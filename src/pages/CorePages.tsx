import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Bell, Search, FlaskConical, ArrowRight, PackageSearch } from 'lucide-react';
import { api } from '../services/api';
import { useAuth } from '../hooks/useAuth';
import DisabledModule from '../components/DisabledModule';
import { useModules } from '../hooks/useModules';
import { usePermissions } from '../hooks/usePermissions';
import { canEnterSettings, settingsBlurb } from '../constants/settingsAccess';
import { MODULES } from '../../shared/constants/modules';
import { NAV_SECTIONS } from '../../shared/constants/navigation';
import { sectionIcon } from '../components/ui/moduleIcons';
import { WaveBackground, MedicalLabBackgroundMarks, PageHeader, KpiStrip, ChartCard, DonutChart, BarMeter, CHART_COLORS, AttentionCenter, AlertsByModule } from '../components/ui';
import DashboardProfileCard from '../components/DashboardProfileCard';
import DashboardInbox from '../components/DashboardInbox';
import DutyTodoCard from '../components/DutyTodoCard';

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
  const { can, canView } = usePermissions();
  const [unread, setUnread] = useState<number | null>(null);
  const [needsRegistration, setNeedsRegistration] = useState(false);

  useEffect(() => {
    if (canView('notifications')) {
      safeGet<{ unreadNotifications: number }>('/dashboard/notifications-summary').then(d => setUnread(d?.unreadNotifications ?? null));
    }
    // First-run: prompt the user to register the laboratory until the profile is
    // marked complete under Settings → My Laboratory. Only someone who can
    // actually complete the registration is asked to.
    if (canView('settings')) {
      safeGet<{ registration_complete?: number } | null>('/laboratory-profile').then(p => setNeedsRegistration(!p || Number(p.registration_complete ?? 0) !== 1));
    }
  }, [canView]);

  // The launchpad shows a card only for sections that contain at least one
  // module this user may open — the same test the sidebar applies, so the two
  // surfaces always agree and neither advertises inaccessible work.
  const visibleSections = useMemo(() => {
    const essentials = NAV_SECTIONS.filter(s => s.group === 'essential');
    return NAV_SECTIONS.flatMap(section => {
      // Settings holds delegated tools as well as administration, so it shows
      // for anyone who can open at least one page inside it.
      const landing = section.key === 'settings'
        ? (canEnterSettings(can) ? 'settings' : undefined)
        : section.modules.find(k => isEnabled(k) && canView(k));
      if (!landing) return [];
      return [{
        // The Settings card describes what this person will actually find
        // inside it rather than the administrator's version of the page.
        section: section.key === 'settings' ? { ...section, desc: settingsBlurb(can) } : section,
        to: MODULE_PATHS.get(landing) ?? '#',
        // Only the twelve quality essentials carry an index badge (01–12).
        essentialIndex: section.group === 'essential' ? essentials.indexOf(section) + 1 : null,
      }];
    });
  }, [isEnabled, canView, can]);

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
          {canView('notifications') && (
            <button className="icon-btn" type="button" aria-label="Notifications" onClick={() => navigate('/notifications')}>
              <Bell size={18} />
              {unread !== null && unread > 0 && <span className="icon-badge">{unread > 99 ? '99+' : unread}</span>}
            </button>
          )}
          <button className="user-chip" type="button" title="My profile"
            onClick={() => navigate(canView('dashboard') ? '/dashboard' : '/home')}>
            <span className="user-avatar">{initials(user?.fullName)}</span>
            <span className="user-meta">
              <strong>{user?.fullName ?? 'User'}</strong>
              <span>{user?.roleName ?? 'Member'}</span>
            </span>
          </button>
        </div>
      </header>

      <main className="home-main">
        {needsRegistration && (
          <section className="register-prompt card" role="alert">
            <div>
              <h2>Register your laboratory</h2>
              <p>Welcome! Before you begin, register your laboratory — its legal identity and documents, quality manual, and the quality policy and objectives for ISO 15189:2022. This is a one-time step you can revisit any time.</p>
            </div>
            <button type="button" onClick={() => navigate('/settings/laboratory')}>Register laboratory <ArrowRight size={16} /></button>
          </section>
        )}
        <section className="home-hero">
          <div className="eyebrow">Laboratory Quality Management</div>
          <h1>Welcome, <span className="accent">{firstName}!</span></h1>
          <p>What would you like to manage today?</p>
        </section>

        <div className="launch-grid">
          {visibleSections.map(({ section, to, essentialIndex }) => {
            const Icon = sectionIcon(section.key);
            return (
              <Link key={section.key} to={to} className="launch-card">
                {essentialIndex !== null && <span className="launch-index">{String(essentialIndex).padStart(2, '0')}</span>}
                <span className="launch-ico"><Icon size={24} /></span>
                <h3>{section.title}</h3>
                <p>{section.desc}</p>
              </Link>
            );
          })}
        </div>
        {visibleSections.length === 0 && (
          <div className="card">
            <div className="empty-state">
              <span className="es-ico"><PackageSearch size={26} /></span>
              <h3>No workspaces assigned yet</h3>
              <p>Your account has not been given access to any module. Ask a System Administrator to assign your role and permissions under Settings → People &amp; Access.</p>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

/* ============================================================================
   MAIN DASHBOARD — the staff member's home base.

   Three things, in the order they matter to the person looking at it:
     1. Who they are and what is waiting on them  — profile + inbox, side by side
     2. What needs attention across the laboratory — severity ring + priorities
     3. The numbers behind it                      — key figures, then a compact
                                                     chart per management area

   Every tile, row and bar opens the exact record or register it summarises, so
   the dashboard is a way into the work rather than a report about it. Nothing
   is shown for a module the reader may not open: the metric is dropped, not
   greyed out, so the page shrinks to fit the role instead of teasing it.
   ========================================================================= */

export function Dashboard() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { canView } = usePermissions();
  const [qms, setQms] = useState<AnyRec | null>(null);
  const [ops, setOps] = useState<AnyRec | null>(null);
  const [tech, setTech] = useState<AnyRec | null>(null);
  const [docs, setDocs] = useState<AnyRec | null>(null);
  const [people, setPeople] = useState<AnyRec | null>(null);
  const [gov, setGov] = useState<AnyRec | null>(null);
  const [notifs, setNotifs] = useState<AnyRec | null>(null);

  // Only ask for summaries this user is allowed to receive. Requesting the
  // rest would only produce a row of 403s in the console and, worse, invite
  // someone to wonder what the hidden numbers were.
  useEffect(() => {
    const when = (moduleKeys: string[], path: string, set: (v: AnyRec | null) => void) => {
      if (moduleKeys.some(canView)) safeGet(path).then(set);
    };
    when(['nc_capa', 'complaints', 'risks', 'actions'], '/dashboard/qms-summary', setQms);
    when(['equipment', 'supplier_inventory', 'monitoring', 'facilities_safety'], '/dashboard/operations-summary', setOps);
    when(['iqc', 'eqa', 'verification_validation', 'measurement_uncertainty'], '/dashboard/technical-quality-summary', setTech);
    when(['documents'], '/dashboard/document-control-summary', setDocs);
    when(['personnel'], '/dashboard/personnel-summary', setPeople);
    when(['assessments', 'meetings', 'management_review', 'quality_indicators', 'continual_improvement'], '/dashboard/governance-summary', setGov);
    when(['notifications'], '/dashboard/notifications-summary', setNotifs);
  }, [canView]);

  const c = (x: unknown): number | string | undefined =>
    (x && typeof x === 'object' && 'count' in (x as any)) ? (x as CountRow).count : (x as number | string | undefined);
  const n = (x: unknown): number => { const v = c(x); return typeof v === 'number' ? v : (typeof v === 'string' && v !== '' ? Number(v) || 0 : 0); };
  const firstName = user?.fullName?.trim().split(/\s+/)[0];
  const go = (path: string) => () => navigate(path);

  // A series entry survives only when its module is visible to this reader.
  type Series = { label: string; value: number; color: string; onClick: () => void };
  const series = (entries: Array<Series & { module: string }>): Series[] =>
    entries.filter(e => canView(e.module)).map(({ module: _module, ...rest }) => rest);

  const qualityWorkload = series([
    { module: 'nc_capa', label: 'Open NCs', value: n(qms?.openNCs), color: CHART_COLORS[3], onClick: go('/nonconformities') },
    { module: 'nc_capa', label: 'Open CAPAs', value: n(qms?.openCAPAs), color: CHART_COLORS[0], onClick: go('/capa') },
    { module: 'complaints', label: 'Pending complaints', value: n(qms?.pendingComplaints), color: CHART_COLORS[2], onClick: go('/complaints') },
    { module: 'risks', label: 'High/critical risks', value: n(qms?.highRisks), color: CHART_COLORS[4], onClick: go('/risks') },
  ]);
  const operationalReadiness = series([
    { module: 'equipment', label: 'Maintenance due', value: n(ops?.equipmentMaintenanceDue), color: CHART_COLORS[0], onClick: go('/equipment') },
    { module: 'equipment', label: 'Calibration due', value: n(ops?.equipmentCalibrationDue), color: CHART_COLORS[5], onClick: go('/equipment') },
    { module: 'equipment', label: 'Out of service', value: n(ops?.equipmentOutOfService), color: CHART_COLORS[3], onClick: go('/equipment') },
    { module: 'supplier_inventory', label: 'Low stock', value: n(ops?.inventoryLowStock), color: CHART_COLORS[2], onClick: go('/supplier-inventory') },
    { module: 'supplier_inventory', label: 'Expiring soon', value: n(ops?.inventoryExpiringSoon), color: CHART_COLORS[1], onClick: go('/supplier-inventory') },
    { module: 'supplier_inventory', label: 'Expired stock', value: n(ops?.inventoryExpired), color: CHART_COLORS[6], onClick: go('/supplier-inventory') },
  ]);
  const technicalQuality = series([
    { module: 'iqc', label: 'IQC failures (month)', value: n(tech?.iqcFailuresThisMonth), color: CHART_COLORS[3], onClick: go('/iqc') },
    { module: 'iqc', label: 'IQC pending review', value: n(tech?.iqcResultsPendingReview), color: CHART_COLORS[0], onClick: go('/iqc') },
    { module: 'eqa', label: 'EQA events due', value: n(tech?.eqaEventsDue), color: CHART_COLORS[5], onClick: go('/eqa') },
    { module: 'eqa', label: 'Unsatisfactory EQA', value: n(tech?.eqaUnsatisfactoryEvents), color: CHART_COLORS[2], onClick: go('/eqa') },
    { module: 'verification_validation', label: 'Open verifications', value: n(tech?.openVerifications), color: CHART_COLORS[1], onClick: go('/verification-validation') },
    { module: 'measurement_uncertainty', label: 'MU records due', value: n(tech?.muRecordsDueForReview), color: CHART_COLORS[4], onClick: go('/measurement-uncertainty') },
  ]);
  const peopleAndDocuments = series([
    { module: 'documents', label: 'Doc reviews due', value: n(docs?.dueReviews), color: CHART_COLORS[0], onClick: go('/documents') },
    { module: 'documents', label: 'Doc reviews overdue', value: n(docs?.overdueReviews), color: CHART_COLORS[3], onClick: go('/documents') },
    { module: 'documents', label: 'Pending attestations', value: n(docs?.pendingAttestations), color: CHART_COLORS[5], onClick: go('/documents') },
    { module: 'personnel', label: 'Certificates expiring', value: n(people?.certificatesExpiringSoon), color: CHART_COLORS[2], onClick: go('/personnel') },
    { module: 'personnel', label: 'Competency due', value: n(people?.competencyAssessmentsDue), color: CHART_COLORS[4], onClick: go('/personnel') },
    { module: 'personnel', label: 'Authorisations due', value: n(people?.authorizationsDueReview), color: CHART_COLORS[1], onClick: go('/personnel') },
  ]);
  const governance = series([
    { module: 'assessments', label: 'Planned assessments', value: n(gov?.plannedAssessments), color: CHART_COLORS[0], onClick: go('/assessments') },
    { module: 'assessments', label: 'Open findings', value: n(gov?.openFindings), color: CHART_COLORS[3], onClick: go('/assessments') },
    { module: 'management_review', label: 'Pending mgmt reviews', value: n(gov?.pendingManagementReviews), color: CHART_COLORS[2], onClick: go('/management-review') },
    { module: 'quality_indicators', label: 'Critical QI results', value: n(gov?.criticalQualityIndicatorResults), color: CHART_COLORS[6], onClick: go('/quality-indicators') },
    { module: 'continual_improvement', label: 'Improvement projects', value: n(gov?.activeImprovementProjects), color: CHART_COLORS[1], onClick: go('/continual-improvement') },
    { module: 'continual_improvement', label: 'Overdue improvements', value: n(gov?.overdueImprovementActions), color: CHART_COLORS[4], onClick: go('/continual-improvement') },
  ]);

  // The headline numbers, same rule: a tile appears only if its module does.
  const kpis = [
    { module: 'nc_capa', label: 'Open NCs', value: c(qms?.openNCs), onClick: go('/nonconformities') },
    { module: 'nc_capa', label: 'Open CAPAs', value: c(qms?.openCAPAs), onClick: go('/capa') },
    { module: 'actions', label: 'Overdue actions', value: c(qms?.overdueActions), tone: 'danger' as const, onClick: go('/actions') },
    { module: 'documents', label: 'Docs due review', value: docs?.dueReviews, onClick: go('/documents') },
    { module: 'personnel', label: 'Training due', value: people?.competencyAssessmentsDue, onClick: go('/personnel') },
    { module: 'notifications', label: 'Unread alerts', value: notifs?.unreadNotifications, onClick: go('/notifications') },
  ].filter(k => canView(k.module)).map(({ module: _module, ...rest }) => rest);

  const charts: Array<{ title: string; subtitle: string; body: React.ReactNode }> = [];
  if (qualityWorkload.length) charts.push({ title: 'Quality workload', subtitle: 'Open quality items', body: <DonutChart data={qualityWorkload} centerLabel="Open items" size={132} thickness={15} /> });
  if (operationalReadiness.length) charts.push({ title: 'Operational readiness', subtitle: 'Equipment & inventory attention', body: <BarMeter data={operationalReadiness} /> });
  if (technicalQuality.length) charts.push({ title: 'Technical quality', subtitle: 'IQC, EQA, verification, MU', body: <BarMeter data={technicalQuality} /> });
  if (peopleAndDocuments.length) charts.push({ title: 'People & documents', subtitle: 'Reviews, competence, attestations', body: <BarMeter data={peopleAndDocuments} /> });
  if (governance.length) charts.push({ title: 'Governance & improvement', subtitle: 'Audits, reviews, projects', body: <BarMeter data={governance} /> });

  return (
    <div className="module-page dash">
      <PageHeader
        eyebrow="My dashboard"
        title={firstName ? `Good day, ${firstName}` : 'Main Dashboard'}
        subtitle="Your profile, your inbox and the laboratory's quality picture — every figure opens the record behind it."
        actions={canView('notifications')
          ? <button className="secondary" type="button" onClick={() => navigate('/notifications')}><Bell size={16} /> Open inbox</button>
          : undefined}
      />

      {/* 1 — the person, and what is waiting on them */}
      <div className="dash-me">
        <DashboardProfileCard />
        {canView('notifications') && <DashboardInbox />}
      </div>

      {/* 1b — what they are on duty to do. Deliberately above the laboratory's
          numbers: the bench's own day comes before management's overview, and
          it needs no permission because it is the person's own work. */}
      <DutyTodoCard />

      {/* 2 — what needs attention across the laboratory. Both views read the
          live-alert feed, which is itself trimmed to the modules this reader
          may view, so they are shown only to someone who has that feed. */}
      {canView('notifications') && <AttentionCenter />}

      {/* 3 — the numbers behind it */}
      {kpis.length > 0 && <>
        <div className="section-title"><h3>Key numbers</h3></div>
        <KpiStrip items={kpis} />
      </>}

      {charts.length > 0 && <>
        <div className="section-title"><h3>Quality management overview</h3></div>
        <div className="grid cols-3 dash-charts">
          {charts.map(ch => <ChartCard key={ch.title} title={ch.title} subtitle={ch.subtitle}>{ch.body}</ChartCard>)}
        </div>
      </>}

      {canView('notifications') && <AlertsByModule />}
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
export function Organisation() { return <ModulePage moduleKey="organisation" title="Organisation & Leadership" eyebrow="Organisation and Leadership" />; }
export function Personnel() { return <ModulePage moduleKey="personnel" title="Personnel Management" />; }
