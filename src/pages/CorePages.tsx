import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Bell, Search, FlaskConical, LayoutDashboard, FileText, Users, Wrench, Boxes,
  AlertOctagon, ClipboardCheck, ShieldAlert, MessageSquareWarning, ShieldCheck,
  TrendingUp, FolderArchive, Settings as SettingsIcon, ArrowRight, ClipboardList,
  CalendarClock, Activity, TriangleAlert, GraduationCap, PackageSearch,
} from 'lucide-react';
import { api } from '../services/api';
import { useAuth } from '../hooks/useAuth';
import DisabledModule from '../components/DisabledModule';
import { useModules } from '../hooks/useModules';
import { WaveBackground, MedicalLabBackgroundMarks, PageHeader, StatCard } from '../components/ui';

type CountRow = { count: number };
type AnyRec = Record<string, any>;

async function safeGet<T = AnyRec>(path: string): Promise<T | null> {
  try { return await api<T>(path); } catch { return null; }
}

function initials(name?: string) {
  if (!name) return 'U';
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || 'U';
}

/* ============================================================================
   HOME — premium launchpad (no persistent sidebar)
   ========================================================================= */
const LAUNCH_CARDS: { title: string; desc: string; to: string; Icon: typeof FileText }[] = [
  { title: 'Main Dashboard', desc: 'View organization-wide quality overview', to: '/dashboard', Icon: LayoutDashboard },
  { title: 'Documents & SOPs', desc: 'Manage controlled documents and forms', to: '/documents', Icon: FileText },
  { title: 'Personnel', desc: 'Staff records, competency, rosters, training', to: '/personnel', Icon: Users },
  { title: 'Equipment & Monitoring', desc: 'Equipment, maintenance, calibration, environment', to: '/equipment', Icon: Wrench },
  { title: 'Inventory', desc: 'Reagents, supplies, stock and vendors', to: '/supplier-inventory', Icon: Boxes },
  { title: 'Process Control | IQC-EQA', desc: 'Internal QC, EQA, process monitoring', to: '/iqc', Icon: Activity },
  { title: 'Nonconformities & CAPA', desc: 'Incidents, investigations, corrective actions', to: '/nc-capa', Icon: AlertOctagon },
  { title: 'Assessments & Audits', desc: 'Internal audits, assessments, checklists', to: '/assessments', Icon: ClipboardCheck },
  { title: 'Risk Management', desc: 'Risk register, mitigations, review', to: '/risks', Icon: ShieldAlert },
  { title: 'Complaints & Customer Service', desc: 'Complaints, feedback, resolution', to: '/complaints', Icon: MessageSquareWarning },
  { title: 'Facilities & Safety', desc: 'Safety incidents, inspections, facility checks', to: '/facilities-safety', Icon: ShieldCheck },
  { title: 'Continual Improvement', desc: 'Improvement projects and tracking', to: '/continual-improvement', Icon: TrendingUp },
  { title: 'Reports', desc: 'Dashboards, summaries, exports', to: '/records-reports', Icon: FolderArchive },
  { title: 'Notifications', desc: 'Alerts, reminders, announcements', to: '/notifications', Icon: Bell },
  { title: 'Settings', desc: 'Users, permissions, configuration', to: '/settings', Icon: SettingsIcon },
];

const MODULE_KEY_FOR_PATH: Record<string, string> = {
  '/dashboard': 'dashboard', '/documents': 'documents', '/personnel': 'personnel',
  '/equipment': 'equipment', '/supplier-inventory': 'supplier_inventory', '/iqc': 'iqc',
  '/nc-capa': 'nc_capa', '/assessments': 'assessments', '/risks': 'risks',
  '/complaints': 'complaints', '/facilities-safety': 'facilities_safety',
  '/continual-improvement': 'continual_improvement', '/records-reports': 'records_reports',
  '/notifications': 'notifications', '/settings': 'settings',
};

