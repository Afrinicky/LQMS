import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, CheckCircle2, Inbox } from 'lucide-react';
import { api } from '../services/api';
import type { NotificationRecord } from '../../shared/types/api';

/**
 * The staff member's notification inbox, on the dashboard.
 *
 * This is the real inbox, not a count: the alerts routed to this person, newest
 * and most urgent first. Clicking a row marks it read and opens the record that
 * raised it — the dashboard's promise that every number leads to the thing you
 * have to do about it.
 *
 * The server only returns alerts from modules the reader may view, so nothing
 * here can reveal work in an area they have no access to.
 */
const SEVERITY_RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };

function severityTone(severity: string): string {
  if (severity === 'urgent') return 'crit';
  if (severity === 'high') return 'warn';
  if (severity === 'medium') return 'ok';
  return 'info';
}

function relativeDue(dueDate?: string | null): { text: string; tone: 'crit' | 'warn' | 'muted' } | null {
  if (!dueDate) return null;
  const today = new Date().toISOString().slice(0, 10);
  const due = String(dueDate).slice(0, 10);
  if (due < today) {
    const days = Math.max(1, Math.round((Date.parse(today) - Date.parse(due)) / 86400000));
    return { text: `${days}d overdue`, tone: 'crit' };
  }
  if (due === today) return { text: 'Today', tone: 'warn' };
  return { text: due, tone: 'muted' };
}

export default function DashboardInbox({ limit = 6 }: { limit?: number }) {
  const navigate = useNavigate();
  const [items, setItems] = useState<NotificationRecord[] | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  async function load() {
    try {
      const rows = await api<NotificationRecord[]>('/notifications?mine=true');
      const open = rows.filter(n => n.status !== 'resolved' && n.status !== 'dismissed');
      open.sort((a, b) => {
        const s = (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9);
        if (s !== 0) return s;
        return String(b.created_at).localeCompare(String(a.created_at));
      });
      setItems(open);
    } catch {
      setItems([]);
    }
  }

  useEffect(() => { void load(); }, []);

  async function open(n: NotificationRecord) {
    setBusyId(n.id);
    try {
      if (n.status === 'unread') await api(`/notifications/${n.id}/read`, { method: 'POST', body: JSON.stringify({}) });
      navigate(n.action_url || '/notifications');
    } catch {
      navigate('/notifications');
    } finally {
      setBusyId(null);
    }
  }

  const unread = (items ?? []).filter(n => n.status === 'unread').length;

  return (
    <div className="card dash-inbox">
      <div className="di-head">
        <div>
          <h3><Inbox size={16} /> My inbox</h3>
          <p>{items === null ? 'Loading…' : unread > 0 ? `${unread} unread of ${items.length} open` : `${items.length} open`}</p>
        </div>
        <button type="button" className="pq-link" onClick={() => navigate('/notifications')}>
          Open inbox <ArrowRight size={13} />
        </button>
      </div>

      {items !== null && items.length === 0 && (
        <div className="di-clear">
          <CheckCircle2 size={18} />
          <span>Nothing waiting on you. Your inbox is clear.</span>
        </div>
      )}

      <ul className="di-list">
        {(items ?? []).slice(0, limit).map(n => {
          const due = relativeDue(n.due_date);
          return (
            <li key={n.id} className={`di-item${n.status === 'unread' ? ' unread' : ''}`}
              role="button" tabIndex={0} aria-busy={busyId === n.id}
              onClick={() => void open(n)}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void open(n); } }}
              title="Open the record this alert came from">
              <span className={`di-rail ${severityTone(n.severity)}`} />
              <div className="di-main">
                <div className="di-title">{n.title}</div>
                <div className="di-meta">
                  <span className="badge">{(n.module_key || 'general').replace(/_/g, ' ')}</span>
                  <span>{(n.notification_type || '').replace(/_/g, ' ')}</span>
                </div>
              </div>
              {due && <span className={`di-due ${due.tone}`}>{due.text}</span>}
              <ArrowRight size={15} className="di-go" />
            </li>
          );
        })}
      </ul>

      {items !== null && items.length > limit && (
        <button type="button" className="di-more" onClick={() => navigate('/notifications')}>
          {items.length - limit} more in the inbox <ArrowRight size={13} />
        </button>
      )}
    </div>
  );
}
