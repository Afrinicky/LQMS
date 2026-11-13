import { useState } from 'react';
import { Eye, EyeOff, Waypoints } from 'lucide-react';

/**
 * The sign-in furniture, as SECHLIMS draws it.
 *
 * The same three pieces and the same class names, so the two products present
 * one house style rather than two that nearly match. The only difference is
 * the name on the badge.
 */
export function AuthBrand({ tagline }: { tagline: string }) {
  return (
    <div className="auth-brand">
      <span className="brand-mark"><Waypoints size={22} /></span>
      <div className="ab">
        <strong>TransLis</strong>
        <span>{tagline}</span>
      </div>
    </div>
  );
}

export function Field({ icon, label, ...props }: {
  icon: React.ReactNode; label: string
} & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="auth-field">
      <span>{label}</span>
      <span className="auth-input">
        <span className="ai-ico">{icon}</span>
        <input {...props} />
      </span>
    </label>
  );
}

/**
 * A password box you can look at — the same reasoning as SECHLIMS's: typing a
 * password blind on a laboratory keyboard is where sign-in goes wrong, and it
 * reveals rather than stores.
 */
export function PasswordField({ icon, label, ...props }: {
  icon: React.ReactNode; label: string
} & React.InputHTMLAttributes<HTMLInputElement>) {
  const [shown, setShown] = useState(false);
  return (
    <label className="auth-field">
      <span>{label}</span>
      <span className="auth-input">
        <span className="ai-ico">{icon}</span>
        <input {...props} type={shown ? 'text' : 'password'} />
        <button type="button" className="ai-reveal" onClick={() => setShown(v => !v)} tabIndex={-1}
          aria-pressed={shown} aria-label={shown ? 'Hide the password' : 'Show the password'}
          title={shown ? 'Hide the password' : 'Show the password'}>
          {shown ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      </span>
    </label>
  );
}
