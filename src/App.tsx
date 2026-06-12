import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import AppLayout from './layouts/AppLayout';
import SettingsLayout from './layouts/SettingsLayout';
import { AuthProvider, useAuth } from './hooks/useAuth';
import { ModuleProvider } from './hooks/useModules';
import { API_BASE, getSetupStatus } from './services/api';
import { LoginPage, SetupPage } from './pages/AuthPages';
import { Dashboard, Home, ModulePage, Organisation } from './pages/CorePages';
import { ActionTracker, BackupRestore, Devices, DocumentImport, EvidenceUpload, ModuleToggles, PermissionMatrix, Positions, UsersAccess } from './pages/SettingsPages';
import { NcCapaPage, ComplaintsPage, RisksPage, QmsActionTracker } from './pages/QMSPages';
import { MODULES } from '../shared/constants/modules';
import './styles/app.css';

const DocumentControlPage = lazy(() => import('./pages/DocumentControlPage').then(m => ({ default: m.DocumentControlPage })));
const PersonnelManagementPage = lazy(() => import('./pages/PersonnelManagementPage').then(m => ({ default: m.PersonnelManagementPage })));
const AssessmentsPage = lazy(() => import('./pages/Phase8Pages').then(m => ({ default: m.AssessmentsPage })));
const MeetingsPage = lazy(() => import('./pages/Phase8Pages').then(m => ({ default: m.MeetingsPage })));
const ManagementReviewPage = lazy(() => import('./pages/Phase8Pages').then(m => ({ default: m.ManagementReviewPage })));
const QualityIndicatorsPage = lazy(() => import('./pages/Phase8Pages').then(m => ({ default: m.QualityIndicatorsPage })));
const ContinualImprovementPage = lazy(() => import('./pages/Phase8Pages').then(m => ({ default: m.ContinualImprovementPage })));
const CustomerFocusPage = lazy(() => import('./pages/CustomerFocusPage').then(m => ({ default: m.CustomerFocusPage })));
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

type StartupState = 'booting' | 'checkingApi' | 'apiUnavailable' | 'checkingSetup' | 'setupRequired' | 'checkingAuth' | 'loginRequired' | 'authenticated' | 'startupError';

function StartupShell({ heading, message, detail, children }: { heading: string; message: string; detail?: string; children?: React.ReactNode }) {
  return <div className="auth">
    <div className="card" style={{ maxWidth: 640 }}>
      <h2 style={{ marginTop: 0, color: 'var(--navy)' }}>SECH_LIMS by Nickland</h2>
      <p style={{ fontWeight: 600 }}>{heading}</p>
      <p style={{ color: 'var(--muted)' }}>{message}</p>
      {detail && <pre style={{ background: '#fff', border: '1px solid var(--border)', borderRadius: 8, padding: 12, whiteSpace: 'pre-wrap', color: '#172033', fontSize: 12 }}>{detail}</pre>}
      {children}
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

  // Phase 2: ask the API whether first-time setup is complete.
  useEffect(() => {
    if (state !== 'checkingSetup') return;
    let cancelled = false;
    getSetupStatus()
      .then(s => { if (cancelled) return; console.log('[renderer] setup status', s); setSetupComplete(s.setupComplete); setState(s.setupComplete ? 'checkingAuth' : 'setupRequired'); })
      .catch(err => { if (cancelled) return; console.error('[renderer] setup status failed', err); setErrorDetail(String(err)); setState('startupError'); });
    return () => { cancelled = true; };
  }, [state]);

  // Phase 3: wait for AuthProvider to finish its /auth/me check.
  useEffect(() => {
    if (state !== 'checkingAuth') return;
    if (loading) return;
    setState(user ? 'authenticated' : 'loginRequired');
    console.log('[renderer] startup state ->', user ? 'authenticated' : 'loginRequired');
  }, [state, loading, user]);

  // Render a visible screen for every state. Never return null.
  if (state === 'booting' || state === 'checkingApi') {
    return <StartupShell heading="Starting up" message="Checking local API…" detail={`API base URL: ${API_BASE}`} />;
  }

  if (state === 'apiUnavailable') {
    return <StartupShell
      heading="Local API is not responding"
      message="The host API did not respond within 10 seconds. Make sure no other copy of SECH_LIMS is running and the host service is reachable."
      detail={`API base URL: ${API_BASE}\n${errorDetail}`}
    >
      <button onClick={retry} style={{ marginTop: 12 }}>Retry connection</button>
      <p style={{ color: 'var(--muted)', marginTop: 12, fontSize: 13 }}>Open <strong>View → Toggle Developer Tools</strong> to inspect the failure.</p>
    </StartupShell>;
  }

  if (state === 'checkingSetup') {
    return <StartupShell heading="Starting up" message="Checking setup status…" detail={`API base URL: ${API_BASE}`} />;
  }

  if (state === 'setupRequired') {
    if (location.pathname !== '/setup') return <Navigate to="/setup" replace />;
    return <>{children}</>;
  }

  if (state === 'checkingAuth') {
    return <StartupShell heading="Starting up" message="Checking session…" />;
  }

  if (state === 'loginRequired') {
    if (location.pathname !== '/login') return <Navigate to="/login" replace />;
    return <>{children}</>;
  }

  if (state === 'authenticated') {
    if (location.pathname === '/login') return <Navigate to="/home" replace />;
    if (location.pathname === '/setup' && setupComplete) return <Navigate to="/home" replace />;
    return <>{children}</>;
  }

  // startupError
  return <StartupShell
    heading="Startup error"
    message="Something went wrong while the application was starting up."
    detail={errorDetail || 'No further details available.'}
  >
    <button onClick={retry} style={{ marginTop: 12 }}>Retry</button>
    <p style={{ color: 'var(--muted)', marginTop: 12, fontSize: 13 }}>Open <strong>View → Toggle Developer Tools</strong> for the full stack trace.</p>
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
      <Route path="/organisation" element={<Organisation/>}/>
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
        <Route index element={<Navigate to="users"/>}/>
        <Route path="users" element={<UsersAccess/>}/>
        <Route path="positions" element={<Positions/>}/>
        <Route path="permissions" element={<PermissionMatrix/>}/>
        <Route path="modules" element={<ModuleToggles/>}/>
        <Route path="document-import" element={<DocumentImport/>}/>
        <Route path="evidence" element={<EvidenceUpload/>}/>
        <Route path="actions" element={<ActionTracker/>}/>
        <Route path="backup" element={<BackupRestore/>}/>
        <Route path="devices" element={<Devices/>}/>
      </Route>
    </Route>
    <Route path="*" element={<Navigate to="/home"/>}/>
  </Routes>;
}
export default function App() { return <AuthProvider><Gate><AppRoutes/></Gate></AuthProvider>; }
