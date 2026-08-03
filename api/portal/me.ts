import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireStaff } from '../_lib/auth.js';
import { getUserById } from '../_lib/cloudDb.js';

/** GET /api/portal/me → the signed-in staff member's identity + remote capabilities. */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const p = requireStaff(req, res);
  if (!p) return;
  try {
    const user = await getUserById(p.userId);
    res.status(200).json({
      staffId: p.staffId,
      email: p.email,
      role: p.role,
      fullName: user?.full_name ?? null,
      capabilities: user?.remote_scope ?? null,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Lookup failed' });
  }
}
