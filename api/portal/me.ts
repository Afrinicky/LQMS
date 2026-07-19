import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireStaff } from '../_lib/auth.js';

/** GET /api/portal/me → the signed-in staff member's identity (from the JWT). */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const p = requireStaff(req, res);
  if (!p) return;
  res.status(200).json({ staffId: p.staffId, email: p.email, role: p.role });
}
