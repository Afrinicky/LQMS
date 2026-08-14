/**
 * What a piece of equipment IS, and therefore what the laboratory owes it.
 *
 * ISO 15189:2022 does not treat all equipment alike, and neither should the
 * software. Two clauses draw the line:
 *
 *   §6.5.2/6.5.3  equipment whose measurement affects the validity of a result
 *                 must be calibrated against a traceable reference. That covers
 *                 the analyser that reports the result AND the pipette, balance
 *                 or thermometer taking a "subsidiary measurement" that feeds
 *                 it (the same wording appears in ISO/IEC 17025:2017 §6.4.6).
 *
 *   §7.3.7        internal QC and EQA are about EXAMINATION performance — they
 *                 belong to the device that produces a patient result. A
 *                 refrigerator has no result to control, so putting it in an
 *                 IQC picker is not strictness, it is noise.
 *
 * So the category answers two different questions, and they are not the same
 * question:
 *
 *   "does it produce a patient result?"  → IQC, EQA, verification, uncertainty
 *   "does its measurement matter?"       → calibration with traceability
 *
 * A pipette answers no to the first and yes to the second. A fridge answers no
 * to both — but it is NOT unmanaged: §6.4.3 acceptance, §6.4.5 maintenance and
 * continuous monitoring are its cohort of services, and they are listed here
 * so the system can hold it to them the way it holds an analyser to Westgard.
 */

export const EQUIPMENT_CATEGORIES = [
  'analyser', 'poct', 'measuring_device', 'support', 'it', 'other',
] as const;
export type EquipmentCategory = (typeof EQUIPMENT_CATEGORIES)[number];

/**
 * The six values above are the ARCHETYPES — the fixed behavioural classes the
 * standards recognise. What a laboratory sees in the dropdown is a CATEGORY,
 * and a category is configurable: "Chemistry analyser", "Molecular analyser"
 * and "Blood gas analyser" can all be added, and each is pinned to one
 * archetype so the system still knows a molecular analyser owes IQC and a cold
 * room does not. The archetype carries the behaviour; the category carries the
 * name. A built-in category's value equals its archetype, so a laboratory that
 * never customises anything sees exactly these six.
 */
export const EQUIPMENT_ARCHETYPES = EQUIPMENT_CATEGORIES;
export type EquipmentArchetype = EquipmentCategory;
export function isArchetype(v?: string | null): v is EquipmentArchetype {
  return (EQUIPMENT_ARCHETYPES as readonly string[]).includes(String(v));
}

export const EQUIPMENT_CATEGORY_LABELS: Record<EquipmentCategory, string> = {
  analyser: 'Diagnostic analyser',
  poct: 'Point-of-care testing device',
  measuring_device: 'Measuring device',
  support: 'Support / ancillary equipment',
  it: 'Computing / IT equipment',
  other: 'Other equipment',
};

export const EQUIPMENT_CATEGORY_HINTS: Record<EquipmentCategory, string> = {
  analyser: 'Produces patient results — chemistry, haematology, immunoassay, PCR, blood gas, microbiology ID/AST systems. Carries the full examination programme: calibration, verification, uncertainty, IQC and EQA.',
  poct: 'Testing at the point of care — glucometer, rapid analyser, blood gas at the bedside. Produces patient results, so IQC and EQA apply, with operator competency tracked per user.',
  measuring_device: 'Takes a measurement that feeds a result without reporting one itself — pipette, balance, thermometer, timer, pH meter, centrifuge where speed matters. Needs traceable calibration (ISO 15189 §6.5.3), not IQC or EQA.',
  support: 'Holds, prepares or protects — refrigerator, freezer, incubator, water bath, centrifuge, autoclave, biosafety cabinet, fume hood. No patient result, so no IQC or EQA; it is controlled by acceptance, continuous monitoring, maintenance and (where applicable) certification.',
  it: 'Computers, servers and network hardware carrying laboratory data. Managed under information management (ISO 15189 §7.6) rather than calibration.',
  other: 'Anything else on the inventory — furniture, transport boxes, general fittings.',
};

export const EQUIPMENT_CATEGORY_EXAMPLES: Record<EquipmentCategory, string> = {
  analyser: 'Cobas c311, Sysmex XN-1000, GeneXpert, VITEK 2',
  poct: 'Glucometer, i-STAT, rapid HIV reader',
  measuring_device: 'Micropipette, analytical balance, thermometer, pH meter',
  support: 'Refrigerator, −80 freezer, incubator, autoclave, biosafety cabinet',
  it: 'LIS server, workstation, barcode printer',
  other: 'Trolley, storage cabinet',
};

/* ------------------------------------------------------------------ duties */

/**
 * The quality activities a category owes. Every category owes SOMETHING —
 * that is the point. A fridge is not exempt from control, it is controlled
 * differently from an analyser.
 */
export const EQUIPMENT_DUTIES = [
  'acceptance', 'calibration', 'verification', 'measurement_uncertainty',
  'iqc', 'eqa', 'maintenance', 'monitoring', 'certification', 'competency',
] as const;
export type EquipmentDuty = (typeof EQUIPMENT_DUTIES)[number];

export const DUTY_LABELS: Record<EquipmentDuty, string> = {
  acceptance: 'Acceptance / qualification before use',
  calibration: 'Calibration with metrological traceability',
  verification: 'Performance verification',
  measurement_uncertainty: 'Measurement uncertainty',
  iqc: 'Internal quality control (IQC)',
  eqa: 'External quality assessment (EQA/PT)',
  maintenance: 'Preventive maintenance',
  monitoring: 'Continuous performance monitoring',
  certification: 'Periodic certification / validation',
  competency: 'Operator competency',
};

