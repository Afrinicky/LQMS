import { Router } from 'express';
import { getDb } from '../db/database.js';
import { requirePermission } from '../middleware/permissions.js';
import { audit } from '../services/auditService.js';
import { generateRecordNumber } from '../utils/recordNumber.js';
import { parseIntNullable, getStaffIdOrCurrent } from './routeHelpers.js';

const METHOD_STATUSES = ['planned', 'in_progress', 'completed', 'approved', 'rejected'];
const EQUIPMENT_VERIFICATION_STATUSES = ['planned', 'in_progress', 'completed', 'approved', 'rejected'];

export function verificationValidationRoutes() {
  const router = Router();

  // Equipment verification routes (specific paths first)
  router.get('/equipment', requirePermission('verification_validation', 'view'), (_req, res) => {
    const db = getDb();
    res.json(db.prepare(`SELECT ev.*, e.name AS equipment_name, e.equipment_number FROM equipment_verifications ev JOIN equipment_items e ON e.id = ev.equipment_id ORDER BY ev.verification_date DESC`).all());
  });

  router.post('/equipment', requirePermission('verification_validation', 'create'), (req, res) => {
    if (!parseIntNullable(req.body.equipmentId)) return res.status(400).json({ error: 'equipmentId is required' });
    if (!req.body.verificationType) return res.status(400).json({ error: 'verificationType is required' });
    if (!req.body.verificationDate) return res.status(400).json({ error: 'verificationDate is required' });
    const db = getDb();
    const equipment = db.prepare('SELECT id FROM equipment_items WHERE id = ?').get(req.body.equipmentId);
    if (!equipment) return res.status(404).json({ error: 'Equipment item not found' });
    const createdAt = new Date().toISOString();
    const verificationNumber = generateRecordNumber(db, 'equipment_verifications', 'EQV', createdAt);
    const verifiedBy = getStaffIdOrCurrent(req, req.body.verifiedByStaffId);
    const status = req.body.status ?? 'in_progress';
    if (!EQUIPMENT_VERIFICATION_STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${EQUIPMENT_VERIFICATION_STATUSES.join(', ')}` });
    const result = db.prepare(`INSERT INTO equipment_verifications (equipment_id, verification_number, verification_type, verification_date, reason, acceptance_criteria, results_summary, conclusion, status, verified_by_staff_id, evidence_file_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        Number(req.body.equipmentId),
        verificationNumber,
        req.body.verificationType,
        req.body.verificationDate,
        req.body.reason ?? null,
        req.body.acceptanceCriteria ?? null,
        req.body.resultsSummary ?? null,
        req.body.conclusion ?? null,
        status,
        verifiedBy,
        parseIntNullable(req.body.evidenceFileId),
        req.user!.id,
        createdAt
      );
    const verId = Number(result.lastInsertRowid);
    db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run('verification_validation', 'equipment_verifications', String(verId), 'equipment', 'equipment_items', String(req.body.equipmentId), 'Equipment verification record');
    audit(req, { action: 'create', entity: 'equipment_verifications', entityId: verId, newValue: { verificationNumber, ...req.body } });
    res.status(201).json({ id: verId, verificationNumber });
  });

  router.get('/equipment/:id', requirePermission('verification_validation', 'view'), (req, res) => {
    const db = getDb();
    const record = db.prepare(`SELECT ev.*, e.name AS equipment_name, e.equipment_number FROM equipment_verifications ev JOIN equipment_items e ON e.id = ev.equipment_id WHERE ev.id = ?`).get(req.params.id);
    if (!record) return res.status(404).json({ error: 'Equipment verification not found' });
    const links = db.prepare('SELECT * FROM record_links WHERE (source_module_key = ? AND source_record_type = ? AND source_record_id = ?) OR (target_module_key = ? AND target_record_type = ? AND target_record_id = ?)')
      .all('verification_validation', 'equipment_verifications', String(req.params.id), 'verification_validation', 'equipment_verifications', String(req.params.id));
    res.json({ ...record, links });
  });

  router.put('/equipment/:id', requirePermission('verification_validation', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM equipment_verifications WHERE id = ?').get(req.params.id) as any;
    if (!oldValue) return res.status(404).json({ error: 'Equipment verification not found' });
    if (req.body.status && !EQUIPMENT_VERIFICATION_STATUSES.includes(req.body.status)) return res.status(400).json({ error: `status must be one of: ${EQUIPMENT_VERIFICATION_STATUSES.join(', ')}` });
    db.prepare(`UPDATE equipment_verifications SET verification_type = ?, verification_date = ?, reason = ?, acceptance_criteria = ?, results_summary = ?, conclusion = ?, status = ?, verified_by_staff_id = ?, evidence_file_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(
        req.body.verificationType ?? oldValue.verification_type,
        req.body.verificationDate ?? oldValue.verification_date,
        req.body.reason ?? oldValue.reason,
        req.body.acceptanceCriteria ?? oldValue.acceptance_criteria,
        req.body.resultsSummary ?? oldValue.results_summary,
        req.body.conclusion ?? oldValue.conclusion,
        req.body.status ?? oldValue.status,
        parseIntNullable(req.body.verifiedByStaffId) ?? oldValue.verified_by_staff_id,
        parseIntNullable(req.body.evidenceFileId) ?? oldValue.evidence_file_id,
        req.params.id
      );
    audit(req, { action: 'edit', entity: 'equipment_verifications', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  router.post('/equipment/:id/approve', requirePermission('verification_validation', 'approve'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM equipment_verifications WHERE id = ?').get(req.params.id);
    if (!oldValue) return res.status(404).json({ error: 'Equipment verification not found' });
    const approvedBy = getStaffIdOrCurrent(req, req.body.approvedByStaffId);
    if (approvedBy === null) return res.status(400).json({ error: 'This action requires the logged-in user to be linked to a staff record.' });
    db.prepare('UPDATE equipment_verifications SET approved_by_staff_id = ?, status = ?, conclusion = COALESCE(?, conclusion), updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(approvedBy, req.body.status ?? 'approved', req.body.conclusion ?? null, req.params.id);
    audit(req, { action: 'approve', entity: 'equipment_verifications', entityId: req.params.id, oldValue, newValue: { approvedByStaffId: approvedBy, status: req.body.status ?? 'approved' } });
    res.json({ ok: true });
  });

  // Method verification routes
  router.get('/', requirePermission('verification_validation', 'view'), (_req, res) => {
    const db = getDb();
    res.json(db.prepare(`SELECT mv.*, e.name AS equipment_name FROM method_verifications mv LEFT JOIN equipment_items e ON e.id = mv.equipment_id ORDER BY mv.created_at DESC`).all());
  });

  router.post('/', requirePermission('verification_validation', 'create'), (req, res) => {
    if (!req.body.methodName) return res.status(400).json({ error: 'methodName is required' });
    if (!req.body.testName) return res.status(400).json({ error: 'testName is required' });
    if (!req.body.verificationType) return res.status(400).json({ error: 'verificationType is required' });
    const db = getDb();
    const createdAt = new Date().toISOString();
    const verificationNumber = generateRecordNumber(db, 'method_verifications', 'MV', createdAt);
    const status = req.body.status ?? 'in_progress';
    if (!METHOD_STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${METHOD_STATUSES.join(', ')}` });
    const result = db.prepare(`INSERT INTO method_verifications (verification_number, department_id, section_id, method_name, test_name, equipment_id, verification_type, reason, start_date, completion_date, parameters_assessed, acceptance_criteria, summary, conclusion, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        verificationNumber,
        parseIntNullable(req.body.departmentId),
        parseIntNullable(req.body.sectionId),
        req.body.methodName,
        req.body.testName,
        parseIntNullable(req.body.equipmentId),
        req.body.verificationType,
        req.body.reason ?? null,
        req.body.startDate ?? null,
        req.body.completionDate ?? null,
        req.body.parametersAssessed ?? null,
        req.body.acceptanceCriteria ?? null,
        req.body.summary ?? null,
        req.body.conclusion ?? null,
        status,
        req.user!.id,
        createdAt
      );
    const verId = Number(result.lastInsertRowid);
    if (parseIntNullable(req.body.equipmentId)) {
      db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run('verification_validation', 'method_verifications', String(verId), 'equipment', 'equipment_items', String(req.body.equipmentId), 'Method verification linked to equipment');
    }
    audit(req, { action: 'create', entity: 'method_verifications', entityId: verId, newValue: { verificationNumber, ...req.body } });
    res.status(201).json({ id: verId, verificationNumber });
  });

  router.get('/:id', requirePermission('verification_validation', 'view'), (req, res) => {
    const db = getDb();
    const verification = db.prepare('SELECT mv.*, e.name AS equipment_name FROM method_verifications mv LEFT JOIN equipment_items e ON e.id = mv.equipment_id WHERE mv.id = ?').get(req.params.id);
    if (!verification) return res.status(404).json({ error: 'Method verification not found' });
    const experiments = db.prepare('SELECT * FROM verification_experiments WHERE verification_id = ? ORDER BY date_performed DESC, id DESC').all(req.params.id);
    const links = db.prepare('SELECT * FROM record_links WHERE (source_module_key = ? AND source_record_type = ? AND source_record_id = ?) OR (target_module_key = ? AND target_record_type = ? AND target_record_id = ?)')
      .all('verification_validation', 'method_verifications', String(req.params.id), 'verification_validation', 'method_verifications', String(req.params.id));
    res.json({ ...verification, experiments, links });
  });

  router.put('/:id', requirePermission('verification_validation', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM method_verifications WHERE id = ?').get(req.params.id) as any;
    if (!oldValue) return res.status(404).json({ error: 'Method verification not found' });
    if (req.body.status && !METHOD_STATUSES.includes(req.body.status)) return res.status(400).json({ error: `status must be one of: ${METHOD_STATUSES.join(', ')}` });
    db.prepare(`UPDATE method_verifications SET department_id = ?, section_id = ?, method_name = ?, test_name = ?, equipment_id = ?, verification_type = ?, reason = ?, start_date = ?, completion_date = ?, parameters_assessed = ?, acceptance_criteria = ?, summary = ?, conclusion = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(
        parseIntNullable(req.body.departmentId) ?? oldValue.department_id,
        parseIntNullable(req.body.sectionId) ?? oldValue.section_id,
        req.body.methodName ?? oldValue.method_name,
        req.body.testName ?? oldValue.test_name,
        parseIntNullable(req.body.equipmentId) ?? oldValue.equipment_id,
        req.body.verificationType ?? oldValue.verification_type,
        req.body.reason ?? oldValue.reason,
        req.body.startDate ?? oldValue.start_date,
        req.body.completionDate ?? oldValue.completion_date,
        req.body.parametersAssessed ?? oldValue.parameters_assessed,
        req.body.acceptanceCriteria ?? oldValue.acceptance_criteria,
        req.body.summary ?? oldValue.summary,
        req.body.conclusion ?? oldValue.conclusion,
        req.body.status ?? oldValue.status,
        req.params.id
      );
    audit(req, { action: 'edit', entity: 'method_verifications', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  router.post('/:id/experiments', requirePermission('verification_validation', 'create'), (req, res) => {
    if (!req.body.experimentType) return res.status(400).json({ error: 'experimentType is required' });
    const db = getDb();
    const verification = db.prepare('SELECT id FROM method_verifications WHERE id = ?').get(req.params.id);
    if (!verification) return res.status(404).json({ error: 'Method verification not found' });
    const performedBy = getStaffIdOrCurrent(req, req.body.performedByStaffId);
    const evidenceFileId = parseIntNullable(req.body.evidenceFileId);
    const result = db.prepare(`INSERT INTO verification_experiments (verification_id, experiment_type, date_performed, sample_count, results_summary, acceptance_met, evidence_file_id, performed_by_staff_id, reviewed_by_staff_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        req.params.id,
        req.body.experimentType,
        req.body.datePerformed ?? null,
        parseIntNullable(req.body.sampleCount),
        req.body.resultsSummary ?? null,
        req.body.acceptanceMet ? 1 : 0,
        evidenceFileId,
        performedBy,
        parseIntNullable(req.body.reviewedByStaffId)
      );
    const expId = Number(result.lastInsertRowid);
    if (evidenceFileId) {
      db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run('verification_validation', 'verification_experiments', String(expId), 'documents', 'files', String(evidenceFileId), 'Evidence for verification experiment');
    }
    audit(req, { action: 'create', entity: 'verification_experiments', entityId: expId, newValue: { verificationId: req.params.id, ...req.body } });
    res.status(201).json({ id: expId });
  });

  router.post('/:id/approve', requirePermission('verification_validation', 'approve'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM method_verifications WHERE id = ?').get(req.params.id);
    if (!oldValue) return res.status(404).json({ error: 'Method verification not found' });
    const approvedBy = getStaffIdOrCurrent(req, req.body.approvedByStaffId);
    if (approvedBy === null) return res.status(400).json({ error: 'This action requires the logged-in user to be linked to a staff record.' });
    const newStatus = req.body.status ?? 'approved';
    if (!METHOD_STATUSES.includes(newStatus)) return res.status(400).json({ error: `status must be one of: ${METHOD_STATUSES.join(', ')}` });
    db.prepare('UPDATE method_verifications SET approved_by_staff_id = ?, status = ?, conclusion = COALESCE(?, conclusion), completion_date = COALESCE(completion_date, ?), updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(approvedBy, newStatus, req.body.conclusion ?? null, new Date().toISOString(), req.params.id);
    audit(req, { action: 'approve', entity: 'method_verifications', entityId: req.params.id, oldValue, newValue: { approvedByStaffId: approvedBy, status: newStatus } });
    res.json({ ok: true });
  });

  return router;
}

export { METHOD_STATUSES, EQUIPMENT_VERIFICATION_STATUSES };
