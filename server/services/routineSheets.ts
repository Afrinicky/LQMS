/**
 * The monthly log sheet — one mechanism for three registers.
 *
 * The laboratory's temperature chart, its bench decontamination log and its
 * freezer maintenance schedule are the same object: a month across the top, the
 * things being recorded down the side, one initial per cell, and the
 * supervisor's signature at the bottom on the last day. Building them three
 * times would produce three subtly different ideas of what "verified" means,
 * which is exactly the drift an assessor finds.
 *
 * What the paper forms cannot do, and this does:
 *
 *   - a cell knows the time it was read, who read it and where the value came
 *     from, so "08:00, by whom, off the logger" survives into the record
 *   - an out-of-range reading opens an excursion the moment it is typed, rather
 *     than being noticed when the month is reviewed
 *   - the month cannot be signed while cells are missing without the supervisor
 *     being told exactly which ones, and their signature is a real one
 *   - a signed month is closed: correcting it takes an NC, which is the only
 *     honest way to change a record somebody has already attested to
 *
 * Rows are snapshotted onto the sheet when it is opened. If somebody widens a
 * fridge's acceptable range in March, February's chart still prints with the
 * range that was actually in force in February.
 */
import {
  daysInMonth, monthLabel, weekSlotForDay, cellIsBreach, sheetIsLocked,
  type SheetKind, type CellSlot,
} from '../../shared/constants/routineWork.js';
import { deconTimesPerDay } from '../../shared/constants/routineWork.js';
import { recordReading } from './environmental/monitorService.js';
import { generateRecordNumber } from '../utils/recordNumber.js';

type DB = any;

export type SubjectType = 'environmental_assets' | 'decontamination_definitions' | 'equipment_items';

const SUBJECT_FOR_KIND: Record<SheetKind, SubjectType> = {
  environmental: 'environmental_assets',
  decontamination: 'decontamination_definitions',
  equipment_maintenance: 'equipment_items',
};

export interface RowSpec {
  rowKey: string;
  label: string;
  rowType: 'numeric' | 'tick' | 'text';
  unit?: string | null;
  minValue?: number | null;
  maxValue?: number | null;
  slots: CellSlot[];
  cadence: 'daily' | 'weekly';
  sourceRef?: string | null;
}

/* ============================================================================
   What the rows of each kind of sheet are
   ========================================================================= */

function envSettings(db: DB): any {
  return db.prepare('SELECT * FROM environmental_settings WHERE id = 1').get()
    ?? { logging_mode: 'manual', reading_slots: '["am","pm"]', monthly_verification_required: 1 };
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') return (value as T) ?? fallback;
  try { const parsed = JSON.parse(value); return (parsed ?? fallback) as T; } catch { return fallback; }
}

/**
 * An environmental asset's rows: one per parameter charted, each read in each
 * configured slot. The asset may declare its own parameter set (a CO2
 * incubator, a room with a pressure differential); a plain fridge falls back to
 * the temperature and humidity limits already on the asset.
 */
function environmentalRows(db: DB, asset: any): RowSpec[] {
  const settings = envSettings(db);
  const slots = parseJson<CellSlot[]>(asset.reading_slots ?? settings.reading_slots, ['am', 'pm']);
  const declared = db.prepare('SELECT * FROM environmental_asset_parameters WHERE asset_id = ? AND is_active = 1 ORDER BY display_order, id').all(asset.id) as any[];

  if (declared.length) {
    return declared.map((p, i) => ({
      rowKey: p.parameter,
      label: `${p.label}${p.unit ? ` (${p.unit})` : ''}`,
      rowType: 'numeric' as const,
      unit: p.unit, minValue: p.min_value, maxValue: p.max_value,
      slots, cadence: 'daily' as const, sourceRef: p.parameter,
      _order: i,
    }));
  }

  const rows: RowSpec[] = [];
  if (asset.temp_min != null || asset.temp_max != null) {
    rows.push({
      rowKey: 'temperature',
      label: `Temperature (${fmtRange(asset.temp_min, asset.temp_max, '°C')})`,
      rowType: 'numeric', unit: '°C', minValue: asset.temp_min, maxValue: asset.temp_max,
      slots, cadence: 'daily', sourceRef: 'temperature',
    });
  }
  if (asset.humidity_min != null || asset.humidity_max != null) {
    rows.push({
      rowKey: 'humidity',
      label: `Relative humidity (${fmtRange(asset.humidity_min, asset.humidity_max, '%')})`,
      rowType: 'numeric', unit: '%', minValue: asset.humidity_min, maxValue: asset.humidity_max,
      slots, cadence: 'daily', sourceRef: 'humidity',
    });
  }
  // An asset with no limits at all is still charted — a reading with no
  // acceptance criterion is a weaker record, but it is not nothing, and the
  // laboratory is told about it on the sheet rather than losing the month.
  if (!rows.length) {
    rows.push({
      rowKey: 'temperature', label: 'Temperature (no range set)', rowType: 'numeric',
      unit: '°C', minValue: null, maxValue: null, slots, cadence: 'daily', sourceRef: 'temperature',
    });
  }
  return rows;
}

function fmtRange(min: number | null, max: number | null, unit: string): string {
  if (min != null && max != null) return `${min} to ${max} ${unit}`;
  if (min != null) return `not below ${min} ${unit}`;
  if (max != null) return `not above ${max} ${unit}`;
  return `no range set`;
}

/**
 * A decontamination sheet has one row — the act itself — done once or twice a
 * day, weekly, or monthly. The paper log writes AM/INITIAL/PM/INITIAL as four
 * rows; here the initials belong to the cell, which is the same information
 * without the transcription error.
 */
function decontaminationRows(definition: any, frequency: string): RowSpec[] {
  const times = deconTimesPerDay(frequency);
  const weekly = frequency === 'weekly' || frequency === 'fortnightly';
  const monthly = frequency === 'monthly' || frequency === 'quarterly';

  if (monthly) {
    return [{
      rowKey: 'decontamination', label: definition.name, rowType: 'tick',
      slots: ['once'], cadence: 'weekly', sourceRef: String(definition.id),
    }];
  }
  if (weekly) {
    return [{
      rowKey: 'decontamination', label: definition.name, rowType: 'tick',
      slots: ['w1', 'w2', 'w3', 'w4', 'w5'], cadence: 'weekly', sourceRef: String(definition.id),
    }];
  }
  return [{
    rowKey: 'decontamination', label: definition.name, rowType: 'tick',
    slots: times >= 2 ? ['am', 'pm'] : ['once'], cadence: 'daily', sourceRef: String(definition.id),
  }];
}

/**
 * An equipment maintenance chart carries every active task for the instrument,
 * each on the axis its own cadence needs: daily tasks run across the days of
 * the month, weekly and longer ones across the weeks — which is precisely how
 * the freezer schedule is laid out on paper.
 */
