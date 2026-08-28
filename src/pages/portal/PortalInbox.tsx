import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, ArrowRight, Bell, CheckCircle2, Inbox } from 'lucide-react';
import { api } from '../../services/api';
import { dueTone, isOpenAlert, usePortal } from './portalData';
import type { NotificationRecord } from '../../../shared/types/api';

/**
 * My inbox — every alert the system routed to this person, and nothing else.
 *
 * This is the whole inbox, not a preview: it moved here from Notifications &
 * Reports because an alert is not a report. It is a piece of work waiting on
 * one named person, and it belongs beside the rest of their work.
 *
 * Opening a row marks it read and navigates to the record that raised it, so
 * the alert is a way into the job rather than a note about it.
 */
const SEVERITY_RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3, info: 4 };
const SEV_TONE: Record<string, string> = { urgent: 'crit', high: 'crit', medium: 'warn', low: 'ok', info: 'info' };

export type InboxFilter = 'active' | 'urgent' | 'today' | 'overdue' | 'resolved' | 'all';

const FILTERS: { key: InboxFilter; label: string }[] = [
  { key: 'active', label: 'Open' },
  { key: 'urgent', label: 'Urgent' },
  { key: 'today', label: 'Due today' },
  { key: 'overdue', label: 'Overdue' },
  { key: 'resolved', label: 'Cleared' },
  { key: 'all', label: 'Everything' },
];

export function filterInbox(list: NotificationRecord[], filter: InboxFilter, search = ''): NotificationRecord[] {
  const today = new Date().toISOString().slice(0, 10);
  let rows = list;
  if (filter === 'active') rows = rows.filter(isOpenAlert);
  else if (filter === 'urgent') rows = rows.filter(n => isOpenAlert(n) && ['urgent', 'high'].includes(n.severity));
  else if (filter === 'today') rows = rows.filter(n => isOpenAlert(n) && n.due_date === today);
  else if (filter === 'overdue') rows = rows.filter(n => isOpenAlert(n) && !!n.due_date && String(n.due_date).slice(0, 10) < today);
  else if (filter === 'resolved') rows = rows.filter(n => !isOpenAlert(n));
  const q = search.trim().toLowerCase();
  if (q) {
    rows = rows.filter(n => `${n.title} ${n.message ?? ''} ${n.module_key ?? ''}`.toLowerCase().includes(q));
  }
  return [...rows].sort((a, b) => {
    const s = (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9);
    if (s !== 0) return s;
    return String(b.created_at).localeCompare(String(a.created_at));
  });
}

export function InboxRow({ notification, onOpen, onTransition }: {
  notification: NotificationRecord;
  onOpen: (n: NotificationRecord) => void;
  onTransition?: (id: number, action: 'acknowledge' | 'resolve' | 'dismiss') => void;
}) {
  const n = notification;
  const due = dueTone(n.due_date);
  const tone = SEV_TONE[n.severity] ?? 'info';
  const open = isOpenAlert(n);
  return (
    <li className={`pt-row sev-${tone}${n.status === 'unread' ? ' is-unread' : ''}`}>
      <span className={`pt-rail ${tone}`} />
      <button type="button" className="pt-row-main" onClick={() => onOpen(n)}
        title={n.action_label ? `${n.action_label} — opens the record this alert is about` : 'Open the record this alert is about'}>
        <span className="pt-row-title">
          {(n.severity === 'urgent' || n.severity === 'high')
            ? <AlertTriangle size={13} className="pt-sev-ico crit" />
            : <Bell size={13} className="pt-sev-ico" />}
          {n.title}
        </span>
        {n.message && <span className="pt-row-msg">{n.message}</span>}
        <span className="pt-row-meta">
          <span className="badge">{(n.module_key || 'general').replace(/_/g, ' ')}</span>
          <span>{(n.notification_type || '').replace(/_/g, ' ')}</span>
          {due && <span className={`pt-due ${due.tone}`}>{due.text}</span>}
          {!open && <span className="badge done">{n.status}</span>}
        </span>
      </button>
      <div className="pt-row-side">
        {open && onTransition && <>
          <button type="button" className="pt-mini" title="Acknowledge — you have seen it"
            onClick={() => onTransition(n.id, 'acknowledge')}>Ack</button>
          <button type="button" className="pt-mini ok" title="Mark resolved — the work is done"
            onClick={() => onTransition(n.id, 'resolve')}><CheckCircle2 size={13} /></button>
          <button type="button" className="pt-mini" title="Dismiss — this does not apply"
            onClick={() => onTransition(n.id, 'dismiss')}>×</button>
        </>}
        <ArrowRight size={15} className="pt-go" />
      </div>
    </li>
  );
}

export default function PortalInbox() {
  const navigate = useNavigate();
  const { inbox, reloadInbox, setError } = usePortal();
  const [filter, setFilter] = useState<InboxFilter>('active');
  const [search, setSearch] = useState('');

  const rows = useMemo(() => filterInbox(inbox, filter, search), [inbox, filter, search]);
  const counts = useMemo(() => ({
    active: filterInbox(inbox, 'active').length,
    urgent: filterInbox(inbox, 'urgent').length,
    today: filterInbox(inbox, 'today').length,
    overdue: filterInbox(inbox, 'overdue').length,
    resolved: filterInbox(inbox, 'resolved').length,
    all: inbox.length,
  }), [inbox]);

  async function open(n: NotificationRecord) {
    try {
      if (n.status === 'unread') await api(`/notifications/${n.id}/read`, { method: 'POST', body: JSON.stringify({}) });
      void reloadInbox();
    } catch { /* opening the record matters more than recording the read */ }
    if (n.action_url) navigate(n.action_url);
  }

  async function transition(id: number, action: 'acknowledge' | 'resolve' | 'dismiss') {
    try {
      await api(`/notifications/${id}/${action}`, { method: 'POST', body: JSON.stringify({}) });
      await reloadInbox();
    } catch (e) { setError((e as Error).message); }
  }

  return (
    <section className="portal-panel">
      <div className="pp-head">
        <div>
          <h3><Inbox size={16} /> My inbox</h3>
          <p>Every alert routed to you. Opening one marks it read and takes you to the record it is about.</p>
        </div>
        <input className="pp-search" value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search your alerts…" aria-label="Search your alerts" />
      </div>

      <div className="pp-filters" role="tablist" aria-label="Inbox filters">
        {FILTERS.map(f => (
          <button key={f.key} type="button" role="tab" aria-selected={filter === f.key}
            className={filter === f.key ? 'active' : ''} onClick={() => setFilter(f.key)}>
            {f.label}<span className="pp-filter-n">{counts[f.key]}</span>
          </button>
        ))}
      </div>

      {rows.length === 0 ? (
        <div className="pp-clear">
          <CheckCircle2 size={18} />
          <span>{filter === 'active' ? 'Nothing is waiting on you. Your inbox is clear.' : 'Nothing matches this view.'}</span>
        </div>
      ) : (
        <ul className="pt-list">
          {rows.map(n => <InboxRow key={n.id} notification={n} onOpen={open} onTransition={transition} />)}
        </ul>
      )}
    </section>
  );
}
