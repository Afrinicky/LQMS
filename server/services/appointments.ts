/**
 * Who holds which post — written in one place, and read everywhere.
 *
 * THE FAILURE THIS EXISTS TO END. A laboratory appointed a new Microbiology
 * supervisor and the old one stayed: both appeared on the register as
 * "Microbiology Unit Supervisor", and the old one kept the post's access,
 * because the permission resolver reads a person's profile off exactly these
 * assignment rows. The same thing happened the other way round when a
 * supervisor was rotated between units — her profile still read Blood Bank
 * while somebody else held Blood Bank too.
 *
 * It happened because an appointment was recorded in two unrelated places and
 * written from five:
 *
 *   `staff_position_assignments`  said who held the post — and appointing a
 *       successor DEMOTED the incumbent to a second, invisible assignment
 *       instead of ending theirs, so the post had two holders;
 *   `sections.head_staff_id`      separately said who ran the unit, and was
 *       edited on a different screen that knew nothing of the post;
 *
 *   written by the organogram, the unit profile, the personnel register, staff
 *   registration and a quick-assignment form, none of which consulted the
 *   others.
 *
 * So there is one way in, and it is this module. Every route that can change
 * an appointment calls it, and it holds the rules that the screens used to
 * each hold differently:
 *
 *   A POST HAS ONE HOLDER. Appointing a successor ENDS the predecessor's
 *   appointment, on the record, with the date it ended.
 *
 *   A UNIT HAS ONE SUPERVISOR. The post that supervises a unit is named on
 *   the post itself rather than guessed from its title, and `head_staff_id`
 *   is maintained from the appointment — so scheduling, duty rosters, alerts,
 *   quality control and the permission resolver all read one answer.
 *
 *   A PERSON MAY HOLD SEVERAL POSTS. The rule is one holder per POST, never
 *   one post per person: a supervisor who is also the safety officer holds
 *   both, and both are visible.
 *
 * Nothing here grants access. It records who holds what; Access Control
 * remains the authority on what that is worth.
 */
import { parseIntNullable } from '../routes/routeHelpers.js';
import { addUnitMembership, isClinicalUnit, removeUnitMembership, setClinicalUnit } from './unitMembership.js';

type DB = any;

export type AppointmentKind = 'holder' | 'deputy';

/**
 * What came of an attempt to change an appointment.
 *
 * One shape for both answers rather than two: this project compiles with
 * `strict` off, where a union discriminated on `ok` does not narrow, and a
 * caller that cannot narrow safely is a caller that forgets to check.
 */
export interface AppointmentOutcome {
  ok: boolean;
  /** Set when it was refused: what to say, and what status to say it with. */
  error?: string;
  status?: number;
  positionId?: number;
  staffId?: number;
  kind?: AppointmentKind;
  /** The person this appointment displaced, where it displaced one. */
  replacedStaffId?: number | null;
  /** The unit whose supervisor changed as a result, where one did. */
  sectionId?: number | null;
  /** What happened, in words, for the screen that asked for it. */
  summary?: string;
}

const ROW_KIND: Record<AppointmentKind, string> = { holder: 'primary', deputy: 'deputy' };

function staffName(db: DB, staffId: number | null): string {
  if (!staffId) return 'nobody';
  const row = db.prepare('SELECT full_name FROM staff WHERE id = ?').get(staffId) as { full_name: string } | undefined;
  return row?.full_name ?? `staff #${staffId}`;
}

/** The post that supervises this unit, where the laboratory has named one. */
export function supervisorPostOf(db: DB, sectionId: number): { id: number; title: string; holderStaffId: number | null } | null {
  const row = db.prepare(`SELECT p.id, p.title,
      (SELECT spa.staff_id FROM staff_position_assignments spa
         WHERE spa.position_id = p.id AND spa.is_active = 1 AND spa.assignment_type = 'primary'
         ORDER BY spa.id DESC LIMIT 1) AS holder
      FROM positions p
      WHERE p.supervises_section_id = ? AND COALESCE(p.is_active, 1) = 1
      ORDER BY p.id LIMIT 1`).get(sectionId) as any;
  return row ? { id: Number(row.id), title: String(row.title), holderStaffId: row.holder ?? null } : null;
}

