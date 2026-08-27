import { Router } from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import * as XLSX from 'xlsx';
import { getDb, uploadRoot, evidenceRoot } from '../db/database.js';
import { requirePermission } from '../middleware/permissions.js';
import { audit } from '../services/auditService.js';
import { generateRecordNumber } from '../utils/recordNumber.js';
import { safeStoredFilename } from '../utils/safeFilename.js';
import { parseIntNullable, getStaffIdOrCurrent } from './routeHelpers.js';
import { mean, sd, cvPercent, linreg, round } from '../utils/stats.js';

// ==========================================================================
// Method Verification & Validation (ISO 15189:2022 §7.3.3 / CLSI EP series)
//   * Verification confirms a validated (e.g. manufacturer's) method meets its
//     claimed performance in this laboratory.
//   * Validation fully characterises a laboratory-developed or modified method.
//   Each study carries structured performance-characteristic rows, an overall
//   verdict, authorisation for clinical use, and the signed report.
// ==========================================================================

const METHOD_STATUSES = ['planned', 'in_progress', 'completed', 'reviewed', 'approved', 'rejected'];
const EQUIPMENT_VERIFICATION_STATUSES = ['planned', 'in_progress', 'completed', 'approved', 'rejected'];
const VERDICTS = ['pending', 'acceptable', 'acceptable_with_limitations', 'not_acceptable'];
const OUTCOMES = ['pending', 'pass', 'fail', 'na'];

const upload = multer({
  storage: multer.diskStorage({ destination: (_r, _f, cb) => cb(null, uploadRoot), filename: (_r, file, cb) => cb(null, safeStoredFilename(file.originalname)) }),
  limits: { fileSize: 25 * 1024 * 1024 },
});

// Standard performance-characteristic catalogue and the default set seeded for
// each study kind, so a study can be built in one click and then filled in.
const PARAM_LABELS: Record<string, { label: string; stat: string; unit?: string }> = {
  precision_repeatability: { label: 'Precision — repeatability (within-run)', stat: 'CV%', unit: '%' },
  precision_intermediate: { label: 'Precision — intermediate (within-lab)', stat: 'CV%', unit: '%' },
  trueness_bias: { label: 'Trueness / bias', stat: 'Bias%', unit: '%' },
  linearity: { label: 'Linearity', stat: 'r²' },
  measuring_interval: { label: 'Analytical measuring interval (AMR / reportable range)', stat: 'Range' },
  lob: { label: 'Limit of blank (LoB)', stat: 'LoB' },
  lod: { label: 'Limit of detection (LoD)', stat: 'LoD' },
  loq: { label: 'Limit of quantitation (LoQ)', stat: 'LoQ' },
  carryover: { label: 'Carry-over', stat: '%' },
  interference: { label: 'Interference / analytical specificity', stat: 'Bias%' },
  method_comparison: { label: 'Method comparison / agreement', stat: 'Slope; r' },
  reference_interval: { label: 'Reference interval verification', stat: '% within' },
  diagnostic_sensitivity: { label: 'Diagnostic sensitivity', stat: '%' },
  diagnostic_specificity: { label: 'Diagnostic specificity', stat: '%' },
  agreement: { label: 'Positive/negative agreement', stat: '%' },
  detection_limit: { label: 'Analytical sensitivity / detection limit', stat: 'LoD' },
  cross_reactivity: { label: 'Cross-reactivity', stat: '%' },
  reproducibility: { label: 'Reproducibility', stat: 'CV%' },
};
function seedParameters(studyType: string, measurandType: string): string[] {
  if (measurandType === 'qualitative') {
    return studyType === 'validation'
      ? ['diagnostic_sensitivity', 'diagnostic_specificity', 'agreement', 'detection_limit', 'interference', 'cross_reactivity', 'reproducibility']
      : ['diagnostic_sensitivity', 'diagnostic_specificity', 'agreement'];
  }
  return studyType === 'validation'
    ? ['precision_repeatability', 'precision_intermediate', 'trueness_bias', 'linearity', 'measuring_interval', 'lod', 'loq', 'carryover', 'interference', 'method_comparison', 'reference_interval']
    : ['precision_repeatability', 'precision_intermediate', 'trueness_bias', 'measuring_interval', 'reference_interval'];
}

function escHtml(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}
function labMasthead(db: any): string {
  const p = db.prepare('SELECT * FROM laboratory_profile WHERE id = 1').get() as any;
  let logo = '';
  if (p?.logo_file_id) {
    const f = db.prepare('SELECT * FROM files WHERE id = ?').get(p.logo_file_id) as any;
    if (f) { const fp = path.join(f.storage_area === 'evidence' ? evidenceRoot : uploadRoot, f.stored_name); if (fs.existsSync(fp)) { try { logo = `data:${f.mime_type || 'image/png'};base64,${fs.readFileSync(fp).toString('base64')}`; } catch { logo = ''; } } }
  }
  const name = escHtml(p?.facility_name || 'Laboratory');
  const sub = [p?.city, p?.country].filter(Boolean).map(escHtml).join(', ');
  return `<div class="mast">${logo ? `<img src="${logo}"/>` : ''}<div><div class="org">${name}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div></div>`;
}

