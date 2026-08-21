import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { LayoutList, Plus, Settings2, Trash2, User } from 'lucide-react';
import { DetailModal, EmptyState, KpiStrip } from '../../components/ui';
import { api } from '../../services/api';
import { useAuth } from '../../hooks/useAuth';
import { usePermissions } from '../../hooks/usePermissions';
import { focusAttr } from '../../hooks/useFocusTarget';
import AppraisalSetup from './AppraisalSetup';
import {
  DueBadge, EvidencePanel, PrintButton, RatingPicker, ScaleLegend, ScoreDial, StatCell,
  badgeFor, labelise,
} from './competencyShared';
import {
  APPRAISAL_OBJECTIVE_STATUSES, APPRAISAL_RECOMMENDATIONS, APPRAISAL_RECOMMENDATION_LABELS,
  APPRAISAL_SCALE_5, APPRAISAL_SECTIONS, APPRAISAL_SECTION_HINTS, APPRAISAL_SECTION_LABELS,
  APPRAISAL_STATUS_LABELS, APPRAISAL_TYPES, APPRAISAL_TYPE_LABELS,
  DEVELOPMENT_ACTION_TYPES, DEVELOPMENT_ACTION_TYPE_LABELS,
} from '../../../shared/constants/competency';
import type {
  AppraisalCycle, AppraisalItem, AppraisalOverview, AppraisalTemplate, Department,
  PerformanceAppraisal, Position, Section, Staff,
} from '../../../shared/types/api';

/**
 * Performance appraisal.
 *
 * The register is the working list — who is being appraised, which stage the
 * record has reached and what it came out at. Setup holds the template and the
 * cycle behind it. "My appraisals" is the same register narrowed to the
 * signed-in person, because the member of staff has real work to do here: they
 * rate themselves before the appraiser does, and they sign at the end.
 */

const VIEWS = ['Register', 'My appraisals', 'Setup'] as const;
type View = (typeof VIEWS)[number];

const SCALE_LABELS = Object.fromEntries(APPRAISAL_SCALE_5.map(s => [s.score, s.label])) as Record<number, string>;

const emptyAppraisal = {
  staffId: '', cycleId: '', templateId: '', appraisalType: 'annual',
  appraisalDate: new Date().toISOString().slice(0, 10), periodStart: '', periodEnd: '',
  appraiserStaffId: '', reviewerStaffId: '',
};

