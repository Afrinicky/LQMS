import type { NextFunction, Request, Response } from 'express';
import crypto from 'node:crypto';
import { getDb } from '../db/database.js';
import { IDLE_TIMEOUT_MINUTES } from '../../shared/constants/credentials.js';

declare global {
  namespace Express {
    interface Request { user?: { id: number; username: string; roleId: number; staffId?: number | null } }
  }
}

/**
 * Sessions are looked up by the SHA-256 of the token, never by the token
 * itself. Reading `auth_sessions` therefore no longer hands anybody a working
 * session (validation finding VF-20). The digest is unsalted on purpose — the
 * token is 256 bits of CSPRNG output, so there is nothing to guess and a salt
 * would only prevent the indexed lookup.
 */
export const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

/** Read the bearer token off a request, if there is one. */
export function tokenFrom(req: Request): string | null {
  const raw = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  return raw && raw.trim() ? raw.trim() : null;
}

export function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  const token = tokenFrom(req);
  if (!token) return next();

  const db = getDb();
  const session = db.prepare(
    `SELECT s.id, s.last_seen_at, u.id AS user_id, u.username, u.role_id, u.staff_id
     FROM auth_sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > CURRENT_TIMESTAMP AND u.is_active = 1`
  ).get(hashToken(token)) as {
    id: number; last_seen_at: string | null; user_id: number; username: string; role_id: number; staff_id: number | null;
  } | undefined;
  if (!session) return next();

  // A session also dies after a spell of inactivity, however much of its
  // absolute lifetime is left. A bench workstation left signed in at the start
  // of a shift used to stay usable for the rest of it (VF-18).
  const idleSince = session.last_seen_at ? Date.parse(`${session.last_seen_at.replace(' ', 'T')}Z`) : NaN;
  if (Number.isFinite(idleSince) && Date.now() - idleSince > IDLE_TIMEOUT_MINUTES * 60_000) {
    db.prepare("UPDATE auth_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE id = ?").run(session.id);
    return next();
  }

  db.prepare('UPDATE auth_sessions SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?').run(session.id);
  req.user = { id: session.user_id, username: session.username, roleId: session.role_id, staffId: session.staff_id };
  next();
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  next();
}
