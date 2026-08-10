import { Router } from 'express';
import { getDb, uploadRoot } from '../db/database.js';
import { requirePermission } from '../middleware/permissions.js';
import { audit, verifyAuditChain } from '../services/auditService.js';
import { generateRecordNumber } from '../utils/recordNumber.js';
import { safeStoredFilename } from '../utils/safeFilename.js';
import { parseIntNullable, getStaffIdOrCurrent } from './routeHelpers.js';
import fs from 'node:fs';
import path from 'node:path';

const REPORT_STATUSES = ['draft', 'generated', 'reviewed', 'approved', 'archived'];
const EVIDENCE_PACK_STATUSES = ['draft', 'prepared', 'reviewed', 'approved', 'archived'];
const RETENTION_REVIEW_STATUSES = ['draft', 'completed', 'archived'];
const AUDIT_REVIEW_STATUSES = ['draft', 'completed', 'action_required', 'closed'];
const BACKUP_CHECK_STATUSES = ['draft', 'passed', 'failed', 'action_required', 'closed'];
const INTEGRITY_CHECK_STATUSES = ['draft', 'passed', 'issues_found', 'action_required', 'closed'];
const OUTPUT_FORMATS = ['html', 'csv', 'json', 'print_view'];
const SUPPORTED_REPORT_MODULES = ['nc_capa', 'complaints', 'risks', 'actions', 'equipment', 'supplier_inventory', 'monitoring', 'iqc', 'eqa', 'blood_bank_handover', 'monthly_reports', 'assessments', 'quality_indicators', 'customer_focus', 'poct', 'notifications'];
const ARCHIVE_ACTIONS = ['flag_for_review', 'move_to_archive', 'retain_with_review_note', 'do_not_archive'];

function insertLink(db: any, source: { module: string; type: string; id: string | number }, target: { module: string; type: string; id: string | number }, notes?: string) {
  db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run(source.module, source.type, String(source.id), target.module, target.type, String(target.id), notes ?? null);
}

function csvEscape(v: unknown) { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }

function tableColumns(db: any, table: string): Set<string> {
  try { const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>; return new Set(cols.map(c => c.name)); } catch { return new Set(); }
}

