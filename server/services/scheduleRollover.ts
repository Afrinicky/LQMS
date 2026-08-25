/**
 * Schedule governance: preparation deadlines, and what happens when they pass.
 *
 * The laboratory's rule, expressed here in code:
 *
 *   • The duty roster and the unit reassignment schedule are the laboratory
 *     manager's and quality manager's, and must exist some days before the new
 *     month starts.
 *   • The bench schedules are the unit heads', due a little later — they cannot
 *     sensibly be built until the unit assignments they sit inside exist.
 *   • If a month begins without them, the laboratory does not run unscheduled:
 *     the previous month's stands, automatically, and the roll-forward is
 *     recorded so nobody mistakes it for a schedule somebody prepared.
 *   • If the roster and unit assignments were done but the benches were not,
 *     staff already on a bench stay on it, and staff newly assigned to the unit
 *     fill the benches the departing staff left empty.
 *
 * Every one of these documents can still be changed at any point in the month.
 * Nothing here freezes them; the carry-forward only ever creates what is
 * missing, and every reader resolves the live document through dutyService.
 */
import { generateRecordNumber } from '../utils/recordNumber.js';
import {
  SCHEDULE_KIND_LABELS, SCHEDULE_OWNER_KEYWORDS,
  type ScheduleKind, type CarryForwardReason,
} from '../../shared/constants/activities.js';
import {
  activeBenchSchedule, activeDutyRoster, activeReassignment, daysBetween, daysInMonth,
  monthEnd, monthLabel, monthOf, monthStart, nextMonth, previousMonth, todayIso, unitMembers,
  unitHeadOf, usersForStaff,
} from './dutyService.js';
import { queuePush } from './pushService.js';

type Db = any;

export type SchedulingPolicy = {
  id: number;
  roster_due_days_before: number;
  reassignment_due_days_before: number;
  bench_due_days_before: number;
  reminder_lead_days: number;
  auto_carry_forward: number;
  bench_inherit_gaps: number;
  activity_generation_days: number;
  missed_grace_hours: number;
  notify_leadership_daily: number;
  briefing_hour: number;
  rotation_enabled: number;
  rotation_staff_frequency: string;
  rotation_rotate_unit_heads: number;
  rotation_head_frequency: string;
  rotation_notes: string | null;
};

const POLICY_DEFAULTS: SchedulingPolicy = {
  id: 1,
  roster_due_days_before: 7,
  reassignment_due_days_before: 7,
  bench_due_days_before: 3,
  reminder_lead_days: 14,
  auto_carry_forward: 1,
  bench_inherit_gaps: 1,
  activity_generation_days: 14,
  missed_grace_hours: 6,
  notify_leadership_daily: 1,
  briefing_hour: 5,
  rotation_enabled: 0,
  rotation_staff_frequency: 'monthly',
  rotation_rotate_unit_heads: 0,
  rotation_head_frequency: 'annual',
  rotation_notes: null,
};

export function schedulingPolicy(db: Db): SchedulingPolicy {
  try {
    const row = db.prepare('SELECT * FROM scheduling_policy WHERE id = 1').get() as SchedulingPolicy | undefined;
    return row ? { ...POLICY_DEFAULTS, ...row } : POLICY_DEFAULTS;
  } catch {
    return POLICY_DEFAULTS;
  }
}

/** The last date a schedule may be prepared without being late. */
export function deadlineFor(kind: ScheduleKind, month: string, policy: SchedulingPolicy): string {
  const daysBefore = kind === 'duty_roster' ? policy.roster_due_days_before
    : kind === 'reassignment' ? policy.reassignment_due_days_before
    : policy.bench_due_days_before;
  const start = new Date(`${monthStart(month)}T00:00:00`);
  start.setDate(start.getDate() - Math.max(0, daysBefore));
  return `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`;
}

/* ============================================================================
   What is outstanding right now
   ========================================================================= */
