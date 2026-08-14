import { FormEvent, useEffect, useState } from 'react';
import PageHeader from '../components/ui/PageHeader';
import { KpiStrip, ChartCard, DonutChart, BarMeter, CHART_COLORS, ModuleAlerts, DetailModal } from '../components/ui';
import { useModules } from '../hooks/useModules';
import { api, API_BASE, getToken } from '../services/api';
import DisabledModule from '../components/DisabledModule';
import { usePermissions } from '../hooks/usePermissions';
import PermissionTabs from '../components/PermissionTabs';
import type {
  Section, Department, Staff,
  LhimsImportBatch, LhimsImportRow, ReportMappingRule, MonthlyReportBatch,
  MonthlyReportException, TatRecord, MonthlyReportsSummary, TatSummary,
  MonthlyReportArchiveEntry
} from '../../shared/types/api';

const statusBadgeClass = (status?: string) => `badge ${status ? status.toLowerCase().replace(/\s+/g, '-') : 'unknown'}`;
const formatBadge = (status?: string) => <span className={statusBadgeClass(status)}>{status ? status.replace(/_/g, ' ') : 'Unknown'}</span>;
// Tabs are filtered by permission — a tab whose feature this user cannot
// view is not drawn. See src/components/PermissionTabs.tsx.
const TAB_MODULE = 'monthly_reports';
const tabBar = (active: string, tabs: string[], onChange: (name: string) => void) =>
  <PermissionTabs moduleKey={TAB_MODULE} tabs={tabs} active={active} onChange={onChange} />;

const IMPORT_TYPES = ['opd_worksheet', 'ipd_worksheet', 'tat_file', 'other'];
const REPORT_TYPES = ['combined_lab_monthly', 'haematology', 'biochemistry', 'microbiology', 'malaria', 'tat_summary', 'blood_bank_summary'];
const MAPPING_SOURCE_FIELDS = ['test_name', 'parameter_name', 'department_name', 'section_name', 'organism', 'sample_type'];
const COUNTING_RULES = ['count_rows', 'count_unique_patient', 'count_positive', 'count_negative', 'count_organism', 'sum_value'];

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

const now = new Date();
const initialMonth = now.getMonth() + 1;
const initialYear = now.getFullYear();

