import { FormEvent, useEffect, useState } from 'react';
import PageHeader from '../components/ui/PageHeader';
import { KpiStrip, ChartCard, DonutChart, BarMeter, CHART_COLORS } from '../components/ui';
import { useModules } from '../hooks/useModules';
import { api } from '../services/api';
import DisabledModule from '../components/DisabledModule';
import { MeetingsPage, ManagementReviewPage } from './Phase8Pages';
import { Link } from 'react-router-dom';
import type { Staff, CodeOfConductRecord, BudgetProjection, OrganisationSummary, RegulatoryRegistration, LaboratoryConfig } from '../../shared/types/api';

const statusBadgeClass = (status?: string) => `badge ${status ? status.toLowerCase().replace(/\s+/g, '-') : 'unknown'}`;
const formatBadge = (status?: string) => <span className={statusBadgeClass(status)}>{status ? status.replace(/_/g, ' ') : 'Unknown'}</span>;
const tabBar = (active: string, tabs: string[], onChange: (name: string) => void) =>
  <div className="tabs">{tabs.map(name => <button key={name} type="button" className={active === name ? 'active' : ''} onClick={() => onChange(name)}>{name}</button>)}</div>;
const pretty = (s?: string) => s ? s.replace(/_/g, ' ') : '—';

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

const COMMITMENT_TYPES = ['all', 'impartiality', 'confidentiality', 'conflict_of_interest', 'code_adherence'];
const BUDGET_CATEGORIES = ['personnel', 'equipment', 'maintenance', 'reagents_consumables', 'quality_assurance', 'infrastructure', 'training', 'other'];

