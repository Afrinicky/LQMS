/**
 * Passwords, sessions, and what happens to someone who keeps guessing.
 *
 * Everything that sets a password or opens a session goes through here, so the
 * rule cannot drift between the three places that used to enforce their own
 * version of it (validation findings VF-02, VF-19, VF-20).
 */
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import type { Request } from 'express';
import { getDb } from '../db/database.js';
import { audit } from './auditService.js';
import { hashToken } from '../middleware/auth.js';
import {
  checkPassword, LOCKOUT_MINUTES, MAX_FAILED_ATTEMPTS, PASSWORD_HISTORY_DEPTH, SESSION_HOURS,
} from '../../shared/constants/credentials.js';

const BCRYPT_ROUNDS = 12;

/* --------------------------------------------------------------- passwords */

export interface SetPasswordResult { ok: boolean; error?: string }

/**
 * Set a password, having checked that it is allowed to be one.
 *
 * `reuse` is checked against the last few hashes for the account. bcrypt has no
 * shortcut for this — each comparison is a full verification — which is why the
 * history is short.
 */
export function setPassword(
  userId: number,
  password: string,
  options: { mustChange?: boolean; skipHistory?: boolean } = {},
): SetPasswordResult {
  const db = getDb();
  const user = db.prepare('SELECT id, username, full_name FROM users WHERE id = ?').get(userId) as
    { id: number; username: string; full_name: string } | undefined;
  if (!user) return { ok: false, error: 'User not found.' };

  const verdict = checkPassword(password, { username: user.username, fullName: user.full_name });
  if (!verdict.ok) return { ok: false, error: verdict.error };

  if (!options.skipHistory) {
    const history = db.prepare('SELECT password_hash FROM password_history WHERE user_id = ? ORDER BY id DESC LIMIT ?')
      .all(userId, PASSWORD_HISTORY_DEPTH) as Array<{ password_hash: string }>;
    const current = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId) as { password_hash: string };
    const seen = [current?.password_hash, ...history.map(h => h.password_hash)].filter(Boolean) as string[];
    if (seen.some(hash => bcrypt.compareSync(password, hash))) {
      return { ok: false, error: `Choose a password you have not used before. The last ${PASSWORD_HISTORY_DEPTH} are remembered.` };
    }
  }

  const hash = bcrypt.hashSync(password, BCRYPT_ROUNDS);
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(hash, options.mustChange ? 1 : 0, userId);
  db.prepare('INSERT INTO password_history (user_id, password_hash) VALUES (?, ?)').run(userId, hash);
  // Keep the history at its stated depth rather than for ever.
  db.prepare(
    `DELETE FROM password_history WHERE user_id = ? AND id NOT IN
       (SELECT id FROM password_history WHERE user_id = ? ORDER BY id DESC LIMIT ?)`
  ).run(userId, userId, PASSWORD_HISTORY_DEPTH);

  return { ok: true };
}

/** Hash a password for an account that does not exist yet (first admin, imports). */
export function hashNewPassword(password: string, context: { username?: string; fullName?: string } = {}):
  { ok: true; hash: string } | { ok: false; error: string } {
  const verdict = checkPassword(password, context);
  if (!verdict.ok) return { ok: false, error: verdict.error! };
  return { ok: true, hash: bcrypt.hashSync(password, BCRYPT_ROUNDS) };
}

/* ---------------------------------------------------------------- lockout */

export interface LockState { locked: boolean; minutesRemaining: number }

/** Is this account currently locked, and for how much longer? */
export function lockState(username: string): LockState {
  const row = getDb().prepare(
    "SELECT locked_until FROM users WHERE username = ? COLLATE NOCASE"
  ).get(username) as { locked_until: string | null } | undefined;
  if (!row?.locked_until) return { locked: false, minutesRemaining: 0 };

  const until = Date.parse(`${row.locked_until.replace(' ', 'T')}Z`);
  if (!Number.isFinite(until) || until <= Date.now()) return { locked: false, minutesRemaining: 0 };
  return { locked: true, minutesRemaining: Math.max(1, Math.ceil((until - Date.now()) / 60_000)) };
}