export type ScheduleObligation = {
  kind: ScheduleKind;
  kindLabel: string;
  month: string;
  monthLabel: string;
  sectionId: number | null;
  sectionName: string | null;
  dueDate: string;
  daysRemaining: number;
  /** upcoming | due_soon | overdue | prepared | carried_forward */
  status: string;
  prepared: boolean;
  carriedForward: boolean;
  scheduleId: number | null;
  ownerStaffId: number | null;
  ownerRoleHint: string;
  actionUrl: string;
  message: string;
};

const ROUTES: Record<ScheduleKind, string> = {
  duty_roster: '/personnel?tab=Duty%20Roster',
  reassignment: '/personnel?tab=Unit%20Reassignments',
  bench_schedule: '/personnel?tab=Bench%20Schedules',
};

/**
 * Every schedule the laboratory owes for a month, and where each one stands.
 *
 * Called with the month that is being prepared for — normally next month, but
 * the current month is checked too, because a month that started without a
 * schedule is a live problem, not a historical one.
 */
export function obligationsForMonth(db: Db, month: string, today = todayIso()): ScheduleObligation[] {
  const policy = schedulingPolicy(db);
  const out: ScheduleObligation[] = [];

  const classify = (dueDate: string, prepared: boolean, carried: boolean): { status: string; daysRemaining: number } => {
    const daysRemaining = daysBetween(today, dueDate);
    if (carried) return { status: 'carried_forward', daysRemaining };
    if (prepared) return { status: 'prepared', daysRemaining };
    if (daysRemaining < 0) return { status: 'overdue', daysRemaining };
    if (daysRemaining <= policy.reminder_lead_days) return { status: 'due_soon', daysRemaining };
    return { status: 'upcoming', daysRemaining };
  };

  // ── Laboratory-wide: the duty roster and the unit reassignment ──────────
  const roster = activeDutyRoster(db, month);
  {
    const dueDate = deadlineFor('duty_roster', month, policy);
    const carried = Boolean(roster?.is_carry_forward);
    const { status, daysRemaining } = classify(dueDate, Boolean(roster), carried);
    out.push({
      kind: 'duty_roster', kindLabel: SCHEDULE_KIND_LABELS.duty_roster,
      month, monthLabel: monthLabel(month), sectionId: null, sectionName: null,
      dueDate, daysRemaining, status, prepared: Boolean(roster), carriedForward: carried,
      scheduleId: roster?.id ?? null, ownerStaffId: roster?.prepared_by_staff_id ?? null,
      ownerRoleHint: 'Laboratory Manager / Quality Manager',
      actionUrl: ROUTES.duty_roster,
      message: messageFor('duty_roster', month, status, daysRemaining, null),
    });
  }

  const reassignment = activeReassignment(db, month);
  {
    const dueDate = deadlineFor('reassignment', month, policy);
    const carried = Boolean(reassignment?.is_carry_forward);
    const { status, daysRemaining } = classify(dueDate, Boolean(reassignment), carried);
    out.push({
      kind: 'reassignment', kindLabel: SCHEDULE_KIND_LABELS.reassignment,
      month, monthLabel: monthLabel(month), sectionId: null, sectionName: null,
      dueDate, daysRemaining, status, prepared: Boolean(reassignment), carriedForward: carried,
      scheduleId: reassignment?.id ?? null, ownerStaffId: reassignment?.prepared_by_staff_id ?? null,
      ownerRoleHint: 'Laboratory Manager / Quality Manager',
      actionUrl: ROUTES.reassignment,
      message: messageFor('reassignment', month, status, daysRemaining, null),
    });
  }

  // ── Per unit: the bench schedules ───────────────────────────────────────
  const sections = db.prepare('SELECT id, name FROM sections WHERE is_active = 1 ORDER BY name').all() as any[];
  const benchDue = deadlineFor('bench_schedule', month, policy);
  for (const section of sections) {
    // A unit with no benches configured has no bench schedule to prepare.
    const benchCount = (db.prepare('SELECT COUNT(*) n FROM section_benches WHERE section_id = ? AND is_active = 1').get(section.id) as any).n;
    if (!benchCount) continue;
    const schedule = activeBenchSchedule(db, month, Number(section.id));
    const carried = Boolean(schedule?.is_carry_forward);
    const { status, daysRemaining } = classify(benchDue, Boolean(schedule), carried);
    out.push({
      kind: 'bench_schedule', kindLabel: SCHEDULE_KIND_LABELS.bench_schedule,
      month, monthLabel: monthLabel(month), sectionId: Number(section.id), sectionName: section.name,
      dueDate: benchDue, daysRemaining, status, prepared: Boolean(schedule), carriedForward: carried,
      scheduleId: schedule?.id ?? null,
      ownerStaffId: unitHeadOf(db, Number(section.id), month),
      ownerRoleHint: 'Unit Head',
      actionUrl: `${ROUTES.bench_schedule}&sectionId=${section.id}`,
      message: messageFor('bench_schedule', month, status, daysRemaining, section.name),
    });
  }

  return out;
}

