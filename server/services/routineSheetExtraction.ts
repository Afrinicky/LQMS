/**
 * Reading a month off an attached chart.
 *
 * Laboratories will keep charting on paper for a while yet, and the honest
 * answer to "the system should read the chart" has two halves.
 *
 * Where the attachment is *structured* — a spreadsheet, a CSV, a Word table,
 * the analyser's own export — it is read exactly, here, offline, with no
 * guessing. That covers the automated-logger exports and every laboratory that
 * already keeps its month in Excel, and it is the common case.
 *
 * Where it is a *photograph of handwriting*, no offline library can be trusted
 * with a temperature. So the pipeline is built and the reader is pluggable: if
 * the laboratory has configured a recognition service (an on-premises OCR
 * endpoint on the LAN — nothing leaves the building), it is called and every
 * cell it returns comes back flagged for review with the confidence it gave.
 * If none is configured, the attachment is kept, the grid is put beside the
 * image, and the person types the month in against the picture — which is
 * still a great deal better than retyping from a folder in another room.
 *
 * What it never does is accept a number it is unsure of. A confidently wrong
 * fridge temperature is worse than a blank cell, because a blank cell gets
 * noticed and signed for.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as XLSX from 'xlsx';
import AdmZip from 'adm-zip';
import { uploadRoot, evidenceRoot } from '../db/database.js';
import { parseSheetWorkbook } from './routineSheetRender.js';
import { EXTRACTION_REVIEW_THRESHOLD, SLOT_LABELS, type CellSlot } from '../../shared/constants/routineWork.js';

type DB = any;

export interface ExtractionOutcome {
  status: 'partial' | 'complete' | 'failed';
  note: string;
  cells: any[];
  reader: string;
  needsReview: number;
}

/* ============================================================================
   Where the attached file lives
   ========================================================================= */
function attachmentPath(db: DB, sheet: any): { file: any; fullPath: string } | null {
  const file = db.prepare('SELECT * FROM files WHERE id = ?').get(sheet.attachment_file_id) as any;
  if (!file) return null;
  const root = file.storage_area === 'evidence' ? evidenceRoot : uploadRoot;
  const fullPath = path.join(root, file.stored_name);
  if (!fs.existsSync(fullPath)) return null;
  return { file, fullPath };
}

/* ============================================================================
   The entry point
   ========================================================================= */
export async function extractSheetFromFile(db: DB, sheetId: number): Promise<ExtractionOutcome> {
  const sheet = db.prepare('SELECT * FROM routine_log_sheets WHERE id = ?').get(sheetId) as any;
  if (!sheet) throw new Error('Log sheet not found');
  const located = attachmentPath(db, sheet);
  if (!located) throw new Error('The attached file could not be found on disk. Re-attach it and try again.');

  const { file, fullPath } = located;
  const name = String(file.original_name || '').toLowerCase();
  const mime = String(file.mime_type || '').toLowerCase();

  if (name.endsWith('.xlsx') || name.endsWith('.xls') || name.endsWith('.csv') || mime.includes('spreadsheet') || mime.includes('excel') || mime === 'text/csv') {
    return fromWorkbook(db, sheet, fullPath);
  }
  if (name.endsWith('.docx') || mime.includes('wordprocessingml')) {
    return fromWordTable(db, sheet, fullPath);
  }
  if (mime.startsWith('image/') || name.endsWith('.pdf') || mime === 'application/pdf') {
    return fromScan(db, sheet, fullPath, file);
  }
  return {
    status: 'failed', reader: 'none', needsReview: 0, cells: [],
    note: `The system does not know how to read a ${file.mime_type || 'file of that type'}. Attach the month as a spreadsheet, a Word table, or a photograph of the chart.`,
  };
}

/* ============================================================================
   Structured files — read exactly
   ========================================================================= */
