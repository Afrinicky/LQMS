import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { getDb, uploadRoot, evidenceRoot } from '../db/database.js';
import { requirePermission } from '../middleware/permissions.js';
import { resolvePermission } from '../services/permissionResolver.js';
import { requireAuth } from '../middleware/auth.js';
import { audit } from '../services/auditService.js';
import { generateRecordNumber } from '../utils/recordNumber.js';
import multer from 'multer';
import { getStaffIdOrCurrent } from './routeHelpers.js';
import { computeRisk, SEVERITY, OCCURRENCE, RISK_BANDS } from '../utils/riskMatrix.js';
import { buildWorkbook, sendWorkbook, readSheet, cell, numCell } from '../utils/xlsxRegister.js';

const ncXlsxUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
const NC_HEADERS = ['NCR Number', 'Date of Event', 'Time', 'Unit', 'Detected by', 'Type', 'Title', 'Description', 'Immediate action', 'Remedial action', 'Occurrence (1-5)', 'Severity (1-5)', 'Risk score', 'Risk level', 'Root cause', 'Corrective action', 'Preventive action', 'Status'] as const;

function parseIntNullable(value: unknown) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}
function escHtml(s: unknown): string { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string)); }
function p_facility(db: any): string { const p = db.prepare('SELECT facility_name FROM laboratory_profile WHERE id = 1').get() as any; return p?.facility_name || 'Laboratory'; }
function labMasthead(db: any): string {
  const p = db.prepare('SELECT * FROM laboratory_profile WHERE id = 1').get() as any;
  let logo = '';
  if (p?.logo_file_id) { const f = db.prepare('SELECT * FROM files WHERE id = ?').get(p.logo_file_id) as any; if (f) { const fp = path.join(f.storage_area === 'evidence' ? evidenceRoot : uploadRoot, f.stored_name); if (fs.existsSync(fp)) { try { logo = `data:${f.mime_type || 'image/png'};base64,${fs.readFileSync(fp).toString('base64')}`; } catch { logo = ''; } } } }
  return `<div class="mast">${logo ? `<img src="${logo}"/>` : ''}<div><div class="org">${escHtml(p?.facility_name || 'Laboratory')}</div><div class="sub">${escHtml([p?.city, p?.country].filter(Boolean).join(', '))}</div></div></div>`;
}

// The full NC column set (SECHFO005). Kept in one place so create and edit stay
// in sync as the form grows.
const NC_FIELDS: Array<[string, string]> = [
  ['event_date', 'eventDate'], ['time_of_event', 'timeOfEvent'], ['detected_by_staff_id', 'detectedByStaffId#'], ['detected_by_name', 'detectedByName'],
  ['department_id', 'departmentId#'], ['section_id', 'sectionId#'], ['source_module', 'sourceModule'], ['source_record_id', 'sourceRecordId'],
  ['title', 'title'], ['description', 'description'], ['nc_type', 'ncType'], ['nc_type_other', 'ncTypeOther'], ['category', 'category'],
  ['immediate_correction', 'immediateCorrection'], ['remedial_action', 'remedialAction'], ['patient_or_service_impact', 'patientOrServiceImpact'],
  ['occurrence_score', 'occurrenceScore#'], ['severity_score', 'severityScore#'],
  ['investigation_team', 'investigationTeam'], ['root_cause', 'rootCause'], ['rca_method', 'rcaMethod'], ['rca_evidence_file_id', 'rcaEvidenceFileId#'],
  ['corrective_action', 'correctiveAction'], ['preventive_action', 'preventiveAction'], ['capa_responsible_staff_id', 'capaResponsibleStaffId#'], ['capa_timeline_date', 'capaTimelineDate'],
  ['effectiveness_reviewed_by_staff_id', 'effectivenessReviewedByStaffId#'], ['effectiveness_review_date', 'effectivenessReviewDate'], ['corrective_effective', 'correctiveEffective?'], ['effectiveness_comments', 'effectivenessComments'],
];

// Shared quality-workflow settings (key/value). remedialActionEnabled controls
// whether a separate "remedial / short-term correction" field is captured — some
// standards do not require it, so laboratories can switch it off.
export function ncWorkflowConfig(db: any) {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'nc.remedialActionEnabled'").get() as { value: string } | undefined;
  return { remedialActionEnabled: row ? row.value === '1' : true };
}

