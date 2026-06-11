import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Suspense, lazy, useEffect, useState } from 'react';
import AppLayout from './layouts/AppLayout';
import SettingsLayout from './layouts/SettingsLayout';
import { AuthProvider, useAuth } from './hooks/useAuth';
import { ModuleProvider } from './hooks/useModules';
import { getSetupStatus } from './services/api';
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

function Gate({ children }: { children: React.ReactNode }) {
  const [setupComplete, setSetupComplete] = useState<boolean | null>(null); const { user, loading } = useAuth(); const location = useLocation();
  useEffect(() => { getSetupStatus().then(s => setSetupComplete(s.setupComplete)).catch(() => setSetupComplete(false)); }, []);
  if (setupComplete === null || loading) return <div className="auth"><div className="card">Loading SECH_LIMS host...</div></div>;
  if (!setupComplete && location.pathname !== '/setup') return <Navigate to="/setup" replace />;
  if (setupComplete && location.pathname === '/setup') return <Navigate to={user ? '/home' : '/login'} replace />;
  if (setupComplete && !user && location.pathname !== '/login') return <Navigate to="/login" replace />;
  if (setupComplete && user && location.pathname === '/login') return <Navigate to="/home" replace />;
  return <>{children}</>;
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
