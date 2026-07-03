import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { getDb, uploadRoot } from '../db/database.js';
import { requirePermission } from '../middleware/permissions.js';
import { audit } from '../services/auditService.js';
import { generateRecordNumber } from '../utils/recordNumber.js';
import { safeStoredFilename } from '../utils/safeFilename.js';
import { parseIntNullable, getStaffIdOrCurrent } from './routeHelpers.js';

const ASSESSMENT_STATUSES = ['planned', 'in_progress', 'completed', 'closed'];
const FINDING_TYPES = ['observation', 'nonconformity', 'improvement_opportunity', 'risk'];
const FINDING_STATUSES = ['open', 'action_required', 'linked_to_capa', 'closed'];
const CHECKLIST_STATUSES = ['draft', 'active', 'inactive', 'archived', 'replaced'];
const SELECTION_MODES = ['whole_checklist', 'selected_sections', 'selected_questions', 'mixed'];
const RESPONSE_OPTIONS = ['met', 'partially_met', 'not_met', 'not_applicable', 'not_assessed', 'observation_only'];

function insertLink(db: any, source: { module: string; type: string; id: string | number }, target: { module: string; type: string; id: string | number }, notes?: string) {
  db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run(source.module, source.type, String(source.id), target.module, target.type, String(target.id), notes ?? null);
}

const uploadInstance = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadRoot),
    filename: (_req, file, cb) => cb(null, safeStoredFilename(file.originalname))
  }),
  limits: { fileSize: 10 * 1024 * 1024 }
});

function parseCsvBody(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const out: string[][] = [];
  let row: string[] = []; let cell = ''; let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else inQuotes = false; }
      else cell += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { row.push(cell); cell = ''; }
      else if (ch === '\r') {}
      else if (ch === '\n') { row.push(cell); cell = ''; out.push(row); row = []; }
      else cell += ch;
    }
  }
  if (cell.length > 0 || row.length > 0) { row.push(cell); out.push(row); }
  const nonEmpty = out.filter(r => r.some(c => c.trim() !== ''));
  if (nonEmpty.length === 0) return { headers: [], rows: [] };
  const headers = nonEmpty[0].map(h => h.trim());
  const rows = nonEmpty.slice(1).map(r => { const o: Record<string, string> = {}; headers.forEach((h, i) => { o[h] = (r[i] ?? '').trim(); }); return o; });
  return { headers, rows };
}

function pick(row: Record<string, string>, ...keys: string[]) {
  for (const k of keys) { for (const h of Object.keys(row)) { if (h.toLowerCase().replace(/[^a-z0-9]+/g, '') === k.toLowerCase().replace(/[^a-z0-9]+/g, '')) return row[h]; } }
  return '';
}

