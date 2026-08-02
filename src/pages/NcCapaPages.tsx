import { FormEvent, useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import PageHeader from '../components/ui/PageHeader';
import { KpiStrip, ModuleAlerts } from '../components/ui';
import { api, API_BASE, getToken } from '../services/api';
import { useModules } from '../hooks/useModules';
import DisabledModule from '../components/DisabledModule';
import RiskMatrix, { riskLevelBadge, bandFor } from '../components/RiskMatrix';
import XlsxToolbar from '../components/XlsxToolbar';
import WorkflowStepper from '../components/WorkflowStepper';
import {
  NC_TYPE_OPTIONS, RCA_METHOD_OPTIONS, capaSourceLabel, formatBadge, fmtDate, EmptyRow,
  openPrintWindow, useLookupData, useWorkflowConfig, type CapaDetail, type LoadState,
  type NonconformingEventDetail, type WorkflowConfig,
} from './qmsShared';
import type { CapaRecord, NonconformingEvent, Section, Staff } from '../../shared/types/api';
import { usePermissions } from '../hooks/usePermissions';

// ==========================================================================
// Nonconforming Event Management — three sibling submodules that share one
// staged, risk-proportionate workflow (ISO 15189:2022 §7.5/§8.7, ISO 9001
// §10.2, ISO 22367):
//
//   Nonconformities   log → risk assessment → root cause → CAPA → closure
//   Incidents         report → risk assessment → investigation → CAPA → closure
//   CAPA              plan → implement → verify → effectiveness → closure
//
// Every corrective/preventive action, wherever it originated, is managed in
// the single CAPA register.
// ==========================================================================

const INCIDENT_TYPES = [
  { v: 'patient_safety', l: 'Patient safety event' }, { v: 'staff_safety', l: 'Staff safety / injury' },
  { v: 'near_miss', l: 'Near miss' }, { v: 'sentinel_event', l: 'Sentinel event' },
  { v: 'biosafety_exposure', l: 'Biosafety exposure' }, { v: 'needlestick', l: 'Needlestick / sharps' },
  { v: 'specimen_related', l: 'Specimen-related' }, { v: 'equipment_related', l: 'Equipment-related' },
  { v: 'data_security', l: 'Data / IT security' }, { v: 'fire_disaster', l: 'Fire / disaster' }, { v: 'other', l: 'Other' },
];
const HARM_LEVELS = [{ v: 'none', l: 'No harm' }, { v: 'minor', l: 'Minor' }, { v: 'moderate', l: 'Moderate' }, { v: 'severe', l: 'Severe' }, { v: 'death', l: 'Death' }];

type Incident = {
  id: number; incident_number: string; incident_datetime: string | null; incident_type: string | null; incident_type_other: string | null;
  is_near_miss: number; section_id: number | null; section_name: string | null; location_text: string | null; persons_involved: string | null;
  description: string | null; immediate_action: string | null; harm_level: string | null; occurrence_score: number | null; severity_score: number | null;
  risk_score: number | null; risk_level: string | null; reported_by_staff_id: number | null; reported_by_name: string | null; reported_by_full: string | null;
  investigation_team: string | null; root_cause: string | null; rca_method: string | null; contributing_factors: string | null;
  corrective_action: string | null; preventive_action: string | null; notified_to: string | null; reportable_external: number; external_authority: string | null;
  nc_id: number | null; nc_number: string | null; capa_id: number | null; capa_number: string | null; status: string; notes: string | null;
  workflow_stage: string | null; rca_required: number | null; affects_patient_safety: number | null; escalation_reason: string | null; rca_evidence_file_id: number | null;
};

// --- small presentational helpers -----------------------------------------

function Banner({ kind, children }: { kind: 'error' | 'ok' | 'info'; children: React.ReactNode }) {
  if (!children) return null;
  const cls = kind === 'error' ? 'error' : kind === 'ok' ? 'notice-ok' : 'hint';
  return <div className={cls} style={{ marginBottom: 10 }}>{children}</div>;
}

/** Tab bar shared by the three submodules. */
function Tabs({ tabs, tab, setTab, counts }: { tabs: string[]; tab: string; setTab: (t: string) => void; counts?: Record<string, number> }) {
  return <div className="tabs">{tabs.map(name => {
    const n = counts?.[name];
    return <button key={name} className={tab === name ? 'active' : ''} onClick={() => setTab(name)}>
      {name}{n ? <span className="badge badge--warning" style={{ marginLeft: 6 }}>{n}</span> : null}
    </button>;
  })}</div>;
}

/** Explains the configured auto-escalation rules wherever risk is assessed. */
function EscalationNote({ cfg }: { cfg: WorkflowConfig }) {
  const lvl = { off: null, moderate: 'Medium', high: 'High', very_high: 'Very High' }[cfg.autoEscalateRiskLevel];
  const parts: string[] = [];
  if (lvl) parts.push(`events assessed at ${lvl} risk or above escalate automatically to root-cause analysis and corrective action`);
  if (cfg.autoEscalatePatientSafety) parts.push('events affecting patient safety escalate automatically whatever their risk band');
  if (parts.length === 0) return null;
  return <p className="hint" style={{ marginTop: 6 }}>
    Escalation rules in force: {parts.join('; ')}
    {cfg.autoCreateCapaOnEscalation ? '. A CAPA record is raised automatically on escalation.' : '.'}
    {' '}<Link to="/settings/system">Change in Settings → System → Quality Workflow</Link>.
  </p>;
}

// --- risk assessment & investigation worklists ----------------------------

type WFItem = {
  id: number; ref: string; date: string; title: string; unit: string; typeLabel: string;
  risk_score: number | null; risk_level: string | null; occurrence_score: number | null; severity_score: number | null;
  description: string | null; immediate_action: string | null; rca_required: number | null; affects_patient_safety: number | null;
  investigation_team?: string | null; rca_method?: string | null; root_cause?: string | null; contributing_factors?: string | null;
  rca_evidence_file_id?: number | null;
};

/**
 * One workflow stage (risk assessment or root-cause analysis / investigation)
 * for a single record kind. Nonconformities and incidents each get their own
 * queue so the two submodules stay self-contained.
 */
function StageBoard({ kind, stage, sections, cfg, onChanged }: {
  kind: 'nc' | 'incident'; stage: 'risk_assessment' | 'rca'; sections: Section[]; cfg: WorkflowConfig; onChanged: () => void;
}) {
  const [items, setItems] = useState<WFItem[]>([]);
  const [sel, setSel] = useState<WFItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [occ, setOcc] = useState<number | null>(null);
  const [sev, setSev] = useState<number | null>(null);
  const [rcaReq, setRcaReq] = useState(false);
  const [safety, setSafety] = useState(false);
  const [notes, setNotes] = useState('');
  const [team, setTeam] = useState('');
  const [method, setMethod] = useState('5_whys');
  const [rootCause, setRootCause] = useState('');
  const [contributing, setContributing] = useState('');
  const [evidence, setEvidence] = useState<File | null>(null);
  const [hasEvidence, setHasEvidence] = useState(false);

  const isNc = kind === 'nc';
  const investigationLabel = isNc ? 'Root cause analysis' : 'Investigation';

  function load() {
    setError(null);
    const path = isNc ? '/nonconformities' : `/incidents?stage=${stage}`;
    api<any[]>(path).then(rows => {
      const mapped: WFItem[] = (rows || [])
        .filter(r => (r.workflow_stage || 'risk_assessment') === stage && r.status !== 'closed')
        .map(r => isNc ? {
          id: r.id, ref: r.nc_number, date: r.event_date, title: r.title,
          typeLabel: (r.nc_type || 'nonconformity').replace(/_/g, ' '),
          unit: sections.find(s => s.id === r.section_id)?.name || '—',
          risk_score: r.risk_score, risk_level: r.risk_level, occurrence_score: r.occurrence_score, severity_score: r.severity_score,
          description: r.description, immediate_action: r.immediate_correction, rca_required: r.rca_required,
          affects_patient_safety: r.affects_patient_safety, rca_evidence_file_id: r.rca_evidence_file_id,
          investigation_team: r.investigation_team, rca_method: r.rca_method, root_cause: r.root_cause,
        } : {
          id: r.id, ref: r.incident_number, date: (r.incident_datetime || '').slice(0, 10),
          title: r.description ? String(r.description).slice(0, 70) : (r.incident_type || 'incident').replace(/_/g, ' '),
          typeLabel: (r.incident_type || 'incident').replace(/_/g, ' '), unit: r.section_name || '—',
          risk_score: r.risk_score, risk_level: r.risk_level, occurrence_score: r.occurrence_score, severity_score: r.severity_score,
          description: r.description, immediate_action: r.immediate_action, rca_required: r.rca_required,
          affects_patient_safety: r.affects_patient_safety, rca_evidence_file_id: r.rca_evidence_file_id,
          investigation_team: r.investigation_team, rca_method: r.rca_method, root_cause: r.root_cause, contributing_factors: r.contributing_factors,
        });
      setItems(mapped.sort((a, b) => (b.date || '').localeCompare(a.date || '')));
    }).catch(e => setError((e as Error).message));
  }
  useEffect(() => { load(); }, [stage, kind, sections.length]);

  function pick(it: WFItem) {
    setSel(it); setError(null); setMsg(null);
    setOcc(it.occurrence_score ?? null); setSev(it.severity_score ?? null);
    const band = it.risk_score ? bandFor(it.risk_score) : null;
    setRcaReq(it.rca_required != null ? !!it.rca_required : !!(band && (band.level === 'high' || band.level === 'very_high')));
    setSafety(!!it.affects_patient_safety);
    setNotes('');
    setTeam(it.investigation_team || ''); setMethod(it.rca_method || '5_whys');
    setRootCause(it.root_cause || ''); setContributing(it.contributing_factors || '');
    setEvidence(null); setHasEvidence(!!it.rca_evidence_file_id);
  }
  const base = (it: WFItem) => isNc ? `/nonconformities/${it.id}` : `/incidents/${it.id}`;

  async function submitRisk() {
    if (!sel) return;
    if (!occ || !sev) { setError('Select both an occurrence and a severity score.'); return; }
    setBusy(true); setError(null);
    try {
      const r = await api<{ escalated: boolean; escalationReason: string | null; rcaRequired: boolean; capaNumber: string | null }>(
        `${base(sel)}/risk-assessment`, { method: 'POST', body: JSON.stringify({ occurrenceScore: occ, severityScore: sev, rcaRequired: rcaReq, affectsPatientSafety: safety, notes }) });
      const bits = [`Risk assessment saved for ${sel.ref}.`];
      if (r.escalated && r.escalationReason) bits.push(`Escalated automatically — ${r.escalationReason}`);
      bits.push(r.rcaRequired ? `Sent to ${investigationLabel.toLowerCase()}.` : 'Ready for CAPA.');
      if (r.capaNumber) bits.push(`CAPA ${r.capaNumber} was raised.`);
      setMsg(bits.join(' '));
      setSel(null); load(); onChanged();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function submitRca() {
    if (!sel) return;
    if (!rootCause.trim()) { setError('Record the identified root cause.'); return; }
    if (!evidence && !hasEvidence) { setError('Attach the completed root-cause analysis sheet before completing.'); return; }
    setBusy(true); setError(null);
    try {
      // Multipart so the analysis sheet is stored alongside the findings.
      const fd = new FormData();
      fd.append('investigationTeam', team); fd.append('rcaMethod', method);
      fd.append('rootCause', rootCause); fd.append('contributingFactors', contributing);
      if (evidence) fd.append('evidence', evidence);
      const token = getToken();
      const res = await fetch(`${API_BASE}${base(sel)}/rca`, { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : undefined, body: fd });
      const data = await res.json().catch(() => ({ error: res.statusText }));
      if (!res.ok) throw new Error(data.error ?? res.statusText);
      setMsg(`Root cause recorded for ${sel.ref}. Ready for CAPA.`);
      setSel(null); load(); onChanged();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  const previewScore = occ && sev ? occ * sev : null;
  const previewBand = previewScore ? bandFor(previewScore) : null;
  // Mirror the server-side rules so the assessor sees the outcome before saving.
  const threshold = { off: 99, moderate: 2, high: 3, very_high: 4 }[cfg.autoEscalateRiskLevel];
  const rank = previewBand ? ({ low: 1, moderate: 2, high: 3, very_high: 4 } as Record<string, number>)[previewBand.level] : 0;
  const willEscalate = (rank >= threshold) || (safety && cfg.autoEscalatePatientSafety);

  return <div className="card">
    <WorkflowStepper active={stage} />
    <h3 style={{ marginTop: 0 }}>{stage === 'risk_assessment' ? 'Risk assessment queue' : `${investigationLabel} queue`}</h3>
    <p className="muted" style={{ marginTop: 0 }}>{stage === 'risk_assessment'
      ? `Every ${isNc ? 'logged nonconformity' : 'reported incident'} is scored on the 5×5 matrix before it is classified. The score decides whether a full ${investigationLabel.toLowerCase()} is required — investigation proportionate to risk (ISO 22367).`
      : `${isNc ? 'Nonconformities' : 'Incidents'} whose risk warrants investigation. Record the root cause; the event then moves to CAPA. Low-risk events may proceed straight to CAPA or closure.`}</p>
    {stage === 'risk_assessment' && <EscalationNote cfg={cfg} />}
    <Banner kind="error">{error}</Banner>
    <Banner kind="ok">{msg}</Banner>
    {!cfg.canFollowUp && <Banner kind="info">You can view this queue, but completing a {stage === 'risk_assessment' ? 'risk assessment' : investigationLabel.toLowerCase()} requires reviewer permission.</Banner>}

    <table className="table" style={{ marginTop: 8 }}><thead><tr>
      <th>Ref</th><th>Date</th><th>Title</th><th>Unit</th><th>Risk</th><th>Flags</th><th></th>
    </tr></thead><tbody>
      {items.map(it => <tr key={it.id}>
        <td>{it.ref}</td>
        <td>{it.date}</td>
        <td>{it.title}<div className="muted" style={{ fontSize: 11 }}>{it.typeLabel}</div></td>
        <td>{it.unit}</td>
        <td>{it.risk_score != null ? <>{it.risk_score} {riskLevelBadge(it.risk_level)}</> : '—'}</td>
        <td>{it.affects_patient_safety ? <span className="badge badge--danger">patient safety</span> : '—'}</td>
        <td><button disabled={!cfg.canFollowUp} onClick={() => pick(it)}>{stage === 'risk_assessment' ? 'Assess' : 'Investigate'}</button></td>
      </tr>)}
      {items.length === 0 && <EmptyRow colSpan={7}>Nothing awaiting {stage === 'risk_assessment' ? 'risk assessment' : investigationLabel.toLowerCase()}.</EmptyRow>}
    </tbody></table>

    {sel && <div className="card" style={{ marginTop: 16, borderTop: '3px solid var(--primary, #2563eb)' }}>
      <div className="section-head" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <h3 style={{ margin: 0 }}>{sel.ref}</h3>
        <button style={{ marginLeft: 'auto' }} className="secondary" onClick={() => setSel(null)}>Close</button>
      </div>
      <p className="muted" style={{ fontSize: 12 }}>{sel.date} · {sel.typeLabel} · {sel.unit}</p>
      <p><strong>Description:</strong> {sel.description || '—'}</p>
      <p><strong>Immediate action taken:</strong> {sel.immediate_action || '—'}</p>

      {stage === 'risk_assessment' ? <>
        <h4 style={{ marginBottom: 4 }}>Score the risk (click a cell)</h4>
        <RiskMatrix occurrence={occ} severity={sev} onChange={(o, s) => { setOcc(o); setSev(s); }} />
        {previewBand && <p style={{ margin: '8px 0' }}>Risk score <strong>{previewScore}</strong> — {riskLevelBadge(previewBand.level)} <span className="muted">{previewBand.action}</span></p>}
        <label className="check-inline" style={{ marginTop: 6, display: 'block' }}>
          <input type="checkbox" checked={safety} onChange={e => setSafety(e.target.checked)} /> This event affects patient safety
        </label>
        <label className="check-inline" style={{ marginTop: 4, display: 'block' }}>
          <input type="checkbox" checked={rcaReq || willEscalate} disabled={willEscalate} onChange={e => setRcaReq(e.target.checked)} /> {investigationLabel} required
        </label>
        {willEscalate
          ? <p className="notice-warn" style={{ marginTop: 6 }}>This event meets the automatic escalation rules — {investigationLabel.toLowerCase()} and corrective action will be raised on save{cfg.autoCreateCapaOnEscalation ? ', including a CAPA record' : ''}.</p>
          : <p className="muted" style={{ fontSize: 12, marginTop: 2 }}>Tick this to investigate an event the rules would otherwise let through on a correction alone.</p>}
        <label style={{ display: 'block', marginTop: 8 }}>Assessment notes (optional)<textarea value={notes} onChange={e => setNotes(e.target.value)} /></label>
        <button style={{ marginTop: 10 }} disabled={busy || !cfg.canFollowUp} onClick={submitRisk}>{busy ? 'Saving…' : 'Complete risk assessment'}</button>
      </> : <>
        <p style={{ margin: '6px 0' }}>Assessed risk: {sel.risk_score != null ? <>{sel.risk_score} {riskLevelBadge(sel.risk_level)}</> : '—'}{sel.affects_patient_safety ? <span className="badge badge--danger" style={{ marginLeft: 8 }}>patient safety</span> : null}</p>
        <h4 style={{ marginBottom: 4 }}>{investigationLabel}</h4>
        <div className="form-grid">
          <label>Investigation team / person<input value={team} onChange={e => setTeam(e.target.value)} /></label>
          <label>Method<select value={method} onChange={e => setMethod(e.target.value)}>{RCA_METHOD_OPTIONS.map(m => <option key={m.v} value={m.v}>{m.l}</option>)}</select></label>
          <label style={{ gridColumn: '1 / -1' }}>Root cause(s) identified<textarea value={rootCause} onChange={e => setRootCause(e.target.value)} required /></label>
          <label style={{ gridColumn: '1 / -1' }}>Contributing factors (optional)<textarea value={contributing} onChange={e => setContributing(e.target.value)} /></label>
          <label style={{ gridColumn: '1 / -1' }}>
            Analysis sheet (the completed {(RCA_METHOD_OPTIONS.find(m => m.v === method)?.l || 'RCA')} worksheet) — required
            <input type="file" accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx" onChange={e => setEvidence(e.target.files?.[0] ?? null)} />
            {hasEvidence && !evidence && <small className="muted">An analysis sheet is already attached — <a href={`${API_BASE}${base(sel)}/rca-evidence`} target="_blank" rel="noreferrer">view it</a>. Choose a file to replace it.</small>}
          </label>
        </div>
        <button style={{ marginTop: 10 }} disabled={busy || !cfg.canFollowUp || (!evidence && !hasEvidence)} onClick={submitRca}>{busy ? 'Saving…' : `Complete ${investigationLabel.toLowerCase()}`}</button>
      </>}
    </div>}
  </div>;
}

// ==========================================================================
// Submodule 1 — Nonconformities
// ==========================================================================

// One workspace, three top-level tabs — mirroring Process Management. The
// active tab is driven by the route so cross-links (e.g. a nonconformity's
// "Managed as CAPA-…" link) and the browser back button all behave naturally.
const NC_TOP_TABS = [
  { key: 'nonconformities', label: 'Nonconformities', path: '/nonconformities' },
  { key: 'incidents', label: 'Incidents & Adverse Events', path: '/incidents' },
  { key: 'capa', label: 'CAPA', path: '/capa' },
];

export function NcCapaPage() {
  const { isEnabled } = useModules();
  const location = useLocation();
  const navigate = useNavigate();
  const active = location.pathname.startsWith('/incidents') ? 'incidents'
    : location.pathname.startsWith('/capa') ? 'capa' : 'nonconformities';
  if (!isEnabled('nc_capa')) return <DisabledModule />;
  return <div>
    <PageHeader eyebrow="Nonconforming Event Management" title="Nonconforming Event Management"
      subtitle="Nonconformities, incidents & adverse events, and corrective/preventive action — one connected workflow from logging to closure." />
    <div className="tabs">{NC_TOP_TABS.map(t => <button key={t.key} type="button" className={active === t.key ? 'active' : ''} onClick={() => navigate(t.path)}>{t.label}</button>)}</div>
    {active === 'nonconformities' && <NonconformitiesPage embedded />}
    {active === 'incidents' && <IncidentsPage embedded />}
    {active === 'capa' && <CapaPage embedded />}
  </div>;
}

export function NonconformitiesPage({ embedded = false }: { embedded?: boolean } = {}) {
  const { can } = usePermissions();
  const { isEnabled } = useModules();
  const { staff, sections } = useLookupData();
  const cfg = useWorkflowConfig();
  const [tab, setTab] = useState('Register');
  const [list, setList] = useState<NonconformingEvent[]>([]);
  const [capas, setCapas] = useState<CapaRecord[]>([]);
  const [selected, setSelected] = useState<NonconformingEventDetail | null>(null);
  const [state, setState] = useState<LoadState>({ loading: false, error: null });
  const [msg, setMsg] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const blank = {
    eventDate: new Date().toISOString().slice(0, 10), timeOfEvent: '', detectedByStaffId: '', detectedByName: '',
    sectionId: '', ncType: 'pre_analytical', ncTypeOther: '', title: '', description: '',
    immediateCorrection: '', remedialAction: '', affectsPatientSafety: false,
  };
  const [form, setForm] = useState(blank);

  async function load() {
    setState({ loading: true, error: null });
    try {
      const [ncs, cs] = await Promise.all([api<NonconformingEvent[]>('/nonconformities'), api<CapaRecord[]>('/capa').catch(() => [])]);
      setList(ncs); setCapas(cs);
      setState({ loading: false, error: null });
    } catch (e) { setState({ loading: false, error: (e as Error).message }); }
  }
  useEffect(() => { if (isEnabled('nc_capa')) void load(); }, [isEnabled]);

  async function openDetail(id: number) {
    try { setSelected(await api<NonconformingEventDetail>(`/nonconformities/${id}`)); }
    catch (e) { setState({ loading: false, error: (e as Error).message }); }
  }

  async function submitNew(e: FormEvent) {
    e.preventDefault(); setState({ loading: false, error: null }); setMsg(null);
    if (!form.title.trim() || !form.description.trim()) { setState({ loading: false, error: 'A title and a description are required.' }); return; }
    try {
      const r = await api<{ id: number; ncNumber: string }>('/nonconformities', { method: 'POST', body: JSON.stringify(form) });
      setForm(blank); await load(); setMsg(`Nonconformity ${r.ncNumber} logged. It now appears in the Risk Assessment queue.`);
      setTab('Risk Assessment');
    } catch (e) { setState({ loading: false, error: (e as Error).message }); }
  }

  const stages = useMemo(() => ({
    risk: list.filter(n => (n.workflow_stage || 'risk_assessment') === 'risk_assessment' && n.status !== 'closed').length,
    rca: list.filter(n => n.workflow_stage === 'rca' && n.status !== 'closed').length,
  }), [list]);

  const filtered = useMemo(() => list.filter(n => {
    const t = search.toLowerCase();
    const okSearch = !t || n.nc_number.toLowerCase().includes(t) || n.title.toLowerCase().includes(t) || (n.description || '').toLowerCase().includes(t);
    return okSearch && (!statusFilter || n.status === statusFilter);
  }), [list, search, statusFilter]);

  if (!isEnabled('nc_capa')) return <DisabledModule />;
  const TABS = ['Register', 'Log Event', 'Risk Assessment', 'Root Cause Analysis'];

  return <div>
    {!embedded && <PageHeader eyebrow="Nonconforming Event Management" title="Nonconformities"
      subtitle="Log a nonconforming event, assess its risk, investigate the cause where it matters, then drive corrective action to closure." />}
    <Tabs tabs={TABS} tab={tab} setTab={setTab} counts={{ 'Risk Assessment': stages.risk, 'Root Cause Analysis': stages.rca }} />
    <Banner kind="error">{state.error}</Banner>
    <Banner kind="ok">{msg}</Banner>

    {tab === 'Register' && <>
      <ModuleAlerts moduleKey="nc_capa" />
      <KpiStrip items={[
        { label: 'Open nonconformities', value: list.filter(n => n.status !== 'closed').length },
        { label: 'Awaiting risk assessment', value: stages.risk, tone: 'warning', onClick: () => setTab('Risk Assessment') },
        { label: 'Awaiting root cause', value: stages.rca, onClick: () => setTab('Root Cause Analysis') },
        { label: 'Patient-safety events', value: list.filter(n => (n as any).affects_patient_safety).length, tone: 'danger' },
        { label: 'Closed', value: list.filter(n => n.status === 'closed').length },
      ]} />
      <div className="card" style={{ marginTop: 16 }}>
        <div className="section-head" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <h3 style={{ margin: 0 }}>Nonconformity register</h3>
          <button style={{ marginLeft: 'auto' }} onClick={() => setTab('Log Event')}>+ Log nonconformity</button>
        </div>
        <XlsxToolbar module="nc_capa" exportPath="/nonconformities/register/export" templatePath="/nonconformities/register/template" importPath="/nonconformities/register/import" exportName="Nonconformities.xlsx" onImported={load} />
        <div className="form" style={{ gridTemplateColumns: '1fr auto', alignItems: 'end' }}>
          <label>Search<input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search number, title or description" /></label>
          <label>Status<select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}><option value="">All</option>{['open', 'reviewed', 'capa_required', 'closed'].map(s => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}</select></label>
        </div>
        <table className="table"><thead><tr>
          <th>NC No.</th><th>Date</th><th>Category</th><th>Unit</th><th>Title</th><th>Risk</th><th>Stage</th><th>CAPA</th><th></th>
        </tr></thead><tbody>
          {filtered.map(n => { const nc = n as any; const capa = capas.find(c => c.nc_id === n.id); return <tr key={n.id}>
            <td>{n.nc_number}{nc.affects_patient_safety ? <div><span className="badge badge--danger" style={{ fontSize: 10 }}>patient safety</span></div> : null}</td>
            <td>{n.event_date}</td>
            <td>{(n.nc_type || '—').replace(/_/g, ' ')}</td>
            <td>{sections.find(s => s.id === n.section_id)?.name || '—'}</td>
            <td>{n.title}</td>
            <td>{n.risk_score != null ? <>{n.risk_score} {riskLevelBadge(n.risk_level)}</> : '—'}</td>
            <td>{formatBadge(nc.workflow_stage || 'risk_assessment')}</td>
            <td>{capa ? <Link to="/capa">{capa.capa_number}</Link> : '—'}</td>
            <td style={{ whiteSpace: 'nowrap' }}>
              <button onClick={() => openDetail(n.id)}>View</button>{' '}
              {can('nc_capa', 'print') && <button className="secondary" onClick={() => openPrintWindow(`/nonconformities/${n.id}/print`, m => setState({ loading: false, error: m }))}>Print</button>}
            </td>
          </tr>; })}
          {filtered.length === 0 && <EmptyRow colSpan={9}>No nonconformities match the current filters.</EmptyRow>}
        </tbody></table>
      </div>
    </>}

    {tab === 'Log Event' && <div className="card">
      <WorkflowStepper active="log" />
      <h3 style={{ marginTop: 0 }}>Log a nonconforming event</h3>
      <p className="muted" style={{ marginTop: 0 }}>Any staff member can record a nonconforming event. Capture the facts and any immediate action taken — nothing more is needed now. The event then flows to <strong>Risk Assessment</strong>, and where the risk warrants it, to <strong>Root Cause Analysis</strong> and <strong>CAPA</strong>.</p>
      <form onSubmit={submitNew}>
        <fieldset className="reg-section"><legend>Event details</legend><div className="form-grid">
          <label>Date of event<input type="date" value={form.eventDate} onChange={e => setForm({ ...form, eventDate: e.target.value })} required /></label>
          <label>Time of event<input type="time" value={form.timeOfEvent} onChange={e => setForm({ ...form, timeOfEvent: e.target.value })} /></label>
          <label>Unit / section<select value={form.sectionId} onChange={e => setForm({ ...form, sectionId: e.target.value })}><option value="">—</option>{sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
          <label>Reported by (staff)<select value={form.detectedByStaffId} onChange={e => setForm({ ...form, detectedByStaffId: e.target.value })}><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
          <label>… or name / role<input value={form.detectedByName} onChange={e => setForm({ ...form, detectedByName: e.target.value })} placeholder="if not a staff record" /></label>
          <label style={{ gridColumn: '1 / -1' }}>Category<select value={form.ncType} onChange={e => setForm({ ...form, ncType: e.target.value })}>{NC_TYPE_OPTIONS.map(t => <option key={t.v} value={t.v}>{t.l}</option>)}</select></label>
          {form.ncType === 'other' && <label style={{ gridColumn: '1 / -1' }}>Specify<input value={form.ncTypeOther} onChange={e => setForm({ ...form, ncTypeOther: e.target.value })} /></label>}
          <label style={{ gridColumn: '1 / -1' }}>Title<input value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} required placeholder="Short descriptive title" /></label>
          <label style={{ gridColumn: '1 / -1' }}>What happened? (facts only, no blame)<textarea value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} required /></label>
          <label style={{ gridColumn: '1 / -1' }}>Immediate action taken (urgent step to contain the problem)<textarea value={form.immediateCorrection} onChange={e => setForm({ ...form, immediateCorrection: e.target.value })} /></label>
          {cfg.remedialActionEnabled && <label style={{ gridColumn: '1 / -1' }}>Remedial action taken (short-term correction)<textarea value={form.remedialAction} onChange={e => setForm({ ...form, remedialAction: e.target.value })} /></label>}
          <label className="check-inline" style={{ gridColumn: '1 / -1' }}>
            <input type="checkbox" checked={form.affectsPatientSafety} onChange={e => setForm({ ...form, affectsPatientSafety: e.target.checked })} /> This event affects patient safety
          </label>
        </div></fieldset>
        <EscalationNote cfg={cfg} />
        <button type="submit">Log event</button>
      </form>
    </div>}

    {tab === 'Risk Assessment' && <StageBoard kind="nc" stage="risk_assessment" sections={sections} cfg={cfg} onChanged={load} />}
    {tab === 'Root Cause Analysis' && <StageBoard kind="nc" stage="rca" sections={sections} cfg={cfg} onChanged={load} />}

    {selected && <NcDetail nc={selected} staff={staff} sections={sections} cfg={cfg} capa={capas.find(c => c.nc_id === selected.id)}
      onClose={() => setSelected(null)} onChanged={() => { void load(); void openDetail(selected.id); }}
      onError={m => setState({ loading: false, error: m })} onMsg={setMsg} />}
  </div>;
}

/** Read-only record view with amend-gated editing of the logged facts. */
function NcDetail({ nc, staff, sections, cfg, capa, onClose, onChanged, onError, onMsg }: {
  nc: NonconformingEventDetail; staff: Staff[]; sections: Section[]; cfg: WorkflowConfig; capa?: CapaRecord;
  onClose: () => void; onChanged: () => void; onError: (m: string) => void; onMsg: (m: string) => void;
}) {
  const { can } = usePermissions();
  const n = nc as any;
  const [amend, setAmend] = useState(false);
  const [edit, setEdit] = useState({ title: nc.title, description: nc.description || '', immediateCorrection: n.immediate_correction || '', remedialAction: n.remedial_action || '' });

  async function saveAmendment() {
    try { await api(`/nonconformities/${nc.id}`, { method: 'PUT', body: JSON.stringify(edit) }); setAmend(false); onMsg('Record amended.'); onChanged(); }
    catch (e) { onError((e as Error).message); }
  }
  async function closeNc() {
    if (!confirm('Close this nonconformity?')) return;
    try { await api(`/nonconformities/${nc.id}/close`, { method: 'POST', body: JSON.stringify({ status: 'closed' }) }); onMsg('Nonconformity closed.'); onChanged(); }
    catch (e) { onError((e as Error).message); }
  }

  return <div className="card" style={{ marginTop: 16, borderTop: '3px solid var(--primary, #2563eb)' }}>
    <div className="section-head" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
      <h3 style={{ margin: 0 }}>{nc.nc_number} {formatBadge(nc.status)} {n.risk_score != null ? <>{n.risk_score} {riskLevelBadge(n.risk_level)}</> : null}
        {n.affects_patient_safety ? <span className="badge badge--danger" style={{ marginLeft: 6 }}>patient safety</span> : null}</h3>
      <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
        {can('nc_capa', 'print') && <button className="secondary" onClick={() => openPrintWindow(`/nonconformities/${nc.id}/print`, onError)}>Print report</button>}
        <button className="secondary" onClick={onClose}>Close</button>
      </div>
    </div>
    <p className="muted" style={{ fontSize: 12 }}>{nc.event_date}{n.time_of_event ? ` ${n.time_of_event}` : ''} · {(n.nc_type || '—').replace(/_/g, ' ')} · {sections.find(s => s.id === nc.section_id)?.name || '—'} · reported by {staff.find(s => s.id === nc.detected_by_staff_id)?.fullName || n.detected_by_name || '—'}</p>
    <WorkflowStepper active={n.workflow_stage || (nc.status === 'closed' ? 'closed' : 'risk_assessment')} />
    {n.escalation_reason && <Banner kind="info"><strong>Auto-escalated:</strong> {n.escalation_reason}</Banner>}

    {amend ? <div className="form-grid">
      <label style={{ gridColumn: '1 / -1' }}>Title<input value={edit.title} onChange={e => setEdit({ ...edit, title: e.target.value })} /></label>
      <label style={{ gridColumn: '1 / -1' }}>Description<textarea value={edit.description} onChange={e => setEdit({ ...edit, description: e.target.value })} /></label>
      <label style={{ gridColumn: '1 / -1' }}>Immediate action<textarea value={edit.immediateCorrection} onChange={e => setEdit({ ...edit, immediateCorrection: e.target.value })} /></label>
      {cfg.remedialActionEnabled && <label style={{ gridColumn: '1 / -1' }}>Remedial action<textarea value={edit.remedialAction} onChange={e => setEdit({ ...edit, remedialAction: e.target.value })} /></label>}
      <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 8 }}>
        <button onClick={saveAmendment}>Save amendment</button>
        <button className="secondary" onClick={() => setAmend(false)}>Cancel</button>
      </div>
    </div> : <>
      <p><strong>Description:</strong> {nc.description || '—'}</p>
      <p><strong>Immediate action:</strong> {n.immediate_correction || '—'}</p>
      {cfg.remedialActionEnabled && <p><strong>Remedial action:</strong> {n.remedial_action || '—'}</p>}
    </>}

    <div className="grid cols-2" style={{ marginTop: 12 }}>
      <div>
        <h4 style={{ marginBottom: 4 }}>Risk assessment</h4>
        {n.risk_score != null
          ? <p style={{ margin: 0 }}>Score {n.risk_score} {riskLevelBadge(n.risk_level)}{n.risk_assessed_at ? <span className="muted"> · assessed {fmtDate(n.risk_assessed_at)}</span> : null}
            {n.risk_assessment_notes ? <div className="muted" style={{ fontSize: 12 }}>{n.risk_assessment_notes}</div> : null}</p>
          : <p className="muted" style={{ margin: 0 }}>Not yet assessed — see the Risk Assessment tab.</p>}
      </div>
      <div>
        <h4 style={{ marginBottom: 4 }}>Root cause</h4>
        {n.root_cause
          ? <p style={{ margin: 0 }}>{n.root_cause}<span className="muted" style={{ fontSize: 12 }}> · {(n.rca_method || '').replace(/_/g, ' ')}{n.investigation_team ? ` · ${n.investigation_team}` : ''}</span>
            {n.rca_evidence_file_id ? <div style={{ fontSize: 12 }}><a href={`${API_BASE}/nonconformities/${nc.id}/rca-evidence`} target="_blank" rel="noreferrer">📎 View analysis sheet</a></div> : null}</p>
          : <p className="muted" style={{ margin: 0 }}>{n.rca_required ? 'Investigation outstanding — see the Root Cause Analysis tab.' : 'Not required for this event.'}</p>}
      </div>
    </div>

    <h4 style={{ marginBottom: 4, marginTop: 14 }}>Corrective &amp; preventive action</h4>
    {capa
      ? <p style={{ margin: 0 }}>Managed as <Link to="/capa"><strong>{capa.capa_number}</strong></Link> {formatBadge(capa.status)} <span className="muted">— open the CAPA submodule to plan, verify and review it.</span></p>
      : <p className="muted" style={{ margin: 0 }}>No CAPA raised yet. One is created automatically when an event escalates; otherwise raise it from the CAPA register.</p>}

    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 14 }}>
      {cfg.canAmend && !amend && nc.status !== 'closed' && <button className="secondary" onClick={() => setAmend(true)}>Amend logged details</button>}
      {!cfg.canAmend && <span className="muted" style={{ fontSize: 12 }}>Amending the logged details is restricted to {cfg.amendRoles.join(', ') || 'senior quality roles'}.</span>}
      {nc.status !== 'closed' && cfg.canFollowUp && <button className="secondary" onClick={closeNc}>Close nonconformity</button>}
    </div>
  </div>;
}

