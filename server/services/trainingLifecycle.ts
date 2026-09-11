/**
 * The life of a training session, from the memo to the signed report.
 *
 * WHAT WAS WRONG. The register could hold a training session but it had no
 * sense of one happening. A row was created, and from that moment it was a row
 * like any other: editable forever, by anybody with the edit right, with no
 * point at which it became a record rather than a draft. So the three things a
 * laboratory actually does around training had nowhere to live.
 *
 *   TELLING PEOPLE. A session scheduled for next Tuesday is of no use to the
 *   four people expected at it unless they are told, and told again when the day
 *   comes. Scheduling now sends the memo; the day before, it sends the notice.
 *   Postponing or calling the session off tells them that too, because a
 *   session quietly moved is worse than one never booked.
 *
 *   FINISHING. A session stops being a plan when it is closed by somebody
 *   senior, and closure is what disseminates it: from that moment it is on
 *   every attendee's own file and on their portal, and it is out of reach of
 *   casual editing. Before that it is documentation outstanding, and says so.
 *
 *   COMING ROUND AGAIN. Most real training recurs — safety, the quality
 *   manual, the annual refresher. Closing one occurrence raises the next, so a
 *   programme runs without anybody remembering to re-enter it, and each
 *   occurrence is reviewed for effect in its own right. A one-off is reviewed
 *   once and is then done.
 *
 * And one thing that follows from closing a session honestly: a session that
 * did not work for somebody is the normal case, not the exception. Closure
 * reads the outcomes and raises an individual session for anybody found
 * unsatisfactory, for them alone, rather than leaving a note asking a
 * supervisor to remember.
 *
 * Nothing here decides WHO may do any of it. That is the routes' business and
 * is enforced there; this module is what happens once they have decided.
 */
import {
  attendedInPerson, needsIndividualRetraining, nextTrainingDate, trainingRecurs,
  effectivenessDueDate, recurrenceSummary,
  TRAINING_CATEGORY_LABELS,
} from '../../shared/constants/training.js';
import { generateRecordNumber } from '../utils/recordNumber.js';

type DB = any;
type Row = Record<string, any>;

/** How many days after a session that failed somebody their own session falls. */
export const REMEDIAL_WITHIN_DAYS = 14;

/** How many days before a session the reminder goes out. */
export const REMINDER_LEAD_DAYS = 1;

const str = (value: unknown): string | null => {
  const text = String(value ?? '').trim();
  return text ? text : null;
};
const num = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const today = () => new Date().toISOString().slice(0, 10);

