import { FormEvent, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../services/api';
import { MODULES, PERMISSION_ACTIONS, TECHNICAL_AUTHORIZATION_LEVELS } from '../../shared/constants/modules';
import type {
  Position, Staff, SystemModule, ApiUser, Permission, Section, Device,
  Department, PermissionMatrixData, TechnicalAuthorizationRow, StaffProfile,
} from '../../shared/types/api';

// ---------------------------------------------------------------------------
// Register New Staff
// ---------------------------------------------------------------------------
// Single onboarding workflow that wires a new person into every linked area:
// the staff/personnel record, Positions & Organogram, an optional login account
// (Users & Access), and optional starting Technical Authorizations (Permission
// Matrix → Section Scope). Everything is created in one transaction server-side.

type AuthRow = { moduleKey: string; sectionId: string; level: string };

export function RegisterStaff() {
  const [roles, setRoles] = useState<{ id: number; name: string }[]>([]);
  const [positions, setPositions] = useState<Position[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [profile, setProfile] = useState<StaffProfile | null>(null);

  const blank = { employeeNo: '', fullName: '', email: '', phone: '', sectionId: '', primaryPositionId: '' };
  const [form, setForm] = useState(blank);
  const [positionIds, setPositionIds] = useState<number[]>([]);
  const [createUser, setCreateUser] = useState(false);
  const [account, setAccount] = useState({ username: '', password: '', roleId: '' });
  const [auths, setAuths] = useState<AuthRow[]>([]);

  function loadLookups() {
    api<{ id: number; name: string }[]>('/roles').then(setRoles).catch(() => setRoles([]));
    api<Position[]>('/positions').then(setPositions).catch(() => setPositions([]));
    api<Section[]>('/sections').then(setSections).catch(() => setSections([]));
    api<Staff[]>('/staff').then(setStaff).catch(() => setStaff([]));
  }
  useEffect(() => { loadLookups(); }, []);

  function togglePosition(id: number) {
    setPositionIds(prev => {
      const next = prev.includes(id) ? prev.filter(p => p !== id) : [...prev, id];
      // keep primary valid
      setForm(f => ({ ...f, primaryPositionId: next.includes(Number(f.primaryPositionId)) ? f.primaryPositionId : (next[0] ? String(next[0]) : '') }));
      return next;
    });
  }

  function addAuthRow() { setAuths(prev => [...prev, { moduleKey: 'documents', sectionId: '', level: 'Perform' }]); }
  function updateAuthRow(i: number, patch: Partial<AuthRow>) { setAuths(prev => prev.map((r, idx) => idx === i ? { ...r, ...patch } : r)); }
  function removeAuthRow(i: number) { setAuths(prev => prev.filter((_, idx) => idx !== i)); }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null); setSuccess(null);
    try {
      const payload = {
        employeeNo: form.employeeNo || null,
        fullName: form.fullName,
        email: form.email || null,
        phone: form.phone || null,
        sectionId: form.sectionId || null,
        positionIds,
        primaryPositionId: form.primaryPositionId || null,
        createUser,
        username: createUser ? account.username : undefined,
        password: createUser ? account.password : undefined,
        roleId: createUser ? account.roleId : undefined,
        authorizations: auths.filter(a => a.moduleKey && a.level).map(a => ({ moduleKey: a.moduleKey, sectionId: a.sectionId || null, level: a.level })),
      };
      const res = await api<{ staffId: number; userId: number | null }>('/staff/register', { method: 'POST', body: JSON.stringify(payload) });
      setSuccess(`Staff record created (#${res.staffId})${res.userId ? ` with linked login account (user #${res.userId})` : ''}. Positions, authorizations and personnel records are now linked.`);
      setForm(blank); setPositionIds([]); setCreateUser(false); setAccount({ username: '', password: '', roleId: '' }); setAuths([]);
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
            <label>Full name<input value={form.fullName} onChange={e => setForm({ ...form, fullName: e.target.value })} required /></label>
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
          <legend>Initial technical authorizations <span className="hint">(optional)</span></legend>
          <p className="hint">Grant module/section authorization levels now, or add them later from the Permission Matrix → Section Scope.</p>
          {auths.map((a, i) => <div className="form-grid auth-row" key={i}>
            <label>Module<select value={a.moduleKey} onChange={e => updateAuthRow(i, { moduleKey: e.target.value })}>{MODULES.map(m => <option key={m.key} value={m.key}>{m.label}</option>)}</select></label>
            <label>Section scope<select value={a.sectionId} onChange={e => updateAuthRow(i, { sectionId: e.target.value })}><option value="">All sections</option>{sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
            <label>Level<select value={a.level} onChange={e => updateAuthRow(i, { level: e.target.value })}>{TECHNICAL_AUTHORIZATION_LEVELS.map(l => <option key={l} value={l}>{l}</option>)}</select></label>
            <button type="button" className="secondary" onClick={() => removeAuthRow(i)}>Remove</button>
          </div>)}
          <button type="button" className="secondary" onClick={addAuthRow}>+ Add authorization</button>
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
        ? <p>{profile.account.username} — role <span className="badge">{profile.account.role_name}</span> {profile.account.is_active ? '' : '(disabled)'} · <Link to="/settings/users">Manage in Users &amp; Access</Link></p>
        : <p className="hint">No login account linked. <Link to="/settings/users">Create one in Users &amp; Access</Link>.</p>}

      <h4>Positions &amp; organogram</h4>
      {profile.positions.length > 0
        ? <ul className="link-list">{profile.positions.map(p => <li key={p.id}><strong>{p.title}</strong> <span className="badge">{p.assignment_type}</span>{p.reports_to_title ? ` → reports to ${p.reports_to_title}` : ''}{p.is_active ? '' : ' (inactive)'}</li>)}</ul>
        : <p className="hint">No positions assigned. <Link to="/settings/positions">Assign in Positions &amp; Organogram</Link>.</p>}

      <h4>Technical authorizations &amp; section scope (Permission Matrix)</h4>
      {profile.authorizations.length > 0
        ? <table className="data-table"><thead><tr><th>Module</th><th>Section</th><th>Level</th><th>Status</th><th>Expires</th></tr></thead><tbody>
            {profile.authorizations.map(a => <tr key={a.id}><td>{moduleLabel(a.module_key)}</td><td>{a.section_name || 'All sections'}</td><td><span className="badge">{a.level}</span></td><td>{a.is_active ? <span className="badge active">active</span> : <span className="badge inactive">inactive</span>}</td><td>{a.expires_at || '—'}</td></tr>)}
          </tbody></table>
        : <p className="hint">No technical authorizations. <Link to="/settings/permissions">Add in Permission Matrix → Section Scope</Link>.</p>}

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
  const load=()=>{api<(ApiUser & {staffName?: string})[]>('/users').then(setUsers); api<{id:number;name:string}[]>('/roles').then(setRoles); api<Staff[]>('/staff').then(setStaff).catch(()=>setStaff([]))};
  useEffect(()=>{void load()},[]);
  async function submit(e:FormEvent<HTMLFormElement>){
    e.preventDefault(); setError(null);
    const fd=new FormData(e.currentTarget);
    const staffId=fd.get('staffId')?Number(fd.get('staffId')):null;
    try {
      await api('/users',{method:'POST',body:JSON.stringify({username:fd.get('username'),password:fd.get('password'),fullName:fd.get('fullName'),roleId:Number(fd.get('roleId')),staffId})});
      e.currentTarget.reset();
      load();
    } catch (err) { setError((err as Error).message); }
  }
  const unlinkedStaff = staff.filter(s => !s.userId);
  return <div className="card"><h3>Users &amp; Access</h3>
    <p>Create login accounts and link them to staff records. To onboard a whole new person (staff + account + positions) use <Link to="/settings/register-staff">Register New Staff</Link>.</p>
    {error && <div className="error">{error}</div>}
    <form className="form" onSubmit={submit}>
      <label>Full name<input name="fullName" required/></label>
      <label>Username<input name="username" required/></label>
      <label>Password<input name="password" type="password" minLength={8} required/></label>
      <label>Role<select name="roleId" required><option value="">Select role…</option>{roles.map(r=><option value={r.id} key={r.id}>{r.name}</option>)}</select></label>
      <label>Link to Staff Record (Optional)<select name="staffId"><option value="">Not linked</option>{unlinkedStaff.map(s=><option value={s.id} key={s.id}>{s.fullName}</option>)}</select></label>
      <button>Create user</button>
    </form>
    <table className="table"><thead><tr><th>Username</th><th>Full Name</th><th>Role</th><th>Linked Staff</th><th>Active</th></tr></thead><tbody>{users.map(u=><tr key={u.id}><td>{u.username}</td><td>{u.fullName}</td><td>{u.roleName}</td><td>{u.staffName || 'Not linked'}</td><td>{u.isActive?'Yes':'No'}</td></tr>)}</tbody></table>
  </div>;
}

// ---------------------------------------------------------------------------
// Positions & Organogram
// ---------------------------------------------------------------------------
export function Positions(){
  const [positions,setPositions]=useState<Position[]>([]);
  const [staff,setStaff]=useState<Staff[]>([]);
  const [sections,setSections]=useState<Section[]>([]);
  const load=()=>{api<Position[]>('/positions').then(setPositions); api<Staff[]>('/staff').then(setStaff).catch(()=>setStaff([])); api<Section[]>('/sections').then(setSections).catch(()=>setSections([]))};
  useEffect(()=>{void load()},[]);
  async function addPosition(e:FormEvent<HTMLFormElement>){
    e.preventDefault();
    const fd=new FormData(e.currentTarget);
    await api('/positions',{method:'POST',body:JSON.stringify({title:fd.get('title'),description:fd.get('description'),reportsToPositionId:fd.get('reportsToPositionId')||null})});
    e.currentTarget.reset();
    load();
  }
  async function addStaff(e:FormEvent<HTMLFormElement>){
    e.preventDefault();
    const fd=new FormData(e.currentTarget);
    await api('/staff',{method:'POST',body:JSON.stringify({employeeNo:fd.get('employeeNo'),fullName:fd.get('fullName'),email:fd.get('email'),phone:fd.get('phone'),sectionId:fd.get('sectionId')||null,positionId:Number(fd.get('positionId'))})});
    e.currentTarget.reset();
    load();
  }
  const byId = (id?: number | null) => positions.find(p => p.id === id)?.title;
  return <div className="grid cols-2">
    <div className="card"><h3>Positions &amp; Organogram</h3><p>Create positions and assign reporting lines. Staff are mapped to positions here and during <Link to="/settings/register-staff">Register New Staff</Link>.</p>
      <form className="form" onSubmit={addPosition}>
        <label>Position title<input name="title" required/></label>
        <label>Description<textarea name="description"/></label>
        <label>Reporting line<select name="reportsToPositionId"><option value="">None</option>{positions.map(p=><option value={p.id} key={p.id}>{p.title}</option>)}</select></label>
        <button>Create position</button>
      </form>
      <table className="data-table"><thead><tr><th>Title</th><th>Reports to</th><th>Status</th></tr></thead><tbody>
        {positions.map(p => <tr key={p.id}><td>{p.title}</td><td>{byId(p.reportsToPositionId) || '—'}</td><td>{p.isActive ? <span className="badge active">active</span> : <span className="badge inactive">archived</span>}</td></tr>)}
      </tbody></table>
    </div>
    <div className="card"><h3>Quick staff assignment</h3>
      <form className="form" onSubmit={addStaff}>
        <label>Employee no<input name="employeeNo"/></label>
        <label>Staff full name<input name="fullName" required/></label>
        <label>Email<input name="email"/></label>
        <label>Phone<input name="phone"/></label>
        <label>Section<select name="sectionId"><option value="">Unassigned</option>{sections.map(s=><option value={s.id} key={s.id}>{s.name}</option>)}</select></label>
        <label>Assign position<select name="positionId" required><option value="">Select…</option>{positions.map(p=><option value={p.id} key={p.id}>{p.title}</option>)}</select></label>
        <button>Create staff</button>
      </form>
      <table className="data-table"><thead><tr><th>Name</th><th>Position</th><th>Section</th></tr></thead><tbody>
        {staff.map(s => <tr key={s.id}><td>{s.fullName}</td><td>{s.primaryPosition || '—'}</td><td>{s.sectionName || '—'}</td></tr>)}
      </tbody></table>
    </div>
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
  return <div className="card"><h3>Document Master List Import</h3><p>Upload/import workflow scaffold for SOPs, policies, forms, registers, logs, and trackers. CSV parsing is intentionally deferred.</p>
    <button onClick={()=>api('/documents/import-master-list',{method:'POST',body:JSON.stringify({source:'mvp-ui'})})}>Run placeholder import</button>
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

export function BackupRestore(){
  return <div className="card"><h3>Backup &amp; Restore</h3><p>Backups use the Node archiver ZIP library and include SQLite, uploads, evidence, config, and backup-manifest.json. Restore remains a safe placeholder.</p>
    <button onClick={()=>api('/backup/create',{method:'POST'}).then(r=>alert(JSON.stringify(r)))}>Create backup package</button>
    <button className="secondary" onClick={()=>api('/backup/restore-placeholder',{method:'POST'}).then(r=>alert(JSON.stringify(r)))}>Restore placeholder</button>
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
