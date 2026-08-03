import { FormEvent, useEffect, useMemo, useState } from 'react';
import PageHeader from '../components/ui/PageHeader';
import { KpiStrip, ChartCard, DonutChart, BarMeter, CHART_COLORS, ModuleAlerts } from '../components/ui';
import { api } from '../services/api';
import { useModules } from '../hooks/useModules';
import DisabledModule from '../components/DisabledModule';
import { useTabParam } from '../hooks/useTabParam';
import { useFocusTarget, focusAttr } from '../hooks/useFocusTarget';
import { formatBadge, toDisplay, useLookupData, type ComplaintDetail, type LoadState, type RiskDetail } from './qmsShared';
import type { ActionRecord, ComplaintRecord, RiskRecord } from '../../shared/types/api';


// Named so a dashboard alert can aim at a tab by name (?tab=Complaints Register).
const COMPLAINT_TABS = ['Dashboard', 'Complaints Register', 'New Complaint', 'Investigation', 'Trends placeholder', 'Reports placeholder'];
const RISK_TABS = ['Dashboard', 'Risk Register', 'New Risk', 'Reviews Due', 'Reports placeholder'];

export function ComplaintsPage({ embedded = false }: { embedded?: boolean } = {}) {
  const { isEnabled } = useModules();
  const { staff, sections } = useLookupData();
  const [tab, setTab] = useState(embedded ? 'Complaints Register' : 'Dashboard');
  useTabParam(COMPLAINT_TABS, setTab);
  const [complaints, setComplaints] = useState<ComplaintRecord[]>([]);
  // A dashboard alert lands here with ?tab= and ?focus=; this scrolls to the
  // record it names and flashes it.
  useFocusTarget(complaints);
  const [selected, setSelected] = useState<ComplaintDetail | null>(null);
  const [formState, setFormState] = useState({ receivedDate: '', source: '', complainantType: '', complainantName: '', contact: '', sectionId: '', category: '', title: '', description: '', assignedToStaffId: '' });
  const [workflowState, setWorkflowState] = useState({ assignedToStaffId: '', acknowledgementStatus: 'assigned', investigationSummary: '', rootCause: '', correction: '', closureSummary: '' });
  const [loadState, setLoadState] = useState<LoadState>({ loading: false, error: null });
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  useEffect(() => { if (!embedded && !isEnabled('complaints')) return; void load(); }, [isEnabled]);

  async function load() {
    setLoadState({ loading: true, error: null });
    try {
      setComplaints(await api<ComplaintRecord[]>('/complaints'));
    } catch (error) {
      setLoadState({ loading: false, error: (error as Error).message });
      return;
    }
    setLoadState({ loading: false, error: null });
  }

  async function loadComplaintDetail(id: number) {
    try {
      setSelected(await api<ComplaintDetail>(`/complaints/${id}`));
    } catch (error) {
      setLoadState({ loading: false, error: (error as Error).message });
    }
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!formState.title || !formState.description || !formState.receivedDate || !formState.complainantType || !formState.category) {
      setLoadState({ loading: false, error: 'Title, description, received date, complainant type, and category are required.' });
      return;
    }
    setLoadState({ loading: true, error: null });
    try {
      await api('/complaints', { method: 'POST', body: JSON.stringify({ ...formState, departmentId: undefined }) });
      setFormState({ receivedDate: '', source: '', complainantType: '', complainantName: '', contact: '', sectionId: '', category: '', title: '', description: '', assignedToStaffId: '' });
      await load();
    } catch (error) {
      setLoadState({ loading: false, error: (error as Error).message });
      return;
    }
    setLoadState({ loading: false, error: null });
  }

  async function assignComplaint(id: number) {
    if (!workflowState.assignedToStaffId) {
      setLoadState({ loading: false, error: 'Selecting an assigned staff member is required.' });
      return;
    }
    setLoadState({ loading: true, error: null });
    try {
      await api(`/complaints/${id}/assign`, { method: 'POST', body: JSON.stringify({ assignedToStaffId: workflowState.assignedToStaffId, acknowledgementStatus: workflowState.acknowledgementStatus }) });
      await load();
      await loadComplaintDetail(id);
    } catch (error) {
      setLoadState({ loading: false, error: (error as Error).message });
      return;
    }
    setLoadState({ loading: false, error: null });
  }

  async function investigateComplaint(id: number) {
    if (!workflowState.investigationSummary || !workflowState.rootCause || !workflowState.correction) {
      setLoadState({ loading: false, error: 'Investigation summary, root cause, and correction are required.' });
      return;
    }
    setLoadState({ loading: true, error: null });
    try {
      await api(`/complaints/${id}/investigate`, { method: 'POST', body: JSON.stringify({ investigationSummary: workflowState.investigationSummary, rootCause: workflowState.rootCause, correction: workflowState.correction, status: 'investigating' }) });
      await load();
      await loadComplaintDetail(id);
    } catch (error) {
      setLoadState({ loading: false, error: (error as Error).message });
      return;
    }
    setLoadState({ loading: false, error: null });
  }

  async function createNcFromComplaint(id: number) {
    setLoadState({ loading: true, error: null });
    try {
      await api(`/complaints/${id}/create-nc`, { method: 'POST', body: JSON.stringify({}) });
      await load();
      await loadComplaintDetail(id);
    } catch (error) {
      setLoadState({ loading: false, error: (error as Error).message });
      return;
    }
    setLoadState({ loading: false, error: null });
  }

  async function createCapaFromComplaint(id: number) {
    setLoadState({ loading: true, error: null });
    try {
      await api(`/complaints/${id}/create-capa`, { method: 'POST', body: JSON.stringify({}) });
      await load();
      await loadComplaintDetail(id);
    } catch (error) {
      setLoadState({ loading: false, error: (error as Error).message });
      return;
    }
    setLoadState({ loading: false, error: null });
  }

  async function closeComplaint(id: number) {
    if (!workflowState.closureSummary) {
      setLoadState({ loading: false, error: 'Closure summary is required to close the complaint.' });
      return;
    }
    setLoadState({ loading: true, error: null });
    try {
      await api(`/complaints/${id}/close`, { method: 'POST', body: JSON.stringify({ closureSummary: workflowState.closureSummary }) });
      await load();
      await loadComplaintDetail(id);
    } catch (error) {
      setLoadState({ loading: false, error: (error as Error).message });
      return;
    }
    setLoadState({ loading: false, error: null });
  }

  const statusOptions = ['new', 'received', 'assigned', 'investigating', 'action_required', 'closed'];
  const filteredComplaints = useMemo(() => complaints.filter(c => {
    const term = search.toLowerCase();
    const matchesSearch = !term || c.complaint_number.toLowerCase().includes(term) || c.title.toLowerCase().includes(term) || c.description.toLowerCase().includes(term);
    const matchesStatus = !statusFilter || c.status === statusFilter;
    return matchesSearch && matchesStatus;
  }), [complaints, search, statusFilter]);

  if (!embedded && !isEnabled('complaints')) return <DisabledModule />;

  return <div>
    {!embedded && <PageHeader eyebrow="Customer Focus" title="Complaints Register" subtitle="Complaints intake, investigation, and resolution." />}
    <div className="tabs">{COMPLAINT_TABS.filter(name => !embedded || name !== 'Dashboard').map(name => <button key={name} className={tab === name ? 'active' : ''} onClick={() => setTab(name)}>{name}</button>)}</div>
    {loadState.error && <div className="card"><strong>Error:</strong> {loadState.error}</div>}
    {loadState.loading && <div className="card"><em>Loading complaints…</em></div>}
    {tab === 'Dashboard' && <><ModuleAlerts moduleKey="complaints" /><KpiStrip items={[
      { label: 'Open complaints', value: complaints.filter(c => c.status !== 'closed').length, onClick: () => setTab('Complaints Register') },
      { label: 'Under investigation', value: complaints.filter(c => c.status === 'investigating').length, onClick: () => setTab('Investigation') },
      { label: 'Overdue', value: complaints.filter(c => c.status !== 'closed' && c.received_date && new Date(c.received_date).getTime() + 1000 * 60 * 60 * 24 * 30 < Date.now()).length, tone: 'danger', onClick: () => setTab('Complaints Register') },
      { label: 'Closed', value: complaints.filter(c => c.status === 'closed').length, onClick: () => setTab('Complaints Register') },
      { label: 'Linked CAPAs', value: complaints.filter(c => c.capa_required === 1).length, onClick: () => setTab('Complaints Register') },
    ]} />
    <div className="grid cols-2" style={{ marginTop: 18 }}>
      <ChartCard title="Complaint status mix" subtitle="Distribution across the resolution lifecycle">
        <DonutChart centerLabel="Total" data={[
          { label: 'Under investigation', value: complaints.filter(c => c.status === 'investigating').length, color: CHART_COLORS[2] },
          { label: 'Open (other)', value: complaints.filter(c => c.status !== 'closed' && c.status !== 'investigating').length, color: CHART_COLORS[0] },
          { label: 'Closed', value: complaints.filter(c => c.status === 'closed').length, color: CHART_COLORS[1] },
        ]} />
      </ChartCard>
      <ChartCard title="Follow-up load" subtitle="Items needing escalation or linked corrective action">
        <BarMeter data={[
          { label: 'Overdue', value: complaints.filter(c => c.status !== 'closed' && c.received_date && new Date(c.received_date).getTime() + 1000 * 60 * 60 * 24 * 30 < Date.now()).length, color: CHART_COLORS[3] },
          { label: 'Linked CAPAs', value: complaints.filter(c => c.capa_required === 1).length, color: CHART_COLORS[4] },
          { label: 'Under investigation', value: complaints.filter(c => c.status === 'investigating').length, color: CHART_COLORS[2] },
        ]} />
      </ChartCard>
    </div></>}
    {tab === 'Complaints Register' && <div className="card">
      <div className="form" style={{ gridTemplateColumns: '1fr auto', alignItems: 'end' }}>
        <label>Search<input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search complaint number, title" /></label>
        <label>Status<select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}><option value="">All</option>{statusOptions.map(status => <option key={status} value={status}>{status.replace(/_/g, ' ')}</option>)}</select></label>
      </div>
      {filteredComplaints.length === 0 ? <p>No complaints match the current filters.</p> : <table className="table"><thead><tr><th>No.</th><th>Date</th><th>Source</th><th>Type</th><th>Category</th><th>Title</th><th>Assigned</th><th>Status</th><th>Actions</th></tr></thead><tbody>{filteredComplaints.map(c => <tr key={c.id} {...focusAttr('complaints', c.id)}><td>{c.complaint_number}</td><td>{c.received_date}</td><td>{c.source || '—'}</td><td>{c.complainant_type || '—'}</td><td>{c.category || '—'}</td><td>{c.title}</td><td>{staff.find(s => s.id === c.assigned_to_staff_id)?.fullName || toDisplay(c.assigned_to_staff_id)}</td><td>{formatBadge(c.status)}</td><td><button onClick={() => loadComplaintDetail(c.id)}>View</button></td></tr>)}</tbody></table>}
    </div>}
    {tab === 'New Complaint' && <div className="card"><form className="form" onSubmit={submit}>
      <label>Received date<input type="date" value={formState.receivedDate} onChange={e => setFormState(prev => ({ ...prev, receivedDate: e.target.value }))} required /></label>
      <label>Source<input value={formState.source} onChange={e => setFormState(prev => ({ ...prev, source: e.target.value }))} placeholder="Where the complaint came from" /></label>
      <label>Complainant type<input value={formState.complainantType} onChange={e => setFormState(prev => ({ ...prev, complainantType: e.target.value }))} placeholder="Patient, client, staff" required /></label>
      <label>Complainant name<input value={formState.complainantName} onChange={e => setFormState(prev => ({ ...prev, complainantName: e.target.value }))} placeholder="Optional name" /></label>
      <label>Contact<input value={formState.contact} onChange={e => setFormState(prev => ({ ...prev, contact: e.target.value }))} placeholder="Phone or email" /></label>
      <label>Section<select value={formState.sectionId} onChange={e => setFormState(prev => ({ ...prev, sectionId: e.target.value }))}><option value="">Select section</option>{sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
      <label>Category<input value={formState.category} onChange={e => setFormState(prev => ({ ...prev, category: e.target.value }))} required /></label>
      <label>Title<input value={formState.title} onChange={e => setFormState(prev => ({ ...prev, title: e.target.value }))} required /></label>
      <label>Description<textarea value={formState.description} onChange={e => setFormState(prev => ({ ...prev, description: e.target.value }))} required /></label>
      <label>Assigned to<select value={formState.assignedToStaffId} onChange={e => setFormState(prev => ({ ...prev, assignedToStaffId: e.target.value }))}><option value="">None</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
      <button>Create complaint</button>
    </form></div>}
    {tab === 'Investigation' && <div className="card"><h3>Investigation tools</h3>{selected ? <div><h4>{selected.complaint_number} - {selected.title}</h4><p><strong>Status:</strong> {formatBadge(selected.status)}</p><p>{selected.description}</p><div className="form"><label>Assign to<select value={workflowState.assignedToStaffId} onChange={e => setWorkflowState(prev => ({ ...prev, assignedToStaffId: e.target.value }))}><option value="">Select staff</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label><button onClick={() => selected && assignComplaint(selected.id)}>Assign</button><label>Investigation summary<textarea value={workflowState.investigationSummary} onChange={e => setWorkflowState(prev => ({ ...prev, investigationSummary: e.target.value }))} placeholder="Enter investigation summary" /></label><label>Root cause<textarea value={workflowState.rootCause} onChange={e => setWorkflowState(prev => ({ ...prev, rootCause: e.target.value }))} placeholder="Enter root cause" /></label><label>Correction<textarea value={workflowState.correction} onChange={e => setWorkflowState(prev => ({ ...prev, correction: e.target.value }))} placeholder="Enter correction" /></label><button onClick={() => selected && investigateComplaint(selected.id)}>Investigate</button></div></div> : <p>Select a complaint from the register tab to investigate.</p>}</div>}
    {tab === 'Trends placeholder' && <div className="card"><h3>Trends placeholder</h3><p>Complaint trends and analysis will be added in a later phase while keeping the interface clean and neutral.</p></div>}
    {tab === 'Reports placeholder' && <div className="card"><h3>Reports placeholder</h3><p>Structured reporting and export workflows will be added later in the QMS polish roadmap.</p></div>}
    {selected && <div className="card"><h3>Complaint detail</h3><p><strong>{selected.title}</strong></p><p><strong>Received:</strong> {selected.received_date}</p><p><strong>Source:</strong> {selected.source || '—'}</p><p><strong>Complainant:</strong> {selected.complainant_type || '—'} {selected.complainant_name ? `(${selected.complainant_name})` : ''}</p><p><strong>Contact:</strong> {selected.contact || '—'}</p><p><strong>Section:</strong> {sections.find(s => s.id === selected.section_id)?.name || toDisplay(selected.section_id)}</p><p><strong>Category:</strong> {selected.category || '—'}</p><p><strong>Status:</strong> {formatBadge(selected.status)}</p><p><strong>Assigned:</strong> {staff.find(s => s.id === selected.assigned_to_staff_id)?.fullName || toDisplay(selected.assigned_to_staff_id)}</p><p><strong>Investigation:</strong> {selected.investigation_summary || 'Not started'}</p><p><strong>Root cause:</strong> {selected.root_cause || 'Not captured'}</p><p><strong>Correction:</strong> {selected.correction || 'Not captured'}</p><p><strong>Closure summary:</strong> {selected.closure_summary || 'Not closed'}</p>
      {selected.links?.length ? <div><h4>Linked records</h4><table className="table"><thead><tr><th>Source</th><th>Target</th><th>Notes</th></tr></thead><tbody>{selected.links.map(link => <tr key={link.id}><td>{link.source_module_key} / {link.source_record_type}#{link.source_record_id}</td><td>{link.target_module_key} / {link.target_record_type}#{link.target_record_id}</td><td>{link.notes || '—'}</td></tr>)}</tbody></table></div> : <p>No linked records available.</p>}
      <div className="form" style={{ display: 'grid', gap: '14px', marginTop: '14px' }}><h4>Workflow actions</h4><button onClick={() => selected && createNcFromComplaint(selected.id)}>Create NC</button><button onClick={() => selected && createCapaFromComplaint(selected.id)}>Create CAPA</button><label>Closure summary<textarea value={workflowState.closureSummary} onChange={e => setWorkflowState(prev => ({ ...prev, closureSummary: e.target.value }))} placeholder="Enter closure summary before closing" /></label><button className="secondary" onClick={() => selected && closeComplaint(selected.id)}>Close complaint</button></div>
    </div>}
  </div>;
}

export function RisksPage({ embedded = false }: { embedded?: boolean } = {}) {
  const { isEnabled } = useModules();
  const { staff, sections } = useLookupData();
  const [tab, setTab] = useState(embedded ? 'Risk Register' : 'Dashboard');
  useTabParam(RISK_TABS, setTab);
  const [risks, setRisks] = useState<RiskRecord[]>([]);
  useFocusTarget(risks);
  const [selected, setSelected] = useState<RiskDetail | null>(null);
  const [formState, setFormState] = useState({ sectionId: '', riskArea: '', riskDescription: '', cause: '', consequence: '', existingControls: '', likelihood: '1', severity: '1', detectability: '1', mitigationPlan: '', responsibleStaffId: '', reviewDueDate: '' });
  const [workflowState, setWorkflowState] = useState({ reviewNotes: '', nextReviewDate: '', actionTitle: '', actionDescription: '', actionAssignedToStaffId: '', actionDueDate: '', actionPriority: 'normal' });
  const [loadState, setLoadState] = useState<LoadState>({ loading: false, error: null });
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  useEffect(() => { if (!embedded && !isEnabled('risks')) return; void load(); }, [isEnabled]);

  async function load() {
    setLoadState({ loading: true, error: null });
    try {
      setRisks(await api<RiskRecord[]>('/risks'));
    } catch (error) {
      setLoadState({ loading: false, error: (error as Error).message });
      return;
    }
    setLoadState({ loading: false, error: null });
  }

  async function loadRiskDetail(id: number) {
    try {
      setSelected(await api<RiskDetail>(`/risks/${id}`));
    } catch (error) {
      setLoadState({ loading: false, error: (error as Error).message });
    }
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!formState.riskArea || !formState.riskDescription || !formState.likelihood || !formState.severity || !formState.detectability) {
      setLoadState({ loading: false, error: 'Risk area, description, likelihood, severity and detectability are required.' });
      return;
    }
    setLoadState({ loading: true, error: null });
    try {
      await api('/risks', { method: 'POST', body: JSON.stringify({ ...formState, departmentId: undefined }) });
      setFormState({ sectionId: '', riskArea: '', riskDescription: '', cause: '', consequence: '', existingControls: '', likelihood: '1', severity: '1', detectability: '1', mitigationPlan: '', responsibleStaffId: '', reviewDueDate: '' });
      await load();
    } catch (error) {
      setLoadState({ loading: false, error: (error as Error).message });
      return;
    }
    setLoadState({ loading: false, error: null });
  }

  async function reviewRisk(id: number) {
    if (!workflowState.reviewNotes || !workflowState.nextReviewDate) {
      setLoadState({ loading: false, error: 'Review notes and next review date are required.' });
      return;
    }
    setLoadState({ loading: true, error: null });
    try {
      await api(`/risks/${id}/review`, { method: 'POST', body: JSON.stringify({ reviewNotes: workflowState.reviewNotes, nextReviewDate: workflowState.nextReviewDate }) });
      await load();
      await loadRiskDetail(id);
    } catch (error) {
      setLoadState({ loading: false, error: (error as Error).message });
      return;
    }
    setLoadState({ loading: false, error: null });
  }

  async function createActionFromRisk(id: number) {
    if (!workflowState.actionTitle) {
      setLoadState({ loading: false, error: 'Action title is required.' });
      return;
    }
    setLoadState({ loading: true, error: null });
    try {
      await api(`/risks/${id}/create-action`, { method: 'POST', body: JSON.stringify({ title: workflowState.actionTitle, description: workflowState.actionDescription, assignedToStaffId: workflowState.actionAssignedToStaffId || undefined, dueDate: workflowState.actionDueDate || undefined, priority: workflowState.actionPriority }) });
      await load();
      await loadRiskDetail(id);
    } catch (error) {
      setLoadState({ loading: false, error: (error as Error).message });
      return;
    }
    setLoadState({ loading: false, error: null });
  }

  async function createCapaFromRisk(id: number) {
    setLoadState({ loading: true, error: null });
    try {
      await api(`/risks/${id}/create-capa`, { method: 'POST', body: JSON.stringify({}) });
      await load();
      await loadRiskDetail(id);
    } catch (error) {
      setLoadState({ loading: false, error: (error as Error).message });
      return;
    }
    setLoadState({ loading: false, error: null });
  }

  async function closeRisk(id: number) {
    setLoadState({ loading: true, error: null });
    try {
      await api(`/risks/${id}/close`, { method: 'POST', body: JSON.stringify({ status: 'closed' }) });
      await load();
      await loadRiskDetail(id);
    } catch (error) {
      setLoadState({ loading: false, error: (error as Error).message });
      return;
    }
    setLoadState({ loading: false, error: null });
  }

  const statusOptions = ['active', 'mitigation_in_progress', 'review_due', 'closed'];
  const filteredRisks = useMemo(() => risks.filter(r => {
    const term = search.toLowerCase();
    const matchesSearch = !term || r.risk_number.toLowerCase().includes(term) || r.risk_area.toLowerCase().includes(term) || r.risk_description?.toLowerCase().includes(term);
    const matchesStatus = !statusFilter || r.status === statusFilter;
    return matchesSearch && matchesStatus;
  }), [risks, search, statusFilter]);

  const high = risks.filter(r => r.risk_level === 'High' || r.risk_level === 'Critical').length;
  const reviewsDue = risks.filter(r => r.review_due_date && new Date(r.review_due_date) <= new Date()).length;
  const mitigationOverdue = risks.filter(r => r.status !== 'closed' && r.review_due_date && new Date(r.review_due_date) < new Date()).length;

  if (!embedded && !isEnabled('risks')) return <DisabledModule />;

  return <div>
    {!embedded && <PageHeader eyebrow="Continual Improvement" title="Risk Register" subtitle="Risk identification, mitigation, and periodic review." />}
    <div className="tabs">{RISK_TABS.filter(name => !embedded || name !== 'Dashboard').map(name => <button key={name} className={tab === name ? 'active' : ''} onClick={() => setTab(name)}>{name}</button>)}</div>
    {loadState.error && <div className="card"><strong>Error:</strong> {loadState.error}</div>}
    {loadState.loading && <div className="card"><em>Loading risk register…</em></div>}
    {tab === 'Dashboard' && <><ModuleAlerts moduleKey="risks" /><KpiStrip items={[
      { label: 'Active risks', value: risks.filter(r => r.status !== 'closed').length, onClick: () => setTab('Risk Register') },
      { label: 'High / critical risks', value: high, tone: 'warning', onClick: () => setTab('Risk Register') },
      { label: 'Reviews due', value: reviewsDue, onClick: () => setTab('Reviews Due') },
      { label: 'Mitigation overdue', value: mitigationOverdue, tone: 'danger', onClick: () => setTab('Risk Register') },
      { label: 'Critical risk flags', value: risks.filter(r => r.risk_level === 'Critical').length, onClick: () => setTab('Risk Register') },
    ]} />
    <div className="grid cols-2" style={{ marginTop: 18 }}>
      <ChartCard title="Risk severity profile" subtitle="Active register grouped by rated level">
        <DonutChart centerLabel="Active" data={[
          { label: 'Critical', value: risks.filter(r => r.risk_level === 'Critical').length, color: CHART_COLORS[3] },
          { label: 'High', value: risks.filter(r => r.risk_level === 'High').length, color: CHART_COLORS[2] },
          { label: 'Medium', value: risks.filter(r => r.risk_level === 'Medium').length, color: CHART_COLORS[0] },
          { label: 'Low', value: risks.filter(r => r.risk_level === 'Low').length, color: CHART_COLORS[1] },
        ]} />
      </ChartCard>
      <ChartCard title="Review & mitigation status" subtitle="Outstanding review and treatment actions">
        <BarMeter data={[
          { label: 'Reviews due', value: reviewsDue, color: CHART_COLORS[2] },
          { label: 'Mitigation overdue', value: mitigationOverdue, color: CHART_COLORS[3] },
          { label: 'High / critical', value: high, color: CHART_COLORS[4] },
        ]} />
      </ChartCard>
    </div></>}
    {tab === 'Risk Register' && <div className="card">
      <div className="form" style={{ gridTemplateColumns: '1fr auto', alignItems: 'end' }}>
        <label>Search<input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search risk number, area" /></label>
        <label>Status<select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}><option value="">All</option>{statusOptions.map(status => <option key={status} value={status}>{status.replace(/_/g, ' ')}</option>)}</select></label>
      </div>
      {filteredRisks.length === 0 ? <p>No risks match the current filters.</p> : <table className="table"><thead><tr><th>Risk No.</th><th>Area</th><th>Description</th><th>Score</th><th>Level</th><th>Responsible</th><th>Review Due</th><th>Status</th><th>Actions</th></tr></thead><tbody>{filteredRisks.map(r => <tr key={r.id} {...focusAttr('risks', r.id)}><td>{r.risk_number}</td><td>{r.risk_area}</td><td>{r.risk_description}</td><td>{r.risk_score || '—'}</td><td>{r.risk_level || '—'}</td><td>{staff.find(s => s.id === r.responsible_staff_id)?.fullName || toDisplay(r.responsible_staff_id)}</td><td>{r.review_due_date || 'N/A'}</td><td>{formatBadge(r.status)}</td><td><button onClick={() => loadRiskDetail(r.id)}>View</button></td></tr>)}</tbody></table>}
    </div>}
    {tab === 'New Risk' && <div className="card"><form className="form" onSubmit={submit}>
      <label>Section<select value={formState.sectionId} onChange={e => setFormState(prev => ({ ...prev, sectionId: e.target.value }))}><option value="">Select section</option>{sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
      <label>Risk area<input value={formState.riskArea} onChange={e => setFormState(prev => ({ ...prev, riskArea: e.target.value }))} placeholder="Describe the risk area" required /></label>
      <label>Risk description<textarea value={formState.riskDescription} onChange={e => setFormState(prev => ({ ...prev, riskDescription: e.target.value }))} placeholder="Describe the risk" required /></label>
      <label>Cause<textarea value={formState.cause} onChange={e => setFormState(prev => ({ ...prev, cause: e.target.value }))} placeholder="Root cause or source" /></label>
      <label>Consequence<textarea value={formState.consequence} onChange={e => setFormState(prev => ({ ...prev, consequence: e.target.value }))} placeholder="Potential consequence" /></label>
      <label>Existing controls<textarea value={formState.existingControls} onChange={e => setFormState(prev => ({ ...prev, existingControls: e.target.value }))} placeholder="Existing control measures" /></label>
      <label>Likelihood<input type="number" min="1" max="5" value={formState.likelihood} onChange={e => setFormState(prev => ({ ...prev, likelihood: e.target.value }))} required /></label>
      <label>Severity<input type="number" min="1" max="5" value={formState.severity} onChange={e => setFormState(prev => ({ ...prev, severity: e.target.value }))} required /></label>
      <label>Detectability<input type="number" min="1" max="5" value={formState.detectability} onChange={e => setFormState(prev => ({ ...prev, detectability: e.target.value }))} required /></label>
      <label>Mitigation plan<textarea value={formState.mitigationPlan} onChange={e => setFormState(prev => ({ ...prev, mitigationPlan: e.target.value }))} placeholder="Planned mitigation" /></label>
      <label>Responsible<select value={formState.responsibleStaffId} onChange={e => setFormState(prev => ({ ...prev, responsibleStaffId: e.target.value }))}><option value="">Select staff</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
      <label>Review due date<input type="date" value={formState.reviewDueDate} onChange={e => setFormState(prev => ({ ...prev, reviewDueDate: e.target.value }))} /></label>
      <button>Create risk</button>
    </form></div>}
    {tab === 'Reviews Due' && <div className="card"><table className="table"><thead><tr><th>Risk No.</th><th>Area</th><th>Review Due</th><th>Status</th><th>Actions</th></tr></thead><tbody>{risks.filter(r => r.review_due_date && new Date(r.review_due_date) <= new Date()).map(r => <tr key={r.id}><td>{r.risk_number}</td><td>{r.risk_area}</td><td>{r.review_due_date}</td><td>{formatBadge(r.status)}</td><td><button onClick={() => loadRiskDetail(r.id)}>View</button> <button onClick={() => reviewRisk(r.id)}>Review</button> <button className="secondary" onClick={() => closeRisk(r.id)}>Close</button></td></tr>)}</tbody></table>{risks.filter(r => r.review_due_date && new Date(r.review_due_date) <= new Date()).length === 0 && <p>No reviews are due right now.</p>}</div>}
    {tab === 'Reports placeholder' && <div className="card"><h3>Reports placeholder</h3><p>Risk register reporting and performance summaries will be introduced in a later phase while keeping QMS language neutral.</p></div>}
    {selected && <div className="card"><h3>Risk detail</h3>
      <p><strong>{selected.risk_number}</strong></p>
      <p><strong>Section:</strong> {sections.find(s => s.id === selected.section_id)?.name || toDisplay(selected.section_id)}</p>
      <p><strong>Area:</strong> {selected.risk_area}</p>
      <p><strong>Description:</strong> {selected.risk_description || '—'}</p>
      <p><strong>Cause:</strong> {selected.cause || '—'}</p>
      <p><strong>Consequence:</strong> {selected.consequence || '—'}</p>
      <p><strong>Existing controls:</strong> {selected.existing_controls || '—'}</p>
      <p><strong>Likelihood:</strong> {selected.likelihood ?? '—'}</p>
      <p><strong>Severity:</strong> {selected.severity ?? '—'}</p>
      <p><strong>Detectability:</strong> {selected.detectability ?? '—'}</p>
      <p><strong>Risk score:</strong> {selected.risk_score ?? '—'}</p>
      <p><strong>Risk level:</strong> {selected.risk_level || '—'}</p>
      <p><strong>Mitigation plan:</strong> {selected.mitigation_plan || '—'}</p>
      <p><strong>Responsible:</strong> {staff.find(s => s.id === selected.responsible_staff_id)?.fullName || toDisplay(selected.responsible_staff_id)}</p>
      <p><strong>Review due:</strong> {selected.review_due_date || 'N/A'}</p>
      <p><strong>Status:</strong> {formatBadge(selected.status)}</p>
      {selected.residual_score !== undefined && <p><strong>Residual score:</strong> {selected.residual_score}</p>}
      {selected.links?.length ? <div><h4>Linked records</h4><table className="table"><thead><tr><th>Source</th><th>Target</th><th>Notes</th></tr></thead><tbody>{selected.links.map(link => <tr key={link.id}><td>{link.source_module_key} / {link.source_record_type}#{link.source_record_id}</td><td>{link.target_module_key} / {link.target_record_type}#{link.target_record_id}</td><td>{link.notes || '—'}</td></tr>)}</tbody></table></div> : <p>No linked records.</p>}
      {selected.reviews?.length ? <div><h4>Review history</h4><table className="table"><thead><tr><th>Date</th><th>Risk level</th><th>Next review</th><th>Notes</th></tr></thead><tbody>{selected.reviews.map(review => <tr key={review.id}><td>{review.review_date}</td><td>{review.risk_level}</td><td>{review.next_review_date || 'N/A'}</td><td>{review.review_notes}</td></tr>)}</tbody></table></div> : <p>No review history recorded.</p>}
      <div className="form" style={{ display: 'grid', gap: '14px', marginTop: '14px' }}>
        <div><h4>Review risk</h4><label>Notes<textarea value={workflowState.reviewNotes} onChange={e => setWorkflowState(prev => ({ ...prev, reviewNotes: e.target.value }))} placeholder="Enter review notes" /></label><label>Next review date<input type="date" value={workflowState.nextReviewDate} onChange={e => setWorkflowState(prev => ({ ...prev, nextReviewDate: e.target.value }))} /></label><button onClick={() => reviewRisk(selected.id)}>Submit review</button></div>
        <div><h4>Action from risk</h4><label>Title<input value={workflowState.actionTitle} onChange={e => setWorkflowState(prev => ({ ...prev, actionTitle: e.target.value }))} placeholder="Action title" /></label><label>Description<textarea value={workflowState.actionDescription} onChange={e => setWorkflowState(prev => ({ ...prev, actionDescription: e.target.value }))} placeholder="Enter action description" /></label><label>Assigned to<select value={workflowState.actionAssignedToStaffId} onChange={e => setWorkflowState(prev => ({ ...prev, actionAssignedToStaffId: e.target.value }))}><option value="">Select staff</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label><label>Due date<input type="date" value={workflowState.actionDueDate} onChange={e => setWorkflowState(prev => ({ ...prev, actionDueDate: e.target.value }))} /></label><label>Priority<select value={workflowState.actionPriority} onChange={e => setWorkflowState(prev => ({ ...prev, actionPriority: e.target.value }))}><option value="normal">Normal</option><option value="high">High</option><option value="low">Low</option></select></label><button onClick={() => createActionFromRisk(selected.id)}>Create action</button></div>
        <div><h4>Link CAPA</h4><button onClick={() => createCapaFromRisk(selected.id)}>Create CAPA</button><button className="secondary" onClick={() => closeRisk(selected.id)}>Close risk</button></div>
      </div>
    </div>}
  </div>;
}

export function QmsActionTracker({ embedded = false }: { embedded?: boolean } = {}) {
  const { isEnabled } = useModules();
  const { staff } = useLookupData();
  const [actions, setActions] = useState<ActionRecord[]>([]);
  const [statusFilter, setStatusFilter] = useState('');
  const [staffFilter, setStaffFilter] = useState('');
  const [overdueFilter, setOverdueFilter] = useState(false);
  const [selected, setSelected] = useState<ActionRecord | null>(null);
  const [formState, setFormState] = useState({ title: '', moduleKey: 'nc_capa', sourceModule: '', sourceRecordId: '', description: '', assignedToStaffId: '', dueDate: '', priority: 'normal', status: 'Not started', evidenceRequired: false, completionNotes: '' });
  const [loadState, setLoadState] = useState<LoadState>({ loading: false, error: null });

  useEffect(() => { if (!embedded && !isEnabled('actions')) return; void load(); }, [isEnabled]);

  async function load() {
    setLoadState({ loading: true, error: null });
    try {
      const query = new URLSearchParams();
      if (statusFilter) query.set('status', statusFilter);
      if (staffFilter) query.set('assignedToStaffId', staffFilter);
      if (overdueFilter) query.set('overdue', 'true');
      setActions(await api<ActionRecord[]>(`/actions?${query.toString()}`));
    } catch (error) {
      setLoadState({ loading: false, error: (error as Error).message });
      return;
    }
    setLoadState({ loading: false, error: null });
  }

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!formState.title) {
      setLoadState({ loading: false, error: 'Action title is required.' });
      return;
    }
    setLoadState({ loading: true, error: null });
    try {
      await api('/actions', { method: 'POST', body: JSON.stringify({ ...formState, assignedToStaffId: formState.assignedToStaffId || undefined, evidenceRequired: formState.evidenceRequired }) });
      setFormState({ title: '', moduleKey: 'nc_capa', sourceModule: '', sourceRecordId: '', description: '', assignedToStaffId: '', dueDate: '', priority: 'normal', status: 'Not started', evidenceRequired: false, completionNotes: '' });
      await load();
    } catch (error) {
      setLoadState({ loading: false, error: (error as Error).message });
      return;
    }
    setLoadState({ loading: false, error: null });
  }

  async function updateStatus() {
    if (!selected) return;
    setLoadState({ loading: true, error: null });
    try {
      await api(`/actions/${selected.id}`, { method: 'PUT', body: JSON.stringify({ ...selected, status: selected.status, completionNotes: selected.completion_notes }) });
      await load();
    } catch (error) {
      setLoadState({ loading: false, error: (error as Error).message });
      return;
    }
    setLoadState({ loading: false, error: null });
  }

  const statusOptions = ['Not started', 'In progress', 'Waiting for evidence', 'Submitted for review', 'Completed', 'Verified', 'Closed', 'Reopened', 'Overdue'];

  if (!embedded && !isEnabled('actions')) return <DisabledModule />;

  return <div>
    {!embedded && <PageHeader eyebrow="Nonconforming Event Management" title="Action Tracker" subtitle="Centralized actions, owners, due dates, and status." />}
    {loadState.error && <div className="card"><strong>Error:</strong> {loadState.error}</div>}
    {loadState.loading && <div className="card"><em>Loading actions…</em></div>}
    <div className="card"><h3>Filters</h3><div className="form" style={{ gridTemplateColumns: '1fr auto auto', alignItems: 'end' }}><label>Status<select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}><option value="">All</option>{statusOptions.map(s => <option key={s} value={s}>{s}</option>)}</select></label><label>Assigned staff<select value={staffFilter} onChange={e => setStaffFilter(e.target.value)}><option value="">All</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label><label><input type="checkbox" checked={overdueFilter} onChange={e => setOverdueFilter(e.target.checked)} /> Overdue only</label><button onClick={load}>Refresh</button></div></div>
    <div className="card"><h3>Create action</h3><form className="form" onSubmit={create}><label>Title<input value={formState.title} onChange={e => setFormState(prev => ({ ...prev, title: e.target.value }))} required /></label><label>Source module<input value={formState.sourceModule} onChange={e => setFormState(prev => ({ ...prev, sourceModule: e.target.value }))} placeholder="e.g. nc_capa" /></label><label>Source record ID<input value={formState.sourceRecordId} onChange={e => setFormState(prev => ({ ...prev, sourceRecordId: e.target.value }))} placeholder="Record ID" /></label><label>Description<textarea value={formState.description} onChange={e => setFormState(prev => ({ ...prev, description: e.target.value }))} /></label><label>Assigned to<select value={formState.assignedToStaffId} onChange={e => setFormState(prev => ({ ...prev, assignedToStaffId: e.target.value }))}><option value="">None</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label><label>Due date<input type="date" value={formState.dueDate} onChange={e => setFormState(prev => ({ ...prev, dueDate: e.target.value }))} /></label><label>Priority<select value={formState.priority} onChange={e => setFormState(prev => ({ ...prev, priority: e.target.value }))}><option>normal</option><option>high</option><option>low</option></select></label><label>Status<select value={formState.status} onChange={e => setFormState(prev => ({ ...prev, status: e.target.value }))}>{statusOptions.map(s => <option key={s} value={s}>{s}</option>)}</select></label><label><input type="checkbox" checked={formState.evidenceRequired} onChange={e => setFormState(prev => ({ ...prev, evidenceRequired: e.target.checked }))} /> Evidence required</label><label>Completion notes<textarea value={formState.completionNotes} onChange={e => setFormState(prev => ({ ...prev, completionNotes: e.target.value }))} /></label><button>Create action</button></form></div>
    <div className="card"><h3>Actions</h3>{actions.length === 0 ? <p>No actions match the current filters.</p> : <table className="table"><thead><tr><th>Title</th><th>Source</th><th>Assigned</th><th>Due</th><th>Priority</th><th>Status</th><th>Actions</th></tr></thead><tbody>{actions.map(action => <tr key={action.id}><td>{action.title}</td><td>{action.source_module || action.module_key}#{action.source_record_id || ''}</td><td>{staff.find(s => s.id === action.assigned_to_staff_id)?.fullName || toDisplay(action.assigned_to_staff_id)}</td><td>{action.due_date || 'N/A'}</td><td>{action.priority}</td><td>{formatBadge(action.status)}</td><td><button onClick={() => setSelected(action)}>Select</button></td></tr>)}</tbody></table>}</div>
    {selected && <div className="card"><h3>Action detail</h3><p><strong>{selected.title}</strong></p><p><strong>Source</strong> {selected.source_module || selected.module_key} / {selected.source_record_id || 'N/A'}</p><p><strong>Assigned</strong> {staff.find(s => s.id === selected.assigned_to_staff_id)?.fullName || toDisplay(selected.assigned_to_staff_id)}</p><label>Status<select value={selected.status} onChange={e => setSelected(prev => prev ? { ...prev, status: e.target.value } : prev)}>{statusOptions.map(s => <option key={s} value={s}>{s}</option>)}</select></label><label>Completion notes<textarea value={selected.completion_notes ?? ''} onChange={e => setSelected(prev => prev ? { ...prev, completion_notes: e.target.value } : prev)} /></label><div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}><button onClick={updateStatus}>Update</button><button className="secondary" onClick={() => setSelected(prev => prev ? { ...prev, status: 'Completed' } : prev)}>Mark completed</button><button className="secondary" onClick={() => setSelected(prev => prev ? { ...prev, status: 'Reopened' } : prev)}>Reopen</button></div></div>}
  </div>;
}