function fromWorkbook(db: DB, sheet: any, fullPath: string): ExtractionOutcome {
  const buffer = fs.readFileSync(fullPath);
  const parsed = parseSheetWorkbook(db, sheet.id, buffer);
  if (!parsed.cells.length) {
    return {
      status: 'failed', reader: 'workbook', needsReview: 0, cells: [],
      note: 'Nothing in that spreadsheet matched this sheet\'s entries. Download the blank month from this sheet and paste your values into it — the first two columns are what the match is made on.'
        + (parsed.unmatched.length ? ` Unrecognised: ${parsed.unmatched.slice(0, 6).join('; ')}.` : ''),
    };
  }
  // A spreadsheet is exact. Nothing is flagged, because there is nothing to
  // doubt: the number in the cell is the number that was written.
  return {
    status: 'complete', reader: 'workbook', needsReview: 0,
    cells: parsed.cells.map(c => ({ ...c, source: 'import' })),
    note: `${parsed.cells.length} entries read from the spreadsheet.`
      + (parsed.unmatched.length ? ` ${parsed.unmatched.length} row(s) did not match anything on this sheet and were left out.` : ''),
  };
}

/**
 * A Word chart, read out of the document's own table.
 *
 * docx is a zip with an XML document inside it, and its tables are structured —
 * so the same day-by-row grid the paper form uses can be lifted straight out
 * without any guessing. No library beyond the zip reader already in the project.
 */
function fromWordTable(db: DB, sheet: any, fullPath: string): ExtractionOutcome {
  let xml: string;
  try {
    const zip = new AdmZip(fullPath);
    const entry = zip.getEntry('word/document.xml');
    if (!entry) throw new Error('no document.xml');
    xml = zip.readAsText(entry);
  } catch {
    return { status: 'failed', reader: 'docx', needsReview: 0, cells: [], note: 'That Word file could not be opened. Save it as .docx (not .doc) and attach it again.' };
  }

  const tables = wordTables(xml);
  if (!tables.length) {
    return { status: 'failed', reader: 'docx', needsReview: 0, cells: [], note: 'No table was found in that Word document. The chart has to be a real table, not a picture pasted into the page.' };
  }
  // Turn the largest table into the same shape a spreadsheet import produces,
  // then reuse exactly one parser rather than maintaining two.
  const grid = tables.sort((a, b) => b.length * (b[0]?.length ?? 0) - a.length * (a[0]?.length ?? 0))[0];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(grid), 'Chart');
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  const parsed = parseSheetWorkbook(db, sheet.id, buffer);

  if (!parsed.cells.length) {
    return {
      status: 'failed', reader: 'docx', needsReview: 0, cells: [],
      note: 'The table was read, but none of its rows matched this sheet\'s entries. The first column of each row has to carry the entry name as it appears on the sheet.',
    };
  }
  return {
    status: 'complete', reader: 'docx', needsReview: 0,
    cells: parsed.cells.map(c => ({ ...c, source: 'import' })),
    note: `${parsed.cells.length} entries read from the Word table.`,
  };
}

/** Every table in a docx, as rows of cell text. */
function wordTables(xml: string): string[][][] {
  const tables: string[][][] = [];
  const tableMatches = xml.match(/<w:tbl>[\s\S]*?<\/w:tbl>/g) ?? [];
  for (const table of tableMatches) {
    const rows: string[][] = [];
    for (const row of table.match(/<w:tr[\s\S]*?<\/w:tr>/g) ?? []) {
      const cells: string[] = [];
      for (const cell of row.match(/<w:tc>[\s\S]*?<\/w:tc>/g) ?? []) {
        const text = (cell.match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g) ?? [])
          .map(t => t.replace(/<[^>]+>/g, ''))
          .join('')
          .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
          .trim();
        cells.push(text);
      }
      if (cells.length) rows.push(cells);
    }
    if (rows.length) tables.push(rows);
  }
  return tables;
}

/* ============================================================================
   A photograph of a handwritten chart
   ========================================================================= */

/**
 * The recognition service, if the laboratory has one.
 *
 * Kept as a plain HTTP endpoint on the laboratory's own network rather than a
 * bundled model: the hardware this runs on will not carry a vision model, and
 * a patient-adjacent record must not be posted to somebody else's cloud without
 * the laboratory deciding to. Set `routine.ocrEndpoint` in Settings to switch
 * it on.
 */
interface ReaderConfig { endpoint: string | null; timeoutMs: number; }

function readerConfig(db: DB): ReaderConfig {
  const get = (key: string) => (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as any)?.value ?? null;
  return {
    endpoint: get('routine.ocrEndpoint'),
    timeoutMs: Number(get('routine.ocrTimeoutMs') || 30000),
  };
}

