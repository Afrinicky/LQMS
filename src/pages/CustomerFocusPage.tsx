import { FormEvent, useEffect, useState } from 'react';
import { useModules } from '../hooks/useModules';
import { api, API_BASE, getToken } from '../services/api';
import DisabledModule from '../components/DisabledModule';
import type {
  Section, Department, Staff,
  CustomerStakeholder, ServiceAgreement, CustomerFeedback,
  SatisfactionSurvey, SatisfactionSurveyQuestion, SatisfactionSurveyResponse,
  CustomerCommunicationLog, CustomerFocusImportBatch, CustomerFocusSummary
} from '../../shared/types/api';

const statusBadgeClass = (status?: string) => `badge ${status ? status.toLowerCase().replace(/\s+/g, '-') : 'unknown'}`;
const formatBadge = (status?: string) => <span className={statusBadgeClass(status)}>{status ? status.replace(/_/g, ' ') : 'Unknown'}</span>;
const tabBar = (active: string, tabs: string[], onChange: (name: string) => void) =>
  <div className="tabs">{tabs.map(name => <button key={name} type="button" className={active === name ? 'active' : ''} onClick={() => onChange(name)}>{name}</button>)}</div>;

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
        api<CustomerStakeholder[]>('/customer-focus/stakeholders'),
        api<ServiceAgreement[]>('/customer-focus/service-agreements'),
        api<CustomerFeedback[]>('/customer-focus/feedback'),
        api<SatisfactionSurvey[]>('/customer-focus/surveys'),
        api<CustomerCommunicationLog[]>('/customer-focus/communications'),
        api<CustomerFocusImportBatch[]>('/customer-focus/imports')
      ]);
      if (sum) setSummary(sum);
      setStakeholders(st); setAgreements(sa); setFeedback(fb); setSurveys(sv); setCommunications(cm); setImports(im);
    } catch (e) { setError((e as Error).message); }
  }
  useEffect(() => { if (isEnabled('customer_focus')) void load(); }, [isEnabled]);
  if (!isEnabled('customer_focus')) return <DisabledModule />;

  async function openSurvey(id: number) {
    try {
      setSelectedSurvey(await api<SatisfactionSurvey>(`/customer-focus/surveys/${id}`));
      setSurveyResponses(await api<SatisfactionSurveyResponse[]>(`/customer-focus/surveys/${id}/responses`));
      setRespForm(r => ({ ...r, answers: {} }));
    } catch (e) { setError((e as Error).message); }
  }

  async function submitStakeholder(e: FormEvent) {
    e.preventDefault(); setError(null);
    try {
      await api('/customer-focus/stakeholders', { method: 'POST', body: JSON.stringify(stakeForm) });
      setStakeForm({ stakeholderName: '', stakeholderType: 'internal_unit', organisation: '', contactPerson: '', email: '', phone: '', address: '', departmentId: '', sectionId: '', notes: '' });
      await load(); setTab('Stakeholders');
    } catch (e) { setError((e as Error).message); }
  }
  async function toggleStakeholder(id: number) { try { await api(`/customer-focus/stakeholders/${id}/toggle`, { method: 'POST', body: JSON.stringify({}) }); await load(); } catch (e) { setError((e as Error).message); } }

  async function submitAgreement(e: FormEvent) {
    e.preventDefault(); setError(null);
    try {
      await api('/customer-focus/service-agreements', { method: 'POST', body: JSON.stringify(agreeForm) });
      setAgreeForm({ stakeholderId: '', agreementTitle: '', serviceScope: '', startDate: '', endDate: '', reviewDueDate: '', responsibleStaffId: '', agreedTurnaround: '', reportingFormat: '', notes: '' });
      await load();
    } catch (e) { setError((e as Error).message); }
  }
  async function approveAgreement(id: number) { try { await api(`/customer-focus/service-agreements/${id}/approve`, { method: 'POST', body: JSON.stringify({}) }); await load(); } catch (e) { setError((e as Error).message); } }
  async function archiveAgreement(id: number) { try { await api(`/customer-focus/service-agreements/${id}/archive`, { method: 'POST', body: JSON.stringify({}) }); await load(); } catch (e) { setError((e as Error).message); } }

  async function submitFeedback(e: FormEvent) {
    e.preventDefault(); setError(null);
    try {
      await api('/customer-focus/feedback', { method: 'POST', body: JSON.stringify(feedbackForm) });
      setFeedbackForm({ feedbackDate: '', feedbackType: 'concern', sourceChannel: '', stakeholderId: '', contactName: '', contactDetail: '', title: '', description: '', urgency: 'medium', sentiment: '', assignedToStaffId: '', followUpDueDate: '' });
      await load();
    } catch (e) { setError((e as Error).message); }
  }
  async function escalateToComplaint(id: number) { try { await api(`/customer-focus/feedback/${id}/create-complaint`, { method: 'POST', body: JSON.stringify({}) }); await load(); } catch (e) { setError((e as Error).message); } }
  async function feedbackCreateAction(id: number) { const title = prompt('Action title?'); if (!title) return; try { await api(`/customer-focus/feedback/${id}/create-action`, { method: 'POST', body: JSON.stringify({ title }) }); await load(); } catch (e) { setError((e as Error).message); } }
  async function feedbackCreateNc(id: number) { try { await api(`/customer-focus/feedback/${id}/create-nc`, { method: 'POST', body: JSON.stringify({}) }); await load(); } catch (e) { setError((e as Error).message); } }
  async function feedbackCreateCapa(id: number) { try { await api(`/customer-focus/feedback/${id}/create-capa`, { method: 'POST', body: JSON.stringify({}) }); await load(); } catch (e) { setError((e as Error).message); } }
  async function closeFeedback(id: number) { const summary = prompt('Resolution summary (optional)?') || ''; try { await api(`/customer-focus/feedback/${id}/close`, { method: 'POST', body: JSON.stringify({ resolutionSummary: summary }) }); await load(); } catch (e) { setError((e as Error).message); } }
  async function printFeedback(id: number) {
    try {
      const token = getToken();
      const response = await fetch(`${API_BASE}/customer-focus/feedback/${id}/print`, { headers: token ? { Authorization: `Bearer ${token}` } : undefined });
      if (!response.ok) throw new Error(await response.text() || response.statusText);
      const html = await response.text();
      const w = window.open('', '_blank');
      if (!w) { setError('Pop-up blocked. Allow pop-ups to open the print dialog.'); return; }
      w.document.open(); w.document.write(html); w.document.close();
    } catch (e) { setError((e as Error).message); }
  }

  async function submitSurvey(e: FormEvent) {
    e.preventDefault(); setError(null);
    try {
      await api('/customer-focus/surveys', { method: 'POST', body: JSON.stringify(surveyForm) });
      setSurveyForm({ surveyTitle: '', surveyType: 'clinician_satisfaction', description: '', audience: '', periodStart: '', periodEnd: '' });
      await load();
    } catch (e) { setError((e as Error).message); }
  }
  async function addQuestion(e: FormEvent) {
    e.preventDefault(); setError(null);
    if (!selectedSurvey) return;
    try {
      await api(`/customer-focus/surveys/${selectedSurvey.id}/questions`, { method: 'POST', body: JSON.stringify(questionForm) });
      setQuestionForm({ questionText: '', questionType: 'scale', scaleMin: '1', scaleMax: '5', optionsText: '', isRequired: false, displayOrder: '0', questionCode: '' });
      await openSurvey(selectedSurvey.id);
    } catch (e) { setError((e as Error).message); }
  }
  async function approveSurvey(id: number) { try { await api(`/customer-focus/surveys/${id}/approve`, { method: 'POST', body: JSON.stringify({}) }); await load(); if (selectedSurvey?.id === id) await openSurvey(id); } catch (e) { setError((e as Error).message); } }
  async function closeSurvey(id: number) { try { await api(`/customer-focus/surveys/${id}/close`, { method: 'POST', body: JSON.stringify({}) }); await load(); if (selectedSurvey?.id === id) await openSurvey(id); } catch (e) { setError((e as Error).message); } }

  async function submitResponse(e: FormEvent) {
    e.preventDefault(); setError(null);
    if (!selectedSurvey) return;
    const answers = Object.entries(respForm.answers).map(([qid, v]) => ({ questionId: Number(qid), answerText: v.answerText || undefined, answerNumber: v.answerNumber !== '' ? Number(v.answerNumber) : undefined }));
    try {
      await api(`/customer-focus/surveys/${selectedSurvey.id}/responses`, { method: 'POST', body: JSON.stringify({ ...respForm, stakeholderId: respForm.stakeholderId || null, answers }) });
      setRespForm({ responseDate: '', respondentName: '', respondentRole: '', sourceChannel: '', stakeholderId: '', overallComment: '', answers: {} });
      await openSurvey(selectedSurvey.id);
    } catch (e) { setError((e as Error).message); }
  }

  async function submitCommunication(e: FormEvent) {
    e.preventDefault(); setError(null);
    try {
      await api('/customer-focus/communications', { method: 'POST', body: JSON.stringify(commForm) });
      setCommForm({ communicationDate: '', communicationType: 'update', direction: 'outbound', channel: '', subject: '', messageSummary: '', stakeholderId: '', feedbackId: '', contactName: '', contactDetail: '', followUpDueDate: '' });
      await load();
    } catch (e) { setError((e as Error).message); }
  }
  async function commCreateAction(id: number) { const title = prompt('Action title?'); if (!title) return; try { await api(`/customer-focus/communications/${id}/create-action`, { method: 'POST', body: JSON.stringify({ title }) }); await load(); } catch (e) { setError((e as Error).message); } }
  async function closeComm(id: number) { try { await api(`/customer-focus/communications/${id}/close`, { method: 'POST', body: JSON.stringify({}) }); await load(); } catch (e) { setError((e as Error).message); } }

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
    } catch (e) { setError((e as Error).message); }
  }
  async function processImport(id: number) { try { await api(`/customer-focus/imports/${id}/process`, { method: 'POST', body: JSON.stringify({}) }); await load(); } catch (e) { setError((e as Error).message); } }

  const tabs = ['Dashboard', 'Stakeholders', 'New Stakeholder', 'Service Agreements', 'Feedback Intake', 'Satisfaction Surveys', 'Survey Responses', 'Communication Log', 'Imports', 'Reports'];

  return <div className="module-page">
    <h2>Customer Focus</h2>
    {tabBar(tab, tabs, setTab)}
    {error && <div className="error">{error}</div>}

    {tab === 'Dashboard' && (summary ? <div className="cards">
      <div className="card"><h4>Active stakeholders</h4><p className="metric">{summary.activeStakeholders}</p></div>
      <div className="card"><h4>Active service agreements</h4><p className="metric">{summary.activeServiceAgreements}</p></div>
      <div className="card"><h4>Feedback this month</h4><p className="metric">{summary.feedbackThisMonth}</p></div>
      <div className="card"><h4>Open feedback</h4><p className="metric">{summary.openFeedback}</p></div>
      <div className="card"><h4>High urgency feedback</h4><p className="metric">{summary.highUrgencyFeedback}</p></div>
      <div className="card"><h4>Active surveys</h4><p className="metric">{summary.activeSurveys}</p></div>
      <div className="card"><h4>Survey responses this month</h4><p className="metric">{summary.surveyResponsesThisMonth}</p></div>
      <div className="card"><h4>Follow-ups due</h4><p className="metric">{summary.followUpsDue}</p></div>
    </div> : <p>Loading summary…</p>)}

    {tab === 'Stakeholders' && <table className="data-table"><thead><tr><th>Number</th><th>Name</th><th>Type</th><th>Organisation</th><th>Contact</th><th>Active</th><th></th></tr></thead><tbody>
      {stakeholders.map(s => <tr key={s.id}>
        <td>{s.stakeholder_number}</td><td>{s.stakeholder_name}</td><td>{s.stakeholder_type.replace(/_/g, ' ')}</td>
        <td>{s.organisation || '—'}</td><td>{s.contact_person || s.email || s.phone || '—'}</td>
        <td>{s.is_active ? 'Yes' : 'No'}</td>
        <td><button onClick={() => toggleStakeholder(s.id)}>{s.is_active ? 'Deactivate' : 'Activate'}</button></td>
      </tr>)}
    </tbody></table>}

    {tab === 'New Stakeholder' && <form className="form-grid" onSubmit={submitStakeholder}>
      <label>Name<input value={stakeForm.stakeholderName} onChange={e => setStakeForm({ ...stakeForm, stakeholderName: e.target.value })} required /></label>
      <label>Type<select value={stakeForm.stakeholderType} onChange={e => setStakeForm({ ...stakeForm, stakeholderType: e.target.value })} required>{STAKEHOLDER_TYPES.map(t => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}</select></label>
      <label>Organisation<input value={stakeForm.organisation} onChange={e => setStakeForm({ ...stakeForm, organisation: e.target.value })} /></label>
      <label>Contact person<input value={stakeForm.contactPerson} onChange={e => setStakeForm({ ...stakeForm, contactPerson: e.target.value })} /></label>
      <label>Email<input value={stakeForm.email} onChange={e => setStakeForm({ ...stakeForm, email: e.target.value })} /></label>
      <label>Phone<input value={stakeForm.phone} onChange={e => setStakeForm({ ...stakeForm, phone: e.target.value })} /></label>
      <label>Address<input value={stakeForm.address} onChange={e => setStakeForm({ ...stakeForm, address: e.target.value })} /></label>
      <label>Department<select value={stakeForm.departmentId} onChange={e => setStakeForm({ ...stakeForm, departmentId: e.target.value })}><option value="">—</option>{departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
      <label>Section<select value={stakeForm.sectionId} onChange={e => setStakeForm({ ...stakeForm, sectionId: e.target.value })}><option value="">—</option>{sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
      <label>Notes<textarea value={stakeForm.notes} onChange={e => setStakeForm({ ...stakeForm, notes: e.target.value })} /></label>
      <button type="submit">Create stakeholder</button>
    </form>}

    {tab === 'Service Agreements' && <>
      <form className="form-grid" onSubmit={submitAgreement}>
        <label>Stakeholder<select value={agreeForm.stakeholderId} onChange={e => setAgreeForm({ ...agreeForm, stakeholderId: e.target.value })} required><option value="">—</option>{stakeholders.filter(s => s.is_active).map(s => <option key={s.id} value={s.id}>{s.stakeholder_name}</option>)}</select></label>
        <label>Title<input value={agreeForm.agreementTitle} onChange={e => setAgreeForm({ ...agreeForm, agreementTitle: e.target.value })} required /></label>
        <label>Start date<input type="date" value={agreeForm.startDate} onChange={e => setAgreeForm({ ...agreeForm, startDate: e.target.value })} /></label>
        <label>End date<input type="date" value={agreeForm.endDate} onChange={e => setAgreeForm({ ...agreeForm, endDate: e.target.value })} /></label>
        <label>Review due<input type="date" value={agreeForm.reviewDueDate} onChange={e => setAgreeForm({ ...agreeForm, reviewDueDate: e.target.value })} /></label>
        <label>Responsible staff<select value={agreeForm.responsibleStaffId} onChange={e => setAgreeForm({ ...agreeForm, responsibleStaffId: e.target.value })}><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
        <label>Agreed turnaround<input value={agreeForm.agreedTurnaround} onChange={e => setAgreeForm({ ...agreeForm, agreedTurnaround: e.target.value })} placeholder="e.g. 24 hours" /></label>
        <label>Reporting format<input value={agreeForm.reportingFormat} onChange={e => setAgreeForm({ ...agreeForm, reportingFormat: e.target.value })} placeholder="e.g. monthly PDF" /></label>
        <label>Service scope<textarea value={agreeForm.serviceScope} onChange={e => setAgreeForm({ ...agreeForm, serviceScope: e.target.value })} required /></label>
        <label>Notes<textarea value={agreeForm.notes} onChange={e => setAgreeForm({ ...agreeForm, notes: e.target.value })} /></label>
        <button type="submit">Create agreement</button>
      </form>
      <table className="data-table"><thead><tr><th>Number</th><th>Stakeholder</th><th>Title</th><th>Period</th><th>Status</th><th></th></tr></thead><tbody>
        {agreements.map(a => <tr key={a.id}>
          <td>{a.agreement_number}</td><td>{a.stakeholder_name || '—'}</td><td>{a.agreement_title}</td>
          <td>{a.start_date || '—'} → {a.end_date || '—'}</td><td>{formatBadge(a.status)}</td>
          <td>
            {a.status !== 'active' && <button onClick={() => approveAgreement(a.id)}>Approve</button>}
            {a.status !== 'archived' && <button onClick={() => archiveAgreement(a.id)}>Archive</button>}
          </td>
        </tr>)}
      </tbody></table>
    </>}

    {tab === 'Feedback Intake' && <>
      <form className="form-grid" onSubmit={submitFeedback}>
        <label>Date<input type="date" value={feedbackForm.feedbackDate} onChange={e => setFeedbackForm({ ...feedbackForm, feedbackDate: e.target.value })} required /></label>
        <label>Type<select value={feedbackForm.feedbackType} onChange={e => setFeedbackForm({ ...feedbackForm, feedbackType: e.target.value })} required>{FEEDBACK_TYPES.map(t => <option key={t} value={t}>{t}</option>)}</select></label>
        <label>Source channel<input value={feedbackForm.sourceChannel} onChange={e => setFeedbackForm({ ...feedbackForm, sourceChannel: e.target.value })} placeholder="e.g. phone, email, in-person" /></label>
        <label>Stakeholder<select value={feedbackForm.stakeholderId} onChange={e => setFeedbackForm({ ...feedbackForm, stakeholderId: e.target.value })}><option value="">—</option>{stakeholders.filter(s => s.is_active).map(s => <option key={s.id} value={s.id}>{s.stakeholder_name}</option>)}</select></label>
        <label>Contact name<input value={feedbackForm.contactName} onChange={e => setFeedbackForm({ ...feedbackForm, contactName: e.target.value })} /></label>
        <label>Contact detail<input value={feedbackForm.contactDetail} onChange={e => setFeedbackForm({ ...feedbackForm, contactDetail: e.target.value })} placeholder="phone / email" /></label>
        <label>Urgency<select value={feedbackForm.urgency} onChange={e => setFeedbackForm({ ...feedbackForm, urgency: e.target.value })}>{URGENCIES.map(u => <option key={u} value={u}>{u}</option>)}</select></label>
        <label>Sentiment<input value={feedbackForm.sentiment} onChange={e => setFeedbackForm({ ...feedbackForm, sentiment: e.target.value })} placeholder="positive / neutral / negative (optional)" /></label>
        <label>Assigned to<select value={feedbackForm.assignedToStaffId} onChange={e => setFeedbackForm({ ...feedbackForm, assignedToStaffId: e.target.value })}><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
        <label>Follow-up due<input type="date" value={feedbackForm.followUpDueDate} onChange={e => setFeedbackForm({ ...feedbackForm, followUpDueDate: e.target.value })} /></label>
        <label>Title<input value={feedbackForm.title} onChange={e => setFeedbackForm({ ...feedbackForm, title: e.target.value })} required /></label>
        <label>Description<textarea value={feedbackForm.description} onChange={e => setFeedbackForm({ ...feedbackForm, description: e.target.value })} required /></label>
        <button type="submit">Record feedback</button>
      </form>
      <table className="data-table"><thead><tr><th>Number</th><th>Date</th><th>Type</th><th>Title</th><th>Urgency</th><th>Status</th><th>Stakeholder</th><th>Actions</th></tr></thead><tbody>
        {feedback.map(f => <tr key={f.id}>
          <td>{f.feedback_number}</td><td>{f.feedback_date}</td><td>{f.feedback_type}</td>
          <td>{f.title}</td><td>{formatBadge(f.urgency)}</td><td>{formatBadge(f.status)}</td>
          <td>{f.stakeholder_name || '—'}</td>
          <td>
            <button onClick={() => printFeedback(f.id)}>Print</button>
            {!f.complaint_id && <button onClick={() => escalateToComplaint(f.id)}>Escalate to complaint</button>}
            <button onClick={() => feedbackCreateAction(f.id)}>Action</button>
            {!f.nc_id && <button onClick={() => feedbackCreateNc(f.id)}>NC</button>}
            {!f.capa_id && <button onClick={() => feedbackCreateCapa(f.id)}>CAPA</button>}
            {f.status !== 'closed' && <button onClick={() => closeFeedback(f.id)}>Close</button>}
          </td>
        </tr>)}
      </tbody></table>
    </>}

    {tab === 'Satisfaction Surveys' && <>
      <form className="form-grid" onSubmit={submitSurvey}>
        <label>Title<input value={surveyForm.surveyTitle} onChange={e => setSurveyForm({ ...surveyForm, surveyTitle: e.target.value })} required /></label>
        <label>Type<select value={surveyForm.surveyType} onChange={e => setSurveyForm({ ...surveyForm, surveyType: e.target.value })} required>{SURVEY_TYPES.map(t => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}</select></label>
        <label>Audience<input value={surveyForm.audience} onChange={e => setSurveyForm({ ...surveyForm, audience: e.target.value })} /></label>
        <label>Period start<input type="date" value={surveyForm.periodStart} onChange={e => setSurveyForm({ ...surveyForm, periodStart: e.target.value })} /></label>
        <label>Period end<input type="date" value={surveyForm.periodEnd} onChange={e => setSurveyForm({ ...surveyForm, periodEnd: e.target.value })} /></label>
        <label>Description<textarea value={surveyForm.description} onChange={e => setSurveyForm({ ...surveyForm, description: e.target.value })} /></label>
        <button type="submit">Create survey</button>
      </form>
      <table className="data-table"><thead><tr><th>Number</th><th>Title</th><th>Type</th><th>Status</th><th>Period</th><th></th></tr></thead><tbody>
        {surveys.map(s => <tr key={s.id}>
          <td>{s.survey_number}</td><td>{s.survey_title}</td><td>{s.survey_type.replace(/_/g, ' ')}</td>
          <td>{formatBadge(s.status)}</td><td>{s.period_start || '—'} → {s.period_end || '—'}</td>
          <td>
            <button onClick={() => openSurvey(s.id)}>Open</button>
            {s.status === 'draft' && <button onClick={() => approveSurvey(s.id)}>Approve / activate</button>}
            {s.status === 'active' && <button onClick={() => closeSurvey(s.id)}>Close</button>}
          </td>
        </tr>)}
      </tbody></table>
      {selectedSurvey && <div className="card" style={{ marginTop: 16 }}>
        <h3>{selectedSurvey.survey_number} — {selectedSurvey.survey_title}</h3>
        <p>Status: {formatBadge(selectedSurvey.status)} | Type: {selectedSurvey.survey_type.replace(/_/g, ' ')} | Responses: {selectedSurvey.responseCount ?? 0}</p>
        <h4>Questions</h4>
        <table className="data-table"><thead><tr><th>Order</th><th>Text</th><th>Type</th><th>Scale</th><th>Required</th></tr></thead><tbody>
          {(selectedSurvey.questions || []).map(q => <tr key={q.id}><td>{q.display_order}</td><td>{q.question_text}</td><td>{q.question_type}</td><td>{q.scale_min !== null && q.scale_max !== null ? `${q.scale_min}–${q.scale_max}` : '—'}</td><td>{q.is_required ? 'Yes' : 'No'}</td></tr>)}
        </tbody></table>
        {selectedSurvey.status === 'draft' && <form className="form-grid" onSubmit={addQuestion}>
          <label>Code<input value={questionForm.questionCode} onChange={e => setQuestionForm({ ...questionForm, questionCode: e.target.value })} /></label>
          <label>Type<select value={questionForm.questionType} onChange={e => setQuestionForm({ ...questionForm, questionType: e.target.value })}>{QUESTION_TYPES.map(t => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}</select></label>
          <label>Scale min<input type="number" value={questionForm.scaleMin} onChange={e => setQuestionForm({ ...questionForm, scaleMin: e.target.value })} /></label>
          <label>Scale max<input type="number" value={questionForm.scaleMax} onChange={e => setQuestionForm({ ...questionForm, scaleMax: e.target.value })} /></label>
          <label>Options text<input value={questionForm.optionsText} onChange={e => setQuestionForm({ ...questionForm, optionsText: e.target.value })} placeholder="for multiple_choice, pipe-separated" /></label>
          <label>Order<input type="number" value={questionForm.displayOrder} onChange={e => setQuestionForm({ ...questionForm, displayOrder: e.target.value })} /></label>
          <label><input type="checkbox" checked={questionForm.isRequired} onChange={e => setQuestionForm({ ...questionForm, isRequired: e.target.checked })} /> Required</label>
          <label>Question text<textarea value={questionForm.questionText} onChange={e => setQuestionForm({ ...questionForm, questionText: e.target.value })} required /></label>
          <button type="submit">Add question</button>
        </form>}
        <button className="secondary" onClick={() => { setSelectedSurvey(null); setSurveyResponses([]); }}>Close panel</button>
      </div>}
    </>}

    {tab === 'Survey Responses' && <>
      <p>Open a survey from the Satisfaction Surveys tab. Active surveys accept new responses.</p>
      {selectedSurvey && <div className="card">
        <h3>{selectedSurvey.survey_number} — {selectedSurvey.survey_title}</h3>
        <table className="data-table"><thead><tr><th>Date</th><th>Respondent</th><th>Role</th><th>Source</th><th>Overall comment</th></tr></thead><tbody>
          {surveyResponses.map(r => <tr key={r.id}><td>{r.response_date}</td><td>{r.respondent_name || r.stakeholder_name || '—'}</td><td>{r.respondent_role || '—'}</td><td>{r.source_channel || '—'}</td><td>{r.overall_comment || '—'}</td></tr>)}
        </tbody></table>
        {selectedSurvey.status === 'active' && <form className="form-grid" onSubmit={submitResponse}>
          <h4>Record new response</h4>
          <label>Response date<input type="date" value={respForm.responseDate} onChange={e => setRespForm({ ...respForm, responseDate: e.target.value })} required /></label>
          <label>Respondent name<input value={respForm.respondentName} onChange={e => setRespForm({ ...respForm, respondentName: e.target.value })} /></label>
          <label>Respondent role<input value={respForm.respondentRole} onChange={e => setRespForm({ ...respForm, respondentRole: e.target.value })} /></label>
          <label>Source channel<input value={respForm.sourceChannel} onChange={e => setRespForm({ ...respForm, sourceChannel: e.target.value })} placeholder="e.g. paper, in-person, web" /></label>
          <label>Stakeholder (optional)<select value={respForm.stakeholderId} onChange={e => setRespForm({ ...respForm, stakeholderId: e.target.value })}><option value="">—</option>{stakeholders.filter(s => s.is_active).map(s => <option key={s.id} value={s.id}>{s.stakeholder_name}</option>)}</select></label>
          <label>Overall comment<textarea value={respForm.overallComment} onChange={e => setRespForm({ ...respForm, overallComment: e.target.value })} /></label>
          {(selectedSurvey.questions || []).map(q => <label key={q.id}>{q.question_text}{q.is_required ? ' *' : ''}
            {q.question_type === 'scale' ? <input type="number" min={q.scale_min ?? undefined} max={q.scale_max ?? undefined} value={respForm.answers[q.id]?.answerNumber ?? ''} onChange={e => setRespForm({ ...respForm, answers: { ...respForm.answers, [q.id]: { answerText: '', answerNumber: e.target.value } } })} />
              : q.question_type === 'yes_no' ? <select value={respForm.answers[q.id]?.answerText ?? ''} onChange={e => setRespForm({ ...respForm, answers: { ...respForm.answers, [q.id]: { answerText: e.target.value, answerNumber: '' } } })}><option value="">—</option><option value="yes">Yes</option><option value="no">No</option></select>
              : q.question_type === 'multiple_choice' ? <select value={respForm.answers[q.id]?.answerText ?? ''} onChange={e => setRespForm({ ...respForm, answers: { ...respForm.answers, [q.id]: { answerText: e.target.value, answerNumber: '' } } })}><option value="">—</option>{(q.options_text || '').split('|').filter(Boolean).map(o => <option key={o} value={o}>{o}</option>)}</select>
              : q.question_type === 'long_text' ? <textarea value={respForm.answers[q.id]?.answerText ?? ''} onChange={e => setRespForm({ ...respForm, answers: { ...respForm.answers, [q.id]: { answerText: e.target.value, answerNumber: '' } } })} />
              : <input value={respForm.answers[q.id]?.answerText ?? ''} onChange={e => setRespForm({ ...respForm, answers: { ...respForm.answers, [q.id]: { answerText: e.target.value, answerNumber: '' } } })} />}
          </label>)}
          <button type="submit">Save response</button>
        </form>}
      </div>}
    </>}

    {tab === 'Communication Log' && <>
      <form className="form-grid" onSubmit={submitCommunication}>
        <label>Date<input type="date" value={commForm.communicationDate} onChange={e => setCommForm({ ...commForm, communicationDate: e.target.value })} required /></label>
        <label>Type<select value={commForm.communicationType} onChange={e => setCommForm({ ...commForm, communicationType: e.target.value })}>{COMMUNICATION_TYPES.map(t => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}</select></label>
        <label>Direction<select value={commForm.direction} onChange={e => setCommForm({ ...commForm, direction: e.target.value })}>{COMMUNICATION_DIRECTIONS.map(d => <option key={d} value={d}>{d}</option>)}</select></label>
        <label>Channel<input value={commForm.channel} onChange={e => setCommForm({ ...commForm, channel: e.target.value })} placeholder="email, phone, meeting…" /></label>
        <label>Stakeholder<select value={commForm.stakeholderId} onChange={e => setCommForm({ ...commForm, stakeholderId: e.target.value })}><option value="">—</option>{stakeholders.filter(s => s.is_active).map(s => <option key={s.id} value={s.id}>{s.stakeholder_name}</option>)}</select></label>
        <label>Linked feedback<select value={commForm.feedbackId} onChange={e => setCommForm({ ...commForm, feedbackId: e.target.value })}><option value="">—</option>{feedback.map(f => <option key={f.id} value={f.id}>{f.feedback_number} — {f.title}</option>)}</select></label>
        <label>Contact name<input value={commForm.contactName} onChange={e => setCommForm({ ...commForm, contactName: e.target.value })} /></label>
        <label>Contact detail<input value={commForm.contactDetail} onChange={e => setCommForm({ ...commForm, contactDetail: e.target.value })} /></label>
        <label>Follow-up due<input type="date" value={commForm.followUpDueDate} onChange={e => setCommForm({ ...commForm, followUpDueDate: e.target.value })} /></label>
        <label>Subject<input value={commForm.subject} onChange={e => setCommForm({ ...commForm, subject: e.target.value })} required /></label>
        <label>Message summary<textarea value={commForm.messageSummary} onChange={e => setCommForm({ ...commForm, messageSummary: e.target.value })} required /></label>
        <button type="submit">Log communication</button>
      </form>
      <table className="data-table"><thead><tr><th>Number</th><th>Date</th><th>Type</th><th>Dir.</th><th>Subject</th><th>Stakeholder</th><th>Status</th><th></th></tr></thead><tbody>
        {communications.map(c => <tr key={c.id}>
          <td>{c.communication_number}</td><td>{c.communication_date}</td><td>{c.communication_type.replace(/_/g, ' ')}</td>
          <td>{c.direction}</td><td>{c.subject}</td><td>{c.stakeholder_name || '—'}</td><td>{formatBadge(c.status)}</td>
          <td>
            <button onClick={() => commCreateAction(c.id)}>Action</button>
            {c.status !== 'closed' && <button onClick={() => closeComm(c.id)}>Close</button>}
          </td>
        </tr>)}
      </tbody></table>
    </>}

    {tab === 'Imports' && <>
      <p><small>Supported import types: feedback, survey_responses, stakeholders, other. CSV / XLSX. Stakeholder import expects columns like stakeholderName, stakeholderType, organisation, email. Feedback import expects feedbackDate, feedbackType, title, description.</small></p>
      <form className="form-grid" onSubmit={submitImport}>
        <label>Import type<select value={importForm.importType} onChange={e => setImportForm({ ...importForm, importType: e.target.value })}>{IMPORT_TYPES.map(t => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}</select></label>
        <label>File<input type="file" accept=".csv,.xlsx,.xls" onChange={e => setImportForm({ ...importForm, file: e.target.files?.[0] ?? null })} required /></label>
        <label>Notes<textarea value={importForm.notes} onChange={e => setImportForm({ ...importForm, notes: e.target.value })} /></label>
        <button type="submit">Upload batch</button>
      </form>
      <table className="data-table"><thead><tr><th>Batch</th><th>Type</th><th>Status</th><th>Rows</th><th>Processed</th><th>Exceptions</th><th></th></tr></thead><tbody>
        {imports.map(b => <tr key={b.id}>
          <td>{b.batch_number}</td><td>{b.import_type}</td><td>{formatBadge(b.status)}</td>
          <td>{b.total_rows}</td><td>{b.processed_rows}</td><td>{b.exception_count}</td>
          <td>{b.status !== 'processed' && <button onClick={() => processImport(b.id)}>Process</button>}</td>
        </tr>)}
      </tbody></table>
    </>}

    {tab === 'Reports' && <p>Customer focus reports (sentiment trend, NPS-style breakdown, response heatmaps) will be added in a later phase. Use Print on each feedback row to output the printable record for any selected feedback.</p>}
  </div>;
}
