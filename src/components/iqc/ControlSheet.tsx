import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CalendarDays, Download, FileSpreadsheet, Loader2, Maximize2, Minimize2,
  Printer, Repeat, SlidersHorizontal, Upload, X,
} from 'lucide-react';
import { api, API_BASE, getToken, errorText } from '../../services/api';
import { usePermissions } from '../../hooks/usePermissions';
import {
  buildSheet, daysOfWindow, periodLabel, rowsOfLot,
  type SheetControlLike, type SheetRow, type SheetSeries,
} from '../../../shared/constants/iqcSeries';
import { OCCURRENCE_STATE_LABELS } from '../../../shared/constants/iqcProgramme';

/**
 * The control schedule as a month's sheet.
 *
 * It is the environmental monitoring log sheet, deliberately: a sheet per
 * control down the left, the days of the month across the top, a row for each
 * thing being recorded and a cell that is either marked or visibly empty. A
 * supervisor who has signed a paper QC chart for twenty years should recognise
 * this at a glance, and that recognition is worth more than any arrangement a
 * screen could invent.
 *
 * Three things it says that a list of runs cannot.
 *
 * A SERIES IS ONE CONTROL. Eight consecutive lots of XN CHECK Level 1 are not
 * eight controls, they are one control that has been running for two years. So
 * the sheet is the series, and the lots are its rows — each stretched across
 * exactly the days it was in use for.
 *
 * A DAY BELONGS TO A LOT. Outside a lot's period its cells are shaded and
 * dead: nothing was expected of it then and nothing may be recorded against it
 * either, exactly as this sheet's environmental cousin will not take a reading
 * for a day that has not happened yet. A month no lot of the series reaches
 * into is not on the sheet at all, because a control the laboratory was not
 * running is not a control it missed.
 *
 * MISSING IS VISIBLE. A scheduled day with no run is hatched, not blank. The
 * whole value of a chart is that it shows what was not done.
 */

const DAY_WIDTH = 30;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

const CELL_LABELS: Record<string, string> = {
  ...OCCURRENCE_STATE_LABELS,
  out_of_use: 'Lot not in use',
  not_scheduled: 'Not scheduled',
};

/** The states a legend has to explain, in the order a reader meets them. */
const LEGEND: Array<[string, string]> = [
  ['in_control', 'Run, in control'],
  ['warning', 'Warning'],
  ['rejected', 'Rejected'],
  ['missed', 'Not run'],
  ['excused', 'Accounted for'],
  ['due', 'Due'],
  ['out_of_use', 'Lot not in use'],
];

