import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  AlertTriangle, ArrowRight, Beaker, Check, CheckCircle2, ClipboardPaste, Clock, MonitorPlay,
  Download, FileSpreadsheet, FileUp, Keyboard, LineChart, Loader2, Lock, Plus,
  Printer, Radio, ScanLine, ShieldAlert, Table2, Upload, X, XCircle,
} from 'lucide-react';
import { api, API_BASE, getToken, errorText } from '../../services/api';
import { downloadXlsx, openPrintable } from '../../services/xlsx';
import { usePermissions } from '../../hooks/usePermissions';
import TextField from '../../components/ui/TextField';
import {
  IQC_ENTRY_METHOD_LABELS, IQC_ENTRY_METHOD_HINTS, type IqcEntryMethod,
} from '../../../shared/constants/routineWork';
import {
  QUALITATIVE_LABELS, RULE_LABELS, scaleForOutcome,
  AST_INTERPRETATIONS, AST_INTERPRETATION_LABELS,
} from '../../../shared/constants/iqc';
import LeveyJenningsChart, { type ChartData } from '../../components/LeveyJenningsChart';
import { useAnalyserListen, armAnalyser } from '../../hooks/useAnalyserListen';
import LiveTransmission from '../../components/instruments/LiveTransmission';
import TransmissionsDialog, { type Transmission } from '../../components/instruments/TransmissionsDialog';
import type {
  IqcBoard, IqcBoardControl, IqcMapping, IqcFeedMessage, IqcChartAnalyte,
} from '../../../shared/types/api';
import PortalIqcCoverage from './PortalIqcCoverage';

/**
 * IQC on the bench.
 *
 * The control has always been definable and judgeable; what was missing was the
 * thirty seconds at 8am when somebody actually runs it. This is that thirty
 * seconds.
 *
 * The board answers one question per instrument — has this been controlled
 * today, and did it pass — and everybody in the unit can read it, because a
 * technician about to release a result off the chemistry analyser is entitled
 * to know whether its controls have been run. Only somebody holding the
 * technical tier gets the buttons.
 *
 * Then there is the problem that actually stops control records being kept: an
 * FBC control is twenty-three parameters on three levels, every day. Typing
 * sixty-nine numbers off a printout is not a workflow, it is a reason to stop.
 * So the numbers can arrive five ways — typed, pasted, filled into a
 * spreadsheet, read out of the analyser's own export, or read off a scan of the
 * printout — and every one of them lands in the same run through the same
 * Westgard evaluation. What changes is the door; the room is the same.
 *
 * Receiving them from the analyser over the network is NOT a sixth door, and
 * offering it as one was a mistake worth naming. It is a way of filling the
 * form rather than a different form: the boxes stay typeable while the analyser
 * is listened to, and whatever arrives lands in those same boxes. Put beside
 * "type each value" as an alternative, it produced two buttons that did the
 * same thing and a choice between a thing and itself. It now sits on the form,
 * once, beside the boxes it fills.
 *
 * Every route that reads numbers from somewhere shows the bench what it thinks
 * it found, lined up against the control's own parameters, BEFORE anything is
 * saved. A system that decides column four is MCHC and is wrong has written a
 * false control record with a real name on it.
 */

const METHOD_ICONS: Record<IqcEntryMethod, ReactNode> = {
  manual: <Keyboard size={13} />,
  paste: <ClipboardPaste size={13} />,
  worksheet: <Table2 size={13} />,
  upload: <FileUp size={13} />,
  scan: <ScanLine size={13} />,
  instrument: <Radio size={13} />,
};

type QcFace = 'board' | 'charts';

