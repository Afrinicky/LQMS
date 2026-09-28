import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, Clock, Bell, CheckCircle2, ChevronRight, ArrowRight } from 'lucide-react';
import { TODAY, RAIL_CLASS, bucketOf, dueChip, type Bucket } from './AttentionCenter';
import { api } from '../../services/api';
import type { LiveAlert, LiveAlertsGrouped } from '../../../shared/types/api';

// ==========================================================================
// AlertCard / AlertGrid / ModuleAlerts — the shared env-monitoring-style
// alert surface used across every module dashboard and the main dashboard.
// A card has a coloured left rail keyed to severity, a headline value, the
// title/detail, a status pill and a meta line — matching the environmental
// live dashboard. All theme-aware (dark/light) via CSS variables.
// ==========================================================================

const TONE_CLASS: Record<string, string> = { crit: 'tone-crit', warn: 'tone-warn', ok: 'tone-ok', info: 'tone-off' };
const TONE_ICON: Record<string, typeof Bell> = { crit: AlertTriangle, warn: Clock, ok: Bell, info: Bell };

/** An alert's URL without the record it points at — the module's own landing page. */
function moduleRouteOf(alert: LiveAlert | undefined): string {
  if (!alert?.actionUrl) return '/notifications';
  const [path] = alert.actionUrl.split('?');
  return path || '/notifications';
}

export function AlertCard({ alert, onOpen }: { alert: LiveAlert; onOpen?: (a: LiveAlert) => void }) {
  const navigate = useNavigate();
  const Icon = TONE_ICON[alert.tone] || Bell;
  const go = () => { if (onOpen) onOpen(alert); else navigate(alert.actionUrl); };
  return (
    <button type="button" className={`alert-card ${TONE_CLASS[alert.tone] || 'tone-off'}`} onClick={go} title="Open">
      <div className="alert-card-top">
        <span className="alert-card-title">{alert.title}</span>
        <span className="alert-dot" />
      </div>
      {alert.value && <div className="alert-card-value"><Icon size={16} className="alert-card-ico" /> {alert.value}</div>}
      {alert.message && <div className="alert-card-msg">{alert.message}</div>}
      <div className="alert-card-meta">
        <span className={`sev-pill sev-${alert.tone}`}>{alert.severity}</span>
        {alert.dueDate && <span className="alert-card-due">{alert.dueDate}</span>}
      </div>
      <div className="alert-card-foot">{[alert.moduleLabel, alert.sectionName, alert.detail].filter(Boolean).join(' · ')}</div>
    </button>
  );
}

export function AlertGrid({ alerts, onOpen, emptyText = 'No active alerts — all clear.' }: { alerts: LiveAlert[]; onOpen?: (a: LiveAlert) => void; emptyText?: string }) {
  if (!alerts || alerts.length === 0) {
    return <div className="alert-empty"><CheckCircle2 size={18} /> <span>{emptyText}</span></div>;
  }
  return <div className="alert-grid">{alerts.map(a => <AlertCard key={a.key} alert={a} onOpen={onOpen} />)}</div>;
}

