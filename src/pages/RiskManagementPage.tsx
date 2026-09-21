import { FormEvent, useEffect, useMemo, useState } from 'react';
import PageHeader from '../components/ui/PageHeader';
import { KpiStrip, ChartCard, DonutChart, BarMeter, CHART_COLORS, ModuleAlerts } from '../components/ui';
import { Notice } from '../components/ui/Feedback';
import TextField from '../components/ui/TextField';
import DisabledModule from '../components/DisabledModule';
import { usePermittedTabs } from '../components/PermissionTabs';
import { usePermissions } from '../hooks/usePermissions';
import { useModules } from '../hooks/useModules';
import { useCappedRows } from '../hooks/useCappedRows';
import { useFocusTarget, focusAttr } from '../hooks/useFocusTarget';
import { api, errorText } from '../services/api';
import { useLookupData, formatBadge, openPrintWindow } from './qmsShared';
import { downloadXlsx } from '../services/xlsx';
import RiskStepper from './risk/RiskStepper';
import RiskDetailModal from './risk/RiskDetail';
import {
  AcceptanceStage, AnalysisStage, EvaluationStage, MonitoringStage, ResidualStage, TreatmentStage,
} from './risk/RiskStages';
import {
  BandChip, RISK_CATEGORIES, RISK_SOURCES, chosenLabel, fmtDate, useRiskCriteria,
  type RiskRow,
} from './risk/riskShared';

// ==========================================================================
// Risk management.
//
// One register, worked through in steps, each step its own tab: a risk is
// identified, assessed on the laboratory's 5x5 matrix, evaluated against its
// own acceptance criteria, controlled, re-scored, accepted by an authorising
// officer, then reviewed on a cycle its band decides. Finishing a step hands
// the risk to the next one, so nothing is left between two tabs.
//
// How far a risk is carried follows its size: a band the laboratory sets no
// review cycle for is closed once accepted, so the queues hold only the risks
// that still need attention.
// ==========================================================================

const RISK_TABS = [
  'Dashboard', 'Risk Register', 'Risk Identification', 'Risk Assessment', 'Risk Evaluation',
  'Risk Control', 'Residual Risk', 'Risk Acceptance', 'Monitoring & Review', 'Risk Report',
];

const STAGE_LABELS: Record<string, string> = {
  identification: 'Identification', analysis: 'Assessment', evaluation: 'Evaluation',
  treatment: 'Control', residual: 'Residual risk', acceptance: 'Acceptance',
  monitoring: 'Monitoring', closed: 'Closed',
};

const STAGE_TAB: Record<string, string> = {
  analysis: 'Risk Assessment', evaluation: 'Risk Evaluation', treatment: 'Risk Control',
  residual: 'Residual Risk', acceptance: 'Risk Acceptance', monitoring: 'Monitoring & Review',
};

