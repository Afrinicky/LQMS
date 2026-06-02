import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { getDb } from '../db/database.js';
import { requireAuth } from '../middleware/auth.js';
const router = Router();
router.post('/login', (req, res) => {
  const { username, password } = req.body as { username: string; password: string };
  const user = getDb().prepare('SELECT u.*, r.name role_name FROM users u JOIN roles r ON r.id = u.role_id WHERE username = ? AND u.is_active = 1').get(username) as { id: number; username: string; full_name: string; role_id: number; role_name: string; password_hash: string } | undefined;
  if (!user || !bcrypt.compareSync(password, user.password_hash)) return res.status(401).json({ error: 'Invalid username or password' });
  const token = crypto.randomBytes(32).toString('hex');
  getDb().prepare("INSERT INTO auth_sessions (user_id, token, device_id, ip_address, expires_at) VALUES (?, ?, ?, ?, datetime('now', '+12 hours'))").run(user.id, token, req.headers['x-device-id'] ?? null, req.ip);
  res.json({ token, user: { id: user.id, username: user.username, fullName: user.full_name, roleId: user.role_id, roleName: user.role_name, isActive: true } });
});
router.get('/me', requireAuth, (req, res) => {
  const user = getDb().prepare('SELECT u.id, u.username, u.full_name fullName, u.role_id roleId, r.name roleName, u.is_active isActive FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?').get(req.user!.id);
  res.json({ user });
});
router.post('/logout', requireAuth, (req, res) => {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (token) getDb().prepare('UPDATE auth_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE token = ?').run(token);
  res.json({ ok: true });
});
export default router;
