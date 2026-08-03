import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getRecord, READABLE_ENTITIES } from '../_lib/cloudDb.js';
import { requireUser } from '../_lib/auth.js';

/** GET /api/cloud/record?entity=risks&uuid=... → one record (with tombstone flag). */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!requireUser(req, res)) return;
  const entity = String(req.query.entity ?? '');
  const uuid = String(req.query.uuid ?? '');
  if (!READABLE_ENTITIES.has(entity)) {
    res.status(400).json({ error: 'Unknown or unsupported entity type.' });
    return;
  }
  if (!uuid) {
    res.status(400).json({ error: 'uuid is required.' });
    return;
  }
  try {
    const row = await getRecord(entity, uuid);
    if (!row) {
      res.status(404).json({ error: 'Record not found.' });
      return;
    }
    res.status(200).json({ entity, record: row });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Cloud query failed' });
  }
}
