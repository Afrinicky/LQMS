import { Router } from 'express';
import { getDb } from '../db/database.js';
import { requirePermission } from '../middleware/permissions.js';
import { audit } from '../services/auditService.js';
import { generateRecordNumber } from '../utils/recordNumber.js';
import { getStaffIdOrCurrent } from './routeHelpers.js';

function parseIntNullable(value: unknown) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function calculateRiskScore(likelihood: number, severity: number, detectability: number) {
  return likelihood * severity * detectability;
}

function determineRiskLevel(score: number) {
  if (score >= 13) return score > 25 ? 'Critical' : 'High';
  if (score >= 6) return 'Medium';
  return 'Low';
}

export function riskRoutes() {
  const router = Router();
  router.get('/', requirePermission('risks', 'view'), (_req, res) => {
    const db = getDb();
    res.json(db.prepare('SELECT * FROM risks ORDER BY id DESC').all());
  });

  router.post('/', requirePermission('risks', 'create'), (req, res) => {
    const db = getDb();
    const createdAt = new Date().toISOString();
    const riskNumber = generateRecordNumber(db, 'risks', 'RISK', createdAt);
    const likelihood = Number(req.body.likelihood) || 0;
    const severity = Number(req.body.severity) || 0;
    const detectability = Number(req.body.detectability) || 0;
    const riskScore = calculateRiskScore(likelihood, severity, detectability);
    const riskLevel = determineRiskLevel(riskScore);
    const result = db.prepare('INSERT INTO risks (risk_number, department_id, section_id, risk_area, risk_description, cause, consequence, existing_controls, likelihood, severity, detectability, risk_score, risk_level, mitigation_plan, responsible_staff_id, review_due_date, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
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
      createdAt
    );
    audit(req, { action: 'create', entity: 'risks', entityId: result.lastInsertRowid, newValue: { riskNumber, ...req.body } });
    res.status(201).json({ id: result.lastInsertRowid, riskNumber });
  });

  router.get('/:id', requirePermission('risks', 'view'), (req, res) => {
    const db = getDb();
    const item = db.prepare('SELECT * FROM risks WHERE id = ?').get(req.params.id);
    if (!item) return res.status(404).json({ error: 'Risk not found' });
    const reviews = db.prepare('SELECT * FROM risk_reviews WHERE risk_id = ? ORDER BY review_date DESC').all(req.params.id);
    res.json({ ...item, reviews });
  });

  router.put('/:id', requirePermission('risks', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM risks WHERE id = ?').get(req.params.id);
    if (!oldValue) return res.status(404).json({ error: 'Risk not found' });
    const likelihood = Number(req.body.likelihood) || oldValue.likelihood || 0;
    const severity = Number(req.body.severity) || oldValue.severity || 0;
    const detectability = Number(req.body.detectability) || oldValue.detectability || 0;
    const riskScore = calculateRiskScore(likelihood, severity, detectability);
    const riskLevel = determineRiskLevel(riskScore);
    db.prepare('UPDATE risks SET department_id = ?, section_id = ?, risk_area = ?, risk_description = ?, cause = ?, consequence = ?, existing_controls = ?, likelihood = ?, severity = ?, detectability = ?, risk_score = ?, risk_level = ?, mitigation_plan = ?, responsible_staff_id = ?, review_due_date = ?, residual_likelihood = ?, residual_severity = ?, residual_detectability = ?, residual_score = ?, residual_level = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(
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
      req.params.id
    );
    audit(req, { action: 'edit', entity: 'risks', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  router.post('/:id/review', requirePermission('risks', 'approve'), (req, res) => {
    const db = getDb();
    const existing = db.prepare('SELECT * FROM risks WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Risk not found' });
    const reviewDate = req.body.reviewDate ?? new Date().toISOString();
    const likelihood = Number(req.body.riskScore) || existing.risk_score;
    const riskLevel = req.body.riskLevel ?? existing.risk_level;
    const nextReviewDate = req.body.nextReviewDate ?? null;
    const reviewedByStaffId = getStaffIdOrCurrent(req, req.body.reviewedByStaffId);
    if (reviewedByStaffId === null) return res.status(400).json({ error: 'This action requires the logged-in user to be linked to a staff record.' });
    const result = db.prepare('INSERT INTO risk_reviews (risk_id, review_date, review_notes, risk_score, risk_level, next_review_date, reviewed_by_staff_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      req.params.id,
      reviewDate,
      req.body.reviewNotes,
      likelihood,
      riskLevel,
      nextReviewDate,
      reviewedByStaffId,
      new Date().toISOString()
    );
    db.prepare('UPDATE risks SET review_due_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(nextReviewDate, req.params.id);
    audit(req, { action: 'approve', entity: 'risk_reviews', entityId: result.lastInsertRowid, newValue: { riskId: req.params.id, ...req.body } });
    res.status(201).json({ id: result.lastInsertRowid });
  });

  router.post('/:id/create-action', requirePermission('actions', 'create'), (req, res) => {
    const db = getDb();
    const result = db.prepare('INSERT INTO actions (title, module_key, source_module, source_record_id, description, assigned_to_staff_id, due_date, priority, status, evidence_required, completion_notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
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
      req.user!.id
    );
    const actionId = result.lastInsertRowid;
    db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run('risks', 'risks', req.params.id, 'actions', 'actions', String(actionId), 'Action linked from risk');
    audit(req, { action: 'create', entity: 'actions', entityId: actionId, newValue: { sourceModule: 'risks', sourceRecordId: req.params.id, ...req.body } });
    res.status(201).json({ id: actionId });
  });

  router.post('/:id/create-capa', requirePermission('nc_capa', 'create'), (req, res) => {
    const db = getDb();
    const risk = db.prepare('SELECT * FROM risks WHERE id = ?').get(req.params.id);
    if (!risk) return res.status(404).json({ error: 'Risk not found' });
    const createdAt = new Date().toISOString();
    const capaNumber = generateRecordNumber(db, 'capa_records', 'CAPA', createdAt);
    const result = db.prepare('INSERT INTO capa_records (capa_number, source_module, source_record_id, risk_id, title, problem_summary, root_cause, corrective_action, preventive_action, responsible_staff_id, due_date, priority, status, effectiveness_required, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
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
      createdAt
    );
    const capaId = result.lastInsertRowid;
    db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run('risks', 'risks', req.params.id, 'nc_capa', 'capa_records', String(capaId), 'CAPA created from risk');
    audit(req, { action: 'create', entity: 'capa_records', entityId: capaId, newValue: { capaNumber, riskId: req.params.id } });
    res.status(201).json({ id: capaId, capaNumber });
  });

  router.post('/:id/close', requirePermission('risks', 'void_archive'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT status FROM risks WHERE id = ?').get(req.params.id);
    if (!oldValue) return res.status(404).json({ error: 'Risk not found' });
    db.prepare('UPDATE risks SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.body.status ?? 'closed', req.params.id);
    audit(req, { action: 'void_archive', entity: 'risks', entityId: req.params.id, oldValue, newValue: { status: req.body.status ?? 'closed' } });
    res.json({ ok: true });
  });

  return router;
}
