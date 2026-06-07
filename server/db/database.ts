import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export const dataRoot = process.env.SECH_LIMS_DATA_DIR ?? path.join(process.cwd(), 'local-data');
export const uploadRoot = path.join(dataRoot, 'uploads');
export const evidenceRoot = path.join(dataRoot, 'evidence');
export const backupRoot = path.join(dataRoot, 'backups');
export const configRoot = path.join(dataRoot, 'config');
export const dbPath = path.join(dataRoot, 'sech_lims.sqlite');

let db: Database.Database | undefined;

export function ensureDataDirs() {
  for (const dir of [dataRoot, uploadRoot, evidenceRoot, backupRoot, configRoot]) fs.mkdirSync(dir, { recursive: true });
}

export function getDb() {
  if (!db) {
    ensureDataDirs();
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    migrate(db);
  }
  return db;
}

function migrate(database: Database.Database) {
  database.exec(`
CREATE TABLE IF NOT EXISTS roles (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, description TEXT, is_system INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, full_name TEXT NOT NULL, role_id INTEGER NOT NULL REFERENCES roles(id), staff_id INTEGER REFERENCES staff(id), is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT);
CREATE TABLE IF NOT EXISTS auth_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id), token TEXT NOT NULL UNIQUE, device_id TEXT, ip_address TEXT, expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, revoked_at TEXT);
CREATE TABLE IF NOT EXISTS permissions (id INTEGER PRIMARY KEY AUTOINCREMENT, module_key TEXT NOT NULL, action TEXT NOT NULL, label TEXT NOT NULL, UNIQUE(module_key, action));
CREATE TABLE IF NOT EXISTS role_permissions (id INTEGER PRIMARY KEY AUTOINCREMENT, role_id INTEGER NOT NULL REFERENCES roles(id), permission_id INTEGER NOT NULL REFERENCES permissions(id), allowed INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT 'Role default', UNIQUE(role_id, permission_id));
CREATE TABLE IF NOT EXISTS position_permissions (id INTEGER PRIMARY KEY AUTOINCREMENT, position_id INTEGER NOT NULL REFERENCES positions(id), permission_id INTEGER NOT NULL REFERENCES permissions(id), allowed INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT 'Position default', UNIQUE(position_id, permission_id));
CREATE TABLE IF NOT EXISTS user_permission_overrides (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id), permission_id INTEGER NOT NULL REFERENCES permissions(id), allowed INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT 'Manual override', reason TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(user_id, permission_id));
CREATE TABLE IF NOT EXISTS devices (id INTEGER PRIMARY KEY AUTOINCREMENT, device_code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'desktop', status TEXT NOT NULL DEFAULT 'pending', paired_user_id INTEGER REFERENCES users(id), last_seen_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS laboratory_profile (id INTEGER PRIMARY KEY CHECK (id = 1), facility_name TEXT NOT NULL, short_name TEXT, host_mode INTEGER NOT NULL DEFAULT 1, host_api_port INTEGER NOT NULL DEFAULT 4317, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT);
CREATE TABLE IF NOT EXISTS departments (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, is_active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS sections (id INTEGER PRIMARY KEY AUTOINCREMENT, department_id INTEGER REFERENCES departments(id), name TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1, UNIQUE(department_id, name));
CREATE TABLE IF NOT EXISTS locations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, description TEXT, is_active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS positions (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL UNIQUE, description TEXT, reports_to_position_id INTEGER REFERENCES positions(id), default_section_id INTEGER REFERENCES sections(id), is_active INTEGER NOT NULL DEFAULT 1, archived_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT);
CREATE TABLE IF NOT EXISTS staff (id INTEGER PRIMARY KEY AUTOINCREMENT, employee_no TEXT UNIQUE, full_name TEXT NOT NULL, email TEXT, phone TEXT, section_id INTEGER REFERENCES sections(id), is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT);
CREATE TABLE IF NOT EXISTS staff_position_assignments (id INTEGER PRIMARY KEY AUTOINCREMENT, staff_id INTEGER NOT NULL REFERENCES staff(id), position_id INTEGER NOT NULL REFERENCES positions(id), assignment_type TEXT NOT NULL DEFAULT 'primary', starts_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, ends_at TEXT, is_active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS technical_authorizations (id INTEGER PRIMARY KEY AUTOINCREMENT, staff_id INTEGER REFERENCES staff(id), position_id INTEGER REFERENCES positions(id), module_key TEXT NOT NULL, section_id INTEGER REFERENCES sections(id), level TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1, granted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, expires_at TEXT);
CREATE TABLE IF NOT EXISTS approval_routes (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, module_key TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS approval_route_steps (id INTEGER PRIMARY KEY AUTOINCREMENT, route_id INTEGER NOT NULL REFERENCES approval_routes(id), step_order INTEGER NOT NULL, position_id INTEGER REFERENCES positions(id), role_id INTEGER REFERENCES roles(id), action TEXT NOT NULL DEFAULT 'approve');
CREATE TABLE IF NOT EXISTS system_modules (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, label TEXT NOT NULL, path TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, alerts_paused INTEGER NOT NULL DEFAULT 0, updated_at TEXT);
CREATE TABLE IF NOT EXISTS files (id INTEGER PRIMARY KEY AUTOINCREMENT, original_name TEXT NOT NULL, stored_name TEXT NOT NULL UNIQUE, mime_type TEXT, size_bytes INTEGER NOT NULL, storage_area TEXT NOT NULL DEFAULT 'uploads', uploaded_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS documents (id INTEGER PRIMARY KEY AUTOINCREMENT, document_code TEXT, title TEXT NOT NULL, document_type TEXT, owner_position_id INTEGER REFERENCES positions(id), status TEXT NOT NULL DEFAULT 'draft', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT);
CREATE TABLE IF NOT EXISTS document_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, document_id INTEGER NOT NULL REFERENCES documents(id), version_label TEXT NOT NULL, file_id INTEGER REFERENCES files(id), effective_date TEXT, status TEXT NOT NULL DEFAULT 'draft', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS document_attestations (id INTEGER PRIMARY KEY AUTOINCREMENT, document_version_id INTEGER NOT NULL REFERENCES document_versions(id), staff_id INTEGER NOT NULL REFERENCES staff(id), attested_at TEXT, status TEXT NOT NULL DEFAULT 'pending');
CREATE TABLE IF NOT EXISTS evidence_files (id INTEGER PRIMARY KEY AUTOINCREMENT, file_id INTEGER NOT NULL REFERENCES files(id), module_key TEXT NOT NULL, record_type TEXT NOT NULL, record_id TEXT NOT NULL, notes TEXT, linked_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS record_links (id INTEGER PRIMARY KEY AUTOINCREMENT, source_module_key TEXT NOT NULL, source_record_type TEXT NOT NULL, source_record_id TEXT NOT NULL, target_module_key TEXT NOT NULL, target_record_type TEXT NOT NULL, target_record_id TEXT NOT NULL, notes TEXT);
CREATE TABLE IF NOT EXISTS equipment_items (id INTEGER PRIMARY KEY AUTOINCREMENT, equipment_number TEXT NOT NULL UNIQUE, name TEXT NOT NULL, category TEXT, manufacturer TEXT, model TEXT, serial_number TEXT, location_id INTEGER REFERENCES locations(id), department_id INTEGER REFERENCES departments(id), section_id INTEGER REFERENCES sections(id), status TEXT NOT NULL DEFAULT 'operational', calibration_due_date TEXT, last_service_date TEXT, next_service_due TEXT, assigned_to_staff_id INTEGER REFERENCES staff(id), created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT);
CREATE TABLE IF NOT EXISTS suppliers (id INTEGER PRIMARY KEY AUTOINCREMENT, supplier_code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, contact TEXT, phone TEXT, email TEXT, address TEXT, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT);
CREATE TABLE IF NOT EXISTS inventory_items (id INTEGER PRIMARY KEY AUTOINCREMENT, item_code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, category TEXT, supplier_id INTEGER REFERENCES suppliers(id), location_id INTEGER REFERENCES locations(id), quantity INTEGER NOT NULL DEFAULT 0, unit TEXT, status TEXT NOT NULL DEFAULT 'available', reorder_level INTEGER NOT NULL DEFAULT 0, expiry_date TEXT, created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT);
CREATE TABLE IF NOT EXISTS monitoring_records (id INTEGER PRIMARY KEY AUTOINCREMENT, monitoring_number TEXT NOT NULL UNIQUE, parameter TEXT NOT NULL, target_range TEXT, actual_value TEXT, unit TEXT, sample_date TEXT NOT NULL, location_id INTEGER REFERENCES locations(id), department_id INTEGER REFERENCES departments(id), section_id INTEGER REFERENCES sections(id), status TEXT NOT NULL DEFAULT 'reported', notes TEXT, created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT);
CREATE TABLE IF NOT EXISTS safety_incidents (id INTEGER PRIMARY KEY AUTOINCREMENT, incident_number TEXT NOT NULL UNIQUE, incident_date TEXT NOT NULL, location_id INTEGER REFERENCES locations(id), department_id INTEGER REFERENCES departments(id), section_id INTEGER REFERENCES sections(id), reported_by_staff_id INTEGER REFERENCES staff(id), description TEXT NOT NULL, category TEXT, severity TEXT, status TEXT NOT NULL DEFAULT 'open', corrective_action TEXT, reported_to TEXT, created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT);
CREATE TABLE IF NOT EXISTS actions (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, module_key TEXT NOT NULL, source_module TEXT, source_record_id TEXT, description TEXT, status TEXT NOT NULL DEFAULT 'Not started', priority TEXT NOT NULL DEFAULT 'normal', assigned_to_staff_id INTEGER REFERENCES staff(id), due_date TEXT, evidence_required INTEGER NOT NULL DEFAULT 0, completion_notes TEXT, created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT);
CREATE TABLE IF NOT EXISTS nonconforming_events (id INTEGER PRIMARY KEY AUTOINCREMENT, nc_number TEXT NOT NULL UNIQUE, event_date TEXT NOT NULL, detected_by_staff_id INTEGER REFERENCES staff(id), department_id INTEGER REFERENCES departments(id), section_id INTEGER REFERENCES sections(id), source_module TEXT, source_record_id TEXT, title TEXT NOT NULL, description TEXT, category TEXT, severity TEXT, impact_level TEXT, immediate_correction TEXT, patient_or_service_impact TEXT, status TEXT NOT NULL DEFAULT 'open', reviewer_staff_id INTEGER REFERENCES staff(id), reviewed_at TEXT, closure_notes TEXT, closed_by_staff_id INTEGER REFERENCES staff(id), closed_at TEXT, created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT);
CREATE TABLE IF NOT EXISTS complaints (id INTEGER PRIMARY KEY AUTOINCREMENT, complaint_number TEXT NOT NULL UNIQUE, received_date TEXT NOT NULL, source TEXT, complainant_type TEXT, complainant_name TEXT, contact TEXT, department_id INTEGER REFERENCES departments(id), section_id INTEGER REFERENCES sections(id), category TEXT, title TEXT NOT NULL, description TEXT, assigned_to_staff_id INTEGER REFERENCES staff(id), acknowledgement_status TEXT NOT NULL DEFAULT 'pending', investigation_summary TEXT, root_cause TEXT, correction TEXT, capa_required INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'new', closure_summary TEXT, closed_by_staff_id INTEGER REFERENCES staff(id), closed_at TEXT, created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT);
CREATE TABLE IF NOT EXISTS risks (id INTEGER PRIMARY KEY AUTOINCREMENT, risk_number TEXT NOT NULL UNIQUE, department_id INTEGER REFERENCES departments(id), section_id INTEGER REFERENCES sections(id), risk_area TEXT NOT NULL, risk_description TEXT, cause TEXT, consequence TEXT, existing_controls TEXT, likelihood INTEGER, severity INTEGER, detectability INTEGER, risk_score INTEGER, risk_level TEXT, mitigation_plan TEXT, responsible_staff_id INTEGER REFERENCES staff(id), review_due_date TEXT, residual_likelihood INTEGER, residual_severity INTEGER, residual_detectability INTEGER, residual_score INTEGER, residual_level TEXT, status TEXT NOT NULL DEFAULT 'active', created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT);
CREATE TABLE IF NOT EXISTS capa_records (id INTEGER PRIMARY KEY AUTOINCREMENT, capa_number TEXT NOT NULL UNIQUE, source_module TEXT, source_record_id TEXT, nc_id INTEGER REFERENCES nonconforming_events(id), complaint_id INTEGER REFERENCES complaints(id), risk_id INTEGER REFERENCES risks(id), title TEXT NOT NULL, problem_summary TEXT, root_cause TEXT, corrective_action TEXT, preventive_action TEXT, responsible_staff_id INTEGER REFERENCES staff(id), due_date TEXT, priority TEXT NOT NULL DEFAULT 'normal', status TEXT NOT NULL DEFAULT 'open', verification_notes TEXT, verified_by_staff_id INTEGER REFERENCES staff(id), verified_at TEXT, effectiveness_required INTEGER NOT NULL DEFAULT 0, effectiveness_due_date TEXT, effectiveness_review_notes TEXT, effectiveness_status TEXT DEFAULT 'pending', closed_by_staff_id INTEGER REFERENCES staff(id), closed_at TEXT, created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT);
CREATE TABLE IF NOT EXISTS risk_reviews (id INTEGER PRIMARY KEY AUTOINCREMENT, risk_id INTEGER NOT NULL REFERENCES risks(id), review_date TEXT NOT NULL, review_notes TEXT, risk_score INTEGER, risk_level TEXT, next_review_date TEXT, reviewed_by_staff_id INTEGER REFERENCES staff(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS capa_updates (id INTEGER PRIMARY KEY AUTOINCREMENT, capa_id INTEGER NOT NULL REFERENCES capa_records(id), update_date TEXT NOT NULL, update_text TEXT, status TEXT, evidence_file_id INTEGER REFERENCES evidence_files(id), created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER REFERENCES users(id), module_key TEXT NOT NULL, title TEXT NOT NULL, message TEXT, status TEXT NOT NULL DEFAULT 'unread', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, actor_user_id INTEGER, action TEXT NOT NULL, entity TEXT NOT NULL, entity_id TEXT, old_value TEXT, new_value TEXT, ip_address TEXT, device_id TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS backup_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, file_name TEXT NOT NULL, manifest TEXT NOT NULL, created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
`);

  // Migration: Add staff_id to users if it doesn't exist
  const tableInfo = database.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>;
  const hasStaffId = tableInfo.some(col => col.name === 'staff_id');
  if (!hasStaffId) {
    database.exec('ALTER TABLE users ADD COLUMN staff_id INTEGER REFERENCES staff(id)');
  }
  const actionColumns = database.prepare("PRAGMA table_info(actions)").all() as Array<{ name: string }>;
  const actionNames = new Set(actionColumns.map(col => col.name));
  if (!actionNames.has('source_module')) database.exec('ALTER TABLE actions ADD COLUMN source_module TEXT');
  if (!actionNames.has('source_record_id')) database.exec('ALTER TABLE actions ADD COLUMN source_record_id TEXT');
  if (!actionNames.has('description')) database.exec('ALTER TABLE actions ADD COLUMN description TEXT');
  if (!actionNames.has('evidence_required')) database.exec('ALTER TABLE actions ADD COLUMN evidence_required INTEGER NOT NULL DEFAULT 0');
  if (!actionNames.has('completion_notes')) database.exec('ALTER TABLE actions ADD COLUMN completion_notes TEXT');

  // Phase 3: extend equipment_items with maintenance/calibration scheduling fields
  const equipmentColumns = database.prepare("PRAGMA table_info(equipment_items)").all() as Array<{ name: string }>;
  const equipmentNames = new Set(equipmentColumns.map(col => col.name));
  if (!equipmentNames.has('equipment_type')) database.exec('ALTER TABLE equipment_items ADD COLUMN equipment_type TEXT');
  if (!equipmentNames.has('maintenance_frequency')) database.exec('ALTER TABLE equipment_items ADD COLUMN maintenance_frequency TEXT');
  if (!equipmentNames.has('calibration_frequency')) database.exec('ALTER TABLE equipment_items ADD COLUMN calibration_frequency TEXT');
  if (!equipmentNames.has('next_maintenance_due')) database.exec('ALTER TABLE equipment_items ADD COLUMN next_maintenance_due TEXT');
  if (!equipmentNames.has('next_calibration_due')) database.exec('ALTER TABLE equipment_items ADD COLUMN next_calibration_due TEXT');
  if (!equipmentNames.has('responsible_staff_id')) database.exec('ALTER TABLE equipment_items ADD COLUMN responsible_staff_id INTEGER REFERENCES staff(id)');
  if (!equipmentNames.has('date_received')) database.exec('ALTER TABLE equipment_items ADD COLUMN date_received TEXT');
  if (!equipmentNames.has('date_commissioned')) database.exec('ALTER TABLE equipment_items ADD COLUMN date_commissioned TEXT');
  if (!equipmentNames.has('calibration_required')) database.exec('ALTER TABLE equipment_items ADD COLUMN calibration_required INTEGER NOT NULL DEFAULT 0');
  if (!equipmentNames.has('notes')) database.exec('ALTER TABLE equipment_items ADD COLUMN notes TEXT');

  // Phase 3: extend inventory_items
  const inventoryColumns = database.prepare("PRAGMA table_info(inventory_items)").all() as Array<{ name: string }>;
  const inventoryNames = new Set(inventoryColumns.map(col => col.name));
  if (!inventoryNames.has('storage_requirement')) database.exec('ALTER TABLE inventory_items ADD COLUMN storage_requirement TEXT');
  if (!inventoryNames.has('department_id')) database.exec('ALTER TABLE inventory_items ADD COLUMN department_id INTEGER REFERENCES departments(id)');
  if (!inventoryNames.has('section_id')) database.exec('ALTER TABLE inventory_items ADD COLUMN section_id INTEGER REFERENCES sections(id)');
  if (!inventoryNames.has('minimum_stock')) database.exec('ALTER TABLE inventory_items ADD COLUMN minimum_stock INTEGER NOT NULL DEFAULT 0');
  if (!inventoryNames.has('is_active')) database.exec('ALTER TABLE inventory_items ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1');

  // Phase 3: extend suppliers
  const supplierColumns = database.prepare("PRAGMA table_info(suppliers)").all() as Array<{ name: string }>;
  const supplierNames = new Set(supplierColumns.map(col => col.name));
  if (!supplierNames.has('contact_person')) database.exec('ALTER TABLE suppliers ADD COLUMN contact_person TEXT');
  if (!supplierNames.has('item_category')) database.exec('ALTER TABLE suppliers ADD COLUMN item_category TEXT');
  if (!supplierNames.has('evaluation_required')) database.exec('ALTER TABLE suppliers ADD COLUMN evaluation_required INTEGER NOT NULL DEFAULT 0');
  if (!supplierNames.has('last_evaluation_date')) database.exec('ALTER TABLE suppliers ADD COLUMN last_evaluation_date TEXT');
  if (!supplierNames.has('next_evaluation_due')) database.exec('ALTER TABLE suppliers ADD COLUMN next_evaluation_due TEXT');

  // Phase 3: extend safety_incidents
  const safetyColumns = database.prepare("PRAGMA table_info(safety_incidents)").all() as Array<{ name: string }>;
  const safetyNames = new Set(safetyColumns.map(col => col.name));
  if (!safetyNames.has('incident_type')) database.exec('ALTER TABLE safety_incidents ADD COLUMN incident_type TEXT');
  if (!safetyNames.has('title')) database.exec('ALTER TABLE safety_incidents ADD COLUMN title TEXT');
  if (!safetyNames.has('immediate_action')) database.exec('ALTER TABLE safety_incidents ADD COLUMN immediate_action TEXT');
  if (!safetyNames.has('persons_involved')) database.exec('ALTER TABLE safety_incidents ADD COLUMN persons_involved TEXT');
  if (!safetyNames.has('nc_id')) database.exec('ALTER TABLE safety_incidents ADD COLUMN nc_id INTEGER REFERENCES nonconforming_events(id)');
  if (!safetyNames.has('capa_id')) database.exec('ALTER TABLE safety_incidents ADD COLUMN capa_id INTEGER REFERENCES capa_records(id)');
  if (!safetyNames.has('closed_by_staff_id')) database.exec('ALTER TABLE safety_incidents ADD COLUMN closed_by_staff_id INTEGER REFERENCES staff(id)');
  if (!safetyNames.has('closed_at')) database.exec('ALTER TABLE safety_incidents ADD COLUMN closed_at TEXT');

  // Phase 3: new tables
  database.exec(`
CREATE TABLE IF NOT EXISTS equipment_maintenance_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  equipment_id INTEGER NOT NULL REFERENCES equipment_items(id),
  maintenance_date TEXT NOT NULL,
  maintenance_type TEXT NOT NULL,
  performed_by_staff_id INTEGER REFERENCES staff(id),
  findings TEXT,
  action_taken TEXT,
  next_due_date TEXT,
  status TEXT NOT NULL DEFAULT 'completed',
  evidence_file_id INTEGER REFERENCES files(id),
  reviewed_by_staff_id INTEGER REFERENCES staff(id),
  reviewed_at TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS equipment_breakdowns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  equipment_id INTEGER NOT NULL REFERENCES equipment_items(id),
  breakdown_date TEXT NOT NULL,
  reported_by_staff_id INTEGER REFERENCES staff(id),
  description TEXT NOT NULL,
  service_impact TEXT,
  immediate_action TEXT,
  equipment_status TEXT,
  repair_action TEXT,
  service_provider TEXT,
  return_to_service_date TEXT,
  verified_by_staff_id INTEGER REFERENCES staff(id),
  nc_id INTEGER REFERENCES nonconforming_events(id),
  capa_id INTEGER REFERENCES capa_records(id),
  status TEXT NOT NULL DEFAULT 'open',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS monitoring_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  monitoring_type TEXT,
  parameter TEXT NOT NULL,
  unit TEXT,
  department_id INTEGER REFERENCES departments(id),
  section_id INTEGER REFERENCES sections(id),
  location_id INTEGER REFERENCES locations(id),
  lower_limit REAL,
  upper_limit REAL,
  warning_lower_limit REAL,
  warning_upper_limit REAL,
  critical_lower_limit REAL,
  critical_upper_limit REAL,
  frequency TEXT,
  responsible_staff_id INTEGER REFERENCES staff(id),
  reviewer_staff_id INTEGER REFERENCES staff(id),
  nc_trigger_enabled INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS monitoring_readings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  monitoring_item_id INTEGER NOT NULL REFERENCES monitoring_items(id),
  reading_date TEXT NOT NULL,
  reading_time TEXT,
  value REAL NOT NULL,
  entered_by_staff_id INTEGER REFERENCES staff(id),
  status TEXT NOT NULL DEFAULT 'normal',
  comment TEXT,
  immediate_action TEXT,
  reviewed_by_staff_id INTEGER REFERENCES staff(id),
  reviewed_at TEXT,
  nc_id INTEGER REFERENCES nonconforming_events(id),
  capa_id INTEGER REFERENCES capa_records(id),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS inventory_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES inventory_items(id),
  batch_number TEXT,
  lot_number TEXT,
  supplier_id INTEGER REFERENCES suppliers(id),
  supplier_name TEXT,
  quantity_received REAL NOT NULL DEFAULT 0,
  quantity_available REAL NOT NULL DEFAULT 0,
  date_received TEXT NOT NULL,
  expiry_date TEXT,
  acceptance_status TEXT NOT NULL DEFAULT 'pending',
  acceptance_checked_by_staff_id INTEGER REFERENCES staff(id),
  acceptance_date TEXT,
  storage_location_id INTEGER REFERENCES locations(id),
  status TEXT NOT NULL DEFAULT 'available',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS inventory_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES inventory_items(id),
  batch_id INTEGER REFERENCES inventory_batches(id),
  movement_type TEXT NOT NULL,
  quantity REAL NOT NULL,
  movement_date TEXT NOT NULL,
  issued_to_section_id INTEGER REFERENCES sections(id),
  received_by_staff_id INTEGER REFERENCES staff(id),
  reason TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS supplier_evaluations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  evaluation_date TEXT NOT NULL,
  evaluated_by_staff_id INTEGER REFERENCES staff(id),
  rating TEXT,
  findings TEXT,
  action_required TEXT,
  next_evaluation_date TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);

  // Phase 4: IQC, EQA, Verification/Validation, Measurement Uncertainty
  database.exec(`
CREATE TABLE IF NOT EXISTS iqc_materials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  material_code TEXT NOT NULL UNIQUE,
  material_name TEXT NOT NULL,
  department_id INTEGER REFERENCES departments(id),
  section_id INTEGER REFERENCES sections(id),
  test_name TEXT NOT NULL,
  analyte TEXT NOT NULL,
  lot_number TEXT NOT NULL,
  manufacturer TEXT,
  expiry_date TEXT,
  storage_condition TEXT,
  target_mean REAL,
  target_sd REAL,
  acceptable_low REAL,
  acceptable_high REAL,
  equipment_id INTEGER REFERENCES equipment_items(id),
  inventory_batch_id INTEGER REFERENCES inventory_batches(id),
  is_active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS iqc_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  iqc_material_id INTEGER NOT NULL REFERENCES iqc_materials(id),
  run_date TEXT NOT NULL,
  run_time TEXT,
  result_value REAL NOT NULL,
  entered_by_staff_id INTEGER REFERENCES staff(id),
  equipment_id INTEGER REFERENCES equipment_items(id),
  inventory_batch_id INTEGER REFERENCES inventory_batches(id),
  status TEXT NOT NULL DEFAULT 'accepted',
  rule_violation TEXT,
  comment TEXT,
  immediate_action TEXT,
  reviewed_by_staff_id INTEGER REFERENCES staff(id),
  reviewed_at TEXT,
  nc_id INTEGER REFERENCES nonconforming_events(id),
  capa_id INTEGER REFERENCES capa_records(id),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS iqc_lot_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  old_iqc_material_id INTEGER REFERENCES iqc_materials(id),
  new_iqc_material_id INTEGER REFERENCES iqc_materials(id),
  change_date TEXT NOT NULL,
  reason TEXT,
  verification_summary TEXT,
  approved_by_staff_id INTEGER REFERENCES staff(id),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS eqa_programs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  program_code TEXT NOT NULL UNIQUE,
  program_name TEXT NOT NULL,
  provider TEXT NOT NULL,
  department_id INTEGER REFERENCES departments(id),
  section_id INTEGER REFERENCES sections(id),
  test_area TEXT NOT NULL,
  frequency TEXT,
  contact TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS eqa_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  eqa_program_id INTEGER NOT NULL REFERENCES eqa_programs(id),
  cycle_name TEXT NOT NULL,
  received_date TEXT,
  submission_due_date TEXT,
  submitted_date TEXT,
  result_received_date TEXT,
  performance_status TEXT,
  score TEXT,
  findings TEXT,
  corrective_action_required INTEGER NOT NULL DEFAULT 0,
  nc_id INTEGER REFERENCES nonconforming_events(id),
  capa_id INTEGER REFERENCES capa_records(id),
  responsible_staff_id INTEGER REFERENCES staff(id),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS eqa_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  eqa_event_id INTEGER NOT NULL REFERENCES eqa_events(id),
  analyte_or_test TEXT NOT NULL,
  reported_result TEXT,
  expected_result TEXT,
  performance TEXT,
  comment TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS method_verifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  verification_number TEXT NOT NULL UNIQUE,
  department_id INTEGER REFERENCES departments(id),
  section_id INTEGER REFERENCES sections(id),
  method_name TEXT NOT NULL,
  test_name TEXT NOT NULL,
  equipment_id INTEGER REFERENCES equipment_items(id),
  verification_type TEXT NOT NULL,
  reason TEXT,
  start_date TEXT,
  completion_date TEXT,
  parameters_assessed TEXT,
  acceptance_criteria TEXT,
  summary TEXT,
  conclusion TEXT,
  status TEXT NOT NULL DEFAULT 'in_progress',
  approved_by_staff_id INTEGER REFERENCES staff(id),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS verification_experiments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  verification_id INTEGER NOT NULL REFERENCES method_verifications(id),
  experiment_type TEXT NOT NULL,
  date_performed TEXT,
  sample_count INTEGER,
  results_summary TEXT,
  acceptance_met INTEGER NOT NULL DEFAULT 0,
  evidence_file_id INTEGER REFERENCES files(id),
  performed_by_staff_id INTEGER REFERENCES staff(id),
  reviewed_by_staff_id INTEGER REFERENCES staff(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS equipment_verifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  equipment_id INTEGER NOT NULL REFERENCES equipment_items(id),
  verification_number TEXT NOT NULL UNIQUE,
  verification_type TEXT NOT NULL,
  verification_date TEXT NOT NULL,
  reason TEXT,
  acceptance_criteria TEXT,
  results_summary TEXT,
  conclusion TEXT,
  status TEXT NOT NULL DEFAULT 'in_progress',
  verified_by_staff_id INTEGER REFERENCES staff(id),
  approved_by_staff_id INTEGER REFERENCES staff(id),
  evidence_file_id INTEGER REFERENCES files(id),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS measurement_uncertainty_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mu_number TEXT NOT NULL UNIQUE,
  department_id INTEGER REFERENCES departments(id),
  section_id INTEGER REFERENCES sections(id),
  test_name TEXT NOT NULL,
  analyte TEXT NOT NULL,
  method_name TEXT,
  equipment_id INTEGER REFERENCES equipment_items(id),
  calculation_date TEXT NOT NULL,
  data_period_start TEXT,
  data_period_end TEXT,
  source_data TEXT,
  mean_value REAL,
  sd_value REAL,
  cv_percent REAL,
  uncertainty_value REAL,
  expanded_uncertainty REAL,
  coverage_factor REAL,
  interpretation TEXT,
  reviewed_by_staff_id INTEGER REFERENCES staff(id),
  approved_by_staff_id INTEGER REFERENCES staff(id),
  status TEXT NOT NULL DEFAULT 'draft',
  evidence_file_id INTEGER REFERENCES files(id),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
`);
}
