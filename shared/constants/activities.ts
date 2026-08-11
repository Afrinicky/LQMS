/**
 * Unit activities — the recurring work a laboratory unit actually does.
 *
 * Environmental charting, equipment checks, controls, reagent changes, weekly
 * cleaning: every laboratory runs dozens of them, and every accreditation
 * finding about them is the same one — it was supposed to be done and there is
 * no record that it was. This catalogue turns each of those into a definition
 * the system can schedule, put in front of whoever is on duty in that unit, and
 * afterwards prove was done or flag as missed.
 *
 * Two design rules run through the whole thing:
 *
 *  1. The to-do belongs to the person on duty in the unit that owns the work.
 *     Not the unit head, not the whole laboratory — the people the duty roster
 *     actually placed on that bench that day. Leadership sees the same items,
 *     but as oversight, never as their own to-do.
 *
 *  2. Staff comply with what is easy. Every activity therefore carries a
 *     simplicity rating and a redesign flag, so an activity that is painful to
 *     execute is visible as a problem to fix rather than a discipline failure
 *     to chase.
 */

/* ============================================================================
   How often the work comes round
   ========================================================================= */
export const ACTIVITY_FREQUENCIES = [
  'per_shift', 'daily', 'weekly', 'fortnightly', 'monthly',
  'quarterly', 'biannual', 'annual', 'custom_days',
] as const;
export type ActivityFrequency = (typeof ACTIVITY_FREQUENCIES)[number];

export const FREQUENCY_LABELS: Record<ActivityFrequency, string> = {
  per_shift: 'Every shift',
  daily: 'Daily',
  weekly: 'Weekly',
  fortnightly: 'Every two weeks',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  biannual: 'Twice a year',
  annual: 'Yearly',
  custom_days: 'Every N days',
};

/** How wide the window is that one occurrence covers, for the period key. */
export const FREQUENCY_PERIODS: Record<ActivityFrequency, 'day' | 'week' | 'month' | 'quarter' | 'half' | 'year'> = {
  per_shift: 'day',
  daily: 'day',
  weekly: 'week',
  fortnightly: 'week',
  monthly: 'month',
  quarterly: 'quarter',
  biannual: 'half',
  annual: 'year',
  custom_days: 'day',
};

/* ============================================================================
   What kind of work it is
   ========================================================================= */
