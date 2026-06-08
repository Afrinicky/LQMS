import { Router } from 'express';
import { getDb } from '../db/database.js';
import { requirePermission } from '../middleware/permissions.js';
import { audit } from '../services/auditService.js';
import { generateRecordNumber } from '../utils/recordNumber.js';
import { parseIntNullable, getStaffIdOrCurrent } from './routeHelpers.js';

const REVIEW_STATUSES = ['draft', 'inputs_collected', 'reviewed', 'approved', 'closed'];

export function managementReviewRoutes() {
  const router = Router();

  router.get('/', requirePermission('management_review', 'view'), (_req, res) => {
    const db = getDb();
    res.json(db.prepare('SELECT * FROM management_reviews ORDER BY review_date DESC, id DESC').all());
  });

  router.post('/', requirePermission('management_review', 'create'), (req, res) => {
    if (!req.body.reviewPeriodStart) return res.status(400).json({ error: 'reviewPeriodStart is required' });
    if (!req.body.reviewPeriodEnd) return res.status(400).json({ error: 'reviewPeriodEnd is required' });
    if (!req.body.reviewDate) return res.status(400).json({ error: 'reviewDate is required' });
    const status = req.body.status ?? 'draft';
    if (!REVIEW_STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${REVIEW_STATUSES.join(', ')}` });
    const db = getDb();
    const createdAt = new Date().toISOString();
    const reviewNumber = generateRecordNumber(db, 'management_reviews', 'MREV', createdAt);
    const result = db.prepare(`INSERT INTO management_reviews (review_number, review_period_start, review_period_end, review_date, chair_staff_id, secretary_staff_id, summary, conclusions, decisions, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(reviewNumber, req.body.reviewPeriodStart, req.body.reviewPeriodEnd, req.body.reviewDate, parseIntNullable(req.body.chairStaffId), parseIntNullable(req.body.secretaryStaffId), req.body.summary ?? null, req.body.conclusions ?? null, req.body.decisions ?? null, status, req.user!.id, createdAt);
    const id = Number(result.lastInsertRowid);
    audit(req, { action: 'create', entity: 'management_reviews', entityId: id, newValue: { reviewNumber, ...req.body } });
    res.status(201).json({ id, reviewNumber });
  });

  router.get('/:id', requirePermission('management_review', 'view'), (req, res) => {
    const db = getDb();
    const review = db.prepare('SELECT * FROM management_reviews WHERE id = ?').get(req.params.id) as any;
    if (!review) return res.status(404).json({ error: 'Management review not found' });
    const inputs = db.prepare('SELECT * FROM management_review_inputs WHERE management_review_id = ? ORDER BY input_area, id').all(req.params.id);
    const links = db.prepare('SELECT * FROM record_links WHERE source_module_key = ? AND source_record_type = ? AND source_record_id = ?').all('management_review', 'management_reviews', String(req.params.id));
    res.json({ ...review, inputs, links });
  });

  router.put('/:id', requirePermission('management_review', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM management_reviews WHERE id = ?').get(req.params.id) as any;
    if (!oldValue) return res.status(404).json({ error: 'Management review not found' });
    if (req.body.status && !REVIEW_STATUSES.includes(req.body.status)) return res.status(400).json({ error: `status must be one of: ${REVIEW_STATUSES.join(', ')}` });
    db.prepare(`UPDATE management_reviews SET review_period_start = ?, review_period_end = ?, review_date = ?, chair_staff_id = ?, secretary_staff_id = ?, summary = ?, conclusions = ?, decisions = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(req.body.reviewPeriodStart ?? oldValue.review_period_start, req.body.reviewPeriodEnd ?? oldValue.review_period_end, req.body.reviewDate ?? oldValue.review_date, parseIntNullable(req.body.chairStaffId) ?? oldValue.chair_staff_id, parseIntNullable(req.body.secretaryStaffId) ?? oldValue.secretary_staff_id, req.body.summary ?? oldValue.summary, req.body.conclusions ?? oldValue.conclusions, req.body.decisions ?? oldValue.decisions, req.body.status ?? oldValue.status, req.params.id);
    audit(req, { action: 'edit', entity: 'management_reviews', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  router.post('/:id/add-input', requirePermission('management_review', 'create'), (req, res) => {
    if (!req.body.inputArea) return res.status(400).json({ error: 'inputArea is required' });
    const db = getDb();
    const review = db.prepare('SELECT id FROM management_reviews WHERE id = ?').get(req.params.id);
    if (!review) return res.status(404).json({ error: 'Management review not found' });
    const result = db.prepare(`INSERT INTO management_review_inputs (management_review_id, input_area, source_module, source_record_id, summary, issues, actions_required, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(req.params.id, req.body.inputArea, req.body.sourceModule ?? null, req.body.sourceRecordId ?? null, req.body.summary ?? null, req.body.issues ?? null, req.body.actionsRequired ?? null, req.user!.id);
    const id = Number(result.lastInsertRowid);
    if (req.body.sourceModule && req.body.sourceRecordId) {
      db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run('management_review', 'management_reviews', String(req.params.id), req.body.sourceModule, req.body.sourceRecordType ?? 'unspecified', String(req.body.sourceRecordId), req.body.inputArea);
    }
    audit(req, { action: 'add_input', entity: 'management_review_inputs', entityId: id, newValue: { managementReviewId: req.params.id, ...req.body } });
    res.status(201).json({ id });
  });

  router.post('/:id/generate-inputs', requirePermission('management_review', 'create'), (req, res) => {
    const db = getDb();
    const review = db.prepare('SELECT * FROM management_reviews WHERE id = ?').get(req.params.id) as any;
    if (!review) return res.status(404).json({ error: 'Management review not found' });
    const start = review.review_period_start;
    const end = review.review_period_end;
    const insert = db.prepare('INSERT INTO management_review_inputs (management_review_id, input_area, source_module, summary, issues, created_by) VALUES (?, ?, ?, ?, ?, ?)');
    const count = (sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { count: number }).count;
    let createdCount = 0;
    const sections: Array<{ area: string; module: string; summary: string; issues?: string }> = [];

    const openCapa = count("SELECT COUNT(*) count FROM capa_records WHERE status != 'closed' AND created_at BETWEEN ? AND ?", start, end);
    sections.push({ area: 'Open CAPA', module: 'nc_capa', summary: `${openCapa} open CAPA record(s) in period.` });

    const complaints = count('SELECT COUNT(*) count FROM complaints WHERE received_date BETWEEN ? AND ?', start, end);
    const complaintsOpen = count("SELECT COUNT(*) count FROM complaints WHERE status != 'closed' AND received_date BETWEEN ? AND ?", start, end);
    sections.push({ area: 'Customer complaints', module: 'complaints', summary: `${complaints} complaint(s) received; ${complaintsOpen} still open.` });

    const highRisks = count("SELECT COUNT(*) count FROM risks WHERE risk_level IN ('High','Critical') AND status != 'closed'");
    sections.push({ area: 'Risk register', module: 'risks', summary: `${highRisks} high/critical risk(s) currently open.` });

    const indicatorsActive = count('SELECT COUNT(*) count FROM quality_indicators WHERE is_active = 1');
    const indicatorsCritical = count("SELECT COUNT(*) count FROM quality_indicator_results WHERE status = 'critical' AND period_start BETWEEN ? AND ?", start, end);
    sections.push({ area: 'Quality indicators', module: 'quality_indicators', summary: `${indicatorsActive} active indicator(s); ${indicatorsCritical} critical result(s) in period.` });

    const equipmentOoS = count("SELECT COUNT(*) count FROM equipment_items WHERE status IN ('out_of_service','under_repair','restricted_use')");
    const breakdowns = count("SELECT COUNT(*) count FROM equipment_breakdowns WHERE breakdown_date BETWEEN ? AND ?", start, end);
    sections.push({ area: 'Equipment issues', module: 'equipment', summary: `${equipmentOoS} item(s) out of service; ${breakdowns} breakdown(s) in period.` });

    const monitoringCrit = count("SELECT COUNT(*) count FROM monitoring_readings WHERE status IN ('critical','out_of_range') AND reading_date BETWEEN ? AND ?", start, end);
    sections.push({ area: 'Monitoring excursions', module: 'monitoring', summary: `${monitoringCrit} critical/out-of-range monitoring reading(s) in period.` });

    const reportsApproved = count("SELECT COUNT(*) count FROM monthly_report_batches WHERE status IN ('approved','exported','archived') AND approved_at BETWEEN ? AND ?", start, end);
    sections.push({ area: 'Monthly reports', module: 'monthly_reports', summary: `${reportsApproved} monthly report(s) approved in period.` });

    const bbAdverse = count('SELECT COUNT(*) count FROM blood_adverse_events WHERE event_date BETWEEN ? AND ?', start, end);
    sections.push({ area: 'Blood bank adverse events', module: 'blood_bank_handover', summary: `${bbAdverse} blood bank adverse event(s) logged in period.` });

    const trainings = count('SELECT COUNT(*) count FROM training_events WHERE training_date BETWEEN ? AND ?', start, end);
    const compNotYet = count("SELECT COUNT(*) count FROM competency_assessments WHERE outcome = 'not_yet_competent' AND assessment_date BETWEEN ? AND ?", start, end);
    sections.push({ area: 'Training and competency', module: 'personnel', summary: `${trainings} training event(s); ${compNotYet} not-yet-competent assessment(s) in period.` });

    const tx = db.transaction(() => {
      for (const s of sections) {
        insert.run(req.params.id, s.area, s.module, s.summary, s.issues ?? null, req.user!.id);
        createdCount++;
      }
      db.prepare("UPDATE management_reviews SET status = CASE WHEN status = 'draft' THEN 'inputs_collected' ELSE status END, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
    });
    tx();

    audit(req, { action: 'generate_inputs', entity: 'management_reviews', entityId: req.params.id, newValue: { sectionsCreated: createdCount, period: { start, end } } });
    res.json({ ok: true, sectionsCreated: createdCount });
  });

  router.post('/:id/create-action', requirePermission('actions', 'create'), (req, res) => {
    if (!req.body.title) return res.status(400).json({ error: 'title is required' });
    const db = getDb();
    const review = db.prepare('SELECT id FROM management_reviews WHERE id = ?').get(req.params.id);
    if (!review) return res.status(404).json({ error: 'Management review not found' });
    const result = db.prepare('INSERT INTO actions (title, module_key, source_module, source_record_id, description, priority, assigned_to_staff_id, due_date, status, evidence_required, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(req.body.title, 'management_review', 'management_review', String(req.params.id), req.body.description ?? null, req.body.priority ?? 'normal', parseIntNullable(req.body.assignedToStaffId), req.body.dueDate ?? null, 'Not started', req.body.evidenceRequired ? 1 : 0, req.user!.id);
    const actionId = Number(result.lastInsertRowid);
    db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run('management_review', 'management_reviews', String(req.params.id), 'actions', 'actions', String(actionId), 'Action from management review');
    audit(req, { action: 'create', entity: 'actions', entityId: actionId, newValue: { sourceModule: 'management_review', sourceRecordId: req.params.id, ...req.body } });
    res.status(201).json({ id: actionId });
  });

  router.post('/:id/approve', requirePermission('management_review', 'approve'), (req, res) => {
    const db = getDb();
    const review = db.prepare('SELECT * FROM management_reviews WHERE id = ?').get(req.params.id) as any;
    if (!review) return res.status(404).json({ error: 'Management review not found' });
    const staffId = getStaffIdOrCurrent(req, req.body.approvedByStaffId);
    if (staffId === null) return res.status(400).json({ error: 'This action requires the logged-in user to be linked to a staff record.' });
    db.prepare("UPDATE management_reviews SET status = 'approved', approved_by_staff_id = ?, approved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(staffId, req.params.id);
    audit(req, { action: 'approve', entity: 'management_reviews', entityId: req.params.id, oldValue: { status: review.status }, newValue: { status: 'approved', approvedByStaffId: staffId } });
    res.json({ ok: true });
  });

  router.post('/:id/close', requirePermission('management_review', 'approve'), (req, res) => {
    const db = getDb();
    const review = db.prepare('SELECT * FROM management_reviews WHERE id = ?').get(req.params.id) as any;
    if (!review) return res.status(404).json({ error: 'Management review not found' });
    db.prepare("UPDATE management_reviews SET status = 'closed', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
    audit(req, { action: 'close', entity: 'management_reviews', entityId: req.params.id, oldValue: { status: review.status }, newValue: { status: 'closed' } });
    res.json({ ok: true });
  });

  return router;
}

export { REVIEW_STATUSES };
