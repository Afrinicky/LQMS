/**
 * The SECHLIMS Result Filler — the vocabulary the extension, the API and the
 * settings screens all read from.
 *
 * What the extension does is narrow on purpose. An analyser has already
 * transmitted a result and SECHLIMS has already recorded it; a person is
 * standing in front of a result-entry form typing that same number in by hand.
 * The extension reads the identifier off the form, asks SECHLIMS whether it
 * knows that identifier, and — only if the two agree — puts the recorded values
 * into the fields they belong in.
 *
 * Three rules shape everything below.
 *
 *   IT NEVER DECIDES. The extension fills boxes. Reviewing, saving, authorising
 *   and releasing stay exactly where they were, with the person at the bench.
 *
 *   IT NEVER GUESSES AN IDENTITY. A missing, ambiguous or mismatched identifier
 *   stops the fill and says so. Filling the right numbers into the wrong
 *   patient is the one failure this tool could introduce that the manual
 *   process does not already have, so it is refused rather than warned about.
 *
 *   IT NEVER TOUCHES THE TRANSMISSION. Nothing here receives from an analyser,
 *   forwards anything, or writes to the tables the bridge and the middleware
 *   own. It reads what was recorded and reports what it filled.
 *
 * The form knowledge is CONFIGURATION, not code: a form adapter is a row an
 * administrator can add, so another analyser, another form or another
 * browser-based LIS is supported by configuring it rather than by shipping a
 * new extension.
 */

/* ============================================================================
   Which system the form belongs to
   ----------------------------------------------------------------------------
   An adapter names its platform so the register groups sensibly and so a
   future platform is a row rather than a branch in the extension.
   ========================================================================= */
export const FILLER_PLATFORMS = ['sechlims', 'lhims', 'lis', 'his', 'other'] as const;
export type FillerPlatform = (typeof FILLER_PLATFORMS)[number];

export const FILLER_PLATFORM_LABELS: Record<FillerPlatform, string> = {
  sechlims: 'SECHLIMS',
  lhims: 'LHIMS',
  lis: 'Laboratory information system',
  his: 'Hospital information system',
  other: 'Other platform',
};

/* ============================================================================
   Which page an adapter belongs to
   ========================================================================= */
export const URL_MATCH_MODES = ['contains', 'glob', 'regex', 'exact'] as const;
export type UrlMatchMode = (typeof URL_MATCH_MODES)[number];

export const URL_MATCH_MODE_LABELS: Record<UrlMatchMode, string> = {
  contains: 'URL contains',
  glob: 'URL matches pattern (* wildcards)',
  regex: 'URL matches regular expression',
  exact: 'URL is exactly',
};

/**
 * Does this adapter belong to the page the person is looking at?
 *
 * A bad pattern must never match everything: an adapter whose expression will
 * not compile matches nothing at all, which shows up as "no adapter for this
 * page" rather than as an adapter quietly claiming the whole browser.
 */
export function urlMatches(pattern: string, mode: UrlMatchMode, url: string): boolean {
  const target = String(url ?? '');
  const raw = String(pattern ?? '').trim();
  if (!raw) return false;
  if (mode === 'exact') return target === raw;
  if (mode === 'contains') return target.toLowerCase().includes(raw.toLowerCase());
  if (mode === 'glob') {
    const escaped = raw.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    try { return new RegExp(`^${escaped}$`, 'i').test(target); } catch { return false; }
  }
  try { return new RegExp(raw, 'i').test(target); } catch { return false; }
}

/* ============================================================================
   What the identifier on the form is
   ========================================================================= */
export const IDENTIFIER_KINDS = ['sample', 'patient', 'qc_lot', 'request', 'other'] as const;
export type IdentifierKind = (typeof IDENTIFIER_KINDS)[number];

export const IDENTIFIER_KIND_LABELS: Record<IdentifierKind, string> = {
  sample: 'Sample / specimen number',
  patient: 'Patient identifier',
  qc_lot: 'Control lot or level',
  request: 'Request or accession number',
  other: 'Other identifier',
};

/**
 * The identifier an adapter matches on.
 *
 * One kind is PRIMARY and decides the match. Any other kind the adapter reads
 * is corroboration: it may contradict the primary and stop the fill, but it may
 * never be the thing a result is filed against on its own.
 */
export const PRIMARY_IDENTIFIER_KINDS: IdentifierKind[] = ['sample', 'request', 'patient', 'qc_lot'];

/* ============================================================================
   Comparing two identifiers
   ----------------------------------------------------------------------------
   An analyser writes "25-09-002265", a form shows "2609002265", a barcode
   reader adds a trailing space. Comparing raw text refuses matches that are
   plainly the same sample; comparing too loosely matches samples that are not.
   The normaliser is per adapter, so a laboratory chooses how much it tolerates
   and can see which rule a match was made under.
   ========================================================================= */
