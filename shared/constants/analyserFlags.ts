/**
 * What an analyser sends that is not a result.
 *
 * ----------------------------------------------------------------------------
 * Why this exists
 * ----------------------------------------------------------------------------
 * A haematology analyser transmits three different kinds of thing down one
 * channel, and until now the report printed all three as though they were the
 * same kind.
 *
 *   A MEASUREMENT. Haemoglobin 13.6 g/dL. A number, a unit, a reference range,
 *   and a flag if it falls outside one. This is what a report is for.
 *
 *   AN INTERPRETIVE MESSAGE — Sysmex calls them IP messages. "Blasts/Abn
 *   Lympho?", "Anemia", "PLT Clumps?". The analyser is not measuring anything;
 *   it is saying what it suspects about the sample, and the number beside it is
 *   a confidence level on the instrument's own scale, not a concentration.
 *   Printed as a parameter it reads as a result — "Iron_Deficiency? 80" sits in
 *   a column headed RESULT with a reference range beside it, and a patient or
 *   a clinician has every reason to read 80 as a measured quantity. It is not.
 *
 *   A PICTURE. SCAT_WDF, DIST_RBC. The scattergrams and histograms. These are
 *   channel names for graphics, and they arrive with no value at all, which is
 *   why the report showed a row of dashes under RESULT for each one.
 *
 * This module tells them apart, so each can be put where it belongs.
 *
 * ----------------------------------------------------------------------------
 * How it decides
 * ----------------------------------------------------------------------------
 * By the code itself, not by whether a value happens to be missing — a
 * haemoglobin that failed to transmit is still a haemoglobin, and must not be
 * quietly reclassified as a picture because this one message lacks it.
 *
 * The named lists come from the Sysmex XN series' own interpretive programme.
 * The patterns catch the rest: a code ending in "?" is a question the analyser
 * is asking, which is what an IP message is, and SCAT_/DIST_ name a graphic.
 * Being wrong in the safe direction matters here, so anything unrecognised
 * stays a measurement and is printed as one.
 */

export type ReadingKind = 'measurement' | 'message' | 'graphic';

/** Which part of the count a message is about, as the printout groups them. */
export type MessageGroup = 'wbc' | 'rbc' | 'plt' | 'other';

export const MESSAGE_GROUP_LABELS: Record<MessageGroup, string> = {
  wbc: 'WBC',
  rbc: 'RBC',
  plt: 'PLT',
  other: 'Other',
};

/** Compare codes without being defeated by spacing, case or punctuation. */
function squash(code: unknown): string {
  return String(code ?? '').toUpperCase().replace(/[^A-Z0-9?]/g, '');
}

/*
 * The Sysmex XN interpretive messages, by the part of the count they concern.
 *
 * Both spellings of each are covered by `squash`, so "Blasts/Abn_Lympho?" and
 * "Blasts/Abn Lympho?" are one entry rather than two.
 */
const WBC_MESSAGES = [
  'Blasts/Abn_Lympho?', 'Blasts?', 'Abn_Lympho?', 'Left_Shift?', 'Atypical_Lympho?',
  'Immature_Gran?', 'NRBC?', 'WBC_Abn_Scattergram', 'Monocytosis?',
  'Leukocytopenia', 'Leukocytosis', 'Neutropenia', 'Neutrophilia',
  'Lymphopenia', 'Lymphocytosis', 'Monocytosis', 'Eosinophilia', 'Basophilia',
  'NRBC_Present', 'IG_Present', 'WBC_Abn_Scattergram?',
];

const RBC_MESSAGES = [
  'RBC_Agglutination?', 'Turbidity/HGB_Interference?', 'Iron_Deficiency?',
  'HGB_Defect?', 'Fragments?', 'IRBC?', 'Dimorphic_Population?',
  'Anisocytosis', 'Microcytosis', 'Macrocytosis', 'Hypochromia',
  'Anemia', 'Anaemia', 'Erythrocytosis', 'RET_Abn_Scattergram', 'RBC_Abn_Distribution',
];

const PLT_MESSAGES = [
  'PLT_Clumps?', 'PLT_Abn_Distribution', 'PLT_Abn_Scattergram',
  'Thrombocytopenia', 'Thrombocytosis', 'Giant_PLT?',
];

const GROUPED: Array<[MessageGroup, string[]]> = [
  ['wbc', WBC_MESSAGES], ['rbc', RBC_MESSAGES], ['plt', PLT_MESSAGES],
];