/**
 * Record a failed sign-in, and lock the account if it has now failed too often.
 *
 * The attempt is recorded whether or not the username exists, so the trail
 * shows an attack on a username that was never real — which is exactly the
 * pattern worth seeing. The response the caller gives back must not differ,
 * or this becomes a way to enumerate accounts.
 */
export function recordFailure(req: Request, username: string): LockState {
  const db = getDb();
  const name = String(username ?? '').trim();
  db.prepare('INSERT INTO auth_attempts (username, ip_address, succeeded) VALUES (?, ?, 0)').run(name, req.ip ?? null);

  const since = new Date(Date.now() - LOCKOUT_MINUTES * 60_000).toISOString().replace('T', ' ').slice(0, 19);
  const { failures } = db.prepare(
    "SELECT COUNT(*) AS failures FROM auth_attempts WHERE username = ? COLLATE NOCASE AND succeeded = 0 AND created_at >= ?"
  ).get(name, since) as { failures: number };

  const user = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(name) as { id: number } | undefined;

  audit(req, {
    action: 'login_failed', entity: 'users', entityId: user?.id ?? null,
    actorUserId: null, newValue: { username: name, failuresInWindow: failures },
  });

  if (failures >= MAX_FAILED_ATTEMPTS && user) {
    db.prepare(`UPDATE users SET locked_until = datetime('now', '+${LOCKOUT_MINUTES} minutes') WHERE id = ?`).run(user.id);
    audit(req, {
      action: 'account_locked', entity: 'users', entityId: user.id, actorUserId: null,
      newValue: { username: name, failures, minutes: LOCKOUT_MINUTES, reason: 'Consecutive failed sign-in attempts' },
    });
    return { locked: true, minutesRemaining: LOCKOUT_MINUTES };
  }
  return { locked: false, minutesRemaining: 0 };
}

/** A successful sign-in clears the slate. */
export function recordSuccess(req: Request, userId: number, username: string) {
  const db = getDb();
  db.prepare('INSERT INTO auth_attempts (username, ip_address, succeeded) VALUES (?, ?, 1)').run(username, req.ip ?? null);
  db.prepare('DELETE FROM auth_attempts WHERE username = ? COLLATE NOCASE AND succeeded = 0').run(username);
  db.prepare('UPDATE users SET locked_until = NULL WHERE id = ?').run(userId);
  audit(req, { action: 'login_success', entity: 'users', entityId: userId, actorUserId: userId, newValue: { username } });
}

/* --------------------------------------------------------------- sessions */

/**
 * Open a session. The caller gets the only copy of the token; the database
 * keeps its digest.
 */
export function openSession(req: Request, userId: number): string {
  const token = crypto.randomBytes(32).toString('hex');
  getDb().prepare(
    `INSERT INTO auth_sessions (user_id, token_hash, device_id, ip_address, expires_at, last_seen_at)
     VALUES (?, ?, ?, ?, datetime('now', '+${SESSION_HOURS} hours'), CURRENT_TIMESTAMP)`
  ).run(userId, hashToken(token), req.headers['x-device-id'] ?? null, req.ip ?? null);
  return token;
}

/** Close one session. */
export function revokeSession(token: string) {
  getDb().prepare('UPDATE auth_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE token_hash = ?').run(hashToken(token));
}

/** Close every session for an account, optionally sparing the caller's own. */
export function revokeAllSessions(userId: number, keepToken?: string | null) {
  const db = getDb();
  if (keepToken) {
    db.prepare('UPDATE auth_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = ? AND revoked_at IS NULL AND token_hash != ?')
      .run(userId, hashToken(keepToken));
  } else {
    db.prepare('UPDATE auth_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = ? AND revoked_at IS NULL').run(userId);
  }
}

/** Confirm a password belongs to this user. Used before signing (VF-04). */
export function verifyPassword(userId: number, password: string): boolean {
  const row = getDb().prepare('SELECT password_hash FROM users WHERE id = ? AND is_active = 1')
    .get(userId) as { password_hash: string } | undefined;
  return !!row && bcrypt.compareSync(String(password ?? ''), row.password_hash);
}
