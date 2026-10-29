/**
 * What a parameter is, and what form it is in.
 *
 * A differential sends each cell line twice — NEUT# is a count, NEUT% is a
 * proportion — and they are different numbers, in different units, against
 * different limits. Anything that matches one analyser's word for a parameter
 * against somebody else's word for it has to keep that distinction, because
 * dropping a percentage into a count is not a near miss: it is a wrong result
 * in a patient's or a control's record, and it looks exactly like a real one.
 *
 * This is the one place that decides it, so that a control screen, a
 * verification study and a critical-result rule cannot come to three different
 * conclusions about the same word.
 */
import { analyteKey } from './formIntelligence.js';

/** A count, a percentage, or a name that does not say which. */
export type AnalyteForm = 'abs' | 'pct' | 'plain';

export interface AnalyteIdentity {
  /** The parameter, with synonyms resolved and the form set aside: "neutrophils". */
  base: string;
  /** The word as written, with the form set aside and no synonym applied: "neut". */
  flat: string;
  form: AnalyteForm;
  /** The two together, which is what equality means. */
  key: string;
}

/**
 * The names one parameter goes by.
 *
 * Deliberately short. A synonym that is nearly right is worse than none, so
 * this holds only the spellings a laboratory actually writes.
 */
export const ANALYTE_SYNONYMS: Record<string, string[]> = {
  haemoglobin: ['hgb', 'hb', 'hemoglobin', 'haemoglobin'],
  haematocrit: ['hct', 'pcv', 'hematocrit', 'haematocrit'],
  wbc: ['wbc', 'leucocytes', 'leukocytes', 'whitecellcount', 'totalwbc'],
  rbc: ['rbc', 'erythrocytes', 'redcellcount'],
  platelets: ['plt', 'platelets', 'plateletcount'],
  neutrophils: ['neut', 'ne', 'neutrophils', 'neu'],
  lymphocytes: ['lymph', 'ly', 'lymphocytes', 'lym'],
  monocytes: ['mono', 'mo', 'monocytes'],
  eosinophils: ['eos', 'eo', 'eosinophils'],
  basophils: ['baso', 'ba', 'basophils'],
  glucose: ['glu', 'gluc', 'glucose'],
  urea: ['urea', 'bun'],
  creatinine: ['crea', 'creat', 'creatinine'],
  sodium: ['na', 'sodium'],
  potassium: ['k', 'potassium'],
  chloride: ['cl', 'chloride'],
  calcium: ['ca', 'calcium'],
  albumin: ['alb', 'albumin'],
  bilirubin: ['tbil', 'bili', 'bilirubin', 'totalbilirubin'],
  alt: ['alt', 'sgpt', 'alanineaminotransferase'],
  ast: ['ast', 'sgot', 'aspartateaminotransferase'],
  alp: ['alp', 'alkalinephosphatase'],
};

/** A name with case, spacing and punctuation set aside. */
export function flattenAnalyte(value: unknown): string {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function analyteSynonymGroup(name: string): string | null {
  const key = flattenAnalyte(name);
  for (const [group, members] of Object.entries(ANALYTE_SYNONYMS)) {
    if (members.includes(key) || flattenAnalyte(group) === key) return group;
  }
  return null;
}

const identities = new Map<string, AnalyteIdentity>();

/**
 * Read a label as "which parameter, in which form".
 *
 * The form markers come from the same place the result filler reads them, so
 * the two halves of the system cannot come to disagree about what a "#" means:
 * analyteKey turns "#" into ABS and "%" into PCT, and expands the words
 * ABSOLUTE and PERCENTAGE to match.
 */
export function identifyAnalyte(value: unknown): AnalyteIdentity {
  const raw = String(value ?? '');
  const cached = identities.get(raw);
  if (cached) return cached;

  let form: AnalyteForm = 'plain';
  const words: string[] = [];
  for (const token of analyteKey(raw).split(' ')) {
    if (!token) continue;
    if (token === 'ABS') { form = 'abs'; continue; }
    if (token === 'PCT') { form = 'pct'; continue; }
    words.push(token);
  }
  const flat = words.join('').toLowerCase();
  const base = analyteSynonymGroup(flat) ?? flat;
  const identity: AnalyteIdentity = { base, flat, form, key: `${base}:${form}` };
  if (identities.size < 4_000) identities.set(raw, identity);
  return identity;
}

/**
 * What a unit says about the form of the parameter it belongs to.
 *
 * A parameter named only "Neutrophils" still declares itself: a percent sign
 * means a proportion, and 10^3/uL means a count. It is the one piece of
 * evidence available when the name does not say, and it beats the order the
 * analyser happened to send things in.
 */
export function formOfUnit(unit: unknown): AnalyteForm {
  const text = String(unit ?? '').trim();
  if (!text) return 'plain';
  if (/%|percent/i.test(text)) return 'pct';
  return 'abs';
}

/**
 * May a reading labelled one way fill a field labelled another?
 *
 * Only where the two agree about the form, or where one of them does not say
 * and nothing contradicts it. A count never fills a percentage.
 */
export function formsAgree(a: AnalyteForm, b: AnalyteForm): boolean {
  return a === b || a === 'plain' || b === 'plain';
}
