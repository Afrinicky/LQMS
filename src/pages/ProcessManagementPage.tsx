import { FormEvent, useEffect, useState } from 'react';
import PageHeader from '../components/ui/PageHeader';
import { KpiStrip, ChartCard, DonutChart, BarMeter, CHART_COLORS, ModuleAlerts } from '../components/ui';
import { useModules } from '../hooks/useModules';
import { usePermissions } from '../hooks/usePermissions';
import { api, errorText, apiRead } from '../services/api';
import DisabledModule from '../components/DisabledModule';
import { useTabParam } from '../hooks/useTabParam';
import XlsxToolbar from '../components/XlsxToolbar';
import BarcodeScanner from '../components/BarcodeScanner';
import { printLabelSheet } from '../utils/labelPrint';
import { EqaPage, VerificationValidationPage, MeasurementUncertaintyPage } from './Phase4Pages';
import { IqcPage } from './IqcPage';
import { POCTPage } from './POCTPage';
import { BloodBankHandoverPage } from './BloodBankHandoverPage';
import PermissionTabs from '../components/PermissionTabs';
import type {
  Section, Department, Staff,
  LabTestCatalog, SpecimenAcceptanceCriteria, SpecimenRejectionRecord,
  CriticalResultRule, CriticalResultNotification,
  ReferralLaboratory, ReferralTest, ReferralSendout,
  ReportAmendmentLog, ProcessReviewRecord, ProcessManagementSummary,
  PreExaminationInstruction, SampleReceiptRecord, ReferenceIntervalRecord, ResultComparabilityStudy, ContingencyPlan
} from '../../shared/types/api';
import TextField from '../components/ui/TextField';
import { Notice } from '../components/ui/Feedback';

const statusBadgeClass = (status?: string) => `badge ${status ? status.toLowerCase().replace(/\s+/g, '-') : 'unknown'}`;
const formatBadge = (status?: string) => <span className={statusBadgeClass(status)}>{status ? status.replace(/_/g, ' ') : 'Unknown'}</span>;
// Tabs are filtered by permission — a tab whose feature this user cannot
// view is not drawn. See src/components/PermissionTabs.tsx.
const TAB_MODULE = 'process_management';

// Every tab this workspace can show, in one flat list, so an alert can name one.
const ALL_PROCESS_TABS = [
  'Dashboard',
  'Pre-Examination', 'Sample Receipt', 'Test Directory', 'Acceptance Criteria', 'Specimen Rejections',
  'Reference Intervals', 'Comparability', 'IQC', 'EQA', 'Method Verification', 'Measurement Uncertainty', 'POCT',
  'Critical Result Rules', 'Critical Notifications', 'Referral Labs', 'Referral Tests', 'Referral Sendouts',
  'Report Amendments', 'Process Reviews', 'Contingency Plan',
  'Blood banking',
];
const tabBar = (active: string, tabs: string[], onChange: (name: string) => void) =>
  <PermissionTabs moduleKey={TAB_MODULE} tabs={tabs} active={active} onChange={onChange} />;

const TEST_STATUSES = ['active', 'inactive', 'under_review', 'archived'];
const LAB_STATUSES = ['active', 'inactive', 'suspended', 'archived'];