function snapshotResponse(db: any, oldRow: any, userId: number) {
  if (!oldRow) return;
  db.prepare(`INSERT INTO assessment_question_response_history (response_id, assessment_program_id, question_id, response, evidence_summary, finding_required, marks_awarded, max_marks_at_assessment, score_comment, notes, snapshot_by_staff_id, snapshot_by_user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(oldRow.id, oldRow.assessment_program_id, oldRow.question_id, oldRow.response, oldRow.evidence_summary, oldRow.finding_required, oldRow.marks_awarded, oldRow.max_marks_at_assessment, oldRow.score_comment, oldRow.notes, oldRow.assessed_by_staff_id, userId);
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

  // -------- Checklist library (specific paths before /:id) --------
  router.get('/checklists', requirePermission('assessments', 'view'), (req, res) => {
    const db = getDb();
    const filters: string[] = [];
    const params: unknown[] = [];
    if (req.query.status) { filters.push('status = ?'); params.push(String(req.query.status)); }
    if (req.query.checklistType) { filters.push('checklist_type = ?'); params.push(String(req.query.checklistType)); }
    let query = 'SELECT * FROM assessment_checklists';
    if (filters.length) query += ` WHERE ${filters.join(' AND ')}`;
    query += ' ORDER BY checklist_name';
    res.json(db.prepare(query).all(...params));
  });

  router.post('/checklists', requirePermission('assessments', 'create'), (req, res) => {
    if (!req.body.checklistName) return res.status(400).json({ error: 'checklistName is required' });
    if (!req.body.checklistType) return res.status(400).json({ error: 'checklistType is required' });
    const status = req.body.status ?? 'draft';
    if (!CHECKLIST_STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${CHECKLIST_STATUSES.join(', ')}` });
    const db = getDb();
    const result = db.prepare(`INSERT INTO assessment_checklists (checklist_code, checklist_name, checklist_type, description, source_name, version_label, effective_date, status, is_default, is_editable, marking_enabled, total_possible_marks, internal_threshold_label, internal_pass_mark, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(req.body.checklistCode ?? null, req.body.checklistName, req.body.checklistType, req.body.description ?? null, req.body.sourceName ?? null, req.body.versionLabel ?? null, req.body.effectiveDate ?? null, status, req.body.isDefault ? 1 : 0, req.body.isEditable === false ? 0 : 1, req.body.markingEnabled ? 1 : 0, req.body.totalPossibleMarks !== undefined && req.body.totalPossibleMarks !== '' ? Number(req.body.totalPossibleMarks) : null, req.body.internalThresholdLabel ?? null, req.body.internalPassMark !== undefined && req.body.internalPassMark !== '' ? Number(req.body.internalPassMark) : null, req.user!.id);
    const id = Number(result.lastInsertRowid);
    audit(req, { action: 'create', entity: 'assessment_checklists', entityId: id, newValue: req.body });
    res.status(201).json({ id });
  });

  router.post('/checklists/import', requirePermission('assessments', 'create'), (req, res) => {
    const c = req.body.checklist;
    if (!c || !c.checklistName || !c.checklistType) return res.status(400).json({ error: 'checklist.checklistName and checklist.checklistType are required' });
    const sections = Array.isArray(req.body.sections) ? req.body.sections : [];
    const db = getDb();
    let checklistId = 0;
    let sectionsInserted = 0;
    let questionsInserted = 0;
    const tx = db.transaction(() => {
      const r = db.prepare(`INSERT INTO assessment_checklists (checklist_code, checklist_name, checklist_type, description, source_name, version_label, effective_date, status, is_default, is_editable, marking_enabled, total_possible_marks, internal_threshold_label, internal_pass_mark, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?, ?, ?, ?)`)
        .run(c.checklistCode ?? null, c.checklistName, c.checklistType, c.description ?? null, c.sourceName ?? null, c.versionLabel ?? null, c.effectiveDate ?? null, c.status ?? 'draft', c.markingEnabled ? 1 : 0, c.totalPossibleMarks ?? null, c.internalThresholdLabel ?? null, c.internalPassMark ?? null, req.user!.id);
      checklistId = Number(r.lastInsertRowid);
      const insertSection = db.prepare(`INSERT INTO assessment_checklist_sections (checklist_id, section_code, section_title, section_description, display_order, is_active, section_possible_marks, section_weight, created_by) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`);
      const insertQuestion = db.prepare(`INSERT INTO assessment_checklist_questions (checklist_id, section_id, question_code, question_text, guidance, expected_evidence, response_type, display_order, is_required, is_active, max_marks, weight, scoring_guidance, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`);
      sections.forEach((s: any, idx: number) => {
        const sr = insertSection.run(checklistId, s.sectionCode ?? null, s.sectionTitle ?? `Section ${idx + 1}`, s.sectionDescription ?? null, s.displayOrder ?? idx, s.sectionPossibleMarks ?? null, s.sectionWeight ?? null, req.user!.id);
        const sId = Number(sr.lastInsertRowid);
        sectionsInserted++;
        (s.questions || []).forEach((q: any, qIdx: number) => {
          insertQuestion.run(checklistId, sId, q.questionCode ?? null, q.questionText ?? '', q.guidance ?? null, q.expectedEvidence ?? null, q.responseType ?? 'met_partial_not_met', q.displayOrder ?? qIdx, q.isRequired ? 1 : 0, q.maxMarks ?? null, q.weight ?? null, q.scoringGuidance ?? null, req.user!.id);
          questionsInserted++;
        });
      });
    });
    tx();
    audit(req, { action: 'import', entity: 'assessment_checklists', entityId: checklistId, newValue: { checklistName: c.checklistName, sectionsInserted, questionsInserted } });
    res.status(201).json({ id: checklistId, sectionsInserted, questionsInserted });
  });

  router.post('/checklists/import-file', requirePermission('assessments', 'create'), uploadInstance.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'A file upload is required' });
    if (!req.body.checklistName) return res.status(400).json({ error: 'checklistName is required' });
    if (!req.body.checklistType) return res.status(400).json({ error: 'checklistType is required' });
    const ext = path.extname(req.file.originalname).toLowerCase();
    const filePath = path.join(uploadRoot, req.file.filename);
    let rows: Record<string, string>[] = [];
    try {
      if (ext === '.csv') {
        rows = parseCsvBody(fs.readFileSync(filePath, 'utf-8')).rows;
      } else if (ext === '.xlsx' || ext === '.xls') {
        // `XLSX.readFile` is not reliably resolvable under Node's ESM/CJS
        // interop for this package (see documentExtract.ts's fromXlsx for the
        // full explanation) — read the buffer ourselves and parse it with
        // `XLSX.read`, which is a real static export.
        const wb = XLSX.read(fs.readFileSync(filePath), { type: 'buffer', cellDates: false });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '', raw: false });
        rows = raw.map(r => { const o: Record<string, string> = {}; for (const k of Object.keys(r)) o[k] = r[k] === null || r[k] === undefined ? '' : String(r[k]).trim(); return o; });
      } else {
        return res.status(400).json({ error: 'Upload .csv, .xlsx, or .xls' });
      }
    } catch (e) { return res.status(400).json({ error: `Parse failed: ${(e as Error).message}` }); }

    const db = getDb();
    let checklistId = 0; let sectionsInserted = 0; let questionsInserted = 0;
    const tx = db.transaction(() => {
      const r = db.prepare(`INSERT INTO assessment_checklists (checklist_code, checklist_name, checklist_type, description, source_name, version_label, effective_date, status, is_default, is_editable, marking_enabled, internal_threshold_label, internal_pass_mark, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', 0, 1, ?, ?, ?, ?)`)
        .run(req.body.checklistCode ?? null, req.body.checklistName, req.body.checklistType, req.body.description ?? null, req.body.sourceName ?? req.file!.originalname, req.body.versionLabel ?? null, req.body.effectiveDate ?? null, req.body.markingEnabled === 'true' || req.body.markingEnabled === true ? 1 : 0, req.body.internalThresholdLabel ?? null, req.body.internalPassMark ? Number(req.body.internalPassMark) : null, req.user!.id);
      checklistId = Number(r.lastInsertRowid);
      const sectionCache = new Map<string, number>();
      const insertSection = db.prepare(`INSERT INTO assessment_checklist_sections (checklist_id, section_code, section_title, section_description, display_order, is_active, section_possible_marks, section_weight, created_by) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`);
      const insertQuestion = db.prepare(`INSERT INTO assessment_checklist_questions (checklist_id, section_id, question_code, question_text, guidance, expected_evidence, response_type, display_order, is_required, is_active, max_marks, weight, scoring_guidance, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`);
      rows.forEach((row, idx) => {
        const sectionTitle = pick(row, 'sectionTitle', 'section') || `Section ${idx + 1}`;
        const sectionCode = pick(row, 'sectionCode') || null;
        let sectionId = sectionCache.get(sectionTitle);
        if (!sectionId) {
          const possible = pick(row, 'sectionPossibleMarks');
          const weight = pick(row, 'sectionWeight');
          const sr = insertSection.run(checklistId, sectionCode, sectionTitle, pick(row, 'sectionDescription') || null, sectionCache.size, possible ? Number(possible) : null, weight ? Number(weight) : null, req.user!.id);
          sectionId = Number(sr.lastInsertRowid);
          sectionCache.set(sectionTitle, sectionId);
          sectionsInserted++;
        }
        const questionText = pick(row, 'questionText', 'question');
        if (!questionText) return;
        const maxMarks = pick(row, 'maxMarks');
        const weight = pick(row, 'weight', 'questionWeight');
        insertQuestion.run(checklistId, sectionId, pick(row, 'questionCode') || null, questionText, pick(row, 'guidance') || null, pick(row, 'expectedEvidence') || null, pick(row, 'responseType') || 'met_partial_not_met', questionsInserted, /^(y|yes|true|1)$/i.test(pick(row, 'isRequired')) ? 1 : 0, maxMarks ? Number(maxMarks) : null, weight ? Number(weight) : null, pick(row, 'scoringGuidance') || null, req.user!.id);
        questionsInserted++;
      });
    });
    tx();
    audit(req, { action: 'import_file', entity: 'assessment_checklists', entityId: checklistId, newValue: { fileName: req.file.originalname, sectionsInserted, questionsInserted } });
    res.status(201).json({ id: checklistId, sectionsInserted, questionsInserted });
  });

  router.delete('/checklists/:id', requirePermission('assessments', 'void_archive'), (req, res) => {
    const db = getDb();
    const c = db.prepare('SELECT * FROM assessment_checklists WHERE id = ?').get(req.params.id) as any;
    if (!c) return res.status(404).json({ error: 'Checklist not found' });
    const used = db.prepare('SELECT COUNT(*) AS c FROM assessment_selected_checklists WHERE checklist_id = ?').get(req.params.id) as { c: number };
    if (used.c > 0) return res.status(400).json({ error: `Checklist is used by ${used.c} assessment(s). Archive it instead.` });
    const tx = db.transaction(() => {
      db.prepare('DELETE FROM assessment_checklist_questions WHERE checklist_id = ?').run(req.params.id);
      db.prepare('DELETE FROM assessment_checklist_sections WHERE checklist_id = ?').run(req.params.id);
      db.prepare('DELETE FROM assessment_checklists WHERE id = ?').run(req.params.id);
    });
    tx();
    audit(req, { action: 'delete', entity: 'assessment_checklists', entityId: req.params.id, oldValue: c });
    res.json({ ok: true });
  });

  router.delete('/checklists/:id/sections/:sectionId', requirePermission('assessments', 'void_archive'), (req, res) => {
    const db = getDb();
    const s = db.prepare('SELECT * FROM assessment_checklist_sections WHERE id = ? AND checklist_id = ?').get(req.params.sectionId, req.params.id) as any;
    if (!s) return res.status(404).json({ error: 'Section not found' });
    const usedSel = db.prepare('SELECT COUNT(*) AS c FROM assessment_selected_questions WHERE section_id = ?').get(req.params.sectionId) as { c: number };
    if (usedSel.c > 0) return res.status(400).json({ error: `Section is referenced by ${usedSel.c} selected assessment question(s). Deactivate it instead.` });
    const questions = db.prepare('SELECT COUNT(*) AS c FROM assessment_checklist_questions WHERE section_id = ?').get(req.params.sectionId) as { c: number };
    if (questions.c > 0) return res.status(400).json({ error: `Section still contains ${questions.c} question(s). Delete them first or deactivate the section.` });
    db.prepare('DELETE FROM assessment_checklist_sections WHERE id = ?').run(req.params.sectionId);
    audit(req, { action: 'delete', entity: 'assessment_checklist_sections', entityId: req.params.sectionId, oldValue: s });
    res.json({ ok: true });
  });

  router.delete('/checklists/:id/questions/:questionId', requirePermission('assessments', 'void_archive'), (req, res) => {
    const db = getDb();
    const q = db.prepare('SELECT * FROM assessment_checklist_questions WHERE id = ? AND checklist_id = ?').get(req.params.questionId, req.params.id) as any;
    if (!q) return res.status(404).json({ error: 'Question not found' });
    const used = db.prepare('SELECT COUNT(*) AS c FROM assessment_selected_questions WHERE question_id = ?').get(req.params.questionId) as { c: number };
    if (used.c > 0) return res.status(400).json({ error: `Question is referenced by ${used.c} selected assessment record(s). Deactivate it instead.` });
    db.prepare('DELETE FROM assessment_checklist_questions WHERE id = ?').run(req.params.questionId);
    audit(req, { action: 'delete', entity: 'assessment_checklist_questions', entityId: req.params.questionId, oldValue: q });
    res.json({ ok: true });
  });

  router.get('/checklists/:id', requirePermission('assessments', 'view'), (req, res) => {
    const db = getDb();
    const checklist = db.prepare('SELECT * FROM assessment_checklists WHERE id = ?').get(req.params.id) as any;
    if (!checklist) return res.status(404).json({ error: 'Checklist not found' });
    const sections = db.prepare('SELECT * FROM assessment_checklist_sections WHERE checklist_id = ? ORDER BY display_order, id').all(req.params.id);
    const questions = db.prepare('SELECT * FROM assessment_checklist_questions WHERE checklist_id = ? ORDER BY section_id, display_order, id').all(req.params.id);
    res.json({ ...checklist, sections, questions });
  });

  router.put('/checklists/:id', requirePermission('assessments', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM assessment_checklists WHERE id = ?').get(req.params.id) as any;
    if (!oldValue) return res.status(404).json({ error: 'Checklist not found' });
    if (req.body.status && !CHECKLIST_STATUSES.includes(req.body.status)) return res.status(400).json({ error: `status must be one of: ${CHECKLIST_STATUSES.join(', ')}` });
    if (oldValue.is_editable === 0 && oldValue.is_default === 1) {
      // still allow status/marking/threshold updates but block destructive name/type changes
    }
    db.prepare(`UPDATE assessment_checklists SET checklist_code = ?, checklist_name = ?, checklist_type = ?, description = ?, source_name = ?, version_label = ?, effective_date = ?, status = ?, marking_enabled = ?, total_possible_marks = ?, internal_threshold_label = ?, internal_pass_mark = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(req.body.checklistCode ?? oldValue.checklist_code, req.body.checklistName ?? oldValue.checklist_name, req.body.checklistType ?? oldValue.checklist_type, req.body.description ?? oldValue.description, req.body.sourceName ?? oldValue.source_name, req.body.versionLabel ?? oldValue.version_label, req.body.effectiveDate ?? oldValue.effective_date, req.body.status ?? oldValue.status, req.body.markingEnabled !== undefined ? (req.body.markingEnabled ? 1 : 0) : oldValue.marking_enabled, req.body.totalPossibleMarks !== undefined && req.body.totalPossibleMarks !== '' ? Number(req.body.totalPossibleMarks) : oldValue.total_possible_marks, req.body.internalThresholdLabel ?? oldValue.internal_threshold_label, req.body.internalPassMark !== undefined && req.body.internalPassMark !== '' ? Number(req.body.internalPassMark) : oldValue.internal_pass_mark, req.params.id);
    audit(req, { action: 'edit', entity: 'assessment_checklists', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  router.post('/checklists/:id/archive', requirePermission('assessments', 'approve'), (req, res) => {
    const db = getDb();
    const c = db.prepare('SELECT * FROM assessment_checklists WHERE id = ?').get(req.params.id) as any;
    if (!c) return res.status(404).json({ error: 'Checklist not found' });
    db.prepare("UPDATE assessment_checklists SET status = 'archived', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
    audit(req, { action: 'archive', entity: 'assessment_checklists', entityId: req.params.id, oldValue: { status: c.status }, newValue: { status: 'archived' } });
    res.json({ ok: true });
  });

  router.post('/checklists/:id/toggle', requirePermission('assessments', 'edit'), (req, res) => {
    const db = getDb();
    const c = db.prepare('SELECT * FROM assessment_checklists WHERE id = ?').get(req.params.id) as any;
    if (!c) return res.status(404).json({ error: 'Checklist not found' });
    const newStatus = c.status === 'active' ? 'inactive' : 'active';
    db.prepare('UPDATE assessment_checklists SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(newStatus, req.params.id);
    audit(req, { action: 'toggle', entity: 'assessment_checklists', entityId: req.params.id, oldValue: { status: c.status }, newValue: { status: newStatus } });
    res.json({ ok: true, status: newStatus });
  });

  router.post('/checklists/:id/sections', requirePermission('assessments', 'create'), (req, res) => {
    if (!req.body.sectionTitle) return res.status(400).json({ error: 'sectionTitle is required' });
    const db = getDb();
    const checklist = db.prepare('SELECT id FROM assessment_checklists WHERE id = ?').get(req.params.id);
    if (!checklist) return res.status(404).json({ error: 'Checklist not found' });
    const result = db.prepare(`INSERT INTO assessment_checklist_sections (checklist_id, section_code, section_title, section_description, display_order, is_active, section_possible_marks, section_weight, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(req.params.id, req.body.sectionCode ?? null, req.body.sectionTitle, req.body.sectionDescription ?? null, parseIntNullable(req.body.displayOrder) ?? 0, req.body.isActive === false ? 0 : 1, req.body.sectionPossibleMarks !== undefined && req.body.sectionPossibleMarks !== '' ? Number(req.body.sectionPossibleMarks) : null, req.body.sectionWeight !== undefined && req.body.sectionWeight !== '' ? Number(req.body.sectionWeight) : null, req.user!.id);
    const id = Number(result.lastInsertRowid);
    audit(req, { action: 'create', entity: 'assessment_checklist_sections', entityId: id, newValue: { checklistId: req.params.id, ...req.body } });
    res.status(201).json({ id });
  });

  router.put('/checklists/:id/sections/:sectionId', requirePermission('assessments', 'edit'), (req, res) => {
    const db = getDb();
    const old = db.prepare('SELECT * FROM assessment_checklist_sections WHERE id = ? AND checklist_id = ?').get(req.params.sectionId, req.params.id) as any;
    if (!old) return res.status(404).json({ error: 'Section not found' });
    db.prepare(`UPDATE assessment_checklist_sections SET section_code = ?, section_title = ?, section_description = ?, display_order = ?, is_active = ?, section_possible_marks = ?, section_weight = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(req.body.sectionCode ?? old.section_code, req.body.sectionTitle ?? old.section_title, req.body.sectionDescription ?? old.section_description, parseIntNullable(req.body.displayOrder) ?? old.display_order, req.body.isActive !== undefined ? (req.body.isActive ? 1 : 0) : old.is_active, req.body.sectionPossibleMarks !== undefined && req.body.sectionPossibleMarks !== '' ? Number(req.body.sectionPossibleMarks) : old.section_possible_marks, req.body.sectionWeight !== undefined && req.body.sectionWeight !== '' ? Number(req.body.sectionWeight) : old.section_weight, req.params.sectionId);
    audit(req, { action: 'edit', entity: 'assessment_checklist_sections', entityId: req.params.sectionId, oldValue: old, newValue: req.body });
    res.json({ ok: true });
  });

  router.post('/checklists/:id/questions', requirePermission('assessments', 'create'), (req, res) => {
    if (!req.body.questionText) return res.status(400).json({ error: 'questionText is required' });
    if (!req.body.responseType) return res.status(400).json({ error: 'responseType is required' });
    const db = getDb();
    const checklist = db.prepare('SELECT id FROM assessment_checklists WHERE id = ?').get(req.params.id);
    if (!checklist) return res.status(404).json({ error: 'Checklist not found' });
    const result = db.prepare(`INSERT INTO assessment_checklist_questions (checklist_id, section_id, question_code, question_text, guidance, expected_evidence, response_type, display_order, is_required, is_active, max_marks, weight, scoring_guidance, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(req.params.id, parseIntNullable(req.body.sectionId), req.body.questionCode ?? null, req.body.questionText, req.body.guidance ?? null, req.body.expectedEvidence ?? null, req.body.responseType, parseIntNullable(req.body.displayOrder) ?? 0, req.body.isRequired ? 1 : 0, req.body.isActive === false ? 0 : 1, req.body.maxMarks !== undefined && req.body.maxMarks !== '' ? Number(req.body.maxMarks) : null, req.body.weight !== undefined && req.body.weight !== '' ? Number(req.body.weight) : null, req.body.scoringGuidance ?? null, req.user!.id);
    const id = Number(result.lastInsertRowid);
    audit(req, { action: 'create', entity: 'assessment_checklist_questions', entityId: id, newValue: { checklistId: req.params.id, ...req.body } });
    res.status(201).json({ id });
  });

  router.put('/checklists/:id/questions/:questionId', requirePermission('assessments', 'edit'), (req, res) => {
    const db = getDb();
    const old = db.prepare('SELECT * FROM assessment_checklist_questions WHERE id = ? AND checklist_id = ?').get(req.params.questionId, req.params.id) as any;
    if (!old) return res.status(404).json({ error: 'Question not found' });
    db.prepare(`UPDATE assessment_checklist_questions SET section_id = ?, question_code = ?, question_text = ?, guidance = ?, expected_evidence = ?, response_type = ?, display_order = ?, is_required = ?, is_active = ?, max_marks = ?, weight = ?, scoring_guidance = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(parseIntNullable(req.body.sectionId) ?? old.section_id, req.body.questionCode ?? old.question_code, req.body.questionText ?? old.question_text, req.body.guidance ?? old.guidance, req.body.expectedEvidence ?? old.expected_evidence, req.body.responseType ?? old.response_type, parseIntNullable(req.body.displayOrder) ?? old.display_order, req.body.isRequired !== undefined ? (req.body.isRequired ? 1 : 0) : old.is_required, req.body.isActive !== undefined ? (req.body.isActive ? 1 : 0) : old.is_active, req.body.maxMarks !== undefined && req.body.maxMarks !== '' ? Number(req.body.maxMarks) : old.max_marks, req.body.weight !== undefined && req.body.weight !== '' ? Number(req.body.weight) : old.weight, req.body.scoringGuidance ?? old.scoring_guidance, req.params.questionId);
    audit(req, { action: 'edit', entity: 'assessment_checklist_questions', entityId: req.params.questionId, oldValue: old, newValue: req.body });
    res.json({ ok: true });
  });

  // -------- Per-assessment planning + responses --------
  router.post('/:id/select-checklist', requirePermission('assessments', 'edit'), (req, res) => {
    if (!parseIntNullable(req.body.checklistId)) return res.status(400).json({ error: 'checklistId is required' });
    if (!req.body.selectionMode) return res.status(400).json({ error: 'selectionMode is required' });
    if (!SELECTION_MODES.includes(req.body.selectionMode)) return res.status(400).json({ error: `selectionMode must be one of: ${SELECTION_MODES.join(', ')}` });
    const db = getDb();
    const program = db.prepare('SELECT id FROM assessment_programs WHERE id = ?').get(req.params.id);
    if (!program) return res.status(404).json({ error: 'Assessment not found' });
    const checklist = db.prepare('SELECT * FROM assessment_checklists WHERE id = ?').get(req.body.checklistId) as any;
    if (!checklist) return res.status(404).json({ error: 'Checklist not found' });
    const selectedBy = getStaffIdOrCurrent(req, req.body.selectedByStaffId);
    const mode = req.body.selectionMode;
    const sectionIds: number[] = Array.isArray(req.body.sectionIds) ? req.body.sectionIds.map((n: unknown) => Number(n)).filter((n: number) => isFinite(n)) : [];
    const questionIds: number[] = Array.isArray(req.body.questionIds) ? req.body.questionIds.map((n: unknown) => Number(n)).filter((n: number) => isFinite(n)) : [];

    let resolvedQuestionIds: number[] = [];
    if (mode === 'whole_checklist') {
      resolvedQuestionIds = (db.prepare('SELECT id FROM assessment_checklist_questions WHERE checklist_id = ? AND is_active = 1').all(req.body.checklistId) as Array<{ id: number }>).map(r => r.id);
    } else if (mode === 'selected_sections') {
      if (!sectionIds.length) return res.status(400).json({ error: 'sectionIds is required for selected_sections mode' });
      const placeholders = sectionIds.map(() => '?').join(',');
      resolvedQuestionIds = (db.prepare(`SELECT id FROM assessment_checklist_questions WHERE checklist_id = ? AND is_active = 1 AND section_id IN (${placeholders})`).all(req.body.checklistId, ...sectionIds) as Array<{ id: number }>).map(r => r.id);
    } else if (mode === 'selected_questions' || mode === 'mixed') {
      if (!questionIds.length && !sectionIds.length) return res.status(400).json({ error: 'questionIds or sectionIds is required for selected_questions/mixed mode' });
      const set = new Set<number>(questionIds);
      if (sectionIds.length) {
        const placeholders = sectionIds.map(() => '?').join(',');
        for (const r of db.prepare(`SELECT id FROM assessment_checklist_questions WHERE checklist_id = ? AND is_active = 1 AND section_id IN (${placeholders})`).all(req.body.checklistId, ...sectionIds) as Array<{ id: number }>) set.add(r.id);
      }
      resolvedQuestionIds = Array.from(set);
    }
    if (!resolvedQuestionIds.length) return res.status(400).json({ error: 'No questions resolved for this selection' });

    const insertSel = db.prepare(`INSERT OR REPLACE INTO assessment_selected_checklists (assessment_program_id, checklist_id, selection_mode, selected_by_staff_id, selected_at, notes, marking_enabled_at_selection, total_possible_marks_at_selection, created_by) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?, ?, ?)`);
    const insertQ = db.prepare(`INSERT OR IGNORE INTO assessment_selected_questions (assessment_program_id, checklist_id, section_id, question_id, included, planned_for_review, question_text_at_selection, section_title_at_selection, max_marks_at_selection, weight_at_selection, scoring_guidance_at_selection, created_by) VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?, ?)`);
    let totalPossibleAtSelection = 0;
    let savedCount = 0;
    const tx = db.transaction(() => {
      insertSel.run(req.params.id, req.body.checklistId, mode, selectedBy, req.body.notes ?? null, checklist.marking_enabled, checklist.total_possible_marks ?? null, req.user!.id);
      for (const qid of resolvedQuestionIds) {
        const q = db.prepare('SELECT q.*, s.section_title FROM assessment_checklist_questions q LEFT JOIN assessment_checklist_sections s ON s.id = q.section_id WHERE q.id = ?').get(qid) as any;
        if (!q) continue;
        insertQ.run(req.params.id, req.body.checklistId, q.section_id, q.id, q.question_text, q.section_title, q.max_marks, q.weight, q.scoring_guidance, req.user!.id);
        if (checklist.marking_enabled && q.max_marks !== null && q.max_marks !== undefined) totalPossibleAtSelection += Number(q.max_marks);
        savedCount++;
      }
    });
    tx();

    audit(req, { action: 'select_checklist', entity: 'assessment_programs', entityId: req.params.id, newValue: { checklistId: req.body.checklistId, mode, savedCount, totalPossibleAtSelection } });
    res.status(201).json({ ok: true, savedCount, totalPossibleAtSelection });
  });

  router.get('/:id/selected-questions', requirePermission('assessments', 'view'), (req, res) => {
    const db = getDb();
    res.json(db.prepare(`SELECT sq.*, c.checklist_name, c.checklist_type, c.marking_enabled,
        r.id AS response_id, r.response AS existing_response, r.evidence_summary AS existing_evidence_summary,
        r.marks_awarded AS existing_marks_awarded, r.score_comment AS existing_score_comment,
        r.finding_required AS existing_finding_required, r.finding_id AS existing_finding_id
      FROM assessment_selected_questions sq
      JOIN assessment_checklists c ON c.id = sq.checklist_id
      LEFT JOIN assessment_question_responses r ON r.assessment_program_id = sq.assessment_program_id AND r.question_id = sq.question_id
      WHERE sq.assessment_program_id = ? AND sq.included = 1
      ORDER BY c.checklist_name, sq.section_id, sq.id`).all(req.params.id));
  });

  router.post('/:id/selected-questions', requirePermission('assessments', 'edit'), (req, res) => {
    const ids: number[] = Array.isArray(req.body.removeQuestionIds) ? req.body.removeQuestionIds.map((n: unknown) => Number(n)).filter((n: number) => isFinite(n)) : [];
    const db = getDb();
    let removed = 0;
    if (ids.length) {
      const placeholders = ids.map(() => '?').join(',');
      const r = db.prepare(`UPDATE assessment_selected_questions SET included = 0 WHERE assessment_program_id = ? AND question_id IN (${placeholders})`).run(req.params.id, ...ids);
      removed = r.changes;
    }
    audit(req, { action: 'edit_selected_questions', entity: 'assessment_programs', entityId: req.params.id, newValue: { removed, removeQuestionIds: ids } });
    res.json({ ok: true, removed });
  });

  router.post('/:id/question-response', requirePermission('assessments', 'edit'), (req, res) => {
    if (!parseIntNullable(req.body.questionId)) return res.status(400).json({ error: 'questionId is required' });
    if (!req.body.response) return res.status(400).json({ error: 'response is required' });
    if (!RESPONSE_OPTIONS.includes(req.body.response)) return res.status(400).json({ error: `response must be one of: ${RESPONSE_OPTIONS.join(', ')}` });
    const db = getDb();
    const sel = db.prepare('SELECT sq.*, c.marking_enabled FROM assessment_selected_questions sq JOIN assessment_checklists c ON c.id = sq.checklist_id WHERE sq.assessment_program_id = ? AND sq.question_id = ? AND sq.included = 1').get(req.params.id, req.body.questionId) as any;
    if (!sel) return res.status(404).json({ error: 'Question is not part of this assessment' });
    const marksAwarded = req.body.marksAwarded !== undefined && req.body.marksAwarded !== '' ? Number(req.body.marksAwarded) : null;
    const maxAtAssessment = req.body.maxMarksAtAssessment !== undefined && req.body.maxMarksAtAssessment !== '' ? Number(req.body.maxMarksAtAssessment) : sel.max_marks_at_selection;
    if (marksAwarded !== null) {
      if (!Number.isFinite(marksAwarded) || marksAwarded < 0) return res.status(400).json({ error: 'marksAwarded must be a non-negative number' });
      if (maxAtAssessment !== null && maxAtAssessment !== undefined) {
        if (!Number.isFinite(Number(maxAtAssessment)) || Number(maxAtAssessment) < 0) return res.status(400).json({ error: 'maxMarksAtAssessment must be a non-negative number' });
        if (marksAwarded > Number(maxAtAssessment)) return res.status(400).json({ error: 'marksAwarded cannot exceed maxMarksAtAssessment' });
      }
    }
    const assessedBy = getStaffIdOrCurrent(req, req.body.assessedByStaffId);
    const existing = db.prepare('SELECT * FROM assessment_question_responses WHERE assessment_program_id = ? AND question_id = ?').get(req.params.id, req.body.questionId) as any;
    let id: number;
    if (existing) {
      snapshotResponse(db, existing, req.user!.id);
      db.prepare('UPDATE assessment_question_responses SET response = ?, evidence_summary = ?, finding_required = ?, marks_awarded = ?, max_marks_at_assessment = ?, score_comment = ?, assessed_by_staff_id = ?, assessed_at = CURRENT_TIMESTAMP, notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(req.body.response, req.body.evidenceSummary ?? null, req.body.findingRequired ? 1 : 0, marksAwarded, maxAtAssessment ?? null, req.body.scoreComment ?? null, assessedBy, req.body.notes ?? null, existing.id);
      id = existing.id;
    } else {
      const result = db.prepare(`INSERT INTO assessment_question_responses (assessment_program_id, checklist_id, section_id, question_id, response, evidence_summary, finding_required, marks_awarded, max_marks_at_assessment, score_comment, assessed_by_staff_id, assessed_at, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?)`)
        .run(req.params.id, sel.checklist_id, sel.section_id, req.body.questionId, req.body.response, req.body.evidenceSummary ?? null, req.body.findingRequired ? 1 : 0, marksAwarded, maxAtAssessment ?? null, req.body.scoreComment ?? null, assessedBy, req.body.notes ?? null, req.user!.id);
      id = Number(result.lastInsertRowid);
    }
    audit(req, { action: existing ? 'edit_question_response' : 'create_question_response', entity: 'assessment_question_responses', entityId: id, newValue: { assessmentProgramId: req.params.id, ...req.body } });
    res.status(existing ? 200 : 201).json({ id });
  });

  router.put('/:id/question-response/:responseId', requirePermission('assessments', 'edit'), (req, res) => {
    const db = getDb();
    const old = db.prepare('SELECT * FROM assessment_question_responses WHERE id = ? AND assessment_program_id = ?').get(req.params.responseId, req.params.id) as any;
    if (!old) return res.status(404).json({ error: 'Response not found' });
    if (req.body.response && !RESPONSE_OPTIONS.includes(req.body.response)) return res.status(400).json({ error: `response must be one of: ${RESPONSE_OPTIONS.join(', ')}` });
    const marksAwarded = req.body.marksAwarded !== undefined && req.body.marksAwarded !== '' ? Number(req.body.marksAwarded) : old.marks_awarded;
    const maxAtAssessment = req.body.maxMarksAtAssessment !== undefined && req.body.maxMarksAtAssessment !== '' ? Number(req.body.maxMarksAtAssessment) : old.max_marks_at_assessment;
    if (marksAwarded !== null && marksAwarded !== undefined) {
      if (!Number.isFinite(marksAwarded) || marksAwarded < 0) return res.status(400).json({ error: 'marksAwarded must be a non-negative number' });
      if (maxAtAssessment !== null && maxAtAssessment !== undefined && marksAwarded > Number(maxAtAssessment)) return res.status(400).json({ error: 'marksAwarded cannot exceed maxMarksAtAssessment' });
    }
    snapshotResponse(db, old, req.user!.id);
    db.prepare('UPDATE assessment_question_responses SET response = ?, evidence_summary = ?, finding_required = ?, marks_awarded = ?, max_marks_at_assessment = ?, score_comment = ?, notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(req.body.response ?? old.response, req.body.evidenceSummary ?? old.evidence_summary, req.body.findingRequired !== undefined ? (req.body.findingRequired ? 1 : 0) : old.finding_required, marksAwarded, maxAtAssessment, req.body.scoreComment ?? old.score_comment, req.body.notes ?? old.notes, req.params.responseId);
    audit(req, { action: 'edit_question_response', entity: 'assessment_question_responses', entityId: req.params.responseId, oldValue: old, newValue: req.body });
    res.json({ ok: true });
  });

  router.get('/:id/question-response/:responseId/history', requirePermission('assessments', 'view'), (req, res) => {
    const db = getDb();
    const exists = db.prepare('SELECT id FROM assessment_question_responses WHERE id = ? AND assessment_program_id = ?').get(req.params.responseId, req.params.id);
    if (!exists) return res.status(404).json({ error: 'Response not found' });
    res.json(db.prepare('SELECT * FROM assessment_question_response_history WHERE response_id = ? ORDER BY snapshot_at DESC, id DESC').all(req.params.responseId));
  });

  router.post('/:id/question-response/:responseId/create-finding', requirePermission('assessments', 'create'), (req, res) => {
    if (!req.body.findingType) return res.status(400).json({ error: 'findingType is required' });
    if (!FINDING_TYPES.includes(req.body.findingType)) return res.status(400).json({ error: `findingType must be one of: ${FINDING_TYPES.join(', ')}` });
    if (!req.body.description) return res.status(400).json({ error: 'description is required' });
    const db = getDb();
    const response = db.prepare('SELECT r.*, q.question_text FROM assessment_question_responses r JOIN assessment_checklist_questions q ON q.id = r.question_id WHERE r.id = ? AND r.assessment_program_id = ?').get(req.params.responseId, req.params.id) as any;
    if (!response) return res.status(404).json({ error: 'Response not found' });
    const createdAt = new Date().toISOString();
    const findingNumber = generateRecordNumber(db, 'assessment_findings', 'FIND', createdAt);
    const result = db.prepare(`INSERT INTO assessment_findings (finding_number, assessment_program_id, finding_date, finding_type, title, description, evidence_summary, severity, responsible_staff_id, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(findingNumber, req.params.id, req.body.findingDate ?? createdAt.slice(0, 10), req.body.findingType, req.body.title ?? response.question_text.slice(0, 120), req.body.description, req.body.evidenceSummary ?? response.evidence_summary ?? null, req.body.severity ?? null, parseIntNullable(req.body.responsibleStaffId), 'open', req.user!.id, createdAt);
    const findingId = Number(result.lastInsertRowid);
    db.prepare('UPDATE assessment_question_responses SET finding_id = ?, finding_required = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(findingId, req.params.responseId);
    insertLink(db, { module: 'assessments', type: 'assessment_question_responses', id: req.params.responseId }, { module: 'assessments', type: 'assessment_findings', id: findingId }, 'Finding created from checklist response');
    audit(req, { action: 'create', entity: 'assessment_findings', entityId: findingId, newValue: { findingNumber, sourceResponseId: req.params.responseId, ...req.body } });
    res.status(201).json({ id: findingId, findingNumber });
  });

  router.get('/:id/print', requirePermission('assessments', 'print'), (req, res) => {
    const db = getDb();
    const program = db.prepare(`SELECT p.*, s.full_name AS lead_assessor_name, d.name AS department_name, sec.name AS section_name
      FROM assessment_programs p
      LEFT JOIN staff s ON s.id = p.lead_assessor_staff_id
      LEFT JOIN departments d ON d.id = p.department_id
      LEFT JOIN sections sec ON sec.id = p.section_id
      WHERE p.id = ?`).get(req.params.id) as any;
    if (!program) return res.status(404).send('Assessment not found');
    const selectedChecklists = db.prepare(`SELECT sc.*, c.checklist_name, c.checklist_code, c.checklist_type, c.internal_threshold_label, c.internal_pass_mark
      FROM assessment_selected_checklists sc JOIN assessment_checklists c ON c.id = sc.checklist_id
      WHERE sc.assessment_program_id = ?`).all(req.params.id) as any[];
    const questions = db.prepare(`SELECT sq.*, c.checklist_name, c.marking_enabled,
        r.response, r.evidence_summary, r.marks_awarded, r.score_comment, r.assessed_at,
        sa.full_name AS assessed_by_name
      FROM assessment_selected_questions sq
      JOIN assessment_checklists c ON c.id = sq.checklist_id
      LEFT JOIN assessment_question_responses r ON r.assessment_program_id = sq.assessment_program_id AND r.question_id = sq.question_id
      LEFT JOIN staff sa ON sa.id = r.assessed_by_staff_id
      WHERE sq.assessment_program_id = ? AND sq.included = 1
      ORDER BY c.checklist_name, sq.section_id, sq.id`).all(req.params.id) as any[];
    const findings = db.prepare(`SELECT f.*, s.full_name AS responsible_name
      FROM assessment_findings f LEFT JOIN staff s ON s.id = f.responsible_staff_id
      WHERE f.assessment_program_id = ? ORDER BY f.finding_date, f.id`).all(req.params.id) as any[];

    // Score summary (inline)
    const planned = (db.prepare("SELECT COUNT(*) AS c FROM assessment_selected_questions WHERE assessment_program_id = ? AND included = 1").get(req.params.id) as { c: number }).c;
    const assessed = (db.prepare("SELECT COUNT(*) AS c FROM assessment_question_responses WHERE assessment_program_id = ?").get(req.params.id) as { c: number }).c;
    const totalPossible = Number((db.prepare("SELECT COALESCE(SUM(max_marks_at_selection), 0) AS s FROM assessment_selected_questions WHERE assessment_program_id = ? AND included = 1").get(req.params.id) as { s: number }).s || 0);
    const totalAwarded = Number((db.prepare("SELECT COALESCE(SUM(marks_awarded), 0) AS s FROM assessment_question_responses WHERE assessment_program_id = ? AND marks_awarded IS NOT NULL").get(req.params.id) as { s: number }).s || 0);
    const rawPct = totalPossible > 0 ? (totalAwarded / totalPossible) * 100 : null;
    const responseRows = db.prepare("SELECT response, COUNT(*) AS c FROM assessment_question_responses WHERE assessment_program_id = ? GROUP BY response").all(req.params.id) as Array<{ response: string; c: number }>;

    const esc = (v: unknown) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const autoprint = req.query.autoprint === '0' ? '' : '<script>window.addEventListener("load", () => { setTimeout(() => window.print(), 250); });</script>';

    // Group questions by checklist -> section for the body
    const byChecklist = new Map<string, Map<string, any[]>>();
    for (const q of questions) {
      const cName = q.checklist_name || `Checklist #${q.checklist_id}`;
      const sName = q.section_title_at_selection || '(no section)';
      if (!byChecklist.has(cName)) byChecklist.set(cName, new Map());
      const m = byChecklist.get(cName)!;
      if (!m.has(sName)) m.set(sName, []);
      m.get(sName)!.push(q);
    }

    const checklistBlocks = Array.from(byChecklist.entries()).map(([cName, sections]) => {
      const sectionBlocks = Array.from(sections.entries()).map(([sName, rows]) => {
        const markingOn = rows.some(r => r.marking_enabled === 1);
        return `<h3>${esc(sName)}</h3>
<table class="qtable"><thead><tr><th style="width:6%">#</th><th>Question</th><th style="width:14%">Response</th>${markingOn ? '<th style="width:12%">Marks awarded / max</th>' : ''}<th style="width:22%">Evidence summary</th><th style="width:14%">Assessed by</th></tr></thead><tbody>
${rows.map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.question_text_at_selection || '')}</td><td>${esc((r.response || 'not_assessed').replace(/_/g, ' '))}</td>${markingOn ? `<td>${r.marks_awarded ?? '—'} / ${r.max_marks_at_selection ?? '—'}</td>` : ''}<td>${esc(r.evidence_summary || '—')}</td><td>${esc(r.assessed_by_name || '—')}${r.assessed_at ? `<br/><small>${esc(String(r.assessed_at).slice(0, 19).replace('T', ' '))}</small>` : ''}</td></tr>`).join('')}
</tbody></table>`;
      }).join('');
      return `<h2 class="checklist-heading">${esc(cName)}</h2>${sectionBlocks}`;
    }).join('');

    const findingsHtml = findings.length === 0 ? '<p><em>No findings recorded for this assessment.</em></p>' : `<table class="qtable"><thead><tr><th>#</th><th>Date</th><th>Type</th><th>Title</th><th>Severity</th><th>Status</th><th>NC / CAPA</th><th>Responsible</th></tr></thead><tbody>
${findings.map(f => `<tr><td>${esc(f.finding_number)}</td><td>${esc(f.finding_date)}</td><td>${esc((f.finding_type || '').replace(/_/g, ' '))}</td><td>${esc(f.title)}<br/><small>${esc(f.description || '')}</small></td><td>${esc(f.severity || '—')}</td><td>${esc(f.status)}</td><td>${f.nc_id ? `NC #${f.nc_id}` : '—'}${f.capa_id ? ` / CAPA #${f.capa_id}` : ''}</td><td>${esc(f.responsible_name || '—')}</td></tr>`).join('')}
</tbody></table>`;

    const responseDistHtml = `<table class="qtable" style="width:auto"><thead><tr><th>Response</th><th>Count</th></tr></thead><tbody>
${['met','partially_met','not_met','not_applicable','not_assessed','observation_only'].map(k => {
  const c = responseRows.find(r => r.response === k)?.c ?? 0;
  return `<tr><td>${k.replace(/_/g, ' ')}</td><td>${c}</td></tr>`;
}).join('')}
</tbody></table>`;

    const checklistSummaryHtml = selectedChecklists.length === 0 ? '<p><em>No checklist selected for this assessment.</em></p>' : `<table class="qtable"><thead><tr><th>Checklist</th><th>Type</th><th>Selection mode</th><th>Marking</th><th>Internal pass mark</th></tr></thead><tbody>
${selectedChecklists.map(c => `<tr><td>${esc(c.checklist_name)}${c.checklist_code ? ` <small>(${esc(c.checklist_code)})</small>` : ''}</td><td>${esc((c.checklist_type || '').replace(/_/g, ' '))}</td><td>${esc((c.selection_mode || '').replace(/_/g, ' '))}</td><td>${c.marking_enabled_at_selection ? 'enabled' : 'disabled'}</td><td>${c.internal_pass_mark !== null && c.internal_pass_mark !== undefined ? `${c.internal_pass_mark}% (${esc(c.internal_threshold_label || 'Internal pass threshold')})` : '—'}</td></tr>`).join('')}
</tbody></table>`;

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>${esc(program.program_number || 'Assessment')} — Print</title>
<style>
@page { size: A4; margin: 14mm; }
body { font-family: 'Times New Roman', Georgia, serif; color: #111; margin: 0; padding: 18px 24px; line-height: 1.4; }
.no-print { background: #f4f6fb; padding: 8px 12px; border: 1px solid #ccd; border-radius: 6px; margin-bottom: 12px; font-size: 12px; }
h1 { font-size: 20px; border-bottom: 2px solid #1B3A6B; padding-bottom: 6px; margin: 0 0 12px; }
h2 { font-size: 14px; color: #1B3A6B; margin-top: 18px; border-bottom: 1px solid #ccd; padding-bottom: 3px; }
h2.checklist-heading { background: #eef2f7; padding: 4px 8px; border: 1px solid #ccd; border-radius: 4px; }
h3 { font-size: 12px; margin: 10px 0 4px; color: #333; }
table.meta { border-collapse: collapse; width: 100%; font-size: 11px; margin: 6px 0 16px; }
table.meta th, table.meta td { border: 1px solid #888; padding: 4px 8px; text-align: left; vertical-align: top; }
table.meta th { background: #eef2f7; width: 22%; }
table.qtable { border-collapse: collapse; width: 100%; font-size: 10.5px; margin: 4px 0 12px; page-break-inside: auto; }
table.qtable th, table.qtable td { border: 1px solid #aaa; padding: 4px 6px; vertical-align: top; }
table.qtable thead th { background: #eef2f7; }
.cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin: 6px 0 14px; }
.metric-card { border: 1px solid #ccd; border-radius: 6px; padding: 8px; font-size: 11px; }
.metric-card .label { color: #555; font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; }
.metric-card .value { font-size: 18px; font-weight: bold; color: #1B3A6B; }
.signoff { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-top: 28px; }
.signoff .block { border-top: 1px solid #555; padding-top: 4px; font-size: 11px; }
.footer { font-size: 10px; color: #555; margin-top: 24px; border-top: 1px solid #ccc; padding-top: 6px; }
.disclaimer { font-size: 10px; color: #777; font-style: italic; margin-top: 4px; }
@media print { .no-print { display: none; } body { padding: 0; } }
</style>${autoprint}</head><body>
<div class="no-print">
  The print dialog will open automatically. Choose any installed printer or <strong>Save as PDF</strong>. If it didn't open, click here: <button onclick="window.print()">Print</button>
  &nbsp;<a href="?autoprint=0" style="margin-left:8px;font-size:11px;">disable autoprint</a>
</div>
<h1>${esc(program.program_number || '—')} &nbsp;&mdash;&nbsp; ${esc(program.title)}</h1>
<table class="meta">
  <tr><th>Programme number</th><td>${esc(program.program_number || '—')}</td><th>Assessment type</th><td>${esc((program.assessment_type || '').replace(/_/g, ' '))}</td></tr>
  <tr><th>Status</th><td>${esc(program.status)}</td><th>Lead assessor</th><td>${esc(program.lead_assessor_name || '—')}</td></tr>
  <tr><th>Planned period</th><td>${esc(program.planned_start_date || '—')} &nbsp;to&nbsp; ${esc(program.planned_end_date || '—')}</td><th>Department / Section</th><td>${esc(program.department_name || '—')}${program.section_name ? ' / ' + esc(program.section_name) : ''}</td></tr>
  ${program.scope ? `<tr><th>Scope</th><td colspan="3">${esc(program.scope)}</td></tr>` : ''}
  ${program.objectives ? `<tr><th>Objectives</th><td colspan="3">${esc(program.objectives)}</td></tr>` : ''}
</table>

<h2>Selected checklists</h2>
${checklistSummaryHtml}

<h2>Internal audit marks summary</h2>
<div class="cards">
  <div class="metric-card"><div class="label">Questions planned</div><div class="value">${planned}</div></div>
  <div class="metric-card"><div class="label">Questions assessed</div><div class="value">${assessed}</div></div>
  <div class="metric-card"><div class="label">Total possible marks</div><div class="value">${totalPossible}</div></div>
  <div class="metric-card"><div class="label">Marks awarded</div><div class="value">${totalAwarded}</div></div>
  <div class="metric-card"><div class="label">Internal Assessment Score</div><div class="value">${rawPct !== null ? rawPct.toFixed(1) + '%' : '—'}</div></div>
  <div class="metric-card"><div class="label">Findings recorded</div><div class="value">${findings.length}</div></div>
</div>
<p class="disclaimer">Internal Audit Marks — not an accreditation or official compliance score.</p>

<h3>Response distribution</h3>
${responseDistHtml}

<h2>Checklist responses</h2>
${checklistBlocks || '<p><em>No checklist questions were planned for this assessment.</em></p>'}

<h2>Findings</h2>
${findingsHtml}

<div class="signoff">
  <div class="block"><strong>Lead assessor signature</strong><br/>${esc(program.lead_assessor_name || '__________________________')}<br/><br/>Date: __________________</div>
  <div class="block"><strong>Laboratory representative signature</strong><br/>__________________________<br/><br/>Date: __________________</div>
</div>

<div class="footer">SECH_LIMS by Nickland · Assessment report generated ${new Date().toISOString().slice(0, 19).replace('T', ' ')} · Internal use only.</div>
</body></html>`;

    audit(req, { action: 'print', entity: 'assessment_programs', entityId: req.params.id, newValue: { autoprint: req.query.autoprint !== '0' } });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  });

  router.get('/checklists/:id/print', requirePermission('assessments', 'print'), (req, res) => {
    const db = getDb();
    const checklist = db.prepare('SELECT * FROM assessment_checklists WHERE id = ?').get(req.params.id) as any;
    if (!checklist) return res.status(404).send('Checklist not found');
    const sections = db.prepare('SELECT * FROM assessment_checklist_sections WHERE checklist_id = ? ORDER BY display_order, id').all(req.params.id) as any[];
    const questions = db.prepare('SELECT * FROM assessment_checklist_questions WHERE checklist_id = ? AND is_active = 1 ORDER BY section_id, display_order, id').all(req.params.id) as any[];
    const esc = (v: unknown) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const autoprint = req.query.autoprint === '0' ? '' : '<script>window.addEventListener("load", () => { setTimeout(() => window.print(), 250); });</script>';
    const byId = new Map<number | null, any[]>();
    for (const q of questions) { const k = q.section_id ?? null; if (!byId.has(k)) byId.set(k, []); byId.get(k)!.push(q); }
    const sectionBlocks = sections.map(s => `<h3>${esc(s.section_title)}${s.section_possible_marks ? ` <small>(possible: ${s.section_possible_marks})</small>` : ''}</h3>
${s.section_description ? `<p>${esc(s.section_description)}</p>` : ''}
<table class="qtable"><thead><tr><th style="width:6%">#</th><th>Question</th><th style="width:14%">Response</th>${checklist.marking_enabled ? '<th style="width:12%">Marks / max</th>' : ''}<th style="width:22%">Evidence</th></tr></thead><tbody>
${(byId.get(s.id) ?? []).map((q, i) => `<tr><td>${i + 1}</td><td>${esc(q.question_text)}${q.guidance ? `<br/><small><em>${esc(q.guidance)}</em></small>` : ''}</td><td>&nbsp;</td>${checklist.marking_enabled ? `<td>&nbsp; / ${q.max_marks ?? '—'}</td>` : ''}<td>${q.expected_evidence ? esc(q.expected_evidence) : '&nbsp;'}</td></tr>`).join('')}
</tbody></table>`).join('');
    const orphan = byId.get(null);
    const orphanBlock = orphan && orphan.length ? `<h3>Unassigned questions</h3><table class="qtable"><tbody>${orphan.map((q, i) => `<tr><td style="width:6%">${i+1}</td><td>${esc(q.question_text)}</td></tr>`).join('')}</tbody></table>` : '';
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>${esc(checklist.checklist_code || checklist.checklist_name)} — Print</title>
<style>
@page { size: A4; margin: 14mm; }
body { font-family: 'Times New Roman', Georgia, serif; color: #111; padding: 18px 24px; }
.no-print { background: #f4f6fb; padding: 8px 12px; border: 1px solid #ccd; border-radius: 6px; margin-bottom: 12px; font-size: 12px; }
h1 { font-size: 18px; border-bottom: 2px solid #1B3A6B; padding-bottom: 6px; }
h3 { color: #1B3A6B; margin-top: 14px; }
table.qtable { border-collapse: collapse; width: 100%; font-size: 10.5px; }
table.qtable th, table.qtable td { border: 1px solid #aaa; padding: 4px 6px; vertical-align: top; }
table.qtable thead th { background: #eef2f7; }
@media print { .no-print { display: none; } body { padding: 0; } }
</style>${autoprint}</head><body>
<div class="no-print">The print dialog will open automatically. Choose any printer or Save as PDF. <button onclick="window.print()">Print</button> <a href="?autoprint=0">disable autoprint</a></div>
<h1>${esc(checklist.checklist_code || '')} ${checklist.checklist_code ? '—' : ''} ${esc(checklist.checklist_name)}</h1>
<p>Type: ${esc((checklist.checklist_type || '').replace(/_/g, ' '))} · Status: ${esc(checklist.status)} · Marking: ${checklist.marking_enabled ? 'enabled' : 'disabled'}${checklist.internal_pass_mark !== null && checklist.internal_pass_mark !== undefined ? ' · Internal pass mark: ' + checklist.internal_pass_mark + '%' : ''}</p>
${checklist.description ? `<p>${esc(checklist.description)}</p>` : ''}
${sectionBlocks}
${orphanBlock}
</body></html>`;
    audit(req, { action: 'print', entity: 'assessment_checklists', entityId: req.params.id });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  });

  router.get('/:id/internal-score-summary', requirePermission('assessments', 'view'), (req, res) => {
    const db = getDb();
    const program = db.prepare('SELECT id FROM assessment_programs WHERE id = ?').get(req.params.id);
    if (!program) return res.status(404).json({ error: 'Assessment not found' });
    const selectedChecklists = db.prepare(`SELECT sc.checklist_id, sc.marking_enabled_at_selection, c.checklist_name, c.internal_threshold_label, c.internal_pass_mark
      FROM assessment_selected_checklists sc JOIN assessment_checklists c ON c.id = sc.checklist_id WHERE sc.assessment_program_id = ?`).all(req.params.id) as Array<any>;
    const markingEnabled = selectedChecklists.some(c => c.marking_enabled_at_selection === 1);
    const planned = db.prepare("SELECT COUNT(*) AS c FROM assessment_selected_questions WHERE assessment_program_id = ? AND included = 1").get(req.params.id) as { c: number };
    const assessed = db.prepare("SELECT COUNT(*) AS c FROM assessment_question_responses WHERE assessment_program_id = ?").get(req.params.id) as { c: number };
    const sums = db.prepare("SELECT COALESCE(SUM(max_marks_at_selection), 0) AS total_possible FROM assessment_selected_questions WHERE assessment_program_id = ? AND included = 1").get(req.params.id) as { total_possible: number };
    const awarded = db.prepare("SELECT COALESCE(SUM(marks_awarded), 0) AS total_awarded FROM assessment_question_responses WHERE assessment_program_id = ? AND marks_awarded IS NOT NULL").get(req.params.id) as { total_awarded: number };
    const totalPossible = Number(sums.total_possible || 0);
    const totalAwarded = Number(awarded.total_awarded || 0);
    const pct = totalPossible > 0 ? (totalAwarded / totalPossible) * 100 : null;
    const sectionRows = db.prepare(`SELECT sq.section_id, MAX(sq.section_title_at_selection) AS section_title,
        MAX(sq.checklist_id) AS checklist_id,
        COUNT(*) AS questions_planned,
        SUM(CASE WHEN r.id IS NOT NULL THEN 1 ELSE 0 END) AS questions_assessed,
        COALESCE(SUM(sq.max_marks_at_selection), 0) AS possible_marks,
        COALESCE(SUM(r.marks_awarded), 0) AS marks_awarded
      FROM assessment_selected_questions sq
      LEFT JOIN assessment_question_responses r ON r.assessment_program_id = sq.assessment_program_id AND r.question_id = sq.question_id
      WHERE sq.assessment_program_id = ? AND sq.included = 1
      GROUP BY sq.section_id`).all(req.params.id) as any[];
    const sectionWeightLookup = db.prepare('SELECT id, section_weight FROM assessment_checklist_sections').all() as Array<{ id: number; section_weight: number | null }>;
    const weightMap = new Map(sectionWeightLookup.map(s => [s.id, s.section_weight]));
    const sections = sectionRows.map(s => {
      const possible = Number(s.possible_marks || 0);
      const awarded = Number(s.marks_awarded || 0);
      const sectionScore = possible > 0 ? (awarded / possible) * 100 : null;
      const weight = weightMap.get(s.section_id) ?? null;
      return {
        section_id: s.section_id,
        section_title: s.section_title,
        questions_planned: s.questions_planned ?? 0,
        questions_assessed: s.questions_assessed ?? 0,
        possible_marks: possible,
        marks_awarded: awarded,
        internal_score_percentage: sectionScore,
        section_weight: weight,
        weighted_contribution: weight !== null && weight !== undefined && sectionScore !== null ? sectionScore * Number(weight) : null
      };
    });
    let weightedScore: number | null = null;
    const weightedSections = sections.filter(s => s.section_weight !== null && s.section_weight !== undefined && s.internal_score_percentage !== null);
    if (weightedSections.length) {
      const totalWeight = weightedSections.reduce((acc, s) => acc + Number(s.section_weight!), 0);
      if (totalWeight > 0) weightedScore = weightedSections.reduce((acc, s) => acc + s.internal_score_percentage! * Number(s.section_weight!), 0) / totalWeight;
    }
    const responseRows = db.prepare("SELECT response, COUNT(*) AS c FROM assessment_question_responses WHERE assessment_program_id = ? GROUP BY response").all(req.params.id) as Array<{ response: string; c: number }>;
    const response_summary: Record<string, number> = { met: 0, partially_met: 0, not_met: 0, not_applicable: 0, not_assessed: 0, observation_only: 0 };
    for (const r of responseRows) response_summary[r.response] = r.c;
    const findingsCount = (db.prepare("SELECT COUNT(*) AS c FROM assessment_findings WHERE assessment_program_id = ?").get(req.params.id) as { c: number }).c;
    const reportingScore = weightedScore !== null ? weightedScore : pct;
    const passStatusPerChecklist = selectedChecklists.filter(c => c.internal_pass_mark !== null && c.internal_pass_mark !== undefined).map(c => {
      const possibleForChecklist = sections.filter(s => s.section_id !== null).reduce((acc, s) => {
        const cid = sectionRows.find(r => r.section_id === s.section_id)?.checklist_id;
        return cid === c.checklist_id ? acc + s.possible_marks : acc;
      }, 0);
      const awardedForChecklist = sections.filter(s => s.section_id !== null).reduce((acc, s) => {
        const cid = sectionRows.find(r => r.section_id === s.section_id)?.checklist_id;
        return cid === c.checklist_id ? acc + s.marks_awarded : acc;
      }, 0);
      const scoreForChecklist = possibleForChecklist > 0 ? (awardedForChecklist / possibleForChecklist) * 100 : null;
      return {
        checklist_id: c.checklist_id,
        checklist_name: c.checklist_name,
        internal_threshold_label: c.internal_threshold_label || 'Internal pass threshold',
        internal_pass_mark: Number(c.internal_pass_mark),
        score_against_checklist: scoreForChecklist,
        status: scoreForChecklist === null ? 'pending' : (scoreForChecklist >= Number(c.internal_pass_mark) ? 'pass' : 'attention')
      };
    });
    res.json({
      assessment_program_id: Number(req.params.id),
      marking_enabled: markingEnabled,
      total_questions_planned: planned.c,
      total_questions_assessed: assessed.c,
      total_possible_marks: totalPossible,
      total_marks_awarded: totalAwarded,
      internal_score_percentage: pct,
      weighted_internal_score_percentage: weightedScore,
      reporting_score_percentage: reportingScore,
      sections,
      response_summary,
      findings_count: findingsCount,
      pass_status_per_checklist: passStatusPerChecklist,
      label: 'Internal Audit Marks — not an accreditation or official compliance score.'
    });
  });

  router.get('/:id', requirePermission('assessments', 'view'), (req, res) => {
    const db = getDb();
    const program = db.prepare('SELECT * FROM assessment_programs WHERE id = ?').get(req.params.id) as any;
    if (!program) return res.status(404).json({ error: 'Assessment not found' });
    const findings = db.prepare('SELECT * FROM assessment_findings WHERE assessment_program_id = ? ORDER BY finding_date DESC, id DESC').all(req.params.id);
    const selectedChecklists = db.prepare('SELECT sc.*, c.checklist_name, c.checklist_type FROM assessment_selected_checklists sc JOIN assessment_checklists c ON c.id = sc.checklist_id WHERE sc.assessment_program_id = ? ORDER BY sc.id').all(req.params.id);
    res.json({ ...program, findings, selectedChecklists });
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

export { ASSESSMENT_STATUSES, FINDING_TYPES, FINDING_STATUSES, CHECKLIST_STATUSES, SELECTION_MODES, RESPONSE_OPTIONS };
