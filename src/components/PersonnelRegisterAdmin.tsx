import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { Download, Upload, FileSpreadsheet, Search, Pencil, Archive, RotateCcw, Trash2, AlertTriangle, ShieldAlert, Users } from 'lucide-react';
import { api, API_BASE, getToken, errorText } from '../services/api';
import { usePermissions } from '../hooks/usePermissions';
import { DetailModal, RowMenu } from './ui';
import {
  GENDERS, PERSONNEL_CATEGORIES, APPOINTMENT_TYPES, NATIONAL_ID_TYPES, CADRES, AVAILABILITY_STATUSES, EXIT_REASONS,
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
   missing: edit, record a departure, erase. Import/export sits on the same
   screen, using the same one approved workbook as Personnel Management.

   Leaving and erasing are deliberately different things:
     · Departure — access, rosters and authorizations end and the person moves
                   to Former staff WITH THE REASON STATED. "Retired" is one
                   reason among several; a transfer, the end of an internship
                   and a dismissal are different events and the register has to
                   be able to say which. The history keeps naming them.
     · Erase     — the row disappears. Offered freely only when the person left
                   no trace in the laboratory record; where they did, it takes a
                   written reason, for the demonstration rows a live system has
                   grown around.
   ========================================================================= */

/**
 * Has this person left the laboratory?
 *
 * SQLite has no boolean, so `is_active` comes back as 0 or 1 and a `=== false`
 * test silently matches nothing — which is how a departed row can end up
 * offering "Record departure…" and hiding "Return to the register".
 */
const hasLeft = (s: Staff) => !s.isActive;


type ImportResult = { created: number; updated: number; skipped?: number; errors: string[] };
type DeletionImpact = {
  staff: { id: number; fullName: string; employeeNo: string | null; isActive: boolean };
  account: { id: number; username: string; isActive: boolean } | null;
  blockers: string[];
  canDeactivate: boolean;
  canDelete: boolean;
  canForceDelete: boolean;
  historicReferences: { table: string; column: string; rows: number; label: string }[];
  totalHistoricRows: number;
};

export default function PersonnelRegisterAdmin() {
  const { can } = usePermissions();
  const [staff, setStaff] = useState<Staff[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [positions, setPositions] = useState<Position[]>([]);
  const [ranks, setRanks] = useState<ProfessionalRank[]>([]);
  const [former, setFormer] = useState<Staff[]>([]);
  const [query, setQuery] = useState('');
  // People who have left are not colleagues you can roster or assign work to,
  // so they are not in the register at all — they are a list of their own,
  // closed until somebody goes looking for them.
  const [view, setView] = useState<'active' | 'former'>('active');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [editing, setEditing] = useState<Staff | null>(null);
  const [form, setForm] = useState<StaffFormValues>(emptyStaffForm());
  // Recording a departure and erasing a record are different decisions with
  // different consequences, so they are different dialogs. Neither is reachable
  // by mis-clicking the other.
  const [departing, setDeparting] = useState<Staff | null>(null);
  const [exitForm, setExitForm] = useState({ exitReason: '', exitDate: new Date().toISOString().slice(0, 10), notes: '' });
  const [deleting, setDeleting] = useState<DeletionImpact | null>(null);
  const [confirmName, setConfirmName] = useState('');
  const [forceReason, setForceReason] = useState('');
  const [forcing, setForcing] = useState(false);

  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const importInput = useRef<HTMLInputElement>(null);

  const mayEdit = can('personnel.register', 'edit');
  const mayRemove = can('personnel.register', 'void_archive');
  const mayImport = can('personnel.register', 'import');
  const mayExport = can('personnel.register', 'export');

  const load = () => Promise.all([
    api<Staff[]>('/staff').then(setStaff),
    api<Staff[]>('/staff?status=retired').then(setFormer).catch(() => setFormer([])),
  ]).catch(e => setError(errorText(e)));
  useEffect(() => {
    void load();
    api<Section[]>('/sections').then(setSections).catch(() => setSections([]));
    api<Position[]>('/positions').then(setPositions).catch(() => setPositions([]));
    api<ProfessionalRank[]>('/professional-ranks').then(setRanks).catch(() => setRanks([]));
  }, []);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const source = view === 'former' ? former : staff;
    return source.filter(s => !q || [s.fullName, s.employeeNo, s.jobTitle, s.designation, s.unit, s.sectionName, s.username]
      .some(v => v?.toLowerCase().includes(q)));
  }, [staff, former, query, view]);

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
    } catch (e) { setError(errorText(e)); }
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
    } catch (e) { setError(errorText(e)); }
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
    } catch (err) { setError(errorText(err)); }
    finally { setBusy(null); }
  }

  // ---- Return somebody to the register -------------------------------------
  async function restore(s: Staff) {
    setBusy(`restore-${s.id}`); setError(null);
    try {
      await api(`/staff/${s.id}/reactivate`, { method: 'POST', body: JSON.stringify({}) });
      setNotice(`${s.fullName} is back in the active register.`);
      await load();
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(null); }
  }

  // ---- Record a departure (the ordinary answer for somebody who has left) --
  function openDeparture(s: Staff) {
    setDeparting(s);
    setExitForm({ exitReason: '', exitDate: new Date().toISOString().slice(0, 10), notes: '' });
    setError(null); setNotice(null);
  }
  async function doDeparture() {
    if (!departing) return;
    setBusy('depart'); setError(null);
    try {
      const r = await api<{ accountDeactivated?: boolean; exitReason?: string }>(`/staff/${departing.id}`, {
        method: 'DELETE', body: JSON.stringify(exitForm),
      });
      setNotice(`${departing.fullName} was recorded as having left — ${(r.exitReason || exitForm.exitReason).toLowerCase()}`
        + `${r.accountDeactivated ? ', and their login account deactivated' : ''}. Their history is unchanged.`);
      setDeparting(null);
      await load();
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(null); }
  }

  // ---- Erase (what the record leaves behind decides how it is offered) ----
  async function openDelete(s: Staff) {
    setBusy(`impact-${s.id}`); setError(null); setNotice(null);
    setConfirmName(''); setForceReason(''); setForcing(false);
    try {
      setDeleting(await api<DeletionImpact>(`/staff/${s.id}/deletion-impact`));
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(null); }
  }
  async function doDelete(mode: 'delete' | 'purge') {
    if (!deleting) return;
    setBusy(mode); setError(null);
    try {
      const r = await api<{ accountDeleted?: boolean; accountUnlinked?: string | null; detached?: number }>(
        `/staff/${deleting.staff.id}?mode=${mode}`,
        { method: 'DELETE', body: JSON.stringify(mode === 'purge' ? { reason: forceReason.trim() } : {}) },
      );
      setNotice(`${deleting.staff.fullName} was erased from the register${r.accountDeleted ? ' with their login account' : ''}`
        + (mode === 'purge' && r.detached ? `, and their name removed from ${r.detached} record${r.detached === 1 ? '' : 's'}` : '')
        + (r.accountUnlinked ? `. The login account “${r.accountUnlinked}” has its own history and was left in Users & Access` : '')
        + '.');
      setDeleting(null);
      await load();
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(null); }
  }

  const set = (k: keyof StaffFormValues) => (e: { target: { value: string } }) => setForm(f => ({ ...f, [k]: e.target.value }));

  return <div className="reg-admin">
    <div className="card">
      <div className="reg-head">
        <div className="reg-head-text">
          <h3>Master Personnel Register</h3>
          <p className="muted">
            Everyone currently working in the laboratory, with the same record Personnel Management holds.
            Somebody who leaves is recorded with the reason — retirement, transfer, end of contract — and moves
            to <strong>Former staff</strong>, out of the register, the roster and the export, where that list can
            be exported in its own right. Import and export use the one approved workbook — rows are matched on
            Staff ID, so existing people are updated and new ones created.
          </p>
        </div>
        <div className="reg-head-actions">
          <label className="reg-search">
            <Search size={15} />
            <input placeholder="Search name, Staff ID, position, unit…" value={query} onChange={e => setQuery(e.target.value)} />
          </label>
          {mayExport && view === 'active' && <button type="button" className="secondary" disabled={busy === '/staff/template'} onClick={() => download('/staff/template', 'Staff_Register_Template.xlsx')}>
            <FileSpreadsheet size={15} /> {busy === '/staff/template' ? 'Preparing…' : 'Blank template'}
          </button>}
          {mayExport && <button type="button" className="secondary" disabled={!!busy?.startsWith('/staff/export')}
            title={view === 'former' ? 'Download the former-staff list, with the reason and date each person left' : 'Download the Master Personnel Register'}
            onClick={() => (view === 'former'
              ? download('/staff/export?status=former', 'Former_Personnel.xlsx')
              : download('/staff/export', 'Master_Personnel_Register.xlsx'))}>
            <Download size={15} /> {busy?.startsWith('/staff/export') ? 'Exporting…' : view === 'former' ? 'Export former staff' : 'Export'}
          </button>}
          {mayImport && view === 'active' && <>
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
        <div className="reg-seg" role="tablist" aria-label="Register section">
          <button type="button" role="tab" aria-selected={view === 'active'} className={view === 'active' ? 'on' : ''} onClick={() => setView('active')}>
            <Users size={14} /> Register <span className="reg-count">{staff.length}</span>
          </button>
          <button type="button" role="tab" aria-selected={view === 'former'} className={view === 'former' ? 'on' : ''} onClick={() => setView('former')}>
            <Archive size={14} /> Former staff <span className="reg-count">{former.length}</span>
          </button>
        </div>
        <span className="muted">{rows.length} {rows.length === 1 ? 'person' : 'people'}</span>
      </div>

      <div className="table-scroll">
        <table className="data-table reg-table">
          <thead><tr>
            <th>Person</th><th>Role</th><th>Unit</th>
            {view === 'former' ? <th>Reason for leaving</th> : <th>Licence</th>}
            {view === 'former' ? <th>Left</th> : <th>Login account</th>}
            <th className="reg-actions-col">Actions</th>
          </tr></thead>
          <tbody>
            {rows.map(s => {
              const today = new Date().toISOString().slice(0, 10);
              const soon = new Date(Date.now() + 60 * 864e5).toISOString().slice(0, 10);
              const licExpired = s.licenceExpiryDate && s.licenceExpiryDate < today;
              const licSoon = s.licenceExpiryDate && !licExpired && s.licenceExpiryDate <= soon;
              const departed = hasLeft(s);
              return <tr key={s.id} className={departed ? 'row-retired' : ''}>
                <td>
                  <span className="reg-primary">{s.fullName}{s.initials ? <span className="muted"> ({s.initials})</span> : null}</span>
                  <span className="reg-sub">
                    {s.employeeNo || 'No Staff ID'}
                    {s.personnelCategory ? ` · ${s.personnelCategory}` : ''}
                    {departed && view !== 'former' ? <span className="badge inactive">{s.exitReason || 'left'}</span> : null}
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
                {view === 'former'
                  ? <td>
                      <span className="reg-primary">{s.exitReason || '—'}</span>
                      {s.exitNotes && <span className="reg-sub">{s.exitNotes}</span>}
                    </td>
                  : <td>
                      <span className="reg-primary">{s.professionalLicence || '—'}</span>
                      {s.licenceExpiryDate && <span className="reg-sub">
                        expires {s.licenceExpiryDate}
                        {licExpired && <span className="badge danger">expired</span>}
                        {licSoon && <span className="badge warning">soon</span>}
                      </span>}
                    </td>}
                {view === 'former'
                  ? <td>
                      <span className="reg-primary">{s.exitDate || '—'}</span>
                      {s.username && <span className="reg-sub">account {s.username}</span>}
                    </td>
                  : <td>
                      {s.username
                        ? <><span className="reg-primary">{s.username}</span><span className="reg-sub">{s.roleName || 'No role'}</span></>
                        : <span className="muted">None</span>}
                    </td>}
                <td className="reg-actions-col">
                  {/* Editing is the everyday act, so it is a button. Retiring
                      and erasing are not, so they sit under the menu where a
                      slipped click cannot reach them. */}
                  <div className="reg-row-actions">
                    {mayEdit && <button type="button" className="tiny" onClick={() => openEdit(s)}><Pencil size={13} /> Edit</button>}
                    {(mayEdit || mayRemove) && <RowMenu label={`More actions for ${s.fullName}`}>
                      {close => <>
                        {mayEdit && departed && <button type="button" role="menuitem" disabled={busy === `restore-${s.id}`}
                          onClick={() => { close(); void restore(s); }}><RotateCcw size={13} /> Return to the register</button>}
                        {mayRemove && !departed && <button type="button" role="menuitem"
                          onClick={() => { close(); openDeparture(s); }}><Archive size={13} /> Record departure…</button>}
                        {mayRemove && <button type="button" role="menuitem" className="danger" disabled={busy === `impact-${s.id}`}
                          onClick={() => { close(); void openDelete(s); }}><Trash2 size={13} /> Erase permanently…</button>}
                      </>}
                    </RowMenu>}
                  </div>
                </td>
              </tr>;
            })}
            {rows.length === 0 && <tr><td colSpan={6} className="muted" style={{ padding: 18, textAlign: 'center' }}>
              {query.trim() ? 'Nobody matches that search.'
                : view === 'former' ? 'Nobody has left the laboratory.'
                : 'No staff records yet — register someone on the Register New Staff tab, or import the workbook above.'}
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
      {can('personnel.self', 'view') && <form id="reg-edit-form" className="form-grid" onSubmit={saveEdit}>
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
        <label>Assign position<select value={form.positionId} onChange={set('positionId')}><option value="">— keep current —</option>{positions.filter(p => !!p.isActive).map(p => <option key={p.id} value={p.id}>{p.title}</option>)}</select></label>
        <label>Staff file location<input value={form.staffFileLocation} onChange={set('staffFileLocation')} placeholder="e.g. /SECH-LAB-PERSONNEL-FILES/SNO-001/" /></label>
      </form>}
    </DetailModal>

    {/* --- Record a departure ----------------------------------------------- */}
    <DetailModal
      open={!!departing}
      onClose={() => setDeparting(null)}
      width="narrow"
      title={departing ? `Record ${departing.fullName}’s departure` : ''}
      subtitle={departing?.employeeNo ? `Staff ID ${departing.employeeNo}` : undefined}
      footer={<>
        <button type="button" className="secondary" onClick={() => setDeparting(null)}>Cancel</button>
        {can('personnel.register', 'void_archive') && <button type="button" disabled={busy === 'depart' || !exitForm.exitReason} onClick={doDeparture}>
          {busy === 'depart' ? 'Recording…' : 'Record departure'}
        </button>}
      </>}
    >
      {error && <div className="error">{error}</div>}
      <p className="dialog-lead">
        They leave the register, the roster and the Excel export, their access ends and their technical
        authorizations are withdrawn. Everything they signed, reviewed or wrote keeps their name on it.
      </p>
      <div className="form-grid">
        <label>Reason for leaving
          <select value={exitForm.exitReason} onChange={e => setExitForm(f => ({ ...f, exitReason: e.target.value }))} required>
            <option value="">Select a reason…</option>
            {EXIT_REASONS.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
        </label>
        <label>Date of leaving
          <input type="date" value={exitForm.exitDate} onChange={e => setExitForm(f => ({ ...f, exitDate: e.target.value }))} />
        </label>
        <label className="wide">Notes <span className="muted">(optional)</span>
          <input value={exitForm.notes} onChange={e => setExitForm(f => ({ ...f, notes: e.target.value }))}
            placeholder="e.g. Transferred to Regional Hospital laboratory" />
        </label>
      </div>
      <p className="dialog-lead muted">
        They move to <strong>Former staff</strong>, where the reason and date are kept and can be exported. If they
        come back, returning them to the register clears the departure.
      </p>
    </DetailModal>

    {/* --- Erase ------------------------------------------------------------ */}
    <DetailModal
      open={!!deleting}
      onClose={() => setDeleting(null)}
      width="narrow"
      title={deleting ? `Erase ${deleting.staff.fullName}` : ''}
      subtitle={deleting?.staff.employeeNo ? `Staff ID ${deleting.staff.employeeNo}` : undefined}
    >
      {deleting && <div className="remove-flow">
        {error && <div className="error">{error}</div>}
        {deleting.blockers.length > 0 && <div className="error"><ShieldAlert size={15} /> {deleting.blockers.join(' ')}</div>}

        {/* Nothing to lose: the ordinary erase. */}
        {deleting.canDelete && <>
          <p className="dialog-lead">
            This person is named nowhere in the laboratory record, so the row can simply go.
            {deleting.account && <> Their unused login account <strong>{deleting.account.username}</strong> goes with it.</>}
            {' '}This cannot be undone.
          </p>
          <label className="remove-confirm">
            <span>Type <strong>{deleting.staff.fullName}</strong> to confirm</span>
            <input value={confirmName} onChange={e => setConfirmName(e.target.value)} placeholder={deleting.staff.fullName} />
          </label>
          {can('personnel.register', 'void_archive') && <button type="button" className="danger" disabled={busy === 'delete' || confirmName.trim().toLowerCase() !== deleting.staff.fullName.trim().toLowerCase()}
            onClick={() => doDelete('delete')}>
            {busy === 'delete' ? 'Erasing…' : 'Erase permanently'}
          </button>}
        </>}

        {/* Named in the record: a departure is the answer, unless this is one of the
            demonstration rows a live system grew around — then the force erase
            below cuts the name out and leaves the records standing. */}
        {!deleting.canDelete && deleting.blockers.length === 0 && <>
          <div className="remove-note">
            <AlertTriangle size={15} />
            <div>
              <p><strong>{deleting.staff.fullName}</strong> is named in <strong>{deleting.totalHistoricRows}</strong> record{deleting.totalHistoricRows === 1 ? '' : 's'}.</p>
              <ul className="link-list">
                {deleting.historicReferences.slice(0, 6).map(r => <li key={`${r.table}.${r.column}`}>{r.label}</li>)}
                {deleting.historicReferences.length > 6 && <li className="muted">…and {deleting.historicReferences.length - 6} more</li>}
              </ul>
              <p className="muted">If this was a real colleague, record their departure instead — the record keeps their name and the trail stays intact.</p>
            </div>
          </div>

          {deleting.canForceDelete && (!forcing
            ? <button type="button" className="secondary" onClick={() => setForcing(true)}>
                This was a demonstration record — erase it anyway
              </button>
            : <div className="remove-option danger">
                <div className="remove-option-head"><Trash2 size={17} /><h4>Erase anyway</h4></div>
                <p>
                  Their name is removed from all {deleting.totalHistoricRows} record{deleting.totalHistoricRows === 1 ? '' : 's'} and
                  the row is deleted. The records themselves stay — they simply no longer name anybody. Rows that
                  cannot exist without a person, such as attestation assignments and roster slots, are removed with them.
                  The audit trail keeps who was erased and why. This cannot be undone.
                </p>
                <label className="remove-confirm">
                  <span>Why is this record being erased?</span>
                  <input value={forceReason} onChange={e => setForceReason(e.target.value)}
                    placeholder="e.g. Demonstration record created during setup, never a member of staff" />
                </label>
                <label className="remove-confirm">
                  <span>Type <strong>{deleting.staff.fullName}</strong> to confirm</span>
                  <input value={confirmName} onChange={e => setConfirmName(e.target.value)} placeholder={deleting.staff.fullName} />
                </label>
                <div className="remove-acts">
                  <button type="button" className="secondary" onClick={() => { setForcing(false); setForceReason(''); setConfirmName(''); }}>Cancel</button>
                  {can('personnel.register', 'void_archive') && <button type="button" className="danger"
                    disabled={busy === 'purge' || forceReason.trim().length < 10 || confirmName.trim().toLowerCase() !== deleting.staff.fullName.trim().toLowerCase()}
                    onClick={() => doDelete('purge')}>
                    {busy === 'purge' ? 'Erasing…' : 'Erase and remove the name'}
                  </button>}
                </div>
              </div>)}
        </>}
      </div>}
    </DetailModal>

  </div>;
}
