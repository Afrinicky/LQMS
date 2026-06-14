import { FormEvent, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { FlaskConical, User, Lock, Building2, IdCard, ArrowRight } from 'lucide-react';
import { api } from '../services/api';
import { useAuth } from '../hooks/useAuth';
import { WaveBackground, MedicalLabBackgroundMarks } from '../components/ui';

function AuthBrand({ tagline }: { tagline: string }) {
  return (
    <div className="auth-brand">
      <span className="brand-mark"><FlaskConical size={22} /></span>
      <div className="ab">
        <strong>SECH_LIMS</strong>
        <span>{tagline}</span>
      </div>
    </div>
  );
}

function Field({ icon, label, ...props }: { icon: React.ReactNode; label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
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

export function LoginPage() {
  const { login, user } = useAuth();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();
  if (user) return <Navigate to="/home" />;

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setBusy(true);
    setError('');
    try {
      await login(String(fd.get('username')), String(fd.get('password')));
      nav('/home');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <div className="bg-deco"><WaveBackground variant="hero" /><MedicalLabBackgroundMarks waveform /></div>
      <form className="card form" onSubmit={submit}>
        <AuthBrand tagline="by Nickland" />
        <div className="auth-head">
          <h2>Welcome back</h2>
          <p>Sign in to your laboratory quality management workspace.</p>
        </div>
        <Field icon={<User size={16} />} label="Username" name="username" required autoFocus autoComplete="username" placeholder="Enter your username" />
        <Field icon={<Lock size={16} />} label="Password" name="password" type="password" required autoComplete="current-password" placeholder="Enter your password" />
        {error && <div className="error">{error}</div>}
        <button className="auth-submit" disabled={busy}>
          {busy ? <><span className="spinner sm" /> Signing in…</> : <>Sign in <ArrowRight size={16} /></>}
        </button>
        <div className="auth-foot"><span className="dot" /> Local workspace · Offline-ready</div>
      </form>
    </div>
  );
}

export function SetupPage() {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setBusy(true);
    setError('');
    try {
      await api('/setup/initialize', { method: 'POST', body: JSON.stringify({
        facilityName: fd.get('facilityName'), shortName: fd.get('shortName'),
        fullName: fd.get('fullName'), username: fd.get('username'), password: fd.get('password'),
      }) });
      nav('/login');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Setup failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <div className="bg-deco"><WaveBackground variant="hero" /><MedicalLabBackgroundMarks /></div>
      <form className="card form" onSubmit={submit}>
        <AuthBrand tagline="First-time setup" />
        <div className="auth-head">
          <h2>Create your workspace</h2>
          <p>Set up the host database, laboratory profile, default roles, positions, modules, and the first administrator.</p>
        </div>
        <Field icon={<Building2 size={16} />} label="Facility name" name="facilityName" defaultValue="St. Elizabeth Catholic Hospital Laboratory" required />
        <Field icon={<Building2 size={16} />} label="Short name" name="shortName" defaultValue="SECH Laboratory" />
        <Field icon={<IdCard size={16} />} label="Administrator full name" name="fullName" required />
        <Field icon={<User size={16} />} label="Admin username" name="username" required autoComplete="username" />
        <Field icon={<Lock size={16} />} label="Admin password" name="password" type="password" minLength={8} required autoComplete="new-password" />
        {error && <div className="error">{error}</div>}
        <button className="auth-submit" disabled={busy}>
          {busy ? <><span className="spinner sm" /> Initializing…</> : <>Initialize workspace <ArrowRight size={16} /></>}
        </button>
        <div className="auth-foot"><span className="dot" /> Local workspace · Offline-ready</div>
      </form>
    </div>
  );
}
