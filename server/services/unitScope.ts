/**
 * Whose unit a routine register is being read as — and who is not held to one.
 *
 * Every routine register in the system (environmental charts, decontamination
 * logs, maintenance charts, the unit's IQC board, the unit's activity
 * programme) is scoped to a unit, and that is right: a Haematology technician
 * charting Microbiology's fridge is a mistake, not a feature. The unit comes
 * from the reader's own staff record, so the register they open is the one
 * they work on.
 *
 * But three jobs are accountable for the whole laboratory rather than one
 * bench: the administrator, the Quality Manager and the Laboratory Manager.
 * Holding them to the unit their staff record happens to name meant a Quality
 * Manager sitting in Haematology could not open Biochemistry's temperature
 * charts, set up Microbiology's decontamination log, or answer an assessor
 * asking to see the whole programme — which is exactly the work those posts
 * exist to do. So for them the unit is a CHOICE: their own by default, any
 * unit on request.
 *
 * That choice is made here, once, so every register answers it the same way:
 *
 *   resolveUnitScope   which unit this request is for, and whether the reader
 *                      was allowed to ask for it
 *   selectableUnits    the units they may switch between — all of them for a
 *                      senior post, their own alone for everybody else
 *
 * Seniority is read off the ACCESS PROFILE the permission resolver settles on,
 * not off the account's role row directly, so a person whose organogram
 * position maps them to Quality Manager is senior by the same rule as somebody
 * whose account carries the profile.
 */
import { getDb } from '../db/database.js';
import { profileIdForUser } from './permissionResolver.js';
import { parseIntNullable, getCurrentStaffId } from '../routes/routeHelpers.js';

/**
 * The profiles that are not held to one unit.
 *
 * Matched on the profile NAME as well as the administrator flag, because a
 * laboratory renames "Laboratory Manager" to "Lab Manager" and neither should
 * lose the reach the post carries. The administrator flag is authoritative on
 * its own: whoever holds the keys to access control can already see
 * everything.
 */
const CROSS_UNIT_NAME = /(quality\s*manager|lab(oratory)?\s*manager)/i;

/** Is this user one of the senior posts that answers for the whole laboratory? */
export function isCrossUnitRole(userId: number): boolean {
  const { profileId } = profileIdForUser(userId);
  if (!profileId) return false;
  const row = getDb().prepare('SELECT name, is_administrator AS admin FROM roles WHERE id = ?')
    .get(profileId) as { name: string; admin: number } | undefined;
  if (!row) return false;
  return row.admin === 1 || CROSS_UNIT_NAME.test(String(row.name ?? ''));
}

/** The unit the signed-in person's staff record places them in. */
export function homeUnitId(req: any): number | null {
  const staffId = getCurrentStaffId(req);
  if (staffId === null) return null;
  const row = getDb().prepare('SELECT section_id FROM staff WHERE id = ?').get(staffId) as { section_id?: number | null } | undefined;
  return row?.section_id ?? null;
}

export interface UnitScope {
  /** The unit to read or write, once seniority and the request are both taken into account. */
  sectionId: number | null;
  /** The reader's own unit, whatever they asked for. */
  homeSectionId: number | null;
  /** May this reader work in a unit other than their own? */
  canChooseUnit: boolean;
}

/**
 * Which unit this request is for.
 *
 * A senior post gets the unit it asked for, and its own when it asked for
 * nothing. Everybody else gets their own unit no matter what the query string
 * says — the parameter is ignored rather than refused, because a bench member
 * of staff who lands on a stale link should see their own charts, not an
 * error.
 */
export function resolveUnitScope(req: any, requested?: unknown): UnitScope {
  const home = homeUnitId(req);
  const canChooseUnit = isCrossUnitRole(req.user!.id);
  const asked = parseIntNullable(requested);
  return {
    sectionId: canChooseUnit ? (asked ?? home) : home,
    homeSectionId: home,
    canChooseUnit,
  };
}

/**
 * The units this reader may switch between, for the picker the screens draw.
 *
 * One entry — their own — for ordinary staff, so the picker simply does not
 * appear. Every active unit for a senior post, with their own first so the
 * screen still opens on the bench they sit at.
 */
export function selectableUnits(req: any): Array<{ id: number; name: string }> {
  const db = getDb();
  const home = homeUnitId(req);
  if (!isCrossUnitRole(req.user!.id)) {
    if (home === null) return [];
    const own = db.prepare('SELECT id, name FROM sections WHERE id = ?').get(home) as { id: number; name: string } | undefined;
    return own ? [own] : [];
  }
  const all = db.prepare('SELECT id, name FROM sections WHERE is_active = 1 ORDER BY name').all() as Array<{ id: number; name: string }>;
  return all.sort((a, b) => (a.id === home ? -1 : b.id === home ? 1 : 0));
}

/** The scope, plus everything the screens need to draw a unit picker from it. */
export function unitScopePayload(req: any, requested?: unknown): UnitScope & { units: Array<{ id: number; name: string }> } {
  const scope = resolveUnitScope(req, requested);
  return { ...scope, units: selectableUnits(req) };
}
