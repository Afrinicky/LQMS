/**
 * Who is on duty, in which unit, on which bench — for any given day.
 *
 * Three documents decide that, and they are layered:
 *
 *   duty roster        → is this person working today, and on what shift
 *   unit reassignment  → which unit are they in this month
 *   bench schedule     → which bench inside that unit, today
 *
 * Everything that routes work to a person — the daily activity to-dos, the
 * reminders, the escalation to a unit head — reads the laboratory's own
 * schedules through this one module, so a mid-month change to any of the three
 * is reflected everywhere the next time anything is resolved. There is no
 * second copy of "who is where" to fall out of step.
 *
 * The fallbacks matter as much as the happy path. A laboratory that has not yet
 * built a roster must still get its environmental charting done, so a missing
 * document degrades to the widest sensible answer (everyone active in the unit)
 * rather than to nobody, and the answer says which document it came from so the
 * staff member can see why the work is theirs.
 */
import type { AssignmentSource } from '../../shared/constants/activities.js';

type Db = any;

export type DutyEntry = {
  staffId: number;
  staffName: string | null;
  shiftCode: string | null;
  shiftLabel: string | null;
  /** shift | off | leave — only 'shift' counts as being at work. */
  shiftCategory: string | null;
  source: AssignmentSource;
};

export type UnitAssignment = {
  sectionId: number;
  sectionName: string | null;
  /** supervisor | deputy | member */
  role: string;
  source: 'reassignment' | 'staff_register';
};

/* ============================================================================
   Small date helpers. Everything here works in the host's local calendar,
   because a duty roster is a wall chart in a specific building.
   ========================================================================= */
export function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function monthOf(dateIso: string): string {
  return String(dateIso).slice(0, 7);
}

export function dayOfMonth(dateIso: string): number {
  return Number(String(dateIso).slice(8, 10));
}

export function addDays(dateIso: string, days: number): string {
  const d = new Date(`${dateIso}T00:00:00`);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function daysInMonth(month: string): number {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}

export function monthStart(month: string): string { return `${month}-01`; }
export function monthEnd(month: string): string { return `${month}-${String(daysInMonth(month)).padStart(2, '0')}`; }

export function previousMonth(month: string): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function nextMonth(month: string): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m)) return month;
  return `${MONTH_NAMES[m - 1]} ${y}`;
}

