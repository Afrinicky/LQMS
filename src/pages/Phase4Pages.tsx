import { FormEvent, useEffect, useState } from 'react';
import PageHeader from '../components/ui/PageHeader';
import { useModules } from '../hooks/useModules';
import { api } from '../services/api';
import DisabledModule from '../components/DisabledModule';
import type {
  Location, Section, Staff, EquipmentItem,
  IqcMaterial, IqcResult, IqcLotChange,
  EqaProgram, EqaEvent, EqaResultRow,
  MethodVerification, VerificationExperiment, EquipmentVerification,
  MeasurementUncertaintyRecord,
  IqcSummary, EqaSummary, VerificationSummary, MeasurementUncertaintySummary,
  LeveyJenningsData, EquipmentVerificationDetail
} from '../../shared/types/api';

const statusBadgeClass = (status?: string) => `badge ${status ? status.toLowerCase().replace(/\s+/g, '-') : 'unknown'}`;
const formatBadge = (status?: string) => <span className={statusBadgeClass(status)}>{status ? status.replace(/_/g, ' ') : 'Unknown'}</span>;
const tabBar = (active: string, tabs: string[], onChange: (name: string) => void) =>
  <div className="tabs">{tabs.map(name => <button key={name} type="button" className={active === name ? 'active' : ''} onClick={() => onChange(name)}>{name}</button>)}</div>;

