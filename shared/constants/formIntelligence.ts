/**
 * Reading a result-entry form the way a person reads it.
 *
 * The first version of the filler could only see what it had been told the
 * selector for, and only inside a box somebody could type in. On a real LIS
 * page that is the wrong half: the sample barcode is printed in a table cell,
 * the folder number sits under the photograph with no label at all, and the
 * parameter a box belongs to is written beside it rather than in its name
 * attribute. A tool that can only read inputs cannot read any of that.
 *
 * So the page is read by MEANING rather than by markup:
 *
 *   A value is identified by what it is LABELLED as — a column header above it,
 *   a caption beside it — or, failing a label, by what it LOOKS like.
 *
 *   A parameter is matched to an analyser's reading through a dictionary of the
 *   names both of them actually use, because "NA" and "SODIUM" are the same
 *   measurement and no amount of string comparison will say so.
 *
 * Everything here is pure: the same functions decide on the page, in the API
 * and in the checks, so what the bench is shown and what the server allows can
 * never drift apart.
 */

/* ============================================================================
   Cleaning a label
   ----------------------------------------------------------------------------
   A label on a result form carries decoration: a required marker, a colon, the
   last value printed underneath, a parenthetical abbreviation, a note about the
   method. The decoration is not the name.
   ========================================================================= */

/** `ALBUMIN*` → `ALBUMIN`; `Sample Barcode :` → `Sample Barcode`. */
export function cleanLabel(raw: unknown): string {
  return String(raw ?? '')
    .replace(/[ \s]+/g, ' ')
    .replace(/[*†‡]+/g, ' ')
    // A lone 0 or 0.0 trailing the label is the previous value LHIMS prints
    // under each parameter, not part of its name. It arrives with a space
    // where the markup gave one and without where it did not, so both are cut.
    .replace(/\s+0(\.0+)?\s*$/, '')
    .replace(/(?<=[)\]A-Za-z%#])\s*0(\.0+)?\s*$/, '')
    .replace(/\s*[:：]\s*$/, '')
    .trim();
}

/**
 * The names one label could be going by.
 *
 * `Alanine Aminotransferase (ALT)` is three candidates: the whole phrase, the
 * phrase without its bracket, and ALT on its own — and it is the last of those
 * that an analyser sends.
 */
export function labelCandidates(raw: unknown): string[] {
  const label = cleanLabel(raw);
  if (!label) return [];
  const out = [label];
  const bracketed = label.match(/\(([^)]{1,24})\)/g);
  if (bracketed) {
    out.push(label.replace(/\s*\([^)]*\)\s*/g, ' ').trim());
    for (const part of bracketed) out.push(part.replace(/[()]/g, '').trim());
  }
  // A method note on its own line — "MPV (Laser Flowcytometry)" — is already
  // handled above; a dash-suffixed qualifier is not part of the name either.
  const dashed = label.match(/^(.+?)\s+[-–—]\s+(method|by|on)\b/i);
  if (dashed) out.push(dashed[1].trim());
  return Array.from(new Set(out.filter(Boolean)));
}

/**
 * The comparable form of a parameter name.
 *
 * `#` and `%` survive as words. They are the difference between an absolute
 * neutrophil count and a neutrophil percentage, and a normaliser that threw
 * away punctuation would file one as the other — the single most dangerous
 * mistake this matcher could make.
 */