function messageFor(kind: ScheduleKind, month: string, status: string, daysRemaining: number, sectionName: string | null): string {
  const label = SCHEDULE_KIND_LABELS[kind];
  const where = sectionName ? ` for ${sectionName}` : '';
  const when = monthLabel(month);
  switch (status) {
    case 'prepared':
      return `${label}${where} for ${when} is prepared.`;
    case 'carried_forward':
      return `${label}${where} for ${when} was not prepared in time, so the previous month's is running. Review and adjust it.`;
    case 'overdue':
      return `${label}${where} for ${when} is ${Math.abs(daysRemaining)} day${Math.abs(daysRemaining) === 1 ? '' : 's'} late. Prepare it now — until it exists the previous month's will be carried forward.`;
    case 'due_soon':
      return daysRemaining === 0
        ? `${label}${where} for ${when} is due today.`
        : `${label}${where} for ${when} is due in ${daysRemaining} day${daysRemaining === 1 ? '' : 's'}.`;
    default:
      return `${label}${where} for ${when} is due on ${status === 'upcoming' ? 'schedule' : status}.`;
  }
}

/**
 * Everything outstanding across the month that is running and the one being
 * prepared for — the set the dashboard reminders are drawn from.
 */
export function currentObligations(db: Db, today = todayIso()): ScheduleObligation[] {
  const thisMonth = monthOf(today);
  const upcoming = nextMonth(thisMonth);
  // The current month only matters when something is still missing from it.
  const current = obligationsForMonth(db, thisMonth, today).filter(o => !o.prepared || o.carriedForward);
  return [...current, ...obligationsForMonth(db, upcoming, today)];
}

/* ============================================================================
   Carry-forward
   ========================================================================= */
export type CarryForwardResult = {
  month: string;
  created: Array<{ kind: ScheduleKind; sectionId: number | null; sectionName: string | null; fromId: number; newId: number; reason: CarryForwardReason; detail: string }>;
  skipped: number;
};

function recordCarryForward(db: Db, kind: ScheduleKind, month: string, sectionId: number, sourceId: number, createdId: number, reason: CarryForwardReason, detail: string) {
  db.prepare(`INSERT OR IGNORE INTO schedule_carry_forwards (kind, month, section_id, source_id, created_id, reason, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?)`).run(kind, month, sectionId, sourceId, createdId, reason, detail);
  db.prepare(`INSERT INTO audit_logs (actor_user_id, action, entity, entity_id, new_value)
     VALUES (NULL, 'carry_forward', ?, ?, ?)`)
    .run(kind === 'duty_roster' ? 'duty_rosters' : kind === 'reassignment' ? 'reassignment_schedules' : 'bench_schedules',
      String(createdId), JSON.stringify({ month, sectionId: sectionId || null, sourceId, reason, detail }));
}

