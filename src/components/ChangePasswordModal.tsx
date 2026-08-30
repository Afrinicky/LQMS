import { useState } from 'react';
import { KeyRound, X } from 'lucide-react';
import { api, errorText } from '../services/api';
import TextField from './ui/TextField';

/**
 * Self-service password change for the desktop app. Any signed-in user confirms
 * their current password and sets a new one via /auth/change-password — the same
 * endpoint the mobile companion uses. This is how staff take over the temporary
 * password an administrator issued them.
 */
export function ChangePasswordModal({ onClose, required = false, onChanged }: { onClose: () => void; required?: boolean; onChanged?: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!current) return setError('Enter your current password.');
    if (next.length < 8) return setError('New password must be at least 8 characters.');
    if (next !== confirm) return setError('The new passwords do not match.');
    if (next === current) return setError('Choose a password different from your current one.');
    setBusy(true);
    try {
      await api('/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword: current, newPassword: next }) });
      setDone(true);
      onChanged?.();
    } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  }

  const type = show ? 'text' : 'password';
  return (
    <div className="pw-overlay" onClick={required ? undefined : onClose}>
      <div className="pw-modal" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Change password">
        <div className="pw-head">
          <h3><KeyRound size={18} /> {required ? 'Choose a new password' : 'Change password'}</h3>
          {!required && <button className="drawer-close" type="button" aria-label="Close" onClick={onClose}><X size={18} /></button>}
        </div>
        {required && !done && (
          <p className="pw-required">
            An administrator has asked you to set a new password before you carry on.
          </p>
        )}
        {done ? (
          <div className="pw-body">
            <p className="pw-ok">Your password has been changed. Use it next time you sign in.</p>
            <div className="form-actions"><button type="button" onClick={onClose}>Done</button></div>
          </div>
        ) : (
          <form className="pw-body" onSubmit={submit}>
            <label className="pw-label">Current password</label>
            <TextField type={type} value={current} onValue={setCurrent} autoComplete="current-password" autoFocus />
            <label className="pw-label">New password</label>
            <TextField type={type} value={next} onValue={setNext} autoComplete="new-password" />
            <label className="pw-label">Confirm new password</label>
            <TextField type={type} value={confirm} onValue={setConfirm} autoComplete="new-password" />
            <label className="pw-show"><input type="checkbox" checked={show} onChange={e => setShow(e.target.checked)} /> Show passwords</label>
            {error && <p className="pw-error">{error}</p>}
            <div className="form-actions">
              {!required && <button type="button" className="secondary" onClick={onClose}>Cancel</button>}
              <button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Update password'}</button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
