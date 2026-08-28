import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Activity, AlertTriangle, ArrowRight, CalendarClock, CheckCircle2, ClipboardCheck,
  Eye, Play, RefreshCw, ScanSearch, ShieldAlert, Radio,
} from 'lucide-react';
import PageHeader from '../components/ui/PageHeader';
import { KpiStrip, ChartCard, BarMeter, CHART_COLORS } from '../components/ui';
import PermissionTabs from '../components/PermissionTabs';
import DisabledModule from '../components/DisabledModule';
import { useModules } from '../hooks/useModules';
import { usePermissions } from '../hooks/usePermissions';
import { useFocusTarget, focusAttr } from '../hooks/useFocusTarget';
import { api, errorText } from '../services/api';
import {
  AUDIT_FLAG_CATEGORY_LABELS, AUDIT_SEVERITIES, AUDIT_SEVERITY_RANK,
  SCHEDULE_KIND_LABELS, type ScheduleKind,
} from '../../shared/constants/activities';
import type {
  SystemAuditFlag, SystemAuditSummary, SystemAuditTrailResponse, SystemAuditScan, ScheduleObligation,
} from '../../shared/types/api';
import TextField from '../components/ui/TextField';

/**
 * System Audit — the laboratory's watchtower over its own software.
 *
 * The trail was already there; what was missing was the other half of the
 * question. An audit trail tells you what people did. It cannot tell you what
 * nobody did, and "nobody did it" is what an assessment finding actually is.
 *
 * So this workspace has two halves, and one rule that binds them: every row is
 * a door. A trail entry opens the record it touched; a flag opens the problem
 * it found. Nothing here is a dead end you have to go and hunt down by hand,
 * because a finding you cannot act on from where you read it is a finding
 * people stop reading.
 */
const TAB_MODULE = 'system_audit';
const TABS = ['Overview', 'Flags', 'Not Done', 'Schedules', 'Live Trail', 'Checks'];

const SEVERITY_TONE: Record<string, string> = { critical: 'crit', high: 'crit', medium: 'warn', low: 'ok' };

function relative(iso?: string | null): string {
  if (!iso) return '—';
  const then = Date.parse(String(iso).replace(' ', 'T'));
  if (!Number.isFinite(then)) return String(iso).slice(0, 16).replace('T', ' ');
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  const days = Math.floor(seconds / 86400);
  if (days < 30) return `${days} d ago`;
  return String(iso).slice(0, 10);
}

function ageInDays(iso?: string | null): number {
  if (!iso) return 0;
  const then = Date.parse(String(iso).replace(' ', 'T'));
  return Number.isFinite(then) ? Math.max(0, Math.floor((Date.now() - then) / 86400000)) : 0;
}

/* ============================================================================
   Overview
   ========================================================================= */
