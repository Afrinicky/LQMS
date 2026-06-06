import { FormEvent, useEffect, useMemo, useState } from 'react';
import { api } from '../services/api';
import { useModules } from '../hooks/useModules';
import DisabledModule from '../components/DisabledModule';
import type { ActionRecord, ComplaintRecord, CapaRecord, NonconformingEvent, QmsSummary, RiskRecord, Staff } from '../../shared/types/api';

const badges = { open: 'badge', new: 'badge', active: 'badge', closed: 'badge', reviewed: 'badge', verified: 'badge', 'Not started': 'badge', 'In progress': 'badge', 'Waiting for evidence': 'badge', 'Submitted for review': 'badge', Completed: 'badge', Verified: 'badge', Closed: 'badge', Reopened: 'badge', Overdue: 'badge' };

export function NcCapaPage() {
  const { isEnabled } = useModules();
  const [tab, setTab] = useState('Dashboard');
  const [ncList, setNcList] = useState<NonconformingEvent[]>([]);
  const [capaList, setCapaList] = useState<CapaRecord[]>([]);
  const [summary, setSummary] = useState<QmsSummary | null>(null);
  const [selectedNc, setSelectedNc] = useState<NonconformingEvent | null>(null);
  const [selectedCapa, setSelectedCapa] = useState<CapaRecord | null>(null);
  const [formState, setFormState] = useState({ eventDate: '', detectedByStaffId: '', departmentId: '', sectionId: '', sourceModule: '', title: '', description: '', category: '', severity: '', impactLevel: '', immediateCorrection: '', patientOrServiceImpact: '' });

  useEffect(() => { if (!isEnabled('nc_capa')) return; void load(); }, [isEnabled]);
  async function load() {
    setNcList(await api<NonconformingEvent[]>('/nonconformities'));
    setCapaList(await api<CapaRecord[]>('/capa'));
    setSummary(await api<QmsSummary>('/dashboard/qms-summary'));
  }
  async function submitNewNc(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    await api('/nonconformities', { method: 'POST', body: JSON.stringify({ ...formState, eventDate: formState.eventDate || undefined }) });
    setFormState({ eventDate: '', detectedByStaffId: '', departmentId: '', sectionId: '', sourceModule: '', title: '', description: '', category: '', severity: '', impactLevel: '', immediateCorrection: '', patientOrServiceImpact: '' });
    load();
  }
  async function closeNc(id: number) {
    await api(`/nonconformities/${id}/close`, { method: 'POST', body: JSON.stringify({ closureNotes: 'Closed through dashboard action' }) });
    load();
  }
  async function createCapaFromNc(id: number) {
    await api(`/nonconformities/${id}/create-capa`, { method: 'POST', body: JSON.stringify({ title: 'CAPA from NC', problemSummary: 'Auto-generated from NC review' }) });
    load();
  }
  const overdueCAPAs = capaList.filter(c => c.status !== 'closed' && c.due_date && new Date(c.due_date) < new Date());
  const effectivenessDue = capaList.filter(c => c.effectiveness_due_date && new Date(c.effectiveness_due_date) <= new Date() && c.effectiveness_status !== 'Complete');
  return !isEnabled('nc_capa') ? <DisabledModule /> : <div>
    <h2>Nonconforming Events & CAPA</h2>
    <div className="tabs">{['Dashboard','Nonconforming Events','New Event','CAPA Register','Overdue CAPAs','Effectiveness Reviews','Reports placeholder'].map(name=><button key={name} className={tab===name?'active':''} onClick={()=>setTab(name)}>{name}</button>)}</div>
    {tab === 'Dashboard' && <div className="grid cols-4">
      <div className="card metric"><span>Open NCs</span><br/><strong>{summary?.openNCs.count ?? ncList.filter(n => n.status !== 'closed').length}</strong></div>
      <div className="card metric"><span>NCs pending review</span><br/><strong>{ncList.filter(n => n.status === 'open').length}</strong></div>
      <div className="card metric"><span>Open CAPAs</span><br/><strong>{summary?.openCAPAs.count ?? capaList.filter(c => c.status !== 'closed').length}</strong></div>
      <div className="card metric"><span>Overdue CAPAs</span><br/><strong>{overdueCAPAs.length}</strong></div>
      <div className="card metric"><span>Effectiveness reviews due</span><br/><strong>{effectivenessDue.length}</strong></div>
      <div className="card metric"><span>Recurrent issue placeholder</span><br/><strong>Placeholder</strong></div>
    </div>}

    {tab === 'Nonconforming Events' && <div className="card">
      <h3>Nonconforming Events</h3>
      <table className="table"><thead><tr><th>NC No.</th><th>Date</th><th>Source</th><th>Department/Section</th><th>Title</th><th>Severity</th><th>Status</th><th>CAPA</th><th>Actions</th></tr></thead>
      <tbody>{ncList.map(n => <tr key={n.id}><td>{n.nc_number}</td><td>{n.event_date}</td><td>{n.source_module || 'Manual'}</td><td>{n.department_id || ''}/{n.section_id || ''}</td><td>{n.title}</td><td>{n.severity}</td><td><span className={badges[n.status] || 'badge'}>{n.status}</span></td><td>{capaList.some(c => c.nc_id === n.id) ? 'Yes' : 'No'}</td><td><button onClick={()=>setSelectedNc(n)}>View</button> <button className="secondary" onClick={()=>createCapaFromNc(n.id)}>Create CAPA</button></td></tr>)}</tbody>
      </table>
    </div>}

    {tab === 'New Event' && <div className="card"><h3>New Nonconforming Event</h3>
      <form className="form" onSubmit={submitNewNc}>
        <label>Event date<input type="date" value={formState.eventDate} onChange={e=>setFormState(prev=>({...prev,eventDate:e.target.value}))} required/></label>
        <label>Detected by staff ID<input value={formState.detectedByStaffId} onChange={e=>setFormState(prev=>({...prev,detectedByStaffId:e.target.value}))} placeholder="Staff ID"/></label>
        <label>Department ID<input value={formState.departmentId} onChange={e=>setFormState(prev=>({...prev,departmentId:e.target.value}))} placeholder="Department ID"/></label>
        <label>Section ID<input value={formState.sectionId} onChange={e=>setFormState(prev=>({...prev,sectionId:e.target.value}))} placeholder="Section ID"/></label>
        <label>Source module<input value={formState.sourceModule} onChange={e=>setFormState(prev=>({...prev,sourceModule:e.target.value}))} placeholder="e.g. complaints"/></label>
        <label>Title<input value={formState.title} onChange={e=>setFormState(prev=>({...prev,title:e.target.value}))} required/></label>
        <label>Description<textarea value={formState.description} onChange={e=>setFormState(prev=>({...prev,description:e.target.value}))} required/></label>
        <label>Category<input value={formState.category} onChange={e=>setFormState(prev=>({...prev,category:e.target.value}))}/></label>
        <label>Severity<input value={formState.severity} onChange={e=>setFormState(prev=>({...prev,severity:e.target.value}))}/></label>
        <label>Impact level<input value={formState.impactLevel} onChange={e=>setFormState(prev=>({...prev,impactLevel:e.target.value}))}/></label>
        <label>Immediate correction<textarea value={formState.immediateCorrection} onChange={e=>setFormState(prev=>({...prev,immediateCorrection:e.target.value}))}/></label>
        <label>Patient/service impact<textarea value={formState.patientOrServiceImpact} onChange={e=>setFormState(prev=>({...prev,patientOrServiceImpact:e.target.value}))}/></label>
        <button>Create event</button>
      </form>
    </div>}

    {tab === 'CAPA Register' && <div className="card">
      <h3>CAPA Register</h3>
      <table className="table"><thead><tr><th>CAPA No.</th><th>Source</th><th>Title</th><th>Responsible</th><th>Due date</th><th>Priority</th><th>Status</th><th>Effectiveness</th><th>Actions</th></tr></thead>
      <tbody>{capaList.map(c => <tr key={c.id}><td>{c.capa_number}</td><td>{c.source_module || 'Manual'}</td><td>{c.title}</td><td>{c.responsible_staff_id || ''}</td><td>{c.due_date || 'N/A'}</td><td>{c.priority}</td><td><span className={badges[c.status] || 'badge'}>{c.status}</span></td><td>{c.effectiveness_status || 'pending'}</td><td><button onClick={()=>setSelectedCapa(c)}>View</button></td></tr>)}</tbody>
      </table>
    </div>}

    {tab === 'Overdue CAPAs' && <div className="card">
      <h3>Overdue CAPAs</h3>
      <table className="table"><thead><tr><th>CAPA No.</th><th>Title</th><th>Due date</th><th>Status</th></tr></thead>
      <tbody>{overdueCAPAs.map(c => <tr key={c.id}><td>{c.capa_number}</td><td>{c.title}</td><td>{c.due_date}</td><td><span className={badges[c.status] || 'badge'}>{c.status}</span></td></tr>)}</tbody>
      </table>
    </div>}

    {tab === 'Effectiveness Reviews' && <div className="card">
      <h3>Effectiveness reviews due</h3>
      <table className="table"><thead><tr><th>CAPA No.</th><th>Title</th><th>Effectiveness due</th><th>Status</th></tr></thead>
      <tbody>{effectivenessDue.map(c => <tr key={c.id}><td>{c.capa_number}</td><td>{c.title}</td><td>{c.effectiveness_due_date}</td><td>{c.effectiveness_status}</td></tr>)}</tbody>
      </table>
    </div>}

    {tab === 'Reports placeholder' && <div className="card"><h3>Reports placeholder</h3><p>This section is reserved for future CAPA and NC analytics. Core QMS workflows are built without accreditation scoring or checklist percentages.</p></div>}

    {selectedNc && <div className="card"><h3>NC detail: {selectedNc.nc_number}</h3><p><strong>Title</strong> {selectedNc.title}</p><p><strong>Description</strong> {selectedNc.description}</p><p><strong>Immediate correction</strong> {selectedNc.immediate_correction}</p><p><strong>Status</strong> {selectedNc.status}</p><p><strong>Reviewer</strong> {selectedNc.reviewer_staff_id || 'Unassigned'}</p><button onClick={()=>closeNc(selectedNc.id)}>Close NC</button></div>}
    {selectedCapa && <div className="card"><h3>CAPA detail: {selectedCapa.capa_number}</h3><p><strong>Title</strong> {selectedCapa.title}</p><p><strong>Problem summary</strong> {selectedCapa.problem_summary}</p><p><strong>Corrective action</strong> {selectedCapa.corrective_action}</p><p><strong>Preventive action</strong> {selectedCapa.preventive_action}</p><p><strong>Status</strong> {selectedCapa.status}</p></div>}
  </div>;
}

