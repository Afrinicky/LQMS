import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useEffect, useState } from 'react';
import AppLayout from './layouts/AppLayout';
import SettingsLayout from './layouts/SettingsLayout';
import { AuthProvider, useAuth } from './hooks/useAuth';
import { ModuleProvider } from './hooks/useModules';
import { getSetupStatus } from './services/api';
import { LoginPage, SetupPage } from './pages/AuthPages';
import { Dashboard, Home, ModulePage, Organisation } from './pages/CorePages';
import { DocumentControlPage } from './pages/DocumentControlPage';
import { PersonnelManagementPage } from './pages/PersonnelManagementPage';
import { AssessmentsPage, MeetingsPage, ManagementReviewPage, QualityIndicatorsPage, ContinualImprovementPage } from './pages/Phase8Pages';
import { CustomerFocusPage } from './pages/CustomerFocusPage';
import { ActionTracker, BackupRestore, Devices, DocumentImport, EvidenceUpload, ModuleToggles, PermissionMatrix, Positions, UsersAccess } from './pages/SettingsPages';
import { EquipmentPage, InventoryPage, MonitoringPage, SafetyPage } from './pages/Phase3Pages';
import { IqcPage, EqaPage, VerificationValidationPage, MeasurementUncertaintyPage } from './pages/Phase4Pages';
import { BloodBankHandoverPage } from './pages/BloodBankHandoverPage';
import { MonthlyReportsPage } from './pages/MonthlyReportsPage';
import { NcCapaPage, ComplaintsPage, RisksPage, QmsActionTracker } from './pages/QMSPages';
import { MODULES } from '../shared/constants/modules';
import './styles/app.css';

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
      <Route path="/documents" element={<DocumentControlPage/>}/>
      <Route path="/organisation" element={<Organisation/>}/>
      <Route path="/personnel" element={<PersonnelManagementPage/>}/>
      <Route path="/nc-capa" element={<NcCapaPage/>}/>
      <Route path="/complaints" element={<ComplaintsPage/>}/>
      <Route path="/risks" element={<RisksPage/>}/>
      <Route path="/actions" element={<QmsActionTracker/>}/>
      <Route path="/equipment" element={<EquipmentPage/>}/>
      <Route path="/supplier-inventory" element={<InventoryPage/>}/>
      <Route path="/monitoring" element={<MonitoringPage/>}/>
      <Route path="/facilities-safety" element={<SafetyPage/>}/>
      <Route path="/iqc" element={<IqcPage/>}/>
      <Route path="/eqa" element={<EqaPage/>}/>
      <Route path="/verification-validation" element={<VerificationValidationPage/>}/>
      <Route path="/measurement-uncertainty" element={<MeasurementUncertaintyPage/>}/>
      <Route path="/blood-bank-handover" element={<BloodBankHandoverPage/>}/>
      <Route path="/monthly-reports" element={<MonthlyReportsPage/>}/>
      <Route path="/assessments" element={<AssessmentsPage/>}/>
      <Route path="/meetings" element={<MeetingsPage/>}/>
      <Route path="/management-review" element={<ManagementReviewPage/>}/>
      <Route path="/quality-indicators" element={<QualityIndicatorsPage/>}/>
      <Route path="/continual-improvement" element={<ContinualImprovementPage/>}/>
      <Route path="/customer-focus" element={<CustomerFocusPage/>}/>
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
export default function App(){return <AuthProvider><Gate><AppRoutes/></Gate></AuthProvider>}
