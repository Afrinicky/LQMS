import { FormEvent, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import PageHeader from '../components/ui/PageHeader';
import { KpiStrip, ChartCard, DonutChart, BarMeter, BarChart, CHART_COLORS, ModuleAlerts, DetailModal, RowMenu, RegisterSearch, NumberField } from '../components/ui';
import { FileText, Pencil, PackagePlus, Tag, Trash2, ShieldAlert, Star, Undo2, Scale, Plus, Search } from 'lucide-react';
import { StockLedger, IssueDesk, IssueRegister, StockTake, type LedgerRow } from './inventory/StockControl';
import { ForecastingPanel } from './inventory/Forecasting';
import { InventoryReports } from './inventory/Reports';
import SupplierEvaluationWorkspace from './inventory/SupplierEvaluation';
import { STOCK_STATUS_LABELS, NEEDS_ACTION } from '../../shared/constants/stockControl';

// Receiving is one job done in two places: the delivery is booked in, and the
// lots it created are then inspected, accepted and watched for expiry.
const RECEIVING_TABS = ['Goods receipt', 'Batches & lots'] as const;
// Counting the shelf and correcting what is on it are the same job seen from
// two ends, so they share a tab rather than competing for the top bar.
const STOCK_MANAGEMENT_TABS = ['Stock take', 'Stock movements'] as const;
import { useModules } from '../hooks/useModules';
import { api, API_BASE, getToken, ApiError } from '../services/api';
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
import { useCappedRows } from '../hooks/useCappedRows';
import { useTabParam } from '../hooks/useTabParam';
import type {
  Location, Section, Department, Staff, Supplier, EquipmentItem, InventoryItem, MonitoringRecord, SafetyIncident,
  EquipmentMaintenanceRecord, EquipmentBreakdown, MonitoringItem, MonitoringReading,
  EquipmentChecklistItem, EquipmentVerificationRecord, EquipmentCalibrationRecord, ReferenceStandard, EquipmentSchedule, EquipmentAdverseEvent, EquipmentCompetency, EquipmentDocumentLink,
  InventoryBatch, OperationsSummary, StockMovement, SupplierEvaluationRow, ItemDeletionImpact, SupplierDeletionImpact,
  SafetyEquipment, SafetyInspection, WasteDisposalRecord, HazardousChemical, StaffImmunization, FacilitiesSafetySummary,
  StorageInspection
} from '../../shared/types/api';
import {
  EQUIPMENT_CATEGORY_LABELS, EQUIPMENT_CATEGORY_HINTS,
  DUTY_LABELS, DUTY_CLAUSES, DUTY_HINTS, dutiesFor, categoryFromLegacy, isArchetype,
} from '../../shared/constants/equipment';
import type { ConfigOption } from '../../shared/constants/configLists';
import {
  BARCODE_SOURCE_LABELS, MOVEMENT_LABELS, STORAGE_KIND_LABELS, effectiveBarcode,
  SUPPLY_SOURCE_KIND_LABELS, normaliseProcurementPolicy, allowsSupplier, allowsStore,
} from '../../shared/constants/inventory';
import type { BarcodePolicy, ProcurementPolicy } from '../../shared/constants/inventory';
import type { SupplySource } from './StockSettingsPage';

// Where a supplier stands on evaluation, in one word. Ordered worst-first so
// the management view can simply sort by it.
const EVALUATION_TONE: Record<string, { label: string; style: Record<string, string> }> = {
  overdue: { label: 'overdue', style: { background: '#fde2e2', color: 'var(--danger)' } },
  never_evaluated: { label: 'never evaluated', style: { background: '#fff7df', color: '#6b4b05' } },
  current: { label: 'up to date', style: { background: '#e4f7ec', color: '#155c34' } },
  not_required: { label: 'not required', style: {} },
};
const evaluationRank = (s: { evaluation_status?: string }) =>
  ['overdue', 'never_evaluated', 'current', 'not_required'].indexOf(s.evaluation_status ?? 'not_required');
function evaluationBadge(s: { evaluation_status?: string }) {
  const tone = EVALUATION_TONE[s.evaluation_status ?? 'not_required'] ?? EVALUATION_TONE.not_required;
  return <span className="badge" style={tone.style}>{tone.label}</span>;
}

// An expiry date is only half the story — what a storekeeper needs to see is
// how close it is. Drawn once here so every register says it the same way.
function expiryCell(date?: string | null, status?: string | null) {
  if (!date) return <span className="muted">—</span>;
  const tone = status === 'expired' ? { background: '#fde2e2', color: 'var(--danger)' }
    : status === 'expiring_soon' ? { background: '#fff7df', color: '#6b4b05' } : null;
  return <>
    <span className="reg-primary nowrap">{String(date).slice(0, 10)}</span>
    {tone && <span className="badge" style={tone}>{String(status).replace(/_/g, ' ')}</span>}
  </>;
}

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

// The archetype an equipment-category option is pinned to (its behaviour).
function archetypeOfOption(options: ConfigOption[], value: string): string {
  const found = options.find(o => o.value === value);
  const a = found?.extra && (found.extra as any).archetype;
  return isArchetype(a) ? a : (isArchetype(value) ? value : 'other');
}
// How an item's category reads on its profile: the configured label if we can
// see it, otherwise the archetype's standard name.
function equipmentCategoryLabel(item: { equipment_category?: string | null; equipment_archetype?: string | null; equipment_class?: string | null; name?: string | null; category?: string | null }): string {
  const archetype = item.equipment_archetype ?? (isArchetype(item.equipment_category) ? item.equipment_category! : categoryFromLegacy(item.equipment_class, item.name, item.category));
  const base = EQUIPMENT_CATEGORY_LABELS[archetype as never] ?? 'Equipment';
  const value = item.equipment_category;
  if (value && !isArchetype(value)) return value.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  return base;
}

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
  // Configurable dropdowns — categories, criticality, condition — come from
  // Settings, so the laboratory's own vocabulary drives the form.
  const [optionLists, setOptionLists] = useState<Record<string, ConfigOption[]>>({});
  const opt = (key: string) => (optionLists[key] ?? []).filter(o => o.is_active);
  useEffect(() => {
    Promise.all(['equipment_category', 'equipment_criticality', 'equipment_condition']
      .map(k => api<ConfigOption[]>(`/config/option-lists/${k}`).then(o => [k, o] as const).catch(() => [k, []] as const)))
      .then(pairs => setOptionLists(Object.fromEntries(pairs)));
  }, []);
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
          {can('equipment.register', 'export') && <button type="button" className="secondary" disabled={!!regBusy} title="Download the equipment register as an Excel workbook" onClick={() => downloadEquipmentRegister('/equipment/register/export', 'Equipment_Register.xlsx')}>{regBusy === '/equipment/register/export' ? 'Exporting…' : 'Export'}</button>}
          {can('equipment.register', 'create') && <>
            <button type="button" className="secondary" disabled={!!regBusy} title="Upload a completed equipment register workbook" onClick={() => equipImportRef.current?.click()}>{regBusy === 'import' ? 'Importing…' : 'Import'}</button>
            <input ref={equipImportRef} type="file" accept=".xlsx,.xls" style={{ display: 'none' }} onChange={e => { const f = e.target.files?.[0]; if (f) void importEquipmentRegister(f); }} />
          </>}
          <select value={bcSize} onChange={e => setBcSize(e.target.value)} title="Barcode label size">{LABEL_PRESETS.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}</select>
          {can('equipment.register', 'print') && <button type="button" className="secondary" title="Print Code 128 barcode asset tags for all equipment" onClick={() => { const p = LABEL_PRESETS.find(x => x.key === bcSize) || LABEL_PRESETS[1]; printLabelSheet(equipment.map(it => ({ barcodeValue: it.equipment_number, title: it.name, lines: [it.equipment_number, it.serial_number ? `S/N ${it.serial_number}` : ''].filter(Boolean) })), { widthMm: p.widthMm, heightMm: p.heightMm, title: 'Equipment barcode labels' }); }}>🏷️ Print barcode labels</button>}
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
        <label>Equipment category<select value={equipForm.equipmentCategory} onChange={e => setEquipForm({ ...equipForm, equipmentCategory: e.target.value })}>
          {opt('equipment_category').map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select><small className="muted">{EQUIPMENT_CATEGORY_HINTS[(archetypeOfOption(opt('equipment_category'), equipForm.equipmentCategory)) as never] ?? ''} <Link to="/settings/config-lists">Manage categories</Link></small></label>
        <label>Manufacturer<input value={equipForm.manufacturer} onChange={e => setEquipForm({ ...equipForm, manufacturer: e.target.value })} /></label>
        <label>Model<input value={equipForm.model} onChange={e => setEquipForm({ ...equipForm, model: e.target.value })} /></label>
        <label>Serial number<input value={equipForm.serialNumber} onChange={e => setEquipForm({ ...equipForm, serialNumber: e.target.value })} /></label>
        <label>Country of origin<input value={equipForm.countryOfOrigin} onChange={e => setEquipForm({ ...equipForm, countryOfOrigin: e.target.value })} /></label>
        <label>Condition received<select value={equipForm.conditionReceived} onChange={e => setEquipForm({ ...equipForm, conditionReceived: e.target.value })}><option value="">—</option>{opt('equipment_condition').map(c => <option key={c.value} value={c.value}>{c.label}</option>)}</select></label>
        <label>Criticality<select value={equipForm.criticality} onChange={e => setEquipForm({ ...equipForm, criticality: e.target.value })}><option value="">—</option>{opt('equipment_criticality').map(c => <option key={c.value} value={c.value}>{c.label}</option>)}</select></label>
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
          <div><h4>Identity</h4>{dv('Unique identifier', item.equipment_number)}{dv('Equipment category', equipmentCategoryLabel(item))}{dv('Manufacturer', item.manufacturer)}{dv('Model', item.model)}{dv('Serial number', item.serial_number)}{dv('Country of origin', item.country_of_origin)}{dv('Condition received', item.condition_received)}{dv('Criticality', item.criticality?.replace(/_/g, ' '))}</div>
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
type InventoryItemDetail = InventoryItem & { batches?: InventoryBatch[]; movements?: StockMovement[] };

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
  const [itemForm, setItemForm] = useState({
    name: '', category: '', supplierId: '', storageLocationId: '', sectionId: '', quantity: 0, unit: '',
    minimumStock: 0, reorderLevel: 0, expiryDate: '', storageRequirement: '', status: 'available',
    manufacturer: '', catalogueNumber: '', barcodeSource: 'system', productBarcode: '',
  });
  // Where stock lives, and what a stock item may be called — both the
  // laboratory's own, configured in Settings → Stock & Storage and Dropdown Lists.
  const [storagePlaces, setStoragePlaces] = useState<Array<{ id: number; path: string; kind: string }>>([]);
  const [categories, setCategories] = useState<ConfigOption[]>([]);
  const [units, setUnits] = useState<ConfigOption[]>([]);
  // Why stock leaves the store, in the laboratory's own words — configured in
  // Settings → Dropdown Lists rather than typed afresh at every counter.
  const [issueReasons, setIssueReasons] = useState<ConfigOption[]>([]);
  const [movementReasons, setMovementReasons] = useState<ConfigOption[]>([]);
  // Where stock can be issued to beyond the laboratory's own benches, and
  // where deliveries can come from besides a supplier. Both are the
  // laboratory's own registers, configured in Settings.
  const [issueDestinations, setIssueDestinations] = useState<ConfigOption[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [supplySources, setSupplySources] = useState<SupplySource[]>([]);
  const [procurement, setProcurement] = useState<ProcurementPolicy>({ mode: 'direct', defaultSourceType: 'supplier' });
  const [barcodePolicy, setBarcodePolicy] = useState<BarcodePolicy>({ defaultSource: 'system', allowPerItem: true });
  const [regBusy, setRegBusy] = useState('');
  const [regResult, setRegResult] = useState<{ created: number; updated: number; skipped: number; errors: string[] } | null>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const supplierImportRef = useRef<HTMLInputElement>(null);
  // Only the settled query lives here. The box holds what is being typed, so
  // a keystroke does not re-render this whole page — see RegisterSearch.
  const [itemQuery, setItemQuery] = useState('');
  const [fefoWarning, setFefoWarning] = useState<{ message: string; batchId: number } | null>(null);
  const [recvTab, setRecvTab] = useState<typeof RECEIVING_TABS[number]>('Goods receipt');
  const [manageTab, setManageTab] = useState<typeof STOCK_MANAGEMENT_TABS[number]>('Stock take');
  // A link to a batch lands on the bench that holds it, not on the module's
  // front page: ?tab=Receiving&subtab=Batches & lots.
  useTabParam(RECEIVING_TABS as unknown as string[], t => setRecvTab(t as typeof RECEIVING_TABS[number]), 'subtab');
  useTabParam(STOCK_MANAGEMENT_TABS as unknown as string[], t => setManageTab(t as typeof STOCK_MANAGEMENT_TABS[number]), 'subtab');
  // Bumped whenever stock moves, so every panel showing a balance re-reads it.
  const [stockKey, setStockKey] = useState(0);
  const [ledgerRows, setLedgerRows] = useState<LedgerRow[]>([]);
  const [detailMode, setDetailMode] = useState<'view' | 'edit'>('view');
  const [removing, setRemoving] = useState<ItemDeletionImpact | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [movements, setMovements] = useState<StockMovement[]>([]);
  const [moveQuery, setMoveQuery] = useState('');
  const [supplierTab, setSupplierTab] = useState('Register');
  const [supplierQuery, setSupplierQuery] = useState('');
  const [evaluations, setEvaluations] = useState<SupplierEvaluationRow[]>([]);
  const [editingSupplier, setEditingSupplier] = useState<Supplier | null>(null);
  const [removingSupplier, setRemovingSupplier] = useState<SupplierDeletionImpact | null>(null);
  // Corrections to what is already recorded. Each is deliberately a separate
  // piece of state, because each asks a different question before it acts.
  const [editingBatch, setEditingBatch] = useState<InventoryBatch | null>(null);
  const [reversingBatch, setReversingBatch] = useState<InventoryBatch | null>(null);
  const [reversingMovement, setReversingMovement] = useState<StockMovement | null>(null);
  // The register is searched over what a storekeeper can see on the shelf —
  // the name, the code, either barcode, the category and where it is kept.
  const itemRows = useMemo(() => {
    const q = itemQuery.trim().toLowerCase();
    if (!q) return items;
    return items.filter(i => [i.name, i.item_code, i.product_barcode, i.category, i.storage_path, i.manufacturer, i.catalogue_number]
      .some(v => String(v ?? '').toLowerCase().includes(q)));
  }, [items, itemQuery]);
  const shownItems = useCappedRows(itemRows);
  const shownBatches = useCappedRows(batches);
  const movementRows = useMemo(() => {
    const q = moveQuery.trim().toLowerCase();
    if (!q) return movements;
    return movements.filter(m => [m.item_name, m.item_code, m.batch_number, m.lot_number, m.issued_to_section_name, m.received_by_name, m.reason, m.movement_type]
      .some(v => String(v ?? '').toLowerCase().includes(q)));
  }, [movements, moveQuery]);
  const shownMovements = useCappedRows(movementRows);
  // The store's position, worked out once for the dashboard.
  const stockSummary = useMemo(() => {
    const count = (st: string) => ledgerRows.filter(r => r.status === st).length;
    const byStatus = (['stockout', 'blocked', 'critical', 'low', 'adequate', 'overstock', 'unknown'] as const)
      .map((st, i) => ({ label: STOCK_STATUS_LABELS[st], value: count(st), color: CHART_COLORS[i % CHART_COLORS.length] }))
      .filter(d => d.value > 0);
    return {
      needOrdering: ledgerRows.filter(r => NEEDS_ACTION.includes(r.status)).length,
      unavailable: ledgerRows.filter(r => r.issuable <= 0).length,
      expiring: ledgerRows.filter(r => ['expired', 'expiring_soon'].includes(r.expiry_status ?? '')).length,
      quarantined: ledgerRows.filter(r => r.quarantined > 0).length,
      byStatus,
      urgent: [...ledgerRows].filter(r => NEEDS_ACTION.includes(r.status))
        .sort((a, b) => a.priority - b.priority || (a.months_of_stock ?? 0) - (b.months_of_stock ?? 0))
        .slice(0, 8)
        .map(r => ({ label: `${r.name} — ${r.months_of_stock == null ? 'no use recorded' : `${r.months_of_stock} months left`}`, value: Math.max(1, Math.round((r.amc || 1) * 3 - r.issuable)) })),
    };
  }, [ledgerRows]);

  const supplierRows = useMemo(() => {
    const q = supplierQuery.trim().toLowerCase();
    if (!q) return suppliers;
    return suppliers.filter(sp => [sp.name, sp.supplier_code, sp.contact_person, sp.contact, sp.phone, sp.email, sp.item_category]
      .some(v => String(v ?? '').toLowerCase().includes(q)));
  }, [suppliers, supplierQuery]);
  const [batchForm, setBatchForm] = useState({
    itemId: '', batchNumber: '', lotNumber: '', supplierId: '', quantityReceived: 0, quantityAvailable: 0,
    dateReceived: '', expiryDate: '', storageLocationId: '', productBarcode: '',
    sourceType: 'supplier' as 'supplier' | 'store', sourceId: '', reference: '', unitCost: '',
  });
  const [receiptNote, setReceiptNote] = useState<string | null>(null);
  const [movementForm, setMovementForm] = useState({ batchId: '', movementType: 'issue', quantity: 0, movementDate: '', issuedToSectionId: '', receivedByStaffId: '', reason: '', reasonNote: '' });
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
      api<StockMovement[]>('/supplier-inventory/movements').then(setMovements).catch(() => setMovements([]));
      api<{ rows: LedgerRow[] }>('/supplier-inventory/ledger').then(d => setLedgerRows(d.rows)).catch(() => setLedgerRows([]));
      api<SupplierEvaluationRow[]>('/supplier-inventory/supplier-evaluations').then(setEvaluations).catch(() => setEvaluations([]));
      api<Array<{ id: number; path: string; kind: string }>>('/supplier-inventory/storage-locations').then(setStoragePlaces).catch(() => setStoragePlaces([]));
      api<ConfigOption[]>('/config/option-lists/inventory_category').then(setCategories).catch(() => setCategories([]));
      api<ConfigOption[]>('/config/option-lists/inventory_unit').then(setUnits).catch(() => setUnits([]));
      api<ConfigOption[]>('/config/option-lists/stock_issue_reason').then(setIssueReasons).catch(() => setIssueReasons([]));
      api<ConfigOption[]>('/config/option-lists/stock_movement_reason').then(setMovementReasons).catch(() => setMovementReasons([]));
      api<ConfigOption[]>('/config/option-lists/stock_issue_destination').then(setIssueDestinations).catch(() => setIssueDestinations([]));
      api<Department[]>('/departments').then(setDepartments).catch(() => setDepartments([]));
      api<SupplySource[]>('/supplier-inventory/supply-sources').then(setSupplySources).catch(() => setSupplySources([]));
      api<ProcurementPolicy>('/supplier-inventory/procurement-policy')
        .then(p => { setProcurement(normaliseProcurementPolicy(p)); setBatchForm(f => ({ ...f, sourceType: normaliseProcurementPolicy(p).defaultSourceType })); })
        .catch(() => undefined);
      api<BarcodePolicy>('/supplier-inventory/barcode-policy')
        .then(p => { setBarcodePolicy(p); setItemForm(f => ({ ...f, barcodeSource: p.defaultSource })); })
        .catch(() => undefined);
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

  const categoryLabel = (value?: string) => categories.find(c => c.value === value)?.label ?? value ?? '—';

  async function openDetail(id: number, mode: 'view' | 'edit' = 'view') {
    try { setSelected(await api<InventoryItemDetail>(`/supplier-inventory/items/${id}`)); setDetailMode(mode); }
    catch (e) { setError((e as Error).message); }
  }

  // Removing anything asks what it would cost before it asks whether to do it.
  async function openItemRemoval(item: { id: number; name: string } | null) {
    if (!item) return;
    setError(null); setNotice(null);
    try { setRemoving(await api<ItemDeletionImpact>(`/supplier-inventory/items/${item.id}/deletion-impact`)); }
    catch (e) { setError((e as Error).message); }
  }
  async function openSupplierRemoval(sup: Supplier) {
    setError(null); setNotice(null);
    try { setRemovingSupplier(await api<SupplierDeletionImpact>(`/supplier-inventory/suppliers/${sup.id}/deletion-impact`)); }
    catch (e) { setError((e as Error).message); }
  }

  async function submitItem(e: FormEvent) {
    e.preventDefault(); setError(null);
    try {
      await api('/supplier-inventory/items', { method: 'POST', body: JSON.stringify(itemForm) });
      setItemForm({
        name: '', category: '', supplierId: '', storageLocationId: '', sectionId: '', quantity: 0, unit: '',
        minimumStock: 0, reorderLevel: 0, expiryDate: '', storageRequirement: '', status: 'available',
        manufacturer: '', catalogueNumber: '', barcodeSource: barcodePolicy.defaultSource, productBarcode: '',
      });
      await load(); setTab('Item Register');
    } catch (e) { setError((e as Error).message); }
  }

  // The register as a spreadsheet — the laboratory's own rows, not a blank
  // template: exporting gives back exactly what importing accepts, so the file
  // that comes out can be edited and put straight back in.
  async function downloadFile(path: string, fallback: string, busyKey: string) {
    setError(null); setRegBusy(busyKey); setRegResult(null);
    try {
      const res = await fetch(`${API_BASE}${path}`, { headers: getToken() ? { Authorization: `Bearer ${getToken()}` } : undefined });
      if (!res.ok) throw new Error((await res.json().catch(() => ({ error: res.statusText }))).error ?? res.statusText);
      const named = (res.headers.get('Content-Disposition') || '').match(/filename="?([^"]+)"?/);
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url; a.download = named ? named[1] : fallback;
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    } catch (e) { setError((e as Error).message); }
    finally { setRegBusy(''); }
  }
  const downloadRegister = () => downloadFile('/supplier-inventory/items/export', 'Stock_Item_Register.xlsx', 'export');

  async function importRegister(file: File, path = '/supplier-inventory/items/import') {
    setError(null); setRegBusy('import'); setRegResult(null);
    try {
      const fd = new FormData(); fd.append('file', file);
      const res = await fetch(`${API_BASE}${path}`, {
        method: 'POST', headers: getToken() ? { Authorization: `Bearer ${getToken()}` } : undefined, body: fd,
      });
      const data = await res.json().catch(() => ({ error: res.statusText }));
      if (!res.ok) throw new Error(data.error ?? res.statusText);
      setRegResult(data);
      await load();
    } catch (e) { setError((e as Error).message); }
    finally { setRegBusy(''); if (importRef.current) importRef.current.value = ''; }
  }

  // A scan is answered by the register, not by the list on screen — the code on
  // the box and the code SECH_LIMS printed both resolve to the same item.
  async function scanStock(code: string) {
    setError(null);
    try {
      const hit = await api<{ kind: string; id: number; itemId?: number }>(`/supplier-inventory/scan/${encodeURIComponent(code.trim())}`);
      await openDetail(hit.kind === 'batch' ? (hit.itemId ?? hit.id) : hit.id);
    } catch (e) { setError((e as Error).message); }
  }

  /**
   * Scanning a box at the receiving bench.
   *
   * A GS1 symbol carries the product, the lot and the expiry together, so the
   * form is filled from the box rather than read off it and retyped — which is
   * where a mistyped lot number stops being traceable. A plain barcode only
   * says which product it is, and that much is still filled in.
   */
  async function scanForReceipt(code: string) {
    setError(null); setReceiptNote(null);
    try {
      const hit = await api<{ kind: string; id: number; itemId?: number; name?: string; batchNumber?: string | null; parsed?: { lot?: string | null; expiry?: string | null } }>(
        `/supplier-inventory/scan/${encodeURIComponent(code.trim())}`);
      const itemId = hit.kind === 'batch' ? hit.itemId : hit.id;
      setBatchForm(f => ({
        ...f,
        itemId: itemId ? String(itemId) : f.itemId,
        batchNumber: hit.parsed?.lot || f.batchNumber,
        lotNumber: hit.parsed?.lot || f.lotNumber,
        expiryDate: hit.parsed?.expiry || f.expiryDate,
        productBarcode: code.trim(),
        dateReceived: f.dateReceived || new Date().toISOString().slice(0, 10),
      }));
      setReceiptNote(hit.kind === 'batch'
        ? `That is ${hit.name} — batch ${hit.batchNumber || hit.id}, which is already on the register. Receiving it again adds a second delivery of the same lot.`
        : `${hit.name}${hit.parsed?.lot ? ` — lot ${hit.parsed.lot}` : ''}${hit.parsed?.expiry ? `, expiring ${hit.parsed.expiry}` : ''}.`);
    } catch (e) {
      // An unknown product still hands back whatever the symbol said, so a
      // storekeeper is not made to read the lot off the box by eye.
      const parsed = e instanceof ApiError ? (e.data.parsed as { lot?: string; expiry?: string } | null) : null;
      if (parsed?.lot || parsed?.expiry) {
        setBatchForm(f => ({ ...f, batchNumber: parsed.lot || f.batchNumber, lotNumber: parsed.lot || f.lotNumber, expiryDate: parsed.expiry || f.expiryDate, productBarcode: code.trim() }));
        setReceiptNote('That product is not on the register yet — register it first, then choose it above. The lot and expiry from the box have been kept.');
      } else setError((e as Error).message);
    }
  }

  async function submitBatch(e: FormEvent) {
    e.preventDefault(); setError(null);
    if (!batchForm.itemId) return setError('Select an item');
    try {
      await api(`/supplier-inventory/items/${batchForm.itemId}/batches`, { method: 'POST', body: JSON.stringify(batchForm) });
      setBatchForm(f => ({
        itemId: '', batchNumber: '', lotNumber: '', supplierId: '', quantityReceived: 0, quantityAvailable: 0,
        dateReceived: '', expiryDate: '', storageLocationId: '', productBarcode: '',
        sourceType: f.sourceType, sourceId: '', reference: '', unitCost: '',
      }));
      setReceiptNote(null);
      setStockKey(k => k + 1);
      await load();
    } catch (e) { setError((e as Error).message); }
  }

  async function submitMovement(e: FormEvent, overrideFefo = false) {
    e.preventDefault(); setError(null);
    if (!movementForm.batchId) return setError('Select a batch');
    try {
      await api(`/supplier-inventory/batches/${movementForm.batchId}/movement`, { method: 'POST', body: JSON.stringify({ ...movementForm, overrideFefo }) });
      setMovementForm({ batchId: '', movementType: 'issue', quantity: 0, movementDate: '', issuedToSectionId: '', receivedByStaffId: '', reason: '', reasonNote: '' });
      setFefoWarning(null);
      setStockKey(k => k + 1);
      await load();
    } catch (err) {
      // 409 is not a failure — it is the store telling the person there is an
      // older box behind this one. They may still have a reason to skip it,
      // and the reason is written into the movement when they do.
      if (err instanceof ApiError && err.status === 409 && err.data.fefo) {
        setFefoWarning({ message: err.message, batchId: (err.data.fefo as { batchId: number }).batchId });
      } else setError((err as Error).message);
    }
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
    <PageHeader eyebrow="Supplier &amp; Inventory Management" title="Supplier &amp; Inventory Management" subtitle="Suppliers, stock items, receiving, issuing, stock counts and expiry control." />
    {error && <div className="card" style={{ color: 'var(--danger)' }}>{error}</div>}
    {notice && <div className="card notice-ok" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <span style={{ flex: 1 }}>{notice}</span>
      <button type="button" className="secondary tiny" onClick={() => setNotice(null)}>Dismiss</button>
    </div>}
    {/* The store's day, in the order it runs: what is held, what came in, what
        is going out, what the count found, and the trail of all of it. */}
    {tabBarFor('supplier_inventory')(tab, ['Dashboard', 'Stock Ledger', 'Issuing', 'Receiving', 'Item Register', 'New Item', 'Stock Management', 'Suppliers', 'Storage Inspections', 'Barcode Labels', 'Forecasting'], setTab)}

    {/* The store's own position, not a count of catalogue rows: can the bench
        be served today, and what is about to be lost off the shelf. The
        reporting that used to sit on its own tab is the second half of the
        same question, so it is read here rather than hunted for. */}
    {tab === 'Dashboard' && <><ModuleAlerts moduleKey="supplier_inventory" /><KpiStrip items={[
      { label: 'Items held', value: ledgerRows.length, onClick: () => setTab('Stock Ledger') },
      { label: 'Below reorder level', value: stockSummary.needOrdering, tone: stockSummary.needOrdering ? 'warning' : undefined, onClick: () => setTab('Stock Ledger') },
      { label: 'Nothing available to issue', value: stockSummary.unavailable, tone: stockSummary.unavailable ? 'danger' : undefined, onClick: () => setTab('Stock Ledger') },
      { label: 'Expiring or expired', value: stockSummary.expiring, tone: stockSummary.expiring ? 'warning' : undefined, onClick: () => { setTab('Receiving'); setRecvTab('Batches & lots'); } },
      { label: 'Quarantined', value: stockSummary.quarantined, onClick: () => { setTab('Receiving'); setRecvTab('Batches & lots'); } },
    ]} />
    <div className="grid cols-2" style={{ marginTop: 18 }}>
      <ChartCard title="Stock status" subtitle="Every item by what it can actually supply">
        <DonutChart centerLabel="Items" data={stockSummary.byStatus} />
      </ChartCard>
      <ChartCard title="Replenishment priority" subtitle="Ranked by how badly a shortage would hurt — the bar is roughly the quantity for three months' cover">
        {stockSummary.urgent.length === 0
          ? <p className="muted">Nothing is below its reorder level.</p>
          : <BarMeter data={stockSummary.urgent} />}
      </ChartCard>
    </div>
    {can('supplier_inventory.reports', 'view') && <div style={{ marginTop: 22 }}>
      <InventoryReports refreshKey={stockKey} />
    </div>}</>}

    {tab === 'Item Register' && <div className="card">
      <div className="section-head" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <h3 style={{ margin: 0 }}>Stock item register</h3>
        <div className="reg-head-actions" style={{ marginLeft: 'auto' }}>
          {can('supplier_inventory.stock', 'export') && <button type="button" className="secondary" disabled={regBusy === 'export'}
            title="Download the register the laboratory actually holds — the same file the import accepts"
            onClick={downloadRegister}>{regBusy === 'export' ? 'Exporting…' : 'Export register'}</button>}
          {can('supplier_inventory.stock', 'create') && <>
            <button type="button" disabled={regBusy === 'import'} onClick={() => importRef.current?.click()}>
              {regBusy === 'import' ? 'Importing…' : 'Import'}
            </button>
            <input ref={importRef} type="file" accept=".xlsx,.xls" style={{ display: 'none' }}
              onChange={e => { const f = e.target.files?.[0]; if (f) void importRegister(f); }} />
          </>}
          {can('supplier_inventory', 'print') && <button type="button" className="secondary" title="Print Code 128 labels — each item's own barcode, whether the product's or one SECH_LIMS generated" onClick={() => printLabelSheet(itemRows.map(it => ({ barcodeValue: effectiveBarcode(it), title: it.name, lines: [effectiveBarcode(it), it.storage_path || it.category || ''].filter(Boolean) })), { widthMm: 50, heightMm: 25, title: 'Stock barcode labels' })}>🏷️ Print barcode labels</button>}
        </div>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>Rows are matched on item code — a code the register already holds is updated, a blank one is created. Export first, edit that file, import it back.</p>
      {regResult && <div className="notice-ok">
        Import complete — <strong>{regResult.created}</strong> created, <strong>{regResult.updated}</strong> updated, <strong>{regResult.skipped}</strong> skipped
        {regResult.errors.length > 0 && <ul className="link-list">{regResult.errors.slice(0, 8).map((er, i) => <li key={i}>{er}</li>)}</ul>}
      </div>}
      <div className="reg-head-actions" style={{ margin: '4px 0 10px', gap: 10 }}>
        <RegisterSearch style={{ flex: '1 1 240px' }} onQuery={setItemQuery}
          placeholder="Search name, code, category, storage place…" />
        <div style={{ flex: '1 1 240px' }}><BarcodeScanner placeholder="Scan a stock item barcode…" autoFocus={false} onScan={scanStock} /></div>
      </div>
      {loading ? <p>Loading…</p> : items.length === 0 ? <p>No items yet.</p> : itemRows.length === 0 ? <p>Nothing matches “{itemQuery}”.</p> :
        <div>
        <div className="table-scroll"><table className="data-table reg-table"><thead><tr>
          <th>Item</th><th>Category</th><th>Storage location</th><th>On hand</th><th>Min / reorder</th><th>Expires</th><th className="reg-actions-col"></th>
        </tr></thead><tbody>
          {/* The whole row opens the item — clicking a record is how a record
              is opened, and the "Open" button was the only thing that worked. */}
          {shownItems.shown.map(i => <tr key={i.id} className={`row-clickable${i.is_active === 0 ? ' row-retired' : ''}`} {...focusAttr('inventory_items', i.id)}
            onClick={() => openDetail(i.id)} tabIndex={0} role="button"
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(i.id); } }}>
            <td>
              <span className="reg-primary">{i.name}{i.is_active === 0 && <span className="badge inactive">withdrawn</span>}</span>
              <span className="reg-sub">{effectiveBarcode(i) || i.item_code}{i.barcode_source === 'product' ? ' · product barcode' : ''}{i.manufacturer ? ` · ${i.manufacturer}` : ''}</span>
            </td>
            <td>{categoryLabel(i.category)}</td>
            <td>{i.storage_path || <span className="muted">—</span>}</td>
            <td>
              <span className="reg-primary">{i.stock_on_hand ?? i.quantity} {i.unit || ''}</span>
              {i.low_stock && <span className="badge warn">low</span>}
              {(i.batch_count ?? 0) > 0 && <span className="reg-sub">{i.batch_count} batch{i.batch_count === 1 ? '' : 'es'}</span>}
            </td>
            <td>{i.minimum_stock || 0} / {i.reorder_level || 0}</td>
            <td>{expiryCell(i.effective_expiry ?? i.expiry_date, i.expiry_status)}</td>
            <td className="reg-actions-col" onClick={e => e.stopPropagation()}>
              <RowMenu label={`Manage ${i.name}`}>{close => <>
                <button type="button" role="menuitem" onClick={() => { close(); openDetail(i.id); }}><FileText size={14} /> Open</button>
                {can('supplier_inventory', 'edit') && <button type="button" role="menuitem" onClick={() => { close(); openDetail(i.id, 'edit'); }}><Pencil size={14} /> Edit details</button>}
                {can('supplier_inventory', 'create') && <button type="button" role="menuitem" onClick={() => { close(); setBatchForm(f => ({ ...f, itemId: String(i.id) })); setRecvTab('Goods receipt'); setTab('Receiving'); }}><PackagePlus size={14} /> Book in a delivery</button>}
                {can('supplier_inventory', 'print') && <button type="button" role="menuitem" onClick={() => { close(); printLabelSheet([{ barcodeValue: effectiveBarcode(i), title: i.name, lines: [effectiveBarcode(i), i.storage_path || ''].filter(Boolean) }], { widthMm: 50, heightMm: 25, title: i.name }); }}><Tag size={14} /> Print its label</button>}
                {can('supplier_inventory', 'void_archive') && <button type="button" role="menuitem" className="danger" onClick={() => { close(); void openItemRemoval(i); }}><Trash2 size={14} /> Remove…</button>}
              </>}</RowMenu>
            </td>
          </tr>)}
        </tbody></table></div>
        {shownItems.hidden > 0 && <p className="muted list-capped">
          Showing the first {shownItems.shown.length.toLocaleString()} of {shownItems.total.toLocaleString()} items.
          Search to narrow it down — the register is not cut short, only what is drawn at once.
        </p>}
        </div>}
    </div>}

    {tab === 'New Item' && <div className="card">
      <h3>Register a stock item</h3>
      <form className="form" onSubmit={submitItem}>
        <label>Name<input value={itemForm.name} onChange={e => setItemForm({ ...itemForm, name: e.target.value })} required /></label>
        <label>Category<select value={itemForm.category} onChange={e => setItemForm({ ...itemForm, category: e.target.value })} required>
          <option value="">Select the category</option>
          {categories.map(c => <option key={c.id} value={c.value}>{c.label}</option>)}
        </select>{categories.length === 0 && <span className="muted">No categories yet — add them in Settings → Dropdown Lists.</span>}</label>
        <label>Unit of measure<select value={itemForm.unit} onChange={e => setItemForm({ ...itemForm, unit: e.target.value })} required>
          <option value="">Select the unit of measure</option>
          {units.map(u => <option key={u.id} value={u.value}>{u.label}</option>)}
        </select></label>
        <label>Manufacturer<input value={itemForm.manufacturer} onChange={e => setItemForm({ ...itemForm, manufacturer: e.target.value })} /></label>
        <label>Catalogue number<input value={itemForm.catalogueNumber} onChange={e => setItemForm({ ...itemForm, catalogueNumber: e.target.value })} placeholder="Manufacturer's reference" /></label>
        <label>Supplier<select value={itemForm.supplierId} onChange={e => setItemForm({ ...itemForm, supplierId: e.target.value })}><option value="">Select the supplier</option>{suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label>Storage location<select value={itemForm.storageLocationId} onChange={e => setItemForm({ ...itemForm, storageLocationId: e.target.value })}>
          <option value="">Select a store, shelf or fridge</option>
          {storagePlaces.map(pl => <option key={pl.id} value={pl.id}>{pl.path}{pl.kind && pl.kind !== 'shelf' ? ` (${STORAGE_KIND_LABELS[pl.kind] ?? pl.kind})` : ''}</option>)}
        </select>{storagePlaces.length === 0 && <span className="muted">No storage places yet — add the stores, shelves and fridges in Settings → Stock &amp; Storage.</span>}</label>
        <label>Unit<select value={itemForm.sectionId} onChange={e => setItemForm({ ...itemForm, sectionId: e.target.value })}><option value="">Select the unit</option>{sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label>Minimum stock<NumberField value={itemForm.minimumStock} onValue={n => setItemForm({ ...itemForm, minimumStock: n ?? 0 })} min={0} /></label>
        <label>Reorder level<NumberField value={itemForm.reorderLevel} onValue={n => setItemForm({ ...itemForm, reorderLevel: n ?? 0 })} min={0} /></label>
        <label>Storage requirement<input value={itemForm.storageRequirement} onChange={e => setItemForm({ ...itemForm, storageRequirement: e.target.value })} placeholder="e.g. 2-8°C" /></label>
        <label>Status<select value={itemForm.status} onChange={e => setItemForm({ ...itemForm, status: e.target.value })}><option value="available">Available</option><option value="reserved">Reserved</option><option value="unavailable">Unavailable</option></select></label>

        {/* Some boxes arrive with a barcode already on them and some do not.
            Which one this item answers to is decided here, once. */}
        <fieldset className="bc-pick">
          <legend>Barcode</legend>
          {barcodePolicy.allowPerItem
            ? <div className="bc-pick-row">
                {(['system', 'product'] as const).map(src => <label key={src} className={itemForm.barcodeSource === src ? 'on' : ''}>
                  <input type="radio" name="barcodeSource" value={src} checked={itemForm.barcodeSource === src}
                    onChange={() => setItemForm({ ...itemForm, barcodeSource: src })} />
                  <span>{BARCODE_SOURCE_LABELS[src]}</span>
                </label>)}
              </div>
            : <p className="muted">This laboratory uses <strong>{BARCODE_SOURCE_LABELS[barcodePolicy.defaultSource]}</strong> for every item. Change that in Settings → Stock &amp; Storage.</p>}
          {itemForm.barcodeSource === 'product'
            ? <>
                <label>Product barcode<input value={itemForm.productBarcode} onChange={e => setItemForm({ ...itemForm, productBarcode: e.target.value })} required placeholder="Scan or type the barcode on the box"
                  onKeyDown={e => { if (e.key === 'Enter') e.preventDefault(); }} /></label>
                <BarcodeScanner placeholder="…or scan it here" autoFocus={false} onScan={code => setItemForm(f => ({ ...f, productBarcode: code.trim() }))} />
              </>
            : <label>Product barcode <span className="muted">(optional — recorded so a scan of the box still finds the item)</span>
                <input value={itemForm.productBarcode} onChange={e => setItemForm({ ...itemForm, productBarcode: e.target.value })} />
              </label>}
        </fieldset>
        <button type="submit">Register the item</button>
      </form>
    </div>}

    {tab === 'Stock Ledger' &&
      <StockLedger refreshKey={stockKey} onOpenItem={id => void openDetail(id)} />}

    {tab === 'Issuing' && <>
      <IssueDesk items={ledgerRows} sections={sections} staff={staff} departments={departments}
        reasons={issueReasons} destinations={issueDestinations}
        onIssued={() => { setStockKey(k => k + 1); void load(); }} />
      <IssueRegister refreshKey={stockKey} canVoid={can('supplier_inventory.stock', 'void_archive')}
        onChanged={() => { setStockKey(k => k + 1); void load(); }} />
    </>}

    {/* Counting the shelf, and putting right what the count found. */}
    {tab === 'Stock Management' && <div className="card" style={{ paddingBottom: 6 }}>
      <div className="reg-seg" role="tablist" aria-label="Stock management">
        {STOCK_MANAGEMENT_TABS.map(t => <button key={t} type="button" role="tab" aria-selected={manageTab === t}
          className={manageTab === t ? 'on' : ''} onClick={() => setManageTab(t)}>{t}</button>)}
      </div>
    </div>}

    {tab === 'Stock Management' && manageTab === 'Stock take' &&
      <StockTake places={storagePlaces} staff={staff} items={ledgerRows} categories={categories}
        canVoid={can('supplier_inventory.stock', 'void_archive')}
        onPosted={() => { setStockKey(k => k + 1); void load(); }} />}

    {/* Receiving is booking the delivery in and then dealing with the lots it
        created — one job, so one tab with two benches. */}
    {tab === 'Receiving' && <div className="card" style={{ paddingBottom: 6 }}>
      <div className="reg-seg" role="tablist" aria-label="Receiving">
        {RECEIVING_TABS.map(t => <button key={t} type="button" role="tab" aria-selected={recvTab === t}
          className={recvTab === t ? 'on' : ''} onClick={() => setRecvTab(t)}>{t}</button>)}
      </div>
    </div>}

    {tab === 'Receiving' && recvTab === 'Goods receipt' && <div>
      <div className="card">
        <h3>Book in a delivery</h3>
        <p className="muted" style={{ marginTop: 0 }}>
          A delivery is booked in against its lot and expiry — the level traceability runs at. Scanning the box
          fills in the product, the lot and the expiry.
        </p>
        <div style={{ margin: '0 0 12px' }}>
          <BarcodeScanner placeholder="Scan the box to fill this form…" autoFocus={false} onScan={scanForReceipt} />
          {receiptNote && <p className="notice-ok" style={{ marginTop: 8 }}>{receiptNote}</p>}
        </div>
        <form className="form" onSubmit={submitBatch}>
          <label>Item<select value={batchForm.itemId} onChange={e => setBatchForm({ ...batchForm, itemId: e.target.value })} required><option value="">Select the item</option>{items.map(i => <option key={i.id} value={i.id}>{i.item_code} — {i.name}</option>)}</select></label>
          <label>Batch number<input value={batchForm.batchNumber} onChange={e => setBatchForm({ ...batchForm, batchNumber: e.target.value })} /></label>
          <label>Lot number<input value={batchForm.lotNumber} onChange={e => setBatchForm({ ...batchForm, lotNumber: e.target.value })} /></label>

          {/* Who supplied the goods and who the laboratory received them FROM
              are two different facts. A hospital laboratory draws most of its
              stock from the hospital store, and a receipt that can only name a
              supplier cannot say so. What is asked for here follows the policy
              set in Settings → Stock & Storage. */}
          {procurement.mode === 'both' && <label>How this delivery was obtained
            <select value={batchForm.sourceType} onChange={e => setBatchForm({ ...batchForm, sourceType: e.target.value as 'supplier' | 'store', sourceId: '' })}>
              <option value="supplier">Bought direct from a supplier</option>
              <option value="store">Drawn from a store</option>
            </select></label>}
          {allowsStore(procurement) && (procurement.mode === 'stores' || batchForm.sourceType === 'store') &&
            <label>Received from<select value={batchForm.sourceId} onChange={e => setBatchForm({ ...batchForm, sourceId: e.target.value, sourceType: 'store' })} required>
              <option value="">Select the store</option>
              {supplySources.map(src => <option key={src.id} value={src.id}>{src.name} — {SUPPLY_SOURCE_KIND_LABELS[src.kind] ?? src.kind}</option>)}
            </select>{supplySources.length === 0 && <span className="muted">No stores configured yet — add them in Settings → Stock &amp; Storage.</span>}</label>}
          {allowsSupplier(procurement) && (procurement.mode === 'direct' || batchForm.sourceType === 'supplier') &&
            <label>Supplier<select value={batchForm.supplierId} onChange={e => setBatchForm({ ...batchForm, supplierId: e.target.value, sourceType: 'supplier' })}><option value="">Select the supplier</option>{suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>}
          {allowsStore(procurement) && batchForm.sourceType === 'store' &&
            <label>Supplier <span className="muted">(optional — who made or sold it, if it is known)</span>
              <select value={batchForm.supplierId} onChange={e => setBatchForm({ ...batchForm, supplierId: e.target.value })}>
                <option value="">Not recorded</option>{suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select></label>}
          <label>Waybill / invoice reference <span className="muted">(optional)</span>
            <input value={batchForm.reference} onChange={e => setBatchForm({ ...batchForm, reference: e.target.value })} placeholder="What this delivery is traced by" /></label>
          <label>Quantity received<NumberField value={batchForm.quantityReceived} required min={0} step="any"
            onValue={n => setBatchForm({ ...batchForm, quantityReceived: n ?? 0, quantityAvailable: n ?? 0 })} /></label>
          <label>Quantity available<NumberField value={batchForm.quantityAvailable} required min={0} step="any"
            onValue={n => setBatchForm({ ...batchForm, quantityAvailable: n ?? 0 })} /></label>
          <label>Date received<input type="date" value={batchForm.dateReceived} onChange={e => setBatchForm({ ...batchForm, dateReceived: e.target.value })} required /></label>
          <label>Expiry date<input type="date" value={batchForm.expiryDate} onChange={e => setBatchForm({ ...batchForm, expiryDate: e.target.value })} /></label>
          <label>Unit cost <span className="muted">(optional — what the stock is valued at)</span>
            <input type="number" step="any" min={0} value={batchForm.unitCost} onChange={e => setBatchForm({ ...batchForm, unitCost: e.target.value })} /></label>
          <label>Storage location<select value={batchForm.storageLocationId} onChange={e => setBatchForm({ ...batchForm, storageLocationId: e.target.value })}><option value="">Select a store, shelf or fridge</option>{storagePlaces.map(pl => <option key={pl.id} value={pl.id}>{pl.path}{pl.kind && pl.kind !== 'shelf' ? ` (${STORAGE_KIND_LABELS[pl.kind] ?? pl.kind})` : ''}</option>)}</select></label>
          <label>Barcode on this box <span className="muted">(optional — scanning it later finds this exact delivery)</span>
            <input value={batchForm.productBarcode} onChange={e => setBatchForm({ ...batchForm, productBarcode: e.target.value })}
              onKeyDown={e => { if (e.key === 'Enter') e.preventDefault(); }} />
          </label>
          <button type="submit">Book in the delivery</button>
        </form>
      </div>
    </div>}

    {tab === 'Receiving' && recvTab === 'Batches & lots' && <div>
      <div className="card">
        <div className="section-head" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <h3 style={{ margin: 0 }}>Batches and lots <span className="muted">— earliest expiry first</span></h3>
          {can('supplier_inventory', 'print') && batches.length > 0 && <button type="button" className="secondary" style={{ marginLeft: 'auto' }}
            title="A label per delivery, carrying its own barcode, lot and expiry"
            onClick={() => printLabelSheet(batches.map(b => ({
              barcodeValue: b.product_barcode || b.batch_number || String(b.id),
              title: b.item_name || `Item #${b.item_id}`,
              lines: [b.batch_number ? `Batch ${b.batch_number}` : '', b.expiry_date ? `Exp ${String(b.expiry_date).slice(0, 10)}` : ''].filter(Boolean),
            })), { widthMm: 50, heightMm: 25, title: 'Batch labels' })}>🏷️ Print batch labels</button>}
        </div>
        <p className="muted" style={{ marginTop: 0 }}>A delivery is quarantined until it has been inspected and accepted. Until then it cannot be issued — only discarded or returned. Stock is issued earliest-expiry-first.</p>
        {batches.length === 0 ? <p className="muted">Nothing has been received yet.</p> : <>
          <div className="table-scroll"><table className="data-table reg-table"><thead><tr>
            <th>Item</th><th>Batch / lot</th><th>Received from</th><th>Available</th><th>Received</th><th>Expires</th><th>Acceptance</th><th className="reg-actions-col"></th>
          </tr></thead><tbody>
            {shownBatches.shown.map(b => <tr key={b.id} className={`row-clickable${b.quantity_available > 0 && !b.reversed_at ? '' : ' row-retired'}`} {...focusAttr('inventory_batches', b.id)}
              onClick={() => openDetail(b.item_id)} tabIndex={0} role="button"
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(b.item_id); } }}>
              <td><span className="reg-primary">{b.item_name || `Item #${b.item_id}`}</span><span className="reg-sub">{b.item_code || ''}</span></td>
              <td><span className="reg-primary">{b.batch_number || `#${b.id}`}{b.reversed_at && <span className="badge inactive">reversed</span>}</span><span className="reg-sub">{[b.lot_number && `lot ${b.lot_number}`, b.product_barcode].filter(Boolean).join(' · ')}</span></td>
              <td>{b.source_label || <span className="muted">—</span>}{b.reference && <span className="reg-sub">{b.reference}</span>}</td>
              <td>{b.quantity_available} {b.unit_of_measure || ''}<span className="reg-sub">of {b.quantity_received} received</span></td>
              <td className="nowrap">{String(b.date_received ?? '').slice(0, 10) || '—'}</td>
              <td>{expiryCell(b.expiry_date, b.expiry_status)}</td>
              <td>{formatBadge(b.acceptance_status)}</td>
              <td className="reg-actions-col" onClick={e => e.stopPropagation()}>
                <RowMenu label={`Manage batch ${b.batch_number || b.id}`}>{close => <>
                  <button type="button" role="menuitem" onClick={() => { close(); openDetail(b.item_id); }}><FileText size={14} /> Open the item</button>
                  {(b.acceptance_status === 'pending' || b.acceptance_status === 'quarantined') && can('supplier_inventory', 'edit') && !b.reversed_at && <>
                    <button type="button" role="menuitem" onClick={() => { close(); acceptBatch(b.id, 'accepted'); }}>Accept on receipt</button>
                    <button type="button" role="menuitem" className="danger" onClick={() => { close(); acceptBatch(b.id, 'rejected'); }}>Reject on receipt</button>
                  </>}
                  {can('supplier_inventory', 'edit') && !b.reversed_at && <button type="button" role="menuitem" onClick={() => { close(); setEditingBatch(b); }}><Pencil size={14} /> Correct this receipt…</button>}
                  <button type="button" role="menuitem" onClick={() => { close(); createBatchNc(b.id); }}><ShieldAlert size={14} /> Raise a nonconformity</button>
                  {can('supplier_inventory', 'print') && <button type="button" role="menuitem" onClick={() => { close(); printLabelSheet([{ barcodeValue: b.product_barcode || b.batch_number || String(b.id), title: b.item_name || '', lines: [b.batch_number ? `Batch ${b.batch_number}` : '', b.expiry_date ? `Exp ${String(b.expiry_date).slice(0, 10)}` : ''].filter(Boolean) }], { widthMm: 50, heightMm: 25, title: 'Batch label' }); }}><Tag size={14} /> Print its label</button>}
                  {/* Reversing a receipt is not an everyday action and is not
                      offered to everyone, so it sits at the bottom of the menu
                      behind a confirmation that asks for a reason. */}
                  {can('supplier_inventory.stock', 'void_archive') && !b.reversed_at &&
                    <button type="button" role="menuitem" className="danger" onClick={() => { close(); setReversingBatch(b); }}><Undo2 size={14} /> Reverse this receipt…</button>}
                </>}</RowMenu>
              </td>
            </tr>)}
          </tbody></table></div>
          {shownBatches.hidden > 0 && <p className="muted list-capped">
            Showing the first {shownBatches.shown.length.toLocaleString()} of {shownBatches.total.toLocaleString()} deliveries,
            earliest expiry first.
          </p>}
        </>}
        {editingBatch && <BatchEditModal batch={editingBatch} suppliers={suppliers} storagePlaces={storagePlaces}
          supplySources={supplySources} procurement={procurement} onClose={() => setEditingBatch(null)}
          onSaved={async msg => { setEditingBatch(null); setNotice(msg); setStockKey(k => k + 1); await load(); }} />}
        {reversingBatch && <ReasonPrompt
          title={`Reverse the receipt of ${reversingBatch.item_name || 'this delivery'}`}
          intro={`Whatever is still on the shelf from ${reversingBatch.batch_number ? `batch ${reversingBatch.batch_number}` : 'this delivery'} is taken back off it, and the delivery is marked reversed so nothing more can be issued from it. Anything already issued stays issued — that stock physically left.`}
          confirmLabel="Reverse the receipt" danger
          onClose={() => setReversingBatch(null)}
          onConfirm={async reason => {
            const r = await api<{ message: string }>(`/supplier-inventory/batches/${reversingBatch.id}/reverse`, { method: 'POST', body: JSON.stringify({ reason }) });
            setReversingBatch(null); setNotice(r.message); setStockKey(k => k + 1); await load();
          }} />}
      </div>
    </div>}

    {tab === 'Stock Management' && manageTab === 'Stock movements' && <>
    <div className="card">
      <h3>Record a one-off movement</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        For anything that is not an ordinary issue — a disposal, a transfer, an adjustment. Issuing to a unit is
        quicker on the <button type="button" className="linklike" onClick={() => setTab('Issuing')}>Issuing</button> tab.
      </p>
      <form className="form" onSubmit={submitMovement}>
        {/* The state of a batch is on the option itself, so a storekeeper is
            not offered a quarantined or expired box and refused a click later. */}
        <label>Batch<select value={movementForm.batchId} onChange={e => { setMovementForm({ ...movementForm, batchId: e.target.value }); setFefoWarning(null); }} required>
          <option value="">Select the batch</option>
          {batches.map(b => {
            const flag = b.acceptance_status === 'rejected' ? 'rejected on receipt'
              : (b.acceptance_status === 'pending' || b.acceptance_status === 'quarantined') ? 'in quarantine'
              : b.expiry_status === 'expired' ? 'expired'
              : b.expiry_status === 'expiring_soon' ? 'expires soon' : '';
            return <option key={b.id} value={b.id}>
              {b.item_name} — {b.batch_number || `Batch #${b.id}`} · {b.quantity_available} available{flag ? ` · ${flag}` : ''}
            </option>;
          })}
        </select></label>
        <label>Movement type<select value={movementForm.movementType} onChange={e => { setMovementForm({ ...movementForm, movementType: e.target.value }); setFefoWarning(null); }}>{['issue', 'consume', 'discard', 'waste', 'transfer_out', 'receive', 'return', 'adjust_in', 'transfer_in'].map(t => <option key={t} value={t}>{MOVEMENT_LABELS[t] ?? t.replace('_', ' ')}</option>)}</select></label>
        <label>Quantity<NumberField value={movementForm.quantity} onValue={n => setMovementForm({ ...movementForm, quantity: n ?? 0 })} required min={0.0001} step="any" /></label>
        <label>Movement date<input type="date" value={movementForm.movementDate} onChange={e => setMovementForm({ ...movementForm, movementDate: e.target.value })} /></label>
        <label>Issued to unit<select value={movementForm.issuedToSectionId} onChange={e => setMovementForm({ ...movementForm, issuedToSectionId: e.target.value })}><option value="">Select the unit</option>{sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label>Received by<select value={movementForm.receivedByStaffId} onChange={e => setMovementForm({ ...movementForm, receivedByStaffId: e.target.value })}><option value="">Select the member of staff</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
        <label>Reason<select value={movementForm.reason} onChange={e => setMovementForm({ ...movementForm, reason: e.target.value })} required>
          <option value="">Select a reason</option>
          {movementReasons.map(r => <option key={r.id} value={r.value}>{r.label}</option>)}
        </select>{movementReasons.length === 0 && <span className="muted">No reasons configured — add them in Settings → Dropdown Lists.</span>}</label>
        <label>Detail <span className="muted">(optional)</span><input value={movementForm.reasonNote} onChange={e => setMovementForm({ ...movementForm, reasonNote: e.target.value })} placeholder="Anything the movement record should carry" /></label>
        {fefoWarning && <div className="notice-warn">
          <p style={{ margin: '0 0 8px' }}>{fefoWarning.message}</p>
          <button type="button" className="secondary" onClick={() => { setMovementForm({ ...movementForm, batchId: String(fefoWarning.batchId) }); setFefoWarning(null); }}>Issue the older batch instead</button>{' '}
          <button type="button" className="secondary" onClick={e => void submitMovement(e as unknown as FormEvent, true)}>Skip it anyway — record the reason</button>
        </div>}
        <button type="submit">Record movement</button>
      </form>
    </div>

    {/* Recording a movement and then having nowhere to see it is not a record.
        The receipt and the use of every lot is kept here. */}
    <div className="card">
      <div className="section-head" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <h3 style={{ margin: 0 }}>Stock movement register</h3>
        <div className="reg-head-actions" style={{ marginLeft: 'auto' }}>
          <RegisterSearch onQuery={setMoveQuery} placeholder="Search item, batch, unit, reason…" />
          {can('supplier_inventory.stock', 'export') && <button type="button" className="secondary" disabled={regBusy === 'movements'}
            onClick={() => void downloadFile('/supplier-inventory/movements/export', 'Stock_Movements.xlsx', 'movements')}>
            {regBusy === 'movements' ? 'Exporting…' : 'Export'}</button>}
        </div>
      </div>
      {movements.length === 0 ? <p className="muted">Nothing has been issued or received yet.</p> : movementRows.length === 0 ? <p className="muted">Nothing matches “{moveQuery}”.</p> :
        <div>
        <div className="table-scroll"><table className="data-table reg-table"><thead><tr>
          <th>Date</th><th>Item</th><th>Movement</th><th>Quantity</th><th>Batch / lot</th><th>To</th><th>Received by</th><th>Reason</th><th>Recorded by</th><th className="reg-actions-col"></th>
        </tr></thead><tbody>
          {shownMovements.shown.map(m => <tr key={m.id} className={`row-clickable${(m as any).reversed_by_id ? ' row-retired' : ''}`} onClick={() => openDetail(m.item_id)}>
            <td className="nowrap">{String(m.movement_date ?? '').slice(0, 10)}</td>
            <td><span className="reg-primary">{m.item_name || `Item #${m.item_id}`}</span><span className="reg-sub">{m.item_code}</span></td>
            <td>{MOVEMENT_LABELS[m.movement_type] ?? String(m.movement_type).replace(/_/g, ' ')}
              {(m as any).reversed_by_id ? <span className="badge inactive">reversed</span> : null}
              {(m as any).reversal_of_id ? <span className="badge">a reversal</span> : null}</td>
            <td>{m.quantity} {m.unit_of_measure || ''}</td>
            <td>{m.batch_number || <span className="muted">—</span>}{m.lot_number && <span className="reg-sub">lot {m.lot_number}</span>}</td>
            <td>{(m as any).issue_destination_name || m.issued_to_section_name || <span className="muted">—</span>}</td>
            <td>{m.received_by_name || <span className="muted">—</span>}</td>
            <td>{m.reason || <span className="muted">—</span>}</td>
            <td>{m.recorded_by_name || <span className="muted">—</span>}</td>
            <td className="reg-actions-col" onClick={e => e.stopPropagation()}>
              <RowMenu label={`Manage this movement`}>{close => <>
                <button type="button" role="menuitem" onClick={() => { close(); openDetail(m.item_id); }}><FileText size={14} /> Open the item</button>
                {/* A movement is never edited away and never deleted: the bin
                    card is a running record. The correction is its mirror. */}
                {can('supplier_inventory.stock', 'void_archive') && !(m as any).reversed_by_id && !(m as any).reversal_of_id &&
                  <button type="button" role="menuitem" className="danger" onClick={() => { close(); setReversingMovement(m); }}><Undo2 size={14} /> Reverse this movement…</button>}
              </>}</RowMenu>
            </td>
          </tr>)}
        </tbody></table></div>
        {shownMovements.hidden > 0 && <p className="muted list-capped">
          Showing the most recent {shownMovements.shown.length.toLocaleString()} of {shownMovements.total.toLocaleString()} movements.
          Search, or export the register for the whole trail.
        </p>}
        </div>}
      {reversingMovement && <ReasonPrompt
        title="Reverse this movement"
        intro={`A movement is not deleted — the bin card is a running record and rewriting a line of it invalidates every balance printed after it. What is posted instead is the mirror: ${reversingMovement.quantity} ${reversingMovement.unit_of_measure || ''} back the other way, pointed at this movement.`}
        confirmLabel="Post the reversal" danger
        onClose={() => setReversingMovement(null)}
        onConfirm={async reason => {
          await api(`/supplier-inventory/movements/${reversingMovement.id}/reverse`, { method: 'POST', body: JSON.stringify({ reason }) });
          setReversingMovement(null); setNotice('The movement has been reversed — both lines are on the bin card.');
          setStockKey(k => k + 1); await load();
        }} />}
    </div></>}

    {/* Selecting a supplier, registering them, evaluating them and monitoring
        them are four different jobs, so they get four places rather than three
        stacked forms. */}
    {tab === 'Suppliers' && <>
      <div className="card" style={{ paddingBottom: 6 }}>
        <div className="reg-seg" role="tablist" aria-label="Suppliers">
          {['Register', 'New registration', 'Evaluation', 'Scored evaluation', 'Management'].map(t =>
            <button key={t} type="button" role="tab" aria-selected={supplierTab === t} className={supplierTab === t ? 'on' : ''}
              onClick={() => setSupplierTab(t)}>
              {t}{t === 'Register' && <span className="reg-count">{suppliers.length}</span>}
              {t === 'Evaluation' && <span className="reg-count">{evaluations.length}</span>}
            </button>)}
        </div>
      </div>

      {supplierTab === 'Register' && <div className="card">
        <div className="section-head" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <h3 style={{ margin: 0 }}>Approved suppliers</h3>
          <div className="reg-head-actions" style={{ marginLeft: 'auto' }}>
            <RegisterSearch onQuery={setSupplierQuery} placeholder="Search name, code, contact…" />
            {can('supplier_inventory.suppliers', 'export') && <button type="button" className="secondary" disabled={regBusy === 'suppliers'}
              onClick={() => void downloadFile('/supplier-inventory/suppliers/export', 'Supplier_Register.xlsx', 'suppliers')}>
              {regBusy === 'suppliers' ? 'Exporting…' : 'Export'}</button>}
            {can('supplier_inventory.suppliers', 'create') && <>
              <button type="button" disabled={regBusy === 'import'} onClick={() => supplierImportRef.current?.click()}>
                {regBusy === 'import' ? 'Importing…' : 'Import'}</button>
              <input ref={supplierImportRef} type="file" accept=".xlsx,.xls" style={{ display: 'none' }}
                onChange={e => { const f = e.target.files?.[0]; if (f) void importRegister(f, '/supplier-inventory/suppliers/import'); }} />
            </>}
          </div>
        </div>
        <p className="muted" style={{ marginTop: 0 }}>Rows are matched on supplier code — a code the register already holds is updated, a blank one is created.</p>
        {suppliers.length === 0 ? <p className="muted">No suppliers registered yet.</p> : supplierRows.length === 0 ? <p className="muted">Nothing matches “{supplierQuery}”.</p> :
          <div className="table-scroll"><table className="data-table reg-table"><thead><tr>
            <th>Supplier</th><th>Contact</th><th>Supplies</th><th>Items</th><th>Evaluation</th><th>Status</th><th className="reg-actions-col"></th>
          </tr></thead><tbody>
            {supplierRows.map(sp => <tr key={sp.id} className={`row-clickable${sp.status === 'suspended' ? ' row-retired' : ''}`} {...focusAttr('suppliers', sp.id)}
              onClick={() => setEditingSupplier(sp)} tabIndex={0} role="button"
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setEditingSupplier(sp); } }}>
              <td><span className="reg-primary">{sp.name}</span><span className="reg-sub">{sp.supplier_code}</span></td>
              <td>{sp.contact_person || sp.contact || <span className="muted">—</span>}<span className="reg-sub">{[sp.phone, sp.email].filter(Boolean).join(' · ')}</span></td>
              <td>{sp.item_category || <span className="muted">—</span>}</td>
              <td>{sp.item_count ?? 0}{(sp.batch_count ?? 0) > 0 && <span className="reg-sub">{sp.batch_count} deliveries</span>}</td>
              <td>{evaluationBadge(sp)}{sp.last_rating && <span className="reg-sub">rated {sp.last_rating}</span>}</td>
              <td>{formatBadge(sp.status)}</td>
              <td className="reg-actions-col" onClick={e => e.stopPropagation()}>
                <RowMenu label={`Manage ${sp.name}`}>{close => <>
                  <button type="button" role="menuitem" onClick={() => { close(); setEditingSupplier(sp); }}><Pencil size={14} /> Open and edit</button>
                  {can('supplier_inventory', 'create') && <button type="button" role="menuitem" onClick={() => { close(); setEvalForm(f => ({ ...f, supplierId: String(sp.id) })); setSupplierTab('Evaluation'); }}><Star size={14} /> Evaluate</button>}
                  {can('supplier_inventory', 'void_archive') && <button type="button" role="menuitem" className="danger" onClick={() => { close(); void openSupplierRemoval(sp); }}><Trash2 size={14} /> Remove…</button>}
                </>}</RowMenu>
              </td>
            </tr>)}
          </tbody></table></div>}
      </div>}

      {supplierTab === 'New registration' && <div className="card">
        <h3>Register a supplier</h3>
        <p className="muted" style={{ marginTop: 0 }}>Whoever supplies reagents, consumables or a service that affects a result belongs on this register, with the evaluation the laboratory's procedure requires.</p>
        <form className="form" onSubmit={submitSupplier}>
          <label>Name<input value={supplierForm.name} onChange={e => setSupplierForm({ ...supplierForm, name: e.target.value })} required /></label>
          <label>Contact person<input value={supplierForm.contactPerson} onChange={e => setSupplierForm({ ...supplierForm, contactPerson: e.target.value })} /></label>
          <label>Phone<input value={supplierForm.phone} onChange={e => setSupplierForm({ ...supplierForm, phone: e.target.value })} /></label>
          <label>Email<input type="email" value={supplierForm.email} onChange={e => setSupplierForm({ ...supplierForm, email: e.target.value })} /></label>
          <label>Address<input value={supplierForm.address} onChange={e => setSupplierForm({ ...supplierForm, address: e.target.value })} /></label>
          <label>What they supply<input value={supplierForm.itemCategory} onChange={e => setSupplierForm({ ...supplierForm, itemCategory: e.target.value })} placeholder="Reagents, consumables, calibration services…" /></label>
          <label className="toggle"><input type="checkbox" checked={supplierForm.evaluationRequired} onChange={e => setSupplierForm({ ...supplierForm, evaluationRequired: e.target.checked })} /> They must be evaluated periodically</label>
          <button type="submit">Register supplier</button>
        </form>
      </div>}

      {supplierTab === 'Evaluation' && <>
        <div className="card">
          <h3>Record an evaluation</h3>
          <form className="form" onSubmit={submitEvaluation}>
            <label>Supplier<select value={evalForm.supplierId} onChange={e => setEvalForm({ ...evalForm, supplierId: e.target.value })} required><option value="">Select supplier</option>{suppliers.map(sp => <option key={sp.id} value={sp.id}>{sp.name}</option>)}</select></label>
            <label>Evaluation date<input type="date" value={evalForm.evaluationDate} onChange={e => setEvalForm({ ...evalForm, evaluationDate: e.target.value })} required /></label>
            <label>Rating<select value={evalForm.rating} onChange={e => setEvalForm({ ...evalForm, rating: e.target.value })}>
              <option value="">Select a rating</option>
              {['satisfactory', 'acceptable', 'conditional', 'unsatisfactory'].map(r => <option key={r} value={r}>{r[0].toUpperCase() + r.slice(1)}</option>)}
            </select></label>
            <label>Findings<textarea value={evalForm.findings} onChange={e => setEvalForm({ ...evalForm, findings: e.target.value })} placeholder="Delivery times, condition on arrival, documentation, complaints raised…" /></label>
            <label>Action required<textarea value={evalForm.actionRequired} onChange={e => setEvalForm({ ...evalForm, actionRequired: e.target.value })} /></label>
            <label>Next evaluation due<input type="date" value={evalForm.nextEvaluationDate} onChange={e => setEvalForm({ ...evalForm, nextEvaluationDate: e.target.value })} /></label>
            <button type="submit">Record evaluation</button>
          </form>
        </div>
        <div className="card">
          <h3>Evaluation register</h3>
          {evaluations.length === 0 ? <p className="muted">No supplier has been evaluated yet.</p> :
            <div className="table-scroll"><table className="data-table"><thead><tr>
              <th>Date</th><th>Supplier</th><th>Rating</th><th>Findings</th><th>Action required</th><th>Next due</th><th>Evaluated by</th>
            </tr></thead><tbody>
              {evaluations.map(ev => <tr key={ev.id}>
                <td className="nowrap">{String(ev.evaluation_date ?? '').slice(0, 10)}</td>
                <td><span className="reg-primary">{ev.supplier_name || '—'}</span><span className="reg-sub">{ev.supplier_code}</span></td>
                <td>{ev.rating ? formatBadge(ev.rating) : <span className="muted">—</span>}</td>
                <td>{ev.findings || <span className="muted">—</span>}</td>
                <td>{ev.action_required || <span className="muted">—</span>}</td>
                <td>{String(ev.next_evaluation_date ?? '').slice(0, 10) || <span className="muted">—</span>}</td>
                <td>{ev.evaluated_by_name || <span className="muted">—</span>}</td>
              </tr>)}
            </tbody></table></div>}
        </div>
      </>}

      {supplierTab === 'Scored evaluation' && <SupplierEvaluationWorkspace suppliers={suppliers} />}

      {supplierTab === 'Management' && <div className="card">
        <h3>Who is due, and who is not being watched</h3>
        <p className="muted" style={{ marginTop: 0 }}>Monitoring is the part that slips. This is the same register, sorted by what needs doing.</p>
        {suppliers.length === 0 ? <p className="muted">No suppliers registered yet.</p> : <>
          <KpiStrip items={[
            { label: 'Suppliers', value: suppliers.length },
            { label: 'Evaluation overdue', value: suppliers.filter(sp => sp.evaluation_status === 'overdue').length, tone: 'danger' },
            { label: 'Never evaluated', value: suppliers.filter(sp => sp.evaluation_status === 'never_evaluated').length, tone: 'warning' },
            { label: 'Suspended', value: suppliers.filter(sp => sp.status === 'suspended').length },
          ]} />
          <div className="table-scroll" style={{ marginTop: 14 }}><table className="data-table reg-table"><thead><tr>
            <th>Supplier</th><th>Evaluation</th><th>Last evaluated</th><th>Next due</th><th>Supplies</th><th className="reg-actions-col"></th>
          </tr></thead><tbody>
            {[...suppliers]
              .sort((a, b) => evaluationRank(a) - evaluationRank(b) || a.name.localeCompare(b.name))
              .map(sp => <tr key={sp.id} className={sp.status === 'suspended' ? 'row-retired' : ''}>
                <td><span className="reg-primary">{sp.name}</span><span className="reg-sub">{sp.supplier_code}</span></td>
                <td>{evaluationBadge(sp)}</td>
                <td>{String(sp.last_evaluation_date ?? '').slice(0, 10) || <span className="muted">—</span>}</td>
                <td>{String(sp.next_evaluation_due ?? '').slice(0, 10) || <span className="muted">—</span>}</td>
                <td>{sp.item_count ?? 0} item{sp.item_count === 1 ? '' : 's'}</td>
                <td className="reg-actions-col">
                  <RowMenu label={`Manage ${sp.name}`}>{close => <>
                    <button type="button" role="menuitem" onClick={() => { close(); setEditingSupplier(sp); }}><Pencil size={14} /> Open and edit</button>
                    {can('supplier_inventory', 'create') && <button type="button" role="menuitem" onClick={() => { close(); setEvalForm(f => ({ ...f, supplierId: String(sp.id) })); setSupplierTab('Evaluation'); }}><Star size={14} /> Evaluate</button>}
                    {can('supplier_inventory', 'void_archive') && <button type="button" role="menuitem" className="danger" onClick={() => { close(); void openSupplierRemoval(sp); }}><Trash2 size={14} /> Remove…</button>}
                  </>}</RowMenu>
                </td>
              </tr>)}
          </tbody></table></div>
        </>}
      </div>}

      {editingSupplier && <SupplierDetailPanel supplier={editingSupplier} evaluations={evaluations.filter(ev => ev.supplier_id === editingSupplier.id)}
        can={can} onClose={() => setEditingSupplier(null)} setError={setError}
        onSaved={async () => { setEditingSupplier(null); await load(); }}
        onRemove={() => { const sp = editingSupplier; setEditingSupplier(null); void openSupplierRemoval(sp); }} />}
      {removingSupplier && <SupplierRemovalModal impact={removingSupplier} onClose={() => setRemovingSupplier(null)} setError={setError}
        onDone={async msg => { setRemovingSupplier(null); setNotice(msg); await load(); }} />}
    </>}

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

    {tab === 'Forecasting' && <ForecastingPanel canEdit={can('supplier_inventory', 'edit')} refreshKey={stockKey}
      onApplied={() => { setStockKey(k => k + 1); void load(); }} />}

    {/* The item's own page, opened from wherever the item was found — the
        register, a bin card, a search result, an alert. It used to live inside
        the Item Register tab, so opening an item from the ledger set it and
        then drew nothing, which read as the button doing nothing at all. */}
    {selected && <InventoryDetailPanel item={selected} staff={staff} suppliers={suppliers} sections={sections}
      storagePlaces={storagePlaces} categories={categories} units={units} barcodePolicy={barcodePolicy}
      movementReasons={movementReasons} supplySources={supplySources} procurement={procurement}
      mode={detailMode} setMode={setDetailMode} can={can}
      onClose={() => { setSelected(null); setDetailMode('view'); }}
      onSaved={async () => { await load(); await openDetail(selected.id, 'view'); }}
      onChanged={async (message?: string) => { setStockKey(k => k + 1); if (message) setNotice(message); await load(); await openDetail(selected.id, detailMode); }}
      acceptBatch={acceptBatch} createBatchNc={createBatchNc} onRemove={() => void openItemRemoval(selected)} />}
    {removing && <ItemRemovalModal impact={removing} busy={regBusy} onClose={() => setRemoving(null)}
      onDone={async msg => { setRemoving(null); setSelected(null); setNotice(msg); await load(); }} setError={setError} />}
  </div>;
}

