/**
 * Handling a complaint, the way ISO 15189:2022 §7.4 describes it.
 *
 * The clause asks a laboratory for a documented process that receives,
 * evaluates and decides on complaints; acknowledges receipt; keeps a record of
 * the complaint and everything done about it; makes the decision by people not
 * involved in the activity complained about; and formally tells the complainant
 * when handling has finished. ISO 10002 adds the same shape in more detail.
 *
 * Those requirements are the stages below, in order. Each one is a thing
 * somebody did on a date, not a status somebody typed.
 */
export const COMPLAINT_STAGES = [
  'received',
  'acknowledged',
  'under_investigation',
  'awaiting_review',
  'outcome_pending',
  'closed',
] as const;
export type ComplaintStage = typeof COMPLAINT_STAGES[number];

/** A complaint can also stop early, without going the whole way. */
export const COMPLAINT_TERMINAL = ['closed', 'withdrawn'] as const;

export const STAGE_LABELS: Record<string, string> = {
  received: 'Received',
  acknowledged: 'Acknowledged',
  under_investigation: 'Under investigation',
  awaiting_review: 'Awaiting independent review',
  outcome_pending: 'Outcome to be communicated',
  closed: 'Closed',
  withdrawn: 'Withdrawn',
};

/** What the laboratory still owes at each stage — shown on the record itself. */
export const STAGE_NEXT_ACTION: Record<string, string> = {
  received: 'Acknowledge receipt to the complainant.',
  acknowledged: 'Assign an investigator and establish what happened.',
  under_investigation: 'Record the findings, the cause and the correction, then send for review.',
  awaiting_review: 'A person not involved in the activity complained about must review the decision.',
  outcome_pending: 'Tell the complainant the outcome, then close the record.',
  closed: 'Nothing outstanding.',
  withdrawn: 'Nothing outstanding — the complainant withdrew it.',
};

export const COMPLAINT_SEVERITIES = ['minor', 'moderate', 'major', 'critical'] as const;
export type ComplaintSeverity = typeof COMPLAINT_SEVERITIES[number];

export const SEVERITY_LABELS: Record<string, string> = {
  minor: 'Minor — no impact on a result or a patient',
  moderate: 'Moderate — service affected, no patient harm',
  major: 'Major — a result or a patient was affected',
  critical: 'Critical — patient harm, or a systemic failure',
};

/** How the laboratory spoke to the complainant. Recorded, because ISO asks. */
export const CONTACT_METHODS = ['In person', 'Telephone', 'Email', 'Letter', 'Through the ward', 'Other'] as const;

export const COMPLAINANT_TYPES = [
  'Patient', 'Relative or carer', 'Clinician', 'Ward or unit', 'Referring laboratory',
  'Supplier', 'Staff member', 'Regulator', 'Other',
] as const;

export const COMPLAINT_CATEGORIES = [
  'Result accuracy', 'Turnaround time', 'Sample handling or rejection', 'Report content or clarity',
  'Staff conduct or communication', 'Access to service', 'Phlebotomy or collection',
  'Confidentiality or data protection', 'Billing', 'Facilities', 'Other',
] as const;

/** The decision the reviewer records. ISO 10002 wants the complaint decided. */
export const COMPLAINT_OUTCOMES = ['upheld', 'partly_upheld', 'not_upheld', 'withdrawn'] as const;
export type ComplaintOutcome = typeof COMPLAINT_OUTCOMES[number];

export const OUTCOME_LABELS: Record<string, string> = {
  upheld: 'Upheld — the complaint was justified',
  partly_upheld: 'Partly upheld',
  not_upheld: 'Not upheld — the service was as it should have been',
  withdrawn: 'Withdrawn by the complainant',
};

/**
 * The laboratory's own targets, in days. Defaults are the common ones; a
 * laboratory sets its own in Settings, because the assessor's question is
 * whether you meet the target YOUR documented process states.
 */
export type ComplaintTargets = { acknowledgeDays: number; resolveDays: number };
export const DEFAULT_COMPLAINT_TARGETS: ComplaintTargets = { acknowledgeDays: 3, resolveDays: 30 };

export function normaliseTargets(input: unknown): ComplaintTargets {
  const raw = (input ?? {}) as Partial<ComplaintTargets>;
  const clamp = (v: unknown, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 1 && n <= 365 ? Math.floor(n) : fallback;
  };
  return {
    acknowledgeDays: clamp(raw.acknowledgeDays, DEFAULT_COMPLAINT_TARGETS.acknowledgeDays),
    resolveDays: clamp(raw.resolveDays, DEFAULT_COMPLAINT_TARGETS.resolveDays),
  };
}

/** `date` + `days`, as a plain YYYY-MM-DD. */
export function addDays(dateIso: string, days: number): string {
  const d = new Date(`${String(dateIso).slice(0, 10)}T00:00:00`);
  if (isNaN(d.getTime())) return String(dateIso).slice(0, 10);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Past its date and not yet done. */
export function isOverdue(dueDate?: string | null, doneAt?: string | null): boolean {
  if (!dueDate || doneAt) return false;
  return String(dueDate).slice(0, 10) < new Date().toISOString().slice(0, 10);
}
