import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import DetailModal from '../../components/ui/DetailModal';
import { api, errorText } from '../../services/api';
import { usePermissions } from '../../hooks/usePermissions';
import { useAuth } from '../../hooks/useAuth';
import { Notice } from '../../components/ui/Feedback';
import TextField from '../../components/ui/TextField';
import RiskStepper from './RiskStepper';
import { openPrintWindow } from '../qmsShared';
import {
  BandChip, CONTROL_OPTIONS, CONTROL_TYPES, RISK_CATEGORIES, RISK_SOURCES,
  chosenLabel, fmtDate, identifiedByLabel, optionLabel,
  type RiskCriteriaState, type RiskDetail as RiskDetailRecord,
} from './riskShared';

// The whole life of one risk on a single page: what was identified, what it
// scored, what was done about it, what remains, who accepted it and every
// review since. Read-only — each stage is worked in its own queue.

/** A field, drawn only when it has something to say — an empty line on a record
 *  reads as work left undone, so it is left out rather than dashed. */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  const empty = children === null || children === undefined || children === '' || children === false;
  if (empty) return null;
  return <div style={{ marginBottom: 8 }}>
    <div className="muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.04em' }}>{label}</div>
    <div>{children}</div>
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
  const { user } = useAuth();
  // Permanent deletion is administrator-only and kept out of plain sight; the
  // server enforces the same restriction independently.
  const isAdmin = user?.isAdministrator === true;
  const [risk, setRisk] = useState<RiskDetailRecord | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteReason, setDeleteReason] = useState('');
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

  async function remove() {
    setBusy(true); setError(null);
    try {
      const r = await api<{ riskNumber: string }>(`/risks/${riskId}`, { method: 'DELETE', body: JSON.stringify({ reason: deleteReason }) });
      onChanged(); onClose();
      window.setTimeout(() => window.alert(`${r.riskNumber} was permanently deleted.`), 0);
    } catch (e) { setError(errorText(e)); setBusy(false); }
  }

  if (!risk) {
    return <DetailModal open onClose={onClose} title="Risk record">
      {error ? <Notice kind="error">{error}</Notice> : <p className="muted">Loading…</p>}
    </DetailModal>;
  }

  const controls = risk.controls ?? [];
  const reviews = risk.reviews ?? [];
  const signatures = risk.signatures ?? [];
  // Which parts of the lifecycle this risk has actually been through. A stage
  // nobody has reached yet is not drawn at all.
  const assessed = risk.risk_score != null;
  const controlled = !!risk.treatment_option || !!risk.mitigation_plan || controls.length > 0;
  const decided = !!risk.acceptance_decision || risk.residual_score != null;
  const monitored = reviews.length > 0 || !!risk.review_due_date || !!risk.last_review_date;

  return <DetailModal open onClose={onClose}
    title={<>{risk.risk_number} <BandChip level={risk.residual_level || risk.risk_level} score={risk.residual_score ?? risk.risk_score} criteria={criteria} /></>}
    subtitle={`${risk.risk_area} · ${risk.section_name || 'Laboratory-wide'}`}
    header={<>
      {can('risks', 'print') && <button className="secondary" onClick={printReport}>Print report</button>}
      {can('nc_capa', 'create') && <button className="secondary" disabled={busy} onClick={raiseCapa}>Raise CAPA</button>}
      {risk.status !== 'closed' && can('risks', 'void_archive') && <button className="secondary" disabled={busy} onClick={closeRisk}>Close risk</button>}
      {risk.status === 'closed' && can('risks', 'edit') && <button className="secondary" disabled={busy} onClick={reopen}>Reopen</button>}
      {isAdmin && <div className="dm-menuwrap" style={{ position: 'relative' }}>
        <button className="secondary" onClick={() => { setDeleting(o => !o); setDeleteReason(''); }}>Admin ▾</button>
        {deleting && <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 35 }} onClick={() => setDeleting(false)} />
          <div className="dm-admin-menu" style={{ minWidth: 300 }}>
            <span className="dm-admin-menu-head">Administrator only</span>
            <label style={{ padding: '2px 8px 8px', fontSize: 12 }}>Reason for deleting {risk.risk_number}
              <TextField as="textarea" value={deleteReason} onValue={setDeleteReason} placeholder="Why this record is being removed" />
            </label>
            <button className="dm-danger-item" disabled={busy || deleteReason.trim().length < 10} onClick={remove}>
              🗑 Delete {risk.risk_number} permanently
            </button>
          </div>
        </>}
      </div>}
    </>}>
    {error && <Notice kind="error">{error}</Notice>}
    {msg && <Notice kind="success">{msg}</Notice>}
    <RiskStepper active={risk.workflow_stage} />

    <div className="grid cols-2">
      <div>
        <Field label="Identified">{`${fmtDate(risk.identified_date)} by ${identifiedByLabel(risk)}`}</Field>
        <Field label="Category">{risk.risk_category ? chosenLabel(RISK_CATEGORIES, risk.risk_category, risk.risk_category_other) : null}</Field>
        <Field label="Source">{risk.risk_source ? chosenLabel(RISK_SOURCES, risk.risk_source, risk.risk_source_other) : null}</Field>
      </div>
      <div>
        <Field label="Unit / section">{risk.section_name || 'Laboratory-wide'}</Field>
        <Field label="Process affected">{risk.process_affected}</Field>
        <Field label="Responsible person">{risk.responsible_name}</Field>
      </div>
    </div>

    <Section title="Risk identification">
      <Field label="Description">{risk.risk_description}</Field>
      <Field label="Cause / source">{risk.cause}</Field>
      <Field label="Potential consequence">{risk.consequence}</Field>
      <Field label="Existing controls">{risk.existing_controls}</Field>
      <Field label="Affects patient or staff safety">{risk.affects_patient_safety ? 'Yes' : 'No'}</Field>
    </Section>

    {assessed && <Section title="Assessment & evaluation">
      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginBottom: 8 }}>
        <span>Initial risk: <BandChip level={risk.risk_level} score={risk.risk_score} criteria={criteria} /></span>
        <span className="muted">Likelihood {risk.likelihood ?? '—'} × Severity {risk.severity ?? '—'}</span>
        <span className="muted">Assessed {fmtDate(risk.analysed_at)}</span>
      </div>
      <Field label="Evaluation outcome">{risk.evaluation_decision ? (risk.evaluation_decision === 'treat' ? 'Control required' : 'Tolerable — retain') : null}</Field>
      <Field label="Assessment notes">{risk.analysis_notes}</Field>
    </Section>}

    {controlled && <Section title="Risk control">
      <Field label="Control option">{risk.treatment_option ? optionLabel(CONTROL_OPTIONS, risk.treatment_option) : null}</Field>
      <Field label="Control plan">{risk.mitigation_plan}</Field>
      <Field label="Responsible person">{risk.treatment_owner_name}</Field>
      <Field label="Target completion">{risk.treatment_due_date ? fmtDate(risk.treatment_due_date) : null}</Field>
      <table className="table">
        <thead><tr><th>Control measure</th><th>Type</th><th>Responsible person</th><th>Target</th><th>Status</th><th>Completed</th></tr></thead>
        <tbody>
          {controls.map(c => <tr key={c.id}>
            <td>{c.control_description}</td><td>{optionLabel(CONTROL_TYPES, c.control_type)}</td>
            <td>{c.responsible_name || '—'}</td><td>{fmtDate(c.target_date)}</td>
            <td>{String(c.status).replace(/_/g, ' ')}</td><td>{fmtDate(c.completed_date)}</td>
          </tr>)}
          {controls.length === 0 && <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 14 }}>No control measures recorded.</td></tr>}
        </tbody>
      </table>
    </Section>}

    {decided && <Section title="Residual risk & acceptance">
      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginBottom: 8 }}>
        <span>Residual risk: {risk.residual_score != null ? <BandChip level={risk.residual_level} score={risk.residual_score} criteria={criteria} /> : <span className="badge">Not assessed</span>}</span>
        <span className="muted">Assessed {fmtDate(risk.residual_assessed_at)}</span>
      </div>
      <Field label="Decision">{risk.acceptance_decision ? String(risk.acceptance_decision).replace(/_/g, ' ') : null}</Field>
      <Field label="Justification">{risk.acceptance_justification}</Field>
      <Field label="Accepted by">{risk.accepted_by_name ? `${risk.accepted_by_name} · ${fmtDate(risk.accepted_at)}` : null}</Field>
    </Section>}

    {monitored && <Section title="Monitoring & review">
      <Field label="Last review">{risk.last_review_date ? fmtDate(risk.last_review_date) : null}</Field>
      <Field label="Next review due">{risk.review_due_date ? fmtDate(risk.review_due_date) : null}</Field>
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
    </Section>}

    {signatures.length > 0 && <Section title="Authorisations">
      <table className="table">
        <thead><tr><th>Stage</th><th>Signed by</th><th>When</th></tr></thead>
        <tbody>
          {signatures.map(s => <tr key={s.id}>
            <td>{s.meaning || String(s.purpose).replace(/_/g, ' ')}</td>
            <td>{s.signer_name || '—'}</td>
            <td>{String(s.signed_at).slice(0, 16).replace('T', ' ')}</td>
          </tr>)}
        </tbody>
      </table>
    </Section>}

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