/** The clause each duty answers to, shown beside it so an audit can follow it. */
export const DUTY_CLAUSES: Record<EquipmentDuty, string> = {
  acceptance: 'ISO 15189:2022 §6.4.3',
  calibration: 'ISO 15189:2022 §6.5.2–6.5.3',
  verification: 'ISO 15189:2022 §7.3.3',
  measurement_uncertainty: 'ISO 15189:2022 §7.3.4',
  iqc: 'ISO 15189:2022 §7.3.7.2',
  eqa: 'ISO 15189:2022 §7.3.7.3',
  maintenance: 'ISO 15189:2022 §6.4.5',
  monitoring: 'ISO 15189:2022 §6.4.5 / §6.3 (facilities & environment)',
  certification: 'ISO 15189:2022 §6.4.3 / §6.3.4',
  competency: 'ISO 15189:2022 §6.2.3',
};

export const DUTY_HINTS: Record<EquipmentDuty, string> = {
  acceptance: 'Verified against the manufacturer’s stated performance and the laboratory’s intended use before first clinical use, and again after a repair that could affect performance.',
  calibration: 'Calibrated at defined intervals against a reference that is traceable to a higher-order standard, with the interval and the acceptance criteria stated.',
  verification: 'The examination performs as claimed in this laboratory, on these samples, with these operators.',
  measurement_uncertainty: 'The uncertainty of a reported quantitative value, estimated and reviewed, and available on request.',
  iqc: 'Control material run at a stated frequency and judged by stated rules before patient results are released.',
  eqa: 'Performance compared with peer laboratories through an interlaboratory programme, or by an alternative approach where no programme exists.',
  maintenance: 'The preventive schedule from the manufacturer and from this laboratory’s own experience, with every service recorded.',
  monitoring: 'Continuous or scheduled recording that the unit is holding its stated condition — temperature, humidity, CO₂, pressure — with alarm limits and an action on breach.',
  certification: 'Periodic third-party certification or revalidation — a biosafety cabinet’s airflow, an autoclave’s sterilisation performance.',
  competency: 'Each operator assessed as competent on this device before independent use, and reassessed periodically.',
};

/**
 * What each category owes. Derived from the clauses above rather than from
 * habit: the analyser and the POCT device are the only ones producing a
 * patient result, so they are the only ones carrying IQC and EQA.
 */
export const DUTIES_BY_CATEGORY: Record<EquipmentCategory, EquipmentDuty[]> = {
  analyser: ['acceptance', 'calibration', 'verification', 'measurement_uncertainty', 'iqc', 'eqa', 'maintenance', 'competency'],
  poct: ['acceptance', 'calibration', 'verification', 'iqc', 'eqa', 'maintenance', 'competency'],
  measuring_device: ['acceptance', 'calibration', 'verification', 'maintenance'],
  support: ['acceptance', 'monitoring', 'maintenance', 'certification', 'competency'],
  it: ['acceptance', 'maintenance'],
  other: ['acceptance', 'maintenance'],
};

export function dutiesFor(category?: string | null): EquipmentDuty[] {
  return DUTIES_BY_CATEGORY[(category ?? 'other') as EquipmentCategory] ?? DUTIES_BY_CATEGORY.other;
}
export function owes(category: string | null | undefined, duty: EquipmentDuty): boolean {
  return dutiesFor(category).includes(duty);
}

/* --------------------------------------------------------------- the gate */

/**
 * Does this category produce a patient result? Only these appear where an
 * examination is being controlled — the IQC and EQA pickers, a test's
 * analyser, method verification, measurement uncertainty.
 *
 * Deliberately narrower than "is it in the laboratory": a pipette is
 * calibration-critical and still has no business in an IQC picker.
 */
export function isDiagnosticCategory(category?: string | null): boolean {
  return category === 'analyser' || category === 'poct';
}

/**
 * The one place the front end asks "does analytical QC apply to this item?".
 * The archetype is the truth; the category and the legacy class are fallbacks
 * for rows written before each existed.
 */
export function equipmentIsDiagnostic(e: { equipment_archetype?: string | null; equipment_category?: string | null; equipment_class?: string | null; name?: string | null; category?: string | null }): boolean {
  const archetype = e.equipment_archetype
    ?? (isArchetype(e.equipment_category) ? e.equipment_category : null)
    ?? categoryFromLegacy(e.equipment_class, e.name, e.category);
  return isDiagnosticCategory(archetype);
}

/** Categories that carry traceable calibration, whether or not they report. */
export function needsCalibration(category?: string | null): boolean {
  return owes(category, 'calibration');
}

/**
 * The bridge to the original two-value `equipment_class` ('laboratory' |
 * 'support'), which is still stored so older rows and any code not yet moved
 * across keep working.
 */
export function classForCategory(category?: string | null): 'laboratory' | 'support' {
  return isDiagnosticCategory(category) || category === 'measuring_device' ? 'laboratory' : 'support';
}

/** Best guess at a category for a row that predates this field. */
export function categoryFromLegacy(equipmentClass?: string | null, name?: string | null, categoryText?: string | null): EquipmentCategory {
  const hay = `${name ?? ''} ${categoryText ?? ''}`.toLowerCase();
  if (/fridge|refrigerat|freezer|incubat|water ?bath|autoclave|cabinet|hood|oven|air ?condition/.test(hay)) return 'support';
  if (/comput|laptop|server|printer|ups|network/.test(hay)) return 'it';
  if (/pipette|balance|scale|thermometer|timer|ph ?meter/.test(hay)) return 'measuring_device';
  if (/glucomet|point.?of.?care|poct/.test(hay)) return 'poct';
  if (equipmentClass === 'support') return 'support';
  return 'analyser';
}
