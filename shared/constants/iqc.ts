/**
 * Internal quality control — the vocabulary, shared by the server and the bench
 * screens so a control is described the same way in both.
 *
 * Two axes decide everything about how a control behaves:
 *
 *   SOURCE       where the material came from. A commercial control arrives
 *                with an assayed target from the manufacturer; an in-house
 *                control has to carry its own provenance — who made it, from
 *                what, how it was validated — because nobody else can vouch
 *                for it (ISO 15189:2022 §7.3.7.2).
 *
 *   CONTROL TYPE what a result even IS. A full blood count control yields
 *                numbers, so it gets a mean, an SD, Westgard rules and a
 *                Levey-Jennings chart. A hepatitis B surface antigen control
 *                yields "reactive", so it gets an expected result and a
 *                straight match. Forcing the second into the shape of the
 *                first is how QC records become fiction.
 */

export const IQC_SOURCES = ['commercial', 'in_house'] as const;
export type IqcSource = (typeof IQC_SOURCES)[number];

export const IQC_SOURCE_LABELS: Record<IqcSource, string> = {
  commercial: 'Commercially prepared',
  in_house: 'In-house prepared',
};

export const IQC_SOURCE_HINTS: Record<IqcSource, string> = {
  commercial: 'Bought ready-made with an assayed or stated target value from the manufacturer.',
  in_house: 'Prepared in this laboratory. Its preparation and validation must be recorded here.',
};

export const IQC_CONTROL_TYPES = ['quantitative', 'qualitative', 'semi_quantitative', 'culture_sensitivity'] as const;
export type IqcControlType = (typeof IQC_CONTROL_TYPES)[number];

export const IQC_CONTROL_TYPE_LABELS: Record<IqcControlType, string> = {
  quantitative: 'Quantitative',
  qualitative: 'Qualitative',
  semi_quantitative: 'Semi-quantitative',
  culture_sensitivity: 'Culture & sensitivity',
};

export const IQC_CONTROL_TYPE_HINTS: Record<IqcControlType, string> = {
  quantitative: 'Measured as a number — FBC, chemistry, coagulation. Uses mean, SD, Westgard rules and a Levey-Jennings chart.',
  qualitative: 'Reported as reactive/non-reactive or positive/negative — HBsAg, HIV, malaria RDT. Passes when it matches the expected result.',
  semi_quantitative: 'Graded or titred — urinalysis, agglutination titre. Checked against an acceptable range without statistical rules.',
  culture_sensitivity: 'Microbiology culture, organism ID and antimicrobial susceptibility (AST). QC is run on a reference strain (e.g. E. coli ATCC 25922): the expected organism must be identified, and each agent must fall in its CLSI zone/MIC QC range and give the expected S/I/R category (CLSI M100/M02/M07).',
};

/**
 * Antimicrobial susceptibility interpretive categories. Reported as an ordinal
 * category, not a number, and defined by CLSI M100 (with the EUCAST reading of
 * "I" noted, since laboratories following either standard use this system).
 */
export const AST_INTERPRETATIONS = ['S', 'SDD', 'I', 'R', 'NS'] as const;
export type AstInterpretation = (typeof AST_INTERPRETATIONS)[number];

export const AST_INTERPRETATION_LABELS: Record<AstInterpretation, string> = {
  S: 'S — Susceptible',
  SDD: 'SDD — Susceptible-dose dependent',
  I: 'I — Intermediate',
  R: 'R — Resistant',
  NS: 'NS — Nonsusceptible',
};

export const AST_INTERPRETATION_HINTS: Record<AstInterpretation, string> = {
  S: 'Inhibited by the usually achievable concentration at the recommended dose (CLSI M100).',
  SDD: 'Susceptibility depends on the dosing regimen used — a higher/more frequent dose is required.',
  I: 'CLSI: intermediate. EUCAST: "susceptible, increased exposure". Also a technical buffer zone.',
  R: 'Not inhibited by the usually achievable concentration; likely treatment failure.',
  NS: 'Used where only a susceptible breakpoint exists (no resistant/intermediate isolates yet).',
};

/**
 * A culture & sensitivity control does not always do both jobs. Identification
 * and susceptibility are often run as separate exercises — one panel confirms
 * the organism, another confirms the antibiogram, and some do both on one
 * strain. The scope decides what the control asks for and what a run records.
 */
