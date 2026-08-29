/**
 * Where a control's mean and SD come from when nobody supplied them.
 *
 * A commercial control usually arrives with an assayed mean and a range, and
 * very often with no SD at all — the insert gives a range because the range is
 * the only thing the manufacturer can state across every instrument in the
 * world. An in-house control arrives with nothing. Either way the laboratory
 * ends up with a control it can record against and cannot judge: no SD means no
 * z score, no Westgard, and a Levey-Jennings chart with nothing to draw.
 *
 * The standards do not treat that as a gap to be filled with the vendor's
 * number. ISO 15189:2022 §7.3.7.2 requires QC data to be reviewed against the
 * laboratory's own performance, and CLSI C24 is explicit about the arithmetic:
 *
 *   - the mean and SD are established from the laboratory's OWN runs of THAT
 *     lot, on THAT instrument, by THOSE operators — imprecision is a property
 *     of the measuring system, not of the vial;
 *   - twenty data points collected over twenty separate days is the definitive
 *     set, because twenty days is what makes it span the between-day component
 *     of imprecision rather than one good morning;
 *   - twenty points over at least five days may be used as INTERIM limits while
 *     the twenty days accumulate, and are replaced once they are in;
 *   - a point outside ±3 SD of the preliminary mean is excluded once, as an
 *     outlier belonging to an event rather than to the process, and the
 *     statistics are recomputed on what remains.
 *
 * Three things this module refuses to do, all for the same reason — a control
 * limit is a clinical decision and has to be defensible:
 *
 *   it never overwrites a mean or SD a human entered. A vendor's assayed SD, or
 *   one a laboratory established elsewhere and typed in, is the laboratory's
 *   decision and outranks anything computed here.
 *
 *   it never establishes from rejected runs. A run that failed was investigated
 *   and repeated; folding it back into the target would widen the limits by
 *   exactly the amount of the fault they exist to catch.
 *
 *   it never hides which it used. Everything downstream — the chart, the run
 *   evaluation, the printed record — is told whether the limits are the
 *   vendor's, the laboratory's definitive set, or interim, and interim says so
 *   on its face.
 */
import { chartStatistics } from './iqcEvaluation.js';

type DB = any;

/** Twenty points over twenty days: the definitive set (CLSI C24). */
export const DEFINITIVE_POINTS = 20;
export const DEFINITIVE_DAYS = 20;
/** Twenty points over five days: interim limits, until the twenty days are in. */
export const INTERIM_POINTS = 20;
export const INTERIM_DAYS = 5;

export type TargetSource = 'vendor' | 'established' | 'none';

export type EffectiveTarget = {
  mean: number | null;
  sd: number | null;
  /** Where the pair being used actually came from. */
  source: TargetSource;
  /** 'definitive' | 'interim' when source is 'established'. */
  basis: string | null;
  n: number | null;
  days: number | null;
  from: string | null;
  to: string | null;
  establishedAt: string | null;
  /** True while the SD in use is interim and the twenty days are incomplete. */
  provisional: boolean;
  /** How many more points are needed before a definitive set exists. */
  pointsShort: number;
  daysShort: number;
};

const num = (v: unknown): number | null =>
  v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v);

/**
 * The mean and SD this analyte is actually judged against right now.
 *
 * The order is the order of authority: what a human entered wins, because
 * somebody took responsibility for it. What the laboratory established from its
 * own data comes next. Nothing at all is a legitimate third state, and the
 * screens say so rather than pretending a chart exists.
 */
