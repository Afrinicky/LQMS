import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { getDb } from '../db/database.js';
import { requireAuth, tokenFrom } from '../middleware/auth.js';
import { audit } from '../services/auditService.js';
import { getEffectivePermissions } from '../services/permissionResolver.js';
import { createRequest, statusForClaim, completeReset, notifyApprovers } from '../services/passwordResetService.js';
import {
  lockState, openSession, recordFailure, recordSuccess, revokeAllSessions, revokeSession, setPassword,
} from '../services/credentialService.js';
const router = Router();

// One wrong answer for every kind of wrong sign-in. Saying "no such user" or
// "wrong password" would tell someone probing the system which usernames are
// real, and saying "locked" on an account that does not exist would do the same.
const REFUSED = 'Invalid username or password';

router.post('/login', (req, res) => {
  const { username, password } = req.body as { username: string; password: string };
  const name = String(username ?? '').trim();

  // A locked account is refused before the password is even checked, so
  // guessing gains nothing by continuing (validation finding VF-02).
  const lock = lockState(name);
  if (lock.locked) {
    audit(req, { action: 'login_blocked', entity: 'users', actorUserId: null, newValue: { username: name, reason: 'locked' } });
    return res.status(429).json({
      error: `Too many failed sign-in attempts. This account is locked for another ${lock.minutesRemaining} minute${lock.minutesRemaining === 1 ? '' : 's'}. ` +
        'An administrator can unlock it sooner.',
    });
  }

  const user = getDb().prepare('SELECT u.*, r.name role_name, r.is_administrator, s.full_name staff_name FROM users u JOIN roles r ON r.id = u.role_id LEFT JOIN staff s ON s.id = u.staff_id WHERE username = ? AND u.is_active = 1').get(name) as { id: number; username: string; full_name: string; role_id: number; role_name: string; is_administrator: number; password_hash: string; staff_id: number | null; staff_name: string | null; must_change_password?: number } | undefined;
  if (!user || !bcrypt.compareSync(String(password ?? ''), user.password_hash)) {
    const nowLocked = recordFailure(req, name);
    if (nowLocked.locked) {
      return res.status(429).json({
        error: `Too many failed sign-in attempts. This account is locked for ${nowLocked.minutesRemaining} minutes.`,
      });
    }
    return res.status(401).json({ error: REFUSED });
  }

  recordSuccess(req, user.id, user.username);
  const token = openSession(req, user.id);
  res.json({
    token,
    // isAdministrator is what the client uses to hide the few capabilities the
    // permission matrix does not grant. The server refuses them regardless.
    user: { id: user.id, username: user.username, fullName: user.full_name, roleId: user.role_id, roleName: user.role_name, isAdministrator: Number(user.is_administrator) === 1, staffId: user.staff_id ?? null, staffName: user.staff_name ?? null, isActive: true, mustChangePassword: user.must_change_password === 1 },
    permissions: getEffectivePermissions(user.id),
  });
});
router.get('/me', requireAuth, (req, res) => {
  const user = getDb().prepare('SELECT u.id, u.username, u.full_name fullName, u.role_id roleId, r.name roleName, r.is_administrator isAdministrator, u.staff_id staffId, s.full_name staffName, u.is_active isActive, u.must_change_password mustChangePassword FROM users u JOIN roles r ON r.id = u.role_id LEFT JOIN staff s ON s.id = u.staff_id WHERE u.id = ?').get(req.user!.id) as Record<string, unknown> | undefined;
  if (user) {
    user.mustChangePassword = user.mustChangePassword === 1;
    user.isAdministrator = Number(user.isAdministrator) === 1;
  }
  res.json({ user, permissions: getEffectivePermissions(req.user!.id) });
});

// The caller's effective permissions on their own. The client hides every
// feature that is absent from this map, so it is refreshed whenever the app
// regains focus and after any change that could alter a user's rights.
router.get('/permissions', requireAuth, (req, res) => {
  res.json({ permissions: getEffectivePermissions(req.user!.id) });
});
router.post('/logout', requireAuth, (req, res) => {
  const token = tokenFrom(req);
  if (token) revokeSession(token);
  audit(req, { action: 'logout', entity: 'users', entityId: req.user!.id, newValue: { username: req.user!.username } });
  res.json({ ok: true });
});

