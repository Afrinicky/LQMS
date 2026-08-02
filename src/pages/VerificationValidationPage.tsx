import { FormEvent, useEffect, useRef, useState } from 'react';
import PageHeader from '../components/ui/PageHeader';
import { KpiStrip, ChartCard, DonutChart, ModuleAlerts } from '../components/ui';
import { useModules } from '../hooks/useModules';
import { api, API_BASE, getToken } from '../services/api';
import DisabledModule from '../components/DisabledModule';
import { downloadXlsx } from '../services/xlsx';
import type { Staff, Section, EquipmentItem } from '../../shared/types/api';
import { usePermissions } from '../hooks/usePermissions';

// ==========================================================================
// Method Verification & Validation — ISO 15189:2022 (§7.3.3) / CLSI EP series.
// A study characterises a method's analytical performance against defined
// acceptance criteria and authorises it (or not) for clinical use.
// ==========================================================================

type VParam = {
  id: number; parameter: string; parameter_label: string; acceptance_criteria: string | null; claimed_value: string | null;
  observed_value: string | null; statistic_label: string | null; statistic_value: string | null; unit: string | null;
  n_samples: number | null; outcome: string; notes: string | null; evidence_file_id: number | null; display_order: number;
};
type Study = {
  id: number; verification_number: string; study_type: string; measurand_type: string; verification_type: string;
  method_name: string; test_name: string; analyte: string | null; sample_matrix: string | null; measurement_units: string | null;
  manufacturer: string | null; reagent_lot: string | null; equipment_id: number | null; equipment_name: string | null;
  section_id: number | null; section_name: string | null; scope_reason: string | null; guideline_ref: string | null;
  manufacturer_claims_ref: string | null; reason: string | null; start_date: string | null; completion_date: string | null;
  acceptance_criteria: string | null; summary: string | null; conclusion: string | null; limitations: string | null;
  verdict: string; authorized_for_use: number; authorized_date: string | null; next_review_date: string | null;
  status: string; report_file_id: number | null; report_file_name: string | null;
  performed_by_name: string | null; reviewed_by_name: string | null; approved_by_name: string | null;
  performed_by_staff_id: number | null; reviewed_at: string | null; approved_at: string | null;
  parameters: VParam[];
};
type StudyRow = Study & { parameter_count: number; failed_count: number; pending_count: number };
type EquipVerif = { id: number; verification_number: string; equipment_name?: string; equipment_number?: string; verification_type: string; verification_date: string; conclusion?: string; status: string };

const STUDY_TYPES = [{ v: 'verification', l: 'Verification (validated / manufacturer method)' }, { v: 'validation', l: 'Validation (lab-developed / modified method)' }];
const MEASURANDS = [{ v: 'quantitative', l: 'Quantitative' }, { v: 'qualitative', l: 'Qualitative' }];
const SCOPE_REASONS = ['new_method', 'new_instrument', 'modified_method', 'new_reagent_lot_major', 'relocation', 'post_repair', 'periodic_review', 'troubleshooting'];
const GUIDELINES = ['ISO 15189:2022', 'CLSI EP15-A3 (precision & trueness)', 'CLSI EP05 (precision)', 'CLSI EP06 (linearity)', 'CLSI EP09 (method comparison)', 'CLSI EP17 (LoB/LoD/LoQ)', 'CLSI EP12 (qualitative)', 'CLSI EP28 (reference intervals)', 'Manufacturer IFU'];
const MATRICES = ['Serum', 'Plasma', 'Whole blood', 'Urine', 'CSF', 'Stool', 'Swab', 'Other'];
const OUTCOMES = [{ v: 'pending', l: 'Pending' }, { v: 'pass', l: 'Pass' }, { v: 'fail', l: 'Fail' }, { v: 'na', l: 'N/A' }];
const VERDICTS = [{ v: 'pending', l: 'Pending' }, { v: 'acceptable', l: 'Acceptable' }, { v: 'acceptable_with_limitations', l: 'Acceptable with limitations' }, { v: 'not_acceptable', l: 'Not acceptable' }];

const tabBar = (active: string, tabs: string[], onChange: (n: string) => void) =>
  <div className="tabs">{tabs.map(n => <button key={n} type="button" className={active === n ? 'active' : ''} onClick={() => onChange(n)}>{n}</button>)}</div>;
const badge = (s?: string) => <span className={`badge ${s ? s.toLowerCase().replace(/\s+/g, '-') : ''}`}>{(s || '—').replace(/_/g, ' ')}</span>;
const verdictBadge = (v: string) => {
  const tone = v === 'acceptable' ? 'approved' : v === 'not_acceptable' ? 'danger' : v === 'acceptable_with_limitations' ? 'warning' : '';
  return <span className={`badge ${tone}`}>{(VERDICTS.find(x => x.v === v)?.l || v)}</span>;
};
const outcomeChip = (o: string) => {
  const bg = o === 'pass' ? '#1a7f37' : o === 'fail' ? '#c1121f' : o === 'na' ? '#6b7280' : '#b8860b';
  return <span style={{ background: bg, color: '#fff', fontWeight: 700, fontSize: 10, padding: '2px 7px', borderRadius: 4 }}>{o.toUpperCase()}</span>;
};

