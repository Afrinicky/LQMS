/**
 * Units, and the arithmetic between them.
 *
 * ----------------------------------------------------------------------------
 * Why this exists
 * ----------------------------------------------------------------------------
 * A Sysmex XN shows RET# on its own screen as 267.3 ×10⁹/L and transmits the
 * same reading to a LIS as 0.2673 ×10⁶/µL. Both are correct and they are the
 * same concentration. Nothing was corrupted — but a laboratory reading the two
 * side by side sees two different numbers, and a system comparing one against a
 * target expressed in the other compares 0.2673 with 267.3 and calls a
 * perfectly good control a thousandfold failure.
 *
 * Until now SECHLIMS recorded whatever unit arrived and never looked at it
 * again. Form was guarded — a percentage could not fill a count, which is the
 * fix that came out of the WBC differentials — but SCALE was not, and scale is
 * the other half of the same mistake.
 *
 * ----------------------------------------------------------------------------
 * What it will and will not do
 * ----------------------------------------------------------------------------
 * It converts only where the conversion is a matter of arithmetic: the same
 * physical quantity written at a different scale. ×10⁹/L and ×10⁶/µL are the
 * same dimension and differ by a factor this file can derive, so that one is
 * safe to do automatically and silently.
 *
 * It will NOT convert between dimensions that need to know what the analyte is.
 * mg/dL to mmol/L needs a molar mass; it is different for glucose, urea and
 * creatinine, and a system that guesses one produces a number that looks
 * entirely plausible and is wrong. Those return null, and a null here must
 * always mean "leave the value alone and say so", never "assume they match".
 *
 * A laboratory that genuinely needs such a conversion gives the factor itself,
 * per parameter, and then it is their declared number rather than our guess.
 */

/** The physical kind of a unit. Conversion never crosses these. */
export type UnitDimension =
  /** Things counted in a volume: cells per litre, per microlitre. */
  | 'count_per_volume'
  /** Mass in a volume: g/L, g/dL, mg/dL. */
  | 'mass_per_volume'
  /** Amount of substance in a volume: mmol/L, µmol/L. */
  | 'substance_per_volume'
  /** A proportion. */
  | 'fraction'
  /** A volume of one thing within another: fL, mL. */
  | 'volume'
  /** Mass alone: pg, g. */
  | 'mass'
  /** Known to us, but nothing to convert. */
  | 'dimensionless'
  /** Not recognised. */
  | 'unknown';

export interface UnitInfo {
  /** The spelling this unit was written in. */
  readonly raw: string;
  /** A single spelling every equivalent writing collapses onto. */
  readonly canonical: string;
  readonly dimension: UnitDimension;
  /**
   * How many base units one of these is. The base is per litre for counts,
   * g/L for mass concentration, mmol/L for substance, 1 for a fraction.
   * Null where the unit is known but not on a scale.
   */
  readonly factor: number | null;
}

/* ============================================================================
   Writing the same unit twelve ways
   ----------------------------------------------------------------------------
   Analysers are inventive. 10^9/L, 10*9/L, 10E9/L, x10(9)/L, ×10⁹/L and
   "10 9 / L" all turn up, as do µL, uL, ul and mcL. None of that is a
   different unit, so none of it is allowed to look like one.
   ========================================================================= */

const SUPERSCRIPT: Record<string, string> = {
  '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4',
  '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9',
};

/**
 * Reduce a written unit to a comparable skeleton.
 *
 * Case, spaces, the multiplication sign, brackets and the several ways of
 * writing an exponent all come off. What is left is the unit itself.
 */
export function normaliseUnit(raw: unknown): string {
  let text = String(raw ?? '').trim();
  if (!text) return '';
  // Superscript digits become ordinary ones, but a RUN of them has to keep
  // saying it was an exponent: 10⁶ flattened naively reads as one hundred and
  // six, which is a different unit and a silently wrong one.
  text = text.replace(/[⁰¹²³⁴-⁹]+/g,
    run => `^${[...run].map(c => SUPERSCRIPT[c] ?? c).join('')}`);
  text = text
    .replace(/µ|μ/g, 'u')        // µ and Greek mu both mean micro
    .replace(/×/g, 'x')               // × is x
    .replace(/\s+/g, '')
    .toLowerCase();
  // The exponent, however it was written: 10^9, 10*9, 10e9, x10(9), 10**9.
  text = text
    .replace(/^x/, '')
    .replace(/10\s*(?:\^|\*\*|\*|e|\()\s*(\d+)\s*\)?/g, '10^$1');
  // Microlitre, spelled every way a vendor has ever spelled it.
  text = text.replace(/\bmcl\b/g, 'ul').replace(/\bµl\b/g, 'ul');
  // Per is a slash.
  text = text.replace(/per/g, '/');
  return text;
}

