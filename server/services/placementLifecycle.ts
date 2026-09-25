/**
 * Placements end, and the system ends them.
 *
 * A student, an intern, a national service person, a locum or a contractor is
 * in the laboratory for a stated period. The register had no way to say so, so
 * they were enrolled like permanent staff and stayed that way: counted in the
 * head count, offered on rosters, holding a working login, months after they
 * had gone. Closing the record was somebody's job to remember, and nobody
 * remembers.
 *
 * The placement now carries its own end date, and this module is what happens
 * when it passes. Two steps, in this order:
 *
 *   1. On the day it ends, the laboratory is TOLD — the person themselves, the
 *      supervisor of their unit, and the laboratory manager. Nothing is taken
 *      away. A placement is extended at the last minute more often than
 *      anybody plans for, and the notice is what makes extending it possible.
 *
 *   2. A week later, if nobody extended it, access is WITHDRAWN: the login is
 *      disabled and every open session ended, the person leaves the active
 *      register with the reason on it, and their position assignments and
 *      technical authorisations are closed.
 *
 * Withdrawn is not deleted. The whole record stays — training, competence,
 * the work they signed for, every entry they made — under Former staff, where
 * it is read and printed like any other. What stops is being counted: the
 * active register, the rosters, the head count and the activity boards all ask
 * for `is_active = 1`, and they no longer answer with somebody who has left.
 *
 * Extending a placement resets all of it. A new end date clears the notice and
 * the closure, so the warning goes out again against the new date; extending
 * one that has already been closed is a reinstatement, which the register does
 * through its own screen.
 */
import { PLACEMENT_GRACE_DAYS, PLACEMENT_EXIT_REASON, TEMPORARY_CATEGORIES } from '../../shared/constants/personnel.js';

type DB = any;

const today = () => new Date().toISOString().slice(0, 10);
const plusDays = (iso: string, days: number) =>
  new Date(new Date(`${iso}T00:00:00Z`).getTime() + days * 864e5).toISOString().slice(0, 10);

/** Everyone on a placement that has run out, whether or not it has been dealt with. */
function expiredPlacements(db: DB, onDate: string): any[] {
  const marks = TEMPORARY_CATEGORIES.map(() => '?').join(', ');
  return db.prepare(`SELECT s.id, s.full_name, s.employee_no, s.section_id, s.personnel_category,
      s.placement_end_date, s.placement_notice_at, s.placement_closed_at, sec.name AS section_name
    FROM staff s LEFT JOIN sections sec ON sec.id = s.section_id
    WHERE s.is_active = 1
      AND s.placement_end_date IS NOT NULL
      AND date(s.placement_end_date) <= date(?)
      AND UPPER(COALESCE(s.personnel_category, '')) IN (${marks})`)
    .all(onDate, ...TEMPORARY_CATEGORIES) as any[];
}

/**
 * Who should be told that a placement has run out.
 *
 * The person, so they are not locked out without warning; whoever runs their
 * unit, because extending it or letting it end is their call; and the
 * laboratory manager, who signs either way. The unit's supervisor is the
 * acting one when somebody is standing in, for the same reason every other
 * notice goes to them: they are the person doing the job this week.
 */
function recipients(db: DB, staff: any): number[] {
  const people = new Set<number>();
  if (staff.id) people.add(Number(staff.id));

  if (staff.section_id) {
    const unit = db.prepare('SELECT head_staff_id FROM sections WHERE id = ?').get(staff.section_id) as
      { head_staff_id: number | null } | undefined;
    if (unit?.head_staff_id) people.add(Number(unit.head_staff_id));
    const acting = db.prepare(`SELECT acting_staff_id FROM acting_unit_heads
        WHERE section_id = ? AND status = 'active' AND start_date <= ? AND end_date >= ?
        ORDER BY start_date DESC, id DESC LIMIT 1`).get(staff.section_id, today(), today()) as
      { acting_staff_id: number } | undefined;
    if (acting?.acting_staff_id) people.add(Number(acting.acting_staff_id));
  }

  // The laboratory manager, by the profile their account resolves to rather
  // than by a title somebody typed, so a renamed post still reaches them.
  for (const row of db.prepare(`SELECT u.staff_id FROM users u JOIN roles r ON r.id = u.role_id
      WHERE u.is_active = 1 AND u.staff_id IS NOT NULL
        AND LOWER(r.name) IN ('laboratory manager', 'lab manager')`).all() as Array<{ staff_id: number }>) {
    people.add(Number(row.staff_id));
  }
  return [...people];
}

/** One notice, once. A second tick on the same day must not repeat it. */
function notify(db: DB, staffId: number, notice: {
  kind: string; subjectId: number; title: string; message: string; severity: string; dueDate: string | null;
}): boolean {
  const recordType = `staff:${notice.kind}`;
  const recordId = String(notice.subjectId);
  const already = db.prepare('SELECT id FROM notifications WHERE assigned_to_staff_id = ? AND record_type = ? AND record_id = ?')
    .get(staffId, recordType, recordId);
  if (already) return false;
  const account = db.prepare('SELECT id FROM users WHERE staff_id = ? AND is_active = 1 ORDER BY id LIMIT 1')
    .get(staffId) as { id: number } | undefined;
  db.prepare(`INSERT INTO notifications
      (user_id, module_key, title, message, status, severity, notification_type,
       record_type, record_id, assigned_to_staff_id, assigned_to_user_id, action_url, action_label, due_date, created_by)
      VALUES (?, 'personnel.register', ?, ?, 'unread', ?, 'due_soon', ?, ?, ?, ?, ?, ?, ?, NULL)`)
    .run(account?.id ?? null, notice.title, notice.message, notice.severity,
      recordType, recordId, staffId, account?.id ?? null,
      '/personnel', 'Open the register', notice.dueDate);
  return true;
}

