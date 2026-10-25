/**
 * The ranges a printed result is read against.
 *
 * A reference range is a clinical decision this laboratory owns, so nothing
 * here invents one: a parameter with no range on file prints a dash. What this
 * file provides is somewhere to keep them, and a starting point taken from the
 * ranges the laboratory's OWN result-entry forms already display — which is the
 * only honest source for a starting point, and still has to be reviewed before
 * anybody relies on it.
 */
import { ageToDays, type RangeSex } from '../../../shared/constants/labReport.js';
import { analyteKey, canonicalAnalyte } from '../../../shared/constants/formIntelligence.js';

type DB = any;

/**
 * The key a range is found by, so one set under HGB answers for Haemoglobin.
 *
 * `analyteKey`, never `codeKey`: the latter throws away punctuation, and on a
 * differential that would file the neutrophil PERCENTAGE against the absolute
 * count's range — the same number printed beside a result it has nothing to do
 * with.
 */
export function rangeKey(analyte: unknown): string {
  return analyteKey(canonicalAnalyte(analyte) ?? analyte);
}

export interface RangeSeed {
  analyte: string;
  sex?: RangeSex;
  /** `[value, unit]`, inclusive; omitted ends are open. */
  from?: [number, 'days' | 'weeks' | 'months' | 'years'];
  to?: [number, 'days' | 'weeks' | 'months' | 'years'];
  ageLabel?: string;
  low?: string;
  high?: string;
  unit?: string;
}

/**
 * What the laboratory's own LHIMS result-entry forms print beside each box.
 *
 * Transcribed from those forms, and offered as a starting point rather than
 * applied: every row is marked with where it came from, and the screen says it
 * must be reviewed. A laboratory that disagrees with one edits it; a laboratory
 * that would rather start from nothing never loads them.
 */
export const FORM_RANGES: RangeSeed[] = [
  /* ---- Full blood count --------------------------------------------- */
  { analyte: 'WBC', low: '4.00', high: '10.00', unit: '10^3/uL' },
  { analyte: 'RBC', sex: 'male', from: [18, 'years'], low: '4.7', high: '6.1', unit: '10^6/uL' },
  { analyte: 'RBC', sex: 'female', from: [18, 'years'], low: '4.2', high: '5.4', unit: '10^6/uL' },
  { analyte: 'RBC', to: [8, 'weeks'], ageLabel: 'Newborn', low: '4.8', high: '7.1', unit: '10^6/uL' },
  { analyte: 'RBC', from: [8, 'weeks'], to: [6, 'months'], low: '3.5', high: '5.5', unit: '10^6/uL' },
  { analyte: 'RBC', from: [6, 'months'], to: [1, 'years'], low: '3.5', high: '5.2', unit: '10^6/uL' },
  { analyte: 'RBC', from: [1, 'years'], to: [6, 'years'], low: '4.0', high: '5.5', unit: '10^6/uL' },
  { analyte: 'RBC', from: [6, 'years'], to: [18, 'years'], low: '4.0', high: '5.5', unit: '10^6/uL' },
  { analyte: 'HGB', low: '11.00', high: '16.00', unit: 'g/dL' },
  { analyte: 'HCT', sex: 'male', from: [18, 'years'], low: '42', high: '52', unit: '%' },
  { analyte: 'HCT', sex: 'female', from: [18, 'years'], low: '37', high: '47', unit: '%' },
  { analyte: 'HCT', to: [8, 'weeks'], ageLabel: 'Newborn', low: '44', high: '64', unit: '%' },
  { analyte: 'HCT', from: [8, 'weeks'], to: [6, 'months'], low: '35', high: '50', unit: '%' },
  { analyte: 'HCT', from: [6, 'months'], to: [1, 'years'], low: '29', high: '43', unit: '%' },
  { analyte: 'HCT', from: [1, 'years'], to: [6, 'years'], low: '30', high: '40', unit: '%' },
  { analyte: 'HCT', from: [6, 'years'], to: [18, 'years'], low: '32', high: '44', unit: '%' },
  { analyte: 'MCV', low: '80.0', high: '95.0', unit: 'fL' },
  { analyte: 'MCH', low: '27.0', high: '33.0', unit: 'pg' },
  { analyte: 'MCHC', low: '32.0', high: '36.0', unit: 'g/dL' },
  { analyte: 'RDW-SD', low: '37.0', high: '46.0', unit: 'fL' },
  { analyte: 'RDW-CV', low: '11.0', high: '16.0', unit: '%' },
  { analyte: 'PDW', low: '9.0', high: '14.0', unit: 'fL' },
  { analyte: 'MPV', low: '8.0', high: '12.0', unit: 'fL' },
  { analyte: 'P-LCR', low: '15.0', high: '35.0', unit: '%' },
  { analyte: 'PCT', low: '0.17', high: '0.35', unit: '%' },
  { analyte: 'NEUT#', low: '2.00', high: '7.00', unit: '10^3/uL' },
  { analyte: 'LYMPH#', low: '1.00', high: '5.00', unit: '10^3/uL' },
  { analyte: 'MONO#', low: '0.20', high: '0.60', unit: '10^3/uL' },
  { analyte: 'EO#', low: '0.03', high: '0.46', unit: '10^3/uL' },
  { analyte: 'BASO#', low: '0.01', high: '0.05', unit: '10^3/uL' },
  { analyte: 'NEUT%', low: '50.0', high: '70.0', unit: '%' },
  { analyte: 'LYMPH%', low: '25.0', high: '60.0', unit: '%' },
  { analyte: 'MONO%', low: '3.0', high: '7.0', unit: '%' },
  { analyte: 'EO%', low: '1.0', high: '3.0', unit: '%' },
  { analyte: 'BASO%', low: '0.0', high: '0.8', unit: '%' },
  { analyte: 'IG#', low: '0.00', high: '0.30', unit: '10^3/uL' },
  { analyte: 'IG%', low: '0.00', high: '0.5', unit: '%' },
  { analyte: 'RET#', low: '0.0', high: '999.9', unit: '10^9/L' },
  { analyte: 'RET%', low: '0.5', high: '2', unit: '%' },
  { analyte: 'IRF', low: '0', high: '100', unit: '%' },
  { analyte: 'LFR', low: '0', high: '100', unit: '%' },
  { analyte: 'MFR', low: '0', high: '100', unit: '%' },
  { analyte: 'HFR', low: '0', high: '100', unit: '%' },
  { analyte: 'RET-HE', low: '0', high: '99.9', unit: 'pg' },
  { analyte: 'PLT', low: '150', high: '450', unit: '10^3/uL' },

  /* ---- Urea, electrolytes and renal function -------------------------- */
  { analyte: 'UREA', low: '1.67', high: '8.35', unit: 'mmol/L' },
  { analyte: 'CREATININE', low: '53', high: '115', unit: 'umol/L' },
  { analyte: 'SODIUM', low: '135.0', high: '145.0', unit: 'mmol/L' },
  { analyte: 'POTASSIUM', low: '3.5', high: '5.5', unit: 'mmol/L' },
  { analyte: 'CHLORIDE', low: '96.0', high: '106.0', unit: 'mmol/L' },
  { analyte: 'CALCIUM', low: '2.2', high: '2.9', unit: 'mmol/L' },
  { analyte: 'IONIZED CALCIUM', low: '1', high: '1.4', unit: 'mmol/L' },

  /* ---- Liver function -------------------------------------------------- */
  { analyte: 'ALBUMIN', low: '39.70', high: '49.50', unit: 'g/L' },
  { analyte: 'TOTAL PROTEIN', low: '64.00', high: '83.00', unit: 'g/L' },
  { analyte: 'TOTAL BILIRUBIN', low: '1.71', high: '20.00', unit: 'umol/L' },
  { analyte: 'DIRECT BILIRUBIN', low: '0.0', high: '5.00', unit: 'umol/L' },
  { analyte: 'INDIRECT BILIRUBIN', low: '0.00', high: '14.00', unit: 'umol/L' },
];