function maintenanceRows(db: DB, equipmentId: number): RowSpec[] {
  const tasks = db.prepare(`SELECT * FROM equipment_maintenance_tasks
      WHERE equipment_id = ? AND is_active = 1 ORDER BY maintenance_kind, display_order, id`).all(equipmentId) as any[];
  return tasks.map(t => {
    const daily = t.frequency === 'daily' || t.frequency === 'twice_daily';
    return {
      rowKey: `task_${t.id}`,
      label: t.task_text,
      rowType: 'tick' as const,
      slots: (daily
        ? (t.frequency === 'twice_daily' ? ['am', 'pm'] : ['once'])
        : ['w1', 'w2', 'w3', 'w4', 'w5']) as CellSlot[],
      cadence: (daily ? 'daily' : 'weekly') as 'daily' | 'weekly',
      sourceRef: String(t.id),
    };
  });
}

/* ============================================================================
   Opening a sheet
   ========================================================================= */

export interface OpenSheetOptions {
  kind: SheetKind;
  subjectId: number;
  month: string;              // YYYY-MM
  sectionId?: number | null;
  userId?: number | null;
  /** Do not create it if it is not there — used by read-only listings. */
  readOnly?: boolean;
}

/**
 * Fetch the sheet for a subject and month, creating it (with its rows
 * snapshotted) the first time somebody looks at it.
 */
