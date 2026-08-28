import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Copy, Plus, Trash2 } from 'lucide-react';
import { DetailModal, EmptyState } from '../../components/ui';
import { api } from '../../services/api';
import { usePermissions } from '../../hooks/usePermissions';
import {
  PrintButton, RatingPicker, ScaleLegend, ScoreDial, StatCell, badgeFor, labelise,
} from '../personnel/competencyShared';
import type { Supplier, SupplierEvalFramework, SupplierEvalAssessment, SupplierEvalItem } from '../../../shared/types/api';

/**
 * Supplier evaluation, framework-based — the same idea as competency
 * assessment. A framework states, once, what a supplier is judged against; an
 * evaluation copies those questions, scores them, concludes with a rating and
 * prints. Carrying out an evaluation takes the approve right on suppliers, so
 * it is the managers who evaluate, while everyone may read and build frameworks.
 */

const BASE = '/supplier-inventory';
const SUPPLIER_SCALE = [
  { score: 5, label: 'Excellent', descriptor: 'Consistently exceeds the standard.' },
  { score: 4, label: 'Very good', descriptor: 'Meets the standard well.' },
  { score: 3, label: 'Good', descriptor: 'Meets the standard.' },
  { score: 2, label: 'Fair', descriptor: 'Falls short in places; watch and follow up.' },
  { score: 1, label: 'Poor', descriptor: 'Does not meet the standard.' },
];
const SCALE_LABELS = Object.fromEntries(SUPPLIER_SCALE.map(s => [s.score, s.label])) as Record<number, string>;
const RATINGS = ['approved', 'approved_conditional', 'not_approved'] as const;
const RATING_LABELS: Record<string, string> = { approved: 'Approved', approved_conditional: 'Approved with conditions', not_approved: 'Not approved' };

const VIEWS = ['Evaluations', 'Frameworks'] as const;
type View = (typeof VIEWS)[number];

export default function SupplierEvaluationWorkspace({ suppliers }: { suppliers: Supplier[] }) {
  const [view, setView] = useState<View>('Evaluations');
  return <div className="competency-workspace">
    <div className="tabs sub view-switch">
      {VIEWS.map(v => <button key={v} type="button" className={view === v ? 'active' : ''} onClick={() => setView(v)}>{v}</button>)}
    </div>
    {view === 'Evaluations' ? <EvaluationList suppliers={suppliers} /> : <FrameworkList />}
  </div>;
}

/* ── Evaluations ────────────────────────────────────────────────────────── */

const emptyEval = { supplierId: '', frameworkId: '', evaluationDate: new Date().toISOString().slice(0, 10), periodLabel: '', purpose: '' };

