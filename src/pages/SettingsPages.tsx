import { FormEvent, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../services/api';
import { PERMISSION_ACTIONS, TECHNICAL_AUTHORIZATION_LEVELS } from '../../shared/constants/modules';
import type { Position, Staff, SystemModule, ApiUser, Permission, Section, Device } from '../../shared/types/api';

export function UsersAccess(){
  const [users,setUsers]=useState<(ApiUser & {staffName?: string})[]>([]);
  const [roles,setRoles]=useState<{id:number;name:string}[]>([]);
  const [staff,setStaff]=useState<Staff[]>([]);
  const load=()=>{api<(ApiUser & {staffName?: string})[]>('/users').then(setUsers); api<{id:number;name:string}[]>('/roles').then(setRoles); api<Staff[]>('/staff').then(setStaff).catch(()=>setStaff([]))};
  useEffect(()=>{void load()},[]);
  async function submit(e:FormEvent<HTMLFormElement>){
    e.preventDefault();
    const fd=new FormData(e.currentTarget);
    const staffId=fd.get('staffId')?Number(fd.get('staffId')):null;
    await api('/users',{method:'POST',body:JSON.stringify({username:fd.get('username'),password:fd.get('password'),fullName:fd.get('fullName'),roleId:Number(fd.get('roleId')),staffId})});
    e.currentTarget.reset();
    load();
  }
  return <div className="card"><h3>Users & Access</h3>
    <form className="form" onSubmit={submit}>
      <label>Full name<input name="fullName" required/></label>
      <label>Username<input name="username" required/></label>
      <label>Password<input name="password" type="password" minLength={8} required/></label>
      <label>Role<select name="roleId" required>{roles.map(r=><option value={r.id} key={r.id}>{r.name}</option>)}</select></label>
      <label>Link to Staff Record (Optional)<select name="staffId"><option value="">Not linked</option>{staff.map(s=><option value={s.id} key={s.id}>{s.fullName}</option>)}</select></label>
      <button>Create user</button>
    </form>
    <table className="table"><thead><tr><th>Username</th><th>Full Name</th><th>Role</th><th>Linked Staff</th><th>Active</th></tr></thead><tbody>{users.map(u=><tr key={u.id}><td>{u.username}</td><td>{u.fullName}</td><td>{u.roleName}</td><td>{u.staffName || 'Not linked'}</td><td>{u.isActive?'Yes':'No'}</td></tr>)}</tbody></table>
  </div>;
}

export function Positions(){
  const [positions,setPositions]=useState<Position[]>([]);
  const [staff,setStaff]=useState<Staff[]>([]);
  const [posErr,setPosErr]=useState('');
  const [posMsg,setPosMsg]=useState('');
  const [staffErr,setStaffErr]=useState('');
  const [staffMsg,setStaffMsg]=useState('');
  const [posBusy,setPosBusy]=useState(false);
  const [staffBusy,setStaffBusy]=useState(false);
  const load=()=>{api<Position[]>('/positions').then(setPositions); api<Staff[]>('/staff').then(setStaff).catch(()=>setStaff([]))};
  useEffect(()=>{void load()},[]);
  async function addPosition(e:FormEvent<HTMLFormElement>){
    e.preventDefault();
    const form=e.currentTarget;                 // capture before await (React nulls currentTarget after yielding)
    const fd=new FormData(form);
    const title=String(fd.get('title')||'').trim();
    if(!title){setPosErr('Position title is required.');return;}
    setPosBusy(true);setPosErr('');setPosMsg('');
    try{
      await api('/positions',{method:'POST',body:JSON.stringify({title,description:String(fd.get('description')||'').trim()||null,reportsToPositionId:fd.get('reportsToPositionId')||null})});
      form.reset();
      setPosMsg(`Position “${title}” created.`);
      load();
    }catch(err){setPosErr(err instanceof Error?err.message:'Could not create position.');}
    finally{setPosBusy(false);}
  }
  async function addStaff(e:FormEvent<HTMLFormElement>){
    e.preventDefault();
    const form=e.currentTarget;                 // capture before await
    const fd=new FormData(form);
    const fullName=String(fd.get('fullName')||'').trim();
    if(!fullName){setStaffErr('Staff full name is required.');return;}
    setStaffBusy(true);setStaffErr('');setStaffMsg('');
    try{
      await api('/staff',{method:'POST',body:JSON.stringify({employeeNo:String(fd.get('employeeNo')||'').trim()||null,fullName,email:String(fd.get('email')||'').trim()||null,phone:String(fd.get('phone')||'').trim()||null,positionId:fd.get('positionId')?Number(fd.get('positionId')):null})});
      form.reset();
      setStaffMsg(`Staff “${fullName}” created.`);
      load();
    }catch(err){setStaffErr(err instanceof Error?err.message:'Could not create staff.');}
    finally{setStaffBusy(false);}
  }
  return <div className="grid cols-2">
    <div className="card"><h3>Positions & Organogram</h3><p>Create, edit, assign reporting lines, activate/deactivate, and archive used positions instead of hard-deleting them.</p>
      <form className="form" onSubmit={addPosition}>
        <label>Position title<input name="title" required placeholder="e.g. Biochemistry Unit Head"/></label>
        <label>Description<textarea name="description" placeholder="Optional"/></label>
        <label>Reporting line<select name="reportsToPositionId"><option value="">None</option>{positions.map(p=><option value={p.id} key={p.id}>{p.title}</option>)}</select></label>
        {posErr && <div className="error">{posErr}</div>}
        {posMsg && <div className="success-msg">{posMsg}</div>}
        <button disabled={posBusy}>{posBusy?'Creating…':'Create position'}</button>
      </form>
      <Table rows={positions}/>
    </div>
    <div className="card"><h3>Staff Assignment</h3>
      <form className="form" onSubmit={addStaff}>
        <label>Staff full name<input name="fullName" required placeholder="e.g. Dr. Paul Ntiamoah"/></label>
        <label>Employee no<input name="employeeNo" placeholder="Optional"/></label>
        <label>Email<input name="email" type="email" placeholder="Optional"/></label>
        <label>Phone<input name="phone" placeholder="Optional"/></label>
        <label>Assign position<select name="positionId"><option value="">None</option>{positions.map(p=><option value={p.id} key={p.id}>{p.title}</option>)}</select></label>
        {staffErr && <div className="error">{staffErr}</div>}
        {staffMsg && <div className="success-msg">{staffMsg}</div>}
        <button disabled={staffBusy}>{staffBusy?'Creating…':'Create staff'}</button>
      </form>
      <Table rows={staff}/>
    </div>
  </div>;
}

export function PermissionMatrix(){
  const [data,setData]=useState<Record<string,unknown[]>>({});
  const [roles,setRoles]=useState<{id:number;name:string}[]>([]);
  const [positions,setPositions]=useState<Position[]>([]);
  const [users,setUsers]=useState<ApiUser[]>([]);
  const [staff,setStaff]=useState<Staff[]>([]);
  const [permissions,setPermissions]=useState<Permission[]>([]);
  const [sections,setSections]=useState<Section[]>([]);
  const tabs=['Role Permissions','Position Permissions','User Overrides','Approval Rights','Technical Authorizations','Section Scope','Audit History'];
  const [tab,setTab]=useState(tabs[0]);
  
  useEffect(()=>{
    api<Record<string,unknown[]>>('/permissions/matrix').then(setData);
    api<{id:number;name:string}[]>('/roles').then(setRoles);
    api<Position[]>('/positions').then(setPositions);
    api<ApiUser[]>('/users').then(setUsers);
    api<Staff[]>('/staff').then(setStaff);
    api<Permission[]>('/permissions').then(setPermissions);
    api<Section[]>('/sections').then(setSections);
  },[]);

  async function addRolePermission(e:FormEvent<HTMLFormElement>){
    e.preventDefault();
    const fd=new FormData(e.currentTarget);
    await api('/permissions/role',{method:'POST',body:JSON.stringify({roleId:Number(fd.get('roleId')),permissionId:Number(fd.get('permissionId')),allowed:fd.get('allowed')==='allow'})});
    e.currentTarget.reset();
    api<Record<string,unknown[]>>('/permissions/matrix').then(setData);
  }

  async function addPositionPermission(e:FormEvent<HTMLFormElement>){
    e.preventDefault();
    const fd=new FormData(e.currentTarget);
    await api('/permissions/position',{method:'POST',body:JSON.stringify({positionId:Number(fd.get('positionId')),permissionId:Number(fd.get('permissionId')),allowed:fd.get('allowed')==='allow'})});
    e.currentTarget.reset();
    api<Record<string,unknown[]>>('/permissions/matrix').then(setData);
  }

  async function addUserOverride(e:FormEvent<HTMLFormElement>){
    e.preventDefault();
    const fd=new FormData(e.currentTarget);
    await api('/permissions/user-override',{method:'POST',body:JSON.stringify({userId:Number(fd.get('userId')),permissionId:Number(fd.get('permissionId')),allowed:fd.get('effect')==='allow',reason:fd.get('reason')})});
    e.currentTarget.reset();
    api<Record<string,unknown[]>>('/permissions/matrix').then(setData);
  }

  async function addTechnicalAuth(e:FormEvent<HTMLFormElement>){
    e.preventDefault();
    const fd=new FormData(e.currentTarget);
    await api('/authorizations/technical',{method:'POST',body:JSON.stringify({staffId:fd.get('staffId')?Number(fd.get('staffId')):null,positionId:fd.get('positionId')?Number(fd.get('positionId')):null,moduleKey:fd.get('moduleKey'),sectionId:fd.get('sectionId')?Number(fd.get('sectionId')):null,level:fd.get('level')})});
    e.currentTarget.reset();
    api<Record<string,unknown[]>>('/permissions/matrix').then(setData);
  }

  return <div className="card"><h3>Permission Matrix</h3><p>Detailed authorization foundation using module access, record actions, approvals, technical authorizations, section scope, overrides, and audit history.</p>
    <div className="tabs">{tabs.map(t=><button key={t} onClick={()=>setTab(t)} className={tab===t?'active':''}>{t}</button>)}</div>
    
    {tab==='Role Permissions' && <div>
      <form className="form" onSubmit={addRolePermission}>
        <label>Role<select name="roleId" required>{roles.map(r=><option value={r.id} key={r.id}>{r.name}</option>)}</select></label>
        <label>Permission<select name="permissionId" required>{permissions.map(p=><option value={p.id} key={p.id}>{p.label}</option>)}</select></label>
        <label>Effect<select name="allowed" required><option value="allow">Allow</option><option value="deny">Deny</option></select></label>
        <button>Assign permission</button>
      </form>
    </div>}
    
    {tab==='Position Permissions' && <div>
      <form className="form" onSubmit={addPositionPermission}>
        <label>Position<select name="positionId" required>{positions.map(p=><option value={p.id} key={p.id}>{p.title}</option>)}</select></label>
        <label>Permission<select name="permissionId" required>{permissions.map(p=><option value={p.id} key={p.id}>{p.label}</option>)}</select></label>
        <label>Effect<select name="allowed" required><option value="allow">Allow</option><option value="deny">Deny</option></select></label>
        <button>Assign permission</button>
      </form>
    </div>}
    
    {tab==='User Overrides' && <div>
      <form className="form" onSubmit={addUserOverride}>
        <label>User<select name="userId" required>{users.map(u=><option value={u.id} key={u.id}>{u.fullName}</option>)}</select></label>
        <label>Permission<select name="permissionId" required>{permissions.map(p=><option value={p.id} key={p.id}>{p.label}</option>)}</select></label>
        <label>Effect<select name="effect" required><option value="allow">Allow</option><option value="deny">Deny</option></select></label>
        <label>Reason<textarea name="reason"/></label>
        <button>Add override</button>
      </form>
    </div>}
    
    {tab==='Technical Authorizations' && <div>
      <form className="form" onSubmit={addTechnicalAuth}>
        <label>Staff<select name="staffId">{staff.map(s=><option value={s.id} key={s.id}>{s.fullName}</option>)}</select></label>
        <label>Position (Optional)<select name="positionId"><option value="">None</option>{positions.map(p=><option value={p.id} key={p.id}>{p.title}</option>)}</select></label>
        <label>Module<input name="moduleKey" placeholder="e.g., documents" required/></label>
        <label>Section<select name="sectionId"><option value="">All sections</option>{sections.map(s=><option value={s.id} key={s.id}>{s.name}</option>)}</select></label>
        <label>Authorization Level<select name="level" required>{TECHNICAL_AUTHORIZATION_LEVELS.map(l=><option value={l} key={l}>{l}</option>)}</select></label>
        <button>Add authorization</button>
      </form>
    </div>}
    
    {(tab==='Approval Rights' || tab==='Section Scope' || tab==='Audit History') && <div><p>Data-driven view for {tab.toLowerCase()}</p><pre style={{overflow:'auto',maxHeight:400}}>{JSON.stringify(data,null,2).slice(0,2000)}</pre></div>}
  </div>;
}

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

export function BackupRestore(){
  return <div className="card"><h3>Backup & Restore</h3><p>Backups use the Node archiver ZIP library and include SQLite, uploads, evidence, config, and backup-manifest.json. Restore remains a safe placeholder.</p>
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

function Table({rows}:{rows:unknown[]}){
  return <pre style={{maxHeight:280,overflow:'auto'}}>{JSON.stringify(rows,null,2)}</pre>;
}
