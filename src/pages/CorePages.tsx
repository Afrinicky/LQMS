import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../services/api';
import DisabledModule from '../components/DisabledModule';
import { useModules } from '../hooks/useModules';

type CountRow = { count: number };
type AnyRec = Record<string, any>;

async function safeGet<T = AnyRec>(path: string): Promise<T | null> {
  try { return await api<T>(path); } catch { return null; }
}

function Metric({ label, value, hint }: { label: string; value: unknown; hint?: string }) {
  return <div className="card metric"><span>{label}</span><br/><strong>{value === null || value === undefined ? '—' : String(value)}</strong>{hint && <div style={{ fontSize: 11, color: 'var(--muted, #888)' }}>{hint}</div>}</div>;
}

function Section({ title, available, children }: { title: string; available: boolean; children: React.ReactNode }) {
  return <div className="card" style={{ marginTop: 16 }}>
    <h3 style={{ marginTop: 0 }}>{title}{!available && <span style={{ fontSize: 12, color: 'var(--muted, #888)', marginLeft: 8 }}>(some data unavailable)</span>}</h3>
    <div className="grid cols-4">{children}</div>
  </div>;
}

export function Home() {
  const [myWork, setMyWork] = useState<AnyRec | null>(null);
  useEffect(() => { safeGet('/dashboard/my-work-summary').then(d => setMyWork(d as AnyRec)); }, []);
  return <div className="grid">
    <div className="card">
      <h2>Home</h2>
      <p>Welcome to SECH_LIMS by Nickland, a neutral laboratory QMS workspace designed to support daily records, evidence, personnel, actions, document control, audit trail, backups, and LAN host/client readiness alongside LHIMS/Lightwave.</p>
      <p>SECH_LIMS does not replace LHIMS/Lightwave for patient registration, test requests, clinical result entry, verification, dispatch, or reporting. It does not include official GAS, SLIPTA, ISO scoring, accreditation scoring, star ratings, or official compliance grading. Internal audit marking is supported as a configurable internal assessment tool inside the assessment module.</p>
    </div>
    <div className="card">
      <h3>My Work</h3>
      {myWork ? <div className="grid cols-4">
        <Metric label="My open tasks" value={myWork.myOpenTasks} />
        <Metric label="My unread notifications" value={myWork.myUnreadNotifications} />
        <Metric label="My due today" value={myWork.myDueToday} />
        <Metric label="My overdue items" value={myWork.myOverdueItems} />
        <Metric label="My open actions" value={myWork.myOpenActions} />
        <Metric label="My pending approvals" value={myWork.myPendingApprovals} />
      </div> : <p>Loading personal queue…</p>}
      <p><Link to="/notifications">Open Notifications & Review Calendar →</Link> · <Link to="/actions">Open Action Tracker →</Link> · <Link to="/dashboard">Open Main Dashboard →</Link></p>
    </div>
  </div>;
}

