import { Router } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import * as XLSX from 'xlsx';
import { getDb, uploadRoot, evidenceRoot } from '../db/database.js';
import { requirePermission } from '../middleware/permissions.js';
import { audit } from '../services/auditService.js';
import { generateRecordNumber } from '../utils/recordNumber.js';
import { parseIntNullable, getStaffIdOrCurrent, getCurrentStaffId } from './routeHelpers.js';
import { extractDocument, deriveDocumentCodeFromName } from '../utils/documentExtract.js';
import { indexDocument } from '../services/dennisService.js';
import { recordSignature } from '../services/signatureService.js';
import { buildDocxFromHtml } from '../utils/documentBuild.js';
import { safeStoredFilename } from '../utils/safeFilename.js';
import { recordCentralArchive } from './archives.js';

// Make a document readable by the Dennis AI assistant (best-effort). Called after
// a document's content is extracted so every uploaded document is fully read into
// the system — search visibility is still enforced per-user at query time.
function indexForDennis(db: any, docId: number, userId: number) {
  try { indexDocument(db, docId, userId); } catch { /* AI indexing is best-effort */ }
}

const DOCUMENT_STATUSES = ['draft', 'under_review', 'reviewed', 'approved', 'current', 'due_review', 'obsolete', 'archived'];
const VERSION_STATUSES = ['draft', 'under_review', 'reviewed', 'approved', 'current', 'obsolete'];
const REVIEW_OUTCOMES = ['no_change', 'minor_revision', 'major_revision', 'obsolete'];
const ATTESTATION_STATUSES = ['pending', 'signed', 'overdue', 'waived'];
const DISTRIBUTION_TARGETS = ['staff', 'position', 'section', 'department'];

function addMonths(dateIso: string, months: number): string {
  const d = new Date(dateIso);
  if (isNaN(d.getTime())) return dateIso;
  d.setMonth(d.getMonth() + months);
  return d.toISOString().slice(0, 10);
}

// Resolve which version of a document to serve. Callers may pass 0/"current",
// and documents replicated from another host (cloud sync) can carry a
// current_version_id minted on the origin node that doesn't exist here — so an
// exact miss falls back to this document's own current version, then its latest
// version, instead of failing with "Version not found".
function resolveVersionId(db: any, docId: number | string, versionParam: unknown): number | null {
  const requested = parseIntNullable(versionParam);
  if (requested) {
    const exact = db.prepare('SELECT id FROM document_versions WHERE id = ? AND document_id = ?').get(requested, docId) as { id: number } | undefined;
    if (exact) return exact.id;
  }
  const doc = db.prepare('SELECT current_version_id FROM documents WHERE id = ?').get(docId) as { current_version_id: number | null } | undefined;
  if (doc?.current_version_id) {
    const cur = db.prepare('SELECT id FROM document_versions WHERE id = ? AND document_id = ?').get(doc.current_version_id, docId) as { id: number } | undefined;
    if (cur) return cur.id;
  }
  const latest = db.prepare('SELECT id FROM document_versions WHERE document_id = ? ORDER BY id DESC LIMIT 1').get(docId) as { id: number } | undefined;
  if (latest) {
    // Self-heal a dangling pointer so joins (register, master list) recover too.
    if (doc && doc.current_version_id && doc.current_version_id !== latest.id) {
      db.prepare('UPDATE documents SET current_version_id = ? WHERE id = ?').run(latest.id, docId);
    }
    return latest.id;
  }
  return null;
}

function flipOverdueAttestations(db: any) {
  db.prepare("UPDATE document_attestations SET status = 'overdue' WHERE status = 'pending' AND due_date IS NOT NULL AND due_date < date('now')").run();
}