export function effectiveTarget(analyte: any): EffectiveTarget {
  const vendorMean = num(analyte?.target_mean);
  const vendorSd = num(analyte?.target_sd);
  const ownMean = num(analyte?.established_mean);
  const ownSd = num(analyte?.established_sd);
  const n = num(analyte?.established_n);
  const days = num(analyte?.established_days);
  const basis = analyte?.established_basis ? String(analyte.established_basis) : null;

  const shape = {
    n: n === null ? null : Math.round(n),
    days: days === null ? null : Math.round(days),
    from: analyte?.established_from ?? null,
    to: analyte?.established_to ?? null,
    establishedAt: analyte?.established_at ?? null,
    pointsShort: Math.max(0, DEFINITIVE_POINTS - Math.round(n ?? 0)),
    daysShort: Math.max(0, DEFINITIVE_DAYS - Math.round(days ?? 0)),
  };

  // Both entered by hand: the laboratory's own decision, used as given.
  if (vendorMean !== null && vendorSd !== null && vendorSd > 0) {
    return { ...shape, mean: vendorMean, sd: vendorSd, source: 'vendor', basis: null, provisional: false };
  }
  // The common case: an assayed mean with no SD. The mean stays the vendor's —
  // it is the target the control is meant to hit — and only the SD, which is
  // this laboratory's imprecision and nobody else's, is established.
  if (ownSd !== null && ownSd > 0) {
    const mean = vendorMean !== null ? vendorMean : ownMean;
    if (mean !== null) {
      return {
        ...shape, mean, sd: ownSd, source: 'established', basis,
        provisional: basis !== 'definitive',
      };
    }
  }
  return { ...shape, mean: vendorMean ?? ownMean, sd: null, source: 'none', basis: null, provisional: false };
}

/** The analyte row with its effective mean and SD written into the target fields. */
export function withEffectiveTarget<T extends Record<string, any>>(analyte: T): T & { effectiveTarget: EffectiveTarget } {
  const target = effectiveTarget(analyte);
  return { ...analyte, target_mean: target.mean, target_sd: target.sd, effectiveTarget: target };
}

export type EstablishOutcome = {
  analyteId: number;
  analyte: string;
  changed: boolean;
  /** Why nothing was established, when nothing was. */
  reason: string | null;
  target: EffectiveTarget;
};

/**
 * Establish this analyte's own mean and SD from the runs the laboratory has
 * actually done, and store them.
 *
 * Only the CURRENT lot's results count. A lot change is a new control material
 * row in this system, so "the current lot" is simply this analyte's own
 * results — but a laboratory that reuses a row across lots would otherwise pool
 * two populations into one SD, so the lot-change date, where there is one,
 * cuts the window.
 */
