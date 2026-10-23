/**
 * Form adapters: what the extension knows about a result-entry form, and how a
 * transmission becomes a list of boxes to fill.
 *
 * The knowledge is configuration, deliberately. A laboratory that buys another
 * analyser, opens another form or moves to another browser-based LIS should be
 * adding a row here, not waiting for a new extension to be built and
 * distributed to every bench.
 *
 * Two ways a parameter finds its box, and a form may use both:
 *
 *   A MAPPED FIELD. The administrator has said where WBC goes on this form.
 *   Exact, and the only way for a form whose boxes are not labelled.
 *
 *   THE ROW IT SITS IN. For a result grid that labels every row with the
 *   parameter — which is how SECHLIMS's own entry tables are built — the box is
 *   found by reading the label. A control that gains a parameter is then filled
 *   without anybody configuring anything.
 *
 * Whatever is left over is REPORTED rather than guessed at. A parameter with no
 * box and a box with no parameter both appear in the plan as something a person
 * is told about; neither is quietly dropped.
 */
import {
  BUILTIN_ADAPTERS, applyFieldTransform, codeKey, type OverwritePolicy, type SelectorKind,
} from '../../../shared/constants/resultFiller.js';
import type { Reading, Transmission } from './pending.js';

type DB = any;

export interface AdapterRow {
  id: number;
  adapter_code: string;
  name: string;
  platform: string;
  description: string | null;
  url_pattern: string;
  url_match_mode: string;
  form_selector: string | null;
  identifiers: string | null;
  normaliser: string;
  overwrite_policy: string;
  lookback_hours: number;
  message_kind: string;
  match_by_label: number;
  row_container: string | null;
  row_label_cell: number;
  row_value_cell: number;
  section_id: number | null;
  is_builtin: number;
  is_active: number;
  notes: string | null;
}

export interface FieldRow {
  id: number;
  adapter_id: number;
  source_code: string;
  analyte: string | null;
  selector_kind: string;
  selector: string;
  unit: string | null;
  decimals: number | null;
  factor: number | null;
  offset_value: number | null;
  value_map: string | null;
  is_required: number;
  is_active: number;
  sort_order: number;
  note: string | null;
}

function json<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try { return (JSON.parse(value) ?? fallback) as T; } catch { return fallback; }
}

/**
 * Put the adapters that ship with the extension on the record.
 *
 * Inserted once, by code, and never updated afterwards: a laboratory that has
 * adjusted a built-in adapter must not have its change reverted by a restart.
 */
