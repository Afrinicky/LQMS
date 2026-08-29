/**
 * The record of a control run, as a document somebody can sign and file.
 *
 * A Levey-Jennings chart answers "is this method behaving?". It does not answer
 * "what did the control read on Tuesday, and was that inside what it should
 * have read?" — and that second question is the one asked at bench review, at
 * an audit, and whenever a patient result released on the back of a QC run is
 * queried months later. So this report puts every reading beside the target it
 * was measured against: assigned mean, assigned SD, the acceptable range, how
 * many SDs out it landed, which rule caught it, and what the run as a whole
 * decided about releasing patient results.
 *
 * Several runs go on one document. That is the normal way it is used — a week
 * of a control, or the two levels run this morning — and putting them on
 * separate sheets makes the reviewer hold the comparison in their head. Where
 * charts are asked for, one chart per analyte follows the runs, drawn over the
 * recorded series so the runs on the sheet can be seen in context rather than
 * as isolated points.
 *
 * PDF is the browser's own print-to-PDF, as everywhere else in this system:
 * a laboratory host that never sees the internet must still be able to produce
 * one, and every machine already has a PDF printer.
 */
import type BetterSqlite3 from 'better-sqlite3';
import { RULE_LABELS, isRejection } from '../../shared/constants/iqc.js';
import { renderLjSvg, ljSvgElement, COMPACT_GEOMETRY } from './iqcChartSvg.js';
import { chartStatistics } from './iqcEvaluation.js';
import { staffSignatureDataUri } from './signatureService.js';
import { htmlEscape, signatureBlock } from '../utils/printLayout.js';

type Row = Record<string, any>;

const OUTCOME_LABELS: Record<string, string> = {
  accepted: 'Accepted', in_control: 'In control', warning: 'Warning',
  out_of_control: 'Rejected', rejected: 'Rejected',
};
const outcome = (s: unknown) => OUTCOME_LABELS[String(s ?? '')] ?? String(s ?? '');
const esc = htmlEscape;

/** How many results a chart in this report looks back over. */
export const REPORT_CHART_WINDOW = 60;

export interface RunReportSelection {
  /** Explicit run ids — "print these". Wins over everything else. */
  ids?: number[];
  /** Or the controls and a window — "print this month for these two levels". */
  materialIds?: number[];
  from?: string | null;
  to?: string | null;
  /** Draw a chart per analyte after the runs. */
  charts?: boolean;
}

export interface RunReportData {
  runs: Row[];
  /** run id → its readings, in display order. */
  readings: Map<number, Row[]>;
  /** The analytes appearing across the selected runs, with their chart series. */
  charts: { analyte: Row; points: Row[]; stats: ReturnType<typeof chartStatistics> }[];
  period: string;
}

/**
 * Gather the runs and, where asked for, a chart series per analyte.
 *
 * Selection is either an explicit list of run ids — what "print these three"
 * means — or a control and a date window. An empty selection returns no runs
 * rather than the whole register: printing everything by accident is how a
 * laboratory ends up with a 400-page document nobody reads.
 */
