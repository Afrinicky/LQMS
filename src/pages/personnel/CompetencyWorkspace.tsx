import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { ClipboardCheck, Grid3x3, LayoutList, Pencil, Plus, ShieldAlert, Trash2 } from 'lucide-react';
import { DetailModal, EmptyState, KpiStrip, RowMenu } from '../../components/ui';
import { api, errorText , apiRead } from '../../services/api';
import { useAuth } from '../../hooks/useAuth';
import { usePermissions } from '../../hooks/usePermissions';
import { focusAttr } from '../../hooks/useFocusTarget';
import CompetencyFrameworks from './CompetencyFrameworks';
import {
  DueBadge, EvidencePanel, PrintButton, RatingPicker, ScaleLegend, ScoreDial, StatCell,
  badgeFor, labelise,
} from './competencyShared';
import {
  COMPETENCY_ASSESSMENT_TYPES, COMPETENCY_ASSESSMENT_TYPE_LABELS, COMPETENCY_METHODS,
  COMPETENCY_METHOD_LABELS, COMPETENCY_OUTCOMES, COMPETENCY_OUTCOME_LABELS, COMPETENCY_SCALE_4,
  COMPETENCY_STATUS_LABELS, SAMPLE_AGREEMENTS, SAMPLE_AGREEMENT_LABELS, SAMPLE_CHECK_TYPES,
  SAMPLE_CHECK_TYPE_LABELS, SUPERVISION_LEVELS, SUPERVISION_LEVEL_LABELS,
} from '../../../shared/constants/competency';
import type {
  CompetencyAssessment, CompetencyAssessmentItem, CompetencyMatrix, CompetencyOverview,
  Department, Position, Section, Staff,
} from '../../../shared/types/api';

/**
 * Competency assessment.
 *
 * Three views of the same thing. The register is the working list — who was
 * assessed, against what, how it came out and when it falls due again. The
 * frameworks are the standards those assessments are raised against. The
 * matrix is the question a head of department actually has: is the bench
 * covered, and by whom.
 *
 * Opening a record gives the assessor a scoring sheet rather than a form: the
 * elements of the job in the order they are worked, each with the criteria
 * that define acceptable performance, a rating, the method used, room for a
 * remark and somewhere to attach what was seen.
 */

const VIEWS = ['Register', 'Frameworks', 'Coverage matrix'] as const;
type View = (typeof VIEWS)[number];

const SCALE_LABELS = Object.fromEntries(COMPETENCY_SCALE_4.map(s => [s.score, s.label])) as Record<number, string>;

const emptyAssessment = {
  staffId: '', frameworkId: '', activity: '', sectionId: '', positionId: '',
  assessorStaffId: '', assessmentDate: new Date().toISOString().slice(0, 10),
  assessmentType: 'initial', assessmentReason: '', periodLabel: '',
};