export function Dashboard() {
  const [legacy, setLegacy] = useState<Record<string, CountRow | { file_name?: string } | null>>({});
  const [qms, setQms] = useState<AnyRec | null>(null);
  const [ops, setOps] = useState<AnyRec | null>(null);
  const [tech, setTech] = useState<AnyRec | null>(null);
  const [docs, setDocs] = useState<AnyRec | null>(null);
  const [people, setPeople] = useState<AnyRec | null>(null);
  const [gov, setGov] = useState<AnyRec | null>(null);
  const [customer, setCustomer] = useState<AnyRec | null>(null);
  const [poct, setPoct] = useState<AnyRec | null>(null);
  const [blood, setBlood] = useState<AnyRec | null>(null);
  const [monthly, setMonthly] = useState<AnyRec | null>(null);
  const [notifs, setNotifs] = useState<AnyRec | null>(null);
  const [records, setRecords] = useState<AnyRec | null>(null);
  const [process, setProcess] = useState<AnyRec | null>(null);
  const [info, setInfo] = useState<AnyRec | null>(null);
  const [health, setHealth] = useState<AnyRec | null>(null);
  const [myWork, setMyWork] = useState<AnyRec | null>(null);

  useEffect(() => {
    safeGet('/dashboard').then(d => setLegacy(d as any));
    safeGet('/dashboard/qms-summary').then(setQms);
    safeGet('/dashboard/operations-summary').then(setOps);
    safeGet('/dashboard/technical-quality-summary').then(setTech);
    safeGet('/dashboard/document-control-summary').then(setDocs);
    safeGet('/dashboard/personnel-summary').then(setPeople);
    safeGet('/dashboard/governance-summary').then(setGov);
    safeGet('/dashboard/customer-focus-summary').then(setCustomer);
    safeGet('/dashboard/poct-summary').then(setPoct);
    safeGet('/dashboard/blood-bank-summary').then(setBlood);
    safeGet('/dashboard/monthly-reports-summary').then(setMonthly);
    safeGet('/dashboard/notifications-summary').then(setNotifs);
    safeGet('/dashboard/records-reports-summary').then(setRecords);
    safeGet('/dashboard/process-management-summary').then(setProcess);
    safeGet('/dashboard/information-management-summary').then(setInfo);
    safeGet('/dashboard/system-health-summary').then(setHealth);
    safeGet('/dashboard/my-work-summary').then(setMyWork);
  }, []);

  const c = (x: unknown) => (x && typeof x === 'object' && 'count' in (x as any)) ? (x as CountRow).count : x;

  return <>
    <h2>Main Dashboard</h2>

    <Section title="System Health" available={!!health}>
      <Metric label="Active modules" value={health?.activeModules} />
      <Metric label="Total users" value={health?.totalUsers} />
      <Metric label="Users linked to staff" value={health?.usersLinkedToStaff} />
      <Metric label="Users not linked" value={health?.usersNotLinkedToStaff} />
      <Metric label="Open actions" value={health?.openActions} />
      <Metric label="Overdue actions" value={health?.overdueActions} />
      <Metric label="Unread notifications" value={health?.unreadNotifications} />
      <Metric label="Overdue calendar items" value={health?.overdueCalendarItems} />
      <Metric label="Recent audit events (month)" value={health?.recentAuditEvents} />
      <Metric label="Backup checks (month)" value={health?.backupChecksThisMonth} />
      <Metric label="Open data integrity issues" value={health?.openDataIntegrityIssues} />
    </Section>

    <Section title="My Work" available={!!myWork}>
      <Metric label="My open tasks" value={myWork?.myOpenTasks} />
      <Metric label="My unread notifications" value={myWork?.myUnreadNotifications} />
      <Metric label="My due today" value={myWork?.myDueToday} />
      <Metric label="My overdue items" value={myWork?.myOverdueItems} />
      <Metric label="My open actions" value={myWork?.myOpenActions} />
      <Metric label="My pending approvals" value={myWork?.myPendingApprovals} />
    </Section>

    <Section title="QMS Core" available={!!qms}>
      <Metric label="Open NCs" value={c(qms?.openNCs)} />
      <Metric label="Open CAPAs" value={c(qms?.openCAPAs)} />
      <Metric label="Pending complaints" value={c(qms?.pendingComplaints)} />
      <Metric label="High/critical risks" value={c(qms?.highRisks)} />
      <Metric label="My assigned actions" value={c(qms?.myAssignedActions)} />
      <Metric label="Overdue actions" value={c(qms?.overdueActions)} />
    </Section>

    <Section title="Operations" available={!!ops}>
      <Metric label="Equipment total" value={ops?.equipmentTotal} />
      <Metric label="Maintenance due" value={ops?.equipmentMaintenanceDue} />
      <Metric label="Calibration due" value={ops?.equipmentCalibrationDue} />
      <Metric label="Out of service" value={ops?.equipmentOutOfService} />
      <Metric label="Low stock" value={ops?.inventoryLowStock} />
      <Metric label="Expiring soon" value={ops?.inventoryExpiringSoon} />
      <Metric label="Expired stock" value={ops?.inventoryExpired} />
      <Metric label="Monitoring warnings" value={ops?.monitoringWarnings} />
      <Metric label="Monitoring critical" value={ops?.monitoringCritical} />
      <Metric label="Open safety incidents" value={ops?.openSafetyIncidents} />
    </Section>

    <Section title="Technical Quality" available={!!tech}>
      <Metric label="Active IQC materials" value={tech?.activeIqcMaterials} />
      <Metric label="IQC failures (month)" value={tech?.iqcFailuresThisMonth} />
      <Metric label="IQC pending review" value={tech?.iqcResultsPendingReview} />
      <Metric label="EQA events due" value={tech?.eqaEventsDue} />
      <Metric label="Unsatisfactory EQA" value={tech?.eqaUnsatisfactoryEvents} />
      <Metric label="Open verifications" value={tech?.openVerifications} />
      <Metric label="Equip verifications due" value={tech?.equipmentVerificationsDue} />
      <Metric label="MU records due review" value={tech?.muRecordsDueForReview} />
    </Section>

    <Section title="People & Documents" available={!!(docs || people)}>
      <Metric label="Current documents" value={docs?.currentDocuments} />
      <Metric label="Document drafts" value={docs?.drafts} />
      <Metric label="Reviews due" value={docs?.dueReviews} />
      <Metric label="Reviews overdue" value={docs?.overdueReviews} />
      <Metric label="Pending attestations" value={docs?.pendingAttestations} />
      <Metric label="Staff docs pending" value={people?.staffDocumentsPendingVerification} />
      <Metric label="Certificates expiring" value={people?.certificatesExpiringSoon} />
      <Metric label="Competency assess due" value={people?.competencyAssessmentsDue} />
      <Metric label="Auth due review" value={people?.authorizationsDueReview} />
      <Metric label="Rosters this month" value={people?.rostersThisMonth} />
    </Section>

    <Section title="Governance" available={!!gov}>
      <Metric label="Planned assessments" value={gov?.plannedAssessments} />
      <Metric label="Open findings" value={gov?.openFindings} />
      <Metric label="Open meetings" value={gov?.openMeetings} />
      <Metric label="Pending mgmt reviews" value={gov?.pendingManagementReviews} />
      <Metric label="Active QI" value={gov?.activeQualityIndicators} />
      <Metric label="Critical QI results" value={gov?.criticalQualityIndicatorResults} />
      <Metric label="Active improvement projects" value={gov?.activeImprovementProjects} />
      <Metric label="Overdue improvement actions" value={gov?.overdueImprovementActions} />
    </Section>

    <Section title="Customer, POCT & Blood Bank" available={!!(customer || poct || blood)}>
      <Metric label="Active stakeholders" value={customer?.activeStakeholders} />
      <Metric label="Open feedback" value={customer?.openFeedback} />
      <Metric label="High-urgency feedback" value={customer?.highUrgencyFeedback} />
      <Metric label="Active POCT sites" value={poct?.activeSites} />
      <Metric label="POCT QC failures (month)" value={poct?.qcFailuresThisMonth} />
      <Metric label="Open POCT incidents" value={poct?.openIncidents} />
      <Metric label="Blood units available" value={blood?.unitsAvailable} />
      <Metric label="Units expiring soon" value={blood?.unitsExpiringSoon} />
      <Metric label="Pending handovers" value={blood?.pendingHandovers} />
      <Metric label="Open adverse events" value={blood?.openAdverseEvents} />
    </Section>

    <Section title="Process Management" available={!!process}>
      <Metric label="Active tests" value={process?.activeTests} />
      <Metric label="Specimen rejections (month)" value={process?.specimenRejectionsThisMonth} />
      <Metric label="Open rejections" value={process?.openSpecimenRejections} />
      <Metric label="Critical results (month)" value={process?.criticalResultsThisMonth} />
      <Metric label="Delayed critical notifs" value={process?.delayedCriticalNotifications} />
      <Metric label="Referral sendouts pending" value={process?.referralSendoutsPending} />
      <Metric label="Delayed sendouts" value={process?.delayedReferralSendouts} />
      <Metric label="Amendments (month)" value={process?.reportAmendmentsThisMonth} />
    </Section>

    <Section title="Information & Records" available={!!(info || records || monthly)}>
      <Metric label="Active info assets" value={info?.activeInformationAssets} />
      <Metric label="Active systems" value={info?.activeSystems} />
      <Metric label="Open access reviews" value={info?.openAccessReviews} />
      <Metric label="Open security incidents" value={info?.openSecurityIncidents} />
      <Metric label="Open change requests" value={info?.openChangeRequests} />
      <Metric label="Downtime (month)" value={info?.downtimeRecordsThisMonth} />
      <Metric label="Pending data corrections" value={info?.pendingDataCorrections} />
      <Metric label="Active report templates" value={records?.activeReportTemplates} />
      <Metric label="Reports generated (month)" value={records?.reportsGeneratedThisMonth} />
      <Metric label="Open evidence packs" value={records?.openEvidencePacks} />
      <Metric label="Imports this month" value={monthly?.importsThisMonth} />
      <Metric label="Unresolved exceptions" value={monthly?.unresolvedExceptions} />
    </Section>

    <Section title="Alerts & Tasks" available={!!notifs}>
      <Metric label="Unread notifications" value={notifs?.unreadNotifications} />
      <Metric label="Urgent notifications" value={notifs?.urgentNotifications} />
      <Metric label="Due today" value={notifs?.dueToday} />
      <Metric label="Due soon" value={notifs?.dueSoon} />
      <Metric label="Overdue" value={notifs?.overdue} />
      <Metric label="Open tasks" value={notifs?.openTasks} />
      <Metric label="Pending approvals" value={notifs?.pendingApprovals} />
      <Metric label="Review items due" value={notifs?.reviewItemsDue} />
      <Metric label="Follow-ups due" value={notifs?.followUpsDue} />
    </Section>

    <div className="card" style={{ marginTop: 16 }}>
      <h3 style={{ marginTop: 0 }}>Legacy counts</h3>
      <div className="grid cols-4">
        <Metric label="Documents" value={c(legacy.documents)} />
        <Metric label="Open actions" value={c(legacy.actionsOpen)} />
        <Metric label="Staff records" value={c(legacy.staff)} />
        <Metric label="Enabled modules" value={c(legacy.modulesEnabled)} />
        <Metric label="Equipment items" value={c(legacy.equipmentItems)} />
        <Metric label="Inventory items" value={c(legacy.inventoryItems)} />
        <Metric label="Monitoring records" value={c(legacy.monitoringRecords)} />
        <Metric label="Safety incidents" value={c(legacy.safetyIncidents)} />
      </div>
    </div>
  </>;
}

export function ModulePage({ moduleKey, title, placeholder = false }: { moduleKey: string; title: string; placeholder?: boolean }) {
  const { isEnabled } = useModules();
  if (!isEnabled(moduleKey)) return <DisabledModule/>;
  return <div className="card"><h2>{title}</h2>{placeholder ? <p>This foundation MVP intentionally provides a placeholder only. Full workflows will be built in later phases without accreditation scoring or star ratings.</p> : <p>Foundation workspace connected to the host API and audit-ready data model.</p>}</div>;
}

export function Documents() { return <ModulePage moduleKey="documents" title="Documents & Records"/>; }
export function Organisation() { return <ModulePage moduleKey="organisation" title="Organisation & Leadership"/>; }
export function Personnel() { return <ModulePage moduleKey="personnel" title="Personnel Management"/>; }
