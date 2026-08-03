import { Router } from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { getDb, uploadRoot, evidenceRoot } from '../db/database.js';
import { requirePermission } from '../middleware/permissions.js';
import { audit } from '../services/auditService.js';
import { generateRecordNumber } from '../utils/recordNumber.js';
import { parseIntNullable, getStaffIdOrCurrent } from './routeHelpers.js';
import { computeRisk } from '../utils/riskMatrix.js';
import { workflowConfig, decideEscalation, createCapaForIncident, canAmendRecords, RECORD_AMEND_ROLES } from '../utils/escalation.js';
import { saveEvidenceFile } from '../utils/fileStore.js';
import { buildWorkbook, sendWorkbook, readSheet, cell, numCell } from '../utils/xlsxRegister.js';

const incXlsxUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
const evidenceUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const INC_HEADERS = ['Incident No', 'Date/time', 'Type', 'Near miss', 'Unit', 'Location', 'Persons involved', 'Description', 'Immediate action', 'Harm level', 'Occurrence (1-5)', 'Severity (1-5)', 'Risk score', 'Risk level', 'Reported by', 'Root cause', 'Corrective action', 'Preventive action', 'Status'] as const;
const INCIDENT_TYPES = ['patient_safety', 'staff_safety', 'near_miss', 'sentinel_event', 'biosafety_exposure', 'needlestick', 'specimen_related', 'equipment_related', 'data_security', 'fire_disaster', 'other'];

// ==========================================================================
// Incident / Adverse Event / Occurrence management
//   Aligned with ISO 15189:2022 (risk management, §8.5 nonconformities and
//   §8.7 corrective action) and ISO 22367 (risk management for medical labs).
//   Captures patient-safety events, staff-safety/biosafety events, near-misses
//   and sentinel events, risk-rated on the same 5x5 matrix, investigated and
//   linked to nonconformities / CAPA. Uses the nc_capa module RBAC.
// ==========================================================================

const INCIDENT_FIELDS: Array<[string, string]> = [
  ['incident_datetime', 'incidentDatetime'], ['incident_type', 'incidentType'], ['incident_type_other', 'incidentTypeOther'], ['is_near_miss', 'isNearMiss?'],
  ['department_id', 'departmentId#'], ['section_id', 'sectionId#'], ['location_text', 'locationText'], ['persons_involved', 'personsInvolved'],
  ['description', 'description'], ['immediate_action', 'immediateAction'], ['harm_level', 'harmLevel'], ['affects_patient_safety', 'affectsPatientSafety?'],
  ['reported_by_staff_id', 'reportedByStaffId#'], ['reported_by_name', 'reportedByName'],
  ['investigation_team', 'investigationTeam'], ['root_cause', 'rootCause'], ['rca_method', 'rcaMethod'], ['contributing_factors', 'contributingFactors'],
  ['corrective_action', 'correctiveAction'], ['preventive_action', 'preventiveAction'],
  ['notified_to', 'notifiedTo'], ['reportable_external', 'reportableExternal?'], ['external_authority', 'externalAuthority'],
  ['evidence_file_id', 'evidenceFileId#'], ['notes', 'notes'],
];
// The facts as originally reported. Changing these after the fact rewrites the
// account of what happened, so it is reserved for senior quality roles.
const REPORTED_FACT_KEYS = ['incidentDatetime', 'incidentType', 'incidentTypeOther', 'isNearMiss', 'sectionId', 'departmentId',
  'locationText', 'personsInvolved', 'description', 'immediateAction', 'harmLevel', 'reportedByStaffId', 'reportedByName'];

function bodyVal(body: any, key: string): unknown {
  if (key.endsWith('#')) return parseIntNullable(body[key.slice(0, -1)]);
  if (key.endsWith('?')) { const v = body[key.slice(0, -1)]; return v === undefined || v === '' || v === null ? 0 : (v === true || v === 'true' || v === 1 || v === '1' ? 1 : 0); }
  const v = body[key]; return v === undefined ? null : v;
}

