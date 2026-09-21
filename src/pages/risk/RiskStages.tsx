import { useEffect, useMemo, useState } from 'react';
import { api, errorText } from '../../services/api';
import RiskMatrix from '../../components/RiskMatrix';
import TextField from '../../components/ui/TextField';
import { Notice } from '../../components/ui/Feedback';
import RiskStepper from './RiskStepper';
import {
  BandChip, CONTROL_STATUSES, CONTROL_TYPES, CONTROL_OPTIONS, fmtDate, optionLabel,
  type RiskControl, type RiskCriteriaState, type RiskRow,
} from './riskShared';
import type { Staff } from '../../../shared/types/api';

// ==========================================================================
// The working queues.
//
// Each key step is a queue of the risks waiting at that step. Completing the
// step writes the next stage onto the record, so the risk leaves this queue
// and appears in the next one immediately — nothing is ever left between two
// steps with nobody responsible for it.
// ==========================================================================

type StageProps = {
  rows: RiskRow[];
  criteria: RiskCriteriaState;
  staff: Staff[];
  onChanged: (message?: string, nextTab?: string) => void;
  onOpen: (id: number) => void;
};

function QueueEmpty({ children }: { children: React.ReactNode }) {
  return <p className="muted" style={{ textAlign: 'center', padding: '20px 8px', margin: 0 }}>{children}</p>;
}

function StageHead({ stage, title }: { stage: string; title: string }) {
  return <>
    <RiskStepper active={stage} />
    <h3 style={{ margin: '0 0 10px' }}>{title}</h3>
  </>;
}

/** The row that opens beneath a queue when an item is picked. */
function WorkPanel({ risk, onClose, children }: { risk: RiskRow; onClose: () => void; children: React.ReactNode }) {
  return <div className="card" style={{ marginTop: 16 }}>
    <div className="section-head" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
      <h3 style={{ margin: 0 }}>{risk.risk_number}</h3>
      <button style={{ marginLeft: 'auto' }} className="secondary" onClick={onClose}>Close</button>
    </div>
    <p className="muted" style={{ fontSize: 12, marginTop: 2 }}>
      {fmtDate(risk.identified_date)} · {risk.section_name || 'Laboratory-wide'} · {risk.risk_area}
      {risk.affects_patient_safety ? <span className="badge badge--danger" style={{ marginLeft: 8 }}>patient safety</span> : null}
    </p>
    {children}
  </div>;
}

function QueueTable({ rows, criteria, columns, action, onPick, onOpen, empty }: {
  rows: RiskRow[]; criteria: RiskCriteriaState; columns: string[]; action: string;
  onPick: (r: RiskRow) => void; onOpen: (id: number) => void; empty: string;
}) {
  if (rows.length === 0) return <QueueEmpty>{empty}</QueueEmpty>;
  return <table className="table" style={{ marginTop: 8 }}>
    <thead><tr><th>Risk No.</th><th>Risk</th><th>Unit</th>{columns.map(c => <th key={c}>{c}</th>)}<th></th></tr></thead>
    <tbody>{rows.map(r => <tr key={r.id}>
      <td>{r.risk_number}{r.affects_patient_safety ? <div><span className="badge badge--danger" style={{ fontSize: 10 }}>patient safety</span></div> : null}</td>
      <td>{r.risk_area}<div className="muted" style={{ fontSize: 11 }}>{(r.risk_description || '').slice(0, 80)}</div></td>
      <td>{r.section_name || '—'}</td>
      {columns.map(c => <td key={c}>
        {c === 'Initial risk' && <BandChip level={r.risk_level} score={r.risk_score} criteria={criteria} size="sm" />}
        {c === 'Residual risk' && (r.residual_score != null ? <BandChip level={r.residual_level} score={r.residual_score} criteria={criteria} size="sm" /> : '—')}
        {c === 'Identified' && fmtDate(r.identified_date)}
        {c === 'Responsible' && (r.treatment_owner_name || r.responsible_name || '—')}
        {c === 'Target' && fmtDate(r.treatment_due_date)}
        {c === 'Review due' && fmtDate(r.review_due_date)}
        {c === 'Option' && optionLabel(CONTROL_OPTIONS, r.treatment_option).split(' — ')[0]}
      </td>)}
      <td style={{ whiteSpace: 'nowrap' }}>
        <button onClick={() => onPick(r)}>{action}</button>{' '}
        <button className="secondary" onClick={() => onOpen(r.id)}>View</button>
      </td>
    </tr>)}</tbody>
  </table>;
}

