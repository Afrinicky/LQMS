import { FormEvent, useEffect, useState } from 'react';
import PageHeader from '../components/ui/PageHeader';
import { KpiStrip, ChartCard, DonutChart, BarMeter, CHART_COLORS, ModuleAlerts } from '../components/ui';
import { useModules } from '../hooks/useModules';
import { api, errorText, apiRead } from '../services/api';
import DisabledModule from '../components/DisabledModule';
import PermissionTabs from '../components/PermissionTabs';
import type {
  Section, Department, Staff,
  InformationAsset, InformationSystem, SystemAccessReview,
  InformationSecurityIncident, DataCorrectionRequest, SystemChangeRequest,
  SoftwareReleaseRecord, SystemValidationRecord, SystemDowntimeRecord,
  InformationManagementReview, InformationManagementSummary
} from '../../shared/types/api';
import TextField from '../components/ui/TextField';
import { Notice } from '../components/ui/Feedback';

const statusBadgeClass = (status?: string) => `badge ${status ? status.toLowerCase().replace(/\s+/g, '-') : 'unknown'}`;
const formatBadge = (status?: string) => <span className={statusBadgeClass(status)}>{status ? status.replace(/_/g, ' ') : 'Unknown'}</span>;
// Tabs are filtered by permission — a tab whose feature this user cannot
// view is not drawn. See src/components/PermissionTabs.tsx.
const TAB_MODULE = 'information_management';
const tabBar = (active: string, tabs: string[], onChange: (name: string) => void) =>
  <PermissionTabs moduleKey={TAB_MODULE} tabs={tabs} active={active} onChange={onChange} />;

const ASSET_TYPES = ['paper_register', 'electronic_file', 'database', 'spreadsheet', 'lhims_export', 'report', 'backup_drive', 'evidence_pack', 'shared_folder', 'other'];
const ASSET_STATUSES = ['active', 'inactive', 'under_review', 'archived'];
const SYSTEM_TYPES = ['sech_lims', 'lhims', 'analyzer', 'poct', 'backup_drive', 'shared_folder', 'cloud_service', 'other'];
const CONFIDENTIALITY_LEVELS = ['public', 'internal', 'restricted', 'confidential'];
const CRITICALITY_LEVELS = ['low', 'medium', 'high', 'critical'];
const SEVERITIES = ['low', 'medium', 'high', 'critical'];
const INCIDENT_TYPES = ['unauthorised_access', 'data_loss', 'data_disclosure', 'malware', 'phishing', 'lost_device', 'misconfiguration', 'other'];
const CHANGE_TYPES = ['configuration', 'upgrade', 'patch', 'integration', 'access_control', 'infrastructure', 'other'];
const VALIDATION_TYPES = ['installation', 'operational', 'performance', 'uat', 'verification', 'other'];
const DOWNTIME_TYPES = ['planned', 'unplanned', 'partial', 'full', 'maintenance', 'other'];

