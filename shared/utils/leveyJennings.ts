/**
 * The geometry of a Levey-Jennings chart, in one place.
 *
 * It lives here because the chart is drawn twice — as SVG in the browser and as
 * SVG on the server for the printed record — and a printed chart that does not
 * match the screen is worse than no printed chart at all. Both callers ask this
 * module where the lines go.
 *
 * THE CASE THIS EXISTS FOR: a control with no target SD.
 *
 * A new control usually has one. Assigned mean, no assigned SD, or an SD the
 * laboratory intends to establish from its own runs — ISO 15189 expects exactly
 * that, and the define-a-control screen invites it ("leave the mean and SD blank
 * if you are establishing them from your own runs"). The old chart treated that
 * as undrawable: on screen it said so, and on the printout it silently drew
 * nothing, leaving a page with a heading, a statistics strip and a blank
 * rectangle where the chart should be. A blank rectangle on a signed quality
 * record is indistinguishable from a fault.
 *
 * So there are three ways to scale the same series, and the chart says which
 * one it used:
 *
 *   TARGET     — an SD to scale against: the vendor's, or the one this
 *                laboratory established from its own runs. The real thing:
 *                ±1/2/3 SD zones, Westgard rules mean what they say.
 *   PLAIN      — no SD yet. Points are plotted on an ordinary value axis
 *                against the acceptable range, which is what a result IS
 *                checked against until limits exist. It is a run chart, and it
 *                is called one.
 *
 * There is deliberately no third mode that computes ±1/2/3 SD bands from the
 * handful of results recorded so far. This laboratory establishes its limits
 * from 20 results over 20 days (see server/services/iqcTargets.ts); bands drawn
 * from four results would look exactly like control limits on the page and
 * invite Westgard rules to be read off them, which is the opposite of what that
 * policy says. Until there is an SD, the honest chart is a run chart.
 */

export type LjMode = 'target' | 'plain';

export interface LjSeriesPoint {
  value: number;
}

export interface LjScale {
  mode: LjMode;
  /** The centre line, when there is one to draw. */
  centre: number | null;
  /** The SD the bands are drawn from. Null in plain mode. */
  sd: number | null;
  /** How many SDs the axis spans either side of the centre. Null in plain mode. */
  extent: number | null;
  /** Whether a point had to be pinned to the edge of the axis. */
  clipped: boolean;
  top: number;
  bottom: number;
  /** Where a value sits vertically, in the plot's own pixel space. */
  y: (value: number) => number;
  /** Where the nth point sits horizontally. */
  x: (index: number) => number;
  /** Is this value beyond the drawn axis? */
  offScale: (value: number) => boolean;
  /** Distance from the centre in SDs — null when there is no SD to divide by. */
  z: (value: number) => number | null;
  /** The horizontal lines to draw, outermost first, with their labels. */
  gridlines: { value: number; k: number | null; label: string; kind: 'mean' | 'limit' | 'outer' | 'value' }[];
  /** In a run chart, the acceptable range to shade. Absent when limits exist. */
  acceptable?: { low: number | null; high: number | null };
  /** What to tell the reader about how this chart is scaled. Null when it is the real thing. */
  caveat: string | null;
}

export interface LjGeometry {
  padTop: number; padRight: number; padBottom: number; padLeft: number;
  width: number; height: number;
}

/** The default extent either side of the centre, and the most we will stretch to. */
const BASE_EXTENT = 4;
const MAX_EXTENT = 6;

function usableSd(sd: number | null | undefined): sd is number {
  return typeof sd === 'number' && Number.isFinite(sd) && sd > 0;
}

/**
 * Work out how to scale a series.
 *
 * `targetMean`/`targetSd` are what the control was assigned. `values` are the
 * numeric results in the window, in order. Everything else is the plot box.
 */
