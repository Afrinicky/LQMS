import { Router } from 'express';
import multer from 'multer';
import * as XLSX from 'xlsx';
import { getDb } from '../db/database.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import { audit } from '../services/auditService.js';
import { generateRecordNumber } from '../utils/recordNumber.js';
import { parseIntNullable } from './routeHelpers.js';
import { recordReading } from '../services/environmental/monitorService.js';
import { getDriver, listDrivers, COMMUNICATION_METHODS } from '../services/environmental/drivers.js';
import { listChannels, getChannels, processQueue } from '../services/environmental/notifications.js';
import { computeInsights } from '../services/environmental/insights.js';
import { buildReport, reportToWorkbook, reportToHtml, REPORT_TYPES } from '../services/environmental/reports.js';
import { getCurrentStaffId } from './routeHelpers.js';
import { openSheet, refreshSheetRows, sheetsForSection } from '../services/routineSheets.js';
import { LOGGING_MODES, MAX_ATTACHMENT_MB } from '../../shared/constants/routineWork.js';
import { resolvePermission } from '../services/permissionResolver.js';
import { tierFeatureKey, TIER_ACTION } from '../../shared/constants/activities.js';

/** A number, or nothing — an empty box is "not set", never zero. */
const num = (value: unknown): number | null =>
  (value === '' || value === null || value === undefined || Number.isNaN(Number(value)) ? null : Number(value));

const numericOnly = (req: any, _res: any, next: any) => (/^\d+$/.test(req.params.id) ? next() : next('route'));
// Environmental Monitoring is a feature of Facilities & Safety, not the whole
// module. Guarding it on `facilities_safety` meant anyone with any safety
// right — a person who may only report an incident — could read, export and
// import the monitoring record. The client gates on this same key.
const MODULE = 'facilities_safety.environment';
const xlsxUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
const READING_HEADERS = ['Asset code', 'Asset name', 'Recorded at', 'Temperature', 'Humidity', 'Recorded by (employee no.)', 'Observation', 'Corrective action'] as const;