export const IDENTIFIER_NORMALISERS = ['none', 'trim', 'alnum', 'digits'] as const;
export type IdentifierNormaliser = (typeof IDENTIFIER_NORMALISERS)[number];

export const IDENTIFIER_NORMALISER_LABELS: Record<IdentifierNormaliser, string> = {
  none: 'Exactly as typed',
  trim: 'Ignore surrounding spaces and case',
  alnum: 'Ignore spaces, punctuation and case',
  digits: 'Digits only',
};

export function normaliseIdentifier(value: unknown, rule: IdentifierNormaliser = 'alnum'): string {
  const raw = String(value ?? '');
  if (rule === 'none') return raw;
  const trimmed = raw.trim();
  if (rule === 'trim') return trimmed.toUpperCase();
  if (rule === 'digits') return trimmed.replace(/\D+/g, '');
  return trimmed.toUpperCase().replace(/[^A-Z0-9]+/g, '');
}

/**
 * How two identifiers relate.
 *
 * `exact` is the raw strings agreeing. `normalised` is them agreeing under the
 * adapter's rule — still a match, but one worth showing the person. `partial`
 * is one containing the other, which is NOT a match: it is the shape a
 * near-miss takes and the reason a fill stops for confirmation.
 */
export type IdentifierAgreement = 'exact' | 'normalised' | 'partial' | 'different';

export function compareIdentifiers(a: unknown, b: unknown, rule: IdentifierNormaliser = 'alnum'): IdentifierAgreement {
  const rawA = String(a ?? '').trim();
  const rawB = String(b ?? '').trim();
  if (!rawA || !rawB) return 'different';
  if (rawA === rawB) return 'exact';
  const normA = normaliseIdentifier(rawA, rule);
  const normB = normaliseIdentifier(rawB, rule);
  if (!normA || !normB) return 'different';
  if (normA === normB) return 'normalised';
  if (normA.length >= 4 && normB.length >= 4 && (normA.endsWith(normB) || normB.endsWith(normA))) return 'partial';
  return 'different';
}

/* ============================================================================
   Finding a field on a page
   ----------------------------------------------------------------------------
   Stable identifiers, never coordinates and never blind keystrokes. Where a
   form gives its controls names or ids, those are used. Where it does not —
   and a result-entry grid built out of a table often does not — the control is
   found by the ROW IT SITS IN: the row whose label cell reads "Haemoglobin"
   holds the haemoglobin box, and that is true whatever the page is styled like
   and wherever the row has moved to.
   ========================================================================= */
export const SELECTOR_KINDS = ['css', 'name', 'id', 'label', 'row'] as const;
export type SelectorKind = (typeof SELECTOR_KINDS)[number];

export const SELECTOR_KIND_LABELS: Record<SelectorKind, string> = {
  css: 'CSS selector',
  name: 'Field name attribute',
  id: 'Field id attribute',
  label: 'Label text beside the field',
  row: 'Table row whose label matches',
};

export const SELECTOR_KIND_HINTS: Record<SelectorKind, string> = {
  css: 'A selector that resolves to exactly one control, e.g. input[data-analyte="HGB"].',
  name: 'The control’s name attribute, e.g. result_hgb.',
  id: 'The control’s id attribute, e.g. txtHGB.',
  label: 'The visible label, e.g. Haemoglobin. The control the label points at is filled.',
  row: 'The row label, e.g. Haemoglobin. The control in that row is filled — for result grids with no field names.',
};

/* ============================================================================
   What a fill is allowed to do to a box that already has something in it
   ========================================================================= */
export const OVERWRITE_POLICIES = ['never', 'confirm', 'allow'] as const;
export type OverwritePolicy = (typeof OVERWRITE_POLICIES)[number];

export const OVERWRITE_POLICY_LABELS: Record<OverwritePolicy, string> = {
  never: 'Never overwrite — leave a field that already has a value',
  confirm: 'Ask first, then overwrite the fields the person agrees to',
  allow: 'Overwrite without asking',
};

/* ============================================================================
   The verdict on an identifier
   ----------------------------------------------------------------------------
   Only `verified` fills on its own. `near_match` fills after the person has
   been shown both identifiers and has agreed. Nothing else fills at all.
   ========================================================================= */
export const VERIFY_STATUSES = [
  'verified', 'near_match', 'ambiguous', 'no_identifier', 'not_found', 'no_results', 'already_entered', 'blocked',
] as const;
export type VerifyStatus = (typeof VERIFY_STATUSES)[number];