/**
 * Is this post an OFFICE, or a GRADE?
 *
 * An office is appointed to and held by one person: the laboratory manager,
 * the quality officer, a unit supervisor. A grade is what people are graded
 * into — ten technicians hold "Laboratory Technician", and that is not a
 * conflict, it is a laboratory. The one-holder rule is of offices only, and
 * everything in this module turns on the distinction.
 */
export function isOffice(position: { is_core?: unknown; supervises_section_id?: unknown }): boolean {
  return Number(position?.is_core ?? 0) === 1 || parseIntNullable(position?.supervises_section_id) !== null;
}

/** The current holder of a post. */
export function holderOf(db: DB, positionId: number): number | null {
  const row = db.prepare(`SELECT staff_id FROM staff_position_assignments
      WHERE position_id = ? AND is_active = 1 AND assignment_type = 'primary'
      ORDER BY id DESC LIMIT 1`).get(positionId) as { staff_id: number } | undefined;
  return row?.staff_id ?? null;
}

/**
 * Appoint somebody to a post.
 *
 * The whole change is one transaction: the predecessor's appointment ends, the
 * successor's begins, and the unit the post supervises is handed over with it.
 * Half of that is worse than none — it is precisely the half-finished handover
 * that left two people holding one post.
 */
export function appoint(db: DB, input: {
  positionId: unknown;
  staffId: unknown;
  kind?: string | null;
  /** Why the appointment was made, kept on the record. */
  note?: string | null;
}): AppointmentOutcome {
  const positionId = parseIntNullable(input.positionId);
  const staffId = parseIntNullable(input.staffId);
  const kind: AppointmentKind = input.kind === 'deputy' ? 'deputy' : 'holder';

  if (!positionId) return { ok: false, status: 400, error: 'Say which post is being filled.' };
  if (!staffId) return { ok: false, status: 400, error: 'Say who is being appointed.' };

  const position = db.prepare('SELECT id, title, supervises_section_id, is_active FROM positions WHERE id = ?')
    .get(positionId) as any;
  if (!position) return { ok: false, status: 404, error: 'That post is not on the register.' };
  if (Number(position.is_active ?? 1) !== 1) {
    return { ok: false, status: 400, error: `${position.title} is not an active post. Reactivate it before appointing anybody to it.` };
  }
  const staff = db.prepare('SELECT id, full_name, is_active, section_id FROM staff WHERE id = ?').get(staffId) as any;
  if (!staff) return { ok: false, status: 404, error: 'That member of staff is not on the register.' };
  if (Number(staff.is_active ?? 1) !== 1) {
    return { ok: false, status: 400, error: `${staff.full_name} is not in service, so they cannot hold a post.` };
  }

  const sectionId = parseIntNullable(position.supervises_section_id);
  const office = isOffice(position);
  const replaced = kind === 'holder' && office
    ? holderOf(db, positionId)
    : kind === 'deputy'
      ? (db.prepare(`SELECT staff_id FROM staff_position_assignments
          WHERE position_id = ? AND is_active = 1 AND assignment_type = 'deputy' ORDER BY id DESC LIMIT 1`)
        .get(positionId) as { staff_id: number } | undefined)?.staff_id ?? null
      : null;

  const already = db.prepare(`SELECT id, assignment_type FROM staff_position_assignments
      WHERE position_id = ? AND staff_id = ? AND is_active = 1`).get(positionId, staffId) as any;
  if (already && already.assignment_type === ROW_KIND[kind]) {
    return { ok: false, status: 409, error: `${staff.full_name} already holds ${position.title}${kind === 'deputy' ? ' as deputy' : ''}.` };
  }

  db.transaction(() => {
    /*
     * The predecessor's appointment ENDS — for an office, and for a deputy.
     *
     * It is not demoted, hidden or left active under another name: that is
     * what put two people in one post. A GRADE displaces nobody: the new
     * holder simply joins everybody else graded into it.
     */
    if (kind === 'deputy' || office) {
      db.prepare(`UPDATE staff_position_assignments SET is_active = 0, ends_at = CURRENT_TIMESTAMP
          WHERE position_id = ? AND is_active = 1 AND assignment_type = ?`).run(positionId, ROW_KIND[kind]);
    }

    // A person already attached to this post in some other capacity takes it
    // up rather than acquiring a second row for the same post.
    const existing = db.prepare(`SELECT id FROM staff_position_assignments
        WHERE position_id = ? AND staff_id = ? AND is_active = 1`).get(positionId, staffId) as any;
    if (existing) {
      db.prepare('UPDATE staff_position_assignments SET assignment_type = ? WHERE id = ?').run(ROW_KIND[kind], existing.id);
    } else {
      db.prepare(`INSERT INTO staff_position_assignments (staff_id, position_id, assignment_type)
          VALUES (?, ?, ?)`).run(staffId, positionId, ROW_KIND[kind]);
    }

    if (kind === 'holder' && sectionId) {
      /*
       * The unit changes hands with the post.
       *
       * `sections.head_staff_id` is read by scheduling, the duty roster, the
       * alert routing, quality control and the permission resolver. Leaving it
       * behind is how the system kept honouring a supervisor who had been
       * replaced.
       */
      db.prepare('UPDATE sections SET head_staff_id = ? WHERE id = ?').run(staffId, sectionId);

      /*
       * Where the post supervises a CLINICAL unit, the supervisor belongs to
       * the unit they supervise. This is the other half of the rotation that
       * went wrong: a supervisor moved to another unit kept her old unit on
       * her staff record, which is what every unit-scoped screen reads to
       * decide whose work she sees. Appointment is the authority here —
       * nobody should have to go and edit the register afterwards.
       *
       * An ADMINISTRATIVE unit is different, and deliberately so. Heading the
       * Quality Office does not stop somebody being a haematologist, so it
       * adds a membership and leaves their clinical unit exactly where it is.
       */
      if (isClinicalUnit(db, sectionId)) {
        setClinicalUnit(db, {
          staffId, sectionId,
          source: `appointment: ${position.title}`,
          syncMemo: true,
        });
      } else {
        /*
         * The office changes hands too.
         *
         * The predecessor's APPOINTMENT ended above, but the membership that
         * appointment created is a separate row, and leaving it behind is the
         * same fault in a new place: the Quality Office would go on listing
         * somebody who stopped running it, and their own record would go on
         * saying they sat there. Only the membership the POST created is
         * removed — anything the laboratory added by hand is its own
         * decision and stays.
         */
        db.prepare(`DELETE FROM staff_unit_memberships
            WHERE section_id = ? AND source = 'position' AND staff_id <> ?`).run(sectionId, staffId);
        addUnitMembership(db, { staffId, sectionId, role: 'head', source: 'position' });
      }
    }
  })();

  const unitName = sectionId
    ? (db.prepare('SELECT name FROM sections WHERE id = ?').get(sectionId) as any)?.name ?? null : null;
  const parts = [`${staff.full_name} holds ${position.title}${kind === 'deputy' ? ' as deputy' : ''}.`];
  if (replaced) parts.push(`${staffName(db, replaced)}’s appointment to it ended.`);
  if (kind === 'holder' && unitName) parts.push(`${unitName} is now run by ${staff.full_name}.`);

  return {
    ok: true, positionId, staffId, kind,
    replacedStaffId: replaced ?? null,
    sectionId: kind === 'holder' ? sectionId : null,
    summary: parts.join(' '),
  };
}

