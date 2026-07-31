import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import AppLayout from './layouts/AppLayout';
import SettingsLayout from './layouts/SettingsLayout';
import { AuthProvider, useAuth } from './hooks/useAuth';
import { ModuleProvider } from './hooks/useModules';
import { API_BASE, getSetupStatus } from './services/api';
import { LoginPage, SetupPage } from './pages/AuthPages';
import { Dashboard, Home, ModulePage } from './pages/CorePages';
import { ActionTracker, DocumentImport, EvidenceUpload, MyLaboratory, PeopleAccess, SectionConfig, SystemSettings, RosterSettings } from './pages/SettingsPages';
import { NcCapaPage, ComplaintsPage, RisksPage, QmsActionTracker } from './pages/QMSPages';
import { MODULES } from '../shared/constants/modules';
import { FlaskConical, TriangleAlert } from 'lucide-react';
import { WaveBackground } from './components/ui';
import './styles/app.css';

const DocumentControlPage = lazy(() => import('./pages/DocumentControlPage').then(m => ({ default: m.DocumentControlPage })));
const DennisPage = lazy(() => import('./pages/DennisPage').then(m => ({ default: m.DennisPage })));
const PersonnelManagementPage = lazy(() => import('./pages/PersonnelManagementPage').then(m => ({ default: m.PersonnelManagementPage })));
const AssessmentsPage = lazy(() => import('./pages/Phase8Pages').then(m => ({ default: m.AssessmentsPage })));
const MeetingsPage = lazy(() => import('./pages/Phase8Pages').then(m => ({ default: m.MeetingsPage })));
const ManagementReviewPage = lazy(() => import('./pages/Phase8Pages').then(m => ({ default: m.ManagementReviewPage })));
const QualityIndicatorsPage = lazy(() => import('./pages/Phase8Pages').then(m => ({ default: m.QualityIndicatorsPage })));
const ContinualImprovementPage = lazy(() => import('./pages/Phase8Pages').then(m => ({ default: m.ContinualImprovementPage })));
const CustomerFocusPage = lazy(() => import('./pages/CustomerFocusPage').then(m => ({ default: m.CustomerFocusPage })));
const OrganisationPage = lazy(() => import('./pages/OrganisationPage').then(m => ({ default: m.OrganisationPage })));
const POCTPage = lazy(() => import('./pages/POCTPage').then(m => ({ default: m.POCTPage })));
const NotificationsPage = lazy(() => import('./pages/NotificationsPage').then(m => ({ default: m.NotificationsPage })));
const RecordsReportsPage = lazy(() => import('./pages/RecordsReportsPage').then(m => ({ default: m.RecordsReportsPage })));
const ProcessManagementPage = lazy(() => import('./pages/ProcessManagementPage').then(m => ({ default: m.ProcessManagementPage })));
const InformationManagementPage = lazy(() => import('./pages/InformationManagementPage').then(m => ({ default: m.InformationManagementPage })));
const EquipmentPage = lazy(() => import('./pages/Phase3Pages').then(m => ({ default: m.EquipmentPage })));
const InventoryPage = lazy(() => import('./pages/Phase3Pages').then(m => ({ default: m.InventoryPage })));
const MonitoringPage = lazy(() => import('./pages/Phase3Pages').then(m => ({ default: m.MonitoringPage })));
const SafetyPage = lazy(() => import('./pages/Phase3Pages').then(m => ({ default: m.SafetyPage })));
const IqcPage = lazy(() => import('./pages/Phase4Pages').then(m => ({ default: m.IqcPage })));
const EqaPage = lazy(() => import('./pages/Phase4Pages').then(m => ({ default: m.EqaPage })));
const VerificationValidationPage = lazy(() => import('./pages/Phase4Pages').then(m => ({ default: m.VerificationValidationPage })));
const MeasurementUncertaintyPage = lazy(() => import('./pages/Phase4Pages').then(m => ({ default: m.MeasurementUncertaintyPage })));
const BloodBankHandoverPage = lazy(() => import('./pages/BloodBankHandoverPage').then(m => ({ default: m.BloodBankHandoverPage })));
const MonthlyReportsPage = lazy(() => import('./pages/MonthlyReportsPage').then(m => ({ default: m.MonthlyReportsPage })));

