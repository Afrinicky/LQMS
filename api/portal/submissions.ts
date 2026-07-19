import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireStaff } from '../_lib/auth.js';
import { listSubmissionsForStaff } from '../_lib/cloudDb.js';

/** GET /api/portal/submissions — the signed-in staff member's own submissions. */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const p = requireStaff(req, res);
  if (!p) return;
  try {
    res.status(200).json({ submissions: await listSubmissionsForStaff(p.staffId) });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Lookup failed' });
  }
}