export function openSheet(db: DB, options: OpenSheetOptions): any | null {
  const subjectType = SUBJECT_FOR_KIND[options.kind];

  // The unit is part of a sheet's identity. A laboratory-wide decontamination
  // is carried by every unit and each keeps its own log — matching on the
  // subject alone would hand Haematology Microbiology's bench log to sign.
  const built = buildSheetDefinition(db, options);
  const sectionId = built?.sectionId ?? options.sectionId ?? null;

  const existing = db.prepare(`SELECT * FROM routine_log_sheets
      WHERE sheet_kind = ? AND subject_type = ? AND subject_id = ? AND month = ?
        AND IFNULL(section_id, 0) = IFNULL(?, 0)`)
    .get(options.kind, subjectType, options.subjectId, options.month, sectionId);
  if (existing) return existing;
  if (options.readOnly || !built) return null;

  const inserted = db.prepare(`INSERT INTO routine_log_sheets
      (sheet_kind, subject_type, subject_id, section_id, month, title, subtitle, status, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)`)
    .run(options.kind, subjectType, options.subjectId, sectionId, options.month,
      built.title, built.subtitle, options.userId ?? null);
  const sheetId = Number(inserted.lastInsertRowid);

  const insertRow = db.prepare(`INSERT INTO routine_log_rows
      (sheet_id, row_key, label, row_type, unit, min_value, max_value, slots, cadence, source_ref, display_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  built.rows.forEach((r, i) => insertRow.run(sheetId, r.rowKey, r.label, r.rowType, r.unit ?? null,
    r.minValue ?? null, r.maxValue ?? null, JSON.stringify(r.slots), r.cadence, r.sourceRef ?? null, i));

  return db.prepare('SELECT * FROM routine_log_sheets WHERE id = ?').get(sheetId);
}

/** The title, subtitle and rows a sheet would be created with. */
function buildSheetDefinition(db: DB, options: OpenSheetOptions):
  { title: string; subtitle: string | null; sectionId: number | null; rows: RowSpec[] } | null {

  if (options.kind === 'environmental') {
    const asset = db.prepare('SELECT * FROM environmental_assets WHERE id = ?').get(options.subjectId) as any;
    if (!asset) return null;
    return {
      title: `${asset.name} — temperature and environment chart`,
      subtitle: [asset.asset_code, fmtRange(asset.temp_min, asset.temp_max, '°C')].filter(Boolean).join(' · '),
      sectionId: asset.responsible_section_id ?? asset.section_id ?? options.sectionId ?? null,
      rows: environmentalRows(db, asset),
    };
  }

  if (options.kind === 'decontamination') {
    const definition = db.prepare('SELECT * FROM decontamination_definitions WHERE id = ?').get(options.subjectId) as any;
    if (!definition) return null;
    const sectionId = definition.section_id ?? options.sectionId ?? null;
    const frequency = effectiveDeconFrequency(db, definition, sectionId);
    const decontaminant = effectiveDecontaminant(db, definition, sectionId);
    return {
      title: `${definition.name} — decontamination log`,
      subtitle: decontaminant ? `Decontaminant used: ${decontaminant}` : null,
      sectionId,
      rows: decontaminationRows(definition, frequency),
    };
  }

  const equipment = db.prepare('SELECT * FROM equipment_items WHERE id = ?').get(options.subjectId) as any;
  if (!equipment) return null;
  return {
    title: `${equipment.name} — maintenance chart`,
    subtitle: [equipment.equipment_number, equipment.serial_number ? `Serial no. ${equipment.serial_number}` : null]
      .filter(Boolean).join(' · ') || null,
    sectionId: equipment.section_id ?? options.sectionId ?? null,
    rows: maintenanceRows(db, options.subjectId),
  };
}

/** A unit may carry a laboratory-wide decontamination at its own frequency. */
export function effectiveDeconFrequency(db: DB, definition: any, sectionId: number | null): string {
  if (!sectionId) return definition.frequency;
  const override = db.prepare('SELECT frequency FROM decontamination_unit_settings WHERE definition_id = ? AND section_id = ?')
    .get(definition.id, sectionId) as { frequency?: string | null } | undefined;
  return override?.frequency || definition.frequency;
}

export function effectiveDecontaminant(db: DB, definition: any, sectionId: number | null): string | null {
  if (sectionId) {
    const override = db.prepare('SELECT decontaminant FROM decontamination_unit_settings WHERE definition_id = ? AND section_id = ?')
      .get(definition.id, sectionId) as { decontaminant?: string | null } | undefined;
    if (override?.decontaminant) return override.decontaminant;
  }
  return definition.decontaminant ?? null;
}

/**
 * Bring an open sheet's rows back into line with its definition.
 *
 * A unit head who adds a maintenance task on the 12th expects it on this
 * month's chart, not next month's. Rows are only ever added — never removed —
 * because a row that already carries entries is a record. An open sheet accepts
 * this; a signed one does not.
 */
export function refreshSheetRows(db: DB, sheet: any): void {
  if (sheetIsLocked(sheet.status)) return;
  const built = buildSheetDefinition(db, {
    kind: sheet.sheet_kind, subjectId: sheet.subject_id, month: sheet.month, sectionId: sheet.section_id,
  });
  if (!built) return;
  const have = new Set((db.prepare('SELECT row_key FROM routine_log_rows WHERE sheet_id = ?').all(sheet.id) as any[]).map(r => r.row_key));
  const nextOrder = (db.prepare('SELECT COALESCE(MAX(display_order), -1) + 1 AS n FROM routine_log_rows WHERE sheet_id = ?').get(sheet.id) as any).n as number;
  let order = nextOrder;
  const insertRow = db.prepare(`INSERT INTO routine_log_rows
      (sheet_id, row_key, label, row_type, unit, min_value, max_value, slots, cadence, source_ref, display_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const r of built.rows) {
    if (have.has(r.rowKey)) continue;
    insertRow.run(sheet.id, r.rowKey, r.label, r.rowType, r.unit ?? null, r.minValue ?? null,
      r.maxValue ?? null, JSON.stringify(r.slots), r.cadence, r.sourceRef ?? null, order++);
  }
}

/* ============================================================================
   Reading a sheet
   ========================================================================= */

/** The sheet, its rows, its cells and everything the screen needs to draw it. */
export function sheetPayload(db: DB, sheetId: number): any {
  const sheet = db.prepare('SELECT * FROM routine_log_sheets WHERE id = ?').get(sheetId) as any;
  if (!sheet) return null;
  const rows = (db.prepare('SELECT * FROM routine_log_rows WHERE sheet_id = ? ORDER BY display_order, id').all(sheetId) as any[])
    .map(r => ({ ...r, slots: parseJson<CellSlot[]>(r.slots, ['once']) }));
  const cells = db.prepare(`SELECT c.*, s.full_name AS recorded_by_name
      FROM routine_log_cells c LEFT JOIN staff s ON s.id = c.recorded_by_staff_id
      WHERE c.sheet_id = ? ORDER BY c.day, c.slot`).all(sheetId) as any[];

  const section = sheet.section_id
    ? db.prepare('SELECT id, name FROM sections WHERE id = ?').get(sheet.section_id) as any : null;
  const verifier = sheet.verified_by_staff_id
    ? db.prepare('SELECT full_name FROM staff WHERE id = ?').get(sheet.verified_by_staff_id) as any : null;
  const submitter = sheet.submitted_by_staff_id
    ? db.prepare('SELECT full_name FROM staff WHERE id = ?').get(sheet.submitted_by_staff_id) as any : null;
  const nc = sheet.nc_id
    ? db.prepare('SELECT id, nc_number, status FROM nonconforming_events WHERE id = ?').get(sheet.nc_id) as any : null;
  const signature = sheet.verification_signature_id
    ? db.prepare('SELECT id, signer_name, signed_at, meaning FROM e_signatures WHERE id = ?').get(sheet.verification_signature_id) as any : null;
  const attachment = sheet.attachment_file_id
    ? db.prepare('SELECT id, original_name, mime_type, size_bytes FROM files WHERE id = ?').get(sheet.attachment_file_id) as any : null;

  return {
    sheet: {
      ...sheet,
      monthLabel: monthLabel(sheet.month),
      days: daysInMonth(sheet.month),
      sectionName: section?.name ?? null,
      verifiedByName: verifier?.full_name ?? null,
      submittedByName: submitter?.full_name ?? null,
      nc, signature, attachment,
      locked: sheetIsLocked(sheet.status),
      // The laboratory's own reading window, so the grid greys the same cells
      // the server would refuse. Sending it beats the client guessing: a
      // laboratory that reads at 14:00 should not be told to wait until 15:00.
      ...readingWindow(db),
    },
    rows,
    cells,
    completeness: completeness(db, sheet, rows, cells),
    // What the month shows that no single reading does. Computed here so the
    // grid, the print and any export all report the same findings.
    trends: sheetTrends(db, sheet, rows, cells),
  };
}

/**
 * How much of the month is actually recorded, and what is missing.
 *
 * The supervisor signing at the end of the month is signing for the gaps as
 * much as the readings, so the gaps are counted for them rather than left to be
 * spotted by eye across 31 columns.
 */
export function completeness(db: DB, sheet: any, rows: any[], cells: any[]): any {
  const total = daysInMonth(sheet.month);
  const today = new Date().toISOString().slice(0, 10);
  const isCurrentMonth = today.slice(0, 7) === sheet.month;
  // Only days that have actually happened can be missing.
  const lastDay = isCurrentMonth ? Number(today.slice(8, 10)) : total;

  const filled = new Set(cells.map(c => `${c.row_id}:${c.day}:${c.slot}`));
  let expected = 0; let recorded = 0;
  const missing: Array<{ rowId: number; label: string; day: number; slot: string }> = [];

  for (const row of rows) {
    const slots = parseJson<CellSlot[]>(row.slots, ['once']);
    if (row.cadence === 'weekly') {
      const weeks = Math.min(slots.length, Math.ceil(lastDay / 7));
      for (let w = 1; w <= weeks; w++) {
        const slot = slots[w - 1];
        if (!slot) continue;
        expected++;
        if (filled.has(`${row.id}:${w}:${slot}`)) recorded++;
        else missing.push({ rowId: row.id, label: row.label, day: w, slot });
      }
      continue;
    }
    for (let d = 1; d <= lastDay; d++) {
      for (const slot of slots) {
        expected++;
        if (filled.has(`${row.id}:${d}:${slot}`)) recorded++;
        else missing.push({ rowId: row.id, label: row.label, day: d, slot });
      }
    }
  }

  const breaches = cells.filter(c => cellIsBreach(c.status));
  const needsReview = cells.filter(c => c.needs_review);
  return {
    expected, recorded,
    percent: expected ? Math.round((recorded / expected) * 100) : 100,
    // The whole list would be 60 entries on a neglected chart; the count is
    // what matters and the first dozen are enough to see the shape of it.
    missing: missing.slice(0, 40),
    missingCount: missing.length,
    breaches: breaches.length,
    unexplainedBreaches: breaches.filter(c => !c.note).length,
    needsReview: needsReview.length,
    monthEnded: !isCurrentMonth,
  };
}

/**
 * When each slot may be recorded, in minutes past midnight, for the client.
 *
 * The same numbers `cellWindow` enforces. Two screens disagreeing about when
 * the afternoon starts is worse than either rule alone.
 */
export function readingWindow(db: DB): { pmOpensAt: number; pmDueAt: number; amDueAt: number } {
  const settings = envSettings(db);
  const clock = (value: unknown, fallback: number): number => {
    const match = /^(\d{1,2}):(\d{2})/.exec(String(value ?? ''));
    return match ? Number(match[1]) * 60 + Number(match[2]) : fallback;
  };
  const pmDueAt = clock(settings.reading_time_pm, 16 * 60);
  const grace = Number(settings.reading_grace_minutes ?? 60);
  return {
    amDueAt: clock(settings.reading_time_am, 8 * 60),
    pmDueAt,
    pmOpensAt: Math.max(0, pmDueAt - (Number.isFinite(grace) ? grace : 60)),
  };
}

/* ============================================================================
   Trends: what a chart shows that no single reading does
   ----------------------------------------------------------------------------
   Every reading on this month's fridge chart is in range and the fridge is
   failing. That is not a hypothetical — a compressor losing efficiency, a door
   seal perishing, an incubator drifting after a service all present the same
   way: nothing breaches, and the numbers walk. By the time one is out of range
   the reagents have been warm for a fortnight.

   The rules here are the Nelson/Western Electric run rules, which are the
   standard answer to exactly this and are the same family of rules the IQC side
   of this system already applies to a Levey-Jennings chart. Using the same ideas
   in both places is deliberate: a laboratory that knows what "ten on one side of
   the mean" means on a control chart does not have to learn a second vocabulary
   for a fridge.

   Four are worth a fridge, and no more — a rule that fires on ordinary noise
   trains people to ignore the ones that matter:

     TREND      six or more consecutive readings all rising, or all falling.
                A drift with a direction: something is changing, not wobbling.

     SHIFT      eight or more consecutive readings on the same side of the
                middle of the acceptable range. The unit has moved and stayed
                moved.

     CREEPING   the last third of the month averages more than a third of the
     TOWARDS    range closer to a limit than the first third did. Slower than a
     A LIMIT    run rule catches, and the shape a dying seal actually makes.

     WIDENING   the spread in the last third is more than double the first
     SPREAD     third's. Control being lost before the mean has moved at all.

   Deterministic, explainable, and computed from the month already on the sheet.
   Nothing here needs a model to run, which matters for a laboratory whose
   server is a desktop PC — and it gives an assistant something factual to
   explain rather than something to guess at.
   ========================================================================= */

export type SheetTrend = {
  rowId: number;
  rowLabel: string;
  unit: string | null;
  slot: string | null;
  kind: 'rising' | 'falling' | 'shift' | 'approaching_limit' | 'widening';
  severity: 'watch' | 'act';
  /** What was seen, in the words a bench would use. */
  summary: string;
  /** What it usually means, so the finding is actionable rather than decorative. */
  meaning: string;
  from: { day: number; value: number };
  to: { day: number; value: number };
  points: number;
};

const MIN_TREND_RUN = 6;
const MIN_SHIFT_RUN = 8;
/** Below this there is not enough month to say anything about its shape. */
const MIN_FOR_DRIFT = 12;

const round = (v: number, dp = 2) => Number(v.toFixed(dp));
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = (xs: number[]) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((acc, v) => acc + (v - m) ** 2, 0) / (xs.length - 1));
};

