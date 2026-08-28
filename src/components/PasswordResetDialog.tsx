import { FormEvent, useEffect, useRef, useState } from 'react';
import { KeyRound, ShieldQuestion, Clock, CheckCircle2, XCircle, Lock, ArrowRight, X } from 'lucide-react';
import { api } from '../services/api';
import TextField from './ui/TextField';
import { Notice } from './ui/Feedback';

/**
 * Forgotten password, from the sign-in screen.
 *
 * There is no email on a LAN Host, so recovery goes through a person: the
 * request goes to whoever administers accounts, they confirm who is asking —
 * the point of the flow — and approve. This dialog walks that wait without
 * making it feel like an error state: ask, wait, set.
 *
 * The browser holds a claim token and polls with it. Nothing about whether the
 * username exists is ever revealed: an unknown account waits exactly as a real
 * one does, and simply lapses.
 */
type Phase = 'ask' | 'waiting' | 'approved' | 'denied' | 'expired' | 'done';

const STORAGE_KEY = 'sech_lims_reset_claim';

export default function PasswordResetDialog({ onClose, initialUsername = '' }: { onClose: () => void; initialUsername?: string }) {
  const [phase, setPhase] = useState<Phase>('ask');
  const [username, setUsername] = useState(initialUsername);
  const [reason, setReason] = useState('');
  const [claim, setClaim] = useState<string | null>(null);
  const [resetToken, setResetToken] = useState<string | null>(null);
  const [fullName, setFullName] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [waited, setWaited] = useState(0);
  const timer = useRef<number | null>(null);

  // A request survives a page refresh — people close the tab while they walk
  // over to the office, and losing the claim would mean asking twice.
  useEffect(() => {
    const saved = sessionStorage.getItem(STORAGE_KEY);
    if (saved) { setClaim(saved); setPhase('waiting'); }
  }, []);

  useEffect(() => {
    if (phase !== 'waiting' || !claim) return;
    let live = true;
    const poll = async () => {
      try {
        const r = await api<{ status: string; resetToken?: string; fullName?: string; note?: string }>(
          `/auth/password-reset/status?claim=${encodeURIComponent(claim)}`);
        if (!live) return;
        if (r.status === 'approved' && r.resetToken) {
          setResetToken(r.resetToken); setFullName(r.fullName ?? null); setPhase('approved');
          sessionStorage.removeItem(STORAGE_KEY);
        } else if (r.status === 'denied') {
          setNote(r.note ?? null); setPhase('denied'); sessionStorage.removeItem(STORAGE_KEY);
        } else if (r.status === 'expired' || r.status === 'unknown' || r.status === 'cancelled') {
          setPhase('expired'); sessionStorage.removeItem(STORAGE_KEY);
        }
      } catch { /* the host may be briefly unreachable; keep waiting */ }
    };
    void poll();
    timer.current = window.setInterval(() => { setWaited(w => w + 1); void poll(); }, 4000);
    return () => { live = false; if (timer.current) window.clearInterval(timer.current); };
  }, [phase, claim]);

  async function request(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const r = await api<{ claimToken: string }>('/auth/password-reset/request', {
        method: 'POST', body: JSON.stringify({ username: username.trim(), reason: reason.trim() || undefined }),
      });
      sessionStorage.setItem(STORAGE_KEY, r.claimToken);
      setClaim(r.claimToken); setWaited(0); setPhase('waiting');
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not send the request.'); }
    finally { setBusy(false); }
  }

  async function complete(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const pw = String(fd.get('newPassword') ?? '');
    if (pw !== String(fd.get('confirm') ?? '')) { setError('The two passwords do not match.'); return; }
    setBusy(true); setError('');
    try {
      await api('/auth/password-reset/complete', { method: 'POST', body: JSON.stringify({ resetToken, newPassword: pw }) });
      setPhase('done');
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not set the new password.'); }
    finally { setBusy(false); }
  }

  function cancel() {
    sessionStorage.removeItem(STORAGE_KEY);
    onClose();
  }

  return (
    <div className="pwr-backdrop" role="dialog" aria-modal="true" aria-label="Reset your password">
      <div className="pwr card">
        <button type="button" className="pwr-close" onClick={cancel} aria-label="Close"><X size={16} /></button>

        {phase === 'ask' && (
          <form onSubmit={request}>
            <span className="pwr-ico"><KeyRound size={22} /></span>
            <h3>Forgotten your password?</h3>
            <p>An administrator will confirm it is you and approve the reset. Stay on this screen — it opens by itself once they do.</p>
            <label className="auth-field">
              <span>Your username</span>
              <span className="auth-input">
                <span className="ai-ico"><ShieldQuestion size={16} /></span>
                <TextField value={username} onValue={nextValue => setUsername(nextValue)} required autoFocus placeholder="The username you sign in with" />
              </span>
            </label>
            <label className="auth-field">
              <span>Anything the administrator should know <em>(optional)</em></span>
              <span className="auth-input">
                <TextField value={reason} onValue={nextValue => setReason(nextValue)} placeholder="e.g. I am at the Haematology bench" />
              </span>
            </label>
            {error && <Notice kind="error">{error}</Notice>}
            <button className="auth-submit" disabled={busy || !username.trim()}>
              {busy ? <><span className="spinner sm" /> Sending…</> : <>Ask for a reset <ArrowRight size={16} /></>}
            </button>
          </form>
        )}

        {phase === 'waiting' && (
          <div className="pwr-wait">
            <span className="pwr-pulse"><Clock size={22} /></span>
            <h3>Waiting for approval</h3>
            <p>
              An administrator has been notified. They will confirm who you are before approving —
              if they are nearby, it is worth going to see them.
            </p>
            <div className="pwr-dots"><i /><i /><i /></div>
            <p className="pwr-meta">
              Checking every few seconds{waited > 15 ? ' · still waiting, this stays open as long as you need' : ''}
            </p>
            <button type="button" className="secondary" onClick={cancel}>Cancel this request</button>
          </div>
        )}

        {phase === 'approved' && (
          <form onSubmit={complete}>
            <span className="pwr-ico ok"><CheckCircle2 size={22} /></span>
            <h3>Approved{fullName ? `, ${fullName.split(/\s+/)[0]}` : ''}</h3>
            <p>Choose a new password. You will be signed out everywhere else.</p>
            <label className="auth-field">
              <span>New password</span>
              <span className="auth-input">
                <span className="ai-ico"><Lock size={16} /></span>
                <input name="newPassword" type="password" required minLength={8} autoFocus autoComplete="new-password" placeholder="At least 8 characters" />
              </span>
            </label>
            <label className="auth-field">
              <span>Confirm new password</span>
              <span className="auth-input">
                <span className="ai-ico"><Lock size={16} /></span>
                <input name="confirm" type="password" required minLength={8} autoComplete="new-password" placeholder="Type it again" />
              </span>
            </label>
            {error && <Notice kind="error">{error}</Notice>}
            <button className="auth-submit" disabled={busy}>
              {busy ? <><span className="spinner sm" /> Saving…</> : <>Set new password <ArrowRight size={16} /></>}
            </button>
          </form>
        )}

        {phase === 'denied' && (
          <div className="pwr-wait">
            <span className="pwr-ico bad"><XCircle size={22} /></span>
            <h3>Not approved</h3>
            <p>{note || 'The administrator did not approve this reset. Speak to them if you think that is a mistake.'}</p>
            <button type="button" onClick={() => { setPhase('ask'); setError(''); }}>Ask again</button>
          </div>
        )}

        {phase === 'expired' && (
          <div className="pwr-wait">
            <span className="pwr-ico bad"><Clock size={22} /></span>
            <h3>The request lapsed</h3>
            <p>Nobody got to it in time, so it has been closed. You can ask again.</p>
            <button type="button" onClick={() => { setPhase('ask'); setError(''); }}>Ask again</button>
          </div>
        )}

        {phase === 'done' && (
          <div className="pwr-wait">
            <span className="pwr-ico ok"><CheckCircle2 size={22} /></span>
            <h3>Password changed</h3>
            <p>Sign in with your new password.</p>
            <button type="button" onClick={cancel}>Back to sign in</button>
          </div>
        )}
      </div>
    </div>
  );
}