export const ACTIVITY_CATEGORIES = [
  'environmental', 'equipment', 'quality_control', 'reagent', 'stock',
  'cleaning', 'safety', 'records', 'handover', 'other',
] as const;
export type ActivityCategory = (typeof ACTIVITY_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<ActivityCategory, string> = {
  environmental: 'Environmental monitoring',
  equipment: 'Equipment care',
  quality_control: 'Quality control',
  reagent: 'Reagents & controls',
  stock: 'Stock & storage',
  cleaning: 'Cleaning & decontamination',
  safety: 'Safety checks',
  records: 'Records & charting',
  handover: 'Handover',
  other: 'Other unit activity',
};

/* ============================================================================
   Who the occurrence lands on
   ========================================================================= */
export const ASSIGN_MODES = ['on_duty', 'bench', 'unit_head', 'named_staff', 'whole_unit'] as const;
export type AssignMode = (typeof ASSIGN_MODES)[number];

export const ASSIGN_MODE_LABELS: Record<AssignMode, string> = {
  on_duty: 'Whoever is on duty in the unit',
  bench: 'Whoever is on the named bench',
  unit_head: 'The unit head',
  named_staff: 'One named member of staff',
  whole_unit: 'Everyone assigned to the unit',
};

/** Where an assignment came from — shown so a staff member knows why it is theirs. */
export const ASSIGNMENT_SOURCES = [
  'duty_roster', 'bench_schedule', 'unit_head', 'named_staff',
  'unit_member', 'section_fallback', 'manual',
] as const;
export type AssignmentSource = (typeof ASSIGNMENT_SOURCES)[number];

export const ASSIGNMENT_SOURCE_LABELS: Record<AssignmentSource, string> = {
  duty_roster: 'On duty (duty roster)',
  bench_schedule: 'On this bench (bench schedule)',
  unit_head: 'Unit head',
  named_staff: 'Named on the activity',
  unit_member: 'Assigned to this unit',
  section_fallback: 'Unit member (no roster entry)',
  manual: 'Assigned by hand',
};

/* ============================================================================
   The life of one occurrence
   ========================================================================= */
export const OCCURRENCE_STATUSES = ['pending', 'in_progress', 'done', 'missed', 'not_applicable'] as const;
export type OccurrenceStatus = (typeof OCCURRENCE_STATUSES)[number];

export const OCCURRENCE_STATUS_LABELS: Record<OccurrenceStatus, string> = {
  pending: 'To do',
  in_progress: 'Started',
  done: 'Done',
  missed: 'Missed',
  not_applicable: 'Not applicable',
};

/* ============================================================================
   The simplification programme
   ----------------------------------------------------------------------------
   Compliance follows ease. An activity nobody completes is usually an activity
   that is awkward to complete, so each one carries its own redesign state and
   the staff's own rating of how easy it is to run.
   ========================================================================= */
export const REDESIGN_STATUSES = ['none', 'flagged', 'in_progress', 'redesigned'] as const;
export type RedesignStatus = (typeof REDESIGN_STATUSES)[number];

export const REDESIGN_STATUS_LABELS: Record<RedesignStatus, string> = {
  none: 'Not flagged',
  flagged: 'Flagged for redesign',
  in_progress: 'Being redesigned',
  redesigned: 'Redesigned',
};

export const EASE_RATING_LABELS: Record<number, string> = {
  1: 'Very hard to do',
  2: 'Hard',
  3: 'Workable',
  4: 'Easy',
  5: 'Very easy',
};

/* ============================================================================
   Sound notifications
   ----------------------------------------------------------------------------
   Sounds are synthesised on the client from these specs rather than shipped as
   audio files: a spec is a few hundred bytes, survives the offline install, and
   plays identically in the desktop shell, the browser and the native mobile
   app. A laboratory that wants its own recorded chime uploads one instead and
   the same preference points at the uploaded file.
   ========================================================================= */
export type ToneStep = {
  /** Hertz. 0 is a rest. */
  freq: number;
  /** Length of the step, in milliseconds. */
  ms: number;
  /** Silence after the step, in milliseconds. */
  gap?: number;
};

export type ToneSpec = {
  waveform: 'sine' | 'triangle' | 'square' | 'sawtooth';
  /** Peak gain before the user's volume preference is applied (0–1). */
  gain: number;
  steps: ToneStep[];
};

export type SoundDefinition = {
  key: string;
  label: string;
  description: string;
  spec: ToneSpec;
};

/**
 * The built-in catalogue. Each is deliberately short and distinguishable from
 * the others across a noisy bench — a chime nobody can pick out of the room is
 * the same as no chime at all.
 */
export const BUILTIN_SOUNDS: SoundDefinition[] = [
  {
    key: 'chime_soft',
    label: 'Soft chime',
    description: 'Two gentle notes. The default for a new to-do.',
    spec: { waveform: 'sine', gain: 0.5, steps: [{ freq: 880, ms: 140, gap: 40 }, { freq: 1175, ms: 220 }] },
  },
  {
    key: 'chime_bright',
    label: 'Bright chime',
    description: 'Three rising notes that carry over bench noise.',
    spec: { waveform: 'triangle', gain: 0.5, steps: [{ freq: 784, ms: 110, gap: 30 }, { freq: 988, ms: 110, gap: 30 }, { freq: 1319, ms: 240 }] },
  },
  {
    key: 'bell_double',
    label: 'Double bell',
    description: 'A short two-stroke bell for a reminder that is now due.',
    spec: { waveform: 'sine', gain: 0.55, steps: [{ freq: 1046, ms: 90, gap: 90 }, { freq: 1046, ms: 200 }] },
  },
  {
    key: 'alert_urgent',
    label: 'Urgent alert',
    description: 'Insistent triple tone for an overdue or critical item.',
    spec: { waveform: 'square', gain: 0.32, steps: [{ freq: 660, ms: 130, gap: 70 }, { freq: 660, ms: 130, gap: 70 }, { freq: 880, ms: 260 }] },
  },
  {
    key: 'morning_briefing',
    label: 'Morning briefing',
    description: 'A short four-note phrase for the start-of-day list.',
    spec: {
      waveform: 'triangle', gain: 0.45,
      steps: [{ freq: 523, ms: 130, gap: 25 }, { freq: 659, ms: 130, gap: 25 }, { freq: 784, ms: 130, gap: 25 }, { freq: 1046, ms: 300 }],
    },
  },
  {
    key: 'schedule_due',
    label: 'Schedule due',
    description: 'Low-high pair for roster and schedule preparation reminders.',
    spec: { waveform: 'sine', gain: 0.5, steps: [{ freq: 587, ms: 180, gap: 50 }, { freq: 880, ms: 260 }] },
  },
  {
    key: 'tick_quiet',
    label: 'Quiet tick',
    description: 'Barely-there click for laboratories that want a minimal cue.',
    spec: { waveform: 'sine', gain: 0.25, steps: [{ freq: 1568, ms: 60 }] },
  },
  {
    key: 'silent',
    label: 'Silent',
    description: 'No sound. The notification is still shown on screen.',
    spec: { waveform: 'sine', gain: 0, steps: [] },
  },
];

/**
 * The events a sound can be attached to. Each is a separate preference so a
 * laboratory can leave the routine to-do chime quiet and still let an overdue
 * critical activity make a noise.
 */
export const SOUND_EVENTS = ['todo', 'reminder', 'overdue', 'critical', 'schedule', 'briefing'] as const;
export type SoundEvent = (typeof SOUND_EVENTS)[number];

export const SOUND_EVENT_LABELS: Record<SoundEvent, string> = {
  todo: 'New activity on your list',
  reminder: 'Activity due now',
  overdue: 'Activity overdue',
  critical: 'Critical alert',
  schedule: 'Roster / schedule preparation due',
  briefing: 'Start-of-day briefing',
};

export const DEFAULT_SOUND_FOR_EVENT: Record<SoundEvent, string> = {
  todo: 'chime_soft',
  reminder: 'bell_double',
  overdue: 'alert_urgent',
  critical: 'alert_urgent',
  schedule: 'schedule_due',
  briefing: 'morning_briefing',
};

/* ============================================================================
   Schedule governance
   ----------------------------------------------------------------------------
   The duty roster and unit reassignment are the laboratory manager's and
   quality manager's to prepare before the month turns; the bench schedules are
   the unit heads', and cannot sensibly be built until the unit assignments
   exist. When a month starts without them, the previous month's stands rather
   than the laboratory running with no schedule at all.
   ========================================================================= */
export const SCHEDULE_KINDS = ['duty_roster', 'reassignment', 'bench_schedule'] as const;
export type ScheduleKind = (typeof SCHEDULE_KINDS)[number];

export const SCHEDULE_KIND_LABELS: Record<ScheduleKind, string> = {
  duty_roster: 'Duty roster',
  reassignment: 'Unit reassignment schedule',
  bench_schedule: 'Bench schedule',
};

/** Who is expected to prepare each schedule, by position-title keyword. */
export const SCHEDULE_OWNER_KEYWORDS: Record<ScheduleKind, string[]> = {
  duty_roster: ['laboratory manager', 'lab manager', 'quality manager'],
  reassignment: ['laboratory manager', 'lab manager', 'quality manager'],
  bench_schedule: ['unit head', 'section head', 'head', 'supervisor'],
};

export const CARRY_FORWARD_REASONS = ['not_prepared', 'partial_bench', 'manual'] as const;
export type CarryForwardReason = (typeof CARRY_FORWARD_REASONS)[number];

export const CARRY_FORWARD_REASON_LABELS: Record<CarryForwardReason, string> = {
  not_prepared: 'Not prepared before the month began — previous month carried forward',
  partial_bench: 'Unit assignments changed — benches inherited and gaps filled',
  manual: 'Carried forward on request',
};

/* ============================================================================
   System audit
   ========================================================================= */
export const AUDIT_FLAG_CATEGORIES = [
  'omission', 'inconsistency', 'integrity', 'governance', 'access', 'schedule', 'activity',
] as const;
export type AuditFlagCategory = (typeof AUDIT_FLAG_CATEGORIES)[number];

export const AUDIT_FLAG_CATEGORY_LABELS: Record<AuditFlagCategory, string> = {
  omission: 'Not done',
  inconsistency: 'Inconsistent data',
  integrity: 'Record integrity',
  governance: 'Governance gap',
  access: 'Access & accounts',
  schedule: 'Roster & schedules',
  activity: 'Unit activities',
};

export const AUDIT_FLAG_STATUSES = ['open', 'acknowledged', 'resolved', 'dismissed'] as const;
export type AuditFlagStatus = (typeof AUDIT_FLAG_STATUSES)[number];

export const AUDIT_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type AuditSeverity = (typeof AUDIT_SEVERITIES)[number];

export const AUDIT_SEVERITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/* ============================================================================
   Helpers shared by the server scheduler and the client views
   ========================================================================= */

/** ISO week number and year, used for the weekly period key. */
export function isoWeek(date: Date): { year: number; week: number } {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return { year: d.getUTCFullYear(), week };
}

/**
 * The key that identifies the period one occurrence covers. Two generation runs
 * over the same period must produce the same key, because that key is what
 * stops a daily activity being raised twice in one day.
 */
export function periodKeyFor(frequency: ActivityFrequency, dateIso: string): string {
  const date = new Date(`${dateIso}T00:00:00`);
  switch (FREQUENCY_PERIODS[frequency]) {
    case 'week': {
      const { year, week } = isoWeek(date);
      return `${year}-W${String(week).padStart(2, '0')}`;
    }
    case 'month':
      return dateIso.slice(0, 7);
    case 'quarter':
      return `${dateIso.slice(0, 4)}-Q${Math.floor(date.getMonth() / 3) + 1}`;
    case 'half':
      return `${dateIso.slice(0, 4)}-H${date.getMonth() < 6 ? 1 : 2}`;
    case 'year':
      return dateIso.slice(0, 4);
    case 'day':
    default:
      return dateIso;
  }
}

/** A short, human phrase for how often an activity runs. */
export function frequencyPhrase(frequency: string, intervalDays?: number | null): string {
  if (frequency === 'custom_days') return intervalDays ? `Every ${intervalDays} days` : 'Every few days';
  return FREQUENCY_LABELS[frequency as ActivityFrequency] ?? frequency;
}
