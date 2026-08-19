import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { Download, Upload, FileSpreadsheet, Search, Pencil, Archive, RotateCcw, Trash2, AlertTriangle, ShieldAlert } from 'lucide-react';
import { api, API_BASE, getToken } from '../services/api';
import { usePermissions } from '../hooks/usePermissions';
import { DetailModal } from './ui';
import {
  GENDERS, PERSONNEL_CATEGORIES, APPOINTMENT_TYPES, NATIONAL_ID_TYPES, CADRES, AVAILABILITY_STATUSES,
  emptyStaffForm, staffFormFrom, yearsOfService, type StaffFormValues,
} from '../../shared/constants/personnel';
import type { Staff, Section, Position, ProfessionalRank } from '../../shared/types/api';

/* ============================================================================
   MASTER PERSONNEL REGISTER — administration

   The register itself lives in Personnel Management, but the people who
   maintain it work in Settings: they are the ones who onboard staff, hand out
   accounts, and clear up after a demonstration database. Until now they could
   add a person here and then had to go somewhere else to correct them, and
   nowhere at all to remove them — which is how a laboratory ends up running on
   real staff with the demo rows still in the roster.

   So this is the whole register, in Settings, with the three verbs that were
   missing: edit, retire, erase. Import/export sits on the same screen, using
   the same one approved workbook as Personnel Management.

   Retire and erase are deliberately different things:
     · Retire  — access, rosters and authorizations end; the history keeps
                 naming them. This is the right answer for anyone who worked.
     · Erase   — the row disappears. Offered only when the person left no trace
                 in the laboratory record, which is exactly the demonstration
                 rows this screen exists to clear.
   ========================================================================= */

type ImportResult = { created: number; updated: number; skipped?: number; errors: string[] };
type DeletionImpact = {
  staff: { id: number; fullName: string; employeeNo: string | null; isActive: boolean };
  account: { id: number; username: string; isActive: boolean } | null;
  blockers: string[];
  canDeactivate: boolean;
  canDelete: boolean;
  historicReferences: { table: string; column: string; rows: number; label: string }[];
  totalHistoricRows: number;
};

