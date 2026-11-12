/**
 * The control schedule as a month's sheet.
 *
 * The same shape the environmental monitoring log sheet has, and for the same
 * reason: that layout is what a laboratory's own paper charts look like, so
 * nobody has to be taught to read it. A sheet per series, a row per lot, a
 * column per day, and a cell that says what became of that day.
 *
 * It is assembled from the programme's own answer rather than from the runs, so
 * the screen, the printed sheet and the workbook cannot disagree about whether
 * a Tuesday was missed.
 */
import { programmeFor, type ProgrammeControl } from './iqcProgramme.js';
import {
  buildSheet, daysOfWindow, rowsOfLot, periodLabel,
  type SheetRow, type SheetSeries,
} from '../../shared/constants/iqcSeries.js';

type DB = any;

export interface SheetMonth {
  month: string;
  from: string;
  to: string;
  days: string[];
  sectionId: number | null;
  sectionName: string | null;
  series: Array<SheetSeries<ProgrammeControl> & { rows: Array<SheetRow<ProgrammeControl>> }>;
}

/** The first and last day of a YYYY-MM month. */
export function monthWindow(month: string): { from: string; to: string } {
  const [year, m] = month.split('-').map(Number);
  const from = new Date(Date.UTC(year, m - 1, 1));
  const to = new Date(Date.UTC(year, m, 0));
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

export function sheetFor(db: DB, options: { sectionId: number | null; month: string; seriesId?: number | null }): SheetMonth {
  const { from, to } = monthWindow(options.month);
  const answer = programmeFor(db, { sectionId: options.sectionId, from, to });
  const days = daysOfWindow(from, to);
  const today = new Date().toISOString().slice(0, 10);

  const series = buildSheet(answer.controls, from, to)
    .filter(group => !options.seriesId || group.seriesId === Number(options.seriesId))
    .map(group => ({
      ...group,
      rows: group.lots.flatMap(lot => rowsOfLot(lot, days, today)),
    }));

  return {
    month: options.month, from, to, days,
    sectionId: answer.sectionId, sectionName: answer.sectionName,
    series,
  };
}

/* ============================================================================
   The same sheet, as a grid of strings
   ----------------------------------------------------------------------------
   One mapping from a cell to a mark, used by the printed sheet and by the
   workbook, so the paper and the file say the same thing. A tick is a run in
   control; the rest are named rather than coloured, because a photocopy of a
   coloured chart is a chart of grey squares.
   ========================================================================= */
export const CELL_MARKS: Record<string, string> = {
  in_control: '✓',
  warning: 'W',
  rejected: '✗',
  missed: '—',
  excused: 'A',
  due: '',
  not_scheduled: '',
  out_of_use: '',
};

export const MARK_LEGEND = '✓ run, in control · W warning · ✗ rejected · — not run · A not run, accounted for · shaded: lot not in use';

/** A series' rows as plain cells, ready for a table or a worksheet. */
export function gridRows(group: SheetMonth['series'][number]): Array<{
  label: string; period: string; marks: string[]; performed: number; missed: number; compliance: string;
}> {
  return group.rows.map(row => {
    const performed = row.cells.filter(c => ['in_control', 'warning', 'rejected'].includes(c.state)).length;
    const missed = row.cells.filter(c => c.state === 'missed').length;
    return {
      label: row.label,
      period: row.period,
      marks: row.cells.map(cell => CELL_MARKS[cell.state] ?? ''),
      performed,
      missed,
      compliance: performed + missed === 0 ? '—' : `${Math.round((performed / (performed + missed)) * 100)}%`,
    };
  });
}

/**
 * A blank month to fill offline.
 *
 * In the shape the run importer already reads — one row per reading, with the
 * lot, the date and the analyte already in place — because a month of a
 * thirty-parameter control is a thousand cells, and because a sheet that loads
 * straight back in through the evaluation every typed run goes through is
 * worth more than one that matches the paper exactly and has to be transcribed.
 *
 * Only the days the programme actually expects a run on are offered, and only
 * for the lot that was in use on each of them.
 */
export function blankMonthRows(db: DB, sheet: SheetMonth): unknown[][] {
  const rows: unknown[][] = [];
  for (const group of sheet.series) {
    for (const lot of group.lots) {
      const analytes = db.prepare(`SELECT analyte FROM iqc_analytes WHERE iqc_material_id = ? AND is_active = 1
          ORDER BY display_order, id`).all(lot.id) as Array<{ analyte: string }>;
      const expected = lot.days.filter(d => d.state !== 'not_scheduled');
      for (const day of expected) {
        for (const analyte of (analytes.length ? analytes : [{ analyte: lot.testName }])) {
          rows.push([
            lot.lotNumber, day.date, '', day.shift ?? '', lot.equipmentName ?? '', '', '',
            analyte.analyte, '', '', '',
          ]);
        }
      }
    }
  }
  return rows;
}

/** The period of every lot on the sheet, for a header that says what is covered. */
export function periodsOf(sheet: SheetMonth): string {
  return sheet.series
    .flatMap(group => group.lots.map(lot => `${lot.lotNumber} (${periodLabel(lot)})`))
    .join('; ');
}