function EvaluationList({ suppliers }: { suppliers: Supplier[] }) {
  const { can } = usePermissions();
  const mayEvaluate = can('supplier_inventory.suppliers', 'approve');
  const [rows, setRows] = useState<SupplierEvalAssessment[]>([]);
  const [frameworks, setFrameworks] = useState<SupplierEvalFramework[]>([]);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState(emptyEval);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try { setRows(await api<SupplierEvalAssessment[]>(`${BASE}/eval-assessments`)); }
    catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { api<SupplierEvalFramework[]>(`${BASE}/eval-frameworks?status=active`).then(setFrameworks).catch(() => setFrameworks([])); }, []);

  async function submitNew(e: FormEvent) {
    e.preventDefault(); setError(null);
    try {
      const created = await api<{ id: number }>(`${BASE}/eval-assessments`, { method: 'POST', body: JSON.stringify(form) });
      setForm(emptyEval); setCreating(false); await load(); setSelectedId(created.id);
    } catch (err) { setError((err as Error).message); }
  }

  return <>
    <div className="workspace-head">
      <div>
        <h3>Supplier evaluations</h3>
        <p className="muted">Each evaluation is scored against a framework of questions, concluded with a rating, and printable. Raising one is a manager action.</p>
      </div>
      {mayEvaluate && <div className="workspace-actions">
        <button type="button" onClick={() => setCreating(v => !v)}><Plus size={15} style={{ verticalAlign: '-3px', marginRight: 6 }} />New evaluation</button>
      </div>}
    </div>
    {error && <div className="error">{error}</div>}

    {creating && mayEvaluate && <form className="form-grid" onSubmit={submitNew}>
      <label>Supplier
        <select value={form.supplierId} onChange={e => setForm({ ...form, supplierId: e.target.value })} required>
          <option value="">—</option>
          {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}{s.supplier_code ? ` (${s.supplier_code})` : ''}</option>)}
        </select>
      </label>
      <label>Framework
        <select value={form.frameworkId} onChange={e => setForm({ ...form, frameworkId: e.target.value })} required>
          <option value="">—</option>
          {frameworks.map(f => <option key={f.id} value={f.id}>{f.title} (v{f.version_label})</option>)}
        </select>
        {frameworks.length === 0 && <small className="field-hint">No active frameworks yet — build one under Frameworks and activate it.</small>}
      </label>
      <label>Evaluation date<input type="date" value={form.evaluationDate} onChange={e => setForm({ ...form, evaluationDate: e.target.value })} required /></label>
      <label>Period label<input value={form.periodLabel} onChange={e => setForm({ ...form, periodLabel: e.target.value })} placeholder="e.g. 2026 annual review" /></label>
      <label className="wide">Purpose<textarea rows={2} value={form.purpose} onChange={e => setForm({ ...form, purpose: e.target.value })} /></label>
      <button type="submit" disabled={!form.frameworkId}>Raise evaluation</button>
    </form>}

    {loading ? <p className="muted">Loading…</p> : rows.length === 0
      ? <EmptyState title="No evaluations yet" message="Raise one against an active framework." />
      : <div className="table-scroll"><table className="data-table register-table">
        <thead><tr><th>Number</th><th>Supplier</th><th>Framework</th><th>Date</th><th>Score</th><th>Rating</th><th>Stage</th><th>Next due</th><th /></tr></thead>
        <tbody>
          {rows.map(r => <tr key={r.id} className="row-click" onClick={() => setSelectedId(r.id)}>
            <td>{r.evaluation_number}</td>
            <td>{r.supplier_name}{r.supplier_code && <><br /><small className="muted">{r.supplier_code}</small></>}</td>
            <td>{r.framework_title}{r.framework_version && <><br /><small className="muted">v{r.framework_version}</small></>}</td>
            <td>{r.evaluation_date}</td>
            <td>{r.score_percent === null || r.score_percent === undefined ? <span className="muted">—</span> : <strong>{r.score_percent}%</strong>}</td>
            <td>{r.rating ? badgeFor(r.rating, RATING_LABELS[r.rating]) : <span className="muted">—</span>}</td>
            <td>{badgeFor(r.status)}</td>
            <td>{r.next_evaluation_due || <span className="muted">—</span>}</td>
            <td onClick={e => e.stopPropagation()}><button type="button" className="secondary" onClick={() => setSelectedId(r.id)}>Open</button></td>
          </tr>)}
        </tbody>
      </table></div>}

    {selectedId !== null && <EvaluationEditor id={selectedId} mayEvaluate={mayEvaluate} onClose={() => setSelectedId(null)} onChanged={load} />}
  </>;
}