export const CS_SCOPES = ['identification', 'susceptibility', 'both'] as const;
export type CsScope = (typeof CS_SCOPES)[number];

export const CS_SCOPE_LABELS: Record<CsScope, string> = {
  identification: 'Identification only',
  susceptibility: 'Susceptibility only',
  both: 'Identification & susceptibility',
};

export const CS_SCOPE_HINTS: Record<CsScope, string> = {
  identification: 'Confirms the organism only — the reference strain must be identified as expected. No antimicrobial panel.',
  susceptibility: 'Confirms the antibiogram only — each agent must give its expected category. The organism is taken as known.',
  both: 'Confirms the organism and its susceptibilities on one reference strain.',
};

/** Whether a scope needs the organism, the agent panel, or both. */
export function csNeedsOrganism(scope?: string | null): boolean { return scope !== 'susceptibility'; }
export function csNeedsPanel(scope?: string | null): boolean { return scope !== 'identification'; }

/** How an agent's susceptibility is measured. Decides the QC range's unit. */
export const AST_METHODS = ['disk_diffusion', 'mic', 'gradient'] as const;
export type AstMethod = (typeof AST_METHODS)[number];

export const AST_METHOD_LABELS: Record<AstMethod, string> = {
  disk_diffusion: 'Disk diffusion (zone)',
  mic: 'MIC (broth/agar dilution)',
  gradient: 'Gradient strip / Etest',
};

export const AST_METHOD_UNITS: Record<AstMethod, string> = {
  disk_diffusion: 'mm',
  mic: 'µg/mL',
  gradient: 'µg/mL',
};

/** What a qualitative control is expected to produce. */
export const QUALITATIVE_OUTCOMES = ['reactive', 'non_reactive', 'positive', 'negative', 'detected', 'not_detected'] as const;
export type QualitativeOutcome = (typeof QUALITATIVE_OUTCOMES)[number];

export const QUALITATIVE_LABELS: Record<QualitativeOutcome, string> = {
  reactive: 'Reactive',
  non_reactive: 'Non-reactive',
  positive: 'Positive',
  negative: 'Negative',
  detected: 'Detected',
  not_detected: 'Not detected',
};

/**
 * Pairs offered together, so a screen never asks a serology bench to choose
 * between "positive" and "non-reactive" in the same dropdown.
 */
export const QUALITATIVE_SCALES: { key: string; label: string; outcomes: QualitativeOutcome[] }[] = [
  { key: 'reactivity', label: 'Reactive / Non-reactive', outcomes: ['reactive', 'non_reactive'] },
  { key: 'positivity', label: 'Positive / Negative', outcomes: ['positive', 'negative'] },
  { key: 'detection', label: 'Detected / Not detected', outcomes: ['detected', 'not_detected'] },
];

export function scaleForOutcome(outcome?: string | null): QualitativeOutcome[] {
  const found = QUALITATIVE_SCALES.find(s => s.outcomes.includes(outcome as QualitativeOutcome));
  return found ? found.outcomes : QUALITATIVE_SCALES[0].outcomes;
}

/** How often the control must be run. Part of the definition, not folklore. */
export const IQC_FREQUENCIES = ['each_run', 'per_shift', 'daily', 'weekly', 'per_new_lot', 'per_kit'] as const;
export type IqcFrequency = (typeof IQC_FREQUENCIES)[number];

export const IQC_FREQUENCY_LABELS: Record<IqcFrequency, string> = {
  each_run: 'Every analytical run',
  per_shift: 'Once per shift',
  daily: 'Once daily',
  weekly: 'Weekly',
  per_new_lot: 'On every new reagent lot',
  per_kit: 'On every new kit',
};

/**
 * Rule sets. The profile belongs to the material, so the bench never has to
 * remember which rules apply to which control — the system already knows.
 */
export const IQC_RULE_PROFILES = ['westgard_standard', 'westgard_simple', 'range_only', 'match_expected'] as const;
export type IqcRuleProfile = (typeof IQC_RULE_PROFILES)[number];

export const IQC_RULE_PROFILE_LABELS: Record<IqcRuleProfile, string> = {
  westgard_standard: 'Westgard multirule',
  westgard_simple: 'Westgard 1₃ₛ only',
  range_only: 'Acceptable range only',
  match_expected: 'Must match expected result',
};

