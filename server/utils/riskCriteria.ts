// ==========================================================================
// User-defined risk criteria.
//
// The laboratory decides what its 5x5 matrix means: how each likelihood and
// severity step is worded, where the bands begin and end, which band forces
// treatment, how often each band is reviewed, and who may accept a residual
// risk. Everything here ships with a sensible default and is overridden by
// whatever the laboratory saves in Settings -> System -> Risk Criteria.
//
// Stored as one JSON value in `settings` under `risk.criteria`, so a lab that
// has never opened the settings page simply gets the defaults.
// ==========================================================================

export type ScaleStep = { score: number; label: string; description: string };
export type RiskBand = { level: string; label: string; min: number; max: number; action: string; color: string; reviewMonths: number };

export type RiskCriteria = {
  likelihood: ScaleStep[];
  severity: ScaleStep[];
  bands: RiskBand[];
  /** Lowest band that must be treated rather than simply accepted. */
  treatmentThresholdLevel: string;
  /** Residual re-assessment is mandatory before acceptance. */
  requireResidualAssessment: boolean;
  /** Roles permitted to record the final acceptance decision. */
  acceptanceRoles: string[];
  /** Always treat a risk flagged as affecting patient safety, whatever its band. */
  alwaysTreatPatientSafety: boolean;
};

export const DEFAULT_RISK_CRITERIA: RiskCriteria = {
  likelihood: [
    { score: 1, label: 'Rare', description: 'Has not occurred before; not expected' },
    { score: 2, label: 'Unlikely', description: 'Has occurred before but is not expected' },
    { score: 3, label: 'Possible', description: 'Intermittent occurrence' },
    { score: 4, label: 'Likely', description: 'Probable to occur' },
    { score: 5, label: 'Almost certain', description: 'Occurs routinely' },
  ],
  severity: [
    { score: 1, label: 'Negligible', description: 'No patient impact; minor inconvenience' },
    { score: 2, label: 'Minor', description: 'Delay or rework needed; no harm' },
    { score: 3, label: 'Moderate', description: 'Potential impact on patient care or compliance' },
    { score: 4, label: 'Major', description: 'Likely patient harm; serious safety risk' },
    { score: 5, label: 'Catastrophic', description: 'Patient death or major system failure' },
  ],
  bands: [
    { level: 'low', label: 'Low', min: 1, max: 4, action: 'Acceptable — document and monitor.', color: '#1a7f37', reviewMonths: 12 },
    { level: 'moderate', label: 'Medium', min: 5, max: 9, action: 'Acceptable with controls — treat where practicable.', color: '#c9a227', reviewMonths: 6 },
    { level: 'high', label: 'High', min: 10, max: 16, action: 'Not acceptable — treatment plan required.', color: '#e8590c', reviewMonths: 3 },
    { level: 'very_high', label: 'Very High', min: 17, max: 25, action: 'Critical — stop the activity and escalate to management.', color: '#c1121f', reviewMonths: 1 },
  ],
  treatmentThresholdLevel: 'moderate',
  requireResidualAssessment: true,
  acceptanceRoles: ['System Administrator', 'Laboratory Manager', 'Quality Manager'],
  alwaysTreatPatientSafety: true,
};

/** Band rank, lowest first, used to compare a risk against the threshold. */
export function bandRank(criteria: RiskCriteria, level: string | null | undefined): number {
  if (!level) return 0;
  const idx = criteria.bands.findIndex(b => b.level === level);
  return idx < 0 ? 0 : idx + 1;
}

export function bandForScore(criteria: RiskCriteria, score: number): RiskBand | null {
  return criteria.bands.find(b => score >= b.min && score <= b.max)
    ?? criteria.bands[criteria.bands.length - 1]
    ?? null;
}

export type RiskEvaluation = {
  likelihood: number | null; severity: number | null; score: number | null;
  level: string | null; levelLabel: string | null; action: string | null; color: string | null;
};

export function evaluateRisk(criteria: RiskCriteria, likelihood: unknown, severity: unknown): RiskEvaluation {
  const l = Number(likelihood), s = Number(severity);
  const okL = Number.isFinite(l) && l >= 1 && l <= 5;
  const okS = Number.isFinite(s) && s >= 1 && s <= 5;
  if (!okL || !okS) return { likelihood: okL ? l : null, severity: okS ? s : null, score: null, level: null, levelLabel: null, action: null, color: null };
  const score = l * s;
  const band = bandForScore(criteria, score);
  return { likelihood: l, severity: s, score, level: band?.level ?? null, levelLabel: band?.label ?? null, action: band?.action ?? null, color: band?.color ?? null };
}

/** True when the configured criteria say this risk cannot simply be accepted. */
export function requiresTreatment(criteria: RiskCriteria, level: string | null, affectsPatientSafety: boolean): boolean {
  if (affectsPatientSafety && criteria.alwaysTreatPatientSafety) return true;
  const threshold = bandRank(criteria, criteria.treatmentThresholdLevel);
  return threshold > 0 && bandRank(criteria, level) >= threshold;
}

/** Next review date for a risk sitting in the given band. */
export function nextReviewDate(criteria: RiskCriteria, level: string | null, from = new Date()): string | null {
  const band = criteria.bands.find(b => b.level === level);
  if (!band) return null;
  const d = new Date(from.getTime());
  d.setMonth(d.getMonth() + Math.max(1, Number(band.reviewMonths) || 1));
  return d.toISOString().slice(0, 10);
}

