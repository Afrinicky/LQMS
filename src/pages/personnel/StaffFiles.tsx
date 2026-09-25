import { FormEvent, Suspense, lazy, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Printer, Upload } from 'lucide-react';
import { api, API_BASE, getToken, apiRead, errorText } from '../../services/api';
import { openPrintable } from '../../services/xlsx';
import { usePermissions } from '../../hooks/usePermissions';
import { useTabParam } from '../../hooks/useTabParam';
import { useFocusTarget, focusAttr } from '../../hooks/useFocusTarget';
import TextField from '../../components/ui/TextField';
import StaffRecordViewer from './StaffRecordViewer';
import type {
  Staff, StaffDocument, StaffFile, StaffFileItem, StaffFileRegisterRow,
  JobDescriptionDoc, JobDescriptionRegister,
} from '../../../shared/types/api';

// The document register's own viewer, so a job description read from a staff
// file is the same document, at the same version, as the one read in
// Documents & Records.
const DocumentViewer = lazy(() => import('../DocumentControlPage').then(m => ({ default: m.DocumentViewer })));

export const STAFF_FILE_SUBTABS = ['Register', 'Documents', 'Job Descriptions', 'Verification Queue'];

const STAFF_DOC_TYPES = ['CV', 'Qualification', 'Licence', 'Certificate', 'Contract', 'Job description', 'ID', 'Reference', 'Other'];
const todayIso = () => new Date().toISOString().slice(0, 10);
const soonIso = () => new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

const badge = (status?: string | null) =>
  <span className={`badge ${status ? String(status).toLowerCase().replace(/\s+/g, '-') : 'unknown'}`}>
    {status ? String(status).replace(/_/g, ' ') : 'Unknown'}
  </span>;

const initialsOf = (name?: string | null) => (name || '')
  .split(/\s+/).filter(Boolean).slice(0, 2).map(p => p[0]?.toUpperCase() ?? '').join('') || '—';

function expiryCell(date?: string | null) {
  if (!date) return <span className="muted">—</span>;
  const today = todayIso();
  const expired = date < today;
  const soon = !expired && date <= soonIso();
  return <>{date} {expired && <span className="badge danger">expired</span>}{soon && <span className="badge warning">expiring</span>}</>;
}

/* ============================================================================
   Staff Files
   ----------------------------------------------------------------------------
   One place for everything the laboratory holds about its people. The register
   lists everybody; opening a row opens that person's file, where the papers on
   record and the records the system produced are read side by side.
   ========================================================================== */
export default function StaffFiles({ staff, onError }: { staff: Staff[]; onError: (m: string | null) => void }) {
  const { can } = usePermissions();
  const [sub, setSub] = useState('Register');
  const [openStaffId, setOpenStaffId] = useState<number | null>(null);
  useTabParam(STAFF_FILE_SUBTABS, setSub, 'subtab');

  if (openStaffId !== null) {
    return <StaffFileDetail staffId={openStaffId} onBack={() => setOpenStaffId(null)} onError={onError} />;
  }

  return <>
    <div className="tabs sub">
      {STAFF_FILE_SUBTABS.map(name =>
        <button key={name} type="button" className={sub === name ? 'active' : ''} onClick={() => setSub(name)}>{name}</button>)}
    </div>

    {sub === 'Register' && <StaffFileRegister onOpen={setOpenStaffId} onError={onError} />}
    {sub === 'Documents' && <StaffDocumentsRegister staff={staff} onOpen={setOpenStaffId} onError={onError} canCreate={can('personnel.register', 'create')} canVerify={can('personnel.register', 'approve')} />}
    {sub === 'Job Descriptions' && <JobDescriptionsRegister onError={onError} />}
    {sub === 'Verification Queue' && <VerificationQueue staff={staff} onOpen={setOpenStaffId} onError={onError} canVerify={can('personnel.register', 'approve')} />}
  </>;
}