/**
 * End an appointment, leaving the post vacant.
 *
 * A vacant post is an honest state and a visible one — the Appointments tab
 * lists it, and a unit with no supervisor is reported by the system audit.
 * Pretending somebody still holds it is how this went wrong in the first
 * place.
 */
export function vacate(db: DB, input: { positionId: unknown; staffId: unknown }): AppointmentOutcome {
  const positionId = parseIntNullable(input.positionId);
  const staffId = parseIntNullable(input.staffId);
  if (!positionId || !staffId) return { ok: false, status: 400, error: 'Say which appointment is ending.' };

  const row = db.prepare(`SELECT id, assignment_type FROM staff_position_assignments
      WHERE position_id = ? AND staff_id = ? AND is_active = 1`).get(positionId, staffId) as any;
  if (!row) return { ok: false, status: 404, error: 'That appointment is not in force.' };

  const position = db.prepare('SELECT id, title, supervises_section_id FROM positions WHERE id = ?').get(positionId) as any;
  const sectionId = parseIntNullable(position?.supervises_section_id);
  const wasHolder = row.assignment_type === 'primary';

  db.transaction(() => {
    db.prepare('UPDATE staff_position_assignments SET is_active = 0, ends_at = CURRENT_TIMESTAMP WHERE id = ?').run(row.id);
    if (wasHolder && sectionId) {
      const unit = db.prepare('SELECT head_staff_id FROM sections WHERE id = ?').get(sectionId) as any;
      if (Number(unit?.head_staff_id ?? 0) === Number(staffId)) {
        db.prepare('UPDATE sections SET head_staff_id = NULL WHERE id = ?').run(sectionId);
      }
      // The membership an administrative appointment created goes with it.
      // Their clinical unit is untouched, because it never moved in the first
      // place; leaving the Quality Office on their record after they have
      // stopped running it is exactly the kind of stale affiliation this
      // whole module exists to prevent.
      if (!isClinicalUnit(db, sectionId)) removeUnitMembership(db, staffId, sectionId);
    }
  })();

  return {
    ok: true, positionId, staffId, kind: wasHolder ? 'holder' : 'deputy',
    replacedStaffId: null, sectionId: wasHolder ? sectionId : null,
    summary: `${staffName(db, staffId)}’s appointment to ${position?.title ?? 'the post'} has ended.`
      + (wasHolder && sectionId ? ' The unit has no supervisor until somebody is appointed.' : ''),
  };
}