// --- step 2: risk analysis -------------------------------------------------

export function AnalysisStage({ rows, criteria, onChanged, onOpen }: StageProps) {
  const [sel, setSel] = useState<RiskRow | null>(null);
  const [likelihood, setLikelihood] = useState<number | null>(null);
  const [severity, setSeverity] = useState<number | null>(null);
  const [safety, setSafety] = useState(false);
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function pick(r: RiskRow) {
    setSel(r); setError(null);
    setLikelihood(r.likelihood ?? null); setSeverity(r.severity ?? null);
    setSafety(!!r.affects_patient_safety); setNotes(r.analysis_notes || '');
  }

  async function submit() {
    if (!sel) return;
    if (!likelihood || !severity) { setError('Select a cell on the matrix to set both the likelihood and the severity.'); return; }
    setBusy(true); setError(null);
    try {
      const r = await api<{ score: number; levelLabel: string }>(`/risks/${sel.id}/analysis`, {
        method: 'POST',
        body: JSON.stringify({ likelihood, severity, affectsPatientSafety: safety, analysisNotes: notes }),
      });
      setSel(null);
      onChanged(`${sel.risk_number} analysed — score ${r.score}, ${r.levelLabel}. It now awaits evaluation against your risk criteria.`, 'Risk Evaluation');
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }

  return <div className="card">
    <StageHead stage="analysis" title="Risk assessment" />
    {error && <Notice kind="error">{error}</Notice>}
    <QueueTable rows={rows} criteria={criteria} columns={['Identified', 'Responsible']} action="Analyse"
      onPick={pick} onOpen={onOpen} empty="No risks are waiting to be analysed." />

    {sel && <WorkPanel risk={sel} onClose={() => setSel(null)}>
      <p><strong>Description:</strong> {sel.risk_description || '—'}</p>
      <p><strong>Cause:</strong> {sel.cause || '—'}</p>
      <p><strong>Potential consequence:</strong> {sel.consequence || '—'}</p>
      <p><strong>Existing controls:</strong> {sel.existing_controls || '—'}</p>
      <h4 style={{ marginBottom: 4 }}>Score the risk (click a cell)</h4>
      <RiskMatrix occurrence={likelihood} severity={severity} onChange={(l, s) => { setLikelihood(l); setSeverity(s); }}
        rows={criteria.likelihood} columns={criteria.severity} bands={criteria.bands}
        rowLabel="Likelihood" columnLabel="Severity" scoreLabel="Initial risk score (Likelihood × Severity)" />
      <label className="check-inline" style={{ display: 'block', marginTop: 10 }}>
        <input type="checkbox" checked={safety} onChange={e => setSafety(e.target.checked)} /> This risk affects patient or staff safety
      </label>
      <label style={{ display: 'block', marginTop: 8 }}>Analysis notes
        <TextField as="textarea" value={notes} onValue={setNotes} placeholder="Basis for the scores — data, history, expert judgement" />
      </label>
      <button style={{ marginTop: 10 }} disabled={busy || !criteria.canAssess} onClick={submit}>{busy ? 'Saving…' : 'Complete analysis'}</button>
    </WorkPanel>}
  </div>;
}

// --- step 3: risk evaluation ----------------------------------------------

export function EvaluationStage({ rows, criteria, onChanged, onOpen }: StageProps) {
  const [sel, setSel] = useState<RiskRow | null>(null);
  const [decision, setDecision] = useState<'treat' | 'accept'>('treat');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const forced = useMemo(() => {
    if (!sel) return false;
    if (sel.affects_patient_safety && criteria.alwaysTreatPatientSafety) return true;
    const threshold = criteria.bands.findIndex(b => b.level === criteria.treatmentThresholdLevel);
    const rank = criteria.bands.findIndex(b => b.level === sel.risk_level);
    return threshold >= 0 && rank >= threshold;
  }, [sel, criteria]);

  function pick(r: RiskRow) { setSel(r); setError(null); setNotes(''); setDecision('treat'); }

  async function submit() {
    if (!sel) return;
    setBusy(true); setError(null);
    try {
      const r = await api<{ decision: string; nextStage: string }>(`/risks/${sel.id}/evaluation`, {
        method: 'POST', body: JSON.stringify({ decision: forced ? 'treat' : decision, evaluationNotes: notes }),
      });
      setSel(null);
      onChanged(
        r.decision === 'treat'
          ? `${sel.risk_number} requires control. It now awaits a control plan.`
          : `${sel.risk_number} is tolerable as it stands. It now awaits an acceptance decision.`,
        r.decision === 'treat' ? 'Risk Control' : 'Risk Acceptance',
      );
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }

  const thresholdBand = criteria.bands.find(b => b.level === criteria.treatmentThresholdLevel);
  const selBand = sel ? criteria.bands.find(b => b.level === sel.risk_level) : null;

  return <div className="card">
    <StageHead stage="evaluation" title="Risk evaluation" />
    {thresholdBand && <p className="hint" style={{ marginTop: 0 }}>
      Control required at <strong>{thresholdBand.label}</strong> and above
      {criteria.alwaysTreatPatientSafety ? ', and for every risk affecting patient or staff safety whatever its band' : ''}.
    </p>}
    {error && <Notice kind="error">{error}</Notice>}
    <QueueTable rows={rows} criteria={criteria} columns={['Initial risk', 'Identified']} action="Evaluate"
      onPick={pick} onOpen={onOpen} empty="No analysed risks are waiting to be evaluated." />

    {sel && <WorkPanel risk={sel} onClose={() => setSel(null)}>
      <p><strong>Description:</strong> {sel.risk_description || '—'}</p>
      <p style={{ margin: '6px 0' }}>Initial risk: <BandChip level={sel.risk_level} score={sel.risk_score} criteria={criteria} />
        {selBand && <span className="muted" style={{ marginLeft: 10 }}>{selBand.action}</span>}</p>
      {forced
        ? <Notice kind="warn" style={{ marginTop: 6 }}>
            This risk meets your criteria for mandatory control{sel.affects_patient_safety && criteria.alwaysTreatPatientSafety ? ' — it affects patient or staff safety' : ''}. A control plan is required before it can be accepted.
          </Notice>
        : <div className="form-grid" style={{ marginTop: 8 }}>
            <label>Evaluation outcome
              <select value={decision} onChange={e => setDecision(e.target.value as 'treat' | 'accept')}>
                <option value="treat">Control — reduce this risk with control measures</option>
                <option value="accept">Retain — tolerable as it stands</option>
              </select>
            </label>
          </div>}
      <label style={{ display: 'block', marginTop: 8 }}>Evaluation notes
        <TextField as="textarea" value={notes} onValue={setNotes} placeholder="Why this outcome, against the criteria" />
      </label>
      <button style={{ marginTop: 10 }} disabled={busy || !criteria.canAssess} onClick={submit}>{busy ? 'Saving…' : 'Complete evaluation'}</button>
    </WorkPanel>}
  </div>;
}

// --- step 4: risk control (treatment) -------------------------------------

export function TreatmentStage({ rows, criteria, staff, onChanged, onOpen }: StageProps) {
  const [sel, setSel] = useState<RiskRow | null>(null);
  const [controls, setControls] = useState<RiskControl[]>([]);
  const [plan, setPlan] = useState({ treatmentOption: 'reduce', mitigationPlan: '', treatmentOwnerStaffId: '', treatmentDueDate: '', treatmentNotes: '' });
  const [control, setControl] = useState({ controlDescription: '', controlType: 'engineering', responsibleStaffId: '', targetDate: '', createAction: true });
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function loadControls(id: number) {
    try { const d = await api<{ controls: RiskControl[] }>(`/risks/${id}`); setControls(d.controls || []); }
    catch { setControls([]); }
  }

  function pick(r: RiskRow) {
    setSel(r); setError(null); setMsg(null);
    setPlan({
      treatmentOption: r.treatment_option || 'reduce', mitigationPlan: r.mitigation_plan || '',
      treatmentOwnerStaffId: r.treatment_owner_staff_id ? String(r.treatment_owner_staff_id) : '',
      treatmentDueDate: r.treatment_due_date || '', treatmentNotes: r.treatment_notes || '',
    });
    void loadControls(r.id);
  }

  async function savePlan() {
    if (!sel) return;
    setBusy(true); setError(null);
    try {
      await api(`/risks/${sel.id}/treatment`, { method: 'POST', body: JSON.stringify(plan) });
      setMsg('Control plan saved.'); onChanged();
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }

  async function addControl() {
    if (!sel) return;
    if (!control.controlDescription.trim()) { setError('Describe the control measure.'); return; }
    setBusy(true); setError(null);
    try {
      await api(`/risks/${sel.id}/controls`, { method: 'POST', body: JSON.stringify(control) });
      setControl({ controlDescription: '', controlType: 'engineering', responsibleStaffId: '', targetDate: '', createAction: true });
      await loadControls(sel.id); setMsg('Control measure added.');
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }

  async function updateControl(c: RiskControl, patch: Partial<RiskControl>) {
    if (!sel) return;
    try {
      await api(`/risks/${sel.id}/controls/${c.id}`, { method: 'PUT', body: JSON.stringify({ ...patch }) });
      await loadControls(sel.id);
    } catch (e) { setError(errorText(e)); }
  }

  async function removeControl(c: RiskControl) {
    if (!sel) return;
    try { await api(`/risks/${sel.id}/controls/${c.id}`, { method: 'DELETE' }); await loadControls(sel.id); }
    catch (e) { setError(errorText(e)); }
  }

  async function complete() {
    if (!sel) return;
    setBusy(true); setError(null);
    try {
      await api(`/risks/${sel.id}/treatment/complete`, { method: 'POST', body: JSON.stringify({ treatmentNotes: plan.treatmentNotes }) });
      setSel(null);
      onChanged(`Controls for ${sel.risk_number} are implemented. It now awaits residual risk assessment.`, 'Residual Risk');
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }

  const outstanding = controls.filter(c => c.status !== 'implemented').length;

  return <div className="card">
    <StageHead stage="treatment" title="Risk control" />
    {error && <Notice kind="error">{error}</Notice>}
    {msg && <Notice kind="success">{msg}</Notice>}
    <QueueTable rows={rows} criteria={criteria} columns={['Initial risk', 'Option', 'Responsible', 'Target']} action="Plan"
      onPick={pick} onOpen={onOpen} empty="No risks are awaiting control." />

    {sel && <WorkPanel risk={sel} onClose={() => setSel(null)}>
      <p style={{ margin: '6px 0' }}>Initial risk: <BandChip level={sel.risk_level} score={sel.risk_score} criteria={criteria} /></p>
      <h4 style={{ marginBottom: 4 }}>Control plan</h4>
      <div className="form-grid">
        <label>Control option
          <select value={plan.treatmentOption} onChange={e => setPlan({ ...plan, treatmentOption: e.target.value })}>
            {CONTROL_OPTIONS.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
          </select>
        </label>
        <label>Responsible person
          <select value={plan.treatmentOwnerStaffId} onChange={e => setPlan({ ...plan, treatmentOwnerStaffId: e.target.value })}>
            <option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}
          </select>
        </label>
        <label>Target completion<input type="date" value={plan.treatmentDueDate} onChange={e => setPlan({ ...plan, treatmentDueDate: e.target.value })} /></label>
        <label style={{ gridColumn: '1 / -1' }}>Control plan
          <TextField as="textarea" value={plan.mitigationPlan} onValue={v => setPlan({ ...plan, mitigationPlan: v })} placeholder="What will be done, and how it lowers the likelihood or the severity" />
        </label>
      </div>
      <button style={{ marginTop: 8 }} disabled={busy || !criteria.canAssess} onClick={savePlan}>Save plan</button>

      <h4 style={{ marginTop: 18, marginBottom: 4 }}>Control measures</h4>
      <table className="table">
        <thead><tr><th>Control</th><th>Type</th><th>Responsible</th><th>Target</th><th>Status</th><th></th></tr></thead>
        <tbody>
          {controls.map(c => <tr key={c.id}>
            <td>{c.control_description}</td>
            <td>{optionLabel(CONTROL_TYPES, c.control_type)}</td>
            <td>{c.responsible_name || '—'}</td>
            <td>{fmtDate(c.target_date)}</td>
            <td><select value={c.status} disabled={!criteria.canAssess} onChange={e => updateControl(c, { status: e.target.value })}>
              {CONTROL_STATUSES.map(s => <option key={s.v} value={s.v}>{s.l}</option>)}
            </select></td>
            <td><button className="secondary" disabled={!criteria.canAssess} onClick={() => removeControl(c)}>Remove</button></td>
          </tr>)}
          {controls.length === 0 && <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 14 }}>No control measures yet.</td></tr>}
        </tbody>
      </table>

      <div className="form-grid" style={{ marginTop: 10 }}>
        <label style={{ gridColumn: '1 / -1' }}>Add a control measure
          <TextField value={control.controlDescription} onValue={v => setControl({ ...control, controlDescription: v })} placeholder="The measure to be put in place" />
        </label>
        <label>Control type
          <select value={control.controlType} onChange={e => setControl({ ...control, controlType: e.target.value })}>
            {CONTROL_TYPES.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
          </select>
        </label>
        <label>Responsible
          <select value={control.responsibleStaffId} onChange={e => setControl({ ...control, responsibleStaffId: e.target.value })}>
            <option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}
          </select>
        </label>
        <label>Target date<input type="date" value={control.targetDate} onChange={e => setControl({ ...control, targetDate: e.target.value })} /></label>
        <label className="check-inline" style={{ alignSelf: 'end' }}>
          <input type="checkbox" checked={control.createAction} onChange={e => setControl({ ...control, createAction: e.target.checked })} /> Also raise this on the action tracker
        </label>
      </div>
      <button style={{ marginTop: 8 }} className="secondary" disabled={busy || !criteria.canAssess} onClick={addControl}>Add control</button>

      <div style={{ marginTop: 18, borderTop: '1px solid var(--border, #dde)', paddingTop: 12 }}>
        {outstanding > 0
          ? <p className="muted" style={{ marginTop: 0 }}>{outstanding} control measure(s) still outstanding. Mark each one implemented to move this risk on.</p>
          : <p className="muted" style={{ marginTop: 0 }}>All control measures are implemented. The risk can now be re-scored.</p>}
        <button disabled={busy || !criteria.canAssess || controls.length === 0 || outstanding > 0} onClick={complete}>
          {busy ? 'Saving…' : 'Controls implemented — assess residual risk'}
        </button>
      </div>
    </WorkPanel>}
  </div>;
}

// --- step 5: residual risk -------------------------------------------------

export function ResidualStage({ rows, criteria, onChanged, onOpen }: StageProps) {
  const [sel, setSel] = useState<RiskRow | null>(null);
  const [likelihood, setLikelihood] = useState<number | null>(null);
  const [severity, setSeverity] = useState<number | null>(null);
  const [confirmIncrease, setConfirmIncrease] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function pick(r: RiskRow) {
    setSel(r); setError(null); setConfirmIncrease(false);
    setLikelihood(r.residual_likelihood ?? null); setSeverity(r.residual_severity ?? null);
  }

  async function submit() {
    if (!sel) return;
    if (!likelihood || !severity) { setError('Select a cell on the matrix to set the residual likelihood and severity.'); return; }
    setBusy(true); setError(null);
    try {
      const r = await api<{ score: number; levelLabel: string }>(`/risks/${sel.id}/residual`, {
        method: 'POST', body: JSON.stringify({ residualLikelihood: likelihood, residualSeverity: severity, confirmIncrease }),
      });
      setSel(null);
      onChanged(`Residual risk for ${sel.risk_number} is ${r.score} (${r.levelLabel}). It now awaits an acceptance decision.`, 'Risk Acceptance');
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }

  const score = likelihood && severity ? likelihood * severity : null;
  const worse = score != null && sel?.risk_score != null && score > sel.risk_score;

  return <div className="card">
    <StageHead stage="residual" title="Residual risk" />
    {error && <Notice kind="error">{error}</Notice>}
    <QueueTable rows={rows} criteria={criteria} columns={['Initial risk', 'Responsible', 'Target']} action="Re-score"
      onPick={pick} onOpen={onOpen} empty="No controlled risks are waiting to be re-scored." />

    {sel && <WorkPanel risk={sel} onClose={() => setSel(null)}>
      <p style={{ margin: '6px 0' }}>Initial risk: <BandChip level={sel.risk_level} score={sel.risk_score} criteria={criteria} /></p>
      <p><strong>Control plan:</strong> {sel.mitigation_plan || '—'}</p>
      <h4 style={{ marginBottom: 4 }}>Score the remaining risk (click a cell)</h4>
      <RiskMatrix occurrence={likelihood} severity={severity} onChange={(l, s) => { setLikelihood(l); setSeverity(s); }}
        rows={criteria.likelihood} columns={criteria.severity} bands={criteria.bands}
        rowLabel="Likelihood" columnLabel="Severity" scoreLabel="Residual risk score (Likelihood × Severity)" />
      {worse && <>
        <Notice kind="warn" style={{ marginTop: 8 }}>The residual score is higher than the initial score of {sel.risk_score}. Re-check the assessment before saving.</Notice>
        <label className="check-inline" style={{ display: 'block', marginTop: 6 }}>
          <input type="checkbox" checked={confirmIncrease} onChange={e => setConfirmIncrease(e.target.checked)} /> The increase is correct — save it
        </label>
      </>}
      <button style={{ marginTop: 10 }} disabled={busy || !criteria.canAssess || (worse && !confirmIncrease)} onClick={submit}>
        {busy ? 'Saving…' : 'Record residual risk'}
      </button>
    </WorkPanel>}
  </div>;
}

// --- step 6: risk acceptance ----------------------------------------------

export function AcceptanceStage({ rows, criteria, onChanged, onOpen }: StageProps) {
  const [sel, setSel] = useState<RiskRow | null>(null);
  const [decision, setDecision] = useState<'accepted' | 'further_treatment'>('accepted');
  const [justification, setJustification] = useState('');
  const [reviewDueDate, setReviewDueDate] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function pick(r: RiskRow) { setSel(r); setError(null); setDecision('accepted'); setJustification(''); setReviewDueDate(''); }

  async function submit() {
    if (!sel) return;
    if (!justification.trim()) { setError('Record the justification for this decision.'); return; }
    setBusy(true); setError(null);
    try {
      const r = await api<{ decision: string; reviewDueDate?: string | null; closed?: boolean }>(`/risks/${sel.id}/accept`, {
        method: 'POST', body: JSON.stringify({ decision, justification, reviewDueDate: reviewDueDate || undefined }),
      });
      setSel(null);
      onChanged(
        r.decision !== 'accepted' ? `${sel.risk_number} returned for further control.`
          : r.closed ? `${sel.risk_number} accepted and closed.`
            : `${sel.risk_number} accepted. Next review ${r.reviewDueDate}.`,
        r.decision !== 'accepted' ? 'Risk Control' : r.closed ? 'Risk Register' : 'Monitoring & Review',
      );
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }

  const band = sel ? criteria.bands.find(b => b.level === (sel.residual_level || sel.risk_level)) : null;

  return <div className="card">
    <StageHead stage="acceptance" title="Risk acceptance" />
    <p className="hint" style={{ marginTop: 0 }}>Reserved to: {criteria.acceptanceRoles.join(', ')}.</p>
    {error && <Notice kind="error">{error}</Notice>}
    {!criteria.canAccept && <Notice kind="info">You can see this queue, but accepting a residual risk requires an authorising role.</Notice>}
    <QueueTable rows={rows} criteria={criteria} columns={['Initial risk', 'Residual risk', 'Responsible']} action="Decide"
      onPick={pick} onOpen={onOpen} empty="No risks are awaiting an acceptance decision." />

    {sel && <WorkPanel risk={sel} onClose={() => setSel(null)}>
      <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap', margin: '6px 0 10px' }}>
        <span>Initial risk: <BandChip level={sel.risk_level} score={sel.risk_score} criteria={criteria} /></span>
        <span>Residual risk: {sel.residual_score != null ? <BandChip level={sel.residual_level} score={sel.residual_score} criteria={criteria} /> : <span className="badge">Not assessed</span>}</span>
      </div>
      {band && <p className="muted" style={{ marginTop: 0 }}>{band.action}</p>}
      <p><strong>Control plan:</strong> {sel.mitigation_plan || '—'}</p>
      <div className="form-grid">
        <label>Decision
          <select value={decision} onChange={e => setDecision(e.target.value as 'accepted' | 'further_treatment')}>
            <option value="accepted">Accept the residual risk</option>
            <option value="further_treatment">Not acceptable — return for further control</option>
          </select>
        </label>
        {decision === 'accepted' && band && <label>Next review due
          <input type="date" value={reviewDueDate} onChange={e => setReviewDueDate(e.target.value)} />
          <small className="muted">{band.reviewMonths
            ? `Leave blank for the ${band.label} cycle of ${band.reviewMonths} month(s).`
            : `${band.label} risks close on acceptance. Set a date to keep this one under review.`}</small>
        </label>}
        <label style={{ gridColumn: '1 / -1' }}>Justification
          <TextField as="textarea" value={justification} onValue={setJustification} placeholder="Why this residual risk is, or is not, acceptable" />
        </label>
      </div>
      <button style={{ marginTop: 10 }} disabled={busy || !criteria.canAccept} onClick={submit}>
        {busy ? 'Saving…'
          : decision !== 'accepted' ? 'Return for further control'
            : (band && !band.reviewMonths && !reviewDueDate) ? 'Accept and close' : 'Accept and sign'}
      </button>
    </WorkPanel>}
  </div>;
}

// --- step 7: monitoring & review ------------------------------------------

export function MonitoringStage({ rows, criteria, onChanged, onOpen }: StageProps) {
  const [sel, setSel] = useState<RiskRow | null>(null);
  const [outcome, setOutcome] = useState<'unchanged' | 'reassess' | 'close'>('unchanged');
  const [notes, setNotes] = useState('');
  const [nextReviewDate, setNextReviewDate] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dueOnly, setDueOnly] = useState(true);

  const today = new Date().toISOString().slice(0, 10);
  const shown = dueOnly ? rows.filter(r => r.review_due_date && r.review_due_date <= today) : rows;

  function pick(r: RiskRow) { setSel(r); setError(null); setOutcome('unchanged'); setNotes(''); setNextReviewDate(''); }

  async function submit() {
    if (!sel) return;
    if (!notes.trim()) { setError('Record what the review found.'); return; }
    setBusy(true); setError(null);
    try {
      const r = await api<{ outcome: string; nextReviewDate: string | null }>(`/risks/${sel.id}/review`, {
        method: 'POST', body: JSON.stringify({ outcome, reviewNotes: notes, nextReviewDate: nextReviewDate || undefined }),
      });
      setSel(null);
      onChanged(
        r.outcome === 'close' ? `${sel.risk_number} closed.`
          : r.outcome === 'reassess' ? `${sel.risk_number} sent back for re-analysis on the matrix.`
            : `${sel.risk_number} reviewed. Next review ${r.nextReviewDate || 'not scheduled'}.`,
        r.outcome === 'reassess' ? 'Risk Analysis' : undefined,
      );
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }

  const band = sel ? criteria.bands.find(b => b.level === (sel.residual_level || sel.risk_level)) : null;

  return <div className="card">
    <StageHead stage="monitoring" title="Monitoring & review" />
    <label className="check-inline" style={{ display: 'block', margin: '0 0 8px' }}>
      <input type="checkbox" checked={dueOnly} onChange={e => setDueOnly(e.target.checked)} /> Show only reviews that are due
    </label>
    {error && <Notice kind="error">{error}</Notice>}
    <QueueTable rows={shown} criteria={criteria} columns={['Residual risk', 'Responsible', 'Review due']} action="Review"
      onPick={pick} onOpen={onOpen} empty={dueOnly ? 'No reviews are due.' : 'No risks are being monitored.'} />

    {sel && <WorkPanel risk={sel} onClose={() => setSel(null)}>
      <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap', margin: '6px 0 10px' }}>
        <span>Residual risk: <BandChip level={sel.residual_level} score={sel.residual_score} criteria={criteria} /></span>
        <span className="muted">Last review {fmtDate(sel.last_review_date)} · due {fmtDate(sel.review_due_date)}</span>
      </div>
      <div className="form-grid">
        <label>Review outcome
          <select value={outcome} onChange={e => setOutcome(e.target.value as typeof outcome)}>
            <option value="unchanged">Unchanged — controls remain effective</option>
            <option value="reassess">Circumstances changed — re-analyse the risk</option>
            <option value="close">No longer applicable — close the risk</option>
          </select>
        </label>
        {outcome !== 'close' && band && <label>Next review due
          <input type="date" value={nextReviewDate} onChange={e => setNextReviewDate(e.target.value)} />
          <small className="muted">Leave blank to use your {band.label} review cycle of {band.reviewMonths} month(s).</small>
        </label>}
        <label style={{ gridColumn: '1 / -1' }}>Review notes
          <TextField as="textarea" value={notes} onValue={setNotes} placeholder="What the review found — are the controls still in place and still working?" />
        </label>
      </div>
      <button style={{ marginTop: 10 }} disabled={busy || !criteria.canAssess} onClick={submit}>{busy ? 'Saving…' : 'Record review and sign'}</button>
    </WorkPanel>}
  </div>;
}
