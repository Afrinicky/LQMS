import { FormEvent, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { FlaskConical } from 'lucide-react';
import { api } from '../services/api';
import { useAuth } from '../hooks/useAuth';
import { WaveBackground, MedicalLabBackgroundMarks } from '../components/ui';

function AuthBrand({ tagline }: { tagline: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
      <span className="brand-mark"><FlaskConical size={20} /></span>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <strong style={{ fontSize: 18, letterSpacing: '0.02em' }}>SECH_LIMS</strong>
        <span className="muted" style={{ fontSize: 12 }}>{tagline}</span>
      </div>
    </div>
  );
}

export function LoginPage() {
  const { login, user } = useAuth();
  const [error, setError] = useState('');
  const nav = useNavigate();
  if (user) return <Navigate to="/home" />;
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    try { await login(String(fd.get('username')), String(fd.get('password'))); nav('/home'); }
    catch (err) { setError(err instanceof Error ? err.message : 'Login failed'); }
  }
  return (
    <div className="auth">
      <div className="bg-deco"><WaveBackground variant="hero" /><MedicalLabBackgroundMarks /></div>
      <form className="card form" onSubmit={submit}>
        <AuthBrand tagline="by Nickland" />
        <h2 style={{ margin: '4px 0 0' }}>Welcome back</h2>
        <p className="muted" style={{ margin: 0 }}>Sign in to your laboratory quality management workspace.</p>
        <label>Username<input name="username" required autoFocus /></label>
        <label>Password<input name="password" type="password" required /></label>
        {error && <div className="error">{error}</div>}
        <button>Sign in</button>
      </form>
    </div>
  );
}

export function SetupPage() {
  const [error, setError] = useState('');
  const nav = useNavigate();
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    try {
      await api('/setup/initialize', { method: 'POST', body: JSON.stringify({
        facilityName: fd.get('facilityName'), shortName: fd.get('shortName'),
        fullName: fd.get('fullName'), username: fd.get('username'), password: fd.get('password'),
      }) });
      nav('/login');
    } catch (err) { setError(err instanceof Error ? err.message : 'Setup failed'); }
  }
  return (
    <div className="auth">
      <div className="bg-deco"><WaveBackground variant="hero" /><MedicalLabBackgroundMarks /></div>
      <form className="card form" onSubmit={submit}>
        <AuthBrand tagline="First-time setup" />
        <h2 style={{ margin: '4px 0 0' }}>Create your workspace</h2>
        <p className="muted" style={{ margin: 0 }}>Set up the host database, laboratory profile, default roles, positions, modules, and the first administrator.</p>
        <label>Facility name<input name="facilityName" defaultValue="St. Elizabeth Catholic Hospital Laboratory" required /></label>
        <label>Short name<input name="shortName" defaultValue="SECH Laboratory" /></label>
        <label>Administrator full name<input name="fullName" required /></label>
        <label>Admin username<input name="username" required /></label>
        <label>Admin password<input name="password" type="password" minLength={8} required /></label>
        {error && <div className="error">{error}</div>}
        <button>Initialize workspace</button>
      </form>
    </div>
  );
}
