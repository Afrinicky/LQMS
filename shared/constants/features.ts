/**
 * FEATURES — the unit permissions are actually granted on.
 *
 * A module is not one thing. Personnel Management holds fifteen tabs, Process
 * Management twenty-two. Granting "personnel: view" to let someone see the
 * training calendar also handed them every colleague's appraisals, because a
 * module was the smallest thing a permission could name.
 *
 * A feature is a coherent slice of a module — the tabs and operations that
 * belong together and that an administrator would sensibly grant or withhold as
 * one. Permissions attach to features; a module's access is the union of the
 * features a user holds inside it, so existing module-level route guards keep
 * working while sensitive areas get a key of their own.
 *
 * Modules absent from FEATURES keep a single implicit feature equal to the
 * module key, so nothing needs a feature until it earns one.
 */

/* ============================================================================
   Access levels — what the administrator actually picks
   ----------------------------------------------------------------------------
   The old matrix asked for seven checkboxes per module per role: 224 decisions
   to grant one cohort a coherent set of rights, with no grouping and no
   defaults. Nobody can review that, which is how the seeded defaults drifted.

   One level per feature replaces them. Levels are ordered, so "at least
   Contribute" is a meaningful question, and each expands to the action set the
   engine already enforces — nothing is lost, it is just no longer hand-ticked.
   ========================================================================= */
export const ACCESS_LEVELS = ['none', 'view', 'contribute', 'manage', 'full'] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];

export const LEVEL_ACTIONS: Record<AccessLevel, string[]> = {
  none: [],
  view: ['view', 'print'],
  contribute: ['view', 'print', 'create'],
  manage: ['view', 'print', 'create', 'edit', 'export'],
  full: ['view', 'print', 'create', 'edit', 'export', 'import', 'void_archive', 'approve'],
};

export const LEVEL_LABELS: Record<AccessLevel, string> = {
  none: 'No access',
  view: 'View',
  contribute: 'Contribute',
  manage: 'Manage',
  full: 'Full',
};

export const LEVEL_HINTS: Record<AccessLevel, string> = {
  none: 'Hidden entirely — not shown in menus, dashboards or search.',
  view: 'Can open and print, but change nothing.',
  contribute: 'Can add new records, but not alter or remove existing ones.',
  manage: 'Can add, change and export records.',
  full: 'Everything in Manage, plus approving, archiving and loading a spreadsheet back in.',
};

/** The level whose action set matches a list of granted actions. */
export function levelForActions(actions: string[]): AccessLevel {
  const held = new Set(actions);
  for (const level of [...ACCESS_LEVELS].reverse()) {
    if (level === 'none') continue;
    if (LEVEL_ACTIONS[level].every(a => held.has(a))) return level;
  }
  return held.size > 0 ? 'view' : 'none';
}

/* ============================================================================
   The catalogue
   ========================================================================= */
export type FeatureDef = {
  /** Stable permission key, always `<module>.<name>`. */
  key: string;
  module: string;
  label: string;
  /** One line an administrator can decide from, shown in the matrix. */
  desc: string;
  /** Workspace tabs this feature governs. A tab with no feature is always shown. */
  tabs?: string[];
  /**
   * Personal data: the signed-in user always reaches their OWN records here,
   * whatever their level. The level then controls what they see of everyone
   * else's — which is how "edit your own details, never open anyone else's"
   * becomes a setting instead of a wish.
   */
  personal?: boolean;
  /**
   * Confidential or laboratory-defining. Surfaced in the matrix so an
   * administrator is not granting HR files or reference intervals by accident.
   */
  sensitive?: boolean;
};

