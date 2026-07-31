import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { getDb, uploadRoot, evidenceRoot } from '../db/database.js';
import { requirePermission } from '../middleware/permissions.js';
import { requireAuth } from '../middleware/auth.js';
import { audit } from '../services/auditService.js';
import { generateRecordNumber } from '../utils/recordNumber.js';
import { parseIntNullable, getStaffIdOrCurrent } from './routeHelpers.js';

// ==========================================================================
// Duty Roster & Scheduling
//   * Duty roster       — department-wide monthly grid (staff × days → shift)
//   * Reassignment memo — monthly unit/staff re-assignment schedule
//   * Bench schedule    — per-unit monthly grid (staff × days → bench)
//   * Shift-type & bench catalogues that drive the grids and legends
// Every roster/schedule prints to match the laboratory's paper forms, with the
// laboratory logo embedded. All staff may view/print; editing is gated by the
// personnel module permissions (create/edit/approve).
// ==========================================================================

function escHtml(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAY_LETTER = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

function monthMeta(month: string) {
  // month = 'YYYY-MM'
  const [y, m] = String(month || '').split('-').map(Number);
  const year = Number.isFinite(y) ? y : new Date().getFullYear();
  const mi = Number.isFinite(m) && m >= 1 && m <= 12 ? m - 1 : new Date().getMonth();
  const days = new Date(year, mi + 1, 0).getDate();
  return {
    year, monthIndex: mi, days,
    label: `${MONTH_NAMES[mi]}, ${year}`,
    startDate: `${year}-${String(mi + 1).padStart(2, '0')}-01`,
    endDate: `${year}-${String(mi + 1).padStart(2, '0')}-${String(days).padStart(2, '0')}`,
    weekdayOf: (day: number) => WEEKDAY_LETTER[new Date(year, mi, day).getDay()],
    isWeekend: (day: number) => { const d = new Date(year, mi, day).getDay(); return d === 0 || d === 6; },
  };
}

// Read the laboratory masthead + logo (as a data URI) for printed documents.
function labHeader(db: any): { org: string; facility: string; subtitle: string; logo: string | null; signatory: string } {
  const p = db.prepare('SELECT * FROM laboratory_profile WHERE id = 1').get() as any;
  let logo: string | null = null;
  if (p?.logo_file_id) {
    const file = db.prepare('SELECT * FROM files WHERE id = ?').get(p.logo_file_id) as any;
    if (file) {
      const root = file.storage_area === 'evidence' ? evidenceRoot : uploadRoot;
      const fp = path.join(root, file.stored_name);
      if (fs.existsSync(fp)) {
        try {
          const bytes = fs.readFileSync(fp);
          logo = `data:${file.mime_type || 'image/png'};base64,${bytes.toString('base64')}`;
        } catch { logo = null; }
      }
    }
  }
  const facilityBits = [p?.facility_name, [p?.city, p?.country].filter(Boolean).join(', ')].filter(Boolean);
  return {
    org: p?.short_name || p?.facility_name || 'Laboratory',
    facility: p?.facility_name || '',
    subtitle: facilityBits.join(' — '),
    logo,
    signatory: p?.facility_name || '',
  };
}

function printShell(title: string, headHtml: string, bodyHtml: string, autoprint: boolean): string {
  const autoprintScript = autoprint ? '<script>window.addEventListener("load", () => { setTimeout(() => window.print(), 300); });</script>' : '';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>${escHtml(title)}</title>
<style>
@page{size:A4 landscape;margin:8mm}
*{box-sizing:border-box}
html,body{-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{font-family:Arial,Helvetica,sans-serif;color:#111;padding:10px 14px;margin:0}
.no-print{background:#f4f6fb;padding:8px 12px;border:1px solid #ccd;border-radius:6px;margin-bottom:12px;font-size:12px}
.mast{display:flex;align-items:center;gap:16px;margin-bottom:6px}
.mast img{height:82px;width:auto;object-fit:contain}
.mast-txt{flex:1;text-align:center}
.mast-txt .org{font-weight:bold;font-size:16px;line-height:1.35;letter-spacing:.3px}
.doc-title{text-align:center;font-weight:bold;font-size:16px;letter-spacing:2px;text-decoration:underline;margin:6px 0 12px}
/* Grid fills the sheet: tall rows + readable type, all as selectable text. */
table.grid{border-collapse:collapse;width:100%;table-layout:fixed}
table.grid th,table.grid td{border:1px solid #444;text-align:center;font-size:12px;padding:2px 1px;overflow:hidden;white-space:nowrap;height:30px}
table.grid td.name,table.grid th.name{text-align:left;font-weight:bold;font-family:'Courier New',monospace;font-size:11px;padding:2px 5px;width:120px;white-space:nowrap}
table.grid .hdr{background:#c85a2a;color:#fff;font-weight:bold}
table.grid .hdr-wknd{background:#a8471f;color:#fff;font-weight:bold}
table.grid .monthcell{background:#fff;color:#c85a2a;font-weight:bold;font-style:italic;font-size:12px;text-align:left;padding-left:6px}
table.grid .wknd{background:#f3d9cc}
.legend{margin-top:14px;font-size:12.5px;font-family:'Courier New',monospace;font-weight:bold}
.legend span{margin-right:30px;white-space:nowrap;display:inline-block;margin-bottom:4px}
.memo h1{font-size:26px;margin:0 0 8px;font-family:'Times New Roman',serif}
.memo .metaline{font-size:13px;margin:2px 0;font-family:'Times New Roman',serif}
.memo table{border-collapse:collapse;width:100%;margin:14px 0;font-family:'Times New Roman',serif}
.memo th,.memo td{border:1px solid #333;padding:6px 8px;text-align:left;font-size:12.5px;vertical-align:top}
.memo th{font-weight:bold}
.memo .nb{font-family:'Times New Roman',serif;font-size:12.5px}
.memo .nb b{display:block;margin:8px 0 4px}
.sign{margin-top:26px;font-family:'Times New Roman',serif;font-size:13px}
.footer{font-size:9px;color:#666;margin-top:18px;border-top:1px solid #ccc;padding-top:5px}
@media print{.no-print{display:none}body{padding:0}}
</style>${autoprintScript}</head><body>
<div class="no-print">The print dialog opens automatically — choose any printer or <b>Save as PDF</b>. <button onclick="window.print()">Print</button> <a href="?autoprint=0">disable autoprint</a></div>
${headHtml}
${bodyHtml}
<div class="footer">SECH_LIMS by Nickland · Generated ${new Date().toISOString().slice(0, 19).replace('T', ' ')} · Prepared for posting in the laboratory.</div>
</body></html>`;
}

function mastheadHtml(h: ReturnType<typeof labHeader>, orgLines: string, docTitle: string): string {
  return `<div class="mast">${h.logo ? `<img src="${h.logo}" alt="logo"/>` : '<div style="width:78px"></div>'}
<div class="mast-txt"><div class="org">${orgLines}</div></div><div style="width:78px"></div></div>
<div class="doc-title">${escHtml(docTitle)}</div>`;
}

export function schedulingRoutes() {
  const router = Router();
  router.use(requireAuth);

  // ========================= Shift-type catalogue =========================
  router.get('/shift-types', requirePermission('personnel', 'view'), (_req, res) => {
    res.json(getDb().prepare('SELECT * FROM roster_shift_types ORDER BY display_order, id').all());
  });
  router.post('/shift-types', requirePermission('settings', 'create'), (req, res) => {
    const db = getDb();
    const code = String(req.body.code || '').trim().toUpperCase();
    if (!code) return res.status(400).json({ error: 'A shift code is required.' });
    if (!req.body.label) return res.status(400).json({ error: 'A label is required.' });
    if (db.prepare('SELECT id FROM roster_shift_types WHERE code = ?').get(code)) return res.status(409).json({ error: `Shift code "${code}" already exists.` });
    const order = (db.prepare('SELECT COALESCE(MAX(display_order),0)+1 n FROM roster_shift_types').get() as { n: number }).n;
    const r = db.prepare('INSERT INTO roster_shift_types (code, label, category, bg_color, text_color, display_order, is_active, is_system) VALUES (?, ?, ?, ?, ?, ?, 1, 0)')
      .run(code, String(req.body.label), req.body.category || 'shift', req.body.bgColor || '#ffffff', req.body.textColor || '#111111', parseIntNullable(req.body.displayOrder) ?? order);
    audit(req, { action: 'create', entity: 'roster_shift_types', entityId: Number(r.lastInsertRowid), newValue: { code, ...req.body } });
    res.status(201).json({ id: Number(r.lastInsertRowid) });
  });
  router.put('/shift-types/:id', requirePermission('settings', 'edit'), (req, res) => {
    const db = getDb();
    const ex = db.prepare('SELECT * FROM roster_shift_types WHERE id = ?').get(req.params.id) as any;
    if (!ex) return res.status(404).json({ error: 'Shift type not found' });
    db.prepare('UPDATE roster_shift_types SET label = ?, category = ?, bg_color = ?, text_color = ?, display_order = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(req.body.label ?? ex.label, req.body.category ?? ex.category, req.body.bgColor ?? ex.bg_color, req.body.textColor ?? ex.text_color,
        parseIntNullable(req.body.displayOrder) ?? ex.display_order, req.body.isActive === undefined ? ex.is_active : (req.body.isActive ? 1 : 0), req.params.id);
    audit(req, { action: 'edit', entity: 'roster_shift_types', entityId: req.params.id, oldValue: ex, newValue: req.body });
    res.json({ ok: true });
  });
  router.delete('/shift-types/:id', requirePermission('settings', 'void_archive'), (req, res) => {
    const db = getDb();
    const ex = db.prepare('SELECT * FROM roster_shift_types WHERE id = ?').get(req.params.id) as any;
    if (!ex) return res.status(404).json({ error: 'Shift type not found' });
    if (ex.is_system) { db.prepare('UPDATE roster_shift_types SET is_active = 0 WHERE id = ?').run(req.params.id); return res.json({ ok: true, deactivated: true }); }
    db.prepare('DELETE FROM roster_shift_types WHERE id = ?').run(req.params.id);
    audit(req, { action: 'delete', entity: 'roster_shift_types', entityId: req.params.id, oldValue: ex });
    res.json({ ok: true });
  });

  // ========================= Bench catalogue (per unit) =========================
  router.get('/sections/:id/benches', requirePermission('personnel', 'view'), (req, res) => {
    res.json(getDb().prepare('SELECT * FROM section_benches WHERE section_id = ? ORDER BY display_order, id').all(req.params.id));
  });
  router.post('/sections/:id/benches', requirePermission('settings', 'create'), (req, res) => {
    const db = getDb();
    if (!db.prepare('SELECT id FROM sections WHERE id = ?').get(req.params.id)) return res.status(404).json({ error: 'Unit not found' });
    if (!req.body.name || !String(req.body.name).trim()) return res.status(400).json({ error: 'A bench name is required.' });
    const order = (db.prepare('SELECT COALESCE(MAX(display_order),0)+1 n FROM section_benches WHERE section_id = ?').get(req.params.id) as { n: number }).n;
    const r = db.prepare('INSERT INTO section_benches (section_id, name, code, description, display_order, is_active) VALUES (?, ?, ?, ?, ?, 1)')
      .run(req.params.id, String(req.body.name).trim(), req.body.code || null, req.body.description || null, parseIntNullable(req.body.displayOrder) ?? order);
    audit(req, { action: 'create', entity: 'section_benches', entityId: Number(r.lastInsertRowid), newValue: { sectionId: req.params.id, ...req.body } });
    res.status(201).json({ id: Number(r.lastInsertRowid) });
  });
  router.put('/benches/:benchId', requirePermission('settings', 'edit'), (req, res) => {
    const db = getDb();
    const ex = db.prepare('SELECT * FROM section_benches WHERE id = ?').get(req.params.benchId) as any;
    if (!ex) return res.status(404).json({ error: 'Bench not found' });
    db.prepare('UPDATE section_benches SET name = ?, code = ?, description = ?, display_order = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(req.body.name ?? ex.name, req.body.code ?? ex.code, req.body.description ?? ex.description, parseIntNullable(req.body.displayOrder) ?? ex.display_order,
        req.body.isActive === undefined ? ex.is_active : (req.body.isActive ? 1 : 0), req.params.benchId);
    audit(req, { action: 'edit', entity: 'section_benches', entityId: req.params.benchId, oldValue: ex, newValue: req.body });
    res.json({ ok: true });
  });
  router.delete('/benches/:benchId', requirePermission('settings', 'void_archive'), (req, res) => {
    const db = getDb();
    const ex = db.prepare('SELECT * FROM section_benches WHERE id = ?').get(req.params.benchId);
    if (!ex) return res.status(404).json({ error: 'Bench not found' });
    db.prepare('DELETE FROM section_benches WHERE id = ?').run(req.params.benchId);
    audit(req, { action: 'delete', entity: 'section_benches', entityId: req.params.benchId, oldValue: ex });
    res.json({ ok: true });
  });

  // ========================= Duty rosters (department-wide monthly grid) =========================
  router.get('/duty-rosters', requirePermission('personnel', 'view'), (req, res) => {
    const db = getDb();
    let q = 'SELECT r.*, d.name AS department_name FROM duty_rosters r LEFT JOIN departments d ON d.id = r.department_id';
    const params: unknown[] = [];
    if (req.query.month) { q += ' WHERE r.month = ?'; params.push(req.query.month); }
    q += ' ORDER BY COALESCE(r.month, r.roster_start_date) DESC, r.id DESC';
    res.json(db.prepare(q).all(...params));
  });

  router.post('/duty-rosters', requirePermission('personnel', 'create'), (req, res) => {
    const db = getDb();
    const month = String(req.body.month || '').trim();
    if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'A month (YYYY-MM) is required.' });
    const mm = monthMeta(month);
    const h = labHeader(db);
    const createdAt = new Date().toISOString();
    const rosterNumber = generateRecordNumber(db, 'duty_rosters', 'ROSTER', createdAt);
    // Default enabled shift subset: all active shift-type codes, unless supplied.
    const activeCodes = (db.prepare("SELECT code FROM roster_shift_types WHERE is_active = 1 ORDER BY display_order").all() as Array<{ code: string }>).map(c => c.code);
    const shiftCodes = Array.isArray(req.body.shiftCodes) && req.body.shiftCodes.length ? req.body.shiftCodes : activeCodes;
    const orgLines = `${(h.org || '').toUpperCase()}`;
    const result = db.prepare(`INSERT INTO duty_rosters (roster_number, department_id, section_id, month, title, shift_codes, header_org, header_facility, header_subtitle, roster_start_date, roster_end_date, status, prepared_by_staff_id, notes, created_by, created_at)
      VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`)
      .run(rosterNumber, parseIntNullable(req.body.departmentId), month, req.body.title || 'DUTY ROSTER', JSON.stringify(shiftCodes),
        req.body.headerOrg || orgLines, req.body.headerFacility || h.facility, req.body.headerSubtitle || h.subtitle,
        mm.startDate, mm.endDate, getStaffIdOrCurrent(req, req.body.preparedByStaffId), req.body.notes ?? null, req.user!.id, createdAt);
    const rosterId = Number(result.lastInsertRowid);
    const copyFromId = parseIntNullable(req.body.copyFromId);
    const src = copyFromId ? db.prepare('SELECT * FROM duty_rosters WHERE id = ?').get(copyFromId) as any : null;
    const insRow = db.prepare('INSERT INTO duty_roster_rows (roster_id, staff_id, label, display_order) VALUES (?, ?, ?, ?)');
    if (src) {
      // Use a previous roster as a template: copy its rows (staff + label rows)
      // and, unless told otherwise, the painted shifts too, remapping to the new
      // days. This saves rebuilding the whole month from scratch.
      const srcRows = db.prepare('SELECT * FROM duty_roster_rows WHERE roster_id = ? ORDER BY display_order, id').all(copyFromId) as any[];
      const includeCells = req.body.copyCells !== false;
      const insCell = db.prepare('INSERT OR IGNORE INTO duty_roster_cells (roster_id, row_id, day, shift_code, note) VALUES (?, ?, ?, ?, ?)');
      for (const sr of srcRows) {
        const newRowId = Number(insRow.run(rosterId, sr.staff_id, sr.label, sr.display_order).lastInsertRowid);
        if (includeCells) {
          const srcCells = db.prepare('SELECT * FROM duty_roster_cells WHERE row_id = ? AND day <= ?').all(sr.id, mm.days) as any[];
          for (const c of srcCells) insCell.run(rosterId, newRowId, c.day, c.shift_code, c.note);
        }
      }
      // Carry the template's title and shift subset when not explicitly provided.
      if (!req.body.title && src.title) db.prepare('UPDATE duty_rosters SET title = ? WHERE id = ?').run(src.title, rosterId);
      if (!(Array.isArray(req.body.shiftCodes) && req.body.shiftCodes.length) && src.shift_codes) db.prepare('UPDATE duty_rosters SET shift_codes = ? WHERE id = ?').run(src.shift_codes, rosterId);
    } else {
      // Fresh roster: seed one row per active staff member, in register order.
      const staff = db.prepare("SELECT id FROM staff WHERE is_active = 1 ORDER BY full_name").all() as Array<{ id: number }>;
      staff.forEach((s, i) => insRow.run(rosterId, s.id, null, i + 1));
    }
    audit(req, { action: 'create', entity: 'duty_rosters', entityId: rosterId, newValue: { rosterNumber, month, copyFromId } });
    res.status(201).json({ id: rosterId, rosterNumber });
  });

  function loadRoster(db: any, id: unknown) {
    const roster = db.prepare('SELECT r.*, d.name AS department_name FROM duty_rosters r LEFT JOIN departments d ON d.id = r.department_id WHERE r.id = ?').get(id);
    if (!roster) return null;
    const rows = db.prepare('SELECT rr.*, s.full_name AS staff_name FROM duty_roster_rows rr LEFT JOIN staff s ON s.id = rr.staff_id WHERE rr.roster_id = ? ORDER BY rr.display_order, rr.id').all(id);
    const cells = db.prepare('SELECT * FROM duty_roster_cells WHERE roster_id = ?').all(id);
    return { ...roster, rows, cells };
  }

  router.get('/duty-rosters/:id', requirePermission('personnel', 'view'), (req, res) => {
    const db = getDb();
    const roster = loadRoster(db, req.params.id);
    if (!roster) return res.status(404).json({ error: 'Roster not found' });
    const shiftTypes = db.prepare('SELECT * FROM roster_shift_types ORDER BY display_order, id').all();
    res.json({ ...roster, shiftTypes });
  });

  router.put('/duty-rosters/:id', requirePermission('personnel', 'edit'), (req, res) => {
    const db = getDb();
    const ex = db.prepare('SELECT * FROM duty_rosters WHERE id = ?').get(req.params.id) as any;
    if (!ex) return res.status(404).json({ error: 'Roster not found' });
    const b = req.body;
    let month = ex.month, start = ex.roster_start_date, end = ex.roster_end_date;
    if (b.month && /^\d{4}-\d{2}$/.test(b.month)) { month = b.month; const mm = monthMeta(month); start = mm.startDate; end = mm.endDate; }
    db.prepare(`UPDATE duty_rosters SET title = ?, month = ?, shift_codes = ?, header_org = ?, header_facility = ?, header_subtitle = ?, roster_start_date = ?, roster_end_date = ?, notes = ?, department_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(b.title ?? ex.title, month, b.shiftCodes !== undefined ? JSON.stringify(b.shiftCodes) : ex.shift_codes,
        b.headerOrg ?? ex.header_org, b.headerFacility ?? ex.header_facility, b.headerSubtitle ?? ex.header_subtitle,
        start, end, b.notes ?? ex.notes, b.departmentId !== undefined ? parseIntNullable(b.departmentId) : ex.department_id, req.params.id);
    audit(req, { action: 'edit', entity: 'duty_rosters', entityId: req.params.id, oldValue: ex, newValue: b });
    res.json({ ok: true });
  });

  router.delete('/duty-rosters/:id', requirePermission('personnel', 'void_archive'), (req, res) => {
    const db = getDb();
    const ex = db.prepare('SELECT * FROM duty_rosters WHERE id = ?').get(req.params.id);
    if (!ex) return res.status(404).json({ error: 'Roster not found' });
    db.prepare('DELETE FROM duty_roster_cells WHERE roster_id = ?').run(req.params.id);
    db.prepare('DELETE FROM duty_roster_rows WHERE roster_id = ?').run(req.params.id);
    db.prepare('DELETE FROM duty_rosters WHERE id = ?').run(req.params.id);
    audit(req, { action: 'delete', entity: 'duty_rosters', entityId: req.params.id, oldValue: ex });
    res.json({ ok: true });
  });

  // Roster rows (add a staff row or a free-text label/spacer row)
  router.post('/duty-rosters/:id/rows', requirePermission('personnel', 'edit'), (req, res) => {
    const db = getDb();
    if (!db.prepare('SELECT id FROM duty_rosters WHERE id = ?').get(req.params.id)) return res.status(404).json({ error: 'Roster not found' });
    const order = parseIntNullable(req.body.displayOrder) ?? (db.prepare('SELECT COALESCE(MAX(display_order),0)+1 n FROM duty_roster_rows WHERE roster_id = ?').get(req.params.id) as { n: number }).n;
    const r = db.prepare('INSERT INTO duty_roster_rows (roster_id, staff_id, label, display_order) VALUES (?, ?, ?, ?)')
      .run(req.params.id, parseIntNullable(req.body.staffId), req.body.label || null, order);
    res.status(201).json({ id: Number(r.lastInsertRowid) });
  });
  router.put('/duty-roster-rows/:rowId', requirePermission('personnel', 'edit'), (req, res) => {
    const db = getDb();
    const ex = db.prepare('SELECT * FROM duty_roster_rows WHERE id = ?').get(req.params.rowId) as any;
    if (!ex) return res.status(404).json({ error: 'Row not found' });
    db.prepare('UPDATE duty_roster_rows SET staff_id = ?, label = ?, display_order = ? WHERE id = ?')
      .run(req.body.staffId !== undefined ? parseIntNullable(req.body.staffId) : ex.staff_id, req.body.label !== undefined ? req.body.label : ex.label,
        parseIntNullable(req.body.displayOrder) ?? ex.display_order, req.params.rowId);
    res.json({ ok: true });
  });
  router.delete('/duty-roster-rows/:rowId', requirePermission('personnel', 'edit'), (req, res) => {
    const db = getDb();
    db.prepare('DELETE FROM duty_roster_cells WHERE row_id = ?').run(req.params.rowId);
    db.prepare('DELETE FROM duty_roster_rows WHERE id = ?').run(req.params.rowId);
    res.json({ ok: true });
  });

  // Bulk upsert cells. body.cells = [{ rowId, day, shiftCode, note }]
  router.post('/duty-rosters/:id/cells', requirePermission('personnel', 'edit'), (req, res) => {
    const db = getDb();
    if (!db.prepare('SELECT id FROM duty_rosters WHERE id = ?').get(req.params.id)) return res.status(404).json({ error: 'Roster not found' });
    const cells: Array<{ rowId: number; day: number; shiftCode?: string | null; note?: string | null }> = Array.isArray(req.body.cells) ? req.body.cells : [];
    const up = db.prepare(`INSERT INTO duty_roster_cells (roster_id, row_id, day, shift_code, note) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(row_id, day) DO UPDATE SET shift_code = excluded.shift_code, note = excluded.note`);
    const del = db.prepare('DELETE FROM duty_roster_cells WHERE row_id = ? AND day = ?');
    const tx = db.transaction(() => {
      for (const c of cells) {
        const code = (c.shiftCode ?? '').toString().trim();
        if (!code && !c.note) del.run(c.rowId, c.day);
        else up.run(req.params.id, c.rowId, c.day, code || null, c.note ?? null);
      }
    });
    tx();
    res.json({ ok: true, count: cells.length });
  });

  router.post('/duty-rosters/:id/approve', requirePermission('personnel', 'approve'), (req, res) => {
    const db = getDb();
    const ex = db.prepare('SELECT * FROM duty_rosters WHERE id = ?').get(req.params.id) as any;
    if (!ex) return res.status(404).json({ error: 'Roster not found' });
    db.prepare("UPDATE duty_rosters SET status = 'approved', approved_by_staff_id = ?, approved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(getStaffIdOrCurrent(req, req.body.approvedByStaffId), req.params.id);
    audit(req, { action: 'approve', entity: 'duty_rosters', entityId: req.params.id, oldValue: { status: ex.status } });
    res.json({ ok: true });
  });
  router.post('/duty-rosters/:id/publish', requirePermission('personnel', 'edit'), (req, res) => {
    const db = getDb();
    const ex = db.prepare('SELECT * FROM duty_rosters WHERE id = ?').get(req.params.id) as any;
    if (!ex) return res.status(404).json({ error: 'Roster not found' });
    db.prepare("UPDATE duty_rosters SET status = 'published', published_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
    audit(req, { action: 'publish', entity: 'duty_rosters', entityId: req.params.id, oldValue: { status: ex.status } });
    res.json({ ok: true });
  });

  router.get('/duty-rosters/:id/print', requirePermission('personnel', 'view'), (req, res) => {
    const db = getDb();
    const roster = loadRoster(db, req.params.id) as any;
    if (!roster) return res.status(404).send('Roster not found');
    const mm = monthMeta(roster.month || roster.roster_start_date?.slice(0, 7));
    const h = labHeader(db);
    const shiftTypes = db.prepare('SELECT * FROM roster_shift_types').all() as any[];
    const byCode = new Map(shiftTypes.map(s => [s.code, s]));
    let enabled: string[] = [];
    try { enabled = JSON.parse(roster.shift_codes || '[]'); } catch { enabled = []; }
    // cells lookup
    const cellMap = new Map<string, any>();
    for (const c of roster.cells) cellMap.set(`${c.row_id}:${c.day}`, c);

    const dayNums = Array.from({ length: mm.days }, (_, i) => i + 1);
    // header rows
    const monthLabel = escHtml(mm.label);
    let head1 = `<tr><td class="monthcell" rowspan="1">${monthLabel}</td>`;
    for (const d of dayNums) head1 += `<td class="${mm.isWeekend(d) ? 'hdr-wknd' : 'hdr'}">${mm.weekdayOf(d)}</td>`;
    head1 += '</tr>';
    let head2 = `<th class="name">NAMES</th>`;
    for (const d of dayNums) head2 += `<td class="${mm.isWeekend(d) ? 'hdr-wknd' : 'hdr'}">${d}</td>`;
    head2 = `<tr>${head2}</tr>`;

    let bodyRows = '';
    for (const row of roster.rows) {
      const name = row.staff_id ? row.staff_name : (row.label || '');
      let tds = '';
      let d = 1;
      while (d <= mm.days) {
        const cell = cellMap.get(`${row.id}:${d}`);
        const code = cell?.shift_code || '';
        const st = code ? byCode.get(code) : null;
        // Merge consecutive identical leave codes into a single labelled bar.
        if (st && st.category === 'leave') {
          let span = 1;
          while (d + span <= mm.days && (cellMap.get(`${row.id}:${d + span}`)?.shift_code || '') === code) span++;
          if (span >= 2) {
            tds += `<td colspan="${span}" style="background:${st.bg_color};color:${st.text_color};font-weight:bold;letter-spacing:1px">${escHtml((st.label || '').toUpperCase())}</td>`;
            d += span; continue;
          }
        }
        if (st) tds += `<td class="${mm.isWeekend(d) ? 'wknd' : ''}" style="background:${st.bg_color};color:${st.text_color};font-weight:bold">${escHtml(code)}</td>`;
        else tds += `<td class="${mm.isWeekend(d) ? 'wknd' : ''}"></td>`;
        d++;
      }
      bodyRows += `<tr><td class="name">${escHtml(name)}</td>${tds}</tr>`;
    }

    const colW = `<colgroup><col style="width:120px"/>${dayNums.map(() => '<col/>').join('')}</colgroup>`;
    const table = `<table class="grid">${colW}<thead>${head1}${head2}</thead><tbody>${bodyRows}</tbody></table>`;

    // legend from enabled codes actually in the catalogue
    const legendCodes = (enabled.length ? enabled : shiftTypes.map(s => s.code)).map(c => byCode.get(c)).filter(Boolean);
    const legend = `<div class="legend">${legendCodes.map((s: any) => `<span><b>${escHtml(s.code)}</b>: ${escHtml((s.label || '').toUpperCase())}</span>`).join('')}</div>`;

    const orgLines = escHtml(roster.header_org || h.org).replace(/\n/g, '<br/>') + (roster.header_facility ? `<br/>${escHtml(roster.header_facility)}` : '') + (roster.header_subtitle && roster.header_subtitle !== roster.header_facility ? `<br/>${escHtml(roster.header_subtitle)}` : '');
    const headHtml = mastheadHtml(h, orgLines, roster.title || 'DUTY ROSTER');
    audit(req, { action: 'print', entity: 'duty_rosters', entityId: req.params.id });
    res.send(printShell(`${roster.roster_number} — Duty Roster`, headHtml, table + legend, req.query.autoprint !== '0'));
  });

  // ========================= Reassignment schedules (memo) =========================
  router.get('/reassignments', requirePermission('personnel', 'view'), (req, res) => {
    const db = getDb();
    let q = 'SELECT * FROM reassignment_schedules';
    const params: unknown[] = [];
    if (req.query.month) { q += ' WHERE month = ?'; params.push(req.query.month); }
    q += ' ORDER BY COALESCE(month, effective_date) DESC, id DESC';
    res.json(db.prepare(q).all(...params));
  });

  router.post('/reassignments', requirePermission('personnel', 'create'), (req, res) => {
    const db = getDb();
    const month = String(req.body.month || '').trim();
    const createdAt = new Date().toISOString();
    const num = generateRecordNumber(db, 'reassignment_schedules', 'REASSIGN', createdAt);
    const mm = month && /^\d{4}-\d{2}$/.test(month) ? monthMeta(month) : null;
    const effective = req.body.effectiveDate || (mm ? mm.startDate : null);
    const intro = req.body.introText || (effective ? `Please take notice of the re-assignment of staff with effect from ${effective} as follows:` : '');
    const defaultNb = [
      'All challenges/excuses should be discussed with the unit supervisor for onward discussion with the laboratory manager.',
      'No two staff in a single unit should leave the laboratory unless permitted to do so by the unit supervisor.',
      'The unit supervisors are responsible for the quality of results and equipment, and the performance of LQMS activities in that unit.',
      'Detail handing over should be done where applicable. Transition staff will be assigned specific duties daily.',
    ].join('\n');
    const r = db.prepare(`INSERT INTO reassignment_schedules (schedule_number, month, effective_date, memo_to, memo_from, memo_date, subject, intro_text, nb_notes, signatory_staff_id, signatory_name, status, prepared_by_staff_id, notes, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`)
      .run(num, month || null, effective, req.body.memoTo || 'All Laboratory Staff', req.body.memoFrom || 'Quality Manager', req.body.memoDate || createdAt.slice(0, 10),
        req.body.subject || 'Re-assignment of Laboratory Staff', intro, req.body.nbNotes ?? defaultNb, parseIntNullable(req.body.signatoryStaffId), req.body.signatoryName || null,
        getStaffIdOrCurrent(req, req.body.preparedByStaffId), req.body.notes ?? null, req.user!.id, createdAt);
    const newId = Number(r.lastInsertRowid);
    // Use a previous schedule as a template: copy all its unit rows so only a
    // few edits are needed for the new month.
    const copyFromId = parseIntNullable(req.body.copyFromId);
    if (copyFromId) {
      const srcRows = db.prepare('SELECT * FROM reassignment_rows WHERE schedule_id = ? ORDER BY display_order, id').all(copyFromId) as any[];
      const insRow = db.prepare(`INSERT INTO reassignment_rows (schedule_id, unit_label, is_span, section_id, supervisor_staff_id, supervisor_text, deputy_staff_id, deputy_text, members_text, member_ids, span_text, display_order)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const sr of srcRows) insRow.run(newId, sr.unit_label, sr.is_span, sr.section_id, sr.supervisor_staff_id, sr.supervisor_text, sr.deputy_staff_id, sr.deputy_text, sr.members_text, sr.member_ids, sr.span_text, sr.display_order);
      const srcHdr = db.prepare('SELECT nb_notes, subject, memo_from, memo_to, signatory_staff_id, signatory_name FROM reassignment_schedules WHERE id = ?').get(copyFromId) as any;
      if (srcHdr) db.prepare('UPDATE reassignment_schedules SET nb_notes = COALESCE(?, nb_notes), subject = ?, memo_from = ?, memo_to = ?, signatory_staff_id = ?, signatory_name = ? WHERE id = ?')
        .run(srcHdr.nb_notes, srcHdr.subject, srcHdr.memo_from, srcHdr.memo_to, srcHdr.signatory_staff_id, srcHdr.signatory_name, newId);
    }
    audit(req, { action: 'create', entity: 'reassignment_schedules', entityId: newId, newValue: { num, month, copyFromId } });
    res.status(201).json({ id: newId, scheduleNumber: num });
  });

  function loadReassignment(db: any, id: unknown) {
    const s = db.prepare('SELECT * FROM reassignment_schedules WHERE id = ?').get(id);
    if (!s) return null;
    const rows = db.prepare(`SELECT rr.*, sup.full_name AS supervisor_name, dep.full_name AS deputy_name
      FROM reassignment_rows rr LEFT JOIN staff sup ON sup.id = rr.supervisor_staff_id LEFT JOIN staff dep ON dep.id = rr.deputy_staff_id
      WHERE rr.schedule_id = ? ORDER BY rr.display_order, rr.id`).all(id);
    return { ...s, rows };
  }
  router.get('/reassignments/:id', requirePermission('personnel', 'view'), (req, res) => {
    const r = loadReassignment(getDb(), req.params.id);
    if (!r) return res.status(404).json({ error: 'Schedule not found' });
    res.json(r);
  });
  router.put('/reassignments/:id', requirePermission('personnel', 'edit'), (req, res) => {
    const db = getDb();
    const ex = db.prepare('SELECT * FROM reassignment_schedules WHERE id = ?').get(req.params.id) as any;
    if (!ex) return res.status(404).json({ error: 'Schedule not found' });
    const b = req.body;
    db.prepare(`UPDATE reassignment_schedules SET month = ?, effective_date = ?, memo_to = ?, memo_from = ?, memo_date = ?, subject = ?, intro_text = ?, nb_notes = ?, signatory_staff_id = ?, signatory_name = ?, notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(b.month ?? ex.month, b.effectiveDate ?? ex.effective_date, b.memoTo ?? ex.memo_to, b.memoFrom ?? ex.memo_from, b.memoDate ?? ex.memo_date,
        b.subject ?? ex.subject, b.introText ?? ex.intro_text, b.nbNotes ?? ex.nb_notes,
        b.signatoryStaffId !== undefined ? parseIntNullable(b.signatoryStaffId) : ex.signatory_staff_id, b.signatoryName ?? ex.signatory_name, b.notes ?? ex.notes, req.params.id);
    audit(req, { action: 'edit', entity: 'reassignment_schedules', entityId: req.params.id, oldValue: ex, newValue: b });
    res.json({ ok: true });
  });
  router.delete('/reassignments/:id', requirePermission('personnel', 'void_archive'), (req, res) => {
    const db = getDb();
    db.prepare('DELETE FROM reassignment_rows WHERE schedule_id = ?').run(req.params.id);
    db.prepare('DELETE FROM reassignment_schedules WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  });
  router.post('/reassignments/:id/approve', requirePermission('personnel', 'approve'), (req, res) => {
    const db = getDb();
    if (!db.prepare('SELECT id FROM reassignment_schedules WHERE id = ?').get(req.params.id)) return res.status(404).json({ error: 'Schedule not found' });
    db.prepare("UPDATE reassignment_schedules SET status = 'approved', approved_by_staff_id = ?, approved_at = CURRENT_TIMESTAMP WHERE id = ?").run(getStaffIdOrCurrent(req, req.body.approvedByStaffId), req.params.id);
    res.json({ ok: true });
  });
  // Publishing a reassignment applies it to the master register: every staff
  // member named on a row that is linked to a real unit/section (supervisor,
  // deputy and members) is moved to that section, so the rest of the system
  // reflects the new unit assignment.
  function applyReassignmentToRegister(db: any, scheduleId: unknown) {
    const rows = db.prepare('SELECT * FROM reassignment_rows WHERE schedule_id = ? AND section_id IS NOT NULL').all(scheduleId) as any[];
    const moved: number[] = [];
    const setSection = db.prepare('UPDATE staff SET section_id = ?, unit = COALESCE((SELECT name FROM sections WHERE id = ?), unit), updated_at = CURRENT_TIMESTAMP WHERE id = ?');
    for (const r of rows) {
      const ids = new Set<number>();
      if (r.supervisor_staff_id) ids.add(Number(r.supervisor_staff_id));
      if (r.deputy_staff_id) ids.add(Number(r.deputy_staff_id));
      try { for (const m of JSON.parse(r.member_ids || '[]')) { const n = Number(m); if (Number.isFinite(n)) ids.add(n); } } catch { /* ignore */ }
      for (const id of ids) { setSection.run(r.section_id, r.section_id, id); moved.push(id); }
    }
    return moved.length;
  }
  router.post('/reassignments/:id/publish', requirePermission('personnel', 'edit'), (req, res) => {
    const db = getDb();
    if (!db.prepare('SELECT id FROM reassignment_schedules WHERE id = ?').get(req.params.id)) return res.status(404).json({ error: 'Schedule not found' });
    db.prepare("UPDATE reassignment_schedules SET status = 'published', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
    const moved = applyReassignmentToRegister(db, req.params.id);
    audit(req, { action: 'publish', entity: 'reassignment_schedules', entityId: req.params.id, newValue: { staffReassigned: moved } });
    res.json({ ok: true, staffReassigned: moved });
  });
  // Apply the unit reassignment to the master register on demand, without
  // (re)publishing — useful after editing a linked row.
  router.post('/reassignments/:id/apply-to-register', requirePermission('personnel', 'edit'), (req, res) => {
    const db = getDb();
    if (!db.prepare('SELECT id FROM reassignment_schedules WHERE id = ?').get(req.params.id)) return res.status(404).json({ error: 'Schedule not found' });
    const moved = applyReassignmentToRegister(db, req.params.id);
    audit(req, { action: 'edit', entity: 'reassignment_schedules', entityId: req.params.id, newValue: { staffReassigned: moved } });
    res.json({ ok: true, staffReassigned: moved });
  });

  router.post('/reassignments/:id/rows', requirePermission('personnel', 'edit'), (req, res) => {
    const db = getDb();
    if (!db.prepare('SELECT id FROM reassignment_schedules WHERE id = ?').get(req.params.id)) return res.status(404).json({ error: 'Schedule not found' });
    if (!req.body.unitLabel) return res.status(400).json({ error: 'A unit label is required.' });
    const order = parseIntNullable(req.body.displayOrder) ?? (db.prepare('SELECT COALESCE(MAX(display_order),0)+1 n FROM reassignment_rows WHERE schedule_id = ?').get(req.params.id) as { n: number }).n;
    const memberIds = Array.isArray(req.body.memberIds) ? req.body.memberIds.map((x: unknown) => parseIntNullable(x)).filter((x: number | null) => x !== null) : null;
    const r = db.prepare(`INSERT INTO reassignment_rows (schedule_id, unit_label, is_span, section_id, supervisor_staff_id, supervisor_text, deputy_staff_id, deputy_text, members_text, member_ids, span_text, display_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(req.params.id, req.body.unitLabel, req.body.isSpan ? 1 : 0, parseIntNullable(req.body.sectionId), parseIntNullable(req.body.supervisorStaffId), req.body.supervisorText || null,
        parseIntNullable(req.body.deputyStaffId), req.body.deputyText || null, req.body.membersText || null, memberIds ? JSON.stringify(memberIds) : null, req.body.spanText || null, order);
    res.status(201).json({ id: Number(r.lastInsertRowid) });
  });
  router.put('/reassignment-rows/:rowId', requirePermission('personnel', 'edit'), (req, res) => {
    const db = getDb();
    const ex = db.prepare('SELECT * FROM reassignment_rows WHERE id = ?').get(req.params.rowId) as any;
    if (!ex) return res.status(404).json({ error: 'Row not found' });
    const b = req.body;
    const memberIds = b.memberIds !== undefined ? (Array.isArray(b.memberIds) ? JSON.stringify(b.memberIds.map((x: unknown) => parseIntNullable(x)).filter((x: number | null) => x !== null)) : null) : ex.member_ids;
    db.prepare(`UPDATE reassignment_rows SET unit_label = ?, is_span = ?, section_id = ?, supervisor_staff_id = ?, supervisor_text = ?, deputy_staff_id = ?, deputy_text = ?, members_text = ?, member_ids = ?, span_text = ?, display_order = ? WHERE id = ?`)
      .run(b.unitLabel ?? ex.unit_label, b.isSpan === undefined ? ex.is_span : (b.isSpan ? 1 : 0),
        b.sectionId !== undefined ? parseIntNullable(b.sectionId) : ex.section_id,
        b.supervisorStaffId !== undefined ? parseIntNullable(b.supervisorStaffId) : ex.supervisor_staff_id, b.supervisorText !== undefined ? b.supervisorText : ex.supervisor_text,
        b.deputyStaffId !== undefined ? parseIntNullable(b.deputyStaffId) : ex.deputy_staff_id, b.deputyText !== undefined ? b.deputyText : ex.deputy_text,
        b.membersText !== undefined ? b.membersText : ex.members_text, memberIds, b.spanText !== undefined ? b.spanText : ex.span_text,
        parseIntNullable(b.displayOrder) ?? ex.display_order, req.params.rowId);
    res.json({ ok: true });
  });
  router.delete('/reassignment-rows/:rowId', requirePermission('personnel', 'edit'), (req, res) => {
    getDb().prepare('DELETE FROM reassignment_rows WHERE id = ?').run(req.params.rowId);
    res.json({ ok: true });
  });

  router.get('/reassignments/:id/print', requirePermission('personnel', 'view'), (req, res) => {
    const db = getDb();
    const s = loadReassignment(db, req.params.id) as any;
    if (!s) return res.status(404).send('Schedule not found');
    const h = labHeader(db);
    const supervisor = (r: any) => escHtml(r.supervisor_text || r.supervisor_name || '');
    const deputy = (r: any) => escHtml(r.deputy_text || r.deputy_name || '');
    let rowsHtml = '';
    for (const r of s.rows) {
      if (r.is_span) {
        rowsHtml += `<tr><td><b>${escHtml(r.unit_label)}</b></td><td colspan="3">${escHtml(r.span_text || r.members_text || '')}</td></tr>`;
      } else {
        rowsHtml += `<tr><td><b>${escHtml(r.unit_label)}</b></td><td>${supervisor(r)}</td><td>${deputy(r)}</td><td>${escHtml(r.members_text || '')}</td></tr>`;
      }
    }
    const nb = String(s.nb_notes || '').split('\n').filter(Boolean).map((n: string) => `<b>${escHtml(n)}</b>`).join('');
    const signName = s.signatory_name || '';
    const body = `<div class="memo">
      <h1>MEMO</h1>
      <div class="metaline"><b>TO:</b> ${escHtml(s.memo_to)}</div>
      <div class="metaline"><b>FROM:</b> ${escHtml(s.memo_from)}</div>
      <div class="metaline"><b>DATE:</b> ${escHtml(s.memo_date || '')}</div>
      <div class="metaline"><b>SUBJECT:</b> ${escHtml(s.subject)}</div>
      <div class="metaline">${escHtml(s.intro_text || '')}</div>
      <table><thead><tr><th>UNIT</th><th>SUPERVISOR</th><th>DEPUTY SUPERVISOR</th><th>MEMBER(S)</th></tr></thead><tbody>${rowsHtml}</tbody></table>
      <div class="nb"><u><b>NB:</b></u>${nb}</div>
      ${signName ? `<div class="sign">……………………………………<br/>${escHtml(signName)}</div>` : ''}
    </div>`;
    // Reassignment memo keeps a portrait layout; override the landscape default.
    const head = `<style>@page{size:A4 portrait;margin:14mm}</style>`;
    audit(req, { action: 'print', entity: 'reassignment_schedules', entityId: req.params.id });
    res.send(printShell(`${s.schedule_number} — Reassignment`, head, body, req.query.autoprint !== '0'));
  });

  // ========================= Bench schedules (per unit monthly grid) =========================
  router.get('/bench-schedules', requirePermission('personnel', 'view'), (req, res) => {
    const db = getDb();
    let q = 'SELECT bs.*, s.name AS section_name FROM bench_schedules bs JOIN sections s ON s.id = bs.section_id';
    const params: unknown[] = [];
    const cond: string[] = [];
    if (req.query.sectionId) { cond.push('bs.section_id = ?'); params.push(req.query.sectionId); }
    if (req.query.month) { cond.push('bs.month = ?'); params.push(req.query.month); }
    if (cond.length) q += ' WHERE ' + cond.join(' AND ');
    q += ' ORDER BY bs.month DESC, bs.id DESC';
    res.json(db.prepare(q).all(...params));
  });
  router.post('/bench-schedules', requirePermission('personnel', 'create'), (req, res) => {
    const db = getDb();
    const sectionId = parseIntNullable(req.body.sectionId);
    const month = String(req.body.month || '').trim();
    if (!sectionId) return res.status(400).json({ error: 'A unit/section is required.' });
    if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'A month (YYYY-MM) is required.' });
    const section = db.prepare('SELECT id, name FROM sections WHERE id = ?').get(sectionId) as any;
    if (!section) return res.status(404).json({ error: 'Unit not found' });
    const createdAt = new Date().toISOString();
    const num = generateRecordNumber(db, 'bench_schedules', 'BENCH', createdAt);
    const r = db.prepare(`INSERT INTO bench_schedules (schedule_number, section_id, month, title, status, prepared_by_staff_id, notes, created_by, created_at)
      VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?)`)
      .run(num, sectionId, month, req.body.title || `${section.name} Bench Schedule`, getStaffIdOrCurrent(req, req.body.preparedByStaffId), req.body.notes ?? null, req.user!.id, createdAt);
    const scheduleId = Number(r.lastInsertRowid);
    const insRow = db.prepare('INSERT INTO bench_schedule_rows (schedule_id, staff_id, label, display_order) VALUES (?, ?, ?, ?)');
    const copyFromId = parseIntNullable(req.body.copyFromId);
    const src = copyFromId ? db.prepare('SELECT * FROM bench_schedules WHERE id = ?').get(copyFromId) as any : null;
    if (src) {
      // Template from a previous bench schedule (rows + bench assignments).
      const daysInNew = monthMeta(month).days;
      const includeCells = req.body.copyCells !== false;
      const srcRows = db.prepare('SELECT * FROM bench_schedule_rows WHERE schedule_id = ? ORDER BY display_order, id').all(copyFromId) as any[];
      const insCell = db.prepare('INSERT OR IGNORE INTO bench_schedule_cells (schedule_id, row_id, day, value, note) VALUES (?, ?, ?, ?, ?)');
      for (const sr of srcRows) {
        const newRowId = Number(insRow.run(scheduleId, sr.staff_id, sr.label, sr.display_order).lastInsertRowid);
        if (includeCells) for (const c of db.prepare('SELECT * FROM bench_schedule_cells WHERE row_id = ? AND day <= ?').all(sr.id, daysInNew) as any[]) insCell.run(scheduleId, newRowId, c.day, c.value, c.note);
      }
    } else {
      const staff = db.prepare("SELECT id FROM staff WHERE section_id = ? AND is_active = 1 ORDER BY full_name").all(sectionId) as Array<{ id: number }>;
      staff.forEach((st, i) => insRow.run(scheduleId, st.id, null, i + 1));
    }
    audit(req, { action: 'create', entity: 'bench_schedules', entityId: scheduleId, newValue: { num, sectionId, month, copyFromId } });
    res.status(201).json({ id: scheduleId, scheduleNumber: num });
  });
  function loadBench(db: any, id: unknown) {
    const bs = db.prepare('SELECT bs.*, s.name AS section_name FROM bench_schedules bs JOIN sections s ON s.id = bs.section_id WHERE bs.id = ?').get(id);
    if (!bs) return null;
    const rows = db.prepare('SELECT r.*, s.full_name AS staff_name FROM bench_schedule_rows r LEFT JOIN staff s ON s.id = r.staff_id WHERE r.schedule_id = ? ORDER BY r.display_order, r.id').all(id);
    const cells = db.prepare('SELECT * FROM bench_schedule_cells WHERE schedule_id = ?').all(id);
    const benches = db.prepare('SELECT * FROM section_benches WHERE section_id = ? ORDER BY display_order, id').all((bs as any).section_id);
    return { ...bs, rows, cells, benches };
  }
  router.get('/bench-schedules/:id', requirePermission('personnel', 'view'), (req, res) => {
    const bs = loadBench(getDb(), req.params.id);
    if (!bs) return res.status(404).json({ error: 'Schedule not found' });
    res.json(bs);
  });
  router.put('/bench-schedules/:id', requirePermission('personnel', 'edit'), (req, res) => {
    const db = getDb();
    const ex = db.prepare('SELECT * FROM bench_schedules WHERE id = ?').get(req.params.id) as any;
    if (!ex) return res.status(404).json({ error: 'Schedule not found' });
    const b = req.body;
    db.prepare('UPDATE bench_schedules SET title = ?, month = ?, notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(b.title ?? ex.title, b.month && /^\d{4}-\d{2}$/.test(b.month) ? b.month : ex.month, b.notes ?? ex.notes, req.params.id);
    res.json({ ok: true });
  });
  router.delete('/bench-schedules/:id', requirePermission('personnel', 'void_archive'), (req, res) => {
    const db = getDb();
    db.prepare('DELETE FROM bench_schedule_cells WHERE schedule_id = ?').run(req.params.id);
    db.prepare('DELETE FROM bench_schedule_rows WHERE schedule_id = ?').run(req.params.id);
    db.prepare('DELETE FROM bench_schedules WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  });
  router.post('/bench-schedules/:id/rows', requirePermission('personnel', 'edit'), (req, res) => {
    const db = getDb();
    if (!db.prepare('SELECT id FROM bench_schedules WHERE id = ?').get(req.params.id)) return res.status(404).json({ error: 'Schedule not found' });
    const order = parseIntNullable(req.body.displayOrder) ?? (db.prepare('SELECT COALESCE(MAX(display_order),0)+1 n FROM bench_schedule_rows WHERE schedule_id = ?').get(req.params.id) as { n: number }).n;
    const r = db.prepare('INSERT INTO bench_schedule_rows (schedule_id, staff_id, label, display_order) VALUES (?, ?, ?, ?)')
      .run(req.params.id, parseIntNullable(req.body.staffId), req.body.label || null, order);
    res.status(201).json({ id: Number(r.lastInsertRowid) });
  });
  router.delete('/bench-schedule-rows/:rowId', requirePermission('personnel', 'edit'), (req, res) => {
    const db = getDb();
    db.prepare('DELETE FROM bench_schedule_cells WHERE row_id = ?').run(req.params.rowId);
    db.prepare('DELETE FROM bench_schedule_rows WHERE id = ?').run(req.params.rowId);
    res.json({ ok: true });
  });
  router.post('/bench-schedules/:id/cells', requirePermission('personnel', 'edit'), (req, res) => {
    const db = getDb();
    if (!db.prepare('SELECT id FROM bench_schedules WHERE id = ?').get(req.params.id)) return res.status(404).json({ error: 'Schedule not found' });
    const cells: Array<{ rowId: number; day: number; value?: string | null; note?: string | null }> = Array.isArray(req.body.cells) ? req.body.cells : [];
    const up = db.prepare(`INSERT INTO bench_schedule_cells (schedule_id, row_id, day, value, note) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(row_id, day) DO UPDATE SET value = excluded.value, note = excluded.note`);
    const del = db.prepare('DELETE FROM bench_schedule_cells WHERE row_id = ? AND day = ?');
    const tx = db.transaction(() => {
      for (const c of cells) {
        const v = (c.value ?? '').toString().trim();
        if (!v && !c.note) del.run(c.rowId, c.day);
        else up.run(req.params.id, c.rowId, c.day, v || null, c.note ?? null);
      }
    });
    tx();
    res.json({ ok: true });
  });
  router.post('/bench-schedules/:id/approve', requirePermission('personnel', 'approve'), (req, res) => {
    getDb().prepare("UPDATE bench_schedules SET status = 'approved', approved_by_staff_id = ?, approved_at = CURRENT_TIMESTAMP WHERE id = ?").run(getStaffIdOrCurrent(req, req.body.approvedByStaffId), req.params.id);
    res.json({ ok: true });
  });
  router.post('/bench-schedules/:id/publish', requirePermission('personnel', 'edit'), (req, res) => {
    getDb().prepare("UPDATE bench_schedules SET status = 'published', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
  });

  router.get('/bench-schedules/:id/print', requirePermission('personnel', 'view'), (req, res) => {
    const db = getDb();
    const bs = loadBench(db, req.params.id) as any;
    if (!bs) return res.status(404).send('Schedule not found');
    const mm = monthMeta(bs.month);
    const h = labHeader(db);
    const cellMap = new Map<string, any>();
    for (const c of bs.cells) cellMap.set(`${c.row_id}:${c.day}`, c);
    const dayNums = Array.from({ length: mm.days }, (_, i) => i + 1);
    let head1 = `<td class="monthcell">${escHtml(mm.label)}</td>`;
    for (const d of dayNums) head1 += `<td class="${mm.isWeekend(d) ? 'hdr-wknd' : 'hdr'}">${mm.weekdayOf(d)}</td>`;
    let head2 = `<th class="name">STAFF</th>`;
    for (const d of dayNums) head2 += `<td class="${mm.isWeekend(d) ? 'hdr-wknd' : 'hdr'}">${d}</td>`;
    let bodyRows = '';
    for (const row of bs.rows) {
      const name = row.staff_id ? row.staff_name : (row.label || '');
      let tds = '';
      for (const d of dayNums) {
        const v = cellMap.get(`${row.id}:${d}`)?.value || '';
        tds += `<td class="${mm.isWeekend(d) ? 'wknd' : ''}" style="font-weight:bold">${escHtml(v)}</td>`;
      }
      bodyRows += `<tr><td class="name">${escHtml(name)}</td>${tds}</tr>`;
    }
    const colW = `<colgroup><col style="width:120px"/>${dayNums.map(() => '<col/>').join('')}</colgroup>`;
    const table = `<table class="grid">${colW}<thead><tr>${head1}</tr><tr>${head2}</tr></thead><tbody>${bodyRows}</tbody></table>`;
    const legend = bs.benches.length ? `<div class="legend">${bs.benches.map((b: any) => `<span><b>${escHtml(b.code || b.name)}</b>: ${escHtml(b.name)}</span>`).join('')}</div>` : '';
    const orgLines = escHtml(h.org) + (h.facility ? `<br/>${escHtml(h.facility)}` : '');
    const headHtml = mastheadHtml(h, orgLines, `${(bs.section_name || '').toUpperCase()} — BENCH SCHEDULE — ${mm.label}`);
    audit(req, { action: 'print', entity: 'bench_schedules', entityId: req.params.id });
    res.send(printShell(`${bs.schedule_number} — Bench Schedule`, headHtml, table + legend, req.query.autoprint !== '0'));
  });

  return router;
}