function EvaluationEditor({ id, mayEvaluate, onClose, onChanged }: { id: number; mayEvaluate: boolean; onClose: () => void; onChanged: () => Promise<void> }) {
  const { can } = usePermissions();
  const mayPrint = can('supplier_inventory', 'print');
  const [record, setRecord] = useState<SupplierEvalAssessment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tab, setTab] = useState<'Scoring' | 'Conclusion'>('Scoring');

  const load = useCallback(async () => {
    try { setRecord(await api<SupplierEvalAssessment>(`${BASE}/eval-assessments/${id}`)); }
    catch (e) { setError((e as Error).message); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);
  const refresh = useCallback(async () => { await load(); await onChanged(); }, [load, onChanged]);

  if (!record) return <DetailModal open onClose={onClose} title="Supplier evaluation">{error ? <div className="error">{error}</div> : <p className="muted">Loading…</p>}</DetailModal>;

  const summary = record.score_summary;
  const closed = record.status === 'completed';
  const scorable = mayEvaluate && !closed;
  const maxScore = record.max_score ?? 4;

  return <DetailModal open onClose={onClose} width="wide"
    title={<>{record.evaluation_number} — {record.supplier_name}</>}
    subtitle={<>{record.framework_title}{record.framework_version ? ` v${record.framework_version}` : ''} · {record.evaluation_date}</>}
    header={<>{badgeFor(record.status)}{record.rating && badgeFor(record.rating, RATING_LABELS[record.rating])}{mayPrint && <PrintButton path={`${BASE}/eval-assessments/${id}/print`} label="Print record" />}</>}
  >
    {error && <div className="error">{error}</div>}
    {notice && <div className="notice-ok">{notice}</div>}
    <div className="record-summary">
      <ScoreDial percent={summary?.percent ?? null} threshold={summary?.passThreshold ?? record.pass_threshold_percent ?? null} />
      <div className="summary-stats">
        <StatCell label="Questions scored" value={`${summary?.elementsAssessed ?? 0} / ${summary?.elementsApplicable ?? summary?.elementsTotal ?? 0}`} />
        <StatCell label="Critical shortfalls" value={summary?.criticalFailures ?? 0} tone={(summary?.criticalFailures ?? 0) > 0 ? 'bad' : 'good'} />
        <StatCell label="Rating" value={record.rating ? RATING_LABELS[record.rating] : 'Not concluded'} />
        <StatCell label="Next due" value={record.next_evaluation_due || '—'} />
      </div>
    </div>

    <div className="tabs sub">
      {(['Scoring', 'Conclusion'] as const).map(t => <button key={t} type="button" className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>{t}</button>)}
    </div>

    {tab === 'Scoring' && <ScoringGrid record={record} maxScore={maxScore} scorable={scorable} onError={setError} onChanged={refresh} />}
    {tab === 'Conclusion' && <Conclusion record={record} summary={summary} mayEvaluate={mayEvaluate} onError={setError} onNotice={setNotice} onChanged={refresh} />}
  </DetailModal>;
}

type Draft = Record<number, { score?: number | null; notApplicable?: boolean; remarks?: string }>;

function ScoringGrid({ record, maxScore, scorable, onError, onChanged }: {
  record: SupplierEvalAssessment; maxScore: number; scorable: boolean; onError: (m: string | null) => void; onChanged: () => Promise<void>;
}) {
  const { can } = usePermissions();
  const items = useMemo(() => record.items ?? [], [record.items]);
  const [draft, setDraft] = useState<Draft>({});
  const [saving, setSaving] = useState(false);
  const [showRemarks, setShowRemarks] = useState(false);
  const [fillScore, setFillScore] = useState(3);
  useEffect(() => { setDraft({}); }, [record.id]);

  const value = (item: SupplierEvalItem) => ({
    score: draft[item.id]?.score !== undefined ? draft[item.id].score : item.score,
    notApplicable: draft[item.id]?.notApplicable !== undefined ? draft[item.id].notApplicable : !!item.not_applicable,
    remarks: draft[item.id]?.remarks !== undefined ? draft[item.id].remarks : (item.remarks ?? ''),
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
        return { id: Number(id), score: merged.notApplicable ? null : merged.score ?? null, notApplicable: !!merged.notApplicable, remarks: merged.remarks ?? '' };
      });
      await api(`${BASE}/eval-assessments/${record.id}/items`, { method: 'PUT', body: JSON.stringify({ items: payload }) });
      setDraft({}); await onChanged();
    } catch (e) { onError((e as Error).message); }
    finally { setSaving(false); }
  }

  function markRemaining(score: number) {
    const patch: Draft = {};
    for (const item of items) {
      const c = value(item);
      if (c.notApplicable || (c.score !== null && c.score !== undefined)) continue;
      patch[item.id] = { ...draft[item.id], score };
    }
    setDraft(d => ({ ...d, ...patch }));
  }

  const grouped = useMemo(() => {
    const map = new Map<string, SupplierEvalItem[]>();
    for (const item of items) { const k = item.group_title || 'Assessed questions'; if (!map.has(k)) map.set(k, []); map.get(k)!.push(item); }
    return Array.from(map.entries());
  }, [items]);

  if (items.length === 0) return <EmptyState title="No questions on this evaluation" message="This framework had no active questions when the evaluation was raised." />;

  return <div className="scoring">
    <div className="scoring-bar">
      <ScaleLegend scale={SUPPLIER_SCALE} max={maxScore} />
      <div className="scoring-bar-actions">
        <label className="check-inline"><input type="checkbox" checked={showRemarks} onChange={e => setShowRemarks(e.target.checked)} /> Show remarks</label>
        {scorable && <>
          <span className="fill-remaining">
            <label>Fill unscored as
              <select value={fillScore} onChange={e => setFillScore(Number(e.target.value))}>
                {Array.from({ length: maxScore }, (_, i) => maxScore - i).map(p => <option key={p} value={p}>{p} — {SCALE_LABELS[p] ?? `Level ${p}`}</option>)}
              </select>
            </label>
            <button type="button" className="secondary" onClick={() => markRemaining(fillScore)}>Apply to remaining</button>
          </span>
          {can('supplier_inventory.suppliers', 'approve') && <button type="button" disabled={!dirty || saving} onClick={() => void save()}>{saving ? 'Saving…' : dirty ? `Save ${Object.keys(draft).length} change(s)` : 'Save changes'}</button>}
        </>}
      </div>
    </div>
    {grouped.map(([group, gr]) => <section key={group} className="score-group">
      <header><h4>{group}</h4></header>
      <table className="data-table scoring-table">
        <thead><tr><th style={{ width: '4%' }}>#</th><th>Question and standard</th><th style={{ width: '26%' }}>Rating</th>{showRemarks && <th style={{ width: '26%' }}>Remarks</th>}</tr></thead>
        <tbody>
          {gr.map((item, index) => { const c = value(item); return <tr key={item.id} className={c.notApplicable ? 'row-na' : ''}>
            <td>{index + 1}</td>
            <td><strong>{item.element_text}</strong>{item.is_critical ? <span className="badge critical inline-badge">Critical</span> : null}{item.performance_criteria && <><br /><small className="muted">{item.performance_criteria}</small></>}</td>
            <td><RatingPicker value={c.score ?? null} max={maxScore} labels={SCALE_LABELS} disabled={!scorable} allowNotApplicable notApplicable={c.notApplicable}
              onChange={score => set(item.id, { score })} onNotApplicable={na => set(item.id, { notApplicable: na, score: na ? null : c.score })} /></td>
            {showRemarks && <td><input value={c.remarks} disabled={!scorable} placeholder="Evidence / note" onChange={e => set(item.id, { remarks: e.target.value })} /></td>}
          </tr>; })}
        </tbody>
      </table>
    </section>)}
  </div>;
}

