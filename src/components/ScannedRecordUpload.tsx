import { FormEvent, useEffect, useRef, useState } from 'react';
import { api, API_BASE, getToken, errorText } from '../services/api';
import DocumentScanner from './DocumentScanner';
import { usePermissions } from '../hooks/usePermissions';
import TextField from './ui/TextField';
import { Notice } from './ui/Feedback';

// Reusable uploader for scanned paper records / evidence charts. Used by
// Environmental Monitoring, Equipment and other modules so historical records
// are preserved and ongoing scanned charts stand as evidence of a performed
// duty. Declaring an out-of-range reading raises a nonconformity automatically.

export type ScannedRecord = {
  id: number; record_number: string; module_key: string; category: string | null; title: string;
  coverage: string; period_start: string | null; period_end: string | null; month: string | null;
  section_id: number | null; equipment_id: number | null; file_id: number | null; file_name: string | null;
  is_legacy: number; has_out_of_range: number; out_of_range_notes: string | null; nc_id: number | null; nc_number: string | null;
  section_name: string | null; equipment_name: string | null; uploaded_by_name: string | null; created_at: string;
};

type Opt = { value: string; label: string };

const COVERAGES: Opt[] = [
  { value: 'monthly', label: 'Monthly chart / log' },
  { value: 'weekly', label: 'Weekly chart / log' },
  { value: 'daily', label: 'Daily record' },
  { value: 'one_off', label: 'One-off / single record' },
];

