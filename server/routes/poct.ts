import { Router } from 'express';
import { getDb } from '../db/database.js';
import { requirePermission } from '../middleware/permissions.js';
import { audit } from '../services/auditService.js';
import { generateRecordNumber } from '../utils/recordNumber.js';
import { parseIntNullable, getStaffIdOrCurrent } from './routeHelpers.js';

const SITE_STATUSES = ['active', 'inactive', 'suspended', 'archived'];
const DEVICE_STATUSES = ['active', 'inactive', 'under_maintenance', 'removed', 'quarantined'];
const AUTHORIZATION_LEVELS = ['observe_only', 'perform', 'review', 'supervise', 'train_others'];
const AUTHORIZATION_STATUSES = ['draft', 'active', 'expired', 'revoked', 'suspended'];
const QC_STATUSES = ['accepted', 'warning', 'failed', 'pending_review'];
const QC_INTERPRETATIONS = ['within_range', 'out_of_range', 'invalid', 'not_applicable'];
const EQA_PERFORMANCE_STATUSES = ['satisfactory', 'unsatisfactory', 'pending', 'not_submitted', 'not_applicable'];
const EQA_STATUSES = ['open', 'submitted', 'reviewed', 'closed'];
const MAINTENANCE_TYPES = ['daily_check', 'cleaning', 'calibration_check', 'preventive_maintenance', 'repair', 'troubleshooting', 'other'];
const MAINTENANCE_STATUSES = ['open', 'completed', 'closed'];
const INCIDENT_STATUSES = ['open', 'in_progress', 'linked_to_nc', 'linked_to_capa', 'closed'];
const INCIDENT_SEVERITIES = ['low', 'medium', 'high', 'critical'];
const REVIEW_STATUSES = ['draft', 'reviewed', 'approved', 'closed'];
const REAGENT_STATUSES = ['received', 'in_use', 'expired', 'discarded', 'reserved'];

function insertLink(db: any, source: { module: string; type: string; id: string | number }, target: { module: string; type: string; id: string | number }, notes?: string) {
  db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run(source.module, source.type, String(source.id), target.module, target.type, String(target.id), notes ?? null);
}

function flagExpired(rows: any[], dateField: string) {
  const today = new Date().toISOString().slice(0, 10);
  return rows.map(r => {
    const expiry = r[dateField];
    return { ...r, _expired: expiry && expiry < today };
  });
}

