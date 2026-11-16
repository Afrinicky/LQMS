/**
 * Biological reference intervals, by age and by sex.
 *
 * ----------------------------------------------------------------------------
 * Why this file is shaped the way it is
 * ----------------------------------------------------------------------------
 * A reference interval is not a property of a test. It is a property of a test
 * AND the person it was run on. A haemoglobin of 12.5 g/dL is unremarkable in
 * an adult woman, low in an adult man, and frankly high in a six-month-old.
 * Printing one interval against all three is not a rounding error; it is the
 * report telling a clinician something untrue about two of them.
 *
 * So every row here carries the population it belongs to, and the report picks
 * the most specific row that actually fits the patient in front of it. A row
 * whose band excludes the patient is never used as a fallback — a range that
 * does not apply is not an approximation, it is the wrong answer, and a blank
 * is better than a wrong answer on a document somebody treats a patient from.
 *
 * ----------------------------------------------------------------------------
 * The age bands
 * ----------------------------------------------------------------------------
 * Stated in exact days and deliberately NOT overlapping: one band ends the day
 * before the next begins. Bands written as "birth to 6 months" and "6 months to
 * 1 year" both contain the day a child turns six months old, and which one wins
 * then depends on how the comparison was written rather than on anything
 * clinical.
 *
 * ----------------------------------------------------------------------------
 * Where the numbers come from
 * ----------------------------------------------------------------------------
 * Haematology follows the Sysmex XN series' own adult intervals, with the
 * paediatric bands from CLSI C28-A3 and the standard paediatric haematology
 * literature. Clinical chemistry follows CLSI C28-A3 and Tietz, in SI units,
 * which is what HUMAN's analysers are configured to report here and what LHIMS
 * files. Endocrinology and coagulation follow the usual international method
 * intervals.
 *
 * EVERY ROW IS A STARTING POINT, NOT A DECISION. A reference interval belongs
 * to the laboratory that issues the report: it depends on that laboratory's
 * method, its analyser and its population, and a Ghanaian adult population is
 * not the one most of these were derived from. Each row is marked with its
 * source, the register shows that mark, and all of it is editable. The
 * laboratory is expected to review them and to replace any it does not accept.
 */
import type { RangeSex } from './labReport.js';

export interface IntervalSeed {
  /** The parameter, spelled as this system names it. */
  analyte: string;
  sex?: RangeSex;
  /** Inclusive, in whole days. Omit both for "any age". */
  fromDays?: number;
  toDays?: number;
  /** How a laboratory says that band out loud. */
  ageLabel?: string;
  low?: string;
  high?: string;
  unit?: string;
  /** Where this interval came from, printed on the register. */
  source: string;
  note?: string;
}

/* ============================================================================
   The bands, in days
   ----------------------------------------------------------------------------
   365.25 days to the year, so eighteen years is 6575 days and not 6570. The
   half-days matter at the top of a paediatric band, where a fortnight of
   children would otherwise fall between two intervals and get neither.
   ========================================================================= */
export const BANDS = {
  newborn: { fromDays: 0, toDays: 13, ageLabel: 'Birth – 2 weeks' },
  neonate: { fromDays: 14, toDays: 29, ageLabel: '2 – 4 weeks' },
  infant: { fromDays: 30, toDays: 180, ageLabel: '1 – 6 months' },
  olderInfant: { fromDays: 181, toDays: 364, ageLabel: '6 – 12 months' },
  preschool: { fromDays: 365, toDays: 2191, ageLabel: '1 – 6 years' },
  child: { fromDays: 2192, toDays: 4382, ageLabel: '6 – 12 years' },
  adolescent: { fromDays: 4383, toDays: 6574, ageLabel: '12 – 18 years' },
  adult: { fromDays: 6575, ageLabel: '18 years and over' },
} as const;

const XN = 'Sysmex XN series';
const XN_PAED = 'CLSI C28-A3 / paediatric haematology';
const CLSI = 'CLSI C28-A3';
const TIETZ = 'CLSI C28-A3 / Tietz';
const METHOD = 'Method interval — review against your assay';

