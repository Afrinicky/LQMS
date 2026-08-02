import { Router } from 'express';
import { getDb } from '../db/database.js';
import { requirePermission } from '../middleware/permissions.js';
import { audit } from '../services/auditService.js';
import { generateRecordNumber } from '../utils/recordNumber.js';
import { parseIntNullable, getStaffIdOrCurrent } from './routeHelpers.js';

function computeReadingStatus(value: number, item: any): string {
  const lower = item.lower_limit;
  const upper = item.upper_limit;
  const warnLower = item.warning_lower_limit;
  const warnUpper = item.warning_upper_limit;
  const critLower = item.critical_lower_limit;
  const critUpper = item.critical_upper_limit;

  if ((critLower !== null && value < critLower) || (critUpper !== null && value > critUpper)) return 'critical';
  if ((lower !== null && value < lower) || (upper !== null && value > upper)) return 'out_of_range';
  if ((warnLower !== null && value < warnLower) || (warnUpper !== null && value > warnUpper)) return 'warning';
  return 'normal';
}

export function monitoringRoutes() {
  const router = Router();

  // Legacy flat monitoring_records (kept for backward compatibility)
  router.get('/', requirePermission('monitoring', 'view'), (_req, res) => {
    const db = getDb();
    res.json(db.prepare('SELECT * FROM monitoring_records ORDER BY created_at DESC').all());
  });

  router.post('/', requirePermission('monitoring', 'create'), (req, res) => {
    const db = getDb();
    const createdAt = new Date().toISOString();
    const monitoringNumber = generateRecordNumber(db, 'monitoring_records', 'MON', createdAt);
    const result = db.prepare('INSERT INTO monitoring_records (monitoring_number, parameter, target_range, actual_value, unit, sample_date, location_id, department_id, section_id, status, notes, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        monitoringNumber,
        req.body.parameter,
        req.body.targetRange ?? null,
        req.body.actualValue ?? null,
        req.body.unit ?? null,
        req.body.sampleDate ?? new Date().toISOString(),
        parseIntNullable(req.body.locationId),
        parseIntNullable(req.body.departmentId),
        parseIntNullable(req.body.sectionId),
        req.body.status ?? 'reported',
        req.body.notes ?? null,
        req.user!.id,
        createdAt
      );
    audit(req, { action: 'create', entity: 'monitoring_records', entityId: result.lastInsertRowid, newValue: { monitoringNumber, ...req.body } });
    res.status(201).json({ id: result.lastInsertRowid, monitoringNumber });
  });

  // Monitoring items (the "what to monitor" definitions)
  router.get('/items', requirePermission('monitoring.assets', 'view'), (_req, res) => {
    const db = getDb();
    res.json(db.prepare('SELECT * FROM monitoring_items ORDER BY name').all());
  });

  router.post('/items', requirePermission('monitoring.assets', 'create'), (req, res) => {
    if (!req.body.name) return res.status(400).json({ error: 'name is required' });
    if (!req.body.parameter) return res.status(400).json({ error: 'parameter is required' });
    if (!req.body.unit) return res.status(400).json({ error: 'unit is required' });
    if (req.body.lowerLimit === undefined || req.body.lowerLimit === null || req.body.lowerLimit === '') return res.status(400).json({ error: 'lowerLimit is required' });
    if (req.body.upperLimit === undefined || req.body.upperLimit === null || req.body.upperLimit === '') return res.status(400).json({ error: 'upperLimit is required' });
    const db = getDb();
    const createdAt = new Date().toISOString();
    const itemCode = generateRecordNumber(db, 'monitoring_items', 'MITM', createdAt);
    const result = db.prepare(`INSERT INTO monitoring_items (item_code, name, monitoring_type, parameter, unit, department_id, section_id, location_id, lower_limit, upper_limit, warning_lower_limit, warning_upper_limit, critical_lower_limit, critical_upper_limit, frequency, responsible_staff_id, reviewer_staff_id, nc_trigger_enabled, is_active, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        itemCode,
        req.body.name,
        req.body.monitoringType ?? null,
        req.body.parameter,
        req.body.unit,
        parseIntNullable(req.body.departmentId),
        parseIntNullable(req.body.sectionId),
        parseIntNullable(req.body.locationId),
        Number(req.body.lowerLimit),
        Number(req.body.upperLimit),
        req.body.warningLowerLimit !== undefined && req.body.warningLowerLimit !== '' ? Number(req.body.warningLowerLimit) : null,
        req.body.warningUpperLimit !== undefined && req.body.warningUpperLimit !== '' ? Number(req.body.warningUpperLimit) : null,
        req.body.criticalLowerLimit !== undefined && req.body.criticalLowerLimit !== '' ? Number(req.body.criticalLowerLimit) : null,
        req.body.criticalUpperLimit !== undefined && req.body.criticalUpperLimit !== '' ? Number(req.body.criticalUpperLimit) : null,
        req.body.frequency ?? null,
        parseIntNullable(req.body.responsibleStaffId),
        parseIntNullable(req.body.reviewerStaffId),
        req.body.ncTriggerEnabled ? 1 : 0,
        req.body.isActive === false ? 0 : 1,
        req.user!.id,
        createdAt
      );
    audit(req, { action: 'create', entity: 'monitoring_items', entityId: result.lastInsertRowid, newValue: { itemCode, ...req.body } });
    res.status(201).json({ id: result.lastInsertRowid, itemCode });
  });

  router.get('/items/:id', requirePermission('monitoring.assets', 'view'), (req, res) => {
    const db = getDb();
    const item = db.prepare('SELECT * FROM monitoring_items WHERE id = ?').get(req.params.id);
    if (!item) return res.status(404).json({ error: 'Monitoring item not found' });
    const readings = db.prepare('SELECT * FROM monitoring_readings WHERE monitoring_item_id = ? ORDER BY reading_date DESC LIMIT 100').all(req.params.id);
    res.json({ ...item, readings });
  });

  router.put('/items/:id', requirePermission('monitoring.assets', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM monitoring_items WHERE id = ?').get(req.params.id) as any;
    if (!oldValue) return res.status(404).json({ error: 'Monitoring item not found' });
    db.prepare(`UPDATE monitoring_items SET name = ?, monitoring_type = ?, parameter = ?, unit = ?, department_id = ?, section_id = ?, location_id = ?, lower_limit = ?, upper_limit = ?, warning_lower_limit = ?, warning_upper_limit = ?, critical_lower_limit = ?, critical_upper_limit = ?, frequency = ?, responsible_staff_id = ?, reviewer_staff_id = ?, nc_trigger_enabled = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(
        req.body.name ?? oldValue.name,
        req.body.monitoringType ?? oldValue.monitoring_type,
        req.body.parameter ?? oldValue.parameter,
        req.body.unit ?? oldValue.unit,
        parseIntNullable(req.body.departmentId) ?? oldValue.department_id,
        parseIntNullable(req.body.sectionId) ?? oldValue.section_id,
        parseIntNullable(req.body.locationId) ?? oldValue.location_id,
        req.body.lowerLimit !== undefined ? Number(req.body.lowerLimit) : oldValue.lower_limit,
        req.body.upperLimit !== undefined ? Number(req.body.upperLimit) : oldValue.upper_limit,
        req.body.warningLowerLimit !== undefined && req.body.warningLowerLimit !== '' ? Number(req.body.warningLowerLimit) : oldValue.warning_lower_limit,
        req.body.warningUpperLimit !== undefined && req.body.warningUpperLimit !== '' ? Number(req.body.warningUpperLimit) : oldValue.warning_upper_limit,
        req.body.criticalLowerLimit !== undefined && req.body.criticalLowerLimit !== '' ? Number(req.body.criticalLowerLimit) : oldValue.critical_lower_limit,
        req.body.criticalUpperLimit !== undefined && req.body.criticalUpperLimit !== '' ? Number(req.body.criticalUpperLimit) : oldValue.critical_upper_limit,
        req.body.frequency ?? oldValue.frequency,
        parseIntNullable(req.body.responsibleStaffId) ?? oldValue.responsible_staff_id,
        parseIntNullable(req.body.reviewerStaffId) ?? oldValue.reviewer_staff_id,
        req.body.ncTriggerEnabled !== undefined ? (req.body.ncTriggerEnabled ? 1 : 0) : oldValue.nc_trigger_enabled,
        req.body.isActive !== undefined ? (req.body.isActive ? 1 : 0) : oldValue.is_active,
        req.params.id
      );
    audit(req, { action: 'edit', entity: 'monitoring_items', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  // Readings
  router.get('/items/:id/readings', requirePermission('monitoring.assets', 'view'), (req, res) => {
    const db = getDb();
    res.json(db.prepare('SELECT * FROM monitoring_readings WHERE monitoring_item_id = ? ORDER BY reading_date DESC, id DESC').all(req.params.id));
  });

  router.post('/items/:id/readings', requirePermission('monitoring.assets', 'create'), (req, res) => {
    if (!req.body.readingDate) return res.status(400).json({ error: 'readingDate is required' });
    if (req.body.value === undefined || req.body.value === null || req.body.value === '') return res.status(400).json({ error: 'value is required' });
    const db = getDb();
    const item = db.prepare('SELECT * FROM monitoring_items WHERE id = ?').get(req.params.id) as any;
    if (!item) return res.status(404).json({ error: 'Monitoring item not found' });
    const value = Number(req.body.value);
    if (!Number.isFinite(value)) return res.status(400).json({ error: 'value must be numeric' });
    const status = computeReadingStatus(value, item);
    if (status !== 'normal' && !req.body.comment && !req.body.immediateAction) {
      return res.status(400).json({ error: 'comment or immediateAction is required for abnormal readings' });
    }
    const enteredBy = getStaffIdOrCurrent(req, req.body.enteredByStaffId);
    const result = db.prepare(`INSERT INTO monitoring_readings (monitoring_item_id, reading_date, reading_time, value, entered_by_staff_id, status, comment, immediate_action, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        req.params.id,
        req.body.readingDate,
        req.body.readingTime ?? null,
        value,
        enteredBy,
        status,
        req.body.comment ?? null,
        req.body.immediateAction ?? null,
        req.user!.id
      );
    audit(req, { action: 'create', entity: 'monitoring_readings', entityId: result.lastInsertRowid, newValue: { monitoringItemId: req.params.id, value, status, ...req.body } });
    res.status(201).json({ id: result.lastInsertRowid, status });
  });

  router.get('/readings', requirePermission('monitoring.readings', 'view'), (req, res) => {
    const db = getDb();
    const filters: string[] = [];
    const params: unknown[] = [];
    if (req.query.status) { filters.push('r.status = ?'); params.push(String(req.query.status)); }
    if (req.query.itemId) { filters.push('r.monitoring_item_id = ?'); params.push(Number(req.query.itemId)); }
    let query = `SELECT r.*, i.name AS item_name, i.unit AS item_unit FROM monitoring_readings r JOIN monitoring_items i ON i.id = r.monitoring_item_id`;
    if (filters.length) query += ` WHERE ${filters.join(' AND ')}`;
    query += ' ORDER BY r.reading_date DESC, r.id DESC LIMIT 500';
    res.json(db.prepare(query).all(...params));
  });

  router.post('/readings/:id/review', requirePermission('monitoring.readings', 'approve'), (req, res) => {
    const db = getDb();
    const reading = db.prepare('SELECT * FROM monitoring_readings WHERE id = ?').get(req.params.id);
    if (!reading) return res.status(404).json({ error: 'Reading not found' });
    const reviewedBy = getStaffIdOrCurrent(req, req.body.reviewedByStaffId);
    if (reviewedBy === null) return res.status(400).json({ error: 'This action requires the logged-in user to be linked to a staff record.' });
    db.prepare('UPDATE monitoring_readings SET reviewed_by_staff_id = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?').run(reviewedBy, req.params.id);
    audit(req, { action: 'approve', entity: 'monitoring_readings', entityId: req.params.id, oldValue: reading, newValue: { reviewedByStaffId: reviewedBy } });
    res.json({ ok: true });
  });

  router.post('/readings/:id/create-nc', requirePermission('nc_capa', 'create'), (req, res) => {
    const db = getDb();
    const reading = db.prepare('SELECT r.*, i.name AS item_name, i.parameter AS item_parameter FROM monitoring_readings r JOIN monitoring_items i ON i.id = r.monitoring_item_id WHERE r.id = ?').get(req.params.id) as any;
    if (!reading) return res.status(404).json({ error: 'Reading not found' });
    const createdAt = new Date().toISOString();
    const ncNumber = generateRecordNumber(db, 'nonconforming_events', 'NC', createdAt);
    const detectedByStaffId = getStaffIdOrCurrent(req, req.body.detectedByStaffId ?? reading.entered_by_staff_id);
    const ncResult = db.prepare(`INSERT INTO nonconforming_events (nc_number, event_date, detected_by_staff_id, source_module, source_record_id, title, description, category, severity, immediate_correction, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        ncNumber,
        reading.reading_date,
        detectedByStaffId,
        'monitoring',
        String(reading.id),
        req.body.title ?? `Out-of-range reading: ${reading.item_name}`,
        req.body.description ?? `Reading value ${reading.value} flagged ${reading.status} for ${reading.item_parameter}`,
        req.body.category ?? 'monitoring',
        req.body.severity ?? (reading.status === 'critical' ? 'high' : 'medium'),
        req.body.immediateCorrection ?? reading.immediate_action ?? null,
        'open',
        req.user!.id,
        createdAt
      );
    const ncId = Number(ncResult.lastInsertRowid);
    db.prepare('UPDATE monitoring_readings SET nc_id = ? WHERE id = ?').run(ncId, req.params.id);
    db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run('monitoring', 'monitoring_readings', String(req.params.id), 'nc_capa', 'nonconforming_events', String(ncId), 'NC from monitoring reading');
    audit(req, { action: 'create', entity: 'nonconforming_events', entityId: ncId, newValue: { ncNumber, sourceModule: 'monitoring', sourceRecordId: req.params.id } });
    res.status(201).json({ id: ncId, ncNumber });
  });

  router.post('/readings/:id/create-capa', requirePermission('nc_capa', 'create'), (req, res) => {
    const db = getDb();
    const reading = db.prepare('SELECT r.*, i.name AS item_name FROM monitoring_readings r JOIN monitoring_items i ON i.id = r.monitoring_item_id WHERE r.id = ?').get(req.params.id) as any;
    if (!reading) return res.status(404).json({ error: 'Reading not found' });
    const createdAt = new Date().toISOString();
    const capaNumber = generateRecordNumber(db, 'capa_records', 'CAPA', createdAt);
    const result = db.prepare(`INSERT INTO capa_records (capa_number, source_module, source_record_id, nc_id, title, problem_summary, responsible_staff_id, due_date, priority, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        capaNumber,
        'monitoring',
        String(reading.id),
        reading.nc_id ?? null,
        req.body.title ?? `CAPA for ${reading.item_name} excursion`,
        req.body.problemSummary ?? `Reading value ${reading.value} flagged ${reading.status}`,
        parseIntNullable(req.body.responsibleStaffId),
        req.body.dueDate ?? null,
        req.body.priority ?? 'normal',
        'open',
        req.user!.id,
        createdAt
      );
    const capaId = Number(result.lastInsertRowid);
    db.prepare('UPDATE monitoring_readings SET capa_id = ? WHERE id = ?').run(capaId, req.params.id);
    db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run('monitoring', 'monitoring_readings', String(req.params.id), 'nc_capa', 'capa_records', String(capaId), 'CAPA from monitoring reading');
    audit(req, { action: 'create', entity: 'capa_records', entityId: capaId, newValue: { capaNumber, sourceModule: 'monitoring', sourceRecordId: req.params.id } });
    res.status(201).json({ id: capaId, capaNumber });
  });

  // Legacy item lookup must come AFTER /items, /readings paths
  router.get('/:id', requirePermission('monitoring', 'view'), (req, res) => {
    const db = getDb();
    const item = db.prepare('SELECT * FROM monitoring_records WHERE id = ?').get(req.params.id);
    if (!item) return res.status(404).json({ error: 'Monitoring record not found' });
    res.json(item);
  });

  router.put('/:id', requirePermission('monitoring', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM monitoring_records WHERE id = ?').get(req.params.id) as any;
    if (!oldValue) return res.status(404).json({ error: 'Monitoring record not found' });
    db.prepare('UPDATE monitoring_records SET parameter = ?, target_range = ?, actual_value = ?, unit = ?, sample_date = ?, location_id = ?, department_id = ?, section_id = ?, status = ?, notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(
        req.body.parameter ?? oldValue.parameter,
        req.body.targetRange ?? oldValue.target_range,
        req.body.actualValue ?? oldValue.actual_value,
        req.body.unit ?? oldValue.unit,
        req.body.sampleDate ?? oldValue.sample_date,
        parseIntNullable(req.body.locationId) ?? oldValue.location_id,
        parseIntNullable(req.body.departmentId) ?? oldValue.department_id,
        parseIntNullable(req.body.sectionId) ?? oldValue.section_id,
        req.body.status ?? oldValue.status,
        req.body.notes ?? oldValue.notes,
        req.params.id
      );
    audit(req, { action: 'edit', entity: 'monitoring_records', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  return router;
}
