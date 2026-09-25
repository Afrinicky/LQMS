/**
 * Who actually runs a unit today — and what that entitles them to.
 *
 * A unit is run by the person the unit record names as its head, or, while
 * that person is away, by whoever was appointed to act for them. Both are the
 * same job as far as the work goes: preparing the unit's bench schedule,
 * defining the controls its tests need, running them.
 *
 * Until now that standing was recorded in two tables and read by neither the
 * permission resolver nor the screens that gate this work, so the person
 * running the unit was held to whatever profile their login account happened
 * to carry — usually a bench profile, which grants none of it. The work of
 * running a unit was therefore open to nobody but the administrator.
 *
 * This module is the one place that answers "which units does this person
 * run?", so the route guards, the permission payload and the screens cannot
 * disagree about it. Two rules bound what the answer is worth:
 *
 *   · it reaches only the units they run. Heading Haematology is not a reason
 *     to prepare Microbiology's schedule or define its controls;
 *   · it never overrides Access Control. A right explicitly withdrawn from a
 *     person on the Individuals screen stays withdrawn, whatever post they
 *     hold — that screen is the highest authority in the system and nothing
 *     here may quietly outrank it.
 */
import { getDb } from '../db/database.js';
import { getFeature } from '../../shared/constants/features.js';
import { resolvePermission, BASE_ACTION } from './permissionResolver.js';
import { parseIntNullable } from '../routes/routeHelpers.js';

export type LedUnit = { id: number; name: string; acting: boolean };

/** The staff record behind a request, if the account is linked to one. */
function staffIdOf(req: any): number | null {
  return parseIntNullable(req?.user?.staffId);
}

/** The staff record behind a user id. */
function staffIdOfUser(userId: number): number | null {
  const row = getDb().prepare('SELECT staff_id FROM users WHERE id = ? AND is_active = 1').get(userId) as
    { staff_id: number | null } | undefined;
  return row?.staff_id ?? null;
}

/**
 * The units this member of staff runs today.
 *
 * Substantive headship first, then any acting appointment that is in force on
 * today's date — an appointment that starts next week grants nothing today,
 * and one that ended last night grants nothing at all.
 */
export function unitsLedByStaff(staffId: number | null): LedUnit[] {
  if (staffId === null) return [];
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);
  const units = new Map<number, LedUnit>();

  for (const row of db.prepare('SELECT id, name FROM sections WHERE head_staff_id = ? AND is_active = 1 ORDER BY name')
    .all(staffId) as Array<{ id: number; name: string }>) {
    units.set(row.id, { id: row.id, name: row.name, acting: false });
  }
  for (const row of db.prepare(`SELECT s.id, s.name FROM acting_unit_heads a
      JOIN sections s ON s.id = a.section_id
      WHERE a.acting_staff_id = ? AND a.status = 'active'
        AND a.start_date <= ? AND a.end_date >= ? AND s.is_active = 1
      ORDER BY s.name`).all(staffId, today, today) as Array<{ id: number; name: string }>) {
    if (!units.has(row.id)) units.set(row.id, { id: row.id, name: row.name, acting: true });
  }
  return [...units.values()];
}

/** The units the signed-in person runs today. */
export function unitsLedBy(userId: number): LedUnit[] {
  return unitsLedByStaff(staffIdOfUser(userId));
}

/** The units the caller of this request runs today. */
export function unitsLedByRequest(req: any): LedUnit[] {
  return unitsLedByStaff(staffIdOf(req));
}

/** Does the caller run this particular unit? */
export function leadsUnit(req: any, sectionId: number | null | undefined): boolean {
  const id = parseIntNullable(sectionId);
  if (id === null) return false;
  return unitsLedByRequest(req).some(u => u.id === id);
}

/** Does the caller run any unit at all? */
export function leadsAnyUnit(req: any): boolean {
  return unitsLedByRequest(req).length > 0;
}

/**
 * Has this right been taken off this person individually?
 *
 * Access Control is the highest authority in the system: a right withdrawn
 * there is withdrawn, and no post, appointment or convenience path in the code
 * may hand it back. Every leadership fallback asks this first. A withdrawal
 * written against a module counts for the features inside it, the same way the
 * resolver cascades one.
 */
export function individuallyDenied(userId: number, permKey: string, action: string): boolean {
  const moduleKey = getFeature(permKey)?.module ?? permKey;
  const keys = moduleKey === permKey ? [permKey] : [permKey, moduleKey];
  const row = getDb().prepare(`SELECT 1 AS hit FROM user_permission_overrides o
      JOIN permissions p ON p.id = o.permission_id
      WHERE o.user_id = ? AND o.allowed = 0 AND p.action = ?
        AND p.module_key IN (${keys.map(() => '?').join(', ')}) LIMIT 1`)
    .get(userId, action, ...keys) as { hit: number } | undefined;
  return Boolean(row);
}

/**
 * May the caller take this action, for this unit?
 *
 * The granted right answers first and answers for the whole laboratory. When
 * it does not, running the unit the record belongs to answers for that unit
 * alone — provided the person may view the area at all, and provided Access
 * Control has not withdrawn the action from them individually, which nothing
 * here may undo.
 */
export function mayActOnUnit(
  req: any,
  permKey: string,
  action: string,
  sectionId: number | null | undefined,
): boolean {
  const userId = req?.user?.id;
  if (!userId) return false;
  if (resolvePermission(userId, permKey, action).allowed) return true;
  if (!leadsUnit(req, sectionId)) return false;
  if (!resolvePermission(userId, permKey, BASE_ACTION).allowed) return false;
  return !individuallyDenied(userId, permKey, action);
}
