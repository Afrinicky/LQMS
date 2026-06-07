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

export function capaRoutes() {
  const router = Router();
  router.get('/', requirePermission('nc_capa', 'view'), (_req, res) => {
    const db = getDb();
    res.json(db.prepare('SELECT * FROM capa_records ORDER BY created_at DESC').all());
  });

  router.post('/', requirePermission('nc_capa', 'create'), (req, res) => {
    const db = getDb();
    const createdAt = new Date().toISOString();
    const capaNumber = generateRecordNumber(db, 'capa_records', 'CAPA', createdAt);
    const result = db.prepare('INSERT INTO capa_records (capa_number, source_module, source_record_id, nc_id, complaint_id, risk_id, title, problem_summary, root_cause, corrective_action, preventive_action, responsible_staff_id, due_date, priority, status, effectiveness_required, effectiveness_due_date, effectiveness_status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      capaNumber,
      req.body.sourceModule ?? null,
      req.body.sourceRecordId ?? null,
      parseIntNullable(req.body.ncId),
      parseIntNullable(req.body.complaintId),
      parseIntNullable(req.body.riskId),
      req.body.title,
      req.body.problemSummary,
      req.body.rootCause,
      req.body.correctiveAction,
      req.body.preventiveAction,
      parseIntNullable(req.body.responsibleStaffId),
      req.body.dueDate ?? null,
      req.body.priority ?? 'normal',
      'open',
      req.body.effectivenessRequired ? 1 : 0,
      req.body.effectivenessDueDate ?? null,
      'pending',
      req.user!.id,
      createdAt
    );
    const id = result.lastInsertRowid;
    if (req.body.ncId) {
      db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run('nc_capa', 'nonconforming_events', String(req.body.ncId), 'nc_capa', 'capa_records', String(id), 'Linked CAPA from NC');
    }
    if (req.body.complaintId) {
      db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run('complaints', 'complaints', String(req.body.complaintId), 'nc_capa', 'capa_records', String(id), 'Linked CAPA from complaint');
    }
    if (req.body.riskId) {
      db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run('risks', 'risks', String(req.body.riskId), 'nc_capa', 'capa_records', String(id), 'Linked CAPA from risk');
    }
    audit(req, { action: 'create', entity: 'capa_records', entityId: id, newValue: { capaNumber, ...req.body } });
    res.status(201).json({ id, capaNumber });
  });

  router.get('/:id', requirePermission('nc_capa', 'view'), (req, res) => {
    const db = getDb();
    const item = db.prepare('SELECT * FROM capa_records WHERE id = ?').get(req.params.id);
    if (!item) return res.status(404).json({ error: 'CAPA not found' });
    const updates = db.prepare('SELECT * FROM capa_updates WHERE capa_id = ? ORDER BY update_date DESC').all(req.params.id);
    res.json({ ...item, updates });
  });

  router.put('/:id', requirePermission('nc_capa', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM capa_records WHERE id = ?').get(req.params.id);
    if (!oldValue) return res.status(404).json({ error: 'CAPA not found' });
    db.prepare('UPDATE capa_records SET source_module = ?, source_record_id = ?, nc_id = ?, complaint_id = ?, risk_id = ?, title = ?, problem_summary = ?, root_cause = ?, corrective_action = ?, preventive_action = ?, responsible_staff_id = ?, due_date = ?, priority = ?, status = ?, verification_notes = ?, effectiveness_required = ?, effectiveness_due_date = ?, effectiveness_review_notes = ?, effectiveness_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(
      req.body.sourceModule ?? oldValue.source_module,
      req.body.sourceRecordId ?? oldValue.source_record_id,
      parseIntNullable(req.body.ncId),
      parseIntNullable(req.body.complaintId),
      parseIntNullable(req.body.riskId),
      req.body.title,
      req.body.problemSummary,
      req.body.rootCause,
      req.body.correctiveAction,
      req.body.preventiveAction,
      parseIntNullable(req.body.responsibleStaffId),
      req.body.dueDate ?? null,
      req.body.priority ?? oldValue.priority,
      req.body.status ?? oldValue.status,
      req.body.verificationNotes ?? oldValue.verification_notes,
      req.body.effectivenessRequired ? 1 : 0,
      req.body.effectivenessDueDate ?? oldValue.effectiveness_due_date,
      req.body.effectivenessReviewNotes ?? oldValue.effectiveness_review_notes,
      req.body.effectivenessStatus ?? oldValue.effectiveness_status,
      req.params.id
    );
    audit(req, { action: 'edit', entity: 'capa_records', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  router.post('/:id/add-update', requirePermission('nc_capa', 'edit'), (req, res) => {
    const db = getDb();
    const existing = db.prepare('SELECT * FROM capa_records WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'CAPA not found' });
    const createdAt = new Date().toISOString();
    const result = db.prepare('INSERT INTO capa_updates (capa_id, update_date, update_text, status, evidence_file_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      req.params.id,
      req.body.updateDate ?? createdAt,
      req.body.updateText,
      req.body.status ?? existing.status,
      parseIntNullable(req.body.evidenceFileId),
      req.user!.id,
      createdAt
    );
    audit(req, { action: 'edit', entity: 'capa_updates', entityId: result.lastInsertRowid, newValue: { capaId: req.params.id, ...req.body } });
    res.status(201).json({ id: result.lastInsertRowid });
  });

  router.post('/:id/verify', requirePermission('nc_capa', 'approve'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT verification_notes, verified_by_staff_id, verified_at, status FROM capa_records WHERE id = ?').get(req.params.id);
    if (!oldValue) return res.status(404).json({ error: 'CAPA not found' });
    const verifiedByStaffId = getStaffIdOrCurrent(req, req.body.verifiedByStaffId);
    if (verifiedByStaffId === null) return res.status(400).json({ error: 'This action requires the logged-in user to be linked to a staff record.' });
    db.prepare('UPDATE capa_records SET verification_notes = ?, verified_by_staff_id = ?, verified_at = CURRENT_TIMESTAMP, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.body.verificationNotes, verifiedByStaffId, req.body.status ?? 'verified', req.params.id);
    audit(req, { action: 'approve', entity: 'capa_records', entityId: req.params.id, oldValue, newValue: { verificationNotes: req.body.verificationNotes, status: req.body.status ?? 'verified' } });
    res.json({ ok: true });
  });

  router.post('/:id/effectiveness-review', requirePermission('nc_capa', 'approve'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT effectiveness_review_notes, effectiveness_status, effectiveness_due_date FROM capa_records WHERE id = ?').get(req.params.id);
    if (!oldValue) return res.status(404).json({ error: 'CAPA not found' });
    db.prepare('UPDATE capa_records SET effectiveness_review_notes = ?, effectiveness_status = ?, effectiveness_due_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.body.effectivenessReviewNotes, req.body.effectivenessStatus ?? oldValue.effectiveness_status, req.body.effectivenessDueDate ?? oldValue.effectiveness_due_date, req.params.id);
    audit(req, { action: 'edit', entity: 'capa_records', entityId: req.params.id, oldValue, newValue: { effectivenessReviewNotes: req.body.effectivenessReviewNotes, effectivenessStatus: req.body.effectivenessStatus, effectivenessDueDate: req.body.effectivenessDueDate } });
    res.json({ ok: true });
  });

  router.post('/:id/close', requirePermission('nc_capa', 'void_archive'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT status, closed_by_staff_id, closed_at FROM capa_records WHERE id = ?').get(req.params.id);
    if (!oldValue) return res.status(404).json({ error: 'CAPA not found' });
    const closedByStaffId = getStaffIdOrCurrent(req, req.body.closedByStaffId);
    if (closedByStaffId === null) return res.status(400).json({ error: 'This action requires the logged-in user to be linked to a staff record.' });
    db.prepare('UPDATE capa_records SET status = ?, closed_by_staff_id = ?, closed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.body.status ?? 'closed', closedByStaffId, req.params.id);
    audit(req, { action: 'void_archive', entity: 'capa_records', entityId: req.params.id, oldValue, newValue: { status: req.body.status ?? 'closed' } });
    res.json({ ok: true });
  });

  router.post('/:id/reopen', requirePermission('nc_capa', 'edit'), (req, res) => {
    const db = getDb();
    const existing = db.prepare('SELECT * FROM capa_records WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'CAPA not found' });
    db.prepare('UPDATE capa_records SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.body.status ?? 'reopened', req.params.id);
    audit(req, { action: 'edit', entity: 'capa_records', entityId: req.params.id, oldValue: existing, newValue: { status: req.body.status ?? 'reopened' } });
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
    db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run('nc_capa', 'capa_records', req.params.id, 'actions', 'actions', String(result.lastInsertRowid), 'Action linked from CAPA');
    audit(req, { action: 'create', entity: 'actions', entityId: result.lastInsertRowid, newValue: { sourceModule: 'nc_capa', sourceRecordId: req.params.id, ...req.body } });
    res.status(201).json({ id: result.lastInsertRowid });
  });

  return router;
}
