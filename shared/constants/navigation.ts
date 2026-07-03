/**
 * NAV_SECTIONS — the single source of truth for the application's information
 * architecture. The Home launchpad renders one card per section, and the
 * sidebar renders one nav entry per section (expanding to its child modules
 * when a section contains more than one). Keeping both surfaces on this one
 * structure guarantees the left pane always mirrors the homepage features.
 *
 * The architecture follows the twelve quality essentials of a laboratory
 * quality management system, book-ended by the software's own features
 * (dashboard, notifications & reports, settings).
 *
 * `modules` lists the module keys (from ./modules) that belong to a section,
 * in display order. The first *enabled* module is the section's landing page.
 */
export type NavSection = {
  key: string;
  title: string;
  desc: string;
  /** 'overview' and 'system' are software features; 'essential' is one of the 12 quality essentials. */
  group: 'overview' | 'essential' | 'system';
  modules: string[];
};

export const NAV_SECTIONS: NavSection[] = [
  {
    key: 'dashboard',
    title: 'Main Dashboard',
    desc: 'Organisation-wide quality overview',
    group: 'overview',
    modules: ['dashboard'],
  },

  /* ---- The twelve quality essentials ---- */
  {
    key: 'documents_records',
    title: 'Documents and Records',
    desc: 'Controlled documents, records and master lists',
    group: 'essential',
    modules: ['documents', 'dennis'],
  },
  {
    key: 'organisation',
    title: 'Organisation and Leadership',
    desc: 'Leadership, structure, meetings and management review',
    group: 'essential',
    modules: ['organisation', 'meetings', 'management_review'],
  },
  {
    key: 'personnel',
    title: 'Personnel Management',
    desc: 'Staff records, competency, training and rosters',
    group: 'essential',
    modules: ['personnel'],
  },
  {
    key: 'customer_focus',
    title: 'Customer Focus',
    desc: 'Complaints, feedback and stakeholder care',
    group: 'essential',
    modules: ['customer_focus', 'complaints'],
  },
  {
    key: 'equipment',
    title: 'Equipment Management',
    desc: 'Asset register, maintenance, calibration and breakdowns',
    group: 'essential',
    modules: ['equipment'],
  },
  {
    key: 'assessments',
    title: 'Assessments',
    desc: 'Internal audits, assessments and checklists',
    group: 'essential',
    modules: ['assessments'],
  },
  {
    key: 'supplier_inventory',
    title: 'Supplier and Inventory Management',
    desc: 'Suppliers, reagents, stock and expiry control',
    group: 'essential',
    modules: ['supplier_inventory'],
  },
  {
    key: 'process_management',
    title: 'Process Management',
    desc: 'Testing workflows, IQC, EQA, verification, POCT and blood bank',
    group: 'essential',
    modules: [
      'process_management',
      'iqc',
      'eqa',
      'verification_validation',
      'measurement_uncertainty',
      'poct',
      'blood_bank_handover',
    ],
  },
  {
    key: 'information_management',
    title: 'Information Management',
    desc: 'Systems, data protection, access and downtime',
    group: 'essential',
    modules: ['information_management'],
  },
  {
    key: 'nonconforming_events',
    title: 'Nonconforming Event Management',
    desc: 'Nonconformities, CAPA and action follow-up',
    group: 'essential',
    modules: ['nc_capa', 'actions'],
  },
  {
    key: 'continual_improvement',
    title: 'Continual Improvement',
    desc: 'Improvement projects, quality indicators and risk',
    group: 'essential',
    modules: ['continual_improvement', 'quality_indicators', 'risks'],
  },
  {
    key: 'facilities_safety',
    title: 'Facilities and Safety',
    desc: 'Environment, monitoring and safety incidents',
    group: 'essential',
    modules: ['facilities_safety', 'monitoring'],
  },

  /* ---- Software features ---- */
  {
    key: 'notifications_reports',
    title: 'Notifications & Reports',
    desc: 'Alerts, review calendar, reports and evidence',
    group: 'system',
    modules: ['notifications', 'records_reports', 'monthly_reports'],
  },
  {
    key: 'settings',
    title: 'Settings',
    desc: 'Users, permissions and configuration',
    group: 'system',
    modules: ['settings'],
  },
];

/** Display labels for the three navigation bands. */
export const NAV_GROUP_LABELS: Record<NavSection['group'], string> = {
  overview: 'Overview',
  essential: 'Quality essentials',
  system: 'System',
};
