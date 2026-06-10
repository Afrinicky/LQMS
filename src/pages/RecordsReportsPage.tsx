import { FormEvent, useEffect, useState } from 'react';
import { useModules } from '../hooks/useModules';
import { api, API_BASE, getToken } from '../services/api';
import DisabledModule from '../components/DisabledModule';
import type {
  Staff, ReportTemplate, ReportRequest, PrintJob, EvidencePack,
  RecordRetentionRule, RecordRetentionReview, AuditTrailReview,
  BackupRestoreCheck, DataIntegrityCheck, AuditLogRow, AuditTrailSummary,
  RecordsReportsSummary
} from '../../shared/types/api';

const statusBadgeClass = (status?: string) => `badge ${status ? status.toLowerCase().replace(/\s+/g, '-') : 'unknown'}`;
const formatBadge = (status?: string) => <span className={statusBadgeClass(status)}>{status ? status.replace(/_/g, ' ') : 'Unknown'}</span>;
const tabBar = (active: string, tabs: string[], onChange: (name: string) => void) =>
  <div className="tabs">{tabs.map(name => <button key={name} type="button" className={active === name ? 'active' : ''} onClick={() => onChange(name)}>{name}</button>)}</div>;

const OUTPUT_FORMATS = ['html', 'csv', 'json', 'print_view'];
const REPORT_MODULES = ['nc_capa', 'complaints', 'risks', 'actions', 'equipment', 'supplier_inventory', 'monitoring', 'iqc', 'eqa', 'blood_bank_handover', 'monthly_reports', 'assessments', 'quality_indicators', 'customer_focus', 'poct', 'notifications'];
const ARCHIVE_ACTIONS = ['flag_for_review', 'move_to_archive', 'retain_with_review_note', 'do_not_archive'];