function Conclusion({ record, summary, mayEvaluate, onError, onNotice, onChanged }: {
  record: SupplierEvalAssessment; summary?: SupplierEvalAssessment['score_summary']; mayEvaluate: boolean;
  onError: (m: string | null) => void; onNotice: (m: string | null) => void; onChanged: () => Promise<void>;
}) {
  const [recommended, setRecommended] = useState<string | null>(null);
  const [form, setForm] = useState({ rating: '', findings: record.findings ?? '', actionRequired: record.action_required ?? '', nextEvaluationDue: record.next_evaluation_due ?? '' });
  const [review, setReview] = useState({ reviewerComments: '' });
  const closed = record.status === 'completed';

  useEffect(() => {
    let live = true;
    api<{ recommendedRating?: string | null }>(`${BASE}/eval-assessments/${record.id}/score-summary`)
      .then(r => { if (live) { setRecommended(r.recommendedRating ?? null); setForm(f => ({ ...f, rating: f.rating || (r.recommendedRating ?? '') })); } })
      .catch(() => undefined);
    return () => { live = false; };
  }, [record.id, record.status, summary?.percent]);

  async function act(path: string, body: unknown, message: string) {
    onError(null); onNotice(null);
    try { await api(`${BASE}/eval-assessments/${record.id}${path}`, { method: 'POST', body: JSON.stringify(body) }); onNotice(message); await onChanged(); }
    catch (e) { onError((e as Error).message); }
  }

  return <div className="sign-off">
    {closed && <section className="signoff-card done">
      <h4>Concluded</h4>
      <p><strong>{RATING_LABELS[record.rating ?? ''] ?? '—'}</strong> · {record.score_percent}% · next due {record.next_evaluation_due || '—'}</p>
      {record.findings && <p className="prewrap">{record.findings}</p>}
    </section>}

    {!closed && mayEvaluate && <section className="signoff-card">
      <h4>Conclude the evaluation</h4>
      {recommended ? <p className="muted">The scores point to <strong>{RATING_LABELS[recommended]}</strong>.</p> : <p className="muted">Score at least one question first.</p>}
      <div className="form-grid">
        <label>Rating
          <select value={form.rating} onChange={e => setForm({ ...form, rating: e.target.value })}>
            <option value="">—</option>
            {RATINGS.map(r => <option key={r} value={r}>{RATING_LABELS[r]}{r === recommended ? ' (indicated)' : ''}</option>)}
          </select>
        </label>
        <label>Next evaluation due<input type="date" value={form.nextEvaluationDue} onChange={e => setForm({ ...form, nextEvaluationDue: e.target.value })} /></label>
        <label className="wide">Findings<textarea rows={2} value={form.findings} onChange={e => setForm({ ...form, findings: e.target.value })} /></label>
        <label className="wide">Action required<textarea rows={2} value={form.actionRequired} onChange={e => setForm({ ...form, actionRequired: e.target.value })} /></label>
        <button type="button" disabled={!form.rating} onClick={() => void act('/complete', form, 'Evaluation concluded and fed to the supplier register.')}>Complete evaluation</button>
      </div>
    </section>}

    {closed && mayEvaluate && !record.reviewed_at && <section className="signoff-card">
      <h4>Review</h4>
      <p className="muted">A second pair of eyes, recorded as you. The reviewer cannot be the evaluator.</p>
      <div className="form-grid">
        <label className="wide">Reviewer's comments<textarea rows={2} value={review.reviewerComments} onChange={e => setReview({ reviewerComments: e.target.value })} /></label>
        <button type="button" onClick={() => void act('/review', review, 'Review recorded.')}>Countersign as reviewer</button>
      </div>
    </section>}
    {record.reviewed_at && <section className="signoff-card done"><h4>Reviewed</h4><p><strong>{record.reviewer_name || '—'}</strong> · {String(record.reviewed_at).slice(0, 10)}</p>{record.reviewer_comments && <p className="prewrap">{record.reviewer_comments}</p>}</section>}
  </div>;
}