// --- persistence ----------------------------------------------------------

function sanitiseScale(input: unknown, fallback: ScaleStep[]): ScaleStep[] {
  if (!Array.isArray(input) || input.length !== 5) return fallback;
  return fallback.map((def, i) => {
    const row = input[i] as Partial<ScaleStep> | undefined;
    return {
      score: i + 1,
      label: String(row?.label ?? def.label).trim().slice(0, 60) || def.label,
      description: String(row?.description ?? def.description).trim().slice(0, 200),
    };
  });
}

function sanitiseBands(input: unknown, fallback: RiskBand[]): RiskBand[] {
  if (!Array.isArray(input) || input.length !== fallback.length) return fallback;
  const bands = fallback.map((def, i) => {
    const row = input[i] as Partial<RiskBand> | undefined;
    const min = Number(row?.min); const max = Number(row?.max);
    return {
      level: def.level,
      label: String(row?.label ?? def.label).trim().slice(0, 40) || def.label,
      min: Number.isFinite(min) ? Math.min(25, Math.max(1, Math.round(min))) : def.min,
      max: Number.isFinite(max) ? Math.min(25, Math.max(1, Math.round(max))) : def.max,
      action: String(row?.action ?? def.action).trim().slice(0, 240) || def.action,
      color: /^#[0-9a-fA-F]{6}$/.test(String(row?.color)) ? String(row?.color) : def.color,
      reviewMonths: Number.isFinite(Number(row?.reviewMonths)) ? Math.min(60, Math.max(1, Math.round(Number(row?.reviewMonths)))) : def.reviewMonths,
    };
  });
  // Bands must climb without gaps or overlaps, otherwise a score falls nowhere.
  for (let i = 0; i < bands.length; i++) {
    if (bands[i].max < bands[i].min) bands[i].max = bands[i].min;
    if (i > 0 && bands[i].min !== bands[i - 1].max + 1) bands[i].min = bands[i - 1].max + 1;
    if (bands[i].max < bands[i].min) bands[i].max = bands[i].min;
  }
  bands[0].min = 1;
  bands[bands.length - 1].max = 25;
  return bands;
}

export function riskCriteria(db: any): RiskCriteria {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'risk.criteria'").get() as { value?: string } | undefined;
  if (!row?.value) return DEFAULT_RISK_CRITERIA;
  let parsed: any;
  try { parsed = JSON.parse(row.value); } catch { return DEFAULT_RISK_CRITERIA; }
  const levels = DEFAULT_RISK_CRITERIA.bands.map(b => b.level);
  return {
    likelihood: sanitiseScale(parsed.likelihood, DEFAULT_RISK_CRITERIA.likelihood),
    severity: sanitiseScale(parsed.severity, DEFAULT_RISK_CRITERIA.severity),
    bands: sanitiseBands(parsed.bands, DEFAULT_RISK_CRITERIA.bands),
    treatmentThresholdLevel: levels.includes(parsed.treatmentThresholdLevel) || parsed.treatmentThresholdLevel === 'off'
      ? parsed.treatmentThresholdLevel : DEFAULT_RISK_CRITERIA.treatmentThresholdLevel,
    requireResidualAssessment: parsed.requireResidualAssessment === undefined ? DEFAULT_RISK_CRITERIA.requireResidualAssessment : !!parsed.requireResidualAssessment,
    acceptanceRoles: Array.isArray(parsed.acceptanceRoles) && parsed.acceptanceRoles.length
      ? parsed.acceptanceRoles.map((r: unknown) => String(r)).slice(0, 12) : DEFAULT_RISK_CRITERIA.acceptanceRoles,
    alwaysTreatPatientSafety: parsed.alwaysTreatPatientSafety === undefined ? DEFAULT_RISK_CRITERIA.alwaysTreatPatientSafety : !!parsed.alwaysTreatPatientSafety,
  };
}

export function saveRiskCriteria(db: any, patch: Partial<RiskCriteria>): RiskCriteria {
  const merged = { ...riskCriteria(db), ...patch };
  const clean: RiskCriteria = {
    likelihood: sanitiseScale(merged.likelihood, DEFAULT_RISK_CRITERIA.likelihood),
    severity: sanitiseScale(merged.severity, DEFAULT_RISK_CRITERIA.severity),
    bands: sanitiseBands(merged.bands, DEFAULT_RISK_CRITERIA.bands),
    treatmentThresholdLevel: merged.treatmentThresholdLevel,
    requireResidualAssessment: !!merged.requireResidualAssessment,
    acceptanceRoles: merged.acceptanceRoles,
    alwaysTreatPatientSafety: !!merged.alwaysTreatPatientSafety,
  };
  db.prepare("INSERT INTO settings (key, value) VALUES ('risk.criteria', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP")
    .run(JSON.stringify(clean));
  return riskCriteria(db);
}

export function canAcceptRisk(db: any, roleId: number, criteria: RiskCriteria): boolean {
  const role = db.prepare('SELECT name FROM roles WHERE id = ?').get(roleId) as { name: string } | undefined;
  return !!role && criteria.acceptanceRoles.includes(role.name);
}