/**
 * The trends visible on one sheet.
 *
 * Read per row and per slot, because the morning and afternoon series are
 * different observations of the unit and mixing them turns an ordinary daily
 * cycle into a sawtooth that fires every rule there is.
 */
export function sheetTrends(db: DB, sheet: any, rows: any[], cells: any[]): SheetTrend[] {
  const out: SheetTrend[] = [];
  const numeric = rows.filter(r => r.row_type === 'numeric' && r.cadence !== 'weekly');
  if (!numeric.length) return out;

  for (const row of numeric) {
    const slots = parseJson<CellSlot[]>(row.slots, ['once']);
    for (const slot of slots) {
      const series = cells
        .filter(c => Number(c.row_id) === Number(row.id) && String(c.slot) === String(slot)
          && c.value_num !== null && c.value_num !== undefined && c.status !== 'na')
        .map(c => ({ day: Number(c.day), value: Number(c.value_num) }))
        .filter(p => Number.isFinite(p.value))
        .sort((a, b) => a.day - b.day);
      if (series.length < MIN_TREND_RUN) continue;

      const label = `${row.label}${slots.length > 1 ? ` (${String(slot).toUpperCase()})` : ''}`;
      const unit = row.unit ?? null;
      const say = (v: number) => `${round(v, 2)}${unit ? ` ${unit}` : ''}`;

      /* ---- monotonic runs: something is moving, and in a direction -------- */
      let runStart = 0;
      let direction = 0;
      for (let i = 1; i <= series.length; i++) {
        const step = i < series.length ? Math.sign(series[i].value - series[i - 1].value) : 0;
        if (step !== 0 && step === direction) continue;
        // The run that just ended: series[runStart..i-1].
        const length = i - runStart;
        if (direction !== 0 && length >= MIN_TREND_RUN) {
          const from = series[runStart];
          const to = series[i - 1];
          out.push({
            rowId: row.id, rowLabel: label, unit, slot: String(slot),
            kind: direction > 0 ? 'rising' : 'falling',
            severity: length >= MIN_TREND_RUN + 3 ? 'act' : 'watch',
            summary: `${length} readings in a row ${direction > 0 ? 'rising' : 'falling'} — day ${from.day} at ${say(from.value)} to day ${to.day} at ${say(to.value)}.`,
            meaning: direction > 0
              ? 'A steady climb usually means the unit is losing the ability to hold its setting — a failing compressor, a perished door seal, a room that has warmed around it, or a probe drifting. It is worth acting on before anything breaches, because by the time a reading is out of range the contents have been out of range for days.'
              : 'A steady fall usually means an over-correction after a service or an adjustment, a thermostat drifting, or a probe reading low. Below-range is as much of a problem as above-range for anything that must not freeze.',
            from, to, points: length,
          });
        }
        // A step of 0 (two equal readings) breaks the run, which is right: a
        // flat pair is not a drift.
        direction = step;
        runStart = step === 0 ? i : i - 1;
      }

      /* ---- shift: moved, and stayed moved -------------------------------- */
      const midpoint = row.min_value != null && row.max_value != null
        ? (Number(row.min_value) + Number(row.max_value)) / 2
        : mean(series.map(p => p.value));
      let side = 0;
      let sideStart = 0;
      for (let i = 0; i <= series.length; i++) {
        const s = i < series.length ? Math.sign(series[i].value - midpoint) : 0;
        if (s !== 0 && s === side) continue;
        const length = i - sideStart;
        if (side !== 0 && length >= MIN_SHIFT_RUN) {
          out.push({
            rowId: row.id, rowLabel: label, unit, slot: String(slot),
            kind: 'shift', severity: length >= MIN_SHIFT_RUN + 4 ? 'act' : 'watch',
            summary: `${length} readings in a row ${side > 0 ? 'above' : 'below'} the middle of the range (${say(midpoint)}), days ${series[sideStart].day} to ${series[i - 1].day}.`,
            meaning: 'Being consistently to one side is not a fault in itself, but it means the unit is running with less margin on that side than the range was set to give it. A setting adjusted back towards the middle restores the margin; leaving it means the next ordinary excursion breaches.',
            from: series[sideStart], to: series[i - 1], points: length,
          });
        }
        side = s;
        sideStart = s === 0 ? i : i;
      }

      /* ---- the slow shapes a run rule does not catch ---------------------- */
      if (series.length >= MIN_FOR_DRIFT && row.min_value != null && row.max_value != null) {
        const span = Number(row.max_value) - Number(row.min_value);
        const third = Math.floor(series.length / 3);
        const first = series.slice(0, third).map(p => p.value);
        const last = series.slice(-third).map(p => p.value);
        if (third >= 3 && span > 0) {
          const headroom = (v: number) => Math.min(v - Number(row.min_value), Number(row.max_value) - v);
          const startRoom = headroom(mean(first));
          const endRoom = headroom(mean(last));
          if (startRoom - endRoom > span / 6) {
            const nearer = mean(last) > midpoint ? 'upper' : 'lower';
            out.push({
              rowId: row.id, rowLabel: label, unit, slot: String(slot),
              kind: 'approaching_limit', severity: endRoom < span / 6 ? 'act' : 'watch',
              summary: `The month is drifting towards its ${nearer} limit: the first days averaged ${say(mean(first))}, the last ${say(mean(last))} — ${say(startRoom - endRoom)} less margin than it started with.`,
              meaning: 'Slower than a run of six and just as real. This is the shape a perishing seal, a slowly blocking condenser or an ageing probe makes. It is the finding to raise before the month ends, not after.',
              from: series[0], to: series[series.length - 1], points: series.length,
            });
          }

          const startSpread = sd(first);
          const endSpread = sd(last);
          if (startSpread > 0 && endSpread > startSpread * 2 && endSpread > span / 12) {
            out.push({
              rowId: row.id, rowLabel: label, unit, slot: String(slot),
              kind: 'widening', severity: 'watch',
              summary: `The readings are becoming more scattered: spread of ${say(startSpread)} early in the month against ${say(endSpread)} late.`,
              meaning: 'Control being lost before the average has moved at all. Usually a unit cycling harder to hold the same setting, a door being opened more, or a probe becoming intermittent. Worth looking at the unit itself rather than the numbers.',
              from: series[0], to: series[series.length - 1], points: series.length,
            });
          }
        }
      }
    }
  }

  // The ones that need acting on first, then the longest runs — a screen that
  // lists twelve findings in arbitrary order gets read as noise.
  return out
    .sort((a, b) => (a.severity === b.severity ? b.points - a.points : a.severity === 'act' ? -1 : 1))
    .slice(0, 12);
}

