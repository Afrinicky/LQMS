/**
 * Deciding whether a control run passed.
 *
 * One entry point for every kind of control, because the bench should not have
 * to know which rules apply — the material's definition already says. A
 * quantitative analyte goes through Westgard, a qualitative one is compared
 * with the result it was supposed to give, a semi-quantitative one is checked
 * against its range. The run's verdict is the worst of its analytes, and that
 * verdict is what decides whether patient results may be reported.
 */
import type { IqcControlType, IqcRuleProfile } from '../../shared/constants/iqc.js';
import { isRejection, RULE_LABELS } from '../../shared/constants/iqc.js';

export type AnalyteDef = {
  id: number;
  analyte: string;
  unit: string | null;
  target_mean: number | null;
  target_sd: number | null;
  acceptable_low: number | null;
  acceptable_high: number | null;
  expected_result: string | null;
  // Culture & sensitivity: the agent's test method and the interpretive
  // category (S/SDD/I/R/NS) the reference strain is expected to give.
  ast_method?: string | null;
  expected_interpretation?: string | null;
};

/** One reading being submitted for one analyte. */
export type Reading = {
  analyteId: number;
  value?: number | null;
  qualitativeResult?: string | null;
  /** Culture & sensitivity: observed interpretive category for this agent. */
  interpretation?: string | null;
};

/** The organism identity check for a culture & sensitivity run. */
export type OrganismCheck = { expected: string | null; observed: string | null };

/** Earlier accepted readings for the same analyte, most recent first. */
export type History = Record<number, number[]>;

export type AnalyteVerdict = {
  analyteId: number;
  analyte: string;
  value: number | null;
  qualitativeResult: string | null;
  expectedResult: string | null;
  zScore: number | null;
  status: 'accepted' | 'warning' | 'out_of_control';
  rule: string | null;
};

export type RunVerdict = {
  status: 'in_control' | 'warning' | 'out_of_control';
  ruleSummary: string | null;
  analytes: AnalyteVerdict[];
  /** False when the run must stop patient results going out. */
  mayReleasePatientResults: boolean;
};

const num = (v: unknown): number | null =>
  v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v);

/**
 * Westgard, evaluated against this analyte's own history.
 *
 * `priorZ` is most-recent-first and holds only readings that were themselves
 * accepted — a rejected run is investigated and repeated, so carrying it into
 * a run-of-ten would keep re-flagging work that was already dealt with.
 *
 * `siblingZ` is the other analytes in the SAME run, which is what makes 2of3₂ₛ
 * and the across-material form of R₄ₛ meaningful.
 */
function westgard(
  z: number,
  priorZ: number[],
  siblingZ: number[],
  profile: IqcRuleProfile,
): { status: AnalyteVerdict['status']; rule: string } {
  if (Math.abs(z) > 3) return { status: 'out_of_control', rule: 'reject_1_3s' };
  if (profile === 'westgard_simple') return { status: 'accepted', rule: 'within_control' };

  if (Math.abs(z) > 2) {
    const prev = priorZ[0];
    if (prev !== undefined && Math.abs(prev) > 2 && Math.sign(prev) === Math.sign(z)) {
      return { status: 'out_of_control', rule: 'reject_2_2s' };
    }
    if (prev !== undefined && Math.abs(z - prev) >= 4 && Math.sign(prev) !== Math.sign(z)) {
      return { status: 'out_of_control', rule: 'reject_R_4s' };
    }
    if (siblingZ.some(s => Math.sign(s) === Math.sign(z) && Math.abs(s) > 2)) {
      return { status: 'out_of_control', rule: 'reject_2of3_2s' };
    }
    if (siblingZ.some(s => Math.sign(s) !== Math.sign(z) && Math.abs(z - s) >= 4)) {
      return { status: 'out_of_control', rule: 'reject_R_4s' };
    }
    return { status: 'warning', rule: 'warning_1_2s' };
  }

  if (priorZ.length >= 3) {
    const window4 = [z, ...priorZ.slice(0, 3)];
    if (window4.every(v => v > 1) || window4.every(v => v < -1)) {
      return { status: 'out_of_control', rule: 'reject_4_1s' };
    }
  }
  if (priorZ.length >= 9) {
    const window10 = [z, ...priorZ.slice(0, 9)];
    if (window10.every(v => v > 0) || window10.every(v => v < 0)) {
      return { status: 'out_of_control', rule: 'reject_10x' };
    }
  }
  return { status: 'accepted', rule: 'within_control' };
}

