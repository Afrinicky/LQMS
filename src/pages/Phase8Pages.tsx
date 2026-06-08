import { FormEvent, useEffect, useState } from 'react';
import { useModules } from '../hooks/useModules';
import { api } from '../services/api';
import DisabledModule from '../components/DisabledModule';
import type {
  Section, Department, Staff,
  AssessmentProgram, AssessmentFinding,
  Meeting, MeetingAttendance,
  ManagementReview, ManagementReviewInput,
  QualityIndicator, QualityIndicatorResult,
  ImprovementProject, ImprovementUpdate,
  GovernanceSummary
} from '../../shared/types/api';

const statusBadgeClass = (status?: string) => `badge ${status ? status.toLowerCase().replace(/\s+/g, '-') : 'unknown'}`;
const formatBadge = (status?: string) => <span className={statusBadgeClass(status)}>{status ? status.replace(/_/g, ' ') : 'Unknown'}</span>;
const tabBar = (active: string, tabs: string[], onChange: (name: string) => void) =>
  <div className="tabs">{tabs.map(name => <button key={name} type="button" className={active === name ? 'active' : ''} onClick={() => onChange(name)}>{name}</button>)}</div>;

const ASSESSMENT_TYPES = ['internal_audit', 'self_assessment', 'gap_review', 'peer_review', 'other'];
const FINDING_TYPES = ['observation', 'nonconformity', 'improvement_opportunity', 'risk'];
const MEETING_TYPES = ['quality_meeting', 'section_meeting', 'safety_meeting', 'management_review', 'other'];
const ATTENDANCE_STATUSES = ['invited', 'present', 'absent', 'excused'];
const FREQUENCIES = ['daily', 'weekly', 'monthly', 'quarterly', 'biannual', 'annual'];
const IMPROVEMENT_AREAS = ['pre_analytical', 'analytical', 'post_analytical', 'turnaround_time', 'safety', 'customer_service', 'staff_competency', 'other'];

