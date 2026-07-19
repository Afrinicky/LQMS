import type { VercelRequest, VercelResponse } from '@vercel/node';
import { summary } from '../_lib/cloudDb.js';
import { requireToken } from '../_lib/auth.js';

/** GET /api/cloud/summary → live record counts per entity type. */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!requireToken(req, res)) return;
  try {
    res.status(200).json({ entities: await summary() });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Cloud query failed' });
  }
}
