// 5x5 risk assessment matrix — the single scale every module scores risk on.
// Risk score = row (occurrence / likelihood) x column (severity), 1..25.
//
// The wording of each step, the band boundaries, their colours and the action
// each band calls for are the laboratory's own configuration (Settings ->
// System -> Risk Criteria). Everything here reads that configuration, so a
// change made once applies to risk management, nonconformities, incidents and
// every printed record alike. The exported constants remain the shipped
// defaults, used before a laboratory has configured anything of its own.
import { getDb } from '../db/database.js';
import { DEFAULT_RISK_CRITERIA, riskCriteria, bandForScore, type RiskCriteria } from './riskCriteria.js';

export const SEVERITY = DEFAULT_RISK_CRITERIA.severity;
export const OCCURRENCE = DEFAULT_RISK_CRITERIA.likelihood;

export type RiskLevel = 'low' | 'moderate' | 'high' | 'very_high';

export const RISK_BANDS: { level: RiskLevel; label: string; min: number; max: number; action: string; color: string }[] =
  DEFAULT_RISK_CRITERIA.bands as { level: RiskLevel; label: string; min: number; max: number; action: string; color: string }[];

/** The laboratory's configured criteria, falling back to the defaults. */
export function activeCriteria(): RiskCriteria {
  try { return riskCriteria(getDb()); } catch { return DEFAULT_RISK_CRITERIA; }
}

export function computeRisk(occurrence: unknown, severity: unknown, criteria: RiskCriteria = activeCriteria()): {
  occurrence: number | null; severity: number | null; score: number | null;
  level: RiskLevel | null; levelLabel: string | null; action: string | null;
} {
  const o = Number(occurrence), s = Number(severity);
  const validO = Number.isFinite(o) && o >= 1 && o <= 5;
  const validS = Number.isFinite(s) && s >= 1 && s <= 5;
  if (!validO || !validS) return { occurrence: validO ? o : null, severity: validS ? s : null, score: null, level: null, levelLabel: null, action: null };
  const score = o * s;
  const band = bandForScore(criteria, score);
  return { occurrence: o, severity: s, score, level: (band?.level ?? null) as RiskLevel | null, levelLabel: band?.label ?? null, action: band?.action ?? null };
}

/** Legacy severity words -> an approximate severity score, so records created
 *  before the 5x5 matrix still map onto it. */
export function severityWordToScore(word: unknown): number | null {
  const w = String(word ?? '').toLowerCase();
  if (/catastroph|death/.test(w)) return 5;
  if (/critical|severe|high/.test(w)) return 4;
  if (/moderate|medium|major/.test(w)) return 3;
  if (/minor|low/.test(w)) return 2;
  if (/negligible|trivial/.test(w)) return 1;
  return null;
}
