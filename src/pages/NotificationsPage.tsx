import { FormEvent, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Bell, CheckCircle2, Clock, AlertTriangle, ArrowRight, Inbox } from 'lucide-react';
import PageHeader from '../components/ui/PageHeader';
import { KpiStrip, ChartCard, DonutChart, BarMeter, CHART_COLORS, AlertsByModule } from '../components/ui';
import { useModules } from '../hooks/useModules';
import { api } from '../services/api';
import DisabledModule from '../components/DisabledModule';
import { RecordsReportsPage } from './RecordsReportsPage';
import { MonthlyReportsPage } from './MonthlyReportsPage';
import type {
  NotificationRecord, NotificationRule, ReviewCalendarItem, UserTaskQueueItem,
  NotificationPreference, NotificationsSummary, Staff,
} from '../../shared/types/api';

const statusBadgeClass = (status?: string) => `badge ${status ? status.toLowerCase().replace(/\s+/g, '-') : 'unknown'}`;
const formatBadge = (status?: string) => <span className={statusBadgeClass(status)}>{status ? status.replace(/_/g, ' ') : 'Unknown'}</span>;
const tabBar = (active: string, tabs: string[], onChange: (name: string) => void) =>
  <div className="tabs">{tabs.map(name => <button key={name} type="button" className={active === name ? 'active' : ''} onClick={() => onChange(name)}>{name}</button>)}</div>;

const RULE_TRIGGERS = ['due_soon', 'overdue', 'expiry_alert', 'review_required', 'approval_required', 'follow_up', 'custom'];
const CALENDAR_STATUSES = ['pending', 'due_soon', 'overdue', 'completed', 'cancelled'];
const MODULES_FOR_PREFS = ['actions', 'documents', 'personnel', 'equipment', 'supplier_inventory', 'monitoring', 'iqc', 'eqa', 'verification_validation', 'measurement_uncertainty', 'blood_bank_handover', 'monthly_reports', 'assessments', 'meetings', 'management_review', 'quality_indicators', 'continual_improvement', 'customer_focus', 'poct', 'nc_capa', 'risks', 'complaints', 'facilities_safety', 'process_management', 'information_management', 'organisation'];

const SEV_TONE: Record<string, string> = { urgent: 'crit', high: 'crit', medium: 'warn', low: 'ok', info: 'info' };

