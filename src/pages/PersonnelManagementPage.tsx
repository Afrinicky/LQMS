import { FormEvent, useEffect, useState } from 'react';
import PageHeader from '../components/ui/PageHeader';
import { ChartCard, BarMeter, BarChart, CHART_COLORS } from '../components/ui';
import { useModules } from '../hooks/useModules';
import { api, API_BASE, getToken } from '../services/api';
import DisabledModule from '../components/DisabledModule';
import type {
  Section, Department, Staff, Position,
  StaffDocument, StaffDeclaration, TrainingEvent, CompetencyAssessment, DutyRoster,
  PersonnelSummary, MyTasks, MyProfile, RosterCoverage, StaffSuggestionsResponse
} from '../../shared/types/api';

const statusBadgeClass = (status?: string) => `badge ${status ? status.toLowerCase().replace(/\s+/g, '-') : 'unknown'}`;
const formatBadge = (status?: string) => <span className={statusBadgeClass(status)}>{status ? status.replace(/_/g, ' ') : 'Unknown'}</span>;
const tabBar = (active: string, tabs: string[], onChange: (name: string) => void) =>
  <div className="tabs">{tabs.map(name => <button key={name} type="button" className={active === name ? 'active' : ''} onClick={() => onChange(name)}>{name}</button>)}</div>;

const STAFF_DOC_TYPES = ['CV', 'Qualification', 'Licence', 'Certificate', 'Contract', 'Job description', 'ID', 'Reference', 'Other'];
const DECLARATION_TYPES = ['confidentiality', 'ethical_declaration', 'conflict_of_interest', 'safety_commitment', 'other'];
const ATTENDANCE_STATUSES = ['invited', 'attended', 'absent', 'excused'];
const COMPETENCY_METHODS = ['direct_observation', 'record_review', 'blind_sample', 'split_sample', 'problem_solving', 'result_interpretation', 'interview', 'other'];
const COMPETENCY_OUTCOMES = ['competent', 'competent_with_supervision', 'not_yet_competent'];
const AUTHORIZATION_LEVELS = ['View only', 'Perform', 'Review', 'Verify', 'Approve', 'Supervise', 'Train others'];

