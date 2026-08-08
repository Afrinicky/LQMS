/**
 * The unit activity engine — the part that turns "somebody should chart the
 * fridge temperatures every morning" into a named person's list for today.
 *
 * Four jobs, in the order they run:
 *
 *   generateOccurrences  raise a dated occurrence for every activity that is
 *                        due in the window, once per period
 *   refreshAssignments   resolve (and re-resolve) who each occurrence is on,
 *                        from the live duty roster / unit / bench schedules
 *   dispatchReminders    put the occurrence on the assignee's dashboard, in
 *                        their inbox and — with a sound — on their device
 *   markMissed           close the window on anything that was never done, so
 *                        it becomes a fact the audit can see rather than a
 *                        silence nobody notices
 *
 * Re-running any of them is safe. Occurrences are unique per (activity,
 * period), assignments are recomputed rather than appended, and a reminder is
 * dispatched once per occurrence. That is what lets the schedulers fire every
 * few minutes and lets a mid-month roster change take effect immediately: the
 * next refresh simply resolves a different set of people.
 */
import {
  periodKeyFor, frequencyPhrase,
  type ActivityFrequency, type AssignmentSource,
} from '../../shared/constants/activities.js';
import { generateRecordNumber } from '../utils/recordNumber.js';
import { queuePush } from './pushService.js';
import {
  addDays, daysBetween, leadershipStaffIds, monthOf, onDutyInSection,
  staffOnBench, todayIso, unitHeadOf, unitMembers, usersForStaff,
} from './dutyService.js';
import { isoWeek } from '../../shared/constants/activities.js';
import { schedulingPolicy } from './scheduleRollover.js';

type Db = any;

/* ============================================================================
   Is this activity due on this date?
   ========================================================================= */
function parseList(json: string | null | undefined): number[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.map(Number).filter(n => Number.isFinite(n)) : [];
  } catch { return []; }
}

function parseStrings(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.map(v => String(v).trim().toUpperCase()).filter(Boolean) : [];
  } catch { return []; }
}

function weekdayOf(dateIso: string): number {
  return new Date(`${dateIso}T00:00:00`).getDay();   // 0 = Sunday
}

function monthNumber(dateIso: string): number {
  return Number(dateIso.slice(5, 7));
}

function lastDayOfMonth(dateIso: string): number {
  const [y, m] = dateIso.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}

/**
 * Whether an activity's occurrence starts on this date.
 *
 * A day-of-month later than the month has (the 31st in February) lands on the
 * last day instead of being skipped — a monthly job silently missing four
 * months a year is exactly the kind of gap this system exists to close.
 */
export function isDueOn(activity: any, dateIso: string): boolean {
  const frequency = String(activity.frequency || 'daily') as ActivityFrequency;
  const weekdays = parseList(activity.weekdays);
  const months = parseList(activity.months);
  const dayOfMonth = activity.day_of_month ? Number(activity.day_of_month) : null;

  switch (frequency) {
    case 'per_shift':
    case 'daily':
      return weekdays.length ? weekdays.includes(weekdayOf(dateIso)) : true;

    case 'weekly':
      return weekdays.length ? weekdays.includes(weekdayOf(dateIso)) : weekdayOf(dateIso) === 1;

    case 'fortnightly': {
      const onDay = weekdays.length ? weekdays.includes(weekdayOf(dateIso)) : weekdayOf(dateIso) === 1;
      return onDay && isoWeek(new Date(`${dateIso}T00:00:00`)).week % 2 === 0;
    }

    case 'monthly': {
      const target = Math.min(dayOfMonth || 1, lastDayOfMonth(dateIso));
      return Number(dateIso.slice(8, 10)) === target;
    }

    case 'quarterly':
    case 'biannual':
    case 'annual': {
      const defaults = frequency === 'quarterly' ? [1, 4, 7, 10] : frequency === 'biannual' ? [1, 7] : [1];
      const activeMonths = months.length ? months : defaults;
      if (!activeMonths.includes(monthNumber(dateIso))) return false;
      const target = Math.min(dayOfMonth || 1, lastDayOfMonth(dateIso));
      return Number(dateIso.slice(8, 10)) === target;
    }

    case 'custom_days': {
      const interval = Math.max(1, Number(activity.interval_days) || 1);
      const anchor = String(activity.created_at || dateIso).slice(0, 10);
      const elapsed = daysBetween(anchor, dateIso);
      return elapsed >= 0 && elapsed % interval === 0;
    }

    default:
      return false;
  }
}

