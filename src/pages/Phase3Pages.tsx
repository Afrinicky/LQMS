import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import PageHeader from '../components/ui/PageHeader';
import { KpiStrip, ChartCard, DonutChart, BarMeter, BarChart, CHART_COLORS, ModuleAlerts, DetailModal } from '../components/ui';
import { useModules } from '../hooks/useModules';
import { api, API_BASE, getToken } from '../services/api';
import DisabledModule from '../components/DisabledModule';
import ScannedRecordUpload from '../components/ScannedRecordUpload';
import XlsxToolbar from '../components/XlsxToolbar';
import BarcodeScanner from '../components/BarcodeScanner';
import BarcodeLabelGenerator from '../components/BarcodeLabelGenerator';
import { code128Svg } from '../../shared/utils/barcode';
import { printLabelSheet, LABEL_PRESETS } from '../utils/labelPrint';
import { EnvironmentalMonitoringPage, EnvLiveCards } from './EnvironmentalMonitoringPage';
import { usePermissions } from '../hooks/usePermissions';
import PermissionTabs from '../components/PermissionTabs';
import { useFocusTarget, focusAttr } from '../hooks/useFocusTarget';
import type {
  Location, Section, Department, Staff, Supplier, EquipmentItem, InventoryItem, MonitoringRecord, SafetyIncident,
  EquipmentMaintenanceRecord, EquipmentBreakdown, MonitoringItem, MonitoringReading,
  EquipmentChecklistItem, EquipmentVerificationRecord, EquipmentCalibrationRecord, ReferenceStandard, EquipmentSchedule, EquipmentAdverseEvent, EquipmentCompetency, EquipmentDocumentLink,
  InventoryBatch, OperationsSummary,
  SafetyEquipment, SafetyInspection, WasteDisposalRecord, HazardousChemical, StaffImmunization, FacilitiesSafetySummary,
  StorageInspection
} from '../../shared/types/api';
import {
  EQUIPMENT_CATEGORIES, EQUIPMENT_CATEGORY_LABELS, EQUIPMENT_CATEGORY_HINTS, EQUIPMENT_CATEGORY_EXAMPLES,
  DUTY_LABELS, DUTY_CLAUSES, DUTY_HINTS, dutiesFor, categoryFromLegacy,
} from '../../shared/constants/equipment';

const statusBadgeClass = (status?: string) => `badge ${status ? status.toLowerCase().replace(/\s+/g, '-') : 'unknown'}`;
const formatBadge = (status?: string) => <span className={statusBadgeClass(status)}>{status ? status.replace(/_/g, ' ') : 'Unknown'}</span>;

// Tabs are filtered by permission — a tab whose feature this user cannot
// view is not drawn. These pages host several modules, so each call
// passes the module its tabs belong to.
const tabBarFor = (moduleKey: string) => (active: string, tabs: string[], onChange: (name: string) => void) =>
  <PermissionTabs moduleKey={moduleKey} tabs={tabs} active={active} onChange={onChange} />;