export function establishTargets(db: DB, analyteId: number, options?: { userId?: number | null; force?: boolean }): EstablishOutcome {
  const analyte = db.prepare(`SELECT a.*, m.control_type, m.id AS material_id
      FROM iqc_analytes a JOIN iqc_materials m ON m.id = a.iqc_material_id WHERE a.id = ?`).get(analyteId) as any;
  if (!analyte) throw new Error('Analyte not found');

  const stop = (reason: string): EstablishOutcome => ({
    analyteId, analyte: analyte.analyte, changed: false, reason, target: effectiveTarget(analyte),
  });

  // Only a quantitative control has an SD to establish. A qualitative one is
  // judged against the result it is supposed to give, and a semi-quantitative
  // one against its range.
  if (analyte.control_type !== 'quantitative') {
    return stop('Only a quantitative control has a mean and SD to establish.');
  }
  // A human-entered SD is a decision, not a gap. It is left alone unless the
  // laboratory explicitly asks for it to be recalculated.
  if (!options?.force && num(analyte.target_sd) !== null && Number(analyte.target_sd) > 0) {
    return stop('This analyte already has an SD entered on its definition; nothing was recalculated.');
  }

  // Where this lot's data starts, if the laboratory recorded a change onto it.
  const lotChange = db.prepare(`SELECT MAX(change_date) AS d FROM iqc_lot_changes WHERE new_iqc_material_id = ?`)
    .get(analyte.material_id) as any;
  const since = lotChange?.d ?? null;

  const rows = db.prepare(`SELECT res.result_value, res.run_date
      FROM iqc_results res
      WHERE res.iqc_analyte_id = ?
        AND res.result_value IS NOT NULL
        AND COALESCE(res.is_qualitative, 0) != 1
        -- A rejected run was investigated and repeated. Folding it back in
        -- would widen the limits by the size of the fault they exist to catch.
        AND res.status IN ('accepted', 'warning')
        ${since ? 'AND res.run_date >= ?' : ''}
      ORDER BY res.run_date, res.id`).all(...(since ? [analyteId, since] : [analyteId])) as any[];

  const points = rows
    .map(r => ({ value: Number(r.result_value), date: String(r.run_date) }))
    .filter(p => Number.isFinite(p.value));

  if (points.length < INTERIM_POINTS) {
    return stop(`${points.length} of ${INTERIM_POINTS} results needed. Interim limits can be set from ${INTERIM_POINTS} results over ${INTERIM_DAYS} days; the definitive set is ${DEFINITIVE_POINTS} over ${DEFINITIVE_DAYS} days.`);
  }

  // ---- One pass of outlier exclusion, on the preliminary statistics --------
  // A single point past ±3 SD belongs to an event — a bubble, a short sample, a
  // mis-keyed decimal — not to the process whose spread is being measured.
  // CLSI removes it once and recomputes; removing repeatedly would shrink the
  // SD until ordinary variation started looking like a failure.
  const preliminary = chartStatistics(points.map(p => p.value), null, null);
  let kept = points;
  let excluded = 0;
  if (preliminary.mean !== null && preliminary.sd !== null && preliminary.sd > 0) {
    const low = preliminary.mean - 3 * preliminary.sd;
    const high = preliminary.mean + 3 * preliminary.sd;
    kept = points.filter(p => p.value >= low && p.value <= high);
    excluded = points.length - kept.length;
  }

  if (kept.length < INTERIM_POINTS) {
    return stop(`Only ${kept.length} results remain once ${excluded} outlier${excluded === 1 ? '' : 's'} beyond ±3 SD are set aside — ${INTERIM_POINTS} are needed.`);
  }

  const days = new Set(kept.map(p => p.date)).size;
  if (days < INTERIM_DAYS) {
    return stop(`${kept.length} results, but only over ${days} day${days === 1 ? '' : 's'}. Limits established inside ${INTERIM_DAYS} days measure one run's repeatability, not the between-day imprecision a control has to catch.`);
  }

  const stats = chartStatistics(kept.map(p => p.value), null, null);
  if (stats.mean === null || stats.sd === null || !(stats.sd > 0)) {
    return stop('These results carry no spread at all, so no SD can be established from them.');
  }

  const definitive = kept.length >= DEFINITIVE_POINTS && days >= DEFINITIVE_DAYS;
  const basis = definitive ? 'definitive' : 'interim';
  const dates = kept.map(p => p.date).sort();

  db.prepare(`UPDATE iqc_analytes SET established_mean = ?, established_sd = ?, established_n = ?,
      established_days = ?, established_from = ?, established_to = ?, established_at = CURRENT_TIMESTAMP,
      established_by = ?, established_basis = ?, established_excluded = ? WHERE id = ?`)
    .run(stats.mean, stats.sd, kept.length, days, dates[0], dates[dates.length - 1],
      options?.userId ?? null, basis, excluded, analyteId);

  const updated = db.prepare('SELECT * FROM iqc_analytes WHERE id = ?').get(analyteId);
  return { analyteId, analyte: analyte.analyte, changed: true, reason: null, target: effectiveTarget(updated) };
}

/** Every analyte on one control, so a whole FBC panel is done in one act. */
export function establishForMaterial(db: DB, materialId: number, options?: { userId?: number | null; force?: boolean }): EstablishOutcome[] {
  const analytes = db.prepare('SELECT id FROM iqc_analytes WHERE iqc_material_id = ? AND is_active = 1 ORDER BY display_order, id').all(materialId) as any[];
  return analytes.map(a => establishTargets(db, Number(a.id), options));
}

/**
 * Called after a run is saved: keep the established limits current without
 * anybody having to remember to.
 *
 * Every accepted result moves the cumulative set on by one, and the twentieth
 * one is the one that turns a control that could not be judged into a control
 * that can. Waiting for somebody to press a button would mean that transition
 * happening weeks late, or never.
 *
 * It never throws. A run being recorded is the important act; failing to
 * refresh a statistic must not lose it.
 */
export function refreshEstablishedTargets(db: DB, materialId: number, userId?: number | null): void {
  try {
    const material = db.prepare('SELECT control_type FROM iqc_materials WHERE id = ?').get(materialId) as any;
    if (!material || material.control_type !== 'quantitative') return;
    establishForMaterial(db, materialId, { userId: userId ?? null });
  } catch { /* the run is recorded either way */ }
}