/* ============================================================================
   When a cell may be written
   ----------------------------------------------------------------------------
   A chart is a record of readings taken. Three rules follow from that and
   nothing else, and all three were missing:

   THE FUTURE CANNOT BE RECORDED. A reading for the 22nd, typed on the 19th, is
   not an early entry — it is a fabricated observation, and a chart with three
   days of them in it is worse than a chart with three gaps, because the gaps
   are honest. This is the one rule with no exception and no override.

   THE AFTERNOON CANNOT BE RECORDED IN THE MORNING. The whole point of charting
   a fridge twice is that the two readings are hours apart; taking them
   together at 08:05 and writing one in the PM column measures nothing and
   hides a whole afternoon. So a PM cell opens when the afternoon reading is
   due, less the laboratory's own grace period — the same reading_time_pm and
   reading_grace_minutes that already govern the reminder, because a system
   that reminds you at one time and accepts at another is telling you two
   different things.

   TODAY IS CORRECTABLE; YESTERDAY IS AMENDABLE. Correcting or withdrawing an
   entry on the day it belongs to is ordinary work — a wrong box, a transposed
   digit, a re-read after the door was found ajar. Once the day has ended the
   record has been relied on, so changing it takes somebody senior, a reason,
   and an amendment trail that keeps the original legible (ISO 15189:2022 §8.4).
   ========================================================================= */

