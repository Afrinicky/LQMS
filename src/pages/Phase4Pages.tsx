import { FormEvent, useEffect, useState } from 'react';
import PageHeader from '../components/ui/PageHeader';
import { KpiStrip, ChartCard, DonutChart, BarMeter, CHART_COLORS, ModuleAlerts } from '../components/ui';
import { useModules } from '../hooks/useModules';
import { api } from '../services/api';
import DisabledModule from '../components/DisabledModule';
import ScannedRecordUpload from '../components/ScannedRecordUpload';
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
    // Only laboratory / measuring equipment undergoes analytical QC (IQC,
    // verification, validation, measurement uncertainty). Support equipment
    // (fridges, air-conditioners, incubators …) is excluded here — it is quality
    // assured through environmental monitoring and preventive maintenance instead.
    api<EquipmentItem[]>('/equipment').then(list => setEquipment(list.filter(e => e.equipment_class !== 'support'))).catch(() => setEquipment([]));
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
export function IqcPage({ embedded = false }: { embedded?: boolean } = {}) {
  const { isEnabled } = useModules();
  const { staff, sections, equipment } = useLookups();
  const [tab, setTab] = useState(embedded ? 'IQC Materials' : 'Dashboard');
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
  useEffect(() => { if (embedded || isEnabled('iqc')) void load(); }, [isEnabled]);
  if (!embedded && !isEnabled('iqc')) return <DisabledModule />;

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

  const tabs = ['Dashboard', 'IQC Materials', 'New Material', 'Result Entry', 'QC Failures', 'Levey-Jennings', 'Lot Changes', 'Scanned Records', 'Reports'].filter(name => !embedded || name !== 'Dashboard');
  const failures = results.filter(r => r.status !== 'accepted');

  return <div className="module-page">
    {!embedded && <PageHeader eyebrow="Process Management" title="IQC Management" subtitle="Internal quality control materials, results, and review." />}
    {tabBar(tab, tabs, setTab)}
    {error && <div className="error">{error}</div>}

    {tab === 'Dashboard' && <ModuleAlerts moduleKey="iqc" />}
    {tab === 'Dashboard' && summary && <KpiStrip items={[
      { label: 'Active materials', value: summary.activeMaterials, onClick: () => setTab('IQC Materials') },
      { label: 'Results this month', value: summary.resultsThisMonth, onClick: () => setTab('Result Entry') },
      { label: 'Failed / out-of-control', value: summary.failedThisMonth, tone: 'danger', onClick: () => setTab('QC Failures') },
      { label: 'Pending review', value: summary.resultsPendingReview, onClick: () => setTab('Result Entry') },
      { label: 'Lot changes this year', value: summary.lotChangesThisYear, onClick: () => setTab('Lot Changes') },
    ]} />}
    {tab === 'Dashboard' && summary && <div className="grid cols-2" style={{ marginTop: 18 }}>
      <ChartCard title="QC outcomes this month" subtitle="In-control vs flagged results">
        <DonutChart centerLabel="Results" data={[
          { label: 'In control', value: Math.max(0, summary.resultsThisMonth - summary.failedThisMonth), color: CHART_COLORS[1] },
          { label: 'Failed / OOC', value: summary.failedThisMonth, color: CHART_COLORS[3] },
        ]} />
      </ChartCard>
      <ChartCard title="QC workload" subtitle="Active materials and review backlog">
        <BarMeter data={[
          { label: 'Active materials', value: summary.activeMaterials, color: CHART_COLORS[0] },
          { label: 'Pending review', value: summary.resultsPendingReview, color: CHART_COLORS[2] },
          { label: 'Lot changes (year)', value: summary.lotChangesThisYear, color: CHART_COLORS[5] },
        ]} />
      </ChartCard>
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

    {tab === 'Scanned Records' && <ScannedRecordUpload moduleKey="iqc" sections={sections} equipment={equipment.map(e => ({ id: e.id, name: e.name }))}
      heading="Scanned IQC charts & legacy records"
      blurb="Upload scanned Levey-Jennings charts and historical IQC sheets so paper records are preserved and stand as evidence. Flag any out-of-control run — a nonconformity is raised automatically."
      categories={[{ value: 'iqc_chart', label: 'Levey-Jennings / QC chart' }, { value: 'iqc_log', label: 'IQC log sheet' }, { value: 'legacy_record', label: 'Legacy / historical record' }, { value: 'other', label: 'Other' }]} />}

    {tab === 'Reports' && (() => {
      const breaches = results.filter(r => r.rule_violation);
      const inControlPct = results.length ? Math.round(((results.length - breaches.length) / results.length) * 100) : 0;
      const pendingReview = results.filter(r => !r.reviewed_at).length;
      const perMaterial = materials.map(m => {
        const rs = results.filter(r => r.iqc_material_id === m.id);
        const vals = rs.map(r => Number(r.result_value)).filter(v => Number.isFinite(v));
        const mean = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
        const br = rs.filter(r => r.rule_violation).length;
        const last = rs.slice().sort((a, b) => (b.run_date || '').localeCompare(a.run_date || ''))[0];
        return { m, n: rs.length, mean, br, last, pct: rs.length ? Math.round(((rs.length - br) / rs.length) * 100) : null };
      });
      return <>
        <KpiStrip items={[
          { label: 'Active materials', value: materials.filter(m => m.is_active).length },
          { label: 'Results logged', value: results.length },
          { label: 'In-control', value: `${inControlPct}%`, tone: inControlPct >= 95 ? undefined : 'warning' },
          { label: 'Rule breaches', value: breaches.length, tone: breaches.length ? 'warning' : undefined },
          { label: 'Pending review', value: pendingReview, tone: pendingReview ? 'warning' : undefined },
          { label: 'Lot changes', value: lotChanges.length },
        ]} />
        <div className="card" style={{ marginTop: 16 }}>
          <h3>Per-material QC performance</h3>
          <p className="muted" style={{ marginTop: 0 }}>Westgard rule breaches and in-control rate for each control material. Open the <em>Levey-Jennings</em> tab to see the run chart for any material.</p>
          <table className="data-table"><thead><tr><th>Material</th><th>Test / analyte</th><th>Runs</th><th>Observed mean</th><th>Target mean</th><th>Breaches</th><th>In-control</th><th>Last run</th></tr></thead><tbody>
            {perMaterial.map(x => <tr key={x.m.id}>
              <td>{x.m.material_name}<div className="muted" style={{ fontSize: 11 }}>Lot {x.m.lot_number}</div></td>
              <td>{x.m.test_name}{x.m.analyte ? ` · ${x.m.analyte}` : ''}</td>
              <td>{x.n}</td>
              <td>{x.mean != null ? x.mean.toFixed(2) : '—'}</td>
              <td>{x.m.target_mean ?? '—'}</td>
              <td>{x.br ? <span className="badge warning">{x.br}</span> : 0}</td>
              <td>{x.pct != null ? `${x.pct}%` : '—'}</td>
              <td>{x.last ? x.last.run_date : '—'}</td>
            </tr>)}
            {perMaterial.length === 0 && <tr><td colSpan={8} className="muted">No IQC materials yet.</td></tr>}
          </tbody></table>
        </div>
        {breaches.length > 0 && <div className="card" style={{ marginTop: 16 }}>
          <h3>Recent rule breaches</h3>
          <table className="data-table"><thead><tr><th>Date</th><th>Material</th><th>Value</th><th>Rule</th><th>Z-score</th><th>Reviewed</th></tr></thead><tbody>
            {breaches.slice().sort((a, b) => (b.run_date || '').localeCompare(a.run_date || '')).slice(0, 20).map(r => <tr key={r.id}>
              <td>{r.run_date}</td><td>{r.material_name || materials.find(m => m.id === r.iqc_material_id)?.material_name || '—'}</td>
              <td>{r.result_value}</td><td>{formatBadge(r.rule_violation)}</td><td>{r.z_score != null ? r.z_score.toFixed(2) : '—'}</td><td>{r.reviewed_at ? '✓' : <span className="badge warning">pending</span>}</td>
            </tr>)}
          </tbody></table>
        </div>}
      </>;
    })()}
  </div>;
}

// ============= EQA =============
export function EqaPage({ embedded = false }: { embedded?: boolean } = {}) {
  const { isEnabled } = useModules();
  const { staff, sections } = useLookups();
  const [tab, setTab] = useState(embedded ? 'EQA Programs' : 'Dashboard');
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
  useEffect(() => { if (embedded || isEnabled('eqa')) void load(); }, [isEnabled]);
  if (!embedded && !isEnabled('eqa')) return <DisabledModule />;

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

  const tabs = ['Dashboard', 'EQA Programs', 'New Program', 'EQA Events', 'Results', 'Unsatisfactory Performance', 'Reports'].filter(name => !embedded || name !== 'Dashboard');
  const unsatisfactory = events.filter(ev => ['unsatisfactory', 'poor', 'fail', 'failed'].includes((ev.performance_status || '').toLowerCase()));

  return <div className="module-page">
    {!embedded && <PageHeader eyebrow="Process Management" title="EQA Management" subtitle="External quality assessment events, results, and follow-up." />}
    {tabBar(tab, tabs, setTab)}
    {error && <div className="error">{error}</div>}

    {tab === 'Dashboard' && <ModuleAlerts moduleKey="eqa" />}
    {tab === 'Dashboard' && summary && <KpiStrip items={[
      { label: 'Active programs', value: summary.activePrograms, onClick: () => setTab('EQA Programs') },
      { label: 'Open events', value: summary.openEvents, onClick: () => setTab('EQA Events') },
      { label: 'Events due soon', value: summary.eventsDueSoon, tone: 'warning', onClick: () => setTab('EQA Events') },
      { label: 'Unsatisfactory events', value: summary.unsatisfactoryEvents, tone: 'danger', onClick: () => setTab('Unsatisfactory Performance') },
      { label: 'Corrective action needed', value: summary.eventsRequiringCorrectiveAction, onClick: () => setTab('Unsatisfactory Performance') },
    ]} />}
    {tab === 'Dashboard' && summary && <div className="grid cols-2" style={{ marginTop: 18 }}>
      <ChartCard title="EQA event status" subtitle="Open events by performance outcome">
        <DonutChart centerLabel="Open" data={[
          { label: 'Satisfactory', value: Math.max(0, summary.openEvents - summary.unsatisfactoryEvents), color: CHART_COLORS[1] },
          { label: 'Unsatisfactory', value: summary.unsatisfactoryEvents, color: CHART_COLORS[3] },
        ]} />
      </ChartCard>
      <ChartCard title="EQA attention" subtitle="Scheduling and corrective-action load">
        <BarMeter data={[
          { label: 'Events due soon', value: summary.eventsDueSoon, color: CHART_COLORS[2] },
          { label: 'Unsatisfactory', value: summary.unsatisfactoryEvents, color: CHART_COLORS[3] },
          { label: 'Corrective action', value: summary.eventsRequiringCorrectiveAction, color: CHART_COLORS[4] },
        ]} />
      </ChartCard>
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
        <label>Performance status<select value={eventForm.performanceStatus} onChange={e => setEventForm({ ...eventForm, performanceStatus: e.target.value })}><option value="">— not yet assessed —</option><option value="satisfactory">Satisfactory</option><option value="unsatisfactory">Unsatisfactory</option><option value="not assessed">Not assessed</option></select></label>
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

    {tab === 'Reports' && (() => {
      const isUnsat = (s?: string) => !!s && /unsat|unaccept|fail|poor/i.test(s);
      const isSat = (s?: string) => !!s && /satisf|accept|pass|good/i.test(s);
      const scored = events.filter(e => e.performance_status);
      const unsat = events.filter(e => isUnsat(e.performance_status));
      const sat = events.filter(e => isSat(e.performance_status));
      const pendingSubmission = events.filter(e => !e.submitted_date && e.submission_due_date);
      const perProgram = programs.map(p => {
        const evs = events.filter(e => e.eqa_program_id === p.id);
        return { p, n: evs.length, sat: evs.filter(e => isSat(e.performance_status)).length, unsat: evs.filter(e => isUnsat(e.performance_status)).length, last: evs.slice().sort((a, b) => (b.result_received_date || b.created_at || '').localeCompare(a.result_received_date || a.created_at || ''))[0] };
      });
      return <>
        <KpiStrip items={[
          { label: 'Programs', value: programs.filter(p => p.is_active).length },
          { label: 'Events', value: events.length },
          { label: 'Satisfactory', value: sat.length },
          { label: 'Unsatisfactory', value: unsat.length, tone: unsat.length ? 'warning' : undefined },
          { label: 'Success rate', value: scored.length ? `${Math.round((sat.length / scored.length) * 100)}%` : '—' },
          { label: 'Awaiting submission', value: pendingSubmission.length, tone: pendingSubmission.length ? 'warning' : undefined },
        ]} />
        <div className="card" style={{ marginTop: 16 }}>
          <h3>Per-programme performance</h3>
          <table className="data-table"><thead><tr><th>Programme</th><th>Provider</th><th>Test area</th><th>Events</th><th>Satisfactory</th><th>Unsatisfactory</th><th>Last score</th></tr></thead><tbody>
            {perProgram.map(x => <tr key={x.p.id}>
              <td>{x.p.program_name}</td><td>{x.p.provider}</td><td>{x.p.test_area}</td><td>{x.n}</td>
              <td>{x.sat}</td><td>{x.unsat ? <span className="badge warning">{x.unsat}</span> : 0}</td>
              <td>{x.last?.score || x.last?.performance_status || '—'}</td>
            </tr>)}
            {perProgram.length === 0 && <tr><td colSpan={7} className="muted">No EQA programmes yet.</td></tr>}
          </tbody></table>
        </div>
        {unsat.length > 0 && <div className="card" style={{ marginTop: 16 }}>
          <h3>Unsatisfactory performances needing action</h3>
          <table className="data-table"><thead><tr><th>Cycle</th><th>Programme</th><th>Status</th><th>Score</th><th>Corrective action</th></tr></thead><tbody>
            {unsat.map(e => <tr key={e.id}><td>{e.cycle_name}</td><td>{e.program_name || programs.find(p => p.id === e.eqa_program_id)?.program_name || '—'}</td><td>{formatBadge(e.performance_status)}</td><td>{e.score || '—'}</td><td>{e.corrective_action_required ? <span className="badge warning">required</span> : (e.nc_id ? 'NC raised' : '—')}</td></tr>)}
          </tbody></table>
        </div>}
      </>;
    })()}
  </div>;
}

// ============= Verification & Validation =============
export function VerificationValidationPage({ embedded = false }: { embedded?: boolean } = {}) {
  const { isEnabled } = useModules();
  const { staff, equipment } = useLookups();
  const [tab, setTab] = useState(embedded ? 'Method Verification Register' : 'Dashboard');
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
  useEffect(() => { if (embedded || isEnabled('verification_validation')) void load(); }, [isEnabled]);
  if (!embedded && !isEnabled('verification_validation')) return <DisabledModule />;

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

  const tabs = ['Dashboard', 'Method Verification Register', 'New Verification', 'Experiments', 'Equipment Verification', 'Scanned Records', 'Reports'].filter(name => !embedded || name !== 'Dashboard');

  return <div className="module-page">
    {!embedded && <PageHeader eyebrow="Process Management" title="Verification &amp; Validation" subtitle="Method and equipment verification and validation records." />}
    {tabBar(tab, tabs, setTab)}
    {error && <div className="error">{error}</div>}

    {tab === 'Dashboard' && <ModuleAlerts moduleKey="verification_validation" />}
    {tab === 'Dashboard' && summary && <KpiStrip items={[
      { label: 'Open method verifications', value: summary.openMethodVerifications, onClick: () => setTab('Method Verification Register') },
      { label: 'Completed verifications', value: summary.completedVerifications, tone: 'success', onClick: () => setTab('Method Verification Register') },
      { label: 'Pending approval', value: summary.pendingApproval, onClick: () => setTab('Method Verification Register') },
      { label: 'Equipment verifications (year)', value: summary.equipmentVerificationsThisYear, onClick: () => setTab('Equipment Verification') },
      { label: 'Equipment pending approval', value: summary.equipmentVerificationsPendingApproval, onClick: () => setTab('Equipment Verification') },
    ]} />}
    {tab === 'Dashboard' && summary && <div className="grid cols-2" style={{ marginTop: 18 }}>
      <ChartCard title="Method verification status" subtitle="Open vs completed verifications">
        <DonutChart centerLabel="Methods" data={[
          { label: 'Completed', value: summary.completedVerifications, color: CHART_COLORS[1] },
          { label: 'Open', value: summary.openMethodVerifications, color: CHART_COLORS[0] },
          { label: 'Pending approval', value: summary.pendingApproval, color: CHART_COLORS[2] },
        ]} />
      </ChartCard>
      <ChartCard title="Approval backlog" subtitle="Method and equipment sign-offs awaiting approval">
        <BarMeter data={[
          { label: 'Methods pending approval', value: summary.pendingApproval, color: CHART_COLORS[2] },
          { label: 'Equip. verifications (year)', value: summary.equipmentVerificationsThisYear, color: CHART_COLORS[0] },
          { label: 'Equip. pending approval', value: summary.equipmentVerificationsPendingApproval, color: CHART_COLORS[4] },
        ]} />
      </ChartCard>
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

    {tab === 'Scanned Records' && <ScannedRecordUpload moduleKey="verification_validation" equipment={equipment.map(e => ({ id: e.id, name: e.name }))}
      heading="Scanned verification / validation reports & legacy records"
      blurb="Upload scanned method verification and validation reports (and historical paper records) as evidence. Flag any failed acceptance criterion — a nonconformity is raised automatically."
      categories={[{ value: 'verification_report', label: 'Verification report' }, { value: 'validation_report', label: 'Validation report' }, { value: 'legacy_record', label: 'Legacy / historical record' }, { value: 'other', label: 'Other' }]} />}

    {tab === 'Reports' && (() => {
      const done = (s?: string) => !!s && /complet|approv|pass|accept/i.test(s);
      const methodsDone = methods.filter(m => done(m.status));
      const methodsPending = methods.filter(m => !done(m.status));
      const equipDone = equipVerifs.filter(e => done(e.status));
      const equipPending = equipVerifs.filter(e => !done(e.status));
      return <>
        <KpiStrip items={[
          { label: 'Method verifications', value: methods.length },
          { label: 'Methods completed', value: methodsDone.length },
          { label: 'Methods in progress', value: methodsPending.length, tone: methodsPending.length ? 'warning' : undefined },
          { label: 'Equipment verifications', value: equipVerifs.length },
          { label: 'Equipment completed', value: equipDone.length },
          { label: 'Equipment pending', value: equipPending.length, tone: equipPending.length ? 'warning' : undefined },
        ]} />
        <div className="card" style={{ marginTop: 16 }}>
          <h3>Method verification &amp; validation register</h3>
          <table className="data-table"><thead><tr><th>Number</th><th>Method / test</th><th>Type</th><th>Completed</th><th>Conclusion</th><th>Status</th></tr></thead><tbody>
            {methods.slice().sort((a, b) => (b.completion_date || b.created_at || '').localeCompare(a.completion_date || a.created_at || '')).map(m => <tr key={m.id}>
              <td>{m.verification_number}</td><td>{m.method_name}<div className="muted" style={{ fontSize: 11 }}>{m.test_name}</div></td>
              <td>{(m.verification_type || '').replace(/_/g, ' ')}</td><td>{m.completion_date || '—'}</td><td>{m.conclusion || '—'}</td><td>{formatBadge(m.status)}</td>
            </tr>)}
            {methods.length === 0 && <tr><td colSpan={6} className="muted">No method verifications recorded.</td></tr>}
          </tbody></table>
        </div>
        <div className="card" style={{ marginTop: 16 }}>
          <h3>Equipment verification register</h3>
          <table className="data-table"><thead><tr><th>Number</th><th>Equipment</th><th>Type</th><th>Date</th><th>Conclusion</th><th>Status</th></tr></thead><tbody>
            {equipVerifs.slice().sort((a, b) => (b.verification_date || '').localeCompare(a.verification_date || '')).map(e => <tr key={e.id}>
              <td>{e.verification_number}</td><td>{e.equipment_name || '—'}{e.equipment_number ? <div className="muted" style={{ fontSize: 11 }}>{e.equipment_number}</div> : null}</td>
              <td>{(e.verification_type || '').replace(/_/g, ' ')}</td><td>{e.verification_date}</td><td>{e.conclusion || '—'}</td><td>{formatBadge(e.status)}</td>
            </tr>)}
            {equipVerifs.length === 0 && <tr><td colSpan={6} className="muted">No equipment verifications recorded.</td></tr>}
          </tbody></table>
        </div>
      </>;
    })()}
  </div>;
}

// ============= Measurement Uncertainty =============
export function MeasurementUncertaintyPage({ embedded = false }: { embedded?: boolean } = {}) {
  const { isEnabled } = useModules();
  const { equipment } = useLookups();
  const [tab, setTab] = useState(embedded ? 'MU Register' : 'Dashboard');
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
  useEffect(() => { if (embedded || isEnabled('measurement_uncertainty')) void load(); }, [isEnabled]);
  if (!embedded && !isEnabled('measurement_uncertainty')) return <DisabledModule />;

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

  const tabs = ['Dashboard', 'MU Register', 'New MU Record', 'Review/Approval', 'Reports'].filter(name => !embedded || name !== 'Dashboard');
  const pending = records.filter(r => r.status === 'draft' || r.status === 'in_review');

  return <div className="module-page">
    {!embedded && <PageHeader eyebrow="Process Management" title="Measurement Uncertainty" subtitle="Measurement uncertainty budgets and periodic review." />}
    {tabBar(tab, tabs, setTab)}
    {error && <div className="error">{error}</div>}

    {tab === 'Dashboard' && <ModuleAlerts moduleKey="measurement_uncertainty" />}
    {tab === 'Dashboard' && summary && <KpiStrip items={[
      { label: 'Active records', value: summary.activeRecords, onClick: () => setTab('MU Register') },
      { label: 'Pending review', value: summary.recordsPendingReview, onClick: () => setTab('Review/Approval') },
      { label: 'Pending approval', value: summary.recordsPendingApproval, onClick: () => setTab('Review/Approval') },
      { label: 'Due for review', value: summary.recordsDueForReview, tone: 'warning', onClick: () => setTab('MU Register') },
      { label: 'Completed this year', value: summary.recordsCompletedThisYear, tone: 'success', onClick: () => setTab('MU Register') },
    ]} />}
    {tab === 'Dashboard' && summary && <div className="grid cols-2" style={{ marginTop: 18 }}>
      <ChartCard title="MU record status" subtitle="Active records by review stage">
        <DonutChart centerLabel="Active" data={[
          { label: 'Pending review', value: summary.recordsPendingReview, color: CHART_COLORS[2] },
          { label: 'Pending approval', value: summary.recordsPendingApproval, color: CHART_COLORS[0] },
          { label: 'Due for review', value: summary.recordsDueForReview, color: CHART_COLORS[4] },
        ]} />
      </ChartCard>
      <ChartCard title="Review pipeline" subtitle="Measurement-uncertainty workload">
        <BarMeter data={[
          { label: 'Pending review', value: summary.recordsPendingReview, color: CHART_COLORS[2] },
          { label: 'Pending approval', value: summary.recordsPendingApproval, color: CHART_COLORS[0] },
          { label: 'Due for review', value: summary.recordsDueForReview, color: CHART_COLORS[4] },
          { label: 'Completed (year)', value: summary.recordsCompletedThisYear, color: CHART_COLORS[1] },
        ]} />
      </ChartCard>
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

    {tab === 'Reports' && (() => {
      const approved = records.filter(r => /approv/i.test(r.status));
      const pending = records.filter(r => !/approv/i.test(r.status));
      const highCv = records.filter(r => r.cv_percent != null && Number(r.cv_percent) > 10);
      return <>
        <KpiStrip items={[
          { label: 'MU records', value: records.length },
          { label: 'Approved', value: approved.length },
          { label: 'Pending', value: pending.length, tone: pending.length ? 'warning' : undefined },
          { label: 'CV > 10%', value: highCv.length, tone: highCv.length ? 'warning' : undefined },
        ]} />
        <div className="card" style={{ marginTop: 16 }}>
          <h3>Measurement uncertainty budget by test</h3>
          <p className="muted" style={{ marginTop: 0 }}>Estimated uncertainty for each measurand. Expanded uncertainty (U) is reported at the stated coverage factor (k, usually 2 ≈ 95%).</p>
          <table className="data-table"><thead><tr><th>Number</th><th>Test / analyte</th><th>Mean</th><th>SD</th><th>CV %</th><th>u</th><th>U (expanded)</th><th>k</th><th>Status</th></tr></thead><tbody>
            {records.slice().sort((a, b) => (b.calculation_date || '').localeCompare(a.calculation_date || '')).map(r => <tr key={r.id}>
              <td>{r.mu_number}</td><td>{r.test_name}{r.analyte ? ` · ${r.analyte}` : ''}{r.equipment_name ? <div className="muted" style={{ fontSize: 11 }}>{r.equipment_name}</div> : null}</td>
              <td>{r.mean_value ?? '—'}</td><td>{r.sd_value ?? '—'}</td>
              <td>{r.cv_percent != null ? <span className={Number(r.cv_percent) > 10 ? 'badge warning' : ''}>{Number(r.cv_percent).toFixed(1)}</span> : '—'}</td>
              <td>{r.uncertainty_value ?? '—'}</td><td>{r.expanded_uncertainty ?? '—'}</td><td>{r.coverage_factor ?? '—'}</td><td>{formatBadge(r.status)}</td>
            </tr>)}
            {records.length === 0 && <tr><td colSpan={9} className="muted">No measurement uncertainty records yet.</td></tr>}
          </tbody></table>
        </div>
      </>;
    })()}
  </div>;
}