export function incidentRoutes() {
  const router = Router();

  router.get('/', requirePermission('nc_capa', 'view'), (req, res) => {
    const db = getDb();
    let q = `SELECT i.*, s.name AS section_name, rb.full_name AS reported_by_full, nc.nc_number FROM incidents i
      LEFT JOIN sections s ON s.id = i.section_id LEFT JOIN staff rb ON rb.id = i.reported_by_staff_id LEFT JOIN nonconforming_events nc ON nc.id = i.nc_id`;
    const cond: string[] = []; const params: unknown[] = [];
    if (req.query.status) { cond.push('i.status = ?'); params.push(req.query.status); }
    if (req.query.type) { cond.push('i.incident_type = ?'); params.push(req.query.type); }
    if (req.query.stage) { cond.push('i.workflow_stage = ?'); params.push(req.query.stage); }
    if (cond.length) q += ' WHERE ' + cond.join(' AND ');
    q += ' ORDER BY i.incident_datetime DESC, i.id DESC';
    res.json(db.prepare(q).all(...params));
  });

  // ---- Incident register — Excel export / template / import ----
  function incWorkbook(withData: boolean): Buffer {
    const db = getDb();
    const rows: unknown[][] = [];
    if (withData) {
      const items = db.prepare(`SELECT i.*, s.name AS section_name, rb.full_name AS reported_by_full FROM incidents i LEFT JOIN sections s ON s.id = i.section_id LEFT JOIN staff rb ON rb.id = i.reported_by_staff_id ORDER BY i.incident_datetime DESC`).all() as any[];
      for (const i of items) rows.push([i.incident_number, i.incident_datetime ?? '', i.incident_type ?? '', i.is_near_miss ? 'Yes' : 'No', i.section_name ?? '', i.location_text ?? '', i.persons_involved ?? '', i.description ?? '', i.immediate_action ?? '', i.harm_level ?? '', i.occurrence_score ?? '', i.severity_score ?? '', i.risk_score ?? '', i.risk_level ?? '', i.reported_by_full || i.reported_by_name || '', i.root_cause ?? '', i.corrective_action ?? '', i.preventive_action ?? '', i.status ?? '']);
    }
    return buildWorkbook(INC_HEADERS, rows, 'INCIDENTS');
  }
  router.get('/register/template', requirePermission('nc_capa', 'view'), (_req, res) => sendWorkbook(res, incWorkbook(false), 'Incidents_Template.xlsx'));
  router.get('/register/export', requirePermission('nc_capa', 'view'), (_req, res) => sendWorkbook(res, incWorkbook(true), 'Incidents.xlsx'));
  router.post('/register/import', requirePermission('nc_capa', 'create'), incXlsxUpload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded. Attach the Incidents .xlsx file.' });
    try {
      const rows = readSheet(req.file.buffer, 'INCIDENT');
      const db = getDb();
      const secByName = new Map<string, number>();
      for (const s of db.prepare('SELECT id, name FROM sections').all() as any[]) secByName.set(String(s.name).toLowerCase(), s.id);
      const errors: string[] = []; let created = 0;
      const tx = db.transaction(() => {
        rows.forEach((r, idx) => {
          const rowNo = idx + 2;
          const desc = cell(r, 'Description');
          if (!desc) { errors.push(`Row ${rowNo}: Description is required.`); return; }
          const secId = cell(r, 'Unit') ? (secByName.get(String(cell(r, 'Unit')).toLowerCase()) ?? null) : null;
          let type = (cell(r, 'Type') || '').toLowerCase().replace(/[\s-]+/g, '_'); if (type && !INCIDENT_TYPES.includes(type)) type = 'other';
          const risk = computeRisk(numCell(r, 'Occurrence (1-5)'), numCell(r, 'Severity (1-5)'));
          const nearMiss = /^(y|yes|true|1)/i.test(String(cell(r, 'Near miss') ?? '')) ? 1 : 0;
          try {
            const num = cell(r, 'Incident No') && !db.prepare('SELECT 1 FROM incidents WHERE incident_number = ?').get(cell(r, 'Incident No')) ? cell(r, 'Incident No')! : generateRecordNumber(db, 'incidents', 'INC', new Date().toISOString());
            db.prepare(`INSERT INTO incidents (incident_number, incident_datetime, incident_type, is_near_miss, section_id, location_text, persons_involved, description, immediate_action, harm_level, occurrence_score, severity_score, risk_score, risk_level, reported_by_name, root_cause, corrective_action, preventive_action, status, reported_at, created_by, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
              .run(num, cell(r, 'Date/time') ?? new Date().toISOString(), type || null, nearMiss, secId, cell(r, 'Location'), cell(r, 'Persons involved'), desc, cell(r, 'Immediate action'), cell(r, 'Harm level'), risk.occurrence, risk.severity, risk.score, risk.level, cell(r, 'Reported by'), cell(r, 'Root cause'), cell(r, 'Corrective action'), cell(r, 'Preventive action'), cell(r, 'Status') ?? 'reported', new Date().toISOString(), req.user!.id, new Date().toISOString());
            created++;
          } catch (e) { errors.push(`Row ${rowNo}: ${(e as Error).message}`); }
        });
      });
      tx();
      audit(req, { action: 'import', entity: 'incidents', entityId: null, newValue: { created, errors: errors.length } });
      res.json({ totalRows: rows.length, created, errors });
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });

  router.post('/', requirePermission('nc_capa', 'create'), (req, res) => {
    if (!req.body.description) return res.status(400).json({ error: 'description is required' });
    const db = getDb();
    const createdAt = new Date().toISOString();
    const incidentNumber = generateRecordNumber(db, 'incidents', 'INC', createdAt);
    const cols = INCIDENT_FIELDS.map(([c]) => c);
    const vals = INCIDENT_FIELDS.map(([, k]) => bodyVal(req.body, k));
    const risk = computeRisk(req.body.occurrenceScore, req.body.severityScore);
    const allCols = ['incident_number', ...cols, 'occurrence_score', 'severity_score', 'risk_score', 'risk_level', 'workflow_stage', 'reported_at', 'status', 'created_by', 'created_at'];
    const allVals = [incidentNumber, ...vals, risk.occurrence, risk.severity, risk.score, risk.level, 'risk_assessment', createdAt, 'reported', req.user!.id, createdAt];
    const dtIdx = allCols.indexOf('incident_datetime'); if (!allVals[dtIdx]) allVals[dtIdx] = createdAt;
    const rbIdx = allCols.indexOf('reported_by_staff_id'); if (!allVals[rbIdx]) allVals[rbIdx] = getStaffIdOrCurrent(req, null);
    db.prepare(`INSERT INTO incidents (${allCols.join(', ')}) VALUES (${allCols.map(() => '?').join(', ')})`).run(...allVals as any[]);
    const id = (db.prepare('SELECT last_insert_rowid() AS id').get() as any).id;
    audit(req, { action: 'create', entity: 'incidents', entityId: id, newValue: { incidentNumber, riskScore: risk.score } });
    res.status(201).json({ id, incidentNumber, riskScore: risk.score, riskLevel: risk.level });
  });

  router.get('/:id', requirePermission('nc_capa', 'view'), (req, res) => {
    const db = getDb();
    const i = db.prepare(`SELECT i.*, s.name AS section_name, rb.full_name AS reported_by_full, nc.nc_number, cp.capa_number FROM incidents i
      LEFT JOIN sections s ON s.id = i.section_id LEFT JOIN staff rb ON rb.id = i.reported_by_staff_id
      LEFT JOIN nonconforming_events nc ON nc.id = i.nc_id LEFT JOIN capa_records cp ON cp.id = i.capa_id WHERE i.id = ?`).get(req.params.id);
    if (!i) return res.status(404).json({ error: 'Incident not found' });
    const links = db.prepare('SELECT * FROM record_links WHERE source_module_key = ? AND source_record_type = ? AND source_record_id = ?').all('nc_capa', 'incidents', String(req.params.id));
    res.json({ ...i, links });
  });

  router.put('/:id', requirePermission('nc_capa', 'edit'), (req, res) => {
    const db = getDb();
    const o = db.prepare('SELECT * FROM incidents WHERE id = ?').get(req.params.id) as any;
    if (!o) return res.status(404).json({ error: 'Incident not found' });
    // As with nonconformities, the originally reported facts are locked to
    // senior quality roles. Investigation fields stay open to any reviewer.
    const touchesReported = REPORTED_FACT_KEYS.some(k => req.body[k] !== undefined);
    if (touchesReported && !canAmendRecords(db, req.user!.roleId)) {
      return res.status(403).json({ error: `Only a ${RECORD_AMEND_ROLES.join(', ')} can amend the reported details of an incident. You can still record the risk assessment, investigation and actions.` });
    }
    const sets: string[] = []; const vals: unknown[] = [];
    for (const [col, key] of INCIDENT_FIELDS) {
      const plain = key.replace(/[#?]$/, '');
      if (req.body[plain] !== undefined) { sets.push(`${col} = ?`); vals.push(bodyVal(req.body, key)); }
    }
    if (req.body.occurrenceScore !== undefined || req.body.severityScore !== undefined) {
      const risk = computeRisk(req.body.occurrenceScore ?? o.occurrence_score, req.body.severityScore ?? o.severity_score);
      sets.push('occurrence_score = ?', 'severity_score = ?', 'risk_score = ?', 'risk_level = ?'); vals.push(risk.occurrence, risk.severity, risk.score, risk.level);
    }
    if (req.body.status !== undefined) { sets.push('status = ?'); vals.push(req.body.status); }
    if (!sets.length) return res.json({ ok: true });
    sets.push('updated_at = CURRENT_TIMESTAMP');
    db.prepare(`UPDATE incidents SET ${sets.join(', ')} WHERE id = ?`).run(...vals as any[], req.params.id);
    audit(req, { action: 'edit', entity: 'incidents', entityId: req.params.id, oldValue: o, newValue: req.body });
    res.json({ ok: true });
  });

  router.post('/:id/review', requirePermission('nc_capa', 'approve'), (req, res) => {
    const db = getDb();
    if (!db.prepare('SELECT id FROM incidents WHERE id = ?').get(req.params.id)) return res.status(404).json({ error: 'Incident not found' });
    db.prepare("UPDATE incidents SET reviewed_by_staff_id = ?, reviewed_at = CURRENT_TIMESTAMP, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(getStaffIdOrCurrent(req, req.body.reviewedByStaffId), req.body.status ?? 'under_investigation', req.params.id);
    res.json({ ok: true });
  });
  router.post('/:id/approve', requirePermission('nc_capa', 'approve'), (req, res) => {
    const db = getDb();
    if (!db.prepare('SELECT id FROM incidents WHERE id = ?').get(req.params.id)) return res.status(404).json({ error: 'Incident not found' });
    db.prepare("UPDATE incidents SET approved_by_staff_id = ?, approved_at = CURRENT_TIMESTAMP, status = 'closed', workflow_stage = 'closed', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(getStaffIdOrCurrent(req, req.body.approvedByStaffId), req.params.id);
    audit(req, { action: 'approve', entity: 'incidents', entityId: req.params.id });
    res.json({ ok: true });
  });

  // Stage 2 — Risk assessment (5×5 matrix); records whether RCA is required and
  // advances the incident to the RCA queue, or straight to CAPA/escalation.
  router.post('/:id/risk-assessment', requirePermission('nc_capa', 'edit'), (req, res) => {
    const db = getDb();
    const o = db.prepare('SELECT * FROM incidents WHERE id = ?').get(req.params.id) as any;
    if (!o) return res.status(404).json({ error: 'Incident not found' });
    const risk = computeRisk(req.body.occurrenceScore, req.body.severityScore);
    if (risk.score == null) return res.status(400).json({ error: 'Select both an occurrence and a severity score to complete the risk assessment.' });
    const manualRca = req.body.rcaRequired === true || req.body.rcaRequired === 'true' || req.body.rcaRequired === 1 || req.body.rcaRequired === '1';
    // Any actual harm, or an explicit patient-safety flag, counts as a
    // patient-safety event for the escalation rules.
    const flagged = req.body.affectsPatientSafety !== undefined
      ? (req.body.affectsPatientSafety === true || req.body.affectsPatientSafety === 'true' || req.body.affectsPatientSafety === 1 || req.body.affectsPatientSafety === '1')
      : !!o.affects_patient_safety;
    const affectsPatientSafety = flagged || o.incident_type === 'patient_safety' || o.incident_type === 'sentinel_event'
      || (o.harm_level && !['none', ''].includes(String(o.harm_level)));
    const cfg = workflowConfig(db);
    const decision = decideEscalation(cfg, { riskLevel: risk.level, affectsPatientSafety, manualRcaRequired: manualRca });
    const stage = decision.rcaRequired ? 'rca' : 'capa';
    db.prepare(`UPDATE incidents SET occurrence_score = ?, severity_score = ?, risk_score = ?, risk_level = ?, rca_required = ?, affects_patient_safety = ?, escalation_reason = ?, risk_assessment_notes = ?,
        risk_assessed_by_staff_id = ?, risk_assessed_at = CURRENT_TIMESTAMP, workflow_stage = ?, status = CASE WHEN status = 'reported' THEN 'under_investigation' ELSE status END, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(risk.occurrence, risk.severity, risk.score, risk.level, decision.rcaRequired ? 1 : 0, affectsPatientSafety ? 1 : 0, decision.reason, req.body.notes ?? null,
        getStaffIdOrCurrent(req, req.body.assessedByStaffId), stage, req.params.id);
    let capa: { id: number; capaNumber: string } | null = null;
    if (decision.createCapa) capa = createCapaForIncident(db, req.params.id, req.user!.id, decision.reason);
    audit(req, { action: 'edit', entity: 'incidents', entityId: req.params.id, newValue: { stage: 'risk_assessment', riskScore: risk.score, rcaRequired: decision.rcaRequired, escalated: decision.escalated, capa: capa?.capaNumber } });
    res.json({ ok: true, riskScore: risk.score, riskLevel: risk.level, rcaRequired: decision.rcaRequired, workflowStage: stage, escalated: decision.escalated, escalationReason: decision.reason, capaNumber: capa?.capaNumber ?? null });
  });

  // Stage 3 — Investigation / root cause analysis; on completion advances to
  // CAPA. The completed analysis sheet must be attached as evidence.
  router.post('/:id/rca', requirePermission('nc_capa', 'edit'), evidenceUpload.single('evidence'), (req, res) => {
    const db = getDb();
    const o = db.prepare('SELECT * FROM incidents WHERE id = ?').get(req.params.id) as any;
    if (!o) return res.status(404).json({ error: 'Incident not found' });
    if (!req.body.rootCause || !String(req.body.rootCause).trim()) return res.status(400).json({ error: 'Record the identified root cause to complete the analysis.' });
    let evidenceFileId: number | null = o.rca_evidence_file_id ?? null;
    if (req.file) evidenceFileId = saveEvidenceFile(db, req.file, req.user!.id);
    if (!evidenceFileId) return res.status(400).json({ error: 'Attach the completed root-cause analysis sheet (e.g. the 5 Whys or fishbone) before completing the investigation.' });
    db.prepare(`UPDATE incidents SET investigation_team = ?, rca_method = ?, root_cause = ?, contributing_factors = ?, rca_evidence_file_id = ?, rca_completed_at = CURRENT_TIMESTAMP, workflow_stage = 'capa', updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(req.body.investigationTeam ?? o.investigation_team ?? null, req.body.rcaMethod ?? o.rca_method ?? null, req.body.rootCause, req.body.contributingFactors ?? o.contributing_factors ?? null, evidenceFileId, req.params.id);
    audit(req, { action: 'edit', entity: 'incidents', entityId: req.params.id, newValue: { stage: 'rca', rcaCompleted: true, evidenceFileId } });
    res.json({ ok: true, workflowStage: 'capa', evidenceFileId });
  });

  // Stream the attached investigation / root-cause analysis sheet.
  router.get('/:id/rca-evidence', requirePermission('nc_capa', 'view'), (req, res) => {
    const db = getDb();
    const inc = db.prepare('SELECT rca_evidence_file_id FROM incidents WHERE id = ?').get(req.params.id) as any;
    if (!inc?.rca_evidence_file_id) return res.status(404).send('No evidence attached.');
    const f = db.prepare('SELECT * FROM files WHERE id = ?').get(inc.rca_evidence_file_id) as any;
    if (!f) return res.status(404).send('File not found.');
    const fp = path.join(f.storage_area === 'evidence' ? evidenceRoot : uploadRoot, f.stored_name);
    if (!fs.existsSync(fp)) return res.status(404).send('File missing on disk.');
    res.setHeader('Content-Type', f.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${(f.original_name || 'rca-evidence').replace(/"/g, '')}"`);
    fs.createReadStream(fp).pipe(res);
  });

  // Escalate an incident into a nonconformity (carrying the description, risk and
  // immediate action), so the CAPA workflow follows.
  router.post('/:id/create-nc', requirePermission('nc_capa', 'create'), (req, res) => {
    const db = getDb();
    const i = db.prepare('SELECT * FROM incidents WHERE id = ?').get(req.params.id) as any;
    if (!i) return res.status(404).json({ error: 'Incident not found' });
    if (i.nc_id) return res.status(409).json({ error: 'This incident already has a linked nonconformity.' });
    const createdAt = new Date().toISOString();
    const ncNumber = generateRecordNumber(db, 'nonconforming_events', 'NC', createdAt);
    const ncType = i.incident_type === 'specimen_related' ? 'pre_analytical' : i.incident_type === 'equipment_related' ? 'analytical' : (i.incident_type === 'biosafety_exposure' || i.incident_type === 'needlestick' || i.incident_type === 'staff_safety') ? 'safety_environment' : 'other';
    const r = db.prepare(`INSERT INTO nonconforming_events (nc_number, event_date, time_of_event, detected_by_staff_id, section_id, department_id, source_module, source_record_id, title, description, nc_type, immediate_correction, occurrence_score, severity_score, risk_score, risk_level, workflow_stage, status, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'incidents', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'risk_assessment', 'open', ?, ?)`)
      .run(ncNumber, (i.incident_datetime || createdAt).slice(0, 10), (i.incident_datetime || '').slice(11, 16), i.reported_by_staff_id, i.section_id, i.department_id, String(i.id),
        `Incident: ${i.incident_type ? String(i.incident_type).replace(/_/g, ' ') : 'occurrence'}`, i.description, ncType, i.immediate_action, i.occurrence_score, i.severity_score, i.risk_score, i.risk_level, req.user!.id, createdAt);
    const ncId = (db.prepare('SELECT last_insert_rowid() AS id').get() as any).id;
    db.prepare("UPDATE incidents SET nc_id = ?, workflow_stage = CASE WHEN workflow_stage = 'closed' THEN workflow_stage ELSE 'capa' END, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(ncId, req.params.id);
    db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run('nc_capa', 'incidents', String(req.params.id), 'nc_capa', 'nonconforming_events', String(ncId), 'Nonconformity raised from incident');
    audit(req, { action: 'create', entity: 'nonconforming_events', entityId: ncId, newValue: { ncNumber, fromIncident: i.incident_number } });
    res.status(201).json({ id: ncId, ncNumber });
  });

  return router;
}
