import { useRef, useState } from 'react';
import { Download, Upload, FileSpreadsheet } from 'lucide-react';
import { downloadXlsx, uploadXlsx, type ImportResult } from '../services/xlsx';

// Reusable Export / Import (Excel) toolbar. Give it the export, template and
// import endpoints; it handles the download, the file picker and shows the
// import summary. `onImported` refreshes the caller's data.
export default function XlsxToolbar({
  exportPath, templatePath, importPath, exportName, onImported, exportOnly,
}: {
  exportPath: string;
  templatePath?: string;
  importPath?: string;
  exportName: string;
  onImported?: () => void;
  exportOnly?: boolean;
}) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function doExport(path: string, name: string, key: string) {
    setError(null); setBusy(key);
    try { await downloadXlsx(path, name); } catch (e) { setError((e as Error).message); } finally { setBusy(''); }
  }
  async function doImport(file: File) {
    if (!importPath) return;
    setError(null); setResult(null); setBusy('import');
    try { setResult(await uploadXlsx(importPath, file)); onImported?.(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(''); if (inputRef.current) inputRef.current.value = ''; }
  }

  return <div style={{ margin: '4px 0 10px' }}>
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
      <button type="button" className="secondary" disabled={!!busy} onClick={() => doExport(exportPath, exportName, 'export')}>
        <Download size={15} style={{ verticalAlign: '-2px', marginRight: 6 }} />{busy === 'export' ? 'Exporting…' : 'Export to Excel'}
      </button>
      {!exportOnly && templatePath && <button type="button" className="secondary" disabled={!!busy} onClick={() => doExport(templatePath, exportName.replace('.xlsx', '_Template.xlsx'), 'tpl')}>
        <FileSpreadsheet size={15} style={{ verticalAlign: '-2px', marginRight: 6 }} />{busy === 'tpl' ? 'Preparing…' : 'Download template'}
      </button>}
      {!exportOnly && importPath && <>
        <button type="button" className="secondary" disabled={!!busy} onClick={() => inputRef.current?.click()}>
          <Upload size={15} style={{ verticalAlign: '-2px', marginRight: 6 }} />{busy === 'import' ? 'Importing…' : 'Import from Excel'}
        </button>
        <input ref={inputRef} type="file" accept=".xlsx,.xls" style={{ display: 'none' }} onChange={e => { const f = e.target.files?.[0]; if (f) void doImport(f); }} />
      </>}
    </div>
    {error && <div className="error" style={{ marginTop: 6 }}>{error}</div>}
    {result && <div className="notice-ok" style={{ marginTop: 6 }}>
      <strong>{result.created ?? 0}</strong> created{typeof result.updated === 'number' ? <>, <strong>{result.updated}</strong> updated</> : null}
      {typeof result.excursions === 'number' && result.excursions > 0 ? <>, <strong>{result.excursions}</strong> excursion(s) detected</> : null}
      {result.errors && result.errors.length > 0 && <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>{result.errors.slice(0, 12).map((er, i) => <li key={i} style={{ fontSize: 12 }}>{er}</li>)}</ul>}
    </div>}
  </div>;
}