export default function CompetencyWorkspace({ staff, sections, departments, positions }: {
  staff: Staff[];
  sections: Section[];
  departments: Department[];
  positions: Position[];
}) {
  const { can } = usePermissions();
  const mayCreate = can('personnel.training', 'create');
  const mayEdit = can('personnel.training', 'edit');
  const mayPrint = can('personnel.training', 'print');

  const [view, setView] = useState<View>('Register');
  const [overview, setOverview] = useState<CompetencyOverview | null>(null);
  const [assessments, setAssessments] = useState<CompetencyAssessment[]>([]);
  const [frameworkOptions, setFrameworkOptions] = useState<Array<{ id: number; title: string; framework_code: string; applies_to: string; status: string }>>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState(emptyAssessment);
  const [filters, setFilters] = useState({ staffId: '', status: '', outcome: '', frameworkId: '', sectionId: '', from: '', to: '' });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const loadRegister = useCallback(async () => {
    setLoading(true);
    try {
      const query = new URLSearchParams(Object.entries(filters).filter(([, v]) => v) as [string, string][]).toString();
      const [rows, summary] = await Promise.all([
        apiRead<CompetencyAssessment[]>(`/personnel/competency${query ? `?${query}` : ''}`, []),
        api<CompetencyOverview>('/personnel/competency-overview').catch(() => null),
      ]);
      setAssessments(rows);
      if (summary) setOverview(summary);
    } catch (e) { setError(errorText(e)); }
    finally { setLoading(false); }
  }, [filters]);

  const loadFrameworkOptions = useCallback(async () => {
    try { setFrameworkOptions(await api('/personnel/competency-frameworks?status=active')); }
    catch { setFrameworkOptions([]); }
  }, []);

  useEffect(() => { void loadRegister(); }, [loadRegister]);
  useEffect(() => { void loadFrameworkOptions(); }, [loadFrameworkOptions]);

  async function submitNew(event: FormEvent) {
    event.preventDefault(); setError(null);
    try {
      const created = await api<{ id: number }>('/personnel/competency', { method: 'POST', body: JSON.stringify(form) });
      setForm({ ...emptyAssessment, assessmentDate: form.assessmentDate });
      setCreating(false);
      await loadRegister();
      setSelectedId(created.id);
    } catch (e) { setError(errorText(e)); }
  }

  const chosenFramework = frameworkOptions.find(f => String(f.id) === form.frameworkId);
  const staffName = (id?: number | null) => staff.find(s => s.id === id)?.fullName ?? '—';

  const kpis = overview ? [
    { label: 'Open assessments', value: overview.openAssessments, onClick: () => setFilters(f => ({ ...f, status: 'in_progress' })) },
    { label: 'Awaiting review', value: overview.awaitingReview, tone: overview.awaitingReview ? 'warning' as const : undefined, onClick: () => setFilters(f => ({ ...f, status: 'pending_review' })) },
    { label: 'Awaiting sign-off', value: overview.awaitingAcknowledgement, onClick: () => setFilters(f => ({ ...f, status: 'completed' })) },
    { label: 'Overdue', value: overview.overdue, tone: overview.overdue ? 'danger' as const : undefined },
    { label: 'Due in 60 days', value: overview.dueSoon, tone: overview.dueSoon ? 'warning' as const : undefined },
    { label: 'Not yet competent', value: overview.notYetCompetent, tone: overview.notYetCompetent ? 'danger' as const : undefined, onClick: () => setFilters(f => ({ ...f, outcome: 'not_yet_competent' })) },
    { label: 'Never assessed', value: overview.staffNeverAssessed, tone: overview.staffNeverAssessed ? 'warning' as const : undefined, onClick: () => setView('Coverage matrix') },
    { label: 'Active frameworks', value: overview.activeFrameworks, onClick: () => setView('Frameworks') },
  ] : [];

  return <div className="competency-workspace">
    <div className="tabs sub view-switch">
      {VIEWS.map(v => <button key={v} type="button" className={view === v ? 'active' : ''} onClick={() => setView(v)}>
        {v === 'Register' ? <LayoutList size={14} /> : v === 'Frameworks' ? <ClipboardCheck size={14} /> : <Grid3x3 size={14} />}
        {v}
      </button>)}
    </div>

    {error && <div className="error">{error}</div>}

    {view === 'Register' && <>
      {overview && <KpiStrip items={kpis} />}

      <div className="workspace-head">
        <div>
          <h3>Assessment register</h3>
          <p className="muted">Every competency assessment raised, with the score it produced and when the person falls due again.</p>
        </div>
        <div className="workspace-actions">
          {mayPrint && <PrintButton path="/personnel/competency-matrix/print" label="Print coverage matrix" />}
          {mayCreate && <button type="button" onClick={() => setCreating(v => !v)}>
            <Plus size={15} style={{ verticalAlign: '-3px', marginRight: 6 }} />New assessment
          </button>}
        </div>
      </div>

      {creating && mayCreate && <form className="form-grid" onSubmit={submitNew}>
        <label>Member of staff
          <select value={form.staffId} onChange={e => setForm({ ...form, staffId: e.target.value })} required>
            <option value="">—</option>
            {staff.map(s => <option key={s.id} value={s.id}>{s.fullName}{s.employeeNo ? ` (${s.employeeNo})` : ''}</option>)}
          </select>
        </label>
        <label>Framework
          <select value={form.frameworkId} onChange={e => setForm({ ...form, frameworkId: e.target.value })}>
            <option value="">None — assess a single activity</option>
            {frameworkOptions.map(f => <option key={f.id} value={f.id}>{f.title}</option>)}
          </select>
          <small className="field-hint">
            {chosenFramework ? 'The framework\'s elements are copied onto this assessment when you create it.' : 'Without a framework you describe the activity yourself and add the elements by hand.'}
          </small>
        </label>
        {!form.frameworkId && <label>Activity assessed
          <input value={form.activity} onChange={e => setForm({ ...form, activity: e.target.value })} required={!form.frameworkId} placeholder="e.g. Gram staining" />
        </label>}
        <label>Reason for assessment
          <select value={form.assessmentType} onChange={e => setForm({ ...form, assessmentType: e.target.value })}>
            {COMPETENCY_ASSESSMENT_TYPES.map(t => <option key={t} value={t}>{COMPETENCY_ASSESSMENT_TYPE_LABELS[t]}</option>)}
          </select>
        </label>
        <label>Assessor
          <select value={form.assessorStaffId} onChange={e => setForm({ ...form, assessorStaffId: e.target.value })}>
            <option value="">Me</option>
            {staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}
          </select>
        </label>
        <label>Assessment date<input type="date" value={form.assessmentDate} onChange={e => setForm({ ...form, assessmentDate: e.target.value })} required /></label>
        <label>Unit / section
          <select value={form.sectionId} onChange={e => setForm({ ...form, sectionId: e.target.value })}>
            <option value="">From the framework or the staff record</option>
            {sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <label>Post
          <select value={form.positionId} onChange={e => setForm({ ...form, positionId: e.target.value })}>
            <option value="">—</option>
            {positions.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}
          </select>
        </label>
        <label>Period label<input value={form.periodLabel} onChange={e => setForm({ ...form, periodLabel: e.target.value })} placeholder="e.g. 2026 induction" /></label>
        <label className="wide">Why this assessment is being carried out
          <textarea rows={2} value={form.assessmentReason} onChange={e => setForm({ ...form, assessmentReason: e.target.value })} placeholder="e.g. Newly appointed; to be assessed before working unsupervised." />
        </label>
        <button type="submit">Raise assessment</button>
      </form>}

      <div className="filters">
        <label>Member of staff
          <select value={filters.staffId} onChange={e => setFilters({ ...filters, staffId: e.target.value })}>
            <option value="">Everyone</option>
            {staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}
          </select>
        </label>
        <label>Stage
          <select value={filters.status} onChange={e => setFilters({ ...filters, status: e.target.value })}>
            <option value="">Any</option>
            {Object.entries(COMPETENCY_STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <label>Outcome
          <select value={filters.outcome} onChange={e => setFilters({ ...filters, outcome: e.target.value })}>
            <option value="">Any</option>
            {COMPETENCY_OUTCOMES.map(o => <option key={o} value={o}>{COMPETENCY_OUTCOME_LABELS[o]}</option>)}
          </select>
        </label>
        <label>Framework
          <select value={filters.frameworkId} onChange={e => setFilters({ ...filters, frameworkId: e.target.value })}>
            <option value="">Any</option>
            {frameworkOptions.map(f => <option key={f.id} value={f.id}>{f.title}</option>)}
          </select>
        </label>
        <label>Unit
          <select value={filters.sectionId} onChange={e => setFilters({ ...filters, sectionId: e.target.value })}>
            <option value="">Any</option>
            {sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <label>From<input type="date" value={filters.from} onChange={e => setFilters({ ...filters, from: e.target.value })} /></label>
        <label>To<input type="date" value={filters.to} onChange={e => setFilters({ ...filters, to: e.target.value })} /></label>
        {Object.values(filters).some(Boolean) &&
          <button type="button" className="link-button" onClick={() => setFilters({ staffId: '', status: '', outcome: '', frameworkId: '', sectionId: '', from: '', to: '' })}>Clear filters</button>}
      </div>

      {loading ? <p className="muted">Loading…</p> : assessments.length === 0
        ? <EmptyState title="No assessments match" message={mayCreate ? 'Raise one against an active framework, or clear the filters.' : 'Clear the filters to see the whole register.'} />
        : <div className="table-scroll"><table className="data-table register-table">
          <thead><tr>
            <th>Number</th><th>Member of staff</th><th>Assessed against</th><th>Reason</th>
            <th>Date</th><th>Score</th><th>Outcome</th><th>Stage</th><th>Re-assess</th><th />
          </tr></thead>
          <tbody>
            {assessments.map(a => <tr key={a.id} className="row-click" {...focusAttr('competency_assessments', a.id)} onClick={() => setSelectedId(a.id)}>
              <td>{a.competency_number}</td>
              <td>{a.staff_name || staffName(a.staff_id)}{a.employee_no && <><br /><small className="muted">{a.employee_no}</small></>}</td>
              <td>{a.framework_title || a.activity}{a.framework_version && <><br /><small className="muted">v{a.framework_version}</small></>}</td>
              <td><small>{COMPETENCY_ASSESSMENT_TYPE_LABELS[a.assessment_type] || labelise(a.assessment_type)}</small></td>
              <td>{a.assessment_date}</td>
              <td>{a.score_percent === null || a.score_percent === undefined ? <span className="muted">—</span>
                : <strong className={a.pass_threshold_percent !== undefined && a.score_percent < a.pass_threshold_percent ? 'score-fail' : 'score-pass'}>{a.score_percent}%</strong>}</td>
              <td>{a.outcome ? badgeFor(a.outcome, COMPETENCY_OUTCOME_LABELS[a.outcome]) : <span className="muted">—</span>}</td>
              <td>{badgeFor(a.status, COMPETENCY_STATUS_LABELS[a.status])}</td>
              <td><DueBadge date={a.next_assessment_due} /></td>
              <td onClick={e => e.stopPropagation()}><button type="button" className="secondary" onClick={() => setSelectedId(a.id)}>Open</button></td>
            </tr>)}
          </tbody>
        </table></div>}
    </>}

    {view === 'Frameworks' && <CompetencyFrameworks sections={sections} departments={departments} onChanged={() => { void loadFrameworkOptions(); void loadRegister(); }} />}

    {view === 'Coverage matrix' && <CoverageMatrix sections={sections} mayPrint={mayPrint} onOpenAssessment={setSelectedId} />}

    {selectedId !== null && <AssessmentEditor
      assessmentId={selectedId}
      staff={staff}
      sections={sections}
      positions={positions}
      mayEdit={mayEdit}
      mayApprove={can('personnel.training', 'approve')}
      mayArchive={can('personnel.training', 'void_archive')}
      mayPrint={mayPrint}
      onClose={() => setSelectedId(null)}
      onChanged={loadRegister}
    />}
  </div>;
}

/* ── The assessment editor ──────────────────────────────────────────────── */

type EditorTab = 'Assessment' | 'Scoring' | 'Sample performance' | 'Evidence' | 'Sign-off';

function AssessmentEditor({ assessmentId, staff, sections, positions, mayEdit, mayApprove, mayArchive, mayPrint, onClose, onChanged }: {
  assessmentId: number;
  staff: Staff[];
  sections: Section[];
  positions: Position[];
  mayEdit: boolean;
  mayApprove: boolean;
  mayArchive: boolean;
  mayPrint: boolean;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const { can } = usePermissions();
  const { user } = useAuth();
  const [record, setRecord] = useState<CompetencyAssessment | null>(null);
  const [tab, setTab] = useState<EditorTab>('Scoring');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Editing or deleting a completed record is an administrative override, off
  // by default and switched on per record from the management menu — see
  // requirement 4. Reset whenever a different record is opened.
  const [adminUnlock, setAdminUnlock] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const load = useCallback(async () => {
    try { setRecord(await api<CompetencyAssessment>(`/personnel/competency/${assessmentId}`)); }
    catch (e) { setError(errorText(e)); }
  }, [assessmentId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setAdminUnlock(false); setConfirmDelete(false); }, [assessmentId]);

  const refresh = useCallback(async () => { await load(); await onChanged(); }, [load, onChanged]);

  if (!record) {
    return <DetailModal open onClose={onClose} title="Competency assessment">
      {error ? <div className="error">{error}</div> : <p className="muted">Loading…</p>}
    </DetailModal>;
  }

  const summary = record.score_summary;
  const open = record.status === 'planned' || record.status === 'in_progress';
  const closed = record.status === 'completed' || record.status === 'acknowledged';
  // The override only bites on a closed record and only for someone with
  // archival rights; on an open record editing is already allowed.
  const override = closed && adminUnlock && mayArchive;
  const scorable = mayEdit && (open || record.status === 'pending_review' || override);
  const isSubject = !!user?.staffId && user.staffId === record.staff_id;
  const isAssessor = !!user?.staffId && user.staffId === record.assessor_staff_id;
  const maxScore = record.max_score ?? 4;

  async function act(path: string, body: unknown, message: string) {
    setError(null); setNotice(null);
    try {
      await api(`/personnel/competency/${assessmentId}${path}`, { method: 'POST', body: JSON.stringify(body) });
      setNotice(message);
      await refresh();
    } catch (e) { setError(errorText(e)); }
  }

  async function removeRecord() {
    setError(null); setNotice(null);
    try {
      await api(`/personnel/competency/${assessmentId}`, { method: 'DELETE', body: JSON.stringify({ adminOverride: true }) });
      onClose();
      await onChanged();
    } catch (e) { setError(errorText(e)); setConfirmDelete(false); }
  }

  const tabs: EditorTab[] = ['Scoring', 'Sample performance', 'Evidence', 'Assessment', 'Sign-off'];

  return <DetailModal
    open
    onClose={onClose}
    width="wide"
    title={<>{record.competency_number} — {record.framework_title || record.activity}</>}
    subtitle={<>{record.staff_name}{record.employee_no ? ` (${record.employee_no})` : ''} · {record.section_name || 'No unit recorded'} · {COMPETENCY_ASSESSMENT_TYPE_LABELS[record.assessment_type] || labelise(record.assessment_type)} · {record.assessment_date}</>}
    header={<>
      {badgeFor(record.status, COMPETENCY_STATUS_LABELS[record.status])}
      {record.outcome && badgeFor(record.outcome, COMPETENCY_OUTCOME_LABELS[record.outcome])}
      {mayPrint && <PrintButton path={`/personnel/competency/${assessmentId}/print`} label="Print record" />}
      {mayArchive && closed && <RowMenu label="Manage this record">{close => <>
        <button type="button" role="menuitem" onClick={() => { close(); setAdminUnlock(v => !v); }}>
          <Pencil size={14} /> {adminUnlock ? 'Lock this record again' : 'Edit this submitted record'}
        </button>
        <button type="button" role="menuitem" className="danger" onClick={() => { close(); setConfirmDelete(true); }}>
          <Trash2 size={14} /> Delete this record
        </button>
      </>}</RowMenu>}
    </>}
  >
    {error && <div className="error">{error}</div>}
    {notice && <div className="notice-ok">{notice}</div>}
    {override && <p className="notice-warn">
      <ShieldAlert size={15} style={{ verticalAlign: '-3px', marginRight: 6 }} />
      This is a completed record, unlocked for editing. A competency record is normally left as it was signed — change it only to correct a mistake or clear demonstration data. Every change is audited as an override.
    </p>}
    {confirmDelete && <div className="notice-warn confirm-bar">
      <span><ShieldAlert size={15} style={{ verticalAlign: '-3px', marginRight: 6 }} />Delete {record.competency_number} for good? This removes the record, its scores, sample checks, evidence and any authorisation granted from it. It cannot be undone.</span>
      <span className="element-add-actions">
        {can('personnel.training', 'void_archive') && <button type="button" className="secondary danger-text" onClick={() => void removeRecord()}>Delete permanently</button>}
        <button type="button" className="secondary" onClick={() => setConfirmDelete(false)}>Keep it</button>
      </span>
    </div>}

    <div className="record-summary">
      <ScoreDial percent={summary?.percent ?? null} threshold={summary?.passThreshold ?? record.pass_threshold_percent ?? null} />
      <div className="summary-stats">
        <StatCell label="Elements scored" value={`${summary?.elementsAssessed ?? 0} / ${summary?.elementsApplicable ?? summary?.elementsTotal ?? 0}`} hint={summary && summary.elementsTotal !== summary.elementsApplicable ? `${summary.elementsTotal - summary.elementsApplicable} marked not applicable` : undefined} />
        <StatCell label="Critical shortfalls" value={summary?.criticalFailures ?? 0} tone={(summary?.criticalFailures ?? 0) > 0 ? 'bad' : 'good'}
          hint={summary?.minimumElementScore === null || summary?.minimumElementScore === undefined ? 'No element floor set' : `Element floor ${summary.minimumElementScore}`} />
        <StatCell label="Outcome" value={record.outcome ? COMPETENCY_OUTCOME_LABELS[record.outcome] : 'Not concluded'} />
        <StatCell label="Supervision" value={record.supervision_level ? SUPERVISION_LEVEL_LABELS[record.supervision_level] : '—'} />
        <StatCell label="Re-assessment due" value={record.next_assessment_due || '—'} />
      </div>
    </div>

    <div className="tabs sub">
      {tabs.map(t => <button key={t} type="button" className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
        {t}
        {t === 'Evidence' && (record.attachments?.length ?? 0) > 0 && <span className="tab-count">{record.attachments!.length}</span>}
        {t === 'Sample performance' && (record.sample_checks?.length ?? 0) > 0 && <span className="tab-count">{record.sample_checks!.length}</span>}
      </button>)}
    </div>

    {tab === 'Scoring' && <ScoringGrid record={record} maxScore={maxScore} scorable={scorable} override={override} onError={setError} onChanged={refresh} />}

    {tab === 'Sample performance' && <SampleChecks record={record} scorable={scorable} override={override} onError={setError} onChanged={refresh} />}

    {tab === 'Evidence' && <EvidencePanel
      basePath={`/personnel/competency/${assessmentId}`}
      attachments={record.attachments ?? []}
      canEdit={mayEdit}
      onChanged={refresh}
      itemChoices={(record.items ?? []).map(i => ({ id: i.id, label: i.element_text }))}
    />}

    {tab === 'Assessment' && <AssessmentDetails
      record={record}
      staff={staff}
      sections={sections}
      positions={positions}
      editable={mayEdit && (!closed || override)}
      override={override}
      onError={setError}
      onChanged={refresh}
    />}

    {tab === 'Sign-off' && <SignOff
      record={record}
      staff={staff}
      summary={summary}
      mayEdit={mayEdit}
      mayApprove={mayApprove}
      mayArchive={mayArchive}
      isSubject={isSubject}
      isAssessor={isAssessor}
      onAct={act}
    />}
  </DetailModal>;
}

/* ── Scoring ────────────────────────────────────────────────────────────── */

type Draft = Record<number, { score?: number | null; notApplicable?: boolean; remarks?: string; method?: string; observedDate?: string; evidenceNote?: string }>;

function ScoringGrid({ record, maxScore, scorable, override, onError, onChanged }: {
  record: CompetencyAssessment;
  maxScore: number;
  scorable: boolean;
  override?: boolean;
  onError: (message: string | null) => void;
  onChanged: () => Promise<void>;
}) {
  const { can } = usePermissions();
  const items = useMemo(() => record.items ?? [], [record.items]);
  const [draft, setDraft] = useState<Draft>({});
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [showRemarks, setShowRemarks] = useState(false);
  const [adding, setAdding] = useState(false);
  // Which rating the bulk "fill unscored" applies. Some assessors set the
  // baseline at Competent, others at Proficient — so it is chosen, not fixed.
  const [fillScore, setFillScore] = useState(3);
  const [extra, setExtra] = useState({ elementText: '', groupTitle: '', performanceCriteria: '', method: 'direct_observation', isCritical: false });

  useEffect(() => { setDraft({}); }, [record.id]);

  const value = (item: CompetencyAssessmentItem) => ({
    score: draft[item.id]?.score !== undefined ? draft[item.id].score : item.score,
    notApplicable: draft[item.id]?.notApplicable !== undefined ? draft[item.id].notApplicable : !!item.not_applicable,
    remarks: draft[item.id]?.remarks !== undefined ? draft[item.id].remarks : (item.remarks ?? ''),
    method: draft[item.id]?.method ?? item.method ?? 'direct_observation',
  });

  const set = (id: number, patch: Draft[number]) => setDraft(d => ({ ...d, [id]: { ...d[id], ...patch } }));
  const dirty = Object.keys(draft).length > 0;

  async function save() {
    if (!dirty) return;
    onError(null); setSaving(true);
    try {
      const payload = Object.entries(draft).map(([id, patch]) => {
        const item = items.find(i => i.id === Number(id));
        const merged = { ...value(item!), ...patch };
        return {
          id: Number(id),
          score: merged.notApplicable ? null : merged.score ?? null,
          notApplicable: !!merged.notApplicable,
          remarks: merged.remarks ?? '',
          method: merged.method,
          observedDate: patch.observedDate ?? item?.observed_date ?? '',
          evidenceNote: patch.evidenceNote ?? item?.evidence_note ?? '',
        };
      });
      await api(`/personnel/competency/${record.id}/items`, { method: 'PUT', body: JSON.stringify({ items: payload, adminOverride: override }) });
      setDraft({}); setSavedAt(new Date().toLocaleTimeString());
      await onChanged();
    } catch (e) { onError(errorText(e)); }
    finally { setSaving(false); }
  }

  async function addElement() {
    if (!extra.elementText.trim()) { onError('An element description is required.'); return; }
    onError(null);
    try {
      await api(`/personnel/competency/${record.id}/items`, { method: 'POST', body: JSON.stringify({ ...extra, adminOverride: override }) });
      setExtra({ elementText: '', groupTitle: '', performanceCriteria: '', method: 'direct_observation', isCritical: false });
      setAdding(false);
      await onChanged();
    } catch (e) { onError(errorText(e)); }
  }

  async function removeElement(id: number) {
    onError(null);
    try { await api(`/personnel/competency/${record.id}/items/${id}`, { method: 'DELETE', body: JSON.stringify({ adminOverride: override }) }); await onChanged(); }
    catch (e) { onError(errorText(e)); }
  }

  /** Set every unscored, applicable element to one rating in a single sweep. */
  function markRemaining(score: number) {
    const patch: Draft = {};
    for (const item of items) {
      const current = value(item);
      if (current.notApplicable || current.score !== null && current.score !== undefined) continue;
      patch[item.id] = { ...draft[item.id], score };
    }
    setDraft(d => ({ ...d, ...patch }));
  }

  const grouped = useMemo(() => {
    const map = new Map<string, CompetencyAssessmentItem[]>();
    for (const item of items) {
      const key = item.group_title || 'Assessed elements';
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(item);
    }
    return Array.from(map.entries());
  }, [items]);

  if (items.length === 0) {
    return <>
      <EmptyState
        title="No elements on this assessment"
        message="This assessment was raised without a framework. Add the elements you are assessing, then score them."
      />
      {scorable && <ExtraElementForm extra={extra} setExtra={setExtra} onAdd={addElement} onCancel={() => setAdding(false)} alwaysOpen />}
    </>;
  }

  return <div className="scoring">
    <div className="scoring-bar">
      <ScaleLegend scale={COMPETENCY_SCALE_4} max={maxScore} />
      <div className="scoring-bar-actions">
        <label className="check-inline"><input type="checkbox" checked={showRemarks} onChange={e => setShowRemarks(e.target.checked)} /> Show remarks and method</label>
        {scorable && <>
          <span className="fill-remaining">
            <label>Fill unscored as
              <select value={fillScore} onChange={e => setFillScore(Number(e.target.value))}>
                {Array.from({ length: maxScore }, (_, i) => maxScore - i).map(p => <option key={p} value={p}>{p} — {SCALE_LABELS[p] ?? `Level ${p}`}</option>)}
              </select>
            </label>
            <button type="button" className="secondary" onClick={() => markRemaining(fillScore)} title={`Give every element still unscored a rating of ${fillScore}`}>Apply to remaining</button>
          </span>
          {can('personnel.training', 'edit') && <button type="button" disabled={!dirty || saving} onClick={() => void save()}>{saving ? 'Saving…' : dirty ? `Save ${Object.keys(draft).length} change(s)` : 'Save changes'}</button>}
        </>}
        {savedAt && !dirty && <span className="saved-flag">Saved at {savedAt}</span>}
      </div>
    </div>

    {grouped.map(([group, rows]) => {
      // An element added to this record alone can be taken off it again; one
      // that came from the framework cannot, or the copy stops matching.
      const removable = scorable && rows.some(r => !r.framework_element_id);
      const scored = rows.filter(r => r.not_applicable || (r.score !== null && r.score !== undefined)).length;
      return <section key={group} className="score-group">
      <header><h4>{group}</h4><span className="muted">{scored} of {rows.length} scored</span></header>
      <table className="data-table scoring-table">
        <thead><tr>
          <th style={{ width: '4%' }}>#</th>
          <th>Element and performance criteria</th>
          <th style={{ width: '26%' }}>Rating</th>
          {showRemarks && <th style={{ width: '26%' }}>Method and remarks</th>}
          {removable && <th style={{ width: '4%' }} />}
        </tr></thead>
        <tbody>
          {rows.map((item, index) => {
  const { can } = usePermissions();
            const current = value(item);
            return <tr key={item.id} className={current.notApplicable ? 'row-na' : ''}>
              <td>{index + 1}</td>
              <td>
                <strong>{item.element_text}</strong>
                {item.is_critical ? <span className="badge critical inline-badge">Critical</span> : null}
                {item.performance_criteria && <><br /><small className="muted">{item.performance_criteria}</small></>}
                {item.evidence_file_name && <><br /><small className="muted">Evidence: {item.evidence_file_name}</small></>}
              </td>
              <td>
                <RatingPicker
                  value={current.score ?? null}
                  max={maxScore}
                  labels={SCALE_LABELS}
                  disabled={!scorable}
                  allowNotApplicable
                  notApplicable={current.notApplicable}
                  onChange={score => set(item.id, { score })}
                  onNotApplicable={na => set(item.id, { notApplicable: na, score: na ? null : current.score })}
                />
              </td>
              {showRemarks && <td>
                <select value={current.method} disabled={!scorable} onChange={e => set(item.id, { method: e.target.value })}>
                  {COMPETENCY_METHODS.map(m => <option key={m} value={m}>{COMPETENCY_METHOD_LABELS[m]}</option>)}
                </select>
                <input
                  value={current.remarks}
                  disabled={!scorable}
                  placeholder="What was observed"
                  onChange={e => set(item.id, { remarks: e.target.value })}
                  style={{ marginTop: 6 }}
                />
              </td>}
              {removable && <td>
                {!item.framework_element_id && can('personnel.training', 'edit') && <button type="button" className="link-button danger" onClick={() => void removeElement(item.id)} aria-label="Remove element"><Trash2 size={14} /></button>}
              </td>}
            </tr>;
          })}
        </tbody>
      </table>
    </section>;
    })}

    {scorable && <div className="scoring-foot">
      {adding
        ? <ExtraElementForm extra={extra} setExtra={setExtra} onAdd={addElement} onCancel={() => setAdding(false)} />
        : <button type="button" className="secondary" onClick={() => setAdding(true)}>
          <Plus size={14} style={{ verticalAlign: '-2px', marginRight: 6 }} />Add an element to this assessment only
        </button>}
      {can('personnel.training', 'edit') && <button type="button" disabled={!dirty || saving} onClick={() => void save()}>{saving ? 'Saving…' : dirty ? `Save ${Object.keys(draft).length} change(s)` : 'Save changes'}</button>}
    </div>}
  </div>;
}

function ExtraElementForm({ extra, setExtra, onAdd, onCancel, alwaysOpen }: {
  extra: { elementText: string; groupTitle: string; performanceCriteria: string; method: string; isCritical: boolean };
  setExtra: (value: typeof extra) => void;
  onAdd: () => Promise<void>;
  onCancel: () => void;
  alwaysOpen?: boolean;
}) {
  return <div className="element-add">
    <label className="wide">Element<input value={extra.elementText} onChange={e => setExtra({ ...extra, elementText: e.target.value })} placeholder="What the person has to be able to do" /></label>
    <label>Group<input value={extra.groupTitle} onChange={e => setExtra({ ...extra, groupTitle: e.target.value })} placeholder="Additional elements" /></label>
    <label>Method
      <select value={extra.method} onChange={e => setExtra({ ...extra, method: e.target.value })}>
        {COMPETENCY_METHODS.map(m => <option key={m} value={m}>{COMPETENCY_METHOD_LABELS[m]}</option>)}
      </select>
    </label>
    <label className="wide">Performance criteria<textarea rows={2} value={extra.performanceCriteria} onChange={e => setExtra({ ...extra, performanceCriteria: e.target.value })} /></label>
    <label className="check-inline"><input type="checkbox" checked={extra.isCritical} onChange={e => setExtra({ ...extra, isCritical: e.target.checked })} /> Critical element</label>
    <div className="element-add-actions">
      <button type="button" onClick={() => void onAdd()}>Add element</button>
      {!alwaysOpen && <button type="button" className="secondary" onClick={onCancel}>Cancel</button>}
    </div>
  </div>;
}

/* ── Objective sample performance ───────────────────────────────────────── */

function SampleChecks({ record, scorable, override, onError, onChanged }: {
  record: CompetencyAssessment;
  scorable: boolean;
  override?: boolean;
  onError: (message: string | null) => void;
  onChanged: () => Promise<void>;
}) {
  const { can } = usePermissions();
  const [form, setForm] = useState({ checkType: 'proficiency_testing', sampleId: '', dateTested: '', testPerformed: '', staffResult: '', referenceResult: '', agreement: 'acceptable', remarks: '' });
  const checks = record.sample_checks ?? [];

  async function add(event: FormEvent) {
    event.preventDefault(); onError(null);
    try {
      await api(`/personnel/competency/${record.id}/sample-checks`, { method: 'POST', body: JSON.stringify({ ...form, adminOverride: override }) });
      setForm({ checkType: form.checkType, sampleId: '', dateTested: form.dateTested, testPerformed: '', staffResult: '', referenceResult: '', agreement: 'acceptable', remarks: '' });
      await onChanged();
    } catch (e) { onError(errorText(e)); }
  }

  async function remove(id: number) {
    onError(null);
    try { await api(`/personnel/competency/${record.id}/sample-checks/${id}`, { method: 'DELETE' }); await onChanged(); }
    catch (e) { onError(errorText(e)); }
  }

  return <div className="sample-checks">
    <p className="muted">
      Performance against material where the answer is already known — a proficiency-testing sample, a split, a blind sample, or one the laboratory has examined before.
      This is the part of a competency assessment that does not depend on anybody's opinion.
    </p>

    {checks.length === 0
      ? <EmptyState title="No sample performance recorded" message="Add a proficiency, split, blind or previously examined sample and the result the person obtained." />
      : <table className="data-table">
        <thead><tr><th>Type</th><th>Sample</th><th>Date</th><th>Examination</th><th>Result obtained</th><th>Reference result</th><th>Agreement</th><th>Remarks</th>{scorable && <th />}</tr></thead>
        <tbody>
          {checks.map(c => <tr key={c.id}>
            <td>{SAMPLE_CHECK_TYPE_LABELS[c.check_type] || labelise(c.check_type)}</td>
            <td>{c.sample_id || '—'}</td>
            <td>{c.date_tested || '—'}</td>
            <td>{c.test_performed || '—'}</td>
            <td>{c.staff_result || '—'}</td>
            <td>{c.reference_result || '—'}</td>
            <td>{badgeFor(c.agreement)}</td>
            <td>{c.remarks || '—'}</td>
            {scorable && <td>{can('personnel.training', 'edit') && <button type="button" className="link-button danger" onClick={() => void remove(c.id)} aria-label="Remove"><Trash2 size={14} /></button>}</td>}
          </tr>)}
        </tbody>
      </table>}

    {scorable && can('personnel.training', 'edit') && <form className="form-grid" onSubmit={add}>
      <label>Check type
        <select value={form.checkType} onChange={e => setForm({ ...form, checkType: e.target.value })}>
          {SAMPLE_CHECK_TYPES.map(t => <option key={t} value={t}>{SAMPLE_CHECK_TYPE_LABELS[t]}</option>)}
        </select>
      </label>
      <label>Sample ID<input value={form.sampleId} onChange={e => setForm({ ...form, sampleId: e.target.value })} /></label>
      <label>Date tested<input type="date" value={form.dateTested} onChange={e => setForm({ ...form, dateTested: e.target.value })} /></label>
      <label>Examination performed<input value={form.testPerformed} onChange={e => setForm({ ...form, testPerformed: e.target.value })} placeholder="e.g. Malaria microscopy" /></label>
      <label>Result obtained<input value={form.staffResult} onChange={e => setForm({ ...form, staffResult: e.target.value })} /></label>
      <label>Reference result<input value={form.referenceResult} onChange={e => setForm({ ...form, referenceResult: e.target.value })} /></label>
      <label>Agreement
        <select value={form.agreement} onChange={e => setForm({ ...form, agreement: e.target.value })}>
          {SAMPLE_AGREEMENTS.map(a => <option key={a} value={a}>{SAMPLE_AGREEMENT_LABELS[a]}</option>)}
        </select>
      </label>
      <label className="wide">Remarks<input value={form.remarks} onChange={e => setForm({ ...form, remarks: e.target.value })} /></label>
      <button type="submit">Add sample check</button>
    </form>}
  </div>;
}

/* ── Details ────────────────────────────────────────────────────────────── */

function AssessmentDetails({ record, staff, sections, positions, editable, override, onError, onChanged }: {
  record: CompetencyAssessment;
  staff: Staff[];
  sections: Section[];
  positions: Position[];
  editable: boolean;
  override?: boolean;
  onError: (message: string | null) => void;
  onChanged: () => Promise<void>;
}) {
  const { can } = usePermissions();
  const [form, setForm] = useState({
    activity: record.activity,
    assessmentDate: record.assessment_date,
    assessmentType: record.assessment_type,
    assessmentReason: record.assessment_reason ?? '',
    periodLabel: record.period_label ?? '',
    sectionId: record.section_id ? String(record.section_id) : '',
    positionId: record.position_id ? String(record.position_id) : '',
    assessorStaffId: record.assessor_staff_id ? String(record.assessor_staff_id) : '',
    reviewerStaffId: record.reviewer_staff_id ? String(record.reviewer_staff_id) : '',
    findings: record.findings ?? '',
    assessorComments: record.assessor_comments ?? '',
    developmentPlan: record.development_plan ?? '',
    nextAssessmentDue: record.next_assessment_due ?? '',
    authorizationRecommendation: record.authorization_recommendation ?? '',
  });
  const [saved, setSaved] = useState(false);

  async function save(event: FormEvent) {
    event.preventDefault(); onError(null); setSaved(false);
    try {
      await api(`/personnel/competency/${record.id}`, { method: 'PUT', body: JSON.stringify({ ...form, adminOverride: override }) });
      setSaved(true);
      await onChanged();
    } catch (e) { onError(errorText(e)); }
  }

  if (!editable) {
    return <dl className="record-facts">
      <div><dt>Member of staff</dt><dd>{record.staff_name}{record.employee_no ? ` (${record.employee_no})` : ''}</dd></div>
      <div><dt>Designation</dt><dd>{record.designation || record.position_title || '—'}</dd></div>
      <div><dt>Unit / section</dt><dd>{record.section_name || '—'}</dd></div>
      <div><dt>Assessed against</dt><dd>{record.framework_title || record.activity}{record.framework_version ? ` (v${record.framework_version})` : ''}</dd></div>
      <div><dt>Reason</dt><dd>{COMPETENCY_ASSESSMENT_TYPE_LABELS[record.assessment_type] || labelise(record.assessment_type)}</dd></div>
      <div><dt>Assessment date</dt><dd>{record.assessment_date}</dd></div>
      <div><dt>Assessor</dt><dd>{record.assessor_name || '—'}</dd></div>
      <div><dt>Technical reviewer</dt><dd>{record.reviewer_name || '—'}</dd></div>
      <div><dt>Re-assessment due</dt><dd>{record.next_assessment_due || '—'}</dd></div>
      <div className="wide"><dt>Why this assessment was carried out</dt><dd>{record.assessment_reason || '—'}</dd></div>
      <div className="wide"><dt>Findings and observations</dt><dd className="prewrap">{record.findings || '—'}</dd></div>
      <div className="wide"><dt>Assessor's comments</dt><dd className="prewrap">{record.assessor_comments || '—'}</dd></div>
      <div className="wide"><dt>Training and development plan</dt><dd className="prewrap">{record.development_plan || '—'}</dd></div>
      {record.authorizations && record.authorizations.length > 0 && <div className="wide">
        <dt>Authorisations granted</dt>
        <dd>{record.authorizations.map(a => `${a.module_key} — ${a.level}${a.expires_at ? ` (to ${a.expires_at})` : ''}${a.is_active ? '' : ' — withdrawn'}`).join('; ')}</dd>
      </div>}
    </dl>;
  }

  return can('personnel.training', 'edit') && <form className="form-grid" onSubmit={save}>
    <label>Activity / title<input value={form.activity} onChange={e => setForm({ ...form, activity: e.target.value })} required /></label>
    <label>Assessment date<input type="date" value={form.assessmentDate} onChange={e => setForm({ ...form, assessmentDate: e.target.value })} required /></label>
    <label>Reason
      <select value={form.assessmentType} onChange={e => setForm({ ...form, assessmentType: e.target.value })}>
        {COMPETENCY_ASSESSMENT_TYPES.map(t => <option key={t} value={t}>{COMPETENCY_ASSESSMENT_TYPE_LABELS[t]}</option>)}
      </select>
    </label>
    <label>Unit / section
      <select value={form.sectionId} onChange={e => setForm({ ...form, sectionId: e.target.value })}>
        <option value="">—</option>{sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
    </label>
    <label>Post
      <select value={form.positionId} onChange={e => setForm({ ...form, positionId: e.target.value })}>
        <option value="">—</option>{positions.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}
      </select>
    </label>
    <label>Assessor
      <select value={form.assessorStaffId} onChange={e => setForm({ ...form, assessorStaffId: e.target.value })}>
        <option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}
      </select>
    </label>
    <label>Technical reviewer
      <select value={form.reviewerStaffId} onChange={e => setForm({ ...form, reviewerStaffId: e.target.value })}>
        <option value="">—</option>{staff.filter(s => String(s.id) !== form.assessorStaffId).map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}
      </select>
      <small className="field-hint">Somebody other than the assessor countersigns the record.</small>
    </label>
    <label>Period label<input value={form.periodLabel} onChange={e => setForm({ ...form, periodLabel: e.target.value })} /></label>
    <label>Re-assessment due<input type="date" value={form.nextAssessmentDue} onChange={e => setForm({ ...form, nextAssessmentDue: e.target.value })} /></label>
    <label>Authorisation recommended<input value={form.authorizationRecommendation} onChange={e => setForm({ ...form, authorizationRecommendation: e.target.value })} placeholder="e.g. Perform and report routine haematology" /></label>
    <label className="wide">Why this assessment is being carried out<textarea rows={2} value={form.assessmentReason} onChange={e => setForm({ ...form, assessmentReason: e.target.value })} /></label>
    <label className="wide">Findings and observations<textarea rows={3} value={form.findings} onChange={e => setForm({ ...form, findings: e.target.value })} /></label>
    <label className="wide">Assessor's comments<textarea rows={3} value={form.assessorComments} onChange={e => setForm({ ...form, assessorComments: e.target.value })} /></label>
    <label className="wide">Training and development plan<textarea rows={3} value={form.developmentPlan} onChange={e => setForm({ ...form, developmentPlan: e.target.value })} placeholder="What will be done about any shortfall, by when, and who will do it." /></label>
    <div className="element-add-actions">
      <button type="submit">Save</button>
      {saved && <span className="saved-flag">Saved</span>}
    </div>
  </form>;
}

/* ── Sign-off ───────────────────────────────────────────────────────────── */

function SignOff({ record, staff, summary, mayEdit, mayApprove, mayArchive, isSubject, isAssessor, onAct }: {
  record: CompetencyAssessment;
  staff: Staff[];
  summary?: CompetencyAssessment['score_summary'];
  mayEdit: boolean;
  mayApprove: boolean;
  mayArchive: boolean;
  isSubject: boolean;
  isAssessor: boolean;
  onAct: (path: string, body: unknown, message: string) => Promise<void>;
}) {
  const [recommended, setRecommended] = useState<string | null>(null);
  const [complete, setComplete] = useState({ outcome: '', supervisionLevel: '', nextAssessmentDue: record.next_assessment_due ?? '', overrideReason: '', assessorComments: '', developmentPlan: '', createRetrainingAction: true });
  const [review, setReview] = useState({ reviewerStaffId: record.reviewer_staff_id ? String(record.reviewer_staff_id) : '', reviewerComments: '' });
  const [ack, setAck] = useState({ staffComments: '' });
  const [auth, setAuth] = useState({ moduleKey: '', level: 'Perform', expiresAt: '', notes: '' });
  const [cancelReason, setCancelReason] = useState('');
  const [showCancel, setShowCancel] = useState(false);

  useEffect(() => {
    let live = true;
    api<{ recommendedOutcome?: string | null }>(`/personnel/competency/${record.id}/score-summary`)
      .then(r => { if (live) { setRecommended(r.recommendedOutcome ?? null); setComplete(c => ({ ...c, outcome: c.outcome || (r.recommendedOutcome ?? '') })); } })
      .catch(() => undefined);
    return () => { live = false; };
  }, [record.id, record.status, summary?.percent]);

  const overriding = !!recommended && !!complete.outcome && complete.outcome !== recommended;
  const open = record.status === 'planned' || record.status === 'in_progress';
  const closed = record.status === 'completed' || record.status === 'acknowledged';

  return <div className="sign-off">
    <ol className="workflow-track">
      {[
        { key: 'scored', label: 'Elements scored', done: (summary?.elementsAssessed ?? 0) > 0, detail: `${summary?.elementsAssessed ?? 0} of ${summary?.elementsApplicable ?? 0}` },
        { key: 'submitted', label: 'Submitted for review', done: record.status !== 'planned' && record.status !== 'in_progress', detail: record.status === 'pending_review' ? 'Awaiting the reviewer' : undefined },
        { key: 'completed', label: 'Outcome recorded', done: closed, detail: record.outcome ? COMPETENCY_OUTCOME_LABELS[record.outcome] : undefined },
        { key: 'reviewed', label: 'Technically reviewed', done: !!record.reviewed_at, detail: record.reviewer_name ?? undefined },
        { key: 'acknowledged', label: 'Acknowledged by staff', done: !!record.staff_acknowledged_at, detail: record.staff_acknowledged_at ? String(record.staff_acknowledged_at).slice(0, 10) : undefined },
      ].map(step => <li key={step.key} className={step.done ? 'done' : ''}>
        <span className="wt-label">{step.label}</span>
        {step.detail && <span className="wt-detail">{step.detail}</span>}
      </li>)}
    </ol>

    {open && mayEdit && <section className="signoff-card">
      <h4>Submit for technical review</h4>
      <p className="muted">Hands the scored assessment to a second, technically competent person before the outcome is recorded.</p>
      <div className="form-grid">
        <label>Technical reviewer
          <select value={review.reviewerStaffId} onChange={e => setReview({ ...review, reviewerStaffId: e.target.value })}>
            <option value="">—</option>
            {staff.filter(s => s.id !== record.assessor_staff_id).map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}
          </select>
        </label>
        <button type="button" onClick={() => void onAct('/submit', { reviewerStaffId: review.reviewerStaffId }, 'Sent for technical review.')}>Submit for review</button>
      </div>
    </section>}

    {!closed && mayEdit && <section className="signoff-card">
      <h4>Record the outcome</h4>
      {recommended
        ? <p className="muted">The scores point to <strong>{COMPETENCY_OUTCOME_LABELS[recommended]}</strong>. Record a different outcome only with a reason.</p>
        : <p className="muted">Score at least one element before concluding the assessment.</p>}
      <div className="form-grid">
        <label>Outcome
          <select value={complete.outcome} onChange={e => setComplete({ ...complete, outcome: e.target.value })}>
            <option value="">—</option>
            {COMPETENCY_OUTCOMES.map(o => <option key={o} value={o}>{COMPETENCY_OUTCOME_LABELS[o]}{o === recommended ? ' (indicated by the scores)' : ''}</option>)}
          </select>
        </label>
        <label>Level of supervision
          <select value={complete.supervisionLevel} onChange={e => setComplete({ ...complete, supervisionLevel: e.target.value })}>
            <option value="">Follow the outcome</option>
            {SUPERVISION_LEVELS.map(l => <option key={l} value={l}>{SUPERVISION_LEVEL_LABELS[l]}</option>)}
          </select>
        </label>
        <label>Re-assessment due<input type="date" value={complete.nextAssessmentDue} onChange={e => setComplete({ ...complete, nextAssessmentDue: e.target.value })} /></label>
        {overriding && <label className="wide">Reason for departing from the scored outcome
          <textarea rows={2} value={complete.overrideReason} onChange={e => setComplete({ ...complete, overrideReason: e.target.value })} required />
        </label>}
        <label className="wide">Assessor's comments<textarea rows={2} value={complete.assessorComments} onChange={e => setComplete({ ...complete, assessorComments: e.target.value })} /></label>
        <label className="wide">Training and development plan<textarea rows={2} value={complete.developmentPlan} onChange={e => setComplete({ ...complete, developmentPlan: e.target.value })} /></label>
        <label className="check-inline">
          <input type="checkbox" checked={complete.createRetrainingAction} onChange={e => setComplete({ ...complete, createRetrainingAction: e.target.checked })} />
          Raise a retraining action if the outcome is not yet competent
        </label>
        <button type="button" disabled={!complete.outcome || (overriding && !complete.overrideReason.trim())}
          onClick={() => void onAct('/complete', complete, 'Outcome recorded and the assessment closed.')}>Complete assessment</button>
      </div>
    </section>}

    {(record.status === 'pending_review' || closed) && mayApprove && !record.reviewed_at && <section className="signoff-card">
      <h4>Technical review</h4>
      {isAssessor
        ? <p className="notice-warn">
            <ShieldAlert size={15} style={{ verticalAlign: '-3px', marginRight: 6 }} />
            You carried out this assessment, so you cannot also countersign it. The technical review has to be recorded by another approver, signed in as themselves.
          </p>
        : <>
          <p className="muted">A second pair of eyes on the assessment and its evidence. It is recorded as you, the signed-in reviewer — it cannot be signed on someone else's behalf.</p>
          <div className="form-grid">
            <label className="wide">Reviewer's comments<textarea rows={2} value={review.reviewerComments} onChange={e => setReview({ ...review, reviewerComments: e.target.value })} /></label>
            <button type="button" onClick={() => void onAct('/review', { reviewerComments: review.reviewerComments }, 'Technical review recorded.')}>Countersign as technical reviewer</button>
          </div>
        </>}
    </section>}

    {record.reviewed_at && <section className="signoff-card done">
      <h4>Technical review</h4>
      <p><strong>{record.reviewer_name || '—'}</strong> · {String(record.reviewed_at).slice(0, 10)}</p>
      {record.reviewer_comments && <p className="prewrap">{record.reviewer_comments}</p>}
    </section>}

    {record.status === 'completed' && isSubject && <section className="signoff-card">
      <h4>Your acknowledgement</h4>
      <p className="muted">Signing records that the assessment was discussed with you. It does not signify agreement — put anything you disagree with in the box.</p>
      <div className="form-grid">
        <label className="wide">Your comments<textarea rows={3} value={ack.staffComments} onChange={e => setAck({ staffComments: e.target.value })} /></label>
        <button type="button" onClick={() => void onAct('/acknowledge', ack, 'Acknowledgement recorded.')}>Acknowledge this assessment</button>
      </div>
    </section>}

    {record.staff_acknowledged_at && <section className="signoff-card done">
      <h4>Acknowledged by the member of staff</h4>
      <p>{record.staff_name} · {String(record.staff_acknowledged_at).slice(0, 10)}</p>
      {record.staff_comments && <p className="prewrap">{record.staff_comments}</p>}
    </section>}

    {record.status === 'completed' && !isSubject && !record.staff_acknowledged_at && <p className="notice-warn">
      Waiting for {record.staff_name} to acknowledge this assessment from their own profile.
    </p>}

    {closed && record.outcome !== 'not_yet_competent' && mayApprove && <section className="signoff-card">
      <h4>Grant a technical authorisation</h4>
      <p className="muted">What this assessment entitles the person to do. The authorisation expires with the re-assessment date unless you set another.</p>
      <div className="form-grid">
        <label>Area of work<input value={auth.moduleKey} onChange={e => setAuth({ ...auth, moduleKey: e.target.value })} placeholder="e.g. iqc, monitoring, poct" required /></label>
        <label>Level
          <select value={auth.level} onChange={e => setAuth({ ...auth, level: e.target.value })}>
            {['View only', 'Perform', 'Review', 'Verify', 'Approve', 'Supervise', 'Train others'].map(l => <option key={l} value={l}>{l}</option>)}
          </select>
        </label>
        <label>Valid until<input type="date" value={auth.expiresAt} onChange={e => setAuth({ ...auth, expiresAt: e.target.value })} placeholder={record.next_assessment_due} /></label>
        <label>Notes<input value={auth.notes} onChange={e => setAuth({ ...auth, notes: e.target.value })} /></label>
        <button type="button" disabled={!auth.moduleKey.trim()}
          onClick={() => void onAct('/create-authorization', auth, 'Authorisation granted.')}>Grant authorisation</button>
      </div>
      {record.authorizations && record.authorizations.length > 0 && <table className="data-table">
        <thead><tr><th>Area of work</th><th>Level</th><th>Unit</th><th>Valid until</th><th>Status</th></tr></thead>
        <tbody>{record.authorizations.map(a => <tr key={a.id}>
          <td>{a.module_key}</td><td>{a.level}</td><td>{a.section_name || '—'}</td><td>{a.expires_at || '—'}</td>
          <td>{a.is_active ? badgeFor('active') : badgeFor('withdrawn')}</td>
        </tr>)}</tbody>
      </table>}
    </section>}

    {!closed && mayArchive && <section className="signoff-card">
      {showCancel ? <div className="form-grid">
        <label className="wide">Reason for cancelling<textarea rows={2} value={cancelReason} onChange={e => setCancelReason(e.target.value)} /></label>
        <div className="element-add-actions">
          <button type="button" className="secondary danger-text" disabled={!cancelReason.trim()}
            onClick={() => void onAct('/cancel', { reason: cancelReason }, 'Assessment cancelled.')}>Confirm cancellation</button>
          <button type="button" className="secondary" onClick={() => setShowCancel(false)}>Keep it open</button>
        </div>
      </div> : <button type="button" className="link-button danger" onClick={() => setShowCancel(true)}>Cancel this assessment</button>}
    </section>}
  </div>;
}

/* ── Coverage matrix ────────────────────────────────────────────────────── */

const STATE_LABELS: Record<string, string> = {
  competent: 'Competent',
  supervised: 'Competent under supervision',
  expired: 'Re-assessment overdue',
  not_competent: 'Not yet competent',
  not_assessed: 'Never assessed against this framework',
};
const STATE_MARKS: Record<string, string> = { competent: '✓', supervised: 'S', expired: '!', not_competent: '✕', not_assessed: '·' };

function CoverageMatrix({ sections, mayPrint, onOpenAssessment }: {
  sections: Section[];
  mayPrint: boolean;
  onOpenAssessment: (id: number) => void;
}) {
  const [matrix, setMatrix] = useState<CompetencyMatrix | null>(null);
  const [sectionId, setSectionId] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<CompetencyMatrix>(`/personnel/competency-matrix${sectionId ? `?sectionId=${sectionId}` : ''}`)
      .then(setMatrix).catch(e => setError(errorText(e)));
  }, [sectionId]);

  if (error) return <div className="error">{error}</div>;
  if (!matrix) return <p className="muted">Loading…</p>;

  return <div className="coverage-matrix">
    <div className="workspace-head">
      <div>
        <h3>Coverage matrix</h3>
        <p className="muted">Who is covered for what, as at {matrix.generatedAt}. Each cell shows the most recent completed assessment of that person against that framework.</p>
      </div>
      <div className="workspace-actions">
        <label className="inline-filter">Unit
          <select value={sectionId} onChange={e => setSectionId(e.target.value)}>
            <option value="">Whole laboratory</option>
            {sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        {mayPrint && <PrintButton path={`/personnel/competency-matrix/print${sectionId ? `?sectionId=${sectionId}` : ''}`} label="Print matrix" />}
      </div>
    </div>

    {matrix.frameworks.length === 0
      ? <EmptyState title="No active frameworks" message="Activate a framework before the matrix can show coverage against it." />
      : <>
        <div className="matrix-legend">
          {Object.entries(STATE_LABELS).map(([state, label]) =>
            <span key={state} className="ml-item"><em className={`cell-mark ${state}`}>{STATE_MARKS[state]}</em> {label}</span>)}
        </div>
        <div className="matrix-scroll">
          <table className="data-table matrix-table">
            <thead><tr>
              <th className="sticky-col">Member of staff</th>
              <th>Unit</th>
              {matrix.frameworks.map(f => <th key={f.id} className="matrix-head"><span>{f.title}</span></th>)}
            </tr></thead>
            <tbody>
              {matrix.rows.map(row => <tr key={row.staff.id}>
                <td className="sticky-col">
                  {row.staff.full_name}
                  {row.staff.employee_no && <><br /><small className="muted">{row.staff.employee_no}</small></>}
                </td>
                <td><small>{row.staff.section_name || '—'}</small></td>
                {row.coverage.map(cell => <td key={cell.frameworkId} className="matrix-cell">
                  <button
                    type="button"
                    className={`cell-mark ${cell.state}${cell.assessmentId ? ' clickable' : ''}`}
                    disabled={!cell.assessmentId}
                    title={`${STATE_LABELS[cell.state]}${cell.assessmentDate ? ` · assessed ${cell.assessmentDate}` : ''}${cell.nextDue ? ` · due ${cell.nextDue}` : ''}${cell.scorePercent !== null && cell.scorePercent !== undefined ? ` · ${cell.scorePercent}%` : ''}`}
                    onClick={() => cell.assessmentId && onOpenAssessment(cell.assessmentId)}
                  >{STATE_MARKS[cell.state]}</button>
                </td>)}
              </tr>)}
            </tbody>
          </table>
        </div>
      </>}
  </div>;
}
