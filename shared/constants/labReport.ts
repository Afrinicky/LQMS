/**
 * The laboratory report — what a transmitted result looks like on paper.
 *
 * Every result an analyser has sent is already on the record. This turns one of
 * those records into the document a laboratory actually hands over: the
 * letterhead, the patient and sample block, the parameters with their units,
 * the analyser's own flags, the reference range each was read against, and
 * whatever the instrument said about the sample in its own words.
 *
 * Nothing here recalculates or reinterprets anything. The value printed is the
 * value received, the flag printed is the flag the analyser raised, and a
 * reference range is shown only where the laboratory has one on file. A report
 * that quietly improved on the transmission would be a different result from
 * the one the instrument issued.
 *
 * The appearance is configuration, so a laboratory changes its letterhead
 * without changing the system, and a second site can hold its own template.
 */

export const PAPER_SIZES = ['A4', 'Letter', 'A5'] as const;
export type PaperSize = (typeof PAPER_SIZES)[number];

export const HEADER_STYLES = ['centred', 'left', 'banded', 'minimal'] as const;
export type HeaderStyle = (typeof HEADER_STYLES)[number];

export const HEADER_STYLE_LABELS: Record<HeaderStyle, string> = {
  centred: 'Centred — crest left, titles centred',
  left: 'Left aligned — crest and titles on the left',
  banded: 'Banded — titles reversed out of a coloured band',
  minimal: 'Minimal — one rule, no crest',
};

export const DENSITIES = ['comfortable', 'compact'] as const;
export type Density = (typeof DENSITIES)[number];

export const DENSITY_LABELS: Record<Density, string> = {
  comfortable: 'Comfortable',
  compact: 'Compact — more parameters to a page',
};

export const FONT_CHOICES = [
  { key: 'serif', label: 'Serif (Times)', stack: '"Times New Roman", Times, Georgia, serif' },
  { key: 'sans', label: 'Sans (Arial)', stack: 'Arial, "Segoe UI", Helvetica, sans-serif' },
  { key: 'mixed', label: 'Serif headings, sans body', stack: 'Arial, "Segoe UI", Helvetica, sans-serif' },
  { key: 'mono-values', label: 'Sans with monospaced values', stack: 'Arial, "Segoe UI", Helvetica, sans-serif' },
] as const;
export type FontChoice = (typeof FONT_CHOICES)[number]['key'];

export function fontStack(choice: string | null | undefined): string {
  return FONT_CHOICES.find(f => f.key === choice)?.stack ?? FONT_CHOICES[1].stack;
}

/** The columns the parameter table may carry, in the order they are printed. */
export const REPORT_COLUMNS = ['parameter', 'result', 'flag', 'unit', 'reference', 'method'] as const;
export type ReportColumn = (typeof REPORT_COLUMNS)[number];

export const REPORT_COLUMN_LABELS: Record<ReportColumn, string> = {
  parameter: 'Parameter',
  result: 'Result',
  flag: 'Flag',
  unit: 'Unit',
  reference: 'Reference range',
  method: 'Method / analyser',
};

/** Columns a report cannot sensibly drop. */
export const REQUIRED_COLUMNS: ReportColumn[] = ['parameter', 'result'];

export interface ReportTemplate {
  id?: number;
  templateCode: string;
  name: string;
  /** The lines above the title: owning body, facility, address, contact. */
  organisation: string;
  facility: string;
  addressLine: string;
  contactLine: string;
  /** The document's own title, e.g. HAEMATOLOGY REPORT. Blank follows the discipline. */
  reportTitle: string;
  footerText: string;
  logoDataUri: string | null;
  accentColour: string;
  textColour: string;
  headerStyle: HeaderStyle;
  font: FontChoice;
  paper: PaperSize;
  density: Density;
  marginMm: number;
  columns: ReportColumn[];
  showLogo: boolean;
  showFlagLegend: boolean;
  showInstrumentMessages: boolean;
  /**
   * Print the analyser's scattergrams and histograms.
   *
   * Only ever draws a channel that actually carried a picture, so switching it
   * on costs nothing on an analyser that is not configured to transmit them.
   */
  showScattergrams: boolean;
  showSignature: boolean;
  signatureLine: string;
  showDeliveryState: boolean;
  /** Print the sex or age band a range was set for, beside the range. */
  showRangePopulation: boolean;
  watermark: string;
  disclaimer: string;
  isDefault?: boolean;
}

/**
 * The template a laboratory gets before it has configured one.
 *
 * Modelled on the haematology report this laboratory already issues, so the
 * first document produced is recognisable rather than something to be made
 * recognisable.
 */
