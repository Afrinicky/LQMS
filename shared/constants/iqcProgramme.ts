/**
 * The internal quality control programme: what is expected, and of what.
 *
 * A control that is defined is not a control that is run. ISO 15189:2022
 * §7.3.7.1 asks the laboratory to plan its quality control — to state, in
 * advance, what is run and how often — and then to be able to show that the
 * plan was followed. A register of the runs that happened cannot show that: it
 * has no record of the mornings nobody ran anything, which are precisely the
 * mornings worth knowing about.
 *
 * So the programme carries a SCHEDULE, and the schedule is what turns silence
 * into a finding. Three rules shape everything here.
 *
 *   EVERY EXAMINATION IS IN THE PROGRAMME UNTIL IT IS DELIBERATELY TAKEN OUT.
 *   A test on the menu with no control is a gap, named as one, with the two
 *   honest ways to close it: define a control, or record why this examination
 *   is not controlled. Both are decisions; neither is silence.
 *
 *   A MISSED RUN IS NOT AN ERROR TO BE HIDDEN. It is recorded, and it is
 *   closed one of two ways: the run is entered after the fact, on the day it
 *   was actually performed, or somebody states why it was not run. A
 *   laboratory that cannot record the second will fabricate the first.
 *
 *   THE PLAN IS THE LABORATORY'S, NOT THE SYSTEM'S. Every control's schedule
 *   can be set — which days, which shifts, from when — and what ships is only
 *   a default read off the frequency the control was registered with.
 */

/* ============================================================================
   How often a control is expected
   ----------------------------------------------------------------------------
   The control's own `qc_frequency` says how often it should be run in the
   words of the laboratory's procedure. Some of those words carry a day —
   daily, per shift, weekly — and some do not: "each run", "per new lot" and
   "per kit" are events, not dates. The schedule turns the first into expected
   days and leaves the second to be monitored by event.
   ========================================================================= */
export const PROGRAMME_FREQUENCIES = ['daily', 'per_shift', 'weekly', 'event'] as const;
export type ProgrammeFrequency = (typeof PROGRAMME_FREQUENCIES)[number];

export const PROGRAMME_FREQUENCY_LABELS: Record<ProgrammeFrequency, string> = {
  daily: 'Every scheduled day',
  per_shift: 'Every shift',
  weekly: 'Once a week',
  event: 'By event, not by date',
};

export const PROGRAMME_FREQUENCY_HINTS: Record<ProgrammeFrequency, string> = {
  daily: 'One run on each day the schedule names.',
  per_shift: 'One run on each shift named, on each day named.',
  weekly: 'One run in each week, on the first day named.',
  event: 'Run when something happens — a new lot, a new kit, a service — rather than on a date. Nothing is counted as missed.',
};

/* ============================================================================
   Which days, and which shifts
   ========================================================================= */
/** ISO weekday numbers: 1 is Monday, 7 is Sunday. */
export const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export const WEEKDAY_LABELS: Record<Weekday, string> = {
  1: 'Monday', 2: 'Tuesday', 3: 'Wednesday', 4: 'Thursday', 5: 'Friday', 6: 'Saturday', 7: 'Sunday',
};

export const WEEKDAY_SHORT: Record<Weekday, string> = {
  1: 'Mon', 2: 'Tue', 3: 'Wed', 4: 'Thu', 5: 'Fri', 6: 'Sat', 7: 'Sun',
};

/** The shifts a run can be recorded on, as the run form offers them. */
export const IQC_SHIFTS = ['Morning', 'Afternoon', 'Night'] as const;
export type IqcShift = (typeof IQC_SHIFTS)[number];

/** The ISO weekday of a YYYY-MM-DD date, 1 (Monday) to 7 (Sunday). */
export function weekdayOf(date: string): Weekday {
  const day = new Date(`${date}T00:00:00`).getDay();
  return (day === 0 ? 7 : day) as Weekday;
}

/* ============================================================================
   One control's plan
   ========================================================================= */
export interface ProgrammeSchedule {
  frequency: ProgrammeFrequency;
  /** The days of the week a run is expected. Empty means every day. */
  weekdays: Weekday[];
  /** For `per_shift`, the shifts expected on each of those days. */
  shifts: IqcShift[];
  /** Nothing is expected before this day — the programme does not invent history. */
  startsOn: string | null;
  /** Nothing is expected after it, for a lot taken out of use. */
  endsOn: string | null;
  /** False while a control is in the register but out of the programme. */
  isActive: boolean;
  /** True while no schedule has been saved and the control's frequency decides. */
  isDefault: boolean;
  notes: string | null;
}

/**
 * The plan a control has before anybody writes one.
 *
 * Read off the frequency the control was registered with, so the programme is
 * answering for every control from the day it is switched on rather than from
 * the day somebody finishes configuring it. A control registered "each run" is
 * expected daily: it is run alongside patients, patients are tested every day,
 * and the schedule is one click from saying otherwise.
 */
export function defaultSchedule(qcFrequency?: string | null, startsOn?: string | null): ProgrammeSchedule {
  const frequency: ProgrammeFrequency =
    qcFrequency === 'per_shift' ? 'per_shift'
    : qcFrequency === 'weekly' ? 'weekly'
    : qcFrequency === 'per_new_lot' || qcFrequency === 'per_kit' ? 'event'
    : 'daily';
  return {
    frequency,
    weekdays: [...WEEKDAYS],
    shifts: frequency === 'per_shift' ? ['Morning'] : [],
    startsOn: startsOn ?? null,
    endsOn: null,
    isActive: true,
    isDefault: true,
    notes: null,
  };
}

