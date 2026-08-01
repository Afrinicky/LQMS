import { FormEvent, useEffect, useMemo, useState } from 'react';
import PageHeader from '../components/ui/PageHeader';
import { KpiStrip, ChartCard, DonutChart, BarMeter, CHART_COLORS, ModuleAlerts } from '../components/ui';
import { api, API_BASE, getToken } from '../services/api';
import { useModules } from '../hooks/useModules';
import DisabledModule from '../components/DisabledModule';
import RiskMatrix, { riskLevelBadge } from '../components/RiskMatrix';
import XlsxToolbar from '../components/XlsxToolbar';
import IncidentsBoard from './IncidentsBoard';
import type { ActionRecord, ComplaintRecord, CapaRecord, NonconformingEvent, QmsSummary, RiskRecord, Section, Staff } from '../../shared/types/api';

async function openNcPrint(path: string, onError: (m: string) => void) {
  try {
    const token = getToken();
    const res = await fetch(`${API_BASE}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : undefined });
    if (!res.ok) throw new Error(await res.text() || res.statusText);
    const w = window.open('', '_blank'); if (!w) { onError('Allow pop-ups to open the form.'); return; }
    w.document.open(); w.document.write(await res.text()); w.document.close();
  } catch (e) { onError((e as Error).message); }
}
const NC_TYPE_OPTIONS = [
  { v: 'pre_analytical', l: 'Pre-analytical (sample collection, labelling, transport)' },
  { v: 'analytical', l: 'Analytical (equipment malfunction, reagent issue, SOP deviation)' },
  { v: 'post_analytical', l: 'Post-analytical (reporting error, result communication)' },
  { v: 'safety_environment', l: 'Safety / Environment (spill, exposure, waste handling)' },
  { v: 'other', l: 'Other' },
];
const RCA_METHOD_OPTIONS = [{ v: '5_whys', l: '5 Whys' }, { v: 'fishbone', l: 'Fishbone (Ishikawa)' }, { v: 'pareto', l: 'Pareto analysis' }, { v: 'fault_tree', l: 'Fault tree' }, { v: 'other', l: 'Other' }];

type RecordLink = { id: number; source_module_key: string; source_record_type: string; source_record_id: string; target_module_key: string; target_record_type: string; target_record_id: string; notes?: string };
type NonconformingEventDetail = NonconformingEvent & { links?: RecordLink[] };
type CapaDetail = CapaRecord & { links?: RecordLink[]; updates?: { id: number; update_date: string; update_text: string; status: string }[] };
type ComplaintDetail = ComplaintRecord & { links?: RecordLink[] };
type RiskDetail = RiskRecord & { links?: RecordLink[]; reviews?: { id: number; review_date: string; review_notes: string; risk_score: number; risk_level: string; next_review_date?: string }[] };

type LoadState = { loading: boolean; error: string | null };

const badgeStyles: Record<string, string> = {
  open: 'badge badge--blue',
  reviewed: 'badge badge--info',
  capa_required: 'badge badge--warning',
  closed: 'badge badge--success',
  in_progress: 'badge badge--warning',
  completed: 'badge badge--success',
  verified: 'badge badge--success',
  effectiveness_pending: 'badge badge--warning',
  reopened: 'badge badge--warning',
  overdue: 'badge badge--danger',
  new: 'badge badge--info',
  assigned: 'badge badge--warning',
  investigating: 'badge badge--warning',
  action_required: 'badge badge--warning',
  active: 'badge badge--info',
  mitigation_in_progress: 'badge badge--warning',
  review_due: 'badge badge--warning',
  pending: 'badge badge--warning',
};

const formatBadge = (status: string | undefined) => {
  if (!status) return <span className="badge">Unknown</span>;
  return <span className={badgeStyles[status] || 'badge'}>{status.replace(/_/g, ' ')}</span>;
};

const toDisplay = (value: unknown) => (value || value === 0 ? String(value) : '—');

function useLookupData() {
  const [staff, setStaff] = useState<Staff[]>([]);
  const [sections, setSections] = useState<Section[]>([]);

  useEffect(() => {
    api<Staff[]>('/staff').then(setStaff).catch(() => setStaff([]));
    api<Section[]>('/sections').then(setSections).catch(() => setSections([]));
  }, []);

  return { staff, sections };
}

export function NcCapaPage() {
  const { isEnabled } = useModules();
  const { staff, sections } = useLookupData();
  const [tab, setTab] = useState('Dashboard');
  const [ncList, setNcList] = useState<NonconformingEvent[]>([]);
  const [capaList, setCapaList] = useState<CapaRecord[]>([]);
  const [summary, setSummary] = useState<QmsSummary | null>(null);
  const [selectedNc, setSelectedNc] = useState<NonconformingEventDetail | null>(null);
  const [selectedCapa, setSelectedCapa] = useState<CapaDetail | null>(null);
  const emptyNcForm = { eventDate: new Date().toISOString().slice(0, 10), timeOfEvent: '', detectedByStaffId: '', detectedByName: '', sectionId: '', ncType: 'pre_analytical', ncTypeOther: '', title: '', description: '', immediateCorrection: '', remedialAction: '', occurrenceScore: null as number | null, severityScore: null as number | null, investigationTeam: '', rootCause: '', rcaMethod: '5_whys', correctiveAction: '', preventiveAction: '', capaResponsibleStaffId: '', capaTimelineDate: '' };
  const [formState, setFormState] = useState(emptyNcForm);
  const [workflowState, setWorkflowState] = useState({ reviewStatus: 'reviewed', reviewerStaffId: '', closureNotes: '', actionTitle: '', actionDescription: '', actionAssignedToStaffId: '', actionDueDate: '', actionPriority: 'normal', capaTitle: '', capaProblemSummary: '', capaResponsibleStaffId: '', capaDueDate: '', capaPriority: 'normal' });
  const [loadState, setLoadState] = useState<LoadState>({ loading: false, error: null });
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  useEffect(() => { if (!isEnabled('nc_capa')) return; void load(); }, [isEnabled]);

  async function load() {
    setLoadState({ loading: true, error: null });
    try {
      const [ncs, capas, qms] = await Promise.all([
        api<NonconformingEvent[]>('/nonconformities'),
        api<CapaRecord[]>('/capa'),
        api<QmsSummary>('/dashboard/qms-summary'),
      ]);
      setNcList(ncs);
      setCapaList(capas);
      setSummary(qms);
    } catch (error) {
      setLoadState({ loading: false, error: (error as Error).message });
      return;
    }
    setLoadState({ loading: false, error: null });
  }

  const filteredNcs = useMemo(() => ncList.filter(n => {
    const term = search.toLowerCase();
    const matchesSearch = !term || n.nc_number.toLowerCase().includes(term) || n.title.toLowerCase().includes(term) || n.description?.toLowerCase().includes(term);
    const matchesStatus = !statusFilter || n.status === statusFilter;
    return matchesSearch && matchesStatus;
  }), [ncList, search, statusFilter]);

  const filteredCapas = useMemo(() => capaList.filter(c => {
    const term = search.toLowerCase();
    const matchesSearch = !term || c.capa_number.toLowerCase().includes(term) || c.title.toLowerCase().includes(term) || c.problem_summary?.toLowerCase().includes(term);
    const matchesStatus = !statusFilter || c.status === statusFilter;
    return matchesSearch && matchesStatus;
  }), [capaList, search, statusFilter]);

  const overdueCAPAs = capaList.filter(c => c.status !== 'closed' && c.due_date && new Date(c.due_date) < new Date());
  const effectivenessDue = capaList.filter(c => c.effectiveness_due_date && new Date(c.effectiveness_due_date) <= new Date() && c.effectiveness_status !== 'Complete');

  async function loadNcDetail(id: number) {
    try {
      const detail = await api<NonconformingEventDetail>(`/nonconformities/${id}`);
      setSelectedNc(detail);
    } catch (error) {
      setLoadState({ loading: false, error: (error as Error).message });
    }
  }

  async function loadCapaDetail(id: number) {
    try {
      const detail = await api<CapaDetail>(`/capa/${id}`);
      setSelectedCapa(detail);
    } catch (error) {
      setLoadState({ loading: false, error: (error as Error).message });
    }
  }

  async function submitNewNc(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!formState.title || !formState.description) {
      setLoadState({ loading: false, error: 'A title and a description are required.' });
      return;
    }
    setLoadState({ loading: true, error: null });
    try {
      const r = await api<{ id: number }>('/nonconformities', { method: 'POST', body: JSON.stringify(formState) });
      setFormState(emptyNcForm);
      await load();
      setTab('Nonconforming Events');
      await loadNcDetail(r.id);
    } catch (error) {
      setLoadState({ loading: false, error: (error as Error).message });
      return;
    }
    setLoadState({ loading: false, error: null });
  }
  async function saveNcField(id: number, patch: Record<string, unknown>) {
    try { await api(`/nonconformities/${id}`, { method: 'PUT', body: JSON.stringify(patch) }); await loadNcDetail(id); await load(); }
    catch (error) { setLoadState({ loading: false, error: (error as Error).message }); }
  }
  async function approveNc(id: number) {
    try { await api(`/nonconformities/${id}/approve`, { method: 'POST', body: JSON.stringify({}) }); await loadNcDetail(id); await load(); }
    catch (error) { setLoadState({ loading: false, error: (error as Error).message }); }
  }

  async function reviewNc(id: number) {
    if (!workflowState.reviewerStaffId) {
      setLoadState({ loading: false, error: 'Reviewer is required to complete NC review.' });
      return;
    }
    setLoadState({ loading: true, error: null });
    try {
      await api(`/nonconformities/${id}/review`, { method: 'POST', body: JSON.stringify({ status: workflowState.reviewStatus, reviewerStaffId: workflowState.reviewerStaffId }) });
      await load();
      await loadNcDetail(id);
    } catch (error) {
      setLoadState({ loading: false, error: (error as Error).message });
      return;
    }
    setLoadState({ loading: false, error: null });
  }

  async function closeNc(id: number) {
    setLoadState({ loading: true, error: null });
    try {
      await api(`/nonconformities/${id}/close`, { method: 'POST', body: JSON.stringify({ status: 'closed', closureNotes: workflowState.closureNotes, closedByStaffId: workflowState.reviewerStaffId }) });
      await load();
      setSelectedNc(null);
    } catch (error) {
      setLoadState({ loading: false, error: (error as Error).message });
      return;
    }
    setLoadState({ loading: false, error: null });
  }

  async function createCapaFromNc(id: number) {
    if (!workflowState.capaTitle || !workflowState.capaProblemSummary) {
      setLoadState({ loading: false, error: 'CAPA title and problem summary are required.' });
      return;
    }
    setLoadState({ loading: true, error: null });
    try {
      await api(`/nonconformities/${id}/create-capa`, { method: 'POST', body: JSON.stringify({ title: workflowState.capaTitle, problemSummary: workflowState.capaProblemSummary, responsibleStaffId: workflowState.capaResponsibleStaffId || undefined, dueDate: workflowState.capaDueDate || undefined, priority: workflowState.capaPriority }) });
      await load();
      await loadNcDetail(id);
    } catch (error) {
      setLoadState({ loading: false, error: (error as Error).message });
      return;
    }
    setLoadState({ loading: false, error: null });
  }

  async function createActionFromNc(id: number) {
    if (!workflowState.actionTitle) {
      setLoadState({ loading: false, error: 'Action title is required.' });
      return;
    }
    setLoadState({ loading: true, error: null });
    try {
      await api(`/nonconformities/${id}/create-action`, { method: 'POST', body: JSON.stringify({ title: workflowState.actionTitle, description: workflowState.actionDescription, assignedToStaffId: workflowState.actionAssignedToStaffId || undefined, dueDate: workflowState.actionDueDate || undefined, priority: workflowState.actionPriority }) });
      await load();
      await loadNcDetail(id);
    } catch (error) {
      setLoadState({ loading: false, error: (error as Error).message });
      return;
    }
    setLoadState({ loading: false, error: null });
  }

  async function reopenCapa(id: number) {
    setLoadState({ loading: true, error: null });
    try {
      await api(`/capa/${id}/reopen`, { method: 'POST', body: JSON.stringify({ status: 'reopened' }) });
      await load();
      await loadCapaDetail(id);
    } catch (error) {
      setLoadState({ loading: false, error: (error as Error).message });
      return;
    }
    setLoadState({ loading: false, error: null });
  }

  async function addCapaUpdate(id: number, updateText: string, status: string) {
    if (!updateText) {
      setLoadState({ loading: false, error: 'Update note is required.' });
      return;
    }
    setLoadState({ loading: true, error: null });
    try {
      await api(`/capa/${id}/add-update`, { method: 'POST', body: JSON.stringify({ updateText, status }) });
      await loadCapaDetail(id);
      await load();
    } catch (error) {
      setLoadState({ loading: false, error: (error as Error).message });
      return;
    }
    setLoadState({ loading: false, error: null });
  }

  async function verifyCapa(id: number, verificationNotes: string) {
    if (!verificationNotes) {
      setLoadState({ loading: false, error: 'Verification notes are required.' });
      return;
    }
    setLoadState({ loading: true, error: null });
    try {
      await api(`/capa/${id}/verify`, { method: 'POST', body: JSON.stringify({ verificationNotes, status: 'verified' }) });
      await loadCapaDetail(id);
      await load();
    } catch (error) {
      setLoadState({ loading: false, error: (error as Error).message });
      return;
    }
    setLoadState({ loading: false, error: null });
  }

  async function reviewCapaEffectiveness(id: number, effectivenessReviewNotes: string, effectivenessDueDate: string) {
    if (!effectivenessReviewNotes || !effectivenessDueDate) {
      setLoadState({ loading: false, error: 'Review notes and effectiveness due date are required.' });
      return;
    }
    setLoadState({ loading: true, error: null });
    try {
      await api(`/capa/${id}/effectiveness-review`, { method: 'POST', body: JSON.stringify({ effectivenessReviewNotes, effectivenessDueDate, effectivenessStatus: 'pending' }) });
      await loadCapaDetail(id);
      await load();
    } catch (error) {
      setLoadState({ loading: false, error: (error as Error).message });
      return;
    }
    setLoadState({ loading: false, error: null });
  }

  async function closeCapa(id: number) {
    setLoadState({ loading: true, error: null });
    try {
      await api(`/capa/${id}/close`, { method: 'POST', body: JSON.stringify({ status: 'closed' }) });
      await loadCapaDetail(id);
      await load();
    } catch (error) {
      setLoadState({ loading: false, error: (error as Error).message });
      return;
    }
    setLoadState({ loading: false, error: null });
  }

  const actionOptions = ['Not started', 'In progress', 'Waiting for evidence', 'Submitted for review', 'Completed', 'Verified', 'Closed', 'Reopened', 'Overdue'];
  const ncStatusOptions = ['open', 'reviewed', 'capa_required', 'closed'];
  const capaStatusOptions = ['open', 'in_progress', 'completed', 'verified', 'effectiveness_pending', 'closed', 'reopened', 'overdue'];

  if (!isEnabled('nc_capa')) return <DisabledModule />;

  return <div>
    <PageHeader eyebrow="Nonconforming Event Management" title="Nonconforming Events &amp; CAPA" subtitle="Incidents, investigations, and corrective/preventive actions." />
    <div className="tabs">{['Dashboard', 'Nonconforming Events', 'New Event', 'Incidents & Adverse Events', 'CAPA Register', 'Overdue CAPAs', 'Effectiveness Reviews', ...(isEnabled('actions') ? ['Action Tracker'] : []), 'Reports placeholder'].map(name => <button key={name} className={tab === name ? 'active' : ''} onClick={() => setTab(name)}>{name}</button>)}</div>
    {loadState.error && <div className="card"><strong>Error:</strong> {loadState.error}</div>}
    {loadState.loading && <div className="card"><em>Loading QMS data…</em></div>}
    {tab === 'Dashboard' && <><ModuleAlerts moduleKey="nc_capa" /><KpiStrip items={[
      { label: 'Open NCs', value: summary?.openNCs.count ?? ncList.filter(n => n.status !== 'closed').length, onClick: () => setTab('Nonconforming Events') },
      { label: 'NCs pending review', value: ncList.filter(n => n.status === 'open').length, onClick: () => setTab('Nonconforming Events') },
      { label: 'Open CAPAs', value: summary?.openCAPAs.count ?? capaList.filter(c => c.status !== 'closed').length, onClick: () => setTab('CAPA Register') },
      { label: 'Overdue CAPAs', value: overdueCAPAs.length, tone: 'danger', onClick: () => setTab('Overdue CAPAs') },
      { label: 'Effectiveness reviews due', value: effectivenessDue.length, onClick: () => setTab('Effectiveness Reviews') },
      { label: 'High risk CAPAs', value: summary?.highRisks.count ?? 0, onClick: () => setTab('CAPA Register') },
    ]} />
    <div className="grid cols-2" style={{ marginTop: 18 }}>
      <ChartCard title="Open quality items" subtitle="Composition of active NCs and CAPAs">
        <DonutChart centerLabel="Open" data={[
          { label: 'Open NCs', value: summary?.openNCs.count ?? ncList.filter(n => n.status !== 'closed').length, color: CHART_COLORS[3] },
          { label: 'Open CAPAs', value: summary?.openCAPAs.count ?? capaList.filter(c => c.status !== 'closed').length, color: CHART_COLORS[0] },
          { label: 'High-risk CAPAs', value: summary?.highRisks.count ?? 0, color: CHART_COLORS[4] },
        ]} />
      </ChartCard>
      <ChartCard title="Attention required" subtitle="Items breaching or approaching their due dates">
        <BarMeter data={[
          { label: 'Overdue CAPAs', value: overdueCAPAs.length, color: CHART_COLORS[3] },
          { label: 'Effectiveness reviews due', value: effectivenessDue.length, color: CHART_COLORS[2] },
          { label: 'NCs pending review', value: ncList.filter(n => n.status === 'open').length, color: CHART_COLORS[0] },
        ]} />
      </ChartCard>
    </div></>}

    {tab === 'Incidents & Adverse Events' && <IncidentsBoard staff={staff} sections={sections} />}

    {tab === 'Nonconforming Events' && <div className="card">
      <div className="section-head" style={{ alignItems: 'center', flexWrap: 'wrap' }}><h3 style={{ margin: 0 }}>Nonconformity register</h3><button style={{ marginLeft: 'auto' }} onClick={() => setTab('New Event')}>+ New nonconformity</button></div>
      <XlsxToolbar exportPath="/nonconformities/register/export" templatePath="/nonconformities/register/template" importPath="/nonconformities/register/import" exportName="Nonconformities.xlsx" onImported={load} />
      <div className="form" style={{ gridTemplateColumns: '1fr auto', alignItems: 'end' }}>
        <label>Search<input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search NC number, title, description" /></label>
        <label>Status<select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}><option value="">All</option>{ncStatusOptions.map(status => <option key={status} value={status}>{status.replace(/_/g, ' ')}</option>)}</select></label>
      </div>
      {filteredNcs.length === 0 ? <p>No nonconforming events match the current filters.</p> : <table className="table"><thead><tr><th>NC No.</th><th>Date</th><th>Type</th><th>Section</th><th>Title</th><th>Risk</th><th>Status</th><th>CAPA</th><th>Actions</th></tr></thead><tbody>{filteredNcs.map(n => <tr key={n.id}><td>{n.nc_number}</td><td>{n.event_date}</td><td>{(n.nc_type || n.source_module || '—').replace(/_/g, ' ')}</td><td>{sections.find(s => s.id === n.section_id)?.name || n.section_id || '—'}</td><td>{n.title}</td><td>{n.risk_score != null ? <>{n.risk_score} {riskLevelBadge(n.risk_level)}</> : (n.severity || '—')}</td><td>{formatBadge(n.status)}</td><td>{capaList.some(c => c.nc_id === n.id) ? 'Yes' : 'No'}</td><td><button onClick={() => loadNcDetail(n.id)}>View</button> <button className="secondary" onClick={() => openNcPrint(`/nonconformities/${n.id}/print`, m => setLoadState({ loading: false, error: m }))}>Print form</button></td></tr>)}</tbody></table>}
    </div>}

    {tab === 'New Event' && <div className="card"><h3>Nonconformance Corrective Action Form (SECHFO005)</h3>
      <p className="muted" style={{ marginTop: 0 }}>Record the nonconformity below. After creating it you can complete the root-cause, CAPA, follow-up and approval sections, and print the form.</p>
      <form onSubmit={submitNewNc}>
        <fieldset className="reg-section"><legend>Header</legend><div className="form-grid">
          <label>Date of event<input type="date" value={formState.eventDate} onChange={e => setFormState(p => ({ ...p, eventDate: e.target.value }))} required /></label>
          <label>Time of event<input type="time" value={formState.timeOfEvent} onChange={e => setFormState(p => ({ ...p, timeOfEvent: e.target.value }))} /></label>
          <label>Unit / section<select value={formState.sectionId} onChange={e => setFormState(p => ({ ...p, sectionId: e.target.value }))}><option value="">—</option>{sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
          <label>Detected by (staff)<select value={formState.detectedByStaffId} onChange={e => setFormState(p => ({ ...p, detectedByStaffId: e.target.value }))}><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
          <label>… or name / role<input value={formState.detectedByName} onChange={e => setFormState(p => ({ ...p, detectedByName: e.target.value }))} placeholder="if not a staff record" /></label>
        </div></fieldset>
        <fieldset className="reg-section"><legend>Section A — Description of Nonconformity</legend><div className="form-grid">
          <label style={{ gridColumn: '1 / -1' }}>Type of nonconformity<select value={formState.ncType} onChange={e => setFormState(p => ({ ...p, ncType: e.target.value }))}>{NC_TYPE_OPTIONS.map(t => <option key={t.v} value={t.v}>{t.l}</option>)}</select></label>
          {formState.ncType === 'other' && <label style={{ gridColumn: '1 / -1' }}>Specify<input value={formState.ncTypeOther} onChange={e => setFormState(p => ({ ...p, ncTypeOther: e.target.value }))} /></label>}
          <label style={{ gridColumn: '1 / -1' }}>Title<input value={formState.title} onChange={e => setFormState(p => ({ ...p, title: e.target.value }))} required placeholder="Short descriptive title" /></label>
          <label style={{ gridColumn: '1 / -1' }}>Description of nonconformity (facts only, no blame)<textarea value={formState.description} onChange={e => setFormState(p => ({ ...p, description: e.target.value }))} required /></label>
          <label style={{ gridColumn: '1 / -1' }}>Immediate action taken (urgent step to contain the problem)<textarea value={formState.immediateCorrection} onChange={e => setFormState(p => ({ ...p, immediateCorrection: e.target.value }))} /></label>
          <label style={{ gridColumn: '1 / -1' }}>Remedial action taken (short-term fix)<textarea value={formState.remedialAction} onChange={e => setFormState(p => ({ ...p, remedialAction: e.target.value }))} /></label>
        </div></fieldset>
        <fieldset className="reg-section"><legend>Section B — Risk Evaluation (5×5 matrix)</legend>
          <RiskMatrix occurrence={formState.occurrenceScore} severity={formState.severityScore} onChange={(o, s) => setFormState(p => ({ ...p, occurrenceScore: o, severityScore: s }))} />
        </fieldset>
        <fieldset className="reg-section"><legend>Section C — Root Cause Analysis (optional now)</legend><div className="form-grid">
          <label>Investigation team / person<input value={formState.investigationTeam} onChange={e => setFormState(p => ({ ...p, investigationTeam: e.target.value }))} /></label>
          <label>RCA method<select value={formState.rcaMethod} onChange={e => setFormState(p => ({ ...p, rcaMethod: e.target.value }))}>{RCA_METHOD_OPTIONS.map(m => <option key={m.v} value={m.v}>{m.l}</option>)}</select></label>
          <label style={{ gridColumn: '1 / -1' }}>Root cause(s) identified<textarea value={formState.rootCause} onChange={e => setFormState(p => ({ ...p, rootCause: e.target.value }))} /></label>
        </div></fieldset>
        <fieldset className="reg-section"><legend>Section D — Corrective &amp; Preventive Actions</legend><div className="form-grid">
          <label style={{ gridColumn: '1 / -1' }}>Corrective action (to fix current issue)<textarea value={formState.correctiveAction} onChange={e => setFormState(p => ({ ...p, correctiveAction: e.target.value }))} /></label>
          <label style={{ gridColumn: '1 / -1' }}>Preventive action (to avoid recurrence)<textarea value={formState.preventiveAction} onChange={e => setFormState(p => ({ ...p, preventiveAction: e.target.value }))} /></label>
          <label>Responsible person<select value={formState.capaResponsibleStaffId} onChange={e => setFormState(p => ({ ...p, capaResponsibleStaffId: e.target.value }))}><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
          <label>Timeline for completion<input type="date" value={formState.capaTimelineDate} onChange={e => setFormState(p => ({ ...p, capaTimelineDate: e.target.value }))} /></label>
        </div></fieldset>
        <button type="submit">Create nonconformity</button>
      </form>
    </div>}

    {tab === 'CAPA Register' && <div className="card">
      <div className="form" style={{ gridTemplateColumns: '1fr auto', alignItems: 'end' }}>
        <label>Search<input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search CAPA number, title" /></label>
        <label>Status<select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}><option value="">All</option>{capaStatusOptions.map(status => <option key={status} value={status}>{status.replace(/_/g, ' ')}</option>)}</select></label>
      </div>
      {filteredCapas.length === 0 ? <p>No CAPA records match the current filters.</p> : <table className="table"><thead><tr><th>CAPA No.</th><th>Source</th><th>Title</th><th>Responsible</th><th>Due</th><th>Priority</th><th>Status</th><th>Effectiveness</th><th>Actions</th></tr></thead><tbody>{filteredCapas.map(c => <tr key={c.id}><td>{c.capa_number}</td><td>{c.source_module || 'Manual'}</td><td>{c.title}</td><td>{staff.find(s => s.id === c.responsible_staff_id)?.fullName || c.responsible_staff_id || '—'}</td><td>{c.due_date || 'N/A'}</td><td>{c.priority}</td><td>{formatBadge(c.status)}</td><td>{c.effectiveness_status || 'pending'}</td><td><button onClick={() => loadCapaDetail(c.id)}>View</button></td></tr>)}</tbody></table>}
    </div>}

    {tab === 'Overdue CAPAs' && <div className="card"><h3>Overdue CAPAs</h3>{overdueCAPAs.length === 0 ? <p>No overdue CAPAs at this time.</p> : <table className="table"><thead><tr><th>CAPA No.</th><th>Title</th><th>Due date</th><th>Status</th></tr></thead><tbody>{overdueCAPAs.map(c => <tr key={c.id}><td>{c.capa_number}</td><td>{c.title}</td><td>{c.due_date}</td><td>{formatBadge(c.status)}</td></tr>)}</tbody></table>}</div>}

    {tab === 'Effectiveness Reviews' && <div className="card"><h3>Effectiveness reviews due</h3>{effectivenessDue.length === 0 ? <p>No effectiveness reviews due right now.</p> : <table className="table"><thead><tr><th>CAPA No.</th><th>Title</th><th>Effectiveness due</th><th>Status</th></tr></thead><tbody>{effectivenessDue.map(c => <tr key={c.id}><td>{c.capa_number}</td><td>{c.title}</td><td>{c.effectiveness_due_date}</td><td>{formatBadge(c.effectiveness_status || 'pending')}</td></tr>)}</tbody></table>}</div>}

    {tab === 'Reports placeholder' && <div className="card"><h3>Reports placeholder</h3><p>This section is reserved for future CAPA and NC analytics. Core QMS workflows remain focused on event tracking and linked record visibility.</p></div>}

    {tab === 'Action Tracker' && <QmsActionTracker embedded />}

    {selectedNc && (() => { const nc = selectedNc as any; const ncId = selectedNc.id; return <div className="card">
      <div className="section-head" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <h3 style={{ margin: 0 }}>NC {selectedNc.nc_number} {formatBadge(selectedNc.status)} {nc.risk_score != null ? <>{nc.risk_score} {riskLevelBadge(nc.risk_level)}</> : null}</h3>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button className="secondary" onClick={() => openNcPrint(`/nonconformities/${ncId}/print`, m => setLoadState({ loading: false, error: m }))}>Print form</button>
          <button className="secondary" onClick={() => setSelectedNc(null)}>Close</button>
        </div>
      </div>
      <p className="muted" style={{ fontSize: 12 }}>{selectedNc.event_date}{nc.time_of_event ? ` ${nc.time_of_event}` : ''} · {(nc.nc_type || '—').replace(/_/g, ' ')} · {sections.find(s => s.id === selectedNc.section_id)?.name || '—'} · detected by {staff.find(s => s.id === selectedNc.detected_by_staff_id)?.fullName || nc.detected_by_name || '—'}</p>
      <p><strong>Description:</strong> {selectedNc.description || '—'}</p>
      <p><strong>Immediate action:</strong> {nc.immediate_correction || '—'}</p>
      <p><strong>Remedial action:</strong> {nc.remedial_action || '—'}</p>

      <details style={{ margin: '10px 0' }} open><summary style={{ cursor: 'pointer', fontWeight: 600 }}>Full form — risk, root cause, CAPA, follow-up &amp; approval (Sections B–F)</summary>
        <div style={{ padding: '8px 0' }}>
          <h4 style={{ margin: '6px 0' }}>Section B — Risk evaluation</h4>
          <RiskMatrix occurrence={nc.occurrence_score ?? null} severity={nc.severity_score ?? null} onChange={(o, s) => saveNcField(ncId, { occurrenceScore: o, severityScore: s })} />
          <h4 style={{ margin: '12px 0 6px' }}>Section C — Root cause analysis</h4>
          <div className="form-grid">
            <label>Investigation team<input defaultValue={nc.investigation_team || ''} onBlur={e => saveNcField(ncId, { investigationTeam: e.target.value })} /></label>
            <label>RCA method<select defaultValue={nc.rca_method || ''} onChange={e => saveNcField(ncId, { rcaMethod: e.target.value })}><option value="">—</option>{RCA_METHOD_OPTIONS.map(m => <option key={m.v} value={m.v}>{m.l}</option>)}</select></label>
            <label style={{ gridColumn: '1 / -1' }}>Root cause(s)<textarea defaultValue={nc.root_cause || ''} onBlur={e => saveNcField(ncId, { rootCause: e.target.value })} /></label>
          </div>
          <h4 style={{ margin: '12px 0 6px' }}>Section D — Corrective &amp; preventive actions</h4>
          <div className="form-grid">
            <label style={{ gridColumn: '1 / -1' }}>Corrective action<textarea defaultValue={nc.corrective_action || ''} onBlur={e => saveNcField(ncId, { correctiveAction: e.target.value })} /></label>
            <label style={{ gridColumn: '1 / -1' }}>Preventive action<textarea defaultValue={nc.preventive_action || ''} onBlur={e => saveNcField(ncId, { preventiveAction: e.target.value })} /></label>
            <label>Responsible person<select defaultValue={nc.capa_responsible_staff_id ? String(nc.capa_responsible_staff_id) : ''} onChange={e => saveNcField(ncId, { capaResponsibleStaffId: e.target.value })}><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
            <label>Timeline for completion<input type="date" defaultValue={nc.capa_timeline_date || ''} onBlur={e => saveNcField(ncId, { capaTimelineDate: e.target.value })} /></label>
          </div>
          <h4 style={{ margin: '12px 0 6px' }}>Section E — Follow-up &amp; effectiveness check</h4>
          <div className="form-grid">
            <label>Reviewed by<select defaultValue={nc.effectiveness_reviewed_by_staff_id ? String(nc.effectiveness_reviewed_by_staff_id) : ''} onChange={e => saveNcField(ncId, { effectivenessReviewedByStaffId: e.target.value })}><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
            <label>Review date<input type="date" defaultValue={nc.effectiveness_review_date || ''} onBlur={e => saveNcField(ncId, { effectivenessReviewDate: e.target.value })} /></label>
            <label>Corrective action effective?<select defaultValue={nc.corrective_effective == null ? '' : String(nc.corrective_effective)} onChange={e => saveNcField(ncId, { correctiveEffective: e.target.value === '' ? null : e.target.value === '1' })}><option value="">Not assessed</option><option value="1">Yes</option><option value="0">No</option></select></label>
            <label style={{ gridColumn: '1 / -1' }}>Comments<textarea defaultValue={nc.effectiveness_comments || ''} onBlur={e => saveNcField(ncId, { effectivenessComments: e.target.value })} /></label>
          </div>
          <h4 style={{ margin: '12px 0 6px' }}>Section F — Approval</h4>
          <p style={{ margin: '2px 0' }}>Approved by: <strong>{staff.find(s => s.id === nc.approved_by_staff_id)?.fullName || '—'}</strong>{nc.approved_at ? ` · ${String(nc.approved_at).slice(0, 10)}` : ''}</p>
          <button onClick={() => approveNc(ncId)}>Approve nonconformity (Section F)</button>
        </div>
      </details>
      {selectedNc.links?.length ? <div><h4>Linked records</h4><table className="table"><thead><tr><th>Source</th><th>Target</th><th>Notes</th></tr></thead><tbody>{selectedNc.links.map(link => <tr key={link.id}><td>{link.source_module_key} / {link.source_record_type}#{link.source_record_id}</td><td>{link.target_module_key} / {link.target_record_type}#{link.target_record_id}</td><td>{link.notes || '—'}</td></tr>)}</tbody></table></div> : <p>No linked records are attached to this NC.</p>}
      <div className="form" style={{ display: 'grid', gap: '14px', marginTop: '14px' }}>
        <div><h4>Review NC</h4><label>Status<select value={workflowState.reviewStatus} onChange={e => setWorkflowState(prev => ({ ...prev, reviewStatus: e.target.value }))}>{ncStatusOptions.map(status => <option key={status} value={status}>{status.replace(/_/g, ' ')}</option>)}</select></label><label>Reviewer<select value={workflowState.reviewerStaffId} onChange={e => setWorkflowState(prev => ({ ...prev, reviewerStaffId: e.target.value }))}><option value="">Select staff</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label><button onClick={() => reviewNc(selectedNc.id)}>Submit review</button></div>
        <div><h4>Create CAPA from NC</h4><label>Title<input value={workflowState.capaTitle} onChange={e => setWorkflowState(prev => ({ ...prev, capaTitle: e.target.value }))} placeholder="CAPA title" /></label><label>Problem summary<textarea value={workflowState.capaProblemSummary} onChange={e => setWorkflowState(prev => ({ ...prev, capaProblemSummary: e.target.value }))} placeholder="Describe the problem" /></label><label>Responsible<select value={workflowState.capaResponsibleStaffId} onChange={e => setWorkflowState(prev => ({ ...prev, capaResponsibleStaffId: e.target.value }))}><option value="">Select staff</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label><label>Due date<input type="date" value={workflowState.capaDueDate} onChange={e => setWorkflowState(prev => ({ ...prev, capaDueDate: e.target.value }))} /></label><label>Priority<select value={workflowState.capaPriority} onChange={e => setWorkflowState(prev => ({ ...prev, capaPriority: e.target.value }))}><option value="normal">Normal</option><option value="high">High</option><option value="low">Low</option></select></label><button onClick={() => createCapaFromNc(selectedNc.id)}>Create CAPA</button></div>
        <div><h4>Create action from NC</h4><label>Title<input value={workflowState.actionTitle} onChange={e => setWorkflowState(prev => ({ ...prev, actionTitle: e.target.value }))} placeholder="Action title" /></label><label>Description<textarea value={workflowState.actionDescription} onChange={e => setWorkflowState(prev => ({ ...prev, actionDescription: e.target.value }))} placeholder="Describe the action" /></label><label>Assigned to<select value={workflowState.actionAssignedToStaffId} onChange={e => setWorkflowState(prev => ({ ...prev, actionAssignedToStaffId: e.target.value }))}><option value="">Select staff</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label><label>Due date<input type="date" value={workflowState.actionDueDate} onChange={e => setWorkflowState(prev => ({ ...prev, actionDueDate: e.target.value }))} /></label><label>Priority<select value={workflowState.actionPriority} onChange={e => setWorkflowState(prev => ({ ...prev, actionPriority: e.target.value }))}><option value="normal">Normal</option><option value="high">High</option><option value="low">Low</option></select></label><button onClick={() => createActionFromNc(selectedNc.id)}>Create action</button></div>
        <div><h4>Close NC</h4><label>Closure notes<textarea value={workflowState.closureNotes} onChange={e => setWorkflowState(prev => ({ ...prev, closureNotes: e.target.value }))} placeholder="Enter notes for closure" /></label><button className="secondary" onClick={() => closeNc(selectedNc.id)}>Close NC</button></div>
      </div>
    </div>; })()}

    {selectedCapa && <div className="card"><h3>CAPA detail: {selectedCapa.capa_number}</h3>
      <p><strong>Source:</strong> {selectedCapa.source_module || 'Manual'} / {selectedCapa.source_record_id || '—'}</p>
      <p><strong>Title:</strong> {selectedCapa.title}</p>
      <p><strong>Problem summary:</strong> {selectedCapa.problem_summary || '—'}</p>
      <p><strong>Root cause:</strong> {selectedCapa.root_cause || '—'}</p>
      <p><strong>Corrective action:</strong> {selectedCapa.corrective_action || '—'}</p>
      <p><strong>Preventive action:</strong> {selectedCapa.preventive_action || '—'}</p>
      <p><strong>Responsible:</strong> {staff.find(s => s.id === selectedCapa.responsible_staff_id)?.fullName || toDisplay(selectedCapa.responsible_staff_id)}</p>
      <p><strong>Due date:</strong> {selectedCapa.due_date || 'N/A'}</p>
      <p><strong>Priority:</strong> {selectedCapa.priority}</p>
      <p><strong>Status:</strong> {formatBadge(selectedCapa.status)}</p>
      <p><strong>Verification notes:</strong> {selectedCapa.verification_notes || '—'}</p>
      <p><strong>Effectiveness status:</strong> {selectedCapa.effectiveness_status || 'pending'}</p>
      <p><strong>Effectiveness due:</strong> {selectedCapa.effectiveness_due_date || 'N/A'}</p>
      {selectedCapa.links?.length ? <div><h4>Linked records</h4><table className="table"><thead><tr><th>Source</th><th>Target</th><th>Notes</th></tr></thead><tbody>{selectedCapa.links.map(link => <tr key={link.id}><td>{link.source_module_key} / {link.source_record_type}#{link.source_record_id}</td><td>{link.target_module_key} / {link.target_record_type}#{link.target_record_id}</td><td>{link.notes || '—'}</td></tr>)}</tbody></table></div> : <p>No linked records are attached to this CAPA.</p>}
      {selectedCapa.updates?.length ? <div><h4>Update history</h4><table className="table"><thead><tr><th>Date</th><th>Status</th><th>Note</th></tr></thead><tbody>{selectedCapa.updates.map(update => <tr key={update.id}><td>{update.update_date}</td><td>{formatBadge(update.status)}</td><td>{update.update_text}</td></tr>)}</tbody></table></div> : <p>No update history recorded yet.</p>}
      <div className="form" style={{ display: 'grid', gap: '14px', marginTop: '14px' }}>
        <div><h4>Add CAPA update</h4><label>Update status<select value={workflowState.reviewStatus} onChange={e => setWorkflowState(prev => ({ ...prev, reviewStatus: e.target.value }))}>{actionOptions.map(status => <option key={status} value={status}>{status}</option>)}</select></label><label>Update note<textarea value={workflowState.actionDescription} onChange={e => setWorkflowState(prev => ({ ...prev, actionDescription: e.target.value }))} placeholder="Enter update note" /></label><button onClick={() => addCapaUpdate(selectedCapa.id, workflowState.actionDescription, workflowState.reviewStatus)}>Add update</button></div>
        <div><h4>Verify CAPA</h4><label>Verification notes<textarea value={workflowState.closureNotes} onChange={e => setWorkflowState(prev => ({ ...prev, closureNotes: e.target.value }))} placeholder="Enter verification notes" /></label><button onClick={() => verifyCapa(selectedCapa.id, workflowState.closureNotes)}>Verify</button></div>
        <div><h4>Effectiveness review</h4><label>Review notes<textarea value={workflowState.actionDescription} onChange={e => setWorkflowState(prev => ({ ...prev, actionDescription: e.target.value }))} placeholder="Enter effectiveness review notes" /></label><label>Effectiveness due date<input type="date" value={workflowState.actionDueDate} onChange={e => setWorkflowState(prev => ({ ...prev, actionDueDate: e.target.value }))} /></label><button onClick={() => reviewCapaEffectiveness(selectedCapa.id, workflowState.actionDescription, workflowState.actionDueDate)}>Save review</button></div>
        <div><h4>Close or reopen</h4><button className="secondary" onClick={() => closeCapa(selectedCapa.id)}>Close CAPA</button> <button className="secondary" onClick={() => reopenCapa(selectedCapa.id)}>Reopen CAPA</button></div>
      </div>
    </div>}
  </div>;
}

export function ComplaintsPage({ embedded = false }: { embedded?: boolean } = {}) {
  const { isEnabled } = useModules();
  const { staff, sections } = useLookupData();
  const [tab, setTab] = useState(embedded ? 'Complaints Register' : 'Dashboard');
  const [complaints, setComplaints] = useState<ComplaintRecord[]>([]);
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
    <div className="tabs">{['Dashboard', 'Complaints Register', 'New Complaint', 'Investigation', 'Trends placeholder', 'Reports placeholder'].filter(name => !embedded || name !== 'Dashboard').map(name => <button key={name} className={tab === name ? 'active' : ''} onClick={() => setTab(name)}>{name}</button>)}</div>
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
      {filteredComplaints.length === 0 ? <p>No complaints match the current filters.</p> : <table className="table"><thead><tr><th>No.</th><th>Date</th><th>Source</th><th>Type</th><th>Category</th><th>Title</th><th>Assigned</th><th>Status</th><th>Actions</th></tr></thead><tbody>{filteredComplaints.map(c => <tr key={c.id}><td>{c.complaint_number}</td><td>{c.received_date}</td><td>{c.source || '—'}</td><td>{c.complainant_type || '—'}</td><td>{c.category || '—'}</td><td>{c.title}</td><td>{staff.find(s => s.id === c.assigned_to_staff_id)?.fullName || toDisplay(c.assigned_to_staff_id)}</td><td>{formatBadge(c.status)}</td><td><button onClick={() => loadComplaintDetail(c.id)}>View</button></td></tr>)}</tbody></table>}
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
  const [risks, setRisks] = useState<RiskRecord[]>([]);
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
    <div className="tabs">{['Dashboard', 'Risk Register', 'New Risk', 'Reviews Due', 'Reports placeholder'].filter(name => !embedded || name !== 'Dashboard').map(name => <button key={name} className={tab === name ? 'active' : ''} onClick={() => setTab(name)}>{name}</button>)}</div>
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
      {filteredRisks.length === 0 ? <p>No risks match the current filters.</p> : <table className="table"><thead><tr><th>Risk No.</th><th>Area</th><th>Description</th><th>Score</th><th>Level</th><th>Responsible</th><th>Review Due</th><th>Status</th><th>Actions</th></tr></thead><tbody>{filteredRisks.map(r => <tr key={r.id}><td>{r.risk_number}</td><td>{r.risk_area}</td><td>{r.risk_description}</td><td>{r.risk_score || '—'}</td><td>{r.risk_level || '—'}</td><td>{staff.find(s => s.id === r.responsible_staff_id)?.fullName || toDisplay(r.responsible_staff_id)}</td><td>{r.review_due_date || 'N/A'}</td><td>{formatBadge(r.status)}</td><td><button onClick={() => loadRiskDetail(r.id)}>View</button></td></tr>)}</tbody></table>}
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
