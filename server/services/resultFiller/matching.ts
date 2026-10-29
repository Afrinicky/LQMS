/**
 * Turning a scan of a page into a plan for it.
 *
 * The extension reads the form and sends back what it found: the identifiers it
 * could see, and the parameters the form is asking for, each with the label
 * printed beside it. This decides which of the analyser's readings belongs in
 * which box, and says on what grounds.
 *
 * The decision is made HERE rather than in the browser for three reasons. The
 * dictionary a laboratory extends lives in this database, so a page cannot be
 * filled by a vocabulary nobody approved. The grounds of every match are
 * written down beside the fill, so "why did it put that number there" has an
 * answer months later. And a browser is where a person works, not where a
 * safety rule belongs.
 */
import {
  MATCH_FILL_THRESHOLD, analyteKey, assignReadings, canonicalAnalyte, cleanLabel,
  type DetectedField, type DetectedIdentifier, type FieldAssignment,
} from '../../../shared/constants/formIntelligence.js';
import { applyFieldTransform, codeKey } from '../../../shared/constants/resultFiller.js';
import type { FieldRow } from './adapters.js';
import type { Reading, Transmission } from './pending.js';

type DB = any;

/* ============================================================================
   The laboratory's own names
   ========================================================================= */

/** alias key → canonical, for this form and for every form. */
export function aliasIndex(db: DB, adapterId?: number | null): Map<string, string> {
  const index = new Map<string, string>();
  let rows: any[] = [];
  try {
    rows = db.prepare(`SELECT canonical, alias, COALESCE(withdrawn, 0) AS withdrawn FROM rf_aliases
        WHERE adapter_id IS NULL OR adapter_id = ? ORDER BY adapter_id IS NULL DESC, id`)
      .all(adapterId ?? null) as any[];
  } catch { return index; }
  // A form's own alias is read after the general one and overwrites it, which
  // is what makes a local override local.
  for (const row of rows) {
    const key = analyteKey(row.alias);
    if (!key) continue;
    // A withdrawn name maps to nothing at all, which is how a laboratory
    // overrules a built-in name it does not use. See canonicalAnalyte.
    index.set(key, Number(row.withdrawn) === 1 ? '' : String(row.canonical));
  }
  return index;
}

/* ============================================================================
   Which identifier the page is actually about
   ----------------------------------------------------------------------------
   A result page carries several numbers that identify something: the sample's
   barcode, the patient's folder number, an insurance number, a visit number.
   Only one of them is what a transmission is filed against, and which one it is
   depends on what this laboratory's analysers put on the wire.
   ========================================================================= */
export interface IdentifierCandidate {
  kind: string;
  label: string;
  value: string;
  source?: string;
  confidence?: number;
}

/**
 * The order candidates are tried in.
 *
 * Sample before patient, always: a patient identifier matching a transmission
 * would be a coincidence, and filing a result on a coincidence is the error
 * this whole tool exists to avoid. Within a kind, the more confident detection
 * is tried first.
 */
export function orderCandidates(candidates: IdentifierCandidate[]): IdentifierCandidate[] {
  const rank: Record<string, number> = { sample: 0, request: 1, patient: 2, other: 3 };
  return [...candidates]
    .filter(candidate => String(candidate.value ?? '').trim())
    .sort((a, b) => (rank[a.kind] ?? 9) - (rank[b.kind] ?? 9) || Number(b.confidence ?? 0) - Number(a.confidence ?? 0));
}

/* ============================================================================
   Readings to boxes
   ========================================================================= */
export interface PlanOptions {
  /** Explicit mappings an administrator wrote, which always win. */
  fields: FieldRow[];
  /** The laboratory's own extra names. */
  aliases: Map<string, string>;
  threshold?: number;
}

export interface DetectedPlan {
  assignments: Array<FieldAssignment & { required: boolean; mapped: boolean }>;
  /** Readings the form has no box for. Reported, never dropped silently. */
  unmatched: Array<{ code: string; analyte: string; value: string; unit: string | null }>;
  /** Boxes the transmission carries nothing for. */
  unfilled: Array<{ index: number; label: string }>;
  /** Pairs that resemble each other but not enough to type in unasked. */
  suggestions: FieldAssignment[];
}

/**
 * Which reading goes in which box.
 *
 * An explicit mapping is honoured first and exactly: an administrator who has
 * said where HGB goes on this form has settled the question, and no dictionary
 * gets to disagree. What is left over is matched by name, and only a match the
 * matcher is sure of is filled — the rest comes back as a suggestion for a
 * person to confirm or to map properly.
 */
