import { FormEvent, useEffect, useState } from 'react';
import PageHeader from '../components/ui/PageHeader';
import { KpiStrip, ChartCard, DonutChart, BarMeter, CHART_COLORS, ModuleAlerts } from '../components/ui';
import { useModules } from '../hooks/useModules';
import { api, API_BASE, getToken } from '../services/api';
import DisabledModule from '../components/DisabledModule';
import { usePermissions } from '../hooks/usePermissions';
import type {
  Section, Department, Staff, Location,
  PoctSite, PoctDevice, PoctTest, PoctOperatorAuthorization,
  PoctReagentLot, PoctQcMaterial, PoctQcResult, PoctEqaEvent,
  PoctMaintenanceLog, PoctIncident, PoctMonthlyReview, PoctSummary
} from '../../shared/types/api';

const statusBadgeClass = (status?: string) => `badge ${status ? status.toLowerCase().replace(/\s+/g, '-') : 'unknown'}`;
const formatBadge = (status?: string) => <span className={statusBadgeClass(status)}>{status ? status.replace(/_/g, ' ') : 'Unknown'}</span>;
const tabBar = (active: string, tabs: string[], onChange: (name: string) => void) =>
  <div className="tabs">{tabs.map(name => <button key={name} type="button" className={active === name ? 'active' : ''} onClick={() => onChange(name)}>{name}</button>)}</div>;

const AUTHORIZATION_LEVELS = ['observe_only', 'perform', 'review', 'supervise', 'train_others'];
const REAGENT_STATUSES = ['received', 'in_use', 'expired', 'discarded', 'reserved'];
const MAINTENANCE_TYPES = ['daily_check', 'cleaning', 'calibration_check', 'preventive_maintenance', 'repair', 'troubleshooting', 'other'];
const SEVERITIES = ['low', 'medium', 'high', 'critical'];
const EQA_PERFORMANCE_STATUSES = ['satisfactory', 'unsatisfactory', 'pending', 'not_submitted', 'not_applicable'];
const QC_STATUSES = ['accepted', 'warning', 'failed', 'pending_review'];