const MESSAGE_GROUP = new Map<string, MessageGroup>();
for (const [group, codes] of GROUPED) {
  for (const code of codes) MESSAGE_GROUP.set(squash(code), group);
}

/**
 * A code that names a picture rather than a quantity.
 *
 * SCAT_ is a scattergram and DIST_ a distribution curve on every Sysmex this
 * laboratory runs. They are listed as prefixes because the channel names grow
 * with each analyser generation — WDF, WNR, WPC, RET, PLT-F — and a laboratory
 * should not have to wait for a release to stop printing a new one as a result.
 */
const GRAPHIC_PREFIXES = ['SCAT', 'DIST', 'HISTOGRAM', 'SCATTERGRAM'];

/** The graphics a Sysmex XN names, so a report can lay them out in order. */
export const KNOWN_GRAPHICS = [
  'SCAT_WDF', 'SCAT_WDF-CBC', 'SCAT_WNR', 'SCAT_WPC', 'SCAT_RET', 'SCAT_PLT-F',
  'DIST_RBC', 'DIST_PLT', 'DIST_WBC',
];

/**
 * What kind of thing is this code?
 *
 * The answer is about the CODE and nothing else. Deliberately not consulted:
 * whether this particular message carried a value, which says only what
 * happened to arrive, and the unit, which an IP message does not have but
 * neither does a ratio.
 */
export function readingKind(code: unknown, analyte?: unknown): ReadingKind {
  const raw = String(code ?? '').trim();
  const name = String(analyte ?? '').trim();
  if (!raw && !name) return 'measurement';

  for (const candidate of [raw, name]) {
    if (!candidate) continue;
    const flat = squash(candidate);
    if (!flat) continue;
    if (MESSAGE_GROUP.has(flat)) return 'message';
    if (GRAPHIC_PREFIXES.some(prefix => flat.startsWith(prefix))) return 'graphic';
    /*
     * A trailing question mark is the analyser asking rather than reporting.
     * Every IP message that is a suspicion carries one, and no measurement
     * does — there is no such thing as a haemoglobin with a question mark.
     */
    if (candidate.trim().endsWith('?')) return 'message';
  }
  return 'measurement';
}

/** Which block of the printout a message belongs under. */
export function messageGroup(code: unknown, analyte?: unknown): MessageGroup {
  for (const candidate of [code, analyte]) {
    const found = MESSAGE_GROUP.get(squash(candidate));
    if (found) return found;
  }
  // An unrecognised message is placed by what it mentions rather than dropped
  // into "Other", which is a heading that tells a reader nothing.
  const text = `${String(code ?? '')} ${String(analyte ?? '')}`.toUpperCase();
  if (/\b(WBC|LYMPH|NEUT|BLAST|GRAN|MONO|EOS|BASO|NRBC)/.test(text)) return 'wbc';
  if (/\b(RBC|HGB|HB|RET|ANEM|ANAEM|IRON|FRAGMENT)/.test(text)) return 'rbc';
  if (/\b(PLT|PLATELET|THROMBO)/.test(text)) return 'plt';
  return 'other';
}

/**
 * The message as a person should read it.
 *
 * Transmitted codes are written for a parser — "Blasts/Abn_Lympho?" — and the
 * printout a laboratory is used to reads "Blasts/Abn Lympho?". The underscores
 * become spaces and nothing else changes: the wording is the manufacturer's and
 * is not ours to improve on.
 */
export function messageText(code: unknown, analyte?: unknown): string {
  const source = String(analyte ?? '').trim() || String(code ?? '').trim();
  return source.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Did the analyser actually raise this message, or merely list it as not found?
 *
 * The XN transmits its whole interpretive panel every time, with a confidence
 * of 0 against everything it did not suspect. Printing all of them would put
 * "PLT Clumps? 0" on a report, which reads as a finding to anybody who has not
 * been told it means the opposite. So a message counts as raised only when the
 * analyser put something other than zero against it.
 */
export function messageWasRaised(value: unknown): boolean {
  const text = String(value ?? '').trim();
  if (!text) return false;
  const number = Number(text);
  if (Number.isFinite(number)) return number > 0;
  // A worded message — "Anemia" with no number — is raised by being sent.
  return !/^(no|none|negative|n)$/i.test(text);
}
