import { Router } from 'express';
import { getDb } from '../db/database.js';
import { requirePermission } from '../middleware/permissions.js';
import { audit } from '../services/auditService.js';
import { deleteNotificationsWhere } from '../services/notificationCleanup.js';
import { generateRecordNumber } from '../utils/recordNumber.js';
import { parseIntNullable, getCurrentStaffId } from './routeHelpers.js';
import { DECLARATION_TEMPLATES, DECLARATION_FORM_TYPES } from '../../shared/constants/declarations.js';

/**
 * Tell every member of staff there is something for them to sign.
 *
 * Addressed to the STAFF RECORD. It used to select `users … WHERE staff_id IS
 * NOT NULL`, so a code of conduct went only to people who already had a linked
 * login — everybody else was simply skipped, permanently. The inbox matches on
 * `assigned_to_staff_id`, so a row written now is waiting whenever the account
 * appears.
 */
function notifyAllStaff(db: any, moduleKey: string, title: string, message: string, actionUrl: string, actionLabel: string, notificationType: string, severity: string) {
  const staff = db.prepare('SELECT id FROM staff WHERE is_active = 1').all() as Array<{ id: number }>;
  const accountOf = db.prepare('SELECT id FROM users WHERE staff_id = ? AND is_active = 1 ORDER BY id LIMIT 1');
  const stmt = db.prepare(`INSERT INTO notifications (user_id, module_key, title, message, status, severity, notification_type, record_type, record_id, assigned_to_staff_id, assigned_to_user_id, action_url, action_label, created_by)
    VALUES (?, ?, ?, ?, 'unread', ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const tx = db.transaction(() => {
    for (const s of staff) {
      const account = accountOf.get(s.id) as { id: number } | undefined;
      stmt.run(account?.id ?? null, moduleKey, title, message, severity, notificationType, null, null, s.id, account?.id ?? null, actionUrl, actionLabel, account?.id ?? null);
    }
  });
  tx();
  return staff.length;
}

export function organisationExtendedRoutes() {
  const router = Router();

  // ==================================================================
  // ETHICAL DECLARATION FORMS — Code of Conduct upload + sign flow
  // ==================================================================
  const FORM_TYPES = [...DECLARATION_FORM_TYPES];

  // The pre-populated declaration library. Setting up a declaration copies one
  // of these onto a real, editable form, so a laboratory can stand up its Code
  // of Conduct and ethical declarations without drafting them from scratch.
  router.get('/declaration-templates', requirePermission('organisation.structure', 'view'), (_req, res) => {
    res.json(DECLARATION_TEMPLATES);
  });

  router.get('/ethical-forms', requirePermission('organisation.structure', 'view'), (req, res) => {
    const db = getDb();
    const forms = db.prepare(`SELECT f.*, s.full_name AS uploaded_by_name,
      (SELECT COUNT(*) FROM ethical_declaration_signatures WHERE form_id = f.id) AS signature_count,
      (SELECT COUNT(*) FROM staff WHERE is_active = 1) AS total_staff
      FROM ethical_declaration_forms f LEFT JOIN staff s ON s.id = f.uploaded_by_staff_id
      ORDER BY f.status = 'active' DESC, f.uploaded_at DESC`).all() as any[];
    // For each form, include whether the current caller has signed it.
    const staffId = getCurrentStaffId(req);
    const withMy = forms.map(f => ({
      ...f,
      my_signature: staffId ? db.prepare('SELECT id, signed_at, conflict_declared, conflict_details, signed_file_id FROM ethical_declaration_signatures WHERE form_id = ? AND staff_id = ?').get(f.id, staffId) : null,
    }));
    res.json(withMy);
  });

  router.get('/ethical-forms/:id', requirePermission('organisation.structure', 'view'), (req, res) => {
    const db = getDb();
    const f = db.prepare(`SELECT f.*, s.full_name AS uploaded_by_name, fl.original_name AS file_name, fl.mime_type AS file_mime
      FROM ethical_declaration_forms f LEFT JOIN staff s ON s.id = f.uploaded_by_staff_id
      LEFT JOIN files fl ON fl.id = f.file_id WHERE f.id = ?`).get(req.params.id) as any;
    if (!f) return res.status(404).json({ error: 'Form not found' });
    const signatures = db.prepare(`SELECT sig.*, st.full_name AS staff_name, st.employee_no, sec.name AS section_name, st.signature_file_id, fl.original_name AS signed_file_name
      FROM ethical_declaration_signatures sig LEFT JOIN staff st ON st.id = sig.staff_id
      LEFT JOIN sections sec ON sec.id = st.section_id
      LEFT JOIN files fl ON fl.id = sig.signed_file_id
      WHERE sig.form_id = ? ORDER BY sig.signed_at DESC`).all(req.params.id);
    res.json({ ...f, signatures });
  });

  router.post('/ethical-forms', requirePermission('organisation.structure', 'create'), (req, res) => {
    if (!req.body.title) return res.status(400).json({ error: 'title is required' });
    if (!req.body.formType || !FORM_TYPES.includes(req.body.formType)) return res.status(400).json({ error: `formType must be one of: ${FORM_TYPES.join(', ')}` });
    // A declaration must give staff something to read: either the declaration
    // text set up in the product, or an uploaded form file.
    const bodyContent = typeof req.body.bodyContent === 'string' && req.body.bodyContent.trim() ? req.body.bodyContent.trim() : null;
    if (!bodyContent && !parseIntNullable(req.body.fileId)) {
      return res.status(400).json({ error: 'Provide the declaration text or attach a form file.' });
    }
    const db = getDb();
    const staffId = getCurrentStaffId(req);
    const formNumber = generateRecordNumber(db, 'ethical_declaration_forms', 'ECOC', new Date().toISOString());
    const r = db.prepare(`INSERT INTO ethical_declaration_forms (form_number, title, form_type, description, version, effective_date, review_frequency_months, next_review_date, file_id, linked_document_id, requires_annual_reaffirmation, status, body_content, acknowledgement_statement, template_key, uploaded_by_staff_id, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      formNumber, req.body.title, req.body.formType, req.body.description ?? null, req.body.version ?? null,
      req.body.effectiveDate ?? null, parseIntNullable(req.body.reviewFrequencyMonths), req.body.nextReviewDate ?? null,
      parseIntNullable(req.body.fileId), parseIntNullable(req.body.linkedDocumentId),
      req.body.requiresAnnualReaffirmation === false ? 0 : 1, req.body.status ?? 'active',
      bodyContent, req.body.acknowledgementStatement ?? null, req.body.templateKey ?? null, staffId, req.user!.id);
    const id = Number(r.lastInsertRowid);
    // Notify every active staff to read and sign the newly uploaded form.
    if ((req.body.status ?? 'active') === 'active') {
      const notified = notifyAllStaff(db, 'organisation', `New declaration to sign: ${req.body.title}`,
        `The ${req.body.title} declaration form has been uploaded. Open it, read it and sign your acknowledgement.`,
        `/organisation?tab=Code%20of%20Conduct&form=${id}`, 'Read & sign', 'follow_up', 'high');
      audit(req, { action: 'notify', entity: 'ethical_declaration_forms', entityId: id, newValue: { notified } });
    }
    audit(req, { action: 'create', entity: 'ethical_declaration_forms', entityId: id, newValue: { formNumber, ...req.body } });
    res.status(201).json({ id, formNumber });
  });

  router.put('/ethical-forms/:id', requirePermission('organisation.structure', 'edit'), (req, res) => {
    const db = getDb();
    const old = db.prepare('SELECT * FROM ethical_declaration_forms WHERE id = ?').get(req.params.id) as any;
    if (!old) return res.status(404).json({ error: 'Form not found' });
    db.prepare(`UPDATE ethical_declaration_forms SET title = ?, form_type = ?, description = ?, version = ?, effective_date = ?, review_frequency_months = ?, next_review_date = ?, file_id = ?, linked_document_id = ?, requires_annual_reaffirmation = ?, status = ?, body_content = ?, acknowledgement_statement = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(
      req.body.title ?? old.title, req.body.formType ?? old.form_type, req.body.description ?? old.description,
      req.body.version ?? old.version, req.body.effectiveDate ?? old.effective_date,
      parseIntNullable(req.body.reviewFrequencyMonths) ?? old.review_frequency_months,
      req.body.nextReviewDate ?? old.next_review_date,
      parseIntNullable(req.body.fileId) ?? old.file_id, parseIntNullable(req.body.linkedDocumentId) ?? old.linked_document_id,
      req.body.requiresAnnualReaffirmation === undefined ? old.requires_annual_reaffirmation : (req.body.requiresAnnualReaffirmation ? 1 : 0),
      req.body.status ?? old.status,
      req.body.bodyContent === undefined ? old.body_content : (typeof req.body.bodyContent === 'string' && req.body.bodyContent.trim() ? req.body.bodyContent.trim() : null),
      req.body.acknowledgementStatement === undefined ? old.acknowledgement_statement : (req.body.acknowledgementStatement ?? null),
      req.params.id);
    audit(req, { action: 'edit', entity: 'ethical_declaration_forms', entityId: req.params.id, oldValue: old, newValue: req.body });
    res.json({ ok: true });
  });

  // Sign a form. Signatures are PERSONAL — always bound to the authenticated
  // caller. A body-provided staffId is ignored.
  router.post('/ethical-forms/:id/sign', requirePermission('organisation.structure', 'view'), (req, res) => {
    const db = getDb();
    const staffId = getCurrentStaffId(req);
    if (staffId === null) return res.status(400).json({ error: 'Your login is not linked to a staff record; personal declarations cannot be signed.' });
    const form = db.prepare('SELECT * FROM ethical_declaration_forms WHERE id = ? AND status = \'active\'').get(req.params.id) as any;
    if (!form) return res.status(404).json({ error: 'Form not found or no longer active.' });
    const existing = db.prepare('SELECT id FROM ethical_declaration_signatures WHERE form_id = ? AND staff_id = ?').get(req.params.id, staffId);
    if (existing) return res.status(400).json({ error: 'You have already signed this declaration.' });
    // A file-based declaration (a form file, no in-app text) is signed on the
    // document itself: the signatory must download it, sign it and attach the
    // signed copy. A text declaration is acknowledged in the app, no upload.
    const signedFileId = parseIntNullable(req.body.signedFileId);
    const isFileBased = !!form.file_id && !form.body_content;
    if (isFileBased && !signedFileId) {
      return res.status(400).json({ error: 'Download the form, sign it, and attach the signed copy before submitting your acknowledgement.' });
    }
    const r = db.prepare(`INSERT INTO ethical_declaration_signatures (form_id, staff_id, signed_by_user_id, conflict_declared, conflict_details, affirmation_text, notes, signed_file_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      req.params.id, staffId, req.user!.id, req.body.conflictDeclared ? 1 : 0,
      req.body.conflictDetails ?? null, req.body.affirmationText ?? null, req.body.notes ?? null, signedFileId);
    // Auto-resolve the "sign this declaration" notifications for this user.
    db.prepare("UPDATE notifications SET status = 'resolved', resolved_at = CURRENT_TIMESTAMP, resolved_by_staff_id = ? WHERE assigned_to_staff_id = ? AND module_key = 'organisation' AND (action_url LIKE ? OR (record_type = 'ethical_declaration_forms' AND record_id = ?)) AND status NOT IN ('resolved','dismissed')")
      .run(staffId, staffId, `%form=${req.params.id}%`, String(req.params.id));
    audit(req, { action: 'sign', entity: 'ethical_declaration_signatures', entityId: r.lastInsertRowid, newValue: { formId: req.params.id, staffId } });
    res.status(201).json({ id: r.lastInsertRowid });
  });

  // Delete a declaration form and everything hanging off it — its signatures
  // and the "sign this" notifications it raised. Kept behind the edit/delete
  // controls that are tucked away in the UI, and gated on the archive right.
  /**
   * Remove a declaration form.
   *
   * Two things had to be got right here, and neither was.
   *
   * A declaration that anybody has SIGNED is a record. Deleting it destroys
   * those signatures, and there is no undo — so it is refused unless the caller
   * says, in as many words, that they mean to. The usual answer for a
   * declaration that is finished with is to mark it obsolete, which keeps the
   * signatures and takes it off the list to sign; the refusal says so.
   *
   * And the notifications raised when it was published are not leaves: the
   * moment somebody opens one, a notification_events row points at it, and
   * deleting the notification then fails with "FOREIGN KEY constraint failed".
   * A newly created declaration deleted cleanly; every one that had actually
   * reached the bench did not. They go through deleteNotificationsWhere, which
   * clears the children first.
   */
  router.delete('/ethical-forms/:id', requirePermission('organisation.structure', 'void_archive'), (req, res) => {
    const db = getDb();
    const form = db.prepare('SELECT * FROM ethical_declaration_forms WHERE id = ?').get(req.params.id) as any;
    if (!form) return res.status(404).json({ error: 'Form not found' });

    const signatures = Number((db.prepare('SELECT COUNT(*) AS n FROM ethical_declaration_signatures WHERE form_id = ?')
      .get(req.params.id) as any)?.n ?? 0);
    const confirmed = req.query.deleteSignatures === '1' || req.body?.deleteSignatures === true;
    if (signatures > 0 && !confirmed) {
      return res.status(409).json({
        error: 'signed',
        signatures,
        message: `${signatures} ${signatures === 1 ? 'person has' : 'people have'} signed "${form.title}". `
          + 'Deleting it destroys those signatures and cannot be undone. If the declaration is simply finished with, '
          + 'mark it obsolete instead — that keeps the signatures and takes it off the list to sign.',
      });
    }

    db.transaction(() => {
      db.prepare('DELETE FROM ethical_declaration_signatures WHERE form_id = ?').run(req.params.id);
      deleteNotificationsWhere(
        db,
        "module_key = 'organisation' AND ((record_type = 'ethical_declaration_forms' AND record_id = ?) OR action_url LIKE ?)",
        [String(req.params.id), `%form=${req.params.id}%`],
      );
      db.prepare('DELETE FROM ethical_declaration_forms WHERE id = ?').run(req.params.id);
    })();
    audit(req, { action: 'delete', entity: 'ethical_declaration_forms', entityId: Number(req.params.id), oldValue: { ...form, signatures } });
    res.json({ ok: true, signaturesRemoved: signatures });
  });

  // ==================================================================
  // ORGANOGRAM CONTINUITY PLANS — for the absence of key personnel
  // ==================================================================
  router.get('/continuity-plans', requirePermission('organisation.structure', 'view'), (_req, res) => {
    const db = getDb();
    res.json(db.prepare(`SELECT cp.*, p.title AS position_title, dp.title AS deputy_position_title, s.full_name AS deputy_name
      FROM continuity_plans cp
      LEFT JOIN positions p ON p.id = cp.position_id
      LEFT JOIN positions dp ON dp.id = cp.deputy_position_id
      LEFT JOIN staff s ON s.id = cp.deputy_staff_id
      ORDER BY cp.key_role`).all());
  });

  router.post('/continuity-plans', requirePermission('organisation.structure', 'create'), (req, res) => {
    if (!req.body.keyRole) return res.status(400).json({ error: 'keyRole is required' });
    const db = getDb();
    const num = generateRecordNumber(db, 'continuity_plans', 'CONT', new Date().toISOString());
    const r = db.prepare(`INSERT INTO continuity_plans (plan_number, position_id, key_role, deputy_position_id, deputy_staff_id, acting_arrangement, authority_scope, handover_procedure, activation_trigger, training_status, last_tested_date, next_review_date, status, notes, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      num, parseIntNullable(req.body.positionId), req.body.keyRole,
      parseIntNullable(req.body.deputyPositionId), parseIntNullable(req.body.deputyStaffId),
      req.body.actingArrangement ?? null, req.body.authorityScope ?? null,
      req.body.handoverProcedure ?? null, req.body.activationTrigger ?? null,
      req.body.trainingStatus ?? 'in_progress', req.body.lastTestedDate ?? null,
      req.body.nextReviewDate ?? null, req.body.status ?? 'active', req.body.notes ?? null, req.user!.id);
    audit(req, { action: 'create', entity: 'continuity_plans', entityId: r.lastInsertRowid, newValue: { num, ...req.body } });
    res.status(201).json({ id: r.lastInsertRowid, planNumber: num });
  });

  router.put('/continuity-plans/:id', requirePermission('organisation.structure', 'edit'), (req, res) => {
    const db = getDb();
    const old = db.prepare('SELECT * FROM continuity_plans WHERE id = ?').get(req.params.id) as any;
    if (!old) return res.status(404).json({ error: 'Plan not found' });
    db.prepare(`UPDATE continuity_plans SET position_id = ?, key_role = ?, deputy_position_id = ?, deputy_staff_id = ?, acting_arrangement = ?, authority_scope = ?, handover_procedure = ?, activation_trigger = ?, training_status = ?, last_tested_date = ?, next_review_date = ?, status = ?, notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(
      parseIntNullable(req.body.positionId) ?? old.position_id, req.body.keyRole ?? old.key_role,
      parseIntNullable(req.body.deputyPositionId) ?? old.deputy_position_id,
      parseIntNullable(req.body.deputyStaffId) ?? old.deputy_staff_id,
      req.body.actingArrangement ?? old.acting_arrangement, req.body.authorityScope ?? old.authority_scope,
      req.body.handoverProcedure ?? old.handover_procedure, req.body.activationTrigger ?? old.activation_trigger,
      req.body.trainingStatus ?? old.training_status, req.body.lastTestedDate ?? old.last_tested_date,
      req.body.nextReviewDate ?? old.next_review_date, req.body.status ?? old.status, req.body.notes ?? old.notes, req.params.id);
    audit(req, { action: 'edit', entity: 'continuity_plans', entityId: req.params.id, oldValue: old, newValue: req.body });
    res.json({ ok: true });
  });

  router.delete('/continuity-plans/:id', requirePermission('organisation.structure', 'edit'), (req, res) => {
    const db = getDb();
    const old = db.prepare('SELECT * FROM continuity_plans WHERE id = ?').get(req.params.id);
    if (!old) return res.status(404).json({ error: 'Plan not found' });
    db.prepare('DELETE FROM continuity_plans WHERE id = ?').run(req.params.id);
    audit(req, { action: 'delete', entity: 'continuity_plans', entityId: req.params.id, oldValue: old });
    res.json({ ok: true });
  });

  // ==================================================================
  // BUDGET PROJECTIONS — enriched with ISO scope breakdown + totals
  // ==================================================================
  router.get('/budget/breakdown', requirePermission('organisation.budget', 'view'), (req, res) => {
    const db = getDb();
    const year = String(req.query.year || new Date().getFullYear());
    const rows = db.prepare('SELECT * FROM budget_projections WHERE fiscal_year = ? ORDER BY scope, category').all(year) as any[];
    const totals: Record<string, number> = {};
    for (const r of rows) {
      const k = r.scope || r.category || 'other';
      totals[k] = (totals[k] || 0) + (r.projected_amount || 0);
    }
    const grand = rows.reduce((s, r) => s + (r.projected_amount || 0), 0);
    res.json({ year, rows, totals, grand });
  });

  // ==================================================================
  // QUALITY & TECHNICAL RECORDS REVIEW
  // ==================================================================
  router.get('/qt-reviews/configs', requirePermission('organisation.records_review', 'view'), (_req, res) => {
    res.json(getDb().prepare('SELECT c.*, s.full_name AS responsible_name FROM qt_review_configs c LEFT JOIN staff s ON s.id = c.responsible_staff_id ORDER BY c.area_label').all());
  });

  router.put('/qt-reviews/configs/:areaKey', requirePermission('organisation.records_review', 'edit'), (req, res) => {
    const db = getDb();
    const old = db.prepare('SELECT * FROM qt_review_configs WHERE area_key = ?').get(req.params.areaKey) as any;
    if (!old) return res.status(404).json({ error: 'Config not found' });
    db.prepare(`UPDATE qt_review_configs SET frequency = ?, responsible_staff_id = ?, next_review_date = ?, is_active = ?, notes = ?, updated_at = CURRENT_TIMESTAMP WHERE area_key = ?`).run(
      req.body.frequency ?? old.frequency, parseIntNullable(req.body.responsibleStaffId) ?? old.responsible_staff_id,
      req.body.nextReviewDate ?? old.next_review_date,
      req.body.isActive === undefined ? old.is_active : (req.body.isActive ? 1 : 0),
      req.body.notes ?? old.notes, req.params.areaKey);
    audit(req, { action: 'edit', entity: 'qt_review_configs', entityId: req.params.areaKey, oldValue: old, newValue: req.body });
    res.json({ ok: true });
  });

  // Aggregate data for one review area over a period from the module tables.
  // Returns counts, sample rows, and links so the reviewer can navigate to the
  // source. Reviewer records findings + raises NC/CAPA from the review.
  router.get('/qt-reviews/data/:areaKey', requirePermission('organisation.records_review', 'view'), (req, res) => {
    const db = getDb();
    const areaKey = req.params.areaKey;
    const start = String(req.query.periodStart || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10));
    const end = String(req.query.periodEnd || new Date().toISOString().slice(0, 10));
    const query = (sql: string, ...p: unknown[]) => { try { return db.prepare(sql).all(...p); } catch { return []; } };
    const count = (sql: string, ...p: unknown[]) => { try { return (db.prepare(sql).get(...p) as { c: number })?.c ?? 0; } catch { return 0; } };
    const data: Record<string, unknown> = { areaKey, periodStart: start, periodEnd: end };
    switch (areaKey) {
      case 'previous_actions':
        data.actions = query('SELECT id, title, status, priority, due_date FROM actions WHERE created_at BETWEEN ? AND ? ORDER BY due_date DESC LIMIT 200', start, end);
        data.actionsOpen = count("SELECT COUNT(*) c FROM actions WHERE status != 'Closed' AND created_at <= ?", end);
        break;
      case 'corrective_actions':
        data.capa = query('SELECT id, capa_number, title, status, due_date, priority FROM capa_records WHERE created_at BETWEEN ? AND ? ORDER BY due_date DESC LIMIT 200', start, end);
        data.capaOpen = count("SELECT COUNT(*) c FROM capa_records WHERE status NOT IN ('closed') AND created_at <= ?", end);
        data.ncs = query('SELECT id, nc_number, title, status, severity FROM nonconforming_events WHERE created_at BETWEEN ? AND ? ORDER BY id DESC LIMIT 200', start, end);
        break;
      case 'personnel_reports':
        data.appraisals = query('SELECT id, record_number, staff_id, appraisal_date, rating, outcome FROM performance_appraisals WHERE appraisal_date BETWEEN ? AND ? ORDER BY appraisal_date DESC LIMIT 200', start, end);
        data.competency = query('SELECT id, competency_number, staff_id, activity, assessment_date, outcome FROM competency_assessments WHERE assessment_date BETWEEN ? AND ? ORDER BY assessment_date DESC LIMIT 200', start, end);
        break;
      case 'environmental':
        data.readings = query('SELECT id, asset_id, temperature, humidity, status, recorded_at FROM env_readings WHERE recorded_at BETWEEN ? AND ? AND status != \'normal\' ORDER BY recorded_at DESC LIMIT 200', start + ' 00:00:00', end + ' 23:59:59');
        data.excursions = query('SELECT id, asset_id, parameter, started_at, ended_at, status FROM env_excursions WHERE started_at BETWEEN ? AND ? ORDER BY started_at DESC LIMIT 200', start + ' 00:00:00', end + ' 23:59:59');
        break;
      case 'sample_rejection':
        data.rejections = query('SELECT id, rejection_number, rejection_date, sample_type, rejection_reason, status FROM specimen_rejections WHERE rejection_date BETWEEN ? AND ? ORDER BY rejection_date DESC LIMIT 200', start, end);
        break;
      case 'equipment':
        data.calibrations = query('SELECT id, calibration_number, equipment_id, calibration_date, result, next_due_date, status FROM equipment_calibration_records WHERE calibration_date BETWEEN ? AND ? ORDER BY calibration_date DESC LIMIT 200', start, end);
        data.maintenance = query('SELECT id, equipment_id, maintenance_date, maintenance_type, status, next_due_date FROM equipment_maintenance_records WHERE maintenance_date BETWEEN ? AND ? ORDER BY maintenance_date DESC LIMIT 200', start, end);
        data.breakdowns = query('SELECT id, equipment_id, breakdown_date, description, status FROM equipment_breakdowns WHERE breakdown_date BETWEEN ? AND ? ORDER BY breakdown_date DESC LIMIT 200', start, end);
        break;
      case 'iqc':
        data.results = query('SELECT id, iqc_material_id, run_date, result_value, status, rule_violation FROM iqc_results WHERE run_date BETWEEN ? AND ? ORDER BY run_date DESC LIMIT 200', start, end);
        data.failures = count("SELECT COUNT(*) c FROM iqc_results WHERE run_date BETWEEN ? AND ? AND status IN ('rejected','out_of_range','critical')", start, end);
        break;
      case 'eqa':
        data.events = query('SELECT id, eqa_program_id, cycle_name, received_date, submitted_date, performance_status FROM eqa_events WHERE COALESCE(received_date, submitted_date) BETWEEN ? AND ? ORDER BY id DESC LIMIT 200', start, end);
        data.unsatisfactory = count("SELECT COUNT(*) c FROM eqa_events WHERE performance_status IN ('unsatisfactory','fail','failed','poor')");
        break;
      case 'quality_indicators':
        data.results = query('SELECT id, indicator_id, period_start, period_end, calculated_value, status FROM quality_indicator_results WHERE period_end BETWEEN ? AND ? ORDER BY period_end DESC LIMIT 200', start, end);
        break;
      case 'complaints':
        data.complaints = query('SELECT id, complaint_number, received_date, category, status FROM complaints WHERE received_date BETWEEN ? AND ? ORDER BY received_date DESC LIMIT 200', start, end);
        data.feedback = query('SELECT id, feedback_number, feedback_date, urgency, status FROM customer_feedback WHERE feedback_date BETWEEN ? AND ? ORDER BY feedback_date DESC LIMIT 200', start, end);
        break;
      case 'improvement':
        data.projects = query('SELECT id, project_number, title, improvement_area, status, expected_completion_date FROM improvement_projects WHERE start_date BETWEEN ? AND ? OR expected_completion_date BETWEEN ? AND ? ORDER BY expected_completion_date DESC LIMIT 200', start, end, start, end);
        break;
      case 'routine_review':
        data.reviews = query('SELECT id, review_number, area_key, period_start, period_end, status, follow_up_status FROM qt_reviews ORDER BY period_end DESC LIMIT 200');
        break;
    }
    res.json(data);
  });

  router.get('/qt-reviews', requirePermission('organisation.records_review', 'view'), (req, res) => {
    const db = getDb();
    const filters: string[] = [];
    const params: unknown[] = [];
    if (req.query.areaKey) { filters.push('area_key = ?'); params.push(String(req.query.areaKey)); }
    if (req.query.status) { filters.push('status = ?'); params.push(String(req.query.status)); }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    res.json(db.prepare(`SELECT r.*, s.full_name AS reviewer_name FROM qt_reviews r LEFT JOIN staff s ON s.id = r.reviewed_by_staff_id ${where} ORDER BY r.period_end DESC, r.id DESC LIMIT 500`).all(...params));
  });

  router.post('/qt-reviews', requirePermission('organisation.records_review', 'create'), (req, res) => {
    if (!req.body.areaKey || !req.body.periodStart || !req.body.periodEnd) return res.status(400).json({ error: 'areaKey, periodStart and periodEnd are required' });
    const db = getDb();
    const num = generateRecordNumber(db, 'qt_reviews', 'QTR', new Date().toISOString());
    const reviewer = parseIntNullable(req.body.reviewedByStaffId) ?? getCurrentStaffId(req);
    const r = db.prepare(`INSERT INTO qt_reviews (review_number, area_key, period_start, period_end, reviewed_by_staff_id, reviewed_at, data_snapshot, findings, recurrent_problems, actions_planned, status, follow_up_due_date, follow_up_status, next_review_due, created_by)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      num, req.body.areaKey, req.body.periodStart, req.body.periodEnd, reviewer,
      req.body.dataSnapshot ? JSON.stringify(req.body.dataSnapshot) : null,
      req.body.findings ?? null, req.body.recurrentProblems ?? null, req.body.actionsPlanned ?? null,
      req.body.status ?? 'draft', req.body.followUpDueDate ?? null,
      req.body.followUpStatus ?? 'not_required', req.body.nextReviewDue ?? null, req.user!.id);
    const id = Number(r.lastInsertRowid);
    // Update the area's last_review_date so the frequency clock starts.
    db.prepare('UPDATE qt_review_configs SET last_review_date = ?, next_review_date = ? WHERE area_key = ?')
      .run(req.body.periodEnd, req.body.nextReviewDue ?? null, req.body.areaKey);
    audit(req, { action: 'create', entity: 'qt_reviews', entityId: id, newValue: { num, ...req.body } });
    res.status(201).json({ id, reviewNumber: num });
  });

  router.put('/qt-reviews/:id', requirePermission('organisation.records_review', 'edit'), (req, res) => {
    const db = getDb();
    const old = db.prepare('SELECT * FROM qt_reviews WHERE id = ?').get(req.params.id) as any;
    if (!old) return res.status(404).json({ error: 'Review not found' });
    db.prepare(`UPDATE qt_reviews SET findings = ?, recurrent_problems = ?, actions_planned = ?, status = ?, linked_nc_id = ?, linked_capa_id = ?, follow_up_due_date = ?, follow_up_status = ?, next_review_due = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(
      req.body.findings ?? old.findings, req.body.recurrentProblems ?? old.recurrent_problems,
      req.body.actionsPlanned ?? old.actions_planned, req.body.status ?? old.status,
      parseIntNullable(req.body.linkedNcId) ?? old.linked_nc_id, parseIntNullable(req.body.linkedCapaId) ?? old.linked_capa_id,
      req.body.followUpDueDate ?? old.follow_up_due_date, req.body.followUpStatus ?? old.follow_up_status,
      req.body.nextReviewDue ?? old.next_review_due, req.params.id);
    audit(req, { action: 'edit', entity: 'qt_reviews', entityId: req.params.id, oldValue: old, newValue: req.body });
    res.json({ ok: true });
  });

  return router;
}