export function Home() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { isEnabled } = useModules();
  const [unread, setUnread] = useState<number | null>(null);

  useEffect(() => {
    safeGet<{ unreadNotifications: number }>('/dashboard/notifications-summary').then(d => setUnread(d?.unreadNotifications ?? null));
  }, []);

  const firstName = user?.fullName?.trim().split(/\s+/)[0] ?? 'there';

  return (
    <div className="home-shell">
      <div className="home-bg">
        <WaveBackground variant="hero" />
        <MedicalLabBackgroundMarks waveform />
      </div>

      <header className="home-topbar">
        <div className="brand">
          <span className="brand-mark"><FlaskConical size={20} /></span>
          <span className="brand-text">
            <h1>SECH_LIMS</h1>
            <span>by Nickland</span>
          </span>
        </div>
        <div className="search" style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--faint)', maxWidth: 480, marginLeft: 18 }}>
          <Search size={16} />
          <input placeholder="Search documents, samples, equipment, personnel…"
            style={{ border: 0, background: 'transparent', padding: 0, boxShadow: 'none', flex: 1 }} />
        </div>
        <div className="topbar-actions">
          <span className="health-pill"><span className="dot" /><span>System Healthy</span></span>
          <button className="icon-btn" type="button" aria-label="Notifications" onClick={() => navigate('/notifications')}>
            <Bell size={18} />
            {unread !== null && unread > 0 && <span className="icon-badge">{unread > 99 ? '99+' : unread}</span>}
          </button>
          <button className="user-chip" type="button" onClick={() => navigate('/settings')}>
            <span className="user-avatar">{initials(user?.fullName)}</span>
            <span className="user-meta">
              <strong>{user?.fullName ?? 'User'}</strong>
              <span>{(user as any)?.role ?? (user as any)?.position ?? 'Member'}</span>
            </span>
          </button>
        </div>
      </header>

      <main className="home-main">
        <section className="home-hero">
          <div className="eyebrow">Laboratory Quality Management</div>
          <h1>Welcome, <span className="accent">{firstName}!</span></h1>
          <p>What would you like to manage today?</p>
        </section>

        <div className="launch-grid">
          {LAUNCH_CARDS.map((card, i) => {
            const moduleKey = MODULE_KEY_FOR_PATH[card.to];
            const disabled = moduleKey ? !isEnabled(moduleKey) : false;
            const Icon = card.Icon;
            return (
              <Link
                key={card.title}
                to={disabled ? '#' : card.to}
                className="launch-card"
                onClick={e => { if (disabled) e.preventDefault(); }}
                style={disabled ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}
                aria-disabled={disabled}
              >
                <span className="launch-index">{String(i + 1).padStart(2, '0')}</span>
                <span className="launch-ico"><Icon size={24} /></span>
                <h3>{card.title}</h3>
                <p>{card.desc}</p>
              </Link>
            );
          })}
        </div>
      </main>
    </div>
  );
}

/* ============================================================================
   MAIN DASHBOARD — premium QMS snapshot
   ========================================================================= */
function Metric({ label, value, hint }: { label: string; value: unknown; hint?: string }) {
  return (
    <div className="card metric">
      <span>{label}</span>
      <strong>{value === null || value === undefined ? '—' : String(value)}</strong>
      {hint && <span style={{ fontSize: 11, color: 'var(--faint)' }}>{hint}</span>}
    </div>
  );
}

function Section({ title, available, children }: { title: string; available: boolean; children: React.ReactNode }) {
  return (
    <div className="card" style={{ marginTop: 18 }}>
      <div className="section-head">
        <h3 style={{ marginTop: 0 }}>{title}</h3>
        {!available && <span className="muted" style={{ fontSize: 12 }}>some data unavailable</span>}
      </div>
      <div className="grid cols-4">{children}</div>
    </div>
  );
}

const QUICK_ACTIONS = [
  { label: 'New Nonconformity', to: '/nc-capa', Icon: AlertOctagon },
  { label: 'Add Document', to: '/documents', Icon: FileText },
  { label: 'Schedule Assessment', to: '/assessments', Icon: ClipboardCheck },
  { label: 'Log Action', to: '/actions', Icon: ClipboardList },
  { label: 'Review Calendar', to: '/notifications', Icon: CalendarClock },
  { label: 'Open Reports', to: '/records-reports', Icon: FolderArchive },
];

