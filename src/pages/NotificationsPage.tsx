import { FormEvent, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, CheckCircle2, Clock, AlertTriangle, ArrowRight, Inbox, Archive, Filter } from 'lucide-react';
import PageHeader from '../components/ui/PageHeader';
import { KpiStrip, ChartCard, DonutChart, BarMeter, CHART_COLORS } from '../components/ui';
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

const NOTIFICATION_TYPES = ['due_soon', 'overdue', 'review_required', 'approval_required', 'follow_up', 'expiry_alert', 'task_assigned', 'system_notice'];
const SEVERITIES = ['info', 'low', 'medium', 'high', 'urgent'];
const RULE_TRIGGERS = ['due_soon', 'overdue', 'expiry_alert', 'review_required', 'approval_required', 'follow_up', 'custom'];
const CALENDAR_STATUSES = ['pending', 'due_soon', 'overdue', 'completed', 'cancelled'];
const MODULES_FOR_PREFS = ['actions', 'documents', 'personnel', 'equipment', 'supplier_inventory', 'monitoring', 'iqc', 'eqa', 'verification_validation', 'measurement_uncertainty', 'blood_bank_handover', 'monthly_reports', 'assessments', 'meetings', 'management_review', 'quality_indicators', 'continual_improvement', 'customer_focus', 'poct', 'nc_capa', 'risks', 'complaints'];

const SEVERITY_COLOR: Record<string, string> = {
  urgent: '#dc2626', high: '#ea580c', medium: '#0ea5e9', low: '#64748b', info: '#94a3b8',
};