function notifyStaff(db: any, staffId: number | null, moduleKey: string, title: string, message: string, opts?: { recordType?: string; recordId?: string | number; actionUrl?: string; actionLabel?: string; severity?: string; notificationType?: string; dueDate?: string | null }) {
  if (!staffId) return;
  const users = db.prepare('SELECT id FROM users WHERE staff_id = ? AND is_active = 1').all(staffId) as Array<{ id: number }>;
  const type = opts?.notificationType || 'follow_up';
  const severity = opts?.severity || 'medium';
  const rt = opts?.recordType || null;
  const rid = opts?.recordId != null ? String(opts.recordId) : null;
  const url = opts?.actionUrl || null;
  const label = opts?.actionLabel || null;
  const due = opts?.dueDate || null;
  for (const u of users) {
    // Rich, actionable notification: title + message + a link to the source
    // record, so the inbox and dashboard can navigate the user straight to the
    // action they need to take (and auto-resolve once completed).
    db.prepare(`INSERT INTO notifications (user_id, module_key, title, message, status, severity, notification_type, record_type, record_id, assigned_to_staff_id, action_url, action_label, due_date, created_by)
      VALUES (?, ?, ?, ?, 'unread', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(u.id, moduleKey, title, message, severity, type, rt, rid, staffId, url, label, due, u.id);
  }
}

function htmlEscape(v: unknown) { return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

// Read the file behind a document version and store its extracted content
// (full text + editable HTML + parsed SOP sections) so the document can be read
// and edited inside SECH_LIMS. Best-effort: a failure leaves the version usable.
function extractIntoVersion(db: any, versionId: number, fileId: number) {
  try {
    const file = db.prepare('SELECT * FROM files WHERE id = ?').get(fileId) as any;
    if (!file) return;
    const root = file.storage_area === 'evidence' ? evidenceRoot : uploadRoot;
    const fp = path.join(root, file.stored_name);
    const result = extractDocument(fp, file.original_name, file.mime_type);
    db.prepare(`UPDATE document_versions SET content_text = ?, content_html = ?, content_sections = ?, page_count = ?, extraction_method = ?, extracted_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(result.text || null, result.html || null, result.sections.length ? JSON.stringify(result.sections) : null, result.pageCount, result.method, versionId);
    return result;
  } catch { /* best-effort extraction */ }
}

// Active staff who should attest to a newly issued controlled document.
function activeStaffIds(db: any): number[] {
  return (db.prepare('SELECT id FROM staff WHERE is_active = 1').all() as Array<{ id: number }>).map(r => r.id);
}

// Assign attestation + distribution to a set of staff for a version, notify them,
// and skip anyone who already has a live (pending/overdue/signed) attestation for
// that version. Returns the staff actually newly assigned.
function distributeToStaff(db: any, doc: any, versionId: number, staffIds: number[], assignedBy: number | null, userId: number, dueDate: string | null): number[] {
  const notified: number[] = [];
  const tx = db.transaction(() => {
    for (const staffId of staffIds) {
      const existing = db.prepare("SELECT id FROM document_attestations WHERE document_version_id = ? AND staff_id = ? AND status IN ('pending','overdue','signed')").get(versionId, staffId);
      if (existing) continue;
      const r = db.prepare(`INSERT INTO document_attestations (document_id, document_version_id, staff_id, assigned_by_staff_id, assigned_at, due_date, status) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, ?, 'pending')`)
        .run(doc.id, versionId, staffId, assignedBy, dueDate);
      const attId = Number(r.lastInsertRowid);
      db.prepare('INSERT INTO document_distribution (document_id, document_version_id, target_type, target_staff_id, assigned_by_staff_id, due_date, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(doc.id, versionId, 'staff', staffId, assignedBy, dueDate, 'pending', userId);
      db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run('documents', 'documents', String(doc.id), 'documents', 'document_attestations', String(attId), 'Attestation assignment');
      notified.push(staffId);
    }
  });
  tx();
  const msg = `Please read and attest: ${doc.document_code ? doc.document_code + ' — ' : ''}${doc.title}${dueDate ? ` (due ${dueDate})` : ''}`;
  // Each notification carries the attestation id so the inbox can auto-clear it
  // once the staff signs, and an action URL so clicking opens the document
  // viewer with the attestation prompt shown.
  for (const sId of notified) {
    const att = db.prepare('SELECT id FROM document_attestations WHERE document_version_id = ? AND staff_id = ?').get(versionId, sId) as { id: number } | undefined;
    notifyStaff(db, sId, 'documents', 'New controlled document to attest', msg, {
      recordType: 'document_attestations', recordId: att?.id, dueDate,
      actionUrl: `/documents?open=${doc.id}&attest=${att?.id ?? ''}`,
      actionLabel: 'Read & attest',
      notificationType: 'follow_up',
      severity: 'medium',
    });
  }
  return notified;
}

// Build the next SECH document control number for a coding scheme, following the
// SECH Document Control Procedure (SECHPO026 §5.1.6).
function nextDocumentCode(db: any, type: string, sectionCode?: string | null): string {
  const t = (type || '').toLowerCase();
  const singletons: Record<string, string> = { 'quality manual': 'SECHQM', 'handbook': 'SECHHB', 'laboratory handbook': 'SECHHB', 'safety manual': 'SECHSM' };
  if (singletons[t]) return singletons[t];
  let prefix: string;
  let pad = 3;
  if (t === 'form') prefix = 'SECHF';
  else if (t === 'sop') prefix = `SECHSOP${(sectionCode || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3)}`;
  else if (t === 'register' || t === 'log' || t === 'tracker' || t === 'master list') { prefix = 'SECHML'; pad = 2; }
  else prefix = 'SECHPO'; // policies, manuals, procedures (management)
  const rows = db.prepare('SELECT document_code FROM documents WHERE document_code LIKE ?').all(`${prefix}%`) as Array<{ document_code: string }>;
  let max = 0;
  for (const r of rows) {
    const m = r.document_code && r.document_code.slice(prefix.length).match(/^(\d+)/);
    if (m) { const n = Number(m[1]); if (n > max) max = n; }
  }
  return `${prefix}${String(max + 1).padStart(pad, '0')}`;
}

// Deleting documents is an administrator-only capability, deliberately kept out
// of the reach of the ordinary "approve" authority so it cannot be reached by
// mistake. A System Administrator is any user whose role is the system-admin
// role. Callers must be authenticated first (requirePermission runs before).
function isAdminUser(req: any): boolean {
  const db = getDb();
  const row = db.prepare('SELECT r.name AS role_name FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?').get(req.user?.id) as { role_name?: string } | undefined;
  return (row?.role_name || '').trim().toLowerCase() === 'system administrator';
}

// Permanently remove one document and everything owned by it (versions,
// attestations, comments, distribution, print logs, reviews), remove its AI
// index and record links, detach incidental references from other business
// records, and delete now-unreferenced files from disk. Runs in its own
// transaction. Shared by the single- and bulk-delete endpoints.
function deleteDocumentCascade(db: any, docId: number): void {
  const fileIds = (db.prepare('SELECT DISTINCT file_id FROM document_versions WHERE document_id = ? AND file_id IS NOT NULL').all(docId) as Array<{ file_id: number }>).map(r => r.file_id);
  const columnExists = (table: string, column: string) => {
    try { return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(c => c.name === column); }
    catch { return false; }
  };
  const tableExists = (table: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(table));

  const remove = db.transaction(() => {
    db.prepare('DELETE FROM document_attestations WHERE document_id = ? OR document_version_id IN (SELECT id FROM document_versions WHERE document_id = ?)').run(docId, docId);
    for (const t of ['document_comments', 'document_distribution', 'document_print_logs', 'document_reviews']) {
      if (tableExists(t)) db.prepare(`DELETE FROM ${t} WHERE document_id = ?`).run(docId);
    }
    if (tableExists('dennis_document_chunks')) db.prepare('DELETE FROM dennis_document_chunks WHERE source_document_id = ?').run(docId);
    if (tableExists('dennis_documents')) db.prepare('DELETE FROM dennis_documents WHERE source_document_id = ?').run(docId);
    db.prepare("DELETE FROM record_links WHERE (source_module_key = 'documents' AND source_record_type = 'documents' AND source_record_id = ?) OR (target_module_key = 'documents' AND target_record_type = 'documents' AND target_record_id = ?)").run(String(docId), String(docId));
    const versionIds = (db.prepare('SELECT id FROM document_versions WHERE document_id = ?').all(docId) as Array<{ id: number }>).map(r => r.id);
    for (const [table, col] of [['record_register', 'document_id'], ['quality_objectives', 'document_id'], ['tat_records', 'document_id'], ['lab_test_catalog', 'document_id'], ['referral_laboratories', 'document_id'], ['specimen_acceptance_criteria', 'document_id'], ['laboratory_documents', 'document_id'], ['ethical_declaration_forms', 'document_id'], ['record_destruction_log', 'document_id'], ['staff_declarations', 'document_id']] as const) {
      if (tableExists(table) && columnExists(table, col)) db.prepare(`UPDATE ${table} SET ${col} = NULL WHERE ${col} = ?`).run(docId);
    }
    if (versionIds.length && tableExists('staff_declarations') && columnExists('staff_declarations', 'document_version_id')) {
      const placeholders = versionIds.map(() => '?').join(',');
      db.prepare(`UPDATE staff_declarations SET document_version_id = NULL WHERE document_version_id IN (${placeholders})`).run(...versionIds);
    }
    db.prepare('UPDATE documents SET current_version_id = NULL WHERE id = ?').run(docId);
    db.prepare('DELETE FROM document_versions WHERE document_id = ?').run(docId);
    db.prepare('DELETE FROM documents WHERE id = ?').run(docId);
    for (const fileId of fileIds) {
      const stillUsed = (db.prepare('SELECT COUNT(*) AS n FROM document_versions WHERE file_id = ?').get(fileId) as { n: number }).n
        + (tableExists('staff_documents') ? (db.prepare('SELECT COUNT(*) AS n FROM staff_documents WHERE file_id = ?').get(fileId) as { n: number }).n : 0);
      if (stillUsed > 0) continue;
      const file = db.prepare('SELECT stored_name, storage_area FROM files WHERE id = ?').get(fileId) as { stored_name: string; storage_area: string } | undefined;
      if (file) {
        const root = file.storage_area === 'evidence' ? evidenceRoot : uploadRoot;
        try { const fp = path.join(root, file.stored_name); if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch { /* best-effort disk cleanup */ }
        db.prepare('DELETE FROM files WHERE id = ?').run(fileId);
      }
    }
  });
  remove();
}

export function documentControlRoutes() {
  const router = Router();

  // -------- Reviews due (specific path before /:id) --------
  router.get('/reviews/due', requirePermission('documents.library', 'view'), (req, res) => {
    const db = getDb();
    const horizonDays = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
    const cutoff = new Date(Date.now() + horizonDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    res.json(db.prepare(`SELECT id, document_code, title, document_type, status, next_review_date, owner_staff_id FROM documents WHERE next_review_date IS NOT NULL AND next_review_date <= ? AND status != 'obsolete' ORDER BY next_review_date`).all(cutoff));
  });

  // Every attestation ever assigned or signed — filterable by document code,
  // title, staff name, status. Powers the redesigned Attestation List tab.
  router.get('/attestations/list', requirePermission('documents.library', 'view'), (req, res) => {
    const db = getDb();
    flipOverdueAttestations(db);
    const filters: string[] = [];
    const params: unknown[] = [];
    const docId = parseIntNullable(req.query.documentId);
    if (docId) { filters.push('(a.document_id = ? OR a.document_version_id IN (SELECT id FROM document_versions WHERE document_id = ?))'); params.push(docId, docId); }
    if (req.query.status) { filters.push('a.status = ?'); params.push(String(req.query.status)); }
    const q = String(req.query.q || '').trim();
    if (q) { filters.push('(LOWER(COALESCE(d.document_code, \'\')) LIKE ? OR LOWER(d.title) LIKE ? OR LOWER(COALESCE(s.full_name, \'\')) LIKE ?)'); const like = `%${q.toLowerCase()}%`; params.push(like, like, like); }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const rows = db.prepare(`
      SELECT a.*, d.document_code, d.title, d.document_type, v.version_number, s.full_name AS staff_name, s.employee_no AS staff_employee_no,
             sec.name AS section_name, ab.full_name AS assigned_by_name
      FROM document_attestations a
      LEFT JOIN documents d ON d.id = COALESCE(a.document_id, (SELECT document_id FROM document_versions WHERE id = a.document_version_id))
      LEFT JOIN document_versions v ON v.id = a.document_version_id
      LEFT JOIN staff s ON s.id = a.staff_id
      LEFT JOIN sections sec ON sec.id = s.section_id
      LEFT JOIN staff ab ON ab.id = a.assigned_by_staff_id
      ${where}
      ORDER BY CASE a.status WHEN 'signed' THEN 0 ELSE 1 END, a.attested_at DESC, a.id DESC
      LIMIT 2000
    `).all(...params);
    res.json(rows);
  });

  // Documents that have at least one attestation (for the "pick a document"
  // search on the Attestation List tab).
  router.get('/attestations/documents', requirePermission('documents.library', 'view'), (_req, res) => {
    const db = getDb();
    res.json(db.prepare(`
      SELECT d.id, d.document_code, d.title, d.document_type, d.status,
             COUNT(a.id) AS attestations_total,
             SUM(CASE WHEN a.status = 'signed' THEN 1 ELSE 0 END) AS attestations_signed,
             SUM(CASE WHEN a.status IN ('pending','overdue') THEN 1 ELSE 0 END) AS attestations_pending
      FROM documents d
      JOIN document_attestations a ON a.document_id = d.id OR a.document_version_id IN (SELECT id FROM document_versions WHERE document_id = d.id)
      GROUP BY d.id
      ORDER BY d.document_code, d.title
    `).all());
  });

  // Renders a printable Attestation List for a document (all signed staff).
  // Independent of the document body — used for auditors and hard-copy records.
  router.get('/:id/attestations/print', requirePermission('documents.library', 'print'), (req, res) => {
    const db = getDb();
    const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id) as any;
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    const versionId = resolveVersionId(db, req.params.id, req.query.versionId);
    const version = versionId ? db.prepare('SELECT * FROM document_versions WHERE id = ?').get(versionId) as any : null;
    const rows = db.prepare(`
      SELECT a.*, s.full_name AS staff_name, s.employee_no, sec.name AS section_name,
             p.title AS position_title
      FROM document_attestations a
      LEFT JOIN staff s ON s.id = a.staff_id
      LEFT JOIN sections sec ON sec.id = s.section_id
      LEFT JOIN staff_position_assignments spa ON spa.staff_id = s.id AND spa.is_active = 1 AND spa.assignment_type = 'primary'
      LEFT JOIN positions p ON p.id = spa.position_id
      WHERE (a.document_id = ? OR a.document_version_id IN (SELECT id FROM document_versions WHERE document_id = ?))
      ${versionId ? 'AND a.document_version_id = ?' : ''}
      ORDER BY CASE a.status WHEN 'signed' THEN 0 ELSE 1 END, a.attested_at, s.full_name
    `).all(...(versionId ? [req.params.id, req.params.id, versionId] : [req.params.id, req.params.id])) as any[];
    const lab = db.prepare("SELECT facility_name FROM laboratory_profile WHERE id = 1").get() as any;
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>Attestation List — ${htmlEscape(doc.document_code || doc.title)}</title>
<style>@page { size: A4; margin: 14mm; }
body { font-family: 'Segoe UI', Arial, sans-serif; color: #111; margin: 0; padding: 24px; }
h1 { font-size: 16px; margin: 0 0 4px; color: #1B3A6B; }
h2 { font-size: 13px; margin: 0 0 12px; color: #4a5568; font-weight: 500; }
table { border-collapse: collapse; width: 100%; font-size: 11.5px; margin-top: 12px; }
th, td { border: 1px solid #a0aec0; padding: 5px 8px; text-align: left; vertical-align: top; }
th { background: #edf2f7; font-weight: 600; }
tr.pending td { color: #9b2c2c; background: #fff5f5; }
.meta { font-size: 11px; color: #555; margin: 8px 0 10px; display: flex; flex-wrap: wrap; gap: 18px; }
.meta div { min-width: 140px; }
.meta strong { color: #2d3748; }
.footer { font-size: 10px; color: #666; margin-top: 22px; border-top: 1px solid #cbd5e0; padding-top: 6px; display: flex; justify-content: space-between; }
.no-print { background: #f0f4fa; padding: 6px 10px; margin-bottom: 12px; border-radius: 4px; font-size: 11px; color: #234; }
@media print { .no-print { display: none; } }
</style></head><body>
<div class="no-print">Use your browser's Print (Ctrl+P) to print or save this Attestation List as PDF.</div>
<h1>Attestation List</h1>
<h2>${htmlEscape(lab?.facility_name || 'Laboratory')} · ${htmlEscape(doc.document_code || '')}${doc.document_code ? ' — ' : ''}${htmlEscape(doc.title)}</h2>
<div class="meta">
  <div><strong>Version</strong><br/>${htmlEscape(version?.version_number || version?.version_label || '—')}</div>
  <div><strong>Effective</strong><br/>${htmlEscape(version?.effective_date || '—')}</div>
  <div><strong>Document type</strong><br/>${htmlEscape(doc.document_type || '—')}</div>
  <div><strong>Signed</strong><br/>${rows.filter((r: any) => r.status === 'signed').length} of ${rows.length}</div>
  <div><strong>Printed</strong><br/>${new Date().toISOString().slice(0, 19).replace('T', ' ')}</div>
</div>
<table>
  <thead><tr><th style="width:5%;">#</th><th style="width:32%;">Staff name</th><th style="width:14%;">Staff ID</th><th style="width:16%;">Position</th><th style="width:15%;">Section / unit</th><th style="width:9%;">Status</th><th style="width:9%;">Signed on</th></tr></thead>
  <tbody>
  ${rows.length ? rows.map((r: any, i: number) => `<tr class="${r.status !== 'signed' ? 'pending' : ''}"><td>${i + 1}</td><td>${htmlEscape(r.staff_name || '—')}</td><td>${htmlEscape(r.employee_no || '—')}</td><td>${htmlEscape(r.position_title || '—')}</td><td>${htmlEscape(r.section_name || '—')}</td><td>${htmlEscape(r.status)}</td><td>${htmlEscape(r.attested_at ? String(r.attested_at).slice(0, 10) : '—')}</td></tr>`).join('') : `<tr><td colspan="7" style="text-align:center; color:#888;">No attestations have been assigned for this document yet.</td></tr>`}
  </tbody>
</table>
<div class="footer"><span>SECH_LIMS by Nickland — Attestation List</span><span>Personally signed by each staff member; signatures are non-transferable.</span></div>
</body></html>`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  });

  router.get('/attestations/pending', requirePermission('documents.library', 'view'), (req, res) => {
    const db = getDb();
    flipOverdueAttestations(db);
    const staffId = parseIntNullable(req.query.staffId);
    const where = staffId ? 'WHERE a.staff_id = ? AND a.status IN (\'pending\',\'overdue\')' : 'WHERE a.status IN (\'pending\',\'overdue\')';
    const params: unknown[] = staffId ? [staffId] : [];
    res.json(db.prepare(`SELECT a.*, d.id AS doc_id, d.document_code, d.title, d.document_type, v.version_number FROM document_attestations a JOIN documents d ON d.id = COALESCE(a.document_id, (SELECT document_id FROM document_versions WHERE id = a.document_version_id)) LEFT JOIN document_versions v ON v.id = a.document_version_id ${where} ORDER BY a.due_date NULLS LAST, a.id DESC`).all(...params));
  });

  router.get('/distribution/inbox', requirePermission('documents.library', 'view'), (req, res) => {
    const db = getDb();
    flipOverdueAttestations(db);
    const staffId = parseIntNullable(req.query.staffId) ?? req.user?.staffId ?? null;
    if (!staffId) return res.json([]);
    res.json(db.prepare(`
      SELECT dd.*, d.document_code, d.title, d.document_type, v.version_number,
             a.id AS attestation_id, a.status AS attestation_status, a.attested_at, a.due_date AS attestation_due
      FROM document_distribution dd
      JOIN documents d ON d.id = dd.document_id
      LEFT JOIN document_versions v ON v.id = dd.document_version_id
      LEFT JOIN document_attestations a ON a.document_id = dd.document_id AND a.staff_id = dd.target_staff_id AND a.document_version_id = dd.document_version_id
      WHERE dd.target_staff_id = ?
      ORDER BY CASE dd.status WHEN 'pending' THEN 0 WHEN 'overdue' THEN 1 ELSE 2 END, dd.due_date NULLS LAST, dd.id DESC
    `).all(staffId));
  });

  // -------- Document number generator (SECHPO026 §5.1.6) --------
  router.get('/next-code', requirePermission('documents.library', 'view'), (req, res) => {
    const db = getDb();
    const code = nextDocumentCode(db, String(req.query.type || 'SOP'), req.query.sectionCode ? String(req.query.sectionCode) : null);
    res.json({ code });
  });
  // Derive a document code from a file/document name, e.g.
  // "SECHPO026 Document Control Procedure" -> "SECHPO026".
  router.get('/derive-code', requirePermission('documents.library', 'view'), (req, res) => {
    res.json({ code: deriveDocumentCodeFromName(String(req.query.name || '')) });
  });
  // Read an already-uploaded file and return the document title and number guessed
  // from its content/heading — so "New Document" can auto-fill name and number the
  // same way bulk import does. Does not persist anything.
  router.post('/extract-preview', requirePermission('documents.authoring', 'create'), (req, res) => {
    const db = getDb();
    const fileId = parseIntNullable(req.body.fileId);
    if (!fileId) return res.status(400).json({ error: 'fileId is required' });
    const file = db.prepare('SELECT * FROM files WHERE id = ?').get(fileId) as any;
    if (!file) return res.status(404).json({ error: 'File not found' });
    const root = file.storage_area === 'evidence' ? evidenceRoot : uploadRoot;
    const r = extractDocument(path.join(root, file.stored_name), file.original_name, file.mime_type);
    // Prefer a code found in the content; fall back to one derived from the filename.
    const codeFromName = deriveDocumentCodeFromName(file.original_name);
    res.json({
      titleGuess: r.titleGuess,
      documentCodeGuess: r.documentCodeGuess || codeFromName,
      method: r.method,
      sections: r.sections.length,
      pageCount: r.pageCount,
      hasContent: !!(r.text && r.text.trim().length > 20),
    });
  });

  // ===================================================================
  // RECORD CONTROL (SECHPO051 — Control of Records Procedure)
  // Registered before /:id so the path segments never collide with it.
  // ===================================================================
  router.get('/records/summary', requirePermission('documents.records', 'view'), (_req, res) => {
    const db = getDb();
    const todayIso = new Date().toISOString().slice(0, 10);
    const c = (sql: string, ...p: unknown[]) => (db.prepare(sql).get(...p) as { c: number }).c;
    res.json({
      activeRecords: c("SELECT COUNT(*) c FROM record_register WHERE status = 'active'"),
      archivedRecords: c("SELECT COUNT(*) c FROM record_register WHERE status = 'archived'"),
      disposalDue: c("SELECT COUNT(*) c FROM record_register WHERE status = 'active' AND disposal_due_date IS NOT NULL AND disposal_due_date <= ?", todayIso),
      retentionRules: c('SELECT COUNT(*) c FROM record_retention_schedule WHERE is_active = 1'),
      reviewsThisMonth: c("SELECT COUNT(*) c FROM record_review_log WHERE strftime('%Y-%m', review_date) = strftime('%Y-%m','now')"),
      openReviewActions: c("SELECT COUNT(*) c FROM record_review_log WHERE action_required = 1 AND follow_up_status NOT IN ('completed')"),
      destructionsThisYear: c("SELECT COUNT(*) c FROM record_destruction_log WHERE strftime('%Y', date_destroyed) = strftime('%Y','now')"),
      backupsThisMonth: c("SELECT COUNT(*) c FROM record_backup_log WHERE strftime('%Y-%m', backup_date) = strftime('%Y-%m','now')"),
      failedRestoreTests: c("SELECT COUNT(*) c FROM record_backup_log WHERE restore_test_status = 'failed'"),
    });
  });

  // Record register (inventory of controlled records)
  router.get('/records/register', requirePermission('documents.records', 'view'), (req, res) => {
    const db = getDb();
    const filters: string[] = []; const params: unknown[] = [];
    if (req.query.status) { filters.push('rr.status = ?'); params.push(String(req.query.status)); }
    if (req.query.category) { filters.push('rr.record_category = ?'); params.push(String(req.query.category)); }
    let q = `SELECT rr.*, s.name AS section_name, st.full_name AS responsible_name, d.document_code AS linked_document_code, d.title AS linked_document_title,
             f.original_name AS file_name, f.mime_type AS file_mime, f.size_bytes AS file_size
             FROM record_register rr LEFT JOIN sections s ON s.id = rr.section_id LEFT JOIN staff st ON st.id = rr.responsible_staff_id LEFT JOIN documents d ON d.id = rr.linked_document_id LEFT JOIN files f ON f.id = rr.file_id`;
    if (filters.length) q += ` WHERE ${filters.join(' AND ')}`;
    q += ' ORDER BY rr.created_at DESC';
    res.json(db.prepare(q).all(...params));
  });
  router.post('/records/register', requirePermission('documents.records', 'create'), (req, res) => {
    if (!req.body.title) return res.status(400).json({ error: 'title is required' });
    const db = getDb();
    const code = req.body.recordCode || generateRecordNumber(db, 'record_register', 'SECHREC');
    const fileId = parseIntNullable(req.body.fileId);
    const origin = req.body.origin ?? (fileId ? 'uploaded' : 'manual');
    const r = db.prepare(`INSERT INTO record_register (record_code, title, record_category, record_format, department_id, section_id, responsible_staff_id, storage_location, storage_medium, retention_schedule_id, retention_period, confidentiality, linked_document_id, date_created, disposal_due_date, disposal_method, file_id, origin, source_module, status, notes, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      code, req.body.title, req.body.recordCategory ?? null, req.body.recordFormat ?? 'electronic', parseIntNullable(req.body.departmentId), parseIntNullable(req.body.sectionId),
      parseIntNullable(req.body.responsibleStaffId), req.body.storageLocation ?? null, req.body.storageMedium ?? null, parseIntNullable(req.body.retentionScheduleId),
      req.body.retentionPeriod ?? null, req.body.confidentiality ?? 'internal', parseIntNullable(req.body.linkedDocumentId), req.body.dateCreated ?? null, req.body.disposalDueDate ?? null,
      req.body.disposalMethod ?? null, fileId, origin, req.body.sourceModule ?? null,
      req.body.status ?? 'active', req.body.notes ?? null, req.user!.id);
    if (fileId) db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run('documents', 'record_register', String(r.lastInsertRowid), 'documents', 'files', String(fileId), 'Uploaded record file');
    audit(req, { action: 'create', entity: 'record_register', entityId: r.lastInsertRowid, newValue: { code, ...req.body } });
    res.status(201).json({ id: r.lastInsertRowid, recordCode: code });
  });
  router.put('/records/register/:id', requirePermission('documents.records', 'edit'), (req, res) => {
    const db = getDb();
    const old = db.prepare('SELECT * FROM record_register WHERE id = ?').get(req.params.id) as any;
    if (!old) return res.status(404).json({ error: 'Record not found' });
    db.prepare(`UPDATE record_register SET title = ?, record_category = ?, record_format = ?, department_id = ?, section_id = ?, responsible_staff_id = ?, storage_location = ?, storage_medium = ?, retention_schedule_id = ?, retention_period = ?, confidentiality = ?, linked_document_id = ?, date_created = ?, disposal_due_date = ?, disposal_method = ?, file_id = ?, origin = ?, source_module = ?, status = ?, notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(
      req.body.title ?? old.title, req.body.recordCategory ?? old.record_category, req.body.recordFormat ?? old.record_format, parseIntNullable(req.body.departmentId) ?? old.department_id, parseIntNullable(req.body.sectionId) ?? old.section_id,
      parseIntNullable(req.body.responsibleStaffId) ?? old.responsible_staff_id, req.body.storageLocation ?? old.storage_location, req.body.storageMedium ?? old.storage_medium, parseIntNullable(req.body.retentionScheduleId) ?? old.retention_schedule_id,
      req.body.retentionPeriod ?? old.retention_period, req.body.confidentiality ?? old.confidentiality, parseIntNullable(req.body.linkedDocumentId) ?? old.linked_document_id, req.body.dateCreated ?? old.date_created, req.body.disposalDueDate ?? old.disposal_due_date,
      req.body.disposalMethod ?? old.disposal_method, parseIntNullable(req.body.fileId) ?? old.file_id, req.body.origin ?? old.origin, req.body.sourceModule ?? old.source_module,
      req.body.status ?? old.status, req.body.notes ?? old.notes, req.params.id);
    audit(req, { action: 'edit', entity: 'record_register', entityId: req.params.id, oldValue: old, newValue: req.body });
    res.json({ ok: true });
  });

  // Retention schedule (SECHPO051 Appendix A)
  router.get('/records/retention-schedule', requirePermission('documents.records', 'view'), (_req, res) => {
    res.json(getDb().prepare('SELECT * FROM record_retention_schedule ORDER BY sn, id').all());
  });
  router.post('/records/retention-schedule', requirePermission('documents.records', 'create'), (req, res) => {
    if (!req.body.recordType || !req.body.retentionPeriod) return res.status(400).json({ error: 'recordType and retentionPeriod are required' });
    const db = getDb();
    const maxSn = (db.prepare('SELECT MAX(sn) m FROM record_retention_schedule').get() as { m: number | null }).m ?? 0;
    const r = db.prepare('INSERT INTO record_retention_schedule (sn, record_type, retention_period, storage_medium, responsible_role, extended_retention, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      req.body.sn ?? maxSn + 1, req.body.recordType, req.body.retentionPeriod, req.body.storageMedium ?? null, req.body.responsibleRole ?? null, req.body.extendedRetention ? 1 : 0, req.body.notes ?? null, req.user!.id);
    audit(req, { action: 'create', entity: 'record_retention_schedule', entityId: r.lastInsertRowid, newValue: req.body });
    res.status(201).json({ id: r.lastInsertRowid });
  });
  router.put('/records/retention-schedule/:id', requirePermission('documents.records', 'edit'), (req, res) => {
    const db = getDb();
    const old = db.prepare('SELECT * FROM record_retention_schedule WHERE id = ?').get(req.params.id) as any;
    if (!old) return res.status(404).json({ error: 'Rule not found' });
    db.prepare('UPDATE record_retention_schedule SET record_type = ?, retention_period = ?, storage_medium = ?, responsible_role = ?, extended_retention = ?, notes = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(
      req.body.recordType ?? old.record_type, req.body.retentionPeriod ?? old.retention_period, req.body.storageMedium ?? old.storage_medium, req.body.responsibleRole ?? old.responsible_role,
      req.body.extendedRetention !== undefined ? (req.body.extendedRetention ? 1 : 0) : old.extended_retention, req.body.notes ?? old.notes, req.body.isActive !== undefined ? (req.body.isActive ? 1 : 0) : old.is_active, req.params.id);
    audit(req, { action: 'edit', entity: 'record_retention_schedule', entityId: req.params.id, oldValue: old, newValue: req.body });
    res.json({ ok: true });
  });

  // Quality & Technical Records Review Log (SECHPO051 §5.7)
  router.get('/records/review-log', requirePermission('documents.records', 'view'), (_req, res) => {
    res.json(getDb().prepare(`SELECT rl.*, s.name AS section_name, st.full_name AS responsible_name, rv.full_name AS reviewer_name
      FROM record_review_log rl LEFT JOIN sections s ON s.id = rl.section_id LEFT JOIN staff st ON st.id = rl.responsible_staff_id LEFT JOIN staff rv ON rv.id = rl.reviewer_staff_id ORDER BY rl.review_date DESC, rl.id DESC`).all());
  });
  router.post('/records/review-log', requirePermission('documents.records', 'create'), (req, res) => {
    if (!req.body.reviewDate || !req.body.recordCategory) return res.status(400).json({ error: 'reviewDate and recordCategory are required' });
    const db = getDb();
    const num = generateRecordNumber(db, 'record_review_log', 'RECREV', req.body.reviewDate);
    const reviewer = getStaffIdOrCurrent(req, req.body.reviewerStaffId);
    const r = db.prepare(`INSERT INTO record_review_log (review_number, review_date, record_category, section_id, records_reviewed, findings, nonconformities_identified, action_required, responsible_staff_id, target_completion_date, follow_up_status, reviewer_staff_id, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      num, req.body.reviewDate, req.body.recordCategory, parseIntNullable(req.body.sectionId), req.body.recordsReviewed ?? null, req.body.findings ?? null, req.body.nonconformitiesIdentified ?? null,
      req.body.actionRequired ? 1 : 0, parseIntNullable(req.body.responsibleStaffId), req.body.targetCompletionDate ?? null, req.body.followUpStatus ?? 'open', reviewer, req.user!.id);
    audit(req, { action: 'create', entity: 'record_review_log', entityId: r.lastInsertRowid, newValue: { num, ...req.body } });
    res.status(201).json({ id: r.lastInsertRowid, reviewNumber: num });
  });
  router.put('/records/review-log/:id', requirePermission('documents.records', 'edit'), (req, res) => {
    const db = getDb();
    const old = db.prepare('SELECT * FROM record_review_log WHERE id = ?').get(req.params.id) as any;
    if (!old) return res.status(404).json({ error: 'Review not found' });
    db.prepare('UPDATE record_review_log SET findings = ?, nonconformities_identified = ?, action_required = ?, responsible_staff_id = ?, target_completion_date = ?, follow_up_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(
      req.body.findings ?? old.findings, req.body.nonconformitiesIdentified ?? old.nonconformities_identified, req.body.actionRequired !== undefined ? (req.body.actionRequired ? 1 : 0) : old.action_required,
      parseIntNullable(req.body.responsibleStaffId) ?? old.responsible_staff_id, req.body.targetCompletionDate ?? old.target_completion_date, req.body.followUpStatus ?? old.follow_up_status, req.params.id);
    audit(req, { action: 'edit', entity: 'record_review_log', entityId: req.params.id, oldValue: old, newValue: req.body });
    res.json({ ok: true });
  });

  // Document & Record Destruction log (SECHF0047, SECHPO051 §5.6)
  router.get('/records/destruction-log', requirePermission('documents.records', 'view'), (_req, res) => {
    res.json(getDb().prepare(`SELECT dl.*, a.full_name AS authorized_by_name, w.full_name AS witness_name
      FROM record_destruction_log dl LEFT JOIN staff a ON a.id = dl.authorized_by_staff_id LEFT JOIN staff w ON w.id = dl.witness_staff_id ORDER BY dl.date_destroyed DESC, dl.id DESC`).all());
  });
  router.post('/records/destruction-log', requirePermission('documents.records', 'approve'), (req, res) => {
    if (!req.body.description || !req.body.dateDestroyed) return res.status(400).json({ error: 'description and dateDestroyed are required' });
    const db = getDb();
    const num = generateRecordNumber(db, 'record_destruction_log', 'SECHF0047', req.body.dateDestroyed);
    const auth = getStaffIdOrCurrent(req, req.body.authorizedByStaffId);
    const r = db.prepare(`INSERT INTO record_destruction_log (destruction_number, item_type, record_register_id, document_id, description, record_category, date_destroyed, method, retention_verified, confidentiality_ensured, authorized_by_staff_id, witness_staff_id, notes, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      num, req.body.itemType ?? 'record', parseIntNullable(req.body.recordRegisterId), parseIntNullable(req.body.documentId), req.body.description, req.body.recordCategory ?? null, req.body.dateDestroyed,
      req.body.method ?? null, req.body.retentionVerified ? 1 : 0, req.body.confidentialityEnsured === false ? 0 : 1, auth, parseIntNullable(req.body.witnessStaffId), req.body.notes ?? null, req.user!.id);
    if (parseIntNullable(req.body.recordRegisterId)) db.prepare("UPDATE record_register SET status = 'disposed', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(parseIntNullable(req.body.recordRegisterId));
    audit(req, { action: 'destroy', entity: 'record_destruction_log', entityId: r.lastInsertRowid, newValue: { num, ...req.body } });
    res.status(201).json({ id: r.lastInsertRowid, destructionNumber: num });
  });

  // Backup & Archive log (SECHPO051 §5.4)
  router.get('/records/backup-log', requirePermission('documents.records', 'view'), (_req, res) => {
    res.json(getDb().prepare(`SELECT bl.*, s.full_name AS performed_by_name FROM record_backup_log bl LEFT JOIN staff s ON s.id = bl.performed_by_staff_id ORDER BY bl.backup_date DESC, bl.id DESC`).all());
  });
  router.post('/records/backup-log', requirePermission('documents.records', 'create'), (req, res) => {
    if (!req.body.backupDate) return res.status(400).json({ error: 'backupDate is required' });
    const db = getDb();
    const num = generateRecordNumber(db, 'record_backup_log', 'BKP', req.body.backupDate);
    const by = getStaffIdOrCurrent(req, req.body.performedByStaffId);
    const r = db.prepare(`INSERT INTO record_backup_log (backup_number, backup_date, backup_type, scope, storage_location, offsite, performed_by_staff_id, integrity_verified, restore_test_status, restore_test_date, status, notes, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      num, req.body.backupDate, req.body.backupType ?? null, req.body.scope ?? null, req.body.storageLocation ?? null, req.body.offsite ? 1 : 0, by,
      req.body.integrityVerified ? 1 : 0, req.body.restoreTestStatus ?? null, req.body.restoreTestDate ?? null, req.body.status ?? 'completed', req.body.notes ?? null, req.user!.id);
    // Mirror into the central archive register so every backup is visible in
    // Documents & Records → Archives alongside every other archived record.
    recordCentralArchive(db, {
      title: `Backup ${num} — ${req.body.scope || 'system data'}`,
      description: `${req.body.backupType || 'backup'} on ${req.body.backupDate}${req.body.storageLocation ? ` (stored: ${req.body.storageLocation})` : ''}${req.body.offsite ? ' — off-site' : ''}`,
      archiveType: 'backup',
      sourceModule: 'documents', sourceRecordType: 'record_backup_log', sourceRecordId: r.lastInsertRowid,
      periodStart: req.body.backupDate, periodEnd: req.body.backupDate,
      fileId: parseIntNullable(req.body.fileId),
      cloudUrl: req.body.cloudUrl ?? null, cloudProvider: req.body.cloudProvider ?? null,
      storageLocation: req.body.storageLocation ?? null,
      archivedByStaffId: by, isAutomatic: true,
      createdBy: req.user!.id,
    });
    audit(req, { action: 'create', entity: 'record_backup_log', entityId: r.lastInsertRowid, newValue: { num, ...req.body } });
    res.status(201).json({ id: r.lastInsertRowid, backupNumber: num });
  });

  // ===================================================================
  // DOCUMENT & RECORDS MASTER LIST
  // On-screen registers and Excel exports that mirror the laboratory's
  // controlled Document & Records Master List workbook: a Document
  // Register, a Records Register and an Obsolete Document Register.
  // ===================================================================
  const DOC_REGISTER_HEADERS = ['No.', 'Document Code', 'Category', 'Unit / Section', 'Document Title', 'Version', 'Status', 'Format / Medium', 'Effective Date', 'Review Frequency (Yrs)', 'Next Review Due', 'Author (Name & Position)', 'Technical Reviewer', 'Approved By (Authoriser)', 'Controlled Locations / Distribution', 'Retention Period', 'Remarks'];
  const REC_REGISTER_HEADERS = ['No.', 'Record Type / Title', 'Record Category', 'Source / Generating Document', 'Format / Medium', 'Responsible Owner (Unit)', 'Storage Location', 'Confidentiality / Access Level', 'Retention Period', 'Disposal Method', 'Status', 'Remarks'];
  const OBS_REGISTER_HEADERS = ['No.', 'Former Document Code', 'Document Title', 'Last Version', 'Reason / Remark', 'Effective Date (Last Active)', 'Date Withdrawn / Discontinued', 'Author', 'Technical Reviewer', 'Authoriser', 'Retention / Destroy Date', 'Archive Location'];

  const DOC_STATUS_LABELS: Record<string, string> = { current: 'Active', approved: 'Active', draft: 'Draft (Not Yet Issued)', under_review: 'Under Review', reviewed: 'Pending Issue', due_review: 'Active - Review Due', obsolete: 'Obsolete', archived: 'Archived' };
  const docStatusLabel = (s: string) => DOC_STATUS_LABELS[s] || s;
  const RECORD_FORMAT_LABELS: Record<string, string> = { electronic: 'Electronic', paper: 'Hard Copy', both: 'Electronic + Hard Copy' };
  const CONFIDENTIALITY_LABELS: Record<string, string> = { public: 'Public', internal: 'Internal - Staff Use Only', restricted: 'Restricted - Authorised Staff Only', confidential: 'Restricted - Confidential (Personal/Patient Data)' };
  const RECORD_CATEGORY_LABELS: Record<string, string> = { pre_examination: 'Pre-Examination Record', examination: 'Examination / Patient Record', post_examination: 'Post-Examination Record', quality: 'Quality Control / Technical Record', support: 'Operational Record', other: 'Other Record' };
  const titleCase = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

  // Master-list "Category": the document type, qualified for section SOPs
  // (e.g. "SOP - Blood Bank") and normalised for template-type documents.
  function documentCategory(d: any): string {
    const type = String(d.document_type || '').trim();
    const t = type.toLowerCase();
    if (t === 'sop') return d.section_name ? `SOP - ${d.section_name}` : 'SOP';
    if (t === 'policy' || t === 'procedure') return 'Policy / Procedure';
    if (t === 'register' || t === 'log' || t === 'tracker') return 'Log / Register Template';
    if (t === 'master list') return 'Master List';
    return type || '—';
  }

  const person = (name?: string | null, position?: string | null) => (name ? (position ? `${name} (${position})` : name) : '');
  const yearsFromMonths = (m?: number | null) => (m == null || !isFinite(Number(m)) ? '' : (Number(m) % 12 === 0 ? String(Number(m) / 12) : (Number(m) / 12).toFixed(1)));
  const dateOnly = (v?: string | null) => (v ? String(v).slice(0, 10) : '');

  function facilityName(db: any): string {
    const p = db.prepare('SELECT facility_name FROM laboratory_profile WHERE id = 1').get() as any;
    return String(p?.facility_name || 'Laboratory').toUpperCase();
  }

  // The master list's own controlled document number (e.g. "SECHML00"), shown
  // in register titles when the master list is itself a registered document.
  function masterListCode(db: any): string {
    const row = db.prepare("SELECT document_code FROM documents WHERE document_code LIKE 'SECHML%' AND status != 'obsolete' ORDER BY document_code LIMIT 1").get() as any;
    return row?.document_code ? ` (${row.document_code})` : '';
  }

  // Documents joined with everything the master list needs: unit, current
  // version, author (name + position), technical reviewer and authoriser.
  function masterListDocuments(db: any): any[] {
    return db.prepare(`
      SELECT d.*, s.name AS section_name,
             v.version_number AS current_version_number, v.version_label AS current_version_label, v.effective_date AS current_effective_date,
             lv.version_number AS last_version_number, lv.effective_date AS last_effective_date,
             ow.full_name AS owner_name, owp.title AS owner_position,
             rv.full_name AS reviewer_name, ap.full_name AS approver_name
      FROM documents d
      LEFT JOIN sections s ON s.id = d.section_id
      LEFT JOIN document_versions v ON v.id = d.current_version_id
      LEFT JOIN document_versions lv ON lv.id = (SELECT id FROM document_versions WHERE document_id = d.id ORDER BY id DESC LIMIT 1)
      LEFT JOIN staff ow ON ow.id = d.owner_staff_id
      LEFT JOIN (SELECT spa.staff_id, MIN(p.title) AS title FROM staff_position_assignments spa JOIN positions p ON p.id = spa.position_id WHERE spa.is_active = 1 GROUP BY spa.staff_id) owp ON owp.staff_id = d.owner_staff_id
      LEFT JOIN staff rv ON rv.id = d.reviewed_by_staff_id
      LEFT JOIN staff ap ON ap.id = d.approved_by_staff_id
      ORDER BY d.document_code, d.id
    `).all();
  }

  function masterListRecords(db: any): any[] {
    return db.prepare(`
      SELECT rr.*, s.name AS section_name, st.full_name AS responsible_name,
             d.document_code AS linked_document_code, d.title AS linked_document_title,
             f.original_name AS file_name
      FROM record_register rr
      LEFT JOIN sections s ON s.id = rr.section_id
      LEFT JOIN staff st ON st.id = rr.responsible_staff_id
      LEFT JOIN documents d ON d.id = rr.linked_document_id
      LEFT JOIN files f ON f.id = rr.file_id
      ORDER BY rr.record_code, rr.id
    `).all();
  }

  function documentRegisterRows(db: any): unknown[][] {
    return masterListDocuments(db).filter(d => d.status !== 'obsolete').map((d, i) => [
      i + 1, d.document_code || '', documentCategory(d), d.section_name || 'General / QMS-wide', d.title,
      d.current_version_number || d.current_version_label || d.last_version_number || '', docStatusLabel(d.status),
      d.format_medium || (d.current_version_id ? 'Electronic (LIMS)' : ''),
      dateOnly(d.current_effective_date || d.last_effective_date), yearsFromMonths(d.review_frequency_months), dateOnly(d.next_review_date),
      person(d.owner_name, d.owner_position), d.reviewer_name || '', d.approver_name || '',
      d.controlled_locations || '', d.retention_period || '', d.remarks || '',
    ]);
  }

  function recordsRegisterRows(db: any): unknown[][] {
    return masterListRecords(db).map((r, i) => [
      i + 1, r.title, RECORD_CATEGORY_LABELS[r.record_category] || r.record_category || '',
      r.linked_document_code || (r.origin === 'system' ? `Generated in ${r.source_module || 'LIMS'}` : ''),
      r.storage_medium || RECORD_FORMAT_LABELS[r.record_format] || r.record_format || '',
      r.section_name || 'General / QMS-wide', r.storage_location || '',
      CONFIDENTIALITY_LABELS[r.confidentiality] || r.confidentiality || '', r.retention_period || '',
      r.disposal_method || '', titleCase(String(r.status || '')), r.notes || '',
    ]);
  }

  function obsoleteRegisterRows(db: any): unknown[][] {
    return masterListDocuments(db).filter(d => d.status === 'obsolete').map((d, i) => [
      i + 1, d.document_code || '', d.title, d.last_version_number || d.current_version_number || '',
      d.obsolete_reason || '', dateOnly(d.last_effective_date), dateOnly(d.withdrawn_at || d.updated_at),
      person(d.owner_name, d.owner_position), d.reviewer_name || '', d.approver_name || '',
      dateOnly(d.destroy_due_date), d.archive_location || '',
    ]);
  }

  // One register sheet in the master-list layout: merged facility title row,
  // two spacer rows, the header row, then the data.
  function registerSheet(title: string, headers: string[], rows: unknown[][]) {
    const ws = XLSX.utils.aoa_to_sheet([[title], [], [], headers, ...rows]);
    ws['!merges'] = [
      { s: { c: 0, r: 0 }, e: { c: headers.length - 1, r: 0 } },
      { s: { c: 0, r: 1 }, e: { c: headers.length - 1, r: 1 } },
    ];
    ws['!cols'] = headers.map(h => ({ wch: Math.max(14, Math.min(48, h.length + 10)) }));
    return ws;
  }

  function sendWorkbook(res: any, wb: XLSX.WorkBook, filename: string) {
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buf);
  }

  // Master list as JSON, for the on-screen Master List view.
  router.get('/masterlist', requirePermission('documents.masterlist', 'view'), (_req, res) => {
    const db = getDb();
    res.json({
      facility: facilityName(db),
      documentRegister: { headers: DOC_REGISTER_HEADERS, rows: documentRegisterRows(db) },
      recordsRegister: { headers: REC_REGISTER_HEADERS, rows: recordsRegisterRows(db) },
      obsoleteRegister: { headers: OBS_REGISTER_HEADERS, rows: obsoleteRegisterRows(db) },
    });
  });

  // Full master list workbook: all three registers as separate sheets.
  router.get('/masterlist/export', requirePermission('documents.masterlist', 'export'), (req, res) => {
    const db = getDb();
    const fac = facilityName(db);
    const code = masterListCode(db);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, registerSheet(`${fac} - LABORATORY DOCUMENT REGISTER${code}`, DOC_REGISTER_HEADERS, documentRegisterRows(db)), 'Document Register');
    XLSX.utils.book_append_sheet(wb, registerSheet(`${fac} - LABORATORY RECORDS REGISTER${code}`, REC_REGISTER_HEADERS, recordsRegisterRows(db)), 'Records Register');
    XLSX.utils.book_append_sheet(wb, registerSheet(`${fac} - OBSOLETE DOCUMENT REGISTER`, OBS_REGISTER_HEADERS, obsoleteRegisterRows(db)), 'Obsolete Document Register');
    audit(req, { action: 'export', entity: 'documents', entityId: 'masterlist', newValue: { export: 'Document_and_Records_Master_List.xlsx' } });
    sendWorkbook(res, wb, 'Document_and_Records_Master_List.xlsx');
  });

  router.get('/register/export', requirePermission('documents.library', 'export'), (req, res) => {
    const db = getDb();
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, registerSheet(`${facilityName(db)} - LABORATORY DOCUMENT REGISTER${masterListCode(db)}`, DOC_REGISTER_HEADERS, documentRegisterRows(db)), 'Document Register');
    audit(req, { action: 'export', entity: 'documents', entityId: 'document_register', newValue: { export: 'Document_Register.xlsx' } });
    sendWorkbook(res, wb, 'Document_Register.xlsx');
  });

  router.get('/records/register/export', requirePermission('documents.records', 'export'), (req, res) => {
    const db = getDb();
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, registerSheet(`${facilityName(db)} - LABORATORY RECORDS REGISTER${masterListCode(db)}`, REC_REGISTER_HEADERS, recordsRegisterRows(db)), 'Records Register');
    audit(req, { action: 'export', entity: 'record_register', entityId: 'records_register', newValue: { export: 'Records_Register.xlsx' } });
    sendWorkbook(res, wb, 'Records_Register.xlsx');
  });

  router.get('/obsolete-register/export', requirePermission('documents.masterlist', 'export'), (req, res) => {
    const db = getDb();
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, registerSheet(`${facilityName(db)} - OBSOLETE DOCUMENT REGISTER`, OBS_REGISTER_HEADERS, obsoleteRegisterRows(db)), 'Obsolete Document Register');
    audit(req, { action: 'export', entity: 'documents', entityId: 'obsolete_register', newValue: { export: 'Obsolete_Document_Register.xlsx' } });
    sendWorkbook(res, wb, 'Obsolete_Document_Register.xlsx');
  });

  // -------- Documents CRUD --------
  router.get('/', requirePermission('documents.library', 'view'), (req, res) => {
    const db = getDb();
    const filters: string[] = [];
    const params: unknown[] = [];
    if (req.query.status) { filters.push('d.status = ?'); params.push(String(req.query.status)); }
    if (req.query.documentType) { filters.push('d.document_type = ?'); params.push(String(req.query.documentType)); }
    if (req.query.sectionId) { filters.push('d.section_id = ?'); params.push(Number(req.query.sectionId)); }
    // Register-ready listing: each document carries its unit, current version
    // and the people on the master list (author / reviewer / authoriser).
    // COALESCE onto the latest version so documents whose current_version_id was
    // minted on another host (cloud sync) still show their real version/date.
    let query = `SELECT d.*, s.name AS section_name,
        COALESCE(v.version_number, lv.version_number) AS current_version_number,
        COALESCE(v.effective_date, lv.effective_date) AS current_effective_date,
        COALESCE(d.current_version_id, lv.id) AS resolved_version_id,
        ow.full_name AS owner_name, rv.full_name AS reviewer_name, ap.full_name AS approver_name,
        (SELECT COUNT(*) FROM document_attestations a WHERE a.document_id = d.id OR a.document_version_id IN (SELECT id FROM document_versions dv WHERE dv.document_id = d.id)) AS attestations_total,
        (SELECT COUNT(*) FROM document_attestations a WHERE (a.document_id = d.id OR a.document_version_id IN (SELECT id FROM document_versions dv WHERE dv.document_id = d.id)) AND a.status = 'signed') AS attestations_signed
      FROM documents d
      LEFT JOIN sections s ON s.id = d.section_id
      LEFT JOIN document_versions v ON v.id = d.current_version_id AND v.document_id = d.id
      LEFT JOIN document_versions lv ON lv.id = (SELECT MAX(id) FROM document_versions WHERE document_id = d.id)
      LEFT JOIN staff ow ON ow.id = d.owner_staff_id
      LEFT JOIN staff rv ON rv.id = d.reviewed_by_staff_id
      LEFT JOIN staff ap ON ap.id = d.approved_by_staff_id`;
    if (filters.length) query += ` WHERE ${filters.join(' AND ')}`;
    query += ' ORDER BY d.created_at DESC';
    res.json(db.prepare(query).all(...params));
  });

  router.post('/', requirePermission('documents.authoring', 'create'), (req, res) => {
    if (!req.body.title) return res.status(400).json({ error: 'title is required' });
    if (!req.body.documentType) return res.status(400).json({ error: 'documentType is required' });
    const db = getDb();
    // Document number: explicit code, else auto-generate per SECHPO026 §5.1.6.
    let documentCode: string = req.body.documentCode && String(req.body.documentCode).trim();
    if (!documentCode) documentCode = nextDocumentCode(db, req.body.documentType, req.body.sectionCategory);
    const existing = db.prepare('SELECT id FROM documents WHERE document_code = ?').get(documentCode);
    if (existing) return res.status(400).json({ error: `documentCode "${documentCode}" already exists` });
    const reviewFreq = parseIntNullable(req.body.reviewFrequencyMonths);
    const nextReview = req.body.nextReviewDate ?? (reviewFreq ? addMonths(new Date().toISOString(), reviewFreq) : null);
    const status = req.body.status ?? 'draft';
    if (!DOCUMENT_STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${DOCUMENT_STATUSES.join(', ')}` });
    const result = db.prepare(`INSERT INTO documents (document_code, title, document_type, section_category, department_id, section_id, owner_staff_id, owner_position_id, status, review_frequency_months, next_review_date, access_level, is_controlled, format_medium, controlled_locations, retention_period, remarks, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(documentCode, req.body.title, req.body.documentType, req.body.sectionCategory ?? null, parseIntNullable(req.body.departmentId), parseIntNullable(req.body.sectionId), parseIntNullable(req.body.ownerStaffId), parseIntNullable(req.body.ownerPositionId), status, reviewFreq, nextReview, req.body.accessLevel ?? 'internal', req.body.isControlled === false ? 0 : 1, req.body.formatMedium ?? null, req.body.controlledLocations ?? null, req.body.retentionPeriod ?? null, req.body.remarks ?? null, req.user!.id);
    const docId = Number(result.lastInsertRowid);

    if (parseIntNullable(req.body.fileId)) {
      const fileId = parseIntNullable(req.body.fileId)!;
      const versionNumber = req.body.versionNumber ?? '1.0';
      const versionResult = db.prepare(`INSERT INTO document_versions (document_id, version_label, version_number, file_id, revision_summary, status, prepared_by_staff_id, effective_date, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(docId, versionNumber, versionNumber, fileId, req.body.revisionSummary ?? 'Initial version', 'draft', getStaffIdOrCurrent(req, req.body.preparedByStaffId), req.body.effectiveDate ?? null, req.user!.id);
      const versionId = Number(versionResult.lastInsertRowid);
      db.prepare('UPDATE documents SET current_version_id = ? WHERE id = ?').run(versionId, docId);
      db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run('documents', 'documents', String(docId), 'documents', 'files', String(fileId), 'Initial document file');
      // Read the uploaded SOP so its full content is available in-app.
      extractIntoVersion(db, versionId, fileId);
      indexForDennis(db, docId, req.user!.id);
    }

    audit(req, { action: 'create', entity: 'documents', entityId: docId, newValue: { documentCode, ...req.body } });
    res.status(201).json({ id: docId, documentCode });
  });

  router.get('/:id', requirePermission('documents.library', 'view'), (req, res) => {
    const db = getDb();
    const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id) as any;
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    const versions = db.prepare('SELECT * FROM document_versions WHERE document_id = ? ORDER BY id DESC').all(req.params.id);
    const reviews = db.prepare('SELECT * FROM document_reviews WHERE document_id = ? ORDER BY review_date DESC, id DESC').all(req.params.id);
    const attestations = db.prepare('SELECT a.*, s.full_name AS staff_name FROM document_attestations a LEFT JOIN staff s ON s.id = a.staff_id WHERE a.document_id = ? OR a.document_version_id IN (SELECT id FROM document_versions WHERE document_id = ?) ORDER BY a.id DESC').all(req.params.id, req.params.id);
    const printLogs = db.prepare('SELECT pl.*, s.full_name AS printed_by_name FROM document_print_logs pl LEFT JOIN staff s ON s.id = pl.printed_by_staff_id WHERE pl.document_id = ? ORDER BY pl.print_date DESC, pl.id DESC').all(req.params.id);
    const distribution = db.prepare('SELECT * FROM document_distribution WHERE document_id = ? ORDER BY id DESC').all(req.params.id);
    const links = db.prepare('SELECT * FROM record_links WHERE (source_module_key = ? AND source_record_type = ? AND source_record_id = ?) OR (target_module_key = ? AND target_record_type = ? AND target_record_id = ?)').all('documents', 'documents', String(req.params.id), 'documents', 'documents', String(req.params.id));
    res.json({ ...doc, versions, reviews, attestations, printLogs, distribution, links });
  });

  router.put('/:id', requirePermission('documents.authoring', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id) as any;
    if (!oldValue) return res.status(404).json({ error: 'Document not found' });
    if (req.body.status && !DOCUMENT_STATUSES.includes(req.body.status)) return res.status(400).json({ error: `status must be one of: ${DOCUMENT_STATUSES.join(', ')}` });
    // Document number can be corrected/updated, with a uniqueness guard.
    let documentCode = oldValue.document_code;
    if (req.body.documentCode !== undefined && String(req.body.documentCode).trim() !== (oldValue.document_code ?? '')) {
      documentCode = String(req.body.documentCode).trim() || null;
      if (documentCode) {
        const clash = db.prepare('SELECT id FROM documents WHERE document_code = ? AND id != ?').get(documentCode, req.params.id);
        if (clash) return res.status(400).json({ error: `documentCode "${documentCode}" already exists` });
      }
    }
    db.prepare(`UPDATE documents SET document_code = ?, title = ?, document_type = ?, section_category = ?, department_id = ?, section_id = ?, owner_staff_id = ?, owner_position_id = ?, status = ?, review_frequency_months = ?, next_review_date = ?, access_level = ?, is_controlled = ?, format_medium = ?, controlled_locations = ?, retention_period = ?, remarks = ?, destroy_due_date = ?, archive_location = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(documentCode, req.body.title ?? oldValue.title, req.body.documentType ?? oldValue.document_type, req.body.sectionCategory ?? oldValue.section_category, parseIntNullable(req.body.departmentId) ?? oldValue.department_id, parseIntNullable(req.body.sectionId) ?? oldValue.section_id, parseIntNullable(req.body.ownerStaffId) ?? oldValue.owner_staff_id, parseIntNullable(req.body.ownerPositionId) ?? oldValue.owner_position_id, req.body.status ?? oldValue.status, parseIntNullable(req.body.reviewFrequencyMonths) ?? oldValue.review_frequency_months, req.body.nextReviewDate ?? oldValue.next_review_date, req.body.accessLevel ?? oldValue.access_level, req.body.isControlled !== undefined ? (req.body.isControlled ? 1 : 0) : oldValue.is_controlled, req.body.formatMedium ?? oldValue.format_medium, req.body.controlledLocations ?? oldValue.controlled_locations, req.body.retentionPeriod ?? oldValue.retention_period, req.body.remarks ?? oldValue.remarks, req.body.destroyDueDate ?? oldValue.destroy_due_date, req.body.archiveLocation ?? oldValue.archive_location, req.params.id);
    audit(req, { action: 'edit', entity: 'documents', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  // Transfer document ownership. Gated on the documents "approve" authority
  // (administrators / laboratory management), audited, and both the outgoing and
  // incoming owners are notified. SECHPO026 — the document owner is accountable
  // for keeping it current, so a change of owner is a controlled action.
  router.post('/:id/transfer-ownership', requirePermission('documents.workflow', 'approve'), (req, res) => {
    const db = getDb();
    const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id) as any;
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    const newOwnerId = parseIntNullable(req.body.ownerStaffId);
    if (!newOwnerId) return res.status(400).json({ error: 'ownerStaffId is required' });
    const newOwner = db.prepare('SELECT id, full_name FROM staff WHERE id = ?').get(newOwnerId) as { id: number; full_name: string } | undefined;
    if (!newOwner) return res.status(404).json({ error: 'Staff member not found' });
    const oldOwnerId = doc.owner_staff_id as number | null;
    if (oldOwnerId === newOwnerId) return res.status(400).json({ error: 'This staff member already owns the document.' });
    db.prepare('UPDATE documents SET owner_staff_id = ?, owner_position_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(newOwnerId, parseIntNullable(req.body.ownerPositionId) ?? doc.owner_position_id, req.params.id);
    const label = `${doc.document_code ? doc.document_code + ' — ' : ''}${doc.title}`;
    const note = req.body.note ? ` Note: ${String(req.body.note).slice(0, 300)}` : '';
    notifyStaff(db, newOwnerId, 'documents', 'Document ownership assigned to you',
      `You are now the owner/author of ${label}. You are responsible for keeping it current and presenting it for review.${note}`,
      { recordType: 'documents', recordId: doc.id, actionUrl: `/documents?focus=documents:${doc.id}`, actionLabel: 'Open document' });
    if (oldOwnerId) notifyStaff(db, oldOwnerId, 'documents', 'Document ownership transferred',
      `Ownership of ${label} has been transferred to ${newOwner.full_name}.${note}`,
      { recordType: 'documents', recordId: doc.id, notificationType: 'info', severity: 'low' });
    audit(req, { action: 'transfer_ownership', entity: 'documents', entityId: req.params.id, oldValue: { ownerStaffId: oldOwnerId }, newValue: { ownerStaffId: newOwnerId, note: req.body.note ?? null } });
    res.json({ ok: true, ownerStaffId: newOwnerId, ownerName: newOwner.full_name });
  });

  router.post('/:id/versions', requirePermission('documents.authoring', 'create'), (req, res) => {
    if (!req.body.versionNumber) return res.status(400).json({ error: 'versionNumber is required' });
    const db = getDb();
    const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id) as any;
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    const status = req.body.status ?? 'draft';
    if (!VERSION_STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${VERSION_STATUSES.join(', ')}` });
    const result = db.prepare(`INSERT INTO document_versions (document_id, version_label, version_number, file_id, revision_summary, status, prepared_by_staff_id, effective_date, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(req.params.id, req.body.versionNumber, req.body.versionNumber, parseIntNullable(req.body.fileId), req.body.revisionSummary ?? null, status, getStaffIdOrCurrent(req, req.body.preparedByStaffId), req.body.effectiveDate ?? null, req.user!.id);
    const versionId = Number(result.lastInsertRowid);
    if (parseIntNullable(req.body.fileId)) {
      db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run('documents', 'document_versions', String(versionId), 'documents', 'files', String(req.body.fileId), `Document version ${req.body.versionNumber}`);
      extractIntoVersion(db, versionId, parseIntNullable(req.body.fileId)!);
      indexForDennis(db, Number(req.params.id), req.user!.id);
    }
    // Used by the "Open in Microsoft Office" auto-sync: without this the synced
    // version exists in the history but the document keeps pointing at the old
    // version, so the edits appear to vanish when the viewer is reopened.
    if (req.body.makeCurrent === true) {
      db.prepare('UPDATE documents SET current_version_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(versionId, req.params.id);
    }
    audit(req, { action: 'create', entity: 'document_versions', entityId: versionId, newValue: { documentId: req.params.id, ...req.body } });
    res.status(201).json({ id: versionId });
  });

  // -------- In-app document content (read / edit the SOP body) --------
  router.get('/:id/versions/:versionId/content', requirePermission('documents.library', 'view'), (req, res) => {
    const db = getDb();
    const versionId = resolveVersionId(db, req.params.id, req.params.versionId);
    if (!versionId) return res.status(404).json({ error: 'This document has no version on this host yet. Add a version (upload its file) to view it.' });
    const v = db.prepare(`SELECT v.id, v.document_id, v.version_number, v.version_label, v.status, v.file_id, v.content_text, v.content_html, v.content_sections, v.extraction_method, v.page_count, v.extracted_at, v.content_updated_at, v.content_updated_by,
      f.original_name AS file_name, f.mime_type AS file_mime, f.size_bytes AS file_size, cu.full_name AS content_updated_by_name
      FROM document_versions v LEFT JOIN files f ON f.id = v.file_id LEFT JOIN staff cu ON cu.id = v.content_updated_by WHERE v.id = ?`).get(versionId) as any;
    if (!v) return res.status(404).json({ error: 'Version not found' });
    let sections: unknown = [];
    try { sections = v.content_sections ? JSON.parse(v.content_sections) : []; } catch { sections = []; }
    res.json({ ...v, content_sections: sections });
  });
  // Re-read the attached file and refresh the extracted content.
  router.post('/:id/versions/:versionId/re-extract', requirePermission('documents.authoring', 'edit'), (req, res) => {
    const db = getDb();
    const versionId = resolveVersionId(db, req.params.id, req.params.versionId);
    const v = versionId ? db.prepare('SELECT * FROM document_versions WHERE id = ?').get(versionId) as any : null;
    if (!v) return res.status(404).json({ error: 'Version not found' });
    if (!v.file_id) return res.status(400).json({ error: 'This version has no attached file to read.' });
    const result = extractIntoVersion(db, Number(v.id), Number(v.file_id));
    indexForDennis(db, Number(req.params.id), req.user!.id);
    audit(req, { action: 'extract', entity: 'document_versions', entityId: v.id, newValue: { method: result?.method, length: result?.text?.length ?? 0 } });
    res.json({ ok: true, method: result?.method ?? 'none', length: result?.text?.length ?? 0, sections: result?.sections?.length ?? 0 });
  });
  // Save an edited document body (controlled content authored inside SECH_LIMS).
  router.put('/:id/versions/:versionId/content', requirePermission('documents.authoring', 'edit'), (req, res) => {
    const db = getDb();
    const versionId = resolveVersionId(db, req.params.id, req.params.versionId);
    const v = versionId ? db.prepare('SELECT * FROM document_versions WHERE id = ?').get(versionId) as any : null;
    if (!v) return res.status(404).json({ error: 'Version not found' });
    const staffId = getStaffIdOrCurrent(req, req.body.editedByStaffId);
    const sections = req.body.contentSections !== undefined ? JSON.stringify(req.body.contentSections) : v.content_sections;
    db.prepare('UPDATE document_versions SET content_html = ?, content_text = ?, content_sections = ?, content_updated_by = ?, content_updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(req.body.contentHtml ?? v.content_html, req.body.contentText ?? v.content_text, sections, staffId, v.id);
    audit(req, { action: 'edit_content', entity: 'document_versions', entityId: v.id, newValue: { length: (req.body.contentHtml ?? '').length } });
    res.json({ ok: true });
  });

  // -------- Export the in-app content back out as a real, openable .docx --------
  // Builds a Word file from the version's content_html (using documentBuild.ts —
  // the reverse of documentExtract.ts) and registers it in the files table, so the
  // existing /files/:id/download endpoint serves it. Two flows:
  //   - export-docx: a one-off download, doesn't touch the document's history.
  //   - export-docx/save-as-version: the export becomes the document's newest
  //     version (so edits made in-app round-trip into the official record as a
  //     real Word file, not just trapped HTML).
  router.post('/:id/versions/:versionId/export-docx', requirePermission('documents.library', 'view'), async (req, res) => {
    const db = getDb();
    const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id) as any;
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    const resolvedId = resolveVersionId(db, req.params.id, req.params.versionId);
    const v = resolvedId ? db.prepare('SELECT * FROM document_versions WHERE id = ?').get(resolvedId) as any : null;
    if (!v) return res.status(404).json({ error: 'Version not found' });
    if (!v.content_html || !v.content_html.trim()) return res.status(400).json({ error: 'This version has no in-app content to export. Use "Edit content" or "Re-read from file" first.' });
    const title = `${doc.document_code ? doc.document_code + ' - ' : ''}${doc.title}`;
    const originalName = `${title}.docx`.replace(/[\\/:*?"<>|]/g, '_');
    const storedName = safeStoredFilename(originalName);
    const fullPath = path.join(uploadRoot, storedName);
    try {
      const built = await buildDocxFromHtml(fullPath, v.content_html, title);
      const stat = fs.statSync(fullPath);
      const fileResult = db.prepare('INSERT INTO files (original_name, stored_name, mime_type, size_bytes, storage_area, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)')
        .run(originalName, storedName, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', stat.size, 'uploads', req.user!.id);
      const fileId = Number(fileResult.lastInsertRowid);
      audit(req, { action: 'export_docx', entity: 'document_versions', entityId: v.id, newValue: { fileId, mediaCount: built.mediaCount, linkCount: built.linkCount } });
      res.status(201).json({ fileId, originalName, downloadPath: `/files/${fileId}/download` });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? `Could not build the Word file: ${err.message}` : 'Could not build the Word file.' });
    }
  });

  router.post('/:id/versions/:versionId/export-docx/save-as-version', requirePermission('documents.authoring', 'edit'), async (req, res) => {
    const db = getDb();
    const body = req.body || {};
    const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id) as any;
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    const resolvedId = resolveVersionId(db, req.params.id, req.params.versionId);
    const v = resolvedId ? db.prepare('SELECT * FROM document_versions WHERE id = ?').get(resolvedId) as any : null;
    if (!v) return res.status(404).json({ error: 'Version not found' });
    if (!v.content_html || !v.content_html.trim()) return res.status(400).json({ error: 'This version has no in-app content to export. Use "Edit content" or "Re-read from file" first.' });
    const title = `${doc.document_code ? doc.document_code + ' - ' : ''}${doc.title}`;
    const originalName = `${title}.docx`.replace(/[\\/:*?"<>|]/g, '_');
    const storedName = safeStoredFilename(originalName);
    const fullPath = path.join(uploadRoot, storedName);
    try {
      await buildDocxFromHtml(fullPath, v.content_html, title);
      const stat = fs.statSync(fullPath);
      const fileResult = db.prepare('INSERT INTO files (original_name, stored_name, mime_type, size_bytes, storage_area, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)')
        .run(originalName, storedName, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', stat.size, 'uploads', req.user!.id);
      const fileId = Number(fileResult.lastInsertRowid);
      const nextVersionNumber = `${v.version_number || '1.0'}-word`;
      const versionResult = db.prepare(`INSERT INTO document_versions (document_id, version_label, version_number, file_id, revision_summary, status, prepared_by_staff_id, content_html, content_text, content_sections, extraction_method, content_updated_by, content_updated_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)`)
        .run(req.params.id, nextVersionNumber, nextVersionNumber, fileId, 'Saved from in-app edits as a Word file', 'draft', getStaffIdOrCurrent(req, body.preparedByStaffId), v.content_html, v.content_text, v.content_sections, 'in-app-export', getStaffIdOrCurrent(req, null), req.user!.id);
      const newVersionId = Number(versionResult.lastInsertRowid);
      db.prepare('UPDATE documents SET current_version_id = ? WHERE id = ?').run(newVersionId, req.params.id);
      db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run('documents', 'document_versions', String(newVersionId), 'documents', 'files', String(fileId), 'Word export of in-app edits');
      indexForDennis(db, Number(req.params.id), req.user!.id);
      audit(req, { action: 'export_docx_save_version', entity: 'document_versions', entityId: newVersionId, newValue: { fileId, sourceVersionId: v.id } });
      res.status(201).json({ id: newVersionId, fileId, originalName });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? `Could not save as a new Word version: ${err.message}` : 'Could not save as a new Word version.' });
    }
  });

  // -------- Workflow comments (drafter / reviewer / approver) --------
  router.get('/:id/comments', requirePermission('documents.library', 'view'), (req, res) => {
    const db = getDb();
    res.json(db.prepare(`SELECT c.*, s.full_name AS author_name FROM document_comments c LEFT JOIN staff s ON s.id = c.author_staff_id WHERE c.document_id = ? ORDER BY c.id DESC`).all(req.params.id));
  });
  router.post('/:id/comments', requirePermission('documents.library', 'view'), (req, res) => {
    if (!req.body.comment || !String(req.body.comment).trim()) return res.status(400).json({ error: 'comment is required' });
    const db = getDb();
    const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id) as any;
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    const author = getStaffIdOrCurrent(req, req.body.authorStaffId);
    const r = db.prepare('INSERT INTO document_comments (document_id, document_version_id, stage, comment, author_staff_id, created_by) VALUES (?, ?, ?, ?, ?, ?)')
      .run(req.params.id, parseIntNullable(req.body.documentVersionId) ?? doc.current_version_id, req.body.stage ?? doc.status, String(req.body.comment).trim(), author, req.user!.id);
    // Notify the document owner of new review/approval feedback.
    if (doc.owner_staff_id && doc.owner_staff_id !== author) notifyStaff(db, doc.owner_staff_id, 'documents', 'New comment on document', `${doc.document_code ? doc.document_code + ' — ' : ''}${doc.title}: ${String(req.body.comment).slice(0, 120)}`);
    audit(req, { action: 'comment', entity: 'documents', entityId: req.params.id, newValue: { commentId: r.lastInsertRowid, stage: req.body.stage } });
    res.status(201).json({ id: r.lastInsertRowid });
  });

  // Distribute the current version to all active staff for attestation (ISO
  // 15189 §8.3 — staff must read and acknowledge controlled documents).
  router.post('/:id/distribute-all', requirePermission('documents.workflow', 'edit'), (req, res) => {
    const db = getDb();
    const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id) as any;
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    const versionId = resolveVersionId(db, doc.id, req.body.versionId);
    if (!versionId) return res.status(400).json({ error: 'No current version to distribute. Approve a version first.' });
    const assignedBy = getStaffIdOrCurrent(req, req.body.assignedByStaffId);
    const assigned = distributeToStaff(db, doc, versionId, activeStaffIds(db), assignedBy, req.user!.id, req.body.dueDate ?? null);
    audit(req, { action: 'distribute_all', entity: 'documents', entityId: doc.id, newValue: { versionId, assigned: assigned.length } });
    res.status(201).json({ ok: true, assigned: assigned.length });
  });

  router.post('/:id/submit-review', requirePermission('documents.workflow', 'edit'), (req, res) => {
    const db = getDb();
    const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id) as any;
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    db.prepare("UPDATE documents SET status = 'under_review', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
    if (parseIntNullable(req.body.versionId)) {
      db.prepare("UPDATE document_versions SET status = 'under_review' WHERE id = ?").run(req.body.versionId);
    }
    audit(req, { action: 'submit_review', entity: 'documents', entityId: req.params.id, oldValue: { status: doc.status }, newValue: { status: 'under_review' } });
    res.json({ ok: true });
  });

  router.post('/:id/review', requirePermission('documents.workflow', 'edit'), (req, res) => {
    if (!req.body.reviewOutcome) return res.status(400).json({ error: 'reviewOutcome is required' });
    if (!REVIEW_OUTCOMES.includes(req.body.reviewOutcome)) return res.status(400).json({ error: `reviewOutcome must be one of: ${REVIEW_OUTCOMES.join(', ')}` });
    if (!req.body.reviewDate) return res.status(400).json({ error: 'reviewDate is required' });
    const db = getDb();
    const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id) as any;
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    const reviewedBy = getStaffIdOrCurrent(req, req.body.reviewedByStaffId);
    if (reviewedBy === null) return res.status(400).json({ error: 'This action requires the logged-in user to be linked to a staff record.' });
    const nextReview = req.body.nextReviewDate ?? (req.body.reviewOutcome === 'no_change' && doc.review_frequency_months ? addMonths(req.body.reviewDate, doc.review_frequency_months) : null);
    const reviewNumber = generateRecordNumber(db, 'document_reviews', 'DOCREV', new Date().toISOString());
    const result = db.prepare(`INSERT INTO document_reviews (review_number, document_id, document_version_id, review_date, review_outcome, review_notes, next_review_date, reviewed_by_staff_id, action_required, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(reviewNumber, req.params.id, parseIntNullable(req.body.documentVersionId) ?? doc.current_version_id, req.body.reviewDate, req.body.reviewOutcome, req.body.reviewNotes ?? null, nextReview, reviewedBy, req.body.actionRequired ? 1 : 0, req.user!.id);
    const reviewId = Number(result.lastInsertRowid);
    if (nextReview) db.prepare('UPDATE documents SET next_review_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(nextReview, req.params.id);
    // Advance the lifecycle: a recorded review marks the document as reviewed and
    // ready for approval (SECHPO026 §5.3.6 — reviewed by technical staff/QM,
    // then approved by the Laboratory Director). An 'obsolete' outcome does not.
    if (req.body.reviewOutcome !== 'obsolete' && ['draft', 'under_review'].includes(doc.status)) {
      db.prepare("UPDATE documents SET status = 'reviewed', reviewed_by_staff_id = ?, reviewed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(reviewedBy, req.params.id);
      if (doc.current_version_id) db.prepare("UPDATE document_versions SET status = 'reviewed', reviewed_by_staff_id = ?, review_date = ? WHERE id = ? AND status IN ('draft','under_review')").run(reviewedBy, req.body.reviewDate, doc.current_version_id);
      const owners = db.prepare('SELECT owner_staff_id FROM documents WHERE id = ?').get(req.params.id) as any;
      notifyStaff(db, owners?.owner_staff_id ?? null, 'documents', 'Document reviewed', `${doc.document_code ? doc.document_code + ' — ' : ''}${doc.title} has been reviewed and is awaiting approval.`);
    }
    audit(req, { action: 'review', entity: 'documents', entityId: req.params.id, newValue: { reviewId, reviewNumber, ...req.body } });
    res.status(201).json({ id: reviewId, reviewNumber });
  });

  router.post('/:id/approve', requirePermission('documents.workflow', 'approve'), (req, res) => {
    const db = getDb();
    const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id) as any;
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    const approvedBy = getStaffIdOrCurrent(req, req.body.approvedByStaffId);
    if (approvedBy === null) return res.status(400).json({ error: 'This action requires the logged-in user to be linked to a staff record.' });
    const versionId = resolveVersionId(db, doc.id, req.body.versionId);
    if (!versionId) return res.status(400).json({ error: 'No version available to approve. Add a version first.' });
    const previousCurrent = db.prepare("SELECT id FROM document_versions WHERE document_id = ? AND status = 'current' AND id != ?").all(req.params.id, versionId) as Array<{ id: number }>;
    for (const v of previousCurrent) {
      db.prepare("UPDATE document_versions SET status = 'obsolete', obsolete_date = CURRENT_TIMESTAMP WHERE id = ?").run(v.id);
    }
    db.prepare("UPDATE document_versions SET status = 'current', approved_by_staff_id = ?, approved_at = CURRENT_TIMESTAMP, effective_date = COALESCE(?, effective_date) WHERE id = ?").run(approvedBy, req.body.effectiveDate ?? null, versionId);
    db.prepare("UPDATE documents SET status = 'current', current_version_id = ?, approved_by_staff_id = ?, approved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(versionId, approvedBy, req.params.id);

    // On issue, distribute the controlled document to all active staff for
    // attestation and notify them — unless the caller opts out. This is what
    // makes a newly issued document appear in every staff member's inbox,
    // notifications and dashboard for reading and sign-off.
    let distributed = 0;
    if (req.body.distribute !== false) {
      const freshDoc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id) as any;
      distributed = distributeToStaff(db, freshDoc, versionId, activeStaffIds(db), approvedBy, req.user!.id, req.body.attestationDueDate ?? null).length;
    }
    audit(req, { action: 'approve', entity: 'documents', entityId: req.params.id, oldValue: { status: doc.status, currentVersionId: doc.current_version_id }, newValue: { versionId, status: 'current', approvedByStaffId: approvedBy, distributed } });
    res.json({ ok: true, versionId, distributed });
  });

  router.post('/:id/mark-obsolete', requirePermission('documents.workflow', 'approve'), (req, res) => {
    if (!req.body.obsoleteReason) return res.status(400).json({ error: 'obsoleteReason is required' });
    const db = getDb();
    const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id) as any;
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    db.prepare("UPDATE documents SET status = 'obsolete', obsolete_reason = ?, withdrawn_at = COALESCE(?, date('now')), destroy_due_date = COALESCE(?, destroy_due_date), archive_location = COALESCE(?, archive_location), updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(req.body.obsoleteReason, req.body.withdrawnDate ?? null, req.body.destroyDueDate ?? null, req.body.archiveLocation ?? null, req.params.id);
    db.prepare("UPDATE document_versions SET status = 'obsolete', obsolete_date = CURRENT_TIMESTAMP, obsolete_reason = COALESCE(obsolete_reason, ?) WHERE document_id = ?").run(req.body.obsoleteReason, req.params.id);
    audit(req, { action: 'mark_obsolete', entity: 'documents', entityId: req.params.id, oldValue: { status: doc.status }, newValue: { status: 'obsolete', obsoleteReason: req.body.obsoleteReason } });
    res.json({ ok: true });
  });

  // Permanently remove MANY documents at once — an administrator-only recovery
  // tool for clearing out mistaken or broken imports (e.g. documents that
  // replicated from another host without their files). Registered before the
  // single-delete route. Gated on documents "approve" AND System Administrator.
  // For an ISO-compliant retire that keeps history, use "mark obsolete" instead.
  router.post('/bulk-delete', requirePermission('documents.workflow', 'approve'), (req, res) => {
    if (!isAdminUser(req)) return res.status(403).json({ error: 'Only a System Administrator can permanently delete documents.' });
    const db = getDb();
    const ids: number[] = Array.isArray(req.body?.ids) ? req.body.ids.map((n: unknown) => Number(n)).filter((n: number) => Number.isFinite(n)) : [];
    if (!ids.length) return res.status(400).json({ error: 'Provide an array of document ids to delete.' });
    if (ids.length > 500) return res.status(400).json({ error: 'Too many documents in one request (max 500).' });
    const results: Array<{ id: number; ok: boolean; error?: string; documentCode?: string; title?: string }> = [];
    for (const docId of ids) {
      const doc = db.prepare('SELECT id, document_code, title, status FROM documents WHERE id = ?').get(docId) as any;
      if (!doc) { results.push({ id: docId, ok: false, error: 'Not found' }); continue; }
      try {
        deleteDocumentCascade(db, docId);
        audit(req, { action: 'delete', entity: 'documents', entityId: docId, oldValue: { documentCode: doc.document_code, title: doc.title, status: doc.status, bulk: true } });
        results.push({ id: docId, ok: true, documentCode: doc.document_code, title: doc.title });
      } catch (err) {
        results.push({ id: docId, ok: false, error: err instanceof Error ? err.message : 'Failed to delete' });
      }
    }
    const deleted = results.filter(r => r.ok).length;
    res.json({ ok: true, deleted, failed: results.length - deleted, results });
  });

  // Permanently remove a single document from the system. Administrator-only and
  // audited. It deletes the document, all its versions and their owned records
  // (attestations, comments, distribution, print logs, reviews), removes the AI
  // index and record links, and deletes the underlying files from disk when they
  // are not referenced elsewhere. Incidental links to the document from other
  // business records are detached (set to NULL) so those records survive without
  // a dangling reference. For an ISO-compliant retire that keeps history, use
  // "mark obsolete" instead.
  router.delete('/:id', requirePermission('documents.workflow', 'approve'), (req, res) => {
    if (!isAdminUser(req)) return res.status(403).json({ error: 'Only a System Administrator can permanently delete documents.' });
    const db = getDb();
    const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id) as any;
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    const docId = Number(req.params.id);
    try { deleteDocumentCascade(db, docId); }
    catch (err) { return res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to delete document' }); }
    audit(req, { action: 'delete', entity: 'documents', entityId: docId, oldValue: { documentCode: doc.document_code, title: doc.title, status: doc.status } });
    res.json({ ok: true });
  });

  router.post('/:id/assign-attestation', requirePermission('documents.workflow', 'edit'), (req, res) => {
    const db = getDb();
    const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id) as any;
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    const versionId = resolveVersionId(db, doc.id, req.body.documentVersionId);
    if (!versionId) return res.status(400).json({ error: 'document has no version to attest to' });
    const targetStaffIds: number[] = Array.isArray(req.body.staffIds) ? req.body.staffIds.map((n: unknown) => Number(n)).filter((n: number) => isFinite(n)) : [];
    const targetType = req.body.targetType ?? (targetStaffIds.length ? 'staff' : null);
    if (!targetType || !DISTRIBUTION_TARGETS.includes(targetType)) return res.status(400).json({ error: `targetType must be one of: ${DISTRIBUTION_TARGETS.join(', ')}` });
    const assignedBy = getStaffIdOrCurrent(req, req.body.assignedByStaffId);

    let resolvedStaffIds: number[] = targetStaffIds;
    if (targetType === 'position' && parseIntNullable(req.body.positionId)) {
      const rows = db.prepare('SELECT staff_id FROM staff_position_assignments WHERE position_id = ? AND is_active = 1').all(parseIntNullable(req.body.positionId)) as Array<{ staff_id: number }>;
      resolvedStaffIds = rows.map(r => r.staff_id);
    } else if (targetType === 'section' && parseIntNullable(req.body.sectionId)) {
      const rows = db.prepare('SELECT id FROM staff WHERE section_id = ? AND is_active = 1').all(parseIntNullable(req.body.sectionId)) as Array<{ id: number }>;
      resolvedStaffIds = rows.map(r => r.id);
    } else if (targetType === 'department' && parseIntNullable(req.body.departmentId)) {
      const rows = db.prepare('SELECT s.id FROM staff s JOIN sections sec ON sec.id = s.section_id WHERE sec.department_id = ? AND s.is_active = 1').all(parseIntNullable(req.body.departmentId)) as Array<{ id: number }>;
      resolvedStaffIds = rows.map(r => r.id);
    }
    if (!resolvedStaffIds.length) return res.status(400).json({ error: 'No staff resolved for the target.' });

    const dueDate = req.body.dueDate ?? null;
    const created: number[] = [];
    const notifiedStaffIds: number[] = [];
    const tx = db.transaction(() => {
      for (const staffId of resolvedStaffIds) {
        const existing = db.prepare("SELECT id FROM document_attestations WHERE document_version_id = ? AND staff_id = ? AND status IN ('pending','overdue')").get(versionId, staffId);
        if (existing) continue;
        const r = db.prepare(`INSERT INTO document_attestations (document_id, document_version_id, staff_id, assigned_by_staff_id, assigned_at, due_date, status, notes) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, ?, 'pending', ?)`)
          .run(req.params.id, versionId, staffId, assignedBy, dueDate, req.body.notes ?? null);
        const attId = Number(r.lastInsertRowid);
        db.prepare('INSERT INTO document_distribution (document_id, document_version_id, target_type, target_staff_id, assigned_by_staff_id, due_date, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(req.params.id, versionId, 'staff', staffId, assignedBy, dueDate, 'pending', req.user!.id);
        db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run('documents', 'documents', String(req.params.id), 'documents', 'document_attestations', String(attId), 'Attestation assignment');
        created.push(attId);
        notifiedStaffIds.push(staffId);
      }
    });
    tx();
    const msg = `Please review and sign: ${doc.document_code ? doc.document_code + ' — ' : ''}${doc.title}${dueDate ? ` (due ${dueDate})` : ''}`;
    for (const sId of notifiedStaffIds) {
      const att = db.prepare('SELECT id FROM document_attestations WHERE document_version_id = ? AND staff_id = ?').get(versionId, sId) as { id: number } | undefined;
      notifyStaff(db, sId, 'documents', 'Attestation assigned', msg, {
        recordType: 'document_attestations', recordId: att?.id, dueDate,
        actionUrl: `/documents?open=${req.params.id}&attest=${att?.id ?? ''}`,
        actionLabel: 'Read & attest',
        notificationType: 'follow_up',
        severity: 'medium',
      });
    }
    audit(req, { action: 'assign_attestation', entity: 'documents', entityId: req.params.id, newValue: { versionId, targetType, staffCount: created.length, dueDate } });
    res.status(201).json({ ok: true, assigned: created.length, attestationIds: created });
  });

  router.get('/:id/attestations', requirePermission('documents.library', 'view'), (req, res) => {
    const db = getDb();
    res.json(db.prepare('SELECT a.*, s.full_name AS staff_name, v.version_number FROM document_attestations a LEFT JOIN staff s ON s.id = a.staff_id LEFT JOIN document_versions v ON v.id = a.document_version_id WHERE a.document_id = ? OR a.document_version_id IN (SELECT id FROM document_versions WHERE document_id = ?) ORDER BY a.id DESC').all(req.params.id, req.params.id));
  });

  // Sign an attestation. Signatures are strictly bound to the AUTHENTICATED user
  // — a staff member may NEVER sign an attestation on behalf of another. Any
  // `staffId` sent in the body is ignored; the signer is always the current user.
  router.post('/:id/attest', requirePermission('documents.library', 'view'), (req, res) => {
    const db = getDb();
    const attestationId = parseIntNullable(req.body.attestationId);
    // Signer is always the caller — never accept a body-provided staff id.
    const staffId = getCurrentStaffId(req);
    if (staffId === null) return res.status(400).json({ error: 'Your login is not linked to a staff record; personal attestations cannot be signed. Ask an administrator to link your account to your staff record.' });
    let attestation: any;
    if (attestationId) {
      attestation = db.prepare('SELECT * FROM document_attestations WHERE id = ?').get(attestationId);
      // Enforce ownership: refuse to sign an attestation assigned to someone else.
      if (attestation && Number(attestation.staff_id) !== Number(staffId)) {
        return res.status(403).json({ error: 'You can only sign your own attestation. Attestations must be signed personally by each staff member — you may not sign for another person.' });
      }
    } else {
      // No attestation id → resolve the caller's own pending attestation for this document.
      attestation = db.prepare("SELECT * FROM document_attestations WHERE (document_id = ? OR document_version_id IN (SELECT id FROM document_versions WHERE document_id = ?)) AND staff_id = ? AND status IN ('pending','overdue') ORDER BY id DESC LIMIT 1").get(req.params.id, req.params.id, staffId);
    }
    if (!attestation) return res.status(404).json({ error: 'No pending attestation was found for you on this document.' });
    if (attestation.status === 'signed') return res.status(400).json({ error: 'This attestation has already been signed.' });
    // Apply the signer's signature on file (uploaded once, reused everywhere).
    const onFile = db.prepare('SELECT signature_file_id FROM staff WHERE id = ?').get(staffId) as { signature_file_id?: number | null } | undefined;
    const signatureFileId = parseIntNullable(req.body.signatureFileId) ?? onFile?.signature_file_id ?? null;
    db.prepare("UPDATE document_attestations SET status = 'signed', attested_at = CURRENT_TIMESTAMP, signed_by_user_id = ?, signature_file_id = ?, notes = COALESCE(?, notes) WHERE id = ?")
      .run(req.user!.id, signatureFileId, req.body.notes ?? null, attestation.id);
    // Also record it in the unified electronic-signature trail.
    try { recordSignature(req, { moduleKey: 'documents', recordType: 'document_attestations', recordId: attestation.id, purpose: 'document_acknowledgement', meaning: 'Acknowledged controlled document' }); } catch { /* trail is best-effort */ }
    db.prepare("UPDATE document_distribution SET status = 'completed' WHERE document_id = ? AND target_staff_id = ? AND status = 'pending'").run(req.params.id, staffId);
    // Auto-resolve the "sign this document" notifications for the caller so the
    // inbox and dashboard clear the moment the required action is completed.
    db.prepare("UPDATE notifications SET status = 'resolved', resolved_at = CURRENT_TIMESTAMP, resolved_by_staff_id = ? WHERE assigned_to_staff_id = ? AND module_key = 'documents' AND record_type = 'document_attestations' AND record_id = ? AND status NOT IN ('resolved','dismissed')").run(staffId, staffId, String(attestation.id));
    audit(req, { action: 'attest_sign', entity: 'document_attestations', entityId: attestation.id, oldValue: { status: attestation.status }, newValue: { status: 'signed', staffId } });
    res.json({ ok: true, attestationId: attestation.id });
  });

  router.post('/:id/versions/:versionId/mark-obsolete', requirePermission('documents.workflow', 'approve'), (req, res) => {
    if (!req.body.obsoleteReason) return res.status(400).json({ error: 'obsoleteReason is required' });
    const db = getDb();
    const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id) as any;
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    const version = db.prepare('SELECT * FROM document_versions WHERE id = ? AND document_id = ?').get(req.params.versionId, req.params.id) as any;
    if (!version) return res.status(404).json({ error: 'Version not found on this document' });
    db.prepare("UPDATE document_versions SET status = 'obsolete', obsolete_date = CURRENT_TIMESTAMP, obsolete_reason = ? WHERE id = ?").run(req.body.obsoleteReason, req.params.versionId);
    if (doc.current_version_id && Number(doc.current_version_id) === Number(req.params.versionId)) {
      db.prepare('UPDATE documents SET current_version_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id);
    }
    audit(req, { action: 'mark_version_obsolete', entity: 'document_versions', entityId: req.params.versionId, oldValue: { status: version.status }, newValue: { status: 'obsolete', obsoleteReason: req.body.obsoleteReason } });
    res.json({ ok: true });
  });

  router.get('/:id/print-render', requirePermission('documents.library', 'print'), (req, res) => {
    const db = getDb();
    const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id) as any;
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    const versionId = resolveVersionId(db, req.params.id, req.query.versionId);
    const version = versionId ? db.prepare('SELECT v.*, f.original_name AS file_name FROM document_versions v LEFT JOIN files f ON f.id = v.file_id WHERE v.id = ?').get(versionId) as any : null;
    const signedAttestations = versionId ? db.prepare(`SELECT a.attested_at, s.full_name AS staff_name, s.employee_no FROM document_attestations a LEFT JOIN staff s ON s.id = a.staff_id WHERE a.document_version_id = ? AND a.status = 'signed' ORDER BY a.attested_at`).all(versionId) as any[] : [];
    const ownerName = doc.owner_staff_id ? (db.prepare('SELECT full_name FROM staff WHERE id = ?').get(doc.owner_staff_id) as any)?.full_name : null;
    const approverName = doc.approved_by_staff_id ? (db.prepare('SELECT full_name FROM staff WHERE id = ?').get(doc.approved_by_staff_id) as any)?.full_name : null;
    const reviewerName = doc.reviewed_by_staff_id ? (db.prepare('SELECT full_name FROM staff WHERE id = ?').get(doc.reviewed_by_staff_id) as any)?.full_name : null;
    const copyNumber = req.query.copyNumber ? String(req.query.copyNumber) : '';
    const watermark = req.query.watermark ? String(req.query.watermark) : (doc.is_controlled ? 'CONTROLLED COPY' : 'UNCONTROLLED COPY');
    const purpose = req.query.purpose ? String(req.query.purpose) : '';
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>${htmlEscape(doc.document_code || doc.title)}</title>
<style>
@page { size: A4; margin: 14mm; }
body { font-family: 'Times New Roman', serif; color: #111; margin: 0; padding: 0; position: relative; }
.watermark { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; pointer-events: none; z-index: 0; }
.watermark span { font-size: 96px; font-weight: bold; color: rgba(180, 0, 0, 0.12); transform: rotate(-30deg); border: 4px solid rgba(180,0,0,0.12); padding: 8px 24px; letter-spacing: 4px; }
.page { position: relative; z-index: 1; padding: 18px 24px; }
h1 { font-size: 18px; border-bottom: 2px solid #1B3A6B; padding-bottom: 6px; margin: 0 0 12px; }
h2 { font-size: 14px; color: #1B3A6B; margin: 18px 0 6px; border-bottom: 1px solid #ccd; padding-bottom: 3px; }
.content { font-size: 12px; line-height: 1.4; }
.content h3 { font-size: 12px; margin: 10px 0 2px; color: #222; }
.content p { margin: 4px 0; }
table.meta { border-collapse: collapse; width: 100%; font-size: 12px; margin-bottom: 16px; }
table.meta th, table.meta td { border: 1px solid #888; padding: 4px 8px; text-align: left; vertical-align: top; }
table.meta th { background: #eef2f7; width: 22%; }
.banner { background: #fff8e1; border: 1px solid #d9b400; padding: 8px 12px; margin: 12px 0; font-size: 12px; }
.footer { font-size: 10px; color: #555; margin-top: 24px; border-top: 1px solid #ccc; padding-top: 6px; }
@media print { .no-print { display: none; } }
.no-print { background: #f4f6fb; padding: 8px 12px; border-bottom: 1px solid #ccc; font-size: 12px; }
</style></head><body>
<div class="watermark"><span>${htmlEscape(watermark)}</span></div>
<div class="no-print">Use your browser's Print to produce a watermarked cover sheet. After printing, log the print on the document detail page so the print is captured in the audit trail.</div>
<div class="page">
  <h1>${htmlEscape(doc.document_code || '')} ${doc.document_code ? '—' : ''} ${htmlEscape(doc.title)}</h1>
  <table class="meta">
    <tr><th>Document type</th><td>${htmlEscape(doc.document_type || '—')}</td><th>Version</th><td>${htmlEscape(version?.version_number || version?.version_label || '—')}</td></tr>
    <tr><th>Status</th><td>${htmlEscape(doc.status)}</td><th>Effective date</th><td>${htmlEscape(version?.effective_date || '—')}</td></tr>
    <tr><th>Access level</th><td>${htmlEscape(doc.access_level || '—')}</td><th>Controlled</th><td>${doc.is_controlled ? 'Yes' : 'No'}</td></tr>
    <tr><th>Next review</th><td>${htmlEscape(doc.next_review_date || '—')}</td><th>Copy #</th><td>${htmlEscape(copyNumber || '—')}</td></tr>
    <tr><th>Owner / Author</th><td>${htmlEscape(ownerName || '—')}</td><th>Reviewed by</th><td>${htmlEscape(reviewerName || '—')}</td></tr>
    <tr><th>Authorised by</th><td>${htmlEscape(approverName || '—')}</td><th>Approved on</th><td>${htmlEscape(doc.approved_at ? String(doc.approved_at).slice(0, 10) : '—')}</td></tr>
    <tr><th>Print purpose</th><td colspan="3">${htmlEscape(purpose || '—')}</td></tr>
    ${version?.revision_summary ? `<tr><th>Revision summary</th><td colspan="3">${htmlEscape(version.revision_summary)}</td></tr>` : ''}
  </table>
  ${version?.content_html ? `<div class="content"><h2>Controlled content</h2>${version.content_html}</div>` : (version?.file_name ? `<div class="banner">Attached document file: <strong>${htmlEscape(version.file_name)}</strong>. Open the file from the document viewer and print alongside this cover sheet.</div>` : '<div class="banner">No content has been captured for this version. Print this cover sheet only.</div>')}
  <h2>Attestation Record</h2>
  <p style="font-size:11px;color:#555;margin:2px 0 8px;">Staff who have read and attested to this version of the controlled document.</p>
  <table class="meta"><tr><th style="width:6%;">#</th><th style="width:54%;">Staff name</th><th style="width:20%;">Staff ID</th><th style="width:20%;">Attested on</th></tr>
  ${signedAttestations.length ? signedAttestations.map((a, i) => `<tr><td>${i + 1}</td><td>${htmlEscape(a.staff_name || '—')}</td><td>${htmlEscape(a.employee_no || '—')}</td><td>${htmlEscape(a.attested_at ? String(a.attested_at).slice(0, 10) : '—')}</td></tr>`).join('') : '<tr><td colspan="4" style="text-align:center;color:#888;">No staff have attested to this version yet.</td></tr>'}
  </table>
  <div class="footer">SECH_LIMS by Nickland · Generated ${new Date().toISOString()} · ${signedAttestations.length} staff attestation(s) on record · Recipient is responsible for verifying that this is the current authorised version before use.</div>
</div>
</body></html>`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  });

  router.post('/:id/print-log', requirePermission('documents.library', 'print'), (req, res) => {
    const db = getDb();
    const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id) as any;
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    const printedBy = getStaffIdOrCurrent(req, req.body.printedByStaffId);
    const result = db.prepare(`INSERT INTO document_print_logs (document_id, document_version_id, printed_by_staff_id, print_date, print_purpose, controlled_copy, copy_number, watermark, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(req.params.id, parseIntNullable(req.body.documentVersionId) ?? doc.current_version_id, printedBy, req.body.printDate ?? new Date().toISOString(), req.body.printPurpose ?? null, req.body.controlledCopy ? 1 : 0, req.body.copyNumber ?? null, req.body.watermark ?? null, req.user!.id);
    const printId = Number(result.lastInsertRowid);
    audit(req, { action: 'print', entity: 'documents', entityId: req.params.id, newValue: { printId, ...req.body } });
    res.status(201).json({ id: printId });
  });

  return router;
}

export { DOCUMENT_STATUSES, VERSION_STATUSES, REVIEW_OUTCOMES, ATTESTATION_STATUSES, DISTRIBUTION_TARGETS };