function Overview({ summary, onScan, scanning, goTab }: {
  summary: SystemAuditSummary | null;
  onScan: () => void;
  scanning: boolean;
  goTab: (tab: string) => void;
}) {
  if (!summary) return <div className="card">Loading the audit picture…</div>;

  const kpis = [
    { label: 'Open flags', value: summary.flags.open, tone: summary.flags.open > 0 ? ('danger' as const) : undefined, onClick: () => goTab('Flags') },
    { label: 'Critical', value: summary.flags.critical, tone: summary.flags.critical > 0 ? ('danger' as const) : undefined, onClick: () => goTab('Flags') },
    { label: 'Acknowledged', value: summary.flags.acknowledged, onClick: () => goTab('Flags') },
    { label: 'Not done this week', value: summary.activities.missedThisWeek, onClick: () => goTab('Not Done') },
    { label: 'Schedules overdue', value: summary.schedules.overdue, onClick: () => goTab('Schedules') },
    { label: 'Events today', value: summary.trail.eventsToday, onClick: () => goTab('Live Trail') },
  ];

  const bySeverity = [
    { label: 'Critical', value: summary.flags.critical, color: CHART_COLORS[3], onClick: () => goTab('Flags') },
    { label: 'High', value: summary.flags.high, color: CHART_COLORS[5], onClick: () => goTab('Flags') },
    { label: 'Medium', value: summary.flags.medium, color: CHART_COLORS[0], onClick: () => goTab('Flags') },
    { label: 'Low', value: summary.flags.low, color: CHART_COLORS[2], onClick: () => goTab('Flags') },
  ];

  const byCategory = summary.byCategory.map((row, i) => ({
    label: row.label, value: row.count, color: CHART_COLORS[i % CHART_COLORS.length], onClick: () => goTab('Flags'),
  }));

  return (
    <>
      <div className="audit-scanbar card">
        <div>
          <h3><ScanSearch size={16} /> Audit scan</h3>
          <p>
            {summary.lastScan
              ? <>Last run {relative(summary.lastScan.finished_at ?? summary.lastScan.started_at)} — {summary.lastScan.checks_run} checks, {summary.lastScan.flags_found} findings, {summary.lastScan.flags_new} new, {summary.lastScan.flags_cleared} cleared.</>
              : <>No scan has run yet. Run one to see what the system finds.</>}
          </p>
        </div>
        <button type="button" onClick={onScan} disabled={scanning}>
          {scanning ? <><RefreshCw size={15} className="spin" /> Scanning…</> : <><Play size={15} /> Run a scan now</>}
        </button>
      </div>

      <KpiStrip items={kpis} />

      <div className="grid cols-3">
        <ChartCard title="Findings by severity" subtitle="Open and acknowledged">
          <BarMeter data={bySeverity} />
        </ChartCard>
        <ChartCard title="Findings by kind" subtitle="What sort of problem">
          {byCategory.length ? <BarMeter data={byCategory} /> : <p className="muted">Nothing flagged.</p>}
        </ChartCard>
        <ChartCard title="Unit activities" subtitle="Today, and the week behind">
          <BarMeter data={[
            { label: 'Due today', value: summary.activities.dueToday, color: CHART_COLORS[0], onClick: () => goTab('Not Done') },
            { label: 'Done today', value: summary.activities.doneToday, color: CHART_COLORS[2], onClick: () => goTab('Not Done') },
            { label: 'Missed (7 days)', value: summary.activities.missedThisWeek, color: CHART_COLORS[3], onClick: () => goTab('Not Done') },
            { label: 'Being simplified', value: summary.activities.flaggedForRedesign, color: CHART_COLORS[5], onClick: () => goTab('Not Done') },
          ]} />
        </ChartCard>
      </div>

      <div className="grid cols-2">
        <div className="card">
          <h3><Radio size={15} /> The trail, live</h3>
          <ul className="audit-facts">
            <li><span>Events today</span><strong>{summary.trail.eventsToday}</strong></li>
            <li><span>Events this week</span><strong>{summary.trail.eventsThisWeek}</strong></li>
            <li><span>People active this week</span><strong>{summary.trail.actors}</strong></li>
            <li><span>Record types touched</span><strong>{summary.trail.entities}</strong></li>
            <li><span>Last event</span><strong>{relative(summary.trail.lastEventAt)}</strong></li>
          </ul>
          <button type="button" className="pq-link" onClick={() => goTab('Live Trail')}>Open the live trail <ArrowRight size={13} /></button>
        </div>
        <div className="card">
          <h3><CalendarClock size={15} /> Rosters and schedules</h3>
          <ul className="audit-facts">
            <li><span>Due to be prepared</span><strong>{summary.schedules.pending}</strong></li>
            <li><span>Past their deadline</span><strong className={summary.schedules.overdue ? 'crit' : ''}>{summary.schedules.overdue}</strong></li>
            <li><span>Carried forward this month</span><strong>{summary.schedules.carriedForwardThisMonth}</strong></li>
          </ul>
          <button type="button" className="pq-link" onClick={() => goTab('Schedules')}>Open schedules <ArrowRight size={13} /></button>
        </div>
      </div>
    </>
  );
}

/* ============================================================================
   Flags
   ========================================================================= */