export function collectRunReport(db: BetterSqlite3.Database, selection: RunReportSelection): RunReportData {
  const where: string[] = []; const params: unknown[] = [];
  const ids = (selection.ids ?? []).filter(n => Number.isFinite(n));
  const materialIds = (selection.materialIds ?? []).filter(n => Number.isFinite(n));
  if (ids.length) {
    where.push(`r.id IN (${ids.map(() => '?').join(',')})`);
    params.push(...ids);
  } else if (materialIds.length) {
    where.push(`r.iqc_material_id IN (${materialIds.map(() => '?').join(',')})`);
    params.push(...materialIds);
    if (selection.from) { where.push('r.run_date >= ?'); params.push(selection.from); }
    if (selection.to) { where.push('r.run_date <= ?'); params.push(selection.to); }
  } else {
    return { runs: [], readings: new Map(), charts: [], period: '' };
  }

  const runs = db.prepare(`SELECT r.*, m.material_name, m.lot_number, m.test_name, m.control_type, m.level_label,
      m.source, m.rule_profile, e.name AS equipment_name, e.equipment_number,
      s.full_name AS operator_name, rev.full_name AS reviewed_by, rev.id AS reviewer_staff_id,
      sec.name AS section_name
    FROM iqc_runs r
    JOIN iqc_materials m ON m.id = r.iqc_material_id
    LEFT JOIN equipment_items e ON e.id = r.equipment_id
    LEFT JOIN staff s ON s.id = r.operator_staff_id
    LEFT JOIN staff rev ON rev.id = r.reviewed_by_staff_id
    LEFT JOIN sections sec ON sec.id = r.section_id
    WHERE ${where.join(' AND ')}
    ORDER BY r.run_date, r.run_time, r.id
    LIMIT 500`).all(...params) as Row[];

  const readings = new Map<number, Row[]>();
  const readingStmt = db.prepare(`SELECT res.*, a.analyte, a.unit, a.target_mean, a.target_sd,
      a.acceptable_low, a.acceptable_high, a.decimal_places, a.expected_result, a.display_order, a.id AS analyte_id
    FROM iqc_results res LEFT JOIN iqc_analytes a ON a.id = res.iqc_analyte_id
    WHERE res.iqc_run_id = ? ORDER BY a.display_order, res.id`);
  for (const run of runs) readings.set(Number(run.id), readingStmt.all(run.id) as Row[]);

  const charts: RunReportData['charts'] = [];
  if (selection.charts) {
    // One chart per analyte that actually appears on this document, drawn over
    // the recorded series up to the last run printed — so a run on the sheet is
    // read in the context of the runs around it, which is the whole point of a
    // Levey-Jennings chart.
    const seen = new Set<number>();
    const lastDate = runs.length ? String(runs[runs.length - 1].run_date) : null;
    for (const run of runs) {
      for (const reading of readings.get(Number(run.id)) ?? []) {
        const analyteId = Number(reading.analyte_id);
        if (!analyteId || seen.has(analyteId) || Number(reading.is_qualitative) === 1) continue;
        seen.add(analyteId);
        const analyte = db.prepare('SELECT * FROM iqc_analytes WHERE id = ?').get(analyteId) as Row | undefined;
        if (!analyte) continue;
        const series = db.prepare(`SELECT * FROM iqc_results
          WHERE iqc_analyte_id = ? AND is_qualitative = 0 ${lastDate ? 'AND run_date <= ?' : ''}
          ORDER BY run_date DESC, id DESC LIMIT ?`)
          .all(...(lastDate ? [analyteId, lastDate, REPORT_CHART_WINDOW] : [analyteId, REPORT_CHART_WINDOW])) as Row[];
        const points = series.reverse();
        const values = points.map(p => Number(p.result_value)).filter(v => Number.isFinite(v));
        charts.push({
          analyte: { ...analyte, material_name: run.material_name, lot_number: run.lot_number },
          points,
          stats: chartStatistics(values, analyte.target_mean, analyte.target_sd),
        });
      }
    }
  }

  const dates = runs.map(r => String(r.run_date)).sort();
  const period = dates.length
    ? (dates[0] === dates[dates.length - 1] ? dates[0] : `${dates[0]} to ${dates[dates.length - 1]}`)
    : '';

  return { runs, readings, charts, period };
}

/* ------------------------------------------------------------------ helpers */

function fmt(value: unknown, decimals: number): string {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(decimals) : String(value);
}

/** The acceptable range as it should read on a record. */
function rangeText(reading: Row, dp: number): string {
  const low = reading.acceptable_low, high = reading.acceptable_high;
  if (low === null && high === null) return '—';
  if (low !== null && high !== null) return `${fmt(low, dp)} – ${fmt(high, dp)}`;
  return low !== null ? `≥ ${fmt(low, dp)}` : `≤ ${fmt(high, dp)}`;
}

/**
 * Did this reading land inside what it was measured against?
 *
 * Stated separately from the Westgard outcome on purpose. A result can satisfy
 * every rule and still sit outside a stated acceptable range (or the reverse),
 * and a reviewer reading a printed record wants both facts, not a single word
 * that quietly merges them.
 */
