import { FormEvent, useEffect, useState } from 'react';
import { ArrowRight, Building2, IdCard, Lock, User } from 'lucide-react';
import { api } from '../../../src/services/api';
import { useAuth } from '../../../src/hooks/useAuth';
import { WaveBackground, MedicalLabBackgroundMarks } from '../../../src/components/ui';
import { ThemeToggle } from '../../../src/components/ui/ThemeToggle';
import { Notice } from '../../../src/components/ui/Feedback';
import { AuthBrand, Field, PasswordField } from './authBits';

type ModeOption = { key: 'lan' | 'direct'; label: string; blurb: string };

/**
 * First run.
 *
 * Two questions, asked once: who administers this installation, and where the
 * software is standing. The second is asked here rather than left to a setting
 * somebody finds later, because it decides what every configuration screen
 * after it should be offering — and a site that was never asked will be
 * configured as whichever one the default happened to be.
 *
 * The name of the receiving system is asked for the same reason a form asks
 * for a name rather than saying "the system": every refusal, every delivery
 * and every report in this product then says LHIMS, or whatever this facility
 * actually runs, instead of a placeholder nobody recognises.
 */
export default function SetupPage() {
  const { login } = useAuth();
  const [modes, setModes] = useState<ModeOption[]>([]);
  const [mode, setMode] = useState<'lan' | 'direct'>('lan');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api<{ modes: ModeOption[] }>('/translis/setup/status')
      .then(answer => setModes(answer.modes ?? []))
      .catch(() => setModes([]));
  }, []);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const username = String(fd.get('username'));
    const password = String(fd.get('password'));
    setBusy(true); setError('');
    try {
      await api('/translis/setup/initialize', {
        method: 'POST',
        body: JSON.stringify({
          username, password,
          fullName: String(fd.get('fullName')),
          lisName: String(fd.get('lisName')),
          mode,
        }),
      });
      await login(username, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Setup failed.');
    } finally { setBusy(false); }
  }

  return (
    <div className="auth">
      <div className="bg-deco"><WaveBackground variant="hero" /><MedicalLabBackgroundMarks waveform /></div>
      <ThemeToggle className="icon-btn auth-theme" />
      <form className="card form" onSubmit={submit}>
        <AuthBrand tagline="by Nickland" />
        <div className="auth-head"><h2>Set up this installation</h2></div>

        <Field icon={<IdCard size={16} />} label="Administrator’s name" name="fullName" required autoFocus
          placeholder="Full name" autoComplete="name" />
        <Field icon={<User size={16} />} label="Username" name="username" required
          autoComplete="username" placeholder="Choose a username" />
        <PasswordField icon={<Lock size={16} />} label="Password" name="password" required minLength={8}
          autoComplete="new-password" placeholder="At least 8 characters" />
        <Field icon={<Building2 size={16} />} label="Receiving system" name="lisName" required
          placeholder="LHIMS, SECHLIMS, or whatever this facility runs" />

        <div className="auth-field">
          <span>How this computer receives results</span>
          <div className="ap-choices" style={{ marginTop: 6 }}>
            {modes.map(option => (
              <button key={option.key} type="button"
                className={`ap-choice${mode === option.key ? ' is-on' : ''}`}
                onClick={() => setMode(option.key)}>{option.label}</button>
            ))}
          </div>
          <p className="hint" style={{ marginTop: 6 }}>
            {modes.find(m => m.key === mode)?.blurb}
          </p>
          <p className="hint">It can be changed later under Settings.</p>
        </div>

        {error && <Notice kind="error">{error}</Notice>}
        <button className="auth-submit" disabled={busy}>
          {busy ? <><span className="spinner sm" /> Setting up…</> : <>Create administrator <ArrowRight size={16} /></>}
        </button>
        <div className="auth-foot"><span className="dot" /> Analyser middleware · Offline</div>
      </form>
    </div>
  );
}