function useLookups() {
  const [staff, setStaff] = useState<Staff[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [equipment, setEquipment] = useState<EquipmentItem[]>([]);
  useEffect(() => {
    api<Staff[]>('/staff').then(setStaff).catch(() => setStaff([]));
    api<Section[]>('/sections').then(setSections).catch(() => setSections([]));
    api<Location[]>('/locations').then(setLocations).catch(() => setLocations([]));
    api<EquipmentItem[]>('/equipment').then(setEquipment).catch(() => setEquipment([]));
  }, []);
  return { staff, sections, locations, equipment };
}

function staffName(staffList: Staff[], id?: number | null) {
  if (!id) return '—';
  return staffList.find(s => s.id === id)?.fullName || `Staff #${id}`;
}

function LeveyJenningsChart({ data }: { data: LeveyJenningsData }) {
  const { points, targetMean, targetSd } = data;
  if (!points.length) return <p>No results to chart yet.</p>;
  const w = 720, h = 280, padL = 48, padR = 16, padT = 16, padB = 28;
  const innerW = w - padL - padR, innerH = h - padT - padB;
  const mean = targetMean ?? 0;
  const sd = targetSd ?? 0;
  const hasStats = targetMean !== null && targetMean !== undefined && targetSd !== null && targetSd !== undefined && targetSd > 0;
  // Y-axis spans mean ± 4 SD when stats available; otherwise data range with 10% padding
  let yMin: number, yMax: number;
  if (hasStats) { yMin = mean - 4 * sd; yMax = mean + 4 * sd; }
  else {
    const values = points.map(p => p.result_value);
    const lo = Math.min(...values), hi = Math.max(...values);
    const span = (hi - lo) || 1;
    yMin = lo - span * 0.1; yMax = hi + span * 0.1;
  }
  const x = (i: number) => padL + (points.length === 1 ? innerW / 2 : (i * innerW) / (points.length - 1));
  const y = (v: number) => padT + innerH - ((v - yMin) / (yMax - yMin)) * innerH;
  const colorFor = (status: string) => status === 'accepted' ? 'var(--success)' : status === 'warning' ? 'var(--warning)' : 'var(--danger)';
  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(p.result_value).toFixed(1)}`).join(' ');
  const refLine = (val: number, label: string, dashed: boolean) => <g key={label}>
    <line x1={padL} x2={w - padR} y1={y(val)} y2={y(val)} stroke="var(--border)" strokeWidth={1} strokeDasharray={dashed ? '4 4' : undefined} />
    <text x={padL - 6} y={y(val) + 4} fontSize={10} textAnchor="end" fill="var(--muted)">{label}</text>
  </g>;
  return <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label="Levey-Jennings chart" style={{ width: '100%', maxWidth: w, height: 'auto', background: '#fff', border: '1px solid var(--border)', borderRadius: 12 }}>
    {hasStats && <>
      {refLine(mean + 3 * sd, '+3 SD', true)}
      {refLine(mean + 2 * sd, '+2 SD', true)}
      {refLine(mean + sd, '+1 SD', true)}
      {refLine(mean, 'Mean', false)}
      {refLine(mean - sd, '-1 SD', true)}
      {refLine(mean - 2 * sd, '-2 SD', true)}
      {refLine(mean - 3 * sd, '-3 SD', true)}
    </>}
    {!hasStats && refLine((yMin + yMax) / 2, 'mid', false)}
    <path d={linePath} fill="none" stroke="var(--navy)" strokeWidth={1.5} />
    {points.map((p, i) => <circle key={i} cx={x(i)} cy={y(p.result_value)} r={4} fill={colorFor(p.status)} stroke="#fff" strokeWidth={1}>
      <title>{p.run_date}{p.run_time ? ' ' + p.run_time : ''} – {p.result_value}{p.z_score === null || p.z_score === undefined ? '' : ` (z=${p.z_score.toFixed(2)})`} – ${p.status}${p.rule_violation ? ' / ' + p.rule_violation : ''}</title>
    </circle>)}
    <text x={padL} y={h - 8} fontSize={10} fill="var(--muted)">{points[0].run_date}</text>
    <text x={w - padR} y={h - 8} fontSize={10} textAnchor="end" fill="var(--muted)">{points[points.length - 1].run_date}</text>
  </svg>;
}

// ============= IQC =============
export function IqcPage() {
  const { isEnabled } = useModules();
  const { staff, sections, equipment } = useLookups();
  const [tab, setTab] = useState('Dashboard');
  const [materials, setMaterials] = useState<IqcMaterial[]>([]);
  const [results, setResults] = useState<IqcResult[]>([]);
  const [lotChanges, setLotChanges] = useState<IqcLotChange[]>([]);
  const [summary, setSummary] = useState<IqcSummary | null>(null);
  const [lj, setLj] = useState<LeveyJenningsData | null>(null);
  const [ljMaterialId, setLjMaterialId] = useState<string>('');
  const [materialForm, setMaterialForm] = useState({ materialName: '', testName: '', analyte: '', lotNumber: '', manufacturer: '', expiryDate: '', storageCondition: '', sectionId: '', targetMean: '', targetSd: '', acceptableLow: '', acceptableHigh: '', equipmentId: '', isActive: true });
  const [resultForm, setResultForm] = useState({ iqcMaterialId: '', runDate: '', runTime: '', resultValue: '', equipmentId: '', comment: '', immediateAction: '' });
  const [lotForm, setLotForm] = useState({ oldIqcMaterialId: '', newIqcMaterialId: '', changeDate: '', reason: '', verificationSummary: '' });
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const [mats, ress, lots, sum] = await Promise.all([
        api<IqcMaterial[]>('/iqc/materials'),
        api<IqcResult[]>('/iqc/results'),
        api<IqcLotChange[]>('/iqc/lot-changes'),
        api<IqcSummary>('/dashboard/iqc-summary').catch(() => null)
      ]);
      setMaterials(mats); setResults(ress); setLotChanges(lots);
      if (sum) setSummary(sum);
    } catch (e) { setError((e as Error).message); }
  }
  useEffect(() => { if (isEnabled('iqc')) void load(); }, [isEnabled]);
  if (!isEnabled('iqc')) return <DisabledModule />;

  async function loadLj(id: string) {
    if (!id) { setLj(null); return; }
    try { setLj(await api<LeveyJenningsData>(`/iqc/materials/${id}/levey-jennings`)); }
    catch (e) { setError((e as Error).message); }
  }

  async function submitMaterial(e: FormEvent) {
    e.preventDefault(); setError(null);
    try {
      await api('/iqc/materials', { method: 'POST', body: JSON.stringify(materialForm) });
      setMaterialForm({ materialName: '', testName: '', analyte: '', lotNumber: '', manufacturer: '', expiryDate: '', storageCondition: '', sectionId: '', targetMean: '', targetSd: '', acceptableLow: '', acceptableHigh: '', equipmentId: '', isActive: true });
      await load(); setTab('IQC Materials');
    } catch (e) { setError((e as Error).message); }
  }

  async function submitResult(e: FormEvent) {
    e.preventDefault(); setError(null);
    if (!resultForm.iqcMaterialId) return setError('Select an IQC material');
    try {
      await api(`/iqc/materials/${resultForm.iqcMaterialId}/results`, { method: 'POST', body: JSON.stringify(resultForm) });
      setResultForm({ iqcMaterialId: '', runDate: '', runTime: '', resultValue: '', equipmentId: '', comment: '', immediateAction: '' });
      await load(); setTab('QC Failures');
    } catch (e) { setError((e as Error).message); }
  }

  async function submitLotChange(e: FormEvent) {
    e.preventDefault(); setError(null);
    try {
      await api('/iqc/lot-change', { method: 'POST', body: JSON.stringify(lotForm) });
      setLotForm({ oldIqcMaterialId: '', newIqcMaterialId: '', changeDate: '', reason: '', verificationSummary: '' });
      await load();
    } catch (e) { setError((e as Error).message); }
  }

  async function reviewResult(id: number) {
    try { await api(`/iqc/results/${id}/review`, { method: 'POST', body: JSON.stringify({}) }); await load(); }
    catch (e) { setError((e as Error).message); }
  }
  async function createNc(id: number) {
    try { await api(`/iqc/results/${id}/create-nc`, { method: 'POST', body: JSON.stringify({}) }); await load(); }
    catch (e) { setError((e as Error).message); }
  }
  async function createCapa(id: number) {
    try { await api(`/iqc/results/${id}/create-capa`, { method: 'POST', body: JSON.stringify({}) }); await load(); }
    catch (e) { setError((e as Error).message); }
  }

  const tabs = ['Dashboard', 'IQC Materials', 'New Material', 'Result Entry', 'QC Failures', 'Levey-Jennings', 'Lot Changes', 'Reports'];
  const failures = results.filter(r => r.status !== 'accepted');

  return <div className="module-page">
    <PageHeader eyebrow="Process control" title="IQC Management" subtitle="Internal quality control materials, results, and review." />
    {tabBar(tab, tabs, setTab)}
    {error && <div className="error">{error}</div>}

    {tab === 'Dashboard' && summary && <div className="cards">
      <div className="card"><h4>Active materials</h4><p className="metric">{summary.activeMaterials}</p></div>
      <div className="card"><h4>Results this month</h4><p className="metric">{summary.resultsThisMonth}</p></div>
      <div className="card"><h4>Failed/out-of-control this month</h4><p className="metric">{summary.failedThisMonth}</p></div>
      <div className="card"><h4>Pending review</h4><p className="metric">{summary.resultsPendingReview}</p></div>
      <div className="card"><h4>Lot changes this year</h4><p className="metric">{summary.lotChangesThisYear}</p></div>
    </div>}

    {tab === 'IQC Materials' && <table className="data-table"><thead><tr><th>Code</th><th>Name</th><th>Test</th><th>Analyte</th><th>Lot</th><th>Expiry</th><th>Status</th></tr></thead><tbody>
      {materials.map(m => <tr key={m.id}><td>{m.material_code}</td><td>{m.material_name}</td><td>{m.test_name}</td><td>{m.analyte}</td><td>{m.lot_number}</td><td>{m.expiry_date || '—'}</td><td>{m.is_active ? 'Active' : 'Inactive'}</td></tr>)}
    </tbody></table>}

    {tab === 'New Material' && <form className="form-grid" onSubmit={submitMaterial}>
      <label>Material name<input value={materialForm.materialName} onChange={e => setMaterialForm({ ...materialForm, materialName: e.target.value })} required /></label>
      <label>Test name<input value={materialForm.testName} onChange={e => setMaterialForm({ ...materialForm, testName: e.target.value })} required /></label>
      <label>Analyte<input value={materialForm.analyte} onChange={e => setMaterialForm({ ...materialForm, analyte: e.target.value })} required /></label>
      <label>Lot number<input value={materialForm.lotNumber} onChange={e => setMaterialForm({ ...materialForm, lotNumber: e.target.value })} required /></label>
      <label>Manufacturer<input value={materialForm.manufacturer} onChange={e => setMaterialForm({ ...materialForm, manufacturer: e.target.value })} /></label>
      <label>Expiry date<input type="date" value={materialForm.expiryDate} onChange={e => setMaterialForm({ ...materialForm, expiryDate: e.target.value })} /></label>
      <label>Storage condition<input value={materialForm.storageCondition} onChange={e => setMaterialForm({ ...materialForm, storageCondition: e.target.value })} /></label>
      <label>Section<select value={materialForm.sectionId} onChange={e => setMaterialForm({ ...materialForm, sectionId: e.target.value })}><option value="">—</option>{sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
      <label>Equipment<select value={materialForm.equipmentId} onChange={e => setMaterialForm({ ...materialForm, equipmentId: e.target.value })}><option value="">—</option>{equipment.map(eq => <option key={eq.id} value={eq.id}>{eq.name}</option>)}</select></label>
      <label>Target mean<input type="number" step="any" value={materialForm.targetMean} onChange={e => setMaterialForm({ ...materialForm, targetMean: e.target.value })} /></label>
      <label>Target SD<input type="number" step="any" value={materialForm.targetSd} onChange={e => setMaterialForm({ ...materialForm, targetSd: e.target.value })} /></label>
      <label>Acceptable low<input type="number" step="any" value={materialForm.acceptableLow} onChange={e => setMaterialForm({ ...materialForm, acceptableLow: e.target.value })} /></label>
      <label>Acceptable high<input type="number" step="any" value={materialForm.acceptableHigh} onChange={e => setMaterialForm({ ...materialForm, acceptableHigh: e.target.value })} /></label>
      <button type="submit">Create IQC material</button>
    </form>}

    {tab === 'Result Entry' && <form className="form-grid" onSubmit={submitResult}>
      <label>IQC material<select value={resultForm.iqcMaterialId} onChange={e => setResultForm({ ...resultForm, iqcMaterialId: e.target.value })} required><option value="">—</option>{materials.filter(m => m.is_active).map(m => <option key={m.id} value={m.id}>{m.material_name} / {m.lot_number}</option>)}</select></label>
      <label>Run date<input type="date" value={resultForm.runDate} onChange={e => setResultForm({ ...resultForm, runDate: e.target.value })} required /></label>
      <label>Run time<input type="time" value={resultForm.runTime} onChange={e => setResultForm({ ...resultForm, runTime: e.target.value })} /></label>
      <label>Result value<input type="number" step="any" value={resultForm.resultValue} onChange={e => setResultForm({ ...resultForm, resultValue: e.target.value })} required /></label>
      <label>Equipment<select value={resultForm.equipmentId} onChange={e => setResultForm({ ...resultForm, equipmentId: e.target.value })}><option value="">—</option>{equipment.map(eq => <option key={eq.id} value={eq.id}>{eq.name}</option>)}</select></label>
      <label>Comment<textarea value={resultForm.comment} onChange={e => setResultForm({ ...resultForm, comment: e.target.value })} /></label>
      <label>Immediate action<textarea value={resultForm.immediateAction} onChange={e => setResultForm({ ...resultForm, immediateAction: e.target.value })} /></label>
      <button type="submit">Submit result</button>
    </form>}

    {tab === 'QC Failures' && <table className="data-table"><thead><tr><th>Date</th><th>Material</th><th>Value</th><th>Status</th><th>Rule</th><th>Reviewed</th><th>Actions</th></tr></thead><tbody>
      {failures.map(r => <tr key={r.id}>
        <td>{r.run_date}</td><td>{r.material_name} / {r.lot_number}</td><td>{r.result_value}</td>
        <td>{formatBadge(r.status)}</td><td>{r.rule_violation || '—'}</td>
        <td>{r.reviewed_at ? staffName(staff, r.reviewed_by_staff_id) : 'Pending'}</td>
        <td>
          {!r.reviewed_at && <button onClick={() => reviewResult(r.id)}>Review</button>}
          {!r.nc_id && <button onClick={() => createNc(r.id)}>Create NC</button>}
          {!r.capa_id && <button onClick={() => createCapa(r.id)}>Create CAPA</button>}
        </td>
      </tr>)}
    </tbody></table>}

    {tab === 'Levey-Jennings' && <>
      <label>Material<select value={ljMaterialId} onChange={e => { setLjMaterialId(e.target.value); void loadLj(e.target.value); }}><option value="">—</option>{materials.map(m => <option key={m.id} value={m.id}>{m.material_name} / {m.lot_number}</option>)}</select></label>
      {lj && <>
        <p>Mean: {lj.targetMean ?? '—'} | SD: {lj.targetSd ?? '—'} | points: {lj.points.length}</p>
        <LeveyJenningsChart data={lj} />
        <table className="data-table"><thead><tr><th>Date</th><th>Time</th><th>Value</th><th>z</th><th>Status</th><th>Rule</th></tr></thead><tbody>
          {lj.points.map((p, i) => <tr key={i}><td>{p.run_date}</td><td>{p.run_time || '—'}</td><td>{p.result_value}</td><td>{p.z_score === null || p.z_score === undefined ? '—' : p.z_score.toFixed(2)}</td><td>{formatBadge(p.status)}</td><td>{p.rule_violation || '—'}</td></tr>)}
        </tbody></table>
      </>}
      {!lj && ljMaterialId && <p>Loading…</p>}
      {!ljMaterialId && <p>Select an IQC material to load its recent results.</p>}
    </>}

    {tab === 'Lot Changes' && <>
      <form className="form-grid" onSubmit={submitLotChange}>
        <label>Old material<select value={lotForm.oldIqcMaterialId} onChange={e => setLotForm({ ...lotForm, oldIqcMaterialId: e.target.value })}><option value="">—</option>{materials.map(m => <option key={m.id} value={m.id}>{m.material_name} / {m.lot_number}</option>)}</select></label>
        <label>New material<select value={lotForm.newIqcMaterialId} onChange={e => setLotForm({ ...lotForm, newIqcMaterialId: e.target.value })}><option value="">—</option>{materials.map(m => <option key={m.id} value={m.id}>{m.material_name} / {m.lot_number}</option>)}</select></label>
        <label>Change date<input type="date" value={lotForm.changeDate} onChange={e => setLotForm({ ...lotForm, changeDate: e.target.value })} required /></label>
        <label>Reason<input value={lotForm.reason} onChange={e => setLotForm({ ...lotForm, reason: e.target.value })} /></label>
        <label>Verification summary<textarea value={lotForm.verificationSummary} onChange={e => setLotForm({ ...lotForm, verificationSummary: e.target.value })} /></label>
        <button type="submit">Record lot change</button>
      </form>
      <table className="data-table"><thead><tr><th>Date</th><th>Old lot</th><th>New lot</th><th>Reason</th></tr></thead><tbody>
        {lotChanges.map(lc => <tr key={lc.id}><td>{lc.change_date}</td><td>{lc.old_material_name} / {lc.old_lot_number}</td><td>{lc.new_material_name} / {lc.new_lot_number}</td><td>{lc.reason || '—'}</td></tr>)}
      </tbody></table>
    </>}

    {tab === 'Reports' && <p>Reports view will surface IQC trends and Levey-Jennings style summaries in a later phase.</p>}
  </div>;
}

// ============= EQA =============
export function EqaPage() {
  const { isEnabled } = useModules();
  const { staff, sections } = useLookups();
  const [tab, setTab] = useState('Dashboard');
  const [programs, setPrograms] = useState<EqaProgram[]>([]);
  const [events, setEvents] = useState<EqaEvent[]>([]);
  const [summary, setSummary] = useState<EqaSummary | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<(EqaEvent & { results?: EqaResultRow[] }) | null>(null);
  const [programForm, setProgramForm] = useState({ programName: '', provider: '', testArea: '', sectionId: '', frequency: '', contact: '', isActive: true });
  const [eventForm, setEventForm] = useState({ eqaProgramId: '', cycleName: '', receivedDate: '', submissionDueDate: '', submittedDate: '', resultReceivedDate: '', performanceStatus: '', score: '', findings: '', responsibleStaffId: '' });
  const [resultForm, setResultForm] = useState({ analyteOrTest: '', reportedResult: '', expectedResult: '', performance: '', comment: '' });
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const [progs, evs, sum] = await Promise.all([
        api<EqaProgram[]>('/eqa/programs'),
        api<EqaEvent[]>('/eqa/events'),
        api<EqaSummary>('/dashboard/eqa-summary').catch(() => null)
      ]);
      setPrograms(progs); setEvents(evs);
      if (sum) setSummary(sum);
    } catch (e) { setError((e as Error).message); }
  }
  useEffect(() => { if (isEnabled('eqa')) void load(); }, [isEnabled]);
  if (!isEnabled('eqa')) return <DisabledModule />;

  async function submitProgram(e: FormEvent) {
    e.preventDefault(); setError(null);
    try {
      await api('/eqa/programs', { method: 'POST', body: JSON.stringify(programForm) });
      setProgramForm({ programName: '', provider: '', testArea: '', sectionId: '', frequency: '', contact: '', isActive: true });
      await load(); setTab('EQA Programs');
    } catch (e) { setError((e as Error).message); }
  }

  async function submitEvent(e: FormEvent) {
    e.preventDefault(); setError(null);
    if (!eventForm.eqaProgramId) return setError('Select a program');
    try {
      await api(`/eqa/programs/${eventForm.eqaProgramId}/events`, { method: 'POST', body: JSON.stringify(eventForm) });
      setEventForm({ eqaProgramId: '', cycleName: '', receivedDate: '', submissionDueDate: '', submittedDate: '', resultReceivedDate: '', performanceStatus: '', score: '', findings: '', responsibleStaffId: '' });
      await load(); setTab('EQA Events');
    } catch (e) { setError((e as Error).message); }
  }

  async function openEvent(id: number) {
    try { setSelectedEvent(await api(`/eqa/events/${id}`)); }
    catch (e) { setError((e as Error).message); }
  }

  async function submitResultRow(e: FormEvent) {
    e.preventDefault(); setError(null);
    if (!selectedEvent) return;
    try {
      await api(`/eqa/events/${selectedEvent.id}/results`, { method: 'POST', body: JSON.stringify(resultForm) });
      setResultForm({ analyteOrTest: '', reportedResult: '', expectedResult: '', performance: '', comment: '' });
      await openEvent(selectedEvent.id);
    } catch (e) { setError((e as Error).message); }
  }

  async function createNc(id: number) {
    try { await api(`/eqa/events/${id}/create-nc`, { method: 'POST', body: JSON.stringify({}) }); await load(); if (selectedEvent?.id === id) await openEvent(id); }
    catch (e) { setError((e as Error).message); }
  }
  async function createCapa(id: number) {
    try { await api(`/eqa/events/${id}/create-capa`, { method: 'POST', body: JSON.stringify({}) }); await load(); if (selectedEvent?.id === id) await openEvent(id); }
    catch (e) { setError((e as Error).message); }
  }

  const tabs = ['Dashboard', 'EQA Programs', 'New Program', 'EQA Events', 'Results', 'Unsatisfactory Performance', 'Reports'];
  const unsatisfactory = events.filter(ev => ['unsatisfactory', 'poor', 'fail', 'failed'].includes((ev.performance_status || '').toLowerCase()));

  return <div className="module-page">
    <PageHeader eyebrow="Process control" title="EQA Management" subtitle="External quality assessment events, results, and follow-up." />
    {tabBar(tab, tabs, setTab)}
    {error && <div className="error">{error}</div>}

    {tab === 'Dashboard' && summary && <div className="cards">
      <div className="card"><h4>Active programs</h4><p className="metric">{summary.activePrograms}</p></div>
      <div className="card"><h4>Open events</h4><p className="metric">{summary.openEvents}</p></div>
      <div className="card"><h4>Events due soon</h4><p className="metric">{summary.eventsDueSoon}</p></div>
      <div className="card"><h4>Unsatisfactory events</h4><p className="metric">{summary.unsatisfactoryEvents}</p></div>
      <div className="card"><h4>Requiring corrective action</h4><p className="metric">{summary.eventsRequiringCorrectiveAction}</p></div>
    </div>}

    {tab === 'EQA Programs' && <table className="data-table"><thead><tr><th>Code</th><th>Program</th><th>Provider</th><th>Test area</th><th>Frequency</th><th>Active</th></tr></thead><tbody>
      {programs.map(p => <tr key={p.id}><td>{p.program_code}</td><td>{p.program_name}</td><td>{p.provider}</td><td>{p.test_area}</td><td>{p.frequency || '—'}</td><td>{p.is_active ? 'Yes' : 'No'}</td></tr>)}
    </tbody></table>}

    {tab === 'New Program' && <form className="form-grid" onSubmit={submitProgram}>
      <label>Program name<input value={programForm.programName} onChange={e => setProgramForm({ ...programForm, programName: e.target.value })} required /></label>
      <label>Provider<input value={programForm.provider} onChange={e => setProgramForm({ ...programForm, provider: e.target.value })} required /></label>
      <label>Test area<input value={programForm.testArea} onChange={e => setProgramForm({ ...programForm, testArea: e.target.value })} required /></label>
      <label>Section<select value={programForm.sectionId} onChange={e => setProgramForm({ ...programForm, sectionId: e.target.value })}><option value="">—</option>{sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
      <label>Frequency<input value={programForm.frequency} onChange={e => setProgramForm({ ...programForm, frequency: e.target.value })} /></label>
      <label>Contact<input value={programForm.contact} onChange={e => setProgramForm({ ...programForm, contact: e.target.value })} /></label>
      <button type="submit">Create program</button>
    </form>}

    {tab === 'EQA Events' && <>
      <form className="form-grid" onSubmit={submitEvent}>
        <label>Program<select value={eventForm.eqaProgramId} onChange={e => setEventForm({ ...eventForm, eqaProgramId: e.target.value })} required><option value="">—</option>{programs.map(p => <option key={p.id} value={p.id}>{p.program_name}</option>)}</select></label>
        <label>Cycle name<input value={eventForm.cycleName} onChange={e => setEventForm({ ...eventForm, cycleName: e.target.value })} required /></label>
        <label>Received date<input type="date" value={eventForm.receivedDate} onChange={e => setEventForm({ ...eventForm, receivedDate: e.target.value })} /></label>
        <label>Submission due<input type="date" value={eventForm.submissionDueDate} onChange={e => setEventForm({ ...eventForm, submissionDueDate: e.target.value })} /></label>
        <label>Submitted date<input type="date" value={eventForm.submittedDate} onChange={e => setEventForm({ ...eventForm, submittedDate: e.target.value })} /></label>
        <label>Result received<input type="date" value={eventForm.resultReceivedDate} onChange={e => setEventForm({ ...eventForm, resultReceivedDate: e.target.value })} /></label>
        <label>Performance status<input value={eventForm.performanceStatus} onChange={e => setEventForm({ ...eventForm, performanceStatus: e.target.value })} placeholder="e.g. satisfactory" /></label>
        <label>Score<input value={eventForm.score} onChange={e => setEventForm({ ...eventForm, score: e.target.value })} /></label>
        <label>Findings<textarea value={eventForm.findings} onChange={e => setEventForm({ ...eventForm, findings: e.target.value })} /></label>
        <label>Responsible<select value={eventForm.responsibleStaffId} onChange={e => setEventForm({ ...eventForm, responsibleStaffId: e.target.value })}><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
        <button type="submit">Create event</button>
      </form>
      <table className="data-table"><thead><tr><th>Program</th><th>Cycle</th><th>Received</th><th>Due</th><th>Submitted</th><th>Performance</th><th></th></tr></thead><tbody>
        {events.map(ev => <tr key={ev.id}>
          <td>{ev.program_name}</td><td>{ev.cycle_name}</td><td>{ev.received_date || '—'}</td><td>{ev.submission_due_date || '—'}</td><td>{ev.submitted_date || '—'}</td><td>{formatBadge(ev.performance_status)}</td>
          <td><button onClick={() => openEvent(ev.id)}>Open</button></td>
        </tr>)}
      </tbody></table>
    </>}

    {tab === 'Results' && selectedEvent && <>
      <h3>{selectedEvent.program_name} – {selectedEvent.cycle_name}</h3>
      <form className="form-grid" onSubmit={submitResultRow}>
        <label>Analyte or test<input value={resultForm.analyteOrTest} onChange={e => setResultForm({ ...resultForm, analyteOrTest: e.target.value })} required /></label>
        <label>Reported result<input value={resultForm.reportedResult} onChange={e => setResultForm({ ...resultForm, reportedResult: e.target.value })} /></label>
        <label>Expected result<input value={resultForm.expectedResult} onChange={e => setResultForm({ ...resultForm, expectedResult: e.target.value })} /></label>
        <label>Performance<input value={resultForm.performance} onChange={e => setResultForm({ ...resultForm, performance: e.target.value })} /></label>
        <label>Comment<textarea value={resultForm.comment} onChange={e => setResultForm({ ...resultForm, comment: e.target.value })} /></label>
        <button type="submit">Add result row</button>
      </form>
      <table className="data-table"><thead><tr><th>Analyte</th><th>Reported</th><th>Expected</th><th>Performance</th><th>Comment</th></tr></thead><tbody>
        {(selectedEvent.results || []).map(r => <tr key={r.id}><td>{r.analyte_or_test}</td><td>{r.reported_result || '—'}</td><td>{r.expected_result || '—'}</td><td>{r.performance || '—'}</td><td>{r.comment || '—'}</td></tr>)}
      </tbody></table>
    </>}
    {tab === 'Results' && !selectedEvent && <p>Open an event from the EQA Events tab.</p>}

    {tab === 'Unsatisfactory Performance' && <table className="data-table"><thead><tr><th>Program</th><th>Cycle</th><th>Performance</th><th>Findings</th><th>Actions</th></tr></thead><tbody>
      {unsatisfactory.map(ev => <tr key={ev.id}>
        <td>{ev.program_name}</td><td>{ev.cycle_name}</td><td>{formatBadge(ev.performance_status)}</td><td>{ev.findings || '—'}</td>
        <td>
          {!ev.nc_id && <button onClick={() => createNc(ev.id)}>Create NC</button>}
          {!ev.capa_id && <button onClick={() => createCapa(ev.id)}>Create CAPA</button>}
        </td>
      </tr>)}
    </tbody></table>}

    {tab === 'Reports' && <p>EQA performance reporting view will be added in a later phase.</p>}
  </div>;
}

// ============= Verification & Validation =============
export function VerificationValidationPage() {
  const { isEnabled } = useModules();
  const { staff, equipment } = useLookups();
  const [tab, setTab] = useState('Dashboard');
  const [methods, setMethods] = useState<MethodVerification[]>([]);
  const [equipVerifs, setEquipVerifs] = useState<EquipmentVerification[]>([]);
  const [summary, setSummary] = useState<VerificationSummary | null>(null);
  const [selected, setSelected] = useState<(MethodVerification & { experiments?: VerificationExperiment[] }) | null>(null);
  const [selectedEquip, setSelectedEquip] = useState<EquipmentVerificationDetail | null>(null);
  const [methodForm, setMethodForm] = useState({ methodName: '', testName: '', verificationType: 'method_verification', equipmentId: '', reason: '', startDate: '', completionDate: '', parametersAssessed: '', acceptanceCriteria: '', summary: '', conclusion: '', status: 'in_progress' });
  const [expForm, setExpForm] = useState({ verificationId: '', experimentType: '', datePerformed: '', sampleCount: '', resultsSummary: '', acceptanceMet: false, performedByStaffId: '' });
  const [equipForm, setEquipForm] = useState({ equipmentId: '', verificationType: 'calibration_verification', verificationDate: '', reason: '', acceptanceCriteria: '', resultsSummary: '', conclusion: '', status: 'in_progress' });
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const [methodList, equipList, sum] = await Promise.all([
        api<MethodVerification[]>('/verification-validation'),
        api<EquipmentVerification[]>('/verification-validation/equipment'),
        api<VerificationSummary>('/dashboard/verification-summary').catch(() => null)
      ]);
      setMethods(methodList); setEquipVerifs(equipList);
      if (sum) setSummary(sum);
    } catch (e) { setError((e as Error).message); }
  }
  useEffect(() => { if (isEnabled('verification_validation')) void load(); }, [isEnabled]);
  if (!isEnabled('verification_validation')) return <DisabledModule />;

  async function submitMethod(e: FormEvent) {
    e.preventDefault(); setError(null);
    try {
      await api('/verification-validation', { method: 'POST', body: JSON.stringify(methodForm) });
      setMethodForm({ methodName: '', testName: '', verificationType: 'method_verification', equipmentId: '', reason: '', startDate: '', completionDate: '', parametersAssessed: '', acceptanceCriteria: '', summary: '', conclusion: '', status: 'in_progress' });
      await load(); setTab('Method Verification Register');
    } catch (e) { setError((e as Error).message); }
  }

  async function submitExperiment(e: FormEvent) {
    e.preventDefault(); setError(null);
    if (!expForm.verificationId) return setError('Select a verification');
    try {
      await api(`/verification-validation/${expForm.verificationId}/experiments`, { method: 'POST', body: JSON.stringify(expForm) });
      setExpForm({ verificationId: '', experimentType: '', datePerformed: '', sampleCount: '', resultsSummary: '', acceptanceMet: false, performedByStaffId: '' });
      if (selected) await openMethod(selected.id);
    } catch (e) { setError((e as Error).message); }
  }

  async function submitEquipVerif(e: FormEvent) {
    e.preventDefault(); setError(null);
    if (!equipForm.equipmentId) return setError('Select equipment');
    try {
      await api('/verification-validation/equipment', { method: 'POST', body: JSON.stringify(equipForm) });
      setEquipForm({ equipmentId: '', verificationType: 'calibration_verification', verificationDate: '', reason: '', acceptanceCriteria: '', resultsSummary: '', conclusion: '', status: 'in_progress' });
      await load();
    } catch (e) { setError((e as Error).message); }
  }

  async function openMethod(id: number) {
    try { setSelected(await api(`/verification-validation/${id}`)); }
    catch (e) { setError((e as Error).message); }
  }

  async function approveMethod(id: number) {
    try { await api(`/verification-validation/${id}/approve`, { method: 'POST', body: JSON.stringify({}) }); await load(); if (selected?.id === id) await openMethod(id); }
    catch (e) { setError((e as Error).message); }
  }

  async function approveEquip(id: number) {
    try { await api(`/verification-validation/equipment/${id}/approve`, { method: 'POST', body: JSON.stringify({}) }); await load(); if (selectedEquip?.id === id) await openEquip(id); }
    catch (e) { setError((e as Error).message); }
  }

  async function openEquip(id: number) {
    try { setSelectedEquip(await api<EquipmentVerificationDetail>(`/verification-validation/equipment/${id}`)); }
    catch (e) { setError((e as Error).message); }
  }

  const tabs = ['Dashboard', 'Method Verification Register', 'New Verification', 'Experiments', 'Equipment Verification', 'Reports'];

  return <div className="module-page">
    <PageHeader eyebrow="Technical quality" title="Verification &amp; Validation" subtitle="Method and equipment verification and validation records." />
    {tabBar(tab, tabs, setTab)}
    {error && <div className="error">{error}</div>}

    {tab === 'Dashboard' && summary && <div className="cards">
      <div className="card"><h4>Open method verifications</h4><p className="metric">{summary.openMethodVerifications}</p></div>
      <div className="card"><h4>Completed verifications</h4><p className="metric">{summary.completedVerifications}</p></div>
      <div className="card"><h4>Pending approval</h4><p className="metric">{summary.pendingApproval}</p></div>
      <div className="card"><h4>Equipment verifications this year</h4><p className="metric">{summary.equipmentVerificationsThisYear}</p></div>
      <div className="card"><h4>Equipment verifications pending approval</h4><p className="metric">{summary.equipmentVerificationsPendingApproval}</p></div>
    </div>}

    {tab === 'Method Verification Register' && <table className="data-table"><thead><tr><th>Number</th><th>Method</th><th>Test</th><th>Type</th><th>Equipment</th><th>Status</th><th></th></tr></thead><tbody>
      {methods.map(m => <tr key={m.id}>
        <td>{m.verification_number}</td><td>{m.method_name}</td><td>{m.test_name}</td><td>{m.verification_type}</td><td>{m.equipment_name || '—'}</td><td>{formatBadge(m.status)}</td>
        <td><button onClick={() => openMethod(m.id)}>Open</button>{m.status !== 'approved' && <button onClick={() => approveMethod(m.id)}>Approve</button>}</td>
      </tr>)}
    </tbody></table>}

    {tab === 'New Verification' && <form className="form-grid" onSubmit={submitMethod}>
      <label>Method name<input value={methodForm.methodName} onChange={e => setMethodForm({ ...methodForm, methodName: e.target.value })} required /></label>
      <label>Test name<input value={methodForm.testName} onChange={e => setMethodForm({ ...methodForm, testName: e.target.value })} required /></label>
      <label>Verification type<select value={methodForm.verificationType} onChange={e => setMethodForm({ ...methodForm, verificationType: e.target.value })} required>
        <option value="method_verification">Method verification</option>
        <option value="method_validation">Method validation</option>
        <option value="revalidation">Re-validation</option>
      </select></label>
      <label>Equipment<select value={methodForm.equipmentId} onChange={e => setMethodForm({ ...methodForm, equipmentId: e.target.value })}><option value="">—</option>{equipment.map(eq => <option key={eq.id} value={eq.id}>{eq.name}</option>)}</select></label>
      <label>Reason<input value={methodForm.reason} onChange={e => setMethodForm({ ...methodForm, reason: e.target.value })} /></label>
      <label>Start date<input type="date" value={methodForm.startDate} onChange={e => setMethodForm({ ...methodForm, startDate: e.target.value })} /></label>
      <label>Completion date<input type="date" value={methodForm.completionDate} onChange={e => setMethodForm({ ...methodForm, completionDate: e.target.value })} /></label>
      <label>Parameters assessed<textarea value={methodForm.parametersAssessed} onChange={e => setMethodForm({ ...methodForm, parametersAssessed: e.target.value })} /></label>
      <label>Acceptance criteria<textarea value={methodForm.acceptanceCriteria} onChange={e => setMethodForm({ ...methodForm, acceptanceCriteria: e.target.value })} /></label>
      <label>Summary<textarea value={methodForm.summary} onChange={e => setMethodForm({ ...methodForm, summary: e.target.value })} /></label>
      <label>Conclusion<textarea value={methodForm.conclusion} onChange={e => setMethodForm({ ...methodForm, conclusion: e.target.value })} /></label>
      <button type="submit">Create verification</button>
    </form>}

    {tab === 'Experiments' && <>
      <form className="form-grid" onSubmit={submitExperiment}>
        <label>Verification<select value={expForm.verificationId} onChange={e => setExpForm({ ...expForm, verificationId: e.target.value })} required><option value="">—</option>{methods.map(m => <option key={m.id} value={m.id}>{m.verification_number} – {m.method_name}</option>)}</select></label>
        <label>Experiment type<input value={expForm.experimentType} onChange={e => setExpForm({ ...expForm, experimentType: e.target.value })} required placeholder="e.g. precision, accuracy, linearity" /></label>
        <label>Date performed<input type="date" value={expForm.datePerformed} onChange={e => setExpForm({ ...expForm, datePerformed: e.target.value })} /></label>
        <label>Sample count<input type="number" value={expForm.sampleCount} onChange={e => setExpForm({ ...expForm, sampleCount: e.target.value })} /></label>
        <label>Results summary<textarea value={expForm.resultsSummary} onChange={e => setExpForm({ ...expForm, resultsSummary: e.target.value })} /></label>
        <label>Performed by<select value={expForm.performedByStaffId} onChange={e => setExpForm({ ...expForm, performedByStaffId: e.target.value })}><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
        <label><input type="checkbox" checked={expForm.acceptanceMet} onChange={e => setExpForm({ ...expForm, acceptanceMet: e.target.checked })} /> Acceptance met</label>
        <button type="submit">Add experiment</button>
      </form>
      {selected && <>
        <h3>{selected.verification_number} – {selected.method_name}</h3>
        <table className="data-table"><thead><tr><th>Type</th><th>Date</th><th>Samples</th><th>Results</th><th>Met</th></tr></thead><tbody>
          {(selected.experiments || []).map(x => <tr key={x.id}><td>{x.experiment_type}</td><td>{x.date_performed || '—'}</td><td>{x.sample_count ?? '—'}</td><td>{x.results_summary || '—'}</td><td>{x.acceptance_met ? 'Yes' : 'No'}</td></tr>)}
        </tbody></table>
      </>}
    </>}

    {tab === 'Equipment Verification' && <>
      <form className="form-grid" onSubmit={submitEquipVerif}>
        <label>Equipment<select value={equipForm.equipmentId} onChange={e => setEquipForm({ ...equipForm, equipmentId: e.target.value })} required><option value="">—</option>{equipment.map(eq => <option key={eq.id} value={eq.id}>{eq.name}</option>)}</select></label>
        <label>Verification type<input value={equipForm.verificationType} onChange={e => setEquipForm({ ...equipForm, verificationType: e.target.value })} required /></label>
        <label>Verification date<input type="date" value={equipForm.verificationDate} onChange={e => setEquipForm({ ...equipForm, verificationDate: e.target.value })} required /></label>
        <label>Reason<input value={equipForm.reason} onChange={e => setEquipForm({ ...equipForm, reason: e.target.value })} /></label>
        <label>Acceptance criteria<textarea value={equipForm.acceptanceCriteria} onChange={e => setEquipForm({ ...equipForm, acceptanceCriteria: e.target.value })} /></label>
        <label>Results summary<textarea value={equipForm.resultsSummary} onChange={e => setEquipForm({ ...equipForm, resultsSummary: e.target.value })} /></label>
        <label>Conclusion<textarea value={equipForm.conclusion} onChange={e => setEquipForm({ ...equipForm, conclusion: e.target.value })} /></label>
        <button type="submit">Record equipment verification</button>
      </form>
      <table className="data-table"><thead><tr><th>Number</th><th>Equipment</th><th>Type</th><th>Date</th><th>Status</th><th></th></tr></thead><tbody>
        {equipVerifs.map(ev => <tr key={ev.id}>
          <td>{ev.verification_number}</td><td>{ev.equipment_name}</td><td>{ev.verification_type}</td><td>{ev.verification_date}</td><td>{formatBadge(ev.status)}</td>
          <td>
            <button onClick={() => openEquip(ev.id)}>Open</button>
            {ev.status !== 'approved' && <button onClick={() => approveEquip(ev.id)}>Approve</button>}
          </td>
        </tr>)}
      </tbody></table>
      {selectedEquip && <div className="card" style={{ marginTop: 16 }}>
        <h3>{selectedEquip.verification_number} – {selectedEquip.equipment_name}</h3>
        <p>Status: {formatBadge(selectedEquip.status)} | Date: {selectedEquip.verification_date} | Type: {selectedEquip.verification_type}</p>
        {selectedEquip.reason && <p><strong>Reason:</strong> {selectedEquip.reason}</p>}
        {selectedEquip.acceptance_criteria && <p><strong>Acceptance criteria:</strong> {selectedEquip.acceptance_criteria}</p>}
        {selectedEquip.results_summary && <p><strong>Results:</strong> {selectedEquip.results_summary}</p>}
        {selectedEquip.conclusion && <p><strong>Conclusion:</strong> {selectedEquip.conclusion}</p>}
        <p>Verified by staff #{selectedEquip.verified_by_staff_id ?? '—'} | Approved by staff #{selectedEquip.approved_by_staff_id ?? '—'}</p>
        {selectedEquip.links && selectedEquip.links.length > 0 && <>
          <h4>Linked records</h4>
          <ul>{selectedEquip.links.map(l => <li key={l.id}>{l.source_module_key}/{l.source_record_type}#{l.source_record_id} → {l.target_module_key}/{l.target_record_type}#{l.target_record_id}{l.notes ? ` — ${l.notes}` : ''}</li>)}</ul>
        </>}
        <button className="secondary" onClick={() => setSelectedEquip(null)}>Close</button>
      </div>}
    </>}

    {tab === 'Reports' && <p>Verification & validation reports will be added in a later phase.</p>}
  </div>;
}

// ============= Measurement Uncertainty =============
export function MeasurementUncertaintyPage() {
  const { isEnabled } = useModules();
  const { equipment } = useLookups();
  const [tab, setTab] = useState('Dashboard');
  const [records, setRecords] = useState<MeasurementUncertaintyRecord[]>([]);
  const [summary, setSummary] = useState<MeasurementUncertaintySummary | null>(null);
  const [form, setForm] = useState({ testName: '', analyte: '', methodName: '', equipmentId: '', calculationDate: '', dataPeriodStart: '', dataPeriodEnd: '', sourceData: '', meanValue: '', sdValue: '', cvPercent: '', uncertaintyValue: '', expandedUncertainty: '', coverageFactor: '2', interpretation: '', status: 'draft' });
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const [recs, sum] = await Promise.all([
        api<MeasurementUncertaintyRecord[]>('/measurement-uncertainty'),
        api<MeasurementUncertaintySummary>('/dashboard/measurement-uncertainty-summary').catch(() => null)
      ]);
      setRecords(recs);
      if (sum) setSummary(sum);
    } catch (e) { setError((e as Error).message); }
  }
  useEffect(() => { if (isEnabled('measurement_uncertainty')) void load(); }, [isEnabled]);
  if (!isEnabled('measurement_uncertainty')) return <DisabledModule />;

  async function submit(e: FormEvent) {
    e.preventDefault(); setError(null);
    try {
      await api('/measurement-uncertainty', { method: 'POST', body: JSON.stringify(form) });
      setForm({ testName: '', analyte: '', methodName: '', equipmentId: '', calculationDate: '', dataPeriodStart: '', dataPeriodEnd: '', sourceData: '', meanValue: '', sdValue: '', cvPercent: '', uncertaintyValue: '', expandedUncertainty: '', coverageFactor: '2', interpretation: '', status: 'draft' });
      await load(); setTab('MU Register');
    } catch (e) { setError((e as Error).message); }
  }

  async function reviewRecord(id: number) {
    try { await api(`/measurement-uncertainty/${id}/review`, { method: 'POST', body: JSON.stringify({}) }); await load(); }
    catch (e) { setError((e as Error).message); }
  }
  async function approveRecord(id: number) {
    try { await api(`/measurement-uncertainty/${id}/approve`, { method: 'POST', body: JSON.stringify({}) }); await load(); }
    catch (e) { setError((e as Error).message); }
  }

  const tabs = ['Dashboard', 'MU Register', 'New MU Record', 'Review/Approval', 'Reports'];
  const pending = records.filter(r => r.status === 'draft' || r.status === 'in_review');

  return <div className="module-page">
    <PageHeader eyebrow="Technical quality" title="Measurement Uncertainty" subtitle="Measurement uncertainty budgets and periodic review." />
    {tabBar(tab, tabs, setTab)}
    {error && <div className="error">{error}</div>}

    {tab === 'Dashboard' && summary && <div className="cards">
      <div className="card"><h4>Active records</h4><p className="metric">{summary.activeRecords}</p></div>
      <div className="card"><h4>Pending review</h4><p className="metric">{summary.recordsPendingReview}</p></div>
      <div className="card"><h4>Pending approval</h4><p className="metric">{summary.recordsPendingApproval}</p></div>
      <div className="card"><h4>Due for review</h4><p className="metric">{summary.recordsDueForReview}</p></div>
      <div className="card"><h4>Completed this year</h4><p className="metric">{summary.recordsCompletedThisYear}</p></div>
    </div>}

    {tab === 'MU Register' && <table className="data-table"><thead><tr><th>Number</th><th>Test</th><th>Analyte</th><th>Method</th><th>Equipment</th><th>Date</th><th>U (k={records[0]?.coverage_factor ?? '—'})</th><th>Status</th></tr></thead><tbody>
      {records.map(r => <tr key={r.id}><td>{r.mu_number}</td><td>{r.test_name}</td><td>{r.analyte}</td><td>{r.method_name || '—'}</td><td>{r.equipment_name || '—'}</td><td>{r.calculation_date}</td><td>{r.expanded_uncertainty ?? r.uncertainty_value ?? '—'}</td><td>{formatBadge(r.status)}</td></tr>)}
    </tbody></table>}

    {tab === 'New MU Record' && <form className="form-grid" onSubmit={submit}>
      <label>Test name<input value={form.testName} onChange={e => setForm({ ...form, testName: e.target.value })} required /></label>
      <label>Analyte<input value={form.analyte} onChange={e => setForm({ ...form, analyte: e.target.value })} required /></label>
      <label>Method name<input value={form.methodName} onChange={e => setForm({ ...form, methodName: e.target.value })} /></label>
      <label>Equipment<select value={form.equipmentId} onChange={e => setForm({ ...form, equipmentId: e.target.value })}><option value="">—</option>{equipment.map(eq => <option key={eq.id} value={eq.id}>{eq.name}</option>)}</select></label>
      <label>Calculation date<input type="date" value={form.calculationDate} onChange={e => setForm({ ...form, calculationDate: e.target.value })} required /></label>
      <label>Data period start<input type="date" value={form.dataPeriodStart} onChange={e => setForm({ ...form, dataPeriodStart: e.target.value })} /></label>
      <label>Data period end<input type="date" value={form.dataPeriodEnd} onChange={e => setForm({ ...form, dataPeriodEnd: e.target.value })} /></label>
      <label>Source data<textarea value={form.sourceData} onChange={e => setForm({ ...form, sourceData: e.target.value })} placeholder="e.g. IQC L1 (n=120)" /></label>
      <label>Mean<input type="number" step="any" value={form.meanValue} onChange={e => setForm({ ...form, meanValue: e.target.value })} /></label>
      <label>SD<input type="number" step="any" value={form.sdValue} onChange={e => setForm({ ...form, sdValue: e.target.value })} /></label>
      <label>CV %<input type="number" step="any" value={form.cvPercent} onChange={e => setForm({ ...form, cvPercent: e.target.value })} /></label>
      <label>Uncertainty u<input type="number" step="any" value={form.uncertaintyValue} onChange={e => setForm({ ...form, uncertaintyValue: e.target.value })} /></label>
      <label>Expanded uncertainty U<input type="number" step="any" value={form.expandedUncertainty} onChange={e => setForm({ ...form, expandedUncertainty: e.target.value })} /></label>
      <label>Coverage factor k<input type="number" step="any" value={form.coverageFactor} onChange={e => setForm({ ...form, coverageFactor: e.target.value })} /></label>
      <label>Interpretation<textarea value={form.interpretation} onChange={e => setForm({ ...form, interpretation: e.target.value })} /></label>
      <button type="submit">Create MU record</button>
    </form>}

    {tab === 'Review/Approval' && <table className="data-table"><thead><tr><th>Number</th><th>Test</th><th>Analyte</th><th>Status</th><th>Actions</th></tr></thead><tbody>
      {pending.map(r => <tr key={r.id}>
        <td>{r.mu_number}</td><td>{r.test_name}</td><td>{r.analyte}</td><td>{formatBadge(r.status)}</td>
        <td>
          {r.status === 'draft' && <button onClick={() => reviewRecord(r.id)}>Mark in review</button>}
          {r.status === 'in_review' && <button onClick={() => approveRecord(r.id)}>Approve</button>}
        </td>
      </tr>)}
    </tbody></table>}

    {tab === 'Reports' && <p>Measurement uncertainty trend reports will be added in a later phase.</p>}
  </div>;
}