export function OrganisationPage() {
  const { isEnabled } = useModules();
  const [tab, setTab] = useState('Dashboard');
  const [error, setError] = useState<string | null>(null);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [summary, setSummary] = useState<OrganisationSummary | null>(null);
  const [conduct, setConduct] = useState<CodeOfConductRecord[]>([]);
  const [budget, setBudget] = useState<BudgetProjection[]>([]);
  const [registrations, setRegistrations] = useState<RegulatoryRegistration[]>([]);
  const [config, setConfig] = useState<LaboratoryConfig | null>(null);

  const [cocForm, setCocForm] = useState({ staffId: '', commitmentType: 'all', statement: '', signedDate: '', reviewDate: '', conflictDeclared: false, conflictDetails: '' });
  const [budForm, setBudForm] = useState({ fiscalYear: String(new Date().getFullYear()), category: '', description: '', projectedAmount: '', currency: 'GHS', responsibleStaffId: '', status: 'draft' });
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
  if (!isEnabled('organisation')) return <DisabledModule />;

  const staffName = (id?: number) => staff.find(s => s.id === id)?.fullName || '—';

  async function submitCoc(e: FormEvent) {
    e.preventDefault(); setError(null);
    try { await api('/organisation/code-of-conduct', { method: 'POST', body: JSON.stringify(cocForm) }); setCocForm({ staffId: '', commitmentType: 'all', statement: '', signedDate: '', reviewDate: '', conflictDeclared: false, conflictDetails: '' }); await load(); }
    catch (e) { setError((e as Error).message); }
  }
  async function submitBud(e: FormEvent) {
    e.preventDefault(); setError(null);
    try { await api('/organisation/budget', { method: 'POST', body: JSON.stringify(budForm) }); setBudForm({ fiscalYear: String(new Date().getFullYear()), category: '', description: '', projectedAmount: '', currency: 'GHS', responsibleStaffId: '', status: 'draft' }); await load(); }
    catch (e) { setError((e as Error).message); }
  }
  async function submitReg(e: FormEvent) {
    e.preventDefault(); setError(null);
    try { await api('/organisation/registrations', { method: 'POST', body: JSON.stringify(regForm) }); setRegForm({ credentialType: '', title: '', issuingBody: '', reference: '', issueDate: '', expiryDate: '', responsibleStaffId: '', status: 'active' }); await load(); }
    catch (e) { setError((e as Error).message); }
  }

  const budgetByCategory = BUDGET_CATEGORIES.map((c, i) => ({
    label: pretty(c),
    value: budget.filter(b => b.category === c).reduce((s, b) => s + (b.projected_amount || 0), 0),
    color: CHART_COLORS[i % CHART_COLORS.length],
    onClick: () => setTab('Budget Projection'),
  })).filter(d => d.value > 0);

  return <div className="module-page">
    <PageHeader eyebrow="Organisation and Leadership" title="Organisation &amp; Leadership" subtitle="Leadership commitments, code of conduct, and budget planning." />
    {tabBar(tab, ['Dashboard', 'Quality Configuration', 'Code of Conduct', 'Budget Projection', 'Registrations & Licences',
      ...(isEnabled('meetings') ? ['Meetings'] : []), ...(isEnabled('management_review') ? ['Management Review'] : [])], setTab)}
    {error && <div className="error">{error}</div>}

    {tab === 'Quality Configuration' && <QualityConfigurationView config={config} />}

    {tab === 'Dashboard' && <><KpiStrip items={[
      { label: 'Code-of-conduct records', value: summary?.codeOfConductRecords ?? conduct.length, onClick: () => setTab('Code of Conduct') },
      { label: 'Due review', value: summary?.codeOfConductDueReview ?? 0, tone: (summary?.codeOfConductDueReview ?? 0) ? 'warning' : undefined, onClick: () => setTab('Code of Conduct') },
      { label: 'Declared conflicts', value: summary?.declaredConflicts ?? 0, tone: (summary?.declaredConflicts ?? 0) ? 'danger' : undefined, onClick: () => setTab('Code of Conduct') },
      { label: 'Budget lines (year)', value: summary?.budgetLinesCurrentYear ?? 0, onClick: () => setTab('Budget Projection') },
      { label: 'Budget total (year)', value: summary ? Math.round(summary.budgetTotalCurrentYear).toLocaleString() : 0, onClick: () => setTab('Budget Projection') },
      { label: 'Registrations', value: summary?.activeRegistrations ?? 0, onClick: () => setTab('Registrations & Licences') },
      { label: 'Expiring soon', value: summary?.registrationsExpiringSoon ?? 0, tone: (summary?.registrationsExpiringSoon ?? 0) ? 'warning' : undefined, onClick: () => setTab('Registrations & Licences') },
      { label: 'Expired', value: summary?.registrationsExpired ?? 0, tone: (summary?.registrationsExpired ?? 0) ? 'danger' : undefined, onClick: () => setTab('Registrations & Licences') },
    ]} />
    <div className="grid cols-2 dash-charts" style={{ marginTop: 18 }}>
      <ChartCard title="Budget by category" subtitle="Projected amounts, current fiscal year">
        <DonutChart centerLabel="Categories" data={budgetByCategory} />
      </ChartCard>
      <ChartCard title="Code of conduct" subtitle="Adherence and conflict declarations">
        <BarMeter data={[
          { label: 'Active records', value: summary?.codeOfConductRecords ?? conduct.length, color: CHART_COLORS[1], onClick: () => setTab('Code of Conduct') },
          { label: 'Due review', value: summary?.codeOfConductDueReview ?? 0, color: CHART_COLORS[2], onClick: () => setTab('Code of Conduct') },
          { label: 'Declared conflicts', value: summary?.declaredConflicts ?? 0, color: CHART_COLORS[3], onClick: () => setTab('Code of Conduct') },
        ]} />
      </ChartCard>
    </div></>}

    {tab === 'Code of Conduct' && <>
      <div className="card">
        <h3>Record code-of-conduct commitment</h3>
        <p className="muted" style={{ marginTop: 0 }}>Captures each member's commitment to impartiality, confidentiality, conflict-of-interest disclosure and the code of conduct.</p>
        <form className="form-grid" onSubmit={submitCoc}>
          <label>Staff<select value={cocForm.staffId} onChange={e => setCocForm({ ...cocForm, staffId: e.target.value })}><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
          <label>Commitment<select value={cocForm.commitmentType} onChange={e => setCocForm({ ...cocForm, commitmentType: e.target.value })}>{COMMITMENT_TYPES.map(c => <option key={c} value={c}>{pretty(c)}</option>)}</select></label>
          <label>Signed date<input type="date" value={cocForm.signedDate} onChange={e => setCocForm({ ...cocForm, signedDate: e.target.value })} /></label>
          <label>Review date<input type="date" value={cocForm.reviewDate} onChange={e => setCocForm({ ...cocForm, reviewDate: e.target.value })} /></label>
          <label><input type="checkbox" checked={cocForm.conflictDeclared} onChange={e => setCocForm({ ...cocForm, conflictDeclared: e.target.checked })} /> Conflict of interest declared</label>
          <label>Conflict details<input value={cocForm.conflictDetails} onChange={e => setCocForm({ ...cocForm, conflictDetails: e.target.value })} /></label>
          <label>Statement<textarea value={cocForm.statement} onChange={e => setCocForm({ ...cocForm, statement: e.target.value })} /></label>
          <button type="submit">Add record</button>
        </form>
      </div>
      <div className="card" style={{ marginTop: 16 }}>
        <h3>Code-of-conduct register</h3>
        {conduct.length === 0 ? <p>No records yet.</p> :
          <table className="data-table"><thead><tr><th>No.</th><th>Staff</th><th>Commitment</th><th>Signed</th><th>Review</th><th>Conflict</th><th>Status</th></tr></thead><tbody>
            {conduct.map(c => <tr key={c.id}><td>{c.record_number}</td><td>{staffName(c.staff_id)}</td><td>{pretty(c.commitment_type)}</td><td>{c.signed_date || '—'}</td><td>{c.review_date || '—'}</td><td>{c.conflict_declared ? <span style={{ color: 'var(--danger)' }}>Declared</span> : 'None'}</td><td>{formatBadge(c.status)}</td></tr>)}
          </tbody></table>}
      </div>
    </>}

    {tab === 'Budget Projection' && <>
      <div className="card">
        <h3>Add budget projection line</h3>
        <p className="muted" style={{ marginTop: 0 }}>Plan across personnel, equipment, maintenance, reagents &amp; consumables, quality assurance (IQC/EQA), infrastructure and training.</p>
        <form className="form-grid" onSubmit={submitBud}>
          <label>Fiscal year<input value={budForm.fiscalYear} onChange={e => setBudForm({ ...budForm, fiscalYear: e.target.value })} /></label>
          <label>Category<select value={budForm.category} onChange={e => setBudForm({ ...budForm, category: e.target.value })}><option value="">—</option>{BUDGET_CATEGORIES.map(c => <option key={c} value={c}>{pretty(c)}</option>)}</select></label>
          <label>Projected amount<input type="number" value={budForm.projectedAmount} onChange={e => setBudForm({ ...budForm, projectedAmount: e.target.value })} /></label>
          <label>Currency<input value={budForm.currency} onChange={e => setBudForm({ ...budForm, currency: e.target.value })} /></label>
          <label>Responsible<select value={budForm.responsibleStaffId} onChange={e => setBudForm({ ...budForm, responsibleStaffId: e.target.value })}><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
          <label>Status<select value={budForm.status} onChange={e => setBudForm({ ...budForm, status: e.target.value })}>{['draft', 'submitted', 'approved', 'closed'].map(s => <option key={s} value={s}>{pretty(s)}</option>)}</select></label>
          <label>Description<textarea value={budForm.description} onChange={e => setBudForm({ ...budForm, description: e.target.value })} /></label>
          <button type="submit">Add line</button>
        </form>
      </div>
      <div className="card" style={{ marginTop: 16 }}>
        <h3>Budget register</h3>
        {budget.length === 0 ? <p>No budget lines yet.</p> :
          <table className="data-table"><thead><tr><th>No.</th><th>Year</th><th>Category</th><th>Description</th><th>Amount</th><th>Responsible</th><th>Status</th></tr></thead><tbody>
            {budget.map(b => <tr key={b.id}><td>{b.projection_number}</td><td>{b.fiscal_year || '—'}</td><td>{pretty(b.category)}</td><td>{b.description || '—'}</td><td>{b.projected_amount != null ? `${b.currency || ''} ${b.projected_amount.toLocaleString()}` : '—'}</td><td>{staffName(b.responsible_staff_id)}</td><td>{formatBadge(b.status)}</td></tr>)}
          </tbody></table>}
      </div>
    </>}

    {tab === 'Registrations & Licences' && <>
      <div className="card">
        <h3>Add registration / licence</h3>
        <p className="muted" style={{ marginTop: 0 }}>Facility licences, accreditation, practice registrations and permits. Enter the issuing body for your jurisdiction.</p>
        <form className="form-grid" onSubmit={submitReg}>
          <label>Type<select value={regForm.credentialType} onChange={e => setRegForm({ ...regForm, credentialType: e.target.value })}><option value="">—</option>{['facility_licence', 'accreditation', 'practice_registration', 'permit', 'certification', 'other'].map(c => <option key={c} value={c}>{pretty(c)}</option>)}</select></label>
          <label>Title<input value={regForm.title} onChange={e => setRegForm({ ...regForm, title: e.target.value })} required /></label>
          <label>Issuing body<input value={regForm.issuingBody} onChange={e => setRegForm({ ...regForm, issuingBody: e.target.value })} placeholder="regulator / authority name" /></label>
          <label>Reference<input value={regForm.reference} onChange={e => setRegForm({ ...regForm, reference: e.target.value })} /></label>
          <label>Issue date<input type="date" value={regForm.issueDate} onChange={e => setRegForm({ ...regForm, issueDate: e.target.value })} /></label>
          <label>Expiry date<input type="date" value={regForm.expiryDate} onChange={e => setRegForm({ ...regForm, expiryDate: e.target.value })} /></label>
          <label>Responsible<select value={regForm.responsibleStaffId} onChange={e => setRegForm({ ...regForm, responsibleStaffId: e.target.value })}><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
          <label>Status<select value={regForm.status} onChange={e => setRegForm({ ...regForm, status: e.target.value })}>{['active', 'pending_renewal', 'expired', 'withdrawn'].map(s => <option key={s} value={s}>{pretty(s)}</option>)}</select></label>
          <button type="submit">Add registration</button>
        </form>
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
