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
  showSignature: boolean;
  signatureLine: string;
  showDeliveryState: boolean;
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
  showSignature: true,
  signatureLine: 'Authorised by',
  showDeliveryState: false,
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
 * Is this value outside the range the laboratory holds for it?
 *
 * Used only to EXPLAIN a printed value, never to flag one the analyser did not.
 * A laboratory's reference interval and an analyser's flag can legitimately
 * disagree — different population, different method — and this report shows
 * both rather than overruling either.
 */
export function outsideRange(value: unknown, lower: unknown, upper: unknown): 'high' | 'low' | null {
  const v = Number(String(value ?? '').replace(/[^\d.+-]/g, ''));
  if (!Number.isFinite(v)) return null;
  const lo = Number(lower);
  const hi = Number(upper);
  if (Number.isFinite(hi) && v > hi) return 'high';
  if (Number.isFinite(lo) && v < lo) return 'low';
  return null;
}

/** The export formats offered beside the on-screen report. */
export const REPORT_FORMATS = ['pdf', 'docx', 'xlsx'] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];

export const REPORT_FORMAT_LABELS: Record<ReportFormat, string> = {
  pdf: 'PDF',
  docx: 'Word',
  xlsx: 'Excel',
};