export const IQC_RULE_PROFILE_HINTS: Record<IqcRuleProfile, string> = {
  westgard_standard: '1₃ₛ, 2₂ₛ, R₄ₛ, 4₁ₛ and 10ₓ, with 1₂ₛ as a warning. The usual choice for a quantitative control.',
  westgard_simple: 'Rejects only beyond ±3 SD. For controls where the multirule set produces too many false rejections.',
  range_only: 'Flags a result outside the acceptable range. No statistical rules.',
  match_expected: 'Passes only when the observed result equals the expected one.',
};

/** The rule profiles that make sense for each control type. */
export const PROFILES_FOR_TYPE: Record<IqcControlType, IqcRuleProfile[]> = {
  quantitative: ['westgard_standard', 'westgard_simple', 'range_only'],
  qualitative: ['match_expected'],
  semi_quantitative: ['range_only', 'match_expected'],
  // A C&S control is judged against what the reference strain is expected to
  // give — the organism, and each agent's category and QC range — so the
  // profile is fixed rather than offered.
  culture_sensitivity: ['match_expected'],
};

/** Human-readable rule names, used on charts, tables and failure reports. */
export const RULE_LABELS: Record<string, string> = {
  within_control: 'In control',
  warning_1_2s: '1₂ₛ warning',
  reject_1_3s: '1₃ₛ',
  reject_2_2s: '2₂ₛ',
  reject_R_4s: 'R₄ₛ',
  reject_2of3_2s: '2of3₂ₛ',
  reject_4_1s: '4₁ₛ',
  reject_10x: '10ₓ',
  out_of_range: 'Outside acceptable range',
  expected_mismatch: 'Does not match expected result',
  organism_mismatch: 'Organism not identified as expected',
  interpretation_mismatch: 'Susceptibility category not as expected',
};

/** What each rule is telling the bench to look at. Shown beside a failure. */
export const RULE_MEANING: Record<string, string> = {
  warning_1_2s: 'One result beyond ±2 SD. A warning only — carry on, but watch the next run.',
  reject_1_3s: 'One result beyond ±3 SD. Random error. Reject the run.',
  reject_2_2s: 'Two consecutive results beyond the same ±2 SD limit. Systematic error — check calibration.',
  reject_R_4s: 'Two results in the run spanning 4 SD. Random error — check reproducibility, bubbles, pipetting.',
  reject_2of3_2s: 'Two of three controls beyond the same ±2 SD limit. Systematic error beginning.',
  reject_4_1s: 'Four consecutive results beyond the same ±1 SD limit. Systematic drift — look at reagent or calibrator age.',
  reject_10x: 'Ten consecutive results on the same side of the mean. A shift — recalibrate or change reagent lot.',
  out_of_range: 'Outside the acceptable range set for this control.',
  expected_mismatch: 'The control did not give its expected result. The test system is not performing — do not report patient results.',
  organism_mismatch: 'The reference strain did not identify as the expected organism. The medium, inoculum or identification system is not performing — do not report patient results.',
  interpretation_mismatch: 'The agent gave a category other than the expected S/I/R for the reference strain. Check disk potency, inoculum density and incubation before reporting susceptibilities.',
};

/** Rules that stop patient results going out. A warning does not. */
export function isRejection(rule?: string | null): boolean {
  return Boolean(rule && rule.startsWith('reject_'))
    || rule === 'out_of_range' || rule === 'expected_mismatch'
    || rule === 'organism_mismatch' || rule === 'interpretation_mismatch';
}

/**
 * A starting set of analytes for common tests, so defining an FBC control is
 * picking a template rather than typing eight rows by hand.
 */
