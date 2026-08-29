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
    },
    rows,
    cells,
    completeness: completeness(db, sheet, rows, cells),
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
}

export interface SaveCellsContext {
  staffId: number | null;
  userId: number | null;
  initials?: string | null;
  /** Skip the environmental ingest — used when replaying an extraction. */
  skipIngest?: boolean;
}

export interface SaveCellsResult {
  saved: number;
  breaches: Array<{ day: number; slot: string; label: string; value: string; status: string }>;
  excursions: number[];
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

  const result: SaveCellsResult = { saved: 0, breaches: [], excursions: [] };

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
          const previous = db.prepare('SELECT value_num, environmental_reading_id FROM routine_log_cells WHERE sheet_id = ? AND row_id = ? AND day = ? AND slot = ?')
            .get(sheetId, row.id, day, input.slot || 'once') as any;
          const unchanged = previous && previous.value_num !== null && Number(previous.value_num) === numeric;
          if (unchanged) {
            readingId = previous.environmental_reading_id ?? null;
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

      upsert.run(sheetId, row.id, day, input.slot || 'once', valueNum, valueText, status,
        input.initials ?? context.initials ?? null, input.note ?? null,
        input.source ?? 'manual', input.confidence ?? null, input.needsReview ? 1 : 0,
        context.staffId, input.readingTime ?? null, excursionId, readingId, context.userId);

      result.saved++;
      if (excursionId) result.excursions.push(excursionId);
      if (cellIsBreach(status)) {
        result.breaches.push({
          day, slot: input.slot || 'once', label: row.label,
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
