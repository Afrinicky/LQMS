import { Router } from 'express';
import { getDb } from '../db/database.js';
import { requirePermission } from '../middleware/permissions.js';
import { requireAdministrator, requiredReason } from '../middleware/administrator.js';
import { requireAuth } from '../middleware/auth.js';
import { resolvePermission } from '../services/permissionResolver.js';
import { audit } from '../services/auditService.js';
import { generateRecordNumber } from '../utils/recordNumber.js';
import { parseIntNullable, getStaffIdOrCurrent, getCurrentStaffId, blockedForNoSignature } from './routeHelpers.js';
import { recordSignature, signaturesFor, signatureImageDataUri, fileDataUri } from '../services/signatureService.js';
import { buildWorkbook, sendWorkbook } from '../utils/xlsxRegister.js';
import {
  riskCriteria, saveRiskCriteria, evaluateRisk, requiresTreatment, nextReviewDate,
  canAcceptRisk, bandForScore, closesOnAcceptance, reviewMonthsFor, type RiskCriteria,
} from '../utils/riskCriteria.js';

// ==========================================================================
// Risk management — one staged lifecycle, each stage its own queue.
//
//   Identification -> Assessment -> Evaluation -> Control ->
//   Residual risk -> Acceptance -> Monitoring & review -> Closure
//
// A record never sits between stages: completing one stage writes the next
// one onto the record, so it appears in the following queue straight away.
// What each stage means in numbers — the wording of the 5x5 scales, where the
// bands fall, which band forces treatment, how often each band is reviewed and
// who may accept a residual risk — is the laboratory's own configuration.
// ==========================================================================

export const RISK_STAGES = ['identification', 'analysis', 'evaluation', 'treatment', 'residual', 'acceptance', 'monitoring', 'closed'] as const;

const RISK_HEADERS = [
  'Risk No.', 'Identified', 'Identified by', 'Unit / Section', 'Category', 'Source', 'Risk area', 'Description',
  'Cause', 'Consequence', 'Existing controls', 'Likelihood', 'Severity', 'Risk score', 'Risk level',
  'Control option', 'Control plan', 'Responsible person', 'Target completion',
  'Residual likelihood', 'Residual severity', 'Residual score', 'Residual level',
  'Acceptance', 'Accepted by', 'Review due', 'Step', 'Status',
] as const;

function escHtml(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}
function labMasthead(db: any): string {
  const p = db.prepare('SELECT * FROM laboratory_profile WHERE id = 1').get() as any;
  const logo = fileDataUri(p?.logo_file_id ?? null);
  const sub = [p?.city, p?.country].filter(Boolean).map(escHtml).join(', ');
  return `<div class="mast">${logo ? `<img src="${logo}" alt=""/>` : ''}<div><div class="org">${escHtml(p?.facility_name || 'Laboratory')}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div></div>`;
}
function facilityName(db: any): string {
  const p = db.prepare('SELECT facility_name FROM laboratory_profile WHERE id = 1').get() as any;
  return p?.facility_name || 'Laboratory';
}

const SELECT_RISK = `SELECT r.*, s.name AS section_name,
    idb.full_name AS identified_by_name, resp.full_name AS responsible_name,
    own.full_name AS treatment_owner_name, acc.full_name AS accepted_by_name
  FROM risks r
  LEFT JOIN sections s ON s.id = r.section_id
  LEFT JOIN staff idb ON idb.id = r.identified_by_staff_id
  LEFT JOIN staff resp ON resp.id = r.responsible_staff_id
  LEFT JOIN staff own ON own.id = r.treatment_owner_staff_id
  LEFT JOIN staff acc ON acc.id = r.accepted_by_staff_id`;