export const VERIFY_STATUS_LABELS: Record<VerifyStatus, string> = {
  verified: 'Identifier verified',
  near_match: 'Close, not identical',
  ambiguous: 'More than one record matches',
  no_identifier: 'No identifier on the form',
  not_found: 'No matching record',
  no_results: 'Nothing transmitted for it',
  already_entered: 'Already entered from this transmission',
  blocked: 'Blocked',
};

export const VERIFY_STATUS_TONES: Record<VerifyStatus, 'ok' | 'warn' | 'crit' | 'idle'> = {
  verified: 'ok',
  near_match: 'warn',
  ambiguous: 'crit',
  no_identifier: 'crit',
  not_found: 'crit',
  no_results: 'idle',
  already_entered: 'warn',
  blocked: 'crit',
};

/** Only these two may ever reach a Populate button, and one of them asks first. */
export function statusAllowsFill(status: VerifyStatus | string): boolean {
  return status === 'verified' || status === 'near_match' || status === 'already_entered';
}

/** The ones where the person has to agree to something before anything is filled. */
export function statusNeedsConfirmation(status: VerifyStatus | string): boolean {
  return status === 'near_match' || status === 'already_entered';
}

/* ============================================================================
   One fill, on the record
   ========================================================================= */
export const FILL_STATES = ['issued', 'applied', 'partial', 'failed', 'abandoned'] as const;
export type FillState = (typeof FILL_STATES)[number];

export const FILL_STATE_LABELS: Record<FillState, string> = {
  issued: 'Issued, no outcome reported',
  applied: 'Filled',
  partial: 'Partly filled',
  failed: 'Failed',
  abandoned: 'Abandoned',
};

export const FILL_STATE_TONES: Record<FillState, 'ok' | 'warn' | 'crit' | 'idle'> = {
  issued: 'idle', applied: 'ok', partial: 'warn', failed: 'crit', abandoned: 'idle',
};

/* ============================================================================
   Turning a transmitted value into what a form expects
   ----------------------------------------------------------------------------
   Deliberately minimal, and off unless configured. The received value is the
   record; a conversion is a destination's requirement, not an improvement, and
   every one applied is reported beside the field it changed.
   ========================================================================= */
export interface FieldTransform {
  factor?: number | null;
  offsetValue?: number | null;
  decimals?: number | null;
  valueMap?: Record<string, string> | null;
}

export interface TransformedValue {
  value: string;
  /** What was done to it, in words, or null when the value is untouched. */
  note: string | null;
}

export function applyFieldTransform(received: unknown, transform?: FieldTransform | null): TransformedValue {
  const raw = String(received ?? '').trim();
  if (!transform) return { value: raw, note: null };

  const mapped = transform.valueMap?.[raw] ?? transform.valueMap?.[raw.toUpperCase()];
  if (mapped != null) return { value: String(mapped), note: `coded ${raw} → ${mapped}` };

  const numeric = Number(raw);
  if (!raw || !Number.isFinite(numeric)) return { value: raw, note: null };

  const factor = Number(transform.factor ?? 1);
  const offset = Number(transform.offsetValue ?? 0);
  const scaled = (Number.isFinite(factor) ? factor : 1) * numeric + (Number.isFinite(offset) ? offset : 0);
  const decimals = transform.decimals;
  const converted = decimals != null && Number.isFinite(Number(decimals))
    ? scaled.toFixed(Math.max(0, Math.min(6, Number(decimals))))
    : String(scaled);

  if (converted === raw) return { value: raw, note: null };
  const parts: string[] = [];
  if (factor !== 1 || offset !== 0) parts.push(`converted from ${raw}`);
  else if (decimals != null) parts.push(`rounded from ${raw}`);
  return { value: converted, note: parts.join(', ') || null };
}

/* ============================================================================
   Matching an analyser parameter to a field
   ----------------------------------------------------------------------------
   An analyser says WBC, a form says W.B.C, a mapping row says "wbc". They are
   the same parameter and comparing them literally says they are not.
   ========================================================================= */