function addDays(from: string, days: number): string {
  const date = new Date(`${String(from).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return today();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/* ============================================================================
   Telling the people it concerns
   ========================================================================= */

/**
 * One notification to one member of staff.
 *
 * Addressed to the staff record first and the user account second, because a
 * laboratory has staff who have not been given a login yet and their training
 * memo must still exist for when they are. Deduplicated on the record and the
 * kind of notice, so a timer that fires every ten minutes does not fill
 * somebody's inbox with the same reminder.
 */
function notifyOne(db: DB, staffId: number, notice: {
  kind: string;
  title: string;
  message: string;
  severity?: string;
  notificationType?: string;
  eventId: number;
  dueDate?: string | null;
}): boolean {
  const account = db.prepare('SELECT id FROM users WHERE staff_id = ? AND is_active = 1 ORDER BY id LIMIT 1')
    .get(staffId) as { id: number } | undefined;
  const recordType = `training_events:${notice.kind}`;
  const recordId = String(notice.eventId);
  const already = db.prepare('SELECT id FROM notifications WHERE assigned_to_staff_id = ? AND record_type = ? AND record_id = ?')
    .get(staffId, recordType, recordId);
  if (already) return false;

  db.prepare(`INSERT INTO notifications
      (user_id, module_key, title, message, status, severity, notification_type,
       record_type, record_id, assigned_to_staff_id, assigned_to_user_id, action_url, action_label, due_date, created_by)
      VALUES (?, 'personnel.training', ?, ?, 'unread', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`)
    .run(account?.id ?? null, notice.title, notice.message,
      notice.severity ?? 'medium', notice.notificationType ?? 'task_assigned',
      recordType, recordId, staffId, account?.id ?? null,
      '/portal/training', 'Open my training', notice.dueDate ?? null);
  return true;
}

/** The one-line description of a session, worded the same in every notice. */
function describe(event: Row): string {
  const parts = [
    event.training_date ? `on ${String(event.training_date).slice(0, 10)}` : null,
    event.start_time ? `at ${event.start_time}` : null,
    event.location ? `in ${event.location}` : null,
  ].filter(Boolean);
  return parts.join(' ');
}

/**
 * What every notice about a session says, before the reason for this one.
 *
 * An assessor reads these as the evidence that notice was given, and somebody
 * deciding whether to rearrange their morning reads them to find out what the
 * session is. Both want the same four facts, so they are always present.
 */
function body(event: Row, lead: string): string {
  const lines = [lead];
  const where = describe(event);
  if (where) lines.push(`When: ${where}.`);
  if (event.duration_hours) lines.push(`Expected to take ${event.duration_hours} hours.`);
  if (event.category) lines.push(`Subject: ${TRAINING_CATEGORY_LABELS[event.category] ?? event.category}.`);
  if (event.objectives) lines.push(`What it is meant to achieve: ${event.objectives}`);
  const series = recurrenceSummary(event.frequency, event.frequency_interval_days);
  if (series) lines.push(`This is a recurring session — ${series.toLowerCase()}.`);
  return lines.join('\n');
}

export type NoticeKind = 'scheduled' | 'reminder' | 'postponed' | 'cancelled' | 'closed' | 'remedial';

/**
 * Tell everybody on the list. Returns how many were actually told.
 *
 * Who is on the list depends on the notice: a memo about a session that is
 * still to happen goes to everybody invited, while word that a session has
 * been closed and is now on their file goes only to the people who were
 * actually there — telling somebody who was marked absent that their record has
 * been updated would be untrue.
 */
export function notifyParticipants(db: DB, eventId: number, kind: NoticeKind): number {
  const event = db.prepare('SELECT * FROM training_events WHERE id = ?').get(eventId) as Row | undefined;
  if (!event) return 0;

  const attendance = db.prepare('SELECT staff_id, attendance_status FROM training_attendance WHERE training_event_id = ?')
    .all(eventId) as Row[];
  const audience = kind === 'closed'
    ? attendance.filter(a => attendedInPerson(a.attendance_status))
    : attendance;
  if (audience.length === 0) return 0;

  const ref = event.training_number ? `${event.training_number} — ` : '';
  const notices: Record<NoticeKind, { title: string; message: string; severity: string; type: string }> = {
    scheduled: {
      title: `Training scheduled: ${event.title}`,
      message: body(event, `${ref}You are expected at this training session.`),
      severity: 'medium', type: 'task_assigned',
    },
    reminder: {
      title: `Training tomorrow: ${event.title}`,
      message: body(event, `${ref}A reminder that you are expected at this session.`),
      severity: 'high', type: 'due_soon',
    },
    postponed: {
      title: `Training postponed: ${event.title}`,
      message: body(event, `${ref}This session has been postponed.${event.postponement_reason ? ` Reason: ${event.postponement_reason}` : ''}`),
      severity: 'medium', type: 'system_notice',
    },
    cancelled: {
      title: `Training called off: ${event.title}`,
      message: `${ref}This session has been called off and will not be held.${event.cancellation_reason ? ` Reason: ${event.cancellation_reason}` : ''}`,
      severity: 'medium', type: 'system_notice',
    },
    closed: {
      title: `Training on your record: ${event.title}`,
      message: `${ref}This session has been closed and added to your training file. Open it to sign the attendance sheet if you have not already.`,
      severity: 'low', type: 'system_notice',
    },
    remedial: {
      title: `Further training arranged for you: ${event.title}`,
      message: body(event, `${ref}Further individual training has been arranged for you following an earlier session.`),
      severity: 'high', type: 'task_assigned',
    },
  };
  const notice = notices[kind];

  let told = 0;
  for (const person of audience) {
    if (!person.staff_id) continue;
    const sent = notifyOne(db, Number(person.staff_id), {
      kind, eventId,
      title: notice.title, message: notice.message,
      severity: notice.severity, notificationType: notice.type,
      dueDate: kind === 'closed' || kind === 'cancelled' ? null : str(event.training_date),
    });
    if (sent) told++;
  }

  const stamp = kind === 'scheduled' ? 'notified_at'
    : kind === 'reminder' ? 'reminder_sent_at'
      : kind === 'closed' ? 'closure_notified_at' : null;
  if (stamp) db.prepare(`UPDATE training_events SET ${stamp} = CURRENT_TIMESTAMP WHERE id = ?`).run(eventId);
  return told;
}

/* ============================================================================
   Putting people on the list
   ========================================================================= */

/**
 * Invite a group, a selection, or one person.
 *
 * Training is mostly given to groups, occasionally to a handful of named
 * people, and sometimes to one person alone — and the register only ever let
 * somebody be added one at a time, after the session had been created, which is
 * why sessions routinely had nobody on them. The participants are part of
 * scheduling now.
 *
 * Somebody already on the list is left exactly as they are: re-inviting a
 * person who has already been marked present and signed must not wipe that.
 */
export function inviteParticipants(db: DB, eventId: number, staffIds: Array<number | string | null | undefined>, userId: number | null): number {
  const wanted = [...new Set(staffIds.map(id => num(id)).filter((id): id is number => Boolean(id)))];
  if (wanted.length === 0) return 0;
  const exists = db.prepare('SELECT 1 FROM staff WHERE id = ?');
  const onList = db.prepare('SELECT id FROM training_attendance WHERE training_event_id = ? AND staff_id = ?');
  const insert = db.prepare(`INSERT INTO training_attendance
      (training_event_id, staff_id, attendance_status, created_by) VALUES (?, ?, 'invited', ?)`);
  let added = 0;
  for (const staffId of wanted) {
    if (!exists.get(staffId)) continue;
    if (onList.get(eventId, staffId)) continue;
    insert.run(eventId, staffId, userId);
    added++;
  }
  return added;
}

/* ============================================================================
   The session that comes next
   ========================================================================= */

/**
 * Raise the next occurrence of a recurring session.
 *
 * Called when an occurrence closes, which is the only moment the next date is
 * actually knowable: a monthly session held eight days late should put the next
 * one a month after it was HELD, not a month after it was once planned for.
 *
 * The new occurrence inherits everything descriptive — what it is, who teaches
 * it, what it is for, how its effect is judged — and nothing historical. It
 * starts empty of attendance and of findings, with the same people invited,
 * because the list of who should be at the monthly safety briefing is the point
 * of the series. Idempotent: an occurrence that has already raised its
 * successor does not raise a second one.
 */
export function raiseNextOccurrence(db: DB, eventId: number, opts: {
  userId?: number | null;
  makeNumber: (db: DB, table: string, prefix: string, createdAt?: string, codeColumn?: string) => string;
}): { id: number; trainingNumber: string; date: string } | null {
  const event = db.prepare('SELECT * FROM training_events WHERE id = ?').get(eventId) as Row | undefined;
  if (!event || !trainingRecurs(event.frequency)) return null;

  const nextDate = nextTrainingDate(str(event.training_date), event.frequency, num(event.frequency_interval_days));
  if (!nextDate) return null;
  // A series can be given an end, and past it nothing further is raised.
  if (event.series_ends_on && nextDate > String(event.series_ends_on).slice(0, 10)) return null;

  const seriesRoot = num(event.series_parent_id) ?? Number(event.id);
  const already = db.prepare('SELECT id FROM training_events WHERE series_parent_id = ? AND training_date = ?')
    .get(seriesRoot, nextDate) as Row | undefined;
  if (already) return null;

  const createdAt = new Date().toISOString();
  const trainingNumber = opts.makeNumber(db, 'training_events', 'TRN', createdAt, 'training_number');
  const nextIndex = (num(event.series_index) ?? 1) + 1;

  const inserted = db.prepare(`INSERT INTO training_events
      (training_number, title, description, training_type, category, training_format, objectives,
       delivery_mode, trainer_type, trainer_staff_id, external_trainer_name, external_trainer_organisation,
       external_trainer_qualifications, provider, department_id, section_id, equipment_id, document_id,
       training_date, start_time, end_time, duration_hours, location,
       effectiveness_method, effectiveness_due_date, status, training_mode,
       frequency, frequency_interval_days, series_parent_id, series_index, series_ends_on,
       source_module, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', 'scheduled',
              ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(trainingNumber, event.title, event.description, event.training_type, event.category,
      event.training_format, event.objectives, event.delivery_mode, event.trainer_type, event.trainer_staff_id,
      event.external_trainer_name, event.external_trainer_organisation, event.external_trainer_qualifications,
      event.provider, event.department_id, event.section_id, event.equipment_id, event.document_id,
      nextDate, event.start_time, event.end_time, event.duration_hours, event.location,
      event.effectiveness_method,
      // Each occurrence owes its own review. That is what periodic review of a
      // recurring session means, and the reason a series cannot be signed off
      // once and treated as settled for ever.
      event.effectiveness_method === 'not_required' ? null : effectivenessDueDate(nextDate),
      event.frequency, event.frequency_interval_days, seriesRoot, nextIndex, event.series_ends_on,
      event.source_module, opts.userId ?? null, createdAt);
  const nextId = Number(inserted.lastInsertRowid);

  // The same people, invited again and told. The list of who belongs at a
  // recurring session is the substance of the series.
  const people = db.prepare('SELECT staff_id FROM training_attendance WHERE training_event_id = ?').all(eventId) as Row[];
  inviteParticipants(db, nextId, people.map(p => p.staff_id), opts.userId ?? null);
  notifyParticipants(db, nextId, 'scheduled');

  return { id: nextId, trainingNumber, date: nextDate };
}

/* ============================================================================
   When it did not work for somebody
   ========================================================================= */

/**
 * Raise an individual session for everybody this one failed.
 *
 * The point is that it is theirs alone. Repeating a whole session because one
 * person in eight did not come away competent wastes seven people's morning and
 * is why, in practice, it never happens and the shortfall is simply left. A
 * session for one person, already scheduled, with the original named as its
 * cause, is what actually gets done.
 *
 * Idempotent per attendance row: correcting somebody's outcome twice does not
 * give them two remedial sessions.
 */
export function raiseRemedialTraining(db: DB, eventId: number, opts: {
  userId?: number | null;
  makeNumber: (db: DB, table: string, prefix: string, createdAt?: string, codeColumn?: string) => string;
}): Array<{ id: number; trainingNumber: string; staffId: number }> {
  const event = db.prepare('SELECT * FROM training_events WHERE id = ?').get(eventId) as Row | undefined;
  if (!event) return [];

  const shortfalls = (db.prepare(`SELECT a.*, s.full_name AS staff_name
      FROM training_attendance a JOIN staff s ON s.id = a.staff_id
      WHERE a.training_event_id = ?`).all(eventId) as Row[])
    .filter(row => needsIndividualRetraining(row.outcome) && !row.remedial_event_id);
  if (shortfalls.length === 0) return [];

  const raised: Array<{ id: number; trainingNumber: string; staffId: number }> = [];
  for (const row of shortfalls) {
    const createdAt = new Date().toISOString();
    const trainingNumber = opts.makeNumber(db, 'training_events', 'TRN', createdAt, 'training_number');
    const when = addDays(str(event.training_date) ?? today(), REMEDIAL_WITHIN_DAYS);
    const title = `Individual retraining: ${event.title}`;
    const objectives = `Repeat of ${event.training_number ?? 'an earlier session'} for ${row.staff_name} alone, `
      + `who was assessed as ${String(row.outcome).replace(/_/g, ' ')} on it. `
      + `${event.objectives ? `Original aim: ${event.objectives}` : ''}`.trim();

    const inserted = db.prepare(`INSERT INTO training_events
        (training_number, title, description, training_type, category, training_format, objectives,
         delivery_mode, trainer_type, trainer_staff_id, external_trainer_name, external_trainer_organisation,
         external_trainer_qualifications, provider, department_id, section_id, equipment_id, document_id,
         training_date, duration_hours, location,
         effectiveness_method, effectiveness_due_date, status, training_mode,
         remedial_for_event_id, remedial_for_staff_id, source_module, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', 'scheduled', ?, ?, ?, ?, ?)`)
      .run(trainingNumber, title, str(row.effectiveness_notes) ?? str(row.remarks), event.training_type,
        event.category, event.training_format, objectives,
        event.delivery_mode, event.trainer_type, event.trainer_staff_id,
        event.external_trainer_name, event.external_trainer_organisation, event.external_trainer_qualifications,
        event.provider, event.department_id, event.section_id, event.equipment_id, event.document_id,
        when, event.duration_hours, event.location,
        // Retraining that nobody checks the effect of is the same shortfall
        // again, so a competency assessment is asked for by default.
        'competency_assessment', effectivenessDueDate(when),
        eventId, row.staff_id, event.source_module, opts.userId ?? null, createdAt);
    const newId = Number(inserted.lastInsertRowid);

    inviteParticipants(db, newId, [row.staff_id], opts.userId ?? null);
    db.prepare('UPDATE training_attendance SET remedial_event_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(newId, row.id);
    db.prepare(`INSERT INTO record_links
        (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes)
        VALUES ('personnel', 'training_events', ?, 'personnel', 'training_events', ?, ?)`)
      .run(String(eventId), String(newId), `Individual retraining for ${row.staff_name}`);
    notifyParticipants(db, newId, 'remedial');
    raised.push({ id: newId, trainingNumber, staffId: Number(row.staff_id) });
  }
  return raised;
}

/* ============================================================================
   The timer
   ========================================================================= */

/**
 * What the host does about training on its own.
 *
 * Two jobs, both idempotent, both cheap enough to run on the existing ten-minute
 * tick:
 *
 *   THE NOTICE WHEN THE DAY COMES. A memo sent a month ago has been forgotten.
 *   Everybody expected at a session starting tomorrow or today is told again,
 *   once — the stamp on the session is what makes it once.
 *
 *   THE NEXT OCCURRENCE, as a safety net. A recurring session normally raises
 *   its successor when it closes. One that was held and closed on a host that
 *   was switched off, or closed before this code existed, would leave the series
 *   stopped dead; so any closed occurrence whose successor is missing and whose
 *   next date has arrived gets one.
 */
export function runTrainingTick(db: DB): { reminded: number; raised: number } {
  let reminded = 0;
  let raised = 0;

  try {
    const horizon = addDays(today(), REMINDER_LEAD_DAYS);
    const due = db.prepare(`SELECT id FROM training_events
        WHERE status = 'planned' AND training_mode = 'scheduled'
          AND training_date <= ? AND training_date >= date('now', '-1 day')
          AND reminder_sent_at IS NULL`).all(horizon) as Row[];
    for (const row of due) reminded += notifyParticipants(db, Number(row.id), 'reminder') > 0 ? 1 : 0;
  } catch { /* a reminder that cannot be sent must not stop the rest of the tick */ }

  try {
    const stalled = db.prepare(`SELECT id FROM training_events
        WHERE status = 'closed' AND frequency IS NOT NULL AND frequency != 'none'
          AND NOT EXISTS (
            SELECT 1 FROM training_events n
            WHERE n.series_parent_id = COALESCE(training_events.series_parent_id, training_events.id)
              AND n.training_date > training_events.training_date)
        ORDER BY training_date DESC LIMIT 25`).all() as Row[];
    for (const row of stalled) {
      if (raiseNextOccurrence(db, Number(row.id), { userId: null, makeNumber: generateRecordNumber })) raised++;
    }
  } catch { /* the series is repaired on the next tick, or when somebody closes one by hand */ }

  return { reminded, raised };
}
