import { FormEvent, useEffect, useState } from 'react';
import PageHeader from '../components/ui/PageHeader';
import { KpiStrip, ChartCard, DonutChart, BarMeter, CHART_COLORS, ModuleAlerts, DetailModal } from '../components/ui';
import { useModules } from '../hooks/useModules';
import { api, API_BASE, getToken, errorText } from '../services/api';
import DisabledModule from '../components/DisabledModule';
import { RisksPage } from './QMSPages';
import { usePermissions } from '../hooks/usePermissions';
import PermissionTabs from '../components/PermissionTabs';
import { useTabParam } from '../hooks/useTabParam';
import type {
  Section, Department, Staff,
  AssessmentProgram, AssessmentFinding,
  Meeting, MeetingAttendance,
  ManagementReview, ManagementReviewInput,
  QualityIndicator, QualityIndicatorResult,
  ImprovementProject, ImprovementUpdate,
  GovernanceSummary,
  AssessmentChecklist, AssessmentChecklistSection, AssessmentChecklistQuestion,
  AssessmentSelectedQuestion, AssessmentInternalScoreSummary
} from '../../shared/types/api';

const statusBadgeClass = (status?: string) => `badge ${status ? status.toLowerCase().replace(/\s+/g, '-') : 'unknown'}`;
const formatBadge = (status?: string) => <span className={statusBadgeClass(status)}>{status ? status.replace(/_/g, ' ') : 'Unknown'}</span>;
// Tabs are filtered by permission — a tab whose feature this user cannot
// view is not drawn. These pages host several modules, so each call
// passes the module its tabs belong to.
const tabBarFor = (moduleKey: string) => (active: string, tabs: string[], onChange: (name: string) => void) =>
  <PermissionTabs moduleKey={moduleKey} tabs={tabs} active={active} onChange={onChange} />;

const ASSESSMENT_TYPES = ['internal_audit', 'self_assessment', 'gap_review', 'peer_review', 'other'];
const FINDING_TYPES = ['observation', 'nonconformity', 'improvement_opportunity', 'risk'];
const MEETING_TYPES = ['quality_meeting', 'section_meeting', 'safety_meeting', 'management_review', 'other'];
const ATTENDANCE_STATUSES = ['invited', 'present', 'absent', 'excused'];
const FREQUENCIES = ['daily', 'weekly', 'monthly', 'quarterly', 'biannual', 'annual'];
const IMPROVEMENT_AREAS = ['pre_analytical', 'analytical', 'post_analytical', 'turnaround_time', 'safety', 'customer_service', 'staff_competency', 'other'];
const CHECKLIST_TYPES = ['general', 'sectional', 'section_specific', 'safety', 'document_control', 'theme', 'other'];
const CHECKLIST_STATUSES = ['draft', 'active', 'inactive', 'archived', 'replaced'];
const RESPONSE_OPTIONS = ['met', 'partially_met', 'not_met', 'not_applicable', 'not_assessed', 'observation_only'];
const RESPONSE_TYPES = ['met_partial_not_met', 'yes_no', 'observation_only', 'numeric_marks'];
const SELECTION_MODES = ['whole_checklist', 'selected_sections', 'selected_questions', 'mixed'];

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

function useGovernanceSummary() {
  const [s, setS] = useState<GovernanceSummary | null>(null);
  useEffect(() => { api<GovernanceSummary>('/dashboard/governance-summary').then(setS).catch(() => undefined); }, []);
  return s;
}

function dashboardCards(s: GovernanceSummary | null, keys: Array<{ label: string; value: keyof GovernanceSummary; onClick?: () => void }>) {
  if (!s) return <p>Loading summary…</p>;
  const series = keys.map((k, i) => ({ label: k.label, value: Number(s[k.value]) || 0, color: CHART_COLORS[i % CHART_COLORS.length], onClick: k.onClick }));
  return <>
    <KpiStrip items={keys.map(k => ({ label: k.label, value: s[k.value] as number, onClick: k.onClick }))} />
    {keys.length >= 3 && <div className="grid cols-2" style={{ marginTop: 18 }}>
      <ChartCard title="Distribution" subtitle="Composition of the current governance counts">
        <DonutChart centerLabel="Total" data={series} />
      </ChartCard>
      <ChartCard title="Ranked view" subtitle="Items ordered by volume">
        <BarMeter data={series} />
      </ChartCard>
    </div>}
    {keys.length === 2 && <div className="grid cols-2" style={{ marginTop: 18 }}>
      <ChartCard title="Comparison" subtitle="Current governance counts">
        <BarMeter data={series} />
      </ChartCard>
    </div>}
  </>;
}

// ============= Assessments =============
// Every tab the assessments workspace can show, so an alert can name one.
const ASSESSMENT_TABS = ['Dashboard', 'Assessment Programmes', 'New Assessment', 'Checklist Library',
  'Plan Assessment', 'Assessment Questions', 'Internal Audit Marks', 'Findings', 'Reports'];