/* ----------------------------------------------------------------------------
   The table
   ----------------------------------------------------------------------------
   Factors are to the base of each dimension:
     count_per_volume      per litre
     mass_per_volume       g/L
     substance_per_volume  mmol/L
     fraction              1 (a bare proportion; % is 0.01)
   -------------------------------------------------------------------------- */

interface UnitRow { dimension: UnitDimension; factor: number | null; canonical: string }

const TABLE: Record<string, UnitRow> = {};

const define = (canonical: string, dimension: UnitDimension, factor: number | null, ...spellings: string[]) => {
  for (const s of [canonical, ...spellings]) TABLE[normaliseUnit(s)] = { dimension, factor, canonical };
};

/* Counts in a volume. One per microlitre is 10^6 per litre. */
define('/L', 'count_per_volume', 1, 'L-1', '1/L', 'cells/L');
define('10^3/L', 'count_per_volume', 1e3);
define('10^6/L', 'count_per_volume', 1e6);
define('10^9/L', 'count_per_volume', 1e9, 'G/L', 'giga/L');
define('10^12/L', 'count_per_volume', 1e12, 'T/L', 'tera/L');
define('/uL', 'count_per_volume', 1e6, 'uL-1', '1/uL', 'cells/uL', '/mcL', '/cumm', '/mm3');
define('10^3/uL', 'count_per_volume', 1e9, 'K/uL', 'k/uL', 'thou/uL');
define('10^6/uL', 'count_per_volume', 1e12, 'M/uL', 'mil/uL');
define('10^3/mm3', 'count_per_volume', 1e9);
define('10^6/mm3', 'count_per_volume', 1e12);

/* Mass in a volume. Base g/L. */
define('g/L', 'mass_per_volume', 1);
define('g/dL', 'mass_per_volume', 10, 'gm/dL', 'g/100mL');
define('mg/dL', 'mass_per_volume', 0.01, 'mgs/dL', 'mg/100mL');
define('mg/L', 'mass_per_volume', 1e-3);
define('ug/L', 'mass_per_volume', 1e-6);
define('ug/dL', 'mass_per_volume', 1e-5);
define('ng/mL', 'mass_per_volume', 1e-6);
define('pg/mL', 'mass_per_volume', 1e-9);

/* Amount of substance in a volume. Base mmol/L. */
define('mmol/L', 'substance_per_volume', 1);
define('umol/L', 'substance_per_volume', 1e-3);
define('nmol/L', 'substance_per_volume', 1e-6);
define('mol/L', 'substance_per_volume', 1e3);
define('mEq/L', 'substance_per_volume', 1);

/* Proportions. A percentage is a hundredth. */
define('%', 'fraction', 0.01, 'percent', 'pct', '%%');
define('ratio', 'fraction', 1, 'fraction', '1');

/* Volumes, masses and the rest: known, and convertible within themselves. */
define('fL', 'volume', 1);
define('mL', 'volume', 1e12);
define('L', 'volume', 1e15);
define('pg', 'mass', 1);
define('g', 'mass', 1e12);
define('mg', 'mass', 1e9);
define('U/L', 'dimensionless', null, 'IU/L', 'iu/L', 'U/l');
define('s', 'dimensionless', null, 'sec', 'seconds');

/**
 * What is this unit?
 *
 * An unrecognised unit is reported as unknown rather than guessed at. Unknown
 * is a perfectly good answer: it stops a conversion rather than inventing one.
 */
export function unitInfo(raw: unknown): UnitInfo {
  const normalised = normaliseUnit(raw);
  const text = String(raw ?? '').trim();
  if (!normalised) return { raw: text, canonical: '', dimension: 'unknown', factor: null };
  const row = TABLE[normalised];
  if (!row) return { raw: text, canonical: text, dimension: 'unknown', factor: null };
  return { raw: text, canonical: row.canonical, dimension: row.dimension, factor: row.factor };
}

/** Are these two the same unit, however each was spelled? */
export function sameUnit(a: unknown, b: unknown): boolean {
  const left = normaliseUnit(a);
  const right = normaliseUnit(b);
  if (!left || !right) return false;
  if (left === right) return true;
  const infoA = unitInfo(a);
  const infoB = unitInfo(b);
  return infoA.dimension !== 'unknown'
    && infoA.dimension === infoB.dimension
    && infoA.factor !== null
    && infoA.factor === infoB.factor;
}

/** How one unit relates to another, when the relation is pure arithmetic. */
export function conversionFactor(from: unknown, to: unknown): number | null {
  const a = unitInfo(from);
  const b = unitInfo(to);
  if (a.dimension === 'unknown' || b.dimension === 'unknown') return null;
  if (a.dimension !== b.dimension) return null;
  if (a.factor === null || b.factor === null) return null;
  if (b.factor === 0) return null;
  return a.factor / b.factor;
}

export type ConversionRefusal = 'same' | 'no_unit' | 'not_a_number' | 'unknown_unit' | 'different_dimension';