function applyFilterJson(db: any, table: string, filterJson: string | null | undefined, baseFilters: string[], baseParams: unknown[]): { filters: string[]; params: unknown[]; rejectedKeys: string[] } {
  const filters = [...baseFilters]; const params = [...baseParams]; const rejectedKeys: string[] = [];
  if (!filterJson) return { filters, params, rejectedKeys };
  let parsed: any;
  try { parsed = JSON.parse(filterJson); } catch { return { filters, params, rejectedKeys }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { filters, params, rejectedKeys };
  const cols = tableColumns(db, table);
  for (const [rawKey, rawVal] of Object.entries(parsed)) {
    const key = rawKey.toLowerCase();
    if (!cols.has(rawKey)) { rejectedKeys.push(rawKey); continue; }
    if (rawVal === null) { filters.push(`${rawKey} IS NULL`); continue; }
    if (Array.isArray(rawVal) && rawVal.length > 0) {
      filters.push(`${rawKey} IN (${rawVal.map(() => '?').join(',')})`);
      for (const v of rawVal) params.push(v);
      continue;
    }
    if (typeof rawVal === 'object' && rawVal !== null) {
      for (const [op, v] of Object.entries(rawVal as Record<string, unknown>)) {
        const sqlOp = ({ gt: '>', gte: '>=', lt: '<', lte: '<=', ne: '!=', eq: '=', like: 'LIKE' } as Record<string, string>)[op.toLowerCase()];
        if (!sqlOp) continue;
        filters.push(`${rawKey} ${sqlOp} ?`); params.push(v);
      }
      continue;
    }
    filters.push(`${rawKey} = ?`); params.push(rawVal);
    void key;
  }
  return { filters, params, rejectedKeys };
}

function tableForModule(moduleKey: string): { table: string; dateField: string; titleField: string } | null {
  switch (moduleKey) {
    case 'nc_capa': return { table: 'nonconforming_events', dateField: 'event_date', titleField: 'title' };
    case 'complaints': return { table: 'complaints', dateField: 'received_date', titleField: 'title' };
    case 'risks': return { table: 'risks', dateField: 'created_at', titleField: 'risk_area' };
    case 'actions': return { table: 'actions', dateField: 'created_at', titleField: 'title' };
    case 'equipment': return { table: 'equipment_items', dateField: 'created_at', titleField: 'name' };
    case 'supplier_inventory': return { table: 'inventory_items', dateField: 'created_at', titleField: 'name' };
    case 'monitoring': return { table: 'monitoring_records', dateField: 'sample_date', titleField: 'parameter' };
    case 'iqc': return { table: 'iqc_results', dateField: 'run_date', titleField: 'comment' };
    case 'eqa': return { table: 'eqa_events', dateField: 'received_date', titleField: 'cycle_name' };
    case 'blood_bank_handover': return { table: 'blood_bank_handovers', dateField: 'handover_date', titleField: 'handover_number' };
    case 'monthly_reports': return { table: 'monthly_report_batches', dateField: 'created_at', titleField: 'report_number' };
    case 'assessments': return { table: 'assessment_programs', dateField: 'planned_start_date', titleField: 'title' };
    case 'quality_indicators': return { table: 'quality_indicator_results', dateField: 'period_end', titleField: 'interpretation' };
    case 'customer_focus': return { table: 'customer_feedback', dateField: 'feedback_date', titleField: 'title' };
    case 'poct': return { table: 'poct_qc_results', dateField: 'qc_date', titleField: 'qc_number' };
    case 'notifications': return { table: 'notifications', dateField: 'created_at', titleField: 'title' };
    default: return null;
  }
}

function writeFileToUploads(db: any, originalName: string, contents: string, mimeType: string, userId: number): number {
  const storedName = safeStoredFilename(originalName);
  fs.writeFileSync(path.join(uploadRoot, storedName), contents, 'utf-8');
  const result = db.prepare('INSERT INTO files (original_name, stored_name, mime_type, size_bytes, storage_area, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)').run(originalName, storedName, mimeType, Buffer.byteLength(contents, 'utf-8'), 'uploads', userId);
  return Number(result.lastInsertRowid);
}

export function recordsReportsRoutes() {
  const router = Router();

  // -------- Summary (specific) --------
  router.get('/summary', requirePermission('records_reports', 'view'), (_req, res) => {
    const db = getDb();
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);
    const count = (sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { count: number }).count;
    res.json({
      activeReportTemplates: count("SELECT COUNT(*) count FROM report_templates WHERE is_active = 1"),
      reportsGeneratedThisMonth: count("SELECT COUNT(*) count FROM report_requests WHERE created_at >= ? AND status IN ('generated','reviewed','approved','archived')", monthStart),
      openEvidencePacks: count("SELECT COUNT(*) count FROM evidence_packs WHERE status NOT IN ('approved','archived')"),
      pendingApprovals: count("SELECT COUNT(*) count FROM report_requests WHERE status = 'reviewed'") + count("SELECT COUNT(*) count FROM evidence_packs WHERE status = 'reviewed'"),
      printJobsThisMonth: count("SELECT COUNT(*) count FROM print_jobs WHERE created_at >= ?", monthStart),
      retentionReviewsDue: count("SELECT COUNT(*) count FROM record_retention_reviews WHERE status = 'draft'"),
      backupChecksThisMonth: count("SELECT COUNT(*) count FROM backup_restore_checks WHERE created_at >= ?", monthStart),
      openIntegrityIssues: count("SELECT COUNT(*) count FROM data_integrity_checks WHERE status IN ('issues_found','action_required')")
    });
  });

  // ============= Report templates =============
  router.get('/templates', requirePermission('records_reports.generate', 'view'), (req, res) => {
    const db = getDb();
    const filters: string[] = []; const params: unknown[] = [];
    if (req.query.moduleKey) { filters.push('module_key = ?'); params.push(String(req.query.moduleKey)); }
    if (req.query.isActive !== undefined) { filters.push('is_active = ?'); params.push(req.query.isActive === 'true' ? 1 : 0); }
    let query = 'SELECT * FROM report_templates';
    if (filters.length) query += ` WHERE ${filters.join(' AND ')}`;
    query += ' ORDER BY template_name';
    res.json(db.prepare(query).all(...params));
  });

  router.post('/templates', requirePermission('records_reports.generate', 'create'), (req, res) => {
    if (!req.body.templateName) return res.status(400).json({ error: 'templateName is required' });
    if (!req.body.templateType) return res.status(400).json({ error: 'templateType is required' });
    if (!req.body.outputFormat) return res.status(400).json({ error: 'outputFormat is required' });
    if (!OUTPUT_FORMATS.includes(req.body.outputFormat)) return res.status(400).json({ error: `outputFormat must be one of: ${OUTPUT_FORMATS.join(', ')}` });
    const db = getDb();
    const createdAt = new Date().toISOString();
    const templateCode = req.body.templateCode || generateRecordNumber(db, 'report_templates', 'RPTT', createdAt);
    const result = db.prepare(`INSERT INTO report_templates (template_code, template_name, template_type, module_key, description, output_format, template_config_json, is_active, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(templateCode, req.body.templateName, req.body.templateType, req.body.moduleKey ?? null, req.body.description ?? null, req.body.outputFormat, req.body.templateConfigJson ?? null, req.body.isActive === false ? 0 : 1, req.user!.id);
    const id = Number(result.lastInsertRowid);
    audit(req, { action: 'create', entity: 'report_templates', entityId: id, newValue: { templateCode, ...req.body } });
    res.status(201).json({ id, templateCode });
  });

  router.get('/templates/:id', requirePermission('records_reports.generate', 'view'), (req, res) => {
    const db = getDb();
    const t = db.prepare('SELECT * FROM report_templates WHERE id = ?').get(req.params.id);
    if (!t) return res.status(404).json({ error: 'Template not found' });
    res.json(t);
  });

  router.put('/templates/:id', requirePermission('records_reports.generate', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM report_templates WHERE id = ?').get(req.params.id) as any;
    if (!oldValue) return res.status(404).json({ error: 'Template not found' });
    if (req.body.outputFormat && !OUTPUT_FORMATS.includes(req.body.outputFormat)) return res.status(400).json({ error: `outputFormat must be one of: ${OUTPUT_FORMATS.join(', ')}` });
    db.prepare(`UPDATE report_templates SET template_name = ?, template_type = ?, module_key = ?, description = ?, output_format = ?, template_config_json = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(req.body.templateName ?? oldValue.template_name, req.body.templateType ?? oldValue.template_type, req.body.moduleKey ?? oldValue.module_key, req.body.description ?? oldValue.description, req.body.outputFormat ?? oldValue.output_format, req.body.templateConfigJson ?? oldValue.template_config_json, req.body.isActive !== undefined ? (req.body.isActive ? 1 : 0) : oldValue.is_active, req.params.id);
    audit(req, { action: 'edit', entity: 'report_templates', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  router.post('/templates/:id/toggle', requirePermission('records_reports.generate', 'edit'), (req, res) => {
    const db = getDb();
    const t = db.prepare('SELECT * FROM report_templates WHERE id = ?').get(req.params.id) as any;
    if (!t) return res.status(404).json({ error: 'Template not found' });
    const newActive = t.is_active ? 0 : 1;
    db.prepare('UPDATE report_templates SET is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(newActive, req.params.id);
    audit(req, { action: 'toggle', entity: 'report_templates', entityId: req.params.id, oldValue: { is_active: t.is_active }, newValue: { is_active: newActive } });
    res.json({ ok: true, isActive: newActive === 1 });
  });

  // ============= Report requests =============
  router.get('/reports', requirePermission('records_reports.generate', 'view'), (req, res) => {
    const db = getDb();
    const filters: string[] = []; const params: unknown[] = [];
    if (req.query.status) { filters.push('status = ?'); params.push(String(req.query.status)); }
    if (req.query.moduleKey) { filters.push('module_key = ?'); params.push(String(req.query.moduleKey)); }
    let query = 'SELECT * FROM report_requests';
    if (filters.length) query += ` WHERE ${filters.join(' AND ')}`;
    query += ' ORDER BY created_at DESC LIMIT 500';
    res.json(db.prepare(query).all(...params));
  });

  router.post('/reports', requirePermission('records_reports.generate', 'create'), (req, res) => {
    if (!req.body.reportTitle) return res.status(400).json({ error: 'reportTitle is required' });
    if (!req.body.moduleKey) return res.status(400).json({ error: 'moduleKey is required' });
    const db = getDb();
    const createdAt = new Date().toISOString();
    const requestNumber = generateRecordNumber(db, 'report_requests', 'RREQ', createdAt);
    const requestedBy = getStaffIdOrCurrent(req, req.body.requestedByStaffId);
    const result = db.prepare(`INSERT INTO report_requests (request_number, report_template_id, report_title, module_key, date_from, date_to, requested_by_staff_id, status, filter_json, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(requestNumber, parseIntNullable(req.body.reportTemplateId), req.body.reportTitle, req.body.moduleKey, req.body.dateFrom ?? null, req.body.dateTo ?? null, requestedBy, 'draft', req.body.filterJson ?? null, req.user!.id, createdAt);
    const id = Number(result.lastInsertRowid);
    audit(req, { action: 'create', entity: 'report_requests', entityId: id, newValue: { requestNumber, ...req.body } });
    res.status(201).json({ id, requestNumber });
  });

  router.get('/reports/:id', requirePermission('records_reports.generate', 'view'), (req, res) => {
    const db = getDb();
    const r = db.prepare('SELECT * FROM report_requests WHERE id = ?').get(req.params.id);
    if (!r) return res.status(404).json({ error: 'Report request not found' });
    const exports_ = db.prepare('SELECT * FROM report_exports WHERE report_request_id = ? ORDER BY created_at DESC').all(req.params.id);
    res.json({ ...r, exports: exports_ });
  });

  router.put('/reports/:id', requirePermission('records_reports.generate', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM report_requests WHERE id = ?').get(req.params.id) as any;
    if (!oldValue) return res.status(404).json({ error: 'Report request not found' });
    if (req.body.status && !REPORT_STATUSES.includes(req.body.status)) return res.status(400).json({ error: `status must be one of: ${REPORT_STATUSES.join(', ')}` });
    db.prepare(`UPDATE report_requests SET report_title = ?, module_key = ?, date_from = ?, date_to = ?, filter_json = ?, summary = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(req.body.reportTitle ?? oldValue.report_title, req.body.moduleKey ?? oldValue.module_key, req.body.dateFrom ?? oldValue.date_from, req.body.dateTo ?? oldValue.date_to, req.body.filterJson ?? oldValue.filter_json, req.body.summary ?? oldValue.summary, req.body.status ?? oldValue.status, req.params.id);
    audit(req, { action: 'edit', entity: 'report_requests', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  router.post('/reports/:id/generate', requirePermission('records_reports.generate', 'create'), (req, res) => {
    const db = getDb();
    const r = db.prepare('SELECT * FROM report_requests WHERE id = ?').get(req.params.id) as any;
    if (!r) return res.status(404).json({ error: 'Report request not found' });
    const map = tableForModule(r.module_key);
    if (!map) {
      db.prepare("UPDATE report_requests SET summary = ?, status = 'generated', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(`Data source for module "${r.module_key}" is not yet available for direct report generation. Use module-specific export instead.`, req.params.id);
      audit(req, { action: 'generate', entity: 'report_requests', entityId: req.params.id, newValue: { skipped: true, moduleKey: r.module_key } });
      return res.json({ ok: true, skipped: true, summary: `Module ${r.module_key} has no direct data source mapping in the simple report engine.` });
    }
    const baseFilters: string[] = []; const baseParams: unknown[] = [];
    if (r.date_from) { baseFilters.push(`${map.dateField} >= ?`); baseParams.push(r.date_from); }
    if (r.date_to) { baseFilters.push(`${map.dateField} <= ?`); baseParams.push(r.date_to); }
    const applied = applyFilterJson(db, map.table, r.filter_json, baseFilters, baseParams);
    const where = applied.filters.length ? `WHERE ${applied.filters.join(' AND ')}` : '';
    const total = (db.prepare(`SELECT COUNT(*) AS c FROM ${map.table} ${where}`).get(...applied.params) as { c: number }).c;
    const sample = db.prepare(`SELECT * FROM ${map.table} ${where} ORDER BY ${map.dateField} DESC LIMIT 200`).all(...applied.params) as any[];
    const summary = `Report generated for ${r.module_key} (${map.table}) from ${r.date_from || 'beginning'} to ${r.date_to || 'today'}. Total records: ${total}. Sample size: ${Math.min(sample.length, 200)}.${applied.rejectedKeys.length ? ` Filter keys ignored (no such column): ${applied.rejectedKeys.join(', ')}.` : ''}`;
    db.prepare("UPDATE report_requests SET summary = ?, status = 'generated', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(summary, req.params.id);
    audit(req, { action: 'generate', entity: 'report_requests', entityId: req.params.id, newValue: { totalRecords: total, moduleKey: r.module_key, rejectedFilterKeys: applied.rejectedKeys } });
    res.json({ ok: true, total, sampleCount: sample.length, summary, rejectedFilterKeys: applied.rejectedKeys });
  });

  router.post('/reports/:id/review', requirePermission('records_reports.generate', 'edit'), (req, res) => {
    const db = getDb();
    const r = db.prepare('SELECT * FROM report_requests WHERE id = ?').get(req.params.id) as any;
    if (!r) return res.status(404).json({ error: 'Report request not found' });
    const staffId = getStaffIdOrCurrent(req, req.body.reviewedByStaffId);
    if (staffId === null) return res.status(400).json({ error: 'This action requires the logged-in user to be linked to a staff record.' });
    db.prepare("UPDATE report_requests SET status = 'reviewed', reviewed_by_staff_id = ?, reviewed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(staffId, req.params.id);
    audit(req, { action: 'review', entity: 'report_requests', entityId: req.params.id, oldValue: { status: r.status }, newValue: { status: 'reviewed', reviewedByStaffId: staffId } });
    res.json({ ok: true });
  });

  router.post('/reports/:id/approve', requirePermission('records_reports.generate', 'approve'), (req, res) => {
    const db = getDb();
    const r = db.prepare('SELECT * FROM report_requests WHERE id = ?').get(req.params.id) as any;
    if (!r) return res.status(404).json({ error: 'Report request not found' });
    const staffId = getStaffIdOrCurrent(req, req.body.approvedByStaffId);
    if (staffId === null) return res.status(400).json({ error: 'This action requires the logged-in user to be linked to a staff record.' });
    db.prepare("UPDATE report_requests SET status = 'approved', approved_by_staff_id = ?, approved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(staffId, req.params.id);
    audit(req, { action: 'approve', entity: 'report_requests', entityId: req.params.id, oldValue: { status: r.status }, newValue: { status: 'approved', approvedByStaffId: staffId } });
    res.json({ ok: true });
  });

  router.post('/reports/:id/export', requirePermission('records_reports.generate', 'export'), (req, res) => {
    const format = (req.body.format ?? 'csv').toLowerCase();
    if (!['csv', 'json', 'html'].includes(format)) return res.status(400).json({ error: 'format must be csv, json, or html' });
    const db = getDb();
    const r = db.prepare('SELECT * FROM report_requests WHERE id = ?').get(req.params.id) as any;
    if (!r) return res.status(404).json({ error: 'Report request not found' });
    const map = tableForModule(r.module_key);
    if (!map) return res.status(400).json({ error: `No data source mapping for module ${r.module_key}` });
    const baseFilters: string[] = []; const baseParams: unknown[] = [];
    if (r.date_from) { baseFilters.push(`${map.dateField} >= ?`); baseParams.push(r.date_from); }
    if (r.date_to) { baseFilters.push(`${map.dateField} <= ?`); baseParams.push(r.date_to); }
    const applied = applyFilterJson(db, map.table, r.filter_json, baseFilters, baseParams);
    const where = applied.filters.length ? `WHERE ${applied.filters.join(' AND ')}` : '';
    const rows = db.prepare(`SELECT * FROM ${map.table} ${where} ORDER BY ${map.dateField} DESC LIMIT 5000`).all(...applied.params) as any[];
    let body = ''; let mime = ''; let ext = format;
    if (format === 'json') { body = JSON.stringify({ request: r, rows }, null, 2); mime = 'application/json'; }
    else if (format === 'csv') {
      const headers = rows.length ? Object.keys(rows[0]) : [];
      body = [headers.join(','), ...rows.map(row => headers.map(h => csvEscape(row[h])).join(','))].join('\n');
      mime = 'text/csv';
    } else {
      const esc = (v: unknown) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const headers = rows.length ? Object.keys(rows[0]) : [];
      body = `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>${esc(r.report_title)}</title><style>body{font-family:'Times New Roman',serif;padding:18px}table{border-collapse:collapse;width:100%;font-size:11px}th,td{border:1px solid #888;padding:4px 6px;text-align:left}thead{background:#eef2f7}</style></head><body><h1>${esc(r.report_title)}</h1><p>Module: ${esc(r.module_key)} · Period: ${esc(r.date_from || '—')} → ${esc(r.date_to || '—')} · Rows: ${rows.length}</p><table><thead><tr>${headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${headers.map(h => `<td>${esc(row[h])}</td>`).join('')}</tr>`).join('')}</tbody></table></body></html>`;
      mime = 'text/html';
    }
    const fileName = `${r.request_number}.${ext}`;
    const fileId = writeFileToUploads(db, fileName, body, mime, req.user!.id);
    const createdAt = new Date().toISOString();
    const exportNumber = generateRecordNumber(db, 'report_exports', 'REXP', createdAt);
    const exportedBy = getStaffIdOrCurrent(req, req.body.exportedByStaffId);
    db.prepare(`INSERT INTO report_exports (export_number, report_request_id, export_format, file_id, exported_by_staff_id, exported_at, status, created_by) VALUES (?, ?, ?, ?, ?, ?, 'completed', ?)`).run(exportNumber, req.params.id, format, fileId, exportedBy, createdAt, req.user!.id);
    db.prepare('UPDATE report_requests SET generated_file_id = COALESCE(generated_file_id, ?), updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(fileId, req.params.id);
    insertLink(db, { module: 'records_reports', type: 'report_requests', id: req.params.id }, { module: 'documents', type: 'files', id: fileId }, `Report export (${format})`);
    audit(req, { action: 'export', entity: 'report_requests', entityId: req.params.id, newValue: { exportNumber, format, fileId, rowCount: rows.length } });
    res.json({ ok: true, exportNumber, fileId, fileName, rowCount: rows.length });
  });

  // ============= Print jobs =============
  router.get('/print-jobs', requirePermission('records_reports.print', 'view'), (req, res) => {
    const db = getDb();
    const filters: string[] = []; const params: unknown[] = [];
    if (req.query.moduleKey) { filters.push('module_key = ?'); params.push(String(req.query.moduleKey)); }
    let query = 'SELECT * FROM print_jobs';
    if (filters.length) query += ` WHERE ${filters.join(' AND ')}`;
    query += ' ORDER BY printed_at DESC, id DESC LIMIT 500';
    res.json(db.prepare(query).all(...params));
  });

  router.post('/print-jobs', requirePermission('records_reports.print', 'print'), (req, res) => {
    if (!req.body.printTitle) return res.status(400).json({ error: 'printTitle is required' });
    if (!req.body.printPurpose) return res.status(400).json({ error: 'printPurpose is required' });
    const db = getDb();
    const createdAt = new Date().toISOString();
    const printNumber = generateRecordNumber(db, 'print_jobs', 'PRT', createdAt);
    const printedBy = getStaffIdOrCurrent(req, req.body.printedByStaffId);
    const result = db.prepare(`INSERT INTO print_jobs (print_number, module_key, record_type, record_id, print_title, print_purpose, printed_by_staff_id, printed_at, controlled_copy, copy_number, watermark, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'logged', ?)`)
      .run(printNumber, req.body.moduleKey ?? null, req.body.recordType ?? null, req.body.recordId ?? null, req.body.printTitle, req.body.printPurpose, printedBy, req.body.printedAt ?? createdAt, req.body.controlledCopy ? 1 : 0, req.body.copyNumber ?? null, req.body.watermark ?? null, req.user!.id);
    const id = Number(result.lastInsertRowid);
    audit(req, { action: 'create', entity: 'print_jobs', entityId: id, newValue: { printNumber, ...req.body } });
    res.status(201).json({ id, printNumber });
  });

  router.get('/print-jobs/:id', requirePermission('records_reports.print', 'view'), (req, res) => {
    const db = getDb();
    const p = db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(req.params.id);
    if (!p) return res.status(404).json({ error: 'Print job not found' });
    res.json(p);
  });

  // ============= Evidence packs =============
  router.get('/evidence-packs', requirePermission('records_reports.evidence', 'view'), (req, res) => {
    const db = getDb();
    const filters: string[] = []; const params: unknown[] = [];
    if (req.query.status) { filters.push('status = ?'); params.push(String(req.query.status)); }
    let query = 'SELECT * FROM evidence_packs';
    if (filters.length) query += ` WHERE ${filters.join(' AND ')}`;
    query += ' ORDER BY created_at DESC';
    res.json(db.prepare(query).all(...params));
  });

  router.post('/evidence-packs', requirePermission('records_reports.evidence', 'create'), (req, res) => {
    if (!req.body.packTitle) return res.status(400).json({ error: 'packTitle is required' });
    if (!req.body.packPurpose) return res.status(400).json({ error: 'packPurpose is required' });
    const db = getDb();
    const createdAt = new Date().toISOString();
    const packNumber = generateRecordNumber(db, 'evidence_packs', 'EPACK', createdAt);
    const preparedBy = getStaffIdOrCurrent(req, req.body.preparedByStaffId);
    const result = db.prepare(`INSERT INTO evidence_packs (pack_number, pack_title, pack_purpose, date_from, date_to, prepared_by_staff_id, status, notes, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(packNumber, req.body.packTitle, req.body.packPurpose, req.body.dateFrom ?? null, req.body.dateTo ?? null, preparedBy, 'draft', req.body.notes ?? null, req.user!.id, createdAt);
    const id = Number(result.lastInsertRowid);
    audit(req, { action: 'create', entity: 'evidence_packs', entityId: id, newValue: { packNumber, ...req.body } });
    res.status(201).json({ id, packNumber });
  });

  router.get('/evidence-packs/:id', requirePermission('records_reports.evidence', 'view'), (req, res) => {
    const db = getDb();
    const pack = db.prepare('SELECT * FROM evidence_packs WHERE id = ?').get(req.params.id) as any;
    if (!pack) return res.status(404).json({ error: 'Evidence pack not found' });
    const items = db.prepare('SELECT * FROM evidence_pack_items WHERE evidence_pack_id = ? ORDER BY display_order, id').all(req.params.id);
    res.json({ ...pack, items });
  });

  router.put('/evidence-packs/:id', requirePermission('records_reports.evidence', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM evidence_packs WHERE id = ?').get(req.params.id) as any;
    if (!oldValue) return res.status(404).json({ error: 'Evidence pack not found' });
    if (req.body.status && !EVIDENCE_PACK_STATUSES.includes(req.body.status)) return res.status(400).json({ error: `status must be one of: ${EVIDENCE_PACK_STATUSES.join(', ')}` });
    db.prepare(`UPDATE evidence_packs SET pack_title = ?, pack_purpose = ?, date_from = ?, date_to = ?, status = ?, notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(req.body.packTitle ?? oldValue.pack_title, req.body.packPurpose ?? oldValue.pack_purpose, req.body.dateFrom ?? oldValue.date_from, req.body.dateTo ?? oldValue.date_to, req.body.status ?? oldValue.status, req.body.notes ?? oldValue.notes, req.params.id);
    audit(req, { action: 'edit', entity: 'evidence_packs', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  router.post('/evidence-packs/:id/items', requirePermission('records_reports.evidence', 'create'), (req, res) => {
    if (!req.body.moduleKey) return res.status(400).json({ error: 'moduleKey is required' });
    if (!req.body.recordType) return res.status(400).json({ error: 'recordType is required' });
    if (!req.body.recordId) return res.status(400).json({ error: 'recordId is required' });
    if (!req.body.itemTitle) return res.status(400).json({ error: 'itemTitle is required' });
    const db = getDb();
    const pack = db.prepare('SELECT id FROM evidence_packs WHERE id = ?').get(req.params.id);
    if (!pack) return res.status(404).json({ error: 'Evidence pack not found' });
    const result = db.prepare(`INSERT INTO evidence_pack_items (evidence_pack_id, module_key, record_type, record_id, item_title, item_summary, file_id, display_order, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(req.params.id, req.body.moduleKey, req.body.recordType, String(req.body.recordId), req.body.itemTitle, req.body.itemSummary ?? null, parseIntNullable(req.body.fileId), parseIntNullable(req.body.displayOrder) ?? 0, req.user!.id);
    const id = Number(result.lastInsertRowid);
    insertLink(db, { module: 'records_reports', type: 'evidence_pack_items', id }, { module: req.body.moduleKey, type: req.body.recordType, id: String(req.body.recordId) }, `Evidence pack item: ${req.body.itemTitle}`);
    audit(req, { action: 'add_item', entity: 'evidence_packs', entityId: req.params.id, newValue: { itemId: id, ...req.body } });
    res.status(201).json({ id });
  });

  router.delete('/evidence-packs/:id/items/:itemId', requirePermission('records_reports.evidence', 'edit'), (req, res) => {
    const db = getDb();
    const item = db.prepare('SELECT * FROM evidence_pack_items WHERE id = ? AND evidence_pack_id = ?').get(req.params.itemId, req.params.id) as any;
    if (!item) return res.status(404).json({ error: 'Item not found on this pack' });
    db.prepare('DELETE FROM evidence_pack_items WHERE id = ?').run(req.params.itemId);
    audit(req, { action: 'remove_item', entity: 'evidence_packs', entityId: req.params.id, oldValue: item });
    res.json({ ok: true });
  });

  router.post('/evidence-packs/:id/generate', requirePermission('records_reports.evidence', 'create'), (req, res) => {
    const db = getDb();
    const pack = db.prepare('SELECT * FROM evidence_packs WHERE id = ?').get(req.params.id) as any;
    if (!pack) return res.status(404).json({ error: 'Evidence pack not found' });
    const items = db.prepare('SELECT * FROM evidence_pack_items WHERE evidence_pack_id = ? ORDER BY display_order, id').all(req.params.id) as any[];
    const payload = { pack, items, generatedAt: new Date().toISOString() };
    const body = JSON.stringify(payload, null, 2);
    const fileName = `${pack.pack_number}.json`;
    const fileId = writeFileToUploads(db, fileName, body, 'application/json', req.user!.id);
    db.prepare("UPDATE evidence_packs SET generated_file_id = ?, status = CASE WHEN status = 'draft' THEN 'prepared' ELSE status END, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(fileId, req.params.id);
    insertLink(db, { module: 'records_reports', type: 'evidence_packs', id: req.params.id }, { module: 'documents', type: 'files', id: fileId }, 'Evidence pack summary');
    audit(req, { action: 'generate', entity: 'evidence_packs', entityId: req.params.id, newValue: { fileId, itemCount: items.length } });
    res.json({ ok: true, fileId, fileName, itemCount: items.length });
  });

  router.get('/evidence-packs/:id/print', requirePermission('records_reports.evidence', 'print'), (req, res) => {
    const db = getDb();
    const pack = db.prepare('SELECT * FROM evidence_packs WHERE id = ?').get(req.params.id) as any;
    if (!pack) return res.status(404).send('Evidence pack not found');
    const items = db.prepare('SELECT * FROM evidence_pack_items WHERE evidence_pack_id = ? ORDER BY display_order, id').all(req.params.id) as any[];
    const esc = (v: unknown) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const autoprint = req.query.autoprint === '0' ? '' : '<script>window.addEventListener("load", () => { setTimeout(() => window.print(), 250); });</script>';
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>${esc(pack.pack_number)} — Evidence pack</title>
<style>@page{size:A4;margin:14mm}body{font-family:'Times New Roman',Georgia,serif;color:#111;padding:18px 24px;line-height:1.4}.no-print{background:#f4f6fb;padding:8px 12px;border:1px solid #ccd;border-radius:6px;margin-bottom:12px;font-size:12px}h1{font-size:20px;border-bottom:2px solid #1B3A6B;padding-bottom:6px;margin:0 0 12px}h2{font-size:14px;color:#1B3A6B;margin-top:18px;border-bottom:1px solid #ccd;padding-bottom:3px}table.meta{border-collapse:collapse;width:100%;font-size:11px;margin:6px 0 16px}table.meta th,table.meta td{border:1px solid #888;padding:4px 8px;text-align:left;vertical-align:top}table.meta th{background:#eef2f7;width:22%}table.items{border-collapse:collapse;width:100%;font-size:10.5px}table.items th,table.items td{border:1px solid #aaa;padding:4px 6px;vertical-align:top}table.items thead th{background:#eef2f7}.signoff{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-top:28px}.signoff .block{border-top:1px solid #555;padding-top:4px;font-size:11px}@media print{.no-print{display:none}body{padding:0}}</style>${autoprint}</head><body>
<div class="no-print">The print dialog will open automatically. Choose any printer or Save as PDF. <button onclick="window.print()">Print</button> <a href="?autoprint=0">disable autoprint</a></div>
<h1>${esc(pack.pack_number)} &nbsp;&mdash;&nbsp; ${esc(pack.pack_title)}</h1>
<table class="meta"><tr><th>Purpose</th><td>${esc(pack.pack_purpose)}</td><th>Status</th><td>${esc(pack.status)}</td></tr>
<tr><th>Period</th><td>${esc(pack.date_from || '—')} → ${esc(pack.date_to || '—')}</td><th>Items</th><td>${items.length}</td></tr>
${pack.notes ? `<tr><th>Notes</th><td colspan="3">${esc(pack.notes)}</td></tr>` : ''}</table>
<h2>Pack items</h2>
<table class="items"><thead><tr><th style="width:5%">#</th><th>Module / record</th><th>Title</th><th>Summary</th></tr></thead><tbody>
${items.map((i, idx) => `<tr><td>${idx + 1}</td><td>${esc(i.module_key)}/${esc(i.record_type)}#${esc(i.record_id)}</td><td>${esc(i.item_title)}</td><td>${esc(i.item_summary || '—')}</td></tr>`).join('')}
</tbody></table>
<div class="signoff"><div class="block"><strong>Prepared by</strong><br/>__________________________<br/><br/>Date: __________________</div><div class="block"><strong>Reviewed/approved by</strong><br/>__________________________<br/><br/>Date: __________________</div></div>
<p style="margin-top:24px;font-size:10px;color:#555">SECH_LIMS by Nickland · Generated ${new Date().toISOString().slice(0,19).replace('T',' ')} · Internal use only.</p>
</body></html>`;
    audit(req, { action: 'print', entity: 'evidence_packs', entityId: req.params.id });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  });

  router.post('/evidence-packs/:id/review', requirePermission('records_reports.evidence', 'edit'), (req, res) => {
    const db = getDb();
    const pack = db.prepare('SELECT * FROM evidence_packs WHERE id = ?').get(req.params.id) as any;
    if (!pack) return res.status(404).json({ error: 'Evidence pack not found' });
    const staffId = getStaffIdOrCurrent(req, req.body.reviewedByStaffId);
    if (staffId === null) return res.status(400).json({ error: 'This action requires the logged-in user to be linked to a staff record.' });
    db.prepare("UPDATE evidence_packs SET status = 'reviewed', reviewed_by_staff_id = ?, reviewed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(staffId, req.params.id);
    audit(req, { action: 'review', entity: 'evidence_packs', entityId: req.params.id, oldValue: { status: pack.status }, newValue: { status: 'reviewed', reviewedByStaffId: staffId } });
    res.json({ ok: true });
  });

  router.post('/evidence-packs/:id/approve', requirePermission('records_reports.evidence', 'approve'), (req, res) => {
    const db = getDb();
    const pack = db.prepare('SELECT * FROM evidence_packs WHERE id = ?').get(req.params.id) as any;
    if (!pack) return res.status(404).json({ error: 'Evidence pack not found' });
    const staffId = getStaffIdOrCurrent(req, req.body.approvedByStaffId);
    if (staffId === null) return res.status(400).json({ error: 'This action requires the logged-in user to be linked to a staff record.' });
    db.prepare("UPDATE evidence_packs SET status = 'approved', approved_by_staff_id = ?, approved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(staffId, req.params.id);
    audit(req, { action: 'approve', entity: 'evidence_packs', entityId: req.params.id, oldValue: { status: pack.status }, newValue: { status: 'approved', approvedByStaffId: staffId } });
    res.json({ ok: true });
  });

  router.post('/evidence-packs/:id/archive', requirePermission('records_reports.evidence', 'approve'), (req, res) => {
    const db = getDb();
    const pack = db.prepare('SELECT * FROM evidence_packs WHERE id = ?').get(req.params.id) as any;
    if (!pack) return res.status(404).json({ error: 'Evidence pack not found' });
    db.prepare("UPDATE evidence_packs SET status = 'archived', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
    audit(req, { action: 'archive', entity: 'evidence_packs', entityId: req.params.id, oldValue: { status: pack.status }, newValue: { status: 'archived' } });
    res.json({ ok: true });
  });

  // ============= Retention rules + reviews =============
  router.get('/retention-rules', requirePermission('records_reports.retention', 'view'), (_req, res) => {
    const db = getDb();
    res.json(db.prepare('SELECT * FROM record_retention_rules ORDER BY module_key, record_type').all());
  });

  router.post('/retention-rules', requirePermission('records_reports.retention', 'create'), (req, res) => {
    if (!req.body.ruleName) return res.status(400).json({ error: 'ruleName is required' });
    if (!req.body.moduleKey) return res.status(400).json({ error: 'moduleKey is required' });
    if (!req.body.recordType) return res.status(400).json({ error: 'recordType is required' });
    if (!req.body.retentionPeriodMonths) return res.status(400).json({ error: 'retentionPeriodMonths is required' });
    const months = parseIntNullable(req.body.retentionPeriodMonths);
    if (months === null || months < 1) return res.status(400).json({ error: 'retentionPeriodMonths must be a positive integer' });
    const archiveAction = req.body.archiveAction ?? 'flag_for_review';
    if (!ARCHIVE_ACTIONS.includes(archiveAction)) return res.status(400).json({ error: `archiveAction must be one of: ${ARCHIVE_ACTIONS.join(', ')}` });
    const db = getDb();
    const result = db.prepare(`INSERT INTO record_retention_rules (rule_code, rule_name, module_key, record_type, retention_period_months, archive_action, is_active, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(req.body.ruleCode ?? null, req.body.ruleName, req.body.moduleKey, req.body.recordType, months, archiveAction, req.body.isActive === false ? 0 : 1, req.body.notes ?? null, req.user!.id);
    const id = Number(result.lastInsertRowid);
    audit(req, { action: 'create', entity: 'record_retention_rules', entityId: id, newValue: req.body });
    res.status(201).json({ id });
  });

  router.put('/retention-rules/:id', requirePermission('records_reports.retention', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM record_retention_rules WHERE id = ?').get(req.params.id) as any;
    if (!oldValue) return res.status(404).json({ error: 'Rule not found' });
    if (req.body.archiveAction && !ARCHIVE_ACTIONS.includes(req.body.archiveAction)) return res.status(400).json({ error: `archiveAction must be one of: ${ARCHIVE_ACTIONS.join(', ')}` });
    db.prepare(`UPDATE record_retention_rules SET rule_name = ?, module_key = ?, record_type = ?, retention_period_months = ?, archive_action = ?, is_active = ?, notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(req.body.ruleName ?? oldValue.rule_name, req.body.moduleKey ?? oldValue.module_key, req.body.recordType ?? oldValue.record_type, parseIntNullable(req.body.retentionPeriodMonths) ?? oldValue.retention_period_months, req.body.archiveAction ?? oldValue.archive_action, req.body.isActive !== undefined ? (req.body.isActive ? 1 : 0) : oldValue.is_active, req.body.notes ?? oldValue.notes, req.params.id);
    audit(req, { action: 'edit', entity: 'record_retention_rules', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  router.post('/retention-rules/:id/toggle', requirePermission('records_reports.retention', 'edit'), (req, res) => {
    const db = getDb();
    const rule = db.prepare('SELECT * FROM record_retention_rules WHERE id = ?').get(req.params.id) as any;
    if (!rule) return res.status(404).json({ error: 'Rule not found' });
    const newActive = rule.is_active ? 0 : 1;
    db.prepare('UPDATE record_retention_rules SET is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(newActive, req.params.id);
    audit(req, { action: 'toggle', entity: 'record_retention_rules', entityId: req.params.id, oldValue: { is_active: rule.is_active }, newValue: { is_active: newActive } });
    res.json({ ok: true, isActive: newActive === 1 });
  });

  router.get('/retention-reviews', requirePermission('records_reports.retention', 'view'), (_req, res) => {
    const db = getDb();
    res.json(db.prepare('SELECT * FROM record_retention_reviews ORDER BY review_date DESC').all());
  });

  router.post('/retention-reviews', requirePermission('records_reports.retention', 'create'), (req, res) => {
    if (!req.body.reviewDate) return res.status(400).json({ error: 'reviewDate is required' });
    const db = getDb();
    const createdAt = new Date().toISOString();
    const reviewNumber = generateRecordNumber(db, 'record_retention_reviews', 'RET', createdAt);
    // Optionally compute due-for-archive count if module/recordType set with rule.
    let dueForArchive = 0;
    if (req.body.moduleKey && req.body.recordType) {
      const rule = db.prepare('SELECT * FROM record_retention_rules WHERE module_key = ? AND record_type = ? AND is_active = 1').get(req.body.moduleKey, req.body.recordType) as any;
      const map = tableForModule(req.body.moduleKey);
      if (rule && map) {
        const cutoff = new Date(Date.now() - Number(rule.retention_period_months) * 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        try { dueForArchive = (db.prepare(`SELECT COUNT(*) AS c FROM ${map.table} WHERE ${map.dateField} <= ?`).get(cutoff) as { c: number }).c; } catch {}
      }
    }
    const reviewedBy = getStaffIdOrCurrent(req, req.body.reviewedByStaffId);
    const result = db.prepare(`INSERT INTO record_retention_reviews (review_number, review_date, module_key, record_type, records_reviewed, records_due_for_archive, records_archived, reviewed_by_staff_id, status, notes, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(reviewNumber, req.body.reviewDate, req.body.moduleKey ?? null, req.body.recordType ?? null, parseIntNullable(req.body.recordsReviewed) ?? 0, dueForArchive, 0, reviewedBy, 'draft', req.body.notes ?? null, req.user!.id, createdAt);
    const id = Number(result.lastInsertRowid);
    audit(req, { action: 'create', entity: 'record_retention_reviews', entityId: id, newValue: { reviewNumber, dueForArchive, ...req.body } });
    res.status(201).json({ id, reviewNumber, recordsDueForArchive: dueForArchive });
  });

  router.get('/retention-reviews/:id', requirePermission('records_reports.retention', 'view'), (req, res) => {
    const db = getDb();
    const r = db.prepare('SELECT * FROM record_retention_reviews WHERE id = ?').get(req.params.id);
    if (!r) return res.status(404).json({ error: 'Retention review not found' });
    res.json(r);
  });

  router.post('/retention-reviews/:id/complete', requirePermission('records_reports.retention', 'edit'), (req, res) => {
    const db = getDb();
    const r = db.prepare('SELECT * FROM record_retention_reviews WHERE id = ?').get(req.params.id) as any;
    if (!r) return res.status(404).json({ error: 'Retention review not found' });
    const archived = parseIntNullable(req.body.recordsArchived) ?? r.records_archived;
    const reviewed = parseIntNullable(req.body.recordsReviewed) ?? r.records_reviewed;
    db.prepare("UPDATE record_retention_reviews SET records_reviewed = ?, records_archived = ?, status = 'completed', notes = COALESCE(?, notes), updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(reviewed, archived, req.body.notes ?? null, req.params.id);
    audit(req, { action: 'complete', entity: 'record_retention_reviews', entityId: req.params.id, oldValue: { status: r.status }, newValue: { status: 'completed', recordsArchived: archived } });
    res.json({ ok: true });
  });

  // ============= Audit trail =============
  router.get('/audit-trail', requirePermission('records_reports.audit', 'view'), (req, res) => {
    const db = getDb();
    const filters: string[] = []; const params: unknown[] = [];
    if (req.query.from) { filters.push('created_at >= ?'); params.push(String(req.query.from)); }
    if (req.query.to) { filters.push('created_at <= ?'); params.push(String(req.query.to)); }
    if (req.query.entity) { filters.push('entity = ?'); params.push(String(req.query.entity)); }
    if (req.query.actorUserId) { filters.push('actor_user_id = ?'); params.push(Number(req.query.actorUserId)); }
    if (req.query.action) { filters.push('action = ?'); params.push(String(req.query.action)); }
    let query = 'SELECT * FROM audit_logs';
    if (filters.length) query += ` WHERE ${filters.join(' AND ')}`;
    query += ' ORDER BY id DESC LIMIT 500';
    res.json(db.prepare(query).all(...params));
  });

  // "Has this trail been tampered with?" — the question an assessor asks, and
  // until the hash chain existed there was no way to answer it. Available to
  // anyone who may read the trail, including the Independent Reviewer role,
  // which holds this and no administrative right at all.
  router.get('/audit-trail/verify', requirePermission('records_reports.audit', 'view'), (_req, res) => {
    res.json(verifyAuditChain());
  });

  router.get('/audit-trail/summary', requirePermission('records_reports.audit', 'view'), (req, res) => {
    const db = getDb();
    const filters: string[] = []; const params: unknown[] = [];
    if (req.query.from) { filters.push('created_at >= ?'); params.push(String(req.query.from)); }
    if (req.query.to) { filters.push('created_at <= ?'); params.push(String(req.query.to)); }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const total = (db.prepare(`SELECT COUNT(*) AS c FROM audit_logs ${where}`).get(...params) as { c: number }).c;
    const byAction = db.prepare(`SELECT action, COUNT(*) AS c FROM audit_logs ${where} GROUP BY action ORDER BY c DESC LIMIT 25`).all(...params);
    const byEntity = db.prepare(`SELECT entity, COUNT(*) AS c FROM audit_logs ${where} GROUP BY entity ORDER BY c DESC LIMIT 25`).all(...params);
    const byActor = db.prepare(`SELECT actor_user_id, COUNT(*) AS c FROM audit_logs ${where} GROUP BY actor_user_id ORDER BY c DESC LIMIT 25`).all(...params);
    res.json({ total, byAction, byEntity, byActor });
  });

  router.get('/audit-reviews', requirePermission('records_reports.audit', 'view'), (_req, res) => {
    const db = getDb();
    res.json(db.prepare(`SELECT r.*, a.title AS action_title, a.status AS action_status, a.due_date AS action_due_date FROM audit_trail_reviews r LEFT JOIN actions a ON a.id = r.action_id ORDER BY r.review_date DESC`).all());
  });

  router.post('/audit-reviews', requirePermission('records_reports.audit', 'create'), (req, res) => {
    if (!req.body.reviewDate) return res.status(400).json({ error: 'reviewDate is required' });
    if (!req.body.dateFrom) return res.status(400).json({ error: 'dateFrom is required' });
    if (!req.body.dateTo) return res.status(400).json({ error: 'dateTo is required' });
    const db = getDb();
    const createdAt = new Date().toISOString();
    const reviewNumber = generateRecordNumber(db, 'audit_trail_reviews', 'ATR', createdAt);
    const reviewedBy = getStaffIdOrCurrent(req, req.body.reviewedByStaffId);
    const result = db.prepare(`INSERT INTO audit_trail_reviews (review_number, review_date, date_from, date_to, module_key, reviewed_by_staff_id, unusual_activity_noted, findings_summary, action_required, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(reviewNumber, req.body.reviewDate, req.body.dateFrom, req.body.dateTo, req.body.moduleKey ?? null, reviewedBy, req.body.unusualActivityNoted ? 1 : 0, req.body.findingsSummary ?? null, req.body.actionRequired ? 1 : 0, 'draft', req.user!.id, createdAt);
    const id = Number(result.lastInsertRowid);
    audit(req, { action: 'create', entity: 'audit_trail_reviews', entityId: id, newValue: { reviewNumber, ...req.body } });
    res.status(201).json({ id, reviewNumber });
  });

  router.get('/audit-reviews/:id', requirePermission('records_reports.audit', 'view'), (req, res) => {
    const db = getDb();
    const r = db.prepare('SELECT * FROM audit_trail_reviews WHERE id = ?').get(req.params.id);
    if (!r) return res.status(404).json({ error: 'Audit review not found' });
    res.json(r);
  });

  router.post('/audit-reviews/:id/create-action', requirePermission('actions', 'create'), (req, res) => {
    if (!req.body.title) return res.status(400).json({ error: 'title is required' });
    const db = getDb();
    const review = db.prepare('SELECT * FROM audit_trail_reviews WHERE id = ?').get(req.params.id) as any;
    if (!review) return res.status(404).json({ error: 'Audit review not found' });
    const r = db.prepare('INSERT INTO actions (title, module_key, source_module, source_record_id, description, priority, assigned_to_staff_id, due_date, status, evidence_required, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(req.body.title, 'records_reports', 'audit_trail_reviews', String(req.params.id), req.body.description ?? review.findings_summary ?? null, req.body.priority ?? 'normal', parseIntNullable(req.body.assignedToStaffId), req.body.dueDate ?? null, 'Not started', req.body.evidenceRequired ? 1 : 0, req.user!.id);
    const actionId = Number(r.lastInsertRowid);
    db.prepare("UPDATE audit_trail_reviews SET action_id = ?, status = 'action_required', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(actionId, req.params.id);
    insertLink(db, { module: 'records_reports', type: 'audit_trail_reviews', id: req.params.id }, { module: 'actions', type: 'actions', id: actionId }, 'Action from audit trail review');
    audit(req, { action: 'create', entity: 'actions', entityId: actionId, newValue: { sourceModule: 'audit_trail_reviews', ...req.body } });
    res.status(201).json({ id: actionId });
  });

  router.post('/audit-reviews/:id/close', requirePermission('records_reports.audit', 'approve'), (req, res) => {
    const db = getDb();
    const r = db.prepare('SELECT * FROM audit_trail_reviews WHERE id = ?').get(req.params.id) as any;
    if (!r) return res.status(404).json({ error: 'Audit review not found' });
    db.prepare("UPDATE audit_trail_reviews SET status = 'closed', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
    audit(req, { action: 'close', entity: 'audit_trail_reviews', entityId: req.params.id, oldValue: { status: r.status }, newValue: { status: 'closed' } });
    res.json({ ok: true });
  });

  // ============= Backup / restore checks =============
  router.get('/backup-checks', requirePermission('records_reports.retention', 'view'), (_req, res) => {
    const db = getDb();
    res.json(db.prepare('SELECT * FROM backup_restore_checks ORDER BY check_date DESC').all());
  });

  router.post('/backup-checks', requirePermission('records_reports.retention', 'create'), (req, res) => {
    if (!req.body.checkDate) return res.status(400).json({ error: 'checkDate is required' });
    if (!req.body.checkType) return res.status(400).json({ error: 'checkType is required' });
    if (!req.body.backupStatus) return res.status(400).json({ error: 'backupStatus is required' });
    const db = getDb();
    const createdAt = new Date().toISOString();
    const checkNumber = generateRecordNumber(db, 'backup_restore_checks', 'BRC', createdAt);
    const checkedBy = getStaffIdOrCurrent(req, req.body.checkedByStaffId);
    const status = req.body.backupStatus === 'failed' ? 'failed' : (req.body.restoreTestStatus === 'failed' ? 'failed' : (req.body.backupStatus === 'passed' ? 'passed' : 'draft'));
    const result = db.prepare(`INSERT INTO backup_restore_checks (check_number, check_date, check_type, backup_location, backup_file_name, backup_status, restore_test_status, checked_by_staff_id, findings, action_required, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(checkNumber, req.body.checkDate, req.body.checkType, req.body.backupLocation ?? null, req.body.backupFileName ?? null, req.body.backupStatus, req.body.restoreTestStatus ?? null, checkedBy, req.body.findings ?? null, req.body.actionRequired ? 1 : 0, status, req.user!.id, createdAt);
    const id = Number(result.lastInsertRowid);
    audit(req, { action: 'create', entity: 'backup_restore_checks', entityId: id, newValue: { checkNumber, ...req.body } });
    res.status(201).json({ id, checkNumber });
  });

  router.get('/backup-checks/:id', requirePermission('records_reports.retention', 'view'), (req, res) => {
    const db = getDb();
    const c = db.prepare('SELECT * FROM backup_restore_checks WHERE id = ?').get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Backup check not found' });
    res.json(c);
  });

  router.post('/backup-checks/:id/create-action', requirePermission('actions', 'create'), (req, res) => {
    if (!req.body.title) return res.status(400).json({ error: 'title is required' });
    const db = getDb();
    const check = db.prepare('SELECT * FROM backup_restore_checks WHERE id = ?').get(req.params.id) as any;
    if (!check) return res.status(404).json({ error: 'Backup check not found' });
    const r = db.prepare('INSERT INTO actions (title, module_key, source_module, source_record_id, description, priority, assigned_to_staff_id, due_date, status, evidence_required, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(req.body.title, 'records_reports', 'backup_restore_checks', String(req.params.id), req.body.description ?? check.findings ?? null, req.body.priority ?? (check.backup_status === 'failed' ? 'high' : 'normal'), parseIntNullable(req.body.assignedToStaffId), req.body.dueDate ?? null, 'Not started', req.body.evidenceRequired ? 1 : 0, req.user!.id);
    const actionId = Number(r.lastInsertRowid);
    db.prepare("UPDATE backup_restore_checks SET action_id = ?, status = 'action_required', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(actionId, req.params.id);
    insertLink(db, { module: 'records_reports', type: 'backup_restore_checks', id: req.params.id }, { module: 'actions', type: 'actions', id: actionId }, 'Action from backup check');
    audit(req, { action: 'create', entity: 'actions', entityId: actionId, newValue: { sourceModule: 'backup_restore_checks', ...req.body } });
    res.status(201).json({ id: actionId });
  });

  router.post('/backup-checks/:id/close', requirePermission('records_reports.retention', 'approve'), (req, res) => {
    const db = getDb();
    const c = db.prepare('SELECT * FROM backup_restore_checks WHERE id = ?').get(req.params.id) as any;
    if (!c) return res.status(404).json({ error: 'Backup check not found' });
    db.prepare("UPDATE backup_restore_checks SET status = 'closed', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
    audit(req, { action: 'close', entity: 'backup_restore_checks', entityId: req.params.id, oldValue: { status: c.status }, newValue: { status: 'closed' } });
    res.json({ ok: true });
  });

  // ============= Data integrity checks =============
  router.get('/data-integrity-checks', requirePermission('records_reports', 'view'), (_req, res) => {
    const db = getDb();
    res.json(db.prepare('SELECT * FROM data_integrity_checks ORDER BY check_date DESC').all());
  });

  router.post('/data-integrity-checks', requirePermission('records_reports', 'create'), (req, res) => {
    if (!req.body.checkDate) return res.status(400).json({ error: 'checkDate is required' });
    if (!req.body.checkType) return res.status(400).json({ error: 'checkType is required' });
    const db = getDb();
    const createdAt = new Date().toISOString();
    const checkNumber = generateRecordNumber(db, 'data_integrity_checks', 'DIC', createdAt);
    const checkedBy = getStaffIdOrCurrent(req, req.body.checkedByStaffId);
    const result = db.prepare(`INSERT INTO data_integrity_checks (check_number, check_date, check_type, module_key, records_checked, issues_found, findings_summary, action_required, status, checked_by_staff_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(checkNumber, req.body.checkDate, req.body.checkType, req.body.moduleKey ?? null, parseIntNullable(req.body.recordsChecked) ?? 0, parseIntNullable(req.body.issuesFound) ?? 0, req.body.findingsSummary ?? null, req.body.actionRequired ? 1 : 0, 'draft', checkedBy, req.user!.id, createdAt);
    const id = Number(result.lastInsertRowid);
    audit(req, { action: 'create', entity: 'data_integrity_checks', entityId: id, newValue: { checkNumber, ...req.body } });
    res.status(201).json({ id, checkNumber });
  });

  router.get('/data-integrity-checks/:id', requirePermission('records_reports', 'view'), (req, res) => {
    const db = getDb();
    const c = db.prepare('SELECT * FROM data_integrity_checks WHERE id = ?').get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Integrity check not found' });
    res.json(c);
  });

  router.post('/data-integrity-checks/:id/create-action', requirePermission('actions', 'create'), (req, res) => {
    if (!req.body.title) return res.status(400).json({ error: 'title is required' });
    const db = getDb();
    const check = db.prepare('SELECT * FROM data_integrity_checks WHERE id = ?').get(req.params.id) as any;
    if (!check) return res.status(404).json({ error: 'Integrity check not found' });
    const r = db.prepare('INSERT INTO actions (title, module_key, source_module, source_record_id, description, priority, assigned_to_staff_id, due_date, status, evidence_required, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(req.body.title, 'records_reports', 'data_integrity_checks', String(req.params.id), req.body.description ?? check.findings_summary ?? null, req.body.priority ?? 'normal', parseIntNullable(req.body.assignedToStaffId), req.body.dueDate ?? null, 'Not started', req.body.evidenceRequired ? 1 : 0, req.user!.id);
    const actionId = Number(r.lastInsertRowid);
    db.prepare("UPDATE data_integrity_checks SET action_id = ?, status = 'action_required', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(actionId, req.params.id);
    insertLink(db, { module: 'records_reports', type: 'data_integrity_checks', id: req.params.id }, { module: 'actions', type: 'actions', id: actionId }, 'Action from data integrity check');
    audit(req, { action: 'create', entity: 'actions', entityId: actionId, newValue: { sourceModule: 'data_integrity_checks', ...req.body } });
    res.status(201).json({ id: actionId });
  });

  router.post('/data-integrity-checks/:id/close', requirePermission('records_reports', 'approve'), (req, res) => {
    const db = getDb();
    const c = db.prepare('SELECT * FROM data_integrity_checks WHERE id = ?').get(req.params.id) as any;
    if (!c) return res.status(404).json({ error: 'Integrity check not found' });
    db.prepare("UPDATE data_integrity_checks SET status = 'closed', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
    audit(req, { action: 'close', entity: 'data_integrity_checks', entityId: req.params.id, oldValue: { status: c.status }, newValue: { status: 'closed' } });
    res.json({ ok: true });
  });

  router.post('/data-integrity-checks/run-basic-scan', requirePermission('records_reports', 'create'), (req, res) => {
    const db = getDb();
    const findings: string[] = [];
    let recordsChecked = 0; let issues = 0;
    const tableHas = (table: string, col: string) => {
      try { const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>; return cols.some(c => c.name === col); } catch { return false; }
    };
    const countSafe = (sql: string) => { try { return (db.prepare(sql).get() as { c: number }).c; } catch { return 0; } };
    const auditMissing = countSafe("SELECT COUNT(*) AS c FROM audit_logs WHERE created_at IS NULL");
    if (auditMissing > 0) { findings.push(`audit_logs missing created_at: ${auditMissing}`); issues += auditMissing; }
    recordsChecked += countSafe('SELECT COUNT(*) AS c FROM audit_logs');

    // The audit trail checked against itself. Each entry carries the hash of the
    // one before it, so an entry that has been rewritten or removed shows up
    // here as a break in the chain — which is the whole reason the chain exists
    // (validation finding VF-05). Anything found is an integrity incident, not
    // a tidy-up: it means the record of what the laboratory did has been edited.
    const chain = verifyAuditChain();
    if (!chain.ok) {
      findings.push(chain.message);
      issues += chain.altered.length + chain.broken.length;
      if (chain.altered.length) findings.push(`altered audit entries: ${chain.altered.slice(0, 20).join(', ')}${chain.altered.length > 20 ? '…' : ''}`);
      if (chain.broken.length) findings.push(`chain breaks at audit entries: ${chain.broken.slice(0, 20).join(', ')}${chain.broken.length > 20 ? '…' : ''}`);
    }
    const orphanLinks = countSafe("SELECT COUNT(*) AS c FROM record_links WHERE source_record_id IS NULL OR target_record_id IS NULL");
    if (orphanLinks > 0) { findings.push(`orphaned record_links rows: ${orphanLinks}`); issues += orphanLinks; }
    recordsChecked += countSafe('SELECT COUNT(*) AS c FROM record_links');
    const notifMissingTitle = countSafe("SELECT COUNT(*) AS c FROM notifications WHERE title IS NULL OR title = ''");
    if (notifMissingTitle > 0) { findings.push(`notifications without title: ${notifMissingTitle}`); issues += notifMissingTitle; }
    recordsChecked += countSafe('SELECT COUNT(*) AS c FROM notifications');
    const overdueTasks = countSafe("SELECT COUNT(*) AS c FROM user_task_queue WHERE status IN ('open','in_progress') AND due_date IS NOT NULL AND due_date < date('now')");
    if (overdueTasks > 0) { findings.push(`open tasks past due_date: ${overdueTasks}`); issues += overdueTasks; }
    recordsChecked += countSafe('SELECT COUNT(*) AS c FROM user_task_queue');
    if (tableHas('documents', 'is_controlled') && tableHas('documents', 'next_review_date')) {
      const docsMissing = countSafe("SELECT COUNT(*) AS c FROM documents WHERE is_controlled = 1 AND (next_review_date IS NULL OR next_review_date = '') AND status != 'obsolete'");
      if (docsMissing > 0) { findings.push(`controlled documents without next_review_date: ${docsMissing}`); issues += docsMissing; }
      recordsChecked += countSafe('SELECT COUNT(*) AS c FROM documents');
    }
    const backupMissingStatus = countSafe("SELECT COUNT(*) AS c FROM backup_restore_checks WHERE backup_status IS NULL OR backup_status = ''");
    if (backupMissingStatus > 0) { findings.push(`backup checks missing backup_status: ${backupMissingStatus}`); issues += backupMissingStatus; }
    recordsChecked += countSafe('SELECT COUNT(*) AS c FROM backup_restore_checks');

    // Module-specific deeper checks
    if (tableHas('blood_units', 'screening_status')) {
      const ncScreening = countSafe("SELECT COUNT(*) AS c FROM blood_units WHERE current_status = 'available' AND (screening_status IS NULL OR screening_status = '' OR screening_status = 'incomplete')");
      if (ncScreening > 0) { findings.push(`available blood units with incomplete screening: ${ncScreening}`); issues += ncScreening; }
      recordsChecked += countSafe('SELECT COUNT(*) AS c FROM blood_units');
    }
    if (tableHas('monitoring_readings', 'reviewed_at')) {
      const unreviewedExcursions = countSafe("SELECT COUNT(*) AS c FROM monitoring_readings WHERE status IN ('critical','out_of_range') AND reviewed_at IS NULL");
      if (unreviewedExcursions > 0) { findings.push(`monitoring excursions without reviewed_at: ${unreviewedExcursions}`); issues += unreviewedExcursions; }
      recordsChecked += countSafe('SELECT COUNT(*) AS c FROM monitoring_readings');
    }
    if (tableHas('iqc_results', 'reviewed_at')) {
      const iqcPending = countSafe("SELECT COUNT(*) AS c FROM iqc_results WHERE reviewed_at IS NULL AND status != 'accepted' AND run_date < date('now','-14 day')");
      if (iqcPending > 0) { findings.push(`IQC non-accepted results unreviewed >14 days: ${iqcPending}`); issues += iqcPending; }
      recordsChecked += countSafe('SELECT COUNT(*) AS c FROM iqc_results');
    }
    if (tableHas('equipment_items', 'next_calibration_due')) {
      const overdueCal = countSafe("SELECT COUNT(*) AS c FROM equipment_items WHERE next_calibration_due IS NOT NULL AND next_calibration_due < date('now') AND status = 'active'");
      if (overdueCal > 0) { findings.push(`active equipment with overdue calibration: ${overdueCal}`); issues += overdueCal; }
      recordsChecked += countSafe('SELECT COUNT(*) AS c FROM equipment_items');
    }
    if (tableHas('nonconforming_events', 'closure_notes')) {
      const closedNoNotes = countSafe("SELECT COUNT(*) AS c FROM nonconforming_events WHERE status = 'closed' AND (closure_notes IS NULL OR closure_notes = '')");
      if (closedNoNotes > 0) { findings.push(`closed NC records without closure_notes: ${closedNoNotes}`); issues += closedNoNotes; }
      recordsChecked += countSafe('SELECT COUNT(*) AS c FROM nonconforming_events');
    }
    if (tableHas('capa_records', 'effectiveness_required') && tableHas('capa_records', 'effectiveness_status')) {
      const capaEffMissing = countSafe("SELECT COUNT(*) AS c FROM capa_records WHERE status = 'closed' AND effectiveness_required = 1 AND (effectiveness_status IS NULL OR effectiveness_status = 'pending')");
      if (capaEffMissing > 0) { findings.push(`closed CAPAs requiring effectiveness review but pending: ${capaEffMissing}`); issues += capaEffMissing; }
      recordsChecked += countSafe('SELECT COUNT(*) AS c FROM capa_records');
    }
    if (tableHas('poct_operator_authorizations', 'expiry_date')) {
      const poctStale = countSafe("SELECT COUNT(*) AS c FROM poct_operator_authorizations WHERE status = 'active' AND expiry_date IS NOT NULL AND expiry_date < date('now')");
      if (poctStale > 0) { findings.push(`POCT authorizations still 'active' past expiry: ${poctStale}`); issues += poctStale; }
      recordsChecked += countSafe('SELECT COUNT(*) AS c FROM poct_operator_authorizations');
    }
    if (tableHas('staff_documents', 'expiry_date')) {
      const expiredStaffDocs = countSafe("SELECT COUNT(*) AS c FROM staff_documents WHERE expiry_date IS NOT NULL AND expiry_date < date('now') AND verification_status != 'expired'");
      if (expiredStaffDocs > 0) { findings.push(`staff documents past expiry not marked expired: ${expiredStaffDocs}`); issues += expiredStaffDocs; }
      recordsChecked += countSafe('SELECT COUNT(*) AS c FROM staff_documents');
    }

    const createdAt = new Date().toISOString();
    const checkNumber = generateRecordNumber(db, 'data_integrity_checks', 'DIC', createdAt);
    const checkedBy = getStaffIdOrCurrent(req, req.body.checkedByStaffId);
    const status = issues === 0 ? 'passed' : 'issues_found';
    const summary = findings.length ? findings.join('\n') : 'No issues detected by basic scan.';
    const result = db.prepare(`INSERT INTO data_integrity_checks (check_number, check_date, check_type, module_key, records_checked, issues_found, findings_summary, action_required, status, checked_by_staff_id, created_by, created_at) VALUES (?, ?, 'basic_scan', NULL, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(checkNumber, createdAt.slice(0, 10), recordsChecked, issues, summary, issues > 0 ? 1 : 0, status, checkedBy, req.user!.id, createdAt);
    const id = Number(result.lastInsertRowid);
    audit(req, { action: 'run_basic_scan', entity: 'data_integrity_checks', entityId: id, newValue: { recordsChecked, issues, status, findings } });
    res.json({ ok: true, id, checkNumber, recordsChecked, issuesFound: issues, status, findings: summary });
  });

  return router;
}

export { REPORT_STATUSES, EVIDENCE_PACK_STATUSES, RETENTION_REVIEW_STATUSES, AUDIT_REVIEW_STATUSES, BACKUP_CHECK_STATUSES, INTEGRITY_CHECK_STATUSES, OUTPUT_FORMATS, SUPPORTED_REPORT_MODULES, ARCHIVE_ACTIONS };