export function NotificationsPage() {
  const { isEnabled } = useModules();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [tab, setTab] = useState('Dashboard');
  const [error, setError] = useState<string | null>(null);

  const [summary, setSummary] = useState<NotificationsSummary | null>(null);
  const [notifications, setNotifications] = useState<NotificationRecord[]>([]);
  const [tasks, setTasks] = useState<UserTaskQueueItem[]>([]);
  const [calendar, setCalendar] = useState<ReviewCalendarItem[]>([]);
  const [rules, setRules] = useState<NotificationRule[]>([]);
  const [prefs, setPrefs] = useState<NotificationPreference[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [generateResult, setGenerateResult] = useState<{ candidates: number; created?: number; skipped: number; recipients?: number } | null>(null);

  const [calFilter, setCalFilter] = useState({ moduleKey: '', itemType: '', status: '', from: '', to: '' });
  const [taskForm, setTaskForm] = useState({ title: '', description: '', moduleKey: '', priority: 'normal', dueDate: '', assignedToStaffId: '' });
  const [ruleForm, setRuleForm] = useState({ ruleName: '', moduleKey: '', triggerType: 'due_soon', dueField: '', reminderDaysBefore: '7', escalationDaysAfter: '14' });

  const [inboxSearch, setInboxSearch] = useState('');
  const [inboxFilter, setInboxFilter] = useState<'active' | 'all' | 'urgent' | 'today' | 'resolved'>('active');
  const [selected, setSelected] = useState<NotificationRecord | null>(null);

  async function load() {
    try {
      const [sum, n, t, c, r, p, s] = await Promise.all([
        api<NotificationsSummary>('/dashboard/notifications-summary').catch(() => null),
        api<NotificationRecord[]>('/notifications?mine=true'),
        api<UserTaskQueueItem[]>('/notifications/tasks?mine=true'),
        api<ReviewCalendarItem[]>('/notifications/calendar'),
        api<NotificationRule[]>('/notifications/rules'),
        api<NotificationPreference[]>('/notifications/preferences'),
        api<Staff[]>('/staff').catch(() => []),
      ]);
      if (sum) setSummary(sum);
      setNotifications(n); setTasks(t); setCalendar(c); setRules(r); setPrefs(p); setStaff(s);
    } catch (e) { setError((e as Error).message); }
  }
  useEffect(() => { if (isEnabled('notifications')) void load(); }, [isEnabled]);

  // Deep-link support: a dashboard triage click arrives as ?view=urgent|today|
  // all|active and opens the full inbox pre-filtered to that slice.
  useEffect(() => {
    const view = searchParams.get('view');
    if (view && ['active', 'all', 'urgent', 'today', 'resolved'].includes(view)) {
      setInboxFilter(view as typeof inboxFilter);
      setTab('Full Inbox');
    }
  }, [searchParams]);

  if (!isEnabled('notifications')) return <DisabledModule />;

  async function transition(id: number, action: 'read' | 'acknowledge' | 'resolve' | 'dismiss') {
    try { await api(`/notifications/${id}/${action}`, { method: 'POST', body: JSON.stringify({}) }); await load(); if (selected?.id === id) setSelected(null); }
    catch (e) { setError((e as Error).message); }
  }

  async function openNotification(n: NotificationRecord) {
    try {
      if (n.status === 'unread') await api(`/notifications/${n.id}/read`, { method: 'POST', body: JSON.stringify({}) });
      if (n.action_url) navigate(n.action_url);
      else setSelected(n);
      await load();
    } catch (e) { setError((e as Error).message); }
  }

  async function generateAlerts() {
    try { setGenerateResult(await api(`/notifications/auto-scan`, { method: 'POST', body: JSON.stringify({}) })); await load(); }
    catch (e) { setError((e as Error).message); }
  }

  async function reloadCalendar() {
    const params = new URLSearchParams();
    Object.entries(calFilter).forEach(([k, v]) => { if (v) params.set(k, String(v)); });
    try { setCalendar(await api<ReviewCalendarItem[]>(`/notifications/calendar?${params.toString()}`)); }
    catch (e) { setError((e as Error).message); }
  }

  async function completeCalendarItem(id: number) {
    try { await api(`/notifications/calendar/${id}/complete`, { method: 'POST', body: JSON.stringify({}) }); await reloadCalendar(); await load(); }
    catch (e) { setError((e as Error).message); }
  }

  async function submitTask(e: FormEvent) {
    e.preventDefault(); setError(null);
    try { await api('/notifications/tasks', { method: 'POST', body: JSON.stringify(taskForm) });
      setTaskForm({ title: '', description: '', moduleKey: '', priority: 'normal', dueDate: '', assignedToStaffId: '' });
      await load();
    } catch (e) { setError((e as Error).message); }
  }
  async function taskAction(id: number, action: 'start' | 'complete' | 'cancel') { try { await api(`/notifications/tasks/${id}/${action}`, { method: 'POST', body: JSON.stringify({}) }); await load(); } catch (e) { setError((e as Error).message); } }

  async function submitRule(e: FormEvent) {
    e.preventDefault(); setError(null);
    try { await api('/notifications/rules', { method: 'POST', body: JSON.stringify(ruleForm) });
      setRuleForm({ ruleName: '', moduleKey: '', triggerType: 'due_soon', dueField: '', reminderDaysBefore: '7', escalationDaysAfter: '14' });
      await load();
    } catch (e) { setError((e as Error).message); }
  }
  async function toggleRule(id: number) { try { await api(`/notifications/rules/${id}/toggle`, { method: 'POST', body: JSON.stringify({}) }); await load(); } catch (e) { setError((e as Error).message); } }

  async function savePrefs() {
    const payload = MODULES_FOR_PREFS.map(m => {
      const cur = prefs.find(p => p.module_key === m);
      return { moduleKey: m, inAppEnabled: cur ? !!cur.in_app_enabled : true, digestEnabled: cur ? !!cur.digest_enabled : false, emailEnabled: cur ? !!cur.email_enabled : false, smsEnabled: cur ? !!cur.sms_enabled : false };
    });
    try { await api('/notifications/preferences', { method: 'PUT', body: JSON.stringify({ preferences: payload }) }); await load(); }
    catch (e) { setError((e as Error).message); }
  }

  function setPrefField(moduleKey: string, field: 'in_app_enabled' | 'digest_enabled' | 'email_enabled' | 'sms_enabled', value: boolean) {
    setPrefs(prev => {
      const idx = prev.findIndex(p => p.module_key === moduleKey);
      if (idx === -1) return [...prev, { id: 0, module_key: moduleKey, in_app_enabled: field === 'in_app_enabled' ? (value ? 1 : 0) : 1, digest_enabled: field === 'digest_enabled' ? (value ? 1 : 0) : 0, email_enabled: field === 'email_enabled' ? (value ? 1 : 0) : 0, sms_enabled: field === 'sms_enabled' ? (value ? 1 : 0) : 0, created_at: '' }];
      const copy = [...prev];
      copy[idx] = { ...copy[idx], [field]: value ? 1 : 0 };
      return copy;
    });
  }

  const now = new Date().toISOString().slice(0, 10);
  const filteredInbox = useMemo(() => {
    let list = notifications;
    if (inboxFilter === 'active') list = list.filter(n => n.status !== 'resolved' && n.status !== 'dismissed');
    else if (inboxFilter === 'resolved') list = list.filter(n => n.status === 'resolved' || n.status === 'dismissed');
    else if (inboxFilter === 'urgent') list = list.filter(n => ['urgent', 'high'].includes(n.severity) && n.status !== 'resolved' && n.status !== 'dismissed');
    else if (inboxFilter === 'today') list = list.filter(n => n.due_date === now && n.status !== 'resolved' && n.status !== 'dismissed');
    if (inboxSearch.trim()) {
      const q = inboxSearch.toLowerCase();
      list = list.filter(n => (n.title || '').toLowerCase().includes(q) || (n.message || '').toLowerCase().includes(q) || (n.module_key || '').toLowerCase().includes(q));
    }
    return list;
  }, [notifications, inboxFilter, inboxSearch, now]);

  const activeCount = notifications.filter(n => n.status !== 'resolved' && n.status !== 'dismissed').length;
  const urgentCount = notifications.filter(n => ['urgent', 'high'].includes(n.severity) && n.status !== 'resolved' && n.status !== 'dismissed').length;
  const overdueCount = notifications.filter(n => n.due_date && n.due_date < now && n.status !== 'resolved' && n.status !== 'dismissed').length;
  const todayCount = notifications.filter(n => n.due_date === now && n.status !== 'resolved' && n.status !== 'dismissed').length;

  const NOTIF_TABS = ['Dashboard', 'Full Inbox', 'My Tasks', 'Review Calendar', 'Generate Alerts', 'Notification Rules', 'Preferences'];
  const inNotifications = NOTIF_TABS.includes(tab);
  const topTabs: { key: string; active: boolean; go: () => void }[] = [
    { key: 'Notifications & Alerts', active: inNotifications, go: () => setTab('Dashboard') },
    ...(isEnabled('records_reports') ? [{ key: 'Records, Reports & Evidence', active: tab === 'Records, Reports & Evidence', go: () => setTab('Records, Reports & Evidence') }] : []),
    ...(isEnabled('monthly_reports') ? [{ key: 'Monthly Reports & Archives', active: tab === 'Monthly Reports & Archives', go: () => setTab('Monthly Reports & Archives') }] : []),
  ];

  return <div className="module-page">
    <PageHeader eyebrow="Notifications &amp; Reports" title="Notifications &amp; Reports" subtitle="A professional inbox that never lets you miss an action. Every notification opens the record it points to and clears itself once the work is done." />
    <div className="tabs">{topTabs.map(t => <button key={t.key} type="button" className={t.active ? 'active' : ''} onClick={t.go}>{t.key}</button>)}</div>
    {inNotifications && tabBar(tab, NOTIF_TABS, setTab)}
    {error && <div className="error">{error}</div>}

    {tab === 'Records, Reports & Evidence' && <RecordsReportsPage embedded />}
    {tab === 'Monthly Reports & Archives' && <MonthlyReportsPage embedded />}

    {/* Dashboard now merges the inbox, live alerts and metrics into one view. */}
    {tab === 'Dashboard' && summary && <>
      <div className="inbox-summary-band">
        <SummaryTile icon={<Inbox size={18} />} tone="accent" label="Active in inbox" value={activeCount} onClick={() => setInboxFilter('active')} active={inboxFilter === 'active'} />
        <SummaryTile icon={<AlertTriangle size={18} />} tone="crit" label="Urgent / high" value={urgentCount} onClick={() => setInboxFilter('urgent')} active={inboxFilter === 'urgent'} />
        <SummaryTile icon={<Clock size={18} />} tone="warn" label="Due today" value={todayCount} onClick={() => setInboxFilter('today')} active={inboxFilter === 'today'} />
        <SummaryTile icon={<Clock size={18} />} tone="crit" label="Overdue" value={overdueCount} onClick={() => setInboxFilter('all')} active={false} />
        <SummaryTile icon={<CheckCircle2 size={18} />} tone="ok" label="Resolved" value={notifications.length - activeCount} onClick={() => setInboxFilter('resolved')} active={inboxFilter === 'resolved'} />
      </div>

      <InboxPanel
        title="Your inbox"
        list={filteredInbox}
        filter={inboxFilter}
        onFilterChange={setInboxFilter}
        search={inboxSearch}
        onSearchChange={setInboxSearch}
        onOpen={openNotification}
        onTransition={transition}
      />

      {/* Consolidated live alerts across the whole system as one compact chart */}
      <AlertsByModule />

      <div className="grid cols-2" style={{ marginTop: 18 }}>
        <ChartCard title="Timeliness" subtitle="Notifications by due-date pressure">
          <DonutChart centerLabel="Items" data={[
            { label: 'Due today', value: summary.dueToday, color: CHART_COLORS[2] },
            { label: 'Due soon', value: summary.dueSoon, color: CHART_COLORS[0] },
            { label: 'Overdue', value: summary.overdue, color: CHART_COLORS[3] },
          ]} />
        </ChartCard>
        <ChartCard title="Task workload" subtitle="Open items awaiting action">
          <BarMeter data={[
            { label: 'Open tasks', value: summary.openTasks, color: CHART_COLORS[0] },
            { label: 'Pending approvals', value: summary.pendingApprovals, color: CHART_COLORS[2] },
            { label: 'Follow-ups due', value: summary.followUpsDue, color: CHART_COLORS[4] },
            { label: 'Review items due', value: summary.reviewItemsDue, color: CHART_COLORS[5] },
          ]} />
        </ChartCard>
      </div>
    </>}

    {tab === 'Full Inbox' && <InboxPanel
      title="Full inbox"
      list={filteredInbox}
      filter={inboxFilter}
      onFilterChange={setInboxFilter}
      search={inboxSearch}
      onSearchChange={setInboxSearch}
      onOpen={openNotification}
      onTransition={transition}
      showFilters
    />}

    {tab === 'My Tasks' && <>
      <form className="form-grid" onSubmit={submitTask}>
        <label>Title<input value={taskForm.title} onChange={e => setTaskForm({ ...taskForm, title: e.target.value })} required /></label>
        <label>Module<input value={taskForm.moduleKey} onChange={e => setTaskForm({ ...taskForm, moduleKey: e.target.value })} placeholder="e.g. equipment" /></label>
        <label>Priority<select value={taskForm.priority} onChange={e => setTaskForm({ ...taskForm, priority: e.target.value })}><option value="low">low</option><option value="normal">normal</option><option value="high">high</option><option value="urgent">urgent</option></select></label>
        <label>Due date<input type="date" value={taskForm.dueDate} onChange={e => setTaskForm({ ...taskForm, dueDate: e.target.value })} /></label>
        <label>Assigned to<select value={taskForm.assignedToStaffId} onChange={e => setTaskForm({ ...taskForm, assignedToStaffId: e.target.value })}><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
        <label>Description<textarea value={taskForm.description} onChange={e => setTaskForm({ ...taskForm, description: e.target.value })} /></label>
        <button type="submit">Create task</button>
      </form>
      <table className="data-table"><thead><tr><th>Number</th><th>Title</th><th>Module</th><th>Priority</th><th>Due</th><th>Status</th><th></th></tr></thead><tbody>
        {tasks.map(t => <tr key={t.id}><td>{t.task_number}</td><td>{t.title}</td><td>{t.module_key || '—'}</td><td>{t.priority}</td><td>{t.due_date || '—'}</td><td>{formatBadge(t.status)}</td>
          <td>
            {t.status === 'open' && <button onClick={() => taskAction(t.id, 'start')}>Start</button>}
            {t.status !== 'completed' && t.status !== 'cancelled' && <button onClick={() => taskAction(t.id, 'complete')}>Complete</button>}
            {t.status !== 'completed' && t.status !== 'cancelled' && <button onClick={() => taskAction(t.id, 'cancel')}>Cancel</button>}
          </td></tr>)}
      </tbody></table>
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
      <p className="muted">This scan also runs automatically in the background every 15 minutes and opportunistically as the dashboards are used, so alerts appear without anyone pressing this button.</p>
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

    {tab === 'Preferences' && <>
      <p>Per-module notification preferences. <strong>Email and SMS delivery are placeholders</strong> until a delivery integration is wired; in-app preferences are honoured today.</p>
      <table className="data-table"><thead><tr><th>Module</th><th>In-app</th><th>Digest</th><th>Email</th><th>SMS</th></tr></thead><tbody>
        {MODULES_FOR_PREFS.map(m => {
          const cur = prefs.find(p => p.module_key === m);
          return <tr key={m}>
            <td>{m.replace(/_/g, ' ')}</td>
            <td><input type="checkbox" checked={cur ? !!cur.in_app_enabled : true} onChange={e => setPrefField(m, 'in_app_enabled', e.target.checked)} /></td>
            <td><input type="checkbox" checked={cur ? !!cur.digest_enabled : false} onChange={e => setPrefField(m, 'digest_enabled', e.target.checked)} /></td>
            <td><input type="checkbox" checked={cur ? !!cur.email_enabled : false} onChange={e => setPrefField(m, 'email_enabled', e.target.checked)} /></td>
            <td><input type="checkbox" checked={cur ? !!cur.sms_enabled : false} onChange={e => setPrefField(m, 'sms_enabled', e.target.checked)} /></td>
          </tr>;
        })}
      </tbody></table>
      <button type="button" onClick={savePrefs}>Save preferences</button>
    </>}

    {selected && <div className="doc-drawer-overlay" onClick={() => setSelected(null)}>
      <div className="doc-drawer" onClick={e => e.stopPropagation()}>
        <div className="doc-drawer-panel">
          <div className="doc-drawer-head">
            <div>
              <span className="hint">{selected.notification_number || '—'} · {selected.module_key}</span>
              <h3 style={{ margin: '2px 0 0' }}>{selected.title}</h3>
            </div>
            <button className="drawer-close" onClick={() => setSelected(null)}>×</button>
          </div>
          <div className="doc-drawer-body">
            <p>{selected.message}</p>
            <p style={{ margin: '4px 0' }}><strong>Severity:</strong> {formatBadge(selected.severity)} · <strong>Type:</strong> {selected.notification_type.replace(/_/g, ' ')} · <strong>Status:</strong> {formatBadge(selected.status)}</p>
            <p style={{ margin: '4px 0' }}><strong>Due:</strong> {selected.due_date || '—'} · <strong>Created:</strong> {String(selected.created_at).slice(0, 10)}</p>
            <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {selected.action_url && <button onClick={() => { navigate(selected.action_url!); setSelected(null); }}>{selected.action_label || 'Open'}</button>}
              {selected.status !== 'acknowledged' && <button className="secondary" onClick={() => transition(selected.id, 'acknowledge')}>Acknowledge</button>}
              {selected.status !== 'resolved' && <button className="secondary" onClick={() => transition(selected.id, 'resolve')}>Mark resolved</button>}
              {selected.status !== 'dismissed' && <button className="secondary" onClick={() => transition(selected.id, 'dismiss')}>Dismiss</button>}
            </div>
          </div>
        </div>
      </div>
    </div>}
  </div>;
}

function SummaryTile({ icon, tone, label, value, onClick, active }: { icon: React.ReactNode; tone: string; label: string; value: number; onClick: () => void; active: boolean }) {
  return (
    <button type="button" className={`inbox-tile tone-${tone} ${active ? 'is-active' : ''}`} onClick={onClick}>
      <span className="inbox-tile-ico">{icon}</span>
      <span className="inbox-tile-body">
        <span className="inbox-tile-value">{value}</span>
        <span className="inbox-tile-label">{label}</span>
      </span>
    </button>
  );
}

// InboxPanel — the professional, theme-aware inbox surface used on the module
// dashboard and the Full Inbox tab.
function InboxPanel({ title, list, filter, onFilterChange, search, onSearchChange, onOpen, onTransition, showFilters }: {
  title: string;
  list: NotificationRecord[];
  filter: string; onFilterChange: (f: any) => void;
  search: string; onSearchChange: (s: string) => void;
  onOpen: (n: NotificationRecord) => void;
  onTransition: (id: number, action: 'read' | 'acknowledge' | 'resolve' | 'dismiss') => void;
  showFilters?: boolean;
}) {
  const now = new Date().toISOString().slice(0, 10);
  return (
    <section className="alert-section">
      <div className="alert-section-head">
        <h3>{title}</h3>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input value={search} onChange={e => onSearchChange(e.target.value)} placeholder="Search notifications…" style={{ minWidth: 200 }} />
          <div className="tabs" style={{ marginBottom: 0 }}>
            {[{ k: 'active', l: 'Active' }, { k: 'all', l: 'All' }, { k: 'urgent', l: 'Urgent' }, { k: 'today', l: 'Today' }, { k: 'resolved', l: 'Resolved' }].map(f =>
              <button key={f.k} type="button" className={filter === f.k ? 'active' : ''} onClick={() => onFilterChange(f.k)}>{f.l}</button>)}
          </div>
        </div>
      </div>

      {list.length === 0 ? (
        <div className="alert-empty big"><CheckCircle2 size={20} /> <span>Nothing here. New notifications appear when the system needs your attention.</span></div>
      ) : (
        <div className="inbox-strip-grid" style={{ padding: 0 }}>
          {list.map(n => {
            const tone = SEV_TONE[n.severity] || 'info';
            const isOverdue = n.due_date && n.due_date < now;
            const isToday = n.due_date === now;
            return (
              <div key={n.id} className={`inbox-item sev-${tone} ${n.status !== 'unread' ? 'is-read' : ''}`} onClick={() => onOpen(n)}>
                <div style={{ marginTop: 2 }}>
                  {(n.severity === 'urgent' || n.severity === 'high') ? <AlertTriangle size={14} style={{ color: 'var(--danger)' }} /> : <Bell size={14} style={{ color: 'var(--muted)' }} />}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="inbox-item-title">{n.title}</div>
                  {n.message && <div className="inbox-item-msg">{n.message}</div>}
                  <div className="inbox-item-meta">
                    <span className="badge">{n.module_key}</span>
                    {n.due_date && <span style={{ color: isOverdue ? 'var(--danger)' : isToday ? 'var(--warning)' : 'var(--faint)', fontWeight: 600 }}>
                      {isOverdue ? `Overdue ${n.due_date}` : isToday ? 'Due today' : n.due_date}
                    </span>}
                    {n.action_label && n.status !== 'resolved' && <span style={{ color: 'var(--accent-bright)', fontWeight: 600 }}>{n.action_label} <ArrowRight size={11} style={{ verticalAlign: 'middle' }} /></span>}
                  </div>
                </div>
                {n.status !== 'resolved' && n.status !== 'dismissed' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }} onClick={e => e.stopPropagation()}>
                    <button className="inbox-item-x" title="Mark resolved" onClick={() => onTransition(n.id, 'resolve')}>✓</button>
                    <button className="inbox-item-x" title="Dismiss" onClick={() => onTransition(n.id, 'dismiss')}>×</button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