function useLookups() {
  const [staff, setStaff] = useState<Staff[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  useEffect(() => {
    api<Staff[]>('/staff').then(setStaff).catch(() => setStaff([]));
    api<Section[]>('/sections').then(setSections).catch(() => setSections([]));
    api<Department[]>('/departments').then(setDepartments).catch(() => setDepartments([]));
  }, []);
  return { staff, sections, departments };
}

function staffName(staffList: Staff[], id?: number | null) {
  if (!id) return '—';
  return staffList.find(s => s.id === id)?.fullName || `Staff #${id}`;
}

export function InformationManagementPage() {
  const { isEnabled } = useModules();
  const { staff, sections, departments } = useLookups();
  const [tab, setTab] = useState('Dashboard');
  const [error, setError] = useState<string | null>(null);

  const [summary, setSummary] = useState<InformationManagementSummary | null>(null);
  const [assets, setAssets] = useState<InformationAsset[]>([]);
  const [systems, setSystems] = useState<InformationSystem[]>([]);
  const [accessReviews, setAccessReviews] = useState<SystemAccessReview[]>([]);
  const [incidents, setIncidents] = useState<InformationSecurityIncident[]>([]);
  const [corrections, setCorrections] = useState<DataCorrectionRequest[]>([]);
  const [changeReqs, setChangeReqs] = useState<SystemChangeRequest[]>([]);
  const [releases, setReleases] = useState<SoftwareReleaseRecord[]>([]);
  const [validations, setValidations] = useState<SystemValidationRecord[]>([]);
  const [downtime, setDowntime] = useState<SystemDowntimeRecord[]>([]);
  const [reviews, setReviews] = useState<InformationManagementReview[]>([]);

  const [assetForm, setAssetForm] = useState({ assetCode: '', assetName: '', assetType: 'electronic_file', ownerStaffId: '', departmentId: '', sectionId: '', description: '', dataCategory: '', confidentialityLevel: 'internal', storageLocation: '', backupMethod: '', retentionRuleId: '', status: 'active' });
  const [systemForm, setSystemForm] = useState({ systemCode: '', systemName: '', systemType: 'sech_lims', vendorOrOwner: '', purpose: '', dataHandled: '', hostingLocation: '', accessMethod: '', backupResponsibility: '', supportContact: '', criticality: 'medium', status: 'active' });
  const [accessForm, setAccessForm] = useState({ systemId: '', reviewDate: '', reviewPeriodStart: '', reviewPeriodEnd: '', usersReviewed: '', accessIssuesFound: '', inactiveAccountsFound: '', excessiveAccessFound: '', actionsRequired: '' });
  const [incidentForm, setIncidentForm] = useState({ incidentDate: '', incidentType: 'unauthorised_access', systemId: '', assetId: '', title: '', description: '', immediateAction: '', severity: 'medium', confidentialityImpact: '', dataLossSuspected: false, investigationSummary: '' });
  const [correctionForm, setCorrectionForm] = useState({ requestDate: '', systemId: '', moduleKey: '', recordType: '', recordReference: '', correctionReason: '', originalValueSummary: '', requestedCorrectionSummary: '' });
  const [changeForm, setChangeForm] = useState({ requestDate: '', systemId: '', changeType: 'configuration', title: '', description: '', reason: '', riskLevel: 'medium', implementationDate: '', validationRequired: false, validationSummary: '', rollbackPlan: '' });
  const [releaseForm, setReleaseForm] = useState({ systemId: '', versionLabel: '', releaseDate: '', releaseSummary: '', changesIncluded: '', testingSummary: '', deploymentNotes: '', changeRequestId: '' });
  const [validationForm, setValidationForm] = useState({ systemId: '', validationDate: '', validationType: 'uat', scope: '', testSummary: '', deviationsFound: '', outcome: '', releaseId: '', changeRequestId: '' });
  const [downtimeForm, setDowntimeForm] = useState({ systemId: '', downtimeStart: '', downtimeEnd: '', downtimeType: 'unplanned', affectedServices: '', impactSummary: '', workaroundUsed: '' });
  const [reviewForm, setReviewForm] = useState({ reviewPeriodStart: '', reviewPeriodEnd: '', reviewDate: '' });
  const [expandedReviewId, setExpandedReviewId] = useState<number | null>(null);

  async function load() {
    try {
      const [sum, a, s, ar, inc, dc, cr, rel, val, dt, rv] = await Promise.all([
        api<InformationManagementSummary>('/dashboard/information-management-summary').catch(() => null),
        apiRead<InformationAsset[]>('/information-management/assets', []),
        apiRead<InformationSystem[]>('/information-management/systems', []),
        apiRead<SystemAccessReview[]>('/information-management/access-reviews', []),
        apiRead<InformationSecurityIncident[]>('/information-management/security-incidents', []),
        apiRead<DataCorrectionRequest[]>('/information-management/data-corrections', []),
        apiRead<SystemChangeRequest[]>('/information-management/change-requests', []),
        apiRead<SoftwareReleaseRecord[]>('/information-management/releases', []),
        apiRead<SystemValidationRecord[]>('/information-management/validations', []),
        apiRead<SystemDowntimeRecord[]>('/information-management/downtime', []),
        apiRead<InformationManagementReview[]>('/information-management/reviews', [])
      ]);
      if (sum) setSummary(sum);
      setAssets(a); setSystems(s); setAccessReviews(ar); setIncidents(inc); setCorrections(dc);
      setChangeReqs(cr); setReleases(rel); setValidations(val); setDowntime(dt); setReviews(rv);
    } catch (e) { setError(errorText(e)); }
  }
  useEffect(() => { if (isEnabled('information_management')) void load(); }, [isEnabled]);
  if (!isEnabled('information_management')) return <DisabledModule />;

  async function post(path: string, body: any) { return api(path, { method: 'POST', body: JSON.stringify(body) }); }

  async function submitAsset(e: FormEvent) { e.preventDefault(); setError(null); try { await post('/information-management/assets', assetForm); setAssetForm({ assetCode: '', assetName: '', assetType: 'electronic_file', ownerStaffId: '', departmentId: '', sectionId: '', description: '', dataCategory: '', confidentialityLevel: 'internal', storageLocation: '', backupMethod: '', retentionRuleId: '', status: 'active' }); await load(); } catch (e) { setError(errorText(e)); } }
  async function setAssetStatus(id: number, status: string) { try { await post(`/information-management/assets/${id}/status`, { status }); await load(); } catch (e) { setError(errorText(e)); } }
  async function submitSystem(e: FormEvent) { e.preventDefault(); setError(null); try { await post('/information-management/systems', systemForm); setSystemForm({ systemCode: '', systemName: '', systemType: 'sech_lims', vendorOrOwner: '', purpose: '', dataHandled: '', hostingLocation: '', accessMethod: '', backupResponsibility: '', supportContact: '', criticality: 'medium', status: 'active' }); await load(); } catch (e) { setError(errorText(e)); } }
  async function setSystemStatus(id: number, status: string) { try { await post(`/information-management/systems/${id}/status`, { status }); await load(); } catch (e) { setError(errorText(e)); } }
  async function submitAccess(e: FormEvent) { e.preventDefault(); setError(null); try { await post('/information-management/access-reviews', accessForm); setAccessForm({ systemId: '', reviewDate: '', reviewPeriodStart: '', reviewPeriodEnd: '', usersReviewed: '', accessIssuesFound: '', inactiveAccountsFound: '', excessiveAccessFound: '', actionsRequired: '' }); await load(); } catch (e) { setError(errorText(e)); } }
  async function generateAccessItems(id: number) { try { await post(`/information-management/access-reviews/${id}/generate-items`, {}); await load(); } catch (e) { setError(errorText(e)); } }
  async function accessCreateAction(id: number) { const title = prompt('Action title?'); if (!title) return; try { await post(`/information-management/access-reviews/${id}/create-action`, { title }); await load(); } catch (e) { setError(errorText(e)); } }
  async function closeAccess(id: number) { try { await post(`/information-management/access-reviews/${id}/close`, {}); await load(); } catch (e) { setError(errorText(e)); } }
  async function submitIncident(e: FormEvent) { e.preventDefault(); setError(null); try { await post('/information-management/security-incidents', incidentForm); setIncidentForm({ incidentDate: '', incidentType: 'unauthorised_access', systemId: '', assetId: '', title: '', description: '', immediateAction: '', severity: 'medium', confidentialityImpact: '', dataLossSuspected: false, investigationSummary: '' }); await load(); } catch (e) { setError(errorText(e)); } }
  async function incidentCreateAction(id: number) { const title = prompt('Action title?'); if (!title) return; try { await post(`/information-management/security-incidents/${id}/create-action`, { title }); await load(); } catch (e) { setError(errorText(e)); } }
  async function incidentCreateNc(id: number) { try { await post(`/information-management/security-incidents/${id}/create-nc`, {}); await load(); } catch (e) { setError(errorText(e)); } }
  async function incidentCreateCapa(id: number) { try { await post(`/information-management/security-incidents/${id}/create-capa`, {}); await load(); } catch (e) { setError(errorText(e)); } }
  async function closeIncident(id: number) { try { await post(`/information-management/security-incidents/${id}/close`, {}); await load(); } catch (e) { setError(errorText(e)); } }
  async function submitCorrection(e: FormEvent) { e.preventDefault(); setError(null); try { await post('/information-management/data-corrections', correctionForm); setCorrectionForm({ requestDate: '', systemId: '', moduleKey: '', recordType: '', recordReference: '', correctionReason: '', originalValueSummary: '', requestedCorrectionSummary: '' }); await load(); } catch (e) { setError(errorText(e)); } }
  async function reviewCorrection(id: number) { try { await post(`/information-management/data-corrections/${id}/review`, {}); await load(); } catch (e) { setError(errorText(e)); } }
  async function approveCorrection(id: number) { try { await post(`/information-management/data-corrections/${id}/approve`, {}); await load(); } catch (e) { setError(errorText(e)); } }
  async function completeCorrection(id: number) { try { await post(`/information-management/data-corrections/${id}/complete`, {}); await load(); } catch (e) { setError(errorText(e)); } }
  async function correctionCreateAction(id: number) { const title = prompt('Action title?'); if (!title) return; try { await post(`/information-management/data-corrections/${id}/create-action`, { title }); await load(); } catch (e) { setError(errorText(e)); } }
  async function closeCorrection(id: number) { try { await post(`/information-management/data-corrections/${id}/close`, {}); await load(); } catch (e) { setError(errorText(e)); } }
  async function submitChange(e: FormEvent) { e.preventDefault(); setError(null); try { await post('/information-management/change-requests', changeForm); setChangeForm({ requestDate: '', systemId: '', changeType: 'configuration', title: '', description: '', reason: '', riskLevel: 'medium', implementationDate: '', validationRequired: false, validationSummary: '', rollbackPlan: '' }); await load(); } catch (e) { setError(errorText(e)); } }
  async function reviewChange(id: number) { try { await post(`/information-management/change-requests/${id}/review`, {}); await load(); } catch (e) { setError(errorText(e)); } }
  async function approveChange(id: number) { try { await post(`/information-management/change-requests/${id}/approve`, {}); await load(); } catch (e) { setError(errorText(e)); } }
  async function implementChange(id: number) { try { await post(`/information-management/change-requests/${id}/implement`, {}); await load(); } catch (e) { setError(errorText(e)); } }
  async function validateChange(id: number) { const summary = prompt('Validation summary?') || ''; try { await post(`/information-management/change-requests/${id}/validate`, { validationSummary: summary }); await load(); } catch (e) { setError(errorText(e)); } }
  async function changeCreateAction(id: number) { const title = prompt('Action title?'); if (!title) return; try { await post(`/information-management/change-requests/${id}/create-action`, { title }); await load(); } catch (e) { setError(errorText(e)); } }
  async function closeChange(id: number) { try { await post(`/information-management/change-requests/${id}/close`, {}); await load(); } catch (e) { setError(errorText(e)); } }
  async function submitRelease(e: FormEvent) { e.preventDefault(); setError(null); try { await post('/information-management/releases', releaseForm); setReleaseForm({ systemId: '', versionLabel: '', releaseDate: '', releaseSummary: '', changesIncluded: '', testingSummary: '', deploymentNotes: '', changeRequestId: '' }); await load(); } catch (e) { setError(errorText(e)); } }
  async function approveRelease(id: number) { try { await post(`/information-management/releases/${id}/approve`, {}); await load(); } catch (e) { setError(errorText(e)); } }
  async function deployRelease(id: number) { const notes = prompt('Deployment notes?') || ''; try { await post(`/information-management/releases/${id}/deploy`, { deploymentNotes: notes }); await load(); } catch (e) { setError(errorText(e)); } }
  async function archiveRelease(id: number) { try { await post(`/information-management/releases/${id}/archive`, {}); await load(); } catch (e) { setError(errorText(e)); } }
  async function submitValidation(e: FormEvent) { e.preventDefault(); setError(null); try { await post('/information-management/validations', validationForm); setValidationForm({ systemId: '', validationDate: '', validationType: 'uat', scope: '', testSummary: '', deviationsFound: '', outcome: '', releaseId: '', changeRequestId: '' }); await load(); } catch (e) { setError(errorText(e)); } }
  async function approveValidation(id: number) { try { await post(`/information-management/validations/${id}/approve`, {}); await load(); } catch (e) { setError(errorText(e)); } }
  async function closeValidation(id: number) { try { await post(`/information-management/validations/${id}/close`, {}); await load(); } catch (e) { setError(errorText(e)); } }
  async function submitDowntime(e: FormEvent) { e.preventDefault(); setError(null); try { await post('/information-management/downtime', downtimeForm); setDowntimeForm({ systemId: '', downtimeStart: '', downtimeEnd: '', downtimeType: 'unplanned', affectedServices: '', impactSummary: '', workaroundUsed: '' }); await load(); } catch (e) { setError(errorText(e)); } }
  async function downtimeCreateAction(id: number) { const title = prompt('Action title?'); if (!title) return; try { await post(`/information-management/downtime/${id}/create-action`, { title }); await load(); } catch (e) { setError(errorText(e)); } }
  async function downtimeCreateNc(id: number) { try { await post(`/information-management/downtime/${id}/create-nc`, {}); await load(); } catch (e) { setError(errorText(e)); } }
  async function resolveDowntime(id: number) { try { await post(`/information-management/downtime/${id}/resolve`, {}); await load(); } catch (e) { setError(errorText(e)); } }
  async function closeDowntime(id: number) { try { await post(`/information-management/downtime/${id}/close`, {}); await load(); } catch (e) { setError(errorText(e)); } }
  async function submitReview(e: FormEvent) { e.preventDefault(); setError(null); try { await post('/information-management/reviews', reviewForm); setReviewForm({ reviewPeriodStart: '', reviewPeriodEnd: '', reviewDate: '' }); await load(); } catch (e) { setError(errorText(e)); } }
  async function generateReviewSummary(id: number) { try { await post(`/information-management/reviews/${id}/generate-summary`, {}); await load(); } catch (e) { setError(errorText(e)); } }
  async function approveReview(id: number) { try { await post(`/information-management/reviews/${id}/approve`, {}); await load(); } catch (e) { setError(errorText(e)); } }
  async function closeReview(id: number) { try { await post(`/information-management/reviews/${id}/close`, {}); await load(); } catch (e) { setError(errorText(e)); } }

  const tabs = ['Dashboard', 'Information Assets', 'Information Systems', 'Access Reviews', 'Security Incidents', 'Data Corrections', 'Change Requests', 'Software Releases', 'System Validations', 'Downtime Records', 'Information Reviews', 'Reports'];

  return <div className="module-page">
    <PageHeader eyebrow="Information Management" title="Information Management" subtitle="Information assets, systems, access reviews, and changes." />
    <p className="muted">QMS oversight of laboratory information assets and systems. SECH_LIMS does not replace LHIMS/Lightwave for patient registration, test requests, result entry, verification, dispatch, or reporting.</p>
    {tabBar(tab, tabs, setTab)}
    {error && <Notice kind="error">{error}</Notice>}

    {tab === 'Dashboard' && <ModuleAlerts moduleKey="information_management" />}
    {tab === 'Dashboard' && (summary ? <KpiStrip items={[
      { label: 'Information assets', value: summary.activeInformationAssets, onClick: () => setTab('Information Assets') },
      { label: 'Active systems', value: summary.activeSystems, onClick: () => setTab('Information Systems') },
      { label: 'Open access reviews', value: summary.openAccessReviews, onClick: () => setTab('Access Reviews') },
      { label: 'Security incidents', value: summary.openSecurityIncidents, tone: 'danger', onClick: () => setTab('Security Incidents') },
      { label: 'Data corrections', value: summary.pendingDataCorrections, onClick: () => setTab('Data Corrections') },
      { label: 'Change requests', value: summary.openChangeRequests, onClick: () => setTab('Change Requests') },
      { label: 'Downtime (month)', value: summary.downtimeRecordsThisMonth, onClick: () => setTab('Downtime Records') },
      { label: 'Pending reviews', value: summary.pendingInformationReviews, onClick: () => setTab('Information Reviews') },
    ]} /> : <p>Loading summary…</p>)}
    {tab === 'Dashboard' && summary && <div className="grid cols-2" style={{ marginTop: 18 }}>
      <ChartCard title="Information estate" subtitle="Managed assets and systems">
        <DonutChart centerLabel="Assets" data={[
          { label: 'Information assets', value: summary.activeInformationAssets, color: CHART_COLORS[0] },
          { label: 'Active systems', value: summary.activeSystems, color: CHART_COLORS[5] },
        ]} />
      </ChartCard>
      <ChartCard title="Open governance items" subtitle="Reviews, incidents and changes to action">
        <BarMeter data={[
          { label: 'Access reviews', value: summary.openAccessReviews, color: CHART_COLORS[0] },
          { label: 'Security incidents', value: summary.openSecurityIncidents, color: CHART_COLORS[3] },
          { label: 'Data corrections', value: summary.pendingDataCorrections, color: CHART_COLORS[2] },
          { label: 'Change requests', value: summary.openChangeRequests, color: CHART_COLORS[4] },
          { label: 'Validations pending', value: summary.validationsPendingApproval, color: CHART_COLORS[5] },
        ]} />
      </ChartCard>
    </div>}

    {tab === 'Information Assets' && <>
      <form className="form-grid" onSubmit={submitAsset}>
        <label>Code<TextField value={assetForm.assetCode} onValue={nextValue => setAssetForm({ ...assetForm, assetCode: nextValue })} /></label>
        <label>Name<TextField value={assetForm.assetName} onValue={nextValue => setAssetForm({ ...assetForm, assetName: nextValue })} required /></label>
        <label>Type<select value={assetForm.assetType} onChange={e => setAssetForm({ ...assetForm, assetType: e.target.value })}>{ASSET_TYPES.map(t => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}</select></label>
        <label>Owner<select value={assetForm.ownerStaffId} onChange={e => setAssetForm({ ...assetForm, ownerStaffId: e.target.value })}><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
        <label>Department<select value={assetForm.departmentId} onChange={e => setAssetForm({ ...assetForm, departmentId: e.target.value })}><option value="">—</option>{departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
        <label>Section<select value={assetForm.sectionId} onChange={e => setAssetForm({ ...assetForm, sectionId: e.target.value })}><option value="">—</option>{sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label>Data category<TextField value={assetForm.dataCategory} onValue={nextValue => setAssetForm({ ...assetForm, dataCategory: nextValue })} placeholder="e.g. QMS, results, samples" /></label>
        <label>Confidentiality<select value={assetForm.confidentialityLevel} onChange={e => setAssetForm({ ...assetForm, confidentialityLevel: e.target.value })}>{CONFIDENTIALITY_LEVELS.map(c => <option key={c} value={c}>{c}</option>)}</select></label>
        <label>Storage location<TextField value={assetForm.storageLocation} onValue={nextValue => setAssetForm({ ...assetForm, storageLocation: nextValue })} /></label>
        <label>Backup method<TextField value={assetForm.backupMethod} onValue={nextValue => setAssetForm({ ...assetForm, backupMethod: nextValue })} /></label>
        <label>Retention rule id<input type="number" value={assetForm.retentionRuleId} onChange={e => setAssetForm({ ...assetForm, retentionRuleId: e.target.value })} /></label>
        <label>Description<TextField as="textarea" value={assetForm.description} onValue={nextValue => setAssetForm({ ...assetForm, description: nextValue })} /></label>
        <button type="submit">Register asset</button>
      </form>
      <table className="data-table"><thead><tr><th>Code</th><th>Name</th><th>Type</th><th>Owner</th><th>Confidentiality</th><th>Storage</th><th>Backup</th><th>Status</th><th></th></tr></thead><tbody>
        {assets.map(a => <tr key={a.id}><td>{a.asset_code || '—'}</td><td>{a.asset_name}</td><td>{a.asset_type.replace(/_/g, ' ')}</td><td>{staffName(staff, a.owner_staff_id)}</td><td>{a.confidentiality_level || '—'}</td><td>{a.storage_location || '—'}</td><td>{a.backup_method || '—'}</td><td>{formatBadge(a.status)}</td>
          <td>{ASSET_STATUSES.filter(s => s !== a.status).slice(0, 2).map(s => <button key={s} onClick={() => setAssetStatus(a.id, s)}>{s}</button>)}</td>
        </tr>)}
      </tbody></table>
    </>}

    {tab === 'Information Systems' && <>
      <form className="form-grid" onSubmit={submitSystem}>
        <label>Code<TextField value={systemForm.systemCode} onValue={nextValue => setSystemForm({ ...systemForm, systemCode: nextValue })} /></label>
        <label>Name<TextField value={systemForm.systemName} onValue={nextValue => setSystemForm({ ...systemForm, systemName: nextValue })} required /></label>
        <label>Type<select value={systemForm.systemType} onChange={e => setSystemForm({ ...systemForm, systemType: e.target.value })}>{SYSTEM_TYPES.map(t => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}</select></label>
        <label>Vendor/owner<TextField value={systemForm.vendorOrOwner} onValue={nextValue => setSystemForm({ ...systemForm, vendorOrOwner: nextValue })} /></label>
        <label>Purpose<TextField value={systemForm.purpose} onValue={nextValue => setSystemForm({ ...systemForm, purpose: nextValue })} /></label>
        <label>Data handled<TextField value={systemForm.dataHandled} onValue={nextValue => setSystemForm({ ...systemForm, dataHandled: nextValue })} /></label>
        <label>Hosting location<TextField value={systemForm.hostingLocation} onValue={nextValue => setSystemForm({ ...systemForm, hostingLocation: nextValue })} /></label>
        <label>Access method<TextField value={systemForm.accessMethod} onValue={nextValue => setSystemForm({ ...systemForm, accessMethod: nextValue })} placeholder="e.g. LAN desktop, browser" /></label>
        <label>Backup responsibility<TextField value={systemForm.backupResponsibility} onValue={nextValue => setSystemForm({ ...systemForm, backupResponsibility: nextValue })} /></label>
        <label>Support contact<TextField value={systemForm.supportContact} onValue={nextValue => setSystemForm({ ...systemForm, supportContact: nextValue })} /></label>
        <label>Criticality<select value={systemForm.criticality} onChange={e => setSystemForm({ ...systemForm, criticality: e.target.value })}>{CRITICALITY_LEVELS.map(c => <option key={c} value={c}>{c}</option>)}</select></label>
        <button type="submit">Register system</button>
      </form>
      <table className="data-table"><thead><tr><th>Code</th><th>Name</th><th>Type</th><th>Purpose</th><th>Criticality</th><th>Support</th><th>Status</th><th></th></tr></thead><tbody>
        {systems.map(s => <tr key={s.id}><td>{s.system_code || '—'}</td><td>{s.system_name}</td><td>{s.system_type.replace(/_/g, ' ')}</td><td>{s.purpose || '—'}</td><td>{s.criticality || '—'}</td><td>{s.support_contact || '—'}</td><td>{formatBadge(s.status)}</td>
          <td>{['active', 'inactive', 'under_review', 'archived'].filter(st => st !== s.status).slice(0, 2).map(st => <button key={st} onClick={() => setSystemStatus(s.id, st)}>{st.replace(/_/g, ' ')}</button>)}</td>
        </tr>)}
      </tbody></table>
    </>}

    {tab === 'Access Reviews' && <>
      <form className="form-grid" onSubmit={submitAccess}>
        <label>System<select value={accessForm.systemId} onChange={e => setAccessForm({ ...accessForm, systemId: e.target.value })} required><option value="">—</option>{systems.map(s => <option key={s.id} value={s.id}>{s.system_name}</option>)}</select></label>
        <label>Review date<input type="date" value={accessForm.reviewDate} onChange={e => setAccessForm({ ...accessForm, reviewDate: e.target.value })} required /></label>
        <label>Period start<input type="date" value={accessForm.reviewPeriodStart} onChange={e => setAccessForm({ ...accessForm, reviewPeriodStart: e.target.value })} /></label>
        <label>Period end<input type="date" value={accessForm.reviewPeriodEnd} onChange={e => setAccessForm({ ...accessForm, reviewPeriodEnd: e.target.value })} /></label>
        <label>Users reviewed<input type="number" value={accessForm.usersReviewed} onChange={e => setAccessForm({ ...accessForm, usersReviewed: e.target.value })} /></label>
        <label>Access issues<input type="number" value={accessForm.accessIssuesFound} onChange={e => setAccessForm({ ...accessForm, accessIssuesFound: e.target.value })} /></label>
        <label>Inactive accounts<input type="number" value={accessForm.inactiveAccountsFound} onChange={e => setAccessForm({ ...accessForm, inactiveAccountsFound: e.target.value })} /></label>
        <label>Excessive access<input type="number" value={accessForm.excessiveAccessFound} onChange={e => setAccessForm({ ...accessForm, excessiveAccessFound: e.target.value })} /></label>
        <label>Actions required<TextField as="textarea" value={accessForm.actionsRequired} onValue={nextValue => setAccessForm({ ...accessForm, actionsRequired: nextValue })} /></label>
        <button type="submit">Open access review</button>
      </form>
      <table className="data-table"><thead><tr><th>Number</th><th>System</th><th>Review date</th><th>Users</th><th>Issues</th><th>Status</th><th></th></tr></thead><tbody>
        {accessReviews.map(r => <tr key={r.id}><td>{r.review_number}</td><td>{systems.find(s => s.id === r.system_id)?.system_name || '—'}</td><td>{r.review_date}</td><td>{r.users_reviewed}</td><td>{r.access_issues_found}</td><td>{formatBadge(r.status)}</td>
          <td><button onClick={() => generateAccessItems(r.id)}>Generate items</button> <button onClick={() => accessCreateAction(r.id)}>Action</button> {r.status !== 'closed' && <button onClick={() => closeAccess(r.id)}>Close</button>}</td>
        </tr>)}
      </tbody></table>
    </>}

    {tab === 'Security Incidents' && <>
      <form className="form-grid" onSubmit={submitIncident}>
        <label>Date<input type="date" value={incidentForm.incidentDate} onChange={e => setIncidentForm({ ...incidentForm, incidentDate: e.target.value })} required /></label>
        <label>Type<select value={incidentForm.incidentType} onChange={e => setIncidentForm({ ...incidentForm, incidentType: e.target.value })}>{INCIDENT_TYPES.map(t => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}</select></label>
        <label>System<select value={incidentForm.systemId} onChange={e => setIncidentForm({ ...incidentForm, systemId: e.target.value })}><option value="">—</option>{systems.map(s => <option key={s.id} value={s.id}>{s.system_name}</option>)}</select></label>
        <label>Asset<select value={incidentForm.assetId} onChange={e => setIncidentForm({ ...incidentForm, assetId: e.target.value })}><option value="">—</option>{assets.map(a => <option key={a.id} value={a.id}>{a.asset_name}</option>)}</select></label>
        <label>Severity<select value={incidentForm.severity} onChange={e => setIncidentForm({ ...incidentForm, severity: e.target.value })}>{SEVERITIES.map(s => <option key={s} value={s}>{s}</option>)}</select></label>
        <label>Confidentiality impact<TextField value={incidentForm.confidentialityImpact} onValue={nextValue => setIncidentForm({ ...incidentForm, confidentialityImpact: nextValue })} /></label>
        <label>Title<TextField value={incidentForm.title} onValue={nextValue => setIncidentForm({ ...incidentForm, title: nextValue })} required /></label>
        <label>Description<TextField as="textarea" value={incidentForm.description} onValue={nextValue => setIncidentForm({ ...incidentForm, description: nextValue })} required /></label>
        <label>Immediate action<TextField as="textarea" value={incidentForm.immediateAction} onValue={nextValue => setIncidentForm({ ...incidentForm, immediateAction: nextValue })} /></label>
        <label>Investigation summary<TextField as="textarea" value={incidentForm.investigationSummary} onValue={nextValue => setIncidentForm({ ...incidentForm, investigationSummary: nextValue })} /></label>
        <label><input type="checkbox" checked={incidentForm.dataLossSuspected} onChange={e => setIncidentForm({ ...incidentForm, dataLossSuspected: e.target.checked })} /> Data loss suspected</label>
        <button type="submit">Log incident</button>
      </form>
      <table className="data-table"><thead><tr><th>Number</th><th>Date</th><th>Type</th><th>System</th><th>Title</th><th>Severity</th><th>Data loss?</th><th>Status</th><th></th></tr></thead><tbody>
        {incidents.map(i => <tr key={i.id}><td>{i.incident_number}</td><td>{i.incident_date}</td><td>{i.incident_type.replace(/_/g, ' ')}</td><td>{systems.find(s => s.id === i.system_id)?.system_name || '—'}</td><td>{i.title}</td><td>{formatBadge(i.severity)}</td><td>{i.data_loss_suspected ? 'Yes' : 'No'}</td><td>{formatBadge(i.status)}</td>
          <td><button onClick={() => incidentCreateAction(i.id)}>Action</button>{!i.linked_nc_id && <button onClick={() => incidentCreateNc(i.id)}>NC</button>}{!i.linked_capa_id && <button onClick={() => incidentCreateCapa(i.id)}>CAPA</button>}{i.status !== 'closed' && <button onClick={() => closeIncident(i.id)}>Close</button>}</td>
        </tr>)}
      </tbody></table>
    </>}

    {tab === 'Data Corrections' && <>
      <p className="muted">Records a request for correction. Does not directly edit patient/clinical data in LHIMS/Lightwave.</p>
      <form className="form-grid" onSubmit={submitCorrection}>
        <label>Request date<input type="date" value={correctionForm.requestDate} onChange={e => setCorrectionForm({ ...correctionForm, requestDate: e.target.value })} required /></label>
        <label>System<select value={correctionForm.systemId} onChange={e => setCorrectionForm({ ...correctionForm, systemId: e.target.value })}><option value="">—</option>{systems.map(s => <option key={s.id} value={s.id}>{s.system_name}</option>)}</select></label>
        <label>Module key<TextField value={correctionForm.moduleKey} onValue={nextValue => setCorrectionForm({ ...correctionForm, moduleKey: nextValue })} placeholder="e.g. nc_capa, blood_bank_handover" /></label>
        <label>Record type<TextField value={correctionForm.recordType} onValue={nextValue => setCorrectionForm({ ...correctionForm, recordType: nextValue })} /></label>
        <label>Record reference<TextField value={correctionForm.recordReference} onValue={nextValue => setCorrectionForm({ ...correctionForm, recordReference: nextValue })} placeholder="Record number / reference only" /></label>
        <label>Correction reason<TextField as="textarea" value={correctionForm.correctionReason} onValue={nextValue => setCorrectionForm({ ...correctionForm, correctionReason: nextValue })} required /></label>
        <label>Original value summary<TextField as="textarea" value={correctionForm.originalValueSummary} onValue={nextValue => setCorrectionForm({ ...correctionForm, originalValueSummary: nextValue })} /></label>
        <label>Requested correction summary<TextField as="textarea" value={correctionForm.requestedCorrectionSummary} onValue={nextValue => setCorrectionForm({ ...correctionForm, requestedCorrectionSummary: nextValue })} required /></label>
        <button type="submit">Submit request</button>
      </form>
      <table className="data-table"><thead><tr><th>Number</th><th>Date</th><th>System</th><th>Record ref</th><th>Reason</th><th>Status</th><th></th></tr></thead><tbody>
        {corrections.map(c => <tr key={c.id}><td>{c.request_number}</td><td>{c.request_date}</td><td>{systems.find(s => s.id === c.system_id)?.system_name || '—'}</td><td>{c.record_reference || '—'}</td><td>{c.correction_reason}</td><td>{formatBadge(c.status)}</td>
          <td>{c.status === 'submitted' && <button onClick={() => reviewCorrection(c.id)}>Review</button>}{c.status === 'reviewed' && <button onClick={() => approveCorrection(c.id)}>Approve</button>}{c.status === 'approved' && <button onClick={() => completeCorrection(c.id)}>Complete</button>} <button onClick={() => correctionCreateAction(c.id)}>Action</button> {c.status !== 'closed' && <button onClick={() => closeCorrection(c.id)}>Close</button>}</td>
        </tr>)}
      </tbody></table>
    </>}

    {tab === 'Change Requests' && <>
      <form className="form-grid" onSubmit={submitChange}>
        <label>Date<input type="date" value={changeForm.requestDate} onChange={e => setChangeForm({ ...changeForm, requestDate: e.target.value })} required /></label>
        <label>System<select value={changeForm.systemId} onChange={e => setChangeForm({ ...changeForm, systemId: e.target.value })}><option value="">—</option>{systems.map(s => <option key={s.id} value={s.id}>{s.system_name}</option>)}</select></label>
        <label>Change type<select value={changeForm.changeType} onChange={e => setChangeForm({ ...changeForm, changeType: e.target.value })}>{CHANGE_TYPES.map(t => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}</select></label>
        <label>Risk level<select value={changeForm.riskLevel} onChange={e => setChangeForm({ ...changeForm, riskLevel: e.target.value })}>{CRITICALITY_LEVELS.map(l => <option key={l} value={l}>{l}</option>)}</select></label>
        <label>Implementation date<input type="date" value={changeForm.implementationDate} onChange={e => setChangeForm({ ...changeForm, implementationDate: e.target.value })} /></label>
        <label>Title<TextField value={changeForm.title} onValue={nextValue => setChangeForm({ ...changeForm, title: nextValue })} required /></label>
        <label>Description<TextField as="textarea" value={changeForm.description} onValue={nextValue => setChangeForm({ ...changeForm, description: nextValue })} required /></label>
        <label>Reason<TextField as="textarea" value={changeForm.reason} onValue={nextValue => setChangeForm({ ...changeForm, reason: nextValue })} required /></label>
        <label>Rollback plan<TextField as="textarea" value={changeForm.rollbackPlan} onValue={nextValue => setChangeForm({ ...changeForm, rollbackPlan: nextValue })} /></label>
        <label>Validation summary<TextField as="textarea" value={changeForm.validationSummary} onValue={nextValue => setChangeForm({ ...changeForm, validationSummary: nextValue })} /></label>
        <label><input type="checkbox" checked={changeForm.validationRequired} onChange={e => setChangeForm({ ...changeForm, validationRequired: e.target.checked })} /> Validation required</label>
        <button type="submit">Log change request</button>
      </form>
      <table className="data-table"><thead><tr><th>Number</th><th>Date</th><th>System</th><th>Type</th><th>Title</th><th>Risk</th><th>Status</th><th></th></tr></thead><tbody>
        {changeReqs.map(c => <tr key={c.id}><td>{c.change_number}</td><td>{c.request_date}</td><td>{systems.find(s => s.id === c.system_id)?.system_name || '—'}</td><td>{c.change_type.replace(/_/g, ' ')}</td><td>{c.title}</td><td>{c.risk_level || '—'}</td><td>{formatBadge(c.status)}</td>
          <td>{c.status === 'submitted' && <button onClick={() => reviewChange(c.id)}>Review</button>}{c.status === 'reviewed' && <button onClick={() => approveChange(c.id)}>Approve</button>}{c.status === 'approved' && <button onClick={() => implementChange(c.id)}>Implement</button>}{c.status === 'implemented' && <button onClick={() => validateChange(c.id)}>Validate</button>} <button onClick={() => changeCreateAction(c.id)}>Action</button> {c.status !== 'closed' && <button onClick={() => closeChange(c.id)}>Close</button>}</td>
        </tr>)}
      </tbody></table>
    </>}

    {tab === 'Software Releases' && <>
      <form className="form-grid" onSubmit={submitRelease}>
        <label>System<select value={releaseForm.systemId} onChange={e => setReleaseForm({ ...releaseForm, systemId: e.target.value })} required><option value="">—</option>{systems.map(s => <option key={s.id} value={s.id}>{s.system_name}</option>)}</select></label>
        <label>Version label<TextField value={releaseForm.versionLabel} onValue={nextValue => setReleaseForm({ ...releaseForm, versionLabel: nextValue })} required /></label>
        <label>Release date<input type="date" value={releaseForm.releaseDate} onChange={e => setReleaseForm({ ...releaseForm, releaseDate: e.target.value })} required /></label>
        <label>Change request id<input type="number" value={releaseForm.changeRequestId} onChange={e => setReleaseForm({ ...releaseForm, changeRequestId: e.target.value })} /></label>
        <label>Release summary<TextField as="textarea" value={releaseForm.releaseSummary} onValue={nextValue => setReleaseForm({ ...releaseForm, releaseSummary: nextValue })} /></label>
        <label>Changes included<TextField as="textarea" value={releaseForm.changesIncluded} onValue={nextValue => setReleaseForm({ ...releaseForm, changesIncluded: nextValue })} /></label>
        <label>Testing summary<TextField as="textarea" value={releaseForm.testingSummary} onValue={nextValue => setReleaseForm({ ...releaseForm, testingSummary: nextValue })} /></label>
        <label>Deployment notes<TextField as="textarea" value={releaseForm.deploymentNotes} onValue={nextValue => setReleaseForm({ ...releaseForm, deploymentNotes: nextValue })} /></label>
        <button type="submit">Record release</button>
      </form>
      <table className="data-table"><thead><tr><th>Number</th><th>System</th><th>Version</th><th>Date</th><th>Status</th><th></th></tr></thead><tbody>
        {releases.map(r => <tr key={r.id}><td>{r.release_number}</td><td>{systems.find(s => s.id === r.system_id)?.system_name || '—'}</td><td>{r.version_label}</td><td>{r.release_date}</td><td>{formatBadge(r.status)}</td>
          <td>{r.status !== 'approved' && r.status !== 'deployed' && r.status !== 'archived' && <button onClick={() => approveRelease(r.id)}>Approve</button>}{r.status === 'approved' && <button onClick={() => deployRelease(r.id)}>Deploy</button>}{r.status !== 'archived' && <button onClick={() => archiveRelease(r.id)}>Archive</button>}</td>
        </tr>)}
      </tbody></table>
    </>}

    {tab === 'System Validations' && <>
      <form className="form-grid" onSubmit={submitValidation}>
        <label>System<select value={validationForm.systemId} onChange={e => setValidationForm({ ...validationForm, systemId: e.target.value })} required><option value="">—</option>{systems.map(s => <option key={s.id} value={s.id}>{s.system_name}</option>)}</select></label>
        <label>Validation date<input type="date" value={validationForm.validationDate} onChange={e => setValidationForm({ ...validationForm, validationDate: e.target.value })} required /></label>
        <label>Type<select value={validationForm.validationType} onChange={e => setValidationForm({ ...validationForm, validationType: e.target.value })}>{VALIDATION_TYPES.map(t => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}</select></label>
        <label>Release id<input type="number" value={validationForm.releaseId} onChange={e => setValidationForm({ ...validationForm, releaseId: e.target.value })} /></label>
        <label>Change request id<input type="number" value={validationForm.changeRequestId} onChange={e => setValidationForm({ ...validationForm, changeRequestId: e.target.value })} /></label>
        <label>Scope<TextField value={validationForm.scope} onValue={nextValue => setValidationForm({ ...validationForm, scope: nextValue })} /></label>
        <label>Test summary<TextField as="textarea" value={validationForm.testSummary} onValue={nextValue => setValidationForm({ ...validationForm, testSummary: nextValue })} /></label>
        <label>Deviations found<TextField as="textarea" value={validationForm.deviationsFound} onValue={nextValue => setValidationForm({ ...validationForm, deviationsFound: nextValue })} /></label>
        <label>Outcome<TextField value={validationForm.outcome} onValue={nextValue => setValidationForm({ ...validationForm, outcome: nextValue })} /></label>
        <button type="submit">Record validation</button>
      </form>
      <table className="data-table"><thead><tr><th>Number</th><th>System</th><th>Date</th><th>Type</th><th>Outcome</th><th>Status</th><th></th></tr></thead><tbody>
        {validations.map(v => <tr key={v.id}><td>{v.validation_number}</td><td>{systems.find(s => s.id === v.system_id)?.system_name || '—'}</td><td>{v.validation_date}</td><td>{v.validation_type.replace(/_/g, ' ')}</td><td>{v.outcome || '—'}</td><td>{formatBadge(v.status)}</td>
          <td>{v.status !== 'approved' && v.status !== 'closed' && <button onClick={() => approveValidation(v.id)}>Approve</button>}{v.status !== 'closed' && <button onClick={() => closeValidation(v.id)}>Close</button>}</td>
        </tr>)}
      </tbody></table>
    </>}

    {tab === 'Downtime Records' && <>
      <form className="form-grid" onSubmit={submitDowntime}>
        <label>System<select value={downtimeForm.systemId} onChange={e => setDowntimeForm({ ...downtimeForm, systemId: e.target.value })} required><option value="">—</option>{systems.map(s => <option key={s.id} value={s.id}>{s.system_name}</option>)}</select></label>
        <label>Downtime start<input type="datetime-local" value={downtimeForm.downtimeStart} onChange={e => setDowntimeForm({ ...downtimeForm, downtimeStart: e.target.value })} required /></label>
        <label>Downtime end<input type="datetime-local" value={downtimeForm.downtimeEnd} onChange={e => setDowntimeForm({ ...downtimeForm, downtimeEnd: e.target.value })} /></label>
        <label>Type<select value={downtimeForm.downtimeType} onChange={e => setDowntimeForm({ ...downtimeForm, downtimeType: e.target.value })}>{DOWNTIME_TYPES.map(t => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}</select></label>
        <label>Affected services<TextField as="textarea" value={downtimeForm.affectedServices} onValue={nextValue => setDowntimeForm({ ...downtimeForm, affectedServices: nextValue })} required /></label>
        <label>Impact summary<TextField as="textarea" value={downtimeForm.impactSummary} onValue={nextValue => setDowntimeForm({ ...downtimeForm, impactSummary: nextValue })} /></label>
        <label>Workaround used<TextField as="textarea" value={downtimeForm.workaroundUsed} onValue={nextValue => setDowntimeForm({ ...downtimeForm, workaroundUsed: nextValue })} /></label>
        <button type="submit">Log downtime</button>
      </form>
      <table className="data-table"><thead><tr><th>Number</th><th>System</th><th>Start</th><th>End</th><th>Duration (min)</th><th>Affected</th><th>Status</th><th></th></tr></thead><tbody>
        {downtime.map(d => <tr key={d.id}><td>{d.downtime_number}</td><td>{systems.find(s => s.id === d.system_id)?.system_name || '—'}</td><td>{d.downtime_start}</td><td>{d.downtime_end || '—'}</td><td>{d.duration_minutes ?? '—'}</td><td>{d.affected_services}</td><td>{formatBadge(d.status)}</td>
          <td><button onClick={() => downtimeCreateAction(d.id)}>Action</button>{!d.linked_nc_id && <button onClick={() => downtimeCreateNc(d.id)}>NC</button>}{d.status === 'open' && <button onClick={() => resolveDowntime(d.id)}>Resolve</button>}{d.status !== 'closed' && <button onClick={() => closeDowntime(d.id)}>Close</button>}</td>
        </tr>)}
      </tbody></table>
    </>}

    {tab === 'Information Reviews' && <>
      <form className="form-grid" onSubmit={submitReview}>
        <label>Period start<input type="date" value={reviewForm.reviewPeriodStart} onChange={e => setReviewForm({ ...reviewForm, reviewPeriodStart: e.target.value })} required /></label>
        <label>Period end<input type="date" value={reviewForm.reviewPeriodEnd} onChange={e => setReviewForm({ ...reviewForm, reviewPeriodEnd: e.target.value })} required /></label>
        <label>Review date<input type="date" value={reviewForm.reviewDate} onChange={e => setReviewForm({ ...reviewForm, reviewDate: e.target.value })} required /></label>
        <button type="submit">Open review</button>
      </form>
      <table className="data-table"><thead><tr><th>Number</th><th>Period</th><th>Status</th><th></th></tr></thead><tbody>
        {reviews.map(r => <tr key={r.id}><td>{r.review_number}</td><td>{r.review_period_start} → {r.review_period_end}</td><td>{formatBadge(r.status)}</td>
          <td><button onClick={() => generateReviewSummary(r.id)}>Generate summary</button> <button onClick={() => setExpandedReviewId(expandedReviewId === r.id ? null : r.id)}>{expandedReviewId === r.id ? 'Hide' : 'View'} summary</button> {r.status !== 'approved' && r.status !== 'closed' && <button onClick={() => approveReview(r.id)}>Approve</button>}{r.status !== 'closed' && <button onClick={() => closeReview(r.id)}>Close</button>}</td>
        </tr>)}
      </tbody></table>
      {expandedReviewId !== null && (() => {
        const r = reviews.find(x => x.id === expandedReviewId);
        if (!r) return null;
        return <div className="card" style={{ marginTop: 12 }}>
          <h4>Review {r.review_number} ({r.review_period_start} → {r.review_period_end})</h4>
          <p><strong>Information assets:</strong> {r.information_assets_summary || '—'}</p>
          <p><strong>Access reviews:</strong> {r.access_review_summary || '—'}</p>
          <p><strong>Security incidents:</strong> {r.security_incident_summary || '—'}</p>
          <p><strong>Change requests:</strong> {r.change_request_summary || '—'}</p>
          <p><strong>Downtime:</strong> {r.downtime_summary || '—'}</p>
          <p><strong>Validation/release:</strong> {r.validation_summary || '—'}</p>
          <p><strong>Data integrity:</strong> {r.data_integrity_summary || '—'}</p>
        </div>;
      })()}
    </>}

    {tab === 'Reports' && <>
      <h3>Printable reports</h3>
      <p>Detailed report templates for information management remain placeholders in this foundation. The cross-module Records, Reports & Evidence module can be used to generate CSV/JSON/HTML exports filtered by date for any of the tables in this module.</p>
      <ul>
        <li>Information asset register — placeholder</li>
        <li>Access review report — placeholder</li>
        <li>Security incident report — placeholder</li>
        <li>Downtime report — placeholder</li>
        <li>Change control report — placeholder</li>
      </ul>
    </>}
  </div>;
}
