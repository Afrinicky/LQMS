import { Fragment, FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, API_BASE, getToken } from '../services/api';
import { useAuth } from '../hooks/useAuth';
import { MODULES, PERMISSION_ACTIONS, TECHNICAL_AUTHORIZATION_LEVELS } from '../../shared/constants/modules';
import type {
  OrgTree, OrgTreeNode, ProfessionalRank,
  Position, Staff, SystemModule, ApiUser, Permission, Section, Device,
  Department, PermissionMatrixData, TechnicalAuthorizationRow, StaffProfile,
  SectionConfigRow, SectionConfigDetail,
  LaboratoryDocument, QualityPolicy, QualityObjective,
  EquipmentPattern, EquipmentSegment,
  SystemConnectivity, AppMode, SyncStatus, RemoteCloudUser,
} from '../../shared/types/api';

// Maps an organogram position title to the lab role(s) whose default permissions
// it should inherit, so that selecting a position pre-fills the authorization grid
// even when the position title is not an exact role name.
const POSITION_ROLE_MAP: Record<string, string> = {
  'haematology unit head': 'Section Head',
  'biochemistry unit head': 'Section Head',
  'microbiology unit head': 'Section Head',
  'blood bank unit head': 'Blood Bank Unit Head',
  'customer service officer': 'Quality User',
  'stores officer': 'Quality User',
  'secretary': 'Quality User',
};
function effectiveRoleNames(title: string): string[] {
  const t = title.toLowerCase().trim();
  const names = new Set<string>([t]);
  if (POSITION_ROLE_MAP[t]) names.add(POSITION_ROLE_MAP[t].toLowerCase());
  if (/unit head|head of/.test(t)) names.add('section head');
  return [...names];
}

// ---------------------------------------------------------------------------
// Register New Staff
// ---------------------------------------------------------------------------
// Single onboarding workflow that wires a new person into every linked area:
// the staff/personnel record, Positions & Organogram, an optional login account
// (Users & Access), and optional starting Technical Authorizations (Permission
// Matrix → Section Scope). Everything is created in one transaction server-side.

