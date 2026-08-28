import { FormEvent, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { IdCard } from 'lucide-react';
import PageHeader from '../components/ui/PageHeader';
import { ChartCard, DonutChart, BarMeter, CHART_COLORS, AlertsByModule } from '../components/ui';
import { useModules } from '../hooks/useModules';
import { usePermissions } from '../hooks/usePermissions';
import { api, errorText, apiRead } from '../services/api';
import DisabledModule from '../components/DisabledModule';
import { RecordsReportsPage } from './RecordsReportsPage';
import { MonthlyReportsPage } from './MonthlyReportsPage';
import PermissionTabs from '../components/PermissionTabs';
import type { NotificationRule, ReviewCalendarItem, NotificationsSummary } from '../../shared/types/api';

/**
 * Notifications & Reports — the laboratory's alerting machinery.
 *
 * This module used to hold two different things under one roof: the machinery
 * that raises alerts, and one person's inbox of them. The second was never a
 * report — it is a queue of work belonging to a named individual — and it has
 * moved to My Portal, alongside the rest of that person's file, together with
 * their task queue and their own notification preferences.
 *
 * What remains is what the laboratory as a whole owns: the alert overview, the
 * review calendar, the rules that raise alerts and the scan that runs them,
 * plus the reports and archives already embedded here.
 */
const statusBadgeClass = (status?: string) => `badge ${status ? status.toLowerCase().replace(/\s+/g, '-') : 'unknown'}`;
const formatBadge = (status?: string) => <span className={statusBadgeClass(status)}>{status ? status.replace(/_/g, ' ') : 'Unknown'}</span>;
// Tabs are filtered by permission — a tab whose feature this user cannot
// view is not drawn. See src/components/PermissionTabs.tsx.
const TAB_MODULE = 'notifications';
const tabBar = (active: string, tabs: string[], onChange: (name: string) => void) =>
  <PermissionTabs moduleKey={TAB_MODULE} tabs={tabs} active={active} onChange={onChange} />;

const RULE_TRIGGERS = ['due_soon', 'overdue', 'expiry_alert', 'review_required', 'approval_required', 'follow_up', 'custom'];
const CALENDAR_STATUSES = ['pending', 'due_soon', 'overdue', 'completed', 'cancelled'];

const NOTIF_TABS = ['Alert Overview', 'Review Calendar', 'Notification Rules', 'Generate Alerts'];

export function NotificationsPage() {
  const { canView } = usePermissions();
  const { isEnabled } = useModules();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [tab, setTab] = useState('Alert Overview');
  const [error, setError] = useState<string | null>(null);

  const [summary, setSummary] = useState<NotificationsSummary | null>(null);
  const [calendar, setCalendar] = useState<ReviewCalendarItem[]>([]);
  const [rules, setRules] = useState<NotificationRule[]>([]);
  const [generateResult, setGenerateResult] = useState<{ candidates: number; created?: number; skipped: number; recipients?: number } | null>(null);

  const [calFilter, setCalFilter] = useState({ moduleKey: '', itemType: '', status: '', from: '', to: '' });
  const [ruleForm, setRuleForm] = useState({ ruleName: '', moduleKey: '', triggerType: 'due_soon', dueField: '', reminderDaysBefore: '7', escalationDaysAfter: '14' });

  async function load() {
    try {
      const [sum, c, r] = await Promise.all([
        api<NotificationsSummary>('/dashboard/notifications-summary').catch(() => null),
        apiRead<ReviewCalendarItem[]>('/notifications/calendar', []),
        apiRead<NotificationRule[]>('/notifications/rules', []),
      ]);
      if (sum) setSummary(sum);
      setCalendar(c); setRules(r);
    } catch (e) { setError(errorText(e)); }
  }
  useEffect(() => { if (isEnabled('notifications')) void load(); }, [isEnabled]);

  // Old links pointed the inbox here with ?view=urgent|today|… . The inbox is
  // in My Portal now, so those links follow it rather than dead-ending.
  useEffect(() => {
    const view = searchParams.get('view');
    if (view) navigate(`/my-portal?tab=My%20Inbox&view=${encodeURIComponent(view)}`, { replace: true });
  }, [searchParams, navigate]);

  if (!isEnabled('notifications')) return <DisabledModule />;

  async function generateAlerts() {
    try { setGenerateResult(await api(`/notifications/auto-scan`, { method: 'POST', body: JSON.stringify({}) })); await load(); }
    catch (e) { setError(errorText(e)); }
  }

  async function reloadCalendar() {
    const params = new URLSearchParams();
    Object.entries(calFilter).forEach(([k, v]) => { if (v) params.set(k, String(v)); });
    try { setCalendar(await api<ReviewCalendarItem[]>(`/notifications/calendar?${params.toString()}`)); }
    catch (e) { setError(errorText(e)); }
  }

  async function completeCalendarItem(id: number) {
    try { await api(`/notifications/calendar/${id}/complete`, { method: 'POST', body: JSON.stringify({}) }); await reloadCalendar(); await load(); }
    catch (e) { setError(errorText(e)); }
  }

  async function submitRule(e: FormEvent) {
    e.preventDefault(); setError(null);
    try {
      await api('/notifications/rules', { method: 'POST', body: JSON.stringify(ruleForm) });
      setRuleForm({ ruleName: '', moduleKey: '', triggerType: 'due_soon', dueField: '', reminderDaysBefore: '7', escalationDaysAfter: '14' });
      await load();
    } catch (e) { setError(errorText(e)); }
  }
  async function toggleRule(id: number) {
    try { await api(`/notifications/rules/${id}/toggle`, { method: 'POST', body: JSON.stringify({}) }); await load(); }
    catch (e) { setError(errorText(e)); }
  }

  const inNotifications = NOTIF_TABS.includes(tab);
  const topTabs: { key: string; active: boolean; go: () => void }[] = [
    { key: 'Notifications & Alerts', active: inNotifications, go: () => setTab('Alert Overview') },
    // Both switch into other modules and take their own rights.
    ...(isEnabled('records_reports') && canView('records_reports') ? [{ key: 'Records, Reports & Evidence', active: tab === 'Records, Reports & Evidence', go: () => setTab('Records, Reports & Evidence') }] : []),
    ...(isEnabled('monthly_reports') && canView('monthly_reports') ? [{ key: 'Monthly Reports & Archives', active: tab === 'Monthly Reports & Archives', go: () => setTab('Monthly Reports & Archives') }] : []),
  ];

  return <div className="module-page">
    <PageHeader
      eyebrow="Notifications &amp; Reports"
      title="Notifications &amp; Reports"
      subtitle="The machinery behind the laboratory's alerts — what is due, what raises a reminder, and the reports built from it. Your own inbox and tasks are in My Portal."
      actions={<button className="secondary" type="button" onClick={() => navigate('/my-portal?tab=My%20Inbox')}><IdCard size={16} /> My inbox</button>}
    />
    <div className="tabs">{topTabs.map(t => <button key={t.key} type="button" className={t.active ? 'active' : ''} onClick={t.go}>{t.key}</button>)}</div>
    {inNotifications && tabBar(tab, NOTIF_TABS, setTab)}
    {error && <div className="error">{error}</div>}

    {tab === 'Records, Reports & Evidence' && <RecordsReportsPage embedded />}
    {tab === 'Monthly Reports & Archives' && <MonthlyReportsPage embedded />}

    {/* The laboratory's alert picture: where alerts are concentrated, how much
        is under time pressure, and how much work is open across everyone. */}
    {tab === 'Alert Overview' && <>
      <AlertsByModule />
      {summary && <div className="grid cols-2" style={{ marginTop: 18 }}>
        <ChartCard title="Timeliness" subtitle="Alerts by due-date pressure">
          <DonutChart centerLabel="Items" data={[
            { label: 'Due today', value: summary.dueToday, color: CHART_COLORS[2] },
            { label: 'Due soon', value: summary.dueSoon, color: CHART_COLORS[0] },
            { label: 'Overdue', value: summary.overdue, color: CHART_COLORS[3] },
          ]} />
        </ChartCard>
        <ChartCard title="Workload across the laboratory" subtitle="Open items awaiting action">
          <BarMeter data={[
            { label: 'Open tasks', value: summary.openTasks, color: CHART_COLORS[0] },
            { label: 'Pending approvals', value: summary.pendingApprovals, color: CHART_COLORS[2] },
            { label: 'Follow-ups due', value: summary.followUpsDue, color: CHART_COLORS[4] },
            { label: 'Review items due', value: summary.reviewItemsDue, color: CHART_COLORS[5] },
          ]} />
        </ChartCard>
      </div>}
    </>}

    {tab === 'Review Calendar' && <>
      <div className="form-grid">
        <label>Module<input value={calFilter.moduleKey} onChange={e => setCalFilter({ ...calFilter, moduleKey: e.target.value })} placeholder="any" /></label>
        <label>Item type<input value={calFilter.itemType} onChange={e => setCalFilter({ ...calFilter, itemType: e.target.value })} placeholder="any" /></label>
        <label>Status<select value={calFilter.status} onChange={e => setCalFilter({ ...calFilter, status: e.target.value })}><option value="">any</option>{CALENDAR_STATUSES.map(s => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}</select></label>
        <label>From<input type="date" value={calFilter.from} onChange={e => setCalFilter({ ...calFilter, from: e.target.value })} /></label>
        <label>To<input type="date" value={calFilter.to} onChange={e => setCalFilter({ ...calFilter, to: e.target.value })} /></label>
        <button type="button" onClick={reloadCalendar}>Apply filters</button>
      </div>
      <table className="data-table"><thead><tr><th>Number</th><th>Title</th><th>Module</th><th>Item type</th><th>Due</th><th>Status</th><th></th></tr></thead><tbody>
        {calendar.map(c => <tr key={c.id}><td>{c.calendar_number || '—'}</td><td>{c.title}</td><td>{c.module_key}</td><td>{c.item_type.replace(/_/g, ' ')}</td><td>{c.due_date}</td><td>{formatBadge(c.status)}</td>
          <td>{c.status !== 'completed' && c.status !== 'cancelled' && <button onClick={() => completeCalendarItem(c.id)}>Complete</button>}</td></tr>)}
      </tbody></table>
    </>}

    {tab === 'Generate Alerts' && <>
      <p>Run the routed alert scan now. This walks every module for due, overdue, expiring, excursion, pending-review and pending-approval items, then routes a notification to each responsible person, section head/staff, and the relevant managers — deduplicated against existing open notifications.</p>
      <p className="muted">This scan also runs automatically in the background every 15 minutes and opportunistically as the dashboards are used, so alerts appear without anyone pressing this button. Each person reads what it routed to them in My Portal.</p>
      <button type="button" onClick={generateAlerts}>Run routed scan now</button>
      {generateResult && <p style={{ marginTop: 12 }}>Scanned {generateResult.candidates} condition(s) · routed {generateResult.created ?? 0} new notification(s) to {generateResult.recipients ?? 0} recipient slot(s) · skipped {generateResult.skipped} existing.</p>}
    </>}

    {tab === 'Notification Rules' && <>
      <form className="form-grid" onSubmit={submitRule}>
        <label>Name<input value={ruleForm.ruleName} onChange={e => setRuleForm({ ...ruleForm, ruleName: e.target.value })} required /></label>
        <label>Module<input value={ruleForm.moduleKey} onChange={e => setRuleForm({ ...ruleForm, moduleKey: e.target.value })} required /></label>
        <label>Trigger<select value={ruleForm.triggerType} onChange={e => setRuleForm({ ...ruleForm, triggerType: e.target.value })}>{RULE_TRIGGERS.map(t => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}</select></label>
        <label>Due field<input value={ruleForm.dueField} onChange={e => setRuleForm({ ...ruleForm, dueField: e.target.value })} placeholder="e.g. due_date" /></label>
        <label>Reminder days before<input type="number" value={ruleForm.reminderDaysBefore} onChange={e => setRuleForm({ ...ruleForm, reminderDaysBefore: e.target.value })} /></label>
        <label>Escalation days after<input type="number" value={ruleForm.escalationDaysAfter} onChange={e => setRuleForm({ ...ruleForm, escalationDaysAfter: e.target.value })} /></label>
        <button type="submit">Create rule</button>
      </form>
      <table className="data-table"><thead><tr><th>Code</th><th>Name</th><th>Module</th><th>Trigger</th><th>Reminder</th><th>Escalation</th><th>Active</th><th></th></tr></thead><tbody>
        {rules.map(r => <tr key={r.id}><td>{r.rule_code || '—'}</td><td>{r.rule_name}</td><td>{r.module_key}</td><td>{r.trigger_type.replace(/_/g, ' ')}</td><td>{r.reminder_days_before ?? '—'}</td><td>{r.escalation_days_after ?? '—'}</td><td>{r.is_active ? 'Yes' : 'No'}</td><td><button onClick={() => toggleRule(r.id)}>Toggle</button></td></tr>)}
      </tbody></table>
    </>}
  </div>;
}