export default function AppraisalWorkspace({ staff, sections, departments, positions }: {
  staff: Staff[];
  sections: Section[];
  departments: Department[];
  positions: Position[];
}) {
  const { can } = usePermissions();
  const { user } = useAuth();
  const mayCreate = can('personnel.appraisals', 'create');
  const mayEdit = can('personnel.appraisals', 'edit');
  const mayPrint = can('personnel.appraisals', 'print');

  const [view, setView] = useState<View>('Register');
  const [overview, setOverview] = useState<AppraisalOverview | null>(null);
  const [appraisals, setAppraisals] = useState<PerformanceAppraisal[]>([]);
  const [cycles, setCycles] = useState<AppraisalCycle[]>([]);
  const [templates, setTemplates] = useState<AppraisalTemplate[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState(emptyAppraisal);
  const [filters, setFilters] = useState({ staffId: '', status: '', cycleId: '', sectionId: '', appraisalType: '' });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const query = new URLSearchParams(Object.entries(filters).filter(([, v]) => v) as [string, string][]).toString();
      const [rows, summary] = await Promise.all([
        api<PerformanceAppraisal[]>(`/personnel/appraisals${query ? `?${query}` : ''}`),
        api<AppraisalOverview>('/personnel/appraisal-overview').catch(() => null),
      ]);
      setAppraisals(rows);
      if (summary) setOverview(summary);
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }, [filters]);

  const loadSetup = useCallback(async () => {
    try {
      const [c, t] = await Promise.all([
        api<AppraisalCycle[]>('/personnel/appraisal-cycles').catch(() => []),
        api<AppraisalTemplate[]>('/personnel/appraisal-templates?status=active').catch(() => []),
      ]);
      setCycles(c); setTemplates(t);
    } catch { /* the register still works without them */ }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void loadSetup(); }, [loadSetup]);

  async function submitNew(event: FormEvent) {
    event.preventDefault(); setError(null);
    try {
      const created = await api<{ id: number }>('/personnel/appraisals', { method: 'POST', body: JSON.stringify(form) });
      setForm({ ...emptyAppraisal, appraisalDate: form.appraisalDate });
      setCreating(false);
      await load();
      setSelectedId(created.id);
    } catch (e) { setError((e as Error).message); }
  }

  const mine = useMemo(
    () => user?.staffId ? appraisals.filter(a => a.staff_id === user.staffId) : [],
    [appraisals, user?.staffId],
  );

  const kpis = overview ? [
    { label: 'With staff', value: overview.withStaff, onClick: () => setFilters(f => ({ ...f, status: 'self_assessment' })) },
    { label: 'With appraiser', value: overview.withAppraiser, onClick: () => setFilters(f => ({ ...f, status: 'appraiser_review' })) },
    { label: 'For moderation', value: overview.awaitingModeration, tone: overview.awaitingModeration ? 'warning' as const : undefined, onClick: () => setFilters(f => ({ ...f, status: 'pending_moderation' })) },
    { label: 'Awaiting signature', value: overview.awaitingAcknowledgement, onClick: () => setFilters(f => ({ ...f, status: 'completed' })) },
    { label: 'Completed, year', value: overview.completedThisYear },
    { label: 'Overdue', value: overview.overdue, tone: overview.overdue ? 'danger' as const : undefined },
    { label: 'Never appraised', value: overview.staffNeverAppraised, tone: overview.staffNeverAppraised ? 'warning' as const : undefined },
    { label: 'Open actions', value: overview.developmentActionsOpen },
  ] : [];

  const rows = view === 'My appraisals' ? mine : appraisals;

  const register = <>
    {view === 'Register' && overview && <KpiStrip items={kpis} />}

    <div className="workspace-head">
      <div>
        <h3>{view === 'My appraisals' ? 'My appraisals' : 'Appraisal register'}</h3>
        <p className="muted">
          {view === 'My appraisals'
            ? 'Your own appraisals. Rate yourself before the discussion, then sign the record afterwards.'
            : 'Every appraisal raised, the stage it has reached and the rating it produced. Confidential between the member of staff, the appraiser and the reviewer.'}
        </p>
      </div>
      {view === 'Register' && mayCreate && <div className="workspace-actions">
        <button type="button" onClick={() => setCreating(v => !v)}>
          <Plus size={15} style={{ verticalAlign: '-3px', marginRight: 6 }} />New appraisal
        </button>
      </div>}
    </div>

    {view === 'Register' && creating && mayCreate && <form className="form-grid" onSubmit={submitNew}>
      <label>Member of staff
        <select value={form.staffId} onChange={e => setForm({ ...form, staffId: e.target.value })} required>
          <option value="">—</option>
          {staff.map(s => <option key={s.id} value={s.id}>{s.fullName}{s.employeeNo ? ` (${s.employeeNo})` : ''}</option>)}
        </select>
      </label>
      <label>Cycle
        <select value={form.cycleId} onChange={e => {
          const cycle = cycles.find(c => String(c.id) === e.target.value);
          setForm({
            ...form,
            cycleId: e.target.value,
            templateId: cycle?.template_id ? String(cycle.template_id) : form.templateId,
            periodStart: cycle?.period_start ?? form.periodStart,
            periodEnd: cycle?.period_end ?? form.periodEnd,
            appraisalType: cycle?.cycle_type ?? form.appraisalType,
          });
        }}>
          <option value="">Outside any cycle</option>
          {cycles.filter(c => c.status !== 'closed').map(c => <option key={c.id} value={c.id}>{c.cycle_name}</option>)}
        </select>
      </label>
      <label>Template
        <select value={form.templateId} onChange={e => setForm({ ...form, templateId: e.target.value })}>
          <option value="">None — a narrative record only</option>
          {templates.map(t => <option key={t.id} value={t.id}>{t.title}</option>)}
        </select>
        <small className="field-hint">The template's items are copied onto the appraisal when you create it.</small>
      </label>
      <label>Type
        <select value={form.appraisalType} onChange={e => setForm({ ...form, appraisalType: e.target.value })}>
          {APPRAISAL_TYPES.map(t => <option key={t} value={t}>{APPRAISAL_TYPE_LABELS[t]}</option>)}
        </select>
      </label>
      <label>Period start<input type="date" value={form.periodStart} onChange={e => setForm({ ...form, periodStart: e.target.value })} /></label>
      <label>Period end<input type="date" value={form.periodEnd} onChange={e => setForm({ ...form, periodEnd: e.target.value })} /></label>
      <label>Appraisal date<input type="date" value={form.appraisalDate} onChange={e => setForm({ ...form, appraisalDate: e.target.value })} required /></label>
      <label>Appraiser
        <select value={form.appraiserStaffId} onChange={e => setForm({ ...form, appraiserStaffId: e.target.value })}>
          <option value="">Me</option>
          {staff.filter(s => String(s.id) !== form.staffId).map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}
        </select>
      </label>
      <label>Second-level reviewer
        <select value={form.reviewerStaffId} onChange={e => setForm({ ...form, reviewerStaffId: e.target.value })}>
          <option value="">Decide later</option>
          {staff.filter(s => String(s.id) !== form.staffId).map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}
        </select>
      </label>
      <button type="submit">Raise appraisal</button>
    </form>}

    {view === 'Register' && <div className="filters">
      <label>Member of staff
        <select value={filters.staffId} onChange={e => setFilters({ ...filters, staffId: e.target.value })}>
          <option value="">Everyone</option>
          {staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}
        </select>
      </label>
      <label>Stage
        <select value={filters.status} onChange={e => setFilters({ ...filters, status: e.target.value })}>
          <option value="">Any</option>
          {Object.entries(APPRAISAL_STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </label>
      <label>Cycle
        <select value={filters.cycleId} onChange={e => setFilters({ ...filters, cycleId: e.target.value })}>
          <option value="">Any</option>
          {cycles.map(c => <option key={c.id} value={c.id}>{c.cycle_name}</option>)}
        </select>
      </label>
      <label>Type
        <select value={filters.appraisalType} onChange={e => setFilters({ ...filters, appraisalType: e.target.value })}>
          <option value="">Any</option>
          {APPRAISAL_TYPES.map(t => <option key={t} value={t}>{APPRAISAL_TYPE_LABELS[t]}</option>)}
        </select>
      </label>
      <label>Unit
        <select value={filters.sectionId} onChange={e => setFilters({ ...filters, sectionId: e.target.value })}>
          <option value="">Any</option>
          {sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </label>
      {Object.values(filters).some(Boolean) &&
        <button type="button" className="link-button" onClick={() => setFilters({ staffId: '', status: '', cycleId: '', sectionId: '', appraisalType: '' })}>Clear filters</button>}
    </div>}

    {loading ? <p className="muted">Loading…</p> : rows.length === 0
      ? <EmptyState
        title={view === 'My appraisals' ? 'No appraisals of your own' : 'No appraisals match'}
        message={view === 'My appraisals'
          ? 'When your manager raises one it will appear here, starting with your own self-assessment.'
          : mayCreate ? 'Raise one from a template, or open a cycle in Setup and raise them in a batch.' : 'Clear the filters to see the whole register.'}
      />
      : <div className="table-scroll"><table className="data-table register-table">
        <thead><tr>
          <th>Number</th><th>Member of staff</th><th>Period</th><th>Type</th><th>Appraiser</th>
          <th>Overall</th><th>Rating</th><th>Stage</th><th>Next due</th><th />
        </tr></thead>
        <tbody>
          {rows.map(a => <tr key={a.id} className="row-click" {...focusAttr('performance_appraisals', a.id)} onClick={() => setSelectedId(a.id)}>
            <td>{a.record_number}</td>
            <td>{a.staff_name || '—'}{a.employee_no && <><br /><small className="muted">{a.employee_no}</small></>}</td>
            <td>{a.period_start && a.period_end ? <>{a.period_start}<br /><small className="muted">to {a.period_end}</small></> : (a.period || '—')}</td>
            <td><small>{APPRAISAL_TYPE_LABELS[a.appraisal_type] || labelise(a.appraisal_type)}</small></td>
            <td>{a.appraiser_name || '—'}</td>
            <td>{a.overall_percent === null || a.overall_percent === undefined ? <span className="muted">—</span> : <strong>{a.overall_percent}%</strong>}</td>
            <td>{a.rating_band ? badgeFor(a.rating_band) : <span className="muted">—</span>}</td>
            <td>{badgeFor(a.status, APPRAISAL_STATUS_LABELS[a.status])}</td>
            <td><DueBadge date={a.next_appraisal_due} /></td>
            <td onClick={e => e.stopPropagation()}><button type="button" className="secondary" onClick={() => setSelectedId(a.id)}>Open</button></td>
          </tr>)}
        </tbody>
      </table></div>}
  </>;

  return <div className="appraisal-workspace">
    <div className="tabs sub view-switch">
      {VIEWS.map(v => <button key={v} type="button" className={view === v ? 'active' : ''} onClick={() => setView(v)}>
        {v === 'Register' ? <LayoutList size={14} /> : v === 'My appraisals' ? <User size={14} /> : <Settings2 size={14} />}
        {v}
      </button>)}
    </div>

    {error && <div className="error">{error}</div>}

    {(view === 'Register' || view === 'My appraisals') && register}
    {view === 'Setup' && <AppraisalSetup staff={staff} sections={sections} departments={departments} onChanged={() => { void loadSetup(); void load(); }} />}

    {selectedId !== null && <AppraisalEditor
      appraisalId={selectedId}
      staff={staff}
      sections={sections}
      positions={positions}
      mayEdit={mayEdit}
      mayApprove={can('personnel.appraisals', 'approve')}
      mayArchive={can('personnel.appraisals', 'void_archive')}
      mayPrint={mayPrint}
      onClose={() => setSelectedId(null)}
      onChanged={load}
    />}
  </div>;
}

/* ── The appraisal editor ───────────────────────────────────────────────── */

type EditorTab = 'Ratings' | 'Objectives' | 'Development plan' | 'Evidence' | 'Details' | 'Sign-off';

function AppraisalEditor({ appraisalId, staff, sections, positions, mayEdit, mayApprove, mayArchive, mayPrint, onClose, onChanged }: {
  appraisalId: number;
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
  const { user } = useAuth();
  const [record, setRecord] = useState<PerformanceAppraisal | null>(null);
  const [tab, setTab] = useState<EditorTab>('Ratings');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setRecord(await api<PerformanceAppraisal>(`/personnel/appraisals/${appraisalId}`)); }
    catch (e) { setError((e as Error).message); }
  }, [appraisalId]);

  useEffect(() => { void load(); }, [load]);
  const refresh = useCallback(async () => { await load(); await onChanged(); }, [load, onChanged]);

  if (!record) {
    return <DetailModal open onClose={onClose} title="Performance appraisal">
      {error ? <div className="error">{error}</div> : <p className="muted">Loading…</p>}
    </DetailModal>;
  }

  const summary = record.score_summary;
  const isSubject = !!user?.staffId && user.staffId === record.staff_id;
  const closed = record.status === 'completed' || record.status === 'acknowledged' || record.status === 'cancelled';
  const maxScore = record.max_score ?? 5;

  async function act(path: string, body: unknown, message: string) {
    setError(null); setNotice(null);
    try {
      await api(`/personnel/appraisals/${appraisalId}${path}`, { method: 'POST', body: JSON.stringify(body) });
      setNotice(message);
      await refresh();
    } catch (e) { setError((e as Error).message); }
  }

  const tabs: EditorTab[] = ['Ratings', 'Objectives', 'Development plan', 'Evidence', 'Details', 'Sign-off'];

  return <DetailModal
    open
    onClose={onClose}
    width="wide"
    title={<>{record.record_number} — {record.staff_name}</>}
    subtitle={<>{APPRAISAL_TYPE_LABELS[record.appraisal_type] || labelise(record.appraisal_type)} · {record.period_start && record.period_end ? `${record.period_start} to ${record.period_end}` : record.period || record.appraisal_date} · appraised by {record.appraiser_name || '—'}</>}
    header={<>
      {badgeFor(record.status, APPRAISAL_STATUS_LABELS[record.status])}
      {record.rating_band && badgeFor(record.rating_band)}
      {mayPrint && <PrintButton path={`/personnel/appraisals/${appraisalId}/print`} label="Print record" />}
    </>}
  >
    {error && <div className="error">{error}</div>}
    {notice && <div className="notice-ok">{notice}</div>}
    {isSubject && record.status === 'self_assessment' && <p className="notice-warn">
      This appraisal is waiting on you. Rate yourself against each item under <strong>Ratings</strong>, then submit it to your appraiser from <strong>Sign-off</strong>.
    </p>}

    <div className="record-summary">
      <ScoreDial percent={summary?.overallPercent ?? null} threshold={null} label="Overall" sublabel={summary?.band ?? 'Not yet rated'} />
      <div className="summary-stats">
        <StatCell label="Mean rating" value={summary?.overallScore ?? '—'} hint={`out of ${maxScore}`} />
        <StatCell label="Self-assessment" value={summary?.selfPercent === null || summary?.selfPercent === undefined ? '—' : `${summary.selfPercent}%`}
          hint={record.self_assessment_submitted_at ? `Submitted ${String(record.self_assessment_submitted_at).slice(0, 10)}` : 'Not submitted'} />
        <StatCell label="Items rated" value={`${summary?.itemsScored ?? 0} / ${summary?.itemsTotal ?? 0}`} />
        <StatCell label="Recommendation" value={record.recommendation ? APPRAISAL_RECOMMENDATION_LABELS[record.recommendation] : '—'} />
        <StatCell label="Next appraisal" value={record.next_appraisal_due || '—'} />
      </div>
    </div>

    {summary && summary.sections.length > 0 && <div className="section-scores">
      {summary.sections.map(s => <div key={s.section} className="ss-item">
        <span className="ss-label">{s.label}</span>
        <div className="ss-bar"><span style={{ width: `${Math.max(0, Math.min(100, s.percent ?? 0))}%` }} /></div>
        <span className="ss-value">{s.percent === null ? '—' : `${s.percent}%`}</span>
      </div>)}
    </div>}

    <div className="tabs sub">
      {tabs.map(t => <button key={t} type="button" className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
        {t}
        {t === 'Objectives' && (record.objectives?.length ?? 0) > 0 && <span className="tab-count">{record.objectives!.length}</span>}
        {t === 'Development plan' && (record.development_actions?.length ?? 0) > 0 && <span className="tab-count">{record.development_actions!.length}</span>}
        {t === 'Evidence' && (record.attachments?.length ?? 0) > 0 && <span className="tab-count">{record.attachments!.length}</span>}
      </button>)}
    </div>

    {tab === 'Ratings' && <RatingsGrid record={record} maxScore={maxScore} isSubject={isSubject} mayEdit={mayEdit} onError={setError} onChanged={refresh} />}
    {tab === 'Objectives' && <Objectives record={record} mayEdit={mayEdit || isSubject} onError={setError} onChanged={refresh} />}
    {tab === 'Development plan' && <DevelopmentPlan record={record} staff={staff} mayEdit={mayEdit} onError={setError} onChanged={refresh} onAct={act} />}
    {tab === 'Evidence' && <EvidencePanel
      basePath={`/personnel/appraisals/${appraisalId}`}
      attachments={record.attachments ?? []}
      canEdit={mayEdit}
      onChanged={refresh}
      itemChoices={(record.items ?? []).map(i => ({ id: i.id, label: i.item_title }))}
    />}
    {tab === 'Details' && <AppraisalDetails record={record} staff={staff} sections={sections} positions={positions} editable={mayEdit && !closed} onError={setError} onChanged={refresh} />}
    {tab === 'Sign-off' && <AppraisalSignOff record={record} staff={staff} summary={summary} mayEdit={mayEdit} mayApprove={mayApprove} mayArchive={mayArchive} isSubject={isSubject} onAct={act} />}
  </DetailModal>;
}

