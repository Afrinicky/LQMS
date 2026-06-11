import { Router } from 'express';
import { getDb } from '../db/database.js';
import { requirePermission } from '../middleware/permissions.js';
import { audit } from '../services/auditService.js';
import { generateRecordNumber } from '../utils/recordNumber.js';
import { parseIntNullable, getStaffIdOrCurrent, getCurrentStaffId } from './routeHelpers.js';

const NOTIFICATION_STATUSES = ['unread', 'read', 'acknowledged', 'resolved', 'dismissed'];
const NOTIFICATION_SEVERITIES = ['info', 'low', 'medium', 'high', 'urgent'];
const NOTIFICATION_TYPES = ['due_soon', 'overdue', 'review_required', 'approval_required', 'follow_up', 'expiry_alert', 'task_assigned', 'system_notice'];
const CALENDAR_STATUSES = ['pending', 'due_soon', 'overdue', 'completed', 'cancelled'];
const TASK_STATUSES = ['open', 'in_progress', 'completed', 'cancelled', 'overdue'];
const RULE_TRIGGER_TYPES = ['due_soon', 'overdue', 'expiry_alert', 'review_required', 'approval_required', 'follow_up', 'custom'];

function tableExists(db: any, table: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(table);
  return !!row;
}

function columnExists(db: any, table: string, column: string): boolean {
  if (!tableExists(db, table)) return false;
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return cols.some(c => c.name === column);
}

function eventLog(db: any, notificationId: number, eventType: string, note: string | null, actorStaffId: number | null, actorUserId: number | null) {
  db.prepare('INSERT INTO notification_events (notification_id, event_type, event_note, actor_staff_id, actor_user_id) VALUES (?, ?, ?, ?, ?)').run(notificationId, eventType, note, actorStaffId, actorUserId);
}

type ScanCandidate = {
  moduleKey: string;
  recordType: string;
  recordId: string;
  title: string;
  message: string;
  dueDate: string | null;
  severity: string;
  notificationType: string;
  itemType: string;
  responsibleStaffId?: number | null;
};

function classifyDue(dueIso: string | null): { isDue: boolean; isOverdue: boolean; isDueSoon: boolean } {
  if (!dueIso) return { isDue: false, isOverdue: false, isDueSoon: false };
  const today = new Date().toISOString().slice(0, 10);
  const soon = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return { isDue: true, isOverdue: dueIso < today, isDueSoon: dueIso >= today && dueIso <= soon };
}

function severityForCandidate(c: ScanCandidate): string {
  const { isOverdue } = classifyDue(c.dueDate);
  if (c.notificationType === 'expiry_alert' && isOverdue) return 'urgent';
  if (isOverdue) return 'high';
  return c.severity || 'medium';
}

