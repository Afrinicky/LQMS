import { Router } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import * as XLSX from 'xlsx';
import { getDb, uploadRoot, evidenceRoot } from '../db/database.js';
import { requirePermission } from '../middleware/permissions.js';
import { audit } from '../services/auditService.js';
import { generateRecordNumber } from '../utils/recordNumber.js';
import { parseIntNullable, getCurrentStaffId } from './routeHelpers.js';
import { safeStoredFilename } from '../utils/safeFilename.js';

// -------------------------------------------------------------------
// Central Archive service — a single register of every archived record
// or report no matter which module produced it. All archive-producing
// actions across the system should call `recordCentralArchive(...)` so
// the Documents & Records module can show, print and retrieve them.
// -------------------------------------------------------------------

export type CentralArchiveInput = {
  title: string;
  description?: string | null;
  archiveType: string;              // record | report | patient_results | backup | evidence | other
  sourceModule?: string | null;
  sourceRecordType?: string | null;
  sourceRecordId?: string | number | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  retentionPeriodMonths?: number | null;
  retentionUntil?: string | null;
  fileId?: number | null;
  cloudUrl?: string | null;
  cloudProvider?: string | null;
  storageLocation?: string | null;
  format?: string | null;
  sizeBytes?: number | null;
  archivedByStaffId?: number | null;
  isAutomatic?: boolean;
  linkedRecordId?: number | null;
  notes?: string | null;
  createdBy?: number | null;
};

/**
 * Insert a central archive entry. Called from every archive-producing action
 * across the system so the Documents & Records module always sees every
 * archive. Safe to call from any route — swallows errors so a failure here
 * never blocks the primary archive action.
 */
