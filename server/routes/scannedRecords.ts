import { Router } from 'express';
import multer from 'multer';
import { getDb, uploadRoot } from '../db/database.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import { audit } from '../services/auditService.js';
import { generateRecordNumber } from '../utils/recordNumber.js';
import { safeStoredFilename } from '../utils/safeFilename.js';
import { parseIntNullable, getStaffIdOrCurrent } from './routeHelpers.js';

// ==========================================================================
// Scanned records / evidence uploads
//   Preserve historical paper records (monitoring charts, maintenance logs,
//   IQC sheets, verification/validation reports …) and capture ongoing scanned
//   charts as evidence a duty was performed. Each upload states the period it
//   covers and whether it holds an out-of-range reading; if it does, a
//   nonconformity is raised automatically so the CAPA workflow follows.
// ==========================================================================

const upload = multer({
  storage: multer.diskStorage({ destination: (_req, _file, cb) => cb(null, uploadRoot), filename: (_req, file, cb) => cb(null, safeStoredFilename(file.originalname)) }),
  limits: { fileSize: 25 * 1024 * 1024 },
});

const COVERAGES = ['daily', 'weekly', 'monthly', 'one_off'];
// Modules for which the auto-NC on an out-of-range reading makes sense.
const AUTO_NC_MODULES = new Set(['monitoring', 'equipment', 'iqc', 'eqa', 'verification_validation', 'measurement_uncertainty']);
const MODULE_NC_CATEGORY: Record<string, string> = {
  monitoring: 'environmental', equipment: 'equipment', iqc: 'quality_control',
  eqa: 'external_quality', verification_validation: 'method_performance', measurement_uncertainty: 'measurement',
};