/** Copy last month's duty roster into `month`, remapping the day columns. */
function carryDutyRoster(db: Db, month: string, result: CarryForwardResult) {
  if (activeDutyRoster(db, month)) return;
  const source = activeDutyRoster(db, previousMonth(month));
  if (!source) return;

  const days = daysInMonth(month);
  const createdAt = new Date().toISOString();
  const number = generateRecordNumber(db, 'duty_rosters', 'ROSTER', createdAt);
  const note = `Carried forward automatically from ${source.roster_number || `roster ${source.id}`} (${monthLabel(previousMonth(month))}) because no roster was prepared for ${monthLabel(month)}.`;
  const insert = db.prepare(`INSERT INTO duty_rosters
     (roster_number, department_id, section_id, month, title, shift_codes, header_org, header_facility, header_subtitle,
      roster_start_date, roster_end_date, status, prepared_by_staff_id, notes, created_by, created_at,
      carried_forward_from_id, is_carry_forward, carry_forward_note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', ?, ?, NULL, ?, ?, 1, ?)`);
  const newId = Number(insert.run(
    number, source.department_id, source.section_id, month, source.title, source.shift_codes,
    source.header_org, source.header_facility, source.header_subtitle,
    monthStart(month), monthEnd(month), source.prepared_by_staff_id, source.notes, createdAt,
    source.id, note,
  ).lastInsertRowid);

  const insRow = db.prepare('INSERT INTO duty_roster_rows (roster_id, staff_id, label, display_order) VALUES (?, ?, ?, ?)');
  const insCell = db.prepare('INSERT OR IGNORE INTO duty_roster_cells (roster_id, row_id, day, shift_code, note) VALUES (?, ?, ?, ?, ?)');
  for (const row of db.prepare('SELECT * FROM duty_roster_rows WHERE roster_id = ? ORDER BY display_order, id').all(source.id) as any[]) {
    // A member of staff who has since left is not carried into the new month.
    if (row.staff_id) {
      const active = db.prepare('SELECT is_active FROM staff WHERE id = ?').get(row.staff_id) as any;
      if (active && !active.is_active) continue;
    }
    const newRowId = Number(insRow.run(newId, row.staff_id, row.label, row.display_order).lastInsertRowid);
    for (const cell of db.prepare('SELECT * FROM duty_roster_cells WHERE row_id = ? AND day <= ?').all(row.id, days) as any[]) {
      insCell.run(newId, newRowId, cell.day, cell.shift_code, cell.note);
    }
  }
  recordCarryForward(db, 'duty_roster', month, 0, source.id, newId, 'not_prepared', note);
  result.created.push({ kind: 'duty_roster', sectionId: null, sectionName: null, fromId: source.id, newId, reason: 'not_prepared', detail: note });
}