export default function ControlSheet<T extends SheetControlLike>({
  controls, from, to, sectionId, canRecord, onOpenDay, onPlan, onProblem, onReloaded,
}: {
  /** The programme's own answer for this unit and month. */
  controls: T[];
  from: string;
  to: string;
  sectionId: number | null;
  canRecord: boolean;
  /** Open the day: what became of it, and the two ways to close it. */
  onOpenDay: (control: T, date: string, days: T['days']) => void;
  /** Open the control's plan — which days and shifts it is expected on. */
  onPlan: (control: T) => void;
  onProblem: (message: string) => void;
  /** A month loaded from a workbook changes the answer, so it is re-read. */
  onReloaded: () => void;
}) {
  const { can } = usePermissions();
  const today = new Date().toISOString().slice(0, 10);
  const days = useMemo(() => daysOfWindow(from, to), [from, to]);
  const series = useMemo(() => buildSheet(controls, from, to), [controls, from, to]);

  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  // The chosen sheet survives stepping to another month wherever that series
  // is still in use, and falls back to the first rather than to nothing.
  useEffect(() => {
    if (series.length === 0) { setActiveKey(null); return; }
    setActiveKey(current => (current && series.some(s => s.key === current) ? current : series[0].key));
  }, [series]);

  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setExpanded(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded]);

  const active = series.find(s => s.key === activeKey) ?? null;
  const month = from.slice(0, 7);

  if (series.length === 0) {
    return (
      <p className="muted">
        No control of this unit was in use in {MONTHS[Number(month.slice(5, 7)) - 1]} {month.slice(0, 4)}.
        A lot appears on the sheet for the days it was in use, so give each lot the period it was in use for.
      </p>
    );
  }

  const grid = active && (
    <Grid series={active} days={days} today={today} canRecord={canRecord}
      onOpenDay={onOpenDay} onPlan={onPlan} />
  );

  return (
    <div className={`iqs-wrap${expanded ? ' is-expanded' : ''}`}>
      <div className="rs-split">
        <div className="rs-list">
          <ul className="iqs-picker">
            {series.map(group => {
              const tone = group.missed ? 'crit' : group.compliance == null ? 'none'
                : group.compliance >= 95 ? 'ok' : 'warn';
              return (
                <li key={group.key}>
                  <button type="button" className={`iqs-pick t-${tone}${group.key === activeKey ? ' is-active' : ''}`}
                    aria-current={group.key === activeKey || undefined}
                    onClick={() => setActiveKey(group.key)}>
                    <span className="iqs-pick-dot" aria-hidden="true" />
                    <span className="iqs-pick-body">
                      <span className="iqs-pick-name" title={group.name}>{group.name}</span>
                      <span className="iqs-pick-meta">
                        <span>{group.lots.length} lot{group.lots.length === 1 ? '' : 's'} in use</span>
                        {group.compliance != null && <span className="iqs-pick-pct">{group.compliance}%</span>}
                        {group.missed > 0 && <span className="crit">{group.missed} not run</span>}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>

        <div className="rs-grid">
          {!active ? <p className="muted">Choose a control on the left.</p> : (
            <>
              <header className="iqs-head">
                <div>
                  <h5>{active.name}</h5>
                  <p className="iqs-sub">
                    {active.testName}
                    {active.equipmentName ? ` · ${active.equipmentName}` : ''}
                    {' · '}{active.lotCount} lot{active.lotCount === 1 ? '' : 's'} in the series
                  </p>
                </div>
                <SheetActions series={active} month={month} sectionId={sectionId}
                  mayPrint={can('iqc', 'print')} mayExport={can('iqc', 'export')}
                  mayImport={can('iqc', 'import') && canRecord}
                  expanded={expanded} onToggleExpand={() => setExpanded(v => !v)}
                  onProblem={onProblem} onReloaded={onReloaded} />
              </header>

              {active.changeovers.length > 0 && (
                <p className="iqs-note">
                  <Repeat size={12} /> Lot changeover: {active.changeovers
                    .map(c => `${c.earlier} and ${c.later} were both in use ${c.from} to ${c.to}`)
                    .join('; ')}. Both lots take runs on those days.
                </p>
              )}
              {active.runsOutsidePeriod > 0 && (
                <p className="iqs-note warn">
                  {active.runsOutsidePeriod} run{active.runsOutsidePeriod === 1 ? ' is' : 's are'} recorded outside
                  the period of the lot {active.runsOutsidePeriod === 1 ? 'it belongs' : 'they belong'} to. Nothing has
                  been moved or hidden — correct the lot&rsquo;s period if the dates are wrong.
                </p>
              )}
              {active.uncovered > 0 && (
                <p className="iqs-note warn">
                  {active.uncovered} day{active.uncovered === 1 ? '' : 's'} in this month with no lot of this control
                  in use. Register the lot that covered {active.uncovered === 1 ? 'it' : 'them'}, or extend a
                  lot&rsquo;s period.
                </p>
              )}

              {grid}
              <Legend />
            </>
          )}
        </div>
      </div>

      {expanded && active && (
        <div className="iqs-expand" role="dialog" aria-modal="true" aria-label={active.name}
          onClick={e => { if (e.target === e.currentTarget) setExpanded(false); }}>
          <div className="iqs-expand-panel">
            <button type="button" className="iqs-expand-close" onClick={() => setExpanded(false)} aria-label="Close the window">
              <X size={15} />
            </button>
            <header className="iqs-head">
              <div>
                <h5>{active.name}</h5>
                <p className="iqs-sub">{MONTHS[Number(month.slice(5, 7)) - 1]} {month.slice(0, 4)} · {active.testName}</p>
              </div>
            </header>
            <div className="iqs-expand-body">{grid}<Legend /></div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ----------------------------------------------------------------------------
   The grid
   ------------------------------------------------------------------------- */
function Grid<T extends SheetControlLike>({ series, days, today, canRecord, onOpenDay, onPlan }: {
  series: SheetSeries<T>; days: string[]; today: string; canRecord: boolean;
  onOpenDay: (control: T, date: string, days: T['days']) => void;
  onPlan: (control: T) => void;
}) {
  const rows = useMemo(
    () => series.lots.flatMap(lot => rowsOfLot(lot, days, today)) as Array<SheetRow<T>>,
    [series, days, today],
  );
  /*
   * A shift column, only where there are shifts.
   *
   * The environmental sheet always carries AM and PM because every parameter
   * on it is read twice a day. A control is mostly run once, so the column
   * appears for the series that is run per shift and nowhere else — a column
   * of "Day" against every row is a column that teaches people to ignore the
   * header.
   */
  const split = rows.some(row => row.shift);

  return (
    <div className="iqs-scroll" style={{ ['--iqs-day' as string]: `${DAY_WIDTH}px` }}>
      <table className="iqs-grid">
        <thead>
          <tr>
            <th className="iqs-rowhead">Lot</th>
            <th className="iqs-period">In use</th>
            {split && <th className="iqs-shift">Shift</th>}
            {days.map(date => (
              <th key={date} className={`iqs-day${date === today ? ' is-today' : ''}`} title={date}>
                {Number(date.slice(8, 10))}
              </th>
            ))}
            <th className="iqs-num">Done</th>
            <th className="iqs-num">Not run</th>
            <th className="iqs-num">%</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const first = index === 0 || rows[index - 1].lot.id !== row.lot.id;
            const span = rows.filter(r => r.lot.id === row.lot.id).length;
            const performed = row.cells.filter(c => ['in_control', 'warning', 'rejected'].includes(c.state)).length;
            const missed = row.cells.filter(c => c.state === 'missed').length;
            const compliance = performed + missed === 0 ? null : Math.round((performed / (performed + missed)) * 100);
            return (
              <tr key={row.key} className={first ? 'iqs-row-first' : ''}>
                {first && (
                  <th className="iqs-rowhead" rowSpan={span}>
                    <button type="button" className="iqs-lot" onClick={() => onPlan(row.lot)}
                      title="What this lot is expected to do, and when">
                      <strong>Lot {row.lot.lotNumber}</strong>
                      <span className="iqs-sched">
                        <SlidersHorizontal size={10} /> {row.lot.schedule.summary}
                        {row.lot.schedule.isDefault ? ' (from its frequency)' : ''}
                      </span>
                    </button>
                  </th>
                )}
                {first && <td className="iqs-period" rowSpan={span}>{periodLabel(row.lot)}</td>}
                {split && <th className="iqs-shift">{row.shift ?? 'Day'}</th>}
                {row.cells.map(cell => {
                  const label = `${cell.date}${row.shift ? ` · ${row.shift}` : ''} · ${CELL_LABELS[cell.state] ?? cell.state}`;
                  return (
                    <td key={cell.date} className={cell.date === today ? 'is-today' : undefined}>
                      <button type="button" className={`iqs-cell s-${cell.state}`}
                        title={cell.reason ? `${label} — ${cell.reason}` : label}
                        aria-label={label}
                        disabled={cell.frozen || (!cell.runId && !canRecord && cell.state !== 'excused')}
                        onClick={() => onOpenDay(row.lot, cell.date, row.lot.days.filter(
                          d => d.date === cell.date && (row.shift === null || d.shift === null || d.shift === row.shift),
                        ))}>
                        {cell.count > 1 && <span className="iqs-count">{cell.count}</span>}
                      </button>
                    </td>
                  );
                })}
                <td className="iqs-num">{performed}</td>
                <td className={`iqs-num${missed ? ' crit' : ''}`}>{missed}</td>
                <td className="iqs-num">{compliance == null ? '—' : `${compliance}%`}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Legend() {
  return (
    <div className="iqs-legend">
      {LEGEND.map(([state, label]) => (
        <span key={state}><i className={`iqs-sw s-${state}`} /> {label}</span>
      ))}
    </div>
  );
}

/* ----------------------------------------------------------------------------
   Print, Excel, and a month filled in offline
   ------------------------------------------------------------------------- */
function SheetActions<T extends SheetControlLike>({
  series, month, sectionId, mayPrint, mayExport, mayImport, expanded, onToggleExpand, onProblem, onReloaded,
}: {
  series: SheetSeries<T>; month: string; sectionId: number | null;
  mayPrint: boolean; mayExport: boolean; mayImport: boolean;
  expanded: boolean; onToggleExpand: () => void;
  onProblem: (message: string) => void; onReloaded: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const importRef = useRef<HTMLInputElement>(null);

  const query = () => {
    const params = new URLSearchParams({ month, seriesId: String(series.seriesId) });
    if (sectionId != null) params.set('sectionId', String(sectionId));
    return params.toString();
  };

  /*
   * The export endpoints need the bearer token, which a plain link cannot
   * send, so the file is fetched and handed to the browser as a blob — the
   * same way every other printable record in this system is opened.
   */
  function openAuthed(path: string, filename?: string) {
    setBusy(path);
    fetch(`${API_BASE}${path}`, { headers: { Authorization: `Bearer ${getToken() ?? ''}` } })
      .then(async response => {
        if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || response.statusText);
        const url = URL.createObjectURL(await response.blob());
        if (path.includes('/print')) {
          if (!window.open(url, '_blank')) {
            throw new Error('Your browser blocked the print window. Allow pop-ups for this site and try again.');
          }
        } else {
          const anchor = document.createElement('a');
          anchor.href = url;
          anchor.download = filename ?? `${series.name.replace(/[^a-z0-9]+/gi, '_')}_${month}.xlsx`;
          anchor.click();
        }
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      })
      .catch(e => onProblem(errorText(e)))
      .finally(() => setBusy(null));
  }

  async function loadMonth(file: File) {
    setBusy('import');
    const body = new FormData();
    body.append('file', file);
    try {
      const outcome = await api<{ created: number; readings: number; rejected: number; errors: string[] }>(
        '/iqc/runs/import', { method: 'POST', body });
      if (outcome.errors?.length) onProblem(outcome.errors.slice(0, 6).join(' '));
      onReloaded();
    } catch (e) { onProblem(errorText(e)); }
    finally { setBusy(null); }
  }

  const spinning = (key: string) => busy === key;

  return (
    <div className="iqs-actions">
      <button type="button" className="pq-link" onClick={onToggleExpand}
        title={expanded ? 'Back to the page' : 'Open the sheet in a larger window'}>
        {expanded ? <><Minimize2 size={12} /> Close</> : <><Maximize2 size={12} /> Expand</>}
      </button>
      {mayPrint && (
        <button type="button" className="pq-link" onClick={() => openAuthed(`/iqc/programme/sheet/print?${query()}`)}
          title="The sheet as the laboratory knows it, ready to print or save as PDF">
          {spinning(`/iqc/programme/sheet/print?${query()}`) ? <Loader2 size={12} className="pd-spin" /> : <Printer size={12} />} Print
        </button>
      )}
      {mayExport && (
        <>
          <button type="button" className="pq-link" onClick={() => openAuthed(`/iqc/programme/sheet/export.xlsx?${query()}`)}
            title="This grid as a workbook, a row per lot and a column per day">
            <Download size={12} /> Excel
          </button>
          <button type="button" className="pq-link"
            onClick={() => openAuthed(`/iqc/programme/sheet/template.xlsx?${query()}`,
              `Control_runs_blank_${month}.xlsx`)}
            title="A blank month: every day this control is expected on, against the lot that was in use — fill in the results offline and load it back">
            <FileSpreadsheet size={12} /> Blank month
          </button>
        </>
      )}
      {mayImport && (
        <>
          <button type="button" className="pq-link" onClick={() => importRef.current?.click()}
            title="Load a filled blank month back in. Every row is evaluated exactly as a run typed at the bench.">
            {spinning('import') ? <Loader2 size={12} className="pd-spin" /> : <Upload size={12} />} Load a month
          </button>
          <input ref={importRef} type="file" hidden accept=".xlsx,.xls,.csv"
            onChange={e => { const f = e.target.files?.[0]; if (f) void loadMonth(f); e.target.value = ''; }} />
        </>
      )}
    </div>
  );
}

export { CalendarDays as SheetMonthIcon };
