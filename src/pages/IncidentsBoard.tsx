import { FormEvent, useEffect, useState } from 'react';
import { api } from '../services/api';
import RiskMatrix, { riskLevelBadge } from '../components/RiskMatrix';
import XlsxToolbar from '../components/XlsxToolbar';
import type { Staff, Section } from '../../shared/types/api';

// Incident / Adverse Event / Occurrence management (ISO 15189 risk management;
// ISO 22367). Report events, risk-rate them on the 5x5 matrix, investigate and
// escalate to a nonconformity when needed.

type Incident = {
  id: number; incident_number: string; incident_datetime: string | null; incident_type: string | null; incident_type_other: string | null;
  is_near_miss: number; section_id: number | null; section_name: string | null; location_text: string | null; persons_involved: string | null;
  description: string | null; immediate_action: string | null; harm_level: string | null; occurrence_score: number | null; severity_score: number | null;
  risk_score: number | null; risk_level: string | null; reported_by_staff_id: number | null; reported_by_name: string | null; reported_by_full: string | null;
  investigation_team: string | null; root_cause: string | null; rca_method: string | null; contributing_factors: string | null;
  corrective_action: string | null; preventive_action: string | null; notified_to: string | null; reportable_external: number; external_authority: string | null;
  nc_id: number | null; nc_number: string | null; status: string; notes: string | null;
};

const INCIDENT_TYPES = [
  { v: 'patient_safety', l: 'Patient safety event' }, { v: 'staff_safety', l: 'Staff safety / injury' }, { v: 'near_miss', l: 'Near miss' },
  { v: 'sentinel_event', l: 'Sentinel event' }, { v: 'biosafety_exposure', l: 'Biosafety exposure' }, { v: 'needlestick', l: 'Needlestick / sharps' },
  { v: 'specimen_related', l: 'Specimen-related' }, { v: 'equipment_related', l: 'Equipment-related' }, { v: 'data_security', l: 'Data / IT security' },
  { v: 'fire_disaster', l: 'Fire / disaster' }, { v: 'other', l: 'Other' },
];
const HARM_LEVELS = [{ v: 'none', l: 'No harm' }, { v: 'minor', l: 'Minor' }, { v: 'moderate', l: 'Moderate' }, { v: 'severe', l: 'Severe' }, { v: 'death', l: 'Death' }];
const RCA_METHODS = [{ v: '5_whys', l: '5 Whys' }, { v: 'fishbone', l: 'Fishbone (Ishikawa)' }, { v: 'pareto', l: 'Pareto' }, { v: 'fault_tree', l: 'Fault tree' }, { v: 'other', l: 'Other' }];
const STATUSES = ['reported', 'under_investigation', 'action_in_progress', 'closed'];
const badge = (s?: string) => <span className={`badge ${s === 'closed' ? 'badge--success' : s === 'reported' ? 'badge--info' : 'badge--warning'}`}>{(s || '—').replace(/_/g, ' ')}</span>;

