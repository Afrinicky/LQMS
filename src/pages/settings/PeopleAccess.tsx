import { FormEvent, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errorText } from '../../services/api';
import { usePermissions } from '../../hooks/usePermissions';
import { Notice } from '../../components/ui/Feedback';
import { DetailModal } from '../../components/ui';
import TextField from '../../components/ui/TextField';
import PersonnelRegisterAdmin from '../../components/PersonnelRegisterAdmin';
import UserAccountActions from '../../components/UserAccountActions';
import PasswordResetApprovals from '../../components/PasswordResetApprovals';
import TrainingRecordPanel from '../../components/training/TrainingRecordPanel';
import { AccessControl } from '../AccessControl';
import { MODULES, PERMISSION_ACTIONS } from '../../../shared/constants/modules';
import { requiresClinicalUnit } from '../../../shared/constants/roles';
import { UNIT_GRANT_LEVEL_LABELS } from '../../../shared/constants/labUnits';
import type {
  ApiUser, Position, Role, Section, Staff, StaffProfile, StaffUnits,
} from '../../../shared/types/api';

/**
 * People & Access.
 *
 * Four questions, four tabs, and each one answered in exactly one place:
 *
 *   Logins      who can sign in
 *   Staff       who works here
 *   Positions   what they have been appointed to
 *   Access      what any of that is worth
 *
 * The screen used to ask the first two twice. "Register New Staff" and
 * "Users & Access" each created a person, each collected a different half of
 * their details, and each had its own idea of what a "role" was — so the same
 * person could arrive with two records and two job titles. They are one tab
 * now, with the creation form and the register it feeds side by side as
 * subtabs, and a login creates the personnel record it belongs to.
 */

type PeopleTab = 'Logins' | 'Staff' | 'Positions & Organogram' | 'Access Control';

/**
 * What each tab needs before it is drawn.
 *
 * A tab somebody cannot use is a tab they should not be offered: the API
 * refuses the work either way, and a dead end is worse than an absence.
 * Access Control takes `edit` rather than `view` because reading who can do
 * what is itself a decision about the laboratory's access.
 */
type PermissionAction = (typeof PERMISSION_ACTIONS)[number];
const PEOPLE_TAB_RIGHTS: Array<{ tab: PeopleTab; key: string; action: PermissionAction }> = [
  { tab: 'Logins', key: 'settings', action: 'view' },
  { tab: 'Staff', key: 'personnel.register', action: 'view' },
  { tab: 'Positions & Organogram', key: 'settings', action: 'view' },
  { tab: 'Access Control', key: 'settings', action: 'edit' },
];

export default function PeopleAccess({ positionsView }: { positionsView: React.ReactNode }) {
  const { can } = usePermissions();
  const tabs = useMemo(
    () => PEOPLE_TAB_RIGHTS.filter(t => can(t.key, t.action)).map(t => t.tab),
    [can],
  );
  const [tab, setTab] = useState<PeopleTab>('Logins');
  // Whatever they may actually open, rather than whatever was open last.
  const active = tabs.includes(tab) ? tab : tabs[0];

  if (tabs.length === 0) {
    return <div className="card"><p className="hint">You do not have permission to administer people or access.</p></div>;
  }

  return (
    <div className="people-access">
      <div className="tabs" role="tablist" aria-label="People and access">
        {tabs.map(t => (
          <button key={t} role="tab" aria-selected={active === t} className={active === t ? 'active' : ''} onClick={() => setTab(t)}>{t}</button>
        ))}
      </div>
      {active === 'Logins' && <LoginsTab />}
      {active === 'Staff' && <StaffTab />}
      {active === 'Positions & Organogram' && positionsView}
      {active === 'Access Control' && <AccessControl />}
    </div>
  );
}

/** Keeps a tab union from widening to `string` when it is inferred. */
type NoWiden<T> = T;

/** The pill row used for every second-level tab on this screen. */
function SubTabs<T extends string>({ tabs, value, onChange }: { tabs: readonly T[]; value: NoWiden<T>; onChange: (t: T) => void }) {
  return (
    <div className="org-subtabs" role="tablist">
      {tabs.map(t => (
        <button key={t} type="button" role="tab" aria-selected={value === t} className={value === t ? 'active' : ''} onClick={() => onChange(t)}>{t}</button>
      ))}
    </div>
  );
}

/* ==========================================================================
   Logins
   ========================================================================== */

const LOGIN_TABS = ['Create login', 'Login register'] as const;
type LoginTab = (typeof LOGIN_TABS)[number];