/** Copy last month's unit reassignment memo into `month`. */
function carryReassignment(db: Db, month: string, result: CarryForwardResult) {
  if (activeReassignment(db, month)) return;
  const source = activeReassignment(db, previousMonth(month));
  if (!source) return;

  const createdAt = new Date().toISOString();
  const number = generateRecordNumber(db, 'reassignment_schedules', 'REASSIGN', createdAt);
  const note = `Carried forward automatically from ${source.schedule_number || `schedule ${source.id}`} (${monthLabel(previousMonth(month))}) because no unit reassignment was prepared for ${monthLabel(month)}.`;
  const newId = Number(db.prepare(`INSERT INTO reassignment_schedules
     (schedule_number, month, effective_date, memo_to, memo_from, memo_date, subject, intro_text, nb_notes,
      signatory_staff_id, signatory_name, status, prepared_by_staff_id, notes, created_by, created_at,
      carried_forward_from_id, is_carry_forward, carry_forward_note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', ?, NULL, NULL, ?, ?, 1, ?)`)
    .run(number, month, monthStart(month), source.memo_to, source.memo_from, monthStart(month), source.subject,
      `Please take notice of the re-assignment of staff with effect from ${monthStart(month)} as follows:`,
      source.nb_notes, source.signatory_staff_id, source.signatory_name, source.prepared_by_staff_id,
      createdAt, source.id, note).lastInsertRowid);

  const insRow = db.prepare(`INSERT INTO reassignment_rows
     (schedule_id, unit_label, is_span, section_id, supervisor_staff_id, supervisor_text, deputy_staff_id, deputy_text, members_text, member_ids, span_text, display_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const row of db.prepare('SELECT * FROM reassignment_rows WHERE schedule_id = ? ORDER BY display_order, id').all(source.id) as any[]) {
    insRow.run(newId, row.unit_label, row.is_span, row.section_id, row.supervisor_staff_id, row.supervisor_text,
      row.deputy_staff_id, row.deputy_text, row.members_text, row.member_ids, row.span_text, row.display_order);
  }
  recordCarryForward(db, 'reassignment', month, 0, source.id, newId, 'not_prepared', note);
  result.created.push({ kind: 'reassignment', sectionId: null, sectionName: null, fromId: source.id, newId, reason: 'not_prepared', detail: note });
}

/**
 * Carry a unit's bench schedule forward — the case the laboratory described in
 * the most detail, and the one with the most judgement in it.
 *
 * Staff who were on a bench last month and are still in the unit stay exactly
 * where they were. Staff who have left the unit vacate their benches, and the
 * staff newly assigned to the unit are dropped into those vacancies in turn, so
 * a unit whose membership changed still opens the month with every bench
 * covered rather than with holes where the leavers used to be.
 */
function carryBenchSchedule(db: Db, month: string, sectionId: number, sectionName: string, result: CarryForwardResult) {
  if (activeBenchSchedule(db, month, sectionId)) return;
  const source = activeBenchSchedule(db, previousMonth(month), sectionId);
  if (!source) return;

  const policy = schedulingPolicy(db);
  const days = daysInMonth(month);
  const members = new Set(unitMembers(db, sectionId, month));
  const sourceRows = db.prepare('SELECT * FROM bench_schedule_rows WHERE schedule_id = ? ORDER BY display_order, id').all(source.id) as any[];
  const staffRows = sourceRows.filter(r => r.staff_id);

  const retained = staffRows.filter(r => members.has(Number(r.staff_id)));
  const departed = staffRows.filter(r => !members.has(Number(r.staff_id)));
  const previouslyPlaced = new Set(staffRows.map(r => Number(r.staff_id)));
  const arrivals = [...members].filter(id => !previouslyPlaced.has(id));

  const reason: CarryForwardReason = (departed.length || arrivals.length) ? 'partial_bench' : 'not_prepared';
  const detail = reason === 'partial_bench'
    ? `Carried forward from ${monthLabel(previousMonth(month))}. ${retained.length} staff kept their bench; ${departed.length} left the unit and ${arrivals.length} newly assigned staff were placed into the benches they vacated.`
    : `Carried forward automatically from ${monthLabel(previousMonth(month))} because no bench schedule was prepared for ${monthLabel(month)}.`;

  const createdAt = new Date().toISOString();
  const number = generateRecordNumber(db, 'bench_schedules', 'BENCH', createdAt);
  const newId = Number(db.prepare(`INSERT INTO bench_schedules
     (schedule_number, section_id, month, title, status, prepared_by_staff_id, notes, created_by, created_at,
      carried_forward_from_id, is_carry_forward, carry_forward_note)
     VALUES (?, ?, ?, ?, 'published', ?, NULL, NULL, ?, ?, 1, ?)`)
    .run(number, sectionId, month, source.title, source.prepared_by_staff_id, createdAt, source.id, detail).lastInsertRowid);

  const insRow = db.prepare('INSERT INTO bench_schedule_rows (schedule_id, staff_id, label, display_order) VALUES (?, ?, ?, ?)');
  const insCell = db.prepare('INSERT OR IGNORE INTO bench_schedule_cells (schedule_id, row_id, day, value, note) VALUES (?, ?, ?, ?, ?)');
  const cellsOf = (rowId: number) => db.prepare('SELECT * FROM bench_schedule_cells WHERE row_id = ? AND day <= ?').all(rowId, days) as any[];

  let order = 1;
  // 1. Everyone who is staying keeps their bench, day for day.
  for (const row of retained) {
    const newRowId = Number(insRow.run(newId, row.staff_id, row.label, order++).lastInsertRowid);
    for (const cell of cellsOf(row.id)) insCell.run(newId, newRowId, cell.day, cell.value, cell.note);
  }
  // 2. Free-text label rows (bench headings, spacers) come across unchanged.
  for (const row of sourceRows.filter(r => !r.staff_id)) {
    insRow.run(newId, null, row.label, order++);
  }
  // 3. New arrivals take the vacated benches, in turn. A unit that gained more
  //    people than it lost gets blank rows for the surplus — a gap to fill by
  //    hand is honest; inventing a bench for somebody is not.
  const inheritGaps = policy.bench_inherit_gaps !== 0;
  arrivals.forEach((staffId, index) => {
    const newRowId = Number(insRow.run(newId, staffId, null, order++).lastInsertRowid);
    const vacancy = inheritGaps ? departed[index] : undefined;
    if (!vacancy) return;
    for (const cell of cellsOf(vacancy.id)) insCell.run(newId, newRowId, cell.day, cell.value, cell.note);
  });

  recordCarryForward(db, 'bench_schedule', month, sectionId, source.id, newId, reason, detail);
  result.created.push({ kind: 'bench_schedule', sectionId, sectionName, fromId: source.id, newId, reason, detail });
}

/**
 * Make sure a month has schedules to run on. Safe to call as often as you like:
 * it only ever creates what is genuinely absent, and never touches a schedule
 * somebody prepared.
 */
export function ensureMonthSchedules(db: Db, month: string, opts: { force?: boolean } = {}): CarryForwardResult {
  const policy = schedulingPolicy(db);
  const result: CarryForwardResult = { month, created: [], skipped: 0 };
  if (!opts.force && policy.auto_carry_forward === 0) { result.skipped = 1; return result; }

  const run = db.transaction(() => {
    carryDutyRoster(db, month, result);
    carryReassignment(db, month, result);
    for (const section of db.prepare('SELECT id, name FROM sections WHERE is_active = 1').all() as any[]) {
      const benchCount = (db.prepare('SELECT COUNT(*) n FROM section_benches WHERE section_id = ? AND is_active = 1').get(section.id) as any).n;
      if (!benchCount) continue;
      carryBenchSchedule(db, month, Number(section.id), section.name, result);
    }
  });
  run();
  return result;
}

/**
 * The scheduler's daily job: make sure the month that is running has its
 * schedules. Deliberately does NOT pre-empt next month — carrying forward
 * before the deadline has passed would rob the managers of the chance to
 * prepare their own, which is the behaviour the reminders exist to encourage.
 */
export function ensureCurrentMonthSchedules(db: Db, today = todayIso()): CarryForwardResult {
  return ensureMonthSchedules(db, monthOf(today));
}

/** Who a schedule reminder should go to, by position-title keyword. */
export function scheduleOwnerStaffIds(db: Db, kind: ScheduleKind, sectionId: number | null, month: string): number[] {
  const out = new Set<number>();
  if (kind === 'bench_schedule' && sectionId) {
    const head = unitHeadOf(db, sectionId, month);
    if (head) out.add(head);
  }
  const keywords = SCHEDULE_OWNER_KEYWORDS[kind];
  const like = keywords.map(() => 'LOWER(p.title) LIKE ?').join(' OR ');
  try {
    const rows = db.prepare(`SELECT DISTINCT spa.staff_id AS id FROM staff_position_assignments spa
       JOIN positions p ON p.id = spa.position_id JOIN staff s ON s.id = spa.staff_id
       WHERE spa.is_active = 1 AND s.is_active = 1 AND (${like})`).all(...keywords.map(k => `%${k}%`)) as any[];
    for (const r of rows) out.add(Number(r.id));
  } catch { /* no organogram yet */ }
  // A bench schedule reminder that found no unit head still has to reach
  // somebody, so it falls back to the managers who can appoint one.
  if (out.size === 0 && kind === 'bench_schedule') {
    for (const id of scheduleOwnerStaffIds(db, 'duty_roster', null, month)) out.add(id);
  }
  // Last resort: a laboratory that has not filled in its organogram has no
  // position titles to match, and a roster deadline nobody is told about is the
  // same as no deadline. Fall back to the managerial and administrator USER
  // roles, which are always seeded, so the reminder reaches an accountable
  // person rather than being dropped.
  if (out.size === 0) {
    try {
      const rows = db.prepare(`SELECT DISTINCT u.staff_id AS id FROM users u JOIN roles r ON r.id = u.role_id
         JOIN staff s ON s.id = u.staff_id
         WHERE u.is_active = 1 AND s.is_active = 1 AND u.staff_id IS NOT NULL
           AND (LOWER(r.name) LIKE '%manager%' OR LOWER(r.name) LIKE '%head%' OR r.is_administrator = 1)`).all() as any[];
      for (const r of rows) out.add(Number(r.id));
    } catch { /* pre-migration database */ }
  }
  return [...out];
}

/**
 * Remind the people who owe a schedule that it is coming due — and tell them
 * again, once, when the deadline passes.
 *
 * Deduplicated on the obligation itself rather than on the day, so a manager
 * with three weeks of lead time gets one reminder as the window opens and one
 * when it closes, not twenty-one identical alerts they learn to swipe away.
 */
export function dispatchScheduleReminders(db: Db, today = todayIso()): { reminders: number } {
  const obligations = currentObligations(db, today).filter(o => o.status === 'due_soon' || o.status === 'overdue' || o.status === 'carried_forward');
  let reminders = 0;

  for (const obligation of obligations) {
    const owners = scheduleOwnerStaffIds(db, obligation.kind, obligation.sectionId, obligation.month);
    if (!owners.length) continue;
    // One alert per obligation per phase. The phase is part of the key so the
    // "now it is late" reminder still gets through after the "due soon" one.
    const resolveKey = `schedule:${obligation.kind}:${obligation.month}:${obligation.sectionId ?? 0}:${obligation.status}`;
    const existing = db.prepare("SELECT id FROM notifications WHERE auto_resolve_key = ? AND status NOT IN ('resolved','dismissed')").get(resolveKey);
    if (existing) continue;

    const userIds = usersForStaff(db, owners);
    const severity = obligation.status === 'overdue' ? 'high' : obligation.status === 'carried_forward' ? 'medium' : 'medium';
    for (const staffId of owners) {
      const userId = userIds.get(staffId) ?? null;
      const number = generateRecordNumber(db, 'notifications', 'NOTIF', new Date().toISOString());
      db.prepare(`INSERT INTO notifications
         (notification_number, user_id, module_key, title, message, status, severity, notification_type, due_date,
          record_type, record_id, assigned_to_staff_id, assigned_to_user_id, action_url, action_label, auto_resolve_key)
         VALUES (?, ?, 'personnel', ?, ?, 'unread', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(number, userId, `${obligation.kindLabel} — ${obligation.monthLabel}${obligation.sectionName ? ` (${obligation.sectionName})` : ''}`,
          obligation.message, severity,
          obligation.status === 'overdue' ? 'overdue' : 'due_soon', obligation.dueDate,
          obligation.kind === 'duty_roster' ? 'duty_rosters' : obligation.kind === 'reassignment' ? 'reassignment_schedules' : 'bench_schedules',
          String(obligation.scheduleId ?? `${obligation.month}:${obligation.sectionId ?? 0}`),
          staffId, userId, obligation.actionUrl, 'Prepare it', resolveKey);
      if (userId) {
        queuePush({
          userId, title: `${obligation.kindLabel} due — ${obligation.monthLabel}`, body: obligation.message,
          priority: obligation.status === 'overdue' ? 'high' : 'normal', moduleKey: 'personnel', createInApp: false,
          payload: { kind: 'schedule_obligation', actionUrl: obligation.actionUrl, soundEvent: 'schedule', month: obligation.month, scheduleKind: obligation.kind },
        });
      }
      reminders++;
    }
  }
  return { reminders };
}

/** The daily governance tick: carry forward what is missing, then remind. */
export function runScheduleTick(db: Db, today = todayIso()): { carried: CarryForwardResult; reminders: number } {
  const carried = ensureCurrentMonthSchedules(db, today);
  const { reminders } = dispatchScheduleReminders(db, today);
  return { carried, reminders };
}

export { SCHEDULE_KIND_LABELS };