/** The plan in one line of words, for a register that cannot show a form. */
export function scheduleSummary(schedule: ProgrammeSchedule): string {
  if (!schedule.isActive) return 'Out of the programme';
  if (schedule.frequency === 'event') return 'By event — new lot, new kit or after a service';
  const every = schedule.weekdays.length === 0 || schedule.weekdays.length === 7;
  const days = every ? 'every day' : schedule.weekdays.map(d => WEEKDAY_SHORT[d]).join(', ');
  if (schedule.frequency === 'weekly') return `Once a week, on ${every ? 'any day' : days}`;
  if (schedule.frequency === 'per_shift') {
    const shifts = schedule.shifts.length ? schedule.shifts.join(', ').toLowerCase() : 'every shift';
    return `${every ? 'Every day' : days}, ${shifts}`;
  }
  return every ? 'Every day' : `Every ${days}`;
}

/* ============================================================================
   What the plan expects, day by day
   ========================================================================= */
export interface Occurrence {
  date: string;
  /** The shift expected, for a control run per shift. Null for once a day. */
  shift: IqcShift | null;
}

const DAY_MS = 86_400_000;

/** Every day from `from` to `to` inclusive, as YYYY-MM-DD. */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let cursor = new Date(`${from}T00:00:00Z`).getTime();
  const end = new Date(`${to}T00:00:00Z`).getTime();
  // A window somebody mistyped must not spin: a year of days is more than any
  // screen shows, and the caller is told by the empty answer.
  let guard = 0;
  while (cursor <= end && guard++ < 400) {
    out.push(new Date(cursor).toISOString().slice(0, 10));
    cursor += DAY_MS;
  }
  return out;
}

/**
 * What the plan expects between two days.
 *
 * Nothing before the schedule starts, nothing after it ends, nothing for a
 * control monitored by event, and nothing for a day of the week the laboratory
 * does not run it on. A weekly control is expected once in each calendar week,
 * on the first scheduled day of that week — expecting it on all of them would
 * report six misses for a control that is behaving exactly as planned.
 */
export function occurrencesBetween(schedule: ProgrammeSchedule, from: string, to: string): Occurrence[] {
  if (!schedule.isActive || schedule.frequency === 'event') return [];
  const days = daysBetween(from, to).filter(date => {
    if (schedule.startsOn && date < schedule.startsOn) return false;
    if (schedule.endsOn && date > schedule.endsOn) return false;
    if (schedule.weekdays.length && !schedule.weekdays.includes(weekdayOf(date))) return false;
    return true;
  });

  if (schedule.frequency === 'weekly') {
    const firstOfWeek = new Map<string, string>();
    for (const date of days) {
      // Weeks run Monday to Sunday, so a week is named by its Monday.
      const monday = new Date(`${date}T00:00:00Z`);
      monday.setUTCDate(monday.getUTCDate() - (weekdayOf(date) - 1));
      const key = monday.toISOString().slice(0, 10);
      if (!firstOfWeek.has(key)) firstOfWeek.set(key, date);
    }
    return [...firstOfWeek.values()].map(date => ({ date, shift: null }));
  }

  if (schedule.frequency === 'per_shift') {
    const shifts = schedule.shifts.length ? schedule.shifts : [...IQC_SHIFTS];
    return days.flatMap(date => shifts.map(shift => ({ date, shift })));
  }

  return days.map(date => ({ date, shift: null }));
}

/* ============================================================================
   What became of one expected run
   ========================================================================= */
export const OCCURRENCE_STATES = [
  'in_control', 'warning', 'rejected', 'missed', 'excused', 'due', 'not_scheduled',
] as const;
export type OccurrenceState = (typeof OCCURRENCE_STATES)[number];

export const OCCURRENCE_STATE_LABELS: Record<OccurrenceState, string> = {
  in_control: 'Run, in control',
  warning: 'Run, warning',
  rejected: 'Run, rejected',
  missed: 'Not run',
  excused: 'Not run, accounted for',
  due: 'Due',
  not_scheduled: 'Not scheduled',
};

export const OCCURRENCE_STATE_TONES: Record<OccurrenceState, 'ok' | 'warn' | 'crit' | 'idle'> = {
  in_control: 'ok', warning: 'warn', rejected: 'crit',
  missed: 'crit', excused: 'warn', due: 'idle', not_scheduled: 'idle',
};

/** Only these count against the programme. A day still to come does not. */
export function countsAsMissed(state: OccurrenceState): boolean {
  return state === 'missed';
}

/**
 * Compliance, as a whole number of percent.
 *
 * Performed over expected, where expected excludes the days still to come and
 * the ones somebody has accounted for. A laboratory is not non-compliant for
 * the afternoon that has not happened yet, and it is not non-compliant for the
 * day the analyser was under repair and somebody said so.
 */
export function compliancePercent(performed: number, missed: number): number | null {
  const judged = performed + missed;
  return judged === 0 ? null : Math.round((performed / judged) * 100);
}

/* ============================================================================
   An examination left out of the programme
   ========================================================================= */
export const EXEMPTION_GROUNDS = [
  'no_control_available',
  'qualitative_each_kit',
  'referred_out',
  'not_performed',
  'other',
] as const;
export type ExemptionGround = (typeof EXEMPTION_GROUNDS)[number];

export const EXEMPTION_GROUND_LABELS: Record<ExemptionGround, string> = {
  no_control_available: 'No control material exists for this examination',
  qualitative_each_kit: 'Controlled by the kit’s own internal control on each use',
  referred_out: 'Referred to another laboratory',
  not_performed: 'No longer performed here',
  other: 'Other ground',
};

/**
 * An exemption is a decision with a date on it.
 *
 * Left open-ended it becomes the way an examination quietly stops being
 * controlled, so one is reviewed: the register shows when, and an exemption
 * past its review date is reported like any other overdue thing.
 */
export const EXEMPTION_REVIEW_MONTHS = 12;
