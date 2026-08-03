import { generateRecordNumber } from './recordNumber.js';

// ==========================================================================
// Auto-escalation rules for nonconformities and incidents / adverse events.
//
// ISO 15189:2022 §7.5 / §8.7 and ISO 22367 require the depth of investigation
// to be proportionate to risk, and require events affecting patient safety to
// be acted on regardless of how unlikely they are. These rules encode that:
//
//   * a risk level at or above the configured threshold escalates the event to
//     root-cause analysis and corrective action automatically;
//   * an event flagged as affecting patient safety escalates automatically even
//     when its computed risk band is only Low or Medium.
//
// Everything here is configuration-driven so each laboratory can tune the
// thresholds to its own quality manual.
// ==========================================================================

export type EscalationConfig = {
  remedialActionEnabled: boolean;
  /** Lowest risk level that auto-escalates: 'off' disables the rule. */
  autoEscalateRiskLevel: 'off' | 'moderate' | 'high' | 'very_high';
  /** Escalate patient-safety events regardless of their risk band. */
  autoEscalatePatientSafety: boolean;
  /** Raise the CAPA record automatically once an event escalates. */
  autoCreateCapaOnEscalation: boolean;
};

export const DEFAULT_ESCALATION: EscalationConfig = {
  remedialActionEnabled: true,
  autoEscalateRiskLevel: 'high',
  autoEscalatePatientSafety: true,
  autoCreateCapaOnEscalation: true,
};

const RANK: Record<string, number> = { low: 1, moderate: 2, high: 3, very_high: 4 };
const LEVEL_LABEL: Record<string, string> = { low: 'Low', moderate: 'Medium', high: 'High', very_high: 'Very High' };

function readBool(db: any, key: string, fallback: boolean): boolean {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? row.value === '1' : fallback;
}

/** Reads the laboratory's quality-workflow configuration. */
export function workflowConfig(db: any): EscalationConfig {
  const lvlRow = db.prepare("SELECT value FROM settings WHERE key = 'nc.autoEscalateRiskLevel'").get() as { value: string } | undefined;
  const lvl = lvlRow?.value as EscalationConfig['autoEscalateRiskLevel'] | undefined;
  return {
    remedialActionEnabled: readBool(db, 'nc.remedialActionEnabled', DEFAULT_ESCALATION.remedialActionEnabled),
    autoEscalateRiskLevel: lvl && ['off', 'moderate', 'high', 'very_high'].includes(lvl) ? lvl : DEFAULT_ESCALATION.autoEscalateRiskLevel,
    autoEscalatePatientSafety: readBool(db, 'nc.autoEscalatePatientSafety', DEFAULT_ESCALATION.autoEscalatePatientSafety),
    autoCreateCapaOnEscalation: readBool(db, 'nc.autoCreateCapaOnEscalation', DEFAULT_ESCALATION.autoCreateCapaOnEscalation),
  };
}

export type EscalationDecision = {
  /** True when the rules force root-cause analysis + corrective action. */
  escalated: boolean;
  rcaRequired: boolean;
  createCapa: boolean;
  reason: string | null;
};

/**
 * Applies the configured rules to one assessed event. `manualRcaRequired` is
 * the assessor's own choice — the rules can force RCA on, but never off, so an
 * assessor may always ask for a deeper investigation than the rules demand.
 */
export function decideEscalation(cfg: EscalationConfig, opts: {
  riskLevel: string | null;
  affectsPatientSafety: boolean;
  manualRcaRequired: boolean;
}): EscalationDecision {
  const { riskLevel, affectsPatientSafety, manualRcaRequired } = opts;
  const threshold = cfg.autoEscalateRiskLevel === 'off' ? Infinity : RANK[cfg.autoEscalateRiskLevel] ?? Infinity;
  const rank = riskLevel ? RANK[riskLevel] ?? 0 : 0;

  let escalated = false;
  let reason: string | null = null;
  if (rank >= threshold) {
    escalated = true;
    reason = `Risk assessed as ${LEVEL_LABEL[riskLevel!] ?? riskLevel} — at or above the ${LEVEL_LABEL[cfg.autoEscalateRiskLevel] ?? cfg.autoEscalateRiskLevel} auto-escalation threshold.`;
  } else if (affectsPatientSafety && cfg.autoEscalatePatientSafety) {
    escalated = true;
    reason = `Flagged as affecting patient safety — escalated automatically despite a ${LEVEL_LABEL[riskLevel!] ?? 'lower'} risk band.`;
  }
  return {
    escalated,
    rcaRequired: escalated || manualRcaRequired,
    createCapa: escalated && cfg.autoCreateCapaOnEscalation,
    reason,
  };
}