// ==========================================================================
// Submodule 2 — Incidents & Adverse Events
// ==========================================================================

export function IncidentsPage({ embedded = false }: { embedded?: boolean } = {}) {
  const { isEnabled } = useModules();
  const { staff, sections } = useLookupData();
  const cfg = useWorkflowConfig();
  const [tab, setTab] = useState('Register');
  const [list, setList] = useState<Incident[]>([]);
  const [sel, setSel] = useState<Incident | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const blank = {
    incidentDatetime: new Date().toISOString().slice(0, 16), incidentType: 'patient_safety', incidentTypeOther: '',
    isNearMiss: false, sectionId: '', locationText: '', personsInvolved: '', description: '', immediateAction: '',
    harmLevel: 'none', reportedByStaffId: '', reportedByName: '', affectsPatientSafety: false,
  };
  const [form, setForm] = useState(blank);

  function load() { api<Incident[]>('/incidents').then(setList).catch(e => setError((e as Error).message)); }
  useEffect(() => { if (isEnabled('nc_capa')) load(); }, [isEnabled]);
  async function openDetail(id: number) { try { setSel(await api<Incident>(`/incidents/${id}`)); } catch (e) { setError((e as Error).message); } }

  async function create(e: FormEvent) {
    e.preventDefault(); setError(null); setMsg(null);
    if (!form.description.trim()) { setError('Describe what happened.'); return; }
    try {
      const r = await api<{ id: number; incidentNumber: string }>('/incidents', { method: 'POST', body: JSON.stringify(form) });
      setForm(blank); load(); setMsg(`Incident ${r.incidentNumber} reported. It now appears in the Risk Assessment queue.`);
      setTab('Risk Assessment');
    } catch (e) { setError((e as Error).message); }
  }

  const stages = useMemo(() => ({
    risk: list.filter(i => (i.workflow_stage || 'risk_assessment') === 'risk_assessment' && i.status !== 'closed').length,
    rca: list.filter(i => i.workflow_stage === 'rca' && i.status !== 'closed').length,
  }), [list]);
  const filtered = useMemo(() => list.filter(i => {
    const t = search.toLowerCase();
    return !t || i.incident_number.toLowerCase().includes(t) || (i.description || '').toLowerCase().includes(t);
  }), [list, search]);

  if (!isEnabled('nc_capa')) return <DisabledModule />;
  const TABS = ['Register', 'Report Incident', 'Risk Assessment', 'Investigation'];

  return <div>
    {!embedded && <PageHeader eyebrow="Nonconforming Event Management" title="Incidents &amp; Adverse Events"
      subtitle="Report incidents, adverse events, occurrences and near-misses, then assess, investigate and act on them." />}
    <Tabs tabs={TABS} tab={tab} setTab={setTab} counts={{ 'Risk Assessment': stages.risk, Investigation: stages.rca }} />
    <Banner kind="error">{error}</Banner>
    <Banner kind="ok">{msg}</Banner>

    {tab === 'Register' && <>
      <KpiStrip items={[
        { label: 'Open events', value: list.filter(i => i.status !== 'closed').length },
        { label: 'Awaiting risk assessment', value: stages.risk, tone: 'warning', onClick: () => setTab('Risk Assessment') },
        { label: 'Under investigation', value: stages.rca, onClick: () => setTab('Investigation') },
        { label: 'Near misses', value: list.filter(i => i.is_near_miss).length },
        { label: 'Patient-safety events', value: list.filter(i => i.affects_patient_safety).length, tone: 'danger' },
      ]} />
      <div className="card" style={{ marginTop: 16 }}>
        <div className="section-head" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <h3 style={{ margin: 0 }}>Incident &amp; adverse event register</h3>
          <button style={{ marginLeft: 'auto' }} onClick={() => setTab('Report Incident')}>+ Report incident</button>
        </div>
        <XlsxToolbar module="nc_capa" exportPath="/incidents/register/export" templatePath="/incidents/register/template" importPath="/incidents/register/import" exportName="Incidents.xlsx" onImported={load} />
        <div className="form" style={{ gridTemplateColumns: '1fr', alignItems: 'end' }}>
          <label>Search<input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search number or description" /></label>
        </div>
        <table className="table"><thead><tr>
          <th>No.</th><th>Date</th><th>Type</th><th>Unit</th><th>Harm</th><th>Risk</th><th>Stage</th><th>CAPA</th><th></th>
        </tr></thead><tbody>
          {filtered.map(i => <tr key={i.id}>
            <td>{i.incident_number}{i.is_near_miss ? <div><span className="badge" style={{ fontSize: 10 }}>near miss</span></div> : null}</td>
            <td>{(i.incident_datetime || '').slice(0, 16).replace('T', ' ')}</td>
            <td>{(i.incident_type || '—').replace(/_/g, ' ')}</td>
            <td>{i.section_name || '—'}</td>
            <td>{i.harm_level || '—'}</td>
            <td>{i.risk_score != null ? <>{i.risk_score} {riskLevelBadge(i.risk_level)}</> : '—'}</td>
            <td>{formatBadge(i.workflow_stage || 'risk_assessment')}</td>
            <td>{i.capa_number ? <Link to="/capa">{i.capa_number}</Link> : '—'}</td>
            <td><button onClick={() => openDetail(i.id)}>View</button></td>
          </tr>)}
          {filtered.length === 0 && <EmptyRow colSpan={9}>No incidents reported yet.</EmptyRow>}
        </tbody></table>
      </div>
    </>}

    {tab === 'Report Incident' && <div className="card">
      <WorkflowStepper active="log" />
      <h3 style={{ marginTop: 0 }}>Report an incident or adverse event</h3>
      <p className="muted" style={{ marginTop: 0 }}>Any staff member can report an incident, adverse event, occurrence or near-miss — capture the facts and any immediate action. The event then flows to <strong>Risk Assessment</strong>, and where warranted, to <strong>Investigation</strong> and <strong>CAPA</strong>.</p>
      <form className="form-grid" onSubmit={create}>
        <label>Date &amp; time<input type="datetime-local" value={form.incidentDatetime} onChange={e => setForm({ ...form, incidentDatetime: e.target.value })} /></label>
        <label>Type<select value={form.incidentType} onChange={e => setForm({ ...form, incidentType: e.target.value })}>{INCIDENT_TYPES.map(t => <option key={t.v} value={t.v}>{t.l}</option>)}</select></label>
        {form.incidentType === 'other' && <label>Specify type<input value={form.incidentTypeOther} onChange={e => setForm({ ...form, incidentTypeOther: e.target.value })} /></label>}
        <label>Unit / section<select value={form.sectionId} onChange={e => setForm({ ...form, sectionId: e.target.value })}><option value="">—</option>{sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label>Location<input value={form.locationText} onChange={e => setForm({ ...form, locationText: e.target.value })} placeholder="e.g. Phlebotomy room" /></label>
        <label>Persons involved<input value={form.personsInvolved} onChange={e => setForm({ ...form, personsInvolved: e.target.value })} placeholder="Names / roles (no blame)" /></label>
        <label>Harm level<select value={form.harmLevel} onChange={e => setForm({ ...form, harmLevel: e.target.value })}>{HARM_LEVELS.map(h => <option key={h.v} value={h.v}>{h.l}</option>)}</select></label>
        <label>Reported by<select value={form.reportedByStaffId} onChange={e => setForm({ ...form, reportedByStaffId: e.target.value })}><option value="">Me</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
        <label style={{ gridColumn: '1 / -1' }}>What happened? (facts only)<textarea value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} required /></label>
        <label style={{ gridColumn: '1 / -1' }}>Immediate action taken<textarea value={form.immediateAction} onChange={e => setForm({ ...form, immediateAction: e.target.value })} /></label>
        <label className="check-inline" style={{ gridColumn: '1 / -1' }}><input type="checkbox" checked={form.isNearMiss} onChange={e => setForm({ ...form, isNearMiss: e.target.checked })} /> Near miss (no harm occurred)</label>
        <label className="check-inline" style={{ gridColumn: '1 / -1' }}><input type="checkbox" checked={form.affectsPatientSafety} onChange={e => setForm({ ...form, affectsPatientSafety: e.target.checked })} /> This event affects patient safety</label>
        <div style={{ gridColumn: '1 / -1' }}><EscalationNote cfg={cfg} /></div>
        <button type="submit">Report incident</button>
      </form>
    </div>}

    {tab === 'Risk Assessment' && <StageBoard kind="incident" stage="risk_assessment" sections={sections} cfg={cfg} onChanged={load} />}
    {tab === 'Investigation' && <StageBoard kind="incident" stage="rca" sections={sections} cfg={cfg} onChanged={load} />}

    {sel && <IncidentDetail incident={sel} cfg={cfg} onClose={() => setSel(null)}
      onChanged={() => { load(); void openDetail(sel.id); }} onError={setError} onMsg={setMsg} />}
  </div>;
}