export function MonthlyReportsPage({ embedded = false }: { embedded?: boolean } = {}) {
  const { can } = usePermissions();
  const { isEnabled } = useModules();
  const { staff, sections, departments } = useLookups();
  const [tab, setTab] = useState(embedded ? 'Import Batches' : 'Dashboard');
  const [error, setError] = useState<string | null>(null);

  const [summary, setSummary] = useState<MonthlyReportsSummary | null>(null);
  const [imports, setImports] = useState<LhimsImportBatch[]>([]);
  const [rules, setRules] = useState<ReportMappingRule[]>([]);
  const [exceptions, setExceptions] = useState<MonthlyReportException[]>([]);
  const [reports, setReports] = useState<MonthlyReportBatch[]>([]);
  const [tatRecords, setTatRecords] = useState<TatRecord[]>([]);
  const [tatSummary, setTatSummary] = useState<TatSummary | null>(null);
  const [archive, setArchive] = useState<MonthlyReportArchiveEntry[]>([]);
  const [selectedImport, setSelectedImport] = useState<(LhimsImportBatch & { rows?: LhimsImportRow[] }) | null>(null);
  const [selectedReport, setSelectedReport] = useState<MonthlyReportBatch | null>(null);

  const [importForm, setImportForm] = useState<{ reportMonth: number; reportYear: number; importType: string; notes: string; file: File | null }>({ reportMonth: initialMonth, reportYear: initialYear, importType: 'opd_worksheet', notes: '', file: null });
  const [ruleForm, setRuleForm] = useState({ mappingName: '', sourcePattern: '', sourceField: 'test_name', reportType: 'combined_lab_monthly', reportSection: '', reportRow: '', countingRule: 'count_rows', departmentId: '', sectionId: '', isActive: true });
  const [generateForm, setGenerateForm] = useState({ reportMonth: initialMonth, reportYear: initialYear, reportType: 'combined_lab_monthly', importBatchIds: [] as number[], notes: '' });
  const [resolveForm, setResolveForm] = useState({ exceptionId: 0, resolutionNotes: '' });
  const [tatFilter, setTatFilter] = useState({ month: initialMonth, year: initialYear });

  async function load() {
    try {
      const [sum, imp, mr, ex, rep, tats] = await Promise.all([
        api<MonthlyReportsSummary>('/dashboard/monthly-reports-summary').catch(() => null),
        api<LhimsImportBatch[]>('/monthly-reports/imports'),
        api<ReportMappingRule[]>('/monthly-reports/mapping-rules'),
        api<MonthlyReportException[]>('/monthly-reports/exceptions'),
        api<MonthlyReportBatch[]>('/monthly-reports/reports'),
        api<TatRecord[]>('/monthly-reports/tat')
      ]);
      if (sum) setSummary(sum);
      setImports(imp); setRules(mr); setExceptions(ex); setReports(rep); setTatRecords(tats);
    } catch (e) { setError((e as Error).message); }
  }
  useEffect(() => { if (embedded || isEnabled('monthly_reports')) void load(); }, [isEnabled]);
  if (!embedded && !isEnabled('monthly_reports')) return <DisabledModule />;

  async function submitImport(e: FormEvent) {
    e.preventDefault(); setError(null);
    if (!importForm.file) return setError('Choose a CSV file to upload');
    try {
      const fd = new FormData();
      fd.append('reportMonth', String(importForm.reportMonth));
      fd.append('reportYear', String(importForm.reportYear));
      fd.append('importType', importForm.importType);
      if (importForm.notes) fd.append('notes', importForm.notes);
      fd.append('file', importForm.file);
      const token = getToken();
      const response = await fetch(`${API_BASE}/monthly-reports/imports`, { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : undefined, body: fd });
      if (!response.ok) throw new Error((await response.json().catch(() => ({ error: response.statusText }))).error ?? response.statusText);
      setImportForm({ reportMonth: initialMonth, reportYear: initialYear, importType: 'opd_worksheet', notes: '', file: null });
      await load(); setTab('Import Batches');
    } catch (e) { setError((e as Error).message); }
  }

  async function processImport(id: number) {
    try { await api(`/monthly-reports/imports/${id}/process`, { method: 'POST', body: JSON.stringify({}) }); await load(); }
    catch (e) { setError((e as Error).message); }
  }

  async function openImport(id: number) {
    try {
      const detail = await api<LhimsImportBatch>(`/monthly-reports/imports/${id}`);
      const rows = await api<LhimsImportRow[]>(`/monthly-reports/imports/${id}/rows?limit=200`);
      setSelectedImport({ ...detail, rows });
    } catch (e) { setError((e as Error).message); }
  }

  async function submitRule(e: FormEvent) {
    e.preventDefault(); setError(null);
    try {
      await api('/monthly-reports/mapping-rules', { method: 'POST', body: JSON.stringify(ruleForm) });
      setRuleForm({ mappingName: '', sourcePattern: '', sourceField: 'test_name', reportType: 'combined_lab_monthly', reportSection: '', reportRow: '', countingRule: 'count_rows', departmentId: '', sectionId: '', isActive: true });
      await load();
    } catch (e) { setError((e as Error).message); }
  }

  async function toggleRule(id: number) {
    try { await api(`/monthly-reports/mapping-rules/${id}/toggle`, { method: 'POST', body: JSON.stringify({}) }); await load(); }
    catch (e) { setError((e as Error).message); }
  }

  async function submitGenerate(e: FormEvent) {
    e.preventDefault(); setError(null);
    if (generateForm.importBatchIds.length === 0) return setError('Select at least one processed import batch');
    try {
      await api('/monthly-reports/reports/generate', { method: 'POST', body: JSON.stringify(generateForm) });
      setGenerateForm({ ...generateForm, importBatchIds: [], notes: '' });
      await load(); setTab('Monthly Reports');
    } catch (e) { setError((e as Error).message); }
  }

  async function openReport(id: number) {
    try { setSelectedReport(await api<MonthlyReportBatch>(`/monthly-reports/reports/${id}`)); }
    catch (e) { setError((e as Error).message); }
  }

  async function reviewReport(id: number) {
    try { await api(`/monthly-reports/reports/${id}/review`, { method: 'POST', body: JSON.stringify({}) }); await load(); if (selectedReport?.id === id) await openReport(id); }
    catch (e) { setError((e as Error).message); }
  }

  async function approveReport(id: number, override: boolean) {
    try { await api(`/monthly-reports/reports/${id}/approve`, { method: 'POST', body: JSON.stringify({ overrideUnresolvedExceptions: override }) }); await load(); if (selectedReport?.id === id) await openReport(id); }
    catch (e) { setError((e as Error).message); }
  }

  async function exportReport(id: number, format: 'csv' | 'html' | 'doc') {
    try { await api(`/monthly-reports/reports/${id}/export`, { method: 'POST', body: JSON.stringify({ format }) }); await load(); if (selectedReport?.id === id) await openReport(id); }
    catch (e) { setError((e as Error).message); }
  }

  async function loadArchive() {
    try { setArchive(await api<MonthlyReportArchiveEntry[]>('/monthly-reports/archive')); }
    catch (e) { setError((e as Error).message); }
  }
  useEffect(() => { if (tab === 'Reports/Exports' && isEnabled('monthly_reports')) void loadArchive(); }, [tab, isEnabled]);

  async function downloadArchiveFile(reportId: number, fileId: number, name: string) {
    try {
      const token = getToken();
      const response = await fetch(`${API_BASE}/monthly-reports/reports/${reportId}/download?fileId=${fileId}`, { headers: token ? { Authorization: `Bearer ${token}` } : undefined });
      if (!response.ok) throw new Error(await response.text() || response.statusText);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch (e) { setError((e as Error).message); }
  }

  async function submitResolve(e: FormEvent) {
    e.preventDefault(); setError(null);
    if (!resolveForm.exceptionId) return;
    try {
      await api(`/monthly-reports/exceptions/${resolveForm.exceptionId}/resolve`, { method: 'POST', body: JSON.stringify({ resolutionNotes: resolveForm.resolutionNotes }) });
      setResolveForm({ exceptionId: 0, resolutionNotes: '' });
      await load();
    } catch (e) { setError((e as Error).message); }
  }

  async function createExceptionAction(id: number) {
    const title = prompt('Action title for this exception?');
    if (!title) return;
    try { await api(`/monthly-reports/exceptions/${id}/create-action`, { method: 'POST', body: JSON.stringify({ title }) }); await load(); }
    catch (e) { setError((e as Error).message); }
  }

  async function loadTatSummary() {
    try { setTatSummary(await api<TatSummary>(`/monthly-reports/tat/summary?month=${tatFilter.month}&year=${tatFilter.year}`)); }
    catch (e) { setError((e as Error).message); }
  }

  const tabs = ['Dashboard', 'Raw Archive', 'New Import', 'Import Batches', 'Mapping Rules', 'Exceptions', 'Generate Report', 'Monthly Reports', 'TAT Summary', 'Reports/Exports'];

  return <div className={embedded ? '' : 'module-page'}>
    {!embedded && <PageHeader eyebrow="Notifications &amp; Reports" title="Monthly Reports &amp; Archives" subtitle="Monthly report imports, archives, and exception handling." />}
    {tabBar(tab, tabs, setTab)}
    {error && <div className="error">{error}</div>}

    {tab === 'Dashboard' && <>
      <ModuleAlerts moduleKey="monthly_reports" />
      {summary ? <KpiStrip items={[
        { label: 'Imports (month)', value: summary.importsThisMonth, onClick: () => setTab('Import Batches') },
        { label: 'Unprocessed imports', value: summary.unprocessedImports, tone: 'warning', onClick: () => setTab('Import Batches') },
        { label: 'Unresolved exceptions', value: summary.unresolvedExceptions, tone: 'danger', onClick: () => setTab('Exceptions') },
        { label: 'Draft reports', value: summary.draftReports, onClick: () => setTab('Monthly Reports') },
        { label: 'Approved (month)', value: summary.approvedReportsThisMonth, tone: 'success', onClick: () => setTab('Monthly Reports') },
        { label: 'Delayed TAT records', value: summary.delayedTatRecords, onClick: () => setTab('TAT Summary') },
        { label: 'Average TAT (min)', value: summary.averageTatMinutes, onClick: () => setTab('TAT Summary') },
      ]} /> : <p>Loading summary…</p>}
      {summary && <div className="grid cols-2" style={{ marginTop: 18 }}>
        <ChartCard title="Import pipeline" subtitle="This month's import processing">
          <DonutChart centerLabel="Imports" data={[
            { label: 'Processed', value: Math.max(0, summary.importsThisMonth - summary.unprocessedImports), color: CHART_COLORS[1] },
            { label: 'Unprocessed', value: summary.unprocessedImports, color: CHART_COLORS[2] },
            { label: 'Unresolved exceptions', value: summary.unresolvedExceptions, color: CHART_COLORS[3] },
          ]} />
        </ChartCard>
        <ChartCard title="Reporting & turnaround" subtitle="Report status and TAT pressure">
          <BarMeter data={[
            { label: 'Draft reports', value: summary.draftReports, color: CHART_COLORS[0] },
            { label: 'Approved (month)', value: summary.approvedReportsThisMonth, color: CHART_COLORS[1] },
            { label: 'Delayed TAT records', value: summary.delayedTatRecords, color: CHART_COLORS[3] },
          ]} />
        </ChartCard>
      </div>}
    </>}

    {tab === 'Raw Archive' && <table className="data-table"><thead><tr><th>Batch #</th><th>Period</th><th>Type</th><th>File</th><th>Imported by</th><th>Status</th><th>Rows</th><th>Exceptions</th><th>Actions</th></tr></thead><tbody>
      {imports.map(b => <tr key={b.id}>
        <td>{b.batch_number}</td><td>{b.report_year}-{String(b.report_month).padStart(2, '0')}</td>
        <td>{b.import_type.replace(/_/g, ' ')}</td><td>{b.original_filename || '—'}</td>
        <td>{b.imported_by_staff_id ? (staff.find(s => s.id === b.imported_by_staff_id)?.fullName || `Staff #${b.imported_by_staff_id}`) : '—'}</td>
        <td>{formatBadge(b.status)}</td><td>{b.total_rows}</td><td>{b.exception_count}</td>
        <td>
          <button onClick={() => openImport(b.id)}>Open</button>
          {b.status !== 'processed' && <button onClick={() => processImport(b.id)}>Process</button>}
          {b.status === 'processed' && <button onClick={() => processImport(b.id)}>Reprocess</button>}
        </td>
      </tr>)}
    </tbody></table>}

    {tab === 'New Import' && <form className="form-grid" onSubmit={submitImport}>
      <label>Report month<input type="number" min={1} max={12} value={importForm.reportMonth} onChange={e => setImportForm({ ...importForm, reportMonth: Number(e.target.value) })} required /></label>
      <label>Report year<input type="number" min={2000} max={2100} value={importForm.reportYear} onChange={e => setImportForm({ ...importForm, reportYear: Number(e.target.value) })} required /></label>
      <label>Import type<select value={importForm.importType} onChange={e => setImportForm({ ...importForm, importType: e.target.value })} required>{IMPORT_TYPES.map(t => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}</select></label>
      <label>Source file<input type="file" accept=".csv,.xlsx,.xls,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={e => setImportForm({ ...importForm, file: e.target.files?.[0] ?? null })} required /></label>
      <label>Notes<textarea value={importForm.notes} onChange={e => setImportForm({ ...importForm, notes: e.target.value })} /></label>
      <button type="submit">Upload import batch</button>
      <p><em>CSV (.csv) and Excel (.xlsx, .xls) imports are parsed. The uploaded file is retained as raw archive evidence and included in backups.</em></p>
    </form>}

    {tab === 'Import Batches' && <>
      <table className="data-table"><thead><tr><th>Batch #</th><th>Period</th><th>Type</th><th>Status</th><th>Rows</th><th>Processed</th><th>Exceptions</th><th>Actions</th></tr></thead><tbody>
        {imports.map(b => <tr key={b.id}>
          <td>{b.batch_number}</td><td>{b.report_year}-{String(b.report_month).padStart(2, '0')}</td>
          <td>{b.import_type.replace(/_/g, ' ')}</td><td>{formatBadge(b.status)}</td>
          <td>{b.total_rows}</td><td>{b.processed_rows}</td><td>{b.exception_count}</td>
          <td>
            <button onClick={() => openImport(b.id)}>Open</button>
            {b.status !== 'processed' && <button onClick={() => processImport(b.id)}>Process</button>}
            {b.status === 'processed' && <button onClick={() => processImport(b.id)}>Reprocess</button>}
          </td>
        </tr>)}
      </tbody></table>
      {selectedImport && <DetailModal open onClose={() => setSelectedImport(null)} title={<>{selectedImport.batch_number} — {selectedImport.original_filename}</>}>
        <p>Status: {formatBadge(selectedImport.status)} | Rows: {selectedImport.total_rows} | Exceptions: {selectedImport.exception_count}</p>
        <p>File hash: {selectedImport.file_hash ? <code>{selectedImport.file_hash.slice(0, 16)}…</code> : '—'}</p>
        {selectedImport.rows && <>
          <h4>First {selectedImport.rows.length} rows</h4>
          <table className="data-table"><thead><tr><th>#</th><th>Patient type</th><th>Test</th><th>Parameter</th><th>Result</th><th>Mapping</th><th>Exception</th></tr></thead><tbody>
            {selectedImport.rows.map(r => <tr key={r.id}><td>{r.row_number}</td><td>{r.patient_type || '—'}</td><td>{r.test_name || '—'}</td><td>{r.parameter_name || '—'}</td><td>{r.result_value || '—'}</td><td>{formatBadge(r.mapping_status)}</td><td>{r.exception_reason || '—'}</td></tr>)}
          </tbody></table>
        </>}
      </DetailModal>}
    </>}

    {tab === 'Mapping Rules' && <>
      <form className="form-grid" onSubmit={submitRule}>
        <label>Mapping name<input value={ruleForm.mappingName} onChange={e => setRuleForm({ ...ruleForm, mappingName: e.target.value })} required /></label>
        <label>Source pattern<input value={ruleForm.sourcePattern} onChange={e => setRuleForm({ ...ruleForm, sourcePattern: e.target.value })} required placeholder="e.g. FBC, regex:^Malaria|MP, Hb*" /></label>
        <label>Source field<select value={ruleForm.sourceField} onChange={e => setRuleForm({ ...ruleForm, sourceField: e.target.value })}>{MAPPING_SOURCE_FIELDS.map(f => <option key={f} value={f}>{f.replace(/_/g, ' ')}</option>)}</select></label>
        <label>Report type<select value={ruleForm.reportType} onChange={e => setRuleForm({ ...ruleForm, reportType: e.target.value })}>{REPORT_TYPES.map(t => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}</select></label>
        <label>Report section<input value={ruleForm.reportSection} onChange={e => setRuleForm({ ...ruleForm, reportSection: e.target.value })} required placeholder="e.g. Haematology" /></label>
        <label>Report row<input value={ruleForm.reportRow} onChange={e => setRuleForm({ ...ruleForm, reportRow: e.target.value })} required placeholder="e.g. FBC requests" /></label>
        <label>Counting rule<select value={ruleForm.countingRule} onChange={e => setRuleForm({ ...ruleForm, countingRule: e.target.value })}>{COUNTING_RULES.map(c => <option key={c} value={c}>{c.replace(/_/g, ' ')}</option>)}</select></label>
        <label>Department<select value={ruleForm.departmentId} onChange={e => setRuleForm({ ...ruleForm, departmentId: e.target.value })}><option value="">—</option>{departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
        <label>Section<select value={ruleForm.sectionId} onChange={e => setRuleForm({ ...ruleForm, sectionId: e.target.value })}><option value="">—</option>{sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <button type="submit">Add mapping rule</button>
      </form>
      <table className="data-table"><thead><tr><th>Name</th><th>Pattern</th><th>Field</th><th>Report type</th><th>Section</th><th>Row</th><th>Rule</th><th>Active</th><th></th></tr></thead><tbody>
        {rules.map(r => <tr key={r.id}>
          <td>{r.mapping_name}</td><td><code>{r.source_pattern}</code></td><td>{r.source_field.replace(/_/g, ' ')}</td>
          <td>{r.report_type.replace(/_/g, ' ')}</td><td>{r.report_section}</td><td>{r.report_row}</td>
          <td>{r.counting_rule.replace(/_/g, ' ')}</td><td>{r.is_active ? 'Yes' : 'No'}</td>
          <td><button onClick={() => toggleRule(r.id)}>{r.is_active ? 'Disable' : 'Enable'}</button></td>
        </tr>)}
      </tbody></table>
    </>}

    {tab === 'Exceptions' && <>
      <table className="data-table"><thead><tr><th>Batch</th><th>Row #</th><th>Type</th><th>Test</th><th>Message</th><th>Status</th><th>Actions</th></tr></thead><tbody>
        {exceptions.map(e => <tr key={e.id}>
          <td>{e.batch_number || `#${e.import_batch_id}`}</td><td>{e.row_number ?? '—'}</td>
          <td>{e.exception_type.replace(/_/g, ' ')}</td><td>{e.test_name || e.parameter_name || '—'}</td>
          <td>{e.exception_message || '—'}</td><td>{formatBadge(e.status)}</td>
          <td>
            {e.status === 'open' && <button onClick={() => setResolveForm({ exceptionId: e.id, resolutionNotes: '' })}>Resolve</button>}
            {e.status === 'open' && <button onClick={() => createExceptionAction(e.id)}>Create action</button>}
          </td>
        </tr>)}
      </tbody></table>
      {resolveForm.exceptionId > 0 && <form className="form-grid" onSubmit={submitResolve} style={{ marginTop: 12 }}>
        <h4>Resolve exception #{resolveForm.exceptionId}</h4>
        <label>Resolution notes<textarea value={resolveForm.resolutionNotes} onChange={e => setResolveForm({ ...resolveForm, resolutionNotes: e.target.value })} required /></label>
        <button type="submit">Mark resolved</button>{' '}
        <button type="button" className="secondary" onClick={() => setResolveForm({ exceptionId: 0, resolutionNotes: '' })}>Cancel</button>
      </form>}
    </>}

    {tab === 'Generate Report' && <form className="form-grid" onSubmit={submitGenerate}>
      <label>Report month<input type="number" min={1} max={12} value={generateForm.reportMonth} onChange={e => setGenerateForm({ ...generateForm, reportMonth: Number(e.target.value) })} required /></label>
      <label>Report year<input type="number" min={2000} max={2100} value={generateForm.reportYear} onChange={e => setGenerateForm({ ...generateForm, reportYear: Number(e.target.value) })} required /></label>
      <label>Report type<select value={generateForm.reportType} onChange={e => setGenerateForm({ ...generateForm, reportType: e.target.value })} required>{REPORT_TYPES.map(t => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}</select></label>
      <label>Import batches (processed only)<select multiple size={Math.min(8, Math.max(3, imports.length))} value={generateForm.importBatchIds.map(String)} onChange={e => setGenerateForm({ ...generateForm, importBatchIds: Array.from(e.target.selectedOptions).map(o => Number(o.value)) })} required>
        {imports.filter(b => b.status === 'processed').map(b => <option key={b.id} value={b.id}>{b.batch_number} — {b.report_year}-{String(b.report_month).padStart(2, '0')} ({b.import_type})</option>)}
      </select></label>
      <label>Notes<textarea value={generateForm.notes} onChange={e => setGenerateForm({ ...generateForm, notes: e.target.value })} /></label>
      <button type="submit">Generate draft report</button>
    </form>}

    {tab === 'Monthly Reports' && <>
      <table className="data-table"><thead><tr><th>Report #</th><th>Period</th><th>Type</th><th>Status</th><th>Exceptions</th><th>Reviewed</th><th>Approved</th><th>Actions</th></tr></thead><tbody>
        {reports.map(r => <tr key={r.id}>
          <td>{r.report_number}</td><td>{r.report_year}-{String(r.report_month).padStart(2, '0')}</td>
          <td>{r.report_type.replace(/_/g, ' ')}</td><td>{formatBadge(r.status)}</td>
          <td>{r.exception_count}</td>
          <td>{r.reviewed_by_staff_id ? (staff.find(s => s.id === r.reviewed_by_staff_id)?.fullName || `Staff #${r.reviewed_by_staff_id}`) : '—'}</td>
          <td>{r.approved_by_staff_id ? (staff.find(s => s.id === r.approved_by_staff_id)?.fullName || `Staff #${r.approved_by_staff_id}`) : '—'}</td>
          <td>
            <button onClick={() => openReport(r.id)}>Open</button>
            {r.status === 'draft' && <button onClick={() => reviewReport(r.id)}>Mark reviewed</button>}
            {(r.status === 'reviewed' || r.status === 'draft') && <button onClick={() => approveReport(r.id, false)}>Approve</button>}
            {(r.status === 'reviewed' || r.status === 'draft') && r.exception_count > 0 && <button onClick={() => approveReport(r.id, true)}>Approve (override)</button>}
            {(r.status === 'approved' || r.status === 'exported') && <>
              {can('monthly_reports', 'export') && <>
                <button onClick={() => exportReport(r.id, 'csv')}>Export CSV</button>
                <button onClick={() => exportReport(r.id, 'html')}>Export HTML (print)</button>
                <button onClick={() => exportReport(r.id, 'doc')}>Export DOC</button>
              </>}
            </>}
          </td>
        </tr>)}
      </tbody></table>
      {selectedReport && <DetailModal open onClose={() => setSelectedReport(null)} title={<>{selectedReport.report_number}</>}>
        <p>Period: {selectedReport.report_year}-{String(selectedReport.report_month).padStart(2, '0')} | Type: {selectedReport.report_type.replace(/_/g, ' ')} | Status: {formatBadge(selectedReport.status)} | Exceptions: {selectedReport.exception_count}</p>
        <table className="data-table"><thead><tr><th>Section</th><th>Row</th><th>Category</th><th>Value</th><th>Source count</th><th>Notes</th></tr></thead><tbody>
          {(selectedReport.lines || []).map(l => <tr key={l.id}><td>{l.report_section}</td><td>{l.report_row}</td><td>{l.category || '—'}</td><td>{l.value_text ?? l.value_number ?? '—'}</td><td>{l.source_count}</td><td>{l.notes || '—'}</td></tr>)}
        </tbody></table>
        {selectedReport.links && selectedReport.links.length > 0 && <>
          <h4>Linked records</h4>
          <ul>{selectedReport.links.map(l => <li key={l.id}>{l.source_module_key}/{l.source_record_type}#{l.source_record_id} → {l.target_module_key}/{l.target_record_type}#{l.target_record_id}{l.notes ? ` — ${l.notes}` : ''}</li>)}</ul>
        </>}
      </DetailModal>}
    </>}

    {tab === 'TAT Summary' && <>
      <div className="form-grid">
        <label>Month<input type="number" min={1} max={12} value={tatFilter.month} onChange={e => setTatFilter({ ...tatFilter, month: Number(e.target.value) })} /></label>
        <label>Year<input type="number" min={2000} max={2100} value={tatFilter.year} onChange={e => setTatFilter({ ...tatFilter, year: Number(e.target.value) })} /></label>
        <button type="button" onClick={loadTatSummary}>Load summary</button>
      </div>
      {tatSummary && <>
        <div className="cards">
          <div className="card"><h4>Total records</h4><p className="metric">{tatSummary.total}</p></div>
          <div className="card"><h4>Within target</h4><p className="metric">{tatSummary.withinTarget}</p></div>
          <div className="card"><h4>Delayed</h4><p className="metric">{tatSummary.delayed}</p></div>
          <div className="card"><h4>Incomplete / exception</h4><p className="metric">{tatSummary.incompleteOrException}</p></div>
          <div className="card"><h4>Average TAT (min)</h4><p className="metric">{tatSummary.averageTatMinutes ?? '—'}</p></div>
        </div>
        {tatSummary.bySection && tatSummary.bySection.length > 0 && <>
          <h4>By section</h4>
          <table className="data-table"><thead><tr><th>Section</th><th>Total</th><th>Within target</th><th>Delayed</th><th>Incomplete / exception</th><th>Average TAT (min)</th></tr></thead><tbody>
            {tatSummary.bySection.map((s, i) => <tr key={i}><td>{s.section}</td><td>{s.total}</td><td>{s.withinTarget}</td><td>{s.delayed}</td><td>{s.incompleteOrException}</td><td>{s.averageTatMinutes ?? '—'}</td></tr>)}
          </tbody></table>
        </>}
      </>}
      <h4>Recent TAT records</h4>
      <table className="data-table"><thead><tr><th>Request</th><th>Patient type</th><th>Test</th><th>TAT (min)</th><th>Target</th><th>Status</th><th>Exception</th></tr></thead><tbody>
        {tatRecords.slice(0, 100).map(t => <tr key={t.id}><td>{t.request_id || `#${t.id}`}</td><td>{t.patient_type || '—'}</td><td>{t.test_name || '—'}</td><td>{t.tat_minutes ?? '—'}</td><td>{t.target_minutes ?? '—'}</td><td>{formatBadge(t.status)}</td><td>{t.exception_reason || '—'}</td></tr>)}
      </tbody></table>
    </>}

    {tab === 'Reports/Exports' && <>
      <div style={{ margin: '8px 0' }}><button type="button" onClick={loadArchive}>Refresh archive</button></div>
      <table className="data-table"><thead><tr><th>Report #</th><th>Period</th><th>Type</th><th>Status</th><th>File</th><th>Format</th><th>Size</th><th>Exported at</th><th>Notes</th><th></th></tr></thead><tbody>
        {archive.map(a => <tr key={a.link_id}>
          <td>{a.report_number}</td>
          <td>{a.report_year}-{String(a.report_month).padStart(2, '0')}</td>
          <td>{a.report_type.replace(/_/g, ' ')}</td>
          <td>{formatBadge(a.report_status)}</td>
          <td>{a.original_name}</td>
          <td>{(a.original_name.split('.').pop() || '').toLowerCase()}</td>
          <td>{(a.size_bytes / 1024).toFixed(1)} KB</td>
          <td>{a.file_created_at}</td>
          <td>{a.link_notes || '—'}</td>
          <td><button onClick={() => downloadArchiveFile(a.report_id, a.file_id, a.original_name)}>Download</button></td>
        </tr>)}
      </tbody></table>
      {archive.length === 0 && <p>No exported reports yet. Export an approved report to populate the archive.</p>}
    </>}
  </div>;
}
