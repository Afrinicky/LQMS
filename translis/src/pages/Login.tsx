import { FormEvent, useState } from 'react';
import { ArrowRight, Lock, User } from 'lucide-react';
import { useAuth } from '../../../src/hooks/useAuth';
import { WaveBackground, MedicalLabBackgroundMarks } from '../../../src/components/ui';
import { ThemeToggle } from '../../../src/components/ui/ThemeToggle';
import { Notice } from '../../../src/components/ui/Feedback';
import { AuthBrand, Field, PasswordField } from './authBits';

/**
 * Signing in.
 *
 * No password reset link, unlike SECHLIMS. There is no personnel office behind
 * this product and no second administrator to appeal to at three in the
 * morning — a forgotten password is reset by the site's administrator from
 * Settings, and offering a self-service route that nothing answers would be
 * worse than not offering one.
 */
export default function LoginPage() {
  const { login } = useAuth();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setBusy(true); setError('');
    try {
      await login(String(fd.get('username')), String(fd.get('password')));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed.');
    } finally { setBusy(false); }
  }

  return (
    <div className="auth">
      <div className="bg-deco"><WaveBackground variant="hero" /><MedicalLabBackgroundMarks waveform /></div>
      <ThemeToggle className="icon-btn auth-theme" />
      <form className="card form" onSubmit={submit}>
        <AuthBrand tagline="by Nickland" />
        <div className="auth-head"><h2>Sign in</h2></div>
        <Field icon={<User size={16} />} label="Username" name="username" required autoFocus
          autoComplete="username" placeholder="Enter your username" />
        <PasswordField icon={<Lock size={16} />} label="Password" name="password" required
          autoComplete="current-password" placeholder="Enter your password" />
        {error && <Notice kind="error">{error}</Notice>}
        <button className="auth-submit" disabled={busy}>
          {busy ? <><span className="spinner sm" /> Signing in…</> : <>Sign in <ArrowRight size={16} /></>}
        </button>
        <div className="auth-foot"><span className="dot" /> Analyser middleware · Offline</div>
      </form>
    </div>
  );
}