export function Dashboard() {
  const navigate = useNavigate();
  const { user } = useAuth();
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

  const c = (x: unknown): number | string | undefined =>
    (x && typeof x === 'object' && 'count' in (x as any)) ? (x as CountRow).count : (x as number | string | undefined);
  const firstName = user?.fullName?.trim().split(/\s+/)[0];

  return (
    <div className="module-page">
      <PageHeader
        eyebrow="Quality overview"
        title={firstName ? `Good day, ${firstName}` : 'Main Dashboard'}
        subtitle="Your laboratory quality management snapshot — pending actions, reviews, alerts and indicators at a glance."
        actions={<button className="secondary" type="button" onClick={() => navigate('/notifications')}><Bell size={16} /> Review Calendar</button>}
      />

      {/* Hero KPI row */}
      <div className="grid cols-4">
        <StatCard label="Open CAPAs" value={c(qms?.openCAPAs)} icon={<AlertOctagon size={20} />} hint="Corrective & preventive actions" />
        <StatCard label="Overdue actions" value={health?.overdueActions ?? c(qms?.overdueActions)} icon={<TriangleAlert size={20} />} hint="Across all modules" />
        <StatCard label="Documents due review" value={docs?.dueReviews} icon={<FileText size={20} />} hint="Within review window" />
        <StatCard label="Training due" value={people?.competencyAssessmentsDue} icon={<GraduationCap size={20} />} hint="Competency assessments" />
      </div>

      {/* My Work + Quick Actions */}
      <div className="grid cols-2">
        <div className="card">
          <div className="section-head"><h3>My Work</h3><Link to="/actions">Open tracker <ArrowRight size={13} /></Link></div>
          <div className="grid cols-3">
            <Metric label="Open tasks" value={myWork?.myOpenTasks} />
            <Metric label="Due today" value={myWork?.myDueToday} />
            <Metric label="Overdue" value={myWork?.myOverdueItems} />
            <Metric label="Open actions" value={myWork?.myOpenActions} />
            <Metric label="Pending approvals" value={myWork?.myPendingApprovals} />
            <Metric label="Unread alerts" value={myWork?.myUnreadNotifications} />
          </div>
        </div>
        <div className="card">
          <div className="section-head"><h3>Quick Actions</h3></div>
          <div className="quick-actions">
            {QUICK_ACTIONS.map(a => {
              const Icon = a.Icon;
              return (
                <button key={a.label} type="button" className="quick-action" onClick={() => navigate(a.to)}>
                  <span className="qa-ico"><Icon size={20} /></span>
                  <strong>{a.label}</strong>
                </button>
              );
            })}
          </div>
        </div>
      </div>

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

      <Section title="Snapshot Counts" available={true}>
        <Metric label="Documents" value={c(legacy.documents)} />
        <Metric label="Open actions" value={c(legacy.actionsOpen)} />
        <Metric label="Staff records" value={c(legacy.staff)} />
        <Metric label="Enabled modules" value={c(legacy.modulesEnabled)} />
        <Metric label="Equipment items" value={c(legacy.equipmentItems)} />
        <Metric label="Inventory items" value={c(legacy.inventoryItems)} />
        <Metric label="Monitoring records" value={c(legacy.monitoringRecords)} />
        <Metric label="Safety incidents" value={c(legacy.safetyIncidents)} />
      </Section>
    </div>
  );
}

/* ============================================================================
   Generic module page / placeholders
   ========================================================================= */
export function ModulePage({ moduleKey, title, placeholder = false }: { moduleKey: string; title: string; placeholder?: boolean }) {
  const { isEnabled } = useModules();
  if (!isEnabled(moduleKey)) return <DisabledModule />;
  return (
    <div className="module-page">
      <PageHeader title={title} eyebrow="Module" subtitle={placeholder
        ? 'This workspace is part of the SECH_LIMS foundation and will gain full workflows in a later phase.'
        : 'Connected to the host API and the audit-ready data model.'} />
      <div className="card">
        <div className="empty-state">
          <span className="es-ico"><PackageSearch size={26} /></span>
          <h3>{placeholder ? 'Workspace coming soon' : 'Workspace ready'}</h3>
          <p>{placeholder
            ? 'A placeholder is shown for now. Records, forms and reports for this module will be added without accreditation scoring or star ratings.'
            : 'This module is enabled and connected. Use the navigation to manage its records.'}</p>
        </div>
      </div>
    </div>
  );
}

export function Documents() { return <ModulePage moduleKey="documents" title="Documents & Records" />; }
export function Organisation() { return <ModulePage moduleKey="organisation" title="Organisation & Leadership" />; }
export function Personnel() { return <ModulePage moduleKey="personnel" title="Personnel Management" />; }
