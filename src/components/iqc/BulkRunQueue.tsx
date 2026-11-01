import { Fragment, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, Trash2 } from 'lucide-react';
import TextField from '../ui/TextField';
import {
  AST_INTERPRETATIONS, AST_INTERPRETATION_LABELS, QUALITATIVE_LABELS, scaleForOutcome, runStampFrom,
  type QualitativeOutcome,
} from '../../../shared/constants/iqc';

/**
 * The runs waiting to be recorded, before any of them is.
 *
 * An analyser that transmits in bulk sends a week of stored control runs at
 * once, and a laboratory putting its history on the record has a hundred to
 * enter. Entering those one at a time is an afternoon of typing, and the chart
 * stays empty until somebody finishes.
 *
 * So the selection becomes a QUEUE, and the queue is the thing a person checks
 * before pressing record. Each row keeps its own date, its own time and its own
 * readings, exactly as a single run does — because that is what each of them is.
 * Nothing here evaluates anything: the host applies the same rules to every run
 * in the set that it applies to one typed in by hand.
 *
 * The same queue is used on the bench and in the module, so a run entered in
 * one place is entered the way it would have been in the other.
 */

/** A control's parameter, as both screens hold it. */
export type QueueAnalyte = {
  id: number; analyte: string; unit: string | null;
  target_mean?: number | null; acceptable_low?: number | null; acceptable_high?: number | null;
  expected_result?: string | null; expected_interpretation?: string | null;
};

/** One run in the queue. */
export type QueuedRun = {
  /** Stable while the row is edited; never sent anywhere. */
  key: string;
  runDate: string;
  runTime: string;
  values: Record<number, string>;
  /** The transmission it was read off, where it came from one. */
  feedMessageId: number | null;
  sampleId: string | null;
  source: string | null;
  /** Parameters the transmission carried that this control does not measure. */
  unmatchedLabels: string[];
  /** The control the host had read this transmission as. */
  readAs: string | null;
};

/** A transmission lined up against this control, as the host hands it over. */
export type QueueMapping = {
  readings: Array<{ analyteId: number; value: number | null; qualitativeResult?: string | null }>;
  unmatchedLabels?: string[];
  message?: {
    id?: number; sample_id?: string | null; received_at?: string; instrument_run_at?: string | null;
    source_name?: string | null; material_name?: string | null;
  } | null;
};

let counter = 0;
const nextKey = () => `q${++counter}`;

/** A run to type in, on the day the form is already set to. */
export function blankQueuedRun(runDate: string, runTime = ''): QueuedRun {
  return {
    key: nextKey(), runDate, runTime, values: {},
    feedMessageId: null, sampleId: null, source: null, unmatchedLabels: [], readAs: null,
  };
}

/**
 * A queued run from one transmission.
 *
 * The analyser states when it ran the control, so that is the date the run is
 * filed under — not the moment somebody selected it. Stamping the day of entry
 * is how a fortnight of stored runs lands on one point of a Levey-Jennings
 * chart.
 */
export function queuedFromMapping(mapping: QueueMapping, today: string): QueuedRun {
  const stamp = runStampFrom(mapping.message ?? null, today);
  const values: Record<number, string> = {};
  for (const reading of mapping.readings ?? []) {
    values[reading.analyteId] = reading.value != null ? String(reading.value) : String(reading.qualitativeResult ?? '');
  }
  return {
    key: nextKey(),
    runDate: stamp?.date ?? today,
    runTime: stamp?.time ?? '',
    values,
    feedMessageId: mapping.message?.id ?? null,
    sampleId: mapping.message?.sample_id ?? null,
    source: mapping.message?.source_name ?? null,
    unmatchedLabels: mapping.unmatchedLabels ?? [],
    readAs: mapping.message?.material_name ?? null,
  };
}

/** How many parameters a queued run carries a value for. */
export const filledCount = (run: QueuedRun, analytes: QueueAnalyte[]) =>
  analytes.filter(a => String(run.values[a.id] ?? '').trim() !== '').length;

