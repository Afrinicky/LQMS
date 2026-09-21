import { useEffect, useState } from 'react';
import { api } from '../../services/api';

// Shared vocabulary, criteria and small presentational helpers for the risk
// management workspace. The criteria are the laboratory's own — everything the
// module draws (matrix wording, bands, colours, review cycles, who may accept
// a risk) comes from here rather than from anything hard-coded.

export type ScaleStep = { score: number; label: string; description: string };
export type RiskBand = { level: string; label: string; min: number; max: number; action: string; color: string; reviewMonths: number };

export type RiskCriteria = {
  likelihood: ScaleStep[];
  severity: ScaleStep[];
  bands: RiskBand[];
  treatmentThresholdLevel: string;
  requireResidualAssessment: boolean;
  acceptanceRoles: string[];
  alwaysTreatPatientSafety: boolean;
};

export type RiskCriteriaState = RiskCriteria & {
  canCreate: boolean; canAssess: boolean; canAccept: boolean; canClose: boolean; canConfigure: boolean;
};

export const DEFAULT_CRITERIA: RiskCriteriaState = {
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
  canCreate: false, canAssess: false, canAccept: false, canClose: false, canConfigure: false,
};

/** The laboratory's risk criteria and what this user may do with them. */
export function useRiskCriteria() {
  const [criteria, setCriteria] = useState<RiskCriteriaState>(DEFAULT_CRITERIA);
  useEffect(() => {
    api<RiskCriteriaState>('/risks/criteria')
      .then(c => setCriteria({ ...DEFAULT_CRITERIA, ...c }))
      .catch(() => { /* the shipped defaults stand in until the API answers */ });
  }, []);
  return criteria;
}

export const RISK_CATEGORIES = [
  { v: 'pre_examination', l: 'Pre-examination (request, collection, transport, receipt)' },
  { v: 'examination', l: 'Examination (method, equipment, reagent, competence)' },
  { v: 'post_examination', l: 'Post-examination (reporting, release, interpretation)' },
  { v: 'safety_biosafety', l: 'Safety & biosafety' },
  { v: 'equipment', l: 'Equipment & instrumentation' },
  { v: 'personnel', l: 'Personnel & competence' },
  { v: 'facility_environment', l: 'Facility & environmental conditions' },
  { v: 'information_ict', l: 'Information management & ICT' },
  { v: 'supply_chain', l: 'Supply chain & inventory' },
  { v: 'external_provider', l: 'Externally provided services' },
  { v: 'business_continuity', l: 'Business continuity' },
  { v: 'other', l: 'Other' },
];

export const RISK_SOURCES = [
  { v: 'proactive_assessment', l: 'Proactive risk assessment' },
  { v: 'nonconformity', l: 'Nonconformity' },
  { v: 'incident', l: 'Incident or adverse event' },
  { v: 'complaint', l: 'Complaint' },
  { v: 'audit_finding', l: 'Audit finding' },
  { v: 'management_review', l: 'Management review' },
  { v: 'eqa_iqc', l: 'Quality control or external assessment' },
  { v: 'staff_report', l: 'Staff report or suggestion' },
  { v: 'supplier_equipment', l: 'Supplier or equipment notification' },
  { v: 'other', l: 'Other' },
];

export const TREATMENT_OPTIONS = [
  { v: 'avoid', l: 'Avoid — stop or do not start the activity' },
  { v: 'reduce', l: 'Reduce — lower the likelihood or the severity' },
  { v: 'transfer', l: 'Transfer — share the risk with another party' },
  { v: 'accept', l: 'Retain — accept the risk with monitoring' },
];

// Controls listed strongest first: designing a hazard out beats warning people
// about it, and the order is how the plan is judged.
export const CONTROL_TYPES = [
  { v: 'elimination', l: 'Elimination' },
  { v: 'substitution', l: 'Substitution' },
  { v: 'engineering', l: 'Engineering control' },
  { v: 'administrative', l: 'Administrative control (procedure, training)' },
  { v: 'ppe', l: 'Personal protective equipment' },
];

export const CONTROL_STATUSES = [
  { v: 'planned', l: 'Planned' },
  { v: 'in_progress', l: 'In progress' },
  { v: 'implemented', l: 'Implemented' },
];

export type RiskRow = {
  id: number; risk_number: string; section_id: number | null; section_name: string | null;
  risk_category: string | null; risk_source: string | null; process_affected: string | null;
  risk_area: string; risk_description: string | null; cause: string | null; consequence: string | null;
  existing_controls: string | null; identified_by_staff_id: number | null; identified_by_name: string | null;
  identified_date: string | null; affects_patient_safety: number;
  likelihood: number | null; severity: number | null; risk_score: number | null; risk_level: string | null;
  analysis_notes: string | null; analysed_at: string | null; evaluation_decision: string | null;
  treatment_option: string | null; mitigation_plan: string | null; treatment_owner_staff_id: number | null;
  treatment_owner_name: string | null; treatment_due_date: string | null; treatment_completed_at: string | null;
  treatment_notes: string | null;
  residual_likelihood: number | null; residual_severity: number | null; residual_score: number | null;
  residual_level: string | null; residual_assessed_at: string | null;
  acceptance_decision: string | null; acceptance_justification: string | null;
  accepted_by_name: string | null; accepted_at: string | null;
  responsible_staff_id: number | null; responsible_name: string | null;
  review_due_date: string | null; last_review_date: string | null;
  workflow_stage: string; status: string; created_at: string;
};

export type RiskControl = {
  id: number; risk_id: number; control_description: string; control_type: string | null;
  responsible_staff_id: number | null; responsible_name: string | null; target_date: string | null;
  status: string; completed_date: string | null; verification_notes: string | null; action_id: number | null;
};

export type RiskReview = {
  id: number; review_date: string; review_notes: string; risk_score: number | null; risk_level: string | null;
  residual_score: number | null; residual_level: string | null; outcome: string | null;
  next_review_date: string | null; reviewed_by_name: string | null;
};

export type RiskSignature = { id: number; purpose: string; meaning: string | null; signer_name: string | null; signed_at: string };

export type RiskLink = {
  id: number; source_module_key: string; source_record_type: string; source_record_id: string;
  target_module_key: string; target_record_type: string; target_record_id: string; notes?: string;
};

export type RiskDetail = RiskRow & {
  controls?: RiskControl[]; reviews?: RiskReview[]; signatures?: RiskSignature[]; links?: RiskLink[];
};

export const optionLabel = (options: { v: string; l: string }[], value: unknown) =>
  options.find(o => o.v === value)?.l ?? (value ? String(value).replace(/_/g, ' ') : '—');

/** A coloured band chip, drawn from the laboratory's own criteria. */
export function BandChip({ level, score, criteria, size = 'md' }: {
  level: string | null | undefined; score?: number | null; criteria: RiskCriteria; size?: 'sm' | 'md';
}) {
  const band = criteria.bands.find(b => b.level === level);
  if (!band) return <span className="badge">—</span>;
  return <span style={{
    background: band.color, color: '#fff', fontWeight: 700, borderRadius: 4, whiteSpace: 'nowrap',
    fontSize: size === 'sm' ? 10 : 11, padding: size === 'sm' ? '1px 6px' : '2px 8px',
  }}>{score != null ? `${score} · ` : ''}{band.label}</span>;
}

export const fmtDate = (v: unknown) => (v ? String(v).slice(0, 10) : '—');
