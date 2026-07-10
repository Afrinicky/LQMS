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

// Close the active SQLite connection and release the file handles so the
// on-disk database file can be safely overwritten (e.g. during a restore).
// The next getDb() call transparently reopens and re-migrates the database.
export function closeDb() {
  if (db) {
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
    } catch { /* checkpoint is best-effort */ }
    try {
      db.close();
    } catch { /* already closed */ }
    db = undefined;
  }
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
CREATE TABLE IF NOT EXISTS dennis_documents (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, module TEXT, document_type TEXT, source_record_id TEXT, version TEXT, status TEXT NOT NULL DEFAULT 'placeholder', file_path TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT);
CREATE TABLE IF NOT EXISTS dennis_document_chunks (id INTEGER PRIMARY KEY AUTOINCREMENT, document_id INTEGER NOT NULL REFERENCES dennis_documents(id), chunk_text TEXT NOT NULL, chunk_index INTEGER NOT NULL DEFAULT 0, page_number INTEGER, section_heading TEXT, embedding_id TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS dennis_conversations (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER REFERENCES users(id), title TEXT, mode TEXT NOT NULL DEFAULT 'offline-placeholder', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS dennis_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id INTEGER NOT NULL REFERENCES dennis_conversations(id), role TEXT NOT NULL, content TEXT NOT NULL, cited_sources TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS dennis_suggestions (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER REFERENCES users(id), module TEXT, source_record_id TEXT, suggestion_type TEXT, input_text TEXT, dennis_output TEXT NOT NULL, accepted INTEGER, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS dennis_activity_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER REFERENCES users(id), module TEXT NOT NULL, action TEXT NOT NULL, dennis_mode TEXT NOT NULL DEFAULT 'offline-placeholder', status TEXT NOT NULL DEFAULT 'draft', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS dennis_settings (id INTEGER PRIMARY KEY AUTOINCREMENT, setting_key TEXT NOT NULL UNIQUE, setting_value TEXT NOT NULL, updated_by INTEGER REFERENCES users(id), updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
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
  // Phase 2 upgrade: fuller equipment records (supplier, provenance, service dates, criticality)
  if (!equipmentNames.has('supplier_name')) database.exec('ALTER TABLE equipment_items ADD COLUMN supplier_name TEXT');
  if (!equipmentNames.has('supplier_location')) database.exec('ALTER TABLE equipment_items ADD COLUMN supplier_location TEXT');
  if (!equipmentNames.has('supplier_contact')) database.exec('ALTER TABLE equipment_items ADD COLUMN supplier_contact TEXT');
  if (!equipmentNames.has('country_of_origin')) database.exec('ALTER TABLE equipment_items ADD COLUMN country_of_origin TEXT');
  if (!equipmentNames.has('condition_received')) database.exec('ALTER TABLE equipment_items ADD COLUMN condition_received TEXT');
  if (!equipmentNames.has('date_out_of_service')) database.exec('ALTER TABLE equipment_items ADD COLUMN date_out_of_service TEXT');
  if (!equipmentNames.has('criticality')) database.exec('ALTER TABLE equipment_items ADD COLUMN criticality TEXT');

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
-- Equipment lifecycle: verification/validation, calibration and their editable
-- checklist question bank (Phase 3). No standard clause is hard-coded; the
-- question bank is seeded once with starter prompts the laboratory can edit.
CREATE TABLE IF NOT EXISTS equipment_checklist_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  checklist_type TEXT NOT NULL,            -- 'verification_validation' | 'calibration' (extensible)
  prompt TEXT NOT NULL,
  guidance TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS equipment_checklist_responses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  record_type TEXT NOT NULL,               -- 'verification' | 'calibration'
  record_id INTEGER NOT NULL,
  item_id INTEGER REFERENCES equipment_checklist_items(id),
  prompt TEXT NOT NULL,                     -- prompt snapshot so later edits don't rewrite history
  response TEXT,                            -- 'yes' | 'no' | 'na'
  notes TEXT,
  evidence_file_id INTEGER REFERENCES files(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS equipment_verifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  verification_number TEXT NOT NULL UNIQUE,
  equipment_id INTEGER NOT NULL REFERENCES equipment_items(id),
  verification_type TEXT NOT NULL DEFAULT 'verification',   -- verification | validation
  performed_by_staff_id INTEGER REFERENCES staff(id),
  performed_date TEXT NOT NULL,
  conclusion TEXT,
  outcome TEXT,                             -- pass | conditional | fail
  reviewed_by_staff_id INTEGER REFERENCES staff(id),
  reviewed_at TEXT,
  review_outcome TEXT,                      -- approved | rejected
  status TEXT NOT NULL DEFAULT 'completed', -- completed | reviewed
  evidence_file_id INTEGER REFERENCES files(id),
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS reference_standards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reference_number TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  standard_type TEXT,                       -- certified_reference_material | reference_instrument | other
  identifier TEXT,
  certificate_number TEXT,
  traceable_to TEXT,
  valid_from TEXT,
  valid_until TEXT,
  custodian_staff_id INTEGER REFERENCES staff(id),
  status TEXT NOT NULL DEFAULT 'active',
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS equipment_calibrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  calibration_number TEXT NOT NULL UNIQUE,
  equipment_id INTEGER NOT NULL REFERENCES equipment_items(id),
  calibration_date TEXT NOT NULL,
  calibration_mode TEXT,                    -- internal | external
  provider TEXT,
  certificate_number TEXT,
  traceability_reference TEXT,
  reference_standard_id INTEGER REFERENCES reference_standards(id),
  result TEXT,                              -- pass | fail | adjusted
  next_due_date TEXT,
  verified_before_use INTEGER,              -- for externally-calibrated items returned to use
  performed_by_staff_id INTEGER REFERENCES staff(id),
  reviewed_by_staff_id INTEGER REFERENCES staff(id),
  reviewed_at TEXT,
  review_outcome TEXT,                      -- accepted | rejected
  status TEXT NOT NULL DEFAULT 'completed', -- completed | reviewed
  evidence_file_id INTEGER REFERENCES files(id),
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
-- Equipment maintenance/servicing programme (Phase 4): each equipment can carry
-- one or more schedules that generate due/overdue states and roll forward when a
-- maintenance record is logged against them.
CREATE TABLE IF NOT EXISTS equipment_schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  equipment_id INTEGER NOT NULL REFERENCES equipment_items(id),
  schedule_type TEXT NOT NULL DEFAULT 'preventive_maintenance',  -- preventive_maintenance | servicing
  frequency TEXT NOT NULL,                 -- daily | weekly | monthly | quarterly | biannual | annual | custom
  interval_days INTEGER,                    -- used when frequency = custom
  provider_type TEXT,                       -- internal | external
  provider_name TEXT,
  responsible_staff_id INTEGER REFERENCES staff(id),
  section_id INTEGER REFERENCES sections(id),
  task_description TEXT,
  last_done_date TEXT,
  next_due_date TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
-- Equipment adverse events (Phase 5): reportable incidents with investigation,
-- corrective action, follow-up, retrospective impact and external reporting,
-- linked into the nonconforming events & CAPA module.
CREATE TABLE IF NOT EXISTS equipment_adverse_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  adverse_event_number TEXT NOT NULL UNIQUE,
  equipment_id INTEGER NOT NULL REFERENCES equipment_items(id),
  event_date TEXT NOT NULL,
  reported_by_staff_id INTEGER REFERENCES staff(id),
  event_type TEXT NOT NULL,
  severity TEXT,
  patient_harm TEXT,                        -- actual | potential | none
  description TEXT NOT NULL,
  immediate_action TEXT,
  investigation TEXT,
  investigated_by_staff_id INTEGER REFERENCES staff(id),
  investigation_date TEXT,
  corrective_action TEXT,
  follow_up TEXT,
  follow_up_date TEXT,
  retrospective_impact_required INTEGER NOT NULL DEFAULT 0,
  results_affected INTEGER NOT NULL DEFAULT 0,
  affected_period_from TEXT,
  affected_period_to TEXT,
  retrospective_impact_summary TEXT,
  reported_to_manufacturer INTEGER NOT NULL DEFAULT 0,
  reported_to_authority INTEGER NOT NULL DEFAULT 0,
  report_reference TEXT,
  report_date TEXT,
  nc_id INTEGER REFERENCES nonconforming_events(id),
  capa_id INTEGER REFERENCES capa_records(id),
  status TEXT NOT NULL DEFAULT 'open',       -- open | under_investigation | action_required | closed
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
-- Staff training & competence on a specific equipment (Phase 6). When competent
-- and authorised, this auto-populates the personnel competency assessment and
-- technical authorization records (linked by id below).
CREATE TABLE IF NOT EXISTS equipment_competencies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  equipment_id INTEGER NOT NULL REFERENCES equipment_items(id),
  staff_id INTEGER NOT NULL REFERENCES staff(id),
  training_date TEXT,
  trainer_staff_id INTEGER REFERENCES staff(id),
  assessment_method TEXT,
  assessment_date TEXT,
  assessor_staff_id INTEGER REFERENCES staff(id),
  outcome TEXT,                             -- competent | competent_with_supervision | not_yet_competent
  authorized INTEGER NOT NULL DEFAULT 0,
  authorization_level TEXT,
  competency_assessment_id INTEGER,
  technical_authorization_id INTEGER,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'recorded',
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
CREATE TABLE IF NOT EXISTS assessment_question_response_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  response_id INTEGER NOT NULL REFERENCES assessment_question_responses(id),
  assessment_program_id INTEGER NOT NULL,
  question_id INTEGER NOT NULL,
  response TEXT,
  evidence_summary TEXT,
  finding_required INTEGER,
  marks_awarded REAL,
  max_marks_at_assessment REAL,
  score_comment TEXT,
  notes TEXT,
  snapshot_by_staff_id INTEGER REFERENCES staff(id),
  snapshot_by_user_id INTEGER REFERENCES users(id),
  snapshot_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS customer_stakeholders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stakeholder_number TEXT NOT NULL UNIQUE,
  stakeholder_name TEXT NOT NULL,
  stakeholder_type TEXT NOT NULL,
  organisation TEXT,
  contact_person TEXT,
  email TEXT,
  phone TEXT,
  address TEXT,
  department_id INTEGER REFERENCES departments(id),
  section_id INTEGER REFERENCES sections(id),
  notes TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS service_agreements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agreement_number TEXT NOT NULL UNIQUE,
  stakeholder_id INTEGER NOT NULL REFERENCES customer_stakeholders(id),
  agreement_title TEXT NOT NULL,
  service_scope TEXT NOT NULL,
  start_date TEXT,
  end_date TEXT,
  review_due_date TEXT,
  responsible_staff_id INTEGER REFERENCES staff(id),
  agreed_turnaround TEXT,
  reporting_format TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  approved_by_staff_id INTEGER REFERENCES staff(id),
  approved_at TEXT,
  attached_file_id INTEGER REFERENCES files(id),
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS customer_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  feedback_number TEXT NOT NULL UNIQUE,
  feedback_date TEXT NOT NULL,
  feedback_type TEXT NOT NULL,
  source_channel TEXT,
  stakeholder_id INTEGER REFERENCES customer_stakeholders(id),
  contact_name TEXT,
  contact_detail TEXT,
  department_id INTEGER REFERENCES departments(id),
  section_id INTEGER REFERENCES sections(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  urgency TEXT,
  sentiment TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  assigned_to_staff_id INTEGER REFERENCES staff(id),
  acknowledgement_sent_at TEXT,
  follow_up_due_date TEXT,
  resolution_summary TEXT,
  complaint_id INTEGER REFERENCES complaints(id),
  nc_id INTEGER REFERENCES nonconforming_events(id),
  capa_id INTEGER REFERENCES capa_records(id),
  closed_by_staff_id INTEGER REFERENCES staff(id),
  closed_at TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS satisfaction_surveys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  survey_number TEXT NOT NULL UNIQUE,
  survey_title TEXT NOT NULL,
  survey_type TEXT NOT NULL,
  description TEXT,
  audience TEXT,
  period_start TEXT,
  period_end TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  approved_by_staff_id INTEGER REFERENCES staff(id),
  approved_at TEXT,
  closed_at TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS satisfaction_survey_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  survey_id INTEGER NOT NULL REFERENCES satisfaction_surveys(id),
  question_code TEXT,
  question_text TEXT NOT NULL,
  question_type TEXT NOT NULL,
  scale_min INTEGER,
  scale_max INTEGER,
  options_text TEXT,
  is_required INTEGER NOT NULL DEFAULT 0,
  display_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS satisfaction_survey_responses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  survey_id INTEGER NOT NULL REFERENCES satisfaction_surveys(id),
  response_date TEXT NOT NULL,
  source_channel TEXT,
  stakeholder_id INTEGER REFERENCES customer_stakeholders(id),
  respondent_name TEXT,
  respondent_role TEXT,
  notes TEXT,
  overall_comment TEXT,
  feedback_id INTEGER REFERENCES customer_feedback(id),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS satisfaction_survey_answer_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  response_id INTEGER NOT NULL REFERENCES satisfaction_survey_responses(id),
  question_id INTEGER NOT NULL REFERENCES satisfaction_survey_questions(id),
  answer_text TEXT,
  answer_number REAL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(response_id, question_id)
);
CREATE TABLE IF NOT EXISTS customer_communication_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  communication_number TEXT NOT NULL UNIQUE,
  communication_date TEXT NOT NULL,
  communication_type TEXT NOT NULL,
  direction TEXT NOT NULL DEFAULT 'outbound',
  channel TEXT,
  subject TEXT NOT NULL,
  message_summary TEXT NOT NULL,
  stakeholder_id INTEGER REFERENCES customer_stakeholders(id),
  feedback_id INTEGER REFERENCES customer_feedback(id),
  contact_name TEXT,
  contact_detail TEXT,
  staff_id INTEGER REFERENCES staff(id),
  attached_file_id INTEGER REFERENCES files(id),
  follow_up_due_date TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  closed_by_staff_id INTEGER REFERENCES staff(id),
  closed_at TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS customer_focus_import_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_number TEXT NOT NULL UNIQUE,
  import_type TEXT NOT NULL,
  source_file_id INTEGER REFERENCES files(id),
  original_filename TEXT,
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
CREATE TABLE IF NOT EXISTS customer_focus_import_rows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  import_batch_id INTEGER NOT NULL REFERENCES customer_focus_import_batches(id),
  row_number INTEGER,
  raw_json TEXT,
  mapped_target TEXT,
  mapped_target_id INTEGER,
  status TEXT NOT NULL DEFAULT 'unprocessed',
  exception_reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS poct_sites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_code TEXT,
  site_name TEXT NOT NULL,
  department_id INTEGER REFERENCES departments(id),
  section_id INTEGER REFERENCES sections(id),
  location_id INTEGER REFERENCES locations(id),
  service_area TEXT,
  responsible_staff_id INTEGER REFERENCES staff(id),
  contact_person TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS poct_devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_code TEXT,
  site_id INTEGER NOT NULL REFERENCES poct_sites(id),
  equipment_id INTEGER REFERENCES equipment_items(id),
  device_name TEXT NOT NULL,
  device_type TEXT NOT NULL,
  manufacturer TEXT,
  model TEXT,
  serial_number TEXT,
  test_menu_summary TEXT,
  installation_date TEXT,
  last_service_date TEXT,
  next_service_due TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS poct_tests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  test_code TEXT,
  test_name TEXT NOT NULL,
  sample_type TEXT,
  result_unit TEXT,
  method_summary TEXT,
  device_type TEXT,
  clinical_area TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS poct_operator_authorizations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  authorization_number TEXT,
  staff_id INTEGER NOT NULL REFERENCES staff(id),
  site_id INTEGER REFERENCES poct_sites(id),
  device_id INTEGER REFERENCES poct_devices(id),
  test_id INTEGER REFERENCES poct_tests(id),
  competency_assessment_id INTEGER REFERENCES competency_assessments(id),
  authorization_level TEXT NOT NULL,
  authorized_by_staff_id INTEGER REFERENCES staff(id),
  authorized_date TEXT,
  expiry_date TEXT,
  restrictions TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS poct_reagent_lots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lot_number TEXT NOT NULL,
  reagent_name TEXT NOT NULL,
  device_id INTEGER REFERENCES poct_devices(id),
  test_id INTEGER REFERENCES poct_tests(id),
  manufacturer TEXT,
  received_date TEXT,
  opened_date TEXT,
  expiry_date TEXT NOT NULL,
  storage_condition TEXT,
  inventory_batch_id INTEGER REFERENCES inventory_batches(id),
  status TEXT NOT NULL DEFAULT 'in_use',
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS poct_qc_materials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  material_code TEXT,
  material_name TEXT NOT NULL,
  device_id INTEGER REFERENCES poct_devices(id),
  test_id INTEGER REFERENCES poct_tests(id),
  lot_number TEXT,
  manufacturer TEXT,
  expiry_date TEXT,
  target_value REAL,
  acceptable_low REAL,
  acceptable_high REAL,
  iqc_material_id INTEGER REFERENCES iqc_materials(id),
  status TEXT NOT NULL DEFAULT 'active',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS poct_qc_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  qc_number TEXT NOT NULL UNIQUE,
  site_id INTEGER REFERENCES poct_sites(id),
  device_id INTEGER NOT NULL REFERENCES poct_devices(id),
  test_id INTEGER NOT NULL REFERENCES poct_tests(id),
  qc_material_id INTEGER REFERENCES poct_qc_materials(id),
  reagent_lot_id INTEGER REFERENCES poct_reagent_lots(id),
  qc_date TEXT NOT NULL,
  qc_time TEXT,
  result_value REAL,
  expected_result TEXT,
  interpretation TEXT,
  performed_by_staff_id INTEGER REFERENCES staff(id),
  reviewed_by_staff_id INTEGER REFERENCES staff(id),
  reviewed_at TEXT,
  immediate_action TEXT,
  nc_id INTEGER REFERENCES nonconforming_events(id),
  capa_id INTEGER REFERENCES capa_records(id),
  status TEXT NOT NULL DEFAULT 'pending_review',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS poct_eqa_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_number TEXT NOT NULL UNIQUE,
  site_id INTEGER REFERENCES poct_sites(id),
  device_id INTEGER REFERENCES poct_devices(id),
  test_id INTEGER NOT NULL REFERENCES poct_tests(id),
  eqa_program_id INTEGER REFERENCES eqa_programs(id),
  cycle_name TEXT NOT NULL,
  received_date TEXT,
  due_date TEXT,
  submitted_date TEXT,
  result_received_date TEXT,
  performance_status TEXT,
  findings TEXT,
  corrective_action_required INTEGER NOT NULL DEFAULT 0,
  responsible_staff_id INTEGER REFERENCES staff(id),
  nc_id INTEGER REFERENCES nonconforming_events(id),
  capa_id INTEGER REFERENCES capa_records(id),
  status TEXT NOT NULL DEFAULT 'open',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS poct_maintenance_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  maintenance_number TEXT NOT NULL UNIQUE,
  site_id INTEGER REFERENCES poct_sites(id),
  device_id INTEGER NOT NULL REFERENCES poct_devices(id),
  maintenance_date TEXT NOT NULL,
  maintenance_type TEXT NOT NULL,
  description TEXT,
  performed_by_staff_id INTEGER REFERENCES staff(id),
  outcome TEXT,
  next_due_date TEXT,
  evidence_file_id INTEGER REFERENCES files(id),
  status TEXT NOT NULL DEFAULT 'open',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS poct_incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_number TEXT NOT NULL UNIQUE,
  incident_date TEXT NOT NULL,
  site_id INTEGER REFERENCES poct_sites(id),
  device_id INTEGER REFERENCES poct_devices(id),
  test_id INTEGER REFERENCES poct_tests(id),
  reported_by_staff_id INTEGER REFERENCES staff(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  immediate_action TEXT,
  severity TEXT NOT NULL,
  outcome TEXT,
  nc_id INTEGER REFERENCES nonconforming_events(id),
  capa_id INTEGER REFERENCES capa_records(id),
  action_id INTEGER REFERENCES actions(id),
  status TEXT NOT NULL DEFAULT 'open',
  closed_by_staff_id INTEGER REFERENCES staff(id),
  closed_at TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS notification_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_code TEXT,
  rule_name TEXT NOT NULL,
  module_key TEXT NOT NULL,
  trigger_type TEXT NOT NULL,
  due_field TEXT,
  reminder_days_before INTEGER,
  escalation_days_after INTEGER,
  target_role_key TEXT,
  target_position_id INTEGER REFERENCES positions(id),
  target_staff_id INTEGER REFERENCES staff(id),
  is_active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS notification_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  notification_id INTEGER NOT NULL REFERENCES notifications(id),
  event_type TEXT NOT NULL,
  event_note TEXT,
  actor_staff_id INTEGER REFERENCES staff(id),
  actor_user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS review_calendar_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  calendar_number TEXT,
  module_key TEXT NOT NULL,
  record_type TEXT,
  record_id TEXT,
  title TEXT NOT NULL,
  description TEXT,
  due_date TEXT NOT NULL,
  item_type TEXT NOT NULL,
  responsible_staff_id INTEGER REFERENCES staff(id),
  responsible_position_id INTEGER REFERENCES positions(id),
  status TEXT NOT NULL DEFAULT 'pending',
  completed_at TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS user_task_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_number TEXT,
  title TEXT NOT NULL,
  description TEXT,
  module_key TEXT,
  record_type TEXT,
  record_id TEXT,
  assigned_to_staff_id INTEGER REFERENCES staff(id),
  assigned_to_user_id INTEGER REFERENCES users(id),
  priority TEXT NOT NULL DEFAULT 'normal',
  due_date TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  completed_at TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS notification_preferences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  staff_id INTEGER REFERENCES staff(id),
  module_key TEXT,
  in_app_enabled INTEGER NOT NULL DEFAULT 1,
  digest_enabled INTEGER NOT NULL DEFAULT 0,
  email_enabled INTEGER NOT NULL DEFAULT 0,
  sms_enabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT,
  UNIQUE(user_id, module_key)
);
CREATE TABLE IF NOT EXISTS poct_monthly_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  review_number TEXT NOT NULL UNIQUE,
  review_month INTEGER NOT NULL,
  review_year INTEGER NOT NULL,
  site_id INTEGER REFERENCES poct_sites(id),
  summary TEXT,
  qc_summary TEXT,
  eqa_summary TEXT,
  operator_authorization_summary TEXT,
  device_issue_summary TEXT,
  incidents_summary TEXT,
  actions_required TEXT,
  reviewed_by_staff_id INTEGER REFERENCES staff(id),
  reviewed_at TEXT,
  approved_by_staff_id INTEGER REFERENCES staff(id),
  approved_at TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
`);

  const notificationColumns = database.prepare("PRAGMA table_info(notifications)").all() as Array<{ name: string }>;
  const notificationNames = new Set(notificationColumns.map(c => c.name));
  if (!notificationNames.has('notification_number')) database.exec('ALTER TABLE notifications ADD COLUMN notification_number TEXT');
  if (!notificationNames.has('record_type')) database.exec('ALTER TABLE notifications ADD COLUMN record_type TEXT');
  if (!notificationNames.has('record_id')) database.exec('ALTER TABLE notifications ADD COLUMN record_id TEXT');
  if (!notificationNames.has('severity')) database.exec("ALTER TABLE notifications ADD COLUMN severity TEXT NOT NULL DEFAULT 'info'");
  if (!notificationNames.has('notification_type')) database.exec("ALTER TABLE notifications ADD COLUMN notification_type TEXT NOT NULL DEFAULT 'system_notice'");
  if (!notificationNames.has('due_date')) database.exec('ALTER TABLE notifications ADD COLUMN due_date TEXT');
  if (!notificationNames.has('assigned_to_staff_id')) database.exec('ALTER TABLE notifications ADD COLUMN assigned_to_staff_id INTEGER REFERENCES staff(id)');
  if (!notificationNames.has('assigned_to_user_id')) database.exec('ALTER TABLE notifications ADD COLUMN assigned_to_user_id INTEGER REFERENCES users(id)');
  if (!notificationNames.has('source_rule_id')) database.exec('ALTER TABLE notifications ADD COLUMN source_rule_id INTEGER REFERENCES notification_rules(id)');
  if (!notificationNames.has('acknowledged_by_staff_id')) database.exec('ALTER TABLE notifications ADD COLUMN acknowledged_by_staff_id INTEGER REFERENCES staff(id)');
  if (!notificationNames.has('acknowledged_at')) database.exec('ALTER TABLE notifications ADD COLUMN acknowledged_at TEXT');
  if (!notificationNames.has('resolved_by_staff_id')) database.exec('ALTER TABLE notifications ADD COLUMN resolved_by_staff_id INTEGER REFERENCES staff(id)');
  if (!notificationNames.has('resolved_at')) database.exec('ALTER TABLE notifications ADD COLUMN resolved_at TEXT');
  if (!notificationNames.has('created_by')) database.exec('ALTER TABLE notifications ADD COLUMN created_by INTEGER REFERENCES users(id)');
  if (!notificationNames.has('updated_at')) database.exec('ALTER TABLE notifications ADD COLUMN updated_at TEXT');

  database.exec(`
CREATE TABLE IF NOT EXISTS report_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  template_code TEXT,
  template_name TEXT NOT NULL,
  template_type TEXT NOT NULL,
  module_key TEXT,
  description TEXT,
  output_format TEXT NOT NULL DEFAULT 'html',
  template_config_json TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS report_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_number TEXT NOT NULL UNIQUE,
  report_template_id INTEGER REFERENCES report_templates(id),
  report_title TEXT NOT NULL,
  module_key TEXT NOT NULL,
  date_from TEXT,
  date_to TEXT,
  requested_by_staff_id INTEGER REFERENCES staff(id),
  status TEXT NOT NULL DEFAULT 'draft',
  filter_json TEXT,
  summary TEXT,
  generated_file_id INTEGER REFERENCES files(id),
  reviewed_by_staff_id INTEGER REFERENCES staff(id),
  reviewed_at TEXT,
  approved_by_staff_id INTEGER REFERENCES staff(id),
  approved_at TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS report_exports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  export_number TEXT NOT NULL UNIQUE,
  report_request_id INTEGER NOT NULL REFERENCES report_requests(id),
  export_format TEXT NOT NULL,
  file_id INTEGER REFERENCES files(id),
  exported_by_staff_id INTEGER REFERENCES staff(id),
  exported_at TEXT,
  status TEXT NOT NULL DEFAULT 'completed',
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS print_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  print_number TEXT NOT NULL UNIQUE,
  module_key TEXT,
  record_type TEXT,
  record_id TEXT,
  print_title TEXT NOT NULL,
  print_purpose TEXT NOT NULL,
  printed_by_staff_id INTEGER REFERENCES staff(id),
  printed_at TEXT,
  controlled_copy INTEGER NOT NULL DEFAULT 0,
  copy_number TEXT,
  watermark TEXT,
  status TEXT NOT NULL DEFAULT 'logged',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS evidence_packs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pack_number TEXT NOT NULL UNIQUE,
  pack_title TEXT NOT NULL,
  pack_purpose TEXT NOT NULL,
  date_from TEXT,
  date_to TEXT,
  prepared_by_staff_id INTEGER REFERENCES staff(id),
  reviewed_by_staff_id INTEGER REFERENCES staff(id),
  reviewed_at TEXT,
  approved_by_staff_id INTEGER REFERENCES staff(id),
  approved_at TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  notes TEXT,
  generated_file_id INTEGER REFERENCES files(id),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS evidence_pack_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  evidence_pack_id INTEGER NOT NULL REFERENCES evidence_packs(id),
  module_key TEXT NOT NULL,
  record_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  item_title TEXT NOT NULL,
  item_summary TEXT,
  file_id INTEGER REFERENCES files(id),
  display_order INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS record_retention_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_code TEXT,
  rule_name TEXT NOT NULL,
  module_key TEXT NOT NULL,
  record_type TEXT NOT NULL,
  retention_period_months INTEGER NOT NULL,
  archive_action TEXT NOT NULL DEFAULT 'flag_for_review',
  is_active INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS record_retention_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  review_number TEXT NOT NULL UNIQUE,
  review_date TEXT NOT NULL,
  module_key TEXT,
  record_type TEXT,
  records_reviewed INTEGER NOT NULL DEFAULT 0,
  records_due_for_archive INTEGER NOT NULL DEFAULT 0,
  records_archived INTEGER NOT NULL DEFAULT 0,
  reviewed_by_staff_id INTEGER REFERENCES staff(id),
  status TEXT NOT NULL DEFAULT 'draft',
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS audit_trail_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  review_number TEXT NOT NULL UNIQUE,
  review_date TEXT NOT NULL,
  date_from TEXT NOT NULL,
  date_to TEXT NOT NULL,
  module_key TEXT,
  reviewed_by_staff_id INTEGER REFERENCES staff(id),
  unusual_activity_noted INTEGER NOT NULL DEFAULT 0,
  findings_summary TEXT,
  action_required INTEGER NOT NULL DEFAULT 0,
  action_id INTEGER REFERENCES actions(id),
  status TEXT NOT NULL DEFAULT 'draft',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS backup_restore_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  check_number TEXT NOT NULL UNIQUE,
  check_date TEXT NOT NULL,
  check_type TEXT NOT NULL,
  backup_location TEXT,
  backup_file_name TEXT,
  backup_status TEXT,
  restore_test_status TEXT,
  checked_by_staff_id INTEGER REFERENCES staff(id),
  findings TEXT,
  action_required INTEGER NOT NULL DEFAULT 0,
  action_id INTEGER REFERENCES actions(id),
  status TEXT NOT NULL DEFAULT 'draft',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS data_integrity_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  check_number TEXT NOT NULL UNIQUE,
  check_date TEXT NOT NULL,
  check_type TEXT NOT NULL,
  module_key TEXT,
  records_checked INTEGER NOT NULL DEFAULT 0,
  issues_found INTEGER NOT NULL DEFAULT 0,
  findings_summary TEXT,
  action_required INTEGER NOT NULL DEFAULT 0,
  action_id INTEGER REFERENCES actions(id),
  status TEXT NOT NULL DEFAULT 'draft',
  checked_by_staff_id INTEGER REFERENCES staff(id),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS lab_test_catalog (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  test_code TEXT UNIQUE,
  test_name TEXT NOT NULL,
  department_id INTEGER REFERENCES departments(id),
  section_id INTEGER REFERENCES sections(id),
  sample_type TEXT,
  container_type TEXT,
  minimum_volume TEXT,
  method_name TEXT,
  method_summary TEXT,
  equipment_id INTEGER REFERENCES equipment_items(id),
  tat_target_minutes INTEGER,
  reportable_range TEXT,
  reference_interval_summary TEXT,
  critical_result_applicable INTEGER NOT NULL DEFAULT 0,
  document_id INTEGER REFERENCES documents(id),
  status TEXT NOT NULL DEFAULT 'active',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS specimen_acceptance_criteria (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  criteria_code TEXT,
  test_catalog_id INTEGER REFERENCES lab_test_catalog(id),
  sample_type TEXT NOT NULL,
  container_type TEXT,
  acceptance_criteria TEXT NOT NULL,
  rejection_criteria TEXT,
  transport_condition TEXT,
  stability_summary TEXT,
  document_id INTEGER REFERENCES documents(id),
  is_active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS specimen_rejection_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rejection_number TEXT NOT NULL UNIQUE,
  rejection_date TEXT NOT NULL,
  request_reference TEXT,
  patient_reference TEXT,
  patient_type TEXT,
  department_id INTEGER REFERENCES departments(id),
  section_id INTEGER REFERENCES sections(id),
  test_catalog_id INTEGER REFERENCES lab_test_catalog(id),
  test_name TEXT,
  sample_type TEXT,
  rejection_reason TEXT NOT NULL,
  rejected_by_staff_id INTEGER REFERENCES staff(id),
  communicated_to TEXT,
  communication_date TEXT,
  immediate_action TEXT,
  repeat_sample_requested INTEGER NOT NULL DEFAULT 0,
  linked_nc_id INTEGER REFERENCES nonconforming_events(id),
  linked_action_id INTEGER REFERENCES actions(id),
  status TEXT NOT NULL DEFAULT 'open',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS critical_result_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_code TEXT,
  test_catalog_id INTEGER REFERENCES lab_test_catalog(id),
  analyte_name TEXT NOT NULL,
  unit TEXT,
  low_critical_value REAL,
  high_critical_value REAL,
  notification_timeframe_minutes INTEGER,
  escalation_instruction TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS critical_result_notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  notification_number TEXT NOT NULL UNIQUE,
  event_date TEXT NOT NULL,
  event_time TEXT NOT NULL,
  request_reference TEXT,
  patient_reference TEXT,
  patient_type TEXT,
  department_id INTEGER REFERENCES departments(id),
  section_id INTEGER REFERENCES sections(id),
  test_catalog_id INTEGER REFERENCES lab_test_catalog(id),
  analyte_name TEXT NOT NULL,
  result_value TEXT NOT NULL,
  unit TEXT,
  critical_rule_id INTEGER REFERENCES critical_result_rules(id),
  notified_to TEXT,
  notification_method TEXT,
  notified_by_staff_id INTEGER REFERENCES staff(id),
  notification_time TEXT,
  read_back_confirmed INTEGER NOT NULL DEFAULT 0,
  acknowledgement_status TEXT NOT NULL DEFAULT 'pending',
  escalation_required INTEGER NOT NULL DEFAULT 0,
  escalation_notes TEXT,
  linked_nc_id INTEGER REFERENCES nonconforming_events(id),
  linked_action_id INTEGER REFERENCES actions(id),
  status TEXT NOT NULL DEFAULT 'pending_notification',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS referral_laboratories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  referral_lab_code TEXT,
  referral_lab_name TEXT NOT NULL,
  contact_person TEXT,
  phone TEXT,
  email TEXT,
  address TEXT,
  service_scope TEXT,
  accreditation_or_approval_note TEXT,
  agreement_document_id INTEGER REFERENCES documents(id),
  status TEXT NOT NULL DEFAULT 'active',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS referral_tests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  referral_lab_id INTEGER NOT NULL REFERENCES referral_laboratories(id),
  test_catalog_id INTEGER REFERENCES lab_test_catalog(id),
  referral_test_name TEXT NOT NULL,
  sample_requirement TEXT,
  expected_tat_days INTEGER,
  transport_condition TEXT,
  cost_note TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS referral_sendouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sendout_number TEXT NOT NULL UNIQUE,
  sendout_date TEXT NOT NULL,
  referral_lab_id INTEGER NOT NULL REFERENCES referral_laboratories(id),
  referral_test_id INTEGER REFERENCES referral_tests(id),
  request_reference TEXT,
  patient_reference TEXT,
  patient_type TEXT,
  sample_type TEXT,
  courier_or_transport TEXT,
  expected_return_date TEXT,
  result_received_date TEXT,
  result_summary TEXT,
  issue_noted TEXT,
  linked_nc_id INTEGER REFERENCES nonconforming_events(id),
  linked_action_id INTEGER REFERENCES actions(id),
  status TEXT NOT NULL DEFAULT 'sent',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS report_amendment_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  amendment_number TEXT NOT NULL UNIQUE,
  amendment_date TEXT NOT NULL,
  request_reference TEXT,
  patient_reference TEXT,
  patient_type TEXT,
  department_id INTEGER REFERENCES departments(id),
  section_id INTEGER REFERENCES sections(id),
  test_catalog_id INTEGER REFERENCES lab_test_catalog(id),
  reason_for_amendment TEXT NOT NULL,
  original_report_summary TEXT,
  amended_report_summary TEXT,
  authorized_by_staff_id INTEGER REFERENCES staff(id),
  communicated_to TEXT,
  communication_date TEXT,
  linked_nc_id INTEGER REFERENCES nonconforming_events(id),
  linked_action_id INTEGER REFERENCES actions(id),
  status TEXT NOT NULL DEFAULT 'draft',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS process_review_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  review_number TEXT NOT NULL UNIQUE,
  review_period_start TEXT NOT NULL,
  review_period_end TEXT NOT NULL,
  department_id INTEGER REFERENCES departments(id),
  section_id INTEGER REFERENCES sections(id),
  rejection_summary TEXT,
  critical_result_summary TEXT,
  referral_testing_summary TEXT,
  report_amendment_summary TEXT,
  tat_summary TEXT,
  issues_identified TEXT,
  actions_required TEXT,
  reviewed_by_staff_id INTEGER REFERENCES staff(id),
  approved_by_staff_id INTEGER REFERENCES staff(id),
  approved_at TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS information_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_code TEXT,
  asset_name TEXT NOT NULL,
  asset_type TEXT NOT NULL,
  owner_staff_id INTEGER REFERENCES staff(id),
  department_id INTEGER REFERENCES departments(id),
  section_id INTEGER REFERENCES sections(id),
  description TEXT,
  data_category TEXT,
  confidentiality_level TEXT,
  storage_location TEXT,
  backup_method TEXT,
  retention_rule_id INTEGER REFERENCES record_retention_rules(id),
  status TEXT NOT NULL DEFAULT 'active',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS information_systems (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  system_code TEXT,
  system_name TEXT NOT NULL,
  system_type TEXT NOT NULL,
  vendor_or_owner TEXT,
  purpose TEXT,
  data_handled TEXT,
  hosting_location TEXT,
  access_method TEXT,
  backup_responsibility TEXT,
  support_contact TEXT,
  criticality TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS system_access_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  review_number TEXT NOT NULL UNIQUE,
  system_id INTEGER NOT NULL REFERENCES information_systems(id),
  review_date TEXT NOT NULL,
  review_period_start TEXT,
  review_period_end TEXT,
  reviewed_by_staff_id INTEGER REFERENCES staff(id),
  users_reviewed INTEGER NOT NULL DEFAULT 0,
  access_issues_found INTEGER NOT NULL DEFAULT 0,
  inactive_accounts_found INTEGER NOT NULL DEFAULT 0,
  excessive_access_found INTEGER NOT NULL DEFAULT 0,
  actions_required TEXT,
  linked_action_id INTEGER REFERENCES actions(id),
  status TEXT NOT NULL DEFAULT 'draft',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS system_access_review_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  access_review_id INTEGER NOT NULL REFERENCES system_access_reviews(id),
  staff_id INTEGER REFERENCES staff(id),
  user_id INTEGER REFERENCES users(id),
  system_role TEXT,
  access_status TEXT,
  review_decision TEXT,
  review_notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS information_security_incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_number TEXT NOT NULL UNIQUE,
  incident_date TEXT NOT NULL,
  incident_type TEXT NOT NULL,
  system_id INTEGER REFERENCES information_systems(id),
  asset_id INTEGER REFERENCES information_assets(id),
  reported_by_staff_id INTEGER REFERENCES staff(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  immediate_action TEXT,
  severity TEXT NOT NULL DEFAULT 'medium',
  confidentiality_impact TEXT,
  data_loss_suspected INTEGER NOT NULL DEFAULT 0,
  investigation_summary TEXT,
  linked_nc_id INTEGER REFERENCES nonconforming_events(id),
  linked_capa_id INTEGER REFERENCES capa_records(id),
  linked_action_id INTEGER REFERENCES actions(id),
  status TEXT NOT NULL DEFAULT 'open',
  closed_by_staff_id INTEGER REFERENCES staff(id),
  closed_at TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS data_correction_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_number TEXT NOT NULL UNIQUE,
  request_date TEXT NOT NULL,
  system_id INTEGER REFERENCES information_systems(id),
  module_key TEXT,
  record_type TEXT,
  record_reference TEXT,
  requested_by_staff_id INTEGER REFERENCES staff(id),
  correction_reason TEXT NOT NULL,
  original_value_summary TEXT,
  requested_correction_summary TEXT NOT NULL,
  reviewed_by_staff_id INTEGER REFERENCES staff(id),
  approved_by_staff_id INTEGER REFERENCES staff(id),
  approved_at TEXT,
  correction_completed_at TEXT,
  linked_action_id INTEGER REFERENCES actions(id),
  status TEXT NOT NULL DEFAULT 'submitted',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS system_change_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  change_number TEXT NOT NULL UNIQUE,
  request_date TEXT NOT NULL,
  system_id INTEGER REFERENCES information_systems(id),
  change_type TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  reason TEXT NOT NULL,
  risk_level TEXT,
  requested_by_staff_id INTEGER REFERENCES staff(id),
  reviewed_by_staff_id INTEGER REFERENCES staff(id),
  approved_by_staff_id INTEGER REFERENCES staff(id),
  approved_at TEXT,
  implementation_date TEXT,
  validation_required INTEGER NOT NULL DEFAULT 0,
  validation_summary TEXT,
  rollback_plan TEXT,
  linked_action_id INTEGER REFERENCES actions(id),
  status TEXT NOT NULL DEFAULT 'submitted',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS software_release_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  release_number TEXT NOT NULL UNIQUE,
  system_id INTEGER NOT NULL REFERENCES information_systems(id),
  version_label TEXT NOT NULL,
  release_date TEXT NOT NULL,
  release_summary TEXT,
  changes_included TEXT,
  testing_summary TEXT,
  approved_by_staff_id INTEGER REFERENCES staff(id),
  deployed_by_staff_id INTEGER REFERENCES staff(id),
  deployment_notes TEXT,
  status TEXT NOT NULL DEFAULT 'planned',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS system_validation_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  validation_number TEXT NOT NULL UNIQUE,
  system_id INTEGER NOT NULL REFERENCES information_systems(id),
  validation_date TEXT NOT NULL,
  validation_type TEXT NOT NULL,
  scope TEXT,
  test_summary TEXT,
  deviations_found TEXT,
  outcome TEXT,
  approved_by_staff_id INTEGER REFERENCES staff(id),
  evidence_file_id INTEGER REFERENCES files(id),
  status TEXT NOT NULL DEFAULT 'planned',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS system_downtime_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  downtime_number TEXT NOT NULL UNIQUE,
  system_id INTEGER NOT NULL REFERENCES information_systems(id),
  downtime_start TEXT NOT NULL,
  downtime_end TEXT,
  duration_minutes INTEGER,
  downtime_type TEXT,
  affected_services TEXT NOT NULL,
  impact_summary TEXT,
  workaround_used TEXT,
  reported_by_staff_id INTEGER REFERENCES staff(id),
  resolved_by_staff_id INTEGER REFERENCES staff(id),
  linked_action_id INTEGER REFERENCES actions(id),
  linked_nc_id INTEGER REFERENCES nonconforming_events(id),
  status TEXT NOT NULL DEFAULT 'open',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS information_management_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  review_number TEXT NOT NULL UNIQUE,
  review_period_start TEXT NOT NULL,
  review_period_end TEXT NOT NULL,
  review_date TEXT NOT NULL,
  information_assets_summary TEXT,
  access_review_summary TEXT,
  security_incident_summary TEXT,
  change_request_summary TEXT,
  downtime_summary TEXT,
  validation_summary TEXT,
  data_integrity_summary TEXT,
  issues_identified TEXT,
  actions_required TEXT,
  reviewed_by_staff_id INTEGER REFERENCES staff(id),
  approved_by_staff_id INTEGER REFERENCES staff(id),
  approved_at TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
`);

  // Section/Unit Configuration: extend sections with a profile and add a per-unit
  // service catalogue. The unit's test menu, equipment and inventory reuse the
  // existing section-scoped tables (lab_test_catalog, equipment_items,
  // inventory_items) so configuration here stays interconnected with the
  // Process Management, Equipment and Supplier & Inventory modules.
  const sectionColumns = database.prepare("PRAGMA table_info(sections)").all() as Array<{ name: string }>;
  const sectionNames = new Set(sectionColumns.map(col => col.name));
  if (!sectionNames.has('code')) database.exec('ALTER TABLE sections ADD COLUMN code TEXT');
  if (!sectionNames.has('description')) database.exec('ALTER TABLE sections ADD COLUMN description TEXT');
  if (!sectionNames.has('service_summary')) database.exec('ALTER TABLE sections ADD COLUMN service_summary TEXT');
  if (!sectionNames.has('operating_hours')) database.exec('ALTER TABLE sections ADD COLUMN operating_hours TEXT');
  if (!sectionNames.has('head_staff_id')) database.exec('ALTER TABLE sections ADD COLUMN head_staff_id INTEGER REFERENCES staff(id)');

  database.exec(`
CREATE TABLE IF NOT EXISTS section_services (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  section_id INTEGER NOT NULL REFERENCES sections(id),
  name TEXT NOT NULL,
  category TEXT,
  is_offered INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
`);

  // People & Access: structured staff name parts (used by the staff Excel
  // import/export) alongside the canonical full_name.
  const staffColumns = database.prepare("PRAGMA table_info(staff)").all() as Array<{ name: string }>;
  const staffColNames = new Set(staffColumns.map(col => col.name));
  if (!staffColNames.has('first_name')) database.exec('ALTER TABLE staff ADD COLUMN first_name TEXT');
  if (!staffColNames.has('surname')) database.exec('ALTER TABLE staff ADD COLUMN surname TEXT');
  if (!staffColNames.has('other_names')) database.exec('ALTER TABLE staff ADD COLUMN other_names TEXT');

  // Master Personnel Register fields (identity, HR):
  // professional registration, qualifications, appointment and contact details.
  const addStaffCol = (name: string, ddl: string) => { if (!staffColNames.has(name)) database.exec(`ALTER TABLE staff ADD COLUMN ${ddl}`); };
  addStaffCol('middle_name', 'middle_name TEXT');
  addStaffCol('initials', 'initials TEXT');
  addStaffCol('date_of_birth', 'date_of_birth TEXT');
  addStaffCol('gender', 'gender TEXT');
  addStaffCol('designation', 'designation TEXT');
  addStaffCol('job_title', 'job_title TEXT');
  addStaffCol('professional_regulator', 'professional_regulator TEXT');
  addStaffCol('professional_licence', 'professional_licence TEXT');
  addStaffCol('licence_expiry_date', 'licence_expiry_date TEXT');
  addStaffCol('qualifications', 'qualifications TEXT');
  addStaffCol('unit', 'unit TEXT');
  addStaffCol('personnel_category', 'personnel_category TEXT');
  addStaffCol('appointment_type', 'appointment_type TEXT');
  addStaffCol('appointment_date', 'appointment_date TEXT');
  addStaffCol('national_id_type', 'national_id_type TEXT');
  addStaffCol('national_id_number', 'national_id_number TEXT');
  addStaffCol('emergency_contact', 'emergency_contact TEXT');
  addStaffCol('staff_file_location', 'staff_file_location TEXT');
  // Cadre, professional rank and availability drive the automatic unit hierarchy
  // and acting/succession logic on the organogram (below each Unit Head).
  addStaffCol('cadre', 'cadre TEXT');                       // Scientist / Technician / Assistant
  addStaffCol('professional_rank', 'professional_rank TEXT');
  addStaffCol('availability_status', "availability_status TEXT NOT NULL DEFAULT 'available'");

  // Configurable professional rank order (lower sort_order = higher rank). The
  // automatic hierarchy within a cadre is ordered by this table.
  database.exec(`CREATE TABLE IF NOT EXISTS professional_ranks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    sort_order INTEGER NOT NULL DEFAULT 100,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );`);
  if ((database.prepare('SELECT COUNT(*) c FROM professional_ranks').get() as { c: number }).c === 0) {
    const seed = database.prepare('INSERT OR IGNORE INTO professional_ranks (name, sort_order) VALUES (?, ?)');
    // Highest grade first; keyword-matched against a staff member's designation
    // when no explicit professional rank is set.
    [
      ['Chief', 10], ['Deputy Chief', 20], ['Principal', 30], ['Senior', 40],
      ['Medical Laboratory Scientist', 50], ['Medical Laboratory Technician', 60],
      ['Senior Technician', 45], ['Technician', 60], ['Laboratory Assistant', 70], ['Intern', 80],
    ].forEach(([n, o]) => seed.run(n, o));
  }

  // Structured ethics confirmations on staff_declarations.
  const declColNames = new Set((database.prepare("PRAGMA table_info(staff_declarations)").all() as Array<{ name: string }>).map(c => c.name));
  const addDeclCol = (name: string, ddl: string) => { if (!declColNames.has(name)) database.exec(`ALTER TABLE staff_declarations ADD COLUMN ${ddl}`); };
  addDeclCol('impartiality_confirmed', 'impartiality_confirmed INTEGER');
  addDeclCol('confidentiality_confirmed', 'confidentiality_confirmed INTEGER');
  addDeclCol('conflict_of_interest', 'conflict_of_interest TEXT');
  addDeclCol('code_of_conduct_ack', 'code_of_conduct_ack INTEGER');
  addDeclCol('form_completed_date', 'form_completed_date TEXT');
  addDeclCol('reviewed_by_staff_id', 'reviewed_by_staff_id INTEGER REFERENCES staff(id)');
  addDeclCol('review_date', 'review_date TEXT');
  addDeclCol('next_review_date', 'next_review_date TEXT');

  // Orientation / induction tracking.
  database.exec(`
CREATE TABLE IF NOT EXISTS staff_orientations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id INTEGER NOT NULL REFERENCES staff(id),
  hire_date TEXT,
  orientation_start TEXT,
  orientation_complete INTEGER NOT NULL DEFAULT 0,
  welcome_orientation TEXT NOT NULL DEFAULT 'pending',
  safety_training TEXT NOT NULL DEFAULT 'pending',
  ethics_training TEXT NOT NULL DEFAULT 'pending',
  lis_training TEXT NOT NULL DEFAULT 'pending',
  equipment_training TEXT NOT NULL DEFAULT 'pending',
  sop_review TEXT NOT NULL DEFAULT 'pending',
  competency_baseline TEXT NOT NULL DEFAULT 'pending',
  department_induction TEXT NOT NULL DEFAULT 'pending',
  form_completed_date TEXT,
  facilitator_staff_id INTEGER REFERENCES staff(id),
  staff_sign_off TEXT,
  facilitator_sign_off TEXT,
  status TEXT NOT NULL DEFAULT 'in_progress',
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_staff_orientations_staff ON staff_orientations(staff_id);
`);

  // My Laboratory: extend the single-row laboratory_profile with identity and
  // accreditation fields so each laboratory can fully configure its own details.
  const labColumns = database.prepare("PRAGMA table_info(laboratory_profile)").all() as Array<{ name: string }>;
  const labColNames = new Set(labColumns.map(col => col.name));
  for (const [col, type] of [
    ['address', 'TEXT'], ['city', 'TEXT'], ['country', 'TEXT'], ['phone', 'TEXT'], ['email', 'TEXT'],
    ['website', 'TEXT'], ['registration_number', 'TEXT'], ['accreditation_body', 'TEXT'],
    ['accreditation_number', 'TEXT'], ['accreditation_status', 'TEXT'], ['motto', 'TEXT'], ['logo_file_id', 'INTEGER'],
    // Legal identity narrative and quality-policy/manual summaries live on the
    // singleton profile; supporting documents and granular policies/objectives
    // live in the dedicated tables below.
    ['legal_status', 'TEXT'], ['legal_identity_notes', 'TEXT'],
    ['quality_policy', 'TEXT'], ['quality_manual_summary', 'TEXT'],
    ['mission', 'TEXT'], ['vision', 'TEXT'],
    // Set to 1 once the laboratory has been fully registered from My Laboratory,
    // which retires the first-run "register your laboratory" prompt.
    ['registration_complete', 'INTEGER NOT NULL DEFAULT 0'],
  ] as const) {
    if (!labColNames.has(col)) database.exec(`ALTER TABLE laboratory_profile ADD COLUMN ${col} ${type}`);
  }

  // My Laboratory: supporting documents (legal identity + quality manual),
  // quality policies, and quality objectives (standing + annual). Editable only
  // from Settings → My Laboratory; surfaced read-only elsewhere.
  database.exec(`
CREATE TABLE IF NOT EXISTS laboratory_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,            -- 'legal_identity' | 'quality_manual'
  doc_type TEXT,                     -- e.g. operating licence, incorporation, tax, quality manual
  title TEXT NOT NULL,
  file_id INTEGER REFERENCES files(id),
  reference_number TEXT,
  issuing_authority TEXT,
  issue_date TEXT,
  expiry_date TEXT,
  version TEXT,
  effective_date TEXT,
  notes TEXT,
  -- When a core document (quality manual / handbook / safety manual) is
  -- uploaded, it is auto-registered as a controlled document; this links back.
  linked_document_id INTEGER REFERENCES documents(id),
  uploaded_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS quality_policies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  policy_statement TEXT NOT NULL,
  reference_note TEXT,               -- lab-entered ISO 15189:2022 relationship
  display_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS quality_objectives (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  objective TEXT NOT NULL,
  target TEXT,
  measure TEXT,
  year INTEGER,                      -- NULL = standing objective; a year = annual objective
  responsible_staff_id INTEGER REFERENCES staff(id),
  status TEXT NOT NULL DEFAULT 'active',
  review_notes TEXT,
  reference_note TEXT,               -- lab-entered ISO 15189:2022 relationship
  display_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_laboratory_documents_category ON laboratory_documents(category);
CREATE INDEX IF NOT EXISTS idx_quality_objectives_year ON quality_objectives(year);
`);
  // laboratory_documents may pre-date the linked_document_id column on upgraded installs.
  const labDocCols = new Set((database.prepare("PRAGMA table_info(laboratory_documents)").all() as Array<{ name: string }>).map(c => c.name));
  if (!labDocCols.has('linked_document_id')) database.exec('ALTER TABLE laboratory_documents ADD COLUMN linked_document_id INTEGER REFERENCES documents(id)');

  // ===================================================================
  // Environmental Monitoring — manual + automated real-time monitoring.
  // Assets are monitored locations/equipment; devices are the sensors/loggers
  // (each bound to a communication driver); readings flow from manual entry or
  // automated polling and are evaluated into alerts, excursions and auto-NCs.
  // Floor-plan coordinates and a config_json/driver_key give room to grow
  // (floor plan overlay, new protocols, new parameters) without refactoring.
  // -------------------------------------------------------------------
  database.exec(`
CREATE TABLE IF NOT EXISTS environmental_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  asset_type TEXT,
  department_id INTEGER REFERENCES departments(id),
  section_id INTEGER REFERENCES sections(id),
  location_id INTEGER REFERENCES locations(id),
  responsible_section_id INTEGER REFERENCES sections(id),
  responsible_staff_id INTEGER REFERENCES staff(id),
  equipment_id INTEGER REFERENCES equipment_items(id),
  temp_min REAL, temp_max REAL,
  humidity_min REAL, humidity_max REAL,
  monitoring_frequency TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  is_active INTEGER NOT NULL DEFAULT 1,
  installation_date TEXT,
  calibration_due_date TEXT,
  device_id INTEGER,
  floor_plan_x REAL, floor_plan_y REAL,
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS environmental_devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  manufacturer TEXT, model TEXT, serial_number TEXT,
  device_type TEXT,
  communication_method TEXT NOT NULL DEFAULT 'manual',
  driver_key TEXT NOT NULL DEFAULT 'manual',
  firmware_version TEXT,
  calibration_status TEXT,
  calibration_certificate_file_id INTEGER REFERENCES files(id),
  calibration_due_date TEXT,
  battery_status TEXT,
  battery_level REAL,
  signal_strength REAL,
  last_communication_at TEXT,
  location_id INTEGER REFERENCES locations(id),
  asset_id INTEGER REFERENCES environmental_assets(id),
  poll_interval_seconds INTEGER,
  config_json TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS environmental_excursions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER NOT NULL REFERENCES environmental_assets(id),
  device_id INTEGER REFERENCES environmental_devices(id),
  parameter TEXT NOT NULL DEFAULT 'temperature',
  acceptable_min REAL, acceptable_max REAL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  max_value REAL, min_value REAL,
  duration_minutes INTEGER,
  status TEXT NOT NULL DEFAULT 'open',
  investigation_status TEXT DEFAULT 'pending',
  acknowledged_by_staff_id INTEGER REFERENCES staff(id),
  nc_id INTEGER REFERENCES nonconforming_events(id),
  capa_id INTEGER REFERENCES capa_records(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS environmental_readings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER NOT NULL REFERENCES environmental_assets(id),
  device_id INTEGER REFERENCES environmental_devices(id),
  source TEXT NOT NULL DEFAULT 'manual',
  temperature REAL, humidity REAL,
  battery_level REAL, signal_strength REAL,
  recorded_at TEXT NOT NULL,
  recorded_by_staff_id INTEGER REFERENCES staff(id),
  status TEXT NOT NULL DEFAULT 'normal',
  observation TEXT, corrective_action TEXT, manual_reason TEXT, signature TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS environmental_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER REFERENCES environmental_assets(id),
  device_id INTEGER REFERENCES environmental_devices(id),
  alert_type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'warning',
  message TEXT,
  value REAL,
  status TEXT NOT NULL DEFAULT 'active',
  triggered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  acknowledged_by_staff_id INTEGER REFERENCES staff(id),
  acknowledged_at TEXT,
  resolved_at TEXT,
  excursion_id INTEGER REFERENCES environmental_excursions(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS environmental_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  polling_enabled INTEGER NOT NULL DEFAULT 0,
  default_poll_interval_seconds INTEGER NOT NULL DEFAULT 300,
  excursion_nc_minutes INTEGER NOT NULL DEFAULT 30,
  battery_low_threshold REAL NOT NULL DEFAULT 20,
  no_comm_minutes INTEGER NOT NULL DEFAULT 15,
  prevent_expired_devices INTEGER NOT NULL DEFAULT 0,
  floor_plan_file_id INTEGER REFERENCES files(id),
  email_enabled INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT
);
INSERT OR IGNORE INTO environmental_settings (id) VALUES (1);
CREATE INDEX IF NOT EXISTS idx_env_readings_asset_time ON environmental_readings(asset_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_env_alerts_status ON environmental_alerts(status);
CREATE INDEX IF NOT EXISTS idx_env_excursions_status ON environmental_excursions(status);

-- Escalation ladder: each rule fires a channel after delay_minutes if a matching
-- alert is still unacknowledged. delay 0 = notify immediately.
CREATE TABLE IF NOT EXISTS environmental_escalation_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'critical',
  delay_minutes INTEGER NOT NULL DEFAULT 0,
  channel TEXT NOT NULL DEFAULT 'in_app',
  recipients TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
-- Outbound notification queue (one row per alert × rule); a worker delivers it.
CREATE TABLE IF NOT EXISTS environmental_notification_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_id INTEGER REFERENCES environmental_alerts(id),
  rule_id INTEGER REFERENCES environmental_escalation_rules(id),
  channel TEXT NOT NULL,
  recipients TEXT,
  subject TEXT,
  body TEXT,
  severity TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  scheduled_at TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_env_notif_status ON environmental_notification_queue(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_env_notif_alert_rule ON environmental_notification_queue(alert_id, rule_id);
`);
  // environmental_settings may pre-date the webhook column on upgraded installs.
  const envSetCols = new Set((database.prepare("PRAGMA table_info(environmental_settings)").all() as Array<{ name: string }>).map(c => c.name));
  if (!envSetCols.has('webhook_url')) database.exec('ALTER TABLE environmental_settings ADD COLUMN webhook_url TEXT');
  // Seed a sensible default escalation ladder once, so in-app alerts work out of
  // the box: notify in-app immediately, and escalate criticals after 30 minutes.
  const ruleCount = (database.prepare('SELECT COUNT(*) c FROM environmental_escalation_rules').get() as { c: number }).c;
  if (ruleCount === 0) {
    database.prepare("INSERT INTO environmental_escalation_rules (name, severity, delay_minutes, channel) VALUES (?, 'any', 0, 'in_app')").run('In-app — all alerts');
    database.prepare("INSERT INTO environmental_escalation_rules (name, severity, delay_minutes, channel) VALUES (?, 'critical', 30, 'in_app')").run('Escalate unacknowledged criticals (30m)');
  }

  // ===================================================================
  // Phase 9: Documents & Records upgrade
  // Faithful to SECH Document Control Procedure (SECHPO026) and Control of
  // Records Procedure (SECHPO051).
  // -------------------------------------------------------------------
  // In-application document content: extracted text + an editable, controlled
  // body, so a controlled document can be read and edited inside SECH_LIMS
  // instead of only existing as an opaque attachment.
  const docCols2 = new Set((database.prepare("PRAGMA table_info(documents)").all() as Array<{ name: string }>).map(c => c.name));
  if (!docCols2.has('section_category')) database.exec('ALTER TABLE documents ADD COLUMN section_category TEXT');
  if (!docCols2.has('control_copy_number')) database.exec('ALTER TABLE documents ADD COLUMN control_copy_number TEXT');
  if (!docCols2.has('reviewed_by_staff_id')) database.exec('ALTER TABLE documents ADD COLUMN reviewed_by_staff_id INTEGER REFERENCES staff(id)');
  if (!docCols2.has('reviewed_at')) database.exec('ALTER TABLE documents ADD COLUMN reviewed_at TEXT');
  if (!docCols2.has('approved_by_staff_id')) database.exec('ALTER TABLE documents ADD COLUMN approved_by_staff_id INTEGER REFERENCES staff(id)');
  if (!docCols2.has('approved_at')) database.exec('ALTER TABLE documents ADD COLUMN approved_at TEXT');

  const verCols2 = new Set((database.prepare("PRAGMA table_info(document_versions)").all() as Array<{ name: string }>).map(c => c.name));
  if (!verCols2.has('content_text')) database.exec('ALTER TABLE document_versions ADD COLUMN content_text TEXT');
  if (!verCols2.has('content_html')) database.exec('ALTER TABLE document_versions ADD COLUMN content_html TEXT');
  if (!verCols2.has('content_sections')) database.exec('ALTER TABLE document_versions ADD COLUMN content_sections TEXT');
  if (!verCols2.has('extracted_at')) database.exec('ALTER TABLE document_versions ADD COLUMN extracted_at TEXT');
  if (!verCols2.has('extraction_method')) database.exec('ALTER TABLE document_versions ADD COLUMN extraction_method TEXT');
  if (!verCols2.has('page_count')) database.exec('ALTER TABLE document_versions ADD COLUMN page_count INTEGER');
  if (!verCols2.has('content_updated_by')) database.exec('ALTER TABLE document_versions ADD COLUMN content_updated_by INTEGER REFERENCES staff(id)');
  if (!verCols2.has('content_updated_at')) database.exec('ALTER TABLE document_versions ADD COLUMN content_updated_at TEXT');

  database.exec(`
-- Master Record Register (SECHPO051 §5.3): inventory of controlled records.
CREATE TABLE IF NOT EXISTS record_register (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  record_code TEXT,
  title TEXT NOT NULL,
  record_category TEXT,              -- pre_examination|examination|post_examination|quality|support|other
  record_format TEXT DEFAULT 'electronic', -- paper|electronic|both
  department_id INTEGER REFERENCES departments(id),
  section_id INTEGER REFERENCES sections(id),
  responsible_staff_id INTEGER REFERENCES staff(id),
  storage_location TEXT,
  storage_medium TEXT,
  retention_schedule_id INTEGER,
  retention_period TEXT,
  confidentiality TEXT DEFAULT 'internal', -- public|internal|restricted|confidential
  linked_document_id INTEGER REFERENCES documents(id),
  date_created TEXT,
  disposal_due_date TEXT,
  status TEXT NOT NULL DEFAULT 'active', -- active|archived|disposed
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);

-- Record Retention Schedule (SECHPO051 Appendix A): retention rules per record type.
CREATE TABLE IF NOT EXISTS record_retention_schedule (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sn INTEGER,
  record_type TEXT NOT NULL,
  retention_period TEXT NOT NULL,
  storage_medium TEXT,
  responsible_role TEXT,
  extended_retention INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);

-- Quality & Technical Records Review Log (SECHPO051 §5.7).
CREATE TABLE IF NOT EXISTS record_review_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  review_number TEXT,
  review_date TEXT NOT NULL,
  record_category TEXT NOT NULL,
  section_id INTEGER REFERENCES sections(id),
  records_reviewed TEXT,
  findings TEXT,
  nonconformities_identified TEXT,
  action_required INTEGER NOT NULL DEFAULT 0,
  responsible_staff_id INTEGER REFERENCES staff(id),
  target_completion_date TEXT,
  follow_up_status TEXT DEFAULT 'open', -- open|in_progress|completed|escalated
  nc_id INTEGER REFERENCES nonconforming_events(id),
  reviewer_staff_id INTEGER REFERENCES staff(id),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);

-- Document & Record Destruction Form (SECHF0047) — disposal log (SECHPO051 §5.6).
CREATE TABLE IF NOT EXISTS record_destruction_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  destruction_number TEXT,
  item_type TEXT NOT NULL DEFAULT 'record', -- record|document
  record_register_id INTEGER REFERENCES record_register(id),
  document_id INTEGER REFERENCES documents(id),
  description TEXT NOT NULL,
  record_category TEXT,
  date_destroyed TEXT NOT NULL,
  method TEXT,                       -- shredding|incineration|secure_deletion|media_destruction
  retention_verified INTEGER NOT NULL DEFAULT 0,
  confidentiality_ensured INTEGER NOT NULL DEFAULT 1,
  authorized_by_staff_id INTEGER REFERENCES staff(id),
  witness_staff_id INTEGER REFERENCES staff(id),
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Backup & Archive Log (SECHPO051 §5.4): electronic record backups + restore tests.
CREATE TABLE IF NOT EXISTS record_backup_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  backup_number TEXT,
  backup_date TEXT NOT NULL,
  backup_type TEXT,                  -- incremental|full|archive
  scope TEXT,
  storage_location TEXT,
  offsite INTEGER NOT NULL DEFAULT 0,
  performed_by_staff_id INTEGER REFERENCES staff(id),
  integrity_verified INTEGER NOT NULL DEFAULT 0,
  restore_test_status TEXT,          -- not_tested|passed|failed
  restore_test_date TEXT,
  status TEXT NOT NULL DEFAULT 'completed',
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- Workflow comments left by drafter/reviewer/approver during the document
-- lifecycle (documented review before issue).
CREATE TABLE IF NOT EXISTS document_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL REFERENCES documents(id),
  document_version_id INTEGER REFERENCES document_versions(id),
  stage TEXT,
  comment TEXT NOT NULL,
  author_staff_id INTEGER REFERENCES staff(id),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_record_register_section ON record_register(section_id);
CREATE INDEX IF NOT EXISTS idx_record_review_log_date ON record_review_log(review_date);
CREATE INDEX IF NOT EXISTS idx_document_comments_doc ON document_comments(document_id);
`);

  // Document & Records Master List (SECHML00) fields: registers carry the full
  // master-list columns so on-screen registers and Excel exports mirror the
  // laboratory's controlled master list workbook.
  const docCols3 = new Set((database.prepare("PRAGMA table_info(documents)").all() as Array<{ name: string }>).map(c => c.name));
  if (!docCols3.has('format_medium')) database.exec('ALTER TABLE documents ADD COLUMN format_medium TEXT');
  if (!docCols3.has('controlled_locations')) database.exec('ALTER TABLE documents ADD COLUMN controlled_locations TEXT');
  if (!docCols3.has('retention_period')) database.exec('ALTER TABLE documents ADD COLUMN retention_period TEXT');
  if (!docCols3.has('remarks')) database.exec('ALTER TABLE documents ADD COLUMN remarks TEXT');
  if (!docCols3.has('withdrawn_at')) database.exec('ALTER TABLE documents ADD COLUMN withdrawn_at TEXT');
  if (!docCols3.has('destroy_due_date')) database.exec('ALTER TABLE documents ADD COLUMN destroy_due_date TEXT');
  if (!docCols3.has('archive_location')) database.exec('ALTER TABLE documents ADD COLUMN archive_location TEXT');

  // Records may be uploaded files or generated inside the system; both live in
  // the record register with their origin and (for uploads) the stored file.
  const recRegCols = new Set((database.prepare("PRAGMA table_info(record_register)").all() as Array<{ name: string }>).map(c => c.name));
  if (!recRegCols.has('disposal_method')) database.exec('ALTER TABLE record_register ADD COLUMN disposal_method TEXT');
  if (!recRegCols.has('file_id')) database.exec('ALTER TABLE record_register ADD COLUMN file_id INTEGER REFERENCES files(id)');
  if (!recRegCols.has('origin')) database.exec("ALTER TABLE record_register ADD COLUMN origin TEXT DEFAULT 'manual'");
  if (!recRegCols.has('source_module')) database.exec('ALTER TABLE record_register ADD COLUMN source_module TEXT');

  // Seed the Record Retention Schedule from SECHPO051 Appendix A (idempotent).
  const retentionSeeded = (database.prepare('SELECT COUNT(*) c FROM record_retention_schedule').get() as { c: number }).c;
  if (retentionSeeded === 0) {
    const rows: Array<[number, string, string, string, string, number]> = [
      [1, 'Examination request forms', '2 years', 'Paper / Electronic', 'Section Head', 0],
      [2, 'Routine examination results & reports', '5 years', 'LIS / Electronic / Paper', 'Laboratory Manager', 0],
      [3, 'Critical result records', '5 years', 'Electronic / Paper', 'Quality Manager', 0],
      [4, 'Histology & cytology reports', '10 years minimum', 'Archive / Secure Storage', 'Section Head', 1],
      [5, 'Genetic testing records', '10–20 years (high legal risk)', 'Secure Electronic Archive', 'Laboratory Manager', 1],
      [6, 'Pediatric examination records', 'Until patient is 21 years OR 10 years, whichever is longer', 'Electronic / Archive', 'Quality Manager', 1],
      [7, 'Blood transfusion & compatibility records', '10 years', 'Paper / Electronic', 'Blood Bank Supervisor', 1],
      [8, 'Quality control (IQC) records', '2 years', 'Paper / Electronic', 'Section Head', 0],
      [9, 'External Quality Assessment (EQA/PT)', '5 years', 'Electronic', 'Quality Manager', 0],
      [10, 'Equipment records', 'Lifetime of equipment + 5 years', 'Paper / Electronic', 'Equipment Officer', 0],
      [11, 'Reagent & consumable records', '2 years after expiry', 'Paper / Electronic', 'Stores Officer', 0],
      [12, 'Personnel records', 'Duration of employment + 5 years', 'Confidential File', 'Laboratory Manager', 0],
      [13, 'Incident & nonconformity records', '5–10 years', 'Electronic / Paper', 'Quality Manager', 0],
      [14, 'Risk assessment records', '5 years', 'Paper / Electronic', 'Quality Manager', 0],
      [15, 'Audit & management review records', '5 years', 'Electronic', 'Laboratory Manager', 0],
      [16, 'Backup & archive logs', '2 years', 'Electronic', 'IT / Quality Officer', 0],
    ];
    const stmt = database.prepare('INSERT INTO record_retention_schedule (sn, record_type, retention_period, storage_medium, responsible_role, extended_retention) VALUES (?, ?, ?, ?, ?, ?)');
    const tx = database.transaction(() => { for (const r of rows) stmt.run(...r); });
    tx();
  }

  // ===================================================================
  // Dennis AI Quality Assistant — Phases 2-6 (offline indexing & search,
  // source-grounded answers, local/online provider prep, activity logging).
  // Extends the Phase AI-1 dennis_* tables created above.
  // -------------------------------------------------------------------
  const dennisDocCols = new Set((database.prepare("PRAGMA table_info(dennis_documents)").all() as Array<{ name: string }>).map(c => c.name));
  for (const [col, type] of [
    ['source_document_id', 'INTEGER'], ['source_version_id', 'INTEGER'], ['document_code', 'TEXT'], ['section_id', 'INTEGER'],
    ['access_level', 'TEXT'], ['approval_status', 'TEXT'], ['searchable_text', 'TEXT'], ['effective_date', 'TEXT'], ['next_review_date', 'TEXT'],
    ['indexed_by', 'INTEGER'], ['indexed_at', 'TEXT'], ['last_indexed_at', 'TEXT'], ['indexing_status', "TEXT DEFAULT 'not_indexed'"],
    ['indexing_error', 'TEXT'], ['chunk_count', 'INTEGER'], ['word_count', 'INTEGER'],
  ] as const) {
    if (!dennisDocCols.has(col)) database.exec(`ALTER TABLE dennis_documents ADD COLUMN ${col} ${type}`);
  }
  const dennisChunkCols = new Set((database.prepare("PRAGMA table_info(dennis_document_chunks)").all() as Array<{ name: string }>).map(c => c.name));
  for (const [col, type] of [['source_document_id', 'INTEGER'], ['embedding', 'TEXT'], ['word_count', 'INTEGER'], ['embed_model', 'TEXT']] as const) {
    if (!dennisChunkCols.has(col)) database.exec(`ALTER TABLE dennis_document_chunks ADD COLUMN ${col} ${type}`);
  }
  const dennisLogCols = new Set((database.prepare("PRAGMA table_info(dennis_activity_logs)").all() as Array<{ name: string }>).map(c => c.name));
  for (const [col, type] of [['current_page', 'TEXT'], ['provider', 'TEXT'], ['source_document_ids', 'TEXT'], ['record_id', 'TEXT'], ['error_message', 'TEXT'], ['detail', 'TEXT'], ['online_used', 'INTEGER'], ['redaction_applied', 'INTEGER'], ['document_name', 'TEXT'], ['task_type', 'TEXT']] as const) {
    if (!dennisLogCols.has(col)) database.exec(`ALTER TABLE dennis_activity_logs ADD COLUMN ${col} ${type}`);
  }
  // FTS5 index over chunk text for fast offline keyword/relevance search.
  database.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS dennis_chunk_fts USING fts5(chunk_text, chunk_id UNINDEXED, dennis_document_id UNINDEXED)`);
  database.exec(`CREATE INDEX IF NOT EXISTS idx_dennis_documents_source ON dennis_documents(source_document_id);
CREATE INDEX IF NOT EXISTS idx_dennis_chunks_doc ON dennis_document_chunks(document_id);`);

  // ===================================================================
  // Facilities & Safety workspace — safety equipment, inspections/drills,
  // waste disposal, hazardous chemicals and staff immunisation/exposure
  // records, complementing the existing safety-incident register.
  // -------------------------------------------------------------------
  database.exec(`
-- Safety equipment register: biosafety cabinets, fume hoods, fire
-- extinguishers, alarms, eyewash stations, showers, spill/first-aid kits, PPE
-- stations. Tracks inspection and certification due dates.
CREATE TABLE IF NOT EXISTS safety_equipment (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  equipment_number TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  equipment_type TEXT,               -- biosafety_cabinet|fume_hood|fire_extinguisher|fire_alarm|smoke_detector|eyewash_station|emergency_shower|spill_kit|first_aid_kit|ppe_station|other
  serial_number TEXT,
  location_id INTEGER REFERENCES locations(id),
  section_id INTEGER REFERENCES sections(id),
  responsible_staff_id INTEGER REFERENCES staff(id),
  status TEXT NOT NULL DEFAULT 'operational', -- operational|out_of_service|expired|removed
  inspection_frequency TEXT,
  last_inspection_date TEXT,
  next_inspection_due TEXT,
  certification_frequency TEXT,
  last_certification_date TEXT,
  next_certification_due TEXT,
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);

-- Safety inspections, audits, fire drills, housekeeping and facility
-- assessments. Findings can escalate to NC/CAPA like safety incidents.
CREATE TABLE IF NOT EXISTS safety_inspections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  inspection_number TEXT NOT NULL UNIQUE,
  inspection_type TEXT,              -- safety_audit|fire_drill|housekeeping|facility_assessment|walkthrough|biosafety
  inspection_date TEXT NOT NULL,
  section_id INTEGER REFERENCES sections(id),
  location_id INTEGER REFERENCES locations(id),
  conducted_by_staff_id INTEGER REFERENCES staff(id),
  scope TEXT,
  findings_summary TEXT,
  outcome TEXT,                      -- pass|action_required|fail
  corrective_action TEXT,
  status TEXT NOT NULL DEFAULT 'open', -- open|under_review|action_required|closed
  next_due_date TEXT,
  nc_id INTEGER REFERENCES nonconforming_events(id),
  capa_id INTEGER REFERENCES capa_records(id),
  closed_by_staff_id INTEGER REFERENCES staff(id),
  closed_at TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);

-- Waste disposal log: biohazard, sharps, chemical, pathological and general
-- waste, with disposal method and manifest reference.
CREATE TABLE IF NOT EXISTS waste_disposal_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  record_number TEXT NOT NULL UNIQUE,
  disposal_date TEXT NOT NULL,
  waste_type TEXT,                   -- infectious|sharps|chemical|pathological|general|radioactive|pharmaceutical
  quantity TEXT,
  unit TEXT,
  disposal_method TEXT,              -- autoclave|incineration|pit|licensed_collector|sewer|other
  handled_by_staff_id INTEGER REFERENCES staff(id),
  carrier_or_destination TEXT,
  manifest_reference TEXT,
  section_id INTEGER REFERENCES sections(id),
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);

-- Hazardous chemical inventory with safety-data-sheet reference, hazard
-- class, storage and segregation.
CREATE TABLE IF NOT EXISTS hazardous_chemicals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chemical_number TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  hazard_class TEXT,                 -- flammable|corrosive|toxic|oxidizer|carcinogen|irritant|radioactive|other
  cas_number TEXT,
  sds_reference TEXT,
  sds_on_file INTEGER DEFAULT 0,
  storage_location_id INTEGER REFERENCES locations(id),
  segregation_group TEXT,
  quantity TEXT,
  unit TEXT,
  expiry_date TEXT,
  spill_measures TEXT,
  status TEXT NOT NULL DEFAULT 'in_use', -- in_use|in_store|disposed
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);

-- Staff immunisation, post-exposure prophylaxis and vaccination-declination
-- records (occupational health).
CREATE TABLE IF NOT EXISTS staff_immunizations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  record_number TEXT NOT NULL UNIQUE,
  staff_id INTEGER REFERENCES staff(id),
  record_type TEXT NOT NULL DEFAULT 'vaccination', -- vaccination|post_exposure|declination
  vaccine_or_agent TEXT,
  dose_or_stage TEXT,
  date_administered TEXT,
  next_due_date TEXT,
  provider TEXT,
  exposure_date TEXT,
  exposure_source TEXT,
  follow_up_summary TEXT,
  outcome TEXT,
  declination_signed INTEGER DEFAULT 0,
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
`);

  // ===================================================================
  // Process Management — pre-examination, continuity and result-validity
  // registers: collection instructions, sample receipt/condition log,
  // biological reference intervals, result-comparability studies and a
  // scenario-based contingency / continuity plan.
  // -------------------------------------------------------------------
  database.exec(`
-- Pre-examination collection & handling instructions, per test / sample type.
CREATE TABLE IF NOT EXISTS pre_examination_instructions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instruction_number TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  test_catalog_id INTEGER REFERENCES lab_test_catalog(id),
  sample_type TEXT,
  container_additive TEXT,
  patient_preparation TEXT,
  collection_instructions TEXT,
  transport_condition TEXT,
  stability_summary TEXT,
  storage_condition TEXT,
  status TEXT NOT NULL DEFAULT 'active', -- active|under_review|archived
  section_id INTEGER REFERENCES sections(id),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);

-- Primary-sample receipt & condition log (feeds the rejection register).
CREATE TABLE IF NOT EXISTS sample_receipt_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_number TEXT NOT NULL UNIQUE,
  receipt_date TEXT NOT NULL,
  receipt_time TEXT,
  request_reference TEXT,
  patient_reference TEXT,
  patient_type TEXT,
  sample_type TEXT,
  section_id INTEGER REFERENCES sections(id),
  test_catalog_id INTEGER REFERENCES lab_test_catalog(id),
  received_by_staff_id INTEGER REFERENCES staff(id),
  condition TEXT NOT NULL DEFAULT 'acceptable', -- acceptable|suboptimal|rejected
  condition_notes TEXT,
  temperature TEXT,
  request_complete INTEGER DEFAULT 1,
  urgent INTEGER DEFAULT 0,
  rejection_id INTEGER REFERENCES specimen_rejection_records(id),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);

-- Biological reference intervals & clinical decision limits register.
CREATE TABLE IF NOT EXISTS reference_interval_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  record_number TEXT NOT NULL UNIQUE,
  test_catalog_id INTEGER REFERENCES lab_test_catalog(id),
  analyte TEXT NOT NULL,
  sample_type TEXT,
  population TEXT,                    -- e.g. adult male, paediatric, pregnancy
  lower_limit TEXT,
  upper_limit TEXT,
  unit TEXT,
  clinical_decision_limit TEXT,
  source TEXT,                        -- manufacturer|literature|in-house study
  effective_date TEXT,
  review_date TEXT,
  status TEXT NOT NULL DEFAULT 'active', -- active|under_review|superseded
  communicated_to_users INTEGER DEFAULT 0,
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);

-- Result comparability studies across methods / analysers / POCT.
CREATE TABLE IF NOT EXISTS result_comparability_studies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  study_number TEXT NOT NULL UNIQUE,
  study_date TEXT NOT NULL,
  test_name TEXT,
  analyte TEXT,
  method_a TEXT,
  method_b TEXT,
  sample_count INTEGER,
  acceptance_criteria TEXT,
  outcome TEXT,                       -- comparable|significant_difference|inconclusive
  findings TEXT,
  action_taken TEXT,
  conducted_by_staff_id INTEGER REFERENCES staff(id),
  next_due_date TEXT,
  status TEXT NOT NULL DEFAULT 'open', -- open|reviewed|closed
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);

-- Scenario-based contingency / continuity & emergency-preparedness plans.
CREATE TABLE IF NOT EXISTS contingency_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_number TEXT NOT NULL UNIQUE,
  scenario_type TEXT,                -- personnel|equipment|power|reagent_stockout|fire_disaster|lis_downtime|other
  title TEXT NOT NULL,
  trigger_description TEXT,
  response_actions TEXT,
  backup_arrangement TEXT,
  responsible_staff_id INTEGER REFERENCES staff(id),
  last_tested_date TEXT,
  test_outcome TEXT,
  next_test_due TEXT,
  status TEXT NOT NULL DEFAULT 'active', -- draft|active|under_review|retired
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
`);

  // ===================================================================
  // Customer Focus — advisory services and laboratory handbook.
  // -------------------------------------------------------------------
  database.exec(`
-- Advisory-services log: advice given to clinicians/users on test choice,
-- interpretation, sample type, frequency and utilisation.
CREATE TABLE IF NOT EXISTS advisory_services (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  record_number TEXT NOT NULL UNIQUE,
  service_date TEXT NOT NULL,
  service_type TEXT,                 -- test_choice|interpretation|sample_type|frequency|clinical_advice|utilization|other
  requester TEXT,
  stakeholder_id INTEGER REFERENCES customer_stakeholders(id),
  provided_by_staff_id INTEGER REFERENCES staff(id),
  subject TEXT,
  advice_summary TEXT,
  communication_channel TEXT,
  follow_up_required INTEGER DEFAULT 0,
  follow_up_due_date TEXT,
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);

-- Laboratory handbook / user-information entries (hours, test menu,
-- collection, transport, turnaround, contacts, policies).
CREATE TABLE IF NOT EXISTS laboratory_handbook_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_number TEXT NOT NULL UNIQUE,
  section TEXT,                       -- hours|test_menu|collection|transport|turnaround|contacts|policies|other
  title TEXT NOT NULL,
  content TEXT,
  version TEXT,
  effective_date TEXT,
  review_date TEXT,
  status TEXT NOT NULL DEFAULT 'active', -- draft|active|under_review|archived
  display_order INTEGER DEFAULT 0,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
`);

  // ===================================================================
  // Organisation & Leadership — code-of-conduct adherence and budget
  // projection registers.
  // -------------------------------------------------------------------
  database.exec(`
-- Code-of-conduct adherence: impartiality, confidentiality, conflict of
-- interest and code-of-conduct commitments, signed per staff member.
CREATE TABLE IF NOT EXISTS code_of_conduct_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  record_number TEXT NOT NULL UNIQUE,
  staff_id INTEGER REFERENCES staff(id),
  commitment_type TEXT,              -- impartiality|confidentiality|conflict_of_interest|code_adherence|all
  statement TEXT,
  signed_date TEXT,
  review_date TEXT,
  conflict_declared INTEGER DEFAULT 0,
  conflict_details TEXT,
  status TEXT NOT NULL DEFAULT 'active', -- active|due_review|superseded
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);

-- Annual budget projections across personnel, equipment, maintenance,
-- reagents/consumables, quality assurance (IQC/EQA), infrastructure, training.
CREATE TABLE IF NOT EXISTS budget_projections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  projection_number TEXT NOT NULL UNIQUE,
  fiscal_year TEXT,
  category TEXT,                      -- personnel|equipment|maintenance|reagents_consumables|quality_assurance|infrastructure|training|other
  description TEXT,
  projected_amount REAL,
  currency TEXT DEFAULT 'GHS',
  responsible_staff_id INTEGER REFERENCES staff(id),
  status TEXT NOT NULL DEFAULT 'draft', -- draft|submitted|approved|closed
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
`);

  // ===================================================================
  // Phase D cross-cutting registers — staff performance appraisals,
  // storage-area condition inspections, and regulatory registrations /
  // licences. All are empty registers populated by the laboratory.
  // -------------------------------------------------------------------
  database.exec(`
-- Staff performance appraisals (distinct from competency assessments).
CREATE TABLE IF NOT EXISTS performance_appraisals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  record_number TEXT NOT NULL UNIQUE,
  staff_id INTEGER REFERENCES staff(id),
  appraisal_date TEXT NOT NULL,
  period TEXT,
  appraiser_staff_id INTEGER REFERENCES staff(id),
  rating TEXT,
  outcome TEXT,
  strengths TEXT,
  development_areas TEXT,
  objectives TEXT,
  next_appraisal_due TEXT,
  status TEXT NOT NULL DEFAULT 'completed', -- planned|completed
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);

-- Storage-area condition inspections (reagent/consumable/sample storage).
CREATE TABLE IF NOT EXISTS storage_inspections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  inspection_number TEXT NOT NULL UNIQUE,
  inspection_date TEXT NOT NULL,
  location_id INTEGER REFERENCES locations(id),
  storage_area TEXT,
  inspected_by_staff_id INTEGER REFERENCES staff(id),
  cold_storage_adequate INTEGER DEFAULT 0,
  temperature_monitored INTEGER DEFAULT 0,
  humidity_monitored INTEGER DEFAULT 0,
  ventilation_adequate INTEGER DEFAULT 0,
  access_controlled INTEGER DEFAULT 0,
  organised_fefo INTEGER DEFAULT 0,
  outcome TEXT,                      -- pass|action_required|fail
  findings TEXT,
  corrective_action TEXT,
  next_due_date TEXT,
  status TEXT NOT NULL DEFAULT 'open', -- open|closed
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);

-- Regulatory registrations & licences (facility / organisational). The
-- issuing body is free text so each laboratory names its own regulators.
CREATE TABLE IF NOT EXISTS regulatory_registrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  registration_number TEXT NOT NULL UNIQUE,
  credential_type TEXT,             -- facility_licence|accreditation|practice_registration|permit|certification|other
  title TEXT NOT NULL,
  issuing_body TEXT,
  reference TEXT,
  issue_date TEXT,
  expiry_date TEXT,
  responsible_staff_id INTEGER REFERENCES staff(id),
  status TEXT NOT NULL DEFAULT 'active', -- active|expired|pending_renewal|withdrawn
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
`);

  // Default Dennis settings: strict hybrid policy. Ollama (offline) is the default
  // runtime and is enabled; online AI is disabled by default and, even once
  // enabled, is restricted to SOP/document analysis only (never operational data).
  // INSERT OR IGNORE so operator changes are preserved across restarts.
  const dennisDefaults: Array<[string, string]> = [
    ['dennis.mode', 'Hybrid recommended'],
    ['dennis.local.enabled', 'true'],
    ['dennis.local.provider', 'ollama'],
    ['dennis.local.endpoint', 'http://localhost:11434'],
    ['dennis.local.chatModel', 'llama3.1'],
    ['dennis.local.embedModel', 'nomic-embed-text'],
    ['dennis.online.enabled', 'false'],
    ['dennis.online.provider', 'anthropic'],
    ['dennis.online.endpoint', ''],
    ['dennis.online.model', 'claude-sonnet-4-6'],
    ['dennis.online.apiKey', ''],
    ['dennis.online.confirmRequired', 'true'],
  ];
  const dset = database.prepare('INSERT OR IGNORE INTO dennis_settings (setting_key, setting_value) VALUES (?, ?)');
  for (const [k, v] of dennisDefaults) dset.run(k, v);

  // One-time policy enforcement (strict hybrid). Runs once per database so it
  // does not repeatedly override later operator choices: enable Ollama by
  // default, migrate the mode vocabulary to the three supported modes, and make
  // sure online AI starts disabled.
  const policyApplied = database.prepare("SELECT setting_value FROM dennis_settings WHERE setting_key = 'dennis.policy.v2'").get() as { setting_value: string } | undefined;
  if (!policyApplied) {
    const cur = (k: string) => (database.prepare('SELECT setting_value FROM dennis_settings WHERE setting_key = ?').get(k) as { setting_value: string } | undefined)?.setting_value;
    const put = database.prepare(`INSERT INTO dennis_settings (setting_key, setting_value) VALUES (?, ?)
      ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value`);
    const modeMap: Record<string, string> = { 'Offline only': 'Offline only', 'Online only': 'Online drafting only', 'Hybrid': 'Hybrid recommended', 'Hybrid recommended': 'Hybrid recommended', 'Online drafting only': 'Online drafting only' };
    const oldMode = cur('dennis.mode') || 'Hybrid recommended';
    put.run('dennis.mode', modeMap[oldMode] || 'Hybrid recommended');
    put.run('dennis.local.enabled', 'true');
    put.run('dennis.online.enabled', 'false');
    put.run('dennis.policy.v2', 'applied');
  }

  // Phase 4: link maintenance records to a schedule and capture the servicer.
  // Placed at the end of migrate() so equipment_maintenance_records (created in a
  // later schema block) already exists.
  const maintCols = new Set((database.prepare("PRAGMA table_info(equipment_maintenance_records)").all() as Array<{ name: string }>).map(c => c.name));
  if (!maintCols.has('schedule_id')) database.exec('ALTER TABLE equipment_maintenance_records ADD COLUMN schedule_id INTEGER REFERENCES equipment_schedules(id)');
  if (!maintCols.has('service_provider')) database.exec('ALTER TABLE equipment_maintenance_records ADD COLUMN service_provider TEXT');
  if (!maintCols.has('provider_type')) database.exec('ALTER TABLE equipment_maintenance_records ADD COLUMN provider_type TEXT');
}
