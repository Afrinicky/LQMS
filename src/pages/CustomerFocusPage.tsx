import { FormEvent, useEffect, useState } from 'react';
import PageHeader from '../components/ui/PageHeader';
import { KpiStrip, ChartCard, DonutChart, BarMeter, CHART_COLORS, ModuleAlerts, DetailModal } from '../components/ui';
import { useModules } from '../hooks/useModules';
import { api, API_BASE, getToken, errorText, apiRead } from '../services/api';
import DisabledModule from '../components/DisabledModule';
import { ComplaintsPage } from './QMSPages';
import { usePermissions } from '../hooks/usePermissions';
import PermissionTabs from '../components/PermissionTabs';
import type {
  Section, Department, Staff,
  CustomerStakeholder, ServiceAgreement, CustomerFeedback,
  SatisfactionSurvey, SatisfactionSurveyQuestion, SatisfactionSurveyResponse,
  CustomerCommunicationLog, CustomerFocusImportBatch, CustomerFocusSummary,
  SurveyAnalytics, ServiceAgreementPerformance, AdvisoryService, LaboratoryHandbookEntry
} from '../../shared/types/api';
import TextField from '../components/ui/TextField';
import { Notice } from '../components/ui/Feedback';

const statusBadgeClass = (status?: string) => `badge ${status ? status.toLowerCase().replace(/\s+/g, '-') : 'unknown'}`;
const formatBadge = (status?: string) => <span className={statusBadgeClass(status)}>{status ? status.replace(/_/g, ' ') : 'Unknown'}</span>;
// Tabs are filtered by permission — a tab whose feature this user cannot
// view is not drawn. See src/components/PermissionTabs.tsx.
const TAB_MODULE = 'customer_focus';
const tabBar = (active: string, tabs: string[], onChange: (name: string) => void) =>
  <PermissionTabs moduleKey={TAB_MODULE} tabs={tabs} active={active} onChange={onChange} />;

const STAKEHOLDER_TYPES = ['internal_unit', 'clinician', 'patient_or_family', 'organisation', 'public_partner', 'supplier', 'other'];
const FEEDBACK_TYPES = ['compliment', 'concern', 'suggestion', 'enquiry', 'request', 'other'];
const URGENCIES = ['low', 'medium', 'high', 'critical'];
const SURVEY_TYPES = ['clinician_satisfaction', 'patient_satisfaction', 'internal_unit', 'partner', 'other'];
const QUESTION_TYPES = ['scale', 'multiple_choice', 'short_text', 'long_text', 'yes_no'];
const COMMUNICATION_TYPES = ['acknowledgement', 'update', 'meeting', 'newsletter', 'follow_up', 'other'];
const COMMUNICATION_DIRECTIONS = ['inbound', 'outbound'];
const IMPORT_TYPES = ['feedback', 'survey_responses', 'stakeholders', 'other'];

