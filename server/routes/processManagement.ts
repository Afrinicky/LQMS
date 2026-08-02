import { Router } from 'express';
import multer from 'multer';
import { getDb } from '../db/database.js';
import { requirePermission } from '../middleware/permissions.js';
import { audit } from '../services/auditService.js';
import { generateRecordNumber } from '../utils/recordNumber.js';
import { parseIntNullable, getStaffIdOrCurrent } from './routeHelpers.js';
import { buildWorkbook, sendWorkbook, readSheet, cell } from '../utils/xlsxRegister.js';

const riXlsxUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
const RI_HEADERS = ['Analyte', 'Sample type', 'Population', 'Lower limit', 'Upper limit', 'Unit', 'Clinical decision limit', 'Source', 'Effective date', 'Review date', 'Status'] as const;

const TEST_STATUSES = ['active', 'inactive', 'under_review', 'archived'];
const REJECTION_STATUSES = ['open', 'communicated', 'repeat_requested', 'linked_to_nc', 'closed'];
const CRITICAL_STATUSES = ['pending_notification', 'notified', 'acknowledged', 'escalated', 'closed'];
const ACK_STATUSES = ['pending', 'acknowledged', 'unacknowledged'];
const LAB_STATUSES = ['active', 'inactive', 'suspended', 'archived'];
const SENDOUT_STATUSES = ['sent', 'pending_result', 'result_received', 'delayed', 'issue_flagged', 'closed'];
const AMENDMENT_STATUSES = ['draft', 'authorized', 'communicated', 'linked_to_nc', 'closed'];
const REVIEW_STATUSES = ['draft', 'reviewed', 'approved', 'closed'];

function insertLink(db: any, source: { module: string; type: string; id: string | number }, target: { module: string; type: string; id: string | number }, notes?: string) {
  db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run(source.module, source.type, String(source.id), target.module, target.type, String(target.id), notes ?? null);
}

function createNcFromSource(req: any, recordType: string, sourceId: string | number, fallbackDate: string, fallbackTitle: string, fallbackDesc: string, severity = 'medium') {
  const db = getDb();
  const createdAt = new Date().toISOString();
  const ncNumber = generateRecordNumber(db, 'nonconforming_events', 'NC', createdAt);
  const detectedBy = getStaffIdOrCurrent(req, req.body.detectedByStaffId);
  const ncResult = db.prepare(`INSERT INTO nonconforming_events (nc_number, event_date, detected_by_staff_id, source_module, source_record_id, title, description, category, severity, status, created_by, created_at) VALUES (?, ?, ?, 'process_management', ?, ?, ?, ?, ?, 'open', ?, ?)`)
    .run(ncNumber, req.body.eventDate ?? fallbackDate, detectedBy, String(sourceId), req.body.title ?? fallbackTitle, req.body.description ?? fallbackDesc, req.body.category ?? 'process_management', req.body.severity ?? severity, req.user!.id, createdAt);
  const ncId = Number(ncResult.lastInsertRowid);
  insertLink(db, { module: 'process_management', type: recordType, id: sourceId }, { module: 'nc_capa', type: 'nonconforming_events', id: ncId }, `NC from ${recordType}`);
  audit(req, { action: 'create', entity: 'nonconforming_events', entityId: ncId, newValue: { ncNumber, sourceModule: 'process_management', sourceRecordType: recordType, sourceRecordId: sourceId } });
  return { ncId, ncNumber };
}

