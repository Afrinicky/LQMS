import { useEffect, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from '../../src/hooks/useAuth';
import { PermissionProvider, usePermissions } from '../../src/hooks/usePermissions';
import { ThemeProvider } from '../../src/hooks/useTheme';
import { api } from '../../src/services/api';
import { InstallationProvider } from './useInstallation';
import Shell from './Shell';
import SetupPage from './pages/Setup';
import LoginPage from './pages/Login';
import Workspace from './pages/Workspace';
import AnalyserSync from './pages/AnalyserSync';
import SettingsPage from './pages/Settings';

/**
 * TransLis, start to finish.
 *
 * Three states and nothing in between: an installation nobody has set up yet,
 * one nobody is signed in to, and one in use. SECHLIMS has a startup machine
 * that validates an environment, a host binding and a module registry; this
 * has a single question — has an administrator been created — because that is
 * the only thing that can be missing.
 */

type Status = { setupComplete: boolean; product: string };

function Startup() {
  const [status, setStatus] = useState<Status | null>(null);
  const [unreachable, setUnreachable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const ask = async () => {
      try {
        const answer = await api<Status>('/translis/setup/status');
        if (!cancelled) { setStatus(answer); setUnreachable(false); }
      } catch {
        if (!cancelled) setUnreachable(true);
      }
    };
    void ask();
    // The window can open before the embedded host has finished binding, which
    // looks exactly like a broken installation if it is only asked once.
    const timer = setInterval(() => { if (!status) void ask(); }, 2000);
    return () => { cancelled = true; clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!status) {
    return (
      <div className="module-page">
        <div className="card">
          <h3>TransLis</h3>
          <p className="muted">
            {unreachable ? 'Waiting for the TransLis host to answer…' : 'Starting…'}
          </p>
        </div>
      </div>
    );
  }

  if (!status.setupComplete) {
    return (
      <Routes>
        <Route path="/setup" element={<SetupPage />} />
        <Route path="*" element={<Navigate to="/setup" replace />} />
      </Routes>
    );
  }

  return <Signed />;
}

function Signed() {
  const { user, loading } = useAuth();
  if (loading) return <div className="module-page"><div className="card"><p className="muted">Signing in…</p></div></div>;
  if (!user) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }
  return (
    <PermissionProvider>
      <InstallationProvider>
        <InApp />
      </InstallationProvider>
    </PermissionProvider>
  );
}

/**
 * The routes an account can actually reach.
 *
 * Staff reach the workspace and nothing else. Rather than drawing the other
 * two and refusing them, they are absent — the same rule SECHLIMS applies, for
 * the same reason: nobody should browse a menu of work they cannot do.
 */
function InApp() {
  const { can, loading } = usePermissions();
  if (loading) return <div className="module-page"><div className="card"><p className="muted">Checking your access…</p></div></div>;
  const configures = can('settings', 'edit');

  return (
    <Shell configures={configures}>
      <Routes>
        <Route path="/transmission" element={<Workspace />} />
        {configures && <Route path="/analyser-sync" element={<AnalyserSync />} />}
        {configures && <Route path="/settings" element={<SettingsPage />} />}
        <Route path="*" element={<Navigate to="/transmission" replace />} />
      </Routes>
    </Shell>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <Startup />
      </AuthProvider>
    </ThemeProvider>
  );
}