const ModuleFallback = () => <div className="card">Loading module…</div>;

// Startup is a one-shot sequence that validates the environment (local API
// reachable, first-time setup complete). Once it reaches `ready`, auth gating is
// driven LIVE from the AuthProvider's `user`/`loading` instead of being frozen
// in a stale snapshot. The old machine latched on `loginRequired`/`authenticated`
// and never re-evaluated after sign-in, which produced an infinite
// /login <-> /home redirect loop (Chromium "throttling navigation" → blank screen).
type StartupState = 'booting' | 'checkingApi' | 'apiUnavailable' | 'checkingSetup' | 'setupRequired' | 'ready' | 'startupError';

function StartupShell({ variant = 'loading', heading, message, detail, children }: { variant?: 'loading' | 'error'; heading: string; message: string; detail?: string; children?: React.ReactNode }) {
  return <div className="boot">
    <div className="bg-deco"><WaveBackground variant="hero" /></div>
    <div className="boot-inner">
      <div className="boot-brand">
        <span className="brand-mark"><FlaskConical size={26} /></span>
        <div className="bt"><strong>SECH_LIMS</strong><span>by Nickland</span></div>
      </div>
      {variant === 'error'
        ? <div className="boot-error-ico"><TriangleAlert size={26} /></div>
        : <div className="spinner" />}
      <div className="boot-status">
        <h2>{heading}</h2>
        <p>{message}</p>
      </div>
      {detail && <div className="boot-detail">{detail}</div>}
      {children && <div className="boot-actions">{children}</div>}
    </div>
  </div>;
}