export function scannedRecordsRoutes() {
  const router = Router();
  router.use(requireAuth);

  router.get('/', requirePermission('documents', 'view'), (req, res) => {
    const db = getDb();
    let q = `SELECT sr.*, f.original_name AS file_name, f.mime_type AS file_mime, s.name AS section_name,
        e.name AS equipment_name, e.equipment_number, st.full_name AS uploaded_by_name, nc.nc_number
      FROM scanned_records sr
      LEFT JOIN files f ON f.id = sr.file_id
      LEFT JOIN sections s ON s.id = sr.section_id
      LEFT JOIN equipment_items e ON e.id = sr.equipment_id
      LEFT JOIN staff st ON st.id = sr.uploaded_by_staff_id
      LEFT JOIN nonconforming_events nc ON nc.id = sr.nc_id`;
    const cond: string[] = [];
    const params: unknown[] = [];
    if (req.query.moduleKey) { cond.push('sr.module_key = ?'); params.push(req.query.moduleKey); }
    if (req.query.equipmentId) { cond.push('sr.equipment_id = ?'); params.push(req.query.equipmentId); }
    if (req.query.sectionId) { cond.push('sr.section_id = ?'); params.push(req.query.sectionId); }
    if (req.query.monitoringItemId) { cond.push('sr.monitoring_item_id = ?'); params.push(req.query.monitoringItemId); }
    if (cond.length) q += ' WHERE ' + cond.join(' AND ');
    q += ' ORDER BY sr.created_at DESC, sr.id DESC';
    res.json(db.prepare(q).all(...params));
  });

  router.post('/', requirePermission('documents', 'create'), upload.single('file'), (req, res) => {
    const db = getDb();
    const b = req.body ?? {};
    const moduleKey = String(b.moduleKey || 'other').trim();
    if (!b.title || !String(b.title).trim()) return res.status(400).json({ error: 'A title is required.' });
    const coverage = COVERAGES.includes(b.coverage) ? b.coverage : 'one_off';
    const createdAt = new Date().toISOString();

    // Persist the uploaded scan into the files table (optional — a metadata-only
    // legacy note is allowed too, but normally a scan is attached).
    let fileId: number | null = null;
    if (req.file) {
      const fr = db.prepare('INSERT INTO files (original_name, stored_name, mime_type, size_bytes, storage_area, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)')
        .run(req.file.originalname, req.file.filename, req.file.mimetype, req.file.size, 'uploads', req.user!.id);
      fileId = Number(fr.lastInsertRowid);
    }

    const recordNumber = generateRecordNumber(db, 'scanned_records', 'SCAN', createdAt);
    const hasOutOfRange = b.hasOutOfRange === true || b.hasOutOfRange === 'true' || b.hasOutOfRange === '1' || b.hasOutOfRange === 1;
    const sectionId = parseIntNullable(b.sectionId);
    const equipmentId = parseIntNullable(b.equipmentId);
    const uploadedBy = getStaffIdOrCurrent(req, b.uploadedByStaffId);
    const result = db.prepare(`INSERT INTO scanned_records
      (record_number, module_key, category, title, coverage, period_start, period_end, month, section_id, equipment_id, monitoring_item_id, file_id, is_legacy, has_out_of_range, out_of_range_notes, notes, uploaded_by_staff_id, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(recordNumber, moduleKey, b.category || null, String(b.title).trim(), coverage, b.periodStart || null, b.periodEnd || null, b.month || null,
        sectionId, equipmentId, parseIntNullable(b.monitoringItemId), fileId,
        (b.isLegacy === true || b.isLegacy === 'true' || b.isLegacy === '1') ? 1 : 0,
        hasOutOfRange ? 1 : 0, b.outOfRangeNotes || null, b.notes || null, uploadedBy, req.user!.id, createdAt);
    const id = Number(result.lastInsertRowid);

    // Raise a nonconformity when an out-of-range reading is declared on the scan.
    let ncId: number | null = null;
    let ncNumber: string | null = null;
    if (hasOutOfRange && AUTO_NC_MODULES.has(moduleKey)) {
      ncNumber = generateRecordNumber(db, 'nonconforming_events', 'NC', createdAt);
      const equipmentName = equipmentId ? (db.prepare('SELECT name FROM equipment_items WHERE id = ?').get(equipmentId) as any)?.name : null;
      const subject = equipmentName || (sectionId ? (db.prepare('SELECT name FROM sections WHERE id = ?').get(sectionId) as any)?.name : null) || String(b.title).trim();
      const title = `Out-of-range reading on scanned ${b.category ? String(b.category).replace(/_/g, ' ') : 'record'}: ${subject}`;
      const description = `An out-of-range reading was flagged on the uploaded ${coverage} record "${String(b.title).trim()}" (${recordNumber}).` + (b.outOfRangeNotes ? ` Details: ${b.outOfRangeNotes}` : '');
      const ncRes = db.prepare(`INSERT INTO nonconforming_events (nc_number, event_date, detected_by_staff_id, section_id, source_module, source_record_id, title, description, category, severity, status, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'medium', 'open', ?, ?)`)
        .run(ncNumber, (b.periodEnd || b.periodStart || createdAt.slice(0, 10)), uploadedBy, sectionId, moduleKey, String(id),
          title, description, MODULE_NC_CATEGORY[moduleKey] || 'quality', req.user!.id, createdAt);
      ncId = Number(ncRes.lastInsertRowid);
      db.prepare('UPDATE scanned_records SET nc_id = ? WHERE id = ?').run(ncId, id);
      db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(moduleKey, 'scanned_records', String(id), 'nc_capa', 'nonconforming_events', String(ncId), 'Out-of-range reading on scanned record');
      audit(req, { action: 'create', entity: 'nonconforming_events', entityId: ncId, newValue: { ncNumber, fromScannedRecord: recordNumber } });
    }

    audit(req, { action: 'create', entity: 'scanned_records', entityId: id, newValue: { recordNumber, moduleKey, hasOutOfRange } });
    res.status(201).json({ id, recordNumber, ncId, ncNumber });
  });

  router.delete('/:id', requirePermission('documents', 'void_archive'), (req, res) => {
    const db = getDb();
    const ex = db.prepare('SELECT * FROM scanned_records WHERE id = ?').get(req.params.id);
    if (!ex) return res.status(404).json({ error: 'Record not found' });
    db.prepare('DELETE FROM scanned_records WHERE id = ?').run(req.params.id);
    audit(req, { action: 'delete', entity: 'scanned_records', entityId: req.params.id, oldValue: ex });
    res.json({ ok: true });
  });

  return router;
}
