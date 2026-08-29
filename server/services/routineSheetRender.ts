/**
 * Printing and exporting a monthly log sheet.
 *
 * The output has to be recognisable. A supervisor who has signed a paper
 * temperature chart every month for nine years should be able to look at what
 * this prints and see the same document — days across the top, the readings
 * down the side, AM and PM, initials, and their own signature at the bottom.
 * A print-out that reorganises the form into something "cleaner" is a print-out
 * nobody trusts, and an assessor has to learn twice.
 *
 * So the layout follows the laboratory's own forms, and what it adds it adds at
 * the edges: the time each reading was taken, which cells were out of range,
 * where a value came from, and the electronic signature block that replaces the
 * biro. The Excel export carries the same grid, which is what the leadership
 * asked to be able to take away.
 */
import * as XLSX from 'xlsx';
import {
  daysInMonth, monthLabel, SLOT_LABELS, CELL_STATUS_LABELS, CELL_SOURCE_LABELS,
  cellIsBreach, type CellSlot,
} from '../../shared/constants/routineWork.js';

type DB = any;

const esc = (v: unknown) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

interface Loaded {
  sheet: any;
  rows: any[];
  cells: Map<string, any>;
  days: number;
  section: any;
  laboratory: string;
  verifier: string | null;
  signature: any;
}

function slotsOf(row: any): CellSlot[] {
  try { const parsed = JSON.parse(row.slots); return Array.isArray(parsed) ? parsed : ['once']; }
  catch { return ['once']; }
}

function load(db: DB, sheetId: number): Loaded | null {
  const sheet = db.prepare('SELECT * FROM routine_log_sheets WHERE id = ?').get(sheetId) as any;
  if (!sheet) return null;
  const rows = db.prepare('SELECT * FROM routine_log_rows WHERE sheet_id = ? ORDER BY display_order, id').all(sheetId) as any[];
  const cellRows = db.prepare(`SELECT c.*, s.full_name AS recorded_by_name FROM routine_log_cells c
      LEFT JOIN staff s ON s.id = c.recorded_by_staff_id WHERE c.sheet_id = ?`).all(sheetId) as any[];
  const cells = new Map<string, any>();
  for (const c of cellRows) cells.set(`${c.row_id}:${c.day}:${c.slot}`, c);

  const section = sheet.section_id ? db.prepare('SELECT name FROM sections WHERE id = ?').get(sheet.section_id) as any : null;
  const org = db.prepare("SELECT value FROM settings WHERE key = 'organisation.name'").get() as any;
  const verifier = sheet.verified_by_staff_id
    ? (db.prepare('SELECT full_name FROM staff WHERE id = ?').get(sheet.verified_by_staff_id) as any)?.full_name ?? null
    : null;
  const signature = sheet.verification_signature_id
    ? db.prepare('SELECT * FROM e_signatures WHERE id = ?').get(sheet.verification_signature_id) as any : null;

  return {
    sheet, rows, cells, days: daysInMonth(sheet.month), section,
    laboratory: org?.value || 'Laboratory',
    verifier, signature,
  };
}

/** What goes in a printed cell: the number, a tick, or a dash for a gap. */
function cellText(cell: any | undefined, rowType: string): string {
  if (!cell) return '';
  if (cell.status === 'na') return 'N/A';
  if (rowType === 'numeric') return cell.value_num != null ? String(cell.value_num) : '';
  if (rowType === 'text') return cell.value_text ?? '';
  return cell.status === 'not_done' ? '✗' : '✓';
}

function cellClass(cell: any | undefined): string {
  if (!cell) return 'blank';
  if (cellIsBreach(cell.status)) return 'breach';
  if (cell.status === 'warning') return 'warn';
  if (cell.status === 'na') return 'na';
  return '';
}

/* ============================================================================
   The printable sheet
   ========================================================================= */