export const FORM_RANGE_SOURCE = 'LHIMS result-entry forms';

/**
 * Put the starting point on the record.
 *
 * Nothing already set for a parameter is touched: a laboratory that has decided
 * its own haemoglobin range keeps it, and loading the rest costs it nothing.
 */
export function seedFormRanges(db: DB, userId: number | null): { added: number; kept: number } {
  const insert = db.prepare(`INSERT INTO rf_reference_ranges
      (analyte, analyte_key, sex, age_min_days, age_max_days, age_label, low, high, unit, source, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  /*
   * Which parameters the laboratory had already decided on BEFORE this run.
   *
   * Asked once rather than per row: several of these ranges belong to the same
   * parameter — a haematocrit has one for each age band — and a check made
   * against the table as it fills would treat the first band as a decision
   * already taken and drop the other six.
   */
  const decided = new Set<string>(
    (db.prepare('SELECT DISTINCT analyte FROM rf_reference_ranges').all() as Array<{ analyte: string }>)
      .map(row => rangeKey(row.analyte)),
  );

  let added = 0;
  let kept = 0;
  const apply = db.transaction(() => {
    for (const seed of FORM_RANGES) {
      const key = rangeKey(seed.analyte);
      // A parameter the laboratory has already decided on is left alone.
      if (decided.has(key)) { kept++; continue; }
      insert.run(
        seed.analyte, key, seed.sex ?? 'any',
        seed.from ? ageToDays(seed.from[0], seed.from[1]) : null,
        seed.to ? ageToDays(seed.to[0], seed.to[1]) : null,
        seed.ageLabel ?? null, seed.low ?? null, seed.high ?? null, seed.unit ?? null,
        FORM_RANGE_SOURCE, userId,
      );
      added++;
    }
  });
  apply();
  return { added, kept };
}