/**
 * The result of attempting a conversion.
 *
 * Written as one shape rather than a discriminated union on purpose: this
 * project compiles with `strict` off, so narrowing by `ok` does not apply and
 * a union would force every caller into a cast. `ok` is the only field to
 * branch on; the rest are filled according to which way it went.
 */
export interface ConversionOutcome {
  /** True when `value` holds a number safe to use. */
  ok: boolean;
  /** The converted reading. Only when ok. */
  value?: number;
  /** What the original was multiplied by. Only when ok. */
  factor?: number;
  from?: string;
  to?: string;
  /** False when the units were already the same, so nothing moved. */
  changed?: boolean;
  /** Why it was refused. Only when not ok. */
  reason?: ConversionRefusal;
  /** What to tell somebody. Only when not ok. */
  note?: string;
}

/**
 * Convert a reading, or refuse and say why.
 *
 * The refusal matters more than the conversion. Every caller must treat a
 * refusal as "keep the original value AND the original unit", because the one
 * thing worse than an unconverted number is a converted one that was never
 * convertible.
 */
export function convertValue(value: unknown, from: unknown, to: unknown): ConversionOutcome {
  const fromText = String(from ?? '').trim();
  const toText = String(to ?? '').trim();
  if (!toText || !fromText) {
    return { ok: false, reason: 'no_unit', note: 'One of the two units is not stated, so nothing can be worked out.' };
  }
  if (sameUnit(fromText, toText)) {
    const n = Number(String(value ?? '').trim());
    if (!Number.isFinite(n)) return { ok: false, reason: 'not_a_number', note: 'That reading is not a number.' };
    return { ok: true, value: n, factor: 1, from: fromText, to: toText, changed: false };
  }
  const n = Number(String(value ?? '').trim());
  if (!Number.isFinite(n)) {
    return { ok: false, reason: 'not_a_number', note: 'That reading is not a number, so it cannot be converted.' };
  }
  const a = unitInfo(fromText);
  const b = unitInfo(toText);
  if (a.dimension === 'unknown' || b.dimension === 'unknown') {
    return {
      ok: false, reason: 'unknown_unit',
      note: `${a.dimension === 'unknown' ? fromText : toText} is not a unit this system knows, so it will not guess at the arithmetic.`,
    };
  }
  if (a.dimension !== b.dimension) {
    return {
      ok: false, reason: 'different_dimension',
      note: `${fromText} and ${toText} measure different kinds of thing. Converting between them needs to know what the analyte is — `
        + 'a molar mass, for instance — and a wrong one produces a number that looks entirely plausible.',
    };
  }
  const factor = conversionFactor(fromText, toText);
  if (factor === null) {
    return { ok: false, reason: 'different_dimension', note: `${fromText} cannot be rescaled to ${toText}.` };
  }
  return { ok: true, value: round(n * factor), factor, from: fromText, to: toText, changed: factor !== 1 };
}

/**
 * Trim the floating-point dust a conversion leaves.
 *
 * 267.3 / 1000 is 0.26730000000000004, and a laboratory should never be shown
 * that. Twelve significant figures is far beyond any analyser's precision and
 * well inside a double's, so nothing real is lost.
 */
function round(n: number): number {
  if (!Number.isFinite(n) || n === 0) return n;
  return Number(n.toPrecision(12));
}

/**
 * May these two readings be compared at all?
 *
 * Used wherever a number meets a target: a control's mean, a reference range,
 * a delta check. Where this says no, the comparison must not happen — an
 * out-of-control verdict reached by comparing 0.2673 against 267.3 is not a
 * finding, it is a fault.
 */
export function comparable(a: unknown, b: unknown): { ok: boolean; factor: number | null; note?: string } {
  const left = String(a ?? '').trim();
  const right = String(b ?? '').trim();
  // Where either side does not state a unit there is nothing to contradict.
  // That is the long-standing behaviour and it stays: a laboratory that has
  // never entered units must not have its quality control stop overnight.
  if (!left || !right) return { ok: true, factor: 1 };
  if (sameUnit(left, right)) return { ok: true, factor: 1 };
  const factor = conversionFactor(left, right);
  if (factor !== null) return { ok: true, factor };
  return {
    ok: false, factor: null,
    note: `The reading is in ${left} and the target is in ${right}. These cannot be reconciled automatically.`,
  };
}

/** Every unit this system knows, for a picker. */
export function knownUnits(): Array<{ canonical: string; dimension: UnitDimension }> {
  const seen = new Map<string, UnitDimension>();
  for (const row of Object.values(TABLE)) if (!seen.has(row.canonical)) seen.set(row.canonical, row.dimension);
  return [...seen].map(([canonical, dimension]) => ({ canonical, dimension }))
    .sort((x, y) => x.dimension.localeCompare(y.dimension) || x.canonical.localeCompare(y.canonical));
}
