/**
 * Which unit a person belongs to — written in one place, and read everywhere.
 *
 * THE FAILURE THIS EXISTS TO END. A scientist was moved from Haematology to
 * Microbiology on the personnel register, and was still in Haematology
 * everywhere that mattered: the daily work routed to her was Haematology's,
 * her personnel file printed HAEMATOLOGY, and once she was appointed to run
 * Microbiology she still could not reach Microbiology's records. Nobody had
 * done anything wrong. "Which unit" was kept in three unrelated places, and
 * each screen read whichever one it happened to know about:
 *
 *   `staff.section_id`   the register's link to the unit;
 *   `staff.unit`         a free-text column written once at import and never
 *                        again, which the personnel file and the Excel export
 *                        printed IN PREFERENCE to the real unit;
 *   the monthly memo     `reassignment_rows`, which dutyService reads FIRST,
 *                        so until the memo was re-cut the move had not
 *                        happened as far as the work was concerned.
 *
 * Now there is one answer:
 *
 *   `staff.section_id` IS the clinical unit. One per person, mandatory for
 *   laboratory professionals. Everything else is derived from it.
 *
 *   `staff.unit` is overwritten from it on every write, so a printout can no
 *   longer contradict the register.
 *
 *   The CURRENT month's memo is kept in step both ways: changing a unit
 *   anywhere writes the memo, and editing or publishing the memo writes the
 *   register. Past months stay exactly as they were — they are the record of
 *   what happened, not a thing to correct. Future months are plans, and take
 *   effect when their month arrives.
 *
 *   Administrative units (the Quality Office, the Stores) are ADDITIONAL
 *   memberships in `staff_unit_memberships`. They never displace the clinical
 *   unit, because heading the Quality Office does not stop somebody being a
 *   haematologist.
 *
 * Every caller that can move somebody goes through `setClinicalUnit`. That is
 * the whole point: there is no second way in.
 */

type DB = any;

export type UnitKind = 'clinical' | 'administrative';

/** Access levels a cross-unit grant can carry, weakest first. */
export const UNIT_GRANT_LEVELS = ['view', 'contribute', 'manage', 'full'] as const;
export type UnitGrantLevel = (typeof UNIT_GRANT_LEVELS)[number];