export function planFromScan(transmission: Transmission, detected: DetectedField[], options: PlanOptions): DetectedPlan {
  const assignments: DetectedPlan['assignments'] = [];
  const takenFields = new Set<number>();
  const takenCodes = new Set<string>();

  const byLabel = new Map<string, DetectedField>();
  for (const field of detected) {
    const key = analyteKey(field.label);
    if (key && !byLabel.has(key)) byLabel.set(key, field);
  }

  /* ---- what an administrator mapped by hand -------------------------- */
  for (const mapping of options.fields) {
    if (!Number(mapping.is_active)) continue;
    const reading = findReading(transmission.readings, mapping.source_code)
      ?? (mapping.analyte ? findReading(transmission.readings, mapping.analyte) : undefined);
    if (!reading) continue;

    // A mapping's selector names the field on the page; on a detected page the
    // same name is what the scanner labelled a box with.
    const target = byLabel.get(analyteKey(mapping.selector))
      ?? byLabel.get(analyteKey(mapping.analyte ?? ''))
      ?? byLabel.get(analyteKey(mapping.source_code));
    if (!target || takenFields.has(target.index)) continue;

    const transformed = applyFieldTransform(reading.value, {
      factor: mapping.factor, offsetValue: mapping.offset_value, decimals: mapping.decimals,
      valueMap: safeJson<Record<string, string> | null>(mapping.value_map, null),
    });
    assignments.push({
      index: target.index,
      sourceCode: reading.code,
      analyte: mapping.analyte || reading.analyte,
      fieldLabel: target.label,
      value: transformed.value,
      receivedValue: reading.value,
      unit: mapping.unit ?? reading.unit,
      flag: reading.flag,
      score: 100,
      how: 'mapped by hand for this form',
      note: transformed.note,
      required: Number(mapping.is_required) === 1,
      mapped: true,
    });
    takenFields.add(target.index);
    takenCodes.add(codeKey(reading.code));
  }

  /* ---- and what the names say ----------------------------------------- */
  const remainingReadings = transmission.readings.filter(reading => !takenCodes.has(codeKey(reading.code)));
  const remainingFields = detected.filter(field => !takenFields.has(field.index));
  const matched = assignReadings(remainingReadings, remainingFields, {
    extraAliases: options.aliases,
    threshold: options.threshold ?? MATCH_FILL_THRESHOLD,
  });

  for (const assignment of matched.assignments) {
    assignments.push({ ...assignment, required: false, mapped: false });
    takenFields.add(assignment.index);
    takenCodes.add(codeKey(assignment.sourceCode));
  }

  assignments.sort((a, b) => a.index - b.index);

  return {
    assignments,
    unmatched: transmission.readings
      .filter(reading => !takenCodes.has(codeKey(reading.code)) && String(reading.value ?? '').trim())
      .map(reading => ({ code: reading.code, analyte: reading.analyte, value: reading.value, unit: reading.unit })),
    unfilled: detected
      .filter(field => !takenFields.has(field.index))
      .map(field => ({ index: field.index, label: field.label })),
    suggestions: matched.suggestions,
  };
}

function findReading(readings: Reading[], wanted: string): Reading | undefined {
  const key = codeKey(wanted);
  if (!key) return undefined;
  return readings.find(r => codeKey(r.code) === key) ?? readings.find(r => codeKey(r.analyte) === key);
}

function safeJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try { return (JSON.parse(value) ?? fallback) as T; } catch { return fallback; }
}

/* ============================================================================
   What the scan is allowed to say about itself
   ========================================================================= */

/** The scanner's own words, trimmed to what a register should hold. */
export function tidyDetectedFields(raw: unknown): DetectedField[] {
  if (!Array.isArray(raw)) return [];
  const out: DetectedField[] = [];
  for (const entry of raw.slice(0, 400)) {
    const index = Number((entry as any)?.index);
    const label = cleanLabel((entry as any)?.label);
    if (!Number.isInteger(index) || index < 0 || !label) continue;
    out.push({
      index,
      label: label.slice(0, 120),
      unit: (entry as any)?.unit ? String((entry as any).unit).slice(0, 40) : null,
      referenceText: (entry as any)?.referenceText ? String((entry as any).referenceText).slice(0, 120) : null,
      current: String((entry as any)?.current ?? '').slice(0, 60),
      kind: (entry as any)?.kind === 'select' ? 'select' : 'text',
    });
  }
  return out;
}

export function tidyDetectedIdentifiers(raw: unknown): DetectedIdentifier[] {
  if (!Array.isArray(raw)) return [];
  const out: DetectedIdentifier[] = [];
  for (const entry of raw.slice(0, 40)) {
    const value = String((entry as any)?.value ?? '').trim();
    if (!value) continue;
    const kind = String((entry as any)?.kind ?? 'other');
    out.push({
      kind: (['sample', 'patient', 'request', 'other'].includes(kind) ? kind : 'other') as DetectedIdentifier['kind'],
      label: cleanLabel((entry as any)?.label).slice(0, 80),
      value: value.slice(0, 64),
      source: String((entry as any)?.source ?? 'unknown').slice(0, 20),
      confidence: Math.min(100, Math.max(0, Number((entry as any)?.confidence ?? 0))),
    });
  }
  return out;
}

/** A one-line account of what a scan understood, for the panel and the record. */
export function describeScan(identifiers: DetectedIdentifier[], fields: DetectedField[]): string {
  const sample = identifiers.find(i => i.kind === 'sample');
  const parts: string[] = [];
  parts.push(sample ? `${sample.label || 'Sample'} ${sample.value}` : 'no sample identifier found');
  parts.push(`${fields.length} result field(s) on the page`);
  const known = fields.filter(field => canonicalAnalyte(field.label)).length;
  if (fields.length) parts.push(`${known} recognised`);
  return parts.join(' · ');
}