/** Shorthand so a band is written once per row rather than three fields. */
type Band = { fromDays?: number; toDays?: number; ageLabel?: string };
const at = (band: Band, rest: Omit<IntervalSeed, 'analyte' | 'source'> & { analyte: string; source: string }): IntervalSeed =>
  ({ ...band, ...rest });

/* ============================================================================
   Full blood count
   ========================================================================= */
const FBC: IntervalSeed[] = [
  /* ---- White cells ---------------------------------------------------- */
  at(BANDS.newborn, { analyte: 'WBC', low: '9.0', high: '30.0', unit: '10^3/uL', source: XN_PAED }),
  at(BANDS.neonate, { analyte: 'WBC', low: '5.0', high: '20.0', unit: '10^3/uL', source: XN_PAED }),
  at(BANDS.infant, { analyte: 'WBC', low: '6.0', high: '17.5', unit: '10^3/uL', source: XN_PAED }),
  at(BANDS.olderInfant, { analyte: 'WBC', low: '6.0', high: '17.5', unit: '10^3/uL', source: XN_PAED }),
  at(BANDS.preschool, { analyte: 'WBC', low: '5.0', high: '15.5', unit: '10^3/uL', source: XN_PAED }),
  at(BANDS.child, { analyte: 'WBC', low: '4.5', high: '13.5', unit: '10^3/uL', source: XN_PAED }),
  at(BANDS.adolescent, { analyte: 'WBC', low: '4.5', high: '13.0', unit: '10^3/uL', source: XN_PAED }),
  at(BANDS.adult, { analyte: 'WBC', low: '4.0', high: '10.0', unit: '10^3/uL', source: XN }),

  /* ---- Red cells ------------------------------------------------------- */
  at(BANDS.newborn, { analyte: 'RBC', low: '4.1', high: '6.1', unit: '10^6/uL', source: XN_PAED }),
  at(BANDS.neonate, { analyte: 'RBC', low: '4.0', high: '6.0', unit: '10^6/uL', source: XN_PAED }),
  at(BANDS.infant, { analyte: 'RBC', low: '3.1', high: '4.5', unit: '10^6/uL', source: XN_PAED }),
  at(BANDS.olderInfant, { analyte: 'RBC', low: '3.9', high: '5.5', unit: '10^6/uL', source: XN_PAED }),
  at(BANDS.preschool, { analyte: 'RBC', low: '4.0', high: '5.2', unit: '10^6/uL', source: XN_PAED }),
  at(BANDS.child, { analyte: 'RBC', low: '4.0', high: '5.2', unit: '10^6/uL', source: XN_PAED }),
  at(BANDS.adolescent, { analyte: 'RBC', sex: 'male', low: '4.5', high: '5.3', unit: '10^6/uL', source: XN_PAED }),
  at(BANDS.adolescent, { analyte: 'RBC', sex: 'female', low: '4.1', high: '5.1', unit: '10^6/uL', source: XN_PAED }),
  at(BANDS.adult, { analyte: 'RBC', sex: 'male', low: '4.30', high: '5.70', unit: '10^6/uL', source: XN }),
  at(BANDS.adult, { analyte: 'RBC', sex: 'female', low: '3.80', high: '5.20', unit: '10^6/uL', source: XN }),

  /* ---- Haemoglobin ----------------------------------------------------- */
  at(BANDS.newborn, { analyte: 'HGB', low: '14.5', high: '22.5', unit: 'g/dL', source: XN_PAED }),
  at(BANDS.neonate, { analyte: 'HGB', low: '12.5', high: '20.5', unit: 'g/dL', source: XN_PAED }),
  at(BANDS.infant, { analyte: 'HGB', low: '10.0', high: '13.0', unit: 'g/dL', source: XN_PAED,
    note: 'The physiological nadir of infancy. A value here that would be low in an adult is expected.' }),
  at(BANDS.olderInfant, { analyte: 'HGB', low: '10.5', high: '13.5', unit: 'g/dL', source: XN_PAED }),
  at(BANDS.preschool, { analyte: 'HGB', low: '11.5', high: '13.5', unit: 'g/dL', source: XN_PAED }),
  at(BANDS.child, { analyte: 'HGB', low: '11.5', high: '15.5', unit: 'g/dL', source: XN_PAED }),
  at(BANDS.adolescent, { analyte: 'HGB', sex: 'male', low: '13.0', high: '16.0', unit: 'g/dL', source: XN_PAED }),
  at(BANDS.adolescent, { analyte: 'HGB', sex: 'female', low: '12.0', high: '16.0', unit: 'g/dL', source: XN_PAED }),
  at(BANDS.adult, { analyte: 'HGB', sex: 'male', low: '13.5', high: '17.5', unit: 'g/dL', source: XN }),
  at(BANDS.adult, { analyte: 'HGB', sex: 'female', low: '11.5', high: '15.5', unit: 'g/dL', source: XN }),

  /* ---- Haematocrit ----------------------------------------------------- */
  at(BANDS.newborn, { analyte: 'HCT', low: '45', high: '67', unit: '%', source: XN_PAED }),
  at(BANDS.neonate, { analyte: 'HCT', low: '42', high: '66', unit: '%', source: XN_PAED }),
  at(BANDS.infant, { analyte: 'HCT', low: '31', high: '41', unit: '%', source: XN_PAED }),
  at(BANDS.olderInfant, { analyte: 'HCT', low: '33', high: '39', unit: '%', source: XN_PAED }),
  at(BANDS.preschool, { analyte: 'HCT', low: '34', high: '40', unit: '%', source: XN_PAED }),
  at(BANDS.child, { analyte: 'HCT', low: '35', high: '45', unit: '%', source: XN_PAED }),
  at(BANDS.adolescent, { analyte: 'HCT', sex: 'male', low: '37', high: '49', unit: '%', source: XN_PAED }),
  at(BANDS.adolescent, { analyte: 'HCT', sex: 'female', low: '36', high: '46', unit: '%', source: XN_PAED }),
  at(BANDS.adult, { analyte: 'HCT', sex: 'male', low: '40', high: '52', unit: '%', source: XN }),
  at(BANDS.adult, { analyte: 'HCT', sex: 'female', low: '35', high: '47', unit: '%', source: XN }),

  /* ---- Indices ---------------------------------------------------------- */
  at(BANDS.newborn, { analyte: 'MCV', low: '98', high: '118', unit: 'fL', source: XN_PAED }),
  at(BANDS.neonate, { analyte: 'MCV', low: '94', high: '112', unit: 'fL', source: XN_PAED }),
  at(BANDS.infant, { analyte: 'MCV', low: '74', high: '96', unit: 'fL', source: XN_PAED }),
  at(BANDS.olderInfant, { analyte: 'MCV', low: '70', high: '86', unit: 'fL', source: XN_PAED }),
  at(BANDS.preschool, { analyte: 'MCV', low: '75', high: '87', unit: 'fL', source: XN_PAED }),
  at(BANDS.child, { analyte: 'MCV', low: '77', high: '95', unit: 'fL', source: XN_PAED }),
  at(BANDS.adolescent, { analyte: 'MCV', low: '78', high: '98', unit: 'fL', source: XN_PAED }),
  at(BANDS.adult, { analyte: 'MCV', low: '80.0', high: '100.0', unit: 'fL', source: XN }),
  at(BANDS.adult, { analyte: 'MCH', low: '27.0', high: '33.0', unit: 'pg', source: XN }),
  at(BANDS.preschool, { analyte: 'MCH', low: '24.0', high: '30.0', unit: 'pg', source: XN_PAED }),
  at(BANDS.child, { analyte: 'MCH', low: '25.0', high: '33.0', unit: 'pg', source: XN_PAED }),
  at(BANDS.adult, { analyte: 'MCHC', low: '32.0', high: '36.0', unit: 'g/dL', source: XN }),
  { analyte: 'RDW-CV', low: '11.0', high: '16.0', unit: '%', source: XN },
  { analyte: 'RDW-SD', low: '37.0', high: '54.0', unit: 'fL', source: XN },

  /* ---- Platelets --------------------------------------------------------- */
  { analyte: 'PLT', low: '150', high: '450', unit: '10^3/uL', source: XN },
  { analyte: 'MPV', low: '9.0', high: '13.0', unit: 'fL', source: XN },
  { analyte: 'PDW', low: '9.0', high: '17.0', unit: 'fL', source: XN },
  { analyte: 'P-LCR', low: '13.0', high: '43.0', unit: '%', source: XN },
  { analyte: 'PCT', low: '0.17', high: '0.35', unit: '%', source: XN },

  /* ---- Differential, absolute -------------------------------------------- */
  at(BANDS.adult, { analyte: 'NEUT#', low: '2.00', high: '7.00', unit: '10^3/uL', source: XN }),
  at(BANDS.adult, { analyte: 'LYMPH#', low: '1.00', high: '3.50', unit: '10^3/uL', source: XN }),
  at(BANDS.adult, { analyte: 'MONO#', low: '0.20', high: '0.80', unit: '10^3/uL', source: XN }),
  at(BANDS.adult, { analyte: 'EO#', low: '0.02', high: '0.50', unit: '10^3/uL', source: XN }),
  at(BANDS.adult, { analyte: 'BASO#', low: '0.00', high: '0.10', unit: '10^3/uL', source: XN }),
  at(BANDS.preschool, { analyte: 'LYMPH#', low: '2.00', high: '8.00', unit: '10^3/uL', source: XN_PAED,
    note: 'Lymphocytes predominate in early childhood; the differential inverts at about four years.' }),
  at(BANDS.preschool, { analyte: 'NEUT#', low: '1.50', high: '8.50', unit: '10^3/uL', source: XN_PAED }),

  /* ---- Differential, percentage ------------------------------------------- */
  at(BANDS.adult, { analyte: 'NEUT%', low: '40.0', high: '75.0', unit: '%', source: XN }),
  at(BANDS.adult, { analyte: 'LYMPH%', low: '20.0', high: '50.0', unit: '%', source: XN }),
  at(BANDS.adult, { analyte: 'MONO%', low: '2.0', high: '10.0', unit: '%', source: XN }),
  at(BANDS.adult, { analyte: 'EO%', low: '1.0', high: '6.0', unit: '%', source: XN }),
  at(BANDS.adult, { analyte: 'BASO%', low: '0.0', high: '1.0', unit: '%', source: XN }),
  at(BANDS.preschool, { analyte: 'LYMPH%', low: '35.0', high: '75.0', unit: '%', source: XN_PAED }),
  at(BANDS.preschool, { analyte: 'NEUT%', low: '20.0', high: '55.0', unit: '%', source: XN_PAED }),

  /* ---- Immature and reticulocyte channels ---------------------------------- */
  { analyte: 'IG#', low: '0.00', high: '0.07', unit: '10^3/uL', source: XN },
  { analyte: 'IG%', low: '0.0', high: '0.6', unit: '%', source: XN },
  { analyte: 'RET%', low: '0.5', high: '2.0', unit: '%', source: XN },
  { analyte: 'RET#', low: '25', high: '75', unit: '10^9/L', source: XN },
  { analyte: 'NRBC#', low: '0.00', high: '0.01', unit: '10^3/uL', source: XN },
  { analyte: 'NRBC%', low: '0.0', high: '0.2', unit: '%', source: XN },
];

