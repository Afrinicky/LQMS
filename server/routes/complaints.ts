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

export function complaintsRoutes() {
  const router = Router();
  router.get('/', requirePermission('complaints', 'view'), (_req, res) => {
    const db = getDb();
    res.json(db.prepare('SELECT * FROM complaints ORDER BY received_date DESC, id DESC').all());
  });

  router.post('/', requirePermission('complaints', 'create'), (req, res) => {
    const db = getDb();
    const createdAt = new Date().toISOString();
    const complaintNumber = generateRecordNumber(db, 'complaints', 'COMP', createdAt);
    const result = db.prepare('INSERT INTO complaints (complaint_number, received_date, source, complainant_type, complainant_name, contact, department_id, section_id, category, title, description, assigned_to_staff_id, acknowledgement_status, investigation_summary, root_cause, correction, capa_required, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      complaintNumber,
      req.body.receivedDate ?? createdAt,
      req.body.source,
      req.body.complainantType,
      req.body.complainantName,
      req.body.contact,
      parseIntNullable(req.body.departmentId),
      parseIntNullable(req.body.sectionId),
      req.body.category,
      req.body.title,
      req.body.description,
      parseIntNullable(req.body.assignedToStaffId),
      req.body.acknowledgementStatus ?? 'pending',
      req.body.investigationSummary ?? null,
      req.body.rootCause ?? null,
      req.body.correction ?? null,
      req.body.capaRequired ? 1 : 0,
      'new',
      req.user!.id,
      createdAt
    );
    audit(req, { action: 'create', entity: 'complaints', entityId: result.lastInsertRowid, newValue: { complaintNumber, ...req.body } });
    res.status(201).json({ id: result.lastInsertRowid, complaintNumber });
  });

  router.get('/:id', requirePermission('complaints', 'view'), (req, res) => {
    const db = getDb();
    const item = db.prepare('SELECT * FROM complaints WHERE id = ?').get(req.params.id);
    if (!item) return res.status(404).json({ error: 'Complaint not found' });
    const links = db.prepare('SELECT * FROM record_links WHERE source_record_type = ? AND source_record_id = ? OR target_record_type = ? AND target_record_id = ?').all('complaints', req.params.id, 'complaints', req.params.id);
    res.json({ ...item, links });
  });

  router.put('/:id', requirePermission('complaints', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM complaints WHERE id = ?').get(req.params.id);
    if (!oldValue) return res.status(404).json({ error: 'Complaint not found' });
    db.prepare('UPDATE complaints SET received_date = ?, source = ?, complainant_type = ?, complainant_name = ?, contact = ?, department_id = ?, section_id = ?, category = ?, title = ?, description = ?, assigned_to_staff_id = ?, acknowledgement_status = ?, investigation_summary = ?, root_cause = ?, correction = ?, capa_required = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(
      req.body.receivedDate,
      req.body.source,
      req.body.complainantType,
      req.body.complainantName,
      req.body.contact,
      parseIntNullable(req.body.departmentId),
      parseIntNullable(req.body.sectionId),
      req.body.category,
      req.body.title,
      req.body.description,
      parseIntNullable(req.body.assignedToStaffId),
      req.body.acknowledgementStatus ?? oldValue.acknowledgement_status,
      req.body.investigationSummary ?? oldValue.investigation_summary,
      req.body.rootCause ?? oldValue.root_cause,
      req.body.correction ?? oldValue.correction,
      req.body.capaRequired ? 1 : 0,
      req.body.status ?? oldValue.status,
      req.params.id
    );
    audit(req, { action: 'edit', entity: 'complaints', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  router.post('/:id/assign', requirePermission('complaints', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT assigned_to_staff_id, acknowledgement_status FROM complaints WHERE id = ?').get(req.params.id);
    if (!oldValue) return res.status(404).json({ error: 'Complaint not found' });
    db.prepare('UPDATE complaints SET assigned_to_staff_id = ?, acknowledgement_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(parseIntNullable(req.body.assignedToStaffId), req.body.acknowledgementStatus ?? 'assigned', req.params.id);
    audit(req, { action: 'edit', entity: 'complaints', entityId: req.params.id, oldValue, newValue: { assignedToStaffId: req.body.assignedToStaffId, acknowledgementStatus: req.body.acknowledgementStatus } });
    res.json({ ok: true });
  });

  router.post('/:id/investigate', requirePermission('complaints', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT investigation_summary, root_cause, correction, status FROM complaints WHERE id = ?').get(req.params.id);
    if (!oldValue) return res.status(404).json({ error: 'Complaint not found' });
    db.prepare('UPDATE complaints SET investigation_summary = ?, root_cause = ?, correction = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.body.investigationSummary, req.body.rootCause, req.body.correction, req.body.status ?? 'investigating', req.params.id);
    audit(req, { action: 'edit', entity: 'complaints', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  router.post('/:id/create-nc', requirePermission('nc_capa', 'create'), (req, res) => {
    const db = getDb();
    const complaint = db.prepare('SELECT * FROM complaints WHERE id = ?').get(req.params.id);
    if (!complaint) return res.status(404).json({ error: 'Complaint not found' });
    const createdAt = new Date().toISOString();
    const ncNumber = generateRecordNumber(db, 'nonconforming_events', 'NC', createdAt);
    const result = db.prepare('INSERT INTO nonconforming_events (nc_number, event_date, detected_by_staff_id, department_id, section_id, source_module, source_record_id, title, description, category, severity, impact_level, immediate_correction, patient_or_service_impact, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      ncNumber,
      req.body.eventDate ?? complaint.received_date,
      parseIntNullable(req.body.detectedByStaffId),
      complaint.department_id,
      complaint.section_id,
      'complaints',
      req.params.id,
      req.body.title ?? complaint.title,
      req.body.description ?? complaint.description,
      req.body.category ?? complaint.category,
      req.body.severity ?? null,
      req.body.impactLevel ?? null,
      req.body.immediateCorrection ?? null,
      req.body.patientOrServiceImpact ?? null,
      'open',
      req.user!.id,
      createdAt
    );
    const ncId = result.lastInsertRowid;
    db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run('complaints', 'complaints', req.params.id, 'nc_capa', 'nonconforming_events', String(ncId), 'NC created from complaint');
    audit(req, { action: 'create', entity: 'nonconforming_events', entityId: ncId, newValue: { ncNumber, complaintId: req.params.id } });
    res.status(201).json({ id: ncId, ncNumber });
  });

  router.post('/:id/create-capa', requirePermission('nc_capa', 'create'), (req, res) => {
    const db = getDb();
    const complaint = db.prepare('SELECT * FROM complaints WHERE id = ?').get(req.params.id);
    if (!complaint) return res.status(404).json({ error: 'Complaint not found' });
    const createdAt = new Date().toISOString();
    const capaNumber = generateRecordNumber(db, 'capa_records', 'CAPA', createdAt);
    const result = db.prepare('INSERT INTO capa_records (capa_number, source_module, source_record_id, complaint_id, title, problem_summary, root_cause, corrective_action, preventive_action, responsible_staff_id, due_date, priority, status, effectiveness_required, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      capaNumber,
      'complaints',
      req.params.id,
      req.params.id,
      req.body.title ?? complaint.title,
      req.body.problemSummary ?? complaint.description,
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
    db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run('complaints', 'complaints', req.params.id, 'nc_capa', 'capa_records', String(capaId), 'CAPA created from complaint');
    audit(req, { action: 'create', entity: 'capa_records', entityId: capaId, newValue: { capaNumber, complaintId: req.params.id } });
    res.status(201).json({ id: capaId, capaNumber });
  });

  router.post('/:id/close', requirePermission('complaints', 'void_archive'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT status, closure_summary, closed_by_staff_id, closed_at FROM complaints WHERE id = ?').get(req.params.id);
    if (!oldValue) return res.status(404).json({ error: 'Complaint not found' });
    const closedByStaffId = getStaffIdOrCurrent(req, req.body.closedByStaffId);
    if (closedByStaffId === null) return res.status(400).json({ error: 'This action requires the logged-in user to be linked to a staff record.' });
    db.prepare('UPDATE complaints SET status = ?, closure_summary = ?, closed_by_staff_id = ?, closed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.body.status ?? 'closed', req.body.closureSummary, closedByStaffId, req.params.id);
    audit(req, { action: 'void_archive', entity: 'complaints', entityId: req.params.id, oldValue, newValue: { status: req.body.status ?? 'closed', closureSummary: req.body.closureSummary } });
    res.json({ ok: true });
  });

  router.post('/:id/create-action', requirePermission('actions', 'create'), (req, res) => {
    const db = getDb();
    const result = db.prepare('INSERT INTO actions (title, module_key, source_module, source_record_id, description, assigned_to_staff_id, due_date, priority, status, evidence_required, completion_notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      req.body.title,
      'actions',
      'complaints',
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
    db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run('complaints', 'complaints', req.params.id, 'actions', 'actions', String(result.lastInsertRowid), 'Action linked from complaint');
    audit(req, { action: 'create', entity: 'actions', entityId: result.lastInsertRowid, newValue: { sourceModule: 'complaints', sourceRecordId: req.params.id, ...req.body } });
    res.status(201).json({ id: result.lastInsertRowid });
  });

  return router;
}