export function ComplaintsPage() {
  const { isEnabled } = useModules();
  const [tab, setTab] = useState('Dashboard');
  const [complaints, setComplaints] = useState<ComplaintRecord[]>([]);
  const [selected, setSelected] = useState<ComplaintRecord | null>(null);
  const [formState, setFormState] = useState({ receivedDate: '', source: '', complainantType: '', complainantName: '', contact: '', departmentId: '', sectionId: '', category: '', title: '', description: '', assignedToStaffId: '' });

  useEffect(() => { if (!isEnabled('complaints')) return; void load(); }, [isEnabled]);
  async function load() { setComplaints(await api<ComplaintRecord[]>('/complaints')); }
  async function submit(e: FormEvent<HTMLFormElement>) { e.preventDefault(); await api('/complaints',{method:'POST',body:JSON.stringify({...formState, receivedDate: formState.receivedDate || undefined})}); setFormState({receivedDate:'',source:'',complainantType:'',complainantName:'',contact:'',departmentId:'',sectionId:'',category:'',title:'',description:'',assignedToStaffId:''}); load(); }
  async function assign(selectedId:number) { await api(`/complaints/${selectedId}/assign`,{method:'POST',body:JSON.stringify({assignedToStaffId:selected?.assigned_to_staff_id,status:'assigned'})}); load(); }
  async function investigate(selectedId:number) { await api(`/complaints/${selectedId}/investigate`,{method:'POST',body:JSON.stringify({investigationSummary:'Investigation logged',rootCause:'Pending evaluation',correction:'Pending',status:'investigating'})}); load(); }
  const openCount = complaints.filter(c=>c.status !== 'closed').length;
  const underInvestigation = complaints.filter(c=>c.status==='investigating').length;
  const overdue = complaints.filter(c=>c.status !== 'closed' && c.received_date && new Date(c.received_date).getTime() + 1000*60*60*24*30 < Date.now()).length;
  const closed = complaints.filter(c=>c.status==='closed').length;
  const linked = complaints.filter(c=>c.capa_required === 1).length;
  return !isEnabled('complaints') ? <DisabledModule/> : <div>
    <h2>Complaints Register</h2>
    <div className="tabs">{['Dashboard','Complaints Register','New Complaint','Investigation','Trends placeholder','Reports placeholder'].map(name=><button key={name} className={tab===name?'active':''} onClick={()=>setTab(name)}>{name}</button>)}</div>
    {tab==='Dashboard' && <div className="grid cols-4"><div className="card metric"><span>Received this month</span><br/><strong>{openCount}</strong></div><div className="card metric"><span>Under investigation</span><br/><strong>{underInvestigation}</strong></div><div className="card metric"><span>Overdue</span><br/><strong>{overdue}</strong></div><div className="card metric"><span>Closed</span><br/><strong>{closed}</strong></div><div className="card metric"><span>Linked to CAPA</span><br/><strong>{linked}</strong></div></div>}
    {tab==='Complaints Register' && <div className="card"><table className="table"><thead><tr><th>No.</th><th>Date</th><th>Source</th><th>Type</th><th>Category</th><th>Title</th><th>Assigned To</th><th>Status</th><th>Actions</th></tr></thead><tbody>{complaints.map(c=><tr key={c.id}><td>{c.complaint_number}</td><td>{c.received_date}</td><td>{c.source}</td><td>{c.complainant_type}</td><td>{c.category}</td><td>{c.title}</td><td>{c.assigned_to_staff_id || ''}</td><td>{c.status}</td><td><button onClick={()=>setSelected(c)}>View</button></td></tr>)}</tbody></table></div>}
    {tab==='New Complaint' && <div className="card"><form className="form" onSubmit={submit}><label>Received date<input type="date" value={formState.receivedDate} onChange={e=>setFormState(prev=>({...prev,receivedDate:e.target.value}))} required/></label><label>Source<input value={formState.source} onChange={e=>setFormState(prev=>({...prev,source:e.target.value}))}/></label><label>Complainant type<input value={formState.complainantType} onChange={e=>setFormState(prev=>({...prev,complainantType:e.target.value}))}/></label><label>Complainant name<input value={formState.complainantName} onChange={e=>setFormState(prev=>({...prev,complainantName:e.target.value}))}/></label><label>Contact<input value={formState.contact} onChange={e=>setFormState(prev=>({...prev,contact:e.target.value}))}/></label><label>Department ID<input value={formState.departmentId} onChange={e=>setFormState(prev=>({...prev,departmentId:e.target.value}))}/></label><label>Section ID<input value={formState.sectionId} onChange={e=>setFormState(prev=>({...prev,sectionId:e.target.value}))}/></label><label>Category<input value={formState.category} onChange={e=>setFormState(prev=>({...prev,category:e.target.value}))}/></label><label>Title<input value={formState.title} onChange={e=>setFormState(prev=>({...prev,title:e.target.value}))} required/></label><label>Description<textarea value={formState.description} onChange={e=>setFormState(prev=>({...prev,description:e.target.value}))} required/></label><label>Assigned to staff ID<input value={formState.assignedToStaffId} onChange={e=>setFormState(prev=>({...prev,assignedToStaffId:e.target.value}))}/></label><button>Create complaint</button></form></div>}
    {tab==='Investigation' && <div className="card"><h3>Investigation tools</h3>{selected? <div><h4>{selected.complaint_number} - {selected.title}</h4><p>{selected.description}</p><button onClick={()=>selected && assign(selected.id)}>Assign</button> <button onClick={()=>selected && investigate(selected.id)}>Investigate</button></div> : <p>Select a complaint from the register tab to investigate.</p>}</div>}
    {tab==='Trends placeholder' && <div className="card"><h3>Trends placeholder</h3><p>Risk and complaint trend dashboards will be added in a later phase while preserving neutral QMS language.</p></div>}
    {tab==='Reports placeholder' && <div className="card"><h3>Reports placeholder</h3><p>Structured complaint reporting and export workflows are reserved for future QMS expansions.</p></div>}
    {selected && <div className="card"><h3>Complaint detail</h3><p><strong>{selected.title}</strong></p><p>{selected.description}</p><p><strong>Status:</strong> {selected.status}</p><p><strong>Investigation:</strong> {selected.investigation_summary || 'Not started'}</p><p><strong>Root cause:</strong> {selected.root_cause || 'Not captured'}</p><p><strong>Correction:</strong> {selected.correction || 'Not captured'}</p><p><strong>CAPA required:</strong> {selected.capa_required ? 'Yes' : 'No'}</p></div>}
  </div>;
}