function useLookups() {
  const [staff, setStaff] = useState<Staff[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  useEffect(() => {
    api<Staff[]>('/staff').then(setStaff).catch(() => setStaff([]));
    api<Section[]>('/sections').then(setSections).catch(() => setSections([]));
    api<Department[]>('/departments').then(setDepartments).catch(() => setDepartments([]));
  }, []);
  return { staff, sections, departments };
}

function staffName(staffList: Staff[], id?: number | null) {
  if (!id) return '—';
  return staffList.find(s => s.id === id)?.fullName || `Staff #${id}`;
}

function useGovernanceSummary() {
  const [s, setS] = useState<GovernanceSummary | null>(null);
  useEffect(() => { api<GovernanceSummary>('/dashboard/governance-summary').then(setS).catch(() => undefined); }, []);
  return s;
}

function dashboardCards(s: GovernanceSummary | null, keys: Array<{ label: string; value: keyof GovernanceSummary }>) {
  if (!s) return <p>Loading summary…</p>;
  return <div className="cards">{keys.map(k => <div key={k.value} className="card"><h4>{k.label}</h4><p className="metric">{s[k.value]}</p></div>)}</div>;
}

// ============= Assessments =============
export function AssessmentsPage() {
  const { isEnabled } = useModules();
  const { staff, sections, departments } = useLookups();
  const summary = useGovernanceSummary();
  const [tab, setTab] = useState('Dashboard');
  const [error, setError] = useState<string | null>(null);
  const [programs, setPrograms] = useState<AssessmentProgram[]>([]);
  const [findings, setFindings] = useState<AssessmentFinding[]>([]);
  const [selected, setSelected] = useState<(AssessmentProgram & { findings?: AssessmentFinding[] }) | null>(null);
  const [progForm, setProgForm] = useState({ title: '', assessmentType: 'internal_audit', departmentId: '', sectionId: '', plannedStartDate: '', plannedEndDate: '', leadAssessorStaffId: '', scope: '', objectives: '' });
  const [findForm, setFindForm] = useState({ findingType: 'observation', findingDate: '', title: '', description: '', severity: 'medium', evidenceSummary: '', responsibleStaffId: '' });

  async function load() {
    try {
      setPrograms(await api<AssessmentProgram[]>('/assessments'));
      setFindings(await api<AssessmentFinding[]>('/assessments/findings'));
    } catch (e) { setError((e as Error).message); }
  }
  useEffect(() => { if (isEnabled('assessments')) void load(); }, [isEnabled]);
  if (!isEnabled('assessments')) return <DisabledModule />;

  async function submitProgram(e: FormEvent) {
    e.preventDefault(); setError(null);
    try {
      await api('/assessments', { method: 'POST', body: JSON.stringify(progForm) });
      setProgForm({ title: '', assessmentType: 'internal_audit', departmentId: '', sectionId: '', plannedStartDate: '', plannedEndDate: '', leadAssessorStaffId: '', scope: '', objectives: '' });
      await load(); setTab('Assessment Programmes');
    } catch (e) { setError((e as Error).message); }
  }
  async function open(id: number) { try { setSelected(await api<AssessmentProgram>(`/assessments/${id}`)); } catch (e) { setError((e as Error).message); } }
  async function submitFinding(e: FormEvent) {
    e.preventDefault(); setError(null);
    if (!selected) return;
    try { await api(`/assessments/${selected.id}/findings`, { method: 'POST', body: JSON.stringify(findForm) }); setFindForm({ findingType: 'observation', findingDate: '', title: '', description: '', severity: 'medium', evidenceSummary: '', responsibleStaffId: '' }); await open(selected.id); await load(); }
    catch (e) { setError((e as Error).message); }
  }
  async function createNc(id: number) { try { await api(`/assessments/findings/${id}/create-nc`, { method: 'POST', body: JSON.stringify({}) }); await load(); if (selected) await open(selected.id); } catch (e) { setError((e as Error).message); } }
  async function createCapa(id: number) { try { await api(`/assessments/findings/${id}/create-capa`, { method: 'POST', body: JSON.stringify({}) }); await load(); if (selected) await open(selected.id); } catch (e) { setError((e as Error).message); } }
  async function closeFinding(id: number) { try { await api(`/assessments/findings/${id}/close`, { method: 'POST', body: JSON.stringify({}) }); await load(); if (selected) await open(selected.id); } catch (e) { setError((e as Error).message); } }

  const tabs = ['Dashboard', 'Assessment Programmes', 'New Assessment', 'Findings', 'Reports'];
  return <div className="module-page">
    <h2>Internal Assessments</h2>
    {tabBar(tab, tabs, setTab)}
    {error && <div className="error">{error}</div>}

    {tab === 'Dashboard' && dashboardCards(summary, [
      { label: 'Planned/active assessments', value: 'plannedAssessments' },
      { label: 'Open findings', value: 'openFindings' }
    ])}

    {tab === 'Assessment Programmes' && <>
      <table className="data-table"><thead><tr><th>Number</th><th>Title</th><th>Type</th><th>Start</th><th>Lead</th><th>Status</th><th></th></tr></thead><tbody>
        {programs.map(p => <tr key={p.id}><td>{p.program_number}</td><td>{p.title}</td><td>{p.assessment_type.replace(/_/g, ' ')}</td><td>{p.planned_start_date}</td><td>{staffName(staff, p.lead_assessor_staff_id)}</td><td>{formatBadge(p.status)}</td><td><button onClick={() => open(p.id)}>Open</button></td></tr>)}
      </tbody></table>
      {selected && <div className="card" style={{ marginTop: 16 }}>
        <h3>{selected.program_number} — {selected.title}</h3>
        <p>Type: {selected.assessment_type.replace(/_/g, ' ')} | Status: {formatBadge(selected.status)} | Lead: {staffName(staff, selected.lead_assessor_staff_id)}</p>
        {selected.scope && <p><strong>Scope:</strong> {selected.scope}</p>}
        {selected.objectives && <p><strong>Objectives:</strong> {selected.objectives}</p>}
        <h4>Findings</h4>
        <table className="data-table"><thead><tr><th>Number</th><th>Date</th><th>Type</th><th>Title</th><th>Severity</th><th>Status</th><th></th></tr></thead><tbody>
          {(selected.findings || []).map(f => <tr key={f.id}><td>{f.finding_number}</td><td>{f.finding_date}</td><td>{f.finding_type.replace(/_/g, ' ')}</td><td>{f.title}</td><td>{formatBadge(f.severity)}</td><td>{formatBadge(f.status)}</td><td>{!f.nc_id && <button onClick={() => createNc(f.id)}>NC</button>}{!f.capa_id && <button onClick={() => createCapa(f.id)}>CAPA</button>}{f.status !== 'closed' && <button onClick={() => closeFinding(f.id)}>Close</button>}</td></tr>)}
        </tbody></table>
        <form className="form-grid" onSubmit={submitFinding}>
          <label>Type<select value={findForm.findingType} onChange={e => setFindForm({ ...findForm, findingType: e.target.value })}>{FINDING_TYPES.map(t => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}</select></label>
          <label>Date<input type="date" value={findForm.findingDate} onChange={e => setFindForm({ ...findForm, findingDate: e.target.value })} /></label>
          <label>Title<input value={findForm.title} onChange={e => setFindForm({ ...findForm, title: e.target.value })} required /></label>
          <label>Severity<input value={findForm.severity} onChange={e => setFindForm({ ...findForm, severity: e.target.value })} /></label>
          <label>Description<textarea value={findForm.description} onChange={e => setFindForm({ ...findForm, description: e.target.value })} required /></label>
          <label>Evidence summary<textarea value={findForm.evidenceSummary} onChange={e => setFindForm({ ...findForm, evidenceSummary: e.target.value })} /></label>
          <label>Responsible<select value={findForm.responsibleStaffId} onChange={e => setFindForm({ ...findForm, responsibleStaffId: e.target.value })}><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
          <button type="submit">Add finding</button>
        </form>
        <button className="secondary" onClick={() => setSelected(null)}>Close panel</button>
      </div>}
    </>}

    {tab === 'New Assessment' && <form className="form-grid" onSubmit={submitProgram}>
      <label>Title<input value={progForm.title} onChange={e => setProgForm({ ...progForm, title: e.target.value })} required /></label>
      <label>Type<select value={progForm.assessmentType} onChange={e => setProgForm({ ...progForm, assessmentType: e.target.value })}>{ASSESSMENT_TYPES.map(t => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}</select></label>
      <label>Department<select value={progForm.departmentId} onChange={e => setProgForm({ ...progForm, departmentId: e.target.value })}><option value="">—</option>{departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
      <label>Section<select value={progForm.sectionId} onChange={e => setProgForm({ ...progForm, sectionId: e.target.value })}><option value="">—</option>{sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
      <label>Planned start<input type="date" value={progForm.plannedStartDate} onChange={e => setProgForm({ ...progForm, plannedStartDate: e.target.value })} required /></label>
      <label>Planned end<input type="date" value={progForm.plannedEndDate} onChange={e => setProgForm({ ...progForm, plannedEndDate: e.target.value })} /></label>
      <label>Lead assessor<select value={progForm.leadAssessorStaffId} onChange={e => setProgForm({ ...progForm, leadAssessorStaffId: e.target.value })}><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
      <label>Scope<textarea value={progForm.scope} onChange={e => setProgForm({ ...progForm, scope: e.target.value })} /></label>
      <label>Objectives<textarea value={progForm.objectives} onChange={e => setProgForm({ ...progForm, objectives: e.target.value })} /></label>
      <button type="submit">Create assessment</button>
    </form>}

    {tab === 'Findings' && <table className="data-table"><thead><tr><th>Number</th><th>Programme</th><th>Date</th><th>Type</th><th>Title</th><th>Status</th><th></th></tr></thead><tbody>
      {findings.map(f => <tr key={f.id}><td>{f.finding_number}</td><td>{f.program_number || f.assessment_program_id}</td><td>{f.finding_date}</td><td>{f.finding_type.replace(/_/g, ' ')}</td><td>{f.title}</td><td>{formatBadge(f.status)}</td><td>{!f.nc_id && <button onClick={() => createNc(f.id)}>NC</button>}{!f.capa_id && <button onClick={() => createCapa(f.id)}>CAPA</button>}</td></tr>)}
    </tbody></table>}

    {tab === 'Reports' && <p>Assessment outcome reports and trend dashboards will be added in a later phase.</p>}
  </div>;
}

// ============= Meetings =============
export function MeetingsPage() {
  const { isEnabled } = useModules();
  const { staff } = useLookups();
  const summary = useGovernanceSummary();
  const [tab, setTab] = useState('Dashboard');
  const [error, setError] = useState<string | null>(null);
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [selected, setSelected] = useState<Meeting | null>(null);
  const [form, setForm] = useState({ meetingType: 'quality_meeting', title: '', meetingDate: '', startTime: '', endTime: '', location: '', chairStaffId: '', secretaryStaffId: '', agenda: '', minutes: '' });
  const [attForm, setAttForm] = useState({ staffId: '', attendanceStatus: 'present', remarks: '' });
  const [actForm, setActForm] = useState({ title: '', description: '', assignedToStaffId: '', dueDate: '', priority: 'normal' });

  async function load() { try { setMeetings(await api<Meeting[]>('/meetings')); } catch (e) { setError((e as Error).message); } }
  useEffect(() => { if (isEnabled('meetings')) void load(); }, [isEnabled]);
  if (!isEnabled('meetings')) return <DisabledModule />;

  async function submit(e: FormEvent) {
    e.preventDefault(); setError(null);
    try { await api('/meetings', { method: 'POST', body: JSON.stringify(form) }); setForm({ meetingType: 'quality_meeting', title: '', meetingDate: '', startTime: '', endTime: '', location: '', chairStaffId: '', secretaryStaffId: '', agenda: '', minutes: '' }); await load(); setTab('Meetings'); }
    catch (e) { setError((e as Error).message); }
  }
  async function open(id: number) { try { setSelected(await api<Meeting>(`/meetings/${id}`)); } catch (e) { setError((e as Error).message); } }
  async function submitAtt(e: FormEvent) { e.preventDefault(); setError(null); if (!selected) return; try { await api(`/meetings/${selected.id}/attendance`, { method: 'POST', body: JSON.stringify(attForm) }); setAttForm({ staffId: '', attendanceStatus: 'present', remarks: '' }); await open(selected.id); } catch (e) { setError((e as Error).message); } }
  async function submitAct(e: FormEvent) { e.preventDefault(); setError(null); if (!selected) return; try { await api(`/meetings/${selected.id}/create-action`, { method: 'POST', body: JSON.stringify(actForm) }); setActForm({ title: '', description: '', assignedToStaffId: '', dueDate: '', priority: 'normal' }); await open(selected.id); } catch (e) { setError((e as Error).message); } }
  async function closeMtg(id: number) { try { await api(`/meetings/${id}/close`, { method: 'POST', body: JSON.stringify({}) }); await load(); if (selected) await open(id); } catch (e) { setError((e as Error).message); } }

  const tabs = ['Dashboard', 'Meetings', 'New Meeting', 'Attendance', 'Action Items', 'Reports'];
  return <div className="module-page">
    <h2>Meetings & Minutes</h2>
    {tabBar(tab, tabs, setTab)}
    {error && <div className="error">{error}</div>}

    {tab === 'Dashboard' && dashboardCards(summary, [{ label: 'Open meetings', value: 'openMeetings' }])}

    {tab === 'Meetings' && <>
      <table className="data-table"><thead><tr><th>Number</th><th>Type</th><th>Title</th><th>Date</th><th>Status</th><th></th></tr></thead><tbody>
        {meetings.map(m => <tr key={m.id}><td>{m.meeting_number}</td><td>{m.meeting_type.replace(/_/g, ' ')}</td><td>{m.title}</td><td>{m.meeting_date}</td><td>{formatBadge(m.status)}</td><td><button onClick={() => open(m.id)}>Open</button>{m.status !== 'closed' && <button onClick={() => closeMtg(m.id)}>Close</button>}</td></tr>)}
      </tbody></table>
      {selected && <div className="card" style={{ marginTop: 16 }}>
        <h3>{selected.meeting_number} — {selected.title}</h3>
        <p>Date: {selected.meeting_date} | Chair: {staffName(staff, selected.chair_staff_id)} | Secretary: {staffName(staff, selected.secretary_staff_id)}</p>
        {selected.agenda && <p><strong>Agenda:</strong> {selected.agenda}</p>}
        {selected.minutes && <p><strong>Minutes:</strong> {selected.minutes}</p>}
        <h4>Attendance</h4>
        <table className="data-table"><thead><tr><th>Staff</th><th>Status</th><th>Signed</th><th>Remarks</th></tr></thead><tbody>
          {(selected.attendance || []).map((a: MeetingAttendance) => <tr key={a.id}><td>{a.staff_name || staffName(staff, a.staff_id)}</td><td>{formatBadge(a.attendance_status)}</td><td>{a.signed_at || '—'}</td><td>{a.remarks || '—'}</td></tr>)}
        </tbody></table>
        <form className="form-grid" onSubmit={submitAtt}>
          <label>Staff<select value={attForm.staffId} onChange={e => setAttForm({ ...attForm, staffId: e.target.value })} required><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
          <label>Status<select value={attForm.attendanceStatus} onChange={e => setAttForm({ ...attForm, attendanceStatus: e.target.value })}>{ATTENDANCE_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}</select></label>
          <label>Remarks<input value={attForm.remarks} onChange={e => setAttForm({ ...attForm, remarks: e.target.value })} /></label>
          <button type="submit">Record attendance</button>
        </form>
        <h4>Action items</h4>
        <table className="data-table"><thead><tr><th>Title</th><th>Status</th><th>Assigned</th><th>Due</th></tr></thead><tbody>
          {(selected.actions || []).map(a => <tr key={a.id}><td>{a.title}</td><td>{formatBadge(a.status)}</td><td>{staffName(staff, a.assigned_to_staff_id)}</td><td>{a.due_date || '—'}</td></tr>)}
        </tbody></table>
        <form className="form-grid" onSubmit={submitAct}>
          <label>Action title<input value={actForm.title} onChange={e => setActForm({ ...actForm, title: e.target.value })} required /></label>
          <label>Description<textarea value={actForm.description} onChange={e => setActForm({ ...actForm, description: e.target.value })} /></label>
          <label>Assigned to<select value={actForm.assignedToStaffId} onChange={e => setActForm({ ...actForm, assignedToStaffId: e.target.value })}><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
          <label>Due date<input type="date" value={actForm.dueDate} onChange={e => setActForm({ ...actForm, dueDate: e.target.value })} /></label>
          <button type="submit">Create action</button>
        </form>
        <button className="secondary" onClick={() => setSelected(null)}>Close panel</button>
      </div>}
    </>}

    {tab === 'New Meeting' && <form className="form-grid" onSubmit={submit}>
      <label>Type<select value={form.meetingType} onChange={e => setForm({ ...form, meetingType: e.target.value })}>{MEETING_TYPES.map(t => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}</select></label>
      <label>Title<input value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} required /></label>
      <label>Date<input type="date" value={form.meetingDate} onChange={e => setForm({ ...form, meetingDate: e.target.value })} required /></label>
      <label>Start<input type="time" value={form.startTime} onChange={e => setForm({ ...form, startTime: e.target.value })} /></label>
      <label>End<input type="time" value={form.endTime} onChange={e => setForm({ ...form, endTime: e.target.value })} /></label>
      <label>Location<input value={form.location} onChange={e => setForm({ ...form, location: e.target.value })} /></label>
      <label>Chair<select value={form.chairStaffId} onChange={e => setForm({ ...form, chairStaffId: e.target.value })}><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
      <label>Secretary<select value={form.secretaryStaffId} onChange={e => setForm({ ...form, secretaryStaffId: e.target.value })}><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
      <label>Agenda<textarea value={form.agenda} onChange={e => setForm({ ...form, agenda: e.target.value })} /></label>
      <label>Minutes<textarea value={form.minutes} onChange={e => setForm({ ...form, minutes: e.target.value })} /></label>
      <button type="submit">Create meeting</button>
    </form>}

    {tab === 'Attendance' && <p>Open a meeting to record attendance and add action items.</p>}
    {tab === 'Action Items' && <p>Action items raised in meetings appear inside the meeting detail panel and in the shared Action Tracker.</p>}
    {tab === 'Reports' && <p>Meeting cadence reports will be added in a later phase.</p>}
  </div>;
}

// ============= Management Review =============
export function ManagementReviewPage() {
  const { isEnabled } = useModules();
  const { staff } = useLookups();
  const summary = useGovernanceSummary();
  const [tab, setTab] = useState('Dashboard');
  const [error, setError] = useState<string | null>(null);
  const [reviews, setReviews] = useState<ManagementReview[]>([]);
  const [selected, setSelected] = useState<ManagementReview | null>(null);
  const [form, setForm] = useState({ reviewPeriodStart: '', reviewPeriodEnd: '', reviewDate: '', chairStaffId: '', secretaryStaffId: '', summary: '', conclusions: '', decisions: '' });
  const [inputForm, setInputForm] = useState({ inputArea: '', summary: '', issues: '', actionsRequired: '' });
  const [actForm, setActForm] = useState({ title: '', description: '', assignedToStaffId: '', dueDate: '', priority: 'normal' });

  async function load() { try { setReviews(await api<ManagementReview[]>('/management-review')); } catch (e) { setError((e as Error).message); } }
  useEffect(() => { if (isEnabled('management_review')) void load(); }, [isEnabled]);
  if (!isEnabled('management_review')) return <DisabledModule />;

  async function submit(e: FormEvent) { e.preventDefault(); setError(null); try { await api('/management-review', { method: 'POST', body: JSON.stringify(form) }); setForm({ reviewPeriodStart: '', reviewPeriodEnd: '', reviewDate: '', chairStaffId: '', secretaryStaffId: '', summary: '', conclusions: '', decisions: '' }); await load(); setTab('Review Register'); } catch (e) { setError((e as Error).message); } }
  async function open(id: number) { try { setSelected(await api<ManagementReview>(`/management-review/${id}`)); } catch (e) { setError((e as Error).message); } }
  async function generate(id: number) { try { await api(`/management-review/${id}/generate-inputs`, { method: 'POST', body: JSON.stringify({}) }); await open(id); } catch (e) { setError((e as Error).message); } }
  async function addInput(e: FormEvent) { e.preventDefault(); setError(null); if (!selected) return; try { await api(`/management-review/${selected.id}/add-input`, { method: 'POST', body: JSON.stringify(inputForm) }); setInputForm({ inputArea: '', summary: '', issues: '', actionsRequired: '' }); await open(selected.id); } catch (e) { setError((e as Error).message); } }
  async function addAction(e: FormEvent) { e.preventDefault(); setError(null); if (!selected) return; try { await api(`/management-review/${selected.id}/create-action`, { method: 'POST', body: JSON.stringify(actForm) }); setActForm({ title: '', description: '', assignedToStaffId: '', dueDate: '', priority: 'normal' }); await open(selected.id); } catch (e) { setError((e as Error).message); } }
  async function approve(id: number) { try { await api(`/management-review/${id}/approve`, { method: 'POST', body: JSON.stringify({}) }); await load(); if (selected) await open(id); } catch (e) { setError((e as Error).message); } }
  async function closeReview(id: number) { try { await api(`/management-review/${id}/close`, { method: 'POST', body: JSON.stringify({}) }); await load(); if (selected) await open(id); } catch (e) { setError((e as Error).message); } }

  const tabs = ['Dashboard', 'Review Register', 'New Review', 'Inputs', 'Actions', 'Reports'];
  return <div className="module-page">
    <h2>Management Review</h2>
    {tabBar(tab, tabs, setTab)}
    {error && <div className="error">{error}</div>}

    {tab === 'Dashboard' && dashboardCards(summary, [{ label: 'Pending management reviews', value: 'pendingManagementReviews' }])}

    {tab === 'Review Register' && <>
      <table className="data-table"><thead><tr><th>Number</th><th>Period</th><th>Date</th><th>Chair</th><th>Status</th><th></th></tr></thead><tbody>
        {reviews.map(r => <tr key={r.id}><td>{r.review_number}</td><td>{r.review_period_start} → {r.review_period_end}</td><td>{r.review_date}</td><td>{staffName(staff, r.chair_staff_id)}</td><td>{formatBadge(r.status)}</td><td><button onClick={() => open(r.id)}>Open</button>{r.status !== 'approved' && r.status !== 'closed' && <button onClick={() => approve(r.id)}>Approve</button>}{r.status !== 'closed' && <button onClick={() => closeReview(r.id)}>Close</button>}</td></tr>)}
      </tbody></table>
      {selected && <div className="card" style={{ marginTop: 16 }}>
        <h3>{selected.review_number}</h3>
        <p>Period: {selected.review_period_start} → {selected.review_period_end} | Date: {selected.review_date} | Status: {formatBadge(selected.status)}</p>
        {selected.summary && <p><strong>Summary:</strong> {selected.summary}</p>}
        {selected.conclusions && <p><strong>Conclusions:</strong> {selected.conclusions}</p>}
        {selected.decisions && <p><strong>Decisions:</strong> {selected.decisions}</p>}
        <button onClick={() => generate(selected.id)}>Generate inputs from modules</button>
        <h4>Inputs</h4>
        <table className="data-table"><thead><tr><th>Area</th><th>Source</th><th>Summary</th><th>Issues</th><th>Actions required</th></tr></thead><tbody>
          {(selected.inputs || []).map((i: ManagementReviewInput) => <tr key={i.id}><td>{i.input_area}</td><td>{i.source_module || '—'}</td><td>{i.summary || '—'}</td><td>{i.issues || '—'}</td><td>{i.actions_required || '—'}</td></tr>)}
        </tbody></table>
        <form className="form-grid" onSubmit={addInput}>
          <label>Area<input value={inputForm.inputArea} onChange={e => setInputForm({ ...inputForm, inputArea: e.target.value })} required /></label>
          <label>Summary<textarea value={inputForm.summary} onChange={e => setInputForm({ ...inputForm, summary: e.target.value })} /></label>
          <label>Issues<textarea value={inputForm.issues} onChange={e => setInputForm({ ...inputForm, issues: e.target.value })} /></label>
          <label>Actions required<textarea value={inputForm.actionsRequired} onChange={e => setInputForm({ ...inputForm, actionsRequired: e.target.value })} /></label>
          <button type="submit">Add input</button>
        </form>
        <h4>Add action</h4>
        <form className="form-grid" onSubmit={addAction}>
          <label>Title<input value={actForm.title} onChange={e => setActForm({ ...actForm, title: e.target.value })} required /></label>
          <label>Description<textarea value={actForm.description} onChange={e => setActForm({ ...actForm, description: e.target.value })} /></label>
          <label>Assigned to<select value={actForm.assignedToStaffId} onChange={e => setActForm({ ...actForm, assignedToStaffId: e.target.value })}><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
          <label>Due<input type="date" value={actForm.dueDate} onChange={e => setActForm({ ...actForm, dueDate: e.target.value })} /></label>
          <button type="submit">Create action</button>
        </form>
        <button className="secondary" onClick={() => setSelected(null)}>Close panel</button>
      </div>}
    </>}

    {tab === 'New Review' && <form className="form-grid" onSubmit={submit}>
      <label>Period start<input type="date" value={form.reviewPeriodStart} onChange={e => setForm({ ...form, reviewPeriodStart: e.target.value })} required /></label>
      <label>Period end<input type="date" value={form.reviewPeriodEnd} onChange={e => setForm({ ...form, reviewPeriodEnd: e.target.value })} required /></label>
      <label>Review date<input type="date" value={form.reviewDate} onChange={e => setForm({ ...form, reviewDate: e.target.value })} required /></label>
      <label>Chair<select value={form.chairStaffId} onChange={e => setForm({ ...form, chairStaffId: e.target.value })}><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
      <label>Secretary<select value={form.secretaryStaffId} onChange={e => setForm({ ...form, secretaryStaffId: e.target.value })}><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
      <label>Summary<textarea value={form.summary} onChange={e => setForm({ ...form, summary: e.target.value })} /></label>
      <label>Conclusions<textarea value={form.conclusions} onChange={e => setForm({ ...form, conclusions: e.target.value })} /></label>
      <label>Decisions<textarea value={form.decisions} onChange={e => setForm({ ...form, decisions: e.target.value })} /></label>
      <button type="submit">Create review</button>
    </form>}

    {tab === 'Inputs' && <p>Open a review from the register to add inputs or use "Generate inputs from modules" to pull QMS summaries.</p>}
    {tab === 'Actions' && <p>Actions raised from a review appear inside the review's detail panel and in the shared Action Tracker.</p>}
    {tab === 'Reports' && <p>Management review reports will be added in a later phase.</p>}
  </div>;
}

// ============= Quality Indicators =============
export function QualityIndicatorsPage() {
  const { isEnabled } = useModules();
  const { staff, sections } = useLookups();
  const summary = useGovernanceSummary();
  const [tab, setTab] = useState('Dashboard');
  const [error, setError] = useState<string | null>(null);
  const [indicators, setIndicators] = useState<QualityIndicator[]>([]);
  const [results, setResults] = useState<QualityIndicatorResult[]>([]);
  const [selectedId, setSelectedId] = useState<string>('');
  const [form, setForm] = useState({ indicatorCode: '', indicatorName: '', sectionId: '', description: '', numeratorDefinition: '', denominatorDefinition: '', targetValue: '', warningThreshold: '', criticalThreshold: '', frequency: 'monthly', responsibleStaffId: '', reviewerStaffId: '' });
  const [resForm, setResForm] = useState({ periodStart: '', periodEnd: '', numeratorValue: '', denominatorValue: '', interpretation: '' });

  async function load() { try { setIndicators(await api<QualityIndicator[]>('/quality-indicators')); } catch (e) { setError((e as Error).message); } }
  async function loadResults(id: string) { if (!id) { setResults([]); return; } try { setResults(await api<QualityIndicatorResult[]>(`/quality-indicators/${id}/results`)); } catch (e) { setError((e as Error).message); } }
  useEffect(() => { if (isEnabled('quality_indicators')) void load(); }, [isEnabled]);
  if (!isEnabled('quality_indicators')) return <DisabledModule />;

  async function submit(e: FormEvent) { e.preventDefault(); setError(null); try { await api('/quality-indicators', { method: 'POST', body: JSON.stringify(form) }); setForm({ indicatorCode: '', indicatorName: '', sectionId: '', description: '', numeratorDefinition: '', denominatorDefinition: '', targetValue: '', warningThreshold: '', criticalThreshold: '', frequency: 'monthly', responsibleStaffId: '', reviewerStaffId: '' }); await load(); setTab('Indicator Register'); } catch (e) { setError((e as Error).message); } }
  async function submitResult(e: FormEvent) { e.preventDefault(); setError(null); if (!selectedId) return setError('Select an indicator'); try { await api(`/quality-indicators/${selectedId}/results`, { method: 'POST', body: JSON.stringify(resForm) }); setResForm({ periodStart: '', periodEnd: '', numeratorValue: '', denominatorValue: '', interpretation: '' }); await loadResults(selectedId); } catch (e) { setError((e as Error).message); } }
  async function review(id: number) { try { await api(`/quality-indicators/results/${id}/review`, { method: 'POST', body: JSON.stringify({}) }); await loadResults(selectedId); } catch (e) { setError((e as Error).message); } }
  async function createNc(id: number) { try { await api(`/quality-indicators/results/${id}/create-nc`, { method: 'POST', body: JSON.stringify({}) }); await loadResults(selectedId); } catch (e) { setError((e as Error).message); } }
  async function createCapa(id: number) { try { await api(`/quality-indicators/results/${id}/create-capa`, { method: 'POST', body: JSON.stringify({}) }); await loadResults(selectedId); } catch (e) { setError((e as Error).message); } }

  const tabs = ['Dashboard', 'Indicator Register', 'New Indicator', 'Results Entry', 'Trends', 'Reports'];
  return <div className="module-page">
    <h2>Quality Indicators</h2>
    {tabBar(tab, tabs, setTab)}
    {error && <div className="error">{error}</div>}

    {tab === 'Dashboard' && dashboardCards(summary, [
      { label: 'Active indicators', value: 'activeQualityIndicators' },
      { label: 'Critical results to action', value: 'criticalQualityIndicatorResults' }
    ])}

    {tab === 'Indicator Register' && <table className="data-table"><thead><tr><th>Code</th><th>Name</th><th>Frequency</th><th>Target</th><th>Warning</th><th>Critical</th><th>Active</th></tr></thead><tbody>
      {indicators.map(i => <tr key={i.id}><td>{i.indicator_code}</td><td>{i.indicator_name}</td><td>{i.frequency}</td><td>{i.target_value ?? '—'}</td><td>{i.warning_threshold ?? '—'}</td><td>{i.critical_threshold ?? '—'}</td><td>{i.is_active ? 'Yes' : 'No'}</td></tr>)}
    </tbody></table>}

    {tab === 'New Indicator' && <form className="form-grid" onSubmit={submit}>
      <label>Code (auto if blank)<input value={form.indicatorCode} onChange={e => setForm({ ...form, indicatorCode: e.target.value })} /></label>
      <label>Name<input value={form.indicatorName} onChange={e => setForm({ ...form, indicatorName: e.target.value })} required /></label>
      <label>Section<select value={form.sectionId} onChange={e => setForm({ ...form, sectionId: e.target.value })}><option value="">—</option>{sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
      <label>Description<textarea value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} /></label>
      <label>Numerator definition<input value={form.numeratorDefinition} onChange={e => setForm({ ...form, numeratorDefinition: e.target.value })} /></label>
      <label>Denominator definition<input value={form.denominatorDefinition} onChange={e => setForm({ ...form, denominatorDefinition: e.target.value })} /></label>
      <label>Target (%)<input type="number" step="any" value={form.targetValue} onChange={e => setForm({ ...form, targetValue: e.target.value })} required /></label>
      <label>Warning threshold<input type="number" step="any" value={form.warningThreshold} onChange={e => setForm({ ...form, warningThreshold: e.target.value })} /></label>
      <label>Critical threshold<input type="number" step="any" value={form.criticalThreshold} onChange={e => setForm({ ...form, criticalThreshold: e.target.value })} /></label>
      <label>Frequency<select value={form.frequency} onChange={e => setForm({ ...form, frequency: e.target.value })}>{FREQUENCIES.map(f => <option key={f} value={f}>{f}</option>)}</select></label>
      <label>Responsible<select value={form.responsibleStaffId} onChange={e => setForm({ ...form, responsibleStaffId: e.target.value })}><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
      <label>Reviewer<select value={form.reviewerStaffId} onChange={e => setForm({ ...form, reviewerStaffId: e.target.value })}><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
      <button type="submit">Create indicator</button>
    </form>}

    {tab === 'Results Entry' && <>
      <label>Indicator<select value={selectedId} onChange={e => { setSelectedId(e.target.value); void loadResults(e.target.value); }}><option value="">—</option>{indicators.filter(i => i.is_active).map(i => <option key={i.id} value={i.id}>{i.indicator_code} — {i.indicator_name}</option>)}</select></label>
      {selectedId && <form className="form-grid" onSubmit={submitResult}>
        <label>Period start<input type="date" value={resForm.periodStart} onChange={e => setResForm({ ...resForm, periodStart: e.target.value })} required /></label>
        <label>Period end<input type="date" value={resForm.periodEnd} onChange={e => setResForm({ ...resForm, periodEnd: e.target.value })} required /></label>
        <label>Numerator<input type="number" step="any" value={resForm.numeratorValue} onChange={e => setResForm({ ...resForm, numeratorValue: e.target.value })} required /></label>
        <label>Denominator<input type="number" step="any" value={resForm.denominatorValue} onChange={e => setResForm({ ...resForm, denominatorValue: e.target.value })} required /></label>
        <label>Interpretation<textarea value={resForm.interpretation} onChange={e => setResForm({ ...resForm, interpretation: e.target.value })} /></label>
        <button type="submit">Record result</button>
      </form>}
      {selectedId && <table className="data-table"><thead><tr><th>Period</th><th>Numerator</th><th>Denominator</th><th>Value %</th><th>Status</th><th>Reviewed</th><th></th></tr></thead><tbody>
        {results.map(r => <tr key={r.id}><td>{r.period_start} → {r.period_end}</td><td>{r.numerator_value}</td><td>{r.denominator_value}</td><td>{r.calculated_value !== null && r.calculated_value !== undefined ? r.calculated_value.toFixed(2) : '—'}</td><td>{formatBadge(r.status)}</td><td>{r.reviewed_at || 'Pending'}</td><td>{!r.reviewed_at && <button onClick={() => review(r.id)}>Review</button>}{r.status === 'critical' && !r.nc_id && <button onClick={() => createNc(r.id)}>NC</button>}{r.status === 'critical' && !r.capa_id && <button onClick={() => createCapa(r.id)}>CAPA</button>}</td></tr>)}
      </tbody></table>}
    </>}

    {tab === 'Trends' && <p>Indicator trend charts will be added in a later phase. The results table above already shows period-over-period values.</p>}
    {tab === 'Reports' && <p>Indicator reports will be added in a later phase.</p>}
  </div>;
}

// ============= Continual Improvement =============
export function ContinualImprovementPage() {
  const { isEnabled } = useModules();
  const { staff } = useLookups();
  const summary = useGovernanceSummary();
  const [tab, setTab] = useState('Dashboard');
  const [error, setError] = useState<string | null>(null);
  const [projects, setProjects] = useState<ImprovementProject[]>([]);
  const [selected, setSelected] = useState<ImprovementProject | null>(null);
  const [form, setForm] = useState({ title: '', improvementArea: 'turnaround_time', aimStatement: '', baselineMeasure: '', targetMeasure: '', startDate: '', expectedCompletionDate: '', responsibleStaffId: '', sourceModule: '', sourceRecordId: '' });
  const [updForm, setUpdForm] = useState({ updateDate: '', updateText: '', progressStatus: 'in_progress' });
  const [actForm, setActForm] = useState({ title: '', description: '', assignedToStaffId: '', dueDate: '', priority: 'normal' });

  async function load() { try { setProjects(await api<ImprovementProject[]>('/improvement')); } catch (e) { setError((e as Error).message); } }
  useEffect(() => { if (isEnabled('continual_improvement')) void load(); }, [isEnabled]);
  if (!isEnabled('continual_improvement')) return <DisabledModule />;

  async function submit(e: FormEvent) { e.preventDefault(); setError(null); try { await api('/improvement', { method: 'POST', body: JSON.stringify(form) }); setForm({ title: '', improvementArea: 'turnaround_time', aimStatement: '', baselineMeasure: '', targetMeasure: '', startDate: '', expectedCompletionDate: '', responsibleStaffId: '', sourceModule: '', sourceRecordId: '' }); await load(); setTab('Improvement Projects'); } catch (e) { setError((e as Error).message); } }
  async function open(id: number) { try { setSelected(await api<ImprovementProject>(`/improvement/${id}`)); } catch (e) { setError((e as Error).message); } }
  async function addUpdate(e: FormEvent) { e.preventDefault(); setError(null); if (!selected) return; try { await api(`/improvement/${selected.id}/update`, { method: 'POST', body: JSON.stringify(updForm) }); setUpdForm({ updateDate: '', updateText: '', progressStatus: 'in_progress' }); await open(selected.id); } catch (e) { setError((e as Error).message); } }
  async function addAction(e: FormEvent) { e.preventDefault(); setError(null); if (!selected) return; try { await api(`/improvement/${selected.id}/create-action`, { method: 'POST', body: JSON.stringify(actForm) }); setActForm({ title: '', description: '', assignedToStaffId: '', dueDate: '', priority: 'normal' }); await open(selected.id); } catch (e) { setError((e as Error).message); } }
  async function closeProject(id: number) { const summary = prompt('Outcome summary?'); if (!summary) return; try { await api(`/improvement/${id}/close`, { method: 'POST', body: JSON.stringify({ outcomeSummary: summary }) }); await load(); if (selected) await open(id); } catch (e) { setError((e as Error).message); } }

  const tabs = ['Dashboard', 'Improvement Projects', 'New Project', 'Updates', 'Reports'];
  return <div className="module-page">
    <h2>Continual Improvement</h2>
    {tabBar(tab, tabs, setTab)}
    {error && <div className="error">{error}</div>}

    {tab === 'Dashboard' && dashboardCards(summary, [
      { label: 'Active projects', value: 'activeImprovementProjects' },
      { label: 'Overdue improvement actions', value: 'overdueImprovementActions' }
    ])}

    {tab === 'Improvement Projects' && <>
      <table className="data-table"><thead><tr><th>Number</th><th>Title</th><th>Area</th><th>Status</th><th>Responsible</th><th></th></tr></thead><tbody>
        {projects.map(p => <tr key={p.id}><td>{p.project_number}</td><td>{p.title}</td><td>{p.improvement_area.replace(/_/g, ' ')}</td><td>{formatBadge(p.status)}</td><td>{staffName(staff, p.responsible_staff_id)}</td><td><button onClick={() => open(p.id)}>Open</button>{p.status !== 'closed' && <button onClick={() => closeProject(p.id)}>Close</button>}</td></tr>)}
      </tbody></table>
      {selected && <div className="card" style={{ marginTop: 16 }}>
        <h3>{selected.project_number} — {selected.title}</h3>
        <p>Area: {selected.improvement_area.replace(/_/g, ' ')} | Status: {formatBadge(selected.status)} | Responsible: {staffName(staff, selected.responsible_staff_id)}</p>
        <p><strong>Aim:</strong> {selected.aim_statement}</p>
        {selected.baseline_measure && <p><strong>Baseline:</strong> {selected.baseline_measure}</p>}
        {selected.target_measure && <p><strong>Target:</strong> {selected.target_measure}</p>}
        {selected.outcome_summary && <p><strong>Outcome:</strong> {selected.outcome_summary}</p>}
        <h4>Updates</h4>
        <table className="data-table"><thead><tr><th>Date</th><th>Progress</th><th>Notes</th></tr></thead><tbody>
          {(selected.updates || []).map((u: ImprovementUpdate) => <tr key={u.id}><td>{u.update_date}</td><td>{u.progress_status || '—'}</td><td>{u.update_text || '—'}</td></tr>)}
        </tbody></table>
        <form className="form-grid" onSubmit={addUpdate}>
          <label>Date<input type="date" value={updForm.updateDate} onChange={e => setUpdForm({ ...updForm, updateDate: e.target.value })} required /></label>
          <label>Progress status<input value={updForm.progressStatus} onChange={e => setUpdForm({ ...updForm, progressStatus: e.target.value })} /></label>
          <label>Update<textarea value={updForm.updateText} onChange={e => setUpdForm({ ...updForm, updateText: e.target.value })} /></label>
          <button type="submit">Add update</button>
        </form>
        <h4>Add action</h4>
        <form className="form-grid" onSubmit={addAction}>
          <label>Title<input value={actForm.title} onChange={e => setActForm({ ...actForm, title: e.target.value })} required /></label>
          <label>Description<textarea value={actForm.description} onChange={e => setActForm({ ...actForm, description: e.target.value })} /></label>
          <label>Assigned<select value={actForm.assignedToStaffId} onChange={e => setActForm({ ...actForm, assignedToStaffId: e.target.value })}><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
          <label>Due<input type="date" value={actForm.dueDate} onChange={e => setActForm({ ...actForm, dueDate: e.target.value })} /></label>
          <button type="submit">Create action</button>
        </form>
        <button className="secondary" onClick={() => setSelected(null)}>Close panel</button>
      </div>}
    </>}

    {tab === 'New Project' && <form className="form-grid" onSubmit={submit}>
      <label>Title<input value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} required /></label>
      <label>Area<select value={form.improvementArea} onChange={e => setForm({ ...form, improvementArea: e.target.value })}>{IMPROVEMENT_AREAS.map(a => <option key={a} value={a}>{a.replace(/_/g, ' ')}</option>)}</select></label>
      <label>Aim statement<textarea value={form.aimStatement} onChange={e => setForm({ ...form, aimStatement: e.target.value })} required /></label>
      <label>Baseline measure<input value={form.baselineMeasure} onChange={e => setForm({ ...form, baselineMeasure: e.target.value })} /></label>
      <label>Target measure<input value={form.targetMeasure} onChange={e => setForm({ ...form, targetMeasure: e.target.value })} /></label>
      <label>Start date<input type="date" value={form.startDate} onChange={e => setForm({ ...form, startDate: e.target.value })} /></label>
      <label>Expected completion<input type="date" value={form.expectedCompletionDate} onChange={e => setForm({ ...form, expectedCompletionDate: e.target.value })} /></label>
      <label>Responsible<select value={form.responsibleStaffId} onChange={e => setForm({ ...form, responsibleStaffId: e.target.value })}><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
      <label>Source module (optional)<input value={form.sourceModule} onChange={e => setForm({ ...form, sourceModule: e.target.value })} placeholder="e.g. nc_capa, quality_indicators" /></label>
      <label>Source record id<input value={form.sourceRecordId} onChange={e => setForm({ ...form, sourceRecordId: e.target.value })} /></label>
      <button type="submit">Create improvement project</button>
    </form>}

    {tab === 'Updates' && <p>Open a project from the register to add updates.</p>}
    {tab === 'Reports' && <p>Improvement portfolio reports will be added in a later phase.</p>}
  </div>;
}
