import { FormEvent, useEffect, useState } from 'react';
import { useModules } from '../hooks/useModules';
import { api } from '../services/api';
import DisabledModule from '../components/DisabledModule';
import type {
  Section, Department,
  LabTestCatalog, SpecimenAcceptanceCriteria, SpecimenRejectionRecord,
  CriticalResultRule, CriticalResultNotification,
  ReferralLaboratory, ReferralTest, ReferralSendout,
  ReportAmendmentLog, ProcessReviewRecord, ProcessManagementSummary
} from '../../shared/types/api';

const statusBadgeClass = (status?: string) => `badge ${status ? status.toLowerCase().replace(/\s+/g, '-') : 'unknown'}`;
const formatBadge = (status?: string) => <span className={statusBadgeClass(status)}>{status ? status.replace(/_/g, ' ') : 'Unknown'}</span>;
const tabBar = (active: string, tabs: string[], onChange: (name: string) => void) =>
  <div className="tabs">{tabs.map(name => <button key={name} type="button" className={active === name ? 'active' : ''} onClick={() => onChange(name)}>{name}</button>)}</div>;

const TEST_STATUSES = ['active', 'inactive', 'under_review', 'archived'];
const LAB_STATUSES = ['active', 'inactive', 'suspended', 'archived'];

function useLookups() {
  const [sections, setSections] = useState<Section[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  useEffect(() => {
    api<Section[]>('/sections').then(setSections).catch(() => setSections([]));
    api<Department[]>('/departments').then(setDepartments).catch(() => setDepartments([]));
  }, []);
  return { sections, departments };
}

export function ProcessManagementPage() {
  const { isEnabled } = useModules();
  const { sections, departments } = useLookups();
  const [tab, setTab] = useState('Dashboard');
  const [error, setError] = useState<string | null>(null);

  const [summary, setSummary] = useState<ProcessManagementSummary | null>(null);
  const [tests, setTests] = useState<LabTestCatalog[]>([]);
  const [criteria, setCriteria] = useState<SpecimenAcceptanceCriteria[]>([]);
  const [rejections, setRejections] = useState<SpecimenRejectionRecord[]>([]);
  const [rules, setRules] = useState<CriticalResultRule[]>([]);
  const [criticals, setCriticals] = useState<CriticalResultNotification[]>([]);
  const [labs, setLabs] = useState<ReferralLaboratory[]>([]);
  const [refTests, setRefTests] = useState<ReferralTest[]>([]);
  const [sendouts, setSendouts] = useState<ReferralSendout[]>([]);
  const [amendments, setAmendments] = useState<ReportAmendmentLog[]>([]);
  const [reviews, setReviews] = useState<ProcessReviewRecord[]>([]);

  const [testForm, setTestForm] = useState({ testCode: '', testName: '', departmentId: '', sectionId: '', sampleType: '', containerType: '', minimumVolume: '', methodName: '', methodSummary: '', tatTargetMinutes: '', reportableRange: '', referenceIntervalSummary: '', criticalResultApplicable: false, status: 'active' });
  const [criteriaForm, setCriteriaForm] = useState({ criteriaCode: '', testCatalogId: '', sampleType: '', containerType: '', acceptanceCriteria: '', rejectionCriteria: '', transportCondition: '', stabilitySummary: '' });
  const [rejectionForm, setRejectionForm] = useState({ rejectionDate: '', requestReference: '', patientReference: '', patientType: '', sectionId: '', testCatalogId: '', testName: '', sampleType: '', rejectionReason: '', communicatedTo: '', communicationDate: '', immediateAction: '', repeatSampleRequested: false });
  const [ruleForm, setRuleForm] = useState({ ruleCode: '', testCatalogId: '', analyteName: '', unit: '', lowCriticalValue: '', highCriticalValue: '', notificationTimeframeMinutes: '', escalationInstruction: '' });
  const [criticalForm, setCriticalForm] = useState({ eventDate: '', eventTime: '', requestReference: '', patientReference: '', patientType: '', sectionId: '', testCatalogId: '', analyteName: '', resultValue: '', unit: '', criticalRuleId: '', notifiedTo: '', notificationMethod: '', notificationTime: '', readBackConfirmed: false, escalationNotes: '' });
  const [labForm, setLabForm] = useState({ referralLabCode: '', referralLabName: '', contactPerson: '', phone: '', email: '', address: '', serviceScope: '', accreditationOrApprovalNote: '', status: 'active' });
  const [refTestForm, setRefTestForm] = useState({ referralLabId: '', testCatalogId: '', referralTestName: '', sampleRequirement: '', expectedTatDays: '', transportCondition: '', costNote: '' });
  const [sendoutForm, setSendoutForm] = useState({ sendoutDate: '', referralLabId: '', referralTestId: '', requestReference: '', patientReference: '', patientType: '', sampleType: '', courierOrTransport: '', expectedReturnDate: '' });
  const [amendmentForm, setAmendmentForm] = useState({ amendmentDate: '', requestReference: '', patientReference: '', patientType: '', sectionId: '', testCatalogId: '', reasonForAmendment: '', originalReportSummary: '', amendedReportSummary: '' });
  const [reviewForm, setReviewForm] = useState({ reviewPeriodStart: '', reviewPeriodEnd: '', departmentId: '', sectionId: '' });

  async function load() {
    try {
      const [sum, t, c, rj, ru, cr, lb, rt, so, am, rv] = await Promise.all([
        api<ProcessManagementSummary>('/dashboard/process-management-summary').catch(() => null),
        api<LabTestCatalog[]>('/process-management/tests'),
        api<SpecimenAcceptanceCriteria[]>('/process-management/acceptance-criteria'),
        api<SpecimenRejectionRecord[]>('/process-management/specimen-rejections'),
        api<CriticalResultRule[]>('/process-management/critical-result-rules'),
        api<CriticalResultNotification[]>('/process-management/critical-results'),
        api<ReferralLaboratory[]>('/process-management/referral-labs'),
        api<ReferralTest[]>('/process-management/referral-tests'),
        api<ReferralSendout[]>('/process-management/referral-sendouts'),
        api<ReportAmendmentLog[]>('/process-management/report-amendments'),
        api<ProcessReviewRecord[]>('/process-management/process-reviews')
      ]);
      if (sum) setSummary(sum);
      setTests(t); setCriteria(c); setRejections(rj); setRules(ru); setCriticals(cr);
      setLabs(lb); setRefTests(rt); setSendouts(so); setAmendments(am); setReviews(rv);
    } catch (e) { setError((e as Error).message); }
  }
  useEffect(() => { if (isEnabled('process_management')) void load(); }, [isEnabled]);
  if (!isEnabled('process_management')) return <DisabledModule />;

  async function post(path: string, body: any) { return api(path, { method: 'POST', body: JSON.stringify(body) }); }

  async function submitTest(e: FormEvent) { e.preventDefault(); setError(null); try { await post('/process-management/tests', testForm); setTestForm({ testCode: '', testName: '', departmentId: '', sectionId: '', sampleType: '', containerType: '', minimumVolume: '', methodName: '', methodSummary: '', tatTargetMinutes: '', reportableRange: '', referenceIntervalSummary: '', criticalResultApplicable: false, status: 'active' }); await load(); } catch (e) { setError((e as Error).message); } }
  async function toggleTest(id: number) { try { await post(`/process-management/tests/${id}/toggle`, {}); await load(); } catch (e) { setError((e as Error).message); } }
  async function submitCriteria(e: FormEvent) { e.preventDefault(); setError(null); try { await post('/process-management/acceptance-criteria', criteriaForm); setCriteriaForm({ criteriaCode: '', testCatalogId: '', sampleType: '', containerType: '', acceptanceCriteria: '', rejectionCriteria: '', transportCondition: '', stabilitySummary: '' }); await load(); } catch (e) { setError((e as Error).message); } }
  async function toggleCriteria(id: number) { try { await post(`/process-management/acceptance-criteria/${id}/toggle`, {}); await load(); } catch (e) { setError((e as Error).message); } }
  async function submitRejection(e: FormEvent) { e.preventDefault(); setError(null); try { await post('/process-management/specimen-rejections', rejectionForm); setRejectionForm({ rejectionDate: '', requestReference: '', patientReference: '', patientType: '', sectionId: '', testCatalogId: '', testName: '', sampleType: '', rejectionReason: '', communicatedTo: '', communicationDate: '', immediateAction: '', repeatSampleRequested: false }); await load(); } catch (e) { setError((e as Error).message); } }
  async function rejectionCreateNc(id: number) { try { await post(`/process-management/specimen-rejections/${id}/create-nc`, {}); await load(); } catch (e) { setError((e as Error).message); } }
  async function rejectionCreateAction(id: number) { const title = prompt('Action title?'); if (!title) return; try { await post(`/process-management/specimen-rejections/${id}/create-action`, { title }); await load(); } catch (e) { setError((e as Error).message); } }
  async function closeRejection(id: number) { try { await post(`/process-management/specimen-rejections/${id}/close`, {}); await load(); } catch (e) { setError((e as Error).message); } }
  async function submitRule(e: FormEvent) { e.preventDefault(); setError(null); try { await post('/process-management/critical-result-rules', ruleForm); setRuleForm({ ruleCode: '', testCatalogId: '', analyteName: '', unit: '', lowCriticalValue: '', highCriticalValue: '', notificationTimeframeMinutes: '', escalationInstruction: '' }); await load(); } catch (e) { setError((e as Error).message); } }
  async function toggleRule(id: number) { try { await post(`/process-management/critical-result-rules/${id}/toggle`, {}); await load(); } catch (e) { setError((e as Error).message); } }
  async function submitCritical(e: FormEvent) { e.preventDefault(); setError(null); try { await post('/process-management/critical-results', criticalForm); setCriticalForm({ eventDate: '', eventTime: '', requestReference: '', patientReference: '', patientType: '', sectionId: '', testCatalogId: '', analyteName: '', resultValue: '', unit: '', criticalRuleId: '', notifiedTo: '', notificationMethod: '', notificationTime: '', readBackConfirmed: false, escalationNotes: '' }); await load(); } catch (e) { setError((e as Error).message); } }
  async function ackCritical(id: number) { try { await post(`/process-management/critical-results/${id}/acknowledge`, {}); await load(); } catch (e) { setError((e as Error).message); } }
  async function criticalCreateNc(id: number) { try { await post(`/process-management/critical-results/${id}/create-nc`, {}); await load(); } catch (e) { setError((e as Error).message); } }
  async function criticalCreateAction(id: number) { const title = prompt('Action title?'); if (!title) return; try { await post(`/process-management/critical-results/${id}/create-action`, { title }); await load(); } catch (e) { setError((e as Error).message); } }
  async function closeCritical(id: number) { try { await post(`/process-management/critical-results/${id}/close`, {}); await load(); } catch (e) { setError((e as Error).message); } }
  async function submitLab(e: FormEvent) { e.preventDefault(); setError(null); try { await post('/process-management/referral-labs', labForm); setLabForm({ referralLabCode: '', referralLabName: '', contactPerson: '', phone: '', email: '', address: '', serviceScope: '', accreditationOrApprovalNote: '', status: 'active' }); await load(); } catch (e) { setError((e as Error).message); } }
  async function setLabStatus(id: number, status: string) { try { await post(`/process-management/referral-labs/${id}/status`, { status }); await load(); } catch (e) { setError((e as Error).message); } }
  async function submitRefTest(e: FormEvent) { e.preventDefault(); setError(null); try { await post('/process-management/referral-tests', refTestForm); setRefTestForm({ referralLabId: '', testCatalogId: '', referralTestName: '', sampleRequirement: '', expectedTatDays: '', transportCondition: '', costNote: '' }); await load(); } catch (e) { setError((e as Error).message); } }
  async function toggleRefTest(id: number) { try { await post(`/process-management/referral-tests/${id}/toggle`, {}); await load(); } catch (e) { setError((e as Error).message); } }
  async function submitSendout(e: FormEvent) { e.preventDefault(); setError(null); try { await post('/process-management/referral-sendouts', sendoutForm); setSendoutForm({ sendoutDate: '', referralLabId: '', referralTestId: '', requestReference: '', patientReference: '', patientType: '', sampleType: '', courierOrTransport: '', expectedReturnDate: '' }); await load(); } catch (e) { setError((e as Error).message); } }
  async function sendoutCreateNc(id: number) { try { await post(`/process-management/referral-sendouts/${id}/create-nc`, {}); await load(); } catch (e) { setError((e as Error).message); } }
  async function sendoutCreateAction(id: number) { const title = prompt('Action title?'); if (!title) return; try { await post(`/process-management/referral-sendouts/${id}/create-action`, { title }); await load(); } catch (e) { setError((e as Error).message); } }
  async function closeSendout(id: number) { try { await post(`/process-management/referral-sendouts/${id}/close`, {}); await load(); } catch (e) { setError((e as Error).message); } }
  async function submitAmendment(e: FormEvent) { e.preventDefault(); setError(null); try { await post('/process-management/report-amendments', amendmentForm); setAmendmentForm({ amendmentDate: '', requestReference: '', patientReference: '', patientType: '', sectionId: '', testCatalogId: '', reasonForAmendment: '', originalReportSummary: '', amendedReportSummary: '' }); await load(); } catch (e) { setError((e as Error).message); } }
  async function authorizeAmendment(id: number) { try { await post(`/process-management/report-amendments/${id}/authorize`, {}); await load(); } catch (e) { setError((e as Error).message); } }
  async function amendmentCreateNc(id: number) { try { await post(`/process-management/report-amendments/${id}/create-nc`, {}); await load(); } catch (e) { setError((e as Error).message); } }
  async function amendmentCreateAction(id: number) { const title = prompt('Action title?'); if (!title) return; try { await post(`/process-management/report-amendments/${id}/create-action`, { title }); await load(); } catch (e) { setError((e as Error).message); } }
  async function closeAmendment(id: number) { try { await post(`/process-management/report-amendments/${id}/close`, {}); await load(); } catch (e) { setError((e as Error).message); } }
  async function submitReview(e: FormEvent) { e.preventDefault(); setError(null); try { await post('/process-management/process-reviews', reviewForm); setReviewForm({ reviewPeriodStart: '', reviewPeriodEnd: '', departmentId: '', sectionId: '' }); await load(); } catch (e) { setError((e as Error).message); } }
  async function generateReviewSummary(id: number) { try { await post(`/process-management/process-reviews/${id}/generate-summary`, {}); await load(); } catch (e) { setError((e as Error).message); } }
  async function approveReview(id: number) { try { await post(`/process-management/process-reviews/${id}/approve`, {}); await load(); } catch (e) { setError((e as Error).message); } }
  async function closeReview(id: number) { try { await post(`/process-management/process-reviews/${id}/close`, {}); await load(); } catch (e) { setError((e as Error).message); } }

  const tabs = ['Dashboard', 'Test Directory', 'Acceptance Criteria', 'Specimen Rejections', 'Critical Result Rules', 'Critical Notifications', 'Referral Labs', 'Referral Tests', 'Referral Sendouts', 'Report Amendments', 'Process Reviews'];

  return <div className="module-page">
    <h2>Process Management</h2>
    <p className="muted">Patient testing and clinical result reporting remain with LHIMS/Lightwave. This module tracks the QMS workflow only — no patient names are required; use request and patient references as identifiers.</p>
    {tabBar(tab, tabs, setTab)}
    {error && <div className="error">{error}</div>}

    {tab === 'Dashboard' && (summary ? <div className="cards">
      <div className="card"><h4>Active tests</h4><p className="metric">{summary.activeTests}</p></div>
      <div className="card"><h4>Active acceptance criteria</h4><p className="metric">{summary.activeAcceptanceCriteria}</p></div>
      <div className="card"><h4>Specimen rejections (month)</h4><p className="metric">{summary.specimenRejectionsThisMonth}</p></div>
      <div className="card"><h4>Open rejections</h4><p className="metric">{summary.openSpecimenRejections}</p></div>
      <div className="card"><h4>Critical results (month)</h4><p className="metric">{summary.criticalResultsThisMonth}</p></div>
      <div className="card"><h4>Delayed critical notifications</h4><p className="metric">{summary.delayedCriticalNotifications}</p></div>
      <div className="card"><h4>Referral sendouts pending</h4><p className="metric">{summary.referralSendoutsPending}</p></div>
      <div className="card"><h4>Delayed referral sendouts</h4><p className="metric">{summary.delayedReferralSendouts}</p></div>
      <div className="card"><h4>Report amendments (month)</h4><p className="metric">{summary.reportAmendmentsThisMonth}</p></div>
      <div className="card"><h4>Pending process reviews</h4><p className="metric">{summary.pendingProcessReviews}</p></div>
    </div> : <p>Loading summary…</p>)}

    {tab === 'Test Directory' && <>
      <form className="form-grid" onSubmit={submitTest}>
        <label>Code<input value={testForm.testCode} onChange={e => setTestForm({ ...testForm, testCode: e.target.value })} /></label>
        <label>Test name<input value={testForm.testName} onChange={e => setTestForm({ ...testForm, testName: e.target.value })} required /></label>
        <label>Department<select value={testForm.departmentId} onChange={e => setTestForm({ ...testForm, departmentId: e.target.value })}><option value="">—</option>{departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
        <label>Section<select value={testForm.sectionId} onChange={e => setTestForm({ ...testForm, sectionId: e.target.value })}><option value="">—</option>{sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label>Sample type<input value={testForm.sampleType} onChange={e => setTestForm({ ...testForm, sampleType: e.target.value })} required /></label>
        <label>Container<input value={testForm.containerType} onChange={e => setTestForm({ ...testForm, containerType: e.target.value })} /></label>
        <label>Min volume<input value={testForm.minimumVolume} onChange={e => setTestForm({ ...testForm, minimumVolume: e.target.value })} /></label>
        <label>Method name<input value={testForm.methodName} onChange={e => setTestForm({ ...testForm, methodName: e.target.value })} /></label>
        <label>TAT target (minutes)<input type="number" value={testForm.tatTargetMinutes} onChange={e => setTestForm({ ...testForm, tatTargetMinutes: e.target.value })} /></label>
        <label>Reportable range<input value={testForm.reportableRange} onChange={e => setTestForm({ ...testForm, reportableRange: e.target.value })} /></label>
        <label>Reference interval<input value={testForm.referenceIntervalSummary} onChange={e => setTestForm({ ...testForm, referenceIntervalSummary: e.target.value })} /></label>
        <label>Method summary<textarea value={testForm.methodSummary} onChange={e => setTestForm({ ...testForm, methodSummary: e.target.value })} /></label>
        <label><input type="checkbox" checked={testForm.criticalResultApplicable} onChange={e => setTestForm({ ...testForm, criticalResultApplicable: e.target.checked })} /> Critical result applicable</label>
        <label>Status<select value={testForm.status} onChange={e => setTestForm({ ...testForm, status: e.target.value })}>{TEST_STATUSES.map(s => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}</select></label>
        <button type="submit">Add test</button>
      </form>
      <table className="data-table"><thead><tr><th>Code</th><th>Name</th><th>Section</th><th>Sample</th><th>TAT min</th><th>Critical?</th><th>Status</th><th></th></tr></thead><tbody>
        {tests.map(t => <tr key={t.id}><td>{t.test_code || '—'}</td><td>{t.test_name}</td><td>{sections.find(s => s.id === t.section_id)?.name || '—'}</td><td>{t.sample_type || '—'}</td><td>{t.tat_target_minutes ?? '—'}</td><td>{t.critical_result_applicable ? 'Yes' : 'No'}</td><td>{formatBadge(t.status)}</td><td><button onClick={() => toggleTest(t.id)}>Toggle</button></td></tr>)}
      </tbody></table>
    </>}

    {tab === 'Acceptance Criteria' && <>
      <form className="form-grid" onSubmit={submitCriteria}>
        <label>Code<input value={criteriaForm.criteriaCode} onChange={e => setCriteriaForm({ ...criteriaForm, criteriaCode: e.target.value })} /></label>
        <label>Test<select value={criteriaForm.testCatalogId} onChange={e => setCriteriaForm({ ...criteriaForm, testCatalogId: e.target.value })}><option value="">—</option>{tests.map(t => <option key={t.id} value={t.id}>{t.test_name}</option>)}</select></label>
        <label>Sample type<input value={criteriaForm.sampleType} onChange={e => setCriteriaForm({ ...criteriaForm, sampleType: e.target.value })} required /></label>
        <label>Container<input value={criteriaForm.containerType} onChange={e => setCriteriaForm({ ...criteriaForm, containerType: e.target.value })} /></label>
        <label>Acceptance criteria<textarea value={criteriaForm.acceptanceCriteria} onChange={e => setCriteriaForm({ ...criteriaForm, acceptanceCriteria: e.target.value })} required /></label>
        <label>Rejection criteria<textarea value={criteriaForm.rejectionCriteria} onChange={e => setCriteriaForm({ ...criteriaForm, rejectionCriteria: e.target.value })} /></label>
        <label>Transport condition<input value={criteriaForm.transportCondition} onChange={e => setCriteriaForm({ ...criteriaForm, transportCondition: e.target.value })} /></label>
        <label>Stability summary<input value={criteriaForm.stabilitySummary} onChange={e => setCriteriaForm({ ...criteriaForm, stabilitySummary: e.target.value })} /></label>
        <button type="submit">Add criteria</button>
      </form>
      <table className="data-table"><thead><tr><th>Code</th><th>Sample</th><th>Container</th><th>Acceptance</th><th>Active</th><th></th></tr></thead><tbody>
        {criteria.map(c => <tr key={c.id}><td>{c.criteria_code || '—'}</td><td>{c.sample_type}</td><td>{c.container_type || '—'}</td><td>{c.acceptance_criteria}</td><td>{c.is_active ? 'Yes' : 'No'}</td><td><button onClick={() => toggleCriteria(c.id)}>Toggle</button></td></tr>)}
      </tbody></table>
    </>}

    {tab === 'Specimen Rejections' && <>
      <form className="form-grid" onSubmit={submitRejection}>
        <label>Rejection date<input type="date" value={rejectionForm.rejectionDate} onChange={e => setRejectionForm({ ...rejectionForm, rejectionDate: e.target.value })} required /></label>
        <label>Request reference<input value={rejectionForm.requestReference} onChange={e => setRejectionForm({ ...rejectionForm, requestReference: e.target.value })} /></label>
        <label>Patient reference<input value={rejectionForm.patientReference} onChange={e => setRejectionForm({ ...rejectionForm, patientReference: e.target.value })} /></label>
        <label>Patient type<input value={rejectionForm.patientType} onChange={e => setRejectionForm({ ...rejectionForm, patientType: e.target.value })} placeholder="e.g. OPD, IPD" /></label>
        <label>Section<select value={rejectionForm.sectionId} onChange={e => setRejectionForm({ ...rejectionForm, sectionId: e.target.value })}><option value="">—</option>{sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label>Test<select value={rejectionForm.testCatalogId} onChange={e => setRejectionForm({ ...rejectionForm, testCatalogId: e.target.value })}><option value="">—</option>{tests.map(t => <option key={t.id} value={t.id}>{t.test_name}</option>)}</select></label>
        <label>Test name (free text)<input value={rejectionForm.testName} onChange={e => setRejectionForm({ ...rejectionForm, testName: e.target.value })} /></label>
        <label>Sample type<input value={rejectionForm.sampleType} onChange={e => setRejectionForm({ ...rejectionForm, sampleType: e.target.value })} /></label>
        <label>Rejection reason<textarea value={rejectionForm.rejectionReason} onChange={e => setRejectionForm({ ...rejectionForm, rejectionReason: e.target.value })} required /></label>
        <label>Communicated to<input value={rejectionForm.communicatedTo} onChange={e => setRejectionForm({ ...rejectionForm, communicatedTo: e.target.value })} /></label>
        <label>Communication date<input type="date" value={rejectionForm.communicationDate} onChange={e => setRejectionForm({ ...rejectionForm, communicationDate: e.target.value })} /></label>
        <label>Immediate action<input value={rejectionForm.immediateAction} onChange={e => setRejectionForm({ ...rejectionForm, immediateAction: e.target.value })} /></label>
        <label><input type="checkbox" checked={rejectionForm.repeatSampleRequested} onChange={e => setRejectionForm({ ...rejectionForm, repeatSampleRequested: e.target.checked })} /> Repeat sample requested</label>
        <button type="submit">Log rejection</button>
      </form>
      <table className="data-table"><thead><tr><th>Number</th><th>Date</th><th>Request ref</th><th>Test</th><th>Reason</th><th>Repeat?</th><th>Status</th><th></th></tr></thead><tbody>
        {rejections.map(r => <tr key={r.id}><td>{r.rejection_number}</td><td>{r.rejection_date}</td><td>{r.request_reference || '—'}</td><td>{r.test_name || (tests.find(t => t.id === r.test_catalog_id)?.test_name || '—')}</td><td>{r.rejection_reason}</td><td>{r.repeat_sample_requested ? 'Yes' : 'No'}</td><td>{formatBadge(r.status)}</td>
          <td>{!r.linked_nc_id && <button onClick={() => rejectionCreateNc(r.id)}>NC</button>} <button onClick={() => rejectionCreateAction(r.id)}>Action</button> {r.status !== 'closed' && <button onClick={() => closeRejection(r.id)}>Close</button>}</td>
        </tr>)}
      </tbody></table>
    </>}

    {tab === 'Critical Result Rules' && <>
      <form className="form-grid" onSubmit={submitRule}>
        <label>Code<input value={ruleForm.ruleCode} onChange={e => setRuleForm({ ...ruleForm, ruleCode: e.target.value })} /></label>
        <label>Test<select value={ruleForm.testCatalogId} onChange={e => setRuleForm({ ...ruleForm, testCatalogId: e.target.value })} required><option value="">—</option>{tests.map(t => <option key={t.id} value={t.id}>{t.test_name}</option>)}</select></label>
        <label>Analyte<input value={ruleForm.analyteName} onChange={e => setRuleForm({ ...ruleForm, analyteName: e.target.value })} required /></label>
        <label>Unit<input value={ruleForm.unit} onChange={e => setRuleForm({ ...ruleForm, unit: e.target.value })} /></label>
        <label>Low critical<input type="number" step="any" value={ruleForm.lowCriticalValue} onChange={e => setRuleForm({ ...ruleForm, lowCriticalValue: e.target.value })} /></label>
        <label>High critical<input type="number" step="any" value={ruleForm.highCriticalValue} onChange={e => setRuleForm({ ...ruleForm, highCriticalValue: e.target.value })} /></label>
        <label>Notification timeframe (min)<input type="number" value={ruleForm.notificationTimeframeMinutes} onChange={e => setRuleForm({ ...ruleForm, notificationTimeframeMinutes: e.target.value })} /></label>
        <label>Escalation instruction<textarea value={ruleForm.escalationInstruction} onChange={e => setRuleForm({ ...ruleForm, escalationInstruction: e.target.value })} /></label>
        <button type="submit">Add rule</button>
      </form>
      <table className="data-table"><thead><tr><th>Code</th><th>Test</th><th>Analyte</th><th>Range</th><th>Timeframe (min)</th><th>Active</th><th></th></tr></thead><tbody>
        {rules.map(r => <tr key={r.id}><td>{r.rule_code || '—'}</td><td>{tests.find(t => t.id === r.test_catalog_id)?.test_name || '—'}</td><td>{r.analyte_name}</td><td>{r.low_critical_value ?? '—'} – {r.high_critical_value ?? '—'} {r.unit}</td><td>{r.notification_timeframe_minutes ?? '—'}</td><td>{r.is_active ? 'Yes' : 'No'}</td><td><button onClick={() => toggleRule(r.id)}>Toggle</button></td></tr>)}
      </tbody></table>
    </>}

    {tab === 'Critical Notifications' && <>
      <form className="form-grid" onSubmit={submitCritical}>
        <label>Event date<input type="date" value={criticalForm.eventDate} onChange={e => setCriticalForm({ ...criticalForm, eventDate: e.target.value })} required /></label>
        <label>Event time<input type="time" value={criticalForm.eventTime} onChange={e => setCriticalForm({ ...criticalForm, eventTime: e.target.value })} required /></label>
        <label>Request reference<input value={criticalForm.requestReference} onChange={e => setCriticalForm({ ...criticalForm, requestReference: e.target.value })} /></label>
        <label>Patient reference<input value={criticalForm.patientReference} onChange={e => setCriticalForm({ ...criticalForm, patientReference: e.target.value })} /></label>
        <label>Patient type<input value={criticalForm.patientType} onChange={e => setCriticalForm({ ...criticalForm, patientType: e.target.value })} placeholder="e.g. OPD, IPD" /></label>
        <label>Test<select value={criticalForm.testCatalogId} onChange={e => setCriticalForm({ ...criticalForm, testCatalogId: e.target.value })}><option value="">—</option>{tests.map(t => <option key={t.id} value={t.id}>{t.test_name}</option>)}</select></label>
        <label>Analyte<input value={criticalForm.analyteName} onChange={e => setCriticalForm({ ...criticalForm, analyteName: e.target.value })} required /></label>
        <label>Result value<input value={criticalForm.resultValue} onChange={e => setCriticalForm({ ...criticalForm, resultValue: e.target.value })} required /></label>
        <label>Unit<input value={criticalForm.unit} onChange={e => setCriticalForm({ ...criticalForm, unit: e.target.value })} /></label>
        <label>Critical rule<select value={criticalForm.criticalRuleId} onChange={e => setCriticalForm({ ...criticalForm, criticalRuleId: e.target.value })}><option value="">—</option>{rules.map(r => <option key={r.id} value={r.id}>{r.analyte_name} ({r.rule_code || `#${r.id}`})</option>)}</select></label>
        <label>Notified to<input value={criticalForm.notifiedTo} onChange={e => setCriticalForm({ ...criticalForm, notifiedTo: e.target.value })} /></label>
        <label>Notification method<input value={criticalForm.notificationMethod} onChange={e => setCriticalForm({ ...criticalForm, notificationMethod: e.target.value })} placeholder="e.g. phone, in person" /></label>
        <label>Notification time<input type="time" value={criticalForm.notificationTime} onChange={e => setCriticalForm({ ...criticalForm, notificationTime: e.target.value })} /></label>
        <label><input type="checkbox" checked={criticalForm.readBackConfirmed} onChange={e => setCriticalForm({ ...criticalForm, readBackConfirmed: e.target.checked })} /> Read-back confirmed</label>
        <label>Escalation notes<textarea value={criticalForm.escalationNotes} onChange={e => setCriticalForm({ ...criticalForm, escalationNotes: e.target.value })} /></label>
        <button type="submit">Log notification</button>
      </form>
      <table className="data-table"><thead><tr><th>Number</th><th>Date/time</th><th>Request ref</th><th>Analyte</th><th>Value</th><th>Notified</th><th>Escalation?</th><th>Status</th><th></th></tr></thead><tbody>
        {criticals.map(c => <tr key={c.id}><td>{c.notification_number}</td><td>{c.event_date} {c.event_time}</td><td>{c.request_reference || '—'}</td><td>{c.analyte_name}</td><td>{c.result_value} {c.unit}</td><td>{c.notified_to || '—'}{c.notification_time ? ` @ ${c.notification_time}` : ''}</td><td>{c.escalation_required ? <span className="badge danger">required</span> : '—'}</td><td>{formatBadge(c.status)}</td>
          <td>{c.acknowledgement_status !== 'acknowledged' && <button onClick={() => ackCritical(c.id)}>Ack</button>}{!c.linked_nc_id && <button onClick={() => criticalCreateNc(c.id)}>NC</button>} <button onClick={() => criticalCreateAction(c.id)}>Action</button> {c.status !== 'closed' && <button onClick={() => closeCritical(c.id)}>Close</button>}</td>
        </tr>)}
      </tbody></table>
    </>}

    {tab === 'Referral Labs' && <>
      <form className="form-grid" onSubmit={submitLab}>
        <label>Code<input value={labForm.referralLabCode} onChange={e => setLabForm({ ...labForm, referralLabCode: e.target.value })} /></label>
        <label>Lab name<input value={labForm.referralLabName} onChange={e => setLabForm({ ...labForm, referralLabName: e.target.value })} required /></label>
        <label>Contact person<input value={labForm.contactPerson} onChange={e => setLabForm({ ...labForm, contactPerson: e.target.value })} /></label>
        <label>Phone<input value={labForm.phone} onChange={e => setLabForm({ ...labForm, phone: e.target.value })} /></label>
        <label>Email<input value={labForm.email} onChange={e => setLabForm({ ...labForm, email: e.target.value })} /></label>
        <label>Address<input value={labForm.address} onChange={e => setLabForm({ ...labForm, address: e.target.value })} /></label>
        <label>Service scope<input value={labForm.serviceScope} onChange={e => setLabForm({ ...labForm, serviceScope: e.target.value })} /></label>
        <label>Accreditation/approval<input value={labForm.accreditationOrApprovalNote} onChange={e => setLabForm({ ...labForm, accreditationOrApprovalNote: e.target.value })} placeholder="Lab-recorded note only; not an official scoring claim" /></label>
        <label>Status<select value={labForm.status} onChange={e => setLabForm({ ...labForm, status: e.target.value })}>{LAB_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}</select></label>
        <button type="submit">Register referral lab</button>
      </form>
      <table className="data-table"><thead><tr><th>Code</th><th>Name</th><th>Contact</th><th>Phone</th><th>Status</th><th></th></tr></thead><tbody>
        {labs.map(l => <tr key={l.id}><td>{l.referral_lab_code || '—'}</td><td>{l.referral_lab_name}</td><td>{l.contact_person || '—'}</td><td>{l.phone || '—'}</td><td>{formatBadge(l.status)}</td>
          <td>{LAB_STATUSES.filter(s => s !== l.status).map(s => <button key={s} onClick={() => setLabStatus(l.id, s)}>{s}</button>)}</td>
        </tr>)}
      </tbody></table>
    </>}

    {tab === 'Referral Tests' && <>
      <form className="form-grid" onSubmit={submitRefTest}>
        <label>Referral lab<select value={refTestForm.referralLabId} onChange={e => setRefTestForm({ ...refTestForm, referralLabId: e.target.value })} required><option value="">—</option>{labs.map(l => <option key={l.id} value={l.id}>{l.referral_lab_name}</option>)}</select></label>
        <label>Local test<select value={refTestForm.testCatalogId} onChange={e => setRefTestForm({ ...refTestForm, testCatalogId: e.target.value })}><option value="">—</option>{tests.map(t => <option key={t.id} value={t.id}>{t.test_name}</option>)}</select></label>
        <label>Referral test name<input value={refTestForm.referralTestName} onChange={e => setRefTestForm({ ...refTestForm, referralTestName: e.target.value })} required /></label>
        <label>Sample requirement<input value={refTestForm.sampleRequirement} onChange={e => setRefTestForm({ ...refTestForm, sampleRequirement: e.target.value })} /></label>
        <label>Expected TAT (days)<input type="number" value={refTestForm.expectedTatDays} onChange={e => setRefTestForm({ ...refTestForm, expectedTatDays: e.target.value })} /></label>
        <label>Transport condition<input value={refTestForm.transportCondition} onChange={e => setRefTestForm({ ...refTestForm, transportCondition: e.target.value })} /></label>
        <label>Cost note<input value={refTestForm.costNote} onChange={e => setRefTestForm({ ...refTestForm, costNote: e.target.value })} /></label>
        <button type="submit">Add referral test</button>
      </form>
      <table className="data-table"><thead><tr><th>Lab</th><th>Test name</th><th>Sample</th><th>TAT (days)</th><th>Active</th><th></th></tr></thead><tbody>
        {refTests.map(rt => <tr key={rt.id}><td>{labs.find(l => l.id === rt.referral_lab_id)?.referral_lab_name || '—'}</td><td>{rt.referral_test_name}</td><td>{rt.sample_requirement || '—'}</td><td>{rt.expected_tat_days ?? '—'}</td><td>{rt.is_active ? 'Yes' : 'No'}</td><td><button onClick={() => toggleRefTest(rt.id)}>Toggle</button></td></tr>)}
      </tbody></table>
    </>}

    {tab === 'Referral Sendouts' && <>
      <form className="form-grid" onSubmit={submitSendout}>
        <label>Sendout date<input type="date" value={sendoutForm.sendoutDate} onChange={e => setSendoutForm({ ...sendoutForm, sendoutDate: e.target.value })} required /></label>
        <label>Referral lab<select value={sendoutForm.referralLabId} onChange={e => setSendoutForm({ ...sendoutForm, referralLabId: e.target.value })} required><option value="">—</option>{labs.map(l => <option key={l.id} value={l.id}>{l.referral_lab_name}</option>)}</select></label>
        <label>Referral test<select value={sendoutForm.referralTestId} onChange={e => setSendoutForm({ ...sendoutForm, referralTestId: e.target.value })}><option value="">—</option>{refTests.filter(rt => !sendoutForm.referralLabId || String(rt.referral_lab_id) === sendoutForm.referralLabId).map(rt => <option key={rt.id} value={rt.id}>{rt.referral_test_name}</option>)}</select></label>
        <label>Request reference<input value={sendoutForm.requestReference} onChange={e => setSendoutForm({ ...sendoutForm, requestReference: e.target.value })} /></label>
        <label>Patient reference<input value={sendoutForm.patientReference} onChange={e => setSendoutForm({ ...sendoutForm, patientReference: e.target.value })} /></label>
        <label>Patient type<input value={sendoutForm.patientType} onChange={e => setSendoutForm({ ...sendoutForm, patientType: e.target.value })} placeholder="e.g. OPD, IPD" /></label>
        <label>Sample type<input value={sendoutForm.sampleType} onChange={e => setSendoutForm({ ...sendoutForm, sampleType: e.target.value })} /></label>
        <label>Courier/transport<input value={sendoutForm.courierOrTransport} onChange={e => setSendoutForm({ ...sendoutForm, courierOrTransport: e.target.value })} /></label>
        <label>Expected return date<input type="date" value={sendoutForm.expectedReturnDate} onChange={e => setSendoutForm({ ...sendoutForm, expectedReturnDate: e.target.value })} /></label>
        <button type="submit">Log sendout</button>
      </form>
      <table className="data-table"><thead><tr><th>Number</th><th>Date</th><th>Lab</th><th>Test</th><th>Request ref</th><th>Expected return</th><th>Result received</th><th>Status</th><th></th></tr></thead><tbody>
        {sendouts.map(s => <tr key={s.id}><td>{s.sendout_number}</td><td>{s.sendout_date}</td><td>{labs.find(l => l.id === s.referral_lab_id)?.referral_lab_name || '—'}</td><td>{refTests.find(rt => rt.id === s.referral_test_id)?.referral_test_name || '—'}</td><td>{s.request_reference || '—'}</td><td>{s.expected_return_date || '—'}{s._delayed && <span className="badge danger"> delayed</span>}</td><td>{s.result_received_date || '—'}</td><td>{formatBadge(s.status)}</td>
          <td>{!s.linked_nc_id && <button onClick={() => sendoutCreateNc(s.id)}>NC</button>} <button onClick={() => sendoutCreateAction(s.id)}>Action</button> {s.status !== 'closed' && <button onClick={() => closeSendout(s.id)}>Close</button>}</td>
        </tr>)}
      </tbody></table>
    </>}

    {tab === 'Report Amendments' && <>
      <form className="form-grid" onSubmit={submitAmendment}>
        <label>Amendment date<input type="date" value={amendmentForm.amendmentDate} onChange={e => setAmendmentForm({ ...amendmentForm, amendmentDate: e.target.value })} required /></label>
        <label>Request reference<input value={amendmentForm.requestReference} onChange={e => setAmendmentForm({ ...amendmentForm, requestReference: e.target.value })} /></label>
        <label>Patient reference<input value={amendmentForm.patientReference} onChange={e => setAmendmentForm({ ...amendmentForm, patientReference: e.target.value })} /></label>
        <label>Patient type<input value={amendmentForm.patientType} onChange={e => setAmendmentForm({ ...amendmentForm, patientType: e.target.value })} /></label>
        <label>Section<select value={amendmentForm.sectionId} onChange={e => setAmendmentForm({ ...amendmentForm, sectionId: e.target.value })}><option value="">—</option>{sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label>Test<select value={amendmentForm.testCatalogId} onChange={e => setAmendmentForm({ ...amendmentForm, testCatalogId: e.target.value })}><option value="">—</option>{tests.map(t => <option key={t.id} value={t.id}>{t.test_name}</option>)}</select></label>
        <label>Reason for amendment<textarea value={amendmentForm.reasonForAmendment} onChange={e => setAmendmentForm({ ...amendmentForm, reasonForAmendment: e.target.value })} required /></label>
        <label>Original report summary<textarea value={amendmentForm.originalReportSummary} onChange={e => setAmendmentForm({ ...amendmentForm, originalReportSummary: e.target.value })} /></label>
        <label>Amended report summary<textarea value={amendmentForm.amendedReportSummary} onChange={e => setAmendmentForm({ ...amendmentForm, amendedReportSummary: e.target.value })} /></label>
        <button type="submit">Log amendment</button>
      </form>
      <table className="data-table"><thead><tr><th>Number</th><th>Date</th><th>Request ref</th><th>Reason</th><th>Status</th><th></th></tr></thead><tbody>
        {amendments.map(a => <tr key={a.id}><td>{a.amendment_number}</td><td>{a.amendment_date}</td><td>{a.request_reference || '—'}</td><td>{a.reason_for_amendment}</td><td>{formatBadge(a.status)}</td>
          <td>{a.status === 'draft' && <button onClick={() => authorizeAmendment(a.id)}>Authorise</button>}{!a.linked_nc_id && <button onClick={() => amendmentCreateNc(a.id)}>NC</button>} <button onClick={() => amendmentCreateAction(a.id)}>Action</button> {a.status !== 'closed' && <button onClick={() => closeAmendment(a.id)}>Close</button>}</td>
        </tr>)}
      </tbody></table>
    </>}

    {tab === 'Process Reviews' && <>
      <form className="form-grid" onSubmit={submitReview}>
        <label>Period start<input type="date" value={reviewForm.reviewPeriodStart} onChange={e => setReviewForm({ ...reviewForm, reviewPeriodStart: e.target.value })} required /></label>
        <label>Period end<input type="date" value={reviewForm.reviewPeriodEnd} onChange={e => setReviewForm({ ...reviewForm, reviewPeriodEnd: e.target.value })} required /></label>
        <label>Department<select value={reviewForm.departmentId} onChange={e => setReviewForm({ ...reviewForm, departmentId: e.target.value })}><option value="">—</option>{departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
        <label>Section<select value={reviewForm.sectionId} onChange={e => setReviewForm({ ...reviewForm, sectionId: e.target.value })}><option value="">—</option>{sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <button type="submit">Create review</button>
      </form>
      <table className="data-table"><thead><tr><th>Number</th><th>Period</th><th>Summary</th><th>Status</th><th></th></tr></thead><tbody>
        {reviews.map(r => <tr key={r.id}><td>{r.review_number}</td><td>{r.review_period_start} → {r.review_period_end}</td>
          <td>{[r.rejection_summary, r.critical_result_summary, r.referral_testing_summary, r.report_amendment_summary].filter(Boolean).join(' · ') || '—'}</td>
          <td>{formatBadge(r.status)}</td>
          <td><button onClick={() => generateReviewSummary(r.id)}>Generate summary</button> {r.status === 'reviewed' && <button onClick={() => approveReview(r.id)}>Approve</button>}{r.status !== 'closed' && <button onClick={() => closeReview(r.id)}>Close</button>}</td>
        </tr>)}
      </tbody></table>
    </>}
  </div>;
}