/**
 * Culture & sensitivity, judged categorically.
 *
 * The reference strain has to identify as the expected organism, and each
 * antimicrobial has to give the expected interpretive category (S/SDD/I/R/NS).
 * A mismatch on either stops patient susceptibilities going out, the same way
 * a rejected quantitative run stops numeric results. The organism check rides
 * as a synthetic verdict with analyteId 0 so it appears in the summary without
 * needing an analyte row of its own.
 */
function evaluateCultureSensitivity(
  analytes: AnalyteDef[],
  readings: Reading[],
  organism?: OrganismCheck,
): RunVerdict {
  const byId = new Map(analytes.map(a => [a.id, a]));
  const verdicts: AnalyteVerdict[] = [];

  if (organism && (organism.expected ?? '').trim()) {
    const expected = (organism.expected ?? '').trim();
    const observed = (organism.observed ?? '').trim();
    const ok = observed && observed.toLowerCase() === expected.toLowerCase();
    verdicts.push({
      analyteId: 0, analyte: 'Organism identification',
      value: null, qualitativeResult: observed || null, expectedResult: expected,
      zScore: null, status: ok ? 'accepted' : 'out_of_control', rule: ok ? 'within_control' : 'organism_mismatch',
    });
  }

  for (const r of readings) {
    const def = byId.get(r.analyteId);
    if (!def) continue;
    const observed = (r.interpretation ?? r.qualitativeResult ?? '').trim();
    const expected = (def.expected_interpretation ?? '').trim();
    const base = {
      analyteId: def.id, analyte: def.analyte,
      value: null, qualitativeResult: observed || null, expectedResult: expected || null, zScore: null,
    };
    if (!expected) {
      // No expected category recorded for this agent — nothing to judge it
      // against, so it is noted but does not fail the run.
      verdicts.push({ ...base, status: 'accepted', rule: 'within_control' });
    } else if (!observed) {
      verdicts.push({ ...base, status: 'out_of_control', rule: 'interpretation_mismatch' });
    } else {
      const ok = observed.toLowerCase() === expected.toLowerCase();
      verdicts.push({ ...base, status: ok ? 'accepted' : 'out_of_control', rule: ok ? 'within_control' : 'interpretation_mismatch' });
    }
  }

  const rejected = verdicts.filter(v => v.status === 'out_of_control');
  const say = (v: AnalyteVerdict) => `${v.analyte}: ${RULE_LABELS[v.rule ?? ''] ?? v.rule}`;
  return {
    status: rejected.length ? 'out_of_control' : 'in_control',
    ruleSummary: rejected.length ? rejected.map(say).join('; ') : null,
    analytes: verdicts,
    mayReleasePatientResults: !verdicts.some(v => isRejection(v.rule)),
  };
}