export function ljScale(
  values: number[],
  targetMean: number | null | undefined,
  targetSd: number | null | undefined,
  geometry: LjGeometry,
  range?: { low?: number | null; high?: number | null },
): LjScale | null {
  const acceptableLow = range?.low ?? null;
  const acceptableHigh = range?.high ?? null;
  if (values.length === 0) return null;

  const plotW = geometry.width - geometry.padLeft - geometry.padRight;
  const plotH = geometry.height - geometry.padTop - geometry.padBottom;
  const x = (i: number) => geometry.padLeft + (values.length === 1 ? plotW / 2 : (i / (values.length - 1)) * plotW);

  const mean = typeof targetMean === 'number' && Number.isFinite(targetMean) ? targetMean : null;

  // An SD to scale against, or none. `targetSd` is already the EFFECTIVE SD by
  // the time it reaches here — the vendor's where one was entered, otherwise
  // the one established from this laboratory's own runs — so this is the whole
  // test.
  const mode: LjMode = mean !== null && usableSd(targetSd) ? 'target' : 'plain';
  const centre: number | null = mode === 'target'
    ? mean
    : (mean ?? values.reduce((a, b) => a + b, 0) / values.length);
  const sd = mode === 'target' ? (targetSd as number) : null;

  if (sd !== null && centre !== null) {
    const zs = values.map(v => (v - centre!) / sd!);
    const needed = Math.ceil(Math.max(...zs.map(Math.abs)) + 0.5);
    const extent = Math.min(MAX_EXTENT, Math.max(BASE_EXTENT, needed));
    const top = centre + extent * sd;
    const bottom = centre - extent * sd;
    const y = (value: number) => {
      const clamped = Math.min(top, Math.max(bottom, value));
      return geometry.padTop + ((top - clamped) / (top - bottom)) * plotH;
    };
    const gridlines = [3, 2, 1, 0, -1, -2, -3]
      .filter(k => Math.abs(k) <= extent)
      .map(k => ({
        value: centre! + k * sd!,
        k,
        label: k === 0 ? 'Mean' : `${k > 0 ? '+' : '−'}${Math.abs(k)}SD`,
        kind: (k === 0 ? 'mean' : Math.abs(k) === 3 ? 'outer' : 'limit') as 'mean' | 'limit' | 'outer',
      }));
    return {
      mode, centre, sd, extent, clipped: needed > extent, top, bottom, y, x,
      offScale: (value: number) => Math.abs((value - centre!) / sd!) > extent,
      z: (value: number) => (value - centre!) / sd!,
      gridlines,
      caveat: null,
    };
  }

  // Plain: an ordinary value axis around the data AND the acceptable range, so
  // a result sitting outside the range is visibly outside it. A flat series
  // (the same number every run — real, and common on a new lot) is padded so it
  // does not sit on the frame instead of dividing by zero.
  const bounds = [
    ...values,
    ...(mean !== null ? [mean] : []),
    ...(typeof acceptableLow === 'number' && Number.isFinite(acceptableLow) ? [acceptableLow] : []),
    ...(typeof acceptableHigh === 'number' && Number.isFinite(acceptableHigh) ? [acceptableHigh] : []),
  ];
  const min = Math.min(...bounds);
  const max = Math.max(...bounds);
  const span = max - min;
  const pad = Math.max(span * 0.12, Math.abs(max) * 0.02, 0.5);
  const top = max + pad;
  const bottom = min - pad;
  const y = (value: number) => {
    const clamped = Math.min(top, Math.max(bottom, value));
    return geometry.padTop + ((top - clamped) / (top - bottom)) * plotH;
  };

  const gridlines: LjScale['gridlines'] = [];
  if (typeof acceptableHigh === 'number' && Number.isFinite(acceptableHigh)) {
    gridlines.push({ value: acceptableHigh, k: null, label: 'High', kind: 'outer' });
  }
  if (typeof acceptableLow === 'number' && Number.isFinite(acceptableLow)) {
    gridlines.push({ value: acceptableLow, k: null, label: 'Low', kind: 'outer' });
  }
  if (mean !== null) gridlines.push({ value: mean, k: 0, label: 'Target mean', kind: 'mean' });

  const hasRange = gridlines.some(g => g.kind === 'outer');
  return {
    mode: 'plain', centre, sd: null, extent: null, clipped: false, top, bottom, y, x,
    offScale: () => false,
    z: () => null,
    gridlines,
    /** Also the pair drawn as a shaded band, when both ends exist. */
    acceptable: {
      low: typeof acceptableLow === 'number' && Number.isFinite(acceptableLow) ? acceptableLow : null,
      high: typeof acceptableHigh === 'number' && Number.isFinite(acceptableHigh) ? acceptableHigh : null,
    },
    caveat: hasRange
      ? 'No control limits have been established for this parameter yet, so this is a run chart: the results in date order '
        + 'against the acceptable range. Limits are calculated from the laboratory\'s own runs — 20 results over 20 days — '
        + 'and Westgard rules apply only once they exist.'
      : 'No control limits and no acceptable range have been set for this parameter, so nothing here can be in or out of '
        + 'control. Set an acceptable range on the control, and establish limits from 20 results over 20 days.',
  };
}
/** What to call the chart, given how it had to be scaled. */
export function ljChartTitle(mode: LjMode): string {
  return mode === 'target' ? 'Levey-Jennings chart' : 'Run chart — no control limits established yet';
}
