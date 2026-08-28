import { FormEvent, Suspense, lazy, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import PageHeader from '../components/ui/PageHeader';
import { KpiStrip, ChartCard, BarMeter, BarChart, CHART_COLORS, ModuleAlerts, DetailModal, RegisterSearch } from '../components/ui';
import { useModules } from '../hooks/useModules';
import { Download, Upload } from 'lucide-react';
import { api, API_BASE, getToken, errorText, apiRead } from '../services/api';
import { useAuth } from '../hooks/useAuth';
import { DutyRosterBoard, ReassignmentBoard, BenchScheduleBoard, ActingSupervisorsBoard } from './SchedulingBoards';
import DisabledModule from '../components/DisabledModule';
import { usePermissions } from '../hooks/usePermissions';
import PermissionTabs from '../components/PermissionTabs';
import { useFocusTarget, focusAttr } from '../hooks/useFocusTarget';
import CompetencyWorkspace from './personnel/CompetencyWorkspace';
import AppraisalWorkspace from './personnel/AppraisalWorkspace';
import OrientationInduction from './personnel/OrientationInduction';
import type {
  Section, Department, Staff, Position,
  StaffDocument, StaffDeclaration, TrainingEvent, DutyRoster,
  PersonnelSummary, MyTasks, MyProfile, RosterCoverage, StaffSuggestionsResponse, ProfessionalRank,
  JobDescriptionDoc, JobDescriptionRegister,
} from '../../shared/types/api';

// Document control's own viewer, so a job description previewed from a
// personnel screen is the same document, at the same version, as the one read
// in Documents & Records. Lazy — Personnel Management should not carry it.
const DocumentViewer = lazy(() => import('./DocumentControlPage').then(m => ({ default: m.DocumentViewer })));

const statusBadgeClass = (status?: string) => `badge ${status ? status.toLowerCase().replace(/\s+/g, '-') : 'unknown'}`;
const formatBadge = (status?: string) => <span className={statusBadgeClass(status)}>{status ? status.replace(/_/g, ' ') : 'Unknown'}</span>;
// Tabs are filtered by permission — a tab whose feature this user cannot
// view is not drawn. See src/components/PermissionTabs.tsx.
const TAB_MODULE = 'personnel';
const tabBar = (active: string, tabs: string[], onChange: (name: string) => void) =>
  <PermissionTabs moduleKey={TAB_MODULE} tabs={tabs} active={active} onChange={onChange} />;

const STAFF_DOC_TYPES = ['CV', 'Qualification', 'Licence', 'Certificate', 'Contract', 'Job description', 'ID', 'Reference', 'Other'];
const DECLARATION_TYPES = ['confidentiality', 'ethical_declaration', 'conflict_of_interest', 'safety_commitment', 'other'];
const ATTENDANCE_STATUSES = ['invited', 'attended', 'absent', 'excused'];
const GENDERS = ['MALE', 'FEMALE', 'OTHER'];
const PERSONNEL_CATEGORIES = ['STAFF', 'INTERN', 'NSS', 'LOCUM', 'STUDENT', 'CONTRACTOR'];
const APPOINTMENT_TYPES = ['FULL TIME', 'PART TIME', 'CONTRACT', 'INTERN', 'NSS', 'LOCUM'];
const NATIONAL_ID_TYPES = ['GHANA CARD', 'PASSPORT', 'VOTER ID', 'DRIVERS LICENCE', 'OTHER'];
const CADRES = ['Scientist', 'Technician', 'Assistant', 'Other'];
const AVAILABILITY_STATUSES = ['available', 'on_leave', 'transferred', 'inactive', 'unavailable'];
const emptyStaffForm = {
  employeeNo: '', surname: '', middleName: '', firstName: '', initials: '', dateOfBirth: '', gender: '',
  designation: '', jobTitle: '', professionalRegulator: '', professionalLicence: '', licenceExpiryDate: '',
  qualifications: '', sectionId: '', unit: '', personnelCategory: 'STAFF', appointmentType: 'FULL TIME',
  appointmentDate: '', nationalIdType: 'GHANA CARD', nationalIdNumber: '', emergencyContact: '', phone: '',
  email: '', staffFileLocation: '', positionId: '', cadre: '', professionalRank: '', availabilityStatus: 'available',
};
function yearsBetween(dateStr?: string): string {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '—';
  const yrs = (Date.now() - d.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
  return yrs >= 0 ? `${yrs.toFixed(1)} yrs` : '—';
}

function useLookups() {
  const [staff, setStaff] = useState<Staff[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [positions, setPositions] = useState<Position[]>([]);
  const reloadStaff = () => api<Staff[]>('/staff').then(setStaff).catch(() => setStaff([]));
  useEffect(() => {
    void reloadStaff();
    api<Section[]>('/sections').then(setSections).catch(() => setSections([]));
    api<Department[]>('/departments').then(setDepartments).catch(() => setDepartments([]));
    api<Position[]>('/positions').then(setPositions).catch(() => setPositions([]));
  }, []);
  return { staff, sections, departments, positions, reloadStaff };
}

function staffName(staffList: Staff[], id?: number | null) {
  if (!id) return '—';
  return staffList.find(s => s.id === id)?.fullName || `Staff #${id}`;
}

export function PersonnelManagementPage() {
  const { can } = usePermissions();
  const { isEnabled } = useModules();
  const { user } = useAuth();
  // Who may build rosters is a granted permission, not a guess from the role's
  // name. The old test matched any role whose title happened to contain
  // "manager", "head", "administrator" or "supervisor", so a custom role such
  // as "Bench Head" silently gained roster editing nobody had granted it.
  const canEditRosters = can('personnel.rosters', 'edit');
  const { staff, sections, departments, positions, reloadStaff } = useLookups();
  const [tab, setTab] = useState('Dashboard');
  const [error, setError] = useState<string | null>(null);

  const [summary, setSummary] = useState<PersonnelSummary | null>(null);
  const [staffDocs, setStaffDocs] = useState<StaffDocument[]>([]);
  const [declarations, setDeclarations] = useState<StaffDeclaration[]>([]);
  const [trainings, setTrainings] = useState<TrainingEvent[]>([]);
  const [selectedTraining, setSelectedTraining] = useState<TrainingEvent | null>(null);
  // A dashboard alert arrives with ?tab= and ?focus=; the tab bar opens the tab,
  // this scrolls to the record and flashes it. Competence and appraisal records
  // carry their own focus targets inside their workspaces.
  useFocusTarget(staffDocs.length);
  const [rosters, setRosters] = useState<DutyRoster[]>([]);
  const [selectedRoster, setSelectedRoster] = useState<DutyRoster | null>(null);
  const [myProfile, setMyProfile] = useState<MyProfile | null>(null);
  const [myTasks, setMyTasks] = useState<MyTasks | null>(null);
  const [staffSuggestions, setStaffSuggestions] = useState<StaffSuggestionsResponse | null>(null);
  const [rosterCoverage, setRosterCoverage] = useState<RosterCoverage | null>(null);

  const [docForm, setDocForm] = useState({ staffId: '', documentType: 'CV', title: '', issueDate: '', expiryDate: '', remarks: '' });
  const [docFile, setDocFile] = useState<File | null>(null);
  const [declForm, setDeclForm] = useState({ declarationType: 'ethical_declaration', title: '', description: '', staffId: '', impartialityConfirmed: true, confidentialityConfirmed: true, codeOfConductAck: true, conflictOfInterest: 'None Declared', formCompletedDate: '', reviewedByStaffId: '', nextReviewDate: '' });
  const [staffForm, setStaffForm] = useState(emptyStaffForm);
  const [editingStaffId, setEditingStaffId] = useState<number | null>(null);
  const [staffSearch, setStaffSearch] = useState('');
  const [regBusy, setRegBusy] = useState('');
  const [regResult, setRegResult] = useState<{ created: number; updated: number; skipped?: number; errors: string[] } | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const [ranks, setRanks] = useState<ProfessionalRank[]>([]);
  useEffect(() => { api<ProfessionalRank[]>('/professional-ranks').then(setRanks).catch(() => setRanks([])); }, []);
  const [trainingForm, setTrainingForm] = useState({ title: '', description: '', trainingType: '', sectionId: '', trainerStaffId: '', trainingDate: '', startTime: '', endTime: '', location: '' });
  const [attendanceForm, setAttendanceForm] = useState({ staffId: '', attendanceStatus: 'attended', remarks: '' });
  const [rosterForm, setRosterForm] = useState({ departmentId: '', sectionId: '', rosterStartDate: '', rosterEndDate: '', notes: '' });
  const [assignForm, setAssignForm] = useState({ staffId: '', dutyDate: '', shiftName: '', startTime: '', endTime: '', dutyRole: '', notes: '' });

  async function load() {
    try {
      const [sum, sd, decl, tr, rs] = await Promise.all([
        api<PersonnelSummary>('/dashboard/personnel-summary').catch(() => null),
        apiRead<StaffDocument[]>('/personnel/staff-documents', []),
        apiRead<StaffDeclaration[]>('/personnel/declarations', []),
        apiRead<TrainingEvent[]>('/personnel/training', []),
        apiRead<DutyRoster[]>('/personnel/rosters', [])
      ]);
      if (sum) setSummary(sum);
      setStaffDocs(sd); setDeclarations(decl); setTrainings(tr); setRosters(rs);
    } catch (e) { setError(errorText(e)); }
  }
  useEffect(() => { if (isEnabled('personnel')) void load(); }, [isEnabled]);
  if (!isEnabled('personnel')) return <DisabledModule />;

  async function uploadFile(file: File | null): Promise<string | null> {
    if (!file) return null;
    const fd = new FormData();
    fd.append('file', file);
    const token = getToken();
    const response = await fetch(`${API_BASE}/files`, { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : undefined, body: fd });
    if (!response.ok) throw new Error((await response.json().catch(() => ({ error: response.statusText }))).error ?? response.statusText);
    const data = await response.json();
    return String(data.id);
  }

  async function submitStaffDoc(e: FormEvent) {
    e.preventDefault(); setError(null);
    try {
      const fileId = await uploadFile(docFile);
      await api('/personnel/staff-documents', { method: 'POST', body: JSON.stringify({ ...docForm, fileId }) });
      setDocForm({ staffId: '', documentType: 'CV', title: '', issueDate: '', expiryDate: '', remarks: '' }); setDocFile(null);
      await load();
    } catch (e) { setError(errorText(e)); }
  }

  async function verifyStaffDoc(id: number) {
    try { await api(`/personnel/staff-documents/${id}/verify`, { method: 'POST', body: JSON.stringify({ verificationStatus: 'verified' }) }); await load(); }
    catch (e) { setError(errorText(e)); }
  }

  async function submitDeclaration(e: FormEvent) {
    e.preventDefault(); setError(null);
    try {
      await api('/personnel/declarations', { method: 'POST', body: JSON.stringify(declForm) });
      setDeclForm({ declarationType: 'ethical_declaration', title: '', description: '', staffId: '', impartialityConfirmed: true, confidentialityConfirmed: true, codeOfConductAck: true, conflictOfInterest: 'None Declared', formCompletedDate: '', reviewedByStaffId: '', nextReviewDate: '' });
      await load();
    } catch (e) { setError(errorText(e)); }
  }

  function editStaff(s: Staff) {
    setTab('Add Staff');
    setEditingStaffId(s.id);
    setStaffForm({
      employeeNo: s.employeeNo ?? '', surname: s.surname ?? '', middleName: s.middleName ?? '', firstName: s.firstName ?? '',
      initials: s.initials ?? '', dateOfBirth: s.dateOfBirth ?? '', gender: s.gender ?? '', designation: s.designation ?? '',
      jobTitle: s.jobTitle ?? '', professionalRegulator: s.professionalRegulator ?? '', professionalLicence: s.professionalLicence ?? '',
      licenceExpiryDate: s.licenceExpiryDate ?? '', qualifications: s.qualifications ?? '', sectionId: s.sectionId ? String(s.sectionId) : '',
      unit: s.unit ?? '', personnelCategory: s.personnelCategory ?? 'STAFF', appointmentType: s.appointmentType ?? 'FULL TIME',
      appointmentDate: s.appointmentDate ?? '', nationalIdType: s.nationalIdType ?? 'GHANA CARD', nationalIdNumber: s.nationalIdNumber ?? '',
      emergencyContact: s.emergencyContact ?? '', phone: s.phone ?? '', email: s.email ?? '', staffFileLocation: s.staffFileLocation ?? '', positionId: '',
      cadre: s.cadre ?? '', professionalRank: s.professionalRank ?? '', availabilityStatus: s.availabilityStatus ?? 'available',
    });
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function submitStaff(e: FormEvent) {
    e.preventDefault(); setError(null);
    if (!staffForm.surname && !staffForm.firstName) { setError('At least a first name or surname is required.'); return; }
    try {
      if (editingStaffId) await api(`/staff/${editingStaffId}`, { method: 'PUT', body: JSON.stringify(staffForm) });
      else await api('/staff', { method: 'POST', body: JSON.stringify(staffForm) });
      setStaffForm(emptyStaffForm); setEditingStaffId(null);
      await reloadStaff();
      setTab('Master Personnel Register');
    } catch (e) { setError(errorText(e)); }
  }

  async function downloadRegister(path: string, fallback: string) {
    setError(null); setRegBusy(path);
    try {
      const token = getToken();
      const res = await fetch(`${API_BASE}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : undefined });
      if (!res.ok) throw new Error((await res.json().catch(() => ({ error: res.statusText }))).error ?? res.statusText);
      const blob = await res.blob();
      const m = (res.headers.get('Content-Disposition') || '').match(/filename="?([^"]+)"?/);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = m ? m[1] : fallback; document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch (e) { setError(errorText(e)); }
    finally { setRegBusy(''); }
  }

  // Import routes through the single approved Master Personnel Register workbook
  // (Settings → People & Access → Import / Export) so there is one Excel structure.
  async function importRegister(file: File) {
    setError(null); setRegResult(null); setRegBusy('import');
    try {
      const fd = new FormData(); fd.append('file', file);
      const token = getToken();
      const res = await fetch(`${API_BASE}/staff/import`, { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : undefined, body: fd });
      const data = await res.json().catch(() => ({ error: res.statusText }));
      if (!res.ok) throw new Error(data.error ?? res.statusText);
      setRegResult(data as { created: number; updated: number; skipped?: number; errors: string[] });
      await reloadStaff();
    } catch (e) { setError(errorText(e)); }
    finally { setRegBusy(''); if (importInputRef.current) importInputRef.current.value = ''; }
  }

  async function signDeclaration(id: number) {
    try { await api(`/personnel/declarations/${id}/sign`, { method: 'POST', body: JSON.stringify({}) }); await load(); }
    catch (e) { setError(errorText(e)); }
  }

  async function submitTraining(e: FormEvent) {
    e.preventDefault(); setError(null);
    try {
      await api('/personnel/training', { method: 'POST', body: JSON.stringify(trainingForm) });
      setTrainingForm({ title: '', description: '', trainingType: '', sectionId: '', trainerStaffId: '', trainingDate: '', startTime: '', endTime: '', location: '' });
      await load();
    } catch (e) { setError(errorText(e)); }
  }

  async function openTraining(id: number) {
    try { setSelectedTraining(await api<TrainingEvent>(`/personnel/training/${id}`)); }
    catch (e) { setError(errorText(e)); }
  }

  async function submitAttendance(e: FormEvent) {
    e.preventDefault(); setError(null);
    if (!selectedTraining) return;
    try {
      await api(`/personnel/training/${selectedTraining.id}/attendance`, { method: 'POST', body: JSON.stringify(attendanceForm) });
      setAttendanceForm({ staffId: '', attendanceStatus: 'attended', remarks: '' });
      await openTraining(selectedTraining.id);
    } catch (e) { setError(errorText(e)); }
  }

  async function submitRoster(e: FormEvent) {
    e.preventDefault(); setError(null);
    try {
      await api('/personnel/rosters', { method: 'POST', body: JSON.stringify(rosterForm) });
      setRosterForm({ departmentId: '', sectionId: '', rosterStartDate: '', rosterEndDate: '', notes: '' });
      await load();
    } catch (e) { setError(errorText(e)); }
  }

  async function openRoster(id: number) {
    try {
      setSelectedRoster(await api<DutyRoster>(`/personnel/rosters/${id}`));
      setRosterCoverage(await api<RosterCoverage>(`/personnel/rosters/${id}/coverage`));
    } catch (e) { setError(errorText(e)); }
  }

  async function linkMyStaff(staffId: number) {
    try {
      await api('/personnel/link-my-staff', { method: 'POST', body: JSON.stringify({ staffId }) });
      const [prof, sug] = await Promise.all([
        api<MyProfile>('/personnel/my-profile'),
        api<StaffSuggestionsResponse>('/personnel/staff-suggestions')
      ]);
      setMyProfile(prof); setStaffSuggestions(sug);
    } catch (e) { setError(errorText(e)); }
  }

  async function submitAssignment(e: FormEvent) {
    e.preventDefault(); setError(null);
    if (!selectedRoster) return;
    try {
      await api(`/personnel/rosters/${selectedRoster.id}/assignments`, { method: 'POST', body: JSON.stringify(assignForm) });
      setAssignForm({ staffId: '', dutyDate: '', shiftName: '', startTime: '', endTime: '', dutyRole: '', notes: '' });
      await openRoster(selectedRoster.id);
    } catch (e) { setError(errorText(e)); }
  }

  async function approveRoster(id: number) {
    try { await api(`/personnel/rosters/${id}/approve`, { method: 'POST', body: JSON.stringify({}) }); await load(); if (selectedRoster?.id === id) await openRoster(id); }
    catch (e) { setError(errorText(e)); }
  }

  const tabs = ['Dashboard', 'Master Personnel Register', 'Add Staff', 'Staff Documents', 'Job Descriptions', 'Orientation & Induction', 'Declarations', 'Training Events', 'Competency Assessments', 'Performance Appraisals', 'Technical Authorizations', 'Duty Roster', 'Unit Reassignments', 'Unit Supervisors', 'Bench Schedules', 'Reports'];

  return <div className="module-page">
    <PageHeader eyebrow="Personnel Management" title="Personnel Management" subtitle="Personnel records — competence, authorisation, training, induction, and ethics." />
    {tabBar(tab, tabs, setTab)}
    {error && <div className="error">{error}</div>}

    {tab === 'Dashboard' && <ModuleAlerts moduleKey="personnel" />}
    {tab === 'Dashboard' && (summary ? <KpiStrip items={[
      { label: 'Active staff', value: summary.totalStaff ?? staff.length, onClick: () => setTab('Master Personnel Register') },
      { label: 'Docs pending verification', value: summary.staffDocumentsPendingVerification, onClick: () => setTab('Staff Documents') },
      { label: 'Certificates expiring', value: summary.certificatesExpiringSoon, tone: 'warning', onClick: () => setTab('Staff Documents') },
      { label: 'Licences expiring', value: summary.licencesExpiringSoon ?? 0, tone: 'warning', onClick: () => setTab('Master Personnel Register') },
      { label: 'Pending declarations', value: summary.pendingDeclarations, onClick: () => setTab('Declarations') },
      { label: 'Orientations in progress', value: summary.orientationsInProgress ?? 0, onClick: () => setTab('Orientation & Induction') },
      { label: 'Competency due', value: summary.competencyAssessmentsDue, tone: summary.competencyAssessmentsDue ? 'warning' : undefined, onClick: () => setTab('Competency Assessments') },
      { label: 'Appraisals due', value: summary.appraisalsDue ?? 0, tone: (summary.appraisalsDue ?? 0) ? 'warning' : undefined, onClick: () => setTab('Performance Appraisals') },
      { label: 'Authorisations due', value: summary.authorizationsDueReview, onClick: () => setTab('Technical Authorizations') },
    ]} /> : <p>Loading summary…</p>)}
    {tab === 'Dashboard' && summary && <div className="grid cols-2" style={{ marginTop: 18 }}>
      <ChartCard title="Compliance backlog" subtitle="Personnel records needing action">
        <BarMeter data={[
          { label: 'Docs pending verification', value: summary.staffDocumentsPendingVerification, color: CHART_COLORS[0] },
          { label: 'Certificates expiring', value: summary.certificatesExpiringSoon, color: CHART_COLORS[2] },
          { label: 'Pending declarations', value: summary.pendingDeclarations, color: CHART_COLORS[4] },
          { label: 'Authorisations due', value: summary.authorizationsDueReview, color: CHART_COLORS[3] },
          { label: 'Ethics reviews due', value: summary.ethicsReviewsDue ?? 0, color: CHART_COLORS[5] },
        ]} />
      </ChartCard>
      <ChartCard title="Training & competency" subtitle="Development and assessment activity">
        <BarChart data={[
          { label: 'Training', value: summary.plannedTrainingEvents, color: CHART_COLORS[0] },
          { label: 'Competency due', value: summary.competencyAssessmentsDue, color: CHART_COLORS[2] },
          { label: 'Appraisals in progress', value: summary.appraisalsInProgress ?? 0, color: CHART_COLORS[3] },
          { label: 'Rosters', value: summary.rostersThisMonth, color: CHART_COLORS[1] },
        ]} />
      </ChartCard>
    </div>}

    {tab === 'Master Personnel Register' && <>
      <div className="card">
        <div className="section-head" style={{ alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <h3 style={{ margin: 0 }}>Master Personnel Register</h3>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {can('personnel.register', 'export') && <button type="button" className="secondary" disabled={!!regBusy} title="Download the register as an Excel workbook" onClick={() => downloadRegister('/staff/export', 'Master_Personnel_Register.xlsx')}><Download size={15} style={{ verticalAlign: '-2px', marginRight: 6 }} />{regBusy === '/staff/export' ? 'Exporting…' : 'Export'}</button>}
            {can('personnel.register', 'import') && <>
              <button type="button" className="secondary" disabled={!!regBusy} title="Upload a completed register workbook" onClick={() => importInputRef.current?.click()}><Upload size={15} style={{ verticalAlign: '-2px', marginRight: 6 }} />{regBusy === 'import' ? 'Importing…' : 'Import'}</button>
              <input ref={importInputRef} type="file" accept=".xlsx,.xls" style={{ display: 'none' }} onChange={e => { const f = e.target.files?.[0]; if (f) void importRegister(f); }} />
            </>}
            <RegisterSearch style={{ maxWidth: 240 }} onQuery={setStaffSearch} placeholder="Search name, ID, position…" />
          </div>
        </div>
        <p className="muted" style={{ marginTop: 0 }}>The complete register of laboratory personnel. Export or import uses the single approved workbook — rows are matched on Staff ID, so existing staff are updated and new ones created.</p>
        {regResult && <div className="success-msg" style={{ marginTop: 4, marginBottom: 12 }}><strong>{regResult.created}</strong> created, <strong>{regResult.updated}</strong> updated{typeof regResult.skipped === 'number' ? <>, <strong>{regResult.skipped}</strong> skipped</> : null}.{regResult.errors.length > 0 && <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>{regResult.errors.map((er, i) => <li key={i} style={{ fontSize: 12 }}>{er}</li>)}</ul>}</div>}
        <table className="data-table"><thead><tr><th>Staff ID</th><th>Name</th><th>Designation</th><th>Position</th><th>Unit</th><th>Category</th><th>Licence</th><th>Experience</th><th></th></tr></thead><tbody>
          {staff.filter(s => { const q = staffSearch.trim().toLowerCase(); if (!q) return true; return [s.fullName, s.employeeNo, s.jobTitle, s.designation, s.unit].some(v => v?.toLowerCase().includes(q)); }).map(s => {
            const today = new Date().toISOString().slice(0, 10);
            const licExpiringSoon = s.licenceExpiryDate && s.licenceExpiryDate <= new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10) && s.licenceExpiryDate >= today;
            const licExpired = s.licenceExpiryDate && s.licenceExpiryDate < today;
            return <tr key={s.id}>
              <td>{s.employeeNo || '—'}</td><td>{s.fullName}{s.initials ? <span className="muted"> ({s.initials})</span> : null}</td>
              <td>{s.designation || '—'}</td><td>{s.jobTitle || '—'}</td><td>{s.unit || (s.sectionId ? sections.find(x => x.id === s.sectionId)?.name : '') || '—'}</td>
              <td>{s.personnelCategory ? <span className="badge">{s.personnelCategory}</span> : '—'}</td>
              <td>{s.professionalLicence || '—'}{licExpired && <span className="badge danger">expired</span>}{licExpiringSoon && <span className="badge warning">expiring</span>}</td>
              <td>{yearsBetween(s.appointmentDate)}</td>
              <td><button type="button" onClick={() => editStaff(s)}>Edit</button></td>
            </tr>;
          })}
          {staff.length === 0 && <tr><td colSpan={9} className="muted">No staff records yet — add one from the <strong>Add Staff</strong> tab, or import the register above.</td></tr>}
        </tbody></table>
      </div>
    </>}

    {tab === 'Add Staff' && <>
      <div className="card">
        <div className="section-head"><h3 style={{ margin: 0 }}>{editingStaffId ? 'Edit staff record' : 'Add staff'}</h3>
          {editingStaffId && <button type="button" className="secondary" onClick={() => { setEditingStaffId(null); setStaffForm(emptyStaffForm); }}>Cancel edit</button>}</div>
        <p className="muted" style={{ marginTop: 0 }}>Adds a member of staff to the Master Personnel Register: identity, professional registration, qualifications, appointment and emergency contact.</p>
        {can('personnel.self', 'view') && can('personnel.register', 'create') && <form className="form-grid" onSubmit={submitStaff}>
          <label>Staff ID<input value={staffForm.employeeNo} onChange={e => setStaffForm({ ...staffForm, employeeNo: e.target.value })} placeholder="e.g. SNO-001" /></label>
          <label>Surname<input value={staffForm.surname} onChange={e => setStaffForm({ ...staffForm, surname: e.target.value })} /></label>
          <label>Middle name(s)<input value={staffForm.middleName} onChange={e => setStaffForm({ ...staffForm, middleName: e.target.value })} /></label>
          <label>First name(s)<input value={staffForm.firstName} onChange={e => setStaffForm({ ...staffForm, firstName: e.target.value })} /></label>
          <label>Initials<input value={staffForm.initials} onChange={e => setStaffForm({ ...staffForm, initials: e.target.value })} placeholder="auto" /></label>
          <label>Date of birth<input type="date" value={staffForm.dateOfBirth} onChange={e => setStaffForm({ ...staffForm, dateOfBirth: e.target.value })} /></label>
          <label>Gender<select value={staffForm.gender} onChange={e => setStaffForm({ ...staffForm, gender: e.target.value })}><option value="">—</option>{GENDERS.map(g => <option key={g} value={g}>{g}</option>)}</select></label>
          <label>Designation (grade)<input value={staffForm.designation} onChange={e => setStaffForm({ ...staffForm, designation: e.target.value })} placeholder="e.g. Principal Medical Lab Scientist" /></label>
          <label>Position / role<input value={staffForm.jobTitle} onChange={e => setStaffForm({ ...staffForm, jobTitle: e.target.value })} placeholder="e.g. Biochemistry Unit Head" /></label>
          <label>Unit / Section<select value={staffForm.sectionId} onChange={e => setStaffForm({ ...staffForm, sectionId: e.target.value })}><option value="">—</option>{sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
          <label>Professional regulator<input value={staffForm.professionalRegulator} onChange={e => setStaffForm({ ...staffForm, professionalRegulator: e.target.value })} placeholder="e.g. AHPC" /></label>
          <label>Professional licence no.<input value={staffForm.professionalLicence} onChange={e => setStaffForm({ ...staffForm, professionalLicence: e.target.value })} /></label>
          <label>Licence expiry<input type="date" value={staffForm.licenceExpiryDate} onChange={e => setStaffForm({ ...staffForm, licenceExpiryDate: e.target.value })} /></label>
          <label>Qualifications<input value={staffForm.qualifications} onChange={e => setStaffForm({ ...staffForm, qualifications: e.target.value })} placeholder="Separate several with |" /></label>
          <label>Personnel category<select value={staffForm.personnelCategory} onChange={e => setStaffForm({ ...staffForm, personnelCategory: e.target.value })}>{PERSONNEL_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}</select></label>
          <label>Appointment type<select value={staffForm.appointmentType} onChange={e => setStaffForm({ ...staffForm, appointmentType: e.target.value })}>{APPOINTMENT_TYPES.map(c => <option key={c} value={c}>{c}</option>)}</select></label>
          <label>Date of appointment<input type="date" value={staffForm.appointmentDate} onChange={e => setStaffForm({ ...staffForm, appointmentDate: e.target.value })} /></label>
          <label>National ID type<select value={staffForm.nationalIdType} onChange={e => setStaffForm({ ...staffForm, nationalIdType: e.target.value })}>{NATIONAL_ID_TYPES.map(c => <option key={c} value={c}>{c}</option>)}</select></label>
          <label>National ID number<input value={staffForm.nationalIdNumber} onChange={e => setStaffForm({ ...staffForm, nationalIdNumber: e.target.value })} /></label>
          <label>Contact phone<input value={staffForm.phone} onChange={e => setStaffForm({ ...staffForm, phone: e.target.value })} /></label>
          <label>Email<input type="email" value={staffForm.email} onChange={e => setStaffForm({ ...staffForm, email: e.target.value })} /></label>
          <label>Emergency contact<input value={staffForm.emergencyContact} onChange={e => setStaffForm({ ...staffForm, emergencyContact: e.target.value })} placeholder="e.g. Spouse - 0200000000" /></label>
          <label>Cadre<select value={staffForm.cadre} onChange={e => setStaffForm({ ...staffForm, cadre: e.target.value })}><option value="">Auto (from designation)</option>{CADRES.map(c => <option key={c} value={c}>{c}</option>)}</select></label>
          <label>Professional rank<select value={staffForm.professionalRank} onChange={e => setStaffForm({ ...staffForm, professionalRank: e.target.value })}><option value="">Auto (from designation)</option>{ranks.map(r => <option key={r.id} value={r.name}>{r.name}</option>)}</select></label>
          <label>Availability<select value={staffForm.availabilityStatus} onChange={e => setStaffForm({ ...staffForm, availabilityStatus: e.target.value })}>{AVAILABILITY_STATUSES.map(a => <option key={a} value={a}>{a.replace(/_/g, ' ')}</option>)}</select></label>
          <label>Assign position<select value={staffForm.positionId} onChange={e => setStaffForm({ ...staffForm, positionId: e.target.value })}><option value="">— keep current —</option>{positions.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}</select></label>
          <label>Staff file location<input value={staffForm.staffFileLocation} onChange={e => setStaffForm({ ...staffForm, staffFileLocation: e.target.value })} placeholder="e.g. /SECH-LAB-PERSONNEL-FILES/SNO-001/" /></label>
          <button type="submit">{editingStaffId ? 'Save changes' : 'Create staff record'}</button>
        </form>}
      </div>
    </>}

    {tab === 'Job Descriptions' && <JobDescriptionsTab onError={setError} />}

    {tab === 'Staff Documents' && <>
      {can('personnel.register', 'create') && <form className="form-grid" onSubmit={submitStaffDoc}>
        <label>Staff<select value={docForm.staffId} onChange={e => setDocForm({ ...docForm, staffId: e.target.value })} required><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
        <label>Type<select value={docForm.documentType} onChange={e => setDocForm({ ...docForm, documentType: e.target.value })} required>{STAFF_DOC_TYPES.map(t => <option key={t} value={t}>{t}</option>)}</select></label>
        <label>Title<input value={docForm.title} onChange={e => setDocForm({ ...docForm, title: e.target.value })} required /></label>
        <label>Issue date<input type="date" value={docForm.issueDate} onChange={e => setDocForm({ ...docForm, issueDate: e.target.value })} /></label>
        <label>Expiry date<input type="date" value={docForm.expiryDate} onChange={e => setDocForm({ ...docForm, expiryDate: e.target.value })} /></label>
        <label>File<input type="file" onChange={e => setDocFile(e.target.files?.[0] ?? null)} /></label>
        <label>Remarks<input value={docForm.remarks} onChange={e => setDocForm({ ...docForm, remarks: e.target.value })} /></label>
        <button type="submit">Upload staff document</button>
      </form>}
      <table className="data-table"><thead><tr><th>Staff</th><th>Type</th><th>Title</th><th>Issue</th><th>Expiry</th><th>Verification</th><th>File</th><th></th></tr></thead><tbody>
        {staffDocs.map(d => {
          const today = new Date().toISOString().slice(0, 10);
          const expiringSoon = d.expiry_date && d.expiry_date <= new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10) && d.expiry_date >= today;
          const expired = d.expiry_date && d.expiry_date < today;
          return <tr key={d.id} {...focusAttr('staff_documents', d.id)}>
            <td>{d.staff_name || staffName(staff, d.staff_id)}</td><td>{d.document_type}</td><td>{d.title}</td>
            <td>{d.issue_date || '—'}</td>
            <td>{d.expiry_date || '—'} {expired && <span className="badge danger">expired</span>}{expiringSoon && <span className="badge warning">expiring</span>}</td>
            <td>{formatBadge(d.verification_status)}</td><td>{d.file_name || '—'}</td>
            <td>{d.verification_status === 'pending' && can('personnel.register', 'approve') && <button onClick={() => verifyStaffDoc(d.id)}>Verify</button>}</td>
          </tr>;
        })}
      </tbody></table>
    </>}

    {tab === 'Declarations' && <>
      <div className="card"><p className="muted" style={{ marginTop: 0 }}>Ethical declarations record each member of staff's commitment to impartiality, confidentiality, disclosure of conflicts of interest, and the code of conduct.</p>
      {can('personnel.declarations', 'create') && <form className="form-grid" onSubmit={submitDeclaration}>
        <label>Type<select value={declForm.declarationType} onChange={e => setDeclForm({ ...declForm, declarationType: e.target.value })} required>{DECLARATION_TYPES.map(t => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}</select></label>
        <label>Title<input value={declForm.title} onChange={e => setDeclForm({ ...declForm, title: e.target.value })} required placeholder="e.g. Annual ethics & confidentiality declaration" /></label>
        <label>Assign to staff<select value={declForm.staffId} onChange={e => setDeclForm({ ...declForm, staffId: e.target.value })}><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
        <label>Conflict of interest<input value={declForm.conflictOfInterest} onChange={e => setDeclForm({ ...declForm, conflictOfInterest: e.target.value })} placeholder="None Declared / details" /></label>
        <label>Form completed date<input type="date" value={declForm.formCompletedDate} onChange={e => setDeclForm({ ...declForm, formCompletedDate: e.target.value })} /></label>
        <label>Reviewed by<select value={declForm.reviewedByStaffId} onChange={e => setDeclForm({ ...declForm, reviewedByStaffId: e.target.value })}><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
        <label>Next review date<input type="date" value={declForm.nextReviewDate} onChange={e => setDeclForm({ ...declForm, nextReviewDate: e.target.value })} /></label>
        <label>Description / notes<textarea value={declForm.description} onChange={e => setDeclForm({ ...declForm, description: e.target.value })} /></label>
        <label className="check-inline"><input type="checkbox" checked={declForm.impartialityConfirmed} onChange={e => setDeclForm({ ...declForm, impartialityConfirmed: e.target.checked })} /> Impartiality confirmed</label>
        <label className="check-inline"><input type="checkbox" checked={declForm.confidentialityConfirmed} onChange={e => setDeclForm({ ...declForm, confidentialityConfirmed: e.target.checked })} /> Confidentiality confirmed</label>
        <label className="check-inline"><input type="checkbox" checked={declForm.codeOfConductAck} onChange={e => setDeclForm({ ...declForm, codeOfConductAck: e.target.checked })} /> Code of conduct acknowledged</label>
        <button type="submit">Create declaration</button>
      </form>}</div>
      <table className="data-table" style={{ marginTop: 16 }}><thead><tr><th>Number</th><th>Type</th><th>Title</th><th>Staff</th><th>Impartiality</th><th>Confidentiality</th><th>COI</th><th>Next review</th><th>Status</th><th></th></tr></thead><tbody>
        {declarations.map(d => <tr key={d.id}>
          <td>{d.declaration_number}</td><td>{d.declaration_type.replace(/_/g, ' ')}</td><td>{d.title}</td>
          <td>{d.staff_name || staffName(staff, d.staff_id)}</td>
          <td>{d.impartiality_confirmed == null ? '—' : (d.impartiality_confirmed ? '✓' : '✗')}</td>
          <td>{d.confidentiality_confirmed == null ? '—' : (d.confidentiality_confirmed ? '✓' : '✗')}</td>
          <td>{d.conflict_of_interest || '—'}</td>
          <td>{d.next_review_date || '—'}</td>
          <td>{formatBadge(d.status)}</td>
          <td>{d.status === 'pending' && can('personnel.declarations', 'edit') && <button onClick={() => signDeclaration(d.id)}>Sign</button>}</td>
        </tr>)}
      </tbody></table>
    </>}

    {tab === 'Orientation & Induction' && <OrientationInduction staff={staff} sections={sections} departments={departments} />}

    {tab === 'Training Events' && <>
      {can('personnel.training', 'create') && <form className="form-grid" onSubmit={submitTraining}>
        <label>Title<input value={trainingForm.title} onChange={e => setTrainingForm({ ...trainingForm, title: e.target.value })} required /></label>
        <label>Description<textarea value={trainingForm.description} onChange={e => setTrainingForm({ ...trainingForm, description: e.target.value })} /></label>
        <label>Type<input value={trainingForm.trainingType} onChange={e => setTrainingForm({ ...trainingForm, trainingType: e.target.value })} placeholder="e.g. internal, external, refresher" /></label>
        <label>Section<select value={trainingForm.sectionId} onChange={e => setTrainingForm({ ...trainingForm, sectionId: e.target.value })}><option value="">—</option>{sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label>Trainer<select value={trainingForm.trainerStaffId} onChange={e => setTrainingForm({ ...trainingForm, trainerStaffId: e.target.value })}><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
        <label>Date<input type="date" value={trainingForm.trainingDate} onChange={e => setTrainingForm({ ...trainingForm, trainingDate: e.target.value })} required /></label>
        <label>Start time<input type="time" value={trainingForm.startTime} onChange={e => setTrainingForm({ ...trainingForm, startTime: e.target.value })} /></label>
        <label>End time<input type="time" value={trainingForm.endTime} onChange={e => setTrainingForm({ ...trainingForm, endTime: e.target.value })} /></label>
        <label>Location<input value={trainingForm.location} onChange={e => setTrainingForm({ ...trainingForm, location: e.target.value })} /></label>
        <button type="submit">Create training event</button>
      </form>}
      <table className="data-table"><thead><tr><th>Number</th><th>Title</th><th>Type</th><th>Date</th><th>Status</th><th></th></tr></thead><tbody>
        {trainings.map(t => <tr key={t.id}>
          <td>{t.training_number}</td><td>{t.title}</td><td>{t.training_type || '—'}</td>
          <td>{t.training_date}</td><td>{formatBadge(t.status)}</td>
          <td><button onClick={() => openTraining(t.id)}>Open</button></td>
        </tr>)}
      </tbody></table>
      {selectedTraining && <DetailModal open onClose={() => setSelectedTraining(null)} title={<>{selectedTraining.training_number} — {selectedTraining.title}</>}>
        <h4>Attendance</h4>
        <table className="data-table"><thead><tr><th>Staff</th><th>Status</th><th>Signed</th><th>Remarks</th></tr></thead><tbody>
          {(selectedTraining.attendance || []).map(a => <tr key={a.id}><td>{a.staff_name || staffName(staff, a.staff_id)}</td><td>{formatBadge(a.attendance_status)}</td><td>{a.signed_at || '—'}</td><td>{a.remarks || '—'}</td></tr>)}
        </tbody></table>
        {can('personnel.training', 'create') && <form className="form-grid" onSubmit={submitAttendance}>
          <label>Staff<select value={attendanceForm.staffId} onChange={e => setAttendanceForm({ ...attendanceForm, staffId: e.target.value })} required><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
          <label>Status<select value={attendanceForm.attendanceStatus} onChange={e => setAttendanceForm({ ...attendanceForm, attendanceStatus: e.target.value })}>{ATTENDANCE_STATUSES.map(a => <option key={a} value={a}>{a}</option>)}</select></label>
          <label>Remarks<input value={attendanceForm.remarks} onChange={e => setAttendanceForm({ ...attendanceForm, remarks: e.target.value })} /></label>
          <button type="submit">Record attendance</button>
        </form>}
      </DetailModal>}
    </>}

    {tab === 'Competency Assessments' &&
      <CompetencyWorkspace staff={staff} sections={sections} departments={departments} positions={positions} />}

    {tab === 'Performance Appraisals' &&
      <AppraisalWorkspace staff={staff} sections={sections} departments={departments} positions={positions} />}

    {tab === 'Technical Authorizations' && <p>Technical authorisations are created from completed competency assessments via the Competency Assessments tab. They appear on each staff member's own record in <em>My Portal</em>.</p>}

    {tab === 'Duty Roster' && <DutyRosterBoard staff={staff} canEdit={canEditRosters} />}
    {tab === 'Unit Reassignments' && <ReassignmentBoard staff={staff} sections={sections} canEdit={canEditRosters} onNavigate={setTab} />}
    {tab === 'Unit Supervisors' && <ActingSupervisorsBoard staff={staff} sections={sections} canEdit={canEditRosters} />}
    {tab === 'Bench Schedules' && <BenchScheduleBoard sections={sections} canEdit={canEditRosters} />}


    {tab === 'Reports' && <div className="card">
      <h3>Personnel reports</h3>
      <p className="muted" style={{ marginTop: 0 }}>Printable summaries are produced from the register that holds the data:</p>
      <ul>
        <li><strong>Competency coverage matrix</strong> — who is covered for what, by unit. <em>Competency Assessments → Coverage matrix → Print matrix.</em></li>
        <li><strong>Competency assessment record</strong> — the full scored record with its evidence and signatures. <em>Open any assessment → Print record.</em></li>
        <li><strong>Blank assessment form</strong> — a framework printed as a form to complete away from a screen. <em>Competency Assessments → Frameworks → open one → Print blank form.</em></li>
        <li><strong>Performance appraisal record</strong> — ratings, objectives, development plan and signatures. <em>Open any appraisal → Print record.</em></li>
        <li><strong>Appraisal cycle summary</strong> — who is outstanding in a round. <em>Performance Appraisals → Setup → open a cycle → Print cycle summary.</em></li>
        <li><strong>Master Personnel Register</strong> — export to Excel from the register tab.</li>
      </ul>
      <p className="muted">Training-hours-per-member-of-staff and authorisation expiry trend reports follow in a later phase.</p>
    </div>}
  </div>;
}


/* ============================================================================
   Job Descriptions
   ----------------------------------------------------------------------------
   Personnel Management's view of documents that live in Document Control. It
   deliberately holds no copies: it reads the register and lists what is issued,
   for which post, and — the part an assessor actually asks about — which active
   posts have no description at all.

   Uploading one is document control's job and stays there, so this view links
   across rather than growing a second upload form. Two ways to create the same
   controlled document is two ways for it to be created wrongly.
   ========================================================================= */
function JobDescriptionsTab({ onError }: { onError: (m: string | null) => void }) {
  const navigate = useNavigate();
  const { can } = usePermissions();
  const [data, setData] = useState<JobDescriptionRegister | null>(null);
  const [reading, setReading] = useState<JobDescriptionDoc | null>(null);

  useEffect(() => {
    api<JobDescriptionRegister>('/personnel/job-descriptions')
      .then(setData)
      .catch(e => { onError(errorText(e)); setData({ documents: [], gaps: [] }); });
  }, [onError]);

  if (!data) return <p className="muted">Loading the job description register…</p>;

  const mayAuthor = can('documents.authoring', 'create');

  return <>
    <div className="section-head">
      <div>
        <h3 style={{ margin: 0 }}>Job descriptions</h3>
        <p className="muted" style={{ marginTop: 4, maxWidth: '72ch' }}>
          Job descriptions are controlled documents: written, reviewed, approved and versioned in
          Documents &amp; Records like any other. Naming the post one describes is what puts it here,
          and on the portal of every member of staff holding that post — from one upload, with no
          second copy to drift out of step.
        </p>
      </div>
      {mayAuthor && (
        <button type="button" className="secondary"
          onClick={() => navigate('/documents?new=Job%20Description')}>
          Upload a job description
        </button>
      )}
    </div>

    <table className="data-table">
      <thead><tr><th>Post / person</th><th>Document</th><th>Version</th><th>Status</th><th>Next review</th><th /></tr></thead>
      <tbody>
        {data.documents.map(d => (
          <tr key={d.id}>
            <td>
              <strong>{d.position_title ?? d.staff_name ?? '—'}</strong>
              {d.staff_name && d.applies_to_staff_id ? <div className="muted">issued to this person by name</div> : null}
              {!d.position_title && !d.staff_name ? <div className="muted">not linked to a post yet — it will not reach anybody&rsquo;s portal</div> : null}
            </td>
            <td>{d.title}<div className="muted">{d.document_code ?? '—'}</div></td>
            <td>{d.version_number ?? '—'}</td>
            <td>{formatBadge(d.status)}</td>
            <td>{d.next_review_date ?? '—'}</td>
            <td style={{ whiteSpace: 'nowrap' }}>
              {d.current_version_id
                ? <button type="button" className="pq-link" onClick={() => setReading(d)}>Preview</button>
                : <span className="muted">no file yet</span>}
              <button type="button" className="pq-link" onClick={() => navigate(`/documents?open=${d.id}`)}>Open in Documents</button>
            </td>
          </tr>
        ))}
        {data.documents.length === 0 && (
          <tr><td colSpan={6} className="muted">No job description has been registered yet.</td></tr>
        )}
      </tbody>
    </table>

    {data.gaps.length > 0 && <>
      <div className="section-head" style={{ marginTop: 22 }}>
        <h3 style={{ margin: 0 }}>Posts with no issued description</h3>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        ISO 15189 expects every post to have a documented description of its responsibilities and
        authority. These are the ones that do not, with the number of people currently holding each.
      </p>
      <ul className="jd-gaps">
        {data.gaps.map(g => (
          <li key={g.id}>
            <span>{g.title}</span>
            <span className={`badge ${g.staff_count > 0 ? 'warning' : ''}`}>
              {g.staff_count === 0 ? 'nobody in post' : g.staff_count === 1 ? '1 member of staff' : `${g.staff_count} members of staff`}
            </span>
          </li>
        ))}
      </ul>
    </>}

    {reading && (
      <Suspense fallback={<div className="card">Opening the document…</div>}>
        <DocumentViewer
          docId={reading.id}
          versionId={Number(reading.current_version_id ?? 0)}
          onClose={() => setReading(null)}
          onAttest={() => setReading(null)}
          onSaved={() => undefined}
          onError={onError}
        />
      </Suspense>
    )}
  </>;
}