/* ============================================================================
   CORRECTING WHAT IS ALREADY RECORDED

   Mistakes happen at a counter: the wrong lot number, a quantity keyed with an
   extra zero, a voucher written for the wrong unit. A store that cannot fix
   those ends up with a second "correct" record beside the wrong one, and a
   balance nobody trusts.

   Two rules shape everything here. Nothing that has moved stock is deleted —
   the correction is a movement of its own, so the bin card shows what happened
   and what was done about it. And nothing destructive is offered in plain
   sight: these live behind a row's ⋯ menu, and every one of them costs a
   written reason.
   ========================================================================= */

/**
 * "Are you sure, and why?" — asked once, properly.
 *
 * A confirmation that only asks whether you are sure collects nothing. The
 * reason typed here goes onto the record itself, which is what makes a
 * reversal an explanation rather than a hole.
 */
function ReasonPrompt({ title, intro, confirmLabel, danger, placeholder, onClose, onConfirm }: {
  title: string; intro: string; confirmLabel: string; danger?: boolean; placeholder?: string;
  onClose: () => void; onConfirm: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function go() {
    if (!reason.trim()) { setError('A reason is required — it is what the record will say.'); return; }
    setBusy(true); setError(null);
    try { await onConfirm(reason.trim()); }
    catch (e) { setError((e as Error).message); setBusy(false); }
  }

  return <DetailModal open onClose={onClose} width="narrow" title={title}
    footer={<>
      <button type="button" className="secondary" onClick={onClose}>Cancel</button>
      <button type="button" className={danger ? 'danger' : ''} disabled={busy} onClick={() => void go()}>
        {busy ? 'Working…' : confirmLabel}
      </button>
    </>}>
    {error && <div className="error">{error}</div>}
    <p className="muted" style={{ marginTop: 0 }}>{intro}</p>
    <label>Reason<textarea value={reason} onChange={e => setReason(e.target.value)} rows={3}
      placeholder={placeholder ?? 'What went wrong, and how it was noticed'} autoFocus /></label>
  </DetailModal>;
}

/**
 * Correcting a delivery that was booked in wrong.
 *
 * The quantity is the delicate one. Anything already issued out of this
 * delivery cannot be un-received — that stock physically left — so the
 * quantity can only be corrected down as far as what is still on the shelf,
 * and the server refuses anything lower with the figure it would need to be.
 */
function BatchEditModal({ batch, suppliers, storagePlaces, supplySources, procurement, onClose, onSaved }: {
  batch: InventoryBatch; suppliers: Supplier[];
  storagePlaces: Array<{ id: number; path: string; kind: string }>;
  supplySources: SupplySource[]; procurement: ProcurementPolicy;
  onClose: () => void; onSaved: (message: string) => void | Promise<void>;
}) {
  const anyBatch = batch as any;
  const [form, setForm] = useState({
    batchNumber: batch.batch_number ?? '', lotNumber: batch.lot_number ?? '',
    supplierId: batch.supplier_id ? String(batch.supplier_id) : '',
    sourceType: (anyBatch.source_type && anyBatch.source_type !== 'supplier' ? 'store' : 'supplier') as 'supplier' | 'store',
    sourceId: anyBatch.source_id ? String(anyBatch.source_id) : '',
    reference: anyBatch.reference ?? '',
    quantityReceived: String(batch.quantity_received ?? 0),
    dateReceived: String(batch.date_received ?? '').slice(0, 10),
    expiryDate: String(batch.expiry_date ?? '').slice(0, 10),
    storageLocationId: anyBatch.storage_location_id ? String(anyBatch.storage_location_id) : '',
    productBarcode: batch.product_barcode ?? '',
    unitCost: anyBatch.unit_cost != null ? String(anyBatch.unit_cost) : '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const issued = Number(batch.quantity_received ?? 0) - Number(batch.quantity_available ?? 0);

  async function save(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      await api(`/supplier-inventory/batches/${batch.id}`, { method: 'PUT', body: JSON.stringify(form) });
      await onSaved(`${batch.batch_number ? `Batch ${batch.batch_number}` : 'The delivery'} was corrected.`);
    } catch (err) { setError((err as Error).message); setBusy(false); }
  }

  return <DetailModal open onClose={onClose} title={`Correct the receipt of ${batch.item_name ?? 'this delivery'}`}
    subtitle={batch.batch_number ? `Batch ${batch.batch_number}` : `Delivery #${batch.id}`}
    footer={<>
      <button type="button" className="secondary" onClick={onClose}>Cancel</button>
      <button type="submit" form="edit-batch" disabled={busy}>{busy ? 'Saving…' : 'Save the correction'}</button>
    </>}>
    {error && <div className="error">{error}</div>}
    {issued > 0 && <div className="notice-warn" style={{ marginTop: 0 }}>
      {issued} {batch.unit_of_measure || ''} has already gone out of this delivery, so the quantity received cannot be
      corrected below that. If the whole receipt was wrong, reverse it instead.
    </div>}
    <form id="edit-batch" className="form" onSubmit={save}>
      <label>Batch number<input value={form.batchNumber} onChange={e => setForm({ ...form, batchNumber: e.target.value })} /></label>
      <label>Lot number<input value={form.lotNumber} onChange={e => setForm({ ...form, lotNumber: e.target.value })} /></label>
      {procurement.mode === 'both' && <label>How it was obtained
        <select value={form.sourceType} onChange={e => setForm({ ...form, sourceType: e.target.value as 'supplier' | 'store', sourceId: '' })}>
          <option value="supplier">Bought direct from a supplier</option>
          <option value="store">Drawn from a store</option>
        </select></label>}
      {allowsStore(procurement) && (procurement.mode === 'stores' || form.sourceType === 'store') &&
        <label>Received from<select value={form.sourceId} onChange={e => setForm({ ...form, sourceId: e.target.value, sourceType: 'store' })}>
          <option value="">Select the store</option>
          {supplySources.map(src => <option key={src.id} value={src.id}>{src.name}</option>)}
        </select></label>}
      <label>Supplier<select value={form.supplierId} onChange={e => setForm({ ...form, supplierId: e.target.value })}>
        <option value="">Not recorded</option>{suppliers.map(sp => <option key={sp.id} value={sp.id}>{sp.name}</option>)}
      </select></label>
      <label>Waybill / invoice reference<input value={form.reference} onChange={e => setForm({ ...form, reference: e.target.value })} /></label>
      <label>Quantity received<input type="number" step="any" min={issued} value={form.quantityReceived}
        onChange={e => setForm({ ...form, quantityReceived: e.target.value })} />
        <span className="muted">{issued > 0 ? `At least ${issued} — that much has already been issued.` : 'What is on the shelf moves with this correction.'}</span></label>
      <label>Date received<input type="date" value={form.dateReceived} onChange={e => setForm({ ...form, dateReceived: e.target.value })} /></label>
      <label>Expiry date<input type="date" value={form.expiryDate} onChange={e => setForm({ ...form, expiryDate: e.target.value })} /></label>
      <label>Unit cost<input type="number" step="any" min={0} value={form.unitCost} onChange={e => setForm({ ...form, unitCost: e.target.value })} /></label>
      <label>Storage location<select value={form.storageLocationId} onChange={e => setForm({ ...form, storageLocationId: e.target.value })}>
        <option value="">Not recorded</option>
        {storagePlaces.map(pl => <option key={pl.id} value={pl.id}>{pl.path}</option>)}
      </select></label>
      <label>Barcode on this box<input value={form.productBarcode} onChange={e => setForm({ ...form, productBarcode: e.target.value })}
        onKeyDown={e => { if (e.key === 'Enter') e.preventDefault(); }} /></label>
    </form>
  </DetailModal>;
}

/**
 * Taking stock off the shelf, or putting it back, without a delivery or an issue.
 *
 * Every store needs this and every store does it — on paper, in the margin of
 * a bin card, if the system will not. A bottle breaks, a box is found behind
 * another, a figure was keyed wrong last month. Both directions are ordinary
 * movements: allocated earliest-expiry-first, carrying a reason, landing on
 * the bin card where anyone can see what was done and why.
 */
function StockAdjustModal({ item, reasons, onClose, onDone }: {
  item: InventoryItemDetail; reasons: ConfigOption[];
  onClose: () => void; onDone: (message: string) => void | Promise<void>;
}) {
  const [direction, setDirection] = useState<'debit' | 'credit'>('debit');
  const [quantity, setQuantity] = useState('');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [batchId, setBatchId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onHand = item.stock_on_hand ?? item.quantity ?? 0;
  const lots = (item.batches ?? []).filter(b => (b as any).reversed_at == null);

  async function go(e: FormEvent) {
    e.preventDefault();
    if (!(Number(quantity) > 0)) { setError('Say how much.'); return; }
    if (!reason) { setError('Choose a reason — an adjustment without one is just a changed number.'); return; }
    setBusy(true); setError(null);
    try {
      const r = await api<{ allocation: Array<{ batchId: number; quantity: number; batchNumber?: string | null }> }>(
        `/supplier-inventory/items/${item.id}/adjust`,
        { method: 'POST', body: JSON.stringify({ direction, quantity: Number(quantity), reason, note, batchId: batchId || null }) });
      const lotWords = r.allocation.map(a => `${a.quantity} from ${a.batchNumber || `lot #${a.batchId}`}`).join(', ');
      await onDone(`${quantity} ${item.unit || ''} ${direction === 'debit' ? 'taken off' : 'put back on'} the shelf — ${lotWords}.`.replace(/\s+/g, ' '));
    } catch (err) { setError((err as Error).message); setBusy(false); }
  }

  return <DetailModal open onClose={onClose} width="narrow" title={`Adjust the stock of ${item.name}`}
    subtitle={`${onHand} ${item.unit || ''} on hand`}
    footer={<>
      <button type="button" className="secondary" onClick={onClose}>Cancel</button>
      <button type="submit" form="adjust-stock" disabled={busy} className={direction === 'debit' ? 'danger' : ''}>
        {busy ? 'Posting…' : direction === 'debit' ? 'Debit the stock' : 'Credit the stock'}
      </button>
    </>}>
    {error && <div className="error">{error}</div>}
    <form id="adjust-stock" className="form" onSubmit={go}>
      <div className="bc-choice">
        <button type="button" className={direction === 'debit' ? 'active' : ''} onClick={() => setDirection('debit')}>
          <strong>Debit — take stock off</strong>
          <span>Breakage, loss, expiry found on the shelf, a quantity recorded too high.</span>
        </button>
        <button type="button" className={direction === 'credit' ? 'active' : ''} onClick={() => setDirection('credit')}>
          <strong>Credit — put stock back</strong>
          <span>Stock found, or a quantity recorded too low.</span>
        </button>
      </div>
      <label>Quantity<input type="number" step="any" min={0} value={quantity} onChange={e => setQuantity(e.target.value)} autoFocus />
        {direction === 'debit' && <span className="muted">There {onHand === 1 ? 'is' : 'are'} {onHand} {item.unit || ''} on the shelf.</span>}</label>
      <label>Reason<select value={reason} onChange={e => setReason(e.target.value)} required>
        <option value="">Select a reason</option>
        {reasons.map(r => <option key={r.id} value={r.value}>{r.label}</option>)}
      </select>{reasons.length === 0 && <span className="muted">No reasons configured — add them in Settings → Dropdown Lists.</span>}</label>
      <label>Detail <span className="muted">(optional)</span>
        <input value={note} onChange={e => setNote(e.target.value)} placeholder="Anything the bin card should carry" /></label>
      <label>Which lot <span className="muted">(optional)</span>
        <select value={batchId} onChange={e => setBatchId(e.target.value)}>
          <option value="">{direction === 'debit' ? 'Take it off earliest-expiry-first' : 'Put it on the lot that expires first'}</option>
          {lots.map(b => <option key={b.id} value={b.id}>
            {b.batch_number || `Lot #${b.id}`} — {b.quantity_available} available{b.expiry_date ? `, expires ${String(b.expiry_date).slice(0, 10)}` : ''}
          </option>)}
        </select></label>
    </form>
  </DetailModal>;
}

/**
 * A stock item, opened.
 *
 * It used to say one line — quantity, minimum, reorder, and an expiry date
 * that was always blank because expiry belongs to the delivery, not to the
 * product. What a storekeeper or an assessor asks of a reagent is: what
 * exactly is it, who supplies it, where is it kept, how much is on the shelf,
 * which lots, and what has been done with it. That is what is here, in that
 * order, with the record editable in place.
 */
function InventoryDetailPanel({
  item, staff, suppliers, sections, storagePlaces, categories, units, barcodePolicy,
  movementReasons, supplySources, procurement,
  mode, setMode, can, onClose, onSaved, onChanged, acceptBatch, createBatchNc, onRemove,
}: {
  item: InventoryItemDetail; staff: Staff[]; suppliers: Supplier[]; sections: Section[];
  storagePlaces: Array<{ id: number; path: string; kind: string }>;
  categories: ConfigOption[]; units: ConfigOption[]; barcodePolicy: BarcodePolicy;
  movementReasons: ConfigOption[]; supplySources: SupplySource[]; procurement: ProcurementPolicy;
  mode: 'view' | 'edit'; setMode: (m: 'view' | 'edit') => void;
  can: (module: string, action: string) => boolean;
  onClose: () => void; onSaved: () => void | Promise<void>;
  onChanged: (message?: string) => void | Promise<void>;
  acceptBatch: (id: number, status: string) => void; createBatchNc: (id: number) => void; onRemove: () => void;
}) {
  const [form, setForm] = useState({
    name: item.name, category: item.category ?? '', unit: item.unit ?? '',
    manufacturer: item.manufacturer ?? '', catalogueNumber: item.catalogue_number ?? '',
    supplierId: item.supplier_id ? String(item.supplier_id) : '',
    storageLocationId: item.storage_location_id ? String(item.storage_location_id) : '',
    sectionId: item.section_id ? String(item.section_id) : '',
    minimumStock: item.minimum_stock ?? 0, reorderLevel: item.reorder_level ?? 0,
    storageRequirement: item.storage_requirement ?? '', status: item.status ?? 'available',
    barcodeSource: item.barcode_source ?? 'system', productBarcode: item.product_barcode ?? '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adjusting, setAdjusting] = useState(false);
  const [editingBatch, setEditingBatch] = useState<InventoryBatch | null>(null);
  const [reversingBatch, setReversingBatch] = useState<InventoryBatch | null>(null);
  const [reversingMovement, setReversingMovement] = useState<any>(null);
  const label = (list: ConfigOption[], value?: string | null) => list.find(o => o.value === value)?.label ?? value ?? '—';
  const mayCorrect = can('supplier_inventory', 'edit');
  const mayReverse = can('supplier_inventory.stock', 'void_archive');

  async function save(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      await api(`/supplier-inventory/items/${item.id}`, { method: 'PUT', body: JSON.stringify(form) });
      setMode('view');
      await onSaved();
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }

  const onHand = item.stock_on_hand ?? item.quantity;
  const facts: Array<[string, ReactNode]> = [
    ['Item code', item.item_code],
    ['Barcode', <>{effectiveBarcode(item) || '—'}{item.barcode_source === 'product' && <span className="badge">product</span>}</>],
    ['Category', label(categories, item.category)],
    ['Manufacturer', item.manufacturer || '—'],
    ['Catalogue number', item.catalogue_number || '—'],
    ['Supplier', item.supplier_name
      ? <>{item.supplier_name}{item.supplier_phone ? <span className="reg-sub">{item.supplier_phone}</span> : null}</>
      : '—'],
    ['Storage location', item.storage_path || '—'],
    ['Unit', item.section_name || '—'],
    ['Storage requirement', item.storage_requirement || '—'],
    ['Added by', item.created_by_name || '—'],
  ];

  return <DetailModal open onClose={onClose} title={<>{item.name}</>} subtitle={`${item.item_code} · ${label(categories, item.category)}`}
    header={<>
      {item.is_active === 0 && <span className="badge inactive">withdrawn</span>}
      {formatBadge(item.status)}
      {can('supplier_inventory', 'edit') && mode === 'view' &&
        <button type="button" className="secondary" onClick={() => setMode('edit')}><Pencil size={14} /> Edit</button>}
      {/* Removing is not an everyday action, so it lives under the menu with
          the rest of the management actions rather than beside Edit. */}
      <RowMenu label={`Manage ${item.name}`}>{close => <>
        {mayCorrect && <button type="button" role="menuitem" onClick={() => { close(); setAdjusting(true); }}><Scale size={14} /> Adjust the stock — debit or credit…</button>}
        {can('supplier_inventory', 'print') && <button type="button" role="menuitem" onClick={() => { close(); printLabelSheet([{ barcodeValue: effectiveBarcode(item), title: item.name, lines: [effectiveBarcode(item), item.storage_path || ''].filter(Boolean) }], { widthMm: 50, heightMm: 25, title: item.name }); }}><Tag size={14} /> Print its label</button>}
        {can('supplier_inventory', 'void_archive') && <button type="button" role="menuitem" className="danger" onClick={() => { close(); onRemove(); }}><Trash2 size={14} /> Remove…</button>}
      </>}</RowMenu>
    </>}>

    {error && <div className="error">{error}</div>}

    {/* What is on the shelf, first — it is the question being asked. */}
    <div className="stock-figures">
      <div><span className="fig">{onHand} <small>{item.unit || ''}</small></span><span className="fig-label">on hand</span></div>
      <div><span className="fig">{item.minimum_stock ?? 0}</span><span className="fig-label">minimum</span></div>
      <div><span className="fig">{item.reorder_level ?? 0}</span><span className="fig-label">reorder at</span></div>
      <div><span className="fig">{item.batch_count ?? 0}</span><span className="fig-label">batches in stock</span></div>
      <div><span className="fig">{item.effective_expiry ? String(item.effective_expiry).slice(0, 10) : '—'}</span><span className="fig-label">expires first</span></div>
    </div>
    {item.low_stock && <div className="notice-warn" style={{ marginTop: 10 }}>
      Stock is at or below the minimum. {item.supplier_name ? `Reorder from ${item.supplier_name}.` : 'No supplier is recorded against this item.'}
    </div>}

    {mode === 'edit' ? <form className="form" onSubmit={save} style={{ marginTop: 14 }}>
      <label>Name<input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required /></label>
      <label>Category<select value={form.category} onChange={e => setForm({ ...form, category: e.target.value })} required>
        {categories.map(c => <option key={c.id} value={c.value}>{c.label}</option>)}
      </select></label>
      <label>Unit of measure<select value={form.unit} onChange={e => setForm({ ...form, unit: e.target.value })} required>
        {units.map(u => <option key={u.id} value={u.value}>{u.label}</option>)}
      </select></label>
      <label>Manufacturer<input value={form.manufacturer} onChange={e => setForm({ ...form, manufacturer: e.target.value })} /></label>
      <label>Catalogue number<input value={form.catalogueNumber} onChange={e => setForm({ ...form, catalogueNumber: e.target.value })} /></label>
      <label>Supplier<select value={form.supplierId} onChange={e => setForm({ ...form, supplierId: e.target.value })}>
        <option value="">No supplier recorded</option>{suppliers.map(sp => <option key={sp.id} value={sp.id}>{sp.name}</option>)}
      </select></label>
      <label>Storage location<select value={form.storageLocationId} onChange={e => setForm({ ...form, storageLocationId: e.target.value })}>
        <option value="">Select a store, shelf or fridge</option>{storagePlaces.map(pl => <option key={pl.id} value={pl.id}>{pl.path}</option>)}
      </select></label>
      <label>Unit<select value={form.sectionId} onChange={e => setForm({ ...form, sectionId: e.target.value })}>
        <option value="">Select the unit</option>{sections.map(sec => <option key={sec.id} value={sec.id}>{sec.name}</option>)}
      </select></label>
      <label>Minimum stock<NumberField value={form.minimumStock} onValue={n => setForm({ ...form, minimumStock: n ?? 0 })} min={0} /></label>
      <label>Reorder level<NumberField value={form.reorderLevel} onValue={n => setForm({ ...form, reorderLevel: n ?? 0 })} min={0} /></label>
      <label>Storage requirement<input value={form.storageRequirement} onChange={e => setForm({ ...form, storageRequirement: e.target.value })} placeholder="e.g. 2-8°C" /></label>
      <label>Status<select value={form.status} onChange={e => setForm({ ...form, status: e.target.value })}>
        <option value="available">Available</option><option value="reserved">Reserved</option><option value="unavailable">Unavailable</option>
      </select></label>
      <fieldset className="bc-pick">
        <legend>Barcode</legend>
        {barcodePolicy.allowPerItem && <div className="bc-pick-row">
          {(['system', 'product'] as const).map(src => <label key={src} className={form.barcodeSource === src ? 'on' : ''}>
            <input type="radio" name="editBarcodeSource" value={src} checked={form.barcodeSource === src} onChange={() => setForm({ ...form, barcodeSource: src })} />
            <span>{BARCODE_SOURCE_LABELS[src]}</span>
          </label>)}
        </div>}
        <label>Product barcode<input value={form.productBarcode} onChange={e => setForm({ ...form, productBarcode: e.target.value })}
          required={form.barcodeSource === 'product'} onKeyDown={e => { if (e.key === 'Enter') e.preventDefault(); }} /></label>
      </fieldset>
      <div className="reg-head-actions">
        <button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</button>
        <button type="button" className="secondary" onClick={() => setMode('view')}>Cancel</button>
      </div>
    </form> : <dl className="fact-grid">
      {facts.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
    </dl>}

    <h4>Batches and lots <span className="muted">— issued oldest-expiry-first</span></h4>
    {!item.batches?.length ? <p className="muted">Nothing received against this item yet.</p> :
      <div className="table-scroll"><table className="data-table reg-table"><thead><tr>
        <th>Batch / lot</th><th>Received from</th><th>Available</th><th>Received</th><th>Expires</th><th>Where</th><th>Acceptance</th><th className="reg-actions-col"></th>
      </tr></thead><tbody>
        {item.batches.map(b => <tr key={b.id} className={b.quantity_available > 0 && !b.reversed_at ? '' : 'row-retired'}>
          <td>
            <span className="reg-primary">{b.batch_number || `Batch #${b.id}`}{b.reversed_at && <span className="badge inactive">reversed</span>}</span>
            <span className="reg-sub">{[b.lot_number && `lot ${b.lot_number}`, b.product_barcode].filter(Boolean).join(' · ') || '—'}</span>
          </td>
          <td>{b.source_label || (b.source_type && b.source_type !== 'supplier'
            ? `${b.source_name || ''} ${SUPPLY_SOURCE_KIND_LABELS[b.source_type] ?? ''}`.trim()
            : b.supplier_name) || <span className="muted">—</span>}
            {b.reference && <span className="reg-sub">{b.reference}</span>}</td>
          <td>{b.quantity_available} {item.unit || ''}<span className="reg-sub">of {b.quantity_received} received</span></td>
          <td className="nowrap">{String(b.date_received ?? '').slice(0, 10) || '—'}</td>
          <td>{expiryCell(b.expiry_date, b.expiry_status)}</td>
          <td>{b.storage_path || <span className="muted">—</span>}</td>
          <td>{formatBadge(b.acceptance_status)}{b.accepted_by_name && <span className="reg-sub">{b.accepted_by_name}</span>}</td>
          <td className="reg-actions-col">
            <RowMenu label={`Manage batch ${b.batch_number || b.id}`}>{close => <>
              {(b.acceptance_status === 'pending' || b.acceptance_status === 'quarantined') && !b.reversed_at && <>
                <button type="button" role="menuitem" onClick={() => { close(); acceptBatch(b.id, 'accepted'); }}>Accept on receipt</button>
                <button type="button" role="menuitem" className="danger" onClick={() => { close(); acceptBatch(b.id, 'rejected'); }}>Reject on receipt</button>
              </>}
              {mayCorrect && !b.reversed_at && <button type="button" role="menuitem" onClick={() => { close(); setEditingBatch({ ...b, item_id: item.id, item_name: item.name, unit_of_measure: item.unit ?? undefined } as InventoryBatch); }}><Pencil size={14} /> Correct this receipt…</button>}
              <button type="button" role="menuitem" onClick={() => { close(); createBatchNc(b.id); }}><ShieldAlert size={14} /> Raise a nonconformity</button>
              <button type="button" role="menuitem" onClick={() => { close(); printLabelSheet([{ barcodeValue: b.product_barcode || b.batch_number || String(b.id), title: item.name, lines: [b.batch_number ? `Batch ${b.batch_number}` : '', b.expiry_date ? `Exp ${String(b.expiry_date).slice(0, 10)}` : ''].filter(Boolean) }], { widthMm: 50, heightMm: 25, title: `${item.name} batch label` }); }}><Tag size={14} /> Print a batch label</button>
              {mayReverse && !b.reversed_at && <button type="button" role="menuitem" className="danger" onClick={() => { close(); setReversingBatch({ ...b, item_id: item.id, item_name: item.name, unit_of_measure: item.unit ?? undefined } as InventoryBatch); }}><Undo2 size={14} /> Reverse this receipt…</button>}
            </>}</RowMenu>
          </td>
        </tr>)}
      </tbody></table></div>}

    <h4>Movements</h4>
    {!item.movements?.length ? <p className="muted">Nothing has been issued or received against this item yet.</p> :
      <div className="table-scroll"><table className="data-table reg-table"><thead><tr>
        <th>Date</th><th>Movement</th><th>Quantity</th><th>Batch</th><th>To</th><th>Received by</th><th>Reason</th><th className="reg-actions-col"></th>
      </tr></thead><tbody>
        {item.movements.map(m => <tr key={m.id} className={(m as any).reversed_by_id ? 'row-retired' : ''}>
          <td className="nowrap">{String(m.movement_date ?? '').slice(0, 10)}</td>
          <td>{MOVEMENT_LABELS[m.movement_type] ?? String(m.movement_type).replace(/_/g, ' ')}
            {(m as any).reversed_by_id ? <span className="badge inactive">reversed</span> : null}
            {(m as any).reversal_of_id ? <span className="badge">a reversal</span> : null}</td>
          <td>{m.quantity} {item.unit || ''}</td>
          <td>{m.batch_number || <span className="muted">—</span>}</td>
          <td>{m.issued_to_section_name || <span className="muted">—</span>}</td>
          <td>{m.received_by_name || staffName(staff, m.received_by_staff_id ?? undefined) || <span className="muted">—</span>}</td>
          <td>{m.reason || <span className="muted">—</span>}</td>
          <td className="reg-actions-col">
            {mayReverse && !(m as any).reversed_by_id && !(m as any).reversal_of_id && !(m as any).issue_id &&
              <RowMenu label="Manage this movement">{close => <>
                <button type="button" role="menuitem" className="danger" onClick={() => { close(); setReversingMovement(m); }}><Undo2 size={14} /> Reverse this movement…</button>
              </>}</RowMenu>}
          </td>
        </tr>)}
      </tbody></table></div>}

    {adjusting && <StockAdjustModal item={item} reasons={movementReasons}
      onClose={() => setAdjusting(false)}
      onDone={async msg => { setAdjusting(false); await onChanged(msg); }} />}
    {editingBatch && <BatchEditModal batch={editingBatch} suppliers={suppliers} storagePlaces={storagePlaces}
      supplySources={supplySources} procurement={procurement}
      onClose={() => setEditingBatch(null)}
      onSaved={async msg => { setEditingBatch(null); await onChanged(msg); }} />}
    {reversingBatch && <ReasonPrompt
      title={`Reverse the receipt of ${reversingBatch.batch_number || 'this delivery'}`}
      intro="Whatever is still on the shelf from this delivery is taken back off it, and the delivery is marked reversed so nothing more can be issued from it. Anything already issued stays issued."
      confirmLabel="Reverse the receipt" danger
      onClose={() => setReversingBatch(null)}
      onConfirm={async reason => {
        const r = await api<{ message: string }>(`/supplier-inventory/batches/${reversingBatch.id}/reverse`, { method: 'POST', body: JSON.stringify({ reason }) });
        setReversingBatch(null); await onChanged(r.message);
      }} />}
    {reversingMovement && <ReasonPrompt
      title="Reverse this movement"
      intro={`The mirror of this movement is posted — ${reversingMovement.quantity} ${item.unit || ''} back the other way — so the bin card shows both the mistake and the correction.`}
      confirmLabel="Post the reversal" danger
      onClose={() => setReversingMovement(null)}
      onConfirm={async reason => {
        await api(`/supplier-inventory/movements/${reversingMovement.id}/reverse`, { method: 'POST', body: JSON.stringify({ reason }) });
        setReversingMovement(null); await onChanged('The movement has been reversed — both lines are on the bin card.');
      }} />}
  </DetailModal>;
}

/**
 * Taking a stock item off the register.
 *
 * Withdrawing is the answer almost every time: the item stops being offered
 * and its batches and movements stay, which is what lot traceability rests on.
 * Erasing is for something typed in by mistake, so it costs a written reason
 * and — once there is history behind it — a second confirmation that names
 * exactly what is about to be destroyed.
 */
function ItemRemovalModal({ impact, busy, onClose, onDone, setError }: {
  impact: ItemDeletionImpact; busy: string; onClose: () => void;
  onDone: (message: string) => void | Promise<void>; setError: (m: string | null) => void;
}) {
  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [working, setWorking] = useState('');
  const history = impact.batches + impact.movements;

  async function run(mode: 'withdraw' | 'delete', force = false) {
    setWorking(mode); setError(null);
    try {
      const r = await api<{ message: string }>(
        `/supplier-inventory/items/${impact.item.id}?mode=${mode}${force ? '&force=1' : ''}`,
        { method: 'DELETE', body: JSON.stringify({ reason: reason.trim() }) });
      await onDone(r.message);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.data.needsForce) setConfirming(true);
      else setError((e as Error).message);
    } finally { setWorking(''); }
  }

  return <DetailModal open onClose={onClose} width="narrow" title={`Remove ${impact.item.name}`}
    subtitle={impact.item.itemCode}>
    <p>
      {history === 0
        ? 'Nothing has ever been received or issued against this item, so it can simply go.'
        : <>This item carries <strong>{impact.batches}</strong> batch{impact.batches === 1 ? '' : 'es'} and <strong>{impact.movements}</strong> movement{impact.movements === 1 ? '' : 's'}
          {impact.quantityOnHand > 0 ? <>, with <strong>{impact.quantityOnHand}</strong> still on the shelf</> : null}. That history is what a recall would be traced through.</>}
    </p>
    <label>Reason <span className="muted">(kept in the audit trail)</span>
      <input value={reason} onChange={e => setReason(e.target.value)} placeholder="Discontinued, replaced by…, entered in error" />
    </label>
    <div className="danger-actions">
      <button type="button" disabled={!!working} onClick={() => void run('withdraw')}>
        {working === 'withdraw' ? 'Withdrawing…' : 'Withdraw from the register'}
      </button>
      <p className="muted">It leaves the working register. Every batch and movement stays on the record.</p>
      <button type="button" className="danger" disabled={!!working || reason.trim().length < 8}
        onClick={() => void run('delete', confirming)}>
        {working === 'delete' ? 'Erasing…' : confirming ? `Yes — erase it and its ${history} record${history === 1 ? '' : 's'}` : 'Erase permanently'}
      </button>
      <p className="muted">
        {reason.trim().length < 8 ? 'Give a reason first — at least a few words.'
          : confirming ? 'This cannot be undone.'
          : 'Only for an item entered by mistake.'}
      </p>
    </div>
  </DetailModal>;
}

/**
 * A supplier, opened — their details editable in place, and what they have
 * actually supplied and how they have been rated beside them.
 */
function SupplierDetailPanel({ supplier, evaluations, can, onClose, onSaved, onRemove, setError }: {
  supplier: Supplier; evaluations: SupplierEvaluationRow[];
  can: (module: string, action: string) => boolean;
  onClose: () => void; onSaved: () => void | Promise<void>; onRemove: () => void;
  setError: (m: string | null) => void;
}) {
  const [form, setForm] = useState({
    name: supplier.name, contactPerson: supplier.contact_person ?? '', phone: supplier.phone ?? '',
    email: supplier.email ?? '', address: supplier.address ?? '', itemCategory: supplier.item_category ?? '',
    status: supplier.status ?? 'active', evaluationRequired: !!supplier.evaluation_required,
    nextEvaluationDue: (supplier.next_evaluation_due ?? '').slice(0, 10),
  });
  const [busy, setBusy] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      await api(`/supplier-inventory/suppliers/${supplier.id}`, { method: 'PUT', body: JSON.stringify(form) });
      await onSaved();
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }

  return <DetailModal open onClose={onClose} title={supplier.name} subtitle={supplier.supplier_code}
    header={<>
      {evaluationBadge(supplier)}
      {formatBadge(supplier.status)}
      {can('supplier_inventory', 'void_archive') && <RowMenu label={`Manage ${supplier.name}`}>{close => <>
        <button type="button" role="menuitem" className="danger" onClick={() => { close(); onRemove(); }}><Trash2 size={14} /> Remove…</button>
      </>}</RowMenu>}
    </>}>
    <div className="stock-figures">
      <div><span className="fig">{supplier.item_count ?? 0}</span><span className="fig-label">items supplied</span></div>
      <div><span className="fig">{supplier.batch_count ?? 0}</span><span className="fig-label">deliveries</span></div>
      <div><span className="fig">{evaluations.length}</span><span className="fig-label">evaluations</span></div>
      <div><span className="fig">{(supplier.last_evaluation_date ?? '').slice(0, 10) || '—'}</span><span className="fig-label">last evaluated</span></div>
    </div>

    <form className="form" onSubmit={save} style={{ marginTop: 14 }}>
      <label>Name<input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required /></label>
      <label>Contact person<input value={form.contactPerson} onChange={e => setForm({ ...form, contactPerson: e.target.value })} /></label>
      <label>Phone<input value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} /></label>
      <label>Email<input type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} /></label>
      <label>Address<input value={form.address} onChange={e => setForm({ ...form, address: e.target.value })} /></label>
      <label>What they supply<input value={form.itemCategory} onChange={e => setForm({ ...form, itemCategory: e.target.value })} /></label>
      <label>Status<select value={form.status} onChange={e => setForm({ ...form, status: e.target.value })}>
        {['active', 'suspended', 'inactive'].map(st => <option key={st} value={st}>{st[0].toUpperCase() + st.slice(1)}</option>)}
      </select></label>
      <label>Next evaluation due<input type="date" value={form.nextEvaluationDue} onChange={e => setForm({ ...form, nextEvaluationDue: e.target.value })} /></label>
      <label className="toggle"><input type="checkbox" checked={form.evaluationRequired} onChange={e => setForm({ ...form, evaluationRequired: e.target.checked })} /> They must be evaluated periodically</label>
      <button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</button>
    </form>

    <h4>Evaluations</h4>
    {evaluations.length === 0 ? <p className="muted">This supplier has never been evaluated.</p> :
      <div className="table-scroll"><table className="data-table"><thead><tr>
        <th>Date</th><th>Rating</th><th>Findings</th><th>Action required</th><th>Next due</th><th>By</th>
      </tr></thead><tbody>
        {evaluations.map(ev => <tr key={ev.id}>
          <td className="nowrap">{String(ev.evaluation_date ?? '').slice(0, 10)}</td>
          <td>{ev.rating ? formatBadge(ev.rating) : <span className="muted">—</span>}</td>
          <td>{ev.findings || <span className="muted">—</span>}</td>
          <td>{ev.action_required || <span className="muted">—</span>}</td>
          <td>{String(ev.next_evaluation_date ?? '').slice(0, 10) || <span className="muted">—</span>}</td>
          <td>{ev.evaluated_by_name || <span className="muted">—</span>}</td>
        </tr>)}
      </tbody></table></div>}
  </DetailModal>;
}

/**
 * Taking a supplier off the register.
 *
 * Suspending is the answer almost every time: they stop being offered for new
 * orders and every reagent they ever delivered keeps their name, which is what
 * a recall is traced through. Erasing is for a duplicate or a typo — the stock
 * is detached rather than deleted, so nothing loses its record along with them.
 */
function SupplierRemovalModal({ impact, onClose, onDone, setError }: {
  impact: SupplierDeletionImpact; onClose: () => void;
  onDone: (message: string) => void | Promise<void>; setError: (m: string | null) => void;
}) {
  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [working, setWorking] = useState('');
  const history = impact.items + impact.batches + impact.evaluations;

  async function run(mode: 'suspend' | 'delete', force = false) {
    setWorking(mode); setError(null);
    try {
      const r = await api<{ message: string }>(
        `/supplier-inventory/suppliers/${impact.supplier.id}?mode=${mode}${force ? '&force=1' : ''}`,
        { method: 'DELETE', body: JSON.stringify({ reason: reason.trim() }) });
      await onDone(r.message);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.data.needsForce) setConfirming(true);
      else setError((e as Error).message);
    } finally { setWorking(''); }
  }

  return <DetailModal open onClose={onClose} width="narrow" title={`Remove ${impact.supplier.name}`} subtitle={impact.supplier.supplierCode}>
    <p>
      {history === 0
        ? 'Nothing has ever been ordered from this supplier, so they can simply go.'
        : <>They supply <strong>{impact.items}</strong> item{impact.items === 1 ? '' : 's'}, have delivered <strong>{impact.batches}</strong> batch{impact.batches === 1 ? '' : 'es'} and carry <strong>{impact.evaluations}</strong> evaluation{impact.evaluations === 1 ? '' : 's'}.</>}
    </p>
    <label>Reason <span className="muted">(kept in the audit trail)</span>
      <input value={reason} onChange={e => setReason(e.target.value)} placeholder="Contract ended, duplicate record, entered in error" />
    </label>
    <div className="danger-actions">
      <button type="button" disabled={!!working} onClick={() => void run('suspend')}>
        {working === 'suspend' ? 'Suspending…' : 'Suspend them'}
      </button>
      <p className="muted">They stop being offered for new orders. Everything they supplied keeps their name.</p>
      <button type="button" className="danger" disabled={!!working || reason.trim().length < 8} onClick={() => void run('delete', confirming)}>
        {working === 'delete' ? 'Erasing…' : confirming ? 'Yes — erase them' : 'Erase permanently'}
      </button>
      <p className="muted">
        {reason.trim().length < 8 ? 'Give a reason first — at least a few words.'
          : confirming ? `The ${impact.items} item(s) and ${impact.batches} batch(es) stay; only the supplier record goes.`
          : 'Only for a duplicate or a record entered by mistake.'}
      </p>
    </div>
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
