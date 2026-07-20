import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireStaff } from '../_lib/auth.js';
import { getUserById, listApprovableSubmissions } from '../_lib/cloudDb.js';

/**
 * GET /api/portal/approvals — awaiting-approval submissions the signed-in staff
 * member is authorized to decide (based on their capability snapshot). Excludes
 * their own submissions. The Host re-validates authority before applying.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const p = requireStaff(req, res);
  if (!p) return;
  try {
    const user = await getUserById(p.userId);
    const caps = (user?.remote_scope ?? null) as { approvals?: Array<{ key: string; allowed: boolean }> } | null;
    const approvable = (caps?.approvals ?? []).filter((a) => a.allowed).map((a) => a.key);
    res.status(200).json({ approvals: await listApprovableSubmissions(approvable, p.staffId) });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Lookup failed' });
  }
}
