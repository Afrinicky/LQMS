/**
 * The vocabulary of training.
 *
 * THE PROBLEM THIS FILE FIXES: a training event could only name a trainer who
 * was on the staff register. So the week the manufacturer's engineer came and
 * trained four people on the new analyser, there was nowhere to put his name —
 * the field was a dropdown of employees — and the laboratory's own record said
 * the training had no trainer. Most of the training that matters most is like
 * that: the supplier's application specialist, the reference laboratory, the
 * regional trainer, the online course.
 *
 * Two things were being confused, so they are separated here and stay separate
 * everywhere downstream:
 *
 *   DELIVERY — who ran the session. Internal means the laboratory arranged and
 *   ran it. External means somebody outside did: a supplier, a training
 *   institution, a programme. It decides whose record this primarily is.
 *
 *   TRAINER — who actually stood there and taught. A member of staff, or a
 *   person from outside. These do not always agree: an in-house session can be
 *   taught by the supplier's engineer, and a member of staff can teach on an
 *   external course. So the two are recorded independently rather than one
 *   being inferred from the other.
 *
 * THE SECOND THING THIS FILE FIXES: training was recorded in three places that
 * did not know about each other — the personnel register, the equipment file,
 * and what people declared about themselves — so nobody could answer "what
 * training has this person had?" without opening three modules and adding up
 * by hand. Every record now declares its ORIGIN (below), and one training file
 * per person gathers all of them. Where a record was made does not change
 * whose training it is.
 */

/* ============================================================================
   Who ran it
   ========================================================================= */
export const TRAINING_DELIVERY_MODES = ['internal', 'external'] as const;
export type TrainingDeliveryMode = (typeof TRAINING_DELIVERY_MODES)[number];

export const TRAINING_DELIVERY_LABELS: Record<TrainingDeliveryMode, string> = {
  internal: 'Internal — the laboratory ran it',
  external: 'External — an outside body ran it',
};

export const TRAINING_DELIVERY_HINTS: Record<TrainingDeliveryMode, string> = {
  internal:
    'The laboratory arranged and ran the session: a bench-side handover, an SOP briefing, a refresher before an '
    + 'accreditation visit. The trainer may still be somebody from outside — say so on the next field.',
  external:
    'Somebody outside ran it: a supplier\'s application specialist, a reference laboratory, a training institution, '
    + 'a regional or national programme, an online course. Record the provider so the certificate can be traced back to it.',
};

/* ============================================================================
   Who taught it
   ========================================================================= */
export const TRAINER_TYPES = ['internal_staff', 'external_person'] as const;
export type TrainerType = (typeof TRAINER_TYPES)[number];

export const TRAINER_TYPE_LABELS: Record<TrainerType, string> = {
  internal_staff: 'A member of staff',
  external_person: 'Somebody from outside',
};

export const TRAINER_TYPE_HINTS: Record<TrainerType, string> = {
  internal_staff: 'Chosen from the personnel register, so the session also lands on the trainer\'s own file as training delivered.',
  external_person:
    'Typed in: the engineer, the application specialist, the visiting trainer, the course tutor. Give the organisation '
    + 'they came from and, where it matters, what qualifies them to teach it — that is what an assessor asks about a '
    + 'trainer who is not on the staff register.',
};

/** Does this trainer need a name typing in rather than choosing? */
export function trainerIsExternal(type?: string | null): boolean {
  return type === 'external_person';
}

/**
 * What to show as the trainer, whichever kind it is.
 *
 * One function so a register, a certificate, a profile panel and an export all
 * word it the same way, and so "—" appears only when nobody was actually
 * recorded rather than when the record used the other kind of trainer.
 */
export function trainerDisplayName(record: {
  trainer_type?: string | null;
  trainer_name?: string | null;
  external_trainer_name?: string | null;
  external_trainer_organisation?: string | null;
} | null | undefined): string {
  if (!record) return '—';
  if (trainerIsExternal(record.trainer_type)) {
    const name = String(record.external_trainer_name ?? '').trim();
    const org = String(record.external_trainer_organisation ?? '').trim();
    if (name && org) return `${name} (${org})`;
    if (name) return name;
    if (org) return org;
    return 'External trainer (not named)';
  }
  return String(record.trainer_name ?? '').trim() || '—';
}

