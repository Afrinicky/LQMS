import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Bell, Search, FlaskConical, FileText, AlertOctagon, ClipboardCheck,
  ArrowRight, ClipboardList, CalendarClock, FolderArchive, PackageSearch,
} from 'lucide-react';
import { api } from '../services/api';
import { useAuth } from '../hooks/useAuth';
import DisabledModule from '../components/DisabledModule';
import { useModules } from '../hooks/useModules';
import { MODULES } from '../../shared/constants/modules';
import { NAV_SECTIONS } from '../../shared/constants/navigation';
import { sectionIcon } from '../components/ui/moduleIcons';
import { WaveBackground, MedicalLabBackgroundMarks, PageHeader, KpiStrip, ChartCard, DonutChart, BarChart, BarMeter, CHART_COLORS } from '../components/ui';

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
   HOME — premium launchpad (no persistent sidebar). Cards come from the same
   NAV_SECTIONS structure the sidebar renders, so the two always match.
   ========================================================================= */
const MODULE_PATHS = new Map(MODULES.map(m => [m.key, m.path]));

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
          {NAV_SECTIONS.map(section => {
            // A section lands on its first enabled module; it is disabled only
            // when none of its modules are enabled (settings is always on).
            const firstEnabled = section.modules.find(k => isEnabled(k) || k === 'settings');
            const to = MODULE_PATHS.get(firstEnabled ?? section.modules[0]) ?? '#';
            const disabled = !firstEnabled;
            const Icon = sectionIcon(section.key);
            // Only the twelve quality essentials carry an index badge (01–12).
            const essentialIndex = section.group === 'essential'
              ? NAV_SECTIONS.filter(s => s.group === 'essential').indexOf(section) + 1
              : null;
            return (
              <Link
                key={section.key}
                to={disabled ? '#' : to}
                className="launch-card"
                onClick={e => { if (disabled) e.preventDefault(); }}
                style={disabled ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}
                aria-disabled={disabled}
              >
                {essentialIndex !== null && <span className="launch-index">{String(essentialIndex).padStart(2, '0')}</span>}
                <span className="launch-ico"><Icon size={24} /></span>
                <h3>{section.title}</h3>
                <p>{section.desc}</p>
              </Link>
            );
          })}
        </div>
      </main>
    </div>
  );
}