function IncidentDetail({ incident: i, cfg, onClose, onChanged, onError, onMsg }: {
  incident: Incident; cfg: WorkflowConfig; onClose: () => void; onChanged: () => void; onError: (m: string) => void; onMsg: (m: string) => void;
}) {
  const [notifiedTo, setNotifiedTo] = useState(i.notified_to || '');
  const [external, setExternal] = useState(!!i.reportable_external);
  const [authority, setAuthority] = useState(i.external_authority || '');

  async function save(patch: Record<string, unknown>) {
    try { await api(`/incidents/${i.id}`, { method: 'PUT', body: JSON.stringify(patch) }); onChanged(); }
    catch (e) { onError((e as Error).message); }
  }
  async function escalateToNc() {
    try { const r = await api<{ ncNumber: string }>(`/incidents/${i.id}/create-nc`, { method: 'POST', body: JSON.stringify({}) }); onMsg(`Nonconformity ${r.ncNumber} raised from this incident.`); onChanged(); }
    catch (e) { onError((e as Error).message); }
  }
  async function closeIncident() {
    if (!confirm('Close this incident?')) return;
    try { await api(`/incidents/${i.id}/approve`, { method: 'POST', body: JSON.stringify({}) }); onMsg('Incident closed.'); onChanged(); }
    catch (e) { onError((e as Error).message); }
  }

  return <div className="card" style={{ marginTop: 16, borderTop: '3px solid #c1121f' }}>
    <div className="section-head" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
      <h3 style={{ margin: 0 }}>{i.incident_number} {formatBadge(i.status)} {i.risk_level ? riskLevelBadge(i.risk_level) : null}
        {i.affects_patient_safety ? <span className="badge badge--danger" style={{ marginLeft: 6 }}>patient safety</span> : null}</h3>
      <button style={{ marginLeft: 'auto' }} className="secondary" onClick={onClose}>Close</button>
    </div>
    <p className="muted" style={{ fontSize: 12 }}>{(i.incident_type || '').replace(/_/g, ' ')}{i.is_near_miss ? ' · near miss' : ''} · {(i.incident_datetime || '').slice(0, 16).replace('T', ' ')} · {i.section_name || '—'}{i.location_text ? ` · ${i.location_text}` : ''} · reported by {i.reported_by_full || i.reported_by_name || '—'}</p>
    <WorkflowStepper active={i.workflow_stage || (i.status === 'closed' ? 'closed' : 'risk_assessment')} />
    {i.escalation_reason && <Banner kind="info"><strong>Auto-escalated:</strong> {i.escalation_reason}</Banner>}

    <p><strong>What happened:</strong> {i.description || '—'}</p>
    <p><strong>Immediate action:</strong> {i.immediate_action || '—'}</p>
    <p><strong>Persons involved:</strong> {i.persons_involved || '—'} · <strong>Harm:</strong> {i.harm_level || '—'}</p>

    <div className="grid cols-2" style={{ marginTop: 12 }}>
      <div>
        <h4 style={{ marginBottom: 4 }}>Risk assessment</h4>
        {i.risk_score != null ? <p style={{ margin: 0 }}>Score {i.risk_score} {riskLevelBadge(i.risk_level)}</p>
          : <p className="muted" style={{ margin: 0 }}>Not yet assessed — see the Risk Assessment tab.</p>}
      </div>
      <div>
        <h4 style={{ marginBottom: 4 }}>Investigation</h4>
        {i.root_cause ? <p style={{ margin: 0 }}>{i.root_cause}<span className="muted" style={{ fontSize: 12 }}> · {(i.rca_method || '').replace(/_/g, ' ')}</span>
          {(i as any).rca_evidence_file_id ? <div style={{ fontSize: 12 }}><a href={`${API_BASE}/incidents/${i.id}/rca-evidence`} target="_blank" rel="noreferrer">📎 View analysis sheet</a></div> : null}</p>
          : <p className="muted" style={{ margin: 0 }}>{i.rca_required ? 'Outstanding — see the Investigation tab.' : 'Not required for this event.'}</p>}
      </div>
    </div>

    <h4 style={{ marginBottom: 4, marginTop: 14 }}>Notification &amp; reporting</h4>
    <div className="form-grid">
      <label>Notified to<input value={notifiedTo} onChange={e => setNotifiedTo(e.target.value)} onBlur={() => save({ notifiedTo })} placeholder="Manager, safety officer…" /></label>
      <label className="check-inline"><input type="checkbox" checked={external} onChange={e => { setExternal(e.target.checked); save({ reportableExternal: e.target.checked }); }} /> Reportable to an external authority</label>
      {external && <label>External authority<input value={authority} onChange={e => setAuthority(e.target.value)} onBlur={() => save({ externalAuthority: authority })} /></label>}
    </div>

    <h4 style={{ marginBottom: 4, marginTop: 14 }}>Corrective &amp; preventive action</h4>
    {i.capa_number
      ? <p style={{ margin: 0 }}>Managed as <Link to="/capa"><strong>{i.capa_number}</strong></Link> <span className="muted">— open the CAPA submodule to plan, verify and review it.</span></p>
      : <p className="muted" style={{ margin: 0 }}>No CAPA raised yet. One is created automatically when an event escalates.</p>}

    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 14 }}>
      {!i.nc_id && cfg.canFollowUp && <button onClick={escalateToNc}>Also raise a nonconformity</button>}
      {i.nc_number && <span className="badge badge--info">Linked NC: {i.nc_number}</span>}
      {i.status !== 'closed' && cfg.canFollowUp && <button className="secondary" onClick={closeIncident}>Close incident</button>}
    </div>
  </div>;
}