export function analyteKey(raw: unknown): string {
  return String(raw ?? '')
    .toUpperCase()
    .replace(/[ \s]+/g, ' ')
    .replace(/#/g, ' ABS ')
    .replace(/%/g, ' PCT ')
    .replace(/\bABSOLUTE\b/g, ' ABS ')
    .replace(/\bPERCENTAGE\b|\bPERCENT\b/g, ' PCT ')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/* ============================================================================
   The dictionary
   ----------------------------------------------------------------------------
   Canonical name first, then every name an analyser or a form has been seen to
   use for it. Deliberately conservative: a wrong synonym files a result under
   the wrong parameter, so an abbreviation that two different measurements share
   is left out rather than guessed at.
   ========================================================================= */
export interface AnalyteEntry {
  /** What this system calls it. */
  canonical: string;
  /** Haematology, chemistry… — used only to explain a match, never to make one. */
  discipline: 'haematology' | 'chemistry' | 'other';
  aliases: string[];
}

export const ANALYTE_DICTIONARY: AnalyteEntry[] = [
  /* ---- Full blood count, as a Sysmex XN emits it and LHIMS labels it ---- */
  { canonical: 'WBC', discipline: 'haematology', aliases: ['W B C', 'WHITE BLOOD CELL', 'WHITE BLOOD CELLS', 'WHITE CELL COUNT', 'WHITE CELLS', 'LEUCOCYTES', 'LEUKOCYTES', 'TLC', 'TOTAL WHITE CELL COUNT'] },
  { canonical: 'RBC', discipline: 'haematology', aliases: ['R B C', 'RED BLOOD CELL', 'RED BLOOD CELLS', 'RED CELL COUNT', 'ERYTHROCYTES'] },
  { canonical: 'HGB', discipline: 'haematology', aliases: ['HB', 'HGB', 'HBG', 'HAEMOGLOBIN', 'HEMOGLOBIN', 'HAEMOGLOBIN CONCENTRATION'] },
  { canonical: 'HCT', discipline: 'haematology', aliases: ['PCV', 'HAEMATOCRIT', 'HEMATOCRIT', 'PACKED CELL VOLUME'] },
  { canonical: 'MCV', discipline: 'haematology', aliases: ['MEAN CELL VOLUME', 'MEAN CORPUSCULAR VOLUME'] },
  { canonical: 'MCH', discipline: 'haematology', aliases: ['MEAN CELL HAEMOGLOBIN', 'MEAN CORPUSCULAR HAEMOGLOBIN', 'MEAN CORPUSCULAR HEMOGLOBIN'] },
  { canonical: 'MCHC', discipline: 'haematology', aliases: ['MEAN CELL HAEMOGLOBIN CONCENTRATION', 'MEAN CORPUSCULAR HAEMOGLOBIN CONCENTRATION'] },
  { canonical: 'RDW-SD', discipline: 'haematology', aliases: ['RDW SD', 'RDWSD', 'RED CELL DISTRIBUTION WIDTH SD'] },
  { canonical: 'RDW-CV', discipline: 'haematology', aliases: ['RDW CV', 'RDWCV', 'RDW', 'RED CELL DISTRIBUTION WIDTH', 'RED CELL DISTRIBUTION WIDTH CV'] },
  { canonical: 'PDW', discipline: 'haematology', aliases: ['PLATELET DISTRIBUTION WIDTH'] },
  { canonical: 'MPV', discipline: 'haematology', aliases: ['MEAN PLATELET VOLUME'] },
  { canonical: 'P-LCR', discipline: 'haematology', aliases: ['P LCR', 'PLCR', 'PLATELET LARGE CELL RATIO', 'LARGE PLATELET RATIO'] },
  { canonical: 'PCT', discipline: 'haematology', aliases: ['PLATELETCRIT', 'PLATELET CRIT'] },
  { canonical: 'NEUT#', discipline: 'haematology', aliases: ['NE ABS', 'NEUT ABS', 'NEUTROPHIL ABS', 'NEUTROPHILS ABS', 'ABSOLUTE NEUTROPHIL COUNT', 'ANC', 'NEUTROPHIL COUNT'] },
  { canonical: 'LYMPH#', discipline: 'haematology', aliases: ['LY ABS', 'LYMPH ABS', 'LYMPHOCYTE ABS', 'LYMPHOCYTES ABS', 'ABSOLUTE LYMPHOCYTE COUNT', 'LYMPHOCYTE COUNT'] },
  { canonical: 'MONO#', discipline: 'haematology', aliases: ['MO ABS', 'MONO ABS', 'MONOCYTE ABS', 'MONOCYTES ABS', 'ABSOLUTE MONOCYTE COUNT', 'MONOCYTE COUNT'] },
  { canonical: 'EO#', discipline: 'haematology', aliases: ['EO ABS', 'EOS ABS', 'EOSINOPHIL ABS', 'EOSINOPHILS ABS', 'ABSOLUTE EOSINOPHIL COUNT', 'EOSINOPHIL COUNT'] },
  { canonical: 'BASO#', discipline: 'haematology', aliases: ['BA ABS', 'BASO ABS', 'BASOPHIL ABS', 'BASOPHILS ABS', 'ABSOLUTE BASOPHIL COUNT', 'BASOPHIL COUNT'] },
  { canonical: 'NEUT%', discipline: 'haematology', aliases: ['NE PCT', 'NEUT PCT', 'NEUTROPHIL PCT', 'NEUTROPHILS PCT', 'NEUTROPHILS'] },
  { canonical: 'LYMPH%', discipline: 'haematology', aliases: ['LY PCT', 'LYMPH PCT', 'LYMPHOCYTE PCT', 'LYMPHOCYTES PCT', 'LYMPHOCYTES'] },
  { canonical: 'MONO%', discipline: 'haematology', aliases: ['MO PCT', 'MONO PCT', 'MONOCYTE PCT', 'MONOCYTES PCT', 'MONOCYTES'] },
  { canonical: 'EO%', discipline: 'haematology', aliases: ['EO PCT', 'EOS PCT', 'EOSINOPHIL PCT', 'EOSINOPHILS PCT', 'EOSINOPHILS'] },
  { canonical: 'BASO%', discipline: 'haematology', aliases: ['BA PCT', 'BASO PCT', 'BASOPHIL PCT', 'BASOPHILS PCT', 'BASOPHILS'] },
  { canonical: 'IG#', discipline: 'haematology', aliases: ['IG ABS', 'IMMATURE GRANULOCYTE ABS', 'IMMATURE GRANULOCYTES ABS'] },
  { canonical: 'IG%', discipline: 'haematology', aliases: ['IG PCT', 'IMMATURE GRANULOCYTE PCT', 'IMMATURE GRANULOCYTES PCT'] },
  { canonical: 'RET#', discipline: 'haematology', aliases: ['RET ABS', 'RETIC ABS', 'RETICULOCYTE ABS', 'RETICULOCYTES ABS', 'ABSOLUTE RETICULOCYTE COUNT'] },
  { canonical: 'RET%', discipline: 'haematology', aliases: ['RET PCT', 'RETIC PCT', 'RETICULOCYTE PCT', 'RETICULOCYTES PCT'] },
  { canonical: 'IRF', discipline: 'haematology', aliases: ['IMMATURE RETICULOCYTE FRACTION'] },
  { canonical: 'LFR', discipline: 'haematology', aliases: ['LOW FLUORESCENCE RATIO', 'LOW FLUORESCENCE RETICULOCYTE'] },
  { canonical: 'MFR', discipline: 'haematology', aliases: ['MEDIUM FLUORESCENCE RATIO', 'MIDDLE FLUORESCENCE RATIO'] },
  { canonical: 'HFR', discipline: 'haematology', aliases: ['HIGH FLUORESCENCE RATIO'] },
  { canonical: 'RET-HE', discipline: 'haematology', aliases: ['RET HE', 'RETHE', 'RETICULOCYTE HAEMOGLOBIN EQUIVALENT', 'RETICULOCYTE HEMOGLOBIN'] },
  { canonical: 'PLT', discipline: 'haematology', aliases: ['PLATELET', 'PLATELETS', 'PLATELET COUNT', 'PLT I', 'PLT F', 'PLT O'] },
  { canonical: 'NRBC#', discipline: 'haematology', aliases: ['NRBC ABS', 'NUCLEATED RED BLOOD CELL ABS', 'NUCLEATED RBC ABS'] },
  { canonical: 'NRBC%', discipline: 'haematology', aliases: ['NRBC PCT', 'NUCLEATED RED BLOOD CELL PCT', 'NUCLEATED RBC PCT'] },
  { canonical: 'ESR', discipline: 'haematology', aliases: ['ERYTHROCYTE SEDIMENTATION RATE', 'SED RATE'] },

  /* ---- Chemistry, as the laboratory's analysers and LHIMS name it ------- */
  { canonical: 'UREA', discipline: 'chemistry', aliases: ['BUN', 'BLOOD UREA', 'BLOOD UREA NITROGEN', 'UREA NITROGEN', 'SERUM UREA'] },
  { canonical: 'CREATININE', discipline: 'chemistry', aliases: ['CREA', 'CRE', 'CREAT', 'SERUM CREATININE'] },
  { canonical: 'SODIUM', discipline: 'chemistry', aliases: ['NA', 'NA+', 'SERUM SODIUM'] },
  { canonical: 'POTASSIUM', discipline: 'chemistry', aliases: ['K', 'K+', 'SERUM POTASSIUM'] },
  { canonical: 'CHLORIDE', discipline: 'chemistry', aliases: ['CL', 'CL-', 'SERUM CHLORIDE'] },
  { canonical: 'CALCIUM', discipline: 'chemistry', aliases: ['CA', 'TOTAL CALCIUM', 'SERUM CALCIUM'] },
  { canonical: 'IONIZED CALCIUM', discipline: 'chemistry', aliases: ['ICA', 'IONISED CALCIUM', 'CA ION', 'FREE CALCIUM'] },
  { canonical: 'MAGNESIUM', discipline: 'chemistry', aliases: ['MG', 'SERUM MAGNESIUM'] },
  { canonical: 'PHOSPHATE', discipline: 'chemistry', aliases: ['PHOS', 'PO4', 'INORGANIC PHOSPHATE', 'PHOSPHORUS'] },
  { canonical: 'BICARBONATE', discipline: 'chemistry', aliases: ['HCO3', 'TCO2', 'CO2', 'TOTAL CO2'] },
  { canonical: 'PH', discipline: 'chemistry', aliases: ['P H'] },
  { canonical: 'ALBUMIN', discipline: 'chemistry', aliases: ['ALB', 'SERUM ALBUMIN'] },
  { canonical: 'TOTAL PROTEIN', discipline: 'chemistry', aliases: ['TP', 'PROT', 'TPROT', 'T PROTEIN', 'SERUM TOTAL PROTEIN'] },
  { canonical: 'GLOBULIN', discipline: 'chemistry', aliases: ['GLOB'] },
  { canonical: 'ALT', discipline: 'chemistry', aliases: ['SGPT', 'GPT', 'ALANINE AMINOTRANSFERASE', 'ALANINE TRANSAMINASE'] },
  { canonical: 'AST', discipline: 'chemistry', aliases: ['SGOT', 'GOT', 'ASPARTATE AMINOTRANSFERASE', 'ASPARTATE TRANSAMINASE'] },
  { canonical: 'GGT', discipline: 'chemistry', aliases: ['GAMMA GT', 'GAMMA GLUTAMYLTRANSFERASE', 'GAMMA GLUTAMYL TRANSFERASE', 'GAMMA GLUTAMYL TRANSPEPTIDASE'] },
  { canonical: 'ALP', discipline: 'chemistry', aliases: ['ALK PHOS', 'ALKALINE PHOSPHATASE'] },
  { canonical: 'TOTAL BILIRUBIN', discipline: 'chemistry', aliases: ['TBIL', 'T BIL', 'TBILI', 'BILIRUBIN TOTAL', 'BIL T'] },
  { canonical: 'DIRECT BILIRUBIN', discipline: 'chemistry', aliases: ['DBIL', 'D BIL', 'DBILI', 'BILIRUBIN DIRECT', 'CONJUGATED BILIRUBIN', 'BIL D'] },
  { canonical: 'INDIRECT BILIRUBIN', discipline: 'chemistry', aliases: ['IBIL', 'I BIL', 'IBILI', 'BILIRUBIN INDIRECT', 'UNCONJUGATED BILIRUBIN'] },
  { canonical: 'GLUCOSE', discipline: 'chemistry', aliases: ['GLU', 'BLOOD SUGAR', 'FBS', 'RBS', 'FASTING BLOOD SUGAR', 'RANDOM BLOOD SUGAR', 'BLOOD GLUCOSE'] },
  { canonical: 'URIC ACID', discipline: 'chemistry', aliases: ['UA', 'URATE', 'SERUM URIC ACID'] },
  { canonical: 'TOTAL CHOLESTEROL', discipline: 'chemistry', aliases: ['CHOL', 'TC', 'CHOLESTEROL', 'SERUM CHOLESTEROL'] },
  { canonical: 'TRIGLYCERIDES', discipline: 'chemistry', aliases: ['TRIG', 'TG', 'TRIGLYCERIDE'] },
  { canonical: 'HDL', discipline: 'chemistry', aliases: ['HDL C', 'HDL CHOLESTEROL', 'HIGH DENSITY LIPOPROTEIN'] },
  { canonical: 'LDL', discipline: 'chemistry', aliases: ['LDL C', 'LDL CHOLESTEROL', 'LOW DENSITY LIPOPROTEIN'] },
  { canonical: 'VLDL', discipline: 'chemistry', aliases: ['VLDL C', 'VERY LOW DENSITY LIPOPROTEIN'] },
  { canonical: 'AMYLASE', discipline: 'chemistry', aliases: ['AMY', 'SERUM AMYLASE'] },
  { canonical: 'LIPASE', discipline: 'chemistry', aliases: ['LIP'] },
  { canonical: 'LDH', discipline: 'chemistry', aliases: ['LACTATE DEHYDROGENASE'] },
  { canonical: 'CK', discipline: 'chemistry', aliases: ['CPK', 'CREATINE KINASE'] },
  { canonical: 'CK-MB', discipline: 'chemistry', aliases: ['CKMB', 'CK MB', 'CREATINE KINASE MB'] },
  { canonical: 'EGFR', discipline: 'chemistry', aliases: ['E GFR', 'ESTIMATED GFR', 'GFR'] },
];

/** alias key → canonical, built once. */
const ALIAS_INDEX: Map<string, string> = (() => {
  const index = new Map<string, string>();
  for (const entry of ANALYTE_DICTIONARY) {
    index.set(analyteKey(entry.canonical), entry.canonical);
    for (const alias of entry.aliases) {
      const key = analyteKey(alias);
      // First definition wins, so an alias listed under two parameters never
      // silently changes meaning when the dictionary is extended.
      if (!index.has(key)) index.set(key, entry.canonical);
    }
  }
  return index;
})();

export const DISCIPLINE_OF: Map<string, string> = new Map(
  ANALYTE_DICTIONARY.map(entry => [entry.canonical, entry.discipline]),
);

/**
 * What this system calls the parameter, given anything anyone calls it.
 *
 * Extra aliases a laboratory has added are passed in rather than compiled in,
 * so a site that labels haemoglobin "HB CONC" teaches the filler once and never
 * waits for a release.
 */
export function canonicalAnalyte(raw: unknown, extra?: Map<string, string> | null): string | null {
  for (const candidate of labelCandidates(raw)) {
    const key = analyteKey(candidate);
    if (!key) continue;
    const added = extra?.get(key);
    if (added) return added;
    const known = ALIAS_INDEX.get(key);
    if (known) return known;
  }
  return null;
}

/* ============================================================================
   Scoring a match
   ----------------------------------------------------------------------------
   A number, not a yes, because the difference between "these are certainly the
   same parameter" and "these look a bit alike" has to be visible to the person
   deciding whether to press the button.
   ========================================================================= */
export const MATCH_CERTAIN = 100;
/** At or above this, a field is filled without asking. */
export const MATCH_FILL_THRESHOLD = 80;
/** Below this, the pair is not even offered as a suggestion. */
export const MATCH_SUGGEST_THRESHOLD = 55;

export interface MatchOutcome {
  score: number;
  /** How the two were judged the same, in words, for the record. */
  how: string;
}

function tokens(value: string): string[] {
  return analyteKey(value).split(' ').filter(Boolean);
}

/** Jaccard overlap, which handles word order and extra words sensibly. */
function overlap(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let shared = 0;
  for (const token of setA) if (setB.has(token)) shared++;
  return shared / (setA.size + setB.size - shared);
}

/**
 * Is the analyser's parameter the same as this field on the form?
 *
 * The order of these tests is the order of how sure they make us. Anything
 * resting on resemblance alone lands below the fill threshold and is reported
 * as a suggestion rather than typed into a patient's record.
 */
export function matchAnalyte(analyserCode: unknown, analyserName: unknown, fieldLabel: unknown, extra?: Map<string, string> | null): MatchOutcome {
  const fieldCanonical = canonicalAnalyte(fieldLabel, extra);
  const sourceCanonical = canonicalAnalyte(analyserCode, extra) ?? canonicalAnalyte(analyserName, extra);

  if (fieldCanonical && sourceCanonical && fieldCanonical === sourceCanonical) {
    return { score: MATCH_CERTAIN, how: `both are ${fieldCanonical}` };
  }
  // One side known, the other spelled the same way: still certain.
  const fieldKeys = labelCandidates(fieldLabel).map(analyteKey).filter(Boolean);
  const sourceKeys = [...labelCandidates(analyserCode), ...labelCandidates(analyserName)].map(analyteKey).filter(Boolean);
  if (fieldKeys.some(key => sourceKeys.includes(key))) {
    return { score: 96, how: 'the form and the analyser use the same name' };
  }
  // A known parameter on one side can only match an unknown name on the other
  // by resemblance, and resemblance is never certainty.
  if (fieldCanonical && sourceCanonical && fieldCanonical !== sourceCanonical) {
    return { score: 0, how: `the form asks for ${fieldCanonical} and the analyser sent ${sourceCanonical}` };
  }

  let best = { score: 0, how: 'no resemblance' };
  for (const fieldKey of fieldKeys) {
    for (const sourceKey of sourceKeys) {
      const fieldTokens = fieldKey.split(' ');
      const sourceTokens = sourceKey.split(' ');
      // An absolute count and a percentage are never the same parameter,
      // whatever else the names share.
      const fieldQualifier = fieldTokens.includes('ABS') ? 'ABS' : fieldTokens.includes('PCT') ? 'PCT' : '';
      const sourceQualifier = sourceTokens.includes('ABS') ? 'ABS' : sourceTokens.includes('PCT') ? 'PCT' : '';
      if (fieldQualifier !== sourceQualifier) continue;

      const shared = overlap(fieldTokens, sourceTokens);
      if (shared >= 0.75) {
        const score = Math.round(70 + shared * 20);
        if (score > best.score) best = { score, how: `the names agree on ${Math.round(shared * 100)}% of their words` };
        continue;
      }
      // One name contained whole inside the other, e.g. SODIUM in SERUM SODIUM.
      const longer = fieldKey.length >= sourceKey.length ? fieldKey : sourceKey;
      const shorter = fieldKey.length >= sourceKey.length ? sourceKey : fieldKey;
      if (shorter.length >= 3 && new RegExp(`\\b${shorter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(longer)) {
        const ratio = shorter.length / longer.length;
        const score = Math.round(55 + ratio * 20);
        if (score > best.score) best = { score, how: `${shorter} appears in ${longer}` };
        continue;
      }
      if (shared > 0) {
        const score = Math.round(shared * 60);
        if (score > best.score) best = { score, how: `the names share some words` };
      }
    }
  }
  return best;
}

/* ============================================================================
   Identifiers
   ----------------------------------------------------------------------------
   What a laboratory information system calls the number that identifies a
   sample, and what that number tends to look like when nothing calls it
   anything at all.
   ========================================================================= */
export interface IdentifierLabelRule {
  kind: 'sample' | 'patient' | 'request' | 'other';
  /** Matched against a cleaned, uppercased label. */
  patterns: RegExp[];
  /** Higher wins when a page offers several. */
  weight: number;
}

export const IDENTIFIER_LABEL_RULES: IdentifierLabelRule[] = [
  // The sample's own number. A barcode and a sample identifier are the same
  // thing wearing different words, which is why they share a kind.
  { kind: 'sample', weight: 100, patterns: [/^SAMPLE\s*BAR\s*CODE$/, /^BAR\s*CODE$/, /^SAMPLE\s*(ID|NO|NUMBER|CODE)$/, /^SPECIMEN\s*(ID|NO|NUMBER|BAR\s*CODE)?$/] },
  { kind: 'sample', weight: 92, patterns: [/^LAB(ORATORY)?\s*(NO|NUMBER|ID)$/, /^ACCESSION\s*(NO|NUMBER|ID)?$/, /^SPECIMEN$/, /^SAMPLE$/] },
  { kind: 'request', weight: 70, patterns: [/^REQUEST\s*(NO|NUMBER|ID)$/, /^ORDER\s*(NO|NUMBER|ID)$/, /^VISIT\s*(NO|NUMBER|ID)$/, /^CONSULTATION\s*(NO|NUMBER|ID)$/] },
  // The patient. Corroboration only — never what a result is filed against.
  { kind: 'patient', weight: 60, patterns: [/^PATIENT\s*(ID|NO|NUMBER|CODE)$/, /^FOLDER\s*(NO|NUMBER|ID)?$/, /^MRN$/, /^HOSPITAL\s*(NO|NUMBER|ID)$/, /^MR\s*(NO|NUMBER)$/, /^OPD\s*(NO|NUMBER)$/] },
  { kind: 'patient', weight: 45, patterns: [/^NHI[AS]?\s*(NO|NUMBER)?$/, /^(HEALTH\s*)?INSURANCE\s*(NO|NUMBER)$/, /^MOH\s*(NO|NUMBER)$/, /^NATIONAL\s*ID$/] },
];

/** What kind of identifier a label names, if any. */
export function identifierKindOf(label: unknown): { kind: IdentifierLabelRule['kind']; weight: number } | null {
  const clean = cleanLabel(label).toUpperCase().replace(/[. ]/g, '').replace(/\s+/g, ' ').trim();
  if (!clean || clean.length > 40) return null;
  for (const rule of IDENTIFIER_LABEL_RULES) {
    for (const pattern of rule.patterns) {
      if (pattern.test(clean)) return { kind: rule.kind, weight: rule.weight };
    }
  }
  return null;
}

/**
 * Values that identify a sample even where nothing labels them.
 *
 * Used only as a last resort and always reported as a guess: a page full of
 * numbers has many that look like this and are not it.
 */
export const IDENTIFIER_SHAPES: Array<{ kind: 'sample' | 'patient'; weight: number; shape: RegExp; description: string }> = [
  // A folder number is distinctive enough to outrank a caption: `UW-A11-AAB2287`
  // is one thing and one thing only, while a label reading "Insurance Number"
  // sits above a number that identifies a policy rather than a person.
  { kind: 'patient', weight: 58, shape: /^[A-Z]{2}-[A-Z]\d{2}-[A-Z]{2,4}\d{3,6}$/, description: 'a folder number' },
  { kind: 'sample', weight: 40, shape: /^\d{8,14}$/, description: 'a long unbroken number, the usual shape of a sample barcode' },
  { kind: 'sample', weight: 30, shape: /^[A-Z]{1,4}[-/]?\d{6,12}$/, description: 'a prefixed sample number' },
];

/** Is this text plausibly an identifier rather than a date, a price or a count? */
export function looksLikeIdentifier(value: unknown): { kind: 'sample' | 'patient'; weight: number; description: string } | null {
  const text = String(value ?? '').trim().toUpperCase();
  if (!text || text.length < 5 || text.length > 32) return null;
  // Dates and times are the commonest false positive on a result form.
  if (/^\d{1,2}[-/ ]\d{1,2}[-/ ]\d{2,4}$/.test(text)) return null;
  if (/^\d{4}[-/]\d{2}[-/]\d{2}/.test(text)) return null;
  if (/^(NA|N\/A|NIL|NONE|-)$/.test(text)) return null;
  for (const shape of IDENTIFIER_SHAPES) {
    if (shape.shape.test(text)) return { kind: shape.kind, weight: shape.weight, description: shape.description };
  }
  return null;
}

/* ============================================================================
   What the scanner hands back
   ========================================================================= */
export interface DetectedIdentifier {
  kind: 'sample' | 'patient' | 'request' | 'other';
  /** The words on the page that named it, or how it was recognised without one. */
  label: string;
  value: string;
  /** 'label' | 'header' | 'input' | 'shape' — how it was found. */
  source: string;
  confidence: number;
}

export interface DetectedField {
  /** The scanner's handle on the control, meaningless outside the page. */
  index: number;
  label: string;
  unit: string | null;
  referenceText: string | null;
  /** What is already in the box. */
  current: string;
  kind: 'text' | 'select';
}

export interface FieldAssignment {
  index: number;
  sourceCode: string;
  analyte: string;
  fieldLabel: string;
  value: string;
  receivedValue: string;
  unit: string | null;
  flag: string | null;
  score: number;
  how: string;
  note: string | null;
}

/**
 * Match what the analyser sent against what the form asks for.
 *
 * One reading fills at most one field and one field takes at most one reading:
 * the best pairs are taken first, so a close-but-not-best match cannot steal a
 * box from the reading that belongs in it.
 */
export function assignReadings(
  readings: Array<{ code: string; analyte: string; value: string; unit: string | null; flag: string | null }>,
  fields: DetectedField[],
  options?: { extraAliases?: Map<string, string> | null; threshold?: number },
): { assignments: FieldAssignment[]; unmatchedReadings: typeof readings; unmatchedFields: DetectedField[]; suggestions: FieldAssignment[] } {
  const threshold = options?.threshold ?? MATCH_FILL_THRESHOLD;
  const extra = options?.extraAliases ?? null;

  const scored: FieldAssignment[] = [];
  for (const reading of readings) {
    if (!String(reading.value ?? '').trim()) continue;
    for (const field of fields) {
      const outcome = matchAnalyte(reading.code, reading.analyte, field.label, extra);
      if (outcome.score < MATCH_SUGGEST_THRESHOLD) continue;
      scored.push({
        index: field.index,
        sourceCode: reading.code,
        analyte: reading.analyte || reading.code,
        fieldLabel: field.label,
        value: String(reading.value).trim(),
        receivedValue: String(reading.value).trim(),
        unit: reading.unit,
        flag: reading.flag,
        score: outcome.score,
        how: outcome.how,
        note: null,
      });
    }
  }

  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  const takenFields = new Set<number>();
  const takenReadings = new Set<string>();
  const assignments: FieldAssignment[] = [];
  const suggestions: FieldAssignment[] = [];

  for (const candidate of scored) {
    if (takenFields.has(candidate.index) || takenReadings.has(candidate.sourceCode)) continue;
    if (candidate.score >= threshold) {
      assignments.push(candidate);
      takenFields.add(candidate.index);
      takenReadings.add(candidate.sourceCode);
    } else {
      suggestions.push(candidate);
    }
  }

  return {
    assignments,
    unmatchedReadings: readings.filter(r => !takenReadings.has(r.code) && String(r.value ?? '').trim()),
    unmatchedFields: fields.filter(f => !takenFields.has(f.index)),
    suggestions: suggestions.filter(s => !takenFields.has(s.index) && !takenReadings.has(s.sourceCode)),
  };
}