/** The last day an occurrence may still be completed before it counts as missed. */
export function windowEndFor(activity: any, dateIso: string): string {
  const frequency = String(activity.frequency || 'daily') as ActivityFrequency;
  switch (frequency) {
    case 'per_shift':
    case 'daily':
    case 'custom_days':
      return dateIso;
    case 'weekly':
    case 'fortnightly':
      return addDays(dateIso, 6);
    case 'monthly':
      return addDays(dateIso, 27);
    case 'quarterly':
      return addDays(dateIso, 85);
    case 'biannual':
      return addDays(dateIso, 175);
    case 'annual':
      return addDays(dateIso, 355);
    default:
      return dateIso;
  }
}

/* ============================================================================
   Generation
   ========================================================================= */
export type GenerationResult = { from: string; to: string; activities: number; created: number; refreshed: number };

/**
 * Raise occurrences for every active activity across a date window.
 *
 * The window runs from today rather than from the past: back-filling a fortnight
 * of missed daily charting the first time the feature is switched on would bury
 * the unit under a hundred red items on day one, which is the fastest way to
 * teach staff to ignore the list.
 */
export function generateOccurrences(db: Db, opts: { from?: string; to?: string } = {}): GenerationResult {
  const policy = schedulingPolicy(db);
  const from = opts.from ?? todayIso();
  const to = opts.to ?? addDays(from, Math.max(1, policy.activity_generation_days));
  const activities = db.prepare('SELECT * FROM unit_activities WHERE is_active = 1').all() as any[];

  const exists = db.prepare('SELECT id FROM activity_occurrences WHERE activity_id = ? AND period_key = ?');
  const insert = db.prepare(`INSERT INTO activity_occurrences
     (activity_id, period_key, occurrence_date, window_start, window_end, due_at, section_id, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`);

  const created: number[] = [];
  const run = db.transaction(() => {
    for (const activity of activities) {
      const frequency = String(activity.frequency || 'daily') as ActivityFrequency;
      for (let date = from; date <= to; date = addDays(date, 1)) {
        if (!isDueOn(activity, date)) continue;
        const periodKey = periodKeyFor(frequency, date);
        if (exists.get(activity.id, periodKey)) continue;
        const windowEnd = windowEndFor(activity, date);
        const dueAt = activity.due_time ? `${date}T${String(activity.due_time).slice(0, 5)}:00` : null;
        created.push(Number(insert.run(activity.id, periodKey, date, date, windowEnd, dueAt, activity.section_id).lastInsertRowid));
      }
    }
  });
  run();

  const refreshed = refreshAssignments(db, { from, to });
  return { from, to, activities: activities.length, created: created.length, refreshed };
}

/* ============================================================================
   Assignment
   ========================================================================= */

/**
 * Who an occurrence is on, resolved from the live schedules.
 *
 * Owners are the people expected to do the work; watchers are leadership, who
 * see it without it becoming their own to-do. That distinction is the whole
 * routing rule the laboratory asked for, so it is made once, here.
 */
