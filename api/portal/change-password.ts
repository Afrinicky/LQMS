import type { VercelRequest, VercelResponse } from '@vercel/node';
import bcrypt from 'bcryptjs';
import { requireStaff } from '../_lib/auth.js';
import { getUserById, updatePassword } from '../_lib/cloudDb.js';

/**
 * POST /api/portal/change-password { currentPassword, newPassword } (JWT required).
 * Used for the first-login password change (temp password) and voluntary changes.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  const p = requireStaff(req, res);
  if (!p) return;
  const body = (req.body ?? {}) as { currentPassword?: string; newPassword?: string };
  const current = String(body.currentPassword ?? '');
  const next = String(body.newPassword ?? '');
  if (next.length < 8) { res.status(400).json({ error: 'New password must be at least 8 characters.' }); return; }
  try {
    const user = await getUserById(p.userId);
    if (!user || !bcrypt.compareSync(current, user.password_hash)) {
      res.status(401).json({ error: 'Current password is incorrect.' });
      return;
    }
    await updatePassword(user.id, bcrypt.hashSync(next, 12));
    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Password change failed' });
  }
}