export function RegisterStaff() {
  const [roles, setRoles] = useState<{ id: number; name: string }[]>([]);
  const [positions, setPositions] = useState<Position[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [matrix, setMatrix] = useState<PermissionMatrixData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [profile, setProfile] = useState<StaffProfile | null>(null);

  const blank = { firstName: '', surname: '', otherNames: '', employeeNo: '', email: '', phone: '', sectionId: '', primaryPositionId: '' };
  const [form, setForm] = useState(blank);
  const [positionIds, setPositionIds] = useState<number[]>([]);
  const [createUser, setCreateUser] = useState(false);
  const [account, setAccount] = useState({ username: '', password: '', roleId: '' });
  // Authorization grid: explicit allow/deny per permission for this staff member.
  // Seeded from the selected positions, then freely editable (add / remove).
  const [perm, setPerm] = useState<Record<number, boolean>>({});

  function loadLookups() {
    api<{ id: number; name: string }[]>('/roles').then(setRoles).catch(() => setRoles([]));
    api<Position[]>('/positions').then(setPositions).catch(() => setPositions([]));
    api<Section[]>('/sections').then(setSections).catch(() => setSections([]));
    api<Staff[]>('/staff').then(setStaff).catch(() => setStaff([]));
    api<PermissionMatrixData>('/permissions/matrix').then(setMatrix).catch(() => setMatrix(null));
  }
  useEffect(() => { loadLookups(); }, []);

  // Baseline = permissions inherited from the selected organogram positions. Positions
  // map to role defaults by matching title↔role-name (the lab's standard roles), and we
  // also include any explicit position-permission grants an admin has configured.
  const baseline = useMemo(() => {
    const set = new Set<number>();
    if (!matrix) return set;
    for (const pp of matrix.positionPermissions) {
      if (pp.allowed === 1 && positionIds.includes(pp.position_id)) set.add(pp.permission_id);
    }
    const wantedRoleNames = new Set<string>();
    for (const p of positions.filter(p => positionIds.includes(p.id))) {
      for (const rn of effectiveRoleNames(p.title)) wantedRoleNames.add(rn);
    }
    const roleIds = new Set(roles.filter(r => wantedRoleNames.has(r.name.toLowerCase())).map(r => r.id));
    for (const rp of matrix.rolePermissions) {
      if (rp.allowed === 1 && roleIds.has(rp.role_id)) set.add(rp.permission_id);
    }
    return set;
  }, [matrix, positionIds, positions, roles]);

  // Whenever the selected positions change, reset the grid to the inherited baseline.
  useEffect(() => {
    const next: Record<number, boolean> = {};
    baseline.forEach(id => { next[id] = true; });
    setPerm(next);
  }, [baseline]);

  const permById = useMemo(() => {
    const m = new Map<string, Permission>();
    matrix?.permissions.forEach(p => m.set(`${p.module_key}:${p.action}`, p));
    return m;
  }, [matrix]);
  const matrixModules = useMemo(() => {
    if (!matrix) return [] as { key: string; label: string }[];
    const present = new Set(matrix.permissions.map(p => p.module_key));
    return MODULES.filter(m => present.has(m.key)).map(m => ({ key: m.key, label: m.label }));
  }, [matrix]);

  function togglePosition(id: number) {
    setPositionIds(prev => {
      const next = prev.includes(id) ? prev.filter(p => p !== id) : [...prev, id];
      setForm(f => ({ ...f, primaryPositionId: next.includes(Number(f.primaryPositionId)) ? f.primaryPositionId : (next[0] ? String(next[0]) : '') }));
      return next;
    });
  }
  function togglePerm(permId: number) { setPerm(prev => ({ ...prev, [permId]: !prev[permId] })); }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null); setSuccess(null);
    try {
      // Send only the deltas vs. the position baseline as explicit overrides.
      const permissions: { permissionId: number; allowed: boolean }[] = [];
      const ids = new Set<number>([...baseline, ...Object.keys(perm).map(Number)]);
      ids.forEach(id => { const on = !!perm[id]; if (on !== baseline.has(id)) permissions.push({ permissionId: id, allowed: on }); });
      const payload = {
        firstName: form.firstName,
        surname: form.surname,
        otherNames: form.otherNames || null,
        employeeNo: form.employeeNo || null,
        email: form.email || null,
        phone: form.phone || null,
        sectionId: form.sectionId || null,
        positionIds,
        primaryPositionId: form.primaryPositionId || null,
        createUser,
        username: createUser ? account.username : undefined,
        password: createUser ? account.password : undefined,
        roleId: createUser ? account.roleId : undefined,
        permissions: createUser ? permissions : [],
      };
      const res = await api<{ staffId: number; userId: number | null }>('/staff/register', { method: 'POST', body: JSON.stringify(payload) });
      setSuccess(`Staff record created (#${res.staffId})${res.userId ? ` with linked login account (user #${res.userId})` : ''}. Positions, permissions and personnel records are now linked.`);
      setForm(blank); setPositionIds([]); setCreateUser(false); setAccount({ username: '', password: '', roleId: '' }); setPerm({});
      loadLookups();
    } catch (err) { setError((err as Error).message); }
  }

  async function openProfile(id: number) {
    setError(null);
    try { setProfile(await api<StaffProfile>(`/staff/${id}`)); }
    catch (err) { setError((err as Error).message); }
  }

  const moduleLabel = (key: string) => MODULES.find(m => m.key === key)?.label ?? key;

  return <div className="reg-staff">
    <div className="card">
      <h3>Register New Staff</h3>
      <p>Onboard a staff member in one step. This record feeds <strong>Personnel Management</strong>, and the choices below link the person to <strong>Positions &amp; Organogram</strong>, <strong>Users &amp; Access</strong> (optional login), and the <strong>Permission Matrix</strong> (technical authorizations &amp; section scope).</p>
      {error && <div className="error">{error}</div>}
      {success && <div className="notice-ok">{success}</div>}

      <form className="form" onSubmit={submit}>
        <fieldset className="reg-section">
          <legend>Personal &amp; role details</legend>
          <div className="form-grid">
            <label>First name<input value={form.firstName} onChange={e => setForm({ ...form, firstName: e.target.value })} required /></label>
            <label>Surname<input value={form.surname} onChange={e => setForm({ ...form, surname: e.target.value })} required /></label>
            <label>Other names<input value={form.otherNames} onChange={e => setForm({ ...form, otherNames: e.target.value })} placeholder="Optional" /></label>
            <label>Employee no<input value={form.employeeNo} onChange={e => setForm({ ...form, employeeNo: e.target.value })} placeholder="Optional" /></label>
            <label>Email<input type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} placeholder="Used for self-link to login" /></label>
            <label>Phone<input value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} /></label>
            <label>Section / Unit<select value={form.sectionId} onChange={e => setForm({ ...form, sectionId: e.target.value })}><option value="">Unassigned</option>{sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
          </div>
        </fieldset>

        <fieldset className="reg-section">
          <legend>Positions &amp; organogram</legend>
          <p className="hint">Select one or more organogram positions. The primary position drives reporting lines and position-based permissions.</p>
          <div className="chip-select">
            {positions.filter(p => p.isActive !== false).map(p => (
              <label key={p.id} className={`pick ${positionIds.includes(p.id) ? 'on' : ''}`}>
                <input type="checkbox" checked={positionIds.includes(p.id)} onChange={() => togglePosition(p.id)} />{p.title}
              </label>
            ))}
            {positions.length === 0 && <span className="hint">No positions yet — create them under Positions &amp; Organogram.</span>}
          </div>
          {positionIds.length > 1 && <label className="primary-pick">Primary position<select value={form.primaryPositionId} onChange={e => setForm({ ...form, primaryPositionId: e.target.value })}>{positionIds.map(id => <option key={id} value={id}>{positions.find(p => p.id === id)?.title ?? `#${id}`}</option>)}</select></label>}
        </fieldset>

        <fieldset className="reg-section">
          <legend>Login account (Users &amp; Access)</legend>
          <label className="toggle"><input type="checkbox" checked={createUser} onChange={e => setCreateUser(e.target.checked)} /> Create a system login account linked to this staff member</label>
          {createUser && <div className="form-grid">
            <label>Username<input value={account.username} onChange={e => setAccount({ ...account, username: e.target.value })} required={createUser} /></label>
            <label>Password<input type="password" minLength={8} value={account.password} onChange={e => setAccount({ ...account, password: e.target.value })} required={createUser} placeholder="Min 8 characters" /></label>
            <label>Role<select value={account.roleId} onChange={e => setAccount({ ...account, roleId: e.target.value })} required={createUser}><option value="">Select role…</option>{roles.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
          </div>}
        </fieldset>

        <fieldset className="reg-section">
          <legend>Permissions &amp; authorizations</legend>
          <p className="hint">
            The grid below is pre-set from the organogram position(s) selected above — change the positions and it updates automatically.
            Click any action chip to grant or revoke it for this staff member. These apply to the login account
            {createUser ? '' : ' (enable “Create a system login account” above to save them)'}. Role defaults still apply on top of these.
          </p>
          <div className="matrix-legend">
            {PERMISSION_ACTIONS.map(a => <span key={a} className="leg"><span className="auth-chip on">{ACTION_META[a]?.short ?? a[0].toUpperCase()}</span>{ACTION_META[a]?.title ?? a}</span>)}
          </div>
          <div className="auth-matrix-wrap">
            <table className="auth-matrix">
              <thead><tr><th className="corner">Module</th>{PERMISSION_ACTIONS.map(a => <th key={a} className="act-col">{ACTION_META[a]?.short ?? a[0].toUpperCase()}</th>)}</tr></thead>
              <tbody>
                {matrixModules.map(m => <tr key={m.key}>
                  <th className="row-head">{m.label}</th>
                  {PERMISSION_ACTIONS.map(action => {
                    const p = permById.get(`${m.key}:${action}`);
                    if (!p) return <td key={action} className="auth-cell" />;
                    const on = !!perm[p.id];
                    const inherited = baseline.has(p.id);
                    return <td key={action} className="auth-cell">
                      <button type="button" title={`${ACTION_META[action]?.title ?? action}${inherited ? ' — from position' : ''} — click to ${on ? 'revoke' : 'grant'}`} className={`auth-chip ${on ? 'on' : 'off'} ${inherited ? 'inherited' : ''}`} onClick={() => togglePerm(p.id)}>{ACTION_META[action]?.short ?? action[0].toUpperCase()}</button>
                    </td>;
                  })}
                </tr>)}
                {matrixModules.length === 0 && <tr><td className="hint" colSpan={PERMISSION_ACTIONS.length + 1}>Loading permissions…</td></tr>}
              </tbody>
            </table>
          </div>
        </fieldset>

        <button type="submit">Register staff member</button>
      </form>
    </div>

    <div className="card">
      <h3>Staff directory &amp; linkages</h3>
      <p>Every registered staff member and how they are connected across the system.</p>
      <table className="data-table"><thead><tr><th>Name</th><th>Employee no</th><th>Section</th><th>Primary position</th><th>Login account</th><th>Status</th><th></th></tr></thead><tbody>
        {staff.map(s => <tr key={s.id}>
          <td>{s.fullName}</td>
          <td>{s.employeeNo || '—'}</td>
          <td>{s.sectionName || '—'}</td>
          <td>{s.primaryPosition || '—'}</td>
          <td>{s.username ? <>{s.username} <span className="badge">{s.roleName}</span></> : <span className="hint">No account</span>}</td>
          <td>{s.isActive ? <span className="badge active">active</span> : <span className="badge inactive">inactive</span>}</td>
          <td><button onClick={() => openProfile(s.id)}>View linkages</button></td>
        </tr>)}
        {staff.length === 0 && <tr><td colSpan={7} className="hint">No staff registered yet.</td></tr>}
      </tbody></table>
    </div>

    {profile && <div className="card profile-panel">
      <div className="panel-head">
        <h3>{profile.staff.full_name}</h3>
        <button className="secondary" onClick={() => setProfile(null)}>Close</button>
      </div>
      <p>Employee no: {profile.staff.employee_no || '—'} · Section: {profile.staff.section_name || '—'} · {profile.staff.is_active ? 'Active' : 'Inactive'}</p>

      <h4>Login account (Users &amp; Access)</h4>
      {profile.account
        ? <p>{profile.account.username} — role <span className="badge">{profile.account.role_name}</span> {profile.account.is_active ? '' : '(disabled)'} · <Link to="/settings/people">Manage in Users &amp; Access</Link></p>
        : <p className="hint">No login account linked. <Link to="/settings/people">Create one in Users &amp; Access</Link>.</p>}

      <h4>Positions &amp; organogram</h4>
      {profile.positions.length > 0
        ? <ul className="link-list">{profile.positions.map(p => <li key={p.id}><strong>{p.title}</strong> <span className="badge">{p.assignment_type}</span>{p.reports_to_title ? ` → reports to ${p.reports_to_title}` : ''}{p.is_active ? '' : ' (inactive)'}</li>)}</ul>
        : <p className="hint">No positions assigned. <Link to="/settings/people">Assign in Positions &amp; Organogram</Link>.</p>}

      <h4>Technical authorizations &amp; section scope (Permission Matrix)</h4>
      {profile.authorizations.length > 0
        ? <table className="data-table"><thead><tr><th>Module</th><th>Section</th><th>Level</th><th>Status</th><th>Expires</th></tr></thead><tbody>
            {profile.authorizations.map(a => <tr key={a.id}><td>{moduleLabel(a.module_key)}</td><td>{a.section_name || 'All sections'}</td><td><span className="badge">{a.level}</span></td><td>{a.is_active ? <span className="badge active">active</span> : <span className="badge inactive">inactive</span>}</td><td>{a.expires_at || '—'}</td></tr>)}
          </tbody></table>
        : <p className="hint">No technical authorizations. <Link to="/settings/people">Add in Permission Matrix → Section Scope</Link>.</p>}

      <h4>Personnel activity</h4>
      <div className="cards">
        <div className="card mini"><h4>Documents</h4><p className="metric">{profile.activity.documents}</p></div>
        <div className="card mini"><h4>Declarations</h4><p className="metric">{profile.activity.declarations}</p></div>
        <div className="card mini"><h4>Competency</h4><p className="metric">{profile.activity.competency}</p></div>
        <div className="card mini"><h4>Training</h4><p className="metric">{profile.activity.training}</p></div>
        <div className="card mini"><h4>Open actions</h4><p className="metric">{profile.activity.openActions}</p></div>
      </div>
      <p className="hint"><Link to="/personnel">Open in Personnel Management</Link></p>
    </div>}
  </div>;
}

// ---------------------------------------------------------------------------
// Users & Access
// ---------------------------------------------------------------------------
export function UsersAccess(){
  const [users,setUsers]=useState<(ApiUser & {staffName?: string})[]>([]);
  const [roles,setRoles]=useState<{id:number;name:string}[]>([]);
  const [staff,setStaff]=useState<Staff[]>([]);
  const [error,setError]=useState<string|null>(null);
  const [success,setSuccess]=useState<string|null>(null);
  const [openUser,setOpenUser]=useState<number|null>(null);
  const [linkSel,setLinkSel]=useState<string>('');
  const load=()=>{api<(ApiUser & {staffName?: string})[]>('/users').then(setUsers); api<{id:number;name:string}[]>('/roles').then(setRoles); api<Staff[]>('/staff').then(setStaff).catch(()=>setStaff([]))};
  useEffect(()=>{void load()},[]);
  async function submit(e:FormEvent<HTMLFormElement>){
    e.preventDefault(); setError(null); setSuccess(null);
    const form=e.currentTarget;                       // capture before await (React nulls currentTarget after yielding)
    const fd=new FormData(form);
    const staffId=fd.get('staffId')?Number(fd.get('staffId')):null;
    try {
      await api('/users',{method:'POST',body:JSON.stringify({username:fd.get('username'),password:fd.get('password'),fullName:fd.get('fullName'),roleId:Number(fd.get('roleId')),staffId})});
      form.reset();
      setSuccess('User account created.');
      load();
    } catch (err) { setError((err as Error).message); }
  }
  async function linkStaff(userId:number, staffId:number|null){
    setError(null); setSuccess(null);
    try {
      await api(`/users/${userId}`,{method:'PUT',body:JSON.stringify({staffId})});
      setSuccess(staffId?'Account linked to staff record.':'Account unlinked from staff.');
      setOpenUser(null); setLinkSel(''); load();
    } catch (err) { setError((err as Error).message); }
  }
  const unlinkedStaff = staff.filter(s => !s.userId);
  return <div className="card"><h3>Users &amp; Access</h3>
    <p>Create login accounts and link them to staff records. To onboard a whole new person (staff + account + positions) use <Link to="/settings/people">Register New Staff</Link>. Click any user below to link or change its staff record.</p>
    {error && <div className="error">{error}</div>}
    {success && <div className="notice-ok">{success}</div>}
    <form className="form" onSubmit={submit}>
      <label>Full name<input name="fullName" required/></label>
      <label>Username<input name="username" required/></label>
      <label>Password<input name="password" type="password" minLength={8} required/></label>
      <label>Role<select name="roleId" required><option value="">Select role…</option>{roles.map(r=><option value={r.id} key={r.id}>{r.name}</option>)}</select></label>
      <label>Link to Staff Record (Optional)<select name="staffId"><option value="">Not linked</option>{unlinkedStaff.map(s=><option value={s.id} key={s.id}>{s.fullName}{s.employeeNo?` (${s.employeeNo})`:''}</option>)}</select></label>
      <button>Create user</button>
    </form>
    <table className="table"><thead><tr><th>Username</th><th>Full Name</th><th>Role</th><th>Linked Staff</th><th>Active</th><th></th></tr></thead><tbody>
      {users.map(u=>{
        const linkable = staff.filter(s => !s.userId || s.userId === u.id);
        const open = openUser===u.id;
        return <Fragment key={u.id}>
          <tr className="row-click" onClick={()=>{ setOpenUser(open?null:u.id); setLinkSel(u.staffId?String(u.staffId):''); setError(null); setSuccess(null); }}>
            <td>{u.username}</td><td>{u.fullName}</td><td>{u.roleName}</td>
            <td>{u.staffName || <span className="muted">Not linked</span>}</td>
            <td>{u.isActive?'Yes':'No'}</td>
            <td><button type="button" className="tiny" onClick={e=>{ e.stopPropagation(); setOpenUser(open?null:u.id); setLinkSel(u.staffId?String(u.staffId):''); setError(null); setSuccess(null); }}>{open?'Close':(u.staffId?'Change link':'Link staff')}</button></td>
          </tr>
          {open && <tr className="link-editor-row"><td colSpan={6}>
            <div className="user-link-editor">
              <span className="lab">Link <strong>{u.username}</strong> to staff record</span>
              <select value={linkSel} onChange={e=>setLinkSel(e.target.value)}>
                <option value="">— none —</option>
                {linkable.map(s=><option key={s.id} value={s.id}>{s.fullName}{s.employeeNo?` (${s.employeeNo})`:''}</option>)}
              </select>
              <button type="button" onClick={()=>linkStaff(u.id, linkSel?Number(linkSel):null)}>Save link</button>
              {u.staffId && <button type="button" className="secondary" onClick={()=>linkStaff(u.id,null)}>Unlink</button>}
              {staff.length===0 && <span className="hint">No staff records yet — register staff first.</span>}
            </div>
          </td></tr>}
        </Fragment>;
      })}
    </tbody></table>
  </div>;
}

// ---------------------------------------------------------------------------
// Positions & Organogram
// ---------------------------------------------------------------------------
type OrgNodeData = { id: number; title: string; description?: string | null; reportsToPositionId: number | null; isActive: number; occupants: { staffId: number; staffName: string; assignmentType: string }[] };

export function Positions(){
  const [view,setView]=useState<'list'|'organogram'>('list');
  const [positions,setPositions]=useState<Position[]>([]);
  const [staff,setStaff]=useState<Staff[]>([]);
  const [sections,setSections]=useState<Section[]>([]);
  const [error,setError]=useState<string|null>(null);
  const [editing,setEditing]=useState<Position | null>(null);
  const [editForm,setEditForm]=useState({ title:'', reportsToPositionId:'', isActive:true });
  const load=()=>{api<Position[]>('/positions').then(setPositions); api<Staff[]>('/staff').then(setStaff).catch(()=>setStaff([])); api<Section[]>('/sections').then(setSections).catch(()=>setSections([]))};
  useEffect(()=>{void load()},[]);

  async function addPosition(e:FormEvent<HTMLFormElement>){
    e.preventDefault(); setError(null);
    const fd=new FormData(e.currentTarget);
    try {
      await api('/positions',{method:'POST',body:JSON.stringify({title:fd.get('title'),description:fd.get('description'),reportsToPositionId:fd.get('reportsToPositionId')||null})});
      e.currentTarget.reset(); load();
    } catch (err) { setError((err as Error).message); }
  }
  async function addStaff(e:FormEvent<HTMLFormElement>){
    e.preventDefault(); setError(null);
    const fd=new FormData(e.currentTarget);
    try {
      await api('/staff',{method:'POST',body:JSON.stringify({employeeNo:fd.get('employeeNo'),fullName:fd.get('fullName'),email:fd.get('email'),phone:fd.get('phone'),sectionId:fd.get('sectionId')||null,positionId:Number(fd.get('positionId'))})});
      e.currentTarget.reset(); load();
    } catch (err) { setError((err as Error).message); }
  }
  function startEdit(p:Position){ setEditing(p); setEditForm({ title:p.title, reportsToPositionId:p.reportsToPositionId?String(p.reportsToPositionId):'', isActive:p.isActive!==false }); }
  async function saveEdit(e:FormEvent<HTMLFormElement>){
    e.preventDefault(); setError(null);
    if(!editing) return;
    try {
      await api(`/positions/${editing.id}`,{method:'PUT',body:JSON.stringify({ title:editForm.title, reportsToPositionId:editForm.reportsToPositionId||null, isActive:editForm.isActive })});
      setEditing(null); load();
    } catch (err) { setError((err as Error).message); }
  }
  async function toggleStatus(p:Position){
    setError(null);
    try { await api(`/positions/${p.id}`,{method:'PUT',body:JSON.stringify({ isActive:p.isActive===false })}); load(); }
    catch (err) { setError((err as Error).message); }
  }
  async function removePosition(p:Position){
    setError(null);
    try { await api(`/positions/${p.id}`,{method:'DELETE'}); load(); }
    catch (err) { setError((err as Error).message); }
  }
  const byId = (id?: number | null) => positions.find(p => p.id === id)?.title;

  return <div>
    <div className="tabs"><button className={view==='list'?'active':''} onClick={()=>setView('list')}>Positions list</button><button className={view==='organogram'?'active':''} onClick={()=>setView('organogram')}>Organogram</button></div>
    {error && <div className="error">{error}</div>}

    {view==='list' && <div className="grid cols-2">
      <div className="card"><h3>Positions &amp; Organogram</h3><p>Create positions and assign reporting lines. Not every laboratory has every position — deactivate the ones you don't use. Staff are mapped here and during <Link to="/settings/people">Register New Staff</Link>.</p>
        <form className="form" onSubmit={addPosition}>
          <label>Position title<input name="title" required/></label>
          <label>Description<textarea name="description"/></label>
          <label>Reporting line<select name="reportsToPositionId"><option value="">None</option>{positions.map(p=><option value={p.id} key={p.id}>{p.title}</option>)}</select></label>
          <button>Create position</button>
        </form>
        <table className="data-table"><thead><tr><th>Title</th><th>Reports to</th><th>Status</th><th></th></tr></thead><tbody>
          {positions.map(p => editing?.id===p.id
            ? <tr key={p.id}><td colSpan={4}>
                <form className="form inline-edit" onSubmit={saveEdit}>
                  <label>Title<input value={editForm.title} onChange={e=>setEditForm({...editForm,title:e.target.value})} required/></label>
                  <label>Reports to<select value={editForm.reportsToPositionId} onChange={e=>setEditForm({...editForm,reportsToPositionId:e.target.value})}><option value="">None</option>{positions.filter(x=>x.id!==p.id).map(x=><option value={x.id} key={x.id}>{x.title}</option>)}</select></label>
                  <label className="toggle"><input type="checkbox" checked={editForm.isActive} onChange={e=>setEditForm({...editForm,isActive:e.target.checked})}/> Active</label>
                  <button type="submit">Save</button>
                  <button type="button" className="secondary" onClick={()=>setEditing(null)}>Cancel</button>
                </form>
              </td></tr>
            : <tr key={p.id}><td>{p.title}</td><td>{byId(p.reportsToPositionId) || '—'}</td><td>{p.isActive ? <span className="badge active">active</span> : <span className="badge inactive">inactive</span>}</td>
                <td><button onClick={()=>startEdit(p)}>Edit</button> <button className="secondary" onClick={()=>toggleStatus(p)}>{p.isActive?'Deactivate':'Activate'}</button> <button className="secondary" onClick={()=>removePosition(p)}>Remove</button></td>
              </tr>)}
        </tbody></table>
      </div>
      <div className="card"><h3>Quick staff assignment</h3>
        <form className="form" onSubmit={addStaff}>
          <label>Employee no<input name="employeeNo"/></label>
          <label>Staff full name<input name="fullName" required/></label>
          <label>Email<input name="email"/></label>
          <label>Phone<input name="phone"/></label>
          <label>Section<select name="sectionId"><option value="">Unassigned</option>{sections.map(s=><option value={s.id} key={s.id}>{s.name}</option>)}</select></label>
          <label>Assign position<select name="positionId" required><option value="">Select…</option>{positions.filter(p=>p.isActive!==false).map(p=><option value={p.id} key={p.id}>{p.title}</option>)}</select></label>
          <button>Create staff</button>
        </form>
        <table className="data-table"><thead><tr><th>Name</th><th>Position</th><th>Section</th></tr></thead><tbody>
          {staff.map(s => <tr key={s.id}><td>{s.fullName}</td><td>{s.primaryPosition || '—'}</td><td>{s.sectionName || '—'}</td></tr>)}
        </tbody></table>
      </div>
    </div>}

    {view==='organogram' && <><Organogram staff={staff} onChanged={load} /><RankConfig /></>}
  </div>;
}

// Classify a role for colour coding on the organogram.
function roleType(title: string): 'management' | 'quality' | 'technical' | 'support' {
  const t = title.toLowerCase();
  if (/quality/.test(t)) return 'quality';
  if (/^laboratory manager|laboratory director|^lab manager|^director|superintend/.test(t)) return 'management';
  if (/unit head|head of|scientist|technologist|technician|technical officer|biomedical|microbiolog|haematolog|chemistry|blood bank|laboratory assistant/.test(t)) return 'technical';
  return 'support';
}

type OrgCtx = {
  nodes: OrgNodeData[];
  staff: Staff[];
  selectedId: number | null;
  onSelect: (id: number | null) => void;
  childrenOf: (id: number | null) => OrgNodeData[];
  descendants: (id: number) => Set<number>;
  call: (path: string, options: RequestInit, okMsg?: string) => Promise<boolean>;
};

// Laboratory organogram — interactive reporting and
// deputisation chart. Editing happens in place on each node.
// Configurable professional rank order — drives the automatic within-cadre
// arrangement of technical staff on the organogram (lower number = higher rank).
function RankConfig() {
  const [ranks, setRanks] = useState<ProfessionalRank[]>([]);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const load = () => api<ProfessionalRank[]>('/professional-ranks').then(setRanks).catch(e => setError((e as Error).message));
  useEffect(() => { void load(); }, []);
  async function call(path: string, options: RequestInit) { setError(null); try { await api(path, options); await load(); return true; } catch (e) { setError((e as Error).message); return false; } }
  async function add(e: FormEvent) { e.preventDefault(); if (!name.trim()) return; if (await call('/professional-ranks', { method: 'POST', body: JSON.stringify({ name: name.trim() }) })) setName(''); }
  function move(r: ProfessionalRank, dir: -1 | 1) {
    const sorted = [...ranks].sort((a, b) => a.sortOrder - b.sortOrder);
    const i = sorted.findIndex(x => x.id === r.id); const j = i + dir;
    if (j < 0 || j >= sorted.length) return;
    // swap sort orders
    void call(`/professional-ranks/${r.id}`, { method: 'PUT', body: JSON.stringify({ sortOrder: sorted[j].sortOrder }) });
    void call(`/professional-ranks/${sorted[j].id}`, { method: 'PUT', body: JSON.stringify({ sortOrder: sorted[i].sortOrder }) });
  }
  return <div className="card" style={{ marginTop: 16 }}>
    <h3>Professional rank order</h3>
    <p className="hint">The automatic hierarchy under each Unit Head orders staff of the same cadre by these ranks (top = highest). Staff with no explicit rank are matched against their designation.</p>
    {error && <div className="error">{error}</div>}
    <table className="data-table" style={{ maxWidth: 520 }}><thead><tr><th>#</th><th>Rank</th><th>Active</th><th></th></tr></thead><tbody>
      {[...ranks].sort((a, b) => a.sortOrder - b.sortOrder).map((r, i, arr) => <tr key={r.id} style={{ opacity: r.isActive ? 1 : 0.5 }}>
        <td>{i + 1}</td><td>{r.name}</td>
        <td><input type="checkbox" checked={r.isActive === 1} onChange={e => call(`/professional-ranks/${r.id}`, { method: 'PUT', body: JSON.stringify({ isActive: e.target.checked }) })} /></td>
        <td style={{ whiteSpace: 'nowrap' }}>
          <button type="button" className="tiny" disabled={i === 0} onClick={() => move(r, -1)} title="Move up">↑</button>
          <button type="button" className="tiny" disabled={i === arr.length - 1} onClick={() => move(r, 1)} title="Move down">↓</button>
          <button type="button" className="tiny secondary" onClick={() => { if (window.confirm(`Remove rank "${r.name}"?`)) call(`/professional-ranks/${r.id}`, { method: 'DELETE' }); }}>×</button>
        </td>
      </tr>)}
      {ranks.length === 0 && <tr><td colSpan={4} className="hint">No ranks configured.</td></tr>}
    </tbody></table>
    <form className="org-add-root" style={{ marginTop: 10 }} onSubmit={add}>
      <input placeholder="Add a rank (e.g. Senior Medical Laboratory Scientist)…" value={name} onChange={e => setName(e.target.value)} />
      <button type="submit">Add rank</button>
    </form>
  </div>;
}

function Organogram({ staff, onChanged }: { staff: Staff[]; onChanged: () => void }) {
  const [nodes,setNodes]=useState<OrgNodeData[]>([]);   // flat positions (for editor + reporting-line options)
  const [tree,setTree]=useState<OrgTreeNode[]>([]);     // computed render tree
  const [selectedId,setSelectedId]=useState<number|null>(null);
  const [error,setError]=useState<string|null>(null);
  const [success,setSuccess]=useState<string|null>(null);
  const [newRoot,setNewRoot]=useState('');
  const [zoom,setZoom]=useState(1);
  const viewportRef=useRef<HTMLDivElement>(null);
  const chartRef=useRef<HTMLDivElement>(null);
  const load=()=>{
    api<OrgNodeData[]>('/organogram').then(setNodes).catch(e=>setError((e as Error).message));
    api<OrgTree>('/organogram/tree').then(t=>setTree(t.roots)).catch(e=>setError((e as Error).message));
  };
  useEffect(()=>{void load()},[]);

  function refresh(){ load(); onChanged(); }
  async function call(path:string, options:RequestInit, okMsg?:string){
    setError(null); setSuccess(null);
    try { await api(path,options); if(okMsg) setSuccess(okMsg); refresh(); return true; }
    catch(e){ setError((e as Error).message); return false; }
  }

  const childrenOf = (id:number|null) => nodes.filter(n => n.reportsToPositionId === id).sort((a,b)=>a.title.localeCompare(b.title));
  function descendants(id:number): Set<number> {
    const out = new Set<number>(); const stack=[id];
    while(stack.length){ const cur=stack.pop()!; for(const c of nodes.filter(n=>n.reportsToPositionId===cur)){ if(!out.has(c.id)){ out.add(c.id); stack.push(c.id); } } }
    return out;
  }
  const ctx: OrgCtx = { nodes, staff, selectedId, onSelect:setSelectedId, childrenOf, descendants, call };

  async function applyStandard(){ await call('/organogram/apply-standard',{method:'POST',body:JSON.stringify({})},'Standard laboratory structure applied.'); }
  async function addRoot(e:FormEvent){ e.preventDefault(); if(!newRoot.trim()) return; const ok=await call('/positions',{method:'POST',body:JSON.stringify({ title:newRoot.trim(), reportsToPositionId:null })},'Top-level role added.'); if(ok) setNewRoot(''); }
  function printChart(){ window.print(); }
  function fitToScreen(){
    const vp=viewportRef.current, ch=chartRef.current;
    if(!vp||!ch) return;
    const w=ch.scrollWidth/(zoom||1); const avail=vp.clientWidth-24;
    setZoom(w>0 ? Math.max(0.4, Math.min(1, avail/w)) : 1);
  }

  const printedAt = new Date().toLocaleString();

  return <div className="card organogram-card">
    <div className="panel-head no-print">
      <h3>Laboratory Organogram &amp; Deputisation</h3>
      <div className="org-toolbar">
        <div className="org-zoom">
          <button type="button" title="Zoom out" onClick={()=>setZoom(z=>Math.max(0.4, Math.round((z-0.1)*10)/10))}>−</button>
          <span className="org-zoom-val">{Math.round(zoom*100)}%</span>
          <button type="button" title="Zoom in" onClick={()=>setZoom(z=>Math.min(1.6, Math.round((z+0.1)*10)/10))}>+</button>
          <button type="button" title="Fit to screen" onClick={fitToScreen}>Fit</button>
          <button type="button" title="Reset" onClick={()=>setZoom(1)}>100%</button>
        </div>
        <button type="button" onClick={applyStandard}>Apply standard structure</button>
        <button type="button" onClick={printChart}>Print</button>
      </div>
    </div>
    <p className="hint no-print">The appointed roles below the Laboratory Manager are set by hand. Under each <strong>Unit Head</strong>, the unit’s technical staff are arranged automatically by cadre (Scientist → Technician → Assistant) then professional rank — the highest-ranked becomes the next-in-command, and succession flows downward. Click any appointed role to edit it; the automatic chain follows the staff register.</p>
    <div className="org-legend no-print">
      <span className="leg"><span className="org-swatch rt-management" />Management</span>
      <span className="leg"><span className="org-swatch rt-quality" />Quality</span>
      <span className="leg"><span className="org-swatch rt-technical" />Technical / unit</span>
      <span className="leg"><span className="org-swatch rt-support" />Support / admin</span>
      <span className="leg"><span className="org-swatch org-staff-swatch" />Auto staff (by cadre &amp; rank)</span>
    </div>
    <form className="org-add-root no-print" onSubmit={addRoot}>
      <input placeholder="Add a top-level role (e.g. Laboratory Manager)…" value={newRoot} onChange={e=>setNewRoot(e.target.value)} />
      <button type="submit">Add top role</button>
    </form>
    {error && <div className="error no-print">{error}</div>}
    {success && <div className="notice-ok no-print">{success}</div>}

    <div className="org-viewport" ref={viewportRef}>
      <div className="org-print-area" ref={chartRef} style={{ zoom } as unknown as React.CSSProperties}>
        <div className="org-print-head"><strong>SECH_LIMS — Laboratory Organisational Structure &amp; Deputisation</strong><span>Printed {printedAt}</span></div>
        {tree.length===0
          ? <p className="hint">No positions yet. Use “Add top role” or “Apply standard structure”.</p>
          : <div className="org-chart"><ul className="org-tree">{tree.map(r => <OrgTreeBranch key={r.key} node={r} ctx={ctx} />)}</ul></div>}
      </div>
    </div>
  </div>;
}

const avClass = (a?: string | null) => `av-${String(a || 'available').toLowerCase().replace(/[^a-z]+/g,'-')}`;

function OrgTreeBranch({ node, ctx }: { node: OrgTreeNode; ctx: OrgCtx }) {
  const kids = node.children;
  if (node.kind === 'staff') {
    const unavailable = node.availability && node.availability.toLowerCase() !== 'available';
    return <li>
      <div className={`org-node org-staff ${avClass(node.availability)}`} title={node.staffName}>
        <span className="org-title">{node.title}</span>
        <span className="org-holder">{node.staffName}</span>
        <span className="org-meta">{node.cadre}{node.rank ? ` · ${node.rank}` : ''}</span>
        <span className="org-deputy">
          {unavailable ? <span className="av-flag">{node.availability}</span> : null}
          {node.nextInCommand ? <span className="muted"> Next: {node.nextInCommand}</span> : null}
        </span>
      </div>
      {kids.length>0 && <ul>{kids.map(k=><OrgTreeBranch key={k.key} node={k} ctx={ctx} />)}</ul>}
    </li>;
  }
  // Position (appointed) node — editable in place.
  const flat = ctx.nodes.find(n => n.id === node.positionId);
  const selected = ctx.selectedId === node.positionId;
  return <li>
    {selected && flat
      ? <OrgNodeEditor node={flat} ctx={ctx} />
      : <button type="button" className={`org-node rt-${node.roleType} ${node.isActive ? '' : 'inactive'} ${node.unitHead ? 'is-head' : ''}`} onClick={()=>ctx.onSelect(node.positionId!)}>
          <span className="org-title">{node.title}</span>
          <span className={`org-holder ${node.vacant ? 'vacant' : ''}`}>{node.vacant ? 'Vacant — click to assign' : node.holderName}</span>
          {node.unitHead
            ? <span className="org-deputy">{node.deputyName ? <>Next-in-command: {node.deputyName}</> : <span className="muted">No deputy yet</span>}{node.actingName && node.actingName !== node.deputyName ? <span className="muted"> · Acting: {node.actingName}</span> : null}</span>
            : <span className="org-deputy">{node.deputyName ? <>Deputy: {node.deputyName}</> : <span className="muted">Deputy: —</span>}</span>}
        </button>}
    {kids.length>0 && <ul>{kids.map(k=><OrgTreeBranch key={k.key} node={k} ctx={ctx} />)}</ul>}
  </li>;
}

// In-place editor rendered as the node itself when selected.
function OrgNodeEditor({ node, ctx }: { node: OrgNodeData; ctx: OrgCtx }) {
  const [title,setTitle]=useState(node.title);
  const [child,setChild]=useState('');
  useEffect(()=>{ setTitle(node.title); },[node.id, node.title]);
  const holder = node.occupants.find(o => o.assignmentType === 'primary');
  const deputy = node.occupants.find(o => o.assignmentType === 'deputy');
  const secondaries = node.occupants.filter(o => o.assignmentType === 'secondary');
  const rt = roleType(node.title);
  const reportOptions = ctx.nodes.filter(n => n.id !== node.id && !ctx.descendants(node.id).has(n.id));

  function saveTitle(){ const t=title.trim(); if(t && t!==node.title) ctx.call(`/positions/${node.id}`,{method:'PUT',body:JSON.stringify({title:t})},'Title updated.'); }
  function assign(staffId:string, assignmentType:'primary'|'deputy'|'secondary'){ if(staffId) ctx.call(`/positions/${node.id}/occupant`,{method:'POST',body:JSON.stringify({staffId:Number(staffId),assignmentType})}, assignmentType==='deputy'?'Deputy assigned.':'Occupant assigned.'); }
  function removeOcc(staffId:number){ ctx.call(`/positions/${node.id}/occupant/${staffId}`,{method:'DELETE'},'Removed.'); }
  function addChildRole(e:FormEvent){ e.preventDefault(); const t=child.trim(); if(!t) return; ctx.call('/positions',{method:'POST',body:JSON.stringify({title:t, reportsToPositionId:node.id})},'Subordinate role added.').then(ok=>{ if(ok) setChild(''); }); }

  const freeStaff = ctx.staff.filter(s => s.isActive !== false);

  return <div className={`org-node org-node-edit rt-${rt}`}>
    <input className="org-title-input" value={title} onChange={e=>setTitle(e.target.value)} onBlur={saveTitle} onKeyDown={e=>{ if(e.key==='Enter'){ e.preventDefault(); (e.target as HTMLInputElement).blur(); } }} aria-label="Role title" />

    <div className="org-edit-row">
      <span className="lab">Holder</span>
      {holder ? <span className="who">{holder.staffName} <button type="button" className="x" title="Vacate" onClick={()=>removeOcc(holder.staffId)}>×</button></span> : <span className="who vacant">Vacant</span>}
    </div>
    <div className="org-edit-row">
      <select defaultValue="" onChange={e=>{ assign(e.target.value,'primary'); e.target.value=''; }}>
        <option value="" disabled>{holder ? 'Change holder…' : 'Assign holder…'}</option>
        {freeStaff.map(s=><option key={s.id} value={s.id}>{s.fullName}</option>)}
      </select>
      <Link className="org-newstaff" to="/settings/people" title="Create and link a new staff member">+ New</Link>
    </div>

    <div className="org-edit-row">
      <span className="lab">Deputy</span>
      {deputy ? <span className="who">{deputy.staffName} <button type="button" className="x" title="Remove deputy" onClick={()=>removeOcc(deputy.staffId)}>×</button></span> : <span className="who vacant">—</span>}
    </div>
    <div className="org-edit-row">
      <select defaultValue="" onChange={e=>{ assign(e.target.value,'deputy'); e.target.value=''; }}>
        <option value="" disabled>{deputy ? 'Change deputy…' : 'Assign deputy…'}</option>
        {freeStaff.map(s=><option key={s.id} value={s.id}>{s.fullName}</option>)}
      </select>
    </div>

    {secondaries.length>0 && <div className="org-edit-row wrap">{secondaries.map(o=><span key={o.staffId} className="badge">{o.staffName} <button type="button" className="x" onClick={()=>removeOcc(o.staffId)}>×</button></span>)}</div>}

    <div className="org-edit-row">
      <span className="lab">Reports to</span>
      <select value={node.reportsToPositionId?String(node.reportsToPositionId):''} onChange={e=>ctx.call(`/positions/${node.id}`,{method:'PUT',body:JSON.stringify({reportsToPositionId:e.target.value||null})},'Reporting line updated.')}>
        <option value="">None (top level)</option>
        {reportOptions.map(n=><option key={n.id} value={n.id}>{n.title}</option>)}
      </select>
    </div>

    <label className="org-edit-row toggle"><input type="checkbox" checked={node.isActive===1} onChange={e=>ctx.call(`/positions/${node.id}`,{method:'PUT',body:JSON.stringify({isActive:e.target.checked})})} /> Active</label>

    <form className="org-edit-row" onSubmit={addChildRole}>
      <input placeholder="Add subordinate role…" value={child} onChange={e=>setChild(e.target.value)} />
      <button type="submit" className="tiny">Add</button>
    </form>

    <div className="org-edit-actions">
      <button type="button" className="secondary tiny" onClick={()=>{ if(window.confirm(`Remove the role "${node.title}"? If it has staff or subordinates it is deactivated instead of deleted.`)) ctx.call(`/positions/${node.id}`,{method:'DELETE'},'Role removed.').then(()=>ctx.onSelect(null)); }}>Remove</button>
      <button type="button" className="tiny" onClick={()=>ctx.onSelect(null)}>Done</button>
    </div>
  </div>;
}

// ---------------------------------------------------------------------------
// Section / Unit Configuration
// ---------------------------------------------------------------------------
// A single workspace to configure each laboratory unit/section: its profile,
// the services it offers (and explicitly does NOT offer), its own test menu,
// its equipment, and its stock/inventory. Test menu / equipment / inventory
// write to the same section-scoped tables used by Process Management,
// Equipment and Supplier & Inventory, so the configuration stays linked.

const SECTION_SUBTABS = ['Profile', 'Services', 'Test Menu', 'Equipment', 'Stock & Inventory', 'Staff'] as const;
type SectionSubtab = typeof SECTION_SUBTABS[number];

export function SectionConfig() {
  const [sections, setSections] = useState<SectionConfigRow[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<SectionConfigDetail | null>(null);
  const [subtab, setSubtab] = useState<SectionSubtab>('Profile');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);

  function loadSections() { api<SectionConfigRow[]>('/section-config/sections').then(setSections).catch(e => setError((e as Error).message)); }
  function loadDetail(id: number) { api<SectionConfigDetail>(`/section-config/sections/${id}`).then(setDetail).catch(e => setError((e as Error).message)); }
  useEffect(() => {
    loadSections();
    api<Department[]>('/departments').then(setDepartments).catch(() => setDepartments([]));
    api<Staff[]>('/staff').then(setStaff).catch(() => setStaff([]));
  }, []);
  useEffect(() => { if (selectedId != null) { loadDetail(selectedId); setSubtab('Profile'); } }, [selectedId]);

  function refresh() { loadSections(); if (selectedId != null) loadDetail(selectedId); }
  async function call(path: string, options: RequestInit, okMsg?: string) {
    setError(null); setSuccess(null);
    try { await api(path, options); if (okMsg) setSuccess(okMsg); refresh(); return true; }
    catch (e) { setError((e as Error).message); return false; }
  }

  // --- new unit ---
  const [newForm, setNewForm] = useState({ name: '', departmentId: '', code: '', operatingHours: '', headStaffId: '', serviceSummary: '', description: '' });
  async function createSection(e: FormEvent) {
    e.preventDefault();
    const ok = await call('/section-config/sections', { method: 'POST', body: JSON.stringify(newForm) }, 'Unit created.');
    if (ok) { setNewForm({ name: '', departmentId: '', code: '', operatingHours: '', headStaffId: '', serviceSummary: '', description: '' }); setShowNew(false); }
  }
  async function deleteSection() {
    if (selectedId == null) return;
    if (!window.confirm('Delete this unit? If it is referenced by staff, tests, equipment or stock it will be deactivated instead of deleted.')) return;
    setError(null); setSuccess(null);
    try {
      const r = await api<{ deactivated?: boolean; message?: string }>(`/section-config/sections/${selectedId}`, { method: 'DELETE' });
      setSuccess(r?.message || (r?.deactivated ? 'Unit deactivated (it is in use).' : 'Unit deleted.'));
      setSelectedId(null); setDetail(null); loadSections();
    } catch (e) { setError((e as Error).message); }
  }

  return <div className="section-config">
    <div className="card">
      <div className="panel-head">
        <h3>Section / Unit Configuration</h3>
        <button onClick={() => setShowNew(v => !v)}>{showNew ? 'Cancel' : '+ New unit'}</button>
      </div>
      <p>Configure every laboratory unit in one place. Not all laboratories run every unit — create only the units you operate, define what each one does (and does not) do, and set up its test menu, equipment and stock. These feed Process Management, Equipment, Supplier &amp; Inventory and Personnel automatically.</p>
      {error && <div className="error">{error}</div>}
      {success && <div className="notice-ok">{success}</div>}

      {showNew && <form className="form" onSubmit={createSection}>
        <div className="form-grid">
          <label>Unit / section name<input value={newForm.name} onChange={e => setNewForm({ ...newForm, name: e.target.value })} required placeholder="e.g. Molecular Biology" /></label>
          <label>Department<select value={newForm.departmentId} onChange={e => setNewForm({ ...newForm, departmentId: e.target.value })}><option value="">Default</option>{departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
          <label>Unit code<input value={newForm.code} onChange={e => setNewForm({ ...newForm, code: e.target.value })} placeholder="e.g. MOL" /></label>
          <label>Operating hours<input value={newForm.operatingHours} onChange={e => setNewForm({ ...newForm, operatingHours: e.target.value })} placeholder="e.g. 24/7 or Mon–Fri 08:00–17:00" /></label>
          <label>Unit head<select value={newForm.headStaffId} onChange={e => setNewForm({ ...newForm, headStaffId: e.target.value })}><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
        </div>
        <label>Service summary<input value={newForm.serviceSummary} onChange={e => setNewForm({ ...newForm, serviceSummary: e.target.value })} placeholder="Short description of what this unit provides" /></label>
        <label>Description / scope<textarea value={newForm.description} onChange={e => setNewForm({ ...newForm, description: e.target.value })} /></label>
        <button type="submit">Create unit</button>
      </form>}

      <div className="unit-grid">
        {sections.map(s => <button key={s.id} type="button" className={`unit-card ${selectedId === s.id ? 'active' : ''} ${s.isActive ? '' : 'inactive'}`} onClick={() => setSelectedId(s.id)}>
          <div className="unit-card-top">
            <strong>{s.name}</strong>
            {s.isActive ? <span className="badge active">active</span> : <span className="badge inactive">inactive</span>}
          </div>
          <span className="hint">{s.code ? `${s.code} · ` : ''}{s.departmentName || 'Laboratory'}</span>
          <div className="unit-stats">
            <span title="Services offered">🧪 {s.servicesOffered}</span>
            <span title="Tests in menu">📋 {s.testCount}</span>
            <span title="Equipment">⚙️ {s.equipmentCount}</span>
            <span title="Stock items">📦 {s.inventoryCount}</span>
            <span title="Active staff">👤 {s.staffCount}</span>
          </div>
        </button>)}
        {sections.length === 0 && <p className="hint">No units configured yet. Use “+ New unit” to create your first one.</p>}
      </div>
    </div>

    {detail && selectedId != null && <SectionDetailPanel
      detail={detail}
      departments={departments}
      staff={staff}
      subtab={subtab}
      onSubtab={setSubtab}
      onClose={() => { setSelectedId(null); setDetail(null); }}
      onDelete={deleteSection}
      call={call}
      sectionId={selectedId}
    />}
  </div>;
}

function SectionDetailPanel({ detail, departments, staff, subtab, onSubtab, onClose, onDelete, call, sectionId }: {
  detail: SectionConfigDetail; departments: Department[]; staff: Staff[]; subtab: SectionSubtab;
  onSubtab: (t: SectionSubtab) => void; onClose: () => void; onDelete: () => void;
  call: (path: string, options: RequestInit, okMsg?: string) => Promise<boolean>; sectionId: number;
}) {
  const s = detail.section;
  const [profile, setProfile] = useState({ name: s.name, code: s.code || '', departmentId: s.department_id ? String(s.department_id) : '', headStaffId: s.head_staff_id ? String(s.head_staff_id) : '', operatingHours: s.operating_hours || '', serviceSummary: s.service_summary || '', description: s.description || '' });
  useEffect(() => { setProfile({ name: s.name, code: s.code || '', departmentId: s.department_id ? String(s.department_id) : '', headStaffId: s.head_staff_id ? String(s.head_staff_id) : '', operatingHours: s.operating_hours || '', serviceSummary: s.service_summary || '', description: s.description || '' }); }, [s.id]);

  const [svc, setSvc] = useState({ name: '', category: '', isOffered: 'yes', notes: '' });
  const [test, setTest] = useState({ testName: '', sampleType: '', methodName: '', tatTargetMinutes: '' });
  const [equip, setEquip] = useState({ name: '', category: '', manufacturer: '', model: '', serialNumber: '' });
  const [item, setItem] = useState({ name: '', category: '', quantity: '', unit: '', reorderLevel: '', expiryDate: '' });

  return <div className="card section-detail">
    <div className="panel-head">
      <h3>{s.name} {s.is_active ? '' : <span className="badge inactive">inactive</span>}</h3>
      <div>
        <button className="secondary" onClick={() => call(`/section-config/sections/${sectionId}/toggle`, { method: 'POST' }, s.is_active ? 'Unit deactivated.' : 'Unit activated.')}>{s.is_active ? 'Deactivate unit' : 'Activate unit'}</button>
        <button className="secondary" onClick={onDelete}>Delete unit</button>
        <button className="secondary" onClick={onClose}>Close</button>
      </div>
    </div>

    <div className="tabs">{SECTION_SUBTABS.map(t => <button key={t} className={subtab === t ? 'active' : ''} onClick={() => onSubtab(t)}>{t}</button>)}</div>

    {subtab === 'Profile' && <form className="form" onSubmit={e => { e.preventDefault(); call(`/section-config/sections/${sectionId}`, { method: 'PUT', body: JSON.stringify(profile) }, 'Unit profile updated.'); }}>
      <div className="form-grid">
        <label>Unit name<input value={profile.name} onChange={e => setProfile({ ...profile, name: e.target.value })} required /></label>
        <label>Unit code<input value={profile.code} onChange={e => setProfile({ ...profile, code: e.target.value })} /></label>
        <label>Department<select value={profile.departmentId} onChange={e => setProfile({ ...profile, departmentId: e.target.value })}><option value="">Default</option>{departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
        <label>Unit head<select value={profile.headStaffId} onChange={e => setProfile({ ...profile, headStaffId: e.target.value })}><option value="">—</option>{staff.map(st => <option key={st.id} value={st.id}>{st.fullName}</option>)}</select></label>
        <label>Operating hours<input value={profile.operatingHours} onChange={e => setProfile({ ...profile, operatingHours: e.target.value })} /></label>
      </div>
      <label>Service summary<input value={profile.serviceSummary} onChange={e => setProfile({ ...profile, serviceSummary: e.target.value })} /></label>
      <label>Description / scope<textarea value={profile.description} onChange={e => setProfile({ ...profile, description: e.target.value })} /></label>
      <button type="submit">Save profile</button>
    </form>}

    {subtab === 'Services' && <>
      <p className="hint">Define what this unit does and explicitly does not do. This makes the lab's true scope clear and drives section-specific configuration.</p>
      <form className="form" onSubmit={e => { e.preventDefault(); call(`/section-config/sections/${sectionId}/services`, { method: 'POST', body: JSON.stringify({ ...svc, isOffered: svc.isOffered === 'yes' }) }, 'Service saved.').then(ok => { if (ok) setSvc({ name: '', category: '', isOffered: 'yes', notes: '' }); }); }}>
        <div className="form-grid">
          <label>Service / activity<input value={svc.name} onChange={e => setSvc({ ...svc, name: e.target.value })} required placeholder="e.g. Full Blood Count, Blood Culture" /></label>
          <label>Category<input value={svc.category} onChange={e => setSvc({ ...svc, category: e.target.value })} placeholder="e.g. Routine, Referral" /></label>
          <label>Offered here?<select value={svc.isOffered} onChange={e => setSvc({ ...svc, isOffered: e.target.value })}><option value="yes">Yes — done in this unit</option><option value="no">No — not offered / referred out</option></select></label>
          <label>Notes<input value={svc.notes} onChange={e => setSvc({ ...svc, notes: e.target.value })} /></label>
        </div>
        <button type="submit">Add service</button>
      </form>
      <table className="data-table"><thead><tr><th>Service</th><th>Category</th><th>Status</th><th>Notes</th><th></th></tr></thead><tbody>
        {detail.services.map(sv => <tr key={sv.id}>
          <td>{sv.name}</td><td>{sv.category || '—'}</td>
          <td>{sv.is_offered ? <span className="badge active">offered</span> : <span className="badge inactive">not offered</span>}</td>
          <td>{sv.notes || '—'}</td>
          <td>
            <button onClick={() => call(`/section-config/services/${sv.id}`, { method: 'PUT', body: JSON.stringify({ isOffered: !sv.is_offered }) })}>{sv.is_offered ? 'Mark not offered' : 'Mark offered'}</button>
            <button className="secondary" onClick={() => call(`/section-config/services/${sv.id}`, { method: 'DELETE' })}>Remove</button>
          </td>
        </tr>)}
        {detail.services.length === 0 && <tr><td colSpan={5} className="hint">No services defined yet.</td></tr>}
      </tbody></table>
    </>}

    {subtab === 'Test Menu' && <>
      <p className="hint">Each unit has its own test menu. Tests added here appear in <Link to="/process-management">Process Management</Link> scoped to this unit.</p>
      <form className="form" onSubmit={e => { e.preventDefault(); call(`/section-config/sections/${sectionId}/tests`, { method: 'POST', body: JSON.stringify(test) }, 'Test added to menu.').then(ok => { if (ok) setTest({ testName: '', sampleType: '', methodName: '', tatTargetMinutes: '' }); }); }}>
        <div className="form-grid">
          <label>Test name<input value={test.testName} onChange={e => setTest({ ...test, testName: e.target.value })} required /></label>
          <label>Sample type<input value={test.sampleType} onChange={e => setTest({ ...test, sampleType: e.target.value })} placeholder="e.g. EDTA blood, Serum" /></label>
          <label>Method<input value={test.methodName} onChange={e => setTest({ ...test, methodName: e.target.value })} /></label>
          <label>TAT target (min)<input type="number" value={test.tatTargetMinutes} onChange={e => setTest({ ...test, tatTargetMinutes: e.target.value })} /></label>
        </div>
        <button type="submit">Add test</button>
      </form>
      <table className="data-table"><thead><tr><th>Code</th><th>Test</th><th>Sample</th><th>Method</th><th>TAT</th><th>Status</th><th></th></tr></thead><tbody>
        {detail.tests.map(t => <tr key={t.id}>
          <td>{t.test_code || '—'}</td><td>{t.test_name}</td><td>{t.sample_type || '—'}</td><td>{t.method_name || '—'}</td>
          <td>{t.tat_target_minutes != null ? `${t.tat_target_minutes}m` : '—'}</td>
          <td>{t.status === 'active' ? <span className="badge active">active</span> : <span className="badge inactive">{t.status}</span>}</td>
          <td><button onClick={() => call(`/section-config/tests/${t.id}/toggle`, { method: 'POST' })}>{t.status === 'active' ? 'Deactivate' : 'Activate'}</button></td>
        </tr>)}
        {detail.tests.length === 0 && <tr><td colSpan={7} className="hint">No tests in this unit's menu yet.</td></tr>}
      </tbody></table>
    </>}

    {subtab === 'Equipment' && <>
      <p className="hint">Equipment registered here is scoped to this unit and appears in the <Link to="/equipment">Equipment Management</Link> module for scheduling and maintenance.</p>
      <form className="form" onSubmit={e => { e.preventDefault(); call(`/section-config/sections/${sectionId}/equipment`, { method: 'POST', body: JSON.stringify(equip) }, 'Equipment registered.').then(ok => { if (ok) setEquip({ name: '', category: '', manufacturer: '', model: '', serialNumber: '' }); }); }}>
        <div className="form-grid">
          <label>Equipment name<input value={equip.name} onChange={e => setEquip({ ...equip, name: e.target.value })} required /></label>
          <label>Category<input value={equip.category} onChange={e => setEquip({ ...equip, category: e.target.value })} placeholder="e.g. Analyser, Centrifuge" /></label>
          <label>Manufacturer<input value={equip.manufacturer} onChange={e => setEquip({ ...equip, manufacturer: e.target.value })} /></label>
          <label>Model<input value={equip.model} onChange={e => setEquip({ ...equip, model: e.target.value })} /></label>
          <label>Serial number<input value={equip.serialNumber} onChange={e => setEquip({ ...equip, serialNumber: e.target.value })} /></label>
        </div>
        <button type="submit">Register equipment</button>
      </form>
      <table className="data-table"><thead><tr><th>Number</th><th>Name</th><th>Category</th><th>Make / model</th><th>Serial</th><th>Status</th></tr></thead><tbody>
        {detail.equipment.map(eq => <tr key={eq.id}>
          <td>{eq.equipment_number}</td><td>{eq.name}</td><td>{eq.category || '—'}</td>
          <td>{[eq.manufacturer, eq.model].filter(Boolean).join(' ') || '—'}</td><td>{eq.serial_number || '—'}</td>
          <td><span className={`badge ${eq.status === 'operational' ? 'active' : ''}`}>{eq.status}</span></td>
        </tr>)}
        {detail.equipment.length === 0 && <tr><td colSpan={6} className="hint">No equipment registered for this unit yet.</td></tr>}
      </tbody></table>
    </>}

    {subtab === 'Stock & Inventory' && <>
      <p className="hint">Stock and reagents set here are scoped to this unit and managed in the <Link to="/supplier-inventory">Supplier &amp; Inventory</Link> module.</p>
      <form className="form" onSubmit={e => { e.preventDefault(); call(`/section-config/sections/${sectionId}/inventory`, { method: 'POST', body: JSON.stringify(item) }, 'Stock item added.').then(ok => { if (ok) setItem({ name: '', category: '', quantity: '', unit: '', reorderLevel: '', expiryDate: '' }); }); }}>
        <div className="form-grid">
          <label>Item name<input value={item.name} onChange={e => setItem({ ...item, name: e.target.value })} required /></label>
          <label>Category<input value={item.category} onChange={e => setItem({ ...item, category: e.target.value })} placeholder="e.g. Reagent, Consumable" /></label>
          <label>Quantity<input type="number" value={item.quantity} onChange={e => setItem({ ...item, quantity: e.target.value })} /></label>
          <label>Unit<input value={item.unit} onChange={e => setItem({ ...item, unit: e.target.value })} placeholder="e.g. boxes, vials" /></label>
          <label>Reorder level<input type="number" value={item.reorderLevel} onChange={e => setItem({ ...item, reorderLevel: e.target.value })} /></label>
          <label>Expiry date<input type="date" value={item.expiryDate} onChange={e => setItem({ ...item, expiryDate: e.target.value })} /></label>
        </div>
        <button type="submit">Add stock item</button>
      </form>
      <table className="data-table"><thead><tr><th>Code</th><th>Item</th><th>Category</th><th>Qty</th><th>Reorder</th><th>Expiry</th><th>Status</th></tr></thead><tbody>
        {detail.inventory.map(it => <tr key={it.id}>
          <td>{it.item_code}</td><td>{it.name}</td><td>{it.category || '—'}</td>
          <td>{it.quantity}{it.unit ? ` ${it.unit}` : ''}</td><td>{it.reorder_level}</td><td>{it.expiry_date || '—'}</td>
          <td><span className="badge">{it.status}</span></td>
        </tr>)}
        {detail.inventory.length === 0 && <tr><td colSpan={7} className="hint">No stock items for this unit yet.</td></tr>}
      </tbody></table>
    </>}

    {subtab === 'Staff' && <>
      <p className="hint">Staff assigned to this unit. Assign people to a unit during <Link to="/settings/people">Register New Staff</Link> or in <Link to="/personnel">Personnel Management</Link>.</p>
      <table className="data-table"><thead><tr><th>Name</th><th>Employee no</th><th>Status</th></tr></thead><tbody>
        {detail.staff.map(p => <tr key={p.id}><td>{p.full_name}</td><td>{p.employee_no || '—'}</td><td>{p.is_active ? <span className="badge active">active</span> : <span className="badge inactive">inactive</span>}</td></tr>)}
        {detail.staff.length === 0 && <tr><td colSpan={3} className="hint">No staff assigned to this unit yet.</td></tr>}
      </tbody></table>
    </>}
  </div>;
}

// ---------------------------------------------------------------------------
// Permission Matrix
// ---------------------------------------------------------------------------
const ACTION_META: Record<string, { short: string; title: string }> = {
  view: { short: 'V', title: 'View' },
  create: { short: 'C', title: 'Create' },
  edit: { short: 'E', title: 'Edit' },
  void_archive: { short: 'Z', title: 'Void / Archive' },
  export: { short: 'X', title: 'Export' },
  print: { short: 'P', title: 'Print' },
  approve: { short: 'A', title: 'Approve' },
};

export function PermissionMatrix(){
  const [data,setData]=useState<PermissionMatrixData | null>(null);
  const [roles,setRoles]=useState<{id:number;name:string}[]>([]);
  const [positions,setPositions]=useState<Position[]>([]);
  const [users,setUsers]=useState<ApiUser[]>([]);
  const [staff,setStaff]=useState<Staff[]>([]);
  const [sections,setSections]=useState<Section[]>([]);
  const [techAuths,setTechAuths]=useState<TechnicalAuthorizationRow[]>([]);
  const [error,setError]=useState<string|null>(null);
  const tabs=['Authorization Matrix','Role Permissions','Position Permissions','User Overrides','Technical Authorizations','Section Scope','Audit History'];
  const [tab,setTab]=useState(tabs[0]);
  const [matrixScope,setMatrixScope]=useState<'role'|'position'>('role');
  const [moduleFilter,setModuleFilter]=useState<string>('all');
  const [auditFilter,setAuditFilter]=useState<string>('all');

  function loadMatrix(){ api<PermissionMatrixData>('/permissions/matrix').then(setData).catch(e=>setError((e as Error).message)); }
  function loadTechAuths(){ api<TechnicalAuthorizationRow[]>('/authorizations/technical').then(setTechAuths).catch(()=>setTechAuths([])); }
  useEffect(()=>{
    loadMatrix();
    loadTechAuths();
    api<{id:number;name:string}[]>('/roles').then(setRoles);
    api<Position[]>('/positions').then(setPositions);
    api<ApiUser[]>('/users').then(setUsers);
    api<Staff[]>('/staff').then(setStaff);
    api<Section[]>('/sections').then(setSections);
  },[]);

  // module list present in the permission set, in canonical MODULES order
  const matrixModules = useMemo(()=>{
    if(!data) return [] as { key:string; label:string }[];
    const present = new Set(data.permissions.map(p=>p.module_key));
    return MODULES.filter(m=>present.has(m.key)).map(m=>({key:m.key,label:m.label}));
  },[data]);

  // permission id lookup by module+action
  const permIndex = useMemo(()=>{
    const map = new Map<string, Permission>();
    data?.permissions.forEach(p=>map.set(`${p.module_key}:${p.action}`, p));
    return map;
  },[data]);

  // allowed set for current scope: `${subjectId}:${permissionId}`
  const allowedSet = useMemo(()=>{
    const set = new Set<string>();
    if(!data) return set;
    const rows = matrixScope==='role' ? data.rolePermissions : data.positionPermissions;
    rows.forEach(r=>{ if(r.allowed===1){ const id = matrixScope==='role'?(r as any).role_id:(r as any).position_id; set.add(`${id}:${r.permission_id}`);} });
    return set;
  },[data,matrixScope]);

  const subjects = matrixScope==='role' ? roles.map(r=>({id:r.id,name:r.name})) : positions.filter(p=>p.isActive!==false).map(p=>({id:p.id,name:p.title}));
  const visibleModules = moduleFilter==='all' ? matrixModules : matrixModules.filter(m=>m.key===moduleFilter);

  async function toggleCell(subjectId:number, perm:Permission, currentlyAllowed:boolean){
    setError(null);
    try {
      const endpoint = matrixScope==='role' ? '/permissions/role' : '/permissions/position';
      const body = matrixScope==='role'
        ? { roleId: subjectId, permissionId: perm.id, allowed: !currentlyAllowed }
        : { positionId: subjectId, permissionId: perm.id, allowed: !currentlyAllowed };
      await api(endpoint,{method:'POST',body:JSON.stringify(body)});
      loadMatrix();
    } catch (e) { setError((e as Error).message); }
  }

  async function addRolePermission(e:FormEvent<HTMLFormElement>){
    e.preventDefault();
    const fd=new FormData(e.currentTarget);
    await api('/permissions/role',{method:'POST',body:JSON.stringify({roleId:Number(fd.get('roleId')),permissionId:Number(fd.get('permissionId')),allowed:fd.get('allowed')==='allow'})});
    e.currentTarget.reset(); loadMatrix();
  }
  async function addPositionPermission(e:FormEvent<HTMLFormElement>){
    e.preventDefault();
    const fd=new FormData(e.currentTarget);
    await api('/permissions/position',{method:'POST',body:JSON.stringify({positionId:Number(fd.get('positionId')),permissionId:Number(fd.get('permissionId')),allowed:fd.get('allowed')==='allow'})});
    e.currentTarget.reset(); loadMatrix();
  }
  async function addUserOverride(e:FormEvent<HTMLFormElement>){
    e.preventDefault();
    const fd=new FormData(e.currentTarget);
    await api('/permissions/user-override',{method:'POST',body:JSON.stringify({userId:Number(fd.get('userId')),permissionId:Number(fd.get('permissionId')),allowed:fd.get('effect')==='allow',reason:fd.get('reason')})});
    e.currentTarget.reset(); loadMatrix();
  }
  async function addTechnicalAuth(e:FormEvent<HTMLFormElement>){
    e.preventDefault(); setError(null);
    const fd=new FormData(e.currentTarget);
    try {
      await api('/authorizations/technical',{method:'POST',body:JSON.stringify({staffId:fd.get('staffId')?Number(fd.get('staffId')):null,positionId:fd.get('positionId')?Number(fd.get('positionId')):null,moduleKey:fd.get('moduleKey'),sectionId:fd.get('sectionId')?Number(fd.get('sectionId')):null,level:fd.get('level'),expiresAt:fd.get('expiresAt')||null})});
      e.currentTarget.reset(); loadMatrix(); loadTechAuths();
    } catch (err) { setError((err as Error).message); }
  }
  async function deactivateAuth(id:number){
    setError(null);
    try { await api(`/authorizations/technical/${id}/deactivate`,{method:'POST'}); loadMatrix(); loadTechAuths(); }
    catch (err) { setError((err as Error).message); }
  }

  const moduleLabel = (key:string)=>MODULES.find(m=>m.key===key)?.label ?? key;

  function summariseAudit(entry: PermissionMatrixData['auditHistory'][number]): string {
    const parse = (v?: string|null) => { if(!v) return null; try { return JSON.parse(v); } catch { return v; } };
    const nv:any = parse(entry.new_value);
    if(nv && typeof nv==='object'){
      const bits:string[]=[];
      if(nv.username) bits.push(`user ${nv.username}`);
      if(nv.fullName) bits.push(nv.fullName);
      if(nv.moduleKey) bits.push(`module ${nv.moduleKey}`);
      if(nv.level) bits.push(`level ${nv.level}`);
      if('allowed' in nv) bits.push(nv.allowed?'allow':'deny');
      if(nv.reason) bits.push(`(${nv.reason})`);
      if(bits.length) return bits.join(' · ');
    }
    return entry.entity_id ? `#${entry.entity_id}` : '';
  }

  const auditEntities = useMemo(()=>{
    const s = new Set<string>(); data?.auditHistory.forEach(a=>s.add(a.entity)); return Array.from(s);
  },[data]);
  const filteredAudit = (data?.auditHistory ?? []).filter(a=>auditFilter==='all'||a.entity===auditFilter);

  return <div className="card"><h3>Permission Matrix</h3><p>Role-based access control with module permissions, record actions, approvals, technical authorizations, section scope, overrides, and a full audit trail.</p>
    <div className="tabs">{tabs.map(t=><button key={t} onClick={()=>setTab(t)} className={tab===t?'active':''}>{t}</button>)}</div>
    {error && <div className="error">{error}</div>}

    {tab==='Authorization Matrix' && <div>
      <div className="matrix-toolbar">
        <div className="seg">
          <button className={matrixScope==='role'?'active':''} onClick={()=>setMatrixScope('role')}>Roles</button>
          <button className={matrixScope==='position'?'active':''} onClick={()=>setMatrixScope('position')}>Positions</button>
        </div>
        <label className="inline">Module
          <select value={moduleFilter} onChange={e=>setModuleFilter(e.target.value)}>
            <option value="all">All modules</option>
            {matrixModules.map(m=><option key={m.key} value={m.key}>{m.label}</option>)}
          </select>
        </label>
      </div>
      <p className="hint">Each cell shows the actions a {matrixScope} is authorized for. Click an action chip to grant or revoke it.</p>
      <div className="matrix-legend">
        {PERMISSION_ACTIONS.map(a=><span key={a} className="leg"><span className="auth-chip on">{ACTION_META[a]?.short ?? a[0].toUpperCase()}</span>{ACTION_META[a]?.title ?? a}</span>)}
      </div>
      <div className="auth-matrix-wrap">
        <table className="auth-matrix">
          <thead><tr><th className="corner">{matrixScope==='role'?'Role':'Position'}</th>{visibleModules.map(m=><th key={m.key}>{m.label}</th>)}</tr></thead>
          <tbody>
            {subjects.map(sub=><tr key={sub.id}>
              <th className="row-head">{sub.name}</th>
              {visibleModules.map(m=><td key={m.key} className="auth-cell">
                {PERMISSION_ACTIONS.map(action=>{
                  const perm = permIndex.get(`${m.key}:${action}`);
                  if(!perm) return null;
                  const on = allowedSet.has(`${sub.id}:${perm.id}`);
                  return <button key={action} type="button" title={`${ACTION_META[action]?.title ?? action} — click to ${on?'revoke':'grant'}`} className={`auth-chip ${on?'on':'off'}`} onClick={()=>toggleCell(sub.id, perm, on)}>{ACTION_META[action]?.short ?? action[0].toUpperCase()}</button>;
                })}
              </td>)}
            </tr>)}
            {subjects.length===0 && <tr><td className="hint" colSpan={visibleModules.length+1}>No {matrixScope}s defined.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>}

    {tab==='Role Permissions' && <div>
      <form className="form" onSubmit={addRolePermission}>
        <label>Role<select name="roleId" required>{roles.map(r=><option value={r.id} key={r.id}>{r.name}</option>)}</select></label>
        <label>Permission<select name="permissionId" required>{(data?.permissions??[]).map(p=><option value={p.id} key={p.id}>{p.label}</option>)}</select></label>
        <label>Effect<select name="allowed" required><option value="allow">Allow</option><option value="deny">Deny</option></select></label>
        <button>Assign permission</button>
      </form>
    </div>}

    {tab==='Position Permissions' && <div>
      <form className="form" onSubmit={addPositionPermission}>
        <label>Position<select name="positionId" required>{positions.map(p=><option value={p.id} key={p.id}>{p.title}</option>)}</select></label>
        <label>Permission<select name="permissionId" required>{(data?.permissions??[]).map(p=><option value={p.id} key={p.id}>{p.label}</option>)}</select></label>
        <label>Effect<select name="allowed" required><option value="allow">Allow</option><option value="deny">Deny</option></select></label>
        <button>Assign permission</button>
      </form>
    </div>}

    {tab==='User Overrides' && <div>
      <form className="form" onSubmit={addUserOverride}>
        <label>User<select name="userId" required>{users.map(u=><option value={u.id} key={u.id}>{u.fullName}</option>)}</select></label>
        <label>Permission<select name="permissionId" required>{(data?.permissions??[]).map(p=><option value={p.id} key={p.id}>{p.label}</option>)}</select></label>
        <label>Effect<select name="effect" required><option value="allow">Allow</option><option value="deny">Deny</option></select></label>
        <label>Reason<textarea name="reason"/></label>
        <button>Add override</button>
      </form>
      {data && data.userOverrides.length>0 && <table className="data-table"><thead><tr><th>User</th><th>Permission</th><th>Effect</th><th>Reason</th></tr></thead><tbody>
        {data.userOverrides.map(o=>{ const u=users.find(x=>x.id===o.user_id); const p=data.permissions.find(x=>x.id===o.permission_id); return <tr key={o.id}><td>{u?.fullName||`User #${o.user_id}`}</td><td>{p?.label||`#${o.permission_id}`}</td><td>{o.allowed?<span className="badge active">allow</span>:<span className="badge inactive">deny</span>}</td><td>{o.reason||'—'}</td></tr>; })}
      </tbody></table>}
    </div>}

    {tab==='Technical Authorizations' && <div>
      <form className="form" onSubmit={addTechnicalAuth}>
        <label>Staff<select name="staffId"><option value="">—</option>{staff.map(s=><option value={s.id} key={s.id}>{s.fullName}</option>)}</select></label>
        <label>Position (Optional)<select name="positionId"><option value="">None</option>{positions.map(p=><option value={p.id} key={p.id}>{p.title}</option>)}</select></label>
        <label>Module<select name="moduleKey" required>{MODULES.map(m=><option value={m.key} key={m.key}>{m.label}</option>)}</select></label>
        <label>Section<select name="sectionId"><option value="">All sections</option>{sections.map(s=><option value={s.id} key={s.id}>{s.name}</option>)}</select></label>
        <label>Authorization Level<select name="level" required>{TECHNICAL_AUTHORIZATION_LEVELS.map(l=><option value={l} key={l}>{l}</option>)}</select></label>
        <label>Expires<input type="date" name="expiresAt"/></label>
        <button>Add authorization</button>
      </form>
    </div>}

    {tab==='Section Scope' && <div>
      <p>Section-scoped technical authorizations control what each staff member or position can do within a specific laboratory section.</p>
      <form className="form" onSubmit={addTechnicalAuth}>
        <label>Staff<select name="staffId"><option value="">—</option>{staff.map(s=><option value={s.id} key={s.id}>{s.fullName}</option>)}</select></label>
        <label>or Position<select name="positionId"><option value="">None</option>{positions.map(p=><option value={p.id} key={p.id}>{p.title}</option>)}</select></label>
        <label>Module<select name="moduleKey" required>{MODULES.map(m=><option value={m.key} key={m.key}>{m.label}</option>)}</select></label>
        <label>Section scope<select name="sectionId"><option value="">All sections</option>{sections.map(s=><option value={s.id} key={s.id}>{s.name}</option>)}</select></label>
        <label>Level<select name="level" required>{TECHNICAL_AUTHORIZATION_LEVELS.map(l=><option value={l} key={l}>{l}</option>)}</select></label>
        <label>Expires<input type="date" name="expiresAt"/></label>
        <button>Grant section authorization</button>
      </form>
      <table className="data-table"><thead><tr><th>Subject</th><th>Module</th><th>Section</th><th>Level</th><th>Status</th><th>Expires</th><th></th></tr></thead><tbody>
        {techAuths.map(a=><tr key={a.id}>
          <td>{a.staff_name || a.position_title || '—'}{a.position_title && a.staff_name ? '' : a.position_title ? ' (position)' : ''}</td>
          <td>{moduleLabel(a.module_key)}</td>
          <td>{a.section_name || 'All sections'}</td>
          <td><span className="badge">{a.level}</span></td>
          <td>{a.is_active ? <span className="badge active">active</span> : <span className="badge inactive">inactive</span>}</td>
          <td>{a.expires_at || '—'}</td>
          <td>{a.is_active ? <button onClick={()=>deactivateAuth(a.id)}>Deactivate</button> : null}</td>
        </tr>)}
        {techAuths.length===0 && <tr><td colSpan={7} className="hint">No technical authorizations yet.</td></tr>}
      </tbody></table>
    </div>}

    {tab==='Audit History' && <div>
      <label className="inline">Filter by entity
        <select value={auditFilter} onChange={e=>setAuditFilter(e.target.value)}>
          <option value="all">All</option>
          {auditEntities.map(en=><option key={en} value={en}>{en}</option>)}
        </select>
      </label>
      <table className="data-table"><thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Entity</th><th>Details</th></tr></thead><tbody>
        {filteredAudit.map(a=><tr key={a.id}>
          <td>{a.created_at}</td>
          <td>{a.actor_name || a.actor_username || 'System'}</td>
          <td><span className="badge">{a.action}</span></td>
          <td>{a.entity}</td>
          <td>{summariseAudit(a)}</td>
        </tr>)}
        {filteredAudit.length===0 && <tr><td colSpan={5} className="hint">No audit history yet.</td></tr>}
      </tbody></table>
    </div>}
  </div>;
}

// ---------------------------------------------------------------------------
// Other settings panels (unchanged behaviour)
// ---------------------------------------------------------------------------
export function ModuleToggles(){
  const [modules,setModules]=useState<SystemModule[]>([]);
  const load=()=>api<SystemModule[]>('/system-modules').then(setModules);
  useEffect(()=>{void load()},[]);
  async function toggle(m:SystemModule){
    await api(`/system-modules/${m.key}`,{method:'PUT',body:JSON.stringify({enabled:!m.enabled})});
    load();
  }
  return <div className="card"><h3>System Modules Toggle</h3><p>Disabled modules are hidden from the main sidebar, alerts are paused, data is preserved, and direct routes show a disabled module page. Settings remains accessible.</p>
    <table className="table"><tbody>{modules.map(m=><tr key={m.key}><td>{m.label}</td><td>{m.enabled?'Enabled':'Disabled'}</td><td><button disabled={m.key==='settings'} onClick={()=>toggle(m)}>{m.enabled?'Disable':'Enable'}</button></td></tr>)}</tbody></table>
  </div>;
}

export function DocumentImport(){
  return <div className="card"><h3>Document Master List Import</h3>
    <p>Bulk import of SOPs, policies, forms, registers, logs and trackers now lives in the Documents module, where each uploaded file becomes a controlled document with its first version.</p>
    <p className="muted">Open <strong>Documents &amp; Records → Bulk Import</strong> to upload multiple files at once, set a shared section, owner and review frequency, and auto-number their document codes.</p>
    <Link to="/documents"><button>Go to Documents</button></Link>
  </div>;
}

export function EvidenceUpload(){
  async function submit(e:FormEvent<HTMLFormElement>){
    e.preventDefault();
    const fd=new FormData(e.currentTarget);
    await api('/evidence',{method:'POST',body:fd});
    alert('Evidence uploaded and linked.');
  }
  return <div className="card"><h3>Evidence Upload</h3>
    <form className="form" onSubmit={submit}>
      <label>File<input name="file" type="file" required/></label>
      <label>Module key<input name="moduleKey" defaultValue="documents" required/></label>
      <label>Record type<input name="recordType" defaultValue="foundation_record" required/></label>
      <label>Record ID<input name="recordId" defaultValue="MVP-1" required/></label>
      <label>Notes<textarea name="notes"/></label>
      <button>Upload evidence</button>
    </form>
  </div>;
}

export function ActionTracker(){
  async function submit(e:FormEvent<HTMLFormElement>){
    e.preventDefault();
    const fd=new FormData(e.currentTarget);
    await api('/actions',{method:'POST',body:JSON.stringify({title:fd.get('title'),moduleKey:fd.get('moduleKey'),priority:fd.get('priority'),dueDate:fd.get('dueDate')})});
    alert('Action created.');
  }
  return <div className="card"><h3>Action Tracker</h3>
    <form className="form" onSubmit={submit}>
      <label>Title<input name="title" required/></label>
      <label>Module key<input name="moduleKey" defaultValue="nc_capa"/></label>
      <label>Priority<select name="priority"><option>normal</option><option>high</option><option>low</option></select></label>
      <label>Due date<input name="dueDate" type="date"/></label>
      <button>Create action</button>
    </form>
  </div>;
}

type BackupEntry = { fileName: string; sizeBytes: number; createdAt: string; source: string; downloadPath: string };

function formatBytes(n: number): string {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / Math.pow(1024, i)).toFixed(i ? 1 : 0)} ${units[i]}`;
}

export function BackupRestore(){
  const { user, logout } = useAuth();
  const isAdmin = user?.roleName === 'System Administrator';
  const [backups, setBackups] = useState<BackupEntry[]>([]);
  const [location, setLocation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [resetConfirm, setResetConfirm] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const load = () => api<{ location: string; backups: BackupEntry[] }>('/backup/list')
    .then(r => { setBackups(r.backups); setLocation(r.location); })
    .catch(e => setError(e.message));
  useEffect(() => { void load(); }, []);

  async function createBackup() {
    setBusy(true); setError(null); setMessage(null);
    try {
      const r = await api<{ fileName: string; sizeBytes: number; location: string }>('/backup/create', { method: 'POST' });
      setMessage(`Backup created: ${r.fileName} (${formatBytes(r.sizeBytes)}). Saved in ${r.location}. Use Download to save a copy anywhere you like.`);
      await load();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  async function download(entry: BackupEntry) {
    setError(null);
    try {
      const token = getToken();
      const res = await fetch(`${API_BASE}${entry.downloadPath}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      if (!res.ok) throw new Error('Download failed.');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = entry.fileName;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch (e) { setError((e as Error).message); }
  }

  const CONFIRM = 'This REPLACES the current database, uploads, evidence and config with the contents of the backup. A pre-restore safety backup is created automatically first. You may need to sign in again afterwards.\n\nContinue?';

  async function restoreExisting(entry: BackupEntry) {
    if (!window.confirm(`Restore from "${entry.fileName}"?\n\n${CONFIRM}`)) return;
    setBusy(true); setError(null); setMessage(null);
    try {
      const r = await api<{ message: string; safetyBackup: string }>('/backup/restore', { method: 'POST', body: JSON.stringify({ fileName: entry.fileName }) });
      setMessage(`${r.message} (Safety snapshot saved as ${r.safetyBackup}.)`);
      await load();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  async function restoreFromUpload() {
    if (!restoreFile) return;
    if (!window.confirm(`Restore from uploaded file "${restoreFile.name}"?\n\n${CONFIRM}`)) return;
    setBusy(true); setError(null); setMessage(null);
    try {
      const fd = new FormData();
      fd.append('file', restoreFile);
      const r = await api<{ message: string; safetyBackup: string }>('/backup/restore', { method: 'POST', body: fd });
      setMessage(`${r.message} (Safety snapshot saved as ${r.safetyBackup}.)`);
      setRestoreFile(null);
      if (fileRef.current) fileRef.current.value = '';
      await load();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  async function factoryReset() {
    if (resetConfirm !== 'RESET') return;
    if (!window.confirm('FACTORY RESET\n\nThis PERMANENTLY erases ALL data — the database, uploads, evidence and configuration — and returns the system to first-time setup.\n\nA full backup is created automatically first so this can be undone. You will be signed out afterwards.\n\nAre you absolutely sure?')) return;
    setBusy(true); setError(null); setMessage(null);
    try {
      const r = await api<{ message: string; backup: string }>('/backup/factory-reset', { method: 'POST', body: JSON.stringify({ confirm: 'RESET' }) });
      setResetConfirm('');
      setMessage(`${r.message} A safety backup was saved as ${r.backup}. Signing out…`);
      setTimeout(() => { void logout().catch(() => undefined).finally(() => window.location.reload()); }, 1800);
    } catch (e) { setError((e as Error).message); setBusy(false); }
  }

  return <div className="card"><h3>Backup &amp; Restore</h3>
    <p>Backups are ZIP archives that include the SQLite database, uploads, evidence, config, and a backup-manifest.json. They are stored on the server at <code>{location || 'the backups folder'}</code>. Use <strong>Download</strong> to keep a copy anywhere, and restore from an existing backup or from a ZIP file on your computer.</p>

    {error && <p className="error" role="alert">{error}</p>}
    {message && <p className="hint" role="status">{message}</p>}

    <div className="form-actions">
      <button onClick={createBackup} disabled={busy}>{busy ? 'Working…' : 'Create backup (ZIP)'}</button>
    </div>

    <h4>Available backups</h4>
    {backups.length === 0
      ? <p className="hint">No backups yet. Create one above.</p>
      : <table className="table"><thead><tr><th>File</th><th>Size</th><th>Created</th><th>Source</th><th>Actions</th></tr></thead><tbody>
          {backups.map(b => <tr key={b.fileName}>
            <td>{b.fileName}</td>
            <td>{formatBytes(b.sizeBytes)}</td>
            <td>{new Date(b.createdAt).toLocaleString()}</td>
            <td>{b.source === 'system' ? 'This system' : 'External'}</td>
            <td>
              <button className="secondary" onClick={() => download(b)} disabled={busy}>Download</button>{' '}
              <button onClick={() => restoreExisting(b)} disabled={busy}>Restore</button>
            </td>
          </tr>)}
        </tbody></table>}

    <h4>Restore from a ZIP file</h4>
    <p className="hint">Select a backup ZIP saved on your computer (for example one you downloaded earlier) and restore it.</p>
    <div className="form-actions">
      <input ref={fileRef} type="file" accept=".zip,application/zip" onChange={e => setRestoreFile(e.target.files?.[0] ?? null)} />
      <button onClick={restoreFromUpload} disabled={busy || !restoreFile}>{busy ? 'Working…' : 'Restore from selected ZIP'}</button>
    </div>

    {isAdmin && <>
      <hr />
      <h4 style={{ color: 'var(--danger)' }}>Factory reset</h4>
      <p className="hint">Permanently erase <strong>all data</strong> — database, uploads, evidence and configuration — and return the system to first-time setup. A full backup is created automatically first so this can be undone, and existing backups are kept. Only a System Administrator can do this.</p>
      <p className="hint">To proceed, type <code>RESET</code> below and then confirm.</p>
      <div className="form-actions">
        <input
          type="text"
          value={resetConfirm}
          onChange={e => setResetConfirm(e.target.value)}
          placeholder="Type RESET to confirm"
          aria-label="Type RESET to confirm factory reset"
          autoComplete="off"
        />
        <button className="danger" onClick={factoryReset} disabled={busy || resetConfirm !== 'RESET'}>{busy ? 'Working…' : 'Reset to factory settings'}</button>
      </div>
    </>}
  </div>;
}

export function Devices(){
  const [devices,setDevices]=useState<Device[]>([]);
  const load=()=>api<Device[]>('/devices').then(setDevices);
  useEffect(()=>{void load()},[]);

  async function submit(e:FormEvent<HTMLFormElement>){
    e.preventDefault();
    const fd=new FormData(e.currentTarget);
    await api('/devices/request-pairing',{method:'POST',body:JSON.stringify({name:fd.get('name'),type:fd.get('type')})});
    e.currentTarget.reset();
    load();
  }

  async function deviceAction(deviceId:number,action:'approve'|'revoke'|'block'){
    await api(`/devices/${deviceId}/${action}`,{method:'POST'});
    load();
  }

  return <div className="card"><h3>Device Access / Pairing</h3><p>Foundation for future desktop LAN clients and mobile LAN clients. Only the host directly accesses SQLite.</p>
    <form className="form" onSubmit={submit}>
      <label>Device name<input name="name" required/></label>
      <label>Type<select name="type"><option>desktop</option><option>mobile</option></select></label>
      <button>Request pairing code</button>
    </form>
    <table className="table"><thead><tr><th>Name</th><th>Type</th><th>Status</th><th>Code</th><th>Actions</th></tr></thead><tbody>{devices.map(d=><tr key={d.id}><td>{d.name}</td><td>{d.type}</td><td>{d.status}</td><td>{d.device_code}</td><td><button onClick={()=>deviceAction(d.id,'approve')} disabled={d.status==='approved'}>Approve</button> <button onClick={()=>deviceAction(d.id,'revoke')} disabled={d.status==='revoked'}>Revoke</button> <button onClick={()=>deviceAction(d.id,'block')} disabled={d.status==='blocked'}>Block</button></td></tr>)}</tbody></table>
  </div>;
}

// ---------------------------------------------------------------------------
// People & Access  (merged module: everything about staff, users, positions,
// the organogram, the permission matrix, and staff Excel import/export)
// ---------------------------------------------------------------------------
const PEOPLE_TABS = ['Register New Staff', 'Users & Access', 'Positions & Organogram', 'Permission Matrix', 'Import / Export'] as const;
type PeopleTab = typeof PEOPLE_TABS[number];

export function PeopleAccess() {
  const [tab, setTab] = useState<PeopleTab>('Register New Staff');
  return <div className="settings-module">
    <div className="settings-module-head">
      <h2>People &amp; Access</h2>
      <p>One place for everyone who works in the laboratory: register staff, manage login accounts, the positions &amp; organogram, the authorization matrix, and bulk import/export of the staff register.</p>
    </div>
    <div className="tabs">{PEOPLE_TABS.map(t => <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>{t}</button>)}</div>
    <div className="people-tab-body">
      {tab === 'Register New Staff' && <RegisterStaff />}
      {tab === 'Users & Access' && <UsersAccess />}
      {tab === 'Positions & Organogram' && <Positions />}
      {tab === 'Permission Matrix' && <PermissionMatrix />}
      {tab === 'Import / Export' && <StaffImportExport />}
    </div>
  </div>;
}

// Staff register Excel import / export.
function StaffImportExport() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ created: number; updated: number; skipped: number; errors: string[] } | null>(null);
  const [file, setFile] = useState<File | null>(null);

  async function download(path: string, fallback: string) {
    setError(null);
    try {
      const token = getToken();
      const res = await fetch(`${API_BASE}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : undefined });
      if (!res.ok) throw new Error((await res.json().catch(() => ({ error: res.statusText }))).error ?? res.statusText);
      const blob = await res.blob();
      const m = (res.headers.get('Content-Disposition') || '').match(/filename="?([^"]+)"?/);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = m ? m[1] : fallback;
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    } catch (e) { setError((e as Error).message); }
  }

  async function upload(e: FormEvent) {
    e.preventDefault(); setError(null); setResult(null);
    if (!file) { setError('Choose a .xlsx file first.'); return; }
    setBusy(true);
    try {
      const fd = new FormData(); fd.append('file', file);
      const token = getToken();
      const res = await fetch(`${API_BASE}/staff/import`, { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : undefined, body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? res.statusText);
      setResult(data); setFile(null);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  return <div className="grid cols-2">
    <div className="card">
      <h3>Master Personnel Register — Export</h3>
      <p>Download the <strong>Master Personnel Register</strong> workbook. It carries every personnel field — Staff ID, full name parts and initials, date of birth, gender, designation and position, professional regulator, licence and qualifications, unit, personnel category, appointment type and date, years of experience, national ID, emergency contact, phone, email and file location. Use the blank template to prepare a bulk upload, or export the current register.</p>
      <div className="quick-actions" style={{ marginTop: 8 }}>
        <button type="button" onClick={() => download('/staff/template', 'Staff_Register_Template.xlsx')}>Download blank template</button>
        <button type="button" className="secondary" onClick={() => download('/staff/export', 'Master_Personnel_Register.xlsx')}>Export current register</button>
      </div>
    </div>
    <div className="card">
      <h3>Master Personnel Register — Import</h3>
      <p>Upload a completed Master Personnel Register workbook. Rows are matched by <strong>Staff ID</strong> — existing records are updated, new ones are created. Every column maps to its field, the <strong>Unit</strong> links to the matching section, and the <strong>Position</strong> is created in the organogram and assigned automatically.</p>
      {error && <div className="error">{error}</div>}
      <form className="form" onSubmit={upload}>
        <label>Excel file (.xlsx)<input type="file" accept=".xlsx,.xls" onChange={e => setFile(e.target.files?.[0] ?? null)} /></label>
        <button type="submit" disabled={busy}>{busy ? 'Importing…' : 'Import staff'}</button>
      </form>
      {result && <div className="notice-ok">Import complete — {result.created} created, {result.updated} updated, {result.skipped} skipped{result.errors.length ? `, ${result.errors.length} error(s)` : ''}.{result.errors.length > 0 && <ul className="link-list">{result.errors.slice(0, 8).map((er, i) => <li key={i}>{er}</li>)}</ul>}</div>}
    </div>
  </div>;
}

// ---------------------------------------------------------------------------
// My Laboratory  (laboratory identity / profile + departments)
// ---------------------------------------------------------------------------
// Upload a file to the shared file store; returns the numeric file id.
async function uploadLabFile(file: File): Promise<number> {
  const fd = new FormData();
  fd.append('file', file);
  const token = getToken();
  const res = await fetch(`${API_BASE}/files`, { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : undefined, body: fd });
  if (!res.ok) throw new Error((await res.json().catch(() => ({ error: res.statusText }))).error ?? res.statusText);
  return Number((await res.json()).id);
}

async function openLabFile(fileId: number) {
  const token = getToken();
  const res = await fetch(`${API_BASE}/files/${fileId}/raw`, { headers: token ? { Authorization: `Bearer ${token}` } : undefined });
  if (!res.ok) return;
  const url = URL.createObjectURL(await res.blob());
  window.open(url, '_blank');
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

const LAB_TABS = ['Identity & Legal', 'Mission & Vision', 'Core Documents', 'Quality Policy & Objectives', 'Annual Objectives', 'Departments', 'Equipment Numbering'] as const;
type LabTab = typeof LAB_TABS[number];

// ---------------------------------------------------------------------------
// Equipment identifier pattern (laboratory configuration)
// ---------------------------------------------------------------------------
function renderPatternPreview(pattern: EquipmentPattern, year: number, seq: number): string {
  return pattern.segments.map(seg => {
    if (seg.type === 'text') return seg.value;
    if (seg.type === 'year') return seg.digits === 2 ? String(year).slice(-2) : String(year);
    return String(seq).padStart(seg.padding, '0');
  }).join(pattern.separator);
}

function EquipmentNumbering() {
  const [pattern, setPattern] = useState<EquipmentPattern>({ separator: '/', segments: [{ type: 'text', value: 'EQP' }, { type: 'year', digits: 4 }, { type: 'sequence', padding: 4 }] });
  const [serverPreview, setServerPreview] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ pattern: EquipmentPattern; preview: string }>('/equipment/config/id-pattern')
      .then(r => { if (r.pattern?.segments?.length) setPattern(r.pattern); setServerPreview(r.preview); })
      .catch(() => undefined);
  }, []);

  function update(next: EquipmentPattern) { setPattern(next); setSuccess(null); }
  function setSeg(i: number, seg: EquipmentSegment) { update({ ...pattern, segments: pattern.segments.map((s, idx) => idx === i ? seg : s) }); }
  function addSeg(type: EquipmentSegment['type']) {
    const seg: EquipmentSegment = type === 'text' ? { type: 'text', value: '' } : type === 'year' ? { type: 'year', digits: 4 } : { type: 'sequence', padding: 4 };
    update({ ...pattern, segments: [...pattern.segments, seg] });
  }
  function removeSeg(i: number) { update({ ...pattern, segments: pattern.segments.filter((_, idx) => idx !== i) }); }
  function moveSeg(i: number, dir: -1 | 1) {
    const j = i + dir; if (j < 0 || j >= pattern.segments.length) return;
    const segs = [...pattern.segments]; [segs[i], segs[j]] = [segs[j], segs[i]]; update({ ...pattern, segments: segs });
  }

  const hasSequence = pattern.segments.some(s => s.type === 'sequence');
  const livePreview = renderPatternPreview(pattern, new Date().getFullYear(), 1);

  async function save() {
    setError(null); setSuccess(null);
    if (!hasSequence) { setError('The pattern must include a Sequence segment so every identifier stays unique.'); return; }
    if (pattern.segments.some(s => s.type === 'text' && !s.value.trim())) { setError('Give every Text segment a value, or remove it.'); return; }
    setBusy(true);
    try {
      const r = await api<{ pattern: EquipmentPattern; preview: string }>('/equipment/config/id-pattern', { method: 'PUT', body: JSON.stringify({ pattern }) });
      setPattern(r.pattern); setServerPreview(r.preview); setSuccess('Saved. New equipment will use this pattern.');
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  return <div className="card">
    <h3>Equipment identifier</h3>
    <p>Define how each equipment's unique identifier is built. Add segments in order, choose a separator, and place the year wherever you like. The <strong>Sequence</strong> counter restarts at 1 each calendar year. Every new equipment gets the next identifier automatically; it can still be overridden on an individual equipment profile.</p>
    {error && <div className="error">{error}</div>}
    {success && <div className="notice-ok">{success}</div>}

    <div className="form-grid" style={{ maxWidth: 320 }}>
      <label>Separator<input value={pattern.separator} maxLength={3} onChange={e => update({ ...pattern, separator: e.target.value })} placeholder="/" /></label>
    </div>

    <table className="data-table" style={{ marginTop: 12 }}>
      <thead><tr><th>#</th><th>Segment type</th><th>Value</th><th>Order</th><th></th></tr></thead>
      <tbody>
        {pattern.segments.map((seg, i) => <tr key={i}>
          <td>{i + 1}</td>
          <td>
            <select value={seg.type} onChange={e => {
              const t = e.target.value as EquipmentSegment['type'];
              setSeg(i, t === 'text' ? { type: 'text', value: seg.type === 'text' ? seg.value : '' } : t === 'year' ? { type: 'year', digits: 4 } : { type: 'sequence', padding: 4 });
            }}>
              <option value="text">Text</option><option value="year">Year</option><option value="sequence">Sequence</option>
            </select>
          </td>
          <td>
            {seg.type === 'text' && <input value={seg.value} onChange={e => setSeg(i, { type: 'text', value: e.target.value })} placeholder="e.g. SECH" style={{ maxWidth: 160 }} />}
            {seg.type === 'year' && <select value={seg.digits} onChange={e => setSeg(i, { type: 'year', digits: Number(e.target.value) === 2 ? 2 : 4 })}><option value={4}>4-digit (2026)</option><option value={2}>2-digit (26)</option></select>}
            {seg.type === 'sequence' && <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>Padding <input type="number" min={1} max={8} value={seg.padding} onChange={e => setSeg(i, { type: 'sequence', padding: Math.min(8, Math.max(1, Number(e.target.value) || 1)) })} style={{ width: 64 }} /></label>}
          </td>
          <td>
            <button type="button" className="secondary" disabled={i === 0} onClick={() => moveSeg(i, -1)} title="Move up">↑</button>{' '}
            <button type="button" className="secondary" disabled={i === pattern.segments.length - 1} onClick={() => moveSeg(i, 1)} title="Move down">↓</button>
          </td>
          <td><button type="button" className="secondary" onClick={() => removeSeg(i)}>Remove</button></td>
        </tr>)}
      </tbody>
    </table>
    <div className="quick-actions" style={{ marginTop: 8 }}>
      <button type="button" className="secondary" onClick={() => addSeg('text')}>+ Text</button>
      <button type="button" className="secondary" onClick={() => addSeg('year')}>+ Year</button>
      <button type="button" className="secondary" onClick={() => addSeg('sequence')}>+ Sequence</button>
    </div>

    <div className="notice" style={{ marginTop: 14 }}>
      Preview (first item this year): <strong style={{ fontFamily: 'ui-monospace, monospace' }}>{livePreview || '—'}</strong>
      {serverPreview && <> · next actual identifier: <strong style={{ fontFamily: 'ui-monospace, monospace' }}>{serverPreview}</strong></>}
    </div>
    <div style={{ marginTop: 12 }}><button type="button" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save pattern'}</button></div>
  </div>;
}

// A small register that uploads and lists supporting documents for one category
// (legal identity or the quality manual). Editing is confined to Settings.
function LabDocuments({ category, docTypes, onChanged }: { category: string; docTypes: string[]; onChanged?: () => void }) {
  const blank = { docType: docTypes[0] ?? '', title: '', referenceNumber: '', issuingAuthority: '', issueDate: '', expiryDate: '', version: '', effectiveDate: '', notes: '' };
  const [rows, setRows] = useState<LaboratoryDocument[]>([]);
  const [form, setForm] = useState(blank);
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const isManual = category === 'quality_manual';

  function load() { api<LaboratoryDocument[]>(`/laboratory-documents?category=${category}`).then(setRows).catch(() => setRows([])); }
  useEffect(() => { load(); }, [category]);

  async function add(e: FormEvent) {
    e.preventDefault(); setError(null); setBusy(true);
    try {
      let fileId: number | undefined;
      if (file) fileId = await uploadLabFile(file);
      await api('/laboratory-documents', { method: 'POST', body: JSON.stringify({ category, ...form, fileId }) });
      setForm(blank); setFile(null); if (fileRef.current) fileRef.current.value = '';
      load(); onChanged?.();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  async function remove(id: number) {
    if (!confirm('Remove this document entry? The uploaded file remains in the file store.')) return;
    try { await api(`/laboratory-documents/${id}`, { method: 'DELETE' }); load(); onChanged?.(); }
    catch (err) { setError((err as Error).message); }
  }

  return <>
    {error && <div className="error">{error}</div>}
    <form className="form" onSubmit={add}>
      <div className="form-grid">
        <label>Document type<select value={form.docType} onChange={e => setForm({ ...form, docType: e.target.value })}>{docTypes.map(t => <option key={t} value={t}>{t}</option>)}</select></label>
        <label>Title<input value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} required placeholder={isManual ? 'e.g. Laboratory Quality Manual' : 'e.g. Operating licence 2026'} /></label>
        <label>Reference no<input value={form.referenceNumber} onChange={e => setForm({ ...form, referenceNumber: e.target.value })} /></label>
        {!isManual && <label>Issuing authority<input value={form.issuingAuthority} onChange={e => setForm({ ...form, issuingAuthority: e.target.value })} /></label>}
        {isManual && <label>Version<input value={form.version} onChange={e => setForm({ ...form, version: e.target.value })} placeholder="e.g. v3.0" /></label>}
        {isManual
          ? <label>Effective date<input type="date" value={form.effectiveDate} onChange={e => setForm({ ...form, effectiveDate: e.target.value })} /></label>
          : <label>Issue date<input type="date" value={form.issueDate} onChange={e => setForm({ ...form, issueDate: e.target.value })} /></label>}
        {!isManual && <label>Expiry date<input type="date" value={form.expiryDate} onChange={e => setForm({ ...form, expiryDate: e.target.value })} /></label>}
        <label>Attachment<input ref={fileRef} type="file" onChange={e => setFile(e.target.files?.[0] ?? null)} /></label>
      </div>
      <label>Notes<textarea value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} /></label>
      <button disabled={busy}>{busy ? 'Uploading…' : 'Add document'}</button>
    </form>
    <table className="data-table"><thead><tr><th>Type</th><th>Title</th><th>Ref</th><th>{isManual ? 'Version' : 'Issuer'}</th><th>{isManual ? 'Effective' : 'Issued'}</th><th>{isManual ? '' : 'Expiry'}</th><th>File</th><th></th></tr></thead><tbody>
      {rows.map(r => <tr key={r.id}>
        <td>{r.doc_type || '—'}</td><td>{r.title}</td><td>{r.reference_number || '—'}</td>
        <td>{isManual ? (r.version || '—') : (r.issuing_authority || '—')}</td>
        <td>{(isManual ? r.effective_date : r.issue_date) || '—'}</td>
        <td>{isManual ? '' : (r.expiry_date || '—')}</td>
        <td>{r.file_id ? <button type="button" className="secondary" onClick={() => openLabFile(r.file_id!)}>Open {r.file_name ? `(${r.file_name})` : ''}</button> : '—'}</td>
        <td><button type="button" className="secondary" onClick={() => remove(r.id)}>Remove</button></td>
      </tr>)}
      {rows.length === 0 && <tr><td colSpan={8} className="hint">No documents uploaded yet.</td></tr>}
    </tbody></table>
  </>;
}

// Core documents are registered through the full Documents & Records workflow so
// they carry complete controlled-document metadata. This tab shows their status
// and launches the New Document form (pre-set to the right type).
const CORE_DOC_LAUNCH = [
  { label: 'Quality Manual', type: 'Quality Manual' },
  { label: 'Laboratory Handbook', type: 'Handbook' },
  { label: 'Safety Manual', type: 'Safety Manual' },
];
function CoreDocumentsTab({ qualityManualSummary, onSummaryChange, onSaveSummary }: { qualityManualSummary: string; onSummaryChange: (v: string) => void; onSaveSummary: () => void }) {
  const nav = useNavigate();
  const [docs, setDocs] = useState<Array<{ id: number; document_code?: string; title: string; document_type?: string; status: string; current_version_number?: string }>>([]);
  useEffect(() => { api<typeof docs>('/documents').then(setDocs).catch(() => setDocs([])); }, []);
  return <div>
    <div className="card">
      <h3>Core laboratory documents</h3>
      <p>Register your three foundational controlled documents — <strong>Quality Manual</strong>, <strong>Laboratory Handbook</strong> and <strong>Safety Manual</strong> — through Documents &amp; Records so each carries full controlled-document detail (owner, section, review schedule, versions, attestations). They then appear in the register and on the Laboratory Profile.</p>
      <label className="form"><span>Quality manual summary</span><textarea value={qualityManualSummary} onChange={e => onSummaryChange(e.target.value)} placeholder="Scope, structure and references of the quality manual." /></label>
      <div style={{ marginTop: 8 }}><button type="button" onClick={onSaveSummary}>Save summary</button></div>
    </div>
    {CORE_DOC_LAUNCH.map(ct => {
      const existing = docs.filter(d => (d.document_type || '') === ct.type && d.status !== 'obsolete');
      return <div className="card" key={ct.type} style={{ marginTop: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <h3 style={{ margin: 0 }}>{ct.label}</h3>
          <button type="button" onClick={() => nav(`/documents?new=${encodeURIComponent(ct.type)}`)}>{existing.length ? 'Register another' : 'Register in Documents & Records'}</button>
        </div>
        {existing.length === 0
          ? <p className="hint" style={{ marginBottom: 0 }}>Not registered yet.</p>
          : <table className="data-table" style={{ marginTop: 10 }}><thead><tr><th>Code</th><th>Title</th><th>Version</th><th>Status</th><th></th></tr></thead><tbody>
              {existing.map(d => <tr key={d.id}><td>{d.document_code || '—'}</td><td>{d.title}</td><td>{d.current_version_number || '—'}</td><td><span className="badge">{d.status}</span></td><td><Link className="hint" to="/documents">Open in Documents &amp; Records</Link></td></tr>)}
            </tbody></table>}
      </div>;
    })}
  </div>;
}

export function MyLaboratory() {
  const blank = { facilityName: '', shortName: '', motto: '', registrationNumber: '', address: '', city: '', country: '', phone: '', email: '', website: '', accreditationBody: '', accreditationNumber: '', accreditationStatus: '', legalStatus: '', legalIdentityNotes: '', qualityPolicy: '', qualityManualSummary: '', mission: '', vision: '' };
  const [tab, setTab] = useState<LabTab>('Identity & Legal');
  const [form, setForm] = useState(blank);
  const [registrationComplete, setRegistrationComplete] = useState(false);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [policies, setPolicies] = useState<QualityPolicy[]>([]);
  const [objectives, setObjectives] = useState<QualityObjective[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [policyForm, setPolicyForm] = useState({ title: '', policyStatement: '', referenceNote: '' });
  const thisYear = new Date().getFullYear();
  const [objForm, setObjForm] = useState({ objective: '', target: '', measure: '', responsibleStaffId: '', referenceNote: '' });
  const [annualForm, setAnnualForm] = useState({ objective: '', target: '', measure: '', year: String(thisYear), responsibleStaffId: '', status: 'active' });

  function loadPolicies() { api<QualityPolicy[]>('/quality-policies').then(setPolicies).catch(() => setPolicies([])); }
  function loadObjectives() { api<QualityObjective[]>('/quality-objectives').then(setObjectives).catch(() => setObjectives([])); }
  function load() {
    api<Record<string, unknown> | null>('/laboratory-profile').then(p => {
      if (!p) return;
      setForm({
        facilityName: String(p.facility_name ?? ''), shortName: String(p.short_name ?? ''), motto: String(p.motto ?? ''),
        registrationNumber: String(p.registration_number ?? ''), address: String(p.address ?? ''), city: String(p.city ?? ''),
        country: String(p.country ?? ''), phone: String(p.phone ?? ''), email: String(p.email ?? ''), website: String(p.website ?? ''),
        accreditationBody: String(p.accreditation_body ?? ''), accreditationNumber: String(p.accreditation_number ?? ''), accreditationStatus: String(p.accreditation_status ?? ''),
        legalStatus: String(p.legal_status ?? ''), legalIdentityNotes: String(p.legal_identity_notes ?? ''),
        qualityPolicy: String(p.quality_policy ?? ''), qualityManualSummary: String(p.quality_manual_summary ?? ''),
        mission: String(p.mission ?? ''), vision: String(p.vision ?? ''),
      });
      setRegistrationComplete(Number(p.registration_complete ?? 0) === 1);
    }).catch(() => undefined);
    api<Department[]>('/departments').then(setDepartments).catch(() => setDepartments([]));
    api<Staff[]>('/staff').then(setStaff).catch(() => setStaff([]));
    loadPolicies(); loadObjectives();
  }
  useEffect(() => { load(); }, []);

  async function saveProfile(extra: Record<string, unknown> = {}) {
    setError(null); setSuccess(null);
    try { await api('/laboratory-profile', { method: 'PUT', body: JSON.stringify({ ...form, ...extra }) }); setSuccess('Saved.'); }
    catch (err) { setError((err as Error).message); }
  }
  async function completeRegistration() {
    setError(null); setSuccess(null);
    try { await api('/laboratory-profile', { method: 'PUT', body: JSON.stringify({ ...form, registrationComplete: true }) }); setRegistrationComplete(true); setSuccess('Laboratory registration marked complete.'); }
    catch (err) { setError((err as Error).message); }
  }
  async function addDepartment(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setError(null);
    const fd = new FormData(e.currentTarget);
    try { await api('/departments', { method: 'POST', body: JSON.stringify({ name: fd.get('name') }) }); e.currentTarget.reset(); load(); }
    catch (err) { setError((err as Error).message); }
  }
  async function toggleDepartment(d: Department) {
    try { await api(`/departments/${d.id}`, { method: 'PUT', body: JSON.stringify({ isActive: d.is_active ? false : true }) }); load(); }
    catch (err) { setError((err as Error).message); }
  }
  async function addPolicy(e: FormEvent) {
    e.preventDefault(); setError(null);
    try { await api('/quality-policies', { method: 'POST', body: JSON.stringify(policyForm) }); setPolicyForm({ title: '', policyStatement: '', referenceNote: '' }); loadPolicies(); }
    catch (err) { setError((err as Error).message); }
  }
  async function removePolicy(id: number) { if (!confirm('Delete this policy?')) return; try { await api(`/quality-policies/${id}`, { method: 'DELETE' }); loadPolicies(); } catch (err) { setError((err as Error).message); } }
  async function addObjective(e: FormEvent) {
    e.preventDefault(); setError(null);
    try { await api('/quality-objectives', { method: 'POST', body: JSON.stringify({ ...objForm, year: null }) }); setObjForm({ objective: '', target: '', measure: '', responsibleStaffId: '', referenceNote: '' }); loadObjectives(); }
    catch (err) { setError((err as Error).message); }
  }
  async function addAnnual(e: FormEvent) {
    e.preventDefault(); setError(null);
    try { await api('/quality-objectives', { method: 'POST', body: JSON.stringify(annualForm) }); setAnnualForm({ objective: '', target: '', measure: '', year: String(thisYear), responsibleStaffId: '', status: 'active' }); loadObjectives(); }
    catch (err) { setError((err as Error).message); }
  }
  async function removeObjective(id: number) { if (!confirm('Delete this objective?')) return; try { await api(`/quality-objectives/${id}`, { method: 'DELETE' }); loadObjectives(); } catch (err) { setError((err as Error).message); } }

  const standingObjectives = objectives.filter(o => o.year === null || o.year === undefined);
  const annualObjectives = objectives.filter(o => o.year != null);
  const years = Array.from(new Set(annualObjectives.map(o => o.year as number))).sort((a, b) => b - a);

  return <div>
    <div className="card" style={{ marginBottom: 16 }}>
      <h3>My Laboratory</h3>
      <p>Register and configure your laboratory here. Everything on this page is the single source of truth for the laboratory's legal identity, quality manual, quality policy and objectives — these are shown read-only elsewhere in the system and can only be changed here.</p>
      <div className="tabs">{LAB_TABS.map(t => <button key={t} type="button" className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>{t}</button>)}</div>
      {error && <div className="error">{error}</div>}
      {success && <div className="notice-ok">{success}</div>}
      {!registrationComplete && <div className="notice" style={{ marginTop: 10 }}>Laboratory registration is not yet marked complete. Fill in the identity, quality manual, and quality policy &amp; objectives, then use <strong>Mark registration complete</strong> below.</div>}
    </div>

    {tab === 'Identity & Legal' && <div className="grid cols-2">
      <div className="card">
        <h3>Identity &amp; legal status</h3>
        <p>Your laboratory's legal identity and accreditation details, so the software can be used by any facility.</p>
        <form className="form" onSubmit={e => { e.preventDefault(); saveProfile(); }}>
          <fieldset className="reg-section"><legend>Identity</legend>
            <div className="form-grid">
              <label>Facility name<input value={form.facilityName} onChange={e => setForm({ ...form, facilityName: e.target.value })} required /></label>
              <label>Short name<input value={form.shortName} onChange={e => setForm({ ...form, shortName: e.target.value })} /></label>
              <label>Motto / tagline<input value={form.motto} onChange={e => setForm({ ...form, motto: e.target.value })} /></label>
              <label>Registration no<input value={form.registrationNumber} onChange={e => setForm({ ...form, registrationNumber: e.target.value })} /></label>
              <label>Legal status / entity type<input value={form.legalStatus} onChange={e => setForm({ ...form, legalStatus: e.target.value })} placeholder="e.g. faith-based hospital laboratory, private company" /></label>
            </div>
          </fieldset>
          <fieldset className="reg-section"><legend>Contact</legend>
            <div className="form-grid">
              <label>Address<input value={form.address} onChange={e => setForm({ ...form, address: e.target.value })} /></label>
              <label>City / town<input value={form.city} onChange={e => setForm({ ...form, city: e.target.value })} /></label>
              <label>Country<input value={form.country} onChange={e => setForm({ ...form, country: e.target.value })} /></label>
              <label>Phone<input value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} /></label>
              <label>Email<input type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} /></label>
              <label>Website<input value={form.website} onChange={e => setForm({ ...form, website: e.target.value })} /></label>
            </div>
          </fieldset>
          <fieldset className="reg-section"><legend>Accreditation</legend>
            <div className="form-grid">
              <label>Accreditation body<input value={form.accreditationBody} onChange={e => setForm({ ...form, accreditationBody: e.target.value })} placeholder="e.g. your national accreditation body" /></label>
              <label>Accreditation no<input value={form.accreditationNumber} onChange={e => setForm({ ...form, accreditationNumber: e.target.value })} /></label>
              <label>Status<select value={form.accreditationStatus} onChange={e => setForm({ ...form, accreditationStatus: e.target.value })}><option value="">—</option><option>Accredited</option><option>In progress</option><option>Not accredited</option><option>Suspended</option></select></label>
            </div>
          </fieldset>
          <label>Legal identity notes<textarea value={form.legalIdentityNotes} onChange={e => setForm({ ...form, legalIdentityNotes: e.target.value })} placeholder="Ownership, governing body, licences held, etc." /></label>
          <button type="submit">Save identity</button>
        </form>
      </div>
      <div className="card">
        <h3>Legal identity documents</h3>
        <p>Upload documentation that establishes the laboratory's legal identity — certificates, licences, registrations.</p>
        <LabDocuments category="legal_identity" docTypes={['Operating licence', 'Certificate of incorporation', 'Business registration', 'Tax registration', 'Ownership / governance', 'Other']} />
      </div>
    </div>}

    {tab === 'Mission & Vision' && <div className="card">
      <h3>Mission &amp; vision</h3>
      <p>The laboratory's mission and vision statements. These appear on the Laboratory Profile in Documents &amp; Records.</p>
      <form className="form" onSubmit={e => { e.preventDefault(); saveProfile(); }}>
        <label>Mission<textarea rows={3} value={form.mission} onChange={e => setForm({ ...form, mission: e.target.value })} placeholder="Why the laboratory exists and who it serves." /></label>
        <label>Vision<textarea rows={3} value={form.vision} onChange={e => setForm({ ...form, vision: e.target.value })} placeholder="What the laboratory aspires to become." /></label>
        <label>Motto / tagline<input value={form.motto} onChange={e => setForm({ ...form, motto: e.target.value })} /></label>
        <button type="submit">Save mission &amp; vision</button>
      </form>
    </div>}

    {tab === 'Core Documents' && <CoreDocumentsTab qualityManualSummary={form.qualityManualSummary} onSummaryChange={v => setForm({ ...form, qualityManualSummary: v })} onSaveSummary={() => saveProfile()} />}

    {tab === 'Quality Policy & Objectives' && <div className="grid cols-2">
      <div className="card">
        <h3>Quality policy</h3>
        <p>The laboratory's overarching quality policy statement, established to fulfil the requirements of ISO 15189:2022.</p>
        <form className="form" onSubmit={e => { e.preventDefault(); saveProfile(); }}>
          <label>Quality policy statement<textarea rows={6} value={form.qualityPolicy} onChange={e => setForm({ ...form, qualityPolicy: e.target.value })} placeholder="Management's commitment to quality, good professional practice, and continual improvement…" /></label>
          <button type="submit">Save quality policy</button>
        </form>
        <h4 style={{ marginTop: 18 }}>Supporting policies</h4>
        <p className="hint">Add specific policies that support the quality policy.</p>
        <form className="form" onSubmit={addPolicy}>
          <label>Title<input value={policyForm.title} onChange={e => setPolicyForm({ ...policyForm, title: e.target.value })} required /></label>
          <label>Policy statement<textarea value={policyForm.policyStatement} onChange={e => setPolicyForm({ ...policyForm, policyStatement: e.target.value })} required /></label>
          <label>ISO 15189:2022 relationship (optional)<input value={policyForm.referenceNote} onChange={e => setPolicyForm({ ...policyForm, referenceNote: e.target.value })} placeholder="How this policy relates to the standard" /></label>
          <button>Add policy</button>
        </form>
        <table className="data-table"><thead><tr><th>Title</th><th>Statement</th><th></th></tr></thead><tbody>
          {policies.map(p => <tr key={p.id}><td>{p.title}</td><td>{p.policy_statement}{p.reference_note ? <><br /><span className="hint">{p.reference_note}</span></> : ''}</td><td><button type="button" className="secondary" onClick={() => removePolicy(p.id)}>Remove</button></td></tr>)}
          {policies.length === 0 && <tr><td colSpan={3} className="hint">No supporting policies yet.</td></tr>}
        </tbody></table>
      </div>
      <div className="card">
        <h3>Standing quality objectives</h3>
        <p>Continuous quality objectives, in relation to ISO 15189:2022. Year-specific targets are set under <strong>Annual Objectives</strong>.</p>
        <form className="form" onSubmit={addObjective}>
          <label>Objective<textarea value={objForm.objective} onChange={e => setObjForm({ ...objForm, objective: e.target.value })} required /></label>
          <div className="form-grid">
            <label>Target<input value={objForm.target} onChange={e => setObjForm({ ...objForm, target: e.target.value })} placeholder="e.g. ≥ 95%" /></label>
            <label>Measure / indicator<input value={objForm.measure} onChange={e => setObjForm({ ...objForm, measure: e.target.value })} /></label>
            <label>Responsible<select value={objForm.responsibleStaffId} onChange={e => setObjForm({ ...objForm, responsibleStaffId: e.target.value })}><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
          </div>
          <label>ISO 15189:2022 relationship (optional)<input value={objForm.referenceNote} onChange={e => setObjForm({ ...objForm, referenceNote: e.target.value })} /></label>
          <button>Add objective</button>
        </form>
        <table className="data-table"><thead><tr><th>Objective</th><th>Target</th><th>Measure</th><th>Owner</th><th></th></tr></thead><tbody>
          {standingObjectives.map(o => <tr key={o.id}><td>{o.objective}{o.reference_note ? <><br /><span className="hint">{o.reference_note}</span></> : ''}</td><td>{o.target || '—'}</td><td>{o.measure || '—'}</td><td>{o.responsible_name || '—'}</td><td><button type="button" className="secondary" onClick={() => removeObjective(o.id)}>Remove</button></td></tr>)}
          {standingObjectives.length === 0 && <tr><td colSpan={5} className="hint">No standing objectives yet.</td></tr>}
        </tbody></table>
      </div>
    </div>}

    {tab === 'Annual Objectives' && <div className="card">
      <h3>Annual quality objectives</h3>
      <p>Set measurable objectives for each year. The laboratory is expected to establish objectives every year.</p>
      <form className="form" onSubmit={addAnnual}>
        <div className="form-grid">
          <label>Year<input type="number" min={2000} max={2100} value={annualForm.year} onChange={e => setAnnualForm({ ...annualForm, year: e.target.value })} required /></label>
          <label>Target<input value={annualForm.target} onChange={e => setAnnualForm({ ...annualForm, target: e.target.value })} placeholder="e.g. ≥ 98%" /></label>
          <label>Measure / indicator<input value={annualForm.measure} onChange={e => setAnnualForm({ ...annualForm, measure: e.target.value })} /></label>
          <label>Responsible<select value={annualForm.responsibleStaffId} onChange={e => setAnnualForm({ ...annualForm, responsibleStaffId: e.target.value })}><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
          <label>Status<select value={annualForm.status} onChange={e => setAnnualForm({ ...annualForm, status: e.target.value })}>{['active', 'on_track', 'at_risk', 'achieved', 'not_achieved', 'carried_over'].map(s => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}</select></label>
        </div>
        <label>Objective<textarea value={annualForm.objective} onChange={e => setAnnualForm({ ...annualForm, objective: e.target.value })} required /></label>
        <button>Add annual objective</button>
      </form>
      {years.length === 0 && <p className="hint">No annual objectives yet.</p>}
      {years.map(y => <div key={y} style={{ marginTop: 16 }}>
        <h4>{y}</h4>
        <table className="data-table"><thead><tr><th>Objective</th><th>Target</th><th>Measure</th><th>Owner</th><th>Status</th><th></th></tr></thead><tbody>
          {annualObjectives.filter(o => o.year === y).map(o => <tr key={o.id}><td>{o.objective}</td><td>{o.target || '—'}</td><td>{o.measure || '—'}</td><td>{o.responsible_name || '—'}</td><td><span className="badge">{(o.status || '').replace(/_/g, ' ')}</span></td><td><button type="button" className="secondary" onClick={() => removeObjective(o.id)}>Remove</button></td></tr>)}
        </tbody></table>
      </div>)}
    </div>}

    {tab === 'Departments' && <div className="card">
      <h3>Departments</h3>
      <p>Top-level departments. Sections/units (configured under Section/Unit Configuration) belong to a department.</p>
      <form className="form" onSubmit={addDepartment}>
        <label>New department<input name="name" required placeholder="e.g. Laboratory, Pathology" /></label>
        <button>Add department</button>
      </form>
      <table className="data-table"><thead><tr><th>Name</th><th>Status</th><th></th></tr></thead><tbody>
        {departments.map(d => <tr key={d.id}><td>{d.name}</td><td>{d.is_active ? <span className="badge active">active</span> : <span className="badge inactive">inactive</span>}</td><td><button className="secondary" onClick={() => toggleDepartment(d)}>{d.is_active ? 'Deactivate' : 'Activate'}</button></td></tr>)}
        {departments.length === 0 && <tr><td colSpan={3} className="hint">No departments yet.</td></tr>}
      </tbody></table>
    </div>}

    {tab === 'Equipment Numbering' && <EquipmentNumbering />}

    <div className="card" style={{ marginTop: 16 }}>
      {registrationComplete
        ? <p className="notice-ok">Laboratory registration is complete. You can keep updating any section above at any time.</p>
        : <button onClick={completeRegistration}>Mark registration complete</button>}
    </div>
  </div>;
}

// ---------------------------------------------------------------------------
// Remote Staff Access — provision & manage cloud portal accounts (R7).
// Wires the Settings UI to /api/remote-access/*. Requires the cloud to be
// configured on the Host (SECH_LIMS_CLOUD_URL). Remote permissions are always a
// subset of the staff member's Host permissions.
// ---------------------------------------------------------------------------
export function RemoteStaffAccess() {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [users, setUsers] = useState<RemoteCloudUser[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [form, setForm] = useState({ staffId: '', email: '', role: '', password: '' });
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadUsers = () => api<RemoteCloudUser[]>('/remote-access/users').then(setUsers).catch(e => setError((e as Error).message));
  const load = () => {
    api<{ cloudConfigured: boolean }>('/remote-access/status')
      .then(s => { setConfigured(s.cloudConfigured); if (s.cloudConfigured) loadUsers(); })
      .catch(() => setConfigured(false));
    api<Staff[]>('/staff').then(setStaff).catch(() => setStaff([]));
  };
  useEffect(() => { void load(); }, []);

  const selectedStaff = staff.find(s => String(s.id) === form.staffId);

  function pickStaff(id: string) {
    const s = staff.find(x => String(x.id) === id);
    setForm(f => ({ ...f, staffId: id, email: s?.email ?? f.email, role: s?.roleName ?? f.role }));
  }
  function genPassword() {
    const p = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6).toUpperCase();
    setForm(f => ({ ...f, password: p }));
  }

  async function provision(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setError(null); setMessage(null);
    if (!form.staffId || !form.email || !form.password) { setError('Staff, email and temporary password are required.'); return; }
    if (form.password.length < 8) { setError('Temporary password must be at least 8 characters.'); return; }
    setBusy(true);
    try {
      await api('/remote-access/users', { method: 'POST', body: JSON.stringify({ staffId: Number(form.staffId), email: form.email, fullName: selectedStaff?.fullName, role: form.role, password: form.password }) });
      setMessage(`Remote access created for ${form.email}. Share this temporary password securely (they must change it on first sign-in): ${form.password}`);
      setForm({ staffId: '', email: '', role: '', password: '' });
      load();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function changeStatus(u: RemoteCloudUser, status: 'active' | 'disabled') {
    setError(null); setMessage(null);
    try { await api(`/remote-access/users/${u.id}/status`, { method: 'POST', body: JSON.stringify({ status }) }); loadUsers(); }
    catch (e) { setError((e as Error).message); }
  }
  async function refresh(u: RemoteCloudUser) {
    setError(null); setMessage(null);
    try { await api(`/remote-access/users/${u.id}/refresh`, { method: 'POST' }); setMessage(`Recomputed remote access for ${u.email}.`); }
    catch (e) { setError((e as Error).message); }
  }

  if (configured === null) return <div className="card"><h3>Remote Staff Access</h3><p className="muted">Loading…</p></div>;
  if (!configured) return <div className="card"><h3>Remote Staff Access</h3>
    <p className="hint">The cloud is not configured on this Host. Set <code>SECH_LIMS_CLOUD_URL</code> (and enable Hybrid mode / sync) to provision remote staff portal accounts. See <code>docs/CLOUD_SYNC.md</code>.</p>
  </div>;

  return <div>
    <div className="card">
      <h3>Provision remote access</h3>
      <p className="muted" style={{ fontSize: 13 }}>Create a cloud portal account for a staff member. They sign in at the portal with this email and the temporary password, then set their own. Remote permissions are always a subset of their Host permissions.</p>
      <form className="form" onSubmit={provision}>
        <label>Staff member
          <select value={form.staffId} onChange={e => pickStaff(e.target.value)} required>
            <option value="">Select staff…</option>
            {staff.filter(s => s.isActive).map(s => <option key={s.id} value={s.id}>{s.fullName}{s.username ? '' : ' — no login (limited)'}</option>)}
          </select>
        </label>
        {selectedStaff && !selectedStaff.username && <p className="hint">This staff member has no Host login, so they can sign in but will have no module permissions until a login/role is assigned.</p>}
        <label>Portal email<input type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} required /></label>
        <label>Role label (optional)<input value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value }))} /></label>
        <label>Temporary password
          <span style={{ display: 'flex', gap: 8 }}>
            <input value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} required />
            <button type="button" onClick={genPassword}>Generate</button>
          </span>
        </label>
        <button disabled={busy}>Create remote access</button>
      </form>
      {message && <p className="notice-ok">{message}</p>}
      {error && <p className="error">{error}</p>}
    </div>

    <div className="card">
      <h3>Remote staff accounts</h3>
      {users.length === 0 ? <p className="muted">No remote accounts yet.</p> :
        <table className="data-table"><thead><tr><th>Email</th><th>Staff</th><th>Role</th><th>Status</th><th>Last sign-in</th><th></th></tr></thead><tbody>
          {users.map(u => { const s = staff.find(x => x.id === u.staff_id); return <tr key={u.id}>
            <td>{u.email}</td>
            <td>{u.full_name ?? s?.fullName ?? `#${u.staff_id}`}</td>
            <td>{u.role ?? ''}</td>
            <td>{u.status === 'active' ? 'Active' : 'Disabled'}</td>
            <td>{u.last_login_at ? new Date(u.last_login_at).toLocaleString() : '—'}</td>
            <td style={{ whiteSpace: 'nowrap' }}>
              {u.status === 'active'
                ? <button onClick={() => changeStatus(u, 'disabled')}>Disable</button>
                : <button onClick={() => changeStatus(u, 'active')}>Enable</button>}
              {' '}<button onClick={() => refresh(u)}>Refresh access</button>
            </td>
          </tr>; })}
        </tbody></table>}
    </div>
  </div>;
}

// ---------------------------------------------------------------------------
// System  (system-level settings: modules, backups, devices)
// ---------------------------------------------------------------------------
const SYSTEM_TABS = ['Overview', 'Connectivity & Mode', 'Remote Staff Access', 'System Modules', 'Backup & Restore', 'Device Access / Pairing'] as const;
type SystemTab = typeof SYSTEM_TABS[number];

export function SystemSettings() {
  const [tab, setTab] = useState<SystemTab>('Overview');
  return <div className="settings-module">
    <div className="settings-module-head">
      <h2>System</h2>
      <p>System-level configuration for this laboratory's deployment: enabled modules, backups, and LAN device access.</p>
    </div>
    <div className="tabs">{SYSTEM_TABS.map(t => <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>{t}</button>)}</div>
    <div className="people-tab-body">
      {tab === 'Overview' && <SystemOverview />}
      {tab === 'Connectivity & Mode' && <ConnectivityMode />}
      {tab === 'Remote Staff Access' && <RemoteStaffAccess />}
      {tab === 'System Modules' && <ModuleToggles />}
      {tab === 'Backup & Restore' && <BackupRestore />}
      {tab === 'Device Access / Pairing' && <Devices />}
    </div>
  </div>;
}

function SystemOverview() {
  const [modules, setModules] = useState<SystemModule[]>([]);
  useEffect(() => { api<SystemModule[]>('/system-modules').then(setModules).catch(() => setModules([])); }, []);
  const enabled = modules.filter(m => m.enabled).length;
  return <div>
    <p>This is a multi-laboratory quality management system — each facility configures its own <Link to="/settings/laboratory">My Laboratory</Link> profile, <Link to="/settings/people">People &amp; Access</Link>, and <Link to="/settings/sections">units</Link>.</p>
    <div className="cards">
      <div className="card mini"><h4>Modules enabled</h4><p className="metric">{enabled}/{modules.length}</p></div>
      <div className="card mini"><h4>Product</h4><p>SECH_LIMS by Nickland</p></div>
      <div className="card mini"><h4>Data</h4><p>Local SQLite host</p></div>
    </div>
    <p className="hint">Use the tabs above to enable/disable modules, run backups, and manage LAN device pairing.</p>
  </div>;
}

// ---------------------------------------------------------------------------
// Connectivity & Mode  (offline-first hybrid architecture, Phase 1)
//
// Surfaces the deployment mode (Local vs Hybrid), whether the host API is
// reachable on the LAN, the URLs remote-in-the-building clients (desktop
// browsers and mobile PWA) should use, and the planned — not yet active —
// cloud synchronization status. Switching mode never affects instruments,
// monitoring, printers or workflows; the host stays fully functional offline.
// ---------------------------------------------------------------------------
export function ConnectivityMode() {
  const { user } = useAuth();
  const canEdit = user?.roleName === 'System Administrator' || user?.roleName === 'Laboratory Manager';
  const [info, setInfo] = useState<SystemConnectivity | null>(null);
  const [sync, setSync] = useState<SyncStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = () => {
    api<SystemConnectivity>('/system/connectivity').then(setInfo).catch(e => setError((e as Error).message));
    api<SyncStatus>('/sync/status').then(setSync).catch(() => setSync(null));
  };
  useEffect(() => { void load(); }, []);

  async function setMode(mode: AppMode) {
    if (!info || info.mode === mode) return;
    setBusy(true); setError(null); setMessage(null);
    try {
      await api('/system/mode', { method: 'PUT', body: JSON.stringify({ mode }) });
      setMessage(mode === 'hybrid'
        ? 'Hybrid mode enabled. LAN clients can connect; cloud sync remains planned and stays off until it is built.'
        : 'Local mode enabled. The host runs fully offline.');
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!info) return <div className="card"><h3>Connectivity &amp; Mode</h3>{error ? <p className="error">{error}</p> : <p className="muted">Loading…</p>}</div>;

  return <div>
    <div className="card">
      <h3>Deployment mode</h3>
      <p>Choose how this host operates. Both modes run the full laboratory offline — instruments, environmental monitoring, printers and workflows are never affected by connectivity.</p>
      <div className="tabs" style={{ marginTop: 8 }}>
        <button disabled={!canEdit || busy} className={info.mode === 'local' ? 'active' : ''} onClick={() => setMode('local')}>Local Mode</button>
        <button disabled={!canEdit || busy} className={info.mode === 'hybrid' ? 'active' : ''} onClick={() => setMode('hybrid')}>Hybrid Mode</button>
      </div>
      <p className="hint" style={{ marginTop: 8 }}>
        Current: <strong>{info.mode === 'hybrid' ? 'Hybrid' : 'Local'}</strong>{' '}
        ({info.modeSource === 'override' ? 'set here' : `default from environment (${info.envDefaultMode})`}).
        {' '}<em>Local</em> = single-PC offline. <em>Hybrid</em> = LAN clients now, secure remote access later.
      </p>
      {!canEdit && <p className="muted">Only a System Administrator or Laboratory Manager can change the mode.</p>}
      {message && <p className="notice-ok">{message}</p>}
      {error && <p className="error">{error}</p>}
    </div>

    <div className="card">
      <h3>LAN access</h3>
      {info.lanExposed
        ? <p className="notice-ok">The host API is bound to the LAN. Desktop browsers and the mobile PWA on this network can connect using the addresses below.</p>
        : <p className="hint">The host API is bound to loopback only (private to this PC). To serve desktop and mobile clients over the LAN, start the host with <code>SECH_LIMS_API_HOST=0.0.0.0</code> and allow the port through the Windows firewall.</p>}
      <table className="table" style={{ maxWidth: 640 }}><tbody>
        <tr><td>Bind address</td><td><code>{info.api.host}</code></td></tr>
        <tr><td>Port</td><td><code>{info.api.port}</code></td></tr>
        {info.lanUrls.length > 0 && <tr><td>LAN client URLs</td><td>{info.lanUrls.map(u => <div key={u}><code>{u}</code></div>)}</td></tr>}
        {info.api.publicUrl && <tr><td>Public URL (remote)</td><td><code>{info.api.publicUrl}</code></td></tr>}
      </tbody></table>
    </div>

    <div className="card">
      <h3>Cloud synchronization</h3>
      <p className="hint">
        Status: <strong>{sync ? (sync.enabled ? sync.state : 'Planned (not yet available)') : (info.sync.status === 'planned' ? 'Planned (not yet available)' : info.sync.status)}</strong>.
        The architecture is prepared for a future cloud database and web frontend, but no synchronization runs today.
        The active data store is <code>{info.database.driver}</code> on this host.
      </p>
      {sync && <table className="table" style={{ maxWidth: 640 }}><tbody>
        <tr><td>This host node id</td><td><code>{sync.nodeId ?? '—'}</code></td></tr>
        <tr><td>Cloud endpoint configured</td><td>{sync.cloudConfigured ? 'Yes' : 'No'}</td></tr>
        <tr><td>Pending changes (outbox)</td><td>{sync.pendingOutbox}</td></tr>
        <tr><td>Last synchronized</td><td>{sync.lastSyncAt ?? 'Never'}</td></tr>
      </tbody></table>}
    </div>
  </div>;
}