export default function PersonnelRegisterAdmin() {
  const { can } = usePermissions();
  const [staff, setStaff] = useState<Staff[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [positions, setPositions] = useState<Position[]>([]);
  const [ranks, setRanks] = useState<ProfessionalRank[]>([]);
  const [query, setQuery] = useState('');
  const [showRetired, setShowRetired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [editing, setEditing] = useState<Staff | null>(null);
  const [form, setForm] = useState<StaffFormValues>(emptyStaffForm());
  const [removing, setRemoving] = useState<DeletionImpact | null>(null);
  const [confirmName, setConfirmName] = useState('');

  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const importInput = useRef<HTMLInputElement>(null);

  const mayEdit = can('personnel.register', 'edit');
  const mayRemove = can('personnel.register', 'void_archive');
  const mayImport = can('personnel.register', 'create');
  const mayExport = can('personnel.register', 'export') || can('personnel', 'export');

  const load = () => api<Staff[]>('/staff').then(setStaff).catch(e => setError((e as Error).message));
  useEffect(() => {
    void load();
    api<Section[]>('/sections').then(setSections).catch(() => setSections([]));
    api<Position[]>('/positions').then(setPositions).catch(() => setPositions([]));
    api<ProfessionalRank[]>('/professional-ranks').then(setRanks).catch(() => setRanks([]));
  }, []);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return staff
      .filter(s => (showRetired ? true : s.isActive !== false))
      .filter(s => !q || [s.fullName, s.employeeNo, s.jobTitle, s.designation, s.unit, s.sectionName, s.username]
        .some(v => v?.toLowerCase().includes(q)));
  }, [staff, query, showRetired]);

  const retiredCount = staff.filter(s => s.isActive === false).length;

  // ---- Excel round-trip (the same workbook Personnel Management uses) ------
  async function download(path: string, fallback: string) {
    setError(null); setBusy(path);
    try {
      const token = getToken();
      const res = await fetch(`${API_BASE}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : undefined });
      if (!res.ok) throw new Error((await res.json().catch(() => ({ error: res.statusText }))).error ?? res.statusText);
      const blob = await res.blob();
      const named = (res.headers.get('Content-Disposition') || '').match(/filename="?([^"]+)"?/);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = named ? named[1] : fallback;
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  }

  async function importRegister(file: File) {
    setError(null); setNotice(null); setImportResult(null); setBusy('import');
    try {
      const fd = new FormData(); fd.append('file', file);
      const token = getToken();
      const res = await fetch(`${API_BASE}/staff/import`, { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : undefined, body: fd });
      const data = await res.json().catch(() => ({ error: res.statusText }));
      if (!res.ok) throw new Error(data.error ?? res.statusText);
      setImportResult(data as ImportResult);
      await load();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(null); if (importInput.current) importInput.current.value = ''; }
  }

  // ---- Edit ----------------------------------------------------------------
  function openEdit(s: Staff) {
    setEditing(s);
    setForm({ ...staffFormFrom(s as unknown as Record<string, unknown>), sectionId: s.sectionId ? String(s.sectionId) : '' });
    setError(null); setNotice(null);
  }
  async function saveEdit(e: FormEvent) {
    e.preventDefault();
    if (!editing) return;
    setBusy('save'); setError(null);
    try {
      await api(`/staff/${editing.id}`, { method: 'PUT', body: JSON.stringify(form) });
      setNotice(`${editing.fullName} updated.`);
      setEditing(null);
      await load();
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(null); }
  }

  // ---- Retire / restore ----------------------------------------------------
  async function restore(s: Staff) {
    setBusy(`restore-${s.id}`); setError(null);
    try {
      await api(`/staff/${s.id}/reactivate`, { method: 'POST', body: JSON.stringify({}) });
      setNotice(`${s.fullName} is back in the active register.`);
      await load();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  }

  // ---- Remove (the screen decides retire vs erase from the impact) ---------
  async function openRemove(s: Staff) {
    setBusy(`impact-${s.id}`); setError(null); setNotice(null); setConfirmName('');
    try {
      setRemoving(await api<DeletionImpact>(`/staff/${s.id}/deletion-impact`));
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  }
  async function doRemove(mode: 'deactivate' | 'delete') {
    if (!removing) return;
    setBusy(mode); setError(null);
    try {
      const r = await api<{ mode: string; accountDeleted?: boolean; accountDeactivated?: boolean }>(`/staff/${removing.staff.id}?mode=${mode}`, { method: 'DELETE' });
      setNotice(mode === 'delete'
        ? `${removing.staff.fullName} was permanently removed from the register${r.accountDeleted ? ', along with their login account' : ''}.`
        : `${removing.staff.fullName} was retired${r.accountDeactivated ? ' and their login account deactivated' : ''}. Their history is unchanged.`);
      setRemoving(null);
      await load();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  }

  const set = (k: keyof StaffFormValues) => (e: { target: { value: string } }) => setForm(f => ({ ...f, [k]: e.target.value }));

  return <div className="reg-admin">
    <div className="card">
      <div className="reg-head">
        <div className="reg-head-text">
          <h3>Master Personnel Register</h3>
          <p className="muted">
            Every member of laboratory personnel, with the same record Personnel Management holds.
            Correct a record here, retire someone who has left, or remove a row that was never real.
            Import and export use the one approved workbook — rows are matched on Staff ID, so existing
            people are updated and new ones created.
          </p>
        </div>
        <div className="reg-head-actions">
          <label className="reg-search">
            <Search size={15} />
            <input placeholder="Search name, Staff ID, position, unit…" value={query} onChange={e => setQuery(e.target.value)} />
          </label>
          <button type="button" className="secondary" disabled={busy === '/staff/template'} onClick={() => download('/staff/template', 'Staff_Register_Template.xlsx')}>
            <FileSpreadsheet size={15} /> {busy === '/staff/template' ? 'Preparing…' : 'Blank template'}
          </button>
          {mayExport && <button type="button" className="secondary" disabled={busy === '/staff/export'} onClick={() => download('/staff/export', 'Master_Personnel_Register.xlsx')}>
            <Download size={15} /> {busy === '/staff/export' ? 'Exporting…' : 'Export'}
          </button>}
          {mayImport && <>
            <button type="button" disabled={busy === 'import'} onClick={() => importInput.current?.click()}>
              <Upload size={15} /> {busy === 'import' ? 'Importing…' : 'Import'}
            </button>
            <input ref={importInput} type="file" accept=".xlsx,.xls" style={{ display: 'none' }}
              onChange={e => { const f = e.target.files?.[0]; if (f) void importRegister(f); }} />
          </>}
        </div>
      </div>

      {error && <div className="error">{error}</div>}
      {notice && <div className="notice-ok">{notice}</div>}
      {importResult && <div className="notice-ok">
        Import complete — <strong>{importResult.created}</strong> created, <strong>{importResult.updated}</strong> updated
        {typeof importResult.skipped === 'number' ? <>, <strong>{importResult.skipped}</strong> skipped</> : null}
        {importResult.errors.length > 0 && <ul className="link-list">{importResult.errors.slice(0, 8).map((er, i) => <li key={i}>{er}</li>)}</ul>}
      </div>}

      <div className="reg-filters">
        <span className="muted">{rows.length} {rows.length === 1 ? 'person' : 'people'} shown</span>
        {retiredCount > 0 && <label className="toggle">
          <input type="checkbox" checked={showRetired} onChange={e => setShowRetired(e.target.checked)} />
          Show retired ({retiredCount})
        </label>}
      </div>

      <div className="table-scroll">
        <table className="data-table reg-table">
          <thead><tr>
            <th>Person</th><th>Role</th><th>Unit</th><th>Licence</th><th>Login account</th>
            <th className="reg-actions-col">Actions</th>
          </tr></thead>
          <tbody>
            {rows.map(s => {
              const today = new Date().toISOString().slice(0, 10);
              const soon = new Date(Date.now() + 60 * 864e5).toISOString().slice(0, 10);
              const licExpired = s.licenceExpiryDate && s.licenceExpiryDate < today;
              const licSoon = s.licenceExpiryDate && !licExpired && s.licenceExpiryDate <= soon;
              return <tr key={s.id} className={s.isActive === false ? 'row-retired' : ''}>
                <td>
                  <span className="reg-primary">{s.fullName}{s.initials ? <span className="muted"> ({s.initials})</span> : null}</span>
                  <span className="reg-sub">
                    {s.employeeNo || 'No Staff ID'}
                    {s.personnelCategory ? ` · ${s.personnelCategory}` : ''}
                    {s.isActive === false ? <span className="badge inactive">retired</span> : null}
                  </span>
                </td>
                <td>
                  <span className="reg-primary">{s.designation || s.jobTitle || s.primaryPosition || '—'}</span>
                  <span className="reg-sub">
                    {s.jobTitle || s.primaryPosition || 'No position assigned'}
                    {s.appointmentDate ? ` · ${yearsOfService(s.appointmentDate)}` : ''}
                  </span>
                </td>
                <td>{s.unit || s.sectionName || '—'}</td>
                <td>
                  <span className="reg-primary">{s.professionalLicence || '—'}</span>
                  {s.licenceExpiryDate && <span className="reg-sub">
                    expires {s.licenceExpiryDate}
                    {licExpired && <span className="badge danger">expired</span>}
                    {licSoon && <span className="badge warning">soon</span>}
                  </span>}
                </td>
                <td>
                  {s.username
                    ? <><span className="reg-primary">{s.username}</span><span className="reg-sub">{s.roleName || 'No role'}</span></>
                    : <span className="muted">None</span>}
                </td>
                <td className="reg-actions-col">
                  <div className="reg-row-actions">
                    {mayEdit && <button type="button" className="tiny" onClick={() => openEdit(s)}><Pencil size={13} /> Edit</button>}
                    {mayEdit && s.isActive === false && <button type="button" className="tiny secondary" disabled={busy === `restore-${s.id}`} onClick={() => restore(s)}><RotateCcw size={13} /> Restore</button>}
                    {mayRemove && <button type="button" className="tiny danger" disabled={busy === `impact-${s.id}`} onClick={() => openRemove(s)}><Trash2 size={13} /> Remove</button>}
                  </div>
                </td>
              </tr>;
            })}
            {rows.length === 0 && <tr><td colSpan={6} className="muted" style={{ padding: 18, textAlign: 'center' }}>
              {staff.length === 0 ? 'No staff records yet — register someone on the Register New Staff tab, or import the workbook above.' : 'Nobody matches that search.'}
            </td></tr>}
          </tbody>
        </table>
      </div>
    </div>

    {/* --- Edit a register record ------------------------------------------ */}
    <DetailModal
      open={!!editing}
      onClose={() => setEditing(null)}
      title={editing ? `Edit ${editing.fullName}` : ''}
      subtitle={editing?.employeeNo ? `Staff ID ${editing.employeeNo}` : 'Master Personnel Register'}
      footer={<>
        <button type="button" className="secondary" onClick={() => setEditing(null)}>Cancel</button>
        <button type="submit" form="reg-edit-form" disabled={busy === 'save'}>{busy === 'save' ? 'Saving…' : 'Save changes'}</button>
      </>}
    >
      {error && <div className="error">{error}</div>}
      <form id="reg-edit-form" className="form-grid" onSubmit={saveEdit}>
        <label>Staff ID<input value={form.employeeNo} onChange={set('employeeNo')} placeholder="e.g. SNO-001" /></label>
        <label>Surname<input value={form.surname} onChange={set('surname')} /></label>
        <label>Middle name(s)<input value={form.middleName} onChange={set('middleName')} /></label>
        <label>First name(s)<input value={form.firstName} onChange={set('firstName')} /></label>
        <label>Initials<input value={form.initials} onChange={set('initials')} placeholder="auto" /></label>
        <label>Date of birth<input type="date" value={form.dateOfBirth} onChange={set('dateOfBirth')} /></label>
        <label>Gender<select value={form.gender} onChange={set('gender')}><option value="">—</option>{GENDERS.map(g => <option key={g} value={g}>{g}</option>)}</select></label>
        <label>Designation (grade)<input value={form.designation} onChange={set('designation')} placeholder="e.g. Principal Medical Lab Scientist" /></label>
        <label>Position / role<input value={form.jobTitle} onChange={set('jobTitle')} placeholder="e.g. Biochemistry Unit Head" /></label>
        <label>Unit / Section<select value={form.sectionId} onChange={set('sectionId')}><option value="">—</option>{sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label>Professional regulator<input value={form.professionalRegulator} onChange={set('professionalRegulator')} placeholder="e.g. AHPC" /></label>
        <label>Professional licence no.<input value={form.professionalLicence} onChange={set('professionalLicence')} /></label>
        <label>Licence expiry<input type="date" value={form.licenceExpiryDate} onChange={set('licenceExpiryDate')} /></label>
        <label>Qualifications<input value={form.qualifications} onChange={set('qualifications')} placeholder="Separate several with |" /></label>
        <label>Personnel category<select value={form.personnelCategory} onChange={set('personnelCategory')}>{PERSONNEL_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}</select></label>
        <label>Appointment type<select value={form.appointmentType} onChange={set('appointmentType')}>{APPOINTMENT_TYPES.map(c => <option key={c} value={c}>{c}</option>)}</select></label>
        <label>Date of appointment<input type="date" value={form.appointmentDate} onChange={set('appointmentDate')} /></label>
        <label>National ID type<select value={form.nationalIdType} onChange={set('nationalIdType')}>{NATIONAL_ID_TYPES.map(c => <option key={c} value={c}>{c}</option>)}</select></label>
        <label>National ID number<input value={form.nationalIdNumber} onChange={set('nationalIdNumber')} /></label>
        <label>Contact phone<input value={form.phone} onChange={set('phone')} /></label>
        <label>Email<input type="email" value={form.email} onChange={set('email')} /></label>
        <label>Emergency contact<input value={form.emergencyContact} onChange={set('emergencyContact')} placeholder="e.g. Spouse - 0200000000" /></label>
        <label>Cadre<select value={form.cadre} onChange={set('cadre')}><option value="">Auto (from designation)</option>{CADRES.map(c => <option key={c} value={c}>{c}</option>)}</select></label>
        <label>Professional rank<select value={form.professionalRank} onChange={set('professionalRank')}><option value="">Auto (from designation)</option>{ranks.map(r => <option key={r.id} value={r.name}>{r.name}</option>)}</select></label>
        <label>Availability<select value={form.availabilityStatus} onChange={set('availabilityStatus')}>{AVAILABILITY_STATUSES.map(a => <option key={a} value={a}>{a.replace(/_/g, ' ')}</option>)}</select></label>
        <label>Assign position<select value={form.positionId} onChange={set('positionId')}><option value="">— keep current —</option>{positions.filter(p => p.isActive !== false).map(p => <option key={p.id} value={p.id}>{p.title}</option>)}</select></label>
        <label>Staff file location<input value={form.staffFileLocation} onChange={set('staffFileLocation')} placeholder="e.g. /SECH-LAB-PERSONNEL-FILES/SNO-001/" /></label>
      </form>
    </DetailModal>

    {/* --- Retire or erase -------------------------------------------------- */}
    <DetailModal
      open={!!removing}
      onClose={() => setRemoving(null)}
      width="narrow"
      title={removing ? `Remove ${removing.staff.fullName}` : ''}
      subtitle={removing?.staff.employeeNo ? `Staff ID ${removing.staff.employeeNo}` : undefined}
    >
      {removing && <div className="remove-flow">
        {error && <div className="error">{error}</div>}
        {removing.blockers.length > 0 && <div className="error">
          <ShieldAlert size={15} /> {removing.blockers.join(' ')}
        </div>}

        <div className={`remove-option${removing.canDeactivate ? '' : ' disabled'}`}>
          <div className="remove-option-head"><Archive size={17} /><h4>Retire this person</h4><span className="badge">Recommended</span></div>
          <p>
            Their access, roster places and technical authorizations end immediately, and they leave the
            active register. Everything they signed, reviewed or wrote keeps their name on it — which is
            what an assessor expects to find.
            {removing.account && <> Their login account <strong>{removing.account.username}</strong> is deactivated with them.</>}
          </p>
          <button type="button" disabled={!removing.canDeactivate || busy === 'deactivate' || !removing.staff.isActive} onClick={() => doRemove('deactivate')}>
            {busy === 'deactivate' ? 'Retiring…' : removing.staff.isActive ? 'Retire from the register' : 'Already retired'}
          </button>
        </div>

        <div className={`remove-option danger${removing.canDelete ? '' : ' disabled'}`}>
          <div className="remove-option-head"><Trash2 size={17} /><h4>Erase permanently</h4></div>
          {removing.canDelete
            ? <>
                <p>
                  This person has left no trace in the laboratory record, so the row can simply go — this is
                  the way to clear demonstration entries and duplicate imports.
                  {removing.account && <> Their unused login account <strong>{removing.account.username}</strong> goes with it.</>}
                  {' '}It cannot be undone.
                </p>
                <label className="remove-confirm">
                  Type <strong>{removing.staff.fullName}</strong> to confirm
                  <input value={confirmName} onChange={e => setConfirmName(e.target.value)} placeholder={removing.staff.fullName} />
                </label>
                <button type="button" className="danger" disabled={busy === 'delete' || confirmName.trim().toLowerCase() !== removing.staff.fullName.trim().toLowerCase()} onClick={() => doRemove('delete')}>
                  {busy === 'delete' ? 'Erasing…' : 'Erase permanently'}
                </button>
              </>
            : <>
                <p><AlertTriangle size={14} /> This person appears in <strong>{removing.totalHistoricRows}</strong> laboratory record{removing.totalHistoricRows === 1 ? '' : 's'}, so erasing them would break the trail. Retire them instead.</p>
                <ul className="link-list">
                  {removing.historicReferences.slice(0, 8).map(r => <li key={`${r.table}.${r.column}`}>{r.label}</li>)}
                  {removing.historicReferences.length > 8 && <li className="muted">…and {removing.historicReferences.length - 8} more</li>}
                </ul>
              </>}
        </div>
      </div>}
    </DetailModal>
  </div>;
}
