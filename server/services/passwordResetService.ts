/**
 * Password reset, administrator-approved.
 *
 * A LAN Host has no email, so there is no link to send and no mailbox to prove
 * ownership of. Recovery therefore runs through a person: the member of staff
 * asks from the sign-in screen, an administrator sees who asked and from where,
 * verifies them the way laboratories already do — they are standing there, or
 * they telephone — and approves.
 *
 * That makes the approval the entire security boundary, which shapes the rest:
 *
 *   • The reset token is handed only to the browser that made the request, via
 *     a claim token that browser alone holds. Approving a request never emits
 *     anything the approver could paste somewhere else by mistake.
 *   • Asking about an account that does not exist behaves identically to asking
 *     about one that does, so the screen cannot be used to discover usernames.
 *   • Requests are rate limited per account and per address, so nobody can bury
 *     an administrator in approvals or grind through a list of names.
 *   • Approvals expire quickly and are single use, and completing one revokes
 *     every existing session for that account.
 */
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { Request } from 'express';
import { getDb } from '../db/database.js';
import { checkPassword } from '../../shared/constants/credentials.js';
import { resolvePermission } from './permissionResolver.js';

/** How long an approval stays usable. Long enough to walk back to a bench. */
export const APPROVAL_TTL_MINUTES = 30;
/** How long an unanswered request waits before it lapses. */
export const REQUEST_TTL_MINUTES = 120;
/** Most requests one account may raise per hour. */
const MAX_PER_USERNAME_PER_HOUR = 3;
/** Most requests one address may raise per hour, across all accounts. */
const MAX_PER_ADDRESS_PER_HOUR = 10;

export const MIN_PASSWORD_LENGTH = 8;

export type ResetStatus = 'pending' | 'approved' | 'denied' | 'completed' | 'expired' | 'cancelled';

export type ResetRequestRow = {
  id: number;
  user_id: number | null;
  requested_username: string;
  claim_token: string;
  reset_token: string | null;
  status: ResetStatus;
  origin: string;
  reason: string | null;
  ip_address: string | null;
  device_id: string | null;
  decided_by_user_id: number | null;
  decision_note: string | null;
  decided_at: string | null;
  completed_at: string | null;
  expires_at: string;
  created_at: string;
};

const token = () => crypto.randomBytes(32).toString('hex');
const inMinutes = (n: number) => new Date(Date.now() + n * 60_000).toISOString();

/** Lapse anything nobody got to in time. Cheap, so it runs before every read. */
export function expireStale(): void {
  getDb().prepare(
    "UPDATE password_reset_requests SET status = 'expired' WHERE status IN ('pending','approved') AND expires_at < ?"
  ).run(new Date().toISOString());
}

/**
 * Raise a request. Always succeeds from the caller's point of view — an unknown
 * username produces a request that simply never finds an approver — so the
 * response says nothing about whether the account is real.
 */
export function createRequest(req: Request, username: string, reason?: string): { claimToken: string; throttled: boolean } {
  const db = getDb();
  expireStale();

  const name = String(username).trim();
  const hourAgo = new Date(Date.now() - 60 * 60_000).toISOString();
  const ip = req.ip ?? null;

  const perName = (db.prepare('SELECT COUNT(*) c FROM password_reset_requests WHERE requested_username = ? COLLATE NOCASE AND created_at > ?')
    .get(name, hourAgo) as { c: number }).c;
  const perAddress = ip
    ? (db.prepare('SELECT COUNT(*) c FROM password_reset_requests WHERE ip_address = ? AND created_at > ?').get(ip, hourAgo) as { c: number }).c
    : 0;

  // Throttled callers still receive a claim token that behaves normally; it
  // just never becomes approvable. Refusing outright would tell an attacker
  // their probing had been noticed.
  const throttled = perName >= MAX_PER_USERNAME_PER_HOUR || perAddress >= MAX_PER_ADDRESS_PER_HOUR;

  const user = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE AND is_active = 1').get(name) as { id: number } | undefined;
  const claimToken = token();

  db.prepare(`INSERT INTO password_reset_requests
      (user_id, requested_username, claim_token, status, origin, reason, ip_address, device_id, expires_at)
      VALUES (?, ?, ?, ?, 'user', ?, ?, ?, ?)`)
    .run(
      throttled ? null : (user?.id ?? null),
      name,
      claimToken,
      throttled ? 'cancelled' : 'pending',
      reason ? String(reason).slice(0, 500) : null,
      ip,
      (req.headers['x-device-id'] as string) ?? null,
      inMinutes(REQUEST_TTL_MINUTES),
    );

  return { claimToken, throttled };
}

