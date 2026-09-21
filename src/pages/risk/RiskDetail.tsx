import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import DetailModal from '../../components/ui/DetailModal';
import { api, errorText } from '../../services/api';
import { usePermissions } from '../../hooks/usePermissions';
import { Notice } from '../../components/ui/Feedback';
import RiskStepper from './RiskStepper';
import { openPrintWindow } from '../qmsShared';
import {
  BandChip, CONTROL_TYPES, RISK_CATEGORIES, RISK_SOURCES, TREATMENT_OPTIONS,
  fmtDate, optionLabel, type RiskCriteriaState, type RiskDetail as RiskDetailRecord,
} from './riskShared';

// The whole life of one risk on a single page: what was identified, what it
// scored, what was done about it, what remains, who accepted it and every
// review since. Read-only — each stage is worked in its own queue.

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div style={{ marginBottom: 8 }}>
    <div className="muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.04em' }}>{label}</div>
    <div>{children || '—'}</div>
  </div>;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section style={{ marginTop: 18 }}>
    <h4 style={{ margin: '0 0 8px', paddingBottom: 4, borderBottom: '1px solid var(--border, #dde)' }}>{title}</h4>
    {children}
  </section>;
}

export default function RiskDetailModal({ riskId, criteria, onClose, onChanged }: {
  riskId: number; criteria: RiskCriteriaState; onClose: () => void; onChanged: () => void;
}) {
  const { can } = usePermissions();
  const [risk, setRisk] = useState<RiskDetailRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    try { setRisk(await api<RiskDetailRecord>(`/risks/${riskId}`)); }
    catch (e) { setError(errorText(e)); }
  }
  useEffect(() => { void load(); }, [riskId]);

  async function raiseCapa() {
    setBusy(true); setError(null);
    try {
      const r = await api<{ capaNumber: string; existing?: boolean }>(`/risks/${riskId}/create-capa`, { method: 'POST', body: JSON.stringify({}) });
      setMsg(r.existing ? `Already managed as CAPA ${r.capaNumber}.` : `CAPA ${r.capaNumber} raised from this risk.`);
      await load(); onChanged();
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }

  async function closeRisk() {
    setBusy(true); setError(null);
    try {
      await api(`/risks/${riskId}/close`, { method: 'POST', body: JSON.stringify({ closureNotes: 'Closed from the risk record.' }) });
      setMsg('Risk closed.'); await load(); onChanged();
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }

  async function reopen() {
    setBusy(true); setError(null);
    try {
      await api(`/risks/${riskId}/reopen`, { method: 'POST', body: JSON.stringify({}) });
      setMsg('Risk reopened for re-analysis.'); await load(); onChanged();
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }

  function printReport() {
    void openPrintWindow(`/risks/${riskId}/print`, m => setError(m));
  }

  if (!risk) {
    return <DetailModal open onClose={onClose} title="Risk record">
      {error ? <Notice kind="error">{error}</Notice> : <p className="muted">Loading…</p>}
    </DetailModal>;
  }

  const controls = risk.controls ?? [];
  const reviews = risk.reviews ?? [];
  const signatures = risk.signatures ?? [];

  return <DetailModal open onClose={onClose}
    title={<>{risk.risk_number} <BandChip level={risk.residual_level || risk.risk_level} score={risk.residual_score ?? risk.risk_score} criteria={criteria} /></>}
    subtitle={`${risk.risk_area} · ${risk.section_name || 'Laboratory-wide'}`}
    header={<>
      {can('risks', 'print') && <button className="secondary" onClick={printReport}>Print report</button>}
      {can('nc_capa', 'create') && <button className="secondary" disabled={busy} onClick={raiseCapa}>Raise CAPA</button>}
      {risk.status !== 'closed' && can('risks', 'void_archive') && <button className="secondary" disabled={busy} onClick={closeRisk}>Close risk</button>}
      {risk.status === 'closed' && can('risks', 'edit') && <button className="secondary" disabled={busy} onClick={reopen}>Reopen</button>}
    </>}>
    {error && <Notice kind="error">{error}</Notice>}
    {msg && <Notice kind="success">{msg}</Notice>}
    <RiskStepper active={risk.workflow_stage} />

    <div className="grid cols-2">
      <div>
        <Field label="Identified">{fmtDate(risk.identified_date)} by {risk.identified_by_name || '—'}</Field>
        <Field label="Category">{optionLabel(RISK_CATEGORIES, risk.risk_category)}</Field>
        <Field label="Source">{optionLabel(RISK_SOURCES, risk.risk_source)}</Field>
      </div>
      <div>
        <Field label="Unit / section">{risk.section_name}</Field>
        <Field label="Process affected">{risk.process_affected}</Field>
        <Field label="Risk owner">{risk.responsible_name}</Field>
      </div>
    </div>

    <Section title="Risk identification">
      <Field label="Description">{risk.risk_description}</Field>
      <Field label="Cause / source">{risk.cause}</Field>
      <Field label="Potential consequence">{risk.consequence}</Field>
      <Field label="Existing controls">{risk.existing_controls}</Field>
      <Field label="Affects patient safety">{risk.affects_patient_safety ? 'Yes' : 'No'}</Field>
    </Section>

    <Section title="Analysis & evaluation">
      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginBottom: 8 }}>
        <span>Initial risk: <BandChip level={risk.risk_level} score={risk.risk_score} criteria={criteria} /></span>
        <span className="muted">Likelihood {risk.likelihood ?? '—'} × Severity {risk.severity ?? '—'}</span>
        <span className="muted">Assessed {fmtDate(risk.analysed_at)}</span>
      </div>
      <Field label="Evaluation outcome">{risk.evaluation_decision ? (risk.evaluation_decision === 'treat' ? 'Treat — controls required' : 'Retain — tolerable as it stands') : '—'}</Field>
      <Field label="Analysis notes">{risk.analysis_notes}</Field>
    </Section>

    <Section title="Risk control">
      <Field label="Treatment option">{risk.treatment_option ? optionLabel(TREATMENT_OPTIONS, risk.treatment_option) : '—'}</Field>
      <Field label="Treatment plan">{risk.mitigation_plan}</Field>
      <Field label="Owner / target">{risk.treatment_owner_name || '—'} · {fmtDate(risk.treatment_due_date)}</Field>
      <table className="table">
        <thead><tr><th>Control measure</th><th>Type</th><th>Responsible</th><th>Target</th><th>Status</th><th>Completed</th></tr></thead>
        <tbody>
          {controls.map(c => <tr key={c.id}>
            <td>{c.control_description}</td><td>{optionLabel(CONTROL_TYPES, c.control_type)}</td>
            <td>{c.responsible_name || '—'}</td><td>{fmtDate(c.target_date)}</td>
            <td>{String(c.status).replace(/_/g, ' ')}</td><td>{fmtDate(c.completed_date)}</td>
          </tr>)}
          {controls.length === 0 && <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 14 }}>No control measures recorded.</td></tr>}
        </tbody>
      </table>
    </Section>

    <Section title="Residual risk & acceptance">
      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginBottom: 8 }}>
        <span>Residual risk: {risk.residual_score != null ? <BandChip level={risk.residual_level} score={risk.residual_score} criteria={criteria} /> : <span className="badge">Not assessed</span>}</span>
        <span className="muted">Assessed {fmtDate(risk.residual_assessed_at)}</span>
      </div>
      <Field label="Decision">{risk.acceptance_decision ? String(risk.acceptance_decision).replace(/_/g, ' ') : '—'}</Field>
      <Field label="Justification">{risk.acceptance_justification}</Field>
      <Field label="Accepted by">{risk.accepted_by_name ? `${risk.accepted_by_name} · ${fmtDate(risk.accepted_at)}` : '—'}</Field>
    </Section>

    <Section title="Monitoring & review">
      <Field label="Review schedule">Last {fmtDate(risk.last_review_date)} · next due {fmtDate(risk.review_due_date)}</Field>
      <table className="table">
        <thead><tr><th>Date</th><th>Outcome</th><th>Residual</th><th>Reviewed by</th><th>Notes</th><th>Next due</th></tr></thead>
        <tbody>
          {reviews.map(v => <tr key={v.id}>
            <td>{fmtDate(v.review_date)}</td><td>{String(v.outcome || '—').replace(/_/g, ' ')}</td>
            <td>{v.residual_score ?? v.risk_score ?? '—'}</td><td>{v.reviewed_by_name || '—'}</td>
            <td>{v.review_notes}</td><td>{fmtDate(v.next_review_date)}</td>
          </tr>)}
          {reviews.length === 0 && <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 14 }}>No reviews recorded.</td></tr>}
        </tbody>
      </table>
    </Section>

    <Section title="Authorisations">
      <table className="table">
        <thead><tr><th>Stage</th><th>Signed by</th><th>When</th></tr></thead>
        <tbody>
          {signatures.map(s => <tr key={s.id}>
            <td>{s.meaning || String(s.purpose).replace(/_/g, ' ')}</td>
            <td>{s.signer_name || '—'}</td>
            <td>{String(s.signed_at).slice(0, 16).replace('T', ' ')}</td>
          </tr>)}
          {signatures.length === 0 && <tr><td colSpan={3} className="muted" style={{ textAlign: 'center', padding: 14 }}>No stage has been signed yet.</td></tr>}
        </tbody>
      </table>
    </Section>

    {(risk.links?.length ?? 0) > 0 && <Section title="Linked records">
      <ul style={{ margin: 0, paddingLeft: 18 }}>
        {risk.links!.map(l => {
          const other = l.source_module_key === 'risks' ? l : { ...l, target_module_key: l.source_module_key, target_record_id: l.source_record_id };
          const to = other.target_module_key === 'nc_capa' ? '/capa' : other.target_module_key === 'actions' ? '/actions' : null;
          return <li key={l.id}>{to ? <Link to={to}>{l.notes || other.target_module_key}</Link> : (l.notes || other.target_module_key)}</li>;
        })}
      </ul>
    </Section>}
  </DetailModal>;
}
