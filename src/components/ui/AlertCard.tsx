import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, Clock, Bell, CheckCircle2, ChevronRight } from 'lucide-react';
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

// ModuleAlerts — drop-in strip for a module dashboard. Fetches this module's
// live alerts and renders them as env-style cards. Renders nothing while empty
// unless `showEmpty` is set, so it never adds clutter to a clean module.
export function ModuleAlerts({ moduleKey, title = 'Alerts & attention', scope = 'all', limit, showEmpty = false, onOpen }: {
  moduleKey: string; title?: string; scope?: 'all' | 'mine'; limit?: number; showEmpty?: boolean; onOpen?: (a: LiveAlert) => void;
}) {
  const [alerts, setAlerts] = useState<LiveAlert[] | null>(null);
  const [denied, setDenied] = useState(false);
  const [expanded, setExpanded] = useState(false);
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

  const cap = limit && !expanded ? limit : alerts.length;
  const shown = alerts.slice(0, cap);
  const crit = alerts.filter(a => a.tone === 'crit').length;
  const warn = alerts.filter(a => a.tone === 'warn').length;

  return (
    <section className="alert-section">
      <div className="alert-section-head">
        <h3>{title}</h3>
        <div className="alert-section-counts">
          {crit > 0 && <span className="alert-chip crit"><AlertTriangle size={12} />{crit} critical</span>}
          {warn > 0 && <span className="alert-chip warn"><Clock size={12} />{warn} due</span>}
          <span className="alert-chip muted">{alerts.length} total</span>
        </div>
      </div>
      <AlertGrid alerts={shown} onOpen={onOpen} />
      {limit && alerts.length > limit && (
        <button type="button" className="alert-more" onClick={() => setExpanded(e => !e)}>
          {expanded ? 'Show fewer' : `Show all ${alerts.length}`} <ChevronRight size={13} />
        </button>
      )}
    </section>
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
