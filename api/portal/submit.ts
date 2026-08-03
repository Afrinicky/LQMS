import type { VercelRequest, VercelResponse } from '@vercel/node';
import crypto from 'node:crypto';
import { requireStaff } from '../_lib/auth.js';
import { insertSubmission } from '../_lib/cloudDb.js';
import { findActivity } from '../../shared/constants/remoteAccess.js';

/**
 * POST /api/portal/submit — queue a proposed change (R3). The actor is taken
 * from the verified JWT (never the client). The Host pulls, re-validates against
 * its authoritative permissions, and applies (or routes for approval).
 *
 * Body: { activity, targetTable?, targetUuid?, baseVersion?, payload? }
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  const p = requireStaff(req, res);
  if (!p) return;
  const body = (req.body ?? {}) as { activity?: string; targetTable?: string; targetUuid?: string; baseVersion?: string; payload?: unknown };
  const activity = String(body.activity ?? '');
  const def = findActivity(activity);
  if (!def) { res.status(400).json({ error: 'Unknown activity.' }); return; }
  try {
    const submissionUuid = crypto.randomUUID();
    await insertSubmission({
      submissionUuid,
      actorStaffId: p.staffId,
      actorEmail: p.email,
      activity,
      targetTable: body.targetTable ?? null,
      targetUuid: body.targetUuid ?? null,
      baseVersion: body.baseVersion ?? null,
      payload: body.payload ?? {},
    });
    res.status(202).json({ ok: true, submissionUuid, status: 'pending_sync', tier: def.tier });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Submission failed' });
  }
}
