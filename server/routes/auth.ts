import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { getDb } from '../db/database.js';
import { requireAuth } from '../middleware/auth.js';
import { audit } from '../services/auditService.js';
const router = Router();

// Minimum length mirrors the policy enforced when accounts are created
// (server/routes/common.ts). Keep the two in sync.
const MIN_PASSWORD_LENGTH = 8;
router.post('/login', (req, res) => {
  const { username, password } = req.body as { username: string; password: string };
  const user = getDb().prepare('SELECT u.*, r.name role_name, s.full_name staff_name FROM users u JOIN roles r ON r.id = u.role_id LEFT JOIN staff s ON s.id = u.staff_id WHERE username = ? AND u.is_active = 1').get(username) as { id: number; username: string; full_name: string; role_id: number; role_name: string; password_hash: string; staff_id: number | null; staff_name: string | null } | undefined;
  if (!user || !bcrypt.compareSync(password, user.password_hash)) return res.status(401).json({ error: 'Invalid username or password' });
  const token = crypto.randomBytes(32).toString('hex');
  getDb().prepare("INSERT INTO auth_sessions (user_id, token, device_id, ip_address, expires_at) VALUES (?, ?, ?, ?, datetime('now', '+12 hours'))").run(user.id, token, req.headers['x-device-id'] ?? null, req.ip);
  res.json({ token, user: { id: user.id, username: user.username, fullName: user.full_name, roleId: user.role_id, roleName: user.role_name, staffId: user.staff_id ?? null, staffName: user.staff_name ?? null, isActive: true } });
});
router.get('/me', requireAuth, (req, res) => {
  const user = getDb().prepare('SELECT u.id, u.username, u.full_name fullName, u.role_id roleId, r.name roleName, u.staff_id staffId, s.full_name staffName, u.is_active isActive FROM users u JOIN roles r ON r.id = u.role_id LEFT JOIN staff s ON s.id = u.staff_id WHERE u.id = ?').get(req.user!.id);
  res.json({ user });
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
  db.prepare('UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(bcrypt.hashSync(String(newPassword), 12), user.id);
  // Revoke every other active session; the caller's current session stays valid.
  db.prepare("UPDATE auth_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = ? AND revoked_at IS NULL AND token != ?").run(user.id, keepToken);
  audit(req, { action: 'change_password', entity: 'users', entityId: user.id });
  res.json({ ok: true });
});

export default router;