export default function IncidentsBoard({ staff, sections }: { staff: Staff[]; sections: Section[] }) {
  const [list, setList] = useState<Incident[]>([]);
  const [sel, setSel] = useState<Incident | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const blank = { incidentDatetime: new Date().toISOString().slice(0, 16), incidentType: 'patient_safety', incidentTypeOther: '', isNearMiss: false, sectionId: '', locationText: '', personsInvolved: '', description: '', immediateAction: '', harmLevel: 'none', occurrenceScore: null as number | null, severityScore: null as number | null, reportedByStaffId: '', reportedByName: '' };
  const [nf, setNf] = useState(blank);

  function load() { api<Incident[]>('/incidents').then(setList).catch(e => setError((e as Error).message)); }
  useEffect(() => { load(); }, []);
  async function open(id: number) { setError(null); try { setSel(await api<Incident>(`/incidents/${id}`)); } catch (e) { setError((e as Error).message); } }
  async function refresh() { if (sel) await open(sel.id); load(); }

  async function create(e: FormEvent) {
    e.preventDefault(); setError(null); setMsg(null);
    if (!nf.description) { setError('Describe the incident.'); return; }
    try { const r = await api<{ id: number; incidentNumber: string }>('/incidents', { method: 'POST', body: JSON.stringify(nf) }); setNf(blank); setShowNew(false); load(); await open(r.id); setMsg(`Incident ${r.incidentNumber} logged.`); }
    catch (e) { setError((e as Error).message); }
  }
  async function save(patch: Record<string, unknown>) { if (!sel) return; try { await api(`/incidents/${sel.id}`, { method: 'PUT', body: JSON.stringify(patch) }); await refresh(); } catch (e) { setError((e as Error).message); } }
  async function act(path: string, ok: string) { if (!sel) return; try { await api(`/incidents/${sel.id}/${path}`, { method: 'POST', body: JSON.stringify({}) }); setMsg(ok); await refresh(); } catch (e) { setError((e as Error).message); } }
  async function createNc() { if (!sel) return; try { const r = await api<{ ncNumber: string }>(`/incidents/${sel.id}/create-nc`, { method: 'POST', body: JSON.stringify({}) }); setMsg(`Nonconformity ${r.ncNumber} raised from this incident.`); await refresh(); } catch (e) { setError((e as Error).message); } }

  const canEdit = sel && sel.status !== 'closed';
  return <div>
    {error && <div className="error">{error}</div>}
    {msg && <div className="notice-ok">{msg}</div>}
    <div className="card">
      <div className="section-head" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <h3 style={{ margin: 0 }}>Incident / Adverse Event Register</h3>
        <button style={{ marginLeft: 'auto' }} onClick={() => setShowNew(v => !v)}>{showNew ? 'Cancel' : '+ Report incident'}</button>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>Report and manage incidents, adverse events, occurrences and near-misses. Each is risk-rated on the 5×5 matrix; high-risk events should be escalated to a nonconformity so the CAPA workflow follows.</p>
      <XlsxToolbar exportPath="/incidents/register/export" templatePath="/incidents/register/template" importPath="/incidents/register/import" exportName="Incidents.xlsx" onImported={load} />

      {showNew && <form className="form-grid" onSubmit={create} style={{ marginTop: 12, border: '1px solid var(--border, #ddd)', padding: 12, borderRadius: 8 }}>
        <label>Date &amp; time<input type="datetime-local" value={nf.incidentDatetime} onChange={e => setNf({ ...nf, incidentDatetime: e.target.value })} /></label>
        <label>Type<select value={nf.incidentType} onChange={e => setNf({ ...nf, incidentType: e.target.value })}>{INCIDENT_TYPES.map(t => <option key={t.v} value={t.v}>{t.l}</option>)}</select></label>
        {nf.incidentType === 'other' && <label>Specify type<input value={nf.incidentTypeOther} onChange={e => setNf({ ...nf, incidentTypeOther: e.target.value })} /></label>}
        <label className="check-inline"><input type="checkbox" checked={nf.isNearMiss} onChange={e => setNf({ ...nf, isNearMiss: e.target.checked })} /> Near miss (no harm occurred)</label>
        <label>Unit / section<select value={nf.sectionId} onChange={e => setNf({ ...nf, sectionId: e.target.value })}><option value="">—</option>{sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label>Location<input value={nf.locationText} onChange={e => setNf({ ...nf, locationText: e.target.value })} placeholder="e.g. Phlebotomy room" /></label>
        <label>Persons involved<input value={nf.personsInvolved} onChange={e => setNf({ ...nf, personsInvolved: e.target.value })} placeholder="Names / roles (no blame)" /></label>
        <label>Harm level<select value={nf.harmLevel} onChange={e => setNf({ ...nf, harmLevel: e.target.value })}>{HARM_LEVELS.map(h => <option key={h.v} value={h.v}>{h.l}</option>)}</select></label>
        <label>Reported by<select value={nf.reportedByStaffId} onChange={e => setNf({ ...nf, reportedByStaffId: e.target.value })}><option value="">Me</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
        <label style={{ gridColumn: '1 / -1' }}>Description (facts only)<textarea value={nf.description} onChange={e => setNf({ ...nf, description: e.target.value })} required /></label>
        <label style={{ gridColumn: '1 / -1' }}>Immediate action taken<textarea value={nf.immediateAction} onChange={e => setNf({ ...nf, immediateAction: e.target.value })} /></label>
        <div style={{ gridColumn: '1 / -1' }}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>Risk assessment (click a cell):</div>
          <RiskMatrix occurrence={nf.occurrenceScore} severity={nf.severityScore} onChange={(o, s) => setNf({ ...nf, occurrenceScore: o, severityScore: s })} />
        </div>
        <button type="submit">Log incident</button>
      </form>}

      <table className="data-table" style={{ marginTop: 12 }}><thead><tr><th>No</th><th>Date</th><th>Type</th><th>Unit</th><th>Risk</th><th>Status</th><th>NC</th><th></th></tr></thead><tbody>
        {list.map(i => <tr key={i.id}>
          <td>{i.incident_number}{i.is_near_miss ? <span className="badge">near miss</span> : null}</td>
          <td>{(i.incident_datetime || '').slice(0, 16).replace('T', ' ')}</td>
          <td>{(i.incident_type || '—').replace(/_/g, ' ')}</td>
          <td>{i.section_name || '—'}</td>
          <td>{i.risk_score != null ? <>{i.risk_score} {riskLevelBadge(i.risk_level)}</> : '—'}</td>
          <td>{badge(i.status)}</td>
          <td>{i.nc_number || '—'}</td>
          <td><button onClick={() => open(i.id)}>Open</button></td>
        </tr>)}
        {list.length === 0 && <tr><td colSpan={8} className="muted">No incidents reported yet.</td></tr>}
      </tbody></table>
    </div>

    {sel && <div className="card" style={{ marginTop: 16, borderTop: '3px solid #c1121f' }}>
      <div className="section-head" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <h3 style={{ margin: 0 }}>{sel.incident_number} {badge(sel.status)} {sel.risk_level ? riskLevelBadge(sel.risk_level) : null}</h3>
        <button style={{ marginLeft: 'auto' }} className="secondary" onClick={() => setSel(null)}>Close</button>
      </div>
      <p className="muted" style={{ fontSize: 12 }}>{(sel.incident_type || '').replace(/_/g, ' ')}{sel.is_near_miss ? ' · near miss' : ''} · {(sel.incident_datetime || '').slice(0, 16).replace('T', ' ')} · {sel.section_name || '—'}{sel.location_text ? ` · ${sel.location_text}` : ''} · reported by {sel.reported_by_full || sel.reported_by_name || '—'}</p>
      <p><strong>Description:</strong> {sel.description || '—'}</p>
      <p><strong>Immediate action:</strong> {sel.immediate_action || '—'}</p>
      <p><strong>Persons involved:</strong> {sel.persons_involved || '—'} · <strong>Harm:</strong> {sel.harm_level || '—'}</p>

      {canEdit && <>
        <h4 style={{ marginBottom: 4 }}>Risk assessment</h4>
        <RiskMatrix occurrence={sel.occurrence_score} severity={sel.severity_score} onChange={(o, s) => save({ occurrenceScore: o, severityScore: s })} />
        <h4 style={{ marginBottom: 4, marginTop: 14 }}>Investigation &amp; actions</h4>
        <div className="form-grid">
          <label>Investigation team<input defaultValue={sel.investigation_team || ''} onBlur={e => save({ investigationTeam: e.target.value })} /></label>
          <label>RCA method<select defaultValue={sel.rca_method || ''} onChange={e => save({ rcaMethod: e.target.value })}><option value="">—</option>{RCA_METHODS.map(m => <option key={m.v} value={m.v}>{m.l}</option>)}</select></label>
          <label style={{ gridColumn: '1 / -1' }}>Root cause<textarea defaultValue={sel.root_cause || ''} onBlur={e => save({ rootCause: e.target.value })} /></label>
          <label style={{ gridColumn: '1 / -1' }}>Contributing factors<textarea defaultValue={sel.contributing_factors || ''} onBlur={e => save({ contributingFactors: e.target.value })} /></label>
          <label style={{ gridColumn: '1 / -1' }}>Corrective action<textarea defaultValue={sel.corrective_action || ''} onBlur={e => save({ correctiveAction: e.target.value })} /></label>
          <label style={{ gridColumn: '1 / -1' }}>Preventive action<textarea defaultValue={sel.preventive_action || ''} onBlur={e => save({ preventiveAction: e.target.value })} /></label>
          <label>Notified to<input defaultValue={sel.notified_to || ''} onBlur={e => save({ notifiedTo: e.target.value })} placeholder="Manager, safety officer…" /></label>
          <label className="check-inline"><input type="checkbox" defaultChecked={!!sel.reportable_external} onChange={e => save({ reportableExternal: e.target.checked })} /> Reportable to an external authority</label>
          {!!sel.reportable_external && <label>External authority<input defaultValue={sel.external_authority || ''} onBlur={e => save({ externalAuthority: e.target.value })} /></label>}
          <label>Status<select value={sel.status} onChange={e => save({ status: e.target.value })}>{STATUSES.map(s => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}</select></label>
        </div>
      </>}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
        {!sel.nc_id && <button onClick={createNc}>Escalate to Nonconformity</button>}
        {sel.nc_number && <span className="badge badge--info">Linked NC: {sel.nc_number}</span>}
        <button className="secondary" onClick={() => act('review', 'Marked under investigation.')}>Mark reviewed</button>
        <button className="secondary" onClick={() => act('approve', 'Incident closed.')}>Approve &amp; close</button>
      </div>
    </div>}
  </div>;
}
