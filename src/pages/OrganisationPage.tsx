import { FormEvent, useEffect, useMemo, useState } from 'react';
import PageHeader from '../components/ui/PageHeader';
import { KpiStrip, ChartCard, DonutChart, BarMeter, CHART_COLORS, ModuleAlerts } from '../components/ui';
import { useModules } from '../hooks/useModules';
import { api, API_BASE, getToken } from '../services/api';
import DisabledModule from '../components/DisabledModule';
import { MeetingsPage, ManagementReviewPage } from './Phase8Pages';
import { Link, useSearchParams } from 'react-router-dom';
import PermissionTabs from '../components/PermissionTabs';
import { usePermissions } from '../hooks/usePermissions';
import type {
  Staff, CodeOfConductRecord, BudgetProjection, OrganisationSummary, RegulatoryRegistration, LaboratoryConfig,
  EthicalDeclarationForm, EthicalDeclarationSignature, ContinuityPlan, QtReviewConfig, QtReview, Position, OrgTree,
  DeclarationTemplate,
} from '../../shared/types/api';

const statusBadgeClass = (status?: string) => `badge ${status ? status.toLowerCase().replace(/\s+/g, '-') : 'unknown'}`;
const formatBadge = (status?: string) => <span className={statusBadgeClass(status)}>{status ? status.replace(/_/g, ' ') : 'Unknown'}</span>;
// Tabs are filtered by permission — a tab whose feature this user cannot
// view is not drawn. See src/components/PermissionTabs.tsx.
const TAB_MODULE = 'organisation';
const tabBar = (active: string, tabs: string[], onChange: (name: string) => void) =>
  <PermissionTabs moduleKey={TAB_MODULE} tabs={tabs} active={active} onChange={onChange} />;
const pretty = (s?: string) => s ? s.replace(/_/g, ' ') : '—';

async function uploadFileToServer(file: File): Promise<string> {
  const fd = new FormData();
  fd.append('file', file);
  const token = getToken();
  const r = await fetch(`${API_BASE}/files`, { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : undefined, body: fd });
  if (!r.ok) throw new Error((await r.json().catch(() => ({ error: r.statusText }))).error ?? r.statusText);
  return String((await r.json()).id);
}

async function fetchBlobUrl(path: string): Promise<string> {
  const token = getToken();
  const r = await fetch(`${API_BASE}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : undefined });
  if (!r.ok) throw new Error('Could not load the file.');
  return URL.createObjectURL(await r.blob());
}

// Fetch a protected image with the auth header and return it as a data: URL —
// used to embed signature images inside a print window that carries no session.
async function blobAsDataUrl(path: string): Promise<string> {
  const token = getToken();
  const r = await fetch(`${API_BASE}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : undefined });
  if (!r.ok) throw new Error('Could not load the image.');
  const blob = await r.blob();
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// A staff member's signature image shown inline, fetched with the auth header.
// Falls back to their name in a script face when no signature is on file (or
// the fetch is not permitted).
function SignatureImage({ staffId, hasSignature, name }: { staffId: number; hasSignature: boolean; name: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let revoke: string | null = null;
    if (hasSignature) {
      fetchBlobUrl(`/signatures/staff/${staffId}/image`).then(u => { revoke = u; setUrl(u); }).catch(() => setFailed(true));
    }
    return () => { if (revoke) URL.revokeObjectURL(revoke); };
  }, [staffId, hasSignature]);
  if (hasSignature && url && !failed) return <img src={url} alt={`${name} signature`} style={{ maxHeight: 34, maxWidth: 150 }} />;
  return <span style={{ fontFamily: "'Segoe Script', 'Brush Script MT', cursive", fontSize: 15 }}>{name}</span>;
}

// Read-only display of the laboratory configuration owned by Settings → My
// Laboratory. Shown here so the whole team can see the legal identity, quality
// manual, quality policy and objectives; it can only be changed in Settings.
export function QualityConfigurationView({ config }: { config: LaboratoryConfig | null }) {
  if (!config) return <div className="card"><p>Loading laboratory configuration…</p></div>;
  const p = config.profile;
  const standing = config.objectives.filter(o => o.year === null || o.year === undefined);
  const annual = config.objectives.filter(o => o.year != null);
  const years = Array.from(new Set(annual.map(o => o.year as number))).sort((a, b) => b - a);
  const legalDocs = config.documents.filter(d => d.category === 'legal_identity');
  const manualDocs = config.documents.filter(d => d.category === 'quality_manual');
  return <div className="grid" style={{ gap: 16 }}>
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
        <h3 style={{ margin: 0 }}>Laboratory identity</h3>
        <Link className="hint" to="/settings/laboratory">Edit in Settings → My Laboratory</Link>
      </div>
      {p ? <div className="form-grid" style={{ marginTop: 10 }}>
        <div><span className="hint">Facility</span><div><strong>{p.facility_name}</strong>{p.short_name ? ` (${p.short_name})` : ''}</div></div>
        <div><span className="hint">Legal status</span><div>{p.legal_status || '—'}</div></div>
        <div><span className="hint">Registration no</span><div>{p.registration_number || '—'}</div></div>
        <div><span className="hint">Accreditation</span><div>{p.accreditation_status || '—'}{p.accreditation_body ? ` · ${p.accreditation_body}` : ''}</div></div>
        <div><span className="hint">Location</span><div>{[p.city, p.country].filter(Boolean).join(', ') || '—'}</div></div>
        <div><span className="hint">Contact</span><div>{p.phone || p.email || '—'}</div></div>
      </div> : <p>Not yet registered.</p>}
      {p?.legal_identity_notes && <p style={{ marginTop: 10 }}>{p.legal_identity_notes}</p>}
      {legalDocs.length > 0 && <p className="hint" style={{ marginTop: 8 }}>Legal documents on file: {legalDocs.map(d => d.title).join(', ')}.</p>}
    </div>

    <div className="card">
      <h3>Quality policy</h3>
      {p?.quality_policy ? <p style={{ whiteSpace: 'pre-wrap' }}>{p.quality_policy}</p> : <p className="hint">No quality policy recorded yet.</p>}
      {config.policies.length > 0 && <>
        <h4>Supporting policies</h4>
        <ul className="link-list">{config.policies.map(pol => <li key={pol.id}><strong>{pol.title}:</strong> {pol.policy_statement}{pol.reference_note ? <> <span className="hint">({pol.reference_note})</span></> : ''}</li>)}</ul>
      </>}
    </div>

    <div className="card">
      <h3>Quality manual</h3>
      {p?.quality_manual_summary ? <p style={{ whiteSpace: 'pre-wrap' }}>{p.quality_manual_summary}</p> : <p className="hint">No quality manual summary recorded yet.</p>}
      {manualDocs.length > 0 && <p className="hint">Manual documents on file: {manualDocs.map(d => `${d.title}${d.version ? ` ${d.version}` : ''}`).join(', ')}.</p>}
    </div>

    <div className="card">
      <h3>Quality objectives</h3>
      {standing.length === 0 && annual.length === 0 && <p className="hint">No quality objectives recorded yet.</p>}
      {standing.length > 0 && <>
        <h4>Standing objectives</h4>
        <table className="data-table"><thead><tr><th>Objective</th><th>Target</th><th>Measure</th><th>Owner</th></tr></thead><tbody>
          {standing.map(o => <tr key={o.id}><td>{o.objective}</td><td>{o.target || '—'}</td><td>{o.measure || '—'}</td><td>{o.responsible_name || '—'}</td></tr>)}
        </tbody></table>
      </>}
      {years.map(y => <div key={y} style={{ marginTop: 12 }}>
        <h4>{y} objectives</h4>
        <table className="data-table"><thead><tr><th>Objective</th><th>Target</th><th>Measure</th><th>Owner</th><th>Status</th></tr></thead><tbody>
          {annual.filter(o => o.year === y).map(o => <tr key={o.id}><td>{o.objective}</td><td>{o.target || '—'}</td><td>{o.measure || '—'}</td><td>{o.responsible_name || '—'}</td><td>{formatBadge(o.status)}</td></tr>)}
        </tbody></table>
      </div>)}
    </div>
  </div>;
}

const FORM_TYPES: Array<{ key: string; label: string }> = [
  { key: 'code_of_conduct', label: 'Code of Conduct' },
  { key: 'adherence', label: 'Adherence to Organisational Policies & Procedures' },
  { key: 'impartiality', label: 'Declaration of Impartiality' },
  { key: 'confidentiality', label: 'Declaration of Confidentiality' },
  { key: 'conflict_of_interest', label: 'Declaration of Conflict of Interest' },
  { key: 'other', label: 'Other declaration' },
];

const BUDGET_SCOPES: Array<{ key: string; label: string }> = [
  { key: 'personnel', label: 'Personnel needs' },
  { key: 'scope_of_test', label: 'Scope of tests' },
  { key: 'infrastructure', label: 'Infrastructure' },
  { key: 'equipment', label: 'Equipment needs' },
  { key: 'service_maintenance', label: 'Service & maintenance' },
  { key: 'quality_assurance', label: 'Quality assurance process' },
  { key: 'iqc_eqa', label: 'IQC & EQA materials' },
  { key: 'materials', label: 'Consumables / materials' },
  { key: 'other', label: 'Other' },
];

const TABS = ['Dashboard', 'Quality Configuration', 'Code of Conduct', 'Organogram & Deputisation', 'Budgetary Projection', 'Quality & Technical Records Review', 'Registrations & Licences', 'Meetings', 'Management Review'];

