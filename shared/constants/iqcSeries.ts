/**
 * A control, a lot of it, and the series the lots form.
 *
 * A laboratory does not run "a control". It runs a VIAL — a lot, with a number
 * on it, bought on a date and finished on another — and when that lot runs out
 * it buys the next one and carries on running the same control. The register
 * held each of those lots as a separate control, which is true of the material
 * and false of the work: eight lots of XN CHECK Level 1 are one control that
 * has been running for two years, and a chart that shows eight unrelated
 * entries hides exactly the continuity an assessor comes to look for.
 *
 * So a lot may say which lot it CONTINUES, and the chain is a series. Three
 * consequences, all of them the point:
 *
 *   ONE LINE ON THE SCHEDULE. The series is what a supervisor looks for, and
 *   the lots are the rows inside it — each occupying the stretch of the month
 *   it was actually in use for.
 *
 *   A LOT HAS A PERIOD, AND IT OWNS ITS OWN DATES. From the day it was put
 *   into use to the day it was exhausted, the expiry date standing as the end
 *   until somebody says otherwise. Nothing is expected of a lot outside it,
 *   and nothing may be recorded against it there either — a run on the 25th
 *   belongs to the lot that was open on the 25th.
 *
 *   A MONTH THE SERIES WAS NOT IN USE IS NOT A MONTH OF MISSED RUNS. A lot
 *   whose period does not reach into the month is not on that month's sheet
 *   at all.
 */
import type { IqcShift } from './iqcProgramme.js';

/* ============================================================================
   A lot's period
   ========================================================================= */

/** What a lot states about when it was in use, before anything is derived. */
export interface LotDates {
  inUseFrom?: string | null;
  inUseTo?: string | null;
  /** The expiry date, which stands as the end of the period unless overridden. */
  expiryDate?: string | null;
}

export interface LotPeriod {
  from: string | null;
  to: string | null;
  /** True where the end is the expiry date rather than a date somebody set. */
  endIsExpiry: boolean;
  /** True while neither end has been stated: the lot is treated as always in use. */
  open: boolean;
}

/**
 * The period a lot may be run in.
 *
 * The expiry date is the default end because that is the honest one: a lot
 * cannot be used past it. A laboratory that finished a vial early says so, and
 * that date wins.
 */
export function lotPeriod(lot: LotDates): LotPeriod {
  const from = lot.inUseFrom || null;
  const stated = lot.inUseTo || null;
  const to = stated || lot.expiryDate || null;
  return { from, to, endIsExpiry: !stated && Boolean(to), open: !from && !to };
}

/** Whether a day falls inside a lot's period. A lot with no period is always in use. */
export function inUseOn(lot: LotDates, date: string): boolean {
  const period = lotPeriod(lot);
  if (period.from && date < period.from) return false;
  if (period.to && date > period.to) return false;
  return true;
}

/** Whether a lot's period touches a window at all. */
export function periodOverlaps(lot: LotDates, from: string, to: string): boolean {
  const period = lotPeriod(lot);
  if (period.from && period.from > to) return false;
  if (period.to && period.to < from) return false;
  return true;
}

/** The period in words, for a row header and a print-out. */
export function periodLabel(lot: LotDates): string {
  const period = lotPeriod(lot);
  if (period.open) return 'No period set';
  if (period.from && period.to) return `${period.from} to ${period.to}`;
  if (period.from) return `From ${period.from}`;
  return `Until ${period.to}`;
}

/* ============================================================================
   The sheet: a series, its lots, and the days
   ========================================================================= */

/** What the sheet needs of a control. The programme's own answer satisfies it. */
export interface SheetControlLike extends LotDates {
  id: number;
  seriesId: number | null;
  continuesMaterialId?: number | null;
  materialName: string;
  testName: string;
  levelLabel: string | null;
  lotNumber: string;
  equipmentId: number | null;
  equipmentName: string | null;
  recordingBasis?: string;
  schedule: {
    frequency: string;
    shifts: IqcShift[];
    isActive: boolean;
    isDefault: boolean;
    summary: string;
  };
  days: Array<{ date: string; shift: IqcShift | null; state: string; runId: number | null; runNumber: string | null; reason: string | null; missedId: number | null }>;
  performed: number;
  missed: number;
  excused: number;
  due: number;
  compliance: number | null;
  runsOutsidePeriod?: number;
}