// ModuleAlerts — compact triage panel for a module dashboard. It mirrors the
// main dashboard: a severity summary and a short, ranked queue of what to do
// next, never a wall of cards. Renders nothing while empty unless `showEmpty`
// is set, so it never adds clutter to a clean module.
export function ModuleAlerts({ moduleKey, title = 'Alerts & attention', scope = 'all', limit = 4, showEmpty = false, onOpen }: {
  moduleKey: string; title?: string; scope?: 'all' | 'mine'; limit?: number; showEmpty?: boolean; onOpen?: (a: LiveAlert) => void;
}) {
  const navigate = useNavigate();
  const today = TODAY();
  const [alerts, setAlerts] = useState<LiveAlert[] | null>(null);
  const [denied, setDenied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [bucket, setBucket] = useState<Bucket | null>(null);

  useEffect(() => {
    let live = true;
    api<LiveAlert[]>(`/notifications/live-alerts?module=${encodeURIComponent(moduleKey)}${scope === 'mine' ? '&scope=mine' : ''}`)
      .then(a => { if (live) { setAlerts(a); setDenied(false); } })
      // A refusal is not "no alerts": someone without access to the alert feed
      // must not be told the module is clear, so the strip is dropped instead.
      .catch(() => { if (live) { setAlerts([]); setDenied(true); } });
    return () => { live = false; };
  }, [moduleKey, scope]);

  if (alerts === null || denied) return null;
  if (alerts.length === 0 && !showEmpty) return null;
  if (alerts.length === 0) {
    return <div className="alert-empty"><CheckCircle2 size={18} /> <span>No active alerts — all clear.</span></div>;
  }

  const counts = { crit: 0, overdue: 0, today: 0, info: 0 } as Record<Bucket, number>;
  for (const a of alerts) counts[bucketOf(a, today)]++;
  const total = alerts.length;

  const allFilters: { key: Bucket; label: string; value: number; chip: string }[] = [
    { key: 'crit', label: 'critical', value: counts.crit, chip: 'crit' },
    { key: 'overdue', label: 'overdue', value: counts.overdue, chip: 'warn' },
    { key: 'today', label: 'due today', value: counts.today, chip: 'warn' },
    { key: 'info', label: 'later', value: counts.info, chip: 'muted' },
  ];
  const filters = allFilters.filter(f => f.value > 0);

  const queue = bucket ? alerts.filter(a => bucketOf(a, today) === bucket) : alerts;
  const cap = expanded ? Math.min(queue.length, 12) : limit;
  const shown = queue.slice(0, cap);

  const open = (a: LiveAlert) => { if (onOpen) onOpen(a); else navigate(a.actionUrl); };

  return (
    <div className="card ma-card">
      <div className="ma-head">
        <h3>{title}</h3>
        <div className="ma-chips">
          {filters.map(f => (
            <button
              key={f.key}
              type="button"
              className={`alert-chip ${f.chip} ${bucket === f.key ? 'is-on' : ''}`}
              onClick={() => setBucket(b => (b === f.key ? null : f.key))}
              title={`Show only ${f.label} items`}
            >
              {f.value} {f.label}
            </button>
          ))}
          <span className="alert-chip muted">{total} total</span>
        </div>
      </div>

      <div className="ma-bar" title={`${counts.crit} critical · ${counts.overdue} overdue · ${counts.today} due today · ${counts.info} later`}>
        {counts.crit > 0 && <span className="ma-seg crit" style={{ flex: counts.crit }} />}
        {counts.overdue > 0 && <span className="ma-seg warn" style={{ flex: counts.overdue }} />}
        {counts.today > 0 && <span className="ma-seg ok" style={{ flex: counts.today }} />}
        {counts.info > 0 && <span className="ma-seg info" style={{ flex: counts.info }} />}
      </div>

      <ul className="pq-list ma-list">
        {shown.map(a => {
          const chip = dueChip(a, today);
          return (
            <li key={a.key} className="pq-item" onClick={() => open(a)} role="button" title={`Open: ${a.message || a.title}`}>
              <span className={`pq-rail ${RAIL_CLASS[bucketOf(a, today)]}`} />
              <div className="pq-main">
                <div className="pq-title">{a.title}</div>
                <div className="pq-meta">{[a.sectionName, a.detail].filter(Boolean).join(' · ') || a.moduleLabel}</div>
              </div>
              <span className={`pq-due ${chip.tone}`}>{chip.text}</span>
              <ArrowRight size={15} className="pq-go" />
            </li>
          );
        })}
      </ul>

      {queue.length > limit && (
        <div className="ma-foot">
          <button type="button" className="alert-more" onClick={() => setExpanded(e => !e)}>
            {expanded ? 'Show fewer' : `${queue.length - limit} more`} <ChevronRight size={13} />
          </button>
          {bucket && <button type="button" className="alert-more" onClick={() => { setBucket(null); setExpanded(false); }}>Show all {total} <ChevronRight size={13} /></button>}
        </div>
      )}
      {!(queue.length > limit) && bucket && (
        <div className="ma-foot">
          <button type="button" className="alert-more" onClick={() => setBucket(null)}>Show all {total} <ChevronRight size={13} /></button>
        </div>
      )}
    </div>
  );
}

// AlertSummary — the main-dashboard consolidated view: one compact card per
// module that has active alerts, each opening the module.
export function AlertSummary({ onOpenAlert }: { onOpenAlert?: (a: LiveAlert) => void }) {
  const navigate = useNavigate();
  const [data, setData] = useState<LiveAlertsGrouped | null>(null);
  const [openModule, setOpenModule] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api<LiveAlertsGrouped>('/notifications/live-alerts?grouped=true')
      .then(d => { if (live) setData(d); })
      .catch(() => { if (live) setData({ total: 0, groups: [] }); });
    return () => { live = false; };
  }, []);

  if (!data) return null;
  if (data.total === 0) {
    return <div className="alert-empty big"><CheckCircle2 size={20} /> <span>No active alerts across the laboratory. Everything is up to date.</span></div>;
  }

  const activeGroup = openModule ? data.groups.find(g => g.module === openModule) : null;

  return (
    <section className="alert-section">
      <div className="alert-section-head">
        <h3>Alerts across the laboratory</h3>
        <span className="alert-chip muted">{data.total} active</span>
      </div>
      <div className="alert-module-grid">
        {data.groups.map(g => (
          <button key={g.module} type="button" className={`alert-module-card ${g.crit ? 'has-crit' : g.warn ? 'has-warn' : ''} ${openModule === g.module ? 'is-open' : ''}`} onClick={() => setOpenModule(m => m === g.module ? null : g.module)}>
            <div className="alert-module-top">
              <span className="alert-module-name">{g.moduleLabel}</span>
              <span className="alert-module-total">{g.total}</span>
            </div>
            <div className="alert-module-counts">
              {g.crit > 0 && <span className="alert-chip crit"><AlertTriangle size={11} />{g.crit}</span>}
              {g.warn > 0 && <span className="alert-chip warn"><Clock size={11} />{g.warn}</span>}
              {g.crit === 0 && g.warn === 0 && <span className="alert-chip muted">{g.total} info</span>}
            </div>
          </button>
        ))}
      </div>
      {activeGroup && (
        <div className="alert-module-detail">
          <div className="alert-section-head">
            <h4>{activeGroup.moduleLabel} — {activeGroup.total} alert(s)</h4>
            {/* The module itself, not whichever alert happened to sort first —
                the individual records are one click away in the grid below. */}
            <button type="button" className="alert-more" onClick={() => navigate(moduleRouteOf(activeGroup.alerts[0]))}>Open module <ChevronRight size={13} /></button>
          </div>
          <AlertGrid alerts={activeGroup.alerts.slice(0, 8)} onOpen={onOpenAlert} />
        </div>
      )}
    </section>
  );
}