async function downloadFile(fileId: number, name: string, onError: (m: string) => void) {
  try {
    const token = getToken();
    const res = await fetch(`${API_BASE}/files/${fileId}/download`, { headers: token ? { Authorization: `Bearer ${token}` } : undefined });
    if (!res.ok) throw new Error(res.statusText);
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a'); a.href = url; a.download = name || `record-${fileId}`; document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  } catch (e) { onError(errorText(e)); }
}

export default function ScannedRecordUpload({
  moduleKey, categories, sections, equipment, defaultSectionId, defaultEquipmentId, monitoringItemId, heading, blurb,
}: {
  moduleKey: string;
  categories: Opt[];
  sections?: { id: number; name: string }[];
  equipment?: { id: number; name: string }[];
  defaultSectionId?: number | string;
  defaultEquipmentId?: number | string;
  monitoringItemId?: number | string;
  heading?: string;
  blurb?: string;
}) {
  // The scans belong to the module they document, so the rights that decide
  // what may be done with them are that module's — not the document library's.
  const { can } = usePermissions();
  const [rows, setRows] = useState<ScannedRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const blank = {
    title: '', category: categories[0]?.value || '', coverage: 'monthly', month: '', periodStart: '', periodEnd: '',
    sectionId: defaultSectionId ? String(defaultSectionId) : '', equipmentId: defaultEquipmentId ? String(defaultEquipmentId) : '',
    isLegacy: false, hasOutOfRange: false, outOfRangeNotes: '', notes: '',
  };
  const [form, setForm] = useState(blank);

  function load() {
    const params = new URLSearchParams({ moduleKey });
    if (defaultEquipmentId) params.set('equipmentId', String(defaultEquipmentId));
    if (monitoringItemId) params.set('monitoringItemId', String(monitoringItemId));
    api<ScannedRecord[]>(`/scanned-records?${params.toString()}`).then(setRows).catch(() => setRows([]));
  }
  useEffect(() => { load(); }, [moduleKey, defaultEquipmentId, monitoringItemId]);

  async function submit(e: FormEvent) {
    e.preventDefault(); setError(null); setMsg(null);
    if (!form.title.trim()) { setError('Give the record a title.'); return; }
    if (!file && !form.isLegacy) { setError('Attach the scanned copy (or tick “legacy note only”).'); return; }
    setBusy(true);
    try {
      const fd = new FormData();
      if (file) fd.append('file', file);
      fd.append('moduleKey', moduleKey);
      fd.append('title', form.title.trim());
      fd.append('category', form.category);
      fd.append('coverage', form.coverage);
      if (form.month) fd.append('month', form.month);
      if (form.periodStart) fd.append('periodStart', form.periodStart);
      if (form.periodEnd) fd.append('periodEnd', form.periodEnd);
      if (form.sectionId) fd.append('sectionId', form.sectionId);
      if (form.equipmentId) fd.append('equipmentId', form.equipmentId);
      if (monitoringItemId) fd.append('monitoringItemId', String(monitoringItemId));
      fd.append('isLegacy', String(form.isLegacy));
      fd.append('hasOutOfRange', String(form.hasOutOfRange));
      if (form.outOfRangeNotes) fd.append('outOfRangeNotes', form.outOfRangeNotes);
      if (form.notes) fd.append('notes', form.notes);
      const token = getToken();
      const res = await fetch(`${API_BASE}/scanned-records`, { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : undefined, body: fd });
      const data = await res.json().catch(() => ({ error: res.statusText }));
      if (!res.ok) throw new Error(data.error ?? res.statusText);
      setMsg(data.ncNumber ? `Saved. An out-of-range reading was flagged — nonconformity ${data.ncNumber} was raised for follow-up.` : 'Saved.');
      setForm(blank); setFile(null); if (fileRef.current) fileRef.current.value = '';
      load();
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  }
  async function remove(id: number) {
    if (!confirm('Delete this scanned record?')) return;
    try { await api(`/scanned-records/${id}`, { method: 'DELETE' }); load(); } catch (e) { setError(errorText(e)); }
  }

  return <div className="card" style={{ marginTop: 16 }}>
    <h3>{heading || 'Scanned records & evidence'}</h3>
    <p className="muted" style={{ marginTop: 0 }}>{blurb || 'Upload scanned copies of paper records so they are preserved, and attach charts/logs as evidence that the activity was performed. State the period the scan covers, and flag any out-of-range reading — the system will raise a nonconformity so the corrective-action steps follow.'}</p>
    {error && <Notice kind="error">{error}</Notice>}
    {msg && <Notice kind="success">{msg}</Notice>}
    {/* Uploading a scan creates a record. Somebody who may only read the
        register sees the register, not the form. */}
    {can(moduleKey, 'create') && <form className="form-grid" onSubmit={submit}>
      <label>Title / description<TextField value={form.title} onValue={nextValue => setForm({ ...form, title: nextValue })} placeholder="e.g. Fridge 1 temperature chart — Aug 2026" required /></label>
      <label>Type of record<select value={form.category} onChange={e => setForm({ ...form, category: e.target.value })}>{categories.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}</select></label>
      <label>Coverage<select value={form.coverage} onChange={e => setForm({ ...form, coverage: e.target.value })}>{COVERAGES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}</select></label>
      {form.coverage === 'monthly' ? <label>Month<input type="month" value={form.month} onChange={e => setForm({ ...form, month: e.target.value })} /></label> : <>
        <label>Period from<input type="date" value={form.periodStart} onChange={e => setForm({ ...form, periodStart: e.target.value })} /></label>
        <label>Period to<input type="date" value={form.periodEnd} onChange={e => setForm({ ...form, periodEnd: e.target.value })} /></label>
      </>}
      {sections && sections.length > 0 && <label>Unit / section<select value={form.sectionId} onChange={e => setForm({ ...form, sectionId: e.target.value })}><option value="">—</option>{sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>}
      {equipment && equipment.length > 0 && <label>Equipment<select value={form.equipmentId} onChange={e => setForm({ ...form, equipmentId: e.target.value })}><option value="">—</option>{equipment.map(eq => <option key={eq.id} value={eq.id}>{eq.name}</option>)}</select></label>}
      <label style={{ gridColumn: '1 / -1' }}>Scanned file
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <input ref={fileRef} type="file" accept="image/*,application/pdf" onChange={e => setFile(e.target.files?.[0] ?? null)} />
          <DocumentScanner onCapture={f => setFile(f)} />
          {file && <span className="muted" style={{ fontSize: 12 }}>Selected: {file.name}</span>}
        </div>
      </label>
      <label className="check-inline"><input type="checkbox" checked={form.isLegacy} onChange={e => setForm({ ...form, isLegacy: e.target.checked })} /> Historical (legacy) record being preserved</label>
      <label className="check-inline"><input type="checkbox" checked={form.hasOutOfRange} onChange={e => setForm({ ...form, hasOutOfRange: e.target.checked })} /> This copy contains an out-of-range reading</label>
      {form.hasOutOfRange && <label style={{ gridColumn: '1 / -1' }}>Out-of-range details (what/when)<TextField value={form.outOfRangeNotes} onValue={nextValue => setForm({ ...form, outOfRangeNotes: nextValue })} placeholder="e.g. 08 Aug reading 9.2°C exceeded 2–8°C limit" /></label>}
      <label style={{ gridColumn: '1 / -1' }}>Notes<TextField value={form.notes} onValue={nextValue => setForm({ ...form, notes: nextValue })} /></label>
      <button type="submit" disabled={busy}>{busy ? 'Uploading…' : 'Upload scanned record'}</button>
    </form>}

    <table className="data-table" style={{ marginTop: 14 }}><thead><tr><th>Number</th><th>Title</th><th>Type</th><th>Coverage</th><th>Period</th><th>Out-of-range</th><th>File</th><th></th></tr></thead><tbody>
      {rows.map(r => <tr key={r.id}>
        <td>{r.record_number}{r.is_legacy ? <span className="badge">legacy</span> : null}</td>
        <td>{r.title}{r.equipment_name ? <div className="muted" style={{ fontSize: 11 }}>{r.equipment_name}</div> : null}</td>
        <td>{(r.category || '—').replace(/_/g, ' ')}</td>
        <td>{r.coverage.replace(/_/g, ' ')}</td>
        <td>{r.month || [r.period_start, r.period_end].filter(Boolean).join(' → ') || '—'}</td>
        <td>{r.has_out_of_range ? <span className="badge danger">yes{r.nc_number ? ` · ${r.nc_number}` : ''}</span> : 'no'}</td>
        <td>{r.file_id && can(moduleKey, 'export') ? <button type="button" className="secondary" onClick={() => downloadFile(r.file_id!, r.file_name || r.record_number, setError)}>Download</button> : '—'}</td>
        <td>{can(moduleKey, 'void_archive') && <button type="button" className="secondary" onClick={() => remove(r.id)}>Delete</button>}</td>
      </tr>)}
      {rows.length === 0 && <tr><td colSpan={8} className="muted">No scanned records uploaded yet.</td></tr>}
    </tbody></table>
  </div>;
}