function Gate({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  const [state, setState] = useState<StartupState>('booting');
  const [errorDetail, setErrorDetail] = useState<string>('');
  const [setupComplete, setSetupComplete] = useState<boolean | null>(null);
  const [attempt, setAttempt] = useState(0);

  const retry = useCallback(() => setAttempt(a => a + 1), []);

  // Phase 1: ping the local API health endpoint with a 10 s timeout.
  useEffect(() => {
    let cancelled = false;
    setState('checkingApi');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    fetch(`${API_BASE}/health`, { signal: ctrl.signal })
      .then(r => r.json())
      .then(() => { if (!cancelled) { console.log('[renderer] startup state -> checkingSetup'); setState('checkingSetup'); } })
      .catch(err => { if (!cancelled) { console.error('[renderer] API health failed', err); setErrorDetail(String(err)); setState('apiUnavailable'); } })
      .finally(() => clearTimeout(timer));
    return () => { cancelled = true; clearTimeout(timer); ctrl.abort(); };
  }, [attempt]);

  // Phase 2: ask the API whether first-time setup is complete. On success we move
  // to `ready`, after which auth gating is reactive (see below) — there is no
  // separate frozen "checkingAuth/loginRequired/authenticated" phase anymore.
  useEffect(() => {
    if (state !== 'checkingSetup') return;
    let cancelled = false;
    getSetupStatus()
      .then(s => { if (cancelled) return; console.log('[renderer] setup status', s); setSetupComplete(s.setupComplete); setState(s.setupComplete ? 'ready' : 'setupRequired'); })
      .catch(err => { if (cancelled) return; console.error('[renderer] setup status failed', err); setErrorDetail(String(err)); setState('startupError'); });
    return () => { cancelled = true; };
  }, [state]);

  // Render a visible screen for every state. Never return null.
  if (state === 'booting' || state === 'checkingApi') {
    return <StartupShell heading="Starting up" message="Checking local API…" detail={`API base URL: ${API_BASE}`} />;
  }

  if (state === 'apiUnavailable') {
    return <StartupShell
      variant="error"
      heading="Local service is not responding"
      message="The host service did not respond in time. You can retry the connection, or restart the application for a clean start."
      detail={`API base URL: ${API_BASE}\n${errorDetail}`}
    >
      <button onClick={retry}>Retry connection</button>
      {window.sechLims?.relaunch && <button className="secondary" onClick={() => window.sechLims?.relaunch?.()}>Restart application</button>}
    </StartupShell>;
  }

  if (state === 'checkingSetup') {
    return <StartupShell heading="Starting up" message="Checking setup status…" detail={`API base URL: ${API_BASE}`} />;
  }

  if (state === 'setupRequired') {
    if (location.pathname !== '/setup') return <Navigate to="/setup" replace />;
    return <>{children}</>;
  }

  // Setup is complete: gate purely on live auth state. This block re-renders
  // whenever `user`/`loading` change, so signing in (user becomes set) or out
  // (user becomes null) flips the gate without any stale-state redirect loop.
  if (state === 'ready') {
    // AuthProvider is still resolving the existing session (/auth/me).
    if (loading) return <StartupShell heading="Starting up" message="Checking session…" />;

    if (!user) {
      // Not signed in — only the login screen is reachable.
      if (location.pathname !== '/login') return <Navigate to="/login" replace />;
      return <>{children}</>;
    }

    // Signed in — keep the user out of the login/setup screens.
    if (location.pathname === '/login') return <Navigate to="/home" replace />;
    if (location.pathname === '/setup' && setupComplete) return <Navigate to="/home" replace />;
    return <>{children}</>;
  }

  // startupError
  return <StartupShell
    variant="error"
    heading="Startup error"
    message="Something went wrong while the application was starting up. Retry, or restart the application."
    detail={errorDetail || 'No further details available.'}
  >
    <button onClick={retry}>Retry</button>
    {window.sechLims?.relaunch && <button className="secondary" onClick={() => window.sechLims?.relaunch?.()}>Restart application</button>}
  </StartupShell>;
}

function AppRoutes() {
  const placeholders = MODULES.filter(m => m.placeholder);
  return <Routes>
    <Route path="/setup" element={<SetupPage/>}/>
    <Route path="/login" element={<LoginPage/>}/>
    <Route element={<ModuleProvider><AppLayout/></ModuleProvider>}>
      <Route index element={<Navigate to="/home"/>}/>
      <Route path="/home" element={<Home/>}/>
      <Route path="/dashboard" element={<Dashboard/>}/>
      <Route path="/documents" element={<Suspense fallback={<ModuleFallback/>}><DocumentControlPage/></Suspense>}/>
      <Route path="/dennis" element={<Suspense fallback={<ModuleFallback/>}><DennisPage/></Suspense>}/>
      <Route path="/organisation" element={<Suspense fallback={<ModuleFallback/>}><OrganisationPage/></Suspense>}/>
      <Route path="/personnel" element={<Suspense fallback={<ModuleFallback/>}><PersonnelManagementPage/></Suspense>}/>
      <Route path="/nc-capa" element={<NcCapaPage/>}/>
      <Route path="/complaints" element={<ComplaintsPage/>}/>
      <Route path="/risks" element={<RisksPage/>}/>
      <Route path="/actions" element={<QmsActionTracker/>}/>
      <Route path="/equipment" element={<Suspense fallback={<ModuleFallback/>}><EquipmentPage/></Suspense>}/>
      <Route path="/supplier-inventory" element={<Suspense fallback={<ModuleFallback/>}><InventoryPage/></Suspense>}/>
      <Route path="/monitoring" element={<Suspense fallback={<ModuleFallback/>}><MonitoringPage/></Suspense>}/>
      <Route path="/facilities-safety" element={<Suspense fallback={<ModuleFallback/>}><SafetyPage/></Suspense>}/>
      <Route path="/iqc" element={<Suspense fallback={<ModuleFallback/>}><IqcPage/></Suspense>}/>
      <Route path="/eqa" element={<Suspense fallback={<ModuleFallback/>}><EqaPage/></Suspense>}/>
      <Route path="/verification-validation" element={<Suspense fallback={<ModuleFallback/>}><VerificationValidationPage/></Suspense>}/>
      <Route path="/measurement-uncertainty" element={<Suspense fallback={<ModuleFallback/>}><MeasurementUncertaintyPage/></Suspense>}/>
      <Route path="/blood-bank-handover" element={<Suspense fallback={<ModuleFallback/>}><BloodBankHandoverPage/></Suspense>}/>
      <Route path="/monthly-reports" element={<Suspense fallback={<ModuleFallback/>}><MonthlyReportsPage/></Suspense>}/>
      <Route path="/assessments" element={<Suspense fallback={<ModuleFallback/>}><AssessmentsPage/></Suspense>}/>
      <Route path="/meetings" element={<Suspense fallback={<ModuleFallback/>}><MeetingsPage/></Suspense>}/>
      <Route path="/management-review" element={<Suspense fallback={<ModuleFallback/>}><ManagementReviewPage/></Suspense>}/>
      <Route path="/quality-indicators" element={<Suspense fallback={<ModuleFallback/>}><QualityIndicatorsPage/></Suspense>}/>
      <Route path="/continual-improvement" element={<Suspense fallback={<ModuleFallback/>}><ContinualImprovementPage/></Suspense>}/>
      <Route path="/customer-focus" element={<Suspense fallback={<ModuleFallback/>}><CustomerFocusPage/></Suspense>}/>
      <Route path="/poct" element={<Suspense fallback={<ModuleFallback/>}><POCTPage/></Suspense>}/>
      <Route path="/notifications" element={<Suspense fallback={<ModuleFallback/>}><NotificationsPage/></Suspense>}/>
      <Route path="/records-reports" element={<Suspense fallback={<ModuleFallback/>}><RecordsReportsPage/></Suspense>}/>
      <Route path="/process-management" element={<Suspense fallback={<ModuleFallback/>}><ProcessManagementPage/></Suspense>}/>
      <Route path="/information-management" element={<Suspense fallback={<ModuleFallback/>}><InformationManagementPage/></Suspense>}/>
      {placeholders.map(m => <Route key={m.key} path={m.path.slice(1)} element={<ModulePage moduleKey={m.key} title={m.label} placeholder/>}/>)}
      <Route path="/settings" element={<SettingsLayout/>}>
        <Route index element={<Navigate to="laboratory"/>}/>
        <Route path="laboratory" element={<MyLaboratory/>}/>
        <Route path="people" element={<PeopleAccess/>}/>
        <Route path="sections" element={<SectionConfig/>}/>
        <Route path="scheduling" element={<RosterSettings/>}/>
        <Route path="system" element={<SystemSettings/>}/>
        <Route path="document-import" element={<DocumentImport/>}/>
        <Route path="evidence" element={<EvidenceUpload/>}/>
        <Route path="actions" element={<ActionTracker/>}/>
        {/* legacy deep links → People & Access */}
        <Route path="register-staff" element={<Navigate to="/settings/people" replace/>}/>
        <Route path="users" element={<Navigate to="/settings/people" replace/>}/>
        <Route path="positions" element={<Navigate to="/settings/people" replace/>}/>
        <Route path="permissions" element={<Navigate to="/settings/people" replace/>}/>
        <Route path="modules" element={<Navigate to="/settings/system" replace/>}/>
        <Route path="backup" element={<Navigate to="/settings/system" replace/>}/>
        <Route path="devices" element={<Navigate to="/settings/system" replace/>}/>
      </Route>
    </Route>
    <Route path="*" element={<Navigate to="/home"/>}/>
  </Routes>;
}
export default function App() { return <AuthProvider><Gate><AppRoutes/></Gate></AuthProvider>; }