// Self-service password change. Any signed-in user (staff or admin) can set a
// new password after confirming their current one — this is how staff take over
// the temporary password an administrator gave them. All other sessions for the
// account are revoked so a leaked temporary password cannot linger.
router.post('/change-password', requireAuth, (req, res) => {
  const { currentPassword, newPassword } = (req.body ?? {}) as { currentPassword?: string; newPassword?: string };
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Current and new passwords are required.' });
  if (currentPassword === newPassword) return res.status(400).json({ error: 'The new password must be different from the current one.' });
  const db = getDb();
  const user = db.prepare('SELECT id, password_hash FROM users WHERE id = ? AND is_active = 1').get(req.user!.id) as { id: number; password_hash: string } | undefined;
  if (!user || !bcrypt.compareSync(currentPassword, user.password_hash)) return res.status(400).json({ error: 'Your current password is incorrect.' });

  const applied = setPassword(user.id, String(newPassword));
  if (!applied.ok) return res.status(400).json({ error: applied.error });

  // Revoke every other active session; the caller's current session stays valid.
  revokeAllSessions(user.id, tokenFrom(req));
  audit(req, { action: 'change_password', entity: 'users', entityId: user.id });
  res.json({ ok: true });
});

/* ============================================================================
   Forgotten password — the sign-in screen half.
   These three are deliberately unauthenticated: the whole point is that the
   person cannot get in. Everything that makes them safe lives in
   passwordResetService — see the note at the top of that file.
   ========================================================================= */

// Ask for a reset. Always answers the same way, whether or not the account
// exists, so this cannot be used to find out which usernames are real.
router.post('/password-reset/request', (req, res) => {
  const { username, reason } = (req.body ?? {}) as { username?: string; reason?: string };
  if (!username || !String(username).trim()) return res.status(400).json({ error: 'Enter your username.' });

  const { claimToken, throttled } = createRequest(req, username, reason);
  if (!throttled) {
    const db = getDb();
    const user = db.prepare('SELECT id, full_name FROM users WHERE username = ? COLLATE NOCASE AND is_active = 1')
      .get(String(username).trim()) as { id: number; full_name: string } | undefined;
    if (user) {
      const row = db.prepare('SELECT id FROM password_reset_requests WHERE claim_token = ?').get(claimToken) as { id: number };
      notifyApprovers(row.id, String(username).trim(), user.full_name);
    }
  }
  getDb().prepare('INSERT INTO audit_logs (actor_user_id, action, entity, entity_id, new_value, ip_address) VALUES (NULL, ?, ?, ?, ?, ?)')
    .run('password_reset_requested', 'password_reset_requests', null, JSON.stringify({ username: String(username).trim(), throttled }), req.ip ?? null);

  res.json({ claimToken, status: 'pending' });
});

// Poll the decision. Answers only the browser holding the claim token.
router.get('/password-reset/status', (req, res) => {
  const claim = String(req.query.claim ?? '');
  if (!claim) return res.status(400).json({ error: 'Missing claim.' });
  res.json(statusForClaim(claim));
});

// Spend an approval and set the new password.
router.post('/password-reset/complete', (req, res) => {
  const { resetToken, newPassword } = (req.body ?? {}) as { resetToken?: string; newPassword?: string };
  if (!resetToken) return res.status(400).json({ error: 'Missing reset token.' });
  const result = completeReset(resetToken, String(newPassword ?? ''));
  if (result.ok !== true) return res.status(400).json({ error: result.error });
  getDb().prepare('INSERT INTO audit_logs (actor_user_id, action, entity, entity_id, new_value, ip_address) VALUES (?, ?, ?, ?, ?, ?)')
    .run(result.userId, 'password_reset_completed', 'users', String(result.userId), JSON.stringify({ username: result.username }), req.ip ?? null);
  res.json({ ok: true });
});

export default router;
