import { Fragment, FormEvent, Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PenLine, Printer, Upload } from 'lucide-react';
import { api, API_BASE, getToken, apiRead, errorText } from '../../services/api';
import { openPrintable } from '../../services/xlsx';
import { usePermissions } from '../../hooks/usePermissions';
import { useTabParam } from '../../hooks/useTabParam';
import { useFocusTarget, focusAttr } from '../../hooks/useFocusTarget';
import TextField from '../../components/ui/TextField';
import { SignatureThumb } from '../../components/SignatureThumb';
import RecordWindow from './RecordWindow';
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

  // The file opens over the register, as a window, rather than replacing the
  // page: the register stays where it was, and closing the window puts the
  // reader back exactly where they were in it.
  return <>
    <div className="tabs sub">
      {STAFF_FILE_SUBTABS.map(name =>
        <button key={name} type="button" className={sub === name ? 'active' : ''} onClick={() => setSub(name)}>{name}</button>)}
    </div>

    {sub === 'Register' && <StaffFileRegister onOpen={setOpenStaffId} onError={onError} />}
    {sub === 'Documents' && <StaffDocumentsRegister staff={staff} onOpen={setOpenStaffId} onError={onError} canCreate={can('personnel.register', 'create')} canVerify={can('personnel.register', 'approve')} />}
    {sub === 'Job Descriptions' && <JobDescriptionsRegister onError={onError} />}
    {sub === 'Verification Queue' && <VerificationQueue staff={staff} onOpen={setOpenStaffId} onError={onError} canVerify={can('personnel.register', 'approve')} />}

    {openStaffId !== null && <StaffFileDetail key={openStaffId} staffId={openStaffId} onClose={() => setOpenStaffId(null)} onError={onError} />}
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


