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

export function capaRoutes() {
  const router = Router();
  // The register carries the human-readable source reference and owner name so
  // the list is readable without a second round-trip per row.
  const LIST_SQL = `SELECT c.*, resp.full_name AS responsible_name, ver.full_name AS verified_by_name,
      eff.full_name AS effectiveness_reviewed_by_name, nc.nc_number, inc.incident_number, cm.complaint_number
    FROM capa_records c
    LEFT JOIN staff resp ON resp.id = c.responsible_staff_id
    LEFT JOIN staff ver ON ver.id = c.verified_by_staff_id
    LEFT JOIN staff eff ON eff.id = c.effectiveness_reviewed_by_staff_id
    LEFT JOIN nonconforming_events nc ON nc.id = c.nc_id
    LEFT JOIN incidents inc ON inc.id = c.incident_id
    LEFT JOIN complaints cm ON cm.id = c.complaint_id`;

  router.get('/', requirePermission('nc_capa', 'view'), (_req, res) => {
    const db = getDb();
    res.json(db.prepare(`${LIST_SQL} ORDER BY c.created_at DESC`).all());
  });

  // Worklist counts driving the CAPA dashboard and tab badges.
  router.get('/summary', requirePermission('nc_capa', 'view'), (_req, res) => {
    const db = getDb();
    const today = new Date().toISOString().slice(0, 10);
    const one = (sql: string, ...p: unknown[]) => (db.prepare(`SELECT COUNT(*) AS n FROM capa_records ${sql}`).get(...p as any[]) as any).n as number;
    res.json({
      total: one(''),
      open: one("WHERE status NOT IN ('closed')"),
      needsPlan: one("WHERE status = 'open'"),
      inProgress: one("WHERE status = 'in_progress'"),
      awaitingVerification: one("WHERE status = 'completed'"),
      awaitingEffectiveness: one("WHERE status = 'verified' AND effectiveness_required = 1 AND COALESCE(effectiveness_status,'pending') = 'pending'"),
      effectivenessDue: one("WHERE effectiveness_required = 1 AND COALESCE(effectiveness_status,'pending') = 'pending' AND effectiveness_due_date IS NOT NULL AND effectiveness_due_date <= ?", today),
      overdue: one("WHERE status NOT IN ('closed') AND due_date IS NOT NULL AND due_date < ?", today),
      failed: one("WHERE effectiveness_status = 'not_effective'"),
      closed: one("WHERE status = 'closed'"),
    });
  });

  router.post('/', requirePermission('nc_capa', 'create'), (req, res) => {
    if (!req.body.title) return res.status(400).json({ error: 'title is required' });
    if (!req.body.problemSummary) return res.status(400).json({ error: 'problemSummary is required' });
    const db = getDb();
    const createdAt = new Date().toISOString();
    const capaNumber = generateRecordNumber(db, 'capa_records', 'CAPA', createdAt);
    const result = db.prepare('INSERT INTO capa_records (capa_number, source_module, source_record_id, nc_id, complaint_id, risk_id, title, problem_summary, root_cause, corrective_action, preventive_action, responsible_staff_id, due_date, priority, status, effectiveness_required, effectiveness_due_date, effectiveness_status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      capaNumber,
      req.body.sourceModule ?? null,
      req.body.sourceRecordId ?? null,
      parseIntNullable(req.body.ncId),
      parseIntNullable(req.body.complaintId),
      parseIntNullable(req.body.riskId),
      req.body.title,
      req.body.problemSummary,
      req.body.rootCause,
      req.body.correctiveAction,
      req.body.preventiveAction,
      parseIntNullable(req.body.responsibleStaffId),
      req.body.dueDate ?? null,
      req.body.priority ?? 'normal',
      'open',
      req.body.effectivenessRequired ? 1 : 0,
      req.body.effectivenessDueDate ?? null,
      'pending',
      req.user!.id,
      createdAt
    );
    const id = result.lastInsertRowid;
    if (req.body.ncId) {
      db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run('nc_capa', 'nonconforming_events', String(req.body.ncId), 'nc_capa', 'capa_records', String(id), 'Linked CAPA from NC');
    }
    if (req.body.complaintId) {
      db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run('complaints', 'complaints', String(req.body.complaintId), 'nc_capa', 'capa_records', String(id), 'Linked CAPA from complaint');
    }
    if (req.body.riskId) {
      db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run('risks', 'risks', String(req.body.riskId), 'nc_capa', 'capa_records', String(id), 'Linked CAPA from risk');
    }
    audit(req, { action: 'create', entity: 'capa_records', entityId: id, newValue: { capaNumber, ...req.body } });
    res.status(201).json({ id, capaNumber });
  });

  router.get('/:id', requirePermission('nc_capa', 'view'), (req, res) => {
    const db = getDb();
    const item = db.prepare(`${LIST_SQL} WHERE c.id = ?`).get(req.params.id);
    if (!item) return res.status(404).json({ error: 'CAPA not found' });
    const updates = db.prepare('SELECT * FROM capa_updates WHERE capa_id = ? ORDER BY update_date DESC').all(req.params.id);
    const links = db.prepare('SELECT * FROM record_links WHERE (source_module_key = ? AND source_record_type = ? AND source_record_id = ?) OR (target_module_key = ? AND target_record_type = ? AND target_record_id = ?)').all('nc_capa', 'capa_records', String(req.params.id), 'nc_capa', 'capa_records', String(req.params.id));
    res.json({ ...item, updates, links });
  });

  router.put('/:id', requirePermission('nc_capa', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM capa_records WHERE id = ?').get(req.params.id);
    if (!oldValue) return res.status(404).json({ error: 'CAPA not found' });
    db.prepare('UPDATE capa_records SET source_module = ?, source_record_id = ?, nc_id = ?, complaint_id = ?, risk_id = ?, title = ?, problem_summary = ?, root_cause = ?, corrective_action = ?, preventive_action = ?, responsible_staff_id = ?, due_date = ?, priority = ?, status = ?, verification_notes = ?, effectiveness_required = ?, effectiveness_due_date = ?, effectiveness_review_notes = ?, effectiveness_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(
      req.body.sourceModule ?? oldValue.source_module,
      req.body.sourceRecordId ?? oldValue.source_record_id,
      parseIntNullable(req.body.ncId),
      parseIntNullable(req.body.complaintId),
      parseIntNullable(req.body.riskId),
      req.body.title,
      req.body.problemSummary,
      req.body.rootCause,
      req.body.correctiveAction,
      req.body.preventiveAction,
      parseIntNullable(req.body.responsibleStaffId),
      req.body.dueDate ?? null,
      req.body.priority ?? oldValue.priority,
      req.body.status ?? oldValue.status,
      req.body.verificationNotes ?? oldValue.verification_notes,
      req.body.effectivenessRequired ? 1 : 0,
      req.body.effectivenessDueDate ?? oldValue.effectiveness_due_date,
      req.body.effectivenessReviewNotes ?? oldValue.effectiveness_review_notes,
      req.body.effectivenessStatus ?? oldValue.effectiveness_status,
      req.params.id
    );
    audit(req, { action: 'edit', entity: 'capa_records', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  router.post('/:id/add-update', requirePermission('nc_capa', 'edit'), (req, res) => {
    const db = getDb();
    const existing = db.prepare('SELECT * FROM capa_records WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'CAPA not found' });
    const createdAt = new Date().toISOString();
    const result = db.prepare('INSERT INTO capa_updates (capa_id, update_date, update_text, status, evidence_file_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      req.params.id,
      req.body.updateDate ?? createdAt,
      req.body.updateText,
      req.body.status ?? existing.status,
      parseIntNullable(req.body.evidenceFileId),
      req.user!.id,
      createdAt
    );
    audit(req, { action: 'edit', entity: 'capa_updates', entityId: result.lastInsertRowid, newValue: { capaId: req.params.id, ...req.body } });
    res.status(201).json({ id: result.lastInsertRowid });
  });

  // Step 1 — the action plan. Records what will be done, by whom and by when,
  // which is what moves a newly raised CAPA into implementation.
  router.post('/:id/plan', requirePermission('nc_capa', 'edit'), (req, res) => {
    const db = getDb();
    const old = db.prepare('SELECT * FROM capa_records WHERE id = ?').get(req.params.id) as any;
    if (!old) return res.status(404).json({ error: 'CAPA not found' });
    if (!req.body.correctiveAction || !String(req.body.correctiveAction).trim()) {
      return res.status(400).json({ error: 'Describe the corrective action to be taken.' });
    }
    if (!req.body.dueDate) return res.status(400).json({ error: 'Set the target completion date.' });
    db.prepare(`UPDATE capa_records SET root_cause = ?, corrective_action = ?, preventive_action = ?, responsible_staff_id = ?,
        due_date = ?, target_completion_date = ?, priority = ?, effectiveness_required = ?, effectiveness_due_date = ?,
        status = CASE WHEN status IN ('open','reopened') THEN 'in_progress' ELSE status END, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(req.body.rootCause ?? old.root_cause, req.body.correctiveAction, req.body.preventiveAction ?? old.preventive_action,
        parseIntNullable(req.body.responsibleStaffId), req.body.dueDate, req.body.dueDate,
        req.body.priority ?? old.priority, req.body.effectivenessRequired === false ? 0 : 1,
        req.body.effectivenessDueDate ?? old.effectiveness_due_date, req.params.id);
    audit(req, { action: 'edit', entity: 'capa_records', entityId: req.params.id, oldValue: old, newValue: { stage: 'plan' } });
    res.json({ ok: true });
  });

  // Step 2 — the owner declares the planned actions implemented; the CAPA then
  // waits for independent verification.
  router.post('/:id/complete', requirePermission('nc_capa', 'edit'), (req, res) => {
    const db = getDb();
    const old = db.prepare('SELECT * FROM capa_records WHERE id = ?').get(req.params.id) as any;
    if (!old) return res.status(404).json({ error: 'CAPA not found' });
    if (!old.corrective_action || !String(old.corrective_action).trim()) {
      return res.status(400).json({ error: 'Record the action plan before marking the actions complete.' });
    }
    const when = new Date().toISOString();
    db.prepare("UPDATE capa_records SET status = 'completed', completed_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(when, req.params.id);
    if (req.body.notes) {
      db.prepare('INSERT INTO capa_updates (capa_id, update_date, update_text, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(req.params.id, when.slice(0, 10), req.body.notes, 'completed', req.user!.id, when);
    }
    audit(req, { action: 'edit', entity: 'capa_records', entityId: req.params.id, oldValue: old, newValue: { status: 'completed' } });
    res.json({ ok: true });
  });

  router.post('/:id/verify', requirePermission('nc_capa', 'approve'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT verification_notes, verified_by_staff_id, verified_at, status FROM capa_records WHERE id = ?').get(req.params.id);
    if (!oldValue) return res.status(404).json({ error: 'CAPA not found' });
    const verifiedByStaffId = getStaffIdOrCurrent(req, req.body.verifiedByStaffId);
    if (verifiedByStaffId === null) return res.status(400).json({ error: 'This action requires the logged-in user to be linked to a staff record.' });
    db.prepare('UPDATE capa_records SET verification_notes = ?, verified_by_staff_id = ?, verified_at = CURRENT_TIMESTAMP, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.body.verificationNotes, verifiedByStaffId, req.body.status ?? 'verified', req.params.id);
    audit(req, { action: 'approve', entity: 'capa_records', entityId: req.params.id, oldValue, newValue: { verificationNotes: req.body.verificationNotes, status: req.body.status ?? 'verified' } });
    res.json({ ok: true });
  });

  // Schedule the effectiveness review — sets when the check is due, without
  // recording a verdict yet.
  router.post('/:id/schedule-effectiveness', requirePermission('nc_capa', 'edit'), (req, res) => {
    const db = getDb();
    const old = db.prepare('SELECT effectiveness_due_date, effectiveness_required FROM capa_records WHERE id = ?').get(req.params.id) as any;
    if (!old) return res.status(404).json({ error: 'CAPA not found' });
    if (!req.body.effectivenessDueDate) return res.status(400).json({ error: 'Choose the date the effectiveness check falls due.' });
    db.prepare("UPDATE capa_records SET effectiveness_required = 1, effectiveness_due_date = ?, effectiveness_status = CASE WHEN effectiveness_status IN ('effective','not_effective') THEN effectiveness_status ELSE 'pending' END, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(req.body.effectivenessDueDate, req.params.id);
    audit(req, { action: 'edit', entity: 'capa_records', entityId: req.params.id, oldValue: old, newValue: { effectivenessDueDate: req.body.effectivenessDueDate } });
    res.json({ ok: true });
  });

  // Record the effectiveness review verdict. A CAPA judged effective is ready
  // for closure; one judged not effective is reopened so the actions can be
  // reworked (ISO 15189 §8.7 — verify that corrective action was effective).
  router.post('/:id/effectiveness-review', requirePermission('nc_capa', 'approve'), (req, res) => {
    const db = getDb();
    const old = db.prepare('SELECT * FROM capa_records WHERE id = ?').get(req.params.id) as any;
    if (!old) return res.status(404).json({ error: 'CAPA not found' });
    const verdict = String(req.body.verdict ?? '').trim();
    if (!['effective', 'not_effective'].includes(verdict)) {
      return res.status(400).json({ error: 'Choose whether the action was effective or not effective.' });
    }
    if (!req.body.effectivenessReviewNotes || !String(req.body.effectivenessReviewNotes).trim()) {
      return res.status(400).json({ error: 'Record what evidence shows the action was (or was not) effective.' });
    }
    const reviewedBy = getStaffIdOrCurrent(req, req.body.reviewedByStaffId);
    const reviewDate = req.body.effectivenessReviewDate || new Date().toISOString().slice(0, 10);
    // Effective → ready to close. Not effective → back to in progress for rework.
    const nextStatus = verdict === 'effective' ? 'verified' : 'reopened';
    db.prepare(`UPDATE capa_records SET effectiveness_review_notes = ?, effectiveness_status = ?, effectiveness_verdict = ?,
        effectiveness_reviewed_by_staff_id = ?, effectiveness_review_date = ?, effectiveness_required = 1,
        status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(req.body.effectivenessReviewNotes, verdict, verdict, reviewedBy, reviewDate, nextStatus, req.params.id);
    db.prepare('INSERT INTO capa_updates (capa_id, update_date, update_text, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(req.params.id, reviewDate, `Effectiveness review — ${verdict === 'effective' ? 'effective' : 'not effective'}: ${req.body.effectivenessReviewNotes}`, nextStatus, req.user!.id, new Date().toISOString());
    audit(req, { action: 'approve', entity: 'capa_records', entityId: req.params.id, oldValue: old, newValue: { verdict, status: nextStatus } });
    res.json({ ok: true, verdict, status: nextStatus });
  });

  router.post('/:id/close', requirePermission('nc_capa', 'void_archive'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM capa_records WHERE id = ?').get(req.params.id) as any;
    if (!oldValue) return res.status(404).json({ error: 'CAPA not found' });
    // ISO 15189 §8.7 expects corrective action to be shown effective before the
    // record is closed. `force` lets an authorised user close with a reason.
    if (oldValue.effectiveness_required && oldValue.effectiveness_status !== 'effective' && !req.body.force) {
      return res.status(409).json({
        error: 'Complete the effectiveness review first — a CAPA is closed once its action is shown to have worked.',
        needsEffectivenessReview: true,
      });
    }
    if (oldValue.effectiveness_status === 'not_effective' && !req.body.force) {
      return res.status(409).json({ error: 'The last effectiveness review found the action was not effective. Rework the actions and review again before closing.' });
    }
    const closedByStaffId = getStaffIdOrCurrent(req, req.body.closedByStaffId);
    if (closedByStaffId === null) return res.status(400).json({ error: 'This action requires the logged-in user to be linked to a staff record.' });
    db.prepare('UPDATE capa_records SET status = ?, closure_notes = ?, closed_by_staff_id = ?, closed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(req.body.status ?? 'closed', req.body.closureNotes ?? oldValue.closure_notes ?? null, closedByStaffId, req.params.id);
    // Closing the CAPA closes out the nonconformity / incident that raised it.
    if (oldValue.nc_id) db.prepare("UPDATE nonconforming_events SET workflow_stage = 'closed', status = CASE WHEN status = 'closed' THEN status ELSE 'closed' END, closed_at = COALESCE(closed_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(oldValue.nc_id);
    if (oldValue.incident_id) db.prepare("UPDATE incidents SET workflow_stage = 'closed', status = 'closed', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(oldValue.incident_id);
    audit(req, { action: 'void_archive', entity: 'capa_records', entityId: req.params.id, oldValue, newValue: { status: req.body.status ?? 'closed', forced: !!req.body.force } });
    res.json({ ok: true });
  });

  router.post('/:id/reopen', requirePermission('nc_capa', 'edit'), (req, res) => {
    const db = getDb();
    const existing = db.prepare('SELECT * FROM capa_records WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'CAPA not found' });
    db.prepare('UPDATE capa_records SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.body.status ?? 'reopened', req.params.id);
    audit(req, { action: 'edit', entity: 'capa_records', entityId: req.params.id, oldValue: existing, newValue: { status: req.body.status ?? 'reopened' } });
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
    db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run('nc_capa', 'capa_records', req.params.id, 'actions', 'actions', String(result.lastInsertRowid), 'Action linked from CAPA');
    audit(req, { action: 'create', entity: 'actions', entityId: result.lastInsertRowid, newValue: { sourceModule: 'nc_capa', sourceRecordId: req.params.id, ...req.body } });
    res.status(201).json({ id: result.lastInsertRowid });
  });

  return router;
}
