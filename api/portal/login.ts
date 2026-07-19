import type { VercelRequest, VercelResponse } from '@vercel/node';
import bcrypt from 'bcryptjs';
import { getUserByEmail, touchLastLogin } from '../_lib/cloudDb.js';
import { signPortalToken } from '../_lib/jwt.js';

/** POST /api/portal/login { email, password } → { token, user }. */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  const body = (req.body ?? {}) as { email?: string; password?: string };
  const email = String(body.email ?? '').trim().toLowerCase();
  const password = String(body.password ?? '');
  if (!email || !password) { res.status(400).json({ error: 'Email and password are required.' }); return; }
  try {
    const user = await getUserByEmail(email);
    // Constant-ish response: same 401 whether the user is missing, disabled, or the password is wrong.
    if (!user || user.status !== 'active' || !bcrypt.compareSync(password, user.password_hash)) {
      res.status(401).json({ error: 'Invalid email or password.' });
      return;
    }
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
