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

export function nonconformityRoutes() {
  const router = Router();
  router.get('/', requirePermission('nc_capa', 'view'), (_req, res) => {
    const db = getDb();
    res.json(db.prepare('SELECT * FROM nonconforming_events ORDER BY event_date DESC, id DESC').all());
  });

  router.post('/', requirePermission('nc_capa', 'create'), (req, res) => {
    const requiredFields = ['title', 'description', 'eventDate', 'severity'];
    for (const field of requiredFields) {
      if (!req.body[field]) return res.status(400).json({ error: `${field} is required` });
    }
    const db = getDb();
    const createdAt = new Date().toISOString();
    const ncNumber = generateRecordNumber(db, 'nonconforming_events', 'NC', createdAt);
    const result = db.prepare('INSERT INTO nonconforming_events (nc_number, event_date, detected_by_staff_id, department_id, section_id, source_module, source_record_id, title, description, category, severity, impact_level, immediate_correction, patient_or_service_impact, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      ncNumber,
      req.body.eventDate ?? createdAt,
      parseIntNullable(req.body.detectedByStaffId),
      parseIntNullable(req.body.departmentId),
      parseIntNullable(req.body.sectionId),
      req.body.sourceModule ?? null,
      req.body.sourceRecordId ?? null,
      req.body.title,
      req.body.description,
      req.body.category,
      req.body.severity,
      req.body.impactLevel,
      req.body.immediateCorrection,
      req.body.patientOrServiceImpact,
      'open',
      req.user!.id,
      createdAt
    );
    const id = result.lastInsertRowid;
    audit(req, { action: 'create', entity: 'nonconforming_events', entityId: id, newValue: { ncNumber, ...req.body } });
    res.status(201).json({ id, ncNumber });
  });

  router.get('/:id', requirePermission('nc_capa', 'view'), (req, res) => {
    const db = getDb();
    const item = db.prepare('SELECT * FROM nonconforming_events WHERE id = ?').get(req.params.id);
    if (!item) return res.status(404).json({ error: 'Nonconforming event not found' });
    const links = db.prepare('SELECT * FROM record_links WHERE (source_module_key = ? AND source_record_type = ? AND source_record_id = ?) OR (target_module_key = ? AND target_record_type = ? AND target_record_id = ?)').all('nc_capa', 'nonconforming_events', String(req.params.id), 'nc_capa', 'nonconforming_events', String(req.params.id));
    res.json({ ...item, links });
  });

  router.put('/:id', requirePermission('nc_capa', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM nonconforming_events WHERE id = ?').get(req.params.id);
    if (!oldValue) return res.status(404).json({ error: 'Nonconforming event not found' });
    db.prepare('UPDATE nonconforming_events SET event_date = ?, detected_by_staff_id = ?, department_id = ?, section_id = ?, source_module = ?, source_record_id = ?, title = ?, description = ?, category = ?, severity = ?, impact_level = ?, immediate_correction = ?, patient_or_service_impact = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(
      req.body.eventDate,
      parseIntNullable(req.body.detectedByStaffId),
      parseIntNullable(req.body.departmentId),
      parseIntNullable(req.body.sectionId),
      req.body.sourceModule ?? null,
      req.body.sourceRecordId ?? null,
      req.body.title,
      req.body.description,
      req.body.category,
      req.body.severity,
      req.body.impactLevel,
      req.body.immediateCorrection,
      req.body.patientOrServiceImpact,
      req.body.status ?? oldValue.status,
      req.params.id
    );
    audit(req, { action: 'edit', entity: 'nonconforming_events', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  router.post('/:id/review', requirePermission('nc_capa', 'approve'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT reviewer_staff_id, reviewed_at, status FROM nonconforming_events WHERE id = ?').get(req.params.id);
    if (!oldValue) return res.status(404).json({ error: 'Nonconforming event not found' });
    const reviewerStaffId = getStaffIdOrCurrent(req, req.body.reviewerStaffId);
    if (reviewerStaffId === null) return res.status(400).json({ error: 'This action requires the logged-in user to be linked to a staff record.' });
    db.prepare('UPDATE nonconforming_events SET reviewer_staff_id = ?, reviewed_at = CURRENT_TIMESTAMP, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(reviewerStaffId, req.body.status ?? 'reviewed', req.params.id);
    audit(req, { action: 'approve', entity: 'nonconforming_events', entityId: req.params.id, oldValue, newValue: { reviewerStaffId, status: req.body.status ?? 'reviewed' } });
    res.json({ ok: true });
  });

  router.post('/:id/create-capa', requirePermission('nc_capa', 'create'), (req, res) => {
    const db = getDb();
    const source = db.prepare('SELECT * FROM nonconforming_events WHERE id = ?').get(req.params.id);
    if (!source) return res.status(404).json({ error: 'Nonconforming event not found' });
    const createdAt = new Date().toISOString();
    const capaNumber = generateRecordNumber(db, 'capa_records', 'CAPA', createdAt);
    const result = db.prepare('INSERT INTO capa_records (capa_number, source_module, source_record_id, nc_id, title, problem_summary, root_cause, corrective_action, preventive_action, responsible_staff_id, due_date, priority, status, effectiveness_required, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      capaNumber,
      'nonconformities',
      req.params.id,
      Number(req.params.id),
      req.body.title ?? source.title,
      req.body.problemSummary ?? source.description,
      req.body.rootCause ?? null,
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
    db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run('nc_capa', 'nonconforming_events', req.params.id, 'nc_capa', 'capa_records', String(capaId), 'Linked CAPA from NC');
    audit(req, { action: 'create', entity: 'capa_records', entityId: capaId, newValue: { capaNumber, sourceModule: 'nonconformities', sourceRecordId: req.params.id } });
    res.status(201).json({ id: capaId, capaNumber });
  });

  router.post('/:id/close', requirePermission('nc_capa', 'void_archive'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT status, closure_notes, closed_by_staff_id, closed_at FROM nonconforming_events WHERE id = ?').get(req.params.id);
    if (!oldValue) return res.status(404).json({ error: 'Nonconforming event not found' });
    const closedByStaffId = getStaffIdOrCurrent(req, req.body.closedByStaffId);
    if (closedByStaffId === null) return res.status(400).json({ error: 'This action requires the logged-in user to be linked to a staff record.' });
    db.prepare('UPDATE nonconforming_events SET status = ?, closure_notes = ?, closed_by_staff_id = ?, closed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.body.status ?? 'closed', req.body.closureNotes, closedByStaffId, req.params.id);
    audit(req, { action: 'void_archive', entity: 'nonconforming_events', entityId: req.params.id, oldValue, newValue: { status: req.body.status ?? 'closed', closureNotes: req.body.closureNotes } });
    res.json({ ok: true });
  });

  router.post('/:id/create-action', requirePermission('actions', 'create'), (req, res) => {
    const db = getDb();
    const result = db.prepare('INSERT INTO actions (title, module_key, source_module, source_record_id, description, assigned_to_staff_id, due_date, priority, status, evidence_required, completion_notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      req.body.title,
      'actions',
      'nc_capa',
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
    db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run('nc_capa', 'nonconforming_events', req.params.id, 'actions', 'actions', String(result.lastInsertRowid), 'Action linked from NC');
    audit(req, { action: 'create', entity: 'actions', entityId: result.lastInsertRowid, newValue: { sourceModule: 'nc_capa', sourceRecordId: req.params.id, ...req.body } });
    res.status(201).json({ id: result.lastInsertRowid });
  });

  return router;
}
