export type ModuleDefinition = {
  key: string;
  label: string;
  path: string;
  protected?: boolean;
  placeholder?: boolean;
};

export const MODULES: ModuleDefinition[] = [
  { key: 'home', label: 'Home', path: '/home', protected: true },
  { key: 'dashboard', label: 'Main Dashboard', path: '/dashboard', protected: true },
  { key: 'documents', label: 'Documents & Records', path: '/documents', protected: true },
  { key: 'organisation', label: 'Organisation & Leadership', path: '/organisation', protected: true },
  { key: 'personnel', label: 'Personnel Management', path: '/personnel', protected: true },
  { key: 'actions', label: 'Action Tracker', path: '/actions', protected: true },
  { key: 'nc_capa', label: 'Nonconforming Events & CAPA', path: '/nc-capa' },
  { key: 'complaints', label: 'Complaints Register', path: '/complaints' },
  { key: 'risks', label: 'Risk Register', path: '/risks' },
  { key: 'customer_focus', label: 'Customer Focus', path: '/customer-focus' },
  { key: 'equipment', label: 'Equipment Management', path: '/equipment' },
  { key: 'assessments', label: 'Internal Assessments', path: '/assessments' },
  { key: 'supplier_inventory', label: 'Supplier & Inventory', path: '/supplier-inventory' },
  { key: 'process_management', label: 'Process Management', path: '/process-management', placeholder: true },
  { key: 'information_management', label: 'Information Management', path: '/information-management', placeholder: true },
  { key: 'continual_improvement', label: 'Continual Improvement', path: '/continual-improvement' },
  { key: 'meetings', label: 'Meetings & Minutes', path: '/meetings' },
  { key: 'management_review', label: 'Management Review', path: '/management-review' },
  { key: 'quality_indicators', label: 'Quality Indicators', path: '/quality-indicators' },
  { key: 'facilities_safety', label: 'Facilities & Safety', path: '/facilities-safety' },
  { key: 'monitoring', label: 'Environmental Monitoring', path: '/monitoring' },
  { key: 'iqc', label: 'IQC Management', path: '/iqc' },
  { key: 'eqa', label: 'EQA Management', path: '/eqa' },
  { key: 'verification_validation', label: 'Method & Equipment Verification', path: '/verification-validation' },
  { key: 'measurement_uncertainty', label: 'Measurement Uncertainty', path: '/measurement-uncertainty' },
  { key: 'poct', label: 'POCT Oversight', path: '/poct' },
  { key: 'blood_bank_handover', label: 'Blood Bank Handover', path: '/blood-bank-handover' },
  { key: 'monthly_reports', label: 'Monthly Reports & LHIMS Archive', path: '/monthly-reports' },
  { key: 'reports_exports', label: 'Reports & Exports', path: '/reports-exports', placeholder: true },
  { key: 'notifications', label: 'Notifications & Review Calendar', path: '/notifications' },
  { key: 'settings', label: 'Settings', path: '/settings', protected: true }
];

export const PERMISSION_ACTIONS = ['view', 'create', 'edit', 'void_archive', 'export', 'print', 'approve'] as const;
export const PERMISSION_SOURCES = ['Role default', 'Position default', 'Section scope', 'Technical authorization', 'Manual override', 'Denied override'] as const;
export const TECHNICAL_AUTHORIZATION_LEVELS = ['View only', 'Perform', 'Review', 'Verify', 'Approve', 'Supervise', 'Train others'] as const;

export const DEFAULT_POSITIONS = [
  'Laboratory Manager', 'Quality Manager', 'Quality Team Member', 'Secretary', 'Safety Manager',
  'Blood Bank Unit Head', 'Microbiology Unit Head', 'Biochemistry Unit Head', 'Haematology Unit Head',
  'Stores Officer', 'Customer Service Officer', 'POCT Officer', 'Biomedical Scientist', 'Technician',
  'System Administrator', 'Data Officer'
];