function useLookups() {
  const [staff, setStaff] = useState<Staff[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [positions, setPositions] = useState<Position[]>([]);
  useEffect(() => {
    api<Staff[]>('/staff').then(setStaff).catch(() => setStaff([]));
    api<Section[]>('/sections').then(setSections).catch(() => setSections([]));
    api<Department[]>('/departments').then(setDepartments).catch(() => setDepartments([]));
    api<Position[]>('/positions').then(setPositions).catch(() => setPositions([]));
  }, []);
  return { staff, sections, departments, positions };
}

function staffName(staffList: Staff[], id?: number | null) {
  if (!id) return '—';
  return staffList.find(s => s.id === id)?.fullName || `Staff #${id}`;
}

export function PersonnelManagementPage() {
  const { isEnabled } = useModules();
  const { staff, sections, departments, positions } = useLookups();
  const [tab, setTab] = useState('Dashboard');
  const [error, setError] = useState<string | null>(null);

  const [summary, setSummary] = useState<PersonnelSummary | null>(null);
  const [staffDocs, setStaffDocs] = useState<StaffDocument[]>([]);
  const [declarations, setDeclarations] = useState<StaffDeclaration[]>([]);
  const [trainings, setTrainings] = useState<TrainingEvent[]>([]);
  const [selectedTraining, setSelectedTraining] = useState<TrainingEvent | null>(null);
  const [competencies, setCompetencies] = useState<CompetencyAssessment[]>([]);
  const [selectedComp, setSelectedComp] = useState<CompetencyAssessment | null>(null);
  const [rosters, setRosters] = useState<DutyRoster[]>([]);
  const [selectedRoster, setSelectedRoster] = useState<DutyRoster | null>(null);
  const [myProfile, setMyProfile] = useState<MyProfile | null>(null);
  const [myTasks, setMyTasks] = useState<MyTasks | null>(null);
  const [staffSuggestions, setStaffSuggestions] = useState<StaffSuggestionsResponse | null>(null);
  const [rosterCoverage, setRosterCoverage] = useState<RosterCoverage | null>(null);

  const [docForm, setDocForm] = useState({ staffId: '', documentType: 'CV', title: '', issueDate: '', expiryDate: '', remarks: '' });
  const [docFile, setDocFile] = useState<File | null>(null);
  const [declForm, setDeclForm] = useState({ declarationType: 'confidentiality', title: '', description: '', staffId: '' });
  const [trainingForm, setTrainingForm] = useState({ title: '', description: '', trainingType: '', sectionId: '', trainerStaffId: '', trainingDate: '', startTime: '', endTime: '', location: '' });
  const [attendanceForm, setAttendanceForm] = useState({ staffId: '', attendanceStatus: 'attended', remarks: '' });
  const [compForm, setCompForm] = useState({ staffId: '', sectionId: '', activity: '', assessmentMethod: 'direct_observation', assessorStaffId: '', assessmentDate: '', findings: '', authorizationRecommendation: '' });
  const [completeForm, setCompleteForm] = useState({ outcome: 'competent', findings: '', authorizationRecommendation: '', nextAssessmentDue: '', createRetrainingAction: true });
  const [authForm, setAuthForm] = useState({ moduleKey: 'documents', level: 'Perform', expiresAt: '', positionId: '', notes: '' });
  const [rosterForm, setRosterForm] = useState({ departmentId: '', sectionId: '', rosterStartDate: '', rosterEndDate: '', notes: '' });
  const [assignForm, setAssignForm] = useState({ staffId: '', dutyDate: '', shiftName: '', startTime: '', endTime: '', dutyRole: '', notes: '' });

  async function load() {
    try {
      const [sum, sd, decl, tr, comp, rs] = await Promise.all([
        api<PersonnelSummary>('/dashboard/personnel-summary').catch(() => null),
        api<StaffDocument[]>('/personnel/staff-documents'),
        api<StaffDeclaration[]>('/personnel/declarations'),
        api<TrainingEvent[]>('/personnel/training'),
        api<CompetencyAssessment[]>('/personnel/competency'),
        api<DutyRoster[]>('/personnel/rosters')
      ]);
      if (sum) setSummary(sum);
      setStaffDocs(sd); setDeclarations(decl); setTrainings(tr); setCompetencies(comp); setRosters(rs);
    } catch (e) { setError((e as Error).message); }
  }
  useEffect(() => { if (isEnabled('personnel')) void load(); }, [isEnabled]);
  useEffect(() => {
    if (tab === 'My Profile' && isEnabled('personnel')) {
      api<MyProfile>('/personnel/my-profile').then(setMyProfile).catch((e) => setError((e as Error).message));
      api<MyTasks>('/personnel/my-tasks').then(setMyTasks).catch(() => undefined);
      api<StaffSuggestionsResponse>('/personnel/staff-suggestions').then(setStaffSuggestions).catch(() => undefined);
    }
  }, [tab, isEnabled]);
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
    } catch (e) { setError((e as Error).message); }
  }

  async function verifyStaffDoc(id: number) {
    try { await api(`/personnel/staff-documents/${id}/verify`, { method: 'POST', body: JSON.stringify({ verificationStatus: 'verified' }) }); await load(); }
    catch (e) { setError((e as Error).message); }
  }

  async function submitDeclaration(e: FormEvent) {
    e.preventDefault(); setError(null);
    try {
      await api('/personnel/declarations', { method: 'POST', body: JSON.stringify(declForm) });
      setDeclForm({ declarationType: 'confidentiality', title: '', description: '', staffId: '' });
      await load();
    } catch (e) { setError((e as Error).message); }
  }

  async function signDeclaration(id: number) {
    try { await api(`/personnel/declarations/${id}/sign`, { method: 'POST', body: JSON.stringify({}) }); await load(); }
    catch (e) { setError((e as Error).message); }
  }

  async function submitTraining(e: FormEvent) {
    e.preventDefault(); setError(null);
    try {
      await api('/personnel/training', { method: 'POST', body: JSON.stringify(trainingForm) });
      setTrainingForm({ title: '', description: '', trainingType: '', sectionId: '', trainerStaffId: '', trainingDate: '', startTime: '', endTime: '', location: '' });
      await load();
    } catch (e) { setError((e as Error).message); }
  }

  async function openTraining(id: number) {
    try { setSelectedTraining(await api<TrainingEvent>(`/personnel/training/${id}`)); }
    catch (e) { setError((e as Error).message); }
  }

  async function submitAttendance(e: FormEvent) {
    e.preventDefault(); setError(null);
    if (!selectedTraining) return;
    try {
      await api(`/personnel/training/${selectedTraining.id}/attendance`, { method: 'POST', body: JSON.stringify(attendanceForm) });
      setAttendanceForm({ staffId: '', attendanceStatus: 'attended', remarks: '' });
      await openTraining(selectedTraining.id);
    } catch (e) { setError((e as Error).message); }
  }

  async function submitCompetency(e: FormEvent) {
    e.preventDefault(); setError(null);
    try {
      await api('/personnel/competency', { method: 'POST', body: JSON.stringify(compForm) });
      setCompForm({ staffId: '', sectionId: '', activity: '', assessmentMethod: 'direct_observation', assessorStaffId: '', assessmentDate: '', findings: '', authorizationRecommendation: '' });
      await load();
    } catch (e) { setError((e as Error).message); }
  }

  async function openCompetency(id: number) {
    try { setSelectedComp(await api<CompetencyAssessment>(`/personnel/competency/${id}`)); }
    catch (e) { setError((e as Error).message); }
  }

  async function submitComplete(e: FormEvent) {
    e.preventDefault(); setError(null);
    if (!selectedComp) return;
    try {
      await api(`/personnel/competency/${selectedComp.id}/complete`, { method: 'POST', body: JSON.stringify(completeForm) });
      setCompleteForm({ outcome: 'competent', findings: '', authorizationRecommendation: '', nextAssessmentDue: '', createRetrainingAction: true });
      await openCompetency(selectedComp.id); await load();
    } catch (e) { setError((e as Error).message); }
  }

  async function submitAuth(e: FormEvent) {
    e.preventDefault(); setError(null);
    if (!selectedComp) return;
    try {
      await api(`/personnel/competency/${selectedComp.id}/create-authorization`, { method: 'POST', body: JSON.stringify(authForm) });
      setAuthForm({ moduleKey: 'documents', level: 'Perform', expiresAt: '', positionId: '', notes: '' });
      await openCompetency(selectedComp.id); await load();
    } catch (e) { setError((e as Error).message); }
  }

  async function submitRoster(e: FormEvent) {
    e.preventDefault(); setError(null);
    try {
      await api('/personnel/rosters', { method: 'POST', body: JSON.stringify(rosterForm) });
      setRosterForm({ departmentId: '', sectionId: '', rosterStartDate: '', rosterEndDate: '', notes: '' });
      await load();
    } catch (e) { setError((e as Error).message); }
  }

  async function openRoster(id: number) {
    try {
      setSelectedRoster(await api<DutyRoster>(`/personnel/rosters/${id}`));
      setRosterCoverage(await api<RosterCoverage>(`/personnel/rosters/${id}/coverage`));
    } catch (e) { setError((e as Error).message); }
  }

  async function linkMyStaff(staffId: number) {
    try {
      await api('/personnel/link-my-staff', { method: 'POST', body: JSON.stringify({ staffId }) });
      const [prof, sug] = await Promise.all([
        api<MyProfile>('/personnel/my-profile'),
        api<StaffSuggestionsResponse>('/personnel/staff-suggestions')
      ]);
      setMyProfile(prof); setStaffSuggestions(sug);
    } catch (e) { setError((e as Error).message); }
  }

  async function submitAssignment(e: FormEvent) {
    e.preventDefault(); setError(null);
    if (!selectedRoster) return;
    try {
      await api(`/personnel/rosters/${selectedRoster.id}/assignments`, { method: 'POST', body: JSON.stringify(assignForm) });
      setAssignForm({ staffId: '', dutyDate: '', shiftName: '', startTime: '', endTime: '', dutyRole: '', notes: '' });
      await openRoster(selectedRoster.id);
    } catch (e) { setError((e as Error).message); }
  }

  async function approveRoster(id: number) {
    try { await api(`/personnel/rosters/${id}/approve`, { method: 'POST', body: JSON.stringify({}) }); await load(); if (selectedRoster?.id === id) await openRoster(id); }
    catch (e) { setError((e as Error).message); }
  }

  const tabs = ['Dashboard', 'Staff Documents', 'Declarations', 'Training Events', 'Competency Assessments', 'Technical Authorizations', 'Duty Rosters', 'My Profile', 'Reports'];

  return <div className="module-page">
    <PageHeader eyebrow="People" title="Personnel Management" subtitle="Staff records, competency, training, rosters, and attestations." />
    {tabBar(tab, tabs, setTab)}
    {error && <div className="error">{error}</div>}

    {tab === 'Dashboard' && (summary ? <div className="cards">
      <div className="card"><h4>Staff docs pending verification</h4><p className="metric">{summary.staffDocumentsPendingVerification}</p></div>
      <div className="card"><h4>Certificates expiring soon</h4><p className="metric">{summary.certificatesExpiringSoon}</p></div>
      <div className="card"><h4>Pending declarations</h4><p className="metric">{summary.pendingDeclarations}</p></div>
      <div className="card"><h4>Planned training events</h4><p className="metric">{summary.plannedTrainingEvents}</p></div>
      <div className="card"><h4>Competency assessments due</h4><p className="metric">{summary.competencyAssessmentsDue}</p></div>
      <div className="card"><h4>Authorisations due review</h4><p className="metric">{summary.authorizationsDueReview}</p></div>
      <div className="card"><h4>Rosters this month</h4><p className="metric">{summary.rostersThisMonth}</p></div>
    </div> : <p>Loading summary…</p>)}
    {tab === 'Dashboard' && summary && <div className="grid cols-2" style={{ marginTop: 18 }}>
      <ChartCard title="Compliance backlog" subtitle="Personnel records needing action">
        <BarMeter data={[
          { label: 'Docs pending verification', value: summary.staffDocumentsPendingVerification, color: CHART_COLORS[0] },
          { label: 'Certificates expiring', value: summary.certificatesExpiringSoon, color: CHART_COLORS[2] },
          { label: 'Pending declarations', value: summary.pendingDeclarations, color: CHART_COLORS[4] },
          { label: 'Authorisations due', value: summary.authorizationsDueReview, color: CHART_COLORS[3] },
        ]} />
      </ChartCard>
      <ChartCard title="Training & competency" subtitle="Development and assessment activity">
        <BarChart data={[
          { label: 'Training', value: summary.plannedTrainingEvents, color: CHART_COLORS[0] },
          { label: 'Competency due', value: summary.competencyAssessmentsDue, color: CHART_COLORS[2] },
          { label: 'Rosters', value: summary.rostersThisMonth, color: CHART_COLORS[1] },
        ]} />
      </ChartCard>
    </div>}

    {tab === 'Staff Documents' && <>
      <form className="form-grid" onSubmit={submitStaffDoc}>
        <label>Staff<select value={docForm.staffId} onChange={e => setDocForm({ ...docForm, staffId: e.target.value })} required><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
        <label>Type<select value={docForm.documentType} onChange={e => setDocForm({ ...docForm, documentType: e.target.value })} required>{STAFF_DOC_TYPES.map(t => <option key={t} value={t}>{t}</option>)}</select></label>
        <label>Title<input value={docForm.title} onChange={e => setDocForm({ ...docForm, title: e.target.value })} required /></label>
        <label>Issue date<input type="date" value={docForm.issueDate} onChange={e => setDocForm({ ...docForm, issueDate: e.target.value })} /></label>
        <label>Expiry date<input type="date" value={docForm.expiryDate} onChange={e => setDocForm({ ...docForm, expiryDate: e.target.value })} /></label>
        <label>File<input type="file" onChange={e => setDocFile(e.target.files?.[0] ?? null)} /></label>
        <label>Remarks<input value={docForm.remarks} onChange={e => setDocForm({ ...docForm, remarks: e.target.value })} /></label>
        <button type="submit">Upload staff document</button>
      </form>
      <table className="data-table"><thead><tr><th>Staff</th><th>Type</th><th>Title</th><th>Issue</th><th>Expiry</th><th>Verification</th><th>File</th><th></th></tr></thead><tbody>
        {staffDocs.map(d => {
          const today = new Date().toISOString().slice(0, 10);
          const expiringSoon = d.expiry_date && d.expiry_date <= new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10) && d.expiry_date >= today;
          const expired = d.expiry_date && d.expiry_date < today;
          return <tr key={d.id}>
            <td>{d.staff_name || staffName(staff, d.staff_id)}</td><td>{d.document_type}</td><td>{d.title}</td>
            <td>{d.issue_date || '—'}</td>
            <td>{d.expiry_date || '—'} {expired && <span className="badge danger">expired</span>}{expiringSoon && <span className="badge warning">expiring</span>}</td>
            <td>{formatBadge(d.verification_status)}</td><td>{d.file_name || '—'}</td>
            <td>{d.verification_status === 'pending' && <button onClick={() => verifyStaffDoc(d.id)}>Verify</button>}</td>
          </tr>;
        })}
      </tbody></table>
    </>}

    {tab === 'Declarations' && <>
      <form className="form-grid" onSubmit={submitDeclaration}>
        <label>Type<select value={declForm.declarationType} onChange={e => setDeclForm({ ...declForm, declarationType: e.target.value })} required>{DECLARATION_TYPES.map(t => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}</select></label>
        <label>Title<input value={declForm.title} onChange={e => setDeclForm({ ...declForm, title: e.target.value })} required /></label>
        <label>Description<textarea value={declForm.description} onChange={e => setDeclForm({ ...declForm, description: e.target.value })} /></label>
        <label>Assign to staff<select value={declForm.staffId} onChange={e => setDeclForm({ ...declForm, staffId: e.target.value })}><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
        <button type="submit">Create declaration</button>
      </form>
      <table className="data-table"><thead><tr><th>Number</th><th>Type</th><th>Title</th><th>Staff</th><th>Status</th><th>Signed</th><th></th></tr></thead><tbody>
        {declarations.map(d => <tr key={d.id}>
          <td>{d.declaration_number}</td><td>{d.declaration_type.replace(/_/g, ' ')}</td><td>{d.title}</td>
          <td>{d.staff_name || staffName(staff, d.staff_id)}</td><td>{formatBadge(d.status)}</td><td>{d.signed_at || '—'}</td>
          <td>{d.status === 'pending' && <button onClick={() => signDeclaration(d.id)}>Sign</button>}</td>
        </tr>)}
      </tbody></table>
    </>}

    {tab === 'Training Events' && <>
      <form className="form-grid" onSubmit={submitTraining}>
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
      </form>
      <table className="data-table"><thead><tr><th>Number</th><th>Title</th><th>Type</th><th>Date</th><th>Status</th><th></th></tr></thead><tbody>
        {trainings.map(t => <tr key={t.id}>
          <td>{t.training_number}</td><td>{t.title}</td><td>{t.training_type || '—'}</td>
          <td>{t.training_date}</td><td>{formatBadge(t.status)}</td>
          <td><button onClick={() => openTraining(t.id)}>Open</button></td>
        </tr>)}
      </tbody></table>
      {selectedTraining && <div className="card" style={{ marginTop: 16 }}>
        <h3>{selectedTraining.training_number} — {selectedTraining.title}</h3>
        <h4>Attendance</h4>
        <table className="data-table"><thead><tr><th>Staff</th><th>Status</th><th>Signed</th><th>Remarks</th></tr></thead><tbody>
          {(selectedTraining.attendance || []).map(a => <tr key={a.id}><td>{a.staff_name || staffName(staff, a.staff_id)}</td><td>{formatBadge(a.attendance_status)}</td><td>{a.signed_at || '—'}</td><td>{a.remarks || '—'}</td></tr>)}
        </tbody></table>
        <form className="form-grid" onSubmit={submitAttendance}>
          <label>Staff<select value={attendanceForm.staffId} onChange={e => setAttendanceForm({ ...attendanceForm, staffId: e.target.value })} required><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
          <label>Status<select value={attendanceForm.attendanceStatus} onChange={e => setAttendanceForm({ ...attendanceForm, attendanceStatus: e.target.value })}>{ATTENDANCE_STATUSES.map(a => <option key={a} value={a}>{a}</option>)}</select></label>
          <label>Remarks<input value={attendanceForm.remarks} onChange={e => setAttendanceForm({ ...attendanceForm, remarks: e.target.value })} /></label>
          <button type="submit">Record attendance</button>
        </form>
        <button className="secondary" onClick={() => setSelectedTraining(null)}>Close panel</button>
      </div>}
    </>}

    {tab === 'Competency Assessments' && <>
      <form className="form-grid" onSubmit={submitCompetency}>
        <label>Staff<select value={compForm.staffId} onChange={e => setCompForm({ ...compForm, staffId: e.target.value })} required><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
        <label>Section<select value={compForm.sectionId} onChange={e => setCompForm({ ...compForm, sectionId: e.target.value })}><option value="">—</option>{sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label>Activity<input value={compForm.activity} onChange={e => setCompForm({ ...compForm, activity: e.target.value })} required /></label>
        <label>Assessment method<select value={compForm.assessmentMethod} onChange={e => setCompForm({ ...compForm, assessmentMethod: e.target.value })}>{COMPETENCY_METHODS.map(m => <option key={m} value={m}>{m.replace(/_/g, ' ')}</option>)}</select></label>
        <label>Assessor<select value={compForm.assessorStaffId} onChange={e => setCompForm({ ...compForm, assessorStaffId: e.target.value })}><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
        <label>Assessment date<input type="date" value={compForm.assessmentDate} onChange={e => setCompForm({ ...compForm, assessmentDate: e.target.value })} required /></label>
        <label>Findings<textarea value={compForm.findings} onChange={e => setCompForm({ ...compForm, findings: e.target.value })} /></label>
        <label>Authorisation recommendation<input value={compForm.authorizationRecommendation} onChange={e => setCompForm({ ...compForm, authorizationRecommendation: e.target.value })} /></label>
        <button type="submit">Create competency assessment</button>
      </form>
      <table className="data-table"><thead><tr><th>Number</th><th>Staff</th><th>Activity</th><th>Method</th><th>Date</th><th>Outcome</th><th>Status</th><th></th></tr></thead><tbody>
        {competencies.map(c => <tr key={c.id}>
          <td>{c.competency_number}</td><td>{c.staff_name || staffName(staff, c.staff_id)}</td>
          <td>{c.activity}</td><td>{c.assessment_method.replace(/_/g, ' ')}</td>
          <td>{c.assessment_date}</td><td>{formatBadge(c.outcome)}</td><td>{formatBadge(c.status)}</td>
          <td><button onClick={() => openCompetency(c.id)}>Open</button></td>
        </tr>)}
      </tbody></table>
      {selectedComp && <div className="card" style={{ marginTop: 16 }}>
        <h3>{selectedComp.competency_number} — {selectedComp.activity}</h3>
        <p>Staff: {selectedComp.staff_name || staffName(staff, selectedComp.staff_id)} | Status: {formatBadge(selectedComp.status)} | Outcome: {formatBadge(selectedComp.outcome)}</p>
        {selectedComp.status !== 'completed' && <>
          <h4>Complete assessment</h4>
          <form className="form-grid" onSubmit={submitComplete}>
            <label>Outcome<select value={completeForm.outcome} onChange={e => setCompleteForm({ ...completeForm, outcome: e.target.value })}>{COMPETENCY_OUTCOMES.map(o => <option key={o} value={o}>{o.replace(/_/g, ' ')}</option>)}</select></label>
            <label>Findings<textarea value={completeForm.findings} onChange={e => setCompleteForm({ ...completeForm, findings: e.target.value })} /></label>
            <label>Authorisation recommendation<input value={completeForm.authorizationRecommendation} onChange={e => setCompleteForm({ ...completeForm, authorizationRecommendation: e.target.value })} /></label>
            <label>Next assessment due<input type="date" value={completeForm.nextAssessmentDue} onChange={e => setCompleteForm({ ...completeForm, nextAssessmentDue: e.target.value })} /></label>
            <label><input type="checkbox" checked={completeForm.createRetrainingAction} onChange={e => setCompleteForm({ ...completeForm, createRetrainingAction: e.target.checked })} /> Auto-create retraining action if not_yet_competent</label>
            <button type="submit">Mark complete</button>
          </form>
        </>}
        {selectedComp.status === 'completed' && selectedComp.outcome !== 'not_yet_competent' && <>
          <h4>Create technical authorisation</h4>
          <form className="form-grid" onSubmit={submitAuth}>
            <label>Module key<input value={authForm.moduleKey} onChange={e => setAuthForm({ ...authForm, moduleKey: e.target.value })} required placeholder="e.g. iqc, monitoring" /></label>
            <label>Level<select value={authForm.level} onChange={e => setAuthForm({ ...authForm, level: e.target.value })}>{AUTHORIZATION_LEVELS.map(l => <option key={l} value={l}>{l}</option>)}</select></label>
            <label>Position<select value={authForm.positionId} onChange={e => setAuthForm({ ...authForm, positionId: e.target.value })}><option value="">—</option>{positions.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}</select></label>
            <label>Expires at<input type="date" value={authForm.expiresAt} onChange={e => setAuthForm({ ...authForm, expiresAt: e.target.value })} /></label>
            <label>Notes<input value={authForm.notes} onChange={e => setAuthForm({ ...authForm, notes: e.target.value })} /></label>
            <button type="submit">Grant authorisation</button>
          </form>
        </>}
        {selectedComp.links && selectedComp.links.length > 0 && <>
          <h4>Linked records</h4>
          <ul>{selectedComp.links.map(l => <li key={l.id}>{l.source_module_key}/{l.source_record_type}#{l.source_record_id} → {l.target_module_key}/{l.target_record_type}#{l.target_record_id}{l.notes ? ` — ${l.notes}` : ''}</li>)}</ul>
        </>}
        <button className="secondary" onClick={() => setSelectedComp(null)}>Close panel</button>
      </div>}
    </>}

    {tab === 'Technical Authorizations' && <p>Technical authorisations are created from completed competency assessments via the Competency Assessments tab. They appear on each staff member's profile under <em>My Profile</em>.</p>}

    {tab === 'Duty Rosters' && <>
      <form className="form-grid" onSubmit={submitRoster}>
        <label>Department<select value={rosterForm.departmentId} onChange={e => setRosterForm({ ...rosterForm, departmentId: e.target.value })}><option value="">—</option>{departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
        <label>Section<select value={rosterForm.sectionId} onChange={e => setRosterForm({ ...rosterForm, sectionId: e.target.value })}><option value="">—</option>{sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label>Start date<input type="date" value={rosterForm.rosterStartDate} onChange={e => setRosterForm({ ...rosterForm, rosterStartDate: e.target.value })} required /></label>
        <label>End date<input type="date" value={rosterForm.rosterEndDate} onChange={e => setRosterForm({ ...rosterForm, rosterEndDate: e.target.value })} required /></label>
        <label>Notes<textarea value={rosterForm.notes} onChange={e => setRosterForm({ ...rosterForm, notes: e.target.value })} /></label>
        <button type="submit">Create roster</button>
      </form>
      <table className="data-table"><thead><tr><th>Number</th><th>Section</th><th>Period</th><th>Status</th><th></th></tr></thead><tbody>
        {rosters.map(r => <tr key={r.id}>
          <td>{r.roster_number}</td><td>{sections.find(s => s.id === r.section_id)?.name || '—'}</td>
          <td>{r.roster_start_date} → {r.roster_end_date}</td><td>{formatBadge(r.status)}</td>
          <td><button onClick={() => openRoster(r.id)}>Open</button>{r.status !== 'approved' && <button onClick={() => approveRoster(r.id)}>Approve</button>}</td>
        </tr>)}
      </tbody></table>
      {selectedRoster && <div className="card" style={{ marginTop: 16 }}>
        <h3>{selectedRoster.roster_number}</h3>
        <p>Period: {selectedRoster.roster_start_date} → {selectedRoster.roster_end_date} | Status: {formatBadge(selectedRoster.status)}</p>
        {rosterCoverage && <div className="cards">
          <div className="card"><h4>Days covered</h4><p className="metric">{rosterCoverage.coveredDates}/{rosterCoverage.totalDates}</p></div>
          <div className="card"><h4>Gap days</h4><p className="metric">{rosterCoverage.gapDates.length}</p>{rosterCoverage.gapDates.length > 0 && <small>{rosterCoverage.gapDates.slice(0, 5).join(', ')}{rosterCoverage.gapDates.length > 5 ? '…' : ''}</small>}</div>
          <div className="card"><h4>Time conflicts</h4><p className="metric">{rosterCoverage.conflicts.length}</p>{rosterCoverage.conflicts.length > 0 && <small>{rosterCoverage.conflicts.slice(0, 3).map(c => `${c.duty_date} staff #${c.staff_id}`).join('; ')}</small>}</div>
        </div>}
        <table className="data-table"><thead><tr><th>Date</th><th>Staff</th><th>Shift</th><th>Hours</th><th>Role</th><th>Notes</th></tr></thead><tbody>
          {(selectedRoster.assignments || []).map(a => <tr key={a.id}><td>{a.duty_date}</td><td>{a.staff_name || staffName(staff, a.staff_id)}</td><td>{a.shift_name || '—'}</td><td>{a.start_time || '—'} – {a.end_time || '—'}</td><td>{a.duty_role || '—'}</td><td>{a.notes || '—'}</td></tr>)}
        </tbody></table>
        <form className="form-grid" onSubmit={submitAssignment}>
          <label>Staff<select value={assignForm.staffId} onChange={e => setAssignForm({ ...assignForm, staffId: e.target.value })} required><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
          <label>Duty date<input type="date" value={assignForm.dutyDate} onChange={e => setAssignForm({ ...assignForm, dutyDate: e.target.value })} required /></label>
          <label>Shift name<input value={assignForm.shiftName} onChange={e => setAssignForm({ ...assignForm, shiftName: e.target.value })} placeholder="e.g. Morning, Night" /></label>
          <label>Start time<input type="time" value={assignForm.startTime} onChange={e => setAssignForm({ ...assignForm, startTime: e.target.value })} /></label>
          <label>End time<input type="time" value={assignForm.endTime} onChange={e => setAssignForm({ ...assignForm, endTime: e.target.value })} /></label>
          <label>Duty role<input value={assignForm.dutyRole} onChange={e => setAssignForm({ ...assignForm, dutyRole: e.target.value })} placeholder="e.g. Bench, Phlebotomy" /></label>
          <label>Notes<input value={assignForm.notes} onChange={e => setAssignForm({ ...assignForm, notes: e.target.value })} /></label>
          <button type="submit">Add assignment</button>
        </form>
        <button className="secondary" onClick={() => setSelectedRoster(null)}>Close panel</button>
      </div>}
    </>}

    {tab === 'My Profile' && <>
      {myProfile && <div className="card">
        <h3>{myProfile.staff?.fullName || myProfile.user.fullName}</h3>
        {!myProfile.staff && <>
          <p className="error">Your user account is not linked to a staff record. You need a link before signing attestations or declarations.</p>
          {staffSuggestions && staffSuggestions.suggestions.length > 0 && <>
            <h4>Candidate staff records</h4>
            <table className="data-table"><thead><tr><th>Staff</th><th>Email</th><th>Section</th><th></th></tr></thead><tbody>
              {staffSuggestions.suggestions.map(s => <tr key={s.id}>
                <td>{s.full_name}{s.employee_no ? ` (${s.employee_no})` : ''}</td>
                <td>{s.email || '—'}</td><td>{s.section_name || '—'}</td>
                <td>{s.already_taken ? <em>linked to another user</em> : <button onClick={() => linkMyStaff(s.id)}>Link to me</button>}</td>
              </tr>)}
            </tbody></table>
            <small>Self-link only succeeds when your account's full name or username/email exactly matches the candidate. Otherwise an administrator must link you.</small>
          </>}
          {staffSuggestions && staffSuggestions.suggestions.length === 0 && <p>No matching staff records found. Ask an administrator to create your staff record and link your account.</p>}
        </>}
        {myProfile.staff && <p>Employee #: {myProfile.staff.employeeNo || '—'} | Section: {myProfile.staff.section_name || '—'}</p>}
        {myProfile.positions.length > 0 && <p>Positions: {myProfile.positions.map(p => `${p.title}${p.is_active ? '' : ' (inactive)'}`).join(', ')}</p>}
        {myProfile.authorizations.length > 0 && <>
          <h4>Active technical authorisations</h4>
          <table className="data-table"><thead><tr><th>Module</th><th>Level</th><th>Expires</th><th>Notes</th></tr></thead><tbody>
            {myProfile.authorizations.map(a => <tr key={a.id}><td>{a.module_key}</td><td>{a.level}</td><td>{a.expires_at || '—'}</td><td>{a.notes || '—'}</td></tr>)}
          </tbody></table>
        </>}
      </div>}
      {myTasks && <>
        <div className="cards">
          <div className="card"><h4>Pending attestations</h4><p className="metric">{myTasks.pendingAttestations.length}</p></div>
          <div className="card"><h4>Pending declarations</h4><p className="metric">{myTasks.pendingDeclarations.length}</p></div>
          <div className="card"><h4>Upcoming training</h4><p className="metric">{myTasks.upcomingTraining.length}</p></div>
          <div className="card"><h4>Upcoming competency</h4><p className="metric">{myTasks.upcomingCompetency.length}</p></div>
          <div className="card"><h4>Assigned actions</h4><p className="metric">{myTasks.assignedActions.length}</p></div>
          <div className="card"><h4>Upcoming duties</h4><p className="metric">{myTasks.upcomingDuties.length}</p></div>
        </div>
        {myTasks.upcomingDuties.length > 0 && <>
          <h4>Upcoming duties</h4>
          <table className="data-table"><thead><tr><th>Roster</th><th>Date</th><th>Shift</th><th>Hours</th><th>Role</th></tr></thead><tbody>
            {myTasks.upcomingDuties.map(a => <tr key={a.id}><td>{a.roster_number || '—'}</td><td>{a.duty_date}</td><td>{a.shift_name || '—'}</td><td>{a.start_time || '—'} – {a.end_time || '—'}</td><td>{a.duty_role || '—'}</td></tr>)}
          </tbody></table>
        </>}
      </>}
    </>}

    {tab === 'Reports' && <p>Personnel reports (training hours per staff, competency coverage, authorisation expiry trend) will be added in a later phase.</p>}
  </div>;
}