async function fromScan(db: DB, sheet: any, fullPath: string, file: any): Promise<ExtractionOutcome> {
  const config = readerConfig(db);
  const rows = db.prepare('SELECT * FROM routine_log_rows WHERE sheet_id = ? ORDER BY display_order, id').all(sheet.id) as any[];

  if (!config.endpoint) {
    return {
      status: 'partial', reader: 'manual', needsReview: 0, cells: [],
      note: 'The chart is attached and shown beside the grid. No handwriting reader is configured on this laboratory\'s network, '
        + 'so the month is typed in against the picture rather than guessed at — which is what an assessor would want anyway. '
        + 'An administrator can point the system at an on-premises recognition service under Settings → Routine Work.',
    };
  }

  let payload: any;
  try {
    const image = fs.readFileSync(fullPath);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    const response = await fetch(config.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        // What the reader is looking at, so it can align columns to days rather
        // than guessing the shape of the grid from the pixels alone.
        month: sheet.month,
        title: sheet.title,
        rows: rows.map(r => ({ key: r.row_key, label: r.label, type: r.row_type, unit: r.unit, slots: safeSlots(r.slots) })),
        mimeType: file.mime_type,
        fileName: file.original_name,
        imageBase64: image.toString('base64'),
      }),
    });
    clearTimeout(timer);
    if (!response.ok) throw new Error(`the reader returned ${response.status}`);
    payload = await response.json();
  } catch (error) {
    return {
      status: 'failed', reader: 'service', needsReview: 0, cells: [],
      note: `The handwriting reader could not be reached (${(error as Error).message}). The chart is still attached — enter the month against the picture, or try again once the service is back.`,
    };
  }

  const byKey = new Map(rows.map(r => [String(r.row_key), r]));
  const cells: any[] = [];
  let lowConfidence = 0;
  for (const item of Array.isArray(payload?.cells) ? payload.cells : []) {
    const row = byKey.get(String(item.rowKey));
    if (!row) continue;
    const confidence = Number(item.confidence ?? 0);
    const uncertain = !Number.isFinite(confidence) || confidence < EXTRACTION_REVIEW_THRESHOLD;
    if (uncertain) lowConfidence++;
    const base = {
      rowId: row.id, day: Number(item.day), slot: String(item.slot || 'once'),
      initials: item.initials ?? null, source: 'extraction',
      confidence: Number.isFinite(confidence) ? confidence : null,
      // Everything read off handwriting is put in front of a person. The
      // confidence decides how loudly, not whether.
      needsReview: true,
    };
    if (row.row_type === 'numeric') {
      const value = Number(item.value);
      if (!Number.isFinite(value)) continue;
      cells.push({ ...base, value });
    } else if (row.row_type === 'text') {
      if (!item.value) continue;
      cells.push({ ...base, text: String(item.value) });
    } else {
      cells.push({ ...base, done: item.value !== false && String(item.value).toUpperCase() !== 'N' });
    }
  }

  const expected = expectedCellCount(db, sheet, rows);
  const status = cells.length >= expected ? 'complete' : 'partial';
  return {
    status, reader: 'service', cells, needsReview: cells.length,
    note: `${cells.length} of about ${expected} entries were read off the chart`
      + (lowConfidence ? `, ${lowConfidence} of them uncertain` : '')
      + `. Every one of them is marked for you to confirm before the month can be signed — check them against the picture, correct what is wrong, and fill anything the reader missed.`,
  };
}

function safeSlots(value: unknown): CellSlot[] {
  try { const parsed = JSON.parse(String(value)); return Array.isArray(parsed) ? parsed : ['once']; }
  catch { return ['once']; }
}

function expectedCellCount(db: DB, sheet: any, rows: any[]): number {
  const [year, month] = sheet.month.split('-').map(Number);
  const days = new Date(year, month, 0).getDate();
  let total = 0;
  for (const row of rows) {
    const slots = safeSlots(row.slots);
    total += row.cadence === 'weekly' ? slots.length : days * slots.length;
  }
  return total;
}

/** Human labels for the slots, used in extraction feedback. */
export function slotLabel(slot: string): string {
  return SLOT_LABELS[slot as CellSlot] ?? slot;
}
