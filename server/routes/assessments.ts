import { Router } from 'express';
import { getDb } from '../db/database.js';
import { requirePermission } from '../middleware/permissions.js';
import { audit } from '../services/auditService.js';
import { generateRecordNumber } from '../utils/recordNumber.js';
import { parseIntNullable, getStaffIdOrCurrent } from './routeHelpers.js';

const ASSESSMENT_STATUSES = ['planned', 'in_progress', 'completed', 'closed'];
const FINDING_TYPES = ['observation', 'nonconformity', 'improvement_opportunity', 'risk'];
const FINDING_STATUSES = ['open', 'action_required', 'linked_to_capa', 'closed'];

function insertLink(db: any, source: { module: string; type: string; id: string | number }, target: { module: string; type: string; id: string | number }, notes?: string) {
  db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run(source.module, source.type, String(source.id), target.module, target.type, String(target.id), notes ?? null);
}

export function assessmentsRoutes() {
  const router = Router();

  router.get('/', requirePermission('assessments', 'view'), (req, res) => {
    const db = getDb();
    const filters: string[] = [];
    const params: unknown[] = [];
    if (req.query.status) { filters.push('status = ?'); params.push(String(req.query.status)); }
    if (req.query.assessmentType) { filters.push('assessment_type = ?'); params.push(String(req.query.assessmentType)); }
    let query = 'SELECT * FROM assessment_programs';
    if (filters.length) query += ` WHERE ${filters.join(' AND ')}`;
    query += ' ORDER BY planned_start_date DESC, id DESC';
    res.json(db.prepare(query).all(...params));
  });

  router.post('/', requirePermission('assessments', 'create'), (req, res) => {
    if (!req.body.title) return res.status(400).json({ error: 'title is required' });
    if (!req.body.assessmentType) return res.status(400).json({ error: 'assessmentType is required' });
    if (!req.body.plannedStartDate) return res.status(400).json({ error: 'plannedStartDate is required' });
    const status = req.body.status ?? 'planned';
    if (!ASSESSMENT_STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${ASSESSMENT_STATUSES.join(', ')}` });
    const db = getDb();
    const createdAt = new Date().toISOString();
    const programNumber = generateRecordNumber(db, 'assessment_programs', 'ASSM', createdAt);
    const result = db.prepare(`INSERT INTO assessment_programs (program_number, title, assessment_type, department_id, section_id, planned_start_date, planned_end_date, lead_assessor_staff_id, scope, objectives, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(programNumber, req.body.title, req.body.assessmentType, parseIntNullable(req.body.departmentId), parseIntNullable(req.body.sectionId), req.body.plannedStartDate, req.body.plannedEndDate ?? null, parseIntNullable(req.body.leadAssessorStaffId), req.body.scope ?? null, req.body.objectives ?? null, status, req.user!.id, createdAt);
    const id = Number(result.lastInsertRowid);
    audit(req, { action: 'create', entity: 'assessment_programs', entityId: id, newValue: { programNumber, ...req.body } });
    res.status(201).json({ id, programNumber });
  });

  router.get('/findings', requirePermission('assessments', 'view'), (req, res) => {
    const db = getDb();
    const filters: string[] = [];
    const params: unknown[] = [];
    if (req.query.status) { filters.push('f.status = ?'); params.push(String(req.query.status)); }
    if (req.query.findingType) { filters.push('f.finding_type = ?'); params.push(String(req.query.findingType)); }
    let query = 'SELECT f.*, p.program_number, p.title AS program_title FROM assessment_findings f JOIN assessment_programs p ON p.id = f.assessment_program_id';
    if (filters.length) query += ` WHERE ${filters.join(' AND ')}`;
    query += ' ORDER BY f.finding_date DESC, f.id DESC';
    res.json(db.prepare(query).all(...params));
  });

  router.post('/findings/:id/create-nc', requirePermission('nc_capa', 'create'), (req, res) => {
    const db = getDb();
    const finding = db.prepare('SELECT f.*, p.title AS program_title FROM assessment_findings f JOIN assessment_programs p ON p.id = f.assessment_program_id WHERE f.id = ?').get(req.params.id) as any;
    if (!finding) return res.status(404).json({ error: 'Finding not found' });
    const createdAt = new Date().toISOString();
    const ncNumber = generateRecordNumber(db, 'nonconforming_events', 'NC', createdAt);
    const detectedBy = getStaffIdOrCurrent(req, req.body.detectedByStaffId ?? finding.responsible_staff_id);
    const ncResult = db.prepare(`INSERT INTO nonconforming_events (nc_number, event_date, detected_by_staff_id, source_module, source_record_id, title, description, category, severity, immediate_correction, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(ncNumber, finding.finding_date, detectedBy, 'assessments', String(finding.id), req.body.title ?? `Finding ${finding.finding_number}: ${finding.title}`, req.body.description ?? finding.description, req.body.category ?? 'assessment', req.body.severity ?? finding.severity ?? 'medium', req.body.immediateCorrection ?? null, 'open', req.user!.id, createdAt);
    const ncId = Number(ncResult.lastInsertRowid);
    db.prepare("UPDATE assessment_findings SET nc_id = ?, status = 'action_required', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(ncId, req.params.id);
    insertLink(db, { module: 'assessments', type: 'assessment_findings', id: finding.id }, { module: 'nc_capa', type: 'nonconforming_events', id: ncId }, 'NC from assessment finding');
    audit(req, { action: 'create', entity: 'nonconforming_events', entityId: ncId, newValue: { ncNumber, sourceModule: 'assessments', sourceRecordId: finding.id } });
    res.status(201).json({ id: ncId, ncNumber });
  });

  router.post('/findings/:id/create-capa', requirePermission('nc_capa', 'create'), (req, res) => {
    const db = getDb();
    const finding = db.prepare('SELECT * FROM assessment_findings WHERE id = ?').get(req.params.id) as any;
    if (!finding) return res.status(404).json({ error: 'Finding not found' });
    const createdAt = new Date().toISOString();
    const capaNumber = generateRecordNumber(db, 'capa_records', 'CAPA', createdAt);
    const capaResult = db.prepare(`INSERT INTO capa_records (capa_number, source_module, source_record_id, nc_id, title, problem_summary, responsible_staff_id, due_date, priority, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(capaNumber, 'assessments', String(finding.id), finding.nc_id ?? null, req.body.title ?? `CAPA for finding ${finding.finding_number}`, req.body.problemSummary ?? finding.description, parseIntNullable(req.body.responsibleStaffId), req.body.dueDate ?? null, req.body.priority ?? 'normal', 'open', req.user!.id, createdAt);
    const capaId = Number(capaResult.lastInsertRowid);
    db.prepare("UPDATE assessment_findings SET capa_id = ?, status = 'linked_to_capa', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(capaId, req.params.id);
    insertLink(db, { module: 'assessments', type: 'assessment_findings', id: finding.id }, { module: 'nc_capa', type: 'capa_records', id: capaId }, 'CAPA from assessment finding');
    audit(req, { action: 'create', entity: 'capa_records', entityId: capaId, newValue: { capaNumber, sourceModule: 'assessments', sourceRecordId: finding.id } });
    res.status(201).json({ id: capaId, capaNumber });
  });

  router.post('/findings/:id/close', requirePermission('assessments', 'approve'), (req, res) => {
    const db = getDb();
    const finding = db.prepare('SELECT * FROM assessment_findings WHERE id = ?').get(req.params.id) as any;
    if (!finding) return res.status(404).json({ error: 'Finding not found' });
    db.prepare("UPDATE assessment_findings SET status = 'closed', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
    audit(req, { action: 'close', entity: 'assessment_findings', entityId: req.params.id, oldValue: { status: finding.status }, newValue: { status: 'closed' } });
    res.json({ ok: true });
  });

  router.get('/:id', requirePermission('assessments', 'view'), (req, res) => {
    const db = getDb();
    const program = db.prepare('SELECT * FROM assessment_programs WHERE id = ?').get(req.params.id) as any;
    if (!program) return res.status(404).json({ error: 'Assessment not found' });
    const findings = db.prepare('SELECT * FROM assessment_findings WHERE assessment_program_id = ? ORDER BY finding_date DESC, id DESC').all(req.params.id);
    res.json({ ...program, findings });
  });

  router.put('/:id', requirePermission('assessments', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM assessment_programs WHERE id = ?').get(req.params.id) as any;
    if (!oldValue) return res.status(404).json({ error: 'Assessment not found' });
    if (req.body.status && !ASSESSMENT_STATUSES.includes(req.body.status)) return res.status(400).json({ error: `status must be one of: ${ASSESSMENT_STATUSES.join(', ')}` });
    db.prepare(`UPDATE assessment_programs SET title = ?, assessment_type = ?, department_id = ?, section_id = ?, planned_start_date = ?, planned_end_date = ?, lead_assessor_staff_id = ?, scope = ?, objectives = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(req.body.title ?? oldValue.title, req.body.assessmentType ?? oldValue.assessment_type, parseIntNullable(req.body.departmentId) ?? oldValue.department_id, parseIntNullable(req.body.sectionId) ?? oldValue.section_id, req.body.plannedStartDate ?? oldValue.planned_start_date, req.body.plannedEndDate ?? oldValue.planned_end_date, parseIntNullable(req.body.leadAssessorStaffId) ?? oldValue.lead_assessor_staff_id, req.body.scope ?? oldValue.scope, req.body.objectives ?? oldValue.objectives, req.body.status ?? oldValue.status, req.params.id);
    audit(req, { action: 'edit', entity: 'assessment_programs', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  router.get('/:id/findings', requirePermission('assessments', 'view'), (req, res) => {
    const db = getDb();
    res.json(db.prepare('SELECT * FROM assessment_findings WHERE assessment_program_id = ? ORDER BY finding_date DESC, id DESC').all(req.params.id));
  });

  router.post('/:id/findings', requirePermission('assessments', 'create'), (req, res) => {
    if (!req.body.findingType) return res.status(400).json({ error: 'findingType is required' });
    if (!FINDING_TYPES.includes(req.body.findingType)) return res.status(400).json({ error: `findingType must be one of: ${FINDING_TYPES.join(', ')}` });
    if (!req.body.title) return res.status(400).json({ error: 'title is required' });
    if (!req.body.description) return res.status(400).json({ error: 'description is required' });
    const db = getDb();
    const program = db.prepare('SELECT id FROM assessment_programs WHERE id = ?').get(req.params.id);
    if (!program) return res.status(404).json({ error: 'Assessment not found' });
    const createdAt = new Date().toISOString();
    const findingNumber = generateRecordNumber(db, 'assessment_findings', 'FIND', createdAt);
    const result = db.prepare(`INSERT INTO assessment_findings (finding_number, assessment_program_id, finding_date, department_id, section_id, finding_type, title, description, evidence_summary, severity, responsible_staff_id, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(findingNumber, req.params.id, req.body.findingDate ?? createdAt.slice(0, 10), parseIntNullable(req.body.departmentId), parseIntNullable(req.body.sectionId), req.body.findingType, req.body.title, req.body.description, req.body.evidenceSummary ?? null, req.body.severity ?? null, parseIntNullable(req.body.responsibleStaffId), 'open', req.user!.id, createdAt);
    const id = Number(result.lastInsertRowid);
    audit(req, { action: 'create', entity: 'assessment_findings', entityId: id, newValue: { findingNumber, assessmentProgramId: req.params.id, ...req.body } });
    res.status(201).json({ id, findingNumber });
  });

  return router;
}

export { ASSESSMENT_STATUSES, FINDING_TYPES, FINDING_STATUSES };
