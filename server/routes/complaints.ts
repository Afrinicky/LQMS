import { Router, type Request } from 'express';
import { getDb } from '../db/database.js';
import { requirePermission } from '../middleware/permissions.js';
import { audit } from '../services/auditService.js';
import { generateRecordNumber } from '../utils/recordNumber.js';
import { parseIntNullable, getStaffIdOrCurrent } from './routeHelpers.js';
import {
  COMPLAINT_SEVERITIES, COMPLAINT_OUTCOMES, addDays, normaliseTargets,
  DEFAULT_COMPLAINT_TARGETS, type ComplaintTargets,
} from '../../shared/constants/complaints.js';


const TARGETS_KEY = 'complaints.targets';

/** The laboratory's own acknowledgement and resolution targets, in days. */
function getTargets(): ComplaintTargets {
  try {
    const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(TARGETS_KEY) as { value: string } | undefined;
    return row ? normaliseTargets(JSON.parse(row.value)) : { ...DEFAULT_COMPLAINT_TARGETS };
  } catch { return { ...DEFAULT_COMPLAINT_TARGETS }; }
}

/**
 * Write down that something happened, in a row of its own.
 *
 * §7.4 wants the record of "the actions taken" on a complaint. A column that
 * the next action overwrites is not that record, so every step lands here as
 * well as on the complaint itself.
 */
