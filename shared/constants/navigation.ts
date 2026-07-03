/**
 * NAV_SECTIONS — the single source of truth for the application's information
 * architecture. The Home launchpad renders one card per section, and the
 * sidebar renders one nav entry per section (expanding to its child modules
 * when a section contains more than one). Keeping both surfaces on this one
 * structure guarantees the left pane always mirrors the homepage features.
 *
 * `modules` lists the module keys (from ./modules) that belong to a section,
 * in display order. The first *enabled* module is the section's landing page.
 */
export type NavSection = {
  key: string;
  title: string;
  desc: string;
  modules: string[];
};

export const NAV_SECTIONS: NavSection[] = [
  {
    key: 'dashboard',
    title: 'Main Dashboard',
    desc: 'View organization-wide quality overview',
    modules: ['dashboard'],
  },
  {
    key: 'documents',
    title: 'Documents & SOPs',
    desc: 'Manage controlled documents and forms',
    modules: ['documents', 'dennis'],
  },
  {
    key: 'personnel',
    title: 'Personnel',
    desc: 'Staff records, competency, rosters, training',
    modules: ['personnel', 'organisation'],
  },
  {
    key: 'equipment',
    title: 'Equipment & Monitoring',
    desc: 'Equipment, maintenance, calibration, environment',
    modules: ['equipment', 'monitoring'],
  },
  {
    key: 'inventory',
    title: 'Inventory',
    desc: 'Reagents, supplies, stock and vendors',
    modules: ['supplier_inventory'],
  },
  {
    key: 'process_control',
    title: 'Process Control | IQC-EQA',
    desc: 'Internal QC, EQA, process monitoring',
    modules: [
      'iqc',
      'eqa',
      'verification_validation',
      'measurement_uncertainty',
      'process_management',
      'poct',
      'blood_bank_handover',
    ],
  },
  {
    key: 'nc_capa',
    title: 'Nonconformities & CAPA',
    desc: 'Incidents, investigations, corrective actions',
    modules: ['nc_capa', 'actions'],
  },
  {
    key: 'assessments',
    title: 'Assessments & Audits',
    desc: 'Internal audits, assessments, checklists',
    modules: ['assessments'],
  },
  {
    key: 'risks',
    title: 'Risk Management',
    desc: 'Risk register, mitigations, review',
    modules: ['risks'],
  },
  {
    key: 'customer',
    title: 'Complaints & Customer Service',
    desc: 'Complaints, feedback, resolution',
    modules: ['complaints', 'customer_focus'],
  },
  {
    key: 'safety',
    title: 'Facilities & Safety',
    desc: 'Safety incidents, inspections, facility checks',
    modules: ['facilities_safety'],
  },
  {
    key: 'improvement',
    title: 'Continual Improvement',
    desc: 'Improvement projects, indicators, reviews, meetings',
    modules: ['continual_improvement', 'quality_indicators', 'management_review', 'meetings'],
  },
  {
    key: 'reports',
    title: 'Reports',
    desc: 'Dashboards, summaries, exports',
    modules: ['records_reports', 'monthly_reports', 'information_management'],
  },
  {
    key: 'notifications',
    title: 'Notifications',
    desc: 'Alerts, reminders, announcements',
    modules: ['notifications'],
  },
  {
    key: 'settings',
    title: 'Settings',
    desc: 'Users, permissions, configuration',
    modules: ['settings'],
  },
];