export function NotificationsPage() {
  const { isEnabled } = useModules();
  const navigate = useNavigate();
  const [tab, setTab] = useState('Inbox');
  const [error, setError] = useState<string | null>(null);

  const [summary, setSummary] = useState<NotificationsSummary | null>(null);
  const [notifications, setNotifications] = useState<NotificationRecord[]>([]);
  const [tasks, setTasks] = useState<UserTaskQueueItem[]>([]);
  const [calendar, setCalendar] = useState<ReviewCalendarItem[]>([]);
  const [rules, setRules] = useState<NotificationRule[]>([]);
  const [prefs, setPrefs] = useState<NotificationPreference[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [generateResult, setGenerateResult] = useState<{ candidates: number; notificationsCreated: number; calendarItemsCreated: number; skipped: number } | null>(null);

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
  if (!isEnabled('notifications')) return <DisabledModule />;

  async function transition(id: number, action: 'read' | 'acknowledge' | 'resolve' | 'dismiss') {
    try { await api(`/notifications/${id}/${action}`, { method: 'POST', body: JSON.stringify({}) }); await load(); if (selected?.id === id) setSelected(null); }
    catch (e) { setError((e as Error).message); }
  }

  // Open a notification: mark it read, navigate to the action URL if present,
  // and let the target page auto-resolve the notification when the required
  // work is done. If no action URL, show the details drawer instead.
  async function openNotification(n: NotificationRecord) {
    try {
      if (n.status === 'unread') await api(`/notifications/${n.id}/read`, { method: 'POST', body: JSON.stringify({}) });
      if (n.action_url) navigate(n.action_url);
      else setSelected(n);
      await load();
    } catch (e) { setError((e as Error).message); }
  }

  async function generateAlerts() {
    try { setGenerateResult(await api(`/notifications/calendar/generate`, { method: 'POST', body: JSON.stringify({}) })); await load(); }
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

  const NOTIF_TABS = ['Inbox', 'My Tasks', 'Review Calendar', 'Generate Alerts', 'Notification Rules', 'Preferences', 'Reports'];
  const inNotifications = NOTIF_TABS.includes(tab);
  const topTabs: { key: string; active: boolean; go: () => void }[] = [
    { key: 'Dashboard', active: tab === 'Dashboard', go: () => setTab('Dashboard') },
    { key: 'Notifications & Review Calendar', active: inNotifications, go: () => setTab('Inbox') },
    ...(isEnabled('records_reports') ? [{ key: 'Records, Reports & Evidence', active: tab === 'Records, Reports & Evidence', go: () => setTab('Records, Reports & Evidence') }] : []),
    ...(isEnabled('monthly_reports') ? [{ key: 'Monthly Reports & Archives', active: tab === 'Monthly Reports & Archives', go: () => setTab('Monthly Reports & Archives') }] : []),
  ];

  return <div className="module-page">
    <PageHeader eyebrow="Notifications &amp; Reports" title="Notifications &amp; Reports" subtitle="A professional inbox that never lets you miss an action. Every notification opens the record it points to, and clears itself once the work is done." />
    <div className="tabs">{topTabs.map(t => <button key={t.key} type="button" className={t.active ? 'active' : ''} onClick={t.go}>{t.key}</button>)}</div>
    {inNotifications && tabBar(tab, NOTIF_TABS, setTab)}
    {error && <div className="error">{error}</div>}

    {tab === 'Records, Reports & Evidence' && <RecordsReportsPage embedded />}
    {tab === 'Monthly Reports & Archives' && <MonthlyReportsPage embedded />}

    {tab === 'Dashboard' && (summary ? <>
      <KpiStrip items={[
        { label: 'Active in inbox', value: activeCount, onClick: () => setTab('Inbox') },
        { label: 'Urgent / high', value: urgentCount, tone: urgentCount ? 'danger' : undefined, onClick: () => { setInboxFilter('urgent'); setTab('Inbox'); } },
        { label: 'Due today', value: todayCount, tone: todayCount ? 'warning' : undefined, onClick: () => { setInboxFilter('today'); setTab('Inbox'); } },
        { label: 'Overdue', value: overdueCount, tone: overdueCount ? 'danger' : undefined, onClick: () => setTab('Inbox') },
        { label: 'Open tasks', value: summary.openTasks, onClick: () => setTab('My Tasks') },
        { label: 'My tasks', value: summary.myOpenTasks, onClick: () => setTab('My Tasks') },
        { label: 'Approvals', value: summary.pendingApprovals, onClick: () => setTab('Inbox') },
        { label: 'Reviews due', value: summary.reviewItemsDue, onClick: () => setTab('Review Calendar') },
      ]} />
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
    </> : <p>Loading…</p>)}

    {tab === 'Inbox' && <InboxView
      list={filteredInbox}
      total={notifications.length}
      activeCount={activeCount}
      urgentCount={urgentCount}
      todayCount={todayCount}
      overdueCount={overdueCount}
      filter={inboxFilter}
      onFilterChange={setInboxFilter}
      search={inboxSearch}
      onSearchChange={setInboxSearch}
      onOpen={openNotification}
      onTransition={transition}
      selected={selected}
      onCloseSelected={() => setSelected(null)}
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
      <p>Run the internal reminder scan. This walks every module's due/expiry/review fields and creates unread notifications + review-calendar items for new findings only — existing open notifications and calendar entries for the same record/type/due-date are skipped to avoid duplicates.</p>
      <button type="button" onClick={generateAlerts}>Run scan now</button>
      {generateResult && <p style={{ marginTop: 12 }}>Scanned {generateResult.candidates} candidate(s) · created {generateResult.notificationsCreated} notification(s) · {generateResult.calendarItemsCreated} calendar item(s) · skipped {generateResult.skipped} duplicate(s).</p>}
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
            <td>{m}</td>
            <td><input type="checkbox" checked={cur ? !!cur.in_app_enabled : true} onChange={e => setPrefField(m, 'in_app_enabled', e.target.checked)} /></td>
            <td><input type="checkbox" checked={cur ? !!cur.digest_enabled : false} onChange={e => setPrefField(m, 'digest_enabled', e.target.checked)} /></td>
            <td><input type="checkbox" checked={cur ? !!cur.email_enabled : false} onChange={e => setPrefField(m, 'email_enabled', e.target.checked)} /></td>
            <td><input type="checkbox" checked={cur ? !!cur.sms_enabled : false} onChange={e => setPrefField(m, 'sms_enabled', e.target.checked)} /></td>
          </tr>;
        })}
      </tbody></table>
      <button type="button" onClick={savePrefs}>Save preferences</button>
    </>}

    {tab === 'Reports' && <ul>
      <li>Overdue items report — filter the Review Calendar by status=overdue today.</li>
      <li>Staff task report — use My Tasks today.</li>
      <li>Module alerts report — placeholder. Future per-module breakdown export.</li>
    </ul>}
  </div>;
}