/**
 * What the waiting browser is told. Only the holder of the claim token learns
 * anything, and only about their own request.
 */
export function statusForClaim(claimToken: string): { status: ResetStatus | 'unknown'; resetToken?: string; fullName?: string; note?: string } {
  const db = getDb();
  expireStale();
  const row = db.prepare('SELECT * FROM password_reset_requests WHERE claim_token = ?').get(claimToken) as ResetRequestRow | undefined;
  if (!row) return { status: 'unknown' };

  // A request that was throttled, or was for an account that does not exist,
  // reports "pending" for its lifetime and then lapses — indistinguishable
  // from a genuine request an administrator has not yet reached.
  if (row.status === 'cancelled' || (row.status === 'pending' && !row.user_id)) return { status: 'pending' };

  if (row.status === 'approved' && row.reset_token) {
    const user = row.user_id ? db.prepare('SELECT full_name FROM users WHERE id = ?').get(row.user_id) as { full_name: string } | undefined : undefined;
    return { status: 'approved', resetToken: row.reset_token, fullName: user?.full_name };
  }
  return { status: row.status, note: row.decision_note ?? undefined };
}

/** Approve or refuse, as an administrator. Returns the updated row. */
export function decideRequest(
  requestId: number,
  decision: 'approve' | 'deny',
  deciderUserId: number,
  note?: string,
): ResetRequestRow | null {
  const db = getDb();
  expireStale();
  const row = db.prepare('SELECT * FROM password_reset_requests WHERE id = ?').get(requestId) as ResetRequestRow | undefined;
  if (!row || row.status !== 'pending' || !row.user_id) return null;

  if (decision === 'deny') {
    db.prepare("UPDATE password_reset_requests SET status = 'denied', decided_by_user_id = ?, decision_note = ?, decided_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(deciderUserId, note ?? null, requestId);
  } else {
    db.prepare(`UPDATE password_reset_requests
        SET status = 'approved', reset_token = ?, decided_by_user_id = ?, decision_note = ?,
            decided_at = CURRENT_TIMESTAMP, expires_at = ?
        WHERE id = ?`)
      .run(token(), deciderUserId, note ?? null, inMinutes(APPROVAL_TTL_MINUTES), requestId);
  }
  return db.prepare('SELECT * FROM password_reset_requests WHERE id = ?').get(requestId) as ResetRequestRow;
}

/**
 * Spend an approval and set the new password. Single use: the token is cleared
 * as part of the same transaction that changes the password, so a replay finds
 * nothing. Every session for the account is revoked, including any an intruder
 * may already hold.
 */
export function completeReset(resetToken: string, newPassword: string): { ok: true; userId: number; username: string } | { ok: false; error: string } {
  const db = getDb();
  expireStale();
  const quality = checkPassword(String(newPassword ?? ''));
  if (!quality.ok) return { ok: false, error: quality.error! };
  const row = db.prepare("SELECT * FROM password_reset_requests WHERE reset_token = ? AND status = 'approved'").get(resetToken) as ResetRequestRow | undefined;
  if (!row || !row.user_id) return { ok: false, error: 'This reset link is no longer valid. Ask an administrator to approve a new request.' };
  if (new Date(row.expires_at).getTime() < Date.now()) return { ok: false, error: 'This approval has expired. Ask an administrator to approve a new request.' };

  const user = db.prepare('SELECT id, username, password_hash FROM users WHERE id = ? AND is_active = 1').get(row.user_id) as
    { id: number; username: string; password_hash: string } | undefined;
  if (!user) return { ok: false, error: 'That account is no longer active.' };
  if (bcrypt.compareSync(String(newPassword), user.password_hash)) {
    return { ok: false, error: 'Choose a password you have not used before on this account.' };
  }

  const tx = db.transaction(() => {
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(bcrypt.hashSync(String(newPassword), 12), user.id);
    db.prepare("UPDATE password_reset_requests SET status = 'completed', reset_token = NULL, completed_at = CURRENT_TIMESTAMP WHERE id = ?").run(row.id);
    // Any other request outstanding for this account is now moot.
    db.prepare("UPDATE password_reset_requests SET status = 'cancelled' WHERE user_id = ? AND status IN ('pending','approved') AND id != ?").run(user.id, row.id);
    db.prepare('UPDATE auth_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = ? AND revoked_at IS NULL').run(user.id);
  });
  tx();
  return { ok: true, userId: user.id, username: user.username };
}

/** Requests an administrator needs to look at, newest first. */
export function pendingRequests(): Array<ResetRequestRow & { full_name: string | null; role_name: string | null }> {
  expireStale();
  return getDb().prepare(`
    SELECT r.*, u.full_name, ro.name AS role_name
    FROM password_reset_requests r
    JOIN users u ON u.id = r.user_id
    LEFT JOIN roles ro ON ro.id = u.role_id
    WHERE r.status = 'pending'
    ORDER BY r.created_at DESC`).all() as never;
}

/** Recent decisions, so an administrator can see what they have just done. */
export function recentRequests(limit = 25): Array<ResetRequestRow & { full_name: string | null; decided_by: string | null }> {
  expireStale();
  return getDb().prepare(`
    SELECT r.*, u.full_name, d.username AS decided_by
    FROM password_reset_requests r
    LEFT JOIN users u ON u.id = r.user_id
    LEFT JOIN users d ON d.id = r.decided_by_user_id
    WHERE r.status != 'pending' AND r.user_id IS NOT NULL
    ORDER BY COALESCE(r.decided_at, r.created_at) DESC
    LIMIT ?`).all(limit) as never;
}

/**
 * Raise a notification for every administrator who can act on this.
 * Targeted by permission rather than by role name, so a laboratory that has
 * delegated account administration still gets told.
 */
export function notifyApprovers(requestId: number, username: string, fullName: string | null): void {
  const db = getDb();
  const candidates = db.prepare('SELECT id FROM users WHERE is_active = 1').all() as { id: number }[];
  const approvers = candidates.filter(u => resolvePermission(u.id, 'settings', 'edit').allowed);
  if (approvers.length === 0) return;

  const stmt = db.prepare(`INSERT INTO notifications
      (notification_number, user_id, module_key, title, message, status, severity, notification_type,
       record_type, record_id, assigned_to_user_id, action_url, action_label, created_by)
      VALUES (?, ?, 'settings', ?, ?, 'unread', 'high', 'approval_required', 'password_reset_requests', ?, ?, ?, ?, NULL)`);
  const now = new Date();
  const stamp = `PWR-${now.toISOString().slice(0, 10).replace(/-/g, '')}-${String(requestId).padStart(4, '0')}`;
  for (const approver of approvers) {
    stmt.run(
      `${stamp}-${approver.id}`,
      approver.id,
      'Password reset requested',
      `${fullName ?? username} (${username}) has asked to reset their password. Confirm who they are before approving.`,
      String(requestId),
      approver.id,
      '/settings/people?tab=access',
      'Review request',
    );
  }
}