export function nonconformityRoutes() {
  const router = Router();

  // Static 5x5 risk-matrix metadata for the form UI.
  router.get('/risk-matrix', requireAuth, (_req, res) => res.json({ severity: SEVERITY, occurrence: OCCURRENCE, bands: RISK_BANDS }));

  // Quality-workflow configuration for this laboratory. `canFollowUp` tells the
  // UI whether the current user may progress an event beyond logging (risk
  // assessment, RCA, CAPA) — everyone with 'create' can log an event, but only
  // users with edit/approve rights follow it up.
  router.get('/config', requireAuth, (req, res) => {
    const db = getDb();
    const canFollowUp = resolvePermission(req.user!.id, 'nc_capa', 'edit').allowed || resolvePermission(req.user!.id, 'nc_capa', 'approve').allowed;
    const canCreate = resolvePermission(req.user!.id, 'nc_capa', 'create').allowed;
    res.json({ ...ncWorkflowConfig(db), canFollowUp, canCreate });
  });
  router.put('/config', requirePermission('settings', 'edit'), (req, res) => {
    const db = getDb();
    const enabled = req.body.remedialActionEnabled === true || req.body.remedialActionEnabled === 'true' || req.body.remedialActionEnabled === 1 || req.body.remedialActionEnabled === '1' ? '1' : '0';
    db.prepare("INSERT INTO settings (key, value) VALUES ('nc.remedialActionEnabled', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP").run(enabled);
    audit(req, { action: 'edit', entity: 'settings', entityId: 'nc.remedialActionEnabled', newValue: { remedialActionEnabled: enabled === '1' } });
    res.json(ncWorkflowConfig(db));
  });

  router.get('/', requirePermission('nc_capa', 'view'), (_req, res) => {
    const db = getDb();
    res.json(db.prepare('SELECT * FROM nonconforming_events ORDER BY event_date DESC, id DESC').all());
  });

  // ---- NC register — Excel export / template / import ----
  const NC_TYPES = ['pre_analytical', 'analytical', 'post_analytical', 'safety_environment', 'other'];
  function ncWorkbook(withData: boolean): Buffer {
    const db = getDb();
    const rows: unknown[][] = [];
    if (withData) {
      const items = db.prepare(`SELECT nc.*, s.name AS section_name, det.full_name AS detected_by_full FROM nonconforming_events nc LEFT JOIN sections s ON s.id = nc.section_id LEFT JOIN staff det ON det.id = nc.detected_by_staff_id ORDER BY nc.event_date DESC`).all() as any[];
      for (const n of items) rows.push([n.nc_number, n.event_date ?? '', n.time_of_event ?? '', n.section_name ?? '', n.detected_by_full || n.detected_by_name || '', n.nc_type ?? '', n.title ?? '', n.description ?? '', n.immediate_correction ?? '', n.remedial_action ?? '', n.occurrence_score ?? '', n.severity_score ?? '', n.risk_score ?? '', n.risk_level ?? '', n.root_cause ?? '', n.corrective_action ?? '', n.preventive_action ?? '', n.status ?? '']);
    }
    return buildWorkbook(NC_HEADERS, rows, 'NONCONFORMITIES');
  }
  router.get('/register/template', requirePermission('nc_capa', 'view'), (_req, res) => sendWorkbook(res, ncWorkbook(false), 'Nonconformities_Template.xlsx'));
  router.get('/register/export', requirePermission('nc_capa', 'view'), (_req, res) => sendWorkbook(res, ncWorkbook(true), 'Nonconformities.xlsx'));
  router.post('/register/import', requirePermission('nc_capa', 'create'), ncXlsxUpload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded. Attach the Nonconformities .xlsx file.' });
    try {
      const rows = readSheet(req.file.buffer, 'NONCON');
      const db = getDb();
      const secByName = new Map<string, number>();
      for (const s of db.prepare('SELECT id, name FROM sections').all() as any[]) secByName.set(String(s.name).toLowerCase(), s.id);
      const errors: string[] = []; let created = 0;
      const tx = db.transaction(() => {
        rows.forEach((r, idx) => {
          const rowNo = idx + 2;
          const title = cell(r, 'Title') || cell(r, 'Description');
          if (!title) { errors.push(`Row ${rowNo}: a Title or Description is required.`); return; }
          const secId = cell(r, 'Unit') ? (secByName.get(String(cell(r, 'Unit')).toLowerCase()) ?? null) : null;
          let ncType = (cell(r, 'Type') || '').toLowerCase().replace(/[\s-]+/g, '_'); if (!NC_TYPES.includes(ncType)) ncType = ncType ? 'other' : null as any;
          const risk = computeRisk(numCell(r, 'Occurrence (1-5)'), numCell(r, 'Severity (1-5)'));
          try {
            const ncNumber = cell(r, 'NCR Number') && !db.prepare('SELECT 1 FROM nonconforming_events WHERE nc_number = ?').get(cell(r, 'NCR Number')) ? cell(r, 'NCR Number')! : generateRecordNumber(db, 'nonconforming_events', 'NC', new Date().toISOString());
            db.prepare(`INSERT INTO nonconforming_events (nc_number, event_date, time_of_event, section_id, detected_by_name, nc_type, title, description, immediate_correction, remedial_action, occurrence_score, severity_score, risk_score, risk_level, root_cause, corrective_action, preventive_action, status, created_by, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
              .run(ncNumber, cell(r, 'Date of Event') ?? new Date().toISOString().slice(0, 10), cell(r, 'Time'), secId, cell(r, 'Detected by'), ncType, cell(r, 'Title') ?? title, cell(r, 'Description'), cell(r, 'Immediate action'), cell(r, 'Remedial action'), risk.occurrence, risk.severity, risk.score, risk.level, cell(r, 'Root cause'), cell(r, 'Corrective action'), cell(r, 'Preventive action'), cell(r, 'Status') ?? 'open', req.user!.id, new Date().toISOString());
            created++;
          } catch (e) { errors.push(`Row ${rowNo}: ${(e as Error).message}`); }
        });
      });
      tx();
      audit(req, { action: 'import', entity: 'nonconforming_events', entityId: null, newValue: { created, errors: errors.length } });
      res.json({ totalRows: rows.length, created, errors });
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });

  // Resolve a field value from the request body, honouring the type marker on
  // the mapping key: '#' → integer, '?' → tri-state boolean (0/1/null).
  function bodyVal(body: any, key: string): unknown {
    if (key.endsWith('#')) return parseIntNullable(body[key.slice(0, -1)]);
    if (key.endsWith('?')) { const v = body[key.slice(0, -1)]; return v === undefined || v === '' || v === null ? null : (v === true || v === 'true' || v === 1 || v === '1' ? 1 : 0); }
    const v = body[key];
    return v === undefined ? null : v;
  }

  router.post('/', requirePermission('nc_capa', 'create'), (req, res) => {
    if (!req.body.title) return res.status(400).json({ error: 'title is required' });
    if (!req.body.description) return res.status(400).json({ error: 'description is required' });
    const db = getDb();
    const createdAt = new Date().toISOString();
    const ncNumber = generateRecordNumber(db, 'nonconforming_events', 'NC', createdAt);
    const cols = NC_FIELDS.map(([c]) => c);
    const vals = NC_FIELDS.map(([, k]) => bodyVal(req.body, k));
    // Section B: compute risk from occurrence × severity.
    const risk = computeRisk(req.body.occurrenceScore, req.body.severityScore);
    const extraCols = ['risk_score', 'risk_level', 'severity', 'impact_level', 'workflow_stage'];
    const extraVals = [risk.score, risk.level, req.body.severity ?? risk.levelLabel ?? null, req.body.impactLevel ?? risk.levelLabel ?? null, 'risk_assessment'];
    const allCols = ['nc_number', ...cols, ...extraCols, 'status', 'created_by', 'created_at'];
    const allVals = [ncNumber, ...vals, ...extraVals, 'open', req.user!.id, createdAt];
    // event_date defaults to now if omitted
    const edIdx = allCols.indexOf('event_date'); if (!allVals[edIdx]) allVals[edIdx] = createdAt.slice(0, 10);
    const placeholders = allCols.map(() => '?').join(', ');
    const result = db.prepare(`INSERT INTO nonconforming_events (${allCols.join(', ')}) VALUES (${placeholders})`).run(...allVals as any[]);
    const id = result.lastInsertRowid;
    audit(req, { action: 'create', entity: 'nonconforming_events', entityId: id, newValue: { ncNumber, riskScore: risk.score } });
    res.status(201).json({ id, ncNumber, riskScore: risk.score, riskLevel: risk.level });
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
    const o = db.prepare('SELECT * FROM nonconforming_events WHERE id = ?').get(req.params.id) as any;
    if (!o) return res.status(404).json({ error: 'Nonconforming event not found' });
    // Only update fields that were supplied; recompute risk when either score changes.
    const sets: string[] = []; const vals: unknown[] = [];
    for (const [col, key] of NC_FIELDS) {
      const plain = key.replace(/[#?]$/, '');
      if (req.body[plain] !== undefined) { sets.push(`${col} = ?`); vals.push(bodyVal(req.body, key)); }
    }
    const occ = req.body.occurrenceScore !== undefined ? req.body.occurrenceScore : o.occurrence_score;
    const sev = req.body.severityScore !== undefined ? req.body.severityScore : o.severity_score;
    if (req.body.occurrenceScore !== undefined || req.body.severityScore !== undefined) {
      const risk = computeRisk(occ, sev);
      sets.push('risk_score = ?', 'risk_level = ?'); vals.push(risk.score, risk.level);
      if (risk.levelLabel) { sets.push('severity = ?', 'impact_level = ?'); vals.push(o.severity || risk.levelLabel, o.impact_level || risk.levelLabel); }
    }
    if (req.body.status !== undefined) { sets.push('status = ?'); vals.push(req.body.status); }
    if (sets.length === 0) return res.json({ ok: true });
    sets.push('updated_at = CURRENT_TIMESTAMP');
    db.prepare(`UPDATE nonconforming_events SET ${sets.join(', ')} WHERE id = ?`).run(...vals as any[], req.params.id);
    audit(req, { action: 'edit', entity: 'nonconforming_events', entityId: req.params.id, oldValue: o, newValue: req.body });
    res.json({ ok: true });
  });

  // Section F: approvals.
  router.post('/:id/approve', requirePermission('nc_capa', 'approve'), (req, res) => {
    const db = getDb();
    if (!db.prepare('SELECT id FROM nonconforming_events WHERE id = ?').get(req.params.id)) return res.status(404).json({ error: 'Nonconforming event not found' });
    const approvedBy = getStaffIdOrCurrent(req, req.body.approvedByStaffId);
    db.prepare("UPDATE nonconforming_events SET approved_by_staff_id = ?, approved_at = CURRENT_TIMESTAMP, approval_comments = COALESCE(?, approval_comments), status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(approvedBy, req.body.approvalComments ?? null, req.body.status ?? 'approved', req.params.id);
    audit(req, { action: 'approve', entity: 'nonconforming_events', entityId: req.params.id });
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

  // Stage 2 — Risk assessment. Scores the event on the 5×5 matrix and records
  // whether root-cause analysis is required (risk-proportionate per ISO 22367);
  // advances the event to the RCA queue, or straight to CAPA when RCA is waived.
  router.post('/:id/risk-assessment', requirePermission('nc_capa', 'edit'), (req, res) => {
    const db = getDb();
    const o = db.prepare('SELECT * FROM nonconforming_events WHERE id = ?').get(req.params.id) as any;
    if (!o) return res.status(404).json({ error: 'Nonconforming event not found' });
    const risk = computeRisk(req.body.occurrenceScore, req.body.severityScore);
    if (risk.score == null) return res.status(400).json({ error: 'Select both an occurrence and a severity score to complete the risk assessment.' });
    const rcaRequired = req.body.rcaRequired === true || req.body.rcaRequired === 'true' || req.body.rcaRequired === 1 || req.body.rcaRequired === '1' ? 1 : 0;
    const assessedBy = getStaffIdOrCurrent(req, req.body.assessedByStaffId);
    const stage = rcaRequired ? 'rca' : 'capa';
    db.prepare(`UPDATE nonconforming_events SET occurrence_score = ?, severity_score = ?, risk_score = ?, risk_level = ?, severity = COALESCE(severity, ?), impact_level = COALESCE(impact_level, ?),
        rca_required = ?, risk_assessment_notes = ?, risk_assessed_by_staff_id = ?, risk_assessed_at = CURRENT_TIMESTAMP, workflow_stage = ?, status = CASE WHEN status = 'open' THEN 'reviewed' ELSE status END, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(risk.occurrence, risk.severity, risk.score, risk.level, risk.levelLabel ?? null, risk.levelLabel ?? null, rcaRequired, req.body.notes ?? null, assessedBy, stage, req.params.id);
    audit(req, { action: 'edit', entity: 'nonconforming_events', entityId: req.params.id, newValue: { stage: 'risk_assessment', riskScore: risk.score, rcaRequired } });
    res.json({ ok: true, riskScore: risk.score, riskLevel: risk.level, rcaRequired: !!rcaRequired, workflowStage: stage });
  });

  // Stage 3 — Root cause analysis. Only events flagged as requiring RCA reach
  // this queue; on completion they advance to CAPA.
  router.post('/:id/rca', requirePermission('nc_capa', 'edit'), (req, res) => {
    const db = getDb();
    const o = db.prepare('SELECT * FROM nonconforming_events WHERE id = ?').get(req.params.id) as any;
    if (!o) return res.status(404).json({ error: 'Nonconforming event not found' });
    if (!req.body.rootCause || !String(req.body.rootCause).trim()) return res.status(400).json({ error: 'Record the identified root cause to complete the analysis.' });
    db.prepare(`UPDATE nonconforming_events SET investigation_team = ?, rca_method = ?, root_cause = ?, rca_completed_at = CURRENT_TIMESTAMP, workflow_stage = 'capa', updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(req.body.investigationTeam ?? o.investigation_team ?? null, req.body.rcaMethod ?? o.rca_method ?? null, req.body.rootCause, req.params.id);
    audit(req, { action: 'edit', entity: 'nonconforming_events', entityId: req.params.id, newValue: { stage: 'rca', rcaCompleted: true } });
    res.json({ ok: true, workflowStage: 'capa' });
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
    db.prepare("UPDATE nonconforming_events SET status = CASE WHEN status IN ('open', 'reviewed') THEN 'capa_required' ELSE status END, workflow_stage = 'capa', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
    audit(req, { action: 'create', entity: 'capa_records', entityId: capaId, newValue: { capaNumber, sourceModule: 'nonconformities', sourceRecordId: req.params.id } });
    res.status(201).json({ id: capaId, capaNumber });
  });

  router.post('/:id/close', requirePermission('nc_capa', 'void_archive'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT status, closure_notes, closed_by_staff_id, closed_at FROM nonconforming_events WHERE id = ?').get(req.params.id);
    if (!oldValue) return res.status(404).json({ error: 'Nonconforming event not found' });
    const closedByStaffId = getStaffIdOrCurrent(req, req.body.closedByStaffId);
    if (closedByStaffId === null) return res.status(400).json({ error: 'This action requires the logged-in user to be linked to a staff record.' });
    db.prepare("UPDATE nonconforming_events SET status = ?, workflow_stage = 'closed', closure_notes = ?, closed_by_staff_id = ?, closed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.body.status ?? 'closed', req.body.closureNotes, closedByStaffId, req.params.id);
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

  // Printable nonconformity & corrective-action report. The layout is a neutral,
  // ISO-aligned record — it carries the laboratory's own masthead and record
  // number, not any single facility's form number.
  router.get('/:id/print', requirePermission('nc_capa', 'view'), (req, res) => {
    const db = getDb();
    const n = db.prepare(`SELECT nc.*, s.name AS section_name,
        det.full_name AS detected_by_full, inv.full_name AS capa_resp_full, eff.full_name AS eff_by_full, rev.full_name AS reviewer_full, appr.full_name AS approved_full
      FROM nonconforming_events nc
      LEFT JOIN sections s ON s.id = nc.section_id
      LEFT JOIN staff det ON det.id = nc.detected_by_staff_id
      LEFT JOIN staff inv ON inv.id = nc.capa_responsible_staff_id
      LEFT JOIN staff eff ON eff.id = nc.effectiveness_reviewed_by_staff_id
      LEFT JOIN staff rev ON rev.id = nc.reviewer_staff_id
      LEFT JOIN staff appr ON appr.id = nc.approved_by_staff_id
      WHERE nc.id = ?`).get(req.params.id) as any;
    if (!n) return res.status(404).send('Not found');
    const tick = (on: boolean) => on ? '☒' : '☐';
    const risk = computeRisk(n.occurrence_score, n.severity_score);
    const matrixRows = OCCURRENCE.slice().reverse().map(o => `<tr><td class="hd">${o.score}<br/><b>${escHtml(o.label)}</b><br/><span class="sm">${escHtml(o.description)}</span></td>${SEVERITY.map(s => { const sc = o.score * s.score; const band = RISK_BANDS.find(b => sc >= b.min && sc <= b.max)!; const hit = n.occurrence_score === o.score && n.severity_score === s.score; return `<td style="background:${band.color}22${hit ? ';outline:3px solid #111;outline-offset:-3px' : ''}">${sc} (${band.label})${hit ? ' ◄' : ''}</td>`; }).join('')}</tr>`).join('');
    const line = (label: string, val: unknown) => `<div class="fld"><span class="lb">${label}</span><span class="vl">${escHtml(val || '')}</span></div>`;
    const box = (label: string, val: unknown) => `<div class="sec-item"><div class="lb">${label}</div><div class="box">${escHtml(val || '')}</div></div>`;
    const detectedBy = n.detected_by_full || n.detected_by_name || '';
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>${escHtml(n.nc_number)} — Nonconformity Report</title>
<style>@page{size:A4 portrait;margin:12mm}*{box-sizing:border-box}html,body{-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{font-family:'Times New Roman',Georgia,serif;color:#111;font-size:12px;line-height:1.4;padding:4px 8px}
.mast{display:flex;align-items:center;gap:12px;border-bottom:2px solid #111;padding-bottom:6px}.mast img{height:52px}.mast .org{font-weight:bold;font-size:15px}.mast .sub{font-size:10px;color:#444}
h1{text-align:center;font-size:17px;margin:8px 0}
h2{font-size:13px;background:#eee;border:1px solid #999;padding:3px 6px;margin:12px 0 6px}
.hdr{display:grid;grid-template-columns:1fr 1fr;gap:2px 20px;border:1px solid #999;padding:6px 8px;margin-top:6px}
.fld{display:flex;gap:6px;padding:1px 0}.fld .lb{font-weight:bold;min-width:120px}.fld .vl{border-bottom:1px solid #999;flex:1}
.types div{margin:2px 0}
.sec-item{margin:6px 0}.sec-item .lb{font-weight:bold;margin-bottom:2px}.sec-item .box{border:1px solid #999;min-height:34px;padding:4px 6px;white-space:pre-wrap}
table.mx{border-collapse:collapse;width:100%;font-size:9px;margin:4px 0}table.mx td,table.mx th{border:1px solid #777;padding:3px;text-align:center;vertical-align:middle}
table.mx .hd{text-align:left;width:16%}.sm{font-weight:normal;font-size:8px;color:#333}
.riskline{display:flex;gap:24px;align-items:center;margin:6px 0;font-weight:bold}
.sign{margin-top:22px;display:flex;gap:50px;flex-wrap:wrap}.sign .line{border-top:1px solid #111;width:220px;margin-top:20px}
.no-print{background:#f4f6fb;padding:6px;border:1px solid #ccd;border-radius:6px;margin-bottom:8px;font-size:11px}@media print{.no-print{display:none}body{padding:0}}
</style><script>window.addEventListener("load",()=>{setTimeout(()=>window.print(),300)})</script></head><body>
<div class="no-print">The print dialog opens automatically — choose any printer or Save as PDF. <button onclick="window.print()">Print</button></div>
${labMasthead(db)}
<h1>Nonconformity &amp; Corrective Action Report</h1>
<div class="hdr">
  <div>${line('NCR Number:', n.nc_number)}${line('Date of Event:', n.event_date)}${line('Time of Event:', n.time_of_event)}</div>
  <div>${line('Unit:', n.section_name)}${line('Detected by (Name/Role):', detectedBy)}</div>
</div>
<h2>Section A: Description of Nonconformity</h2>
<div><b>Type of Nonconformity:</b>
<div class="types">
  <div>${tick(n.nc_type === 'pre_analytical')} Pre-analytical (e.g., sample collection, labeling, transport)</div>
  <div>${tick(n.nc_type === 'analytical')} Analytical (e.g., equipment malfunction, reagent issue, SOP deviation)</div>
  <div>${tick(n.nc_type === 'post_analytical')} Post-analytical (e.g., reporting error, result communication)</div>
  <div>${tick(n.nc_type === 'safety_environment')} Safety/Environment (e.g., spill, exposure, waste handling)</div>
  <div>${tick(n.nc_type === 'other')} Other: ${escHtml(n.nc_type_other || '')}</div>
</div></div>
${box('Description of Nonconformity (facts only, no blame):', n.description)}
${box('Immediate Action Taken (urgent step taken to contain the problem):', n.immediate_correction)}
${box('Remedial Action Taken (a short-term fix to correct the problem):', n.remedial_action)}
<h2>Section B: Risk Evaluation — 5×5 Risk Assessment Matrix</h2>
<table class="mx"><thead><tr><th class="hd">Occurrence ↓ / Severity →</th>${SEVERITY.map(s => `<th>${s.score} ${escHtml(s.label)}<br/><span class="sm">${escHtml(s.description)}</span></th>`).join('')}</tr></thead><tbody>${matrixRows}</tbody></table>
<div class="riskline"><span>Risk Score (Occurrence × Severity) = ${risk.score ?? '____'}</span>
<span>Risk Level: ${tick(risk.level === 'low')} Low&nbsp;&nbsp; ${tick(risk.level === 'moderate')} Medium&nbsp;&nbsp; ${tick(risk.level === 'high')} High&nbsp;&nbsp; ${tick(risk.level === 'very_high')} Very High</span></div>
${risk.action ? `<div class="sm" style="font-size:11px">${escHtml(risk.action)}</div>` : ''}
<h2>Section C: Root Cause Analysis</h2>
${line('Investigation Team / Person:', n.investigation_team)}
${box(`Root Cause(s) Identified (method: ${escHtml((n.rca_method || '—').replace(/_/g, ' '))}):`, n.root_cause)}
<h2>Section D: Corrective and Preventive Actions (CAPA)</h2>
${box('Corrective Action (to fix current issue):', n.corrective_action)}
${box('Preventive Action (to avoid recurrence):', n.preventive_action)}
${line('Responsible Person(s):', n.capa_resp_full)}
${line('Timeline for Completion:', n.capa_timeline_date)}
<h2>Section E: Follow-up and Effectiveness Check</h2>
${line('Reviewed by (Name/Role):', n.eff_by_full)}${line('Date:', n.effectiveness_review_date)}
<div>Was corrective action effective? ${tick(n.corrective_effective === 1)} Yes&nbsp;&nbsp; ${tick(n.corrective_effective === 0)} No</div>
${box('Comments:', n.effectiveness_comments)}
<h2>Section F: Approvals</h2>
<div class="sign">
  <div><div>Reviewed by: <b>${escHtml(n.reviewer_full || '')}</b></div><div class="line"></div><div class="sm">Signature / Date${n.reviewed_at ? ` — ${escHtml(String(n.reviewed_at).slice(0, 10))}` : ''}</div></div>
  <div><div>Approved by: <b>${escHtml(n.approved_full || '')}</b></div><div class="line"></div><div class="sm">Signature / Date${n.approved_at ? ` — ${escHtml(String(n.approved_at).slice(0, 10))}` : ''}</div></div>
</div>
${n.approval_comments ? box('Comments:', n.approval_comments) : ''}
<div class="sm" style="margin-top:16px;border-top:1px solid #ccc;padding-top:5px">${escHtml(p_facility(db))} · Nonconformity record ${escHtml(n.nc_number)} · Generated ${new Date().toISOString().slice(0, 19).replace('T', ' ')}</div>
</body></html>`;
    audit(req, { action: 'print', entity: 'nonconforming_events', entityId: req.params.id });
    res.send(html);
  });

  return router;
}