function useLookups() {
  const [staff, setStaff] = useState<Staff[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  useEffect(() => {
    api<Staff[]>('/staff').then(setStaff).catch(() => setStaff([]));
    api<Section[]>('/sections').then(setSections).catch(() => setSections([]));
    api<Department[]>('/departments').then(setDepartments).catch(() => setDepartments([]));
    api<Location[]>('/locations').then(setLocations).catch(() => setLocations([]));
  }, []);
  return { staff, sections, departments, locations };
}

function staffName(staffList: Staff[], id?: number | null) {
  if (!id) return '—';
  return staffList.find(s => s.id === id)?.fullName || `Staff #${id}`;
}

export function POCTPage({ embedded = false }: { embedded?: boolean } = {}) {
  const { can } = usePermissions();
  const { isEnabled } = useModules();
  const { staff, sections, departments, locations } = useLookups();
  const [tab, setTab] = useState(embedded ? 'Sites' : 'Dashboard');
  const [error, setError] = useState<string | null>(null);

  const [summary, setSummary] = useState<PoctSummary | null>(null);
  const [sites, setSites] = useState<PoctSite[]>([]);
  const [devices, setDevices] = useState<PoctDevice[]>([]);
  const [tests, setTests] = useState<PoctTest[]>([]);
  const [authorizations, setAuthorizations] = useState<PoctOperatorAuthorization[]>([]);
  const [reagentLots, setReagentLots] = useState<PoctReagentLot[]>([]);
  const [qcMaterials, setQcMaterials] = useState<PoctQcMaterial[]>([]);
  const [qcResults, setQcResults] = useState<PoctQcResult[]>([]);
  const [eqaEvents, setEqaEvents] = useState<PoctEqaEvent[]>([]);
  const [maintenance, setMaintenance] = useState<PoctMaintenanceLog[]>([]);
  const [incidents, setIncidents] = useState<PoctIncident[]>([]);
  const [reviews, setReviews] = useState<PoctMonthlyReview[]>([]);
  const [poctActions, setPoctActions] = useState<any[]>([]);
  const [trendFilter, setTrendFilter] = useState<{ deviceId: string; testId: string; materialId: string }>({ deviceId: '', testId: '', materialId: '' });
  const [trendData, setTrendData] = useState<any | null>(null);

  const [siteForm, setSiteForm] = useState({ siteCode: '', siteName: '', departmentId: '', sectionId: '', locationId: '', serviceArea: '', responsibleStaffId: '', contactPerson: '', notes: '' });
  const [deviceForm, setDeviceForm] = useState({ siteId: '', deviceCode: '', deviceName: '', deviceType: '', manufacturer: '', model: '', serialNumber: '', testMenuSummary: '', installationDate: '', nextServiceDue: '', notes: '' });
  const [testForm, setTestForm] = useState({ testCode: '', testName: '', sampleType: '', resultUnit: '', methodSummary: '', deviceType: '', clinicalArea: '' });
  const [authForm, setAuthForm] = useState({ staffId: '', siteId: '', deviceId: '', testId: '', authorizationLevel: 'perform', authorizedDate: '', expiryDate: '', restrictions: '', competencyAssessmentId: '' });
  const [reagentForm, setReagentForm] = useState({ lotNumber: '', reagentName: '', deviceId: '', testId: '', manufacturer: '', receivedDate: '', openedDate: '', expiryDate: '', storageCondition: '', status: 'received' });
  const [qcMaterialForm, setQcMaterialForm] = useState({ materialCode: '', materialName: '', deviceId: '', testId: '', lotNumber: '', manufacturer: '', expiryDate: '', targetValue: '', acceptableLow: '', acceptableHigh: '' });
  const [qcResultForm, setQcResultForm] = useState({ qcDate: '', qcTime: '', siteId: '', deviceId: '', testId: '', qcMaterialId: '', reagentLotId: '', resultValue: '', expectedResult: '', interpretation: '', immediateAction: '' });
  const [eqaForm, setEqaForm] = useState({ siteId: '', deviceId: '', testId: '', eqaProgramId: '', cycleName: '', receivedDate: '', dueDate: '', submittedDate: '', resultReceivedDate: '', performanceStatus: 'pending', findings: '', correctiveActionRequired: false, responsibleStaffId: '' });
  const [maintForm, setMaintForm] = useState({ siteId: '', deviceId: '', maintenanceDate: '', maintenanceType: 'daily_check', description: '', outcome: '', nextDueDate: '', performedByStaffId: '' });
  const [incidentForm, setIncidentForm] = useState({ incidentDate: '', siteId: '', deviceId: '', testId: '', title: '', description: '', immediateAction: '', severity: 'medium', outcome: '' });
  const [reviewForm, setReviewForm] = useState<{ reviewMonth: number; reviewYear: number; siteId: string; summary: string }>({ reviewMonth: new Date().getMonth() + 1, reviewYear: new Date().getFullYear(), siteId: '', summary: '' });

  async function load() {
    try {
      const [sum, s, d, t, a, rl, qm, qr, eq, mn, inc, rv] = await Promise.all([
        api<PoctSummary>('/dashboard/poct-summary').catch(() => null),
        api<PoctSite[]>('/poct/sites'),
        api<PoctDevice[]>('/poct/devices'),
        api<PoctTest[]>('/poct/tests'),
        api<PoctOperatorAuthorization[]>('/poct/authorizations'),
        api<PoctReagentLot[]>('/poct/reagent-lots'),
        api<PoctQcMaterial[]>('/poct/qc-materials'),
        api<PoctQcResult[]>('/poct/qc-results'),
        api<PoctEqaEvent[]>('/poct/eqa-events'),
        api<PoctMaintenanceLog[]>('/poct/maintenance'),
        api<PoctIncident[]>('/poct/incidents'),
        api<PoctMonthlyReview[]>('/poct/monthly-reviews')
      ]);
      if (sum) setSummary(sum);
      setSites(s); setDevices(d); setTests(t); setAuthorizations(a); setReagentLots(rl);
      setQcMaterials(qm); setQcResults(qr); setEqaEvents(eq); setMaintenance(mn); setIncidents(inc); setReviews(rv);
    } catch (e) { setError((e as Error).message); }
  }
  useEffect(() => { if (embedded || isEnabled('poct')) void load(); }, [isEnabled]);
  if (!embedded && !isEnabled('poct')) return <DisabledModule />;

  async function post(path: string, body: any) { return api(path, { method: 'POST', body: JSON.stringify(body) }); }

  async function openPrintPage(path: string) {
    try {
      const token = getToken();
      const response = await fetch(`${API_BASE}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : undefined });
      if (!response.ok) throw new Error(await response.text() || response.statusText);
      const html = await response.text();
      const w = window.open('', '_blank');
      if (!w) { setError('Pop-up blocked. Allow pop-ups to open the print dialog.'); return; }
      w.document.open(); w.document.write(html); w.document.close();
    } catch (e) { setError((e as Error).message); }
  }

  async function loadTrend() {
    if (!trendFilter.deviceId || !trendFilter.testId) { setTrendData(null); return; }
    try {
      const params = new URLSearchParams({ deviceId: trendFilter.deviceId, testId: trendFilter.testId });
      if (trendFilter.materialId) params.set('materialId', trendFilter.materialId);
      setTrendData(await api(`/poct/qc-trend?${params.toString()}`));
    } catch (e) { setError((e as Error).message); }
  }

  async function loadActions() { try { setPoctActions(await api<any[]>('/poct/actions')); } catch (e) { setError((e as Error).message); } }
  useEffect(() => { if (tab === 'Reports' && (embedded || isEnabled('poct'))) void loadActions(); }, [tab, isEnabled]);

  async function submitSite(e: FormEvent) { e.preventDefault(); setError(null); try { await post('/poct/sites', siteForm); setSiteForm({ siteCode: '', siteName: '', departmentId: '', sectionId: '', locationId: '', serviceArea: '', responsibleStaffId: '', contactPerson: '', notes: '' }); await load(); } catch (e) { setError((e as Error).message); } }
  async function toggleSite(id: number) { try { await post(`/poct/sites/${id}/toggle`, {}); await load(); } catch (e) { setError((e as Error).message); } }
  async function submitDevice(e: FormEvent) { e.preventDefault(); setError(null); try { await post('/poct/devices', deviceForm); setDeviceForm({ siteId: '', deviceCode: '', deviceName: '', deviceType: '', manufacturer: '', model: '', serialNumber: '', testMenuSummary: '', installationDate: '', nextServiceDue: '', notes: '' }); await load(); } catch (e) { setError((e as Error).message); } }
  async function setDeviceStatus(id: number, status: string) { try { await post(`/poct/devices/${id}/status`, { status }); await load(); } catch (e) { setError((e as Error).message); } }
  async function submitTest(e: FormEvent) { e.preventDefault(); setError(null); try { await post('/poct/tests', testForm); setTestForm({ testCode: '', testName: '', sampleType: '', resultUnit: '', methodSummary: '', deviceType: '', clinicalArea: '' }); await load(); } catch (e) { setError((e as Error).message); } }
  async function toggleTest(id: number) { try { await post(`/poct/tests/${id}/toggle`, {}); await load(); } catch (e) { setError((e as Error).message); } }
  async function submitAuth(e: FormEvent) { e.preventDefault(); setError(null); try { await post('/poct/authorizations', authForm); setAuthForm({ staffId: '', siteId: '', deviceId: '', testId: '', authorizationLevel: 'perform', authorizedDate: '', expiryDate: '', restrictions: '', competencyAssessmentId: '' }); await load(); } catch (e) { setError((e as Error).message); } }
  async function approveAuth(id: number) { try { await post(`/poct/authorizations/${id}/approve`, {}); await load(); } catch (e) { setError((e as Error).message); } }
  async function revokeAuth(id: number) { const reason = prompt('Reason for revocation?') || ''; try { await post(`/poct/authorizations/${id}/revoke`, { reason }); await load(); } catch (e) { setError((e as Error).message); } }
  async function submitReagent(e: FormEvent) { e.preventDefault(); setError(null); try { await post('/poct/reagent-lots', reagentForm); setReagentForm({ lotNumber: '', reagentName: '', deviceId: '', testId: '', manufacturer: '', receivedDate: '', openedDate: '', expiryDate: '', storageCondition: '', status: 'received' }); await load(); } catch (e) { setError((e as Error).message); } }
  async function submitQcMaterial(e: FormEvent) { e.preventDefault(); setError(null); try { await post('/poct/qc-materials', qcMaterialForm); setQcMaterialForm({ materialCode: '', materialName: '', deviceId: '', testId: '', lotNumber: '', manufacturer: '', expiryDate: '', targetValue: '', acceptableLow: '', acceptableHigh: '' }); await load(); } catch (e) { setError((e as Error).message); } }
  async function submitQcResult(e: FormEvent) { e.preventDefault(); setError(null); try { await post('/poct/qc-results', qcResultForm); setQcResultForm({ qcDate: '', qcTime: '', siteId: '', deviceId: '', testId: '', qcMaterialId: '', reagentLotId: '', resultValue: '', expectedResult: '', interpretation: '', immediateAction: '' }); await load(); } catch (e) { setError((e as Error).message); } }
  async function reviewQc(id: number) { try { await post(`/poct/qc-results/${id}/review`, {}); await load(); } catch (e) { setError((e as Error).message); } }
  async function qcCreateNc(id: number) { try { await post(`/poct/qc-results/${id}/create-nc`, {}); await load(); } catch (e) { setError((e as Error).message); } }
  async function qcCreateCapa(id: number) { try { await post(`/poct/qc-results/${id}/create-capa`, {}); await load(); } catch (e) { setError((e as Error).message); } }
  async function submitEqa(e: FormEvent) { e.preventDefault(); setError(null); try { await post('/poct/eqa-events', eqaForm); setEqaForm({ siteId: '', deviceId: '', testId: '', eqaProgramId: '', cycleName: '', receivedDate: '', dueDate: '', submittedDate: '', resultReceivedDate: '', performanceStatus: 'pending', findings: '', correctiveActionRequired: false, responsibleStaffId: '' }); await load(); } catch (e) { setError((e as Error).message); } }
  async function eqaCreateNc(id: number) { try { await post(`/poct/eqa-events/${id}/create-nc`, {}); await load(); } catch (e) { setError((e as Error).message); } }
  async function eqaCreateCapa(id: number) { try { await post(`/poct/eqa-events/${id}/create-capa`, {}); await load(); } catch (e) { setError((e as Error).message); } }
  async function closeEqa(id: number) { try { await post(`/poct/eqa-events/${id}/close`, {}); await load(); } catch (e) { setError((e as Error).message); } }
  async function submitMaint(e: FormEvent) { e.preventDefault(); setError(null); try { await post('/poct/maintenance', maintForm); setMaintForm({ siteId: '', deviceId: '', maintenanceDate: '', maintenanceType: 'daily_check', description: '', outcome: '', nextDueDate: '', performedByStaffId: '' }); await load(); } catch (e) { setError((e as Error).message); } }
  async function closeMaint(id: number) { try { await post(`/poct/maintenance/${id}/close`, {}); await load(); } catch (e) { setError((e as Error).message); } }
  async function submitIncident(e: FormEvent) { e.preventDefault(); setError(null); try { await post('/poct/incidents', incidentForm); setIncidentForm({ incidentDate: '', siteId: '', deviceId: '', testId: '', title: '', description: '', immediateAction: '', severity: 'medium', outcome: '' }); await load(); } catch (e) { setError((e as Error).message); } }
  async function incidentCreateAction(id: number) { const title = prompt('Action title?'); if (!title) return; try { await post(`/poct/incidents/${id}/create-action`, { title }); await load(); } catch (e) { setError((e as Error).message); } }
  async function incidentCreateNc(id: number) { try { await post(`/poct/incidents/${id}/create-nc`, {}); await load(); } catch (e) { setError((e as Error).message); } }
  async function incidentCreateCapa(id: number) { try { await post(`/poct/incidents/${id}/create-capa`, {}); await load(); } catch (e) { setError((e as Error).message); } }
  async function closeIncident(id: number) { const outcome = prompt('Outcome summary?') || ''; try { await post(`/poct/incidents/${id}/close`, { outcome }); await load(); } catch (e) { setError((e as Error).message); } }
  async function submitReview(e: FormEvent) { e.preventDefault(); setError(null); try { await post('/poct/monthly-reviews', reviewForm); setReviewForm({ reviewMonth: new Date().getMonth() + 1, reviewYear: new Date().getFullYear(), siteId: '', summary: '' }); await load(); } catch (e) { setError((e as Error).message); } }
  async function generateReviewSummary(id: number) { try { await post(`/poct/monthly-reviews/${id}/generate-summary`, {}); await load(); } catch (e) { setError((e as Error).message); } }
  async function reviewReview(id: number) { try { await post(`/poct/monthly-reviews/${id}/review`, {}); await load(); } catch (e) { setError((e as Error).message); } }
  async function approveReview(id: number) { try { await post(`/poct/monthly-reviews/${id}/approve`, {}); await load(); } catch (e) { setError((e as Error).message); } }
  async function closeReview(id: number) { try { await post(`/poct/monthly-reviews/${id}/close`, {}); await load(); } catch (e) { setError((e as Error).message); } }

  const tabs = ['Dashboard', 'Sites', 'Devices', 'Test Menu', 'Operator Authorizations', 'Reagent Lots', 'QC Monitoring', 'EQA Monitoring', 'Maintenance Logs', 'Incidents', 'Monthly Reviews', 'Reports'].filter(name => !embedded || name !== 'Dashboard');

  return <div className="module-page">
    {!embedded && <PageHeader eyebrow="Process Management" title="POCT Oversight" subtitle="Point-of-care testing sites, QC, and incident oversight." />}
    {tabBar(tab, tabs, setTab)}
    {error && <div className="error">{error}</div>}

    {tab === 'Dashboard' && <ModuleAlerts moduleKey="poct" />}
    {tab === 'Dashboard' && (summary ? <KpiStrip items={[
      { label: 'Active sites', value: summary.activeSites, onClick: () => setTab('Sites') },
      { label: 'Active devices', value: summary.activeDevices, onClick: () => setTab('Devices') },
      { label: 'Authorised operators', value: summary.authorizedOperators, onClick: () => setTab('Operator Authorizations') },
      { label: 'Expired authorisations', value: summary.expiredAuthorizations, tone: 'warning', onClick: () => setTab('Operator Authorizations') },
      { label: 'QC failures (month)', value: summary.qcFailuresThisMonth, tone: 'danger', onClick: () => setTab('QC Monitoring') },
      { label: 'Unsatisfactory EQA', value: summary.unsatisfactoryEqaEvents, onClick: () => setTab('EQA Monitoring') },
      { label: 'Open incidents', value: summary.openIncidents, onClick: () => setTab('Incidents') },
      { label: 'Maintenance due', value: summary.maintenanceDue, onClick: () => setTab('Maintenance Logs') },
    ]} /> : <p>Loading summary…</p>)}
    {tab === 'Dashboard' && summary && <div className="grid cols-2" style={{ marginTop: 18 }}>
      <ChartCard title="POCT network" subtitle="Active estate and authorised operators">
        <DonutChart centerLabel="Estate" data={[
          { label: 'Active sites', value: summary.activeSites, color: CHART_COLORS[0] },
          { label: 'Active devices', value: summary.activeDevices, color: CHART_COLORS[5] },
          { label: 'Authorised operators', value: summary.authorizedOperators, color: CHART_COLORS[1] },
        ]} />
      </ChartCard>
      <ChartCard title="Quality & compliance" subtitle="Issues needing attention">
        <BarMeter data={[
          { label: 'QC failures (month)', value: summary.qcFailuresThisMonth, color: CHART_COLORS[3] },
          { label: 'Unsatisfactory EQA', value: summary.unsatisfactoryEqaEvents, color: CHART_COLORS[2] },
          { label: 'Open incidents', value: summary.openIncidents, color: CHART_COLORS[4] },
          { label: 'Expired authorisations', value: summary.expiredAuthorizations, color: CHART_COLORS[6] },
          { label: 'Maintenance due', value: summary.maintenanceDue, color: CHART_COLORS[0] },
        ]} />
      </ChartCard>
    </div>}

    {tab === 'Sites' && <>
      <form className="form-grid" onSubmit={submitSite}>
        <label>Site code<input value={siteForm.siteCode} onChange={e => setSiteForm({ ...siteForm, siteCode: e.target.value })} /></label>
        <label>Site name<input value={siteForm.siteName} onChange={e => setSiteForm({ ...siteForm, siteName: e.target.value })} required /></label>
        <label>Department<select value={siteForm.departmentId} onChange={e => setSiteForm({ ...siteForm, departmentId: e.target.value })}><option value="">—</option>{departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
        <label>Section<select value={siteForm.sectionId} onChange={e => setSiteForm({ ...siteForm, sectionId: e.target.value })}><option value="">—</option>{sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label>Location<select value={siteForm.locationId} onChange={e => setSiteForm({ ...siteForm, locationId: e.target.value })}><option value="">—</option>{locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
        <label>Service area<input value={siteForm.serviceArea} onChange={e => setSiteForm({ ...siteForm, serviceArea: e.target.value })} /></label>
        <label>Responsible staff<select value={siteForm.responsibleStaffId} onChange={e => setSiteForm({ ...siteForm, responsibleStaffId: e.target.value })}><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
        <label>Contact person<input value={siteForm.contactPerson} onChange={e => setSiteForm({ ...siteForm, contactPerson: e.target.value })} /></label>
        <label>Notes<textarea value={siteForm.notes} onChange={e => setSiteForm({ ...siteForm, notes: e.target.value })} /></label>
        <button type="submit">Create site</button>
      </form>
      <table className="data-table"><thead><tr><th>Code</th><th>Name</th><th>Section</th><th>Responsible</th><th>Status</th><th></th></tr></thead><tbody>
        {sites.map(s => <tr key={s.id}><td>{s.site_code || '—'}</td><td>{s.site_name}</td><td>{sections.find(x => x.id === s.section_id)?.name || '—'}</td><td>{staffName(staff, s.responsible_staff_id)}</td><td>{formatBadge(s.status)}</td><td><button onClick={() => toggleSite(s.id)}>Toggle</button> {can('poct', 'print') && <><button onClick={() => openPrintPage(`/poct/sites/${s.id}/print`)}>Print site report</button> <button onClick={() => openPrintPage(`/poct/sites/${s.id}/authorization-roster/print`)}>Print roster</button></>}</td></tr>)}
      </tbody></table>
    </>}

    {tab === 'Devices' && <>
      <form className="form-grid" onSubmit={submitDevice}>
        <label>Site<select value={deviceForm.siteId} onChange={e => setDeviceForm({ ...deviceForm, siteId: e.target.value })} required><option value="">—</option>{sites.map(s => <option key={s.id} value={s.id}>{s.site_name}</option>)}</select></label>
        <label>Code<input value={deviceForm.deviceCode} onChange={e => setDeviceForm({ ...deviceForm, deviceCode: e.target.value })} /></label>
        <label>Name<input value={deviceForm.deviceName} onChange={e => setDeviceForm({ ...deviceForm, deviceName: e.target.value })} required /></label>
        <label>Type<input value={deviceForm.deviceType} onChange={e => setDeviceForm({ ...deviceForm, deviceType: e.target.value })} required placeholder="e.g. glucose meter" /></label>
        <label>Manufacturer<input value={deviceForm.manufacturer} onChange={e => setDeviceForm({ ...deviceForm, manufacturer: e.target.value })} /></label>
        <label>Model<input value={deviceForm.model} onChange={e => setDeviceForm({ ...deviceForm, model: e.target.value })} /></label>
        <label>Serial<input value={deviceForm.serialNumber} onChange={e => setDeviceForm({ ...deviceForm, serialNumber: e.target.value })} /></label>
        <label>Test menu summary<input value={deviceForm.testMenuSummary} onChange={e => setDeviceForm({ ...deviceForm, testMenuSummary: e.target.value })} /></label>
        <label>Installation date<input type="date" value={deviceForm.installationDate} onChange={e => setDeviceForm({ ...deviceForm, installationDate: e.target.value })} /></label>
        <label>Next service due<input type="date" value={deviceForm.nextServiceDue} onChange={e => setDeviceForm({ ...deviceForm, nextServiceDue: e.target.value })} /></label>
        <label>Notes<textarea value={deviceForm.notes} onChange={e => setDeviceForm({ ...deviceForm, notes: e.target.value })} /></label>
        <button type="submit">Register device</button>
      </form>
      <table className="data-table"><thead><tr><th>Code</th><th>Site</th><th>Name</th><th>Type</th><th>Model</th><th>Serial</th><th>Status</th><th>Next service</th><th></th></tr></thead><tbody>
        {devices.map(d => <tr key={d.id}><td>{d.device_code || '—'}</td><td>{d.site_name || '—'}</td><td>{d.device_name}</td><td>{d.device_type}</td><td>{d.model || '—'}</td><td>{d.serial_number || '—'}</td><td>{formatBadge(d.status)}</td><td>{d.next_service_due || '—'}</td>
          <td><button onClick={() => setDeviceStatus(d.id, d.status === 'active' ? 'under_maintenance' : 'active')}>{d.status === 'active' ? 'Mark under maintenance' : 'Set active'}</button></td>
        </tr>)}
      </tbody></table>
    </>}

    {tab === 'Test Menu' && <>
      <form className="form-grid" onSubmit={submitTest}>
        <label>Code<input value={testForm.testCode} onChange={e => setTestForm({ ...testForm, testCode: e.target.value })} /></label>
        <label>Name<input value={testForm.testName} onChange={e => setTestForm({ ...testForm, testName: e.target.value })} required /></label>
        <label>Sample type<input value={testForm.sampleType} onChange={e => setTestForm({ ...testForm, sampleType: e.target.value })} /></label>
        <label>Result unit<input value={testForm.resultUnit} onChange={e => setTestForm({ ...testForm, resultUnit: e.target.value })} /></label>
        <label>Method<input value={testForm.methodSummary} onChange={e => setTestForm({ ...testForm, methodSummary: e.target.value })} /></label>
        <label>Device type<input value={testForm.deviceType} onChange={e => setTestForm({ ...testForm, deviceType: e.target.value })} /></label>
        <label>Clinical area<input value={testForm.clinicalArea} onChange={e => setTestForm({ ...testForm, clinicalArea: e.target.value })} /></label>
        <button type="submit">Add test</button>
      </form>
      <table className="data-table"><thead><tr><th>Code</th><th>Name</th><th>Sample</th><th>Unit</th><th>Method</th><th>Active</th><th></th></tr></thead><tbody>
        {tests.map(t => <tr key={t.id}><td>{t.test_code || '—'}</td><td>{t.test_name}</td><td>{t.sample_type || '—'}</td><td>{t.result_unit || '—'}</td><td>{t.method_summary || '—'}</td><td>{t.is_active ? 'Yes' : 'No'}</td><td><button onClick={() => toggleTest(t.id)}>Toggle</button></td></tr>)}
      </tbody></table>
    </>}

    {tab === 'Operator Authorizations' && <>
      <form className="form-grid" onSubmit={submitAuth}>
        <label>Staff<select value={authForm.staffId} onChange={e => setAuthForm({ ...authForm, staffId: e.target.value })} required><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
        <label>Site<select value={authForm.siteId} onChange={e => setAuthForm({ ...authForm, siteId: e.target.value })}><option value="">—</option>{sites.map(s => <option key={s.id} value={s.id}>{s.site_name}</option>)}</select></label>
        <label>Device<select value={authForm.deviceId} onChange={e => setAuthForm({ ...authForm, deviceId: e.target.value })}><option value="">—</option>{devices.map(d => <option key={d.id} value={d.id}>{d.device_name}</option>)}</select></label>
        <label>Test<select value={authForm.testId} onChange={e => setAuthForm({ ...authForm, testId: e.target.value })}><option value="">—</option>{tests.map(t => <option key={t.id} value={t.id}>{t.test_name}</option>)}</select></label>
        <label>Level<select value={authForm.authorizationLevel} onChange={e => setAuthForm({ ...authForm, authorizationLevel: e.target.value })}>{AUTHORIZATION_LEVELS.map(l => <option key={l} value={l}>{l.replace(/_/g, ' ')}</option>)}</select></label>
        <label>Authorised date<input type="date" value={authForm.authorizedDate} onChange={e => setAuthForm({ ...authForm, authorizedDate: e.target.value })} /></label>
        <label>Expiry date<input type="date" value={authForm.expiryDate} onChange={e => setAuthForm({ ...authForm, expiryDate: e.target.value })} /></label>
        <label>Competency assessment id<input type="number" value={authForm.competencyAssessmentId} onChange={e => setAuthForm({ ...authForm, competencyAssessmentId: e.target.value })} /></label>
        <label>Restrictions<input value={authForm.restrictions} onChange={e => setAuthForm({ ...authForm, restrictions: e.target.value })} /></label>
        <button type="submit">Create authorisation</button>
      </form>
      <table className="data-table"><thead><tr><th>Number</th><th>Staff</th><th>Site</th><th>Device</th><th>Test</th><th>Level</th><th>Expiry</th><th>Status</th><th></th></tr></thead><tbody>
        {authorizations.map(a => <tr key={a.id}><td>{a.authorization_number || '—'}</td><td>{a.staff_name || staffName(staff, a.staff_id)}</td><td>{a.site_name || '—'}</td><td>{a.device_name || '—'}</td><td>{a.test_name || '—'}</td><td>{a.authorization_level.replace(/_/g, ' ')}</td><td>{a.expiry_date || '—'}{a._expired && <span className="badge danger"> expired</span>}</td><td>{formatBadge(a.status)}</td>
          <td>{a.status === 'draft' && <button onClick={() => approveAuth(a.id)}>Approve</button>}{a.status !== 'revoked' && <button onClick={() => revokeAuth(a.id)}>Revoke</button>}</td>
        </tr>)}
      </tbody></table>
    </>}

    {tab === 'Reagent Lots' && <>
      <form className="form-grid" onSubmit={submitReagent}>
        <label>Lot number<input value={reagentForm.lotNumber} onChange={e => setReagentForm({ ...reagentForm, lotNumber: e.target.value })} required /></label>
        <label>Reagent name<input value={reagentForm.reagentName} onChange={e => setReagentForm({ ...reagentForm, reagentName: e.target.value })} required /></label>
        <label>Device<select value={reagentForm.deviceId} onChange={e => setReagentForm({ ...reagentForm, deviceId: e.target.value })}><option value="">—</option>{devices.map(d => <option key={d.id} value={d.id}>{d.device_name}</option>)}</select></label>
        <label>Test<select value={reagentForm.testId} onChange={e => setReagentForm({ ...reagentForm, testId: e.target.value })}><option value="">—</option>{tests.map(t => <option key={t.id} value={t.id}>{t.test_name}</option>)}</select></label>
        <label>Manufacturer<input value={reagentForm.manufacturer} onChange={e => setReagentForm({ ...reagentForm, manufacturer: e.target.value })} /></label>
        <label>Received date<input type="date" value={reagentForm.receivedDate} onChange={e => setReagentForm({ ...reagentForm, receivedDate: e.target.value })} /></label>
        <label>Opened date<input type="date" value={reagentForm.openedDate} onChange={e => setReagentForm({ ...reagentForm, openedDate: e.target.value })} /></label>
        <label>Expiry<input type="date" value={reagentForm.expiryDate} onChange={e => setReagentForm({ ...reagentForm, expiryDate: e.target.value })} required /></label>
        <label>Storage condition<input value={reagentForm.storageCondition} onChange={e => setReagentForm({ ...reagentForm, storageCondition: e.target.value })} /></label>
        <label>Status<select value={reagentForm.status} onChange={e => setReagentForm({ ...reagentForm, status: e.target.value })}>{REAGENT_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}</select></label>
        <button type="submit">Register lot</button>
      </form>
      <table className="data-table"><thead><tr><th>Lot</th><th>Reagent</th><th>Device</th><th>Test</th><th>Expiry</th><th>Status</th></tr></thead><tbody>
        {reagentLots.map(r => <tr key={r.id}><td>{r.lot_number}</td><td>{r.reagent_name}</td><td>{r.device_name || '—'}</td><td>{r.test_name || '—'}</td><td>{r.expiry_date}{r._expired && <span className="badge danger"> expired</span>}</td><td>{formatBadge(r.status)}</td></tr>)}
      </tbody></table>
    </>}

    {tab === 'QC Monitoring' && <>
      <h3>QC materials</h3>
      <form className="form-grid" onSubmit={submitQcMaterial}>
        <label>Material name<input value={qcMaterialForm.materialName} onChange={e => setQcMaterialForm({ ...qcMaterialForm, materialName: e.target.value })} required /></label>
        <label>Code<input value={qcMaterialForm.materialCode} onChange={e => setQcMaterialForm({ ...qcMaterialForm, materialCode: e.target.value })} /></label>
        <label>Device<select value={qcMaterialForm.deviceId} onChange={e => setQcMaterialForm({ ...qcMaterialForm, deviceId: e.target.value })}><option value="">—</option>{devices.map(d => <option key={d.id} value={d.id}>{d.device_name}</option>)}</select></label>
        <label>Test<select value={qcMaterialForm.testId} onChange={e => setQcMaterialForm({ ...qcMaterialForm, testId: e.target.value })}><option value="">—</option>{tests.map(t => <option key={t.id} value={t.id}>{t.test_name}</option>)}</select></label>
        <label>Lot number<input value={qcMaterialForm.lotNumber} onChange={e => setQcMaterialForm({ ...qcMaterialForm, lotNumber: e.target.value })} /></label>
        <label>Manufacturer<input value={qcMaterialForm.manufacturer} onChange={e => setQcMaterialForm({ ...qcMaterialForm, manufacturer: e.target.value })} /></label>
        <label>Expiry<input type="date" value={qcMaterialForm.expiryDate} onChange={e => setQcMaterialForm({ ...qcMaterialForm, expiryDate: e.target.value })} /></label>
        <label>Target<input type="number" step="any" value={qcMaterialForm.targetValue} onChange={e => setQcMaterialForm({ ...qcMaterialForm, targetValue: e.target.value })} /></label>
        <label>Acceptable low<input type="number" step="any" value={qcMaterialForm.acceptableLow} onChange={e => setQcMaterialForm({ ...qcMaterialForm, acceptableLow: e.target.value })} /></label>
        <label>Acceptable high<input type="number" step="any" value={qcMaterialForm.acceptableHigh} onChange={e => setQcMaterialForm({ ...qcMaterialForm, acceptableHigh: e.target.value })} /></label>
        <button type="submit">Add QC material</button>
      </form>
      <table className="data-table"><thead><tr><th>Material</th><th>Device</th><th>Test</th><th>Lot</th><th>Range</th></tr></thead><tbody>
        {qcMaterials.map(m => <tr key={m.id}><td>{m.material_name}</td><td>{m.device_name || '—'}</td><td>{m.test_name || '—'}</td><td>{m.lot_number || '—'}</td><td>{m.acceptable_low ?? '—'} – {m.acceptable_high ?? '—'}</td></tr>)}
      </tbody></table>

      <h3>QC results</h3>
      <form className="form-grid" onSubmit={submitQcResult}>
        <label>Date<input type="date" value={qcResultForm.qcDate} onChange={e => setQcResultForm({ ...qcResultForm, qcDate: e.target.value })} required /></label>
        <label>Time<input type="time" value={qcResultForm.qcTime} onChange={e => setQcResultForm({ ...qcResultForm, qcTime: e.target.value })} /></label>
        <label>Site<select value={qcResultForm.siteId} onChange={e => setQcResultForm({ ...qcResultForm, siteId: e.target.value })}><option value="">—</option>{sites.map(s => <option key={s.id} value={s.id}>{s.site_name}</option>)}</select></label>
        <label>Device<select value={qcResultForm.deviceId} onChange={e => setQcResultForm({ ...qcResultForm, deviceId: e.target.value })} required><option value="">—</option>{devices.map(d => <option key={d.id} value={d.id}>{d.device_name}</option>)}</select></label>
        <label>Test<select value={qcResultForm.testId} onChange={e => setQcResultForm({ ...qcResultForm, testId: e.target.value })} required><option value="">—</option>{tests.map(t => <option key={t.id} value={t.id}>{t.test_name}</option>)}</select></label>
        <label>QC material<select value={qcResultForm.qcMaterialId} onChange={e => setQcResultForm({ ...qcResultForm, qcMaterialId: e.target.value })}><option value="">—</option>{qcMaterials.map(m => <option key={m.id} value={m.id}>{m.material_name}</option>)}</select></label>
        <label>Reagent lot<select value={qcResultForm.reagentLotId} onChange={e => setQcResultForm({ ...qcResultForm, reagentLotId: e.target.value })}><option value="">—</option>{reagentLots.map(r => <option key={r.id} value={r.id}>{r.lot_number}</option>)}</select></label>
        <label>Result value<input type="number" step="any" value={qcResultForm.resultValue} onChange={e => setQcResultForm({ ...qcResultForm, resultValue: e.target.value })} required /></label>
        <label>Expected<input value={qcResultForm.expectedResult} onChange={e => setQcResultForm({ ...qcResultForm, expectedResult: e.target.value })} /></label>
        <label>Immediate action (required if failed)<textarea value={qcResultForm.immediateAction} onChange={e => setQcResultForm({ ...qcResultForm, immediateAction: e.target.value })} /></label>
        <button type="submit">Record QC result</button>
      </form>
      <table className="data-table"><thead><tr><th>Number</th><th>Date</th><th>Device</th><th>Test</th><th>Material</th><th>Value</th><th>Interp.</th><th>Status</th><th></th></tr></thead><tbody>
        {qcResults.map(r => <tr key={r.id}><td>{r.qc_number}</td><td>{r.qc_date}</td><td>{r.device_name || '—'}</td><td>{r.test_name || '—'}</td><td>{r.material_name || '—'}</td><td>{r.result_value ?? '—'}</td><td>{formatBadge(r.interpretation)}</td><td>{formatBadge(r.status)}</td>
          <td>{!r.reviewed_at && <button onClick={() => reviewQc(r.id)}>Review</button>}{!r.nc_id && (r.status === 'failed' || r.status === 'warning') && <button onClick={() => qcCreateNc(r.id)}>NC</button>}{!r.capa_id && (r.status === 'failed' || r.status === 'warning') && <button onClick={() => qcCreateCapa(r.id)}>CAPA</button>}</td>
        </tr>)}
      </tbody></table>

      <h3>QC trend</h3>
      <div className="form-grid">
        <label>Device<select value={trendFilter.deviceId} onChange={e => setTrendFilter({ ...trendFilter, deviceId: e.target.value })}><option value="">—</option>{devices.map(d => <option key={d.id} value={d.id}>{d.device_name}</option>)}</select></label>
        <label>Test<select value={trendFilter.testId} onChange={e => setTrendFilter({ ...trendFilter, testId: e.target.value })}><option value="">—</option>{tests.map(t => <option key={t.id} value={t.id}>{t.test_name}</option>)}</select></label>
        <label>QC material (optional)<select value={trendFilter.materialId} onChange={e => setTrendFilter({ ...trendFilter, materialId: e.target.value })}><option value="">—</option>{qcMaterials.map(m => <option key={m.id} value={m.id}>{m.material_name}</option>)}</select></label>
        <button type="button" onClick={loadTrend}>Load trend</button>
        {can('poct', 'print') && <button type="button" onClick={() => openPrintPage(`/poct/qc-report/print${trendFilter.deviceId ? `?deviceId=${trendFilter.deviceId}` : ''}`)}>Print QC report</button>}
      </div>
      {trendData && trendData.points && trendData.points.length > 0 && (() => {
        const points = trendData.points as Array<{ qc_date: string; result_value: number | null; status: string }>;
        const values = points.map(p => p.result_value).filter((v): v is number => v !== null && v !== undefined);
        const target = trendData.target as number | null;
        const low = trendData.acceptableLow as number | null;
        const high = trendData.acceptableHigh as number | null;
        const candidates = [...values, ...(target !== null ? [target] : []), ...(low !== null ? [low] : []), ...(high !== null ? [high] : [])];
        if (!candidates.length) return <p>No numeric data.</p>;
        const lo = Math.min(...candidates), hi = Math.max(...candidates);
        const span = (hi - lo) || 1;
        const yMin = lo - span * 0.1, yMax = hi + span * 0.1;
        const w = 720, h = 240, padL = 48, padR = 16, padT = 16, padB = 32;
        const innerW = w - padL - padR, innerH = h - padT - padB;
        const x = (i: number) => padL + (points.length === 1 ? innerW / 2 : (i * innerW) / (points.length - 1));
        const y = (v: number) => padT + innerH - ((v - yMin) / (yMax - yMin)) * innerH;
        const colorFor = (status: string) => status === 'accepted' ? 'var(--success, #2a9d4a)' : status === 'warning' ? 'var(--warning, #d99500)' : status === 'failed' ? 'var(--danger, #d23a2a)' : 'var(--muted, #888)';
        const linePath = points.map((p, i) => p.result_value === null || p.result_value === undefined ? '' : `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(p.result_value).toFixed(1)}`).filter(Boolean).join(' ');
        const refLine = (val: number, label: string, color: string) => <g key={label}><line x1={padL} x2={w - padR} y1={y(val)} y2={y(val)} stroke={color} strokeWidth={1} strokeDasharray="4 4" /><text x={padL - 6} y={y(val) + 4} fontSize={10} textAnchor="end" fill="var(--muted, #666)">{label}</text></g>;
        return <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label="POCT QC trend" style={{ width: '100%', maxWidth: w, height: 'auto', background: '#fff', border: '1px solid var(--border, #ddd)', borderRadius: 8 }}>
          {target !== null && refLine(target, `Target ${target}`, '#2a9d4a')}
          {low !== null && refLine(low, `Low ${low}`, '#d99500')}
          {high !== null && refLine(high, `High ${high}`, '#d99500')}
          <path d={linePath} fill="none" stroke="#1B3A6B" strokeWidth={1.5} />
          {points.map((p, i) => p.result_value === null || p.result_value === undefined ? null : <circle key={i} cx={x(i)} cy={y(p.result_value)} r={4} fill={colorFor(p.status)} stroke="#fff" strokeWidth={1}><title>{p.qc_date}: {p.result_value} ({p.status})</title></circle>)}
        </svg>;
      })()}
      {trendData && (!trendData.points || trendData.points.length === 0) && <p>No QC results for the selected filters.</p>}
    </>}

    {tab === 'EQA Monitoring' && <>
      <form className="form-grid" onSubmit={submitEqa}>
        <label>Site<select value={eqaForm.siteId} onChange={e => setEqaForm({ ...eqaForm, siteId: e.target.value })}><option value="">—</option>{sites.map(s => <option key={s.id} value={s.id}>{s.site_name}</option>)}</select></label>
        <label>Device<select value={eqaForm.deviceId} onChange={e => setEqaForm({ ...eqaForm, deviceId: e.target.value })}><option value="">—</option>{devices.map(d => <option key={d.id} value={d.id}>{d.device_name}</option>)}</select></label>
        <label>Test<select value={eqaForm.testId} onChange={e => setEqaForm({ ...eqaForm, testId: e.target.value })} required><option value="">—</option>{tests.map(t => <option key={t.id} value={t.id}>{t.test_name}</option>)}</select></label>
        <label>Cycle name<input value={eqaForm.cycleName} onChange={e => setEqaForm({ ...eqaForm, cycleName: e.target.value })} required /></label>
        <label>Received date<input type="date" value={eqaForm.receivedDate} onChange={e => setEqaForm({ ...eqaForm, receivedDate: e.target.value })} /></label>
        <label>Due date<input type="date" value={eqaForm.dueDate} onChange={e => setEqaForm({ ...eqaForm, dueDate: e.target.value })} /></label>
        <label>Submitted date<input type="date" value={eqaForm.submittedDate} onChange={e => setEqaForm({ ...eqaForm, submittedDate: e.target.value })} /></label>
        <label>Result received date<input type="date" value={eqaForm.resultReceivedDate} onChange={e => setEqaForm({ ...eqaForm, resultReceivedDate: e.target.value })} /></label>
        <label>Performance<select value={eqaForm.performanceStatus} onChange={e => setEqaForm({ ...eqaForm, performanceStatus: e.target.value })}>{EQA_PERFORMANCE_STATUSES.map(p => <option key={p} value={p}>{p}</option>)}</select></label>
        <label>Findings<textarea value={eqaForm.findings} onChange={e => setEqaForm({ ...eqaForm, findings: e.target.value })} /></label>
        <button type="submit">Record EQA event</button>
      </form>
      <table className="data-table"><thead><tr><th>Number</th><th>Cycle</th><th>Test</th><th>Due</th><th>Submitted</th><th>Performance</th><th>Status</th><th></th></tr></thead><tbody>
        {eqaEvents.map(e => <tr key={e.id}><td>{e.event_number}</td><td>{e.cycle_name}</td><td>{e.test_name || '—'}</td><td>{e.due_date || '—'}</td><td>{e.submitted_date || '—'}</td><td>{formatBadge(e.performance_status)}</td><td>{formatBadge(e.status)}</td>
          <td>{!e.nc_id && e.performance_status === 'unsatisfactory' && <button onClick={() => eqaCreateNc(e.id)}>NC</button>}{!e.capa_id && e.performance_status === 'unsatisfactory' && <button onClick={() => eqaCreateCapa(e.id)}>CAPA</button>}{e.status !== 'closed' && <button onClick={() => closeEqa(e.id)}>Close</button>}</td>
        </tr>)}
      </tbody></table>
    </>}

    {tab === 'Maintenance Logs' && <>
      <form className="form-grid" onSubmit={submitMaint}>
        <label>Device<select value={maintForm.deviceId} onChange={e => setMaintForm({ ...maintForm, deviceId: e.target.value })} required><option value="">—</option>{devices.map(d => <option key={d.id} value={d.id}>{d.device_name}</option>)}</select></label>
        <label>Date<input type="date" value={maintForm.maintenanceDate} onChange={e => setMaintForm({ ...maintForm, maintenanceDate: e.target.value })} required /></label>
        <label>Type<select value={maintForm.maintenanceType} onChange={e => setMaintForm({ ...maintForm, maintenanceType: e.target.value })}>{MAINTENANCE_TYPES.map(t => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}</select></label>
        <label>Description<textarea value={maintForm.description} onChange={e => setMaintForm({ ...maintForm, description: e.target.value })} required /></label>
        <label>Outcome<input value={maintForm.outcome} onChange={e => setMaintForm({ ...maintForm, outcome: e.target.value })} /></label>
        <label>Next due<input type="date" value={maintForm.nextDueDate} onChange={e => setMaintForm({ ...maintForm, nextDueDate: e.target.value })} /></label>
        <label>Performed by<select value={maintForm.performedByStaffId} onChange={e => setMaintForm({ ...maintForm, performedByStaffId: e.target.value })}><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
        <button type="submit">Log maintenance</button>
      </form>
      <table className="data-table"><thead><tr><th>Number</th><th>Device</th><th>Date</th><th>Type</th><th>Outcome</th><th>Next due</th><th>Status</th><th></th></tr></thead><tbody>
        {maintenance.map(m => <tr key={m.id}><td>{m.maintenance_number}</td><td>{m.device_name || '—'}</td><td>{m.maintenance_date}</td><td>{m.maintenance_type.replace(/_/g, ' ')}</td><td>{m.outcome || '—'}</td><td>{m.next_due_date || '—'}</td><td>{formatBadge(m.status)}</td><td>{m.status !== 'closed' && <button onClick={() => closeMaint(m.id)}>Close</button>}</td></tr>)}
      </tbody></table>
    </>}

    {tab === 'Incidents' && <>
      <form className="form-grid" onSubmit={submitIncident}>
        <label>Date<input type="date" value={incidentForm.incidentDate} onChange={e => setIncidentForm({ ...incidentForm, incidentDate: e.target.value })} required /></label>
        <label>Site<select value={incidentForm.siteId} onChange={e => setIncidentForm({ ...incidentForm, siteId: e.target.value })}><option value="">—</option>{sites.map(s => <option key={s.id} value={s.id}>{s.site_name}</option>)}</select></label>
        <label>Device<select value={incidentForm.deviceId} onChange={e => setIncidentForm({ ...incidentForm, deviceId: e.target.value })}><option value="">—</option>{devices.map(d => <option key={d.id} value={d.id}>{d.device_name}</option>)}</select></label>
        <label>Test<select value={incidentForm.testId} onChange={e => setIncidentForm({ ...incidentForm, testId: e.target.value })}><option value="">—</option>{tests.map(t => <option key={t.id} value={t.id}>{t.test_name}</option>)}</select></label>
        <label>Severity<select value={incidentForm.severity} onChange={e => setIncidentForm({ ...incidentForm, severity: e.target.value })}>{SEVERITIES.map(s => <option key={s} value={s}>{s}</option>)}</select></label>
        <label>Title<input value={incidentForm.title} onChange={e => setIncidentForm({ ...incidentForm, title: e.target.value })} required /></label>
        <label>Description<textarea value={incidentForm.description} onChange={e => setIncidentForm({ ...incidentForm, description: e.target.value })} required /></label>
        <label>Immediate action<textarea value={incidentForm.immediateAction} onChange={e => setIncidentForm({ ...incidentForm, immediateAction: e.target.value })} /></label>
        <label>Outcome<input value={incidentForm.outcome} onChange={e => setIncidentForm({ ...incidentForm, outcome: e.target.value })} /></label>
        <button type="submit">Log incident</button>
      </form>
      <table className="data-table"><thead><tr><th>Number</th><th>Date</th><th>Site</th><th>Device</th><th>Title</th><th>Severity</th><th>Status</th><th></th></tr></thead><tbody>
        {incidents.map(i => <tr key={i.id}><td>{i.incident_number}</td><td>{i.incident_date}</td><td>{i.site_name || '—'}</td><td>{i.device_name || '—'}</td><td>{i.title}</td><td>{formatBadge(i.severity)}</td><td>{formatBadge(i.status)}</td>
          <td><button onClick={() => incidentCreateAction(i.id)}>Action</button>{!i.nc_id && <button onClick={() => incidentCreateNc(i.id)}>NC</button>}{!i.capa_id && <button onClick={() => incidentCreateCapa(i.id)}>CAPA</button>}{i.status !== 'closed' && <button onClick={() => closeIncident(i.id)}>Close</button>}</td>
        </tr>)}
      </tbody></table>
    </>}

    {tab === 'Monthly Reviews' && <>
      <form className="form-grid" onSubmit={submitReview}>
        <label>Month<input type="number" min={1} max={12} value={reviewForm.reviewMonth} onChange={e => setReviewForm({ ...reviewForm, reviewMonth: Number(e.target.value) })} required /></label>
        <label>Year<input type="number" min={2000} value={reviewForm.reviewYear} onChange={e => setReviewForm({ ...reviewForm, reviewYear: Number(e.target.value) })} required /></label>
        <label>Site<select value={reviewForm.siteId} onChange={e => setReviewForm({ ...reviewForm, siteId: e.target.value })}><option value="">All sites</option>{sites.map(s => <option key={s.id} value={s.id}>{s.site_name}</option>)}</select></label>
        <label>Summary<textarea value={reviewForm.summary} onChange={e => setReviewForm({ ...reviewForm, summary: e.target.value })} /></label>
        <button type="submit">Create review</button>
      </form>
      <table className="data-table"><thead><tr><th>Number</th><th>Period</th><th>Site</th><th>Status</th><th>Summaries</th><th></th></tr></thead><tbody>
        {reviews.map(r => <tr key={r.id}><td>{r.review_number}</td><td>{r.review_year}-{String(r.review_month).padStart(2, '0')}</td><td>{r.site_name || 'all'}</td><td>{formatBadge(r.status)}</td>
          <td>{[r.qc_summary, r.eqa_summary, r.operator_authorization_summary, r.device_issue_summary, r.incidents_summary].filter(Boolean).join(' · ') || '—'}</td>
          <td><button onClick={() => generateReviewSummary(r.id)}>Generate summary</button>{r.status === 'draft' && <button onClick={() => reviewReview(r.id)}>Review</button>}{r.status === 'reviewed' && <button onClick={() => approveReview(r.id)}>Approve</button>}{r.status === 'approved' && <button onClick={() => closeReview(r.id)}>Close</button>} {can('poct', 'print') && <button onClick={() => openPrintPage(`/poct/monthly-reviews/${r.id}/print`)}>Print</button>}</td>
        </tr>)}
      </tbody></table>
    </>}

    {tab === 'Reports' && <>
      <h3>Printable reports</h3>
      <ul>
        <li>Site report: open Sites tab and click <em>Print site report</em> on the desired row. Includes devices, active authorisations, recent QC, and open incidents.</li>
        <li>Authorisation roster: open Sites tab and click <em>Print roster</em>.</li>
        {can('poct', 'print') && <li>QC report: <button type="button" onClick={() => openPrintPage('/poct/qc-report/print')}>Print QC report (current month, all sites)</button> — or use the Print QC report button inside QC Monitoring to scope by device.</li>}
        <li>Monthly review: open Monthly Reviews tab and click <em>Print</em>.</li>
      </ul>
      <h3>POCT actions (from incidents)</h3>
      <table className="data-table"><thead><tr><th>Title</th><th>Status</th><th>Priority</th><th>Assigned to</th><th>Due</th><th>Source record</th></tr></thead><tbody>
        {poctActions.map(a => <tr key={a.id}><td>{a.title}</td><td>{formatBadge(a.status)}</td><td>{a.priority}</td><td>{a.assigned_to_name || (a.assigned_to_staff_id ? `Staff #${a.assigned_to_staff_id}` : '—')}</td><td>{a.due_date || '—'}</td><td>{a.source_module && a.source_record_id ? `${a.source_module}#${a.source_record_id}` : '—'}</td></tr>)}
      </tbody></table>
      {poctActions.length === 0 && <p>No POCT-linked actions yet.</p>}
    </>}
  </div>;
}
