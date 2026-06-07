import { Router } from 'express';
import { getDb } from '../db/database.js';
import { requirePermission } from '../middleware/permissions.js';
import { audit } from '../services/auditService.js';
import { generateRecordNumber } from '../utils/recordNumber.js';
import { parseIntNullable, getStaffIdOrCurrent } from './routeHelpers.js';

export function eqaRoutes() {
  const router = Router();

  router.get('/programs', requirePermission('eqa', 'view'), (_req, res) => {
    const db = getDb();
    res.json(db.prepare('SELECT * FROM eqa_programs ORDER BY program_name').all());
  });

  router.post('/programs', requirePermission('eqa', 'create'), (req, res) => {
    if (!req.body.programName) return res.status(400).json({ error: 'programName is required' });
    if (!req.body.provider) return res.status(400).json({ error: 'provider is required' });
    if (!req.body.testArea) return res.status(400).json({ error: 'testArea is required' });
    const db = getDb();
    const createdAt = new Date().toISOString();
    const programCode = generateRecordNumber(db, 'eqa_programs', 'EQAP', createdAt);
    const result = db.prepare(`INSERT INTO eqa_programs (program_code, program_name, provider, department_id, section_id, test_area, frequency, contact, is_active, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        programCode,
        req.body.programName,
        req.body.provider,
        parseIntNullable(req.body.departmentId),
        parseIntNullable(req.body.sectionId),
        req.body.testArea,
        req.body.frequency ?? null,
        req.body.contact ?? null,
        req.body.isActive === false ? 0 : 1,
        req.user!.id,
        createdAt
      );
    audit(req, { action: 'create', entity: 'eqa_programs', entityId: result.lastInsertRowid, newValue: { programCode, ...req.body } });
    res.status(201).json({ id: result.lastInsertRowid, programCode });
  });

  router.get('/programs/:id', requirePermission('eqa', 'view'), (req, res) => {
    const db = getDb();
    const program = db.prepare('SELECT * FROM eqa_programs WHERE id = ?').get(req.params.id);
    if (!program) return res.status(404).json({ error: 'EQA program not found' });
    const events = db.prepare('SELECT * FROM eqa_events WHERE eqa_program_id = ? ORDER BY received_date DESC, id DESC').all(req.params.id);
    res.json({ ...program, events });
  });

  router.put('/programs/:id', requirePermission('eqa', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM eqa_programs WHERE id = ?').get(req.params.id) as any;
    if (!oldValue) return res.status(404).json({ error: 'EQA program not found' });
    db.prepare(`UPDATE eqa_programs SET program_name = ?, provider = ?, department_id = ?, section_id = ?, test_area = ?, frequency = ?, contact = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(
        req.body.programName ?? oldValue.program_name,
        req.body.provider ?? oldValue.provider,
        parseIntNullable(req.body.departmentId) ?? oldValue.department_id,
        parseIntNullable(req.body.sectionId) ?? oldValue.section_id,
        req.body.testArea ?? oldValue.test_area,
        req.body.frequency ?? oldValue.frequency,
        req.body.contact ?? oldValue.contact,
        req.body.isActive !== undefined ? (req.body.isActive ? 1 : 0) : oldValue.is_active,
        req.params.id
      );
    audit(req, { action: 'edit', entity: 'eqa_programs', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  router.post('/programs/:id/events', requirePermission('eqa', 'create'), (req, res) => {
    if (!req.body.cycleName) return res.status(400).json({ error: 'cycleName is required' });
    const db = getDb();
    const program = db.prepare('SELECT id FROM eqa_programs WHERE id = ?').get(req.params.id);
    if (!program) return res.status(404).json({ error: 'EQA program not found' });
    const result = db.prepare(`INSERT INTO eqa_events (eqa_program_id, cycle_name, received_date, submission_due_date, submitted_date, result_received_date, performance_status, score, findings, corrective_action_required, responsible_staff_id, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        req.params.id,
        req.body.cycleName,
        req.body.receivedDate ?? null,
        req.body.submissionDueDate ?? null,
        req.body.submittedDate ?? null,
        req.body.resultReceivedDate ?? null,
        req.body.performanceStatus ?? null,
        req.body.score ?? null,
        req.body.findings ?? null,
        req.body.correctiveActionRequired ? 1 : 0,
        parseIntNullable(req.body.responsibleStaffId),
        req.user!.id
      );
    audit(req, { action: 'create', entity: 'eqa_events', entityId: result.lastInsertRowid, newValue: { eqaProgramId: req.params.id, ...req.body } });
    res.status(201).json({ id: result.lastInsertRowid });
  });

  router.get('/events', requirePermission('eqa', 'view'), (req, res) => {
    const db = getDb();
    const filters: string[] = [];
    const params: unknown[] = [];
    if (req.query.performanceStatus) { filters.push('e.performance_status = ?'); params.push(String(req.query.performanceStatus)); }
    if (req.query.programId) { filters.push('e.eqa_program_id = ?'); params.push(Number(req.query.programId)); }
    let query = `SELECT e.*, p.program_name, p.provider, p.test_area FROM eqa_events e JOIN eqa_programs p ON p.id = e.eqa_program_id`;
    if (filters.length) query += ` WHERE ${filters.join(' AND ')}`;
    query += ' ORDER BY e.received_date DESC, e.id DESC LIMIT 500';
    res.json(db.prepare(query).all(...params));
  });

  router.get('/events/:id', requirePermission('eqa', 'view'), (req, res) => {
    const db = getDb();
    const event = db.prepare('SELECT e.*, p.program_name, p.provider, p.test_area FROM eqa_events e JOIN eqa_programs p ON p.id = e.eqa_program_id WHERE e.id = ?').get(req.params.id);
    if (!event) return res.status(404).json({ error: 'EQA event not found' });
    const results = db.prepare('SELECT * FROM eqa_results WHERE eqa_event_id = ? ORDER BY id').all(req.params.id);
    const links = db.prepare('SELECT * FROM record_links WHERE (source_module_key = ? AND source_record_type = ? AND source_record_id = ?) OR (target_module_key = ? AND target_record_type = ? AND target_record_id = ?)')
      .all('eqa', 'eqa_events', String(req.params.id), 'eqa', 'eqa_events', String(req.params.id));
    res.json({ ...event, results, links });
  });

  router.put('/events/:id', requirePermission('eqa', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM eqa_events WHERE id = ?').get(req.params.id) as any;
    if (!oldValue) return res.status(404).json({ error: 'EQA event not found' });
    db.prepare(`UPDATE eqa_events SET cycle_name = ?, received_date = ?, submission_due_date = ?, submitted_date = ?, result_received_date = ?, performance_status = ?, score = ?, findings = ?, corrective_action_required = ?, responsible_staff_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(
        req.body.cycleName ?? oldValue.cycle_name,
        req.body.receivedDate ?? oldValue.received_date,
        req.body.submissionDueDate ?? oldValue.submission_due_date,
        req.body.submittedDate ?? oldValue.submitted_date,
        req.body.resultReceivedDate ?? oldValue.result_received_date,
        req.body.performanceStatus ?? oldValue.performance_status,
        req.body.score ?? oldValue.score,
        req.body.findings ?? oldValue.findings,
        req.body.correctiveActionRequired !== undefined ? (req.body.correctiveActionRequired ? 1 : 0) : oldValue.corrective_action_required,
        parseIntNullable(req.body.responsibleStaffId) ?? oldValue.responsible_staff_id,
        req.params.id
      );
    audit(req, { action: 'edit', entity: 'eqa_events', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  router.post('/events/:id/results', requirePermission('eqa', 'create'), (req, res) => {
    if (!req.body.analyteOrTest) return res.status(400).json({ error: 'analyteOrTest is required' });
    const db = getDb();
    const event = db.prepare('SELECT id FROM eqa_events WHERE id = ?').get(req.params.id);
    if (!event) return res.status(404).json({ error: 'EQA event not found' });
    const result = db.prepare(`INSERT INTO eqa_results (eqa_event_id, analyte_or_test, reported_result, expected_result, performance, comment, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(
        req.params.id,
        req.body.analyteOrTest,
        req.body.reportedResult ?? null,
        req.body.expectedResult ?? null,
        req.body.performance ?? null,
        req.body.comment ?? null,
        req.user!.id
      );
    audit(req, { action: 'create', entity: 'eqa_results', entityId: result.lastInsertRowid, newValue: { eqaEventId: req.params.id, ...req.body } });
    res.status(201).json({ id: result.lastInsertRowid });
  });

  router.post('/events/:id/create-nc', requirePermission('nc_capa', 'create'), (req, res) => {
    const db = getDb();
    const event = db.prepare('SELECT e.*, p.program_name, p.provider, p.test_area FROM eqa_events e JOIN eqa_programs p ON p.id = e.eqa_program_id WHERE e.id = ?').get(req.params.id) as any;
    if (!event) return res.status(404).json({ error: 'EQA event not found' });
    const createdAt = new Date().toISOString();
    const ncNumber = generateRecordNumber(db, 'nonconforming_events', 'NC', createdAt);
    const detectedByStaffId = getStaffIdOrCurrent(req, req.body.detectedByStaffId ?? event.responsible_staff_id);
    const ncResult = db.prepare(`INSERT INTO nonconforming_events (nc_number, event_date, detected_by_staff_id, source_module, source_record_id, title, description, category, severity, immediate_correction, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        ncNumber,
        event.result_received_date ?? event.received_date ?? createdAt,
        detectedByStaffId,
        'eqa',
        String(event.id),
        req.body.title ?? `EQA performance issue: ${event.program_name} (${event.cycle_name})`,
        req.body.description ?? event.findings ?? `EQA event ${event.cycle_name} flagged ${event.performance_status ?? 'unsatisfactory'}`,
        req.body.category ?? 'eqa',
        req.body.severity ?? 'medium',
        req.body.immediateCorrection ?? null,
        'open',
        req.user!.id,
        createdAt
      );
    const ncId = Number(ncResult.lastInsertRowid);
    db.prepare('UPDATE eqa_events SET nc_id = ?, corrective_action_required = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(ncId, req.params.id);
    db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run('eqa', 'eqa_events', String(req.params.id), 'nc_capa', 'nonconforming_events', String(ncId), 'NC from EQA event');
    audit(req, { action: 'create', entity: 'nonconforming_events', entityId: ncId, newValue: { ncNumber, sourceModule: 'eqa', sourceRecordId: req.params.id } });
    res.status(201).json({ id: ncId, ncNumber });
  });

  router.post('/events/:id/create-capa', requirePermission('nc_capa', 'create'), (req, res) => {
    const db = getDb();
    const event = db.prepare('SELECT e.*, p.program_name FROM eqa_events e JOIN eqa_programs p ON p.id = e.eqa_program_id WHERE e.id = ?').get(req.params.id) as any;
    if (!event) return res.status(404).json({ error: 'EQA event not found' });
    const createdAt = new Date().toISOString();
    const capaNumber = generateRecordNumber(db, 'capa_records', 'CAPA', createdAt);
    const result = db.prepare(`INSERT INTO capa_records (capa_number, source_module, source_record_id, nc_id, title, problem_summary, responsible_staff_id, due_date, priority, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        capaNumber,
        'eqa',
        String(event.id),
        event.nc_id ?? null,
        req.body.title ?? `CAPA for EQA event: ${event.program_name} (${event.cycle_name})`,
        req.body.problemSummary ?? event.findings ?? `EQA cycle ${event.cycle_name} performance ${event.performance_status ?? 'unsatisfactory'}`,
        parseIntNullable(req.body.responsibleStaffId) ?? event.responsible_staff_id,
        req.body.dueDate ?? null,
        req.body.priority ?? 'normal',
        'open',
        req.user!.id,
        createdAt
      );
    const capaId = Number(result.lastInsertRowid);
    db.prepare('UPDATE eqa_events SET capa_id = ?, corrective_action_required = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(capaId, req.params.id);
    db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run('eqa', 'eqa_events', String(req.params.id), 'nc_capa', 'capa_records', String(capaId), 'CAPA from EQA event');
    audit(req, { action: 'create', entity: 'capa_records', entityId: capaId, newValue: { capaNumber, sourceModule: 'eqa', sourceRecordId: req.params.id } });
    res.status(201).json({ id: capaId, capaNumber });
  });

  return router;
}
