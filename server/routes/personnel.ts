import { Router } from 'express';
import { getDb } from '../db/database.js';
import { requirePermission } from '../middleware/permissions.js';
import { audit } from '../services/auditService.js';
import { generateRecordNumber } from '../utils/recordNumber.js';
import { parseIntNullable, getStaffIdOrCurrent } from './routeHelpers.js';

const DECLARATION_TYPES = ['confidentiality', 'ethical_declaration', 'conflict_of_interest', 'safety_commitment', 'other'];
const DECLARATION_STATUSES = ['pending', 'signed', 'withdrawn'];
const TRAINING_STATUSES = ['planned', 'completed', 'cancelled'];
const ATTENDANCE_STATUSES = ['invited', 'attended', 'absent', 'excused'];
const COMPETENCY_METHODS = ['direct_observation', 'record_review', 'blind_sample', 'split_sample', 'problem_solving', 'result_interpretation', 'interview', 'other'];
const COMPETENCY_OUTCOMES = ['competent', 'competent_with_supervision', 'not_yet_competent'];
const COMPETENCY_STATUSES = ['planned', 'in_progress', 'completed', 'cancelled'];
const STAFF_DOC_VERIFICATION = ['pending', 'verified', 'rejected', 'expired'];
const ROSTER_STATUSES = ['draft', 'published', 'approved', 'archived'];