export function sheetToHtml(db: DB, sheetId: number, autoprint: boolean): string | null {
  const data = load(db, sheetId);
  if (!data) return null;
  const { sheet, rows, cells, days } = data;

  const dayHeaders = Array.from({ length: days }, (_, i) => i + 1);
  const daily = rows.filter(r => r.cadence !== 'weekly');
  const weekly = rows.filter(r => r.cadence === 'weekly');

  const dailyBody = daily.map(row => {
    const slots = slotsOf(row);
    return slots.map((slot, index) => `<tr>
      ${index === 0 ? `<th class="rowhead" rowspan="${slots.length * 2}">${esc(row.label)}</th>` : ''}
      <th class="slot">${esc(SLOT_LABELS[slot] ?? slot)}</th>
      ${dayHeaders.map(d => {
        const cell = cells.get(`${row.id}:${d}:${slot}`);
        return `<td class="${cellClass(cell)}">${esc(cellText(cell, row.row_type))}</td>`;
      }).join('')}
    </tr>
    <tr>
      <th class="slot init">Initial</th>
      ${dayHeaders.map(d => {
        const cell = cells.get(`${row.id}:${d}:${slot}`);
        return `<td class="init">${esc(cell?.initials ?? '')}</td>`;
      }).join('')}
    </tr>`).join('');
  }).join('');

  const weeklyBody = weekly.length ? `
    <h2>Weekly and monthly tasks</h2>
    <table class="grid weeks">
      <thead><tr><th class="rowhead">Task</th>${['Week 1', 'Week 2', 'Week 3', 'Week 4', 'Week 5'].map(w => `<th>${w}</th>`).join('')}</tr></thead>
      <tbody>
        ${weekly.map(row => {
          const slots = slotsOf(row);
          return `<tr><th class="rowhead">${esc(row.label)}</th>${[1, 2, 3, 4, 5].map(w => {
            const slot = slots.length === 1 ? slots[0] : (slots[w - 1] ?? `w${w}`);
            const cell = cells.get(`${row.id}:${w}:${slot}`);
            const initials = cell?.initials ? `<span class="ini">${esc(cell.initials)}</span>` : '';
            return `<td class="${cellClass(cell)}">${esc(cellText(cell, row.row_type))} ${initials}</td>`;
          }).join('')}</tr>`;
        }).join('')}
      </tbody>
    </table>` : '';

  // Everything out of range or not done, listed under the grid. On paper this
  // is what the "comments" line was always trying and failing to hold.
  const breaches = [...cells.values()].filter(c => cellIsBreach(c.status)).sort((a, b) => a.day - b.day);
  const breachBlock = breaches.length ? `
    <h2>Out of range / not done — ${breaches.length}</h2>
    <table class="list">
      <thead><tr><th>Day</th><th>Slot</th><th>Entry</th><th>Value</th><th>Recorded by</th><th>What was done about it</th></tr></thead>
      <tbody>${breaches.map(c => {
        const row = rows.find(r => r.id === c.row_id);
        return `<tr><td>${c.day}</td><td>${esc(SLOT_LABELS[c.slot as CellSlot] ?? c.slot)}</td>
          <td>${esc(row?.label ?? '')}</td>
          <td>${esc(c.value_num != null ? `${c.value_num}${row?.unit ? ` ${row.unit}` : ''}` : CELL_STATUS_LABELS[c.status as keyof typeof CELL_STATUS_LABELS] ?? c.status)}</td>
          <td>${esc(c.recorded_by_name ?? '')}</td>
          <td>${esc(c.note ?? '—')}</td></tr>`;
      }).join('')}</tbody>
    </table>` : '';

  const signatureBlock = data.signature ? `
    <div class="sigblock">
      <div><span class="siglabel">Reviewed and verified by</span><span class="signame">${esc(data.verifier ?? data.signature.signer_name)}</span></div>
      <div><span class="siglabel">Signed</span><span>${esc(String(data.signature.signed_at).slice(0, 16).replace('T', ' '))}</span></div>
      <div class="sigmeaning">${esc(data.signature.meaning ?? '')}</div>
      <div class="sigref">Electronic signature reference E-SIG-${data.signature.id}. Recorded in the audit trail with the signer, time and device.</div>
    </div>` : `
    <div class="siglines">
      <div>Reviewed by: <span class="dots"></span></div>
      <div>Comments: <span class="dots"></span></div>
      <div>Date: <span class="dots short"></span></div>
    </div>`;

  const auto = autoprint ? '<script>window.addEventListener("load",()=>setTimeout(()=>window.print(),250));</script>' : '';

  return `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>${esc(sheet.title)} — ${esc(monthLabel(sheet.month))}</title>
<style>
@page{size:A4 landscape;margin:10mm}
body{font-family:'Times New Roman',Georgia,serif;color:#111;padding:14px 18px;line-height:1.35}
.no-print{background:#f4f6fb;padding:8px 12px;border:1px solid #ccd;border-radius:6px;margin-bottom:12px;font-size:12px}
h1{font-size:17px;text-align:center;margin:0 0 2px;text-transform:uppercase;letter-spacing:.4px}
.org{text-align:center;font-size:13px;font-weight:bold;margin-bottom:2px}
.meta{display:flex;gap:26px;flex-wrap:wrap;font-size:11px;margin:8px 0 6px;border-bottom:1px solid #999;padding-bottom:6px}
.meta b{font-weight:bold}
h2{font-size:12px;margin:14px 0 4px;color:#1B3A6B}
table.grid{border-collapse:collapse;width:100%;font-size:8.5px;table-layout:fixed}
table.grid th,table.grid td{border:1px solid #777;padding:1px 2px;text-align:center;height:15px;overflow:hidden}
table.grid thead th{background:#eef2f7;font-size:8.5px}
th.rowhead{text-align:left;width:150px;font-size:9px;padding:2px 4px;background:#f7f9fc}
th.slot{width:34px;background:#f7f9fc;font-size:8px}
td.init,th.init{background:#fcfcfd;font-size:8px;font-style:italic}
td.blank{background:repeating-linear-gradient(45deg,#fff,#fff 3px,#f4f4f4 3px,#f4f4f4 6px)}
td.breach{background:#ffe1e1;font-weight:bold}
td.warn{background:#fff4d6}
td.na{background:#eef0f3;color:#666}
table.weeks td{height:20px}
.ini{font-size:7.5px;font-style:italic;color:#444}
table.list{border-collapse:collapse;width:100%;font-size:9.5px;margin-top:4px}
table.list th,table.list td{border:1px solid #999;padding:3px 5px;text-align:left}
table.list thead th{background:#eef2f7}
.sigblock{margin-top:16px;border:1px solid #777;padding:8px 10px;font-size:10.5px;max-width:520px}
.sigblock div{margin:2px 0}
.siglabel{display:inline-block;width:150px;color:#444}
.signame{font-weight:bold}
.sigmeaning{margin-top:6px;font-style:italic;color:#333}
.sigref{margin-top:6px;font-size:9px;color:#555}
.siglines{margin-top:20px;font-size:11px}
.siglines div{margin:10px 0}
.dots{display:inline-block;border-bottom:1px dotted #333;width:420px}
.dots.short{width:160px}
.footer{font-size:9px;color:#555;margin-top:14px;border-top:1px solid #ccc;padding-top:5px}
.legend{font-size:9px;color:#444;margin-top:6px}
.legend span{margin-right:14px}
.swatch{display:inline-block;width:9px;height:9px;border:1px solid #777;vertical-align:-1px;margin-right:3px}
@media print{.no-print{display:none}body{padding:0}}
</style>${auto}</head><body>
<div class="no-print">Choose any printer or "Save as PDF". <button onclick="window.print()">Print</button></div>
<div class="org">${esc(data.laboratory)}</div>
<h1>${esc(sheet.title)}</h1>
<div class="meta">
  <span><b>Unit:</b> ${esc(data.section?.name ?? '—')}</span>
  <span><b>Month / Year:</b> ${esc(monthLabel(sheet.month))}</span>
  ${sheet.subtitle ? `<span><b>${esc(sheet.subtitle)}</b></span>` : ''}
  <span><b>Status:</b> ${esc(sheet.status)}</span>
</div>

${daily.length ? `<table class="grid">
  <thead><tr><th class="rowhead">Entry</th><th class="slot"></th>${dayHeaders.map(d => `<th>${d}</th>`).join('')}</tr></thead>
  <tbody>${dailyBody}</tbody>
</table>` : ''}
${weeklyBody}

<div class="legend">
  <span><i class="swatch" style="background:#fff"></i>Recorded</span>
  <span><i class="swatch" style="background:#ffe1e1"></i>Out of range / not done</span>
  <span><i class="swatch" style="background:#fff4d6"></i>Approaching a limit</span>
  <span><i class="swatch" style="background:#eef0f3"></i>Not applicable</span>
  <span><i class="swatch" style="background:#f4f4f4"></i>No entry recorded</span>
</div>

${breachBlock}

${sheet.verification_comments ? `<h2>Reviewer's comments</h2><p style="font-size:10.5px">${esc(sheet.verification_comments)}</p>` : ''}
${signatureBlock}
<div class="footer">SECH_LIMS by Nickland · ${esc(sheet.title)} · ${esc(monthLabel(sheet.month))} · printed ${new Date().toISOString().slice(0, 16).replace('T', ' ')}</div>
</body></html>`;
}

/* ============================================================================
   The workbook
   ----------------------------------------------------------------------------
   Two sheets: the grid as it prints, and a flat listing of every entry with its
   time, its status, who recorded it and where it came from. The grid is what a
   supervisor wants; the listing is what anyone analysing a year of charts wants,
   and neither is much use pretending to be the other.
   ========================================================================= */
export function sheetToWorkbook(db: DB, sheetId: number): XLSX.WorkBook | null {
  const data = load(db, sheetId);
  if (!data) return null;
  const { sheet, rows, cells, days } = data;

  const grid: (string | number | null)[][] = [];
  grid.push([data.laboratory]);
  grid.push([sheet.title]);
  grid.push([`Unit: ${data.section?.name ?? '—'}`, `Month: ${monthLabel(sheet.month)}`, sheet.subtitle ?? '']);
  grid.push([]);

  const dayHeaders = Array.from({ length: days }, (_, i) => i + 1);
  const daily = rows.filter(r => r.cadence !== 'weekly');
  const weekly = rows.filter(r => r.cadence === 'weekly');

  if (daily.length) {
    grid.push(['Entry', '', ...dayHeaders]);
    for (const row of daily) {
      for (const slot of slotsOf(row)) {
        grid.push([row.label, SLOT_LABELS[slot] ?? slot,
          ...dayHeaders.map(d => {
            const cell = cells.get(`${row.id}:${d}:${slot}`);
            if (!cell) return null;
            if (row.row_type === 'numeric') return cell.value_num;
            if (row.row_type === 'text') return cell.value_text;
            return cell.status === 'not_done' ? 'Not done' : cell.status === 'na' ? 'N/A' : 'Done';
          })]);
        grid.push(['', 'Initial', ...dayHeaders.map(d => cells.get(`${row.id}:${d}:${slot}`)?.initials ?? null)]);
      }
    }
  }

  if (weekly.length) {
    grid.push([]);
    grid.push(['Weekly / monthly tasks', 'Week 1', 'Week 2', 'Week 3', 'Week 4', 'Week 5']);
    for (const row of weekly) {
      const slots = slotsOf(row);
      grid.push([row.label, ...[1, 2, 3, 4, 5].map(w => {
        const slot = slots.length === 1 ? slots[0] : (slots[w - 1] ?? `w${w}`);
        const cell = cells.get(`${row.id}:${w}:${slot}`);
        if (!cell) return null;
        return cell.status === 'not_done' ? 'Not done' : cell.status === 'na' ? 'N/A' : `Done${cell.initials ? ` (${cell.initials})` : ''}`;
      })]);
    }
  }

  grid.push([]);
  grid.push(['Reviewed and verified by', data.verifier ?? '']);
  grid.push(['Verified at', sheet.verified_at ?? '']);
  grid.push(['Comments', sheet.verification_comments ?? '']);

  const listing: (string | number | null)[][] = [[
    'Day', 'Slot', 'Entry', 'Unit', 'Value', 'Status', 'Time read', 'Initials', 'Recorded by', 'Source', 'Note',
  ]];
  const rowById = new Map(rows.map(r => [Number(r.id), r]));
  for (const cell of [...cells.values()].sort((a, b) => a.day - b.day || String(a.slot).localeCompare(String(b.slot)))) {
    const row = rowById.get(Number(cell.row_id));
    listing.push([
      cell.day, SLOT_LABELS[cell.slot as CellSlot] ?? cell.slot, row?.label ?? '', row?.unit ?? '',
      cell.value_num ?? cell.value_text ?? (cell.status === 'done' ? 'Done' : cell.status === 'not_done' ? 'Not done' : ''),
      CELL_STATUS_LABELS[cell.status as keyof typeof CELL_STATUS_LABELS] ?? cell.status,
      cell.reading_time ?? '', cell.initials ?? '', cell.recorded_by_name ?? '',
      CELL_SOURCE_LABELS[cell.source as keyof typeof CELL_SOURCE_LABELS] ?? cell.source,
      cell.note ?? '',
    ]);
  }

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(grid), 'Chart');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(listing), 'Entries');
  return workbook;
}

/**
 * A blank month, as a spreadsheet, in exactly the shape the sheet stores.
 *
 * This is the other half of the copy-and-paste story: a unit that keeps its
 * readings in Excel already fills this in, uploads it, and the month lands
 * whole — rather than typing 62 numbers into a browser.
 */
export function sheetTemplateWorkbook(db: DB, sheetId: number): XLSX.WorkBook | null {
  const data = load(db, sheetId);
  if (!data) return null;
  const { sheet, rows, days } = data;
  const dayHeaders = Array.from({ length: days }, (_, i) => i + 1);

  const aoa: (string | number | null)[][] = [];
  aoa.push([`${sheet.title} — ${monthLabel(sheet.month)}`]);
  aoa.push(['Fill the cells below. Leave a cell empty for no entry. Do not change the first two columns or the day row.']);
  aoa.push([]);
  aoa.push(['Entry', 'Slot', ...dayHeaders]);
  for (const row of rows) {
    const slots = slotsOf(row);
    if (row.cadence === 'weekly') {
      aoa.push([row.label, 'Weeks 1-5', ...Array.from({ length: 5 }, () => null)]);
      continue;
    }
    for (const slot of slots) {
      aoa.push([row.label, SLOT_LABELS[slot] ?? slot, ...dayHeaders.map(() => null)]);
      aoa.push(['', 'Initial', ...dayHeaders.map(() => null)]);
    }
  }

  const guide: (string | number | null)[][] = [
    ['Entry', 'Slot', 'Type', 'Unit', 'Acceptable from', 'Acceptable to', 'What to write in a cell'],
    ...rows.flatMap(row => slotsOf(row).map(slot => [
      row.label, SLOT_LABELS[slot] ?? slot, row.row_type, row.unit ?? '',
      row.min_value ?? '', row.max_value ?? '',
      row.row_type === 'numeric' ? 'The measured number' : row.row_type === 'text' ? 'A short note' : 'Y for done, N for not done, NA where it does not apply',
    ])),
  ];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(aoa), 'Chart');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(guide), 'How to fill it');
  return workbook;
}

/**
 * Read a filled template back in.
 *
 * Matching is by the entry label and slot in the first two columns rather than
 * by position, so a spreadsheet that has had a row inserted still lands
 * correctly — which is what actually happens to a file that has been round a
 * laboratory a few times.
 */
export function parseSheetWorkbook(db: DB, sheetId: number, buffer: Buffer): { cells: any[]; unmatched: string[] } {
  const data = load(db, sheetId);
  if (!data) return { cells: [], unmatched: [] };
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const first = workbook.Sheets[workbook.SheetNames[0]];
  const grid = XLSX.utils.sheet_to_json<(string | number | null)[]>(first, { header: 1, blankrows: false, defval: null });

  const norm = (v: unknown) => String(v ?? '').trim().toLowerCase();
  const bySlotLabel = new Map<string, CellSlot>();
  for (const [slot, label] of Object.entries(SLOT_LABELS)) bySlotLabel.set(norm(label), slot as CellSlot);

  const byLabel = new Map<string, any>();
  for (const row of data.rows) byLabel.set(norm(row.label), row);

  const out: any[] = [];
  const unmatched: string[] = [];
  let currentRow: any = null;
  let currentSlot: CellSlot | null = null;

  for (const line of grid) {
    if (!Array.isArray(line)) continue;
    const label = norm(line[0]);
    const slotCell = norm(line[1]);
    if (label && byLabel.has(label)) currentRow = byLabel.get(label);
    else if (label && !bySlotLabel.has(slotCell) && slotCell !== 'initial' && label !== 'entry' && line.slice(2).some(v => v != null && v !== '')) {
      if (!byLabel.has(label)) unmatched.push(String(line[0]));
    }
    if (!currentRow) continue;

    if (slotCell === 'initial') {
      // The initials line under the values it belongs to.
      line.slice(2).forEach((value, index) => {
        if (value == null || value === '') return;
        out.push({ rowId: currentRow.id, day: index + 1, slot: currentSlot ?? 'once', initials: String(value).trim(), source: 'import', initialsOnly: true });
      });
      continue;
    }

    const slot = bySlotLabel.get(slotCell) ?? (slotsOf(currentRow)[0] ?? 'once');
    currentSlot = slot;
    const weekly = currentRow.cadence === 'weekly';
    line.slice(2).forEach((value, index) => {
      if (value == null || value === '') return;
      const day = index + 1;
      if (weekly && day > 5) return;
      const text = String(value).trim();
      if (currentRow.row_type === 'numeric') {
        const numeric = Number(text);
        if (Number.isNaN(numeric)) { unmatched.push(`${currentRow.label} day ${day}: "${text}" is not a number`); return; }
        out.push({ rowId: currentRow.id, day, slot: weekly ? slotsOf(currentRow)[day - 1] ?? slot : slot, value: numeric, source: 'import' });
      } else if (currentRow.row_type === 'text') {
        out.push({ rowId: currentRow.id, day, slot, text, source: 'import' });
      } else {
        const upper = text.toUpperCase();
        if (upper === 'NA' || upper === 'N/A') out.push({ rowId: currentRow.id, day, slot: weekly ? slotsOf(currentRow)[day - 1] ?? slot : slot, na: true, source: 'import' });
        else out.push({ rowId: currentRow.id, day, slot: weekly ? slotsOf(currentRow)[day - 1] ?? slot : slot, done: !['N', 'NO', '✗', 'X', 'NOT DONE'].includes(upper), source: 'import' });
      }
    });
  }

  // Fold the initials rows into the value rows they belong to, so one cell is
  // written once with both.
  const merged = new Map<string, any>();
  for (const cell of out) {
    const key = `${cell.rowId}:${cell.day}:${cell.slot}`;
    const existing = merged.get(key);
    if (!existing) { merged.set(key, cell); continue; }
    merged.set(key, { ...existing, ...cell, initialsOnly: existing.initialsOnly && cell.initialsOnly });
  }
  return {
    cells: [...merged.values()].filter(c => !c.initialsOnly),
    unmatched: [...new Set(unmatched)].slice(0, 20),
  };
}
