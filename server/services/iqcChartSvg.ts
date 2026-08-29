/**
 * The Levey-Jennings chart as SVG, for anything printed.
 *
 * Drawn on the server so a printed quality record needs no browser rendering
 * beyond laying out the page — a laboratory host that never sees the internet
 * must still be able to print a chart. The geometry comes from
 * shared/utils/leveyJennings.ts, which is the same module the on-screen chart
 * uses, so the printed chart and the screen cannot drift apart.
 *
 * It is also why a control with no assigned SD still prints something: the
 * scale falls back to the observed spread, or to a plain value axis, and says
 * on the page which it did. A blank rectangle on a signed record is
 * indistinguishable from a fault.
 */
import { ljScale, ljChartTitle, type LjScale } from '../../shared/utils/leveyJennings.js';
import { RULE_LABELS } from '../../shared/constants/iqc.js';

export interface ChartPointRow {
  run_date: string;
  result_value: number | null;
  is_qualitative?: number | null;
  status?: string | null;
  rule_violation?: string | null;
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

export const CHART_GEOMETRY = { width: 980, height: 360, padTop: 20, padRight: 110, padBottom: 48, padLeft: 70 };
/** A second, shorter box for the several charts that share a multi-run report. */
export const COMPACT_GEOMETRY = { width: 980, height: 240, padTop: 16, padRight: 106, padBottom: 36, padLeft: 68 };

export interface RenderedChart {
  svg: string;
  scale: LjScale | null;
  title: string;
  caveat: string | null;
}

/**
 * Draw the series. `points` may include qualitative results; they are skipped,
 * because a Levey-Jennings chart is a chart of numbers.
 */
export function renderLjSvg(
  points: ChartPointRow[],
  targetMean: number | null | undefined,
  targetSd: number | null | undefined,
  decimals: number,
  geometry = CHART_GEOMETRY,
): RenderedChart {
  const fmt = (v: unknown, d = decimals) =>
    (v === null || v === undefined || Number.isNaN(Number(v)) ? '—' : Number(v).toFixed(d));

  const numeric = points.filter(p => Number(p.is_qualitative) !== 1 && p.result_value !== null);
  const plotW = geometry.width - geometry.padLeft - geometry.padRight;
  const plotH = geometry.height - geometry.padTop - geometry.padBottom;
  const scale = ljScale(numeric.map(p => Number(p.result_value)), targetMean, targetSd, geometry);

  if (!scale) {
    return {
      svg: `<text x="${geometry.width / 2}" y="${geometry.padTop + plotH / 2}" font-size="12" fill="#6b7686" text-anchor="middle">`
        + 'No numeric control results in this period.</text>',
      scale: null,
      title: ljChartTitle('target'),
      caveat: null,
    };
  }

  const { centre, sd: bandSd, extent, y, x } = scale;
  let svg = '';

  if (centre !== null && bandSd !== null && extent !== null) {
    const band = (a: number, b: number, fill: string) =>
      `<rect x="${geometry.padLeft}" y="${y(centre + b * bandSd)}" width="${plotW}" `
      + `height="${Math.max(0, y(centre + a * bandSd) - y(centre + b * bandSd))}" fill="${fill}"/>`;
    svg += band(-extent, extent, '#fdeaec') + band(-2, 2, '#fef6e6') + band(-1, 1, '#eafaf2');
  }

  for (const g of scale.gridlines) {
    const yy = y(g.value);
    const stroke = g.kind === 'mean' ? '#1849c0' : g.kind === 'outer' ? '#d64258' : '#b9c2d0';
    const dash = g.kind === 'mean' ? '' : ' stroke-dasharray="4 4"';
    svg += `<line x1="${geometry.padLeft}" x2="${geometry.padLeft + plotW}" y1="${yy}" y2="${yy}" `
      + `stroke="${stroke}" stroke-width="${g.kind === 'mean' ? 1.6 : 1}"${dash}/>`;
    if (g.label) {
      svg += `<text x="${geometry.padLeft + plotW + 7}" y="${yy + 3.5}" font-size="10" `
        + `fill="${g.kind === 'mean' ? '#1849c0' : '#6b7686'}">${esc(g.label)}</text>`;
    }
    svg += `<text x="${geometry.padLeft - 8}" y="${yy + 3.5}" font-size="9.5" fill="#6b7686" text-anchor="end">${fmt(g.value)}</text>`;
  }

  svg += `<polyline fill="none" stroke="#98a2b3" stroke-width="1.3" points="`
    + numeric.map((p, i) => `${x(i)},${y(Number(p.result_value))}`).join(' ') + '"/>';

  numeric.forEach((p, i) => {
    const rejected = p.status === 'out_of_control';
    const warned = p.status === 'warning';
    const colour = rejected ? '#d64258' : warned ? '#d99413' : '#199e6b';
    const px = x(i), py = y(Number(p.result_value));
    svg += scale.offScale(Number(p.result_value))
      ? `<polygon points="${px},${py - 6} ${px - 5},${py + 4} ${px + 5},${py + 4}" fill="${colour}"/>`
      : `<circle cx="${px}" cy="${py}" r="${rejected ? 4.5 : 3.4}" fill="${colour}"/>`;
    if (rejected) {
      svg += `<text x="${px}" y="${py - 9}" font-size="8.5" fill="#d64258" text-anchor="middle">`
        + `${esc(RULE_LABELS[String(p.rule_violation ?? '')] ?? '!')}</text>`;
    }
  });

  const every = Math.max(1, Math.ceil(numeric.length / 8));
  numeric.forEach((p, i) => {
    if (i % every === 0 || i === numeric.length - 1) {
      svg += `<text x="${x(i)}" y="${geometry.padTop + plotH + 18}" font-size="9" fill="#6b7686" text-anchor="middle">`
        + `${esc(String(p.run_date).slice(5))}</text>`;
    }
  });

  return { svg, scale, title: ljChartTitle(scale.mode), caveat: scale.caveat };
}

/** The whole <svg> element, sized for the page. */
export function ljSvgElement(rendered: RenderedChart, geometry = CHART_GEOMETRY, height = 300): string {
  return `<svg viewBox="0 0 ${geometry.width} ${geometry.height}" width="100%" height="${height}" `
    + `xmlns="http://www.w3.org/2000/svg">${rendered.svg}</svg>`;
}