/* ── Frameworks ─────────────────────────────────────────────────────────── */

const emptyFramework = { title: '', category: '', versionLabel: '1.0', purpose: '', scope: '', maxScore: '4', passThresholdPercent: '70', minimumElementScore: '2', validityMonths: '12' };

function FrameworkList() {
  const { can } = usePermissions();
  const mayCreate = can('supplier_inventory.suppliers', 'create');
  const [frameworks, setFrameworks] = useState<SupplierEvalFramework[]>([]);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState(emptyFramework);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try { setFrameworks(await api<SupplierEvalFramework[]>(`${BASE}/eval-frameworks`)); }
    catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function submitNew(e: FormEvent) {
    e.preventDefault(); setError(null);
    try { const c = await api<{ id: number }>(`${BASE}/eval-frameworks`, { method: 'POST', body: JSON.stringify(form) }); setForm(emptyFramework); setCreating(false); await load(); setSelectedId(c.id); }
    catch (err) { setError((err as Error).message); }
  }

  return <>
    <div className="workspace-head">
      <div><h3>Evaluation frameworks</h3><p className="muted">What a supplier is judged against — a set of questions grouped by theme, each with the standard for an acceptable answer.</p></div>
      {mayCreate && <div className="workspace-actions"><button type="button" onClick={() => setCreating(v => !v)}><Plus size={15} style={{ verticalAlign: '-3px', marginRight: 6 }} />New framework</button></div>}
    </div>
    {error && <div className="error">{error}</div>}

    {creating && mayCreate && <form className="form-grid" onSubmit={submitNew}>
      <label>Title<input value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} required placeholder="e.g. Reagent supplier evaluation" /></label>
      <label>Applies to (category)<input value={form.category} onChange={e => setForm({ ...form, category: e.target.value })} placeholder="Reagents, services…" /></label>
      <label>Version<input value={form.versionLabel} onChange={e => setForm({ ...form, versionLabel: e.target.value })} /></label>
      <label>Top of rating scale<select value={form.maxScore} onChange={e => setForm({ ...form, maxScore: e.target.value })}><option value="4">4-point</option><option value="5">5-point</option><option value="3">3-point</option></select></label>
      <label>Pass mark (%)<input type="number" min={0} max={100} value={form.passThresholdPercent} onChange={e => setForm({ ...form, passThresholdPercent: e.target.value })} /></label>
      <label>Re-evaluate every (months)<input type="number" min={1} value={form.validityMonths} onChange={e => setForm({ ...form, validityMonths: e.target.value })} /></label>
      <label className="wide">Purpose<textarea rows={2} value={form.purpose} onChange={e => setForm({ ...form, purpose: e.target.value })} /></label>
      <button type="submit">Create framework</button>
    </form>}

    {loading ? <p className="muted">Loading…</p> : frameworks.length === 0
      ? <EmptyState title="No frameworks yet" message="Create one, add the questions, then activate it." />
      : <table className="data-table">
        <thead><tr><th>Code</th><th>Framework</th><th>Applies to</th><th>Questions</th><th>Pass mark</th><th>Status</th><th /></tr></thead>
        <tbody>
          {frameworks.map(f => <tr key={f.id} className="row-click" onClick={() => setSelectedId(f.id)}>
            <td>{f.framework_code}</td>
            <td>{f.title}<br /><small className="muted">v{f.version_label}{f.evaluation_count ? ` · ${f.evaluation_count} evaluation(s)` : ''}</small></td>
            <td>{f.category || <span className="muted">Any</span>}</td>
            <td>{f.element_count ?? 0}<small className="muted"> in {f.group_count ?? 0} group(s)</small></td>
            <td>{f.pass_threshold_percent}%</td>
            <td>{badgeFor(f.status)}</td>
            <td onClick={e => e.stopPropagation()}><button type="button" className="secondary" onClick={() => setSelectedId(f.id)}>Open</button></td>
          </tr>)}
        </tbody>
      </table>}

    {selectedId !== null && <FrameworkEditor id={selectedId} onClose={() => setSelectedId(null)} onListChanged={load} />}
  </>;
}

