import { FormEvent, useEffect, useState } from 'react';
import PageHeader from '../components/ui/PageHeader';
import { KpiStrip, ChartCard, DonutChart, BarMeter, CHART_COLORS } from '../components/ui';
import { useModules } from '../hooks/useModules';
import { api } from '../services/api';
import DisabledModule from '../components/DisabledModule';
import type { Staff, CodeOfConductRecord, BudgetProjection, OrganisationSummary } from '../../shared/types/api';

const statusBadgeClass = (status?: string) => `badge ${status ? status.toLowerCase().replace(/\s+/g, '-') : 'unknown'}`;
const formatBadge = (status?: string) => <span className={statusBadgeClass(status)}>{status ? status.replace(/_/g, ' ') : 'Unknown'}</span>;
const tabBar = (active: string, tabs: string[], onChange: (name: string) => void) =>
  <div className="tabs">{tabs.map(name => <button key={name} type="button" className={active === name ? 'active' : ''} onClick={() => onChange(name)}>{name}</button>)}</div>;
const pretty = (s?: string) => s ? s.replace(/_/g, ' ') : '—';

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

  const [cocForm, setCocForm] = useState({ staffId: '', commitmentType: 'all', statement: '', signedDate: '', reviewDate: '', conflictDeclared: false, conflictDetails: '' });
  const [budForm, setBudForm] = useState({ fiscalYear: String(new Date().getFullYear()), category: '', description: '', projectedAmount: '', currency: 'GHS', responsibleStaffId: '', status: 'draft' });

  async function load() {
    try {
      const [sum, coc, bud, stf] = await Promise.all([
        api<OrganisationSummary>('/organisation/summary').catch(() => null),
        api<CodeOfConductRecord[]>('/organisation/code-of-conduct').catch(() => []),
        api<BudgetProjection[]>('/organisation/budget').catch(() => []),
        api<Staff[]>('/staff').catch(() => []),
      ]);
      if (sum) setSummary(sum);
      setConduct(coc); setBudget(bud); setStaff(stf);
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

  const budgetByCategory = BUDGET_CATEGORIES.map((c, i) => ({
    label: pretty(c),
    value: budget.filter(b => b.category === c).reduce((s, b) => s + (b.projected_amount || 0), 0),
    color: CHART_COLORS[i % CHART_COLORS.length],
    onClick: () => setTab('Budget Projection'),
  })).filter(d => d.value > 0);

  return <div className="module-page">
    <PageHeader eyebrow="Organisation and Leadership" title="Organisation &amp; Leadership" subtitle="Leadership commitments, code of conduct, and budget planning." />
    {tabBar(tab, ['Dashboard', 'Code of Conduct', 'Budget Projection'], setTab)}
    {error && <div className="error">{error}</div>}

    {tab === 'Dashboard' && <><KpiStrip items={[
      { label: 'Code-of-conduct records', value: summary?.codeOfConductRecords ?? conduct.length, onClick: () => setTab('Code of Conduct') },
      { label: 'Due review', value: summary?.codeOfConductDueReview ?? 0, tone: (summary?.codeOfConductDueReview ?? 0) ? 'warning' : undefined, onClick: () => setTab('Code of Conduct') },
      { label: 'Declared conflicts', value: summary?.declaredConflicts ?? 0, tone: (summary?.declaredConflicts ?? 0) ? 'danger' : undefined, onClick: () => setTab('Code of Conduct') },
      { label: 'Budget lines (year)', value: summary?.budgetLinesCurrentYear ?? 0, onClick: () => setTab('Budget Projection') },
      { label: 'Budget total (year)', value: summary ? Math.round(summary.budgetTotalCurrentYear).toLocaleString() : 0, onClick: () => setTab('Budget Projection') },
      { label: 'Pending approval', value: summary?.budgetPendingApproval ?? 0, onClick: () => setTab('Budget Projection') },
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
  </div>;
}