/* ============================================================================
   Clinical chemistry
   ========================================================================= */
const CHEMISTRY: IntervalSeed[] = [
  /* ---- Renal and electrolytes ------------------------------------------- */
  { analyte: 'UREA', low: '2.5', high: '7.1', unit: 'mmol/L', source: TIETZ },
  at(BANDS.adult, { analyte: 'CREATININE', sex: 'male', low: '62', high: '106', unit: 'umol/L', source: TIETZ }),
  at(BANDS.adult, { analyte: 'CREATININE', sex: 'female', low: '44', high: '80', unit: 'umol/L', source: TIETZ }),
  at(BANDS.child, { analyte: 'CREATININE', low: '27', high: '62', unit: 'umol/L', source: TIETZ }),
  at(BANDS.preschool, { analyte: 'CREATININE', low: '18', high: '35', unit: 'umol/L', source: TIETZ }),
  { analyte: 'SODIUM', low: '135', high: '145', unit: 'mmol/L', source: TIETZ },
  { analyte: 'POTASSIUM', low: '3.5', high: '5.1', unit: 'mmol/L', source: TIETZ },
  { analyte: 'CHLORIDE', low: '98', high: '107', unit: 'mmol/L', source: TIETZ },
  { analyte: 'BICARBONATE', low: '22', high: '29', unit: 'mmol/L', source: TIETZ },
  { analyte: 'CALCIUM', low: '2.15', high: '2.55', unit: 'mmol/L', source: TIETZ },
  { analyte: 'PHOSPHATE', low: '0.81', high: '1.45', unit: 'mmol/L', source: TIETZ },
  at(BANDS.child, { analyte: 'PHOSPHATE', low: '1.45', high: '1.78', unit: 'mmol/L', source: TIETZ,
    note: 'Higher in growing bone. An adult interval reads a normal child as raised.' }),
  { analyte: 'MAGNESIUM', low: '0.66', high: '1.07', unit: 'mmol/L', source: TIETZ },
  at(BANDS.adult, { analyte: 'URIC ACID', sex: 'male', low: '202', high: '416', unit: 'umol/L', source: TIETZ }),
  at(BANDS.adult, { analyte: 'URIC ACID', sex: 'female', low: '143', high: '339', unit: 'umol/L', source: TIETZ }),

  /* ---- Liver ------------------------------------------------------------- */
  { analyte: 'TOTAL PROTEIN', low: '64', high: '83', unit: 'g/L', source: TIETZ },
  { analyte: 'ALBUMIN', low: '35', high: '52', unit: 'g/L', source: TIETZ },
  { analyte: 'GLOBULIN', low: '20', high: '35', unit: 'g/L', source: TIETZ },
  { analyte: 'TOTAL BILIRUBIN', low: '5', high: '21', unit: 'umol/L', source: TIETZ },
  { analyte: 'DIRECT BILIRUBIN', low: '0', high: '5', unit: 'umol/L', source: TIETZ },
  { analyte: 'INDIRECT BILIRUBIN', low: '2', high: '17', unit: 'umol/L', source: TIETZ },
  at(BANDS.adult, { analyte: 'ALT', sex: 'male', low: '0', high: '41', unit: 'U/L', source: TIETZ }),
  at(BANDS.adult, { analyte: 'ALT', sex: 'female', low: '0', high: '33', unit: 'U/L', source: TIETZ }),
  at(BANDS.adult, { analyte: 'AST', sex: 'male', low: '0', high: '40', unit: 'U/L', source: TIETZ }),
  at(BANDS.adult, { analyte: 'AST', sex: 'female', low: '0', high: '32', unit: 'U/L', source: TIETZ }),
  at(BANDS.adult, { analyte: 'ALP', sex: 'male', low: '40', high: '129', unit: 'U/L', source: TIETZ }),
  at(BANDS.adult, { analyte: 'ALP', sex: 'female', low: '35', high: '104', unit: 'U/L', source: TIETZ }),
  at(BANDS.child, { analyte: 'ALP', low: '150', high: '420', unit: 'U/L', source: TIETZ,
    note: 'Bone growth, not liver disease. An adult interval reads a normal child as grossly abnormal.' }),
  at(BANDS.adolescent, { analyte: 'ALP', low: '100', high: '400', unit: 'U/L', source: TIETZ }),
  at(BANDS.adult, { analyte: 'GAMMA GT', sex: 'male', low: '10', high: '71', unit: 'U/L', source: TIETZ }),
  at(BANDS.adult, { analyte: 'GAMMA GT', sex: 'female', low: '6', high: '42', unit: 'U/L', source: TIETZ }),
  { analyte: 'LDH', low: '135', high: '225', unit: 'U/L', source: TIETZ },

  /* ---- Glucose and glycaemic control -------------------------------------- */
  { analyte: 'GLUCOSE', low: '3.9', high: '5.6', unit: 'mmol/L', source: TIETZ,
    note: 'Fasting. A random sample is read against a different threshold.' },
  { analyte: 'HBA1C', low: '4.0', high: '5.6', unit: '%', source: 'IFCC / ADA' },

  /* ---- Lipids -------------------------------------------------------------- */
  { analyte: 'TOTAL CHOLESTEROL', low: '0', high: '5.2', unit: 'mmol/L', source: 'NCEP ATP III',
    note: 'A desirable concentration, not a population interval.' },
  { analyte: 'TRIGLYCERIDES', low: '0', high: '1.7', unit: 'mmol/L', source: 'NCEP ATP III' },
  at(BANDS.adult, { analyte: 'HDL CHOLESTEROL', sex: 'male', low: '1.0', unit: 'mmol/L', source: 'NCEP ATP III' }),
  at(BANDS.adult, { analyte: 'HDL CHOLESTEROL', sex: 'female', low: '1.3', unit: 'mmol/L', source: 'NCEP ATP III' }),
  { analyte: 'LDL CHOLESTEROL', low: '0', high: '3.4', unit: 'mmol/L', source: 'NCEP ATP III' },
  { analyte: 'VLDL CHOLESTEROL', low: '0', high: '0.8', unit: 'mmol/L', source: 'NCEP ATP III' },

  /* ---- Cardiac, pancreatic and inflammatory --------------------------------- */
  at(BANDS.adult, { analyte: 'CK', sex: 'male', low: '39', high: '308', unit: 'U/L', source: TIETZ }),
  at(BANDS.adult, { analyte: 'CK', sex: 'female', low: '26', high: '192', unit: 'U/L', source: TIETZ }),
  { analyte: 'CK-MB', low: '0', high: '25', unit: 'U/L', source: TIETZ },
  { analyte: 'TROPONIN I', low: '0', high: '0.04', unit: 'ug/L', source: METHOD },
  { analyte: 'AMYLASE', low: '28', high: '100', unit: 'U/L', source: TIETZ },
  { analyte: 'LIPASE', low: '13', high: '60', unit: 'U/L', source: TIETZ },
  { analyte: 'C-REACTIVE PROTEIN', low: '0', high: '5', unit: 'mg/L', source: TIETZ },

  /* ---- Iron studies ---------------------------------------------------------- */
  at(BANDS.adult, { analyte: 'IRON', sex: 'male', low: '11.6', high: '31.3', unit: 'umol/L', source: TIETZ }),
  at(BANDS.adult, { analyte: 'IRON', sex: 'female', low: '9.0', high: '30.4', unit: 'umol/L', source: TIETZ }),
  { analyte: 'TIBC', low: '45', high: '72', unit: 'umol/L', source: TIETZ },
  { analyte: 'UIBC', low: '24.2', high: '70.1', unit: 'umol/L', source: TIETZ },
  at(BANDS.adult, { analyte: 'FERRITIN', sex: 'male', low: '24', high: '336', unit: 'ug/L', source: TIETZ }),
  at(BANDS.adult, { analyte: 'FERRITIN', sex: 'female', low: '11', high: '307', unit: 'ug/L', source: TIETZ }),
  { analyte: 'TRANSFERRIN', low: '2.0', high: '3.6', unit: 'g/L', source: TIETZ },
];

