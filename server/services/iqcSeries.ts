/**
 * Lots in series, and the period each one may be run in.
 *
 * One rule governs this file, and everything else follows from it: A RUN
 * BELONGS TO THE LOT THAT WAS OPEN ON THE DAY IT WAS RUN. A reading recorded
 * against the lot that had already been thrown away is not a clerical slip —
 * it is a quality control record attributing a number to material that was not
 * in the analyser, and every chart, mean and standard deviation built on it is
 * wrong in a way nobody can see afterwards.
 *
 * So the period is enforced where runs are written, and the series exists so
 * that enforcing it does not cost the laboratory its continuity: when a run is
 * refused, the lot that WAS open that day is named, and it is one click away.
 */
import { lotPeriod, inUseOn, periodLabel, type LotDates } from '../../shared/constants/iqcSeries.js';

type DB = any;

/** A material row's dates, in the shape the shared helpers read. */
export function materialDates(material: any): LotDates {
  return {
    inUseFrom: material?.in_use_from ?? null,
    inUseTo: material?.in_use_to ?? null,
    expiryDate: material?.expiry_date ?? null,
  };
}

/** A lot's period, from its row. */
export function periodOf(material: any) {
  return lotPeriod(materialDates(material));
}

/** Two names are the same examination, loosely compared. */
const key = (value: unknown) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** The unit a control is run by, however it was recorded. */
function sectionOf(db: DB, material: any): number | null {
  if (material.performing_section_id != null) return Number(material.performing_section_id);
  if (material.section_id != null) return Number(material.section_id);
  if (material.equipment_id == null) return null;
  const row = db.prepare('SELECT section_id FROM equipment_items WHERE id = ?').get(material.equipment_id) as any;
  return row?.section_id ?? null;
}

/** The series a lot belongs to: the first lot of its chain. */
export function seriesRoot(db: DB, materialId: number): number {
  const row = db.prepare('SELECT series_id FROM iqc_materials WHERE id = ?').get(materialId) as any;
  return Number(row?.series_id ?? materialId);
}

export interface SeriesOutcome {
  ok: boolean;
  error?: string;
  status?: number;
  seriesId?: number;
  continuesId?: number | null;
}

/**
 * Whether this lot may be said to continue that one.
 *
 * A series is ONE control at ONE level, run by ONE unit. Level 1 and Level 2 of
 * the same product are two series, because they are two materials with two
 * target means — putting them on one line would average a normal control with
 * an abnormal one and call the result a trend. The checks are refusals rather
 * than warnings for the same reason: a series joined wrongly is not visible
 * afterwards, it just looks like a control that drifted.
 */
export function checkSeries(db: DB, options: {
  continuesMaterialId: number;
  /** The lot being registered or edited. Absent while it is being created. */
  materialId?: number | null;
  testName: string;
  levelLabel: string | null;
  sectionId: number | null;
}): SeriesOutcome {
  const predecessor = db.prepare('SELECT * FROM iqc_materials WHERE id = ?').get(options.continuesMaterialId) as any;
  if (!predecessor) return { ok: false, status: 404, error: 'The lot this one continues is not on the register.' };
  if (options.materialId && Number(options.materialId) === Number(predecessor.id)) {
    return { ok: false, status: 400, error: 'A lot cannot continue itself.' };
  }
  // A chain that loops has no first lot, so nothing can be ordered on the sheet.
  if (options.materialId && Number(seriesRoot(db, Number(predecessor.id))) === Number(options.materialId)) {
    return { ok: false, status: 400, error: 'That lot already continues this one, so the series would loop.' };
  }
  if (key(predecessor.test_name) !== key(options.testName)) {
    return { ok: false, status: 400, error: `Lot ${predecessor.lot_number} is a control for ${predecessor.test_name}. A series is one examination.` };
  }
  if (key(predecessor.level_label) !== key(options.levelLabel)) {
    return {
      ok: false, status: 400,
      error: `Lot ${predecessor.lot_number} is ${predecessor.level_label || 'unlevelled'}. A series is one level — register another series for ${options.levelLabel || 'this level'}.`,
    };
  }
  const theirs = sectionOf(db, predecessor);
  if (theirs != null && options.sectionId != null && Number(theirs) !== Number(options.sectionId)) {
    return { ok: false, status: 400, error: `Lot ${predecessor.lot_number} is run by another unit. A series belongs to the unit that runs it.` };
  }
  return { ok: true, seriesId: seriesRoot(db, Number(predecessor.id)), continuesId: Number(predecessor.id) };
}