/* ── One file, opened as a window ─────────────────────────────────────────── */
function StaffFileDetail({ staffId, onClose, onError }: { staffId: number; onClose: () => void; onError: (m: string | null) => void }) {
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
  const [sigBusy, setSigBusy] = useState(false);
  const [sigNonce, setSigNonce] = useState(0);
  const sigInput = useRef<HTMLInputElement>(null);

  const load = () => api<StaffFile>(`/personnel/staff-files/${staffId}`).then(setFile).catch(e => onError(errorText(e)));
  useEffect(() => { void load(); }, [staffId]);

  const s = file?.staff ?? {};
  const categories = file ? ['All records', ...(file.categories || []).filter(c => (file.counts[c] ?? 0) > 0)] : [];
  const items = !file ? [] : category === 'All records' ? file.items : file.items.filter(i => i.category === category);

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
  }

  async function verify(id: number) {
    try {
      await api(`/personnel/staff-documents/${id}/verify`, { method: 'POST', body: JSON.stringify({ verificationStatus: 'verified' }) });
      await load();
    } catch (e) { onError(errorText(e)); }
  }

  // Nothing in the system may be signed by somebody with no signature on file,
  // so the file both says whether they have one and is where it is set up.
  async function uploadSignature(picked: File) {
    onError(null); setSigBusy(true);
    try {
      const fd = new FormData(); fd.append('file', picked);
      const token = getToken();
      const res = await fetch(`${API_BASE}/personnel/staff-files/${staffId}/signature`,
        { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : undefined, body: fd });
      if (!res.ok) throw new Error((await res.json().catch(() => ({ error: res.statusText }))).error ?? res.statusText);
      setSigNonce(n => n + 1);
      await load();
    } catch (e) { onError(errorText(e)); }
    finally { setSigBusy(false); if (sigInput.current) sigInput.current.value = ''; }
  }

  const field = (label: string, value?: string | null) =>
    <div className="sf-field"><span>{label}</span><strong>{value || '—'}</strong></div>;

  // In "All records" the table is broken by heading, the way a paper file is
  // divided by its tabs. Filtered to one heading it is a plain list.
  const grouped = category === 'All records'
    ? (file?.categories ?? []).filter(c => items.some(i => i.category === c)).map(c => [c, items.filter(i => i.category === c)] as const)
    : [[category, items] as const];

  const rowFor = (item: StaffFileItem, n: number) => <tr key={item.key}
    className={item.can_open ? 'clickable-row' : undefined}
    title={item.can_open ? 'Click to open' : undefined}
    onClick={() => item.can_open && setReading(item)}>
    <td className="dm-num">{n}</td>
    <td className="dm-code">{item.reference || '—'}</td>
    <td className="sf-record">{item.title}</td>
    <td>{item.record_type}</td>
    <td className="dm-date">{item.date || '—'}</td>
    <td className="dm-date">{expiryCell(item.expiry)}</td>
    <td>{badge(item.status)}</td>
    <td className="dm-actions" onClick={e => e.stopPropagation()}>
      {item.can_open
        ? <button type="button" className="link-btn" onClick={() => setReading(item)}>Open</button>
        : <span className="dm-dim">restricted</span>}
      {canEdit && item.key.startsWith('staff-document:') &&
        <button type="button" className="pq-link" onClick={() => editDocument(item)}>Edit</button>}
      {canVerify && item.key.startsWith('staff-document:') && item.status === 'pending' &&
        <button type="button" className="pq-link" onClick={() => verify(item.id)}>Verify</button>}
    </td>
  </tr>;

  const toolbar = <>
    <span className="sf-count">{file ? `${file.items.length} record${file.items.length === 1 ? '' : 's'} on file` : 'Opening…'}</span>
    <span style={{ flex: 1 }} />
    {canCreate && <button type="button" className="rw-btn" onClick={() => (adding ? closeForm() : setAdding(true))}>
      <Upload size={14} />{adding ? 'Cancel' : 'Add document'}
    </button>}
    {file?.mayPrintFile && <button type="button" className="rw-btn"
      onClick={() => openPrintable(`/personnel/staff-files/${staffId}/print`).catch(e => onError(errorText(e)))}>
      <Printer size={14} />Print file
    </button>}
  </>;

  return <>
    <RecordWindow
      title={String(s.full_name || 'Staff file')}
      subtitle={[s.employee_no, s.designation, s.unit || s.section_name].filter(Boolean).join(' · ') || null}
      onClose={onClose}
      toolbar={toolbar}
      restoreLabel={String(s.full_name || 'Staff file')}
    >
      <style>{SF_CSS}</style>
      {!file ? <p className="muted" style={{ padding: 24 }}>Opening the staff file…</p> : <div className="sf-page">

        <section className="sf-identity">
          <span className="sf-avatar">{initialsOf(s.full_name)}</span>
          <div className="sf-who">
            <h3>{s.full_name}</h3>
            <p>{[s.job_title, s.unit || s.section_name, s.department_name].filter(Boolean).join(' · ') || '—'}</p>
            <div className="sf-tags">
              {s.employee_no && <span className="badge">{s.employee_no}</span>}
              {s.personnel_category && <span className="badge">{s.personnel_category}</span>}
              {s.availability_status && <span className={`badge ${String(s.availability_status).toLowerCase().replace(/\s+/g, '-')}`}>{String(s.availability_status).replace(/_/g, ' ')}</span>}
              {s.is_active ? null : <span className="badge danger">left the laboratory</span>}
            </div>
          </div>
        </section>

        <section className="sf-panels">
          <div className="sf-panel">
            <h4>Appointment</h4>
            <div className="sf-grid">
              {field('Position', s.job_title)}
              {field('Designation', s.designation)}
              {field('Posts held', (file.positions || []).filter(p => p.is_active).map(p => p.title).join(', '))}
              {field('Unit', s.unit || s.section_name)}
              {field('Department', s.department_name)}
              {field('Appointment', [s.appointment_type, s.appointment_date].filter(Boolean).join(' · '))}
            </div>
          </div>
          <div className="sf-panel">
            <h4>Professional registration</h4>
            <div className="sf-grid">
              {field('Regulator', s.professional_regulator)}
              {field('Licence', s.professional_licence)}
              {field('Licence expiry', s.licence_expiry_date)}
              {field('Qualifications', s.qualifications)}
              {field('Cadre', s.cadre)}
              {field('Rank', s.professional_rank)}
            </div>
          </div>
          <div className="sf-panel">
            <h4>Signature on file</h4>
            <div className="sf-sig">
              {file.hasSignature
                ? <span className="sf-sig-box"><SignatureThumb key={sigNonce} staffId={staffId} height={38} /></span>
                : <span className="sf-sig-none">No signature on file — this member of staff cannot sign any record until one is added.</span>}
              {canEdit && <>
                <button type="button" className="pq-link" disabled={sigBusy} onClick={() => sigInput.current?.click()}>
                  <PenLine size={13} />{sigBusy ? 'Uploading…' : file.hasSignature ? 'Replace' : 'Upload signature'}
                </button>
                <input ref={sigInput} type="file" accept="image/*" style={{ display: 'none' }}
                  onChange={e => { const f = e.target.files?.[0]; if (f) void uploadSignature(f); }} />
              </>}
            </div>
          </div>

          <div className="sf-panel">
            <h4>Personal &amp; contact</h4>
            <div className="sf-grid">
              {field('Date of birth', s.date_of_birth)}
              {field('Gender', s.gender)}
              {field('National ID', [s.national_id_type, s.national_id_number].filter(Boolean).join(' — '))}
              {field('Phone', s.phone)}
              {field('Email', s.email)}
              {field('Emergency contact', s.emergency_contact)}
              {field('File location', s.staff_file_location)}
            </div>
          </div>
        </section>

        {adding && (editingId ? canEdit : canCreate) && <form className="sf-form" onSubmit={submitDocument}>
          <h4>{editingId ? 'Edit document' : 'Add a document to this file'}</h4>
          <div className="form-grid">
            <label>Type<select value={form.documentType} onChange={e => setForm({ ...form, documentType: e.target.value })} required>
              {STAFF_DOC_TYPES.map(t => <option key={t} value={t}>{t}</option>)}</select></label>
            <label>Title<TextField value={form.title} onValue={v => setForm({ ...form, title: v })} required /></label>
            <label>Issue date<input type="date" value={form.issueDate} onChange={e => setForm({ ...form, issueDate: e.target.value })} /></label>
            <label>Expiry date<input type="date" value={form.expiryDate} onChange={e => setForm({ ...form, expiryDate: e.target.value })} /></label>
            <label>File<input type="file" onChange={e => setUpload(e.target.files?.[0] ?? null)} /></label>
            <label>Remarks<TextField value={form.remarks} onValue={v => setForm({ ...form, remarks: v })} /></label>
            <button type="submit" disabled={busy}>{busy ? 'Saving…' : editingId ? 'Save changes' : 'Add to file'}</button>
          </div>
        </form>}

        <section className="sf-records">
          <div className="sf-cats">
            {categories.map(c => <button key={c} type="button" className={category === c ? 'active' : ''} onClick={() => setCategory(c)}>
              {c}<span className="n">{c === 'All records' ? file.items.length : file.counts[c] ?? 0}</span>
            </button>)}
          </div>

          <div className="dm-table-wrap">
            <table className="data-table dm-table sf-table"><thead><tr>
              <th style={{ width: '4%' }}>No.</th>
              <th style={{ width: '14%' }}>Reference</th>
              <th>Record</th>
              <th style={{ width: '13%' }}>Type</th>
              <th style={{ width: '10%' }}>Date</th>
              <th style={{ width: '12%' }}>Expiry</th>
              <th style={{ width: '11%' }}>Status</th>
              <th style={{ width: '15%' }}>Actions</th>
            </tr></thead><tbody>
              {grouped.map(([heading, rows]) => rows.length === 0 ? null : <Fragment key={heading}>
                {category === 'All records' && <tr className="sf-group"><td colSpan={8}>{heading}<span>{rows.length}</span></td></tr>}
                {rows.map((item, i) => rowFor(item, i + 1))}
              </Fragment>)}
              {items.length === 0 && <tr><td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 28 }}>
                Nothing filed under this heading yet.
              </td></tr>}
            </tbody></table>
          </div>
        </section>
      </div>}
    </RecordWindow>

    {reading && reading.open.kind === 'document' && <Suspense fallback={null}>
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

const SF_CSS = `.sf-page{padding:18px 20px 26px;display:flex;flex-direction:column;gap:18px}
.sf-identity{display:flex;align-items:center;gap:16px}
.sf-avatar{width:52px;height:52px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex:none;
  background:linear-gradient(140deg,var(--accent,#2f6bff),#1B49C0);color:#fff;font-weight:700;font-size:17px;letter-spacing:.02em}
.sf-who h3{margin:0;font-size:19px;letter-spacing:-.01em}
.sf-who p{margin:3px 0 0;font-size:12.5px;color:var(--muted)}
.sf-tags{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
.sf-panels{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px}
.sf-panel{border:1px solid var(--border);border-radius:12px;padding:14px 16px;background:var(--panel)}
.sf-panel h4{margin:0 0 12px;font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);font-weight:700}
.sf-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:12px 16px}
.sf-field{display:flex;flex-direction:column;gap:3px;min-width:0}
.sf-field span{font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.sf-field strong{font-size:12.5px;font-weight:600;overflow-wrap:anywhere;line-height:1.35}
.sf-sig{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.sf-sig-box{display:inline-flex;align-items:center;justify-content:center;width:150px;height:46px;border:1px solid var(--border);border-radius:8px;background:#fff;padding:4px}
.sf-sig-none{font-size:12px;color:var(--warning,#e0a33a);max-width:26ch;line-height:1.4}
.sf-form{border:1px solid var(--border);border-radius:12px;padding:14px 16px;background:var(--panel)}
.sf-form h4{margin:0 0 10px;font-size:13px}
.sf-form .form-grid{margin:0}
.sf-records{display:flex;flex-direction:column;gap:10px}
.sf-cats{display:flex;gap:6px;flex-wrap:wrap}
.sf-cats button{padding:5px 12px;font-size:12px;border-radius:999px;background:transparent;border:1px solid var(--border);
  color:var(--muted);cursor:pointer;box-shadow:none;display:inline-flex;align-items:center;gap:7px}
.sf-cats button:hover{color:var(--text);border-color:var(--border-strong)}
.sf-cats button.active{background:var(--accent-soft);border-color:var(--accent-bright);color:var(--text)}
.sf-cats .n{font-variant-numeric:tabular-nums;opacity:.65;font-size:11px}
.sf-count{font-size:12.5px;color:var(--muted)}
.sf-table .sf-record{font-weight:600;line-height:1.35}
.sf-table tr.sf-group td{background:rgba(255,255,255,.035);font-size:10px;letter-spacing:.1em;text-transform:uppercase;
  font-weight:700;color:var(--accent-bright);padding:7px 10px}
.sf-table tr.sf-group td span{margin-left:8px;opacity:.6;letter-spacing:0}
.sf-table .dm-actions .pq-link{padding:4px 9px}`;

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
