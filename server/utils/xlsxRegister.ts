import * as XLSX from 'xlsx';
import type { Response } from 'express';

// Shared helpers for the register Excel export/import endpoints (IQC, EQA,
// reference intervals, measurement uncertainty, …). buildWorkbook turns a header
// row + data rows into an .xlsx buffer; sendWorkbook streams it; readSheet parses
// an uploaded workbook into row objects keyed by header.

export function buildWorkbook(headers: readonly string[], rows: unknown[][], sheetName: string): Buffer {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([headers as unknown as string[], ...rows]);
  ws['!cols'] = headers.map(h => ({ wch: Math.min(28, Math.max(12, h.length + 2)) }));
  XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31));
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

export function sendWorkbook(res: Response, buf: Buffer, filename: string) {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.end(buf);
}

export function readSheet(buffer: Buffer, sheetHint?: string): Record<string, unknown>[] {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheet = (sheetHint && wb.SheetNames.find(n => n.toUpperCase().includes(sheetHint.toUpperCase()))) || wb.SheetNames[0];
  return XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[sheet], { defval: '', raw: false });
}

export function cell(row: Record<string, unknown>, key: string): string | null {
  const found = Object.keys(row).find(h => h.trim().toLowerCase() === key.trim().toLowerCase());
  if (!found) return null;
  const s = String(row[found] ?? '').trim();
  return s === '' ? null : s;
}
export function numCell(row: Record<string, unknown>, key: string): number | null {
  const v = cell(row, key);
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
