import type { VercelRequest, VercelResponse } from '@vercel/node';
import bcrypt from 'bcryptjs';
import { getUserByEmail, touchLastLogin, registerFailedLogin, clearLoginAttempts } from '../_lib/cloudDb.js';
import { signPortalToken } from '../_lib/jwt.js';

const MAX_ATTEMPTS = 5;
const LOCK_MS = 15 * 60 * 1000;

/** POST /api/portal/login { email, password } → { token, user }. Rate-limited. */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  const body = (req.body ?? {}) as { email?: string; password?: string };
  const email = String(body.email ?? '').trim().toLowerCase();
  const password = String(body.password ?? '');
  if (!email || !password) { res.status(400).json({ error: 'Email and password are required.' }); return; }
  try {
    const user = await getUserByEmail(email);
    // Lockout after too many failures (durable, per-account).
    if (user && user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
      res.status(429).json({ error: 'Account temporarily locked after repeated failed attempts. Try again later.' });
      return;
    }
    if (!user || user.status !== 'active' || !bcrypt.compareSync(password, user.password_hash)) {
      // Count failures against a real, active account (uniform 401 either way).
      if (user && user.status === 'active') await registerFailedLogin(user.id, MAX_ATTEMPTS, LOCK_MS);
      res.status(401).json({ error: 'Invalid email or password.' });
      return;
    }
    await clearLoginAttempts(user.id);
    const token = signPortalToken({
      sub: String(user.id), staffId: user.staff_id, email: user.email, role: user.role, scope: user.remote_scope ?? null,
    });
    await touchLastLogin(user.id);
    res.status(200).json({
      token,
      user: { email: user.email, fullName: user.full_name, role: user.role, mustChangePassword: user.must_change_password },
      capabilities: user.remote_scope ?? null,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Login failed' });
  }
}