function LoginsTab() {
  const [tab, setTab] = useState<LoginTab>('Create login');
  const [reloadKey, setReloadKey] = useState(0);
  return (
    <>
      <SubTabs<LoginTab> tabs={LOGIN_TABS} value={tab} onChange={setTab} />
      {tab === 'Create login' && <CreateLogin onCreated={() => { setReloadKey(k => k + 1); setTab('Login register'); }} />}
      {tab === 'Login register' && <LoginRegister key={reloadKey} />}
    </>
  );
}

const emptyLogin = {
  fullName: '', username: '', password: '', primaryRoleId: '', sectionId: '',
  employeeNo: '', email: '', phone: '', staffId: '',
};

/**
 * Create a login — and the person it belongs to.
 *
 * Everything the personnel register needs is collected once, here, so the
 * staff record is complete from the first day and nobody types a name twice.
 * An existing record can be named instead, for somebody already on the
 * register who is only now being given a password.
 */
function CreateLogin({ onCreated }: { onCreated: () => void }) {
  const { can } = usePermissions();
  const [form, setForm] = useState(emptyLogin);
  const [roles, setRoles] = useState<Role[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [unlinked, setUnlinked] = useState<Staff[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<Role[]>('/roles?kind=primary').then(setRoles).catch(() => setRoles([]));
    api<Section[]>('/sections').then(setSections).catch(() => setSections([]));
    api<Staff[]>('/staff').then(all => setUnlinked(all.filter(s => !s.userId))).catch(() => setUnlinked([]));
  }, []);

  const role = roles.find(r => String(r.id) === form.primaryRoleId);
  const existing = unlinked.find(s => String(s.id) === form.staffId);
  const needsUnit = !existing && requiresClinicalUnit(role?.name);
  const set = (k: keyof typeof emptyLogin) => (v: string) => setForm(f => ({ ...f, [k]: v }));

  // An administrative unit is an additional posting, never somebody's
  // clinical unit, so it is not offered here.
  const clinicalUnits = sections.filter(s => (s as Section & { unitKind?: string }).unitKind !== 'administrative');

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null); setSuccess(null); setBusy(true);
    try {
      await api('/users', {
        method: 'POST',
        body: JSON.stringify({
          username: form.username.trim(),
          password: form.password,
          fullName: form.fullName.trim(),
          roleId: Number(form.primaryRoleId),
          staffId: form.staffId ? Number(form.staffId) : null,
          sectionId: form.sectionId ? Number(form.sectionId) : null,
          employeeNo: form.employeeNo.trim() || null,
          email: form.email.trim() || null,
          phone: form.phone.trim() || null,
        }),
      });
      setSuccess(`Login created for ${form.fullName.trim()}.`);
      setForm(emptyLogin);
      onCreated();
    } catch (err) { setError(errorText(err)); }
    finally { setBusy(false); }
  }

  if (!can('settings', 'create')) {
    return <div className="card"><p className="hint">You do not have permission to create logins.</p></div>;
  }

  return (
    <div className="card">
      <h3>Create login</h3>
      {error && <Notice kind="error">{error}</Notice>}
      {success && <Notice kind="success">{success}</Notice>}

      <form className="form" onSubmit={submit}>
        <fieldset className="reg-section">
          <legend>Account</legend>
          <div className="form-grid">
            <label>Full name<TextField value={form.fullName} onValue={set('fullName')} required /></label>
            <label>Username<TextField value={form.username} onValue={set('username')} required autoComplete="off" /></label>
            <label>Password<TextField type="password" minLength={8} value={form.password} onValue={set('password')} required autoComplete="new-password" placeholder="Minimum 8 characters" /></label>
            <label>Primary role
              <select value={form.primaryRoleId} onChange={e => setForm(f => ({ ...f, primaryRoleId: e.target.value }))} required>
                <option value="">Select…</option>
                {roles.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </label>
          </div>
        </fieldset>

        <fieldset className="reg-section">
          <legend>Personnel record</legend>
          <label>Existing staff record
            <select value={form.staffId} onChange={e => setForm(f => ({ ...f, staffId: e.target.value }))}>
              <option value="">Create a new record from the details below</option>
              {unlinked.map(s => <option key={s.id} value={s.id}>{s.fullName}{s.employeeNo ? ` · ${s.employeeNo}` : ''}</option>)}
            </select>
          </label>
          {!existing && (
            <div className="form-grid">
              <label>Employee number<TextField value={form.employeeNo} onValue={set('employeeNo')} /></label>
              <label>Email<TextField type="email" value={form.email} onValue={set('email')} /></label>
              <label>Phone<TextField value={form.phone} onValue={set('phone')} /></label>
              <label>Clinical unit
                <select value={form.sectionId} onChange={e => setForm(f => ({ ...f, sectionId: e.target.value }))} required={needsUnit}>
                  <option value="">{needsUnit ? 'Select…' : 'Not assigned'}</option>
                  {clinicalUnits.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </label>
            </div>
          )}
          {existing && <p className="hint">{existing.fullName} is already on the register. Their primary role will be set to the one chosen above.</p>}
        </fieldset>

        <button type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create login'}</button>
      </form>
    </div>
  );
}

/** Every login, the person behind it, and what each one may reach. */
function LoginRegister() {
  const { can } = usePermissions();
  const [users, setUsers] = useState<(ApiUser & { staffName?: string })[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [query, setQuery] = useState('');
  const [manage, setManage] = useState<ApiUser | null>(null);
  const [link, setLink] = useState<ApiUser | null>(null);
  const [linkSel, setLinkSel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const load = () => {
    api<(ApiUser & { staffName?: string })[]>('/users').then(setUsers).catch(e => setError(errorText(e)));
    api<Staff[]>('/staff').then(setStaff).catch(() => setStaff([]));
  };
  useEffect(() => { load(); }, []);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return users;
    return users.filter(u => [u.username, u.fullName, u.roleName, u.staffName]
      .some(v => String(v ?? '').toLowerCase().includes(q)));
  }, [users, query]);

  async function saveLink(userId: number, staffId: number | null) {
    setError(null); setSuccess(null);
    try {
      await api(`/users/${userId}`, { method: 'PUT', body: JSON.stringify({ staffId }) });
      setSuccess(staffId ? 'Login linked to the staff record.' : 'Login unlinked.');
      setLink(null); setLinkSel(''); load();
    } catch (err) { setError(errorText(err)); }
  }

  return (
    <>
      <PasswordResetApprovals />
      <div className="card">
        <div className="panel-head">
          <h3>Login register</h3>
          <TextField value={query} onValue={setQuery} placeholder="Search logins…" aria-label="Search logins" />
        </div>
        {error && <Notice kind="error">{error}</Notice>}
        {success && <Notice kind="success">{success}</Notice>}

        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr><th>Username</th><th>Full name</th><th>Primary role</th><th>Staff record</th><th>Status</th><th /></tr>
            </thead>
            <tbody>
              {shown.map(u => (
                <tr key={u.id}>
                  <td>{u.username}</td>
                  <td>{u.fullName}</td>
                  <td>{u.roleName}</td>
                  <td>{u.staffName || <span className="muted">Not linked</span>}</td>
                  <td>{u.isActive ? <span className="badge active">Active</span> : <span className="badge inactive">Deactivated</span>}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {can('settings', 'edit') && (
                      <button type="button" className="tiny" onClick={() => { setLink(u); setLinkSel(u.staffId ? String(u.staffId) : ''); }}>
                        {u.staffId ? 'Change link' : 'Link staff'}
                      </button>
                    )}{' '}
                    <button type="button" className="tiny" onClick={() => setManage(u)}>Manage</button>
                  </td>
                </tr>
              ))}
              {shown.length === 0 && <tr><td colSpan={6} className="hint">{query ? 'No logins match that search.' : 'No logins yet.'}</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <DetailModal open={!!link} onClose={() => setLink(null)} title={link ? `Link ${link.username}` : ''} width="narrow">
        {link && (
          <div className="form">
            <label>Staff record
              <select value={linkSel} onChange={e => setLinkSel(e.target.value)}>
                <option value="">Not linked</option>
                {staff.filter(s => !s.userId || s.userId === link.id).map(s => (
                  <option key={s.id} value={s.id}>{s.fullName}{s.employeeNo ? ` · ${s.employeeNo}` : ''}</option>
                ))}
              </select>
            </label>
            <div className="row-actions">
              <button type="button" onClick={() => saveLink(link.id, linkSel ? Number(linkSel) : null)}>Save</button>
              {link.staffId && <button type="button" className="secondary" onClick={() => saveLink(link.id, null)}>Unlink</button>}
            </div>
          </div>
        )}
      </DetailModal>

      <DetailModal open={!!manage} onClose={() => setManage(null)} title={manage ? `${manage.username} — account` : ''}>
        {manage && <UserAccountActions user={manage} onChanged={m => { if (m) setSuccess(m); load(); setManage(null); }} />}
      </DetailModal>
    </>
  );
}

/* ==========================================================================
   Staff
   ========================================================================== */

const STAFF_TABS = ['Register staff', 'Staff directory', 'Personnel register'] as const;
type StaffSubTab = (typeof STAFF_TABS)[number];

function StaffTab() {
  const [tab, setTab] = useState<StaffSubTab>('Register staff');
  const [reloadKey, setReloadKey] = useState(0);
  return (
    <>
      <SubTabs<StaffSubTab> tabs={STAFF_TABS} value={tab} onChange={setTab} />
      {tab === 'Register staff' && <RegisterStaffForm onRegistered={() => { setReloadKey(k => k + 1); setTab('Staff directory'); }} />}
      {tab === 'Staff directory' && <StaffDirectory key={reloadKey} />}
      {tab === 'Personnel register' && <PersonnelRegisterAdmin />}
    </>
  );
}

const emptyStaff = {
  firstName: '', surname: '', otherNames: '', employeeNo: '', email: '', phone: '',
  primaryRoleId: '', sectionId: '',
  createUser: false, username: '', password: '',
};

function RegisterStaffForm({ onRegistered }: { onRegistered: () => void }) {
  const { can } = usePermissions();
  const [form, setForm] = useState(emptyStaff);
  const [roles, setRoles] = useState<Role[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [positions, setPositions] = useState<Position[]>([]);
  const [positionIds, setPositionIds] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<Role[]>('/roles?kind=primary').then(setRoles).catch(() => setRoles([]));
    api<Section[]>('/sections').then(setSections).catch(() => setSections([]));
    api<Position[]>('/positions').then(setPositions).catch(() => setPositions([]));
  }, []);

  const role = roles.find(r => String(r.id) === form.primaryRoleId);
  const needsUnit = requiresClinicalUnit(role?.name);
  const set = (k: keyof typeof emptyStaff) => (v: string) => setForm(f => ({ ...f, [k]: v }));
  const clinicalUnits = sections.filter(s => (s as Section & { unitKind?: string }).unitKind !== 'administrative');

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null); setSuccess(null); setBusy(true);
    try {
      const res = await api<{ staffId: number; userId: number | null }>('/staff/register', {
        method: 'POST',
        body: JSON.stringify({
          firstName: form.firstName, surname: form.surname, otherNames: form.otherNames || null,
          employeeNo: form.employeeNo || null, email: form.email || null, phone: form.phone || null,
          primaryRoleId: Number(form.primaryRoleId),
          sectionId: form.sectionId ? Number(form.sectionId) : null,
          positionIds,
          createUser: form.createUser,
          username: form.createUser ? form.username : undefined,
          password: form.createUser ? form.password : undefined,
        }),
      });
      setSuccess(`Registered${res.userId ? ' with a login account' : ''}.`);
      setForm(emptyStaff); setPositionIds([]);
      onRegistered();
    } catch (err) { setError(errorText(err)); }
    finally { setBusy(false); }
  }

  if (!can('personnel.register', 'create')) {
    return <div className="card"><p className="hint">You do not have permission to register staff.</p></div>;
  }

  return (
    <div className="card">
      <h3>Register staff</h3>
      {error && <Notice kind="error">{error}</Notice>}
      {success && <Notice kind="success">{success}</Notice>}

      <form className="form" onSubmit={submit}>
        <fieldset className="reg-section">
          <legend>Personal details</legend>
          <div className="form-grid">
            <label>First name<TextField value={form.firstName} onValue={set('firstName')} required /></label>
            <label>Surname<TextField value={form.surname} onValue={set('surname')} required /></label>
            <label>Other names<TextField value={form.otherNames} onValue={set('otherNames')} /></label>
            <label>Employee number<TextField value={form.employeeNo} onValue={set('employeeNo')} /></label>
            <label>Email<TextField type="email" value={form.email} onValue={set('email')} /></label>
            <label>Phone<TextField value={form.phone} onValue={set('phone')} /></label>
          </div>
        </fieldset>

        <fieldset className="reg-section">
          <legend>Classification</legend>
          <div className="form-grid">
            <label>Primary role
              <select value={form.primaryRoleId} onChange={e => setForm(f => ({ ...f, primaryRoleId: e.target.value }))} required>
                <option value="">Select…</option>
                {roles.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </label>
            <label>Clinical unit
              <select value={form.sectionId} onChange={e => setForm(f => ({ ...f, sectionId: e.target.value }))} required={needsUnit}>
                <option value="">{needsUnit ? 'Select…' : 'Not assigned'}</option>
                {clinicalUnits.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </label>
          </div>
        </fieldset>

        <fieldset className="reg-section">
          <legend>Positions held</legend>
          <div className="chip-select">
            {positions.filter(p => !!p.isActive).map(p => (
              <label key={p.id} className={`pick ${positionIds.includes(p.id) ? 'on' : ''}`}>
                <input
                  type="checkbox"
                  checked={positionIds.includes(p.id)}
                  onChange={() => setPositionIds(prev => prev.includes(p.id) ? prev.filter(x => x !== p.id) : [...prev, p.id])}
                />
                {p.title}
              </label>
            ))}
            {positions.length === 0 && <span className="hint">No positions have been created.</span>}
          </div>
        </fieldset>

        <fieldset className="reg-section">
          <legend>Login account</legend>
          <label className="toggle">
            <input type="checkbox" checked={form.createUser} onChange={e => setForm(f => ({ ...f, createUser: e.target.checked }))} />
            Create a login for this person
          </label>
          {form.createUser && (
            <div className="form-grid">
              <label>Username<TextField value={form.username} onValue={set('username')} required autoComplete="off" /></label>
              <label>Password<TextField type="password" minLength={8} value={form.password} onValue={set('password')} required autoComplete="new-password" placeholder="Minimum 8 characters" /></label>
            </div>
          )}
        </fieldset>

        <button type="submit" disabled={busy}>{busy ? 'Registering…' : 'Register staff member'}</button>
      </form>
    </div>
  );
}

/** The register, with every linkage one click away in a dialog. */
function StaffDirectory() {
  const [staff, setStaff] = useState<Staff[]>([]);
  const [gaps, setGaps] = useState<Array<{ id: number; fullName: string; primaryRole: string }>>([]);
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    api<Staff[]>('/staff').then(setStaff).catch(e => setError(errorText(e)));
    api<Array<{ id: number; fullName: string; primaryRole: string }>>('/staff/unit-gaps').then(setGaps).catch(() => setGaps([]));
  };
  useEffect(() => { load(); }, []);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return staff;
    return staff.filter(s => [s.fullName, s.employeeNo, s.primaryRole, s.sectionName, s.username]
      .some(v => String(v ?? '').toLowerCase().includes(q)));
  }, [staff, query]);

  return (
    <>
      <div className="card">
        <div className="panel-head">
          <h3>Staff directory</h3>
          <TextField value={query} onValue={setQuery} placeholder="Search staff…" aria-label="Search staff" />
        </div>
        {error && <Notice kind="error">{error}</Notice>}

        {gaps.length > 0 && (
          <Notice kind="warn">
            {gaps.length} {gaps.length === 1 ? 'person needs' : 'people need'} a clinical unit: {gaps.slice(0, 6).map(g => g.fullName).join(', ')}
            {gaps.length > 6 ? ` and ${gaps.length - 6} more` : ''}.
          </Notice>
        )}

        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr><th>Name</th><th>Employee no</th><th>Primary role</th><th>Clinical unit</th><th>Positions</th><th>Login</th><th /></tr>
            </thead>
            <tbody>
              {shown.map(s => (
                <tr key={s.id}>
                  <td>{s.fullName}</td>
                  <td>{s.employeeNo || '—'}</td>
                  <td>{s.primaryRole || <span className="badge inactive">Not set</span>}</td>
                  <td>{s.sectionName || <span className="muted">—</span>}</td>
                  <td>{s.primaryPosition || <span className="muted">—</span>}</td>
                  <td>{s.username ? s.username : <span className="muted">None</span>}</td>
                  <td style={{ whiteSpace: 'nowrap' }}><button type="button" className="tiny secondary" onClick={() => setOpenId(s.id)}>View linkages</button></td>
                </tr>
              ))}
              {shown.length === 0 && <tr><td colSpan={7} className="hint">{query ? 'No staff match that search.' : 'No staff registered yet.'}</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <StaffLinkageModal staffId={openId} onClose={() => setOpenId(null)} />
    </>
  );
}