export function AssessmentsPage() {
  const { canView } = usePermissions();
  const { can } = usePermissions();
  const { isEnabled } = useModules();
  const { staff, sections, departments } = useLookups();
  const summary = useGovernanceSummary();
  const [tab, setTab] = useState('Dashboard');
  const [error, setError] = useState<string | null>(null);
  const [programs, setPrograms] = useState<AssessmentProgram[]>([]);
  const [findings, setFindings] = useState<AssessmentFinding[]>([]);
  const [selected, setSelected] = useState<(AssessmentProgram & { findings?: AssessmentFinding[]; selectedChecklists?: any[] }) | null>(null);
  const [progForm, setProgForm] = useState({ title: '', assessmentType: 'internal_audit', departmentId: '', sectionId: '', plannedStartDate: '', plannedEndDate: '', leadAssessorStaffId: '', scope: '', objectives: '' });
  const [findForm, setFindForm] = useState({ findingType: 'observation', findingDate: '', title: '', description: '', severity: 'medium', evidenceSummary: '', responsibleStaffId: '' });
  // Checklist library state
  const [checklists, setChecklists] = useState<AssessmentChecklist[]>([]);
  const [selectedChecklist, setSelectedChecklist] = useState<AssessmentChecklist | null>(null);
  const [chForm, setChForm] = useState({ checklistCode: '', checklistName: '', checklistType: 'general', description: '', sourceName: '', versionLabel: '', effectiveDate: '', markingEnabled: false, internalThresholdLabel: '', internalPassMark: '' });
  const [secForm, setSecForm] = useState({ sectionTitle: '', sectionCode: '', sectionDescription: '', displayOrder: '0', sectionPossibleMarks: '', sectionWeight: '' });
  const [qForm, setQForm] = useState({ questionText: '', questionCode: '', sectionId: '', responseType: 'met_partial_not_met', guidance: '', expectedEvidence: '', maxMarks: '', weight: '', scoringGuidance: '', isRequired: false });
  // Planning state
  const [planAssessmentId, setPlanAssessmentId] = useState<string>('');
  const [planChecklistId, setPlanChecklistId] = useState<string>('');
  const [planChecklistDetail, setPlanChecklistDetail] = useState<AssessmentChecklist | null>(null);
  const [planMode, setPlanMode] = useState<string>('whole_checklist');
  const [planSelectedSections, setPlanSelectedSections] = useState<number[]>([]);
  const [planSelectedQuestions, setPlanSelectedQuestions] = useState<number[]>([]);
  const [planNotes, setPlanNotes] = useState('');
  // Question response state
  const [respAssessmentId, setRespAssessmentId] = useState<string>('');
  const [respQuestions, setRespQuestions] = useState<AssessmentSelectedQuestion[]>([]);
  const [respValues, setRespValues] = useState<Record<number, { response: string; evidenceSummary: string; marksAwarded: string; scoreComment: string; findingRequired: boolean; existingResponseId?: number }>>({});
  // Internal score summary state
  const [scoreAssessmentId, setScoreAssessmentId] = useState<string>('');
  const [scoreSummary, setScoreSummary] = useState<AssessmentInternalScoreSummary | null>(null);

  async function load() {
    try {
      setPrograms(await api<AssessmentProgram[]>('/assessments'));
      setFindings(await api<AssessmentFinding[]>('/assessments/findings'));
      setChecklists(await api<AssessmentChecklist[]>('/assessments/checklists').catch(() => []));
    } catch (e) { setError(errorText(e)); }
  }
  useEffect(() => { if (isEnabled('assessments')) void load(); }, [isEnabled]);
  // The internal-audit bar only renders once one of its tabs is active, so an
  // alert aiming at Findings is honoured here, above the module-disabled
  // return so the hook order never changes.
  useTabParam(ASSESSMENT_TABS, setTab);

  if (!isEnabled('assessments')) return <DisabledModule />;

  // Checklist library helpers
  async function openChecklist(id: number) {
    try { setSelectedChecklist(await api<AssessmentChecklist>(`/assessments/checklists/${id}`)); }
    catch (e) { setError(errorText(e)); }
  }
  async function submitChecklist(e: FormEvent) {
    e.preventDefault(); setError(null);
    try {
      await api('/assessments/checklists', { method: 'POST', body: JSON.stringify(chForm) });
      setChForm({ checklistCode: '', checklistName: '', checklistType: 'general', description: '', sourceName: '', versionLabel: '', effectiveDate: '', markingEnabled: false, internalThresholdLabel: '', internalPassMark: '' });
      await load();
    } catch (e) { setError(errorText(e)); }
  }
  async function toggleChecklist(id: number) { try { await api(`/assessments/checklists/${id}/toggle`, { method: 'POST', body: JSON.stringify({}) }); await load(); if (selectedChecklist?.id === id) await openChecklist(id); } catch (e) { setError(errorText(e)); } }
  async function archiveChecklist(id: number) { try { await api(`/assessments/checklists/${id}/archive`, { method: 'POST', body: JSON.stringify({}) }); await load(); if (selectedChecklist?.id === id) await openChecklist(id); } catch (e) { setError(errorText(e)); } }
  async function updateChecklistMarking(id: number, markingEnabled: boolean) { try { await api(`/assessments/checklists/${id}`, { method: 'PUT', body: JSON.stringify({ markingEnabled }) }); await load(); if (selectedChecklist?.id === id) await openChecklist(id); } catch (e) { setError(errorText(e)); } }
  async function addSection(e: FormEvent) {
    e.preventDefault(); setError(null);
    if (!selectedChecklist) return;
    try {
      await api(`/assessments/checklists/${selectedChecklist.id}/sections`, { method: 'POST', body: JSON.stringify(secForm) });
      setSecForm({ sectionTitle: '', sectionCode: '', sectionDescription: '', displayOrder: '0', sectionPossibleMarks: '', sectionWeight: '' });
      await openChecklist(selectedChecklist.id);
    } catch (e) { setError(errorText(e)); }
  }
  async function addQuestion(e: FormEvent) {
    e.preventDefault(); setError(null);
    if (!selectedChecklist) return;
    try {
      await api(`/assessments/checklists/${selectedChecklist.id}/questions`, { method: 'POST', body: JSON.stringify(qForm) });
      setQForm({ questionText: '', questionCode: '', sectionId: '', responseType: 'met_partial_not_met', guidance: '', expectedEvidence: '', maxMarks: '', weight: '', scoringGuidance: '', isRequired: false });
      await openChecklist(selectedChecklist.id);
    } catch (e) { setError(errorText(e)); }
  }

  // Planning helpers
  async function loadPlanChecklist(id: string) {
    if (!id) { setPlanChecklistDetail(null); return; }
    try { setPlanChecklistDetail(await api<AssessmentChecklist>(`/assessments/checklists/${id}`)); }
    catch (e) { setError(errorText(e)); }
  }
  async function savePlan() {
    setError(null);
    if (!planAssessmentId || !planChecklistId) return setError('Choose an assessment and checklist');
    try {
      const payload: any = { checklistId: Number(planChecklistId), selectionMode: planMode, notes: planNotes };
      if (planMode === 'selected_sections') payload.sectionIds = planSelectedSections;
      if (planMode === 'selected_questions' || planMode === 'mixed') { payload.questionIds = planSelectedQuestions; payload.sectionIds = planSelectedSections; }
      const result = await api<{ savedCount: number; totalPossibleAtSelection: number }>(`/assessments/${planAssessmentId}/select-checklist`, { method: 'POST', body: JSON.stringify(payload) });
      alert(`Saved ${result.savedCount} question(s). Possible marks at selection: ${result.totalPossibleAtSelection}.`);
      setPlanSelectedSections([]); setPlanSelectedQuestions([]); setPlanNotes('');
      await load();
    } catch (e) { setError(errorText(e)); }
  }

  // Response helpers
  async function loadResponseQuestions(id: string) {
    if (!id) { setRespQuestions([]); setRespValues({}); return; }
    try {
      const qs = await api<AssessmentSelectedQuestion[]>(`/assessments/${id}/selected-questions`);
      setRespQuestions(qs);
      const init: typeof respValues = {};
      for (const q of qs) init[q.question_id] = {
        response: q.existing_response ?? 'not_assessed',
        evidenceSummary: q.existing_evidence_summary ?? '',
        marksAwarded: q.existing_marks_awarded !== null && q.existing_marks_awarded !== undefined ? String(q.existing_marks_awarded) : '',
        scoreComment: q.existing_score_comment ?? '',
        findingRequired: !!q.existing_finding_required,
        existingResponseId: q.response_id
      };
      setRespValues(init);
    } catch (e) { setError(errorText(e)); }
  }
  async function saveResponse(questionId: number) {
    if (!respAssessmentId) return;
    const v = respValues[questionId];
    if (!v) return;
    try {
      await api(`/assessments/${respAssessmentId}/question-response`, { method: 'POST', body: JSON.stringify({ questionId, response: v.response, evidenceSummary: v.evidenceSummary, marksAwarded: v.marksAwarded, scoreComment: v.scoreComment, findingRequired: v.findingRequired }) });
      alert('Response saved.');
    } catch (e) { setError(errorText(e)); }
  }

  // Score summary helpers
  async function loadScoreSummary(id: string) {
    if (!id) { setScoreSummary(null); return; }
    try { setScoreSummary(await api<AssessmentInternalScoreSummary>(`/assessments/${id}/internal-score-summary`)); }
    catch (e) { setError(errorText(e)); }
  }

  // Delete helpers (history-safe)
  async function deleteChecklist(id: number) {
    if (!confirm('Delete this checklist? Only unused checklists can be deleted; otherwise archive.')) return;
    try { await api(`/assessments/checklists/${id}`, { method: 'DELETE' }); if (selectedChecklist?.id === id) setSelectedChecklist(null); await load(); }
    catch (e) { setError(errorText(e)); }
  }
  async function deleteSection(checklistId: number, sectionId: number) {
    if (!confirm('Delete this section? Only sections with no questions and no assessment usage can be deleted.')) return;
    try { await api(`/assessments/checklists/${checklistId}/sections/${sectionId}`, { method: 'DELETE' }); await openChecklist(checklistId); }
    catch (e) { setError(errorText(e)); }
  }
  async function deleteQuestion(checklistId: number, questionId: number) {
    if (!confirm('Delete this question? Only questions never used in any assessment can be deleted; otherwise deactivate.')) return;
    try { await api(`/assessments/checklists/${checklistId}/questions/${questionId}`, { method: 'DELETE' }); await openChecklist(checklistId); }
    catch (e) { setError(errorText(e)); }
  }

  // Print helper — opens server-rendered HTML in a new tab so the OS print
  // dialog runs there (which includes all installed printers and Save as PDF).
  async function openPrintPage(path: string) {
    try {
      const token = getToken();
      const response = await fetch(`${API_BASE}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : undefined });
      if (!response.ok) throw new Error(await response.text() || response.statusText);
      const html = await response.text();
      const w = window.open('', '_blank');
      if (!w) { setError('Pop-up blocked. Allow pop-ups to open the print dialog.'); return; }
      w.document.open();
      w.document.write(html);
      w.document.close();
    } catch (e) { setError(errorText(e)); }
  }

  // File import helper (CSV / XLSX)
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importMeta, setImportMeta] = useState({ checklistName: '', checklistType: 'general', markingEnabled: false, internalPassMark: '' });
  async function submitFileImport(e: FormEvent) {
    e.preventDefault(); setError(null);
    if (!importFile) return setError('Choose a CSV or XLSX file');
    if (!importMeta.checklistName) return setError('Checklist name is required');
    try {
      const fd = new FormData();
      fd.append('file', importFile);
      fd.append('checklistName', importMeta.checklistName);
      fd.append('checklistType', importMeta.checklistType);
      fd.append('markingEnabled', String(importMeta.markingEnabled));
      if (importMeta.internalPassMark) fd.append('internalPassMark', importMeta.internalPassMark);
      const token = getToken();
      const response = await fetch(`${API_BASE}/assessments/checklists/import-file`, { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : undefined, body: fd });
      if (!response.ok) throw new Error((await response.json().catch(() => ({ error: response.statusText }))).error ?? response.statusText);
      const data = await response.json();
      alert(`Imported checklist #${data.id}: ${data.sectionsInserted} section(s), ${data.questionsInserted} question(s).`);
      setImportFile(null); setImportMeta({ checklistName: '', checklistType: 'general', markingEnabled: false, internalPassMark: '' });
      await load();
    } catch (e) { setError(errorText(e)); }
  }

  // Response history viewer
  const [historyResponseId, setHistoryResponseId] = useState<number | null>(null);
  const [history, setHistory] = useState<Array<{ snapshot_at: string; response: string; marks_awarded?: number; evidence_summary?: string }>>([]);
  async function loadHistory(responseId: number) {
    if (!respAssessmentId) return;
    try { setHistoryResponseId(responseId); setHistory(await api(`/assessments/${respAssessmentId}/question-response/${responseId}/history`)); }
    catch (e) { setError(errorText(e)); }
  }

  async function submitProgram(e: FormEvent) {
    e.preventDefault(); setError(null);
    try {
      await api('/assessments', { method: 'POST', body: JSON.stringify(progForm) });
      setProgForm({ title: '', assessmentType: 'internal_audit', departmentId: '', sectionId: '', plannedStartDate: '', plannedEndDate: '', leadAssessorStaffId: '', scope: '', objectives: '' });
      await load(); setTab('Assessment Programmes');
    } catch (e) { setError(errorText(e)); }
  }
  async function open(id: number) { try { setSelected(await api<AssessmentProgram>(`/assessments/${id}`)); } catch (e) { setError(errorText(e)); } }
  async function submitFinding(e: FormEvent) {
    e.preventDefault(); setError(null);
    if (!selected) return;
    try { await api(`/assessments/${selected.id}/findings`, { method: 'POST', body: JSON.stringify(findForm) }); setFindForm({ findingType: 'observation', findingDate: '', title: '', description: '', severity: 'medium', evidenceSummary: '', responsibleStaffId: '' }); await open(selected.id); await load(); }
    catch (e) { setError(errorText(e)); }
  }
  async function createNc(id: number) { try { await api(`/assessments/findings/${id}/create-nc`, { method: 'POST', body: JSON.stringify({}) }); await load(); if (selected) await open(selected.id); } catch (e) { setError(errorText(e)); } }
  async function createCapa(id: number) { try { await api(`/assessments/findings/${id}/create-capa`, { method: 'POST', body: JSON.stringify({}) }); await load(); if (selected) await open(selected.id); } catch (e) { setError(errorText(e)); } }
  async function closeFinding(id: number) { try { await api(`/assessments/findings/${id}/close`, { method: 'POST', body: JSON.stringify({}) }); await load(); if (selected) await open(selected.id); } catch (e) { setError(errorText(e)); } }

  const INTERNAL_AUDIT_TABS = ['Assessment Programmes', 'New Assessment', 'Checklist Library', 'Plan Assessment', 'Assessment Questions', 'Internal Audit Marks', 'Findings', 'Reports'];
  const inInternalAudit = INTERNAL_AUDIT_TABS.includes(tab);
  const topTabs: { key: string; active: boolean; go: () => void }[] = [
    { key: 'Dashboard', active: tab === 'Dashboard', go: () => setTab('Dashboard') },
    { key: 'Internal Audit', active: inInternalAudit, go: () => setTab('Assessment Programmes') },
    // These two switch into other modules. Enabled says the laboratory runs
    // them; canView says this person may open them.
    ...(isEnabled('risks') && canView('risks') ? [{ key: 'Risk Management', active: tab === 'Risk Management', go: () => setTab('Risk Management') }] : []),
    ...(isEnabled('quality_indicators') && canView('quality_indicators') ? [{ key: 'Quality Indicator Monitoring', active: tab === 'Quality Indicator Monitoring', go: () => setTab('Quality Indicator Monitoring') }] : []),
  ];
  return <div className="module-page">
    <PageHeader eyebrow="Assessments" title="Assessments" subtitle="Internal audits, risk management, and quality indicator monitoring." />
    <div className="tabs">{topTabs.map(t => <button key={t.key} type="button" className={t.active ? 'active' : ''} onClick={t.go}>{t.key}</button>)}</div>
    {inInternalAudit && tabBarFor('assessments')(tab, INTERNAL_AUDIT_TABS, setTab)}
    {error && <div className="error">{error}</div>}

    {tab === 'Risk Management' && <RisksPage embedded />}
    {tab === 'Quality Indicator Monitoring' && <QualityIndicatorsPage embedded />}

    {tab === 'Dashboard' && <ModuleAlerts moduleKey="assessments" />}
    {tab === 'Dashboard' && dashboardCards(summary, [
      { label: 'Planned/active assessments', value: 'plannedAssessments', onClick: () => setTab('Assessment Programmes') },
      { label: 'Open findings', value: 'openFindings', onClick: () => setTab('Findings') }
    ])}

    {tab === 'Assessment Programmes' && <>
      <table className="data-table"><thead><tr><th>Number</th><th>Title</th><th>Type</th><th>Start</th><th>Lead</th><th>Status</th><th></th></tr></thead><tbody>
        {programs.map(p => <tr key={p.id}><td>{p.program_number}</td><td>{p.title}</td><td>{p.assessment_type.replace(/_/g, ' ')}</td><td>{p.planned_start_date}</td><td>{staffName(staff, p.lead_assessor_staff_id)}</td><td>{formatBadge(p.status)}</td><td><button onClick={() => open(p.id)}>Open</button> {can('assessments', 'print') && <button onClick={() => openPrintPage(`/assessments/${p.id}/print`)}>Print</button>}</td></tr>)}
      </tbody></table>
      {selected && <DetailModal open onClose={() => setSelected(null)} title={<>{selected.program_number} — {selected.title}</>}>
        <p>Type: {selected.assessment_type.replace(/_/g, ' ')} | Status: {formatBadge(selected.status)} | Lead: {staffName(staff, selected.lead_assessor_staff_id)}</p>
        {selected.scope && <p><strong>Scope:</strong> {selected.scope}</p>}
        {selected.objectives && <p><strong>Objectives:</strong> {selected.objectives}</p>}
        <h4>Findings</h4>
        <table className="data-table"><thead><tr><th>Number</th><th>Date</th><th>Type</th><th>Title</th><th>Severity</th><th>Status</th><th></th></tr></thead><tbody>
          {(selected.findings || []).map(f => <tr key={f.id}><td>{f.finding_number}</td><td>{f.finding_date}</td><td>{f.finding_type.replace(/_/g, ' ')}</td><td>{f.title}</td><td>{formatBadge(f.severity)}</td><td>{formatBadge(f.status)}</td><td>{!f.nc_id && can('nc_capa', 'create') && <button onClick={() => createNc(f.id)}>NC</button>}{!f.capa_id && <button onClick={() => createCapa(f.id)}>CAPA</button>}{f.status !== 'closed' && <button onClick={() => closeFinding(f.id)}>Close</button>}</td></tr>)}
        </tbody></table>
        {can('assessments', 'create') && <form className="form-grid" onSubmit={submitFinding}>
          <label>Type<select value={findForm.findingType} onChange={e => setFindForm({ ...findForm, findingType: e.target.value })}>{FINDING_TYPES.map(t => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}</select></label>
          <label>Date<input type="date" value={findForm.findingDate} onChange={e => setFindForm({ ...findForm, findingDate: e.target.value })} /></label>
          <label>Title<input value={findForm.title} onChange={e => setFindForm({ ...findForm, title: e.target.value })} required /></label>
          <label>Severity<input value={findForm.severity} onChange={e => setFindForm({ ...findForm, severity: e.target.value })} /></label>
          <label>Description<textarea value={findForm.description} onChange={e => setFindForm({ ...findForm, description: e.target.value })} required /></label>
          <label>Evidence summary<textarea value={findForm.evidenceSummary} onChange={e => setFindForm({ ...findForm, evidenceSummary: e.target.value })} /></label>
          <label>Responsible<select value={findForm.responsibleStaffId} onChange={e => setFindForm({ ...findForm, responsibleStaffId: e.target.value })}><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
          <button type="submit">Add finding</button>
        </form>}
      </DetailModal>}
    </>}

    {tab === 'New Assessment' && can('assessments', 'create') && <form className="form-grid" onSubmit={submitProgram}>
      <label>Title<input value={progForm.title} onChange={e => setProgForm({ ...progForm, title: e.target.value })} required /></label>
      <label>Type<select value={progForm.assessmentType} onChange={e => setProgForm({ ...progForm, assessmentType: e.target.value })}>{ASSESSMENT_TYPES.map(t => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}</select></label>
      <label>Department<select value={progForm.departmentId} onChange={e => setProgForm({ ...progForm, departmentId: e.target.value })}><option value="">—</option>{departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
      <label>Section<select value={progForm.sectionId} onChange={e => setProgForm({ ...progForm, sectionId: e.target.value })}><option value="">—</option>{sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
      <label>Planned start<input type="date" value={progForm.plannedStartDate} onChange={e => setProgForm({ ...progForm, plannedStartDate: e.target.value })} required /></label>
      <label>Planned end<input type="date" value={progForm.plannedEndDate} onChange={e => setProgForm({ ...progForm, plannedEndDate: e.target.value })} /></label>
      <label>Lead assessor<select value={progForm.leadAssessorStaffId} onChange={e => setProgForm({ ...progForm, leadAssessorStaffId: e.target.value })}><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
      <label>Scope<textarea value={progForm.scope} onChange={e => setProgForm({ ...progForm, scope: e.target.value })} /></label>
      <label>Objectives<textarea value={progForm.objectives} onChange={e => setProgForm({ ...progForm, objectives: e.target.value })} /></label>
      <button type="submit">Create assessment</button>
    </form>}

    {tab === 'Checklist Library' && <>
      <p><small>Edit, replace, or archive default checklists. Marking is optional per checklist. Internal marks are not accreditation or external compliance scores.</small></p>
      <table className="data-table"><thead><tr><th>Code</th><th>Name</th><th>Type</th><th>Status</th><th>Default</th><th>Marking</th><th></th></tr></thead><tbody>
        {checklists.map(c => <tr key={c.id}>
          <td>{c.checklist_code || '—'}</td><td>{c.checklist_name}</td><td>{c.checklist_type.replace(/_/g, ' ')}</td>
          <td>{formatBadge(c.status)}</td><td>{c.is_default ? 'Yes' : 'No'}</td>
          <td><label><input type="checkbox" checked={!!c.marking_enabled} onChange={e => updateChecklistMarking(c.id, e.target.checked)} /> marks</label></td>
          <td>
            <button onClick={() => openChecklist(c.id)}>Open</button>
            {can('assessments', 'print') && <button onClick={() => openPrintPage(`/assessments/checklists/${c.id}/print`)}>Print</button>}
            {can('assessments', 'edit') && <button onClick={() => toggleChecklist(c.id)}>{c.status === 'active' ? 'Deactivate' : 'Activate'}</button>}
            {can('assessments', 'void_archive') && c.status !== 'archived' && <button onClick={() => archiveChecklist(c.id)}>Archive</button>}
            {can('assessments', 'void_archive') && <button onClick={() => deleteChecklist(c.id)} className="secondary">Delete</button>}
          </td>
        </tr>)}
      </tbody></table>
      {/* Loading a whole checklist in from a spreadsheet is a bulk import, not
          the everyday right to add a question. */}
      {can('assessments', 'import') && <>
      <h3>Import checklist from CSV / XLSX</h3>
      <p><small>Expected columns: SectionTitle, QuestionText (required), and optionally SectionCode, SectionPossibleMarks, SectionWeight, QuestionCode, ResponseType, MaxMarks, Weight, Guidance, ExpectedEvidence, ScoringGuidance, IsRequired. Rows are grouped into sections by SectionTitle.</small></p>
      <form className="form-grid" onSubmit={submitFileImport}>
        <label>Checklist name<input value={importMeta.checklistName} onChange={e => setImportMeta({ ...importMeta, checklistName: e.target.value })} required /></label>
        <label>Checklist type<select value={importMeta.checklistType} onChange={e => setImportMeta({ ...importMeta, checklistType: e.target.value })}>{CHECKLIST_TYPES.map(t => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}</select></label>
        <label><input type="checkbox" checked={importMeta.markingEnabled} onChange={e => setImportMeta({ ...importMeta, markingEnabled: e.target.checked })} /> Enable internal marking</label>
        <label>Internal pass mark<input type="number" step="any" value={importMeta.internalPassMark} onChange={e => setImportMeta({ ...importMeta, internalPassMark: e.target.value })} /></label>
        <label>File<input type="file" accept=".csv,.xlsx,.xls" onChange={e => setImportFile(e.target.files?.[0] ?? null)} required /></label>
        <button type="submit">Import file</button>
      </form>

      <h3>Create new checklist</h3>
      {can('assessments', 'create') && <form className="form-grid" onSubmit={submitChecklist}>
        <label>Code<input value={chForm.checklistCode} onChange={e => setChForm({ ...chForm, checklistCode: e.target.value })} /></label>
        <label>Name<input value={chForm.checklistName} onChange={e => setChForm({ ...chForm, checklistName: e.target.value })} required /></label>
        <label>Type<select value={chForm.checklistType} onChange={e => setChForm({ ...chForm, checklistType: e.target.value })}>{CHECKLIST_TYPES.map(t => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}</select></label>
        <label>Source<input value={chForm.sourceName} onChange={e => setChForm({ ...chForm, sourceName: e.target.value })} placeholder="e.g. internal QMS, framework name" /></label>
        <label>Version<input value={chForm.versionLabel} onChange={e => setChForm({ ...chForm, versionLabel: e.target.value })} /></label>
        <label>Effective date<input type="date" value={chForm.effectiveDate} onChange={e => setChForm({ ...chForm, effectiveDate: e.target.value })} /></label>
        <label>Description<textarea value={chForm.description} onChange={e => setChForm({ ...chForm, description: e.target.value })} /></label>
        <label><input type="checkbox" checked={chForm.markingEnabled} onChange={e => setChForm({ ...chForm, markingEnabled: e.target.checked })} /> Enable internal marking</label>
        <label>Threshold label<input value={chForm.internalThresholdLabel} onChange={e => setChForm({ ...chForm, internalThresholdLabel: e.target.value })} placeholder="optional, e.g. Internal pass threshold" /></label>
        <label>Internal pass mark<input type="number" step="any" value={chForm.internalPassMark} onChange={e => setChForm({ ...chForm, internalPassMark: e.target.value })} /></label>
        <button type="submit">Create checklist</button>
      </form>}
      </>}

      {selectedChecklist && <DetailModal open onClose={() => setSelectedChecklist(null)} title={<>{selectedChecklist.checklist_code ? selectedChecklist.checklist_code + ' — ' : ''}{selectedChecklist.checklist_name}</>}>
        <p>Status: {formatBadge(selectedChecklist.status)} | Type: {selectedChecklist.checklist_type.replace(/_/g, ' ')} | Marking: {selectedChecklist.marking_enabled ? 'enabled' : 'disabled'}</p>
        <h4>Sections</h4>
        <table className="data-table"><thead><tr><th>Order</th><th>Title</th><th>Possible marks</th><th>Weight</th><th></th></tr></thead><tbody>
          {(selectedChecklist.sections || []).map(s => <tr key={s.id}><td>{s.display_order}</td><td>{s.section_title}</td><td>{s.section_possible_marks ?? '—'}</td><td>{s.section_weight ?? '—'}</td><td>{can('assessments', 'void_archive') && <button onClick={() => deleteSection(selectedChecklist.id, s.id)} className="secondary">Delete</button>}</td></tr>)}
        </tbody></table>
        {can('assessments', 'create') && <form className="form-grid" onSubmit={addSection}>
          <label>Section title<input value={secForm.sectionTitle} onChange={e => setSecForm({ ...secForm, sectionTitle: e.target.value })} required /></label>
          <label>Code<input value={secForm.sectionCode} onChange={e => setSecForm({ ...secForm, sectionCode: e.target.value })} /></label>
          <label>Order<input type="number" value={secForm.displayOrder} onChange={e => setSecForm({ ...secForm, displayOrder: e.target.value })} /></label>
          <label>Possible marks<input type="number" step="any" value={secForm.sectionPossibleMarks} onChange={e => setSecForm({ ...secForm, sectionPossibleMarks: e.target.value })} /></label>
          <label>Weight<input type="number" step="any" value={secForm.sectionWeight} onChange={e => setSecForm({ ...secForm, sectionWeight: e.target.value })} /></label>
          <label>Description<textarea value={secForm.sectionDescription} onChange={e => setSecForm({ ...secForm, sectionDescription: e.target.value })} /></label>
          <button type="submit">Add section</button>
        </form>}
        <h4>Questions</h4>
        <table className="data-table"><thead><tr><th>Section</th><th>Code</th><th>Text</th><th>Response type</th><th>Max marks</th><th>Active</th><th></th></tr></thead><tbody>
          {(selectedChecklist.questions || []).map(q => <tr key={q.id}>
            <td>{(selectedChecklist.sections || []).find(s => s.id === q.section_id)?.section_title || '—'}</td>
            <td>{q.question_code || '—'}</td><td>{q.question_text}</td>
            <td>{q.response_type}</td><td>{q.max_marks ?? '—'}</td><td>{q.is_active ? 'Yes' : 'No'}</td>
            <td>{can('assessments', 'void_archive') && <button onClick={() => deleteQuestion(selectedChecklist.id, q.id)} className="secondary">Delete</button>}</td>
          </tr>)}
        </tbody></table>
        {can('assessments', 'create') && <form className="form-grid" onSubmit={addQuestion}>
          <label>Section<select value={qForm.sectionId} onChange={e => setQForm({ ...qForm, sectionId: e.target.value })}><option value="">(no section)</option>{(selectedChecklist.sections || []).map(s => <option key={s.id} value={s.id}>{s.section_title}</option>)}</select></label>
          <label>Code<input value={qForm.questionCode} onChange={e => setQForm({ ...qForm, questionCode: e.target.value })} /></label>
          <label>Response type<select value={qForm.responseType} onChange={e => setQForm({ ...qForm, responseType: e.target.value })}>{RESPONSE_TYPES.map(t => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}</select></label>
          <label>Max marks<input type="number" step="any" value={qForm.maxMarks} onChange={e => setQForm({ ...qForm, maxMarks: e.target.value })} /></label>
          <label>Weight<input type="number" step="any" value={qForm.weight} onChange={e => setQForm({ ...qForm, weight: e.target.value })} /></label>
          <label><input type="checkbox" checked={qForm.isRequired} onChange={e => setQForm({ ...qForm, isRequired: e.target.checked })} /> Required</label>
          <label>Question text<textarea value={qForm.questionText} onChange={e => setQForm({ ...qForm, questionText: e.target.value })} required /></label>
          <label>Guidance<textarea value={qForm.guidance} onChange={e => setQForm({ ...qForm, guidance: e.target.value })} /></label>
          <label>Expected evidence<textarea value={qForm.expectedEvidence} onChange={e => setQForm({ ...qForm, expectedEvidence: e.target.value })} /></label>
          <label>Scoring guidance<textarea value={qForm.scoringGuidance} onChange={e => setQForm({ ...qForm, scoringGuidance: e.target.value })} /></label>
          <button type="submit">Add question</button>
        </form>}
      </DetailModal>}
    </>}

    {tab === 'Plan Assessment' && <>
      <p><small>Select a checklist, then pick whole/sections/individual questions. Selected questions are copied into the assessment so it stays stable if the source checklist later changes.</small></p>
      <div className="form-grid">
        <label>Assessment<select value={planAssessmentId} onChange={e => setPlanAssessmentId(e.target.value)}><option value="">—</option>{programs.map(p => <option key={p.id} value={p.id}>{p.program_number} — {p.title}</option>)}</select></label>
        <label>Checklist<select value={planChecklistId} onChange={e => { setPlanChecklistId(e.target.value); void loadPlanChecklist(e.target.value); setPlanSelectedSections([]); setPlanSelectedQuestions([]); }}><option value="">—</option>{checklists.filter(c => c.status !== 'archived').map(c => <option key={c.id} value={c.id}>{c.checklist_name} ({c.status})</option>)}</select></label>
        <label>Selection mode<select value={planMode} onChange={e => setPlanMode(e.target.value)}>{SELECTION_MODES.map(m => <option key={m} value={m}>{m.replace(/_/g, ' ')}</option>)}</select></label>
        <label>Notes<input value={planNotes} onChange={e => setPlanNotes(e.target.value)} /></label>
      </div>
      {planChecklistDetail && <>
        <h4>Sections{planMode === 'selected_sections' || planMode === 'mixed' ? ' (tick to include)' : ''}</h4>
        <table className="data-table"><thead><tr><th>Pick</th><th>Section</th><th>Possible marks</th></tr></thead><tbody>
          {(planChecklistDetail.sections || []).map(s => <tr key={s.id}>
            <td><input type="checkbox" disabled={planMode === 'whole_checklist' || planMode === 'selected_questions'} checked={planSelectedSections.includes(s.id)} onChange={e => setPlanSelectedSections(e.target.checked ? [...planSelectedSections, s.id] : planSelectedSections.filter(id => id !== s.id))} /></td>
            <td>{s.section_title}</td><td>{s.section_possible_marks ?? '—'}</td>
          </tr>)}
        </tbody></table>
        <h4>Questions{planMode === 'selected_questions' || planMode === 'mixed' ? ' (tick to include)' : ''}</h4>
        <table className="data-table"><thead><tr><th>Pick</th><th>Section</th><th>Text</th><th>Max marks</th></tr></thead><tbody>
          {(planChecklistDetail.questions || []).filter(q => q.is_active).map(q => <tr key={q.id}>
            <td><input type="checkbox" disabled={planMode === 'whole_checklist' || planMode === 'selected_sections'} checked={planSelectedQuestions.includes(q.id)} onChange={e => setPlanSelectedQuestions(e.target.checked ? [...planSelectedQuestions, q.id] : planSelectedQuestions.filter(id => id !== q.id))} /></td>
            <td>{(planChecklistDetail.sections || []).find(s => s.id === q.section_id)?.section_title || '—'}</td>
            <td>{q.question_text}</td><td>{q.max_marks ?? '—'}</td>
          </tr>)}
        </tbody></table>
        {can('assessments', 'edit') && <button type="button" onClick={savePlan}>Save selection for this assessment</button>}
      </>}
    </>}

    {tab === 'Assessment Questions' && <>
      <div className="form-grid">
        <label>Assessment<select value={respAssessmentId} onChange={e => { setRespAssessmentId(e.target.value); void loadResponseQuestions(e.target.value); }}><option value="">—</option>{programs.map(p => <option key={p.id} value={p.id}>{p.program_number} — {p.title}</option>)}</select></label>
      </div>
      {respQuestions.length === 0 && respAssessmentId && <p>No questions selected for this assessment yet. Use the Plan Assessment tab first.</p>}
      {respQuestions.length > 0 && <table className="data-table"><thead><tr><th>Checklist</th><th>Section</th><th>Question</th><th>Response</th><th>Evidence summary</th><th>Marks awarded / max</th><th>Finding?</th><th>Save / history</th></tr></thead><tbody>
        {respQuestions.map(q => {
  const { can } = usePermissions();
          const v = respValues[q.question_id] || { response: 'not_assessed', evidenceSummary: '', marksAwarded: '', scoreComment: '', findingRequired: false };
          const max = q.max_marks_at_selection;
          return <tr key={q.question_id}>
            <td>{q.checklist_name || '—'}</td>
            <td>{q.section_title_at_selection || '—'}</td>
            <td>{q.question_text_at_selection || `Question #${q.question_id}`}</td>
            <td><select value={v.response} onChange={e => setRespValues({ ...respValues, [q.question_id]: { ...v, response: e.target.value } })}>{RESPONSE_OPTIONS.map(r => <option key={r} value={r}>{r.replace(/_/g, ' ')}</option>)}</select></td>
            <td><input value={v.evidenceSummary} onChange={e => setRespValues({ ...respValues, [q.question_id]: { ...v, evidenceSummary: e.target.value } })} /></td>
            <td>{q.marking_enabled ? <input type="number" step="any" value={v.marksAwarded} onChange={e => setRespValues({ ...respValues, [q.question_id]: { ...v, marksAwarded: e.target.value } })} style={{ width: 80 }} placeholder={max !== null && max !== undefined ? `/ ${max}` : ''} /> : <em>n/a</em>}{q.marking_enabled && max !== null && max !== undefined ? ` / ${max}` : ''}</td>
            <td><label><input type="checkbox" checked={v.findingRequired} onChange={e => setRespValues({ ...respValues, [q.question_id]: { ...v, findingRequired: e.target.checked } })} /> required</label></td>
            <td>
              {can('assessments', 'edit') && <button type="button" onClick={() => saveResponse(q.question_id)}>Save</button>}
              {v.existingResponseId && <button type="button" className="secondary" onClick={() => loadHistory(v.existingResponseId!)}>History</button>}
            </td>
          </tr>;
        })}
      </tbody></table>}
      {historyResponseId !== null && <div className="card" style={{ marginTop: 12 }}>
        <h4>Response history for response #{historyResponseId}</h4>
        <table className="data-table"><thead><tr><th>Snapshot at</th><th>Response</th><th>Marks</th><th>Evidence</th></tr></thead><tbody>
          {history.length === 0 && <tr><td colSpan={4}><em>No prior revisions — current value is the first saved value.</em></td></tr>}
          {history.map((h, i) => <tr key={i}><td>{h.snapshot_at}</td><td>{h.response || '—'}</td><td>{h.marks_awarded ?? '—'}</td><td>{h.evidence_summary || '—'}</td></tr>)}
        </tbody></table>
        <button className="secondary" onClick={() => { setHistoryResponseId(null); setHistory([]); }}>Close history</button>
      </div>}
    </>}

    {tab === 'Internal Audit Marks' && <>
      <div className="form-grid">
        <label>Assessment<select value={scoreAssessmentId} onChange={e => { setScoreAssessmentId(e.target.value); void loadScoreSummary(e.target.value); }}><option value="">—</option>{programs.map(p => <option key={p.id} value={p.id}>{p.program_number} — {p.title}</option>)}</select></label>
        {scoreAssessmentId && can('assessments', 'print') && <button type="button" onClick={() => openPrintPage(`/assessments/${scoreAssessmentId}/print`)}>Print full assessment report</button>}
      </div>
      {scoreSummary && <>
        <div className="cards">
          <div className="card"><h4>Questions planned</h4><p className="metric">{scoreSummary.total_questions_planned}</p></div>
          <div className="card"><h4>Questions assessed</h4><p className="metric">{scoreSummary.total_questions_assessed}</p></div>
          <div className="card"><h4>Total possible marks</h4><p className="metric">{scoreSummary.total_possible_marks}</p></div>
          <div className="card"><h4>Marks awarded</h4><p className="metric">{scoreSummary.total_marks_awarded}</p></div>
          <div className="card"><h4>Internal Assessment Score (raw)</h4><p className="metric">{scoreSummary.internal_score_percentage !== null ? scoreSummary.internal_score_percentage.toFixed(1) + '%' : '—'}</p></div>
          <div className="card"><h4>Weighted Internal Score</h4><p className="metric">{scoreSummary.weighted_internal_score_percentage !== null && scoreSummary.weighted_internal_score_percentage !== undefined ? scoreSummary.weighted_internal_score_percentage.toFixed(1) + '%' : '—'}</p><small>Only computed when section weights are set.</small></div>
          <div className="card"><h4>Findings</h4><p className="metric">{scoreSummary.findings_count}</p></div>
        </div>
        <p><small>{scoreSummary.label}</small></p>
        {scoreSummary.pass_status_per_checklist && scoreSummary.pass_status_per_checklist.length > 0 && <>
          <h4>Internal pass threshold (laboratory-defined)</h4>
          <table className="data-table"><thead><tr><th>Checklist</th><th>Threshold</th><th>Pass mark</th><th>Score</th><th>Status</th></tr></thead><tbody>
            {scoreSummary.pass_status_per_checklist.map(p => <tr key={p.checklist_id}>
              <td>{p.checklist_name}</td>
              <td>{p.internal_threshold_label}</td>
              <td>{p.internal_pass_mark}%</td>
              <td>{p.score_against_checklist !== null ? p.score_against_checklist.toFixed(1) + '%' : '—'}</td>
              <td>{formatBadge(p.status === 'pass' ? 'within-target' : p.status === 'attention' ? 'attention' : 'pending')} <small>({p.status})</small></td>
            </tr>)}
          </tbody></table>
          <small>Pass/attention labels reflect a laboratory-defined internal threshold only. Not an accreditation or external grade.</small>
        </>}
        <h4>Section Scores</h4>
        <table className="data-table"><thead><tr><th>Section</th><th>Planned</th><th>Assessed</th><th>Possible</th><th>Awarded</th><th>Section Score</th><th>Weight</th></tr></thead><tbody>
          {scoreSummary.sections.map((s, i) => <tr key={i}><td>{s.section_title || '—'}</td><td>{s.questions_planned}</td><td>{s.questions_assessed}</td><td>{s.possible_marks}</td><td>{s.marks_awarded}</td><td>{s.internal_score_percentage !== null ? s.internal_score_percentage.toFixed(1) + '%' : '—'}</td><td>{s.section_weight ?? '—'}</td></tr>)}
        </tbody></table>
        <h4>Response distribution</h4>
        <table className="data-table"><thead><tr><th>Response</th><th>Count</th></tr></thead><tbody>
          {Object.entries(scoreSummary.response_summary).map(([k, v]) => <tr key={k}><td>{k.replace(/_/g, ' ')}</td><td>{v}</td></tr>)}
        </tbody></table>
      </>}
    </>}

    {tab === 'Findings' && <table className="data-table"><thead><tr><th>Number</th><th>Programme</th><th>Date</th><th>Type</th><th>Title</th><th>Status</th><th></th></tr></thead><tbody>
      {findings.map(f => <tr key={f.id}><td>{f.finding_number}</td><td>{f.program_number || f.assessment_program_id}</td><td>{f.finding_date}</td><td>{f.finding_type.replace(/_/g, ' ')}</td><td>{f.title}</td><td>{formatBadge(f.status)}</td><td>{!f.nc_id && can('nc_capa', 'create') && <button onClick={() => createNc(f.id)}>NC</button>}{!f.capa_id && <button onClick={() => createCapa(f.id)}>CAPA</button>}</td></tr>)}
    </tbody></table>}

    {tab === 'Reports' && <p>Assessment outcome reports and trend dashboards will be added in a later phase.</p>}
  </div>;
}

// ============= Meetings =============
export function MeetingsPage({ embedded = false }: { embedded?: boolean } = {}) {
  const { can } = usePermissions();
  const { isEnabled } = useModules();
  const { staff } = useLookups();
  const summary = useGovernanceSummary();
  const [tab, setTab] = useState(embedded ? 'Meetings' : 'Dashboard');
  const [error, setError] = useState<string | null>(null);
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [selected, setSelected] = useState<Meeting | null>(null);
  const [form, setForm] = useState({ meetingType: 'quality_meeting', title: '', meetingDate: '', startTime: '', endTime: '', location: '', chairStaffId: '', secretaryStaffId: '', agenda: '', minutes: '' });
  const [attForm, setAttForm] = useState({ staffId: '', attendanceStatus: 'present', remarks: '' });
  const [actForm, setActForm] = useState({ title: '', description: '', assignedToStaffId: '', dueDate: '', priority: 'normal' });

  async function load() { try { setMeetings(await api<Meeting[]>('/meetings')); } catch (e) { setError(errorText(e)); } }
  useEffect(() => { if (embedded || isEnabled('meetings')) void load(); }, [isEnabled]);
  if (!embedded && !isEnabled('meetings')) return <DisabledModule />;

  async function submit(e: FormEvent) {
    e.preventDefault(); setError(null);
    try { await api('/meetings', { method: 'POST', body: JSON.stringify(form) }); setForm({ meetingType: 'quality_meeting', title: '', meetingDate: '', startTime: '', endTime: '', location: '', chairStaffId: '', secretaryStaffId: '', agenda: '', minutes: '' }); await load(); setTab('Meetings'); }
    catch (e) { setError(errorText(e)); }
  }
  async function open(id: number) { try { setSelected(await api<Meeting>(`/meetings/${id}`)); } catch (e) { setError(errorText(e)); } }
  async function submitAtt(e: FormEvent) { e.preventDefault(); setError(null); if (!selected) return; try { await api(`/meetings/${selected.id}/attendance`, { method: 'POST', body: JSON.stringify(attForm) }); setAttForm({ staffId: '', attendanceStatus: 'present', remarks: '' }); await open(selected.id); } catch (e) { setError(errorText(e)); } }
  async function submitAct(e: FormEvent) { e.preventDefault(); setError(null); if (!selected) return; try { await api(`/meetings/${selected.id}/create-action`, { method: 'POST', body: JSON.stringify(actForm) }); setActForm({ title: '', description: '', assignedToStaffId: '', dueDate: '', priority: 'normal' }); await open(selected.id); } catch (e) { setError(errorText(e)); } }
  async function closeMtg(id: number) { try { await api(`/meetings/${id}/close`, { method: 'POST', body: JSON.stringify({}) }); await load(); if (selected) await open(id); } catch (e) { setError(errorText(e)); } }

  const tabs = ['Dashboard', 'Meetings', 'New Meeting', 'Attendance', 'Action Items', 'Reports'];
  return <div className={embedded ? '' : 'module-page'}>
    {!embedded && <PageHeader eyebrow="Organisation and Leadership" title="Meetings &amp; Minutes" subtitle="Meeting scheduling, agendas, minutes, and action items." />}
    {tabBarFor('meetings')(tab, embedded ? tabs.filter(t => t !== 'Dashboard') : tabs, setTab)}
    {error && <div className="error">{error}</div>}

    {tab === 'Dashboard' && <ModuleAlerts moduleKey="meetings" />}
    {tab === 'Dashboard' && dashboardCards(summary, [{ label: 'Open meetings', value: 'openMeetings', onClick: () => setTab('Meetings') }])}

    {tab === 'Meetings' && <>
      <table className="data-table"><thead><tr><th>Number</th><th>Type</th><th>Title</th><th>Date</th><th>Status</th><th></th></tr></thead><tbody>
        {meetings.map(m => <tr key={m.id}><td>{m.meeting_number}</td><td>{m.meeting_type.replace(/_/g, ' ')}</td><td>{m.title}</td><td>{m.meeting_date}</td><td>{formatBadge(m.status)}</td><td><button onClick={() => open(m.id)}>Open</button>{m.status !== 'closed' && can('meetings', 'approve') && <button onClick={() => closeMtg(m.id)}>Close</button>}</td></tr>)}
      </tbody></table>
      {selected && <DetailModal open onClose={() => setSelected(null)} title={<>{selected.meeting_number} — {selected.title}</>}>
        <p>Date: {selected.meeting_date} | Chair: {staffName(staff, selected.chair_staff_id)} | Secretary: {staffName(staff, selected.secretary_staff_id)}</p>
        {selected.agenda && <p><strong>Agenda:</strong> {selected.agenda}</p>}
        {selected.minutes && <p><strong>Minutes:</strong> {selected.minutes}</p>}
        <h4>Attendance</h4>
        <table className="data-table"><thead><tr><th>Staff</th><th>Status</th><th>Signed</th><th>Remarks</th></tr></thead><tbody>
          {(selected.attendance || []).map((a: MeetingAttendance) => <tr key={a.id}><td>{a.staff_name || staffName(staff, a.staff_id)}</td><td>{formatBadge(a.attendance_status)}</td><td>{a.signed_at || '—'}</td><td>{a.remarks || '—'}</td></tr>)}
        </tbody></table>
        {can('meetings', 'edit') && <form className="form-grid" onSubmit={submitAtt}>
          <label>Staff<select value={attForm.staffId} onChange={e => setAttForm({ ...attForm, staffId: e.target.value })} required><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
          <label>Status<select value={attForm.attendanceStatus} onChange={e => setAttForm({ ...attForm, attendanceStatus: e.target.value })}>{ATTENDANCE_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}</select></label>
          <label>Remarks<input value={attForm.remarks} onChange={e => setAttForm({ ...attForm, remarks: e.target.value })} /></label>
          <button type="submit">Record attendance</button>
        </form>}
        <h4>Action items</h4>
        <table className="data-table"><thead><tr><th>Title</th><th>Status</th><th>Assigned</th><th>Due</th></tr></thead><tbody>
          {(selected.actions || []).map(a => <tr key={a.id}><td>{a.title}</td><td>{formatBadge(a.status)}</td><td>{staffName(staff, a.assigned_to_staff_id)}</td><td>{a.due_date || '—'}</td></tr>)}
        </tbody></table>
        {can('actions', 'create') && <form className="form-grid" onSubmit={submitAct}>
          <label>Action title<input value={actForm.title} onChange={e => setActForm({ ...actForm, title: e.target.value })} required /></label>
          <label>Description<textarea value={actForm.description} onChange={e => setActForm({ ...actForm, description: e.target.value })} /></label>
          <label>Assigned to<select value={actForm.assignedToStaffId} onChange={e => setActForm({ ...actForm, assignedToStaffId: e.target.value })}><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
          <label>Due date<input type="date" value={actForm.dueDate} onChange={e => setActForm({ ...actForm, dueDate: e.target.value })} /></label>
          <button type="submit">Create action</button>
        </form>}
      </DetailModal>}
    </>}

    {tab === 'New Meeting' && can('continual_improvement.projects', 'create') && <form className="form-grid" onSubmit={submit}>
      <label>Type<select value={form.meetingType} onChange={e => setForm({ ...form, meetingType: e.target.value })}>{MEETING_TYPES.map(t => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}</select></label>
      <label>Title<input value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} required /></label>
      <label>Date<input type="date" value={form.meetingDate} onChange={e => setForm({ ...form, meetingDate: e.target.value })} required /></label>
      <label>Start<input type="time" value={form.startTime} onChange={e => setForm({ ...form, startTime: e.target.value })} /></label>
      <label>End<input type="time" value={form.endTime} onChange={e => setForm({ ...form, endTime: e.target.value })} /></label>
      <label>Location<input value={form.location} onChange={e => setForm({ ...form, location: e.target.value })} /></label>
      <label>Chair<select value={form.chairStaffId} onChange={e => setForm({ ...form, chairStaffId: e.target.value })}><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
      <label>Secretary<select value={form.secretaryStaffId} onChange={e => setForm({ ...form, secretaryStaffId: e.target.value })}><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
      <label>Agenda<textarea value={form.agenda} onChange={e => setForm({ ...form, agenda: e.target.value })} /></label>
      <label>Minutes<textarea value={form.minutes} onChange={e => setForm({ ...form, minutes: e.target.value })} /></label>
      <button type="submit">Create meeting</button>
    </form>}

    {tab === 'Attendance' && <p>Open a meeting to record attendance and add action items.</p>}
    {tab === 'Action Items' && <p>Action items raised in meetings appear inside the meeting detail panel and in the shared Action Tracker.</p>}
    {tab === 'Reports' && <p>Meeting cadence reports will be added in a later phase.</p>}
  </div>;
}

// ============= Management Review =============
export function ManagementReviewPage({ embedded = false }: { embedded?: boolean } = {}) {
  const { can } = usePermissions();
  const { isEnabled } = useModules();
  const { staff } = useLookups();
  const summary = useGovernanceSummary();
  const [tab, setTab] = useState(embedded ? 'Review Register' : 'Dashboard');
  const [error, setError] = useState<string | null>(null);
  const [reviews, setReviews] = useState<ManagementReview[]>([]);
  const [selected, setSelected] = useState<ManagementReview | null>(null);
  const [form, setForm] = useState({ reviewPeriodStart: '', reviewPeriodEnd: '', reviewDate: '', chairStaffId: '', secretaryStaffId: '', summary: '', conclusions: '', decisions: '' });
  const [inputForm, setInputForm] = useState({ inputArea: '', summary: '', issues: '', actionsRequired: '' });
  const [actForm, setActForm] = useState({ title: '', description: '', assignedToStaffId: '', dueDate: '', priority: 'normal' });

  async function load() { try { setReviews(await api<ManagementReview[]>('/management-review')); } catch (e) { setError(errorText(e)); } }
  useEffect(() => { if (embedded || isEnabled('management_review')) void load(); }, [isEnabled]);
  if (!embedded && !isEnabled('management_review')) return <DisabledModule />;

  async function submit(e: FormEvent) { e.preventDefault(); setError(null); try { await api('/management-review', { method: 'POST', body: JSON.stringify(form) }); setForm({ reviewPeriodStart: '', reviewPeriodEnd: '', reviewDate: '', chairStaffId: '', secretaryStaffId: '', summary: '', conclusions: '', decisions: '' }); await load(); setTab('Review Register'); } catch (e) { setError(errorText(e)); } }
  async function open(id: number) { try { setSelected(await api<ManagementReview>(`/management-review/${id}`)); } catch (e) { setError(errorText(e)); } }
  async function generate(id: number) { try { await api(`/management-review/${id}/generate-inputs`, { method: 'POST', body: JSON.stringify({}) }); await open(id); } catch (e) { setError(errorText(e)); } }
  async function addInput(e: FormEvent) { e.preventDefault(); setError(null); if (!selected) return; try { await api(`/management-review/${selected.id}/add-input`, { method: 'POST', body: JSON.stringify(inputForm) }); setInputForm({ inputArea: '', summary: '', issues: '', actionsRequired: '' }); await open(selected.id); } catch (e) { setError(errorText(e)); } }
  async function addAction(e: FormEvent) { e.preventDefault(); setError(null); if (!selected) return; try { await api(`/management-review/${selected.id}/create-action`, { method: 'POST', body: JSON.stringify(actForm) }); setActForm({ title: '', description: '', assignedToStaffId: '', dueDate: '', priority: 'normal' }); await open(selected.id); } catch (e) { setError(errorText(e)); } }
  async function approve(id: number) { try { await api(`/management-review/${id}/approve`, { method: 'POST', body: JSON.stringify({}) }); await load(); if (selected) await open(id); } catch (e) { setError(errorText(e)); } }
  async function closeReview(id: number) { try { await api(`/management-review/${id}/close`, { method: 'POST', body: JSON.stringify({}) }); await load(); if (selected) await open(id); } catch (e) { setError(errorText(e)); } }

  const tabs = ['Dashboard', 'Review Register', 'New Review', 'Inputs', 'Actions', 'Reports'];
  return <div className={embedded ? '' : 'module-page'}>
    {!embedded && <PageHeader eyebrow="Organisation and Leadership" title="Management Review" subtitle="Management review inputs, outputs, and resulting actions." />}
    {tabBarFor('management_review')(tab, embedded ? tabs.filter(t => t !== 'Dashboard') : tabs, setTab)}
    {error && <div className="error">{error}</div>}

    {tab === 'Dashboard' && <ModuleAlerts moduleKey="management_review" />}
    {tab === 'Dashboard' && dashboardCards(summary, [{ label: 'Pending management reviews', value: 'pendingManagementReviews', onClick: () => setTab('Review Register') }])}

    {tab === 'Review Register' && <>
      <table className="data-table"><thead><tr><th>Number</th><th>Period</th><th>Date</th><th>Chair</th><th>Status</th><th></th></tr></thead><tbody>
        {reviews.map(r => <tr key={r.id}><td>{r.review_number}</td><td>{r.review_period_start} → {r.review_period_end}</td><td>{r.review_date}</td><td>{staffName(staff, r.chair_staff_id)}</td><td>{formatBadge(r.status)}</td><td><button onClick={() => open(r.id)}>Open</button>{r.status !== 'approved' && r.status !== 'closed' && can('management_review', 'approve') && <button onClick={() => approve(r.id)}>Approve</button>}{r.status !== 'closed' && <button onClick={() => closeReview(r.id)}>Close</button>}</td></tr>)}
      </tbody></table>
      {selected && <DetailModal open onClose={() => setSelected(null)} title={<>{selected.review_number}</>}>
        <p>Period: {selected.review_period_start} → {selected.review_period_end} | Date: {selected.review_date} | Status: {formatBadge(selected.status)}</p>
        {selected.summary && <p><strong>Summary:</strong> {selected.summary}</p>}
        {selected.conclusions && <p><strong>Conclusions:</strong> {selected.conclusions}</p>}
        {selected.decisions && <p><strong>Decisions:</strong> {selected.decisions}</p>}
        {can('management_review', 'create') && <button onClick={() => generate(selected.id)}>Generate inputs from modules</button>}
        <h4>Inputs</h4>
        <table className="data-table"><thead><tr><th>Area</th><th>Source</th><th>Summary</th><th>Issues</th><th>Actions required</th></tr></thead><tbody>
          {(selected.inputs || []).map((i: ManagementReviewInput) => <tr key={i.id}><td>{i.input_area}</td><td>{i.source_module || '—'}</td><td>{i.summary || '—'}</td><td>{i.issues || '—'}</td><td>{i.actions_required || '—'}</td></tr>)}
        </tbody></table>
        {can('management_review', 'create') && <form className="form-grid" onSubmit={addInput}>
          <label>Area<input value={inputForm.inputArea} onChange={e => setInputForm({ ...inputForm, inputArea: e.target.value })} required /></label>
          <label>Summary<textarea value={inputForm.summary} onChange={e => setInputForm({ ...inputForm, summary: e.target.value })} /></label>
          <label>Issues<textarea value={inputForm.issues} onChange={e => setInputForm({ ...inputForm, issues: e.target.value })} /></label>
          <label>Actions required<textarea value={inputForm.actionsRequired} onChange={e => setInputForm({ ...inputForm, actionsRequired: e.target.value })} /></label>
          <button type="submit">Add input</button>
        </form>}
        <h4>Add action</h4>
        {can('actions', 'create') && <form className="form-grid" onSubmit={addAction}>
          <label>Title<input value={actForm.title} onChange={e => setActForm({ ...actForm, title: e.target.value })} required /></label>
          <label>Description<textarea value={actForm.description} onChange={e => setActForm({ ...actForm, description: e.target.value })} /></label>
          <label>Assigned to<select value={actForm.assignedToStaffId} onChange={e => setActForm({ ...actForm, assignedToStaffId: e.target.value })}><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
          <label>Due<input type="date" value={actForm.dueDate} onChange={e => setActForm({ ...actForm, dueDate: e.target.value })} /></label>
          <button type="submit">Create action</button>
        </form>}
      </DetailModal>}
    </>}

    {tab === 'New Review' && can('continual_improvement.projects', 'create') && <form className="form-grid" onSubmit={submit}>
      <label>Period start<input type="date" value={form.reviewPeriodStart} onChange={e => setForm({ ...form, reviewPeriodStart: e.target.value })} required /></label>
      <label>Period end<input type="date" value={form.reviewPeriodEnd} onChange={e => setForm({ ...form, reviewPeriodEnd: e.target.value })} required /></label>
      <label>Review date<input type="date" value={form.reviewDate} onChange={e => setForm({ ...form, reviewDate: e.target.value })} required /></label>
      <label>Chair<select value={form.chairStaffId} onChange={e => setForm({ ...form, chairStaffId: e.target.value })}><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
      <label>Secretary<select value={form.secretaryStaffId} onChange={e => setForm({ ...form, secretaryStaffId: e.target.value })}><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
      <label>Summary<textarea value={form.summary} onChange={e => setForm({ ...form, summary: e.target.value })} /></label>
      <label>Conclusions<textarea value={form.conclusions} onChange={e => setForm({ ...form, conclusions: e.target.value })} /></label>
      <label>Decisions<textarea value={form.decisions} onChange={e => setForm({ ...form, decisions: e.target.value })} /></label>
      <button type="submit">Create review</button>
    </form>}

    {tab === 'Inputs' && <p>Open a review from the register to add inputs or use "Generate inputs from modules" to pull QMS summaries.</p>}
    {tab === 'Actions' && <p>Actions raised from a review appear inside the review's detail panel and in the shared Action Tracker.</p>}
    {tab === 'Reports' && <p>Management review reports will be added in a later phase.</p>}
  </div>;
}

// ============= Quality Indicators =============
export function QualityIndicatorsPage({ embedded = false }: { embedded?: boolean } = {}) {
  const { can } = usePermissions();
  const { isEnabled } = useModules();
  const { staff, sections } = useLookups();
  const summary = useGovernanceSummary();
  const [tab, setTab] = useState(embedded ? 'Indicator Register' : 'Dashboard');
  const [error, setError] = useState<string | null>(null);
  const [indicators, setIndicators] = useState<QualityIndicator[]>([]);
  const [results, setResults] = useState<QualityIndicatorResult[]>([]);
  const [selectedId, setSelectedId] = useState<string>('');
  const [form, setForm] = useState({ indicatorCode: '', indicatorName: '', sectionId: '', description: '', numeratorDefinition: '', denominatorDefinition: '', targetValue: '', warningThreshold: '', criticalThreshold: '', frequency: 'monthly', responsibleStaffId: '', reviewerStaffId: '' });
  const [resForm, setResForm] = useState({ periodStart: '', periodEnd: '', numeratorValue: '', denominatorValue: '', interpretation: '' });

  async function load() { try { setIndicators(await api<QualityIndicator[]>('/quality-indicators')); } catch (e) { setError(errorText(e)); } }
  async function loadResults(id: string) { if (!id) { setResults([]); return; } try { setResults(await api<QualityIndicatorResult[]>(`/quality-indicators/${id}/results`)); } catch (e) { setError(errorText(e)); } }
  useEffect(() => { if (embedded || isEnabled('quality_indicators')) void load(); }, [isEnabled]);
  if (!embedded && !isEnabled('quality_indicators')) return <DisabledModule />;

  async function submit(e: FormEvent) { e.preventDefault(); setError(null); try { await api('/quality-indicators', { method: 'POST', body: JSON.stringify(form) }); setForm({ indicatorCode: '', indicatorName: '', sectionId: '', description: '', numeratorDefinition: '', denominatorDefinition: '', targetValue: '', warningThreshold: '', criticalThreshold: '', frequency: 'monthly', responsibleStaffId: '', reviewerStaffId: '' }); await load(); setTab('Indicator Register'); } catch (e) { setError(errorText(e)); } }
  async function submitResult(e: FormEvent) { e.preventDefault(); setError(null); if (!selectedId) return setError('Select an indicator'); try { await api(`/quality-indicators/${selectedId}/results`, { method: 'POST', body: JSON.stringify(resForm) }); setResForm({ periodStart: '', periodEnd: '', numeratorValue: '', denominatorValue: '', interpretation: '' }); await loadResults(selectedId); } catch (e) { setError(errorText(e)); } }
  async function review(id: number) { try { await api(`/quality-indicators/results/${id}/review`, { method: 'POST', body: JSON.stringify({}) }); await loadResults(selectedId); } catch (e) { setError(errorText(e)); } }
  async function createNc(id: number) { try { await api(`/quality-indicators/results/${id}/create-nc`, { method: 'POST', body: JSON.stringify({}) }); await loadResults(selectedId); } catch (e) { setError(errorText(e)); } }
  async function createCapa(id: number) { try { await api(`/quality-indicators/results/${id}/create-capa`, { method: 'POST', body: JSON.stringify({}) }); await loadResults(selectedId); } catch (e) { setError(errorText(e)); } }

  const tabs = ['Dashboard', 'Indicator Register', 'New Indicator', 'Results Entry', 'Trends', 'Reports'];
  return <div className={embedded ? '' : 'module-page'}>
    {!embedded && <PageHeader eyebrow="Continual Improvement" title="Quality Indicators" subtitle="Quality indicators, targets, and result monitoring." />}
    {tabBarFor('quality_indicators')(tab, embedded ? tabs.filter(t => t !== 'Dashboard') : tabs, setTab)}
    {error && <div className="error">{error}</div>}

    {tab === 'Dashboard' && <ModuleAlerts moduleKey="quality_indicators" />}
    {tab === 'Dashboard' && dashboardCards(summary, [
      { label: 'Active indicators', value: 'activeQualityIndicators', onClick: () => setTab('Indicator Register') },
      { label: 'Critical results to action', value: 'criticalQualityIndicatorResults', onClick: () => setTab('Results Entry') }
    ])}

    {tab === 'Indicator Register' && <table className="data-table"><thead><tr><th>Code</th><th>Name</th><th>Frequency</th><th>Target</th><th>Warning</th><th>Critical</th><th>Active</th></tr></thead><tbody>
      {indicators.map(i => <tr key={i.id}><td>{i.indicator_code}</td><td>{i.indicator_name}</td><td>{i.frequency}</td><td>{i.target_value ?? '—'}</td><td>{i.warning_threshold ?? '—'}</td><td>{i.critical_threshold ?? '—'}</td><td>{i.is_active ? 'Yes' : 'No'}</td></tr>)}
    </tbody></table>}

    {tab === 'New Indicator' && can('continual_improvement.projects', 'create') && <form className="form-grid" onSubmit={submit}>
      <label>Code (auto if blank)<input value={form.indicatorCode} onChange={e => setForm({ ...form, indicatorCode: e.target.value })} /></label>
      <label>Name<input value={form.indicatorName} onChange={e => setForm({ ...form, indicatorName: e.target.value })} required /></label>
      <label>Section<select value={form.sectionId} onChange={e => setForm({ ...form, sectionId: e.target.value })}><option value="">—</option>{sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
      <label>Description<textarea value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} /></label>
      <label>Numerator definition<input value={form.numeratorDefinition} onChange={e => setForm({ ...form, numeratorDefinition: e.target.value })} /></label>
      <label>Denominator definition<input value={form.denominatorDefinition} onChange={e => setForm({ ...form, denominatorDefinition: e.target.value })} /></label>
      <label>Target (%)<input type="number" step="any" value={form.targetValue} onChange={e => setForm({ ...form, targetValue: e.target.value })} required /></label>
      <label>Warning threshold<input type="number" step="any" value={form.warningThreshold} onChange={e => setForm({ ...form, warningThreshold: e.target.value })} /></label>
      <label>Critical threshold<input type="number" step="any" value={form.criticalThreshold} onChange={e => setForm({ ...form, criticalThreshold: e.target.value })} /></label>
      <label>Frequency<select value={form.frequency} onChange={e => setForm({ ...form, frequency: e.target.value })}>{FREQUENCIES.map(f => <option key={f} value={f}>{f}</option>)}</select></label>
      <label>Responsible<select value={form.responsibleStaffId} onChange={e => setForm({ ...form, responsibleStaffId: e.target.value })}><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
      <label>Reviewer<select value={form.reviewerStaffId} onChange={e => setForm({ ...form, reviewerStaffId: e.target.value })}><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
      <button type="submit">Create indicator</button>
    </form>}

    {tab === 'Results Entry' && <>
      <label>Indicator<select value={selectedId} onChange={e => { setSelectedId(e.target.value); void loadResults(e.target.value); }}><option value="">—</option>{indicators.filter(i => i.is_active).map(i => <option key={i.id} value={i.id}>{i.indicator_code} — {i.indicator_name}</option>)}</select></label>
      {selectedId && can('quality_indicators', 'create') && <form className="form-grid" onSubmit={submitResult}>
        <label>Period start<input type="date" value={resForm.periodStart} onChange={e => setResForm({ ...resForm, periodStart: e.target.value })} required /></label>
        <label>Period end<input type="date" value={resForm.periodEnd} onChange={e => setResForm({ ...resForm, periodEnd: e.target.value })} required /></label>
        <label>Numerator<input type="number" step="any" value={resForm.numeratorValue} onChange={e => setResForm({ ...resForm, numeratorValue: e.target.value })} required /></label>
        <label>Denominator<input type="number" step="any" value={resForm.denominatorValue} onChange={e => setResForm({ ...resForm, denominatorValue: e.target.value })} required /></label>
        <label>Interpretation<textarea value={resForm.interpretation} onChange={e => setResForm({ ...resForm, interpretation: e.target.value })} /></label>
        <button type="submit">Record result</button>
      </form>}
      {selectedId && <table className="data-table"><thead><tr><th>Period</th><th>Numerator</th><th>Denominator</th><th>Value %</th><th>Status</th><th>Reviewed</th><th></th></tr></thead><tbody>
        {results.map(r => <tr key={r.id}><td>{r.period_start} → {r.period_end}</td><td>{r.numerator_value}</td><td>{r.denominator_value}</td><td>{r.calculated_value !== null && r.calculated_value !== undefined ? r.calculated_value.toFixed(2) : '—'}</td><td>{formatBadge(r.status)}</td><td>{r.reviewed_at || 'Pending'}</td><td>{!r.reviewed_at && <button onClick={() => review(r.id)}>Review</button>}{r.status === 'critical' && !r.nc_id && can('nc_capa', 'create') && <button onClick={() => createNc(r.id)}>NC</button>}{r.status === 'critical' && !r.capa_id && <button onClick={() => createCapa(r.id)}>CAPA</button>}</td></tr>)}
      </tbody></table>}
    </>}

    {tab === 'Trends' && <>
      <label>Indicator<select value={selectedId} onChange={e => { setSelectedId(e.target.value); void loadResults(e.target.value); }}><option value="">—</option>{indicators.map(i => <option key={i.id} value={i.id}>{i.indicator_code} — {i.indicator_name}</option>)}</select></label>
      {!selectedId && <p>Select an indicator to see its trend.</p>}
      {selectedId && results.length === 0 && <p>No results yet for this indicator.</p>}
      {selectedId && results.length > 0 && (() => {
        const indicator = indicators.find(i => String(i.id) === selectedId);
        const ordered = [...results].reverse(); // oldest first
        const values = ordered.map(r => r.calculated_value).filter((v): v is number => v !== null && v !== undefined);
        if (!values.length) return <p>No numeric calculated values to chart.</p>;
        const w = 720, h = 240, padL = 48, padR = 16, padT = 16, padB = 32;
        const innerW = w - padL - padR, innerH = h - padT - padB;
        const target = indicator?.target_value ?? null;
        const warning = indicator?.warning_threshold ?? null;
        const critical = indicator?.critical_threshold ?? null;
        const candidates = [...values, ...(target !== null && target !== undefined ? [target] : []), ...(warning !== null && warning !== undefined ? [warning] : []), ...(critical !== null && critical !== undefined ? [critical] : [])];
        const lo = Math.min(...candidates);
        const hi = Math.max(...candidates);
        const span = (hi - lo) || 1;
        const yMin = lo - span * 0.1;
        const yMax = hi + span * 0.1;
        const x = (i: number) => padL + (ordered.length === 1 ? innerW / 2 : (i * innerW) / (ordered.length - 1));
        const y = (v: number) => padT + innerH - ((v - yMin) / (yMax - yMin)) * innerH;
        const colorFor = (status?: string) => status === 'within_target' ? 'var(--success, #2a9d4a)' : status === 'warning' ? 'var(--warning, #d99500)' : status === 'critical' ? 'var(--danger, #d23a2a)' : 'var(--muted, #888)';
        const linePath = ordered.map((p, i) => p.calculated_value === null || p.calculated_value === undefined ? '' : `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(p.calculated_value).toFixed(1)}`).filter(Boolean).join(' ');
        const refLine = (val: number, label: string, color: string) => <g key={label}>
          <line x1={padL} x2={w - padR} y1={y(val)} y2={y(val)} stroke={color} strokeWidth={1} strokeDasharray="4 4" />
          <text x={padL - 6} y={y(val) + 4} fontSize={10} textAnchor="end" fill="var(--muted, #666)">{label}</text>
        </g>;
        return <>
          <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label="Indicator trend" style={{ width: '100%', maxWidth: w, height: 'auto', background: '#fff', border: '1px solid var(--border, #ddd)', borderRadius: 8 }}>
            {target !== null && target !== undefined && refLine(target, `Target ${target}`, '#2a9d4a')}
            {warning !== null && warning !== undefined && refLine(warning, `Warning ${warning}`, '#d99500')}
            {critical !== null && critical !== undefined && refLine(critical, `Critical ${critical}`, '#d23a2a')}
            <path d={linePath} fill="none" stroke="#1B3A6B" strokeWidth={1.5} />
            {ordered.map((p, i) => p.calculated_value === null || p.calculated_value === undefined ? null : (
              <circle key={i} cx={x(i)} cy={y(p.calculated_value)} r={4} fill={colorFor(p.status)} stroke="#fff" strokeWidth={1}>
                <title>{p.period_start} → {p.period_end}: {p.calculated_value.toFixed(2)} ({p.status})</title>
              </circle>
            ))}
            <text x={padL} y={h - 8} fontSize={10} fill="var(--muted, #666)">{ordered[0].period_start}</text>
            <text x={w - padR} y={h - 8} fontSize={10} textAnchor="end" fill="var(--muted, #666)">{ordered[ordered.length - 1].period_end}</text>
          </svg>
          <table className="data-table" style={{ marginTop: 12 }}><thead><tr><th>Period start</th><th>Period end</th><th>Calculated value</th><th>Status</th><th>Interpretation</th></tr></thead><tbody>
            {ordered.map(r => <tr key={r.id}><td>{r.period_start}</td><td>{r.period_end}</td><td>{r.calculated_value !== null && r.calculated_value !== undefined ? r.calculated_value.toFixed(2) : '—'}</td><td>{formatBadge(r.status)}</td><td>{r.interpretation || '—'}</td></tr>)}
          </tbody></table>
        </>;
      })()}
    </>}
    {tab === 'Reports' && <p>Indicator reports will be added in a later phase.</p>}
  </div>;
}

// ============= Continual Improvement =============
export function ContinualImprovementPage() {
  const { can } = usePermissions();
  const { isEnabled } = useModules();
  const { staff } = useLookups();
  const summary = useGovernanceSummary();
  const [tab, setTab] = useState('Dashboard');
  const [error, setError] = useState<string | null>(null);
  const [projects, setProjects] = useState<ImprovementProject[]>([]);
  const [selected, setSelected] = useState<ImprovementProject | null>(null);
  const [form, setForm] = useState({ title: '', improvementArea: 'turnaround_time', aimStatement: '', baselineMeasure: '', targetMeasure: '', startDate: '', expectedCompletionDate: '', responsibleStaffId: '', sourceModule: '', sourceRecordId: '' });
  const [updForm, setUpdForm] = useState({ updateDate: '', updateText: '', progressStatus: 'in_progress' });
  const [actForm, setActForm] = useState({ title: '', description: '', assignedToStaffId: '', dueDate: '', priority: 'normal' });

  async function load() { try { setProjects(await api<ImprovementProject[]>('/improvement')); } catch (e) { setError(errorText(e)); } }
  useEffect(() => { if (isEnabled('continual_improvement')) void load(); }, [isEnabled]);
  if (!isEnabled('continual_improvement')) return <DisabledModule />;

  async function submit(e: FormEvent) { e.preventDefault(); setError(null); try { await api('/improvement', { method: 'POST', body: JSON.stringify(form) }); setForm({ title: '', improvementArea: 'turnaround_time', aimStatement: '', baselineMeasure: '', targetMeasure: '', startDate: '', expectedCompletionDate: '', responsibleStaffId: '', sourceModule: '', sourceRecordId: '' }); await load(); setTab('Improvement Projects'); } catch (e) { setError(errorText(e)); } }
  async function open(id: number) { try { setSelected(await api<ImprovementProject>(`/improvement/${id}`)); } catch (e) { setError(errorText(e)); } }
  async function addUpdate(e: FormEvent) { e.preventDefault(); setError(null); if (!selected) return; try { await api(`/improvement/${selected.id}/update`, { method: 'POST', body: JSON.stringify(updForm) }); setUpdForm({ updateDate: '', updateText: '', progressStatus: 'in_progress' }); await open(selected.id); } catch (e) { setError(errorText(e)); } }
  async function addAction(e: FormEvent) { e.preventDefault(); setError(null); if (!selected) return; try { await api(`/improvement/${selected.id}/create-action`, { method: 'POST', body: JSON.stringify(actForm) }); setActForm({ title: '', description: '', assignedToStaffId: '', dueDate: '', priority: 'normal' }); await open(selected.id); } catch (e) { setError(errorText(e)); } }
  async function closeProject(id: number) { const summary = prompt('Outcome summary?'); if (!summary) return; try { await api(`/improvement/${id}/close`, { method: 'POST', body: JSON.stringify({ outcomeSummary: summary }) }); await load(); if (selected) await open(id); } catch (e) { setError(errorText(e)); } }

  const tabs = ['Dashboard', 'Improvement Projects', 'New Project', 'Updates', 'Reports'];
  return <div className="module-page">
    <PageHeader eyebrow="Continual Improvement" title="Continual Improvement" subtitle="Improvement projects, indicators, and action tracking." />
    {tabBarFor('continual_improvement')(tab, tabs, setTab)}
    {error && <div className="error">{error}</div>}

    {tab === 'Dashboard' && <ModuleAlerts moduleKey="continual_improvement" />}
    {tab === 'Dashboard' && dashboardCards(summary, [
      { label: 'Active projects', value: 'activeImprovementProjects', onClick: () => setTab('Improvement Projects') },
      { label: 'Overdue improvement actions', value: 'overdueImprovementActions', onClick: () => setTab('Improvement Projects') }
    ])}

    {tab === 'Improvement Projects' && <>
      <table className="data-table"><thead><tr><th>Number</th><th>Title</th><th>Area</th><th>Status</th><th>Responsible</th><th></th></tr></thead><tbody>
        {projects.map(p => <tr key={p.id}><td>{p.project_number}</td><td>{p.title}</td><td>{p.improvement_area.replace(/_/g, ' ')}</td><td>{formatBadge(p.status)}</td><td>{staffName(staff, p.responsible_staff_id)}</td><td><button onClick={() => open(p.id)}>Open</button>{p.status !== 'closed' && can('continual_improvement.projects', 'approve') && <button onClick={() => closeProject(p.id)}>Close</button>}</td></tr>)}
      </tbody></table>
      {selected && <DetailModal open onClose={() => setSelected(null)} title={<>{selected.project_number} — {selected.title}</>}>
        <p>Area: {selected.improvement_area.replace(/_/g, ' ')} | Status: {formatBadge(selected.status)} | Responsible: {staffName(staff, selected.responsible_staff_id)}</p>
        <p><strong>Aim:</strong> {selected.aim_statement}</p>
        {selected.baseline_measure && <p><strong>Baseline:</strong> {selected.baseline_measure}</p>}
        {selected.target_measure && <p><strong>Target:</strong> {selected.target_measure}</p>}
        {selected.outcome_summary && <p><strong>Outcome:</strong> {selected.outcome_summary}</p>}
        <h4>Updates</h4>
        <table className="data-table"><thead><tr><th>Date</th><th>Progress</th><th>Notes</th></tr></thead><tbody>
          {(selected.updates || []).map((u: ImprovementUpdate) => <tr key={u.id}><td>{u.update_date}</td><td>{u.progress_status || '—'}</td><td>{u.update_text || '—'}</td></tr>)}
        </tbody></table>
        {can('continual_improvement.projects', 'edit') && <form className="form-grid" onSubmit={addUpdate}>
          <label>Date<input type="date" value={updForm.updateDate} onChange={e => setUpdForm({ ...updForm, updateDate: e.target.value })} required /></label>
          <label>Progress status<input value={updForm.progressStatus} onChange={e => setUpdForm({ ...updForm, progressStatus: e.target.value })} /></label>
          <label>Update<textarea value={updForm.updateText} onChange={e => setUpdForm({ ...updForm, updateText: e.target.value })} /></label>
          <button type="submit">Add update</button>
        </form>}
        <h4>Add action</h4>
        {can('actions', 'create') && <form className="form-grid" onSubmit={addAction}>
          <label>Title<input value={actForm.title} onChange={e => setActForm({ ...actForm, title: e.target.value })} required /></label>
          <label>Description<textarea value={actForm.description} onChange={e => setActForm({ ...actForm, description: e.target.value })} /></label>
          <label>Assigned<select value={actForm.assignedToStaffId} onChange={e => setActForm({ ...actForm, assignedToStaffId: e.target.value })}><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
          <label>Due<input type="date" value={actForm.dueDate} onChange={e => setActForm({ ...actForm, dueDate: e.target.value })} /></label>
          <button type="submit">Create action</button>
        </form>}
      </DetailModal>}
    </>}

    {tab === 'New Project' && can('continual_improvement.projects', 'create') && <form className="form-grid" onSubmit={submit}>
      <label>Title<input value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} required /></label>
      <label>Area<select value={form.improvementArea} onChange={e => setForm({ ...form, improvementArea: e.target.value })}>{IMPROVEMENT_AREAS.map(a => <option key={a} value={a}>{a.replace(/_/g, ' ')}</option>)}</select></label>
      <label>Aim statement<textarea value={form.aimStatement} onChange={e => setForm({ ...form, aimStatement: e.target.value })} required /></label>
      <label>Baseline measure<input value={form.baselineMeasure} onChange={e => setForm({ ...form, baselineMeasure: e.target.value })} /></label>
      <label>Target measure<input value={form.targetMeasure} onChange={e => setForm({ ...form, targetMeasure: e.target.value })} /></label>
      <label>Start date<input type="date" value={form.startDate} onChange={e => setForm({ ...form, startDate: e.target.value })} /></label>
      <label>Expected completion<input type="date" value={form.expectedCompletionDate} onChange={e => setForm({ ...form, expectedCompletionDate: e.target.value })} /></label>
      <label>Responsible<select value={form.responsibleStaffId} onChange={e => setForm({ ...form, responsibleStaffId: e.target.value })}><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
      <label>Source module (optional)<input value={form.sourceModule} onChange={e => setForm({ ...form, sourceModule: e.target.value })} placeholder="e.g. nc_capa, quality_indicators" /></label>
      <label>Source record id<input value={form.sourceRecordId} onChange={e => setForm({ ...form, sourceRecordId: e.target.value })} /></label>
      <button type="submit">Create improvement project</button>
    </form>}

    {tab === 'Updates' && <p>Open a project from the register to add updates.</p>}
    {tab === 'Reports' && <p>Improvement portfolio reports will be added in a later phase.</p>}
  </div>;
}
