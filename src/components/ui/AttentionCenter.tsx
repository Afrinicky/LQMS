import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CheckCircle2, ArrowRight, ChevronRight } from 'lucide-react';
import { api } from '../../services/api';
import type { LiveAlert, LiveAlertsGrouped } from '../../../shared/types/api';

// ==========================================================================
// AttentionCenter — the redesigned, chart-forward triage surface that opens
// every dashboard. It is driven by the always-current, system-wide live-alert
// feed (not a single user's inbox), so it faithfully reflects everything that
// needs attention across the laboratory, for every role.
//
// It collapses an unbounded pile of alerts into one calm summary:
//   • a severity ring (how much needs attention, by urgency)
//   • a quality-health meter (share of open work that is on track)
//   • a short, ranked "top priorities" queue (never a wall of cards)
// Everything is clickable and drills into the exact record it comes from.
// ==========================================================================

const TODAY = () => new Date().toISOString().slice(0, 10);

type Bucket = 'crit' | 'overdue' | 'today' | 'info';
const RAIL_CLASS: Record<Bucket, string> = { crit: 'crit', overdue: 'warn', today: 'ok', info: 'info' };

// Classify one live alert into a single, mutually-exclusive priority bucket
// so the ring segments always add up to the number of active alerts.
function bucketOf(a: LiveAlert, today: string): Bucket {
  if (a.tone === 'crit') return 'crit';
  if (a.dueDate && a.dueDate < today) return 'overdue';
  if (a.dueDate === today) return 'today';
  return 'info';
}

function dueChip(a: LiveAlert, today: string): { text: string; tone: 'crit' | 'warn' | 'muted' } {
  if (a.dueDate && a.dueDate < today) {
    const days = Math.max(1, Math.round((new Date(today).getTime() - new Date(a.dueDate).getTime()) / 86400000));
    return { text: `${days}d overdue`, tone: 'crit' };
  }
  if (a.dueDate === today) return { text: 'Today', tone: 'warn' };
  if (a.tone === 'crit') return { text: 'Critical', tone: 'crit' };
  if (a.value) return { text: a.value, tone: 'muted' };
  if (a.dueDate) return { text: a.dueDate, tone: 'muted' };
  return { text: (a.notificationType || 'open').replace(/_/g, ' '), tone: 'muted' };
}

// Small dependency-free donut for the severity ring.
function Ring({ segments, total }: { segments: { value: number; color: string }[]; total: number }) {
  const size = 150, thickness = 15, r = (size - thickness) / 2, cx = size / 2, c = 2 * Math.PI * r;
  let offset = 0;
  return (
    <div className="donut-svg" style={{ width: size, height: size }}>
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size}>
        <circle cx={cx} cy={cx} r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={thickness} />
        {total > 0 && (
          <g transform={`rotate(-90 ${cx} ${cx})`}>
            {segments.map((s, i) => {
              if (s.value <= 0) return null;
              const len = (s.value / total) * c;
              const el = <circle key={i} cx={cx} cy={cx} r={r} fill="none" stroke={s.color} strokeWidth={thickness} strokeDasharray={`${len} ${c - len}`} strokeDashoffset={-offset} strokeLinecap="butt" />;
              offset += len;
              return el;
            })}
          </g>
        )}
      </svg>
      <div className="donut-center"><strong>{total}</strong><span>Active</span></div>
    </div>
  );
}

