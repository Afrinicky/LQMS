import { useMemo, useState } from 'react';
import { RULE_LABELS, RULE_MEANING, isRejection } from '../../shared/constants/iqc';

/**
 * Levey-Jennings chart.
 *
 * What an assessor looks for on one of these, and what the old chart did not
 * show: the ±1/2/3 SD zones drawn to scale and labelled, every point placed on
 * a real date axis, rejections distinguishable from warnings at a glance and
 * named by the rule that caught them, the lot change that explains a step in
 * the series, and — the part most often missing — the statistics the period
 * actually produced (n, mean, SD, CV%) next to the target it was measured
 * against, with the bias between them.
 *
 * Drawn as plain SVG so it prints exactly as it appears and needs no library.
 */
export type ChartPoint = {
  id: number;
  run_date: string;
  run_time?: string | null;
  result_value: number;
  z_score: number | null;
  status: string;
  rule_violation: string | null;
  run_number?: string | null;
  equipment_name?: string | null;
  operator_name?: string | null;
};

/**
 * Where the mean and SD being drawn against actually came from. A chart whose
 * limits are the laboratory's own says so on its face, because "±0.4, off the
 * insert" and "±0.4, established here over 22 days" are different claims and
 * an assessor asks which one this is.
 */
export type TargetProvenance = {
  mean: number | null;
  sd: number | null;
  source: 'vendor' | 'established' | 'none';
  basis: string | null;
  n: number | null;
  days: number | null;
  from: string | null;
  to: string | null;
  establishedAt: string | null;
  provisional: boolean;
  pointsShort: number;
  daysShort: number;
};

export type ChartData = {
  analyte: {
    id: number; name: string; unit: string | null; decimalPlaces: number;
    targetMean: number | null; targetSd: number | null;
    enteredMean?: number | null; enteredSd?: number | null;
    acceptableLow: number | null; acceptableHigh: number | null;
  };
  target?: TargetProvenance;
  material: { name: string; lotNumber: string; testName: string; levelLabel: string | null; source: string };
  statistics: { n: number; mean: number | null; sd: number | null; cv: number | null; bias: number | null; biasPercent: number | null; sdIndex: number | null };
  lotChanges: { change_date: string; reason: string | null }[];
  points: ChartPoint[];
};

const W = 900, H = 340;
const PAD = { top: 18, right: 108, bottom: 46, left: 62 };
const PLOT_W = W - PAD.left - PAD.right;
const PLOT_H = H - PAD.top - PAD.bottom;

const fmt = (v: number | null | undefined, dp = 2) =>
  v === null || v === undefined || Number.isNaN(v) ? '—' : v.toFixed(dp);