/** The lots a new lot could be said to continue: same test, same level, same unit. */
export function seriesCandidates(db: DB, options: {
  sectionId: number | null; testName?: string | null; levelLabel?: string | null; excludeId?: number | null;
}): Array<Record<string, unknown>> {
  const rows = db.prepare(`SELECT m.*, e.name AS equipment_name,
        COALESCE(m.performing_section_id, m.section_id, e.section_id) AS resolved_section_id
      FROM iqc_materials m LEFT JOIN equipment_items e ON e.id = m.equipment_id
      WHERE m.is_active = 1
      ORDER BY m.material_name, m.level_label, COALESCE(m.in_use_from, m.created_at) DESC`).all() as any[];

  return rows
    .filter(row => {
      if (options.excludeId && Number(row.id) === Number(options.excludeId)) return false;
      if (options.sectionId != null && row.resolved_section_id != null
        && Number(row.resolved_section_id) !== Number(options.sectionId)) return false;
      if (options.testName && key(row.test_name) !== key(options.testName)) return false;
      if (options.levelLabel !== undefined && options.levelLabel !== null
        && key(row.level_label) !== key(options.levelLabel)) return false;
      return true;
    })
    .map(row => {
      const period = periodOf(row);
      return {
        id: Number(row.id),
        materialName: row.material_name,
        testName: row.test_name,
        levelLabel: row.level_label ?? null,
        lotNumber: row.lot_number,
        seriesId: Number(row.series_id ?? row.id),
        equipmentName: row.equipment_name ?? null,
        sectionId: row.resolved_section_id ?? null,
        inUseFrom: period.from,
        inUseTo: period.to,
        period: periodLabel(materialDates(row)),
        lotsInSeries: Number((db.prepare('SELECT COUNT(*) AS n FROM iqc_materials WHERE series_id = ?')
          .get(Number(row.series_id ?? row.id)) as any)?.n ?? 1),
      };
    });
}

/**
 * Whether a run may be recorded against this lot on this day.
 *
 * Refused outside the period, and the refusal names the lot of the same series
 * that WAS in use — so the bench is redirected rather than blocked. A lot with
 * no period stated is not refused anything: the laboratory has not said when it
 * was in use, and inventing a limit for it would be the system's opinion rather
 * than the laboratory's record.
 */
export function guardRunDate(db: DB, material: any, runDate: string): { ok: boolean; error?: string } {
  const period = periodOf(material);
  if (period.open || inUseOn(materialDates(material), runDate)) return { ok: true };

  const seriesId = Number(material.series_id ?? material.id);
  const siblings = db.prepare('SELECT * FROM iqc_materials WHERE series_id = ? AND id != ? AND is_active = 1')
    .all(seriesId, material.id) as any[];
  const open = siblings.find(row => inUseOn(materialDates(row), runDate));

  const was = period.from && runDate < period.from
    ? `was not in use until ${period.from}`
    : `was in use until ${period.to}${period.endIsExpiry ? ' (its expiry date)' : ''}`;
  return {
    ok: false,
    error: open
      ? `Lot ${material.lot_number} ${was}. On ${runDate} the lot in use was ${open.lot_number} — record the run against that lot.`
      : `Lot ${material.lot_number} ${was}, so no run can be recorded against it on ${runDate}. Correct the lot's period, or record the run against the lot that was in use.`,
  };
}

/**
 * Runs already on the record that fall outside their lot's period.
 *
 * Nothing recorded is ever moved or hidden, so a period narrowed after the fact
 * leaves runs standing outside it. They are counted and shown as such: the
 * period can then be corrected, which is the likelier fault, rather than the
 * history being quietly reshaped to fit a date somebody typed.
 */
export function runsOutsidePeriod(db: DB, materialIds: number[]): Map<number, number> {
  const out = new Map<number, number>();
  if (materialIds.length === 0) return out;
  const placeholders = materialIds.map(() => '?').join(', ');
  const materials = db.prepare(`SELECT id, in_use_from, in_use_to, expiry_date FROM iqc_materials
      WHERE id IN (${placeholders})`).all(...materialIds) as any[];
  const count = db.prepare(`SELECT COUNT(*) AS n FROM iqc_runs
      WHERE iqc_material_id = ? AND (( ? IS NOT NULL AND run_date < ?) OR (? IS NOT NULL AND run_date > ?))`);
  for (const material of materials) {
    const period = periodOf(material);
    if (period.open) continue;
    const n = Number((count.get(material.id, period.from, period.from, period.to, period.to) as any)?.n ?? 0);
    if (n > 0) out.set(Number(material.id), n);
  }
  return out;
}
