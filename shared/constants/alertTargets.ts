/**
 * Where an alert actually lives.
 *
 * An alert used to open the module and stop there: "Equipment calibration
 * overdue: Centrifuge 2" landed on the Equipment dashboard, leaving the reader
 * to work out that the record was three tabs away. This map closes that gap —
 * every kind of alert names the workspace tab (and, where the module is split
 * across routes, the route) that holds the record it is about.
 *
 * Keyed by the `itemType` the alert scan assigns, because that is the finest
 * distinction the scan makes: two alerts on the same table can belong on
 * different tabs (an equipment calibration and an equipment breakdown both
 * point at equipment_items).
 *
 * The client pairs this with `?focus=<recordType>:<recordId>`, which scrolls to
 * and flashes the row once the tab has opened. A missing entry is harmless: the
 * alert lands on the module as it always did.
 */
export type AlertTarget = {
  /** Route to open, when the module is served by more than one. */
  route?: string;
  /** Workspace tab the record lives on. */
  tab?: string;
  /** Inner tab, for a workspace nested inside another module's tab. */
  subtab?: string;
};

export const ALERT_TARGETS: Record<string, AlertTarget> = {
  /* Documents & records */
  document_review: { tab: 'Documents' },
  attestation: { tab: 'Documents' },
  archive_retention_due: { tab: 'Central Archive' },

  /* Personnel */
  staff_document_expiry: { tab: 'Staff Documents' },
  competency_due: { tab: 'Competency Assessments' },
  authorization_expiry: { tab: 'Technical Authorizations' },
  roster_approval: { tab: 'Duty Roster' },
  roster_preparation: { tab: 'Duty Roster' },
  reassignment_preparation: { tab: 'Unit Reassignments' },
  bench_preparation: { tab: 'Bench Schedules' },
  schedule_carried_forward: { tab: 'Duty Roster' },

  /* Unit activities — the recurring work the duty roster puts in front of
     whoever is on the bench. The to-do itself lives on the dashboard, so the
     alert lands on the register that lists every occurrence. */
  activity_due: { route: '/dashboard' },
  activity_overdue: { route: '/dashboard' },
  activity_missed: { route: '/system-audit', tab: 'Not Done' },
  activity_redesign: { route: '/settings/activities' },

  /* Equipment */
  // All three name an instrument, and the register is the one place every
  // instrument has a row to scroll to and flash.
  equipment_calibration: { tab: 'Equipment Register' },
  equipment_maintenance: { tab: 'Equipment Register' },
  equipment_schedule: { tab: 'Equipment Register' },
  breakdown_open: { tab: 'Breakdowns' },

  /* Supplier & inventory */
  // Lots live on the Receiving tab, on the bench that deals with what a
  // delivery created.
  inventory_batch_expiry: { tab: 'Receiving', subtab: 'Batches & lots' },
  inventory_low_stock: { tab: 'Item Register' },
  supplier_evaluation_due: { tab: 'Suppliers' },

  /* Environmental monitoring */
  monitoring_excursion: { tab: 'Excursions' },

  /* Quality control */
  iqc_review: { tab: 'Review' },
  eqa_event: { tab: 'EQA Events' },
  method_verification_approval: { tab: 'Register' },
  equipment_verification_approval: { tab: 'Equipment verification' },
  mu_review: { tab: 'Review/Approval' },

  /* Blood bank */
  blood_unit_expiry: { tab: 'Blood Units' },
  bb_adverse_open: { tab: 'Adverse Events' },
  handover_pending: { tab: 'Handovers' },

  /* Monthly reports */
  monthly_import_pending: { tab: 'Import Batches' },
  monthly_exception: { tab: 'Exceptions' },
  monthly_report_draft: { tab: 'Monthly Reports' },

  /* Assessments */
  assessment_due: { tab: 'Assessment Programmes' },
  finding_open: { tab: 'Findings' },

  /* Governance */
  meeting_due: { tab: 'Meetings' },
  mreview_pending: { tab: 'Review Register' },
  indicator_review: { tab: 'Results Entry' },
  improvement_overdue: { tab: 'Improvement Projects' },

  /* Customer focus */
  feedback_follow_up: { tab: 'Feedback Intake' },
  agreement_review: { tab: 'Service Agreements' },
  communication_follow_up: { tab: 'Communication Log' },
  survey_ending: { tab: 'Satisfaction Surveys' },

  /* POCT */
  poct_authorization_expiry: { tab: 'Operator Authorizations' },
  poct_qc_review: { tab: 'QC Monitoring' },
  poct_eqa: { tab: 'EQA Monitoring' },
  poct_maintenance_due: { tab: 'Devices' },
  poct_incident_open: { tab: 'Incidents' },
  poct_review_pending: { tab: 'Monthly Reviews' },

  /* Nonconforming event management — three routes under one module */
  nc_open: { route: '/nonconformities', tab: 'Register' },
  capa_due: { route: '/capa', tab: 'Register' },
  risk_review: { route: '/risks', tab: 'Risk Register' },
  complaint_open: { route: '/complaints', tab: 'Complaints Register' },

  /* Facilities & safety */
  safety_incident_open: { tab: 'Safety Incidents' },
  safety_equipment_inspection: { tab: 'Safety Equipment' },
  safety_equipment_certification: { tab: 'Safety Equipment' },
  safety_inspection_due: { tab: 'Inspections & Drills' },
  storage_inspection_due: { tab: 'Inspections & Drills' },
  chemical_expiry: { tab: 'Hazardous Chemicals' },
  chemical_missing_sds: { tab: 'Hazardous Chemicals' },
  immunization_due: { tab: 'Immunisation & Exposure' },
  // Environmental monitoring is a workspace inside Facilities & Safety, so it
  // takes both an outer tab and an inner one.
  env_excursion_open: { tab: 'Environmental Monitoring', subtab: 'Excursions' },
  env_alert_active: { tab: 'Environmental Monitoring', subtab: 'Alerts' },

  /* Process management */
  specimen_rejection_open: { tab: 'Specimen Rejections' },
  critical_result_pending: { tab: 'Critical Notifications' },
  referral_overdue: { tab: 'Referral Sendouts' },

  /* Organisation & leadership */
  registration_expiry: { tab: 'Registrations & Licences' },
  budget_pending: { tab: 'Budgetary Projection' },
  ethical_declaration_unsigned: { tab: 'Code of Conduct' },
  qt_review_due: { tab: 'Quality & Technical Records Review' },
  qt_review_followup: { tab: 'Quality & Technical Records Review' },
  continuity_review_due: { tab: 'Organogram & Deputisation' },

  /* Information management */
  infosec_incident_open: { tab: 'Security Incidents' },
  data_correction_pending: { tab: 'Data Corrections' },
};

export function alertTargetFor(itemType: string | null | undefined): AlertTarget {
  return (itemType && ALERT_TARGETS[itemType]) || {};
}