export function RisksPage({ embedded = false }: { embedded?: boolean } = {}) {
  const { can } = usePermissions();
  const { isEnabled } = useModules();
  const { staff, sections } = useLookupData();
  const criteria = useRiskCriteria();

  const [tab, setTab] = useState(embedded ? 'Risk Register' : 'Dashboard');
  const [risks, setRisks] = useState<RiskRow[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyExport, setBusyExport] = useState(false);
  useFocusTarget(risks);

  const [search, setSearch] = useState('');
  const [stageFilter, setStageFilter] = useState('');
  const [levelFilter, setLevelFilter] = useState('');
  // The register shows everything by default. A risk that was closed is still
  // part of the register — hiding it was how a risk seemed to disappear the
  // moment it was closed, while the export still carried it.
  const [statusFilter, setStatusFilter] = useState('');

  const blank = {
    sectionId: '', riskCategory: 'examination', riskCategoryOther: '',
    riskSource: 'proactive_assessment', riskSourceOther: '', processAffected: '',
    riskArea: '', riskDescription: '', cause: '', consequence: '', existingControls: '',
    identifiedDate: new Date().toISOString().slice(0, 10), identifiedByStaffId: '', identifiedByOther: '',
    responsibleStaffId: '', affectsPatientSafety: false,
  };
  const [form, setForm] = useState(blank);

  async function load() {
    setLoading(true);
    try { setRisks(await api<RiskRow[]>('/risks')); setError(null); }
    catch (e) { setError(errorText(e)); }
    finally { setLoading(false); }
  }
  useEffect(() => { if (embedded || isEnabled('risks')) void load(); }, [isEnabled]);

  async function exportRegister() {
    setBusyExport(true); setError(null);
    try { await downloadXlsx('/risks/register/export', 'Risk_Register.xlsx'); }
    catch (e) { setError(errorText(e)); } finally { setBusyExport(false); }
  }

  /** Every stage reports back here: refresh, say what happened, open the next queue. */
  function stageChanged(message?: string, nextTab?: string) {
    void load();
    if (message) setMsg(message);
    if (nextTab) setTab(nextTab);
  }

  async function identify(e: FormEvent) {
    e.preventDefault(); setError(null); setMsg(null);
    if (!form.riskArea.trim() || !form.riskDescription.trim()) {
      setError('A risk area and a description of the risk are required.');
      return;
    }
    if (form.identifiedByStaffId === 'other' && !form.identifiedByOther.trim()) {
      setError('Name the person or body who identified this risk.'); return;
    }
    if (form.riskCategory === 'other' && !form.riskCategoryOther.trim()) {
      setError('Specify the risk category.'); return;
    }
    if (form.riskSource === 'other' && !form.riskSourceOther.trim()) {
      setError('Specify how the risk was identified.'); return;
    }
    try {
      const r = await api<{ riskNumber: string }>('/risks', { method: 'POST', body: JSON.stringify(form) });
      setForm(blank); await load();
      setMsg(`Risk ${r.riskNumber} identified. It now appears in the Risk Assessment queue.`);
      setTab('Risk Assessment');
    } catch (err) { setError(errorText(err)); }
  }

  const open = useMemo(() => risks.filter(r => r.status !== 'closed'), [risks]);
  const atStage = (stage: string) => open.filter(r => (r.workflow_stage || 'analysis') === stage);
  const today = new Date().toISOString().slice(0, 10);

  const counts = useMemo(() => ({
    'Risk Assessment': atStage('analysis').length,
    'Risk Evaluation': atStage('evaluation').length,
    'Risk Control': atStage('treatment').length,
    'Residual Risk': atStage('residual').length,
    'Risk Acceptance': atStage('acceptance').length,
    'Monitoring & Review': open.filter(r => r.review_due_date && r.review_due_date <= today).length,
  }), [open]);

  const filtered = useMemo(() => risks.filter(r => {
    const t = search.toLowerCase();
    const matches = !t || r.risk_number.toLowerCase().includes(t) || r.risk_area.toLowerCase().includes(t)
      || (r.risk_description || '').toLowerCase().includes(t)
      || (r.section_name || '').toLowerCase().includes(t)
      || (r.responsible_name || '').toLowerCase().includes(t);
    const stageOk = !stageFilter || (r.workflow_stage || 'analysis') === stageFilter;
    const levelOk = !levelFilter || (r.residual_level || r.risk_level) === levelFilter;
    const statusOk = !statusFilter || (statusFilter === 'closed' ? r.status === 'closed' : r.status !== 'closed');
    return matches && stageOk && levelOk && statusOk;
  }), [risks, search, stageFilter, levelFilter, statusFilter]);
  const page = useCappedRows(filtered);

  const permitted = usePermittedTabs('risks', RISK_TABS.filter(name => !embedded || name !== 'Dashboard'), tab, setTab);
  if (!embedded && !isEnabled('risks')) return <DisabledModule />;

  const stageProps = { rows: [] as RiskRow[], criteria, staff, onChanged: stageChanged, onOpen: (id: number) => setSelected(id) };
  const byLevel = criteria.bands.map((b, i) => ({
    label: b.label, value: open.filter(r => (r.residual_level || r.risk_level) === b.level).length, color: b.color || CHART_COLORS[i % CHART_COLORS.length],
  }));

  return <div>
    {!embedded && <PageHeader eyebrow="Assessments" title="Risk Management"
      subtitle="Identify, analyse, evaluate, treat, accept and review risk across the laboratory — one connected workflow." />}

    <div className="tabs">{permitted.map(name => {
      const n = (counts as Record<string, number>)[name];
      return <button key={name} type="button" className={tab === name ? 'active' : ''} onClick={() => setTab(name)}>
        {name}{n ? <span className="badge badge--warning" style={{ marginLeft: 6 }}>{n}</span> : null}
      </button>;
    })}</div>

    {error && <Notice kind="error">{error}</Notice>}
    {msg && <Notice kind="success">{msg}</Notice>}
    {loading && <div className="card"><em>Loading risk register…</em></div>}

    {/* ---- Dashboard ---- */}
    {tab === 'Dashboard' && <>
      <ModuleAlerts moduleKey="risks" />
      <KpiStrip items={[
        { label: 'Open risks', value: open.length, onClick: () => setTab('Risk Register') },
        { label: 'Awaiting assessment', value: counts['Risk Assessment'], onClick: () => setTab('Risk Assessment') },
        { label: 'Under control', value: counts['Risk Control'], tone: 'warning', onClick: () => setTab('Risk Control') },
        { label: 'Awaiting acceptance', value: counts['Risk Acceptance'], onClick: () => setTab('Risk Acceptance') },
        { label: 'Reviews due', value: counts['Monitoring & Review'], tone: 'danger', onClick: () => setTab('Monitoring & Review') },
        { label: 'Safety-related risks', value: open.filter(r => r.affects_patient_safety).length, tone: 'danger', onClick: () => setTab('Risk Register') },
      ]} />
      <div className="grid cols-2" style={{ marginTop: 18 }}>
        <ChartCard title="Risk profile" subtitle="Open register by current risk level">
          <DonutChart centerLabel="Open" data={byLevel} />
        </ChartCard>
        <ChartCard title="Where risks are sitting" subtitle="Open register by lifecycle step">
          <BarMeter data={Object.entries(STAGE_LABELS).filter(([k]) => k !== 'closed' && k !== 'identification').map(([k, l], i) => ({
            label: l, value: atStage(k).length, color: CHART_COLORS[i % CHART_COLORS.length],
          }))} />
        </ChartCard>
      </div>
      <div className="card" style={{ marginTop: 18 }}>
        <h3 style={{ margin: '0 0 8px' }}>The risk management process</h3>
        <RiskStepper active="" />
      </div>
    </>}

    {/* ---- Register ---- */}
    {tab === 'Risk Register' && <>
      <div className="dm-toolbar rk-toolbar">
        <TextField className="dm-search rk-search" placeholder="Search risk, unit or person…" value={search} onValue={setSearch} />
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} title="Status">
          <option value="">All risks</option>
          <option value="open">Open only</option>
          <option value="closed">Closed only</option>
        </select>
        <select value={stageFilter} onChange={e => setStageFilter(e.target.value)} title="Step">
          <option value="">All steps</option>
          {Object.entries(STAGE_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <select value={levelFilter} onChange={e => setLevelFilter(e.target.value)} title="Risk level">
          <option value="">All levels</option>
          {criteria.bands.map(b => <option key={b.level} value={b.level}>{b.label}</option>)}
        </select>
        {(search || statusFilter || stageFilter || levelFilter) &&
          <button className="secondary" onClick={() => { setSearch(''); setStatusFilter(''); setStageFilter(''); setLevelFilter(''); }}>Clear</button>}
        <span className="dm-count">{filtered.length} of {risks.length} risk{risks.length === 1 ? '' : 's'}</span>
        <span style={{ flex: 1 }} />
        {can('risks', 'create') && <button className="secondary rk-act" onClick={() => setTab('Risk Identification')}>＋ Identify risk</button>}
        {can('risks', 'export') && <button className="secondary rk-act" disabled={busyExport} onClick={exportRegister}>{busyExport ? 'Preparing…' : '⬇ Excel'}</button>}
        {can('risks', 'print') && <button className="secondary rk-act" onClick={() => openPrintWindow('/risks/register/print', setError)}>🖨 Print</button>}
      </div>

      <div className="dm-table-wrap">
        <table className="data-table dm-table rk-table">
          <thead><tr>
            <th className="rk-no">Risk No.</th><th className="rk-area">Risk area</th>
            <th className="rk-unit">Unit / Section</th><th>Initial</th><th>Residual</th>
            <th>Responsible</th><th>Review due</th><th>Step</th><th></th>
          </tr></thead>
          <tbody>
            {page.shown.map(r => <tr key={r.id} {...focusAttr('risks', r.id)}>
              <td className="dm-code rk-no">{r.risk_number}
                <div className="muted" style={{ fontWeight: 400, fontSize: 11 }}>{fmtDate(r.identified_date)}</div>
                {r.affects_patient_safety ? <span className="badge badge--danger" style={{ fontSize: 10 }}>safety</span> : null}
              </td>
              <td className="rk-area">{r.risk_area}
                {r.risk_category && <div className="muted" style={{ fontSize: 11 }}>{chosenLabel(RISK_CATEGORIES, r.risk_category, r.risk_category_other)}</div>}
              </td>
              <td className="rk-unit">{r.section_name || 'Laboratory-wide'}</td>
              <td><BandChip level={r.risk_level} score={r.risk_score} criteria={criteria} size="sm" /></td>
              <td>{r.residual_score != null ? <BandChip level={r.residual_level} score={r.residual_score} criteria={criteria} size="sm" /> : '—'}</td>
              <td className="rk-person">{r.treatment_owner_name || r.responsible_name || '—'}</td>
              <td className="nowrap">{fmtDate(r.review_due_date)}</td>
              <td className="nowrap">{formatBadge(r.workflow_stage)}</td>
              <td className="nowrap">
                <button onClick={() => setSelected(r.id)}>Open</button>{' '}
                {STAGE_TAB[r.workflow_stage] && r.status !== 'closed' &&
                  <button className="secondary" onClick={() => setTab(STAGE_TAB[r.workflow_stage])}>Step</button>}
              </td>
            </tr>)}
            {filtered.length === 0 && <tr><td colSpan={9} className="muted" style={{ textAlign: 'center', padding: 18 }}>No risks match the current filters.</td></tr>}
            {page.hidden > 0 && <tr><td colSpan={9} className="muted list-capped">
              Showing the most recent {page.shown.length.toLocaleString()} of {page.total.toLocaleString()} — search or filter to narrow it down.
            </td></tr>}
          </tbody>
        </table>
      </div>
    </>}

    {/* ---- Step 1: identification ---- */}
    {tab === 'Risk Identification' && <div className="card">
      <RiskStepper active="identification" />
      <h3 style={{ margin: '0 0 10px' }}>Identify a risk</h3>
      {can('risks', 'create') && <form onSubmit={identify}>
        <fieldset className="reg-section"><legend>What is the risk?</legend><div className="form-grid">
          <label>Date identified<input type="date" value={form.identifiedDate} onChange={e => setForm({ ...form, identifiedDate: e.target.value })} required /></label>
          <label>Unit / section<select value={form.sectionId} onChange={e => setForm({ ...form, sectionId: e.target.value })}>
            <option value="">Laboratory-wide</option>{sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select></label>
          {/* A risk can be found by anyone, including somebody who is not on
              the staff register — an external assessor, an inspector, a
              supplier. "Other" therefore asks who, rather than recording an
              answer nobody can trace. */}
          <label>Identified by<select value={form.identifiedByStaffId} onChange={e => setForm({ ...form, identifiedByStaffId: e.target.value })}>
            <option value="">Me</option>
            {staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}
            <option value="other">Other (external)…</option>
          </select></label>
          {form.identifiedByStaffId === 'other' && <label>Name of person or body
            <TextField value={form.identifiedByOther} onValue={v => setForm({ ...form, identifiedByOther: v })} required placeholder="e.g. External assessor, ABC Accreditation" />
          </label>}
          <label>Risk category<select value={form.riskCategory} onChange={e => setForm({ ...form, riskCategory: e.target.value })}>
            {RISK_CATEGORIES.map(c => <option key={c.v} value={c.v}>{c.l}</option>)}
          </select></label>
          {form.riskCategory === 'other' && <label>Specify the category
            <TextField value={form.riskCategoryOther} onValue={v => setForm({ ...form, riskCategoryOther: v })} required placeholder="What category is it?" />
          </label>}
          <label>How was it identified?<select value={form.riskSource} onChange={e => setForm({ ...form, riskSource: e.target.value })}>
            {RISK_SOURCES.map(c => <option key={c.v} value={c.v}>{c.l}</option>)}
          </select></label>
          {form.riskSource === 'other' && <label>Specify the source
            <TextField value={form.riskSourceOther} onValue={v => setForm({ ...form, riskSourceOther: v })} required placeholder="How was it identified?" />
          </label>}
          <label>Process affected<TextField value={form.processAffected} onValue={v => setForm({ ...form, processAffected: v })} placeholder="e.g. Sample reception" /></label>
          <label style={{ gridColumn: '1 / -1' }}>Risk area<TextField value={form.riskArea} onValue={v => setForm({ ...form, riskArea: v })} required placeholder="Short title for the risk" /></label>
          <label style={{ gridColumn: '1 / -1' }}>Description of the risk<TextField as="textarea" value={form.riskDescription} onValue={v => setForm({ ...form, riskDescription: v })} required placeholder="What could go wrong" /></label>
        </div></fieldset>
        <fieldset className="reg-section"><legend>Cause, consequence and current position</legend><div className="form-grid">
          <label style={{ gridColumn: '1 / -1' }}>Cause / source<TextField as="textarea" value={form.cause} onValue={v => setForm({ ...form, cause: v })} placeholder="What gives rise to this risk" /></label>
          <label style={{ gridColumn: '1 / -1' }}>Potential consequence<TextField as="textarea" value={form.consequence} onValue={v => setForm({ ...form, consequence: v })} placeholder="The effect on patients, staff or the service" /></label>
          <label style={{ gridColumn: '1 / -1' }}>Existing controls<TextField as="textarea" value={form.existingControls} onValue={v => setForm({ ...form, existingControls: v })} placeholder="What is already in place" /></label>
          <label>Responsible person<select value={form.responsibleStaffId} onChange={e => setForm({ ...form, responsibleStaffId: e.target.value })}>
            <option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}
          </select></label>
          <label className="check-inline" style={{ gridColumn: '1 / -1' }}>
            <input type="checkbox" checked={form.affectsPatientSafety} onChange={e => setForm({ ...form, affectsPatientSafety: e.target.checked })} /> This risk affects patient or staff safety
          </label>
        </div></fieldset>
        <button type="submit">Identify risk</button>
      </form>}
    </div>}

    {/* ---- Steps 2-7: the working queues ---- */}
    {tab === 'Risk Assessment' && <AnalysisStage {...stageProps} rows={atStage('analysis')} />}
    {tab === 'Risk Evaluation' && <EvaluationStage {...stageProps} rows={atStage('evaluation')} />}
    {tab === 'Risk Control' && <TreatmentStage {...stageProps} rows={atStage('treatment')} />}
    {tab === 'Residual Risk' && <ResidualStage {...stageProps} rows={atStage('residual')} />}
    {tab === 'Risk Acceptance' && <AcceptanceStage {...stageProps} rows={atStage('acceptance')} />}
    {tab === 'Monitoring & Review' && <MonitoringStage {...stageProps} rows={atStage('monitoring')} />}

    {/* ---- Report ---- */}
    {tab === 'Risk Report' && <RiskReport risks={risks} criteria={criteria} onOpen={id => setSelected(id)} />}

    {selected !== null && <RiskDetailModal riskId={selected} criteria={criteria}
      onClose={() => setSelected(null)} onChanged={load} />}
  </div>;
}

// --- the report tab --------------------------------------------------------

function RiskReport({ risks, criteria, onOpen }: {
  risks: RiskRow[]; criteria: ReturnType<typeof useRiskCriteria>; onOpen: (id: number) => void;
}) {
  const open = risks.filter(r => r.status !== 'closed');
  const levelOf = (r: RiskRow) => r.residual_level || r.risk_level;
  const scoreOf = (r: RiskRow) => r.residual_score ?? r.risk_score ?? 0;

  // The heat map counts the open register into the cell each risk currently
  // occupies, so the shape of the laboratory's risk is visible at a glance.
  const cell = (l: number, s: number) => open.filter(r => (r.residual_likelihood ?? r.likelihood) === l && (r.residual_severity ?? r.severity) === s).length;
  const top = [...open].sort((a, b) => scoreOf(b) - scoreOf(a)).slice(0, 10);

  const byCategory = RISK_CATEGORIES
    .map((c, i) => ({ label: c.l.split(' (')[0], value: open.filter(r => r.risk_category === c.v).length, color: CHART_COLORS[i % CHART_COLORS.length] }))
    .filter(d => d.value > 0);

  return <>
    <div className="card">
      <h3 style={{ margin: '0 0 8px' }}>Risk heat map</h3>
      <div style={{ overflowX: 'auto' }}>
        <table className="risk-matrix">
          <thead><tr>
            <th style={{ minWidth: 130 }}>Likelihood ↓ / Severity →</th>
            {criteria.severity.map(s => <th key={s.score} style={{ minWidth: 88 }}>{s.score}. {s.label}</th>)}
          </tr></thead>
          <tbody>
            {criteria.likelihood.slice().reverse().map(l => <tr key={l.score}>
              <th style={{ textAlign: 'left', minWidth: 130 }}>{l.score}. {l.label}</th>
              {criteria.severity.map(s => {
                const sc = l.score * s.score;
                const band = criteria.bands.find(b => sc >= b.min && sc <= b.max);
                const n = cell(l.score, s.score);
                return <td key={s.score} style={{ background: band?.color ?? '#999', opacity: n ? 1 : 0.32, cursor: 'default', padding: '14px 4px' }}>
                  <div style={{ fontSize: 18, fontWeight: 700, lineHeight: 1.1 }}>{n || '·'}</div>
                  <span>score {sc}</span>
                </td>;
              })}
            </tr>)}
          </tbody>
        </table>
      </div>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 10, fontSize: 11 }}>
        {criteria.bands.map(b => <span key={b.level} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <i style={{ width: 12, height: 12, background: b.color, display: 'inline-block', borderRadius: 2 }} />
          {b.label} ({b.min}–{b.max}) · reviewed every {b.reviewMonths} month(s)
        </span>)}
      </div>
    </div>

    {byCategory.length > 0 && <div className="grid cols-2">
      <ChartCard title="Risk by category" subtitle="Open register grouped by where the risk arises">
        <BarMeter data={byCategory} />
      </ChartCard>
      <ChartCard title="Position in the process" subtitle="How far open risks have travelled">
        <DonutChart centerLabel="Open" data={[
          { label: 'Being assessed', value: open.filter(r => ['analysis', 'evaluation'].includes(r.workflow_stage)).length, color: CHART_COLORS[0] },
          { label: 'Under control', value: open.filter(r => ['treatment', 'residual'].includes(r.workflow_stage)).length, color: CHART_COLORS[2] },
          { label: 'Awaiting acceptance', value: open.filter(r => r.workflow_stage === 'acceptance').length, color: CHART_COLORS[3] },
          { label: 'Monitored', value: open.filter(r => r.workflow_stage === 'monitoring').length, color: CHART_COLORS[1] },
        ]} />
      </ChartCard>
    </div>}

    <div className="card">
      <h3 style={{ margin: '0 0 8px' }}>Highest-rated open risks</h3>
      <table className="table">
        <thead><tr><th>Risk No.</th><th>Risk area</th><th>Unit / Section</th><th>Current level</th><th>Responsible person</th><th>Review due</th><th></th></tr></thead>
        <tbody>
          {top.map(r => <tr key={r.id}>
            <td>{r.risk_number}</td>
            <td>{r.risk_area}</td>
            <td>{r.section_name || 'Laboratory-wide'}</td>
            <td><BandChip level={levelOf(r)} score={scoreOf(r)} criteria={criteria} size="sm" /></td>
            <td>{r.treatment_owner_name || r.responsible_name || '—'}</td>
            <td>{fmtDate(r.review_due_date)}</td>
            <td><button onClick={() => onOpen(r.id)}>View</button></td>
          </tr>)}
          {top.length === 0 && <tr><td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 18 }}>No open risks.</td></tr>}
        </tbody>
      </table>
    </div>
  </>;
}

