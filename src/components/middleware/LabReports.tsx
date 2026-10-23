import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileSpreadsheet, FileText, Image, Loader2, Printer, RefreshCw, Upload } from 'lucide-react';
import { api, apiRead, errorText, API_BASE, getToken } from '../../services/api';
import { usePermissions } from '../../hooks/usePermissions';
import { openPrintable } from '../../services/xlsx';
import { REPORT_COLUMN_LABELS, type ReportColumn, type ReportTemplate } from '../../../shared/constants/labReport';
import { Field, Note, Panel, Pick, Switch, when, type SectionProps } from './shared';

/**
 * Every transmitted result, as the document the laboratory issues.
 *
 * The register beside it already says a message arrived and where it went.
 * This answers the question people actually ask of a result — what did the
 * report say — and makes it something that can be read on screen, printed,
 * or handed over as a PDF, a Word file or a spreadsheet.
 *
 * The design tab changes how it looks and nothing about what it says. Values,
 * units and the analyser's own flags are printed exactly as they were
 * received; a reference range appears only where the laboratory holds one.
 */

const TABS = ['Reports', 'Design'] as const;
type Tab = (typeof TABS)[number];

type Row = {
  id: number; sample_id: string | null; lot_number: string | null; kind: string;
  received_at: string; instrument_run_at: string | null; instrument_name: string | null;
  result_count: number; link_name: string | null; equipment_name: string | null;
  section_name: string | null; mw_status: string | null; delivered: number;
};

type Reference = {
  papers: Array<{ key: string; label: string }>;
  headerStyles: Array<{ key: string; label: string }>;
  densities: Array<{ key: string; label: string }>;
  fonts: Array<{ key: string; label: string }>;
  columns: Array<{ key: ReportColumn; label: string; required: boolean }>;
};