/** Evaluate a whole run: every analyte, then the run's overall verdict. */
export function evaluateRun(
  controlType: IqcControlType,
  ruleProfile: IqcRuleProfile,
  analytes: AnalyteDef[],
  readings: Reading[],
  history: History,
  organism?: OrganismCheck,
): RunVerdict {
  // ---- Culture & sensitivity: organism identity plus categorical AST -------
  // Judged purely on the interpretive category the reference strain gives
  // (S/SDD/I/R/NS) and on the organism identification — not on numeric zone or
  // MIC breakpoints. Its own path, because it is neither a number nor a single
  // reactive/non-reactive call.
  if (controlType === 'culture_sensitivity') {
    return evaluateCultureSensitivity(analytes, readings, organism);
  }

  const byId = new Map(analytes.map(a => [a.id, a]));

  // z-scores for the run, computed first so each analyte can see its siblings.
  const zById = new Map<number, number>();
  if (controlType === 'quantitative') {
    for (const r of readings) {
      const def = byId.get(r.analyteId);
      const value = num(r.value);
      if (!def || value === null) continue;
      const mean = num(def.target_mean);
      const sd = num(def.target_sd);
      if (mean === null || sd === null || sd <= 0) continue;
      zById.set(r.analyteId, (value - mean) / sd);
    }
  }

  const verdicts: AnalyteVerdict[] = [];
  for (const r of readings) {
    const def = byId.get(r.analyteId);
    if (!def) continue;

    const base = {
      analyteId: def.id,
      analyte: def.analyte,
      value: num(r.value),
      qualitativeResult: r.qualitativeResult ?? null,
      expectedResult: def.expected_result ?? null,
    };

    // ---- Qualitative: it either gave the expected result or it did not -----
    if (controlType === 'qualitative' || ruleProfile === 'match_expected') {
      const observed = (r.qualitativeResult ?? '').trim();
      const expected = (def.expected_result ?? '').trim();
      if (!observed) {
        verdicts.push({ ...base, zScore: null, status: 'out_of_control', rule: 'expected_mismatch' });
      } else if (expected && observed !== expected) {
        verdicts.push({ ...base, zScore: null, status: 'out_of_control', rule: 'expected_mismatch' });
      } else {
        verdicts.push({ ...base, zScore: null, status: 'accepted', rule: 'within_control' });
      }
      continue;
    }

    const value = num(r.value);
    if (value === null) {
      verdicts.push({ ...base, zScore: null, status: 'out_of_control', rule: 'out_of_range' });
      continue;
    }

    // ---- Acceptable range applies to every numeric control -----------------
    const low = num(def.acceptable_low);
    const high = num(def.acceptable_high);
    if ((low !== null && value < low) || (high !== null && value > high)) {
      verdicts.push({ ...base, zScore: zById.get(def.id) ?? null, status: 'out_of_control', rule: 'out_of_range' });
      continue;
    }

    // ---- Semi-quantitative stops at the range ------------------------------
    if (controlType === 'semi_quantitative' || ruleProfile === 'range_only') {
      verdicts.push({ ...base, zScore: null, status: 'accepted', rule: 'within_control' });
      continue;
    }

    // ---- Quantitative: statistics, if the target supports them -------------
    const z = zById.get(def.id);
    if (z === undefined) {
      // No usable mean/SD yet — a brand-new lot before its own mean is
      // established. The range check above still applied.
      verdicts.push({ ...base, zScore: null, status: 'accepted', rule: 'within_control' });
      continue;
    }
    const siblingZ = [...zById.entries()].filter(([id]) => id !== def.id).map(([, v]) => v);
    const outcome = westgard(z, history[def.id] ?? [], siblingZ, ruleProfile);
    verdicts.push({ ...base, zScore: z, status: outcome.status, rule: outcome.rule });
  }

  const rejected = verdicts.filter(v => v.status === 'out_of_control');
  const warned = verdicts.filter(v => v.status === 'warning');
  const status: RunVerdict['status'] = rejected.length ? 'out_of_control' : warned.length ? 'warning' : 'in_control';

  // The summary is read on a dashboard alert and on a printed record, so it
  // names the rule the way a laboratory says it (1₃ₛ), not the way it is keyed.
  const say = (v: AnalyteVerdict) => `${v.analyte}: ${RULE_LABELS[v.rule ?? ''] ?? v.rule}`;
  const summary = rejected.length
    ? rejected.map(say).join('; ')
    : warned.length
      ? warned.map(say).join('; ')
      : null;

  return {
    status,
    ruleSummary: summary,
    analytes: verdicts,
    // A warning is a warning: work continues. A rejection stops reporting
    // until somebody has investigated and recorded what they did.
    mayReleasePatientResults: !verdicts.some(v => isRejection(v.rule)),
  };
}

/**
 * The statistics an assessor asks for on a Levey-Jennings chart: what the
 * control ACTUALLY did over the period, next to what it was supposed to do.
 */
export function chartStatistics(values: number[], targetMean: number | null, targetSd: number | null) {
  const n = values.length;
  if (n === 0) return { n: 0, mean: null, sd: null, cv: null, bias: null, biasPercent: null, sdIndex: null };
  const mean = values.reduce((a, b) => a + b, 0) / n;
  // Sample standard deviation (n−1): these are observations of a process, not
  // a whole population, which is the form every QC textbook and assessor uses.
  const sd = n > 1 ? Math.sqrt(values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (n - 1)) : null;
  const cv = sd !== null && mean !== 0 ? (sd / Math.abs(mean)) * 100 : null;
  const bias = targetMean !== null && targetMean !== undefined ? mean - targetMean : null;
  const biasPercent = bias !== null && targetMean ? (bias / Math.abs(targetMean)) * 100 : null;
  // How far the observed mean sits from target in units of the target SD.
  const sdIndex = bias !== null && targetSd ? bias / targetSd : null;
  return { n, mean, sd, cv, bias, biasPercent, sdIndex };
}