function resolveAssignees(db: Db, activity: any, occurrence: any): Array<{ staffId: number; source: AssignmentSource; shiftCode: string | null; benchName: string | null; watcher: boolean }> {
  const date = occurrence.occurrence_date as string;
  const month = monthOf(date);
  const sectionId = Number(occurrence.section_id || activity.section_id) || null;
  const mode = String(activity.assign_mode || 'on_duty');
  const shiftCodes = parseStrings(activity.shift_codes);
  const out = new Map<number, { staffId: number; source: AssignmentSource; shiftCode: string | null; benchName: string | null; watcher: boolean }>();

  const add = (staffId: number | null | undefined, source: AssignmentSource, shiftCode: string | null, benchName: string | null, watcher: boolean) => {
    const id = Number(staffId);
    if (!Number.isFinite(id) || id <= 0) return;
    const existing = out.get(id);
    // Being an owner always beats being a watcher: a unit head who is also on
    // the bench that day owns the work, they do not merely observe it.
    if (existing && (!existing.watcher || watcher)) return;
    out.set(id, { staffId: id, source, shiftCode, benchName, watcher });
  };

  if (mode === 'named_staff') {
    add(activity.responsible_staff_id, 'named_staff', null, null, false);
  } else if (mode === 'unit_head' && sectionId) {
    add(unitHeadOf(db, sectionId, month), 'unit_head', null, null, false);
  } else if (mode === 'whole_unit' && sectionId) {
    for (const staffId of unitMembers(db, sectionId, month)) add(staffId, 'unit_member', null, null, false);
  } else if (mode === 'bench' && sectionId) {
    const benchName = activity.bench_id
      ? (db.prepare('SELECT name, code FROM section_benches WHERE id = ?').get(activity.bench_id) as any)
      : null;
    const names = [benchName?.name, benchName?.code].filter(Boolean) as string[];
    const onBench = staffOnBench(db, sectionId, names, date);
    const onDuty = new Map(onDutyInSection(db, sectionId, date, shiftCodes).map(e => [e.staffId, e]));
    for (const entry of onBench) {
      // A bench schedule is a plan; the duty roster is the record of who is
      // actually in the building. Where both exist, both must agree.
      const duty = onDuty.get(entry.staffId);
      if (onDuty.size && !duty) continue;
      add(entry.staffId, 'bench_schedule', duty?.shiftCode ?? null, entry.benchName, false);
    }
    // A bench nobody was scheduled onto still needs covering, so the unit's
    // on-duty staff pick it up rather than the work vanishing.
    if (![...out.values()].some(a => !a.watcher)) {
      for (const entry of onDutyInSection(db, sectionId, date, shiftCodes)) {
        add(entry.staffId, entry.source, entry.shiftCode, null, false);
      }
    }
  } else if (sectionId) {
    for (const entry of onDutyInSection(db, sectionId, date, shiftCodes)) {
      add(entry.staffId, entry.source, entry.shiftCode, null, false);
    }
  }

  // Nobody on duty at all — a public holiday, an empty roster, a unit with no
  // members. The unit head carries it so the gap has an owner rather than
  // becoming a missed item with nobody's name on it.
  if (![...out.values()].some(a => !a.watcher) && sectionId) {
    add(unitHeadOf(db, sectionId, month), 'unit_head', null, null, false);
  }

  if (activity.notify_leadership !== 0) {
    for (const staffId of leadershipStaffIds(db, sectionId, month)) add(staffId, 'unit_head', null, null, true);
  }

  return [...out.values()];
}

/**
 * Recompute assignments for every occurrence still open in a window.
 *
 * This is what makes a mid-month roster change land where it should: nothing is
 * pinned at generation time, so the moment the manager repaints a shift, the
 * next refresh moves the day's work to whoever the roster now names. Completed
 * occurrences are left alone — the record of who did the work is history.
 */
