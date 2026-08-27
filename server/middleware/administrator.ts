import type { NextFunction, Request, Response } from 'express';
import { getDb } from '../db/database.js';
import { profileIdForUser } from '../services/permissionResolver.js';

/**
 * The administrator gate.
 *
 * Almost everything in SECH_LIMS is decided by the permission matrix, and that
 * is the right instrument: a laboratory decides who does what. A few things are
 * not the matrix's to grant, because they change a quality record after the
 * fact — correcting a control run somebody has already acted on, or removing
 * one from the record altogether. ISO 15189 expects those to be rare,
 * attributable and reasoned, so they are reserved for the administrator and
 * cannot be handed out by ticking a box.
 *
 * "Administrator" is a flag on the role (`roles.is_administrator`), not a name,
 * so renaming the role does not silently open or close the gate.
 *
 * The client hides these controls from everyone else. This is what actually
 * stops them.
 */
export function isAdministrator(userId: number | undefined): boolean {
  if (!userId) return false;
  // Read the flag off the ACCESS PROFILE the user actually resolves to — the
  // same one every other permission question uses. Reading it straight off
  // `users.role_id` would disagree with the rest of the model the moment a
  // position mapping applied, which is exactly the kind of second opinion this
  // work set out to remove.
  const { profileId } = profileIdForUser(userId);
  if (profileId === null) return false;
  const row = getDb().prepare('SELECT is_administrator AS a FROM roles WHERE id = ?').get(profileId) as { a: number } | undefined;
  return Number(row?.a) === 1;
}

/**
 * Guard a route that only an administrator may reach. `what` completes the
 * refusal — "Only an administrator may <what>." — so the message says which
 * capability was reserved rather than a bare "denied".
 */
export function requireAdministrator(what: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (!isAdministrator(req.user.id)) {
      return res.status(403).json({ error: `Only an administrator may ${what}.`, administratorOnly: true });
    }
    next();
  };
}

/**
 * A reason, required.
 *
 * Every administrator override records why it happened — that record is the
 * point of reserving it. Returns the trimmed reason, or null when it is missing
 * or too thin to mean anything, in which case the caller refuses the request.
 */
export function requiredReason(value: unknown): string | null {
  const reason = String(value ?? '').trim();
  return reason.length >= 10 ? reason : null;
}