function FrameworkEditor({ id, onClose, onListChanged }: { id: number; onClose: () => void; onListChanged: () => Promise<void> }) {
  const { can } = usePermissions();
  const mayEdit = can('supplier_inventory.suppliers', 'edit');
  const mayCreate = can('supplier_inventory.suppliers', 'create');
  const mayApprove = can('supplier_inventory.suppliers', 'approve');
  const mayArchive = can('supplier_inventory.suppliers', 'void_archive');
  const mayPrint = can('supplier_inventory', 'print');
  const [framework, setFramework] = useState<SupplierEvalFramework | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setFramework(await api<SupplierEvalFramework>(`${BASE}/eval-frameworks/${id}`)); }
    catch (e) { setError((e as Error).message); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);
  const refresh = useCallback(async () => { await load(); await onListChanged(); }, [load, onListChanged]);

  if (!framework) return <DetailModal open onClose={onClose} title="Framework">{error ? <div className="error">{error}</div> : <p className="muted">Loading…</p>}</DetailModal>;
  const editable = mayEdit && framework.status === 'draft';
  const inUse = (framework.evaluations_raised ?? 0) > 0;

  async function setStatus(status: string) {
    setError(null);
    try { await api(`${BASE}/eval-frameworks/${id}/status`, { method: 'POST', body: JSON.stringify({ status }) }); await refresh(); }
    catch (e) { setError((e as Error).message); }
  }
  async function duplicate() {
    setError(null);
    try { await api(`${BASE}/eval-frameworks/${id}/duplicate`, { method: 'POST', body: JSON.stringify({}) }); await onListChanged(); onClose(); }
    catch (e) { setError((e as Error).message); }
  }
  async function remove() {
    setError(null);
    try { await api(`${BASE}/eval-frameworks/${id}`, { method: 'DELETE' }); await onListChanged(); onClose(); }
    catch (e) { setError((e as Error).message); }
  }

  return <DetailModal open onClose={onClose} width="wide"
    title={<>{framework.framework_code} — {framework.title}</>}
    subtitle={<>v{framework.version_label} · {framework.category || 'Any category'} · {(framework.elements ?? []).length} question(s)</>}
    header={<>{badgeFor(framework.status)}{mayPrint && <PrintButton path={`${BASE}/eval-frameworks/${id}/print`} label="Print blank form" />}</>}
    footer={<div className="modal-foot-row">
      <div className="foot-left">
        {framework.status === 'draft' && mayApprove && <button type="button" onClick={() => void setStatus('active')}>Activate framework</button>}
        {framework.status === 'active' && mayApprove && <button type="button" className="secondary" onClick={() => void setStatus('archived')}>Archive</button>}
        {framework.status === 'archived' && mayApprove && <button type="button" className="secondary" onClick={() => void setStatus('draft')}>Return to draft</button>}
        {mayCreate && <button type="button" className="secondary" onClick={() => void duplicate()}><Copy size={14} style={{ verticalAlign: '-2px', marginRight: 6 }} />New version</button>}
      </div>
      {mayArchive && !inUse && <button type="button" className="secondary danger-text" onClick={() => void remove()}>Delete</button>}
    </div>}
  >
    {error && <div className="error">{error}</div>}
    {framework.status === 'active' && <p className="notice-ok">This framework is in force. To change what it asks, take a new version.</p>}
    <QuestionBuilder framework={framework} editable={editable} onError={setError} onChanged={refresh} />
  </DetailModal>;
}