/** Whole days from `fromIso` to `toIso`; negative when `toIso` is in the past. */
export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso}T00:00:00`) - Date.parse(`${fromIso}T00:00:00`)) / 86400000);
}

/* ============================================================================
   The duty roster
   ========================================================================= */

/**
 * The roster that governs a month. A laboratory often has a draft alongside the
 * posted one, so an approved roster beats a published one, which beats a draft;
 * within the same standing, the most recently created wins.
 */
export function activeDutyRoster(db: Db, month: string): any | null {
  return db.prepare(`SELECT * FROM duty_rosters WHERE month = ?
     ORDER BY CASE status WHEN 'approved' THEN 0 WHEN 'published' THEN 1 ELSE 2 END, id DESC LIMIT 1`).get(month) ?? null;
}

/** The shift-type catalogue as a lookup, so cells can be read as work / off / leave. */
export function shiftTypeMap(db: Db): Map<string, { code: string; label: string; category: string }> {
  const map = new Map<string, { code: string; label: string; category: string }>();
  for (const s of db.prepare('SELECT code, label, category FROM roster_shift_types').all() as any[]) {
    map.set(String(s.code).toUpperCase(), { code: s.code, label: s.label, category: s.category || 'shift' });
  }
  return map;
}

/**
 * Everyone the duty roster puts at work on `dateIso`.
 *
 * Returns null — distinct from an empty array — when no roster exists for the
 * month at all. The caller then knows the silence is a missing document rather
 * than a day nobody was rostered, and can fall back to the unit's own members.
 */
export function onDutyOn(db: Db, dateIso: string): DutyEntry[] | null {
  const roster = activeDutyRoster(db, monthOf(dateIso));
  if (!roster) return null;
  const day = dayOfMonth(dateIso);
  const shifts = shiftTypeMap(db);
  const rows = db.prepare(`SELECT c.shift_code, r.staff_id, s.full_name
     FROM duty_roster_cells c
     JOIN duty_roster_rows r ON r.id = c.row_id
     LEFT JOIN staff s ON s.id = r.staff_id
     WHERE c.roster_id = ? AND c.day = ? AND r.staff_id IS NOT NULL`).all(roster.id, day) as any[];

  const out: DutyEntry[] = [];
  for (const row of rows) {
    const code = row.shift_code ? String(row.shift_code).toUpperCase() : null;
    if (!code) continue;
    const type = shifts.get(code);
    // A cell painted with a leave or off code is a record that the person is
    // NOT at work. Treating it as duty is how staff end up with a to-do list on
    // their annual leave, so only 'shift' rows come back.
    if (type && type.category !== 'shift') continue;
    out.push({
      staffId: Number(row.staff_id),
      staffName: row.full_name ?? null,
      shiftCode: code,
      shiftLabel: type?.label ?? code,
      shiftCategory: type?.category ?? 'shift',
      source: 'duty_roster',
    });
  }
  return out;
}

/** The duty entry for one person on one day, or null when they are not rostered on. */
export function dutyEntryFor(db: Db, staffId: number, dateIso: string): DutyEntry | null {
  const entries = onDutyOn(db, dateIso);
  if (entries === null) return null;
  return entries.find(e => e.staffId === staffId) ?? null;
}

/* ============================================================================
   Unit reassignment — which unit each person belongs to this month
   ========================================================================= */
export function activeReassignment(db: Db, month: string): any | null {
  return db.prepare(`SELECT * FROM reassignment_schedules WHERE month = ?
     ORDER BY CASE status WHEN 'approved' THEN 0 WHEN 'published' THEN 1 ELSE 2 END, id DESC LIMIT 1`).get(month) ?? null;
}

/**
 * Every staff member's unit for a month, read from the reassignment schedule
 * where one exists and from the staff register where it does not. The register
 * is the fallback rather than the source because a reassignment memo is how a
 * laboratory actually moves people between units month to month.
 */
export function unitAssignments(db: Db, month: string): Map<number, UnitAssignment> {
  const out = new Map<number, UnitAssignment>();
  const sectionNames = new Map<number, string>();
  for (const s of db.prepare('SELECT id, name FROM sections').all() as any[]) sectionNames.set(Number(s.id), s.name);

  const schedule = activeReassignment(db, month);
  if (schedule) {
    const rows = db.prepare('SELECT * FROM reassignment_rows WHERE schedule_id = ? ORDER BY display_order, id').all(schedule.id) as any[];
    for (const row of rows) {
      const sectionId = row.section_id ? Number(row.section_id) : null;
      if (!sectionId) continue;   // a free-text row (QMS desk, manager) names no unit
      const put = (staffId: unknown, role: string) => {
        const id = Number(staffId);
        if (!Number.isFinite(id) || id <= 0) return;
        // First row wins: a person named as a unit's supervisor is not demoted
        // to "member" by appearing again further down the memo.
        if (out.has(id)) return;
        out.set(id, { sectionId, sectionName: sectionNames.get(sectionId) ?? null, role, source: 'reassignment' });
      };
      put(row.supervisor_staff_id, 'supervisor');
      put(row.deputy_staff_id, 'deputy');
      try {
        for (const m of JSON.parse(row.member_ids || '[]')) put(m, 'member');
      } catch { /* a malformed member list must not take the whole month down */ }
    }
  }

  for (const s of db.prepare('SELECT id, section_id FROM staff WHERE is_active = 1').all() as any[]) {
    const id = Number(s.id);
    if (out.has(id) || !s.section_id) continue;
    const sectionId = Number(s.section_id);
    out.set(id, { sectionId, sectionName: sectionNames.get(sectionId) ?? null, role: 'member', source: 'staff_register' });
  }
  return out;
}

/** The unit one person belongs to in a month. */
export function unitOf(db: Db, staffId: number, month: string): UnitAssignment | null {
  return unitAssignments(db, month).get(staffId) ?? null;
}

/** Everyone assigned to a unit this month, whether or not they are on duty today. */
export function unitMembers(db: Db, sectionId: number, month: string): number[] {
  const out: number[] = [];
  for (const [staffId, assignment] of unitAssignments(db, month)) {
    if (assignment.sectionId === sectionId) out.push(staffId);
  }
  return out;
}

/* ============================================================================
   Bench schedules — which bench inside the unit
   ========================================================================= */
export function activeBenchSchedule(db: Db, month: string, sectionId: number): any | null {
  return db.prepare(`SELECT * FROM bench_schedules WHERE month = ? AND section_id = ?
     ORDER BY CASE status WHEN 'approved' THEN 0 WHEN 'published' THEN 1 ELSE 2 END, id DESC LIMIT 1`).get(month, sectionId) ?? null;
}

/** The bench a person is on for a given day, or null when no bench schedule says. */
export function benchFor(db: Db, staffId: number, sectionId: number, dateIso: string): string | null {
  const schedule = activeBenchSchedule(db, monthOf(dateIso), sectionId);
  if (!schedule) return null;
  const row = db.prepare(`SELECT c.value FROM bench_schedule_cells c
     JOIN bench_schedule_rows r ON r.id = c.row_id
     WHERE c.schedule_id = ? AND r.staff_id = ? AND c.day = ?`).get(schedule.id, staffId, dayOfMonth(dateIso)) as any;
  const value = row?.value ? String(row.value).trim() : '';
  return value || null;
}

/** Everyone the bench schedule puts on a named bench on a day. */
export function staffOnBench(db: Db, sectionId: number, benchNames: string[], dateIso: string): Array<{ staffId: number; benchName: string }> {
  const schedule = activeBenchSchedule(db, monthOf(dateIso), sectionId);
  if (!schedule) return [];
  const wanted = new Set(benchNames.map(b => String(b).trim().toLowerCase()).filter(Boolean));
  const rows = db.prepare(`SELECT r.staff_id, c.value FROM bench_schedule_cells c
     JOIN bench_schedule_rows r ON r.id = c.row_id
     WHERE c.schedule_id = ? AND c.day = ? AND r.staff_id IS NOT NULL`).all(schedule.id, dayOfMonth(dateIso)) as any[];
  const out: Array<{ staffId: number; benchName: string }> = [];
  for (const row of rows) {
    const value = row.value ? String(row.value).trim() : '';
    if (!value) continue;
    if (wanted.size && !wanted.has(value.toLowerCase())) continue;
    out.push({ staffId: Number(row.staff_id), benchName: value });
  }
  return out;
}

/* ============================================================================
   The composite answer used everywhere else
   ========================================================================= */
export type DutyContext = {
  date: string;
  month: string;
  shiftCode: string | null;
  shiftLabel: string | null;
  onDuty: boolean;
  sectionId: number | null;
  sectionName: string | null;
  benchName: string | null;
  assignmentSource: string | null;
  rosterStatus: string | null;
  rosterCarriedForward: boolean;
  benchCarriedForward: boolean;
};

/** Where one member of staff stands today: on duty or not, in which unit, on which bench. */
export function dutyContextFor(db: Db, staffId: number, dateIso: string): DutyContext {
  const month = monthOf(dateIso);
  const roster = activeDutyRoster(db, month);
  const entry = roster ? dutyEntryFor(db, staffId, dateIso) : null;
  const unit = unitOf(db, staffId, month);
  const bench = unit ? benchFor(db, staffId, unit.sectionId, dateIso) : null;
  const benchSchedule = unit ? activeBenchSchedule(db, month, unit.sectionId) : null;

  return {
    date: dateIso,
    month,
    shiftCode: entry?.shiftCode ?? null,
    shiftLabel: entry?.shiftLabel ?? null,
    // With no roster at all, everyone assigned to a unit counts as on duty:
    // the laboratory is still open and the work still has to be done.
    onDuty: roster ? Boolean(entry) : Boolean(unit),
    sectionId: unit?.sectionId ?? null,
    sectionName: unit?.sectionName ?? null,
    benchName: bench,
    assignmentSource: entry ? 'duty_roster' : (unit ? (roster ? 'unit_member' : 'section_fallback') : null),
    rosterStatus: roster?.status ?? null,
    rosterCarriedForward: Boolean(roster?.is_carry_forward),
    benchCarriedForward: Boolean(benchSchedule?.is_carry_forward),
  };
}

/**
 * Everyone on duty in a unit on a day, with the reason each of them is there.
 *
 * This is the routing rule the whole reminder system turns on: the work goes to
 * the people the roster placed in that unit, not to the unit's entire staff
 * list and not to whoever happens to be logged in.
 */
export function onDutyInSection(db: Db, sectionId: number, dateIso: string, shiftCodes: string[] = []): DutyEntry[] {
  const month = monthOf(dateIso);
  const assignments = unitAssignments(db, month);
  const rostered = onDutyOn(db, dateIso);
  const wantedShifts = new Set(shiftCodes.map(c => String(c).toUpperCase()).filter(Boolean));

  if (rostered === null) {
    // No roster for the month: fall back to the unit's members, marked as such
    // so the staff member can see the work reached them for want of a roster.
    const names = new Map<number, string>();
    for (const s of db.prepare('SELECT id, full_name FROM staff WHERE is_active = 1').all() as any[]) names.set(Number(s.id), s.full_name);
    return [...assignments.entries()]
      .filter(([staffId, a]) => a.sectionId === sectionId && names.has(staffId))
      .map(([staffId]) => ({
        staffId, staffName: names.get(staffId) ?? null,
        shiftCode: null, shiftLabel: null, shiftCategory: null,
        source: 'section_fallback' as AssignmentSource,
      }));
  }

  return rostered.filter(entry => {
    const unit = assignments.get(entry.staffId);
    if (!unit || unit.sectionId !== sectionId) return false;
    if (wantedShifts.size && (!entry.shiftCode || !wantedShifts.has(entry.shiftCode))) return false;
    return true;
  });
}

/** The unit head: the section's own head, falling back to this month's supervisor. */
export function unitHeadOf(db: Db, sectionId: number, month: string): number | null {
  const section = db.prepare('SELECT head_staff_id FROM sections WHERE id = ?').get(sectionId) as any;
  if (section?.head_staff_id) return Number(section.head_staff_id);
  const schedule = activeReassignment(db, month);
  if (schedule) {
    const row = db.prepare('SELECT supervisor_staff_id FROM reassignment_rows WHERE schedule_id = ? AND section_id = ? AND supervisor_staff_id IS NOT NULL LIMIT 1')
      .get(schedule.id, sectionId) as any;
    if (row?.supervisor_staff_id) return Number(row.supervisor_staff_id);
  }
  return null;
}

/* ============================================================================
   Leadership — who watches everything
   ----------------------------------------------------------------------------
   The laboratory manager, quality manager and unit heads see the same activity
   feed the bench sees, but as oversight. They are watchers, never owners: the
   to-do stays with the person the roster put on the bench.
   ========================================================================= */
export function leadershipStaffIds(db: Db, sectionId: number | null, month: string): number[] {
  const out = new Set<number>();
  const byPosition = (keywords: string[]) => {
    const like = keywords.map(() => 'LOWER(p.title) LIKE ?').join(' OR ');
    try {
      const rows = db.prepare(`SELECT DISTINCT spa.staff_id AS id FROM staff_position_assignments spa
         JOIN positions p ON p.id = spa.position_id JOIN staff s ON s.id = spa.staff_id
         WHERE spa.is_active = 1 AND s.is_active = 1 AND (${like})`).all(...keywords.map(k => `%${k}%`)) as any[];
      for (const r of rows) out.add(Number(r.id));
    } catch { /* an organogram without positions is not an error here */ }
  };
  byPosition(['laboratory manager', 'lab manager', 'quality manager']);
  // The unit's own head, and the unit heads generally, so a unit's work is
  // never invisible to the person accountable for it.
  if (sectionId) {
    const head = unitHeadOf(db, sectionId, month);
    if (head) out.add(head);
  }
  return [...out];
}

/** Map staff ids to their (first) active user account, for notification delivery. */
export function usersForStaff(db: Db, staffIds: number[]): Map<number, number> {
  const out = new Map<number, number>();
  if (!staffIds.length) return out;
  const rows = db.prepare(`SELECT id, staff_id FROM users WHERE is_active = 1 AND staff_id IS NOT NULL
     AND staff_id IN (${staffIds.map(() => '?').join(',')}) ORDER BY id`).all(...staffIds) as any[];
  for (const row of rows) {
    if (!out.has(Number(row.staff_id))) out.set(Number(row.staff_id), Number(row.id));
  }
  return out;
}
