import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CheckCircle2, ArrowRight, ChevronRight } from 'lucide-react';
import { api } from '../../services/api';
import type { NotificationRecord, LiveAlertsGrouped } from '../../../shared/types/api';
import { DonutChart } from './Charts';

// ==========================================================================
// AttentionCenter — the redesigned, chart-forward triage surface that opens
// every dashboard. It collapses an unbounded pile of notifications into one
// calm, professional summary:
//   • a severity ring (how much needs attention, by urgency)
//   • a quality-health meter (share of open work that is on track)
//   • a short, ranked "top priorities" queue (never a wall of cards)
// Everything is clickable and drills into the exact record / module it comes
// from, so the summary is a launch-pad, not a dead end.
// ==========================================================================

const TODAY = () => new Date().toISOString().slice(0, 10);

type Bucket = 'crit' | 'overdue' | 'today' | 'info';

// Classify one notification into a single, mutually-exclusive priority bucket
// so the ring segments always add up to the number of open items.
function bucketOf(n: NotificationRecord, today: string): Bucket {
  if (n.severity === 'urgent' || n.severity === 'high') return 'crit';
  if (n.due_date && n.due_date < today) return 'overdue';
  if (n.due_date === today) return 'today';
  return 'info';
}

const BUCKET_RANK: Record<Bucket, number> = { crit: 0, overdue: 1, today: 2, info: 3 };
const RAIL_CLASS: Record<Bucket, string> = { crit: 'crit', overdue: 'warn', today: 'ok', info: 'info' };

function dueText(n: NotificationRecord, today: string): { text: string; tone: 'crit' | 'warn' | 'muted' } {
  if (n.due_date && n.due_date < today) {
    const days = Math.max(1, Math.round((new Date(today).getTime() - new Date(n.due_date).getTime()) / 86400000));
    return { text: `${days}d overdue`, tone: 'crit' };
  }
  if (n.due_date === today) return { text: 'Today', tone: 'warn' };
  if (n.due_date) return { text: n.due_date, tone: 'muted' };
  if (n.severity === 'urgent' || n.severity === 'high') return { text: 'Urgent', tone: 'crit' };
  return { text: (n.notification_type || 'open').replace(/_/g, ' '), tone: 'muted' };
}