/* ── Register: every member of staff, one row each ───────────────────────── */
function StaffFileRegister({ onOpen, onError }: { onOpen: (id: number) => void; onError: (m: string | null) => void }) {
  const [rows, setRows] = useState<StaffFileRegisterRow[]>([]);
  const [query, setQuery] = useState('');
  const [unit, setUnit] = useState('');
  const [category, setCategory] = useState('');
  const [state, setState] = useState('active');
  const [sort, setSort] = useState<{ key: keyof StaffFileRegisterRow; dir: 1 | -1 }>({ key: 'full_name', dir: 1 });

  useEffect(() => {
    apiRead<StaffFileRegisterRow[]>('/personnel/staff-files', []).then(setRows).catch(e => onError(errorText(e)));
  }, [onError]);

  const units = useMemo(() => Array.from(new Set(rows.map(r => r.unit || r.section_name).filter(Boolean))) as string[], [rows]);
  const categories = useMemo(() => Array.from(new Set(rows.map(r => r.personnel_category).filter(Boolean))) as string[], [rows]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const out = rows.filter(r => {
      if (state === 'active' && !r.is_active) return false;
      if (state === 'inactive' && r.is_active) return false;
      if (unit && (r.unit || r.section_name) !== unit) return false;
      if (category && r.personnel_category !== category) return false;
      if (!q) return true;
      return [r.full_name, r.employee_no, r.designation, r.job_title, r.unit, r.section_name]
        .some(v => v?.toLowerCase().includes(q));
    });
    return out.sort((a, b) => {
      const av = a[sort.key] ?? ''; const bv = b[sort.key] ?? '';
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * sort.dir;
      return String(av).localeCompare(String(bv)) * sort.dir;
    });
  }, [rows, query, unit, category, state, sort]);

  const sortHeader = (label: string, key: keyof StaffFileRegisterRow) =>
    <th className="dm-sort" onClick={() => setSort(s => ({ key, dir: s.key === key && s.dir === 1 ? -1 : 1 }))}>
      {label}{sort.key === key ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}
    </th>;

  return <>
    <div className="dm-toolbar">
      <TextField className="dm-search" placeholder="Search name, staff ID, designation, unit…" value={query} onValue={setQuery} />
      <select value={unit} onChange={e => setUnit(e.target.value)} title="Unit">
        <option value="">All units</option>
        {units.map(u => <option key={u} value={u}>{u}</option>)}
      </select>
      <select value={category} onChange={e => setCategory(e.target.value)} title="Category">
        <option value="">All categories</option>
        {categories.map(c => <option key={c} value={c}>{c}</option>)}
      </select>
      <select value={state} onChange={e => setState(e.target.value)} title="Employment">
        <option value="active">In service</option>
        <option value="inactive">Left</option>
        <option value="">All</option>
      </select>
      {(query || unit || category) && <button className="secondary" onClick={() => { setQuery(''); setUnit(''); setCategory(''); }}>Clear</button>}
      <span className="dm-count">{filtered.length} of {rows.length} file{rows.length === 1 ? '' : 's'}</span>
    </div>

    <div className="dm-table-wrap">
      <table className="data-table dm-table"><thead><tr>
        <th>No.</th>
        {sortHeader('Staff ID', 'employee_no')}
        {sortHeader('Name', 'full_name')}
        {sortHeader('Designation', 'designation')}
        {sortHeader('Position', 'job_title')}
        {sortHeader('Unit', 'unit')}
        {sortHeader('Category', 'personnel_category')}
        {sortHeader('Documents', 'document_count')}
        {sortHeader('Records', 'record_count')}
        <th>Attention</th>
      </tr></thead><tbody>
        {filtered.map((r, i) => <tr key={r.id} className="clickable-row" title="Click to open the staff file" onClick={() => onOpen(r.id)}>
          <td className="dm-num">{i + 1}</td>
          <td className="dm-code">{r.employee_no || '—'}</td>
          <td className="dm-title-cell">
            <span className="dm-owner"><span className="dm-avatar">{initialsOf(r.full_name)}</span><span className="dm-owner-name">{r.full_name}</span></span>
          </td>
          <td>{r.designation || '—'}</td>
          <td>{r.job_title || '—'}</td>
          <td>{r.unit || r.section_name || '—'}</td>
          <td>{r.personnel_category ? <span className="badge">{r.personnel_category}</span> : '—'}</td>
          <td className="dm-num">{r.document_count}</td>
          <td className="dm-num">{r.record_count}</td>
          <td>
            {r.pending_verification > 0 && <span className="badge warning">{r.pending_verification} to verify</span>}
            {r.expired_documents > 0 && <span className="badge danger">{r.expired_documents} expired</span>}
            {!r.pending_verification && !r.expired_documents && <span className="dm-dim">—</span>}
          </td>
        </tr>)}
        {filtered.length === 0 && <tr><td colSpan={10} className="muted" style={{ textAlign: 'center', padding: 24 }}>
          {rows.length === 0 ? 'No staff records yet.' : 'No files match the current filters.'}
        </td></tr>}
      </tbody></table>
    </div>
  </>;
}

