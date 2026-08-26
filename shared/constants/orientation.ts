/**
 * The vocabulary of orientation and induction.
 *
 * An orientation framework is the laboratory's own induction checklist —
 * what a new member of staff has to be shown, given and taken through before
 * they can be signed off as inducted. Records copy a framework's items, so the
 * laboratory sets the standard once (mirroring how competency frameworks work)
 * instead of re-typing the checklist for every new starter.
 *
 * Server routes validate against these lists and the pages render their
 * labels, so a term means one thing wherever it appears.
 */

/** Who a framework was written for. Shares the competency audience vocabulary. */
export const ORIENTATION_AUDIENCES = ['new_hire', 'existing_staff', 'intern_attachee', 'locum', 'student', 'all_staff'] as const;
export const ORIENTATION_AUDIENCE_LABELS: Record<string, string> = {
  new_hire: 'New hires',
  existing_staff: 'Existing staff',
  intern_attachee: 'Interns & attachés',
  locum: 'Locum staff',
  student: 'Students',
  all_staff: 'All staff',
};

/** Lifecycle of a framework — mirrors competency frameworks. */
export const ORIENTATION_FRAMEWORK_STATUSES = ['draft', 'active', 'archived'] as const;
export const ORIENTATION_FRAMEWORK_STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  active: 'Active',
  archived: 'Archived',
};

/** Lifecycle of a single staff orientation record. */
export const ORIENTATION_RECORD_STATUSES = ['in_progress', 'completed', 'cancelled'] as const;
export const ORIENTATION_RECORD_STATUS_LABELS: Record<string, string> = {
  in_progress: 'In progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

/** State of a single checklist item on a record. */
export const ORIENTATION_ITEM_STATUSES = ['pending', 'completed', 'not_applicable'] as const;
export const ORIENTATION_ITEM_STATUS_LABELS: Record<string, string> = {
  pending: 'Pending',
  completed: 'Completed',
  not_applicable: 'Not applicable',
};

/**
 * Who is typically responsible for taking a new starter through an item.
 * Advisory only — a framework item may name any responsible role in free text.
 */
export const ORIENTATION_RESPONSIBLE_ROLES = [
  'facilitator', 'line_manager', 'quality_manager', 'safety_officer', 'section_head', 'lis_administrator', 'hr', 'staff_member',
] as const;
export const ORIENTATION_RESPONSIBLE_ROLE_LABELS: Record<string, string> = {
  facilitator: 'Orientation facilitator',
  line_manager: 'Line manager',
  quality_manager: 'Quality manager',
  safety_officer: 'Safety officer',
  section_head: 'Section head',
  lis_administrator: 'LIS administrator',
  hr: 'Human resources',
  staff_member: 'The staff member',
};

export function orientationLabelise(value?: string | null): string {
  if (!value) return '—';
  return value.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
}