/* ============================================================================
   What kind of training it was
   ========================================================================= */
export const TRAINING_CATEGORIES = [
  'induction',
  'sop_procedure',
  'equipment',
  'quality_management',
  'safety',
  'information_systems',
  'ethics_confidentiality',
  'technical_update',
  'corrective_action',
  'continuing_professional_development',
  'other',
] as const;
export type TrainingCategory = (typeof TRAINING_CATEGORIES)[number];

export const TRAINING_CATEGORY_LABELS: Record<string, string> = {
  induction: 'Induction and orientation',
  sop_procedure: 'Procedure / SOP',
  equipment: 'Equipment operation',
  quality_management: 'Quality management system',
  safety: 'Health and safety',
  information_systems: 'Information systems (LIS / LHIMS)',
  ethics_confidentiality: 'Ethics and confidentiality',
  technical_update: 'Technical update',
  corrective_action: 'Arising from a corrective action',
  continuing_professional_development: 'Continuing professional development',
  other: 'Other',
};

/** How the session was run. Separate from who ran it. */
export const TRAINING_FORMATS = ['bench_side', 'classroom', 'online_live', 'online_self_paced', 'workshop', 'conference', 'self_study'] as const;
export type TrainingFormat = (typeof TRAINING_FORMATS)[number];

export const TRAINING_FORMAT_LABELS: Record<string, string> = {
  bench_side: 'Bench-side / on the job',
  classroom: 'Classroom session',
  online_live: 'Online, live',
  online_self_paced: 'Online, self-paced',
  workshop: 'Workshop',
  conference: 'Conference or seminar',
  self_study: 'Self study',
};

/* ============================================================================
   How the record came to exist
   ----------------------------------------------------------------------------
   A laboratory writes training down in two quite different situations, and a
   register that only knows one of them forces the other to lie.

   SCHEDULED — the session is arranged in advance. Everybody who is expected is
   named now, told now, and told again when the day comes. It can be put off,
   it can be called off, and it can repeat. Nothing about it is known yet
   except the intention.

   RETROSPECTIVE — the session already happened. Somebody is writing it down
   afterwards, which is most of what is on a real training register: the
   engineer who came last month, the briefing given at the bench on Tuesday.
   There is nobody to notify and nothing to postpone; what it needs is the
   attendance that was taken on the day and a signature under it.

   The distinction is stored rather than guessed from the date, because a
   session scheduled for last week that nobody has closed is a different thing
   from one entered today about last week — the first is an outstanding piece
   of work and the second is a finished record.
   ========================================================================= */
export const TRAINING_MODES = ['scheduled', 'retrospective'] as const;
export type TrainingMode = (typeof TRAINING_MODES)[number];

export const TRAINING_MODE_LABELS: Record<TrainingMode, string> = {
  scheduled: 'Scheduled in advance',
  retrospective: 'Already happened — being recorded now',
};

export const TRAINING_MODE_HINTS: Record<TrainingMode, string> = {
  scheduled:
    'Name everybody expected and the system tells them now, and again when the day comes. It can be postponed, '
    + 'called off, or set to repeat at a fixed interval.',
  retrospective:
    'The session has been held. Record what it was, take the attendance as it was signed on the day, and close it. '
    + 'Nobody is notified, because there is nothing left to attend.',
};

/* ============================================================================
   Where the session got to
   ----------------------------------------------------------------------------
   The lifecycle is the whole point, and it runs one way. A session is planned,
   it runs, it is held, and then somebody senior completes the documentation
   and CLOSES it. Closure is what makes the record evidence: from that moment
   it is on every attendee's file and it stops being something anybody can
   quietly edit. Reopening it is a deliberate act by a senior role and it is
   written down.

   `postponed` and `cancelled` are the two honest ways out. Putting a session
   off is not the same as it never having been planned — the people who were
   told about it have to be told again — and calling it off is not the same as
   deleting it, because the register has to be able to say a session was
   planned and did not happen.
   ========================================================================= */