export function riskRoutes() {
  const router = Router();

  const asFlag = (v: unknown) => (v === true || v === 'true' || v === 1 || v === '1') ? 1 : 0;
  /** The free text behind an "other" choice, kept only while "other" is chosen. */
  const other = (choice: unknown, text: unknown) => choice === 'other' ? (String(text ?? '').trim() || null) : null;

  function loadRisk(db: any, id: unknown) {
    return db.prepare(`${SELECT_RISK} WHERE r.id = ?`).get(id) as any;
  }

  /**
   * Sign a stage off. Acceptance and review are authorisations and refuse to
   * proceed without a signature on file; the earlier technical stages record
   * one when the assessor has it, and carry on when they have not.
   */
  function sign(req: any, riskId: unknown, purpose: string, meaning: string, required: boolean) {
    try { recordSignature(req, { moduleKey: 'risks', recordType: 'risks', recordId: String(riskId), purpose, meaning }); return true; }
    catch (e) { if (required) throw e; return false; }
  }

  /** Moves a risk on, recording who did it, and returns a short trail line. */
  function advance(db: any, id: unknown, stage: string, patch: Record<string, unknown> = {}) {
    const entries = Object.entries({ workflow_stage: stage, ...patch });
    db.prepare(`UPDATE risks SET ${entries.map(([k]) => `${k} = ?`).join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(...entries.map(([, v]) => v as any), id);
  }

  // ---- configuration -----------------------------------------------------

  router.get('/criteria', requireAuth, (req, res) => {
    const db = getDb();
    const criteria = riskCriteria(db);
    const may = (action: string) => resolvePermission(req.user!.id, 'risks', action).allowed;
    res.json({
      ...criteria,
      canCreate: may('create'),
      canAssess: may('edit') || may('approve'),
      canAccept: may('approve') && canAcceptRisk(db, req.user!.roleId, criteria),
      canClose: may('void_archive'),
      canConfigure: resolvePermission(req.user!.id, 'settings', 'edit').allowed,
    });
  });

  router.put('/criteria', requirePermission('settings', 'edit'), (req, res) => {
    const db = getDb();
    const saved = saveRiskCriteria(db, req.body || {});
    audit(req, { action: 'edit', entity: 'settings', entityId: 'risk.criteria', newValue: saved });
    res.json(saved);
  });

  // ---- register ----------------------------------------------------------

  router.get('/', requirePermission('risks', 'view'), (_req, res) => {
    res.json(getDb().prepare(`${SELECT_RISK} ORDER BY r.id DESC`).all());
  });

  router.get('/summary', requirePermission('risks', 'view'), (_req, res) => {
    const db = getDb();
    const criteria = riskCriteria(db);
    const rows = db.prepare('SELECT workflow_stage, status, risk_level, residual_level, risk_score, review_due_date, risk_category, affects_patient_safety FROM risks').all() as any[];
    const open = rows.filter(r => r.status !== 'closed');
    const today = new Date().toISOString().slice(0, 10);
    const byStage: Record<string, number> = {};
    for (const stage of RISK_STAGES) byStage[stage] = open.filter(r => (r.workflow_stage || 'analysis') === stage).length;
    const byLevel: Record<string, number> = {};
    for (const band of criteria.bands) byLevel[band.level] = open.filter(r => (r.residual_level || r.risk_level) === band.level).length;
    const byCategory: Record<string, number> = {};
    for (const r of open) { const k = r.risk_category || 'unspecified'; byCategory[k] = (byCategory[k] || 0) + 1; }
    res.json({
      total: rows.length, open: open.length, closed: rows.length - open.length,
      byStage, byLevel, byCategory,
      reviewsDue: open.filter(r => r.review_due_date && r.review_due_date <= today).length,
      patientSafety: open.filter(r => r.affects_patient_safety).length,
    });
  });

  // ---- step 1: identification -------------------------------------------

  router.post('/', requirePermission('risks', 'create'), (req, res) => {
    const db = getDb();
    if (!req.body.riskArea || !req.body.riskDescription) {
      return res.status(400).json({ error: 'A risk area and a risk description are required.' });
    }
    // An "other" that cannot say what it was is not a record, so each one is
    // refused until it is spelled out.
    const external = req.body.identifiedByStaffId === 'other';
    if (external && !String(req.body.identifiedByOther ?? '').trim()) {
      return res.status(400).json({ error: 'Name the person or body who identified this risk.' });
    }
    for (const [field, value, text] of [
      ['risk category', req.body.riskCategory, req.body.riskCategoryOther],
      ['source', req.body.riskSource, req.body.riskSourceOther],
    ] as Array<[string, unknown, unknown]>) {
      if (value === 'other' && !String(text ?? '').trim()) {
        return res.status(400).json({ error: `Specify the ${field}.` });
      }
    }
    const createdAt = new Date().toISOString();
    const riskNumber = generateRecordNumber(db, 'risks', 'RISK', createdAt);
    const result = db.prepare(`INSERT INTO risks
      (risk_number, section_id, risk_category, risk_category_other, risk_source, risk_source_other, process_affected,
       risk_area, risk_description, cause, consequence, existing_controls,
       identified_by_staff_id, identified_by_other, identified_date, affects_patient_safety, responsible_staff_id,
       workflow_stage, status, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'analysis', 'active', ?, ?)`)
      .run(
        riskNumber,
        parseIntNullable(req.body.sectionId),
        req.body.riskCategory ?? null,
        other(req.body.riskCategory, req.body.riskCategoryOther),
        req.body.riskSource ?? 'proactive_assessment',
        other(req.body.riskSource, req.body.riskSourceOther),
        req.body.processAffected ?? null,
        req.body.riskArea,
        req.body.riskDescription,
        req.body.cause ?? null,
        req.body.consequence ?? null,
        req.body.existingControls ?? null,
        external ? null : getStaffIdOrCurrent(req, req.body.identifiedByStaffId),
        external ? String(req.body.identifiedByOther).trim() : null,
        req.body.identifiedDate ?? createdAt.slice(0, 10),
        asFlag(req.body.affectsPatientSafety),
        parseIntNullable(req.body.responsibleStaffId),
        req.user!.id,
        createdAt,
      );
    // Somebody found this risk and put their name to it. Where that somebody
    // is the person logging it, their signature goes on the record now rather
    // than leaving a ruled line on the printed report. Where a risk is logged
    // on behalf of another person, nobody signs for them: the report names
    // them and leaves the line for their own signature.
    const identifier = external ? null : getStaffIdOrCurrent(req, req.body.identifiedByStaffId);
    if (identifier !== null && identifier === getCurrentStaffId(req)) {
      sign(req, result.lastInsertRowid, 'risk_identification', `Identified ${riskNumber}`, false);
    }
    audit(req, { action: 'create', entity: 'risks', entityId: result.lastInsertRowid, newValue: { riskNumber, ...req.body } });
    res.status(201).json({ id: Number(result.lastInsertRowid), riskNumber, nextStage: 'analysis' });
  });

  router.get('/:id', requirePermission('risks', 'view'), (req, res) => {
    const db = getDb();
    const item = loadRisk(db, req.params.id);
    if (!item) return res.status(404).json({ error: 'Risk not found' });
    const controls = db.prepare(`SELECT c.*, st.full_name AS responsible_name FROM risk_controls c
      LEFT JOIN staff st ON st.id = c.responsible_staff_id WHERE c.risk_id = ? ORDER BY c.id`).all(req.params.id);
    const reviews = db.prepare(`SELECT rv.*, st.full_name AS reviewed_by_name FROM risk_reviews rv
      LEFT JOIN staff st ON st.id = rv.reviewed_by_staff_id WHERE rv.risk_id = ? ORDER BY rv.review_date DESC`).all(req.params.id);
    const links = db.prepare(`SELECT * FROM record_links WHERE (source_module_key = 'risks' AND source_record_id = ?) OR (target_module_key = 'risks' AND target_record_id = ?)`)
      .all(String(req.params.id), String(req.params.id));
    res.json({ ...item, controls, reviews, links, signatures: signaturesFor('risks', 'risks', req.params.id) });
  });

  /** Amend the identified facts. Scores are never edited here — they are set by the analysis step. */
  router.put('/:id', requirePermission('risks', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = loadRisk(db, req.params.id);
    if (!oldValue) return res.status(404).json({ error: 'Risk not found' });
    db.prepare(`UPDATE risks SET section_id = ?, risk_category = ?, risk_category_other = ?, risk_source = ?,
      risk_source_other = ?, process_affected = ?, risk_area = ?,
      risk_description = ?, cause = ?, consequence = ?, existing_controls = ?, responsible_staff_id = ?,
      affects_patient_safety = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(
        parseIntNullable(req.body.sectionId) ?? oldValue.section_id,
        req.body.riskCategory ?? oldValue.risk_category,
        req.body.riskCategory === undefined ? oldValue.risk_category_other : other(req.body.riskCategory, req.body.riskCategoryOther),
        req.body.riskSource ?? oldValue.risk_source,
        req.body.riskSource === undefined ? oldValue.risk_source_other : other(req.body.riskSource, req.body.riskSourceOther),
        req.body.processAffected ?? oldValue.process_affected,
        req.body.riskArea ?? oldValue.risk_area,
        req.body.riskDescription ?? oldValue.risk_description,
        req.body.cause ?? oldValue.cause,
        req.body.consequence ?? oldValue.consequence,
        req.body.existingControls ?? oldValue.existing_controls,
        parseIntNullable(req.body.responsibleStaffId) ?? oldValue.responsible_staff_id,
        req.body.affectsPatientSafety === undefined ? oldValue.affects_patient_safety : asFlag(req.body.affectsPatientSafety),
        req.params.id,
      );
    audit(req, { action: 'edit', entity: 'risks', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  // ---- step 2: risk analysis --------------------------------------------

  router.post('/:id/analysis', requirePermission('risks', 'edit'), (req, res) => {
    const db = getDb();
    const criteria = riskCriteria(db);
    const risk = loadRisk(db, req.params.id);
    if (!risk) return res.status(404).json({ error: 'Risk not found' });
    const evaluation = evaluateRisk(criteria, req.body.likelihood, req.body.severity);
    if (evaluation.score === null) return res.status(400).json({ error: 'Select both a likelihood and a severity on the matrix.' });

    const safety = req.body.affectsPatientSafety === undefined ? !!risk.affects_patient_safety : !!asFlag(req.body.affectsPatientSafety);
    advance(db, req.params.id, 'evaluation', {
      likelihood: evaluation.likelihood, severity: evaluation.severity,
      risk_score: evaluation.score, risk_level: evaluation.level,
      affects_patient_safety: safety ? 1 : 0,
      analysis_notes: req.body.analysisNotes ?? null,
      analysed_by_staff_id: getStaffIdOrCurrent(req, req.body.analysedByStaffId),
      analysed_at: new Date().toISOString(),
      evaluation_decision: null,
      status: 'active',
    });
    sign(req, req.params.id, 'risk_analysis', `Assessed ${risk.risk_number} as ${evaluation.levelLabel} risk (score ${evaluation.score})`, false);
    audit(req, { action: 'edit', entity: 'risks', entityId: req.params.id, newValue: { stage: 'analysis', ...evaluation } });
    res.json({ ok: true, ...evaluation, nextStage: 'evaluation' });
  });

  // ---- step 3: risk evaluation -------------------------------------------
  //
  // Analysis says how big the risk is; evaluation says what the laboratory's
  // own criteria require be done about it. The criteria can force treatment,
  // but never forbid it — an assessor may always choose to control a risk the
  // criteria would let through.

  router.post('/:id/evaluation', requirePermission('risks', 'edit'), (req, res) => {
    const db = getDb();
    const criteria = riskCriteria(db);
    const risk = loadRisk(db, req.params.id);
    if (!risk) return res.status(404).json({ error: 'Risk not found' });
    if (risk.risk_score == null) return res.status(400).json({ error: 'Assess the risk on the matrix before evaluating it.' });

    const safety = !!risk.affects_patient_safety;
    const mustTreat = requiresTreatment(criteria, risk.risk_level, safety);
    const decision = mustTreat ? 'treat' : (req.body.decision === 'treat' ? 'treat' : 'accept');
    const band = criteria.bands.find(b => b.level === risk.risk_level);
    // A risk judged tolerable as it stands has no treatment to shrink it, so
    // its residual risk is its current risk and it goes straight to acceptance.
    const stage = decision === 'treat' ? 'treatment' : 'acceptance';

    advance(db, req.params.id, stage, {
      evaluation_decision: decision,
      analysis_notes: req.body.evaluationNotes ? `${risk.analysis_notes ? `${risk.analysis_notes}\n\n` : ''}${req.body.evaluationNotes}` : risk.analysis_notes,
      status: decision === 'treat' ? 'mitigation_in_progress' : 'active',
      ...(decision === 'accept' ? {
        residual_likelihood: risk.likelihood, residual_severity: risk.severity,
        residual_score: risk.risk_score, residual_level: risk.risk_level,
      } : {}),
    });
    audit(req, { action: 'edit', entity: 'risks', entityId: req.params.id, newValue: { stage: 'evaluation', decision } });
    res.json({
      ok: true, decision, nextStage: stage, forcedTreatment: mustTreat,
      level: risk.risk_level, score: risk.risk_score, criteriaAction: band?.action ?? null,
      reason: mustTreat
        ? (safety && criteria.alwaysTreatPatientSafety && !requiresTreatment(criteria, risk.risk_level, false)
          ? 'Flagged as affecting patient or staff safety — control is required whatever the band.'
          : `Assessed as ${band?.label ?? risk.risk_level} — at or above the level your criteria require to be controlled.`)
        : null,
    });
  });

  // ---- step 3: treatment -------------------------------------------------

  router.post('/:id/treatment', requirePermission('risks', 'edit'), (req, res) => {
    const db = getDb();
    const risk = loadRisk(db, req.params.id);
    if (!risk) return res.status(404).json({ error: 'Risk not found' });
    if (!req.body.treatmentOption) return res.status(400).json({ error: 'Select a control option.' });
    if (!req.body.mitigationPlan) return res.status(400).json({ error: 'Describe the control plan.' });
    advance(db, req.params.id, 'treatment', {
      treatment_option: req.body.treatmentOption,
      mitigation_plan: req.body.mitigationPlan,
      treatment_owner_staff_id: parseIntNullable(req.body.treatmentOwnerStaffId),
      treatment_due_date: req.body.treatmentDueDate ?? null,
      treatment_notes: req.body.treatmentNotes ?? null,
      status: 'mitigation_in_progress',
    });
    audit(req, { action: 'edit', entity: 'risks', entityId: req.params.id, newValue: { stage: 'treatment', ...req.body } });
    res.json({ ok: true, nextStage: 'treatment' });
  });

  /** Controls are the individual measures the plan is made of. */
  router.post('/:id/controls', requirePermission('risks', 'edit'), (req, res) => {
    const db = getDb();
    if (!loadRisk(db, req.params.id)) return res.status(404).json({ error: 'Risk not found' });
    if (!req.body.controlDescription) return res.status(400).json({ error: 'Describe the control.' });
    const result = db.prepare(`INSERT INTO risk_controls
      (risk_id, control_description, control_type, responsible_staff_id, target_date, status, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, 'planned', ?, ?)`)
      .run(req.params.id, req.body.controlDescription, req.body.controlType ?? null,
        parseIntNullable(req.body.responsibleStaffId), req.body.targetDate ?? null, req.user!.id, new Date().toISOString());
    const controlId = Number(result.lastInsertRowid);

    // A control with an owner and a date is an action; raising it here keeps it
    // on the same tracker as every other outstanding task in the laboratory.
    if (req.body.createAction && resolvePermission(req.user!.id, 'actions', 'create').allowed) {
      const act = db.prepare(`INSERT INTO actions (title, module_key, source_module, source_record_id, description, assigned_to_staff_id, due_date, priority, status, evidence_required, created_by)
        VALUES (?, 'actions', 'risks', ?, ?, ?, ?, ?, 'Not started', 0, ?)`)
        .run(String(req.body.controlDescription).slice(0, 120), String(req.params.id), req.body.controlDescription,
          parseIntNullable(req.body.responsibleStaffId), req.body.targetDate ?? null, req.body.priority ?? 'normal', req.user!.id);
      db.prepare('UPDATE risk_controls SET action_id = ? WHERE id = ?').run(Number(act.lastInsertRowid), controlId);
      db.prepare(`INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes)
        VALUES ('risks', 'risks', ?, 'actions', 'actions', ?, 'Risk control action')`)
        .run(String(req.params.id), String(act.lastInsertRowid));
    }
    audit(req, { action: 'create', entity: 'risk_controls', entityId: controlId, newValue: { riskId: req.params.id, ...req.body } });
    res.status(201).json({ id: controlId });
  });

  router.put('/:id/controls/:controlId', requirePermission('risks', 'edit'), (req, res) => {
    const db = getDb();
    const control = db.prepare('SELECT * FROM risk_controls WHERE id = ? AND risk_id = ?').get(req.params.controlId, req.params.id) as any;
    if (!control) return res.status(404).json({ error: 'Control not found' });
    const status = req.body.status ?? control.status;
    db.prepare(`UPDATE risk_controls SET control_description = ?, control_type = ?, responsible_staff_id = ?, target_date = ?,
      status = ?, completed_date = ?, verification_notes = ? WHERE id = ?`)
      .run(
        req.body.controlDescription ?? control.control_description,
        req.body.controlType ?? control.control_type,
        req.body.responsibleStaffId === undefined ? control.responsible_staff_id : parseIntNullable(req.body.responsibleStaffId),
        req.body.targetDate ?? control.target_date,
        status,
        status === 'implemented' ? (req.body.completedDate ?? new Date().toISOString().slice(0, 10)) : (req.body.completedDate ?? control.completed_date),
        req.body.verificationNotes ?? control.verification_notes,
        req.params.controlId,
      );
    audit(req, { action: 'edit', entity: 'risk_controls', entityId: req.params.controlId, oldValue: control, newValue: req.body });
    res.json({ ok: true });
  });

  router.delete('/:id/controls/:controlId', requirePermission('risks', 'edit'), (req, res) => {
    const db = getDb();
    const control = db.prepare('SELECT * FROM risk_controls WHERE id = ? AND risk_id = ?').get(req.params.controlId, req.params.id) as any;
    if (!control) return res.status(404).json({ error: 'Control not found' });
    db.prepare('DELETE FROM risk_controls WHERE id = ?').run(req.params.controlId);
    audit(req, { action: 'delete', entity: 'risk_controls', entityId: req.params.controlId, oldValue: control });
    res.json({ ok: true });
  });

  /** Control is complete: the risk moves on to be re-scored and accepted. */
  router.post('/:id/treatment/complete', requirePermission('risks', 'edit'), (req, res) => {
    const db = getDb();
    const risk = loadRisk(db, req.params.id);
    if (!risk) return res.status(404).json({ error: 'Risk not found' });
    // A control plan is only done when there is something to have done, and
    // every part of it is in place. An empty plan marked complete is exactly
    // the record that does not survive an assessment.
    const totals = db.prepare("SELECT COUNT(*) AS n, SUM(CASE WHEN status != 'implemented' THEN 1 ELSE 0 END) AS outstanding FROM risk_controls WHERE risk_id = ?").get(req.params.id) as any;
    if (!totals.n) return res.status(400).json({ error: 'Record at least one control measure before completing the control step.' });
    if (totals.outstanding > 0) return res.status(400).json({ error: `${totals.outstanding} control(s) are still outstanding. Mark each one implemented first.` });
    advance(db, req.params.id, 'residual', {
      treatment_completed_at: new Date().toISOString(),
      treatment_notes: req.body.treatmentNotes ?? risk.treatment_notes,
    });
    sign(req, req.params.id, 'risk_treatment_complete', `Confirmed all controls implemented for ${risk.risk_number}`, false);
    audit(req, { action: 'edit', entity: 'risks', entityId: req.params.id, newValue: { stage: 'treatment_complete' } });
    res.json({ ok: true, nextStage: 'residual' });
  });

  // ---- step 5: residual risk ---------------------------------------------

  router.post('/:id/residual', requirePermission('risks', 'edit'), (req, res) => {
    const db = getDb();
    const criteria = riskCriteria(db);
    const risk = loadRisk(db, req.params.id);
    if (!risk) return res.status(404).json({ error: 'Risk not found' });
    const evaluation = evaluateRisk(criteria, req.body.residualLikelihood, req.body.residualSeverity);
    if (evaluation.score === null) return res.status(400).json({ error: 'Select both a residual likelihood and severity on the matrix.' });
    if (evaluation.score > (risk.risk_score ?? 25) && !req.body.confirmIncrease) {
      return res.status(400).json({ error: 'The residual score is higher than the initial score. Re-check the assessment, or confirm the increase.' });
    }
    advance(db, req.params.id, 'acceptance', {
      residual_likelihood: evaluation.likelihood, residual_severity: evaluation.severity,
      residual_score: evaluation.score, residual_level: evaluation.level,
      residual_assessed_at: new Date().toISOString(),
      residual_assessed_by_staff_id: getStaffIdOrCurrent(req, req.body.assessedByStaffId),
    });
    sign(req, req.params.id, 'risk_residual', `Assessed residual risk for ${risk.risk_number} as ${evaluation.levelLabel} (score ${evaluation.score})`, false);
    audit(req, { action: 'edit', entity: 'risks', entityId: req.params.id, newValue: { stage: 'residual', ...evaluation } });
    res.json({ ok: true, ...evaluation, nextStage: 'acceptance' });
  });

  // ---- step 6: risk acceptance -------------------------------------------

  router.post('/:id/accept', requirePermission('risks', 'approve'), (req, res) => {
    const db = getDb();
    const criteria = riskCriteria(db);
    if (!canAcceptRisk(db, req.user!.roleId, criteria)) {
      return res.status(403).json({ error: `Risk acceptance is restricted to: ${criteria.acceptanceRoles.join(', ')}.` });
    }
    const risk = loadRisk(db, req.params.id);
    if (!risk) return res.status(404).json({ error: 'Risk not found' });
    if (blockedForNoSignature(req, res)) return;
    const decision = req.body.decision === 'further_treatment' ? 'further_treatment' : 'accepted';
    if (decision === 'accepted' && criteria.requireResidualAssessment && risk.residual_score == null) {
      return res.status(400).json({ error: 'Record the residual risk before accepting it.' });
    }
    if (!req.body.justification) return res.status(400).json({ error: 'Record the justification for this decision.' });
    const acceptedBy = getStaffIdOrCurrent(req, req.body.acceptedByStaffId);
    if (acceptedBy === null) return res.status(400).json({ error: 'This action requires the logged-in user to be linked to a staff record.' });

    if (decision === 'further_treatment') {
      advance(db, req.params.id, 'treatment', {
        acceptance_decision: 'further_treatment',
        acceptance_justification: req.body.justification,
        status: 'mitigation_in_progress',
      });
      sign(req, req.params.id, 'risk_acceptance', `Returned ${risk.risk_number} for further treatment`, true);
      audit(req, { action: 'approve', entity: 'risks', entityId: req.params.id, newValue: { decision } });
      return res.json({ ok: true, decision, nextStage: 'treatment' });
    }

    // How far a risk is carried follows its size. A band the laboratory has set
    // no review cycle for is closed once it has been accepted — it stays in the
    // register as a closed record and is reopened if anything changes — while
    // the rest go on to be reviewed on their own cycle.
    const level = risk.residual_level || risk.risk_level;
    const closes = closesOnAcceptance(criteria, level) && !req.body.reviewDueDate;
    const reviewDue = req.body.reviewDueDate ?? nextReviewDate(criteria, level);
    const now = new Date().toISOString();
    advance(db, req.params.id, closes ? 'closed' : 'monitoring', {
      acceptance_decision: 'accepted',
      acceptance_justification: req.body.justification,
      accepted_by_staff_id: acceptedBy,
      accepted_at: now,
      review_due_date: closes ? null : reviewDue,
      status: closes ? 'closed' : 'active',
      ...(closes ? { closed_at: now, closed_by_staff_id: acceptedBy, closure_notes: req.body.justification } : {}),
    });
    sign(req, req.params.id, 'risk_acceptance', `Accepted the residual risk of ${risk.risk_number}`, true);
    audit(req, { action: 'approve', entity: 'risks', entityId: req.params.id, newValue: { decision, reviewDue, closed: closes } });
    res.json({
      ok: true, decision, nextStage: closes ? 'closed' : 'monitoring',
      reviewDueDate: closes ? null : reviewDue, closed: closes,
    });
  });

  // ---- step 7: monitoring & review ---------------------------------------

  router.post('/:id/review', requirePermission('risks', 'approve'), (req, res) => {
    const db = getDb();
    const criteria = riskCriteria(db);
    const risk = loadRisk(db, req.params.id);
    if (!risk) return res.status(404).json({ error: 'Risk not found' });
    if (!req.body.reviewNotes) return res.status(400).json({ error: 'Record the review notes.' });
    if (blockedForNoSignature(req, res)) return;
    const reviewedBy = getStaffIdOrCurrent(req, req.body.reviewedByStaffId);
    if (reviewedBy === null) return res.status(400).json({ error: 'This action requires the logged-in user to be linked to a staff record.' });

    const outcome = ['unchanged', 'reassess', 'close'].includes(req.body.outcome) ? req.body.outcome : 'unchanged';
    const level = risk.residual_level || risk.risk_level;
    const nextDue = outcome === 'close' ? null : (req.body.nextReviewDate || nextReviewDate(criteria, level));
    const reviewDate = req.body.reviewDate ?? new Date().toISOString().slice(0, 10);

    const result = db.prepare(`INSERT INTO risk_reviews
      (risk_id, review_date, review_notes, risk_score, risk_level, residual_score, residual_level, outcome, next_review_date, reviewed_by_staff_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(req.params.id, reviewDate, req.body.reviewNotes, risk.risk_score, risk.risk_level,
        risk.residual_score, risk.residual_level, outcome, nextDue, reviewedBy, new Date().toISOString());

    if (outcome === 'reassess') {
      // Something changed — the risk goes back through analysis on the matrix.
      advance(db, req.params.id, 'analysis', { last_review_date: reviewDate, review_due_date: nextDue, status: 'review_due' });
    } else if (outcome === 'close') {
      advance(db, req.params.id, 'closed', {
        last_review_date: reviewDate, review_due_date: null, status: 'closed',
        closure_notes: req.body.reviewNotes, closed_by_staff_id: reviewedBy, closed_at: new Date().toISOString(),
      });
    } else {
      advance(db, req.params.id, 'monitoring', { last_review_date: reviewDate, review_due_date: nextDue, status: 'active' });
    }
    sign(req, req.params.id, 'risk_review', `Reviewed ${risk.risk_number} — outcome: ${outcome.replace(/_/g, ' ')}`, true);
    audit(req, { action: 'approve', entity: 'risk_reviews', entityId: result.lastInsertRowid, newValue: { riskId: req.params.id, outcome, nextDue } });
    res.status(201).json({ id: Number(result.lastInsertRowid), outcome, nextReviewDate: nextDue, nextStage: outcome === 'reassess' ? 'analysis' : outcome === 'close' ? 'closed' : 'monitoring' });
  });

  // ---- linked records ----------------------------------------------------

  router.post('/:id/create-action', requirePermission('actions', 'create'), (req, res) => {
    const db = getDb();
    if (!req.body.title) return res.status(400).json({ error: 'An action title is required.' });
    const result = db.prepare(`INSERT INTO actions (title, module_key, source_module, source_record_id, description, assigned_to_staff_id, due_date, priority, status, evidence_required, completion_notes, created_by)
      VALUES (?, 'actions', 'risks', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(req.body.title, String(req.params.id), req.body.description ?? null,
        parseIntNullable(req.body.assignedToStaffId), req.body.dueDate ?? null, req.body.priority ?? 'normal',
        req.body.status ?? 'Not started', req.body.evidenceRequired ? 1 : 0, req.body.completionNotes ?? null, req.user!.id);
    const actionId = Number(result.lastInsertRowid);
    db.prepare(`INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes)
      VALUES ('risks', 'risks', ?, 'actions', 'actions', ?, 'Action linked from risk')`).run(String(req.params.id), String(actionId));
    audit(req, { action: 'create', entity: 'actions', entityId: actionId, newValue: { sourceModule: 'risks', sourceRecordId: req.params.id, ...req.body } });
    res.status(201).json({ id: actionId });
  });

  router.post('/:id/create-capa', requirePermission('nc_capa', 'create'), (req, res) => {
    const db = getDb();
    const risk = loadRisk(db, req.params.id);
    if (!risk) return res.status(404).json({ error: 'Risk not found' });
    const existing = db.prepare("SELECT id, capa_number FROM capa_records WHERE risk_id = ?").get(req.params.id) as any;
    if (existing) return res.status(200).json({ id: existing.id, capaNumber: existing.capa_number, existing: true });
    const createdAt = new Date().toISOString();
    const capaNumber = generateRecordNumber(db, 'capa_records', 'CAPA', createdAt);
    const result = db.prepare(`INSERT INTO capa_records
      (capa_number, source_module, source_record_id, risk_id, title, problem_summary, root_cause, corrective_action, preventive_action,
       responsible_staff_id, due_date, priority, status, effectiveness_required, effectiveness_status, created_by, created_at)
      VALUES (?, 'risks', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', 1, 'pending', ?, ?)`)
      .run(capaNumber, String(req.params.id), req.params.id,
        req.body.title ?? risk.risk_area, req.body.problemSummary ?? risk.risk_description, req.body.rootCause ?? risk.cause,
        req.body.correctiveAction ?? risk.mitigation_plan, req.body.preventiveAction ?? null,
        parseIntNullable(req.body.responsibleStaffId) ?? risk.treatment_owner_staff_id ?? risk.responsible_staff_id,
        req.body.dueDate ?? risk.treatment_due_date ?? null,
        risk.risk_level === 'very_high' || risk.risk_level === 'high' ? 'high' : 'normal',
        req.user!.id, createdAt);
    const capaId = Number(result.lastInsertRowid);
    db.prepare(`INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes)
      VALUES ('risks', 'risks', ?, 'nc_capa', 'capa_records', ?, 'CAPA created from risk')`).run(String(req.params.id), String(capaId));
    audit(req, { action: 'create', entity: 'capa_records', entityId: capaId, newValue: { capaNumber, riskId: req.params.id } });
    res.status(201).json({ id: capaId, capaNumber });
  });

  router.post('/:id/close', requirePermission('risks', 'void_archive'), (req, res) => {
    const db = getDb();
    const oldValue = loadRisk(db, req.params.id);
    if (!oldValue) return res.status(404).json({ error: 'Risk not found' });
    advance(db, req.params.id, 'closed', {
      status: 'closed', review_due_date: null,
      closure_notes: req.body.closureNotes ?? null,
      closed_by_staff_id: getStaffIdOrCurrent(req, req.body.closedByStaffId),
      closed_at: new Date().toISOString(),
    });
    audit(req, { action: 'void_archive', entity: 'risks', entityId: req.params.id, oldValue, newValue: { status: 'closed' } });
    res.json({ ok: true, nextStage: 'closed' });
  });

  router.post('/:id/reopen', requirePermission('risks', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = loadRisk(db, req.params.id);
    if (!oldValue) return res.status(404).json({ error: 'Risk not found' });
    advance(db, req.params.id, 'analysis', { status: 'active', closed_at: null, closed_by_staff_id: null });
    audit(req, { action: 'edit', entity: 'risks', entityId: req.params.id, oldValue, newValue: { reopened: true } });
    res.json({ ok: true, nextStage: 'analysis' });
  });

  /**
   * Permanent deletion — administrator only, and reasoned.
   *
   * A risk that was logged in error should not sit in the register for ever,
   * but removing a quality record is not something the permission matrix hands
   * out. It is reserved for the administrator, needs a reason, and the reason
   * and the record it removed are written to the audit trail before the row
   * goes.
   */
  router.delete('/:id', requireAdministrator('permanently delete a risk'), (req, res) => {
    const db = getDb();
    const risk = loadRisk(db, req.params.id);
    if (!risk) return res.status(404).json({ error: 'Risk not found' });
    const reason = requiredReason(req.body?.reason);
    if (!reason) return res.status(400).json({ error: 'Give a reason of at least 10 characters for deleting this risk.' });

    const id = Number(req.params.id);
    const removed = db.transaction(() => {
      db.prepare('DELETE FROM risk_controls WHERE risk_id = ?').run(id);
      db.prepare('DELETE FROM risk_reviews WHERE risk_id = ?').run(id);
      db.prepare("DELETE FROM e_signatures WHERE module_key = 'risks' AND record_type = 'risks' AND record_id = ?").run(String(id));
      db.prepare(`DELETE FROM record_links WHERE (source_module_key = 'risks' AND source_record_id = ?)
        OR (target_module_key = 'risks' AND target_record_id = ?)`).run(String(id), String(id));
      db.prepare("UPDATE actions SET source_module = NULL, source_record_id = NULL WHERE source_module = 'risks' AND source_record_id = ?").run(String(id));
      db.prepare('UPDATE capa_records SET risk_id = NULL WHERE risk_id = ?').run(id);
      db.prepare('DELETE FROM risks WHERE id = ?').run(id);
    });
    audit(req, { action: 'delete', entity: 'risks', entityId: req.params.id, oldValue: risk, newValue: { reason } });
    removed();
    res.json({ ok: true, riskNumber: risk.risk_number });
  });

  // ---- reporting ---------------------------------------------------------

  router.get('/register/export', requirePermission('risks', 'export'), (_req, res) => {
    const db = getDb();
    const criteria = riskCriteria(db);
    const label = (band: string | null) => criteria.bands.find(b => b.level === band)?.label ?? '';
    const rows = (db.prepare(`${SELECT_RISK} ORDER BY r.id DESC`).all() as any[]).map(r => ([
      r.risk_number, r.identified_date ?? '',
      r.identified_by_other ? `${r.identified_by_other} (external)` : (r.identified_by_name ?? ''),
      r.section_name ?? 'Laboratory-wide',
      r.risk_category === 'other' && r.risk_category_other ? r.risk_category_other : (r.risk_category ?? '').replace(/_/g, ' '),
      r.risk_source === 'other' && r.risk_source_other ? r.risk_source_other : (r.risk_source ?? '').replace(/_/g, ' '),
      r.risk_area ?? '', r.risk_description ?? '', r.cause ?? '', r.consequence ?? '',
      r.existing_controls ?? '', r.likelihood ?? '', r.severity ?? '', r.risk_score ?? '', label(r.risk_level),
      (r.treatment_option ?? '').replace(/_/g, ' '), r.mitigation_plan ?? '', r.treatment_owner_name ?? r.responsible_name ?? '', r.treatment_due_date ?? '',
      r.residual_likelihood ?? '', r.residual_severity ?? '', r.residual_score ?? '', label(r.residual_level),
      (r.acceptance_decision ?? '').replace(/_/g, ' '), r.accepted_by_name ?? '', r.review_due_date ?? '',
      (r.workflow_stage ?? '').replace(/_/g, ' '), r.status ?? '',
    ]));
    sendWorkbook(res, buildWorkbook(RISK_HEADERS, rows, 'RISK REGISTER'), 'Risk_Register.xlsx');
  });

  router.get('/register/print', requirePermission('risks', 'print'), (req, res) => {
    const db = getDb();
    const criteria = riskCriteria(db);
    const rows = db.prepare(`${SELECT_RISK} WHERE r.status != 'closed' ORDER BY COALESCE(r.residual_score, r.risk_score) DESC, r.id DESC`).all() as any[];
    const colourFor = (level: string | null) => criteria.bands.find(b => b.level === level)?.color ?? '#999';
    const labelFor = (level: string | null) => criteria.bands.find(b => b.level === level)?.label ?? '—';
    const body = rows.map(r => `<tr>
      <td>${escHtml(r.risk_number)}</td><td>${escHtml(r.section_name || 'Laboratory-wide')}</td>
      <td>${escHtml(r.risk_area)}<div class="sm">${escHtml(r.risk_description)}</div></td>
      <td class="c">${escHtml(r.risk_score)}<br/><span style="color:${colourFor(r.risk_level)};font-weight:bold">${escHtml(labelFor(r.risk_level))}</span></td>
      <td>${escHtml(r.mitigation_plan)}</td>
      <td class="c">${r.residual_score ?? '—'}<br/><span style="color:${colourFor(r.residual_level)};font-weight:bold">${r.residual_level ? escHtml(labelFor(r.residual_level)) : ''}</span></td>
      <td>${escHtml(r.treatment_owner_name || r.responsible_name || '')}</td>
      <td class="c">${escHtml(r.review_due_date)}</td>
      <td class="c">${escHtml(String(r.workflow_stage || '').replace(/_/g, ' '))}</td>
    </tr>`).join('');
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>Risk Register</title>
<style>@page{size:A4 landscape;margin:10mm}*{box-sizing:border-box}html,body{-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{font-family:'Times New Roman',Georgia,serif;color:#111;font-size:11px;padding:4px 8px}
h1{text-align:center;font-size:16px;margin:6px 0}
table{border-collapse:collapse;width:100%}th,td{border:1px solid #888;padding:4px 5px;vertical-align:top}
th{background:#eef2f7;font-size:10px}.c{text-align:center}.sm{font-size:9px;color:#444}
.no-print{background:#f4f6fb;padding:6px;border:1px solid #ccd;border-radius:6px;margin-bottom:8px}@media print{.no-print{display:none}body{padding:0}}
</style><script>window.addEventListener("load",()=>{setTimeout(()=>window.print(),300)})</script></head><body>
<div class="no-print">The print dialog opens automatically — choose any printer or Save as PDF. <button onclick="window.print()">Print</button></div>
<h1>${escHtml(facilityName(db))} — Risk Register</h1>
<table><thead><tr><th>Risk No.</th><th>Unit / Section</th><th>Risk</th><th>Initial</th><th>Control plan</th><th>Residual</th><th>Responsible person</th><th>Review due</th><th>Step</th></tr></thead>
<tbody>${body || '<tr><td colspan="9" class="c">No open risks.</td></tr>'}</tbody></table>
<div class="sm" style="margin-top:12px;border-top:1px solid #ccc;padding-top:5px">${escHtml(facilityName(db))} · ${rows.length} open risk(s) · Generated ${new Date().toISOString().slice(0, 19).replace('T', ' ')}</div>
</body></html>`;
    audit(req, { action: 'print', entity: 'risks', entityId: null });
    res.send(html);
  });

  /**
   * The risk assessment report.
   *
   * A record of what was actually done, and only that. A field with nothing in
   * it, a stage the risk never went through, a signature block for work that
   * never happened — each one reads on a printed report as something left
   * undone, so none of them is drawn. A risk accepted as tolerable without
   * control measures prints no control section and no control signature; one
   * still in assessment prints no acceptance.
   */
  router.get('/:id/print', requirePermission('risks', 'print'), (req, res) => {
    const db = getDb();
    const criteria = riskCriteria(db);
    const r = loadRisk(db, req.params.id);
    if (!r) return res.status(404).send('Not found');
    const controls = db.prepare(`SELECT c.*, st.full_name AS responsible_name FROM risk_controls c
      LEFT JOIN staff st ON st.id = c.responsible_staff_id WHERE c.risk_id = ? ORDER BY c.id`).all(req.params.id) as any[];
    const reviews = db.prepare(`SELECT rv.*, st.full_name AS reviewed_by_name FROM risk_reviews rv
      LEFT JOIN staff st ON st.id = rv.reviewed_by_staff_id WHERE rv.risk_id = ? ORDER BY rv.review_date DESC`).all(req.params.id) as any[];
    const capa = db.prepare('SELECT capa_number FROM capa_records WHERE risk_id = ?').get(req.params.id) as any;
    const actions = db.prepare(`SELECT a.title, a.due_date, a.status, st.full_name AS assigned_name FROM actions a
      LEFT JOIN staff st ON st.id = a.assigned_to_staff_id WHERE a.source_module = 'risks' AND a.source_record_id = ? ORDER BY a.id`)
      .all(String(req.params.id)) as any[];
    const signatures = signaturesFor('risks', 'risks', req.params.id) as any[];

    const has = (v: unknown) => v !== null && v !== undefined && String(v).trim() !== '' && String(v) !== '—';
    const bandOf = (score: number | null | undefined) => score == null ? null : bandForScore(criteria, score);
    const labelled = (v: unknown) => escHtml(String(v ?? '').replace(/_/g, ' '));
    /** A field, drawn only when it has something to say. */
    const line = (label: string, val: unknown) => has(val)
      ? `<div class="fld"><span class="lb">${label}</span><span class="vl">${escHtml(val)}</span></div>` : '';
    const box = (label: string, val: unknown) => has(val)
      ? `<div class="sec-item"><div class="lb">${label}</div><div class="box">${escHtml(val)}</div></div>` : '';
    const chip = (score: number | null | undefined, level: string | null | undefined) => {
      const band = criteria.bands.find(b => b.level === level) ?? bandOf(score);
      if (score == null || !band) return '';
      return `<span class="chip" style="background:${band.color}">${score} — ${escHtml(band.label)}</span>`;
    };
    const identifiedBy = r.identified_by_other
      ? `${r.identified_by_other} (external)` : r.identified_by_name;
    const category = r.risk_category === 'other' && r.risk_category_other
      ? r.risk_category_other : String(r.risk_category || '').replace(/_/g, ' ');
    const source = r.risk_source === 'other' && r.risk_source_other
      ? r.risk_source_other : String(r.risk_source || '').replace(/_/g, ' ');

    // Which parts of the lifecycle this risk actually went through.
    const assessed = r.risk_score != null;
    const controlled = has(r.treatment_option) || has(r.mitigation_plan) || controls.length > 0;
    const residualSeparately = r.residual_score != null && has(r.residual_assessed_at);
    const accepted = has(r.acceptance_decision);
    const monitored = reviews.length > 0 || has(r.review_due_date) || has(r.last_review_date);
    const linked = !!capa || actions.length > 0;

    const matrix = criteria.likelihood.slice().reverse().map(l => `<tr><td class="hd">${l.score}. <b>${escHtml(l.label)}</b><div class="sm">${escHtml(l.description)}</div></td>${criteria.severity.map(sv => {
      const sc = l.score * sv.score; const band = bandForScore(criteria, sc)!;
      const initial = r.likelihood === l.score && r.severity === sv.score;
      const residual = r.residual_likelihood === l.score && r.residual_severity === sv.score;
      const mark = initial && residual ? ' I·R' : initial ? ' I' : residual ? ' R' : '';
      return `<td style="background:${band.color}${mark ? '' : '22'};color:${mark ? '#fff' : '#111'}${mark ? ';outline:3px solid #111;outline-offset:-3px;font-weight:bold' : ''}">${sc}<div class="sm" style="color:inherit">${escHtml(band.label)}${mark}</div></td>`;
    }).join('')}</tr>`).join('');

    // An authorisation block is drawn for a stage that happened, and carries the
    // signature that was actually applied. A stage nobody has reached yet has
    // no block, so the report never shows an empty line waiting to be signed.
    const sigFor = (purpose: string) => signatures.filter(x => x.purpose === purpose).slice(-1)[0] ?? null;
    const authBlock = (title: string, purpose: string, fallbackName: unknown, fallbackDate: unknown) => {
      const sg = sigFor(purpose);
      const name = sg?.signer_name || fallbackName || '';
      if (!sg && !has(name)) return '';
      const img = sg ? signatureImageDataUri(sg) : null;
      const when = sg?.signed_at || fallbackDate || '';
      return `<div class="auth">
        <div class="auth-role">${escHtml(title)}</div>
        <div class="auth-sig">${img ? `<img src="${img}" alt=""/>` : ''}</div>
        <div class="auth-line"></div>
        <div class="auth-name">${escHtml(name)}</div>
        <div class="sm">${when ? escHtml(String(when).slice(0, 19).replace('T', ' ')) : 'Signature / Date'}</div>
      </div>`;
    };
    const auths = [
      authBlock('Identified by', 'risk_identification', identifiedBy, r.identified_date),
      assessed ? authBlock('Risk assessment and evaluation', 'risk_analysis', '', r.analysed_at) : '',
      controlled ? authBlock('Control measures implemented and verified', 'risk_treatment_complete', r.treatment_owner_name, r.treatment_completed_at) : '',
      residualSeparately ? authBlock('Residual risk assessed', 'risk_residual', '', r.residual_assessed_at) : '',
      accepted ? authBlock('Residual risk accepted (authorising officer)', 'risk_acceptance', r.accepted_by_name, r.accepted_at) : '',
      reviews.length ? authBlock('Reviewed by', 'risk_review', reviews[0]?.reviewed_by_name, reviews[0]?.review_date) : '',
    ].filter(Boolean);

    let n = 0;
    const heading = (t: string) => `<h2>${++n}. ${t}</h2>`;

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>${escHtml(r.risk_number)} — Risk Assessment Report</title>
<style>@page{size:A4 portrait;margin:12mm}*{box-sizing:border-box}html,body{-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{font-family:'Times New Roman',Georgia,serif;color:#111;font-size:12px;line-height:1.45;padding:4px 8px}
h1{text-align:center;font-size:17px;margin:10px 0 2px}
.subtitle{text-align:center;font-size:11px;color:#444;margin-bottom:8px}
h2{font-size:12.5px;background:#eee;border:1px solid #999;padding:3px 6px;margin:13px 0 6px}
.hdr{display:grid;grid-template-columns:1fr 1fr;gap:2px 20px;border:1px solid #999;padding:6px 8px;margin-top:6px}
.fld{display:flex;gap:6px;padding:1px 0}.fld .lb{font-weight:bold;min-width:132px}.fld .vl{border-bottom:1px dotted #999;flex:1}
.sec-item{margin:6px 0}.sec-item .lb{font-weight:bold;margin-bottom:2px}.sec-item .box{border:1px solid #999;min-height:26px;padding:4px 6px;white-space:pre-wrap}
table{border-collapse:collapse;width:100%;font-size:10px;margin:4px 0}table td,table th{border:1px solid #777;padding:3px 4px;text-align:center;vertical-align:middle}
th{background:#eef2f7}td.l,th.l{text-align:left}
table.mx .hd{text-align:left;width:19%}
.sm{font-size:8.5px;color:#333;font-weight:normal}
.chip{display:inline-block;color:#fff;font-weight:bold;padding:2px 10px;border-radius:4px}
.scores{display:flex;gap:26px;align-items:center;margin:8px 0;flex-wrap:wrap}
.auths{display:grid;grid-template-columns:repeat(2,1fr);gap:14px 26px;margin-top:10px}
.auth{page-break-inside:avoid}.auth-role{font-weight:bold;font-size:11px}
.auth-sig{height:40px;display:flex;align-items:flex-end}.auth-sig img{max-height:40px;max-width:190px}
.auth-line{border-top:1px solid #111;margin-top:2px}.auth-name{font-size:11px}
.legend{display:flex;gap:14px;flex-wrap:wrap;font-size:9px;margin:2px 0 6px}
.legend span{display:inline-flex;align-items:center;gap:4px}.legend i{width:11px;height:11px;display:inline-block;border:1px solid #666}
.mast{display:flex;align-items:center;gap:12px;border-bottom:2px solid #111;padding-bottom:6px}.mast img{height:52px}.mast .org{font-weight:bold;font-size:15px}.mast .sub{font-size:10px;color:#444}
.no-print{background:#f4f6fb;padding:6px;border:1px solid #ccd;border-radius:6px;margin-bottom:8px}@media print{.no-print{display:none}body{padding:0}}
</style><script>window.addEventListener("load",()=>{setTimeout(()=>window.print(),300)})</script></head><body>
<div class="no-print">The print dialog opens automatically — choose any printer or Save as PDF. <button onclick="window.print()">Print</button></div>
${labMasthead(db)}
<h1>Risk Assessment Report</h1>
<div class="subtitle">${escHtml(r.risk_number)} · ${labelled(r.workflow_stage)} · ${labelled(r.status)}</div>
<div class="hdr">
  <div>${line('Risk Number:', r.risk_number)}${line('Date Identified:', r.identified_date)}${line('Identified by:', identifiedBy)}${line('Source of Risk:', source)}</div>
  <div>${line('Unit / Section:', r.section_name || 'Laboratory-wide')}${line('Risk Category:', category)}${line('Process Affected:', r.process_affected)}${line('Responsible Person:', r.responsible_name)}</div>
</div>

${heading('Risk Identification')}
${line('Risk area:', r.risk_area)}
<div>Affects patient or staff safety: <b>${r.affects_patient_safety ? 'Yes' : 'No'}</b></div>
${box('Description of the risk:', r.risk_description)}
${box('Cause / source:', r.cause)}
${box('Potential consequence:', r.consequence)}
${box('Existing controls at the time of identification:', r.existing_controls)}

${assessed ? `${heading('Risk Assessment and Evaluation')}
<table class="mx"><thead><tr><th class="hd">Likelihood ↓ / Severity →</th>${criteria.severity.map(sv => `<th>${sv.score}. ${escHtml(sv.label)}<div class="sm">${escHtml(sv.description)}</div></th>`).join('')}</tr></thead><tbody>${matrix}</tbody></table>
<div class="legend"><span><b>I</b> = initial risk</span>${r.residual_score != null ? '<span><b>R</b> = residual risk</span>' : ''}${criteria.bands.map(b => `<span><i style="background:${b.color}"></i>${escHtml(b.label)} (${b.min}–${b.max})</span>`).join('')}</div>
<div class="scores">
  <span>Initial risk (Likelihood × Severity): ${chip(r.risk_score, r.risk_level)}</span>
  ${has(r.evaluation_decision) ? `<span>Evaluation outcome: <b>${r.evaluation_decision === 'treat' ? 'Control required' : 'Tolerable — retain'}</b></span>` : ''}
</div>
${has(bandOf(r.risk_score)?.action) ? `<div class="sm">${escHtml(bandOf(r.risk_score)!.action)}</div>` : ''}
${box('Assessment notes:', r.analysis_notes)}` : ''}

${controlled ? `${heading('Risk Control')}
${line('Control option:', String(r.treatment_option || '').replace(/_/g, ' '))}${line('Responsible person:', r.treatment_owner_name)}${line('Target completion:', r.treatment_due_date)}${line('Completed:', r.treatment_completed_at ? String(r.treatment_completed_at).slice(0, 10) : '')}
${box('Control plan:', r.mitigation_plan)}
${controls.length ? (() => {
  // A column no control has anything to put in is a column of blanks, so it is
  // not drawn at all.
  const cols: Array<[string, (c: any) => string, boolean]> = [
    ['Control measure', c => escHtml(c.control_description), true],
    ['Control type', c => labelled(c.control_type), controls.some(c => has(c.control_type))],
    ['Responsible person', c => escHtml(c.responsible_name || ''), controls.some(c => has(c.responsible_name))],
    ['Target date', c => escHtml(c.target_date || ''), controls.some(c => has(c.target_date))],
    ['Status', c => labelled(c.status), true],
    ['Completed', c => escHtml(c.completed_date || ''), controls.some(c => has(c.completed_date))],
    ['Verification', c => escHtml(c.verification_notes || ''), controls.some(c => has(c.verification_notes))],
  ];
  const shown = cols.filter(([, , keep]) => keep);
  const wide = (h: string) => h === 'Control measure' || h === 'Verification' ? ' class="l"' : '';
  return `<table><thead><tr>${shown.map(([h]) => `<th${wide(h)}>${h}</th>`).join('')}</tr></thead><tbody>
${controls.map(c => `<tr>${shown.map(([h, cell]) => `<td${wide(h)}>${cell(c)}</td>`).join('')}</tr>`).join('')}
</tbody></table>`;
})() : ''}
${box('Control notes:', r.treatment_notes)}` : ''}

${accepted || r.residual_score != null ? `${heading('Residual Risk and Acceptability')}
<div class="scores">
  ${controlled ? `<span>Initial risk: ${chip(r.risk_score, r.risk_level)}</span>` : ''}
  <span>Residual risk: ${chip(r.residual_score, r.residual_level)}</span>
  ${has(r.acceptance_decision) ? `<span>Decision: <b>${labelled(r.acceptance_decision)}</b></span>` : ''}
</div>
${residualSeparately ? line('Residual risk assessed:', String(r.residual_assessed_at).slice(0, 10)) : ''}
${box('Justification for the decision:', r.acceptance_justification)}` : ''}

${monitored ? `${heading('Monitoring and Review')}
${line('Last review:', r.last_review_date)}${line('Next review due:', r.review_due_date)}
${reviews.length ? `<table><thead><tr><th>Date</th><th>Outcome</th><th>Risk score</th><th>Reviewed by</th><th class="l">Review notes</th><th>Next review</th></tr></thead><tbody>
${reviews.map(v => `<tr><td>${escHtml(v.review_date)}</td><td>${labelled(v.outcome)}</td><td>${v.residual_score ?? v.risk_score ?? ''}</td><td>${escHtml(v.reviewed_by_name || '')}</td><td class="l">${escHtml(v.review_notes || '')}</td><td>${escHtml(v.next_review_date || '')}</td></tr>`).join('')}
</tbody></table>` : ''}` : ''}

${has(r.closure_notes) || has(r.closed_at) ? `${heading('Closure')}
${line('Closed on:', r.closed_at ? String(r.closed_at).slice(0, 10) : '')}
${box('Closure notes:', r.closure_notes)}` : ''}

${linked ? `${heading('Linked Records')}
<table><thead><tr><th class="l">Record</th><th class="l">Detail</th><th>Due</th><th>Status</th></tr></thead><tbody>
${capa ? `<tr><td class="l">CAPA ${escHtml(capa.capa_number)}</td><td class="l">Corrective / preventive action raised from this risk</td><td></td><td></td></tr>` : ''}
${actions.map(a => `<tr><td class="l">Action</td><td class="l">${escHtml(a.title)}${a.assigned_name ? ` — ${escHtml(a.assigned_name)}` : ''}</td><td>${escHtml(a.due_date || '')}</td><td>${escHtml(a.status || '')}</td></tr>`).join('')}
</tbody></table>` : ''}

${auths.length ? `${heading('Authorisations')}
<div class="auths">${auths.join('')}</div>` : ''}

<div class="sm" style="margin-top:16px;border-top:1px solid #ccc;padding-top:5px">${escHtml(facilityName(db))} · Risk record ${escHtml(r.risk_number)} · Generated ${new Date().toISOString().slice(0, 19).replace('T', ' ')}</div>
</body></html>`;
    audit(req, { action: 'print', entity: 'risks', entityId: req.params.id });
    res.send(html);
  });

  return router;
}

export type { RiskCriteria };