// ==========================================================================
// Submodule 3 — CAPA
// ==========================================================================

type CapaSummary = {
  total: number; open: number; needsPlan: number; inProgress: number; awaitingVerification: number;
  awaitingEffectiveness: number; effectivenessDue: number; overdue: number; failed: number; closed: number;
};

/** The CAPA lifecycle, rendered as an explicit progress rail. */
function CapaStepper({ status, effectiveness }: { status: string; effectiveness?: string | null }) {
  const steps = [
    { key: 'open', label: 'Plan' },
    { key: 'in_progress', label: 'Implement' },
    { key: 'completed', label: 'Verify' },
    { key: 'verified', label: 'Effectiveness' },
    { key: 'closed', label: 'Closed' },
  ];
  let idx = steps.findIndex(s => s.key === status);
  if (status === 'reopened') idx = 1;
  if (status === 'verified' && effectiveness === 'effective') idx = 4;
  return <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', margin: '4px 0 14px' }}>
    {steps.map((s, k) => <span key={s.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span style={{
        fontSize: 12, fontWeight: k === idx ? 700 : 500, padding: '3px 10px', borderRadius: 999,
        background: k === idx ? 'var(--primary, #2563eb)' : k < idx ? '#e6f4ea' : 'var(--surface-2, #eef1f6)',
        color: k === idx ? '#fff' : k < idx ? '#1a7f37' : 'var(--muted, #667)',
      }}>{k < idx ? '✓ ' : ''}{s.label}</span>
      {k < steps.length - 1 && <span style={{ color: 'var(--muted, #99a)', fontSize: 12 }}>→</span>}
    </span>)}
  </div>;
}

/** What this CAPA needs next — one clear instruction, never a wall of forms. */
function nextStepFor(c: any): { label: string; hint: string } {
  if (c.status === 'closed') return { label: 'Closed', hint: 'This CAPA is complete. Reopen it if the problem recurs.' };
  if (c.status === 'reopened') return { label: 'Rework the actions', hint: 'The effectiveness review found the action did not work. Revise the plan and implement again.' };
  if (c.status === 'open') return { label: 'Write the action plan', hint: 'Record the corrective action, who owns it and when it is due.' };
  if (c.status === 'in_progress') return { label: 'Implement, then mark complete', hint: 'Log progress as you go. Mark the actions complete once they are done.' };
  if (c.status === 'completed') return { label: 'Verify the actions were implemented', hint: 'An independent reviewer confirms the planned actions were actually carried out.' };
  if (c.status === 'verified' && c.effectiveness_required && c.effectiveness_status !== 'effective') {
    return { label: 'Review effectiveness', hint: 'Confirm with evidence that the action actually stopped the problem recurring.' };
  }
  return { label: 'Close the CAPA', hint: 'Effectiveness is confirmed — record the closure.' };
}

export function CapaPage({ embedded = false }: { embedded?: boolean } = {}) {
  const { isEnabled } = useModules();
  const { staff } = useLookupData();
  const cfg = useWorkflowConfig();
  const [tab, setTab] = useState('Register');
  const [list, setList] = useState<any[]>([]);
  const [summary, setSummary] = useState<CapaSummary | null>(null);
  const [sel, setSel] = useState<CapaDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [sourceFilter, setSourceFilter] = useState('');

  function load() {
    api<any[]>('/capa').then(setList).catch(e => setError((e as Error).message));
    api<CapaSummary>('/capa/summary').then(setSummary).catch(() => setSummary(null));
  }
  useEffect(() => { if (isEnabled('nc_capa')) load(); }, [isEnabled]);
  async function openDetail(id: number) { try { setSel(await api<CapaDetail>(`/capa/${id}`)); setError(null); } catch (e) { setError((e as Error).message); } }

  const today = new Date().toISOString().slice(0, 10);
  const worklist = useMemo(() => {
    const base = list.filter(c => c.status !== 'closed');
    if (tab === 'Overdue') return base.filter(c => c.due_date && c.due_date < today);
    if (tab === 'Effectiveness Reviews') return base.filter(c => c.effectiveness_required && (c.effectiveness_status ?? 'pending') === 'pending' && c.status === 'verified');
    return base;
  }, [list, tab, today]);

  const filtered = useMemo(() => list.filter(c => {
    const t = search.toLowerCase();
    const okSearch = !t || (c.capa_number || '').toLowerCase().includes(t) || (c.title || '').toLowerCase().includes(t) || (c.problem_summary || '').toLowerCase().includes(t);
    const okStatus = !statusFilter || c.status === statusFilter;
    const okSource = !sourceFilter || (sourceFilter === 'manual' ? capaSourceLabel(c) === 'Manual' : (c.source_module || '') === sourceFilter);
    return okSearch && okStatus && okSource;
  }), [list, search, statusFilter, sourceFilter]);

  if (!isEnabled('nc_capa')) return <DisabledModule />;
  const TABS = ['Register', 'My Worklist', 'Overdue', 'Effectiveness Reviews'];

  return <div>
    {!embedded && <PageHeader eyebrow="Nonconforming Event Management" title="Corrective &amp; Preventive Action (CAPA)"
      subtitle="One register for every corrective and preventive action — from nonconformities, incidents, complaints or raised directly. Plan, implement, verify, prove it worked, close." />}
    <Tabs tabs={TABS} tab={tab} setTab={setTab} counts={{ Overdue: summary?.overdue ?? 0, 'Effectiveness Reviews': summary?.awaitingEffectiveness ?? 0 }} />
    <Banner kind="error">{error}</Banner>
    <Banner kind="ok">{msg}</Banner>

    {tab === 'Register' && <>
      <ModuleAlerts moduleKey="nc_capa" />
      <KpiStrip items={[
        { label: 'Open CAPAs', value: summary?.open ?? 0 },
        { label: 'Need a plan', value: summary?.needsPlan ?? 0, tone: 'warning', onClick: () => { setTab('Register'); setStatusFilter('open'); } },
        { label: 'Awaiting verification', value: summary?.awaitingVerification ?? 0, onClick: () => { setTab('Register'); setStatusFilter('completed'); } },
        { label: 'Awaiting effectiveness', value: summary?.awaitingEffectiveness ?? 0, onClick: () => setTab('Effectiveness Reviews') },
        { label: 'Overdue', value: summary?.overdue ?? 0, tone: 'danger', onClick: () => setTab('Overdue') },
        { label: 'Found not effective', value: summary?.failed ?? 0, tone: 'danger', onClick: () => { setTab('Register'); setStatusFilter('reopened'); } },
      ]} />
      <div className="card" style={{ marginTop: 16 }}>
        <h3 style={{ marginTop: 0 }}>CAPA register</h3>
        <div className="form" style={{ gridTemplateColumns: '1fr auto auto', alignItems: 'end' }}>
          <label>Search<input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search CAPA number, title or problem" /></label>
          <label>Source<select value={sourceFilter} onChange={e => setSourceFilter(e.target.value)}><option value="">All</option><option value="nonconformities">Nonconformity</option><option value="incidents">Incident</option><option value="complaints">Complaint</option><option value="manual">Manual</option></select></label>
          <label>Status<select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}><option value="">All</option>{['open', 'in_progress', 'completed', 'verified', 'reopened', 'closed'].map(s => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}</select></label>
        </div>
        <CapaTable rows={filtered} today={today} onOpen={openDetail} />
      </div>
    </>}

    {tab !== 'Register' && <div className="card">
      <h3 style={{ marginTop: 0 }}>{tab === 'My Worklist' ? 'Active CAPAs' : tab === 'Overdue' ? 'Overdue CAPAs' : 'Effectiveness reviews due'}</h3>
      <p className="muted" style={{ marginTop: 0 }}>{
        tab === 'My Worklist' ? 'Everything still in flight, with the next step required on each.'
          : tab === 'Overdue' ? 'CAPAs past their target completion date. Update the plan or record what is blocking them.'
            : 'Actions that have been verified as implemented and now need evidence that they actually worked.'}</p>
      <CapaTable rows={worklist} today={today} onOpen={openDetail} showNextStep />
    </div>}

    {sel && <CapaDetailPanel capa={sel} staff={staff} cfg={cfg} onClose={() => setSel(null)}
      onChanged={() => { load(); void openDetail(sel.id); }} onError={setError} onMsg={setMsg} />}
  </div>;
}

function CapaTable({ rows, today, onOpen, showNextStep }: { rows: any[]; today: string; onOpen: (id: number) => void; showNextStep?: boolean }) {
  return <table className="table"><thead><tr>
    <th>CAPA No.</th><th>Source</th><th>Title</th><th>Owner</th><th>Due</th><th>Status</th>
    {showNextStep ? <th>Next step</th> : <th>Effectiveness</th>}<th></th>
  </tr></thead><tbody>
    {rows.map(c => {
      const overdue = c.status !== 'closed' && c.due_date && c.due_date < today;
      return <tr key={c.id}>
        <td>{c.capa_number}</td>
        <td><span className="badge badge--info">{capaSourceLabel(c)}</span>
          {c.nc_number || c.incident_number || c.complaint_number ? <div className="muted" style={{ fontSize: 11 }}>{c.nc_number || c.incident_number || c.complaint_number}</div> : null}</td>
        <td>{c.title}</td>
        <td>{c.responsible_name || '—'}</td>
        <td>{c.due_date ? <span className={overdue ? 'badge badge--danger' : undefined}>{c.due_date}</span> : '—'}</td>
        <td>{formatBadge(c.status)}</td>
        {showNextStep
          ? <td className="muted" style={{ fontSize: 12 }}>{nextStepFor(c).label}</td>
          : <td>{c.effectiveness_required ? formatBadge(c.effectiveness_status || 'pending') : <span className="muted">n/a</span>}</td>}
        <td><button onClick={() => onOpen(c.id)}>Open</button></td>
      </tr>;
    })}
    {rows.length === 0 && <EmptyRow colSpan={8}>Nothing here right now.</EmptyRow>}
  </tbody></table>;
}

/**
 * The CAPA record. Rather than showing every form at once, it shows the record,
 * then exactly one action panel for the stage the CAPA is actually at.
 */
function CapaDetailPanel({ capa, staff, cfg, onClose, onChanged, onError, onMsg }: {
  capa: CapaDetail; staff: Staff[]; cfg: WorkflowConfig; onClose: () => void; onChanged: () => void; onError: (m: string) => void; onMsg: (m: string) => void;
}) {
  const c = capa as any;
  const [busy, setBusy] = useState(false);
  const next = nextStepFor(c);

  // Each stage owns its own state — no shared fields between unrelated forms.
  const [plan, setPlan] = useState({
    rootCause: c.root_cause || '', correctiveAction: c.corrective_action || '', preventiveAction: c.preventive_action || '',
    responsibleStaffId: c.responsible_staff_id ? String(c.responsible_staff_id) : '', dueDate: c.due_date || '',
    priority: c.priority || 'normal', effectivenessDueDate: c.effectiveness_due_date || '',
  });
  const [progress, setProgress] = useState('');
  const [completeNotes, setCompleteNotes] = useState('');
  const [verifyNotes, setVerifyNotes] = useState('');
  const [eff, setEff] = useState({ verdict: '', notes: '', date: new Date().toISOString().slice(0, 10) });
  const [closureNotes, setClosureNotes] = useState('');

  async function call(path: string, body: unknown, okMsg: string) {
    setBusy(true); onError('');
    try { await api(`/capa/${capa.id}/${path}`, { method: 'POST', body: JSON.stringify(body) }); onMsg(okMsg); onChanged(); }
    catch (e) { onError((e as Error).message); } finally { setBusy(false); }
  }

  return <div className="card" style={{ marginTop: 16, borderTop: '3px solid var(--primary, #2563eb)' }}>
    <div className="section-head" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
      <h3 style={{ margin: 0 }}>{capa.capa_number} {formatBadge(capa.status)}
        {c.effectiveness_status === 'not_effective' ? <span className="badge badge--danger" style={{ marginLeft: 6 }}>not effective</span> : null}</h3>
      <button style={{ marginLeft: 'auto' }} className="secondary" onClick={onClose}>Close</button>
    </div>
    <p className="muted" style={{ fontSize: 12 }}>
      Raised from {capaSourceLabel(c)}{c.nc_number || c.incident_number || c.complaint_number ? ` ${c.nc_number || c.incident_number || c.complaint_number}` : ''}
      {' '}· created {fmtDate(c.created_at)}{c.responsible_name ? ` · owner ${c.responsible_name}` : ''}
    </p>
    <CapaStepper status={capa.status} effectiveness={c.effectiveness_status} />

    <div className="notice-ok" style={{ background: 'var(--surface-2, #eef1f6)', color: 'inherit', marginBottom: 12 }}>
      <strong>Next step: {next.label}.</strong> <span className="muted">{next.hint}</span>
    </div>

    <h4 style={{ marginBottom: 4 }}>Problem</h4>
    <p style={{ marginTop: 0 }}>{capa.title}{capa.problem_summary ? <><br /><span className="muted">{capa.problem_summary}</span></> : null}</p>
    {c.root_cause && <><h4 style={{ marginBottom: 4 }}>Root cause</h4><p style={{ marginTop: 0 }}>{c.root_cause}</p></>}
    {c.corrective_action && <div className="grid cols-2">
      <div><h4 style={{ marginBottom: 4 }}>Corrective action</h4><p style={{ marginTop: 0 }}>{c.corrective_action}</p></div>
      <div><h4 style={{ marginBottom: 4 }}>Preventive action</h4><p style={{ marginTop: 0 }}>{c.preventive_action || '—'}</p></div>
    </div>}

    {/* ---- stage-specific action panel ---- */}
    {(capa.status === 'open' || capa.status === 'reopened') && cfg.canFollowUp && <fieldset className="reg-section"><legend>Action plan</legend>
      <div className="form-grid">
        <label style={{ gridColumn: '1 / -1' }}>Root cause<textarea value={plan.rootCause} onChange={e => setPlan({ ...plan, rootCause: e.target.value })} /></label>
        <label style={{ gridColumn: '1 / -1' }}>Corrective action — what will be done to fix this<textarea value={plan.correctiveAction} onChange={e => setPlan({ ...plan, correctiveAction: e.target.value })} required /></label>
        <label style={{ gridColumn: '1 / -1' }}>Preventive action — what will stop it recurring<textarea value={plan.preventiveAction} onChange={e => setPlan({ ...plan, preventiveAction: e.target.value })} /></label>
        <label>Owner<select value={plan.responsibleStaffId} onChange={e => setPlan({ ...plan, responsibleStaffId: e.target.value })}><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
        <label>Target completion<input type="date" value={plan.dueDate} onChange={e => setPlan({ ...plan, dueDate: e.target.value })} required /></label>
        <label>Priority<select value={plan.priority} onChange={e => setPlan({ ...plan, priority: e.target.value })}><option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option></select></label>
        <label>Effectiveness check due<input type="date" value={plan.effectivenessDueDate} onChange={e => setPlan({ ...plan, effectivenessDueDate: e.target.value })} /></label>
      </div>
      <button style={{ marginTop: 10 }} disabled={busy} onClick={() => call('plan', plan, 'Action plan saved — the CAPA is now in progress.')}>Save plan &amp; start</button>
    </fieldset>}

    {capa.status === 'in_progress' && cfg.canFollowUp && <fieldset className="reg-section"><legend>Implementation</legend>
      <div className="form-grid">
        <label style={{ gridColumn: '1 / -1' }}>Progress note<textarea value={progress} onChange={e => setProgress(e.target.value)} placeholder="What has been done since the last update?" /></label>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
        <button className="secondary" disabled={busy || !progress.trim()} onClick={() => call('add-update', { updateText: progress, status: 'in_progress' }, 'Progress recorded.').then(() => setProgress(''))}>Add progress note</button>
      </div>
      <div className="form-grid" style={{ marginTop: 12 }}>
        <label style={{ gridColumn: '1 / -1' }}>Completion note (optional)<textarea value={completeNotes} onChange={e => setCompleteNotes(e.target.value)} /></label>
      </div>
      <button disabled={busy} onClick={() => call('complete', { notes: completeNotes }, 'Actions marked complete — awaiting verification.')}>Mark actions complete</button>
    </fieldset>}

    {capa.status === 'completed' && cfg.canFollowUp && <fieldset className="reg-section"><legend>Verification</legend>
      <p className="muted" style={{ marginTop: 0 }}>Confirm the planned actions were actually carried out. This is a check of implementation, not yet of whether they worked.</p>
      <label style={{ display: 'block' }}>Verification notes<textarea value={verifyNotes} onChange={e => setVerifyNotes(e.target.value)} /></label>
      <button style={{ marginTop: 10 }} disabled={busy || !verifyNotes.trim()} onClick={() => call('verify', { verificationNotes: verifyNotes }, 'Implementation verified.')}>Verify implementation</button>
    </fieldset>}

    {capa.status === 'verified' && c.effectiveness_required && c.effectiveness_status !== 'effective' && cfg.canFollowUp &&
      <fieldset className="reg-section"><legend>Effectiveness review</legend>
        <p className="muted" style={{ marginTop: 0 }}>Did the action actually stop the problem? Cite the evidence — repeat audit, QC trend, recurrence count, retraining records.</p>
        <div className="form-grid">
          <label>Review date<input type="date" value={eff.date} onChange={e => setEff({ ...eff, date: e.target.value })} /></label>
          <label>Verdict<select value={eff.verdict} onChange={e => setEff({ ...eff, verdict: e.target.value })}>
            <option value="">— choose —</option><option value="effective">Effective — the problem has not recurred</option><option value="not_effective">Not effective — rework required</option>
          </select></label>
          <label style={{ gridColumn: '1 / -1' }}>Evidence &amp; conclusion<textarea value={eff.notes} onChange={e => setEff({ ...eff, notes: e.target.value })} required /></label>
        </div>
        <button style={{ marginTop: 10 }} disabled={busy || !eff.verdict || !eff.notes.trim()}
          onClick={() => call('effectiveness-review', { verdict: eff.verdict, effectivenessReviewNotes: eff.notes, effectivenessReviewDate: eff.date },
            eff.verdict === 'effective' ? 'Recorded as effective — the CAPA can now be closed.' : 'Recorded as not effective — the CAPA has been reopened for rework.')}>
          Save effectiveness review
        </button>
      </fieldset>}

    {capa.status === 'verified' && (!c.effectiveness_required || c.effectiveness_status === 'effective') && cfg.canFollowUp &&
      <fieldset className="reg-section"><legend>Closure</legend>
        <label style={{ display: 'block' }}>Closure notes<textarea value={closureNotes} onChange={e => setClosureNotes(e.target.value)} /></label>
        <button style={{ marginTop: 10 }} disabled={busy} onClick={() => call('close', { closureNotes }, 'CAPA closed. The originating record was closed out too.')}>Close CAPA</button>
      </fieldset>}

    {capa.status === 'closed' && cfg.canFollowUp && <div style={{ marginTop: 10 }}>
      <button className="secondary" disabled={busy} onClick={() => call('reopen', {}, 'CAPA reopened.')}>Reopen CAPA</button>
    </div>}

    {/* ---- record of what has happened so far ---- */}
    <h4 style={{ marginTop: 18, marginBottom: 4 }}>Verification &amp; effectiveness</h4>
    <table className="table"><tbody>
      <tr><td style={{ width: 220 }}>Implementation verified</td><td>{c.verified_at ? `${fmtDate(c.verified_at)} by ${c.verified_by_name || '—'}` : 'Not yet'}{c.verification_notes ? <div className="muted" style={{ fontSize: 12 }}>{c.verification_notes}</div> : null}</td></tr>
      <tr><td>Effectiveness check due</td><td>{c.effectiveness_due_date || '—'}</td></tr>
      <tr><td>Effectiveness verdict</td><td>{c.effectiveness_status && c.effectiveness_status !== 'pending' ? <>{formatBadge(c.effectiveness_status)} {c.effectiveness_review_date ? <span className="muted">{fmtDate(c.effectiveness_review_date)} by {c.effectiveness_reviewed_by_name || '—'}</span> : null}</> : 'Pending'}
        {c.effectiveness_review_notes ? <div className="muted" style={{ fontSize: 12 }}>{c.effectiveness_review_notes}</div> : null}</td></tr>
      {capa.status === 'closed' && <tr><td>Closed</td><td>{fmtDate(c.closed_at)}{c.closure_notes ? <div className="muted" style={{ fontSize: 12 }}>{c.closure_notes}</div> : null}</td></tr>}
    </tbody></table>

    <h4 style={{ marginTop: 16, marginBottom: 4 }}>History</h4>
    {capa.updates?.length
      ? <table className="table"><thead><tr><th>Date</th><th>Status</th><th>Note</th></tr></thead><tbody>
        {capa.updates.map(u => <tr key={u.id}><td>{fmtDate(u.update_date)}</td><td>{formatBadge(u.status)}</td><td>{u.update_text}</td></tr>)}
      </tbody></table>
      : <p className="muted">No updates recorded yet.</p>}
  </div>;
}