/* ── One file ─────────────────────────────────────────────────────────────── */
function StaffFileDetail({ staffId, onBack, onError }: { staffId: number; onBack: () => void; onError: (m: string | null) => void }) {
  const { can } = usePermissions();
  const canCreate = can('personnel.register', 'create');
  const canEdit = can('personnel.register', 'edit');
  const canVerify = can('personnel.register', 'approve');
  const [file, setFile] = useState<StaffFile | null>(null);
  const [category, setCategory] = useState('All records');
  const [reading, setReading] = useState<StaffFileItem | null>(null);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ documentType: 'CV', title: '', issueDate: '', expiryDate: '', remarks: '' });
  const [upload, setUpload] = useState<File | null>(null);

  const load = () => api<StaffFile>(`/personnel/staff-files/${staffId}`).then(setFile).catch(e => onError(errorText(e)));
  useEffect(() => { void load(); }, [staffId]);

  if (!file) return <p className="muted">Opening the staff file…</p>;
  const s = file.staff;
  const categories = ['All records', ...(file.categories || []).filter(c => (file.counts[c] ?? 0) > 0)];
  const items = category === 'All records' ? file.items : file.items.filter(i => i.category === category);

  async function submitDocument(e: FormEvent) {
    e.preventDefault(); onError(null); setBusy(true);
    try {
      let fileId: string | null = null;
      if (upload) {
        const fd = new FormData(); fd.append('file', upload);
        const token = getToken();
        const res = await fetch(`${API_BASE}/files`, { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : undefined, body: fd });
        if (!res.ok) throw new Error((await res.json().catch(() => ({ error: res.statusText }))).error ?? res.statusText);
        fileId = String((await res.json()).id);
      }
      if (editingId) await api(`/personnel/staff-documents/${editingId}`, { method: 'PUT', body: JSON.stringify(fileId ? { ...form, fileId } : form) });
      else await api('/personnel/staff-documents', { method: 'POST', body: JSON.stringify({ ...form, staffId, fileId }) });
      closeForm();
      await load();
    } catch (err) { onError(errorText(err)); }
    finally { setBusy(false); }
  }

  function closeForm() {
    setForm({ documentType: 'CV', title: '', issueDate: '', expiryDate: '', remarks: '' });
    setUpload(null); setAdding(false); setEditingId(null);
  }

  function editDocument(item: StaffFileItem) {
    setEditingId(item.id);
    setAdding(true);
    setUpload(null);
    setForm({
      documentType: item.record_type, title: item.title,
      issueDate: item.date ?? '', expiryDate: item.expiry ?? '', remarks: '',
    });
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function verify(id: number) {
    try {
      await api(`/personnel/staff-documents/${id}/verify`, { method: 'POST', body: JSON.stringify({ verificationStatus: 'verified' }) });
      await load();
    } catch (e) { onError(errorText(e)); }
  }

  const detail = (label: string, value?: string | null) =>
    <div className="sf-field"><span>{label}</span><strong>{value || '—'}</strong></div>;

  return <>
    <style>{`.sf-head{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.sf-avatar{width:46px;height:46px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:var(--accent-soft);color:var(--accent-bright);font-weight:700;font-size:16px;flex:none}
.sf-ident h3{margin:0;font-size:17px}
.sf-ident .muted{font-size:12.5px}
.sf-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:10px 18px;margin-top:4px}
.sf-field{display:flex;flex-direction:column;gap:2px;min-width:0}
.sf-field span{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.sf-field strong{font-size:13px;font-weight:600;overflow-wrap:anywhere}
.sf-cats{display:flex;gap:6px;flex-wrap:wrap;margin:16px 0 10px}
.sf-cats button{padding:5px 12px;font-size:12.5px;border-radius:999px;background:transparent;border:1px solid var(--border);color:var(--muted);cursor:pointer;box-shadow:none}
.sf-cats button:hover{color:var(--text);border-color:var(--border-strong)}
.sf-cats button.active{background:var(--accent-soft);border-color:var(--accent-bright);color:var(--text)}
.sf-cats .n{margin-left:6px;opacity:.7}
.sf-table .dm-title-cell{min-width:150px}
.sf-table .dm-code{font-size:12px}
.sf-table .dm-actions .pq-link{padding:4px 9px}`}</style>

    <div className="card">
      <div className="section-head" style={{ alignItems: 'flex-start' }}>
        <div className="sf-head">
          <button type="button" className="secondary" onClick={onBack}><ArrowLeft size={14} style={{ verticalAlign: '-2px', marginRight: 6 }} />Back</button>
          <span className="sf-avatar">{initialsOf(s.full_name)}</span>
          <span className="sf-ident">
            <h3>{s.full_name}</h3>
            <div className="muted">{[s.employee_no, s.designation, s.unit || s.section_name].filter(Boolean).join(' · ') || '—'}</div>
          </span>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {canCreate && <button type="button" className="secondary" onClick={() => (adding ? closeForm() : setAdding(true))}>
            <Upload size={14} style={{ verticalAlign: '-2px', marginRight: 6 }} />{adding ? 'Cancel' : 'Add document'}
          </button>}
          {file.mayPrintFile && <button type="button" className="secondary" onClick={() => openPrintable(`/personnel/staff-files/${staffId}/print`).catch(e => onError(errorText(e)))}>
            <Printer size={14} style={{ verticalAlign: '-2px', marginRight: 6 }} />Print file
          </button>}
        </div>
      </div>

      <div className="sf-grid">
        {detail('Staff ID', s.employee_no)}
        {detail('Position', s.job_title)}
        {detail('Posts held', (file.positions || []).filter(p => p.is_active).map(p => p.title).join(', '))}
        {detail('Unit', s.unit || s.section_name)}
        {detail('Department', s.department_name)}
        {detail('Category', s.personnel_category)}
        {detail('Appointment', [s.appointment_type, s.appointment_date].filter(Boolean).join(' · '))}
        {detail('Date of birth', s.date_of_birth)}
        {detail('Gender', s.gender)}
        {detail('Regulator', s.professional_regulator)}
        {detail('Licence', s.professional_licence)}
        {detail('Licence expiry', s.licence_expiry_date)}
        {detail('Qualifications', s.qualifications)}
        {detail('National ID', [s.national_id_type, s.national_id_number].filter(Boolean).join(' — '))}
        {detail('Phone', s.phone)}
        {detail('Email', s.email)}
        {detail('Emergency contact', s.emergency_contact)}
        {detail('File location', s.staff_file_location)}
      </div>
    </div>

    {adding && (editingId ? canEdit : canCreate) && <form className="card form-grid" onSubmit={submitDocument}>
      <label>Type<select value={form.documentType} onChange={e => setForm({ ...form, documentType: e.target.value })} required>
        {STAFF_DOC_TYPES.map(t => <option key={t} value={t}>{t}</option>)}</select></label>
      <label>Title<TextField value={form.title} onValue={v => setForm({ ...form, title: v })} required /></label>
      <label>Issue date<input type="date" value={form.issueDate} onChange={e => setForm({ ...form, issueDate: e.target.value })} /></label>
      <label>Expiry date<input type="date" value={form.expiryDate} onChange={e => setForm({ ...form, expiryDate: e.target.value })} /></label>
      <label>File<input type="file" onChange={e => setUpload(e.target.files?.[0] ?? null)} /></label>
      <label>Remarks<TextField value={form.remarks} onValue={v => setForm({ ...form, remarks: v })} /></label>
      <button type="submit" disabled={busy}>{busy ? 'Saving…' : editingId ? 'Save changes' : 'Add to file'}</button>
    </form>}

    <div className="sf-cats">
      {categories.map(c => <button key={c} type="button" className={category === c ? 'active' : ''} onClick={() => setCategory(c)}>
        {c}<span className="n">{c === 'All records' ? file.items.length : file.counts[c] ?? 0}</span>
      </button>)}
    </div>

    <div className="dm-table-wrap">
      <table className="data-table dm-table sf-table"><thead><tr>
        <th>No.</th><th>Reference</th><th>Record</th><th>Type</th><th>Date</th><th>Expiry</th><th>Status</th><th>Actions</th>
      </tr></thead><tbody>
        {items.map((item, i) => <tr key={item.key} className={item.can_open ? 'clickable-row' : undefined}
          title={item.can_open ? 'Click to open' : undefined} onClick={() => item.can_open && setReading(item)}>
          <td className="dm-num">{i + 1}</td>
          <td className="dm-code">{item.reference || '—'}</td>
          <td className="dm-title-cell">
            <span className="dm-title">{item.title}</span>
            <span className="dm-sub">{[item.category, item.file_name || (item.source === 'system' ? 'System record' : null), item.detail].filter(Boolean).join(' · ')}</span>
          </td>
          <td>{item.record_type}</td>
          <td className="dm-date">{item.date || '—'}</td>
          <td className="dm-date">{expiryCell(item.expiry)}</td>
          <td>{badge(item.status)}</td>
          <td className="dm-actions" onClick={e => e.stopPropagation()}>
            {item.can_open
              ? <button className="link-btn" onClick={() => setReading(item)}>Open</button>
              : <span className="dm-dim" style={{ marginRight: 6 }}>restricted</span>}
            {canEdit && item.key.startsWith('staff-document:') &&
              <button className="pq-link" onClick={() => editDocument(item)}>Edit</button>}
            {canVerify && item.key.startsWith('staff-document:') && item.status === 'pending' &&
              <button className="pq-link" onClick={() => verify(item.id)}>Verify</button>}
          </td>
        </tr>)}
        {items.length === 0 && <tr><td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 24 }}>Nothing filed under this heading yet.</td></tr>}
      </tbody></table>
    </div>

    {reading && reading.open.kind === 'document' && <Suspense fallback={<div className="card">Opening the document…</div>}>
      <DocumentViewer
        docId={reading.open.documentId}
        versionId={reading.open.versionId}
        onClose={() => setReading(null)}
        onAttest={() => setReading(null)}
        onSaved={() => undefined}
        onError={onError}
      />
    </Suspense>}
    {reading && reading.open.kind !== 'document' && <StaffRecordViewer
      title={reading.title}
      subtitle={[s.full_name, reading.category, reading.reference].filter(Boolean).join(' · ')}
      open={reading.open}
      onClose={() => setReading(null)}
    />}
  </>;
}