export const FEATURES: FeatureDef[] = [
  // ── Personnel Management ────────────────────────────────────────────────
  // Governs no tab in the Personnel workspace any more: a person's own record
  // is My Portal, which is a module in its own right. The key remains because
  // the self-service endpoints behind the portal are gated on it.
  { key: 'personnel.self', module: 'personnel', label: 'My own record', personal: true,
    desc: 'A member of staff maintaining their own profile, documents and training history in My Portal.' },
  { key: 'personnel.register', module: 'personnel', label: 'Personnel register', sensitive: true,
    desc: 'The master register of all staff — opening, adding and editing other people\'s records, and the job descriptions issued for each post.',
    tabs: ['Master Personnel Register', 'Add Staff', 'Staff Documents', 'Job Descriptions'] },
  { key: 'personnel.orientation', module: 'personnel', label: 'Orientation & induction',
    desc: 'Induction checklists and sign-off for new staff.',
    tabs: ['Orientation & Induction'] },
  { key: 'personnel.declarations', module: 'personnel', label: 'Declarations', sensitive: true, personal: true,
    desc: 'Confidentiality, impartiality and conflict-of-interest declarations.',
    tabs: ['Declarations'] },
  { key: 'personnel.training', module: 'personnel', label: 'Training & competency', personal: true,
    desc: 'Training events, attendance and competency assessments.',
    tabs: ['Training Events', 'Competency Assessments'] },
  { key: 'personnel.appraisals', module: 'personnel', label: 'Performance appraisals', sensitive: true, personal: true,
    desc: 'Performance appraisal records. Confidential between a member of staff and their manager.',
    tabs: ['Performance Appraisals'] },
  { key: 'personnel.authorizations', module: 'personnel', label: 'Technical authorizations', sensitive: true,
    desc: 'Who is authorised to perform, review, verify or approve technical work.',
    tabs: ['Technical Authorizations'] },
  { key: 'personnel.rosters', module: 'personnel', label: 'Rosters & scheduling',
    desc: 'Duty rosters, unit reassignments and bench schedules.',
    tabs: ['Duty Roster', 'Unit Reassignments', 'Bench Schedules'] },
  { key: 'personnel.activities', module: 'personnel', label: 'Unit activities & reminders',
    desc: 'The recurring unit work — environmental charting, equipment checks, controls, cleaning — and the reminders raised for whoever is on duty.',
    tabs: ['Unit Activities'] },
  { key: 'personnel.reports', module: 'personnel', label: 'Personnel reports',
    desc: 'Personnel registers and summaries for management.', tabs: ['Reports'] },

  // ── Documents & Records ─────────────────────────────────────────────────
  { key: 'documents.library', module: 'documents', label: 'Document library',
    desc: 'Reading, searching and printing controlled documents, and signing attestations.',
    tabs: ['Documents'] },
  { key: 'documents.authoring', module: 'documents', label: 'Authoring',
    desc: 'Drafting new documents and new versions of existing ones.' },
  { key: 'documents.workflow', module: 'documents', label: 'Review & approval', sensitive: true,
    desc: 'Submitting for review, approving and issuing, distributing for attestation, marking obsolete.' },
  { key: 'documents.records', module: 'documents', label: 'Records register',
    desc: 'The register of controlled quality records.', tabs: ['Records'] },
  { key: 'documents.archive', module: 'documents', label: 'Central archive',
    desc: 'Archived records from every module.', tabs: ['Central Archive'] },
  { key: 'documents.masterlist', module: 'documents', label: 'Master list',
    desc: 'The controlled Document & Records Master List.', tabs: ['Master List'] },
  { key: 'documents.profile', module: 'documents', label: 'Laboratory profile', sensitive: true,
    desc: 'Laboratory identity, quality manual, policy and objectives.', tabs: ['Laboratory Profile'] },

  // ── Equipment ───────────────────────────────────────────────────────────
  { key: 'equipment.register', module: 'equipment', label: 'Asset register', sensitive: true,
    desc: 'The equipment register — adding assets and editing their identity.',
    tabs: ['Equipment Register', 'Equipment Profile', 'New Equipment'] },
  { key: 'equipment.maintenance', module: 'equipment', label: 'Maintenance & calibration',
    desc: 'Calibration, planned maintenance, breakdowns and their scanned records, the maintenance task lists behind them, and the monthly maintenance charts.',
    tabs: ['Calibration', 'Maintenance Records', 'Maintenance Charts', 'Scanned Records', 'Breakdowns'] },
  { key: 'equipment.verification', module: 'equipment', label: 'Verification & validation', sensitive: true,
    desc: 'Equipment verification and validation studies.', tabs: ['Verification & Validation'] },
  { key: 'equipment.adverse', module: 'equipment', label: 'Adverse events',
    desc: 'Equipment-related adverse events.', tabs: ['Adverse Events'] },
  { key: 'equipment.training', module: 'equipment', label: 'Equipment training', personal: true,
    desc: 'Who is trained and competent on each instrument.', tabs: ['Training & Competency'] },
  { key: 'equipment.files', module: 'equipment', label: 'Equipment files',
    desc: 'Manuals, certificates and service documentation.', tabs: ['Equipment Files'] },
  { key: 'equipment.reports', module: 'equipment', label: 'Equipment reports',
    desc: 'Equipment registers and summaries.', tabs: ['Reports placeholder'] },

  // ── Supplier & Inventory ────────────────────────────────────────────────
  { key: 'supplier_inventory.stock', module: 'supplier_inventory', label: 'Stock & batches',
    desc: 'The item catalogue, and running the store — receiving, issuing, counting and the stock ledger.',
    tabs: ['Item Register', 'New Item', 'Stock Ledger', 'Receiving', 'Issuing', 'Stock Management'] },
  { key: 'supplier_inventory.planning', module: 'supplier_inventory', label: 'Forecasting & levels',
    desc: 'Demand forecasting, reorder levels, minimum and maximum stock.', tabs: ['Forecasting'] },
  { key: 'supplier_inventory.suppliers', module: 'supplier_inventory', label: 'Suppliers', sensitive: true,
    desc: 'The approved supplier register and supplier evaluation.', tabs: ['Suppliers'] },
  { key: 'supplier_inventory.storage', module: 'supplier_inventory', label: 'Storage inspections',
    desc: 'Storage condition inspections.', tabs: ['Storage Inspections'] },
  { key: 'supplier_inventory.labels', module: 'supplier_inventory', label: 'Barcode labels',
    desc: 'Printing barcode labels for stock.', tabs: ['Barcode Labels'] },
  // Reporting is read on the module dashboard rather than on a tab of its own,
  // so the feature governs the section there instead of a tab name.
  { key: 'supplier_inventory.reports', module: 'supplier_inventory', label: 'Inventory reports',
    desc: 'Consumption trends, stock status, expiry risk, wastage and supplier performance, shown on the module dashboard.' },

  // ── Process Management ──────────────────────────────────────────────────
  { key: 'process_management.receipt', module: 'process_management', label: 'Sample receipt',
    desc: 'Specimen receipt and the pre-examination workspace.',
    tabs: ['Pre-Examination', 'Sample Receipt'] },
  { key: 'process_management.directory', module: 'process_management', label: 'Test directory', sensitive: true,
    desc: 'The test menu and specimen acceptance criteria — laboratory-defining configuration.',
    tabs: ['Test Directory', 'Acceptance Criteria'] },
  { key: 'process_management.rejections', module: 'process_management', label: 'Specimen rejections',
    desc: 'Recording and reviewing rejected specimens.', tabs: ['Specimen Rejections'] },
  { key: 'process_management.intervals', module: 'process_management', label: 'Reference intervals', sensitive: true,
    desc: 'Reference intervals and method comparability — clinical configuration.',
    tabs: ['Reference Intervals', 'Comparability'] },
  { key: 'process_management.critical', module: 'process_management', label: 'Critical results', sensitive: true,
    desc: 'Critical result rules and the record of critical notifications.',
    tabs: ['Critical Result Rules', 'Critical Notifications'] },
  { key: 'process_management.referrals', module: 'process_management', label: 'Referrals',
    desc: 'Referral laboratories, referred tests and send-outs.',
    tabs: ['Referral Labs', 'Referral Tests', 'Referral Sendouts'] },
  { key: 'process_management.amendments', module: 'process_management', label: 'Report amendments', sensitive: true,
    desc: 'Amendments to issued reports.', tabs: ['Report Amendments'] },
  { key: 'process_management.reviews', module: 'process_management', label: 'Process reviews',
    desc: 'Process reviews and the contingency plan.', tabs: ['Process Reviews', 'Contingency Plan'] },

  // ── Customer Focus ──────────────────────────────────────────────────────
  { key: 'customer_focus.advisory', module: 'customer_focus', label: 'Advisory services',
    desc: 'Clinical advisory services and the laboratory handbook.',
    tabs: ['Advisory Services', 'Laboratory Handbook'] },
  { key: 'customer_focus.stakeholders', module: 'customer_focus', label: 'Stakeholders & agreements', sensitive: true,
    desc: 'Stakeholder register and service level agreements.',
    tabs: ['Stakeholders', 'New Stakeholder', 'Service Agreements'] },
  { key: 'customer_focus.feedback', module: 'customer_focus', label: 'Feedback intake',
    desc: 'Receiving and triaging customer feedback.', tabs: ['Feedback Intake'] },
  { key: 'customer_focus.surveys', module: 'customer_focus', label: 'Satisfaction surveys',
    desc: 'Survey design and the responses received.',
    tabs: ['Satisfaction Surveys', 'Survey Responses'] },
  { key: 'customer_focus.communication', module: 'customer_focus', label: 'Communication log',
    desc: 'The log of communications with users of the laboratory.', tabs: ['Communication Log'] },
  { key: 'customer_focus.imports', module: 'customer_focus', label: 'Customer imports',
    desc: 'Bulk import of stakeholders and feedback.', tabs: ['Imports'] },
  { key: 'customer_focus.reports', module: 'customer_focus', label: 'Customer reports',
    desc: 'Customer focus registers and summaries.', tabs: ['Reports'] },

  // ── Organisation & Leadership ───────────────────────────────────────────
  { key: 'organisation.structure', module: 'organisation', label: 'Organogram & conduct',
    desc: 'The organisational structure, deputisation and the code of conduct.',
    tabs: ['Organogram & Deputisation', 'Code of Conduct'] },
  { key: 'organisation.quality_config', module: 'organisation', label: 'Quality configuration', sensitive: true,
    desc: 'Quality policy, objectives and configuration of the management system.',
    tabs: ['Quality Configuration'] },
  { key: 'organisation.budget', module: 'organisation', label: 'Budgetary projection', sensitive: true,
    desc: 'Budget projections and financial planning for the laboratory.',
    tabs: ['Budgetary Projection'] },
  { key: 'organisation.records_review', module: 'organisation', label: 'Records review', sensitive: true,
    desc: 'Leadership review of quality and technical records.',
    tabs: ['Quality & Technical Records Review'] },
  { key: 'organisation.licences', module: 'organisation', label: 'Registrations & licences', sensitive: true,
    desc: 'Facility registrations, accreditations and operating licences.',
    tabs: ['Registrations & Licences'] },

  // ── Information Management ──────────────────────────────────────────────
  { key: 'information_management.assets', module: 'information_management', label: 'Assets & systems',
    desc: 'The register of information assets and systems.',
    tabs: ['Information Assets', 'Information Systems'] },
  { key: 'information_management.access', module: 'information_management', label: 'Access reviews', sensitive: true,
    desc: 'Periodic review of who has access to which system.', tabs: ['Access Reviews'] },
  { key: 'information_management.security', module: 'information_management', label: 'Security incidents', sensitive: true,
    desc: 'Information security incidents and breaches.', tabs: ['Security Incidents'] },
  { key: 'information_management.data', module: 'information_management', label: 'Data corrections', sensitive: true,
    desc: 'Corrections applied to stored data.', tabs: ['Data Corrections'] },
  { key: 'information_management.change', module: 'information_management', label: 'Change control', sensitive: true,
    desc: 'Change requests, software releases and system validations.',
    tabs: ['Change Requests', 'Software Releases', 'System Validations'] },
  { key: 'information_management.downtime', module: 'information_management', label: 'Downtime records',
    desc: 'System downtime and contingency operation.', tabs: ['Downtime Records'] },
  { key: 'information_management.reviews', module: 'information_management', label: 'Information reviews',
    desc: 'Periodic information management reviews.', tabs: ['Information Reviews'] },
  { key: 'information_management.reports', module: 'information_management', label: 'Information reports',
    desc: 'Information management registers and summaries.', tabs: ['Reports'] },

  // ── Facilities & Safety ─────────────────────────────────────────────────
  { key: 'facilities_safety.incidents', module: 'facilities_safety', label: 'Safety incidents',
    desc: 'Reporting and following up safety incidents. Every member of staff needs this.',
    tabs: ['Safety Incidents', 'New Incident'] },
  { key: 'facilities_safety.equipment', module: 'facilities_safety', label: 'Safety equipment',
    desc: 'Safety equipment register and checks.', tabs: ['Safety Equipment'] },
  { key: 'facilities_safety.inspections', module: 'facilities_safety', label: 'Inspections & drills',
    desc: 'Facility inspections and emergency drills.', tabs: ['Inspections & Drills'] },
  { key: 'facilities_safety.waste', module: 'facilities_safety', label: 'Waste & chemicals',
    desc: 'Waste disposal and hazardous chemical inventory.',
    tabs: ['Waste Disposal', 'Hazardous Chemicals'] },
  { key: 'facilities_safety.health', module: 'facilities_safety', label: 'Immunisation & exposure', sensitive: true, personal: true,
    desc: 'Occupational health: immunisation status and exposure incidents. Confidential staff health data.',
    tabs: ['Immunisation & Exposure'] },
  { key: 'facilities_safety.environment', module: 'facilities_safety', label: 'Environmental monitoring',
    desc: 'Environmental monitoring from the safety workspace, including the monthly charts and their verification.',
    tabs: ['Environmental Monitoring'] },
  // Decontamination is everybody's work, so the right that matters here is the
  // one that governs the PROGRAMME — adding a decontamination, changing what
  // every unit carries, excusing a unit from one. Filling in the log is routine
  // work at the general tier, which the whole laboratory holds.
  { key: 'facilities_safety.decontamination', module: 'facilities_safety', label: 'Decontamination programme',
    desc: 'The bench and environment decontamination programme: what is decontaminated, how often, and the monthly logs and their verification. Performing a decontamination needs only general routine work.',
    tabs: ['Decontamination'] },

  // ── Environmental Monitoring (its own module) ───────────────────────────
  { key: 'monitoring.readings', module: 'monitoring', label: 'Readings & excursions',
    desc: 'Recording readings and handling excursions. Bench staff need this daily.',
    tabs: ['Live Dashboard', 'Manual Entry', 'Enter Reading', 'Excursions', 'Alerts', 'Monitoring Items'] },
  { key: 'monitoring.assets', module: 'monitoring', label: 'Monitored assets & devices', sensitive: true,
    desc: 'The monitored asset register and the logger devices behind it.',
    tabs: ['Assets', 'Devices', 'New Monitoring Item'] },
  { key: 'monitoring.settings', module: 'monitoring', label: 'Monitoring settings', sensitive: true,
    desc: 'Thresholds, polling and notification configuration.', tabs: ['Settings', 'Notifications'] },
  { key: 'monitoring.reports', module: 'monitoring', label: 'Monitoring reports',
    desc: 'Charts, insights and monitoring reports.',
    tabs: ['Insights', 'Charts', 'Scanned Charts', 'Reports', 'Monthly Charts placeholder'] },

  // ── Continual Improvement ───────────────────────────────────────────────
  { key: 'continual_improvement.projects', module: 'continual_improvement', label: 'Improvement projects',
    desc: 'Improvement projects and their progress updates.',
    tabs: ['Improvement Projects', 'New Project', 'Updates'] },
  { key: 'continual_improvement.reports', module: 'continual_improvement', label: 'Improvement reports',
    desc: 'Improvement registers and summaries.', tabs: ['Reports'] },

  // ── Notifications & Reports ─────────────────────────────────────────────
  // The inbox itself now lives in My Portal — a person's alerts belong beside
  // the work they are about, not in a workspace of their own. This key still
  // governs every inbox and task endpoint the portal calls, so it stays, and
  // the whole laboratory holds it.
  { key: 'notifications.inbox', module: 'notifications', label: 'My inbox & tasks', personal: true,
    desc: 'A member of staff\'s own alerts and assigned tasks, read and worked in My Portal. Everyone needs this.' },
  { key: 'notifications.calendar', module: 'notifications', label: 'Review calendar',
    desc: 'The laboratory-wide alert picture and the scheduled review and due-date calendar.',
    tabs: ['Alert Overview', 'Review Calendar'] },
  { key: 'notifications.rules', module: 'notifications', label: 'Alert rules', sensitive: true,
    desc: 'Configuring which alerts are raised, to whom, and running a scan.',
    tabs: ['Notification Rules', 'Generate Alerts'] },
  { key: 'notifications.sounds', module: 'notifications', label: 'Reminder sounds', personal: true,
    desc: 'The chimes played on the desktop and mobile apps, and each person\'s own choice of them, set in My Portal.' },

  // ── Routine Work ────────────────────────────────────────────────────────
  // Three tiers of competence, granted per profile. They decide who may PERFORM
  // a piece of recurring bench work, not who may see it: every member of staff
  // reads their unit's whole programme, and each activity says which tier it
  // needs. An activity's tier is set on the activity itself (Settings → Unit
  // Activities), so a laboratory that treats an analyser service as ordinary
  // bench work, or its fridge charts as supervised, configures that rather than
  // arguing with the software.
  { key: 'routine_work.general', module: 'routine_work', label: 'Perform general routine work', personal: true,
    desc: 'Environmental charting, decontamination, cleaning, stock and safety checks — the routine work of the bench. Everyone on duty needs this.' },
  { key: 'routine_work.technical', module: 'routine_work', label: 'Perform technical routine work',
    desc: 'IQC, calibration checks and method-related maintenance — work that needs a registered scientist.' },
  { key: 'routine_work.supervisory', module: 'routine_work', label: 'Perform supervisory routine work', sensitive: true,
    desc: 'Reviews, sign-offs and scheduled servicing the unit supervisor owns.' },
  { key: 'routine_work.oversight', module: 'routine_work', label: 'Oversee the unit programme',
    desc: 'See what the whole unit was due to do and what was actually done, not only your own list.' },

  // ── System Audit ────────────────────────────────────────────────────────
  // Split three ways because they are three different jobs: reading the trail,
  // working the flags, and running the checks that produce them.
  { key: 'system_audit.trail', module: 'system_audit', label: 'Live audit trail', sensitive: true,
    desc: 'The real-time record of every action taken in the system, by whom and from where.',
    tabs: ['Live Trail'] },
  { key: 'system_audit.flags', module: 'system_audit', label: 'Flags & omissions', sensitive: true,
    desc: 'Everything that was due and not done, and every inconsistency found. Each flag opens the record behind it.',
    tabs: ['Overview', 'Flags', 'Not Done', 'Schedules'] },
  { key: 'system_audit.checks', module: 'system_audit', label: 'Audit checks & scans', sensitive: true,
    desc: 'Running the audit scan and reviewing what each check covers.',
    tabs: ['Checks'] },

  // ── Records, Reports & Evidence ─────────────────────────────────────────
  { key: 'records_reports.generate', module: 'records_reports', label: 'Reports',
    desc: 'Report templates, generating reports and the requests raised.',
    tabs: ['Report Templates', 'Generate Report', 'Report Requests'] },
  { key: 'records_reports.print', module: 'records_reports', label: 'Controlled printing',
    desc: 'Controlled copy print jobs.', tabs: ['Print Jobs'] },
  { key: 'records_reports.evidence', module: 'records_reports', label: 'Evidence packs',
    desc: 'Assembling evidence packs for assessment.', tabs: ['Evidence Packs'] },
  { key: 'records_reports.audit', module: 'records_reports', label: 'Audit trail', sensitive: true,
    desc: 'The system audit trail and its periodic review.',
    tabs: ['Audit Trail', 'Audit Trail Reviews'] },
  { key: 'records_reports.retention', module: 'records_reports', label: 'Retention & integrity', sensitive: true,
    desc: 'Retention rules, backup/restore checks and data integrity checks.',
    tabs: ['Retention Rules', 'Backup/Restore Checks', 'Data Integrity Checks'] },
];