/** Which unit a post supervises — or none. One post per unit. */
export function setSupervisedUnit(db: DB, positionId: unknown, sectionId: unknown): AppointmentOutcome {
  const post = parseIntNullable(positionId);
  const unit = parseIntNullable(sectionId);
  if (!post) return { ok: false, status: 400, error: 'Say which post.' };
  const position = db.prepare('SELECT id, title FROM positions WHERE id = ?').get(post) as any;
  if (!position) return { ok: false, status: 404, error: 'That post is not on the register.' };

  if (unit) {
    const section = db.prepare('SELECT id, name FROM sections WHERE id = ?').get(unit) as any;
    if (!section) return { ok: false, status: 404, error: 'That unit is not on the register.' };
    const taken = db.prepare(`SELECT id, title FROM positions
        WHERE supervises_section_id = ? AND id != ? AND COALESCE(is_active, 1) = 1`).get(unit, post) as any;
    if (taken) {
      return {
        ok: false, status: 409,
        error: `${section.name} is already supervised by ${taken.title}. A unit has one supervising post; change that one first.`,
      };
    }
  }

  db.transaction(() => {
    db.prepare('UPDATE positions SET supervises_section_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(unit, post);
    // Naming the post brings the unit's head into line with whoever holds it.
    if (unit) {
      const holder = holderOf(db, post);
      db.prepare('UPDATE sections SET head_staff_id = ? WHERE id = ?').run(holder, unit);
    }
  })();
  return { ok: true };
}

/* ============================================================================
   What the register looks like
   ========================================================================= */

export interface AppointmentPost {
  id: number;
  title: string;
  isActive: boolean;
  /** An office, appointed to and held by one person. */
  isOffice: boolean;
  reportsToPositionId: number | null;
  supervisesSectionId: number | null;
  supervisesSectionName: string | null;
  holder: { staffId: number; name: string; since: string | null } | null;
  deputy: { staffId: number; name: string; since: string | null } | null;
  /** For a grade, everybody graded into it. Empty for an office. */
  graded: Array<{ staffId: number; name: string }>;
  /** What this post's holders are given by Access Control, where it is mapped. */
  accessProfile: string | null;
}

export interface AppointmentUnit {
  id: number;
  name: string;
  departmentName: string | null;
  postId: number | null;
  postTitle: string | null;
  /** The substantive supervisor: whoever holds the unit's supervising post. */
  supervisorStaffId: number | null;
  supervisorName: string | null;
  /**
   * An acting appointment in force today, where there is one.
   *
   * A stand-in is not a holder: they run the unit for a fixed period and the
   * post reverts on its own when it ends. Both are shown, because "who is in
   * charge today" and "who holds the post" are different questions and a board
   * that answers only one of them sends somebody to the wrong person.
   */
  actingId: number | null;
  actingStaffId: number | null;
  actingName: string | null;
  actingFrom: string | null;
  actingUntil: string | null;
  actingReason: string | null;
  /** Who is in charge today: the stand-in if there is one, else the holder. */
  inChargeStaffId: number | null;
  inChargeName: string | null;
}

/** A stand-in appointment, whether in force, still to start or finished. */
export interface ActingAppointment {
  id: number;
  sectionId: number;
  sectionName: string;
  actingStaffId: number;
  actingName: string;
  substantiveName: string | null;
  startDate: string;
  endDate: string;
  reason: string | null;
  status: string;
  inForce: boolean;
}

export function appointmentRegister(db: DB): {
  posts: AppointmentPost[];
  units: AppointmentUnit[];
  acting: ActingAppointment[];
  people: Array<{ staffId: number; name: string; sectionName: string | null; posts: string[] }>;
  conflicts: string[];
} {
  const posts = (db.prepare(`SELECT p.id, p.title, COALESCE(p.is_active, 1) AS is_active, COALESCE(p.is_core, 0) AS is_core,
        p.reports_to_position_id, p.supervises_section_id, s.name AS section_name, r.name AS profile_name
      FROM positions p
      LEFT JOIN sections s ON s.id = p.supervises_section_id
      LEFT JOIN roles r ON r.id = p.access_profile_role_id
      ORDER BY COALESCE(p.is_core, 0) DESC, p.title`).all() as any[]).map(row => {
    const occupant = (kind: string) => {
      const found = db.prepare(`SELECT spa.staff_id, st.full_name, spa.starts_at FROM staff_position_assignments spa
          JOIN staff st ON st.id = spa.staff_id
          WHERE spa.position_id = ? AND spa.is_active = 1 AND spa.assignment_type = ?
          ORDER BY spa.id DESC LIMIT 1`).get(row.id, kind) as any;
      return found ? { staffId: Number(found.staff_id), name: String(found.full_name), since: found.starts_at ?? null } : null;
    };
    const office = isOffice(row);
    return {
      id: Number(row.id), title: String(row.title),
      isActive: Number(row.is_active) === 1, isOffice: office,
      reportsToPositionId: row.reports_to_position_id ?? null,
      supervisesSectionId: row.supervises_section_id ?? null,
      supervisesSectionName: row.section_name ?? null,
      holder: occupant('primary'),
      deputy: occupant('deputy'),
      graded: office ? [] : (db.prepare(`SELECT spa.staff_id, st.full_name FROM staff_position_assignments spa
          JOIN staff st ON st.id = spa.staff_id
          WHERE spa.position_id = ? AND spa.is_active = 1 AND spa.assignment_type = 'primary'
          ORDER BY st.full_name`).all(row.id) as any[])
        .map(r => ({ staffId: Number(r.staff_id), name: String(r.full_name) })),
      accessProfile: row.profile_name ?? null,
    } as AppointmentPost;
  });

  const today = new Date().toISOString().slice(0, 10);
  /*
   * A finished acting period reverts on its own.
   *
   * The register must read true whether or not the overnight sweep has run,
   * because somebody opening this screen is deciding who to go to today.
   */
  try {
    db.prepare(`UPDATE acting_unit_heads SET status = 'ended', updated_at = CURRENT_TIMESTAMP
        WHERE status = 'active' AND end_date < date('now')`).run();
  } catch { /* the in-force test below does not rely on it having run */ }

  const units = (db.prepare(`SELECT s.id, s.name, s.head_staff_id, d.name AS department_name
      FROM sections s LEFT JOIN departments d ON d.id = s.department_id
      WHERE s.is_active = 1 ORDER BY d.name, s.name`).all() as any[])
    .map(unit => {
      const post = posts.find(p => p.supervisesSectionId === Number(unit.id) && p.isActive) ?? null;
      const acting = db.prepare(`SELECT a.id, a.acting_staff_id, a.start_date, a.end_date, a.reason, st.full_name
          FROM acting_unit_heads a
          JOIN staff st ON st.id = a.acting_staff_id
          WHERE a.section_id = ? AND a.status = 'active' AND a.start_date <= ? AND a.end_date >= ?
          ORDER BY a.start_date DESC, a.id DESC LIMIT 1`).get(unit.id, today, today) as any;
      return {
        id: Number(unit.id), name: String(unit.name),
        departmentName: unit.department_name ?? null,
        postId: post?.id ?? null, postTitle: post?.title ?? null,
        supervisorStaffId: post?.holder?.staffId ?? null,
        supervisorName: post?.holder?.name ?? null,
        actingId: acting?.id ?? null,
        actingStaffId: acting?.acting_staff_id ?? null,
        actingName: acting?.full_name ?? null,
        actingFrom: acting?.start_date ?? null,
        actingUntil: acting?.end_date ?? null,
        actingReason: acting?.reason ?? null,
        inChargeStaffId: acting?.acting_staff_id ?? post?.holder?.staffId ?? null,
        inChargeName: acting?.full_name ?? post?.holder?.name ?? null,
      } as AppointmentUnit;
    });

  /** Every stand-in on the record: in force, still to start, and finished. */
  const acting: ActingAppointment[] = (db.prepare(`SELECT a.id, a.section_id, a.acting_staff_id, a.start_date,
        a.end_date, a.reason, a.status, sec.name AS section_name, st.full_name AS acting_name,
        h.full_name AS substantive_name
      FROM acting_unit_heads a
      JOIN sections sec ON sec.id = a.section_id
      JOIN staff st ON st.id = a.acting_staff_id
      LEFT JOIN staff h ON h.id = a.substantive_head_staff_id
      ORDER BY (a.status = 'active') DESC, a.start_date DESC, a.id DESC`).all() as any[])
    .map(row => ({
      id: Number(row.id), sectionId: Number(row.section_id), sectionName: String(row.section_name),
      actingStaffId: Number(row.acting_staff_id), actingName: String(row.acting_name),
      substantiveName: row.substantive_name ?? null,
      startDate: String(row.start_date), endDate: String(row.end_date),
      reason: row.reason ?? null, status: String(row.status),
      inForce: row.status === 'active' && String(row.start_date) <= today && String(row.end_date) >= today,
    }));

  const people = (db.prepare(`SELECT st.id, st.full_name, sec.name AS section_name
      FROM staff st LEFT JOIN sections sec ON sec.id = st.section_id
      WHERE st.is_active = 1 ORDER BY st.full_name`).all() as any[]).map(person => ({
    staffId: Number(person.id),
    name: String(person.full_name),
    sectionName: person.section_name ?? null,
    posts: posts.filter(p => p.deputy?.staffId === Number(person.id)
        || (p.isOffice ? p.holder?.staffId === Number(person.id) : p.graded.some(g => g.staffId === Number(person.id))))
      .map(p => (p.deputy?.staffId === Number(person.id) ? `${p.title} (deputy)` : p.title)),
  }));

  /*
   * Anything the rules should have made impossible, said out loud.
   *
   * The invariants are held by the database and by this module, so this ought
   * to stay empty — and if it ever does not, a laboratory should be told
   * rather than left to discover it on a staff list.
   */
  const conflicts: string[] = [];
  for (const row of db.prepare(`SELECT p.title, COUNT(*) AS n FROM staff_position_assignments spa
      JOIN positions p ON p.id = spa.position_id
      WHERE spa.is_active = 1 AND spa.assignment_type = 'primary'
        AND (COALESCE(p.is_core, 0) = 1 OR p.supervises_section_id IS NOT NULL)
      GROUP BY spa.position_id HAVING n > 1`).all() as any[]) {
    conflicts.push(`${row.title} has ${row.n} holders on the record.`);
  }
  for (const unit of units) {
    const head = db.prepare('SELECT head_staff_id FROM sections WHERE id = ?').get(unit.id) as any;
    const headId = head?.head_staff_id ?? null;
    if (unit.postId && Number(headId ?? 0) !== Number(unit.supervisorStaffId ?? 0)) {
      conflicts.push(`${unit.name} is recorded as run by ${staffName(db, headId)}, but ${unit.postTitle} is held by ${unit.supervisorName ?? 'nobody'}.`);
    }
  }
  return { posts, units, acting, people, conflicts };
}
