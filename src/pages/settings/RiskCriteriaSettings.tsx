import { useEffect, useState } from 'react';
import { api, errorText } from '../../services/api';
import { Notice } from '../../components/ui/Feedback';
import TextField from '../../components/ui/TextField';
import RiskMatrix from '../../components/RiskMatrix';
import { DEFAULT_CRITERIA, type RiskCriteria, type RiskCriteriaState } from '../risk/riskShared';

// ---------------------------------------------------------------------------
// User-defined risk criteria.
//
// A laboratory decides for itself what its 5x5 matrix means: how each step of
// likelihood and severity is worded, where the bands fall, which band forces
// treatment, how often each band is reviewed, and who may accept a residual
// risk. What is set here is what every module scores risk on.
// ---------------------------------------------------------------------------

const ACCEPTANCE_ROLES = ['System Administrator', 'Laboratory Manager', 'Quality Manager', 'Unit Supervisor', 'Safety Officer'];

export default function RiskCriteriaSettings() {
  const [criteria, setCriteria] = useState<RiskCriteriaState | null>(null);
  const [draft, setDraft] = useState<RiskCriteria | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ l: number | null; s: number | null }>({ l: null, s: null });

  useEffect(() => {
    api<RiskCriteriaState>('/risks/criteria')
      .then(c => { const merged = { ...DEFAULT_CRITERIA, ...c }; setCriteria(merged); setDraft(strip(merged)); })
      .catch(e => setError(errorText(e)));
  }, []);

  function strip(c: RiskCriteriaState): RiskCriteria {
    const { likelihood, severity, bands, treatmentThresholdLevel, requireResidualAssessment, acceptanceRoles, alwaysTreatPatientSafety } = c;
    return { likelihood, severity, bands, treatmentThresholdLevel, requireResidualAssessment, acceptanceRoles, alwaysTreatPatientSafety };
  }

  async function save() {
    if (!draft) return;
    setBusy(true); setError(null); setMsg(null);
    try {
      const saved = await api<RiskCriteria>('/risks/criteria', { method: 'PUT', body: JSON.stringify(draft) });
      setDraft(saved);
      setCriteria(c => c ? { ...c, ...saved } : c);
      setMsg('Risk criteria saved. They apply everywhere risk is scored.');
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }

  function reset() { setDraft(strip(DEFAULT_CRITERIA)); setMsg('Defaults restored — save to apply them.'); }

  if (error && !draft) return <Notice kind="error">{error}</Notice>;
  if (!draft || !criteria) return <p className="muted">Loading…</p>;

  const readOnly = !criteria.canConfigure || busy;
  const setScale = (key: 'likelihood' | 'severity', i: number, patch: Partial<{ label: string; description: string }>) =>
    setDraft({ ...draft, [key]: draft[key].map((step, n) => n === i ? { ...step, ...patch } : step) });
  const setBand = (i: number, patch: Record<string, unknown>) =>
    setDraft({ ...draft, bands: draft.bands.map((b, n) => n === i ? { ...b, ...patch } : b) });

  return <div>
    {error && <Notice kind="error">{error}</Notice>}
    {msg && <Notice kind="success">{msg}</Notice>}
    {!criteria.canConfigure && <Notice kind="info">You can see these criteria, but changing them requires settings permission.</Notice>}

    <div className="card">
      <h3 style={{ marginTop: 0 }}>Risk criteria</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        The 5×5 matrix below is what every risk assessment in this laboratory is scored on — risk management,
        nonconformities and incidents alike.
      </p>
    </div>

    <div className="card">
      <h3 style={{ marginTop: 0 }}>Likelihood scale</h3>
      <table className="table">
        <thead><tr><th style={{ width: 60 }}>Score</th><th style={{ width: '28%' }}>Label</th><th>Descriptor</th></tr></thead>
        <tbody>{draft.likelihood.map((step, i) => <tr key={step.score}>
          <td>{step.score}</td>
          <td><TextField value={step.label} onValue={v => setScale('likelihood', i, { label: v })} disabled={readOnly} /></td>
          <td><TextField value={step.description} onValue={v => setScale('likelihood', i, { description: v })} disabled={readOnly} /></td>
        </tr>)}</tbody>
      </table>
    </div>

    <div className="card">
      <h3 style={{ marginTop: 0 }}>Severity scale</h3>
      <table className="table">
        <thead><tr><th style={{ width: 60 }}>Score</th><th style={{ width: '28%' }}>Label</th><th>Descriptor</th></tr></thead>
        <tbody>{draft.severity.map((step, i) => <tr key={step.score}>
          <td>{step.score}</td>
          <td><TextField value={step.label} onValue={v => setScale('severity', i, { label: v })} disabled={readOnly} /></td>
          <td><TextField value={step.description} onValue={v => setScale('severity', i, { description: v })} disabled={readOnly} /></td>
        </tr>)}</tbody>
      </table>
    </div>

    <div className="card">
      <h3 style={{ marginTop: 0 }}>Risk bands</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        Set the upper bound of each band; the next band starts where the last one ended and the top band reaches 25.
        A band set to <strong>close on acceptance</strong> carries no recurring review — a risk in it is closed once
        it has been accepted, and reopened if anything changes.
      </p>
      <table className="table">
        <thead><tr><th>Band</th><th style={{ width: 80 }}>From</th><th style={{ width: 110 }}>Up to</th><th style={{ width: 90 }}>Colour</th><th style={{ width: 150 }}>Review cycle</th><th>What this band calls for</th></tr></thead>
        <tbody>{draft.bands.map((band, i) => <tr key={band.level}>
          <td><TextField value={band.label} onValue={v => setBand(i, { label: v })} disabled={readOnly} /></td>
          <td className="muted">{i === 0 ? 1 : draft.bands[i - 1].max + 1}</td>
          <td><input type="number" min={1} max={25} value={band.max} disabled={readOnly || i === draft.bands.length - 1}
            onChange={e => setBand(i, { max: Number(e.target.value) })} /></td>
          <td><input type="color" value={band.color} disabled={readOnly} onChange={e => setBand(i, { color: e.target.value })} style={{ width: 52, height: 30, padding: 2 }} /></td>
          <td><select value={band.reviewMonths} disabled={readOnly} onChange={e => setBand(i, { reviewMonths: Number(e.target.value) })}>
            <option value={0}>Close on acceptance</option>
            {[1, 2, 3, 6, 12, 24].map(m => <option key={m} value={m}>{m === 12 ? 'Annually' : m === 24 ? 'Every 2 years' : `Every ${m} month${m > 1 ? 's' : ''}`}</option>)}
          </select></td>
          <td><TextField value={band.action} onValue={v => setBand(i, { action: v })} disabled={readOnly} /></td>
        </tr>)}</tbody>
      </table>
    </div>

    <div className="card">
      <h3 style={{ marginTop: 0 }}>Acceptance rules</h3>
      <div className="form-grid">
        <label>Control is required at
          <select value={draft.treatmentThresholdLevel} disabled={readOnly}
            onChange={e => setDraft({ ...draft, treatmentThresholdLevel: e.target.value })}>
            <option value="off">Off — the assessor decides case by case</option>
            {draft.bands.map(b => <option key={b.level} value={b.level}>{b.label} ({b.min}–{b.max}) and above</option>)}
          </select>
        </label>
      </div>
      <label className="check-inline" style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12 }}>
        <input type="checkbox" checked={draft.alwaysTreatPatientSafety} disabled={readOnly}
          onChange={e => setDraft({ ...draft, alwaysTreatPatientSafety: e.target.checked })} />
        Always require control of a risk affecting patient or staff safety, whatever its band
      </label>
      <label className="check-inline" style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
        <input type="checkbox" checked={draft.requireResidualAssessment} disabled={readOnly}
          onChange={e => setDraft({ ...draft, requireResidualAssessment: e.target.checked })} />
        Require a residual risk assessment before a controlled risk may be accepted
      </label>

      <h4 style={{ marginBottom: 6, marginTop: 18 }}>Who may accept a residual risk</h4>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        {ACCEPTANCE_ROLES.map(role => <label key={role} className="check-inline" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input type="checkbox" checked={draft.acceptanceRoles.includes(role)} disabled={readOnly}
            onChange={e => setDraft({
              ...draft,
              acceptanceRoles: e.target.checked
                ? [...draft.acceptanceRoles, role]
                : draft.acceptanceRoles.filter(r => r !== role),
            })} />
          {role}
        </label>)}
      </div>
      <p className="hint" style={{ marginTop: 8 }}>At least one role must be able to accept a risk.</p>
    </div>

    <div className="card">
      <h3 style={{ marginTop: 0 }}>Preview</h3>
      <p className="muted" style={{ marginTop: 0 }}>How the matrix will look to an assessor.</p>
      <RiskMatrix occurrence={preview.l} severity={preview.s} onChange={(l, s) => setPreview({ l, s })}
        rows={draft.likelihood} columns={draft.severity} bands={draft.bands}
        rowLabel="Likelihood" columnLabel="Severity" scoreLabel="Risk score (Likelihood × Severity)" />
    </div>

    <div className="card" style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
      <button disabled={readOnly || draft.acceptanceRoles.length === 0} onClick={save}>{busy ? 'Saving…' : 'Save risk criteria'}</button>
      <button className="secondary" disabled={readOnly} onClick={reset}>Restore defaults</button>
    </div>
  </div>;
}