function useLookups() {
  const [staff, setStaff] = useState<Staff[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  useEffect(() => {
    api<Staff[]>('/staff').then(setStaff).catch(() => setStaff([]));
    api<Section[]>('/sections').then(setSections).catch(() => setSections([]));
    api<Location[]>('/locations').then(setLocations).catch(() => setLocations([]));
  }, []);
  return { staff, sections, locations };
}

function staffName(staffList: Staff[], id?: number | null) {
  if (!id) return '—';
  return staffList.find(s => s.id === id)?.fullName || `Staff #${id}`;
}

// ============= EQUIPMENT =============
type EquipmentDetail = EquipmentItem & { maintenance?: EquipmentMaintenanceRecord[]; breakdowns?: EquipmentBreakdown[]; verifications?: EquipmentVerificationRecord[]; calibrations?: EquipmentCalibrationRecord[]; schedules?: EquipmentSchedule[]; adverseEvents?: EquipmentAdverseEvent[]; competencies?: EquipmentCompetency[]; documents?: EquipmentDocumentLink[]; links?: any[] };
const COMPETENCY_OUTCOMES = [{ v: 'competent', l: 'Competent' }, { v: 'competent_with_supervision', l: 'Competent with supervision' }, { v: 'not_yet_competent', l: 'Not yet competent' }];
const EQUIP_DOC_TYPES = ['Manual / IFU', 'SOP', 'Calibration certificate', 'Verification report', 'Maintenance record', 'Service report', 'Acceptance testing', 'Certificate', 'Other'];
const SCHEDULE_FREQUENCIES = ['daily', 'weekly', 'monthly', 'quarterly', 'biannual', 'annual', 'custom'];
const MAINTENANCE_TYPES = ['preventive', 'corrective', 'service', 'calibration', 'verification'];
// The reportable equipment adverse-incident categories.
const ADVERSE_EVENT_TYPES: { value: string; label: string }[] = [
  { value: 'malfunction_patient_harm', label: 'Malfunction causing actual/potential patient harm' },
  { value: 'erroneous_results_reported', label: 'Failure leading to erroneous results that were reported' },
  { value: 'staff_injury', label: 'Physical injury to staff from equipment failure' },
  { value: 'safety_feature_failure', label: 'Safety feature failure (e-stop, alarm, interlock)' },
  { value: 'electrical_mechanical_hazard', label: 'Electrical or mechanical hazard identified' },
  { value: 'recurrent_systematic_failure', label: 'Recurrent or systematic failure (e.g. IQC failure)' },
];
const adverseTypeLabel = (v?: string) => ADVERSE_EVENT_TYPES.find(t => t.value === v)?.label || v || '—';

// Upload a file to the shared store; returns its numeric id as a string, or null.
async function uploadEquipFile(file: File | null): Promise<string | null> {
  if (!file) return null;
  const fd = new FormData(); fd.append('file', file);
  const token = getToken();
  const res = await fetch(`${API_BASE}/files`, { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : undefined, body: fd });
  if (!res.ok) throw new Error((await res.json().catch(() => ({ error: res.statusText }))).error ?? res.statusText);
  return String((await res.json()).id);
}
const RESPONSE_OPTIONS = [{ v: 'yes', l: 'Yes' }, { v: 'no', l: 'No' }, { v: 'na', l: 'N/A' }];

const emptyEquipForm = {
  equipmentNumber: '', name: '', category: '', equipmentClass: 'laboratory', equipmentCategory: 'analyser', equipmentType: '', manufacturer: '', model: '', serialNumber: '',
  supplierName: '', supplierLocation: '', supplierContact: '', countryOfOrigin: '', conditionReceived: '',
  locationId: '', departmentId: '', sectionId: '', status: 'operational', criticality: '',
  maintenanceFrequency: '', calibrationFrequency: '', nextMaintenanceDue: '', nextCalibrationDue: '',
  responsibleStaffId: '', dateReceived: '', dateInService: '', dateOutOfService: '', calibrationRequired: false, notes: '',
};
const CONDITION_OPTIONS = ['new', 'used', 'reconditioned'];
const CRITICALITY_OPTIONS = [{ value: 'critical', label: 'Critical' }, { value: 'non_critical', label: 'Non-critical' }];

// Components that can appear on a printed equipment label.
const LABEL_FIELDS: { key: string; label: string }[] = [
  { key: 'identifier', label: 'Unique identifier' },
  { key: 'name', label: 'Name' },
  { key: 'serial', label: 'Serial number' },
  { key: 'model', label: 'Model' },
  { key: 'manufacturer', label: 'Manufacturer' },
  { key: 'location', label: 'Location' },
  { key: 'custodian', label: 'Custodian' },
  { key: 'nextCalibration', label: 'Next calibration' },
  { key: 'nextMaintenance', label: 'Next maintenance' },
];
const LABEL_SIZES: { key: string; label: string; w: number; h: number }[] = [
  { key: 'small', label: 'Small (50 × 25 mm)', w: 50, h: 25 },
  { key: 'medium', label: 'Medium (70 × 40 mm)', w: 70, h: 40 },
  { key: 'large', label: 'Large (100 × 60 mm)', w: 100, h: 60 },
];

function esc(v: unknown): string {
  return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

function printHtml(title: string, bodyHtml: string, extraCss = '') {
  const win = window.open('', '_blank', 'width=900,height=700');
  if (!win) return;
  win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
    * { box-sizing: border-box; } body { font-family: 'Segoe UI', system-ui, sans-serif; color: #16232a; margin: 24px; }
    h1 { font-size: 20px; margin: 0 0 2px; } h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: #4a6b74; border-bottom: 1px solid #d6e0e3; padding-bottom: 4px; margin: 22px 0 10px; }
    .meta { color: #5a6f77; font-size: 12px; margin-bottom: 14px; }
    table { border-collapse: collapse; width: 100%; font-size: 12.5px; } td, th { text-align: left; padding: 6px 8px; border-bottom: 1px solid #e5ebed; vertical-align: top; }
    .kv { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 28px; font-size: 13px; }
    .kv div { display: flex; justify-content: space-between; gap: 12px; padding: 4px 0; border-bottom: 1px solid #eef2f3; }
    .kv span:first-child { color: #5a6f77; } .kv span:last-child { font-weight: 600; text-align: right; }
    ${extraCss}
  </style></head><body>${bodyHtml}</body></html>`);
  win.document.close();
  win.focus();
  setTimeout(() => { win.print(); }, 250);
}


/**
 * What this item owes, and why.
 *
 * The point of categorising equipment is not to label it — it is to say which
 * quality activities keep it fit for use. An analyser earns calibration,
 * verification, uncertainty, IQC and EQA; a refrigerator earns acceptance,
 * continuous monitoring, maintenance and certification. Neither is unmanaged.
 * Each duty is shown with the clause it answers to, so the answer to "why are
 * we doing this?" is on the same screen as the duty.
 */
function EquipmentDuties({ item }: { item: EquipmentItem }) {
  const category = (item.equipment_category ?? categoryFromLegacy(item.equipment_class, item.name, item.category)) as string;
  const duties = dutiesFor(category);
  return <div className="eq-duties">
    <h4>Quality programme for a {String(EQUIPMENT_CATEGORY_LABELS[category as never] ?? 'item').toLowerCase()}</h4>
    <p className="muted" style={{ marginTop: -4 }}>{EQUIPMENT_CATEGORY_HINTS[category as never]}</p>
    <ul className="eq-duty-list">
      {duties.map(d => <li key={d}>
        <div className="eq-duty-head"><strong>{DUTY_LABELS[d]}</strong><span className="badge">{DUTY_CLAUSES[d]}</span></div>
        <p className="muted">{DUTY_HINTS[d]}</p>
      </li>)}
    </ul>
  </div>;
}

export function EquipmentPage() {
  const { can } = usePermissions();
  const { isEnabled } = useModules();
  const { staff, sections, locations } = useLookups();
  const [departments, setDepartments] = useState<Department[]>([]);
  const [tab, setTab] = useState('Dashboard');
  const [equipment, setEquipment] = useState<EquipmentItem[]>([]);
  // A dashboard alert arrives with ?tab= and ?focus=; the tab bar opens the tab,
  // this scrolls to the record and flashes it.
  useFocusTarget(equipment);
  const [summary, setSummary] = useState<OperationsSummary | null>(null);
  const [selected, setSelected] = useState<EquipmentDetail | null>(null);
  const [nextNumber, setNextNumber] = useState('');
  const [scheduleDueCount, setScheduleDueCount] = useState(0);
  const [openAdverseCount, setOpenAdverseCount] = useState(0);
  const [regBusy, setRegBusy] = useState('');
  const [regResult, setRegResult] = useState<{ created: number; updated: number; totalRows: number; errors: string[] } | null>(null);
  const equipImportRef = useRef<HTMLInputElement>(null);
  const [equipForm, setEquipForm] = useState({ ...emptyEquipForm });
  const [newIfuFile, setNewIfuFile] = useState<File | null>(null);
  const [breakdownForm, setBreakdownForm] = useState({ equipmentId: '', breakdownDate: '', reportedByStaffId: '', description: '', serviceImpact: '', immediateAction: '', equipmentStatus: 'out_of_service', repairAction: '', serviceProvider: '' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bcSize, setBcSize] = useState('m');

  async function load() {
    setLoading(true);
    try {
      const [list, ops] = await Promise.all([
        api<EquipmentItem[]>('/equipment'),
        api<OperationsSummary>('/dashboard/operations-summary').catch(() => null)
      ]);
      setEquipment(list);
      if (ops) setSummary(ops);
      api<Department[]>('/departments').then(setDepartments).catch(() => setDepartments([]));
      api<{ number: string }>('/equipment/config/next-number').then(r => setNextNumber(r.number)).catch(() => setNextNumber(''));
      api<EquipmentSchedule[]>('/equipment/schedules/due').then(r => setScheduleDueCount(r.length)).catch(() => setScheduleDueCount(0));
      api<EquipmentAdverseEvent[]>('/equipment/adverse-events').then(r => setOpenAdverseCount(r.filter(a => a.status !== 'closed').length)).catch(() => setOpenAdverseCount(0));
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }

  useEffect(() => { if (isEnabled('equipment')) void load(); }, [isEnabled]);
  // Suggest the next identifier when opening the New Equipment tab (still editable).
  useEffect(() => {
    if (tab === 'New Equipment' && nextNumber && !equipForm.equipmentNumber) {
      setEquipForm(f => ({ ...f, equipmentNumber: nextNumber }));
    }
  }, [tab, nextNumber]);

  if (!isEnabled('equipment')) return <DisabledModule />;

  // Opening an item shows its full profile on the dedicated tab.
  async function openDetail(id: number) {
    setError(null);
    try { setSelected(await api<EquipmentDetail>(`/equipment/${id}`)); setTab('Equipment Profile'); }
    catch (e) { setError((e as Error).message); }
  }
  async function reloadSelected() {
    if (!selected) return;
    try { setSelected(await api<EquipmentDetail>(`/equipment/${selected.id}`)); await load(); }
    catch (e) { setError((e as Error).message); }
  }

  async function downloadEquipmentRegister(path: string, fallback: string) {
    setError(null); setRegBusy(path);
    try {
      const token = getToken();
      const res = await fetch(`${API_BASE}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : undefined });
      if (!res.ok) throw new Error((await res.json().catch(() => ({ error: res.statusText }))).error ?? res.statusText);
      const blob = await res.blob();
      const m = (res.headers.get('Content-Disposition') || '').match(/filename="?([^"]+)"?/);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = m ? m[1] : fallback; document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch (e) { setError((e as Error).message); }
    finally { setRegBusy(''); }
  }
  async function importEquipmentRegister(file: File) {
    setError(null); setRegResult(null); setRegBusy('import');
    try {
      const fd = new FormData(); fd.append('file', file);
      const token = getToken();
      const res = await fetch(`${API_BASE}/equipment/register/import`, { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : undefined, body: fd });
      const data = await res.json().catch(() => ({ error: res.statusText }));
      if (!res.ok) throw new Error(data.error ?? res.statusText);
      setRegResult(data); await load();
    } catch (e) { setError((e as Error).message); }
    finally { setRegBusy(''); if (equipImportRef.current) equipImportRef.current.value = ''; }
  }

  async function submitEquipment(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const ifuFileId = await uploadEquipFile(newIfuFile);
      await api('/equipment', { method: 'POST', body: JSON.stringify({ ...equipForm, ifuFileId }) });
      setEquipForm({ ...emptyEquipForm }); setNewIfuFile(null);
      await load();
      setTab('Equipment Register');
    } catch (e) { setError((e as Error).message); }
  }

  async function submitBreakdown(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!breakdownForm.equipmentId) return setError('Select an equipment item');
    try {
      await api(`/equipment/${breakdownForm.equipmentId}/breakdown`, { method: 'POST', body: JSON.stringify(breakdownForm) });
      setBreakdownForm({ equipmentId: '', breakdownDate: '', reportedByStaffId: '', description: '', serviceImpact: '', immediateAction: '', equipmentStatus: 'out_of_service', repairAction: '', serviceProvider: '' });
      await load();
    } catch (e) { setError((e as Error).message); }
  }

  async function createBreakdownNc(breakdownId: number) {
    try { await api(`/equipment/breakdowns/${breakdownId}/create-nc`, { method: 'POST', body: JSON.stringify({}) }); if (selected) await openDetail(selected.id); }
    catch (e) { setError((e as Error).message); }
  }
  async function createBreakdownCapa(breakdownId: number) {
    try { await api(`/equipment/breakdowns/${breakdownId}/create-capa`, { method: 'POST', body: JSON.stringify({}) }); if (selected) await openDetail(selected.id); }
    catch (e) { setError((e as Error).message); }
  }
  async function returnToService(breakdownId: number) {
    try { await api(`/equipment/breakdowns/${breakdownId}/return-to-service`, { method: 'POST', body: JSON.stringify({ equipmentStatus: 'operational' }) }); if (selected) await openDetail(selected.id); await load(); }
    catch (e) { setError((e as Error).message); }
  }

  return <div>
    <PageHeader eyebrow="Equipment Management" title="Equipment Management" subtitle="Asset register, maintenance, calibration, and breakdown tracking." />
    {error && <div className="card" style={{ color: 'var(--danger)' }}>{error}</div>}
    {tabBarFor('equipment')(tab, ['Dashboard', 'Equipment Register', 'Equipment Profile', 'New Equipment', 'Verification & Validation', 'Calibration', 'Maintenance Records', 'Scanned Records', 'Breakdowns', 'Adverse Events', 'Training & Competency', 'Equipment Files', 'Reports placeholder'], setTab)}

    {tab === 'Dashboard' && <><ModuleAlerts moduleKey="equipment" /><KpiStrip items={[
      { label: 'Equipment items', value: summary?.equipmentTotal ?? equipment.length, onClick: () => setTab('Equipment Register') },
      { label: 'Maintenance due', value: summary?.equipmentMaintenanceDue, onClick: () => setTab('Maintenance Records') },
      { label: 'Schedules due/overdue', value: scheduleDueCount, tone: scheduleDueCount ? 'warning' : undefined, onClick: () => setTab('Maintenance Records') },
      { label: 'Calibration due', value: summary?.equipmentCalibrationDue, onClick: () => setTab('Calibration') },
      { label: 'Out of service', value: summary?.equipmentOutOfService, tone: 'danger', onClick: () => setTab('Breakdowns') },
      { label: 'Adverse events (open)', value: openAdverseCount, tone: openAdverseCount ? 'danger' : undefined, onClick: () => setTab('Adverse Events') },
    ]} />
    <div className="grid cols-2" style={{ marginTop: 18 }}>
      <ChartCard title="Fleet availability" subtitle="Operational vs out-of-service equipment">
        <DonutChart centerLabel="Assets" data={[
          { label: 'In service', value: Math.max(0, (summary?.equipmentTotal ?? equipment.length) - (summary?.equipmentOutOfService ?? 0)), color: CHART_COLORS[1] },
          { label: 'Out of service', value: summary?.equipmentOutOfService ?? 0, color: CHART_COLORS[3] },
        ]} />
      </ChartCard>
      <ChartCard title="Service schedule" subtitle="Equipment approaching or past due">
        <BarMeter data={[
          { label: 'Maintenance due', value: summary?.equipmentMaintenanceDue, color: CHART_COLORS[0] },
          { label: 'Calibration due', value: summary?.equipmentCalibrationDue, color: CHART_COLORS[2] },
          { label: 'Out of service', value: summary?.equipmentOutOfService, color: CHART_COLORS[3] },
        ]} />
      </ChartCard>
    </div></>}

    {tab === 'Equipment Register' && <div className="card">
      <div className="section-head" style={{ alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0 }}>Equipment register</h3>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span className="muted" style={{ fontSize: 13 }}>Click a row to open its profile.</span>
          {can('equipment', 'export') && <button type="button" className="secondary" disabled={!!regBusy} title="Download the equipment register as an Excel workbook" onClick={() => downloadEquipmentRegister('/equipment/register/export', 'Equipment_Register.xlsx')}>{regBusy === '/equipment/register/export' ? 'Exporting…' : 'Export'}</button>}
          <button type="button" className="secondary" disabled={!!regBusy} title="Upload a completed equipment register workbook" onClick={() => equipImportRef.current?.click()}>{regBusy === 'import' ? 'Importing…' : 'Import'}</button>
          <input ref={equipImportRef} type="file" accept=".xlsx,.xls" style={{ display: 'none' }} onChange={e => { const f = e.target.files?.[0]; if (f) void importEquipmentRegister(f); }} />
          <select value={bcSize} onChange={e => setBcSize(e.target.value)} title="Barcode label size">{LABEL_PRESETS.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}</select>
          {can('equipment', 'print') && <button type="button" className="secondary" title="Print Code 128 barcode asset tags for all equipment" onClick={() => { const p = LABEL_PRESETS.find(x => x.key === bcSize) || LABEL_PRESETS[1]; printLabelSheet(equipment.map(it => ({ barcodeValue: it.equipment_number, title: it.name, lines: [it.equipment_number, it.serial_number ? `S/N ${it.serial_number}` : ''].filter(Boolean) })), { widthMm: p.widthMm, heightMm: p.heightMm, title: 'Equipment barcode labels' }); }}>🏷️ Print barcode labels</button>}
        </div>
      </div>
      <div style={{ margin: '4px 0 10px' }}>
        <BarcodeScanner placeholder="Scan an equipment barcode to open it…" autoFocus={false} onScan={code => { const m = equipment.find(e => e.equipment_number?.toLowerCase() === code.trim().toLowerCase()); if (m) openDetail(m.id); else setError(`No equipment found for barcode "${code}".`); }} />
      </div>
      {regResult && <div className="success-msg" style={{ marginTop: 8 }}><strong>{regResult.created}</strong> created, <strong>{regResult.updated}</strong> updated ({regResult.totalRows} rows).{regResult.errors.length > 0 && <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>{regResult.errors.slice(0, 8).map((er, i) => <li key={i} style={{ fontSize: 12 }}>{er}</li>)}</ul>}</div>}
      {loading ? <p>Loading…</p> : equipment.length === 0 ? <p>No equipment items have been recorded yet.</p> :
        <div style={{ overflowX: 'auto' }}>
        <table className="table"><thead><tr><th>Identifier</th><th>Name</th><th>Serial no.</th><th>Model</th><th>Manufacturer</th><th>Supplier</th><th>Country</th><th>Condition</th><th>Received</th><th>In service</th><th>Location</th><th>Out of service</th><th>Status</th></tr></thead><tbody>
          {equipment.map(item => <tr key={item.id} {...focusAttr('equipment_items', item.id)} className="row-clickable" style={{ cursor: 'pointer' }} onClick={() => openDetail(item.id)} title="Open equipment profile">
            <td>{item.equipment_number}</td><td>{item.name}</td><td>{item.serial_number || '—'}</td><td>{item.model || '—'}</td><td>{item.manufacturer || '—'}</td>
            <td>{item.supplier_name || '—'}</td><td>{item.country_of_origin || '—'}</td><td>{item.condition_received || '—'}</td>
            <td>{item.date_received || '—'}</td><td>{item.date_commissioned || '—'}</td>
            <td>{sections.find(s => s.id === item.section_id)?.name || '—'}</td>
            <td>{item.date_out_of_service || '—'}</td><td>{formatBadge(item.status)}</td>
          </tr>)}
        </tbody></table>
        </div>}
    </div>}

    {tab === 'Equipment Profile' && (selected
      ? <EquipmentProfile item={selected} staff={staff} sections={sections} departments={departments} locations={locations}
          onBack={() => setTab('Equipment Register')} onSaved={reloadSelected}
          createBreakdownNc={createBreakdownNc} createBreakdownCapa={createBreakdownCapa} returnToService={returnToService} setError={setError} />
      : <div className="card"><p>Open an item from the <button type="button" className="linklike" onClick={() => setTab('Equipment Register')}>Equipment Register</button> to view its complete profile.</p></div>)}

    {tab === 'New Equipment' && <div className="card">
      <h3>New equipment</h3>
      <form className="form" onSubmit={submitEquipment}>
        <label>Unique identifier<input value={equipForm.equipmentNumber} onChange={e => setEquipForm({ ...equipForm, equipmentNumber: e.target.value })} placeholder={nextNumber || 'auto'} /><small className="muted">Follows the configured pattern; edit only for items with their own identifier.</small></label>
        <label>Name<input value={equipForm.name} onChange={e => setEquipForm({ ...equipForm, name: e.target.value })} required /></label>
        <label>Category<input value={equipForm.category} onChange={e => setEquipForm({ ...equipForm, category: e.target.value })} /></label>
        <label>Equipment category<select value={equipForm.equipmentCategory} onChange={e => setEquipForm({ ...equipForm, equipmentCategory: e.target.value })}>
          {EQUIPMENT_CATEGORIES.map(c => <option key={c} value={c}>{EQUIPMENT_CATEGORY_LABELS[c]}</option>)}
        </select><small className="muted">{EQUIPMENT_CATEGORY_HINTS[equipForm.equipmentCategory as never] ?? ''} <em>e.g. {EQUIPMENT_CATEGORY_EXAMPLES[equipForm.equipmentCategory as never] ?? ''}</em></small></label>
        <label>Equipment type<input value={equipForm.equipmentType} onChange={e => setEquipForm({ ...equipForm, equipmentType: e.target.value })} /></label>
        <label>Manufacturer<input value={equipForm.manufacturer} onChange={e => setEquipForm({ ...equipForm, manufacturer: e.target.value })} /></label>
        <label>Model<input value={equipForm.model} onChange={e => setEquipForm({ ...equipForm, model: e.target.value })} /></label>
        <label>Serial number<input value={equipForm.serialNumber} onChange={e => setEquipForm({ ...equipForm, serialNumber: e.target.value })} /></label>
        <label>Country of origin<input value={equipForm.countryOfOrigin} onChange={e => setEquipForm({ ...equipForm, countryOfOrigin: e.target.value })} /></label>
        <label>Condition received<select value={equipForm.conditionReceived} onChange={e => setEquipForm({ ...equipForm, conditionReceived: e.target.value })}><option value="">—</option>{CONDITION_OPTIONS.map(c => <option key={c} value={c}>{c}</option>)}</select></label>
        <label>Criticality<select value={equipForm.criticality} onChange={e => setEquipForm({ ...equipForm, criticality: e.target.value })}><option value="">—</option>{CRITICALITY_OPTIONS.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}</select></label>
        <label>Supplier name<input value={equipForm.supplierName} onChange={e => setEquipForm({ ...equipForm, supplierName: e.target.value })} /></label>
        <label>Supplier location<input value={equipForm.supplierLocation} onChange={e => setEquipForm({ ...equipForm, supplierLocation: e.target.value })} /></label>
        <label>Supplier contact<input value={equipForm.supplierContact} onChange={e => setEquipForm({ ...equipForm, supplierContact: e.target.value })} placeholder="phone / email" /></label>
        <label>Department<select value={equipForm.departmentId} onChange={e => setEquipForm({ ...equipForm, departmentId: e.target.value })}><option value="">Select department</option>{departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
        <label>Section (location)<select value={equipForm.sectionId} onChange={e => setEquipForm({ ...equipForm, sectionId: e.target.value })}><option value="">Select section</option>{sections.filter(s => !equipForm.departmentId || String(s.department_id) === equipForm.departmentId).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select><small className="muted">The equipment's location is the section it belongs to.</small></label>
        <label>Custodian (responsible staff)<select value={equipForm.responsibleStaffId} onChange={e => setEquipForm({ ...equipForm, responsibleStaffId: e.target.value })}><option value="">Select staff</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
        <label>Status<select value={equipForm.status} onChange={e => setEquipForm({ ...equipForm, status: e.target.value })}>{['active', 'operational', 'out_of_service', 'under_repair', 'restricted_use', 'retired'].map(s => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}</select></label>
        <label>Date received<input type="date" value={equipForm.dateReceived} onChange={e => setEquipForm({ ...equipForm, dateReceived: e.target.value })} /></label>
        <label>Date of entry into service<input type="date" value={equipForm.dateInService} onChange={e => setEquipForm({ ...equipForm, dateInService: e.target.value })} /></label>
        <label>Date out of service<input type="date" value={equipForm.dateOutOfService} onChange={e => setEquipForm({ ...equipForm, dateOutOfService: e.target.value })} /></label>
        <label>Maintenance frequency<input value={equipForm.maintenanceFrequency} onChange={e => setEquipForm({ ...equipForm, maintenanceFrequency: e.target.value })} placeholder="e.g. monthly" /></label>
        <label>Next maintenance due<input type="date" value={equipForm.nextMaintenanceDue} onChange={e => setEquipForm({ ...equipForm, nextMaintenanceDue: e.target.value })} /></label>
        <label>Calibration frequency<input value={equipForm.calibrationFrequency} onChange={e => setEquipForm({ ...equipForm, calibrationFrequency: e.target.value })} /></label>
        <label>Next calibration due<input type="date" value={equipForm.nextCalibrationDue} onChange={e => setEquipForm({ ...equipForm, nextCalibrationDue: e.target.value })} /></label>
        <label><input type="checkbox" checked={equipForm.calibrationRequired} onChange={e => setEquipForm({ ...equipForm, calibrationRequired: e.target.checked })} /> Calibration required</label>
        <label>Manufacturer's instructions / IFU<input type="file" onChange={e => setNewIfuFile(e.target.files?.[0] ?? null)} /><small className="muted">Attached to the profile as the manufacturer's manual.</small></label>
        <label>Notes<textarea value={equipForm.notes} onChange={e => setEquipForm({ ...equipForm, notes: e.target.value })} /></label>
        <button type="submit">Save equipment</button>
      </form>
    </div>}

    {tab === 'Verification & Validation' && <EquipmentLifecycleTab kind="verification" equipment={equipment} staff={staff} setError={setError} onChanged={reloadSelected} />}

    {tab === 'Calibration' && <><EquipmentLifecycleTab kind="calibration" equipment={equipment} staff={staff} setError={setError} onChanged={reloadSelected} /><ReferenceStandardsPanel staff={staff} setError={setError} /></>}

    {tab === 'Maintenance Records' && <EquipmentMaintenanceTab equipment={equipment} staff={staff} sections={sections} setError={setError} onChanged={() => { void load(); void reloadSelected(); }} />}

    {tab === 'Scanned Records' && <ScannedRecordUpload moduleKey="equipment" sections={sections} equipment={equipment.map(e => ({ id: e.id, name: `${e.equipment_number} — ${e.name}` }))} defaultEquipmentId={selected?.id}
      heading="Scanned maintenance logs & legacy equipment records"
      blurb="Upload scanned maintenance logs, service reports and historical paper records for equipment as evidence the work was done. State whether the log covers weekly or monthly checks, and flag any out-of-range/failed check — a nonconformity is raised automatically so it is followed up."
      categories={[
        { value: 'maintenance_log', label: 'Maintenance / service log' },
        { value: 'service_report', label: 'Service / engineer report' },
        { value: 'calibration_certificate', label: 'Calibration certificate' },
        { value: 'temperature_log', label: 'Temperature log (fridge/freezer)' },
        { value: 'legacy_record', label: 'Legacy / historical record' },
        { value: 'other', label: 'Other' },
      ]} />}

    {tab === 'Breakdowns' && <div className="card">
      <h3>Report breakdown</h3>
      <form className="form" onSubmit={submitBreakdown}>
        <label>Equipment<select value={breakdownForm.equipmentId} onChange={e => setBreakdownForm({ ...breakdownForm, equipmentId: e.target.value })} required><option value="">Select equipment</option>{equipment.map(e2 => <option key={e2.id} value={e2.id}>{e2.equipment_number} — {e2.name}</option>)}</select></label>
        <label>Breakdown date<input type="date" value={breakdownForm.breakdownDate} onChange={e => setBreakdownForm({ ...breakdownForm, breakdownDate: e.target.value })} required /></label>
        <label>Reported by<select value={breakdownForm.reportedByStaffId} onChange={e => setBreakdownForm({ ...breakdownForm, reportedByStaffId: e.target.value })}><option value="">Select staff</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
        <label>Description<textarea value={breakdownForm.description} onChange={e => setBreakdownForm({ ...breakdownForm, description: e.target.value })} required /></label>
        <label>Service impact<input value={breakdownForm.serviceImpact} onChange={e => setBreakdownForm({ ...breakdownForm, serviceImpact: e.target.value })} /></label>
        <label>Immediate action<textarea value={breakdownForm.immediateAction} onChange={e => setBreakdownForm({ ...breakdownForm, immediateAction: e.target.value })} /></label>
        <label>Equipment status<select value={breakdownForm.equipmentStatus} onChange={e => setBreakdownForm({ ...breakdownForm, equipmentStatus: e.target.value })}>{['out_of_service', 'under_repair', 'restricted_use'].map(s => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}</select></label>
        <label>Repair action<textarea value={breakdownForm.repairAction} onChange={e => setBreakdownForm({ ...breakdownForm, repairAction: e.target.value })} /></label>
        <label>Service provider<input value={breakdownForm.serviceProvider} onChange={e => setBreakdownForm({ ...breakdownForm, serviceProvider: e.target.value })} /></label>
        <button type="submit">Report breakdown</button>
      </form>
    </div>}

    {tab === 'Adverse Events' && <EquipmentAdverseEventsTab equipment={equipment} staff={staff} setError={setError} onChanged={() => { void load(); void reloadSelected(); }} />}

    {tab === 'Training & Competency' && <EquipmentCompetencyTab equipment={equipment} staff={staff} setError={setError} onChanged={() => { void reloadSelected(); }} />}

    {tab === 'Equipment Files' && <EquipmentFilesTab equipment={equipment} sections={sections} departments={departments} setError={setError} onChanged={() => { void reloadSelected(); }} />}

    {tab === 'Reports placeholder' && <div className="card"><p>Reporting and exports for equipment will be added in a later phase.</p></div>}
  </div>;
}

type ProfileProps = {
  item: EquipmentDetail; staff: Staff[]; sections: Section[]; departments: Department[]; locations: Location[];
  onBack: () => void; onSaved: () => void; setError: (m: string | null) => void;
  createBreakdownNc: (id: number) => void; createBreakdownCapa: (id: number) => void; returnToService: (id: number) => void;
};

function EquipmentProfile({ item, staff, sections, departments, locations, onBack, onSaved, setError, createBreakdownNc, createBreakdownCapa, returnToService }: ProfileProps) {
  const { can } = usePermissions();
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showLabel, setShowLabel] = useState(false);
  const [showDecommission, setShowDecommission] = useState(false);
  const [ifuFile, setIfuFile] = useState<File | null>(null);
  const emptyDecom = { decommissionedAt: new Date().toISOString().slice(0, 10), decommissionedByStaffId: '', decommissionReason: '', decontaminationConfirmed: false, decontaminationMethod: '', decontaminationConfirmedByStaffId: '', disposalMethod: '', disposalDate: '', disposalReference: '' };
  const [decomForm, setDecomForm] = useState(emptyDecom);
  const [decomFile, setDecomFile] = useState<File | null>(null);
  const [labelSize, setLabelSize] = useState(LABEL_SIZES[1].key);
  const [labelFields, setLabelFields] = useState<string[]>(['identifier', 'name', 'serial', 'nextCalibration']);
  const toForm = (it: EquipmentItem) => ({
    equipmentNumber: it.equipment_number ?? '', name: it.name ?? '', category: it.category ?? '', equipmentClass: it.equipment_class ?? 'laboratory', equipmentCategory: it.equipment_category ?? categoryFromLegacy(it.equipment_class, it.name, it.category), equipmentType: it.equipment_type ?? '',
    manufacturer: it.manufacturer ?? '', model: it.model ?? '', serialNumber: it.serial_number ?? '',
    supplierName: it.supplier_name ?? '', supplierLocation: it.supplier_location ?? '', supplierContact: it.supplier_contact ?? '',
    countryOfOrigin: it.country_of_origin ?? '', conditionReceived: it.condition_received ?? '', criticality: it.criticality ?? '',
    departmentId: it.department_id ? String(it.department_id) : '', sectionId: it.section_id ? String(it.section_id) : '', locationId: it.location_id ? String(it.location_id) : '',
    responsibleStaffId: (it.responsible_staff_id ?? it.assigned_to_staff_id) ? String(it.responsible_staff_id ?? it.assigned_to_staff_id) : '',
    status: it.status ?? 'operational', dateReceived: it.date_received ?? '', dateInService: it.date_commissioned ?? '', dateOutOfService: it.date_out_of_service ?? '',
    maintenanceFrequency: it.maintenance_frequency ?? '', nextMaintenanceDue: it.next_maintenance_due ?? it.next_service_due ?? '',
    calibrationFrequency: it.calibration_frequency ?? '', nextCalibrationDue: it.next_calibration_due ?? it.calibration_due_date ?? '',
    calibrationRequired: !!it.calibration_required, notes: it.notes ?? '',
  });
  const [form, setForm] = useState(toForm(item));
  useEffect(() => { setForm(toForm(item)); setEditing(false); }, [item.id]);

  const deptName = departments.find(d => d.id === item.department_id)?.name || '—';
  const secName = sections.find(s => s.id === item.section_id)?.name || '—';
  // Per lab convention, the equipment's location is its section.
  const locName = sections.find(s => s.id === item.section_id)?.name || '—';
  const custodian = staffName(staff, item.responsible_staff_id || item.assigned_to_staff_id);

  async function save() {
    setSaving(true); setError(null);
    try {
      const payload: any = { ...form };
      if (ifuFile) payload.ifuFileId = await uploadEquipFile(ifuFile);
      await api(`/equipment/${item.id}`, { method: 'PUT', body: JSON.stringify(payload) });
      setIfuFile(null); onSaved(); setEditing(false);
    } catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  }
  async function submitDecommission() {
    if (!decomForm.decontaminationConfirmed) { setError('Confirm decontamination before decommissioning.'); return; }
    setSaving(true); setError(null);
    try {
      const disposalEvidenceFileId = await uploadEquipFile(decomFile);
      await api(`/equipment/${item.id}/decommission`, { method: 'POST', body: JSON.stringify({ ...decomForm, disposalEvidenceFileId }) });
      setDecomForm(emptyDecom); setDecomFile(null); setShowDecommission(false); onSaved();
    } catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  }

  function printProfile() {
    const row = (l: string, v: unknown) => `<div><span>${esc(l)}</span><span>${esc(v && String(v).trim() ? v : '—')}</span></div>`;
    const maint = item.maintenance?.length
      ? `<table><thead><tr><th>Date</th><th>Type</th><th>Performed by</th><th>Findings</th><th>Next due</th><th>Status</th></tr></thead><tbody>${item.maintenance.map(m => `<tr><td>${esc(m.maintenance_date)}</td><td>${esc(m.maintenance_type)}</td><td>${esc(staffName(staff, m.performed_by_staff_id))}</td><td>${esc(m.findings || '—')}</td><td>${esc(m.next_due_date || '—')}</td><td>${esc(m.status)}</td></tr>`).join('')}</tbody></table>`
      : '<p>No maintenance recorded.</p>';
    const bd = item.breakdowns?.length
      ? `<table><thead><tr><th>Date</th><th>Description</th><th>Status</th><th>NC</th><th>CAPA</th></tr></thead><tbody>${item.breakdowns.map(b => `<tr><td>${esc(b.breakdown_date)}</td><td>${esc(b.description)}</td><td>${esc(b.status)}</td><td>${esc(b.nc_id || '—')}</td><td>${esc(b.capa_id || '—')}</td></tr>`).join('')}</tbody></table>`
      : '<p>No breakdowns recorded.</p>';
    const body = `
      <h1>${esc(item.name)}</h1>
      <div class="meta">Equipment identifier <strong>${esc(item.equipment_number)}</strong> · printed ${esc(new Date().toLocaleString())}</div>
      <h2>Identity</h2><div class="kv">
        ${row('Unique identifier', item.equipment_number)}${row('Name', item.name)}${row('Category', item.category)}${row('Type', item.equipment_type)}
        ${row('Manufacturer', item.manufacturer)}${row('Model', item.model)}${row('Serial number', item.serial_number)}${row('Country of origin', item.country_of_origin)}
        ${row('Condition received', item.condition_received)}${row('Criticality', item.criticality)}</div>
      <h2>Supplier</h2><div class="kv">${row('Name', item.supplier_name)}${row('Location', item.supplier_location)}${row('Contact', item.supplier_contact)}</div>
      <h2>Placement &amp; responsibility</h2><div class="kv">${row('Department', deptName)}${row('Section', secName)}${row('Location', locName)}${row('Custodian', custodian)}${row('Status', item.status)}</div>
      <h2>Lifecycle</h2><div class="kv">${row('Date received', item.date_received)}${row('Date into service', item.date_commissioned)}${row('Date out of service', item.date_out_of_service)}</div>
      <h2>Service &amp; calibration</h2><div class="kv">${row('Maintenance frequency', item.maintenance_frequency)}${row('Next maintenance', item.next_maintenance_due || item.next_service_due)}${row('Calibration required', item.calibration_required ? 'Yes' : 'No')}${row('Calibration frequency', item.calibration_frequency)}${row('Next calibration', item.next_calibration_due || item.calibration_due_date)}</div>
      ${item.notes ? `<h2>Notes</h2><p>${esc(item.notes)}</p>` : ''}
      <h2>Maintenance history</h2>${maint}
      <h2>Malfunctions &amp; repairs</h2>${bd}`;
    printHtml(`Equipment profile — ${item.equipment_number}`, body);
  }

  function printLabel() {
    const size = LABEL_SIZES.find(s => s.key === labelSize) || LABEL_SIZES[1];
    const val: Record<string, string> = {
      identifier: item.equipment_number, name: item.name, serial: item.serial_number || '', model: item.model || '',
      manufacturer: item.manufacturer || '', location: locName, custodian, nextCalibration: item.next_calibration_due || item.calibration_due_date || '', nextMaintenance: item.next_maintenance_due || item.next_service_due || '',
    };
    const lines = LABEL_FIELDS.filter(f => labelFields.includes(f.key)).map(f => {
      const isId = f.key === 'identifier';
      return `<div class="line ${isId ? 'idline' : ''}"><span class="lbl">${esc(f.label)}</span><span class="v">${esc(val[f.key] || '—')}</span></div>`;
    }).join('');
    const barcode = code128Svg(item.equipment_number, { moduleWidth: size.w < 60 ? 1 : 2, height: size.w < 60 ? 26 : 34, fontSize: size.w < 60 ? 8 : 10, quietZone: 6 });
    const css = `
      .label { width: ${size.w}mm; height: ${size.h}mm; border: 1px solid #111; padding: 3mm; overflow: hidden; page-break-after: always; }
      .label .bc { text-align:center; line-height:0; margin-bottom: 1mm; } .label .bc svg { max-width: 100%; height: auto; }
      .label .line { display: flex; justify-content: space-between; gap: 4mm; font-size: ${size.w < 60 ? 8 : 10}px; padding: 0.6mm 0; border-bottom: 0.2mm dotted #bbb; }
      .label .lbl { color: #444; text-transform: uppercase; letter-spacing: .04em; } .label .v { font-weight: 700; text-align: right; }
      .label .idline .v { font-size: ${size.w < 60 ? 11 : 14}px; }
      @page { margin: 6mm; } body { margin: 0; }`;
    printHtml(`Label — ${item.equipment_number}`, `<div class="label"><div class="bc">${barcode}</div>${lines}</div>`, css);
  }

  const dv = (l: string, v: string | number | null | undefined) => <div className="kv-row"><span className="kv-k">{l}</span><span className="kv-v">{v != null && String(v).trim() !== '' ? v : '—'}</span></div>;

  return <div className="card">
    <div className="section-head" style={{ alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <div><h3 style={{ margin: 0 }}>{item.name}</h3><div className="muted" style={{ fontSize: 13 }}>{item.equipment_number} · {formatBadge(item.status)}{item.criticality ? <> · <span className="badge">{item.criticality.replace(/_/g, ' ')}</span></> : null}{item.decommissioned ? <> · <span className="badge danger">decommissioned</span></> : null}</div></div>
      <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className="secondary" onClick={onBack}>← Register</button>
        {item.ifu_file_id ? <a className="secondary" href={`${API_BASE}/files/${item.ifu_file_id}/raw`} target="_blank" rel="noreferrer" style={{ padding: '6px 10px', borderRadius: 6, display: 'inline-block' }}>Manufacturer's IFU</a> : null}
        {can('equipment', 'print') && <>
          <button type="button" className="secondary" onClick={printProfile}>Print profile</button>
          <button type="button" className="secondary" onClick={() => setShowLabel(v => !v)}>Print label</button>
        </>}
        {!editing && !item.decommissioned && <button type="button" className="secondary" onClick={() => setShowDecommission(v => !v)}>Decommission</button>}
        {!editing && <button type="button" onClick={() => setEditing(true)}>Edit</button>}
      </div>
    </div>

    {showLabel && <div className="card" style={{ marginTop: 12, background: 'var(--surface-2, #f6f8f9)' }}>
      <h4 style={{ marginTop: 0 }}>Print label</h4>
      <div className="form-grid">
        <label>Label size<select value={labelSize} onChange={e => setLabelSize(e.target.value)}>{LABEL_SIZES.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}</select></label>
      </div>
      <p className="muted" style={{ margin: '8px 0 4px' }}>Components</p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 16px' }}>
        {LABEL_FIELDS.map(f => <label key={f.key} className="check-inline" style={{ fontSize: 13 }}><input type="checkbox" checked={labelFields.includes(f.key)} onChange={e => setLabelFields(prev => e.target.checked ? [...prev, f.key] : prev.filter(k => k !== f.key))} /> {f.label}</label>)}
      </div>
      <div style={{ marginTop: 10 }}><button type="button" onClick={printLabel}>Print label</button></div>
    </div>}

    {showDecommission && !item.decommissioned && <div className="card" style={{ marginTop: 12, background: 'var(--surface-2, #f6f8f9)' }}>
      <h4 style={{ marginTop: 0 }}>Decommission &amp; safe disposal</h4>
      <p className="muted" style={{ marginTop: 0 }}>Confirms decontamination and captures the disposal method. On save the item is retired and the record appears at the top of the profile.</p>
      <div className="form-grid">
        <label>Date decommissioned<input type="date" value={decomForm.decommissionedAt} onChange={e => setDecomForm({ ...decomForm, decommissionedAt: e.target.value })} required /></label>
        <label>Decommissioned by<select value={decomForm.decommissionedByStaffId} onChange={e => setDecomForm({ ...decomForm, decommissionedByStaffId: e.target.value })}><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
        <label style={{ gridColumn: '1 / -1' }}>Reason<textarea value={decomForm.decommissionReason} onChange={e => setDecomForm({ ...decomForm, decommissionReason: e.target.value })} /></label>
        <label className="check-inline" style={{ gridColumn: '1 / -1' }}><input type="checkbox" checked={decomForm.decontaminationConfirmed} onChange={e => setDecomForm({ ...decomForm, decontaminationConfirmed: e.target.checked })} /> Decontamination confirmed</label>
        <label>Decontamination method<input value={decomForm.decontaminationMethod} onChange={e => setDecomForm({ ...decomForm, decontaminationMethod: e.target.value })} placeholder="e.g. 1% NaOCl, autoclave, wipe-down" /></label>
        <label>Confirmed by<select value={decomForm.decontaminationConfirmedByStaffId} onChange={e => setDecomForm({ ...decomForm, decontaminationConfirmedByStaffId: e.target.value })}><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
        <label>Disposal method<input value={decomForm.disposalMethod} onChange={e => setDecomForm({ ...decomForm, disposalMethod: e.target.value })} placeholder="e.g. e-waste vendor, returned to supplier" /></label>
        <label>Disposal date<input type="date" value={decomForm.disposalDate} onChange={e => setDecomForm({ ...decomForm, disposalDate: e.target.value })} /></label>
        <label>Disposal reference<input value={decomForm.disposalReference} onChange={e => setDecomForm({ ...decomForm, disposalReference: e.target.value })} placeholder="Certificate / waybill no." /></label>
        <label>Evidence<input type="file" onChange={e => setDecomFile(e.target.files?.[0] ?? null)} /></label>
      </div>
      <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
        <button type="button" onClick={submitDecommission} disabled={saving || !decomForm.decontaminationConfirmed}>{saving ? 'Saving…' : 'Decommission item'}</button>
        <button type="button" className="secondary" onClick={() => { setShowDecommission(false); setDecomForm(emptyDecom); setDecomFile(null); }}>Cancel</button>
      </div>
    </div>}

    {item.decommissioned ? <div className="card" style={{ marginTop: 12, borderLeft: '3px solid var(--crit, #a63d34)' }}>
      <h4 style={{ marginTop: 0 }}>Decommissioned &amp; disposed</h4>
      <div className="profile-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14 }}>
        <div>{dv('Decommissioned on', item.decommissioned_at)}{dv('By', staffName(staff, item.decommissioned_by_staff_id))}{dv('Reason', item.decommission_reason)}</div>
        <div>{dv('Decontamination confirmed', item.decontamination_confirmed ? 'Yes' : 'No')}{dv('Method', item.decontamination_method)}{dv('Confirmed by', staffName(staff, item.decontamination_confirmed_by_staff_id))}</div>
        <div>{dv('Disposal method', item.disposal_method)}{dv('Disposal date', item.disposal_date)}{dv('Reference', item.disposal_reference)}{item.disposal_evidence_file_id ? <div className="kv-row"><span className="kv-k">Evidence</span><span className="kv-v"><a href={`${API_BASE}/files/${item.disposal_evidence_file_id}/raw`} target="_blank" rel="noreferrer">open</a></span></div> : null}</div>
      </div>
    </div> : null}

    {editing
      ? <form className="form" style={{ marginTop: 14 }} onSubmit={e => { e.preventDefault(); void save(); }}>
          <label>Unique identifier<input value={form.equipmentNumber} onChange={e => setForm({ ...form, equipmentNumber: e.target.value })} /></label>
          <label>Name<input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required /></label>
          <label>Category<input value={form.category} onChange={e => setForm({ ...form, category: e.target.value })} /></label>
          <label>Equipment type<input value={form.equipmentType} onChange={e => setForm({ ...form, equipmentType: e.target.value })} /></label>
          <label>Manufacturer<input value={form.manufacturer} onChange={e => setForm({ ...form, manufacturer: e.target.value })} /></label>
          <label>Model<input value={form.model} onChange={e => setForm({ ...form, model: e.target.value })} /></label>
          <label>Serial number<input value={form.serialNumber} onChange={e => setForm({ ...form, serialNumber: e.target.value })} /></label>
          <label>Country of origin<input value={form.countryOfOrigin} onChange={e => setForm({ ...form, countryOfOrigin: e.target.value })} /></label>
          <label>Condition received<select value={form.conditionReceived} onChange={e => setForm({ ...form, conditionReceived: e.target.value })}><option value="">—</option>{CONDITION_OPTIONS.map(c => <option key={c} value={c}>{c}</option>)}</select></label>
          <label>Criticality<select value={form.criticality} onChange={e => setForm({ ...form, criticality: e.target.value })}><option value="">—</option>{CRITICALITY_OPTIONS.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}</select></label>
          <label>Supplier name<input value={form.supplierName} onChange={e => setForm({ ...form, supplierName: e.target.value })} /></label>
          <label>Supplier location<input value={form.supplierLocation} onChange={e => setForm({ ...form, supplierLocation: e.target.value })} /></label>
          <label>Supplier contact<input value={form.supplierContact} onChange={e => setForm({ ...form, supplierContact: e.target.value })} /></label>
          <label>Department<select value={form.departmentId} onChange={e => setForm({ ...form, departmentId: e.target.value })}><option value="">—</option>{departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
          <label>Section (location)<select value={form.sectionId} onChange={e => setForm({ ...form, sectionId: e.target.value })}><option value="">—</option>{sections.filter(s => !form.departmentId || String(s.department_id) === form.departmentId).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
          <label>Custodian<select value={form.responsibleStaffId} onChange={e => setForm({ ...form, responsibleStaffId: e.target.value })}><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
          <label>Status<select value={form.status} onChange={e => setForm({ ...form, status: e.target.value })}>{['active', 'operational', 'out_of_service', 'under_repair', 'restricted_use', 'retired'].map(s => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}</select></label>
          <label>Date received<input type="date" value={form.dateReceived} onChange={e => setForm({ ...form, dateReceived: e.target.value })} /></label>
          <label>Date into service<input type="date" value={form.dateInService} onChange={e => setForm({ ...form, dateInService: e.target.value })} /></label>
          <label>Date out of service<input type="date" value={form.dateOutOfService} onChange={e => setForm({ ...form, dateOutOfService: e.target.value })} /></label>
          <label>Maintenance frequency<input value={form.maintenanceFrequency} onChange={e => setForm({ ...form, maintenanceFrequency: e.target.value })} /></label>
          <label>Next maintenance due<input type="date" value={form.nextMaintenanceDue} onChange={e => setForm({ ...form, nextMaintenanceDue: e.target.value })} /></label>
          <label>Calibration frequency<input value={form.calibrationFrequency} onChange={e => setForm({ ...form, calibrationFrequency: e.target.value })} /></label>
          <label>Next calibration due<input type="date" value={form.nextCalibrationDue} onChange={e => setForm({ ...form, nextCalibrationDue: e.target.value })} /></label>
          <label className="check-inline"><input type="checkbox" checked={form.calibrationRequired} onChange={e => setForm({ ...form, calibrationRequired: e.target.checked })} /> Calibration required</label>
          <label>Notes<textarea value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} /></label>
          <label>Manufacturer's IFU {item.ifu_file_id ? <>· <a href={`${API_BASE}/files/${item.ifu_file_id}/raw`} target="_blank" rel="noreferrer">current</a></> : null}<input type="file" onChange={e => setIfuFile(e.target.files?.[0] ?? null)} /><small className="muted">Upload to replace the current IFU.</small></label>
          <div style={{ display: 'flex', gap: 8 }}><button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save changes'}</button><button type="button" className="secondary" onClick={() => { setForm(toForm(item)); setEditing(false); }}>Cancel</button></div>
        </form>
      : <>
        <div className="profile-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 18, marginTop: 14 }}>
          <div><h4>Identity</h4>{dv('Unique identifier', item.equipment_number)}{dv('Category', item.category)}{dv('Equipment category', EQUIPMENT_CATEGORY_LABELS[(item.equipment_category ?? categoryFromLegacy(item.equipment_class, item.name, item.category)) as never])}{dv('Type', item.equipment_type)}{dv('Manufacturer', item.manufacturer)}{dv('Model', item.model)}{dv('Serial number', item.serial_number)}{dv('Country of origin', item.country_of_origin)}{dv('Condition received', item.condition_received)}{dv('Criticality', item.criticality?.replace(/_/g, ' '))}</div>
          <div><h4>Supplier</h4>{dv('Name', item.supplier_name)}{dv('Location', item.supplier_location)}{dv('Contact', item.supplier_contact)}
            <h4 style={{ marginTop: 16 }}>Placement</h4>{dv('Department', deptName)}{dv('Section', secName)}{dv('Location', locName)}{dv('Custodian', custodian)}</div>
          <div><h4>Lifecycle</h4>{dv('Date received', item.date_received)}{dv('Date into service', item.date_commissioned)}{dv('Date out of service', item.date_out_of_service)}
            <h4 style={{ marginTop: 16 }}>Service &amp; calibration</h4>{dv('Maintenance frequency', item.maintenance_frequency)}{dv('Next maintenance', item.next_maintenance_due || item.next_service_due)}{dv('Calibration required', item.calibration_required ? 'Yes' : 'No')}{dv('Calibration frequency', item.calibration_frequency)}{dv('Next calibration', item.next_calibration_due || item.calibration_due_date)}</div>
        </div>
        <EquipmentDuties item={item} />
        {item.notes && <><h4>Notes</h4><p className="muted">{item.notes}</p></>}
      </>}

    <h4 style={{ marginTop: 22 }}>Maintenance &amp; servicing schedules</h4>
    {!item.schedules?.length ? <p className="muted">No schedules set.</p> : <table className="table"><thead><tr><th>Type</th><th>Frequency</th><th>Provider</th><th>Last done</th><th>Next due</th><th>Active</th></tr></thead><tbody>
      {item.schedules.map(s => { const overdue = s.next_due_date && s.next_due_date < new Date().toISOString().slice(0, 10); return <tr key={s.id}><td>{(s.schedule_type || '').replace(/_/g, ' ')}</td><td>{s.frequency}{s.frequency === 'custom' && s.interval_days ? ` (${s.interval_days}d)` : ''}</td><td>{s.provider_name || (s.provider_type ? s.provider_type : '—')}</td><td>{s.last_done_date || '—'}</td><td>{s.next_due_date || '—'}{overdue && s.is_active ? <span className="badge danger">overdue</span> : null}</td><td>{s.is_active ? '✓' : '—'}</td></tr>; })}
    </tbody></table>}
    <h4 style={{ marginTop: 22 }}>Maintenance history</h4>
    {!item.maintenance?.length ? <p className="muted">No maintenance recorded.</p> : <table className="table"><thead><tr><th>Date</th><th>Type</th><th>Performed by</th><th>Findings</th><th>Next due</th><th>Status</th></tr></thead><tbody>
      {item.maintenance.map(m => <tr key={m.id}><td>{m.maintenance_date}</td><td>{m.maintenance_type}</td><td>{staffName(staff, m.performed_by_staff_id)}</td><td>{m.findings || '—'}</td><td>{m.next_due_date || '—'}</td><td>{formatBadge(m.status)}</td></tr>)}
    </tbody></table>}
    <h4>Malfunctions, repairs &amp; breakdowns</h4>
    {!item.breakdowns?.length ? <p className="muted">No breakdowns recorded.</p> : <table className="table"><thead><tr><th>Date</th><th>Description</th><th>Status</th><th>NC</th><th>CAPA</th><th>Actions</th></tr></thead><tbody>
      {item.breakdowns.map(b => <tr key={b.id}><td>{b.breakdown_date}</td><td>{b.description}</td><td>{formatBadge(b.status)}</td><td>{b.nc_id || '—'}</td><td>{b.capa_id || '—'}</td>
        <td>
          {!b.nc_id && <button type="button" className="secondary" onClick={() => createBreakdownNc(b.id)}>Create NC</button>}{' '}
          {!b.capa_id && <button type="button" className="secondary" onClick={() => createBreakdownCapa(b.id)}>Create CAPA</button>}{' '}
          {b.status !== 'returned_to_service' && b.status !== 'closed' && <button type="button" className="secondary" onClick={() => returnToService(b.id)}>Return to service</button>}
        </td></tr>)}
    </tbody></table>}
    <h4>Adverse events</h4>
    {!item.adverseEvents?.length ? <p className="muted">No adverse events.</p> : <table className="table"><thead><tr><th>No.</th><th>Date</th><th>Type</th><th>Severity</th><th>NC</th><th>CAPA</th><th>Status</th></tr></thead><tbody>
      {item.adverseEvents.map(a => <tr key={a.id}><td>{a.adverse_event_number}</td><td>{a.event_date}</td><td>{adverseTypeLabel(a.event_type)}</td><td>{a.severity ? formatBadge(a.severity) : '—'}</td><td>{a.nc_id || '—'}</td><td>{a.capa_id || '—'}</td><td>{formatBadge(a.status)}</td></tr>)}
    </tbody></table>}
    <h4>Verification &amp; validation</h4>
    {!item.verifications?.length ? <p className="muted">No verification or validation records.</p> : <table className="table"><thead><tr><th>No.</th><th>Type</th><th>Date</th><th>Outcome</th><th>Reviewed</th><th>Status</th></tr></thead><tbody>
      {item.verifications.map(v => <tr key={v.id}><td>{v.verification_number}</td><td>{v.verification_type}</td><td>{v.performed_date}</td><td>{v.outcome ? formatBadge(v.outcome) : '—'}</td><td>{v.review_outcome || '—'}</td><td>{formatBadge(v.status)}</td></tr>)}
    </tbody></table>}
    <h4>Calibration</h4>
    {!item.calibrations?.length ? <p className="muted">No calibration records.</p> : <table className="table"><thead><tr><th>No.</th><th>Date</th><th>Mode</th><th>Result</th><th>Next due</th><th>Status</th></tr></thead><tbody>
      {item.calibrations.map(c => <tr key={c.id}><td>{c.calibration_number}</td><td>{c.calibration_date}</td><td>{c.calibration_mode || '—'}</td><td>{c.result ? formatBadge(c.result) : '—'}</td><td>{c.next_due_date || '—'}</td><td>{formatBadge(c.status)}</td></tr>)}
    </tbody></table>}
    <h4>Trained &amp; competent staff</h4>
    {!item.competencies?.length ? <p className="muted">No trained staff recorded.</p> : <table className="table"><thead><tr><th>Staff</th><th>Assessed</th><th>Outcome</th><th>Authorised</th><th>Personnel records</th></tr></thead><tbody>
      {item.competencies.map(c => <tr key={c.id}><td>{c.staff_name}</td><td>{c.assessment_date || c.training_date || '—'}</td><td>{c.outcome ? formatBadge(c.outcome) : '—'}</td><td>{c.authorized ? `✓ ${c.authorization_level || ''}` : '—'}</td><td>{c.competency_assessment_id ? `COMP #${c.competency_assessment_id}` : '—'}{c.technical_authorization_id ? ` · AUTH #${c.technical_authorization_id}` : ''}</td></tr>)}
    </tbody></table>}
    <h4>Equipment files</h4>
    {!item.documents?.length ? <p className="muted">No documents linked.</p> : <table className="table"><thead><tr><th>Code</th><th>Title</th><th>Type</th><th>Status</th><th>File</th></tr></thead><tbody>
      {item.documents.map(d => <tr key={d.id}><td>{d.document_code || '—'}</td><td>{d.title}</td><td>{d.document_type || '—'}</td><td>{formatBadge(d.status)}</td><td>{d.file_id ? <a href={`${API_BASE}/files/${d.file_id}/raw`} target="_blank" rel="noreferrer">open</a> : '—'}</td></tr>)}
    </tbody></table>}
    <h4>Linked records</h4>
    {!item.links?.length ? <p className="muted">No linked records.</p> : <ul>{item.links.map((l: any) => <li key={l.id}>{l.source_module_key}/{l.source_record_type}#{l.source_record_id} → {l.target_module_key}/{l.target_record_type}#{l.target_record_id}{l.notes ? ` (${l.notes})` : ''}</li>)}</ul>}
  </div>;
}

// Verification/validation and calibration share one workflow: pick an item, run
// an editable checklist with evidence, record structured detail, then review.
function EquipmentLifecycleTab({ kind, equipment, staff, setError, onChanged }: { kind: 'verification' | 'calibration'; equipment: EquipmentItem[]; staff: Staff[]; setError: (m: string | null) => void; onChanged: () => void }) {
  const isVer = kind === 'verification';
  const checklistType = isVer ? 'verification_validation' : 'calibration';
  const recordsPath = isVer ? 'verifications' : 'calibrations';
  const [items, setItems] = useState<EquipmentChecklistItem[]>([]);
  const [equipId, setEquipId] = useState('');
  const [records, setRecords] = useState<any[]>([]);
  const [responses, setResponses] = useState<Record<number, { response: string; notes: string; file: File | null }>>({});
  const [recordFile, setRecordFile] = useState<File | null>(null);
  const [refStandards, setRefStandards] = useState<ReferenceStandard[]>([]);
  const [openRecord, setOpenRecord] = useState<any | null>(null);
  const [busy, setBusy] = useState(false);
  const [showConfig, setShowConfig] = useState(false);
  const [newPrompt, setNewPrompt] = useState('');
  const blankForm = { verificationType: 'verification', performedDate: '', performedByStaffId: '', outcome: '', conclusion: '', calibrationDate: '', calibrationMode: 'internal', provider: '', certificateNumber: '', traceabilityReference: '', referenceStandardId: '', result: '', nextDueDate: '', verifiedBeforeUse: false, notes: '' };
  const [form, setForm] = useState(blankForm);

  function loadItems() { api<EquipmentChecklistItem[]>(`/equipment/checklists/${checklistType}`).then(setItems).catch(() => setItems([])); }
  useEffect(() => { loadItems(); if (!isVer) api<ReferenceStandard[]>('/equipment/reference-standards').then(setRefStandards).catch(() => setRefStandards([])); }, [kind]);
  useEffect(() => { if (equipId) api<any[]>(`/equipment/${equipId}/${recordsPath}`).then(setRecords).catch(() => setRecords([])); else setRecords([]); }, [equipId, kind]);

  function setResp(itemId: number, patch: Partial<{ response: string; notes: string; file: File | null }>) {
    setResponses(prev => ({ ...prev, [itemId]: { response: '', notes: '', file: null, ...prev[itemId], ...patch } }));
  }

  async function submit(e: FormEvent) {
    e.preventDefault(); setError(null);
    if (!equipId) { setError('Select an equipment item.'); return; }
    if (isVer ? !form.performedDate : !form.calibrationDate) { setError('Enter the date.'); return; }
    setBusy(true);
    try {
      const evidenceFileId = await uploadEquipFile(recordFile);
      const responseList = [];
      for (const it of items) {
        const r = responses[it.id];
        const fid = await uploadEquipFile(r?.file ?? null);
        responseList.push({ itemId: it.id, prompt: it.prompt, response: r?.response || null, notes: r?.notes || null, evidenceFileId: fid });
      }
      const payload = isVer
        ? { verificationType: form.verificationType, performedDate: form.performedDate, performedByStaffId: form.performedByStaffId, outcome: form.outcome, conclusion: form.conclusion, notes: form.notes, evidenceFileId, responses: responseList }
        : { calibrationDate: form.calibrationDate, calibrationMode: form.calibrationMode, provider: form.provider, certificateNumber: form.certificateNumber, traceabilityReference: form.traceabilityReference, referenceStandardId: form.referenceStandardId, result: form.result, nextDueDate: form.nextDueDate, verifiedBeforeUse: form.verifiedBeforeUse, performedByStaffId: form.performedByStaffId, notes: form.notes, evidenceFileId, responses: responseList };
      await api(`/equipment/${equipId}/${recordsPath}`, { method: 'POST', body: JSON.stringify(payload) });
      setForm(blankForm); setResponses({}); setRecordFile(null);
      const list = await api<any[]>(`/equipment/${equipId}/${recordsPath}`); setRecords(list);
      onChanged();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  async function openDetail(id: number) {
    try { setOpenRecord(await api<any>(`/equipment/${recordsPath}/${id}`)); }
    catch (e) { setError((e as Error).message); }
  }
  async function review(id: number, outcome: string) {
    try {
      await api(`/equipment/${recordsPath}/${id}/review`, { method: 'POST', body: JSON.stringify({ reviewOutcome: outcome }) });
      const list = await api<any[]>(`/equipment/${equipId}/${recordsPath}`); setRecords(list);
      if (openRecord?.id === id) await openDetail(id);
    } catch (e) { setError((e as Error).message); }
  }
  async function addItem() {
    if (!newPrompt.trim()) return;
    try { await api(`/equipment/checklists/${checklistType}`, { method: 'POST', body: JSON.stringify({ prompt: newPrompt.trim() }) }); setNewPrompt(''); loadItems(); }
    catch (e) { setError((e as Error).message); }
  }
  async function retireItem(it: EquipmentChecklistItem) {
    try { await api(`/equipment/checklists/items/${it.id}`, { method: 'PUT', body: JSON.stringify({ isActive: 0 }) }); loadItems(); }
    catch (e) { setError((e as Error).message); }
  }
  async function saveItemPrompt(it: EquipmentChecklistItem, prompt: string) {
    try { await api(`/equipment/checklists/items/${it.id}`, { method: 'PUT', body: JSON.stringify({ prompt }) }); loadItems(); }
    catch (e) { setError((e as Error).message); }
  }

  return <div className="card">
    <div className="section-head" style={{ alignItems: 'center' }}>
      <h3 style={{ margin: 0 }}>{isVer ? 'Verification & validation' : 'Calibration'}</h3>
      <button type="button" className="secondary" style={{ marginLeft: 'auto' }} onClick={() => setShowConfig(v => !v)}>{showConfig ? 'Done configuring' : 'Configure checklist'}</button>
    </div>
    <p className="muted" style={{ marginTop: 0 }}>{isVer
      ? 'Record verification or validation before use, answering the review checklist and attaching evidence. Records are reviewed and approved by an authorised person.'
      : 'Record calibration (internal or external), capture metrological traceability, answer the review checklist with evidence, and review before the item returns to use.'}</p>

    {showConfig && <div className="card" style={{ background: 'var(--surface-2, #f6f8f9)' }}>
      <h4 style={{ marginTop: 0 }}>Checklist questions</h4>
      <p className="muted" style={{ marginTop: 0 }}>These questions are yours to edit — change the wording, add your own, or retire ones you don't use. They are starter content only.</p>
      <table className="data-table"><thead><tr><th>#</th><th>Question</th><th></th></tr></thead><tbody>
        {items.map((it, i) => <tr key={it.id}>
          <td>{i + 1}</td>
          <td><input defaultValue={it.prompt} style={{ width: '100%' }} onBlur={e => { if (e.target.value.trim() && e.target.value !== it.prompt) saveItemPrompt(it, e.target.value.trim()); }} /></td>
          <td><button type="button" className="secondary" onClick={() => retireItem(it)}>Retire</button></td>
        </tr>)}
        {items.length === 0 && <tr><td colSpan={3} className="muted">No active questions.</td></tr>}
      </tbody></table>
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <input placeholder="Add a question…" value={newPrompt} onChange={e => setNewPrompt(e.target.value)} style={{ flex: 1 }} />
        <button type="button" onClick={addItem}>Add</button>
      </div>
    </div>}

    <form className="form" onSubmit={submit} style={{ marginTop: 12 }}>
      <label>Equipment<select value={equipId} onChange={e => setEquipId(e.target.value)} required><option value="">Select equipment</option>{equipment.map(e2 => <option key={e2.id} value={e2.id}>{e2.equipment_number} — {e2.name}</option>)}</select></label>
      {isVer ? <>
        <label>Type<select value={form.verificationType} onChange={e => setForm({ ...form, verificationType: e.target.value })}><option value="verification">Verification</option><option value="validation">Validation</option></select></label>
        <label>Date performed<input type="date" value={form.performedDate} onChange={e => setForm({ ...form, performedDate: e.target.value })} required /></label>
        <label>Performed by<select value={form.performedByStaffId} onChange={e => setForm({ ...form, performedByStaffId: e.target.value })}><option value="">Select staff</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
        <label>Outcome<select value={form.outcome} onChange={e => setForm({ ...form, outcome: e.target.value })}><option value="">—</option><option value="pass">Pass</option><option value="conditional">Conditional</option><option value="fail">Fail</option></select></label>
        <label>Conclusion<textarea value={form.conclusion} onChange={e => setForm({ ...form, conclusion: e.target.value })} /></label>
      </> : <>
        <label>Calibration date<input type="date" value={form.calibrationDate} onChange={e => setForm({ ...form, calibrationDate: e.target.value })} required /></label>
        <label>Mode<select value={form.calibrationMode} onChange={e => setForm({ ...form, calibrationMode: e.target.value })}><option value="internal">Internal (in-house)</option><option value="external">External (offsite)</option></select></label>
        <label>Provider<input value={form.provider} onChange={e => setForm({ ...form, provider: e.target.value })} placeholder="Calibration provider" /></label>
        <label>Certificate number<input value={form.certificateNumber} onChange={e => setForm({ ...form, certificateNumber: e.target.value })} /></label>
        <label>Traceability reference<input value={form.traceabilityReference} onChange={e => setForm({ ...form, traceabilityReference: e.target.value })} placeholder="e.g. national standard / CRM" /></label>
        <label>Reference standard used<select value={form.referenceStandardId} onChange={e => setForm({ ...form, referenceStandardId: e.target.value })}><option value="">—</option>{refStandards.map(r => <option key={r.id} value={r.id}>{r.reference_number} — {r.name}</option>)}</select></label>
        <label>Result<select value={form.result} onChange={e => setForm({ ...form, result: e.target.value })}><option value="">—</option><option value="pass">Pass</option><option value="fail">Fail</option><option value="adjusted">Adjusted</option></select></label>
        <label>Next calibration due<input type="date" value={form.nextDueDate} onChange={e => setForm({ ...form, nextDueDate: e.target.value })} /></label>
        <label>Performed by<select value={form.performedByStaffId} onChange={e => setForm({ ...form, performedByStaffId: e.target.value })}><option value="">Select staff</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
        <label className="check-inline"><input type="checkbox" checked={form.verifiedBeforeUse} onChange={e => setForm({ ...form, verifiedBeforeUse: e.target.checked })} /> Verified before use (external calibration)</label>
      </>}

      {items.length > 0 && <div style={{ gridColumn: '1 / -1' }}>
        <h4>Review checklist</h4>
        {items.map(it => <div key={it.id} className="checklist-row" style={{ borderTop: '1px solid var(--line, #e7ebed)', padding: '10px 0' }}>
          <div style={{ fontSize: 14, marginBottom: 6 }}>{it.prompt}</div>
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
            <div style={{ display: 'flex', gap: 10 }}>{RESPONSE_OPTIONS.map(o => <label key={o.v} className="check-inline" style={{ fontSize: 13 }}><input type="radio" name={`resp-${kind}-${it.id}`} checked={responses[it.id]?.response === o.v} onChange={() => setResp(it.id, { response: o.v })} /> {o.l}</label>)}</div>
            <input placeholder="Notes" value={responses[it.id]?.notes ?? ''} onChange={e => setResp(it.id, { notes: e.target.value })} style={{ flex: 1, minWidth: 160 }} />
            <label style={{ fontSize: 12 }} className="muted">Evidence <input type="file" onChange={e => setResp(it.id, { file: e.target.files?.[0] ?? null })} /></label>
          </div>
        </div>)}
      </div>}

      <label>Overall evidence / report<input type="file" onChange={e => setRecordFile(e.target.files?.[0] ?? null)} /></label>
      <label>Notes<textarea value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} /></label>
      <button type="submit" disabled={busy}>{busy ? 'Saving…' : `Record ${isVer ? 'verification' : 'calibration'}`}</button>
    </form>

    {equipId && <div style={{ marginTop: 16 }}>
      <h4>Records for this equipment</h4>
      {records.length === 0 ? <p className="muted">No records yet.</p> : <table className="table"><thead><tr><th>No.</th><th>Date</th><th>{isVer ? 'Outcome' : 'Result'}</th><th>Review</th><th>Status</th><th></th></tr></thead><tbody>
        {records.map(r => <tr key={r.id}>
          <td>{r.verification_number || r.calibration_number}</td>
          <td>{r.performed_date || r.calibration_date}</td>
          <td>{(r.outcome || r.result) ? formatBadge(r.outcome || r.result) : '—'}</td>
          <td>{r.review_outcome || '—'}</td>
          <td>{formatBadge(r.status)}</td>
          <td>
            <button type="button" className="secondary" onClick={() => openDetail(r.id)}>Open</button>{' '}
            {r.status !== 'reviewed' && <button type="button" className="secondary" onClick={() => review(r.id, isVer ? 'approved' : 'accepted')}>Review &amp; {isVer ? 'approve' : 'accept'}</button>}
          </td>
        </tr>)}
      </tbody></table>}
    </div>}

    {openRecord && <div className="card" style={{ marginTop: 14, background: 'var(--surface-2, #f6f8f9)' }}>
      <div className="section-head"><h4 style={{ margin: 0 }}>{openRecord.verification_number || openRecord.calibration_number}</h4><button type="button" className="secondary" onClick={() => setOpenRecord(null)}>Close</button></div>
      <table className="table"><thead><tr><th>Question</th><th>Response</th><th>Notes</th><th>Evidence</th></tr></thead><tbody>
        {(openRecord.responses || []).map((r: any) => <tr key={r.id}><td>{r.prompt}</td><td>{r.response ? formatBadge(r.response) : '—'}</td><td>{r.notes || '—'}</td><td>{r.evidence_file_id ? <a href={`${API_BASE}/files/${r.evidence_file_id}/raw`} target="_blank" rel="noreferrer">file</a> : '—'}</td></tr>)}
        {(!openRecord.responses || openRecord.responses.length === 0) && <tr><td colSpan={4} className="muted">No checklist responses recorded.</td></tr>}
      </tbody></table>
    </div>}
  </div>;
}

function ReferenceStandardsPanel({ staff, setError }: { staff: Staff[]; setError: (m: string | null) => void }) {
  const [rows, setRows] = useState<ReferenceStandard[]>([]);
  const blank = { name: '', standardType: 'certified_reference_material', identifier: '', certificateNumber: '', traceableTo: '', validFrom: '', validUntil: '', custodianStaffId: '', notes: '' };
  const [form, setForm] = useState(blank);
  function load() { api<ReferenceStandard[]>('/equipment/reference-standards').then(setRows).catch(() => setRows([])); }
  useEffect(() => { load(); }, []);
  async function submit(e: FormEvent) {
    e.preventDefault(); setError(null);
    if (!form.name) { setError('Enter a name.'); return; }
    try { await api('/equipment/reference-standards', { method: 'POST', body: JSON.stringify(form) }); setForm(blank); load(); }
    catch (e) { setError((e as Error).message); }
  }
  const today = new Date().toISOString().slice(0, 10);
  return <div className="card" style={{ marginTop: 16 }}>
    <h3>Reference standards &amp; certified reference materials</h3>
    <p className="muted" style={{ marginTop: 0 }}>The reference materials and instruments (certified thermometer, tachometer, CRMs) that underpin in-house calibration and metrological traceability.</p>
    <form className="form" onSubmit={submit}>
      <label>Name<input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required /></label>
      <label>Type<select value={form.standardType} onChange={e => setForm({ ...form, standardType: e.target.value })}><option value="certified_reference_material">Certified reference material</option><option value="reference_instrument">Reference instrument</option><option value="other">Other</option></select></label>
      <label>Identifier / serial<input value={form.identifier} onChange={e => setForm({ ...form, identifier: e.target.value })} /></label>
      <label>Certificate number<input value={form.certificateNumber} onChange={e => setForm({ ...form, certificateNumber: e.target.value })} /></label>
      <label>Traceable to<input value={form.traceableTo} onChange={e => setForm({ ...form, traceableTo: e.target.value })} placeholder="e.g. national metrology institute" /></label>
      <label>Valid from<input type="date" value={form.validFrom} onChange={e => setForm({ ...form, validFrom: e.target.value })} /></label>
      <label>Valid until<input type="date" value={form.validUntil} onChange={e => setForm({ ...form, validUntil: e.target.value })} /></label>
      <label>Custodian<select value={form.custodianStaffId} onChange={e => setForm({ ...form, custodianStaffId: e.target.value })}><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
      <button type="submit">Add reference standard</button>
    </form>
    <table className="table" style={{ marginTop: 12 }}><thead><tr><th>No.</th><th>Name</th><th>Type</th><th>Certificate</th><th>Traceable to</th><th>Valid until</th></tr></thead><tbody>
      {rows.map(r => { const expired = r.valid_until && r.valid_until < today; return <tr key={r.id}><td>{r.reference_number}</td><td>{r.name}</td><td>{(r.standard_type || '').replace(/_/g, ' ')}</td><td>{r.certificate_number || '—'}</td><td>{r.traceable_to || '—'}</td><td>{r.valid_until || '—'}{expired && <span className="badge danger">expired</span>}</td></tr>; })}
      {rows.length === 0 && <tr><td colSpan={6} className="muted">No reference standards recorded.</td></tr>}
    </tbody></table>
  </div>;
}

// Maintenance as a programme: a due/overdue worklist, per-equipment schedules
// (routine user PM and provider servicing), and the maintenance log.
function EquipmentMaintenanceTab({ equipment, staff, sections, setError, onChanged }: { equipment: EquipmentItem[]; staff: Staff[]; sections: Section[]; setError: (m: string | null) => void; onChanged: () => void }) {
  const today = new Date().toISOString().slice(0, 10);
  const [due, setDue] = useState<EquipmentSchedule[]>([]);
  const [equipId, setEquipId] = useState('');
  const [schedules, setSchedules] = useState<EquipmentSchedule[]>([]);
  const [records, setRecords] = useState<EquipmentMaintenanceRecord[]>([]);
  const blankSched = { scheduleType: 'preventive_maintenance', frequency: 'monthly', intervalDays: '', providerType: 'internal', providerName: '', responsibleStaffId: '', sectionId: '', taskDescription: '', nextDueDate: '' };
  const [schedForm, setSchedForm] = useState(blankSched);
  const blankMaint = { maintenanceDate: today, maintenanceType: 'preventive', performedByStaffId: '', findings: '', actionTaken: '', nextDueDate: '', status: 'completed', scheduleId: '', serviceProvider: '', providerType: '' };
  const [maintForm, setMaintForm] = useState(blankMaint);
  const [maintFile, setMaintFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);

  function loadDue() { api<EquipmentSchedule[]>('/equipment/schedules/due').then(setDue).catch(() => setDue([])); }
  useEffect(() => { loadDue(); }, []);
  function loadForEquip(id: string) {
    if (!id) { setSchedules([]); setRecords([]); return; }
    api<EquipmentSchedule[]>(`/equipment/${id}/schedules`).then(setSchedules).catch(() => setSchedules([]));
    api<EquipmentMaintenanceRecord[]>(`/equipment/${id}/maintenance`).then(setRecords).catch(() => setRecords([]));
  }
  useEffect(() => { loadForEquip(equipId); }, [equipId]);

  async function addSchedule(e: FormEvent) {
    e.preventDefault(); setError(null);
    if (!equipId) { setError('Select an equipment item first.'); return; }
    try {
      await api(`/equipment/${equipId}/schedules`, { method: 'POST', body: JSON.stringify(schedForm) });
      setSchedForm(blankSched); loadForEquip(equipId); loadDue(); onChanged();
    } catch (e) { setError((e as Error).message); }
  }
  async function toggleSchedule(s: EquipmentSchedule) {
    try { await api(`/equipment/schedules/${s.id}`, { method: 'PUT', body: JSON.stringify({ isActive: s.is_active ? 0 : 1 }) }); loadForEquip(equipId); loadDue(); }
    catch (e) { setError((e as Error).message); }
  }

  async function submitMaintenance(e: FormEvent) {
    e.preventDefault(); setError(null);
    if (!equipId) { setError('Select an equipment item first.'); return; }
    setBusy(true);
    try {
      const evidenceFileId = await uploadEquipFile(maintFile);
      await api(`/equipment/${equipId}/maintenance`, { method: 'POST', body: JSON.stringify({ ...maintForm, evidenceFileId }) });
      setMaintForm(blankMaint); setMaintFile(null); loadForEquip(equipId); loadDue(); onChanged();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  // Quick "done today" against a due schedule, straight from the worklist.
  async function logDue(s: EquipmentSchedule) {
    setError(null);
    try {
      await api(`/equipment/${s.equipment_id}/maintenance`, { method: 'POST', body: JSON.stringify({ maintenanceDate: today, maintenanceType: s.schedule_type === 'servicing' ? 'service' : 'preventive', scheduleId: s.id, status: 'completed', providerType: s.provider_type ?? null, serviceProvider: s.provider_name ?? null }) });
      loadDue(); if (String(s.equipment_id) === equipId) loadForEquip(equipId); onChanged();
    } catch (e) { setError((e as Error).message); }
  }

  return <div>
    <div className="card">
      <div className="section-head" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0 }}>Maintenance records — Excel</h3>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>Export all logged maintenance to Excel, or bulk-import maintenance records from a spreadsheet (rows are matched to equipment by their identifier). Download the template for the exact columns.</p>
      <XlsxToolbar module="equipment" exportPath="/equipment/maintenance/export" templatePath="/equipment/maintenance/template" importPath="/equipment/maintenance/import" exportName="Equipment_Maintenance_Records.xlsx" onImported={() => { loadDue(); if (equipId) loadForEquip(equipId); onChanged(); }} />
    </div>
    <div className="card" style={{ marginTop: 16 }}>
      <h3>Due &amp; overdue</h3>
      <p className="muted" style={{ marginTop: 0 }}>Every routine maintenance and servicing schedule that is due within 30 days or overdue. Log it done in one click.</p>
      {due.length === 0 ? <p className="muted">Nothing due.</p> : <table className="table"><thead><tr><th>Equipment</th><th>Type</th><th>Frequency</th><th>Due</th><th></th></tr></thead><tbody>
        {due.map(s => { const overdue = s.next_due_date && s.next_due_date < today; return <tr key={s.id}>
          <td>{s.equipment_number} — {s.equipment_name}</td>
          <td>{(s.schedule_type || '').replace(/_/g, ' ')}</td>
          <td>{s.frequency}</td>
          <td>{s.next_due_date || '—'} {overdue ? <span className="badge danger">overdue</span> : <span className="badge warning">due soon</span>}</td>
          <td><button type="button" className="secondary" onClick={() => logDue(s)}>Log done today</button></td>
        </tr>; })}
      </tbody></table>}
    </div>

    <div className="card" style={{ marginTop: 16 }}>
      <div className="section-head"><h3 style={{ margin: 0 }}>Equipment</h3>
        <select value={equipId} onChange={e => setEquipId(e.target.value)} style={{ maxWidth: 320 }}><option value="">Select equipment…</option>{equipment.map(e2 => <option key={e2.id} value={e2.id}>{e2.equipment_number} — {e2.name}</option>)}</select>
      </div>
      {!equipId ? <p className="muted">Select an equipment item to manage its schedules and log maintenance.</p> : <>
        <h4>Schedules</h4>
        {schedules.length === 0 ? <p className="muted">No schedules yet — every equipment should carry at least its routine maintenance schedule.</p> : <table className="table"><thead><tr><th>Type</th><th>Frequency</th><th>Provider</th><th>Responsible</th><th>Last done</th><th>Next due</th><th>Active</th><th></th></tr></thead><tbody>
          {schedules.map(s => { const overdue = s.next_due_date && s.next_due_date < today; return <tr key={s.id} {...focusAttr('equipment_schedules', s.id)}>
            <td>{(s.schedule_type || '').replace(/_/g, ' ')}</td>
            <td>{s.frequency}{s.frequency === 'custom' && s.interval_days ? ` (${s.interval_days}d)` : ''}</td>
            <td>{s.provider_name || (s.provider_type || '—')}</td>
            <td>{staffName(staff, s.responsible_staff_id)}</td>
            <td>{s.last_done_date || '—'}</td>
            <td>{s.next_due_date || '—'}{overdue && s.is_active ? <span className="badge danger">overdue</span> : null}</td>
            <td>{s.is_active ? '✓' : '—'}</td>
            <td><button type="button" className="secondary" onClick={() => toggleSchedule(s)}>{s.is_active ? 'Deactivate' : 'Activate'}</button></td>
          </tr>; })}
        </tbody></table>}
        <form className="form" onSubmit={addSchedule} style={{ marginTop: 10 }}>
          <label>Schedule type<select value={schedForm.scheduleType} onChange={e => setSchedForm({ ...schedForm, scheduleType: e.target.value })}><option value="preventive_maintenance">Routine preventive maintenance</option><option value="servicing">Servicing (provider)</option></select></label>
          <label>Frequency<select value={schedForm.frequency} onChange={e => setSchedForm({ ...schedForm, frequency: e.target.value })}>{SCHEDULE_FREQUENCIES.map(f => <option key={f} value={f}>{f}</option>)}</select></label>
          {schedForm.frequency === 'custom' && <label>Interval (days)<input type="number" min={1} value={schedForm.intervalDays} onChange={e => setSchedForm({ ...schedForm, intervalDays: e.target.value })} /></label>}
          <label>Provider type<select value={schedForm.providerType} onChange={e => setSchedForm({ ...schedForm, providerType: e.target.value })}><option value="internal">Internal</option><option value="external">External</option></select></label>
          <label>Provider name<input value={schedForm.providerName} onChange={e => setSchedForm({ ...schedForm, providerName: e.target.value })} placeholder="Service engineer / unit" /></label>
          <label>Responsible staff<select value={schedForm.responsibleStaffId} onChange={e => setSchedForm({ ...schedForm, responsibleStaffId: e.target.value })}><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
          <label>Responsible unit<select value={schedForm.sectionId} onChange={e => setSchedForm({ ...schedForm, sectionId: e.target.value })}><option value="">—</option>{sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
          <label>Task description<input value={schedForm.taskDescription} onChange={e => setSchedForm({ ...schedForm, taskDescription: e.target.value })} placeholder="e.g. clean rotor, check seals" /></label>
          <label>First due date<input type="date" value={schedForm.nextDueDate} onChange={e => setSchedForm({ ...schedForm, nextDueDate: e.target.value })} /></label>
          <button type="submit">Add schedule</button>
        </form>

        <h4 style={{ marginTop: 20 }}>Log maintenance</h4>
        <form className="form" onSubmit={submitMaintenance}>
          <label>Date<input type="date" value={maintForm.maintenanceDate} onChange={e => setMaintForm({ ...maintForm, maintenanceDate: e.target.value })} required /></label>
          <label>Type<select value={maintForm.maintenanceType} onChange={e => setMaintForm({ ...maintForm, maintenanceType: e.target.value })}>{MAINTENANCE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}</select></label>
          <label>Against schedule<select value={maintForm.scheduleId} onChange={e => setMaintForm({ ...maintForm, scheduleId: e.target.value })}><option value="">— none —</option>{schedules.filter(s => s.is_active).map(s => <option key={s.id} value={s.id}>{(s.schedule_type || '').replace(/_/g, ' ')} · {s.frequency}</option>)}</select></label>
          <label>Performed by<select value={maintForm.performedByStaffId} onChange={e => setMaintForm({ ...maintForm, performedByStaffId: e.target.value })}><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
          <label>Provider type<select value={maintForm.providerType} onChange={e => setMaintForm({ ...maintForm, providerType: e.target.value })}><option value="">—</option><option value="internal">Internal</option><option value="external">External</option></select></label>
          <label>Service provider<input value={maintForm.serviceProvider} onChange={e => setMaintForm({ ...maintForm, serviceProvider: e.target.value })} placeholder="Engineer / company" /></label>
          <label>Findings<textarea value={maintForm.findings} onChange={e => setMaintForm({ ...maintForm, findings: e.target.value })} /></label>
          <label>Action taken<textarea value={maintForm.actionTaken} onChange={e => setMaintForm({ ...maintForm, actionTaken: e.target.value })} /></label>
          <label>Next due (override)<input type="date" value={maintForm.nextDueDate} onChange={e => setMaintForm({ ...maintForm, nextDueDate: e.target.value })} /></label>
          <label>Evidence<input type="file" onChange={e => setMaintFile(e.target.files?.[0] ?? null)} /></label>
          <button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Log maintenance'}</button>
        </form>

        <h4 style={{ marginTop: 20 }}>Recent maintenance</h4>
        {records.length === 0 ? <p className="muted">No maintenance recorded.</p> : <table className="table"><thead><tr><th>Date</th><th>Type</th><th>Provider</th><th>Performed by</th><th>Findings</th><th>Next due</th></tr></thead><tbody>
          {records.map(m => <tr key={m.id}><td>{m.maintenance_date}</td><td>{m.maintenance_type}</td><td>{(m as any).service_provider || '—'}</td><td>{staffName(staff, m.performed_by_staff_id)}</td><td>{m.findings || '—'}</td><td>{m.next_due_date || '—'}</td></tr>)}
        </tbody></table>}
      </>}
    </div>
  </div>;
}

// Equipment adverse events: report → auto-raised NC → investigate, correct,
// follow up, assess retrospective impact and report externally.
function EquipmentAdverseEventsTab({ equipment, staff, setError, onChanged }: { equipment: EquipmentItem[]; staff: Staff[]; setError: (m: string | null) => void; onChanged: () => void }) {
  const [list, setList] = useState<EquipmentAdverseEvent[]>([]);
  const [open, setOpen] = useState<EquipmentAdverseEvent | null>(null);
  const blank = { equipmentId: '', eventDate: '', reportedByStaffId: '', eventType: ADVERSE_EVENT_TYPES[0].value, severity: 'high', patientHarm: 'none', description: '', immediateAction: '', retrospectiveImpactRequired: false, resultsAffected: false, affectedPeriodFrom: '', affectedPeriodTo: '', retrospectiveImpactSummary: '', reportedToManufacturer: false, reportedToAuthority: false, reportReference: '', reportDate: '', raiseNc: true };
  const [form, setForm] = useState(blank);
  const [edit, setEdit] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  function load() { api<EquipmentAdverseEvent[]>('/equipment/adverse-events').then(setList).catch(() => setList([])); }
  useEffect(() => { load(); }, []);

  async function submit(e: FormEvent) {
    e.preventDefault(); setError(null);
    if (!form.equipmentId) { setError('Select an equipment item.'); return; }
    if (!form.eventDate || !form.description) { setError('Enter the date and a description.'); return; }
    setBusy(true);
    try {
      await api(`/equipment/${form.equipmentId}/adverse-events`, { method: 'POST', body: JSON.stringify(form) });
      setForm(blank); load(); onChanged();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  async function openDetail(id: number) {
    try {
      const rec = await api<EquipmentAdverseEvent>(`/equipment/adverse-events/${id}`);
      setOpen(rec);
      setEdit({ severity: rec.severity ?? '', patientHarm: rec.patient_harm ?? '', investigation: rec.investigation ?? '', investigatedByStaffId: rec.investigated_by_staff_id ? String(rec.investigated_by_staff_id) : '', investigationDate: rec.investigation_date ?? '', correctiveAction: rec.corrective_action ?? '', followUp: rec.follow_up ?? '', followUpDate: rec.follow_up_date ?? '', retrospectiveImpactRequired: !!rec.retrospective_impact_required, resultsAffected: !!rec.results_affected, affectedPeriodFrom: rec.affected_period_from ?? '', affectedPeriodTo: rec.affected_period_to ?? '', retrospectiveImpactSummary: rec.retrospective_impact_summary ?? '', reportedToManufacturer: !!rec.reported_to_manufacturer, reportedToAuthority: !!rec.reported_to_authority, reportReference: rec.report_reference ?? '', reportDate: rec.report_date ?? '', status: rec.status });
    } catch (e) { setError((e as Error).message); }
  }
  async function saveDetail() {
    if (!open) return; setError(null); setBusy(true);
    try { await api(`/equipment/adverse-events/${open.id}`, { method: 'PUT', body: JSON.stringify(edit) }); await openDetail(open.id); load(); onChanged(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function createCapa() {
    if (!open) return;
    try { await api(`/equipment/adverse-events/${open.id}/create-capa`, { method: 'POST', body: JSON.stringify({}) }); await openDetail(open.id); load(); }
    catch (e) { setError((e as Error).message); }
  }
  async function createNc() {
    if (!open) return;
    try { await api(`/equipment/adverse-events/${open.id}/create-nc`, { method: 'POST', body: JSON.stringify({}) }); await openDetail(open.id); load(); }
    catch (e) { setError((e as Error).message); }
  }

  return <div>
    <div className="card">
      <h3>Report an equipment adverse event</h3>
      <p className="muted" style={{ marginTop: 0 }}>Reportable incidents are nonconformities: a linked NC is raised automatically. Investigation, corrective action, follow-up, retrospective impact and external reporting are captured on the record.</p>
      <form className="form" onSubmit={submit}>
        <label>Equipment<select value={form.equipmentId} onChange={e => setForm({ ...form, equipmentId: e.target.value })} required><option value="">Select equipment</option>{equipment.map(e2 => <option key={e2.id} value={e2.id}>{e2.equipment_number} — {e2.name}</option>)}</select></label>
        <label>Event date<input type="date" value={form.eventDate} onChange={e => setForm({ ...form, eventDate: e.target.value })} required /></label>
        <label>Reported by<select value={form.reportedByStaffId} onChange={e => setForm({ ...form, reportedByStaffId: e.target.value })}><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
        <label>Event type<select value={form.eventType} onChange={e => setForm({ ...form, eventType: e.target.value })}>{ADVERSE_EVENT_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}</select></label>
        <label>Severity<select value={form.severity} onChange={e => setForm({ ...form, severity: e.target.value })}>{['low', 'medium', 'high', 'critical'].map(s => <option key={s} value={s}>{s}</option>)}</select></label>
        <label>Patient harm<select value={form.patientHarm} onChange={e => setForm({ ...form, patientHarm: e.target.value })}>{['none', 'potential', 'actual'].map(s => <option key={s} value={s}>{s}</option>)}</select></label>
        <label style={{ gridColumn: '1 / -1' }}>Description<textarea value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} required /></label>
        <label style={{ gridColumn: '1 / -1' }}>Immediate action<textarea value={form.immediateAction} onChange={e => setForm({ ...form, immediateAction: e.target.value })} /></label>
        <label className="check-inline"><input type="checkbox" checked={form.retrospectiveImpactRequired} onChange={e => setForm({ ...form, retrospectiveImpactRequired: e.target.checked })} /> Retrospective impact review needed</label>
        <label className="check-inline"><input type="checkbox" checked={form.resultsAffected} onChange={e => setForm({ ...form, resultsAffected: e.target.checked })} /> Previously reported results affected</label>
        {form.resultsAffected && <>
          <label>Affected from<input type="date" value={form.affectedPeriodFrom} onChange={e => setForm({ ...form, affectedPeriodFrom: e.target.value })} /></label>
          <label>Affected to<input type="date" value={form.affectedPeriodTo} onChange={e => setForm({ ...form, affectedPeriodTo: e.target.value })} /></label>
          <label style={{ gridColumn: '1 / -1' }}>Impact summary<textarea value={form.retrospectiveImpactSummary} onChange={e => setForm({ ...form, retrospectiveImpactSummary: e.target.value })} /></label>
        </>}
        <label className="check-inline"><input type="checkbox" checked={form.reportedToManufacturer} onChange={e => setForm({ ...form, reportedToManufacturer: e.target.checked })} /> Reported to manufacturer/supplier</label>
        <label className="check-inline"><input type="checkbox" checked={form.reportedToAuthority} onChange={e => setForm({ ...form, reportedToAuthority: e.target.checked })} /> Reported to authority</label>
        <label>Report reference<input value={form.reportReference} onChange={e => setForm({ ...form, reportReference: e.target.value })} /></label>
        <label>Report date<input type="date" value={form.reportDate} onChange={e => setForm({ ...form, reportDate: e.target.value })} /></label>
        <label className="check-inline"><input type="checkbox" checked={form.raiseNc} onChange={e => setForm({ ...form, raiseNc: e.target.checked })} /> Automatically raise a nonconformity</label>
        <button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Report adverse event'}</button>
      </form>
    </div>

    <div className="card" style={{ marginTop: 16 }}>
      <h3>Adverse event register</h3>
      {list.length === 0 ? <p className="muted">No adverse events recorded.</p> : <table className="table"><thead><tr><th>No.</th><th>Equipment</th><th>Date</th><th>Type</th><th>Severity</th><th>NC</th><th>CAPA</th><th>Status</th><th></th></tr></thead><tbody>
        {list.map(a => <tr key={a.id}><td>{a.adverse_event_number}</td><td>{a.equipment_number} — {a.equipment_name}</td><td>{a.event_date}</td><td>{adverseTypeLabel(a.event_type)}</td><td>{a.severity ? formatBadge(a.severity) : '—'}</td><td>{a.nc_id || '—'}</td><td>{a.capa_id || '—'}</td><td>{formatBadge(a.status)}</td><td><button type="button" className="secondary" onClick={() => openDetail(a.id)}>Open</button></td></tr>)}
      </tbody></table>}
    </div>

    {open && edit && <div className="card" style={{ marginTop: 16 }}>
      <div className="section-head"><h3 style={{ margin: 0 }}>{open.adverse_event_number} — {adverseTypeLabel(open.event_type)}</h3><button type="button" className="secondary" onClick={() => setOpen(null)}>Close</button></div>
      <p className="muted" style={{ marginTop: 0 }}>{open.equipment_number} — {open.equipment_name} · {open.event_date} · {open.description}
        {open.nc_id ? <> · linked NC #{open.nc_id}</> : null}{open.capa_id ? <> · linked CAPA #{open.capa_id}</> : null}</p>
      <div className="form">
        <h4>Investigation</h4>
        <label>Investigation<textarea value={edit.investigation} onChange={e => setEdit({ ...edit, investigation: e.target.value })} /></label>
        <label>Investigated by<select value={edit.investigatedByStaffId} onChange={e => setEdit({ ...edit, investigatedByStaffId: e.target.value })}><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
        <label>Investigation date<input type="date" value={edit.investigationDate} onChange={e => setEdit({ ...edit, investigationDate: e.target.value })} /></label>
        <h4>Corrective action &amp; follow-up</h4>
        <label>Corrective action<textarea value={edit.correctiveAction} onChange={e => setEdit({ ...edit, correctiveAction: e.target.value })} /></label>
        <label>Follow-up<textarea value={edit.followUp} onChange={e => setEdit({ ...edit, followUp: e.target.value })} /></label>
        <label>Follow-up date<input type="date" value={edit.followUpDate} onChange={e => setEdit({ ...edit, followUpDate: e.target.value })} /></label>
        <h4>Retrospective impact on results</h4>
        <label className="check-inline"><input type="checkbox" checked={edit.resultsAffected} onChange={e => setEdit({ ...edit, resultsAffected: e.target.checked })} /> Previously reported results affected</label>
        <label>Affected from<input type="date" value={edit.affectedPeriodFrom} onChange={e => setEdit({ ...edit, affectedPeriodFrom: e.target.value })} /></label>
        <label>Affected to<input type="date" value={edit.affectedPeriodTo} onChange={e => setEdit({ ...edit, affectedPeriodTo: e.target.value })} /></label>
        <label>Impact summary<textarea value={edit.retrospectiveImpactSummary} onChange={e => setEdit({ ...edit, retrospectiveImpactSummary: e.target.value })} /></label>
        <h4>External reporting</h4>
        <label className="check-inline"><input type="checkbox" checked={edit.reportedToManufacturer} onChange={e => setEdit({ ...edit, reportedToManufacturer: e.target.checked })} /> Reported to manufacturer/supplier</label>
        <label className="check-inline"><input type="checkbox" checked={edit.reportedToAuthority} onChange={e => setEdit({ ...edit, reportedToAuthority: e.target.checked })} /> Reported to authority</label>
        <label>Report reference<input value={edit.reportReference} onChange={e => setEdit({ ...edit, reportReference: e.target.value })} /></label>
        <label>Report date<input type="date" value={edit.reportDate} onChange={e => setEdit({ ...edit, reportDate: e.target.value })} /></label>
        <label>Status<select value={edit.status} onChange={e => setEdit({ ...edit, status: e.target.value })}>{['open', 'under_investigation', 'action_required', 'closed'].map(s => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}</select></label>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" onClick={saveDetail} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
          {!open.nc_id && <button type="button" className="secondary" onClick={createNc}>Raise NC</button>}
          {!open.capa_id && <button type="button" className="secondary" onClick={createCapa}>Raise CAPA</button>}
        </div>
      </div>
    </div>}
  </div>;
}

// Staff training & competence on a specific equipment. Competent + authorised
// records flow into the personnel competency and technical-authorisation files.
function EquipmentCompetencyTab({ equipment, staff, setError, onChanged }: { equipment: EquipmentItem[]; staff: Staff[]; setError: (m: string | null) => void; onChanged: () => void }) {
  const [list, setList] = useState<EquipmentCompetency[]>([]);
  const blank = { equipmentId: '', staffId: '', trainingDate: '', trainerStaffId: '', assessmentMethod: 'direct_observation', assessmentDate: '', assessorStaffId: '', outcome: 'competent', authorized: true, authorizationLevel: 'Perform', notes: '' };
  const [form, setForm] = useState(blank);
  const [busy, setBusy] = useState(false);
  function load() { api<EquipmentCompetency[]>('/equipment/competencies').then(setList).catch(() => setList([])); }
  useEffect(() => { load(); }, []);

  async function submit(e: FormEvent) {
    e.preventDefault(); setError(null);
    if (!form.equipmentId || !form.staffId) { setError('Select equipment and staff.'); return; }
    setBusy(true);
    try {
      await api(`/equipment/${form.equipmentId}/competencies`, { method: 'POST', body: JSON.stringify(form) });
      setForm(blank); load(); onChanged();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  return <div>
    <div className="card">
      <h3>Record training &amp; competence on equipment</h3>
      <p className="muted" style={{ marginTop: 0 }}>When a staff member is competent and authorised, a competency assessment and technical authorisation are created automatically in Personnel Management, so the training file is populated in one place.</p>
      <form className="form" onSubmit={submit}>
        <label>Equipment<select value={form.equipmentId} onChange={e => setForm({ ...form, equipmentId: e.target.value })} required><option value="">Select equipment</option>{equipment.map(e2 => <option key={e2.id} value={e2.id}>{e2.equipment_number} — {e2.name}</option>)}</select></label>
        <label>Staff<select value={form.staffId} onChange={e => setForm({ ...form, staffId: e.target.value })} required><option value="">Select staff</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
        <label>Training date<input type="date" value={form.trainingDate} onChange={e => setForm({ ...form, trainingDate: e.target.value })} /></label>
        <label>Trainer<select value={form.trainerStaffId} onChange={e => setForm({ ...form, trainerStaffId: e.target.value })}><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
        <label>Assessment method<select value={form.assessmentMethod} onChange={e => setForm({ ...form, assessmentMethod: e.target.value })}>{['direct_observation', 'record_review', 'blind_sample', 'split_sample', 'problem_solving', 'result_interpretation', 'interview', 'other'].map(m => <option key={m} value={m}>{m.replace(/_/g, ' ')}</option>)}</select></label>
        <label>Assessment date<input type="date" value={form.assessmentDate} onChange={e => setForm({ ...form, assessmentDate: e.target.value })} /></label>
        <label>Assessor<select value={form.assessorStaffId} onChange={e => setForm({ ...form, assessorStaffId: e.target.value })}><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
        <label>Outcome<select value={form.outcome} onChange={e => setForm({ ...form, outcome: e.target.value })}>{COMPETENCY_OUTCOMES.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}</select></label>
        <label className="check-inline"><input type="checkbox" checked={form.authorized} onChange={e => setForm({ ...form, authorized: e.target.checked })} /> Authorise to operate</label>
        {form.authorized && <label>Authorisation level<select value={form.authorizationLevel} onChange={e => setForm({ ...form, authorizationLevel: e.target.value })}>{['View only', 'Perform', 'Review', 'Verify', 'Approve', 'Supervise', 'Train others'].map(l => <option key={l} value={l}>{l}</option>)}</select></label>}
        <label style={{ gridColumn: '1 / -1' }}>Notes<textarea value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} /></label>
        <button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Record competence'}</button>
      </form>
    </div>
    <div className="card" style={{ marginTop: 16 }}>
      <h3>Equipment competence register</h3>
      {list.length === 0 ? <p className="muted">No records yet.</p> : <table className="table"><thead><tr><th>Staff</th><th>Equipment</th><th>Assessed</th><th>Outcome</th><th>Authorised</th><th>Personnel records</th><th>Status</th></tr></thead><tbody>
        {list.map(c => <tr key={c.id}><td>{c.staff_name}</td><td>{c.equipment_number} — {c.equipment_name}</td><td>{c.assessment_date || c.training_date || '—'}</td><td>{c.outcome ? formatBadge(c.outcome) : '—'}</td><td>{c.authorized ? `✓ ${c.authorization_level || ''}` : '—'}</td><td>{c.competency_assessment_id ? `COMP #${c.competency_assessment_id}` : '—'}{c.technical_authorization_id ? ` · AUTH #${c.technical_authorization_id}` : ''}</td><td>{formatBadge(c.status)}</td></tr>)}
      </tbody></table>}
    </div>
  </div>;
}

// Equipment files: uploads create a controlled document via the Documents module
// and link it to the equipment, so it appears in both places.
function EquipmentFilesTab({ equipment, sections, departments, setError, onChanged }: { equipment: EquipmentItem[]; sections: Section[]; departments: Department[]; setError: (m: string | null) => void; onChanged: () => void }) {
  const [equipId, setEquipId] = useState('');
  const [docs, setDocs] = useState<EquipmentDocumentLink[]>([]);
  const blank = { title: '', documentType: EQUIP_DOC_TYPES[0], sectionId: '', departmentId: '' };
  const [form, setForm] = useState(blank);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  function load(id: string) { if (id) api<EquipmentDocumentLink[]>(`/equipment/${id}/documents`).then(setDocs).catch(() => setDocs([])); else setDocs([]); }
  useEffect(() => { load(equipId); }, [equipId]);

  async function submit(e: FormEvent) {
    e.preventDefault(); setError(null);
    if (!equipId) { setError('Select an equipment item.'); return; }
    if (!form.title) { setError('Enter a document title.'); return; }
    if (!file) { setError('Choose a file to upload.'); return; }
    setBusy(true);
    try {
      const fileId = await uploadEquipFile(file);
      // Create the controlled document through the Documents module…
      const created = await api<{ id: number; documentCode: string }>('/documents', { method: 'POST', body: JSON.stringify({ title: form.title, documentType: form.documentType, sectionId: form.sectionId || null, departmentId: form.departmentId || null, fileId }) });
      // …then link it to this equipment so it shows in both places.
      await api(`/equipment/${equipId}/documents`, { method: 'POST', body: JSON.stringify({ documentId: created.id }) });
      setForm(blank); setFile(null); if (fileRef.current) fileRef.current.value = '';
      load(equipId); onChanged();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  return <div className="card">
    <div className="section-head"><h3 style={{ margin: 0 }}>Equipment files</h3>
      <select value={equipId} onChange={e => setEquipId(e.target.value)} style={{ maxWidth: 320 }}><option value="">Select equipment…</option>{equipment.map(e2 => <option key={e2.id} value={e2.id}>{e2.equipment_number} — {e2.name}</option>)}</select>
    </div>
    <p className="muted" style={{ marginTop: 0 }}>Documents added here are created as controlled documents in <strong>Documents &amp; Records</strong> and linked to the equipment, so an update in either module is reflected in both.</p>
    {!equipId ? <p className="muted">Select an equipment item to view and add its files.</p> : <>
      <form className="form" onSubmit={submit}>
        <label>Title<input value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} required /></label>
        <label>Document type<select value={form.documentType} onChange={e => setForm({ ...form, documentType: e.target.value })}>{EQUIP_DOC_TYPES.map(t => <option key={t} value={t}>{t}</option>)}</select></label>
        <label>Department<select value={form.departmentId} onChange={e => setForm({ ...form, departmentId: e.target.value })}><option value="">—</option>{departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
        <label>Section<select value={form.sectionId} onChange={e => setForm({ ...form, sectionId: e.target.value })}><option value="">—</option>{sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label>File<input ref={fileRef} type="file" onChange={e => setFile(e.target.files?.[0] ?? null)} /></label>
        <button type="submit" disabled={busy}>{busy ? 'Uploading…' : 'Add document'}</button>
      </form>
      <table className="table" style={{ marginTop: 12 }}><thead><tr><th>Code</th><th>Title</th><th>Type</th><th>Status</th><th>File</th></tr></thead><tbody>
        {docs.map(d => <tr key={d.id}><td>{d.document_code || '—'}</td><td>{d.title}</td><td>{d.document_type || '—'}</td><td>{formatBadge(d.status)}</td><td>{d.file_id ? <a href={`${API_BASE}/files/${d.file_id}/raw`} target="_blank" rel="noreferrer">open</a> : '—'}</td></tr>)}
        {docs.length === 0 && <tr><td colSpan={5} className="muted">No documents linked yet.</td></tr>}
      </tbody></table>
    </>}
  </div>;
}

// ============= INVENTORY =============
type InventoryItemDetail = InventoryItem & { batches?: InventoryBatch[]; movements?: any[] };

export function InventoryPage() {
  const { can } = usePermissions();
  const { isEnabled } = useModules();
  const { staff, sections, locations } = useLookups();
  const [tab, setTab] = useState('Dashboard');
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [batches, setBatches] = useState<InventoryBatch[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  useFocusTarget(items.length + batches.length + suppliers.length);
  const [summary, setSummary] = useState<OperationsSummary | null>(null);
  const [selected, setSelected] = useState<InventoryItemDetail | null>(null);
  const [itemForm, setItemForm] = useState({ name: '', category: '', supplierId: '', locationId: '', sectionId: '', quantity: 0, unit: '', minimumStock: 0, reorderLevel: 0, expiryDate: '', storageRequirement: '', status: 'available' });
  const [batchForm, setBatchForm] = useState({ itemId: '', batchNumber: '', lotNumber: '', supplierId: '', quantityReceived: 0, quantityAvailable: 0, dateReceived: '', expiryDate: '', storageLocationId: '' });
  const [movementForm, setMovementForm] = useState({ batchId: '', movementType: 'issue', quantity: 0, movementDate: '', issuedToSectionId: '', receivedByStaffId: '', reason: '' });
  const [supplierForm, setSupplierForm] = useState({ name: '', contactPerson: '', phone: '', email: '', address: '', itemCategory: '', evaluationRequired: false });
  const [evalForm, setEvalForm] = useState({ supplierId: '', evaluationDate: '', rating: '', findings: '', actionRequired: '', nextEvaluationDate: '' });
  const [storageInspections, setStorageInspections] = useState<StorageInspection[]>([]);
  const [stiForm, setStiForm] = useState({ inspectionDate: '', locationId: '', storageArea: '', coldStorageAdequate: false, temperatureMonitored: false, humidityMonitored: false, ventilationAdequate: false, accessControlled: false, organisedFefo: false, outcome: '', findings: '', correctiveAction: '', nextDueDate: '' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const [its, bts, sups, ops] = await Promise.all([
        api<InventoryItem[]>('/supplier-inventory/items'),
        api<InventoryBatch[]>('/supplier-inventory/batches'),
        api<Supplier[]>('/supplier-inventory/suppliers'),
        api<OperationsSummary>('/dashboard/operations-summary').catch(() => null)
      ]);
      setItems(its); setBatches(bts); setSuppliers(sups);
      if (ops) setSummary(ops);
      api<StorageInspection[]>('/supplier-inventory/storage-inspections').then(setStorageInspections).catch(() => setStorageInspections([]));
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }
  async function submitStorageInspection(e: FormEvent) {
    e.preventDefault(); setError(null);
    try { await api('/supplier-inventory/storage-inspections', { method: 'POST', body: JSON.stringify(stiForm) }); setStiForm({ inspectionDate: '', locationId: '', storageArea: '', coldStorageAdequate: false, temperatureMonitored: false, humidityMonitored: false, ventilationAdequate: false, accessControlled: false, organisedFefo: false, outcome: '', findings: '', correctiveAction: '', nextDueDate: '' }); await load(); }
    catch (e) { setError((e as Error).message); }
  }
  useEffect(() => { if (isEnabled('supplier_inventory')) void load(); }, [isEnabled]);

  if (!isEnabled('supplier_inventory')) return <DisabledModule />;

  async function openDetail(id: number) {
    try { setSelected(await api<InventoryItemDetail>(`/supplier-inventory/items/${id}`)); }
    catch (e) { setError((e as Error).message); }
  }

  async function submitItem(e: FormEvent) {
    e.preventDefault(); setError(null);
    try {
      await api('/supplier-inventory/items', { method: 'POST', body: JSON.stringify(itemForm) });
      setItemForm({ name: '', category: '', supplierId: '', locationId: '', sectionId: '', quantity: 0, unit: '', minimumStock: 0, reorderLevel: 0, expiryDate: '', storageRequirement: '', status: 'available' });
      await load(); setTab('Item Register');
    } catch (e) { setError((e as Error).message); }
  }

  async function submitBatch(e: FormEvent) {
    e.preventDefault(); setError(null);
    if (!batchForm.itemId) return setError('Select an item');
    try {
      await api(`/supplier-inventory/items/${batchForm.itemId}/batches`, { method: 'POST', body: JSON.stringify(batchForm) });
      setBatchForm({ itemId: '', batchNumber: '', lotNumber: '', supplierId: '', quantityReceived: 0, quantityAvailable: 0, dateReceived: '', expiryDate: '', storageLocationId: '' });
      await load();
    } catch (e) { setError((e as Error).message); }
  }

  async function submitMovement(e: FormEvent) {
    e.preventDefault(); setError(null);
    if (!movementForm.batchId) return setError('Select a batch');
    try {
      await api(`/supplier-inventory/batches/${movementForm.batchId}/movement`, { method: 'POST', body: JSON.stringify(movementForm) });
      setMovementForm({ batchId: '', movementType: 'issue', quantity: 0, movementDate: '', issuedToSectionId: '', receivedByStaffId: '', reason: '' });
      await load();
    } catch (e) { setError((e as Error).message); }
  }

  async function submitSupplier(e: FormEvent) {
    e.preventDefault(); setError(null);
    try {
      await api('/supplier-inventory/suppliers', { method: 'POST', body: JSON.stringify(supplierForm) });
      setSupplierForm({ name: '', contactPerson: '', phone: '', email: '', address: '', itemCategory: '', evaluationRequired: false });
      await load();
    } catch (e) { setError((e as Error).message); }
  }

  async function submitEvaluation(e: FormEvent) {
    e.preventDefault(); setError(null);
    if (!evalForm.supplierId) return setError('Select a supplier');
    try {
      await api(`/supplier-inventory/suppliers/${evalForm.supplierId}/evaluation`, { method: 'POST', body: JSON.stringify(evalForm) });
      setEvalForm({ supplierId: '', evaluationDate: '', rating: '', findings: '', actionRequired: '', nextEvaluationDate: '' });
      await load();
    } catch (e) { setError((e as Error).message); }
  }

  async function acceptBatch(batchId: number, status: string) {
    try { await api(`/supplier-inventory/batches/${batchId}/acceptance`, { method: 'POST', body: JSON.stringify({ acceptanceStatus: status }) }); await load(); }
    catch (e) { setError((e as Error).message); }
  }

  async function createBatchNc(batchId: number) {
    try { await api(`/supplier-inventory/batches/${batchId}/create-nc`, { method: 'POST', body: JSON.stringify({}) }); await load(); }
    catch (e) { setError((e as Error).message); }
  }

  return <div>
    <PageHeader eyebrow="Supplier &amp; Inventory Management" title="Supplier &amp; Inventory Management" subtitle="Suppliers, reagents, stock levels, batches, and expiry control." />
    {error && <div className="card" style={{ color: 'var(--danger)' }}>{error}</div>}
    {tabBarFor('supplier_inventory')(tab, ['Dashboard', 'Item Register', 'New Item', 'Batches/Lots', 'Stock Movements', 'Suppliers', 'Storage Inspections', 'Barcode Labels', 'Reports placeholder'], setTab)}

    {tab === 'Dashboard' && <><ModuleAlerts moduleKey="supplier_inventory" /><KpiStrip items={[
      { label: 'Inventory items', value: items.length, onClick: () => setTab('Item Register') },
      { label: 'Low stock', value: summary?.inventoryLowStock ?? items.filter(i => i.low_stock).length, tone: 'warning', onClick: () => setTab('Item Register') },
      { label: 'Expiring soon', value: summary?.inventoryExpiringSoon, onClick: () => setTab('Batches/Lots') },
      { label: 'Expired', value: summary?.inventoryExpired, tone: 'danger', onClick: () => setTab('Batches/Lots') },
    ]} />
    <div className="grid cols-2" style={{ marginTop: 18 }}>
      <ChartCard title="Stock health" subtitle="Items by supply risk">
        <DonutChart centerLabel="Items" data={[
          { label: 'Healthy', value: Math.max(0, items.length - (summary?.inventoryLowStock ?? items.filter(i => i.low_stock).length) - (summary?.inventoryExpired ?? 0)), color: CHART_COLORS[1] },
          { label: 'Low stock', value: summary?.inventoryLowStock ?? items.filter(i => i.low_stock).length, color: CHART_COLORS[2] },
          { label: 'Expired', value: summary?.inventoryExpired ?? 0, color: CHART_COLORS[3] },
        ]} />
      </ChartCard>
      <ChartCard title="Replenishment signals" subtitle="Stock requiring action">
        <BarMeter data={[
          { label: 'Low stock', value: summary?.inventoryLowStock ?? items.filter(i => i.low_stock).length, color: CHART_COLORS[2] },
          { label: 'Expiring soon', value: summary?.inventoryExpiringSoon, color: CHART_COLORS[0] },
          { label: 'Expired', value: summary?.inventoryExpired, color: CHART_COLORS[3] },
        ]} />
      </ChartCard>
    </div></>}

    {tab === 'Item Register' && <div className="card">
      <div className="section-head" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <h3 style={{ margin: 0 }}>Items</h3>
        {can('supplier_inventory', 'print') && <button style={{ marginLeft: 'auto' }} type="button" className="secondary" title="Print Code 128 barcode labels for all stock items" onClick={() => printLabelSheet(items.map(it => ({ barcodeValue: it.item_code, title: it.name, lines: [it.item_code, it.category || ''].filter(Boolean) })), { widthMm: 50, heightMm: 25, title: 'Stock barcode labels' })}>🏷️ Print barcode labels</button>}
      </div>
      <div style={{ margin: '4px 0 10px' }}><BarcodeScanner placeholder="Scan a stock item barcode…" autoFocus={false} onScan={code => { const m = items.find(i => i.item_code?.toLowerCase() === code.trim().toLowerCase()); if (m) openDetail(m.id); else setError(`No item found for barcode "${code}".`); }} /></div>
      {loading ? <p>Loading…</p> : items.length === 0 ? <p>No items yet.</p> :
        <table className="table"><thead><tr><th>Code</th><th>Name</th><th>Category</th><th>Qty</th><th>Unit</th><th>Min</th><th>Reorder</th><th>Expiry</th><th></th></tr></thead><tbody>
          {items.map(i => <tr key={i.id} {...focusAttr('inventory_items', i.id)}><td>{i.item_code}</td><td>{i.name}</td><td>{i.category || '—'}</td>
            <td>{i.quantity}{i.low_stock && <span className="badge" style={{ marginLeft: 6, background: '#fff7df', color: '#6b4b05' }}>low</span>}</td>
            <td>{i.unit || '—'}</td><td>{i.minimum_stock || 0}</td><td>{i.reorder_level || 0}</td>
            <td>{i.expiry_date || '—'} {i.expiry_status && i.expiry_status !== 'valid' && <span className="badge" style={{ background: i.expiry_status === 'expired' ? '#fde2e2' : '#fff7df', color: i.expiry_status === 'expired' ? 'var(--danger)' : '#6b4b05' }}>{i.expiry_status.replace('_', ' ')}</span>}</td>
            <td><button type="button" className="secondary" onClick={() => openDetail(i.id)}>Open</button></td>
          </tr>)}
        </tbody></table>}
      {selected && <InventoryDetailPanel item={selected} staff={staff} onClose={() => setSelected(null)} acceptBatch={acceptBatch} createBatchNc={createBatchNc} />}
    </div>}

    {tab === 'New Item' && <div className="card">
      <h3>New inventory item</h3>
      <form className="form" onSubmit={submitItem}>
        <label>Name<input value={itemForm.name} onChange={e => setItemForm({ ...itemForm, name: e.target.value })} required /></label>
        <label>Category<input value={itemForm.category} onChange={e => setItemForm({ ...itemForm, category: e.target.value })} required /></label>
        <label>Unit of measure<input value={itemForm.unit} onChange={e => setItemForm({ ...itemForm, unit: e.target.value })} required /></label>
        <label>Supplier<select value={itemForm.supplierId} onChange={e => setItemForm({ ...itemForm, supplierId: e.target.value })}><option value="">Select supplier</option>{suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label>Location<select value={itemForm.locationId} onChange={e => setItemForm({ ...itemForm, locationId: e.target.value })}><option value="">Select location</option>{locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
        <label>Section<select value={itemForm.sectionId} onChange={e => setItemForm({ ...itemForm, sectionId: e.target.value })}><option value="">Select section</option>{sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label>Minimum stock<input type="number" value={itemForm.minimumStock} onChange={e => setItemForm({ ...itemForm, minimumStock: Number(e.target.value) })} /></label>
        <label>Reorder level<input type="number" value={itemForm.reorderLevel} onChange={e => setItemForm({ ...itemForm, reorderLevel: Number(e.target.value) })} /></label>
        <label>Storage requirement<input value={itemForm.storageRequirement} onChange={e => setItemForm({ ...itemForm, storageRequirement: e.target.value })} placeholder="e.g. 2-8°C" /></label>
        <label>Status<select value={itemForm.status} onChange={e => setItemForm({ ...itemForm, status: e.target.value })}><option value="available">Available</option><option value="reserved">Reserved</option><option value="unavailable">Unavailable</option></select></label>
        <button type="submit">Save item</button>
      </form>
    </div>}

    {tab === 'Batches/Lots' && <div>
      <div className="card">
        <h3>Add batch / lot</h3>
        <form className="form" onSubmit={submitBatch}>
          <label>Item<select value={batchForm.itemId} onChange={e => setBatchForm({ ...batchForm, itemId: e.target.value })} required><option value="">Select item</option>{items.map(i => <option key={i.id} value={i.id}>{i.item_code} — {i.name}</option>)}</select></label>
          <label>Batch number<input value={batchForm.batchNumber} onChange={e => setBatchForm({ ...batchForm, batchNumber: e.target.value })} /></label>
          <label>Lot number<input value={batchForm.lotNumber} onChange={e => setBatchForm({ ...batchForm, lotNumber: e.target.value })} /></label>
          <label>Supplier<select value={batchForm.supplierId} onChange={e => setBatchForm({ ...batchForm, supplierId: e.target.value })}><option value="">Select supplier</option>{suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
          <label>Quantity received<input type="number" value={batchForm.quantityReceived} onChange={e => setBatchForm({ ...batchForm, quantityReceived: Number(e.target.value), quantityAvailable: Number(e.target.value) })} required /></label>
          <label>Quantity available<input type="number" value={batchForm.quantityAvailable} onChange={e => setBatchForm({ ...batchForm, quantityAvailable: Number(e.target.value) })} required /></label>
          <label>Date received<input type="date" value={batchForm.dateReceived} onChange={e => setBatchForm({ ...batchForm, dateReceived: e.target.value })} required /></label>
          <label>Expiry date<input type="date" value={batchForm.expiryDate} onChange={e => setBatchForm({ ...batchForm, expiryDate: e.target.value })} /></label>
          <label>Storage location<select value={batchForm.storageLocationId} onChange={e => setBatchForm({ ...batchForm, storageLocationId: e.target.value })}><option value="">Select location</option>{locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
          <button type="submit">Save batch</button>
        </form>
      </div>
      <div className="card">
        <h3>Batches (FEFO order)</h3>
        {batches.length === 0 ? <p>No batches recorded.</p> :
          <table className="table"><thead><tr><th>Item</th><th>Batch</th><th>Lot</th><th>Available</th><th>Expiry</th><th>Acceptance</th><th>Actions</th></tr></thead><tbody>
            {batches.map(b => <tr key={b.id} {...focusAttr('inventory_batches', b.id)}><td>{b.item_name || b.item_id}</td><td>{b.batch_number || '—'}</td><td>{b.lot_number || '—'}</td>
              <td>{b.quantity_available} {b.unit_of_measure || ''}</td>
              <td>{b.expiry_date || '—'} {b.expiry_status && b.expiry_status !== 'valid' && <span className="badge" style={{ background: b.expiry_status === 'expired' ? '#fde2e2' : '#fff7df', color: b.expiry_status === 'expired' ? 'var(--danger)' : '#6b4b05' }}>{b.expiry_status.replace('_', ' ')}</span>}</td>
              <td>{formatBadge(b.acceptance_status)}</td>
              <td>
                {b.acceptance_status === 'pending' && <>
                  <button type="button" className="secondary" onClick={() => acceptBatch(b.id, 'accepted')}>Accept</button>{' '}
                  <button type="button" className="secondary" onClick={() => acceptBatch(b.id, 'rejected')}>Reject</button>{' '}
                </>}
                <button type="button" className="secondary" onClick={() => createBatchNc(b.id)}>Create NC</button>
              </td>
            </tr>)}
          </tbody></table>}
      </div>
    </div>}

    {tab === 'Stock Movements' && <div className="card">
      <h3>Record stock movement</h3>
      <form className="form" onSubmit={submitMovement}>
        <label>Batch<select value={movementForm.batchId} onChange={e => setMovementForm({ ...movementForm, batchId: e.target.value })} required><option value="">Select batch</option>{batches.map(b => <option key={b.id} value={b.id}>{b.item_name} — {b.batch_number || `Batch #${b.id}`} (avail {b.quantity_available})</option>)}</select></label>
        <label>Movement type<select value={movementForm.movementType} onChange={e => setMovementForm({ ...movementForm, movementType: e.target.value })}>{['issue', 'consume', 'discard', 'waste', 'transfer_out', 'receive', 'return', 'adjust_in', 'transfer_in'].map(t => <option key={t} value={t}>{t.replace('_', ' ')}</option>)}</select></label>
        <label>Quantity<input type="number" value={movementForm.quantity} onChange={e => setMovementForm({ ...movementForm, quantity: Number(e.target.value) })} required min={0.0001} step="any" /></label>
        <label>Movement date<input type="date" value={movementForm.movementDate} onChange={e => setMovementForm({ ...movementForm, movementDate: e.target.value })} /></label>
        <label>Issued to section<select value={movementForm.issuedToSectionId} onChange={e => setMovementForm({ ...movementForm, issuedToSectionId: e.target.value })}><option value="">Select section</option>{sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label>Received by<select value={movementForm.receivedByStaffId} onChange={e => setMovementForm({ ...movementForm, receivedByStaffId: e.target.value })}><option value="">Select staff</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
        <label>Reason<input value={movementForm.reason} onChange={e => setMovementForm({ ...movementForm, reason: e.target.value })} /></label>
        <button type="submit">Record movement</button>
      </form>
    </div>}

    {tab === 'Suppliers' && <div>
      <div className="card">
        <h3>New supplier</h3>
        <form className="form" onSubmit={submitSupplier}>
          <label>Name<input value={supplierForm.name} onChange={e => setSupplierForm({ ...supplierForm, name: e.target.value })} required /></label>
          <label>Contact person<input value={supplierForm.contactPerson} onChange={e => setSupplierForm({ ...supplierForm, contactPerson: e.target.value })} /></label>
          <label>Phone<input value={supplierForm.phone} onChange={e => setSupplierForm({ ...supplierForm, phone: e.target.value })} /></label>
          <label>Email<input value={supplierForm.email} onChange={e => setSupplierForm({ ...supplierForm, email: e.target.value })} /></label>
          <label>Address<input value={supplierForm.address} onChange={e => setSupplierForm({ ...supplierForm, address: e.target.value })} /></label>
          <label>Item category<input value={supplierForm.itemCategory} onChange={e => setSupplierForm({ ...supplierForm, itemCategory: e.target.value })} /></label>
          <label><input type="checkbox" checked={supplierForm.evaluationRequired} onChange={e => setSupplierForm({ ...supplierForm, evaluationRequired: e.target.checked })} /> Evaluation required</label>
          <button type="submit">Save supplier</button>
        </form>
      </div>
      <div className="card">
        <h3>Supplier evaluation</h3>
        <form className="form" onSubmit={submitEvaluation}>
          <label>Supplier<select value={evalForm.supplierId} onChange={e => setEvalForm({ ...evalForm, supplierId: e.target.value })} required><option value="">Select supplier</option>{suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
          <label>Evaluation date<input type="date" value={evalForm.evaluationDate} onChange={e => setEvalForm({ ...evalForm, evaluationDate: e.target.value })} /></label>
          <label>Rating<input value={evalForm.rating} onChange={e => setEvalForm({ ...evalForm, rating: e.target.value })} placeholder="e.g. satisfactory" /></label>
          <label>Findings<textarea value={evalForm.findings} onChange={e => setEvalForm({ ...evalForm, findings: e.target.value })} /></label>
          <label>Action required<textarea value={evalForm.actionRequired} onChange={e => setEvalForm({ ...evalForm, actionRequired: e.target.value })} /></label>
          <label>Next evaluation date<input type="date" value={evalForm.nextEvaluationDate} onChange={e => setEvalForm({ ...evalForm, nextEvaluationDate: e.target.value })} /></label>
          <button type="submit">Record evaluation</button>
        </form>
      </div>
      <div className="card">
        <h3>Suppliers</h3>
        {suppliers.length === 0 ? <p>No suppliers.</p> :
          <table className="table"><thead><tr><th>Code</th><th>Name</th><th>Contact</th><th>Last eval</th><th>Next eval</th><th>Status</th></tr></thead><tbody>
            {suppliers.map(s => <tr key={s.id} {...focusAttr('suppliers', s.id)}><td>{s.supplier_code}</td><td>{s.name}</td><td>{s.contact_person || s.contact || '—'}</td><td>{s.last_evaluation_date || '—'}</td><td>{s.next_evaluation_due || '—'}</td><td>{formatBadge(s.status)}</td></tr>)}
          </tbody></table>}
      </div>
    </div>}

    {tab === 'Storage Inspections' && <>
      <div className="card">
        <h3>Record storage-area inspection</h3>
        <form className="form" onSubmit={submitStorageInspection}>
          <label>Inspection date<input type="date" value={stiForm.inspectionDate} onChange={e => setStiForm({ ...stiForm, inspectionDate: e.target.value })} required /></label>
          <label>Location<select value={stiForm.locationId} onChange={e => setStiForm({ ...stiForm, locationId: e.target.value })}><option value="">Select location</option>{locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
          <label>Storage area<input value={stiForm.storageArea} onChange={e => setStiForm({ ...stiForm, storageArea: e.target.value })} placeholder="e.g. reagent store, cold room" /></label>
          <label><input type="checkbox" checked={stiForm.coldStorageAdequate} onChange={e => setStiForm({ ...stiForm, coldStorageAdequate: e.target.checked })} /> Cold storage adequate</label>
          <label><input type="checkbox" checked={stiForm.temperatureMonitored} onChange={e => setStiForm({ ...stiForm, temperatureMonitored: e.target.checked })} /> Temperature monitored</label>
          <label><input type="checkbox" checked={stiForm.humidityMonitored} onChange={e => setStiForm({ ...stiForm, humidityMonitored: e.target.checked })} /> Humidity monitored</label>
          <label><input type="checkbox" checked={stiForm.ventilationAdequate} onChange={e => setStiForm({ ...stiForm, ventilationAdequate: e.target.checked })} /> Ventilation adequate</label>
          <label><input type="checkbox" checked={stiForm.accessControlled} onChange={e => setStiForm({ ...stiForm, accessControlled: e.target.checked })} /> Access controlled</label>
          <label><input type="checkbox" checked={stiForm.organisedFefo} onChange={e => setStiForm({ ...stiForm, organisedFefo: e.target.checked })} /> Organised / FEFO practised</label>
          <label>Outcome<select value={stiForm.outcome} onChange={e => setStiForm({ ...stiForm, outcome: e.target.value })}><option value="">Select outcome</option><option value="pass">Pass</option><option value="action_required">Action required</option><option value="fail">Fail</option></select></label>
          <label>Next due date<input type="date" value={stiForm.nextDueDate} onChange={e => setStiForm({ ...stiForm, nextDueDate: e.target.value })} /></label>
          <label>Findings<textarea value={stiForm.findings} onChange={e => setStiForm({ ...stiForm, findings: e.target.value })} /></label>
          <label>Corrective action<textarea value={stiForm.correctiveAction} onChange={e => setStiForm({ ...stiForm, correctiveAction: e.target.value })} /></label>
          <button type="submit">Record inspection</button>
        </form>
      </div>
      <div className="card" style={{ marginTop: 16 }}>
        <h3>Storage inspection log</h3>
        {storageInspections.length === 0 ? <p>No storage inspections recorded.</p> :
          <table className="table"><thead><tr><th>No.</th><th>Date</th><th>Area</th><th>Cold</th><th>Temp</th><th>Access</th><th>FEFO</th><th>Outcome</th></tr></thead><tbody>
            {storageInspections.map(s => <tr key={s.id}><td>{s.inspection_number}</td><td>{s.inspection_date}</td><td>{s.storage_area || locations.find(l => l.id === s.location_id)?.name || '—'}</td><td>{s.cold_storage_adequate ? '✓' : '—'}</td><td>{s.temperature_monitored ? '✓' : '—'}</td><td>{s.access_controlled ? '✓' : '—'}</td><td>{s.organised_fefo ? '✓' : '—'}</td><td>{s.outcome ? s.outcome.replace(/_/g, ' ') : '—'}</td></tr>)}
          </tbody></table>}
      </div>
    </>}

    {tab === 'Barcode Labels' && <BarcodeLabelGenerator />}

    {tab === 'Reports placeholder' && <div className="card"><p>Reports for inventory will be added in a later phase.</p></div>}
  </div>;
}

function InventoryDetailPanel({ item, staff, onClose, acceptBatch, createBatchNc }: { item: InventoryItemDetail; staff: Staff[]; onClose: () => void; acceptBatch: (id: number, status: string) => void; createBatchNc: (id: number) => void }) {
  return <DetailModal open onClose={onClose} title={<>{item.item_code} — {item.name}</>}>
    <p>Quantity: {item.quantity} {item.unit} | Minimum: {item.minimum_stock} | Reorder: {item.reorder_level} | Expiry: {item.expiry_date || '—'}</p>
    <h4>Batches (FEFO)</h4>
    {!item.batches?.length ? <p>No batches.</p> : <table className="table"><thead><tr><th>Batch</th><th>Lot</th><th>Available</th><th>Expiry</th><th>Acceptance</th><th>Actions</th></tr></thead><tbody>
      {item.batches.map(b => <tr key={b.id}><td>{b.batch_number || '—'}</td><td>{b.lot_number || '—'}</td><td>{b.quantity_available}</td><td>{b.expiry_date || '—'}</td><td>{formatBadge(b.acceptance_status)}</td>
        <td>
          {b.acceptance_status === 'pending' && <><button type="button" className="secondary" onClick={() => acceptBatch(b.id, 'accepted')}>Accept</button>{' '}<button type="button" className="secondary" onClick={() => acceptBatch(b.id, 'rejected')}>Reject</button>{' '}</>}
          <button type="button" className="secondary" onClick={() => createBatchNc(b.id)}>Create NC</button>
        </td></tr>)}
    </tbody></table>}
    <h4>Recent movements</h4>
    {!item.movements?.length ? <p>No movements.</p> : <table className="table"><thead><tr><th>Date</th><th>Type</th><th>Qty</th><th>Reason</th><th>Received by</th></tr></thead><tbody>
      {item.movements.map((m: any) => <tr key={m.id}><td>{m.movement_date}</td><td>{m.movement_type}</td><td>{m.quantity}</td><td>{m.reason || '—'}</td><td>{staffName(staff, m.received_by_staff_id)}</td></tr>)}
    </tbody></table>}
  </DetailModal>;
}

// ============= MONITORING =============
export function MonitoringPage({ embedded = false }: { embedded?: boolean } = {}) {
  const { isEnabled } = useModules();
  const { staff, sections, locations } = useLookups();
  const [tab, setTab] = useState(embedded ? 'Monitoring Items' : 'Dashboard');
  const [items, setItems] = useState<MonitoringItem[]>([]);
  const [readings, setReadings] = useState<MonitoringReading[]>([]);
  useFocusTarget(readings);
  const [summary, setSummary] = useState<OperationsSummary | null>(null);
  const [legacyRecords, setLegacyRecords] = useState<MonitoringRecord[]>([]);
  const [itemForm, setItemForm] = useState({ name: '', monitoringType: '', parameter: '', unit: '', sectionId: '', locationId: '', lowerLimit: '', upperLimit: '', warningLowerLimit: '', warningUpperLimit: '', criticalLowerLimit: '', criticalUpperLimit: '', frequency: '', responsibleStaffId: '', ncTriggerEnabled: false });
  const [readingForm, setReadingForm] = useState({ itemId: '', readingDate: '', readingTime: '', value: '', comment: '', immediateAction: '' });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const [its, rds, ops, legacy] = await Promise.all([
        api<MonitoringItem[]>('/monitoring/items'),
        api<MonitoringReading[]>('/monitoring/readings'),
        api<OperationsSummary>('/dashboard/operations-summary').catch(() => null),
        api<MonitoringRecord[]>('/monitoring').catch(() => [])
      ]);
      setItems(its); setReadings(rds); setLegacyRecords(legacy);
      if (ops) setSummary(ops);
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }
  useEffect(() => { if (embedded || isEnabled('monitoring')) void load(); }, [isEnabled]);

  if (!embedded && !isEnabled('monitoring')) return <DisabledModule />;

  const excursions = useMemo(() => readings.filter(r => r.status !== 'normal'), [readings]);

  async function submitItem(e: FormEvent) {
    e.preventDefault(); setError(null);
    try {
      await api('/monitoring/items', { method: 'POST', body: JSON.stringify(itemForm) });
      setItemForm({ name: '', monitoringType: '', parameter: '', unit: '', sectionId: '', locationId: '', lowerLimit: '', upperLimit: '', warningLowerLimit: '', warningUpperLimit: '', criticalLowerLimit: '', criticalUpperLimit: '', frequency: '', responsibleStaffId: '', ncTriggerEnabled: false });
      await load(); setTab('Monitoring Items');
    } catch (e) { setError((e as Error).message); }
  }

  async function submitReading(e: FormEvent) {
    e.preventDefault(); setError(null);
    if (!readingForm.itemId) return setError('Select a monitoring item');
    try {
      await api(`/monitoring/items/${readingForm.itemId}/readings`, { method: 'POST', body: JSON.stringify(readingForm) });
      setReadingForm({ itemId: '', readingDate: '', readingTime: '', value: '', comment: '', immediateAction: '' });
      await load();
    } catch (e) { setError((e as Error).message); }
  }

  async function createNcForReading(id: number) {
    try { await api(`/monitoring/readings/${id}/create-nc`, { method: 'POST', body: JSON.stringify({}) }); await load(); }
    catch (e) { setError((e as Error).message); }
  }
  async function createCapaForReading(id: number) {
    try { await api(`/monitoring/readings/${id}/create-capa`, { method: 'POST', body: JSON.stringify({}) }); await load(); }
    catch (e) { setError((e as Error).message); }
  }
  async function reviewReading(id: number) {
    try { await api(`/monitoring/readings/${id}/review`, { method: 'POST', body: JSON.stringify({}) }); await load(); }
    catch (e) { setError((e as Error).message); }
  }

  return <div>
    {!embedded && <PageHeader eyebrow="Facilities and Safety" title="Environmental Monitoring" subtitle="Temperature and environment readings, excursions, and trends." />}
    {error && <div className="card" style={{ color: 'var(--danger)' }}>{error}</div>}
    {tabBarFor('monitoring')(tab, ['Dashboard', 'Monitoring Items', 'New Monitoring Item', 'Enter Reading', 'Excursions', 'Monthly Charts placeholder'].filter(t => !embedded || t !== 'Dashboard'), setTab)}

    {tab === 'Dashboard' && <><ModuleAlerts moduleKey="monitoring" /><KpiStrip items={[
      { label: 'Monitoring items', value: items.length, onClick: () => setTab('Monitoring Items') },
      { label: 'Warnings', value: summary?.monitoringWarnings ?? readings.filter(r => r.status === 'warning').length, tone: 'warning', onClick: () => setTab('Excursions') },
      { label: 'Critical / out-of-range', value: summary?.monitoringCritical ?? excursions.filter(r => r.status !== 'warning').length, tone: 'danger', onClick: () => setTab('Excursions') },
      { label: 'Legacy records', value: legacyRecords.length, onClick: () => setTab('Monitoring Items') },
    ]} />
    <div className="grid cols-2" style={{ marginTop: 18 }}>
      <ChartCard title="Environmental status" subtitle="Latest reading status mix">
        <DonutChart centerLabel="Status" data={[
          { label: 'In range', value: Math.max(0, readings.filter(r => r.status === 'ok' || r.status === 'normal').length), color: CHART_COLORS[1] },
          { label: 'Warnings', value: summary?.monitoringWarnings ?? readings.filter(r => r.status === 'warning').length, color: CHART_COLORS[2] },
          { label: 'Critical', value: summary?.monitoringCritical ?? excursions.filter(r => r.status !== 'warning').length, color: CHART_COLORS[3] },
        ]} />
      </ChartCard>
      <ChartCard title="Excursion load" subtitle="Out-of-range signals to review">
        <BarMeter data={[
          { label: 'Warnings', value: summary?.monitoringWarnings ?? readings.filter(r => r.status === 'warning').length, color: CHART_COLORS[2] },
          { label: 'Critical', value: summary?.monitoringCritical ?? excursions.filter(r => r.status !== 'warning').length, color: CHART_COLORS[3] },
        ]} />
      </ChartCard>
    </div></>}

    {tab === 'Monitoring Items' && <div className="card">
      <h3>Monitoring items</h3>
      {loading ? <p>Loading…</p> : items.length === 0 ? <p>No monitoring items configured.</p> :
        <table className="table"><thead><tr><th>Code</th><th>Name</th><th>Parameter</th><th>Unit</th><th>Limits</th><th>Frequency</th><th>NC trigger</th></tr></thead><tbody>
          {items.map(i => <tr key={i.id}><td>{i.item_code}</td><td>{i.name}</td><td>{i.parameter}</td><td>{i.unit || '—'}</td>
            <td>{i.lower_limit ?? '—'} … {i.upper_limit ?? '—'}{i.warning_lower_limit !== undefined && i.warning_lower_limit !== null ? <span style={{ color: 'var(--warning)' }}> (warn {i.warning_lower_limit}…{i.warning_upper_limit})</span> : null}</td>
            <td>{i.frequency || '—'}</td><td>{i.nc_trigger_enabled ? 'yes' : 'no'}</td></tr>)}
        </tbody></table>}
    </div>}

    {tab === 'New Monitoring Item' && <div className="card">
      <h3>New monitoring item</h3>
      <form className="form" onSubmit={submitItem}>
        <label>Name<input value={itemForm.name} onChange={e => setItemForm({ ...itemForm, name: e.target.value })} required /></label>
        <label>Monitoring type<input value={itemForm.monitoringType} onChange={e => setItemForm({ ...itemForm, monitoringType: e.target.value })} placeholder="e.g. fridge, freezer, room temp" /></label>
        <label>Parameter<input value={itemForm.parameter} onChange={e => setItemForm({ ...itemForm, parameter: e.target.value })} required placeholder="e.g. temperature" /></label>
        <label>Unit<input value={itemForm.unit} onChange={e => setItemForm({ ...itemForm, unit: e.target.value })} required placeholder="°C" /></label>
        <label>Section<select value={itemForm.sectionId} onChange={e => setItemForm({ ...itemForm, sectionId: e.target.value })}><option value="">Select section</option>{sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label>Location<select value={itemForm.locationId} onChange={e => setItemForm({ ...itemForm, locationId: e.target.value })}><option value="">Select location</option>{locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
        <label>Lower limit<input type="number" step="any" value={itemForm.lowerLimit} onChange={e => setItemForm({ ...itemForm, lowerLimit: e.target.value })} required /></label>
        <label>Upper limit<input type="number" step="any" value={itemForm.upperLimit} onChange={e => setItemForm({ ...itemForm, upperLimit: e.target.value })} required /></label>
        <label>Warning lower<input type="number" step="any" value={itemForm.warningLowerLimit} onChange={e => setItemForm({ ...itemForm, warningLowerLimit: e.target.value })} /></label>
        <label>Warning upper<input type="number" step="any" value={itemForm.warningUpperLimit} onChange={e => setItemForm({ ...itemForm, warningUpperLimit: e.target.value })} /></label>
        <label>Critical lower<input type="number" step="any" value={itemForm.criticalLowerLimit} onChange={e => setItemForm({ ...itemForm, criticalLowerLimit: e.target.value })} /></label>
        <label>Critical upper<input type="number" step="any" value={itemForm.criticalUpperLimit} onChange={e => setItemForm({ ...itemForm, criticalUpperLimit: e.target.value })} /></label>
        <label>Frequency<input value={itemForm.frequency} onChange={e => setItemForm({ ...itemForm, frequency: e.target.value })} placeholder="e.g. daily" /></label>
        <label>Responsible staff<select value={itemForm.responsibleStaffId} onChange={e => setItemForm({ ...itemForm, responsibleStaffId: e.target.value })}><option value="">Select staff</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
        <label><input type="checkbox" checked={itemForm.ncTriggerEnabled} onChange={e => setItemForm({ ...itemForm, ncTriggerEnabled: e.target.checked })} /> Enable NC trigger button on critical/out-of-range</label>
        <button type="submit">Save monitoring item</button>
      </form>
    </div>}

    {tab === 'Enter Reading' && <div className="card">
      <h3>Enter reading</h3>
      <form className="form" onSubmit={submitReading}>
        <label>Monitoring item<select value={readingForm.itemId} onChange={e => setReadingForm({ ...readingForm, itemId: e.target.value })} required><option value="">Select item</option>{items.map(i => <option key={i.id} value={i.id}>{i.item_code} — {i.name} ({i.lower_limit}…{i.upper_limit} {i.unit})</option>)}</select></label>
        <label>Reading date<input type="date" value={readingForm.readingDate} onChange={e => setReadingForm({ ...readingForm, readingDate: e.target.value })} required /></label>
        <label>Reading time<input type="time" value={readingForm.readingTime} onChange={e => setReadingForm({ ...readingForm, readingTime: e.target.value })} /></label>
        <label>Value<input type="number" step="any" value={readingForm.value} onChange={e => setReadingForm({ ...readingForm, value: e.target.value })} required /></label>
        <label>Comment<textarea value={readingForm.comment} onChange={e => setReadingForm({ ...readingForm, comment: e.target.value })} placeholder="Required for abnormal readings" /></label>
        <label>Immediate action<textarea value={readingForm.immediateAction} onChange={e => setReadingForm({ ...readingForm, immediateAction: e.target.value })} placeholder="Required for abnormal readings" /></label>
        <button type="submit">Save reading</button>
      </form>
    </div>}

    {tab === 'Excursions' && <div className="card">
      <h3>Excursions</h3>
      {excursions.length === 0 ? <p>No excursions recorded.</p> :
        <table className="table"><thead><tr><th>Date</th><th>Item</th><th>Value</th><th>Status</th><th>Comment</th><th>Actions</th></tr></thead><tbody>
          {excursions.map(r => <tr key={r.id} {...focusAttr('monitoring_readings', r.id)}><td>{r.reading_date}</td><td>{r.item_name || items.find(i => i.id === r.monitoring_item_id)?.name}</td><td>{r.value} {r.item_unit}</td><td>{formatBadge(r.status)}</td><td>{r.comment || '—'}</td>
            <td>
              {!r.reviewed_at && <button type="button" className="secondary" onClick={() => reviewReading(r.id)}>Review</button>}{' '}
              {!r.nc_id && (r.status === 'critical' || r.status === 'out_of_range') && <button type="button" className="secondary" onClick={() => createNcForReading(r.id)}>Create NC</button>}{' '}
              {!r.capa_id && <button type="button" className="secondary" onClick={() => createCapaForReading(r.id)}>Create CAPA</button>}
            </td></tr>)}
        </tbody></table>}
    </div>}

    {tab === 'Monthly Charts placeholder' && <div className="card"><p>Monthly trend charts will be added in a later phase.</p></div>}
  </div>;
}

// ============= SAFETY =============
const SAFETY_EQUIPMENT_TYPES = ['biosafety_cabinet', 'fume_hood', 'fire_extinguisher', 'fire_alarm', 'smoke_detector', 'eyewash_station', 'emergency_shower', 'spill_kit', 'first_aid_kit', 'ppe_station', 'other'];
const INSPECTION_TYPES = ['safety_audit', 'fire_drill', 'housekeeping', 'facility_assessment', 'walkthrough', 'biosafety'];
const WASTE_TYPES = ['infectious', 'sharps', 'chemical', 'pathological', 'general', 'radioactive', 'pharmaceutical'];
const DISPOSAL_METHODS = ['autoclave', 'incineration', 'pit', 'licensed_collector', 'sewer', 'other'];
const HAZARD_CLASSES = ['flammable', 'corrosive', 'toxic', 'oxidizer', 'carcinogen', 'irritant', 'radioactive', 'other'];
const IMMUNIZATION_TYPES = ['vaccination', 'post_exposure', 'declination'];
const prettify = (s?: string) => s ? s.replace(/_/g, ' ') : '—';

export function SafetyPage() {
  const { isEnabled } = useModules();
  const { staff, sections, locations } = useLookups();
  const [tab, setTab] = useState('Dashboard');
  const [incidents, setIncidents] = useState<SafetyIncident[]>([]);
  const [summary, setSummary] = useState<FacilitiesSafetySummary | null>(null);
  const [equipment, setEquipment] = useState<SafetyEquipment[]>([]);
  const [inspections, setInspections] = useState<SafetyInspection[]>([]);
  // A dashboard alert arrives with ?tab= and ?focus=; the tab bar opens the tab,
  // this scrolls to the record and flashes it.
  useFocusTarget(incidents.length + equipment.length + inspections.length);
  const [waste, setWaste] = useState<WasteDisposalRecord[]>([]);
  const [chemicals, setChemicals] = useState<HazardousChemical[]>([]);
  const [immunizations, setImmunizations] = useState<StaffImmunization[]>([]);
  const [selected, setSelected] = useState<(SafetyIncident & { links?: any[] }) | null>(null);
  const [selectedInsp, setSelectedInsp] = useState<(SafetyInspection & { links?: any[] }) | null>(null);
  const [form, setForm] = useState({ incidentDate: '', incidentType: '', title: '', description: '', category: '', severity: '', sectionId: '', locationId: '', reportedByStaffId: '', immediateAction: '', personsInvolved: '', reportedTo: '', status: 'open' });
  const [equipForm, setEquipForm] = useState({ name: '', equipmentType: '', serialNumber: '', locationId: '', sectionId: '', responsibleStaffId: '', status: 'operational', inspectionFrequency: '', nextInspectionDue: '', certificationFrequency: '', nextCertificationDue: '', notes: '' });
  const [inspForm, setInspForm] = useState({ inspectionType: '', inspectionDate: '', sectionId: '', locationId: '', conductedByStaffId: '', scope: '', findingsSummary: '', outcome: '', correctiveAction: '', nextDueDate: '' });
  const [wasteForm, setWasteForm] = useState({ disposalDate: '', wasteType: '', quantity: '', unit: '', disposalMethod: '', handledByStaffId: '', carrierOrDestination: '', manifestReference: '', sectionId: '', notes: '' });
  const [chemForm, setChemForm] = useState({ name: '', hazardClass: '', casNumber: '', sdsReference: '', sdsOnFile: false, storageLocationId: '', segregationGroup: '', quantity: '', unit: '', expiryDate: '', spillMeasures: '', status: 'in_use', notes: '' });
  const [immForm, setImmForm] = useState({ staffId: '', recordType: 'vaccination', vaccineOrAgent: '', doseOrStage: '', dateAdministered: '', nextDueDate: '', provider: '', exposureDate: '', exposureSource: '', followUpSummary: '', outcome: '', declinationSigned: false, notes: '' });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const [list, sum, eq, insp, wst, chm, imm] = await Promise.all([
        api<SafetyIncident[]>('/facilities-safety/incidents'),
        api<FacilitiesSafetySummary>('/facilities-safety/summary').catch(() => null),
        api<SafetyEquipment[]>('/facilities-safety/equipment').catch(() => []),
        api<SafetyInspection[]>('/facilities-safety/inspections').catch(() => []),
        api<WasteDisposalRecord[]>('/facilities-safety/waste').catch(() => []),
        api<HazardousChemical[]>('/facilities-safety/chemicals').catch(() => []),
        api<StaffImmunization[]>('/facilities-safety/immunizations').catch(() => []),
      ]);
      setIncidents(list); if (sum) setSummary(sum);
      setEquipment(eq); setInspections(insp); setWaste(wst); setChemicals(chm); setImmunizations(imm);
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }
  useEffect(() => { if (isEnabled('facilities_safety')) void load(); }, [isEnabled]);

  if (!isEnabled('facilities_safety')) return <DisabledModule />;

  async function openDetail(id: number) {
    try { setSelected(await api<SafetyIncident & { links?: any[] }>(`/facilities-safety/incidents/${id}`)); }
    catch (e) { setError((e as Error).message); }
  }
  async function openInspection(id: number) {
    try { setSelectedInsp(await api<SafetyInspection & { links?: any[] }>(`/facilities-safety/inspections/${id}`)); }
    catch (e) { setError((e as Error).message); }
  }

  async function submit(e: FormEvent) {
    e.preventDefault(); setError(null);
    try {
      await api('/facilities-safety/incidents', { method: 'POST', body: JSON.stringify(form) });
      setForm({ incidentDate: '', incidentType: '', title: '', description: '', category: '', severity: '', sectionId: '', locationId: '', reportedByStaffId: '', immediateAction: '', personsInvolved: '', reportedTo: '', status: 'open' });
      await load(); setTab('Safety Incidents');
    } catch (e) { setError((e as Error).message); }
  }
  async function submitEquip(e: FormEvent) {
    e.preventDefault(); setError(null);
    try {
      await api('/facilities-safety/equipment', { method: 'POST', body: JSON.stringify(equipForm) });
      setEquipForm({ name: '', equipmentType: '', serialNumber: '', locationId: '', sectionId: '', responsibleStaffId: '', status: 'operational', inspectionFrequency: '', nextInspectionDue: '', certificationFrequency: '', nextCertificationDue: '', notes: '' });
      await load();
    } catch (e) { setError((e as Error).message); }
  }
  async function submitInsp(e: FormEvent) {
    e.preventDefault(); setError(null);
    try {
      await api('/facilities-safety/inspections', { method: 'POST', body: JSON.stringify(inspForm) });
      setInspForm({ inspectionType: '', inspectionDate: '', sectionId: '', locationId: '', conductedByStaffId: '', scope: '', findingsSummary: '', outcome: '', correctiveAction: '', nextDueDate: '' });
      await load();
    } catch (e) { setError((e as Error).message); }
  }
  async function submitWaste(e: FormEvent) {
    e.preventDefault(); setError(null);
    try {
      await api('/facilities-safety/waste', { method: 'POST', body: JSON.stringify(wasteForm) });
      setWasteForm({ disposalDate: '', wasteType: '', quantity: '', unit: '', disposalMethod: '', handledByStaffId: '', carrierOrDestination: '', manifestReference: '', sectionId: '', notes: '' });
      await load();
    } catch (e) { setError((e as Error).message); }
  }
  async function submitChem(e: FormEvent) {
    e.preventDefault(); setError(null);
    try {
      await api('/facilities-safety/chemicals', { method: 'POST', body: JSON.stringify(chemForm) });
      setChemForm({ name: '', hazardClass: '', casNumber: '', sdsReference: '', sdsOnFile: false, storageLocationId: '', segregationGroup: '', quantity: '', unit: '', expiryDate: '', spillMeasures: '', status: 'in_use', notes: '' });
      await load();
    } catch (e) { setError((e as Error).message); }
  }
  async function submitImm(e: FormEvent) {
    e.preventDefault(); setError(null);
    try {
      await api('/facilities-safety/immunizations', { method: 'POST', body: JSON.stringify(immForm) });
      setImmForm({ staffId: '', recordType: 'vaccination', vaccineOrAgent: '', doseOrStage: '', dateAdministered: '', nextDueDate: '', provider: '', exposureDate: '', exposureSource: '', followUpSummary: '', outcome: '', declinationSigned: false, notes: '' });
      await load();
    } catch (e) { setError((e as Error).message); }
  }

  async function createNc(id: number) { try { await api(`/facilities-safety/incidents/${id}/create-nc`, { method: 'POST', body: JSON.stringify({}) }); if (selected) await openDetail(selected.id); await load(); } catch (e) { setError((e as Error).message); } }
  async function createCapa(id: number) { try { await api(`/facilities-safety/incidents/${id}/create-capa`, { method: 'POST', body: JSON.stringify({}) }); if (selected) await openDetail(selected.id); await load(); } catch (e) { setError((e as Error).message); } }
  async function closeIncident(id: number) { try { await api(`/facilities-safety/incidents/${id}/close`, { method: 'POST', body: JSON.stringify({}) }); if (selected) await openDetail(selected.id); await load(); } catch (e) { setError((e as Error).message); } }
  async function inspNc(id: number) { try { await api(`/facilities-safety/inspections/${id}/create-nc`, { method: 'POST', body: JSON.stringify({}) }); if (selectedInsp) await openInspection(selectedInsp.id); await load(); } catch (e) { setError((e as Error).message); } }
  async function inspCapa(id: number) { try { await api(`/facilities-safety/inspections/${id}/create-capa`, { method: 'POST', body: JSON.stringify({}) }); if (selectedInsp) await openInspection(selectedInsp.id); await load(); } catch (e) { setError((e as Error).message); } }
  async function inspClose(id: number) { try { await api(`/facilities-safety/inspections/${id}/close`, { method: 'POST', body: JSON.stringify({}) }); if (selectedInsp) await openInspection(selectedInsp.id); await load(); } catch (e) { setError((e as Error).message); } }

  const openIncidents = summary?.openIncidents ?? incidents.filter(i => i.status !== 'closed').length;

  return <div>
    <PageHeader eyebrow="Facilities and Safety" title="Facilities &amp; Safety" subtitle="Safety incidents, equipment, inspections, waste, chemicals and occupational health." />
    {error && <div className="card" style={{ color: 'var(--danger)' }}>{error}</div>}
    {tabBarFor('facilities_safety')(tab, ['Dashboard', 'Safety Incidents', 'New Incident', 'Safety Equipment', 'Inspections & Drills', 'Waste Disposal', 'Hazardous Chemicals', 'Immunisation & Exposure', 'Environmental Monitoring'], setTab)}

    {tab === 'Dashboard' && <><KpiStrip items={[
      { label: 'Open incidents', value: openIncidents, tone: openIncidents ? 'warning' : undefined, onClick: () => setTab('Safety Incidents') },
      { label: 'Equipment due', value: summary?.equipmentDueInspection ?? 0, onClick: () => setTab('Safety Equipment') },
      { label: 'Certification due', value: summary?.equipmentCertificationDue ?? 0, onClick: () => setTab('Safety Equipment') },
      { label: 'Inspections due', value: summary?.inspectionsDue ?? 0, onClick: () => setTab('Inspections & Drills') },
      { label: 'Chemicals expired', value: summary?.chemicalsExpired ?? 0, tone: (summary?.chemicalsExpired ?? 0) ? 'danger' : undefined, onClick: () => setTab('Hazardous Chemicals') },
      { label: 'Missing SDS', value: summary?.chemicalsMissingSds ?? 0, tone: (summary?.chemicalsMissingSds ?? 0) ? 'warning' : undefined, onClick: () => setTab('Hazardous Chemicals') },
      { label: 'Immunisations due', value: summary?.immunizationsDue ?? 0, onClick: () => setTab('Immunisation & Exposure') },
      { label: 'Open exposures', value: summary?.openPostExposure ?? 0, tone: (summary?.openPostExposure ?? 0) ? 'danger' : undefined, onClick: () => setTab('Immunisation & Exposure') },
    ]} />
    {/* Live alerts for this module + the environmental monitoring live cards,
        merged straight into the dashboard. */}
    <ModuleAlerts moduleKey="facilities_safety" title="Safety alerts & attention" />
    <EnvLiveCards onOpenFull={() => setTab('Environmental Monitoring')} />
    <div className="grid cols-3 dash-charts" style={{ marginTop: 18 }}>
      <ChartCard title="Safety equipment" subtitle="Fleet readiness">
        <DonutChart centerLabel="Items" data={[
          { label: 'Operational', value: equipment.filter(e => e.status === 'operational').length, color: CHART_COLORS[1], onClick: () => setTab('Safety Equipment') },
          { label: 'Due / cert', value: (summary?.equipmentDueInspection ?? 0) + (summary?.equipmentCertificationDue ?? 0), color: CHART_COLORS[2], onClick: () => setTab('Safety Equipment') },
          { label: 'Out of service', value: summary?.equipmentOutOfService ?? 0, color: CHART_COLORS[3], onClick: () => setTab('Safety Equipment') },
        ]} />
      </ChartCard>
      <ChartCard title="Attention required" subtitle="Items needing follow-up">
        <BarMeter data={[
          { label: 'Open incidents', value: openIncidents, color: CHART_COLORS[3], onClick: () => setTab('Safety Incidents') },
          { label: 'Inspections due', value: summary?.inspectionsDue ?? 0, color: CHART_COLORS[2], onClick: () => setTab('Inspections & Drills') },
          { label: 'Failed inspections', value: summary?.inspectionsFailed ?? 0, color: CHART_COLORS[6], onClick: () => setTab('Inspections & Drills') },
          { label: 'Chemicals expired', value: summary?.chemicalsExpired ?? 0, color: CHART_COLORS[3], onClick: () => setTab('Hazardous Chemicals') },
          { label: 'Open exposures', value: summary?.openPostExposure ?? 0, color: CHART_COLORS[4], onClick: () => setTab('Immunisation & Exposure') },
        ]} />
      </ChartCard>
      <ChartCard title="Waste this month" subtitle="Disposal records by type">
        <BarMeter data={WASTE_TYPES.map((t, i) => ({ label: prettify(t), value: waste.filter(w => w.waste_type === t).length, color: CHART_COLORS[i % CHART_COLORS.length], onClick: () => setTab('Waste Disposal') })).filter(d => d.value > 0)} />
      </ChartCard>
    </div></>}

    {tab === 'Safety Incidents' && <div className="card">
      <h3>Incident register</h3>
      {loading ? <p>Loading…</p> : incidents.length === 0 ? <p>No incidents recorded.</p> :
        <table className="table"><thead><tr><th>No.</th><th>Date</th><th>Title</th><th>Severity</th><th>Status</th><th></th></tr></thead><tbody>
          {incidents.map(i => <tr key={i.id} {...focusAttr('safety_incidents', i.id)}><td>{i.incident_number}</td><td>{i.incident_date}</td><td>{i.title || (i.description || '').slice(0, 80)}</td><td>{i.severity || '—'}</td><td>{formatBadge(i.status)}</td><td><button type="button" className="secondary" onClick={() => openDetail(i.id)}>Open</button></td></tr>)}
        </tbody></table>}
      {selected && <SafetyDetailPanel item={selected} staff={staff} onClose={() => setSelected(null)} createNc={createNc} createCapa={createCapa} closeIncident={closeIncident} />}
    </div>}

    {tab === 'New Incident' && <div className="card">
      <h3>Report safety incident</h3>
      <form className="form" onSubmit={submit}>
        <label>Incident date<input type="date" value={form.incidentDate} onChange={e => setForm({ ...form, incidentDate: e.target.value })} required /></label>
        <label>Incident type<input value={form.incidentType} onChange={e => setForm({ ...form, incidentType: e.target.value })} placeholder="e.g. spill, exposure, injury" /></label>
        <label>Title<input value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} required /></label>
        <label>Description<textarea value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} required /></label>
        <label>Severity<select value={form.severity} onChange={e => setForm({ ...form, severity: e.target.value })} required><option value="">Select severity</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label>
        <label>Category<input value={form.category} onChange={e => setForm({ ...form, category: e.target.value })} /></label>
        <label>Location<select value={form.locationId} onChange={e => setForm({ ...form, locationId: e.target.value })}><option value="">Select location</option>{locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
        <label>Section<select value={form.sectionId} onChange={e => setForm({ ...form, sectionId: e.target.value })}><option value="">Select section</option>{sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label>Reported by<select value={form.reportedByStaffId} onChange={e => setForm({ ...form, reportedByStaffId: e.target.value })}><option value="">Select staff</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
        <label>Immediate action<textarea value={form.immediateAction} onChange={e => setForm({ ...form, immediateAction: e.target.value })} /></label>
        <label>Persons involved<input value={form.personsInvolved} onChange={e => setForm({ ...form, personsInvolved: e.target.value })} /></label>
        <label>Reported to<input value={form.reportedTo} onChange={e => setForm({ ...form, reportedTo: e.target.value })} /></label>
        <button type="submit">Report incident</button>
      </form>
    </div>}

    {tab === 'Safety Equipment' && <>
      <div className="card">
        <h3>Add safety equipment</h3>
        <form className="form" onSubmit={submitEquip}>
          <label>Name<input value={equipForm.name} onChange={e => setEquipForm({ ...equipForm, name: e.target.value })} required /></label>
          <label>Type<select value={equipForm.equipmentType} onChange={e => setEquipForm({ ...equipForm, equipmentType: e.target.value })}><option value="">Select type</option>{SAFETY_EQUIPMENT_TYPES.map(t => <option key={t} value={t}>{prettify(t)}</option>)}</select></label>
          <label>Serial number<input value={equipForm.serialNumber} onChange={e => setEquipForm({ ...equipForm, serialNumber: e.target.value })} /></label>
          <label>Location<select value={equipForm.locationId} onChange={e => setEquipForm({ ...equipForm, locationId: e.target.value })}><option value="">Select location</option>{locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
          <label>Section<select value={equipForm.sectionId} onChange={e => setEquipForm({ ...equipForm, sectionId: e.target.value })}><option value="">Select section</option>{sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
          <label>Responsible staff<select value={equipForm.responsibleStaffId} onChange={e => setEquipForm({ ...equipForm, responsibleStaffId: e.target.value })}><option value="">Select staff</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
          <label>Status<select value={equipForm.status} onChange={e => setEquipForm({ ...equipForm, status: e.target.value })}>{['operational', 'out_of_service', 'expired', 'removed'].map(s => <option key={s} value={s}>{prettify(s)}</option>)}</select></label>
          <label>Inspection frequency<input value={equipForm.inspectionFrequency} onChange={e => setEquipForm({ ...equipForm, inspectionFrequency: e.target.value })} placeholder="e.g. monthly" /></label>
          <label>Next inspection due<input type="date" value={equipForm.nextInspectionDue} onChange={e => setEquipForm({ ...equipForm, nextInspectionDue: e.target.value })} /></label>
          <label>Certification frequency<input value={equipForm.certificationFrequency} onChange={e => setEquipForm({ ...equipForm, certificationFrequency: e.target.value })} placeholder="e.g. annual" /></label>
          <label>Next certification due<input type="date" value={equipForm.nextCertificationDue} onChange={e => setEquipForm({ ...equipForm, nextCertificationDue: e.target.value })} /></label>
          <label>Notes<input value={equipForm.notes} onChange={e => setEquipForm({ ...equipForm, notes: e.target.value })} /></label>
          <button type="submit">Add equipment</button>
        </form>
      </div>
      <div className="card" style={{ marginTop: 16 }}>
        <h3>Safety equipment register</h3>
        {equipment.length === 0 ? <p>No safety equipment recorded.</p> :
          <table className="table"><thead><tr><th>No.</th><th>Name</th><th>Type</th><th>Location</th><th>Next inspection</th><th>Next certification</th><th>Status</th></tr></thead><tbody>
            {equipment.map(e => <tr key={e.id} {...focusAttr('safety_equipment', e.id)}><td>{e.equipment_number}</td><td>{e.name}</td><td>{prettify(e.equipment_type)}</td><td>{locations.find(l => l.id === e.location_id)?.name || '—'}</td><td>{e.next_inspection_due || '—'}</td><td>{e.next_certification_due || '—'}</td><td>{formatBadge(e.status)}</td></tr>)}
          </tbody></table>}
      </div>
    </>}

    {tab === 'Inspections & Drills' && <>
      <div className="card">
        <h3>Record inspection / drill</h3>
        <form className="form" onSubmit={submitInsp}>
          <label>Type<select value={inspForm.inspectionType} onChange={e => setInspForm({ ...inspForm, inspectionType: e.target.value })}><option value="">Select type</option>{INSPECTION_TYPES.map(t => <option key={t} value={t}>{prettify(t)}</option>)}</select></label>
          <label>Date<input type="date" value={inspForm.inspectionDate} onChange={e => setInspForm({ ...inspForm, inspectionDate: e.target.value })} required /></label>
          <label>Section<select value={inspForm.sectionId} onChange={e => setInspForm({ ...inspForm, sectionId: e.target.value })}><option value="">Select section</option>{sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
          <label>Location<select value={inspForm.locationId} onChange={e => setInspForm({ ...inspForm, locationId: e.target.value })}><option value="">Select location</option>{locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
          <label>Conducted by<select value={inspForm.conductedByStaffId} onChange={e => setInspForm({ ...inspForm, conductedByStaffId: e.target.value })}><option value="">Select staff</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
          <label>Outcome<select value={inspForm.outcome} onChange={e => setInspForm({ ...inspForm, outcome: e.target.value })}><option value="">Select outcome</option><option value="pass">Pass</option><option value="action_required">Action required</option><option value="fail">Fail</option></select></label>
          <label>Next due date<input type="date" value={inspForm.nextDueDate} onChange={e => setInspForm({ ...inspForm, nextDueDate: e.target.value })} /></label>
          <label>Scope<textarea value={inspForm.scope} onChange={e => setInspForm({ ...inspForm, scope: e.target.value })} /></label>
          <label>Findings summary<textarea value={inspForm.findingsSummary} onChange={e => setInspForm({ ...inspForm, findingsSummary: e.target.value })} /></label>
          <label>Corrective action<textarea value={inspForm.correctiveAction} onChange={e => setInspForm({ ...inspForm, correctiveAction: e.target.value })} /></label>
          <button type="submit">Record inspection</button>
        </form>
      </div>
      <div className="card" style={{ marginTop: 16 }}>
        <h3>Inspection & drill register</h3>
        {inspections.length === 0 ? <p>No inspections recorded.</p> :
          <table className="table"><thead><tr><th>No.</th><th>Type</th><th>Date</th><th>Outcome</th><th>Next due</th><th>Status</th><th></th></tr></thead><tbody>
            {inspections.map(i => <tr key={i.id} {...focusAttr('safety_inspections', i.id)}><td>{i.inspection_number}</td><td>{prettify(i.inspection_type)}</td><td>{i.inspection_date}</td><td>{prettify(i.outcome)}</td><td>{i.next_due_date || '—'}</td><td>{formatBadge(i.status)}</td><td><button type="button" className="secondary" onClick={() => openInspection(i.id)}>Open</button></td></tr>)}
          </tbody></table>}
        {selectedInsp && <InspectionDetailPanel item={selectedInsp} staff={staff} onClose={() => setSelectedInsp(null)} createNc={inspNc} createCapa={inspCapa} closeInspection={inspClose} />}
      </div>
    </>}

    {tab === 'Waste Disposal' && <>
      <div className="card">
        <h3>Record waste disposal</h3>
        <form className="form" onSubmit={submitWaste}>
          <label>Disposal date<input type="date" value={wasteForm.disposalDate} onChange={e => setWasteForm({ ...wasteForm, disposalDate: e.target.value })} required /></label>
          <label>Waste type<select value={wasteForm.wasteType} onChange={e => setWasteForm({ ...wasteForm, wasteType: e.target.value })}><option value="">Select type</option>{WASTE_TYPES.map(t => <option key={t} value={t}>{prettify(t)}</option>)}</select></label>
          <label>Quantity<input value={wasteForm.quantity} onChange={e => setWasteForm({ ...wasteForm, quantity: e.target.value })} /></label>
          <label>Unit<input value={wasteForm.unit} onChange={e => setWasteForm({ ...wasteForm, unit: e.target.value })} placeholder="e.g. kg, L, containers" /></label>
          <label>Disposal method<select value={wasteForm.disposalMethod} onChange={e => setWasteForm({ ...wasteForm, disposalMethod: e.target.value })}><option value="">Select method</option>{DISPOSAL_METHODS.map(m => <option key={m} value={m}>{prettify(m)}</option>)}</select></label>
          <label>Handled by<select value={wasteForm.handledByStaffId} onChange={e => setWasteForm({ ...wasteForm, handledByStaffId: e.target.value })}><option value="">Select staff</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
          <label>Carrier / destination<input value={wasteForm.carrierOrDestination} onChange={e => setWasteForm({ ...wasteForm, carrierOrDestination: e.target.value })} /></label>
          <label>Manifest reference<input value={wasteForm.manifestReference} onChange={e => setWasteForm({ ...wasteForm, manifestReference: e.target.value })} /></label>
          <label>Notes<textarea value={wasteForm.notes} onChange={e => setWasteForm({ ...wasteForm, notes: e.target.value })} /></label>
          <button type="submit">Record disposal</button>
        </form>
      </div>
      <div className="card" style={{ marginTop: 16 }}>
        <h3>Waste disposal log</h3>
        {waste.length === 0 ? <p>No disposal records.</p> :
          <table className="table"><thead><tr><th>No.</th><th>Date</th><th>Type</th><th>Quantity</th><th>Method</th><th>Manifest</th></tr></thead><tbody>
            {waste.map(w => <tr key={w.id}><td>{w.record_number}</td><td>{w.disposal_date}</td><td>{prettify(w.waste_type)}</td><td>{w.quantity ? `${w.quantity} ${w.unit || ''}` : '—'}</td><td>{prettify(w.disposal_method)}</td><td>{w.manifest_reference || '—'}</td></tr>)}
          </tbody></table>}
      </div>
    </>}

    {tab === 'Hazardous Chemicals' && <>
      <div className="card">
        <h3>Add hazardous chemical</h3>
        <form className="form" onSubmit={submitChem}>
          <label>Name<input value={chemForm.name} onChange={e => setChemForm({ ...chemForm, name: e.target.value })} required /></label>
          <label>Hazard class<select value={chemForm.hazardClass} onChange={e => setChemForm({ ...chemForm, hazardClass: e.target.value })}><option value="">Select class</option>{HAZARD_CLASSES.map(h => <option key={h} value={h}>{prettify(h)}</option>)}</select></label>
          <label>CAS number<input value={chemForm.casNumber} onChange={e => setChemForm({ ...chemForm, casNumber: e.target.value })} /></label>
          <label>SDS reference<input value={chemForm.sdsReference} onChange={e => setChemForm({ ...chemForm, sdsReference: e.target.value })} /></label>
          <label><input type="checkbox" checked={chemForm.sdsOnFile} onChange={e => setChemForm({ ...chemForm, sdsOnFile: e.target.checked })} /> SDS on file</label>
          <label>Storage location<select value={chemForm.storageLocationId} onChange={e => setChemForm({ ...chemForm, storageLocationId: e.target.value })}><option value="">Select location</option>{locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
          <label>Segregation group<input value={chemForm.segregationGroup} onChange={e => setChemForm({ ...chemForm, segregationGroup: e.target.value })} placeholder="e.g. acids, bases, flammables" /></label>
          <label>Quantity<input value={chemForm.quantity} onChange={e => setChemForm({ ...chemForm, quantity: e.target.value })} /></label>
          <label>Unit<input value={chemForm.unit} onChange={e => setChemForm({ ...chemForm, unit: e.target.value })} /></label>
          <label>Expiry date<input type="date" value={chemForm.expiryDate} onChange={e => setChemForm({ ...chemForm, expiryDate: e.target.value })} /></label>
          <label>Status<select value={chemForm.status} onChange={e => setChemForm({ ...chemForm, status: e.target.value })}>{['in_use', 'in_store', 'disposed'].map(s => <option key={s} value={s}>{prettify(s)}</option>)}</select></label>
          <label>Spill measures<textarea value={chemForm.spillMeasures} onChange={e => setChemForm({ ...chemForm, spillMeasures: e.target.value })} /></label>
          <button type="submit">Add chemical</button>
        </form>
      </div>
      <div className="card" style={{ marginTop: 16 }}>
        <h3>Hazardous chemical inventory</h3>
        {chemicals.length === 0 ? <p>No chemicals recorded.</p> :
          <table className="table"><thead><tr><th>No.</th><th>Name</th><th>Hazard class</th><th>SDS</th><th>Storage</th><th>Expiry</th><th>Status</th></tr></thead><tbody>
            {chemicals.map(c => <tr key={c.id} {...focusAttr('hazardous_chemicals', c.id)}><td>{c.chemical_number}</td><td>{c.name}</td><td>{prettify(c.hazard_class)}</td><td>{c.sds_on_file ? (c.sds_reference || 'On file') : <span style={{ color: 'var(--warning)' }}>Missing</span>}</td><td>{locations.find(l => l.id === c.storage_location_id)?.name || '—'}</td><td>{c.expiry_date || '—'}</td><td>{formatBadge(c.status)}</td></tr>)}
          </tbody></table>}
      </div>
    </>}

    {tab === 'Immunisation & Exposure' && <>
      <div className="card">
        <h3>Record immunisation / exposure</h3>
        <form className="form" onSubmit={submitImm}>
          <label>Record type<select value={immForm.recordType} onChange={e => setImmForm({ ...immForm, recordType: e.target.value })}>{IMMUNIZATION_TYPES.map(t => <option key={t} value={t}>{prettify(t)}</option>)}</select></label>
          <label>Staff<select value={immForm.staffId} onChange={e => setImmForm({ ...immForm, staffId: e.target.value })}><option value="">Select staff</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
          <label>Vaccine / agent<input value={immForm.vaccineOrAgent} onChange={e => setImmForm({ ...immForm, vaccineOrAgent: e.target.value })} placeholder="e.g. Hepatitis B" /></label>
          <label>Dose / stage<input value={immForm.doseOrStage} onChange={e => setImmForm({ ...immForm, doseOrStage: e.target.value })} /></label>
          <label>Date administered<input type="date" value={immForm.dateAdministered} onChange={e => setImmForm({ ...immForm, dateAdministered: e.target.value })} /></label>
          <label>Next dose due<input type="date" value={immForm.nextDueDate} onChange={e => setImmForm({ ...immForm, nextDueDate: e.target.value })} /></label>
          <label>Provider<input value={immForm.provider} onChange={e => setImmForm({ ...immForm, provider: e.target.value })} /></label>
          <label>Exposure date<input type="date" value={immForm.exposureDate} onChange={e => setImmForm({ ...immForm, exposureDate: e.target.value })} /></label>
          <label>Exposure source<input value={immForm.exposureSource} onChange={e => setImmForm({ ...immForm, exposureSource: e.target.value })} /></label>
          <label>Outcome<input value={immForm.outcome} onChange={e => setImmForm({ ...immForm, outcome: e.target.value })} /></label>
          <label><input type="checkbox" checked={immForm.declinationSigned} onChange={e => setImmForm({ ...immForm, declinationSigned: e.target.checked })} /> Declination signed</label>
          <label>Follow-up summary<textarea value={immForm.followUpSummary} onChange={e => setImmForm({ ...immForm, followUpSummary: e.target.value })} /></label>
          <button type="submit">Record</button>
        </form>
      </div>
      <div className="card" style={{ marginTop: 16 }}>
        <h3>Immunisation & exposure register</h3>
        {immunizations.length === 0 ? <p>No records.</p> :
          <table className="table"><thead><tr><th>No.</th><th>Type</th><th>Staff</th><th>Vaccine / agent</th><th>Administered</th><th>Next due</th><th>Outcome</th></tr></thead><tbody>
            {immunizations.map(m => <tr key={m.id} {...focusAttr('staff_immunizations', m.id)}><td>{m.record_number}</td><td>{prettify(m.record_type)}</td><td>{staffName(staff, m.staff_id)}</td><td>{m.vaccine_or_agent || '—'}</td><td>{m.date_administered || '—'}</td><td>{m.next_due_date || '—'}</td><td>{m.outcome || (m.record_type === 'post_exposure' ? <span style={{ color: 'var(--warning)' }}>Open</span> : '—')}</td></tr>)}
          </tbody></table>}
      </div>
    </>}

    {tab === 'Environmental Monitoring' && <EnvironmentalMonitoringPage embedded />}
  </div>;
}

function InspectionDetailPanel({ item, staff, onClose, createNc, createCapa, closeInspection }: { item: SafetyInspection & { links?: any[] }; staff: Staff[]; onClose: () => void; createNc: (id: number) => void; createCapa: (id: number) => void; closeInspection: (id: number) => void }) {
  return <DetailModal open onClose={onClose} title={<>{item.inspection_number} — {(item.inspection_type || 'inspection').replace(/_/g, ' ')}</>}>
    <p>Status: {formatBadge(item.status)} | Outcome: {item.outcome ? item.outcome.replace(/_/g, ' ') : '—'} | Conducted by: {staffName(staff, item.conducted_by_staff_id)} | Date: {item.inspection_date}</p>
    {item.scope && <p><strong>Scope:</strong> {item.scope}</p>}
    {item.findings_summary && <p><strong>Findings:</strong> {item.findings_summary}</p>}
    {item.corrective_action && <p><strong>Corrective action:</strong> {item.corrective_action}</p>}
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      {!item.nc_id && <button type="button" className="secondary" onClick={() => createNc(item.id)}>Create NC</button>}
      {!item.capa_id && <button type="button" className="secondary" onClick={() => createCapa(item.id)}>Create CAPA</button>}
      {item.status !== 'closed' && <button type="button" className="secondary" onClick={() => closeInspection(item.id)}>Close inspection</button>}
    </div>
    <h4 style={{ marginTop: 16 }}>Linked records</h4>
    {!item.links?.length ? <p>No linked records.</p> : <ul>{item.links.map((l: any) => <li key={l.id}>{l.source_module_key}/{l.source_record_type}#{l.source_record_id} → {l.target_module_key}/{l.target_record_type}#{l.target_record_id}{l.notes ? ` (${l.notes})` : ''}</li>)}</ul>}
  </DetailModal>;
}

function SafetyDetailPanel({ item, staff, onClose, createNc, createCapa, closeIncident }: { item: SafetyIncident & { links?: any[] }; staff: Staff[]; onClose: () => void; createNc: (id: number) => void; createCapa: (id: number) => void; closeIncident: (id: number) => void }) {
  return <DetailModal open onClose={onClose} title={<>{item.incident_number} — {item.title || (item.description || '').slice(0, 80)}</>}>
    <p>Status: {formatBadge(item.status)} | Severity: {item.severity || '—'} | Reported by: {staffName(staff, item.reported_by_staff_id)} | Date: {item.incident_date}</p>
    {item.description && <p><strong>Description:</strong> {item.description}</p>}
    {item.immediate_action && <p><strong>Immediate action:</strong> {item.immediate_action}</p>}
    {item.persons_involved && <p><strong>Persons involved:</strong> {item.persons_involved}</p>}
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      {!item.nc_id && <button type="button" className="secondary" onClick={() => createNc(item.id)}>Create NC</button>}
      {!item.capa_id && <button type="button" className="secondary" onClick={() => createCapa(item.id)}>Create CAPA</button>}
      {item.status !== 'closed' && <button type="button" className="secondary" onClick={() => closeIncident(item.id)}>Close incident</button>}
    </div>
    <h4 style={{ marginTop: 16 }}>Linked records</h4>
    {!item.links?.length ? <p>No linked records.</p> : <ul>{item.links.map((l: any) => <li key={l.id}>{l.source_module_key}/{l.source_record_type}#{l.source_record_id} → {l.target_module_key}/{l.target_record_type}#{l.target_record_id}{l.notes ? ` (${l.notes})` : ''}</li>)}</ul>}
  </DetailModal>;
}
