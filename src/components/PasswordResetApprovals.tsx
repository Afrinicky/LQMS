import { useCallback, useEffect, useState } from 'react';
import { ShieldQuestion, Check, X, Clock, Loader2 } from 'lucide-react';
import { api } from '../services/api';

/**
 * Password reset requests waiting on an administrator.
 *
 * The approval is the whole security boundary — there is no email link to
 * prove the person is who they say they are, so the human check replaces it.
 * The card therefore leads with that, and shows where the request came from so
 * "someone at the Haematology bench" can be told apart from "someone on a
 * device nobody recognises".
 */
type ResetRequest = {
  id: number;
  requested_username: string;
  full_name: string | null;
  role_name?: string | null;
  reason: string | null;
  ip_address: string | null;
  device_id: string | null;
  status: string;
  created_at: string;
  decided_at?: string | null;
  decided_by?: string | null;
};

const ago = (iso: string) => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
};

export default function PasswordResetApprovals({ compact = false }: { compact?: boolean }) {
  const [pending, setPending] = useState<ResetRequest[]>([]);
  const [recent, setRecent] = useState<ResetRequest[]>([]);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    api<{ pending: ResetRequest[]; recent: ResetRequest[] }>('/users/password-resets')
      .then(r => { setPending(r.pending ?? []); setRecent(r.recent ?? []); })
      .catch(e => setError((e as Error).message));
  }, []);

  useEffect(() => {
    load();
    // Someone is standing at a screen waiting, so this refreshes on its own.
    const id = setInterval(load, 15000);
    return () => clearInterval(id);
  }, [load]);

  async function decide(id: number, decision: 'approve' | 'deny') {
    setBusy(id); setError(null); setNotice(null);
    try {
      await api(`/users/password-resets/${id}/decide`, { method: 'POST', body: JSON.stringify({ decision }) });
      setNotice(decision === 'approve'
        ? 'Approved. The reset form has opened on their screen.'
        : 'Refused. They have been told.');
      load();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  }

  if (compact && pending.length === 0) return null;

  return (
    <div className="card pwra">
      <div className="pwra-head">
        <h3><ShieldQuestion size={16} /> Password reset requests</h3>
        {pending.length > 0 && <span className="pwra-count">{pending.length} waiting</span>}
      </div>

      {error && <div className="error">{error}</div>}
      {notice && <div className="notice-ok">{notice}</div>}

      {pending.length === 0 ? (
        <p className="muted" style={{ margin: 0 }}>Nothing waiting. Requests raised from the sign-in screen appear here.</p>
      ) : (
        <>
          <p className="pwra-warn">
            Confirm who is asking before you approve — in person or by telephone. Approving hands the
            person at that screen the ability to set this account&apos;s password.
          </p>
          <ul className="pwra-list">
            {pending.map(r => (
              <li key={r.id}>
                <div className="pwra-who">
                  <strong>{r.full_name || r.requested_username}</strong>
                  <span className="pwra-user">{r.requested_username}{r.role_name ? ` · ${r.role_name}` : ''}</span>
                  {r.reason && <span className="pwra-reason">“{r.reason}”</span>}
                  <span className="pwra-meta">
                    <Clock size={11} /> {ago(r.created_at)}
                    {r.ip_address && <> · from {r.ip_address}</>}
                    {r.device_id && <> · device {r.device_id.slice(0, 12)}</>}
                  </span>
                </div>
                <div className="pwra-act">
                  <button type="button" disabled={busy === r.id} onClick={() => decide(r.id, 'approve')}>
                    {busy === r.id ? <Loader2 size={13} className="spin" /> : <Check size={13} />} Approve
                  </button>
                  <button type="button" className="secondary" disabled={busy === r.id} onClick={() => decide(r.id, 'deny')}>
                    <X size={13} /> Refuse
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      {!compact && recent.length > 0 && (
        <details className="pwra-recent">
          <summary>Recent decisions ({recent.length})</summary>
          <table className="data-table">
            <thead><tr><th>Account</th><th>Outcome</th><th>By</th><th>When</th></tr></thead>
            <tbody>
              {recent.map(r => (
                <tr key={r.id}>
                  <td>{r.full_name || r.requested_username}</td>
                  <td><span className={`badge ${r.status}`}>{r.status}</span></td>
                  <td>{r.decided_by || '—'}</td>
                  <td>{r.decided_at ? ago(r.decided_at) : ago(r.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </div>
  );
}
