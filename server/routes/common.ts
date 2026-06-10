import { Router } from 'express';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import archiver from 'archiver';
import { getDb, uploadRoot, evidenceRoot, backupRoot, dbPath, configRoot } from '../db/database.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import { audit } from '../services/auditService.js';
import { safeStoredFilename } from '../utils/safeFilename.js';

export function commonRoutes() {
  const router = Router();
  router.use(requireAuth);

  router.get('/dashboard', (_req, res) => {
    const db = getDb();
    res.json({
      documents: db.prepare('SELECT COUNT(*) count FROM documents').get(),
      actionsOpen: db.prepare("SELECT COUNT(*) count FROM actions WHERE status != 'closed'").get(),
      staff: db.prepare('SELECT COUNT(*) count FROM staff').get(),
      equipmentItems: db.prepare('SELECT COUNT(*) count FROM equipment_items').get(),
      inventoryItems: db.prepare('SELECT COUNT(*) count FROM inventory_items').get(),
      monitoringRecords: db.prepare('SELECT COUNT(*) count FROM monitoring_records').get(),
      safetyIncidents: db.prepare('SELECT COUNT(*) count FROM safety_incidents').get(),
      modulesEnabled: db.prepare('SELECT COUNT(*) count FROM system_modules WHERE enabled = 1').get(),
      latestBackup: db.prepare('SELECT file_name FROM backup_logs ORDER BY id DESC LIMIT 1').get()
    });
  });
  router.get('/dashboard/operations-summary', (_req, res) => {
    const db = getDb();
    const now = new Date().toISOString();
    const expiringSoonCutoff = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const count = (sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { count: number }).count;
    res.json({
      equipmentTotal: count('SELECT COUNT(*) count FROM equipment_items'),
      equipmentMaintenanceDue: count('SELECT COUNT(*) count FROM equipment_items WHERE COALESCE(next_maintenance_due, next_service_due) IS NOT NULL AND COALESCE(next_maintenance_due, next_service_due) <= ?', now),
      equipmentCalibrationDue: count('SELECT COUNT(*) count FROM equipment_items WHERE COALESCE(next_calibration_due, calibration_due_date) IS NOT NULL AND COALESCE(next_calibration_due, calibration_due_date) <= ?', now),
      equipmentOutOfService: count("SELECT COUNT(*) count FROM equipment_items WHERE status IN ('out_of_service','under_repair','restricted_use')"),
      inventoryLowStock: count('SELECT COUNT(*) count FROM inventory_items WHERE quantity <= COALESCE(NULLIF(minimum_stock,0), reorder_level, 0)'),
      inventoryExpiringSoon: count('SELECT COUNT(*) count FROM inventory_items WHERE expiry_date IS NOT NULL AND expiry_date > ? AND expiry_date <= ?', now, expiringSoonCutoff),
      inventoryExpired: count('SELECT COUNT(*) count FROM inventory_items WHERE expiry_date IS NOT NULL AND expiry_date < ?', now),
      monitoringWarnings: count("SELECT COUNT(*) count FROM monitoring_readings WHERE status = 'warning'"),
      monitoringCritical: count("SELECT COUNT(*) count FROM monitoring_readings WHERE status IN ('critical','out_of_range')"),
      openSafetyIncidents: count("SELECT COUNT(*) count FROM safety_incidents WHERE status != 'closed'")
    });
  });

  // Deprecated: kept for backward compatibility. New code should use the per-module
  // summary endpoints below (/dashboard/iqc-summary etc).
  router.get('/dashboard/technical-quality-summary', (_req, res) => {
    const db = getDb();
    const now = new Date().toISOString();
    const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
    const monthStartIso = monthStart.toISOString();
    const count = (sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { count: number }).count;
    res.json({
      activeIqcMaterials: count('SELECT COUNT(*) count FROM iqc_materials WHERE is_active = 1'),
      iqcFailuresThisMonth: count("SELECT COUNT(*) count FROM iqc_results WHERE status IN ('rejected','warning','out_of_control') AND run_date >= ?", monthStartIso),
      iqcResultsPendingReview: count("SELECT COUNT(*) count FROM iqc_results WHERE reviewed_at IS NULL AND status != 'accepted'"),
      eqaEventsDue: count('SELECT COUNT(*) count FROM eqa_events WHERE submission_due_date IS NOT NULL AND submitted_date IS NULL AND submission_due_date <= ?', now),
      eqaUnsatisfactoryEvents: count("SELECT COUNT(*) count FROM eqa_events WHERE performance_status IN ('unsatisfactory','poor','fail','failed')"),
      openVerifications: count("SELECT COUNT(*) count FROM method_verifications WHERE status IN ('planned','in_progress')"),
      equipmentVerificationsDue: count("SELECT COUNT(*) count FROM equipment_verifications WHERE status IN ('planned','in_progress')"),
      muRecordsDueForReview: count("SELECT COUNT(*) count FROM measurement_uncertainty_records WHERE status IN ('draft','in_review')")
    });
  });

  router.get('/dashboard/iqc-summary', (_req, res) => {
    const db = getDb();
    const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
    const yearStart = new Date(); yearStart.setMonth(0, 1); yearStart.setHours(0, 0, 0, 0);
    const count = (sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { count: number }).count;
    res.json({
      activeMaterials: count('SELECT COUNT(*) count FROM iqc_materials WHERE is_active = 1'),
      resultsThisMonth: count('SELECT COUNT(*) count FROM iqc_results WHERE run_date >= ?', monthStart.toISOString()),
      failedThisMonth: count("SELECT COUNT(*) count FROM iqc_results WHERE status IN ('rejected','out_of_control','warning') AND run_date >= ?", monthStart.toISOString()),
      resultsPendingReview: count("SELECT COUNT(*) count FROM iqc_results WHERE reviewed_at IS NULL AND status != 'accepted'"),
      lotChangesThisYear: count('SELECT COUNT(*) count FROM iqc_lot_changes WHERE change_date >= ?', yearStart.toISOString())
    });
  });

  router.get('/dashboard/eqa-summary', (_req, res) => {
    const db = getDb();
    const now = new Date().toISOString();
    const dueSoonCutoff = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const count = (sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { count: number }).count;
    res.json({
      activePrograms: count('SELECT COUNT(*) count FROM eqa_programs WHERE is_active = 1'),
      openEvents: count('SELECT COUNT(*) count FROM eqa_events WHERE submitted_date IS NULL'),
      eventsDueSoon: count('SELECT COUNT(*) count FROM eqa_events WHERE submitted_date IS NULL AND submission_due_date IS NOT NULL AND submission_due_date <= ? AND submission_due_date >= ?', dueSoonCutoff, now),
      unsatisfactoryEvents: count("SELECT COUNT(*) count FROM eqa_events WHERE performance_status IN ('unsatisfactory','poor','fail','failed')"),
      eventsRequiringCorrectiveAction: count('SELECT COUNT(*) count FROM eqa_events WHERE corrective_action_required = 1')
    });
  });

  router.get('/dashboard/verification-summary', (_req, res) => {
    const db = getDb();
    const yearStart = new Date(); yearStart.setMonth(0, 1); yearStart.setHours(0, 0, 0, 0);
    const count = (sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { count: number }).count;
    res.json({
      openMethodVerifications: count("SELECT COUNT(*) count FROM method_verifications WHERE status IN ('planned','in_progress')"),
      completedVerifications: count("SELECT COUNT(*) count FROM method_verifications WHERE status IN ('completed','approved')"),
      pendingApproval: count("SELECT COUNT(*) count FROM method_verifications WHERE status = 'completed' AND approved_by_staff_id IS NULL"),
      equipmentVerificationsThisYear: count('SELECT COUNT(*) count FROM equipment_verifications WHERE verification_date >= ?', yearStart.toISOString()),
      equipmentVerificationsPendingApproval: count("SELECT COUNT(*) count FROM equipment_verifications WHERE status IN ('planned','in_progress','completed') AND approved_by_staff_id IS NULL")
    });
  });

  router.get('/dashboard/measurement-uncertainty-summary', (_req, res) => {
    const db = getDb();
    const yearStart = new Date(); yearStart.setMonth(0, 1); yearStart.setHours(0, 0, 0, 0);
    const dueSoonCutoff = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const count = (sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { count: number }).count;
    res.json({
      activeRecords: count("SELECT COUNT(*) count FROM measurement_uncertainty_records WHERE status != 'archived'"),
      recordsPendingReview: count("SELECT COUNT(*) count FROM measurement_uncertainty_records WHERE status = 'draft'"),
      recordsPendingApproval: count("SELECT COUNT(*) count FROM measurement_uncertainty_records WHERE status = 'in_review'"),
      recordsDueForReview: count("SELECT COUNT(*) count FROM measurement_uncertainty_records WHERE status IN ('draft','in_review') AND calculation_date <= ?", dueSoonCutoff),
      recordsCompletedThisYear: count("SELECT COUNT(*) count FROM measurement_uncertainty_records WHERE status = 'approved' AND calculation_date >= ?", yearStart.toISOString())
    });
  });

  router.get('/dashboard/blood-bank-summary', (_req, res) => {
    const db = getDb();
    const now = new Date();
    const nowIso = now.toISOString();
    const expiringSoonCutoff = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10);
    const count = (sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { count: number }).count;
    res.json({
      unitsAvailable: count("SELECT COUNT(*) count FROM blood_units WHERE current_status = 'available' AND expiry_date > ?", nowIso),
      unitsExpiringSoon: count("SELECT COUNT(*) count FROM blood_units WHERE current_status = 'available' AND expiry_date > ? AND expiry_date <= ?", nowIso, expiringSoonCutoff),
      unitsExpired: count("SELECT COUNT(*) count FROM blood_units WHERE expiry_date < ? AND current_status NOT IN ('discarded','transfused')", nowIso),
      pendingHandovers: count("SELECT COUNT(*) count FROM blood_bank_handovers WHERE status NOT IN ('closed','reviewed')"),
      openAdverseEvents: count("SELECT COUNT(*) count FROM blood_adverse_events WHERE status != 'closed'"),
      discardsThisMonth: count('SELECT COUNT(*) count FROM blood_discards WHERE discard_date BETWEEN ? AND ?', monthStart, monthEnd),
      donorReactionsThisMonth: count("SELECT COUNT(*) count FROM blood_adverse_events WHERE event_type = 'donor_reaction' AND event_date BETWEEN ? AND ?", monthStart, monthEnd),
      transfusionReactionsThisMonth: count("SELECT COUNT(*) count FROM blood_adverse_events WHERE event_type IN ('transfusion_reaction','transfusion_incident') AND event_date BETWEEN ? AND ?", monthStart, monthEnd),
      ncCapaLinkedRecords: count("SELECT COUNT(*) count FROM blood_adverse_events WHERE nc_id IS NOT NULL OR capa_id IS NOT NULL") + count("SELECT COUNT(*) count FROM blood_discards WHERE nc_id IS NOT NULL OR capa_id IS NOT NULL")
    });
  });

  router.get('/dashboard/monthly-reports-summary', (_req, res) => {
    const db = getDb();
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const count = (sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { count: number }).count;
    const avgRow = db.prepare("SELECT AVG(CASE WHEN tat_minutes IS NOT NULL AND tat_minutes >= 0 THEN tat_minutes END) AS avg FROM tat_records").get() as { avg: number | null };
    res.json({
      importsThisMonth: count('SELECT COUNT(*) count FROM lhims_import_batches WHERE created_at >= ?', monthStart),
      unprocessedImports: count("SELECT COUNT(*) count FROM lhims_import_batches WHERE status IN ('pending','processing','failed')"),
      unresolvedExceptions: count("SELECT COUNT(*) count FROM monthly_report_exceptions WHERE status = 'open'"),
      draftReports: count("SELECT COUNT(*) count FROM monthly_report_batches WHERE status = 'draft'"),
      approvedReportsThisMonth: count("SELECT COUNT(*) count FROM monthly_report_batches WHERE status IN ('approved','exported','archived') AND approved_at >= ?", monthStart),
      delayedTatRecords: count("SELECT COUNT(*) count FROM tat_records WHERE status = 'delayed'"),
      averageTatMinutes: avgRow.avg !== null && avgRow.avg !== undefined ? Math.round(avgRow.avg) : null
    });
  });

  router.get('/dashboard/document-control-summary', (_req, res) => {
    const db = getDb();
    const todayIso = new Date().toISOString().slice(0, 10);
    const dueCutoff = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const count = (sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { count: number }).count;
    res.json({
      currentDocuments: count("SELECT COUNT(*) count FROM documents WHERE status IN ('current','approved')"),
      drafts: count("SELECT COUNT(*) count FROM documents WHERE status = 'draft'"),
      dueReviews: count("SELECT COUNT(*) count FROM documents WHERE next_review_date IS NOT NULL AND next_review_date <= ? AND next_review_date >= ? AND status != 'obsolete'", dueCutoff, todayIso),
      overdueReviews: count("SELECT COUNT(*) count FROM documents WHERE next_review_date IS NOT NULL AND next_review_date < ? AND status != 'obsolete'", todayIso),
      pendingAttestations: count("SELECT COUNT(*) count FROM document_attestations WHERE status IN ('pending','overdue')"),
      obsoleteDocuments: count("SELECT COUNT(*) count FROM documents WHERE status = 'obsolete'")
    });
  });

  router.get('/dashboard/personnel-summary', (_req, res) => {
    const db = getDb();
    const todayIso = new Date().toISOString().slice(0, 10);
    const expiryCutoff = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);
    const monthEnd = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).toISOString().slice(0, 10);
    const count = (sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { count: number }).count;
    res.json({
      staffDocumentsPendingVerification: count("SELECT COUNT(*) count FROM staff_documents WHERE verification_status = 'pending'"),
      certificatesExpiringSoon: count("SELECT COUNT(*) count FROM staff_documents WHERE expiry_date IS NOT NULL AND expiry_date <= ? AND expiry_date >= ?", expiryCutoff, todayIso),
      pendingDeclarations: count("SELECT COUNT(*) count FROM staff_declarations WHERE status = 'pending'"),
      plannedTrainingEvents: count("SELECT COUNT(*) count FROM training_events WHERE status = 'planned'"),
      competencyAssessmentsDue: count("SELECT COUNT(*) count FROM competency_assessments WHERE next_assessment_due IS NOT NULL AND next_assessment_due <= ?", expiryCutoff),
      authorizationsDueReview: count("SELECT COUNT(*) count FROM technical_authorizations WHERE expires_at IS NOT NULL AND expires_at <= ? AND is_active = 1", expiryCutoff),
      rostersThisMonth: count("SELECT COUNT(*) count FROM duty_rosters WHERE roster_start_date <= ? AND roster_end_date >= ?", monthEnd, monthStart)
    });
  });

  router.get('/dashboard/customer-focus-summary', (_req, res) => {
    const db = getDb();
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);
    const todayIso = new Date().toISOString().slice(0, 10);
    const count = (sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { count: number }).count;
    res.json({
      activeStakeholders: count('SELECT COUNT(*) count FROM customer_stakeholders WHERE is_active = 1'),
      activeServiceAgreements: count("SELECT COUNT(*) count FROM service_agreements WHERE status = 'active'"),
      feedbackThisMonth: count('SELECT COUNT(*) count FROM customer_feedback WHERE feedback_date >= ?', monthStart),
      openFeedback: count("SELECT COUNT(*) count FROM customer_feedback WHERE status NOT IN ('resolved','closed')"),
      highUrgencyFeedback: count("SELECT COUNT(*) count FROM customer_feedback WHERE urgency IN ('high','critical') AND status NOT IN ('resolved','closed')"),
      activeSurveys: count("SELECT COUNT(*) count FROM satisfaction_surveys WHERE status = 'active'"),
      surveyResponsesThisMonth: count('SELECT COUNT(*) count FROM satisfaction_survey_responses WHERE response_date >= ?', monthStart),
      followUpsDue: count("SELECT COUNT(*) count FROM customer_feedback WHERE follow_up_due_date IS NOT NULL AND follow_up_due_date <= ? AND status NOT IN ('resolved','closed')", todayIso)
        + count("SELECT COUNT(*) count FROM customer_communication_logs WHERE follow_up_due_date IS NOT NULL AND follow_up_due_date <= ? AND status != 'closed'", todayIso)
    });
  });

  router.get('/dashboard/notifications-summary', (req, res) => {
    // Reuse the central summary computation to keep numbers identical.
    // Defer the import to avoid a circular module load.
    import('./notifications.js').then(m => res.json(m.computeSummary(req))).catch(e => res.status(500).json({ error: (e as Error).message }));
  });

  router.get('/dashboard/records-reports-summary', (_req, res) => {
    const db = getDb();
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);
    const count = (sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { count: number }).count;
    res.json({
      activeReportTemplates: count("SELECT COUNT(*) count FROM report_templates WHERE is_active = 1"),
      reportsGeneratedThisMonth: count("SELECT COUNT(*) count FROM report_requests WHERE created_at >= ? AND status IN ('generated','reviewed','approved','archived')", monthStart),
      openEvidencePacks: count("SELECT COUNT(*) count FROM evidence_packs WHERE status NOT IN ('approved','archived')"),
      pendingApprovals: count("SELECT COUNT(*) count FROM report_requests WHERE status = 'reviewed'") + count("SELECT COUNT(*) count FROM evidence_packs WHERE status = 'reviewed'"),
      printJobsThisMonth: count("SELECT COUNT(*) count FROM print_jobs WHERE created_at >= ?", monthStart),
      retentionReviewsDue: count("SELECT COUNT(*) count FROM record_retention_reviews WHERE status = 'draft'"),
      backupChecksThisMonth: count("SELECT COUNT(*) count FROM backup_restore_checks WHERE created_at >= ?", monthStart),
      openIntegrityIssues: count("SELECT COUNT(*) count FROM data_integrity_checks WHERE status IN ('issues_found','action_required')")
    });
  });

  router.get('/dashboard/poct-summary', (_req, res) => {
    const db = getDb();
    const today = new Date().toISOString().slice(0, 10);
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);
    const count = (sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { count: number }).count;
    res.json({
      activeSites: count("SELECT COUNT(*) count FROM poct_sites WHERE status = 'active'"),
      activeDevices: count("SELECT COUNT(*) count FROM poct_devices WHERE status = 'active'"),
      authorizedOperators: count("SELECT COUNT(DISTINCT staff_id) count FROM poct_operator_authorizations WHERE status = 'active' AND (expiry_date IS NULL OR expiry_date >= ?)", today),
      expiredAuthorizations: count("SELECT COUNT(*) count FROM poct_operator_authorizations WHERE expiry_date IS NOT NULL AND expiry_date < ? AND status NOT IN ('revoked')", today),
      qcFailuresThisMonth: count("SELECT COUNT(*) count FROM poct_qc_results WHERE status IN ('failed','warning') AND qc_date >= ?", monthStart),
      unsatisfactoryEqaEvents: count("SELECT COUNT(*) count FROM poct_eqa_events WHERE performance_status = 'unsatisfactory'"),
      openIncidents: count("SELECT COUNT(*) count FROM poct_incidents WHERE status != 'closed'"),
      maintenanceDue: count("SELECT COUNT(*) count FROM poct_devices WHERE next_service_due IS NOT NULL AND next_service_due <= ?", today)
    });
  });

  router.get('/dashboard/information-management-summary', (_req, res) => {
    const db = getDb();
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);
    const count = (sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { count: number }).count;
    res.json({
      activeInformationAssets: count("SELECT COUNT(*) count FROM information_assets WHERE status = 'active'"),
      activeSystems: count("SELECT COUNT(*) count FROM information_systems WHERE status = 'active'"),
      openAccessReviews: count("SELECT COUNT(*) count FROM system_access_reviews WHERE status IN ('draft','action_required')"),
      openSecurityIncidents: count("SELECT COUNT(*) count FROM information_security_incidents WHERE status NOT IN ('closed')"),
      pendingDataCorrections: count("SELECT COUNT(*) count FROM data_correction_requests WHERE status IN ('submitted','reviewed','approved')"),
      openChangeRequests: count("SELECT COUNT(*) count FROM system_change_requests WHERE status NOT IN ('closed','rejected','validated')"),
      validationsPendingApproval: count("SELECT COUNT(*) count FROM system_validation_records WHERE status = 'completed'"),
      downtimeRecordsThisMonth: count("SELECT COUNT(*) count FROM system_downtime_records WHERE downtime_start >= ?", monthStart),
      pendingInformationReviews: count("SELECT COUNT(*) count FROM information_management_reviews WHERE status IN ('draft','reviewed')")
    });
  });

  router.get('/dashboard/process-management-summary', (_req, res) => {
    const db = getDb();
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    const count = (sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { count: number }).count;
    res.json({
      activeTests: count("SELECT COUNT(*) count FROM lab_test_catalog WHERE status = 'active'"),
      activeAcceptanceCriteria: count("SELECT COUNT(*) count FROM specimen_acceptance_criteria WHERE is_active = 1"),
      specimenRejectionsThisMonth: count("SELECT COUNT(*) count FROM specimen_rejection_records WHERE rejection_date >= ?", monthStart),
      openSpecimenRejections: count("SELECT COUNT(*) count FROM specimen_rejection_records WHERE status NOT IN ('closed','linked_to_nc')"),
      criticalResultsThisMonth: count("SELECT COUNT(*) count FROM critical_result_notifications WHERE event_date >= ?", monthStart),
      delayedCriticalNotifications: count("SELECT COUNT(*) count FROM critical_result_notifications WHERE escalation_required = 1 AND status NOT IN ('closed')"),
      referralSendoutsPending: count("SELECT COUNT(*) count FROM referral_sendouts WHERE status IN ('sent','pending_result')"),
      delayedReferralSendouts: count("SELECT COUNT(*) count FROM referral_sendouts WHERE expected_return_date IS NOT NULL AND expected_return_date < ? AND result_received_date IS NULL AND status NOT IN ('closed','result_received')", today),
      reportAmendmentsThisMonth: count("SELECT COUNT(*) count FROM report_amendment_logs WHERE amendment_date >= ?", monthStart),
      pendingProcessReviews: count("SELECT COUNT(*) count FROM process_review_records WHERE status IN ('draft','reviewed')")
    });
  });

  router.get('/dashboard/governance-summary', (_req, res) => {
    const db = getDb();
    const todayIso = new Date().toISOString().slice(0, 10);
    const count = (sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { count: number }).count;
    res.json({
      plannedAssessments: count("SELECT COUNT(*) count FROM assessment_programs WHERE status IN ('planned','in_progress')"),
      openFindings: count("SELECT COUNT(*) count FROM assessment_findings WHERE status != 'closed'"),
      openMeetings: count("SELECT COUNT(*) count FROM meetings WHERE status IN ('scheduled','completed')"),
      pendingManagementReviews: count("SELECT COUNT(*) count FROM management_reviews WHERE status IN ('draft','inputs_collected','reviewed')"),
      activeQualityIndicators: count("SELECT COUNT(*) count FROM quality_indicators WHERE is_active = 1"),
      criticalQualityIndicatorResults: count("SELECT COUNT(*) count FROM quality_indicator_results WHERE status = 'critical' AND (reviewed_at IS NULL OR nc_id IS NULL)"),
      activeImprovementProjects: count("SELECT COUNT(*) count FROM improvement_projects WHERE status IN ('planned','active')"),
      overdueImprovementActions: count("SELECT COUNT(*) count FROM actions WHERE module_key = 'continual_improvement' AND status != 'Closed' AND due_date IS NOT NULL AND due_date < ?", todayIso)
    });
  });

  router.get('/dashboard/qms-summary', (_req, res) => {
    const db = getDb();
    const staffId = _req.user?.staffId ?? null;
    const myAssignedActions = staffId
      ? db.prepare('SELECT COUNT(*) count FROM actions WHERE assigned_to_staff_id = ? AND status != ?').get(staffId, 'Closed')
      : { count: 0 };
    res.json({
      openNCs: db.prepare("SELECT COUNT(*) count FROM nonconforming_events WHERE status != 'closed'").get(),
      openCAPAs: db.prepare("SELECT COUNT(*) count FROM capa_records WHERE status != 'closed'").get(),
      pendingComplaints: db.prepare("SELECT COUNT(*) count FROM complaints WHERE status != 'closed'").get(),
      highRisks: db.prepare("SELECT COUNT(*) count FROM risks WHERE risk_level IN ('High','Critical') AND status != 'closed'").get(),
      myAssignedActions,
      overdueActions: db.prepare('SELECT COUNT(*) count FROM actions WHERE due_date IS NOT NULL AND due_date < CURRENT_TIMESTAMP AND status != ?').get('Closed')
    });
  });

  router.get('/roles', requirePermission('settings', 'view'), (_req, res) => res.json(getDb().prepare('SELECT id, name, description, is_system isSystem FROM roles ORDER BY name').all()));
  router.get('/users', requirePermission('settings', 'view'), (_req, res) => res.json(getDb().prepare('SELECT u.id, u.username, u.full_name fullName, u.role_id roleId, u.staff_id staffId, s.full_name staffName, r.name roleName, u.is_active isActive FROM users u JOIN roles r ON r.id = u.role_id LEFT JOIN staff s ON s.id = u.staff_id ORDER BY u.full_name').all()));
  router.post('/users', requirePermission('settings', 'create'), (req, res) => {
    const { username, password, fullName, roleId, staffId } = req.body;
    const oldValue = null;
    const result = getDb().prepare('INSERT INTO users (username, password_hash, full_name, role_id, staff_id) VALUES (?, ?, ?, ?, ?)').run(username, bcrypt.hashSync(password, 12), fullName, roleId, staffId ?? null);
    audit(req, { action: 'create', entity: 'users', entityId: result.lastInsertRowid, oldValue, newValue: { username, fullName, roleId, staffId } });
    res.status(201).json({ id: result.lastInsertRowid });
  });
  router.put('/users/:id', requirePermission('settings', 'edit'), (req, res) => {
    const { staffId } = req.body;
    const oldValue = getDb().prepare('SELECT staff_id staffId FROM users WHERE id = ?').get(req.params.id);
    getDb().prepare('UPDATE users SET staff_id = ? WHERE id = ?').run(staffId ?? null, req.params.id);
    audit(req, { action: 'link_staff', entity: 'users', entityId: req.params.id, oldValue, newValue: { staffId } });
    res.json({ ok: true });
  });

  router.get('/positions', requirePermission('settings', 'view'), (_req, res) => res.json(getDb().prepare('SELECT id, title, description, reports_to_position_id reportsToPositionId, is_active isActive, archived_at archivedAt FROM positions ORDER BY is_active DESC, title').all()));
  router.post('/positions', requirePermission('settings', 'create'), (req, res) => {
    const { title, description, reportsToPositionId } = req.body;
    const result = getDb().prepare('INSERT INTO positions (title, description, reports_to_position_id) VALUES (?, ?, ?)').run(title, description ?? null, reportsToPositionId ?? null);
    audit(req, { action: 'create', entity: 'positions', entityId: result.lastInsertRowid, newValue: req.body });
    res.status(201).json({ id: result.lastInsertRowid });
  });
  router.put('/positions/:id', requirePermission('settings', 'edit'), (req, res) => {
    const oldValue = getDb().prepare('SELECT * FROM positions WHERE id = ?').get(req.params.id);
    getDb().prepare('UPDATE positions SET title = ?, description = ?, reports_to_position_id = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.body.title, req.body.description ?? null, req.body.reportsToPositionId ?? null, req.body.isActive ? 1 : 0, req.params.id);
    audit(req, { action: 'edit', entity: 'positions', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });
  router.delete('/positions/:id', requirePermission('settings', 'void_archive'), (req, res) => {
    const used = getDb().prepare('SELECT COUNT(*) count FROM staff_position_assignments WHERE position_id = ?').get(req.params.id) as { count: number };
    if (used.count > 0) getDb().prepare('UPDATE positions SET is_active = 0, archived_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id); else getDb().prepare('DELETE FROM positions WHERE id = ?').run(req.params.id);
    audit(req, { action: used.count > 0 ? 'archive' : 'delete', entity: 'positions', entityId: req.params.id });
    res.json({ ok: true, archived: used.count > 0 });
  });

  router.get('/staff', requirePermission('personnel', 'view'), (_req, res) => res.json(getDb().prepare('SELECT id, employee_no employeeNo, full_name fullName, email, phone, is_active isActive FROM staff ORDER BY full_name').all()));
  router.post('/staff', requirePermission('personnel', 'create'), (req, res) => {
    const r = getDb().prepare('INSERT INTO staff (employee_no, full_name, email, phone) VALUES (?, ?, ?, ?)').run(req.body.employeeNo ?? null, req.body.fullName, req.body.email ?? null, req.body.phone ?? null);
    if (req.body.positionId) getDb().prepare('INSERT INTO staff_position_assignments (staff_id, position_id, assignment_type) VALUES (?, ?, ?)').run(r.lastInsertRowid, req.body.positionId, req.body.assignmentType ?? 'primary');
    audit(req, { action: 'create', entity: 'staff', entityId: r.lastInsertRowid, newValue: req.body });
    res.status(201).json({ id: r.lastInsertRowid });
  });

  router.get('/system-modules', requirePermission('settings', 'view'), (_req, res) => res.json(getDb().prepare('SELECT id, key, label, path, enabled, alerts_paused alertsPaused FROM system_modules ORDER BY id').all()));
  router.put('/system-modules/:key', requirePermission('settings', 'edit'), (req, res) => {
    const oldValue = getDb().prepare('SELECT * FROM system_modules WHERE key = ?').get(req.params.key);
    getDb().prepare('UPDATE system_modules SET enabled = ?, alerts_paused = ?, updated_at = CURRENT_TIMESTAMP WHERE key = ? AND key != ?').run(req.body.enabled ? 1 : 0, req.body.enabled ? 0 : 1, req.params.key, 'settings');
    audit(req, { action: 'edit', entity: 'system_modules', entityId: req.params.key, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  router.get('/permissions/matrix', requirePermission('settings', 'view'), (_req, res) => {
    const db = getDb();
    res.json({ permissions: db.prepare('SELECT * FROM permissions ORDER BY module_key, action').all(), rolePermissions: db.prepare('SELECT * FROM role_permissions').all(), positionPermissions: db.prepare('SELECT * FROM position_permissions').all(), userOverrides: db.prepare('SELECT * FROM user_permission_overrides').all(), technicalAuthorizations: db.prepare('SELECT * FROM technical_authorizations').all(), auditHistory: db.prepare("SELECT * FROM audit_logs WHERE entity IN ('permissions','role_permissions','position_permissions','user_permission_overrides') ORDER BY id DESC LIMIT 50").all() });
  });

  const storage = multer.diskStorage({ destination: (_req, _file, cb) => cb(null, uploadRoot), filename: (_req, file, cb) => cb(null, safeStoredFilename(file.originalname)) });
  const upload = multer({ storage, limits: { fileSize: 25 * 1024 * 1024 } });
  router.post('/files', requirePermission('documents', 'create'), upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const r = getDb().prepare('INSERT INTO files (original_name, stored_name, mime_type, size_bytes, storage_area, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)').run(req.file.originalname, req.file.filename, req.file.mimetype, req.file.size, 'uploads', req.user!.id);
    audit(req, { action: 'create', entity: 'files', entityId: r.lastInsertRowid, newValue: { originalName: req.file.originalname, storedName: req.file.filename } });
    res.status(201).json({ id: r.lastInsertRowid, storedName: req.file.filename });
  });
  router.post('/evidence', requirePermission('documents', 'create'), upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    fs.renameSync(req.file.path, path.join(evidenceRoot, req.file.filename));
    const file = getDb().prepare('INSERT INTO files (original_name, stored_name, mime_type, size_bytes, storage_area, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)').run(req.file.originalname, req.file.filename, req.file.mimetype, req.file.size, 'evidence', req.user!.id);
    const link = getDb().prepare('INSERT INTO evidence_files (file_id, module_key, record_type, record_id, notes, linked_by) VALUES (?, ?, ?, ?, ?, ?)').run(file.lastInsertRowid, req.body.moduleKey, req.body.recordType, req.body.recordId, req.body.notes ?? null, req.user!.id);
    audit(req, { action: 'create', entity: 'files', entityId: file.lastInsertRowid, newValue: req.body });
    res.status(201).json({ fileId: file.lastInsertRowid, evidenceId: link.lastInsertRowid });
  });

  router.get('/documents', requirePermission('documents', 'view'), (_req, res) => res.json(getDb().prepare('SELECT * FROM documents ORDER BY created_at DESC').all()));
  router.post('/documents/import-master-list', requirePermission('documents', 'create'), (req, res) => { audit(req, { action: 'create', entity: 'documents', newValue: req.body }); res.json({ ok: true, message: 'MVP import placeholder accepted. CSV parsing will be implemented in the next phase.' }); });

  router.get('/actions', requirePermission('actions', 'view'), (req, res) => {
    const db = getDb();
    const filters = [];
    const params: unknown[] = [];
    let query = 'SELECT * FROM actions';
    if (req.query.assignedToStaffId) {
      filters.push('assigned_to_staff_id = ?');
      params.push(Number(req.query.assignedToStaffId));
    }
    if (req.query.status) {
      filters.push('status = ?');
      params.push(String(req.query.status));
    }
    if (req.query.overdue === 'true') {
      filters.push('due_date IS NOT NULL AND due_date < CURRENT_TIMESTAMP AND status != ?');
      params.push('Closed');
    }
    if (filters.length) query += ` WHERE ${filters.join(' AND ')}`;
    query += ' ORDER BY created_at DESC';
    res.json(db.prepare(query).all(...params));
  });
  router.post('/actions', requirePermission('actions', 'create'), (req, res) => {
    const r = getDb().prepare('INSERT INTO actions (title, module_key, source_module, source_record_id, description, priority, assigned_to_staff_id, due_date, status, evidence_required, completion_notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      req.body.title,
      req.body.moduleKey ?? 'actions',
      req.body.sourceModule ?? null,
      req.body.sourceRecordId ?? null,
      req.body.description ?? null,
      req.body.priority ?? 'normal',
      req.body.assignedToStaffId ?? null,
      req.body.dueDate ?? null,
      req.body.status ?? 'Not started',
      req.body.evidenceRequired ? 1 : 0,
      req.body.completionNotes ?? null,
      req.user!.id
    );
    audit(req, { action: 'create', entity: 'actions', entityId: r.lastInsertRowid, newValue: req.body });
    res.status(201).json({ id: r.lastInsertRowid });
  });
  router.put('/actions/:id', requirePermission('actions', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM actions WHERE id = ?').get(req.params.id);
    if (!oldValue) return res.status(404).json({ error: 'Action not found' });
    db.prepare('UPDATE actions SET title = ?, source_module = ?, source_record_id = ?, description = ?, priority = ?, assigned_to_staff_id = ?, due_date = ?, status = ?, evidence_required = ?, completion_notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(
      req.body.title ?? oldValue.title,
      req.body.sourceModule ?? oldValue.source_module,
      req.body.sourceRecordId ?? oldValue.source_record_id,
      req.body.description ?? oldValue.description,
      req.body.priority ?? oldValue.priority,
      req.body.assignedToStaffId ?? oldValue.assigned_to_staff_id,
      req.body.dueDate ?? oldValue.due_date,
      req.body.status ?? oldValue.status,
      req.body.evidenceRequired ? 1 : oldValue.evidence_required,
      req.body.completionNotes ?? oldValue.completion_notes,
      req.params.id
    );
    audit(req, { action: 'edit', entity: 'actions', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  router.get('/permissions', requirePermission('settings', 'view'), (_req, res) => res.json(getDb().prepare('SELECT * FROM permissions ORDER BY module_key, action').all()));
  router.post('/permissions/role', requirePermission('settings', 'edit'), (req, res) => {
    const { roleId, permissionId, allowed } = req.body;
    const result = getDb().prepare('INSERT OR REPLACE INTO role_permissions (role_id, permission_id, allowed, source) VALUES (?, ?, ?, ?)').run(roleId, permissionId, allowed ? 1 : 0, 'Manual assignment');
    audit(req, { action: 'create', entity: 'role_permissions', entityId: result.lastInsertRowid, newValue: { roleId, permissionId, allowed } });
    res.status(201).json({ ok: true });
  });
  router.post('/permissions/position', requirePermission('settings', 'edit'), (req, res) => {
    const { positionId, permissionId, allowed } = req.body;
    const result = getDb().prepare('INSERT OR REPLACE INTO position_permissions (position_id, permission_id, allowed, source) VALUES (?, ?, ?, ?)').run(positionId, permissionId, allowed ? 1 : 0, 'Manual assignment');
    audit(req, { action: 'create', entity: 'position_permissions', entityId: result.lastInsertRowid, newValue: { positionId, permissionId, allowed } });
    res.status(201).json({ ok: true });
  });
  router.post('/permissions/user-override', requirePermission('settings', 'edit'), (req, res) => {
    const { userId, permissionId, allowed, reason } = req.body;
    const result = getDb().prepare('INSERT OR REPLACE INTO user_permission_overrides (user_id, permission_id, allowed, source, reason) VALUES (?, ?, ?, ?, ?)').run(userId, permissionId, allowed ? 1 : 0, 'Manual override', reason ?? null);
    audit(req, { action: 'create', entity: 'user_permission_overrides', entityId: result.lastInsertRowid, newValue: { userId, permissionId, allowed, reason } });
    res.status(201).json({ ok: true });
  });
  router.post('/authorizations/technical', requirePermission('settings', 'edit'), (req, res) => {
    const { staffId, positionId, moduleKey, sectionId, level } = req.body;
    const result = getDb().prepare('INSERT INTO technical_authorizations (staff_id, position_id, module_key, section_id, level, is_active) VALUES (?, ?, ?, ?, ?, 1)').run(staffId ?? null, positionId ?? null, moduleKey, sectionId ?? null, level);
    audit(req, { action: 'create', entity: 'technical_authorizations', entityId: result.lastInsertRowid, newValue: { staffId, positionId, moduleKey, sectionId, level } });
    res.status(201).json({ ok: true });
  });
  router.get('/sections', requirePermission('settings', 'view'), (_req, res) => res.json(getDb().prepare('SELECT id, name FROM sections WHERE is_active = 1 ORDER BY name').all()));

  router.get('/devices', requirePermission('settings', 'view'), (_req, res) => res.json(getDb().prepare('SELECT * FROM devices ORDER BY created_at DESC').all()));
  router.post('/devices/request-pairing', requirePermission('settings', 'create'), (req, res) => { const code = Math.random().toString(36).slice(2, 10).toUpperCase(); const r = getDb().prepare('INSERT INTO devices (device_code, name, type) VALUES (?, ?, ?)').run(code, req.body.name, req.body.type ?? 'desktop'); audit(req, { action: 'create', entity: 'devices', entityId: r.lastInsertRowid, newValue: { code, ...req.body } }); res.status(201).json({ id: r.lastInsertRowid, code }); });
  router.post('/devices/:id/approve', requirePermission('settings', 'edit'), (req, res) => {
    const oldValue = getDb().prepare('SELECT status FROM devices WHERE id = ?').get(req.params.id) as { status: string } | undefined;
    if (!oldValue) return res.status(404).json({ error: 'Device not found' });
    getDb().prepare('UPDATE devices SET status = ? WHERE id = ?').run('approved', req.params.id);
    audit(req, { action: 'approve', entity: 'devices', entityId: req.params.id, oldValue, newValue: { status: 'approved' } });
    res.json({ ok: true });
  });
  router.post('/devices/:id/revoke', requirePermission('settings', 'edit'), (req, res) => {
    const oldValue = getDb().prepare('SELECT status FROM devices WHERE id = ?').get(req.params.id) as { status: string } | undefined;
    if (!oldValue) return res.status(404).json({ error: 'Device not found' });
    getDb().prepare('UPDATE devices SET status = ? WHERE id = ?').run('revoked', req.params.id);
    audit(req, { action: 'revoke', entity: 'devices', entityId: req.params.id, oldValue, newValue: { status: 'revoked' } });
    res.json({ ok: true });
  });
  router.post('/devices/:id/block', requirePermission('settings', 'edit'), (req, res) => {
    const oldValue = getDb().prepare('SELECT status FROM devices WHERE id = ?').get(req.params.id) as { status: string } | undefined;
    if (!oldValue) return res.status(404).json({ error: 'Device not found' });
    getDb().prepare('UPDATE devices SET status = ? WHERE id = ?').run('blocked', req.params.id);
    audit(req, { action: 'block', entity: 'devices', entityId: req.params.id, oldValue, newValue: { status: 'blocked' } });
    res.json({ ok: true });
  });

  router.post('/backup/create', requirePermission('settings', 'export'), async (req, res) => {
    const fileName = `sech-lims-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`;
    const fullPath = path.join(backupRoot, fileName);
    const manifest = { product: 'SECH_LIMS by Nickland', createdAt: new Date().toISOString(), includes: ['SQLite database', 'uploads', 'evidence', 'config', 'backup-manifest.json'] };
    await new Promise<void>((resolve, reject) => {
      const output = fs.createWriteStream(fullPath); const archive = archiver('zip', { zlib: { level: 9 } });
      output.on('close', resolve); archive.on('error', reject); archive.pipe(output);
      if (fs.existsSync(dbPath)) archive.file(dbPath, { name: 'database/sech_lims.sqlite' });
      archive.directory(uploadRoot, 'uploads'); archive.directory(evidenceRoot, 'evidence'); archive.directory(configRoot, 'config'); archive.append(JSON.stringify(manifest, null, 2), { name: 'backup-manifest.json' }); archive.finalize();
    });
    getDb().prepare('INSERT INTO backup_logs (file_name, manifest, created_by) VALUES (?, ?, ?)').run(fileName, JSON.stringify(manifest), req.user!.id);
    audit(req, { action: 'create', entity: 'backup', entityId: fileName, newValue: manifest });
    res.status(201).json({ fileName, manifest });
  });
  router.post('/backup/restore-placeholder', requirePermission('settings', 'approve'), (_req, res) => res.json({ ok: true, message: 'Restore is a guarded placeholder in the foundation MVP.' }));
  router.get('/audit-log', requirePermission('settings', 'view'), (_req, res) => res.json(getDb().prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 200').all()));

  for (const group of ['lab-profile','departments','sections','locations','authorizations','approval-routes','links','notifications','settings']) router.get(`/${group}`, (_req, res) => res.json([]));
  return router;
}