export function refreshAssignments(db: Db, opts: { from?: string; to?: string } = {}): number {
  const from = opts.from ?? todayIso();
  const to = opts.to ?? addDays(from, 14);
  const occurrences = db.prepare(`SELECT o.*, a.assign_mode, a.section_id AS activity_section_id, a.shift_codes, a.bench_id,
       a.responsible_staff_id, a.notify_leadership
     FROM activity_occurrences o JOIN unit_activities a ON a.id = o.activity_id
     WHERE o.occurrence_date BETWEEN ? AND ? AND o.status IN ('pending', 'in_progress') AND a.is_active = 1`).all(from, to) as any[];

  const insert = db.prepare(`INSERT INTO activity_assignees (occurrence_id, staff_id, user_id, assignment_source, shift_code, bench_name, is_watcher)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(occurrence_id, staff_id) DO UPDATE SET
       assignment_source = excluded.assignment_source, shift_code = excluded.shift_code,
       bench_name = excluded.bench_name, is_watcher = excluded.is_watcher, user_id = excluded.user_id`);

  let touched = 0;
  const run = db.transaction(() => {
    for (const occurrence of occurrences) {
      const activity = { ...occurrence, section_id: occurrence.activity_section_id };
      const resolved = resolveAssignees(db, activity, occurrence);
      const userIds = usersForStaff(db, resolved.map(r => r.staffId));
      const keep = new Set(resolved.map(r => r.staffId));

      // Drop people the schedules no longer place here, unless they have
      // already been told about it — an alert that has been read should not
      // silently disappear from somebody's inbox.
      const current = db.prepare('SELECT staff_id, notified_at FROM activity_assignees WHERE occurrence_id = ?').all(occurrence.id) as any[];
      for (const row of current) {
        if (!keep.has(Number(row.staff_id)) && !row.notified_at) {
          db.prepare('DELETE FROM activity_assignees WHERE occurrence_id = ? AND staff_id = ?').run(occurrence.id, row.staff_id);
        }
      }
      for (const entry of resolved) {
        insert.run(occurrence.id, entry.staffId, userIds.get(entry.staffId) ?? null, entry.source, entry.shiftCode, entry.benchName, entry.watcher ? 1 : 0);
      }
      touched++;
    }
  });
  run();
  return touched;
}

/* ============================================================================
   Reminders
   ========================================================================= */
function activityActionUrl(activity: any, occurrenceId: number): string {
  if (activity.target_route) {
    const separator = String(activity.target_route).includes('?') ? '&' : '?';
    return `${activity.target_route}${separator}activity=${occurrenceId}`;
  }
  return `/dashboard?activity=${occurrenceId}`;
}

function soundKeyFor(activity: any, overdue: boolean): string {
  if (overdue) return 'overdue';
  if (String(activity.priority || 'normal') === 'critical') return 'critical';
  return 'todo';
}

/**
 * Put today's occurrences in front of the people they belong to.
 *
 * Owners get an unread notification with a sound; watchers get the same item at
 * information severity so leadership can see the unit's day without the item
 * counting as theirs to do.
 */