export function environmentalRoutes() {
  const router = Router();
  const getAsset = (id: number) => getDb().prepare('SELECT * FROM environmental_assets WHERE id = ?').get(id);

  // ---- Drivers & settings ----
  router.get('/drivers', requirePermission(MODULE, 'view'), (_req, res) => {
    res.json({ drivers: listDrivers(getAsset), communicationMethods: COMMUNICATION_METHODS });
  });
  router.get('/settings', requirePermission(MODULE, 'view'), (_req, res) => {
    res.json(getDb().prepare('SELECT * FROM environmental_settings WHERE id = 1').get() ?? null);
  });
  router.put('/settings', requirePermission(MODULE, 'edit'), (req, res) => {
    const b = req.body ?? {};
    const fields: Array<[string, string]> = [
      ['polling_enabled', 'pollingEnabled'], ['default_poll_interval_seconds', 'defaultPollIntervalSeconds'],
      ['excursion_nc_minutes', 'excursionNcMinutes'], ['battery_low_threshold', 'batteryLowThreshold'],
      ['no_comm_minutes', 'noCommMinutes'], ['prevent_expired_devices', 'preventExpiredDevices'], ['email_enabled', 'emailEnabled'],
      ['webhook_url', 'webhookUrl'],
      // How this laboratory logs its environment. A laboratory that charts by
      // hand should never be shown a data-logger screen, so the mode is stored
      // here and every screen — module and portal alike — obeys it.
      ['logging_mode', 'loggingMode'], ['chart_upload_enabled', 'chartUploadEnabled'],
      ['max_attachment_mb', 'maxAttachmentMb'], ['monthly_verification_required', 'monthlyVerificationRequired'],
      ['reading_slots', 'readingSlots'], ['reading_time_am', 'readingTimeAm'],
      ['reading_time_pm', 'readingTimePm'], ['reading_grace_minutes', 'readingGraceMinutes'],
    ];
    if (b.loggingMode !== undefined && !LOGGING_MODES.includes(String(b.loggingMode) as any)) {
      return res.status(400).json({ error: `Logging must be one of: ${LOGGING_MODES.join(', ')}.` });
    }
    if (b.maxAttachmentMb !== undefined && Number(b.maxAttachmentMb) > MAX_ATTACHMENT_MB) {
      return res.status(400).json({ error: `An attached chart cannot be capped above ${MAX_ATTACHMENT_MB} MB. Attachments accumulate every month on every asset, and this system runs on laboratory hardware.` });
    }
    if (b.readingSlots !== undefined && Array.isArray(b.readingSlots)) b.readingSlots = JSON.stringify(b.readingSlots);
    for (const [col, key] of fields) if (b[key] !== undefined) getDb().prepare(`UPDATE environmental_settings SET ${col} = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1`).run(typeof b[key] === 'boolean' ? (b[key] ? 1 : 0) : b[key], );
    audit(req, { action: 'edit', entity: 'environmental_settings', entityId: 1, newValue: b });
    res.json({ ok: true });
  });

  // ---- Notification channels & escalation ----
  router.get('/channels', requirePermission(MODULE, 'view'), (_req, res) => {
    const settings = getDb().prepare('SELECT * FROM environmental_settings WHERE id = 1').get();
    res.json(listChannels(settings));
  });
  router.get('/escalation-rules', requirePermission(MODULE, 'view'), (_req, res) => {
    res.json(getDb().prepare('SELECT * FROM environmental_escalation_rules ORDER BY severity, delay_minutes, id').all());
  });
  router.post('/escalation-rules', requirePermission(MODULE, 'edit'), (req, res) => {
    const b = req.body ?? {};
    if (!b.name || !b.channel) return res.status(400).json({ error: 'Name and channel are required.' });
    const r = getDb().prepare('INSERT INTO environmental_escalation_rules (name, severity, delay_minutes, channel, recipients, created_by) VALUES (?, ?, ?, ?, ?, ?)')
      .run(b.name, b.severity ?? 'critical', parseIntNullable(b.delayMinutes) ?? 0, b.channel, b.recipients ?? null, req.user!.id);
    audit(req, { action: 'create', entity: 'environmental_escalation_rules', entityId: r.lastInsertRowid, newValue: b });
    res.status(201).json({ id: r.lastInsertRowid });
  });
  router.put('/escalation-rules/:id', numericOnly, requirePermission(MODULE, 'edit'), (req, res) => {
    const b = req.body ?? {};
    const fields: Array<[string, string]> = [['name', 'name'], ['severity', 'severity'], ['delay_minutes', 'delayMinutes'], ['channel', 'channel'], ['recipients', 'recipients'], ['is_active', 'isActive']];
    for (const [col, key] of fields) if (b[key] !== undefined) getDb().prepare(`UPDATE environmental_escalation_rules SET ${col} = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(col === 'is_active' ? (b[key] ? 1 : 0) : col === 'delay_minutes' ? (parseIntNullable(b[key]) ?? 0) : b[key], req.params.id);
    audit(req, { action: 'edit', entity: 'environmental_escalation_rules', entityId: req.params.id, newValue: b });
    res.json({ ok: true });
  });
  router.delete('/escalation-rules/:id', numericOnly, requirePermission(MODULE, 'edit'), (req, res) => {
    getDb().prepare('DELETE FROM environmental_escalation_rules WHERE id = ?').run(req.params.id);
    audit(req, { action: 'delete', entity: 'environmental_escalation_rules', entityId: req.params.id });
    res.json({ ok: true });
  });
  router.get('/notification-queue', requirePermission(MODULE, 'view'), (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status : null;
    const sql = `SELECT q.*, r.name AS rule_name FROM environmental_notification_queue q LEFT JOIN environmental_escalation_rules r ON r.id = q.rule_id ${status ? 'WHERE q.status = ?' : ''} ORDER BY q.id DESC LIMIT 300`;
    res.json(status ? getDb().prepare(sql).all(status) : getDb().prepare(sql).all());
  });
  // Send a test message through a channel to confirm configuration.
  router.post('/channels/:key/test', requirePermission(MODULE, 'edit'), async (req, res) => {
    const db = getDb();
    const settings = db.prepare('SELECT * FROM environmental_settings WHERE id = 1').get() as any;
    const channel = getChannels().get(req.params.key);
    if (!channel) return res.status(404).json({ error: 'Unknown channel' });
    const r = await channel.send(db, { channel: req.params.key, recipients: req.body?.recipients ?? null, subject: 'SECH_LIMS test notification', body: 'This is a test of the environmental notification channel.', severity: 'information' }, settings);
    res.json(r);
  });
  // Force the delivery worker (useful after enabling a channel).
  router.post('/notification-queue/process', requirePermission(MODULE, 'edit'), (_req, res) => { processQueue(getDb()); res.json({ ok: true }); });

  // ---- Insights & predictive maintenance (advisory only) ----
  router.get('/insights', requirePermission(MODULE, 'view'), (_req, res) => {
    res.json(computeInsights(getDb()));
  });
  // Turn a recommendation into an action for someone to own (user-approved).
  router.post('/insights/create-action', requirePermission(MODULE, 'create'), (req, res) => {
    const b = req.body ?? {};
    if (!b.title) return res.status(400).json({ error: 'Title is required.' });
    const r = getDb().prepare('INSERT INTO actions (title, module_key, source_module, source_record_id, description, status, priority, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(b.title, 'facilities_safety', 'environmental', b.assetId ? String(b.assetId) : null, b.description ?? null, 'Not started', b.priority ?? 'normal', req.user!.id);
    audit(req, { action: 'create', entity: 'actions', entityId: r.lastInsertRowid, newValue: { source: 'environmental_insight', ...b } });
    res.status(201).json({ id: r.lastInsertRowid });
  });

  // ---- Reports (Excel + printable/PDF) ----
  router.get('/reports', requirePermission(MODULE, 'view'), (_req, res) => res.json(REPORT_TYPES));
  router.get('/reports/:type/export', requirePermission(MODULE, 'export'), (req, res) => {
    const report = buildReport(getDb(), req.params.type, req.query.from as string, req.query.to as string);
    const buf = reportToWorkbook(report);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Environmental_${req.params.type}.xlsx"`);
    res.send(buf);
    audit(req, { action: 'export', entity: 'environmental_report', entityId: req.params.type });
  });
  router.get('/reports/:type/print', requirePermission(MODULE, 'print'), (req, res) => {
    const report = buildReport(getDb(), req.params.type, req.query.from as string, req.query.to as string);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(reportToHtml(report, req.query.autoprint !== '0'));
    audit(req, { action: 'print', entity: 'environmental_report', entityId: req.params.type });
  });

  // ---- Readings — Excel export / import (manual temperature/humidity logs) ----
  function buildReadingsWorkbook(withData: boolean, from?: string, to?: string): Buffer {
    const db = getDb();
    const rows: any[][] = [];
    if (withData) {
      const cond: string[] = []; const params: unknown[] = [];
      if (from) { cond.push('r.recorded_at >= ?'); params.push(from); }
      if (to) { cond.push('r.recorded_at <= ?'); params.push(to + 'T23:59:59'); }
      const where = cond.length ? ' WHERE ' + cond.join(' AND ') : '';
      const recs = db.prepare(`SELECT r.*, a.asset_code, a.name AS asset_name, st.employee_no AS recorded_no
        FROM environmental_readings r JOIN environmental_assets a ON a.id = r.asset_id
        LEFT JOIN staff st ON st.id = r.recorded_by_staff_id ${where} ORDER BY r.recorded_at DESC LIMIT 20000`).all(...params) as any[];
      for (const r of recs) rows.push([
        r.asset_code, r.asset_name, r.recorded_at, r.temperature ?? '', r.humidity ?? '', r.recorded_no ?? '', r.observation ?? '', r.corrective_action ?? '',
      ]);
    }
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([READING_HEADERS as unknown as string[], ...rows]);
    ws['!cols'] = READING_HEADERS.map(h => ({ wch: Math.min(30, Math.max(12, h.length + 2)) }));
    XLSX.utils.book_append_sheet(wb, ws, 'READINGS');
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  }
  function sendXlsx(res: any, buf: Buffer, filename: string) {
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.end(buf);
  }
  router.get('/readings/template', requirePermission(MODULE, 'export'), (_req, res) => sendXlsx(res, buildReadingsWorkbook(false), 'Environmental_Readings_Template.xlsx'));
  router.get('/readings/export', requirePermission(MODULE, 'export'), (req, res) => {
    sendXlsx(res, buildReadingsWorkbook(true, req.query.from as string, req.query.to as string), 'Environmental_Readings.xlsx');
    audit(req, { action: 'export', entity: 'environmental_readings', entityId: null });
  });
  router.post('/readings/import', requirePermission(MODULE, 'import'), xlsxUpload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded. Attach the Environmental Readings .xlsx file.' });
    try {
      const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
      const sheet = wb.SheetNames.find(n => n.toUpperCase().includes('READING')) || wb.SheetNames[0];
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[sheet], { defval: '', raw: false });
      const db = getDb();
      const assetByCode = new Map<string, number>();
      for (const a of db.prepare('SELECT id, asset_code FROM environmental_assets').all() as any[]) assetByCode.set(String(a.asset_code).toLowerCase(), a.id);
      const staffByNo = new Map<string, number>();
      for (const s of db.prepare('SELECT id, employee_no FROM staff WHERE employee_no IS NOT NULL').all() as any[]) staffByNo.set(String(s.employee_no).toLowerCase(), s.id);
      const norm = (v: unknown) => { const s = String(v ?? '').trim(); return s === '' ? null : s; };
      const errors: string[] = [];
      let created = 0, excursions = 0;
      const tx = db.transaction(() => {
        rows.forEach((r, idx) => {
          const rowNo = idx + 2;
          const code = norm(r['Asset code']);
          const assetId = code ? assetByCode.get(String(code).toLowerCase()) : undefined;
          if (!assetId) { errors.push(`Row ${rowNo}: asset code "${code ?? ''}" not found.`); return; }
          const tempRaw = norm(r['Temperature']);
          const humRaw = norm(r['Humidity']);
          if (tempRaw == null && humRaw == null) { errors.push(`Row ${rowNo}: a temperature or humidity value is required.`); return; }
          const at = norm(r['Recorded at']);
          const recordedAt = at ? new Date(at).toISOString() : new Date().toISOString();
          const staffId = norm(r['Recorded by (employee no.)']) ? (staffByNo.get(String(r['Recorded by (employee no.)']).toLowerCase()) ?? null) : null;
          try {
            const out = recordReading(db, {
              assetId, source: 'excel_import',
              temperature: tempRaw == null ? null : Number(tempRaw),
              humidity: humRaw == null ? null : Number(humRaw),
              recordedAt, recordedByStaffId: staffId,
              observation: norm(r['Observation']), correctiveAction: norm(r['Corrective action']),
              userId: req.user!.id,
            });
            created++;
            if (out && out.status && out.status !== 'normal') excursions++;
          } catch (e) { errors.push(`Row ${rowNo}: ${(e as Error).message}`); }
        });
      });
      tx();
      audit(req, { action: 'import', entity: 'environmental_readings', entityId: null, newValue: { created, excursions, errors: errors.length } });
      res.json({ totalRows: rows.length, created, excursions, errors });
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });

  // ---- Assets ----
  router.get('/assets', requirePermission(MODULE, 'view'), (_req, res) => {
    res.json(getDb().prepare(`SELECT a.*, d.name AS department_name, s.name AS section_name, l.name AS location_name, dev.name AS device_name, dev.driver_key AS device_driver, dev.communication_method AS device_comm
      FROM environmental_assets a
      LEFT JOIN departments d ON d.id = a.department_id
      LEFT JOIN sections s ON s.id = a.section_id
      LEFT JOIN locations l ON l.id = a.location_id
      LEFT JOIN environmental_devices dev ON dev.id = a.device_id
      ORDER BY a.name`).all());
  });
  router.post('/assets', requirePermission(MODULE, 'create'), (req, res) => {
    const db = getDb(); const b = req.body ?? {};
    if (!b.name) return res.status(400).json({ error: 'Asset name is required.' });
    const code = (b.assetCode && String(b.assetCode).trim()) || generateRecordNumber(db, 'environmental_assets', 'ENV', new Date().toISOString());
    const r = db.prepare(`INSERT INTO environmental_assets (asset_code, name, asset_type, department_id, section_id, location_id, responsible_section_id, responsible_staff_id, equipment_id, temp_min, temp_max, humidity_min, humidity_max, monitoring_frequency, status, is_active, installation_date, calibration_due_date, device_id, notes, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      code, b.name, b.assetType ?? null, parseIntNullable(b.departmentId), parseIntNullable(b.sectionId), parseIntNullable(b.locationId),
      parseIntNullable(b.responsibleSectionId), parseIntNullable(b.responsibleStaffId), parseIntNullable(b.equipmentId),
      b.tempMin ?? null, b.tempMax ?? null, b.humidityMin ?? null, b.humidityMax ?? null, b.monitoringFrequency ?? null,
      b.status ?? 'active', b.isActive === false ? 0 : 1, b.installationDate ?? null, b.calibrationDueDate ?? null, parseIntNullable(b.deviceId), b.notes ?? null, req.user!.id);
    audit(req, { action: 'create', entity: 'environmental_assets', entityId: r.lastInsertRowid, newValue: { code, ...b } });
    res.status(201).json({ id: r.lastInsertRowid, assetCode: code });
  });
  router.put('/assets/:id', numericOnly, requirePermission(MODULE, 'edit'), (req, res) => {
    const b = req.body ?? {};
    const fields: Array<[string, string]> = [['name', 'name'], ['asset_type', 'assetType'], ['department_id', 'departmentId'], ['section_id', 'sectionId'], ['location_id', 'locationId'], ['responsible_section_id', 'responsibleSectionId'], ['responsible_staff_id', 'responsibleStaffId'], ['equipment_id', 'equipmentId'], ['temp_min', 'tempMin'], ['temp_max', 'tempMax'], ['humidity_min', 'humidityMin'], ['humidity_max', 'humidityMax'], ['monitoring_frequency', 'monitoringFrequency'], ['status', 'status'], ['is_active', 'isActive'], ['installation_date', 'installationDate'], ['calibration_due_date', 'calibrationDueDate'], ['device_id', 'deviceId'], ['floor_plan_x', 'floorPlanX'], ['floor_plan_y', 'floorPlanY'], ['notes', 'notes']];
    const intCols = new Set(['department_id', 'section_id', 'location_id', 'responsible_section_id', 'responsible_staff_id', 'equipment_id', 'device_id']);
    for (const [col, key] of fields) {
      if (b[key] === undefined) continue;
      const val = col === 'is_active' ? (b[key] ? 1 : 0) : intCols.has(col) ? parseIntNullable(b[key]) : (b[key] === '' ? null : b[key]);
      getDb().prepare(`UPDATE environmental_assets SET ${col} = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(val, req.params.id);
    }
    audit(req, { action: 'edit', entity: 'environmental_assets', entityId: req.params.id, newValue: b });
    res.json({ ok: true });
  });
  router.delete('/assets/:id', numericOnly, requirePermission(MODULE, 'edit'), (req, res) => {
    getDb().prepare('DELETE FROM environmental_assets WHERE id = ?').run(req.params.id);
    audit(req, { action: 'delete', entity: 'environmental_assets', entityId: req.params.id });
    res.json({ ok: true });
  });

  // ---- Readings: manual entry + time-series ----
  router.get('/assets/:id/readings', numericOnly, requirePermission(MODULE, 'view'), (req, res) => {
    const range = String(req.query.range ?? '24h');
    let sinceIso: string | null = null;
    const now = Date.now();
    const map: Record<string, number> = { '24h': 1, '7d': 7, '30d': 30, '90d': 90 };
    if (range in map) sinceIso = new Date(now - map[range] * 86400000).toISOString();
    const from = typeof req.query.from === 'string' ? req.query.from : null;
    const to = typeof req.query.to === 'string' ? req.query.to : null;
    let rows;
    if (from || to) {
      rows = getDb().prepare('SELECT * FROM environmental_readings WHERE asset_id = ? AND recorded_at >= ? AND recorded_at <= ? ORDER BY recorded_at').all(req.params.id, from || '0000', to || '9999');
    } else if (sinceIso) {
      rows = getDb().prepare('SELECT * FROM environmental_readings WHERE asset_id = ? AND recorded_at >= ? ORDER BY recorded_at').all(req.params.id, sinceIso);
    } else {
      rows = getDb().prepare('SELECT * FROM environmental_readings WHERE asset_id = ? ORDER BY recorded_at DESC LIMIT 500').all(req.params.id);
    }
    res.json(rows);
  });
  router.post('/assets/:id/readings', numericOnly, requirePermission(MODULE, 'create'), (req, res) => {
    const b = req.body ?? {};
    try {
      const out = recordReading(getDb(), {
        assetId: Number(req.params.id), deviceId: parseIntNullable(b.deviceId), source: 'manual',
        temperature: b.temperature === '' || b.temperature == null ? null : Number(b.temperature),
        humidity: b.humidity === '' || b.humidity == null ? null : Number(b.humidity),
        recordedAt: b.recordedAt || new Date().toISOString(), recordedByStaffId: parseIntNullable(b.recordedByStaffId),
        observation: b.observation ?? null, correctiveAction: b.correctiveAction ?? null, manualReason: b.manualReason ?? null, signature: b.signature ?? null,
        userId: req.user!.id,
      });
      audit(req, { action: 'create', entity: 'environmental_readings', entityId: out.readingId, newValue: { assetId: req.params.id, source: 'manual', status: out.status } });
      res.status(201).json(out);
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });

  // ---- Devices ----
  router.get('/devices', requirePermission(MODULE, 'view'), (_req, res) => {
    res.json(getDb().prepare(`SELECT dev.*, a.name AS asset_name, l.name AS location_name FROM environmental_devices dev
      LEFT JOIN environmental_assets a ON a.id = dev.asset_id
      LEFT JOIN locations l ON l.id = dev.location_id ORDER BY dev.name`).all());
  });
  router.post('/devices', requirePermission(MODULE, 'create'), (req, res) => {
    const db = getDb(); const b = req.body ?? {};
    if (!b.name) return res.status(400).json({ error: 'Device name is required.' });
    const code = (b.deviceCode && String(b.deviceCode).trim()) || generateRecordNumber(db, 'environmental_devices', 'DEV', new Date().toISOString());
    const r = db.prepare(`INSERT INTO environmental_devices (device_code, name, manufacturer, model, serial_number, device_type, communication_method, driver_key, firmware_version, calibration_status, calibration_certificate_file_id, calibration_due_date, battery_status, location_id, asset_id, poll_interval_seconds, config_json, is_active, notes, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      code, b.name, b.manufacturer ?? null, b.model ?? null, b.serialNumber ?? null, b.deviceType ?? null,
      b.communicationMethod ?? 'manual', b.driverKey ?? b.communicationMethod ?? 'manual', b.firmwareVersion ?? null,
      b.calibrationStatus ?? null, parseIntNullable(b.calibrationCertificateFileId), b.calibrationDueDate ?? null, b.batteryStatus ?? null,
      parseIntNullable(b.locationId), parseIntNullable(b.assetId), parseIntNullable(b.pollIntervalSeconds), b.configJson ?? null,
      b.isActive === false ? 0 : 1, b.notes ?? null, req.user!.id);
    const deviceId = Number(r.lastInsertRowid);
    if (parseIntNullable(b.assetId)) db.prepare('UPDATE environmental_assets SET device_id = ? WHERE id = ?').run(deviceId, parseIntNullable(b.assetId));
    audit(req, { action: 'create', entity: 'environmental_devices', entityId: deviceId, newValue: { code, ...b } });
    res.status(201).json({ id: deviceId, deviceCode: code });
  });
  router.put('/devices/:id', numericOnly, requirePermission(MODULE, 'edit'), (req, res) => {
    const b = req.body ?? {};
    const fields: Array<[string, string]> = [['name', 'name'], ['manufacturer', 'manufacturer'], ['model', 'model'], ['serial_number', 'serialNumber'], ['device_type', 'deviceType'], ['communication_method', 'communicationMethod'], ['driver_key', 'driverKey'], ['firmware_version', 'firmwareVersion'], ['calibration_status', 'calibrationStatus'], ['calibration_certificate_file_id', 'calibrationCertificateFileId'], ['calibration_due_date', 'calibrationDueDate'], ['battery_status', 'batteryStatus'], ['location_id', 'locationId'], ['asset_id', 'assetId'], ['poll_interval_seconds', 'pollIntervalSeconds'], ['config_json', 'configJson'], ['is_active', 'isActive'], ['notes', 'notes']];
    const intCols = new Set(['calibration_certificate_file_id', 'location_id', 'asset_id', 'poll_interval_seconds']);
    for (const [col, key] of fields) {
      if (b[key] === undefined) continue;
      const val = col === 'is_active' ? (b[key] ? 1 : 0) : intCols.has(col) ? parseIntNullable(b[key]) : (b[key] === '' ? null : b[key]);
      getDb().prepare(`UPDATE environmental_devices SET ${col} = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(val, req.params.id);
    }
    if (b.assetId !== undefined && parseIntNullable(b.assetId)) getDb().prepare('UPDATE environmental_assets SET device_id = ? WHERE id = ?').run(req.params.id, parseIntNullable(b.assetId));
    audit(req, { action: 'edit', entity: 'environmental_devices', entityId: req.params.id, newValue: b });
    res.json({ ok: true });
  });
  router.delete('/devices/:id', numericOnly, requirePermission(MODULE, 'edit'), (req, res) => {
    getDb().prepare('UPDATE environmental_assets SET device_id = NULL WHERE device_id = ?').run(req.params.id);
    getDb().prepare('DELETE FROM environmental_devices WHERE id = ?').run(req.params.id);
    audit(req, { action: 'delete', entity: 'environmental_devices', entityId: req.params.id });
    res.json({ ok: true });
  });

  // Force an immediate poll of a device via its driver (test connectivity / demo).
  router.post('/devices/:id/poll', numericOnly, requirePermission(MODULE, 'edit'), async (req, res) => {
    const db = getDb();
    const device = db.prepare('SELECT * FROM environmental_devices WHERE id = ?').get(req.params.id) as any;
    if (!device) return res.status(404).json({ error: 'Device not found' });
    if (!device.asset_id) return res.status(400).json({ error: 'Assign this device to an asset first.' });
    const driver = getDriver(device.driver_key, getAsset);
    try {
      const sample = await driver.poll(device);
      if (!sample.ok) return res.status(400).json({ error: sample.error || 'Device did not return a reading.' });
      const out = recordReading(db, { assetId: device.asset_id, deviceId: device.id, source: 'automated', temperature: sample.temperature, humidity: sample.humidity, batteryLevel: sample.batteryLevel, signalStrength: sample.signalStrength, recordedAt: sample.recordedAt });
      res.json({ ok: true, sample, ...out });
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });

  // Import a data-logger CSV (columns: timestamp, temperature[, humidity]).
  router.post('/devices/:id/import-csv', numericOnly, requirePermission(MODULE, 'import'), (req, res) => {
    const db = getDb();
    const device = db.prepare('SELECT * FROM environmental_devices WHERE id = ?').get(req.params.id) as any;
    if (!device?.asset_id) return res.status(400).json({ error: 'Assign this device to an asset first.' });
    const csv = String(req.body?.csv ?? '');
    const lines = csv.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) return res.status(400).json({ error: 'CSV must have a header row and at least one data row.' });
    const header = lines[0].toLowerCase().split(',').map(s => s.trim());
    const ti = header.findIndex(h => h.includes('time') || h.includes('date'));
    const tempi = header.findIndex(h => h.includes('temp'));
    const humi = header.findIndex(h => h.includes('humid'));
    if (tempi === -1) return res.status(400).json({ error: 'Could not find a temperature column.' });
    let imported = 0;
    const tx = db.transaction(() => {
      for (const line of lines.slice(1)) {
        const cells = line.split(',');
        const temp = Number(cells[tempi]); if (!Number.isFinite(temp)) continue;
        const at = ti >= 0 && cells[ti] ? new Date(cells[ti]).toISOString() : new Date().toISOString();
        recordReading(db, { assetId: device.asset_id, deviceId: device.id, source: 'csv_import', temperature: temp, humidity: humi >= 0 ? Number(cells[humi]) || null : null, recordedAt: at, userId: req.user!.id });
        imported++;
      }
    });
    tx();
    audit(req, { action: 'import', entity: 'environmental_readings', entityId: device.id, newValue: { imported } });
    res.json({ ok: true, imported });
  });

  // ---- Live dashboard ----
  router.get('/dashboard', requirePermission(MODULE, 'view'), (_req, res) => {
    const db = getDb();
    const settings = db.prepare('SELECT * FROM environmental_settings WHERE id = 1').get() as any ?? {};
    const noCommMs = (settings.no_comm_minutes ?? 15) * 60000;
    const assets = db.prepare(`SELECT a.*, l.name AS location_name, s.name AS section_name, dev.name AS device_name, dev.driver_key AS device_driver, dev.battery_level AS device_battery, dev.signal_strength AS device_signal, dev.last_communication_at AS device_last_comm
      FROM environmental_assets a
      LEFT JOIN locations l ON l.id = a.location_id
      LEFT JOIN sections s ON s.id = a.section_id
      LEFT JOIN environmental_devices dev ON dev.id = a.device_id
      WHERE a.is_active = 1 ORDER BY a.name`).all() as any[];
    const cards = assets.map(a => {
      const last2 = db.prepare('SELECT * FROM environmental_readings WHERE asset_id = ? ORDER BY recorded_at DESC LIMIT 2').all(a.id) as any[];
      const latest = last2[0] ?? null;
      const prev = last2[1] ?? null;
      const ageMs = latest ? Date.now() - new Date(latest.recorded_at).getTime() : Infinity;
      const offline = a.device_id && a.device_driver && a.device_driver !== 'manual' && ageMs > noCommMs;
      const cardStatus = !latest ? 'unknown' : offline ? 'offline' : latest.status;
      const trend = latest && prev && latest.temperature != null && prev.temperature != null
        ? (latest.temperature > prev.temperature ? 'up' : latest.temperature < prev.temperature ? 'down' : 'flat') : 'flat';
      return {
        id: a.id, asset_code: a.asset_code, name: a.name, asset_type: a.asset_type, location_name: a.location_name, section_name: a.section_name,
        temp_min: a.temp_min, temp_max: a.temp_max, humidity_min: a.humidity_min, humidity_max: a.humidity_max,
        temperature: latest?.temperature ?? null, humidity: latest?.humidity ?? null,
        status: cardStatus, trend, last_updated: latest?.recorded_at ?? null, source: latest?.source ?? null,
        device_name: a.device_name, device_battery: a.device_battery, device_signal: a.device_signal, device_last_comm: a.device_last_comm,
      };
    });
    const activeAlerts = db.prepare("SELECT COUNT(*) c FROM environmental_alerts WHERE status = 'active'").get() as any;
    const criticalAlerts = db.prepare("SELECT COUNT(*) c FROM environmental_alerts WHERE status = 'active' AND severity = 'critical'").get() as any;
    const openExcursions = db.prepare("SELECT COUNT(*) c FROM environmental_excursions WHERE status = 'open'").get() as any;
    const summary = {
      totalAssets: assets.length,
      normal: cards.filter(c => c.status === 'normal').length,
      warning: cards.filter(c => c.status === 'warning').length,
      critical: cards.filter(c => c.status === 'critical').length,
      offline: cards.filter(c => c.status === 'offline' || c.status === 'unknown').length,
      activeAlerts: activeAlerts.c, criticalAlerts: criticalAlerts.c, openExcursions: openExcursions.c,
      pollingEnabled: !!settings.polling_enabled,
    };
    res.json({ summary, cards });
  });

  // ---- Alerts ----
  router.get('/alerts', requirePermission(MODULE, 'view'), (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status : null;
    const sql = `SELECT al.*, a.name AS asset_name, a.asset_code, dev.name AS device_name FROM environmental_alerts al
      LEFT JOIN environmental_assets a ON a.id = al.asset_id
      LEFT JOIN environmental_devices dev ON dev.id = al.device_id
      ${status ? 'WHERE al.status = ?' : ''} ORDER BY al.triggered_at DESC LIMIT 500`;
    res.json(status ? getDb().prepare(sql).all(status) : getDb().prepare(sql).all());
  });
  router.post('/alerts/:id/acknowledge', numericOnly, requirePermission(MODULE, 'edit'), (req, res) => {
    getDb().prepare("UPDATE environmental_alerts SET status = 'acknowledged', acknowledged_by_staff_id = ?, acknowledged_at = CURRENT_TIMESTAMP WHERE id = ?").run(parseIntNullable(req.body?.staffId), req.params.id);
    audit(req, { action: 'acknowledge', entity: 'environmental_alerts', entityId: req.params.id });
    res.json({ ok: true });
  });
  router.post('/alerts/:id/resolve', numericOnly, requirePermission(MODULE, 'edit'), (req, res) => {
    getDb().prepare("UPDATE environmental_alerts SET status = 'resolved', resolved_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
    audit(req, { action: 'resolve', entity: 'environmental_alerts', entityId: req.params.id });
    res.json({ ok: true });
  });

  // ---- Excursions ----
  router.get('/excursions', requirePermission(MODULE, 'view'), (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status : null;
    const sql = `SELECT e.*, a.name AS asset_name, a.asset_code, nc.nc_number, capa.capa_number FROM environmental_excursions e
      LEFT JOIN environmental_assets a ON a.id = e.asset_id
      LEFT JOIN nonconforming_events nc ON nc.id = e.nc_id
      LEFT JOIN capa_records capa ON capa.id = e.capa_id
      ${status ? 'WHERE e.status = ?' : ''} ORDER BY e.started_at DESC LIMIT 500`;
    res.json(status ? getDb().prepare(sql).all(status) : getDb().prepare(sql).all());
  });
  router.post('/excursions/:id/acknowledge', numericOnly, requirePermission(MODULE, 'edit'), (req, res) => {
    getDb().prepare("UPDATE environmental_excursions SET acknowledged_by_staff_id = ?, investigation_status = COALESCE(?, investigation_status), updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(parseIntNullable(req.body?.staffId), req.body?.investigationStatus ?? null, req.params.id);
    audit(req, { action: 'acknowledge', entity: 'environmental_excursions', entityId: req.params.id });
    res.json({ ok: true });
  });
  router.post('/excursions/:id/create-nc', numericOnly, requirePermission('nc_capa', 'create'), (req, res) => {
    const db = getDb();
    const exc = db.prepare('SELECT * FROM environmental_excursions WHERE id = ?').get(req.params.id) as any;
    if (!exc) return res.status(404).json({ error: 'Excursion not found' });
    if (exc.nc_id) return res.status(400).json({ error: 'This excursion already has an NC.' });
    const asset = db.prepare('SELECT * FROM environmental_assets WHERE id = ?').get(exc.asset_id) as any;
    const createdAt = new Date().toISOString();
    const ncNumber = generateRecordNumber(db, 'nonconforming_events', 'NC', createdAt);
    const ncId = Number(db.prepare(`INSERT INTO nonconforming_events (nc_number, event_date, source_module, source_record_id, title, description, category, severity, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(ncNumber, createdAt.slice(0, 10), 'environmental', String(exc.id), `Temperature excursion: ${asset?.name}`, `Excursion on ${asset?.name}: min ${exc.min_value}°C / max ${exc.max_value}°C since ${exc.started_at}.`, 'environmental', 'high', 'open', req.user!.id, createdAt).lastInsertRowid);
    db.prepare('UPDATE environmental_excursions SET nc_id = ? WHERE id = ?').run(ncId, exc.id);
    db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run('environmental', 'environmental_excursions', String(exc.id), 'nc_capa', 'nonconforming_events', String(ncId), 'NC from environmental excursion');
    audit(req, { action: 'create', entity: 'nonconforming_events', entityId: ncId, newValue: { ncNumber, excursionId: exc.id } });
    res.status(201).json({ id: ncId, ncNumber });
  });


  /* ======================================================================
     The monthly chart
     ----------------------------------------------------------------------
     Readings have always gone into environmental_readings. What the laboratory
     actually keeps, signs and files is the month's chart, and until now there
     was nowhere for that to exist — so a year of readings could be perfect and
     there was still nothing an assessor recognised to hand them.

     The chart does not duplicate the readings. Every numeric cell goes through
     the same ingest path a reading typed on this screen does, so an out-of-range
     value opens the same excursion and raises the same NC. The chart is the
     view the laboratory signs; the readings are still the data.
     ==================================================================== */

  router.get('/charts', requirePermission(MODULE, 'view'), (req, res) => {
    const db = getDb();
    const month = /^\d{4}-\d{2}$/.test(String(req.query.month)) ? String(req.query.month) : new Date().toISOString().slice(0, 7);
    const staffId = getCurrentStaffId(req);
    const sectionId = parseIntNullable(req.query.sectionId)
      ?? (staffId !== null ? (db.prepare('SELECT section_id FROM staff WHERE id = ?').get(staffId) as any)?.section_id ?? null : null);
    const settings = db.prepare('SELECT * FROM environmental_settings WHERE id = 1').get() as any;
    if (!sectionId) return res.json({ month, sectionId: null, sheets: [], settings });
    res.json({
      month, sectionId, settings,
      sheets: sheetsForSection(db, 'environmental', sectionId, month, { userId: req.user!.id }),
    });
  });

  /**
   * Register a new thing to chart, from wherever the person is standing.
   *
   * The unit that reads a fridge is the unit that knows a new fridge has
   * arrived, and the old arrangement sent them to Facilities & Safety to say
   * so — which in practice meant the new fridge went unmonitored until somebody
   * remembered. So a unit can register its own asset here, and it is assigned
   * to that unit, appearing on its chart board the moment it is saved.
   *
   * It is not an open door: it takes the environment module's create right, or
   * the supervisory routine-work tier a unit head holds. And it can only ever
   * be assigned to the caller's own unit — naming somebody else's is a
   * Facilities & Safety act, because it makes another unit responsible.
   */
  router.post('/charts/assets', requireAuth, (req, res) => {
    const db = getDb();
    const mayCreate = resolvePermission(req.user!.id, MODULE, 'create').allowed
      || resolvePermission(req.user!.id, tierFeatureKey('supervisory'), TIER_ACTION).allowed;
    if (!mayCreate) {
      return res.status(403).json({
        error: 'Registering something new to chart is a unit head\'s. Your profile holds neither the environment '
          + 'create right nor the supervisory routine-work tier.',
      });
    }
    const staffId = getCurrentStaffId(req);
    const sectionId = staffId !== null
      ? (db.prepare('SELECT section_id FROM staff WHERE id = ?').get(staffId) as any)?.section_id ?? null
      : null;
    if (!sectionId) {
      return res.status(400).json({ error: 'Your account is not linked to a unit, so there is nobody to make responsible for the readings.' });
    }

    const name = String(req.body?.name ?? '').trim();
    if (!name) return res.status(400).json({ error: 'Give it a name — what the bench calls it, so the person reading it recognises it.' });
    const assetType = String(req.body?.assetType ?? '').trim() || 'refrigerator';
    const parameters = Array.isArray(req.body?.parameters) ? req.body.parameters : [];
    if (parameters.length === 0) {
      return res.status(400).json({ error: 'A chart with no parameter has nothing to record. Add at least one — temperature, humidity, whatever this asset is monitored for — with the range it must stay inside.' });
    }
    for (const p of parameters) {
      const label = String(p?.label ?? '').trim();
      if (!label) return res.status(400).json({ error: 'Every parameter needs a name.' });
      const min = num(p?.minValue), max = num(p?.maxValue);
      if (min === null && max === null) {
        return res.status(400).json({ error: `${label} has no acceptable range. Without one nothing can be out of range, and the chart records numbers rather than control.` });
      }
      if (min !== null && max !== null && min > max) {
        return res.status(400).json({ error: `${label}: the lowest acceptable value is above the highest.` });
      }
    }

    const created = new Date().toISOString();
    const code = generateRecordNumber(db, 'environmental_assets', 'ENV', created);
    const result = db.transaction(() => {
      const inserted = db.prepare(`INSERT INTO environmental_assets
          (asset_code, name, asset_type, section_id, responsible_section_id, location_id,
           temp_min, temp_max, monitoring_frequency, status, is_active, notes, created_by, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?, ?)`)
        .run(code, name, assetType, sectionId, sectionId, parseIntNullable(req.body?.locationId),
          num(parameters[0]?.minValue), num(parameters[0]?.maxValue),
          String(req.body?.monitoringFrequency ?? '').trim() || 'daily',
          String(req.body?.notes ?? '').trim() || null, req.user!.id, created);
      const assetId = Number(inserted.lastInsertRowid);

      parameters.forEach((p: any, index: number) => {
        const label = String(p.label).trim();
        const key = label.toLowerCase().replace(/[^a-z0-9_]+/g, '_') || `parameter_${index + 1}`;
        db.prepare(`INSERT INTO environmental_asset_parameters
            (asset_id, parameter, label, unit, min_value, max_value, decimal_places, display_order, is_active)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`)
          .run(assetId, key, label, String(p.unit ?? '').trim() || null,
            num(p.minValue), num(p.maxValue),
            Number.isFinite(Number(p.decimalPlaces)) ? Number(p.decimalPlaces) : 1, index);
      });
      return assetId;
    })();

    // Open this month straight away, so the chart the person came to fill in is
    // there rather than one action further on.
    const month = /^\d{4}-\d{2}$/.test(String(req.body?.month)) ? String(req.body.month) : new Date().toISOString().slice(0, 7);
    const sheet = openSheet(db, { kind: 'environmental', subjectId: result, month, sectionId, userId: req.user!.id });
    if (sheet) refreshSheetRows(db, sheet);

    audit(req, { action: 'create', entity: 'environmental_assets', entityId: result, newValue: { code, name, assetType, sectionId, parameters: parameters.length } });
    res.status(201).json({ id: result, assetCode: code, sheetId: sheet?.id ?? null });
  });

  router.post('/charts/open', requirePermission(MODULE, 'view'), (req, res) => {
    const db = getDb();
    const assetId = parseIntNullable(req.body?.assetId);
    const month = /^\d{4}-\d{2}$/.test(String(req.body?.month)) ? String(req.body.month) : new Date().toISOString().slice(0, 7);
    if (!assetId) return res.status(400).json({ error: 'assetId is required' });
    const sheet = openSheet(db, { kind: 'environmental', subjectId: assetId, month, userId: req.user!.id });
    if (!sheet) return res.status(404).json({ error: 'Environmental asset not found' });
    refreshSheetRows(db, sheet);
    res.json({ sheetId: sheet.id });
  });

  /* ======================================================================
     What an asset is charted for
     ----------------------------------------------------------------------
     The original schema assumed temperature and humidity. A CO2 incubator, a
     room with a pressure differential, a cold room with an alarm delay — each
     needs its own row with its own limits, and a chart that cannot grow a row
     forces the laboratory back onto paper for exactly the assets that matter
     most.
     ==================================================================== */

  router.get('/assets/:id/parameters', numericOnly, requirePermission(MODULE, 'view'), (req, res) => {
    res.json(getDb().prepare('SELECT * FROM environmental_asset_parameters WHERE asset_id = ? ORDER BY display_order, id').all(req.params.id));
  });

  router.put('/assets/:id/parameters', numericOnly, requirePermission(MODULE, 'edit'), (req, res) => {
    const db = getDb();
    const asset = db.prepare('SELECT id FROM environmental_assets WHERE id = ?').get(req.params.id);
    if (!asset) return res.status(404).json({ error: 'Environmental asset not found' });
    const rows = Array.isArray(req.body?.parameters) ? req.body.parameters : null;
    if (!rows) return res.status(400).json({ error: 'parameters must be an array' });

    const num = (v: unknown) => (v === '' || v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v));
    const tx = db.transaction(() => {
      const keep = new Set<string>();
      rows.forEach((p: any, i: number) => {
        const key = String(p.parameter ?? '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_');
        if (!key) return;
        keep.add(key);
        db.prepare(`INSERT INTO environmental_asset_parameters
            (asset_id, parameter, label, unit, min_value, max_value, decimal_places, display_order, is_active)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
            ON CONFLICT(asset_id, parameter) DO UPDATE SET label = excluded.label, unit = excluded.unit,
              min_value = excluded.min_value, max_value = excluded.max_value,
              decimal_places = excluded.decimal_places, display_order = excluded.display_order, is_active = 1`)
          .run(req.params.id, key, String(p.label ?? p.parameter).trim(), p.unit ?? null,
            num(p.minValue), num(p.maxValue), num(p.decimalPlaces) ?? 1, i);
      });
      // A parameter dropped from the list is deactivated, never deleted: the
      // months already charted against it are records.
      for (const existing of db.prepare('SELECT parameter FROM environmental_asset_parameters WHERE asset_id = ?').all(req.params.id) as any[]) {
        if (!keep.has(String(existing.parameter))) {
          db.prepare('UPDATE environmental_asset_parameters SET is_active = 0 WHERE asset_id = ? AND parameter = ?').run(req.params.id, existing.parameter);
        }
      }
    });
    tx();
    audit(req, { action: 'edit', entity: 'environmental_asset_parameters', entityId: req.params.id, newValue: { count: rows.length } });
    res.json(db.prepare('SELECT * FROM environmental_asset_parameters WHERE asset_id = ? ORDER BY display_order, id').all(req.params.id));
  });

  return router;
}