function QuestionBuilder({ framework, editable, onError, onChanged }: {
  framework: SupplierEvalFramework; editable: boolean; onError: (m: string | null) => void; onChanged: () => Promise<void>;
}) {
  const base = `${BASE}/eval-frameworks/${framework.id}`;
  const groups = framework.groups ?? [];
  const elements = framework.elements ?? [];
  const ungrouped = elements.filter(e => !e.group_id);
  const [collapsed, setCollapsed] = useState<Record<number, boolean>>({});
  const [newGroup, setNewGroup] = useState('');
  const [addingTo, setAddingTo] = useState<number | 'none' | null>(null);
  const [q, setQ] = useState({ elementText: '', performanceCriteria: '', weight: '1', isCritical: false });

  async function addGroup() {
    if (!newGroup.trim()) return;
    onError(null);
    try { await api(`${base}/groups`, { method: 'POST', body: JSON.stringify({ groupTitle: newGroup.trim() }) }); setNewGroup(''); await onChanged(); }
    catch (e) { onError((e as Error).message); }
  }
  async function removeGroup(gid: number) { onError(null); try { await api(`${base}/groups/${gid}`, { method: 'DELETE' }); await onChanged(); } catch (e) { onError((e as Error).message); } }
  async function addElement(groupId: number | 'none') {
    if (!q.elementText.trim()) { onError('A question is required.'); return; }
    onError(null);
    try { await api(`${base}/elements`, { method: 'POST', body: JSON.stringify({ ...q, groupId: groupId === 'none' ? '' : groupId }) }); setQ({ elementText: '', performanceCriteria: '', weight: '1', isCritical: false }); setAddingTo(null); await onChanged(); }
    catch (e) { onError((e as Error).message); }
  }
  async function removeElement(eid: number) { onError(null); try { await api(`${base}/elements/${eid}`, { method: 'DELETE' }); await onChanged(); } catch (e) { onError((e as Error).message); } }

  const addForm = (groupId: number | 'none') => <div className="element-add">
    <label className="wide">Question<input autoFocus value={q.elementText} onChange={e => setQ({ ...q, elementText: e.target.value })} placeholder="e.g. Delivers within the agreed lead time" /></label>
    <label className="wide">Standard for an acceptable answer<textarea rows={2} value={q.performanceCriteria} onChange={e => setQ({ ...q, performanceCriteria: e.target.value })} /></label>
    <label>Weight<input type="number" min={0.5} step="0.5" value={q.weight} onChange={e => setQ({ ...q, weight: e.target.value })} /></label>
    <label className="check-inline"><input type="checkbox" checked={q.isCritical} onChange={e => setQ({ ...q, isCritical: e.target.checked })} /> Critical — a shortfall blocks approval</label>
    <div className="element-add-actions"><button type="button" onClick={() => void addElement(groupId)}>Add question</button><button type="button" className="secondary" onClick={() => setAddingTo(null)}>Cancel</button></div>
  </div>;

  const rows = (list: typeof elements) => <table className="data-table element-table">
    <thead><tr><th style={{ width: '4%' }}>#</th><th>Question and standard</th><th style={{ width: '8%' }}>Weight</th><th style={{ width: '10%' }}>Critical</th>{editable && <th style={{ width: '5%' }} />}</tr></thead>
    <tbody>{list.map((e, i) => <tr key={e.id}>
      <td>{i + 1}</td>
      <td><strong>{e.element_text}</strong>{e.performance_criteria && <><br /><small className="muted">{e.performance_criteria}</small></>}</td>
      <td>{e.weight}</td>
      <td>{e.is_critical ? <span className="badge critical">Critical</span> : <span className="muted">—</span>}</td>
      {editable && <td><button type="button" className="link-button danger" onClick={() => void removeElement(e.id)} aria-label="Remove"><Trash2 size={14} /></button></td>}
    </tr>)}</tbody>
  </table>;

  return <div className="element-builder">
    <ScaleLegend scale={SUPPLIER_SCALE} max={framework.max_score} />
    <p className="muted">Pass mark {framework.pass_threshold_percent}%{framework.minimum_element_score ? `, with no single question below ${framework.minimum_element_score}` : ''}. Re-evaluate every {framework.validity_months} months.</p>
    {groups.length === 0 && ungrouped.length === 0 && <EmptyState title="No questions yet" message="Group the questions by theme, then add what a supplier is judged on." />}

    {groups.map(group => {
      const gr = elements.filter(e => e.group_id === group.id);
      const isCollapsed = collapsed[group.id];
      return <section key={group.id} className="element-group">
        <header>
          <button type="button" className="link-button" onClick={() => setCollapsed(c => ({ ...c, [group.id]: !c[group.id] }))}>
            {isCollapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}<span className="eg-title">{group.group_title}</span><span className="muted"> · {gr.length}</span>
          </button>
          {editable && <div className="eg-actions">
            <button type="button" className="secondary" onClick={() => { setAddingTo(group.id); setCollapsed(c => ({ ...c, [group.id]: false })); }}><Plus size={13} style={{ verticalAlign: '-2px', marginRight: 4 }} />Question</button>
            <button type="button" className="link-button danger" onClick={() => void removeGroup(group.id)} aria-label="Remove group"><Trash2 size={14} /></button>
          </div>}
        </header>
        {!isCollapsed && gr.length > 0 && rows(gr)}
        {!isCollapsed && gr.length === 0 && <p className="muted eg-desc">No questions in this group yet.</p>}
        {addingTo === group.id && addForm(group.id)}
      </section>;
    })}

    {ungrouped.length > 0 && <section className="element-group"><header><span className="eg-title">Other questions</span></header>{rows(ungrouped)}</section>}

    {editable && <div className="group-add">
      <label>New group<input value={newGroup} onChange={e => setNewGroup(e.target.value)} placeholder="e.g. Delivery and logistics" onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void addGroup(); } }} /></label>
      <button type="button" className="secondary" onClick={() => void addGroup()}>Add group</button>
      <button type="button" className="secondary" onClick={() => setAddingTo('none')}>Add ungrouped question</button>
    </div>}
    {addingTo === 'none' && addForm('none')}
  </div>;
}