function createActionFromSource(req: any, recordType: string, sourceId: string | number, fallbackDesc: string) {
  const db = getDb();
  const result = db.prepare('INSERT INTO actions (title, module_key, source_module, source_record_id, description, priority, assigned_to_staff_id, due_date, status, evidence_required, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(req.body.title, 'process_management', 'process_management', String(sourceId), req.body.description ?? fallbackDesc, req.body.priority ?? 'normal', parseIntNullable(req.body.assignedToStaffId), req.body.dueDate ?? null, 'Not started', req.body.evidenceRequired ? 1 : 0, req.user!.id);
  const actionId = Number(result.lastInsertRowid);
  insertLink(db, { module: 'process_management', type: recordType, id: sourceId }, { module: 'actions', type: 'actions', id: actionId }, `Action from ${recordType}`);
  audit(req, { action: 'create', entity: 'actions', entityId: actionId, newValue: { sourceModule: 'process_management', sourceRecordType: recordType, sourceRecordId: sourceId, ...req.body } });
  return actionId;
}

export function processManagementRoutes() {
  const router = Router();

  // -------- Summary --------
  router.get('/summary', requirePermission('process_management', 'view'), (_req, res) => {
    const db = getDb();
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    const count = (sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { count: number }).count;
    res.json({
      activeTests: count("SELECT COUNT(*) count FROM lab_test_catalog WHERE status = 'active'"),
      activeAcceptanceCriteria: count("SELECT COUNT(*) count FROM specimen_acceptance_criteria WHERE is_active = 1"),
      specimenRejectionsThisMonth: count('SELECT COUNT(*) count FROM specimen_rejection_records WHERE rejection_date >= ?', monthStart),
      openSpecimenRejections: count("SELECT COUNT(*) count FROM specimen_rejection_records WHERE status NOT IN ('closed','linked_to_nc')"),
      criticalResultsThisMonth: count('SELECT COUNT(*) count FROM critical_result_notifications WHERE event_date >= ?', monthStart),
      delayedCriticalNotifications: count("SELECT COUNT(*) count FROM critical_result_notifications WHERE escalation_required = 1 AND status NOT IN ('closed')"),
      referralSendoutsPending: count("SELECT COUNT(*) count FROM referral_sendouts WHERE status IN ('sent','pending_result')"),
      delayedReferralSendouts: count("SELECT COUNT(*) count FROM referral_sendouts WHERE expected_return_date IS NOT NULL AND expected_return_date < ? AND result_received_date IS NULL AND status NOT IN ('closed','result_received')", today),
      reportAmendmentsThisMonth: count('SELECT COUNT(*) count FROM report_amendment_logs WHERE amendment_date >= ?', monthStart),
      pendingProcessReviews: count("SELECT COUNT(*) count FROM process_review_records WHERE status IN ('draft','reviewed')"),
      preExaminationInstructions: count("SELECT COUNT(*) count FROM pre_examination_instructions WHERE status = 'active'"),
      sampleReceiptsThisMonth: count('SELECT COUNT(*) count FROM sample_receipt_records WHERE receipt_date >= ?', monthStart),
      suboptimalReceipts: count("SELECT COUNT(*) count FROM sample_receipt_records WHERE condition = 'suboptimal' AND receipt_date >= ?", monthStart),
      referenceIntervalsDueReview: count("SELECT COUNT(*) count FROM reference_interval_records WHERE status = 'active' AND review_date IS NOT NULL AND review_date <= ?", today),
      comparabilityStudiesDue: count('SELECT COUNT(*) count FROM result_comparability_studies WHERE next_due_date IS NOT NULL AND next_due_date <= ?', today),
      openComparabilityIssues: count("SELECT COUNT(*) count FROM result_comparability_studies WHERE outcome = 'significant_difference' AND status != 'closed'"),
      activeContingencyPlans: count("SELECT COUNT(*) count FROM contingency_plans WHERE status = 'active'"),
      contingencyTestsDue: count("SELECT COUNT(*) count FROM contingency_plans WHERE status = 'active' AND next_test_due IS NOT NULL AND next_test_due <= ?", today)
    });
  });

  // ============= Test catalog =============
  router.get('/tests', requirePermission('process_management.directory', 'view'), (req, res) => {
    const db = getDb();
    const filters: string[] = []; const params: unknown[] = [];
    if (req.query.status) { filters.push('status = ?'); params.push(String(req.query.status)); }
    if (req.query.sectionId) { filters.push('section_id = ?'); params.push(Number(req.query.sectionId)); }
    let query = 'SELECT * FROM lab_test_catalog';
    if (filters.length) query += ` WHERE ${filters.join(' AND ')}`;
    query += ' ORDER BY test_name';
    res.json(db.prepare(query).all(...params));
  });

  router.post('/tests', requirePermission('process_management.directory', 'create'), (req, res) => {
    if (!req.body.testName) return res.status(400).json({ error: 'testName is required' });
    if (!req.body.sampleType) return res.status(400).json({ error: 'sampleType is required' });
    const status = req.body.status ?? 'active';
    if (!TEST_STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${TEST_STATUSES.join(', ')}` });
    const db = getDb();
    const createdAt = new Date().toISOString();
    const testCode = req.body.testCode || generateRecordNumber(db, 'lab_test_catalog', 'TEST', createdAt);
    const result = db.prepare(`INSERT INTO lab_test_catalog (test_code, test_name, department_id, section_id, sample_type, container_type, minimum_volume, method_name, method_summary, equipment_id, tat_target_minutes, reportable_range, reference_interval_summary, critical_result_applicable, document_id, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(testCode, req.body.testName, parseIntNullable(req.body.departmentId), parseIntNullable(req.body.sectionId), req.body.sampleType, req.body.containerType ?? null, req.body.minimumVolume ?? null, req.body.methodName ?? null, req.body.methodSummary ?? null, parseIntNullable(req.body.equipmentId), parseIntNullable(req.body.tatTargetMinutes), req.body.reportableRange ?? null, req.body.referenceIntervalSummary ?? null, req.body.criticalResultApplicable ? 1 : 0, parseIntNullable(req.body.documentId), status, req.user!.id);
    const id = Number(result.lastInsertRowid);
    if (parseIntNullable(req.body.documentId)) insertLink(db, { module: 'process_management', type: 'lab_test_catalog', id }, { module: 'documents', type: 'documents', id: parseIntNullable(req.body.documentId)! }, 'Test SOP/specification');
    audit(req, { action: 'create', entity: 'lab_test_catalog', entityId: id, newValue: { testCode, ...req.body } });
    res.status(201).json({ id, testCode });
  });

  router.get('/tests/:id', requirePermission('process_management.directory', 'view'), (req, res) => {
    const db = getDb();
    const t = db.prepare('SELECT * FROM lab_test_catalog WHERE id = ?').get(req.params.id);
    if (!t) return res.status(404).json({ error: 'Test not found' });
    res.json(t);
  });

  router.put('/tests/:id', requirePermission('process_management.directory', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM lab_test_catalog WHERE id = ?').get(req.params.id) as any;
    if (!oldValue) return res.status(404).json({ error: 'Test not found' });
    if (req.body.status && !TEST_STATUSES.includes(req.body.status)) return res.status(400).json({ error: `status must be one of: ${TEST_STATUSES.join(', ')}` });
    db.prepare(`UPDATE lab_test_catalog SET test_name = ?, department_id = ?, section_id = ?, sample_type = ?, container_type = ?, minimum_volume = ?, method_name = ?, method_summary = ?, equipment_id = ?, tat_target_minutes = ?, reportable_range = ?, reference_interval_summary = ?, critical_result_applicable = ?, document_id = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(req.body.testName ?? oldValue.test_name, parseIntNullable(req.body.departmentId) ?? oldValue.department_id, parseIntNullable(req.body.sectionId) ?? oldValue.section_id, req.body.sampleType ?? oldValue.sample_type, req.body.containerType ?? oldValue.container_type, req.body.minimumVolume ?? oldValue.minimum_volume, req.body.methodName ?? oldValue.method_name, req.body.methodSummary ?? oldValue.method_summary, parseIntNullable(req.body.equipmentId) ?? oldValue.equipment_id, parseIntNullable(req.body.tatTargetMinutes) ?? oldValue.tat_target_minutes, req.body.reportableRange ?? oldValue.reportable_range, req.body.referenceIntervalSummary ?? oldValue.reference_interval_summary, req.body.criticalResultApplicable !== undefined ? (req.body.criticalResultApplicable ? 1 : 0) : oldValue.critical_result_applicable, parseIntNullable(req.body.documentId) ?? oldValue.document_id, req.body.status ?? oldValue.status, req.params.id);
    audit(req, { action: 'edit', entity: 'lab_test_catalog', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  router.post('/tests/:id/toggle', requirePermission('process_management.directory', 'edit'), (req, res) => {
    const db = getDb();
    const t = db.prepare('SELECT * FROM lab_test_catalog WHERE id = ?').get(req.params.id) as any;
    if (!t) return res.status(404).json({ error: 'Test not found' });
    const newStatus = t.status === 'active' ? 'inactive' : 'active';
    db.prepare('UPDATE lab_test_catalog SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(newStatus, req.params.id);
    audit(req, { action: 'toggle', entity: 'lab_test_catalog', entityId: req.params.id, oldValue: { status: t.status }, newValue: { status: newStatus } });
    res.json({ ok: true, status: newStatus });
  });

  // ============= Acceptance criteria =============
  router.get('/acceptance-criteria', requirePermission('process_management.directory', 'view'), (req, res) => {
    const db = getDb();
    const filters: string[] = []; const params: unknown[] = [];
    if (req.query.testCatalogId) { filters.push('test_catalog_id = ?'); params.push(Number(req.query.testCatalogId)); }
    if (req.query.isActive !== undefined) { filters.push('is_active = ?'); params.push(req.query.isActive === 'true' ? 1 : 0); }
    let query = 'SELECT * FROM specimen_acceptance_criteria';
    if (filters.length) query += ` WHERE ${filters.join(' AND ')}`;
    query += ' ORDER BY sample_type, container_type';
    res.json(db.prepare(query).all(...params));
  });

  router.post('/acceptance-criteria', requirePermission('process_management.directory', 'create'), (req, res) => {
    if (!req.body.sampleType) return res.status(400).json({ error: 'sampleType is required' });
    if (!req.body.acceptanceCriteria) return res.status(400).json({ error: 'acceptanceCriteria is required' });
    const db = getDb();
    const result = db.prepare(`INSERT INTO specimen_acceptance_criteria (criteria_code, test_catalog_id, sample_type, container_type, acceptance_criteria, rejection_criteria, transport_condition, stability_summary, document_id, is_active, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(req.body.criteriaCode ?? null, parseIntNullable(req.body.testCatalogId), req.body.sampleType, req.body.containerType ?? null, req.body.acceptanceCriteria, req.body.rejectionCriteria ?? null, req.body.transportCondition ?? null, req.body.stabilitySummary ?? null, parseIntNullable(req.body.documentId), req.body.isActive === false ? 0 : 1, req.user!.id);
    const id = Number(result.lastInsertRowid);
    if (parseIntNullable(req.body.documentId)) insertLink(db, { module: 'process_management', type: 'specimen_acceptance_criteria', id }, { module: 'documents', type: 'documents', id: parseIntNullable(req.body.documentId)! }, 'Acceptance criteria SOP');
    audit(req, { action: 'create', entity: 'specimen_acceptance_criteria', entityId: id, newValue: req.body });
    res.status(201).json({ id });
  });

  router.get('/acceptance-criteria/:id', requirePermission('process_management.directory', 'view'), (req, res) => {
    const db = getDb();
    const c = db.prepare('SELECT * FROM specimen_acceptance_criteria WHERE id = ?').get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Acceptance criteria not found' });
    res.json(c);
  });

  router.put('/acceptance-criteria/:id', requirePermission('process_management.directory', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM specimen_acceptance_criteria WHERE id = ?').get(req.params.id) as any;
    if (!oldValue) return res.status(404).json({ error: 'Acceptance criteria not found' });
    db.prepare(`UPDATE specimen_acceptance_criteria SET test_catalog_id = ?, sample_type = ?, container_type = ?, acceptance_criteria = ?, rejection_criteria = ?, transport_condition = ?, stability_summary = ?, document_id = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(parseIntNullable(req.body.testCatalogId) ?? oldValue.test_catalog_id, req.body.sampleType ?? oldValue.sample_type, req.body.containerType ?? oldValue.container_type, req.body.acceptanceCriteria ?? oldValue.acceptance_criteria, req.body.rejectionCriteria ?? oldValue.rejection_criteria, req.body.transportCondition ?? oldValue.transport_condition, req.body.stabilitySummary ?? oldValue.stability_summary, parseIntNullable(req.body.documentId) ?? oldValue.document_id, req.body.isActive !== undefined ? (req.body.isActive ? 1 : 0) : oldValue.is_active, req.params.id);
    audit(req, { action: 'edit', entity: 'specimen_acceptance_criteria', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  router.post('/acceptance-criteria/:id/toggle', requirePermission('process_management.directory', 'edit'), (req, res) => {
    const db = getDb();
    const c = db.prepare('SELECT * FROM specimen_acceptance_criteria WHERE id = ?').get(req.params.id) as any;
    if (!c) return res.status(404).json({ error: 'Acceptance criteria not found' });
    const newActive = c.is_active ? 0 : 1;
    db.prepare('UPDATE specimen_acceptance_criteria SET is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(newActive, req.params.id);
    audit(req, { action: 'toggle', entity: 'specimen_acceptance_criteria', entityId: req.params.id, oldValue: { is_active: c.is_active }, newValue: { is_active: newActive } });
    res.json({ ok: true, isActive: newActive === 1 });
  });

  // ============= Specimen rejections =============
  router.get('/specimen-rejections', requirePermission('process_management', 'view'), (req, res) => {
    const db = getDb();
    const filters: string[] = []; const params: unknown[] = [];
    if (req.query.status) { filters.push('status = ?'); params.push(String(req.query.status)); }
    let query = 'SELECT * FROM specimen_rejection_records';
    if (filters.length) query += ` WHERE ${filters.join(' AND ')}`;
    query += ' ORDER BY rejection_date DESC, id DESC';
    res.json(db.prepare(query).all(...params));
  });

  router.post('/specimen-rejections', requirePermission('process_management', 'create'), (req, res) => {
    if (!req.body.rejectionDate) return res.status(400).json({ error: 'rejectionDate is required' });
    if (!req.body.rejectionReason) return res.status(400).json({ error: 'rejectionReason is required' });
    const db = getDb();
    const createdAt = new Date().toISOString();
    const rejectionNumber = generateRecordNumber(db, 'specimen_rejection_records', 'SREC', createdAt);
    const rejectedBy = getStaffIdOrCurrent(req, req.body.rejectedByStaffId);
    const result = db.prepare(`INSERT INTO specimen_rejection_records (rejection_number, rejection_date, request_reference, patient_reference, patient_type, department_id, section_id, test_catalog_id, test_name, sample_type, rejection_reason, rejected_by_staff_id, communicated_to, communication_date, immediate_action, repeat_sample_requested, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(rejectionNumber, req.body.rejectionDate, req.body.requestReference ?? null, req.body.patientReference ?? null, req.body.patientType ?? null, parseIntNullable(req.body.departmentId), parseIntNullable(req.body.sectionId), parseIntNullable(req.body.testCatalogId), req.body.testName ?? null, req.body.sampleType ?? null, req.body.rejectionReason, rejectedBy, req.body.communicatedTo ?? null, req.body.communicationDate ?? null, req.body.immediateAction ?? null, req.body.repeatSampleRequested ? 1 : 0, 'open', req.user!.id, createdAt);
    const id = Number(result.lastInsertRowid);
    audit(req, { action: 'create', entity: 'specimen_rejection_records', entityId: id, newValue: { rejectionNumber, ...req.body } });
    res.status(201).json({ id, rejectionNumber });
  });

  router.get('/specimen-rejections/:id', requirePermission('process_management', 'view'), (req, res) => {
    const db = getDb();
    const r = db.prepare('SELECT * FROM specimen_rejection_records WHERE id = ?').get(req.params.id);
    if (!r) return res.status(404).json({ error: 'Rejection not found' });
    res.json(r);
  });

  router.put('/specimen-rejections/:id', requirePermission('process_management', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM specimen_rejection_records WHERE id = ?').get(req.params.id) as any;
    if (!oldValue) return res.status(404).json({ error: 'Rejection not found' });
    if (req.body.status && !REJECTION_STATUSES.includes(req.body.status)) return res.status(400).json({ error: `status must be one of: ${REJECTION_STATUSES.join(', ')}` });
    db.prepare(`UPDATE specimen_rejection_records SET rejection_date = ?, request_reference = ?, patient_reference = ?, test_catalog_id = ?, test_name = ?, sample_type = ?, rejection_reason = ?, communicated_to = ?, communication_date = ?, immediate_action = ?, repeat_sample_requested = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(req.body.rejectionDate ?? oldValue.rejection_date, req.body.requestReference ?? oldValue.request_reference, req.body.patientReference ?? oldValue.patient_reference, parseIntNullable(req.body.testCatalogId) ?? oldValue.test_catalog_id, req.body.testName ?? oldValue.test_name, req.body.sampleType ?? oldValue.sample_type, req.body.rejectionReason ?? oldValue.rejection_reason, req.body.communicatedTo ?? oldValue.communicated_to, req.body.communicationDate ?? oldValue.communication_date, req.body.immediateAction ?? oldValue.immediate_action, req.body.repeatSampleRequested !== undefined ? (req.body.repeatSampleRequested ? 1 : 0) : oldValue.repeat_sample_requested, req.body.status ?? oldValue.status, req.params.id);
    audit(req, { action: 'edit', entity: 'specimen_rejection_records', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  router.post('/specimen-rejections/:id/create-nc', requirePermission('nc_capa', 'create'), (req, res) => {
    const db = getDb();
    const r = db.prepare('SELECT * FROM specimen_rejection_records WHERE id = ?').get(req.params.id) as any;
    if (!r) return res.status(404).json({ error: 'Rejection not found' });
    const { ncId, ncNumber } = createNcFromSource(req, 'specimen_rejection_records', r.id, r.rejection_date, `Specimen rejection: ${r.rejection_number}`, r.rejection_reason);
    db.prepare("UPDATE specimen_rejection_records SET linked_nc_id = ?, status = 'linked_to_nc', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(ncId, req.params.id);
    res.status(201).json({ id: ncId, ncNumber });
  });

  router.post('/specimen-rejections/:id/create-action', requirePermission('actions', 'create'), (req, res) => {
    if (!req.body.title) return res.status(400).json({ error: 'title is required' });
    const db = getDb();
    const r = db.prepare('SELECT * FROM specimen_rejection_records WHERE id = ?').get(req.params.id) as any;
    if (!r) return res.status(404).json({ error: 'Rejection not found' });
    const actionId = createActionFromSource(req, 'specimen_rejection_records', r.id, r.rejection_reason);
    db.prepare('UPDATE specimen_rejection_records SET linked_action_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(actionId, req.params.id);
    res.status(201).json({ id: actionId });
  });

  router.post('/specimen-rejections/:id/close', requirePermission('process_management', 'approve'), (req, res) => {
    const db = getDb();
    const r = db.prepare('SELECT * FROM specimen_rejection_records WHERE id = ?').get(req.params.id) as any;
    if (!r) return res.status(404).json({ error: 'Rejection not found' });
    db.prepare("UPDATE specimen_rejection_records SET status = 'closed', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
    audit(req, { action: 'close', entity: 'specimen_rejection_records', entityId: req.params.id, oldValue: { status: r.status }, newValue: { status: 'closed' } });
    res.json({ ok: true });
  });

  // ============= Critical result rules =============
  router.get('/critical-result-rules', requirePermission('process_management.critical', 'view'), (_req, res) => {
    const db = getDb();
    res.json(db.prepare('SELECT * FROM critical_result_rules ORDER BY analyte_name').all());
  });

  router.post('/critical-result-rules', requirePermission('process_management.critical', 'create'), (req, res) => {
    if (!parseIntNullable(req.body.testCatalogId)) return res.status(400).json({ error: 'testCatalogId is required' });
    if (!req.body.analyteName) return res.status(400).json({ error: 'analyteName is required' });
    const db = getDb();
    const result = db.prepare(`INSERT INTO critical_result_rules (rule_code, test_catalog_id, analyte_name, unit, low_critical_value, high_critical_value, notification_timeframe_minutes, escalation_instruction, is_active, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(req.body.ruleCode ?? null, req.body.testCatalogId, req.body.analyteName, req.body.unit ?? null, req.body.lowCriticalValue !== undefined && req.body.lowCriticalValue !== '' ? Number(req.body.lowCriticalValue) : null, req.body.highCriticalValue !== undefined && req.body.highCriticalValue !== '' ? Number(req.body.highCriticalValue) : null, parseIntNullable(req.body.notificationTimeframeMinutes), req.body.escalationInstruction ?? null, req.body.isActive === false ? 0 : 1, req.user!.id);
    const id = Number(result.lastInsertRowid);
    audit(req, { action: 'create', entity: 'critical_result_rules', entityId: id, newValue: req.body });
    res.status(201).json({ id });
  });

  router.get('/critical-result-rules/:id', requirePermission('process_management.critical', 'view'), (req, res) => {
    const db = getDb();
    const r = db.prepare('SELECT * FROM critical_result_rules WHERE id = ?').get(req.params.id);
    if (!r) return res.status(404).json({ error: 'Rule not found' });
    res.json(r);
  });

  router.put('/critical-result-rules/:id', requirePermission('process_management.critical', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM critical_result_rules WHERE id = ?').get(req.params.id) as any;
    if (!oldValue) return res.status(404).json({ error: 'Rule not found' });
    db.prepare(`UPDATE critical_result_rules SET test_catalog_id = ?, analyte_name = ?, unit = ?, low_critical_value = ?, high_critical_value = ?, notification_timeframe_minutes = ?, escalation_instruction = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(parseIntNullable(req.body.testCatalogId) ?? oldValue.test_catalog_id, req.body.analyteName ?? oldValue.analyte_name, req.body.unit ?? oldValue.unit, req.body.lowCriticalValue !== undefined && req.body.lowCriticalValue !== '' ? Number(req.body.lowCriticalValue) : oldValue.low_critical_value, req.body.highCriticalValue !== undefined && req.body.highCriticalValue !== '' ? Number(req.body.highCriticalValue) : oldValue.high_critical_value, parseIntNullable(req.body.notificationTimeframeMinutes) ?? oldValue.notification_timeframe_minutes, req.body.escalationInstruction ?? oldValue.escalation_instruction, req.body.isActive !== undefined ? (req.body.isActive ? 1 : 0) : oldValue.is_active, req.params.id);
    audit(req, { action: 'edit', entity: 'critical_result_rules', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  router.post('/critical-result-rules/:id/toggle', requirePermission('process_management.critical', 'edit'), (req, res) => {
    const db = getDb();
    const r = db.prepare('SELECT * FROM critical_result_rules WHERE id = ?').get(req.params.id) as any;
    if (!r) return res.status(404).json({ error: 'Rule not found' });
    const newActive = r.is_active ? 0 : 1;
    db.prepare('UPDATE critical_result_rules SET is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(newActive, req.params.id);
    audit(req, { action: 'toggle', entity: 'critical_result_rules', entityId: req.params.id, oldValue: { is_active: r.is_active }, newValue: { is_active: newActive } });
    res.json({ ok: true, isActive: newActive === 1 });
  });

  // ============= Critical result notifications =============
  router.get('/critical-results', requirePermission('process_management.critical', 'view'), (req, res) => {
    const db = getDb();
    const filters: string[] = []; const params: unknown[] = [];
    if (req.query.status) { filters.push('status = ?'); params.push(String(req.query.status)); }
    let query = 'SELECT * FROM critical_result_notifications';
    if (filters.length) query += ` WHERE ${filters.join(' AND ')}`;
    query += ' ORDER BY event_date DESC, event_time DESC, id DESC LIMIT 500';
    res.json(db.prepare(query).all(...params));
  });

  router.post('/critical-results', requirePermission('process_management.critical', 'create'), (req, res) => {
    if (!req.body.eventDate) return res.status(400).json({ error: 'eventDate is required' });
    if (!req.body.eventTime) return res.status(400).json({ error: 'eventTime is required' });
    if (!req.body.analyteName) return res.status(400).json({ error: 'analyteName is required' });
    if (req.body.resultValue === undefined || req.body.resultValue === null || req.body.resultValue === '') return res.status(400).json({ error: 'resultValue is required' });
    const db = getDb();
    let escalationRequired = req.body.escalationRequired ? 1 : 0;
    if (parseIntNullable(req.body.criticalRuleId) && req.body.notificationTime) {
      const rule = db.prepare('SELECT notification_timeframe_minutes FROM critical_result_rules WHERE id = ?').get(parseIntNullable(req.body.criticalRuleId)) as any;
      if (rule?.notification_timeframe_minutes) {
        const eventTs = Date.parse(`${req.body.eventDate}T${req.body.eventTime}`);
        const notifTs = Date.parse(`${req.body.eventDate}T${req.body.notificationTime}`);
        if (Number.isFinite(eventTs) && Number.isFinite(notifTs)) {
          const diffMin = (notifTs - eventTs) / 60000;
          if (diffMin > rule.notification_timeframe_minutes) escalationRequired = 1;
        }
      }
    }
    const createdAt = new Date().toISOString();
    const notifNumber = generateRecordNumber(db, 'critical_result_notifications', 'CRIT', createdAt);
    const notifiedBy = getStaffIdOrCurrent(req, req.body.notifiedByStaffId);
    const status = req.body.notificationTime ? (escalationRequired ? 'escalated' : 'notified') : 'pending_notification';
    const result = db.prepare(`INSERT INTO critical_result_notifications (notification_number, event_date, event_time, request_reference, patient_reference, patient_type, department_id, section_id, test_catalog_id, analyte_name, result_value, unit, critical_rule_id, notified_to, notification_method, notified_by_staff_id, notification_time, read_back_confirmed, acknowledgement_status, escalation_required, escalation_notes, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`)
      .run(notifNumber, req.body.eventDate, req.body.eventTime, req.body.requestReference ?? null, req.body.patientReference ?? null, req.body.patientType ?? null, parseIntNullable(req.body.departmentId), parseIntNullable(req.body.sectionId), parseIntNullable(req.body.testCatalogId), req.body.analyteName, String(req.body.resultValue), req.body.unit ?? null, parseIntNullable(req.body.criticalRuleId), req.body.notifiedTo ?? null, req.body.notificationMethod ?? null, notifiedBy, req.body.notificationTime ?? null, req.body.readBackConfirmed ? 1 : 0, escalationRequired, req.body.escalationNotes ?? null, status, req.user!.id, createdAt);
    const id = Number(result.lastInsertRowid);
    audit(req, { action: 'create', entity: 'critical_result_notifications', entityId: id, newValue: { notifNumber, escalationRequired, status, ...req.body } });
    res.status(201).json({ id, notificationNumber: notifNumber, escalationRequired: !!escalationRequired, status });
  });

  router.get('/critical-results/:id', requirePermission('process_management.critical', 'view'), (req, res) => {
    const db = getDb();
    const c = db.prepare('SELECT * FROM critical_result_notifications WHERE id = ?').get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Notification not found' });
    res.json(c);
  });

  router.put('/critical-results/:id', requirePermission('process_management.critical', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM critical_result_notifications WHERE id = ?').get(req.params.id) as any;
    if (!oldValue) return res.status(404).json({ error: 'Notification not found' });
    if (req.body.status && !CRITICAL_STATUSES.includes(req.body.status)) return res.status(400).json({ error: `status must be one of: ${CRITICAL_STATUSES.join(', ')}` });
    db.prepare(`UPDATE critical_result_notifications SET notified_to = ?, notification_method = ?, notified_by_staff_id = ?, notification_time = ?, read_back_confirmed = ?, escalation_required = ?, escalation_notes = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(req.body.notifiedTo ?? oldValue.notified_to, req.body.notificationMethod ?? oldValue.notification_method, parseIntNullable(req.body.notifiedByStaffId) ?? oldValue.notified_by_staff_id, req.body.notificationTime ?? oldValue.notification_time, req.body.readBackConfirmed !== undefined ? (req.body.readBackConfirmed ? 1 : 0) : oldValue.read_back_confirmed, req.body.escalationRequired !== undefined ? (req.body.escalationRequired ? 1 : 0) : oldValue.escalation_required, req.body.escalationNotes ?? oldValue.escalation_notes, req.body.status ?? oldValue.status, req.params.id);
    audit(req, { action: 'edit', entity: 'critical_result_notifications', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  router.post('/critical-results/:id/acknowledge', requirePermission('process_management.critical', 'edit'), (req, res) => {
    const db = getDb();
    const c = db.prepare('SELECT * FROM critical_result_notifications WHERE id = ?').get(req.params.id) as any;
    if (!c) return res.status(404).json({ error: 'Notification not found' });
    db.prepare("UPDATE critical_result_notifications SET acknowledgement_status = 'acknowledged', status = 'acknowledged', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
    audit(req, { action: 'acknowledge', entity: 'critical_result_notifications', entityId: req.params.id, oldValue: { status: c.status }, newValue: { status: 'acknowledged' } });
    res.json({ ok: true });
  });

  router.post('/critical-results/:id/create-nc', requirePermission('nc_capa', 'create'), (req, res) => {
    const db = getDb();
    const c = db.prepare('SELECT * FROM critical_result_notifications WHERE id = ?').get(req.params.id) as any;
    if (!c) return res.status(404).json({ error: 'Notification not found' });
    const { ncId, ncNumber } = createNcFromSource(req, 'critical_result_notifications', c.id, c.event_date, `Critical result notification issue: ${c.notification_number}`, `${c.analyte_name} = ${c.result_value}${c.unit ? ' ' + c.unit : ''}`, c.escalation_required ? 'high' : 'medium');
    db.prepare('UPDATE critical_result_notifications SET linked_nc_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(ncId, req.params.id);
    res.status(201).json({ id: ncId, ncNumber });
  });

  router.post('/critical-results/:id/create-action', requirePermission('actions', 'create'), (req, res) => {
    if (!req.body.title) return res.status(400).json({ error: 'title is required' });
    const db = getDb();
    const c = db.prepare('SELECT * FROM critical_result_notifications WHERE id = ?').get(req.params.id) as any;
    if (!c) return res.status(404).json({ error: 'Notification not found' });
    const actionId = createActionFromSource(req, 'critical_result_notifications', c.id, `${c.analyte_name} = ${c.result_value}`);
    db.prepare('UPDATE critical_result_notifications SET linked_action_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(actionId, req.params.id);
    res.status(201).json({ id: actionId });
  });

  router.post('/critical-results/:id/close', requirePermission('process_management.critical', 'approve'), (req, res) => {
    const db = getDb();
    const c = db.prepare('SELECT * FROM critical_result_notifications WHERE id = ?').get(req.params.id) as any;
    if (!c) return res.status(404).json({ error: 'Notification not found' });
    db.prepare("UPDATE critical_result_notifications SET status = 'closed', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
    audit(req, { action: 'close', entity: 'critical_result_notifications', entityId: req.params.id, oldValue: { status: c.status }, newValue: { status: 'closed' } });
    res.json({ ok: true });
  });

  // ============= Referral laboratories =============
  router.get('/referral-labs', requirePermission('process_management.referrals', 'view'), (_req, res) => {
    const db = getDb();
    res.json(db.prepare('SELECT * FROM referral_laboratories ORDER BY referral_lab_name').all());
  });

  router.post('/referral-labs', requirePermission('process_management.referrals', 'create'), (req, res) => {
    if (!req.body.referralLabName) return res.status(400).json({ error: 'referralLabName is required' });
    const status = req.body.status ?? 'active';
    if (!LAB_STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${LAB_STATUSES.join(', ')}` });
    const db = getDb();
    const createdAt = new Date().toISOString();
    const labCode = req.body.referralLabCode || generateRecordNumber(db, 'referral_laboratories', 'RLAB', createdAt);
    const result = db.prepare(`INSERT INTO referral_laboratories (referral_lab_code, referral_lab_name, contact_person, phone, email, address, service_scope, accreditation_or_approval_note, agreement_document_id, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(labCode, req.body.referralLabName, req.body.contactPerson ?? null, req.body.phone ?? null, req.body.email ?? null, req.body.address ?? null, req.body.serviceScope ?? null, req.body.accreditationOrApprovalNote ?? null, parseIntNullable(req.body.agreementDocumentId), status, req.user!.id);
    const id = Number(result.lastInsertRowid);
    if (parseIntNullable(req.body.agreementDocumentId)) insertLink(db, { module: 'process_management', type: 'referral_laboratories', id }, { module: 'documents', type: 'documents', id: parseIntNullable(req.body.agreementDocumentId)! }, 'Referral lab agreement');
    audit(req, { action: 'create', entity: 'referral_laboratories', entityId: id, newValue: { labCode, ...req.body } });
    res.status(201).json({ id, referralLabCode: labCode });
  });

  router.get('/referral-labs/:id', requirePermission('process_management.referrals', 'view'), (req, res) => {
    const db = getDb();
    const l = db.prepare('SELECT * FROM referral_laboratories WHERE id = ?').get(req.params.id);
    if (!l) return res.status(404).json({ error: 'Lab not found' });
    res.json(l);
  });

  router.put('/referral-labs/:id', requirePermission('process_management.referrals', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM referral_laboratories WHERE id = ?').get(req.params.id) as any;
    if (!oldValue) return res.status(404).json({ error: 'Lab not found' });
    if (req.body.status && !LAB_STATUSES.includes(req.body.status)) return res.status(400).json({ error: `status must be one of: ${LAB_STATUSES.join(', ')}` });
    db.prepare(`UPDATE referral_laboratories SET referral_lab_name = ?, contact_person = ?, phone = ?, email = ?, address = ?, service_scope = ?, accreditation_or_approval_note = ?, agreement_document_id = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(req.body.referralLabName ?? oldValue.referral_lab_name, req.body.contactPerson ?? oldValue.contact_person, req.body.phone ?? oldValue.phone, req.body.email ?? oldValue.email, req.body.address ?? oldValue.address, req.body.serviceScope ?? oldValue.service_scope, req.body.accreditationOrApprovalNote ?? oldValue.accreditation_or_approval_note, parseIntNullable(req.body.agreementDocumentId) ?? oldValue.agreement_document_id, req.body.status ?? oldValue.status, req.params.id);
    audit(req, { action: 'edit', entity: 'referral_laboratories', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  router.post('/referral-labs/:id/status', requirePermission('process_management.referrals', 'edit'), (req, res) => {
    if (!req.body.status || !LAB_STATUSES.includes(req.body.status)) return res.status(400).json({ error: `status must be one of: ${LAB_STATUSES.join(', ')}` });
    const db = getDb();
    const l = db.prepare('SELECT * FROM referral_laboratories WHERE id = ?').get(req.params.id) as any;
    if (!l) return res.status(404).json({ error: 'Lab not found' });
    db.prepare('UPDATE referral_laboratories SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.body.status, req.params.id);
    audit(req, { action: 'status_change', entity: 'referral_laboratories', entityId: req.params.id, oldValue: { status: l.status }, newValue: { status: req.body.status } });
    res.json({ ok: true });
  });

  // ============= Referral tests =============
  router.get('/referral-tests', requirePermission('process_management.referrals', 'view'), (req, res) => {
    const db = getDb();
    const filters: string[] = []; const params: unknown[] = [];
    if (req.query.referralLabId) { filters.push('referral_lab_id = ?'); params.push(Number(req.query.referralLabId)); }
    let query = 'SELECT * FROM referral_tests';
    if (filters.length) query += ` WHERE ${filters.join(' AND ')}`;
    query += ' ORDER BY referral_test_name';
    res.json(db.prepare(query).all(...params));
  });

  router.post('/referral-tests', requirePermission('process_management.referrals', 'create'), (req, res) => {
    if (!parseIntNullable(req.body.referralLabId)) return res.status(400).json({ error: 'referralLabId is required' });
    if (!req.body.referralTestName) return res.status(400).json({ error: 'referralTestName is required' });
    const db = getDb();
    const result = db.prepare(`INSERT INTO referral_tests (referral_lab_id, test_catalog_id, referral_test_name, sample_requirement, expected_tat_days, transport_condition, cost_note, is_active, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(req.body.referralLabId, parseIntNullable(req.body.testCatalogId), req.body.referralTestName, req.body.sampleRequirement ?? null, parseIntNullable(req.body.expectedTatDays), req.body.transportCondition ?? null, req.body.costNote ?? null, req.body.isActive === false ? 0 : 1, req.user!.id);
    const id = Number(result.lastInsertRowid);
    audit(req, { action: 'create', entity: 'referral_tests', entityId: id, newValue: req.body });
    res.status(201).json({ id });
  });

  router.get('/referral-tests/:id', requirePermission('process_management.referrals', 'view'), (req, res) => {
    const db = getDb();
    const t = db.prepare('SELECT * FROM referral_tests WHERE id = ?').get(req.params.id);
    if (!t) return res.status(404).json({ error: 'Referral test not found' });
    res.json(t);
  });

  router.put('/referral-tests/:id', requirePermission('process_management.referrals', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM referral_tests WHERE id = ?').get(req.params.id) as any;
    if (!oldValue) return res.status(404).json({ error: 'Referral test not found' });
    db.prepare(`UPDATE referral_tests SET test_catalog_id = ?, referral_test_name = ?, sample_requirement = ?, expected_tat_days = ?, transport_condition = ?, cost_note = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(parseIntNullable(req.body.testCatalogId) ?? oldValue.test_catalog_id, req.body.referralTestName ?? oldValue.referral_test_name, req.body.sampleRequirement ?? oldValue.sample_requirement, parseIntNullable(req.body.expectedTatDays) ?? oldValue.expected_tat_days, req.body.transportCondition ?? oldValue.transport_condition, req.body.costNote ?? oldValue.cost_note, req.body.isActive !== undefined ? (req.body.isActive ? 1 : 0) : oldValue.is_active, req.params.id);
    audit(req, { action: 'edit', entity: 'referral_tests', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  router.post('/referral-tests/:id/toggle', requirePermission('process_management.referrals', 'edit'), (req, res) => {
    const db = getDb();
    const t = db.prepare('SELECT * FROM referral_tests WHERE id = ?').get(req.params.id) as any;
    if (!t) return res.status(404).json({ error: 'Referral test not found' });
    const newActive = t.is_active ? 0 : 1;
    db.prepare('UPDATE referral_tests SET is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(newActive, req.params.id);
    audit(req, { action: 'toggle', entity: 'referral_tests', entityId: req.params.id, oldValue: { is_active: t.is_active }, newValue: { is_active: newActive } });
    res.json({ ok: true, isActive: newActive === 1 });
  });

  // ============= Referral sendouts =============
  router.get('/referral-sendouts', requirePermission('process_management.referrals', 'view'), (req, res) => {
    const db = getDb();
    const filters: string[] = []; const params: unknown[] = [];
    if (req.query.status) { filters.push('status = ?'); params.push(String(req.query.status)); }
    if (req.query.referralLabId) { filters.push('referral_lab_id = ?'); params.push(Number(req.query.referralLabId)); }
    let query = 'SELECT * FROM referral_sendouts';
    if (filters.length) query += ` WHERE ${filters.join(' AND ')}`;
    query += ' ORDER BY sendout_date DESC, id DESC LIMIT 500';
    const rows = db.prepare(query).all(...params) as any[];
    const today = new Date().toISOString().slice(0, 10);
    res.json(rows.map(r => ({ ...r, _delayed: r.expected_return_date && r.expected_return_date < today && !r.result_received_date && r.status !== 'closed' })));
  });

  router.post('/referral-sendouts', requirePermission('process_management.referrals', 'create'), (req, res) => {
    if (!req.body.sendoutDate) return res.status(400).json({ error: 'sendoutDate is required' });
    if (!parseIntNullable(req.body.referralLabId)) return res.status(400).json({ error: 'referralLabId is required' });
    const db = getDb();
    const createdAt = new Date().toISOString();
    const sendoutNumber = generateRecordNumber(db, 'referral_sendouts', 'RSEND', createdAt);
    const result = db.prepare(`INSERT INTO referral_sendouts (sendout_number, sendout_date, referral_lab_id, referral_test_id, request_reference, patient_reference, patient_type, sample_type, courier_or_transport, expected_return_date, result_received_date, result_summary, issue_noted, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(sendoutNumber, req.body.sendoutDate, req.body.referralLabId, parseIntNullable(req.body.referralTestId), req.body.requestReference ?? null, req.body.patientReference ?? null, req.body.patientType ?? null, req.body.sampleType ?? null, req.body.courierOrTransport ?? null, req.body.expectedReturnDate ?? null, req.body.resultReceivedDate ?? null, req.body.resultSummary ?? null, req.body.issueNoted ?? null, req.body.status ?? 'sent', req.user!.id, createdAt);
    const id = Number(result.lastInsertRowid);
    audit(req, { action: 'create', entity: 'referral_sendouts', entityId: id, newValue: { sendoutNumber, ...req.body } });
    res.status(201).json({ id, sendoutNumber });
  });

  router.get('/referral-sendouts/:id', requirePermission('process_management.referrals', 'view'), (req, res) => {
    const db = getDb();
    const s = db.prepare('SELECT * FROM referral_sendouts WHERE id = ?').get(req.params.id);
    if (!s) return res.status(404).json({ error: 'Sendout not found' });
    res.json(s);
  });

  router.put('/referral-sendouts/:id', requirePermission('process_management.referrals', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM referral_sendouts WHERE id = ?').get(req.params.id) as any;
    if (!oldValue) return res.status(404).json({ error: 'Sendout not found' });
    if (req.body.status && !SENDOUT_STATUSES.includes(req.body.status)) return res.status(400).json({ error: `status must be one of: ${SENDOUT_STATUSES.join(', ')}` });
    db.prepare(`UPDATE referral_sendouts SET sendout_date = ?, referral_lab_id = ?, referral_test_id = ?, request_reference = ?, patient_reference = ?, sample_type = ?, courier_or_transport = ?, expected_return_date = ?, result_received_date = ?, result_summary = ?, issue_noted = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(req.body.sendoutDate ?? oldValue.sendout_date, parseIntNullable(req.body.referralLabId) ?? oldValue.referral_lab_id, parseIntNullable(req.body.referralTestId) ?? oldValue.referral_test_id, req.body.requestReference ?? oldValue.request_reference, req.body.patientReference ?? oldValue.patient_reference, req.body.sampleType ?? oldValue.sample_type, req.body.courierOrTransport ?? oldValue.courier_or_transport, req.body.expectedReturnDate ?? oldValue.expected_return_date, req.body.resultReceivedDate ?? oldValue.result_received_date, req.body.resultSummary ?? oldValue.result_summary, req.body.issueNoted ?? oldValue.issue_noted, req.body.status ?? oldValue.status, req.params.id);
    audit(req, { action: 'edit', entity: 'referral_sendouts', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  router.post('/referral-sendouts/:id/create-nc', requirePermission('nc_capa', 'create'), (req, res) => {
    const db = getDb();
    const s = db.prepare('SELECT * FROM referral_sendouts WHERE id = ?').get(req.params.id) as any;
    if (!s) return res.status(404).json({ error: 'Sendout not found' });
    const { ncId, ncNumber } = createNcFromSource(req, 'referral_sendouts', s.id, s.sendout_date, `Referral sendout issue: ${s.sendout_number}`, s.issue_noted ?? 'Issue with referral sendout');
    db.prepare("UPDATE referral_sendouts SET linked_nc_id = ?, status = 'issue_flagged', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(ncId, req.params.id);
    res.status(201).json({ id: ncId, ncNumber });
  });

  router.post('/referral-sendouts/:id/create-action', requirePermission('actions', 'create'), (req, res) => {
    if (!req.body.title) return res.status(400).json({ error: 'title is required' });
    const db = getDb();
    const s = db.prepare('SELECT * FROM referral_sendouts WHERE id = ?').get(req.params.id) as any;
    if (!s) return res.status(404).json({ error: 'Sendout not found' });
    const actionId = createActionFromSource(req, 'referral_sendouts', s.id, s.issue_noted ?? '');
    db.prepare('UPDATE referral_sendouts SET linked_action_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(actionId, req.params.id);
    res.status(201).json({ id: actionId });
  });

  router.post('/referral-sendouts/:id/close', requirePermission('process_management.referrals', 'approve'), (req, res) => {
    const db = getDb();
    const s = db.prepare('SELECT * FROM referral_sendouts WHERE id = ?').get(req.params.id) as any;
    if (!s) return res.status(404).json({ error: 'Sendout not found' });
    db.prepare("UPDATE referral_sendouts SET status = 'closed', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
    audit(req, { action: 'close', entity: 'referral_sendouts', entityId: req.params.id, oldValue: { status: s.status }, newValue: { status: 'closed' } });
    res.json({ ok: true });
  });

  // ============= Report amendments =============
  router.get('/report-amendments', requirePermission('process_management.amendments', 'view'), (req, res) => {
    const db = getDb();
    const filters: string[] = []; const params: unknown[] = [];
    if (req.query.status) { filters.push('status = ?'); params.push(String(req.query.status)); }
    let query = 'SELECT * FROM report_amendment_logs';
    if (filters.length) query += ` WHERE ${filters.join(' AND ')}`;
    query += ' ORDER BY amendment_date DESC, id DESC';
    res.json(db.prepare(query).all(...params));
  });

  router.post('/report-amendments', requirePermission('process_management.amendments', 'create'), (req, res) => {
    if (!req.body.amendmentDate) return res.status(400).json({ error: 'amendmentDate is required' });
    if (!req.body.reasonForAmendment) return res.status(400).json({ error: 'reasonForAmendment is required' });
    const db = getDb();
    const createdAt = new Date().toISOString();
    const amendmentNumber = generateRecordNumber(db, 'report_amendment_logs', 'RAMD', createdAt);
    const result = db.prepare(`INSERT INTO report_amendment_logs (amendment_number, amendment_date, request_reference, patient_reference, patient_type, department_id, section_id, test_catalog_id, reason_for_amendment, original_report_summary, amended_report_summary, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`)
      .run(amendmentNumber, req.body.amendmentDate, req.body.requestReference ?? null, req.body.patientReference ?? null, req.body.patientType ?? null, parseIntNullable(req.body.departmentId), parseIntNullable(req.body.sectionId), parseIntNullable(req.body.testCatalogId), req.body.reasonForAmendment, req.body.originalReportSummary ?? null, req.body.amendedReportSummary ?? null, req.user!.id, createdAt);
    const id = Number(result.lastInsertRowid);
    audit(req, { action: 'create', entity: 'report_amendment_logs', entityId: id, newValue: { amendmentNumber, ...req.body } });
    res.status(201).json({ id, amendmentNumber });
  });

  router.get('/report-amendments/:id', requirePermission('process_management.amendments', 'view'), (req, res) => {
    const db = getDb();
    const a = db.prepare('SELECT * FROM report_amendment_logs WHERE id = ?').get(req.params.id);
    if (!a) return res.status(404).json({ error: 'Amendment not found' });
    res.json(a);
  });

  router.put('/report-amendments/:id', requirePermission('process_management.amendments', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM report_amendment_logs WHERE id = ?').get(req.params.id) as any;
    if (!oldValue) return res.status(404).json({ error: 'Amendment not found' });
    if (req.body.status && !AMENDMENT_STATUSES.includes(req.body.status)) return res.status(400).json({ error: `status must be one of: ${AMENDMENT_STATUSES.join(', ')}` });
    db.prepare(`UPDATE report_amendment_logs SET reason_for_amendment = ?, original_report_summary = ?, amended_report_summary = ?, communicated_to = ?, communication_date = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(req.body.reasonForAmendment ?? oldValue.reason_for_amendment, req.body.originalReportSummary ?? oldValue.original_report_summary, req.body.amendedReportSummary ?? oldValue.amended_report_summary, req.body.communicatedTo ?? oldValue.communicated_to, req.body.communicationDate ?? oldValue.communication_date, req.body.status ?? oldValue.status, req.params.id);
    audit(req, { action: 'edit', entity: 'report_amendment_logs', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  router.post('/report-amendments/:id/authorize', requirePermission('process_management.amendments', 'approve'), (req, res) => {
    const db = getDb();
    const a = db.prepare('SELECT * FROM report_amendment_logs WHERE id = ?').get(req.params.id) as any;
    if (!a) return res.status(404).json({ error: 'Amendment not found' });
    const staffId = getStaffIdOrCurrent(req, req.body.authorizedByStaffId);
    if (staffId === null) return res.status(400).json({ error: 'This action requires the logged-in user to be linked to a staff record.' });
    db.prepare("UPDATE report_amendment_logs SET status = 'authorized', authorized_by_staff_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(staffId, req.params.id);
    audit(req, { action: 'authorize', entity: 'report_amendment_logs', entityId: req.params.id, oldValue: { status: a.status }, newValue: { status: 'authorized', authorizedByStaffId: staffId } });
    res.json({ ok: true });
  });

  router.post('/report-amendments/:id/create-nc', requirePermission('nc_capa', 'create'), (req, res) => {
    const db = getDb();
    const a = db.prepare('SELECT * FROM report_amendment_logs WHERE id = ?').get(req.params.id) as any;
    if (!a) return res.status(404).json({ error: 'Amendment not found' });
    const { ncId, ncNumber } = createNcFromSource(req, 'report_amendment_logs', a.id, a.amendment_date, `Report amendment: ${a.amendment_number}`, a.reason_for_amendment);
    db.prepare("UPDATE report_amendment_logs SET linked_nc_id = ?, status = 'linked_to_nc', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(ncId, req.params.id);
    res.status(201).json({ id: ncId, ncNumber });
  });

  router.post('/report-amendments/:id/create-action', requirePermission('actions', 'create'), (req, res) => {
    if (!req.body.title) return res.status(400).json({ error: 'title is required' });
    const db = getDb();
    const a = db.prepare('SELECT * FROM report_amendment_logs WHERE id = ?').get(req.params.id) as any;
    if (!a) return res.status(404).json({ error: 'Amendment not found' });
    const actionId = createActionFromSource(req, 'report_amendment_logs', a.id, a.reason_for_amendment);
    db.prepare('UPDATE report_amendment_logs SET linked_action_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(actionId, req.params.id);
    res.status(201).json({ id: actionId });
  });

  router.post('/report-amendments/:id/close', requirePermission('process_management.amendments', 'approve'), (req, res) => {
    const db = getDb();
    const a = db.prepare('SELECT * FROM report_amendment_logs WHERE id = ?').get(req.params.id) as any;
    if (!a) return res.status(404).json({ error: 'Amendment not found' });
    db.prepare("UPDATE report_amendment_logs SET status = 'closed', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
    audit(req, { action: 'close', entity: 'report_amendment_logs', entityId: req.params.id, oldValue: { status: a.status }, newValue: { status: 'closed' } });
    res.json({ ok: true });
  });

  // ============= Process reviews =============
  router.get('/process-reviews', requirePermission('process_management.reviews', 'view'), (_req, res) => {
    const db = getDb();
    res.json(db.prepare('SELECT * FROM process_review_records ORDER BY review_period_end DESC, id DESC').all());
  });

  router.post('/process-reviews', requirePermission('process_management.reviews', 'create'), (req, res) => {
    if (!req.body.reviewPeriodStart) return res.status(400).json({ error: 'reviewPeriodStart is required' });
    if (!req.body.reviewPeriodEnd) return res.status(400).json({ error: 'reviewPeriodEnd is required' });
    const db = getDb();
    const createdAt = new Date().toISOString();
    const reviewNumber = generateRecordNumber(db, 'process_review_records', 'PREV', createdAt);
    const result = db.prepare(`INSERT INTO process_review_records (review_number, review_period_start, review_period_end, department_id, section_id, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, 'draft', ?, ?)`)
      .run(reviewNumber, req.body.reviewPeriodStart, req.body.reviewPeriodEnd, parseIntNullable(req.body.departmentId), parseIntNullable(req.body.sectionId), req.user!.id, createdAt);
    const id = Number(result.lastInsertRowid);
    audit(req, { action: 'create', entity: 'process_review_records', entityId: id, newValue: { reviewNumber, ...req.body } });
    res.status(201).json({ id, reviewNumber });
  });

  router.get('/process-reviews/:id', requirePermission('process_management.reviews', 'view'), (req, res) => {
    const db = getDb();
    const r = db.prepare('SELECT * FROM process_review_records WHERE id = ?').get(req.params.id);
    if (!r) return res.status(404).json({ error: 'Process review not found' });
    res.json(r);
  });

  router.put('/process-reviews/:id', requirePermission('process_management.reviews', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM process_review_records WHERE id = ?').get(req.params.id) as any;
    if (!oldValue) return res.status(404).json({ error: 'Process review not found' });
    if (req.body.status && !REVIEW_STATUSES.includes(req.body.status)) return res.status(400).json({ error: `status must be one of: ${REVIEW_STATUSES.join(', ')}` });
    db.prepare(`UPDATE process_review_records SET department_id = ?, section_id = ?, rejection_summary = ?, critical_result_summary = ?, referral_testing_summary = ?, report_amendment_summary = ?, tat_summary = ?, issues_identified = ?, actions_required = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(parseIntNullable(req.body.departmentId) ?? oldValue.department_id, parseIntNullable(req.body.sectionId) ?? oldValue.section_id, req.body.rejectionSummary ?? oldValue.rejection_summary, req.body.criticalResultSummary ?? oldValue.critical_result_summary, req.body.referralTestingSummary ?? oldValue.referral_testing_summary, req.body.reportAmendmentSummary ?? oldValue.report_amendment_summary, req.body.tatSummary ?? oldValue.tat_summary, req.body.issuesIdentified ?? oldValue.issues_identified, req.body.actionsRequired ?? oldValue.actions_required, req.body.status ?? oldValue.status, req.params.id);
    audit(req, { action: 'edit', entity: 'process_review_records', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  router.post('/process-reviews/:id/generate-summary', requirePermission('process_management.reviews', 'edit'), (req, res) => {
    const db = getDb();
    const r = db.prepare('SELECT * FROM process_review_records WHERE id = ?').get(req.params.id) as any;
    if (!r) return res.status(404).json({ error: 'Process review not found' });
    const start = r.review_period_start; const end = r.review_period_end;
    const count = (sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { count: number }).count;
    const rejections = count('SELECT COUNT(*) count FROM specimen_rejection_records WHERE rejection_date BETWEEN ? AND ?', start, end);
    const rejectionNc = count('SELECT COUNT(*) count FROM specimen_rejection_records WHERE rejection_date BETWEEN ? AND ? AND linked_nc_id IS NOT NULL', start, end);
    const criticalTotal = count('SELECT COUNT(*) count FROM critical_result_notifications WHERE event_date BETWEEN ? AND ?', start, end);
    const criticalDelayed = count('SELECT COUNT(*) count FROM critical_result_notifications WHERE event_date BETWEEN ? AND ? AND escalation_required = 1', start, end);
    const referralTotal = count('SELECT COUNT(*) count FROM referral_sendouts WHERE sendout_date BETWEEN ? AND ?', start, end);
    const referralDelayed = count("SELECT COUNT(*) count FROM referral_sendouts WHERE sendout_date BETWEEN ? AND ? AND expected_return_date IS NOT NULL AND expected_return_date < date('now') AND result_received_date IS NULL AND status NOT IN ('closed','result_received')", start, end);
    const amendments = count('SELECT COUNT(*) count FROM report_amendment_logs WHERE amendment_date BETWEEN ? AND ?', start, end);
    const amendmentsNc = count('SELECT COUNT(*) count FROM report_amendment_logs WHERE amendment_date BETWEEN ? AND ? AND linked_nc_id IS NOT NULL', start, end);
    const rejectionSummary = `Specimen rejections: ${rejections}; linked to NC: ${rejectionNc}.`;
    const criticalSummary = `Critical result notifications: ${criticalTotal}; flagged for escalation/delay: ${criticalDelayed}.`;
    const referralSummary = `Referral sendouts: ${referralTotal}; currently delayed beyond expected return: ${referralDelayed}.`;
    const amendmentSummary = `Report amendments: ${amendments}; linked to NC: ${amendmentsNc}.`;
    db.prepare('UPDATE process_review_records SET rejection_summary = ?, critical_result_summary = ?, referral_testing_summary = ?, report_amendment_summary = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(rejectionSummary, criticalSummary, referralSummary, amendmentSummary, req.params.id);
    audit(req, { action: 'generate_summary', entity: 'process_review_records', entityId: req.params.id, newValue: { rejections, rejectionNc, criticalTotal, criticalDelayed, referralTotal, referralDelayed, amendments, amendmentsNc } });
    res.json({ ok: true, counts: { rejections, rejectionNc, criticalTotal, criticalDelayed, referralTotal, referralDelayed, amendments, amendmentsNc } });
  });

  router.post('/process-reviews/:id/approve', requirePermission('process_management.reviews', 'approve'), (req, res) => {
    const db = getDb();
    const r = db.prepare('SELECT * FROM process_review_records WHERE id = ?').get(req.params.id) as any;
    if (!r) return res.status(404).json({ error: 'Process review not found' });
    const staffId = getStaffIdOrCurrent(req, req.body.approvedByStaffId);
    if (staffId === null) return res.status(400).json({ error: 'This action requires the logged-in user to be linked to a staff record.' });
    db.prepare("UPDATE process_review_records SET status = 'approved', approved_by_staff_id = ?, approved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(staffId, req.params.id);
    audit(req, { action: 'approve', entity: 'process_review_records', entityId: req.params.id, oldValue: { status: r.status }, newValue: { status: 'approved', approvedByStaffId: staffId } });
    res.json({ ok: true });
  });

  router.post('/process-reviews/:id/close', requirePermission('process_management.reviews', 'approve'), (req, res) => {
    const db = getDb();
    const r = db.prepare('SELECT * FROM process_review_records WHERE id = ?').get(req.params.id) as any;
    if (!r) return res.status(404).json({ error: 'Process review not found' });
    db.prepare("UPDATE process_review_records SET status = 'closed', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
    audit(req, { action: 'close', entity: 'process_review_records', entityId: req.params.id, oldValue: { status: r.status }, newValue: { status: 'closed' } });
    res.json({ ok: true });
  });

  // ============= Pre-examination instructions =============
  router.get('/pre-examination', requirePermission('process_management.receipt', 'view'), (_req, res) => {
    res.json(getDb().prepare('SELECT * FROM pre_examination_instructions ORDER BY created_at DESC').all());
  });
  router.post('/pre-examination', requirePermission('process_management.receipt', 'create'), (req, res) => {
    if (!req.body.title) return res.status(400).json({ error: 'title is required' });
    const db = getDb();
    const createdAt = new Date().toISOString();
    const number = generateRecordNumber(db, 'pre_examination_instructions', 'PXI', createdAt);
    const r = db.prepare(`INSERT INTO pre_examination_instructions (instruction_number, title, test_catalog_id, sample_type, container_additive, patient_preparation, collection_instructions, transport_condition, stability_summary, storage_condition, status, section_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(number, req.body.title, parseIntNullable(req.body.testCatalogId), req.body.sampleType ?? null, req.body.containerAdditive ?? null, req.body.patientPreparation ?? null, req.body.collectionInstructions ?? null, req.body.transportCondition ?? null, req.body.stabilitySummary ?? null, req.body.storageCondition ?? null, req.body.status ?? 'active', parseIntNullable(req.body.sectionId), req.user!.id, createdAt);
    audit(req, { action: 'create', entity: 'pre_examination_instructions', entityId: r.lastInsertRowid, newValue: { number, ...req.body } });
    res.status(201).json({ id: r.lastInsertRowid, instructionNumber: number });
  });
  router.put('/pre-examination/:id', requirePermission('process_management.receipt', 'edit'), (req, res) => {
    const db = getDb();
    const old = db.prepare('SELECT * FROM pre_examination_instructions WHERE id = ?').get(req.params.id) as any;
    if (!old) return res.status(404).json({ error: 'Instruction not found' });
    db.prepare(`UPDATE pre_examination_instructions SET title = ?, test_catalog_id = ?, sample_type = ?, container_additive = ?, patient_preparation = ?, collection_instructions = ?, transport_condition = ?, stability_summary = ?, storage_condition = ?, status = ?, section_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(req.body.title ?? old.title, parseIntNullable(req.body.testCatalogId) ?? old.test_catalog_id, req.body.sampleType ?? old.sample_type, req.body.containerAdditive ?? old.container_additive, req.body.patientPreparation ?? old.patient_preparation, req.body.collectionInstructions ?? old.collection_instructions, req.body.transportCondition ?? old.transport_condition, req.body.stabilitySummary ?? old.stability_summary, req.body.storageCondition ?? old.storage_condition, req.body.status ?? old.status, parseIntNullable(req.body.sectionId) ?? old.section_id, req.params.id);
    audit(req, { action: 'edit', entity: 'pre_examination_instructions', entityId: req.params.id, oldValue: old, newValue: req.body });
    res.json({ ok: true });
  });

  // ============= Sample receipt & condition log =============
  router.get('/sample-receipts', requirePermission('process_management', 'view'), (_req, res) => {
    res.json(getDb().prepare('SELECT * FROM sample_receipt_records ORDER BY receipt_date DESC, created_at DESC').all());
  });
  router.post('/sample-receipts', requirePermission('process_management', 'create'), (req, res) => {
    if (!req.body.receiptDate) return res.status(400).json({ error: 'receiptDate is required' });
    const db = getDb();
    const createdAt = new Date().toISOString();
    const number = generateRecordNumber(db, 'sample_receipt_records', 'RCP', createdAt);
    const r = db.prepare(`INSERT INTO sample_receipt_records (receipt_number, receipt_date, receipt_time, request_reference, patient_reference, patient_type, sample_type, section_id, test_catalog_id, received_by_staff_id, condition, condition_notes, temperature, request_complete, urgent, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(number, req.body.receiptDate, req.body.receiptTime ?? null, req.body.requestReference ?? null, req.body.patientReference ?? null, req.body.patientType ?? null, req.body.sampleType ?? null, parseIntNullable(req.body.sectionId), parseIntNullable(req.body.testCatalogId), parseIntNullable(req.body.receivedByStaffId) ?? getStaffIdOrCurrent(req, null), req.body.condition ?? 'acceptable', req.body.conditionNotes ?? null, req.body.temperature ?? null, req.body.requestComplete === false ? 0 : 1, req.body.urgent ? 1 : 0, req.user!.id, createdAt);
    audit(req, { action: 'create', entity: 'sample_receipt_records', entityId: r.lastInsertRowid, newValue: { number, ...req.body } });
    res.status(201).json({ id: r.lastInsertRowid, receiptNumber: number });
  });
  // Escalate a received sample to the specimen-rejection register.
  router.post('/sample-receipts/:id/reject', requirePermission('process_management', 'create'), (req, res) => {
    const db = getDb();
    const rec = db.prepare('SELECT * FROM sample_receipt_records WHERE id = ?').get(req.params.id) as any;
    if (!rec) return res.status(404).json({ error: 'Sample receipt not found' });
    const createdAt = new Date().toISOString();
    const rejNumber = generateRecordNumber(db, 'specimen_rejection_records', 'REJ', createdAt);
    const rej = db.prepare(`INSERT INTO specimen_rejection_records (rejection_number, rejection_date, request_reference, patient_reference, patient_type, section_id, test_catalog_id, test_name, sample_type, rejection_reason, immediate_action, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`)
      .run(rejNumber, rec.receipt_date, rec.request_reference, rec.patient_reference, rec.patient_type, rec.section_id, rec.test_catalog_id, req.body.testName ?? null, rec.sample_type, req.body.rejectionReason ?? rec.condition_notes ?? 'Rejected at receipt', req.body.immediateAction ?? null, req.user!.id, createdAt);
    const rejId = Number(rej.lastInsertRowid);
    db.prepare("UPDATE sample_receipt_records SET condition = 'rejected', rejection_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(rejId, req.params.id);
    insertLink(db, { module: 'process_management', type: 'sample_receipt_records', id: req.params.id }, { module: 'process_management', type: 'specimen_rejection_records', id: rejId }, 'Rejection from sample receipt');
    audit(req, { action: 'create', entity: 'specimen_rejection_records', entityId: rejId, newValue: { rejNumber, fromReceipt: req.params.id } });
    res.status(201).json({ id: rejId, rejectionNumber: rejNumber });
  });

  // ============= Biological reference intervals =============
  router.get('/reference-intervals', requirePermission('process_management.intervals', 'view'), (_req, res) => {
    res.json(getDb().prepare('SELECT * FROM reference_interval_records ORDER BY created_at DESC').all());
  });
  // ---- Reference intervals — Excel export / template / import ----
  function riWorkbook(withData: boolean): Buffer {
    const rows: unknown[][] = [];
    if (withData) {
      for (const r of getDb().prepare('SELECT * FROM reference_interval_records ORDER BY analyte, sample_type').all() as any[])
        rows.push([r.analyte, r.sample_type ?? '', r.population ?? '', r.lower_limit ?? '', r.upper_limit ?? '', r.unit ?? '', r.clinical_decision_limit ?? '', r.source ?? '', r.effective_date ?? '', r.review_date ?? '', r.status ?? '']);
    }
    return buildWorkbook(RI_HEADERS, rows, 'REFERENCE INTERVALS');
  }
  router.get('/reference-intervals/template', requirePermission('process_management.intervals', 'view'), (_req, res) => sendWorkbook(res, riWorkbook(false), 'Reference_Intervals_Template.xlsx'));
  router.get('/reference-intervals/export', requirePermission('process_management.intervals', 'view'), (_req, res) => sendWorkbook(res, riWorkbook(true), 'Reference_Intervals.xlsx'));
  router.post('/reference-intervals/import', requirePermission('process_management.intervals', 'create'), riXlsxUpload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded. Attach the Reference Intervals .xlsx file.' });
    try {
      const rows = readSheet(req.file.buffer, 'REFERENCE');
      const db = getDb();
      const errors: string[] = []; let created = 0, updated = 0;
      const tx = db.transaction(() => {
        rows.forEach((r, idx) => {
          const rowNo = idx + 2;
          const analyte = cell(r, 'Analyte');
          if (!analyte) { errors.push(`Row ${rowNo}: Analyte is required.`); return; }
          const sampleType = cell(r, 'Sample type');
          try {
            const existing = db.prepare('SELECT id FROM reference_interval_records WHERE analyte = ? AND COALESCE(sample_type, \'\') = COALESCE(?, \'\') AND COALESCE(population, \'\') = COALESCE(?, \'\')').get(analyte, sampleType, cell(r, 'Population')) as any;
            const vals = [cell(r, 'Lower limit'), cell(r, 'Upper limit'), cell(r, 'Unit'), cell(r, 'Clinical decision limit'), cell(r, 'Source'), cell(r, 'Effective date'), cell(r, 'Review date'), cell(r, 'Status') ?? 'active'];
            if (existing) { db.prepare('UPDATE reference_interval_records SET sample_type = ?, population = ?, lower_limit = ?, upper_limit = ?, unit = ?, clinical_decision_limit = ?, source = ?, effective_date = ?, review_date = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(sampleType, cell(r, 'Population'), ...vals, existing.id); updated++; }
            else { const number = generateRecordNumber(db, 'reference_interval_records', 'RIV', new Date().toISOString()); db.prepare('INSERT INTO reference_interval_records (record_number, analyte, sample_type, population, lower_limit, upper_limit, unit, clinical_decision_limit, source, effective_date, review_date, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(number, analyte, sampleType, cell(r, 'Population'), ...vals, req.user!.id, new Date().toISOString()); created++; }
          } catch (e) { errors.push(`Row ${rowNo}: ${(e as Error).message}`); }
        });
      });
      tx();
      audit(req, { action: 'import', entity: 'reference_interval_records', entityId: null, newValue: { created, updated, errors: errors.length } });
      res.json({ totalRows: rows.length, created, updated, errors });
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });
  router.post('/reference-intervals', requirePermission('process_management.intervals', 'create'), (req, res) => {
    if (!req.body.analyte) return res.status(400).json({ error: 'analyte is required' });
    const db = getDb();
    const createdAt = new Date().toISOString();
    const number = generateRecordNumber(db, 'reference_interval_records', 'RIV', createdAt);
    const r = db.prepare(`INSERT INTO reference_interval_records (record_number, test_catalog_id, analyte, sample_type, population, lower_limit, upper_limit, unit, clinical_decision_limit, source, effective_date, review_date, status, communicated_to_users, notes, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(number, parseIntNullable(req.body.testCatalogId), req.body.analyte, req.body.sampleType ?? null, req.body.population ?? null, req.body.lowerLimit ?? null, req.body.upperLimit ?? null, req.body.unit ?? null, req.body.clinicalDecisionLimit ?? null, req.body.source ?? null, req.body.effectiveDate ?? null, req.body.reviewDate ?? null, req.body.status ?? 'active', req.body.communicatedToUsers ? 1 : 0, req.body.notes ?? null, req.user!.id, createdAt);
    audit(req, { action: 'create', entity: 'reference_interval_records', entityId: r.lastInsertRowid, newValue: { number, ...req.body } });
    res.status(201).json({ id: r.lastInsertRowid, recordNumber: number });
  });
  router.put('/reference-intervals/:id', requirePermission('process_management.intervals', 'edit'), (req, res) => {
    const db = getDb();
    const old = db.prepare('SELECT * FROM reference_interval_records WHERE id = ?').get(req.params.id) as any;
    if (!old) return res.status(404).json({ error: 'Reference interval not found' });
    db.prepare(`UPDATE reference_interval_records SET test_catalog_id = ?, analyte = ?, sample_type = ?, population = ?, lower_limit = ?, upper_limit = ?, unit = ?, clinical_decision_limit = ?, source = ?, effective_date = ?, review_date = ?, status = ?, communicated_to_users = ?, notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(parseIntNullable(req.body.testCatalogId) ?? old.test_catalog_id, req.body.analyte ?? old.analyte, req.body.sampleType ?? old.sample_type, req.body.population ?? old.population, req.body.lowerLimit ?? old.lower_limit, req.body.upperLimit ?? old.upper_limit, req.body.unit ?? old.unit, req.body.clinicalDecisionLimit ?? old.clinical_decision_limit, req.body.source ?? old.source, req.body.effectiveDate ?? old.effective_date, req.body.reviewDate ?? old.review_date, req.body.status ?? old.status, req.body.communicatedToUsers === undefined ? old.communicated_to_users : (req.body.communicatedToUsers ? 1 : 0), req.body.notes ?? old.notes, req.params.id);
    audit(req, { action: 'edit', entity: 'reference_interval_records', entityId: req.params.id, oldValue: old, newValue: req.body });
    res.json({ ok: true });
  });

  // ============= Result comparability studies =============
  router.get('/comparability', requirePermission('process_management.intervals', 'view'), (_req, res) => {
    res.json(getDb().prepare('SELECT * FROM result_comparability_studies ORDER BY study_date DESC, created_at DESC').all());
  });
  router.post('/comparability', requirePermission('process_management.intervals', 'create'), (req, res) => {
    if (!req.body.studyDate) return res.status(400).json({ error: 'studyDate is required' });
    const db = getDb();
    const createdAt = new Date().toISOString();
    const number = generateRecordNumber(db, 'result_comparability_studies', 'CMP', createdAt);
    const r = db.prepare(`INSERT INTO result_comparability_studies (study_number, study_date, test_name, analyte, method_a, method_b, sample_count, acceptance_criteria, outcome, findings, action_taken, conducted_by_staff_id, next_due_date, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(number, req.body.studyDate, req.body.testName ?? null, req.body.analyte ?? null, req.body.methodA ?? null, req.body.methodB ?? null, parseIntNullable(req.body.sampleCount), req.body.acceptanceCriteria ?? null, req.body.outcome ?? null, req.body.findings ?? null, req.body.actionTaken ?? null, parseIntNullable(req.body.conductedByStaffId) ?? getStaffIdOrCurrent(req, null), req.body.nextDueDate ?? null, req.body.status ?? 'open', req.user!.id, createdAt);
    audit(req, { action: 'create', entity: 'result_comparability_studies', entityId: r.lastInsertRowid, newValue: { number, ...req.body } });
    res.status(201).json({ id: r.lastInsertRowid, studyNumber: number });
  });
  router.put('/comparability/:id', requirePermission('process_management.intervals', 'edit'), (req, res) => {
    const db = getDb();
    const old = db.prepare('SELECT * FROM result_comparability_studies WHERE id = ?').get(req.params.id) as any;
    if (!old) return res.status(404).json({ error: 'Comparability study not found' });
    db.prepare(`UPDATE result_comparability_studies SET study_date = ?, test_name = ?, analyte = ?, method_a = ?, method_b = ?, sample_count = ?, acceptance_criteria = ?, outcome = ?, findings = ?, action_taken = ?, conducted_by_staff_id = ?, next_due_date = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(req.body.studyDate ?? old.study_date, req.body.testName ?? old.test_name, req.body.analyte ?? old.analyte, req.body.methodA ?? old.method_a, req.body.methodB ?? old.method_b, parseIntNullable(req.body.sampleCount) ?? old.sample_count, req.body.acceptanceCriteria ?? old.acceptance_criteria, req.body.outcome ?? old.outcome, req.body.findings ?? old.findings, req.body.actionTaken ?? old.action_taken, parseIntNullable(req.body.conductedByStaffId) ?? old.conducted_by_staff_id, req.body.nextDueDate ?? old.next_due_date, req.body.status ?? old.status, req.params.id);
    audit(req, { action: 'edit', entity: 'result_comparability_studies', entityId: req.params.id, oldValue: old, newValue: req.body });
    res.json({ ok: true });
  });

  // ============= Contingency / continuity plans =============
  router.get('/contingency-plans', requirePermission('process_management.reviews', 'view'), (_req, res) => {
    res.json(getDb().prepare('SELECT * FROM contingency_plans ORDER BY created_at DESC').all());
  });
  router.post('/contingency-plans', requirePermission('process_management.reviews', 'create'), (req, res) => {
    if (!req.body.title) return res.status(400).json({ error: 'title is required' });
    const db = getDb();
    const createdAt = new Date().toISOString();
    const number = generateRecordNumber(db, 'contingency_plans', 'CTP', createdAt);
    const r = db.prepare(`INSERT INTO contingency_plans (plan_number, scenario_type, title, trigger_description, response_actions, backup_arrangement, responsible_staff_id, last_tested_date, test_outcome, next_test_due, status, notes, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(number, req.body.scenarioType ?? null, req.body.title, req.body.triggerDescription ?? null, req.body.responseActions ?? null, req.body.backupArrangement ?? null, parseIntNullable(req.body.responsibleStaffId), req.body.lastTestedDate ?? null, req.body.testOutcome ?? null, req.body.nextTestDue ?? null, req.body.status ?? 'active', req.body.notes ?? null, req.user!.id, createdAt);
    audit(req, { action: 'create', entity: 'contingency_plans', entityId: r.lastInsertRowid, newValue: { number, ...req.body } });
    res.status(201).json({ id: r.lastInsertRowid, planNumber: number });
  });
  router.put('/contingency-plans/:id', requirePermission('process_management.reviews', 'edit'), (req, res) => {
    const db = getDb();
    const old = db.prepare('SELECT * FROM contingency_plans WHERE id = ?').get(req.params.id) as any;
    if (!old) return res.status(404).json({ error: 'Contingency plan not found' });
    db.prepare(`UPDATE contingency_plans SET scenario_type = ?, title = ?, trigger_description = ?, response_actions = ?, backup_arrangement = ?, responsible_staff_id = ?, last_tested_date = ?, test_outcome = ?, next_test_due = ?, status = ?, notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(req.body.scenarioType ?? old.scenario_type, req.body.title ?? old.title, req.body.triggerDescription ?? old.trigger_description, req.body.responseActions ?? old.response_actions, req.body.backupArrangement ?? old.backup_arrangement, parseIntNullable(req.body.responsibleStaffId) ?? old.responsible_staff_id, req.body.lastTestedDate ?? old.last_tested_date, req.body.testOutcome ?? old.test_outcome, req.body.nextTestDue ?? old.next_test_due, req.body.status ?? old.status, req.body.notes ?? old.notes, req.params.id);
    audit(req, { action: 'edit', entity: 'contingency_plans', entityId: req.params.id, oldValue: old, newValue: req.body });
    res.json({ ok: true });
  });

  return router;
}

export { TEST_STATUSES, REJECTION_STATUSES, CRITICAL_STATUSES, ACK_STATUSES, LAB_STATUSES, SENDOUT_STATUSES, AMENDMENT_STATUSES, REVIEW_STATUSES };