function logEvent(req: Request, complaintId: number | string, type: string, fromStage: string | null, toStage: string | null, note?: string | null) {
  try {
    getDb().prepare(`INSERT INTO complaint_events (complaint_id, event_type, from_stage, to_stage, note, actor_staff_id, actor_user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(complaintId, type, fromStage, toStage, note ?? null, getStaffIdOrCurrent(req, null), req.user!.id);
  } catch { /* the record of the act matters more than the record of the record */ }
}

/** The complaint, or a 404 already sent. */
function load(req: Request, res: import('express').Response): any | null {
  const row = getDb().prepare('SELECT * FROM complaints WHERE id = ?').get(req.params.id) as any;
  if (!row) { res.status(404).json({ error: 'Complaint not found' }); return null; }
  return row;
}

export function complaintsRoutes() {
  const router = Router();
  router.get('/', requirePermission('complaints', 'view'), (_req, res) => {
    const db = getDb();
    res.json(db.prepare('SELECT * FROM complaints ORDER BY received_date DESC, id DESC').all());
  });

  // Receiving a complaint. The record starts at `received` and immediately owes
  // an acknowledgement, dated from the laboratory's own target — an assessor
  // asks whether you meet the target your documented process states, so the
  // target is configurable and the due date is stored, not computed on display.
  router.post('/', requirePermission('complaints', 'create'), (req, res) => {
    const requiredFields = ['title', 'description', 'receivedDate', 'complainantType', 'category'];
    for (const field of requiredFields) {
      if (!req.body[field]) return res.status(400).json({ error: `${field} is required` });
    }
    const severity = COMPLAINT_SEVERITIES.includes(req.body.severity) ? req.body.severity : 'moderate';
    const db = getDb();
    const createdAt = new Date().toISOString();
    const receivedDate = String(req.body.receivedDate ?? createdAt).slice(0, 10);
    const complaintNumber = generateRecordNumber(db, 'complaints', 'COMP', createdAt);
    const targets = getTargets();

    const cols: Record<string, unknown> = {
      complaint_number: complaintNumber,
      received_date: receivedDate,
      source: req.body.source ?? null,
      complainant_type: req.body.complainantType,
      complainant_name: req.body.complainantName ?? null,
      contact: req.body.contact ?? null,
      department_id: parseIntNullable(req.body.departmentId),
      section_id: parseIntNullable(req.body.sectionId),
      category: req.body.category,
      title: req.body.title,
      description: req.body.description,
      severity,
      patient_affected: req.body.patientAffected ? 1 : 0,
      assigned_to_staff_id: parseIntNullable(req.body.assignedToStaffId),
      acknowledgement_status: 'pending',
      acknowledgement_due_date: addDays(receivedDate, targets.acknowledgeDays),
      resolution_due_date: addDays(receivedDate, targets.resolveDays),
      capa_required: req.body.capaRequired ? 1 : 0,
      stage: 'received',
      status: 'new',
      created_by: req.user!.id,
      created_at: createdAt,
    };
    const keys = Object.keys(cols);
    const result = db.prepare(`INSERT INTO complaints (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`)
      .run(...keys.map(k => cols[k]));
    const id = Number(result.lastInsertRowid);
    logEvent(req, id, 'received', null, 'received', `Received from ${req.body.complainantType}${req.body.source ? ` via ${req.body.source}` : ''}`);
    audit(req, { action: 'create', entity: 'complaints', entityId: id, newValue: { complaintNumber, ...req.body } });
    res.status(201).json({ id, complaintNumber, acknowledgementDueDate: cols.acknowledgement_due_date, resolutionDueDate: cols.resolution_due_date });
  });

  // ---- The laboratory's targets, which the process document states ----------
  router.get('/config/targets', requirePermission('complaints', 'view'), (_req, res) => res.json(getTargets()));
  router.put('/config/targets', requirePermission('complaints', 'edit'), (req, res) => {
    const targets = normaliseTargets(req.body);
    getDb().prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(TARGETS_KEY, JSON.stringify(targets));
    audit(req, { action: 'edit', entity: 'settings', entityId: TARGETS_KEY, newValue: targets });
    res.json(targets);
  });

  router.get('/:id', requirePermission('complaints', 'view'), (req, res) => {
    const db = getDb();
    const item = db.prepare('SELECT * FROM complaints WHERE id = ?').get(req.params.id) as any;
    if (!item) return res.status(404).json({ error: 'Complaint not found' });
    const links = db.prepare('SELECT * FROM record_links WHERE (source_record_type = ? AND source_record_id = ?) OR (target_record_type = ? AND target_record_id = ?)').all('complaints', String(req.params.id), 'complaints', String(req.params.id));
    // The trail of what was actually done, oldest first — this is the record
    // §7.4 asks for, and it is what an assessor reads.
    const events = db.prepare(`SELECT e.*, s.full_name AS actor_name, u.username AS actor_username
      FROM complaint_events e LEFT JOIN staff s ON s.id = e.actor_staff_id LEFT JOIN users u ON u.id = e.actor_user_id
      WHERE e.complaint_id = ? ORDER BY e.id`).all(req.params.id);
    res.json({ ...item, links, events, targets: getTargets() });
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

  // ---- Acknowledge receipt (§7.4: "acknowledgement of receipt") -------------
  //
  // The first thing the laboratory owes the complainant, and the first thing an
  // assessor looks for. Recorded as an act with a date, a person and the way it
  // was done, not as a status somebody set.
  router.post('/:id/acknowledge', requirePermission('complaints', 'edit'), (req, res) => {
    const db = getDb();
    const c = load(req, res); if (!c) return;
    if (c.acknowledged_at) return res.status(400).json({ error: 'This complaint was already acknowledged.' });
    const method = String(req.body?.method ?? '').trim();
    if (!method) return res.status(400).json({ error: 'Record how the complainant was told — in person, by telephone, by email, and so on.' });
    const by = getStaffIdOrCurrent(req, req.body?.acknowledgedByStaffId);
    db.prepare(`UPDATE complaints SET acknowledged_at = CURRENT_TIMESTAMP, acknowledged_by_staff_id = ?, acknowledgement_method = ?,
      acknowledgement_note = ?, acknowledgement_status = 'acknowledged', stage = CASE WHEN stage = 'received' THEN 'acknowledged' ELSE stage END,
      status = CASE WHEN status = 'new' THEN 'received' ELSE status END, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(by, method, req.body?.note ?? null, c.id);
    logEvent(req, c.id, 'acknowledged', c.stage, 'acknowledged', `Acknowledged to the complainant by ${method}`);
    audit(req, { action: 'edit', entity: 'complaints', entityId: c.id, oldValue: { acknowledged: false }, newValue: { method, note: req.body?.note ?? null } });
    res.json({ ok: true });
  });

  // ---- Independent review (§7.4: decided by people not involved) ------------
  //
  // The requirement that most often has nowhere to live in software: whoever
  // reviews the decision must not be the person who did the work complained
  // about, nor the one who investigated it. The system refuses the shortcut,
  // because a rule nobody can break is worth more than a field nobody fills.
  router.post('/:id/review', requirePermission('complaints', 'approve'), (req, res) => {
    const db = getDb();
    const c = load(req, res); if (!c) return;
    if (!c.investigation_summary || !String(c.investigation_summary).trim()) {
      return res.status(400).json({ error: 'There is nothing to review yet — record the investigation findings first.' });
    }
    const outcome = String(req.body?.outcome ?? '');
    if (!COMPLAINT_OUTCOMES.includes(outcome as never)) {
      return res.status(400).json({ error: `A decision is required: ${COMPLAINT_OUTCOMES.join(', ')}.` });
    }
    const reviewer = getStaffIdOrCurrent(req, req.body?.reviewedByStaffId);
    if (reviewer === null) return res.status(400).json({ error: 'The reviewer must be linked to a staff record.' });
    if (c.assigned_to_staff_id && Number(reviewer) === Number(c.assigned_to_staff_id)) {
      return res.status(400).json({ error: 'The complaint cannot be reviewed by the person who investigated it. ISO 15189 §7.4 requires the decision to be made or reviewed by someone not involved in the activity complained about.' });
    }
    if (c.investigated_by_staff_id && Number(reviewer) === Number(c.investigated_by_staff_id)) {
      return res.status(400).json({ error: 'The complaint cannot be reviewed by the person who investigated it. Ask a colleague who was not involved.' });
    }
    db.prepare(`UPDATE complaints SET reviewed_by_staff_id = ?, reviewed_at = CURRENT_TIMESTAMP, review_notes = ?, outcome = ?,
      stage = 'outcome_pending', status = 'action_required', updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(reviewer, req.body?.notes ?? null, outcome, c.id);
    logEvent(req, c.id, 'reviewed', c.stage, 'outcome_pending', `Independent review — ${outcome.replace(/_/g, ' ')}`);
    audit(req, { action: 'approve', entity: 'complaints', entityId: c.id, newValue: { outcome, reviewer } });
    res.json({ ok: true, outcome });
  });

  // ---- Tell the complainant (§7.4: formal notice that handling has ended) ---
  router.post('/:id/communicate-outcome', requirePermission('complaints', 'edit'), (req, res) => {
    const db = getDb();
    const c = load(req, res); if (!c) return;
    if (!c.reviewed_at) return res.status(400).json({ error: 'The outcome has not been reviewed yet, so there is nothing settled to tell the complainant.' });
    const method = String(req.body?.method ?? '').trim();
    const summary = String(req.body?.summary ?? '').trim();
    if (!method) return res.status(400).json({ error: 'Record how the complainant was told.' });
    if (!summary) return res.status(400).json({ error: 'Record what the complainant was told.' });
    db.prepare(`UPDATE complaints SET outcome_communicated_at = CURRENT_TIMESTAMP, outcome_communicated_by_staff_id = ?,
      outcome_method = ?, outcome_summary = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(getStaffIdOrCurrent(req, req.body?.communicatedByStaffId), method, summary, c.id);
    logEvent(req, c.id, 'outcome_communicated', c.stage, c.stage, `Outcome given to the complainant by ${method}`);
    audit(req, { action: 'edit', entity: 'complaints', entityId: c.id, newValue: { method, summary } });
    res.json({ ok: true });
  });

  // ---- Withdrawn by the complainant ----------------------------------------
  router.post('/:id/withdraw', requirePermission('complaints', 'edit'), (req, res) => {
    const db = getDb();
    const c = load(req, res); if (!c) return;
    const reason = String(req.body?.reason ?? '').trim();
    if (!reason) return res.status(400).json({ error: 'Record why the complaint was withdrawn.' });
    db.prepare(`UPDATE complaints SET stage = 'withdrawn', status = 'closed', outcome = 'withdrawn', closure_summary = ?,
      closed_by_staff_id = ?, closed_by_user_id = ?, closed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(reason, getStaffIdOrCurrent(req, null), req.user!.id, c.id);
    logEvent(req, c.id, 'withdrawn', c.stage, 'withdrawn', reason);
    audit(req, { action: 'edit', entity: 'complaints', entityId: c.id, newValue: { withdrawn: true, reason } });
    res.json({ ok: true });
  });

  // ---- Hand it to somebody to investigate -----------------------------------
  router.post('/:id/assign', requirePermission('complaints', 'edit'), (req, res) => {
    const db = getDb();
    const c = load(req, res); if (!c) return;
    const assignee = parseIntNullable(req.body.assignedToStaffId);
    if (!assignee) return res.status(400).json({ error: 'Choose who will investigate this complaint.' });
    const name = (db.prepare('SELECT full_name FROM staff WHERE id = ?').get(assignee) as { full_name: string } | undefined)?.full_name ?? `staff #${assignee}`;
    db.prepare(`UPDATE complaints SET assigned_to_staff_id = ?, acknowledgement_status = ?,
      stage = CASE WHEN stage IN ('received', 'acknowledged') THEN 'under_investigation' ELSE stage END,
      status = CASE WHEN status IN ('new', 'received') THEN 'assigned' ELSE status END,
      updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(assignee, req.body.acknowledgementStatus ?? 'assigned', c.id);
    logEvent(req, c.id, 'assigned', c.stage, 'under_investigation', `Assigned to ${name}`);
    audit(req, { action: 'edit', entity: 'complaints', entityId: c.id, oldValue: { assignedToStaffId: c.assigned_to_staff_id }, newValue: { assignedToStaffId: assignee } });
    res.json({ ok: true });
  });

  // ---- Record what was found ------------------------------------------------
  //
  // `sendForReview` is what moves it on: findings can be saved and revisited as
  // many times as the investigation needs, and only the investigator decides
  // when it is ready for somebody else to look at.
  router.post('/:id/investigate', requirePermission('complaints', 'edit'), (req, res) => {
    const db = getDb();
    const c = load(req, res); if (!c) return;
    const summary = String(req.body.investigationSummary ?? '').trim();
    if (!summary) return res.status(400).json({ error: 'Record what the investigation found.' });
    const sendForReview = req.body.sendForReview === true;
    if (sendForReview && !String(req.body.correction ?? c.correction ?? '').trim()) {
      return res.status(400).json({ error: 'Record the correction — what was put right — before sending the complaint for review.' });
    }
    const nextStage = sendForReview ? 'awaiting_review' : (c.stage === 'closed' || c.stage === 'withdrawn' ? c.stage : 'under_investigation');
    db.prepare(`UPDATE complaints SET investigation_summary = ?, root_cause = ?, correction = ?, investigated_at = CURRENT_TIMESTAMP,
      investigated_by_staff_id = COALESCE(investigated_by_staff_id, ?), stage = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(summary, req.body.rootCause ?? c.root_cause, req.body.correction ?? c.correction,
        getStaffIdOrCurrent(req, null), nextStage, req.body.status ?? (sendForReview ? 'action_required' : 'investigating'), c.id);
    logEvent(req, c.id, sendForReview ? 'sent_for_review' : 'investigation_updated', c.stage, nextStage,
      sendForReview ? 'Findings complete; sent for independent review' : 'Investigation findings updated');
    audit(req, { action: 'edit', entity: 'complaints', entityId: c.id, oldValue: { investigationSummary: c.investigation_summary }, newValue: req.body });
    res.json({ ok: true, stage: nextStage });
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

  // ---- Close it -------------------------------------------------------------
  //
  // Closing is refused until the two things §7.4 actually requires have
  // happened: somebody uninvolved decided it, and the complainant was told.
  // Otherwise "closed" would mean only that the laboratory stopped thinking
  // about it, which is the state the clause exists to prevent.
  router.post('/:id/close', requirePermission('complaints', 'void_archive'), (req, res) => {
    const db = getDb();
    const c = load(req, res); if (!c) return;
    if (c.closed_at) return res.status(400).json({ error: 'This complaint is already closed.' });
    const closureSummary = String(req.body.closureSummary ?? '').trim();
    if (!closureSummary) return res.status(400).json({ error: 'A closure summary is required.' });
    if (!c.reviewed_at) {
      return res.status(400).json({ error: 'This complaint has not been independently reviewed. ISO 15189 §7.4 requires the decision to be made or reviewed by someone not involved in the activity complained about.' });
    }
    if (!c.outcome_communicated_at) {
      return res.status(400).json({ error: 'The complainant has not been told the outcome. §7.4 requires formal notice that complaint handling has ended before the record is closed.' });
    }
    // Who closed it is recorded either way. Refusing an administrator who has
    // no staff record — as this used to — protects nothing: the account is a
    // named, authenticated person and the audit entry says so.
    const closedByStaffId = getStaffIdOrCurrent(req, req.body.closedByStaffId);
    db.prepare(`UPDATE complaints SET status = 'closed', stage = 'closed', closure_summary = ?, closed_by_staff_id = ?,
      closed_by_user_id = ?, closed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(closureSummary, closedByStaffId, req.user!.id, c.id);
    logEvent(req, c.id, 'closed', c.stage, 'closed', closureSummary);
    audit(req, { action: 'void_archive', entity: 'complaints', entityId: c.id, oldValue: { status: c.status }, newValue: { status: 'closed', closureSummary } });
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