export function RisksPage() {
  const { isEnabled } = useModules();
  const [tab, setTab] = useState('Dashboard');
  const [risks, setRisks] = useState<RiskRecord[]>([]);
  const [selected, setSelected] = useState<RiskRecord | null>(null);
  const [formState, setFormState] = useState({ departmentId: '', sectionId: '', riskArea: '', riskDescription: '', cause: '', consequence: '', existingControls: '', likelihood: '1', severity: '1', detectability: '1', mitigationPlan: '', responsibleStaffId: '', reviewDueDate: '' });

  useEffect(() => { if (!isEnabled('risks')) return; void load(); }, [isEnabled]);
  async function load() { setRisks(await api<RiskRecord[]>('/risks')); }
  async function submit(e: FormEvent<HTMLFormElement>) { e.preventDefault(); await api('/risks',{method:'POST',body:JSON.stringify({ ...formState, likelihood:Number(formState.likelihood), severity:Number(formState.severity), detectability:Number(formState.detectability), departmentId: formState.departmentId || undefined, sectionId: formState.sectionId || undefined, responsibleStaffId: formState.responsibleStaffId || undefined, reviewDueDate: formState.reviewDueDate || undefined })}); setFormState({ departmentId:'', sectionId:'', riskArea:'', riskDescription:'', cause:'', consequence:'', existingControls:'', likelihood:'1', severity:'1', detectability:'1', mitigationPlan:'', responsibleStaffId:'', reviewDueDate:'' }); load(); }
  async function review(id:number) { await api(`/risks/${id}/review`,{method:'POST',body:JSON.stringify({ reviewNotes:'Periodic review logged', nextReviewDate: new Date(Date.now()+1000*60*60*24*30).toISOString().slice(0,10) })}); load(); }
  async function close(id:number) { await api(`/risks/${id}/close`,{method:'POST',body:JSON.stringify({ status:'closed' })}); load(); }
  const high = risks.filter(r=>r.risk_level === 'High' || r.risk_level === 'Critical').length;
  const reviewsDue = risks.filter(r=>r.review_due_date && new Date(r.review_due_date) <= new Date()).length;
  const mitigationOverdue = risks.filter(r=>r.status !== 'closed' && r.review_due_date && new Date(r.review_due_date) < new Date()).length;
  return !isEnabled('risks') ? <DisabledModule/> : <div>
    <h2>Risk Register</h2>
    <div className="tabs">{['Dashboard','Risk Register','New Risk','Reviews Due','Reports placeholder'].map(name=><button key={name} className={tab===name?'active':''} onClick={()=>setTab(name)}>{name}</button>)}</div>
    {tab==='Dashboard' && <div className="grid cols-4"><div className="card metric"><span>Active risks</span><br/><strong>{risks.filter(r=>r.status !== 'closed').length}</strong></div><div className="card metric"><span>High risks</span><br/><strong>{high}</strong></div><div className="card metric"><span>Reviews due</span><br/><strong>{reviewsDue}</strong></div><div className="card metric"><span>Mitigation actions overdue</span><br/><strong>{mitigationOverdue}</strong></div><div className="card metric"><span>Risks linked to CAPA</span><br/><strong>{risks.filter(r=>r.risk_level==='Critical').length}</strong></div></div>}
    {tab==='Risk Register' && <div className="card"><table className="table"><thead><tr><th>Risk No.</th><th>Area</th><th>Description</th><th>Score</th><th>Level</th><th>Responsible</th><th>Review Due</th><th>Status</th><th>Actions</th></tr></thead><tbody>{risks.map(r=><tr key={r.id}><td>{r.risk_number}</td><td>{r.risk_area}</td><td>{r.risk_description}</td><td>{r.risk_score}</td><td>{r.risk_level}</td><td>{r.responsible_staff_id || ''}</td><td>{r.review_due_date || 'N/A'}</td><td>{r.status}</td><td><button onClick={()=>setSelected(r)}>View</button></td></tr>)}</tbody></table></div>}
    {tab==='New Risk' && <div className="card"><form className="form" onSubmit={submit}><label>Department ID<input value={formState.departmentId} onChange={e=>setFormState(prev=>({...prev,departmentId:e.target.value}))}/></label><label>Section ID<input value={formState.sectionId} onChange={e=>setFormState(prev=>({...prev,sectionId:e.target.value}))}/></label><label>Risk area<input value={formState.riskArea} onChange={e=>setFormState(prev=>({...prev,riskArea:e.target.value}))} required/></label><label>Description<textarea value={formState.riskDescription} onChange={e=>setFormState(prev=>({...prev,riskDescription:e.target.value}))}/></label><label>Cause<textarea value={formState.cause} onChange={e=>setFormState(prev=>({...prev,cause:e.target.value}))}/></label><label>Consequence<textarea value={formState.consequence} onChange={e=>setFormState(prev=>({...prev,consequence:e.target.value}))}/></label><label>Existing controls<textarea value={formState.existingControls} onChange={e=>setFormState(prev=>({...prev,existingControls:e.target.value}))}/></label><label>Likelihood<input type="number" min="1" max="5" value={formState.likelihood} onChange={e=>setFormState(prev=>({...prev,likelihood:e.target.value}))} required/></label><label>Severity<input type="number" min="1" max="5" value={formState.severity} onChange={e=>setFormState(prev=>({...prev,severity:e.target.value}))} required/></label><label>Detectability<input type="number" min="1" max="5" value={formState.detectability} onChange={e=>setFormState(prev=>({...prev,detectability:e.target.value}))} required/></label><label>Mitigation plan<textarea value={formState.mitigationPlan} onChange={e=>setFormState(prev=>({...prev,mitigationPlan:e.target.value}))}/></label><label>Responsible staff ID<input value={formState.responsibleStaffId} onChange={e=>setFormState(prev=>({...prev,responsibleStaffId:e.target.value}))}/></label><label>Review due date<input type="date" value={formState.reviewDueDate} onChange={e=>setFormState(prev=>({...prev,reviewDueDate:e.target.value}))}/></label><button>Create risk</button></form></div>}
    {tab==='Reviews Due' && <div className="card"><table className="table"><thead><tr><th>Risk No.</th><th>Area</th><th>Review Due</th><th>Status</th><th>Actions</th></tr></thead><tbody>{risks.filter(r=>r.review_due_date && new Date(r.review_due_date) <= new Date()).map(r=><tr key={r.id}><td>{r.risk_number}</td><td>{r.risk_area}</td><td>{r.review_due_date}</td><td>{r.status}</td><td><button onClick={()=>review(r.id)}>Review</button> <button onClick={()=>close(r.id)}>Close</button></td></tr>)}</tbody></table></div>}
    {tab==='Reports placeholder' && <div className="card"><h3>Reports placeholder</h3><p>Risk register reporting and performance summaries will be introduced later in neutral QMS language.</p></div>}
    {selected && <div className="card"><h3>Risk detail</h3><p><strong>{selected.risk_number}</strong></p><p>{selected.risk_area}</p><p>{selected.risk_description}</p><p><strong>Score</strong> {selected.risk_score}</p><p><strong>Level</strong> {selected.risk_level}</p><p><strong>Review due</strong> {selected.review_due_date}</p><p><button onClick={()=>selected && review(selected.id)}>Add review</button> <button onClick={()=>selected && close(selected.id)}>Close risk</button></p></div>}
  </div>;
}