async function openPrint(path: string, onError: (m: string) => void) {
  try {
    const token = getToken();
    const res = await fetch(`${API_BASE}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : undefined });
    if (!res.ok) throw new Error(await res.text() || res.statusText);
    const w = window.open('', '_blank'); if (!w) { onError('Allow pop-ups to open the report.'); return; }
    w.document.open(); w.document.write(await res.text()); w.document.close();
  } catch (e) { onError((e as Error).message); }
}

export function VerificationValidationPage({ embedded = false }: { embedded?: boolean } = {}) {
  const { can } = usePermissions();
  const { isEnabled } = useModules();
  const [staff, setStaff] = useState<Staff[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [equipment, setEquipment] = useState<EquipmentItem[]>([]);
  const [tab, setTab] = useState(embedded ? 'Register' : 'Dashboard');
  const [studies, setStudies] = useState<StudyRow[]>([]);
  const [equipVerifs, setEquipVerifs] = useState<EquipVerif[]>([]);
  const [selected, setSelected] = useState<Study | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const blankNew = { studyType: 'verification', measurandType: 'quantitative', testName: '', methodName: '', analyte: '', sampleMatrix: 'Serum', measurementUnits: '', manufacturer: '', reagentLot: '', equipmentId: '', sectionId: '', scopeReason: 'new_method', guidelineRef: 'CLSI EP15-A3 (precision & trueness)', manufacturerClaimsRef: '', startDate: new Date().toISOString().slice(0, 10), seedParameters: true };
  const [nf, setNf] = useState(blankNew);
  const [equipForm, setEquipForm] = useState({ equipmentId: '', verificationType: 'calibration_verification', verificationDate: '', reason: '', acceptanceCriteria: '', resultsSummary: '', conclusion: '', status: 'in_progress' });
  const [addParam, setAddParam] = useState('');
  const [catalogue, setCatalogue] = useState<Record<string, { label: string; stat: string; unit?: string }>>({});

  useEffect(() => {
    api<Staff[]>('/staff').then(setStaff).catch(() => setStaff([]));
    api<Section[]>('/sections').then(setSections).catch(() => setSections([]));
    api<EquipmentItem[]>('/equipment').then(l => setEquipment(l.filter(e => e.equipment_class !== 'support'))).catch(() => setEquipment([]));
    api<{ labels: Record<string, { label: string; stat: string; unit?: string }> }>('/verification-validation/parameter-catalogue').then(c => setCatalogue(c.labels)).catch(() => setCatalogue({}));
  }, []);
  async function load() {
    try {
      const [list, eq] = await Promise.all([api<StudyRow[]>('/verification-validation'), api<EquipVerif[]>('/verification-validation/equipment')]);
      setStudies(list); setEquipVerifs(eq);
    } catch (e) { setError((e as Error).message); }
  }
  useEffect(() => { if (embedded || isEnabled('verification_validation')) void load(); }, [isEnabled]);
  if (!embedded && !isEnabled('verification_validation')) return <DisabledModule />;

  async function openStudy(id: number) { setError(null); try { setSelected(await api<Study>(`/verification-validation/${id}`)); } catch (e) { setError((e as Error).message); } }
  async function refreshSelected() { if (selected) await openStudy(selected.id); await load(); }

  async function createStudy(e: FormEvent) {
    e.preventDefault(); setError(null); setMsg(null);
    if (!nf.testName || !nf.methodName) { setError('Test and method are required.'); return; }
    try { const r = await api<{ id: number }>('/verification-validation', { method: 'POST', body: JSON.stringify(nf) }); setNf(blankNew); await load(); await openStudy(r.id); setTab('Register'); setMsg('Study created with its standard performance characteristics — fill in the results below.'); }
    catch (e) { setError((e as Error).message); }
  }
  async function saveHeader(patch: Record<string, unknown>) { if (!selected) return; try { await api(`/verification-validation/${selected.id}`, { method: 'PUT', body: JSON.stringify(patch) }); await refreshSelected(); } catch (e) { setError((e as Error).message); } }
  async function saveParam(pid: number, patch: Record<string, unknown>) { try { await api(`/verification-validation/parameters/${pid}`, { method: 'PUT', body: JSON.stringify(patch) }); await refreshSelected(); } catch (e) { setError((e as Error).message); } }
  async function addParameter() {
    if (!selected || !addParam) return;
    const meta = catalogue[addParam];
    try { await api(`/verification-validation/${selected.id}/parameters`, { method: 'POST', body: JSON.stringify({ parameter: addParam, parameterLabel: meta?.label || addParam, statisticLabel: meta?.stat, unit: meta?.unit }) }); setAddParam(''); await refreshSelected(); } catch (e) { setError((e as Error).message); }
  }
  async function delParam(pid: number) { try { await api(`/verification-validation/parameters/${pid}`, { method: 'DELETE' }); await refreshSelected(); } catch (e) { setError((e as Error).message); } }
  async function seedStandard() { if (!selected) return; try { const r = await api<{ added: number }>(`/verification-validation/${selected.id}/seed-parameters`, { method: 'POST', body: JSON.stringify({}) }); setMsg(`${r.added} standard characteristic(s) added.`); await refreshSelected(); } catch (e) { setError((e as Error).message); } }
  async function review() { if (!selected) return; try { await api(`/verification-validation/${selected.id}/review`, { method: 'POST', body: JSON.stringify({}) }); setMsg('Marked as reviewed.'); await refreshSelected(); } catch (e) { setError((e as Error).message); } }
  async function authorize(authorizeForUse: boolean, reject = false) {
    if (!selected) return;
    try { const r = await api<{ verdict: string }>(`/verification-validation/${selected.id}/authorize`, { method: 'POST', body: JSON.stringify({ authorizeForUse, reject }) }); setMsg(reject ? 'Study rejected.' : `Authorised — verdict: ${r.verdict.replace(/_/g, ' ')}.`); await refreshSelected(); } catch (e) { setError((e as Error).message); }
  }
  async function removeStudy(id: number) { if (!confirm('Delete this study and its characteristics?')) return; try { await api(`/verification-validation/${id}`, { method: 'DELETE' }); if (selected?.id === id) setSelected(null); await load(); } catch (e) { setError((e as Error).message); } }
  const reportRef = useRef<HTMLInputElement>(null);
  async function uploadReport(file: File) {
    if (!selected) return; setError(null);
    try {
      const fd = new FormData(); fd.append('file', file);
      const token = getToken();
      const res = await fetch(`${API_BASE}/verification-validation/${selected.id}/report`, { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : undefined, body: fd });
      if (!res.ok) throw new Error((await res.json().catch(() => ({ error: res.statusText }))).error ?? res.statusText);
      setMsg('Report attached.'); await refreshSelected();
    } catch (e) { setError((e as Error).message); } finally { if (reportRef.current) reportRef.current.value = ''; }
  }
  async function submitEquip(e: FormEvent) {
    e.preventDefault(); setError(null);
    if (!equipForm.equipmentId) { setError('Select equipment.'); return; }
    try { await api('/verification-validation/equipment', { method: 'POST', body: JSON.stringify(equipForm) }); setEquipForm({ equipmentId: '', verificationType: 'calibration_verification', verificationDate: '', reason: '', acceptanceCriteria: '', resultsSummary: '', conclusion: '', status: 'in_progress' }); await load(); }
    catch (e) { setError((e as Error).message); }
  }
  async function approveEquip(id: number) { try { await api(`/verification-validation/equipment/${id}/approve`, { method: 'POST', body: JSON.stringify({}) }); await load(); } catch (e) { setError((e as Error).message); } }

  const canManage = selected && selected.status !== 'approved' && selected.status !== 'rejected';
  const summary = {
    total: studies.length,
    open: studies.filter(s => !['approved', 'rejected'].includes(s.status)).length,
    authorized: studies.filter(s => s.authorized_for_use).length,
    notAcceptable: studies.filter(s => s.verdict === 'not_acceptable').length,
  };
  const tabs = ['Dashboard', 'Register', 'New study', 'Equipment verification', 'Reports'].filter(n => !embedded || n !== 'Dashboard');

  return <div className="module-page">
    {!embedded && <PageHeader eyebrow="Process Management" title="Method Verification &amp; Validation" subtitle="ISO 15189 verification and validation of examination methods, with structured performance characteristics and authorisation for use." />}
    {tabBar(tab, tabs, setTab)}
    {error && <div className="error">{error}</div>}
    {msg && <div className="notice-ok">{msg}</div>}

    {tab === 'Dashboard' && <>
      <ModuleAlerts moduleKey="verification_validation" />
      <KpiStrip items={[
        { label: 'Studies', value: summary.total, onClick: () => setTab('Register') },
        { label: 'In progress', value: summary.open, tone: summary.open ? 'warning' : undefined, onClick: () => setTab('Register') },
        { label: 'Authorised for use', value: summary.authorized },
        { label: 'Not acceptable', value: summary.notAcceptable, tone: summary.notAcceptable ? 'danger' : undefined },
        { label: 'Equipment verifications', value: equipVerifs.length, onClick: () => setTab('Equipment verification') },
      ]} />
      <div className="grid cols-2" style={{ marginTop: 18 }}>
        <ChartCard title="Study verdicts" subtitle="Outcome of method studies">
          <DonutChart centerLabel="Studies" data={[
            { label: 'Acceptable', value: studies.filter(s => s.verdict === 'acceptable').length, color: '#1a7f37' },
            { label: 'With limitations', value: studies.filter(s => s.verdict === 'acceptable_with_limitations').length, color: '#b8860b' },
            { label: 'Not acceptable', value: studies.filter(s => s.verdict === 'not_acceptable').length, color: '#c1121f' },
            { label: 'Pending', value: studies.filter(s => s.verdict === 'pending').length, color: '#6b7280' },
          ]} />
        </ChartCard>
        <ChartCard title="Study types" subtitle="Verification vs validation">
          <DonutChart centerLabel="Type" data={[
            { label: 'Verification', value: studies.filter(s => s.study_type === 'verification').length, color: '#2f6bff' },
            { label: 'Validation', value: studies.filter(s => s.study_type === 'validation').length, color: '#7a2fd6' },
          ]} />
        </ChartCard>
      </div>
    </>}

    {tab === 'Register' && <>
      <div className="card">
        <div className="section-head" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
          <h3 style={{ margin: 0 }}>Verification &amp; validation studies</h3>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            {can('verification_validation', 'export') && <button type="button" className="secondary" onClick={() => downloadXlsx('/verification-validation/export', 'Method_Verification_Register.xlsx').catch(e => setError((e as Error).message))}>Export to Excel</button>}
            <button type="button" onClick={() => setTab('New study')}>+ New study</button>
          </div>
        </div>
        <table className="data-table"><thead><tr><th>Number</th><th>Test / method</th><th>Type</th><th>Characteristics</th><th>Verdict</th><th>For use</th><th>Status</th><th></th></tr></thead><tbody>
          {studies.map(s => <tr key={s.id}>
            <td>{s.verification_number}</td>
            <td>{s.test_name}<div className="muted" style={{ fontSize: 11 }}>{s.method_name}{s.analyte ? ` · ${s.analyte}` : ''}</div></td>
            <td>{badge(s.study_type)}</td>
            <td>{s.parameter_count}{s.failed_count ? <span className="badge danger">{s.failed_count} fail</span> : null}{s.pending_count ? <span className="badge warning">{s.pending_count} pending</span> : null}</td>
            <td>{verdictBadge(s.verdict)}</td>
            <td>{s.authorized_for_use ? <span className="badge approved">✓ authorised</span> : '—'}</td>
            <td>{badge(s.status)}</td>
            <td><button onClick={() => openStudy(s.id)}>Open</button> {can('verification_validation', 'print') && <button className="secondary" onClick={() => openPrint(`/verification-validation/${s.id}/print`, setError)}>Report</button>}</td>
          </tr>)}
          {studies.length === 0 && <tr><td colSpan={8} className="muted">No studies yet. Start one from <em>New study</em>.</td></tr>}
        </tbody></table>
      </div>
      {selected && <StudyWorkspace study={selected} staff={staff} sections={sections} equipment={equipment} catalogue={catalogue}
        canManage={!!canManage} addParam={addParam} setAddParam={setAddParam} onAddParam={addParameter} onSeed={seedStandard}
        onSaveHeader={saveHeader} onSaveParam={saveParam} onDelParam={delParam} onReview={review} onAuthorize={authorize}
        onDelete={() => removeStudy(selected.id)} onClose={() => setSelected(null)} onPrint={() => openPrint(`/verification-validation/${selected.id}/print`, setError)} onRefresh={refreshSelected}
        reportRef={reportRef} onUploadReport={uploadReport} setError={setError} />}
    </>}

    {tab === 'New study' && <div className="card">
      <h3>New verification / validation study</h3>
      <p className="muted" style={{ marginTop: 0 }}>Choose the study type and whether the measurand is quantitative or qualitative — the standard ISO/CLSI performance characteristics are added automatically, ready for you to enter results. <strong>Verification</strong> confirms a validated (e.g. manufacturer's) method performs as claimed here; <strong>validation</strong> fully characterises a lab-developed or modified method.</p>
      <form className="form-grid" onSubmit={createStudy}>
        <label>Study type<select value={nf.studyType} onChange={e => setNf({ ...nf, studyType: e.target.value })}>{STUDY_TYPES.map(t => <option key={t.v} value={t.v}>{t.l}</option>)}</select></label>
        <label>Measurand<select value={nf.measurandType} onChange={e => setNf({ ...nf, measurandType: e.target.value })}>{MEASURANDS.map(t => <option key={t.v} value={t.v}>{t.l}</option>)}</select></label>
        <label>Test<input value={nf.testName} onChange={e => setNf({ ...nf, testName: e.target.value })} required placeholder="e.g. Serum creatinine" /></label>
        <label>Method / assay<input value={nf.methodName} onChange={e => setNf({ ...nf, methodName: e.target.value })} required placeholder="e.g. Enzymatic, Cobas c311" /></label>
        <label>Analyte<input value={nf.analyte} onChange={e => setNf({ ...nf, analyte: e.target.value })} placeholder="e.g. Creatinine" /></label>
        <label>Sample matrix<select value={nf.sampleMatrix} onChange={e => setNf({ ...nf, sampleMatrix: e.target.value })}>{MATRICES.map(m => <option key={m} value={m}>{m}</option>)}</select></label>
        <label>Units<input value={nf.measurementUnits} onChange={e => setNf({ ...nf, measurementUnits: e.target.value })} placeholder="e.g. µmol/L" /></label>
        <label>Equipment<select value={nf.equipmentId} onChange={e => setNf({ ...nf, equipmentId: e.target.value })}><option value="">—</option>{equipment.map(eq => <option key={eq.id} value={eq.id}>{eq.name}</option>)}</select></label>
        <label>Unit / section<select value={nf.sectionId} onChange={e => setNf({ ...nf, sectionId: e.target.value })}><option value="">—</option>{sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label>Manufacturer<input value={nf.manufacturer} onChange={e => setNf({ ...nf, manufacturer: e.target.value })} /></label>
        <label>Reagent lot<input value={nf.reagentLot} onChange={e => setNf({ ...nf, reagentLot: e.target.value })} /></label>
        <label>Reason / scope<select value={nf.scopeReason} onChange={e => setNf({ ...nf, scopeReason: e.target.value })}>{SCOPE_REASONS.map(s => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}</select></label>
        <label>Guideline followed<select value={nf.guidelineRef} onChange={e => setNf({ ...nf, guidelineRef: e.target.value })}>{GUIDELINES.map(g => <option key={g} value={g}>{g}</option>)}</select></label>
        <label>Manufacturer claims ref.<input value={nf.manufacturerClaimsRef} onChange={e => setNf({ ...nf, manufacturerClaimsRef: e.target.value })} placeholder="IFU / insert reference" /></label>
        <label>Start date<input type="date" value={nf.startDate} onChange={e => setNf({ ...nf, startDate: e.target.value })} /></label>
        <label className="check-inline"><input type="checkbox" checked={nf.seedParameters} onChange={e => setNf({ ...nf, seedParameters: e.target.checked })} /> Add the standard performance characteristics automatically</label>
        <button type="submit">Create study</button>
      </form>
    </div>}

    {tab === 'Equipment verification' && <>
      <div className="card">
        <h3>Equipment verification (instrument performance)</h3>
        <p className="muted" style={{ marginTop: 0 }}>Verify an instrument performs to specification (calibration verification, performance checks). Method/assay studies are on the <em>Register</em>.</p>
        <form className="form-grid" onSubmit={submitEquip}>
          <label>Equipment<select value={equipForm.equipmentId} onChange={e => setEquipForm({ ...equipForm, equipmentId: e.target.value })} required><option value="">—</option>{equipment.map(eq => <option key={eq.id} value={eq.id}>{eq.name}</option>)}</select></label>
          <label>Verification type<input value={equipForm.verificationType} onChange={e => setEquipForm({ ...equipForm, verificationType: e.target.value })} required placeholder="e.g. calibration verification" /></label>
          <label>Date<input type="date" value={equipForm.verificationDate} onChange={e => setEquipForm({ ...equipForm, verificationDate: e.target.value })} required /></label>
          <label>Reason<input value={equipForm.reason} onChange={e => setEquipForm({ ...equipForm, reason: e.target.value })} /></label>
          <label>Acceptance criteria<textarea value={equipForm.acceptanceCriteria} onChange={e => setEquipForm({ ...equipForm, acceptanceCriteria: e.target.value })} /></label>
          <label>Results summary<textarea value={equipForm.resultsSummary} onChange={e => setEquipForm({ ...equipForm, resultsSummary: e.target.value })} /></label>
          <label>Conclusion<textarea value={equipForm.conclusion} onChange={e => setEquipForm({ ...equipForm, conclusion: e.target.value })} /></label>
          <button type="submit">Record equipment verification</button>
        </form>
      </div>
      <table className="data-table" style={{ marginTop: 16 }}><thead><tr><th>Number</th><th>Equipment</th><th>Type</th><th>Date</th><th>Status</th><th></th></tr></thead><tbody>
        {equipVerifs.map(ev => <tr key={ev.id}><td>{ev.verification_number}</td><td>{ev.equipment_name}</td><td>{(ev.verification_type || '').replace(/_/g, ' ')}</td><td>{ev.verification_date}</td><td>{badge(ev.status)}</td>
          <td>{ev.status !== 'approved' && <button onClick={() => approveEquip(ev.id)}>Approve</button>}</td></tr>)}
        {equipVerifs.length === 0 && <tr><td colSpan={6} className="muted">No equipment verifications yet.</td></tr>}
      </tbody></table>
    </>}

    {tab === 'Reports' && <>
      <KpiStrip items={[
        { label: 'Studies', value: summary.total },
        { label: 'Acceptable', value: studies.filter(s => s.verdict === 'acceptable').length },
        { label: 'With limitations', value: studies.filter(s => s.verdict === 'acceptable_with_limitations').length },
        { label: 'Not acceptable', value: summary.notAcceptable, tone: summary.notAcceptable ? 'danger' : undefined },
        { label: 'Authorised for use', value: summary.authorized },
      ]} />
      <div className="card" style={{ marginTop: 16 }}>
        <div className="section-head"><h3 style={{ margin: 0 }}>Verification &amp; validation register</h3>
          {can('verification_validation', 'export') && <button type="button" className="secondary" onClick={() => downloadXlsx('/verification-validation/export', 'Method_Verification_Register.xlsx').catch(e => setError((e as Error).message))}>Export to Excel</button>}</div>
        <table className="data-table"><thead><tr><th>Number</th><th>Test / method</th><th>Type</th><th>Guideline</th><th>Completed</th><th>Verdict</th><th>Status</th><th></th></tr></thead><tbody>
          {studies.map(s => <tr key={s.id}>
            <td>{s.verification_number}</td><td>{s.test_name}<div className="muted" style={{ fontSize: 11 }}>{s.method_name}</div></td>
            <td>{badge(s.study_type)}</td><td>{s.guideline_ref || '—'}</td><td>{s.completion_date || '—'}</td><td>{verdictBadge(s.verdict)}</td><td>{badge(s.status)}</td>
            <td>{can('verification_validation', 'print') && <button className="secondary" onClick={() => openPrint(`/verification-validation/${s.id}/print`, setError)}>Report</button>}</td>
          </tr>)}
          {studies.length === 0 && <tr><td colSpan={8} className="muted">No studies recorded.</td></tr>}
        </tbody></table>
      </div>
    </>}
  </div>;
}

// ---- Study detail workspace ----
function StudyWorkspace({ study, staff, sections, equipment, catalogue, canManage, addParam, setAddParam, onAddParam, onSeed, onSaveHeader, onSaveParam, onDelParam, onReview, onAuthorize, onDelete, onClose, onPrint, onRefresh, reportRef, onUploadReport, setError }: {
  study: Study; staff: Staff[]; sections: Section[]; equipment: EquipmentItem[]; catalogue: Record<string, { label: string; stat: string; unit?: string }>;
  canManage: boolean; addParam: string; setAddParam: (v: string) => void; onAddParam: () => void; onSeed: () => void;
  onSaveHeader: (p: Record<string, unknown>) => void; onSaveParam: (pid: number, p: Record<string, unknown>) => void; onDelParam: (pid: number) => void;
  onReview: () => void; onAuthorize: (a: boolean, reject?: boolean) => void; onDelete: () => void; onClose: () => void; onPrint: () => void; onRefresh: () => void;
  reportRef: React.RefObject<HTMLInputElement>; onUploadReport: (f: File) => void; setError: (m: string | null) => void;
}) {
  const { can } = usePermissions();
  const [showEdit, setShowEdit] = useState(false);
  const [dataFor, setDataFor] = useState<VParam | null>(null);
  const failed = study.parameters.filter(p => p.outcome === 'fail').length;
  const pending = study.parameters.filter(p => p.outcome === 'pending').length;
  const suggested = failed ? 'not_acceptable' : pending ? 'pending' : 'acceptable';

  return <div className="card" style={{ marginTop: 16, borderTop: '3px solid #2f6bff' }}>
    <div className="section-head" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
      <h3 style={{ margin: 0 }}>{study.verification_number} — {study.test_name} {verdictBadge(study.verdict)} {study.authorized_for_use ? <span className="badge approved">✓ authorised for use</span> : null}</h3>
      <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {can('verification_validation', 'print') && <button type="button" className="secondary" onClick={onPrint}>Print report</button>}
        {canManage && <button type="button" className="secondary" onClick={() => setShowEdit(v => !v)}>{showEdit ? 'Hide details' : 'Edit details'}</button>}
        {canManage && <button type="button" className="secondary" onClick={onDelete}>Delete</button>}
        <button type="button" className="secondary" onClick={onClose}>Close</button>
      </div>
    </div>
    <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
      {badge(study.study_type)} · {study.measurand_type} · {study.method_name}{study.analyte ? ` · ${study.analyte}` : ''}{study.sample_matrix ? ` · ${study.sample_matrix}` : ''}{study.measurement_units ? ` · ${study.measurement_units}` : ''}
      {study.equipment_name ? ` · ${study.equipment_name}` : ''}{study.guideline_ref ? ` · ${study.guideline_ref}` : ''} · {badge(study.status)}
    </div>

    {showEdit && canManage && <div className="form-grid" style={{ marginBottom: 14 }}>
      <label>Test<input defaultValue={study.test_name} onBlur={e => onSaveHeader({ testName: e.target.value })} /></label>
      <label>Method<input defaultValue={study.method_name} onBlur={e => onSaveHeader({ methodName: e.target.value })} /></label>
      <label>Analyte<input defaultValue={study.analyte || ''} onBlur={e => onSaveHeader({ analyte: e.target.value })} /></label>
      <label>Units<input defaultValue={study.measurement_units || ''} onBlur={e => onSaveHeader({ measurementUnits: e.target.value })} /></label>
      <label>Manufacturer<input defaultValue={study.manufacturer || ''} onBlur={e => onSaveHeader({ manufacturer: e.target.value })} /></label>
      <label>Reagent lot<input defaultValue={study.reagent_lot || ''} onBlur={e => onSaveHeader({ reagentLot: e.target.value })} /></label>
      <label>Equipment<select defaultValue={study.equipment_id ? String(study.equipment_id) : ''} onChange={e => onSaveHeader({ equipmentId: e.target.value })}><option value="">—</option>{equipment.map(eq => <option key={eq.id} value={eq.id}>{eq.name}</option>)}</select></label>
      <label>Section<select defaultValue={study.section_id ? String(study.section_id) : ''} onChange={e => onSaveHeader({ sectionId: e.target.value })}><option value="">—</option>{sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
      <label>Guideline<input defaultValue={study.guideline_ref || ''} onBlur={e => onSaveHeader({ guidelineRef: e.target.value })} /></label>
      <label>Performed by<select defaultValue={study.performed_by_staff_id ? String(study.performed_by_staff_id) : ''} onChange={e => onSaveHeader({ performedByStaffId: e.target.value })}><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
      <label>Completion date<input type="date" defaultValue={study.completion_date || ''} onBlur={e => onSaveHeader({ completionDate: e.target.value })} /></label>
      <label>Next review<input type="date" defaultValue={study.next_review_date || ''} onBlur={e => onSaveHeader({ nextReviewDate: e.target.value })} /></label>
    </div>}

    <h4 style={{ marginBottom: 4 }}>Performance characteristics assessed</h4>
    <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>Enter the acceptance criterion, the observed result and mark each characteristic pass/fail. The overall verdict follows the outcomes.</p>
    <div style={{ overflowX: 'auto' }}>
      <table className="data-table" style={{ minWidth: 900 }}><thead><tr>
        <th style={{ minWidth: 190 }}>Characteristic</th><th>Acceptance criterion</th><th>Claimed</th><th>Observed / statistic</th><th>n</th><th>Outcome</th><th>Notes</th>{canManage && <th></th>}
      </tr></thead><tbody>
        {study.parameters.map(p => <tr key={p.id}>
          <td><strong>{p.parameter_label}</strong>{p.statistic_label ? <div className="muted" style={{ fontSize: 10 }}>{p.statistic_label}{p.unit ? ` (${p.unit})` : ''}</div> : null}</td>
          <td>{canManage ? <input defaultValue={p.acceptance_criteria || ''} style={{ width: 130 }} onBlur={e => onSaveParam(p.id, { acceptanceCriteria: e.target.value })} /> : (p.acceptance_criteria || '—')}</td>
          <td>{canManage ? <input defaultValue={p.claimed_value || ''} style={{ width: 80 }} onBlur={e => onSaveParam(p.id, { claimedValue: e.target.value })} /> : (p.claimed_value || '—')}</td>
          <td>{canManage ? <input defaultValue={p.observed_value || ''} style={{ width: 110 }} placeholder={p.statistic_label || ''} onBlur={e => onSaveParam(p.id, { observedValue: e.target.value })} /> : (p.observed_value || '—')}</td>
          <td>{canManage ? <input defaultValue={p.n_samples ?? ''} type="number" style={{ width: 52 }} onBlur={e => onSaveParam(p.id, { nSamples: e.target.value })} /> : (p.n_samples ?? '—')}</td>
          <td>{canManage ? <select defaultValue={p.outcome} onChange={e => onSaveParam(p.id, { outcome: e.target.value })}>{OUTCOMES.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}</select> : outcomeChip(p.outcome)}</td>
          <td>{canManage ? <input defaultValue={p.notes || ''} style={{ width: 140 }} onBlur={e => onSaveParam(p.id, { notes: e.target.value })} /> : (p.notes || '—')}</td>
          {canManage && <td style={{ whiteSpace: 'nowrap' }}><button type="button" className="secondary" onClick={() => setDataFor(p)}>Data</button> <button type="button" className="secondary" onClick={() => onDelParam(p.id)}>×</button></td>}
        </tr>)}
        {study.parameters.length === 0 && <tr><td colSpan={canManage ? 8 : 7} className="muted">No characteristics yet — add the standard set below.</td></tr>}
      </tbody></table>
    </div>
    {dataFor && <ParamDataEditor param={dataFor} onClose={() => setDataFor(null)} onComputed={onRefresh} setError={setError} />}
    {canManage && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 8 }}>
      <select value={addParam} onChange={e => setAddParam(e.target.value)}><option value="">Add a characteristic…</option>{Object.entries(catalogue).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>
      <button type="button" onClick={onAddParam} disabled={!addParam}>+ Add</button>
      <button type="button" className="secondary" onClick={onSeed}>Add standard set for this study type</button>
    </div>}

    <div className="grid cols-2" style={{ marginTop: 16 }}>
      <div>
        <h4 style={{ marginBottom: 4 }}>Overall assessment</h4>
        <label className="stack">Overall acceptance criteria<textarea defaultValue={study.acceptance_criteria || ''} disabled={!canManage} onBlur={e => onSaveHeader({ acceptanceCriteria: e.target.value })} /></label>
        <label className="stack">Summary of findings<textarea defaultValue={study.summary || ''} disabled={!canManage} onBlur={e => onSaveHeader({ summary: e.target.value })} /></label>
        <label className="stack">Conclusion<textarea defaultValue={study.conclusion || ''} disabled={!canManage} onBlur={e => onSaveHeader({ conclusion: e.target.value })} /></label>
        <label className="stack">Limitations<textarea defaultValue={study.limitations || ''} disabled={!canManage} onBlur={e => onSaveHeader({ limitations: e.target.value })} /></label>
      </div>
      <div>
        <h4 style={{ marginBottom: 4 }}>Report &amp; sign-off</h4>
        <div className="card" style={{ background: 'var(--panel-2, #f6f8fc)' }}>
          <p style={{ margin: '0 0 8px' }}><strong>Report file:</strong> {study.report_file_name ? study.report_file_name : <span className="muted">none attached</span>}</p>
          {canManage && <>
            <input ref={reportRef} type="file" accept="image/*,application/pdf,.doc,.docx,.xlsx" style={{ display: 'none' }} onChange={e => { const f = e.target.files?.[0]; if (f) onUploadReport(f); }} />
            <button type="button" className="secondary" onClick={() => reportRef.current?.click()}>{study.report_file_id ? 'Replace report' : 'Insert verification/validation report'}</button>
          </>}
          <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>Attach the full written verification/validation report (PDF/Word/scan). The one-page summary prints from <em>Print report</em>.</p>
        </div>
        <div style={{ marginTop: 10 }}>
          <p style={{ margin: '2px 0' }}>Performed by: <strong>{study.performed_by_name || '—'}</strong></p>
          <p style={{ margin: '2px 0' }}>Reviewed by: <strong>{study.reviewed_by_name || '—'}</strong>{study.reviewed_at ? ` · ${study.reviewed_at.slice(0, 10)}` : ''}</p>
          <p style={{ margin: '2px 0' }}>Authorised by: <strong>{study.approved_by_name || '—'}</strong>{study.approved_at ? ` · ${study.approved_at.slice(0, 10)}` : ''}</p>
        </div>
        {canManage && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
          <button type="button" className="secondary" onClick={onReview}>Mark reviewed</button>
          <button type="button" onClick={() => onAuthorize(true)} title={`Suggested verdict: ${suggested.replace(/_/g, ' ')}`}>Authorise for use</button>
          <button type="button" className="secondary" onClick={() => onAuthorize(false)}>Approve without authorising</button>
          <button type="button" className="secondary" onClick={() => onAuthorize(false, true)}>Reject</button>
        </div>}
        {failed > 0 && <p className="muted" style={{ color: '#c1121f', fontSize: 12, marginTop: 8 }}>{failed} characteristic(s) failed — authorising will record a <strong>not acceptable</strong> verdict and raise a nonconformity.</p>}
      </div>
    </div>
  </div>;
}

// ---- Raw-data workbench for a single performance characteristic ----
type DP = { sampleLabel: string; valueA: string; valueB: string };
function ParamDataEditor({ param, onClose, onComputed, setError }: { param: VParam; onClose: () => void; onComputed: () => void; setError: (m: string | null) => void }) {
  const paired = param.parameter === 'method_comparison' || param.parameter === 'linearity';
  const bLabel = param.parameter === 'method_comparison' ? 'Comparator (B)' : param.parameter === 'linearity' ? 'Assigned (B)' : 'Value B';
  const aLabel = param.parameter === 'method_comparison' ? 'Test method (A)' : param.parameter === 'linearity' ? 'Measured (A)' : 'Value';
  const [rows, setRows] = useState<DP[]>([]);
  const [computed, setComputed] = useState<string>('');
  useEffect(() => {
    api<Array<{ sample_label: string | null; value_a: number | null; value_b: number | null }>>(`/verification-validation/parameters/${param.id}/datapoints`)
      .then(dp => setRows(dp.length ? dp.map(d => ({ sampleLabel: d.sample_label || '', valueA: d.value_a == null ? '' : String(d.value_a), valueB: d.value_b == null ? '' : String(d.value_b) })) : Array.from({ length: 5 }, () => ({ sampleLabel: '', valueA: '', valueB: '' }))))
      .catch(() => setRows(Array.from({ length: 5 }, () => ({ sampleLabel: '', valueA: '', valueB: '' }))));
  }, [param.id]);
  function setCell(i: number, k: keyof DP, v: string) { setRows(r => r.map((row, idx) => idx === i ? { ...row, [k]: v } : row)); }
  async function saveCompute() {
    setError(null);
    try {
      await api(`/verification-validation/parameters/${param.id}/datapoints`, { method: 'POST', body: JSON.stringify({ points: rows }) });
      const r = await api<{ observed: string }>(`/verification-validation/parameters/${param.id}/compute`, { method: 'POST', body: JSON.stringify({}) });
      setComputed(r.observed || 'No result — check your data.');
      onComputed();
    } catch (e) { setError((e as Error).message); }
  }
  const help = param.parameter === 'method_comparison' ? 'Enter paired results: your test method (A) against the comparator/reference (B). Slope, intercept and Pearson r are computed by least squares.'
    : param.parameter === 'linearity' ? 'Enter measured (A) against assigned/expected (B) values across the range. r² and slope are computed.'
    : /^precision|reproducibility/.test(param.parameter) ? 'Enter the replicate results. Mean, SD and CV% are computed.'
    : /trueness|bias|interference/.test(param.parameter) ? 'Enter the replicate results; set a claimed/target value on the row to compute bias%.'
    : 'Enter the values; mean and SD are computed.';
  return <div className="card" style={{ marginTop: 12, background: 'var(--panel-2, #f6f8fc)' }}>
    <div className="section-head" style={{ alignItems: 'center' }}><h4 style={{ margin: 0 }}>Raw data — {param.parameter_label}</h4><button className="secondary" style={{ marginLeft: 'auto' }} onClick={onClose}>Close</button></div>
    <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>{help}</p>
    <table className="data-table" style={{ maxWidth: 520 }}><thead><tr><th>Sample</th><th>{aLabel}</th>{paired && <th>{bLabel}</th>}</tr></thead><tbody>
      {rows.map((row, i) => <tr key={i}>
        <td><input value={row.sampleLabel} onChange={e => setCell(i, 'sampleLabel', e.target.value)} style={{ width: 120 }} placeholder={`#${i + 1}`} /></td>
        <td><input type="number" step="any" value={row.valueA} onChange={e => setCell(i, 'valueA', e.target.value)} style={{ width: 110 }} /></td>
        {paired && <td><input type="number" step="any" value={row.valueB} onChange={e => setCell(i, 'valueB', e.target.value)} style={{ width: 110 }} /></td>}
      </tr>)}
    </tbody></table>
    <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
      <button type="button" className="secondary" onClick={() => setRows(r => [...r, { sampleLabel: '', valueA: '', valueB: '' }])}>+ Add row</button>
      <button type="button" onClick={saveCompute}>Save &amp; compute</button>
    </div>
    {computed && <div className="notice-ok" style={{ marginTop: 8 }}>Computed: <strong>{computed}</strong> — written to the characteristic's observed value.</div>}
  </div>;
}
