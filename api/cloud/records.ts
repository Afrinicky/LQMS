import type { VercelRequest, VercelResponse } from '@vercel/node';
import { listRecords, READABLE_ENTITIES } from '../_lib/cloudDb.js';
import { requireToken } from '../_lib/auth.js';

/** GET /api/cloud/records?entity=risks&limit=&offset= → live records of a type. */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!requireToken(req, res)) return;
  const entity = String(req.query.entity ?? '');
  if (!READABLE_ENTITIES.has(entity)) {
    res.status(400).json({ error: 'Unknown or unsupported entity type.' });
    return;
  }
  const limit = Number(req.query.limit ?? 200);
  const offset = Number(req.query.offset ?? 0);
  try {
    const rows = await listRecords(entity, Number.isFinite(limit) ? limit : 200, Number.isFinite(offset) ? offset : 0);
    res.status(200).json({ entity, records: rows });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Cloud query failed' });
  }
}
