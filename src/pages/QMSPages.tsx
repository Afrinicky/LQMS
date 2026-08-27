import { FormEvent, useEffect, useMemo, useState } from 'react';
import PageHeader from '../components/ui/PageHeader';
import { KpiStrip, ChartCard, DonutChart, BarMeter, CHART_COLORS, ModuleAlerts, RegisterSearch } from '../components/ui';
import { api } from '../services/api';
import { useModules } from '../hooks/useModules';
import DisabledModule from '../components/DisabledModule';
import { useTabParam } from '../hooks/useTabParam';
import PermissionTabs from '../components/PermissionTabs';
import { useFocusTarget, focusAttr } from '../hooks/useFocusTarget';
import { formatBadge, toDisplay, useLookupData, type LoadState, type RiskDetail } from './qmsShared';
import type { ActionRecord, RiskRecord } from '../../shared/types/api';


// Complaints moved to their own file when the module was rebuilt around the
// handling process ISO 15189 §7.4 describes; re-exported so every existing
// import keeps working.
export { ComplaintsPage } from './ComplaintsPage';

const RISK_TABS = ['Dashboard', 'Risk Register', 'New Risk', 'Reviews Due', 'Reports placeholder'];

export function RisksPage({ embedded = false }: { embedded?: boolean } = {}) {
  const { isEnabled } = useModules();
  const { staff, sections } = useLookupData();
  const [tab, setTab] = useState(embedded ? 'Risk Register' : 'Dashboard');
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
    <PermissionTabs moduleKey="risks" tabs={RISK_TABS.filter(name => !embedded || name !== 'Dashboard')} active={tab} onChange={setTab} />
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
        <label>Search<RegisterSearch onQuery={setSearch} placeholder="Search risk number, area" /></label>
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