export function dispatchReminders(db: Db, today = todayIso()): { reminded: number; notifications: number } {
  const due = db.prepare(`SELECT o.*, a.name, a.instructions, a.priority, a.target_route, a.target_module_key, a.sound_key,
       a.notify_leadership, a.frequency, a.interval_days, a.estimated_minutes, s.name AS section_name
     FROM activity_occurrences o
     JOIN unit_activities a ON a.id = o.activity_id
     LEFT JOIN sections s ON s.id = o.section_id
     WHERE o.status = 'pending' AND o.reminded_at IS NULL AND o.occurrence_date <= ? AND o.window_end >= ?`)
    .all(today, today) as any[];

  let notifications = 0;
  for (const occurrence of due) {
    const assignees = db.prepare('SELECT * FROM activity_assignees WHERE occurrence_id = ?').all(occurrence.id) as any[];
    if (!assignees.length) continue;
    const actionUrl = activityActionUrl(occurrence, occurrence.id);
    const where = occurrence.section_name ? ` — ${occurrence.section_name}` : '';
    const cadence = frequencyPhrase(occurrence.frequency, occurrence.interval_days);

    for (const assignee of assignees) {
      const watcher = assignee.is_watcher === 1;
      const title = watcher
        ? `${occurrence.section_name || 'Unit'} activity due: ${occurrence.name}`
        : `Today: ${occurrence.name}${where}`;
      const body = watcher
        ? `${cadence}. Assigned to the staff on duty${where}.`
        : `${cadence}${occurrence.estimated_minutes ? ` · about ${occurrence.estimated_minutes} min` : ''}. ${occurrence.instructions || 'Open it from your dashboard when it is done.'}`;

      const number = generateRecordNumber(db, 'notifications', 'NOTIF', new Date().toISOString());
      db.prepare(`INSERT INTO notifications
         (notification_number, user_id, module_key, title, message, status, severity, notification_type, due_date,
          record_type, record_id, assigned_to_staff_id, assigned_to_user_id, action_url, action_label, auto_resolve_key)
         VALUES (?, ?, ?, ?, ?, 'unread', ?, ?, ?, 'activity_occurrences', ?, ?, ?, ?, ?, ?)`)
        .run(number, assignee.user_id ?? null, occurrence.target_module_key || 'personnel', title, body,
          watcher ? 'info' : (occurrence.priority === 'critical' ? 'high' : 'medium'),
          watcher ? 'system_notice' : 'task_assigned', occurrence.occurrence_date,
          String(occurrence.id), assignee.staff_id, assignee.user_id ?? null, actionUrl,
          watcher ? 'View' : 'Mark done', `activity:${occurrence.id}:${assignee.staff_id}`);
      notifications++;

      if (assignee.user_id) {
        queuePush({
          userId: Number(assignee.user_id),
          title,
          body,
          priority: watcher ? 'low' : (occurrence.priority === 'critical' ? 'high' : 'normal'),
          moduleKey: occurrence.target_module_key || 'personnel',
          createInApp: false,   // the in-app record above is the one that counts
          payload: {
            kind: 'activity_occurrence',
            occurrenceId: occurrence.id,
            actionUrl,
            watcher,
            // The client resolves this event name against the user's own sound
            // preference, so the laboratory can retune the chimes without a
            // change here.
            soundEvent: soundKeyFor(occurrence, false),
            soundKey: occurrence.sound_key || null,
          },
        });
      }
      db.prepare('UPDATE activity_assignees SET notified_at = CURRENT_TIMESTAMP WHERE id = ?').run(assignee.id);
    }
    db.prepare('UPDATE activity_occurrences SET reminded_at = CURRENT_TIMESTAMP WHERE id = ?').run(occurrence.id);
  }
  return { reminded: due.length, notifications };
}

/* ============================================================================
   Missed work
   ========================================================================= */

/**
 * Close the window on anything still open past its last day.
 *
 * The grace period is deliberate: a night-shift reading charted at 00:30 for
 * the previous day is done work, not a missed activity, and marking it missed
 * at the stroke of midnight would make the whole register untrustworthy.
 */
