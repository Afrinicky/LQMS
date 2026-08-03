import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireStaff } from '../_lib/auth.js';
import { getOwnStaffRecord } from '../_lib/cloudDb.js';

/** GET /api/portal/profile → the signed-in staff member's own profile record. */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const p = requireStaff(req, res);
  if (!p) return;
  try {
    const row = await getOwnStaffRecord(p.staffId);
    res.status(200).json({ profile: row });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Lookup failed' });
  }
}