export function OrganisationPage() {
  const { can } = usePermissions();
  const { isEnabled } = useModules();
  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTab] = useState<string>(searchParams.get('tab') || 'Dashboard');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [summary, setSummary] = useState<OrganisationSummary | null>(null);
  const [conduct, setConduct] = useState<CodeOfConductRecord[]>([]);
  const [budget, setBudget] = useState<BudgetProjection[]>([]);
  const [registrations, setRegistrations] = useState<RegulatoryRegistration[]>([]);
  const [config, setConfig] = useState<LaboratoryConfig | null>(null);

  const [regForm, setRegForm] = useState({ credentialType: '', title: '', issuingBody: '', reference: '', issueDate: '', expiryDate: '', responsibleStaffId: '', status: 'active' });

  async function load() {
    try {
      const [sum, coc, bud, reg, stf] = await Promise.all([
        api<OrganisationSummary>('/organisation/summary').catch(() => null),
        api<CodeOfConductRecord[]>('/organisation/code-of-conduct').catch(() => []),
        api<BudgetProjection[]>('/organisation/budget').catch(() => []),
        api<RegulatoryRegistration[]>('/organisation/registrations').catch(() => []),
        api<Staff[]>('/staff').catch(() => []),
      ]);
      if (sum) setSummary(sum);
      setConduct(coc); setBudget(bud); setRegistrations(reg); setStaff(stf);
      api<LaboratoryConfig>('/laboratory-config').then(setConfig).catch(() => setConfig(null));
    } catch (e) { setError((e as Error).message); }
  }
  useEffect(() => { if (isEnabled('organisation')) void load(); }, [isEnabled]);
  useEffect(() => { const t = searchParams.get('tab'); if (t && t !== tab) setTab(t); }, [searchParams]);

  function flash(msg: string) { setNotice(msg); setError(null); setTimeout(() => setNotice(null), 5000); }

  if (!isEnabled('organisation')) return <DisabledModule />;

  const staffName = (id?: number | null) => staff.find(s => s.id === id)?.fullName || '—';

  async function submitReg(e: FormEvent) {
    e.preventDefault(); setError(null);
    try { await api('/organisation/registrations', { method: 'POST', body: JSON.stringify(regForm) }); setRegForm({ credentialType: '', title: '', issuingBody: '', reference: '', issueDate: '', expiryDate: '', responsibleStaffId: '', status: 'active' }); await load(); }
    catch (e) { setError((e as Error).message); }
  }

  const budgetByScope = BUDGET_SCOPES.map((c, i) => ({
    label: c.label,
    value: budget.filter(b => (b as any).scope === c.key).reduce((s, b) => s + (b.projected_amount || 0), 0),
    color: CHART_COLORS[i % CHART_COLORS.length],
    onClick: () => setTab('Budgetary Projection'),
  })).filter(d => d.value > 0);

  const enabledTabs = TABS.filter(t => (t === 'Meetings' ? isEnabled('meetings') : t === 'Management Review' ? isEnabled('management_review') : true));

  return <div className="module-page">
    <PageHeader eyebrow="Organisation and Leadership" title="Organisation &amp; Leadership" subtitle="Leadership commitments, ethical declarations, organogram, budgetary projections and routine record reviews." />
    {tabBar(tab, enabledTabs, t => { setTab(t); setSearchParams(prev => { prev.set('tab', t); return prev; }); })}
    {error && <div className="error">{error}</div>}
    {notice && <div className="banner-success" style={{ background: '#e8f6ee', border: '1px solid #58b27a', color: '#1c6b3e', padding: '8px 12px', borderRadius: 6, margin: '8px 0' }}>{notice}</div>}

    {tab === 'Quality Configuration' && <QualityConfigurationView config={config} />}

    {tab === 'Dashboard' && <><ModuleAlerts moduleKey="organisation" /><KpiStrip items={[
      { label: 'Code-of-conduct records', value: summary?.codeOfConductRecords ?? conduct.length, onClick: () => setTab('Code of Conduct') },
      { label: 'Due review', value: summary?.codeOfConductDueReview ?? 0, tone: (summary?.codeOfConductDueReview ?? 0) ? 'warning' : undefined, onClick: () => setTab('Code of Conduct') },
      { label: 'Declared conflicts', value: summary?.declaredConflicts ?? 0, tone: (summary?.declaredConflicts ?? 0) ? 'danger' : undefined, onClick: () => setTab('Code of Conduct') },
      { label: 'Budget lines (year)', value: summary?.budgetLinesCurrentYear ?? 0, onClick: () => setTab('Budgetary Projection') },
      { label: 'Budget total (year)', value: summary ? Math.round(summary.budgetTotalCurrentYear).toLocaleString() : 0, onClick: () => setTab('Budgetary Projection') },
      { label: 'Registrations', value: summary?.activeRegistrations ?? 0, onClick: () => setTab('Registrations & Licences') },
      { label: 'Expiring soon', value: summary?.registrationsExpiringSoon ?? 0, tone: (summary?.registrationsExpiringSoon ?? 0) ? 'warning' : undefined, onClick: () => setTab('Registrations & Licences') },
      { label: 'Expired', value: summary?.registrationsExpired ?? 0, tone: (summary?.registrationsExpired ?? 0) ? 'danger' : undefined, onClick: () => setTab('Registrations & Licences') },
    ]} />
    <div className="grid cols-2 dash-charts" style={{ marginTop: 18 }}>
      <ChartCard title="Budget by scope" subtitle="Projected amounts, current fiscal year">
        <DonutChart centerLabel="Scopes" data={budgetByScope} />
      </ChartCard>
      <ChartCard title="Code of conduct" subtitle="Adherence and conflict declarations">
        <BarMeter data={[
          { label: 'Active records', value: summary?.codeOfConductRecords ?? conduct.length, color: CHART_COLORS[1], onClick: () => setTab('Code of Conduct') },
          { label: 'Due review', value: summary?.codeOfConductDueReview ?? 0, color: CHART_COLORS[2], onClick: () => setTab('Code of Conduct') },
          { label: 'Declared conflicts', value: summary?.declaredConflicts ?? 0, color: CHART_COLORS[3], onClick: () => setTab('Code of Conduct') },
        ]} />
      </ChartCard>
    </div></>}

    {tab === 'Code of Conduct' && <CodeOfConductView staff={staff} onError={setError} onNotice={flash} />}
    {tab === 'Organogram & Deputisation' && <OrganogramContinuityView staff={staff} onError={setError} onNotice={flash} />}
    {tab === 'Budgetary Projection' && <BudgetProjectionView staff={staff} onError={setError} onNotice={flash} />}
    {tab === 'Quality & Technical Records Review' && <QtRecordsReviewView staff={staff} onError={setError} onNotice={flash} />}

    {tab === 'Registrations & Licences' && <>
      <div className="card">
        <h3>Add registration / licence</h3>
        <p className="muted" style={{ marginTop: 0 }}>Facility licences, accreditation, practice registrations and permits. Enter the issuing body for your jurisdiction.</p>
        {can('organisation.licences', 'create') && <form className="form-grid" onSubmit={submitReg}>
          <label>Type<select value={regForm.credentialType} onChange={e => setRegForm({ ...regForm, credentialType: e.target.value })}><option value="">—</option>{['facility_licence', 'accreditation', 'practice_registration', 'permit', 'certification', 'other'].map(c => <option key={c} value={c}>{pretty(c)}</option>)}</select></label>
          <label>Title<input value={regForm.title} onChange={e => setRegForm({ ...regForm, title: e.target.value })} required /></label>
          <label>Issuing body<input value={regForm.issuingBody} onChange={e => setRegForm({ ...regForm, issuingBody: e.target.value })} placeholder="regulator / authority name" /></label>
          <label>Reference<input value={regForm.reference} onChange={e => setRegForm({ ...regForm, reference: e.target.value })} /></label>
          <label>Issue date<input type="date" value={regForm.issueDate} onChange={e => setRegForm({ ...regForm, issueDate: e.target.value })} /></label>
          <label>Expiry date<input type="date" value={regForm.expiryDate} onChange={e => setRegForm({ ...regForm, expiryDate: e.target.value })} /></label>
          <label>Responsible<select value={regForm.responsibleStaffId} onChange={e => setRegForm({ ...regForm, responsibleStaffId: e.target.value })}><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
          <label>Status<select value={regForm.status} onChange={e => setRegForm({ ...regForm, status: e.target.value })}>{['active', 'pending_renewal', 'expired', 'withdrawn'].map(s => <option key={s} value={s}>{pretty(s)}</option>)}</select></label>
          <button type="submit">Add registration</button>
        </form>}
      </div>
      <div className="card" style={{ marginTop: 16 }}>
        <h3>Registrations & licences register</h3>
        {registrations.length === 0 ? <p>No registrations recorded.</p> :
          <table className="data-table"><thead><tr><th>No.</th><th>Type</th><th>Title</th><th>Issuing body</th><th>Reference</th><th>Expiry</th><th>Status</th></tr></thead><tbody>
            {registrations.map(r => <tr key={r.id}><td>{r.registration_number}</td><td>{pretty(r.credential_type)}</td><td>{r.title}</td><td>{r.issuing_body || '—'}</td><td>{r.reference || '—'}</td><td>{r.expiry_date || '—'}</td><td>{formatBadge(r.status)}</td></tr>)}
          </tbody></table>}
      </div>
    </>}

    {tab === 'Meetings' && <MeetingsPage embedded />}
    {tab === 'Management Review' && <ManagementReviewPage embedded />}
  </div>;
}