export function RecordsReportsPage() {
  const { isEnabled } = useModules();
  const [tab, setTab] = useState('Dashboard');
  const [error, setError] = useState<string | null>(null);

  const [summary, setSummary] = useState<RecordsReportsSummary | null>(null);
  const [templates, setTemplates] = useState<ReportTemplate[]>([]);
  const [reports, setReports] = useState<ReportRequest[]>([]);
  const [printJobs, setPrintJobs] = useState<PrintJob[]>([]);
  const [evidencePacks, setEvidencePacks] = useState<EvidencePack[]>([]);
  const [selectedPack, setSelectedPack] = useState<EvidencePack | null>(null);
  const [auditRows, setAuditRows] = useState<AuditLogRow[]>([]);
  const [auditSummary, setAuditSummary] = useState<AuditTrailSummary | null>(null);
  const [auditReviews, setAuditReviews] = useState<AuditTrailReview[]>([]);
  const [retentionRules, setRetentionRules] = useState<RecordRetentionRule[]>([]);
  const [retentionReviews, setRetentionReviews] = useState<RecordRetentionReview[]>([]);
  const [backupChecks, setBackupChecks] = useState<BackupRestoreCheck[]>([]);
  const [integrityChecks, setIntegrityChecks] = useState<DataIntegrityCheck[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);

  const [templateForm, setTemplateForm] = useState({ templateName: '', templateType: 'list', moduleKey: '', outputFormat: 'html', description: '' });
  const [reportForm, setReportForm] = useState({ reportTitle: '', moduleKey: 'actions', dateFrom: '', dateTo: '', filterJson: '' });
  const [printForm, setPrintForm] = useState({ moduleKey: '', recordType: '', recordId: '', printTitle: '', printPurpose: '', controlledCopy: false, copyNumber: '', watermark: '' });
  const [packForm, setPackForm] = useState({ packTitle: '', packPurpose: '', dateFrom: '', dateTo: '', notes: '' });
  const [packItemForm, setPackItemForm] = useState({ moduleKey: '', recordType: '', recordId: '', itemTitle: '', itemSummary: '' });
  const [auditFilter, setAuditFilter] = useState({ from: '', to: '', entity: '', action: '' });
  const [auditReviewForm, setAuditReviewForm] = useState({ reviewDate: '', dateFrom: '', dateTo: '', moduleKey: '', findingsSummary: '', unusualActivityNoted: false });
  const [ruleForm, setRuleForm] = useState({ ruleName: '', moduleKey: 'documents', recordType: 'documents', retentionPeriodMonths: '60', archiveAction: 'flag_for_review', notes: '' });
  const [backupForm, setBackupForm] = useState({ checkDate: '', checkType: 'scheduled', backupLocation: '', backupFileName: '', backupStatus: 'passed', restoreTestStatus: '', findings: '' });
  const [integrityForm, setIntegrityForm] = useState({ checkDate: '', checkType: 'manual', moduleKey: '', recordsChecked: '', issuesFound: '', findingsSummary: '' });

  async function load() {
    try {
      const [sum, t, r, pj, ep, ar, rl, rr, bc, ic, s] = await Promise.all([
        api<RecordsReportsSummary>('/dashboard/records-reports-summary').catch(() => null),
        api<ReportTemplate[]>('/records-reports/templates'),
        api<ReportRequest[]>('/records-reports/reports'),
        api<PrintJob[]>('/records-reports/print-jobs'),
        api<EvidencePack[]>('/records-reports/evidence-packs'),
        api<AuditTrailReview[]>('/records-reports/audit-reviews'),
        api<RecordRetentionRule[]>('/records-reports/retention-rules'),
        api<RecordRetentionReview[]>('/records-reports/retention-reviews'),
        api<BackupRestoreCheck[]>('/records-reports/backup-checks'),
        api<DataIntegrityCheck[]>('/records-reports/data-integrity-checks'),
        api<Staff[]>('/staff').catch(() => [])
      ]);
      if (sum) setSummary(sum);
      setTemplates(t); setReports(r); setPrintJobs(pj); setEvidencePacks(ep); setAuditReviews(ar);
      setRetentionRules(rl); setRetentionReviews(rr); setBackupChecks(bc); setIntegrityChecks(ic); setStaff(s);
    } catch (e) { setError((e as Error).message); }
  }
  useEffect(() => { if (isEnabled('records_reports')) void load(); }, [isEnabled]);
  if (!isEnabled('records_reports')) return <DisabledModule />;

  async function loadAudit() {
    const params = new URLSearchParams();
    Object.entries(auditFilter).forEach(([k, v]) => { if (v) params.set(k, v); });
    try {
      setAuditRows(await api<AuditLogRow[]>(`/records-reports/audit-trail?${params.toString()}`));
      setAuditSummary(await api<AuditTrailSummary>(`/records-reports/audit-trail/summary?${params.toString()}`));
    } catch (e) { setError((e as Error).message); }
  }

  async function openPack(id: number) {
    try { setSelectedPack(await api<EvidencePack>(`/records-reports/evidence-packs/${id}`)); }
    catch (e) { setError((e as Error).message); }
  }

  async function submitTemplate(e: FormEvent) {
    e.preventDefault(); setError(null);
    try { await api('/records-reports/templates', { method: 'POST', body: JSON.stringify(templateForm) }); setTemplateForm({ templateName: '', templateType: 'list', moduleKey: '', outputFormat: 'html', description: '' }); await load(); }
    catch (e) { setError((e as Error).message); }
  }
  async function toggleTemplate(id: number) { try { await api(`/records-reports/templates/${id}/toggle`, { method: 'POST', body: JSON.stringify({}) }); await load(); } catch (e) { setError((e as Error).message); } }

  async function submitReport(e: FormEvent) {
    e.preventDefault(); setError(null);
    try { await api('/records-reports/reports', { method: 'POST', body: JSON.stringify(reportForm) }); setReportForm({ reportTitle: '', moduleKey: 'actions', dateFrom: '', dateTo: '', filterJson: '' }); await load(); }
    catch (e) { setError((e as Error).message); }
  }
  async function generateReport(id: number) { try { await api(`/records-reports/reports/${id}/generate`, { method: 'POST', body: JSON.stringify({}) }); await load(); } catch (e) { setError((e as Error).message); } }
  async function reviewReport(id: number) { try { await api(`/records-reports/reports/${id}/review`, { method: 'POST', body: JSON.stringify({}) }); await load(); } catch (e) { setError((e as Error).message); } }
  async function approveReport(id: number) { try { await api(`/records-reports/reports/${id}/approve`, { method: 'POST', body: JSON.stringify({}) }); await load(); } catch (e) { setError((e as Error).message); } }
  async function exportReport(id: number, format: string) { try { const r = await api<{ exportNumber: string; fileName: string; rowCount: number }>(`/records-reports/reports/${id}/export`, { method: 'POST', body: JSON.stringify({ format }) }); alert(`Exported ${r.exportNumber}: ${r.fileName} · ${r.rowCount} row(s)`); await load(); } catch (e) { setError((e as Error).message); } }

  async function submitPrint(e: FormEvent) {
    e.preventDefault(); setError(null);
    try { await api('/records-reports/print-jobs', { method: 'POST', body: JSON.stringify(printForm) }); setPrintForm({ moduleKey: '', recordType: '', recordId: '', printTitle: '', printPurpose: '', controlledCopy: false, copyNumber: '', watermark: '' }); await load(); }
    catch (e) { setError((e as Error).message); }
  }

  async function submitPack(e: FormEvent) {
    e.preventDefault(); setError(null);
    try { await api('/records-reports/evidence-packs', { method: 'POST', body: JSON.stringify(packForm) }); setPackForm({ packTitle: '', packPurpose: '', dateFrom: '', dateTo: '', notes: '' }); await load(); }
    catch (e) { setError((e as Error).message); }
  }
  async function addPackItem(e: FormEvent) {
    e.preventDefault(); setError(null); if (!selectedPack) return;
    try { await api(`/records-reports/evidence-packs/${selectedPack.id}/items`, { method: 'POST', body: JSON.stringify(packItemForm) }); setPackItemForm({ moduleKey: '', recordType: '', recordId: '', itemTitle: '', itemSummary: '' }); await openPack(selectedPack.id); await load(); }
    catch (e) { setError((e as Error).message); }
  }
  async function removePackItem(itemId: number) {
    if (!selectedPack) return;
    try { await api(`/records-reports/evidence-packs/${selectedPack.id}/items/${itemId}`, { method: 'DELETE' }); await openPack(selectedPack.id); await load(); }
    catch (e) { setError((e as Error).message); }
  }
  async function openPackPrint(id: number) {
    try {
      const token = getToken();
      const response = await fetch(`${API_BASE}/records-reports/evidence-packs/${id}/print`, { headers: token ? { Authorization: `Bearer ${token}` } : undefined });
      if (!response.ok) throw new Error(await response.text() || response.statusText);
      const html = await response.text();
      const w = window.open('', '_blank');
      if (!w) { setError('Pop-up blocked. Allow pop-ups to open the print dialog.'); return; }
      w.document.open(); w.document.write(html); w.document.close();
    } catch (e) { setError((e as Error).message); }
  }

  async function packAction(id: number, action: 'generate' | 'review' | 'approve' | 'archive') {
    try { await api(`/records-reports/evidence-packs/${id}/${action}`, { method: 'POST', body: JSON.stringify({}) }); if (selectedPack?.id === id) await openPack(id); await load(); }
    catch (e) { setError((e as Error).message); }
  }

  async function submitAuditReview(e: FormEvent) {
    e.preventDefault(); setError(null);
    try { await api('/records-reports/audit-reviews', { method: 'POST', body: JSON.stringify(auditReviewForm) }); setAuditReviewForm({ reviewDate: '', dateFrom: '', dateTo: '', moduleKey: '', findingsSummary: '', unusualActivityNoted: false }); await load(); }
    catch (e) { setError((e as Error).message); }
  }
  async function auditReviewCreateAction(id: number) {
    const title = prompt('Action title?'); if (!title) return;
    try { await api(`/records-reports/audit-reviews/${id}/create-action`, { method: 'POST', body: JSON.stringify({ title }) }); await load(); }
    catch (e) { setError((e as Error).message); }
  }
  async function auditReviewClose(id: number) { try { await api(`/records-reports/audit-reviews/${id}/close`, { method: 'POST', body: JSON.stringify({}) }); await load(); } catch (e) { setError((e as Error).message); } }

  async function submitRule(e: FormEvent) {
    e.preventDefault(); setError(null);
    try { await api('/records-reports/retention-rules', { method: 'POST', body: JSON.stringify(ruleForm) }); setRuleForm({ ruleName: '', moduleKey: 'documents', recordType: 'documents', retentionPeriodMonths: '60', archiveAction: 'flag_for_review', notes: '' }); await load(); }
    catch (e) { setError((e as Error).message); }
  }
  async function toggleRule(id: number) { try { await api(`/records-reports/retention-rules/${id}/toggle`, { method: 'POST', body: JSON.stringify({}) }); await load(); } catch (e) { setError((e as Error).message); } }

  async function submitBackup(e: FormEvent) {
    e.preventDefault(); setError(null);
    try { await api('/records-reports/backup-checks', { method: 'POST', body: JSON.stringify(backupForm) }); setBackupForm({ checkDate: '', checkType: 'scheduled', backupLocation: '', backupFileName: '', backupStatus: 'passed', restoreTestStatus: '', findings: '' }); await load(); }
    catch (e) { setError((e as Error).message); }
  }
  async function backupCreateAction(id: number) {
    const title = prompt('Action title?'); if (!title) return;
    try { await api(`/records-reports/backup-checks/${id}/create-action`, { method: 'POST', body: JSON.stringify({ title }) }); await load(); }
    catch (e) { setError((e as Error).message); }
  }
  async function backupClose(id: number) { try { await api(`/records-reports/backup-checks/${id}/close`, { method: 'POST', body: JSON.stringify({}) }); await load(); } catch (e) { setError((e as Error).message); } }

  async function submitIntegrity(e: FormEvent) {
    e.preventDefault(); setError(null);
    try { await api('/records-reports/data-integrity-checks', { method: 'POST', body: JSON.stringify(integrityForm) }); setIntegrityForm({ checkDate: '', checkType: 'manual', moduleKey: '', recordsChecked: '', issuesFound: '', findingsSummary: '' }); await load(); }
    catch (e) { setError((e as Error).message); }
  }
  async function runBasicScan() {
    try { const r = await api<{ checkNumber: string; recordsChecked: number; issuesFound: number; status: string }>('/records-reports/data-integrity-checks/run-basic-scan', { method: 'POST', body: JSON.stringify({}) }); alert(`Scan ${r.checkNumber}: ${r.recordsChecked} records checked, ${r.issuesFound} issue(s). Status: ${r.status}`); await load(); }
    catch (e) { setError((e as Error).message); }
  }
  async function integrityCreateAction(id: number) {
    const title = prompt('Action title?'); if (!title) return;
    try { await api(`/records-reports/data-integrity-checks/${id}/create-action`, { method: 'POST', body: JSON.stringify({ title }) }); await load(); }
    catch (e) { setError((e as Error).message); }
  }
  async function integrityClose(id: number) { try { await api(`/records-reports/data-integrity-checks/${id}/close`, { method: 'POST', body: JSON.stringify({}) }); await load(); } catch (e) { setError((e as Error).message); } }

  const tabs = ['Dashboard', 'Report Templates', 'Generate Report', 'Report Requests', 'Print Jobs', 'Evidence Packs', 'Audit Trail', 'Audit Trail Reviews', 'Retention Rules', 'Backup/Restore Checks', 'Data Integrity Checks'];

  return <div className="module-page">
    <h2>Records, Reports & Evidence</h2>
    {tabBar(tab, tabs, setTab)}
    {error && <div className="error">{error}</div>}

    {tab === 'Dashboard' && (summary ? <div className="cards">
      <div className="card"><h4>Active report templates</h4><p className="metric">{summary.activeReportTemplates}</p></div>
      <div className="card"><h4>Reports generated this month</h4><p className="metric">{summary.reportsGeneratedThisMonth}</p></div>
      <div className="card"><h4>Open evidence packs</h4><p className="metric">{summary.openEvidencePacks}</p></div>
      <div className="card"><h4>Pending approvals</h4><p className="metric">{summary.pendingApprovals}</p></div>
      <div className="card"><h4>Print jobs this month</h4><p className="metric">{summary.printJobsThisMonth}</p></div>
      <div className="card"><h4>Retention reviews due</h4><p className="metric">{summary.retentionReviewsDue}</p></div>
      <div className="card"><h4>Backup checks this month</h4><p className="metric">{summary.backupChecksThisMonth}</p></div>
      <div className="card"><h4>Integrity issues open</h4><p className="metric">{summary.openIntegrityIssues}</p></div>
    </div> : <p>Loading…</p>)}

    {tab === 'Report Templates' && <>
      <form className="form-grid" onSubmit={submitTemplate}>
        <label>Name<input value={templateForm.templateName} onChange={e => setTemplateForm({ ...templateForm, templateName: e.target.value })} required /></label>
        <label>Type<input value={templateForm.templateType} onChange={e => setTemplateForm({ ...templateForm, templateType: e.target.value })} placeholder="list / summary / register" /></label>
        <label>Module<select value={templateForm.moduleKey} onChange={e => setTemplateForm({ ...templateForm, moduleKey: e.target.value })}><option value="">—</option>{REPORT_MODULES.map(m => <option key={m} value={m}>{m}</option>)}</select></label>
        <label>Output format<select value={templateForm.outputFormat} onChange={e => setTemplateForm({ ...templateForm, outputFormat: e.target.value })}>{OUTPUT_FORMATS.map(f => <option key={f} value={f}>{f}</option>)}</select></label>
        <label>Description<textarea value={templateForm.description} onChange={e => setTemplateForm({ ...templateForm, description: e.target.value })} /></label>
        <button type="submit">Create template</button>
      </form>
      <table className="data-table"><thead><tr><th>Code</th><th>Name</th><th>Type</th><th>Module</th><th>Format</th><th>Active</th><th></th></tr></thead><tbody>
        {templates.map(t => <tr key={t.id}><td>{t.template_code || '—'}</td><td>{t.template_name}</td><td>{t.template_type}</td><td>{t.module_key || '—'}</td><td>{t.output_format}</td><td>{t.is_active ? 'Yes' : 'No'}</td><td><button onClick={() => toggleTemplate(t.id)}>Toggle</button></td></tr>)}
      </tbody></table>
    </>}

    {tab === 'Generate Report' && <form className="form-grid" onSubmit={submitReport}>
      <label>Title<input value={reportForm.reportTitle} onChange={e => setReportForm({ ...reportForm, reportTitle: e.target.value })} required /></label>
      <label>Module<select value={reportForm.moduleKey} onChange={e => setReportForm({ ...reportForm, moduleKey: e.target.value })}>{REPORT_MODULES.map(m => <option key={m} value={m}>{m}</option>)}</select></label>
      <label>Date from<input type="date" value={reportForm.dateFrom} onChange={e => setReportForm({ ...reportForm, dateFrom: e.target.value })} /></label>
      <label>Date to<input type="date" value={reportForm.dateTo} onChange={e => setReportForm({ ...reportForm, dateTo: e.target.value })} /></label>
      <label>Filters JSON<textarea value={reportForm.filterJson} onChange={e => setReportForm({ ...reportForm, filterJson: e.target.value })} placeholder='{ "status": "open" }' /></label>
      <button type="submit">Create report request</button>
    </form>}

    {tab === 'Report Requests' && <table className="data-table"><thead><tr><th>Number</th><th>Title</th><th>Module</th><th>Period</th><th>Status</th><th>Summary</th><th>Actions</th></tr></thead><tbody>
      {reports.map(r => <tr key={r.id}>
        <td>{r.request_number}</td><td>{r.report_title}</td><td>{r.module_key}</td>
        <td>{r.date_from || '—'} → {r.date_to || '—'}</td><td>{formatBadge(r.status)}</td>
        <td><small>{r.summary || '—'}</small></td>
        <td>
          {r.status === 'draft' && <button onClick={() => generateReport(r.id)}>Generate</button>}
          {r.status === 'generated' && <button onClick={() => reviewReport(r.id)}>Review</button>}
          {r.status === 'reviewed' && <button onClick={() => approveReport(r.id)}>Approve</button>}
          {(r.status === 'generated' || r.status === 'reviewed' || r.status === 'approved') && <>
            <button onClick={() => exportReport(r.id, 'csv')}>CSV</button>
            <button onClick={() => exportReport(r.id, 'json')}>JSON</button>
            <button onClick={() => exportReport(r.id, 'html')}>HTML</button>
          </>}
        </td>
      </tr>)}
    </tbody></table>}

    {tab === 'Print Jobs' && <>
      <form className="form-grid" onSubmit={submitPrint}>
        <label>Title<input value={printForm.printTitle} onChange={e => setPrintForm({ ...printForm, printTitle: e.target.value })} required /></label>
        <label>Purpose<input value={printForm.printPurpose} onChange={e => setPrintForm({ ...printForm, printPurpose: e.target.value })} required placeholder="reference / training / controlled distribution" /></label>
        <label>Module<input value={printForm.moduleKey} onChange={e => setPrintForm({ ...printForm, moduleKey: e.target.value })} /></label>
        <label>Record type<input value={printForm.recordType} onChange={e => setPrintForm({ ...printForm, recordType: e.target.value })} /></label>
        <label>Record id<input value={printForm.recordId} onChange={e => setPrintForm({ ...printForm, recordId: e.target.value })} /></label>
        <label><input type="checkbox" checked={printForm.controlledCopy} onChange={e => setPrintForm({ ...printForm, controlledCopy: e.target.checked })} /> Controlled copy</label>
        <label>Copy number<input value={printForm.copyNumber} onChange={e => setPrintForm({ ...printForm, copyNumber: e.target.value })} /></label>
        <label>Watermark<input value={printForm.watermark} onChange={e => setPrintForm({ ...printForm, watermark: e.target.value })} /></label>
        <button type="submit">Log print job</button>
      </form>
      <table className="data-table"><thead><tr><th>Number</th><th>Title</th><th>Module / record</th><th>Purpose</th><th>Controlled</th><th>Copy</th><th>Watermark</th></tr></thead><tbody>
        {printJobs.map(p => <tr key={p.id}><td>{p.print_number}</td><td>{p.print_title}</td><td>{p.module_key || '—'}{p.record_type ? ` / ${p.record_type} #${p.record_id}` : ''}</td><td>{p.print_purpose}</td><td>{p.controlled_copy ? 'Yes' : 'No'}</td><td>{p.copy_number || '—'}</td><td>{p.watermark || '—'}</td></tr>)}
      </tbody></table>
    </>}

    {tab === 'Evidence Packs' && <>
      <form className="form-grid" onSubmit={submitPack}>
        <label>Title<input value={packForm.packTitle} onChange={e => setPackForm({ ...packForm, packTitle: e.target.value })} required /></label>
        <label>Purpose<input value={packForm.packPurpose} onChange={e => setPackForm({ ...packForm, packPurpose: e.target.value })} required placeholder="audit / management review / inspection" /></label>
        <label>Date from<input type="date" value={packForm.dateFrom} onChange={e => setPackForm({ ...packForm, dateFrom: e.target.value })} /></label>
        <label>Date to<input type="date" value={packForm.dateTo} onChange={e => setPackForm({ ...packForm, dateTo: e.target.value })} /></label>
        <label>Notes<textarea value={packForm.notes} onChange={e => setPackForm({ ...packForm, notes: e.target.value })} /></label>
        <button type="submit">Create pack</button>
      </form>
      <table className="data-table"><thead><tr><th>Number</th><th>Title</th><th>Purpose</th><th>Period</th><th>Status</th><th></th></tr></thead><tbody>
        {evidencePacks.map(p => <tr key={p.id}><td>{p.pack_number}</td><td>{p.pack_title}</td><td>{p.pack_purpose}</td><td>{p.date_from || '—'} → {p.date_to || '—'}</td><td>{formatBadge(p.status)}</td>
          <td>
            <button onClick={() => openPack(p.id)}>Open</button>
            <button onClick={() => packAction(p.id, 'generate')}>Generate JSON</button>
            <button onClick={() => openPackPrint(p.id)}>Print</button>
            {p.status === 'prepared' && <button onClick={() => packAction(p.id, 'review')}>Review</button>}
            {p.status === 'reviewed' && <button onClick={() => packAction(p.id, 'approve')}>Approve</button>}
            {p.status === 'approved' && <button onClick={() => packAction(p.id, 'archive')}>Archive</button>}
          </td></tr>)}
      </tbody></table>
      {selectedPack && <div className="card" style={{ marginTop: 16 }}>
        <h3>{selectedPack.pack_number} — {selectedPack.pack_title}</h3>
        <p>Purpose: {selectedPack.pack_purpose} | Status: {formatBadge(selectedPack.status)}</p>
        <h4>Items</h4>
        <table className="data-table"><thead><tr><th>#</th><th>Module / record</th><th>Title</th><th>Summary</th><th></th></tr></thead><tbody>
          {(selectedPack.items || []).map(i => <tr key={i.id}><td>{i.display_order}</td><td>{i.module_key}/{i.record_type}#{i.record_id}</td><td>{i.item_title}</td><td>{i.item_summary || '—'}</td><td><button onClick={() => removePackItem(i.id)}>Remove</button></td></tr>)}
        </tbody></table>
        <form className="form-grid" onSubmit={addPackItem}>
          <label>Module<input value={packItemForm.moduleKey} onChange={e => setPackItemForm({ ...packItemForm, moduleKey: e.target.value })} required /></label>
          <label>Record type<input value={packItemForm.recordType} onChange={e => setPackItemForm({ ...packItemForm, recordType: e.target.value })} required /></label>
          <label>Record id<input value={packItemForm.recordId} onChange={e => setPackItemForm({ ...packItemForm, recordId: e.target.value })} required /></label>
          <label>Title<input value={packItemForm.itemTitle} onChange={e => setPackItemForm({ ...packItemForm, itemTitle: e.target.value })} required /></label>
          <label>Summary<textarea value={packItemForm.itemSummary} onChange={e => setPackItemForm({ ...packItemForm, itemSummary: e.target.value })} /></label>
          <button type="submit">Add item</button>
        </form>
        <button className="secondary" onClick={() => setSelectedPack(null)}>Close panel</button>
      </div>}
    </>}

    {tab === 'Audit Trail' && <>
      <div className="form-grid">
        <label>From<input type="date" value={auditFilter.from} onChange={e => setAuditFilter({ ...auditFilter, from: e.target.value })} /></label>
        <label>To<input type="date" value={auditFilter.to} onChange={e => setAuditFilter({ ...auditFilter, to: e.target.value })} /></label>
        <label>Entity<input value={auditFilter.entity} onChange={e => setAuditFilter({ ...auditFilter, entity: e.target.value })} placeholder="e.g. actions, documents" /></label>
        <label>Action<input value={auditFilter.action} onChange={e => setAuditFilter({ ...auditFilter, action: e.target.value })} placeholder="e.g. create, approve" /></label>
        <button type="button" onClick={loadAudit}>Load audit trail</button>
      </div>
      {auditSummary && <div className="cards"><div className="card"><h4>Total events</h4><p className="metric">{auditSummary.total}</p></div></div>}
      <table className="data-table"><thead><tr><th>ID</th><th>Created</th><th>Actor</th><th>Action</th><th>Entity</th><th>Entity ID</th></tr></thead><tbody>
        {auditRows.map(a => <tr key={a.id}><td>{a.id}</td><td>{a.created_at}</td><td>{a.actor_user_id ?? '—'}</td><td>{a.action}</td><td>{a.entity}</td><td>{a.entity_id || '—'}</td></tr>)}
      </tbody></table>
    </>}

    {tab === 'Audit Trail Reviews' && <>
      <form className="form-grid" onSubmit={submitAuditReview}>
        <label>Review date<input type="date" value={auditReviewForm.reviewDate} onChange={e => setAuditReviewForm({ ...auditReviewForm, reviewDate: e.target.value })} required /></label>
        <label>From<input type="date" value={auditReviewForm.dateFrom} onChange={e => setAuditReviewForm({ ...auditReviewForm, dateFrom: e.target.value })} required /></label>
        <label>To<input type="date" value={auditReviewForm.dateTo} onChange={e => setAuditReviewForm({ ...auditReviewForm, dateTo: e.target.value })} required /></label>
        <label>Module<input value={auditReviewForm.moduleKey} onChange={e => setAuditReviewForm({ ...auditReviewForm, moduleKey: e.target.value })} /></label>
        <label><input type="checkbox" checked={auditReviewForm.unusualActivityNoted} onChange={e => setAuditReviewForm({ ...auditReviewForm, unusualActivityNoted: e.target.checked })} /> Unusual activity noted</label>
        <label>Findings summary<textarea value={auditReviewForm.findingsSummary} onChange={e => setAuditReviewForm({ ...auditReviewForm, findingsSummary: e.target.value })} /></label>
        <button type="submit">Create audit review</button>
      </form>
      <table className="data-table"><thead><tr><th>Number</th><th>Date</th><th>Period</th><th>Module</th><th>Unusual</th><th>Findings</th><th>Linked action</th><th>Status</th><th></th></tr></thead><tbody>
        {auditReviews.map(r => <tr key={r.id}><td>{r.review_number}</td><td>{r.review_date}</td><td>{r.date_from} → {r.date_to}</td><td>{r.module_key || '—'}</td><td>{r.unusual_activity_noted ? 'Yes' : 'No'}</td><td>{r.findings_summary || '—'}</td>
          <td>{r.action_id ? <small>#{r.action_id} {r.action_title ? `· ${r.action_title}` : ''} {r.action_status ? `(${r.action_status})` : ''}{r.action_due_date ? ` · due ${r.action_due_date}` : ''}</small> : '—'}</td>
          <td>{formatBadge(r.status)}</td>
          <td>{!r.action_id && <button onClick={() => auditReviewCreateAction(r.id)}>Create action</button>}{r.status !== 'closed' && <button onClick={() => auditReviewClose(r.id)}>Close</button>}</td></tr>)}
      </tbody></table>
    </>}

    {tab === 'Retention Rules' && <>
      <form className="form-grid" onSubmit={submitRule}>
        <label>Rule name<input value={ruleForm.ruleName} onChange={e => setRuleForm({ ...ruleForm, ruleName: e.target.value })} required /></label>
        <label>Module<input value={ruleForm.moduleKey} onChange={e => setRuleForm({ ...ruleForm, moduleKey: e.target.value })} required /></label>
        <label>Record type<input value={ruleForm.recordType} onChange={e => setRuleForm({ ...ruleForm, recordType: e.target.value })} required /></label>
        <label>Retention months<input type="number" value={ruleForm.retentionPeriodMonths} onChange={e => setRuleForm({ ...ruleForm, retentionPeriodMonths: e.target.value })} required /></label>
        <label>Archive action<select value={ruleForm.archiveAction} onChange={e => setRuleForm({ ...ruleForm, archiveAction: e.target.value })}>{ARCHIVE_ACTIONS.map(a => <option key={a} value={a}>{a.replace(/_/g, ' ')}</option>)}</select></label>
        <label>Notes<textarea value={ruleForm.notes} onChange={e => setRuleForm({ ...ruleForm, notes: e.target.value })} /></label>
        <button type="submit">Create rule</button>
      </form>
      <table className="data-table"><thead><tr><th>Rule</th><th>Module</th><th>Record type</th><th>Months</th><th>Archive action</th><th>Active</th><th></th></tr></thead><tbody>
        {retentionRules.map(r => <tr key={r.id}><td>{r.rule_name}</td><td>{r.module_key}</td><td>{r.record_type}</td><td>{r.retention_period_months}</td><td>{r.archive_action.replace(/_/g, ' ')}</td><td>{r.is_active ? 'Yes' : 'No'}</td><td><button onClick={() => toggleRule(r.id)}>Toggle</button></td></tr>)}
      </tbody></table>
      <h3>Recent retention reviews</h3>
      <table className="data-table"><thead><tr><th>Number</th><th>Date</th><th>Module/type</th><th>Reviewed</th><th>Due for archive</th><th>Archived</th><th>Status</th></tr></thead><tbody>
        {retentionReviews.map(r => <tr key={r.id}><td>{r.review_number}</td><td>{r.review_date}</td><td>{r.module_key || '—'}{r.record_type ? `/${r.record_type}` : ''}</td><td>{r.records_reviewed}</td><td>{r.records_due_for_archive}</td><td>{r.records_archived}</td><td>{formatBadge(r.status)}</td></tr>)}
      </tbody></table>
    </>}

    {tab === 'Backup/Restore Checks' && <>
      <form className="form-grid" onSubmit={submitBackup}>
        <label>Check date<input type="date" value={backupForm.checkDate} onChange={e => setBackupForm({ ...backupForm, checkDate: e.target.value })} required /></label>
        <label>Check type<input value={backupForm.checkType} onChange={e => setBackupForm({ ...backupForm, checkType: e.target.value })} required placeholder="scheduled / ad-hoc / restore_test" /></label>
        <label>Backup location<input value={backupForm.backupLocation} onChange={e => setBackupForm({ ...backupForm, backupLocation: e.target.value })} /></label>
        <label>Backup file<input value={backupForm.backupFileName} onChange={e => setBackupForm({ ...backupForm, backupFileName: e.target.value })} /></label>
        <label>Backup status<select value={backupForm.backupStatus} onChange={e => setBackupForm({ ...backupForm, backupStatus: e.target.value })}><option value="passed">passed</option><option value="failed">failed</option><option value="partial">partial</option></select></label>
        <label>Restore test status<select value={backupForm.restoreTestStatus} onChange={e => setBackupForm({ ...backupForm, restoreTestStatus: e.target.value })}><option value="">—</option><option value="passed">passed</option><option value="failed">failed</option><option value="not_performed">not performed</option></select></label>
        <label>Findings<textarea value={backupForm.findings} onChange={e => setBackupForm({ ...backupForm, findings: e.target.value })} /></label>
        <button type="submit">Log backup check</button>
      </form>
      <table className="data-table"><thead><tr><th>Number</th><th>Date</th><th>Type</th><th>Backup</th><th>Restore test</th><th>Status</th><th>Findings</th><th></th></tr></thead><tbody>
        {backupChecks.map(c => <tr key={c.id}><td>{c.check_number}</td><td>{c.check_date}</td><td>{c.check_type}</td><td>{c.backup_status || '—'}</td><td>{c.restore_test_status || '—'}</td><td>{formatBadge(c.status)}</td><td>{c.findings || '—'}</td>
          <td><button onClick={() => backupCreateAction(c.id)}>Create action</button>{c.status !== 'closed' && <button onClick={() => backupClose(c.id)}>Close</button>}</td></tr>)}
      </tbody></table>
    </>}

    {tab === 'Data Integrity Checks' && <>
      <button type="button" onClick={runBasicScan}>Run basic scan</button>
      <form className="form-grid" onSubmit={submitIntegrity} style={{ marginTop: 12 }}>
        <label>Check date<input type="date" value={integrityForm.checkDate} onChange={e => setIntegrityForm({ ...integrityForm, checkDate: e.target.value })} required /></label>
        <label>Check type<input value={integrityForm.checkType} onChange={e => setIntegrityForm({ ...integrityForm, checkType: e.target.value })} required /></label>
        <label>Module<input value={integrityForm.moduleKey} onChange={e => setIntegrityForm({ ...integrityForm, moduleKey: e.target.value })} /></label>
        <label>Records checked<input type="number" value={integrityForm.recordsChecked} onChange={e => setIntegrityForm({ ...integrityForm, recordsChecked: e.target.value })} /></label>
        <label>Issues found<input type="number" value={integrityForm.issuesFound} onChange={e => setIntegrityForm({ ...integrityForm, issuesFound: e.target.value })} /></label>
        <label>Findings summary<textarea value={integrityForm.findingsSummary} onChange={e => setIntegrityForm({ ...integrityForm, findingsSummary: e.target.value })} /></label>
        <button type="submit">Log manual check</button>
      </form>
      <table className="data-table"><thead><tr><th>Number</th><th>Date</th><th>Type</th><th>Module</th><th>Records</th><th>Issues</th><th>Status</th><th>Findings</th><th></th></tr></thead><tbody>
        {integrityChecks.map(c => <tr key={c.id}><td>{c.check_number}</td><td>{c.check_date}</td><td>{c.check_type}</td><td>{c.module_key || '—'}</td><td>{c.records_checked}</td><td>{c.issues_found}</td><td>{formatBadge(c.status)}</td><td><pre style={{ whiteSpace: 'pre-wrap', margin: 0, fontSize: 10 }}>{c.findings_summary || '—'}</pre></td>
          <td><button onClick={() => integrityCreateAction(c.id)}>Create action</button>{c.status !== 'closed' && <button onClick={() => integrityClose(c.id)}>Close</button>}</td></tr>)}
      </tbody></table>
    </>}
  </div>;
}
