import { useRef, useState } from 'react';
import { Download, Upload, FileSpreadsheet, Printer } from 'lucide-react';
import { downloadXlsx, uploadXlsx, openPrintable, type ImportResult } from '../services/xlsx';
import { usePermissions } from '../hooks/usePermissions';

// Reusable Export / Import (Excel) toolbar. Give it the export, template and
// import endpoints; it handles the download, the file picker and shows the
// import summary. `onImported` refreshes the caller's data.
//
// `module` is the module the data belongs to. Export appears only for someone
// with the export right on it, import only with the create right, and the
// printable report only with the print right — a user who may read a register
// but not take a copy of it never sees the button.
//
// `dateRange` adds From/To pickers whose values are appended to the export and
// print requests, so a register or a chart can be taken for one period rather
// than in full. The paths may already carry query parameters; the separator is
// worked out rather than assumed.
export default function XlsxToolbar({
  module, exportPath, templatePath, importPath, printPath, printLabel = 'Print (PDF)',
  exportName, onImported, exportOnly, importOnly, dateRange, dateLabel = 'Period',
}: {
  module: string;
  exportPath?: string;
  templatePath?: string;
  importPath?: string;
  printPath?: string;
  printLabel?: string;
  exportName: string;
  onImported?: (result: ImportResult) => void;
  exportOnly?: boolean;
  importOnly?: boolean;
  dateRange?: boolean;
  dateLabel?: string;
}) {
  const { can } = usePermissions();
  const mayExport = can(module, 'export') && !!exportPath && !importOnly;
  const mayImport = can(module, 'create') && !exportOnly;
  const mayPrint = can(module, 'print') && !!printPath && !importOnly;
  const [busy, setBusy] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Only the dates that were actually chosen are sent, so an untouched picker
  // means "everything" rather than an empty window.
  const withRange = (path: string) => {
    if (!dateRange) return path;
    const parts = [from && `from=${from}`, to && `to=${to}`].filter(Boolean);
    if (parts.length === 0) return path;
    return `${path}${path.includes('?') ? '&' : '?'}${parts.join('&')}`;
  };

  async function doExport(path: string, name: string, key: string) {
    setError(null); setBusy(key);
    try { await downloadXlsx(path, name); } catch (e) { setError((e as Error).message); } finally { setBusy(''); }
  }
  async function doPrint() {
    if (!printPath) return;
    setError(null); setBusy('print');
    try { await openPrintable(withRange(printPath)); } catch (e) { setError((e as Error).message); } finally { setBusy(''); }
  }
  async function doImport(file: File) {
    if (!importPath) return;
    setError(null); setResult(null); setBusy('import');
    try { const r = await uploadXlsx(importPath, file); setResult(r); onImported?.(r); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(''); if (inputRef.current) inputRef.current.value = ''; }
  }

  const canImportHere = mayImport && (templatePath || importPath);
  // Nothing to offer: render nothing at all rather than an empty toolbar.
  if (!mayExport && !mayPrint && !canImportHere) return null;

  return <div style={{ margin: '4px 0 10px' }}>
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
      {dateRange && (mayExport || mayPrint) && <>
        <label style={{ fontSize: 12 }}>{dateLabel} from
          <input type="date" value={from} max={to || undefined} onChange={e => setFrom(e.target.value)} style={{ display: 'block' }} />
        </label>
        <label style={{ fontSize: 12 }}>to
          <input type="date" value={to} min={from || undefined} onChange={e => setTo(e.target.value)} style={{ display: 'block' }} />
        </label>
        {(from || to) && <button type="button" className="link-button" style={{ marginBottom: 6 }}
          onClick={() => { setFrom(''); setTo(''); }}>Clear dates</button>}
      </>}
      {mayExport && <button type="button" className="secondary" disabled={!!busy} onClick={() => doExport(withRange(exportPath!), exportName, 'export')}>
        <Download size={15} style={{ verticalAlign: '-2px', marginRight: 6 }} />{busy === 'export' ? 'Exporting…' : 'Export to Excel'}
      </button>}
      {mayPrint && <button type="button" className="secondary" disabled={!!busy} onClick={() => void doPrint()}>
        <Printer size={15} style={{ verticalAlign: '-2px', marginRight: 6 }} />{busy === 'print' ? 'Preparing…' : printLabel}
      </button>}
      {templatePath && mayImport && <button type="button" className="secondary" disabled={!!busy} onClick={() => doExport(templatePath, exportName.replace('.xlsx', '_Template.xlsx'), 'tpl')}>
        <FileSpreadsheet size={15} style={{ verticalAlign: '-2px', marginRight: 6 }} />{busy === 'tpl' ? 'Preparing…' : 'Download template'}
      </button>}
      {importPath && mayImport && <>
        <button type="button" className="secondary" disabled={!!busy} onClick={() => inputRef.current?.click()}>
          <Upload size={15} style={{ verticalAlign: '-2px', marginRight: 6 }} />{busy === 'import' ? 'Importing…' : 'Import from Excel'}
        </button>
        <input ref={inputRef} type="file" accept=".xlsx,.xls" style={{ display: 'none' }} onChange={e => { const f = e.target.files?.[0]; if (f) void doImport(f); }} />
      </>}
    </div>
    {error && <div className="error" style={{ marginTop: 6 }}>{error}</div>}
    {result && <div className={result.errors && result.errors.length > 0 ? 'notice-warn' : 'notice-ok'} style={{ marginTop: 6 }}>
      <strong>{result.created ?? 0}</strong> created{typeof result.updated === 'number' ? <>, <strong>{result.updated}</strong> updated</> : null}
      {typeof result.analytes === 'number' ? <>, <strong>{result.analytes}</strong> analyte(s)</> : null}
      {typeof result.readings === 'number' ? <>, <strong>{result.readings}</strong> reading(s)</> : null}
      {typeof result.rejected === 'number' && result.rejected > 0 ? <>, <strong>{result.rejected}</strong> run(s) out of control</> : null}
      {typeof result.excursions === 'number' && result.excursions > 0 ? <>, <strong>{result.excursions}</strong> excursion(s) detected</> : null}
      {typeof result.totalRows === 'number' ? <span style={{ opacity: .7 }}> · {result.totalRows} row(s) read</span> : null}
      {result.errors && result.errors.length > 0 && <>
        <div style={{ marginTop: 6, fontSize: 12, fontWeight: 600 }}>{result.errors.length} row(s) were not imported:</div>
        <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{result.errors.slice(0, 12).map((er, i) => <li key={i} style={{ fontSize: 12 }}>{er}</li>)}</ul>
        {result.errors.length > 12 && <div style={{ fontSize: 12, opacity: .7 }}>…and {result.errors.length - 12} more.</div>}
      </>}
    </div>}
  </div>;
}