// ============================================================================
// Code of Conduct — set up ethical declarations from pre-populated templates
// (or an uploaded form), then let each member of staff read and sign them.
// Signing is strictly personal (the server binds it to the caller's user id)
// and can never be done on someone else's behalf. Once signed, every signature
// is appended to the declaration and the whole record can be printed.
// ============================================================================
const emptyDeclarationSetup = {
  title: '', formType: 'code_of_conduct', description: '', version: '1.0', effectiveDate: '',
  reviewFrequencyMonths: '12', nextReviewDate: '', requiresAnnualReaffirmation: true, status: 'active',
  bodyContent: '', acknowledgementStatement: '', templateKey: '',
};

function CodeOfConductView({ staff, onError, onNotice }: { staff: Staff[]; onError: (m: string) => void; onNotice: (m: string) => void }) {
  const { can } = usePermissions();
  const staffName = (id?: number | null) => staff.find(s => s.id === id)?.fullName || '—';
  const [searchParams] = useSearchParams();
  const focusForm = searchParams.get('form');
  const [forms, setForms] = useState<EthicalDeclarationForm[]>([]);
  const [templates, setTemplates] = useState<DeclarationTemplate[]>([]);
  const [selected, setSelected] = useState<EthicalDeclarationForm | null>(null);
  const [signatures, setSignatures] = useState<EthicalDeclarationSignature[]>([]);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [signForm, setSignForm] = useState({ conflictDeclared: false, conflictDetails: '', affirmationText: '', notes: '' });
  const [signedFile, setSignedFile] = useState<File | null>(null);
  const [signing, setSigning] = useState(false);
  const [setupForm, setSetupForm] = useState(emptyDeclarationSetup);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [showSetup, setShowSetup] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [showManage, setShowManage] = useState(false);
  const [saving, setSaving] = useState(false);

  async function load() {
    try {
      const list = await api<EthicalDeclarationForm[]>('/organisation/ethical-forms');
      setForms(list);
      if (focusForm) {
        const focus = list.find(f => String(f.id) === focusForm);
        if (focus) void openForm(focus);
      }
    } catch (e) { onError((e as Error).message); }
  }
  useEffect(() => { void load(); }, []);
  useEffect(() => { api<DeclarationTemplate[]>('/organisation/declaration-templates').then(setTemplates).catch(() => setTemplates([])); }, []);

  async function openForm(f: EthicalDeclarationForm) {
    setSelected(f);
    setSignatures([]);
    setPreviewUrl(null);
    try {
      const detail = await api<EthicalDeclarationForm & { signatures: EthicalDeclarationSignature[] }>(`/organisation/ethical-forms/${f.id}`);
      setSelected(detail);
      setSignatures(detail.signatures || []);
      if (detail.file_id) fetchBlobUrl(`/files/${detail.file_id}/raw`).then(setPreviewUrl).catch(() => setPreviewUrl(null));
    } catch (e) { onError((e as Error).message); }
  }

  // Choosing a template copies its wording onto the editable setup form. The
  // laboratory can then amend anything before it is published.
  function applyTemplate(key: string) {
    if (!key) { setSetupForm({ ...emptyDeclarationSetup }); return; }
    const t = templates.find(x => x.key === key);
    if (!t) { setSetupForm({ ...emptyDeclarationSetup, templateKey: '' }); return; }
    setSetupForm({
      ...emptyDeclarationSetup,
      templateKey: t.key, title: t.title, formType: t.formType, description: t.purpose,
      bodyContent: t.bodyContent, acknowledgementStatement: t.acknowledgementStatement,
      reviewFrequencyMonths: String(t.reviewFrequencyMonths ?? 12),
      requiresAnnualReaffirmation: t.requiresAnnualReaffirmation !== false,
    });
  }

  function resetSetup() { setSetupForm({ ...emptyDeclarationSetup }); setUploadFile(null); setEditingId(null); }

  // Edit an existing declaration — populate the setup form with its current
  // values so it can be amended in place. Reached from the tucked-away Manage
  // control on the selected declaration.
  function startEdit(f: EthicalDeclarationForm) {
    setEditingId(f.id);
    setSetupForm({
      title: f.title || '', formType: f.form_type || 'code_of_conduct', description: f.description || '',
      version: f.version || '1.0', effectiveDate: f.effective_date || '',
      reviewFrequencyMonths: f.review_frequency_months != null ? String(f.review_frequency_months) : '12',
      nextReviewDate: f.next_review_date || '', requiresAnnualReaffirmation: f.requires_annual_reaffirmation !== 0,
      status: f.status || 'active', bodyContent: f.body_content || '', acknowledgementStatement: f.acknowledgement_statement || '',
      templateKey: f.template_key || '',
    });
    setUploadFile(null); setShowManage(false); setShowSetup(true);
  }

  async function deleteDeclaration(f: EthicalDeclarationForm) {
    if (!confirm(`Delete "${f.title}" and all of its signatures? This cannot be undone.`)) return;
    onError('');
    try {
      await api(`/organisation/ethical-forms/${f.id}`, { method: 'DELETE' });
      setSelected(null); setShowManage(false);
      await load();
      onNotice('Declaration deleted.');
    } catch (e) { onError((e as Error).message); }
  }

  async function submitSetup(e: FormEvent) {
    e.preventDefault(); onError('');
    if (!setupForm.bodyContent.trim() && !uploadFile && !(editingId && selected?.file_id)) { onError('Add the declaration text, or attach a form file.'); return; }
    setSaving(true);
    try {
      const fileId = uploadFile ? await uploadFileToServer(uploadFile) : undefined;
      if (editingId) {
        await api(`/organisation/ethical-forms/${editingId}`, { method: 'PUT', body: JSON.stringify({ ...setupForm, ...(fileId ? { fileId } : {}) }) });
        resetSetup(); setShowSetup(false);
        await load(); await openForm({ id: editingId } as EthicalDeclarationForm);
        onNotice('Declaration updated.');
      } else {
        await api('/organisation/ethical-forms', { method: 'POST', body: JSON.stringify({ ...setupForm, fileId }) });
        resetSetup(); setShowSetup(false);
        await load();
        onNotice('Declaration published. Every active staff has been notified in their inbox to open, read and sign it.');
      }
    } catch (e) { onError((e as Error).message); }
    finally { setSaving(false); }
  }

  async function signSelected(e: FormEvent) {
    e.preventDefault();
    if (!selected) return;
    const fileBased = !selected.body_content && !!selected.file_id;
    if (fileBased && !signedFile) { onError('Download the form, sign it, then attach the signed copy before submitting.'); return; }
    onError('');
    setSigning(true);
    try {
      const signedFileId = signedFile ? await uploadFileToServer(signedFile) : undefined;
      await api(`/organisation/ethical-forms/${selected.id}/sign`, { method: 'POST', body: JSON.stringify({ ...signForm, signedFileId }) });
      setSignForm({ conflictDeclared: false, conflictDetails: '', affirmationText: '', notes: '' });
      setSignedFile(null);
      await load();
      const fresh = await api<EthicalDeclarationForm & { signatures: EthicalDeclarationSignature[] }>(`/organisation/ethical-forms/${selected.id}`);
      setSelected(fresh); setSignatures(fresh.signatures || []);
      onNotice('Your acknowledgement has been signed and recorded. Thank you.');
    } catch (e) { onError((e as Error).message); }
    finally { setSigning(false); }
  }

  // Fetch a file with the auth header and hand it to the browser to save.
  async function downloadFileById(fileId: number, name: string) {
    const url = await fetchBlobUrl(`/files/${fileId}/download`);
    const a = document.createElement('a'); a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  // Print the declaration together with every appended signature, so the signed
  // record can be filed or held on paper. Each signatory's actual signature
  // image (uploaded once under their profile) is embedded where they have one.
  async function printDeclaration() {
    if (!selected) return;
    const typeLabel = FORM_TYPES.find(t => t.key === selected.form_type)?.label || selected.form_type;
    const esc = (s?: string | null) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const sigImgs = await Promise.all(signatures.map(s => s.signature_file_id ? blobAsDataUrl(`/signatures/staff/${s.staff_id}/image`).catch(() => null) : Promise.resolve(null)));
    const rows = signatures.map((s, i) => {
      const img = sigImgs[i];
      const sigCell = img ? `<img class="sigimg" src="${img}" alt="signature" />`
        : s.signed_file_id ? '<span class="muted">signed copy on file</span>'
        : `<span class="signame">${esc(s.staff_name || staffName(s.staff_id))}</span>`;
      return `<tr>
      <td>${i + 1}</td>
      <td>${esc(s.staff_name || staffName(s.staff_id))}</td>
      <td>${esc(s.employee_no || '—')}</td>
      <td>${esc(s.section_name || '—')}</td>
      <td>${esc(String(s.signed_at).slice(0, 19).replace('T', ' '))}</td>
      <td>${s.conflict_declared ? 'Declared' : '—'}</td>
      <td class="sig">${sigCell}</td>
    </tr>`;
    }).join('');
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(selected.title)}</title>
      <style>
        body { font-family: Georgia, 'Times New Roman', serif; color: #111; margin: 32px; line-height: 1.5; }
        h1 { font-size: 20px; margin: 0 0 2px; }
        .meta { color: #555; font-size: 12px; margin-bottom: 18px; }
        .body { white-space: pre-wrap; font-size: 13.5px; margin: 16px 0 22px; }
        .ack { border-left: 3px solid #333; padding: 6px 12px; font-style: italic; margin: 18px 0; }
        h2 { font-size: 14px; border-bottom: 1px solid #999; padding-bottom: 4px; margin-top: 26px; }
        table { width: 100%; border-collapse: collapse; font-family: Arial, sans-serif; font-size: 11.5px; }
        th, td { border: 1px solid #999; padding: 5px 7px; text-align: left; vertical-align: top; }
        th { background: #f0f0f0; }
        td.sig { min-width: 120px; }
        .sigimg { max-height: 40px; max-width: 160px; }
        .signame { font-family: 'Segoe Script', 'Brush Script MT', cursive; font-size: 15px; }
        .muted { color: #666; font-style: italic; }
        .empty { color: #666; font-style: italic; }
        @media print { body { margin: 12mm; } }
      </style></head><body>
      <div class="meta">${esc(typeLabel)}${selected.form_number ? ` · ${esc(selected.form_number)}` : ''}</div>
      <h1>${esc(selected.title)}</h1>
      <div class="meta">Version ${esc(selected.version || '—')} · effective ${esc(selected.effective_date || '—')}${selected.uploaded_by_name ? ` · issued by ${esc(selected.uploaded_by_name)}` : ''}</div>
      ${selected.description ? `<p>${esc(selected.description)}</p>` : ''}
      ${selected.body_content ? `<div class="body">${esc(selected.body_content)}</div>` : '<p class="empty">The declaration text was supplied as an attached file.</p>'}
      ${selected.acknowledgement_statement ? `<div class="ack">${esc(selected.acknowledgement_statement)}</div>` : ''}
      <h2>Acknowledgement of signatories (${signatures.length})</h2>
      ${signatures.length ? `<table><thead><tr><th>#</th><th>Name</th><th>Staff ID</th><th>Section</th><th>Signed on</th><th>Conflict</th><th>Signature</th></tr></thead><tbody>${rows}</tbody></table>`
        : '<p class="empty">No signatures recorded yet.</p>'}
      <script>window.onload = function(){ window.print(); }</script>
      </body></html>`;
    const w = window.open('', '_blank', 'width=900,height=700');
    if (!w) { onError('Allow pop-ups to print the declaration.'); return; }
    w.document.write(html); w.document.close();
  }

  // Raising a declaration and signing one are different jobs. Every member of
  // staff opens the form, reads it and signs their own acknowledgement — that
  // is what `organisation.structure:view` buys, and the sign endpoint asks for
  // exactly that. Setting one UP is a create, and the API has always refused it
  // to a reader; this said `true` with a note that the server would enforce it,
  // so bench staff were shown a button that could only ever fail. What you
  // cannot do you should not see.
  const canManage = can('organisation.structure', 'create');
  const canEditForm = can('organisation.structure', 'edit');
  const canDeleteForm = can('organisation.structure', 'void_archive');
  const isFileOnly = selected && !selected.body_content && !!selected.file_id;

  return <div>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
      <div>
        <h3 style={{ margin: 0 }}>Code of Conduct &amp; Ethical Declarations</h3>
        <p className="muted" style={{ margin: 0, fontSize: 12 }}>Set up each declaration once from a pre-populated template; every member of staff opens it, reads it, and signs their own acknowledgement. Signatures are personal, appended to the form, and can be printed.</p>
      </div>
      {canManage && <button onClick={() => { if (showSetup) { resetSetup(); setShowSetup(false); } else { resetSetup(); setShowSetup(true); } }}>{showSetup ? 'Cancel' : '＋ Set up declaration'}</button>}
    </div>

    {showSetup && <div className="card" style={{ marginTop: 10 }}>
      <h4 style={{ marginTop: 0 }}>{editingId ? 'Edit declaration' : 'Set up declaration'}</h4>
      <p className="muted" style={{ marginTop: 0 }}>{editingId ? 'Amend this declaration. Changes apply to the form staff open and sign; existing signatures are kept.' : 'Start from a pre-populated declaration and edit it to suit the laboratory, or write your own. All active staff will be notified in their inbox to open, read, and sign it.'}</p>
      {!editingId && <label style={{ display: 'block', marginBottom: 10 }}>Start from a template
        <select value={setupForm.templateKey} onChange={e => applyTemplate(e.target.value)} style={{ display: 'block', marginTop: 4 }}>
          <option value="">Blank / custom declaration</option>
          {templates.map(t => <option key={t.key} value={t.key}>{t.title}</option>)}
        </select>
      </label>}
      {can('organisation.structure', 'edit') && can('organisation.structure', 'create') && <form className="form-grid" onSubmit={submitSetup}>
        <label>Title<input value={setupForm.title} onChange={e => setSetupForm({ ...setupForm, title: e.target.value })} required placeholder="e.g. Declaration of Impartiality (2026)" /></label>
        <label>Type<select value={setupForm.formType} onChange={e => setSetupForm({ ...setupForm, formType: e.target.value })}>{FORM_TYPES.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}</select></label>
        <label>Version<input value={setupForm.version} onChange={e => setSetupForm({ ...setupForm, version: e.target.value })} /></label>
        <label>Effective date<input type="date" value={setupForm.effectiveDate} onChange={e => setSetupForm({ ...setupForm, effectiveDate: e.target.value })} /></label>
        <label>Review frequency (months)<input type="number" min={0} value={setupForm.reviewFrequencyMonths} onChange={e => setSetupForm({ ...setupForm, reviewFrequencyMonths: e.target.value })} /></label>
        <label>Next review date<input type="date" value={setupForm.nextReviewDate} onChange={e => setSetupForm({ ...setupForm, nextReviewDate: e.target.value })} /></label>
        <label style={{ gridColumn: '1 / -1' }}>Purpose / description<textarea value={setupForm.description} onChange={e => setSetupForm({ ...setupForm, description: e.target.value })} placeholder="What this declaration covers…" /></label>
        <label style={{ gridColumn: '1 / -1' }}>Declaration text
          <textarea value={setupForm.bodyContent} onChange={e => setSetupForm({ ...setupForm, bodyContent: e.target.value })} rows={14} style={{ width: '100%', fontFamily: 'inherit' }} placeholder="The declaration every member of staff will read and agree to…" />
        </label>
        <label style={{ gridColumn: '1 / -1' }}>Acknowledgement statement (shown when signing)<input value={setupForm.acknowledgementStatement} onChange={e => setSetupForm({ ...setupForm, acknowledgementStatement: e.target.value })} placeholder="I have read and understood this declaration and agree to be bound by it." /></label>
        <label><input type="checkbox" checked={setupForm.requiresAnnualReaffirmation} onChange={e => setSetupForm({ ...setupForm, requiresAnnualReaffirmation: e.target.checked })} /> Requires annual re-affirmation</label>
        <label>{editingId && selected?.file_id ? 'Replace form file (optional)' : 'Attach a form file (optional)'}<input type="file" accept=".pdf,.doc,.docx,.rtf,.odt,.txt" onChange={e => setUploadFile(e.target.files?.[0] ?? null)} /></label>
        <button type="submit" disabled={saving} style={{ gridColumn: '1 / -1' }}>{saving ? 'Saving…' : editingId ? 'Save changes' : 'Publish & notify all staff'}</button>
      </form>}
    </div>}

    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(300px, 380px) 1fr', gap: 16, alignItems: 'start', marginTop: 12 }}>
      <div>
        <div className="card" style={{ padding: 12 }}>
          <h4 style={{ marginTop: 0 }}>Declaration forms</h4>
          {forms.length === 0 ? <p className="muted">No declarations set up yet.</p> :
            <div style={{ maxHeight: '58vh', overflowY: 'auto', borderTop: '1px solid #e2e8f0' }}>
              {forms.map(f => {
                const isSelected = selected?.id === f.id;
                const signedByMe = !!f.my_signature;
                const total = f.total_staff || 1;
                const pct = Math.round((100 * (f.signature_count || 0)) / total);
                return <button key={f.id} type="button" onClick={() => openForm(f)}
                  style={{ display: 'block', width: '100%', textAlign: 'left', padding: '10px 12px', border: 'none', borderBottom: '1px solid #eef0f4', background: isSelected ? 'var(--accent-soft, #eef4ff)' : 'transparent', cursor: 'pointer' }}>
                  <div style={{ fontWeight: 600 }}>{f.title}</div>
                  <div style={{ fontSize: 11, color: '#64748b', marginTop: 3 }}>
                    {FORM_TYPES.find(t => t.key === f.form_type)?.label || f.form_type} · v{f.version || '—'}
                    {signedByMe ? <span className="badge" style={{ marginLeft: 6, background: '#dcfce7', color: '#166534' }}>signed</span> : <span className="badge" style={{ marginLeft: 6, background: '#fef3c7', color: '#92400e' }}>to sign</span>}
                  </div>
                  <div style={{ marginTop: 5, height: 5, background: '#e5e7eb', borderRadius: 3, overflow: 'hidden' }}>
                    <div style={{ width: `${pct}%`, height: '100%', background: pct >= 80 ? '#16a34a' : pct >= 40 ? '#f59e0b' : '#dc2626' }} />
                  </div>
                  <div style={{ fontSize: 10.5, color: '#64748b', marginTop: 2 }}>{f.signature_count} of {f.total_staff} signed ({pct}%)</div>
                </button>;
              })}
            </div>}
        </div>
      </div>

      <div>
        {!selected ? <div className="card" style={{ padding: 20 }}>
          <p className="muted">Select a declaration on the left to open, read and sign it.</p>
        </div> : <>
          <div className="card">
            <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 220 }}>
                <span className="hint">{FORM_TYPES.find(t => t.key === selected.form_type)?.label || selected.form_type}</span>
                <h3 style={{ margin: '2px 0 0' }}>{selected.title}</h3>
                <p className="muted" style={{ margin: 0, fontSize: 12 }}>v{selected.version || '—'} · effective {selected.effective_date || '—'} · issued by {selected.uploaded_by_name || '—'} on {String(selected.uploaded_at).slice(0, 10)}</p>
              </div>
              <button type="button" className="badge" onClick={() => void printDeclaration()} style={{ cursor: 'pointer' }}>🖨 Print</button>
              {selected.file_id && <a className="badge" onClick={() => void downloadFileById(selected.file_id!, selected.file_name || 'declaration')} style={{ cursor: 'pointer' }}>⬇ Download form</a>}
              {/* Manage is deliberately understated — a small ⋯ that reveals edit/delete.
                  It is not shown at all to somebody who may only read and sign. */}
              {(canEditForm || canDeleteForm) && <button type="button" title="Manage this declaration" aria-label="Manage this declaration" onClick={() => setShowManage(v => !v)}
                style={{ cursor: 'pointer', border: 'none', background: 'transparent', color: '#94a3b8', fontSize: 18, lineHeight: 1, padding: '0 6px' }}>⋯</button>}
            </div>
            {showManage && (canEditForm || canDeleteForm) && <div style={{ marginTop: 8, display: 'flex', gap: 8, justifyContent: 'flex-end', borderTop: '1px dashed #e2e8f0', paddingTop: 8 }}>
              {canEditForm && <button type="button" className="secondary" onClick={() => startEdit(selected)}>✎ Edit declaration</button>}
              {canDeleteForm && <button type="button" className="secondary" style={{ color: '#dc2626' }} onClick={() => void deleteDeclaration(selected)}>🗑 Delete declaration</button>}
            </div>}
            {selected.description && <p style={{ marginTop: 8 }}>{selected.description}</p>}
            {selected.body_content && <div style={{ whiteSpace: 'pre-wrap', marginTop: 10, lineHeight: 1.55, borderTop: '1px solid #e2e8f0', paddingTop: 10 }}>{selected.body_content}</div>}
            {selected.acknowledgement_statement && <p style={{ marginTop: 10, fontStyle: 'italic', borderLeft: '3px solid #94a3b8', paddingLeft: 10, color: '#475569' }}>{selected.acknowledgement_statement}</p>}
            {isFileOnly && (previewUrl && (selected.file_mime === 'application/pdf' || /\.pdf$/i.test(selected.file_name || ''))
              ? <iframe title="declaration" src={previewUrl} style={{ width: '100%', height: '60vh', border: '1px solid #cbd5e0', borderRadius: 6, marginTop: 10 }} />
              : isFileOnly && <p className="muted" style={{ marginTop: 10 }}>Preview not available — download the form to read it.</p>)}
          </div>

          {selected.my_signature ? <div className="card" style={{ marginTop: 12 }}>
            <h4 style={{ marginTop: 0 }}>Your acknowledgement</h4>
            <p>Signed on {String(selected.my_signature.signed_at).slice(0, 19).replace('T', ' ')}. {selected.my_signature.conflict_declared ? <strong style={{ color: '#dc2626' }}>Conflict declared.</strong> : 'No conflict declared.'}</p>
            {selected.my_signature.conflict_details && <p className="muted">Conflict details: {selected.my_signature.conflict_details}</p>}
            {selected.my_signature.signed_file_id && <p style={{ marginTop: 6 }}>Signed copy: <a onClick={() => void downloadFileById(selected.my_signature!.signed_file_id!, `signed-${selected.form_number || selected.id}`)} style={{ cursor: 'pointer', color: 'var(--accent, #2563eb)' }}>⬇ download your signed document</a></p>}
          </div> : <div className="card" style={{ marginTop: 12 }}>
            <h4 style={{ marginTop: 0 }}>Read &amp; sign your acknowledgement</h4>
            <p className="muted" style={{ marginTop: 0 }}>{selected.acknowledgement_statement || 'By signing you confirm you have read and understood this declaration and agree to be bound by it.'} Your signature is personal and cannot be delegated.</p>
            {isFileOnly && <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 6, padding: '10px 12px', margin: '8px 0', fontSize: 13 }}>
              <strong>This declaration is a form document.</strong> To sign it:
              <ol style={{ margin: '6px 0 0', paddingLeft: 20 }}>
                <li><a onClick={() => selected.file_id && void downloadFileById(selected.file_id, selected.file_name || 'declaration')} style={{ cursor: 'pointer', color: 'var(--accent, #2563eb)' }}>Download the form</a></li>
                <li>Print and sign it (or sign it electronically).</li>
                <li>Attach the signed copy below, then submit.</li>
              </ol>
            </div>}
            {can('organisation.structure', 'view') && <form onSubmit={signSelected}>
              {isFileOnly && <label style={{ display: 'block', margin: '6px 0' }}>Signed document (required)<input type="file" accept=".pdf,.doc,.docx,.rtf,.odt,.txt,.jpg,.jpeg,.png" onChange={e => setSignedFile(e.target.files?.[0] ?? null)} required /></label>}
              <label style={{ display: 'block', margin: '6px 0' }}>Affirmation (optional)<textarea value={signForm.affirmationText} onChange={e => setSignForm({ ...signForm, affirmationText: e.target.value })} placeholder="I have read, understood and agree to be bound by the terms of this declaration…" style={{ width: '100%' }} /></label>
              <label><input type="checkbox" checked={signForm.conflictDeclared} onChange={e => setSignForm({ ...signForm, conflictDeclared: e.target.checked })} /> I have a conflict of interest to declare</label>
              {signForm.conflictDeclared && <label style={{ display: 'block', margin: '6px 0' }}>Conflict details<textarea value={signForm.conflictDetails} onChange={e => setSignForm({ ...signForm, conflictDetails: e.target.value })} required style={{ width: '100%' }} /></label>}
              <label style={{ display: 'block', margin: '6px 0' }}>Notes (optional)<input value={signForm.notes} onChange={e => setSignForm({ ...signForm, notes: e.target.value })} /></label>
              <button type="submit" disabled={signing || (isFileOnly && !signedFile)}>{signing ? 'Submitting…' : isFileOnly ? '✔ Attach signed copy & record acknowledgement' : '✔ I have read & understood — Sign'}</button>
            </form>}
          </div>}

          <div className="card" style={{ marginTop: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h4 style={{ marginTop: 0, marginBottom: 0 }}>Signatures ({signatures.length})</h4>
              {signatures.length > 0 && <button type="button" className="badge" onClick={() => void printDeclaration()} style={{ cursor: 'pointer' }}>🖨 Print signed declaration</button>}
            </div>
            {signatures.length === 0 ? <p className="muted">No signatures yet.</p> :
              <table className="data-table" style={{ marginTop: 8 }}><thead><tr><th>#</th><th>Staff</th><th>Staff ID</th><th>Section</th><th>Signed on</th><th>Signature</th><th>Conflict</th>{isFileOnly && <th>Signed copy</th>}</tr></thead><tbody>
                {signatures.map((s, i) => <tr key={s.id}><td>{i + 1}</td><td>{s.staff_name || staffName(s.staff_id)}</td><td>{s.employee_no || '—'}</td><td>{s.section_name || '—'}</td><td>{String(s.signed_at).slice(0, 19).replace('T', ' ')}</td><td><SignatureImage staffId={s.staff_id} hasSignature={!!s.signature_file_id} name={s.staff_name || staffName(s.staff_id)} /></td><td>{s.conflict_declared ? <span style={{ color: '#dc2626' }}>Declared</span> : '—'}</td>{isFileOnly && <td>{s.signed_file_id ? <a onClick={() => void downloadFileById(s.signed_file_id!, s.signed_file_name || `signed-${i + 1}`)} style={{ cursor: 'pointer', color: 'var(--accent, #2563eb)' }}>⬇ {s.signed_file_name || 'download'}</a> : '—'}</td>}</tr>)}
              </tbody></table>}
          </div>
        </>}
      </div>
    </div>
  </div>;
}

// ============================================================================
// Organogram & Deputisation — reads the shared /organogram tree (owned by
// Settings → People & Access), then adds a documented continuity plan for
// every key position so absences never break the management system.
// ============================================================================
function OrganogramContinuityView({ staff, onError, onNotice }: { staff: Staff[]; onError: (m: string) => void; onNotice: (m: string) => void }) {
  const { can } = usePermissions();
  const [tree, setTree] = useState<OrgTree | null>(null);
  const [positions, setPositions] = useState<Position[]>([]);
  const [plans, setPlans] = useState<ContinuityPlan[]>([]);
  const [editingId, setEditingId] = useState<number | 'new' | null>(null);
  const emptyPlan = { positionId: '', keyRole: '', deputyPositionId: '', deputyStaffId: '', actingArrangement: '', authorityScope: '', handoverProcedure: '', activationTrigger: '', trainingStatus: 'in_progress', lastTestedDate: '', nextReviewDate: '', status: 'active', notes: '' };
  const [form, setForm] = useState(emptyPlan);

  async function load() {
    try {
      const [t, p, pl] = await Promise.all([
        api<OrgTree>('/organogram/tree').catch(() => ({ roots: [] })),
        api<Position[]>('/positions').catch(() => []),
        api<ContinuityPlan[]>('/organisation/continuity-plans').catch(() => []),
      ]);
      setTree(t); setPositions(p); setPlans(pl);
    } catch (e) { onError((e as Error).message); }
  }
  useEffect(() => { void load(); }, []);

  function startNew() { setForm(emptyPlan); setEditingId('new'); }
  function startEdit(plan: ContinuityPlan) {
    setForm({
      positionId: plan.position_id ? String(plan.position_id) : '',
      keyRole: plan.key_role, deputyPositionId: plan.deputy_position_id ? String(plan.deputy_position_id) : '',
      deputyStaffId: plan.deputy_staff_id ? String(plan.deputy_staff_id) : '',
      actingArrangement: plan.acting_arrangement || '', authorityScope: plan.authority_scope || '',
      handoverProcedure: plan.handover_procedure || '', activationTrigger: plan.activation_trigger || '',
      trainingStatus: plan.training_status || 'in_progress', lastTestedDate: plan.last_tested_date || '',
      nextReviewDate: plan.next_review_date || '', status: plan.status || 'active', notes: plan.notes || '',
    });
    setEditingId(plan.id);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      if (editingId === 'new') await api('/organisation/continuity-plans', { method: 'POST', body: JSON.stringify(form) });
      else if (editingId) await api(`/organisation/continuity-plans/${editingId}`, { method: 'PUT', body: JSON.stringify(form) });
      setEditingId(null); setForm(emptyPlan);
      await load(); onNotice('Continuity plan saved.');
    } catch (err) { onError((err as Error).message); }
  }

  async function removePlan(id: number) {
    if (!confirm('Delete this continuity plan?')) return;
    try { await api(`/organisation/continuity-plans/${id}`, { method: 'DELETE' }); await load(); onNotice('Plan deleted.'); }
    catch (err) { onError((err as Error).message); }
  }

  const staffName = (id?: number | null) => staff.find(s => s.id === id)?.fullName || '—';
  const positionTitle = (id?: number | null) => positions.find(p => p.id === id)?.title || '—';

  // Flatten the org tree into a simple list of position rows with deputies.
  const flatten = (nodes: any[]): Array<{ id: number; title: string; holderName?: string; deputyName?: string | null; actingName?: string | null; roleType?: string }> => {
    const out: any[] = [];
    const walk = (list: any[]) => { for (const n of list) { if (n.kind === 'position') out.push(n); if (n.children) walk(n.children); } };
    walk(nodes || []);
    return out;
  };
  const positionsList = tree ? flatten(tree.roots) : [];

  return <div>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <div>
        <h3 style={{ margin: 0 }}>Organogram &amp; Deputisation</h3>
        <p className="muted" style={{ margin: 0, fontSize: 12 }}>Reads live from Settings → People &amp; Access. Any organogram or deputy change made there appears here (and vice versa). Continuity plans below cover the absence of key personnel so the management system keeps running.</p>
      </div>
      <Link to="/settings/people" className="secondary" style={{ padding: '6px 10px', borderRadius: 6, background: '#f1f5f9', color: '#334155', textDecoration: 'none' }}>Edit organogram in Settings →</Link>
    </div>

    <div className="card" style={{ marginTop: 12 }}>
      <h4 style={{ marginTop: 0 }}>Current organogram &amp; deputies</h4>
      {positionsList.length === 0 ? <p className="muted">No positions on the organogram yet. Add positions in Settings → People &amp; Access.</p> :
        <table className="data-table">
          <thead><tr><th>Position</th><th>Holder</th><th>Deputy</th><th>Acting (next in command)</th><th>Continuity plan</th></tr></thead>
          <tbody>
            {positionsList.map(p => {
              const plan = plans.find(pl => pl.position_id === p.id);
              return <tr key={p.id}>
                <td>{p.title}</td>
                <td>{p.holderName || <span className="muted">Vacant</span>}</td>
                <td>{p.deputyName || <span className="muted">—</span>}</td>
                <td>{p.actingName || p.deputyName || <span className="muted">—</span>}</td>
                <td>{plan ? <span className="badge" style={{ background: '#dcfce7', color: '#166534' }}>Documented</span> : <button className="secondary" onClick={() => { setForm({ ...emptyPlan, positionId: String(p.id), keyRole: p.title }); setEditingId('new'); }}>Document</button>}</td>
              </tr>;
            })}
          </tbody>
        </table>}
    </div>

    <div className="card" style={{ marginTop: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <h4 style={{ margin: 0 }}>Continuity plans</h4>
        <button onClick={startNew}>＋ Add continuity plan</button>
      </div>
      <p className="muted" style={{ marginTop: 6, fontSize: 12 }}>Document how the laboratory continues to operate if a key member of staff is absent. Each plan identifies the deputy, their authority, and the handover procedure.</p>
      {plans.length === 0 ? <p className="muted">No continuity plans documented yet.</p> :
        <table className="data-table">
          <thead><tr><th>Plan #</th><th>Key role</th><th>Position</th><th>Deputy position</th><th>Deputy staff</th><th>Training</th><th>Last tested</th><th>Next review</th><th></th></tr></thead>
          <tbody>
            {plans.map(p => <tr key={p.id}>
              <td>{p.plan_number}</td>
              <td>{p.key_role}</td>
              <td>{p.position_title || positionTitle(p.position_id)}</td>
              <td>{p.deputy_position_title || positionTitle(p.deputy_position_id)}</td>
              <td>{p.deputy_name || staffName(p.deputy_staff_id)}</td>
              <td>{formatBadge(p.training_status)}</td>
              <td>{p.last_tested_date || '—'}</td>
              <td>{p.next_review_date || '—'}</td>
              <td>
                <button className="link-btn" onClick={() => startEdit(p)}>Edit</button>{' '}
                {can('organisation.structure', 'edit') && <button className="link-btn" style={{ color: '#dc2626' }} onClick={() => removePlan(p.id)}>Delete</button>}
              </td>
            </tr>)}
          </tbody>
        </table>}
    </div>

    {editingId !== null && <div className="doc-drawer-overlay" onClick={() => setEditingId(null)}>
      <div className="doc-drawer" onClick={e => e.stopPropagation()}>
        <div className="doc-drawer-panel">
          <div className="doc-drawer-head">
            <h3 style={{ margin: 0 }}>{editingId === 'new' ? 'New continuity plan' : `Edit continuity plan`}</h3>
            <button className="drawer-close" onClick={() => setEditingId(null)}>×</button>
          </div>
          <div className="doc-drawer-body">
            {can('organisation.budget', 'edit') && can('organisation.budget', 'create') && <form className="form-grid" onSubmit={submit}>
              <label>Key role<input value={form.keyRole} onChange={e => setForm({ ...form, keyRole: e.target.value })} required placeholder="e.g. Laboratory Manager" /></label>
              <label>Position<select value={form.positionId} onChange={e => setForm({ ...form, positionId: e.target.value })}><option value="">—</option>{positions.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}</select></label>
              <label>Deputy position<select value={form.deputyPositionId} onChange={e => setForm({ ...form, deputyPositionId: e.target.value })}><option value="">—</option>{positions.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}</select></label>
              <label>Deputy staff (specific person)<select value={form.deputyStaffId} onChange={e => setForm({ ...form, deputyStaffId: e.target.value })}><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
              <label>Activation trigger<textarea value={form.activationTrigger} onChange={e => setForm({ ...form, activationTrigger: e.target.value })} placeholder="Circumstances that trigger the plan (planned leave, illness, emergency)" /></label>
              <label>Acting arrangement<textarea value={form.actingArrangement} onChange={e => setForm({ ...form, actingArrangement: e.target.value })} placeholder="Who acts, how they are informed, expected duration…" /></label>
              <label>Authority scope<textarea value={form.authorityScope} onChange={e => setForm({ ...form, authorityScope: e.target.value })} placeholder="Which decisions the acting person may make, and which must escalate" /></label>
              <label>Handover procedure<textarea value={form.handoverProcedure} onChange={e => setForm({ ...form, handoverProcedure: e.target.value })} placeholder="Briefing steps, key documents, ongoing NCs / risks, active reviews" /></label>
              <label>Training status<select value={form.trainingStatus} onChange={e => setForm({ ...form, trainingStatus: e.target.value })}><option value="ready">Ready</option><option value="in_progress">In progress</option><option value="not_ready">Not ready</option></select></label>
              <label>Last tested date<input type="date" value={form.lastTestedDate} onChange={e => setForm({ ...form, lastTestedDate: e.target.value })} /></label>
              <label>Next review date<input type="date" value={form.nextReviewDate} onChange={e => setForm({ ...form, nextReviewDate: e.target.value })} /></label>
              <label>Status<select value={form.status} onChange={e => setForm({ ...form, status: e.target.value })}><option value="active">Active</option><option value="retired">Retired</option></select></label>
              <label>Notes<textarea value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} /></label>
              <button type="submit">Save plan</button>
            </form>}
          </div>
        </div>
      </div>
    </div>}
  </div>;
}

// ============================================================================
// Budgetary Projection — plans across personnel, scope of test, infrastructure,
// equipment, service & maintenance, quality assurance and materials (IQC/EQA).
// ============================================================================
function BudgetProjectionView({ staff, onError, onNotice }: { staff: Staff[]; onError: (m: string) => void; onNotice: (m: string) => void }) {
  const { can } = usePermissions();
  const currentYear = String(new Date().getFullYear());
  const [year, setYear] = useState(currentYear);
  const [rows, setRows] = useState<BudgetProjection[]>([]);
  const [breakdown, setBreakdown] = useState<{ totals: Record<string, number>; grand: number } | null>(null);
  const emptyForm = { fiscalYear: currentYear, scope: 'personnel', category: '', description: '', quantity: '', unitCost: '', projectedAmount: '', currency: 'GHS', responsibleStaffId: '', justification: '', status: 'draft' };
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState<number | null>(null);

  async function load() {
    try {
      const [b, br] = await Promise.all([
        api<BudgetProjection[]>('/organisation/budget'),
        api<{ rows: any[]; totals: Record<string, number>; grand: number }>(`/organisation/budget/breakdown?year=${year}`).catch(() => null),
      ]);
      setRows(b);
      if (br) setBreakdown({ totals: br.totals, grand: br.grand });
    } catch (e) { onError((e as Error).message); }
  }
  useEffect(() => { void load(); }, [year]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const qty = form.quantity ? Number(form.quantity) : null;
    const unit = form.unitCost ? Number(form.unitCost) : null;
    const total = form.projectedAmount ? Number(form.projectedAmount) : (qty && unit ? qty * unit : null);
    const payload = { ...form, projectedAmount: total };
    try {
      if (editingId) await api(`/organisation/budget/${editingId}`, { method: 'PUT', body: JSON.stringify(payload) });
      else await api('/organisation/budget', { method: 'POST', body: JSON.stringify(payload) });
      setForm({ ...emptyForm, fiscalYear: year });
      setEditingId(null);
      await load();
      onNotice('Budget line saved.');
    } catch (err) { onError((err as Error).message); }
  }

  function edit(r: BudgetProjection) {
    setForm({
      fiscalYear: r.fiscal_year || year,
      scope: (r as any).scope || 'personnel',
      category: r.category || '', description: r.description || '',
      quantity: (r as any).quantity != null ? String((r as any).quantity) : '',
      unitCost: (r as any).unit_cost != null ? String((r as any).unit_cost) : '',
      projectedAmount: r.projected_amount != null ? String(r.projected_amount) : '',
      currency: r.currency || 'GHS',
      responsibleStaffId: r.responsible_staff_id ? String(r.responsible_staff_id) : '',
      justification: (r as any).justification || '',
      status: r.status,
    });
    setEditingId(r.id);
  }

  const yearRows = rows.filter(r => r.fiscal_year === year);
  const grand = breakdown?.grand ?? yearRows.reduce((s, r) => s + (r.projected_amount || 0), 0);
  const years = Array.from(new Set(rows.map(r => r.fiscal_year).filter(Boolean))).sort().reverse();

  const staffName = (id?: number | null) => staff.find(s => s.id === id)?.fullName || '—';

  return <div>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <div>
        <h3 style={{ margin: 0 }}>Budgetary Projection</h3>
        <p className="muted" style={{ margin: 0, fontSize: 12 }}>Plan across personnel needs, scope of tests, infrastructure, equipment, service &amp; maintenance, quality assurance (IQC / EQA) and materials.</p>
      </div>
      <label>Fiscal year&nbsp;<input type="number" value={year} onChange={e => setYear(e.target.value)} style={{ width: 100 }} />&nbsp;
        {years.length > 0 && <select value={year} onChange={e => setYear(e.target.value)}><option value={currentYear}>{currentYear}</option>{years.map(y => <option key={y} value={y}>{y}</option>)}</select>}
      </label>
    </div>

    {breakdown && <div style={{ marginTop: 10 }}>
      <KpiStrip items={BUDGET_SCOPES.filter(s => (breakdown.totals[s.key] || 0) > 0).map(s => ({
        label: s.label, value: Math.round(breakdown.totals[s.key] || 0).toLocaleString(),
      }))} />
    </div>}

    <div className="card" style={{ marginTop: 12 }}>
      <h4 style={{ marginTop: 0 }}>{editingId ? 'Edit budget line' : 'Add budget line'}</h4>
      {can('organisation.budget', 'edit') && can('organisation.budget', 'create') && <form className="form-grid" onSubmit={submit}>
        <label>Fiscal year<input value={form.fiscalYear} onChange={e => setForm({ ...form, fiscalYear: e.target.value })} required /></label>
        <label>Scope<select value={form.scope} onChange={e => setForm({ ...form, scope: e.target.value })}>{BUDGET_SCOPES.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}</select></label>
        <label>Category / line item<input value={form.category} onChange={e => setForm({ ...form, category: e.target.value })} placeholder="e.g. Full-Time Scientist, Analyzer maintenance" /></label>
        <label>Quantity<input type="number" step="0.01" value={form.quantity} onChange={e => setForm({ ...form, quantity: e.target.value })} /></label>
        <label>Unit cost<input type="number" step="0.01" value={form.unitCost} onChange={e => setForm({ ...form, unitCost: e.target.value })} /></label>
        <label>Projected total<input type="number" step="0.01" value={form.projectedAmount} onChange={e => setForm({ ...form, projectedAmount: e.target.value })} /></label>
        <label>Currency<input value={form.currency} onChange={e => setForm({ ...form, currency: e.target.value })} /></label>
        <label>Responsible<select value={form.responsibleStaffId} onChange={e => setForm({ ...form, responsibleStaffId: e.target.value })}><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
        <label>Status<select value={form.status} onChange={e => setForm({ ...form, status: e.target.value })}>{['draft', 'submitted', 'approved', 'closed', 'rejected'].map(s => <option key={s} value={s}>{pretty(s)}</option>)}</select></label>
        <label>Description<textarea value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} /></label>
        <label>Justification<textarea value={form.justification} onChange={e => setForm({ ...form, justification: e.target.value })} placeholder="ISO-aligned justification — why the item is needed" /></label>
        <button type="submit">{editingId ? 'Save changes' : 'Add line'}</button>
        {editingId && <button type="button" className="secondary" onClick={() => { setEditingId(null); setForm({ ...emptyForm, fiscalYear: year }); }}>Cancel</button>}
      </form>}
    </div>

    <div className="card" style={{ marginTop: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h4 style={{ margin: 0 }}>Register for {year}</h4>
        <div style={{ fontWeight: 700 }}>Grand total: {form.currency} {Math.round(grand).toLocaleString()}</div>
      </div>
      {yearRows.length === 0 ? <p className="muted">No budget lines for {year} yet.</p> :
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <thead><tr><th>No.</th><th>Scope</th><th>Category</th><th>Description</th><th>Qty</th><th>Unit cost</th><th>Total</th><th>Responsible</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {BUDGET_SCOPES.map(s => {
                const scopeRows = yearRows.filter(r => ((r as any).scope || 'other') === s.key);
                if (scopeRows.length === 0) return null;
                const scopeTotal = scopeRows.reduce((n, r) => n + (r.projected_amount || 0), 0);
                return [
                  <tr key={`h-${s.key}`} style={{ background: '#f8fafc' }}>
                    <td colSpan={6} style={{ fontWeight: 700, color: '#1B3A6B' }}>{s.label}</td>
                    <td style={{ fontWeight: 700 }}>{Math.round(scopeTotal).toLocaleString()}</td>
                    <td colSpan={3} />
                  </tr>,
                  ...scopeRows.map(r => <tr key={r.id}>
                    <td>{r.projection_number}</td>
                    <td>{s.label}</td>
                    <td>{r.category || '—'}</td>
                    <td>{r.description || '—'}</td>
                    <td>{(r as any).quantity != null ? (r as any).quantity : '—'}</td>
                    <td>{(r as any).unit_cost != null ? (r as any).unit_cost : '—'}</td>
                    <td>{r.projected_amount != null ? `${r.currency || ''} ${r.projected_amount.toLocaleString()}` : '—'}</td>
                    <td>{staffName(r.responsible_staff_id)}</td>
                    <td>{formatBadge(r.status)}</td>
                    <td><button className="link-btn" onClick={() => edit(r)}>Edit</button></td>
                  </tr>),
                ];
              })}
            </tbody>
          </table>
        </div>}
    </div>
  </div>;
}

// ============================================================================
// Quality & Technical Records Review — a mini-audit workspace pulling data
// from every quality/technical module in the system for the configured review
// frequency, letting the reviewer document findings and raise NC / CAPA.
// ============================================================================
function QtRecordsReviewView({ staff, onError, onNotice }: { staff: Staff[]; onError: (m: string) => void; onNotice: (m: string) => void }) {
  const { can } = usePermissions();
  const [sub, setSub] = useState('Configuration');
  const [configs, setConfigs] = useState<QtReviewConfig[]>([]);
  const [reviews, setReviews] = useState<QtReview[]>([]);
  const [selectedArea, setSelectedArea] = useState<string>('previous_actions');
  const [period, setPeriod] = useState({ start: new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10), end: new Date().toISOString().slice(0, 10) });
  const [data, setData] = useState<any>(null);
  const [dataBusy, setDataBusy] = useState(false);
  const [reviewForm, setReviewForm] = useState({ findings: '', recurrentProblems: '', actionsPlanned: '', followUpDueDate: '', followUpStatus: 'pending', nextReviewDue: '', status: 'draft' });

  async function load() {
    try {
      const [c, r] = await Promise.all([
        api<QtReviewConfig[]>('/organisation/qt-reviews/configs'),
        api<QtReview[]>('/organisation/qt-reviews'),
      ]);
      setConfigs(c); setReviews(r);
    } catch (e) { onError((e as Error).message); }
  }
  useEffect(() => { void load(); }, []);

  async function fetchArea() {
    setDataBusy(true);
    try {
      const d = await api(`/organisation/qt-reviews/data/${selectedArea}?periodStart=${period.start}&periodEnd=${period.end}`);
      setData(d);
    } catch (e) { onError((e as Error).message); }
    finally { setDataBusy(false); }
  }
  useEffect(() => { if (sub === 'Run Review') void fetchArea(); }, [selectedArea, period.start, period.end, sub]);

  async function updateConfig(cfg: QtReviewConfig, patch: Partial<QtReviewConfig>) {
    try {
      await api(`/organisation/qt-reviews/configs/${cfg.area_key}`, { method: 'PUT', body: JSON.stringify(patch) });
      await load(); onNotice('Frequency updated.');
    } catch (err) { onError((err as Error).message); }
  }

  async function submitReview(e: FormEvent) {
    e.preventDefault();
    try {
      await api('/organisation/qt-reviews', {
        method: 'POST',
        body: JSON.stringify({
          areaKey: selectedArea, periodStart: period.start, periodEnd: period.end,
          dataSnapshot: data ?? null, ...reviewForm,
        }),
      });
      setReviewForm({ findings: '', recurrentProblems: '', actionsPlanned: '', followUpDueDate: '', followUpStatus: 'pending', nextReviewDue: '', status: 'draft' });
      await load(); onNotice('Review recorded.');
    } catch (err) { onError((err as Error).message); }
  }

  async function raiseNc() {
    if (!reviewForm.findings) { onError('Enter the finding first, then raise the NC.'); return; }
    try {
      const area = configs.find(c => c.area_key === selectedArea)?.area_label || selectedArea;
      await api('/nonconformities', {
        method: 'POST',
        body: JSON.stringify({
          eventDate: new Date().toISOString().slice(0, 10), title: `QT Review — ${area}`,
          description: reviewForm.findings, sourceModule: 'organisation',
          category: 'system_review', severity: 'medium',
        }),
      });
      onNotice('Nonconforming event raised from this review. Head to NC/CAPA to assign and follow up.');
    } catch (err) { onError((err as Error).message); }
  }

  const staffName = (id?: number | null) => staff.find(s => s.id === id)?.fullName || '—';
  const areaConfig = configs.find(c => c.area_key === selectedArea);

  return <div>
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <div>
        <h3 style={{ margin: 0 }}>Quality &amp; Technical Records Review</h3>
        <p className="muted" style={{ margin: 0, fontSize: 12 }}>Routine documented review of every quality &amp; technical record — pulls live data from all modules, records findings, and raises follow-up actions.</p>
      </div>
    </div>

    {tabBar(sub, ['Configuration', 'Run Review', 'Review History'], setSub)}

    {sub === 'Configuration' && <div className="card">
      <h4 style={{ marginTop: 0 }}>Review frequencies</h4>
      <p className="muted" style={{ marginTop: 0 }}>Configure how often each area is reviewed. The schedule drives the &ldquo;Next review&rdquo; column and the review calendar.</p>
      <table className="data-table">
        <thead><tr><th>Area</th><th>Frequency</th><th>Responsible</th><th>Last review</th><th>Next review</th><th>Active</th></tr></thead>
        <tbody>
          {configs.map(c => <tr key={c.id}>
            <td>{c.area_label}</td>
            <td><select value={c.frequency} onChange={e => updateConfig(c, { frequency: e.target.value })}>
              {['daily', 'weekly', 'monthly', 'quarterly', 'biannual', 'annual'].map(f => <option key={f} value={f}>{f}</option>)}
            </select></td>
            <td><select value={c.responsible_staff_id || ''} onChange={e => updateConfig(c, { responsible_staff_id: e.target.value ? Number(e.target.value) : null })}>
              <option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}
            </select></td>
            <td>{c.last_review_date || '—'}</td>
            <td><input type="date" value={c.next_review_date || ''} onChange={e => updateConfig(c, { next_review_date: e.target.value })} /></td>
            <td><input type="checkbox" checked={!!c.is_active} onChange={e => updateConfig(c, { is_active: e.target.checked ? 1 : 0 })} /></td>
          </tr>)}
        </tbody>
      </table>
    </div>}

    {sub === 'Run Review' && <>
      <div className="card">
        <div className="form-grid">
          <label>Area to review<select value={selectedArea} onChange={e => setSelectedArea(e.target.value)}>
            {configs.map(c => <option key={c.area_key} value={c.area_key}>{c.area_label}</option>)}
          </select></label>
          <label>Period start<input type="date" value={period.start} onChange={e => setPeriod({ ...period, start: e.target.value })} /></label>
          <label>Period end<input type="date" value={period.end} onChange={e => setPeriod({ ...period, end: e.target.value })} /></label>
        </div>
        {areaConfig && <p className="muted" style={{ marginTop: 6, fontSize: 12 }}>Reviewed {areaConfig.frequency}{areaConfig.responsible_name ? ` by ${areaConfig.responsible_name}` : ''} · Last review: {areaConfig.last_review_date || '—'}</p>}
      </div>

      <div className="card" style={{ marginTop: 10 }}>
        <h4 style={{ marginTop: 0 }}>Live data</h4>
        {dataBusy ? <p className="muted">Loading data…</p> : data ? <QtReviewData areaKey={selectedArea} data={data} /> : <p className="muted">No data pulled yet.</p>}
      </div>

      <div className="card" style={{ marginTop: 10 }}>
        <h4 style={{ marginTop: 0 }}>Document the review</h4>
        {can('organisation.records_review', 'create') && <form onSubmit={submitReview}>
          <div className="form-grid">
            <label>Findings<textarea value={reviewForm.findings} onChange={e => setReviewForm({ ...reviewForm, findings: e.target.value })} placeholder="What did the review find?" required /></label>
            <label>Recurrent problems<textarea value={reviewForm.recurrentProblems} onChange={e => setReviewForm({ ...reviewForm, recurrentProblems: e.target.value })} placeholder="Any recurring issues?" /></label>
            <label>Actions planned<textarea value={reviewForm.actionsPlanned} onChange={e => setReviewForm({ ...reviewForm, actionsPlanned: e.target.value })} placeholder="What will you do about it?" /></label>
            <label>Follow-up due<input type="date" value={reviewForm.followUpDueDate} onChange={e => setReviewForm({ ...reviewForm, followUpDueDate: e.target.value })} /></label>
            <label>Follow-up status<select value={reviewForm.followUpStatus} onChange={e => setReviewForm({ ...reviewForm, followUpStatus: e.target.value })}><option value="not_required">Not required</option><option value="pending">Pending</option><option value="in_progress">In progress</option><option value="completed">Completed</option></select></label>
            <label>Next review due<input type="date" value={reviewForm.nextReviewDue} onChange={e => setReviewForm({ ...reviewForm, nextReviewDue: e.target.value })} /></label>
            <label>Status<select value={reviewForm.status} onChange={e => setReviewForm({ ...reviewForm, status: e.target.value })}><option value="draft">Draft</option><option value="completed">Completed</option><option value="followed_up">Followed up</option></select></label>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            <button type="submit">Save review</button>
            {can('nc_capa', 'create') && <button type="button" className="secondary" onClick={raiseNc}>Raise NC from finding</button>}
          </div>
        </form>}
      </div>
    </>}

    {sub === 'Review History' && <div className="card">
      <h4 style={{ marginTop: 0 }}>Review history</h4>
      {reviews.length === 0 ? <p className="muted">No reviews recorded yet.</p> :
        <table className="data-table">
          <thead><tr><th>Review #</th><th>Area</th><th>Period</th><th>Status</th><th>Follow-up</th><th>Reviewer</th><th>Recorded</th></tr></thead>
          <tbody>
            {reviews.map(r => <tr key={r.id}>
              <td>{r.review_number}</td>
              <td>{configs.find(c => c.area_key === r.area_key)?.area_label || r.area_key}</td>
              <td>{r.period_start} → {r.period_end}</td>
              <td>{formatBadge(r.status)}</td>
              <td>{formatBadge(r.follow_up_status)}{r.follow_up_due_date ? ` · ${r.follow_up_due_date}` : ''}</td>
              <td>{r.reviewer_name || staffName(r.reviewed_by_staff_id)}</td>
              <td>{String(r.created_at).slice(0, 10)}</td>
            </tr>)}
          </tbody>
        </table>}
    </div>}
  </div>;
}

function QtReviewData({ areaKey, data }: { areaKey: string; data: any }) {
  const dataAreas = useMemo(() => Object.keys(data || {}).filter(k => Array.isArray(data[k])), [data]);
  if (dataAreas.length === 0) return <p className="muted">No records were found in this period.</p>;
  return <>
    {dataAreas.map(key => <div key={key} style={{ marginBottom: 10 }}>
      <h5 style={{ margin: '6px 0' }}>{key.replace(/_/g, ' ')} — {data[key].length} record(s)</h5>
      {data[key].length > 0 && <div style={{ overflowX: 'auto' }}>
        <table className="data-table">
          <thead><tr>{Object.keys(data[key][0]).slice(0, 8).map(k => <th key={k}>{k}</th>)}</tr></thead>
          <tbody>
            {data[key].slice(0, 30).map((row: any, i: number) => <tr key={i}>{Object.keys(data[key][0]).slice(0, 8).map(k => <td key={k} style={{ fontSize: 11 }}>{row[k] == null ? '—' : String(row[k])}</td>)}</tr>)}
          </tbody>
        </table>
        {data[key].length > 30 && <div className="muted" style={{ fontSize: 11 }}>Showing first 30 of {data[key].length}.</div>}
      </div>}
    </div>)}
  </>;
}
