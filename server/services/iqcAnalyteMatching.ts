/**
 * Lining an analyser's parameters up against a control's.
 *
 * Whatever door the numbers came through — pasted, uploaded, scanned, or off
 * the analyser's own transmission — the question is the same: which of this
 * control's parameters is this label, and what number goes with it. So the
 * answer lives in one place. Two screens matching "HGB" to different analytes
 * is how a control record stops meaning anything.
 *
 * The matching is deliberately unwilling to guess. A label matches exactly, or
 * through a named synonym, or by an UNAMBIGUOUS prefix — "MCH" against a
 * control holding both MCH and MCHC matches nothing, which is the right
 * answer, because a value in the wrong row is worse than a value in no row.
 */

const SYNONYMS: Record<string, string[]> = {
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

export function normalise(value: unknown): string {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function synonymGroup(name: string): string | null {
  const key = normalise(name);
  for (const [group, members] of Object.entries(SYNONYMS)) {
    if (members.includes(key) || normalise(group) === key) return group;
  }
  return null;
}

/** Find the analyte a label refers to, or nothing. Never a near-miss. */
export function findAnalyte(label: string, analytes: any[]): any | null {
  const target = normalise(label);
  if (!target) return null;
  const exact = analytes.find(a => normalise(a.analyte) === target);
  if (exact) return exact;

  const group = synonymGroup(label);
  if (group) {
    const bySynonym = analytes.find(a => synonymGroup(a.analyte) === group);
    if (bySynonym) return bySynonym;
  }

  // A prefix match, but only where it is unambiguous. "MCH" against a control
  // holding both MCH and MCHC matches nothing, which is the correct answer.
  const prefix = analytes.filter(a => {
    const candidate = normalise(a.analyte);
    return candidate.startsWith(target) || target.startsWith(candidate);
  });
  return prefix.length === 1 ? prefix[0] : null;
}

/**
 * Which of several labels for one reading this control actually knows.
 *
 * An analyser sends a parameter under its own mnemonic, and the link may also
 * carry a mapped name for it: HGB and Haemoglobin, for the same number. Which
 * of the two a control recognises depends on how the control was defined —
 * one laboratory writes "Haemoglobin", another writes "HGB" — so both are
 * tried rather than one being chosen in advance and the reading lost when the
 * guess is wrong.
 *
 * The first that resolves wins; where neither does, the first non-empty one is
 * returned so the bench is told which label went unrecognised rather than
 * being shown a blank.
 */
export function bestLabel(candidates: Array<string | null | undefined>, analytes: any[]): string {
  const offered = candidates.map(c => String(c ?? '').trim()).filter(Boolean);
  for (const label of offered) if (findAnalyte(label, analytes)) return label;
  return offered[0] ?? '';
}

/** Split pasted text on tabs, then on commas, then on runs of spaces. */
export function splitPasted(text: string): any[][] {
  const lines = text.replace(/\r/g, '').split('\n').filter(l => l.trim() !== '');
  if (!lines.length) return [];
  const delimiter = lines[0].includes('\t') ? '\t' : lines[0].includes(',') ? ',' : null;
  return lines.map(line => (delimiter ? line.split(delimiter) : line.trim().split(/\s{2,}/)).map(c => c.trim()));
}

export function numberFrom(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  // Analysers decorate values: "12.4 H", "*8.9", "< 0.5". Take the number.
  const match = String(value).replace(/,/g, '.').match(/-?\d+(\.\d+)?/);
  if (!match) return null;
  const num = Number(match[0]);
  return Number.isFinite(num) ? num : null;
}

/**
 * Which way round is the pasted block?
 *
 * Decided by counting how many of the control's parameters are recognisable
 * down the first column versus across the first row — evidence, rather than a
 * rule about how analysers "usually" print.
 */
export function detectOrientation(grid: any[][], analytes: any[]): 'rows' | 'columns' {
  const downFirstColumn = grid.filter(row => Array.isArray(row) && findAnalyte(String(row[0] ?? ''), analytes)).length;
  const acrossFirstRow = (grid[0] ?? []).filter(cell => findAnalyte(String(cell ?? ''), analytes)).length;
  return acrossFirstRow > downFirstColumn ? 'columns' : 'rows';
}

export interface Mapping {
  readings: Array<{
    analyteId: number; analyte: string; unit: string | null;
    value: number | null; qualitativeResult?: string | null; raw: string;
    /**
     * The label this reading was recognised BY, which is not always the
     * control's own name for it: a Sysmex sends PLT, the control may call the
     * parameter Platelets, and a screen showing the transmission beside the
     * control has to be able to say which line filled which box.
     */
    label: string;
  }>;
  unmatchedLabels: string[];
  missingAnalytes: Array<{ analyteId: number; analyte: string }>;
  matched: number;
}

/** One parameter per row: name in the first column, value in the next usable one. */
export function mapRows(grid: any[][], analytes: any[]): Mapping {
  const readings: Mapping['readings'] = [];
  const unmatched: string[] = [];
  const seen = new Set<number>();

  for (const row of grid) {
    if (!Array.isArray(row) || !row.length) continue;
    const label = String(row[0] ?? '').trim();
    if (!label) continue;
    const analyte = findAnalyte(label, analytes);
    if (!analyte) {
      if (row.slice(1).some(c => numberFrom(c) !== null)) unmatched.push(label);
      continue;
    }
    if (seen.has(Number(analyte.id))) continue;
    // The first cell after the name that holds a number. Analysers put a unit,
    // a flag or a blank between the name and the value often enough that
    // taking column 2 blindly is wrong.
    let value: number | null = null;
    let raw = '';
    for (const cell of row.slice(1)) {
      const num = numberFrom(cell);
      if (num !== null) { value = num; raw = String(cell); break; }
    }
    const qualitative = value === null ? qualitativeFrom(row.slice(1)) : null;
    if (value === null && !qualitative) continue;
    seen.add(Number(analyte.id));
    readings.push({
      analyteId: Number(analyte.id), analyte: analyte.analyte, unit: analyte.unit ?? null,
      value, qualitativeResult: qualitative, raw: raw || qualitative || '', label,
    });
  }

  return {
    readings, unmatchedLabels: [...new Set(unmatched)].slice(0, 20),
    missingAnalytes: analytes.filter(a => !seen.has(Number(a.id))).map(a => ({ analyteId: Number(a.id), analyte: a.analyte })),
    matched: readings.length,
  };
}

/** One parameter per column: names across the top, values on the row below. */
export function mapColumns(grid: any[][], analytes: any[]): Mapping {
  const header = grid[0] ?? [];
  // The first row under the header that carries numbers is the result row; a
  // spreadsheet often has a units row in between.
  const valueRow = grid.slice(1).find(row => Array.isArray(row) && row.some(c => numberFrom(c) !== null)) ?? [];

  const readings: Mapping['readings'] = [];
  const unmatched: string[] = [];
  const seen = new Set<number>();

  header.forEach((cell, index) => {
    const label = String(cell ?? '').trim();
    if (!label) return;
    const analyte = findAnalyte(label, analytes);
    if (!analyte) {
      if (numberFrom(valueRow[index]) !== null) unmatched.push(label);
      return;
    }
    if (seen.has(Number(analyte.id))) return;
    const value = numberFrom(valueRow[index]);
    const qualitative = value === null ? qualitativeFrom([valueRow[index]]) : null;
    if (value === null && !qualitative) return;
    seen.add(Number(analyte.id));
    readings.push({
      analyteId: Number(analyte.id), analyte: analyte.analyte, unit: analyte.unit ?? null,
      value, qualitativeResult: qualitative, raw: String(valueRow[index] ?? ''), label,
    });
  });

  return {
    readings, unmatchedLabels: [...new Set(unmatched)].slice(0, 20),
    missingAnalytes: analytes.filter(a => !seen.has(Number(a.id))).map(a => ({ analyteId: Number(a.id), analyte: a.analyte })),
    matched: readings.length,
  };
}

/** A reactive/non-reactive style result, for the qualitative controls. */
export function qualitativeFrom(cells: unknown[]): string | null {
  const words: Record<string, string> = {
    reactive: 'reactive', nonreactive: 'non_reactive', 'non-reactive': 'non_reactive',
    positive: 'positive', negative: 'negative', pos: 'positive', neg: 'negative',
    detected: 'detected', notdetected: 'not_detected', 'not-detected': 'not_detected',
  };
  for (const cell of cells) {
    const key = String(cell ?? '').trim().toLowerCase().replace(/\s+/g, '');
    if (words[key]) return words[key];
  }
  return null;
}
