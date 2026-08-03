// 5x5 risk assessment matrix — shared by Nonconformity and Incident/Adverse
// Event management (per SECHFO005 and ISO 22367 risk management for medical
// laboratories). Risk score = Occurrence × Severity (1..25).

export const SEVERITY = [
  { score: 1, label: 'Negligible', description: 'No patient impact, minor inconvenience' },
  { score: 2, label: 'Minor', description: 'Delay, rework needed, no harm' },
  { score: 3, label: 'Moderate', description: 'Potential impact on patient care, regulatory issue' },
  { score: 4, label: 'Critical', description: 'Likely patient harm, serious safety risk' },
  { score: 5, label: 'Catastrophic', description: 'Patient death, major system failure' },
] as const;

export const OCCURRENCE = [
  { score: 1, label: 'Rare', description: 'Has not occurred before, first time' },
  { score: 2, label: 'Unlikely', description: 'Has occurred before but not expected' },
  { score: 3, label: 'Occasional', description: 'Intermittent occurrence' },
  { score: 4, label: 'Likely', description: 'Probable to occur' },
  { score: 5, label: 'Frequent', description: 'Occurs always' },
] as const;

export type RiskLevel = 'low' | 'moderate' | 'high' | 'very_high';

export const RISK_BANDS: { level: RiskLevel; label: string; min: number; max: number; action: string; color: string }[] = [
  { level: 'low', label: 'Low', min: 1, max: 4, action: 'Acceptable — document and monitor.', color: '#1a7f37' },
  { level: 'moderate', label: 'Moderate', min: 5, max: 9, action: 'Acceptable with controls — document and investigate.', color: '#c9a227' },
  { level: 'high', label: 'High', min: 10, max: 16, action: 'Unacceptable — corrective action required.', color: '#e8590c' },
  { level: 'very_high', label: 'Very High', min: 17, max: 25, action: 'Critical — stop the process, immediate management attention.', color: '#c1121f' },
];

export function computeRisk(occurrence: unknown, severity: unknown): { occurrence: number | null; severity: number | null; score: number | null; level: RiskLevel | null; levelLabel: string | null; action: string | null } {
  const o = Number(occurrence), s = Number(severity);
  const validO = Number.isFinite(o) && o >= 1 && o <= 5;
  const validS = Number.isFinite(s) && s >= 1 && s <= 5;
  if (!validO || !validS) return { occurrence: validO ? o : null, severity: validS ? s : null, score: null, level: null, levelLabel: null, action: null };
  const score = o * s;
  const band = RISK_BANDS.find(b => score >= b.min && score <= b.max)!;
  return { occurrence: o, severity: s, score, level: band.level, levelLabel: band.label, action: band.action };
}

// Legacy severity words → an approximate severity score, so records created
// before the 5x5 matrix still map onto it.
export function severityWordToScore(word: unknown): number | null {
  const w = String(word ?? '').toLowerCase();
  if (/catastroph|death/.test(w)) return 5;
  if (/critical|severe|high/.test(w)) return 4;
  if (/moderate|medium|major/.test(w)) return 3;
  if (/minor|low/.test(w)) return 2;
  if (/negligible|trivial/.test(w)) return 1;
  return null;
}
