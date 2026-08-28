import { Router } from 'express';
import { isAdministrator } from '../middleware/administrator.js';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { getDb } from '../db/database.js';
import { requireAuth } from '../middleware/auth.js';
import { audit } from '../services/auditService.js';
import { getEffectivePermissions } from '../services/permissionResolver.js';
import { createRequest, statusForClaim, completeReset, notifyApprovers } from '../services/passwordResetService.js';
const router = Router();

// Minimum length mirrors the policy enforced when accounts are created
// (server/routes/common.ts). Keep the two in sync.
const MIN_PASSWORD_LENGTH = 8;
router.post('/login', (req, res) => {
  const { username, password } = req.body as { username: string; password: string };
  const user = getDb().prepare('SELECT u.*, r.name role_name, r.is_administrator, s.full_name staff_name FROM users u JOIN roles r ON r.id = u.role_id LEFT JOIN staff s ON s.id = u.staff_id WHERE username = ? AND u.is_active = 1').get(username) as { id: number; username: string; full_name: string; role_id: number; role_name: string; is_administrator: number; password_hash: string; staff_id: number | null; staff_name: string | null; must_change_password?: number } | undefined;
  if (!user || !bcrypt.compareSync(password, user.password_hash)) return res.status(401).json({ error: 'Invalid username or password' });
  const token = crypto.randomBytes(32).toString('hex');
  getDb().prepare("INSERT INTO auth_sessions (user_id, token, device_id, ip_address, expires_at) VALUES (?, ?, ?, ?, datetime('now', '+12 hours'))").run(user.id, token, req.headers['x-device-id'] ?? null, req.ip);
  res.json({
    token,
    // isAdministrator is what the client uses to hide the few capabilities the
    // permission matrix does not grant. The server refuses them regardless.
    user: { id: user.id, username: user.username, fullName: user.full_name, roleId: user.role_id, roleName: user.role_name, isAdministrator: isAdministrator(user.id), staffId: user.staff_id ?? null, staffName: user.staff_name ?? null, isActive: true, mustChangePassword: user.must_change_password === 1 },
    permissions: getEffectivePermissions(user.id),
  });
});
router.get('/me', requireAuth, (req, res) => {
  const user = getDb().prepare('SELECT u.id, u.username, u.full_name fullName, u.role_id roleId, r.name roleName, r.is_administrator isAdministrator, u.staff_id staffId, s.full_name staffName, u.is_active isActive, u.must_change_password mustChangePassword FROM users u JOIN roles r ON r.id = u.role_id LEFT JOIN staff s ON s.id = u.staff_id WHERE u.id = ?').get(req.user!.id) as Record<string, unknown> | undefined;
  if (user) {
    user.mustChangePassword = user.mustChangePassword === 1;
    // Read off the access profile the user resolves to, which is what the
    // administrator gate itself asks — not off `users.role_id` directly, which
    // would disagree the moment a position mapping applied.
    user.isAdministrator = isAdministrator(Number(user.id));
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
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (token) getDb().prepare('UPDATE auth_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE token = ?').run(token);
  res.json({ ok: true });
});

// Self-service password change. Any signed-in user (staff or admin) can set a
// new password after confirming their current one — this is how staff take over
// the temporary password an administrator gave them. All other sessions for the
// account are revoked so a leaked temporary password cannot linger.
router.post('/change-password', requireAuth, (req, res) => {
  const { currentPassword, newPassword } = (req.body ?? {}) as { currentPassword?: string; newPassword?: string };
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Current and new passwords are required.' });
  if (String(newPassword).length < MIN_PASSWORD_LENGTH) return res.status(400).json({ error: `New password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
  if (currentPassword === newPassword) return res.status(400).json({ error: 'The new password must be different from the current one.' });
  const db = getDb();
  const user = db.prepare('SELECT id, password_hash FROM users WHERE id = ? AND is_active = 1').get(req.user!.id) as { id: number; password_hash: string } | undefined;
  if (!user || !bcrypt.compareSync(currentPassword, user.password_hash)) return res.status(400).json({ error: 'Your current password is incorrect.' });

  const keepToken = req.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '';
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(bcrypt.hashSync(String(newPassword), 12), user.id);
  // Revoke every other active session; the caller's current session stays valid.
  db.prepare("UPDATE auth_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = ? AND revoked_at IS NULL AND token != ?").run(user.id, keepToken);
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