// ============================================================================
// InboxView — a professional secretarial inbox. Every notification opens the
// record it points to; completing the required action auto-clears it.
// ============================================================================
function InboxView({ list, total, activeCount, urgentCount, todayCount, overdueCount, filter, onFilterChange, search, onSearchChange, onOpen, onTransition, selected, onCloseSelected }: {
  list: NotificationRecord[]; total: number;
  activeCount: number; urgentCount: number; todayCount: number; overdueCount: number;
  filter: string; onFilterChange: (f: any) => void;
  search: string; onSearchChange: (s: string) => void;
  onOpen: (n: NotificationRecord) => void;
  onTransition: (id: number, action: 'read' | 'acknowledge' | 'resolve' | 'dismiss') => void;
  selected: NotificationRecord | null; onCloseSelected: () => void;
}) {
  const now = new Date().toISOString().slice(0, 10);
  return <div>
    <div style={{ display: 'flex', gap: 16, alignItems: 'stretch', flexWrap: 'wrap', marginBottom: 12 }}>
      <div style={{ flex: 1, minWidth: 260, display: 'flex', gap: 8, background: 'var(--card-bg, #fff)', border: '1px solid #e2e8f0', borderRadius: 10, padding: '10px 14px', alignItems: 'center' }}>
        <Inbox size={22} style={{ color: '#0ea5e9' }} />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 12, color: '#64748b' }}>Inbox</div>
          <div style={{ fontWeight: 700, fontSize: 15 }}>{activeCount} active · <span style={{ color: '#94a3b8', fontWeight: 500 }}>{total} total</span></div>
        </div>
      </div>
      <FilterChip color="#dc2626" label="Urgent" count={urgentCount} active={filter === 'urgent'} onClick={() => onFilterChange('urgent')} />
      <FilterChip color="#f59e0b" label="Due today" count={todayCount} active={filter === 'today'} onClick={() => onFilterChange('today')} />
      <FilterChip color="#ea580c" label="Overdue" count={overdueCount} active={filter === 'all'} onClick={() => onFilterChange('all')} />
      <FilterChip color="#16a34a" label="Resolved" count={total - activeCount} active={filter === 'resolved'} onClick={() => onFilterChange('resolved')} />
    </div>

    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
      <div style={{ position: 'relative', flex: 1, minWidth: 260 }}>
        <input value={search} onChange={e => onSearchChange(e.target.value)} placeholder="Search notifications by title, message, module…" style={{ width: '100%', paddingLeft: 34 }} />
        <Filter size={14} style={{ position: 'absolute', left: 12, top: 10, color: '#94a3b8' }} />
      </div>
      <div className="tabs" style={{ marginBottom: 0 }}>
        {[
          { k: 'active', l: 'Active' }, { k: 'all', l: 'All' }, { k: 'urgent', l: 'Urgent' },
          { k: 'today', l: 'Today' }, { k: 'resolved', l: 'Resolved' },
        ].map(f => <button key={f.k} type="button" className={filter === f.k ? 'active' : ''} onClick={() => onFilterChange(f.k)}>{f.l}</button>)}
      </div>
    </div>

    {list.length === 0 ? <div className="card" style={{ padding: 32, textAlign: 'center' }}>
      <CheckCircle2 size={48} style={{ color: '#22c55e', margin: '0 auto 12px', display: 'block' }} />
      <h3 style={{ margin: 0 }}>Your inbox is clear</h3>
      <p className="muted" style={{ marginTop: 6 }}>No matching notifications. New alerts appear here when the system needs your attention.</p>
    </div> : <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 10 }}>
      {list.map(n => {
        const isOverdue = n.due_date && n.due_date < now;
        const isToday = n.due_date === now;
        const color = SEVERITY_COLOR[n.severity] || '#94a3b8';
        return <div key={n.id} className="card" style={{
          padding: 14, cursor: 'pointer', borderLeft: `4px solid ${color}`,
          background: n.status === 'unread' ? '#fff' : n.status === 'resolved' ? '#f8fafc' : '#fdfdfe',
          opacity: n.status === 'resolved' || n.status === 'dismissed' ? 0.65 : 1,
        }} onClick={() => onOpen(n)}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <div style={{ marginTop: 2 }}>
              {n.severity === 'urgent' || n.severity === 'high' ? <AlertTriangle size={16} style={{ color }} /> :
               n.notification_type === 'approval_required' ? <CheckCircle2 size={16} style={{ color }} /> :
               <Bell size={16} style={{ color }} />}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: n.status === 'unread' ? 700 : 500, fontSize: 13.5, color: '#0f172a' }}>{n.title}</div>
              {n.message && <div style={{ fontSize: 12, color: '#64748b', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{n.message}</div>}
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6, flexWrap: 'wrap', fontSize: 11 }}>
                <span className="badge">{n.module_key}</span>
                {n.due_date && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: isOverdue ? '#dc2626' : isToday ? '#f59e0b' : '#64748b', fontWeight: 500 }}>
                  <Clock size={11} />{isOverdue ? `Overdue ${n.due_date}` : isToday ? 'Today' : `Due ${n.due_date}`}
                </span>}
                <span style={{ color: '#94a3b8' }}>{String(n.created_at).slice(0, 10)}</span>
              </div>
              {n.action_url && n.status !== 'resolved' && <div style={{ marginTop: 8, display: 'flex', gap: 6, alignItems: 'center' }}>
                <span style={{ color: '#0ea5e9', fontSize: 12, fontWeight: 600 }}>{n.action_label || 'Open'}</span>
                <ArrowRight size={13} style={{ color: '#0ea5e9' }} />
              </div>}
            </div>
            {n.status !== 'resolved' && n.status !== 'dismissed' && <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }} onClick={e => e.stopPropagation()}>
              <button className="link-btn" title="Mark resolved" onClick={() => onTransition(n.id, 'resolve')} style={{ fontSize: 11 }}>✓</button>
              <button className="link-btn" title="Dismiss" onClick={() => onTransition(n.id, 'dismiss')} style={{ fontSize: 11, color: '#64748b' }}>×</button>
            </div>}
          </div>
        </div>;
      })}
    </div>}

    {selected && <div className="doc-drawer-overlay" onClick={onCloseSelected}>
      <div className="doc-drawer" onClick={e => e.stopPropagation()}>
        <div className="doc-drawer-panel">
          <div className="doc-drawer-head">
            <div>
              <span className="hint">{selected.notification_number || '—'} · {selected.module_key}</span>
              <h3 style={{ margin: '2px 0 0' }}>{selected.title}</h3>
            </div>
            <button className="drawer-close" onClick={onCloseSelected}>×</button>
          </div>
          <div className="doc-drawer-body">
            <p>{selected.message}</p>
            <p style={{ margin: '4px 0' }}><strong>Severity:</strong> {formatBadge(selected.severity)} · <strong>Type:</strong> {selected.notification_type.replace(/_/g, ' ')} · <strong>Status:</strong> {formatBadge(selected.status)}</p>
            <p style={{ margin: '4px 0' }}><strong>Due:</strong> {selected.due_date || '—'} · <strong>Created:</strong> {String(selected.created_at).slice(0, 10)}</p>
            <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {selected.status !== 'acknowledged' && <button onClick={() => onTransition(selected.id, 'acknowledge')}>Acknowledge</button>}
              {selected.status !== 'resolved' && <button onClick={() => onTransition(selected.id, 'resolve')}>Mark resolved</button>}
              {selected.status !== 'dismissed' && <button className="secondary" onClick={() => onTransition(selected.id, 'dismiss')}>Dismiss</button>}
            </div>
          </div>
        </div>
      </div>
    </div>}
  </div>;
}

function FilterChip({ color, label, count, active, onClick }: { color: string; label: string; count: number; active?: boolean; onClick: () => void }) {
  return <button type="button" onClick={onClick} style={{
    border: `1px solid ${active ? color : '#e2e8f0'}`, background: active ? color : '#fff', color: active ? '#fff' : color,
    padding: '10px 14px', borderRadius: 10, display: 'flex', flexDirection: 'column', alignItems: 'flex-start',
    fontWeight: 600, gap: 2, cursor: 'pointer', minWidth: 100,
  }}>
    <span style={{ fontSize: 11.5, textTransform: 'uppercase', letterSpacing: 0.3, opacity: active ? 0.9 : 1 }}>{label}</span>
    <span style={{ fontSize: 20, lineHeight: 1 }}>{count}</span>
  </button>;
}