export default function PortalRoutineIqc({ sectionId }: { sectionId?: number | null } = {}) {
  const [board, setBoard] = useState<IqcBoard | null>(null);
  const [loading, setLoading] = useState(true);
  const [problem, setProblem] = useState<string | null>(null);
  const [openControl, setOpenControl] = useState<IqcBoardControl | null>(null);
  const [chartControl, setChartControl] = useState<IqcBoardControl | null>(null);
  const [showFeed, setShowFeed] = useState(false);
  const [face, setFace] = useState<QcFace>('board');

  const load = useCallback(async () => {
    try { setBoard(await api<IqcBoard>(`/iqc/portal/board${sectionId ? `?sectionId=${sectionId}` : ''}`)); setProblem(null); }
    catch (e) { setProblem(errorText(e)); }
    finally { setLoading(false); }
  }, [sectionId]);

  useEffect(() => { void load(); }, [load]);

  if (loading) return <div className="portal-loading">Reading your unit&rsquo;s controls…</div>;
  if (!board) return <p className="pd-error"><AlertTriangle size={13} /> {problem}</p>;

  if (board.message) {
    return (
      <section className="portal-panel">
        <div className="pp-head"><div><h3><Beaker size={16} /> Internal quality control</h3></div></div>
        <p className="muted">{board.message}</p>
      </section>
    );
  }

  const { counts } = board;

  const controls = board.groups.flatMap(g => g.controls);

  return (
    <div className="portal-stack">
      {/* Two faces of the same work: run today's controls, or look at the chart
          and the record behind them. Setting a new control up is not a third
          place to be — it is a button on the panel that lists them, and it
          opens the module's own wizard. */}
      <nav className="rw-faces" aria-label="Quality control">
        <button type="button" className={face === 'board' ? 'is-on' : ''} onClick={() => setFace('board')}>
          <Beaker size={13} /> Today&rsquo;s controls
        </button>
        <button type="button" className={face === 'charts' ? 'is-on' : ''} onClick={() => setFace('charts')}>
          <LineChart size={13} /> Charts and records
        </button>
      </nav>

      {face === 'charts' && (
        <ChartsFace controls={controls} onOpen={setChartControl} />
      )}

      {face === 'board' && (
      <section className="portal-panel">
        <div className="pp-head">
          <div>
            <h3>Internal quality control</h3>
            <p>Today&rsquo;s controls for this unit.</p>
          </div>
          {counts.due > 0 && <span className="pp-count">{counts.due}</span>}
        </div>

        {problem && <p className="pd-error"><AlertTriangle size={13} /> {problem}</p>}

        <div className="iqc-counts">
          <Stat label="Not yet run today" value={counts.due} tone={counts.due ? 'warn' : 'ok'} />
          <Stat label="Run today" value={counts.done} tone="ok" />
          <Stat label="Failed" value={counts.failed} tone={counts.failed ? 'crit' : 'ok'} />
          <Stat label="Waiting to be accepted" value={counts.pendingReview} tone={counts.pendingReview ? 'warn' : 'ok'} />
          {counts.expired > 0 && <Stat label="Lot expired" value={counts.expired} tone="crit" />}
        </div>

        {counts.pendingFeed > 0 && (
          <p className="iqc-feed-banner">
            <Radio size={13} />
            {counts.pendingFeed} control {counts.pendingFeed === 1 ? 'result has' : 'results have'} arrived from the
            analysers and {counts.pendingFeed === 1 ? 'is' : 'are'} waiting for somebody to accept {counts.pendingFeed === 1 ? 'it' : 'them'}.
            <button type="button" className="pq-link" onClick={() => setShowFeed(true)}>Open them <ArrowRight size={11} /></button>
          </p>
        )}

        {!board.canPerform && (
          <p className="rw-locked">
            <Lock size={11} /> You can view controls but not run them.
          </p>
        )}

        {board.groups.length === 0 ? (
          <p className="muted">No controls are set up for this unit yet.</p>
        ) : (
          board.groups.map(group => (
            <div key={group.key} className="iqc-group">
              <h4>
                {group.name}
                {group.equipmentNumber && <span className="iqc-eqno">{group.equipmentNumber}</span>}
                <span className="iqc-group-count">{group.controls.length}</span>
              </h4>
              <ul className="iqc-list">
                {group.controls.map(control => (
                  <ControlRow key={control.id} control={control} canPerform={board.canPerform}
                    onOpen={() => setOpenControl(control)} onChart={() => setChartControl(control)} />
                ))}
              </ul>
            </div>
          ))
        )}

        {board.misfiled.length > 0 && (
          <div className="iqc-misfiled">
            <AlertTriangle size={13} />
            <div>
              <strong>{board.misfiled.length} control{board.misfiled.length === 1 ? '' : 's'} cannot be run here.</strong>
              <ul>{board.misfiled.map(m => <li key={m.id}>{m.materialName}: {m.why}</li>)}</ul>
            </div>
          </div>
        )}
      </section>
      )}

      {chartControl && <ChartDialog control={chartControl} onClose={() => setChartControl(null)} />}

      <PortalIqcCoverage onChanged={load} sectionId={sectionId ?? null} />

      {openControl && (
        <RunControlDialog control={openControl} sectionId={sectionId ?? null}
          onClose={() => setOpenControl(null)}
          onSaved={() => { setOpenControl(null); void load(); }} />
      )}
      {showFeed && (
        <FeedDialog sectionId={sectionId ?? null} onClose={() => setShowFeed(false)} onChanged={load} />
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className={`iqc-stat tone-${tone}`}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

/* ----------------------------------------------------------------------------
   Charts and records

   Two things a bench needs after running a control and cannot get from the
   board: where the point landed on the chart, and a printable record of what
   was run against what it should have been. Both are here, because sending
   somebody to another module to see their own morning's work is how charts end
   up looked at monthly.
   ------------------------------------------------------------------------- */
function ChartsFace({ controls, onOpen }: { controls: IqcBoardControl[]; onOpen: (c: IqcBoardControl) => void }) {
  const { can } = usePermissions();
  const [picked, setPicked] = useState<number[]>([]);
  const [from, setFrom] = useState(() => new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10));
  const [to, setTo] = useState(() => new Date().toISOString().slice(0, 10));

  const toggle = (id: number) =>
    setPicked(list => (list.includes(id) ? list.filter(x => x !== id) : [...list, id]));

  /** The report endpoints are downloads, so they are opened with the session token. */
  const reportUrl = (path: string) => {
    const params = new URLSearchParams({ from, to, charts: '1', materialIds: picked.join(',') });
    return `${path}?${params.toString()}`;
  };

  return (
    <section className="portal-panel">
      <div className="pp-head">
        <div>
          <h3><LineChart size={16} /> Charts and records</h3>
        </div>
      </div>

      {controls.length === 0 ? (
        <p className="muted">No controls are set up against your unit yet.</p>
      ) : (
        <>
          <ul className="iqc-chart-picks">
            {controls.map(control => (
              <li key={control.id}>
                <label className="ls-check">
                  <input type="checkbox" checked={picked.includes(control.id)} onChange={() => toggle(control.id)} />
                  <span>
                    <strong>{control.materialName}</strong>
                    <em> {control.testName} · lot {control.lotNumber}{control.levelLabel ? ` · ${control.levelLabel}` : ''}</em>
                  </span>
                </label>
                <button type="button" className="pq-link" onClick={() => onOpen(control)}>
                  <LineChart size={12} /> View the chart
                </button>
              </li>
            ))}
          </ul>

          <div className="iqc-report-bar">
            <label><span>From</span><input type="date" value={from} max={to} onChange={e => setFrom(e.target.value)} /></label>
            <label><span>To</span><input type="date" value={to} min={from} onChange={e => setTo(e.target.value)} /></label>
            {can('iqc', 'print') && (
              <ReportButton kind="print" path={reportUrl('/iqc/runs/report/print')} disabled={picked.length === 0}>
                <Printer size={13} /> Print the runs {picked.length ? `(${picked.length})` : ''}
              </ReportButton>
            )}
            {can('iqc', 'export') && (
              <ReportButton kind="export" path={reportUrl('/iqc/runs/report.xlsx')} name="Control_runs.xlsx" disabled={picked.length === 0}>
                <FileSpreadsheet size={13} /> Excel
              </ReportButton>
            )}
            {picked.length === 0 && <span className="muted">Tick the controls to include.</span>}
            {!can('iqc', 'print') && !can('iqc', 'export') && (
              <span className="muted">Taking a copy of the quality-control record needs the print or export right on Quality Control.</span>
            )}
          </div>
        </>
      )}
    </section>
  );
}

/**
 * A report button.
 *
 * The report endpoints need the session token in a header, so a plain link
 * would come back 401 in a new tab. The shared helpers fetch and hand the
 * result to the browser — the same ones the module toolbars use, so a portal
 * download behaves exactly like a module download.
 */
function ReportButton({ kind, path, name, disabled, children }: {
  kind: 'print' | 'export'; path: string; name?: string; disabled?: boolean; children: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <>
      <button type="button" className="pq-link" disabled={disabled || busy} onClick={async () => {
        setBusy(true); setProblem(null);
        try {
          if (kind === 'print') await openPrintable(path);
          else await downloadXlsx(path, name ?? 'report.xlsx');
        } catch (e) { setProblem(errorText(e)); }
        finally { setBusy(false); }
      }}>
        {busy ? <Loader2 size={13} className="pd-spin" /> : children}
      </button>
      {problem && <span className="pd-error">{problem}</span>}
    </>
  );
}

/** One control's charts, a parameter at a time. */
function ChartDialog({ control, onClose }: { control: IqcBoardControl; onClose: () => void }) {
  const { can } = usePermissions();
  const [analytes, setAnalytes] = useState<IqcChartAnalyte[] | null>(null);
  const [analyteId, setAnalyteId] = useState<number | null>(null);
  const [chart, setChart] = useState<ChartData | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    api<IqcChartAnalyte[]>(`/iqc/portal/controls/${control.id}/chart-analytes`)
      .then(list => {
        const quantitative = list.filter(a => Number(a.is_qualitative) !== 1);
        setAnalytes(quantitative);
        setAnalyteId(quantitative[0]?.id ?? null);
      })
      .catch(e => { setProblem(errorText(e)); setAnalytes([]); });
  }, [control.id]);

  useEffect(() => {
    if (!analyteId) { setChart(null); return; }
    setChart(null);
    api<ChartData>(`/iqc/portal/analytes/${analyteId}/chart`)
      .then(setChart)
      .catch(e => setProblem(errorText(e)));
  }, [analyteId]);

  return (
    <Modal title={`${control.materialName} — lot ${control.lotNumber}`} onClose={onClose}>
      {problem && <p className="pd-error"><AlertTriangle size={13} /> {problem}</p>}
      {analytes === null ? <p className="muted">Reading the parameters…</p>
        : analytes.length === 0 ? (
          <p className="muted">Nothing to chart for this control.</p>
        ) : (
          <>
            <div className="iqc-chart-tabs">
              {analytes.map(a => (
                <button key={a.id} type="button" className={a.id === analyteId ? 'is-on' : ''} onClick={() => setAnalyteId(a.id)}>
                  {a.analyte}
                </button>
              ))}
            </div>
            {chart ? <LeveyJenningsChart data={chart} /> : <p className="muted">Drawing the chart…</p>}
            <div className="iqc-report-bar">
              {can('iqc', 'print') && (
                <ReportButton kind="print" path={`/iqc/runs/report/print?materialIds=${control.id}&charts=1`}>
                  <Printer size={13} /> Print this control&rsquo;s runs with the chart
                </ReportButton>
              )}
              {can('iqc', 'export') && (
                <ReportButton kind="export" path={`/iqc/runs/report.xlsx?materialIds=${control.id}`}
                  name={`Control_runs_${control.lotNumber}.xlsx`}>
                  <FileSpreadsheet size={13} /> Excel
                </ReportButton>
              )}
            </div>
          </>
        )}
    </Modal>
  );
}

/* ----------------------------------------------------------------------------
   One control on the board
   ------------------------------------------------------------------------- */
function ControlRow({ control, canPerform, onOpen, onChart }: {
  control: IqcBoardControl; canPerform: boolean; onOpen: () => void; onChart: () => void;
}) {
  const latest = control.runsToday[0];
  const tone = control.expired ? 'crit'
    : control.statusToday === 'out_of_control' ? 'crit'
    : control.statusToday === 'warning' ? 'warn'
    : control.doneToday ? 'ok' : 'warn';

  return (
    <li className={`iqc-row t-${tone}`}>
      <span className={`iqc-rail ${tone}`} />
      <div className="iqc-row-main">
        <span className="iqc-row-title">
          {control.materialName}
          {control.levelLabel && <span className="badge">{control.levelLabel}</span>}
          {control.analyteCount > 1 && <span className="badge">{control.analyteCount} parameters</span>}
        </span>
        <span className="iqc-row-meta">
          <span>{control.testName}</span>
          <span>Lot {control.lotNumber}</span>
          {control.expiryDate && (
            <span className={control.expired ? 'crit' : ''}>
              {control.expired ? 'Lot expired ' : 'Expires '}{control.expiryDate}
            </span>
          )}
          {control.lastRunDate && !control.doneToday && <span>Last run {control.lastRunDate}</span>}
        </span>
        {latest && (
          <span className="iqc-row-result">
            {latest.status === 'out_of_control' ? <XCircle size={12} /> : <CheckCircle2 size={12} />}
            {latest.status === 'out_of_control' ? 'Out of control' : latest.status === 'warning' ? 'In control, with a warning' : 'In control'}
            {latest.run_time ? ` at ${latest.run_time}` : ''}
            {latest.operator_name ? ` · ${latest.operator_name}` : ''}
            {!latest.reviewed_at && <span className="badge warning">not yet accepted</span>}
            {latest.patient_results_released === 0 && <span className="badge overdue">patient results held</span>}
          </span>
        )}
      </div>
      <div className="iqc-row-side">
        <button type="button" className="pq-link" onClick={onChart} title="The Levey-Jennings chart and the runs behind it">
          <LineChart size={12} /> Chart
        </button>
        {control.expired ? (
          <span className="iqc-blocked" title="A control cannot be run on an expired lot; the result would not mean anything.">
            <ShieldAlert size={13} /> lot expired
          </span>
        ) : control.doneToday && control.statusToday !== 'out_of_control' ? (
          <>
            <span className="iqc-done"><CheckCircle2 size={15} /> done</span>
            {canPerform && <button type="button" className="pq-link" onClick={onOpen}>Run again</button>}
          </>
        ) : canPerform ? (
          <button type="button" className="duty-done" onClick={onOpen}>
            <Beaker size={14} /> {control.doneToday ? 'Repeat' : 'Run it'}
          </button>
        ) : (
          <span className="rw-watch"><Clock size={14} /> not yet run</span>
        )}
      </div>
    </li>
  );
}

/* ----------------------------------------------------------------------------
   Running one — the five doors into the same room
   ------------------------------------------------------------------------- */
/** One analyser link registered against this control's own instrument. */
type FeedChoice = {
  id: number; name: string; equipmentName: string | null;
  state: string; lastMessageAt: string | null; open: boolean; suggested: boolean;
  /** Can this link be asked for results, or only waited on? */
  canPull?: boolean;
};

type Detail = {
  material: any; analytes: any[]; recent: any[];
  layout: any; feed: any; feedOptions?: FeedChoice[]; feedWaiting: number;
  canPerform: boolean; canReview: boolean;
};

function RunControlDialog({ control, sectionId, onClose, onSaved }: {
  control: IqcBoardControl;
  /**
   * The unit whose board this control was opened from.
   *
   * Carried down here because the register of earlier transmissions is scoped
   * by unit on the server, and without being told which one it fell back to the
   * reader's own — so a senior post looking at the haematology board was told
   * "nothing matches that" about haematology's own transmissions.
   */
  sectionId: number | null;
  onClose: () => void; onSaved: () => void;
}) {
  const [detail, setDetail] = useState<Detail | null>(null);
  // 'instrument' is no longer one of these: see `methods` below. A control
  // whose stored preference is still that one opens on the plain form, with the
  // analyser one button away, rather than on a mode that no longer exists.
  const [method, setMethod] = useState<IqcEntryMethod>(
    control.preferredEntryMethod && control.preferredEntryMethod !== 'instrument'
      ? control.preferredEntryMethod as IqcEntryMethod : 'manual');
  const [values, setValues] = useState<Record<number, string>>({});
  const [mapping, setMapping] = useState<IqcMapping | null>(null);
  /**
   * The day the control was actually run.
   *
   * Today, because that is almost always the answer and nobody should have to
   * fill in a date to record this morning's control. But only almost always: a
   * run taken on the night shift and entered at handover, or a sheet caught up
   * on after a weekend, belongs on the day it was run — and stamping it today
   * would put a point on the wrong day of the Levey-Jennings chart and count a
   * missed day as done.
   */
  const [runDate, setRunDate] = useState(new Date().toISOString().slice(0, 10));
  const [runTime, setRunTime] = useState(new Date().toTimeString().slice(0, 5));
  const [reagentLot, setReagentLot] = useState('');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [verdict, setVerdict] = useState<any>(null);
  // The control material itself, or a sample this laboratory already tested —
  // the same choice the module offers, because a lot running out on a Sunday
  // does not wait for somebody to reach a desktop.
  const [runKind, setRunKind] = useState<'control' | 'retained_sample'>('control');
  const [samples, setSamples] = useState<any[]>([]);
  const [sampleId, setSampleId] = useState('');

  useEffect(() => {
    void (async () => {
      try {
        const next = await api<Detail>(`/iqc/portal/controls/${control.id}`);
        setDetail(next);
        if (!control.preferredEntryMethod && next.material.entryMethods?.length) {
          const first = (next.material.entryMethods as IqcEntryMethod[]).find(m => m !== 'instrument');
          if (first) setMethod(first);
        }
      } catch (e) { setProblem(errorText(e)); }
    })();
  }, [control.id, control.preferredEntryMethod]);

  useEffect(() => {
    if (runKind !== 'retained_sample') return;
    api<any[]>(`/iqc/portal/controls/${control.id}/retained-samples`)
      .then(setSamples).catch(() => setSamples([]));
  }, [control.id, runKind]);

  /**
   * How the numbers get in, minus the one that is not a way of getting them in.
   *
   * "Take it from the instrument" sat in this row beside "Type each value" as
   * though the two were alternatives. They are not. Choosing it opened a panel
   * with a Fetch button, while the value boxes underneath carried a Fetch
   * button of their own and stayed typeable throughout — so both choices led to
   * the same form, by two routes, with two buttons that did the same thing. A
   * bench cannot be asked to decide between a thing and itself.
   *
   * Receiving from the analyser is not a mode of entry; it is a way of filling
   * the form, like pasting is. It belongs on the form, once, beside the boxes
   * it fills — which is where it now is, and the only place it is. What stays
   * in this row are the routes that genuinely change what is on screen: a
   * spreadsheet, an upload, a scan.
   */
  const declared = (detail?.material.entryMethods ?? control.entryMethods ?? ['manual']) as IqcEntryMethod[];
  const methods = declared.filter(m => m !== 'instrument');
  const analytes = detail?.analytes ?? [];
  const qualitative = detail?.material.control_type === 'qualitative';
  const retained = runKind === 'retained_sample';
  const sample = samples.find(x => String(x.id) === sampleId);
  /** What the chosen sample originally gave for one parameter. */
  const originalFor = (analyteId: number) => sample?.values?.find(v => v.iqc_analyte_id === analyteId);

  /** Fold a parsed mapping into the value boxes, so every door ends in one form. */
  const applyMapping = useCallback((next: IqcMapping) => {
    setMapping(next);
    setValues(previous => {
      const merged = { ...previous };
      for (const reading of next.readings) {
        merged[reading.analyteId] = reading.value != null ? String(reading.value) : String(reading.qualitativeResult ?? '');
      }
      return merged;
    });
  }, []);

  const filled = analytes.filter(a => String(values[a.id] ?? '').trim() !== '').length;

  /**
   * Fetch, on the run itself rather than behind a tab.
   *
   * Taking the numbers off the analyser is the one route that does not involve
   * typing twenty-three of them, and it was reachable only by knowing that
   * "entry methods" existed and picking the right one. It belongs beside the
   * boxes it fills.
   */
  // Which analyser the bench is listening to: the control's own where it has
  // one, otherwise whichever this unit picks. Hiding the button because no row
  // matched left a bench with a transmitting analyser and no way to say so.
  const feedChoices: FeedChoice[] = detail?.feedOptions ?? [];
  const [feedLinkId, setFeedLinkId] = useState('');
  const [addingSample, setAddingSample] = useState(false);
  /** Watching the conversation while standing ready for it. */
  const [watching, setWatching] = useState(false);
  /** Every earlier transmission, searchable, when the one wanted is not new. */
  const [browsing, setBrowsing] = useState(false);
  /**
   * Which analyser this control is listened to on.
   *
   * The host only ever offers links registered against this control's own
   * instrument, so there is nothing here to guard against: the first one that
   * the bridge will actually open is the right default, and the picker below
   * appears only where that instrument carries more than one link.
   *
   * A control run is a statement about one instrument's performance, and an
   * accepted run cannot be un-attributed afterwards — so an analyser that was
   * never linked to this control is not offered at all, rather than offered
   * with a warning beside it.
   */
  const attached = feedChoices.find(l => l.open) ?? feedChoices[0];
  useEffect(() => {
    if (feedLinkId || !attached) return;
    setFeedLinkId(String(attached.id));
  }, [attached, feedLinkId]);
  const listeningTo = feedChoices.find(l => String(l.id) === feedLinkId) ?? null;

  const fetchListen = useAnalyserListen<IqcFeedMessage>({
    arm: () => armAnalyser(`/iqc/portal/controls/${control.id}/analyser-listen`,
      feedLinkId ? { linkId: Number(feedLinkId) } : undefined),
    /*
     * Scoped to the unit being looked at, and to the analyser being waited on.
     *
     * Neither was being sent, and the unit was the bug the bench was feeling:
     * the server scopes this list by unit, and with nothing told to it, it fell
     * back to the READER's own unit. So a control transmitted from the
     * haematology Sysmex arrived, was parked correctly, and was then filtered
     * out of the very poll that was standing there waiting for it — the bench
     * pressed Fetch Results, the LHIMS client reported success, and the boxes
     * stayed empty.
     */
    poll: since => {
      const q = new URLSearchParams({ since: String(since.control) });
      if (sectionId) q.set('sectionId', String(sectionId));
      if (feedLinkId) q.set('linkId', String(feedLinkId));
      return api<IqcFeedMessage[]>(`/iqc/portal/feed-messages?${q}`);
    },
    onArrival: async message => {
      try { applyMapping(await api<IqcMapping>(`/iqc/portal/feed-messages/${message.id}/mapping?materialId=${control.id}`)); }
      catch (e) { setProblem(errorText(e)); }
    },
  });

  async function save() {
    if (!detail) return;
    setBusy('save'); setProblem(null);
    const readings = analytes
      .filter(a => String(values[a.id] ?? '').trim() !== '')
      .map(a => {
        const raw = String(values[a.id]).trim();
        return qualitative || detail.material.control_type === 'culture_sensitivity'
          ? { analyteId: a.id, qualitativeResult: raw }
          : { analyteId: a.id, value: Number(raw) };
      });
    if (!readings.length) { setProblem('Enter at least one result before saving the run.'); setBusy(null); return; }
    if (retained && !sampleId) { setProblem('Choose the previously run sample you are re-reading.'); setBusy(null); return; }

    try {
      const result = await api<any>('/iqc/runs', {
        method: 'POST',
        body: JSON.stringify({
          iqcMaterialId: control.id,
          runKind,
          retainedSampleId: retained ? Number(sampleId) : undefined,
          runDate,
          runTime, reagentLot: reagentLot || undefined, comment: comment || undefined,
          equipmentId: control.equipmentId ?? undefined,
          entryMethod: method,
          readings,
        }),
      });
      setVerdict(result);
    } catch (e) { setProblem(errorText(e)); }
    finally { setBusy(null); }
  }

  if (verdict) {
    return (
      <Modal onClose={onSaved} title={verdict.status === 'out_of_control' ? 'The control failed' : 'Control recorded'}>
        <div className={`iqc-verdict v-${verdict.status}`}>
          <strong>
            {verdict.status === 'out_of_control' ? <XCircle size={16} /> : <CheckCircle2 size={16} />}
            {verdict.status === 'out_of_control' ? 'Out of control' : verdict.status === 'warning' ? 'In control, with a warning' : 'In control'}
          </strong>
          <span>{verdict.runNumber}</span>
        </div>
        {verdict.ruleSummary && (
          <p className="iqc-rule">{String(verdict.ruleSummary).split(',').map((r: string) => RULE_LABELS[r.trim()] ?? r.trim()).join('; ')}</p>
        )}
        {verdict.mayReleasePatientResults === false && (
          <p className="pd-error">
            <ShieldAlert size={13} /> Patient results on this examination are held until this is resolved.
            Investigate, record what you did, and repeat the control before releasing anything.
          </p>
        )}
        {Array.isArray(verdict.analytes) && (
          <ul className="iqc-verdict-list">
            {verdict.analytes.filter((a: any) => a.analyteId && a.status !== 'accepted').map((a: any) => (
              <li key={a.analyteId} className={a.status}>
                {analytes.find(x => x.id === a.analyteId)?.analyte}: {a.value ?? a.qualitativeResult}
                {a.zScore != null && <span> ({a.zScore.toFixed(2)} SD)</span>}
                {a.rule && <span className="badge overdue">{RULE_LABELS[a.rule] ?? a.rule}</span>}
              </li>
            ))}
          </ul>
        )}
        <div className="pr-btns"><button type="button" onClick={onSaved}>Close</button></div>
      </Modal>
    );
  }

  return (
    <Modal onClose={onClose} title={`${control.materialName}${control.levelLabel ? ` — ${control.levelLabel}` : ''}`}>
      {!detail ? <p className="muted">Opening the control…</p> : (
        <>
          <p className="iqc-modal-lead">
            {control.testName} · Lot {control.lotNumber} · {analytes.length} parameter{analytes.length === 1 ? '' : 's'}
            {control.equipmentName ? ` · ${control.equipmentName}` : ''}
          </p>

          {/* The control material itself, or a sample already tested. The same
              choice the module offers — a lot running out does not wait for
              somebody to reach a desktop. */}
          <div className="iqc-kind">
            <button type="button" className={!retained ? 'is-on' : ''} onClick={() => setRunKind('control')}>
              Control material
            </button>
            <button type="button" className={retained ? 'is-on' : ''} onClick={() => setRunKind('retained_sample')}>
              Previously run sample
            </button>
          </div>

          {retained && (
            <div className="iqc-kind-pick">
              <div className="iqc-sample-row">
                <span>Sample</span>
                <button type="button" className="iqc-sample-add" onClick={() => setAddingSample(v => !v)}>
                  {addingSample ? 'Cancel' : '+ Add a sample'}
                </button>
              </div>
              <select value={sampleId} onChange={e => setSampleId(e.target.value)}>
                <option value="">Choose a sample…</option>
                {samples.map(x => (
                  <option key={x.id} value={x.id}>
                    {x.sample_reference} · first tested {x.original_run_date}
                    {x.rerun_count ? ` · re-read ${x.rerun_count}×` : ''}
                  </option>
                ))}
              </select>
              {samples.length === 0 && !addingSample && (
                <span className="muted">
                  No sample is on this control&rsquo;s register yet. The register is kept per control, so a sample
                  enrolled on another control does not appear here. Add one above.
                </span>
              )}
              {sample && (
                <span className="muted">
                  Re-read against what it gave on {sample.original_run_date}
                  {sample.original_run_number ? `, covered by ${sample.original_run_number}` : ''}.
                </span>
              )}
              {addingSample && (
                <AddSample
                  controlId={control.id} sectionId={sectionId} analytes={analytes} qualitative={qualitative}
                  feedChoices={feedChoices} linkId={feedLinkId}
                  onProblem={setProblem}
                  onAdded={async id => {
                    setAddingSample(false);
                    const list = await api<any[]>(`/iqc/portal/controls/${control.id}/retained-samples`).catch(() => []);
                    setSamples(list);
                    setSampleId(String(id));
                  }} />
              )}
            </div>
          )}

          {methods.length > 1 && !retained && (
            <div className="iqc-methods">
              {methods.map(m => (
                <button key={m} type="button" className={method === m ? 'is-active' : ''}
                  onClick={() => setMethod(m)} title={IQC_ENTRY_METHOD_HINTS[m]}>
                  {METHOD_ICONS[m]} {IQC_ENTRY_METHOD_LABELS[m]}
                </button>
              ))}
            </div>
          )}
          {/* Only worth saying when there was a choice to make. */}
          {!retained && methods.length > 1 && <p className="iqc-method-hint">{IQC_ENTRY_METHOD_HINTS[method]}</p>}

          {!retained && method === 'paste' && <PastePanel controlId={control.id} onMapped={applyMapping} onProblem={setProblem} />}
          {!retained && method === 'worksheet' && <WorksheetPanel controlId={control.id} analytes={analytes} values={values} setValues={setValues} onProblem={setProblem} />}
          {!retained && method === 'upload' && <UploadPanel controlId={control.id} onMapped={applyMapping} onProblem={setProblem} />}
          {!retained && method === 'scan' && <ScanPanel controlId={control.id} onMapped={applyMapping} onProblem={setProblem} />}

          {mapping && <MappingReport mapping={mapping} />}

          {watching && feedLinkId && (
            <LiveTransmission linkId={Number(feedLinkId)} onClose={() => setWatching(false)} />
          )}

          {browsing && (
            <TransmissionsDialog
              endpoint="/iqc/portal/transmissions"
              scope={{ sectionId }}
              mapUrl={row => `/iqc/portal/feed-messages/${row.id}/mapping?materialId=${control.id}`}
              title="Earlier results from the analysers"
              onClose={() => setBrowsing(false)}
              onUse={async (row: Transmission) => {
                setBrowsing(false);
                try {
                  applyMapping(await api<IqcMapping>(
                    `/iqc/portal/feed-messages/${row.id}/mapping?materialId=${control.id}`));
                } catch (e) { setProblem(errorText(e)); }
              }} />
          )}

          <div className="iqc-entry">
            {/* The one place results are entered, and the one place they can be
                received. Type them, or let the analyser send them — same form,
                same boxes, one button. */}
            <div className="iqc-entry-head">
              <span>Results</span>
              {/* Only the links registered against this control's own
                  instrument. More than one is a real arrangement — a machine
                  read directly and also followed through a middleware's log —
                  so the picker stays; one is simply chosen. */}
              {feedChoices.length > 1 && (
                <select className="iqc-feed-pick" value={feedLinkId} onChange={e => setFeedLinkId(e.target.value)}>
                  {feedChoices.map(l => (
                    <option key={l.id} value={l.id}>{l.name}{l.equipmentName ? ` · ${l.equipmentName}` : ''}</option>
                  ))}
                </select>
              )}
              <button type="button" className={`iqc-fetch tiny${fetchListen.waiting ? ' is-waiting' : ''}`}
                disabled={!feedLinkId && !detail.feed}
                onClick={() => (fetchListen.waiting ? fetchListen.stop() : void fetchListen.start())}>
                {fetchListen.waiting
                  ? <><Loader2 size={11} className="pd-spin" /> Waiting… {fetchListen.remaining}s</>
                  : <><Radio size={11} /> Fetch Results</>}
              </button>
              {/* While it stands ready, the one thing somebody wants is to see
                  whether anything is reaching the host at all — rather than
                  watching a countdown and guessing. */}
              {feedLinkId && (
                <button type="button" className="iqc-watch" title="Watch the conversation with this analyser as it happens"
                  onClick={() => setWatching(true)}>
                  <MonitorPlay size={11} /> Watch live
                </button>
              )}
              <button type="button" className="pq-link" onClick={() => setBrowsing(true)}>Earlier results</button>
              <span className="muted">{filled} of {analytes.length} entered</span>
            </div>
            {fetchListen.waiting && (
              <p className="iqc-listening in-head">
                <span className="iqc-pulse" />
                Listening{listeningTo ? ` to ${listeningTo.name}` : ''}. Run the control on the analyser and
                transmit it as you would a patient sample; the results land in the boxes below.
              </p>
            )}
            {/* Two different reasons for there being nothing to fetch from,
                with two different remedies. Saying "no analyser" to both is how
                a bench concludes the button is broken. */}
            {!fetchListen.waiting && feedChoices.length === 0 && !detail.feed && (
              <p className="iqc-hint in-head">
                {detail.material.equipment_id
                  ? 'No analyser link is registered against this control\u2019s instrument, so there is nothing to fetch from. Enter the results below, or add one under Settings \u2192 Analyser Links.'
                  : 'This control does not say which instrument it runs on, so there is no analyser to fetch from. Enter the results below, or set its instrument on the control.'}
              </p>
            )}
            {!fetchListen.waiting && fetchListen.note && <p className="iqc-hint in-head">{fetchListen.note}</p>}
            {fetchListen.problem && <p className="iqc-hint in-head crit">{fetchListen.problem}</p>}
            <ul className="iqc-analytes">
              {analytes.map(a => {
                const raw = values[a.id] ?? '';
                const num = Number(raw);
                const out = !qualitative && raw !== '' && !Number.isNaN(num)
                  && ((a.acceptable_low != null && num < a.acceptable_low) || (a.acceptable_high != null && num > a.acceptable_high));
                const fromMapping = mapping?.readings.some(r => r.analyteId === a.id);
                return (
                  <li key={a.id} className={`${out ? 'is-out' : ''}${fromMapping ? ' is-mapped' : ''}`}>
                    <label>
                      <span className="iqc-an-name">{a.analyte}{a.unit ? <em> {a.unit}</em> : null}</span>
                      {detail.material.control_type === 'culture_sensitivity' ? (
                        <select value={raw} onChange={e => setValues(v => ({ ...v, [a.id]: e.target.value }))}>
                          <option value="">—</option>
                          {AST_INTERPRETATIONS.map(o => <option key={o} value={o}>{AST_INTERPRETATION_LABELS[o]}</option>)}
                        </select>
                      ) : qualitative ? (
                        /* Only the scale this control is defined on. A control
                           whose expected result is "Detected" is answered with
                           Detected or Not detected — offering "Positive" beside
                           them invites a reading the control cannot judge. */
                        <select value={raw} onChange={e => setValues(v => ({ ...v, [a.id]: e.target.value }))}>
                          <option value="">—</option>
                          {scaleForOutcome(a.expected_result).map(o => (
                            <option key={o} value={o}>{QUALITATIVE_LABELS[o]}</option>
                          ))}
                        </select>
                      ) : (
                        <TextField inputMode="decimal" value={raw}
                          onValue={next => setValues(v => ({ ...v, [a.id]: next }))} />
                      )}
                      <span className="iqc-an-range">
                        {retained
                          ? (originalFor(a.id)
                            ? `was ${originalFor(a.id)!.original_value ?? originalFor(a.id)!.original_qualitative_result ?? '—'}`
                            : 'not recorded')
                          : ''}
                        {retained ? '' : a.target_mean != null ? `mean ${a.target_mean}` : ''}
                        {a.acceptable_low != null || a.acceptable_high != null
                          ? ` ${a.acceptable_low ?? '−'}–${a.acceptable_high ?? '−'}` : ''}
                        {a.expected_result ? QUALITATIVE_LABELS[a.expected_result as keyof typeof QUALITATIVE_LABELS] ?? a.expected_result : ''}
                        {a.expected_interpretation ? AST_INTERPRETATION_LABELS[a.expected_interpretation as keyof typeof AST_INTERPRETATION_LABELS] ?? a.expected_interpretation : ''}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </div>

          <div className="iqc-run-meta">
            <label>
              <span>Date run</span>
              <input type="date" value={runDate} max={new Date().toISOString().slice(0, 10)}
                onChange={e => setRunDate(e.target.value)} />
            </label>
            <label><span>Time run</span><input type="time" value={runTime} onChange={e => setRunTime(e.target.value)} /></label>
            <label><span>Reagent lot</span><TextField value={reagentLot} onValue={setReagentLot} placeholder="optional" /></label>
          </div>
          {runDate !== new Date().toISOString().slice(0, 10) && (
            <p className="iqc-backdated">
              <AlertTriangle size={12} /> This run will be recorded against {runDate}, not today. The rules are
              evaluated against the runs that came before that date, which is what makes a caught-up entry honest.
            </p>
          )}
          <label>
            <span>Comment</span>
            <TextField value={comment} onValue={setComment} placeholder="Anything worth recording about this run" />
          </label>

          {problem && <p className="pd-error"><AlertTriangle size={13} /> {problem}</p>}

          <div className="pr-btns">
            <button type="button" disabled={busy === 'save' || filled === 0 || (retained && !sampleId)}
              onClick={() => void save()}>
              {busy === 'save' ? <Loader2 size={14} className="pd-spin" /> : <Check size={14} />}
              {retained ? ' Record the re-read' : ' Record the run'}
            </button>
            <button type="button" className="secondary" onClick={onClose}>Cancel</button>
          </div>
        </>
      )}
    </Modal>
  );
}

/* ----------------------------------------------------------------------------
   Door 2: paste a table
   ------------------------------------------------------------------------- */
/* ----------------------------------------------------------------------------
   Putting a sample on the register, from the bench
   ------------------------------------------------------------------------- */

/**
 * A lot runs out mid-morning and the bench re-reads a sample it already
 * reported. For that to be a control run at all, the system has to hold what
 * the sample gave the first time — and until now that record could only be
 * made at a desktop, which is not where the person holding the tube is.
 *
 * So the same enrolment lives here, cut to what the bench actually knows: the
 * laboratory number, the day it was reported, and the result. The result can
 * come off the analyser rather than off a printout, because the original run
 * went over the same wire as everything else.
 */
function AddSample({ controlId, sectionId, analytes, qualitative, feedChoices, linkId, onAdded, onProblem }: {
  controlId: number;
  /** The unit whose board this is, for the same reason the run dialog needs it. */
  sectionId: number | null;
  analytes: any[];
  qualitative: boolean;
  feedChoices: FeedChoice[];
  linkId: string;
  onAdded: (id: number) => void | Promise<void>;
  onProblem: (message: string | null) => void;
}) {
  const [reference, setReference] = useState('');
  const [runDate, setRunDate] = useState(new Date().toISOString().slice(0, 10));
  const [originals, setOriginals] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);

  const listen = useAnalyserListen<IqcFeedMessage>({
    arm: () => armAnalyser(`/iqc/portal/controls/${controlId}/analyser-listen`,
      linkId ? { linkId: Number(linkId) } : undefined),
    /*
     * Scoped to the unit being looked at, and to the analyser being waited on.
     *
     * Neither was being sent, and the unit was the bug the bench was feeling:
     * the server scopes this list by unit, and with nothing told to it, it fell
     * back to the READER's own unit. So a control transmitted from the
     * haematology Sysmex arrived, was parked correctly, and was then filtered
     * out of the very poll that was standing there waiting for it — the bench
     * pressed Fetch Results, the LHIMS client reported success, and the boxes
     * stayed empty.
     */
    poll: since => {
      const q = new URLSearchParams({ since: String(since.control) });
      if (sectionId) q.set('sectionId', String(sectionId));
      if (linkId) q.set('linkId', String(linkId));
      return api<IqcFeedMessage[]>(`/iqc/portal/feed-messages?${q}`);
    },
    onArrival: async message => {
      try {
        const mapped = await api<IqcMapping>(`/iqc/portal/feed-messages/${message.id}/mapping?materialId=${controlId}`);
        setOriginals(prev => {
          const next = { ...prev };
          for (const r of mapped.readings ?? []) {
            if (r.analyteId == null) continue;
            const v = r.value ?? r.qualitativeResult;
            if (v !== null && v !== undefined && String(v) !== '') next[r.analyteId] = String(v);
          }
          return next;
        });
        if (!reference && message.sample_id) setReference(String(message.sample_id));
      } catch (e) { onProblem(errorText(e)); }
    },
  });

  async function save() {
    const values = analytes
      .filter(a => String(originals[a.id] ?? '').trim() !== '')
      .map(a => (qualitative
        ? { analyteId: a.id, originalQualitativeResult: String(originals[a.id]).trim() }
        : { analyteId: a.id, originalValue: Number(String(originals[a.id]).trim()) }));
    if (!reference.trim()) return onProblem('Give the laboratory number the sample was reported under.');
    if (!values.length) return onProblem('Record what the sample originally gave for at least one parameter.');
    setBusy(true); onProblem(null);
    try {
      const created = await api<{ id: number }>('/iqc/retained-samples', {
        method: 'POST',
        body: JSON.stringify({ iqcMaterialId: controlId, sampleReference: reference.trim(), originalRunDate: runDate, values }),
      });
      await onAdded(created.id);
    } catch (e) { onProblem(errorText(e)); }
    finally { setBusy(false); }
  }

  return (
    <div className="iqc-addsample">
      <div className="iqc-addsample-top">
        <label>
          <span>Sample number</span>
          <TextField value={reference} onValue={setReference} placeholder="laboratory number it was reported under" />
        </label>
        <label>
          <span>First tested</span>
          <input type="date" value={runDate} max={new Date().toISOString().slice(0, 10)}
            onChange={e => setRunDate(e.target.value)} />
        </label>
        <button type="button" className={`iqc-fetch tiny${listen.waiting ? ' is-waiting' : ''}`}
          disabled={feedChoices.length === 0}
          onClick={() => (listen.waiting ? listen.stop() : void listen.start())}>
          {listen.waiting
            ? <><Loader2 size={11} className="pd-spin" /> Waiting… {listen.remaining}s</>
            : <><Radio size={11} /> Fetch</>}
        </button>
      </div>
      {listen.waiting && (
        <p className="iqc-listening">
          <span className="iqc-pulse" />
          Ready. Send the sample from the analyser and what it gave drops in below.
        </p>
      )}
      {!listen.waiting && listen.note && <p className="iqc-hint">{listen.note}</p>}
      {listen.problem && <p className="iqc-hint crit">{listen.problem}</p>}

      <p className="iqc-hint">What it gave the first time — the re-read is compared with this.</p>
      <div className="iqc-addsample-grid">
        {analytes.map(a => (
          <label key={a.id}>
            <span>{a.analyte}{a.unit ? ` ${a.unit}` : ''}</span>
            <TextField value={originals[a.id] ?? ''}
              onValue={v => setOriginals(prev => ({ ...prev, [a.id]: v }))} />
          </label>
        ))}
      </div>
      <button type="button" className="iqc-addsample-save" disabled={busy} onClick={save}>
        {busy ? 'Saving…' : 'Add this sample'}
      </button>
    </div>
  );
}

function PastePanel({ controlId, onMapped, onProblem }: {
  controlId: number; onMapped: (m: IqcMapping) => void; onProblem: (m: string) => void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [orientation, setOrientation] = useState<'auto' | 'rows' | 'columns'>('auto');

  async function parse() {
    setBusy(true);
    try {
      const next = await api<IqcMapping>(`/iqc/portal/controls/${controlId}/parse-paste`, {
        method: 'POST',
        body: JSON.stringify({ text, orientation: orientation === 'auto' ? undefined : orientation }),
      });
      onMapped(next);
    } catch (e) { onProblem(errorText(e)); }
    finally { setBusy(false); }
  }

  return (
    <div className="iqc-panel">
      <label>
        <span>Paste the block of results</span>
        <TextField as="textarea" rows={6} value={text} onValue={setText} className="iqc-paste"
          placeholder={'WBC\t6.2\nRBC\t4.51\nHGB\t13.4\nHCT\t40.1\n…\n\nCopy straight out of Excel, Word or the analyser\'s screen — parameter names and values together. The columns do not have to be in the control\'s order; they are matched by name.'} />
      </label>
      <div className="iqc-panel-row">
        <label className="inline">
          <span>Layout</span>
          <select value={orientation} onChange={e => setOrientation(e.target.value as any)}>
            <option value="auto">Work it out</option>
            <option value="rows">One parameter per row</option>
            <option value="columns">One parameter per column</option>
          </select>
        </label>
        <button type="button" disabled={busy || !text.trim()} onClick={() => void parse()}>
          {busy ? <Loader2 size={13} className="pd-spin" /> : <ClipboardPaste size={13} />} Line it up
        </button>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------------
   Door 3: the control's own table, as a spreadsheet
   ------------------------------------------------------------------------- */
function WorksheetPanel({ controlId, analytes, values, setValues, onProblem }: {
  controlId: number; analytes: any[];
  values: Record<number, string>; setValues: (fn: (v: Record<number, string>) => Record<number, string>) => void;
  onProblem: (m: string) => void;
}) {
  const gridRef = useRef<HTMLTableElement>(null);

  /**
   * Paste straight onto the grid.
   *
   * This is the "open the control interface in Excel" ask, done without leaving
   * the browser: the table below IS the system's entry table, and a block
   * copied out of Excel drops into it from wherever the caret is, filling
   * downwards. The bench can then nudge a value up or down a row until the
   * parameters line up — which is the thing that actually goes wrong.
   */
  function handlePaste(startIndex: number, event: React.ClipboardEvent) {
    const text = event.clipboardData.getData('text/plain');
    if (!text.includes('\n') && !text.includes('\t')) return;
    event.preventDefault();
    const lines = text.replace(/\r/g, '').split('\n').filter(l => l.trim() !== '');
    setValues(previous => {
      const merged = { ...previous };
      lines.forEach((line, offset) => {
        const target = analytes[startIndex + offset];
        if (!target) return;
        const parts = line.split(/\t|,/).map(p => p.trim());
        // The value is the last thing on the line that looks like a number,
        // so a pasted "HGB<tab>13.4<tab>g/dL" lands 13.4 rather than the unit.
        const candidate = [...parts].reverse().find(p => p !== '' && !Number.isNaN(Number(p))) ?? parts[parts.length - 1];
        merged[target.id] = candidate ?? '';
      });
      return merged;
    });
  }

  function shift(index: number, direction: -1 | 1) {
    setValues(previous => {
      const merged: Record<number, string> = {};
      analytes.forEach((a, i) => {
        const source = analytes[i - direction];
        if (i < index) merged[a.id] = previous[a.id] ?? '';
        else merged[a.id] = source ? previous[source.id] ?? '' : '';
      });
      return merged;
    });
  }

  function openInExcel() {
    fetch(`${API_BASE}/iqc/portal/controls/${controlId}/worksheet.xlsx`, {
      headers: { Authorization: `Bearer ${getToken() ?? ''}` },
    }).then(async response => {
      if (!response.ok) throw new Error('The worksheet could not be produced.');
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement('a');
      anchor.href = url; anchor.download = 'control_worksheet.xlsx'; anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }).catch(e => onProblem(errorText(e)));
  }

  return (
    <div className="iqc-panel">
      <p className="iqc-panel-lead">
        This is the control&rsquo;s own table. Click the first result box, paste the analyser&rsquo;s block, and it
        fills downwards. If everything lands one row out, nudge it with the arrows beside the row.
      </p>
      <div className="iqc-sheet-wrap">
        <table className="iqc-sheet" ref={gridRef}>
          <thead><tr><th>#</th><th>Parameter</th><th>Unit</th><th>Result</th><th>Acceptable</th><th /></tr></thead>
          <tbody>
            {analytes.map((a, index) => (
              <tr key={a.id}>
                <td className="n">{index + 1}</td>
                <td>{a.analyte}</td>
                <td className="u">{a.unit ?? ''}</td>
                <td>
                  <TextField value={values[a.id] ?? ''} inputMode="decimal"
                    onPaste={e => handlePaste(index, e)}
                    onValue={next => setValues(v => ({ ...v, [a.id]: next }))} />
                </td>
                <td className="r">{a.acceptable_low ?? '−'}–{a.acceptable_high ?? '−'}</td>
                <td className="shift">
                  <button type="button" title="Move every value from here down one row" onClick={() => shift(index, 1)}>↓</button>
                  <button type="button" title="Move every value from here up one row" onClick={() => shift(index, -1)}>↑</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button type="button" className="pq-link" onClick={openInExcel}>
        <Download size={12} /> Download it as an Excel file instead
      </button>
    </div>
  );
}

/* ----------------------------------------------------------------------------
   Door 4: the analyser's own export
   ------------------------------------------------------------------------- */
function UploadPanel({ controlId, onMapped, onProblem }: {
  controlId: number; onMapped: (m: IqcMapping) => void; onProblem: (m: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [skipRows, setSkipRows] = useState(0);
  const [orientation, setOrientation] = useState<'auto' | 'rows' | 'columns'>('auto');
  const [preview, setPreview] = useState<unknown[][] | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastMapping, setLastMapping] = useState<IqcMapping | null>(null);

  const parse = useCallback(async (chosen: File, skip: number, orient: string) => {
    setBusy(true);
    const body = new FormData();
    body.append('file', chosen);
    body.append('skipRows', String(skip));
    if (orient !== 'auto') body.append('orientation', orient);
    try {
      const next = await api<IqcMapping>(`/iqc/portal/controls/${controlId}/parse-file`, { method: 'POST', body });
      setPreview(next.preview ?? null);
      setLastMapping(next);
      onMapped(next);
    } catch (e) { onProblem(errorText(e)); }
    finally { setBusy(false); }
  }, [controlId, onMapped, onProblem]);

  return (
    <div className="iqc-panel">
      <div className="iqc-panel-row">
        <button type="button" onClick={() => inputRef.current?.click()}>
          <Upload size={13} /> {file ? file.name : 'Choose the analyser\'s file'}
        </button>
        <input ref={inputRef} type="file" hidden accept=".csv,.xlsx,.xls,.txt,.docx"
          onChange={e => { const f = e.target.files?.[0]; if (f) { setFile(f); void parse(f, skipRows, orientation); } }} />
        <span className="muted">CSV, Excel or a Word table</span>
      </div>

      {file && (
        <>
          <div className="iqc-panel-row">
            <label className="inline">
              <span>Start reading at row</span>
              <input type="number" min={0} value={skipRows + 1} style={{ width: 70 }}
                onChange={e => {
                  const next = Math.max(0, Number(e.target.value) - 1);
                  setSkipRows(next);
                  void parse(file, next, orientation);
                }} />
            </label>
            <label className="inline">
              <span>Layout</span>
              <select value={orientation}
                onChange={e => { setOrientation(e.target.value as any); void parse(file, skipRows, e.target.value); }}>
                <option value="auto">Work it out</option>
                <option value="rows">One parameter per row</option>
                <option value="columns">One parameter per column</option>
              </select>
            </label>
            {busy && <Loader2 size={14} className="pd-spin" />}
          </div>
          <p className="iqc-panel-lead">
            Analysers print a different number of header lines. If the parameters have not lined up,
            move the start row up or down until they do — the preview below shows where reading begins.
          </p>

          {preview && (
            <div className="iqc-preview-wrap">
              <table className="iqc-preview">
                <tbody>
                  {preview.map((row, index) => (
                    <tr key={index} className={index === skipRows ? 'is-start' : index < skipRows ? 'is-skipped' : ''}>
                      <td className="n">{index + 1}</td>
                      {(row as unknown[]).map((cell, ci) => <td key={ci}>{String(cell ?? '')}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {lastMapping && lastMapping.matched > 0 && (
            <button type="button" className="pq-link" onClick={async () => {
              try {
                await api(`/iqc/portal/controls/${controlId}/layout`, {
                  method: 'POST',
                  body: JSON.stringify({
                    fileKind: file.name.split('.').pop(), orientation: lastMapping.orientation,
                    firstDataRow: skipRows + 1, headerRow: skipRows,
                  }),
                });
              } catch (e) { onProblem(errorText(e)); }
            }}>
              Remember this layout for next time
            </button>
          )}
        </>
      )}
    </div>
  );
}

/* ----------------------------------------------------------------------------
   Door 5: a scan of the printout
   ------------------------------------------------------------------------- */
function ScanPanel({ controlId, onMapped, onProblem }: {
  controlId: number; onMapped: (m: IqcMapping) => void; onProblem: (m: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [image, setImage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  return (
    <div className="iqc-panel">
      <div className="iqc-panel-row">
        <button type="button" onClick={() => inputRef.current?.click()}>
          <ScanLine size={13} /> Photograph or scan the printout
        </button>
        <input ref={inputRef} type="file" hidden accept="image/*,.pdf" capture="environment"
          onChange={async e => {
            const file = e.target.files?.[0];
            if (!file) return;
            setImage(URL.createObjectURL(file));
            setBusy(true);
            const body = new FormData();
            body.append('file', file);
            try {
              const next = await api<IqcMapping & { note?: string }>(`/iqc/portal/controls/${controlId}/parse-file`, { method: 'POST', body });
              setNote(next.note ?? null);
              onMapped(next);
            } catch (err) {
              // A printout that cannot be read is not a dead end: the image
              // stays on screen beside the boxes and the numbers get typed
              // against it, which is still better than fetching the paper.
              setNote(errorText(err));
              onProblem(`${errorText(err)} The printout is shown below — type the values against it.`);
            } finally { setBusy(false); }
          }} />
        {busy && <Loader2 size={14} className="pd-spin" />}
      </div>
      {note && <p className="iqc-panel-lead">{note}</p>}
      {image && (
        <div className="iqc-scan-view">
          <img src={image} alt="The control printout, for checking the values against" />
        </div>
      )}
    </div>
  );
}

/* ----------------------------------------------------------------------------
   What the system thinks it found, before anything is saved
   ------------------------------------------------------------------------- */
function MappingReport({ mapping }: { mapping: IqcMapping }) {
  const clean = mapping.unmatchedLabels.length === 0 && mapping.missingAnalytes.length === 0;
  return (
    <div className={`iqc-mapping ${clean ? 'is-clean' : 'is-partial'}`}>
      <strong>
        {clean ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />}
        {mapping.matched} of {mapping.matched + mapping.missingAnalytes.length} parameters lined up
        {mapping.orientation ? ` (read ${mapping.orientation === 'columns' ? 'one parameter per column' : 'one parameter per row'})` : ''}
      </strong>
      {mapping.missingAnalytes.length > 0 && (
        <p>
          <span className="warn">Nothing found for:</span>{' '}
          {mapping.missingAnalytes.map(a => a.analyte).join(', ')}. Fill these by hand, or adjust the layout above.
        </p>
      )}
      {mapping.unmatchedLabels.length > 0 && (
        <p>
          <span className="warn">Not part of this control:</span>{' '}
          {mapping.unmatchedLabels.join(', ')}. These were left out rather than guessed at.
        </p>
      )}
    </div>
  );
}

/* ----------------------------------------------------------------------------
   Control results waiting from the analysers
   ----------------------------------------------------------------------------
   The same searchable list the module uses, scoped to this unit's board. It was
   an unbounded list, and this laboratory had 2,693 waiting: a dialog that long
   is not a register, it is a wall.
   ------------------------------------------------------------------------- */
function FeedDialog({ sectionId, onClose, onChanged }: {
  sectionId: number | null; onClose: () => void; onChanged: () => void;
}) {
  return (
    <TransmissionsDialog
      endpoint="/iqc/portal/transmissions"
      scope={{ sectionId }}
      mapUrl={row => `/iqc/portal/feed-messages/${row.id}/mapping`}
      title="Control results from the analysers"
      lead={'These arrived over the network. They are evidence that a control was run — not a decision that it '
        + 'passed, and not permission to release patient results. That decision is yours, on the control itself.'}
      onReject={async row => {
        await api(`/iqc/portal/feed-messages/${row.id}/reject`, {
          method: 'POST', body: JSON.stringify({ reason: 'Rejected on the bench' }),
        });
        onChanged();
      }}
      onClose={onClose} />
  );
}

function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  return (
    <div className="ls-modal-back" onClick={onClose}>
      <div className="ls-modal is-wide" onClick={e => e.stopPropagation()}>
        <header>
          <h4>{title}</h4>
          <button type="button" className="pq-link" onClick={onClose}><X size={14} /></button>
        </header>
        {children}
      </div>
    </div>
  );
}