export function seedAdapters(db: DB, userId?: number | null): void {
  const exists = db.prepare('SELECT 1 FROM rf_adapters WHERE adapter_code = ?');
  const insertAdapter = db.prepare(`INSERT INTO rf_adapters
      (adapter_code, name, platform, description, url_pattern, url_match_mode, form_selector, identifiers,
       normaliser, overwrite_policy, lookback_hours, message_kind, match_by_label, row_container,
       row_label_cell, row_value_cell, is_builtin, is_active, notes, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 1, 0, 1, ?, ?, ?)`);
  const insertField = db.prepare(`INSERT OR IGNORE INTO rf_fields
      (adapter_id, source_code, analyte, selector_kind, selector, unit, decimals, is_required, sort_order, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  for (const adapter of BUILTIN_ADAPTERS) {
    if (exists.get(adapter.adapterCode)) continue;
    const result = insertAdapter.run(
      adapter.adapterCode, adapter.name, adapter.platform, adapter.description,
      adapter.urlPattern, adapter.urlMatchMode, adapter.formSelector || null,
      JSON.stringify(adapter.identifiers), adapter.normaliser, adapter.overwritePolicy,
      adapter.lookbackHours, adapter.messageKind, adapter.formSelector || null,
      adapter.isActive ? 1 : 0, adapter.notes ?? null, userId ?? null,
    );
    const adapterId = Number(result.lastInsertRowid);
    adapter.fields.forEach((field, index) => {
      insertField.run(adapterId, field.sourceCode, field.analyte, field.selectorKind, field.selector,
        field.unit ?? null, field.decimals ?? null, field.required ? 1 : 0, index, field.note ?? null);
    });
  }
}

export function adapterFields(db: DB, adapterId: number): FieldRow[] {
  return db.prepare('SELECT * FROM rf_fields WHERE adapter_id = ? ORDER BY sort_order, id').all(adapterId) as FieldRow[];
}

/** The adapter as the extension receives it: no database ids it cannot use. */
export function publicAdapter(row: AdapterRow, fields?: FieldRow[]) {
  return {
    id: row.id,
    adapterCode: row.adapter_code,
    name: row.name,
    platform: row.platform,
    description: row.description,
    urlPattern: row.url_pattern,
    urlMatchMode: row.url_match_mode,
    formSelector: row.form_selector,
    identifiers: json<any[]>(row.identifiers, []),
    normaliser: row.normaliser,
    overwritePolicy: row.overwrite_policy as OverwritePolicy,
    lookbackHours: Number(row.lookback_hours),
    messageKind: row.message_kind,
    matchByLabel: Number(row.match_by_label) === 1,
    rowContainer: row.row_container,
    rowLabelCell: Number(row.row_label_cell ?? 1),
    rowValueCell: Number(row.row_value_cell ?? 0),
    isBuiltin: Number(row.is_builtin) === 1,
    isActive: Number(row.is_active) === 1,
    notes: row.notes,
    fields: (fields ?? []).map(f => ({
      sourceCode: f.source_code,
      analyte: f.analyte,
      selectorKind: f.selector_kind as SelectorKind,
      selector: f.selector,
      unit: f.unit,
      required: Number(f.is_required) === 1,
    })),
  };
}

/* ============================================================================
   The plan
   ========================================================================= */
export interface PlannedField {
  sourceCode: string;
  analyte: string;
  /** What the extension looks for, and how. */
  selectorKind: SelectorKind;
  selector: string;
  /** Other labels worth trying when the first finds nothing. */
  aliases: string[];
  value: string;
  receivedValue: string;
  unit: string | null;
  flag: string | null;
  required: boolean;
  /** What was done to the received value, where anything was. */
  note: string | null;
  mapped: boolean;
}

export interface FillPlan {
  fields: PlannedField[];
  /** Mapped fields this transmission carried nothing for. */
  missing: Array<{ sourceCode: string; analyte: string | null; required: boolean }>;
  /** Parameters the analyser sent that this form has nowhere to put. */
  unmatched: Array<{ code: string; analyte: string; value: string; unit: string | null }>;
  overwritePolicy: OverwritePolicy;
  rowContainer: string | null;
  rowLabelCell: number;
  rowValueCell: number;
}

/** One parameter, found by what the analyser called it or by what we call it. */
function findReading(readings: Reading[], wanted: string): Reading | undefined {
  const key = codeKey(wanted);
  if (!key) return undefined;
  return readings.find(r => codeKey(r.code) === key) ?? readings.find(r => codeKey(r.analyte) === key);
}

/**
 * Turn one transmission into the boxes a form should receive.
 *
 * Mapped fields first, in the order the administrator put them in; then — if
 * the adapter fills by row label — everything else the analyser sent, so a
 * parameter added at the analyser appears without anybody editing a mapping.
 */
export function buildPlan(adapter: AdapterRow, fields: FieldRow[], transmission: Transmission): FillPlan {
  const planned: PlannedField[] = [];
  const missing: FillPlan['missing'] = [];
  const used = new Set<string>();

  for (const field of fields) {
    if (!Number(field.is_active)) continue;
    const reading = findReading(transmission.readings, field.source_code)
      ?? (field.analyte ? findReading(transmission.readings, field.analyte) : undefined);
    if (!reading) {
      missing.push({ sourceCode: field.source_code, analyte: field.analyte, required: Number(field.is_required) === 1 });
      continue;
    }
    used.add(codeKey(reading.code));
    const transformed = applyFieldTransform(reading.value, {
      factor: field.factor, offsetValue: field.offset_value, decimals: field.decimals,
      valueMap: json<Record<string, string> | null>(field.value_map, null),
    });
    planned.push({
      sourceCode: reading.code,
      analyte: field.analyte || reading.analyte,
      selectorKind: (field.selector_kind || 'row') as SelectorKind,
      selector: field.selector,
      aliases: [],
      value: transformed.value,
      receivedValue: reading.value,
      unit: field.unit ?? reading.unit,
      flag: reading.flag,
      required: Number(field.is_required) === 1,
      note: transformed.note,
      mapped: true,
    });
  }

  const unmatched: FillPlan['unmatched'] = [];
  for (const reading of transmission.readings) {
    if (used.has(codeKey(reading.code))) continue;
    if (!Number(adapter.match_by_label)) {
      unmatched.push({ code: reading.code, analyte: reading.analyte, value: reading.value, unit: reading.unit });
      continue;
    }
    if (!String(reading.value ?? '').trim()) continue;
    planned.push({
      sourceCode: reading.code,
      analyte: reading.analyte,
      selectorKind: 'row',
      // The laboratory's name for the parameter is tried first because that is
      // what a form built in this system labels its rows with; the analyser's
      // own mnemonic is the fallback for a form that labels rows the machine's
      // way.
      selector: reading.analyte || reading.code,
      aliases: Array.from(new Set([reading.code, reading.analyte].filter(Boolean).map(String))),
      value: reading.value,
      receivedValue: reading.value,
      unit: reading.unit,
      flag: reading.flag,
      required: false,
      note: null,
      mapped: false,
    });
  }

  return {
    fields: planned,
    missing,
    unmatched,
    overwritePolicy: (adapter.overwrite_policy || 'confirm') as OverwritePolicy,
    rowContainer: adapter.row_container || adapter.form_selector || null,
    rowLabelCell: Number(adapter.row_label_cell ?? 1),
    rowValueCell: Number(adapter.row_value_cell ?? 0),
  };
}