/* ============================================================================
   Lookups
   ========================================================================= */
const BY_KEY = new Map(FEATURES.map(f => [f.key, f]));
const BY_MODULE = FEATURES.reduce<Record<string, FeatureDef[]>>((acc, f) => {
  (acc[f.module] ??= []).push(f);
  return acc;
}, {});

export function featuresOfModule(moduleKey: string): FeatureDef[] {
  return BY_MODULE[moduleKey] ?? [];
}

export function getFeature(key: string): FeatureDef | undefined {
  return BY_KEY.get(key);
}

/** True when a key names a feature rather than a whole module. */
export function isFeatureKey(key: string): boolean {
  return BY_KEY.has(key);
}

/** Modules that have been broken into features. */
export function modulesWithFeatures(): string[] {
  return Object.keys(BY_MODULE);
}

/**
 * Every key permissions may be granted on: each module (kept so modules
 * without features still work) plus every feature.
 */
export function allPermissionKeys(moduleKeys: string[]): string[] {
  return [...moduleKeys, ...FEATURES.map(f => f.key)];
}

/**
 * Tabs that embed a whole other module rather than a feature of their host.
 * Organisation's "Meetings" tab is the Meetings module; gating it on its own
 * feature would mean maintaining two keys that must never disagree.
 */
export const TAB_MODULE_OVERRIDES: Record<string, string> = {
  Meetings: 'meetings',
  'Management Review': 'management_review',
  IQC: 'iqc',
  EQA: 'eqa',
  'Method Verification': 'verification_validation',
  'Measurement Uncertainty': 'measurement_uncertainty',
  POCT: 'poct',
  'Blood banking': 'blood_bank_handover',
  Complaints: 'complaints',
};