export const DEFAULT_TEMPLATE: ReportTemplate = {
  templateCode: 'DEFAULT',
  name: 'Standard laboratory report',
  organisation: '',
  facility: '',
  addressLine: '',
  contactLine: '',
  reportTitle: '',
  footerText: 'Results relate only to the sample received. Reviewed and authorised before release.',
  logoDataUri: null,
  accentColour: '#1B3A6B',
  textColour: '#111827',
  headerStyle: 'centred',
  font: 'serif',
  paper: 'A4',
  density: 'comfortable',
  marginMm: 13,
  columns: ['parameter', 'result', 'flag', 'unit', 'reference'],
  showLogo: true,
  showFlagLegend: true,
  showInstrumentMessages: true,
  showScattergrams: false,
  showSignature: true,
  signatureLine: 'Authorised by',
  showDeliveryState: false,
  showRangePopulation: false,
  watermark: '',
  disclaimer: '',
  isDefault: true,
};

/* ============================================================================
   Flags
   ----------------------------------------------------------------------------
   Analysers do not agree on how to say "high". ASTM writes H, L, A; a Sysmex
   printout carries +, -, *. Both are kept as sent and read into one meaning for
   the legend, so a report prints the instrument's own mark and still explains
   what it meant.
   ========================================================================= */
export type FlagMeaning = 'high' | 'low' | 'abnormal' | 'critical' | 'none';

export const FLAG_MEANING_LABELS: Record<FlagMeaning, string> = {
  high: 'Above the reference range',
  low: 'Below the reference range',
  abnormal: 'Flagged by the analyser',
  critical: 'Critical',
  none: 'Within range',
};

export function flagMeaning(flag: unknown): FlagMeaning {
  const raw = String(flag ?? '').trim();
  if (!raw) return 'none';
  const upper = raw.toUpperCase();
  // ASTM's result-abnormality field is filled in on EVERY result, and on a
  // normal one it says so: N. Colouring that red turns a clean full blood
  // count into a page of alarms, which is how a report stops being read.
  if (upper === 'N' || upper === 'NORM' || upper === 'NORMAL' || upper === 'NR') return 'none';
  if (upper === 'HH' || upper === 'LL' || upper === '!' || upper === '++' || upper === '--') return 'critical';
  if (upper === 'H' || raw === '+' || upper === 'HI' || upper === 'HIGH' || raw === '>') return 'high';
  if (upper === 'L' || raw === '-' || upper === 'LO' || upper === 'LOW' || raw === '<') return 'low';
  return 'abnormal';
}

/**
 * A limit, or nothing at all.
 *
 * `Number(null)` is 0, and 0 is a perfectly finite number — so a parameter
 * with no upper limit on file was read as having an upper limit of zero, and
 * every value above zero was therefore above range. Nothing showed it while
 * the printed flag came from the analyser; the moment the flag was derived
 * from the range instead, every unranged parameter on the report would have
 * been marked high. An absent limit has to be absent, not zero.
 */
