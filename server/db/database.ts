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

  // Phase 4 polish: extend iqc_results with z_score
  const iqcResultColumns = database.prepare("PRAGMA table_info(iqc_results)").all() as Array<{ name: string }>;
  const iqcResultNames = new Set(iqcResultColumns.map(col => col.name));
  if (!iqcResultNames.has('z_score')) database.exec('ALTER TABLE iqc_results ADD COLUMN z_score REAL');

  // Phase 5: Blood Bank Quality & Inventory Handover
  database.exec(`
CREATE TABLE IF NOT EXISTS blood_units (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  unit_number TEXT NOT NULL UNIQUE,
  batch_number TEXT,
  blood_group TEXT NOT NULL,
  component_type TEXT NOT NULL,
  donor_type TEXT,
  collection_date TEXT NOT NULL,
  expiry_date TEXT NOT NULL,
  screening_hbsag TEXT,
  screening_hcv TEXT,
  screening_syphilis TEXT,
  screening_hiv TEXT,
  screening_status TEXT,
  current_status TEXT NOT NULL DEFAULT 'available',
  location_id INTEGER REFERENCES locations(id),
  refrigerator_monitoring_item_id INTEGER REFERENCES monitoring_items(id),
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS blood_bank_handovers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  handover_number TEXT NOT NULL UNIQUE,
  handover_date TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  outgoing_staff_id INTEGER REFERENCES staff(id),
  incoming_staff_id INTEGER REFERENCES staff(id),
  blood_bank_unit_head_id INTEGER REFERENCES staff(id),
  total_units_available INTEGER NOT NULL DEFAULT 0,
  total_units_expiring_soon INTEGER NOT NULL DEFAULT 0,
  total_units_expired INTEGER NOT NULL DEFAULT 0,
  total_donations INTEGER NOT NULL DEFAULT 0,
  family_donor_count INTEGER NOT NULL DEFAULT 0,
  voluntary_donor_count INTEGER NOT NULL DEFAULT 0,
  commercial_paid_donor_count INTEGER NOT NULL DEFAULT 0,
  outside_campaign_donor_count INTEGER NOT NULL DEFAULT 0,
  total_transfusions INTEGER NOT NULL DEFAULT 0,
  total_discards INTEGER NOT NULL DEFAULT 0,
  donor_reactions_count INTEGER NOT NULL DEFAULT 0,
  transfusion_reactions_count INTEGER NOT NULL DEFAULT 0,
  issues_noted TEXT,
  outgoing_staff_signed_at TEXT,
  incoming_staff_signed_at TEXT,
  unit_head_reviewed_at TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS blood_handover_units (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  handover_id INTEGER NOT NULL REFERENCES blood_bank_handovers(id),
  blood_unit_id INTEGER REFERENCES blood_units(id),
  unit_number TEXT,
  batch_number TEXT,
  blood_group TEXT,
  component_type TEXT,
  collection_date TEXT,
  expiry_date TEXT,
  screening_hbsag TEXT,
  screening_hcv TEXT,
  screening_syphilis TEXT,
  screening_hiv TEXT,
  screening_status TEXT,
  unit_status_at_handover TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS blood_donation_campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_number TEXT,
  campaign_date TEXT NOT NULL,
  location TEXT NOT NULL,
  organizer TEXT,
  total_screened INTEGER NOT NULL DEFAULT 0,
  total_collected INTEGER NOT NULL DEFAULT 0,
  family_donor_count INTEGER NOT NULL DEFAULT 0,
  voluntary_donor_count INTEGER NOT NULL DEFAULT 0,
  commercial_paid_donor_count INTEGER NOT NULL DEFAULT 0,
  rejected_or_deferred_count INTEGER NOT NULL DEFAULT 0,
  remarks TEXT,
  responsible_staff_id INTEGER REFERENCES staff(id),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS blood_donation_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  summary_date TEXT NOT NULL,
  handover_id INTEGER REFERENCES blood_bank_handovers(id),
  donor_type TEXT,
  number_screened INTEGER NOT NULL DEFAULT 0,
  number_accepted INTEGER NOT NULL DEFAULT 0,
  number_deferred INTEGER NOT NULL DEFAULT 0,
  number_collected INTEGER NOT NULL DEFAULT 0,
  remarks TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS blood_transfusion_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  summary_date TEXT NOT NULL,
  handover_id INTEGER REFERENCES blood_bank_handovers(id),
  blood_group TEXT,
  component_type TEXT,
  number_transfused INTEGER NOT NULL DEFAULT 0,
  remarks TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS blood_adverse_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_number TEXT NOT NULL UNIQUE,
  event_date TEXT NOT NULL,
  event_type TEXT NOT NULL,
  related_unit_id INTEGER REFERENCES blood_units(id),
  blood_group TEXT,
  donor_type TEXT,
  department_id INTEGER REFERENCES departments(id),
  section_id INTEGER REFERENCES sections(id),
  location_id INTEGER REFERENCES locations(id),
  reported_by_staff_id INTEGER REFERENCES staff(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  immediate_action TEXT,
  severity TEXT,
  outcome TEXT,
  investigation_summary TEXT,
  nc_id INTEGER REFERENCES nonconforming_events(id),
  capa_id INTEGER REFERENCES capa_records(id),
  safety_incident_id INTEGER REFERENCES safety_incidents(id),
  status TEXT NOT NULL DEFAULT 'open',
  closed_by_staff_id INTEGER REFERENCES staff(id),
  closed_at TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS blood_discards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  discard_date TEXT NOT NULL,
  blood_unit_id INTEGER REFERENCES blood_units(id),
  unit_number TEXT,
  blood_group TEXT,
  component_type TEXT,
  reason TEXT NOT NULL,
  authorized_by_staff_id INTEGER REFERENCES staff(id),
  discarded_by_staff_id INTEGER REFERENCES staff(id),
  nc_id INTEGER REFERENCES nonconforming_events(id),
  capa_id INTEGER REFERENCES capa_records(id),
  remarks TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);

  // Phase 6: Monthly Reports & LHIMS Archive
  database.exec(`
CREATE TABLE IF NOT EXISTS lhims_import_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_number TEXT NOT NULL UNIQUE,
  report_month INTEGER NOT NULL,
  report_year INTEGER NOT NULL,
  import_type TEXT NOT NULL,
  source_file_id INTEGER REFERENCES files(id),
  original_filename TEXT,
  file_hash TEXT,
  imported_by_staff_id INTEGER REFERENCES staff(id),
  imported_at TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  total_rows INTEGER NOT NULL DEFAULT 0,
  processed_rows INTEGER NOT NULL DEFAULT 0,
  exception_count INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS lhims_import_rows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  import_batch_id INTEGER NOT NULL REFERENCES lhims_import_batches(id),
  row_number INTEGER,
  patient_type TEXT,
  request_date TEXT,
  sample_date TEXT,
  result_date TEXT,
  patient_id TEXT,
  patient_age TEXT,
  patient_sex TEXT,
  department_name TEXT,
  section_name TEXT,
  test_name TEXT,
  parameter_name TEXT,
  result_value TEXT,
  unit TEXT,
  sample_type TEXT,
  organism TEXT,
  antibiotic TEXT,
  susceptibility TEXT,
  raw_json TEXT,
  mapping_status TEXT NOT NULL DEFAULT 'unprocessed',
  exception_reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS report_mapping_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mapping_name TEXT NOT NULL,
  source_pattern TEXT NOT NULL,
  source_field TEXT NOT NULL DEFAULT 'test_name',
  report_type TEXT NOT NULL,
  report_section TEXT NOT NULL,
  report_row TEXT NOT NULL,
  counting_rule TEXT NOT NULL DEFAULT 'count_rows',
  department_id INTEGER REFERENCES departments(id),
  section_id INTEGER REFERENCES sections(id),
  is_active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS monthly_report_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_number TEXT NOT NULL UNIQUE,
  report_month INTEGER NOT NULL,
  report_year INTEGER NOT NULL,
  report_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  generated_from_import_batch_ids TEXT,
  generated_by_staff_id INTEGER REFERENCES staff(id),
  generated_at TEXT,
  reviewed_by_staff_id INTEGER REFERENCES staff(id),
  reviewed_at TEXT,
  approved_by_staff_id INTEGER REFERENCES staff(id),
  approved_at TEXT,
  exception_count INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  final_file_id INTEGER REFERENCES files(id),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS monthly_report_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  monthly_report_batch_id INTEGER NOT NULL REFERENCES monthly_report_batches(id),
  report_section TEXT NOT NULL,
  report_row TEXT NOT NULL,
  category TEXT,
  value_text TEXT,
  value_number REAL,
  source_count INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS monthly_report_exceptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  import_batch_id INTEGER NOT NULL REFERENCES lhims_import_batches(id),
  import_row_id INTEGER REFERENCES lhims_import_rows(id),
  exception_type TEXT NOT NULL,
  exception_message TEXT,
  suggested_mapping_rule_id INTEGER REFERENCES report_mapping_rules(id),
  status TEXT NOT NULL DEFAULT 'open',
  resolution_notes TEXT,
  resolved_by_staff_id INTEGER REFERENCES staff(id),
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS tat_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  import_batch_id INTEGER NOT NULL REFERENCES lhims_import_batches(id),
  request_id TEXT,
  patient_type TEXT,
  test_name TEXT,
  department_id INTEGER REFERENCES departments(id),
  section_id INTEGER REFERENCES sections(id),
  request_time TEXT,
  sample_received_time TEXT,
  verification_time TEXT,
  dispatch_time TEXT,
  tat_minutes INTEGER,
  target_minutes INTEGER,
  status TEXT,
  exception_reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);

  const tatColumns = database.prepare("PRAGMA table_info(tat_records)").all() as Array<{ name: string }>;
  const tatNames = new Set(tatColumns.map(col => col.name));
  if (!tatNames.has('section_name')) database.exec('ALTER TABLE tat_records ADD COLUMN section_name TEXT');
  if (!tatNames.has('department_name')) database.exec('ALTER TABLE tat_records ADD COLUMN department_name TEXT');

  // Phase 7: Document Control, Staff Declarations, Training, Competency, Duty Rosters
  const documentColumns = database.prepare("PRAGMA table_info(documents)").all() as Array<{ name: string }>;
  const documentNames = new Set(documentColumns.map(col => col.name));
  if (!documentNames.has('department_id')) database.exec('ALTER TABLE documents ADD COLUMN department_id INTEGER REFERENCES departments(id)');
  if (!documentNames.has('section_id')) database.exec('ALTER TABLE documents ADD COLUMN section_id INTEGER REFERENCES sections(id)');
  if (!documentNames.has('owner_staff_id')) database.exec('ALTER TABLE documents ADD COLUMN owner_staff_id INTEGER REFERENCES staff(id)');
  if (!documentNames.has('current_version_id')) database.exec('ALTER TABLE documents ADD COLUMN current_version_id INTEGER REFERENCES document_versions(id)');
  if (!documentNames.has('review_frequency_months')) database.exec('ALTER TABLE documents ADD COLUMN review_frequency_months INTEGER');
  if (!documentNames.has('next_review_date')) database.exec('ALTER TABLE documents ADD COLUMN next_review_date TEXT');
  if (!documentNames.has('access_level')) database.exec("ALTER TABLE documents ADD COLUMN access_level TEXT DEFAULT 'internal'");
  if (!documentNames.has('is_controlled')) database.exec('ALTER TABLE documents ADD COLUMN is_controlled INTEGER NOT NULL DEFAULT 1');
  if (!documentNames.has('created_by')) database.exec('ALTER TABLE documents ADD COLUMN created_by INTEGER REFERENCES users(id)');
  if (!documentNames.has('obsolete_reason')) database.exec('ALTER TABLE documents ADD COLUMN obsolete_reason TEXT');

  const versionColumns = database.prepare("PRAGMA table_info(document_versions)").all() as Array<{ name: string }>;
  const versionNames = new Set(versionColumns.map(col => col.name));
  if (!versionNames.has('version_number')) database.exec('ALTER TABLE document_versions ADD COLUMN version_number TEXT');
  if (!versionNames.has('revision_summary')) database.exec('ALTER TABLE document_versions ADD COLUMN revision_summary TEXT');
  if (!versionNames.has('prepared_by_staff_id')) database.exec('ALTER TABLE document_versions ADD COLUMN prepared_by_staff_id INTEGER REFERENCES staff(id)');
  if (!versionNames.has('reviewed_by_staff_id')) database.exec('ALTER TABLE document_versions ADD COLUMN reviewed_by_staff_id INTEGER REFERENCES staff(id)');
  if (!versionNames.has('approved_by_staff_id')) database.exec('ALTER TABLE document_versions ADD COLUMN approved_by_staff_id INTEGER REFERENCES staff(id)');
  if (!versionNames.has('review_date')) database.exec('ALTER TABLE document_versions ADD COLUMN review_date TEXT');
  if (!versionNames.has('obsolete_date')) database.exec('ALTER TABLE document_versions ADD COLUMN obsolete_date TEXT');
  if (!versionNames.has('obsolete_reason')) database.exec('ALTER TABLE document_versions ADD COLUMN obsolete_reason TEXT');
  if (!versionNames.has('approved_at')) database.exec('ALTER TABLE document_versions ADD COLUMN approved_at TEXT');
  if (!versionNames.has('created_by')) database.exec('ALTER TABLE document_versions ADD COLUMN created_by INTEGER REFERENCES users(id)');

  const attestationColumns = database.prepare("PRAGMA table_info(document_attestations)").all() as Array<{ name: string }>;
  const attestationNames = new Set(attestationColumns.map(col => col.name));
  if (!attestationNames.has('document_id')) database.exec('ALTER TABLE document_attestations ADD COLUMN document_id INTEGER REFERENCES documents(id)');
  if (!attestationNames.has('assigned_by_staff_id')) database.exec('ALTER TABLE document_attestations ADD COLUMN assigned_by_staff_id INTEGER REFERENCES staff(id)');
  if (!attestationNames.has('assigned_at')) database.exec('ALTER TABLE document_attestations ADD COLUMN assigned_at TEXT');
  if (!attestationNames.has('due_date')) database.exec('ALTER TABLE document_attestations ADD COLUMN due_date TEXT');
  if (!attestationNames.has('signature_file_id')) database.exec('ALTER TABLE document_attestations ADD COLUMN signature_file_id INTEGER REFERENCES files(id)');
  if (!attestationNames.has('notes')) database.exec('ALTER TABLE document_attestations ADD COLUMN notes TEXT');

  const authColumns = database.prepare("PRAGMA table_info(technical_authorizations)").all() as Array<{ name: string }>;
  const authNames = new Set(authColumns.map(col => col.name));
  if (!authNames.has('competency_assessment_id')) database.exec('ALTER TABLE technical_authorizations ADD COLUMN competency_assessment_id INTEGER');
  if (!authNames.has('created_by')) database.exec('ALTER TABLE technical_authorizations ADD COLUMN created_by INTEGER REFERENCES users(id)');
  if (!authNames.has('notes')) database.exec('ALTER TABLE technical_authorizations ADD COLUMN notes TEXT');

  database.exec(`
CREATE TABLE IF NOT EXISTS document_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  review_number TEXT,
  document_id INTEGER NOT NULL REFERENCES documents(id),
  document_version_id INTEGER REFERENCES document_versions(id),
  review_date TEXT NOT NULL,
  review_outcome TEXT NOT NULL,
  review_notes TEXT,
  next_review_date TEXT,
  reviewed_by_staff_id INTEGER REFERENCES staff(id),
  action_required INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS document_print_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL REFERENCES documents(id),
  document_version_id INTEGER REFERENCES document_versions(id),
  printed_by_staff_id INTEGER REFERENCES staff(id),
  print_date TEXT NOT NULL,
  print_purpose TEXT,
  controlled_copy INTEGER NOT NULL DEFAULT 0,
  copy_number TEXT,
  watermark TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS document_distribution (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL REFERENCES documents(id),
  document_version_id INTEGER REFERENCES document_versions(id),
  target_type TEXT NOT NULL,
  target_staff_id INTEGER REFERENCES staff(id),
  target_position_id INTEGER REFERENCES positions(id),
  target_section_id INTEGER REFERENCES sections(id),
  assigned_by_staff_id INTEGER REFERENCES staff(id),
  assigned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  due_date TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS staff_declarations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  declaration_number TEXT NOT NULL UNIQUE,
  declaration_type TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  document_id INTEGER REFERENCES documents(id),
  document_version_id INTEGER REFERENCES document_versions(id),
  staff_id INTEGER REFERENCES staff(id),
  signed_at TEXT,
  signature_file_id INTEGER REFERENCES files(id),
  status TEXT NOT NULL DEFAULT 'pending',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS training_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  training_number TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT,
  training_type TEXT,
  department_id INTEGER REFERENCES departments(id),
  section_id INTEGER REFERENCES sections(id),
  trainer_staff_id INTEGER REFERENCES staff(id),
  training_date TEXT NOT NULL,
  start_time TEXT,
  end_time TEXT,
  location TEXT,
  evidence_file_id INTEGER REFERENCES files(id),
  status TEXT NOT NULL DEFAULT 'planned',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS training_attendance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  training_event_id INTEGER NOT NULL REFERENCES training_events(id),
  staff_id INTEGER NOT NULL REFERENCES staff(id),
  attendance_status TEXT NOT NULL DEFAULT 'invited',
  signed_at TEXT,
  remarks TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(training_event_id, staff_id)
);
CREATE TABLE IF NOT EXISTS competency_assessments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  competency_number TEXT NOT NULL UNIQUE,
  staff_id INTEGER NOT NULL REFERENCES staff(id),
  department_id INTEGER REFERENCES departments(id),
  section_id INTEGER REFERENCES sections(id),
  activity TEXT NOT NULL,
  assessment_method TEXT NOT NULL,
  assessor_staff_id INTEGER REFERENCES staff(id),
  assessment_date TEXT NOT NULL,
  outcome TEXT,
  findings TEXT,
  retraining_required INTEGER NOT NULL DEFAULT 0,
  next_assessment_due TEXT,
  evidence_file_id INTEGER REFERENCES files(id),
  authorization_recommendation TEXT,
  status TEXT NOT NULL DEFAULT 'planned',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS staff_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id INTEGER NOT NULL REFERENCES staff(id),
  document_type TEXT NOT NULL,
  title TEXT NOT NULL,
  file_id INTEGER REFERENCES files(id),
  issue_date TEXT,
  expiry_date TEXT,
  verification_status TEXT NOT NULL DEFAULT 'pending',
  verified_by_staff_id INTEGER REFERENCES staff(id),
  verified_at TEXT,
  remarks TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS duty_rosters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  roster_number TEXT NOT NULL UNIQUE,
  department_id INTEGER REFERENCES departments(id),
  section_id INTEGER REFERENCES sections(id),
  roster_start_date TEXT NOT NULL,
  roster_end_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  prepared_by_staff_id INTEGER REFERENCES staff(id),
  approved_by_staff_id INTEGER REFERENCES staff(id),
  approved_at TEXT,
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS duty_roster_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  roster_id INTEGER NOT NULL REFERENCES duty_rosters(id),
  staff_id INTEGER NOT NULL REFERENCES staff(id),
  duty_date TEXT NOT NULL,
  shift_name TEXT,
  start_time TEXT,
  end_time TEXT,
  duty_role TEXT,
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);

  // Phase 8: Internal Assessments, Meetings, Management Review, Quality Indicators, Continual Improvement
  database.exec(`
CREATE TABLE IF NOT EXISTS assessment_programs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  program_number TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  assessment_type TEXT NOT NULL,
  department_id INTEGER REFERENCES departments(id),
  section_id INTEGER REFERENCES sections(id),
  planned_start_date TEXT NOT NULL,
  planned_end_date TEXT,
  lead_assessor_staff_id INTEGER REFERENCES staff(id),
  scope TEXT,
  objectives TEXT,
  status TEXT NOT NULL DEFAULT 'planned',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS assessment_findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  finding_number TEXT NOT NULL UNIQUE,
  assessment_program_id INTEGER NOT NULL REFERENCES assessment_programs(id),
  finding_date TEXT NOT NULL,
  department_id INTEGER REFERENCES departments(id),
  section_id INTEGER REFERENCES sections(id),
  finding_type TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  evidence_summary TEXT,
  severity TEXT,
  responsible_staff_id INTEGER REFERENCES staff(id),
  nc_id INTEGER REFERENCES nonconforming_events(id),
  capa_id INTEGER REFERENCES capa_records(id),
  status TEXT NOT NULL DEFAULT 'open',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS meetings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_number TEXT NOT NULL UNIQUE,
  meeting_type TEXT NOT NULL,
  title TEXT NOT NULL,
  meeting_date TEXT NOT NULL,
  start_time TEXT,
  end_time TEXT,
  location TEXT,
  chair_staff_id INTEGER REFERENCES staff(id),
  secretary_staff_id INTEGER REFERENCES staff(id),
  agenda TEXT,
  minutes TEXT,
  status TEXT NOT NULL DEFAULT 'scheduled',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS meeting_attendance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id INTEGER NOT NULL REFERENCES meetings(id),
  staff_id INTEGER NOT NULL REFERENCES staff(id),
  attendance_status TEXT NOT NULL DEFAULT 'invited',
  signed_at TEXT,
  remarks TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(meeting_id, staff_id)
);
CREATE TABLE IF NOT EXISTS meeting_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id INTEGER NOT NULL REFERENCES meetings(id),
  action_id INTEGER NOT NULL REFERENCES actions(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(meeting_id, action_id)
);
CREATE TABLE IF NOT EXISTS management_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  review_number TEXT NOT NULL UNIQUE,
  review_period_start TEXT NOT NULL,
  review_period_end TEXT NOT NULL,
  review_date TEXT NOT NULL,
  chair_staff_id INTEGER REFERENCES staff(id),
  secretary_staff_id INTEGER REFERENCES staff(id),
  summary TEXT,
  conclusions TEXT,
  decisions TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  approved_by_staff_id INTEGER REFERENCES staff(id),
  approved_at TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS management_review_inputs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  management_review_id INTEGER NOT NULL REFERENCES management_reviews(id),
  input_area TEXT NOT NULL,
  source_module TEXT,
  source_record_id TEXT,
  summary TEXT,
  issues TEXT,
  actions_required TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS quality_indicators (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  indicator_code TEXT NOT NULL UNIQUE,
  indicator_name TEXT NOT NULL,
  department_id INTEGER REFERENCES departments(id),
  section_id INTEGER REFERENCES sections(id),
  description TEXT,
  numerator_definition TEXT,
  denominator_definition TEXT,
  target_value REAL,
  warning_threshold REAL,
  critical_threshold REAL,
  frequency TEXT NOT NULL,
  responsible_staff_id INTEGER REFERENCES staff(id),
  reviewer_staff_id INTEGER REFERENCES staff(id),
  is_active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS quality_indicator_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  indicator_id INTEGER NOT NULL REFERENCES quality_indicators(id),
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  numerator_value REAL,
  denominator_value REAL,
  calculated_value REAL,
  interpretation TEXT,
  status TEXT NOT NULL DEFAULT 'pending_review',
  reviewed_by_staff_id INTEGER REFERENCES staff(id),
  reviewed_at TEXT,
  nc_id INTEGER REFERENCES nonconforming_events(id),
  capa_id INTEGER REFERENCES capa_records(id),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS improvement_projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_number TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  source_module TEXT,
  source_record_id TEXT,
  improvement_area TEXT NOT NULL,
  aim_statement TEXT NOT NULL,
  baseline_measure TEXT,
  target_measure TEXT,
  start_date TEXT,
  expected_completion_date TEXT,
  responsible_staff_id INTEGER REFERENCES staff(id),
  status TEXT NOT NULL DEFAULT 'planned',
  outcome_summary TEXT,
  closed_by_staff_id INTEGER REFERENCES staff(id),
  closed_at TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS improvement_updates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES improvement_projects(id),
  update_date TEXT NOT NULL,
  update_text TEXT,
  progress_status TEXT,
  evidence_file_id INTEGER REFERENCES files(id),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS assessment_checklists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  checklist_code TEXT,
  checklist_name TEXT NOT NULL,
  checklist_type TEXT NOT NULL,
  description TEXT,
  source_name TEXT,
  version_label TEXT,
  effective_date TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  is_default INTEGER NOT NULL DEFAULT 0,
  is_editable INTEGER NOT NULL DEFAULT 1,
  marking_enabled INTEGER NOT NULL DEFAULT 0,
  total_possible_marks REAL,
  internal_threshold_label TEXT,
  internal_pass_mark REAL,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS assessment_checklist_sections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  checklist_id INTEGER NOT NULL REFERENCES assessment_checklists(id),
  section_code TEXT,
  section_title TEXT NOT NULL,
  section_description TEXT,
  display_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  section_possible_marks REAL,
  section_weight REAL,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS assessment_checklist_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  checklist_id INTEGER NOT NULL REFERENCES assessment_checklists(id),
  section_id INTEGER REFERENCES assessment_checklist_sections(id),
  question_code TEXT,
  question_text TEXT NOT NULL,
  guidance TEXT,
  expected_evidence TEXT,
  response_type TEXT NOT NULL DEFAULT 'met_partial_not_met',
  display_order INTEGER NOT NULL DEFAULT 0,
  is_required INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  max_marks REAL,
  weight REAL,
  scoring_guidance TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS assessment_selected_checklists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assessment_program_id INTEGER NOT NULL REFERENCES assessment_programs(id),
  checklist_id INTEGER NOT NULL REFERENCES assessment_checklists(id),
  selection_mode TEXT NOT NULL,
  selected_by_staff_id INTEGER REFERENCES staff(id),
  selected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  notes TEXT,
  marking_enabled_at_selection INTEGER NOT NULL DEFAULT 0,
  total_possible_marks_at_selection REAL,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(assessment_program_id, checklist_id)
);
CREATE TABLE IF NOT EXISTS assessment_selected_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assessment_program_id INTEGER NOT NULL REFERENCES assessment_programs(id),
  checklist_id INTEGER NOT NULL REFERENCES assessment_checklists(id),
  section_id INTEGER REFERENCES assessment_checklist_sections(id),
  question_id INTEGER NOT NULL REFERENCES assessment_checklist_questions(id),
  included INTEGER NOT NULL DEFAULT 1,
  planned_for_review INTEGER NOT NULL DEFAULT 1,
  question_text_at_selection TEXT,
  section_title_at_selection TEXT,
  max_marks_at_selection REAL,
  weight_at_selection REAL,
  scoring_guidance_at_selection TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(assessment_program_id, question_id)
);
CREATE TABLE IF NOT EXISTS assessment_question_responses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assessment_program_id INTEGER NOT NULL REFERENCES assessment_programs(id),
  checklist_id INTEGER NOT NULL REFERENCES assessment_checklists(id),
  section_id INTEGER REFERENCES assessment_checklist_sections(id),
  question_id INTEGER NOT NULL REFERENCES assessment_checklist_questions(id),
  response TEXT NOT NULL,
  evidence_summary TEXT,
  finding_required INTEGER NOT NULL DEFAULT 0,
  finding_id INTEGER REFERENCES assessment_findings(id),
  marks_awarded REAL,
  max_marks_at_assessment REAL,
  score_comment TEXT,
  assessed_by_staff_id INTEGER REFERENCES staff(id),
  assessed_at TEXT,
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT,
  UNIQUE(assessment_program_id, question_id)
);
`);
}