/* ── Documents held across every file ─────────────────────────────────────── */
function StaffDocumentsRegister({ staff, onOpen, onError, canCreate, canVerify }: {
  staff: Staff[]; onOpen: (id: number) => void; onError: (m: string | null) => void; canCreate: boolean; canVerify: boolean;
}) {
  const [docs, setDocs] = useState<StaffDocument[]>([]);
  const [query, setQuery] = useState('');
  const [type, setType] = useState('');
  const [status, setStatus] = useState('');
  const [form, setForm] = useState({ staffId: '', documentType: 'CV', title: '', issueDate: '', expiryDate: '', remarks: '' });
  const [upload, setUpload] = useState<File | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = () => apiRead<StaffDocument[]>('/personnel/staff-documents', []).then(setDocs);
  useEffect(() => { void load(); }, []);
  useFocusTarget(docs.length);

  const filtered = docs.filter(d => {
    if (type && d.document_type !== type) return false;
    if (status && d.verification_status !== status) return false;
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return [d.title, d.staff_name, d.document_type, d.file_name].some(v => v?.toLowerCase().includes(q));
  });

  async function submit(e: FormEvent) {
    e.preventDefault(); onError(null); setBusy(true);
    try {
      let fileId: string | null = null;
      if (upload) {
        const fd = new FormData(); fd.append('file', upload);
        const token = getToken();
        const res = await fetch(`${API_BASE}/files`, { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : undefined, body: fd });
        if (!res.ok) throw new Error((await res.json().catch(() => ({ error: res.statusText }))).error ?? res.statusText);
        fileId = String((await res.json()).id);
      }
      await api('/personnel/staff-documents', { method: 'POST', body: JSON.stringify({ ...form, fileId }) });
      setForm({ staffId: '', documentType: 'CV', title: '', issueDate: '', expiryDate: '', remarks: '' });
      setUpload(null); setAdding(false);
      await load();
    } catch (err) { onError(errorText(err)); }
    finally { setBusy(false); }
  }

  async function verify(id: number) {
    try { await api(`/personnel/staff-documents/${id}/verify`, { method: 'POST', body: JSON.stringify({ verificationStatus: 'verified' }) }); await load(); }
    catch (e) { onError(errorText(e)); }
  }

  return <>
    <div className="dm-toolbar">
      <TextField className="dm-search" placeholder="Search title, staff, type…" value={query} onValue={setQuery} />
      <select value={type} onChange={e => setType(e.target.value)} title="Document type">
        <option value="">All types</option>
        {STAFF_DOC_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
      </select>
      <select value={status} onChange={e => setStatus(e.target.value)} title="Verification">
        <option value="">All verification states</option>
        {['pending', 'verified', 'rejected', 'expired'].map(s => <option key={s} value={s}>{s}</option>)}
      </select>
      <span className="dm-count">{filtered.length} of {docs.length} document{docs.length === 1 ? '' : 's'}</span>
      <span style={{ flex: 1 }} />
      {canCreate && <button className="secondary" onClick={() => setAdding(a => !a)}>{adding ? 'Cancel' : '＋ Add document'}</button>}
    </div>

    {adding && canCreate && <form className="card form-grid" onSubmit={submit}>
      <label>Staff<select value={form.staffId} onChange={e => setForm({ ...form, staffId: e.target.value })} required>
        <option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
      <label>Type<select value={form.documentType} onChange={e => setForm({ ...form, documentType: e.target.value })} required>
        {STAFF_DOC_TYPES.map(t => <option key={t} value={t}>{t}</option>)}</select></label>
      <label>Title<TextField value={form.title} onValue={v => setForm({ ...form, title: v })} required /></label>
      <label>Issue date<input type="date" value={form.issueDate} onChange={e => setForm({ ...form, issueDate: e.target.value })} /></label>
      <label>Expiry date<input type="date" value={form.expiryDate} onChange={e => setForm({ ...form, expiryDate: e.target.value })} /></label>
      <label>File<input type="file" onChange={e => setUpload(e.target.files?.[0] ?? null)} /></label>
      <label>Remarks<TextField value={form.remarks} onValue={v => setForm({ ...form, remarks: v })} /></label>
      <button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Upload staff document'}</button>
    </form>}

    <div className="dm-table-wrap">
      <table className="data-table dm-table"><thead><tr>
        <th>No.</th><th>Staff</th><th>Type</th><th>Title</th><th>Issue</th><th>Expiry</th><th>Verification</th><th>File</th><th>Actions</th>
      </tr></thead><tbody>
        {filtered.map((d, i) => <tr key={d.id} className="clickable-row" title="Click to open the staff file"
          onClick={() => d.staff_id && onOpen(d.staff_id)} {...focusAttr('staff_documents', d.id)}>
          <td className="dm-num">{i + 1}</td>
          <td>{d.staff_name || '—'}</td>
          <td>{d.document_type}</td>
          <td className="dm-title-cell"><span className="dm-title">{d.title}</span></td>
          <td className="dm-date">{d.issue_date || '—'}</td>
          <td className="dm-date">{expiryCell(d.expiry_date)}</td>
          <td>{badge(d.verification_status)}</td>
          <td>{d.file_name || '—'}</td>
          <td className="dm-actions" onClick={e => e.stopPropagation()}>
            <button className="link-btn" onClick={() => d.staff_id && onOpen(d.staff_id)}>Open file</button>
            {canVerify && d.verification_status === 'pending' && <button className="secondary" onClick={() => verify(d.id)}>Verify</button>}
          </td>
        </tr>)}
        {filtered.length === 0 && <tr><td colSpan={9} className="muted" style={{ textAlign: 'center', padding: 24 }}>
          {docs.length === 0 ? 'No staff documents held yet.' : 'No documents match the current filters.'}
        </td></tr>}
      </tbody></table>
    </div>
  </>;
}

/* ── Documents awaiting verification ──────────────────────────────────────── */
function VerificationQueue({ staff, onOpen, onError, canVerify }: {
  staff: Staff[]; onOpen: (id: number) => void; onError: (m: string | null) => void; canVerify: boolean;
}) {
  const [docs, setDocs] = useState<StaffDocument[]>([]);
  const load = () => apiRead<StaffDocument[]>('/personnel/staff-documents?verificationStatus=pending', []).then(setDocs);
  useEffect(() => { void load(); }, []);

  async function act(id: number, verificationStatus: string) {
    try { await api(`/personnel/staff-documents/${id}/verify`, { method: 'POST', body: JSON.stringify({ verificationStatus }) }); await load(); }
    catch (e) { onError(errorText(e)); }
  }

  const nameOf = (id?: number) => staff.find(s => s.id === id)?.fullName;

  return <>
    <div className="dm-toolbar">
      <span className="dm-count">{docs.length} document{docs.length === 1 ? '' : 's'} awaiting verification</span>
    </div>
    <div className="dm-table-wrap">
      <table className="data-table dm-table"><thead><tr>
        <th>No.</th><th>Staff</th><th>Type</th><th>Title</th><th>Issue</th><th>Expiry</th><th>File</th><th>Actions</th>
      </tr></thead><tbody>
        {docs.map((d, i) => <tr key={d.id} className="clickable-row" onClick={() => d.staff_id && onOpen(d.staff_id)}>
          <td className="dm-num">{i + 1}</td>
          <td>{d.staff_name || nameOf(d.staff_id) || '—'}</td>
          <td>{d.document_type}</td>
          <td className="dm-title-cell"><span className="dm-title">{d.title}</span></td>
          <td className="dm-date">{d.issue_date || '—'}</td>
          <td className="dm-date">{expiryCell(d.expiry_date)}</td>
          <td>{d.file_name || '—'}</td>
          <td className="dm-actions" onClick={e => e.stopPropagation()}>
            <button className="link-btn" onClick={() => d.staff_id && onOpen(d.staff_id)}>Open file</button>
            {canVerify && <>
              <button className="secondary" onClick={() => act(d.id, 'verified')}>Verify</button>
              <button className="secondary" onClick={() => act(d.id, 'rejected')}>Reject</button>
            </>}
          </td>
        </tr>)}
        {docs.length === 0 && <tr><td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 24 }}>Nothing is awaiting verification.</td></tr>}
      </tbody></table>
    </div>
  </>;
}