function againstTarget(reading: Row, dp: number): { text: string; bad: boolean } {
  if (Number(reading.is_qualitative) === 1) {
    const expected = String(reading.expected_result ?? '');
    const got = String(reading.qualitative_result ?? '');
    if (!expected) return { text: '—', bad: false };
    const match = expected.toLowerCase() === got.toLowerCase();
    return { text: match ? `As expected (${expected})` : `Expected ${expected}`, bad: !match };
  }
  const value = Number(reading.result_value);
  const low = reading.acceptable_low === null ? null : Number(reading.acceptable_low);
  const high = reading.acceptable_high === null ? null : Number(reading.acceptable_high);
  if (low !== null && value < low) return { text: `${fmt(value - low, dp)} below the range`, bad: true };
  if (high !== null && value > high) return { text: `+${fmt(value - high, dp)} above the range`, bad: true };
  const mean = reading.target_mean === null ? null : Number(reading.target_mean);
  if (mean === null) return { text: low === null && high === null ? '—' : 'Within range', bad: false };
  const diff = value - mean;
  const pct = mean !== 0 ? ` (${(diff / mean * 100).toFixed(1)}%)` : '';
  return { text: `${diff >= 0 ? '+' : ''}${fmt(diff, dp)} from target${pct}`, bad: false };
}

/* --------------------------------------------------------------------- HTML */