/**
 * Close a placement: withdraw the access, keep the record.
 *
 * The same steps the register takes when somebody records an exit by hand —
 * the login off and its sessions ended, the positions and technical
 * authorisations closed, the reason and the date on the record — so a
 * placement that ends on its own and one closed by the personnel office leave
 * the register in exactly the same state.
 */
export function closePlacement(db: DB, staffId: number, opts: { reason?: string; date?: string; notes?: string } = {}): boolean {
  const staff = db.prepare('SELECT id, full_name, is_active FROM staff WHERE id = ?').get(staffId) as
    { id: number; full_name: string; is_active: number } | undefined;
  if (!staff || staff.is_active !== 1) return false;

  const account = db.prepare('SELECT id, role_id FROM users WHERE staff_id = ?').get(staffId) as
    { id: number; role_id: number } | undefined;
  // Never leave the laboratory without an administrator. A placement should
  // never hold that account, but if one does, the record is left alone and the
  // laboratory keeps its way in.
  if (account) {
    const adminRole = db.prepare("SELECT id FROM roles WHERE name = 'System Administrator'").get() as { id: number } | undefined;
    if (adminRole && account.role_id === adminRole.id) {
      const others = (db.prepare('SELECT COUNT(*) c FROM users WHERE role_id = ? AND is_active = 1 AND id != ?')
        .get(adminRole.id, account.id) as { c: number }).c;
      if (others === 0) return false;
    }
  }

  const date = opts.date ?? today();
  const reason = opts.reason ?? PLACEMENT_EXIT_REASON;
  db.transaction(() => {
    db.prepare(`UPDATE staff SET is_active = 0, exit_reason = ?, exit_date = ?, exit_notes = ?,
      exit_recorded_at = CURRENT_TIMESTAMP, placement_closed_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(reason, date, opts.notes ?? null, staffId);
    db.prepare("UPDATE staff_position_assignments SET is_active = 0, ends_at = CURRENT_TIMESTAMP WHERE staff_id = ? AND is_active = 1").run(staffId);
    db.prepare('UPDATE technical_authorizations SET is_active = 0 WHERE staff_id = ? AND is_active = 1').run(staffId);
    // An appointment to act as a unit supervisor cannot outlive the placement
    // that carried it.
    db.prepare("UPDATE acting_unit_heads SET status = 'ended' WHERE acting_staff_id = ? AND status = 'active'").run(staffId);
    if (account) {
      db.prepare('UPDATE users SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(account.id);
      db.prepare('UPDATE auth_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = ? AND revoked_at IS NULL').run(account.id);
    }
    db.prepare(`INSERT INTO audit_logs (actor_user_id, action, entity, entity_id, old_value, new_value)
      VALUES (NULL, 'record_exit', 'staff', ?, ?, ?)`)
      .run(String(staffId), JSON.stringify({ isActive: 1 }),
        JSON.stringify({ isActive: 0, fullName: staff.full_name, exitReason: reason, exitDate: date, closedBy: 'placement end date' }));
  })();
  return true;
}

/**
 * Has this person's placement run out, grace period and all?
 *
 * Asked at sign-in, so somebody whose week expired an hour ago is not let
 * through because the daily pass has not come round yet. It closes the record
 * on the way — the answer and the consequence are the same event.
 */
export function placementIsSpent(db: DB, staffId: number): boolean {
  const row = db.prepare(`SELECT id, placement_end_date, personnel_category, is_active
    FROM staff WHERE id = ?`).get(staffId) as
    { id: number; placement_end_date: string | null; personnel_category: string | null; is_active: number } | undefined;
  if (!row || row.is_active !== 1 || !row.placement_end_date) return false;
  if (!TEMPORARY_CATEGORIES.includes(String(row.personnel_category ?? '').toUpperCase() as never)) return false;
  if (plusDays(String(row.placement_end_date).slice(0, 10), PLACEMENT_GRACE_DAYS) > today()) return false;
  closePlacement(db, staffId);
  return true;
}

/**
 * The daily pass: warn the ones that ran out today, close the ones whose week
 * is up. Idempotent — a restart mid-morning costs nothing, and a host that was
 * switched off for a fortnight catches up on the first tick.
 */
export function runPlacementTick(db: DB): { warned: number; closed: number } {
  const onDate = today();
  let warned = 0;
  let closed = 0;

  for (const person of expiredPlacements(db, onDate)) {
    const ends = String(person.placement_end_date).slice(0, 10);
    const withdrawsOn = plusDays(ends, PLACEMENT_GRACE_DAYS);
    const who = `${person.full_name}${person.employee_no ? ` (${person.employee_no})` : ''}`;
    const role = String(person.personnel_category ?? 'placement').toLowerCase();

    if (!person.placement_notice_at) {
      for (const staffId of recipients(db, person)) {
        if (notify(db, staffId, {
          kind: `placement_ending:${ends}`,
          subjectId: Number(person.id),
          title: `Placement ended: ${person.full_name}`,
          message: `${who} was enrolled as ${role}${person.section_name ? ` in ${person.section_name}` : ''} `
            + `until ${ends}. Access is withdrawn on ${withdrawsOn} unless the placement is extended — `
            + `set a new end date on the register to extend it.`,
          severity: 'high',
          dueDate: withdrawsOn,
        })) warned++;
      }
      db.prepare('UPDATE staff SET placement_notice_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(onDate, person.id);
    }

    if (withdrawsOn <= onDate && closePlacement(db, Number(person.id), { date: onDate })) closed++;
  }

  return { warned, closed };
}