/**
 * Creates a CAPA for an escalated nonconformity, links it, and returns the new
 * record. Returns null when the source already has a CAPA.
 */
export function createCapaForNc(db: any, ncId: number | string, userId: number, reason: string | null): { id: number; capaNumber: string } | null {
  const nc = db.prepare('SELECT * FROM nonconforming_events WHERE id = ?').get(ncId) as any;
  if (!nc) return null;
  const existing = db.prepare('SELECT id FROM capa_records WHERE nc_id = ?').get(nc.id) as any;
  if (existing) return null;
  const createdAt = new Date().toISOString();
  const capaNumber = generateRecordNumber(db, 'capa_records', 'CAPA', createdAt);
  const r = db.prepare(`INSERT INTO capa_records (capa_number, source_module, source_record_id, nc_id, title, problem_summary, root_cause, responsible_staff_id, due_date, priority, status, effectiveness_required, effectiveness_status, created_by, created_at)
    VALUES (?, 'nonconformities', ?, ?, ?, ?, ?, ?, ?, ?, 'open', 1, 'pending', ?, ?)`)
    .run(capaNumber, String(nc.id), nc.id, nc.title, nc.description ?? null, nc.root_cause ?? null,
      nc.capa_responsible_staff_id ?? null, nc.capa_timeline_date ?? null,
      nc.risk_level === 'very_high' ? 'high' : nc.risk_level === 'high' ? 'high' : 'normal', userId, createdAt);
  const capaId = Number(r.lastInsertRowid);
  db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('nc_capa', 'nonconforming_events', String(nc.id), 'nc_capa', 'capa_records', String(capaId), reason ? `Auto-escalated: ${reason}` : 'Linked CAPA from nonconformity');
  return { id: capaId, capaNumber };
}

/** Creates a CAPA for an escalated incident / adverse event. */
export function createCapaForIncident(db: any, incidentId: number | string, userId: number, reason: string | null): { id: number; capaNumber: string } | null {
  const inc = db.prepare('SELECT * FROM incidents WHERE id = ?').get(incidentId) as any;
  if (!inc) return null;
  const existing = db.prepare('SELECT id FROM capa_records WHERE incident_id = ?').get(inc.id) as any;
  if (existing) return null;
  const createdAt = new Date().toISOString();
  const capaNumber = generateRecordNumber(db, 'capa_records', 'CAPA', createdAt);
  const title = `${(inc.incident_type || 'Incident').replace(/_/g, ' ')} — ${inc.incident_number}`;
  const r = db.prepare(`INSERT INTO capa_records (capa_number, source_module, source_record_id, incident_id, title, problem_summary, root_cause, due_date, priority, status, effectiveness_required, effectiveness_status, created_by, created_at)
    VALUES (?, 'incidents', ?, ?, ?, ?, ?, ?, ?, 'open', 1, 'pending', ?, ?)`)
    .run(capaNumber, String(inc.id), inc.id, title, inc.description ?? null, inc.root_cause ?? null, null,
      inc.risk_level === 'very_high' || inc.risk_level === 'high' ? 'high' : 'normal', userId, createdAt);
  const capaId = Number(r.lastInsertRowid);
  db.prepare('UPDATE incidents SET capa_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(capaId, inc.id);
  db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('nc_capa', 'incidents', String(inc.id), 'nc_capa', 'capa_records', String(capaId), reason ? `Auto-escalated: ${reason}` : 'Linked CAPA from incident');
  return { id: capaId, capaNumber };
}

/**
 * Roles permitted to amend an already-logged event. Everyone may log an event,
 * but altering the record afterwards is restricted so the audit trail of what
 * was originally reported stays trustworthy.
 */
export const RECORD_AMEND_ROLES = ['System Administrator', 'Laboratory Manager', 'Quality Manager'];

export function canAmendRecords(db: any, roleId: number): boolean {
  const role = db.prepare('SELECT name FROM roles WHERE id = ?').get(roleId) as { name: string } | undefined;
  return !!role && RECORD_AMEND_ROLES.includes(role.name);
}