export const TRAINING_STATUSES = ['planned', 'in_progress', 'completed', 'closed', 'postponed', 'cancelled'] as const;
export type TrainingStatus = (typeof TRAINING_STATUSES)[number];

export const TRAINING_STATUS_LABELS: Record<string, string> = {
  planned: 'Scheduled',
  in_progress: 'Running now',
  completed: 'Held — documentation outstanding',
  closed: 'Closed',
  postponed: 'Postponed',
  cancelled: 'Called off',
  // Values the earlier register wrote, kept readable.
  scheduled: 'Scheduled',
  held: 'Held — documentation outstanding',
};

export const TRAINING_STATUS_TONES: Record<string, 'ok' | 'warn' | 'bad' | 'muted' | 'live'> = {
  planned: 'warn',
  in_progress: 'live',
  completed: 'warn',
  closed: 'ok',
  postponed: 'warn',
  cancelled: 'bad',
};

/**
 * What the next thing to do is, in one line.
 *
 * The register used to show a status and leave whoever opened it to work out
 * what that meant they should do. Saying it plainly is most of what makes the
 * workflow simple: every session on the list tells you the one action it is
 * waiting for.
 */
export const TRAINING_STATUS_NEXT_STEP: Record<string, string> = {
  planned: 'Waiting for the day. Start the session when it begins.',
  in_progress: 'Running. Mark everybody who came, and have them sign.',
  completed: 'Held. Complete the documentation and close it.',
  closed: 'Closed and on every attendee\u2019s file.',
  postponed: 'Put off. Set the new date, or call it off.',
  cancelled: 'Called off. Nothing further is owed.',
};

/**
 * A closed or cancelled session is finished, and finished records do not get
 * edited in passing.
 *
 * This is the single rule the whole lock rests on, so it lives here and is read
 * by the server (which enforces it) and by every screen (which hides what the
 * server would refuse). A senior role can still amend a closed record — an
 * assessor expects a laboratory to be able to correct its own file — but it is
 * a deliberate act, taken out of plain sight, and audited.
 */
export function trainingIsLocked(status?: string | null): boolean {
  return status === 'closed' || status === 'cancelled';
}

/** Has the session been held, whatever happened to the paperwork afterwards? */
export function trainingWasHeld(status?: string | null): boolean {
  return status === 'completed' || status === 'closed';
}

/* ============================================================================
   Training that comes round again
   ----------------------------------------------------------------------------
   Most of what a laboratory trains on is not a one-off. Safety, the quality
   manual, the annual competence refresher, the monthly bench briefing — these
   recur at a stated interval, and the register has to know that so the next
   one exists without somebody remembering to create it.

   The interval matters for a second reason. A one-off session is reviewed for
   effect ONCE and then it is done. A recurring one is reviewed every time it
   comes round, which is what "periodic review" means in practice and what
   makes a recurring session's file read as a series rather than a pile.
   ========================================================================= */
export const TRAINING_FREQUENCIES = ['none', 'weekly', 'fortnightly', 'monthly', 'quarterly', 'biannual', 'annual', 'custom'] as const;
export type TrainingFrequency = (typeof TRAINING_FREQUENCIES)[number];

export const TRAINING_FREQUENCY_LABELS: Record<string, string> = {
  none: 'Once only',
  weekly: 'Every week',
  fortnightly: 'Every two weeks',
  monthly: 'Every month',
  quarterly: 'Every quarter',
  biannual: 'Twice a year',
  annual: 'Every year',
  custom: 'Every set number of days',
};

/** Days for the fixed intervals; the month-based ones are counted in months. */
const FREQUENCY_DAYS: Record<string, number> = { weekly: 7, fortnightly: 14 };
const FREQUENCY_MONTHS: Record<string, number> = { monthly: 1, quarterly: 3, biannual: 6, annual: 12 };

export function trainingRecurs(frequency?: string | null): boolean {
  return Boolean(frequency) && frequency !== 'none';
}