export function AttentionCenter({
  inbox,
  resolvedCount = 0,
  onOpen,
  onOpenInbox,
}: {
  /** Open (unresolved) notifications for the current user. */
  inbox: NotificationRecord[];
  /** How many of this user's notifications are already resolved/dismissed. */
  resolvedCount?: number;
  /** Open one notification — should mark read and navigate to its source. */
  onOpen: (n: NotificationRecord) => void;
  /** Open the full inbox, optionally pre-filtered to a view. */
  onOpenInbox: (view?: 'active' | 'urgent' | 'today' | 'all') => void;
}) {
  const today = TODAY();

  const { counts, open, ranked } = useMemo(() => {
    const counts = { crit: 0, overdue: 0, today: 0, info: 0 } as Record<Bucket, number>;
    for (const n of inbox) counts[bucketOf(n, today)]++;
    const open = inbox.length;
    // Rank by bucket, then by how overdue (older due date first), then newest.
    const ranked = [...inbox].sort((a, b) => {
      const ba = bucketOf(a, today), bb = bucketOf(b, today);
      if (BUCKET_RANK[ba] !== BUCKET_RANK[bb]) return BUCKET_RANK[ba] - BUCKET_RANK[bb];
      const ad = a.due_date || '9999-99-99', bd = b.due_date || '9999-99-99';
      return ad < bd ? -1 : ad > bd ? 1 : 0;
    });
    return { counts, open, ranked };
  }, [inbox, today]);

  // Empty state — clean and reassuring, no charts needed.
  if (open === 0) {
    return (
      <div className="attn-clear card">
        <span className="attn-clear-ico"><CheckCircle2 size={22} /></span>
        <div>
          <strong>You're all caught up.</strong>
          <p>No notifications need your attention right now.{resolvedCount > 0 ? ` ${resolvedCount} recently cleared.` : ''}</p>
        </div>
        <button type="button" className="pq-link" onClick={() => onOpenInbox('all')}>Open inbox <ArrowRight size={13} /></button>
      </div>
    );
  }

  const needAttention = counts.crit + counts.overdue;
  const onTrack = open > 0 ? Math.round(((open - needAttention) / open) * 100) : 100;

  const ringData = [
    { label: 'Critical', value: counts.crit, color: 'var(--danger)', onClick: () => onOpenInbox('urgent') },
    { label: 'Overdue', value: counts.overdue, color: 'var(--warning)', onClick: () => onOpenInbox('all') },
    { label: 'Due today', value: counts.today, color: 'var(--accent-bright)', onClick: () => onOpenInbox('today') },
    { label: 'Info / later', value: counts.info, color: 'var(--faint)', onClick: () => onOpenInbox('active') },
  ];

  const legend: { label: string; value: number; color: string; view: 'urgent' | 'all' | 'today' | 'active' }[] = [
    { label: 'Critical', value: counts.crit, color: 'var(--danger)', view: 'urgent' },
    { label: 'Overdue', value: counts.overdue, color: 'var(--warning)', view: 'all' },
    { label: 'Due today', value: counts.today, color: 'var(--accent-bright)', view: 'today' },
    { label: 'Info / later', value: counts.info, color: 'var(--faint)', view: 'active' },
  ];

  return (
    <div className="attn-hero">
      {/* Severity ring + quality-health meter */}
      <div className="card attn-ring-card">
        <div className="attn-ring-head"><h3>Attention required</h3></div>
        <div className="attn-ring-body">
          <div className="attn-ring">
            <DonutChart data={ringData} legend={false} size={150} thickness={15} centerValue={open} centerLabel="Open" />
          </div>
          <ul className="attn-legend">
            {legend.map(l => (
              <li key={l.label} onClick={() => onOpenInbox(l.view)} role="button" title={`Show ${l.label.toLowerCase()}`}>
                <span className="d" style={{ background: l.color }} />
                <span className="l">{l.label}</span>
                <span className="v" style={{ color: l.color === 'var(--faint)' ? 'var(--text)' : l.color }}>{l.value}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="attn-health">
          <div className="ah-head"><span>Items on track</span><strong className={onTrack >= 70 ? 'good' : onTrack >= 40 ? 'warn' : 'bad'}>{onTrack}%</strong></div>
          <div className="ah-track"><div className={`ah-fill ${onTrack >= 70 ? 'good' : onTrack >= 40 ? 'warn' : 'bad'}`} style={{ width: `${onTrack}%` }} /></div>
          <div className="ah-note">
            {needAttention > 0 ? `${needAttention} of ${open} need urgent action` : `All ${open} open items are on schedule`}
            {resolvedCount > 0 ? ` · ${resolvedCount} recently cleared` : ''}
          </div>
        </div>
      </div>

      {/* Ranked priority queue — short by design */}
      <div className="card pq-card">
        <div className="pq-head">
          <h3>Top priorities for you</h3>
          <button type="button" className="pq-link" onClick={() => onOpenInbox('active')}>View all {open} <ArrowRight size={13} /></button>
        </div>
        <ul className="pq-list">
          {ranked.slice(0, 5).map(n => {
            const b = bucketOf(n, today);
            const due = dueText(n, today);
            return (
              <li key={n.id} className="pq-item" onClick={() => onOpen(n)} role="button" title="Open the record">
                <span className={`pq-rail ${RAIL_CLASS[b]}`} />
                <div className="pq-main">
                  <div className="pq-title">{n.title}</div>
                  <div className="pq-meta">
                    <span className="badge">{(n.module_key || '').replace(/_/g, ' ')}</span>
                    <span>{(n.notification_type || '').replace(/_/g, ' ')}</span>
                  </div>
                </div>
                <span className={`pq-due ${due.tone}`}>{due.text}</span>
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
// cards; each row opens that module. Renders nothing when there is nothing to
// show, so a healthy lab shows a clean "all clear" line instead.
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