export function AttentionCenter() {
  const navigate = useNavigate();
  const today = TODAY();
  const [alerts, setAlerts] = useState<LiveAlert[] | null>(null);

  useEffect(() => {
    let live = true;
    api<LiveAlert[]>('/notifications/live-alerts')
      .then(a => { if (live) setAlerts(a); })
      .catch(() => { if (live) setAlerts([]); });
    return () => { live = false; };
  }, []);

  const { counts, total } = useMemo(() => {
    const counts = { crit: 0, overdue: 0, today: 0, info: 0 } as Record<Bucket, number>;
    for (const a of alerts || []) counts[bucketOf(a, today)]++;
    return { counts, total: (alerts || []).length };
  }, [alerts, today]);

  if (alerts === null) return null; // still loading — keep the layout calm

  // Empty state — clean and reassuring, no charts needed.
  if (total === 0) {
    return (
      <div className="attn-clear card">
        <span className="attn-clear-ico"><CheckCircle2 size={22} /></span>
        <div>
          <strong>You're all caught up.</strong>
          <p>No active alerts across the laboratory right now. Everything is up to date.</p>
        </div>
        <button type="button" className="pq-link" onClick={() => navigate('/notifications')}>Open inbox <ArrowRight size={13} /></button>
      </div>
    );
  }

  const needAttention = counts.crit + counts.overdue;
  const onTrack = total > 0 ? Math.round(((total - needAttention) / total) * 100) : 100;
  const grade = onTrack >= 70 ? 'good' : onTrack >= 40 ? 'warn' : 'bad';

  const ringSegments = [
    { value: counts.crit, color: 'var(--danger)' },
    { value: counts.overdue, color: 'var(--warning)' },
    { value: counts.today, color: 'var(--accent-bright)' },
    { value: counts.info, color: 'var(--faint)' },
  ];
  const legend: { label: string; value: number; color: string }[] = [
    { label: 'Critical', value: counts.crit, color: 'var(--danger)' },
    { label: 'Overdue', value: counts.overdue, color: 'var(--warning)' },
    { label: 'Due today', value: counts.today, color: 'var(--accent-bright)' },
    { label: 'Info / later', value: counts.info, color: 'var(--faint)' },
  ];

  return (
    <div className="attn-hero">
      {/* Severity ring + quality-health meter */}
      <div className="card attn-ring-card">
        <div className="attn-ring-head"><h3>Attention required</h3></div>
        <div className="attn-ring-body">
          <div className="attn-ring"><Ring segments={ringSegments} total={total} /></div>
          <ul className="attn-legend">
            {legend.map(l => (
              <li key={l.label} onClick={() => navigate('/notifications')} role="button" title="Open the inbox">
                <span className="d" style={{ background: l.color }} />
                <span className="l">{l.label}</span>
                <span className="v" style={{ color: l.color === 'var(--faint)' ? 'var(--text)' : l.color }}>{l.value}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="attn-health">
          <div className="ah-head"><span>Items on track</span><strong className={grade}>{onTrack}%</strong></div>
          <div className="ah-track"><div className={`ah-fill ${grade}`} style={{ width: `${onTrack}%` }} /></div>
          <div className="ah-note">
            {needAttention > 0 ? `${needAttention} of ${total} need urgent action` : `All ${total} active items are on schedule`}
          </div>
        </div>
      </div>

      {/* Ranked priority queue — short by design. Server returns alerts already
          ordered crit → warn → info, then by due date, so the top slice is the
          right work to do next. */}
      <div className="card pq-card">
        <div className="pq-head">
          <h3>Top priorities</h3>
          <button type="button" className="pq-link" onClick={() => navigate('/notifications')}>View all {total} <ArrowRight size={13} /></button>
        </div>
        <ul className="pq-list">
          {(alerts || []).slice(0, 5).map(a => {
            const b = bucketOf(a, today);
            const chip = dueChip(a, today);
            return (
              <li key={a.key} className="pq-item" onClick={() => navigate(a.actionUrl)} role="button" title="Open the record">
                <span className={`pq-rail ${RAIL_CLASS[b]}`} />
                <div className="pq-main">
                  <div className="pq-title">{a.title}</div>
                  <div className="pq-meta">
                    <span className="badge">{a.moduleLabel}</span>
                    {a.sectionName && <span>{a.sectionName}</span>}
                  </div>
                </div>
                <span className={`pq-due ${chip.tone}`}>{chip.text}</span>
                <ArrowRight size={15} className="pq-go" />
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

// AlertsByModule — the whole-laboratory alert picture as one compact chart:
// a ranked, stacked severity bar per module. Replaces the old wall of module
// cards; each row opens that module. Renders nothing while loading and a clean
// "all clear" line when there is nothing to show.
export function AlertsByModule({ limit = 8 }: { limit?: number }) {
  const navigate = useNavigate();
  const [data, setData] = useState<LiveAlertsGrouped | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let live = true;
    api<LiveAlertsGrouped>('/notifications/live-alerts?grouped=true')
      .then(d => { if (live) setData(d); })
      .catch(() => { if (live) setData({ total: 0, groups: [] }); });
    return () => { live = false; };
  }, []);

  if (!data) return null;

  if (data.total === 0) {
    return (
      <div className="alert-empty big"><CheckCircle2 size={20} /> <span>No active alerts across the laboratory. Everything is up to date.</span></div>
    );
  }

  const max = Math.max(1, ...data.groups.map(g => g.total));
  const shown = expanded ? data.groups : data.groups.slice(0, limit);

  return (
    <div className="card">
      <div className="abm-head">
        <div>
          <h3>Alerts across the laboratory</h3>
          <p>{data.total} active {data.total === 1 ? 'alert' : 'alerts'} in {data.groups.length} module{data.groups.length === 1 ? '' : 's'} — click a module to resolve.</p>
        </div>
        <div className="abm-key">
          <span><i style={{ background: 'var(--danger)' }} />Critical</span>
          <span><i style={{ background: 'var(--warning)' }} />Due</span>
          <span><i style={{ background: 'var(--accent-bright)' }} />Info</span>
        </div>
      </div>
      <ul className="abm-list">
        {shown.map(g => {
          const info = Math.max(0, g.total - g.crit - g.warn);
          const to = g.alerts[0]?.actionUrl || '/notifications';
          const w = (g.total / max) * 100;
          return (
            <li key={g.module} className="abm-row" onClick={() => navigate(to)} role="button" title={`Open ${g.moduleLabel}`}>
              <span className="abm-name">{g.moduleLabel}</span>
              <div className="abm-track" style={{ width: `${Math.max(12, w)}%` }}>
                {g.crit > 0 && <div className="abm-seg crit" style={{ flex: g.crit }} title={`${g.crit} critical`} />}
                {g.warn > 0 && <div className="abm-seg warn" style={{ flex: g.warn }} title={`${g.warn} due`} />}
                {info > 0 && <div className="abm-seg info" style={{ flex: info }} title={`${info} info`} />}
              </div>
              <span className="abm-total">{g.total}</span>
              <ChevronRight size={15} className="abm-go" />
            </li>
          );
        })}
      </ul>
      {data.groups.length > limit && (
        <button type="button" className="alert-more" onClick={() => setExpanded(e => !e)}>
          {expanded ? 'Show fewer' : `Show all ${data.groups.length} modules`} <ChevronRight size={13} />
        </button>
      )}
    </div>
  );
}