export interface SheetSeries<T extends SheetControlLike = SheetControlLike> {
  /** Stable across months, so the chosen sheet survives stepping through them. */
  key: string;
  seriesId: number;
  /** What the series is called: the control, at its level. */
  name: string;
  testName: string;
  equipmentName: string | null;
  /** The lots in use during the window, oldest first. */
  lots: T[];
  /** Every lot of the series, whether or not it reaches into the window. */
  lotCount: number;
  /** Lots whose periods overlap — a changeover, which is allowed and flagged. */
  changeovers: Array<{ earlier: string; later: string; from: string; to: string }>;
  /** Days in the window no lot of this series covers. */
  uncovered: number;
  performed: number;
  missed: number;
  due: number;
  compliance: number | null;
  runsOutsidePeriod: number;
}

/** The identity of a series: same control, same level, whatever the lot. */
export function seriesNameOf(control: { materialName: string; levelLabel: string | null }): string {
  return control.levelLabel ? `${control.materialName} — ${control.levelLabel}` : control.materialName;
}

const DAY_MS = 86_400_000;

/** Every day from `from` to `to` inclusive, as YYYY-MM-DD. */
export function daysOfWindow(from: string, to: string): string[] {
  const out: string[] = [];
  const end = new Date(`${to}T00:00:00Z`).getTime();
  let cursor = new Date(`${from}T00:00:00Z`).getTime();
  let guard = 0;
  while (cursor <= end && guard++ < 400) {
    out.push(new Date(cursor).toISOString().slice(0, 10));
    cursor += DAY_MS;
  }
  return out;
}

/**
 * The month's sheet: one entry per series, holding the lots that were in use.
 *
 * A series with no lot reaching into the window is left out entirely — it is
 * not a gap, it is a control the laboratory was not running that month, and
 * reporting it as missed every day is how a programme teaches people to ignore
 * it.
 */
export function buildSheet<T extends SheetControlLike>(controls: T[], from: string, to: string): Array<SheetSeries<T>> {
  const grouped = new Map<number, T[]>();
  for (const control of controls) {
    const key = Number(control.seriesId ?? control.id);
    grouped.set(key, [...(grouped.get(key) ?? []), control]);
  }

  const windowDays = daysOfWindow(from, to);
  const series: Array<SheetSeries<T>> = [];

  for (const [seriesId, all] of grouped) {
    const lots = all
      .filter(lot => periodOverlaps(lot, from, to))
      .sort((a, b) => {
        const pa = lotPeriod(a).from ?? '';
        const pb = lotPeriod(b).from ?? '';
        return pa === pb ? a.lotNumber.localeCompare(b.lotNumber) : pa.localeCompare(pb);
      });
    if (lots.length === 0) continue;

    // A changeover is two lots open at once. It is legitimate — a new lot is
    // run alongside the old one before the old one is retired — so it is
    // marked rather than refused.
    const changeovers: SheetSeries<T>['changeovers'] = [];
    for (let i = 0; i < lots.length; i++) {
      for (let j = i + 1; j < lots.length; j++) {
        const a = lotPeriod(lots[i]);
        const b = lotPeriod(lots[j]);
        const start = [a.from, b.from].filter(Boolean).sort().pop() ?? from;
        const end = [a.to, b.to].filter(Boolean).sort().shift() ?? to;
        if (start <= end && (a.from || a.to) && (b.from || b.to)) {
          changeovers.push({ earlier: lots[i].lotNumber, later: lots[j].lotNumber, from: start, to: end });
        }
      }
    }

    const covered = new Set<string>();
    for (const lot of lots) for (const date of windowDays) if (inUseOn(lot, date)) covered.add(date);

    const performed = lots.reduce((n, l) => n + l.performed, 0);
    const missed = lots.reduce((n, l) => n + l.missed, 0);
    const first = lots[0];
    series.push({
      key: `series:${seriesId}`,
      seriesId,
      name: seriesNameOf(first),
      testName: first.testName,
      equipmentName: first.equipmentName,
      lots,
      lotCount: all.length,
      changeovers,
      uncovered: windowDays.filter(date => !covered.has(date) && date <= to).length,
      performed,
      missed,
      due: lots.reduce((n, l) => n + l.due, 0),
      compliance: performed + missed === 0 ? null : Math.round((performed / (performed + missed)) * 100),
      runsOutsidePeriod: lots.reduce((n, l) => n + (l.runsOutsidePeriod ?? 0), 0),
    });
  }

  return series.sort((a, b) =>
    (a.equipmentName ?? '').localeCompare(b.equipmentName ?? '') || a.name.localeCompare(b.name));
}