export function poctRoutes() {
  const router = Router();

  // -------- Summary (specific before everything) --------
  router.get('/summary', requirePermission('poct', 'view'), (_req, res) => {
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
      openIncidents: count("SELECT COUNT(*) count FROM poct_incidents WHERE status NOT IN ('closed')"),
      maintenanceDue: count("SELECT COUNT(*) count FROM poct_devices WHERE next_service_due IS NOT NULL AND next_service_due <= ?", today)
    });
  });

  // ============= Sites =============
  router.get('/sites', requirePermission('poct', 'view'), (req, res) => {
    const db = getDb();
    const filters: string[] = []; const params: unknown[] = [];
    if (req.query.status) { filters.push('status = ?'); params.push(String(req.query.status)); }
    let query = 'SELECT * FROM poct_sites';
    if (filters.length) query += ` WHERE ${filters.join(' AND ')}`;
    query += ' ORDER BY site_name';
    res.json(db.prepare(query).all(...params));
  });

  router.post('/sites', requirePermission('poct', 'create'), (req, res) => {
    if (!req.body.siteName) return res.status(400).json({ error: 'siteName is required' });
    const status = req.body.status ?? 'active';
    if (!SITE_STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${SITE_STATUSES.join(', ')}` });
    const db = getDb();
    const createdAt = new Date().toISOString();
    const siteCode = req.body.siteCode || generateRecordNumber(db, 'poct_sites', 'POCTS', createdAt);
    const result = db.prepare(`INSERT INTO poct_sites (site_code, site_name, department_id, section_id, location_id, service_area, responsible_staff_id, contact_person, status, notes, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(siteCode, req.body.siteName, parseIntNullable(req.body.departmentId), parseIntNullable(req.body.sectionId), parseIntNullable(req.body.locationId), req.body.serviceArea ?? null, parseIntNullable(req.body.responsibleStaffId), req.body.contactPerson ?? null, status, req.body.notes ?? null, req.user!.id, createdAt);
    const id = Number(result.lastInsertRowid);
    audit(req, { action: 'create', entity: 'poct_sites', entityId: id, newValue: { siteCode, ...req.body } });
    res.status(201).json({ id, siteCode });
  });

  router.get('/sites/:id', requirePermission('poct', 'view'), (req, res) => {
    const db = getDb();
    const site = db.prepare('SELECT * FROM poct_sites WHERE id = ?').get(req.params.id);
    if (!site) return res.status(404).json({ error: 'Site not found' });
    const devices = db.prepare('SELECT * FROM poct_devices WHERE site_id = ? ORDER BY device_name').all(req.params.id);
    res.json({ ...site, devices });
  });

  router.put('/sites/:id', requirePermission('poct', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM poct_sites WHERE id = ?').get(req.params.id) as any;
    if (!oldValue) return res.status(404).json({ error: 'Site not found' });
    if (req.body.status && !SITE_STATUSES.includes(req.body.status)) return res.status(400).json({ error: `status must be one of: ${SITE_STATUSES.join(', ')}` });
    db.prepare(`UPDATE poct_sites SET site_name = ?, department_id = ?, section_id = ?, location_id = ?, service_area = ?, responsible_staff_id = ?, contact_person = ?, status = ?, notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(req.body.siteName ?? oldValue.site_name, parseIntNullable(req.body.departmentId) ?? oldValue.department_id, parseIntNullable(req.body.sectionId) ?? oldValue.section_id, parseIntNullable(req.body.locationId) ?? oldValue.location_id, req.body.serviceArea ?? oldValue.service_area, parseIntNullable(req.body.responsibleStaffId) ?? oldValue.responsible_staff_id, req.body.contactPerson ?? oldValue.contact_person, req.body.status ?? oldValue.status, req.body.notes ?? oldValue.notes, req.params.id);
    audit(req, { action: 'edit', entity: 'poct_sites', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  router.post('/sites/:id/toggle', requirePermission('poct', 'edit'), (req, res) => {
    const db = getDb();
    const s = db.prepare('SELECT * FROM poct_sites WHERE id = ?').get(req.params.id) as any;
    if (!s) return res.status(404).json({ error: 'Site not found' });
    const newStatus = s.status === 'active' ? 'inactive' : 'active';
    db.prepare('UPDATE poct_sites SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(newStatus, req.params.id);
    audit(req, { action: 'toggle', entity: 'poct_sites', entityId: req.params.id, oldValue: { status: s.status }, newValue: { status: newStatus } });
    res.json({ ok: true, status: newStatus });
  });

  // ============= Devices =============
  router.get('/devices', requirePermission('poct', 'view'), (req, res) => {
    const db = getDb();
    const filters: string[] = []; const params: unknown[] = [];
    if (req.query.siteId) { filters.push('d.site_id = ?'); params.push(Number(req.query.siteId)); }
    if (req.query.status) { filters.push('d.status = ?'); params.push(String(req.query.status)); }
    let query = 'SELECT d.*, s.site_name, e.equipment_number FROM poct_devices d LEFT JOIN poct_sites s ON s.id = d.site_id LEFT JOIN equipment_items e ON e.id = d.equipment_id';
    if (filters.length) query += ` WHERE ${filters.join(' AND ')}`;
    query += ' ORDER BY d.device_name';
    res.json(db.prepare(query).all(...params));
  });

  router.post('/devices', requirePermission('poct', 'create'), (req, res) => {
    if (!parseIntNullable(req.body.siteId)) return res.status(400).json({ error: 'siteId is required' });
    if (!req.body.deviceName) return res.status(400).json({ error: 'deviceName is required' });
    if (!req.body.deviceType) return res.status(400).json({ error: 'deviceType is required' });
    const status = req.body.status ?? 'active';
    if (!DEVICE_STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${DEVICE_STATUSES.join(', ')}` });
    const db = getDb();
    const createdAt = new Date().toISOString();
    const deviceCode = req.body.deviceCode || generateRecordNumber(db, 'poct_devices', 'POCTD', createdAt);
    const result = db.prepare(`INSERT INTO poct_devices (device_code, site_id, equipment_id, device_name, device_type, manufacturer, model, serial_number, test_menu_summary, installation_date, last_service_date, next_service_due, status, notes, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(deviceCode, req.body.siteId, parseIntNullable(req.body.equipmentId), req.body.deviceName, req.body.deviceType, req.body.manufacturer ?? null, req.body.model ?? null, req.body.serialNumber ?? null, req.body.testMenuSummary ?? null, req.body.installationDate ?? null, req.body.lastServiceDate ?? null, req.body.nextServiceDue ?? null, status, req.body.notes ?? null, req.user!.id, createdAt);
    const id = Number(result.lastInsertRowid);
    if (parseIntNullable(req.body.equipmentId)) insertLink(db, { module: 'poct', type: 'poct_devices', id }, { module: 'equipment', type: 'equipment_items', id: parseIntNullable(req.body.equipmentId)! }, 'POCT device linked to equipment record');
    audit(req, { action: 'create', entity: 'poct_devices', entityId: id, newValue: { deviceCode, ...req.body } });
    res.status(201).json({ id, deviceCode });
  });

  router.get('/devices/:id', requirePermission('poct', 'view'), (req, res) => {
    const db = getDb();
    const device = db.prepare('SELECT d.*, s.site_name, e.equipment_number FROM poct_devices d LEFT JOIN poct_sites s ON s.id = d.site_id LEFT JOIN equipment_items e ON e.id = d.equipment_id WHERE d.id = ?').get(req.params.id);
    if (!device) return res.status(404).json({ error: 'Device not found' });
    res.json(device);
  });

  router.put('/devices/:id', requirePermission('poct', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM poct_devices WHERE id = ?').get(req.params.id) as any;
    if (!oldValue) return res.status(404).json({ error: 'Device not found' });
    if (req.body.status && !DEVICE_STATUSES.includes(req.body.status)) return res.status(400).json({ error: `status must be one of: ${DEVICE_STATUSES.join(', ')}` });
    db.prepare(`UPDATE poct_devices SET site_id = ?, equipment_id = ?, device_name = ?, device_type = ?, manufacturer = ?, model = ?, serial_number = ?, test_menu_summary = ?, installation_date = ?, last_service_date = ?, next_service_due = ?, status = ?, notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(parseIntNullable(req.body.siteId) ?? oldValue.site_id, parseIntNullable(req.body.equipmentId) ?? oldValue.equipment_id, req.body.deviceName ?? oldValue.device_name, req.body.deviceType ?? oldValue.device_type, req.body.manufacturer ?? oldValue.manufacturer, req.body.model ?? oldValue.model, req.body.serialNumber ?? oldValue.serial_number, req.body.testMenuSummary ?? oldValue.test_menu_summary, req.body.installationDate ?? oldValue.installation_date, req.body.lastServiceDate ?? oldValue.last_service_date, req.body.nextServiceDue ?? oldValue.next_service_due, req.body.status ?? oldValue.status, req.body.notes ?? oldValue.notes, req.params.id);
    audit(req, { action: 'edit', entity: 'poct_devices', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  router.post('/devices/:id/status', requirePermission('poct', 'edit'), (req, res) => {
    const db = getDb();
    const d = db.prepare('SELECT * FROM poct_devices WHERE id = ?').get(req.params.id) as any;
    if (!d) return res.status(404).json({ error: 'Device not found' });
    if (!req.body.status || !DEVICE_STATUSES.includes(req.body.status)) return res.status(400).json({ error: `status must be one of: ${DEVICE_STATUSES.join(', ')}` });
    db.prepare('UPDATE poct_devices SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.body.status, req.params.id);
    audit(req, { action: 'status_change', entity: 'poct_devices', entityId: req.params.id, oldValue: { status: d.status }, newValue: { status: req.body.status, reason: req.body.reason ?? null } });
    res.json({ ok: true });
  });

  // ============= Tests =============
  router.get('/tests', requirePermission('poct', 'view'), (req, res) => {
    const db = getDb();
    const filters: string[] = []; const params: unknown[] = [];
    if (req.query.isActive !== undefined) { filters.push('is_active = ?'); params.push(req.query.isActive === 'true' ? 1 : 0); }
    let query = 'SELECT * FROM poct_tests';
    if (filters.length) query += ` WHERE ${filters.join(' AND ')}`;
    query += ' ORDER BY test_name';
    res.json(db.prepare(query).all(...params));
  });

  router.post('/tests', requirePermission('poct', 'create'), (req, res) => {
    if (!req.body.testName) return res.status(400).json({ error: 'testName is required' });
    const db = getDb();
    const result = db.prepare(`INSERT INTO poct_tests (test_code, test_name, sample_type, result_unit, method_summary, device_type, clinical_area, is_active, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(req.body.testCode ?? null, req.body.testName, req.body.sampleType ?? null, req.body.resultUnit ?? null, req.body.methodSummary ?? null, req.body.deviceType ?? null, req.body.clinicalArea ?? null, req.body.isActive === false ? 0 : 1, req.user!.id);
    const id = Number(result.lastInsertRowid);
    audit(req, { action: 'create', entity: 'poct_tests', entityId: id, newValue: req.body });
    res.status(201).json({ id });
  });

  router.get('/tests/:id', requirePermission('poct', 'view'), (req, res) => {
    const db = getDb();
    const test = db.prepare('SELECT * FROM poct_tests WHERE id = ?').get(req.params.id);
    if (!test) return res.status(404).json({ error: 'Test not found' });
    res.json(test);
  });

  router.put('/tests/:id', requirePermission('poct', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM poct_tests WHERE id = ?').get(req.params.id) as any;
    if (!oldValue) return res.status(404).json({ error: 'Test not found' });
    db.prepare(`UPDATE poct_tests SET test_code = ?, test_name = ?, sample_type = ?, result_unit = ?, method_summary = ?, device_type = ?, clinical_area = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(req.body.testCode ?? oldValue.test_code, req.body.testName ?? oldValue.test_name, req.body.sampleType ?? oldValue.sample_type, req.body.resultUnit ?? oldValue.result_unit, req.body.methodSummary ?? oldValue.method_summary, req.body.deviceType ?? oldValue.device_type, req.body.clinicalArea ?? oldValue.clinical_area, req.body.isActive !== undefined ? (req.body.isActive ? 1 : 0) : oldValue.is_active, req.params.id);
    audit(req, { action: 'edit', entity: 'poct_tests', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  router.post('/tests/:id/toggle', requirePermission('poct', 'edit'), (req, res) => {
    const db = getDb();
    const t = db.prepare('SELECT * FROM poct_tests WHERE id = ?').get(req.params.id) as any;
    if (!t) return res.status(404).json({ error: 'Test not found' });
    const newActive = t.is_active ? 0 : 1;
    db.prepare('UPDATE poct_tests SET is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(newActive, req.params.id);
    audit(req, { action: 'toggle', entity: 'poct_tests', entityId: req.params.id, oldValue: { is_active: t.is_active }, newValue: { is_active: newActive } });
    res.json({ ok: true, isActive: newActive === 1 });
  });

  // ============= Operator Authorizations =============
  router.get('/authorizations', requirePermission('poct', 'view'), (req, res) => {
    const db = getDb();
    const filters: string[] = []; const params: unknown[] = [];
    if (req.query.staffId) { filters.push('a.staff_id = ?'); params.push(Number(req.query.staffId)); }
    if (req.query.status) { filters.push('a.status = ?'); params.push(String(req.query.status)); }
    let query = `SELECT a.*, s.full_name AS staff_name, ps.site_name, pd.device_name, pt.test_name
      FROM poct_operator_authorizations a
      LEFT JOIN staff s ON s.id = a.staff_id
      LEFT JOIN poct_sites ps ON ps.id = a.site_id
      LEFT JOIN poct_devices pd ON pd.id = a.device_id
      LEFT JOIN poct_tests pt ON pt.id = a.test_id`;
    if (filters.length) query += ` WHERE ${filters.join(' AND ')}`;
    query += ' ORDER BY a.authorized_date DESC, a.id DESC';
    res.json(flagExpired(db.prepare(query).all(...params) as any[], 'expiry_date'));
  });

  router.post('/authorizations', requirePermission('poct', 'create'), (req, res) => {
    if (!parseIntNullable(req.body.staffId)) return res.status(400).json({ error: 'staffId is required' });
    if (!req.body.authorizationLevel) return res.status(400).json({ error: 'authorizationLevel is required' });
    if (!AUTHORIZATION_LEVELS.includes(req.body.authorizationLevel)) return res.status(400).json({ error: `authorizationLevel must be one of: ${AUTHORIZATION_LEVELS.join(', ')}` });
    const status = req.body.status ?? 'draft';
    if (!AUTHORIZATION_STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${AUTHORIZATION_STATUSES.join(', ')}` });
    const db = getDb();
    const createdAt = new Date().toISOString();
    const authorizationNumber = generateRecordNumber(db, 'poct_operator_authorizations', 'POCTA', createdAt);
    const result = db.prepare(`INSERT INTO poct_operator_authorizations (authorization_number, staff_id, site_id, device_id, test_id, competency_assessment_id, authorization_level, authorized_by_staff_id, authorized_date, expiry_date, restrictions, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(authorizationNumber, req.body.staffId, parseIntNullable(req.body.siteId), parseIntNullable(req.body.deviceId), parseIntNullable(req.body.testId), parseIntNullable(req.body.competencyAssessmentId), req.body.authorizationLevel, parseIntNullable(req.body.authorizedByStaffId), req.body.authorizedDate ?? null, req.body.expiryDate ?? null, req.body.restrictions ?? null, status, req.user!.id, createdAt);
    const id = Number(result.lastInsertRowid);
    if (parseIntNullable(req.body.competencyAssessmentId)) insertLink(db, { module: 'poct', type: 'poct_operator_authorizations', id }, { module: 'personnel', type: 'competency_assessments', id: parseIntNullable(req.body.competencyAssessmentId)! }, 'POCT authorization based on competency assessment');
    audit(req, { action: 'create', entity: 'poct_operator_authorizations', entityId: id, newValue: { authorizationNumber, ...req.body } });
    res.status(201).json({ id, authorizationNumber });
  });

  router.get('/authorizations/:id', requirePermission('poct', 'view'), (req, res) => {
    const db = getDb();
    const auth = db.prepare(`SELECT a.*, s.full_name AS staff_name, ps.site_name, pd.device_name, pt.test_name FROM poct_operator_authorizations a LEFT JOIN staff s ON s.id = a.staff_id LEFT JOIN poct_sites ps ON ps.id = a.site_id LEFT JOIN poct_devices pd ON pd.id = a.device_id LEFT JOIN poct_tests pt ON pt.id = a.test_id WHERE a.id = ?`).get(req.params.id) as any;
    if (!auth) return res.status(404).json({ error: 'Authorization not found' });
    const today = new Date().toISOString().slice(0, 10);
    res.json({ ...auth, _expired: auth.expiry_date && auth.expiry_date < today });
  });

  router.put('/authorizations/:id', requirePermission('poct', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM poct_operator_authorizations WHERE id = ?').get(req.params.id) as any;
    if (!oldValue) return res.status(404).json({ error: 'Authorization not found' });
    if (req.body.status && !AUTHORIZATION_STATUSES.includes(req.body.status)) return res.status(400).json({ error: `status must be one of: ${AUTHORIZATION_STATUSES.join(', ')}` });
    if (req.body.authorizationLevel && !AUTHORIZATION_LEVELS.includes(req.body.authorizationLevel)) return res.status(400).json({ error: `authorizationLevel must be one of: ${AUTHORIZATION_LEVELS.join(', ')}` });
    db.prepare(`UPDATE poct_operator_authorizations SET site_id = ?, device_id = ?, test_id = ?, competency_assessment_id = ?, authorization_level = ?, authorized_by_staff_id = ?, authorized_date = ?, expiry_date = ?, restrictions = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(parseIntNullable(req.body.siteId) ?? oldValue.site_id, parseIntNullable(req.body.deviceId) ?? oldValue.device_id, parseIntNullable(req.body.testId) ?? oldValue.test_id, parseIntNullable(req.body.competencyAssessmentId) ?? oldValue.competency_assessment_id, req.body.authorizationLevel ?? oldValue.authorization_level, parseIntNullable(req.body.authorizedByStaffId) ?? oldValue.authorized_by_staff_id, req.body.authorizedDate ?? oldValue.authorized_date, req.body.expiryDate ?? oldValue.expiry_date, req.body.restrictions ?? oldValue.restrictions, req.body.status ?? oldValue.status, req.params.id);
    audit(req, { action: 'edit', entity: 'poct_operator_authorizations', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  router.post('/authorizations/:id/approve', requirePermission('poct', 'approve'), (req, res) => {
    const db = getDb();
    const auth = db.prepare('SELECT * FROM poct_operator_authorizations WHERE id = ?').get(req.params.id) as any;
    if (!auth) return res.status(404).json({ error: 'Authorization not found' });
    const approver = getStaffIdOrCurrent(req, req.body.authorizedByStaffId);
    if (approver === null) return res.status(400).json({ error: 'This action requires the logged-in user to be linked to a staff record.' });
    db.prepare("UPDATE poct_operator_authorizations SET status = 'active', authorized_by_staff_id = ?, authorized_date = COALESCE(authorized_date, date('now')), updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(approver, req.params.id);
    audit(req, { action: 'approve', entity: 'poct_operator_authorizations', entityId: req.params.id, oldValue: { status: auth.status }, newValue: { status: 'active', authorizedByStaffId: approver } });
    res.json({ ok: true });
  });

  router.post('/authorizations/:id/revoke', requirePermission('poct', 'approve'), (req, res) => {
    const db = getDb();
    const auth = db.prepare('SELECT * FROM poct_operator_authorizations WHERE id = ?').get(req.params.id) as any;
    if (!auth) return res.status(404).json({ error: 'Authorization not found' });
    db.prepare("UPDATE poct_operator_authorizations SET status = 'revoked', restrictions = COALESCE(?, restrictions), updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.body.reason ?? null, req.params.id);
    audit(req, { action: 'revoke', entity: 'poct_operator_authorizations', entityId: req.params.id, oldValue: { status: auth.status }, newValue: { status: 'revoked', reason: req.body.reason ?? null } });
    res.json({ ok: true });
  });

  // ============= Reagent Lots =============
  router.get('/reagent-lots', requirePermission('poct', 'view'), (req, res) => {
    const db = getDb();
    const filters: string[] = []; const params: unknown[] = [];
    if (req.query.deviceId) { filters.push('rl.device_id = ?'); params.push(Number(req.query.deviceId)); }
    if (req.query.status) { filters.push('rl.status = ?'); params.push(String(req.query.status)); }
    let query = `SELECT rl.*, pd.device_name, pt.test_name FROM poct_reagent_lots rl LEFT JOIN poct_devices pd ON pd.id = rl.device_id LEFT JOIN poct_tests pt ON pt.id = rl.test_id`;
    if (filters.length) query += ` WHERE ${filters.join(' AND ')}`;
    query += ' ORDER BY rl.expiry_date';
    res.json(flagExpired(db.prepare(query).all(...params) as any[], 'expiry_date'));
  });

  router.post('/reagent-lots', requirePermission('poct', 'create'), (req, res) => {
    if (!req.body.lotNumber) return res.status(400).json({ error: 'lotNumber is required' });
    if (!req.body.reagentName) return res.status(400).json({ error: 'reagentName is required' });
    if (!req.body.expiryDate) return res.status(400).json({ error: 'expiryDate is required' });
    const status = req.body.status ?? 'received';
    if (!REAGENT_STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${REAGENT_STATUSES.join(', ')}` });
    const db = getDb();
    const result = db.prepare(`INSERT INTO poct_reagent_lots (lot_number, reagent_name, device_id, test_id, manufacturer, received_date, opened_date, expiry_date, storage_condition, inventory_batch_id, status, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(req.body.lotNumber, req.body.reagentName, parseIntNullable(req.body.deviceId), parseIntNullable(req.body.testId), req.body.manufacturer ?? null, req.body.receivedDate ?? null, req.body.openedDate ?? null, req.body.expiryDate, req.body.storageCondition ?? null, parseIntNullable(req.body.inventoryBatchId), status, req.body.notes ?? null, req.user!.id);
    const id = Number(result.lastInsertRowid);
    if (parseIntNullable(req.body.inventoryBatchId)) insertLink(db, { module: 'poct', type: 'poct_reagent_lots', id }, { module: 'supplier_inventory', type: 'inventory_batches', id: parseIntNullable(req.body.inventoryBatchId)! }, 'POCT reagent lot linked to inventory batch');
    audit(req, { action: 'create', entity: 'poct_reagent_lots', entityId: id, newValue: req.body });
    res.status(201).json({ id });
  });

  router.get('/reagent-lots/:id', requirePermission('poct', 'view'), (req, res) => {
    const db = getDb();
    const lot = db.prepare(`SELECT rl.*, pd.device_name, pt.test_name FROM poct_reagent_lots rl LEFT JOIN poct_devices pd ON pd.id = rl.device_id LEFT JOIN poct_tests pt ON pt.id = rl.test_id WHERE rl.id = ?`).get(req.params.id);
    if (!lot) return res.status(404).json({ error: 'Reagent lot not found' });
    res.json(lot);
  });

  router.put('/reagent-lots/:id', requirePermission('poct', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM poct_reagent_lots WHERE id = ?').get(req.params.id) as any;
    if (!oldValue) return res.status(404).json({ error: 'Reagent lot not found' });
    if (req.body.status && !REAGENT_STATUSES.includes(req.body.status)) return res.status(400).json({ error: `status must be one of: ${REAGENT_STATUSES.join(', ')}` });
    db.prepare(`UPDATE poct_reagent_lots SET lot_number = ?, reagent_name = ?, device_id = ?, test_id = ?, manufacturer = ?, received_date = ?, opened_date = ?, expiry_date = ?, storage_condition = ?, inventory_batch_id = ?, status = ?, notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(req.body.lotNumber ?? oldValue.lot_number, req.body.reagentName ?? oldValue.reagent_name, parseIntNullable(req.body.deviceId) ?? oldValue.device_id, parseIntNullable(req.body.testId) ?? oldValue.test_id, req.body.manufacturer ?? oldValue.manufacturer, req.body.receivedDate ?? oldValue.received_date, req.body.openedDate ?? oldValue.opened_date, req.body.expiryDate ?? oldValue.expiry_date, req.body.storageCondition ?? oldValue.storage_condition, parseIntNullable(req.body.inventoryBatchId) ?? oldValue.inventory_batch_id, req.body.status ?? oldValue.status, req.body.notes ?? oldValue.notes, req.params.id);
    audit(req, { action: 'edit', entity: 'poct_reagent_lots', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  router.post('/reagent-lots/:id/status', requirePermission('poct', 'edit'), (req, res) => {
    const db = getDb();
    const lot = db.prepare('SELECT * FROM poct_reagent_lots WHERE id = ?').get(req.params.id) as any;
    if (!lot) return res.status(404).json({ error: 'Reagent lot not found' });
    if (!req.body.status || !REAGENT_STATUSES.includes(req.body.status)) return res.status(400).json({ error: `status must be one of: ${REAGENT_STATUSES.join(', ')}` });
    db.prepare('UPDATE poct_reagent_lots SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.body.status, req.params.id);
    audit(req, { action: 'status_change', entity: 'poct_reagent_lots', entityId: req.params.id, oldValue: { status: lot.status }, newValue: { status: req.body.status } });
    res.json({ ok: true });
  });

  // ============= QC =============
  router.get('/qc-materials', requirePermission('poct', 'view'), (_req, res) => {
    const db = getDb();
    res.json(db.prepare(`SELECT m.*, pd.device_name, pt.test_name FROM poct_qc_materials m LEFT JOIN poct_devices pd ON pd.id = m.device_id LEFT JOIN poct_tests pt ON pt.id = m.test_id ORDER BY m.material_name`).all());
  });

  router.post('/qc-materials', requirePermission('poct', 'create'), (req, res) => {
    if (!req.body.materialName) return res.status(400).json({ error: 'materialName is required' });
    const db = getDb();
    const result = db.prepare(`INSERT INTO poct_qc_materials (material_code, material_name, device_id, test_id, lot_number, manufacturer, expiry_date, target_value, acceptable_low, acceptable_high, iqc_material_id, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(req.body.materialCode ?? null, req.body.materialName, parseIntNullable(req.body.deviceId), parseIntNullable(req.body.testId), req.body.lotNumber ?? null, req.body.manufacturer ?? null, req.body.expiryDate ?? null, req.body.targetValue !== undefined && req.body.targetValue !== '' ? Number(req.body.targetValue) : null, req.body.acceptableLow !== undefined && req.body.acceptableLow !== '' ? Number(req.body.acceptableLow) : null, req.body.acceptableHigh !== undefined && req.body.acceptableHigh !== '' ? Number(req.body.acceptableHigh) : null, parseIntNullable(req.body.iqcMaterialId), req.body.status ?? 'active', req.user!.id);
    const id = Number(result.lastInsertRowid);
    audit(req, { action: 'create', entity: 'poct_qc_materials', entityId: id, newValue: req.body });
    res.status(201).json({ id });
  });

  router.get('/qc-results', requirePermission('poct', 'view'), (req, res) => {
    const db = getDb();
    const filters: string[] = []; const params: unknown[] = [];
    if (req.query.deviceId) { filters.push('r.device_id = ?'); params.push(Number(req.query.deviceId)); }
    if (req.query.status) { filters.push('r.status = ?'); params.push(String(req.query.status)); }
    let query = `SELECT r.*, pd.device_name, pt.test_name, m.material_name, s.full_name AS performed_by_name FROM poct_qc_results r LEFT JOIN poct_devices pd ON pd.id = r.device_id LEFT JOIN poct_tests pt ON pt.id = r.test_id LEFT JOIN poct_qc_materials m ON m.id = r.qc_material_id LEFT JOIN staff s ON s.id = r.performed_by_staff_id`;
    if (filters.length) query += ` WHERE ${filters.join(' AND ')}`;
    query += ' ORDER BY r.qc_date DESC, r.id DESC LIMIT 500';
    res.json(db.prepare(query).all(...params));
  });

  router.post('/qc-results', requirePermission('poct', 'create'), (req, res) => {
    if (!req.body.qcDate) return res.status(400).json({ error: 'qcDate is required' });
    if (!parseIntNullable(req.body.deviceId)) return res.status(400).json({ error: 'deviceId is required' });
    if (!parseIntNullable(req.body.testId)) return res.status(400).json({ error: 'testId is required' });
    if (req.body.resultValue === undefined || req.body.resultValue === null || req.body.resultValue === '') return res.status(400).json({ error: 'resultValue is required' });
    const value = Number(req.body.resultValue);
    if (!Number.isFinite(value)) return res.status(400).json({ error: 'resultValue must be numeric' });
    const db = getDb();
    const material = parseIntNullable(req.body.qcMaterialId) ? db.prepare('SELECT * FROM poct_qc_materials WHERE id = ?').get(parseIntNullable(req.body.qcMaterialId)) as any : null;
    let interpretation = req.body.interpretation ?? null;
    let status = req.body.status ?? null;
    if (material && material.acceptable_low !== null && material.acceptable_high !== null) {
      if (value < Number(material.acceptable_low) || value > Number(material.acceptable_high)) {
        interpretation = interpretation || 'out_of_range';
        status = status || 'failed';
      } else {
        interpretation = interpretation || 'within_range';
        status = status || 'accepted';
      }
    }
    if (!status) status = 'pending_review';
    if (!QC_STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${QC_STATUSES.join(', ')}` });
    if (interpretation && !QC_INTERPRETATIONS.includes(interpretation)) return res.status(400).json({ error: `interpretation must be one of: ${QC_INTERPRETATIONS.join(', ')}` });
    if (status === 'failed' && !req.body.immediateAction) return res.status(400).json({ error: 'immediateAction is required for failed QC results' });
    const createdAt = new Date().toISOString();
    const qcNumber = generateRecordNumber(db, 'poct_qc_results', 'POCTQC', createdAt);
    const performedBy = getStaffIdOrCurrent(req, req.body.performedByStaffId);
    const result = db.prepare(`INSERT INTO poct_qc_results (qc_number, site_id, device_id, test_id, qc_material_id, reagent_lot_id, qc_date, qc_time, result_value, expected_result, interpretation, performed_by_staff_id, immediate_action, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(qcNumber, parseIntNullable(req.body.siteId), req.body.deviceId, req.body.testId, parseIntNullable(req.body.qcMaterialId), parseIntNullable(req.body.reagentLotId), req.body.qcDate, req.body.qcTime ?? null, value, req.body.expectedResult ?? null, interpretation, performedBy, req.body.immediateAction ?? null, status, req.user!.id, createdAt);
    const id = Number(result.lastInsertRowid);
    audit(req, { action: 'create', entity: 'poct_qc_results', entityId: id, newValue: { qcNumber, value, status, interpretation, ...req.body } });
    res.status(201).json({ id, qcNumber, status, interpretation });
  });

  router.get('/qc-results/:id', requirePermission('poct', 'view'), (req, res) => {
    const db = getDb();
    const qc = db.prepare(`SELECT r.*, pd.device_name, pt.test_name, m.material_name FROM poct_qc_results r LEFT JOIN poct_devices pd ON pd.id = r.device_id LEFT JOIN poct_tests pt ON pt.id = r.test_id LEFT JOIN poct_qc_materials m ON m.id = r.qc_material_id WHERE r.id = ?`).get(req.params.id);
    if (!qc) return res.status(404).json({ error: 'QC result not found' });
    res.json(qc);
  });

  router.post('/qc-results/:id/review', requirePermission('poct', 'edit'), (req, res) => {
    const db = getDb();
    const qc = db.prepare('SELECT * FROM poct_qc_results WHERE id = ?').get(req.params.id) as any;
    if (!qc) return res.status(404).json({ error: 'QC result not found' });
    const staffId = getStaffIdOrCurrent(req, req.body.reviewedByStaffId);
    if (staffId === null) return res.status(400).json({ error: 'This action requires the logged-in user to be linked to a staff record.' });
    db.prepare('UPDATE poct_qc_results SET reviewed_by_staff_id = ?, reviewed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(staffId, req.params.id);
    audit(req, { action: 'review', entity: 'poct_qc_results', entityId: req.params.id, newValue: { reviewedByStaffId: staffId } });
    res.json({ ok: true });
  });

  router.post('/qc-results/:id/create-nc', requirePermission('nc_capa', 'create'), (req, res) => {
    const db = getDb();
    const qc = db.prepare('SELECT r.*, pd.device_name, pt.test_name FROM poct_qc_results r LEFT JOIN poct_devices pd ON pd.id = r.device_id LEFT JOIN poct_tests pt ON pt.id = r.test_id WHERE r.id = ?').get(req.params.id) as any;
    if (!qc) return res.status(404).json({ error: 'QC result not found' });
    const createdAt = new Date().toISOString();
    const ncNumber = generateRecordNumber(db, 'nonconforming_events', 'NC', createdAt);
    const detectedBy = getStaffIdOrCurrent(req, req.body.detectedByStaffId ?? qc.performed_by_staff_id);
    const ncResult = db.prepare(`INSERT INTO nonconforming_events (nc_number, event_date, detected_by_staff_id, source_module, source_record_id, title, description, category, severity, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(ncNumber, qc.qc_date, detectedBy, 'poct', String(qc.id), req.body.title ?? `POCT QC failure: ${qc.test_name || ''} on ${qc.device_name || ''}`, req.body.description ?? `QC value ${qc.result_value} flagged ${qc.status}${qc.interpretation ? ` (${qc.interpretation})` : ''}`, req.body.category ?? 'poct', req.body.severity ?? 'medium', 'open', req.user!.id, createdAt);
    const ncId = Number(ncResult.lastInsertRowid);
    db.prepare('UPDATE poct_qc_results SET nc_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(ncId, req.params.id);
    insertLink(db, { module: 'poct', type: 'poct_qc_results', id: qc.id }, { module: 'nc_capa', type: 'nonconforming_events', id: ncId }, 'NC from POCT QC');
    audit(req, { action: 'create', entity: 'nonconforming_events', entityId: ncId, newValue: { ncNumber, sourceModule: 'poct', sourceRecordId: qc.id } });
    res.status(201).json({ id: ncId, ncNumber });
  });

  router.post('/qc-results/:id/create-capa', requirePermission('nc_capa', 'create'), (req, res) => {
    const db = getDb();
    const qc = db.prepare('SELECT * FROM poct_qc_results WHERE id = ?').get(req.params.id) as any;
    if (!qc) return res.status(404).json({ error: 'QC result not found' });
    const createdAt = new Date().toISOString();
    const capaNumber = generateRecordNumber(db, 'capa_records', 'CAPA', createdAt);
    const r = db.prepare(`INSERT INTO capa_records (capa_number, source_module, source_record_id, nc_id, title, problem_summary, responsible_staff_id, due_date, priority, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(capaNumber, 'poct', String(qc.id), qc.nc_id ?? null, req.body.title ?? 'CAPA for POCT QC failure', req.body.problemSummary ?? `QC value ${qc.result_value} flagged ${qc.status}`, parseIntNullable(req.body.responsibleStaffId), req.body.dueDate ?? null, req.body.priority ?? 'normal', 'open', req.user!.id, createdAt);
    const capaId = Number(r.lastInsertRowid);
    db.prepare('UPDATE poct_qc_results SET capa_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(capaId, req.params.id);
    insertLink(db, { module: 'poct', type: 'poct_qc_results', id: qc.id }, { module: 'nc_capa', type: 'capa_records', id: capaId }, 'CAPA from POCT QC');
    audit(req, { action: 'create', entity: 'capa_records', entityId: capaId, newValue: { capaNumber, sourceModule: 'poct', sourceRecordId: qc.id } });
    res.status(201).json({ id: capaId, capaNumber });
  });

  // ============= EQA =============
  router.get('/eqa-events', requirePermission('poct', 'view'), (req, res) => {
    const db = getDb();
    const filters: string[] = []; const params: unknown[] = [];
    if (req.query.status) { filters.push('e.status = ?'); params.push(String(req.query.status)); }
    if (req.query.performanceStatus) { filters.push('e.performance_status = ?'); params.push(String(req.query.performanceStatus)); }
    let query = `SELECT e.*, pd.device_name, pt.test_name, ep.program_name FROM poct_eqa_events e LEFT JOIN poct_devices pd ON pd.id = e.device_id LEFT JOIN poct_tests pt ON pt.id = e.test_id LEFT JOIN eqa_programs ep ON ep.id = e.eqa_program_id`;
    if (filters.length) query += ` WHERE ${filters.join(' AND ')}`;
    query += ' ORDER BY e.due_date DESC, e.id DESC';
    res.json(db.prepare(query).all(...params));
  });

  router.post('/eqa-events', requirePermission('poct', 'create'), (req, res) => {
    if (!req.body.cycleName) return res.status(400).json({ error: 'cycleName is required' });
    if (!parseIntNullable(req.body.testId)) return res.status(400).json({ error: 'testId is required' });
    if (req.body.performanceStatus && !EQA_PERFORMANCE_STATUSES.includes(req.body.performanceStatus)) return res.status(400).json({ error: `performanceStatus must be one of: ${EQA_PERFORMANCE_STATUSES.join(', ')}` });
    const status = req.body.status ?? 'open';
    if (!EQA_STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${EQA_STATUSES.join(', ')}` });
    const db = getDb();
    const createdAt = new Date().toISOString();
    const eventNumber = generateRecordNumber(db, 'poct_eqa_events', 'POCTEQA', createdAt);
    const result = db.prepare(`INSERT INTO poct_eqa_events (event_number, site_id, device_id, test_id, eqa_program_id, cycle_name, received_date, due_date, submitted_date, result_received_date, performance_status, findings, corrective_action_required, responsible_staff_id, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(eventNumber, parseIntNullable(req.body.siteId), parseIntNullable(req.body.deviceId), req.body.testId, parseIntNullable(req.body.eqaProgramId), req.body.cycleName, req.body.receivedDate ?? null, req.body.dueDate ?? null, req.body.submittedDate ?? null, req.body.resultReceivedDate ?? null, req.body.performanceStatus ?? null, req.body.findings ?? null, req.body.correctiveActionRequired ? 1 : 0, parseIntNullable(req.body.responsibleStaffId), status, req.user!.id, createdAt);
    const id = Number(result.lastInsertRowid);
    audit(req, { action: 'create', entity: 'poct_eqa_events', entityId: id, newValue: { eventNumber, ...req.body } });
    res.status(201).json({ id, eventNumber });
  });

  router.get('/eqa-events/:id', requirePermission('poct', 'view'), (req, res) => {
    const db = getDb();
    const event = db.prepare(`SELECT e.*, pd.device_name, pt.test_name, ep.program_name FROM poct_eqa_events e LEFT JOIN poct_devices pd ON pd.id = e.device_id LEFT JOIN poct_tests pt ON pt.id = e.test_id LEFT JOIN eqa_programs ep ON ep.id = e.eqa_program_id WHERE e.id = ?`).get(req.params.id);
    if (!event) return res.status(404).json({ error: 'EQA event not found' });
    res.json(event);
  });

  router.put('/eqa-events/:id', requirePermission('poct', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM poct_eqa_events WHERE id = ?').get(req.params.id) as any;
    if (!oldValue) return res.status(404).json({ error: 'EQA event not found' });
    if (req.body.status && !EQA_STATUSES.includes(req.body.status)) return res.status(400).json({ error: `status must be one of: ${EQA_STATUSES.join(', ')}` });
    if (req.body.performanceStatus && !EQA_PERFORMANCE_STATUSES.includes(req.body.performanceStatus)) return res.status(400).json({ error: `performanceStatus must be one of: ${EQA_PERFORMANCE_STATUSES.join(', ')}` });
    db.prepare(`UPDATE poct_eqa_events SET site_id = ?, device_id = ?, test_id = ?, eqa_program_id = ?, cycle_name = ?, received_date = ?, due_date = ?, submitted_date = ?, result_received_date = ?, performance_status = ?, findings = ?, corrective_action_required = ?, responsible_staff_id = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(parseIntNullable(req.body.siteId) ?? oldValue.site_id, parseIntNullable(req.body.deviceId) ?? oldValue.device_id, parseIntNullable(req.body.testId) ?? oldValue.test_id, parseIntNullable(req.body.eqaProgramId) ?? oldValue.eqa_program_id, req.body.cycleName ?? oldValue.cycle_name, req.body.receivedDate ?? oldValue.received_date, req.body.dueDate ?? oldValue.due_date, req.body.submittedDate ?? oldValue.submitted_date, req.body.resultReceivedDate ?? oldValue.result_received_date, req.body.performanceStatus ?? oldValue.performance_status, req.body.findings ?? oldValue.findings, req.body.correctiveActionRequired !== undefined ? (req.body.correctiveActionRequired ? 1 : 0) : oldValue.corrective_action_required, parseIntNullable(req.body.responsibleStaffId) ?? oldValue.responsible_staff_id, req.body.status ?? oldValue.status, req.params.id);
    audit(req, { action: 'edit', entity: 'poct_eqa_events', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  router.post('/eqa-events/:id/create-nc', requirePermission('nc_capa', 'create'), (req, res) => {
    const db = getDb();
    const event = db.prepare('SELECT * FROM poct_eqa_events WHERE id = ?').get(req.params.id) as any;
    if (!event) return res.status(404).json({ error: 'EQA event not found' });
    const createdAt = new Date().toISOString();
    const ncNumber = generateRecordNumber(db, 'nonconforming_events', 'NC', createdAt);
    const detectedBy = getStaffIdOrCurrent(req, req.body.detectedByStaffId ?? event.responsible_staff_id);
    const ncResult = db.prepare(`INSERT INTO nonconforming_events (nc_number, event_date, detected_by_staff_id, source_module, source_record_id, title, description, category, severity, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(ncNumber, event.due_date ?? createdAt.slice(0, 10), detectedBy, 'poct', String(event.id), req.body.title ?? `POCT EQA finding: ${event.cycle_name}`, req.body.description ?? event.findings ?? 'Unsatisfactory POCT EQA performance', req.body.category ?? 'poct_eqa', req.body.severity ?? 'medium', 'open', req.user!.id, createdAt);
    const ncId = Number(ncResult.lastInsertRowid);
    db.prepare('UPDATE poct_eqa_events SET nc_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(ncId, req.params.id);
    insertLink(db, { module: 'poct', type: 'poct_eqa_events', id: event.id }, { module: 'nc_capa', type: 'nonconforming_events', id: ncId }, 'NC from POCT EQA');
    audit(req, { action: 'create', entity: 'nonconforming_events', entityId: ncId, newValue: { ncNumber, sourceModule: 'poct', sourceRecordId: event.id } });
    res.status(201).json({ id: ncId, ncNumber });
  });

  router.post('/eqa-events/:id/create-capa', requirePermission('nc_capa', 'create'), (req, res) => {
    const db = getDb();
    const event = db.prepare('SELECT * FROM poct_eqa_events WHERE id = ?').get(req.params.id) as any;
    if (!event) return res.status(404).json({ error: 'EQA event not found' });
    const createdAt = new Date().toISOString();
    const capaNumber = generateRecordNumber(db, 'capa_records', 'CAPA', createdAt);
    const r = db.prepare(`INSERT INTO capa_records (capa_number, source_module, source_record_id, nc_id, title, problem_summary, responsible_staff_id, due_date, priority, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(capaNumber, 'poct', String(event.id), event.nc_id ?? null, req.body.title ?? 'CAPA for POCT EQA finding', req.body.problemSummary ?? event.findings ?? '', parseIntNullable(req.body.responsibleStaffId), req.body.dueDate ?? null, req.body.priority ?? 'normal', 'open', req.user!.id, createdAt);
    const capaId = Number(r.lastInsertRowid);
    db.prepare('UPDATE poct_eqa_events SET capa_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(capaId, req.params.id);
    insertLink(db, { module: 'poct', type: 'poct_eqa_events', id: event.id }, { module: 'nc_capa', type: 'capa_records', id: capaId }, 'CAPA from POCT EQA');
    audit(req, { action: 'create', entity: 'capa_records', entityId: capaId, newValue: { capaNumber, sourceModule: 'poct', sourceRecordId: event.id } });
    res.status(201).json({ id: capaId, capaNumber });
  });

  router.post('/eqa-events/:id/close', requirePermission('poct', 'approve'), (req, res) => {
    const db = getDb();
    const event = db.prepare('SELECT * FROM poct_eqa_events WHERE id = ?').get(req.params.id) as any;
    if (!event) return res.status(404).json({ error: 'EQA event not found' });
    db.prepare("UPDATE poct_eqa_events SET status = 'closed', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
    audit(req, { action: 'close', entity: 'poct_eqa_events', entityId: req.params.id, oldValue: { status: event.status }, newValue: { status: 'closed' } });
    res.json({ ok: true });
  });

  // ============= Maintenance =============
  router.get('/maintenance', requirePermission('poct', 'view'), (req, res) => {
    const db = getDb();
    const filters: string[] = []; const params: unknown[] = [];
    if (req.query.deviceId) { filters.push('m.device_id = ?'); params.push(Number(req.query.deviceId)); }
    if (req.query.status) { filters.push('m.status = ?'); params.push(String(req.query.status)); }
    let query = `SELECT m.*, pd.device_name, s.full_name AS performed_by_name FROM poct_maintenance_logs m LEFT JOIN poct_devices pd ON pd.id = m.device_id LEFT JOIN staff s ON s.id = m.performed_by_staff_id`;
    if (filters.length) query += ` WHERE ${filters.join(' AND ')}`;
    query += ' ORDER BY m.maintenance_date DESC, m.id DESC';
    res.json(db.prepare(query).all(...params));
  });

  router.post('/maintenance', requirePermission('poct', 'create'), (req, res) => {
    if (!parseIntNullable(req.body.deviceId)) return res.status(400).json({ error: 'deviceId is required' });
    if (!req.body.maintenanceDate) return res.status(400).json({ error: 'maintenanceDate is required' });
    if (!req.body.maintenanceType) return res.status(400).json({ error: 'maintenanceType is required' });
    if (!MAINTENANCE_TYPES.includes(req.body.maintenanceType)) return res.status(400).json({ error: `maintenanceType must be one of: ${MAINTENANCE_TYPES.join(', ')}` });
    if (!req.body.description) return res.status(400).json({ error: 'description is required' });
    const status = req.body.status ?? 'completed';
    if (!MAINTENANCE_STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${MAINTENANCE_STATUSES.join(', ')}` });
    const db = getDb();
    const createdAt = new Date().toISOString();
    const maintenanceNumber = generateRecordNumber(db, 'poct_maintenance_logs', 'POCTM', createdAt);
    const performedBy = getStaffIdOrCurrent(req, req.body.performedByStaffId);
    const result = db.prepare(`INSERT INTO poct_maintenance_logs (maintenance_number, site_id, device_id, maintenance_date, maintenance_type, description, performed_by_staff_id, outcome, next_due_date, evidence_file_id, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(maintenanceNumber, parseIntNullable(req.body.siteId), req.body.deviceId, req.body.maintenanceDate, req.body.maintenanceType, req.body.description, performedBy, req.body.outcome ?? null, req.body.nextDueDate ?? null, parseIntNullable(req.body.evidenceFileId), status, req.user!.id, createdAt);
    const id = Number(result.lastInsertRowid);
    if (req.body.nextDueDate) db.prepare('UPDATE poct_devices SET next_service_due = ?, last_service_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.body.nextDueDate, req.body.maintenanceDate, req.body.deviceId);
    audit(req, { action: 'create', entity: 'poct_maintenance_logs', entityId: id, newValue: { maintenanceNumber, ...req.body } });
    res.status(201).json({ id, maintenanceNumber });
  });

  router.get('/maintenance/:id', requirePermission('poct', 'view'), (req, res) => {
    const db = getDb();
    const m = db.prepare(`SELECT m.*, pd.device_name, s.full_name AS performed_by_name FROM poct_maintenance_logs m LEFT JOIN poct_devices pd ON pd.id = m.device_id LEFT JOIN staff s ON s.id = m.performed_by_staff_id WHERE m.id = ?`).get(req.params.id);
    if (!m) return res.status(404).json({ error: 'Maintenance record not found' });
    res.json(m);
  });

  router.put('/maintenance/:id', requirePermission('poct', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM poct_maintenance_logs WHERE id = ?').get(req.params.id) as any;
    if (!oldValue) return res.status(404).json({ error: 'Maintenance record not found' });
    if (req.body.maintenanceType && !MAINTENANCE_TYPES.includes(req.body.maintenanceType)) return res.status(400).json({ error: `maintenanceType must be one of: ${MAINTENANCE_TYPES.join(', ')}` });
    if (req.body.status && !MAINTENANCE_STATUSES.includes(req.body.status)) return res.status(400).json({ error: `status must be one of: ${MAINTENANCE_STATUSES.join(', ')}` });
    db.prepare(`UPDATE poct_maintenance_logs SET site_id = ?, device_id = ?, maintenance_date = ?, maintenance_type = ?, description = ?, performed_by_staff_id = ?, outcome = ?, next_due_date = ?, evidence_file_id = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(parseIntNullable(req.body.siteId) ?? oldValue.site_id, parseIntNullable(req.body.deviceId) ?? oldValue.device_id, req.body.maintenanceDate ?? oldValue.maintenance_date, req.body.maintenanceType ?? oldValue.maintenance_type, req.body.description ?? oldValue.description, parseIntNullable(req.body.performedByStaffId) ?? oldValue.performed_by_staff_id, req.body.outcome ?? oldValue.outcome, req.body.nextDueDate ?? oldValue.next_due_date, parseIntNullable(req.body.evidenceFileId) ?? oldValue.evidence_file_id, req.body.status ?? oldValue.status, req.params.id);
    audit(req, { action: 'edit', entity: 'poct_maintenance_logs', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  router.post('/maintenance/:id/close', requirePermission('poct', 'approve'), (req, res) => {
    const db = getDb();
    const m = db.prepare('SELECT * FROM poct_maintenance_logs WHERE id = ?').get(req.params.id) as any;
    if (!m) return res.status(404).json({ error: 'Maintenance record not found' });
    db.prepare("UPDATE poct_maintenance_logs SET status = 'closed', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
    audit(req, { action: 'close', entity: 'poct_maintenance_logs', entityId: req.params.id, oldValue: { status: m.status }, newValue: { status: 'closed' } });
    res.json({ ok: true });
  });

  // ============= Incidents =============
  router.get('/incidents', requirePermission('poct', 'view'), (req, res) => {
    const db = getDb();
    const filters: string[] = []; const params: unknown[] = [];
    if (req.query.status) { filters.push('i.status = ?'); params.push(String(req.query.status)); }
    if (req.query.severity) { filters.push('i.severity = ?'); params.push(String(req.query.severity)); }
    let query = `SELECT i.*, ps.site_name, pd.device_name, pt.test_name, s.full_name AS reported_by_name FROM poct_incidents i LEFT JOIN poct_sites ps ON ps.id = i.site_id LEFT JOIN poct_devices pd ON pd.id = i.device_id LEFT JOIN poct_tests pt ON pt.id = i.test_id LEFT JOIN staff s ON s.id = i.reported_by_staff_id`;
    if (filters.length) query += ` WHERE ${filters.join(' AND ')}`;
    query += ' ORDER BY i.incident_date DESC, i.id DESC';
    res.json(db.prepare(query).all(...params));
  });

  router.post('/incidents', requirePermission('poct', 'create'), (req, res) => {
    if (!req.body.incidentDate) return res.status(400).json({ error: 'incidentDate is required' });
    if (!req.body.title) return res.status(400).json({ error: 'title is required' });
    if (!req.body.description) return res.status(400).json({ error: 'description is required' });
    if (!req.body.severity) return res.status(400).json({ error: 'severity is required' });
    if (!INCIDENT_SEVERITIES.includes(req.body.severity)) return res.status(400).json({ error: `severity must be one of: ${INCIDENT_SEVERITIES.join(', ')}` });
    const db = getDb();
    const createdAt = new Date().toISOString();
    const incidentNumber = generateRecordNumber(db, 'poct_incidents', 'POCTI', createdAt);
    const reportedBy = getStaffIdOrCurrent(req, req.body.reportedByStaffId);
    const result = db.prepare(`INSERT INTO poct_incidents (incident_number, incident_date, site_id, device_id, test_id, reported_by_staff_id, title, description, immediate_action, severity, outcome, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(incidentNumber, req.body.incidentDate, parseIntNullable(req.body.siteId), parseIntNullable(req.body.deviceId), parseIntNullable(req.body.testId), reportedBy, req.body.title, req.body.description, req.body.immediateAction ?? null, req.body.severity, req.body.outcome ?? null, 'open', req.user!.id, createdAt);
    const id = Number(result.lastInsertRowid);
    audit(req, { action: 'create', entity: 'poct_incidents', entityId: id, newValue: { incidentNumber, ...req.body } });
    res.status(201).json({ id, incidentNumber });
  });

  router.get('/incidents/:id', requirePermission('poct', 'view'), (req, res) => {
    const db = getDb();
    const i = db.prepare(`SELECT i.*, ps.site_name, pd.device_name, pt.test_name FROM poct_incidents i LEFT JOIN poct_sites ps ON ps.id = i.site_id LEFT JOIN poct_devices pd ON pd.id = i.device_id LEFT JOIN poct_tests pt ON pt.id = i.test_id WHERE i.id = ?`).get(req.params.id);
    if (!i) return res.status(404).json({ error: 'Incident not found' });
    res.json(i);
  });

  router.put('/incidents/:id', requirePermission('poct', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM poct_incidents WHERE id = ?').get(req.params.id) as any;
    if (!oldValue) return res.status(404).json({ error: 'Incident not found' });
    if (req.body.status && !INCIDENT_STATUSES.includes(req.body.status)) return res.status(400).json({ error: `status must be one of: ${INCIDENT_STATUSES.join(', ')}` });
    if (req.body.severity && !INCIDENT_SEVERITIES.includes(req.body.severity)) return res.status(400).json({ error: `severity must be one of: ${INCIDENT_SEVERITIES.join(', ')}` });
    db.prepare(`UPDATE poct_incidents SET incident_date = ?, site_id = ?, device_id = ?, test_id = ?, title = ?, description = ?, immediate_action = ?, severity = ?, outcome = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(req.body.incidentDate ?? oldValue.incident_date, parseIntNullable(req.body.siteId) ?? oldValue.site_id, parseIntNullable(req.body.deviceId) ?? oldValue.device_id, parseIntNullable(req.body.testId) ?? oldValue.test_id, req.body.title ?? oldValue.title, req.body.description ?? oldValue.description, req.body.immediateAction ?? oldValue.immediate_action, req.body.severity ?? oldValue.severity, req.body.outcome ?? oldValue.outcome, req.body.status ?? oldValue.status, req.params.id);
    audit(req, { action: 'edit', entity: 'poct_incidents', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  router.post('/incidents/:id/create-action', requirePermission('actions', 'create'), (req, res) => {
    if (!req.body.title) return res.status(400).json({ error: 'title is required' });
    const db = getDb();
    const inc = db.prepare('SELECT * FROM poct_incidents WHERE id = ?').get(req.params.id) as any;
    if (!inc) return res.status(404).json({ error: 'Incident not found' });
    const r = db.prepare('INSERT INTO actions (title, module_key, source_module, source_record_id, description, priority, assigned_to_staff_id, due_date, status, evidence_required, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(req.body.title, 'poct', 'poct', String(inc.id), req.body.description ?? inc.description, req.body.priority ?? (inc.severity === 'critical' ? 'high' : 'normal'), parseIntNullable(req.body.assignedToStaffId), req.body.dueDate ?? null, 'Not started', req.body.evidenceRequired ? 1 : 0, req.user!.id);
    const actionId = Number(r.lastInsertRowid);
    db.prepare('UPDATE poct_incidents SET action_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(actionId, req.params.id);
    insertLink(db, { module: 'poct', type: 'poct_incidents', id: inc.id }, { module: 'actions', type: 'actions', id: actionId }, 'Action from POCT incident');
    audit(req, { action: 'create', entity: 'actions', entityId: actionId, newValue: { sourceModule: 'poct', sourceRecordId: inc.id, ...req.body } });
    res.status(201).json({ id: actionId });
  });

  router.post('/incidents/:id/create-nc', requirePermission('nc_capa', 'create'), (req, res) => {
    const db = getDb();
    const inc = db.prepare('SELECT * FROM poct_incidents WHERE id = ?').get(req.params.id) as any;
    if (!inc) return res.status(404).json({ error: 'Incident not found' });
    const createdAt = new Date().toISOString();
    const ncNumber = generateRecordNumber(db, 'nonconforming_events', 'NC', createdAt);
    const detectedBy = getStaffIdOrCurrent(req, req.body.detectedByStaffId ?? inc.reported_by_staff_id);
    const ncResult = db.prepare(`INSERT INTO nonconforming_events (nc_number, event_date, detected_by_staff_id, source_module, source_record_id, title, description, category, severity, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(ncNumber, inc.incident_date, detectedBy, 'poct', String(inc.id), req.body.title ?? inc.title, req.body.description ?? inc.description, req.body.category ?? 'poct', req.body.severity ?? inc.severity, 'open', req.user!.id, createdAt);
    const ncId = Number(ncResult.lastInsertRowid);
    db.prepare("UPDATE poct_incidents SET nc_id = ?, status = 'linked_to_nc', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(ncId, req.params.id);
    insertLink(db, { module: 'poct', type: 'poct_incidents', id: inc.id }, { module: 'nc_capa', type: 'nonconforming_events', id: ncId }, 'NC from POCT incident');
    audit(req, { action: 'create', entity: 'nonconforming_events', entityId: ncId, newValue: { ncNumber, sourceModule: 'poct', sourceRecordId: inc.id } });
    res.status(201).json({ id: ncId, ncNumber });
  });

  router.post('/incidents/:id/create-capa', requirePermission('nc_capa', 'create'), (req, res) => {
    const db = getDb();
    const inc = db.prepare('SELECT * FROM poct_incidents WHERE id = ?').get(req.params.id) as any;
    if (!inc) return res.status(404).json({ error: 'Incident not found' });
    const createdAt = new Date().toISOString();
    const capaNumber = generateRecordNumber(db, 'capa_records', 'CAPA', createdAt);
    const r = db.prepare(`INSERT INTO capa_records (capa_number, source_module, source_record_id, nc_id, title, problem_summary, responsible_staff_id, due_date, priority, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(capaNumber, 'poct', String(inc.id), inc.nc_id ?? null, req.body.title ?? `CAPA for POCT incident: ${inc.title}`, req.body.problemSummary ?? inc.description, parseIntNullable(req.body.responsibleStaffId), req.body.dueDate ?? null, req.body.priority ?? (inc.severity === 'critical' ? 'high' : 'normal'), 'open', req.user!.id, createdAt);
    const capaId = Number(r.lastInsertRowid);
    db.prepare("UPDATE poct_incidents SET capa_id = ?, status = 'linked_to_capa', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(capaId, req.params.id);
    insertLink(db, { module: 'poct', type: 'poct_incidents', id: inc.id }, { module: 'nc_capa', type: 'capa_records', id: capaId }, 'CAPA from POCT incident');
    audit(req, { action: 'create', entity: 'capa_records', entityId: capaId, newValue: { capaNumber, sourceModule: 'poct', sourceRecordId: inc.id } });
    res.status(201).json({ id: capaId, capaNumber });
  });

  router.post('/incidents/:id/close', requirePermission('poct', 'approve'), (req, res) => {
    const db = getDb();
    const inc = db.prepare('SELECT * FROM poct_incidents WHERE id = ?').get(req.params.id) as any;
    if (!inc) return res.status(404).json({ error: 'Incident not found' });
    const closedBy = getStaffIdOrCurrent(req, req.body.closedByStaffId);
    if (closedBy === null) return res.status(400).json({ error: 'This action requires the logged-in user to be linked to a staff record.' });
    db.prepare("UPDATE poct_incidents SET status = 'closed', closed_by_staff_id = ?, closed_at = CURRENT_TIMESTAMP, outcome = COALESCE(?, outcome), updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(closedBy, req.body.outcome ?? null, req.params.id);
    audit(req, { action: 'close', entity: 'poct_incidents', entityId: req.params.id, oldValue: { status: inc.status }, newValue: { status: 'closed', closedByStaffId: closedBy } });
    res.json({ ok: true });
  });

  // ============= Monthly Reviews =============
  router.get('/monthly-reviews', requirePermission('poct', 'view'), (req, res) => {
    const db = getDb();
    const filters: string[] = []; const params: unknown[] = [];
    if (req.query.siteId) { filters.push('mr.site_id = ?'); params.push(Number(req.query.siteId)); }
    let query = `SELECT mr.*, ps.site_name FROM poct_monthly_reviews mr LEFT JOIN poct_sites ps ON ps.id = mr.site_id`;
    if (filters.length) query += ` WHERE ${filters.join(' AND ')}`;
    query += ' ORDER BY mr.review_year DESC, mr.review_month DESC, mr.id DESC';
    res.json(db.prepare(query).all(...params));
  });

  router.post('/monthly-reviews', requirePermission('poct', 'create'), (req, res) => {
    const month = parseIntNullable(req.body.reviewMonth);
    const year = parseIntNullable(req.body.reviewYear);
    if (month === null || month < 1 || month > 12) return res.status(400).json({ error: 'reviewMonth is required (1-12)' });
    if (year === null || year < 2000) return res.status(400).json({ error: 'reviewYear is required (>=2000)' });
    const status = req.body.status ?? 'draft';
    if (!REVIEW_STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${REVIEW_STATUSES.join(', ')}` });
    const db = getDb();
    const createdAt = new Date().toISOString();
    const reviewNumber = generateRecordNumber(db, 'poct_monthly_reviews', 'POCTR', createdAt);
    const result = db.prepare(`INSERT INTO poct_monthly_reviews (review_number, review_month, review_year, site_id, summary, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(reviewNumber, month, year, parseIntNullable(req.body.siteId), req.body.summary ?? null, status, req.user!.id, createdAt);
    const id = Number(result.lastInsertRowid);
    audit(req, { action: 'create', entity: 'poct_monthly_reviews', entityId: id, newValue: { reviewNumber, ...req.body } });
    res.status(201).json({ id, reviewNumber });
  });

  router.get('/monthly-reviews/:id', requirePermission('poct', 'view'), (req, res) => {
    const db = getDb();
    const review = db.prepare(`SELECT mr.*, ps.site_name FROM poct_monthly_reviews mr LEFT JOIN poct_sites ps ON ps.id = mr.site_id WHERE mr.id = ?`).get(req.params.id);
    if (!review) return res.status(404).json({ error: 'Monthly review not found' });
    res.json(review);
  });

  router.put('/monthly-reviews/:id', requirePermission('poct', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM poct_monthly_reviews WHERE id = ?').get(req.params.id) as any;
    if (!oldValue) return res.status(404).json({ error: 'Monthly review not found' });
    if (req.body.status && !REVIEW_STATUSES.includes(req.body.status)) return res.status(400).json({ error: `status must be one of: ${REVIEW_STATUSES.join(', ')}` });
    db.prepare(`UPDATE poct_monthly_reviews SET site_id = ?, summary = ?, qc_summary = ?, eqa_summary = ?, operator_authorization_summary = ?, device_issue_summary = ?, incidents_summary = ?, actions_required = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(parseIntNullable(req.body.siteId) ?? oldValue.site_id, req.body.summary ?? oldValue.summary, req.body.qcSummary ?? oldValue.qc_summary, req.body.eqaSummary ?? oldValue.eqa_summary, req.body.operatorAuthorizationSummary ?? oldValue.operator_authorization_summary, req.body.deviceIssueSummary ?? oldValue.device_issue_summary, req.body.incidentsSummary ?? oldValue.incidents_summary, req.body.actionsRequired ?? oldValue.actions_required, req.body.status ?? oldValue.status, req.params.id);
    audit(req, { action: 'edit', entity: 'poct_monthly_reviews', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  router.post('/monthly-reviews/:id/generate-summary', requirePermission('poct', 'edit'), (req, res) => {
    const db = getDb();
    const review = db.prepare('SELECT * FROM poct_monthly_reviews WHERE id = ?').get(req.params.id) as any;
    if (!review) return res.status(404).json({ error: 'Monthly review not found' });
    const monthStart = `${review.review_year}-${String(review.review_month).padStart(2, '0')}-01`;
    const monthEndDate = new Date(review.review_year, review.review_month, 0).toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    const siteFilter = review.site_id ? ' AND site_id = ?' : '';
    const siteArg: unknown[] = review.site_id ? [review.site_id] : [];
    const count = (sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { count: number }).count;
    const activeSites = count("SELECT COUNT(*) count FROM poct_sites WHERE status = 'active'" + (review.site_id ? ' AND id = ?' : ''), ...siteArg);
    const activeDevices = count("SELECT COUNT(*) count FROM poct_devices WHERE status = 'active'" + siteFilter, ...siteArg);
    const operatorsAuthorized = count("SELECT COUNT(DISTINCT staff_id) count FROM poct_operator_authorizations WHERE status = 'active' AND (expiry_date IS NULL OR expiry_date >= ?)" + (review.site_id ? ' AND site_id = ?' : ''), today, ...siteArg);
    const expiredAuthorizations = count("SELECT COUNT(*) count FROM poct_operator_authorizations WHERE expiry_date IS NOT NULL AND expiry_date < ? AND status NOT IN ('revoked')" + (review.site_id ? ' AND site_id = ?' : ''), today, ...siteArg);
    const qcResults = count("SELECT COUNT(*) count FROM poct_qc_results WHERE qc_date BETWEEN ? AND ?" + siteFilter, monthStart, monthEndDate, ...siteArg);
    const qcFailed = count("SELECT COUNT(*) count FROM poct_qc_results WHERE status IN ('failed','warning') AND qc_date BETWEEN ? AND ?" + siteFilter, monthStart, monthEndDate, ...siteArg);
    const eqaEvents = count("SELECT COUNT(*) count FROM poct_eqa_events WHERE (due_date BETWEEN ? AND ? OR submitted_date BETWEEN ? AND ?)" + siteFilter, monthStart, monthEndDate, monthStart, monthEndDate, ...siteArg);
    const eqaUnsat = count("SELECT COUNT(*) count FROM poct_eqa_events WHERE performance_status = 'unsatisfactory' AND (due_date BETWEEN ? AND ? OR submitted_date BETWEEN ? AND ?)" + siteFilter, monthStart, monthEndDate, monthStart, monthEndDate, ...siteArg);
    const openIncidents = count("SELECT COUNT(*) count FROM poct_incidents WHERE status != 'closed'" + siteFilter, ...siteArg);
    const maintenanceDue = count("SELECT COUNT(*) count FROM poct_devices WHERE next_service_due IS NOT NULL AND next_service_due <= ?" + (review.site_id ? ' AND site_id = ?' : ''), monthEndDate, ...siteArg);
    const qcSummary = `${qcResults} QC results recorded; ${qcFailed} flagged warning/failed.`;
    const eqaSummary = `${eqaEvents} EQA events in scope; ${eqaUnsat} unsatisfactory.`;
    const operatorSummary = `${operatorsAuthorized} authorised operators; ${expiredAuthorizations} expired authorisation(s).`;
    const deviceSummary = `${activeDevices} active POCT device(s); ${maintenanceDue} due for maintenance.`;
    const incidentSummary = `${openIncidents} open POCT incident(s).`;
    db.prepare(`UPDATE poct_monthly_reviews SET qc_summary = ?, eqa_summary = ?, operator_authorization_summary = ?, device_issue_summary = ?, incidents_summary = ?, status = CASE WHEN status = 'draft' THEN 'draft' ELSE status END, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(qcSummary, eqaSummary, operatorSummary, deviceSummary, incidentSummary, req.params.id);
    audit(req, { action: 'generate_summary', entity: 'poct_monthly_reviews', entityId: req.params.id, newValue: { activeSites, activeDevices, operatorsAuthorized, expiredAuthorizations, qcResults, qcFailed, eqaEvents, eqaUnsat, openIncidents, maintenanceDue } });
    res.json({ ok: true, counts: { activeSites, activeDevices, operatorsAuthorized, expiredAuthorizations, qcResults, qcFailed, eqaEvents, eqaUnsat, openIncidents, maintenanceDue } });
  });

  router.post('/monthly-reviews/:id/review', requirePermission('poct', 'edit'), (req, res) => {
    const db = getDb();
    const review = db.prepare('SELECT * FROM poct_monthly_reviews WHERE id = ?').get(req.params.id) as any;
    if (!review) return res.status(404).json({ error: 'Monthly review not found' });
    const staffId = getStaffIdOrCurrent(req, req.body.reviewedByStaffId);
    if (staffId === null) return res.status(400).json({ error: 'This action requires the logged-in user to be linked to a staff record.' });
    db.prepare("UPDATE poct_monthly_reviews SET reviewed_by_staff_id = ?, reviewed_at = CURRENT_TIMESTAMP, status = 'reviewed', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(staffId, req.params.id);
    audit(req, { action: 'review', entity: 'poct_monthly_reviews', entityId: req.params.id, oldValue: { status: review.status }, newValue: { status: 'reviewed', reviewedByStaffId: staffId } });
    res.json({ ok: true });
  });

  router.post('/monthly-reviews/:id/approve', requirePermission('poct', 'approve'), (req, res) => {
    const db = getDb();
    const review = db.prepare('SELECT * FROM poct_monthly_reviews WHERE id = ?').get(req.params.id) as any;
    if (!review) return res.status(404).json({ error: 'Monthly review not found' });
    const staffId = getStaffIdOrCurrent(req, req.body.approvedByStaffId);
    if (staffId === null) return res.status(400).json({ error: 'This action requires the logged-in user to be linked to a staff record.' });
    db.prepare("UPDATE poct_monthly_reviews SET approved_by_staff_id = ?, approved_at = CURRENT_TIMESTAMP, status = 'approved', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(staffId, req.params.id);
    audit(req, { action: 'approve', entity: 'poct_monthly_reviews', entityId: req.params.id, oldValue: { status: review.status }, newValue: { status: 'approved', approvedByStaffId: staffId } });
    res.json({ ok: true });
  });

  router.post('/monthly-reviews/:id/close', requirePermission('poct', 'approve'), (req, res) => {
    const db = getDb();
    const review = db.prepare('SELECT * FROM poct_monthly_reviews WHERE id = ?').get(req.params.id) as any;
    if (!review) return res.status(404).json({ error: 'Monthly review not found' });
    db.prepare("UPDATE poct_monthly_reviews SET status = 'closed', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
    audit(req, { action: 'close', entity: 'poct_monthly_reviews', entityId: req.params.id, oldValue: { status: review.status }, newValue: { status: 'closed' } });
    res.json({ ok: true });
  });

  return router;
}

export { SITE_STATUSES, DEVICE_STATUSES, AUTHORIZATION_LEVELS, AUTHORIZATION_STATUSES, QC_STATUSES, QC_INTERPRETATIONS, EQA_PERFORMANCE_STATUSES, EQA_STATUSES, MAINTENANCE_TYPES, MAINTENANCE_STATUSES, INCIDENT_STATUSES, INCIDENT_SEVERITIES, REVIEW_STATUSES, REAGENT_STATUSES };