/* ── Ratings ────────────────────────────────────────────────────────────── */

type RatingDraft = Record<number, { score?: number | null; comment?: string; evidenceNote?: string }>;

function RatingsGrid({ record, maxScore, isSubject, mayEdit, onError, onChanged }: {
  record: PerformanceAppraisal;
  maxScore: number;
  isSubject: boolean;
  mayEdit: boolean;
  onError: (message: string | null) => void;
  onChanged: () => Promise<void>;
}) {
  const items = useMemo(() => record.items ?? [], [record.items]);
  const editableStage = !['completed', 'acknowledged', 'cancelled'].includes(record.status);
  // Whose column you are filling in. The member of staff fills their own; the
  // appraiser fills theirs; neither can write in the other's.
  const [perspective, setPerspective] = useState<'self' | 'appraiser'>(isSubject ? 'self' : 'appraiser');
  const [draft, setDraft] = useState<RatingDraft>({});
  const [saving, setSaving] = useState(false);
  const [adding, setAdding] = useState(false);
  const [extra, setExtra] = useState({ section: 'delivery', itemTitle: '', itemDescription: '', successMeasure: '', weight: '1' });

  useEffect(() => { setDraft({}); }, [record.id, perspective]);

  const canWrite = editableStage && (perspective === 'self' ? isSubject : mayEdit && !isSubject);

  const value = (item: AppraisalItem) => {
    const stored = perspective === 'self' ? item.self_score : item.appraiser_score;
    const storedComment = perspective === 'self' ? item.self_comment : item.appraiser_comment;
    return {
      score: draft[item.id]?.score !== undefined ? draft[item.id].score : stored,
      comment: draft[item.id]?.comment !== undefined ? draft[item.id].comment : (storedComment ?? ''),
      evidenceNote: draft[item.id]?.evidenceNote !== undefined ? draft[item.id].evidenceNote : (item.evidence_note ?? ''),
    };
  };
  const set = (id: number, patch: RatingDraft[number]) => setDraft(d => ({ ...d, [id]: { ...d[id], ...patch } }));
  const dirty = Object.keys(draft).length > 0;

  async function save() {
    if (!dirty) return;
    onError(null); setSaving(true);
    try {
      const payload = Object.entries(draft).map(([id, patch]) => {
        const item = items.find(i => i.id === Number(id))!;
        const merged = { ...value(item), ...patch };
        return { id: Number(id), score: merged.score ?? null, comment: merged.comment ?? '', evidenceNote: merged.evidenceNote ?? '' };
      });
      await api(`/personnel/appraisals/${record.id}/items`, { method: 'PUT', body: JSON.stringify({ perspective, items: payload }) });
      setDraft({});
      await onChanged();
    } catch (e) { onError((e as Error).message); }
    finally { setSaving(false); }
  }

  async function addItem() {
    if (!extra.itemTitle.trim()) { onError('An item title is required.'); return; }
    onError(null);
    try {
      await api(`/personnel/appraisals/${record.id}/items`, { method: 'POST', body: JSON.stringify(extra) });
      setExtra({ section: extra.section, itemTitle: '', itemDescription: '', successMeasure: '', weight: '1' });
      setAdding(false);
      await onChanged();
    } catch (e) { onError((e as Error).message); }
  }

  async function removeItem(id: number) {
    onError(null);
    try { await api(`/personnel/appraisals/${record.id}/items/${id}`, { method: 'DELETE' }); await onChanged(); }
    catch (e) { onError((e as Error).message); }
  }

  if (items.length === 0) {
    return <EmptyState
      title="No rated items"
      message="This appraisal was raised without a template. Add the items you are rating, or raise the appraisal again from a template."
      action={mayEdit && editableStage
        ? <button type="button" onClick={() => setAdding(true)}>Add an item</button>
        : undefined}
    />;
  }

  return <div className="scoring">
    <div className="scoring-bar">
      <ScaleLegend scale={APPRAISAL_SCALE_5} max={maxScore} />
      <div className="scoring-bar-actions">
        <div className="segmented perspective">
          <button type="button" className={perspective === 'self' ? '' : 'secondary'} onClick={() => setPerspective('self')}>Self-assessment</button>
          <button type="button" className={perspective === 'appraiser' ? '' : 'secondary'} onClick={() => setPerspective('appraiser')}>Appraiser's rating</button>
        </div>
        {canWrite && <button type="button" disabled={!dirty || saving} onClick={() => void save()}>
          {saving ? 'Saving…' : dirty ? `Save ${Object.keys(draft).length} change(s)` : 'Save changes'}
        </button>}
      </div>
    </div>

    {!canWrite && <p className="muted">
      {perspective === 'self'
        ? 'The self-assessment column belongs to the member of staff being appraised — it is shown here but cannot be filled in on their behalf.'
        : !editableStage ? 'This appraisal is closed. Ratings can no longer be changed.'
          : isSubject ? 'The appraiser fills in their own column.'
            : 'You do not have the right to record appraiser ratings.'}
    </p>}

    {APPRAISAL_SECTIONS.map(section => {
      const rows = items.filter(i => i.section === section);
      if (rows.length === 0) return null;
      const sectionScore = record.score_summary?.sections.find(s => s.section === section);
      return <section key={section} className="score-group">
        <header>
          <h4>{APPRAISAL_SECTION_LABELS[section]}</h4>
          <span className="muted">{sectionScore?.percent === null || sectionScore?.percent === undefined ? `${rows.length} item(s)` : `${sectionScore.percent}%`}</span>
        </header>
        <p className="muted eg-desc">{APPRAISAL_SECTION_HINTS[section]}</p>
        <table className="data-table scoring-table">
          <thead><tr>
            <th style={{ width: '4%' }}>#</th>
            <th>Assessed item</th>
            <th style={{ width: '7%' }}>Weight</th>
            <th style={{ width: '24%' }}>{perspective === 'self' ? 'Your rating' : "Appraiser's rating"}</th>
            <th style={{ width: '28%' }}>Comment</th>
            {mayEdit && editableStage && <th style={{ width: '4%' }} />}
          </tr></thead>
          <tbody>
            {rows.map((item, index) => {
              const current = value(item);
              const other = perspective === 'self' ? item.appraiser_score : item.self_score;
              const gap = current.score !== null && current.score !== undefined && other !== null && other !== undefined && Math.abs(Number(current.score) - Number(other)) >= 2;
              return <tr key={item.id}>
                <td>{index + 1}</td>
                <td>
                  <strong>{item.item_title}</strong>
                  {item.item_description && <><br /><small className="muted">{item.item_description}</small></>}
                  {item.success_measure && <><br /><small className="muted">Measure: {item.success_measure}</small></>}
                  {other !== null && other !== undefined && <><br /><small className={gap ? 'gap-flag' : 'muted'}>
                    {perspective === 'self' ? 'Appraiser' : 'Self'}: {other}{gap ? ' — a two-point gap worth discussing' : ''}
                  </small></>}
                </td>
                <td>{item.weight}</td>
                <td>
                  <RatingPicker
                    value={current.score ?? null}
                    max={maxScore}
                    labels={SCALE_LABELS}
                    disabled={!canWrite}
                    onChange={score => set(item.id, { score })}
                  />
                </td>
                <td>
                  <input value={current.comment} disabled={!canWrite} placeholder="Evidence for this rating" onChange={e => set(item.id, { comment: e.target.value })} />
                </td>
                {mayEdit && editableStage && <td>
                  {!item.template_item_id && <button type="button" className="link-button danger" onClick={() => void removeItem(item.id)} aria-label="Remove item"><Trash2 size={14} /></button>}
                </td>}
              </tr>;
            })}
          </tbody>
        </table>
      </section>;
    })}

    {mayEdit && editableStage && <div className="scoring-foot">
      {adding ? <div className="element-add">
        <label>Section
          <select value={extra.section} onChange={e => setExtra({ ...extra, section: e.target.value })}>
            {APPRAISAL_SECTIONS.map(s => <option key={s} value={s}>{APPRAISAL_SECTION_LABELS[s]}</option>)}
          </select>
        </label>
        <label className="wide">Item<input value={extra.itemTitle} onChange={e => setExtra({ ...extra, itemTitle: e.target.value })} placeholder="What is being rated" /></label>
        <label className="wide">How success is measured<input value={extra.successMeasure} onChange={e => setExtra({ ...extra, successMeasure: e.target.value })} /></label>
        <label>Weight<input type="number" min={0.5} step="0.5" value={extra.weight} onChange={e => setExtra({ ...extra, weight: e.target.value })} /></label>
        <div className="element-add-actions">
          <button type="button" onClick={() => void addItem()}>Add item</button>
          <button type="button" className="secondary" onClick={() => setAdding(false)}>Cancel</button>
        </div>
      </div> : <button type="button" className="secondary" onClick={() => setAdding(true)}>
        <Plus size={14} style={{ verticalAlign: '-2px', marginRight: 6 }} />Add an item to this appraisal only
      </button>}
      {canWrite && <button type="button" disabled={!dirty || saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save changes'}</button>}
    </div>}
  </div>;
}

/* ── Objectives ─────────────────────────────────────────────────────────── */

function Objectives({ record, mayEdit, onError, onChanged }: {
  record: PerformanceAppraisal;
  mayEdit: boolean;
  onError: (message: string | null) => void;
  onChanged: () => Promise<void>;
}) {
  const objectives = record.objectives ?? [];
  const [form, setForm] = useState({ objective: '', successMeasure: '', targetDate: '', weight: '1' });
  const [editing, setEditing] = useState<number | null>(null);
  const [patch, setPatch] = useState({ achievementPercent: '', status: 'agreed', comments: '' });

  async function add(event: FormEvent) {
    event.preventDefault(); onError(null);
    try {
      await api(`/personnel/appraisals/${record.id}/objectives`, { method: 'POST', body: JSON.stringify(form) });
      setForm({ objective: '', successMeasure: '', targetDate: '', weight: '1' });
      await onChanged();
    } catch (e) { onError((e as Error).message); }
  }

  async function update(id: number) {
    onError(null);
    try {
      await api(`/personnel/appraisals/${record.id}/objectives/${id}`, { method: 'PUT', body: JSON.stringify(patch) });
      setEditing(null);
      await onChanged();
    } catch (e) { onError((e as Error).message); }
  }

  async function remove(id: number) {
    onError(null);
    try { await api(`/personnel/appraisals/${record.id}/objectives/${id}`, { method: 'DELETE' }); await onChanged(); }
    catch (e) { onError((e as Error).message); }
  }

  return <div className="objectives">
    <p className="muted">
      What the person is being asked to achieve, each with the measure that will decide whether it was met.
      Objectives still open when the next appraisal is raised are carried across to it, so this year's promises open next year's review.
    </p>

    {objectives.length === 0
      ? <EmptyState title="No objectives yet" message="Agree what the coming period is for, and how it will be judged." />
      : <table className="data-table">
        <thead><tr><th style={{ width: '4%' }}>#</th><th>Objective</th><th style={{ width: '24%' }}>How success is measured</th><th style={{ width: '11%' }}>Target</th><th style={{ width: '7%' }}>Weight</th><th style={{ width: '18%' }}>Progress</th>{mayEdit && <th style={{ width: '9%' }} />}</tr></thead>
        <tbody>
          {objectives.map((o, index) => <tr key={o.id}>
            <td>{index + 1}</td>
            <td>{o.objective}{o.carried_from_id ? <><br /><small className="muted">Carried forward from the previous appraisal</small></> : null}{o.comments && <><br /><small className="muted">{o.comments}</small></>}</td>
            <td><small>{o.success_measure || '—'}</small></td>
            <td>{o.target_date || '—'}</td>
            <td>{o.weight}</td>
            <td>
              {badgeFor(o.status)}
              {o.achievement_percent !== null && o.achievement_percent !== undefined && <><br /><small className="muted">{o.achievement_percent}% achieved</small></>}
            </td>
            {mayEdit && <td>
              <button type="button" className="link-button" onClick={() => { setEditing(o.id); setPatch({ achievementPercent: o.achievement_percent === null || o.achievement_percent === undefined ? '' : String(o.achievement_percent), status: o.status, comments: o.comments ?? '' }); }}>Update</button>
              <button type="button" className="link-button danger" onClick={() => void remove(o.id)} aria-label="Remove objective"><Trash2 size={14} /></button>
            </td>}
          </tr>)}
        </tbody>
      </table>}

    {editing !== null && <div className="element-add">
      <label>Status
        <select value={patch.status} onChange={e => setPatch({ ...patch, status: e.target.value })}>
          {APPRAISAL_OBJECTIVE_STATUSES.map(s => <option key={s} value={s}>{labelise(s)}</option>)}
        </select>
      </label>
      <label>Achieved (%)<input type="number" min={0} max={100} value={patch.achievementPercent} onChange={e => setPatch({ ...patch, achievementPercent: e.target.value })} /></label>
      <label className="wide">Comments<textarea rows={2} value={patch.comments} onChange={e => setPatch({ ...patch, comments: e.target.value })} /></label>
      <div className="element-add-actions">
        <button type="button" onClick={() => void update(editing)}>Save progress</button>
        <button type="button" className="secondary" onClick={() => setEditing(null)}>Cancel</button>
      </div>
    </div>}

    {mayEdit && <form className="form-grid" onSubmit={add}>
      <label className="wide">Objective<input value={form.objective} onChange={e => setForm({ ...form, objective: e.target.value })} required placeholder="e.g. Complete blood bank competency reverification" /></label>
      <label className="wide">How success is measured<input value={form.successMeasure} onChange={e => setForm({ ...form, successMeasure: e.target.value })} placeholder="What will show it was achieved" /></label>
      <label>Target date<input type="date" value={form.targetDate} onChange={e => setForm({ ...form, targetDate: e.target.value })} /></label>
      <label>Weight<input type="number" min={0.5} step="0.5" value={form.weight} onChange={e => setForm({ ...form, weight: e.target.value })} /></label>
      <button type="submit">Add objective</button>
    </form>}
  </div>;
}

/* ── Development plan ───────────────────────────────────────────────────── */

function DevelopmentPlan({ record, staff, mayEdit, onError, onChanged, onAct }: {
  record: PerformanceAppraisal;
  staff: Staff[];
  mayEdit: boolean;
  onError: (message: string | null) => void;
  onChanged: () => Promise<void>;
  onAct: (path: string, body: unknown, message: string) => Promise<void>;
}) {
  const actions = record.development_actions ?? [];
  const unraised = actions.filter(a => !a.linked_action_id && a.status !== 'cancelled');
  const [form, setForm] = useState({ action: '', actionType: 'training', developmentNeed: '', targetDate: '', responsibleStaffId: '' });

  async function add(event: FormEvent) {
    event.preventDefault(); onError(null);
    try {
      await api(`/personnel/appraisals/${record.id}/development-actions`, { method: 'POST', body: JSON.stringify(form) });
      setForm({ action: '', actionType: form.actionType, developmentNeed: '', targetDate: '', responsibleStaffId: '' });
      await onChanged();
    } catch (e) { onError((e as Error).message); }
  }

  async function remove(id: number) {
    onError(null);
    try { await api(`/personnel/appraisals/${record.id}/development-actions/${id}`, { method: 'DELETE' }); await onChanged(); }
    catch (e) { onError((e as Error).message); }
  }

  return <div className="development-plan">
    <p className="muted">
      What will be done about the development needs the appraisal identified. Raising these as tracked actions puts them on somebody's list of work
      rather than leaving them in a document nobody reopens until next year.
    </p>

    {actions.length === 0
      ? <EmptyState title="No development actions" message="Agree what training, mentoring or reassessment follows from this appraisal." />
      : <table className="data-table">
        <thead><tr><th style={{ width: '4%' }}>#</th><th>Action</th><th style={{ width: '16%' }}>Type</th><th style={{ width: '20%' }}>Development need</th><th style={{ width: '11%' }}>Target</th><th style={{ width: '14%' }}>Responsible</th><th style={{ width: '12%' }}>Status</th>{mayEdit && <th style={{ width: '4%' }} />}</tr></thead>
        <tbody>
          {actions.map((a, index) => <tr key={a.id}>
            <td>{index + 1}</td>
            <td>{a.action}{a.linked_action_id && <><br /><small className="muted">Raised as a tracked action</small></>}</td>
            <td><small>{DEVELOPMENT_ACTION_TYPE_LABELS[a.action_type] || labelise(a.action_type)}</small></td>
            <td><small>{a.development_need || '—'}</small></td>
            <td>{a.target_date || '—'}</td>
            <td>{a.responsible_name || record.staff_name || '—'}</td>
            <td>{badgeFor(a.status, APPRAISAL_STATUS_LABELS[a.status])}</td>
            {mayEdit && <td>{!a.linked_action_id && <button type="button" className="link-button danger" onClick={() => void remove(a.id)} aria-label="Remove action"><Trash2 size={14} /></button>}</td>}
          </tr>)}
        </tbody>
      </table>}

    {mayEdit && unraised.length > 0 && <div className="signoff-card">
      <h4>Put the plan into effect</h4>
      <p className="muted">{unraised.length} action(s) have not yet been raised as tracked work with an owner and a due date.</p>
      <button type="button" onClick={() => void onAct('/raise-development-actions', {}, `${unraised.length} development action(s) raised.`)}>
        Raise {unraised.length} tracked action(s)
      </button>
    </div>}

    {mayEdit && <form className="form-grid" onSubmit={add}>
      <label className="wide">Action<input value={form.action} onChange={e => setForm({ ...form, action: e.target.value })} required placeholder="e.g. Attend transfusion science refresher" /></label>
      <label>Type
        <select value={form.actionType} onChange={e => setForm({ ...form, actionType: e.target.value })}>
          {DEVELOPMENT_ACTION_TYPES.map(t => <option key={t} value={t}>{DEVELOPMENT_ACTION_TYPE_LABELS[t]}</option>)}
        </select>
      </label>
      <label>Development need<input value={form.developmentNeed} onChange={e => setForm({ ...form, developmentNeed: e.target.value })} placeholder="What gap this closes" /></label>
      <label>Target date<input type="date" value={form.targetDate} onChange={e => setForm({ ...form, targetDate: e.target.value })} /></label>
      <label>Responsible
        <select value={form.responsibleStaffId} onChange={e => setForm({ ...form, responsibleStaffId: e.target.value })}>
          <option value="">{record.staff_name || 'The member of staff'}</option>
          {staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}
        </select>
      </label>
      <button type="submit">Add development action</button>
    </form>}
  </div>;
}

/* ── Details ────────────────────────────────────────────────────────────── */

function AppraisalDetails({ record, staff, sections, positions, editable, onError, onChanged }: {
  record: PerformanceAppraisal;
  staff: Staff[];
  sections: Section[];
  positions: Position[];
  editable: boolean;
  onError: (message: string | null) => void;
  onChanged: () => Promise<void>;
}) {
  const [form, setForm] = useState({
    appraisalDate: record.appraisal_date,
    appraisalType: record.appraisal_type,
    periodStart: record.period_start ?? '',
    periodEnd: record.period_end ?? '',
    appraiserStaffId: record.appraiser_staff_id ? String(record.appraiser_staff_id) : '',
    reviewerStaffId: record.reviewer_staff_id ? String(record.reviewer_staff_id) : '',
    sectionId: record.section_id ? String(record.section_id) : '',
    positionId: record.position_id ? String(record.position_id) : '',
    strengths: record.strengths ?? '',
    developmentAreas: record.development_areas ?? '',
    trainingNeeds: record.training_needs ?? '',
    appraiserComments: record.appraiser_comments ?? '',
    nextAppraisalDue: record.next_appraisal_due ?? '',
    notes: record.notes ?? '',
  });
  const [saved, setSaved] = useState(false);

  async function save(event: FormEvent) {
    event.preventDefault(); onError(null); setSaved(false);
    try {
      await api(`/personnel/appraisals/${record.id}`, { method: 'PUT', body: JSON.stringify(form) });
      setSaved(true);
      await onChanged();
    } catch (e) { onError((e as Error).message); }
  }

  if (!editable) {
    return <dl className="record-facts">
      <div><dt>Member of staff</dt><dd>{record.staff_name}{record.employee_no ? ` (${record.employee_no})` : ''}</dd></div>
      <div><dt>Designation</dt><dd>{record.designation || record.position_title || '—'}</dd></div>
      <div><dt>Unit / section</dt><dd>{record.section_name || '—'}</dd></div>
      <div><dt>Cycle</dt><dd>{record.cycle_name || 'Outside a cycle'}</dd></div>
      <div><dt>Template</dt><dd>{record.template_title || '—'}</dd></div>
      <div><dt>Review period</dt><dd>{record.period_start || '—'} to {record.period_end || '—'}</dd></div>
      <div><dt>Appraisal date</dt><dd>{record.appraisal_date}</dd></div>
      <div><dt>Appraiser</dt><dd>{record.appraiser_name || '—'}</dd></div>
      <div><dt>Second-level reviewer</dt><dd>{record.reviewer_name || '—'}</dd></div>
      <div><dt>Next appraisal due</dt><dd>{record.next_appraisal_due || '—'}</dd></div>
      <div className="wide"><dt>Strengths</dt><dd className="prewrap">{record.strengths || '—'}</dd></div>
      <div className="wide"><dt>Areas for development</dt><dd className="prewrap">{record.development_areas || '—'}</dd></div>
      <div className="wide"><dt>Training needs</dt><dd className="prewrap">{record.training_needs || '—'}</dd></div>
      <div className="wide"><dt>Appraiser's comments</dt><dd className="prewrap">{record.appraiser_comments || '—'}</dd></div>
    </dl>;
  }

  return <form className="form-grid" onSubmit={save}>
    <label>Appraisal date<input type="date" value={form.appraisalDate} onChange={e => setForm({ ...form, appraisalDate: e.target.value })} required /></label>
    <label>Type
      <select value={form.appraisalType} onChange={e => setForm({ ...form, appraisalType: e.target.value })}>
        {APPRAISAL_TYPES.map(t => <option key={t} value={t}>{APPRAISAL_TYPE_LABELS[t]}</option>)}
      </select>
    </label>
    <label>Period start<input type="date" value={form.periodStart} onChange={e => setForm({ ...form, periodStart: e.target.value })} /></label>
    <label>Period end<input type="date" value={form.periodEnd} onChange={e => setForm({ ...form, periodEnd: e.target.value })} /></label>
    <label>Appraiser
      <select value={form.appraiserStaffId} onChange={e => setForm({ ...form, appraiserStaffId: e.target.value })}>
        <option value="">—</option>{staff.filter(s => s.id !== record.staff_id).map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}
      </select>
    </label>
    <label>Second-level reviewer
      <select value={form.reviewerStaffId} onChange={e => setForm({ ...form, reviewerStaffId: e.target.value })}>
        <option value="">—</option>{staff.filter(s => s.id !== record.staff_id && String(s.id) !== form.appraiserStaffId).map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}
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
    <label>Next appraisal due<input type="date" value={form.nextAppraisalDue} onChange={e => setForm({ ...form, nextAppraisalDue: e.target.value })} /></label>
    <label className="wide">Strengths<textarea rows={3} value={form.strengths} onChange={e => setForm({ ...form, strengths: e.target.value })} /></label>
    <label className="wide">Areas for development<textarea rows={3} value={form.developmentAreas} onChange={e => setForm({ ...form, developmentAreas: e.target.value })} /></label>
    <label className="wide">Training needs identified<textarea rows={2} value={form.trainingNeeds} onChange={e => setForm({ ...form, trainingNeeds: e.target.value })} /></label>
    <label className="wide">Appraiser's comments<textarea rows={3} value={form.appraiserComments} onChange={e => setForm({ ...form, appraiserComments: e.target.value })} /></label>
    <div className="element-add-actions">
      <button type="submit">Save</button>
      {saved && <span className="saved-flag">Saved</span>}
    </div>
  </form>;
}

/* ── Sign-off ───────────────────────────────────────────────────────────── */

function AppraisalSignOff({ record, staff, summary, mayEdit, mayApprove, mayArchive, isSubject, onAct }: {
  record: PerformanceAppraisal;
  staff: Staff[];
  summary?: PerformanceAppraisal['score_summary'];
  mayEdit: boolean;
  mayApprove: boolean;
  mayArchive: boolean;
  isSubject: boolean;
  onAct: (path: string, body: unknown, message: string) => Promise<void>;
}) {
  const [self, setSelf] = useState({ selfOverallComments: record.self_overall_comments ?? '' });
  const [submit, setSubmit] = useState({
    recommendation: record.recommendation ?? '',
    appraiserComments: record.appraiser_comments ?? '',
    strengths: record.strengths ?? '',
    developmentAreas: record.development_areas ?? '',
    trainingNeeds: record.training_needs ?? '',
    nextAppraisalDue: record.next_appraisal_due ?? '',
    reviewerStaffId: record.reviewer_staff_id ? String(record.reviewer_staff_id) : '',
  });
  const [moderate, setModerate] = useState({ reviewerStaffId: record.reviewer_staff_id ? String(record.reviewer_staff_id) : '', reviewerComments: '' });
  const [ack, setAck] = useState({ employeeComments: '' });
  const [cancelReason, setCancelReason] = useState('');
  const [showCancel, setShowCancel] = useState(false);

  const unrated = (summary?.itemsTotal ?? 0) - (summary?.itemsScored ?? 0);
  const closed = record.status === 'completed' || record.status === 'acknowledged';

  return <div className="sign-off">
    <ol className="workflow-track">
      {[
        { key: 'self', label: 'Self-assessment', done: !!record.self_assessment_submitted_at, detail: record.self_assessment_submitted_at ? String(record.self_assessment_submitted_at).slice(0, 10) : (record.status === 'self_assessment' ? 'With the member of staff' : undefined) },
        { key: 'appraiser', label: "Appraiser's rating", done: !!record.appraiser_submitted_at, detail: record.appraiser_submitted_at ? String(record.appraiser_submitted_at).slice(0, 10) : (record.status === 'appraiser_review' ? 'In progress' : undefined) },
        { key: 'moderate', label: 'Second-level review', done: !!record.reviewed_at, detail: record.reviewer_name ?? (record.status === 'pending_moderation' ? 'Awaiting the reviewer' : undefined) },
        { key: 'ack', label: 'Signed by the member of staff', done: !!record.employee_acknowledged_at, detail: record.employee_acknowledged_at ? String(record.employee_acknowledged_at).slice(0, 10) : undefined },
      ].map(step => <li key={step.key} className={step.done ? 'done' : ''}>
        <span className="wt-label">{step.label}</span>
        {step.detail && <span className="wt-detail">{step.detail}</span>}
      </li>)}
    </ol>

    {record.status === 'self_assessment' && isSubject && <section className="signoff-card">
      <h4>Submit your self-assessment</h4>
      <p className="muted">Rate yourself against each item under <strong>Ratings</strong> first. Your ratings stay on the record beside your appraiser's, so the discussion starts from both views.</p>
      <div className="form-grid">
        <label className="wide">Anything you want to say about the period<textarea rows={3} value={self.selfOverallComments} onChange={e => setSelf({ selfOverallComments: e.target.value })} /></label>
        <button type="button" onClick={() => void onAct('/submit-self-assessment', self, 'Self-assessment sent to your appraiser.')}>Submit to my appraiser</button>
      </div>
    </section>}

    {record.status === 'self_assessment' && !isSubject && <p className="notice-warn">
      Waiting for {record.staff_name} to complete their self-assessment. You can still record your own ratings in the meantime.
    </p>}

    {!closed && mayEdit && !isSubject && <section className="signoff-card">
      <h4>Complete the appraisal</h4>
      <p className="muted">
        {unrated > 0
          ? <>Every item has to be rated before the appraisal can be completed — <strong>{unrated}</strong> still unrated.</>
          : <>Overall {summary?.overallPercent ?? '—'}%{summary?.band ? ` — ${summary.band}` : ''}. Record the recommendation and close your part of the appraisal.</>}
      </p>
      <div className="form-grid">
        <label>Overall recommendation
          <select value={submit.recommendation} onChange={e => setSubmit({ ...submit, recommendation: e.target.value })} required>
            <option value="">—</option>
            {APPRAISAL_RECOMMENDATIONS.map(r => <option key={r} value={r}>{APPRAISAL_RECOMMENDATION_LABELS[r]}</option>)}
          </select>
        </label>
        <label>Second-level reviewer
          <select value={submit.reviewerStaffId} onChange={e => setSubmit({ ...submit, reviewerStaffId: e.target.value })}>
            <option value="">Decide later</option>
            {staff.filter(s => s.id !== record.staff_id && s.id !== record.appraiser_staff_id).map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}
          </select>
        </label>
        <label>Next appraisal due<input type="date" value={submit.nextAppraisalDue} onChange={e => setSubmit({ ...submit, nextAppraisalDue: e.target.value })} /></label>
        <label className="wide">Strengths<textarea rows={2} value={submit.strengths} onChange={e => setSubmit({ ...submit, strengths: e.target.value })} /></label>
        <label className="wide">Areas for development<textarea rows={2} value={submit.developmentAreas} onChange={e => setSubmit({ ...submit, developmentAreas: e.target.value })} /></label>
        <label className="wide">Training needs<textarea rows={2} value={submit.trainingNeeds} onChange={e => setSubmit({ ...submit, trainingNeeds: e.target.value })} /></label>
        <label className="wide">Appraiser's comments<textarea rows={3} value={submit.appraiserComments} onChange={e => setSubmit({ ...submit, appraiserComments: e.target.value })} /></label>
        <button type="button" disabled={!submit.recommendation || unrated > 0}
          onClick={() => void onAct('/submit-appraisal', submit, 'Appraisal completed.')}>Complete the appraisal</button>
      </div>
    </section>}

    {record.status === 'pending_moderation' && mayApprove && <section className="signoff-card">
      <h4>Second-level review</h4>
      <p className="muted">Moderation keeps ratings comparable across the laboratory. The reviewer cannot be the appraiser or the person being appraised.</p>
      <div className="form-grid">
        <label>Reviewer
          <select value={moderate.reviewerStaffId} onChange={e => setModerate({ ...moderate, reviewerStaffId: e.target.value })}>
            <option value="">Me</option>
            {staff.filter(s => s.id !== record.staff_id && s.id !== record.appraiser_staff_id).map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}
          </select>
        </label>
        <label className="wide">Reviewer's comments<textarea rows={3} value={moderate.reviewerComments} onChange={e => setModerate({ ...moderate, reviewerComments: e.target.value })} /></label>
        <button type="button" onClick={() => void onAct('/moderate', moderate, 'Second-level review recorded.')}>Record the review</button>
      </div>
    </section>}

    {record.reviewed_at && <section className="signoff-card done">
      <h4>Second-level review</h4>
      <p><strong>{record.reviewer_name || '—'}</strong> · {String(record.reviewed_at).slice(0, 10)}</p>
      {record.reviewer_comments && <p className="prewrap">{record.reviewer_comments}</p>}
    </section>}

    {record.status === 'completed' && isSubject && <section className="signoff-card">
      <h4>Your signature</h4>
      <p className="muted">Signing records that the appraisal was discussed with you. It does not signify agreement — anything you disagree with belongs in the box, and it stays on the record.</p>
      <div className="form-grid">
        <label className="wide">Your comments<textarea rows={3} value={ack.employeeComments} onChange={e => setAck({ employeeComments: e.target.value })} /></label>
        <button type="button" onClick={() => void onAct('/acknowledge', ack, 'Appraisal acknowledged.')}>Sign this appraisal</button>
      </div>
    </section>}

    {record.employee_acknowledged_at && <section className="signoff-card done">
      <h4>Signed by the member of staff</h4>
      <p>{record.staff_name} · {String(record.employee_acknowledged_at).slice(0, 10)}</p>
      {record.employee_comments && <p className="prewrap">{record.employee_comments}</p>}
    </section>}

    {record.status === 'completed' && !isSubject && !record.employee_acknowledged_at && <p className="notice-warn">
      Waiting for {record.staff_name} to sign this appraisal from their own profile.
    </p>}

    {!closed && mayArchive && <section className="signoff-card">
      {showCancel ? <div className="form-grid">
        <label className="wide">Reason for cancelling<textarea rows={2} value={cancelReason} onChange={e => setCancelReason(e.target.value)} /></label>
        <div className="element-add-actions">
          <button type="button" className="secondary danger-text" disabled={!cancelReason.trim()}
            onClick={() => void onAct('/cancel', { reason: cancelReason }, 'Appraisal cancelled.')}>Confirm cancellation</button>
          <button type="button" className="secondary" onClick={() => setShowCancel(false)}>Keep it open</button>
        </div>
      </div> : <button type="button" className="link-button danger" onClick={() => setShowCancel(true)}>Cancel this appraisal</button>}
    </section>}
  </div>;
}