function useLookups() {
  const [staff, setStaff] = useState<Staff[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  useEffect(() => {
    api<Staff[]>('/staff').then(setStaff).catch(() => setStaff([]));
    api<Section[]>('/sections').then(setSections).catch(() => setSections([]));
    api<Department[]>('/departments').then(setDepartments).catch(() => setDepartments([]));
  }, []);
  return { staff, sections, departments };
}

function staffName(staffList: Staff[], id?: number | null) {
  if (!id) return '—';
  return staffList.find(s => s.id === id)?.fullName || `Staff #${id}`;
}

export function CustomerFocusPage() {
  const { can } = usePermissions();
  const { isEnabled } = useModules();
  const { staff, sections, departments } = useLookups();
  const [tab, setTab] = useState('Dashboard');
  const [error, setError] = useState<string | null>(null);

  const [summary, setSummary] = useState<CustomerFocusSummary | null>(null);
  const [stakeholders, setStakeholders] = useState<CustomerStakeholder[]>([]);
  const [agreements, setAgreements] = useState<ServiceAgreement[]>([]);
  const [feedback, setFeedback] = useState<CustomerFeedback[]>([]);
  const [surveys, setSurveys] = useState<SatisfactionSurvey[]>([]);
  const [selectedSurvey, setSelectedSurvey] = useState<SatisfactionSurvey | null>(null);
  const [surveyResponses, setSurveyResponses] = useState<SatisfactionSurveyResponse[]>([]);
  const [communications, setCommunications] = useState<CustomerCommunicationLog[]>([]);
  const [imports, setImports] = useState<CustomerFocusImportBatch[]>([]);
  const [analytics, setAnalytics] = useState<SurveyAnalytics | null>(null);
  const [allResponses, setAllResponses] = useState<SatisfactionSurveyResponse[]>([]);
  const [performance, setPerformance] = useState<ServiceAgreementPerformance | null>(null);
  const [advisory, setAdvisory] = useState<AdvisoryService[]>([]);
  const [handbook, setHandbook] = useState<LaboratoryHandbookEntry[]>([]);

  const [advForm, setAdvForm] = useState({ serviceDate: '', serviceType: '', requester: '', stakeholderId: '', providedByStaffId: '', subject: '', adviceSummary: '', communicationChannel: '', followUpRequired: false, followUpDueDate: '' });
  const [hbForm, setHbForm] = useState({ section: '', title: '', content: '', version: '', effectiveDate: '', reviewDate: '', status: 'active', displayOrder: '0' });

  const [stakeForm, setStakeForm] = useState({ stakeholderName: '', stakeholderType: 'internal_unit', organisation: '', contactPerson: '', email: '', phone: '', address: '', departmentId: '', sectionId: '', notes: '' });
  const [agreeForm, setAgreeForm] = useState({ stakeholderId: '', agreementTitle: '', serviceScope: '', startDate: '', endDate: '', reviewDueDate: '', responsibleStaffId: '', agreedTurnaround: '', reportingFormat: '', notes: '' });
  const [feedbackForm, setFeedbackForm] = useState({ feedbackDate: '', feedbackType: 'concern', sourceChannel: '', stakeholderId: '', contactName: '', contactDetail: '', title: '', description: '', urgency: 'medium', sentiment: '', assignedToStaffId: '', followUpDueDate: '' });
  const [surveyForm, setSurveyForm] = useState({ surveyTitle: '', surveyType: 'clinician_satisfaction', description: '', audience: '', periodStart: '', periodEnd: '' });
  const [questionForm, setQuestionForm] = useState({ questionText: '', questionType: 'scale', scaleMin: '1', scaleMax: '5', optionsText: '', isRequired: false, displayOrder: '0', questionCode: '' });
  const [respForm, setRespForm] = useState<{ responseDate: string; respondentName: string; respondentRole: string; sourceChannel: string; stakeholderId: string; overallComment: string; answers: Record<number, { answerText: string; answerNumber: string }> }>({ responseDate: '', respondentName: '', respondentRole: '', sourceChannel: '', stakeholderId: '', overallComment: '', answers: {} });
  const [commForm, setCommForm] = useState({ communicationDate: '', communicationType: 'update', direction: 'outbound', channel: '', subject: '', messageSummary: '', stakeholderId: '', feedbackId: '', contactName: '', contactDetail: '', followUpDueDate: '' });
  const [importForm, setImportForm] = useState<{ importType: string; notes: string; file: File | null }>({ importType: 'feedback', notes: '', file: null });

  async function load() {
    try {
      const [sum, st, sa, fb, sv, cm, im] = await Promise.all([
        api<CustomerFocusSummary>('/dashboard/customer-focus-summary').catch(() => null),
        apiRead<CustomerStakeholder[]>('/customer-focus/stakeholders', []),
        apiRead<ServiceAgreement[]>('/customer-focus/service-agreements', []),
        apiRead<CustomerFeedback[]>('/customer-focus/feedback', []),
        apiRead<SatisfactionSurvey[]>('/customer-focus/surveys', []),
        apiRead<CustomerCommunicationLog[]>('/customer-focus/communications', []),
        apiRead<CustomerFocusImportBatch[]>('/customer-focus/imports', [])
      ]);
      if (sum) setSummary(sum);
      setStakeholders(st); setAgreements(sa); setFeedback(fb); setSurveys(sv); setCommunications(cm); setImports(im);
      const [adv, hb] = await Promise.all([
        api<AdvisoryService[]>('/customer-focus/advisory').catch(() => []),
        api<LaboratoryHandbookEntry[]>('/customer-focus/handbook').catch(() => []),
      ]);
      setAdvisory(adv); setHandbook(hb);
    } catch (e) { setError(errorText(e)); }
  }
  useEffect(() => { if (isEnabled('customer_focus')) void load(); }, [isEnabled]);
  if (!isEnabled('customer_focus')) return <DisabledModule />;

  async function openSurvey(id: number) {
    try {
      setSelectedSurvey(await api<SatisfactionSurvey>(`/customer-focus/surveys/${id}`));
      setSurveyResponses(await api<SatisfactionSurveyResponse[]>(`/customer-focus/surveys/${id}/responses`));
      setAnalytics(await api<SurveyAnalytics>(`/customer-focus/surveys/${id}/analytics`).catch(() => null));
      setRespForm(r => ({ ...r, answers: {} }));
    } catch (e) { setError(errorText(e)); }
  }

  async function loadAllResponses() {
    try { setAllResponses(await api<SatisfactionSurveyResponse[]>('/customer-focus/responses')); }
    catch (e) { setError(errorText(e)); }
  }
  useEffect(() => { if (tab === 'Survey Responses' && !selectedSurvey) void loadAllResponses(); }, [tab, selectedSurvey]);

  async function loadAgreementPerformance(id: number) {
    try { setPerformance(await api<ServiceAgreementPerformance>(`/customer-focus/service-agreements/${id}/performance`)); }
    catch (e) { setError(errorText(e)); }
  }

  async function submitStakeholder(e: FormEvent) {
    e.preventDefault(); setError(null);
    try {
      await api('/customer-focus/stakeholders', { method: 'POST', body: JSON.stringify(stakeForm) });
      setStakeForm({ stakeholderName: '', stakeholderType: 'internal_unit', organisation: '', contactPerson: '', email: '', phone: '', address: '', departmentId: '', sectionId: '', notes: '' });
      await load(); setTab('Stakeholders');
    } catch (e) { setError(errorText(e)); }
  }
  async function toggleStakeholder(id: number) { try { await api(`/customer-focus/stakeholders/${id}/toggle`, { method: 'POST', body: JSON.stringify({}) }); await load(); } catch (e) { setError(errorText(e)); } }

  async function submitAgreement(e: FormEvent) {
    e.preventDefault(); setError(null);
    try {
      await api('/customer-focus/service-agreements', { method: 'POST', body: JSON.stringify(agreeForm) });
      setAgreeForm({ stakeholderId: '', agreementTitle: '', serviceScope: '', startDate: '', endDate: '', reviewDueDate: '', responsibleStaffId: '', agreedTurnaround: '', reportingFormat: '', notes: '' });
      await load();
    } catch (e) { setError(errorText(e)); }
  }
  async function approveAgreement(id: number) { try { await api(`/customer-focus/service-agreements/${id}/approve`, { method: 'POST', body: JSON.stringify({}) }); await load(); } catch (e) { setError(errorText(e)); } }
  async function archiveAgreement(id: number) { try { await api(`/customer-focus/service-agreements/${id}/archive`, { method: 'POST', body: JSON.stringify({}) }); await load(); } catch (e) { setError(errorText(e)); } }

  async function submitFeedback(e: FormEvent) {
    e.preventDefault(); setError(null);
    try {
      await api('/customer-focus/feedback', { method: 'POST', body: JSON.stringify(feedbackForm) });
      setFeedbackForm({ feedbackDate: '', feedbackType: 'concern', sourceChannel: '', stakeholderId: '', contactName: '', contactDetail: '', title: '', description: '', urgency: 'medium', sentiment: '', assignedToStaffId: '', followUpDueDate: '' });
      await load();
    } catch (e) { setError(errorText(e)); }
  }
  async function escalateToComplaint(id: number) { try { await api(`/customer-focus/feedback/${id}/create-complaint`, { method: 'POST', body: JSON.stringify({}) }); await load(); } catch (e) { setError(errorText(e)); } }
  async function feedbackCreateAction(id: number) { const title = prompt('Action title?'); if (!title) return; try { await api(`/customer-focus/feedback/${id}/create-action`, { method: 'POST', body: JSON.stringify({ title }) }); await load(); } catch (e) { setError(errorText(e)); } }
  async function feedbackCreateNc(id: number) { try { await api(`/customer-focus/feedback/${id}/create-nc`, { method: 'POST', body: JSON.stringify({}) }); await load(); } catch (e) { setError(errorText(e)); } }
  async function feedbackCreateCapa(id: number) { try { await api(`/customer-focus/feedback/${id}/create-capa`, { method: 'POST', body: JSON.stringify({}) }); await load(); } catch (e) { setError(errorText(e)); } }
  async function closeFeedback(id: number) { const summary = prompt('Resolution summary (optional)?') || ''; try { await api(`/customer-focus/feedback/${id}/close`, { method: 'POST', body: JSON.stringify({ resolutionSummary: summary }) }); await load(); } catch (e) { setError(errorText(e)); } }
  async function printFeedback(id: number) {
    try {
      const token = getToken();
      const response = await fetch(`${API_BASE}/customer-focus/feedback/${id}/print`, { headers: token ? { Authorization: `Bearer ${token}` } : undefined });
      if (!response.ok) throw new Error(await response.text() || response.statusText);
      const html = await response.text();
      const w = window.open('', '_blank');
      if (!w) { setError('Pop-up blocked. Allow pop-ups to open the print dialog.'); return; }
      w.document.open(); w.document.write(html); w.document.close();
    } catch (e) { setError(errorText(e)); }
  }

  async function submitSurvey(e: FormEvent) {
    e.preventDefault(); setError(null);
    try {
      await api('/customer-focus/surveys', { method: 'POST', body: JSON.stringify(surveyForm) });
      setSurveyForm({ surveyTitle: '', surveyType: 'clinician_satisfaction', description: '', audience: '', periodStart: '', periodEnd: '' });
      await load();
    } catch (e) { setError(errorText(e)); }
  }
  async function addQuestion(e: FormEvent) {
    e.preventDefault(); setError(null);
    if (!selectedSurvey) return;
    try {
      await api(`/customer-focus/surveys/${selectedSurvey.id}/questions`, { method: 'POST', body: JSON.stringify(questionForm) });
      setQuestionForm({ questionText: '', questionType: 'scale', scaleMin: '1', scaleMax: '5', optionsText: '', isRequired: false, displayOrder: '0', questionCode: '' });
      await openSurvey(selectedSurvey.id);
    } catch (e) { setError(errorText(e)); }
  }
  async function approveSurvey(id: number) { try { await api(`/customer-focus/surveys/${id}/approve`, { method: 'POST', body: JSON.stringify({}) }); await load(); if (selectedSurvey?.id === id) await openSurvey(id); } catch (e) { setError(errorText(e)); } }
  async function closeSurvey(id: number) { try { await api(`/customer-focus/surveys/${id}/close`, { method: 'POST', body: JSON.stringify({}) }); await load(); if (selectedSurvey?.id === id) await openSurvey(id); } catch (e) { setError(errorText(e)); } }

  async function submitResponse(e: FormEvent) {
    e.preventDefault(); setError(null);
    if (!selectedSurvey) return;
    const answers = Object.entries(respForm.answers).map(([qid, v]) => ({ questionId: Number(qid), answerText: v.answerText || undefined, answerNumber: v.answerNumber !== '' ? Number(v.answerNumber) : undefined }));
    try {
      await api(`/customer-focus/surveys/${selectedSurvey.id}/responses`, { method: 'POST', body: JSON.stringify({ ...respForm, stakeholderId: respForm.stakeholderId || null, answers }) });
      setRespForm({ responseDate: '', respondentName: '', respondentRole: '', sourceChannel: '', stakeholderId: '', overallComment: '', answers: {} });
      await openSurvey(selectedSurvey.id);
    } catch (e) { setError(errorText(e)); }
  }

  async function submitCommunication(e: FormEvent) {
    e.preventDefault(); setError(null);
    try {
      await api('/customer-focus/communications', { method: 'POST', body: JSON.stringify(commForm) });
      setCommForm({ communicationDate: '', communicationType: 'update', direction: 'outbound', channel: '', subject: '', messageSummary: '', stakeholderId: '', feedbackId: '', contactName: '', contactDetail: '', followUpDueDate: '' });
      await load();
    } catch (e) { setError(errorText(e)); }
  }
  async function commCreateAction(id: number) { const title = prompt('Action title?'); if (!title) return; try { await api(`/customer-focus/communications/${id}/create-action`, { method: 'POST', body: JSON.stringify({ title }) }); await load(); } catch (e) { setError(errorText(e)); } }
  async function closeComm(id: number) { try { await api(`/customer-focus/communications/${id}/close`, { method: 'POST', body: JSON.stringify({}) }); await load(); } catch (e) { setError(errorText(e)); } }

  async function submitImport(e: FormEvent) {
    e.preventDefault(); setError(null);
    if (!importForm.file) return setError('Choose a CSV or XLSX file');
    try {
      const fd = new FormData();
      fd.append('file', importForm.file);
      fd.append('importType', importForm.importType);
      if (importForm.notes) fd.append('notes', importForm.notes);
      const token = getToken();
      const response = await fetch(`${API_BASE}/customer-focus/imports`, { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : undefined, body: fd });
      if (!response.ok) throw new Error((await response.json().catch(() => ({ error: response.statusText }))).error ?? response.statusText);
      setImportForm({ importType: 'feedback', notes: '', file: null });
      await load();
    } catch (e) { setError(errorText(e)); }
  }
  async function processImport(id: number) { try { await api(`/customer-focus/imports/${id}/process`, { method: 'POST', body: JSON.stringify({}) }); await load(); } catch (e) { setError(errorText(e)); } }

  async function submitAdvisory(e: FormEvent) { e.preventDefault(); setError(null); try { await api('/customer-focus/advisory', { method: 'POST', body: JSON.stringify(advForm) }); setAdvForm({ serviceDate: '', serviceType: '', requester: '', stakeholderId: '', providedByStaffId: '', subject: '', adviceSummary: '', communicationChannel: '', followUpRequired: false, followUpDueDate: '' }); await load(); } catch (e) { setError(errorText(e)); } }
  async function submitHandbook(e: FormEvent) { e.preventDefault(); setError(null); try { await api('/customer-focus/handbook', { method: 'POST', body: JSON.stringify(hbForm) }); setHbForm({ section: '', title: '', content: '', version: '', effectiveDate: '', reviewDate: '', status: 'active', displayOrder: '0' }); await load(); } catch (e) { setError(errorText(e)); } }
  const pretty = (s?: string) => s ? s.replace(/_/g, ' ') : '—';

  const tabs = ['Dashboard', ...(isEnabled('complaints') ? ['Complaints'] : []), 'Advisory Services', 'Laboratory Handbook', 'Stakeholders', 'New Stakeholder', 'Service Agreements', 'Feedback Intake', 'Satisfaction Surveys', 'Survey Responses', 'Communication Log', 'Imports', 'Reports'];

  return <div className="module-page">
    <PageHeader eyebrow="Customer Focus" title="Customer Focus" subtitle="Stakeholders, feedback, and satisfaction follow-up." />
    {tabBar(tab, tabs, setTab)}
    {error && <Notice kind="error">{error}</Notice>}

    {tab === 'Dashboard' && <ModuleAlerts moduleKey="customer_focus" />}
    {tab === 'Dashboard' && (summary ? <KpiStrip items={[
      { label: 'Active stakeholders', value: summary.activeStakeholders, onClick: () => setTab('Stakeholders') },
      { label: 'Service agreements', value: summary.activeServiceAgreements, onClick: () => setTab('Service Agreements') },
      { label: 'Feedback (month)', value: summary.feedbackThisMonth, onClick: () => setTab('Feedback Intake') },
      { label: 'Open feedback', value: summary.openFeedback, onClick: () => setTab('Feedback Intake') },
      { label: 'High urgency', value: summary.highUrgencyFeedback, tone: 'danger', onClick: () => setTab('Feedback Intake') },
      { label: 'Active surveys', value: summary.activeSurveys, onClick: () => setTab('Satisfaction Surveys') },
      { label: 'Advisory (month)', value: summary.advisoryThisMonth ?? 0, onClick: () => setTab('Advisory Services') },
      { label: 'Handbook entries', value: summary.handbookEntries ?? 0, onClick: () => setTab('Laboratory Handbook') },
      { label: 'Follow-ups due', value: summary.followUpsDue, tone: 'warning', onClick: () => setTab('Communication Log') },
    ]} /> : <p>Loading summary…</p>)}
    {tab === 'Dashboard' && summary && <div className="grid cols-2" style={{ marginTop: 18 }}>
      <ChartCard title="Feedback handling" subtitle="This month's feedback by state">
        <DonutChart centerLabel="Feedback" data={[
          { label: 'Resolved', value: Math.max(0, summary.feedbackThisMonth - summary.openFeedback), color: CHART_COLORS[1] },
          { label: 'Open', value: summary.openFeedback, color: CHART_COLORS[0] },
          { label: 'High urgency', value: summary.highUrgencyFeedback, color: CHART_COLORS[3] },
        ]} />
      </ChartCard>
      <ChartCard title="Engagement & follow-up" subtitle="Stakeholder and survey activity">
        <BarMeter data={[
          { label: 'Active stakeholders', value: summary.activeStakeholders, color: CHART_COLORS[0] },
          { label: 'Active surveys', value: summary.activeSurveys, color: CHART_COLORS[5] },
          { label: 'Survey responses (month)', value: summary.surveyResponsesThisMonth, color: CHART_COLORS[1] },
          { label: 'Follow-ups due', value: summary.followUpsDue, color: CHART_COLORS[2] },
        ]} />
      </ChartCard>
    </div>}

    {tab === 'Complaints' && <ComplaintsPage embedded />}

    {tab === 'Advisory Services' && <>
      {can('customer_focus.advisory', 'create') && <form className="form-grid" onSubmit={submitAdvisory}>
        <label>Date<input type="date" value={advForm.serviceDate} onChange={e => setAdvForm({ ...advForm, serviceDate: e.target.value })} required /></label>
        <label>Type<select value={advForm.serviceType} onChange={e => setAdvForm({ ...advForm, serviceType: e.target.value })}><option value="">—</option>{['test_choice', 'interpretation', 'sample_type', 'frequency', 'clinical_advice', 'utilization', 'other'].map(t => <option key={t} value={t}>{pretty(t)}</option>)}</select></label>
        <label>Requester<TextField value={advForm.requester} onValue={nextValue => setAdvForm({ ...advForm, requester: nextValue })} placeholder="clinician / ward / user" /></label>
        <label>Stakeholder<select value={advForm.stakeholderId} onChange={e => setAdvForm({ ...advForm, stakeholderId: e.target.value })}><option value="">—</option>{stakeholders.map(s => <option key={s.id} value={s.id}>{s.stakeholder_name}</option>)}</select></label>
        <label>Provided by<select value={advForm.providedByStaffId} onChange={e => setAdvForm({ ...advForm, providedByStaffId: e.target.value })}><option value="">Me</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
        <label>Channel<TextField value={advForm.communicationChannel} onValue={nextValue => setAdvForm({ ...advForm, communicationChannel: nextValue })} placeholder="phone / email / ward round" /></label>
        <label>Subject<TextField value={advForm.subject} onValue={nextValue => setAdvForm({ ...advForm, subject: nextValue })} /></label>
        <label><input type="checkbox" checked={advForm.followUpRequired} onChange={e => setAdvForm({ ...advForm, followUpRequired: e.target.checked })} /> Follow-up required</label>
        <label>Follow-up due<input type="date" value={advForm.followUpDueDate} onChange={e => setAdvForm({ ...advForm, followUpDueDate: e.target.value })} /></label>
        <label>Advice summary<TextField as="textarea" value={advForm.adviceSummary} onValue={nextValue => setAdvForm({ ...advForm, adviceSummary: nextValue })} /></label>
        <button type="submit">Log advisory</button>
      </form>}
      <table className="data-table"><thead><tr><th>No.</th><th>Date</th><th>Type</th><th>Requester</th><th>Subject</th><th>By</th><th>Follow-up</th></tr></thead><tbody>
        {advisory.map(a => <tr key={a.id}><td>{a.record_number}</td><td>{a.service_date}</td><td>{pretty(a.service_type)}</td><td>{a.requester || '—'}</td><td>{a.subject || '—'}</td><td>{staffName(staff, a.provided_by_staff_id)}</td><td>{a.follow_up_required ? (a.follow_up_due_date || 'Yes') : '—'}</td></tr>)}
        {advisory.length === 0 && <tr><td colSpan={7}>No advisory services logged yet.</td></tr>}
      </tbody></table>
    </>}

    {tab === 'Laboratory Handbook' && <>
      {can('customer_focus.advisory', 'create') && <form className="form-grid" onSubmit={submitHandbook}>
        <label>Section<select value={hbForm.section} onChange={e => setHbForm({ ...hbForm, section: e.target.value })}><option value="">—</option>{['hours', 'test_menu', 'collection', 'transport', 'turnaround', 'contacts', 'policies', 'other'].map(s => <option key={s} value={s}>{pretty(s)}</option>)}</select></label>
        <label>Title<TextField value={hbForm.title} onValue={nextValue => setHbForm({ ...hbForm, title: nextValue })} required /></label>
        <label>Version<TextField value={hbForm.version} onValue={nextValue => setHbForm({ ...hbForm, version: nextValue })} /></label>
        <label>Display order<input type="number" value={hbForm.displayOrder} onChange={e => setHbForm({ ...hbForm, displayOrder: e.target.value })} /></label>
        <label>Effective date<input type="date" value={hbForm.effectiveDate} onChange={e => setHbForm({ ...hbForm, effectiveDate: e.target.value })} /></label>
        <label>Review date<input type="date" value={hbForm.reviewDate} onChange={e => setHbForm({ ...hbForm, reviewDate: e.target.value })} /></label>
        <label>Status<select value={hbForm.status} onChange={e => setHbForm({ ...hbForm, status: e.target.value })}>{['draft', 'active', 'under_review', 'archived'].map(s => <option key={s} value={s}>{pretty(s)}</option>)}</select></label>
        <label>Content<TextField as="textarea" value={hbForm.content} onValue={nextValue => setHbForm({ ...hbForm, content: nextValue })} /></label>
        <button type="submit">Add entry</button>
      </form>}
      <table className="data-table"><thead><tr><th>No.</th><th>Section</th><th>Title</th><th>Version</th><th>Effective</th><th>Review</th><th>Status</th></tr></thead><tbody>
        {handbook.map(h => <tr key={h.id}><td>{h.entry_number}</td><td>{pretty(h.section)}</td><td>{h.title}</td><td>{h.version || '—'}</td><td>{h.effective_date || '—'}</td><td>{h.review_date || '—'}</td><td>{formatBadge(h.status)}</td></tr>)}
        {handbook.length === 0 && <tr><td colSpan={7}>No handbook entries yet.</td></tr>}
      </tbody></table>
    </>}

    {tab === 'Stakeholders' && <table className="data-table"><thead><tr><th>Number</th><th>Name</th><th>Type</th><th>Organisation</th><th>Contact</th><th>Active</th><th></th></tr></thead><tbody>
      {stakeholders.map(s => <tr key={s.id}>
        <td>{s.stakeholder_number}</td><td>{s.stakeholder_name}</td><td>{s.stakeholder_type.replace(/_/g, ' ')}</td>
        <td>{s.organisation || '—'}</td><td>{s.contact_person || s.email || s.phone || '—'}</td>
        <td>{s.is_active ? 'Yes' : 'No'}</td>
        <td>{can('customer_focus.stakeholders', 'edit') && <button onClick={() => toggleStakeholder(s.id)}>{s.is_active ? 'Deactivate' : 'Activate'}</button>}</td>
      </tr>)}
    </tbody></table>}

    {tab === 'New Stakeholder' && can('customer_focus.stakeholders', 'create') && <form className="form-grid" onSubmit={submitStakeholder}>
      <label>Name<TextField value={stakeForm.stakeholderName} onValue={nextValue => setStakeForm({ ...stakeForm, stakeholderName: nextValue })} required /></label>
      <label>Type<select value={stakeForm.stakeholderType} onChange={e => setStakeForm({ ...stakeForm, stakeholderType: e.target.value })} required>{STAKEHOLDER_TYPES.map(t => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}</select></label>
      <label>Organisation<TextField value={stakeForm.organisation} onValue={nextValue => setStakeForm({ ...stakeForm, organisation: nextValue })} /></label>
      <label>Contact person<TextField value={stakeForm.contactPerson} onValue={nextValue => setStakeForm({ ...stakeForm, contactPerson: nextValue })} /></label>
      <label>Email<TextField value={stakeForm.email} onValue={nextValue => setStakeForm({ ...stakeForm, email: nextValue })} /></label>
      <label>Phone<TextField value={stakeForm.phone} onValue={nextValue => setStakeForm({ ...stakeForm, phone: nextValue })} /></label>
      <label>Address<TextField value={stakeForm.address} onValue={nextValue => setStakeForm({ ...stakeForm, address: nextValue })} /></label>
      <label>Department<select value={stakeForm.departmentId} onChange={e => setStakeForm({ ...stakeForm, departmentId: e.target.value })}><option value="">—</option>{departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
      <label>Section<select value={stakeForm.sectionId} onChange={e => setStakeForm({ ...stakeForm, sectionId: e.target.value })}><option value="">—</option>{sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
      <label>Notes<TextField as="textarea" value={stakeForm.notes} onValue={nextValue => setStakeForm({ ...stakeForm, notes: nextValue })} /></label>
      <button type="submit">Create stakeholder</button>
    </form>}

    {tab === 'Service Agreements' && <>
      {can('customer_focus.stakeholders', 'create') && <form className="form-grid" onSubmit={submitAgreement}>
        <label>Stakeholder<select value={agreeForm.stakeholderId} onChange={e => setAgreeForm({ ...agreeForm, stakeholderId: e.target.value })} required><option value="">—</option>{stakeholders.filter(s => s.is_active).map(s => <option key={s.id} value={s.id}>{s.stakeholder_name}</option>)}</select></label>
        <label>Title<TextField value={agreeForm.agreementTitle} onValue={nextValue => setAgreeForm({ ...agreeForm, agreementTitle: nextValue })} required /></label>
        <label>Start date<input type="date" value={agreeForm.startDate} onChange={e => setAgreeForm({ ...agreeForm, startDate: e.target.value })} /></label>
        <label>End date<input type="date" value={agreeForm.endDate} onChange={e => setAgreeForm({ ...agreeForm, endDate: e.target.value })} /></label>
        <label>Review due<input type="date" value={agreeForm.reviewDueDate} onChange={e => setAgreeForm({ ...agreeForm, reviewDueDate: e.target.value })} /></label>
        <label>Responsible staff<select value={agreeForm.responsibleStaffId} onChange={e => setAgreeForm({ ...agreeForm, responsibleStaffId: e.target.value })}><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
        <label>Agreed turnaround<TextField value={agreeForm.agreedTurnaround} onValue={nextValue => setAgreeForm({ ...agreeForm, agreedTurnaround: nextValue })} placeholder="e.g. 24 hours" /></label>
        <label>Reporting format<TextField value={agreeForm.reportingFormat} onValue={nextValue => setAgreeForm({ ...agreeForm, reportingFormat: nextValue })} placeholder="e.g. monthly PDF" /></label>
        <label>Service scope<TextField as="textarea" value={agreeForm.serviceScope} onValue={nextValue => setAgreeForm({ ...agreeForm, serviceScope: nextValue })} required /></label>
        <label>Notes<TextField as="textarea" value={agreeForm.notes} onValue={nextValue => setAgreeForm({ ...agreeForm, notes: nextValue })} /></label>
        <button type="submit">Create agreement</button>
      </form>}
      <table className="data-table"><thead><tr><th>Number</th><th>Stakeholder</th><th>Title</th><th>Period</th><th>Status</th><th></th></tr></thead><tbody>
        {agreements.map(a => <tr key={a.id}>
          <td>{a.agreement_number}</td><td>{a.stakeholder_name || '—'}</td><td>{a.agreement_title}</td>
          <td>{a.start_date || '—'} → {a.end_date || '—'}</td><td>{formatBadge(a.status)}</td>
          <td>
            <button onClick={() => loadAgreementPerformance(a.id)}>Performance</button>
            {a.status !== 'active' && can('customer_focus.stakeholders', 'approve') && <button onClick={() => approveAgreement(a.id)}>Approve</button>}
            {a.status !== 'archived' && can('customer_focus.stakeholders', 'approve') && <button onClick={() => archiveAgreement(a.id)}>Archive</button>}
          </td>
        </tr>)}
      </tbody></table>
      {performance && <div className="card" style={{ marginTop: 16 }}>
        <h3>Performance — {performance.agreement_number}</h3>
        <p>Stakeholder: {performance.stakeholder_name || '—'} | Period: {performance.period_start || '—'} → {performance.period_end || '—'} | Agreed turnaround: {performance.agreed_turnaround || '—'}</p>
        <div className="cards">
          <div className="card"><h4>Feedback total</h4><p className="metric">{performance.feedback_total}</p></div>
          <div className="card"><h4>Open feedback</h4><p className="metric">{performance.feedback_open}</p></div>
          <div className="card"><h4>High urgency feedback</h4><p className="metric">{performance.feedback_high_urgency}</p></div>
          <div className="card"><h4>Escalated to complaint</h4><p className="metric">{performance.feedback_escalated_to_complaint}</p></div>
          <div className="card"><h4>Communications</h4><p className="metric">{performance.communications_total}</p></div>
        </div>
        {performance.feedback_by_type.length > 0 && <table className="data-table"><thead><tr><th>Feedback type</th><th>Count</th></tr></thead><tbody>{performance.feedback_by_type.map(t => <tr key={t.feedback_type}><td>{t.feedback_type}</td><td>{t.c}</td></tr>)}</tbody></table>}
        <small>{performance.note}</small>
        <div><button className="secondary" onClick={() => setPerformance(null)}>Close performance panel</button></div>
      </div>}
    </>}

    {tab === 'Feedback Intake' && <>
      {can('customer_focus.feedback', 'create') && <form className="form-grid" onSubmit={submitFeedback}>
        <label>Date<input type="date" value={feedbackForm.feedbackDate} onChange={e => setFeedbackForm({ ...feedbackForm, feedbackDate: e.target.value })} required /></label>
        <label>Type<select value={feedbackForm.feedbackType} onChange={e => setFeedbackForm({ ...feedbackForm, feedbackType: e.target.value })} required>{FEEDBACK_TYPES.map(t => <option key={t} value={t}>{t}</option>)}</select></label>
        <label>Source channel<TextField value={feedbackForm.sourceChannel} onValue={nextValue => setFeedbackForm({ ...feedbackForm, sourceChannel: nextValue })} placeholder="e.g. phone, email, in-person" /></label>
        <label>Stakeholder<select value={feedbackForm.stakeholderId} onChange={e => setFeedbackForm({ ...feedbackForm, stakeholderId: e.target.value })}><option value="">—</option>{stakeholders.filter(s => s.is_active).map(s => <option key={s.id} value={s.id}>{s.stakeholder_name}</option>)}</select></label>
        <label>Contact name<TextField value={feedbackForm.contactName} onValue={nextValue => setFeedbackForm({ ...feedbackForm, contactName: nextValue })} /></label>
        <label>Contact detail<TextField value={feedbackForm.contactDetail} onValue={nextValue => setFeedbackForm({ ...feedbackForm, contactDetail: nextValue })} placeholder="phone / email" /></label>
        <label>Urgency<select value={feedbackForm.urgency} onChange={e => setFeedbackForm({ ...feedbackForm, urgency: e.target.value })}>{URGENCIES.map(u => <option key={u} value={u}>{u}</option>)}</select></label>
        <label>Sentiment<TextField value={feedbackForm.sentiment} onValue={nextValue => setFeedbackForm({ ...feedbackForm, sentiment: nextValue })} placeholder="positive / neutral / negative (optional)" /></label>
        <label>Assigned to<select value={feedbackForm.assignedToStaffId} onChange={e => setFeedbackForm({ ...feedbackForm, assignedToStaffId: e.target.value })}><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
        <label>Follow-up due<input type="date" value={feedbackForm.followUpDueDate} onChange={e => setFeedbackForm({ ...feedbackForm, followUpDueDate: e.target.value })} /></label>
        <label>Title<TextField value={feedbackForm.title} onValue={nextValue => setFeedbackForm({ ...feedbackForm, title: nextValue })} required /></label>
        <label>Description<TextField as="textarea" value={feedbackForm.description} onValue={nextValue => setFeedbackForm({ ...feedbackForm, description: nextValue })} required /></label>
        <button type="submit">Record feedback</button>
      </form>}
      <table className="data-table"><thead><tr><th>Number</th><th>Date</th><th>Type</th><th>Title</th><th>Urgency</th><th>Status</th><th>Stakeholder</th><th>Actions</th></tr></thead><tbody>
        {feedback.map(f => <tr key={f.id}>
          <td>{f.feedback_number}</td><td>{f.feedback_date}</td><td>{f.feedback_type}</td>
          <td>{f.title}</td><td>{formatBadge(f.urgency)}</td><td>{formatBadge(f.status)}</td>
          <td>{f.stakeholder_name || '—'}</td>
          <td>
            {can('customer_focus', 'print') && <button onClick={() => printFeedback(f.id)}>Print</button>}
            {!f.complaint_id && <button onClick={() => escalateToComplaint(f.id)}>Escalate to complaint</button>}
            <button onClick={() => feedbackCreateAction(f.id)}>Action</button>
            {!f.nc_id && <button onClick={() => feedbackCreateNc(f.id)}>NC</button>}
            {!f.capa_id && can('nc_capa', 'create') && <button onClick={() => feedbackCreateCapa(f.id)}>CAPA</button>}
            {f.status !== 'closed' && can('customer_focus.feedback', 'approve') && <button onClick={() => closeFeedback(f.id)}>Close</button>}
          </td>
        </tr>)}
      </tbody></table>
    </>}

    {tab === 'Satisfaction Surveys' && <>
      {can('customer_focus.surveys', 'create') && <form className="form-grid" onSubmit={submitSurvey}>
        <label>Title<TextField value={surveyForm.surveyTitle} onValue={nextValue => setSurveyForm({ ...surveyForm, surveyTitle: nextValue })} required /></label>
        <label>Type<select value={surveyForm.surveyType} onChange={e => setSurveyForm({ ...surveyForm, surveyType: e.target.value })} required>{SURVEY_TYPES.map(t => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}</select></label>
        <label>Audience<TextField value={surveyForm.audience} onValue={nextValue => setSurveyForm({ ...surveyForm, audience: nextValue })} /></label>
        <label>Period start<input type="date" value={surveyForm.periodStart} onChange={e => setSurveyForm({ ...surveyForm, periodStart: e.target.value })} /></label>
        <label>Period end<input type="date" value={surveyForm.periodEnd} onChange={e => setSurveyForm({ ...surveyForm, periodEnd: e.target.value })} /></label>
        <label>Description<TextField as="textarea" value={surveyForm.description} onValue={nextValue => setSurveyForm({ ...surveyForm, description: nextValue })} /></label>
        <button type="submit">Create survey</button>
      </form>}
      <table className="data-table"><thead><tr><th>Number</th><th>Title</th><th>Type</th><th>Status</th><th>Period</th><th></th></tr></thead><tbody>
        {surveys.map(s => <tr key={s.id}>
          <td>{s.survey_number}</td><td>{s.survey_title}</td><td>{s.survey_type.replace(/_/g, ' ')}</td>
          <td>{formatBadge(s.status)}</td><td>{s.period_start || '—'} → {s.period_end || '—'}</td>
          <td>
            <button onClick={() => openSurvey(s.id)}>Open</button>
            {s.status === 'draft' && can('customer_focus.surveys', 'approve') && <button onClick={() => approveSurvey(s.id)}>Approve / activate</button>}
            {s.status === 'active' && can('customer_focus.surveys', 'approve') && <button onClick={() => closeSurvey(s.id)}>Close</button>}
          </td>
        </tr>)}
      </tbody></table>
      {selectedSurvey && <DetailModal open onClose={() => { setSelectedSurvey(null); setSurveyResponses([]); }} title={<>{selectedSurvey.survey_number} — {selectedSurvey.survey_title}</>}>
        <p>Status: {formatBadge(selectedSurvey.status)} | Type: {selectedSurvey.survey_type.replace(/_/g, ' ')} | Responses: {selectedSurvey.responseCount ?? 0}</p>
        {analytics && analytics.total_responses > 0 && <>
          <h4>Response analytics</h4>
          <table className="data-table"><thead><tr><th>Question</th><th>Type</th><th>Answered</th><th>Summary</th></tr></thead><tbody>
            {analytics.questions.map(q => <tr key={q.question_id}>
              <td>{q.question_text}</td><td>{q.question_type.replace(/_/g, ' ')}</td><td>{q.answered}</td>
              <td>
                {q.question_type === 'scale' && q.mean !== null && q.mean !== undefined ? `mean ${q.mean.toFixed(2)} · range ${q.min}–${q.max}` : null}
                {(q.question_type === 'yes_no' || q.question_type === 'multiple_choice') && q.distribution ? Object.entries(q.distribution).map(([k, v]) => `${k}: ${v}`).join(' · ') : null}
                {(q.question_type === 'short_text' || q.question_type === 'long_text') && q.samples && q.samples.length > 0 ? <small>{q.samples.slice(0, 3).join(' / ')}</small> : null}
              </td>
            </tr>)}
          </tbody></table>
        </>}
        <h4>Questions</h4>
        <table className="data-table"><thead><tr><th>Order</th><th>Text</th><th>Type</th><th>Scale</th><th>Required</th></tr></thead><tbody>
          {(selectedSurvey.questions || []).map(q => <tr key={q.id}><td>{q.display_order}</td><td>{q.question_text}</td><td>{q.question_type}</td><td>{q.scale_min !== null && q.scale_max !== null ? `${q.scale_min}–${q.scale_max}` : '—'}</td><td>{q.is_required ? 'Yes' : 'No'}</td></tr>)}
        </tbody></table>
        {selectedSurvey.status === 'draft' && can('customer_focus.surveys', 'create') && <form className="form-grid" onSubmit={addQuestion}>
          <label>Code<TextField value={questionForm.questionCode} onValue={nextValue => setQuestionForm({ ...questionForm, questionCode: nextValue })} /></label>
          <label>Type<select value={questionForm.questionType} onChange={e => setQuestionForm({ ...questionForm, questionType: e.target.value })}>{QUESTION_TYPES.map(t => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}</select></label>
          <label>Scale min<input type="number" value={questionForm.scaleMin} onChange={e => setQuestionForm({ ...questionForm, scaleMin: e.target.value })} /></label>
          <label>Scale max<input type="number" value={questionForm.scaleMax} onChange={e => setQuestionForm({ ...questionForm, scaleMax: e.target.value })} /></label>
          <label>Options text<TextField value={questionForm.optionsText} onValue={nextValue => setQuestionForm({ ...questionForm, optionsText: nextValue })} placeholder="for multiple_choice, pipe-separated" /></label>
          <label>Order<input type="number" value={questionForm.displayOrder} onChange={e => setQuestionForm({ ...questionForm, displayOrder: e.target.value })} /></label>
          <label><input type="checkbox" checked={questionForm.isRequired} onChange={e => setQuestionForm({ ...questionForm, isRequired: e.target.checked })} /> Required</label>
          <label>Question text<TextField as="textarea" value={questionForm.questionText} onValue={nextValue => setQuestionForm({ ...questionForm, questionText: nextValue })} required /></label>
          <button type="submit">Add question</button>
        </form>}
      </DetailModal>}
    </>}

    {tab === 'Survey Responses' && <>
      {!selectedSurvey && <>
        <p>All survey responses across all surveys. Open a survey from the Satisfaction Surveys tab to record new responses.</p>
        <table className="data-table"><thead><tr><th>Survey</th><th>Type</th><th>Date</th><th>Respondent</th><th>Source</th><th>Stakeholder</th><th>Comment</th></tr></thead><tbody>
          {allResponses.map(r => <tr key={r.id}><td>{(r as any).survey_number ? `${(r as any).survey_number} — ` : ''}{r.survey_title || `Survey #${r.survey_id}`}</td><td>{((r as any).survey_type || '').replace(/_/g, ' ')}</td><td>{r.response_date}</td><td>{r.respondent_name || '—'}</td><td>{r.source_channel || '—'}</td><td>{r.stakeholder_name || '—'}</td><td>{r.overall_comment || '—'}</td></tr>)}
        </tbody></table>
      </>}
      {selectedSurvey && <div className="card">
        <h3>{selectedSurvey.survey_number} — {selectedSurvey.survey_title}</h3>
        <table className="data-table"><thead><tr><th>Date</th><th>Respondent</th><th>Role</th><th>Source</th><th>Overall comment</th></tr></thead><tbody>
          {surveyResponses.map(r => <tr key={r.id}><td>{r.response_date}</td><td>{r.respondent_name || r.stakeholder_name || '—'}</td><td>{r.respondent_role || '—'}</td><td>{r.source_channel || '—'}</td><td>{r.overall_comment || '—'}</td></tr>)}
        </tbody></table>
        {selectedSurvey.status === 'active' && can('customer_focus.surveys', 'create') && <form className="form-grid" onSubmit={submitResponse}>
          <h4>Record new response</h4>
          <label>Response date<input type="date" value={respForm.responseDate} onChange={e => setRespForm({ ...respForm, responseDate: e.target.value })} required /></label>
          <label>Respondent name<TextField value={respForm.respondentName} onValue={nextValue => setRespForm({ ...respForm, respondentName: nextValue })} /></label>
          <label>Respondent role<TextField value={respForm.respondentRole} onValue={nextValue => setRespForm({ ...respForm, respondentRole: nextValue })} /></label>
          <label>Source channel<TextField value={respForm.sourceChannel} onValue={nextValue => setRespForm({ ...respForm, sourceChannel: nextValue })} placeholder="e.g. paper, in-person, web" /></label>
          <label>Stakeholder (optional)<select value={respForm.stakeholderId} onChange={e => setRespForm({ ...respForm, stakeholderId: e.target.value })}><option value="">—</option>{stakeholders.filter(s => s.is_active).map(s => <option key={s.id} value={s.id}>{s.stakeholder_name}</option>)}</select></label>
          <label>Overall comment<TextField as="textarea" value={respForm.overallComment} onValue={nextValue => setRespForm({ ...respForm, overallComment: nextValue })} /></label>
          {(selectedSurvey.questions || []).map(q => <label key={q.id}>{q.question_text}{q.is_required ? ' *' : ''}
            {q.question_type === 'scale' ? <input type="number" min={q.scale_min ?? undefined} max={q.scale_max ?? undefined} value={respForm.answers[q.id]?.answerNumber ?? ''} onChange={e => setRespForm({ ...respForm, answers: { ...respForm.answers, [q.id]: { answerText: '', answerNumber: e.target.value } } })} />
              : q.question_type === 'yes_no' ? <select value={respForm.answers[q.id]?.answerText ?? ''} onChange={e => setRespForm({ ...respForm, answers: { ...respForm.answers, [q.id]: { answerText: e.target.value, answerNumber: '' } } })}><option value="">—</option><option value="yes">Yes</option><option value="no">No</option></select>
              : q.question_type === 'multiple_choice' ? <select value={respForm.answers[q.id]?.answerText ?? ''} onChange={e => setRespForm({ ...respForm, answers: { ...respForm.answers, [q.id]: { answerText: e.target.value, answerNumber: '' } } })}><option value="">—</option>{(q.options_text || '').split('|').filter(Boolean).map(o => <option key={o} value={o}>{o}</option>)}</select>
              : q.question_type === 'long_text' ? <TextField as="textarea" value={respForm.answers[q.id]?.answerText ?? ''} onValue={nextValue => setRespForm({ ...respForm, answers: { ...respForm.answers, [q.id]: { answerText: nextValue, answerNumber: '' } } })} />
              : <TextField value={respForm.answers[q.id]?.answerText ?? ''} onValue={nextValue => setRespForm({ ...respForm, answers: { ...respForm.answers, [q.id]: { answerText: nextValue, answerNumber: '' } } })} />}
          </label>)}
          <button type="submit">Save response</button>
        </form>}
      </div>}
    </>}

    {tab === 'Communication Log' && <>
      {can('customer_focus.communication', 'create') && <form className="form-grid" onSubmit={submitCommunication}>
        <label>Date<input type="date" value={commForm.communicationDate} onChange={e => setCommForm({ ...commForm, communicationDate: e.target.value })} required /></label>
        <label>Type<select value={commForm.communicationType} onChange={e => setCommForm({ ...commForm, communicationType: e.target.value })}>{COMMUNICATION_TYPES.map(t => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}</select></label>
        <label>Direction<select value={commForm.direction} onChange={e => setCommForm({ ...commForm, direction: e.target.value })}>{COMMUNICATION_DIRECTIONS.map(d => <option key={d} value={d}>{d}</option>)}</select></label>
        <label>Channel<TextField value={commForm.channel} onValue={nextValue => setCommForm({ ...commForm, channel: nextValue })} placeholder="email, phone, meeting…" /></label>
        <label>Stakeholder<select value={commForm.stakeholderId} onChange={e => setCommForm({ ...commForm, stakeholderId: e.target.value })}><option value="">—</option>{stakeholders.filter(s => s.is_active).map(s => <option key={s.id} value={s.id}>{s.stakeholder_name}</option>)}</select></label>
        <label>Linked feedback<select value={commForm.feedbackId} onChange={e => setCommForm({ ...commForm, feedbackId: e.target.value })}><option value="">—</option>{feedback.map(f => <option key={f.id} value={f.id}>{f.feedback_number} — {f.title}</option>)}</select></label>
        <label>Contact name<TextField value={commForm.contactName} onValue={nextValue => setCommForm({ ...commForm, contactName: nextValue })} /></label>
        <label>Contact detail<TextField value={commForm.contactDetail} onValue={nextValue => setCommForm({ ...commForm, contactDetail: nextValue })} /></label>
        <label>Follow-up due<input type="date" value={commForm.followUpDueDate} onChange={e => setCommForm({ ...commForm, followUpDueDate: e.target.value })} /></label>
        <label>Subject<TextField value={commForm.subject} onValue={nextValue => setCommForm({ ...commForm, subject: nextValue })} required /></label>
        <label>Message summary<TextField as="textarea" value={commForm.messageSummary} onValue={nextValue => setCommForm({ ...commForm, messageSummary: nextValue })} required /></label>
        <button type="submit">Log communication</button>
      </form>}
      <table className="data-table"><thead><tr><th>Number</th><th>Date</th><th>Type</th><th>Dir.</th><th>Subject</th><th>Stakeholder</th><th>Status</th><th></th></tr></thead><tbody>
        {communications.map(c => <tr key={c.id}>
          <td>{c.communication_number}</td><td>{c.communication_date}</td><td>{c.communication_type.replace(/_/g, ' ')}</td>
          <td>{c.direction}</td><td>{c.subject}</td><td>{c.stakeholder_name || '—'}</td><td>{formatBadge(c.status)}</td>
          <td>
            {c.direction === 'outbound' && (c.channel || '').toLowerCase().includes('email') && c.contact_detail && c.contact_detail.includes('@') && <a href={`mailto:${encodeURIComponent(c.contact_detail)}?subject=${encodeURIComponent(c.subject)}&body=${encodeURIComponent(c.message_summary)}`} target="_blank" rel="noreferrer"><button type="button">Open in mail</button></a>}
            {can('actions', 'create') && <button onClick={() => commCreateAction(c.id)}>Action</button>}
            {c.status !== 'closed' && can('customer_focus.communication', 'edit') && <button onClick={() => closeComm(c.id)}>Close</button>}
          </td>
        </tr>)}
      </tbody></table>
    </>}

    {tab === 'Imports' && <>
      <p><small>Supported import types: feedback, survey_responses, stakeholders, other. CSV / XLSX. Stakeholder import expects columns like stakeholderName, stakeholderType, organisation, email. Feedback import expects feedbackDate, feedbackType, title, description.</small></p>
      {/* Reading the batch register is one right; putting a file into it is
          another. A "View" user sees the history and not the upload form. */}
      {can('customer_focus.imports', 'import') && <form className="form-grid" onSubmit={submitImport}>
        <label>Import type<select value={importForm.importType} onChange={e => setImportForm({ ...importForm, importType: e.target.value })}>{IMPORT_TYPES.map(t => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}</select></label>
        <label>File<input type="file" accept=".csv,.xlsx,.xls" onChange={e => setImportForm({ ...importForm, file: e.target.files?.[0] ?? null })} required /></label>
        <label>Notes<TextField as="textarea" value={importForm.notes} onValue={nextValue => setImportForm({ ...importForm, notes: nextValue })} /></label>
        <button type="submit">Upload batch</button>
      </form>}
      <table className="data-table"><thead><tr><th>Batch</th><th>Type</th><th>Status</th><th>Rows</th><th>Processed</th><th>Exceptions</th><th></th></tr></thead><tbody>
        {imports.map(b => <tr key={b.id}>
          <td>{b.batch_number}</td><td>{b.import_type}</td><td>{formatBadge(b.status)}</td>
          <td>{b.total_rows}</td><td>{b.processed_rows}</td><td>{b.exception_count}</td>
          <td>{can('customer_focus.imports', 'edit') && b.status !== 'processed' && <button onClick={() => processImport(b.id)}>Process</button>}</td>
        </tr>)}
      </tbody></table>
    </>}

    {tab === 'Reports' && <p>Customer focus reports (sentiment trend, NPS-style breakdown, response heatmaps) will be added in a later phase. Use Print on each feedback row to output the printable record for any selected feedback.</p>}
  </div>;
}
