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
 *   TARGET     — assigned mean and SD. The real thing: ±1/2/3 SD zones, Westgard
 *                rules mean what they say.
 *   OBSERVED   — no assigned SD, but the runs so far have a usable spread. Limits
 *                are drawn from the observed mean and SD and labelled provisional,
 *                because they describe what the method HAS done, not what it
 *                SHOULD do. Useful for seeing drift; not evidence of control.
 *   PLAIN      — neither. Fewer than two results, or every result identical (an
 *                SD of zero). Points are plotted on an ordinary value axis with
 *                the target mean drawn if there is one. It is a run chart, and
 *                it is called one.
 */

export type LjMode = 'target' | 'observed' | 'plain';

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
): LjScale | null {
  if (values.length === 0) return null;

  const plotW = geometry.width - geometry.padLeft - geometry.padRight;
  const plotH = geometry.height - geometry.padTop - geometry.padBottom;
  const x = (i: number) => geometry.padLeft + (values.length === 1 ? plotW / 2 : (i / (values.length - 1)) * plotW);

  const mean = typeof targetMean === 'number' && Number.isFinite(targetMean) ? targetMean : null;

  // Which centre and spread to draw from.
  let mode: LjMode; let centre: number | null; let sd: number | null;
  if (mean !== null && usableSd(targetSd)) {
    mode = 'target'; centre = mean; sd = targetSd;
  } else {
    const observedMean = values.reduce((a, b) => a + b, 0) / values.length;
    const observedSd = values.length >= 2
      ? Math.sqrt(values.reduce((sum, v) => sum + (v - observedMean) ** 2, 0) / (values.length - 1))
      : 0;
    if (usableSd(observedSd)) {
      mode = 'observed'; centre = mean ?? observedMean; sd = observedSd;
    } else {
      mode = 'plain'; centre = mean ?? observedMean; sd = null;
    }
  }

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
        label: k === 0 ? (mode === 'observed' ? 'Mean (obs.)' : 'Mean') : `${k > 0 ? '+' : '−'}${Math.abs(k)}SD`,
        kind: (k === 0 ? 'mean' : Math.abs(k) === 3 ? 'outer' : 'limit') as 'mean' | 'limit' | 'outer',
      }));
    return {
      mode, centre, sd, extent, clipped: needed > extent, top, bottom, y, x,
      offScale: (value: number) => Math.abs((value - centre!) / sd!) > extent,
      z: (value: number) => (value - centre!) / sd!,
      gridlines,
      caveat: mode === 'observed'
        ? 'No SD is assigned to this control, so the limits below are drawn from the results themselves and are provisional. '
          + 'They show how this method has behaved, not what it should do — set an assigned mean and SD, or establish them from at least 20 runs, before treating them as control limits.'
        : null,
    };
  }

  // Plain: an ordinary value axis around the data, padded so a flat series does
  // not sit on the frame. A control run five times with the same number is a
  // real and common thing on a new lot, and it must still draw.
  const min = Math.min(...values, ...(mean !== null ? [mean] : []));
  const max = Math.max(...values, ...(mean !== null ? [mean] : []));
  const span = max - min;
  const pad = span > 0 ? span * 0.35 : Math.max(Math.abs(max) * 0.1, 1);
  const top = max + pad;
  const bottom = min - pad;
  const y = (value: number) => {
    const clamped = Math.min(top, Math.max(bottom, value));
    return geometry.padTop + ((top - clamped) / (top - bottom)) * plotH;
  };
  const ticks = 5;
  const gridlines: LjScale['gridlines'] = Array.from({ length: ticks }, (_, i) => ({
    value: bottom + ((top - bottom) * i) / (ticks - 1),
    k: null,
    label: '',
    kind: 'value',
  }));
  if (mean !== null) gridlines.push({ value: mean, k: 0, label: 'Target mean', kind: 'mean' });

  return {
    mode: 'plain', centre, sd: null, extent: null, clipped: false, top, bottom, y, x,
    offScale: () => false,
    z: () => null,
    gridlines,
    caveat: values.length < 2
      ? 'One result so far. This is a run chart, not a Levey-Jennings chart: control limits appear once the control has an assigned SD, or once enough runs exist to estimate one.'
      : 'Every result in this window is the same value, so there is no spread to draw limits from. This is a run chart until the control has an assigned SD or the results vary.',
  };
}

/** What to call the chart, given how it had to be scaled. */
export function ljChartTitle(mode: LjMode): string {
  return mode === 'target' ? 'Levey-Jennings chart' : mode === 'observed' ? 'Levey-Jennings chart — provisional limits' : 'Run chart — no control limits yet';
}