/* ============================================================================
   MAIN DASHBOARD — one-page, chart-first QMS snapshot. A single KPI band on
   top, then six compact charts; drill into modules for the detailed numbers.
   ========================================================================= */
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
  const [qms, setQms] = useState<AnyRec | null>(null);
  const [ops, setOps] = useState<AnyRec | null>(null);
  const [tech, setTech] = useState<AnyRec | null>(null);
  const [docs, setDocs] = useState<AnyRec | null>(null);
  const [people, setPeople] = useState<AnyRec | null>(null);
  const [gov, setGov] = useState<AnyRec | null>(null);
  const [notifs, setNotifs] = useState<AnyRec | null>(null);
  const [health, setHealth] = useState<AnyRec | null>(null);
  const [myWork, setMyWork] = useState<AnyRec | null>(null);

  useEffect(() => {
    safeGet('/dashboard/qms-summary').then(setQms);
    safeGet('/dashboard/operations-summary').then(setOps);
    safeGet('/dashboard/technical-quality-summary').then(setTech);
    safeGet('/dashboard/document-control-summary').then(setDocs);
    safeGet('/dashboard/personnel-summary').then(setPeople);
    safeGet('/dashboard/governance-summary').then(setGov);
    safeGet('/dashboard/notifications-summary').then(setNotifs);
    safeGet('/dashboard/system-health-summary').then(setHealth);
    safeGet('/dashboard/my-work-summary').then(setMyWork);
  }, []);

  const c = (x: unknown): number | string | undefined =>
    (x && typeof x === 'object' && 'count' in (x as any)) ? (x as CountRow).count : (x as number | string | undefined);
  const n = (x: unknown): number => { const v = c(x); return typeof v === 'number' ? v : (typeof v === 'string' && v !== '' ? Number(v) || 0 : 0); };
  const firstName = user?.fullName?.trim().split(/\s+/)[0];

  // Chart series derived entirely from the real summary counts above.
  const qualityWorkload = [
    { label: 'Open NCs', value: n(qms?.openNCs), color: CHART_COLORS[3] },
    { label: 'Open CAPAs', value: n(qms?.openCAPAs), color: CHART_COLORS[0] },
    { label: 'Pending complaints', value: n(qms?.pendingComplaints), color: CHART_COLORS[2] },
    { label: 'High/critical risks', value: n(qms?.highRisks), color: CHART_COLORS[4] },
  ];
  const operationalReadiness = [
    { label: 'Maintenance due', value: n(ops?.equipmentMaintenanceDue), color: CHART_COLORS[0] },
    { label: 'Calibration due', value: n(ops?.equipmentCalibrationDue), color: CHART_COLORS[5] },
    { label: 'Out of service', value: n(ops?.equipmentOutOfService), color: CHART_COLORS[3] },
    { label: 'Low stock', value: n(ops?.inventoryLowStock), color: CHART_COLORS[2] },
    { label: 'Expiring soon', value: n(ops?.inventoryExpiringSoon), color: CHART_COLORS[1] },
    { label: 'Expired stock', value: n(ops?.inventoryExpired), color: CHART_COLORS[6] },
  ];
  const alertsBreakdown = [
    { label: 'Due today', value: n(notifs?.dueToday), color: CHART_COLORS[2] },
    { label: 'Due soon', value: n(notifs?.dueSoon), color: CHART_COLORS[0] },
    { label: 'Overdue', value: n(notifs?.overdue), color: CHART_COLORS[3] },
    { label: 'Open tasks', value: n(notifs?.openTasks), color: CHART_COLORS[5] },
    { label: 'Approvals', value: n(notifs?.pendingApprovals), color: CHART_COLORS[4] },
  ];
  const technicalQuality = [
    { label: 'IQC failures (month)', value: n(tech?.iqcFailuresThisMonth), color: CHART_COLORS[3] },
    { label: 'IQC pending review', value: n(tech?.iqcResultsPendingReview), color: CHART_COLORS[0] },
    { label: 'EQA events due', value: n(tech?.eqaEventsDue), color: CHART_COLORS[5] },
    { label: 'Unsatisfactory EQA', value: n(tech?.eqaUnsatisfactoryEvents), color: CHART_COLORS[2] },
    { label: 'Open verifications', value: n(tech?.openVerifications), color: CHART_COLORS[1] },
    { label: 'MU records due', value: n(tech?.muRecordsDueForReview), color: CHART_COLORS[4] },
  ];
  const peopleAndDocuments = [
    { label: 'Doc reviews due', value: n(docs?.dueReviews), color: CHART_COLORS[0] },
    { label: 'Doc reviews overdue', value: n(docs?.overdueReviews), color: CHART_COLORS[3] },
    { label: 'Pending attestations', value: n(docs?.pendingAttestations), color: CHART_COLORS[5] },
    { label: 'Certificates expiring', value: n(people?.certificatesExpiringSoon), color: CHART_COLORS[2] },
    { label: 'Competency due', value: n(people?.competencyAssessmentsDue), color: CHART_COLORS[4] },
    { label: 'Authorisations due', value: n(people?.authorizationsDueReview), color: CHART_COLORS[1] },
  ];
  const governance = [
    { label: 'Planned assessments', value: n(gov?.plannedAssessments), color: CHART_COLORS[0] },
    { label: 'Open findings', value: n(gov?.openFindings), color: CHART_COLORS[3] },
    { label: 'Pending mgmt reviews', value: n(gov?.pendingManagementReviews), color: CHART_COLORS[2] },
    { label: 'Critical QI results', value: n(gov?.criticalQualityIndicatorResults), color: CHART_COLORS[6] },
    { label: 'Improvement projects', value: n(gov?.activeImprovementProjects), color: CHART_COLORS[1] },
    { label: 'Overdue improvements', value: n(gov?.overdueImprovementActions), color: CHART_COLORS[4] },
  ];

  return (
    <div className="module-page">
      <PageHeader
        eyebrow="Quality overview"
        title={firstName ? `Good day, ${firstName}` : 'Main Dashboard'}
        subtitle="Your laboratory quality management snapshot — pending actions, reviews, alerts and indicators at a glance."
        actions={<button className="secondary" type="button" onClick={() => navigate('/notifications')}><Bell size={16} /> Review Calendar</button>}
      />

      {/* One slim KPI band — the headline numbers, nothing more */}
      <KpiStrip items={[
        { label: 'Open NCs', value: c(qms?.openNCs) },
        { label: 'Open CAPAs', value: c(qms?.openCAPAs) },
        { label: 'Overdue actions', value: health?.overdueActions ?? c(qms?.overdueActions), tone: 'danger' },
        { label: 'Docs due review', value: docs?.dueReviews },
        { label: 'Training due', value: people?.competencyAssessmentsDue },
        { label: 'Unread alerts', value: notifs?.unreadNotifications },
      ]} />

      {/* Six compact charts cover the whole management system */}
      <div className="grid cols-3 dash-charts">
        <ChartCard title="Quality workload" subtitle="Open quality items">
          <DonutChart data={qualityWorkload} centerLabel="Open items" size={132} thickness={15} />
        </ChartCard>
        <ChartCard title="Operational readiness" subtitle="Equipment & inventory attention">
          <BarMeter data={operationalReadiness} />
        </ChartCard>
        <ChartCard title="Alerts & tasks" subtitle="Time-sensitive follow-ups">
          <BarChart data={alertsBreakdown} height={150} />
        </ChartCard>
        <ChartCard title="Technical quality" subtitle="IQC, EQA, verification, MU">
          <BarMeter data={technicalQuality} />
        </ChartCard>
        <ChartCard title="People & documents" subtitle="Reviews, competence, attestations">
          <BarMeter data={peopleAndDocuments} />
        </ChartCard>
        <ChartCard title="Governance & improvement" subtitle="Audits, reviews, projects">
          <BarMeter data={governance} />
        </ChartCard>
      </div>

      {/* My Work + Quick Actions */}
      <div className="grid cols-2">
        <div className="card">
          <div className="section-head"><h3>My Work</h3><Link to="/actions">Open tracker <ArrowRight size={13} /></Link></div>
          <KpiStrip flat items={[
            { label: 'Open tasks', value: myWork?.myOpenTasks },
            { label: 'Due today', value: myWork?.myDueToday },
            { label: 'Overdue', value: myWork?.myOverdueItems, tone: 'danger' },
            { label: 'Open actions', value: myWork?.myOpenActions },
            { label: 'Approvals', value: myWork?.myPendingApprovals },
            { label: 'Unread alerts', value: myWork?.myUnreadNotifications },
          ]} />
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
    </div>
  );
}

/* ============================================================================
   Generic module page / placeholders
   ========================================================================= */
export function ModulePage({ moduleKey, title, eyebrow = 'Module', placeholder = false }: { moduleKey: string; title: string; eyebrow?: string; placeholder?: boolean }) {
  const { isEnabled } = useModules();
  if (!isEnabled(moduleKey)) return <DisabledModule />;
  return (
    <div className="module-page">
      <PageHeader title={title} eyebrow={eyebrow} subtitle={placeholder
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
export function Organisation() { return <ModulePage moduleKey="organisation" title="Organisation & Leadership" eyebrow="Organisation" />; }
export function Personnel() { return <ModulePage moduleKey="personnel" title="Personnel Management" />; }