export function QmsActionTracker() {
  const { isEnabled } = useModules();
  const [actions, setActions] = useState<ActionRecord[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [statusFilter, setStatusFilter] = useState('');
  const [staffFilter, setStaffFilter] = useState('');
  const [overdueFilter, setOverdueFilter] = useState(false);
  const [selected, setSelected] = useState<ActionRecord | null>(null);
  const [formState, setFormState] = useState({ title: '', moduleKey: 'nc_capa', sourceModule: '', sourceRecordId: '', description: '', assignedToStaffId: '', dueDate: '', priority: 'normal', status: 'Not started', evidenceRequired: false, completionNotes: '' });

  useEffect(() => { if (!isEnabled('actions')) return; void load(); api<Staff[]>('/staff').then(setStaff).catch(()=>[]); }, [isEnabled]);
  async function load() {
    const query = new URLSearchParams();
    if (statusFilter) query.set('status', statusFilter);
    if (staffFilter) query.set('assignedToStaffId', staffFilter);
    if (overdueFilter) query.set('overdue', 'true');
    setActions(await api<ActionRecord[]>(`/actions?${query.toString()}`));
  }
  async function create(e: FormEvent<HTMLFormElement>) { e.preventDefault(); await api('/actions',{method:'POST',body:JSON.stringify({ ...formState, assignedToStaffId: formState.assignedToStaffId || undefined, evidenceRequired: formState.evidenceRequired })}); setFormState({ title:'', moduleKey:'nc_capa', sourceModule:'', sourceRecordId:'', description:'', assignedToStaffId:'', dueDate:'', priority:'normal', status:'Not started', evidenceRequired:false, completionNotes:'' }); load(); }
  async function updateStatus() { if (!selected) return; await api(`/actions/${selected.id}`,{method:'PUT',body:JSON.stringify({ status: selected.status, completionNotes: selected.completion_notes })}); load(); }
  const statusOptions = ['Not started','In progress','Waiting for evidence','Submitted for review','Completed','Verified','Closed','Reopened','Overdue'];
  return !isEnabled('actions') ? <DisabledModule/> : <div>
    <h2>Action Tracker</h2>
    <div className="card"><h3>Filters</h3><div className="form"><label>Status<select value={statusFilter} onChange={e=>setStatusFilter(e.target.value)}><option value="">All</option>{statusOptions.map(s=><option key={s} value={s}>{s}</option>)}</select></label><label>Assigned staff<select value={staffFilter} onChange={e=>setStaffFilter(e.target.value)}><option value="">All</option>{staff.map(s=><option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label><label><input type="checkbox" checked={overdueFilter} onChange={e=>setOverdueFilter(e.target.checked)}/> Overdue only</label><button onClick={load}>Refresh</button></div></div>
    <div className="card"><h3>Create action</h3><form className="form" onSubmit={create}><label>Title<input value={formState.title} onChange={e=>setFormState(prev=>({...prev,title:e.target.value}))} required/></label><label>Source module<input value={formState.sourceModule} onChange={e=>setFormState(prev=>({...prev,sourceModule:e.target.value}))} placeholder="e.g. nc_capa"/></label><label>Source record ID<input value={formState.sourceRecordId} onChange={e=>setFormState(prev=>({...prev,sourceRecordId:e.target.value}))} placeholder="Record ID"/></label><label>Description<textarea value={formState.description} onChange={e=>setFormState(prev=>({...prev,description:e.target.value}))}/></label><label>Assigned to<select value={formState.assignedToStaffId} onChange={e=>setFormState(prev=>({...prev,assignedToStaffId:e.target.value}))}><option value="">None</option>{staff.map(s=><option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label><label>Due date<input type="date" value={formState.dueDate} onChange={e=>setFormState(prev=>({...prev,dueDate:e.target.value}))}/></label><label>Priority<select value={formState.priority} onChange={e=>setFormState(prev=>({...prev,priority:e.target.value}))}><option>normal</option><option>high</option><option>low</option></select></label><label>Status<select value={formState.status} onChange={e=>setFormState(prev=>({...prev,status:e.target.value}))}>{statusOptions.map(s=><option key={s} value={s}>{s}</option>)}</select></label><label><input type="checkbox" checked={formState.evidenceRequired} onChange={e=>setFormState(prev=>({...prev,evidenceRequired:e.target.checked}))}/> Evidence required</label><label>Completion notes<textarea value={formState.completionNotes} onChange={e=>setFormState(prev=>({...prev,completionNotes:e.target.value}))}/></label><button>Create action</button></form></div>
    <div className="card"><h3>Actions</h3><table className="table"><thead><tr><th>Title</th><th>Source</th><th>Assigned</th><th>Due</th><th>Priority</th><th>Status</th><th>Actions</th></tr></thead><tbody>{actions.map(action=><tr key={action.id}><td>{action.title}</td><td>{action.source_module || action.module_key}#{action.source_record_id || ''}</td><td>{action.assigned_to_staff_id || ''}</td><td>{action.due_date || 'N/A'}</td><td>{action.priority}</td><td>{action.status}</td><td><button onClick={()=>setSelected(action)}>Select</button></td></tr>)}</tbody></table></div>
    {selected && <div className="card"><h3>Action detail</h3><p><strong>{selected.title}</strong></p><p><strong>Source</strong> {selected.source_module || selected.module_key} / {selected.source_record_id || 'N/A'}</p><p><strong>Assigned</strong> {selected.assigned_to_staff_id || 'Unassigned'}</p><p><strong>Status</strong> <select value={selected.status} onChange={e=>setSelected(prev => prev ? {...prev,status:e.target.value}:prev)}>{statusOptions.map(s=><option key={s} value={s}>{s}</option>)}</select></p><label>Completion notes<textarea value={selected.completion_notes ?? ''} onChange={e=>setSelected(prev => prev ? {...prev,completion_notes:e.target.value}:prev)} /></label><button onClick={updateStatus}>Update</button></div>}
  </div>;
}
