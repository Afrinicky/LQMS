import { FormEvent, useEffect, useState } from 'react';
import { useModules } from '../hooks/useModules';
import { api } from '../services/api';
import DisabledModule from '../components/DisabledModule';
import type {
  NotificationRecord, NotificationRule, ReviewCalendarItem, UserTaskQueueItem,
  NotificationPreference, NotificationsSummary, Staff
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

export function NotificationsPage() {
  const { isEnabled } = useModules();
  const [tab, setTab] = useState('Dashboard');
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

  async function load() {
    try {
      const [sum, n, t, c, r, p, s] = await Promise.all([
        api<NotificationsSummary>('/dashboard/notifications-summary').catch(() => null),
        api<NotificationRecord[]>('/notifications'),
        api<UserTaskQueueItem[]>('/notifications/tasks?mine=true'),
        api<ReviewCalendarItem[]>('/notifications/calendar'),
        api<NotificationRule[]>('/notifications/rules'),
        api<NotificationPreference[]>('/notifications/preferences'),
        api<Staff[]>('/staff').catch(() => [])
      ]);
      if (sum) setSummary(sum);
      setNotifications(n); setTasks(t); setCalendar(c); setRules(r); setPrefs(p); setStaff(s);
    } catch (e) { setError((e as Error).message); }
  }
  useEffect(() => { if (isEnabled('notifications')) void load(); }, [isEnabled]);
  if (!isEnabled('notifications')) return <DisabledModule />;

  async function reloadCalendar() {
    const params = new URLSearchParams();
    Object.entries(calFilter).forEach(([k, v]) => { if (v) params.set(k, v); });
    try { setCalendar(await api<ReviewCalendarItem[]>(`/notifications/calendar?${params.toString()}`)); }
    catch (e) { setError((e as Error).message); }
  }

  async function transition(id: number, action: 'read' | 'acknowledge' | 'resolve' | 'dismiss') {
    try { await api(`/notifications/${id}/${action}`, { method: 'POST', body: JSON.stringify({}) }); await load(); }
    catch (e) { setError((e as Error).message); }
  }

  async function generateAlerts() {
    try { setGenerateResult(await api(`/notifications/calendar/generate`, { method: 'POST', body: JSON.stringify({}) })); await load(); }
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

  const tabs = ['Dashboard', 'My Notifications', 'My Tasks', 'Review Calendar', 'Generate Alerts', 'Notification Rules', 'Preferences', 'Reports'];

  return <div className="module-page">
    <h2>Notifications & Review Calendar</h2>
    {tabBar(tab, tabs, setTab)}
    {error && <div className="error">{error}</div>}

    {tab === 'Dashboard' && (summary ? <>
      <div className="cards">
        <div className="card"><h4>Unread notifications</h4><p className="metric">{summary.unreadNotifications}</p></div>
        <div className="card"><h4>Urgent / high</h4><p className="metric">{summary.urgentNotifications}</p></div>
        <div className="card"><h4>Due today</h4><p className="metric">{summary.dueToday}</p></div>
        <div className="card"><h4>Due soon</h4><p className="metric">{summary.dueSoon}</p></div>
        <div className="card"><h4>Overdue</h4><p className="metric">{summary.overdue}</p></div>
        <div className="card"><h4>Open tasks</h4><p className="metric">{summary.openTasks}</p></div>
        <div className="card"><h4>My open tasks</h4><p className="metric">{summary.myOpenTasks}</p></div>
        <div className="card"><h4>Pending approvals</h4><p className="metric">{summary.pendingApprovals}</p></div>
        <div className="card"><h4>Follow-ups due</h4><p className="metric">{summary.followUpsDue}</p></div>
        <div className="card"><h4>Review items due</h4><p className="metric">{summary.reviewItemsDue}</p></div>
      </div>
      <h3>By module</h3>
      <table className="data-table"><thead><tr><th>Module</th><th>Open notifications</th></tr></thead><tbody>
        {Object.entries(summary.byModule).map(([k, v]) => <tr key={k}><td>{k}</td><td>{v}</td></tr>)}
      </tbody></table>
    </> : <p>Loading…</p>)}

    {tab === 'My Notifications' && <table className="data-table"><thead><tr><th>Title</th><th>Module</th><th>Type</th><th>Severity</th><th>Due</th><th>Status</th><th></th></tr></thead><tbody>
      {notifications.map(n => <tr key={n.id}><td>{n.title}<br/><small>{n.message}</small></td><td>{n.module_key}</td><td>{n.notification_type.replace(/_/g, ' ')}</td><td>{formatBadge(n.severity)}</td><td>{n.due_date || '—'}</td><td>{formatBadge(n.status)}</td>
        <td>
          {n.status === 'unread' && <button onClick={() => transition(n.id, 'read')}>Mark read</button>}
          {n.status !== 'acknowledged' && n.status !== 'resolved' && n.status !== 'dismissed' && <button onClick={() => transition(n.id, 'acknowledge')}>Acknowledge</button>}
          {n.status !== 'resolved' && n.status !== 'dismissed' && <button onClick={() => transition(n.id, 'resolve')}>Resolve</button>}
          {n.status !== 'dismissed' && <button onClick={() => transition(n.id, 'dismiss')}>Dismiss</button>}
        </td></tr>)}
    </tbody></table>}

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
      <p><strong>Note:</strong> this is an internal in-app reminder scan only. No email, SMS, or external calendar invite is sent.</p>
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
      <p><small>Rules are stored for future automation. The current Generate Alerts scan derives reminders directly from each module's records and does not yet consume rule rows.</small></p>
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
      <li>Overdue items report — placeholder. Filter the Review Calendar by status=overdue today.</li>
      <li>Staff task report — placeholder. Use My Tasks today.</li>
      <li>Module alerts report — placeholder. Future per-module breakdown export.</li>
    </ul>}
  </div>;
}