export default function BulkRunQueue({
  analytes, controlType, controlName, runs, onChange, max, busy = false,
}: {
  analytes: QueueAnalyte[];
  controlType: string;
  /** This control's own name, so a transmission read as another is named. */
  controlName: string;
  runs: QueuedRun[];
  onChange: (runs: QueuedRun[]) => void;
  max: number;
  busy?: boolean;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const today = new Date().toISOString().slice(0, 10);
  const isCs = controlType === 'culture_sensitivity';
  const qualitative = controlType === 'qualitative';

  const patch = (key: string, change: Partial<QueuedRun>) =>
    onChange(runs.map(run => (run.key === key ? { ...run, ...change } : run)));
  const setValue = (key: string, analyteId: number, value: string) =>
    onChange(runs.map(run => (run.key === key ? { ...run, values: { ...run.values, [analyteId]: value } } : run)));

  const dates = runs.map(r => r.runDate).filter(Boolean).sort();
  const incomplete = runs.filter(run => filledCount(run, analytes) === 0).length;
  const duplicates = new Set(
    runs.map(r => `${r.runDate} ${r.runTime}`)
      .filter((stamp, index, all) => all.indexOf(stamp) !== index),
  );

  return (
    <div className="iqc-queue">
      <div className="iqc-queue-head">
        <strong>{runs.length} run{runs.length === 1 ? '' : 's'} ready</strong>
        {dates.length > 1 && <span className="muted">{dates[0]} to {dates[dates.length - 1]}</span>}
        {runs.length >= max && <span className="warn">The most that can be recorded in one entry.</span>}
        {runs.length > 0 && (
          <button type="button" className="pq-link" disabled={busy} onClick={() => onChange([])}>Clear all</button>
        )}
      </div>

      {runs.length === 0 ? (
        <p className="iqc-hint">
          Select the transmissions to record, or add a run and enter it. Each one is recorded as a run of its own,
          on its own date.
        </p>
      ) : (
        <>
          <div className="iqc-queue-wrap">
            <table className="data-table compact iqc-queue-table">
              <thead>
                <tr>
                  <th />
                  <th>Date</th>
                  <th>Time</th>
                  <th>Results</th>
                  <th>Source</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {runs.map((run, index) => {
                  const filled = filledCount(run, analytes);
                  const expanded = open === run.key;
                  const clash = duplicates.has(`${run.runDate} ${run.runTime}`);
                  return (
                    <Fragment key={run.key}>
                      <tr className={filled === 0 ? 'is-empty' : ''}>
                        <td className="iqc-queue-n">
                          <button type="button" className="iqc-queue-open"
                            onClick={() => setOpen(expanded ? null : run.key)}
                            aria-label={expanded ? 'Hide these readings' : 'Show these readings'}>
                            {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                            {index + 1}
                          </button>
                        </td>
                        <td>
                          <input type="date" value={run.runDate} max={today} disabled={busy}
                            onChange={e => patch(run.key, { runDate: e.target.value })} />
                        </td>
                        <td>
                          <input type="time" value={run.runTime} disabled={busy}
                            onChange={e => patch(run.key, { runTime: e.target.value })} />
                        </td>
                        <td className={filled === 0 ? 'iqc-queue-warn' : ''}>
                          {filled} of {analytes.length}
                        </td>
                        <td className="muted">
                          {run.sampleId ?? (run.feedMessageId ? 'transmission' : 'entered by hand')}
                          {run.source ? ` · ${run.source}` : ''}
                          {run.readAs && run.readAs !== controlName ? ` · read as ${run.readAs}` : ''}
                        </td>
                        <td>
                          <button type="button" className="tiny danger" disabled={busy}
                            onClick={() => onChange(runs.filter(r => r.key !== run.key))}>
                            <Trash2 size={12} /> Remove
                          </button>
                        </td>
                      </tr>
                      {expanded && (
                        <tr className="iqc-queue-detail">
                          <td colSpan={6}>
                            <ul className="iqc-analytes">
                              {analytes.map(a => {
                                const raw = run.values[a.id] ?? '';
                                const num = Number(raw);
                                const out = !qualitative && !isCs && raw !== '' && !Number.isNaN(num)
                                  && ((a.acceptable_low != null && num < a.acceptable_low)
                                    || (a.acceptable_high != null && num > a.acceptable_high));
                                return (
                                  <li key={a.id} className={out ? 'is-out' : ''}>
                                    <label>
                                      <span className="iqc-an-name">{a.analyte}{a.unit ? <em> {a.unit}</em> : null}</span>
                                      {isCs ? (
                                        <select value={raw} disabled={busy}
                                          onChange={e => setValue(run.key, a.id, e.target.value)}>
                                          <option value="">—</option>
                                          {AST_INTERPRETATIONS.map(o => (
                                            <option key={o} value={o}>{AST_INTERPRETATION_LABELS[o]}</option>
                                          ))}
                                        </select>
                                      ) : qualitative ? (
                                        <select value={raw} disabled={busy}
                                          onChange={e => setValue(run.key, a.id, e.target.value)}>
                                          <option value="">—</option>
                                          {scaleForOutcome(a.expected_result).map(o => (
                                            <option key={o} value={o}>{QUALITATIVE_LABELS[o]}</option>
                                          ))}
                                        </select>
                                      ) : (
                                        <TextField inputMode="decimal" value={raw}
                                          onValue={next => setValue(run.key, a.id, next)} />
                                      )}
                                      <span className="iqc-an-range">
                                        {a.target_mean != null ? `mean ${a.target_mean}` : ''}
                                        {a.acceptable_low != null || a.acceptable_high != null
                                          ? ` ${a.acceptable_low ?? '−'}–${a.acceptable_high ?? '−'}` : ''}
                                        {a.expected_result
                                          ? QUALITATIVE_LABELS[a.expected_result as QualitativeOutcome] ?? a.expected_result : ''}
                                        {a.expected_interpretation
                                          ? AST_INTERPRETATION_LABELS[a.expected_interpretation as never] ?? a.expected_interpretation : ''}
                                      </span>
                                    </label>
                                  </li>
                                );
                              })}
                            </ul>
                            {run.unmatchedLabels.length > 0 && (
                              <p className="iqc-hint">
                                The analyser also sent {run.unmatchedLabels.join(', ')}, which this control does not measure.
                              </p>
                            )}
                            {clash && (
                              <p className="iqc-hint crit">
                                Another run in this set carries the same date and time. Two runs at one moment is
                                usually the same transmission twice.
                              </p>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>

          {incomplete > 0 && (
            <p className="iqc-note warn">
              <AlertTriangle size={12} /> {incomplete} run{incomplete === 1 ? ' carries' : 's carry'} no reading.
              Open it and enter the results, or remove it — a run with nothing in it is not recorded.
            </p>
          )}
        </>
      )}
    </div>
  );
}

/* ----------------------------------------------------------------------------
   What a set of runs came to
   ----------------------------------------------------------------------------
   One line per run, because every one of them was judged on its own. A set
   recorded as "48 runs recorded" and nothing else hides the two that failed,
   and those two are the whole reason the record is kept.
   ------------------------------------------------------------------------- */

export type BulkOutcome = {
  recorded: number;
  rejected: number;
  warned: number;
  runs: Array<{
    id: number; runNumber: string; runDate: string; runTime: string | null;
    status: string; ruleSummary: string | null; mayReleasePatientResults: boolean; readings: number;
  }>;
  refused?: Array<{ index: number; runDate: string | null; reason: string }>;
};

const OUTCOME_LABEL: Record<string, string> = {
  in_control: 'In control', warning: 'Warning', out_of_control: 'Rejected',
};

export function BulkRunOutcome({ outcome, rules }: {
  outcome: BulkOutcome;
  /** This laboratory's words for a rule, where the screen has them. */
  rules?: Record<string, string>;
}) {
  const held = outcome.runs.filter(r => !r.mayReleasePatientResults);
  return (
    <div className="iqc-queue-outcome">
      <div className="iqc-queue-verdict">
        <strong>{outcome.recorded} run{outcome.recorded === 1 ? '' : 's'} recorded</strong>
        {outcome.rejected > 0 && <span className="badge failed">{outcome.rejected} rejected</span>}
        {outcome.warned > 0 && <span className="badge overdue">{outcome.warned} with a warning</span>}
      </div>

      {held.length > 0 && (
        <p className="iqc-note bad">
          <AlertTriangle size={12} /> Patient results on this examination are held for {held.length} of these runs.
          Investigate, record what was done, and repeat the control before releasing anything.
        </p>
      )}

      <ul className="iqc-queue-runs">
        {outcome.runs.map(run => (
          <li key={run.id} className={run.status}>
            <strong>{run.runNumber}</strong>
            <span className="muted">{run.runDate}{run.runTime ? ` ${run.runTime}` : ''} · {run.readings} parameter{run.readings === 1 ? '' : 's'}</span>
            <span className={`badge${run.status === 'out_of_control' ? ' failed' : run.status === 'warning' ? ' overdue' : ' done'}`}>
              {OUTCOME_LABEL[run.status] ?? run.status}
            </span>
            {run.ruleSummary && (
              <span className="muted">
                {String(run.ruleSummary).split(',').map(r => rules?.[r.trim()] ?? r.trim()).join('; ')}
              </span>
            )}
          </li>
        ))}
      </ul>

      {(outcome.refused?.length ?? 0) > 0 && (
        <ul className="iqc-queue-runs is-refused">
          {outcome.refused!.map(refused => (
            <li key={`${refused.index}-${refused.runDate ?? ''}`}>
              <strong>{refused.runDate ?? 'No date'}</strong>
              <span className="muted">not recorded — {refused.reason}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