/* ============================================================================
   Coagulation
   ----------------------------------------------------------------------------
   More method-dependent than anything else here: a prothrombin time is only
   meaningful against the reagent and analyser that produced it, so these are
   offered as the shape of the answer and must be replaced with the intervals
   the laboratory's own reagent lot gives.
   ========================================================================= */
const COAGULATION: IntervalSeed[] = [
  { analyte: 'PROTHROMBIN TIME', low: '11.0', high: '13.5', unit: 's', source: METHOD },
  { analyte: 'INR', low: '0.8', high: '1.2', unit: 'ratio', source: METHOD },
  { analyte: 'APTT', low: '25', high: '35', unit: 's', source: METHOD },
  { analyte: 'THROMBIN TIME', low: '14', high: '19', unit: 's', source: METHOD },
  { analyte: 'FIBRINOGEN', low: '2.0', high: '4.0', unit: 'g/L', source: TIETZ },
  { analyte: 'D-DIMER', low: '0', high: '0.5', unit: 'mg/L', source: METHOD },
  { analyte: 'BLEEDING TIME', low: '2', high: '7', unit: 'min', source: METHOD },
  { analyte: 'CLOTTING TIME', low: '5', high: '10', unit: 'min', source: METHOD },
];

/* ============================================================================
   Endocrinology and tumour markers
   ----------------------------------------------------------------------------
   Immunoassays differ between manufacturers more than any chemistry does, and
   several of these change with the menstrual cycle or with pregnancy, which no
   age band can express. Each is the usual method interval for a non-pregnant
   adult and each needs checking against the kit insert in use.
   ========================================================================= */