function limit(value: unknown): number | null {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

/**
 * Is this value outside the range the laboratory holds for it?
 *
 * This decides the flag the report prints, so that the flag and the range
 * beside it can never contradict each other. Where the laboratory holds no
 * range, it returns null and the report says nothing — an honest blank rather
 * than a judgement nothing made.
 */
export function outsideRange(value: unknown, lower: unknown, upper: unknown): 'high' | 'low' | null {
  /*
   * A result with no digits in it is not a number, and must not be compared
   * as one. "****" and "ERROR" strip to an empty string, which Number() reads
   * as zero — and zero is below every lower limit, so an analyser's error
   * marker was being reported as a low result.
   */
  const v = limit(String(value ?? '').replace(/[^\d.+-]/g, ''));
  if (v === null) return null;
  const lo = limit(lower);
  const hi = limit(upper);
  if (hi !== null && v > hi) return 'high';
  if (lo !== null && v < lo) return 'low';
  return null;
}

/* ============================================================================
   Reference ranges
   ----------------------------------------------------------------------------
   A range is the laboratory's clinical decision. Nothing here invents one: a
   parameter with none on file prints a dash, because a number somebody might
   trust is worse than an honest blank.

   What this does decide is WHICH of the laboratory's ranges applies, when it
   has set several — and on a full blood count it usually has, because a
   newborn's haematocrit and a grown man's are different numbers.
   ========================================================================= */
export const RANGE_SEXES = ['any', 'male', 'female'] as const;
export type RangeSex = (typeof RANGE_SEXES)[number];

export const RANGE_SEX_LABELS: Record<RangeSex, string> = {
  any: 'Any',
  male: 'Male',
  female: 'Female',
};

export const AGE_UNITS = [
  { key: 'days', label: 'days', days: 1 },
  { key: 'weeks', label: 'weeks', days: 7 },
  { key: 'months', label: 'months', days: 30.4375 },
  { key: 'years', label: 'years', days: 365.25 },
] as const;
export type AgeUnit = (typeof AGE_UNITS)[number]['key'];

export function ageToDays(value: number | null | undefined, unit: AgeUnit): number | null {
  if (value == null || !Number.isFinite(Number(value))) return null;
  const found = AGE_UNITS.find(entry => entry.key === unit) ?? AGE_UNITS[3];
  return Math.round(Number(value) * found.days);
}

/** `0–56` days reads as `birth – 8 weeks`, which is how a laboratory says it. */
export function describeAgeBand(minDays: number | null, maxDays: number | null): string {
  if (minDays == null && maxDays == null) return 'Any age';
  const say = (days: number) => {
    if (days < 14) return `${days} day${days === 1 ? '' : 's'}`;
    if (days < 60) return `${Math.round(days / 7)} weeks`;
    if (days < 730) return `${Math.round(days / 30.4375)} months`;
    return `${Math.round(days / 365.25)} years`;
  };
  if (minDays == null) return `under ${say(maxDays as number)}`;
  if (maxDays == null) return `${say(minDays)} and over`;
  return `${say(minDays)} – ${say(maxDays)}`;
}

export interface ReferenceRange {
  id?: number;
  analyte: string;
  sex: RangeSex;
  ageMinDays: number | null;
  ageMaxDays: number | null;
  ageLabel: string | null;
  low: string | null;
  high: string | null;
  textValue: string | null;
  unit: string | null;
  source: string | null;
  note: string | null;
  isActive?: boolean;
}

/** Whole days between a birth date and the day the sample was run. */
export function ageInDays(birthDate: string | null | undefined, on: string | null | undefined): number | null {
  if (!birthDate) return null;
  const born = Date.parse(`${String(birthDate).slice(0, 10)}T00:00:00Z`);
  const at = on ? Date.parse(`${String(on).replace(' ', 'T').slice(0, 19)}Z`) : Date.now();
  if (!Number.isFinite(born) || !Number.isFinite(at) || at < born) return null;
  return Math.floor((at - born) / 86_400_000);
}

/**
 * Which of the laboratory's ranges applies to this result.
 *
 * The most specific wins: a range set for this sex beats one set for anybody,
 * and a narrow age band beats a wide one. A range whose band excludes the
 * patient is not used at all — a range that does not apply is not a fallback,
 * it is the wrong answer.
 *
 * Where the patient's age or sex is unknown — the transmission carried none —
 * only ranges that ask for neither are eligible, for the same reason.
 */
export function pickRange(
  ranges: ReferenceRange[],
  patient: { sex?: string | null; ageDays?: number | null },
): ReferenceRange | null {
  const sex = String(patient.sex ?? '').trim().toLowerCase().startsWith('m') ? 'male'
    : String(patient.sex ?? '').trim().toLowerCase().startsWith('f') ? 'female' : null;
  const age = patient.ageDays ?? null;

  let best: { range: ReferenceRange; score: number } | null = null;
  for (const range of ranges) {
    if (range.isActive === false) continue;

    let score = 0;
    if (range.sex !== 'any') {
      if (!sex || range.sex !== sex) continue;
      score += 10;
    }
    const banded = range.ageMinDays != null || range.ageMaxDays != null;
    if (banded) {
      if (age == null) continue;
      if (range.ageMinDays != null && age < range.ageMinDays) continue;
      if (range.ageMaxDays != null && age > range.ageMaxDays) continue;
      // A narrower band is a more deliberate decision than a wide one.
      const width = (range.ageMaxDays ?? 40_000) - (range.ageMinDays ?? 0);
      score += 20 + Math.max(0, 20 - Math.round(width / 2_000));
    }
    if (!best || score > best.score) best = { range, score };
  }
  return best?.range ?? null;
}

/** The export formats offered beside the on-screen report. */
export const REPORT_FORMATS = ['pdf', 'docx', 'xlsx'] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];

export const REPORT_FORMAT_LABELS: Record<ReportFormat, string> = {
  pdf: 'PDF',
  docx: 'Word',
  xlsx: 'Excel',
};
