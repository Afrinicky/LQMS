/**
 * The vocabulary of competence and performance.
 *
 * Server routes validate against these lists and the pages render their
 * labels, so a term means exactly one thing wherever it appears — in a
 * dropdown, in a register column, on a printed record and in the audit trail.
 */

/* ── Competence ─────────────────────────────────────────────────────────── */

/** How the assessor gathered the evidence for an element. */
export const COMPETENCY_METHODS = [
  'direct_observation',
  'equipment_maintenance_observation',
  'monitoring_recording_reporting',
  'review_of_work_records',
  'problem_solving_assessment',
  'sample_testing',
  'oral_written_test',
  'other',
] as const;

export const COMPETENCY_METHOD_LABELS: Record<string, string> = {
  direct_observation: 'Direct observation of routine work',
  equipment_maintenance_observation: 'Observation of equipment maintenance and function checks',
  monitoring_recording_reporting: 'Monitoring of recording and reporting of results',
  review_of_work_records: 'Review of work records',
  problem_solving_assessment: 'Assessment of problem-solving skills',
  sample_testing: 'Examination of proficiency, blind, split or previously examined samples',
  oral_written_test: 'Oral or written knowledge test',
  other: 'Other method',
  // Values written by the earlier single-line register, kept readable.
  record_review: 'Review of work records',
  blind_sample: 'Blind sample testing',
  split_sample: 'Split sample testing',
  problem_solving: 'Assessment of problem-solving skills',
  result_interpretation: 'Result interpretation',
  interview: 'Interview',
};

export const COMPETENCY_METHOD_HINTS: Record<string, string> = {
  direct_observation: 'Watching the person carry out the procedure on live work, including the safety practices it requires.',
  equipment_maintenance_observation: 'Watching the person perform the maintenance and function checks the equipment depends on.',
  monitoring_recording_reporting: 'Checking how results are entered, checked and released.',
  review_of_work_records: 'Reading back over worksheets, logs and reports the person produced.',
  problem_solving_assessment: 'Putting a fault, an out-of-range control or an unexpected result to the person and judging the response.',
  sample_testing: 'Re-examining material with a known answer: a proficiency sample, a split, a blind or a previously examined sample.',
  oral_written_test: 'A structured question set covering the underlying principles.',
  other: 'Any other method — state it in the remarks.',
};

/** Who a framework was written for. */
export const COMPETENCY_AUDIENCES = ['new_hire', 'existing_staff', 'intern_attachee', 'locum', 'student', 'all_staff'] as const;
export const COMPETENCY_AUDIENCE_LABELS: Record<string, string> = {
  new_hire: 'New hires',
  existing_staff: 'Existing staff',
  intern_attachee: 'Interns & attachés',
  locum: 'Locum staff',
  student: 'Students',
  all_staff: 'All staff',
};

/** Why the assessment is being carried out. */
export const COMPETENCY_ASSESSMENT_TYPES = [
  'initial', 'periodic', 'post_training', 'for_cause', 'method_change', 'return_to_work', 'extension_of_scope',
] as const;
export const COMPETENCY_ASSESSMENT_TYPE_LABELS: Record<string, string> = {
  initial: 'Initial — before independent work',
  periodic: 'Periodic re-assessment',
  post_training: 'Following training',
  for_cause: 'For cause — triggered by an event',
  method_change: 'Change of method, equipment or procedure',
  return_to_work: 'Return after extended absence',
  extension_of_scope: 'Extension of scope to new work',
};

export const COMPETENCY_STATUSES = ['planned', 'in_progress', 'pending_review', 'completed', 'acknowledged', 'cancelled'] as const;
export const COMPETENCY_STATUS_LABELS: Record<string, string> = {
  planned: 'Planned',
  in_progress: 'In progress',
  pending_review: 'Awaiting technical review',
  completed: 'Completed',
  acknowledged: 'Acknowledged by staff',
  cancelled: 'Cancelled',
};

export const COMPETENCY_OUTCOMES = ['competent', 'competent_with_supervision', 'not_yet_competent'] as const;
export const COMPETENCY_OUTCOME_LABELS: Record<string, string> = {
  competent: 'Competent',
  competent_with_supervision: 'Competent under supervision',
  not_yet_competent: 'Not yet competent',
};

/** What the person may do once the assessment closes. */
export const SUPERVISION_LEVELS = ['independent', 'indirect_supervision', 'direct_supervision', 'not_authorised'] as const;
export const SUPERVISION_LEVEL_LABELS: Record<string, string> = {
  independent: 'May work independently',
  indirect_supervision: 'May work with indirect supervision',
  direct_supervision: 'May work under direct supervision only',
  not_authorised: 'Not authorised for this work',
};

export const SAMPLE_CHECK_TYPES = ['proficiency_testing', 'previously_examined', 'split_sample', 'blind_sample'] as const;
export const SAMPLE_CHECK_TYPE_LABELS: Record<string, string> = {
  proficiency_testing: 'Proficiency testing sample',
  previously_examined: 'Previously examined sample',
  split_sample: 'Split sample',
  blind_sample: 'Blind sample',
};

export const SAMPLE_AGREEMENTS = ['acceptable', 'unacceptable', 'not_evaluated'] as const;
export const SAMPLE_AGREEMENT_LABELS: Record<string, string> = {
  acceptable: 'Acceptable',
  unacceptable: 'Unacceptable',
  not_evaluated: 'Not evaluated',
};

/**
 * The four-point scale the register defaults to. A framework may set its own
 * top of scale; the descriptors below cover the standard one.
 */