/**
 * When the next session in a series falls.
 *
 * Month-based intervals step by calendar months rather than by 30 days, so a
 * quarterly session held on the 15th stays on the 15th instead of drifting
 * backwards four days a year. A day that does not exist in the target month —
 * the 31st of a 30-day month — lands on the last day of it rather than
 * silently rolling into the next one.
 */
export function nextTrainingDate(from?: string | null, frequency?: string | null, intervalDays?: number | null): string | null {
  const base = String(from ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(base) || !trainingRecurs(frequency)) return null;
  const date = new Date(`${base}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;

  if (frequency === 'custom') {
    const days = Number(intervalDays);
    if (!Number.isFinite(days) || days < 1) return null;
    date.setUTCDate(date.getUTCDate() + Math.round(days));
    return date.toISOString().slice(0, 10);
  }
  const days = FREQUENCY_DAYS[String(frequency)];
  if (days) {
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  }
  const months = FREQUENCY_MONTHS[String(frequency)];
  if (!months) return null;
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return date.toISOString().slice(0, 10);
}

/** How a recurring series reads in one line, wherever it is shown. */
export function recurrenceSummary(frequency?: string | null, intervalDays?: number | null): string | null {
  if (!trainingRecurs(frequency)) return null;
  if (frequency === 'custom') {
    const days = Number(intervalDays);
    return Number.isFinite(days) && days > 0 ? `Every ${Math.round(days)} days` : 'Repeats at a set interval';
  }
  return TRAINING_FREQUENCY_LABELS[String(frequency)] ?? 'Repeats';
}

/* ============================================================================
   The attendance sheet
   ----------------------------------------------------------------------------
   Everywhere else in this system, a sheet that records who did something is
   signed the same way: the person's name, the designation they hold, their
   signature, and the date. The training register was the exception — it held a
   status word and nothing else, so the one document an assessor always asks to
   see was the one the system could not produce.

   It behaves like every other signing sheet now. Being marked present is done
   BY somebody (the facilitator or a senior role) and is not the same act as
   signing: the mark says a supervisor saw them there, the signature says they
   attest to it themselves. Both are kept, with who marked and when.
   ========================================================================= */
export const ATTENDANCE_STATUSES = ['invited', 'attended', 'absent', 'excused', 'partial'] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

export const ATTENDANCE_STATUS_LABELS: Record<string, string> = {
  invited: 'Invited',
  attended: 'Attended',
  absent: 'Absent',
  excused: 'Excused',
  partial: 'Attended part',
};

/** Statuses that mean the person was actually in the room. */
export const PRESENT_STATUSES: readonly string[] = ['attended', 'partial'];

export function attendedInPerson(status?: string | null): boolean {
  return PRESENT_STATUSES.includes(String(status ?? ''));
}

/**
 * Only somebody who was there signs.
 *
 * An attendance sheet with a signature against a name that was marked absent
 * is not a record of anything, so the sheet refuses it rather than leaving the
 * refusal to whoever happens to be reading the printout.
 */
export function mayCountersign(status?: string | null): boolean {
  return attendedInPerson(status);
}

/**
 * The hours a session gave THIS person.
 *
 * Somebody who came for part of a two-day course has what they were there for
 * on their file, not two days — so a recorded figure always wins, and the
 * session's own duration is only the fallback for somebody who was there
 * throughout.
 */
export function attendanceHours(row: { attendance_status?: string | null; hours?: number | null },
  sessionHours?: number | null): number | null {
  if (row.hours !== null && row.hours !== undefined && Number.isFinite(Number(row.hours))) return Number(row.hours);
  if (row.attendance_status === 'attended' && Number.isFinite(Number(sessionHours))) return Number(sessionHours);
  return null;
}

/**
 * An outcome that means this person needs the training again on their own.
 *
 * A session that went well for four people and not for the fifth is the normal
 * case, and the fifth person's retraining is owed to them individually rather
 * than by repeating the whole session. This is the test that raises it.
 */
export function needsIndividualRetraining(outcome?: string | null): boolean {
  return outcome === 'unsatisfactory' || outcome === 'needs_further_training';
}

/** What the person came away with. Attending and learning are not the same. */
export const TRAINING_OUTCOMES = ['not_assessed', 'satisfactory', 'competent', 'needs_further_training', 'unsatisfactory'] as const;
export type TrainingOutcome = (typeof TRAINING_OUTCOMES)[number];

export const TRAINING_OUTCOME_LABELS: Record<string, string> = {
  not_assessed: 'Not assessed',
  satisfactory: 'Satisfactory',
  competent: 'Competent',
  needs_further_training: 'Needs further training',
  unsatisfactory: 'Unsatisfactory',
};

export const TRAINING_OUTCOME_TONES: Record<string, 'ok' | 'warn' | 'bad' | 'muted'> = {
  not_assessed: 'muted',
  satisfactory: 'ok',
  competent: 'ok',
  needs_further_training: 'warn',
  unsatisfactory: 'bad',
};

/* ============================================================================
   Did it work?
   ----------------------------------------------------------------------------
   The question a training register is actually asked, and the one it could
   never answer: a list of sessions held proves attendance, not that the work
   changed. So a session carries how its effect will be judged, when that is
   due, and what was found — and until somebody records the finding it reads as
   outstanding rather than quietly counting as done.
   ========================================================================= */
export const EFFECTIVENESS_METHODS = [
  'not_required',
  'competency_assessment',
  'direct_observation',
  'record_review',
  'knowledge_test',
  'qc_performance',
  'eqa_performance',
  'supervisor_feedback',
  'other',
] as const;
export type EffectivenessMethod = (typeof EFFECTIVENESS_METHODS)[number];

export const EFFECTIVENESS_METHOD_LABELS: Record<string, string> = {
  not_required: 'No follow-up needed',
  competency_assessment: 'A competency assessment',
  direct_observation: 'Watching the work afterwards',
  record_review: 'Reviewing the records produced afterwards',
  knowledge_test: 'A knowledge test',
  qc_performance: 'Quality control performance',
  eqa_performance: 'External quality assessment performance',
  supervisor_feedback: 'The supervisor\'s judgement',
  other: 'Other',
};

export const EFFECTIVENESS_OUTCOMES = ['pending', 'effective', 'partially_effective', 'not_effective'] as const;
export type EffectivenessOutcome = (typeof EFFECTIVENESS_OUTCOMES)[number];

export const EFFECTIVENESS_OUTCOME_LABELS: Record<string, string> = {
  pending: 'Not yet reviewed',
  effective: 'Effective',
  partially_effective: 'Partly effective',
  not_effective: 'Not effective — retraining needed',
};

export const EFFECTIVENESS_OUTCOME_TONES: Record<string, 'ok' | 'warn' | 'bad' | 'muted'> = {
  pending: 'muted',
  effective: 'ok',
  partially_effective: 'warn',
  not_effective: 'bad',
};

/** How long after the session to look, when nobody says otherwise. */
export const EFFECTIVENESS_DEFAULT_DAYS = 90;

export function effectivenessDueDate(trainingDate?: string | null, days = EFFECTIVENESS_DEFAULT_DAYS): string | null {
  const base = String(trainingDate ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(base)) return null;
  const date = new Date(`${base}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/* ============================================================================
   Where the record was made
   ----------------------------------------------------------------------------
   A person's training file must not depend on which screen somebody happened
   to be on. Training recorded against an analyser in Equipment Management is
   the same person's training as a session booked in Personnel Management, and
   both belong on their file. The origin is kept so the file can SAY where each
   record came from and link back to it — not so the file can be split by it.
   ========================================================================= */
export const TRAINING_ORIGINS = ['personnel', 'equipment', 'self_declared', 'competency', 'orientation'] as const;
export type TrainingOrigin = (typeof TRAINING_ORIGINS)[number];

export const TRAINING_ORIGIN_LABELS: Record<string, string> = {
  personnel: 'Training register',
  equipment: 'Equipment file',
  self_declared: 'Declared by the member of staff',
  competency: 'Competency assessment',
  orientation: 'Orientation and induction',
};

export const TRAINING_ORIGIN_HINTS: Record<string, string> = {
  personnel: 'A session the laboratory scheduled and ran in Personnel Management.',
  equipment: 'Training on a specific instrument, recorded in Equipment Management. It counts here exactly as any other training does.',
  self_declared: 'Continuing professional development the person entered on their own portal. It reads as declared until Personnel Management verifies the certificate.',
  competency: 'A competency assessment. Not training in itself, but it is the evidence that training worked.',
  orientation: 'Part of the induction programme for somebody new to the laboratory or to a unit.',
};

/**
 * One row of a person's training file, whatever produced it.
 *
 * Deliberately flat and source-agnostic: the panel that renders it should not
 * need to know whether a row came from an equipment record or a course
 * certificate, only how to show it and where to send somebody who wants the
 * original.
 */
export interface TrainingRecordEntry {
  origin: TrainingOrigin;
  /** The row in its own table, for the link back. */
  sourceId: number;
  reference: string | null;
  title: string;
  category: string | null;
  deliveryMode: TrainingDeliveryMode | null;
  trainerType: TrainerType | null;
  trainerName: string | null;
  provider: string | null;
  date: string | null;
  endDate: string | null;
  hours: number | null;
  location: string | null;
  format: string | null;
  attendanceStatus: string | null;
  outcome: string | null;
  /** Where the session itself got to, so a file can tell a plan from a record. */
  status: string | null;
  /** When this person signed the attendance sheet, if they have. */
  signedAt: string | null;
  /** How often the session comes round, for the ones that do. */
  frequency: string | null;
  effectivenessOutcome: string | null;
  effectivenessDueDate: string | null;
  equipmentId: number | null;
  equipmentName: string | null;
  verificationStatus: string | null;
  certificateFileId: number | null;
  notes: string | null;
}

/** Newest first, with undated records last rather than pretending to be old. */
export function sortTrainingRecord(entries: TrainingRecordEntry[]): TrainingRecordEntry[] {
  return [...entries].sort((a, b) => {
    if (!a.date && !b.date) return a.title.localeCompare(b.title);
    if (!a.date) return 1;
    if (!b.date) return -1;
    return b.date.localeCompare(a.date);
  });
}

/**
 * What the file adds up to.
 *
 * Hours are counted only where they were recorded; a session with no duration
 * on it contributes nothing rather than being guessed at, and the count of
 * those is reported so the total is read for what it is.
 */
export function summariseTrainingRecord(entries: TrainingRecordEntry[]) {
  const thisYear = new Date().getFullYear();
  const inYear = (e: TrainingRecordEntry) => Number(String(e.date ?? '').slice(0, 4)) === thisYear;
  const attended = entries.filter(e => e.attendanceStatus !== 'invited' && e.attendanceStatus !== 'absent');
  return {
    total: entries.length,
    thisYear: entries.filter(inYear).length,
    hours: attended.reduce((sum, e) => sum + (Number(e.hours) || 0), 0),
    hoursThisYear: attended.filter(inYear).reduce((sum, e) => sum + (Number(e.hours) || 0), 0),
    withoutHours: attended.filter(e => !Number(e.hours)).length,
    external: entries.filter(e => e.deliveryMode === 'external').length,
    onEquipment: entries.filter(e => e.origin === 'equipment').length,
    awaitingVerification: entries.filter(e => e.verificationStatus === 'declared').length,
    effectivenessOutstanding: entries.filter(e => e.effectivenessOutcome === 'pending' && e.effectivenessDueDate).length,
    // Sessions this person was in the room for and has not yet signed for. The
    // attendance sheet is the evidence the session happened, so an unsigned
    // line is an outstanding piece of work rather than a cosmetic gap.
    awaitingSignature: entries.filter(e => attendedInPerson(e.attendanceStatus) && !e.signedAt
      && (e.origin === 'personnel' || e.origin === 'equipment')).length,
    // Still to come, as opposed to on the record.
    scheduled: entries.filter(e => e.status === 'planned' || e.status === 'postponed').length,
  };
}
