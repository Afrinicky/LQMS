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

export type ImportResult = { totalRows?: number; created?: number; updated?: number; excursions?: number; errors?: string[] };

export async function uploadXlsx(path: string, file: File): Promise<ImportResult> {
  const fd = new FormData();
  fd.append('file', file);
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : undefined, body: fd });
  const data = await res.json().catch(() => ({ error: res.statusText }));
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data as ImportResult;
}