function collectScanCandidates(db: any): ScanCandidate[] {
  const today = new Date().toISOString().slice(0, 10);
  const soonIso = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const out: ScanCandidate[] = [];

  // Actions due/overdue
  if (tableExists(db, 'actions')) {
    const rows = db.prepare("SELECT id, title, module_key, due_date, assigned_to_staff_id, status FROM actions WHERE due_date IS NOT NULL AND status != 'Closed' AND due_date <= ?").all(soonIso) as any[];
    for (const r of rows) {
      const overdue = r.due_date < today;
      out.push({ moduleKey: r.module_key || 'actions', recordType: 'actions', recordId: String(r.id), title: `Action ${overdue ? 'overdue' : 'due soon'}: ${r.title}`, message: `Action assigned with due date ${r.due_date}`, dueDate: r.due_date, severity: overdue ? 'high' : 'medium', notificationType: overdue ? 'overdue' : 'due_soon', itemType: 'action_due', responsibleStaffId: r.assigned_to_staff_id });
    }
  }

  // Documents next review
  if (tableExists(db, 'documents') && columnExists(db, 'documents', 'next_review_date')) {
    const rows = db.prepare("SELECT id, title, document_code, next_review_date, owner_staff_id FROM documents WHERE next_review_date IS NOT NULL AND status != 'obsolete' AND next_review_date <= ?").all(soonIso) as any[];
    for (const r of rows) {
      const overdue = r.next_review_date < today;
      out.push({ moduleKey: 'documents', recordType: 'documents', recordId: String(r.id), title: `Document review ${overdue ? 'overdue' : 'due'}: ${r.document_code || ''} ${r.title}`.trim(), message: `Document ${r.document_code || ''} review due ${r.next_review_date}`, dueDate: r.next_review_date, severity: overdue ? 'high' : 'medium', notificationType: 'review_required', itemType: 'document_review', responsibleStaffId: r.owner_staff_id });
    }
  }

  // Document attestations pending
  if (tableExists(db, 'document_attestations')) {
    const rows = db.prepare("SELECT a.id, a.staff_id, a.due_date, COALESCE(d.title, '') AS title FROM document_attestations a LEFT JOIN documents d ON d.id = a.document_id WHERE a.status IN ('pending','overdue')").all() as any[];
    for (const r of rows) {
      out.push({ moduleKey: 'documents', recordType: 'document_attestations', recordId: String(r.id), title: `Attestation required: ${r.title}`.trim(), message: 'Sign this document attestation', dueDate: r.due_date, severity: 'medium', notificationType: 'follow_up', itemType: 'attestation', responsibleStaffId: r.staff_id });
    }
  }

  // Staff documents expiry
  if (tableExists(db, 'staff_documents')) {
    const rows = db.prepare("SELECT id, staff_id, title, expiry_date FROM staff_documents WHERE expiry_date IS NOT NULL AND expiry_date <= ?").all(soonIso) as any[];
    for (const r of rows) {
      out.push({ moduleKey: 'personnel', recordType: 'staff_documents', recordId: String(r.id), title: `Staff document expiring: ${r.title}`, message: `Expiry ${r.expiry_date}`, dueDate: r.expiry_date, severity: 'medium', notificationType: 'expiry_alert', itemType: 'staff_document_expiry', responsibleStaffId: r.staff_id });
    }
  }

  // Competency next assessment
  if (tableExists(db, 'competency_assessments') && columnExists(db, 'competency_assessments', 'next_assessment_due')) {
    const rows = db.prepare("SELECT id, staff_id, activity, next_assessment_due FROM competency_assessments WHERE next_assessment_due IS NOT NULL AND next_assessment_due <= ?").all(soonIso) as any[];
    for (const r of rows) out.push({ moduleKey: 'personnel', recordType: 'competency_assessments', recordId: String(r.id), title: `Competency due: ${r.activity}`, message: `Next assessment ${r.next_assessment_due}`, dueDate: r.next_assessment_due, severity: 'medium', notificationType: 'review_required', itemType: 'competency_due', responsibleStaffId: r.staff_id });
  }

  // Technical authorizations expiry
  if (tableExists(db, 'technical_authorizations') && columnExists(db, 'technical_authorizations', 'expires_at')) {
    const rows = db.prepare("SELECT id, staff_id, module_key, level, expires_at FROM technical_authorizations WHERE expires_at IS NOT NULL AND expires_at <= ? AND is_active = 1").all(soonIso) as any[];
    for (const r of rows) out.push({ moduleKey: 'personnel', recordType: 'technical_authorizations', recordId: String(r.id), title: `Technical authorisation expiring (${r.module_key} ${r.level})`, message: `Expires ${r.expires_at}`, dueDate: r.expires_at, severity: 'medium', notificationType: 'expiry_alert', itemType: 'authorization_expiry', responsibleStaffId: r.staff_id });
  }

  // Duty rosters pending approval
  if (tableExists(db, 'duty_rosters')) {
    const rows = db.prepare("SELECT id, roster_number, roster_start_date FROM duty_rosters WHERE status = 'draft' OR status = 'published'").all() as any[];
    for (const r of rows) out.push({ moduleKey: 'personnel', recordType: 'duty_rosters', recordId: String(r.id), title: `Roster awaiting approval: ${r.roster_number}`, message: `Roster starts ${r.roster_start_date}`, dueDate: r.roster_start_date, severity: 'low', notificationType: 'approval_required', itemType: 'roster_approval' });
  }

  // Equipment service/calibration/breakdown
  if (tableExists(db, 'equipment_items')) {
    const rows = db.prepare("SELECT id, name, equipment_number, next_service_due, next_maintenance_due, next_calibration_due, status FROM equipment_items WHERE COALESCE(next_calibration_due, calibration_due_date) IS NOT NULL").all() as any[];
    for (const r of rows) {
      const cal = r.next_calibration_due;
      const main = r.next_maintenance_due || r.next_service_due;
      if (cal && cal <= soonIso) { const overdue = cal < today; out.push({ moduleKey: 'equipment', recordType: 'equipment_items', recordId: String(r.id), title: `Equipment calibration ${overdue ? 'overdue' : 'due'}: ${r.name}`, message: `Calibration due ${cal}`, dueDate: cal, severity: overdue ? 'high' : 'medium', notificationType: 'expiry_alert', itemType: 'equipment_calibration' }); }
      if (main && main <= soonIso) { const overdue = main < today; out.push({ moduleKey: 'equipment', recordType: 'equipment_items', recordId: String(r.id), title: `Equipment maintenance ${overdue ? 'overdue' : 'due'}: ${r.name}`, message: `Maintenance due ${main}`, dueDate: main, severity: overdue ? 'high' : 'medium', notificationType: 'expiry_alert', itemType: 'equipment_maintenance' }); }
    }
  }
  if (tableExists(db, 'equipment_breakdowns')) {
    const rows = db.prepare("SELECT id, breakdown_date, description FROM equipment_breakdowns WHERE status = 'open'").all() as any[];
    for (const r of rows) out.push({ moduleKey: 'equipment', recordType: 'equipment_breakdowns', recordId: String(r.id), title: `Open equipment breakdown #${r.id}`, message: r.description || 'Open breakdown', dueDate: null, severity: 'high', notificationType: 'follow_up', itemType: 'breakdown_open' });
  }

  // Inventory batches expiring
  if (tableExists(db, 'inventory_batches')) {
    const rows = db.prepare("SELECT id, item_id, batch_number, expiry_date FROM inventory_batches WHERE expiry_date IS NOT NULL AND expiry_date <= ? AND status = 'available'").all(soonIso) as any[];
    for (const r of rows) { const overdue = r.expiry_date < today; out.push({ moduleKey: 'supplier_inventory', recordType: 'inventory_batches', recordId: String(r.id), title: `Inventory batch ${overdue ? 'expired' : 'expiring'}: ${r.batch_number || `#${r.id}`}`, message: `Expiry ${r.expiry_date}`, dueDate: r.expiry_date, severity: overdue ? 'urgent' : 'medium', notificationType: 'expiry_alert', itemType: 'inventory_batch_expiry' }); }
  }
  if (tableExists(db, 'inventory_items')) {
    const rows = db.prepare("SELECT id, item_code, name, quantity, reorder_level, minimum_stock FROM inventory_items WHERE quantity <= COALESCE(NULLIF(minimum_stock,0), reorder_level, 0)").all() as any[];
    for (const r of rows) out.push({ moduleKey: 'supplier_inventory', recordType: 'inventory_items', recordId: String(r.id), title: `Low stock: ${r.item_code || r.name}`, message: `Quantity ${r.quantity} at or below reorder level`, dueDate: null, severity: 'medium', notificationType: 'follow_up', itemType: 'inventory_low_stock' });
  }

  // Monitoring critical readings
  if (tableExists(db, 'monitoring_readings')) {
    const rows = db.prepare("SELECT id, monitoring_item_id, value, status, reading_date FROM monitoring_readings WHERE status IN ('critical','out_of_range') AND reviewed_at IS NULL").all() as any[];
    for (const r of rows) out.push({ moduleKey: 'monitoring', recordType: 'monitoring_readings', recordId: String(r.id), title: `Monitoring reading ${r.status}`, message: `Reading ${r.value} on ${r.reading_date} pending review`, dueDate: r.reading_date, severity: 'high', notificationType: 'review_required', itemType: 'monitoring_excursion' });
  }

  // IQC results pending review
  if (tableExists(db, 'iqc_results')) {
    const rows = db.prepare("SELECT id, run_date FROM iqc_results WHERE reviewed_at IS NULL AND status != 'accepted'").all() as any[];
    for (const r of rows) out.push({ moduleKey: 'iqc', recordType: 'iqc_results', recordId: String(r.id), title: `IQC result pending review`, message: `IQC #${r.id} from ${r.run_date} requires review`, dueDate: r.run_date, severity: 'medium', notificationType: 'review_required', itemType: 'iqc_review' });
  }

  // EQA events due / unsatisfactory
  if (tableExists(db, 'eqa_events')) {
    const rows = db.prepare("SELECT id, cycle_name, submission_due_date, performance_status FROM eqa_events WHERE (submission_due_date IS NOT NULL AND submission_due_date <= ? AND submitted_date IS NULL) OR performance_status IN ('unsatisfactory','poor','fail','failed')").all(soonIso) as any[];
    for (const r of rows) out.push({ moduleKey: 'eqa', recordType: 'eqa_events', recordId: String(r.id), title: `EQA ${r.performance_status === 'unsatisfactory' || r.performance_status === 'fail' ? 'unsatisfactory' : 'submission due'}: ${r.cycle_name}`, message: `${r.cycle_name} ${r.submission_due_date ? 'due ' + r.submission_due_date : 'performance ' + r.performance_status}`, dueDate: r.submission_due_date, severity: 'high', notificationType: r.submission_due_date ? 'due_soon' : 'follow_up', itemType: 'eqa_event' });
  }

  // Verification & MU pending approval
  if (tableExists(db, 'method_verifications')) {
    const rows = db.prepare("SELECT id, verification_number FROM method_verifications WHERE status = 'completed' AND approved_by_staff_id IS NULL").all() as any[];
    for (const r of rows) out.push({ moduleKey: 'verification_validation', recordType: 'method_verifications', recordId: String(r.id), title: `Method verification awaiting approval: ${r.verification_number}`, message: 'Pending approver review', dueDate: null, severity: 'medium', notificationType: 'approval_required', itemType: 'method_verification_approval' });
  }
  if (tableExists(db, 'equipment_verifications')) {
    const rows = db.prepare("SELECT id, verification_number FROM equipment_verifications WHERE status IN ('planned','in_progress','completed') AND approved_by_staff_id IS NULL").all() as any[];
    for (const r of rows) out.push({ moduleKey: 'verification_validation', recordType: 'equipment_verifications', recordId: String(r.id), title: `Equipment verification awaiting approval: ${r.verification_number}`, message: 'Pending approver review', dueDate: null, severity: 'medium', notificationType: 'approval_required', itemType: 'equipment_verification_approval' });
  }
  if (tableExists(db, 'measurement_uncertainty_records')) {
    const rows = db.prepare("SELECT id, mu_number, status FROM measurement_uncertainty_records WHERE status IN ('draft','in_review')").all() as any[];
    for (const r of rows) out.push({ moduleKey: 'measurement_uncertainty', recordType: 'measurement_uncertainty_records', recordId: String(r.id), title: `MU record pending: ${r.mu_number}`, message: `Status ${r.status}`, dueDate: null, severity: 'low', notificationType: r.status === 'draft' ? 'review_required' : 'approval_required', itemType: 'mu_review' });
  }

  // Blood Bank
  if (tableExists(db, 'blood_units')) {
    const rows = db.prepare("SELECT id, unit_number, expiry_date, current_status FROM blood_units WHERE expiry_date <= ? AND current_status NOT IN ('discarded','transfused')").all(soonIso) as any[];
    for (const r of rows) { const overdue = r.expiry_date < today; out.push({ moduleKey: 'blood_bank_handover', recordType: 'blood_units', recordId: String(r.id), title: `Blood unit ${overdue ? 'expired' : 'expiring'}: ${r.unit_number}`, message: `Expiry ${r.expiry_date}`, dueDate: r.expiry_date, severity: overdue ? 'urgent' : 'high', notificationType: 'expiry_alert', itemType: 'blood_unit_expiry' }); }
  }
  if (tableExists(db, 'blood_adverse_events')) {
    const rows = db.prepare("SELECT id, event_number, event_date FROM blood_adverse_events WHERE status != 'closed'").all() as any[];
    for (const r of rows) out.push({ moduleKey: 'blood_bank_handover', recordType: 'blood_adverse_events', recordId: String(r.id), title: `Open blood bank adverse event: ${r.event_number}`, message: `Event on ${r.event_date}`, dueDate: r.event_date, severity: 'high', notificationType: 'follow_up', itemType: 'bb_adverse_open' });
  }
  if (tableExists(db, 'blood_bank_handovers')) {
    const rows = db.prepare("SELECT id, handover_number, handover_date FROM blood_bank_handovers WHERE status NOT IN ('closed','reviewed')").all() as any[];
    for (const r of rows) out.push({ moduleKey: 'blood_bank_handover', recordType: 'blood_bank_handovers', recordId: String(r.id), title: `Handover pending: ${r.handover_number}`, message: `Handover ${r.handover_date}`, dueDate: r.handover_date, severity: 'medium', notificationType: 'follow_up', itemType: 'handover_pending' });
  }

  // Monthly Reports
  if (tableExists(db, 'lhims_import_batches')) {
    const rows = db.prepare("SELECT id, batch_number FROM lhims_import_batches WHERE status IN ('pending','processing','failed')").all() as any[];
    for (const r of rows) out.push({ moduleKey: 'monthly_reports', recordType: 'lhims_import_batches', recordId: String(r.id), title: `Unprocessed import: ${r.batch_number}`, message: 'Process or fix this import batch', dueDate: null, severity: 'low', notificationType: 'follow_up', itemType: 'monthly_import_pending' });
  }
  if (tableExists(db, 'monthly_report_exceptions')) {
    const rows = db.prepare("SELECT id, import_batch_id FROM monthly_report_exceptions WHERE status = 'open'").all() as any[];
    for (const r of rows) out.push({ moduleKey: 'monthly_reports', recordType: 'monthly_report_exceptions', recordId: String(r.id), title: `Monthly report exception #${r.id}`, message: 'Open exception requires resolution', dueDate: null, severity: 'medium', notificationType: 'review_required', itemType: 'monthly_exception' });
  }
  if (tableExists(db, 'monthly_report_batches')) {
    const rows = db.prepare("SELECT id, report_number FROM monthly_report_batches WHERE status = 'draft'").all() as any[];
    for (const r of rows) out.push({ moduleKey: 'monthly_reports', recordType: 'monthly_report_batches', recordId: String(r.id), title: `Draft monthly report: ${r.report_number}`, message: 'Pending review/approval', dueDate: null, severity: 'low', notificationType: 'approval_required', itemType: 'monthly_report_draft' });
  }

  // Assessments
  if (tableExists(db, 'assessment_programs')) {
    const rows = db.prepare("SELECT id, program_number, planned_start_date FROM assessment_programs WHERE status IN ('planned','in_progress') AND planned_start_date <= ?").all(soonIso) as any[];
    for (const r of rows) out.push({ moduleKey: 'assessments', recordType: 'assessment_programs', recordId: String(r.id), title: `Assessment due: ${r.program_number}`, message: `Planned start ${r.planned_start_date}`, dueDate: r.planned_start_date, severity: 'medium', notificationType: 'due_soon', itemType: 'assessment_due' });
  }
  if (tableExists(db, 'assessment_findings')) {
    const rows = db.prepare("SELECT id, finding_number FROM assessment_findings WHERE status != 'closed'").all() as any[];
    for (const r of rows) out.push({ moduleKey: 'assessments', recordType: 'assessment_findings', recordId: String(r.id), title: `Open assessment finding: ${r.finding_number}`, message: 'Finding requires follow-up', dueDate: null, severity: 'medium', notificationType: 'follow_up', itemType: 'finding_open' });
  }

  // Meetings + management review + quality indicators + improvement
  if (tableExists(db, 'meetings')) {
    const rows = db.prepare("SELECT id, meeting_number, meeting_date FROM meetings WHERE status IN ('scheduled','completed') AND meeting_date <= ?").all(soonIso) as any[];
    for (const r of rows) out.push({ moduleKey: 'meetings', recordType: 'meetings', recordId: String(r.id), title: `Meeting due/open: ${r.meeting_number}`, message: `Meeting ${r.meeting_date}`, dueDate: r.meeting_date, severity: 'low', notificationType: 'due_soon', itemType: 'meeting_due' });
  }
  if (tableExists(db, 'management_reviews')) {
    const rows = db.prepare("SELECT id, review_number, review_date FROM management_reviews WHERE status IN ('draft','inputs_collected','reviewed')").all() as any[];
    for (const r of rows) out.push({ moduleKey: 'management_review', recordType: 'management_reviews', recordId: String(r.id), title: `Management review pending: ${r.review_number}`, message: `Review ${r.review_date}`, dueDate: r.review_date, severity: 'medium', notificationType: 'approval_required', itemType: 'mreview_pending' });
  }
  if (tableExists(db, 'quality_indicator_results')) {
    const rows = db.prepare("SELECT id, status FROM quality_indicator_results WHERE (status = 'critical' AND nc_id IS NULL) OR reviewed_at IS NULL").all() as any[];
    for (const r of rows) out.push({ moduleKey: 'quality_indicators', recordType: 'quality_indicator_results', recordId: String(r.id), title: `Quality indicator ${r.status === 'critical' ? 'critical result' : 'pending review'}`, message: `Indicator result #${r.id} requires attention`, dueDate: null, severity: r.status === 'critical' ? 'high' : 'low', notificationType: r.status === 'critical' ? 'follow_up' : 'review_required', itemType: 'indicator_review' });
  }
  if (tableExists(db, 'improvement_projects')) {
    const rows = db.prepare("SELECT id, project_number, expected_completion_date FROM improvement_projects WHERE status IN ('planned','active') AND expected_completion_date IS NOT NULL AND expected_completion_date < ?").all(today) as any[];
    for (const r of rows) out.push({ moduleKey: 'continual_improvement', recordType: 'improvement_projects', recordId: String(r.id), title: `Improvement project overdue: ${r.project_number}`, message: `Expected completion ${r.expected_completion_date}`, dueDate: r.expected_completion_date, severity: 'high', notificationType: 'overdue', itemType: 'improvement_overdue' });
  }

  // Customer Focus
  if (tableExists(db, 'customer_feedback')) {
    const rows = db.prepare("SELECT id, feedback_number, urgency, follow_up_due_date FROM customer_feedback WHERE status NOT IN ('resolved','closed') AND (urgency IN ('high','critical') OR (follow_up_due_date IS NOT NULL AND follow_up_due_date <= ?))").all(soonIso) as any[];
    for (const r of rows) out.push({ moduleKey: 'customer_focus', recordType: 'customer_feedback', recordId: String(r.id), title: `Customer feedback ${r.urgency === 'critical' ? 'critical' : 'follow-up'}: ${r.feedback_number}`, message: r.follow_up_due_date ? `Follow-up due ${r.follow_up_due_date}` : 'High-urgency feedback open', dueDate: r.follow_up_due_date, severity: r.urgency === 'critical' ? 'urgent' : 'high', notificationType: 'follow_up', itemType: 'feedback_follow_up' });
  }
  if (tableExists(db, 'service_agreements')) {
    const rows = db.prepare("SELECT id, agreement_number, review_due_date FROM service_agreements WHERE review_due_date IS NOT NULL AND review_due_date <= ? AND status = 'active'").all(soonIso) as any[];
    for (const r of rows) out.push({ moduleKey: 'customer_focus', recordType: 'service_agreements', recordId: String(r.id), title: `Service agreement review due: ${r.agreement_number}`, message: `Review by ${r.review_due_date}`, dueDate: r.review_due_date, severity: 'medium', notificationType: 'review_required', itemType: 'agreement_review' });
  }
  if (tableExists(db, 'customer_communication_logs')) {
    const rows = db.prepare("SELECT id, communication_number, follow_up_due_date FROM customer_communication_logs WHERE follow_up_due_date IS NOT NULL AND follow_up_due_date <= ? AND status != 'closed'").all(soonIso) as any[];
    for (const r of rows) out.push({ moduleKey: 'customer_focus', recordType: 'customer_communication_logs', recordId: String(r.id), title: `Communication follow-up: ${r.communication_number}`, message: `Due ${r.follow_up_due_date}`, dueDate: r.follow_up_due_date, severity: 'low', notificationType: 'follow_up', itemType: 'communication_follow_up' });
  }
  if (tableExists(db, 'satisfaction_surveys')) {
    const rows = db.prepare("SELECT id, survey_number, period_end FROM satisfaction_surveys WHERE status = 'active' AND period_end IS NOT NULL AND period_end <= ?").all(soonIso) as any[];
    for (const r of rows) out.push({ moduleKey: 'customer_focus', recordType: 'satisfaction_surveys', recordId: String(r.id), title: `Satisfaction survey ending soon: ${r.survey_number}`, message: `Closes ${r.period_end}`, dueDate: r.period_end, severity: 'low', notificationType: 'due_soon', itemType: 'survey_ending' });
  }

  // POCT
  if (tableExists(db, 'poct_operator_authorizations')) {
    const rows = db.prepare("SELECT id, authorization_number, expiry_date FROM poct_operator_authorizations WHERE expiry_date IS NOT NULL AND expiry_date <= ? AND status IN ('active','expired')").all(soonIso) as any[];
    for (const r of rows) { const overdue = r.expiry_date < today; out.push({ moduleKey: 'poct', recordType: 'poct_operator_authorizations', recordId: String(r.id), title: `POCT authorisation ${overdue ? 'expired' : 'expiring'}: ${r.authorization_number}`, message: `Expiry ${r.expiry_date}`, dueDate: r.expiry_date, severity: overdue ? 'urgent' : 'medium', notificationType: 'expiry_alert', itemType: 'poct_authorization_expiry' }); }
  }
  if (tableExists(db, 'poct_qc_results')) {
    const rows = db.prepare("SELECT id, qc_number FROM poct_qc_results WHERE status IN ('failed','warning') AND reviewed_at IS NULL").all() as any[];
    for (const r of rows) out.push({ moduleKey: 'poct', recordType: 'poct_qc_results', recordId: String(r.id), title: `POCT QC pending review: ${r.qc_number}`, message: 'Failed/warning QC result requires review', dueDate: null, severity: 'high', notificationType: 'review_required', itemType: 'poct_qc_review' });
  }
  if (tableExists(db, 'poct_eqa_events')) {
    const rows = db.prepare("SELECT id, event_number, due_date, performance_status FROM poct_eqa_events WHERE (due_date IS NOT NULL AND due_date <= ? AND submitted_date IS NULL) OR performance_status = 'unsatisfactory'").all(soonIso) as any[];
    for (const r of rows) out.push({ moduleKey: 'poct', recordType: 'poct_eqa_events', recordId: String(r.id), title: `POCT EQA ${r.performance_status === 'unsatisfactory' ? 'unsatisfactory' : 'due'}: ${r.event_number}`, message: r.due_date ? `Due ${r.due_date}` : 'Unsatisfactory performance', dueDate: r.due_date, severity: 'medium', notificationType: r.due_date ? 'due_soon' : 'follow_up', itemType: 'poct_eqa' });
  }
  if (tableExists(db, 'poct_devices')) {
    const rows = db.prepare("SELECT id, device_name, next_service_due FROM poct_devices WHERE next_service_due IS NOT NULL AND next_service_due <= ? AND status = 'active'").all(soonIso) as any[];
    for (const r of rows) out.push({ moduleKey: 'poct', recordType: 'poct_devices', recordId: String(r.id), title: `POCT device maintenance due: ${r.device_name}`, message: `Next service ${r.next_service_due}`, dueDate: r.next_service_due, severity: 'medium', notificationType: 'expiry_alert', itemType: 'poct_maintenance_due' });
  }
  if (tableExists(db, 'poct_incidents')) {
    const rows = db.prepare("SELECT id, incident_number, incident_date FROM poct_incidents WHERE status != 'closed'").all() as any[];
    for (const r of rows) out.push({ moduleKey: 'poct', recordType: 'poct_incidents', recordId: String(r.id), title: `Open POCT incident: ${r.incident_number}`, message: `Incident ${r.incident_date}`, dueDate: r.incident_date, severity: 'high', notificationType: 'follow_up', itemType: 'poct_incident_open' });
  }
  if (tableExists(db, 'poct_monthly_reviews')) {
    const rows = db.prepare("SELECT id, review_number FROM poct_monthly_reviews WHERE status IN ('draft','reviewed')").all() as any[];
    for (const r of rows) out.push({ moduleKey: 'poct', recordType: 'poct_monthly_reviews', recordId: String(r.id), title: `POCT monthly review pending: ${r.review_number}`, message: 'Pending approval/close', dueDate: null, severity: 'low', notificationType: 'approval_required', itemType: 'poct_review_pending' });
  }

  // NC/CAPA / risks / complaints
  if (tableExists(db, 'capa_records')) {
    const rows = db.prepare("SELECT id, capa_number, due_date FROM capa_records WHERE status != 'closed' AND due_date IS NOT NULL AND due_date <= ?").all(soonIso) as any[];
    for (const r of rows) { const overdue = r.due_date < today; out.push({ moduleKey: 'nc_capa', recordType: 'capa_records', recordId: String(r.id), title: `CAPA ${overdue ? 'overdue' : 'due'}: ${r.capa_number}`, message: `Due ${r.due_date}`, dueDate: r.due_date, severity: overdue ? 'high' : 'medium', notificationType: overdue ? 'overdue' : 'due_soon', itemType: 'capa_due' }); }
  }
  if (tableExists(db, 'risks')) {
    const rows = db.prepare("SELECT id, risk_number, review_due_date FROM risks WHERE review_due_date IS NOT NULL AND review_due_date <= ? AND status = 'active'").all(soonIso) as any[];
    for (const r of rows) out.push({ moduleKey: 'risks', recordType: 'risks', recordId: String(r.id), title: `Risk review due: ${r.risk_number}`, message: `Review by ${r.review_due_date}`, dueDate: r.review_due_date, severity: 'medium', notificationType: 'review_required', itemType: 'risk_review' });
  }

  return out;
}

export function notificationsRoutes() {
  const router = Router();

  // -------- Summary --------
  router.get('/summary', requirePermission('notifications', 'view'), (req, res) => {
    res.json(computeSummary(req));
  });

  // -------- Rules --------
  router.get('/rules', requirePermission('notifications', 'view'), (_req, res) => {
    const db = getDb();
    res.json(db.prepare('SELECT * FROM notification_rules ORDER BY rule_name').all());
  });

  router.post('/rules', requirePermission('notifications', 'create'), (req, res) => {
    if (!req.body.ruleName) return res.status(400).json({ error: 'ruleName is required' });
    if (!req.body.moduleKey) return res.status(400).json({ error: 'moduleKey is required' });
    if (!req.body.triggerType) return res.status(400).json({ error: 'triggerType is required' });
    if (!RULE_TRIGGER_TYPES.includes(req.body.triggerType)) return res.status(400).json({ error: `triggerType must be one of: ${RULE_TRIGGER_TYPES.join(', ')}` });
    const db = getDb();
    const createdAt = new Date().toISOString();
    const ruleCode = req.body.ruleCode || generateRecordNumber(db, 'notification_rules', 'NRULE', createdAt);
    const result = db.prepare(`INSERT INTO notification_rules (rule_code, rule_name, module_key, trigger_type, due_field, reminder_days_before, escalation_days_after, target_role_key, target_position_id, target_staff_id, is_active, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(ruleCode, req.body.ruleName, req.body.moduleKey, req.body.triggerType, req.body.dueField ?? null, parseIntNullable(req.body.reminderDaysBefore), parseIntNullable(req.body.escalationDaysAfter), req.body.targetRoleKey ?? null, parseIntNullable(req.body.targetPositionId), parseIntNullable(req.body.targetStaffId), req.body.isActive === false ? 0 : 1, req.user!.id);
    const id = Number(result.lastInsertRowid);
    audit(req, { action: 'create', entity: 'notification_rules', entityId: id, newValue: { ruleCode, ...req.body } });
    res.status(201).json({ id, ruleCode });
  });

  router.get('/rules/:id', requirePermission('notifications', 'view'), (req, res) => {
    const db = getDb();
    const rule = db.prepare('SELECT * FROM notification_rules WHERE id = ?').get(req.params.id);
    if (!rule) return res.status(404).json({ error: 'Rule not found' });
    res.json(rule);
  });

  router.put('/rules/:id', requirePermission('notifications', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM notification_rules WHERE id = ?').get(req.params.id) as any;
    if (!oldValue) return res.status(404).json({ error: 'Rule not found' });
    if (req.body.triggerType && !RULE_TRIGGER_TYPES.includes(req.body.triggerType)) return res.status(400).json({ error: `triggerType must be one of: ${RULE_TRIGGER_TYPES.join(', ')}` });
    db.prepare(`UPDATE notification_rules SET rule_name = ?, module_key = ?, trigger_type = ?, due_field = ?, reminder_days_before = ?, escalation_days_after = ?, target_role_key = ?, target_position_id = ?, target_staff_id = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(req.body.ruleName ?? oldValue.rule_name, req.body.moduleKey ?? oldValue.module_key, req.body.triggerType ?? oldValue.trigger_type, req.body.dueField ?? oldValue.due_field, parseIntNullable(req.body.reminderDaysBefore) ?? oldValue.reminder_days_before, parseIntNullable(req.body.escalationDaysAfter) ?? oldValue.escalation_days_after, req.body.targetRoleKey ?? oldValue.target_role_key, parseIntNullable(req.body.targetPositionId) ?? oldValue.target_position_id, parseIntNullable(req.body.targetStaffId) ?? oldValue.target_staff_id, req.body.isActive !== undefined ? (req.body.isActive ? 1 : 0) : oldValue.is_active, req.params.id);
    audit(req, { action: 'edit', entity: 'notification_rules', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  router.post('/rules/:id/toggle', requirePermission('notifications', 'edit'), (req, res) => {
    const db = getDb();
    const r = db.prepare('SELECT * FROM notification_rules WHERE id = ?').get(req.params.id) as any;
    if (!r) return res.status(404).json({ error: 'Rule not found' });
    const newActive = r.is_active ? 0 : 1;
    db.prepare('UPDATE notification_rules SET is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(newActive, req.params.id);
    audit(req, { action: 'toggle', entity: 'notification_rules', entityId: req.params.id, oldValue: { is_active: r.is_active }, newValue: { is_active: newActive } });
    res.json({ ok: true, isActive: newActive === 1 });
  });

  // -------- Calendar --------
  router.get('/calendar', requirePermission('notifications', 'view'), (req, res) => {
    const db = getDb();
    const filters: string[] = []; const params: unknown[] = [];
    if (req.query.moduleKey) { filters.push('module_key = ?'); params.push(String(req.query.moduleKey)); }
    if (req.query.itemType) { filters.push('item_type = ?'); params.push(String(req.query.itemType)); }
    if (req.query.status) { filters.push('status = ?'); params.push(String(req.query.status)); }
    if (req.query.from) { filters.push('due_date >= ?'); params.push(String(req.query.from)); }
    if (req.query.to) { filters.push('due_date <= ?'); params.push(String(req.query.to)); }
    let query = 'SELECT * FROM review_calendar_items';
    if (filters.length) query += ` WHERE ${filters.join(' AND ')}`;
    query += ' ORDER BY due_date, id LIMIT 500';
    res.json(db.prepare(query).all(...params));
  });

  router.post('/calendar', requirePermission('notifications', 'create'), (req, res) => {
    if (!req.body.title) return res.status(400).json({ error: 'title is required' });
    if (!req.body.dueDate) return res.status(400).json({ error: 'dueDate is required' });
    if (!req.body.itemType) return res.status(400).json({ error: 'itemType is required' });
    const db = getDb();
    const createdAt = new Date().toISOString();
    const calendarNumber = generateRecordNumber(db, 'review_calendar_items', 'CAL', createdAt);
    const result = db.prepare(`INSERT INTO review_calendar_items (calendar_number, module_key, record_type, record_id, title, description, due_date, item_type, responsible_staff_id, responsible_position_id, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(calendarNumber, req.body.moduleKey ?? null, req.body.recordType ?? null, req.body.recordId ?? null, req.body.title, req.body.description ?? null, req.body.dueDate, req.body.itemType, parseIntNullable(req.body.responsibleStaffId), parseIntNullable(req.body.responsiblePositionId), req.body.status ?? 'pending', req.user!.id);
    const id = Number(result.lastInsertRowid);
    if (req.body.moduleKey && req.body.recordType && req.body.recordId) {
      db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run('notifications', 'review_calendar_items', String(id), req.body.moduleKey, req.body.recordType, String(req.body.recordId), 'Calendar item');
    }
    audit(req, { action: 'create', entity: 'review_calendar_items', entityId: id, newValue: { calendarNumber, ...req.body } });
    res.status(201).json({ id, calendarNumber });
  });

  router.post('/calendar/generate', requirePermission('notifications', 'create'), (req, res) => {
    const db = getDb();
    const today = new Date().toISOString().slice(0, 10);
    const candidates = collectScanCandidates(db);
    let notifsCreated = 0, calendarCreated = 0, skipped = 0;
    const existsNotif = db.prepare("SELECT id FROM notifications WHERE module_key = ? AND record_type = ? AND record_id = ? AND notification_type = ? AND COALESCE(due_date,'') = COALESCE(?,'') AND status NOT IN ('resolved','dismissed')");
    const existsCal = db.prepare("SELECT id FROM review_calendar_items WHERE module_key = ? AND record_type = ? AND record_id = ? AND due_date = ? AND status != 'completed' AND status != 'cancelled'");
    const insertNotif = db.prepare(`INSERT INTO notifications (notification_number, user_id, module_key, title, message, status, severity, notification_type, due_date, record_type, record_id, assigned_to_staff_id, created_by) VALUES (?, NULL, ?, ?, ?, 'unread', ?, ?, ?, ?, ?, ?, ?)`);
    const insertCal = db.prepare(`INSERT INTO review_calendar_items (calendar_number, module_key, record_type, record_id, title, description, due_date, item_type, responsible_staff_id, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const tx = db.transaction(() => {
      for (const c of candidates) {
        const sev = severityForCandidate(c);
        const notifKey = existsNotif.get(c.moduleKey, c.recordType, c.recordId, c.notificationType, c.dueDate);
        if (notifKey) skipped++;
        else {
          const notifNumber = generateRecordNumber(db, 'notifications', 'NOTIF', new Date().toISOString());
          insertNotif.run(notifNumber, c.moduleKey, c.title, c.message, sev, c.notificationType, c.dueDate, c.recordType, c.recordId, c.responsibleStaffId ?? null, req.user!.id);
          notifsCreated++;
        }
        if (c.dueDate) {
          const calStatus = c.dueDate < today ? 'overdue' : 'due_soon';
          const calKey = existsCal.get(c.moduleKey, c.recordType, c.recordId, c.dueDate);
          if (calKey) skipped++;
          else {
            const calNumber = generateRecordNumber(db, 'review_calendar_items', 'CAL', new Date().toISOString());
            insertCal.run(calNumber, c.moduleKey, c.recordType, c.recordId, c.title, c.message, c.dueDate, c.itemType, c.responsibleStaffId ?? null, calStatus, req.user!.id);
            calendarCreated++;
          }
        }
      }
    });
    tx();
    audit(req, { action: 'generate', entity: 'review_calendar_items', entityId: 'scan', newValue: { candidates: candidates.length, notifsCreated, calendarCreated, skipped } });
    res.json({ ok: true, candidates: candidates.length, notificationsCreated: notifsCreated, calendarItemsCreated: calendarCreated, skipped });
  });

  router.get('/calendar/:id', requirePermission('notifications', 'view'), (req, res) => {
    const db = getDb();
    const item = db.prepare('SELECT * FROM review_calendar_items WHERE id = ?').get(req.params.id);
    if (!item) return res.status(404).json({ error: 'Calendar item not found' });
    res.json(item);
  });

  router.put('/calendar/:id', requirePermission('notifications', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM review_calendar_items WHERE id = ?').get(req.params.id) as any;
    if (!oldValue) return res.status(404).json({ error: 'Calendar item not found' });
    if (req.body.status && !CALENDAR_STATUSES.includes(req.body.status)) return res.status(400).json({ error: `status must be one of: ${CALENDAR_STATUSES.join(', ')}` });
    db.prepare('UPDATE review_calendar_items SET title = ?, description = ?, due_date = ?, item_type = ?, responsible_staff_id = ?, responsible_position_id = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(req.body.title ?? oldValue.title, req.body.description ?? oldValue.description, req.body.dueDate ?? oldValue.due_date, req.body.itemType ?? oldValue.item_type, parseIntNullable(req.body.responsibleStaffId) ?? oldValue.responsible_staff_id, parseIntNullable(req.body.responsiblePositionId) ?? oldValue.responsible_position_id, req.body.status ?? oldValue.status, req.params.id);
    audit(req, { action: 'edit', entity: 'review_calendar_items', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  router.post('/calendar/:id/complete', requirePermission('notifications', 'edit'), (req, res) => {
    const db = getDb();
    const item = db.prepare('SELECT * FROM review_calendar_items WHERE id = ?').get(req.params.id) as any;
    if (!item) return res.status(404).json({ error: 'Calendar item not found' });
    db.prepare("UPDATE review_calendar_items SET status = 'completed', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
    audit(req, { action: 'complete', entity: 'review_calendar_items', entityId: req.params.id, oldValue: { status: item.status }, newValue: { status: 'completed' } });
    res.json({ ok: true });
  });

  // -------- Tasks --------
  router.get('/tasks', requirePermission('notifications', 'view'), (req, res) => {
    const db = getDb();
    const filters: string[] = []; const params: unknown[] = [];
    if (req.query.status) { filters.push('status = ?'); params.push(String(req.query.status)); }
    if (req.query.mine === 'true' && req.user?.staffId) { filters.push('assigned_to_staff_id = ?'); params.push(req.user.staffId); }
    if (req.query.assignedToStaffId) { filters.push('assigned_to_staff_id = ?'); params.push(Number(req.query.assignedToStaffId)); }
    let query = 'SELECT * FROM user_task_queue';
    if (filters.length) query += ` WHERE ${filters.join(' AND ')}`;
    query += ' ORDER BY CASE status WHEN \'overdue\' THEN 0 WHEN \'open\' THEN 1 WHEN \'in_progress\' THEN 2 ELSE 3 END, due_date NULLS LAST, id DESC LIMIT 500';
    res.json(db.prepare(query).all(...params));
  });

  router.post('/tasks', requirePermission('notifications', 'create'), (req, res) => {
    if (!req.body.title) return res.status(400).json({ error: 'title is required' });
    const db = getDb();
    const createdAt = new Date().toISOString();
    const taskNumber = generateRecordNumber(db, 'user_task_queue', 'TASK', createdAt);
    const result = db.prepare(`INSERT INTO user_task_queue (task_number, title, description, module_key, record_type, record_id, assigned_to_staff_id, assigned_to_user_id, priority, due_date, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(taskNumber, req.body.title, req.body.description ?? null, req.body.moduleKey ?? null, req.body.recordType ?? null, req.body.recordId ?? null, parseIntNullable(req.body.assignedToStaffId), parseIntNullable(req.body.assignedToUserId), req.body.priority ?? 'normal', req.body.dueDate ?? null, req.body.status ?? 'open', req.user!.id);
    const id = Number(result.lastInsertRowid);
    if (req.body.moduleKey && req.body.recordType && req.body.recordId) {
      db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run('notifications', 'user_task_queue', String(id), req.body.moduleKey, req.body.recordType, String(req.body.recordId), 'Task');
    }
    audit(req, { action: 'create', entity: 'user_task_queue', entityId: id, newValue: { taskNumber, ...req.body } });
    res.status(201).json({ id, taskNumber });
  });

  router.get('/tasks/:id', requirePermission('notifications', 'view'), (req, res) => {
    const db = getDb();
    const task = db.prepare('SELECT * FROM user_task_queue WHERE id = ?').get(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    res.json(task);
  });

  router.put('/tasks/:id', requirePermission('notifications', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM user_task_queue WHERE id = ?').get(req.params.id) as any;
    if (!oldValue) return res.status(404).json({ error: 'Task not found' });
    if (req.body.status && !TASK_STATUSES.includes(req.body.status)) return res.status(400).json({ error: `status must be one of: ${TASK_STATUSES.join(', ')}` });
    db.prepare('UPDATE user_task_queue SET title = ?, description = ?, assigned_to_staff_id = ?, assigned_to_user_id = ?, priority = ?, due_date = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(req.body.title ?? oldValue.title, req.body.description ?? oldValue.description, parseIntNullable(req.body.assignedToStaffId) ?? oldValue.assigned_to_staff_id, parseIntNullable(req.body.assignedToUserId) ?? oldValue.assigned_to_user_id, req.body.priority ?? oldValue.priority, req.body.dueDate ?? oldValue.due_date, req.body.status ?? oldValue.status, req.params.id);
    audit(req, { action: 'edit', entity: 'user_task_queue', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  router.post('/tasks/:id/start', requirePermission('notifications', 'edit'), (req, res) => {
    const db = getDb();
    const task = db.prepare('SELECT * FROM user_task_queue WHERE id = ?').get(req.params.id) as any;
    if (!task) return res.status(404).json({ error: 'Task not found' });
    db.prepare("UPDATE user_task_queue SET status = 'in_progress', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
    audit(req, { action: 'start', entity: 'user_task_queue', entityId: req.params.id, oldValue: { status: task.status }, newValue: { status: 'in_progress' } });
    res.json({ ok: true });
  });

  router.post('/tasks/:id/complete', requirePermission('notifications', 'edit'), (req, res) => {
    const db = getDb();
    const task = db.prepare('SELECT * FROM user_task_queue WHERE id = ?').get(req.params.id) as any;
    if (!task) return res.status(404).json({ error: 'Task not found' });
    db.prepare("UPDATE user_task_queue SET status = 'completed', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
    audit(req, { action: 'complete', entity: 'user_task_queue', entityId: req.params.id, oldValue: { status: task.status }, newValue: { status: 'completed' } });
    res.json({ ok: true });
  });

  router.post('/tasks/:id/cancel', requirePermission('notifications', 'edit'), (req, res) => {
    const db = getDb();
    const task = db.prepare('SELECT * FROM user_task_queue WHERE id = ?').get(req.params.id) as any;
    if (!task) return res.status(404).json({ error: 'Task not found' });
    db.prepare("UPDATE user_task_queue SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
    audit(req, { action: 'cancel', entity: 'user_task_queue', entityId: req.params.id, oldValue: { status: task.status }, newValue: { status: 'cancelled' } });
    res.json({ ok: true });
  });

  // -------- Preferences --------
  router.get('/preferences', requirePermission('notifications', 'view'), (req, res) => {
    const db = getDb();
    if (!req.user) return res.status(401).json({ error: 'auth required' });
    res.json(db.prepare('SELECT * FROM notification_preferences WHERE user_id = ?').all(req.user.id));
  });

  router.put('/preferences', requirePermission('notifications', 'edit'), (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'auth required' });
    const items = Array.isArray(req.body.preferences) ? req.body.preferences : [];
    const db = getDb();
    const upsert = db.prepare(`INSERT INTO notification_preferences (user_id, staff_id, module_key, in_app_enabled, digest_enabled, email_enabled, sms_enabled) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, module_key) DO UPDATE SET in_app_enabled = excluded.in_app_enabled, digest_enabled = excluded.digest_enabled, email_enabled = excluded.email_enabled, sms_enabled = excluded.sms_enabled, updated_at = CURRENT_TIMESTAMP`);
    const tx = db.transaction(() => { for (const p of items) upsert.run(req.user!.id, getCurrentStaffId(req), p.moduleKey ?? null, p.inAppEnabled === false ? 0 : 1, p.digestEnabled ? 1 : 0, p.emailEnabled ? 1 : 0, p.smsEnabled ? 1 : 0); });
    tx();
    audit(req, { action: 'edit', entity: 'notification_preferences', entityId: req.user.id, newValue: { count: items.length } });
    res.json({ ok: true, saved: items.length });
  });

  // -------- Notifications CRUD (must come AFTER specific routes) --------
  router.get('/', requirePermission('notifications', 'view'), (req, res) => {
    const db = getDb();
    const filters: string[] = []; const params: unknown[] = [];
    if (req.query.status) { filters.push('status = ?'); params.push(String(req.query.status)); }
    if (req.query.moduleKey) { filters.push('module_key = ?'); params.push(String(req.query.moduleKey)); }
    if (req.query.severity) { filters.push('severity = ?'); params.push(String(req.query.severity)); }
    if (req.query.mine === 'true' && req.user?.staffId) { filters.push('(assigned_to_staff_id = ? OR assigned_to_staff_id IS NULL)'); params.push(req.user.staffId); }
    let query = 'SELECT * FROM notifications';
    if (filters.length) query += ` WHERE ${filters.join(' AND ')}`;
    query += " ORDER BY CASE status WHEN 'unread' THEN 0 WHEN 'read' THEN 1 ELSE 2 END, CASE severity WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, due_date NULLS LAST, id DESC LIMIT 500";
    res.json(db.prepare(query).all(...params));
  });

  router.post('/', requirePermission('notifications', 'create'), (req, res) => {
    if (!req.body.title) return res.status(400).json({ error: 'title is required' });
    if (!req.body.message) return res.status(400).json({ error: 'message is required' });
    if (!req.body.notificationType) return res.status(400).json({ error: 'notificationType is required' });
    if (!NOTIFICATION_TYPES.includes(req.body.notificationType)) return res.status(400).json({ error: `notificationType must be one of: ${NOTIFICATION_TYPES.join(', ')}` });
    if (!req.body.severity) return res.status(400).json({ error: 'severity is required' });
    if (!NOTIFICATION_SEVERITIES.includes(req.body.severity)) return res.status(400).json({ error: `severity must be one of: ${NOTIFICATION_SEVERITIES.join(', ')}` });
    const db = getDb();
    const createdAt = new Date().toISOString();
    const notifNumber = generateRecordNumber(db, 'notifications', 'NOTIF', createdAt);
    const result = db.prepare(`INSERT INTO notifications (notification_number, user_id, module_key, title, message, status, severity, notification_type, due_date, record_type, record_id, assigned_to_staff_id, assigned_to_user_id, source_rule_id, created_by) VALUES (?, ?, ?, ?, ?, 'unread', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(notifNumber, parseIntNullable(req.body.userId), req.body.moduleKey ?? 'notifications', req.body.title, req.body.message, req.body.severity, req.body.notificationType, req.body.dueDate ?? null, req.body.recordType ?? null, req.body.recordId ?? null, parseIntNullable(req.body.assignedToStaffId), parseIntNullable(req.body.assignedToUserId), parseIntNullable(req.body.sourceRuleId), req.user!.id);
    const id = Number(result.lastInsertRowid);
    eventLog(db, id, 'created', null, getCurrentStaffId(req), req.user!.id);
    audit(req, { action: 'create', entity: 'notifications', entityId: id, newValue: { notifNumber, ...req.body } });
    res.status(201).json({ id, notificationNumber: notifNumber });
  });

  router.get('/:id', requirePermission('notifications', 'view'), (req, res) => {
    const db = getDb();
    const n = db.prepare('SELECT * FROM notifications WHERE id = ?').get(req.params.id);
    if (!n) return res.status(404).json({ error: 'Notification not found' });
    const events = db.prepare('SELECT * FROM notification_events WHERE notification_id = ? ORDER BY id').all(req.params.id);
    res.json({ ...n, events });
  });

  function transitionStatus(req: any, res: any, newStatus: string, eventType: string, setFields: { staffField?: string; tsField?: string } = {}) {
    const db = getDb();
    const n = db.prepare('SELECT * FROM notifications WHERE id = ?').get(req.params.id) as any;
    if (!n) return res.status(404).json({ error: 'Notification not found' });
    const staffId = getCurrentStaffId(req);
    let setClause = `status = ?, updated_at = CURRENT_TIMESTAMP`;
    const args: any[] = [newStatus];
    if (setFields.staffField) { setClause += `, ${setFields.staffField} = ?`; args.push(staffId); }
    if (setFields.tsField) { setClause += `, ${setFields.tsField} = CURRENT_TIMESTAMP`; }
    args.push(req.params.id);
    db.prepare(`UPDATE notifications SET ${setClause} WHERE id = ?`).run(...args);
    eventLog(db, Number(req.params.id), eventType, req.body?.note ?? null, staffId, req.user!.id);
    audit(req, { action: eventType, entity: 'notifications', entityId: req.params.id, oldValue: { status: n.status }, newValue: { status: newStatus } });
    res.json({ ok: true });
  }

  router.post('/:id/read', requirePermission('notifications', 'view'), (req, res) => transitionStatus(req, res, 'read', 'read'));
  router.post('/:id/acknowledge', requirePermission('notifications', 'edit'), (req, res) => transitionStatus(req, res, 'acknowledged', 'acknowledge', { staffField: 'acknowledged_by_staff_id', tsField: 'acknowledged_at' }));
  router.post('/:id/resolve', requirePermission('notifications', 'edit'), (req, res) => transitionStatus(req, res, 'resolved', 'resolve', { staffField: 'resolved_by_staff_id', tsField: 'resolved_at' }));
  router.post('/:id/dismiss', requirePermission('notifications', 'edit'), (req, res) => transitionStatus(req, res, 'dismissed', 'dismiss'));

  return router;
}

function computeSummary(req: any) {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);
  const soon = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const count = (sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { count: number }).count;
  const mineFilter = req.user?.staffId ? ` AND (assigned_to_staff_id = ${Number(req.user.staffId)} OR assigned_to_staff_id IS NULL)` : '';
  const byModuleRows = db.prepare("SELECT module_key, COUNT(*) AS c FROM notifications WHERE status IN ('unread','read','acknowledged') GROUP BY module_key").all() as Array<{ module_key: string; c: number }>;
  const byModule: Record<string, number> = {};
  for (const r of byModuleRows) byModule[r.module_key || 'unknown'] = r.c;
  return {
    unreadNotifications: count("SELECT COUNT(*) count FROM notifications WHERE status = 'unread'"),
    urgentNotifications: count("SELECT COUNT(*) count FROM notifications WHERE severity IN ('urgent','high') AND status NOT IN ('resolved','dismissed')"),
    dueToday: count("SELECT COUNT(*) count FROM notifications WHERE due_date = ? AND status NOT IN ('resolved','dismissed')", today),
    dueSoon: count("SELECT COUNT(*) count FROM notifications WHERE due_date > ? AND due_date <= ? AND status NOT IN ('resolved','dismissed')", today, soon),
    overdue: count("SELECT COUNT(*) count FROM notifications WHERE due_date IS NOT NULL AND due_date < ? AND status NOT IN ('resolved','dismissed')", today),
    openTasks: count("SELECT COUNT(*) count FROM user_task_queue WHERE status IN ('open','in_progress','overdue')"),
    myOpenTasks: req.user?.staffId ? count("SELECT COUNT(*) count FROM user_task_queue WHERE status IN ('open','in_progress','overdue') AND assigned_to_staff_id = ?", req.user.staffId) : 0,
    pendingApprovals: count("SELECT COUNT(*) count FROM notifications WHERE notification_type = 'approval_required' AND status NOT IN ('resolved','dismissed')" + mineFilter),
    reviewItemsDue: count("SELECT COUNT(*) count FROM review_calendar_items WHERE status IN ('pending','due_soon','overdue') AND due_date <= ?", soon),
    followUpsDue: count("SELECT COUNT(*) count FROM notifications WHERE notification_type = 'follow_up' AND status NOT IN ('resolved','dismissed')"),
    byModule
  };
}

export { computeSummary, NOTIFICATION_STATUSES, NOTIFICATION_SEVERITIES, NOTIFICATION_TYPES, CALENDAR_STATUSES, TASK_STATUSES, RULE_TRIGGER_TYPES };