export default function LeveyJenningsChart({ data, onEstablish, canEstablish }: {
  data: ChartData;
  /** Establish the limits from the laboratory's own runs, where the caller offers it. */
  onEstablish?: () => void;
  canEstablish?: boolean;
}) {
  const [hover, setHover] = useState<ChartPoint | null>(null);
  const { analyte, material, statistics, points, lotChanges, target } = data;
  const dp = analyte.decimalPlaces ?? 2;

  const mean = analyte.targetMean;
  const sd = analyte.targetSd;
  const usable = mean !== null && sd !== null && sd > 0 && points.length > 0;

  // The vertical scale shows ±4 SD by default and stretches to fit — but only
  // to ±6. A gross outlier (a transcription slip of 20 g/dL against a mean of
  // 13.5 is 16 SD out) would otherwise squash the control limits into a band a
  // few pixels tall and make the chart useless for the runs that matter. Points
  // past the edge are pinned to it and drawn as a triangle, which is what a
  // printed Levey-Jennings chart has always done with an off-scale result.
  const MAX_EXTENT = 6;
  const scale = useMemo(() => {
    if (!usable) return null;
    const zs = points.map(p => (p.result_value - mean!) / sd!);
    const needed = Math.ceil(Math.max(...zs.map(Math.abs)) + 0.5);
    const extent = Math.min(MAX_EXTENT, Math.max(4, needed));
    const top = mean! + extent * sd!;
    const bottom = mean! - extent * sd!;
    return {
      extent,
      clipped: needed > extent,
      z: (value: number) => (value - mean!) / sd!,
      y: (value: number) => {
        const clamped = Math.min(top, Math.max(bottom, value));
        return PAD.top + ((top - clamped) / (top - bottom)) * PLOT_H;
      },
      offScale: (value: number) => Math.abs((value - mean!) / sd!) > extent,
      x: (i: number) => PAD.left + (points.length === 1 ? PLOT_W / 2 : (i / (points.length - 1)) * PLOT_W),
    };
  }, [usable, points, mean, sd]);

  if (!usable || !scale) {
    // A control with results but no SD is the commonest reason this chart came
    // up blank, and a blank panel taught the bench that charting does not work.
    // The results exist; what is missing is the SD to scale them against. So
    // the run chart is drawn anyway — every point, in date order, against the
    // acceptable range where there is one — and the panel says exactly what is
    // needed to turn it into a Levey-Jennings chart.
    return (
      <div className="lj lj-provisional">
        <div className="lj-head">
          <div>
            <h4>{analyte.name}{analyte.unit ? ` (${analyte.unit})` : ''}</h4>
            <p>{material.name} · lot {material.lotNumber}{material.levelLabel ? ` · ${material.levelLabel}` : ''}</p>
          </div>
        </div>
        {points.length === 0 ? (
          <div className="lj-empty">
            No control results have been recorded for this analyte yet. Run the control from
            Routine Work &rarr; Quality control; the chart draws itself from the runs.
          </div>
        ) : (
          <>
            <RunChart points={points} dp={dp} low={analyte.acceptableLow} high={analyte.acceptableHigh} />
            <div className="lj-stats">
              <div><dt>Results (n)</dt><dd>{statistics.n}</dd></div>
              <div><dt>Observed mean</dt><dd>{fmt(statistics.mean, dp)}</dd></div>
              <div><dt>Observed SD</dt><dd>{fmt(statistics.sd, dp + 1)}</dd></div>
              <div><dt>CV%</dt><dd>{fmt(statistics.cv, 1)}</dd></div>
            </div>
          </>
        )}
        <div className="lj-establish">
          <strong>No SD, so no control limits yet.</strong>
          <p>
            {target && target.n
              ? `${target.n} usable result${target.n === 1 ? '' : 's'} over ${target.days} day${target.days === 1 ? '' : 's'} so far.`
              : `${points.length} result${points.length === 1 ? '' : 's'} recorded so far.`}
            {' '}A mean and SD may be established from this laboratory&rsquo;s own runs of this lot —
            20 results over 20 separate days is the definitive set (CLSI C24, ISO 15189:2022 §7.3.7.2),
            and 20 over 5 days may serve as interim limits meanwhile. Until then a result is checked
            against the acceptable range only; Westgard needs an SD to work with.
          </p>
          {canEstablish && onEstablish && (
            <button type="button" onClick={onEstablish}>Establish the limits from our own runs</button>
          )}
        </div>
      </div>
    );
  }

  const zoneBand = (from: number, to: number, className: string) => {
    const yTop = scale.y(mean! + to * sd!);
    const yBottom = scale.y(mean! + from * sd!);
    return <rect key={`${from}-${to}-${className}`} x={PAD.left} y={yTop} width={PLOT_W} height={Math.max(0, yBottom - yTop)} className={className} />;
  };

  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${scale.x(i)},${scale.y(p.result_value)}`).join(' ');

  // Date ticks: about six, evenly spaced, never overlapping.
  const tickEvery = Math.max(1, Math.ceil(points.length / 6));

  // Where a lot change falls in the series, so the step has a visible cause.
  const lotMarkers = lotChanges
    .map(lc => ({ lc, index: points.findIndex(p => p.run_date >= lc.change_date) }))
    .filter(m => m.index > 0);

  return (
    <div className="lj">
      <div className="lj-head">
        <div>
          <h4>{analyte.name}{analyte.unit ? ` (${analyte.unit})` : ''}</h4>
          <p>
            {material.name} · lot {material.lotNumber}
            {material.levelLabel ? ` · ${material.levelLabel}` : ''}
            {material.source === 'in_house' ? ' · in-house' : ''}
          </p>
        </div>
        <ul className="lj-key">
          <li><span className="k-dot ok" /> In control</li>
          <li><span className="k-dot warn" /> 1₂ₛ warning</li>
          <li><span className="k-dot bad" /> Rejected</li>
        </ul>
      </div>

      {target?.source === 'established' && (
        <p className={`lj-provenance${target.provisional ? ' is-interim' : ''}`}>
          <strong>{target.provisional ? 'Interim limits' : 'Limits established here'}</strong>
          {' — '}SD {fmt(target.sd, dp + 1)} calculated from {target.n} of this laboratory&rsquo;s own results
          over {target.days} day{target.days === 1 ? '' : 's'}
          {target.from ? `, ${target.from} to ${target.to}` : ''}.
          {target.provisional
            ? ` ${target.pointsShort > 0 ? `${target.pointsShort} more result${target.pointsShort === 1 ? '' : 's'}` : 'No more results'}${target.pointsShort > 0 && target.daysShort > 0 ? ' and ' : ''}${target.daysShort > 0 ? `${target.daysShort} more day${target.daysShort === 1 ? '' : 's'}` : ''} before the definitive set of 20 over 20 days is complete. Treat a rejection against interim limits as a prompt to look, not as a verdict.`
            : ' Twenty results over twenty days: the definitive set (CLSI C24).'}
          {canEstablish && onEstablish && (
            <button type="button" className="lj-recalc" onClick={onEstablish}>Recalculate</button>
          )}
        </p>
      )}

      <div className="lj-plot">
        <svg viewBox={`0 0 ${W} ${H}`} role="img"
          aria-label={`Levey-Jennings chart for ${analyte.name}, ${points.length} results`}>
          {/* SD zones, drawn outward so the outer bands sit behind the inner */}
          {zoneBand(-scale.extent, scale.extent, 'lj-zone-3')}
          {zoneBand(-2, 2, 'lj-zone-2')}
          {zoneBand(-1, 1, 'lj-zone-1')}

          {/* Control limits */}
          {[3, 2, 1, 0, -1, -2, -3].map(k => {
            const value = mean! + k * sd!;
            const y = scale.y(value);
            const isMean = k === 0;
            return (
              <g key={k}>
                <line x1={PAD.left} x2={PAD.left + PLOT_W} y1={y} y2={y}
                  className={isMean ? 'lj-mean' : Math.abs(k) === 3 ? 'lj-limit-3' : 'lj-limit'} />
                <text x={PAD.left + PLOT_W + 8} y={y + 3.5} className={isMean ? 'lj-lbl-mean' : 'lj-lbl'}>
                  {isMean ? 'Mean' : `${k > 0 ? '+' : '−'}${Math.abs(k)}SD`}
                </text>
                <text x={PAD.left - 8} y={y + 3.5} className="lj-axis" textAnchor="end">{fmt(value, dp)}</text>
              </g>
            );
          })}

          {/* Lot changes */}
          {lotMarkers.map(({ lc, index }) => {
            const x = (scale.x(index) + scale.x(index - 1)) / 2;
            return (
              <g key={lc.change_date}>
                <line x1={x} x2={x} y1={PAD.top} y2={PAD.top + PLOT_H} className="lj-lotline" />
                <text x={x + 4} y={PAD.top + 11} className="lj-lotlbl">New lot</text>
              </g>
            );
          })}

          {/* Series */}
          <path d={line} className="lj-line" fill="none" />

          {points.map((p, i) => {
            const rejected = isRejection(p.rule_violation) || p.status === 'out_of_control';
            const warned = !rejected && p.status === 'warning';
            const cls = rejected ? 'bad' : warned ? 'warn' : 'ok';
            const x = scale.x(i), y = scale.y(p.result_value);
            const off = scale.offScale(p.result_value);
            const above = scale.z(p.result_value) > 0;
            return (
              <g key={p.id} onMouseEnter={() => setHover(p)} onMouseLeave={() => setHover(null)}>
                {off ? (
                  // Off-scale: a triangle pointing the way the result went.
                  <polygon
                    points={above ? `${x},${y - 6} ${x - 5.5},${y + 4} ${x + 5.5},${y + 4}` : `${x},${y + 6} ${x - 5.5},${y - 4} ${x + 5.5},${y - 4}`}
                    className={`lj-pt ${cls}`}
                  />
                ) : (
                  <circle cx={x} cy={y} r={rejected ? 5.5 : 4} className={`lj-pt ${cls}`} />
                )}
                {rejected && (
                  <text x={x} y={above ? y + 20 : y - 11} className="lj-rule" textAnchor="middle">
                    {off ? `${RULE_LABELS[p.rule_violation ?? ''] ?? '!'} · off scale` : (RULE_LABELS[p.rule_violation ?? ''] ?? '!')}
                  </text>
                )}
                {/* A generous invisible target keeps the points hoverable */}
                <circle cx={x} cy={y} r={11} fill="transparent" />
              </g>
            );
          })}

          {/* Date axis */}
          {points.map((p, i) => (i % tickEvery === 0 || i === points.length - 1) && (
            <text key={`t${p.id}`} x={scale.x(i)} y={PAD.top + PLOT_H + 20} className="lj-axis" textAnchor="middle">
              {p.run_date.slice(5)}
            </text>
          ))}
          <text x={PAD.left + PLOT_W / 2} y={H - 6} className="lj-axis-title" textAnchor="middle">
            Run date · {points.length} results
          </text>
        </svg>

        {hover && (
          <div className="lj-tip">
            <strong>{fmt(hover.result_value, dp)}{analyte.unit ? ` ${analyte.unit}` : ''}</strong>
            <span>{hover.run_date}{hover.run_time ? ` ${hover.run_time}` : ''}</span>
            <span>z = {fmt(hover.z_score, 2)}</span>
            {hover.rule_violation && hover.rule_violation !== 'within_control' && (
              <span className={isRejection(hover.rule_violation) ? 'bad' : 'warn'}>
                {RULE_LABELS[hover.rule_violation] ?? hover.rule_violation}
              </span>
            )}
            {scale.offScale(hover.result_value) && <span className="bad">Off scale — beyond ±{scale.extent} SD</span>}
            {hover.equipment_name && <span className="muted">{hover.equipment_name}</span>}
            {hover.operator_name && <span className="muted">{hover.operator_name}</span>}
          </div>
        )}
      </div>

      {/* The numbers an assessor asks for: what it did, against what it should. */}
      <div className="lj-stats">
        <div><dt>Results (n)</dt><dd>{statistics.n}</dd></div>
        <div><dt>Observed mean</dt><dd>{fmt(statistics.mean, dp)}</dd></div>
        <div><dt>Observed SD</dt><dd>{fmt(statistics.sd, dp + 1)}</dd></div>
        <div>
          <dt>CV%</dt>
          <dd className={statistics.cv !== null && statistics.cv > 10 ? 'warn' : undefined}>{fmt(statistics.cv, 1)}</dd>
        </div>
        <div><dt>Target mean</dt><dd>{fmt(mean, dp)}</dd></div>
        <div><dt>Target SD</dt><dd>{fmt(sd, dp + 1)}</dd></div>
        <div>
          <dt>Bias</dt>
          <dd>{fmt(statistics.bias, dp)}{statistics.biasPercent !== null ? ` (${fmt(statistics.biasPercent, 1)}%)` : ''}</dd>
        </div>
        <div>
          <dt title="How far the observed mean sits from target, in target SDs. Beyond ±2 warrants investigation.">SD index</dt>
          <dd className={statistics.sdIndex !== null && Math.abs(statistics.sdIndex) > 2 ? 'bad' : undefined}>
            {fmt(statistics.sdIndex, 2)}
          </dd>
        </div>
      </div>

      {/* Every rejection in the window, so the chart is self-explaining */}
      {(() => {
        const rejections = points.filter(p => isRejection(p.rule_violation));
        if (rejections.length === 0) return null;
        const byRule = new Map<string, number>();
        for (const r of rejections) byRule.set(r.rule_violation!, (byRule.get(r.rule_violation!) ?? 0) + 1);
        return (
          <div className="lj-violations">
            <strong>{rejections.length} rejected {rejections.length === 1 ? 'result' : 'results'} in this window</strong>
            <ul>
              {[...byRule.entries()].map(([rule, count]) => (
                <li key={rule}>
                  <span className="lj-vrule">{RULE_LABELS[rule] ?? rule}</span>
                  <span className="lj-vcount">×{count}</span>
                  <span className="lj-vmean">{RULE_MEANING[rule] ?? ''}</span>
                </li>
              ))}
            </ul>
          </div>
        );
      })()}
    </div>
  );
}

/* ----------------------------------------------------------------------------
   The chart to draw when there is no SD to draw one against
   ----------------------------------------------------------------------------
   Not a Levey-Jennings chart and it does not pretend to be: no SD zones, no
   z axis, no rule labels. Just the results in date order against the acceptable
   range, scaled to the data. It exists because "we have no SD yet" is not the
   same as "we have nothing", and the bench that has run this control forty
   times deserves to see the forty points while the statistics are being
   established rather than an empty box.
   ------------------------------------------------------------------------- */
function RunChart({ points, dp, low, high }: {
  points: ChartPoint[]; dp: number; low: number | null; high: number | null;
}) {
  const values = points.map(p => p.result_value).filter(v => Number.isFinite(v));
  if (!values.length) return null;

  const candidates = [...values, ...(low !== null ? [low] : []), ...(high !== null ? [high] : [])];
  const rawMin = Math.min(...candidates);
  const rawMax = Math.max(...candidates);
  // A flat series would otherwise divide by zero and collapse the plot.
  const pad = Math.max((rawMax - rawMin) * 0.12, Math.abs(rawMax) * 0.02, 0.5);
  const top = rawMax + pad;
  const bottom = rawMin - pad;

  const y = (v: number) => PAD.top + ((top - Math.min(top, Math.max(bottom, v))) / (top - bottom)) * PLOT_H;
  const x = (i: number) => PAD.left + (points.length === 1 ? PLOT_W / 2 : (i / (points.length - 1)) * PLOT_W);
  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(p.result_value)}`).join(' ');
  const tickEvery = Math.max(1, Math.ceil(points.length / 6));

  return (
    <div className="lj-plot">
      <svg viewBox={`0 0 ${W} ${H}`} role="img"
        aria-label={`Control results for this analyte, ${points.length} results, no control limits established yet`}>
        {low !== null && high !== null && (
          <rect x={PAD.left} y={y(high)} width={PLOT_W} height={Math.max(0, y(low) - y(high))} className="lj-zone-1" />
        )}
        {[low, high].map((limit, index) => limit === null ? null : (
          <g key={index}>
            <line x1={PAD.left} x2={PAD.left + PLOT_W} y1={y(limit)} y2={y(limit)} className="lj-limit-3" />
            <text x={PAD.left + PLOT_W + 8} y={y(limit) + 3.5} className="lj-lbl">{index === 0 ? 'Low' : 'High'}</text>
            <text x={PAD.left - 8} y={y(limit) + 3.5} className="lj-axis" textAnchor="end">{fmt(limit, dp)}</text>
          </g>
        ))}
        <path d={line} className="lj-line" fill="none" />
        {points.map((p, i) => {
          const outside = (low !== null && p.result_value < low) || (high !== null && p.result_value > high);
          return <circle key={p.id} cx={x(i)} cy={y(p.result_value)} r={4} className={`lj-pt ${outside ? 'bad' : 'ok'}`} />;
        })}
        {points.map((p, i) => (i % tickEvery === 0 || i === points.length - 1) && (
          <text key={`t${p.id}`} x={x(i)} y={PAD.top + PLOT_H + 20} className="lj-axis" textAnchor="middle">
            {p.run_date.slice(5)}
          </text>
        ))}
        <text x={PAD.left + PLOT_W / 2} y={H - 6} className="lj-axis-title" textAnchor="middle">
          Run date · {points.length} results · no control limits established yet
        </text>
      </svg>
    </div>
  );
}
