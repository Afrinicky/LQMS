import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireStaff } from '../_lib/auth.js';
import { getAssignedTasks } from '../_lib/cloudDb.js';

/** GET /api/portal/my-tasks → actions assigned to the signed-in staff member. */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const p = requireStaff(req, res);
  if (!p) return;
  try {
    res.status(200).json({ tasks: await getAssignedTasks(p.staffId) });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Lookup failed' });
  }
}
