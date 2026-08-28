import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as XLSX from 'xlsx';
import { getDb, uploadRoot } from '../db/database.js';
import { requirePermission } from '../middleware/permissions.js';
import { audit } from '../services/auditService.js';
import { generateRecordNumber } from '../utils/recordNumber.js';
import { recordCentralArchive } from './archives.js';
import { safeStoredFilename } from '../utils/safeFilename.js';
import { parseIntNullable, getStaffIdOrCurrent } from './routeHelpers.js';

const IMPORT_TYPES = ['opd_worksheet', 'ipd_worksheet', 'tat_file', 'other'];
const IMPORT_STATUSES = ['pending', 'processing', 'processed', 'failed'];
const REPORT_TYPES = ['combined_lab_monthly', 'haematology', 'biochemistry', 'microbiology', 'malaria', 'tat_summary', 'blood_bank_summary'];
const REPORT_STATUSES = ['draft', 'in_review', 'reviewed', 'approved', 'exported', 'archived'];
const MAPPING_SOURCE_FIELDS = ['test_name', 'parameter_name', 'department_name', 'section_name', 'organism', 'sample_type'];
const COUNTING_RULES = ['count_rows', 'count_unique_patient', 'count_positive', 'count_negative', 'count_organism', 'sum_value'];
const EXCEPTION_STATUSES = ['open', 'resolved', 'dismissed', 'action_created'];

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadRoot),
  filename: (_req, file, cb) => cb(null, safeStoredFilename(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

function parseCsv(text: string): { headers: string[]; rows: Record<string, string>[] } {
  // Minimal RFC-4180-ish CSV: handles quoted values, escaped quotes, commas in quotes, CR/LF.
  const out: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else { inQuotes = false; }
      } else { cell += ch; }
    } else {
      if (ch === '"') { inQuotes = true; }
      else if (ch === ',') { row.push(cell); cell = ''; }
      else if (ch === '\r') { /* skip */ }
      else if (ch === '\n') { row.push(cell); cell = ''; out.push(row); row = []; }
      else { cell += ch; }
    }
  }
  if (cell.length > 0 || row.length > 0) { row.push(cell); out.push(row); }
  const nonEmpty = out.filter(r => r.some(c => c.trim() !== ''));
  if (nonEmpty.length === 0) return { headers: [], rows: [] };
  const headers = nonEmpty[0].map(h => h.trim());
  const rows = nonEmpty.slice(1).map(r => {
    const obj: Record<string, string> = {};
    headers.forEach((h, idx) => { obj[h] = (r[idx] ?? '').trim(); });
    return obj;
  });
  return { headers, rows };
}

function normalizeKey(s: string) { return s.toLowerCase().replace(/[^a-z0-9]+/g, ''); }

const FIELD_ALIASES: Record<string, string[]> = {
  patient_type: ['patienttype', 'pttype', 'ipdopd', 'patientcategory'],
  request_date: ['requestdate', 'reqdate', 'requesttime', 'requesteddate'],
  sample_date: ['sampledate', 'collectiondate', 'samplereceivedtime', 'samplereceived', 'samplereceiveddate'],
  result_date: ['resultdate', 'verificationtime', 'verificationdate', 'reporteddate', 'dispatchtime', 'dispatchdate'],
  patient_id: ['patientid', 'patientnumber', 'mrn', 'hospitalno'],
  patient_age: ['patientage', 'age'],
  patient_sex: ['patientsex', 'sex', 'gender'],
  department_name: ['departmentname', 'department', 'dept'],
  section_name: ['sectionname', 'section', 'unit'],
  test_name: ['testname', 'test', 'investigation', 'examination'],
  parameter_name: ['parametername', 'parameter', 'analyte'],
  result_value: ['resultvalue', 'result', 'value'],
  unit: ['unit', 'resultunit', 'units'],
  sample_type: ['sampletype', 'specimen', 'specimentype'],
  organism: ['organism', 'isolate'],
  antibiotic: ['antibiotic', 'drug'],
  susceptibility: ['susceptibility', 'sensitivity', 'amrresult'],
  request_time: ['requestdatetime', 'requesttimestamp'],
  sample_received_time: ['sampledatetime', 'samplereceivedtimestamp'],
  verification_time: ['verificationdatetime', 'verifiedat'],
  dispatch_time: ['dispatchdatetime', 'dispatchat', 'reporttime'],
  target_minutes: ['targetminutes', 'targettat', 'tattarget'],
  request_id: ['requestid', 'requestnumber', 'lhimsid']
};

function mapHeaders(headers: string[]) {
  const map: Record<string, string> = {};
  for (const h of headers) {
    const norm = normalizeKey(h);
    for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
      if (norm === field.replace(/_/g, '') || aliases.some(a => a === norm)) {
        if (!map[field]) map[field] = h;
        break;
      }
    }
  }
  return map;
}

function hashFile(filePath: string): string {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function readSourceFile(db: any, fileId: number): { path: string; originalName: string; mimeType: string | null } | null {
  const file = db.prepare('SELECT original_name, stored_name, mime_type, storage_area FROM files WHERE id = ?').get(fileId) as any;
  if (!file) return null;
  const root = file.storage_area === 'evidence' ? path.join(uploadRoot, '..', 'evidence') : uploadRoot;
  return { path: path.join(root, file.stored_name), originalName: file.original_name, mimeType: file.mime_type };
}

function tryParseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const d = new Date(trimmed);
  if (isNaN(d.getTime())) return null;
  return d;
}

function diffMinutes(a: Date | null, b: Date | null): number | null {
  if (!a || !b) return null;
  return Math.round((b.getTime() - a.getTime()) / 60000);
}

function evaluateTatStatus(tat: number | null, target: number | null): string {
  if (tat === null) return 'incomplete';
  if (tat < 0) return 'exception';
  if (target === null) return 'within_target';
  return tat <= target ? 'within_target' : 'delayed';
}