const ENDOCRINE: IntervalSeed[] = [
  { analyte: 'TSH', low: '0.4', high: '4.0', unit: 'mIU/L', source: METHOD },
  { analyte: 'FREE T4', low: '12', high: '22', unit: 'pmol/L', source: METHOD },
  { analyte: 'FREE T3', low: '3.1', high: '6.8', unit: 'pmol/L', source: METHOD },
  { analyte: 'T4', low: '66', high: '181', unit: 'nmol/L', source: METHOD },
  { analyte: 'T3', low: '1.3', high: '3.1', unit: 'nmol/L', source: METHOD },
  at(BANDS.adult, { analyte: 'PROLACTIN', sex: 'male', low: '86', high: '324', unit: 'mIU/L', source: METHOD }),
  at(BANDS.adult, { analyte: 'PROLACTIN', sex: 'female', low: '102', high: '496', unit: 'mIU/L', source: METHOD }),
  at(BANDS.adult, { analyte: 'TESTOSTERONE', sex: 'male', low: '8.6', high: '29.0', unit: 'nmol/L', source: METHOD }),
  at(BANDS.adult, { analyte: 'TESTOSTERONE', sex: 'female', low: '0.3', high: '1.7', unit: 'nmol/L', source: METHOD }),
  { analyte: 'CORTISOL', low: '171', high: '536', unit: 'nmol/L', source: METHOD,
    note: 'Morning sample. Cortisol has a diurnal rhythm, so an afternoon sample is read differently.' },
  at(BANDS.adult, { analyte: 'LH', sex: 'male', low: '1.7', high: '8.6', unit: 'IU/L', source: METHOD }),
  at(BANDS.adult, { analyte: 'LH', sex: 'female', low: '2.4', high: '12.6', unit: 'IU/L', source: METHOD,
    note: 'Follicular phase. The mid-cycle surge is many times this.' }),
  at(BANDS.adult, { analyte: 'FSH', sex: 'male', low: '1.5', high: '12.4', unit: 'IU/L', source: METHOD }),
  at(BANDS.adult, { analyte: 'FSH', sex: 'female', low: '3.5', high: '12.5', unit: 'IU/L', source: METHOD,
    note: 'Follicular phase.' }),
  { analyte: 'PROGESTERONE', sex: 'female', low: '0.3', high: '2.5', unit: 'nmol/L', source: METHOD,
    note: 'Follicular phase. The luteal phase is far higher.' },
  { analyte: 'ESTRADIOL', sex: 'female', low: '46', high: '607', unit: 'pmol/L', source: METHOD,
    note: 'Varies through the cycle; interpret against the day of the cycle.' },
  { analyte: 'BETA HCG', low: '0', high: '5', unit: 'IU/L', source: METHOD, note: 'Non-pregnant.' },
  at(BANDS.adult, { analyte: 'PSA', sex: 'male', low: '0', high: '4.0', unit: 'ug/L', source: METHOD }),
  { analyte: 'VITAMIN B12', low: '145', high: '569', unit: 'pmol/L', source: METHOD },
  { analyte: 'FOLATE', low: '7', high: '45', unit: 'nmol/L', source: METHOD },
  { analyte: 'VITAMIN D', low: '75', high: '250', unit: 'nmol/L', source: METHOD,
    note: 'Sufficiency threshold rather than a population interval.' },
];

/** Every interval this system ships with. */
export const REFERENCE_INTERVALS: IntervalSeed[] = [
  ...FBC, ...CHEMISTRY, ...COAGULATION, ...ENDOCRINE,
];

/** The mark every shipped row carries on the register, so it can be found again. */
export const SHIPPED_SOURCE_PREFIX = '';

/** Groups, for a screen that wants to show them a panel at a time. */
export const INTERVAL_PANELS = [
  { key: 'fbc', label: 'Full blood count', rows: FBC.length },
  { key: 'chemistry', label: 'Clinical chemistry', rows: CHEMISTRY.length },
  { key: 'coagulation', label: 'Coagulation', rows: COAGULATION.length },
  { key: 'endocrine', label: 'Endocrinology and markers', rows: ENDOCRINE.length },
] as const;