function useLookups() {
  const [sections, setSections] = useState<Section[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  useEffect(() => {
    api<Section[]>('/sections').then(setSections).catch(() => setSections([]));
    api<Department[]>('/departments').then(setDepartments).catch(() => setDepartments([]));
    api<Staff[]>('/staff').then(setStaff).catch(() => setStaff([]));
  }, []);
  return { sections, departments, staff };
}

export function ProcessManagementPage() {
  const { canView } = usePermissions();
  const { isEnabled } = useModules();
  const { sections, departments, staff } = useLookups();
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
  const [preExam, setPreExam] = useState<PreExaminationInstruction[]>([]);
  const [receipts, setReceipts] = useState<SampleReceiptRecord[]>([]);
  const [refIntervals, setRefIntervals] = useState<ReferenceIntervalRecord[]>([]);
  const [comparability, setComparability] = useState<ResultComparabilityStudy[]>([]);
  const [contingency, setContingency] = useState<ContingencyPlan[]>([]);

  const [preExamForm, setPreExamForm] = useState({ title: '', testCatalogId: '', sampleType: '', containerAdditive: '', patientPreparation: '', collectionInstructions: '', transportCondition: '', stabilitySummary: '', storageCondition: '', status: 'active', sectionId: '' });
  const [receiptForm, setReceiptForm] = useState({ receiptDate: '', receiptTime: '', requestReference: '', patientReference: '', patientType: '', sampleType: '', sectionId: '', testCatalogId: '', receivedByStaffId: '', condition: 'acceptable', conditionNotes: '', temperature: '', requestComplete: true, urgent: false });
  const [riForm, setRiForm] = useState({ testCatalogId: '', analyte: '', sampleType: '', population: '', lowerLimit: '', upperLimit: '', unit: '', clinicalDecisionLimit: '', source: '', effectiveDate: '', reviewDate: '', status: 'active', communicatedToUsers: false });
  const [cmpForm, setCmpForm] = useState({ studyDate: '', testName: '', analyte: '', methodA: '', methodB: '', sampleCount: '', acceptanceCriteria: '', outcome: '', findings: '', actionTaken: '', nextDueDate: '', status: 'open' });
  const [ctpForm, setCtpForm] = useState({ scenarioType: '', title: '', triggerDescription: '', responseActions: '', backupArrangement: '', responsibleStaffId: '', lastTestedDate: '', testOutcome: '', nextTestDue: '', status: 'active', notes: '' });

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
        apiRead<LabTestCatalog[]>('/process-management/tests', []),
        apiRead<SpecimenAcceptanceCriteria[]>('/process-management/acceptance-criteria', []),
        apiRead<SpecimenRejectionRecord[]>('/process-management/specimen-rejections', []),
        apiRead<CriticalResultRule[]>('/process-management/critical-result-rules', []),
        apiRead<CriticalResultNotification[]>('/process-management/critical-results', []),
        apiRead<ReferralLaboratory[]>('/process-management/referral-labs', []),
        apiRead<ReferralTest[]>('/process-management/referral-tests', []),
        apiRead<ReferralSendout[]>('/process-management/referral-sendouts', []),
        apiRead<ReportAmendmentLog[]>('/process-management/report-amendments', []),
        apiRead<ProcessReviewRecord[]>('/process-management/process-reviews', [])
      ]);
      if (sum) setSummary(sum);
      setTests(t); setCriteria(c); setRejections(rj); setRules(ru); setCriticals(cr);
      setLabs(lb); setRefTests(rt); setSendouts(so); setAmendments(am); setReviews(rv);
      const [px, rcp, ri, cmp, ctp] = await Promise.all([
        api<PreExaminationInstruction[]>('/process-management/pre-examination').catch(() => []),
        api<SampleReceiptRecord[]>('/process-management/sample-receipts').catch(() => []),
        api<ReferenceIntervalRecord[]>('/process-management/reference-intervals').catch(() => []),
        api<ResultComparabilityStudy[]>('/process-management/comparability').catch(() => []),
        api<ContingencyPlan[]>('/process-management/contingency-plans').catch(() => []),
      ]);
      setPreExam(px); setReceipts(rcp); setRefIntervals(ri); setComparability(cmp); setContingency(ctp);
    } catch (e) { setError(errorText(e)); }
  }
  useEffect(() => { if (isEnabled('process_management')) void load(); }, [isEnabled]);
  // A dashboard alert names the tab it wants; the phase bar that holds it only
  // renders once that tab is active, so the aim is taken here, above the
  // module-disabled return so the hook order never changes.
  useTabParam(ALL_PROCESS_TABS, setTab);

  if (!isEnabled('process_management')) return <DisabledModule />;

  async function post(path: string, body: any) { return api(path, { method: 'POST', body: JSON.stringify(body) }); }

  async function submitTest(e: FormEvent) { e.preventDefault(); setError(null); try { await post('/process-management/tests', testForm); setTestForm({ testCode: '', testName: '', departmentId: '', sectionId: '', sampleType: '', containerType: '', minimumVolume: '', methodName: '', methodSummary: '', tatTargetMinutes: '', reportableRange: '', referenceIntervalSummary: '', criticalResultApplicable: false, status: 'active' }); await load(); } catch (e) { setError(errorText(e)); } }
  async function toggleTest(id: number) { try { await post(`/process-management/tests/${id}/toggle`, {}); await load(); } catch (e) { setError(errorText(e)); } }
  async function submitCriteria(e: FormEvent) { e.preventDefault(); setError(null); try { await post('/process-management/acceptance-criteria', criteriaForm); setCriteriaForm({ criteriaCode: '', testCatalogId: '', sampleType: '', containerType: '', acceptanceCriteria: '', rejectionCriteria: '', transportCondition: '', stabilitySummary: '' }); await load(); } catch (e) { setError(errorText(e)); } }
  async function toggleCriteria(id: number) { try { await post(`/process-management/acceptance-criteria/${id}/toggle`, {}); await load(); } catch (e) { setError(errorText(e)); } }
  async function submitRejection(e: FormEvent) { e.preventDefault(); setError(null); try { await post('/process-management/specimen-rejections', rejectionForm); setRejectionForm({ rejectionDate: '', requestReference: '', patientReference: '', patientType: '', sectionId: '', testCatalogId: '', testName: '', sampleType: '', rejectionReason: '', communicatedTo: '', communicationDate: '', immediateAction: '', repeatSampleRequested: false }); await load(); } catch (e) { setError(errorText(e)); } }
  async function rejectionCreateNc(id: number) { try { await post(`/process-management/specimen-rejections/${id}/create-nc`, {}); await load(); } catch (e) { setError(errorText(e)); } }
  async function rejectionCreateAction(id: number) { const title = prompt('Action title?'); if (!title) return; try { await post(`/process-management/specimen-rejections/${id}/create-action`, { title }); await load(); } catch (e) { setError(errorText(e)); } }
  async function closeRejection(id: number) { try { await post(`/process-management/specimen-rejections/${id}/close`, {}); await load(); } catch (e) { setError(errorText(e)); } }
  async function submitRule(e: FormEvent) { e.preventDefault(); setError(null); try { await post('/process-management/critical-result-rules', ruleForm); setRuleForm({ ruleCode: '', testCatalogId: '', analyteName: '', unit: '', lowCriticalValue: '', highCriticalValue: '', notificationTimeframeMinutes: '', escalationInstruction: '' }); await load(); } catch (e) { setError(errorText(e)); } }
  async function toggleRule(id: number) { try { await post(`/process-management/critical-result-rules/${id}/toggle`, {}); await load(); } catch (e) { setError(errorText(e)); } }
  async function submitCritical(e: FormEvent) { e.preventDefault(); setError(null); try { await post('/process-management/critical-results', criticalForm); setCriticalForm({ eventDate: '', eventTime: '', requestReference: '', patientReference: '', patientType: '', sectionId: '', testCatalogId: '', analyteName: '', resultValue: '', unit: '', criticalRuleId: '', notifiedTo: '', notificationMethod: '', notificationTime: '', readBackConfirmed: false, escalationNotes: '' }); await load(); } catch (e) { setError(errorText(e)); } }
  async function ackCritical(id: number) { try { await post(`/process-management/critical-results/${id}/acknowledge`, {}); await load(); } catch (e) { setError(errorText(e)); } }
  async function criticalCreateNc(id: number) { try { await post(`/process-management/critical-results/${id}/create-nc`, {}); await load(); } catch (e) { setError(errorText(e)); } }
  async function criticalCreateAction(id: number) { const title = prompt('Action title?'); if (!title) return; try { await post(`/process-management/critical-results/${id}/create-action`, { title }); await load(); } catch (e) { setError(errorText(e)); } }
  async function closeCritical(id: number) { try { await post(`/process-management/critical-results/${id}/close`, {}); await load(); } catch (e) { setError(errorText(e)); } }
  async function submitLab(e: FormEvent) { e.preventDefault(); setError(null); try { await post('/process-management/referral-labs', labForm); setLabForm({ referralLabCode: '', referralLabName: '', contactPerson: '', phone: '', email: '', address: '', serviceScope: '', accreditationOrApprovalNote: '', status: 'active' }); await load(); } catch (e) { setError(errorText(e)); } }
  async function setLabStatus(id: number, status: string) { try { await post(`/process-management/referral-labs/${id}/status`, { status }); await load(); } catch (e) { setError(errorText(e)); } }
  async function submitRefTest(e: FormEvent) { e.preventDefault(); setError(null); try { await post('/process-management/referral-tests', refTestForm); setRefTestForm({ referralLabId: '', testCatalogId: '', referralTestName: '', sampleRequirement: '', expectedTatDays: '', transportCondition: '', costNote: '' }); await load(); } catch (e) { setError(errorText(e)); } }
  async function toggleRefTest(id: number) { try { await post(`/process-management/referral-tests/${id}/toggle`, {}); await load(); } catch (e) { setError(errorText(e)); } }
  async function submitSendout(e: FormEvent) { e.preventDefault(); setError(null); try { await post('/process-management/referral-sendouts', sendoutForm); setSendoutForm({ sendoutDate: '', referralLabId: '', referralTestId: '', requestReference: '', patientReference: '', patientType: '', sampleType: '', courierOrTransport: '', expectedReturnDate: '' }); await load(); } catch (e) { setError(errorText(e)); } }
  async function sendoutCreateNc(id: number) { try { await post(`/process-management/referral-sendouts/${id}/create-nc`, {}); await load(); } catch (e) { setError(errorText(e)); } }
  async function sendoutCreateAction(id: number) { const title = prompt('Action title?'); if (!title) return; try { await post(`/process-management/referral-sendouts/${id}/create-action`, { title }); await load(); } catch (e) { setError(errorText(e)); } }
  async function closeSendout(id: number) { try { await post(`/process-management/referral-sendouts/${id}/close`, {}); await load(); } catch (e) { setError(errorText(e)); } }
  async function submitAmendment(e: FormEvent) { e.preventDefault(); setError(null); try { await post('/process-management/report-amendments', amendmentForm); setAmendmentForm({ amendmentDate: '', requestReference: '', patientReference: '', patientType: '', sectionId: '', testCatalogId: '', reasonForAmendment: '', originalReportSummary: '', amendedReportSummary: '' }); await load(); } catch (e) { setError(errorText(e)); } }
  async function authorizeAmendment(id: number) { try { await post(`/process-management/report-amendments/${id}/authorize`, {}); await load(); } catch (e) { setError(errorText(e)); } }
  async function amendmentCreateNc(id: number) { try { await post(`/process-management/report-amendments/${id}/create-nc`, {}); await load(); } catch (e) { setError(errorText(e)); } }
  async function amendmentCreateAction(id: number) { const title = prompt('Action title?'); if (!title) return; try { await post(`/process-management/report-amendments/${id}/create-action`, { title }); await load(); } catch (e) { setError(errorText(e)); } }
  async function closeAmendment(id: number) { try { await post(`/process-management/report-amendments/${id}/close`, {}); await load(); } catch (e) { setError(errorText(e)); } }
  async function submitReview(e: FormEvent) { e.preventDefault(); setError(null); try { await post('/process-management/process-reviews', reviewForm); setReviewForm({ reviewPeriodStart: '', reviewPeriodEnd: '', departmentId: '', sectionId: '' }); await load(); } catch (e) { setError(errorText(e)); } }
  async function generateReviewSummary(id: number) { try { await post(`/process-management/process-reviews/${id}/generate-summary`, {}); await load(); } catch (e) { setError(errorText(e)); } }
  async function approveReview(id: number) { try { await post(`/process-management/process-reviews/${id}/approve`, {}); await load(); } catch (e) { setError(errorText(e)); } }
  async function closeReview(id: number) { try { await post(`/process-management/process-reviews/${id}/close`, {}); await load(); } catch (e) { setError(errorText(e)); } }

  async function submitPreExam(e: FormEvent) { e.preventDefault(); setError(null); try { await post('/process-management/pre-examination', preExamForm); setPreExamForm({ title: '', testCatalogId: '', sampleType: '', containerAdditive: '', patientPreparation: '', collectionInstructions: '', transportCondition: '', stabilitySummary: '', storageCondition: '', status: 'active', sectionId: '' }); await load(); } catch (e) { setError(errorText(e)); } }
  async function submitReceipt(e: FormEvent) { e.preventDefault(); setError(null); try { await post('/process-management/sample-receipts', receiptForm); setReceiptForm({ receiptDate: '', receiptTime: '', requestReference: '', patientReference: '', patientType: '', sampleType: '', sectionId: '', testCatalogId: '', receivedByStaffId: '', condition: 'acceptable', conditionNotes: '', temperature: '', requestComplete: true, urgent: false }); await load(); } catch (e) { setError(errorText(e)); } }
  async function rejectReceipt(id: number) { const reason = prompt('Rejection reason?'); if (!reason) return; try { await post(`/process-management/sample-receipts/${id}/reject`, { rejectionReason: reason }); await load(); setTab('Specimen Rejections'); } catch (e) { setError(errorText(e)); } }
  async function submitRi(e: FormEvent) { e.preventDefault(); setError(null); try { await post('/process-management/reference-intervals', riForm); setRiForm({ testCatalogId: '', analyte: '', sampleType: '', population: '', lowerLimit: '', upperLimit: '', unit: '', clinicalDecisionLimit: '', source: '', effectiveDate: '', reviewDate: '', status: 'active', communicatedToUsers: false }); await load(); } catch (e) { setError(errorText(e)); } }
  async function submitCmp(e: FormEvent) { e.preventDefault(); setError(null); try { await post('/process-management/comparability', cmpForm); setCmpForm({ studyDate: '', testName: '', analyte: '', methodA: '', methodB: '', sampleCount: '', acceptanceCriteria: '', outcome: '', findings: '', actionTaken: '', nextDueDate: '', status: 'open' }); await load(); } catch (e) { setError(errorText(e)); } }
  async function submitCtp(e: FormEvent) { e.preventDefault(); setError(null); try { await post('/process-management/contingency-plans', ctpForm); setCtpForm({ scenarioType: '', title: '', triggerDescription: '', responseActions: '', backupArrangement: '', responsibleStaffId: '', lastTestedDate: '', testOutcome: '', nextTestDue: '', status: 'active', notes: '' }); await load(); } catch (e) { setError(errorText(e)); } }

  const testName = (id?: number) => tests.find(t => t.id === id)?.test_name;

  // Process phases group the workflow the way the laboratory experiences it:
  // pre-examination (before testing), examination (the test itself and its
  // quality controls), post-examination (results, referrals, reporting), and
  // the specialised blood-banking service.
  const PRE_EXAM_TABS = ['Pre-Examination', 'Sample Receipt', 'Test Directory', 'Acceptance Criteria', 'Specimen Rejections'];
  const EXAM_TABS = ['Reference Intervals', 'Comparability',
    ...(isEnabled('iqc') ? ['IQC'] : []),
    ...(isEnabled('eqa') ? ['EQA'] : []),
    ...(isEnabled('verification_validation') ? ['Method Verification'] : []),
    ...(isEnabled('measurement_uncertainty') ? ['Measurement Uncertainty'] : []),
    ...(isEnabled('poct') ? ['POCT'] : []),
  ];
  const POST_EXAM_TABS = ['Critical Result Rules', 'Critical Notifications', 'Referral Labs', 'Referral Tests', 'Referral Sendouts', 'Report Amendments', 'Process Reviews', 'Contingency Plan'];
  const inPreExam = PRE_EXAM_TABS.includes(tab);
  const inExam = EXAM_TABS.includes(tab);
  const inPostExam = POST_EXAM_TABS.includes(tab);
  const topTabs: { key: string; active: boolean; go: () => void }[] = [
    { key: 'Dashboard', active: tab === 'Dashboard', go: () => setTab('Dashboard') },
    { key: 'Pre-examination', active: inPreExam, go: () => setTab(PRE_EXAM_TABS[0]) },
    { key: 'Examination', active: inExam, go: () => setTab(EXAM_TABS[0]) },
    { key: 'Post-examination', active: inPostExam, go: () => setTab(POST_EXAM_TABS[0]) },
    // Blood banking is its own module embedded here, so it takes its own right.
    ...(isEnabled('blood_bank_handover') && canView('blood_bank_handover') ? [{ key: 'Blood banking', active: tab === 'Blood banking', go: () => setTab('Blood banking') }] : []),
  ];

  return <div className="module-page">
    <PageHeader eyebrow="Process Management" title="Process Management" subtitle="Pre-examination, examination, post-examination, and blood banking." />
    <p className="muted">Patient testing and clinical result reporting stay in the primary information system. This module tracks the QMS workflow only — no patient names are required; use request and patient references as identifiers.</p>
    <div className="tabs">{topTabs.map(t => <button key={t.key} type="button" className={t.active ? 'active' : ''} onClick={t.go}>{t.key}</button>)}</div>
    {inPreExam && tabBar(tab, PRE_EXAM_TABS, setTab)}
    {inExam && tabBar(tab, EXAM_TABS, setTab)}
    {inPostExam && tabBar(tab, POST_EXAM_TABS, setTab)}
    {error && <Notice kind="error">{error}</Notice>}

    {tab === 'IQC' && <IqcPage embedded />}
    {tab === 'EQA' && <EqaPage embedded />}
    {tab === 'Method Verification' && <VerificationValidationPage embedded />}
    {tab === 'Measurement Uncertainty' && <MeasurementUncertaintyPage embedded />}
    {tab === 'POCT' && <POCTPage embedded />}
    {tab === 'Blood banking' && <BloodBankHandoverPage embedded />}

    {tab === 'Dashboard' && <ModuleAlerts moduleKey="process_management" />}
    {tab === 'Dashboard' && (summary ? <KpiStrip items={[
      { label: 'Active tests', value: summary.activeTests, onClick: () => setTab('Test Directory') },
      { label: 'Sample receipts (month)', value: summary.sampleReceiptsThisMonth ?? 0, onClick: () => setTab('Sample Receipt') },
      { label: 'Open rejections', value: summary.openSpecimenRejections, tone: 'warning', onClick: () => setTab('Specimen Rejections') },
      { label: 'Delayed critical notifs', value: summary.delayedCriticalNotifications, tone: 'danger', onClick: () => setTab('Critical Notifications') },
      { label: 'Ref. intervals due', value: summary.referenceIntervalsDueReview ?? 0, onClick: () => setTab('Reference Intervals') },
      { label: 'Comparability due', value: summary.comparabilityStudiesDue ?? 0, onClick: () => setTab('Comparability') },
      { label: 'Contingency tests due', value: summary.contingencyTestsDue ?? 0, tone: (summary.contingencyTestsDue ?? 0) ? 'warning' : undefined, onClick: () => setTab('Contingency Plan') },
      { label: 'Pending reviews', value: summary.pendingProcessReviews, onClick: () => setTab('Process Reviews') },
    ]} /> : <p>Loading summary…</p>)}
    {tab === 'Dashboard' && summary && <div className="grid cols-3 dash-charts" style={{ marginTop: 18 }}>
      <ChartCard title="Pre-analytical quality" subtitle="Specimen rejection handling this month">
        <DonutChart centerLabel="Rejections" data={[
          { label: 'Resolved', value: Math.max(0, summary.specimenRejectionsThisMonth - summary.openSpecimenRejections), color: CHART_COLORS[1], onClick: () => setTab('Specimen Rejections') },
          { label: 'Open', value: summary.openSpecimenRejections, color: CHART_COLORS[3], onClick: () => setTab('Specimen Rejections') },
        ]} />
      </ChartCard>
      <ChartCard title="Turnaround risks" subtitle="Critical results, referrals and amendments">
        <BarMeter data={[
          { label: 'Delayed critical notifs', value: summary.delayedCriticalNotifications, color: CHART_COLORS[3], onClick: () => setTab('Critical Notifications') },
          { label: 'Referral sendouts pending', value: summary.referralSendoutsPending, color: CHART_COLORS[0], onClick: () => setTab('Referral Sendouts') },
          { label: 'Delayed sendouts', value: summary.delayedReferralSendouts, color: CHART_COLORS[2], onClick: () => setTab('Referral Sendouts') },
          { label: 'Report amendments (month)', value: summary.reportAmendmentsThisMonth, color: CHART_COLORS[4], onClick: () => setTab('Report Amendments') },
        ]} />
      </ChartCard>
      <ChartCard title="Result validity & continuity" subtitle="Reference intervals, comparability, contingency">
        <BarMeter data={[
          { label: 'Ref. intervals due review', value: summary.referenceIntervalsDueReview ?? 0, color: CHART_COLORS[2], onClick: () => setTab('Reference Intervals') },
          { label: 'Comparability due', value: summary.comparabilityStudiesDue ?? 0, color: CHART_COLORS[0], onClick: () => setTab('Comparability') },
          { label: 'Comparability issues', value: summary.openComparabilityIssues ?? 0, color: CHART_COLORS[3], onClick: () => setTab('Comparability') },
          { label: 'Contingency tests due', value: summary.contingencyTestsDue ?? 0, color: CHART_COLORS[4], onClick: () => setTab('Contingency Plan') },
        ]} />
      </ChartCard>
    </div>}

    {tab === 'Pre-Examination' && <>
      <form className="form-grid" onSubmit={submitPreExam}>
        <label>Title<TextField value={preExamForm.title} onValue={nextValue => setPreExamForm({ ...preExamForm, title: nextValue })} required /></label>
        <label>Test<select value={preExamForm.testCatalogId} onChange={e => setPreExamForm({ ...preExamForm, testCatalogId: e.target.value })}><option value="">—</option>{tests.map(t => <option key={t.id} value={t.id}>{t.test_name}</option>)}</select></label>
        <label>Sample type<TextField value={preExamForm.sampleType} onValue={nextValue => setPreExamForm({ ...preExamForm, sampleType: nextValue })} /></label>
        <label>Container / additive<TextField value={preExamForm.containerAdditive} onValue={nextValue => setPreExamForm({ ...preExamForm, containerAdditive: nextValue })} /></label>
        <label>Transport condition<TextField value={preExamForm.transportCondition} onValue={nextValue => setPreExamForm({ ...preExamForm, transportCondition: nextValue })} /></label>
        <label>Storage condition<TextField value={preExamForm.storageCondition} onValue={nextValue => setPreExamForm({ ...preExamForm, storageCondition: nextValue })} /></label>
        <label>Section<select value={preExamForm.sectionId} onChange={e => setPreExamForm({ ...preExamForm, sectionId: e.target.value })}><option value="">—</option>{sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label>Status<select value={preExamForm.status} onChange={e => setPreExamForm({ ...preExamForm, status: e.target.value })}>{['active', 'under_review', 'archived'].map(s => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}</select></label>
        <label>Patient preparation<TextField as="textarea" value={preExamForm.patientPreparation} onValue={nextValue => setPreExamForm({ ...preExamForm, patientPreparation: nextValue })} /></label>
        <label>Collection instructions<TextField as="textarea" value={preExamForm.collectionInstructions} onValue={nextValue => setPreExamForm({ ...preExamForm, collectionInstructions: nextValue })} /></label>
        <label>Stability summary<TextField as="textarea" value={preExamForm.stabilitySummary} onValue={nextValue => setPreExamForm({ ...preExamForm, stabilitySummary: nextValue })} /></label>
        <button type="submit">Add instruction</button>
      </form>
      <table className="data-table"><thead><tr><th>No.</th><th>Title</th><th>Test</th><th>Sample</th><th>Container</th><th>Transport</th><th>Status</th></tr></thead><tbody>
        {preExam.map(p => <tr key={p.id}><td>{p.instruction_number}</td><td>{p.title}</td><td>{testName(p.test_catalog_id) || '—'}</td><td>{p.sample_type || '—'}</td><td>{p.container_additive || '—'}</td><td>{p.transport_condition || '—'}</td><td>{formatBadge(p.status)}</td></tr>)}
        {preExam.length === 0 && <tr><td colSpan={7}>No collection instructions yet.</td></tr>}
      </tbody></table>
    </>}

    {tab === 'Sample Receipt' && <>
      <form className="form-grid" onSubmit={submitReceipt}>
        <label>Receipt date<input type="date" value={receiptForm.receiptDate} onChange={e => setReceiptForm({ ...receiptForm, receiptDate: e.target.value })} required /></label>
        <label>Time<input type="time" value={receiptForm.receiptTime} onChange={e => setReceiptForm({ ...receiptForm, receiptTime: e.target.value })} /></label>
        <label>Request reference<TextField value={receiptForm.requestReference} onValue={nextValue => setReceiptForm({ ...receiptForm, requestReference: nextValue })} /></label>
        <label>Patient reference<TextField value={receiptForm.patientReference} onValue={nextValue => setReceiptForm({ ...receiptForm, patientReference: nextValue })} /></label>
        <label>Sample type<TextField value={receiptForm.sampleType} onValue={nextValue => setReceiptForm({ ...receiptForm, sampleType: nextValue })} /></label>
        <label>Section<select value={receiptForm.sectionId} onChange={e => setReceiptForm({ ...receiptForm, sectionId: e.target.value })}><option value="">—</option>{sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label>Received by<select value={receiptForm.receivedByStaffId} onChange={e => setReceiptForm({ ...receiptForm, receivedByStaffId: e.target.value })}><option value="">Me</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
        <label>Condition<select value={receiptForm.condition} onChange={e => setReceiptForm({ ...receiptForm, condition: e.target.value })}>{['acceptable', 'suboptimal', 'rejected'].map(c => <option key={c} value={c}>{c}</option>)}</select></label>
        <label>Temperature<TextField value={receiptForm.temperature} onValue={nextValue => setReceiptForm({ ...receiptForm, temperature: nextValue })} /></label>
        <label><input type="checkbox" checked={receiptForm.requestComplete} onChange={e => setReceiptForm({ ...receiptForm, requestComplete: e.target.checked })} /> Request form complete</label>
        <label><input type="checkbox" checked={receiptForm.urgent} onChange={e => setReceiptForm({ ...receiptForm, urgent: e.target.checked })} /> Urgent</label>
        <label>Condition notes<TextField as="textarea" value={receiptForm.conditionNotes} onValue={nextValue => setReceiptForm({ ...receiptForm, conditionNotes: nextValue })} /></label>
        <button type="submit">Log receipt</button>
      </form>
      <div style={{ margin: '4px 0 10px' }}><BarcodeScanner placeholder="Scan a specimen barcode (request ref / receipt no.)…" autoFocus={false} onScan={code => { const c = code.trim().toLowerCase(); const m = receipts.find(x => (x.request_reference || '').toLowerCase() === c || x.receipt_number.toLowerCase() === c); setError(m ? `Specimen ${m.receipt_number} — ${m.sample_type || ''} (${m.condition})` : `No specimen found for "${code}".`); }} /></div>
      <table className="data-table"><thead><tr><th>No.</th><th>Date</th><th>Request</th><th>Sample</th><th>Condition</th><th>Complete?</th><th></th></tr></thead><tbody>
        {receipts.map(r => { const val = r.request_reference || r.receipt_number; return <tr key={r.id}><td>{r.receipt_number}</td><td>{r.receipt_date}</td><td>{r.request_reference || '—'}</td><td>{r.sample_type || '—'}</td><td>{formatBadge(r.condition)}</td><td>{r.request_complete ? 'Yes' : 'No'}</td><td><button className="secondary" onClick={() => printLabelSheet([{ barcodeValue: val, title: r.sample_type || 'Specimen', lines: [val, r.receipt_date + (r.receipt_time ? ` ${r.receipt_time}` : ''), r.receipt_number].filter(Boolean) }], { widthMm: 60, heightMm: 30, copies: 2, title: `Specimen label — ${r.receipt_number}` })}>Label</button> {r.condition !== 'rejected' && !r.rejection_id && <button onClick={() => rejectReceipt(r.id)}>Reject</button>}</td></tr>; })}
        {receipts.length === 0 && <tr><td colSpan={7}>No sample receipts logged.</td></tr>}
      </tbody></table>
    </>}

    {tab === 'Reference Intervals' && <>
      <XlsxToolbar module="process_management.intervals" exportPath="/process-management/reference-intervals/export" templatePath="/process-management/reference-intervals/template" importPath="/process-management/reference-intervals/import" exportName="Reference_Intervals.xlsx" onImported={load} />
      <form className="form-grid" onSubmit={submitRi}>
        <label>Test<select value={riForm.testCatalogId} onChange={e => setRiForm({ ...riForm, testCatalogId: e.target.value })}><option value="">—</option>{tests.map(t => <option key={t.id} value={t.id}>{t.test_name}</option>)}</select></label>
        <label>Analyte<TextField value={riForm.analyte} onValue={nextValue => setRiForm({ ...riForm, analyte: nextValue })} required /></label>
        <label>Sample type<TextField value={riForm.sampleType} onValue={nextValue => setRiForm({ ...riForm, sampleType: nextValue })} /></label>
        <label>Population<TextField value={riForm.population} onValue={nextValue => setRiForm({ ...riForm, population: nextValue })} placeholder="e.g. adult male" /></label>
        <label>Lower limit<TextField value={riForm.lowerLimit} onValue={nextValue => setRiForm({ ...riForm, lowerLimit: nextValue })} /></label>
        <label>Upper limit<TextField value={riForm.upperLimit} onValue={nextValue => setRiForm({ ...riForm, upperLimit: nextValue })} /></label>
        <label>Unit<TextField value={riForm.unit} onValue={nextValue => setRiForm({ ...riForm, unit: nextValue })} /></label>
        <label>Clinical decision limit<TextField value={riForm.clinicalDecisionLimit} onValue={nextValue => setRiForm({ ...riForm, clinicalDecisionLimit: nextValue })} /></label>
        <label>Source<TextField value={riForm.source} onValue={nextValue => setRiForm({ ...riForm, source: nextValue })} placeholder="manufacturer / literature / in-house" /></label>
        <label>Effective date<input type="date" value={riForm.effectiveDate} onChange={e => setRiForm({ ...riForm, effectiveDate: e.target.value })} /></label>
        <label>Review date<input type="date" value={riForm.reviewDate} onChange={e => setRiForm({ ...riForm, reviewDate: e.target.value })} /></label>
        <label><input type="checkbox" checked={riForm.communicatedToUsers} onChange={e => setRiForm({ ...riForm, communicatedToUsers: e.target.checked })} /> Communicated to users</label>
        <button type="submit">Add reference interval</button>
      </form>
      <table className="data-table"><thead><tr><th>No.</th><th>Analyte</th><th>Population</th><th>Range</th><th>Unit</th><th>Source</th><th>Review</th><th>Status</th></tr></thead><tbody>
        {refIntervals.map(r => <tr key={r.id}><td>{r.record_number}</td><td>{r.analyte}</td><td>{r.population || '—'}</td><td>{(r.lower_limit || '') + ' – ' + (r.upper_limit || '')}</td><td>{r.unit || '—'}</td><td>{r.source || '—'}</td><td>{r.review_date || '—'}</td><td>{formatBadge(r.status)}</td></tr>)}
        {refIntervals.length === 0 && <tr><td colSpan={8}>No reference intervals recorded.</td></tr>}
      </tbody></table>
    </>}

    {tab === 'Comparability' && <>
      <form className="form-grid" onSubmit={submitCmp}>
        <label>Study date<input type="date" value={cmpForm.studyDate} onChange={e => setCmpForm({ ...cmpForm, studyDate: e.target.value })} required /></label>
        <label>Test name<TextField value={cmpForm.testName} onValue={nextValue => setCmpForm({ ...cmpForm, testName: nextValue })} /></label>
        <label>Analyte<TextField value={cmpForm.analyte} onValue={nextValue => setCmpForm({ ...cmpForm, analyte: nextValue })} /></label>
        <label>Method / analyser A<TextField value={cmpForm.methodA} onValue={nextValue => setCmpForm({ ...cmpForm, methodA: nextValue })} /></label>
        <label>Method / analyser B<TextField value={cmpForm.methodB} onValue={nextValue => setCmpForm({ ...cmpForm, methodB: nextValue })} /></label>
        <label>Sample count<input type="number" value={cmpForm.sampleCount} onChange={e => setCmpForm({ ...cmpForm, sampleCount: e.target.value })} /></label>
        <label>Outcome<select value={cmpForm.outcome} onChange={e => setCmpForm({ ...cmpForm, outcome: e.target.value })}><option value="">—</option><option value="comparable">Comparable</option><option value="significant_difference">Significant difference</option><option value="inconclusive">Inconclusive</option></select></label>
        <label>Next due date<input type="date" value={cmpForm.nextDueDate} onChange={e => setCmpForm({ ...cmpForm, nextDueDate: e.target.value })} /></label>
        <label>Acceptance criteria<TextField as="textarea" value={cmpForm.acceptanceCriteria} onValue={nextValue => setCmpForm({ ...cmpForm, acceptanceCriteria: nextValue })} /></label>
        <label>Findings<TextField as="textarea" value={cmpForm.findings} onValue={nextValue => setCmpForm({ ...cmpForm, findings: nextValue })} /></label>
        <label>Action taken<TextField as="textarea" value={cmpForm.actionTaken} onValue={nextValue => setCmpForm({ ...cmpForm, actionTaken: nextValue })} /></label>
        <button type="submit">Record study</button>
      </form>
      <table className="data-table"><thead><tr><th>No.</th><th>Date</th><th>Test</th><th>A vs B</th><th>Samples</th><th>Outcome</th><th>Next due</th><th>Status</th></tr></thead><tbody>
        {comparability.map(c => <tr key={c.id}><td>{c.study_number}</td><td>{c.study_date}</td><td>{c.test_name || c.analyte || '—'}</td><td>{(c.method_a || '?') + ' vs ' + (c.method_b || '?')}</td><td>{c.sample_count ?? '—'}</td><td>{c.outcome ? c.outcome.replace(/_/g, ' ') : '—'}</td><td>{c.next_due_date || '—'}</td><td>{formatBadge(c.status)}</td></tr>)}
        {comparability.length === 0 && <tr><td colSpan={8}>No comparability studies recorded.</td></tr>}
      </tbody></table>
    </>}

    {tab === 'Contingency Plan' && <>
      <form className="form-grid" onSubmit={submitCtp}>
        <label>Scenario<select value={ctpForm.scenarioType} onChange={e => setCtpForm({ ...ctpForm, scenarioType: e.target.value })}><option value="">—</option>{['personnel', 'equipment', 'power', 'reagent_stockout', 'fire_disaster', 'lis_downtime', 'other'].map(s => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}</select></label>
        <label>Title<TextField value={ctpForm.title} onValue={nextValue => setCtpForm({ ...ctpForm, title: nextValue })} required /></label>
        <label>Responsible staff<select value={ctpForm.responsibleStaffId} onChange={e => setCtpForm({ ...ctpForm, responsibleStaffId: e.target.value })}><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
        <label>Status<select value={ctpForm.status} onChange={e => setCtpForm({ ...ctpForm, status: e.target.value })}>{['draft', 'active', 'under_review', 'retired'].map(s => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}</select></label>
        <label>Last tested<input type="date" value={ctpForm.lastTestedDate} onChange={e => setCtpForm({ ...ctpForm, lastTestedDate: e.target.value })} /></label>
        <label>Next test due<input type="date" value={ctpForm.nextTestDue} onChange={e => setCtpForm({ ...ctpForm, nextTestDue: e.target.value })} /></label>
        <label>Trigger description<TextField as="textarea" value={ctpForm.triggerDescription} onValue={nextValue => setCtpForm({ ...ctpForm, triggerDescription: nextValue })} /></label>
        <label>Response actions<TextField as="textarea" value={ctpForm.responseActions} onValue={nextValue => setCtpForm({ ...ctpForm, responseActions: nextValue })} /></label>
        <label>Backup arrangement<TextField as="textarea" value={ctpForm.backupArrangement} onValue={nextValue => setCtpForm({ ...ctpForm, backupArrangement: nextValue })} /></label>
        <label>Test outcome<TextField as="textarea" value={ctpForm.testOutcome} onValue={nextValue => setCtpForm({ ...ctpForm, testOutcome: nextValue })} /></label>
        <button type="submit">Add plan</button>
      </form>
      <table className="data-table"><thead><tr><th>No.</th><th>Scenario</th><th>Title</th><th>Responsible</th><th>Last tested</th><th>Next test</th><th>Status</th></tr></thead><tbody>
        {contingency.map(c => <tr key={c.id}><td>{c.plan_number}</td><td>{c.scenario_type ? c.scenario_type.replace(/_/g, ' ') : '—'}</td><td>{c.title}</td><td>{staff.find(s => s.id === c.responsible_staff_id)?.fullName || '—'}</td><td>{c.last_tested_date || '—'}</td><td>{c.next_test_due || '—'}</td><td>{formatBadge(c.status)}</td></tr>)}
        {contingency.length === 0 && <tr><td colSpan={7}>No contingency plans recorded.</td></tr>}
      </tbody></table>
    </>}

    {tab === 'Test Directory' && <>
      <form className="form-grid" onSubmit={submitTest}>
        <label>Code<TextField value={testForm.testCode} onValue={nextValue => setTestForm({ ...testForm, testCode: nextValue })} /></label>
        <label>Test name<TextField value={testForm.testName} onValue={nextValue => setTestForm({ ...testForm, testName: nextValue })} required /></label>
        <label>Department<select value={testForm.departmentId} onChange={e => setTestForm({ ...testForm, departmentId: e.target.value })}><option value="">—</option>{departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
        <label>Section<select value={testForm.sectionId} onChange={e => setTestForm({ ...testForm, sectionId: e.target.value })}><option value="">—</option>{sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label>Sample type<TextField value={testForm.sampleType} onValue={nextValue => setTestForm({ ...testForm, sampleType: nextValue })} required /></label>
        <label>Container<TextField value={testForm.containerType} onValue={nextValue => setTestForm({ ...testForm, containerType: nextValue })} /></label>
        <label>Min volume<TextField value={testForm.minimumVolume} onValue={nextValue => setTestForm({ ...testForm, minimumVolume: nextValue })} /></label>
        <label>Method name<TextField value={testForm.methodName} onValue={nextValue => setTestForm({ ...testForm, methodName: nextValue })} /></label>
        <label>TAT target (minutes)<input type="number" value={testForm.tatTargetMinutes} onChange={e => setTestForm({ ...testForm, tatTargetMinutes: e.target.value })} /></label>
        <label>Reportable range<TextField value={testForm.reportableRange} onValue={nextValue => setTestForm({ ...testForm, reportableRange: nextValue })} /></label>
        <label>Reference interval<TextField value={testForm.referenceIntervalSummary} onValue={nextValue => setTestForm({ ...testForm, referenceIntervalSummary: nextValue })} /></label>
        <label>Method summary<TextField as="textarea" value={testForm.methodSummary} onValue={nextValue => setTestForm({ ...testForm, methodSummary: nextValue })} /></label>
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
        <label>Code<TextField value={criteriaForm.criteriaCode} onValue={nextValue => setCriteriaForm({ ...criteriaForm, criteriaCode: nextValue })} /></label>
        <label>Test<select value={criteriaForm.testCatalogId} onChange={e => setCriteriaForm({ ...criteriaForm, testCatalogId: e.target.value })}><option value="">—</option>{tests.map(t => <option key={t.id} value={t.id}>{t.test_name}</option>)}</select></label>
        <label>Sample type<TextField value={criteriaForm.sampleType} onValue={nextValue => setCriteriaForm({ ...criteriaForm, sampleType: nextValue })} required /></label>
        <label>Container<TextField value={criteriaForm.containerType} onValue={nextValue => setCriteriaForm({ ...criteriaForm, containerType: nextValue })} /></label>
        <label>Acceptance criteria<TextField as="textarea" value={criteriaForm.acceptanceCriteria} onValue={nextValue => setCriteriaForm({ ...criteriaForm, acceptanceCriteria: nextValue })} required /></label>
        <label>Rejection criteria<TextField as="textarea" value={criteriaForm.rejectionCriteria} onValue={nextValue => setCriteriaForm({ ...criteriaForm, rejectionCriteria: nextValue })} /></label>
        <label>Transport condition<TextField value={criteriaForm.transportCondition} onValue={nextValue => setCriteriaForm({ ...criteriaForm, transportCondition: nextValue })} /></label>
        <label>Stability summary<TextField value={criteriaForm.stabilitySummary} onValue={nextValue => setCriteriaForm({ ...criteriaForm, stabilitySummary: nextValue })} /></label>
        <button type="submit">Add criteria</button>
      </form>
      <table className="data-table"><thead><tr><th>Code</th><th>Sample</th><th>Container</th><th>Acceptance</th><th>Active</th><th></th></tr></thead><tbody>
        {criteria.map(c => <tr key={c.id}><td>{c.criteria_code || '—'}</td><td>{c.sample_type}</td><td>{c.container_type || '—'}</td><td>{c.acceptance_criteria}</td><td>{c.is_active ? 'Yes' : 'No'}</td><td><button onClick={() => toggleCriteria(c.id)}>Toggle</button></td></tr>)}
      </tbody></table>
    </>}

    {tab === 'Specimen Rejections' && <>
      <form className="form-grid" onSubmit={submitRejection}>
        <label>Rejection date<input type="date" value={rejectionForm.rejectionDate} onChange={e => setRejectionForm({ ...rejectionForm, rejectionDate: e.target.value })} required /></label>
        <label>Request reference<TextField value={rejectionForm.requestReference} onValue={nextValue => setRejectionForm({ ...rejectionForm, requestReference: nextValue })} /></label>
        <label>Patient reference<TextField value={rejectionForm.patientReference} onValue={nextValue => setRejectionForm({ ...rejectionForm, patientReference: nextValue })} /></label>
        <label>Patient type<TextField value={rejectionForm.patientType} onValue={nextValue => setRejectionForm({ ...rejectionForm, patientType: nextValue })} placeholder="e.g. OPD, IPD" /></label>
        <label>Section<select value={rejectionForm.sectionId} onChange={e => setRejectionForm({ ...rejectionForm, sectionId: e.target.value })}><option value="">—</option>{sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label>Test<select value={rejectionForm.testCatalogId} onChange={e => setRejectionForm({ ...rejectionForm, testCatalogId: e.target.value })}><option value="">—</option>{tests.map(t => <option key={t.id} value={t.id}>{t.test_name}</option>)}</select></label>
        <label>Test name (free text)<TextField value={rejectionForm.testName} onValue={nextValue => setRejectionForm({ ...rejectionForm, testName: nextValue })} /></label>
        <label>Sample type<TextField value={rejectionForm.sampleType} onValue={nextValue => setRejectionForm({ ...rejectionForm, sampleType: nextValue })} /></label>
        <label>Rejection reason<TextField as="textarea" value={rejectionForm.rejectionReason} onValue={nextValue => setRejectionForm({ ...rejectionForm, rejectionReason: nextValue })} required /></label>
        <label>Communicated to<TextField value={rejectionForm.communicatedTo} onValue={nextValue => setRejectionForm({ ...rejectionForm, communicatedTo: nextValue })} /></label>
        <label>Communication date<input type="date" value={rejectionForm.communicationDate} onChange={e => setRejectionForm({ ...rejectionForm, communicationDate: e.target.value })} /></label>
        <label>Immediate action<TextField value={rejectionForm.immediateAction} onValue={nextValue => setRejectionForm({ ...rejectionForm, immediateAction: nextValue })} /></label>
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
        <label>Code<TextField value={ruleForm.ruleCode} onValue={nextValue => setRuleForm({ ...ruleForm, ruleCode: nextValue })} /></label>
        <label>Test<select value={ruleForm.testCatalogId} onChange={e => setRuleForm({ ...ruleForm, testCatalogId: e.target.value })} required><option value="">—</option>{tests.map(t => <option key={t.id} value={t.id}>{t.test_name}</option>)}</select></label>
        <label>Analyte<TextField value={ruleForm.analyteName} onValue={nextValue => setRuleForm({ ...ruleForm, analyteName: nextValue })} required /></label>
        <label>Unit<TextField value={ruleForm.unit} onValue={nextValue => setRuleForm({ ...ruleForm, unit: nextValue })} /></label>
        <label>Low critical<input type="number" step="any" value={ruleForm.lowCriticalValue} onChange={e => setRuleForm({ ...ruleForm, lowCriticalValue: e.target.value })} /></label>
        <label>High critical<input type="number" step="any" value={ruleForm.highCriticalValue} onChange={e => setRuleForm({ ...ruleForm, highCriticalValue: e.target.value })} /></label>
        <label>Notification timeframe (min)<input type="number" value={ruleForm.notificationTimeframeMinutes} onChange={e => setRuleForm({ ...ruleForm, notificationTimeframeMinutes: e.target.value })} /></label>
        <label>Escalation instruction<TextField as="textarea" value={ruleForm.escalationInstruction} onValue={nextValue => setRuleForm({ ...ruleForm, escalationInstruction: nextValue })} /></label>
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
        <label>Request reference<TextField value={criticalForm.requestReference} onValue={nextValue => setCriticalForm({ ...criticalForm, requestReference: nextValue })} /></label>
        <label>Patient reference<TextField value={criticalForm.patientReference} onValue={nextValue => setCriticalForm({ ...criticalForm, patientReference: nextValue })} /></label>
        <label>Patient type<TextField value={criticalForm.patientType} onValue={nextValue => setCriticalForm({ ...criticalForm, patientType: nextValue })} placeholder="e.g. OPD, IPD" /></label>
        <label>Test<select value={criticalForm.testCatalogId} onChange={e => setCriticalForm({ ...criticalForm, testCatalogId: e.target.value })}><option value="">—</option>{tests.map(t => <option key={t.id} value={t.id}>{t.test_name}</option>)}</select></label>
        <label>Analyte<TextField value={criticalForm.analyteName} onValue={nextValue => setCriticalForm({ ...criticalForm, analyteName: nextValue })} required /></label>
        <label>Result value<TextField value={criticalForm.resultValue} onValue={nextValue => setCriticalForm({ ...criticalForm, resultValue: nextValue })} required /></label>
        <label>Unit<TextField value={criticalForm.unit} onValue={nextValue => setCriticalForm({ ...criticalForm, unit: nextValue })} /></label>
        <label>Critical rule<select value={criticalForm.criticalRuleId} onChange={e => setCriticalForm({ ...criticalForm, criticalRuleId: e.target.value })}><option value="">—</option>{rules.map(r => <option key={r.id} value={r.id}>{r.analyte_name} ({r.rule_code || `#${r.id}`})</option>)}</select></label>
        <label>Notified to<TextField value={criticalForm.notifiedTo} onValue={nextValue => setCriticalForm({ ...criticalForm, notifiedTo: nextValue })} /></label>
        <label>Notification method<TextField value={criticalForm.notificationMethod} onValue={nextValue => setCriticalForm({ ...criticalForm, notificationMethod: nextValue })} placeholder="e.g. phone, in person" /></label>
        <label>Notification time<input type="time" value={criticalForm.notificationTime} onChange={e => setCriticalForm({ ...criticalForm, notificationTime: e.target.value })} /></label>
        <label><input type="checkbox" checked={criticalForm.readBackConfirmed} onChange={e => setCriticalForm({ ...criticalForm, readBackConfirmed: e.target.checked })} /> Read-back confirmed</label>
        <label>Escalation notes<TextField as="textarea" value={criticalForm.escalationNotes} onValue={nextValue => setCriticalForm({ ...criticalForm, escalationNotes: nextValue })} /></label>
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
        <label>Code<TextField value={labForm.referralLabCode} onValue={nextValue => setLabForm({ ...labForm, referralLabCode: nextValue })} /></label>
        <label>Lab name<TextField value={labForm.referralLabName} onValue={nextValue => setLabForm({ ...labForm, referralLabName: nextValue })} required /></label>
        <label>Contact person<TextField value={labForm.contactPerson} onValue={nextValue => setLabForm({ ...labForm, contactPerson: nextValue })} /></label>
        <label>Phone<TextField value={labForm.phone} onValue={nextValue => setLabForm({ ...labForm, phone: nextValue })} /></label>
        <label>Email<TextField value={labForm.email} onValue={nextValue => setLabForm({ ...labForm, email: nextValue })} /></label>
        <label>Address<TextField value={labForm.address} onValue={nextValue => setLabForm({ ...labForm, address: nextValue })} /></label>
        <label>Service scope<TextField value={labForm.serviceScope} onValue={nextValue => setLabForm({ ...labForm, serviceScope: nextValue })} /></label>
        <label>Accreditation/approval<TextField value={labForm.accreditationOrApprovalNote} onValue={nextValue => setLabForm({ ...labForm, accreditationOrApprovalNote: nextValue })} placeholder="Lab-recorded note only; not an official scoring claim" /></label>
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
        <label>Referral test name<TextField value={refTestForm.referralTestName} onValue={nextValue => setRefTestForm({ ...refTestForm, referralTestName: nextValue })} required /></label>
        <label>Sample requirement<TextField value={refTestForm.sampleRequirement} onValue={nextValue => setRefTestForm({ ...refTestForm, sampleRequirement: nextValue })} /></label>
        <label>Expected TAT (days)<input type="number" value={refTestForm.expectedTatDays} onChange={e => setRefTestForm({ ...refTestForm, expectedTatDays: e.target.value })} /></label>
        <label>Transport condition<TextField value={refTestForm.transportCondition} onValue={nextValue => setRefTestForm({ ...refTestForm, transportCondition: nextValue })} /></label>
        <label>Cost note<TextField value={refTestForm.costNote} onValue={nextValue => setRefTestForm({ ...refTestForm, costNote: nextValue })} /></label>
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
        <label>Request reference<TextField value={sendoutForm.requestReference} onValue={nextValue => setSendoutForm({ ...sendoutForm, requestReference: nextValue })} /></label>
        <label>Patient reference<TextField value={sendoutForm.patientReference} onValue={nextValue => setSendoutForm({ ...sendoutForm, patientReference: nextValue })} /></label>
        <label>Patient type<TextField value={sendoutForm.patientType} onValue={nextValue => setSendoutForm({ ...sendoutForm, patientType: nextValue })} placeholder="e.g. OPD, IPD" /></label>
        <label>Sample type<TextField value={sendoutForm.sampleType} onValue={nextValue => setSendoutForm({ ...sendoutForm, sampleType: nextValue })} /></label>
        <label>Courier/transport<TextField value={sendoutForm.courierOrTransport} onValue={nextValue => setSendoutForm({ ...sendoutForm, courierOrTransport: nextValue })} /></label>
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
        <label>Request reference<TextField value={amendmentForm.requestReference} onValue={nextValue => setAmendmentForm({ ...amendmentForm, requestReference: nextValue })} /></label>
        <label>Patient reference<TextField value={amendmentForm.patientReference} onValue={nextValue => setAmendmentForm({ ...amendmentForm, patientReference: nextValue })} /></label>
        <label>Patient type<TextField value={amendmentForm.patientType} onValue={nextValue => setAmendmentForm({ ...amendmentForm, patientType: nextValue })} /></label>
        <label>Section<select value={amendmentForm.sectionId} onChange={e => setAmendmentForm({ ...amendmentForm, sectionId: e.target.value })}><option value="">—</option>{sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label>Test<select value={amendmentForm.testCatalogId} onChange={e => setAmendmentForm({ ...amendmentForm, testCatalogId: e.target.value })}><option value="">—</option>{tests.map(t => <option key={t.id} value={t.id}>{t.test_name}</option>)}</select></label>
        <label>Reason for amendment<TextField as="textarea" value={amendmentForm.reasonForAmendment} onValue={nextValue => setAmendmentForm({ ...amendmentForm, reasonForAmendment: nextValue })} required /></label>
        <label>Original report summary<TextField as="textarea" value={amendmentForm.originalReportSummary} onValue={nextValue => setAmendmentForm({ ...amendmentForm, originalReportSummary: nextValue })} /></label>
        <label>Amended report summary<TextField as="textarea" value={amendmentForm.amendedReportSummary} onValue={nextValue => setAmendmentForm({ ...amendmentForm, amendedReportSummary: nextValue })} /></label>
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