export function markMissed(db: Db, today = todayIso()): { missed: number } {
  const policy = schedulingPolicy(db);
  const graceHours = Math.max(0, policy.missed_grace_hours);
  const now = new Date();
  const hoursIntoDay = now.getHours() + now.getMinutes() / 60;
  // Yesterday's window only closes once the grace period into today has passed.
  const cutoff = hoursIntoDay >= graceHours ? addDays(today, -1) : addDays(today, -2);

  const stale = db.prepare(`SELECT o.id, o.activity_id, o.occurrence_date, o.section_id, a.name, a.priority, a.notify_leadership
     FROM activity_occurrences o JOIN unit_activities a ON a.id = o.activity_id
     WHERE o.status IN ('pending', 'in_progress') AND o.window_end <= ?`).all(cutoff) as any[];

  const run = db.transaction(() => {
    for (const occurrence of stale) {
      db.prepare("UPDATE activity_occurrences SET status = 'missed', missed_flagged_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(occurrence.id);
      db.prepare(`INSERT INTO audit_logs (actor_user_id, action, entity, entity_id, new_value)
         VALUES (NULL, 'missed', 'activity_occurrences', ?, ?)`)
        .run(String(occurrence.id), JSON.stringify({ activity: occurrence.name, date: occurrence.occurrence_date, sectionId: occurrence.section_id }));
    }
  });
  run();
  return { missed: stale.length };
}

/* ============================================================================
   Completion
   ========================================================================= */
export function completeOccurrence(db: Db, occurrenceId: number, input: { staffId: number | null; userId: number | null; note?: string | null; evidenceFileId?: number | null; linkedRecordType?: string | null; linkedRecordId?: string | null; easeRating?: number | null; minutesTaken?: number | null }): { ok: boolean } {
  const occurrence = db.prepare('SELECT * FROM activity_occurrences WHERE id = ?').get(occurrenceId) as any;
  if (!occurrence) return { ok: false };

  db.prepare(`UPDATE activity_occurrences SET status = 'done', completed_at = CURRENT_TIMESTAMP, completed_by_staff_id = ?,
       completion_note = ?, evidence_file_id = ?, linked_record_type = ?, linked_record_id = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`)
    .run(input.staffId, input.note ?? null, input.evidenceFileId ?? null, input.linkedRecordType ?? null, input.linkedRecordId ?? null, occurrenceId);

  // Retire the alerts this occurrence raised, for everyone it was raised on —
  // an item finished by a colleague must not stay red on your dashboard.
  db.prepare(`UPDATE notifications SET status = 'resolved', resolved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE record_type = 'activity_occurrences' AND record_id = ? AND status NOT IN ('resolved', 'dismissed')`)
    .run(String(occurrenceId));

  if (input.easeRating || input.minutesTaken) {
    db.prepare(`INSERT INTO activity_feedback (activity_id, occurrence_id, staff_id, ease_rating, minutes_taken, comment, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(occurrence.activity_id, occurrenceId, input.staffId, input.easeRating ?? null, input.minutesTaken ?? null, input.note ?? null, input.userId);
  }
  return { ok: true };
}

/* ============================================================================
   What one person sees
   ========================================================================= */
const TODO_SELECT = `SELECT o.*, a.name AS activity_name, a.activity_code, a.category, a.frequency, a.interval_days,
     a.priority, a.instructions, a.target_route, a.target_module_key, a.estimated_minutes, a.evidence_required,
     a.sound_key, a.redesign_status, s.name AS section_name, asg.assignment_source, asg.is_watcher,
     asg.shift_code, asg.bench_name, cs.full_name AS completed_by_name
   FROM activity_occurrences o
   JOIN unit_activities a ON a.id = o.activity_id
   JOIN activity_assignees asg ON asg.occurrence_id = o.id
   LEFT JOIN sections s ON s.id = o.section_id
   LEFT JOIN staff cs ON cs.id = o.completed_by_staff_id`;

/**
 * One staff member's day: the work that is theirs, and the work they watch.
 *
 * "Theirs" spans an open window rather than a single date, so a weekly task
 * raised on Monday is still on Wednesday's list until it is done — which is how
 * people actually work, and stops the list lying about what is outstanding.
 */
export function todosFor(db: Db, staffId: number, date = todayIso()): { mine: any[]; watching: any[] } {
  const mine = db.prepare(`${TODO_SELECT}
     WHERE asg.staff_id = ? AND asg.is_watcher = 0
       AND ((o.status IN ('pending', 'in_progress') AND o.window_start <= ? AND o.window_end >= ?)
            OR (o.status IN ('done', 'missed') AND o.occurrence_date = ?))
     ORDER BY CASE o.status WHEN 'pending' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'missed' THEN 2 ELSE 3 END,
              CASE a.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
              o.due_at, o.occurrence_date`).all(staffId, date, date, date) as any[];

  const watching = db.prepare(`${TODO_SELECT}
     WHERE asg.staff_id = ? AND asg.is_watcher = 1
       AND o.status IN ('pending', 'in_progress', 'missed')
       AND o.window_start <= ? AND o.window_end >= ?
     ORDER BY CASE o.status WHEN 'missed' THEN 0 ELSE 1 END, o.occurrence_date`).all(staffId, date, date) as any[];

  return { mine, watching };
}

/** Occurrences the whole laboratory is carrying on a date — the audit's view. */
export function occurrencesOn(db: Db, date: string, opts: { sectionId?: number | null; status?: string | null } = {}): any[] {
  const clauses = ['o.window_start <= ?', 'o.window_end >= ?'];
  const params: unknown[] = [date, date];
  if (opts.sectionId) { clauses.push('o.section_id = ?'); params.push(opts.sectionId); }
  if (opts.status) { clauses.push('o.status = ?'); params.push(opts.status); }
  return db.prepare(`SELECT o.*, a.name AS activity_name, a.activity_code, a.category, a.frequency, a.priority,
       a.redesign_status, s.name AS section_name, cs.full_name AS completed_by_name,
       (SELECT GROUP_CONCAT(st.full_name, ', ') FROM activity_assignees ag JOIN staff st ON st.id = ag.staff_id
         WHERE ag.occurrence_id = o.id AND ag.is_watcher = 0) AS assignee_names
     FROM activity_occurrences o
     JOIN unit_activities a ON a.id = o.activity_id
     LEFT JOIN sections s ON s.id = o.section_id
     LEFT JOIN staff cs ON cs.id = o.completed_by_staff_id
     WHERE ${clauses.join(' AND ')}
     ORDER BY o.occurrence_date, a.name`).all(...params) as any[];
}

/* ============================================================================
   The full daily tick
   ========================================================================= */
export function runActivityTick(db: Db, today = todayIso()): { generated: GenerationResult; reminders: { reminded: number; notifications: number }; missed: { missed: number } } {
  const generated = generateOccurrences(db, { from: today });
  const missed = markMissed(db, today);
  const reminders = dispatchReminders(db, today);
  return { generated, reminders, missed };
}

/* ============================================================================
   Seeding a catalogue from what the laboratory has already configured
   ----------------------------------------------------------------------------
   Nobody will type in eighty activities by hand. The laboratory has already
   told the system about its fridges, its instruments and its monitoring
   parameters; these become proposed activities the manager accepts in one
   click, which is the difference between a feature that gets used and one that
   stays empty.
   ========================================================================= */
export type ActivityProposal = {
  sourceKey: string;
  name: string;
  category: string;
  frequency: string;
  sectionId: number | null;
  sectionName: string | null;
  equipmentId: number | null;
  environmentalAssetId: number | null;
  monitoringItemId: number | null;
  targetModuleKey: string;
  targetRoute: string;
  instructions: string;
  estimatedMinutes: number;
};

const FREQUENCY_FROM_TEXT: Record<string, string> = {
  daily: 'daily', weekly: 'weekly', fortnightly: 'fortnightly', monthly: 'monthly',
  quarterly: 'quarterly', biannual: 'biannual', 'bi-annual': 'biannual', annual: 'annual',
  yearly: 'annual', 'per shift': 'per_shift', shift: 'per_shift',
};

function normaliseFrequency(text: unknown, fallback = 'daily'): string {
  const key = String(text || '').trim().toLowerCase();
  return FREQUENCY_FROM_TEXT[key] ?? fallback;
}

export function proposeActivities(db: Db): ActivityProposal[] {
  const out: ActivityProposal[] = [];
  const taken = new Set((db.prepare('SELECT activity_code FROM unit_activities').all() as any[]).map(r => String(r.activity_code)));
  const sectionName = (id: unknown): string | null => {
    if (!id) return null;
    const row = db.prepare('SELECT name FROM sections WHERE id = ?').get(id) as any;
    return row?.name ?? null;
  };

  // Environmental assets — the fridges, freezers and rooms already registered.
  for (const asset of db.prepare('SELECT * FROM environmental_assets WHERE is_active = 1').all() as any[]) {
    const code = `ENV-${asset.asset_code}`;
    if (taken.has(code)) continue;
    const sectionId = asset.responsible_section_id || asset.section_id || null;
    out.push({
      sourceKey: code,
      name: `Environmental monitoring — ${asset.name}`,
      category: 'environmental',
      frequency: normaliseFrequency(asset.monitoring_frequency, 'daily'),
      sectionId, sectionName: sectionName(sectionId),
      equipmentId: asset.equipment_id ?? null,
      environmentalAssetId: Number(asset.id),
      monitoringItemId: null,
      targetModuleKey: 'monitoring',
      targetRoute: `/facilities-safety?tab=Environmental%20Monitoring&subtab=Readings&focus=environmental_assets:${asset.id}`,
      instructions: 'Read and chart the temperature and humidity, and record any corrective action.',
      estimatedMinutes: 3,
    });
  }

  // Equipment maintenance programmes already defined on the instruments.
  for (const schedule of db.prepare(`SELECT es.*, e.name AS equipment_name, e.equipment_number
     FROM equipment_schedules es JOIN equipment_items e ON e.id = es.equipment_id WHERE es.is_active = 1`).all() as any[]) {
    const code = `EQP-${schedule.equipment_number}-${schedule.id}`;
    if (taken.has(code)) continue;
    const sectionId = schedule.section_id || null;
    out.push({
      sourceKey: code,
      name: `${schedule.schedule_type === 'servicing' ? 'Servicing' : 'Maintenance'} — ${schedule.equipment_name}`,
      category: 'equipment',
      frequency: normaliseFrequency(schedule.frequency, 'monthly'),
      sectionId, sectionName: sectionName(sectionId),
      equipmentId: Number(schedule.equipment_id),
      environmentalAssetId: null, monitoringItemId: null,
      targetModuleKey: 'equipment',
      targetRoute: `/equipment?tab=Equipment%20Register&focus=equipment_items:${schedule.equipment_id}`,
      instructions: schedule.task_description || 'Carry out the scheduled maintenance and log the record against the instrument.',
      estimatedMinutes: 15,
    });
  }

  // Monitoring parameters (the manual charting register).
  for (const item of db.prepare('SELECT * FROM monitoring_items WHERE is_active = 1').all() as any[]) {
    const code = `MON-${item.item_code}`;
    if (taken.has(code)) continue;
    const sectionId = item.section_id || null;
    out.push({
      sourceKey: code,
      name: `${item.parameter} charting — ${item.name}`,
      category: 'records',
      frequency: normaliseFrequency(item.frequency, 'daily'),
      sectionId, sectionName: sectionName(sectionId),
      equipmentId: null, environmentalAssetId: null,
      monitoringItemId: Number(item.id),
      targetModuleKey: 'monitoring',
      targetRoute: `/monitoring?tab=Enter%20Reading&focus=monitoring_items:${item.id}`,
      instructions: `Record the ${item.parameter} reading${item.unit ? ` in ${item.unit}` : ''}.`,
      estimatedMinutes: 2,
    });
  }

  return out;
}

/** Turn accepted proposals into real activity definitions. */
export function adoptProposals(db: Db, proposals: ActivityProposal[], userId: number | null): { created: number } {
  const insert = db.prepare(`INSERT OR IGNORE INTO unit_activities
     (activity_code, name, description, instructions, category, section_id, equipment_id, environmental_asset_id,
      monitoring_item_id, target_module_key, target_route, frequency, assign_mode, priority, estimated_minutes,
      notify_leadership, is_active, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'on_duty', 'normal', ?, 1, 1, ?)`);
  let created = 0;
  const run = db.transaction(() => {
    for (const proposal of proposals) {
      const result = insert.run(proposal.sourceKey, proposal.name,
        `Created from the laboratory's existing configuration.`, proposal.instructions, proposal.category,
        proposal.sectionId, proposal.equipmentId, proposal.environmentalAssetId, proposal.monitoringItemId,
        proposal.targetModuleKey, proposal.targetRoute, proposal.frequency, proposal.estimatedMinutes, userId);
      if (result.changes) created++;
    }
  });
  run();
  return { created };
}