/**
 * One person's linkages, in a dialog.
 *
 * This used to open underneath the directory, off the bottom of the screen,
 * so picking a row appeared to do nothing and people kept clicking. It opens
 * over the page now, like every other record in the system.
 */
function StaffLinkageModal({ staffId, onClose }: { staffId: number | null; onClose: () => void }) {
  const [profile, setProfile] = useState<StaffProfile | null>(null);
  const [units, setUnits] = useState<StaffUnits | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!staffId) { setProfile(null); setUnits(null); return; }
    setError(null);
    api<StaffProfile>(`/staff/${staffId}`).then(setProfile).catch(e => setError(errorText(e)));
    api<StaffUnits>(`/staff/${staffId}/units`).then(setUnits).catch(() => setUnits(null));
  }, [staffId]);

  const moduleLabel = (key: string) => MODULES.find(m => m.key === key)?.label ?? key;

  return (
    <DetailModal
      open={!!staffId}
      onClose={onClose}
      title={profile?.staff.full_name ?? 'Staff record'}
      subtitle={profile ? [profile.staff.employee_no, profile.staff.is_active ? 'In service' : 'Not in service'].filter(Boolean).join(' · ') : undefined}
    >
      {error && <Notice kind="error">{error}</Notice>}
      {!profile && !error && <p className="hint">Loading…</p>}

      {profile && (
        <div className="linkage-body">
          <section>
            <h4>Units</h4>
            <table className="data-table">
              <tbody>
                <tr><th>Clinical unit</th><td>{units?.clinical?.name ?? <span className="badge inactive">Not set</span>}</td></tr>
                {(units?.additional ?? []).map(u => (
                  <tr key={u.id}><th>{u.kind === 'administrative' ? 'Administrative unit' : 'Additional unit'}</th>
                    <td>{u.name} <span className="badge">{u.role}</span>{u.source === 'position' ? ' · from a post held' : ''}</td></tr>
                ))}
                {(units?.grants ?? []).map(g => (
                  <tr key={g.id}><th>May also work in</th>
                    <td>{g.sectionName} <span className="badge">{UNIT_GRANT_LEVEL_LABELS[g.level] ?? g.level}</span>{g.expiresAt ? ` · until ${g.expiresAt}` : ''}</td></tr>
                ))}
              </tbody>
            </table>
          </section>

          <section>
            <h4>Login account</h4>
            {profile.account
              ? <p>{profile.account.username} — <span className="badge">{profile.account.role_name}</span>{profile.account.is_active ? '' : ' (disabled)'}</p>
              : <p className="hint">No login account.</p>}
          </section>

          <section>
            <h4>Positions</h4>
            {profile.positions.length > 0
              ? <ul className="link-list">{profile.positions.map(p => (
                  <li key={p.id}><strong>{p.title}</strong> <span className="badge">{p.assignment_type}</span>
                    {p.reports_to_title ? ` → reports to ${p.reports_to_title}` : ''}{p.is_active ? '' : ' (ended)'}</li>
                ))}</ul>
              : <p className="hint">No positions held.</p>}
          </section>

          <section>
            <h4>Technical authorisations</h4>
            {profile.authorizations.length > 0
              ? <table className="data-table">
                  <thead><tr><th>Area</th><th>Unit</th><th>Level</th><th>Status</th><th>Expires</th></tr></thead>
                  <tbody>{profile.authorizations.map(a => (
                    <tr key={a.id}><td>{moduleLabel(a.module_key)}</td><td>{a.section_name || 'All units'}</td>
                      <td><span className="badge">{a.level}</span></td>
                      <td>{a.is_active ? <span className="badge active">Active</span> : <span className="badge inactive">Inactive</span>}</td>
                      <td>{a.expires_at || '—'}</td></tr>
                  ))}</tbody>
                </table>
              : <p className="hint">None recorded.</p>}
          </section>

          <section>
            <h4>Activity</h4>
            <div className="stat-row">
              {([
                ['Documents', profile.activity.documents],
                ['Declarations', profile.activity.declarations],
                ['Competency', profile.activity.competency],
                ['Training', profile.training?.summary?.total ?? profile.activity.training],
                ['Open actions', profile.activity.openActions],
              ] as Array<[string, number]>).map(([label, value]) => (
                <div key={label} className="stat-chip"><span>{label}</span><strong>{value}</strong></div>
              ))}
            </div>
          </section>

          <TrainingRecordPanel staffId={profile.staff.id} entries={profile.training?.entries} title="Training file" />

          <p className="hint"><Link to="/personnel">Open in Personnel Management</Link></p>
        </div>
      )}
    </DetailModal>
  );
}