export function currentMonth(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

export function unitKindOf(db: DB, sectionId: unknown): UnitKind | null {
  const id = num(sectionId);
  if (!id) return null;
  const row = db.prepare('SELECT unit_kind AS kind FROM sections WHERE id = ?').get(id) as { kind: string } | undefined;
  if (!row) return null;
  return row.kind === 'administrative' ? 'administrative' : 'clinical';
}

export function isClinicalUnit(db: DB, sectionId: unknown): boolean {
  return unitKindOf(db, sectionId) === 'clinical';
}

/* ==========================================================================
   The clinical unit — the single writer
   ========================================================================== */

export type SetUnitResult = {
  ok: boolean;
  changed: boolean;
  error?: string;
  status?: number;
  /** The unit they were in before, for the message and the audit trail. */
  previousSectionId?: number | null;
  previousSectionName?: string | null;
  sectionName?: string | null;
};

/**
 * Move a member of staff into a clinical unit — or out of every unit, with
 * `sectionId: null`.
 *
 * `syncMemo` is the only reason this takes an option at all: when the memo
 * itself is what is being applied, writing the memo back from the register
 * would be a loop.
 */
export function setClinicalUnit(
  db: DB,
  input: {
    staffId: unknown;
    sectionId: unknown;
    actorUserId?: number | null;
    reason?: string | null;
    source?: string;
    syncMemo?: boolean;
  },
): SetUnitResult {
  const staffId = num(input.staffId);
  if (!staffId) return { ok: false, changed: false, status: 400, error: 'Say whose unit is changing.' };
  const sectionId = num(input.sectionId);

  const staff = db.prepare('SELECT id, full_name, section_id FROM staff WHERE id = ?').get(staffId) as
    { id: number; full_name: string; section_id: number | null } | undefined;
  if (!staff) return { ok: false, changed: false, status: 404, error: 'That member of staff is not on the register.' };

  let sectionName: string | null = null;
  if (sectionId) {
    const section = db.prepare('SELECT id, name, unit_kind AS kind, is_active AS isActive FROM sections WHERE id = ?').get(sectionId) as
      { id: number; name: string; kind: string; isActive: number } | undefined;
    if (!section) return { ok: false, changed: false, status: 404, error: 'That unit is not on the register.' };
    if (section.kind === 'administrative') {
      // An administrative unit is an addition, never somebody's clinical unit.
      // Saying so plainly is better than silently recording the wrong thing.
      return {
        ok: false, changed: false, status: 400,
        error: `${section.name} is an administrative unit. Add it as an additional unit; a clinical unit is set separately.`,
      };
    }
    if (Number(section.isActive ?? 1) !== 1) {
      return { ok: false, changed: false, status: 400, error: `${section.name} is not an active unit.` };
    }
    sectionName = section.name;
  }

  const previousSectionId = staff.section_id == null ? null : Number(staff.section_id);
  const previousSectionName = previousSectionId
    ? ((db.prepare('SELECT name FROM sections WHERE id = ?').get(previousSectionId) as { name: string } | undefined)?.name ?? null)
    : null;
  if (previousSectionId === (sectionId ?? null)) {
    // Still put the derived column right: a record imported with a stale text
    // unit has to be corrected even when the link itself has not moved.
    db.prepare('UPDATE staff SET unit = ? WHERE id = ? AND IFNULL(unit, \'\') <> IFNULL(?, \'\')')
      .run(sectionName, staffId, sectionName);
    return { ok: true, changed: false, previousSectionId, previousSectionName, sectionName };
  }

  db.transaction(() => {
    db.prepare('UPDATE staff SET section_id = ?, unit = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(sectionId, sectionName, staffId);

    // A clinical unit and an additional membership of the SAME unit would say
    // the same thing twice, and the second copy is the one that goes stale.
    if (sectionId) db.prepare('DELETE FROM staff_unit_memberships WHERE staff_id = ? AND section_id = ?').run(staffId, sectionId);

    if (input.syncMemo !== false) syncMemoFromRegister(db, { staffId, sectionId });

    try {
      db.prepare('INSERT INTO audit_logs (actor_user_id, action, entity, entity_id, old_value, new_value) VALUES (?, ?, ?, ?, ?, ?)')
        .run(input.actorUserId ?? null, 'unit_change', 'staff', staffId,
          JSON.stringify({ sectionId: previousSectionId, sectionName: previousSectionName }),
          JSON.stringify({ sectionId, sectionName, source: input.source ?? 'register', reason: input.reason ?? null }));
    } catch { /* the move matters, the note about it does not */ }
  })();

  return { ok: true, changed: true, previousSectionId, previousSectionName, sectionName };
}

/* ==========================================================================
   Keeping the current month's memo in step
   ========================================================================== */

/** The memo in force for a month, preferring an approved one. */
export function activeMemo(db: DB, month: string): { id: number; month: string; status: string } | null {
  return db.prepare(`SELECT id, month, status FROM reassignment_schedules WHERE month = ?
     ORDER BY CASE status WHEN 'approved' THEN 0 WHEN 'published' THEN 1 ELSE 2 END, id DESC LIMIT 1`).get(month) ?? null;
}

/**
 * Write one person's unit into the CURRENT month's memo.
 *
 * Takes them out of whatever row they were on and puts them on the row for
 * their new unit. A memo that does not exist yet is not created: a laboratory
 * that has not cut one this month has nothing to keep in step, and the
 * register answers for the month on its own.
 *
 * Somebody who holds the unit's supervisor or deputy slot is left in it —
 * those slots are maintained from the appointment, not from membership.
 */
export function syncMemoFromRegister(db: DB, input: { staffId: number; sectionId: number | null }): void {
  const memo = activeMemo(db, currentMonth());
  if (!memo) return;
  const rows = db.prepare('SELECT id, section_id, member_ids, supervisor_staff_id, deputy_staff_id FROM reassignment_rows WHERE schedule_id = ?')
    .all(memo.id) as Array<{ id: number; section_id: number | null; member_ids: string | null; supervisor_staff_id: number | null; deputy_staff_id: number | null }>;

  const readMembers = (raw: string | null): number[] => {
    try {
      const parsed = JSON.parse(raw || '[]');
      return Array.isArray(parsed) ? parsed.map(Number).filter(n => Number.isFinite(n)) : [];
    } catch { return []; }
  };
  const write = db.prepare('UPDATE reassignment_rows SET member_ids = ? WHERE id = ?');

  for (const row of rows) {
    const members = readMembers(row.member_ids);
    const isTarget = input.sectionId !== null && Number(row.section_id) === Number(input.sectionId);
    const holdsSlot = Number(row.supervisor_staff_id) === input.staffId || Number(row.deputy_staff_id) === input.staffId;
    const present = members.includes(input.staffId);

    if (isTarget && !present && !holdsSlot) {
      write.run(JSON.stringify([...members, input.staffId]), row.id);
    } else if (!isTarget && present) {
      write.run(JSON.stringify(members.filter(m => m !== input.staffId)), row.id);
    }
  }
}

/**
 * Apply a memo to the register: everybody named on a row that is linked to a
 * real unit is moved to that unit.
 *
 * This is the memo acting as the source of truth. `syncMemo: false` stops the
 * register writing straight back into the memo it is being read from.
 */
export function applyMemoToRegister(db: DB, scheduleId: unknown, actorUserId?: number | null): number {
  const rows = db.prepare('SELECT * FROM reassignment_rows WHERE schedule_id = ? AND section_id IS NOT NULL').all(scheduleId) as any[];
  let moved = 0;
  for (const row of rows) {
    const ids = new Set<number>();
    const add = (v: unknown) => { const n = num(v); if (n) ids.add(n); };
    add(row.supervisor_staff_id);
    add(row.deputy_staff_id);
    try { for (const m of JSON.parse(row.member_ids || '[]')) add(m); } catch { /* a malformed list must not stop the rest */ }
    for (const staffId of ids) {
      const result = setClinicalUnit(db, {
        staffId, sectionId: row.section_id, actorUserId,
        source: 'unit reassignment', syncMemo: false,
      });
      if (result.changed) moved++;
    }
  }
  return moved;
}

/* ==========================================================================
   Additional (administrative) memberships
   ========================================================================== */

export function addUnitMembership(
  db: DB,
  input: { staffId: unknown; sectionId: unknown; role?: string; source?: string; actorUserId?: number | null },
): { ok: boolean; error?: string; status?: number } {
  const staffId = num(input.staffId);
  const sectionId = num(input.sectionId);
  if (!staffId || !sectionId) return { ok: false, status: 400, error: 'Say who is joining which unit.' };
  if (!db.prepare('SELECT id FROM staff WHERE id = ?').get(staffId)) {
    return { ok: false, status: 404, error: 'That member of staff is not on the register.' };
  }
  const section = db.prepare('SELECT id, name FROM sections WHERE id = ?').get(sectionId) as { id: number; name: string } | undefined;
  if (!section) return { ok: false, status: 404, error: 'That unit is not on the register.' };

  const staff = db.prepare('SELECT section_id FROM staff WHERE id = ?').get(staffId) as { section_id: number | null };
  if (Number(staff.section_id ?? 0) === sectionId) {
    return { ok: false, status: 400, error: `This is already their clinical unit.` };
  }
  db.prepare(`INSERT OR IGNORE INTO staff_unit_memberships (staff_id, section_id, role, source, created_by)
      VALUES (?, ?, ?, ?, ?)`)
    .run(staffId, sectionId, input.role ?? 'member', input.source ?? 'manual', input.actorUserId ?? null);
  return { ok: true };
}

export function removeUnitMembership(db: DB, staffId: unknown, sectionId: unknown): void {
  const s = num(staffId); const sec = num(sectionId);
  if (!s || !sec) return;
  db.prepare('DELETE FROM staff_unit_memberships WHERE staff_id = ? AND section_id = ?').run(s, sec);
}

/* ==========================================================================
   Reading it back
   ========================================================================== */

export type StaffUnits = {
  clinical: { id: number; name: string } | null;
  additional: Array<{ id: number; name: string; kind: UnitKind; role: string; source: string; isPseudo: number }>;
  grants: Array<{ id: number; sectionId: number; sectionName: string; level: UnitGrantLevel; expiresAt: string | null; reason: string | null }>;
};

export function unitsForStaff(db: DB, staffId: unknown): StaffUnits {
  const id = num(staffId);
  if (!id) return { clinical: null, additional: [], grants: [] };

  const clinical = db.prepare(`SELECT sec.id, sec.name FROM staff s
      JOIN sections sec ON sec.id = s.section_id WHERE s.id = ?`).get(id) as { id: number; name: string } | undefined;

  const additional = db.prepare(`SELECT sec.id, sec.name, sec.unit_kind AS kind, sec.is_pseudo AS isPseudo, m.role, m.source
      FROM staff_unit_memberships m JOIN sections sec ON sec.id = m.section_id
      WHERE m.staff_id = ? ORDER BY sec.name`).all(id) as StaffUnits['additional'];

  const today = new Date().toISOString().slice(0, 10);
  const grants = db.prepare(`SELECT g.id, g.section_id AS sectionId, sec.name AS sectionName, g.level,
        g.expires_at AS expiresAt, g.reason
      FROM staff_unit_grants g JOIN sections sec ON sec.id = g.section_id
      WHERE g.staff_id = ? AND g.is_active = 1 AND g.revoked_at IS NULL
        AND (g.expires_at IS NULL OR g.expires_at >= ?)
      ORDER BY sec.name`).all(id, today) as StaffUnits['grants'];

  return { clinical: clinical ?? null, additional, grants };
}

/** Every unit a person may work in today: their own, plus anything granted. */
export function workableUnitIds(db: DB, staffId: unknown): Set<number> {
  const units = unitsForStaff(db, staffId);
  const ids = new Set<number>();
  if (units.clinical) ids.add(units.clinical.id);
  for (const u of units.additional) ids.add(u.id);
  for (const g of units.grants) ids.add(g.sectionId);
  return ids;
}

/**
 * The level a cross-unit grant gives somebody in a unit that is not theirs,
 * or null where they need no grant (it is their own unit) or hold none.
 */
export function unitGrantLevel(db: DB, staffId: unknown, sectionId: unknown): UnitGrantLevel | null {
  const s = num(staffId); const sec = num(sectionId);
  if (!s || !sec) return null;
  const today = new Date().toISOString().slice(0, 10);
  const row = db.prepare(`SELECT level FROM staff_unit_grants
      WHERE staff_id = ? AND section_id = ? AND is_active = 1 AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at >= ?)`).get(s, sec, today) as { level: string } | undefined;
  if (!row) return null;
  return (UNIT_GRANT_LEVELS as readonly string[]).includes(row.level) ? row.level as UnitGrantLevel : 'contribute';
}

/**
 * The laboratory's units, for anything that counts them.
 *
 * A pseudo unit is an appointment rather than a place — a Quality Office that
 * is one person and a filing cabinet inside Haematology — so it is left out of
 * the count. A laboratory with a real, separate quality office clears the flag
 * and it is counted like any other unit.
 */
export function countableUnits(db: DB): Array<{ id: number; name: string; kind: UnitKind }> {
  return db.prepare(`SELECT id, name, unit_kind AS kind FROM sections
      WHERE is_active = 1 AND IFNULL(is_pseudo, 0) = 0 ORDER BY unit_kind, name`).all() as Array<{ id: number; name: string; kind: UnitKind }>;
}