export const COMPETENCY_SCALE_4: Array<{ score: number; label: string; descriptor: string }> = [
  { score: 4, label: 'Proficient', descriptor: 'Performs the task correctly and unaided, resolves problems and is able to train others.' },
  { score: 3, label: 'Competent', descriptor: 'Performs the task correctly and unaided to the required standard.' },
  { score: 2, label: 'Developing', descriptor: 'Performs the task but needs prompting, checking or supervision.' },
  { score: 1, label: 'Not yet competent', descriptor: 'Cannot yet perform the task to the required standard; retraining needed.' },
];

export function competencyScaleLabel(score: number | null | undefined, maxScore = 4): string {
  if (score === null || score === undefined) return 'Not assessed';
  if (maxScore === 4) return COMPETENCY_SCALE_4.find(s => s.score === Math.round(score))?.label ?? String(score);
  return `${score} / ${maxScore}`;
}

/* ── Performance appraisal ──────────────────────────────────────────────── */

export const APPRAISAL_SECTIONS = ['delivery', 'competency', 'quality_compliance', 'leadership'] as const;
export const APPRAISAL_SECTION_LABELS: Record<string, string> = {
  delivery: 'Objectives & delivery',
  competency: 'Job knowledge & skills',
  quality_compliance: 'Quality, safety & compliance',
  leadership: 'Leadership & teamwork',
};
export const APPRAISAL_SECTION_HINTS: Record<string, string> = {
  delivery: 'What the person was asked to achieve over the period, and what was actually delivered.',
  competency: 'The technical knowledge and skill the role calls for.',
  quality_compliance: 'Working to procedure, keeping records, safety, confidentiality and turnaround.',
  leadership: 'Working with others, supervising, mentoring and contributing beyond the bench.',
};

export const APPRAISAL_TYPES = ['annual', 'mid_year', 'probation', 'end_of_contract', 'project'] as const;
export const APPRAISAL_TYPE_LABELS: Record<string, string> = {
  annual: 'Annual',
  mid_year: 'Mid-year review',
  probation: 'End of probation',
  end_of_contract: 'End of contract',
  project: 'Project or assignment',
};

export const APPRAISAL_STATUSES = [
  'draft', 'self_assessment', 'appraiser_review', 'pending_moderation', 'completed', 'acknowledged', 'cancelled',
] as const;
export const APPRAISAL_STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  self_assessment: 'With staff member',
  appraiser_review: 'With appraiser',
  pending_moderation: 'Awaiting second-level review',
  completed: 'Completed',
  acknowledged: 'Acknowledged by staff',
  cancelled: 'Cancelled',
};

export const APPRAISAL_CYCLE_TYPES = ['annual', 'mid_year', 'probation', 'quarterly'] as const;
export const APPRAISAL_CYCLE_STATUSES = ['planned', 'open', 'in_review', 'closed'] as const;

export const APPRAISAL_RECOMMENDATIONS = [
  'confirm_in_post', 'progress_normally', 'ready_for_advancement', 'development_required', 'performance_improvement_plan', 'extend_probation',
] as const;
export const APPRAISAL_RECOMMENDATION_LABELS: Record<string, string> = {
  confirm_in_post: 'Confirm in post',
  progress_normally: 'Continue in post — normal progression',
  ready_for_advancement: 'Ready for advancement or wider scope',
  development_required: 'Continue in post with a development plan',
  performance_improvement_plan: 'Place on a performance improvement plan',
  extend_probation: 'Extend probation and reassess',
};

export const APPRAISAL_OBJECTIVE_STATUSES = ['agreed', 'in_progress', 'achieved', 'partially_achieved', 'not_achieved', 'carried_forward'] as const;

export const DEVELOPMENT_ACTION_TYPES = ['training', 'mentoring', 'rotation', 'competency_assessment', 'qualification', 'other'] as const;
export const DEVELOPMENT_ACTION_TYPE_LABELS: Record<string, string> = {
  training: 'Training',
  mentoring: 'Mentoring or coaching',
  rotation: 'Bench rotation or secondment',
  competency_assessment: 'Competency assessment',
  qualification: 'Formal qualification',
  other: 'Other',
};

/** The five-point performance scale, highest first. */
export const APPRAISAL_SCALE_5: Array<{ score: number; label: string; descriptor: string }> = [
  { score: 5, label: 'Outstanding', descriptor: 'Consistently exceeds what the role requires and raises the standard for others.' },
  { score: 4, label: 'Exceeds expectations', descriptor: 'Regularly delivers beyond the requirement of the role.' },
  { score: 3, label: 'Meets expectations', descriptor: 'Delivers the role reliably and to standard.' },
  { score: 2, label: 'Partially meets expectations', descriptor: 'Falls short in some areas; improvement needed.' },
  { score: 1, label: 'Below expectations', descriptor: 'Does not meet the requirement of the role; formal support needed.' },
];

/** Overall percentage → rating band, so two appraisers land on the same word. */
export const APPRAISAL_BANDS: Array<{ min: number; band: string }> = [
  { min: 90, band: 'Outstanding' },
  { min: 75, band: 'Exceeds expectations' },
  { min: 60, band: 'Meets expectations' },
  { min: 45, band: 'Partially meets expectations' },
  { min: 0, band: 'Below expectations' },
];

export function appraisalBand(percent: number | null | undefined): string | null {
  if (percent === null || percent === undefined || !Number.isFinite(percent)) return null;
  return APPRAISAL_BANDS.find(b => percent >= b.min)?.band ?? null;
}

export function labelise(value?: string | null): string {
  if (!value) return '—';
  return value.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
}