/* ── Job descriptions ─────────────────────────────────────────────────────── */
function JobDescriptionsRegister({ onError }: { onError: (m: string | null) => void }) {
  const navigate = useNavigate();
  const { can } = usePermissions();
  const [data, setData] = useState<JobDescriptionRegister | null>(null);
  const [reading, setReading] = useState<JobDescriptionDoc | null>(null);

  useEffect(() => {
    api<JobDescriptionRegister>('/personnel/job-descriptions')
      .then(setData)
      .catch(e => { onError(errorText(e)); setData({ documents: [], gaps: [] }); });
  }, [onError]);

  if (!data) return <p className="muted">Loading job descriptions…</p>;

  return <>
    <div className="dm-toolbar">
      <span className="dm-count">{data.documents.length} job description{data.documents.length === 1 ? '' : 's'}</span>
      <span style={{ flex: 1 }} />
      {can('documents.authoring', 'create') &&
        <button type="button" className="secondary" onClick={() => navigate('/documents?new=Job%20Description')}>＋ Upload a job description</button>}
    </div>

    <div className="dm-table-wrap">
      <table className="data-table dm-table"><thead><tr>
        <th>No.</th><th>Post / person</th><th>Document</th><th>Version</th><th>Status</th><th>Next review</th><th>Actions</th>
      </tr></thead><tbody>
        {data.documents.map((d, i) => <tr key={d.id} className="clickable-row" title="Click to open"
          onClick={() => d.current_version_id && setReading(d)}>
          <td className="dm-num">{i + 1}</td>
          <td className="dm-title-cell">
            <span className="dm-title">{d.position_title ?? d.staff_name ?? '—'}</span>
            {d.staff_name && d.applies_to_staff_id ? <span className="dm-sub">Issued by name</span> : null}
            {!d.position_title && !d.staff_name ? <span className="dm-sub">Not linked to a post</span> : null}
          </td>
          <td>{d.title}<div className="muted">{d.document_code ?? '—'}</div></td>
          <td className="dm-num">{d.version_number ?? '—'}</td>
          <td>{badge(d.status)}</td>
          <td className="dm-date">{d.next_review_date ?? '—'}</td>
          <td className="dm-actions" onClick={e => e.stopPropagation()}>
            {d.current_version_id
              ? <button className="link-btn" onClick={() => setReading(d)}>Open</button>
              : <span className="dm-dim" style={{ marginRight: 6 }}>no file yet</span>}
            <button className="secondary" onClick={() => navigate(`/documents?open=${d.id}`)}>Manage</button>
          </td>
        </tr>)}
        {data.documents.length === 0 &&
          <tr><td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 24 }}>No job description has been registered yet.</td></tr>}
      </tbody></table>
    </div>

    {data.gaps.length > 0 && <>
      <div className="section-head" style={{ marginTop: 22 }}><h3 style={{ margin: 0 }}>Posts with no issued description</h3></div>
      <ul className="jd-gaps">
        {data.gaps.map(g => <li key={g.id}>
          <span>{g.title}</span>
          <span className={`badge ${g.staff_count > 0 ? 'warning' : ''}`}>
            {g.staff_count === 0 ? 'nobody in post' : g.staff_count === 1 ? '1 member of staff' : `${g.staff_count} members of staff`}
          </span>
        </li>)}
      </ul>
    </>}

    {reading && <Suspense fallback={<div className="card">Opening the document…</div>}>
      <DocumentViewer
        docId={reading.id}
        versionId={Number(reading.current_version_id ?? 0)}
        onClose={() => setReading(null)}
        onAttest={() => setReading(null)}
        onSaved={() => undefined}
        onError={onError}
      />
    </Suspense>}
  </>;
}