function processImportBatch(db: any, batchId: number) {
  const batch = db.prepare('SELECT * FROM lhims_import_batches WHERE id = ?').get(batchId) as any;
  if (!batch) throw new Error('Import batch not found');
  if (!batch.source_file_id) throw new Error('Import batch has no source file');
  const file = readSourceFile(db, batch.source_file_id);
  if (!file) throw new Error('Source file is missing on disk');
  const ext = path.extname(file.originalName).toLowerCase();
  let parsed: { headers: string[]; rows: Record<string, string>[] };
  if (ext === '.csv') {
    parsed = parseCsv(fs.readFileSync(file.path, 'utf-8'));
  } else if (ext === '.xlsx' || ext === '.xls') {
    try {
      const wb = XLSX.readFile(file.path, { cellDates: false });
      const firstSheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(firstSheet, { defval: '', raw: false });
      const headers = rows.length ? Object.keys(rows[0]).map(h => String(h).trim()) : [];
      const stringRows = rows.map(r => {
        const out: Record<string, string> = {};
        for (const h of headers) out[h] = r[h] === null || r[h] === undefined ? '' : String(r[h]).trim();
        return out;
      });
      parsed = { headers, rows: stringRows };
    } catch (e) {
      db.prepare("UPDATE lhims_import_batches SET status = 'failed', notes = COALESCE(notes, '') || ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(`\nXLSX parse failed: ${(e as Error).message}`, batchId);
      return { rows: 0, processed: 0, exceptions: 0, skipped: true };
    }
  } else {
    db.prepare("UPDATE lhims_import_batches SET status = 'failed', notes = COALESCE(notes, '') || ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(`\nUnsupported file extension "${ext}". Upload .csv, .xlsx, or .xls.`, batchId);
    return { rows: 0, processed: 0, exceptions: 0, skipped: true };
  }
  const map = mapHeaders(parsed.headers);
  db.prepare('DELETE FROM lhims_import_rows WHERE import_batch_id = ?').run(batchId);
  db.prepare('DELETE FROM monthly_report_exceptions WHERE import_batch_id = ?').run(batchId);
  db.prepare('DELETE FROM tat_records WHERE import_batch_id = ?').run(batchId);

  const rules = db.prepare('SELECT * FROM report_mapping_rules WHERE is_active = 1').all() as any[];

  let processedRows = 0;
  let exceptions = 0;
  const tatRowsToInsert: any[] = [];

  const insertRow = db.prepare(`INSERT INTO lhims_import_rows (import_batch_id, row_number, patient_type, request_date, sample_date, result_date, patient_id, patient_age, patient_sex, department_name, section_name, test_name, parameter_name, result_value, unit, sample_type, organism, antibiotic, susceptibility, raw_json, mapping_status, exception_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertException = db.prepare('INSERT INTO monthly_report_exceptions (import_batch_id, import_row_id, exception_type, exception_message, suggested_mapping_rule_id, status) VALUES (?, ?, ?, ?, ?, ?)');

  const txn = db.transaction(() => {
    parsed.rows.forEach((raw, idx) => {
      const get = (field: string) => (map[field] ? raw[map[field]] : '') || null;
      const testName = get('test_name') ?? get('parameter_name');
      const parameterName = get('parameter_name');
      let mappingStatus = 'unprocessed';
      let exceptionReason: string | null = null;
      let matchedRule: any = null;

      if (batch.import_type === 'tat_file') {
        mappingStatus = 'mapped';
      } else if (!testName) {
        mappingStatus = 'exception';
        exceptionReason = 'No test_name or parameter_name column matched in this row.';
      } else {
        for (const rule of rules) {
          const field = rule.source_field as string;
          const candidate = (field === 'test_name' ? testName : field === 'parameter_name' ? parameterName : get(field)) || '';
          if (!candidate) continue;
          const candidateNorm = candidate.toLowerCase();
          const patternNorm = (rule.source_pattern as string).toLowerCase();
          let match = false;
          if (patternNorm.startsWith('regex:')) {
            try { match = new RegExp(patternNorm.slice(6), 'i').test(candidate); }
            catch { match = false; }
          } else if (patternNorm.includes('*')) {
            const escaped = patternNorm.split('*').map(p => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
            match = new RegExp(`^${escaped}$`, 'i').test(candidate);
          } else {
            match = candidateNorm === patternNorm || candidateNorm.includes(patternNorm);
          }
          if (match) { matchedRule = rule; break; }
        }
        if (matchedRule) mappingStatus = 'mapped';
        else { mappingStatus = 'exception'; exceptionReason = `No active mapping rule matched "${testName}".`; }
      }

      const result = insertRow.run(
        batchId,
        idx + 1,
        get('patient_type'),
        get('request_date'),
        get('sample_date'),
        get('result_date'),
        get('patient_id'),
        get('patient_age'),
        get('patient_sex'),
        get('department_name'),
        get('section_name'),
        testName,
        parameterName,
        get('result_value'),
        get('unit'),
        get('sample_type'),
        get('organism'),
        get('antibiotic'),
        get('susceptibility'),
        JSON.stringify(raw),
        mappingStatus,
        exceptionReason
      );
      const rowId = Number(result.lastInsertRowid);
      processedRows++;
      if (mappingStatus === 'exception') {
        exceptions++;
        insertException.run(batchId, rowId, 'unmapped', exceptionReason ?? 'Unmapped row', null, 'open');
      }

      if (batch.import_type === 'tat_file') {
        const requestTime = tryParseDate(raw[map.request_time || ''] || get('request_date') || '');
        const sampleReceivedTime = tryParseDate(raw[map.sample_received_time || ''] || get('sample_date') || '');
        const verificationTime = tryParseDate(raw[map.verification_time || ''] || '');
        const dispatchTime = tryParseDate(raw[map.dispatch_time || ''] || get('result_date') || '');
        const endTime = dispatchTime || verificationTime;
        const startTime = requestTime || sampleReceivedTime;
        const tat = diffMinutes(startTime, endTime);
        const targetRaw = raw[map.target_minutes || ''];
        const target = targetRaw && !isNaN(Number(targetRaw)) ? Math.round(Number(targetRaw)) : null;
        const status = evaluateTatStatus(tat, target);
        let exceptionReason2: string | null = null;
        if (status === 'incomplete') exceptionReason2 = 'Missing request or completion timestamp.';
        else if (status === 'exception') exceptionReason2 = 'Negative TAT — start/end timestamps appear out of order.';
        tatRowsToInsert.push({
          rowId,
          requestId: raw[map.request_id || ''] || null,
          patientType: get('patient_type'),
          testName,
          departmentName: get('department_name'),
          sectionName: get('section_name'),
          requestTime: startTime?.toISOString() ?? null,
          sampleReceivedTime: sampleReceivedTime?.toISOString() ?? null,
          verificationTime: verificationTime?.toISOString() ?? null,
          dispatchTime: endTime?.toISOString() ?? null,
          tat,
          target,
          status,
          exceptionReason: exceptionReason2
        });
        if (status === 'incomplete' || status === 'exception') {
          exceptions++;
          insertException.run(batchId, rowId, 'tat_' + status, exceptionReason2 ?? 'TAT issue', null, 'open');
        }
      }
    });

    if (tatRowsToInsert.length) {
      const insertTat = db.prepare(`INSERT INTO tat_records (import_batch_id, request_id, patient_type, test_name, department_name, section_name, request_time, sample_received_time, verification_time, dispatch_time, tat_minutes, target_minutes, status, exception_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const t of tatRowsToInsert) {
        insertTat.run(batchId, t.requestId, t.patientType, t.testName, t.departmentName, t.sectionName, t.requestTime, t.sampleReceivedTime, t.verificationTime, t.dispatchTime, t.tat, t.target, t.status, t.exceptionReason);
      }
    }

    db.prepare("UPDATE lhims_import_batches SET status = 'processed', total_rows = ?, processed_rows = ?, exception_count = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(parsed.rows.length, processedRows, exceptions, batchId);
  });
  txn();
  return { rows: parsed.rows.length, processed: processedRows, exceptions, skipped: false };
}

function generateReportLines(db: any, reportId: number, reportType: string, importBatchIds: number[]) {
  if (importBatchIds.length === 0) return { lines: 0, exceptionCount: 0 };
  const placeholders = importBatchIds.map(() => '?').join(', ');
  let exceptionCount = 0;
  let linesInserted = 0;

  const insertLine = db.prepare('INSERT INTO monthly_report_lines (monthly_report_batch_id, report_section, report_row, category, value_text, value_number, source_count, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');

  if (reportType === 'tat_summary') {
    const tatRows = db.prepare(`SELECT * FROM tat_records WHERE import_batch_id IN (${placeholders})`).all(...importBatchIds) as any[];
    type TatBucket = { count: number; within: number; delayed: number; incomplete: number; tatSum: number; tatCount: number };
    const newBucket = (): TatBucket => ({ count: 0, within: 0, delayed: 0, incomplete: 0, tatSum: 0, tatCount: 0 });
    const pivot = (key: string, buckets: Map<string, TatBucket>) => {
      let b = buckets.get(key);
      if (!b) { b = newBucket(); buckets.set(key, b); }
      return b;
    };
    const drillDown = new Map<string, Map<string, Map<string, TatBucket>>>(); // section -> patientType -> test -> bucket
    for (const r of tatRows) {
      const section = r.section_name || (r.department_name ? `${r.department_name} (no section)` : 'Unassigned');
      const pt = r.patient_type || 'unknown';
      const test = r.test_name || 'unknown';
      let bySection = drillDown.get(section);
      if (!bySection) { bySection = new Map(); drillDown.set(section, bySection); }
      let byPatient = bySection.get(pt);
      if (!byPatient) { byPatient = new Map(); bySection.set(pt, byPatient); }
      const bucket = pivot(test, byPatient);
      bucket.count++;
      if (r.status === 'within_target') bucket.within++;
      else if (r.status === 'delayed') bucket.delayed++;
      else { bucket.incomplete++; exceptionCount++; }
      if (r.tat_minutes !== null && r.tat_minutes !== undefined) { bucket.tatSum += r.tat_minutes; bucket.tatCount++; }
    }
    for (const [section, byPatient] of drillDown) {
      const sectionTotals = newBucket();
      for (const [pt, byTest] of byPatient) {
        const patientTotals = newBucket();
        for (const [test, b] of byTest) {
          const avg = b.tatCount > 0 ? Math.round(b.tatSum / b.tatCount) : null;
          insertLine.run(reportId, section, `${pt} • ${test}`, 'count', `${b.within}/${b.count} within target`, b.within, b.count, `delayed=${b.delayed}; incomplete/exception=${b.incomplete}; avg_minutes=${avg ?? '—'}`);
          linesInserted++;
          patientTotals.count += b.count; patientTotals.within += b.within; patientTotals.delayed += b.delayed; patientTotals.incomplete += b.incomplete;
          patientTotals.tatSum += b.tatSum; patientTotals.tatCount += b.tatCount;
        }
        const avgP = patientTotals.tatCount > 0 ? Math.round(patientTotals.tatSum / patientTotals.tatCount) : null;
        insertLine.run(reportId, section, `${pt} • subtotal`, 'subtotal', `${patientTotals.within}/${patientTotals.count} within target`, patientTotals.within, patientTotals.count, `delayed=${patientTotals.delayed}; incomplete/exception=${patientTotals.incomplete}; avg_minutes=${avgP ?? '—'}`);
        linesInserted++;
        sectionTotals.count += patientTotals.count; sectionTotals.within += patientTotals.within; sectionTotals.delayed += patientTotals.delayed; sectionTotals.incomplete += patientTotals.incomplete;
        sectionTotals.tatSum += patientTotals.tatSum; sectionTotals.tatCount += patientTotals.tatCount;
      }
      const avgS = sectionTotals.tatCount > 0 ? Math.round(sectionTotals.tatSum / sectionTotals.tatCount) : null;
      insertLine.run(reportId, section, 'Section total', 'total', `${sectionTotals.within}/${sectionTotals.count} within target`, sectionTotals.within, sectionTotals.count, `delayed=${sectionTotals.delayed}; incomplete/exception=${sectionTotals.incomplete}; avg_minutes=${avgS ?? '—'}`);
      linesInserted++;
    }
    return { lines: linesInserted, exceptionCount };
  }

  // Default: aggregate mapped rows per mapping rule
  const importTypeFilter = reportType === 'blood_bank_summary' ? '' : '';
  const mappedRows = db.prepare(`SELECT r.*, b.import_type FROM lhims_import_rows r JOIN lhims_import_batches b ON b.id = r.import_batch_id WHERE r.import_batch_id IN (${placeholders}) AND r.mapping_status = 'mapped'${importTypeFilter}`).all(...importBatchIds) as any[];
  exceptionCount = (db.prepare(`SELECT COUNT(*) AS count FROM lhims_import_rows WHERE import_batch_id IN (${placeholders}) AND mapping_status = 'exception'`).get(...importBatchIds) as { count: number }).count;
  const rules = db.prepare('SELECT * FROM report_mapping_rules WHERE is_active = 1 AND (report_type = ? OR report_type = ?)').all(reportType, 'combined_lab_monthly') as any[];

  type BucketKey = string;
  const buckets = new Map<BucketKey, { rule: any; rows: any[] }>();

  function ruleMatches(rule: any, row: any) {
    const field = rule.source_field as string;
    const candidate = (field === 'test_name' ? row.test_name : field === 'parameter_name' ? row.parameter_name : row[field]) || '';
    if (!candidate) return false;
    const pattern = String(rule.source_pattern).toLowerCase();
    const c = candidate.toLowerCase();
    if (pattern.startsWith('regex:')) {
      try { return new RegExp(pattern.slice(6), 'i').test(candidate); } catch { return false; }
    }
    if (pattern.includes('*')) {
      const escaped = pattern.split('*').map(p => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
      return new RegExp(`^${escaped}$`, 'i').test(candidate);
    }
    return c === pattern || c.includes(pattern);
  }

  // Multi-match: a row may contribute to every active rule it matches, so a
  // single LHIMS row that is both an FBC request and an HIV-positive result
  // can be counted under both lines in the same report.
  for (const row of mappedRows) {
    for (const rule of rules) {
      if (reportType !== 'combined_lab_monthly' && rule.report_type !== reportType) continue;
      if (!ruleMatches(rule, row)) continue;
      const key = `${rule.report_section}|${rule.report_row}|${rule.counting_rule}|${rule.id}`;
      let b = buckets.get(key);
      if (!b) { b = { rule, rows: [] }; buckets.set(key, b); }
      b.rows.push(row);
    }
  }

  for (const { rule, rows } of buckets.values()) {
    let value = 0;
    let notes = '';
    switch (rule.counting_rule) {
      case 'count_rows': value = rows.length; break;
      case 'count_unique_patient': value = new Set(rows.map(r => r.patient_id).filter(Boolean)).size; break;
      case 'count_positive': value = rows.filter(r => /pos|reactive|detected/i.test(r.result_value ?? '')).length; break;
      case 'count_negative': value = rows.filter(r => /neg|not detected/i.test(r.result_value ?? '')).length; break;
      case 'count_organism': value = rows.filter(r => r.organism && r.organism.toLowerCase() !== 'no growth').length; notes = `organisms: ${Array.from(new Set(rows.map(r => r.organism).filter(Boolean))).slice(0, 5).join(', ')}`; break;
      case 'sum_value': value = rows.reduce((acc, r) => { const n = Number(r.result_value); return acc + (isFinite(n) ? n : 0); }, 0); break;
      default: value = rows.length;
    }
    insertLine.run(reportId, rule.report_section, rule.report_row, rule.counting_rule, String(value), value, rows.length, notes || null);
    linesInserted++;
  }
  return { lines: linesInserted, exceptionCount };
}

export function monthlyReportsRoutes() {
  const router = Router();

  // ============= Imports =============
  router.get('/imports', requirePermission('monthly_reports', 'view'), (req, res) => {
    const db = getDb();
    const filters: string[] = [];
    const params: unknown[] = [];
    if (req.query.month) { filters.push('report_month = ?'); params.push(Number(req.query.month)); }
    if (req.query.year) { filters.push('report_year = ?'); params.push(Number(req.query.year)); }
    if (req.query.importType) { filters.push('import_type = ?'); params.push(String(req.query.importType)); }
    let query = 'SELECT * FROM lhims_import_batches';
    if (filters.length) query += ` WHERE ${filters.join(' AND ')}`;
    query += ' ORDER BY created_at DESC';
    res.json(db.prepare(query).all(...params));
  });

  router.post('/imports', requirePermission('monthly_reports', 'import'), upload.single('file'), (req, res) => {
    const reportMonth = parseIntNullable(req.body.reportMonth);
    const reportYear = parseIntNullable(req.body.reportYear);
    if (reportMonth === null || reportMonth < 1 || reportMonth > 12) return res.status(400).json({ error: 'reportMonth is required (1-12)' });
    if (reportYear === null || reportYear < 2000) return res.status(400).json({ error: 'reportYear is required (>=2000)' });
    if (!req.body.importType) return res.status(400).json({ error: 'importType is required' });
    if (!IMPORT_TYPES.includes(req.body.importType)) return res.status(400).json({ error: `importType must be one of: ${IMPORT_TYPES.join(', ')}` });
    const db = getDb();

    let sourceFileId = parseIntNullable(req.body.sourceFileId);
    let originalFilename: string | null = null;
    let fileHash: string | null = null;

    if (req.file) {
      const stored = db.prepare('INSERT INTO files (original_name, stored_name, mime_type, size_bytes, storage_area, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)')
        .run(req.file.originalname, req.file.filename, req.file.mimetype, req.file.size, 'uploads', req.user!.id);
      sourceFileId = Number(stored.lastInsertRowid);
      originalFilename = req.file.originalname;
      try { fileHash = hashFile(path.join(uploadRoot, req.file.filename)); } catch { fileHash = null; }
    } else if (sourceFileId) {
      const file = readSourceFile(db, sourceFileId);
      if (!file) return res.status(404).json({ error: 'Source file not found' });
      originalFilename = file.originalName;
      try { fileHash = hashFile(file.path); } catch { fileHash = null; }
    } else {
      return res.status(400).json({ error: 'A file upload or sourceFileId is required' });
    }

    const createdAt = new Date().toISOString();
    const batchNumber = generateRecordNumber(db, 'lhims_import_batches', 'LHIMS', createdAt);
    const importedByStaffId = getStaffIdOrCurrent(req, req.body.importedByStaffId);
    const result = db.prepare(`INSERT INTO lhims_import_batches (batch_number, report_month, report_year, import_type, source_file_id, original_filename, file_hash, imported_by_staff_id, imported_at, status, notes, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(batchNumber, reportMonth, reportYear, req.body.importType, sourceFileId, originalFilename, fileHash, importedByStaffId, createdAt, 'pending', req.body.notes ?? null, req.user!.id, createdAt);
    const batchId = Number(result.lastInsertRowid);

    if (sourceFileId) {
      db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run('monthly_reports', 'lhims_import_batches', String(batchId), 'documents', 'files', String(sourceFileId), 'LHIMS raw archive source file');
      db.prepare('INSERT INTO evidence_files (file_id, module_key, record_type, record_id, notes, linked_by) VALUES (?, ?, ?, ?, ?, ?)')
        .run(sourceFileId, 'monthly_reports', 'lhims_import_batches', String(batchId), 'Raw LHIMS export archive', req.user!.id);
    }

    audit(req, { action: 'create', entity: 'lhims_import_batches', entityId: batchId, newValue: { batchNumber, ...req.body, sourceFileId } });
    res.status(201).json({ id: batchId, batchNumber });
  });

  router.get('/imports/:id/rows', requirePermission('monthly_reports', 'view'), (req, res) => {
    const db = getDb();
    const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000);
    res.json(db.prepare('SELECT * FROM lhims_import_rows WHERE import_batch_id = ? ORDER BY row_number LIMIT ?').all(req.params.id, limit));
  });

  router.get('/imports/:id/exceptions', requirePermission('monthly_reports', 'view'), (req, res) => {
    const db = getDb();
    res.json(db.prepare(`SELECT e.*, r.test_name, r.parameter_name, r.row_number FROM monthly_report_exceptions e LEFT JOIN lhims_import_rows r ON r.id = e.import_row_id WHERE e.import_batch_id = ? ORDER BY e.id DESC`).all(req.params.id));
  });

  router.post('/imports/:id/process', requirePermission('monthly_reports', 'create'), (req, res) => {
    const db = getDb();
    try {
      const result = processImportBatch(db, Number(req.params.id));
      audit(req, { action: 'process', entity: 'lhims_import_batches', entityId: req.params.id, newValue: result });
      res.json({ ok: true, ...result });
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });

  router.post('/imports/:id/reprocess', requirePermission('monthly_reports', 'edit'), (req, res) => {
    const db = getDb();
    try {
      const result = processImportBatch(db, Number(req.params.id));
      audit(req, { action: 'reprocess', entity: 'lhims_import_batches', entityId: req.params.id, newValue: result });
      res.json({ ok: true, ...result });
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });

  router.get('/imports/:id', requirePermission('monthly_reports', 'view'), (req, res) => {
    const db = getDb();
    const batch = db.prepare('SELECT * FROM lhims_import_batches WHERE id = ?').get(req.params.id) as any;
    if (!batch) return res.status(404).json({ error: 'Import batch not found' });
    const file = batch.source_file_id ? db.prepare('SELECT id, original_name, stored_name, size_bytes, mime_type FROM files WHERE id = ?').get(batch.source_file_id) : null;
    const links = db.prepare('SELECT * FROM record_links WHERE source_module_key = ? AND source_record_type = ? AND source_record_id = ?')
      .all('monthly_reports', 'lhims_import_batches', String(req.params.id));
    res.json({ ...batch, sourceFile: file, links });
  });

  // ============= Mapping Rules =============
  router.get('/mapping-rules', requirePermission('monthly_reports', 'view'), (_req, res) => {
    const db = getDb();
    res.json(db.prepare('SELECT * FROM report_mapping_rules ORDER BY report_type, report_section, report_row, mapping_name').all());
  });

  router.post('/mapping-rules', requirePermission('monthly_reports', 'create'), (req, res) => {
    if (!req.body.mappingName) return res.status(400).json({ error: 'mappingName is required' });
    if (!req.body.sourcePattern) return res.status(400).json({ error: 'sourcePattern is required' });
    if (!req.body.reportType) return res.status(400).json({ error: 'reportType is required' });
    if (!REPORT_TYPES.includes(req.body.reportType)) return res.status(400).json({ error: `reportType must be one of: ${REPORT_TYPES.join(', ')}` });
    if (!req.body.reportSection) return res.status(400).json({ error: 'reportSection is required' });
    if (!req.body.reportRow) return res.status(400).json({ error: 'reportRow is required' });
    const sourceField = req.body.sourceField ?? 'test_name';
    if (!MAPPING_SOURCE_FIELDS.includes(sourceField)) return res.status(400).json({ error: `sourceField must be one of: ${MAPPING_SOURCE_FIELDS.join(', ')}` });
    const countingRule = req.body.countingRule ?? 'count_rows';
    if (!COUNTING_RULES.includes(countingRule)) return res.status(400).json({ error: `countingRule must be one of: ${COUNTING_RULES.join(', ')}` });
    const db = getDb();
    const result = db.prepare(`INSERT INTO report_mapping_rules (mapping_name, source_pattern, source_field, report_type, report_section, report_row, counting_rule, department_id, section_id, is_active, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(req.body.mappingName, req.body.sourcePattern, sourceField, req.body.reportType, req.body.reportSection, req.body.reportRow, countingRule, parseIntNullable(req.body.departmentId), parseIntNullable(req.body.sectionId), req.body.isActive === false ? 0 : 1, req.user!.id);
    const id = Number(result.lastInsertRowid);
    audit(req, { action: 'create', entity: 'report_mapping_rules', entityId: id, newValue: req.body });
    res.status(201).json({ id });
  });

  router.put('/mapping-rules/:id', requirePermission('monthly_reports', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM report_mapping_rules WHERE id = ?').get(req.params.id) as any;
    if (!oldValue) return res.status(404).json({ error: 'Mapping rule not found' });
    db.prepare(`UPDATE report_mapping_rules SET mapping_name = ?, source_pattern = ?, source_field = ?, report_type = ?, report_section = ?, report_row = ?, counting_rule = ?, department_id = ?, section_id = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(
        req.body.mappingName ?? oldValue.mapping_name,
        req.body.sourcePattern ?? oldValue.source_pattern,
        req.body.sourceField ?? oldValue.source_field,
        req.body.reportType ?? oldValue.report_type,
        req.body.reportSection ?? oldValue.report_section,
        req.body.reportRow ?? oldValue.report_row,
        req.body.countingRule ?? oldValue.counting_rule,
        parseIntNullable(req.body.departmentId) ?? oldValue.department_id,
        parseIntNullable(req.body.sectionId) ?? oldValue.section_id,
        req.body.isActive !== undefined ? (req.body.isActive ? 1 : 0) : oldValue.is_active,
        req.params.id
      );
    audit(req, { action: 'edit', entity: 'report_mapping_rules', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  router.post('/mapping-rules/:id/toggle', requirePermission('monthly_reports', 'edit'), (req, res) => {
    const db = getDb();
    const rule = db.prepare('SELECT is_active FROM report_mapping_rules WHERE id = ?').get(req.params.id) as any;
    if (!rule) return res.status(404).json({ error: 'Mapping rule not found' });
    const newActive = rule.is_active ? 0 : 1;
    db.prepare('UPDATE report_mapping_rules SET is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(newActive, req.params.id);
    audit(req, { action: 'toggle', entity: 'report_mapping_rules', entityId: req.params.id, oldValue: { isActive: rule.is_active }, newValue: { isActive: newActive } });
    res.json({ ok: true, isActive: newActive === 1 });
  });

  // ============= Reports =============
  router.get('/reports', requirePermission('monthly_reports', 'view'), (req, res) => {
    const db = getDb();
    const filters: string[] = [];
    const params: unknown[] = [];
    if (req.query.month) { filters.push('report_month = ?'); params.push(Number(req.query.month)); }
    if (req.query.year) { filters.push('report_year = ?'); params.push(Number(req.query.year)); }
    if (req.query.status) { filters.push('status = ?'); params.push(String(req.query.status)); }
    let query = 'SELECT * FROM monthly_report_batches';
    if (filters.length) query += ` WHERE ${filters.join(' AND ')}`;
    query += ' ORDER BY report_year DESC, report_month DESC, created_at DESC';
    res.json(db.prepare(query).all(...params));
  });

  router.post('/reports/generate', requirePermission('monthly_reports', 'create'), (req, res) => {
    const reportMonth = parseIntNullable(req.body.reportMonth);
    const reportYear = parseIntNullable(req.body.reportYear);
    if (reportMonth === null || reportMonth < 1 || reportMonth > 12) return res.status(400).json({ error: 'reportMonth is required (1-12)' });
    if (reportYear === null || reportYear < 2000) return res.status(400).json({ error: 'reportYear is required (>=2000)' });
    if (!req.body.reportType) return res.status(400).json({ error: 'reportType is required' });
    if (!REPORT_TYPES.includes(req.body.reportType)) return res.status(400).json({ error: `reportType must be one of: ${REPORT_TYPES.join(', ')}` });
    const importBatchIds: number[] = Array.isArray(req.body.importBatchIds) ? req.body.importBatchIds.map((n: unknown) => Number(n)).filter((n: number) => isFinite(n)) : [];
    if (importBatchIds.length === 0) return res.status(400).json({ error: 'importBatchIds (array) is required and must contain at least one processed import batch id' });
    const db = getDb();
    const batches = db.prepare(`SELECT id, status FROM lhims_import_batches WHERE id IN (${importBatchIds.map(() => '?').join(',')})`).all(...importBatchIds) as any[];
    if (batches.length !== importBatchIds.length) return res.status(404).json({ error: 'One or more import batches not found' });
    const unprocessed = batches.filter(b => b.status !== 'processed');
    if (unprocessed.length) return res.status(400).json({ error: `Import batch(es) ${unprocessed.map(b => b.id).join(', ')} are not processed` });

    const createdAt = new Date().toISOString();
    const reportNumber = generateRecordNumber(db, 'monthly_report_batches', 'MREP', createdAt);
    const generatedByStaffId = getStaffIdOrCurrent(req, req.body.generatedByStaffId);
    const result = db.prepare(`INSERT INTO monthly_report_batches (report_number, report_month, report_year, report_type, status, generated_from_import_batch_ids, generated_by_staff_id, generated_at, exception_count, notes, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(reportNumber, reportMonth, reportYear, req.body.reportType, 'draft', JSON.stringify(importBatchIds), generatedByStaffId, createdAt, 0, req.body.notes ?? null, req.user!.id, createdAt);
    const reportId = Number(result.lastInsertRowid);
    const { lines, exceptionCount } = generateReportLines(db, reportId, req.body.reportType, importBatchIds);
    db.prepare('UPDATE monthly_report_batches SET exception_count = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(exceptionCount, reportId);
    for (const ibId of importBatchIds) {
      db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run('monthly_reports', 'monthly_report_batches', String(reportId), 'monthly_reports', 'lhims_import_batches', String(ibId), 'Source import for report');
    }
    audit(req, { action: 'generate', entity: 'monthly_report_batches', entityId: reportId, newValue: { reportNumber, reportType: req.body.reportType, importBatchIds, lines, exceptionCount } });
    res.status(201).json({ id: reportId, reportNumber, lines, exceptionCount });
  });

  router.get('/reports/:id', requirePermission('monthly_reports', 'view'), (req, res) => {
    const db = getDb();
    const report = db.prepare('SELECT * FROM monthly_report_batches WHERE id = ?').get(req.params.id) as any;
    if (!report) return res.status(404).json({ error: 'Monthly report not found' });
    const lines = db.prepare('SELECT * FROM monthly_report_lines WHERE monthly_report_batch_id = ? ORDER BY report_section, report_row, id').all(req.params.id);
    const links = db.prepare('SELECT * FROM record_links WHERE (source_module_key = ? AND source_record_type = ? AND source_record_id = ?) OR (target_module_key = ? AND target_record_type = ? AND target_record_id = ?)')
      .all('monthly_reports', 'monthly_report_batches', String(req.params.id), 'monthly_reports', 'monthly_report_batches', String(req.params.id));
    res.json({ ...report, lines, links });
  });

  router.put('/reports/:id', requirePermission('monthly_reports', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM monthly_report_batches WHERE id = ?').get(req.params.id) as any;
    if (!oldValue) return res.status(404).json({ error: 'Monthly report not found' });
    if (req.body.status && !REPORT_STATUSES.includes(req.body.status)) return res.status(400).json({ error: `status must be one of: ${REPORT_STATUSES.join(', ')}` });
    db.prepare('UPDATE monthly_report_batches SET notes = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(req.body.notes ?? oldValue.notes, req.body.status ?? oldValue.status, req.params.id);
    audit(req, { action: 'edit', entity: 'monthly_report_batches', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  router.post('/reports/:id/review', requirePermission('monthly_reports', 'edit'), (req, res) => {
    const db = getDb();
    const report = db.prepare('SELECT * FROM monthly_report_batches WHERE id = ?').get(req.params.id) as any;
    if (!report) return res.status(404).json({ error: 'Monthly report not found' });
    const staffId = getStaffIdOrCurrent(req, req.body.reviewedByStaffId);
    if (staffId === null) return res.status(400).json({ error: 'This action requires the logged-in user to be linked to a staff record.' });
    db.prepare("UPDATE monthly_report_batches SET reviewed_by_staff_id = ?, reviewed_at = CURRENT_TIMESTAMP, status = 'reviewed', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(staffId, req.params.id);
    audit(req, { action: 'review', entity: 'monthly_report_batches', entityId: req.params.id, oldValue: { status: report.status }, newValue: { reviewedByStaffId: staffId, status: 'reviewed' } });
    res.json({ ok: true });
  });

  router.post('/reports/:id/approve', requirePermission('monthly_reports', 'approve'), (req, res) => {
    const db = getDb();
    const report = db.prepare('SELECT * FROM monthly_report_batches WHERE id = ?').get(req.params.id) as any;
    if (!report) return res.status(404).json({ error: 'Monthly report not found' });
    const importBatchIds = JSON.parse(report.generated_from_import_batch_ids || '[]') as number[];
    const placeholders = importBatchIds.length ? importBatchIds.map(() => '?').join(',') : '0';
    const unresolvedRow = importBatchIds.length
      ? db.prepare(`SELECT COUNT(*) AS count FROM monthly_report_exceptions WHERE import_batch_id IN (${placeholders}) AND status = 'open'`).get(...importBatchIds) as { count: number }
      : { count: 0 };
    if (unresolvedRow.count > 0 && !req.body.overrideUnresolvedExceptions) {
      return res.status(400).json({ error: `${unresolvedRow.count} unresolved exception(s) — pass overrideUnresolvedExceptions: true to approve anyway.` });
    }
    const staffId = getStaffIdOrCurrent(req, req.body.approvedByStaffId);
    if (staffId === null) return res.status(400).json({ error: 'This action requires the logged-in user to be linked to a staff record.' });
    db.prepare("UPDATE monthly_report_batches SET approved_by_staff_id = ?, approved_at = CURRENT_TIMESTAMP, status = 'approved', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(staffId, req.params.id);
    audit(req, { action: 'approve', entity: 'monthly_report_batches', entityId: req.params.id, oldValue: { status: report.status }, newValue: { approvedByStaffId: staffId, status: 'approved', overrideUnresolvedExceptions: !!req.body.overrideUnresolvedExceptions } });
    res.json({ ok: true });
  });

  router.post('/reports/:id/export', requirePermission('monthly_reports', 'export'), (req, res) => {
    const db = getDb();
    const report = db.prepare('SELECT * FROM monthly_report_batches WHERE id = ?').get(req.params.id) as any;
    if (!report) return res.status(404).json({ error: 'Monthly report not found' });
    const format = (req.body.format ?? 'csv').toLowerCase();
    if (!['csv', 'html', 'doc'].includes(format)) return res.status(400).json({ error: 'format must be csv, html, or doc' });
    const lines = db.prepare('SELECT * FROM monthly_report_lines WHERE monthly_report_batch_id = ? ORDER BY report_section, report_row, id').all(req.params.id) as any[];
    const period = `${report.report_year}-${String(report.report_month).padStart(2, '0')}`;

    let body: string;
    let mimeType: string;
    let extension: string;
    if (format === 'csv') {
      const csvEscape = (v: unknown) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
      const out: string[] = ['Section,Row,Category,Value,SourceCount,Notes'];
      for (const l of lines) out.push([l.report_section, l.report_row, l.category ?? '', l.value_text ?? l.value_number ?? '', l.source_count, l.notes ?? ''].map(csvEscape).join(','));
      body = out.join('\n');
      mimeType = 'text/csv';
      extension = 'csv';
    } else {
      const esc = (v: unknown) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const sections = new Map<string, any[]>();
      for (const l of lines) {
        if (!sections.has(l.report_section)) sections.set(l.report_section, []);
        sections.get(l.report_section)!.push(l);
      }
      const sectionHtml = Array.from(sections.entries()).map(([section, rows]) => `<h2>${esc(section)}</h2><table><thead><tr><th>Row</th><th>Category</th><th>Value</th><th>Source count</th><th>Notes</th></tr></thead><tbody>${rows.map(r => `<tr><td>${esc(r.report_row)}</td><td>${esc(r.category)}</td><td>${esc(r.value_text ?? r.value_number ?? '')}</td><td>${esc(r.source_count)}</td><td>${esc(r.notes)}</td></tr>`).join('')}</tbody></table>`).join('');
      const docPrelude = format === 'doc' ? '<?xml version="1.0"?><?mso-application progid="Word.Document"?>' : '';
      body = `${docPrelude}<!DOCTYPE html><html><head><meta charset="utf-8"/><title>${esc(report.report_number)}</title><style>body{font-family:'Times New Roman',serif;color:#111;margin:24px}h1{font-size:20px;border-bottom:2px solid #1B3A6B;padding-bottom:6px}h2{font-size:14px;margin-top:18px;color:#1B3A6B}table{border-collapse:collapse;width:100%;margin:6px 0 14px;font-size:11px}th,td{border:1px solid #999;padding:4px 6px;text-align:left;vertical-align:top}thead{background:#eef2f7}@media print{body{margin:12mm}}</style></head><body><h1>${esc(report.report_number)} — ${esc(report.report_type.replace(/_/g, ' '))}</h1><p><strong>Period:</strong> ${esc(period)} &nbsp; <strong>Status:</strong> ${esc(report.status)} &nbsp; <strong>Exceptions:</strong> ${report.exception_count}</p>${sectionHtml}<p style="margin-top:24px;font-size:10px;color:#555">Generated by SECH_LIMS on ${new Date().toISOString()}</p></body></html>`;
      mimeType = format === 'doc' ? 'application/msword' : 'text/html';
      extension = format;
    }

    const fileName = `${report.report_number}.${extension}`;
    const storedName = safeStoredFilename(fileName);
    fs.writeFileSync(path.join(uploadRoot, storedName), body, 'utf-8');
    const fileResult = db.prepare('INSERT INTO files (original_name, stored_name, mime_type, size_bytes, storage_area, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)')
      .run(fileName, storedName, mimeType, Buffer.byteLength(body, 'utf-8'), 'uploads', req.user!.id);
    const fileId = Number(fileResult.lastInsertRowid);
    db.prepare("UPDATE monthly_report_batches SET final_file_id = ?, status = CASE WHEN status = 'approved' THEN 'exported' ELSE status END, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(fileId, req.params.id);
    db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('monthly_reports', 'monthly_report_batches', String(req.params.id), 'documents', 'files', String(fileId), `Exported monthly report (${format})`);
    db.prepare('INSERT INTO evidence_files (file_id, module_key, record_type, record_id, notes, linked_by) VALUES (?, ?, ?, ?, ?, ?)')
      .run(fileId, 'monthly_reports', 'monthly_report_batches', String(req.params.id), `Final exported monthly report (${format})`, req.user!.id);
    // Mirror into the central archive so this exported monthly report shows up
    // in Documents & Records → Archives beside every other archived record.
    recordCentralArchive(db, {
      title: `Monthly Report ${report.report_number}`,
      description: `${report.report_type} for ${String(report.report_month).padStart(2, '0')}/${report.report_year} exported as ${format.toUpperCase()}`,
      archiveType: 'report',
      sourceModule: 'monthly_reports', sourceRecordType: 'monthly_report_batches', sourceRecordId: req.params.id,
      fileId, format, sizeBytes: Buffer.byteLength(body, 'utf-8'),
      periodStart: `${report.report_year}-${String(report.report_month).padStart(2, '0')}-01`,
      periodEnd: `${report.report_year}-${String(report.report_month).padStart(2, '0')}-28`,
      isAutomatic: true, createdBy: req.user!.id,
    });
    audit(req, { action: 'export', entity: 'monthly_report_batches', entityId: req.params.id, newValue: { fileId, fileName, format } });
    res.json({ ok: true, fileId, fileName, format });
  });

  router.get('/reports/:id/download', requirePermission('monthly_reports', 'export'), (req, res) => {
    const db = getDb();
    const report = db.prepare('SELECT * FROM monthly_report_batches WHERE id = ?').get(req.params.id) as any;
    if (!report) return res.status(404).json({ error: 'Monthly report not found' });
    const fileId = parseIntNullable(req.query.fileId) ?? report.final_file_id;
    if (!fileId) return res.status(404).json({ error: 'No exported file for this report yet' });
    const file = db.prepare('SELECT * FROM files WHERE id = ?').get(fileId) as any;
    if (!file) return res.status(404).json({ error: 'File not found' });
    const fp = path.join(file.storage_area === 'evidence' ? path.join(uploadRoot, '..', 'evidence') : uploadRoot, file.stored_name);
    if (!fs.existsSync(fp)) return res.status(404).json({ error: 'File missing on disk' });
    res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${file.original_name}"`);
    fs.createReadStream(fp).pipe(res);
  });

  router.get('/archive', requirePermission('monthly_reports', 'view'), (_req, res) => {
    const db = getDb();
    const rows = db.prepare(`
      SELECT rl.id AS link_id, rl.notes AS link_notes,
             mrb.id AS report_id, mrb.report_number, mrb.report_type, mrb.report_month, mrb.report_year, mrb.status AS report_status,
             f.id AS file_id, f.original_name, f.stored_name, f.mime_type, f.size_bytes, f.storage_area, f.created_at AS file_created_at
        FROM record_links rl
        JOIN files f ON f.id = CAST(rl.target_record_id AS INTEGER)
        JOIN monthly_report_batches mrb ON mrb.id = CAST(rl.source_record_id AS INTEGER)
       WHERE rl.source_module_key = 'monthly_reports'
         AND rl.source_record_type = 'monthly_report_batches'
         AND rl.target_module_key = 'documents'
         AND rl.target_record_type = 'files'
       ORDER BY mrb.report_year DESC, mrb.report_month DESC, mrb.id DESC, f.id DESC
    `).all();
    res.json(rows);
  });

  // ============= Exceptions =============
  router.get('/exceptions', requirePermission('monthly_reports', 'view'), (req, res) => {
    const db = getDb();
    const filters: string[] = [];
    const params: unknown[] = [];
    if (req.query.status) { filters.push('e.status = ?'); params.push(String(req.query.status)); }
    if (req.query.importBatchId) { filters.push('e.import_batch_id = ?'); params.push(Number(req.query.importBatchId)); }
    let query = `SELECT e.*, r.test_name, r.parameter_name, r.row_number, b.batch_number, b.import_type FROM monthly_report_exceptions e LEFT JOIN lhims_import_rows r ON r.id = e.import_row_id LEFT JOIN lhims_import_batches b ON b.id = e.import_batch_id`;
    if (filters.length) query += ` WHERE ${filters.join(' AND ')}`;
    query += ' ORDER BY e.created_at DESC LIMIT 500';
    res.json(db.prepare(query).all(...params));
  });

  router.post('/exceptions/:id/resolve', requirePermission('monthly_reports', 'edit'), (req, res) => {
    if (!req.body.resolutionNotes) return res.status(400).json({ error: 'resolutionNotes is required' });
    const db = getDb();
    const exception = db.prepare('SELECT * FROM monthly_report_exceptions WHERE id = ?').get(req.params.id) as any;
    if (!exception) return res.status(404).json({ error: 'Exception not found' });
    const staffId = getStaffIdOrCurrent(req, req.body.resolvedByStaffId);
    if (staffId === null) return res.status(400).json({ error: 'This action requires the logged-in user to be linked to a staff record.' });
    const status = req.body.status ?? 'resolved';
    if (!EXCEPTION_STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${EXCEPTION_STATUSES.join(', ')}` });
    db.prepare('UPDATE monthly_report_exceptions SET status = ?, resolution_notes = ?, resolved_by_staff_id = ?, resolved_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(status, req.body.resolutionNotes, staffId, req.params.id);
    audit(req, { action: 'resolve', entity: 'monthly_report_exceptions', entityId: req.params.id, oldValue: { status: exception.status }, newValue: { status, resolvedByStaffId: staffId } });
    res.json({ ok: true });
  });

  router.post('/exceptions/:id/create-action', requirePermission('actions', 'create'), (req, res) => {
    if (!req.body.title) return res.status(400).json({ error: 'title is required' });
    const db = getDb();
    const exception = db.prepare('SELECT * FROM monthly_report_exceptions WHERE id = ?').get(req.params.id) as any;
    if (!exception) return res.status(404).json({ error: 'Exception not found' });
    const result = db.prepare('INSERT INTO actions (title, module_key, source_module, source_record_id, description, priority, assigned_to_staff_id, due_date, status, evidence_required, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(req.body.title, 'monthly_reports', 'monthly_reports', String(req.params.id), req.body.description ?? exception.exception_message ?? null, req.body.priority ?? 'normal', parseIntNullable(req.body.assignedToStaffId), req.body.dueDate ?? null, 'Not started', req.body.evidenceRequired ? 1 : 0, req.user!.id);
    const actionId = Number(result.lastInsertRowid);
    db.prepare("UPDATE monthly_report_exceptions SET status = 'action_created' WHERE id = ?").run(req.params.id);
    db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('monthly_reports', 'monthly_report_exceptions', String(req.params.id), 'actions', 'actions', String(actionId), 'Action from monthly report exception');
    audit(req, { action: 'create', entity: 'actions', entityId: actionId, newValue: { sourceModule: 'monthly_reports', sourceRecordId: req.params.id, ...req.body } });
    res.status(201).json({ id: actionId });
  });

  // ============= TAT =============
  router.get('/tat', requirePermission('monthly_reports', 'view'), (req, res) => {
    const db = getDb();
    const filters: string[] = [];
    const params: unknown[] = [];
    if (req.query.importBatchId) { filters.push('import_batch_id = ?'); params.push(Number(req.query.importBatchId)); }
    if (req.query.status) { filters.push('status = ?'); params.push(String(req.query.status)); }
    let query = 'SELECT * FROM tat_records';
    if (filters.length) query += ` WHERE ${filters.join(' AND ')}`;
    query += ' ORDER BY id DESC LIMIT 500';
    res.json(db.prepare(query).all(...params));
  });

  router.get('/tat/summary', requirePermission('monthly_reports', 'view'), (req, res) => {
    const db = getDb();
    const filters: string[] = [];
    const params: unknown[] = [];
    if (req.query.month && req.query.year) {
      filters.push('import_batch_id IN (SELECT id FROM lhims_import_batches WHERE report_month = ? AND report_year = ?)');
      params.push(Number(req.query.month), Number(req.query.year));
    }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const row = db.prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'within_target' THEN 1 ELSE 0 END) AS within_target, SUM(CASE WHEN status = 'delayed' THEN 1 ELSE 0 END) AS delayed, SUM(CASE WHEN status IN ('incomplete','exception') THEN 1 ELSE 0 END) AS incomplete, AVG(CASE WHEN tat_minutes IS NOT NULL AND tat_minutes >= 0 THEN tat_minutes END) AS avg_tat_minutes FROM tat_records ${where}`).get(...params) as any;
    const bySection = db.prepare(`SELECT COALESCE(NULLIF(section_name, ''), 'Unassigned') AS section, COUNT(*) AS total, SUM(CASE WHEN status = 'within_target' THEN 1 ELSE 0 END) AS within_target, SUM(CASE WHEN status = 'delayed' THEN 1 ELSE 0 END) AS delayed, SUM(CASE WHEN status IN ('incomplete','exception') THEN 1 ELSE 0 END) AS incomplete, AVG(CASE WHEN tat_minutes IS NOT NULL AND tat_minutes >= 0 THEN tat_minutes END) AS avg_tat_minutes FROM tat_records ${where} GROUP BY section ORDER BY section`).all(...params) as any[];
    res.json({
      total: row.total ?? 0,
      withinTarget: row.within_target ?? 0,
      delayed: row.delayed ?? 0,
      incompleteOrException: row.incomplete ?? 0,
      averageTatMinutes: row.avg_tat_minutes !== null && row.avg_tat_minutes !== undefined ? Math.round(row.avg_tat_minutes) : null,
      bySection: bySection.map(r => ({
        section: r.section,
        total: r.total ?? 0,
        withinTarget: r.within_target ?? 0,
        delayed: r.delayed ?? 0,
        incompleteOrException: r.incomplete ?? 0,
        averageTatMinutes: r.avg_tat_minutes !== null && r.avg_tat_minutes !== undefined ? Math.round(r.avg_tat_minutes) : null
      }))
    });
  });

  return router;
}

export { IMPORT_TYPES, IMPORT_STATUSES, REPORT_TYPES, REPORT_STATUSES, MAPPING_SOURCE_FIELDS, COUNTING_RULES, EXCEPTION_STATUSES };
