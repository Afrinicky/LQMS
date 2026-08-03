import { API_BASE, getToken } from './api';

// Small helpers for the Excel export/import buttons used across modules.
// Downloads stream the workbook with the auth token; imports post the file and
// return the { totalRows, created, updated?, errors } summary the routes send.

export async function downloadXlsx(path: string, fallbackName: string): Promise<void> {
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : undefined });
  if (!res.ok) throw new Error((await res.json().catch(() => ({ error: res.statusText }))).error ?? res.statusText);
  const blob = await res.blob();
  const m = (res.headers.get('Content-Disposition') || '').match(/filename="?([^"]+)"?/);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = m ? m[1] : fallbackName;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

// Fetches a server-rendered printable report and opens it in a new window. The
// request has to go through fetch rather than a plain link because the token
// travels in a header, so the HTML is written into the window afterwards.
export async function openPrintable(path: string): Promise<void> {
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : undefined });
  if (!res.ok) throw new Error((await res.text()) || res.statusText);
  const html = await res.text();
  const w = window.open('', '_blank');
  if (!w) throw new Error('Allow pop-ups for this site to open the printable report.');
  w.document.open(); w.document.write(html); w.document.close();
}

export type ImportResult = {
  totalRows?: number; created?: number; updated?: number; excursions?: number;
  analytes?: number; readings?: number; rejected?: number; errors?: string[];
};

export async function uploadXlsx(path: string, file: File): Promise<ImportResult> {
  const fd = new FormData();
  fd.append('file', file);
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : undefined, body: fd });
  const data = await res.json().catch(() => ({ error: res.statusText }));
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data as ImportResult;
}
