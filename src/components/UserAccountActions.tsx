import { useEffect, useState } from 'react';
import { UserX, UserCheck, KeyRound, Trash2, ShieldAlert, Loader2 } from 'lucide-react';
import { api } from '../services/api';
import type { ApiUser } from '../../shared/types/api';

/**
 * What an administrator can do to somebody's account.
 *
 * Removing a user is two different acts and the difference matters to an
 * accredited laboratory. Deactivating ends access and keeps the person's
 * signatures, authorship and audit trail intact — that is almost always the
 * right answer, and it is reversible. Erasing is only offered for an account
 * that never touched a record; the server checks and refuses otherwise, so
 * this panel asks first and shows exactly what is holding it.
 */
type Impact = {
  user: { id: number; username: string; fullName: string; isActive: boolean };
  blockers: string[];
  canDeactivate: boolean;
  canDelete: boolean;
  historicReferences: { table: string; column: string; rows: number }[];
  totalHistoricRows: number;
};

const PRETTY_TABLE: Record<string, string> = {
  audit_logs: 'audit trail entries',
  e_signatures: 'electronic signatures',
  notifications: 'notifications',
  files: 'uploaded files',
  documents: 'documents',
  actions: 'actions',
  form_submissions: 'completed forms',
};
const pretty = (t: string) => PRETTY_TABLE[t] ?? t.replace(/_/g, ' ');

export default function UserAccountActions({ user, onChanged }: { user: ApiUser & { mustChangePassword?: boolean }; onChanged: () => void }) {
  const [impact, setImpact] = useState<Impact | null>(null);
  const [confirming, setConfirming] = useState<'deactivate' | 'delete' | null>(null);
  const [tempPassword, setTempPassword] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setImpact(null);
    api<Impact>(`/users/${user.id}/deletion-impact`).then(setImpact).catch(e => setError((e as Error).message));
  }, [user.id]);

  const run = async (label: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(label); setError(null); setNotice(null);
    try { await fn(); setNotice(done); onChanged(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(''); setConfirming(null); }
  };

  return (
    <div className="uaa">
      {error && <div className="error">{error}</div>}
      {notice && <div className="notice-ok">{notice}</div>}

      <div className="uaa-row">
        <div className="uaa-what">
          <strong><KeyRound size={14} /> Password</strong>
          <p>
            Hand over a temporary password — the account must choose its own the next time it signs in.
            If they have simply forgotten it, they can ask from the sign-in screen and you approve.
          </p>
        </div>
        <div className="uaa-do">
          <input type="text" value={tempPassword} onChange={e => setTempPassword(e.target.value)}
            placeholder="Temporary password" minLength={8} autoComplete="off" />
          <button type="button" disabled={busy !== '' || tempPassword.length < 8}
            onClick={() => run('temp', () => api(`/users/${user.id}/reset-password`, { method: 'POST', body: JSON.stringify({ newPassword: tempPassword }) }), 'Temporary password set. They must change it on first use.').then(() => setTempPassword(''))}>
            {busy === 'temp' ? <Loader2 size={13} className="spin" /> : null} Set temporary
          </button>
          {!user.mustChangePassword && (
            <button type="button" className="secondary" disabled={busy !== ''}
              onClick={() => run('force', () => api(`/users/${user.id}/require-password-change`, { method: 'POST', body: '{}' }), 'They will be asked to choose a new password at their next sign-in.')}>
              Require a change
            </button>
          )}
          {user.mustChangePassword && <span className="uaa-flag">Already required to change</span>}
        </div>
      </div>

      <div className="uaa-row">
        <div className="uaa-what">
          <strong>{user.isActive ? <><UserX size={14} /> Deactivate</> : <><UserCheck size={14} /> Reactivate</>}</strong>
          <p>
            {user.isActive
              ? 'Ends access immediately and signs them out everywhere. Their signatures, authorship and audit trail stay exactly as they are. Reversible.'
              : 'Restores access with the same role and permissions as before.'}
          </p>
        </div>
        <div className="uaa-do">
          {user.isActive ? (
            confirming === 'deactivate' ? (
              <>
                <span className="uaa-ask">Deactivate {user.username}?</span>
                <button type="button" className="danger" disabled={busy !== ''}
                  onClick={() => run('deact', () => api(`/users/${user.id}`, { method: 'DELETE' }), 'Account deactivated.')}>Yes, deactivate</button>
                <button type="button" className="secondary" onClick={() => setConfirming(null)}>Cancel</button>
              </>
            ) : (
              <button type="button" className="secondary" disabled={!impact?.canDeactivate || busy !== ''}
                title={impact?.blockers[0]} onClick={() => setConfirming('deactivate')}>Deactivate account</button>
            )
          ) : (
            <button type="button" disabled={busy !== ''}
              onClick={() => run('react', () => api(`/users/${user.id}/reactivate`, { method: 'POST', body: '{}' }), 'Account reactivated.')}>Reactivate</button>
          )}
        </div>
      </div>

      <div className="uaa-row danger-zone">
        <div className="uaa-what">
          <strong><Trash2 size={14} /> Erase permanently</strong>
          {!impact && <p className="muted">Checking what this account has touched…</p>}
          {impact && impact.canDelete && (
            <p>This account has never been used for anything, so it can be removed entirely. This cannot be undone.</p>
          )}
          {impact && !impact.canDelete && impact.blockers.length === 0 && (
            <p>
              <ShieldAlert size={13} /> Cannot be erased: this account is attached to{' '}
              <strong>{impact.totalHistoricRows.toLocaleString()}</strong> record{impact.totalHistoricRows === 1 ? '' : 's'} the
              laboratory has to keep —{' '}
              {impact.historicReferences.slice(0, 3).map(r => `${r.rows.toLocaleString()} ${pretty(r.table)}`).join(', ')}
              {impact.historicReferences.length > 3 ? ', and more' : ''}. Deactivate it instead.
            </p>
          )}
          {impact && impact.blockers.length > 0 && <p><ShieldAlert size={13} /> {impact.blockers.join(' ')}</p>}
        </div>
        <div className="uaa-do">
          {confirming === 'delete' ? (
            <>
              <span className="uaa-ask">Erase {user.username} for good?</span>
              <button type="button" className="danger" disabled={busy !== ''}
                onClick={() => run('del', () => api(`/users/${user.id}?mode=delete`, { method: 'DELETE' }), 'Account erased.')}>Yes, erase</button>
              <button type="button" className="secondary" onClick={() => setConfirming(null)}>Cancel</button>
            </>
          ) : (
            <button type="button" className="danger" disabled={!impact?.canDelete || busy !== ''}
              onClick={() => setConfirming('delete')}>Erase permanently</button>
          )}
        </div>
      </div>
    </div>
  );
}