/* ============================================================================
   What a cell on the sheet is
   ========================================================================= */
/** A day outside the lot's period is frozen, exactly as a day not yet due is. */
export const FROZEN_STATES = ['out_of_use', 'not_scheduled'] as const;

export const SHEET_CELL_HINTS: Record<string, string> = {
  out_of_use: 'This lot was not in use on this day',
  not_scheduled: 'No run is scheduled on this day',
};

/* ============================================================================
   The rows inside a series, and the cells inside a row
   ----------------------------------------------------------------------------
   One row per lot, because a lot is what a laboratory holds in its hand. A
   control run per shift splits into the shifts its schedule names, exactly as
   the environmental sheet splits a parameter into morning and afternoon — a
   control run once a day keeps one row, which is most of them, and the sheet
   stays short enough to read.
   ========================================================================= */

export interface SheetCell {
  date: string;
  /** 'out_of_use' outside the lot's period; 'not_scheduled' where no run is due. */
  state: string;
  runId: number | null;
  runNumber: string | null;
  reason: string | null;
  missedId: number | null;
  /** Expected runs this cell stands for — more than one only on a split row. */
  count: number;
  /** True where nothing may be entered: outside the period, or not yet due. */
  frozen: boolean;
}

export interface SheetRow<T extends SheetControlLike = SheetControlLike> {
  key: string;
  lot: T;
  shift: IqcShift | null;
  /** The lot number, and the shift where the row is one of several. */
  label: string;
  period: string;
  cells: SheetCell[];
}

/** The worst thing that happened, for a cell standing for more than one day. */
const WORST = ['rejected', 'missed', 'warning', 'excused', 'due', 'in_control'];

export function worstState(states: string[]): string {
  for (const state of WORST) if (states.includes(state)) return state;
  return states[0] ?? 'not_scheduled';
}

/** The rows one lot contributes to the sheet, with every cell of each. */
export function rowsOfLot<T extends SheetControlLike>(lot: T, days: string[], today: string): Array<SheetRow<T>> {
  const shifts: Array<IqcShift | null> = lot.schedule.frequency === 'per_shift' && lot.schedule.shifts.length
    ? [...lot.schedule.shifts]
    : [null];

  return shifts.map(shift => ({
    key: `${lot.id}:${shift ?? 'day'}`,
    lot,
    shift,
    label: shifts.length > 1 ? `${lot.lotNumber} · ${shift}` : lot.lotNumber,
    period: periodLabel(lot),
    cells: days.map(date => {
      if (!inUseOn(lot, date)) {
        return { date, state: 'out_of_use', runId: null, runNumber: null, reason: null, missedId: null, count: 0, frozen: true };
      }
      const entries = lot.days.filter(d => d.date === date && (shift === null || d.shift === null || d.shift === shift));
      if (entries.length === 0) {
        return { date, state: 'not_scheduled', runId: null, runNumber: null, reason: null, missedId: null, count: 0, frozen: true };
      }
      const state = worstState(entries.map(d => d.state));
      const answered = entries.find(d => d.runId) ?? entries.find(d => d.missedId) ?? entries[0];
      return {
        date, state,
        runId: answered.runId ?? null,
        runNumber: answered.runNumber ?? null,
        reason: answered.reason ?? null,
        missedId: answered.missedId ?? null,
        count: entries.length,
        // A day still to come cannot be answered for, exactly as the
        // environmental sheet will not take a reading before it is due.
        frozen: date > today,
      };
    }),
  }));
}
