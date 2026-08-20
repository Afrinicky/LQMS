import { Router } from 'express';
import { getDb } from '../db/database.js';
import { getStore } from '../db/store.js';
import { requirePermission } from '../middleware/permissions.js';
import { audit } from '../services/auditService.js';
import { generateRecordNumber } from '../utils/recordNumber.js';
import { parseIntNullable, getStaffIdOrCurrent } from './routeHelpers.js';


function calculateRiskScore(likelihood: number, severity: number, detectability: number) {
  return likelihood * severity * detectability;
}

function determineRiskLevel(score: number) {
  if (score >= 13) return score > 25 ? 'Critical' : 'High';
  if (score >= 6) return 'Medium';
  return 'Low';
}

// Migrated onto the DataStore seam (Phase 2). Queries go through getStore();
// legacy synchronous helpers that take a raw connection (generateRecordNumber)
// are handed getDb(), which is the same underlying SQLite handle the store uses.
export function riskRoutes() {
  const router = Router();
  const store = getStore();

  router.get('/', requirePermission('risks', 'view'), async (_req, res) => {
    res.json(await store.all('SELECT * FROM risks ORDER BY id DESC'));
  });

  router.post('/', requirePermission('risks', 'create'), async (req, res) => {
    const requiredFields = ['riskArea', 'riskDescription', 'likelihood', 'severity', 'detectability'];
    for (const field of requiredFields) {
      if (!req.body[field]) return res.status(400).json({ error: `${field} is required` });
    }
    const createdAt = new Date().toISOString();
    const riskNumber = generateRecordNumber(getDb(), 'risks', 'RISK', createdAt);
    const likelihood = Number(req.body.likelihood) || 0;
    const severity = Number(req.body.severity) || 0;
    const detectability = Number(req.body.detectability) || 0;
    const riskScore = calculateRiskScore(likelihood, severity, detectability);
    const riskLevel = determineRiskLevel(riskScore);
    const result = await store.run(
      'INSERT INTO risks (risk_number, department_id, section_id, risk_area, risk_description, cause, consequence, existing_controls, likelihood, severity, detectability, risk_score, risk_level, mitigation_plan, responsible_staff_id, review_due_date, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        riskNumber,
        parseIntNullable(req.body.departmentId),
        parseIntNullable(req.body.sectionId),
        req.body.riskArea,
        req.body.riskDescription,
        req.body.cause,
        req.body.consequence,
        req.body.existingControls,
        likelihood,
        severity,
        detectability,
        riskScore,
        riskLevel,
        req.body.mitigationPlan,
        parseIntNullable(req.body.responsibleStaffId),
        req.body.reviewDueDate ?? null,
        'active',
        req.user!.id,
        createdAt,
      ]
    );
    audit(req, { action: 'create', entity: 'risks', entityId: result.lastInsertRowid, newValue: { riskNumber, ...req.body } });
    res.status(201).json({ id: result.lastInsertRowid, riskNumber });
  });

  router.get('/:id', requirePermission('risks', 'view'), async (req, res) => {
    const item = await store.get<Record<string, unknown>>('SELECT * FROM risks WHERE id = ?', [req.params.id]);
    if (!item) return res.status(404).json({ error: 'Risk not found' });
    const reviews = await store.all('SELECT * FROM risk_reviews WHERE risk_id = ? ORDER BY review_date DESC', [req.params.id]);
    const links = await store.all(
      'SELECT * FROM record_links WHERE (source_module_key = ? AND source_record_type = ? AND source_record_id = ?) OR (target_module_key = ? AND target_record_type = ? AND target_record_id = ?)',
      ['risks', 'risks', String(req.params.id), 'risks', 'risks', String(req.params.id)]
    );
    res.json({ ...item, reviews, links });
  });

  router.put('/:id', requirePermission('risks', 'edit'), async (req, res) => {
    const oldValue = await store.get<any>('SELECT * FROM risks WHERE id = ?', [req.params.id]);
    if (!oldValue) return res.status(404).json({ error: 'Risk not found' });
    const likelihood = Number(req.body.likelihood) || oldValue.likelihood || 0;
    const severity = Number(req.body.severity) || oldValue.severity || 0;
    const detectability = Number(req.body.detectability) || oldValue.detectability || 0;
    const riskScore = calculateRiskScore(likelihood, severity, detectability);
    const riskLevel = determineRiskLevel(riskScore);
    await store.run(
      'UPDATE risks SET department_id = ?, section_id = ?, risk_area = ?, risk_description = ?, cause = ?, consequence = ?, existing_controls = ?, likelihood = ?, severity = ?, detectability = ?, risk_score = ?, risk_level = ?, mitigation_plan = ?, responsible_staff_id = ?, review_due_date = ?, residual_likelihood = ?, residual_severity = ?, residual_detectability = ?, residual_score = ?, residual_level = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [
        parseIntNullable(req.body.departmentId),
        parseIntNullable(req.body.sectionId),
        req.body.riskArea,
        req.body.riskDescription,
        req.body.cause,
        req.body.consequence,
        req.body.existingControls,
        likelihood,
        severity,
        detectability,
        riskScore,
        riskLevel,
        req.body.mitigationPlan,
        parseIntNullable(req.body.responsibleStaffId),
        req.body.reviewDueDate ?? null,
        parseIntNullable(req.body.residualLikelihood),
        parseIntNullable(req.body.residualSeverity),
        parseIntNullable(req.body.residualDetectability),
        Number(req.body.residualLikelihood || 0) * Number(req.body.residualSeverity || 0) * Number(req.body.residualDetectability || 0),
        req.body.residualLevel ?? null,
        req.body.status ?? oldValue.status,
        req.params.id,
      ]
    );
    audit(req, { action: 'edit', entity: 'risks', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  router.post('/:id/review', requirePermission('risks', 'approve'), async (req, res) => {
    const existing = await store.get<any>('SELECT * FROM risks WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Risk not found' });
    const reviewDate = req.body.reviewDate ?? new Date().toISOString();
    const likelihood = Number(req.body.riskScore) || existing.risk_score;
    const riskLevel = req.body.riskLevel ?? existing.risk_level;
    const nextReviewDate = req.body.nextReviewDate ?? null;
    const reviewedByStaffId = getStaffIdOrCurrent(req, req.body.reviewedByStaffId);
    if (reviewedByStaffId === null) return res.status(400).json({ error: 'This action requires the logged-in user to be linked to a staff record.' });
    const result = await store.run(
      'INSERT INTO risk_reviews (risk_id, review_date, review_notes, risk_score, risk_level, next_review_date, reviewed_by_staff_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [req.params.id, reviewDate, req.body.reviewNotes, likelihood, riskLevel, nextReviewDate, reviewedByStaffId, new Date().toISOString()]
    );
    await store.run('UPDATE risks SET review_due_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [nextReviewDate, req.params.id]);
    audit(req, { action: 'approve', entity: 'risk_reviews', entityId: result.lastInsertRowid, newValue: { riskId: req.params.id, ...req.body } });
    res.status(201).json({ id: result.lastInsertRowid });
  });

  router.post('/:id/create-action', requirePermission('actions', 'create'), async (req, res) => {
    const result = await store.run(
      'INSERT INTO actions (title, module_key, source_module, source_record_id, description, assigned_to_staff_id, due_date, priority, status, evidence_required, completion_notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        req.body.title,
        'actions',
        'risks',
        req.params.id,
        req.body.description ?? null,
        parseIntNullable(req.body.assignedToStaffId),
        req.body.dueDate ?? null,
        req.body.priority ?? 'normal',
        req.body.status ?? 'Not started',
        req.body.evidenceRequired ? 1 : 0,
        req.body.completionNotes ?? null,
        req.user!.id,
      ]
    );
    const actionId = result.lastInsertRowid;
    await store.run(
      'INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['risks', 'risks', req.params.id, 'actions', 'actions', String(actionId), 'Action linked from risk']
    );
    audit(req, { action: 'create', entity: 'actions', entityId: actionId, newValue: { sourceModule: 'risks', sourceRecordId: req.params.id, ...req.body } });
    res.status(201).json({ id: actionId });
  });

  router.post('/:id/create-capa', requirePermission('nc_capa', 'create'), async (req, res) => {
    const risk = await store.get<any>('SELECT * FROM risks WHERE id = ?', [req.params.id]);
    if (!risk) return res.status(404).json({ error: 'Risk not found' });
    const createdAt = new Date().toISOString();
    const capaNumber = generateRecordNumber(getDb(), 'capa_records', 'CAPA', createdAt);
    const result = await store.run(
      'INSERT INTO capa_records (capa_number, source_module, source_record_id, risk_id, title, problem_summary, root_cause, corrective_action, preventive_action, responsible_staff_id, due_date, priority, status, effectiveness_required, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        capaNumber,
        'risks',
        req.params.id,
        req.params.id,
        req.body.title ?? risk.risk_area,
        req.body.problemSummary ?? risk.risk_description,
        req.body.rootCause ?? risk.cause,
        req.body.correctiveAction ?? null,
        req.body.preventiveAction ?? null,
        parseIntNullable(req.body.responsibleStaffId),
        req.body.dueDate ?? null,
        req.body.priority ?? 'normal',
        'open',
        req.body.effectivenessRequired ? 1 : 0,
        req.user!.id,
        createdAt,
      ]
    );
    const capaId = result.lastInsertRowid;
    await store.run(
      'INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['risks', 'risks', req.params.id, 'nc_capa', 'capa_records', String(capaId), 'CAPA created from risk']
    );
    audit(req, { action: 'create', entity: 'capa_records', entityId: capaId, newValue: { capaNumber, riskId: req.params.id } });
    res.status(201).json({ id: capaId, capaNumber });
  });

  router.post('/:id/close', requirePermission('risks', 'void_archive'), async (req, res) => {
    const oldValue = await store.get('SELECT status FROM risks WHERE id = ?', [req.params.id]);
    if (!oldValue) return res.status(404).json({ error: 'Risk not found' });
    await store.run('UPDATE risks SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [req.body.status ?? 'closed', req.params.id]);
    audit(req, { action: 'void_archive', entity: 'risks', entityId: req.params.id, oldValue, newValue: { status: req.body.status ?? 'closed' } });
    res.json({ ok: true });
  });

  return router;
}