export function codeKey(value: unknown): string {
  return String(value ?? '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '');
}

/* ============================================================================
   How far back a form may reach
   ----------------------------------------------------------------------------
   A sample run this morning is the one being typed in. A sample identifier
   reused next month is a different sample, and filling last month's numbers
   into it is precisely the error this tool must not make. The window is per
   adapter and short by default.
   ========================================================================= */
export const DEFAULT_LOOKBACK_HOURS = 72;
export const MAX_LOOKBACK_HOURS = 24 * 90;

/* ============================================================================
   Enrolling a browser
   ----------------------------------------------------------------------------
   Two credentials, because they answer two questions. The DEVICE token says
   this browser was enrolled by an administrator and may ask SECHLIMS for
   pending results at all; the person's own session says who is filling the
   form. Either can be withdrawn without the other.
   ========================================================================= */
export const PAIRING_CODE_TTL_MINUTES = 60;
export const PAIRING_CODE_LENGTH = 8;
export const DEVICE_HEADER = 'x-sechlims-device';

export const DEVICE_STATES = ['pending', 'enrolled', 'revoked'] as const;
export type DeviceState = (typeof DEVICE_STATES)[number];

export const DEVICE_STATE_LABELS: Record<DeviceState, string> = {
  pending: 'Awaiting enrolment',
  enrolled: 'Enrolled',
  revoked: 'Revoked',
};

export const DEVICE_STATE_TONES: Record<DeviceState, 'ok' | 'warn' | 'idle'> = {
  pending: 'warn', enrolled: 'ok', revoked: 'idle',
};

/* ============================================================================
   The adapters that ship with the extension
   ----------------------------------------------------------------------------
   Seeded as ordinary rows an administrator can edit, disable or copy. They are
   marked built-in so an upgrade can recognise them, and nothing about them is
   privileged: a laboratory that changes one is not fighting the code.
   ========================================================================= */
export interface BuiltInField {
  sourceCode: string;
  analyte: string;
  selectorKind: SelectorKind;
  selector: string;
  unit?: string | null;
  decimals?: number | null;
  required?: boolean;
  note?: string | null;
}

export interface BuiltInAdapter {
  adapterCode: string;
  name: string;
  platform: FillerPlatform;
  description: string;
  urlPattern: string;
  urlMatchMode: UrlMatchMode;
  formSelector: string;
  identifiers: Array<{ kind: IdentifierKind; selectorKind: SelectorKind; selector: string; primary?: boolean }>;
  normaliser: IdentifierNormaliser;
  overwritePolicy: OverwritePolicy;
  lookbackHours: number;
  messageKind: 'patient' | 'control' | 'any';
  /** Empty means the adapter matches analyser parameters by name at fill time. */
  fields: BuiltInField[];
  isActive: boolean;
  notes?: string;
}

/**
 * SECHLIMS's own control-run entry, and the LHIMS patient result page.
 *
 * The SECHLIMS adapter needs no field list: its entry grid labels every row
 * with the analyte, so the row strategy finds each box by the name the
 * laboratory already gave the parameter. The LHIMS adapter ships INACTIVE with
 * the structure filled in and the selectors blank, because the selectors depend
 * on that installation's pages — it is enabled once an administrator has
 * captured them from the page itself.
 */
export const BUILTIN_ADAPTERS: BuiltInAdapter[] = [
  {
    adapterCode: 'SECHLIMS-IQC',
    name: 'SECHLIMS — control run entry',
    platform: 'sechlims',
    description: 'The Internal Quality Control run form. Every analyte row is filled from the control transmission that matches the sample identifier.',
    urlPattern: '*/iqc*',
    urlMatchMode: 'glob',
    formSelector: 'table.iqc-entry',
    identifiers: [{ kind: 'sample', selectorKind: 'css', selector: 'input[data-rf-sample], input[name="sampleId"]', primary: true }],
    normaliser: 'alnum',
    overwritePolicy: 'confirm',
    lookbackHours: 72,
    messageKind: 'control',
    fields: [],
    isActive: true,
    notes: 'Rows are matched on the analyte name in the first column, so a control that gains a parameter needs no change here.',
  },
  {
    adapterCode: 'SECHLIMS-EQA',
    name: 'SECHLIMS — EQA result entry',
    platform: 'sechlims',
    description: 'External quality assessment result entry. The survey sample identifier is matched against the transmission that ran it.',
    urlPattern: '*/eqa*',
    urlMatchMode: 'glob',
    formSelector: 'table.eqa-entry, table.data-table',
    identifiers: [{ kind: 'sample', selectorKind: 'label', selector: 'Sample', primary: true }],
    normaliser: 'alnum',
    overwritePolicy: 'confirm',
    lookbackHours: 24 * 14,
    messageKind: 'any',
    fields: [],
    isActive: true,
  },
  {
    adapterCode: 'LHIMS-RESULTS',
    name: 'LHIMS — patient result entry',
    platform: 'lhims',
    description: 'The LHIMS result-entry page. Capture the specimen field and each parameter from the page before enabling this adapter.',
    urlPattern: '*lhims*',
    urlMatchMode: 'glob',
    formSelector: '',
    identifiers: [{ kind: 'sample', selectorKind: 'name', selector: 'specimen_id', primary: true }],
    normaliser: 'alnum',
    overwritePolicy: 'never',
    lookbackHours: 72,
    messageKind: 'patient',
    fields: [],
    isActive: false,
    notes: 'Inactive until its selectors are captured. Capturing them does not alter the existing analyser-to-LHIMS transmission in any way — the extension only types into a page a person already has open.',
  },
];