/**
 * The permission key governing a workspace tab — a feature key, a module key
 * for tabs that embed another module, or null when the tab is always shown
 * (a module's own landing dashboard, for instance).
 */
export function permKeyForTab(moduleKey: string, tab: string): string | null {
  if (TAB_MODULE_OVERRIDES[tab]) return TAB_MODULE_OVERRIDES[tab];
  const feature = featuresOfModule(moduleKey).find(f => f.tabs?.includes(tab));
  return feature ? feature.key : null;
}

/**
 * Tabs that are nothing but a blank form for adding a record. Showing one to
 * somebody who may read a register but not add to it is the exact complaint
 * this work set out to fix — they fill the form in and the save is refused —
 * so these ask for `create` rather than `view`.
 */
const CREATE_TAB_NAMES = new Set([
  'Add Staff', 'Log Event', 'Report Incident', 'Manual Entry', 'Enter Reading',
  'Result Entry', 'Results Entry', 'Generate Report', 'Generate Alerts',
  'Feedback Intake', 'Sample Receipt',
  // Registers whose "add" tab is phrased as a verb rather than "New …".
  'Log a complaint', 'Log Complaint', 'Raise a risk', 'Log a nonconformity',
  'Register Equipment', 'Add Item', 'Add Element', 'Upload', 'New Import',
]);

/** The action a tab requires: `create` for the "new record" tabs, else `view`. */
export function actionForTab(tab: string): 'view' | 'create' {
  return tab.startsWith('New ') || CREATE_TAB_NAMES.has(tab) ? 'create' : 'view';
}