export default function LabReports({ onError, onNotice }: SectionProps) {
  const { can } = usePermissions();
  const mayDesign = can('analyser_middleware.reports', 'edit');
  const mayExport = can('analyser_middleware.reports', 'export');
  const mayPrint = can('analyser_middleware.reports', 'print');

  const [tab, setTab] = useState<Tab>('Reports');
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [sources, setSources] = useState<Array<{ id: number; name: string }>>([]);
  const [filter, setFilter] = useState({ search: '', kind: '', linkId: '', from: '', to: '' });
  const [selected, setSelected] = useState<number[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const [preview, setPreview] = useState<string>('');
  const [template, setTemplate] = useState<ReportTemplate | null>(null);
  const [reference, setReference] = useState<Reference | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const query = new URLSearchParams({ limit: '150' });
    if (filter.search) query.set('search', filter.search);
    if (filter.kind) query.set('kind', filter.kind);
    if (filter.linkId) query.set('linkId', filter.linkId);
    if (filter.from) query.set('from', filter.from);
    if (filter.to) query.set('to', filter.to);
    const data = await apiRead<{ total: number; rows: Row[]; sources: Array<{ id: number; name: string }> }>(
      `/transmission-reports?${query}`, { total: 0, rows: [], sources: [] });
    setRows(data.rows); setTotal(data.total); setSources(data.sources);
  }, [filter]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    void (async () => {
      try {
        const [templates, ref] = await Promise.all([
          api<ReportTemplate[]>('/transmission-reports/templates'),
          api<Reference>('/transmission-reports/reference'),
        ]);
        setTemplate(templates[0] ?? null);
        setReference(ref);
      } catch (e) { onError(errorText(e)); }
    })();
  }, [onError]);

  // The report itself is server-rendered, and the token travels in a header, so
  // it is fetched and handed to the frame rather than linked to.
  const showReport = useCallback(async (id: number) => {
    setOpen(id); setBusy('preview'); onError(null);
    try {
      const token = getToken();
      const response = await fetch(`${API_BASE}/transmission-reports/${id}/print?toolbar=0`, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      if (!response.ok) throw new Error(await response.text() || response.statusText);
      setPreview(await response.text());
    } catch (e) { onError(errorText(e)); setPreview(''); }
    finally { setBusy(null); }
  }, [onError]);

  useEffect(() => {
    if (open === null && rows.length) void showReport(rows[0].id);
    // Only when the register first arrives: re-opening on every change would
    // pull the reader off the report they are looking at.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows.length]);

  const chosen = useMemo(() => (selected.length ? selected : open ? [open] : []), [selected, open]);

  async function download(format: 'docx' | 'xlsx') {
    if (!chosen.length) { onError('Choose at least one result.'); return; }
    setBusy(format); onError(null);
    try {
      const token = getToken();
      const response = await fetch(`${API_BASE}/transmission-reports/export.${format}?ids=${chosen.join(',')}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      if (!response.ok) throw new Error((await response.json().catch(() => ({ error: response.statusText }))).error ?? response.statusText);
      const blob = await response.blob();
      const match = (response.headers.get('Content-Disposition') || '').match(/filename="?([^"]+)"?/);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = match ? match[1] : `lab-report.${format}`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      onNotice(`${chosen.length} report(s) downloaded.`);
    } catch (e) { onError(errorText(e)); }
    finally { setBusy(null); }
  }

  async function print() {
    if (!chosen.length) { onError('Choose at least one result.'); return; }
    setBusy('print'); onError(null);
    try {
      await openPrintable(chosen.length === 1
        ? `/transmission-reports/${chosen[0]}/print?autoprint=1`
        : `/transmission-reports/print?ids=${chosen.join(',')}&autoprint=1`);
    } catch (e) { onError(errorText(e)); }
    finally { setBusy(null); }
  }

  const toggle = (id: number) => setSelected(current => (current.includes(id) ? current.filter(x => x !== id) : [...current, id]));

  return (
    <>
      <div className="tabs is-inline rf-subtabs">
        {TABS.map(name => (
          <button key={name} className={tab === name ? 'active' : ''} onClick={() => setTab(name)}>{name}</button>
        ))}
      </div>

      {tab === 'Reports' && (
        <div className="rf-report-split">
          <div className="mw-main">
            <Panel
              title="Transmitted results"
              subtitle={`${total} on the record.`}
              actions={<button className="btn ghost" onClick={() => void load()}><RefreshCw size={13} /> Refresh</button>}
            >
              <div className="mw-grid">
                <Field label="Sample, lot or analyser" value={filter.search} onValue={v => setFilter(f => ({ ...f, search: v }))} />
                <Pick label="Kind" value={filter.kind} onValue={v => setFilter(f => ({ ...f, kind: v }))}
                  options={[{ key: 'patient', label: 'Patient' }, { key: 'control', label: 'Control' }]} blank="Any kind" />
                <Pick label="Analyser" value={filter.linkId} onValue={v => setFilter(f => ({ ...f, linkId: v }))}
                  options={sources.map(s => ({ key: String(s.id), label: s.name }))} blank="Any analyser" />
                <Field label="From" type="date" value={filter.from} onValue={v => setFilter(f => ({ ...f, from: v }))} />
                <Field label="To" type="date" value={filter.to} onValue={v => setFilter(f => ({ ...f, to: v }))} />
              </div>

              {!rows.length ? <Note>No transmitted result matches.</Note> : (
                <table className="data-table mw-table">
                  <thead>
                    <tr><th /><th>Received</th><th>Sample</th><th>Analyser</th><th className="num">Results</th><th>Kind</th></tr>
                  </thead>
                  <tbody>
                    {rows.map(row => (
                      <tr key={row.id} className={open === row.id ? 'is-selected' : undefined}>
                        <td><input type="checkbox" checked={selected.includes(row.id)} onChange={() => toggle(row.id)} /></td>
                        <td><button className="mw-list-button" onClick={() => void showReport(row.id)}>{when(row.received_at)}</button></td>
                        <td>
                          <strong>{row.sample_id ?? '—'}</strong>
                          {row.lot_number && <span className="mw-sub">Lot {row.lot_number}</span>}
                        </td>
                        <td>{row.link_name ?? row.equipment_name ?? row.instrument_name ?? '—'}</td>
                        <td className="num">{row.result_count}</td>
                        <td><span className={`mw-chip t-${row.kind === 'control' ? 'info' : row.kind === 'unknown' ? 'warn' : 'ok'}`}>{row.kind}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Panel>
          </div>

          <div className="mw-main">
            <Panel
              title="Report"
              subtitle={selected.length > 1 ? `${selected.length} selected — printing and exporting cover all of them.` : 'As it prints.'}
              actions={(
                <>
                  {mayPrint && <button className="btn ghost" onClick={() => void print()} disabled={busy === 'print'}><Printer size={13} /> Print / PDF</button>}
                  {mayExport && <button className="btn ghost" onClick={() => void download('docx')} disabled={busy === 'docx'}><FileText size={13} /> Word</button>}
                  {mayExport && <button className="btn ghost" onClick={() => void download('xlsx')} disabled={busy === 'xlsx'}><FileSpreadsheet size={13} /> Excel</button>}
                </>
              )}
            >
              {busy === 'preview' ? <Note><Loader2 size={13} className="spin" /> Preparing the report…</Note>
                : preview ? <Sheet html={preview} title="Laboratory report" />
                : <Note>Choose a transmitted result to see its report.</Note>}
            </Panel>
          </div>
        </div>
      )}

      {tab === 'Design' && (
        <Design
          template={template} reference={reference} mayDesign={mayDesign} busy={busy} setBusy={setBusy}
          onError={onError} onNotice={onNotice} onSaved={setTemplate}
          sampleId={open ?? rows[0]?.id ?? null}
        />
      )}
    </>
  );
}

/**
 * The report at its real proportions, scaled to fit beside the register.
 *
 * Shown in a frame rather than re-implemented: what is on screen is the same
 * document the printer and the Word export are built from, so a design is
 * judged on the thing itself rather than on an approximation of it.
 */
function Sheet({ html, title, tall }: { html: string; title: string; tall?: boolean }) {
  return (
    <div className={`rf-sheet${tall ? ' tall' : ''}`}>
      <div className="rf-sheet-inner">
        <iframe className="rf-preview" title={title} srcDoc={html} />
      </div>
    </div>
  );
}

/* ============================================================================
   Design
   ========================================================================= */
function Design({ template, reference, mayDesign, busy, setBusy, onError, onNotice, onSaved, sampleId }: {
  template: ReportTemplate | null;
  reference: Reference | null;
  mayDesign: boolean;
  busy: string | null;
  setBusy: (key: string | null) => void;
  onError: (message: string | null) => void;
  onNotice: (message: string | null) => void;
  onSaved: (template: ReportTemplate) => void;
  sampleId: number | null;
}) {
  const [draft, setDraft] = useState<ReportTemplate | null>(template);
  const [preview, setPreview] = useState('');
  const logoInput = useRef<HTMLInputElement>(null);

  useEffect(() => { setDraft(template); }, [template]);

  const refresh = useCallback(async () => {
    if (!sampleId) { setPreview(''); return; }
    try {
      const token = getToken();
      const response = await fetch(`${API_BASE}/transmission-reports/${sampleId}/print?toolbar=0`, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      setPreview(response.ok ? await response.text() : '');
    } catch { setPreview(''); }
  }, [sampleId]);

  useEffect(() => { void refresh(); }, [refresh]);

  if (!draft) return <Note>The report template could not be read.</Note>;
  const set = (patch: Partial<ReportTemplate>) => setDraft(current => (current ? { ...current, ...patch } : current));

  async function save() {
    if (!draft) return;
    setBusy('template'); onError(null);
    try {
      const saved = await api<ReportTemplate>(`/transmission-reports/templates/${draft.templateCode || 'DEFAULT'}`, {
        method: 'PUT', body: JSON.stringify(draft),
      });
      onSaved(saved);
      onNotice('The report design was saved. It applies to every report from now on.');
      await refresh();
    } catch (e) { onError(errorText(e)); }
    finally { setBusy(null); }
  }

  function readLogo(file: File) {
    if (file.size > 600_000) { onError('Use a crest under 600 KB so the report stays quick to open.'); return; }
    const reader = new FileReader();
    reader.onload = () => set({ logoDataUri: String(reader.result) });
    reader.onerror = () => onError('That image could not be read.');
    reader.readAsDataURL(file);
  }

  const toggleColumn = (column: ReportColumn, on: boolean) => set({
    columns: on
      ? [...draft.columns.filter(c => c !== column), column]
      : draft.columns.filter(c => c !== column),
  });

  return (
    <div className="rf-report-split">
      <div className="mw-main">
        <Panel title="Letterhead" subtitle="The lines above the title, exactly as they should print.">
          <div className="mw-grid">
            <Field label="Owning body" value={draft.organisation} onValue={v => set({ organisation: v })} placeholder="National Catholic Health Service" wide />
            <Field label="Facility" value={draft.facility} onValue={v => set({ facility: v })} placeholder="St. Elizabeth Catholic Hospital" wide />
            <Field label="Address" value={draft.addressLine} onValue={v => set({ addressLine: v })} placeholder="P.O. Box 4, Hwidiem, B/A — Goaso Diocese" wide />
            <Field label="Contact" value={draft.contactLine} onValue={v => set({ contactLine: v })} placeholder="Telephone · email" wide />
            <Field label="Report title" value={draft.reportTitle} onValue={v => set({ reportTitle: v })}
              placeholder="Left blank, the analyser’s section names it" hint="e.g. HAEMATOLOGY REPORT" wide />
            <div className="mw-actions">
              <button className="btn ghost" onClick={() => logoInput.current?.click()}><Upload size={13} /> Crest or logo</button>
              {draft.logoDataUri && <img className="rf-logo" src={draft.logoDataUri} alt="" />}
              {draft.logoDataUri && <button className="btn ghost" onClick={() => set({ logoDataUri: null })}>Remove</button>}
              <input ref={logoInput} type="file" accept="image/*" hidden
                onChange={e => { const file = e.target.files?.[0]; if (file) readLogo(file); e.target.value = ''; }} />
            </div>
          </div>
        </Panel>

        <Panel title="Appearance">
          <div className="mw-grid">
            <Pick label="Header" value={draft.headerStyle} onValue={v => set({ headerStyle: v as ReportTemplate['headerStyle'] })} options={reference?.headerStyles ?? []} />
            <Pick label="Typeface" value={draft.font} onValue={v => set({ font: v as ReportTemplate['font'] })} options={reference?.fonts ?? []} />
            <Pick label="Paper" value={draft.paper} onValue={v => set({ paper: v as ReportTemplate['paper'] })} options={reference?.papers ?? []} />
            <Pick label="Density" value={draft.density} onValue={v => set({ density: v as ReportTemplate['density'] })} options={reference?.densities ?? []} />
            <label>
              <span>Accent colour</span>
              <input type="color" value={draft.accentColour} onChange={e => set({ accentColour: e.target.value })} />
            </label>
            <label>
              <span>Text colour</span>
              <input type="color" value={draft.textColour} onChange={e => set({ textColour: e.target.value })} />
            </label>
            <Field label="Margin (mm)" type="number" value={String(draft.marginMm)} onValue={v => set({ marginMm: Number(v) || 13 })} />
            <Field label="Watermark" value={draft.watermark} onValue={v => set({ watermark: v })} placeholder="e.g. COPY" />
          </div>
        </Panel>

        <Panel title="What the report carries">
          <div className="mw-grid">
            {(reference?.columns ?? []).map(column => (
              <Switch key={column.key}
                label={REPORT_COLUMN_LABELS[column.key] ?? column.label}
                checked={draft.columns.includes(column.key)}
                disabled={column.required}
                onChange={on => toggleColumn(column.key, on)} />
            ))}
            <Switch label="Crest or logo" checked={draft.showLogo} onChange={v => set({ showLogo: v })} />
            <Switch label="Flag legend" checked={draft.showFlagLegend} onChange={v => set({ showFlagLegend: v })} />
            <Switch label="Analyser messages" checked={draft.showInstrumentMessages} onChange={v => set({ showInstrumentMessages: v })} />
            <Switch label="Signature block" checked={draft.showSignature} onChange={v => set({ showSignature: v })} />
            <Switch label="Delivery state" checked={draft.showDeliveryState} onChange={v => set({ showDeliveryState: v })} />
            <Field label="Signature line reads" value={draft.signatureLine} onValue={v => set({ signatureLine: v })} />
            <Field label="Footer" value={draft.footerText} onValue={v => set({ footerText: v })} area wide />
            <Field label="Disclaimer" value={draft.disclaimer} onValue={v => set({ disclaimer: v })} area wide />
            <div className="mw-actions">
              <button className="btn" onClick={() => void save()} disabled={!mayDesign || busy === 'template'}>
                {busy === 'template' ? <Loader2 size={13} className="spin" /> : null} Save design
              </button>
              <button className="btn ghost" onClick={() => setDraft(template)}>Discard changes</button>
            </div>
          </div>
          <Note>
            The design changes how a report looks and nothing about what it says. Values, units and analyser flags
            always print as they were received.
          </Note>
        </Panel>
      </div>

      <div className="mw-main">
        <Panel
          title="Preview"
          subtitle="The most recent transmitted result, as it will print."
          actions={<button className="btn ghost" onClick={() => void refresh()}><Image size={13} /> Refresh</button>}
        >
          {preview ? <Sheet html={preview} title="Report preview" tall />
            : <Note>Save the design, or choose a result on the Reports tab, to see a preview.</Note>}
        </Panel>
      </div>
    </div>
  );
}