/** One run, as a header block and its readings against their targets. */
function runSection(run: Row, readings: Row[]): string {
  const released = run.patient_results_released === null || run.patient_results_released === undefined
    ? 'Not decided'
    : Number(run.patient_results_released) === 1 ? 'Released' : 'Withheld';

  const rows = readings.map(reading => {
    const dp = Number(reading.decimal_places ?? 2);
    const qualitative = Number(reading.is_qualitative) === 1;
    const versus = againstTarget(reading, dp);
    const rejected = isRejection(reading.rule_violation) || reading.status === 'out_of_control';
    return `<tr>
      <td>${esc(reading.analyte ?? '')}</td>
      <td class="num"><strong>${qualitative ? esc(reading.qualitative_result) : fmt(reading.result_value, dp)}</strong></td>
      <td>${esc(reading.unit ?? '')}</td>
      <td class="num">${qualitative ? esc(reading.expected_result ?? '—') : fmt(reading.target_mean, dp)}</td>
      <td class="num">${qualitative ? '—' : fmt(reading.target_sd, dp + 1)}</td>
      <td class="num">${qualitative ? '—' : rangeText(reading, dp)}</td>
      <td class="num">${reading.z_score === null || reading.z_score === undefined ? '—' : Number(reading.z_score).toFixed(2)}</td>
      <td class="${versus.bad ? 'bad' : ''}">${esc(versus.text)}</td>
      <td class="${rejected ? 'bad' : reading.status === 'warning' ? 'warn' : ''}">${esc(outcome(reading.status))}</td>
      <td>${esc(RULE_LABELS[String(reading.rule_violation ?? '')] ?? reading.rule_violation ?? '')}</td>
    </tr>`;
  }).join('');

  const reviewerSignature = run.reviewed_at ? staffSignatureDataUri(run.reviewer_staff_id) : null;

  return `<section class="run">
  <h3>
    ${esc(run.material_name)} · lot ${esc(run.lot_number)}${run.level_label ? ` · ${esc(run.level_label)}` : ''}
    <span class="badge ${run.status === 'out_of_control' ? 'bad' : run.status === 'warning' ? 'warn' : 'ok'}">${esc(outcome(run.status))}</span>
  </h3>
  <table class="meta"><tbody>
    <tr><th>Run</th><td>${esc(run.run_number ?? `#${run.id}`)}</td>
        <th>Date &amp; time</th><td>${esc(run.run_date)}${run.run_time ? ` ${esc(run.run_time)}` : ''}${run.shift ? ` · ${esc(run.shift)}` : ''}</td></tr>
    <tr><th>Test</th><td>${esc(run.test_name)}</td>
        <th>Instrument</th><td>${esc(run.equipment_name ?? '—')}${run.equipment_number ? ` (${esc(run.equipment_number)})` : ''}</td></tr>
    <tr><th>Performed by</th><td>${esc(run.operator_name ?? '—')}</td>
        <th>Unit</th><td>${esc(run.section_name ?? '—')}</td></tr>
    <tr><th>Reagent lot</th><td>${esc(run.reagent_lot ?? '—')}</td>
        <th>Patient results</th><td>${esc(released)}</td></tr>
    <tr><th>Accepted by</th><td>${esc(run.reviewed_by ?? 'Not yet accepted')}${run.reviewed_at ? ` · ${esc(String(run.reviewed_at).slice(0, 16).replace('T', ' '))}` : ''}</td>
        <th>Rules applied</th><td>${esc(run.rule_summary ?? run.rule_profile ?? '—')}</td></tr>
  </tbody></table>

  <table class="results"><thead><tr>
    <th>Parameter</th><th class="num">Result</th><th>Unit</th>
    <th class="num">Target mean</th><th class="num">Target SD</th><th class="num">Acceptable range</th>
    <th class="num">z</th><th>Against target</th><th>Outcome</th><th>Rule</th>
  </tr></thead><tbody>${rows || '<tr><td colspan="10">No readings recorded on this run.</td></tr>'}</tbody></table>

  ${run.corrective_action ? `<p class="note"><strong>Action taken:</strong> ${esc(run.corrective_action)}</p>` : ''}
  ${run.release_decision_note ? `<p class="note"><strong>Release decision:</strong> ${esc(run.release_decision_note)}</p>` : ''}
  ${run.comment ? `<p class="note"><strong>Comment:</strong> ${esc(run.comment)}</p>` : ''}
  ${reviewerSignature
    ? `<p class="signed"><span>Accepted by ${esc(run.reviewed_by ?? '')}</span><img class="sig-img" src="${reviewerSignature}" alt="signature"/></p>`
    : ''}
</section>`;
}

/** The whole document. */
export function renderRunReport(data: RunReportData, options: {
  lab: string; autoprint: boolean;
}): string {
  const runSections = data.runs.map(run => runSection(run, data.readings.get(Number(run.id)) ?? [])).join('');

  const chartSections = data.charts.map(entry => {
    const dp = Number(entry.analyte.decimal_places ?? 2);
    const chart = renderLjSvg(entry.points as any, entry.analyte.target_mean, entry.analyte.target_sd, dp, COMPACT_GEOMETRY);
    const s = entry.stats;
    return `<section class="chart">
    <h3>${esc(chart.title)} — ${esc(entry.analyte.analyte)}${entry.analyte.unit ? ` (${esc(entry.analyte.unit)})` : ''}</h3>
    <p class="chart-sub">Last ${entry.points.length} recorded ${entry.points.length === 1 ? 'result' : 'results'} · ${esc(entry.analyte.material_name)} lot ${esc(entry.analyte.lot_number)}</p>
    ${chart.caveat ? `<p class="caveat">${esc(chart.caveat)}</p>` : ''}
    ${ljSvgElement(chart, COMPACT_GEOMETRY, 210)}
    <table class="stats"><tbody><tr>
      <th>n</th><td>${s.n ?? 0}</td>
      <th>Observed mean</th><td>${fmt(s.mean, dp)}</td>
      <th>Observed SD</th><td>${fmt(s.sd, dp + 1)}</td>
      <th>CV%</th><td>${fmt(s.cv, 1)}</td>
      <th>Target mean</th><td>${fmt(entry.analyte.target_mean, dp)}</td>
      <th>Target SD</th><td>${fmt(entry.analyte.target_sd, dp + 1)}</td>
      <th>Bias</th><td>${fmt(s.bias, dp)}</td>
      <th>SD index</th><td>${fmt(s.sdIndex, 2)}</td>
    </tr></tbody></table>
  </section>`;
  }).join('');

  const rejected = data.runs.filter(r => r.status === 'out_of_control').length;
  const unreviewed = data.runs.filter(r => !r.reviewed_at).length;

  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Control runs — ${esc(data.period || 'selected')}</title>
<style>
  @page { size: A4; margin: 12mm; }
  * { box-sizing: border-box; }
  body { font-family: 'Segoe UI', Arial, Helvetica, sans-serif; color: #16202e; margin: 0; padding: 18px 24px; font-size: 11px; line-height: 1.45; }
  .toolbar { background: #eef3fb; border: 1px solid #c9d8ef; border-radius: 6px; padding: 8px 12px; margin-bottom: 14px; display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  .toolbar button { font: inherit; padding: 5px 14px; border: 1px solid #1B3A6B; background: #1B3A6B; color: #fff; border-radius: 4px; cursor: pointer; }
  .toolbar a { color: #1B3A6B; font-size: 11px; }
  .head { border-bottom: 2px solid #1B3A6B; padding-bottom: 8px; margin-bottom: 12px; display: flex; justify-content: space-between; align-items: flex-end; gap: 20px; }
  .head .facility { font-size: 15px; font-weight: 700; color: #1B3A6B; }
  .head .doc-title { font-size: 12px; text-transform: uppercase; letter-spacing: .09em; color: #40546f; margin-top: 2px; }
  .head .ref { text-align: right; font-size: 10px; color: #5a6b80; }
  .summary { display: flex; gap: 9px; margin-bottom: 12px; flex-wrap: wrap; }
  .summary div { border: 1px solid #b3c1d4; border-radius: 5px; padding: 6px 12px; min-width: 96px; }
  .summary .label { font-size: 8.5px; text-transform: uppercase; letter-spacing: .07em; color: #64748b; }
  .summary .value { font-size: 16px; font-weight: 700; color: #1B3A6B; }
  .summary .value.bad { color: #c0392b; }
  section.run { border: 1px solid #b3c1d4; border-radius: 5px; padding: 9px 11px; margin-bottom: 11px; page-break-inside: avoid; }
  section.run h3 { margin: 0 0 6px; font-size: 12px; color: #1B3A6B; display: flex; justify-content: space-between; gap: 12px; align-items: baseline; }
  .badge { font-size: 9.5px; padding: 2px 8px; border-radius: 99px; border: 1px solid #b3c1d4; white-space: nowrap; }
  .badge.ok { background: #eafaf2; border-color: #9ad9bd; color: #14795a; }
  .badge.warn { background: #fef6e6; border-color: #e6c98a; color: #8a6414; }
  .badge.bad { background: #fdeaec; border-color: #e8a7b0; color: #b32b3d; }
  table { border-collapse: collapse; width: 100%; margin: 4px 0 6px; }
  th, td { border: 1px solid #c3cedd; padding: 3px 6px; text-align: left; font-size: 9.5px; vertical-align: top; }
  thead th { background: #eef3fb; font-size: 9px; text-transform: uppercase; letter-spacing: .03em; }
  table.meta th { background: #f5f8fd; width: 12%; font-weight: 600; }
  table.meta td { width: 26%; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  td.bad { color: #c0392b; font-weight: 700; }
  td.warn { color: #a1720c; font-weight: 700; }
  .note { margin: 3px 0; font-size: 10px; }
  .signed { display: flex; align-items: center; gap: 10px; font-size: 9.5px; color: #40546f; margin: 6px 0 0; }
  .sig-img { height: 30px; max-width: 150px; background: #fff; }
  section.chart { border: 1px solid #b3c1d4; border-radius: 5px; padding: 9px 11px; margin-bottom: 11px; page-break-inside: avoid; }
  section.chart h3 { margin: 0 0 1px; font-size: 12px; color: #1B3A6B; }
  .chart-sub { margin: 0 0 6px; font-size: 9.5px; color: #64748b; }
  .caveat { border: 1px solid #e6c98a; background: #fdf6e6; color: #6a5320; padding: 6px 9px; font-size: 9.5px; margin: 0 0 7px; border-radius: 3px; }
  table.stats th { background: #f5f8fd; font-size: 8.5px; text-transform: uppercase; letter-spacing: .04em; }
  table.stats td { font-weight: 700; font-variant-numeric: tabular-nums; }
  .signatures { display: grid; grid-template-columns: repeat(2, 1fr); gap: 18px; margin-top: 22px; page-break-inside: avoid; }
  .sign .rule { border-bottom: 1px solid #16202e; min-height: 22px; font-weight: 600; padding-bottom: 2px; }
  .sign .role { font-size: 9px; text-transform: uppercase; letter-spacing: .06em; color: #64748b; margin-top: 3px; }
  .sign .date { font-size: 9px; color: #40546f; margin-top: 8px; }
  .foot { margin-top: 18px; border-top: 1px solid #c9d8ef; padding-top: 5px; font-size: 9px; color: #64748b; display: flex; justify-content: space-between; }
  .empty { padding: 30px; text-align: center; color: #64748b; border: 1px dashed #b3c1d4; border-radius: 5px; }
  @media print { .toolbar { display: none; } body { padding: 0; } }
</style>
${options.autoprint ? '<script>window.addEventListener("load",()=>setTimeout(()=>window.print(),350))</script>' : ''}
</head><body>
<div class="toolbar">
  <span>Choose any installed printer, or <strong>Save as PDF</strong> as the destination.</span>
  <button type="button" onclick="window.print()">Print</button>
  <a href="?autoprint=0">Open without printing</a>
</div>
<div class="head">
  <div>
    <div class="facility">${esc(options.lab)}</div>
    <div class="doc-title">Internal quality control — record of runs</div>
  </div>
  <div class="ref">Period: ${esc(data.period || '—')}<br/>Printed ${new Date().toISOString().slice(0, 16).replace('T', ' ')}</div>
</div>

${data.runs.length === 0 ? '<p class="empty">No control runs were selected for this report.</p>' : `
<div class="summary">
  <div><div class="label">Runs</div><div class="value">${data.runs.length}</div></div>
  <div><div class="label">Rejected</div><div class="value ${rejected ? 'bad' : ''}">${rejected}</div></div>
  <div><div class="label">Not yet accepted</div><div class="value">${unreviewed}</div></div>
  ${data.charts.length ? `<div><div class="label">Charts</div><div class="value">${data.charts.length}</div></div>` : ''}
</div>
${runSections}
${chartSections}
<div class="signatures">
  ${signatureBlock('Reviewed by')}
  ${signatureBlock('Authorised by')}
</div>`}

<div class="foot">
  <span>SECH_LIMS by Nickland · Internal quality control record · Retain according to the laboratory&rsquo;s retention schedule.</span>
  <span>${data.runs.length} ${data.runs.length === 1 ? 'run' : 'runs'}</span>
</div>
</body></html>`;
}