export function recordCentralArchive(db: any, input: CentralArchiveInput): { id: number; archiveNumber: string } | null {
  try {
    if (!input.title || !input.archiveType) return null;
    const archiveNumber = generateRecordNumber(db, 'central_archives', 'ARC', new Date().toISOString());
    const retentionUntil = input.retentionUntil ?? (input.retentionPeriodMonths
      ? new Date(new Date().setMonth(new Date().getMonth() + input.retentionPeriodMonths)).toISOString().slice(0, 10)
      : null);
    const r = db.prepare(`INSERT INTO central_archives (archive_number, title, description, archive_type, source_module, source_record_type, source_record_id, period_start, period_end, retention_period_months, retention_until, file_id, cloud_url, cloud_provider, storage_location, format, size_bytes, archived_by_staff_id, is_automatic, linked_record_id, notes, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      archiveNumber, input.title, input.description ?? null, input.archiveType,
      input.sourceModule ?? null, input.sourceRecordType ?? null, input.sourceRecordId != null ? String(input.sourceRecordId) : null,
      input.periodStart ?? null, input.periodEnd ?? null, input.retentionPeriodMonths ?? null, retentionUntil,
      input.fileId ?? null, input.cloudUrl ?? null, input.cloudProvider ?? null, input.storageLocation ?? null,
      input.format ?? null, input.sizeBytes ?? null, input.archivedByStaffId ?? null,
      input.isAutomatic ? 1 : 0, input.linkedRecordId ?? null, input.notes ?? null, input.createdBy ?? null);
    // Link back to the source record so the Linked Records panel picks up the
    // relationship automatically wherever it is shown in the system.
    if (input.sourceModule && input.sourceRecordType && input.sourceRecordId != null) {
      db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        input.sourceModule, input.sourceRecordType, String(input.sourceRecordId),
        'documents', 'central_archives', String(r.lastInsertRowid), `Central archive: ${input.archiveType}`);
    }
    return { id: Number(r.lastInsertRowid), archiveNumber };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[central-archive] failed to record archive:', (err as Error).message);
    return null;
  }
}

const ARCHIVE_TYPES = ['record', 'report', 'patient_results', 'backup', 'evidence', 'other'];

export function centralArchivesRoutes() {
  const router = Router();

  // -------- List / search / summary --------
  router.get('/summary', requirePermission('documents', 'view'), (_req, res) => {
    const db = getDb();
    const c = (sql: string, ...p: unknown[]) => (db.prepare(sql).get(...p) as { c: number }).c;
    const today = new Date().toISOString().slice(0, 10);
    res.json({
      totalArchives: c('SELECT COUNT(*) c FROM central_archives'),
      archivedThisMonth: c("SELECT COUNT(*) c FROM central_archives WHERE strftime('%Y-%m', archived_at) = strftime('%Y-%m','now')"),
      withCloudCopy: c("SELECT COUNT(*) c FROM central_archives WHERE cloud_url IS NOT NULL AND cloud_url != ''"),
      dueForDestruction: c('SELECT COUNT(*) c FROM central_archives WHERE retention_until IS NOT NULL AND retention_until <= ? AND status = ?', today, 'archived'),
      byType: db.prepare("SELECT archive_type, COUNT(*) c FROM central_archives GROUP BY archive_type").all(),
      byModule: db.prepare("SELECT source_module, COUNT(*) c FROM central_archives GROUP BY source_module").all(),
    });
  });

  router.get('/', requirePermission('documents', 'view'), (req, res) => {
    const db = getDb();
    const filters: string[] = [];
    const params: unknown[] = [];
    if (req.query.type) { filters.push('a.archive_type = ?'); params.push(String(req.query.type)); }
    if (req.query.module) { filters.push('a.source_module = ?'); params.push(String(req.query.module)); }
    if (req.query.from) { filters.push("date(a.archived_at) >= ?"); params.push(String(req.query.from)); }
    if (req.query.to) { filters.push("date(a.archived_at) <= ?"); params.push(String(req.query.to)); }
    const q = String(req.query.q || '').trim();
    if (q) {
      const like = `%${q.toLowerCase()}%`;
      filters.push('(LOWER(a.title) LIKE ? OR LOWER(COALESCE(a.description, \'\')) LIKE ? OR LOWER(COALESCE(a.archive_number, \'\')) LIKE ? OR LOWER(COALESCE(a.source_module, \'\')) LIKE ?)');
      params.push(like, like, like, like);
    }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    res.json(db.prepare(`
      SELECT a.*, f.original_name AS file_name, f.mime_type AS file_mime, f.size_bytes AS file_size,
             s.full_name AS archived_by_name
      FROM central_archives a
      LEFT JOIN files f ON f.id = a.file_id
      LEFT JOIN staff s ON s.id = a.archived_by_staff_id
      ${where}
      ORDER BY a.archived_at DESC, a.id DESC
      LIMIT 2000
    `).all(...params));
  });

  router.get('/:id', requirePermission('documents', 'view'), (req, res) => {
    const db = getDb();
    const a = db.prepare(`SELECT a.*, f.original_name AS file_name, f.mime_type AS file_mime, f.size_bytes AS file_size, s.full_name AS archived_by_name
      FROM central_archives a LEFT JOIN files f ON f.id = a.file_id LEFT JOIN staff s ON s.id = a.archived_by_staff_id WHERE a.id = ?`).get(req.params.id) as any;
    if (!a) return res.status(404).json({ error: 'Archive not found' });
    res.json(a);
  });

  // -------- Manual upload --------
  router.post('/', requirePermission('documents', 'create'), (req, res) => {
    if (!req.body.title) return res.status(400).json({ error: 'title is required' });
    if (!req.body.archiveType || !ARCHIVE_TYPES.includes(req.body.archiveType)) {
      return res.status(400).json({ error: `archiveType must be one of: ${ARCHIVE_TYPES.join(', ')}` });
    }
    const db = getDb();
    const staffId = getCurrentStaffId(req);
    const fileId = parseIntNullable(req.body.fileId);
    let fmt: string | null = req.body.format ?? null;
    let sizeBytes: number | null = null;
    if (fileId) {
      const file = db.prepare('SELECT original_name, mime_type, size_bytes FROM files WHERE id = ?').get(fileId) as any;
      if (file) {
        sizeBytes = file.size_bytes ?? null;
        if (!fmt) fmt = String(file.original_name || '').split('.').pop()?.toLowerCase() || null;
      }
    }
    const result = recordCentralArchive(db, {
      title: req.body.title,
      description: req.body.description ?? null,
      archiveType: req.body.archiveType,
      sourceModule: req.body.sourceModule ?? 'documents',
      sourceRecordType: req.body.sourceRecordType ?? null,
      sourceRecordId: req.body.sourceRecordId ?? null,
      periodStart: req.body.periodStart ?? null,
      periodEnd: req.body.periodEnd ?? null,
      retentionPeriodMonths: parseIntNullable(req.body.retentionPeriodMonths),
      retentionUntil: req.body.retentionUntil ?? null,
      fileId,
      cloudUrl: req.body.cloudUrl ?? null,
      cloudProvider: req.body.cloudProvider ?? null,
      storageLocation: req.body.storageLocation ?? null,
      format: fmt,
      sizeBytes,
      archivedByStaffId: parseIntNullable(req.body.archivedByStaffId) ?? staffId,
      isAutomatic: false,
      linkedRecordId: parseIntNullable(req.body.linkedRecordId),
      notes: req.body.notes ?? null,
      createdBy: req.user!.id,
    });
    if (!result) return res.status(500).json({ error: 'Could not create the archive entry.' });
    audit(req, { action: 'create', entity: 'central_archives', entityId: result.id, newValue: { archiveNumber: result.archiveNumber, ...req.body } });
    res.status(201).json(result);
  });

  router.put('/:id', requirePermission('documents', 'edit'), (req, res) => {
    const db = getDb();
    const old = db.prepare('SELECT * FROM central_archives WHERE id = ?').get(req.params.id) as any;
    if (!old) return res.status(404).json({ error: 'Archive not found' });
    db.prepare(`UPDATE central_archives SET title = ?, description = ?, cloud_url = ?, cloud_provider = ?, storage_location = ?, retention_period_months = ?, retention_until = ?, status = ?, notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(
      req.body.title ?? old.title, req.body.description ?? old.description,
      req.body.cloudUrl ?? old.cloud_url, req.body.cloudProvider ?? old.cloud_provider,
      req.body.storageLocation ?? old.storage_location,
      parseIntNullable(req.body.retentionPeriodMonths) ?? old.retention_period_months,
      req.body.retentionUntil ?? old.retention_until,
      req.body.status ?? old.status, req.body.notes ?? old.notes, req.params.id);
    audit(req, { action: 'edit', entity: 'central_archives', entityId: req.params.id, oldValue: old, newValue: req.body });
    res.json({ ok: true });
  });

  // -------- Retrieve --------
  router.post('/:id/retrieve', requirePermission('documents', 'view'), (req, res) => {
    const db = getDb();
    const a = db.prepare('SELECT * FROM central_archives WHERE id = ?').get(req.params.id) as any;
    if (!a) return res.status(404).json({ error: 'Archive not found' });
    audit(req, { action: 'retrieve', entity: 'central_archives', entityId: req.params.id, newValue: { retrievedBy: req.user!.id, reason: req.body?.reason ?? null } });
    res.json({ ok: true, fileId: a.file_id, cloudUrl: a.cloud_url });
  });

  // -------- Schedules (periodic auto-archiving) --------
  router.get('/schedules/list', requirePermission('documents', 'view'), (_req, res) => {
    const db = getDb();
    res.json(db.prepare('SELECT s.*, st.full_name AS responsible_name FROM central_archive_schedules s LEFT JOIN staff st ON st.id = s.responsible_staff_id ORDER BY s.title').all());
  });

  router.post('/schedules', requirePermission('documents', 'edit'), (req, res) => {
    if (!req.body.scheduleKey || !req.body.title) return res.status(400).json({ error: 'scheduleKey and title are required' });
    const db = getDb();
    const exists = db.prepare('SELECT id FROM central_archive_schedules WHERE schedule_key = ?').get(req.body.scheduleKey);
    if (exists) {
      db.prepare(`UPDATE central_archive_schedules SET title = ?, archive_type = ?, frequency = ?, retention_period_months = ?, format = ?, responsible_staff_id = ?, cloud_url_template = ?, next_run_at = ?, is_active = ?, notes = ?, updated_at = CURRENT_TIMESTAMP WHERE schedule_key = ?`).run(
        req.body.title, req.body.archiveType ?? 'patient_results', req.body.frequency ?? 'monthly',
        parseIntNullable(req.body.retentionPeriodMonths), req.body.format ?? 'excel',
        parseIntNullable(req.body.responsibleStaffId), req.body.cloudUrlTemplate ?? null,
        req.body.nextRunAt ?? null, req.body.isActive === false ? 0 : 1, req.body.notes ?? null,
        req.body.scheduleKey);
      audit(req, { action: 'edit', entity: 'central_archive_schedules', entityId: req.body.scheduleKey, newValue: req.body });
      return res.json({ ok: true, updated: true });
    }
    const r = db.prepare(`INSERT INTO central_archive_schedules (schedule_key, title, archive_type, frequency, retention_period_months, format, responsible_staff_id, cloud_url_template, next_run_at, is_active, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      req.body.scheduleKey, req.body.title, req.body.archiveType ?? 'patient_results', req.body.frequency ?? 'monthly',
      parseIntNullable(req.body.retentionPeriodMonths), req.body.format ?? 'excel',
      parseIntNullable(req.body.responsibleStaffId), req.body.cloudUrlTemplate ?? null,
      req.body.nextRunAt ?? null, req.body.isActive === false ? 0 : 1, req.body.notes ?? null);
    audit(req, { action: 'create', entity: 'central_archive_schedules', entityId: r.lastInsertRowid, newValue: req.body });
    res.status(201).json({ id: r.lastInsertRowid });
  });

  // -------- Periodic Patient Results Archive --------
  // Pulls patient results from the LHIMS import rows the lab has processed, in
  // the given period, and produces an Excel/CSV file the lab can retain. The
  // resulting file is registered as a central archive entry automatically.
  router.post('/patient-results', requirePermission('documents', 'create'), (req, res) => {
    const db = getDb();
    if (!req.body.periodStart || !req.body.periodEnd) return res.status(400).json({ error: 'periodStart and periodEnd are required' });
    const start = String(req.body.periodStart);
    const end = String(req.body.periodEnd);
    const format = String(req.body.format || 'excel').toLowerCase();
    // Aggregate patient results from LHIMS import rows in the window.
    let rows: any[] = [];
    try {
      rows = db.prepare(`
        SELECT r.request_date, r.sample_date, r.result_date, r.patient_id, r.patient_age, r.patient_sex,
               r.department_name, r.section_name, r.test_name, r.parameter_name, r.result_value, r.unit,
               r.sample_type, r.organism, r.antibiotic, r.susceptibility,
               b.batch_number, b.report_month, b.report_year
        FROM lhims_import_rows r
        LEFT JOIN lhims_import_batches b ON b.id = r.import_batch_id
        WHERE COALESCE(r.result_date, r.sample_date, r.request_date) BETWEEN ? AND ?
        ORDER BY COALESCE(r.result_date, r.sample_date, r.request_date), r.id
      `).all(start, end) as any[];
    } catch { rows = []; }
    if (!rows.length) return res.status(400).json({ error: `No processed patient results were found between ${start} and ${end}. Import LHIMS data covering this period first.` });
    const title = String(req.body.title || `Patient Results Archive ${start} to ${end}`);
    const originalName = `${title}.${format === 'csv' ? 'csv' : 'xlsx'}`.replace(/[\\/:*?"<>|]/g, '_');
    const storedName = safeStoredFilename(originalName);
    const fullPath = path.join(uploadRoot, storedName);
    try {
      if (format === 'csv') {
        const headers = Object.keys(rows[0]);
        const esc = (v: unknown) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
        const csv = [headers.join(','), ...rows.map(r => headers.map(h => esc(r[h])).join(','))].join('\n');
        fs.writeFileSync(fullPath, csv, 'utf8');
      } else {
        const wb = XLSX.utils.book_new();
        const ws = XLSX.utils.json_to_sheet(rows);
        XLSX.utils.book_append_sheet(wb, ws, 'Patient Results');
        XLSX.writeFile(wb, fullPath);
      }
    } catch (err) {
      return res.status(500).json({ error: `Could not build the archive file: ${err instanceof Error ? err.message : 'unknown error'}` });
    }
    const stat = fs.statSync(fullPath);
    const mime = format === 'csv' ? 'text/csv' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    const fileResult = db.prepare('INSERT INTO files (original_name, stored_name, mime_type, size_bytes, storage_area, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)').run(originalName, storedName, mime, stat.size, 'uploads', req.user!.id);
    const fileId = Number(fileResult.lastInsertRowid);
    const staffId = getCurrentStaffId(req);
    const retentionMonths = parseIntNullable(req.body.retentionPeriodMonths) ?? 60; // 5 years default (ISO 15189 patient records)
    const created = recordCentralArchive(db, {
      title, description: `Automated periodic archive of ${rows.length} patient result(s) covering ${start} → ${end}.`,
      archiveType: 'patient_results',
      sourceModule: 'monthly_reports', sourceRecordType: 'lhims_import_rows', sourceRecordId: null,
      periodStart: start, periodEnd: end,
      retentionPeriodMonths: retentionMonths,
      fileId, format, sizeBytes: stat.size,
      archivedByStaffId: staffId,
      cloudUrl: req.body.cloudUrl ?? null, cloudProvider: req.body.cloudProvider ?? null,
      storageLocation: req.body.storageLocation ?? null,
      isAutomatic: true, notes: req.body.notes ?? null,
      createdBy: req.user!.id,
    });
    if (!created) return res.status(500).json({ error: 'Could not register the archive.' });
    audit(req, { action: 'patient_results_archive', entity: 'central_archives', entityId: created.id, newValue: { periodStart: start, periodEnd: end, rows: rows.length, fileId } });
    res.status(201).json({ ...created, fileId, rows: rows.length });
  });

  return router;
}