export function verificationValidationRoutes() {
  const router = Router();

  // ===================== Equipment verification (instrument) =====================
  router.get('/equipment', requirePermission('verification_validation', 'view'), (_req, res) => {
    const db = getDb();
    res.json(db.prepare(`SELECT ev.*, e.name AS equipment_name, e.equipment_number FROM equipment_verifications ev JOIN equipment_items e ON e.id = ev.equipment_id ORDER BY ev.verification_date DESC`).all());
  });
  router.post('/equipment', requirePermission('verification_validation', 'create'), (req, res) => {
    if (!parseIntNullable(req.body.equipmentId)) return res.status(400).json({ error: 'equipmentId is required' });
    if (!req.body.verificationType) return res.status(400).json({ error: 'verificationType is required' });
    if (!req.body.verificationDate) return res.status(400).json({ error: 'verificationDate is required' });
    const db = getDb();
    if (!db.prepare('SELECT id FROM equipment_items WHERE id = ?').get(req.body.equipmentId)) return res.status(404).json({ error: 'Equipment item not found' });
    const createdAt = new Date().toISOString();
    const verificationNumber = generateRecordNumber(db, 'equipment_verifications', 'EQV', createdAt);
    const status = req.body.status ?? 'in_progress';
    if (!EQUIPMENT_VERIFICATION_STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${EQUIPMENT_VERIFICATION_STATUSES.join(', ')}` });
    const result = db.prepare(`INSERT INTO equipment_verifications (equipment_id, verification_number, verification_type, verification_date, reason, acceptance_criteria, results_summary, conclusion, status, verified_by_staff_id, evidence_file_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(Number(req.body.equipmentId), verificationNumber, req.body.verificationType, req.body.verificationDate, req.body.reason ?? null, req.body.acceptanceCriteria ?? null, req.body.resultsSummary ?? null, req.body.conclusion ?? null, status, getStaffIdOrCurrent(req, req.body.verifiedByStaffId), parseIntNullable(req.body.evidenceFileId), req.user!.id, createdAt);
    const verId = Number(result.lastInsertRowid);
    db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run('verification_validation', 'equipment_verifications', String(verId), 'equipment', 'equipment_items', String(req.body.equipmentId), 'Equipment verification record');
    audit(req, { action: 'create', entity: 'equipment_verifications', entityId: verId, newValue: { verificationNumber } });
    res.status(201).json({ id: verId, verificationNumber });
  });
  router.get('/equipment/:id', requirePermission('verification_validation', 'view'), (req, res) => {
    const db = getDb();
    const record = db.prepare(`SELECT ev.*, e.name AS equipment_name, e.equipment_number FROM equipment_verifications ev JOIN equipment_items e ON e.id = ev.equipment_id WHERE ev.id = ?`).get(req.params.id);
    if (!record) return res.status(404).json({ error: 'Equipment verification not found' });
    const links = db.prepare('SELECT * FROM record_links WHERE (source_module_key = ? AND source_record_type = ? AND source_record_id = ?)').all('verification_validation', 'equipment_verifications', String(req.params.id));
    res.json({ ...record, links });
  });
  router.put('/equipment/:id', requirePermission('verification_validation', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM equipment_verifications WHERE id = ?').get(req.params.id) as any;
    if (!oldValue) return res.status(404).json({ error: 'Equipment verification not found' });
    db.prepare(`UPDATE equipment_verifications SET verification_type = ?, verification_date = ?, reason = ?, acceptance_criteria = ?, results_summary = ?, conclusion = ?, status = ?, verified_by_staff_id = ?, evidence_file_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(req.body.verificationType ?? oldValue.verification_type, req.body.verificationDate ?? oldValue.verification_date, req.body.reason ?? oldValue.reason, req.body.acceptanceCriteria ?? oldValue.acceptance_criteria, req.body.resultsSummary ?? oldValue.results_summary, req.body.conclusion ?? oldValue.conclusion, req.body.status ?? oldValue.status, parseIntNullable(req.body.verifiedByStaffId) ?? oldValue.verified_by_staff_id, parseIntNullable(req.body.evidenceFileId) ?? oldValue.evidence_file_id, req.params.id);
    audit(req, { action: 'edit', entity: 'equipment_verifications', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });
  router.post('/equipment/:id/approve', requirePermission('verification_validation', 'approve'), (req, res) => {
    const db = getDb();
    if (!db.prepare('SELECT id FROM equipment_verifications WHERE id = ?').get(req.params.id)) return res.status(404).json({ error: 'Equipment verification not found' });
    const approvedBy = getStaffIdOrCurrent(req, req.body.approvedByStaffId);
    if (approvedBy === null) return res.status(400).json({ error: 'This action requires the logged-in user to be linked to a staff record.' });
    db.prepare('UPDATE equipment_verifications SET approved_by_staff_id = ?, status = ?, conclusion = COALESCE(?, conclusion), updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(approvedBy, req.body.status ?? 'approved', req.body.conclusion ?? null, req.params.id);
    audit(req, { action: 'approve', entity: 'equipment_verifications', entityId: req.params.id });
    res.json({ ok: true });
  });

  // ===================== Method verification / validation studies =====================
  // Catalogue of available performance characteristics (for the UI dropdown).
  router.get('/parameter-catalogue', requirePermission('verification_validation', 'view'), (_req, res) => {
    res.json({ labels: PARAM_LABELS, seeds: { verification_quantitative: seedParameters('verification', 'quantitative'), validation_quantitative: seedParameters('validation', 'quantitative'), verification_qualitative: seedParameters('verification', 'qualitative'), validation_qualitative: seedParameters('validation', 'qualitative') } });
  });

  router.get('/', requirePermission('verification_validation', 'view'), (_req, res) => {
    const db = getDb();
    res.json(db.prepare(`SELECT mv.*, e.name AS equipment_name, s.name AS section_name,
        (SELECT COUNT(*) FROM verification_parameters vp WHERE vp.verification_id = mv.id) AS parameter_count,
        (SELECT COUNT(*) FROM verification_parameters vp WHERE vp.verification_id = mv.id AND vp.outcome = 'fail') AS failed_count,
        (SELECT COUNT(*) FROM verification_parameters vp WHERE vp.verification_id = mv.id AND vp.outcome = 'pending') AS pending_count
      FROM method_verifications mv LEFT JOIN equipment_items e ON e.id = mv.equipment_id LEFT JOIN sections s ON s.id = mv.section_id ORDER BY mv.created_at DESC`).all());
  });

  function loadStudy(db: any, id: unknown) {
    const study = db.prepare(`SELECT mv.*, e.name AS equipment_name, e.equipment_number, s.name AS section_name,
        pf.full_name AS performed_by_name, rf.full_name AS reviewed_by_name, af.full_name AS approved_by_name,
        f.original_name AS report_file_name
      FROM method_verifications mv
      LEFT JOIN equipment_items e ON e.id = mv.equipment_id
      LEFT JOIN sections s ON s.id = mv.section_id
      LEFT JOIN staff pf ON pf.id = mv.performed_by_staff_id
      LEFT JOIN staff rf ON rf.id = mv.reviewed_by_staff_id
      LEFT JOIN staff af ON af.id = mv.approved_by_staff_id
      LEFT JOIN files f ON f.id = mv.report_file_id
      WHERE mv.id = ?`).get(id);
    if (!study) return null;
    const parameters = db.prepare('SELECT vp.*, f.original_name AS evidence_file_name FROM verification_parameters vp LEFT JOIN files f ON f.id = vp.evidence_file_id WHERE vp.verification_id = ? ORDER BY vp.display_order, vp.id').all(id);
    return { ...study, parameters };
  }

  router.post('/', requirePermission('verification_validation', 'create'), (req, res) => {
    if (!req.body.methodName) return res.status(400).json({ error: 'methodName is required' });
    if (!req.body.testName) return res.status(400).json({ error: 'testName is required' });
    const db = getDb();
    const createdAt = new Date().toISOString();
    const verificationNumber = generateRecordNumber(db, 'method_verifications', 'MV', createdAt);
    const studyType = req.body.studyType === 'validation' ? 'validation' : 'verification';
    const measurandType = req.body.measurandType === 'qualitative' ? 'qualitative' : 'quantitative';
    const status = req.body.status && METHOD_STATUSES.includes(req.body.status) ? req.body.status : 'in_progress';
    const result = db.prepare(`INSERT INTO method_verifications
      (verification_number, department_id, section_id, method_name, test_name, analyte, sample_matrix, measurement_units, measurand_type, reagent_lot, manufacturer, equipment_id, verification_type, study_type, scope_reason, reason, manufacturer_claims_ref, guideline_ref, start_date, completion_date, acceptance_criteria, summary, conclusion, limitations, verdict, next_review_date, performed_by_staff_id, status, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`)
      .run(verificationNumber, parseIntNullable(req.body.departmentId), parseIntNullable(req.body.sectionId), req.body.methodName, req.body.testName,
        req.body.analyte ?? null, req.body.sampleMatrix ?? null, req.body.measurementUnits ?? null, measurandType, req.body.reagentLot ?? null, req.body.manufacturer ?? null,
        parseIntNullable(req.body.equipmentId), req.body.verificationType || studyType, studyType, req.body.scopeReason ?? null, req.body.reason ?? null,
        req.body.manufacturerClaimsRef ?? null, req.body.guidelineRef ?? null, req.body.startDate ?? createdAt.slice(0, 10), req.body.completionDate ?? null,
        req.body.acceptanceCriteria ?? null, req.body.summary ?? null, req.body.conclusion ?? null, req.body.limitations ?? null, req.body.nextReviewDate ?? null,
        getStaffIdOrCurrent(req, req.body.performedByStaffId), status, req.user!.id, createdAt);
    const verId = Number(result.lastInsertRowid);
    // Seed the standard performance characteristics for this study kind unless asked not to.
    if (req.body.seedParameters !== false) {
      const codes = seedParameters(studyType, measurandType);
      const ins = db.prepare('INSERT INTO verification_parameters (verification_id, parameter, parameter_label, statistic_label, unit, display_order) VALUES (?, ?, ?, ?, ?, ?)');
      codes.forEach((c, i) => ins.run(verId, c, PARAM_LABELS[c]?.label ?? c, PARAM_LABELS[c]?.stat ?? null, PARAM_LABELS[c]?.unit ?? null, i + 1));
    }
    if (parseIntNullable(req.body.equipmentId)) db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run('verification_validation', 'method_verifications', String(verId), 'equipment', 'equipment_items', String(req.body.equipmentId), 'Method study linked to equipment');
    audit(req, { action: 'create', entity: 'method_verifications', entityId: verId, newValue: { verificationNumber, studyType } });
    res.status(201).json({ id: verId, verificationNumber });
  });

  // Numeric-guarded so `/export` further down is not swallowed as a study id.
  // It was: the export route's own `export` guard was never reached, and the
  // request fell through to this one — which asks only for `view` and then
  // answers 404. The register could not be exported by anybody, and the guard
  // that was supposed to protect it was dead code.
  const numericOnly = (req: any, _res: any, next: any) => (/^\d+$/.test(req.params.id) ? next() : next('route'));
  router.get('/:id', numericOnly, requirePermission('verification_validation', 'view'), (req, res) => {
    const study = loadStudy(getDb(), req.params.id);
    if (!study) return res.status(404).json({ error: 'Study not found' });
    res.json(study);
  });

  router.put('/:id', requirePermission('verification_validation', 'edit'), (req, res) => {
    const db = getDb();
    const o = db.prepare('SELECT * FROM method_verifications WHERE id = ?').get(req.params.id) as any;
    if (!o) return res.status(404).json({ error: 'Study not found' });
    if (req.body.status && !METHOD_STATUSES.includes(req.body.status)) return res.status(400).json({ error: `status must be one of: ${METHOD_STATUSES.join(', ')}` });
    if (req.body.verdict && !VERDICTS.includes(req.body.verdict)) return res.status(400).json({ error: `verdict must be one of: ${VERDICTS.join(', ')}` });
    const b = req.body;
    const num = (v: unknown, cur: unknown) => v !== undefined ? parseIntNullable(v) : cur;
    db.prepare(`UPDATE method_verifications SET department_id = ?, section_id = ?, method_name = ?, test_name = ?, analyte = ?, sample_matrix = ?, measurement_units = ?, measurand_type = ?, reagent_lot = ?, manufacturer = ?, equipment_id = ?, verification_type = ?, study_type = ?, scope_reason = ?, reason = ?, manufacturer_claims_ref = ?, guideline_ref = ?, start_date = ?, completion_date = ?, acceptance_criteria = ?, summary = ?, conclusion = ?, limitations = ?, verdict = ?, next_review_date = ?, performed_by_staff_id = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(num(b.departmentId, o.department_id), num(b.sectionId, o.section_id), b.methodName ?? o.method_name, b.testName ?? o.test_name, b.analyte ?? o.analyte, b.sampleMatrix ?? o.sample_matrix, b.measurementUnits ?? o.measurement_units, b.measurandType ?? o.measurand_type, b.reagentLot ?? o.reagent_lot, b.manufacturer ?? o.manufacturer, num(b.equipmentId, o.equipment_id), b.verificationType ?? o.verification_type, b.studyType ?? o.study_type, b.scopeReason ?? o.scope_reason, b.reason ?? o.reason, b.manufacturerClaimsRef ?? o.manufacturer_claims_ref, b.guidelineRef ?? o.guideline_ref, b.startDate ?? o.start_date, b.completionDate ?? o.completion_date, b.acceptanceCriteria ?? o.acceptance_criteria, b.summary ?? o.summary, b.conclusion ?? o.conclusion, b.limitations ?? o.limitations, b.verdict ?? o.verdict, b.nextReviewDate ?? o.next_review_date, num(b.performedByStaffId, o.performed_by_staff_id), b.status ?? o.status, req.params.id);
    audit(req, { action: 'edit', entity: 'method_verifications', entityId: req.params.id, oldValue: o, newValue: b });
    res.json({ ok: true });
  });

  router.delete('/:id', requirePermission('verification_validation', 'void_archive'), (req, res) => {
    const db = getDb();
    db.prepare('DELETE FROM verification_parameters WHERE verification_id = ?').run(req.params.id);
    db.prepare('DELETE FROM method_verifications WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  });

  // Seed / re-seed the standard parameter set (adds any that are missing).
  router.post('/:id/seed-parameters', requirePermission('verification_validation', 'edit'), (req, res) => {
    const db = getDb();
    const study = db.prepare('SELECT * FROM method_verifications WHERE id = ?').get(req.params.id) as any;
    if (!study) return res.status(404).json({ error: 'Study not found' });
    const existing = new Set((db.prepare('SELECT parameter FROM verification_parameters WHERE verification_id = ?').all(req.params.id) as any[]).map(p => p.parameter));
    let order = (db.prepare('SELECT COALESCE(MAX(display_order),0) n FROM verification_parameters WHERE verification_id = ?').get(req.params.id) as { n: number }).n;
    const ins = db.prepare('INSERT INTO verification_parameters (verification_id, parameter, parameter_label, statistic_label, unit, display_order) VALUES (?, ?, ?, ?, ?, ?)');
    let added = 0;
    for (const c of seedParameters(study.study_type, study.measurand_type)) { if (!existing.has(c)) { ins.run(req.params.id, c, PARAM_LABELS[c]?.label ?? c, PARAM_LABELS[c]?.stat ?? null, PARAM_LABELS[c]?.unit ?? null, ++order); added++; } }
    res.json({ ok: true, added });
  });

  // Parameter CRUD
  router.post('/:id/parameters', requirePermission('verification_validation', 'edit'), (req, res) => {
    const db = getDb();
    if (!db.prepare('SELECT id FROM method_verifications WHERE id = ?').get(req.params.id)) return res.status(404).json({ error: 'Study not found' });
    const code = String(req.body.parameter || 'custom');
    const order = parseIntNullable(req.body.displayOrder) ?? (db.prepare('SELECT COALESCE(MAX(display_order),0)+1 n FROM verification_parameters WHERE verification_id = ?').get(req.params.id) as { n: number }).n;
    const r = db.prepare('INSERT INTO verification_parameters (verification_id, parameter, parameter_label, acceptance_criteria, claimed_value, observed_value, statistic_label, statistic_value, unit, n_samples, outcome, notes, display_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(req.params.id, code, req.body.parameterLabel ?? PARAM_LABELS[code]?.label ?? code, req.body.acceptanceCriteria ?? null, req.body.claimedValue ?? null, req.body.observedValue ?? null, req.body.statisticLabel ?? PARAM_LABELS[code]?.stat ?? null, req.body.statisticValue ?? null, req.body.unit ?? PARAM_LABELS[code]?.unit ?? null, parseIntNullable(req.body.nSamples), OUTCOMES.includes(req.body.outcome) ? req.body.outcome : 'pending', req.body.notes ?? null, order);
    res.status(201).json({ id: Number(r.lastInsertRowid) });
  });
  router.put('/parameters/:pid', requirePermission('verification_validation', 'edit'), (req, res) => {
    const db = getDb();
    const o = db.prepare('SELECT * FROM verification_parameters WHERE id = ?').get(req.params.pid) as any;
    if (!o) return res.status(404).json({ error: 'Parameter not found' });
    const b = req.body;
    db.prepare('UPDATE verification_parameters SET parameter_label = ?, acceptance_criteria = ?, claimed_value = ?, observed_value = ?, statistic_label = ?, statistic_value = ?, unit = ?, n_samples = ?, outcome = ?, notes = ?, evidence_file_id = ?, display_order = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(b.parameterLabel ?? o.parameter_label, b.acceptanceCriteria ?? o.acceptance_criteria, b.claimedValue ?? o.claimed_value, b.observedValue ?? o.observed_value, b.statisticLabel ?? o.statistic_label, b.statisticValue ?? o.statistic_value, b.unit ?? o.unit, b.nSamples !== undefined ? parseIntNullable(b.nSamples) : o.n_samples, b.outcome && OUTCOMES.includes(b.outcome) ? b.outcome : o.outcome, b.notes ?? o.notes, b.evidenceFileId !== undefined ? parseIntNullable(b.evidenceFileId) : o.evidence_file_id, parseIntNullable(b.displayOrder) ?? o.display_order, req.params.pid);
    res.json({ ok: true });
  });
  router.delete('/parameters/:pid', requirePermission('verification_validation', 'edit'), (req, res) => {
    getDb().prepare('DELETE FROM verification_parameters WHERE id = ?').run(req.params.pid);
    res.json({ ok: true });
  });

  // ---- Raw-data workbench: datapoints + auto-computed statistics ----
  router.get('/parameters/:pid/datapoints', requirePermission('verification_validation', 'view'), (req, res) => {
    res.json(getDb().prepare('SELECT * FROM verification_datapoints WHERE parameter_id = ? ORDER BY display_order, id').all(req.params.pid));
  });
  // Replace the whole datapoint set for a parameter.
  router.post('/parameters/:pid/datapoints', requirePermission('verification_validation', 'edit'), (req, res) => {
    const db = getDb();
    if (!db.prepare('SELECT id FROM verification_parameters WHERE id = ?').get(req.params.pid)) return res.status(404).json({ error: 'Parameter not found' });
    const points: Array<{ sampleLabel?: string; valueA?: unknown; valueB?: unknown }> = Array.isArray(req.body.points) ? req.body.points : [];
    const num = (v: unknown) => { const n = Number(v); return v === '' || v === null || v === undefined || !Number.isFinite(n) ? null : n; };
    const tx = db.transaction(() => {
      db.prepare('DELETE FROM verification_datapoints WHERE parameter_id = ?').run(req.params.pid);
      const ins = db.prepare('INSERT INTO verification_datapoints (parameter_id, sample_label, value_a, value_b, display_order) VALUES (?, ?, ?, ?, ?)');
      points.forEach((p, i) => { if (num(p.valueA) !== null || num(p.valueB) !== null || (p.sampleLabel && String(p.sampleLabel).trim())) ins.run(req.params.pid, p.sampleLabel ?? null, num(p.valueA), num(p.valueB), i + 1); });
    });
    tx();
    res.json({ ok: true });
  });
  // Compute the statistic appropriate to the characteristic and write it back to
  // the parameter's observed/statistic fields.
  router.post('/parameters/:pid/compute', requirePermission('verification_validation', 'edit'), (req, res) => {
    const db = getDb();
    const p = db.prepare('SELECT * FROM verification_parameters WHERE id = ?').get(req.params.pid) as any;
    if (!p) return res.status(404).json({ error: 'Parameter not found' });
    const pts = db.prepare('SELECT * FROM verification_datapoints WHERE parameter_id = ? ORDER BY display_order, id').all(req.params.pid) as any[];
    const a = pts.map(d => Number(d.value_a)).filter(v => Number.isFinite(v));
    const b = pts.map(d => Number(d.value_b)).filter(v => Number.isFinite(v));
    const code = p.parameter as string;
    let observed = '', statLabel = p.statistic_label, statVal = '', n = a.length;
    if (/^precision|reproducibility/.test(code)) {
      const m = mean(a), s = sd(a), cv = cvPercent(a);
      statLabel = 'CV%'; statVal = round(cv, 2)?.toString() ?? '';
      observed = cv != null ? `CV ${round(cv, 2)}% (mean ${round(m, 3)}, SD ${round(s, 3)}, n=${n})` : '';
    } else if (/trueness|bias|interference/.test(code)) {
      const target = Number(p.claimed_value);
      const m = mean(a);
      if (Number.isFinite(target) && target !== 0 && m != null) { const bias = (m - target) / target * 100; statLabel = 'Bias%'; statVal = round(bias, 2)?.toString() ?? ''; observed = `Bias ${round(bias, 2)}% (mean ${round(m, 3)} vs target ${target}, n=${n})`; }
      else if (m != null) { observed = `mean ${round(m, 3)} (n=${n}); set a claimed/target value to compute bias%`; }
    } else if (code === 'method_comparison') {
      const reg = linreg(b, a); // y = test (a) on x = comparator (b)
      if (reg) { statLabel = 'Slope; r'; statVal = `${round(reg.slope, 3)}; ${round(reg.r, 3)}`; observed = `y = ${round(reg.slope, 3)}x ${reg.intercept >= 0 ? '+' : '−'} ${Math.abs(round(reg.intercept, 3) ?? 0)}, r = ${round(reg.r, 4)} (n=${reg.n})`; n = reg.n; }
      else observed = 'Enter test (A) and comparator (B) pairs to compute regression';
    } else if (code === 'linearity') {
      const reg = linreg(b, a); // measured (a) vs assigned (b)
      if (reg) { statLabel = 'r²'; statVal = round(reg.r2, 4)?.toString() ?? ''; observed = `r² = ${round(reg.r2, 4)}, slope = ${round(reg.slope, 3)} (n=${reg.n})`; n = reg.n; }
      else observed = 'Enter measured (A) and assigned (B) pairs to compute linearity';
    } else {
      const m = mean(a), s = sd(a);
      if (m != null) { statVal = round(m, 3)?.toString() ?? ''; observed = `mean ${round(m, 3)}${s != null ? `, SD ${round(s, 3)}` : ''} (n=${n})`; }
    }
    db.prepare('UPDATE verification_parameters SET observed_value = ?, statistic_label = ?, statistic_value = ?, n_samples = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(observed || p.observed_value, statLabel || p.statistic_label, statVal || p.statistic_value, n || p.n_samples, req.params.pid);
    res.json({ ok: true, observed, statisticLabel: statLabel, statisticValue: statVal, n });
  });

  // Attach / insert the verification or validation report (a scanned or generated file).
  router.post('/:id/report', requirePermission('verification_validation', 'edit'), upload.single('file'), (req, res) => {
    const db = getDb();
    const study = db.prepare('SELECT id FROM method_verifications WHERE id = ?').get(req.params.id);
    if (!study) return res.status(404).json({ error: 'Study not found' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    const fr = db.prepare('INSERT INTO files (original_name, stored_name, mime_type, size_bytes, storage_area, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)')
      .run(req.file.originalname, req.file.filename, req.file.mimetype, req.file.size, 'uploads', req.user!.id);
    const fileId = Number(fr.lastInsertRowid);
    db.prepare('UPDATE method_verifications SET report_file_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(fileId, req.params.id);
    audit(req, { action: 'edit', entity: 'method_verifications', entityId: req.params.id, newValue: { reportFileId: fileId } });
    res.status(201).json({ ok: true, fileId, fileName: req.file.originalname });
  });

  // Review, then authorise for clinical use (or reject). Verdict is derived from
  // parameter outcomes but can be overridden by the reviewer.
  router.post('/:id/review', requirePermission('verification_validation', 'edit'), (req, res) => {
    const db = getDb();
    const study = db.prepare('SELECT * FROM method_verifications WHERE id = ?').get(req.params.id) as any;
    if (!study) return res.status(404).json({ error: 'Study not found' });
    const reviewer = getStaffIdOrCurrent(req, req.body.reviewedByStaffId);
    db.prepare("UPDATE method_verifications SET reviewed_by_staff_id = ?, reviewed_at = CURRENT_TIMESTAMP, status = 'reviewed', summary = COALESCE(?, summary), updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(reviewer, req.body.summary ?? null, req.params.id);
    audit(req, { action: 'review', entity: 'method_verifications', entityId: req.params.id });
    res.json({ ok: true });
  });
  router.post('/:id/authorize', requirePermission('verification_validation', 'approve'), (req, res) => {
    const db = getDb();
    const study = db.prepare('SELECT * FROM method_verifications WHERE id = ?').get(req.params.id) as any;
    if (!study) return res.status(404).json({ error: 'Study not found' });
    const approvedBy = getStaffIdOrCurrent(req, req.body.approvedByStaffId);
    if (approvedBy === null) return res.status(400).json({ error: 'This action requires the logged-in user to be linked to a staff record.' });
    const params = db.prepare('SELECT outcome FROM verification_parameters WHERE verification_id = ?').all(req.params.id) as any[];
    const anyFail = params.some(p => p.outcome === 'fail');
    const anyPending = params.some(p => p.outcome === 'pending');
    let verdict = req.body.verdict && VERDICTS.includes(req.body.verdict) ? req.body.verdict : (anyFail ? 'not_acceptable' : anyPending ? 'pending' : 'acceptable');
    const authorize = req.body.authorizeForUse === true || req.body.authorizeForUse === 'true';
    const status = req.body.reject ? 'rejected' : 'approved';
    db.prepare(`UPDATE method_verifications SET approved_by_staff_id = ?, approved_at = CURRENT_TIMESTAMP, status = ?, verdict = ?, authorized_for_use = ?, authorized_date = ?, conclusion = COALESCE(?, conclusion), limitations = COALESCE(?, limitations), completion_date = COALESCE(completion_date, ?), updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(approvedBy, status, verdict, authorize ? 1 : 0, authorize ? new Date().toISOString().slice(0, 10) : null, req.body.conclusion ?? null, req.body.limitations ?? null, new Date().toISOString().slice(0, 10), req.params.id);
    // A not-acceptable study raises a nonconformity so it is followed up.
    if (verdict === 'not_acceptable' && !req.body.suppressNc) {
      const ncNumber = generateRecordNumber(db, 'nonconforming_events', 'NC', new Date().toISOString());
      const ncRes = db.prepare(`INSERT INTO nonconforming_events (nc_number, event_date, detected_by_staff_id, section_id, source_module, source_record_id, title, description, category, severity, status, created_by, created_at)
        VALUES (?, ?, ?, ?, 'verification_validation', ?, ?, ?, 'method_performance', 'high', 'open', ?, ?)`)
        .run(ncNumber, new Date().toISOString().slice(0, 10), approvedBy, study.section_id, String(req.params.id), `Method ${study.study_type} not acceptable: ${study.method_name} (${study.test_name})`, `Study ${study.verification_number} did not meet its acceptance criteria and was found not acceptable for clinical use.`, req.user!.id, new Date().toISOString());
      db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run('verification_validation', 'method_verifications', String(req.params.id), 'nc_capa', 'nonconforming_events', String(ncRes.lastInsertRowid), 'Not-acceptable verification/validation');
    }
    audit(req, { action: 'approve', entity: 'method_verifications', entityId: req.params.id, newValue: { verdict, authorize, status } });
    res.json({ ok: true, verdict });
  });

  // Backward-compatible generic approve used by the old UI.
  router.post('/:id/approve', requirePermission('verification_validation', 'approve'), (req, res) => {
    const db = getDb();
    if (!db.prepare('SELECT id FROM method_verifications WHERE id = ?').get(req.params.id)) return res.status(404).json({ error: 'Study not found' });
    const approvedBy = getStaffIdOrCurrent(req, req.body.approvedByStaffId);
    if (approvedBy === null) return res.status(400).json({ error: 'This action requires the logged-in user to be linked to a staff record.' });
    db.prepare("UPDATE method_verifications SET approved_by_staff_id = ?, approved_at = CURRENT_TIMESTAMP, status = 'approved', conclusion = COALESCE(?, conclusion), completion_date = COALESCE(completion_date, ?), updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(approvedBy, req.body.conclusion ?? null, new Date().toISOString().slice(0, 10), req.params.id);
    res.json({ ok: true });
  });

  // Legacy experiments endpoint retained so older data/records still post.
  router.post('/:id/experiments', requirePermission('verification_validation', 'create'), (req, res) => {
    if (!req.body.experimentType) return res.status(400).json({ error: 'experimentType is required' });
    const db = getDb();
    if (!db.prepare('SELECT id FROM method_verifications WHERE id = ?').get(req.params.id)) return res.status(404).json({ error: 'Study not found' });
    const r = db.prepare(`INSERT INTO verification_experiments (verification_id, experiment_type, date_performed, sample_count, results_summary, acceptance_met, evidence_file_id, performed_by_staff_id, reviewed_by_staff_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(req.params.id, req.body.experimentType, req.body.datePerformed ?? null, parseIntNullable(req.body.sampleCount), req.body.resultsSummary ?? null, req.body.acceptanceMet ? 1 : 0, parseIntNullable(req.body.evidenceFileId), getStaffIdOrCurrent(req, req.body.performedByStaffId), parseIntNullable(req.body.reviewedByStaffId));
    res.status(201).json({ id: Number(r.lastInsertRowid) });
  });

  // ---- Excel export of the studies register ----
  const REGISTER_HEADERS = ['Number', 'Study type', 'Test', 'Method', 'Analyte', 'Matrix', 'Units', 'Measurand', 'Equipment', 'Guideline', 'Scope', 'Start', 'Completed', 'Verdict', 'Authorised', 'Status'];
  router.get('/export', requirePermission('verification_validation', 'export'), (_req, res) => {
    const db = getDb();
    const rows = db.prepare(`SELECT mv.*, e.name AS equipment_name FROM method_verifications mv LEFT JOIN equipment_items e ON e.id = mv.equipment_id ORDER BY mv.created_at DESC`).all() as any[];
    const aoa: any[][] = [REGISTER_HEADERS as unknown as string[]];
    for (const m of rows) aoa.push([m.verification_number, m.study_type, m.test_name, m.method_name, m.analyte ?? '', m.sample_matrix ?? '', m.measurement_units ?? '', m.measurand_type ?? '', m.equipment_name ?? '', m.guideline_ref ?? '', m.scope_reason ?? '', m.start_date ?? '', m.completion_date ?? '', m.verdict ?? '', m.authorized_for_use ? 'Yes' : 'No', m.status ?? '']);
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = REGISTER_HEADERS.map(h => ({ wch: Math.min(26, Math.max(10, h.length + 2)) }));
    XLSX.utils.book_append_sheet(wb, ws, 'VERIFICATION REGISTER');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="Method_Verification_Register.xlsx"');
    res.end(buf);
  });

  // ---- Printable formal verification/validation report ----
  router.get('/:id/print', requirePermission('verification_validation', 'print'), (req, res) => {
    const db = getDb();
    const s = loadStudy(db, req.params.id) as any;
    if (!s) return res.status(404).send('Study not found');
    const verdictLabel = (v: string) => ({ acceptable: 'ACCEPTABLE', acceptable_with_limitations: 'ACCEPTABLE WITH LIMITATIONS', not_acceptable: 'NOT ACCEPTABLE', pending: 'PENDING' }[v] || v);
    const outcomeBadge = (o: string) => `<span class="oc oc-${o}">${o.toUpperCase()}</span>`;
    const paramRows = (s.parameters as any[]).map(p => `<tr>
      <td>${escHtml(p.parameter_label)}</td>
      <td>${escHtml(p.acceptance_criteria || '—')}</td>
      <td>${escHtml(p.claimed_value || '—')}</td>
      <td>${escHtml([p.statistic_label, p.observed_value ?? p.statistic_value].filter(Boolean).join(': ') || '—')}${p.unit ? ' ' + escHtml(p.unit) : ''}${p.n_samples ? ` (n=${p.n_samples})` : ''}</td>
      <td>${outcomeBadge(p.outcome)}</td>
      <td>${escHtml(p.notes || '')}</td></tr>`).join('');
    const kv = (k: string, v: unknown) => v ? `<div><span class="k">${k}</span><span class="v">${escHtml(v)}</span></div>` : '';
    const sign = (role: string, name: unknown, date: unknown) => `<div class="sg"><div class="line"></div><div><b>${role}</b>${name ? `: ${escHtml(name)}` : ''}${date ? ` — ${escHtml(String(date).slice(0, 10))}` : ''}</div></div>`;
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>${escHtml(s.verification_number)} — ${escHtml(s.study_type)} report</title>
<style>@page{size:A4 portrait;margin:14mm}*{box-sizing:border-box}html,body{-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{font-family:'Times New Roman',Georgia,serif;color:#111;font-size:12px;line-height:1.4;padding:6px 10px}
.mast{display:flex;align-items:center;gap:14px;border-bottom:2px solid #1B3A6B;padding-bottom:8px;margin-bottom:8px}
.mast img{height:64px}.mast .org{font-weight:bold;font-size:17px}.mast .sub{font-size:11px;color:#444}
h1{font-size:15px;text-align:center;letter-spacing:1px;margin:8px 0}
.verdict{text-align:center;font-weight:bold;font-size:14px;padding:6px;border:2px solid #111;margin:8px 0}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:2px 24px;margin:8px 0}
.grid2 .k{display:inline-block;min-width:150px;color:#555}.grid2 .v{font-weight:bold}
h2{font-size:12.5px;color:#1B3A6B;border-bottom:1px solid #ccd;margin:14px 0 4px;padding-bottom:2px}
table{border-collapse:collapse;width:100%;font-size:10.5px;margin:4px 0}
th,td{border:1px solid #999;padding:4px 6px;text-align:left;vertical-align:top}
th{background:#eef2f7}
.oc{font-weight:bold;font-size:9px;padding:1px 5px;border-radius:3px;color:#fff}
.oc-pass{background:#1a7f37}.oc-fail{background:#c1121f}.oc-na{background:#6b7280}.oc-pending{background:#b8860b}
.sg{margin-top:26px}.sg .line{border-top:1px solid #111;width:230px;margin-bottom:3px}
.no-print{background:#f4f6fb;padding:8px;border:1px solid #ccd;border-radius:6px;margin-bottom:10px;font-size:11px}
@media print{.no-print{display:none}body{padding:0}}
</style><script>window.addEventListener("load",()=>{setTimeout(()=>window.print(),300)})</script></head><body>
<div class="no-print">The print dialog opens automatically — choose any printer or Save as PDF. <button onclick="window.print()">Print</button></div>
${labMasthead(db)}
<h1>${s.study_type === 'validation' ? 'METHOD VALIDATION REPORT' : 'METHOD VERIFICATION REPORT'}</h1>
<div class="verdict">OUTCOME: ${verdictLabel(s.verdict)}${s.authorized_for_use ? ' — AUTHORISED FOR CLINICAL USE' : ''}</div>
<div class="grid2">
  ${kv('Report no.', s.verification_number)}${kv('Test', s.test_name)}
  ${kv('Method', s.method_name)}${kv('Analyte', s.analyte)}
  ${kv('Sample matrix', s.sample_matrix)}${kv('Units', s.measurement_units)}
  ${kv('Measurand type', s.measurand_type)}${kv('Equipment', s.equipment_name)}
  ${kv('Manufacturer', s.manufacturer)}${kv('Reagent lot', s.reagent_lot)}
  ${kv('Reason / scope', s.scope_reason)}${kv('Guideline', s.guideline_ref)}
  ${kv('Manufacturer claims ref.', s.manufacturer_claims_ref)}${kv('Section', s.section_name)}
  ${kv('Start date', s.start_date)}${kv('Completion date', s.completion_date)}
  ${kv('Next review', s.next_review_date)}${kv('Status', s.status)}
</div>
<h2>Performance characteristics assessed</h2>
<table><thead><tr><th>Characteristic</th><th>Acceptance criterion</th><th>Claimed</th><th>Observed</th><th>Outcome</th><th>Notes</th></tr></thead>
<tbody>${paramRows || '<tr><td colspan="6">No characteristics recorded.</td></tr>'}</tbody></table>
${s.acceptance_criteria ? `<h2>Overall acceptance criteria</h2><div>${escHtml(s.acceptance_criteria)}</div>` : ''}
${s.summary ? `<h2>Summary of findings</h2><div>${escHtml(s.summary)}</div>` : ''}
${s.conclusion ? `<h2>Conclusion</h2><div>${escHtml(s.conclusion)}</div>` : ''}
${s.limitations ? `<h2>Limitations</h2><div>${escHtml(s.limitations)}</div>` : ''}
<div style="display:flex;gap:60px;flex-wrap:wrap">
  ${sign('Performed by', s.performed_by_name, s.start_date)}
  ${sign('Reviewed by', s.reviewed_by_name, s.reviewed_at)}
  ${sign('Authorised by', s.approved_by_name, s.approved_at)}
</div>
<div style="font-size:9px;color:#666;margin-top:18px;border-top:1px solid #ccc;padding-top:5px">SECH_LIMS · ${escHtml(s.verification_number)} · Generated ${new Date().toISOString().slice(0, 19).replace('T', ' ')}</div>
</body></html>`;
    audit(req, { action: 'print', entity: 'method_verifications', entityId: req.params.id });
    res.send(html);
  });

  return router;
}

export { METHOD_STATUSES, EQUIPMENT_VERIFICATION_STATUSES };