export function personnelRoutes() {
  const router = Router();

  // ============= Staff documents =============
  router.get('/staff-documents', requirePermission('personnel', 'view'), (req, res) => {
    const db = getDb();
    const filters: string[] = [];
    const params: unknown[] = [];
    if (req.query.staffId) { filters.push('sd.staff_id = ?'); params.push(Number(req.query.staffId)); }
    if (req.query.verificationStatus) { filters.push('sd.verification_status = ?'); params.push(String(req.query.verificationStatus)); }
    let query = 'SELECT sd.*, s.full_name AS staff_name, f.original_name AS file_name FROM staff_documents sd LEFT JOIN staff s ON s.id = sd.staff_id LEFT JOIN files f ON f.id = sd.file_id';
    if (filters.length) query += ` WHERE ${filters.join(' AND ')}`;
    query += ' ORDER BY sd.created_at DESC';
    res.json(db.prepare(query).all(...params));
  });

  router.post('/staff-documents', requirePermission('personnel', 'create'), (req, res) => {
    if (!parseIntNullable(req.body.staffId)) return res.status(400).json({ error: 'staffId is required' });
    if (!req.body.documentType) return res.status(400).json({ error: 'documentType is required' });
    if (!req.body.title) return res.status(400).json({ error: 'title is required' });
    const db = getDb();
    const result = db.prepare(`INSERT INTO staff_documents (staff_id, document_type, title, file_id, issue_date, expiry_date, verification_status, remarks, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(parseIntNullable(req.body.staffId), req.body.documentType, req.body.title, parseIntNullable(req.body.fileId), req.body.issueDate ?? null, req.body.expiryDate ?? null, 'pending', req.body.remarks ?? null, req.user!.id);
    const id = Number(result.lastInsertRowid);
    if (parseIntNullable(req.body.fileId)) {
      db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run('personnel', 'staff_documents', String(id), 'documents', 'files', String(req.body.fileId), 'Staff document file');
    }
    audit(req, { action: 'create', entity: 'staff_documents', entityId: id, newValue: req.body });
    res.status(201).json({ id });
  });

  router.post('/staff-documents/:id/verify', requirePermission('personnel', 'approve'), (req, res) => {
    const db = getDb();
    const doc = db.prepare('SELECT * FROM staff_documents WHERE id = ?').get(req.params.id) as any;
    if (!doc) return res.status(404).json({ error: 'Staff document not found' });
    const verifiedBy = getStaffIdOrCurrent(req, req.body.verifiedByStaffId);
    if (verifiedBy === null) return res.status(400).json({ error: 'This action requires the logged-in user to be linked to a staff record.' });
    const status = req.body.verificationStatus ?? 'verified';
    if (!STAFF_DOC_VERIFICATION.includes(status)) return res.status(400).json({ error: `verificationStatus must be one of: ${STAFF_DOC_VERIFICATION.join(', ')}` });
    db.prepare('UPDATE staff_documents SET verification_status = ?, verified_by_staff_id = ?, verified_at = CURRENT_TIMESTAMP, remarks = COALESCE(?, remarks), updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(status, verifiedBy, req.body.remarks ?? null, req.params.id);
    audit(req, { action: 'verify', entity: 'staff_documents', entityId: req.params.id, oldValue: { verification_status: doc.verification_status }, newValue: { verificationStatus: status, verifiedByStaffId: verifiedBy } });
    res.json({ ok: true });
  });

  // ============= Declarations =============
  router.get('/declarations', requirePermission('personnel', 'view'), (req, res) => {
    const db = getDb();
    const filters: string[] = [];
    const params: unknown[] = [];
    if (req.query.staffId) { filters.push('d.staff_id = ?'); params.push(Number(req.query.staffId)); }
    if (req.query.status) { filters.push('d.status = ?'); params.push(String(req.query.status)); }
    let query = 'SELECT d.*, s.full_name AS staff_name FROM staff_declarations d LEFT JOIN staff s ON s.id = d.staff_id';
    if (filters.length) query += ` WHERE ${filters.join(' AND ')}`;
    query += ' ORDER BY d.created_at DESC';
    res.json(db.prepare(query).all(...params));
  });

  router.post('/declarations', requirePermission('personnel', 'create'), (req, res) => {
    if (!req.body.declarationType) return res.status(400).json({ error: 'declarationType is required' });
    if (!DECLARATION_TYPES.includes(req.body.declarationType)) return res.status(400).json({ error: `declarationType must be one of: ${DECLARATION_TYPES.join(', ')}` });
    if (!req.body.title) return res.status(400).json({ error: 'title is required' });
    const db = getDb();
    const createdAt = new Date().toISOString();
    const declarationNumber = generateRecordNumber(db, 'staff_declarations', 'DEC', createdAt);
    const result = db.prepare(`INSERT INTO staff_declarations (declaration_number, declaration_type, title, description, document_id, document_version_id, staff_id, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(declarationNumber, req.body.declarationType, req.body.title, req.body.description ?? null, parseIntNullable(req.body.documentId), parseIntNullable(req.body.documentVersionId), parseIntNullable(req.body.staffId), 'pending', req.user!.id, createdAt);
    const id = Number(result.lastInsertRowid);
    audit(req, { action: 'create', entity: 'staff_declarations', entityId: id, newValue: { declarationNumber, ...req.body } });
    res.status(201).json({ id, declarationNumber });
  });

  router.post('/declarations/:id/sign', requirePermission('personnel', 'edit'), (req, res) => {
    const db = getDb();
    const decl = db.prepare('SELECT * FROM staff_declarations WHERE id = ?').get(req.params.id) as any;
    if (!decl) return res.status(404).json({ error: 'Declaration not found' });
    const staffId = getStaffIdOrCurrent(req, req.body.staffId);
    if (staffId === null) return res.status(400).json({ error: 'This action requires the logged-in user to be linked to a staff record.' });
    db.prepare("UPDATE staff_declarations SET staff_id = ?, signed_at = CURRENT_TIMESTAMP, signature_file_id = ?, status = 'signed', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(staffId, parseIntNullable(req.body.signatureFileId), req.params.id);
    audit(req, { action: 'sign', entity: 'staff_declarations', entityId: req.params.id, oldValue: { status: decl.status }, newValue: { status: 'signed', staffId } });
    res.json({ ok: true });
  });

  // ============= Training =============
  router.get('/training', requirePermission('personnel', 'view'), (req, res) => {
    const db = getDb();
    const filters: string[] = [];
    const params: unknown[] = [];
    if (req.query.status) { filters.push('status = ?'); params.push(String(req.query.status)); }
    let query = 'SELECT * FROM training_events';
    if (filters.length) query += ` WHERE ${filters.join(' AND ')}`;
    query += ' ORDER BY training_date DESC';
    res.json(db.prepare(query).all(...params));
  });

  router.post('/training', requirePermission('personnel', 'create'), (req, res) => {
    if (!req.body.title) return res.status(400).json({ error: 'title is required' });
    if (!req.body.trainingDate) return res.status(400).json({ error: 'trainingDate is required' });
    const status = req.body.status ?? 'planned';
    if (!TRAINING_STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${TRAINING_STATUSES.join(', ')}` });
    const db = getDb();
    const createdAt = new Date().toISOString();
    const trainingNumber = generateRecordNumber(db, 'training_events', 'TRN', createdAt);
    const result = db.prepare(`INSERT INTO training_events (training_number, title, description, training_type, department_id, section_id, trainer_staff_id, training_date, start_time, end_time, location, evidence_file_id, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(trainingNumber, req.body.title, req.body.description ?? null, req.body.trainingType ?? null, parseIntNullable(req.body.departmentId), parseIntNullable(req.body.sectionId), parseIntNullable(req.body.trainerStaffId), req.body.trainingDate, req.body.startTime ?? null, req.body.endTime ?? null, req.body.location ?? null, parseIntNullable(req.body.evidenceFileId), status, req.user!.id, createdAt);
    const id = Number(result.lastInsertRowid);
    if (parseIntNullable(req.body.evidenceFileId)) {
      db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run('personnel', 'training_events', String(id), 'documents', 'files', String(req.body.evidenceFileId), 'Training evidence file');
    }
    audit(req, { action: 'create', entity: 'training_events', entityId: id, newValue: { trainingNumber, ...req.body } });
    res.status(201).json({ id, trainingNumber });
  });

  router.get('/training/:id', requirePermission('personnel', 'view'), (req, res) => {
    const db = getDb();
    const event = db.prepare('SELECT * FROM training_events WHERE id = ?').get(req.params.id) as any;
    if (!event) return res.status(404).json({ error: 'Training event not found' });
    const attendance = db.prepare('SELECT a.*, s.full_name AS staff_name FROM training_attendance a JOIN staff s ON s.id = a.staff_id WHERE a.training_event_id = ? ORDER BY s.full_name').all(req.params.id);
    res.json({ ...event, attendance });
  });

  router.post('/training/:id/attendance', requirePermission('personnel', 'create'), (req, res) => {
    if (!parseIntNullable(req.body.staffId)) return res.status(400).json({ error: 'staffId is required' });
    const db = getDb();
    const event = db.prepare('SELECT id FROM training_events WHERE id = ?').get(req.params.id);
    if (!event) return res.status(404).json({ error: 'Training event not found' });
    const status = req.body.attendanceStatus ?? 'invited';
    if (!ATTENDANCE_STATUSES.includes(status)) return res.status(400).json({ error: `attendanceStatus must be one of: ${ATTENDANCE_STATUSES.join(', ')}` });
    const existing = db.prepare('SELECT id FROM training_attendance WHERE training_event_id = ? AND staff_id = ?').get(req.params.id, req.body.staffId) as any;
    let id: number;
    if (existing) {
      db.prepare('UPDATE training_attendance SET attendance_status = ?, signed_at = CASE WHEN ? = \'attended\' THEN CURRENT_TIMESTAMP ELSE signed_at END, remarks = COALESCE(?, remarks) WHERE id = ?')
        .run(status, status, req.body.remarks ?? null, existing.id);
      id = existing.id;
    } else {
      const result = db.prepare(`INSERT INTO training_attendance (training_event_id, staff_id, attendance_status, signed_at, remarks, created_by) VALUES (?, ?, ?, CASE WHEN ? = 'attended' THEN CURRENT_TIMESTAMP ELSE NULL END, ?, ?)`)
        .run(req.params.id, req.body.staffId, status, status, req.body.remarks ?? null, req.user!.id);
      id = Number(result.lastInsertRowid);
    }
    audit(req, { action: 'attendance', entity: 'training_attendance', entityId: id, newValue: { trainingEventId: req.params.id, staffId: req.body.staffId, status } });
    res.status(201).json({ id });
  });

  // ============= Competency =============
  router.get('/competency', requirePermission('personnel', 'view'), (req, res) => {
    const db = getDb();
    const filters: string[] = [];
    const params: unknown[] = [];
    if (req.query.staffId) { filters.push('c.staff_id = ?'); params.push(Number(req.query.staffId)); }
    if (req.query.status) { filters.push('c.status = ?'); params.push(String(req.query.status)); }
    let query = 'SELECT c.*, s.full_name AS staff_name, a.full_name AS assessor_name FROM competency_assessments c LEFT JOIN staff s ON s.id = c.staff_id LEFT JOIN staff a ON a.id = c.assessor_staff_id';
    if (filters.length) query += ` WHERE ${filters.join(' AND ')}`;
    query += ' ORDER BY c.assessment_date DESC';
    res.json(db.prepare(query).all(...params));
  });

  router.post('/competency', requirePermission('personnel', 'create'), (req, res) => {
    if (!parseIntNullable(req.body.staffId)) return res.status(400).json({ error: 'staffId is required' });
    if (!req.body.activity) return res.status(400).json({ error: 'activity is required' });
    if (!req.body.assessmentMethod) return res.status(400).json({ error: 'assessmentMethod is required' });
    if (!COMPETENCY_METHODS.includes(req.body.assessmentMethod)) return res.status(400).json({ error: `assessmentMethod must be one of: ${COMPETENCY_METHODS.join(', ')}` });
    if (!req.body.assessmentDate) return res.status(400).json({ error: 'assessmentDate is required' });
    const status = req.body.status ?? 'planned';
    if (!COMPETENCY_STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${COMPETENCY_STATUSES.join(', ')}` });
    const outcome = req.body.outcome ?? null;
    if (outcome && !COMPETENCY_OUTCOMES.includes(outcome)) return res.status(400).json({ error: `outcome must be one of: ${COMPETENCY_OUTCOMES.join(', ')}` });
    const db = getDb();
    const createdAt = new Date().toISOString();
    const competencyNumber = generateRecordNumber(db, 'competency_assessments', 'COMP', createdAt);
    const result = db.prepare(`INSERT INTO competency_assessments (competency_number, staff_id, department_id, section_id, activity, assessment_method, assessor_staff_id, assessment_date, outcome, findings, retraining_required, next_assessment_due, evidence_file_id, authorization_recommendation, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(competencyNumber, parseIntNullable(req.body.staffId), parseIntNullable(req.body.departmentId), parseIntNullable(req.body.sectionId), req.body.activity, req.body.assessmentMethod, getStaffIdOrCurrent(req, req.body.assessorStaffId), req.body.assessmentDate, outcome, req.body.findings ?? null, req.body.retrainingRequired ? 1 : 0, req.body.nextAssessmentDue ?? null, parseIntNullable(req.body.evidenceFileId), req.body.authorizationRecommendation ?? null, status, req.user!.id, createdAt);
    const id = Number(result.lastInsertRowid);
    audit(req, { action: 'create', entity: 'competency_assessments', entityId: id, newValue: { competencyNumber, ...req.body } });
    res.status(201).json({ id, competencyNumber });
  });

  router.get('/competency/:id', requirePermission('personnel', 'view'), (req, res) => {
    const db = getDb();
    const record = db.prepare('SELECT c.*, s.full_name AS staff_name, a.full_name AS assessor_name FROM competency_assessments c LEFT JOIN staff s ON s.id = c.staff_id LEFT JOIN staff a ON a.id = c.assessor_staff_id WHERE c.id = ?').get(req.params.id);
    if (!record) return res.status(404).json({ error: 'Competency assessment not found' });
    const links = db.prepare('SELECT * FROM record_links WHERE source_module_key = ? AND source_record_type = ? AND source_record_id = ?').all('personnel', 'competency_assessments', String(req.params.id));
    res.json({ ...record, links });
  });

  router.post('/competency/:id/complete', requirePermission('personnel', 'edit'), (req, res) => {
    if (!req.body.outcome) return res.status(400).json({ error: 'outcome is required' });
    if (!COMPETENCY_OUTCOMES.includes(req.body.outcome)) return res.status(400).json({ error: `outcome must be one of: ${COMPETENCY_OUTCOMES.join(', ')}` });
    const db = getDb();
    const assessment = db.prepare('SELECT * FROM competency_assessments WHERE id = ?').get(req.params.id) as any;
    if (!assessment) return res.status(404).json({ error: 'Competency assessment not found' });
    const retraining = req.body.outcome === 'not_yet_competent' ? 1 : (req.body.retrainingRequired ? 1 : 0);
    db.prepare("UPDATE competency_assessments SET outcome = ?, findings = COALESCE(?, findings), retraining_required = ?, next_assessment_due = COALESCE(?, next_assessment_due), evidence_file_id = COALESCE(?, evidence_file_id), authorization_recommendation = COALESCE(?, authorization_recommendation), status = 'completed', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(req.body.outcome, req.body.findings ?? null, retraining, req.body.nextAssessmentDue ?? null, parseIntNullable(req.body.evidenceFileId), req.body.authorizationRecommendation ?? null, req.params.id);

    if (retraining && req.body.createRetrainingAction) {
      const r = db.prepare('INSERT INTO actions (title, module_key, source_module, source_record_id, description, priority, assigned_to_staff_id, status, evidence_required, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(`Retraining required: ${assessment.activity}`, 'personnel', 'personnel', String(req.params.id), `Competency assessment ${assessment.competency_number} outcome was not_yet_competent.`, 'high', assessment.staff_id, 'Not started', 1, req.user!.id);
      const actionId = Number(r.lastInsertRowid);
      db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run('personnel', 'competency_assessments', String(req.params.id), 'actions', 'actions', String(actionId), 'Retraining action');
    }

    audit(req, { action: 'complete', entity: 'competency_assessments', entityId: req.params.id, oldValue: { status: assessment.status, outcome: assessment.outcome }, newValue: { outcome: req.body.outcome, retraining_required: retraining } });
    res.json({ ok: true });
  });

  router.post('/competency/:id/create-authorization', requirePermission('personnel', 'approve'), (req, res) => {
    if (!req.body.moduleKey) return res.status(400).json({ error: 'moduleKey is required' });
    if (!req.body.level) return res.status(400).json({ error: 'level is required' });
    const db = getDb();
    const assessment = db.prepare('SELECT * FROM competency_assessments WHERE id = ?').get(req.params.id) as any;
    if (!assessment) return res.status(404).json({ error: 'Competency assessment not found' });
    if (assessment.outcome === 'not_yet_competent') return res.status(400).json({ error: 'Cannot authorise a not_yet_competent assessment.' });
    const result = db.prepare('INSERT INTO technical_authorizations (staff_id, position_id, module_key, section_id, level, is_active, expires_at, competency_assessment_id, created_by, notes) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)')
      .run(assessment.staff_id, parseIntNullable(req.body.positionId), req.body.moduleKey, assessment.section_id, req.body.level, req.body.expiresAt ?? null, req.params.id, req.user!.id, req.body.notes ?? null);
    const authId = Number(result.lastInsertRowid);
    db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run('personnel', 'competency_assessments', String(req.params.id), 'personnel', 'technical_authorizations', String(authId), 'Authorisation granted from competency assessment');
    audit(req, { action: 'create_authorization', entity: 'technical_authorizations', entityId: authId, newValue: { competencyAssessmentId: req.params.id, ...req.body } });
    res.status(201).json({ id: authId });
  });

  // ============= Duty rosters =============
  router.get('/rosters', requirePermission('personnel', 'view'), (req, res) => {
    const db = getDb();
    const filters: string[] = [];
    const params: unknown[] = [];
    if (req.query.sectionId) { filters.push('section_id = ?'); params.push(Number(req.query.sectionId)); }
    if (req.query.status) { filters.push('status = ?'); params.push(String(req.query.status)); }
    let query = 'SELECT * FROM duty_rosters';
    if (filters.length) query += ` WHERE ${filters.join(' AND ')}`;
    query += ' ORDER BY roster_start_date DESC, id DESC';
    res.json(db.prepare(query).all(...params));
  });

  router.post('/rosters', requirePermission('personnel', 'create'), (req, res) => {
    if (!req.body.rosterStartDate) return res.status(400).json({ error: 'rosterStartDate is required' });
    if (!req.body.rosterEndDate) return res.status(400).json({ error: 'rosterEndDate is required' });
    const status = req.body.status ?? 'draft';
    if (!ROSTER_STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${ROSTER_STATUSES.join(', ')}` });
    const db = getDb();
    const createdAt = new Date().toISOString();
    const rosterNumber = generateRecordNumber(db, 'duty_rosters', 'ROSTER', createdAt);
    const result = db.prepare(`INSERT INTO duty_rosters (roster_number, department_id, section_id, roster_start_date, roster_end_date, status, prepared_by_staff_id, notes, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(rosterNumber, parseIntNullable(req.body.departmentId), parseIntNullable(req.body.sectionId), req.body.rosterStartDate, req.body.rosterEndDate, status, getStaffIdOrCurrent(req, req.body.preparedByStaffId), req.body.notes ?? null, req.user!.id, createdAt);
    const id = Number(result.lastInsertRowid);
    audit(req, { action: 'create', entity: 'duty_rosters', entityId: id, newValue: { rosterNumber, ...req.body } });
    res.status(201).json({ id, rosterNumber });
  });

  router.get('/rosters/:id', requirePermission('personnel', 'view'), (req, res) => {
    const db = getDb();
    const roster = db.prepare('SELECT * FROM duty_rosters WHERE id = ?').get(req.params.id);
    if (!roster) return res.status(404).json({ error: 'Roster not found' });
    const assignments = db.prepare('SELECT a.*, s.full_name AS staff_name FROM duty_roster_assignments a JOIN staff s ON s.id = a.staff_id WHERE a.roster_id = ? ORDER BY a.duty_date, a.start_time').all(req.params.id);
    res.json({ ...roster, assignments });
  });

  router.post('/rosters/:id/assignments', requirePermission('personnel', 'edit'), (req, res) => {
    if (!parseIntNullable(req.body.staffId)) return res.status(400).json({ error: 'staffId is required' });
    if (!req.body.dutyDate) return res.status(400).json({ error: 'dutyDate is required' });
    const db = getDb();
    const roster = db.prepare('SELECT id FROM duty_rosters WHERE id = ?').get(req.params.id);
    if (!roster) return res.status(404).json({ error: 'Roster not found' });
    const result = db.prepare(`INSERT INTO duty_roster_assignments (roster_id, staff_id, duty_date, shift_name, start_time, end_time, duty_role, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(req.params.id, req.body.staffId, req.body.dutyDate, req.body.shiftName ?? null, req.body.startTime ?? null, req.body.endTime ?? null, req.body.dutyRole ?? null, req.body.notes ?? null, req.user!.id);
    const id = Number(result.lastInsertRowid);
    db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run('personnel', 'duty_rosters', String(req.params.id), 'personnel', 'duty_roster_assignments', String(id), 'Roster assignment');
    audit(req, { action: 'assign', entity: 'duty_roster_assignments', entityId: id, newValue: { rosterId: req.params.id, ...req.body } });
    res.status(201).json({ id });
  });

  router.post('/rosters/:id/approve', requirePermission('personnel', 'approve'), (req, res) => {
    const db = getDb();
    const roster = db.prepare('SELECT * FROM duty_rosters WHERE id = ?').get(req.params.id) as any;
    if (!roster) return res.status(404).json({ error: 'Roster not found' });
    const approvedBy = getStaffIdOrCurrent(req, req.body.approvedByStaffId);
    if (approvedBy === null) return res.status(400).json({ error: 'This action requires the logged-in user to be linked to a staff record.' });
    db.prepare("UPDATE duty_rosters SET status = 'approved', approved_by_staff_id = ?, approved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(approvedBy, req.params.id);
    audit(req, { action: 'approve', entity: 'duty_rosters', entityId: req.params.id, oldValue: { status: roster.status }, newValue: { status: 'approved', approvedByStaffId: approvedBy } });
    res.json({ ok: true });
  });

  router.get('/rosters/:id/coverage', requirePermission('personnel', 'view'), (req, res) => {
    const db = getDb();
    const roster = db.prepare('SELECT * FROM duty_rosters WHERE id = ?').get(req.params.id) as any;
    if (!roster) return res.status(404).json({ error: 'Roster not found' });
    const assignments = db.prepare('SELECT * FROM duty_roster_assignments WHERE roster_id = ? ORDER BY duty_date, start_time').all(req.params.id) as any[];

    const dates: string[] = [];
    const start = new Date(roster.roster_start_date);
    const end = new Date(roster.roster_end_date);
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      dates.push(d.toISOString().slice(0, 10));
    }
    const byDate = new Map<string, any[]>();
    for (const a of assignments) {
      if (!byDate.has(a.duty_date)) byDate.set(a.duty_date, []);
      byDate.get(a.duty_date)!.push(a);
    }
    const gaps = dates.filter(d => !byDate.has(d));

    const conflicts: Array<{ duty_date: string; staff_id: number; assignments: any[] }> = [];
    const overlaps = (aStart?: string, aEnd?: string, bStart?: string, bEnd?: string) => {
      if (!aStart || !aEnd || !bStart || !bEnd) return Boolean(aStart === bStart && aEnd === bEnd);
      return aStart < bEnd && bStart < aEnd;
    };
    for (const [date, rows] of byDate) {
      const byStaff = new Map<number, any[]>();
      for (const r of rows) {
        if (!byStaff.has(r.staff_id)) byStaff.set(r.staff_id, []);
        byStaff.get(r.staff_id)!.push(r);
      }
      for (const [staffId, list] of byStaff) {
        if (list.length < 2) continue;
        for (let i = 0; i < list.length; i++) {
          for (let j = i + 1; j < list.length; j++) {
            if (overlaps(list[i].start_time, list[i].end_time, list[j].start_time, list[j].end_time)) {
              conflicts.push({ duty_date: date, staff_id: staffId, assignments: [list[i], list[j]] });
              break;
            }
          }
        }
      }
    }

    res.json({
      rosterId: Number(req.params.id),
      periodStart: roster.roster_start_date,
      periodEnd: roster.roster_end_date,
      totalDates: dates.length,
      coveredDates: dates.length - gaps.length,
      gapDates: gaps,
      conflicts,
      assignmentsByDate: dates.map(d => ({ date: d, count: (byDate.get(d) ?? []).length }))
    });
  });

  // ============= Self-service =============
  router.get('/my-profile', (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    const db = getDb();
    const staffId = req.user.staffId;
    if (!staffId) return res.json({ user: { id: req.user.id, fullName: req.user.fullName }, staff: null, positions: [], authorizations: [] });
    const staff = db.prepare('SELECT s.*, sec.name AS section_name FROM staff s LEFT JOIN sections sec ON sec.id = s.section_id WHERE s.id = ?').get(staffId);
    const positions = db.prepare('SELECT p.title, spa.assignment_type, spa.is_active FROM staff_position_assignments spa JOIN positions p ON p.id = spa.position_id WHERE spa.staff_id = ?').all(staffId);
    const authorizations = db.prepare('SELECT * FROM technical_authorizations WHERE staff_id = ? AND is_active = 1').all(staffId);
    res.json({ user: { id: req.user.id, fullName: req.user.fullName }, staff, positions, authorizations });
  });

  router.get('/my-tasks', (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    const db = getDb();
    const staffId = req.user.staffId;
    if (!staffId) return res.json({ pendingAttestations: [], pendingDeclarations: [], upcomingTraining: [], upcomingCompetency: [], assignedActions: [], upcomingDuties: [] });
    res.json({
      pendingAttestations: db.prepare("SELECT a.*, d.document_code, d.title FROM document_attestations a JOIN documents d ON d.id = COALESCE(a.document_id, (SELECT document_id FROM document_versions WHERE id = a.document_version_id)) WHERE a.staff_id = ? AND a.status IN ('pending','overdue') ORDER BY a.due_date NULLS LAST").all(staffId),
      pendingDeclarations: db.prepare("SELECT * FROM staff_declarations WHERE staff_id = ? AND status = 'pending'").all(staffId),
      upcomingTraining: db.prepare("SELECT te.*, ta.attendance_status FROM training_attendance ta JOIN training_events te ON te.id = ta.training_event_id WHERE ta.staff_id = ? AND te.training_date >= date('now') ORDER BY te.training_date").all(staffId),
      upcomingCompetency: db.prepare("SELECT * FROM competency_assessments WHERE staff_id = ? AND status IN ('planned','in_progress') ORDER BY assessment_date").all(staffId),
      assignedActions: db.prepare("SELECT * FROM actions WHERE assigned_to_staff_id = ? AND status != 'Closed' ORDER BY due_date NULLS LAST").all(staffId),
      upcomingDuties: db.prepare("SELECT a.*, r.roster_number FROM duty_roster_assignments a JOIN duty_rosters r ON r.id = a.roster_id WHERE a.staff_id = ? AND a.duty_date >= date('now') AND r.status IN ('published','approved') ORDER BY a.duty_date").all(staffId)
    });
  });

  router.get('/staff-suggestions', (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    const db = getDb();
    const user = db.prepare('SELECT id, username, full_name, staff_id FROM users WHERE id = ?').get(req.user.id) as any;
    if (user.staff_id) return res.json({ alreadyLinked: true, suggestions: [] });
    const suggestions = db.prepare(`SELECT s.id, s.full_name, s.email, s.employee_no, sec.name AS section_name,
        CASE WHEN EXISTS (SELECT 1 FROM users u WHERE u.staff_id = s.id) THEN 1 ELSE 0 END AS already_taken
      FROM staff s LEFT JOIN sections sec ON sec.id = s.section_id
      WHERE s.is_active = 1 AND (LOWER(s.full_name) = LOWER(?) OR LOWER(s.email) = LOWER(COALESCE(?, '')))
      ORDER BY already_taken, s.full_name`).all(user.full_name, user.username);
    res.json({ alreadyLinked: false, suggestions });
  });

  router.post('/link-my-staff', (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (!parseIntNullable(req.body.staffId)) return res.status(400).json({ error: 'staffId is required' });
    const db = getDb();
    const me = db.prepare('SELECT id, username, full_name, staff_id FROM users WHERE id = ?').get(req.user.id) as any;
    if (me.staff_id) return res.status(400).json({ error: 'Your user is already linked to a staff record.' });
    const candidate = db.prepare('SELECT id, full_name, email FROM staff WHERE id = ? AND is_active = 1').get(req.body.staffId) as any;
    if (!candidate) return res.status(404).json({ error: 'Staff record not found' });
    const taken = db.prepare('SELECT id FROM users WHERE staff_id = ?').get(req.body.staffId);
    if (taken) return res.status(400).json({ error: 'That staff record is already linked to another user.' });
    const nameMatch = candidate.full_name && candidate.full_name.toLowerCase() === me.full_name.toLowerCase();
    const emailMatch = candidate.email && me.username && candidate.email.toLowerCase() === me.username.toLowerCase();
    if (!nameMatch && !emailMatch) return res.status(400).json({ error: 'Self-link requires exact name or email match. Ask an administrator to link your account.' });
    db.prepare('UPDATE users SET staff_id = ? WHERE id = ?').run(req.body.staffId, req.user.id);
    audit(req, { action: 'self_link_staff', entity: 'users', entityId: req.user.id, oldValue: { staffId: null }, newValue: { staffId: req.body.staffId, matchedOn: nameMatch ? 'full_name' : 'email' } });
    res.json({ ok: true, staffId: req.body.staffId });
  });

  return router;
}

export { DECLARATION_TYPES, TRAINING_STATUSES, ATTENDANCE_STATUSES, COMPETENCY_METHODS, COMPETENCY_OUTCOMES, COMPETENCY_STATUSES, STAFF_DOC_VERIFICATION, ROSTER_STATUSES, DECLARATION_STATUSES };