/* -------------------------------------------------------------------- Excel */

export const RUN_REPORT_HEADERS = [
  'Run number', 'Run date', 'Run time', 'Shift', 'Control', 'Lot', 'Level', 'Test',
  'Instrument', 'Operator', 'Reagent lot', 'Run outcome',
  'Parameter', 'Result', 'Unit', 'Target mean', 'Target SD', 'Acceptable low', 'Acceptable high',
  'z-score', 'Against target', 'Result outcome', 'Rule', 'Expected result',
  'Patient results', 'Accepted by', 'Accepted at', 'Action taken', 'Comment',
] as const;

/** One row per reading, so the file sorts, filters and pivots without unpacking. */
export function runReportRows(data: RunReportData): unknown[][] {
  const rows: unknown[][] = [];
  for (const run of data.runs) {
    const readings = data.readings.get(Number(run.id)) ?? [];
    const released = run.patient_results_released === null || run.patient_results_released === undefined
      ? 'Not decided' : Number(run.patient_results_released) === 1 ? 'Released' : 'Withheld';
    const base = [
      run.run_number ?? `#${run.id}`, run.run_date, run.run_time ?? '', run.shift ?? '',
      run.material_name, run.lot_number, run.level_label ?? '', run.test_name,
      run.equipment_name ?? '', run.operator_name ?? '', run.reagent_lot ?? '', outcome(run.status),
    ];
    const tail = [
      released, run.reviewed_by ?? '', run.reviewed_at ?? '', run.corrective_action ?? '', run.comment ?? '',
    ];
    if (readings.length === 0) {
      rows.push([...base, '', '', '', '', '', '', '', '', '', '', '', '', ...tail]);
      continue;
    }
    for (const reading of readings) {
      const dp = Number(reading.decimal_places ?? 2);
      const qualitative = Number(reading.is_qualitative) === 1;
      rows.push([
        ...base,
        reading.analyte ?? '',
        qualitative ? (reading.qualitative_result ?? '') : reading.result_value,
        reading.unit ?? '',
        reading.target_mean ?? '', reading.target_sd ?? '',
        reading.acceptable_low ?? '', reading.acceptable_high ?? '',
        reading.z_score === null || reading.z_score === undefined ? '' : Number(reading.z_score).toFixed(2),
        againstTarget(reading, dp).text,
        outcome(reading.status),
        RULE_LABELS[String(reading.rule_violation ?? '')] ?? reading.rule_violation ?? '',
        reading.expected_result ?? '',
        ...tail,
      ]);
    }
  }
  return rows;
}
