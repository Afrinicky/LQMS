import { useMemo, useState } from 'react';
import { RULE_LABELS, RULE_MEANING, isRejection } from '../../shared/constants/iqc';
import { ljScale, ljChartTitle } from '../../shared/utils/leveyJennings';

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

export type ChartData = {
  analyte: {
    id: number; name: string; unit: string | null; decimalPlaces: number;
    targetMean: number | null; targetSd: number | null;
    acceptableLow: number | null; acceptableHigh: number | null;
  };
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

export default function LeveyJenningsChart({ data }: { data: ChartData }) {
  const [hover, setHover] = useState<ChartPoint | null>(null);
  const { analyte, material, statistics, points, lotChanges } = data;
  const dp = analyte.decimalPlaces ?? 2;

  const mean = analyte.targetMean;
  const sd = analyte.targetSd;

  // How the vertical axis is worked out — including the case that used to make
  // this chart give up: a control with a mean but no assigned SD, or too few
  // runs to have a spread. See shared/utils/leveyJennings.ts. The chart is
  // always drawn; what changes is what it is honestly called.
  const scale = useMemo(
    () => ljScale(points.map(p => p.result_value), mean, sd, {
      padTop: PAD.top, padRight: PAD.right, padBottom: PAD.bottom, padLeft: PAD.left, width: W, height: H,
    }),
    [points, mean, sd],
  );

  if (!scale) {
    return <div className="lj-empty">No control results recorded for this analyte yet.</div>;
  }

  const centre = scale.centre;
  const bandSd = scale.sd;

  const zoneBand = (from: number, to: number, className: string) => {
    if (centre === null || bandSd === null) return null;
    const yTop = scale.y(centre + to * bandSd);
    const yBottom = scale.y(centre + from * bandSd);
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
            {ljChartTitle(scale.mode)} · {material.name} · lot {material.lotNumber}
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

      {scale.caveat && <p className="lj-caveat">{scale.caveat}</p>}

      <div className="lj-plot">
        <svg viewBox={`0 0 ${W} ${H}`} role="img"
          aria-label={`Levey-Jennings chart for ${analyte.name}, ${points.length} results`}>
          {/* SD zones, drawn outward so the outer bands sit behind the inner.
              Nothing to shade when the chart is a run chart. */}
          {scale.extent !== null && zoneBand(-scale.extent, scale.extent, 'lj-zone-3')}
          {scale.extent !== null && zoneBand(-2, 2, 'lj-zone-2')}
          {scale.extent !== null && zoneBand(-1, 1, 'lj-zone-1')}

          {/* Control limits, or a plain value axis where there are none yet */}
          {scale.gridlines.map((g, i) => {
            const y = scale.y(g.value);
            return (
              <g key={`${g.kind}-${g.k ?? i}`}>
                <line x1={PAD.left} x2={PAD.left + PLOT_W} y1={y} y2={y}
                  className={g.kind === 'mean' ? 'lj-mean' : g.kind === 'outer' ? 'lj-limit-3' : 'lj-limit'} />
                {g.label && (
                  <text x={PAD.left + PLOT_W + 8} y={y + 3.5} className={g.kind === 'mean' ? 'lj-lbl-mean' : 'lj-lbl'}>
                    {g.label}
                  </text>
                )}
                <text x={PAD.left - 8} y={y + 3.5} className="lj-axis" textAnchor="end">{fmt(g.value, dp)}</text>
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
            const above = (scale.z(p.result_value) ?? p.result_value - (centre ?? 0)) > 0;
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
            {scale.mode !== 'target' && <span className="warn">Provisional scale — no assigned SD</span>}
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
