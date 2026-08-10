import { useEffect, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PenLine, X } from 'lucide-react';

/**
 * "Confirm it is you" — the password prompt that stands in front of every
 * electronic signature.
 *
 * A signature is only worth something if the person whose name is on it was at
 * the keyboard when it was given. Holding a signed-in session is not evidence
 * of that: benches are shared, and a screen left open at the start of a shift
 * is open for the rest of it. So the Host asks for the password again at the
 * moment of signing, and refuses the signature without it (21 CFR 11.200(a)(1),
 * EU GMP Annex 11 §14, validation finding VF-04).
 *
 * Promise-based on purpose: the three places that sign — approving a request,
 * submitting a form that requires a signature, signing a declaration — each
 * already had their own submit flow, and none of them should have to grow a
 * modal to gain this.
 *
 *   const password = await requestSigningPassword('Approve leave request');
 *   if (!password) return;            // the person changed their mind
 */
function SigningPasswordDialog({ what, meaning, onResolve }: {
  what: string;
  meaning?: string;
  onResolve: (password: string | null) => void;
}) {
  const [password, setPassword] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onResolve(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onResolve]);

  return (
    <div className="pw-overlay" onClick={() => onResolve(null)}>
      <form
        className="pw-modal"
        onClick={e => e.stopPropagation()}
        onSubmit={e => { e.preventDefault(); if (password) onResolve(password); }}
        role="dialog"
        aria-modal="true"
        aria-label="Confirm your password to sign"
      >
        <div className="pw-head">
          <h3><PenLine size={18} /> Sign as yourself</h3>
          <button className="drawer-close" type="button" aria-label="Cancel" onClick={() => onResolve(null)}><X size={18} /></button>
        </div>
        <div className="pw-body">
          <p style={{ margin: '0 0 4px', fontWeight: 600 }}>{what}</p>
          {meaning && <p className="muted" style={{ margin: '0 0 12px', fontSize: 13 }}>{meaning}</p>}
          <p className="muted" style={{ margin: '0 0 12px', fontSize: 13 }}>
            Enter your password to confirm this signature is yours. It is recorded against your name,
            the time, and the record you are signing.
          </p>
          <label className="field">
            <span>Your password</span>
            <input
              ref={inputRef}
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={e => setPassword(e.target.value)}
            />
          </label>
          <div className="form-actions" style={{ marginTop: 14 }}>
            <button type="button" className="secondary" onClick={() => onResolve(null)}>Cancel</button>
            <button type="submit" disabled={!password}>Sign</button>
          </div>
        </div>
      </form>
    </div>
  );
}

let host: HTMLDivElement | null = null;
let root: Root | null = null;

/**
 * Ask for the signer's password. Resolves with the password, or with null when
 * the person cancels — in which case nothing should be signed and nothing
 * should be saved.
 */
export function requestSigningPassword(what: string, meaning?: string): Promise<string | null> {
  return new Promise(resolve => {
    if (!host) {
      host = document.createElement('div');
      document.body.appendChild(host);
      root = createRoot(host);
    }
    const finish = (password: string | null) => {
      root?.render(null);
      resolve(password);
    };
    root?.render(<SigningPasswordDialog what={what} meaning={meaning} onResolve={finish} />);
  });
}