export const ANALYTE_TEMPLATES: { key: string; label: string; controlType: IqcControlType; csScope?: CsScope; expectedOrganism?: string; analytes: { analyte: string; unit?: string; decimalPlaces?: number; astMethod?: AstMethod }[] }[] = [
  {
    key: 'fbc', label: 'Full blood count (FBC)', controlType: 'quantitative',
    analytes: [
      { analyte: 'WBC', unit: '×10⁹/L', decimalPlaces: 2 },
      { analyte: 'RBC', unit: '×10¹²/L', decimalPlaces: 2 },
      { analyte: 'Haemoglobin', unit: 'g/dL', decimalPlaces: 1 },
      { analyte: 'Haematocrit', unit: '%', decimalPlaces: 1 },
      { analyte: 'MCV', unit: 'fL', decimalPlaces: 1 },
      { analyte: 'MCH', unit: 'pg', decimalPlaces: 1 },
      { analyte: 'MCHC', unit: 'g/dL', decimalPlaces: 1 },
      { analyte: 'Platelets', unit: '×10⁹/L', decimalPlaces: 0 },
    ],
  },
  {
    key: 'chem_basic', label: 'Basic chemistry panel', controlType: 'quantitative',
    analytes: [
      { analyte: 'Glucose', unit: 'mmol/L', decimalPlaces: 2 },
      { analyte: 'Urea', unit: 'mmol/L', decimalPlaces: 2 },
      { analyte: 'Creatinine', unit: 'µmol/L', decimalPlaces: 0 },
      { analyte: 'Sodium', unit: 'mmol/L', decimalPlaces: 0 },
      { analyte: 'Potassium', unit: 'mmol/L', decimalPlaces: 2 },
      { analyte: 'Chloride', unit: 'mmol/L', decimalPlaces: 0 },
    ],
  },
  {
    key: 'lft', label: 'Liver function tests', controlType: 'quantitative',
    analytes: [
      { analyte: 'Total bilirubin', unit: 'µmol/L', decimalPlaces: 1 },
      { analyte: 'ALT', unit: 'U/L', decimalPlaces: 0 },
      { analyte: 'AST', unit: 'U/L', decimalPlaces: 0 },
      { analyte: 'ALP', unit: 'U/L', decimalPlaces: 0 },
      { analyte: 'Albumin', unit: 'g/L', decimalPlaces: 1 },
      { analyte: 'Total protein', unit: 'g/L', decimalPlaces: 1 },
    ],
  },
  {
    key: 'coag', label: 'Coagulation', controlType: 'quantitative',
    analytes: [
      { analyte: 'Prothrombin time', unit: 's', decimalPlaces: 1 },
      { analyte: 'INR', unit: '', decimalPlaces: 2 },
      { analyte: 'APTT', unit: 's', decimalPlaces: 1 },
    ],
  },
  {
    key: 'serology_single', label: 'Single serology marker (HBsAg, HCV, HIV, syphilis)', controlType: 'qualitative',
    analytes: [{ analyte: 'Marker' }],
  },
  {
    key: 'malaria_rdt', label: 'Malaria rapid diagnostic test', controlType: 'qualitative',
    analytes: [{ analyte: 'P. falciparum antigen' }],
  },
  {
    key: 'urinalysis', label: 'Urinalysis strip', controlType: 'semi_quantitative',
    analytes: [
      { analyte: 'Protein' }, { analyte: 'Glucose' }, { analyte: 'Blood' },
      { analyte: 'Leucocytes' }, { analyte: 'Nitrite' }, { analyte: 'Ketones' },
    ],
  },
  {
    // A starting agent panel for a Gram-negative reference strain. The zone/MIC
    // QC ranges and expected categories are deliberately left blank — they are
    // specific to the CLSI M100 edition in force and to the disk potency used,
    // so the laboratory fills them from its current tables rather than trusting
    // a value baked into the software.
    key: 'ast_gram_negative', label: 'AST reference strain — Gram-negative panel (E. coli ATCC 25922)',
    controlType: 'culture_sensitivity', csScope: 'susceptibility', expectedOrganism: 'Escherichia coli ATCC 25922',
    analytes: [
      { analyte: 'Ampicillin', unit: 'mm', astMethod: 'disk_diffusion' },
      { analyte: 'Amoxicillin-clavulanate', unit: 'mm', astMethod: 'disk_diffusion' },
      { analyte: 'Ceftriaxone', unit: 'mm', astMethod: 'disk_diffusion' },
      { analyte: 'Ciprofloxacin', unit: 'mm', astMethod: 'disk_diffusion' },
      { analyte: 'Gentamicin', unit: 'mm', astMethod: 'disk_diffusion' },
      { analyte: 'Meropenem', unit: 'mm', astMethod: 'disk_diffusion' },
      { analyte: 'Trimethoprim-sulfamethoxazole', unit: 'mm', astMethod: 'disk_diffusion' },
    ],
  },
  {
    key: 'id_reference_strain', label: 'Identification reference strain (organism ID only)',
    controlType: 'culture_sensitivity', csScope: 'identification', expectedOrganism: 'Staphylococcus aureus ATCC 25923',
    analytes: [],
  },
];