function Flags({ onChanged }: { onChanged: () => void }) {
  const navigate = useNavigate();
  const { can } = usePermissions();
  const [flags, setFlags] = useState<SystemAuditFlag[]>([]);
  const [filter, setFilter] = useState({ status: 'open', category: '', severity: '', search: '' });
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dismissing, setDismissing] = useState<{ id: number; note: string } | null>(null);
  const mayEdit = can('system_audit.flags', 'edit');

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (filter.status) params.set('status', filter.status);
    if (filter.category) params.set('category', filter.category);
    if (filter.severity) params.set('severity', filter.severity);
    if (filter.search) params.set('search', filter.search);
    try { setFlags(await api<SystemAuditFlag[]>(`/system-audit/flags?${params.toString()}`)); setError(null); }
    catch (e) { setError(errorText(e)); }
  }, [filter]);

  useEffect(() => { void load(); }, [load]);
  useFocusTarget(flags);

  async function act(id: number, path: string, body: Record<string, unknown> = {}) {
    setBusyId(id);
    try {
      await api(`/system-audit/flags/${id}/${path}`, { method: 'POST', body: JSON.stringify(body) });
      await load(); onChanged();
    } catch (e) { setError(errorText(e)); } finally { setBusyId(null); }
  }

  const grouped = useMemo(() => {
    const sorted = [...flags].sort((a, b) =>
      (AUDIT_SEVERITY_RANK[a.severity] ?? 9) - (AUDIT_SEVERITY_RANK[b.severity] ?? 9)
      || String(a.first_seen_at).localeCompare(String(b.first_seen_at)));
    return sorted;
  }, [flags]);

  return (
    <div className="card">
      <div className="filters">
        <label><span>Status</span>
          <select value={filter.status} onChange={e => setFilter({ ...filter, status: e.target.value })}>
            <option value="open">Open &amp; acknowledged</option>
            <option value="acknowledged">Acknowledged only</option>
            <option value="resolved">Resolved</option>
            <option value="dismissed">Dismissed</option>
            <option value="all">All</option>
          </select>
        </label>
        <label><span>Kind</span>
          <select value={filter.category} onChange={e => setFilter({ ...filter, category: e.target.value })}>
            <option value="">All kinds</option>
            {Object.entries(AUDIT_FLAG_CATEGORY_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select>
        </label>
        <label><span>Severity</span>
          <select value={filter.severity} onChange={e => setFilter({ ...filter, severity: e.target.value })}>
            <option value="">Any</option>
            {AUDIT_SEVERITIES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <label><span>Search</span>
          <TextField value={filter.search} onValue={nextValue => setFilter({ ...filter, search: nextValue })} placeholder="Title or detail" />
        </label>
      </div>

      {error && <p className="form-error">{error}</p>}

      {grouped.length === 0 && (
        <div className="di-clear"><CheckCircle2 size={18} /><span>No findings match. Nothing outstanding here.</span></div>
      )}

      <ul className="flag-list">
        {grouped.map(flag => (
          <li key={flag.id} className={`flag-item ${SEVERITY_TONE[flag.severity] ?? 'info'}`} {...focusAttr(flag.record_type, flag.record_id)}>
            <span className={`flag-rail ${SEVERITY_TONE[flag.severity] ?? 'info'}`} />
            <div className="flag-main">
              <button type="button" className="flag-title" onClick={() => flag.action_url && navigate(flag.action_url)}
                title="Open the record this flag is about">
                {flag.title} <ArrowRight size={13} />
              </button>
              {flag.detail && <p className="flag-detail">{flag.detail}</p>}
              <div className="flag-meta">
                <span className={`badge ${flag.severity}`}>{flag.severity}</span>
                <span className="badge">{AUDIT_FLAG_CATEGORY_LABELS[flag.category as keyof typeof AUDIT_FLAG_CATEGORY_LABELS] ?? flag.category}</span>
                {flag.module_key && <span>{flag.module_key.replace(/_/g, ' ')}</span>}
                {flag.section_name && <span>{flag.section_name}</span>}
                {flag.due_date && <span>due {flag.due_date}</span>}
                <span title={`First seen ${flag.first_seen_at}`}>open {ageInDays(flag.first_seen_at)} d</span>
                {flag.status === 'acknowledged' && <span className="badge in-progress">acknowledged{flag.acknowledged_by_name ? ` by ${flag.acknowledged_by_name}` : ''}</span>}
                {flag.status === 'dismissed' && <span className="badge inactive">dismissed</span>}
                {flag.status === 'resolved' && <span className="badge done">resolved</span>}
              </div>
              {flag.resolution_note && <p className="flag-detail muted">{flag.resolution_note}</p>}

              {dismissing?.id === flag.id && (
                <div className="flag-dismiss">
                  <TextField value={dismissing.note} autoFocus placeholder="Why does this not apply here?"
                    onValue={nextValue => setDismissing({ id: flag.id, note: nextValue })} />
                  {can('system_audit.flags', 'edit') && <button type="button" disabled={!dismissing.note.trim() || busyId === flag.id}
                    onClick={() => void act(flag.id, 'dismiss', { note: dismissing.note.trim() }).then(() => setDismissing(null))}>
                    Dismiss it
                  </button>}
                  <button type="button" className="secondary" onClick={() => setDismissing(null)}>Cancel</button>
                </div>
              )}
            </div>

            {mayEdit && (flag.status === 'open' || flag.status === 'acknowledged') && (
              <div className="flag-actions">
                {flag.status === 'open' && (
                  can('system_audit.flags', 'edit') && <button type="button" className="pq-link" disabled={busyId === flag.id}
                    onClick={() => void act(flag.id, 'acknowledge')}>
                    <Eye size={12} /> Acknowledge
                  </button>
                )}
                {can('system_audit.flags', 'edit') && <button type="button" className="pq-link" disabled={busyId === flag.id}
                  onClick={() => void act(flag.id, 'raise-action')} title="Raise a tracked action from this finding">
                  <ClipboardCheck size={12} /> Raise action
                </button>}
                {can('system_audit.flags', 'edit') && <button type="button" className="pq-link" disabled={busyId === flag.id}
                  onClick={() => void act(flag.id, 'resolve')}>
                  <CheckCircle2 size={12} /> Resolve
                </button>}
                <button type="button" className="pq-link" onClick={() => setDismissing({ id: flag.id, note: '' })}>
                  Not applicable
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ============================================================================
   Not Done — the omission register
   ========================================================================= */
type NotDoneRow = {
  id: number; occurrence_date: string; window_end: string; section_id: number | null;
  activity_id: number; activity_name: string; activity_code: string; category: string;
  frequency: string; priority: string; redesign_status: string; target_route: string | null;
  section_name: string | null; assignee_names: string | null;
};

function NotDone() {
  const navigate = useNavigate();
  const [rows, setRows] = useState<NotDoneRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState(30);

  useEffect(() => {
    const to = new Date();
    const from = new Date(Date.now() - range * 86400000);
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    api<NotDoneRow[]>(`/system-audit/not-done?from=${iso(from)}&to=${iso(to)}`)
      .then(setRows).catch(e => setError(errorText(e)));
  }, [range]);
  useFocusTarget(rows);

  // Repeat offenders first: one missed reading is a slip, the same one missed
  // eleven times is a design problem, and only the second needs a decision.
  const byActivity = useMemo(() => {
    const map = new Map<number, { name: string; section: string | null; count: number; latest: string; redesign: string; rows: NotDoneRow[] }>();
    for (const row of rows) {
      const entry = map.get(row.activity_id) ?? { name: row.activity_name, section: row.section_name, count: 0, latest: row.occurrence_date, redesign: row.redesign_status, rows: [] };
      entry.count++;
      entry.rows.push(row);
      if (row.occurrence_date > entry.latest) entry.latest = row.occurrence_date;
      map.set(row.activity_id, entry);
    }
    return [...map.entries()].map(([id, v]) => ({ id, ...v })).sort((a, b) => b.count - a.count);
  }, [rows]);

  return (
    <div className="card">
      <div className="filters">
        <label><span>Window</span>
          <select value={range} onChange={e => setRange(Number(e.target.value))}>
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </select>
        </label>
      </div>
      {error && <p className="form-error">{error}</p>}

      {rows.length === 0
        ? <div className="di-clear"><CheckCircle2 size={18} /><span>Every scheduled activity in this window was recorded as done.</span></div>
        : <>
          <p className="muted">{rows.length} scheduled activit{rows.length === 1 ? 'y was' : 'ies were'} never recorded as done. Repeat offenders are listed first — an activity missed again and again is usually one that is hard to do.</p>
          {byActivity.map(group => (
            <section key={group.id} className="notdone-group">
              <header>
                <div>
                  <strong>{group.name}</strong>
                  {group.section && <span className="badge">{group.section}</span>}
                  {group.redesign !== 'none' && <span className="badge in-progress">being simplified</span>}
                </div>
                <div>
                  <span className={`badge ${group.count >= 3 ? 'overdue' : 'warning'}`}>{group.count} missed</span>
                  <button type="button" className="pq-link" onClick={() => navigate(`/settings/activities?focus=unit_activities:${group.id}`)}>
                    Open the activity <ArrowRight size={12} />
                  </button>
                </div>
              </header>
              <table>
                <thead><tr><th>Date due</th><th>Window closed</th><th>Who was on duty</th><th /></tr></thead>
                <tbody>
                  {group.rows.map(row => (
                    <tr key={row.id} {...focusAttr('activity_occurrences', row.id)}>
                      <td>{row.occurrence_date}</td>
                      <td>{row.window_end}</td>
                      <td>{row.assignee_names || <span className="muted">nobody was assigned</span>}</td>
                      <td>
                        {row.target_route && (
                          <button type="button" className="pq-link" onClick={() => navigate(row.target_route!)}>
                            Where it is recorded <ArrowRight size={12} />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ))}
        </>}
    </div>
  );
}

/* ============================================================================
   Schedules
   ========================================================================= */
type CarryForwardRow = { id: number; kind: string; month: string; section_id: number; reason: string; detail: string | null; created_at: string; section_name: string | null };

function Schedules() {
  const navigate = useNavigate();
  const [data, setData] = useState<{ obligations: ScheduleObligation[]; carryForwards: CarryForwardRow[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ obligations: ScheduleObligation[]; carryForwards: CarryForwardRow[] }>('/system-audit/schedules')
      .then(setData).catch(e => setError(errorText(e)));
  }, []);

  if (error) return <div className="card"><p className="form-error">{error}</p></div>;
  if (!data) return <div className="card">Loading…</div>;

  const statusBadge = (status: string) =>
    status === 'overdue' ? 'badge overdue'
      : status === 'carried_forward' ? 'badge warning'
      : status === 'prepared' ? 'badge done'
      : status === 'due_soon' ? 'badge due-soon' : 'badge';

  return (
    <>
      <div className="card">
        <h3><CalendarClock size={15} /> Preparation status</h3>
        <p className="muted">
          The duty roster and unit reassignment are the laboratory manager&rsquo;s and quality manager&rsquo;s, due before the month turns.
          The bench schedules are the unit heads&rsquo;, and follow the unit assignments. A month that starts without one runs on the previous
          month&rsquo;s, automatically — which is safe, but it is recorded here so nobody mistakes it for a schedule somebody prepared.
        </p>
        <table>
          <thead><tr><th>Schedule</th><th>Month</th><th>Unit</th><th>Due by</th><th>Status</th><th>Owed by</th><th /></tr></thead>
          <tbody>
            {data.obligations.map(o => (
              <tr key={`${o.kind}:${o.month}:${o.sectionId ?? 0}`}>
                <td>{SCHEDULE_KIND_LABELS[o.kind as ScheduleKind] ?? o.kind}</td>
                <td>{o.monthLabel}</td>
                <td>{o.sectionName ?? <span className="muted">laboratory-wide</span>}</td>
                <td>{o.dueDate}{o.status !== 'prepared' && <span className="muted"> ({o.daysRemaining >= 0 ? `${o.daysRemaining} d left` : `${Math.abs(o.daysRemaining)} d late`})</span>}</td>
                <td><span className={statusBadge(o.status)}>{o.status.replace(/_/g, ' ')}</span></td>
                <td>{o.ownerRoleHint}</td>
                <td><button type="button" className="pq-link" onClick={() => navigate(o.actionUrl)}>Open <ArrowRight size={12} /></button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3><ShieldAlert size={15} /> Carried forward automatically</h3>
        {data.carryForwards.length === 0
          ? <p className="muted">Nothing has had to be carried forward. Every month was prepared in time.</p>
          : <table>
            <thead><tr><th>Schedule</th><th>Month</th><th>Unit</th><th>Why</th><th>When</th></tr></thead>
            <tbody>
              {data.carryForwards.map(row => (
                <tr key={row.id}>
                  <td>{SCHEDULE_KIND_LABELS[row.kind as ScheduleKind] ?? row.kind}</td>
                  <td>{row.month}</td>
                  <td>{row.section_name ?? <span className="muted">laboratory-wide</span>}</td>
                  <td>{row.detail}</td>
                  <td>{relative(row.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>}
      </div>
    </>
  );
}

/* ============================================================================
   Live trail
   ========================================================================= */
function LiveTrail() {
  const navigate = useNavigate();
  const [data, setData] = useState<SystemAuditTrailResponse | null>(null);
  const [filter, setFilter] = useState({ action: '', entity: '', actorId: '', search: '', from: '', to: '' });
  const [live, setLive] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const query = useMemo(() => {
    const params = new URLSearchParams({ limit: '150' });
    for (const [key, value] of Object.entries(filter)) if (value) params.set(key, value);
    return params.toString();
  }, [filter]);

  const load = useCallback(async () => {
    try { setData(await api<SystemAuditTrailResponse>(`/system-audit/trail?${query}`)); setError(null); }
    catch (e) { setError(errorText(e)); }
  }, [query]);

  useEffect(() => { void load(); }, [load]);

  // The live tail. Ten seconds is fast enough to feel real and slow enough that
  // an audit screen left open all day is not a load problem.
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => void load(), 10000);
    return () => window.clearInterval(timer);
  }, [live, load]);

  return (
    <div className="card">
      <div className="filters">
        <label><span>Action</span>
          <select value={filter.action} onChange={e => setFilter({ ...filter, action: e.target.value })}>
            <option value="">Any action</option>
            {(data?.actions ?? []).map(a => <option key={a} value={a}>{a.replace(/_/g, ' ')}</option>)}
          </select>
        </label>
        <label><span>Record type</span>
          <select value={filter.entity} onChange={e => setFilter({ ...filter, entity: e.target.value })}>
            <option value="">Any record</option>
            {(data?.entities ?? []).map(e => <option key={e} value={e}>{e.replace(/_/g, ' ')}</option>)}
          </select>
        </label>
        <label><span>Who</span>
          <select value={filter.actorId} onChange={e => setFilter({ ...filter, actorId: e.target.value })}>
            <option value="">Anybody</option>
            {(data?.actors ?? []).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
        <label><span>From</span><input type="date" value={filter.from} onChange={e => setFilter({ ...filter, from: e.target.value })} /></label>
        <label><span>To</span><input type="date" value={filter.to} onChange={e => setFilter({ ...filter, to: e.target.value })} /></label>
        <label><span>Search</span><TextField value={filter.search} onValue={nextValue => setFilter({ ...filter, search: nextValue })} placeholder="Record, person, action" /></label>
        <label className="inline">
          <input type="checkbox" checked={live} onChange={e => setLive(e.target.checked)} />
          <span><Radio size={12} /> Live</span>
        </label>
      </div>

      {error && <p className="form-error">{error}</p>}
      <p className="muted">
        {data ? `${data.total.toLocaleString()} recorded events${data.total > data.entries.length ? `, showing the most recent ${data.entries.length}` : ''}.` : 'Loading…'}
        {' '}Every row opens the record it touched.
      </p>

      <table className="trail-table">
        <thead><tr><th>When</th><th>Who</th><th>Did what</th><th>Record</th><th>From</th><th /></tr></thead>
        <tbody>
          {(data?.entries ?? []).map(entry => (
            <tr key={entry.id}>
              <td title={entry.created_at}>{relative(entry.created_at)}</td>
              <td>{entry.actor_name || entry.actor_username || <span className="muted">system</span>}</td>
              <td><span className={`badge ${entry.action === 'delete' || entry.action === 'missed' ? 'overdue' : entry.action === 'create' ? 'done' : ''}`}>{entry.action.replace(/_/g, ' ')}</span></td>
              <td>{String(entry.entity).replace(/_/g, ' ')}{entry.entity_id ? ` #${entry.entity_id}` : ''}</td>
              <td className="muted">{entry.ip_address || '—'}</td>
              <td>
                <button type="button" className="pq-link" onClick={() => entry.action_url && navigate(entry.action_url)}>
                  Open <ArrowRight size={12} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ============================================================================
   Checks
   ========================================================================= */
type CheckRow = {
  key: string; label: string; category: string; categoryLabel: string;
  description: string; severity: string; moduleKey: string | null;
  openFlags: number; lastSeenAt: string | null;
};

function Checks({ onScan, scanning }: { onScan: () => void; scanning: boolean }) {
  const [checks, setChecks] = useState<CheckRow[]>([]);
  const [scans, setScans] = useState<SystemAuditScan[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api<CheckRow[]>('/system-audit/checks'), api<SystemAuditScan[]>('/system-audit/scans')])
      .then(([c, s]) => { setChecks(c); setScans(s); })
      .catch(e => setError(errorText(e)));
  }, [scanning]);

  const byCategory = useMemo(() => {
    const map = new Map<string, CheckRow[]>();
    for (const check of checks) {
      const list = map.get(check.categoryLabel) ?? [];
      list.push(check);
      map.set(check.categoryLabel, list);
    }
    return [...map.entries()];
  }, [checks]);

  return (
    <>
      <div className="audit-scanbar card">
        <div>
          <h3><ScanSearch size={16} /> What the audit looks for</h3>
          <p>{checks.length} checks run against the whole system. Each one either finds nothing, or produces flags that open the record behind them.</p>
        </div>
        <button type="button" onClick={onScan} disabled={scanning}>
          {scanning ? <><RefreshCw size={15} className="spin" /> Scanning…</> : <><Play size={15} /> Run them now</>}
        </button>
      </div>

      {error && <div className="card"><p className="form-error">{error}</p></div>}

      {byCategory.map(([category, rows]) => (
        <div className="card" key={category}>
          <h3>{category}</h3>
          <table>
            <thead><tr><th>Check</th><th>What it looks for</th><th>Severity</th><th>Open findings</th></tr></thead>
            <tbody>
              {rows.map(check => (
                <tr key={check.key}>
                  <td><strong>{check.label}</strong>{check.moduleKey && <div className="muted">{check.moduleKey.replace(/_/g, ' ')}</div>}</td>
                  <td>{check.description}</td>
                  <td><span className={`badge ${check.severity}`}>{check.severity}</span></td>
                  <td>{check.openFlags > 0 ? <span className="badge overdue">{check.openFlags}</span> : <span className="badge done">none</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      <div className="card">
        <h3><Activity size={15} /> Recent scans</h3>
        <table>
          <thead><tr><th>Started</th><th>Took</th><th>Checks</th><th>Findings</th><th>New</th><th>Cleared</th><th>Run by</th></tr></thead>
          <tbody>
            {scans.map(scan => (
              <tr key={scan.id}>
                <td title={scan.started_at}>{relative(scan.started_at)}</td>
                <td>{scan.duration_ms ?? '—'} ms</td>
                <td>{scan.checks_run}</td>
                <td>{scan.flags_found}</td>
                <td>{scan.flags_new}</td>
                <td>{scan.flags_cleared}</td>
                <td>{scan.triggered_by_name ?? <span className="muted">scheduler</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/* ============================================================================
   The workspace
   ========================================================================= */
export function SystemAuditPage() {
  const { isEnabled } = useModules();
  const [tab, setTab] = useState('Overview');
  const [summary, setSummary] = useState<SystemAuditSummary | null>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadSummary = useCallback(async () => {
    try { setSummary(await api<SystemAuditSummary>('/system-audit/summary')); }
    catch (e) { setError(errorText(e)); }
  }, []);

  useEffect(() => { void loadSummary(); }, [loadSummary]);

  const runScan = useCallback(async () => {
    setScanning(true);
    try { await api('/system-audit/scan', { method: 'POST', body: JSON.stringify({}) }); await loadSummary(); }
    catch (e) { setError(errorText(e)); } finally { setScanning(false); }
  }, [loadSummary]);

  if (!isEnabled('system_audit')) return <DisabledModule />;

  return (
    <div className="module-page">
      <PageHeader
        eyebrow="System Audit"
        title="Audit of the whole system, in real time"
        subtitle="Everything that happened, everything that was supposed to happen and did not, and every place the data disagrees with itself. Every row opens the record behind it."
        actions={<button type="button" className="secondary" onClick={runScan} disabled={scanning}>
          {scanning ? <><RefreshCw size={15} className="spin" /> Scanning…</> : <><ScanSearch size={15} /> Run a scan</>}
        </button>}
      />

      {summary && (summary.flags.critical > 0 || summary.schedules.overdue > 0) && (
        <div className="card audit-banner">
          <AlertTriangle size={18} />
          <span>
            {summary.flags.critical > 0 && <>{summary.flags.critical} critical finding{summary.flags.critical === 1 ? '' : 's'} open. </>}
            {summary.schedules.overdue > 0 && <>{summary.schedules.overdue} schedule{summary.schedules.overdue === 1 ? '' : 's'} past the preparation deadline.</>}
          </span>
        </div>
      )}

      <PermissionTabs moduleKey={TAB_MODULE} tabs={TABS} active={tab} onChange={setTab} />
      {error && <div className="card"><p className="form-error">{error}</p></div>}

      {tab === 'Overview' && <Overview summary={summary} onScan={runScan} scanning={scanning} goTab={setTab} />}
      {tab === 'Flags' && <Flags onChanged={loadSummary} />}
      {tab === 'Not Done' && <NotDone />}
      {tab === 'Schedules' && <Schedules />}
      {tab === 'Live Trail' && <LiveTrail />}
      {tab === 'Checks' && <Checks onScan={runScan} scanning={scanning} />}
    </div>
  );
}