/** Local calendar date, which is the date the bench is standing in. */
function todayLocal(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function nowMinutes(): number {
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes();
}

function parseClock(value: unknown, fallback: number): number {
  const match = /^(\d{1,2}):(\d{2})/.exec(String(value ?? ''));
  if (!match) return fallback;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** The calendar date a daily cell asserts something about. */
export function dateOfCell(month: string, day: number): string {
  return `${month}-${String(day).padStart(2, '0')}`;
}

export type CellWindow =
  | { open: true; sameDay: boolean }
  | { open: false; sameDay: boolean; reason: string };

/**
 * Whether this cell may be written right now, and if not, why not in words the
 * person at the fridge can act on.
 *
 * A weekly cell is a week, not a day, so it opens once its week has started —
 * a monthly service ticked on the Monday of week 3 is a normal thing to do.
 */
export function cellWindow(db: DB, sheet: any, row: any, day: number, slot: string): CellWindow {
  const today = todayLocal();
  const cadence = row?.cadence === 'weekly' ? 'weekly' : 'daily';

  if (cadence === 'weekly') {
    const firstDayOfWeek = (day - 1) * 7 + 1;
    const weekStart = dateOfCell(sheet.month, Math.min(firstDayOfWeek, daysInMonth(sheet.month)));
    if (weekStart > today) {
      return { open: false, sameDay: false, reason: `Week ${day} of ${monthLabel(sheet.month)} has not started yet.` };
    }
    return { open: true, sameDay: dateOfCell(sheet.month, day) === today };
  }

  const date = dateOfCell(sheet.month, day);
  if (date > today) {
    return {
      open: false, sameDay: false,
      reason: `${date} has not happened yet. A chart records readings that were taken; an entry against a future day is not an early entry, it is a reading nobody took.`,
    };
  }
  if (date < today) return { open: true, sameDay: false };

  // Today. An afternoon slot waits for the afternoon.
  if (slot === 'pm') {
    const settings = envSettings(db);
    const due = parseClock(settings.reading_time_pm, 16 * 60);
    const grace = Number(settings.reading_grace_minutes ?? 60);
    const opensAt = Math.max(0, due - (Number.isFinite(grace) ? grace : 60));
    if (nowMinutes() < opensAt) {
      const clock = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
      return {
        open: false, sameDay: true,
        reason: `The afternoon reading is due at ${clock(due)} and this column opens from ${clock(opensAt)}. Two readings taken together in the morning measure one moment twice; the PM column exists because the afternoon is a different one.`,
      };
    }
  }
  return { open: true, sameDay: true };
}

/* ============================================================================
   Writing to a sheet
   ========================================================================= */

export interface CellInput {
  rowId?: number;
  rowKey?: string;
  day: number;
  slot: string;
  value?: number | string | null;
  text?: string | null;
  done?: boolean | null;
  na?: boolean | null;
  note?: string | null;
  initials?: string | null;
  readingTime?: string | null;
  source?: string | null;
  confidence?: number | null;
  needsReview?: boolean;
  /** Withdraw the entry altogether rather than change it. */
  clear?: boolean;
  /** Why a closed day's entry is being changed. Required once the day has ended. */
  amendReason?: string | null;
}

export interface SaveCellsContext {
  staffId: number | null;
  userId: number | null;
  initials?: string | null;
  /** Skip the environmental ingest — used when replaying an extraction. */
  skipIngest?: boolean;
  /**
   * Whether the caller may change an entry belonging to a day that has ended.
   * Held by a supervisor, and never assumed: without it a closed day's cell is
   * refused with the reason, rather than quietly written.
   */
  mayAmendClosedDays?: boolean;
  /**
   * Lift the calendar rules for a bulk load — an imported month, an extracted
   * paper chart, a data logger backfill. These carry their own provenance and
   * are asserting what was recorded at the time, not typing a future reading.
   * Never set from an interactive cell edit.
   */
  backfill?: boolean;
}

export interface SaveCellsResult {
  saved: number;
  breaches: Array<{ day: number; slot: string; label: string; value: string; status: string }>;
  excursions: number[];
  /** Entries withdrawn rather than written. */
  cleared: number;
  /** Entries changed after their day had ended, each with its reason recorded. */
  amended: number;
  /**
   * Cells the calendar or the amendment rules would not accept, with the reason
   * for each. Refusing silently would leave somebody believing they had charted
   * a reading they had not.
   */
  refused: Array<{ day: number; slot: string; label: string; reason: string }>;
}

/**
 * Record one or many cells.
 *
 * For an environmental sheet each numeric cell also goes through the existing
 * monitoring engine, so an out-of-range value opens an excursion, raises the
 * alert and — if it is sustained — creates the NC, exactly as a reading entered
 * on the Environmental Monitoring screen would. There is one ingest path for
 * environmental readings in this system and the chart uses it rather than
 * inventing a quieter one.
 */
export function saveCells(db: DB, sheetId: number, inputs: CellInput[], context: SaveCellsContext): SaveCellsResult {
  const sheet = db.prepare('SELECT * FROM routine_log_sheets WHERE id = ?').get(sheetId) as any;
  if (!sheet) throw new Error('Log sheet not found');
  if (sheetIsLocked(sheet.status)) {
    throw new Error('This sheet has been verified and signed. Correcting it requires a nonconformity to be raised against the month.');
  }

  const rows = db.prepare('SELECT * FROM routine_log_rows WHERE sheet_id = ?').all(sheetId) as any[];
  const byId = new Map(rows.map(r => [Number(r.id), r]));
  const byKey = new Map(rows.map(r => [String(r.row_key), r]));
  const days = daysInMonth(sheet.month);

  const result: SaveCellsResult = { saved: 0, breaches: [], excursions: [], cleared: 0, amended: 0, refused: [] };

  const existing = db.prepare('SELECT * FROM routine_log_cells WHERE sheet_id = ? AND row_id = ? AND day = ? AND slot = ?');
  const remove = db.prepare('DELETE FROM routine_log_cells WHERE sheet_id = ? AND row_id = ? AND day = ? AND slot = ?');
  const recordAmendment = db.prepare(`INSERT INTO routine_log_cell_amendments
      (sheet_id, row_id, day, slot, action, old_value_num, old_value_text, old_status, old_note,
       old_recorded_by_staff_id, old_recorded_at, new_value_num, new_value_text, new_status,
       reason, amended_by_staff_id, amended_by_user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const markAmended = db.prepare(`UPDATE routine_log_cells
      SET amendment_count = COALESCE(amendment_count, 0) + 1, last_amended_at = CURRENT_TIMESTAMP,
          last_amend_reason = ?
      WHERE sheet_id = ? AND row_id = ? AND day = ? AND slot = ?`);

  const upsert = db.prepare(`INSERT INTO routine_log_cells
      (sheet_id, row_id, day, slot, value_num, value_text, status, initials, note, source, confidence,
       needs_review, recorded_by_staff_id, recorded_at, reading_time, excursion_id, environmental_reading_id, created_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(sheet_id, row_id, day, slot) DO UPDATE SET
        value_num = excluded.value_num, value_text = excluded.value_text, status = excluded.status,
        initials = excluded.initials, note = excluded.note, source = excluded.source,
        confidence = excluded.confidence, needs_review = excluded.needs_review,
        recorded_by_staff_id = excluded.recorded_by_staff_id, recorded_at = CURRENT_TIMESTAMP,
        reading_time = excluded.reading_time,
        excursion_id = COALESCE(excluded.excursion_id, routine_log_cells.excursion_id),
        environmental_reading_id = COALESCE(excluded.environmental_reading_id, routine_log_cells.environmental_reading_id),
        updated_at = CURRENT_TIMESTAMP`);

  const write = db.transaction(() => {
    for (const input of inputs) {
      const row = input.rowId != null ? byId.get(Number(input.rowId))
        : input.rowKey ? byKey.get(String(input.rowKey)) : undefined;
      if (!row) continue;

      const cadence = row.cadence === 'weekly' ? 'weekly' : 'daily';
      const day = Number(input.day);
      if (!Number.isFinite(day) || day < 1 || (cadence === 'daily' ? day > days : day > 5)) continue;
      const slotKey = input.slot || 'once';

      const refuse = (reason: string) => {
        result.refused.push({ day, slot: slotKey, label: row.label, reason });
      };

      // ---- May this cell be written at all, right now? --------------------
      // A backfill (an imported month, an extracted paper chart, a logger
      // download) is asserting what was recorded at the time and carries its
      // own provenance, so the calendar rules do not apply to it. An
      // interactive edit never sets that flag.
      const window: CellWindow = context.backfill
        ? { open: true, sameDay: false }
        : cellWindow(db, sheet, row, day, slotKey);
      if (window.open === false) { refuse(window.reason); continue; }

      const prior = existing.get(sheetId, row.id, day, slotKey) as any;
      // A day that has ended, on a cell that already says something. Filling a
      // blank for last Tuesday is not this — that is recording an observation
      // that was made and not yet typed, which is ordinary and necessary.
      const dayClosed = Boolean(prior) && !window.sameDay && !context.backfill;

      /**
       * Whether writing this would change what the record SAYS.
       *
       * A note is not an amendment. Writing down what was done about Tuesday's
       * excursion on Thursday is exactly what the chart wants and exactly what
       * an assessor looks for; demanding a supervisor's authorisation for it
       * would stop the one habit worth encouraging. The same goes for an
       * initial or a reading time. Only the value, or the assertion the cell
       * makes, is the record being altered.
       */
      const amendmentGate = (nextStatus: string, nextNum: number | null, nextText: string | null): boolean | 'refused' => {
        if (!dayClosed) return false;
        const sameValue = Number(prior.value_num ?? NaN) === Number(nextNum ?? NaN)
          || (prior.value_num == null && nextNum == null);
        const sameText = (prior.value_text ?? null) === (nextText ?? null);
        const sameStatus = String(prior.status) === nextStatus;
        if (sameValue && sameText && sameStatus) return false;

        const reason = String(input.amendReason ?? '').trim();
        if (!context.mayAmendClosedDays) {
          refuse(`${row.label} on day ${day} was recorded on a day that has ended. Changing what it says now needs a supervisor — the record has already been read, and a quiet edit to it is the one thing a quality system cannot allow (ISO 15189:2022 §8.4). A note about it can still be added by anyone.`);
          return 'refused';
        }
        if (reason.length < 10) {
          refuse(`Changing ${row.label} on day ${day} after its day has ended needs a reason recorded with it — a sentence saying what was wrong and how the correct value was established.`);
          return 'refused';
        }
        return true;
      };

      // ---- Withdrawing an entry -------------------------------------------
      // A deletion is the largest change there is, so it is always gated once
      // the day has ended, whatever it used to say.
      if (input.clear) {
        if (!prior) continue;
        if (dayClosed) {
          const reason = String(input.amendReason ?? '').trim();
          if (!context.mayAmendClosedDays) {
            refuse(`${row.label} on day ${day} belongs to a day that has ended. Withdrawing it needs a supervisor.`);
            continue;
          }
          if (reason.length < 10) {
            refuse(`Withdrawing ${row.label} on day ${day} after its day has ended needs a reason recorded with it.`);
            continue;
          }
          recordAmendment.run(sheetId, row.id, day, slotKey, 'delete',
            prior.value_num, prior.value_text, prior.status, prior.note,
            prior.recorded_by_staff_id, prior.recorded_at, null, null, null,
            reason, context.staffId, context.userId);
        }
        remove.run(sheetId, row.id, day, slotKey);
        result.cleared++;
        continue;
      }

      let status: string;
      let valueNum: number | null = null;
      let valueText: string | null = null;
      let excursionId: number | null = null;
      let readingId: number | null = null;

      if (input.na) {
        status = 'na';
        valueText = input.note ?? null;
      } else if (row.row_type === 'numeric') {
        const numeric = input.value === '' || input.value === null || input.value === undefined
          ? null : Number(input.value);
        if (numeric === null || Number.isNaN(numeric)) continue;
        valueNum = numeric;
        status = classifyNumeric(numeric, row.min_value, row.max_value);

        if (sheet.sheet_kind === 'environmental' && !context.skipIngest) {
          // A cell IS one reading. Coming back to the same cell to write down
          // what was done about an excursion must not post the temperature a
          // second time — that would double-count the month and reopen an
          // excursion that has just been closed. Only a changed VALUE is a new
          // observation; a note, an initial or a time is an amendment to the
          // one already there.
          const unchanged = prior && prior.value_num !== null && Number(prior.value_num) === numeric;
          if (unchanged) {
            readingId = prior.environmental_reading_id ?? null;
            if (readingId && input.note) {
              db.prepare('UPDATE environmental_readings SET observation = ? WHERE id = ?').run(input.note, readingId);
            }
          } else {
            const ingest = ingestEnvironmentalCell(db, sheet, row, day, input, numeric, context);
            excursionId = ingest.excursionId;
            readingId = ingest.readingId;
          }
        }
      } else if (row.row_type === 'text') {
        valueText = input.text ?? String(input.value ?? '');
        if (!valueText.trim()) continue;
        status = 'normal';
      } else {
        // A tick. `done: false` is a deliberate assertion that it was NOT done,
        // which is a different and much more useful record than a blank cell.
        status = input.done === false ? 'not_done' : 'done';
      }

      // Now that the new value is known, decide whether this is an amendment at
      // all. It is only one if what the record SAYS changes; a note, an initial
      // or a reading time added to a past day is an annotation, and blocking
      // those would stop the habit the chart most depends on.
      const gate = amendmentGate(status, valueNum, valueText);
      if (gate === 'refused') continue;
      const isAmendment = gate === true;

      upsert.run(sheetId, row.id, day, slotKey, valueNum, valueText, status,
        input.initials ?? context.initials ?? null, input.note ?? null,
        input.source ?? 'manual', input.confidence ?? null, input.needsReview ? 1 : 0,
        context.staffId, input.readingTime ?? null, excursionId, readingId, context.userId);

      // The original stays legible. What it said, what it says now, who
      // authorised the change and why — kept beside the cell rather than only
      // in the audit log, because the person reviewing the month is looking at
      // the sheet, not at the audit trail.
      if (isAmendment) {
        recordAmendment.run(sheetId, row.id, day, slotKey, 'amend',
          prior.value_num, prior.value_text, prior.status, prior.note,
          prior.recorded_by_staff_id, prior.recorded_at,
          valueNum, valueText, status,
          String(input.amendReason ?? '').trim(), context.staffId, context.userId);
        markAmended.run(String(input.amendReason ?? '').trim(), sheetId, row.id, day, slotKey);
        result.amended++;
      }

      result.saved++;
      if (excursionId) result.excursions.push(excursionId);
      if (cellIsBreach(status)) {
        result.breaches.push({
          day, slot: slotKey, label: row.label,
          value: valueNum != null ? `${valueNum}${row.unit ? ` ${row.unit}` : ''}` : (valueText ?? 'not done'),
          status,
        });
      }
    }
    db.prepare('UPDATE routine_log_sheets SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(sheetId);
  });
  write();
  return result;
}

function classifyNumeric(value: number, min: number | null, max: number | null): string {
  if (min == null && max == null) return 'normal';
  if ((min != null && value < min) || (max != null && value > max)) return 'out_of_range';
  const span = (max ?? 0) - (min ?? 0);
  const margin = Math.max(0.1, Math.abs(span) * 0.08);
  if ((min != null && value < min + margin) || (max != null && value > max - margin)) return 'warning';
  return 'normal';
}

/**
 * Push an environmental chart cell through the monitoring engine, so a value
 * typed on the chart behaves exactly as one typed on the monitoring screen.
 */
function ingestEnvironmentalCell(db: DB, sheet: any, row: any, day: number, input: CellInput, value: number, context: SaveCellsContext):
  { excursionId: number | null; readingId: number | null } {
  const parameter = row.source_ref || row.row_key;
  const time = input.readingTime || defaultSlotTime(db, input.slot);
  const recordedAt = `${sheet.month}-${String(day).padStart(2, '0')}T${time}:00`;
  try {
    const outcome = recordReading(db, {
      assetId: sheet.subject_id,
      source: input.source === 'device' ? 'device' : 'manual',
      temperature: parameter === 'temperature' ? value : null,
      humidity: parameter === 'humidity' ? value : null,
      recordedAt,
      recordedByStaffId: context.staffId ?? null,
      observation: input.note ?? null,
      userId: context.userId ?? null,
    });
    // Parameters beyond temperature and humidity hang off the reading rather
    // than pretending to be one of the two the original schema knew about.
    if (parameter !== 'temperature' && parameter !== 'humidity') {
      db.prepare(`INSERT INTO environmental_reading_values (reading_id, parameter, value, unit, status)
          VALUES (?, ?, ?, ?, ?) ON CONFLICT(reading_id, parameter) DO UPDATE SET value = excluded.value, status = excluded.status`)
        .run(outcome.readingId, parameter, value, row.unit ?? null, classifyNumeric(value, row.min_value, row.max_value));
    }
    return { excursionId: outcome.excursionId ?? null, readingId: outcome.readingId ?? null };
  } catch {
    // A chart entry must not be lost because the alerting side of the engine
    // failed. The cell is still the record; the excursion is a consequence of it.
    return { excursionId: null, readingId: null };
  }
}

function defaultSlotTime(db: DB, slot: string | undefined): string {
  const settings = envSettings(db);
  if (slot === 'pm') return settings.reading_time_pm || '16:00';
  if (slot === 'am') return settings.reading_time_am || '08:00';
  return settings.reading_time_am || '08:00';
}

/* ============================================================================
   Closing the month
   ========================================================================= */

export function submitSheet(db: DB, sheetId: number, staffId: number | null): void {
  const sheet = db.prepare('SELECT * FROM routine_log_sheets WHERE id = ?').get(sheetId) as any;
  if (!sheet) throw new Error('Log sheet not found');
  if (sheetIsLocked(sheet.status)) throw new Error('This sheet has already been verified.');
  db.prepare(`UPDATE routine_log_sheets SET status = 'submitted', submitted_by_staff_id = ?,
      submitted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(staffId, sheetId);
}

export function reopenSheet(db: DB, sheetId: number): void {
  const sheet = db.prepare('SELECT * FROM routine_log_sheets WHERE id = ?').get(sheetId) as any;
  if (!sheet) throw new Error('Log sheet not found');
  if (sheetIsLocked(sheet.status)) throw new Error('A verified sheet cannot be reopened. Raise a nonconformity against the month instead.');
  db.prepare(`UPDATE routine_log_sheets SET status = 'open', submitted_by_staff_id = NULL,
      submitted_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(sheetId);
}

/**
 * Raise an NC against the month.
 *
 * A chart with gaps, a decontamination log that stopped on the 9th, a month of
 * readings nobody signed — these are failures of the programme, and the
 * supervisor reviewing the month is exactly the person placed to say so. The NC
 * carries the sheet's own numbers so the investigation does not start by
 * counting columns again.
 */
export function raiseSheetNc(db: DB, sheetId: number, options: { title?: string; description?: string; severity?: string; staffId: number | null; userId: number | null }): number {
  const sheet = db.prepare('SELECT * FROM routine_log_sheets WHERE id = ?').get(sheetId) as any;
  if (!sheet) throw new Error('Log sheet not found');
  if (sheet.nc_id) return Number(sheet.nc_id);

  const rows = (db.prepare('SELECT * FROM routine_log_rows WHERE sheet_id = ?').all(sheetId) as any[]);
  const cells = db.prepare('SELECT * FROM routine_log_cells WHERE sheet_id = ?').all(sheetId) as any[];
  const stats = completeness(db, sheet, rows, cells);

  const createdAt = new Date().toISOString();
  const ncNumber = generateRecordNumber(db, 'nonconforming_events', 'NC', createdAt);
  const description = options.description
    || `${sheet.title} for ${monthLabel(sheet.month)}: ${stats.recorded} of ${stats.expected} entries recorded `
     + `(${stats.percent}%), ${stats.missingCount} missing, ${stats.breaches} out of range or not done.`;

  const ncId = Number(db.prepare(`INSERT INTO nonconforming_events
      (nc_number, event_date, detected_by_staff_id, section_id, source_module, source_record_id, title,
       description, category, severity, status, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`)
    .run(ncNumber, createdAt.slice(0, 10), options.staffId, sheet.section_id, 'routine_work', String(sheetId),
      options.title || `${sheet.title} — ${monthLabel(sheet.month)}`,
      description, sheet.sheet_kind, options.severity || 'medium', options.userId, createdAt).lastInsertRowid);

  db.prepare('UPDATE routine_log_sheets SET nc_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(ncId, sheetId);
  db.prepare(`INSERT INTO record_links (source_module_key, source_record_type, source_record_id,
      target_module_key, target_record_type, target_record_id, notes)
      VALUES ('routine_work', 'routine_log_sheets', ?, 'nc_capa', 'nonconforming_events', ?, ?)`)
    .run(String(sheetId), String(ncId), 'Raised on review of the monthly log sheet');
  return ncId;
}

/**
 * Verify and sign the month. Once this happens the sheet is closed: it prints,
 * it archives, and it does not change.
 */
export function verifySheet(db: DB, sheetId: number, options: { staffId: number | null; signatureId: number; comments?: string | null }): void {
  const sheet = db.prepare('SELECT * FROM routine_log_sheets WHERE id = ?').get(sheetId) as any;
  if (!sheet) throw new Error('Log sheet not found');
  if (sheetIsLocked(sheet.status)) throw new Error('This sheet has already been verified.');
  db.prepare(`UPDATE routine_log_sheets SET status = 'verified', verified_by_staff_id = ?, verified_at = CURRENT_TIMESTAMP,
      verification_signature_id = ?, verification_comments = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(options.staffId, options.signatureId, options.comments ?? null, sheetId);
}

/** File the verified sheet in the central archive. */
export function archiveSheet(db: DB, sheetId: number, options: { staffId: number | null; userId: number | null; retentionMonths?: number | null; notes?: string | null }): number {
  const sheet = db.prepare('SELECT * FROM routine_log_sheets WHERE id = ?').get(sheetId) as any;
  if (!sheet) throw new Error('Log sheet not found');
  if (sheet.status !== 'verified') throw new Error('Only a verified sheet can be archived.');
  if (sheet.archive_id) return Number(sheet.archive_id);

  const createdAt = new Date().toISOString();
  const archiveNumber = generateRecordNumber(db, 'central_archives', 'ARC', createdAt);
  const [year, month] = sheet.month.split('-').map(Number);
  const periodEnd = `${sheet.month}-${String(new Date(year, month, 0).getDate()).padStart(2, '0')}`;

  const archiveId = Number(db.prepare(`INSERT INTO central_archives
      (archive_number, title, description, archive_type, source_module, source_record_type, source_record_id,
       period_start, period_end, retention_period_months, file_id, format, archived_by_staff_id,
       status, is_automatic, notes, created_by, created_at)
      VALUES (?, ?, ?, 'record', 'routine_work', 'routine_log_sheets', ?, ?, ?, ?, ?, 'pdf', ?, 'archived', 0, ?, ?, ?)`)
    .run(archiveNumber, `${sheet.title} — ${monthLabel(sheet.month)}`,
      sheet.verification_comments ?? null, String(sheetId), `${sheet.month}-01`, periodEnd,
      options.retentionMonths ?? null, sheet.attachment_file_id ?? null, options.staffId,
      options.notes ?? null, options.userId, createdAt).lastInsertRowid);

  db.prepare(`UPDATE routine_log_sheets SET status = 'archived', archive_id = ?, archived_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(archiveId, sheetId);
  return archiveId;
}

/* ============================================================================
   Listing sheets for a unit
   ========================================================================= */

/**
 * Every subject of this kind that the unit is responsible for, with its sheet
 * for the month — creating the sheet lazily so a unit that has never opened one
 * still sees its whole programme rather than an empty screen.
 */
export function sheetsForSection(db: DB, kind: SheetKind, sectionId: number | null, month: string, options?: { create?: boolean; userId?: number | null }): any[] {
  const subjects = subjectsForSection(db, kind, sectionId);
  const out: any[] = [];
  for (const subject of subjects) {
    let sheet = openSheet(db, {
      kind, subjectId: subject.id, month, sectionId: subject.section_id ?? sectionId,
      userId: options?.userId ?? null, readOnly: options?.create === false,
    });
    if (sheet) refreshSheetRows(db, sheet);
    if (sheet) sheet = db.prepare('SELECT * FROM routine_log_sheets WHERE id = ?').get(sheet.id);

    const rows = sheet ? db.prepare('SELECT * FROM routine_log_rows WHERE sheet_id = ?').all(sheet.id) as any[] : [];
    const cells = sheet ? db.prepare('SELECT * FROM routine_log_cells WHERE sheet_id = ?').all(sheet.id) as any[] : [];
    out.push({
      subject,
      sheet: sheet ? { ...sheet, monthLabel: monthLabel(sheet.month), days: daysInMonth(sheet.month), locked: sheetIsLocked(sheet.status) } : null,
      completeness: sheet ? completeness(db, sheet, rows, cells) : null,
    });
  }
  return out;
}

/** The things of this kind a unit charts. */
export function subjectsForSection(db: DB, kind: SheetKind, sectionId: number | null): any[] {
  if (kind === 'environmental') {
    if (!sectionId) return [];
    return db.prepare(`SELECT a.*, a.name AS subject_name, COALESCE(a.responsible_section_id, a.section_id) AS section_id
        FROM environmental_assets a
        WHERE a.is_active = 1 AND COALESCE(a.responsible_section_id, a.section_id) = ?
        ORDER BY a.name`).all(sectionId);
  }
  if (kind === 'decontamination') {
    // A unit carries the laboratory-wide programme plus whatever it added, less
    // anything it has been excused from and said why.
    return db.prepare(`SELECT d.*, d.name AS subject_name, ? AS section_id,
          COALESCE(u.frequency, d.frequency) AS effective_frequency,
          COALESCE(u.decontaminant, d.decontaminant) AS effective_decontaminant
        FROM decontamination_definitions d
        LEFT JOIN decontamination_unit_settings u ON u.definition_id = d.id AND u.section_id = ?
        WHERE d.is_active = 1
          AND (d.section_id IS NULL OR d.section_id = ?)
          AND COALESCE(u.is_excluded, 0) = 0
        ORDER BY CASE d.scope WHEN 'general' THEN 0 ELSE 1 END, d.name`).all(sectionId, sectionId, sectionId);
  }
  if (!sectionId) return [];
  return db.prepare(`SELECT e.*, e.name AS subject_name FROM equipment_items e
      WHERE e.section_id = ? AND e.status != 'decommissioned'
        AND EXISTS (SELECT 1 FROM equipment_maintenance_tasks t WHERE t.equipment_id = e.id AND t.is_active = 1)
      ORDER BY e.name`).all(sectionId);
}
