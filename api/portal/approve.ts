import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireStaff } from '../_lib/auth.js';
import { getUserById, getSubmissionByUuid, recordDecision } from '../_lib/cloudDb.js';

/**
 * POST /api/portal/approve { submissionUuid, decision: 'approve'|'reject', reason? }
 * Records an approver's decision. Authority is checked here for UX and
 * re-validated authoritatively on the Host before the decision is applied.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  const p = requireStaff(req, res);
  if (!p) return;
  const body = (req.body ?? {}) as { submissionUuid?: string; decision?: string; reason?: string };
  const submissionUuid = String(body.submissionUuid ?? '');
  const decision = String(body.decision ?? '');
  if (!submissionUuid || (decision !== 'approve' && decision !== 'reject')) {
    res.status(400).json({ error: 'submissionUuid and a valid decision (approve|reject) are required.' });
    return;
  }
  try {
    const sub = await getSubmissionByUuid(submissionUuid);
    if (!sub) { res.status(404).json({ error: 'Submission not found.' }); return; }
    if (sub.actor_staff_id === p.staffId) { res.status(403).json({ error: 'You cannot decide your own submission.' }); return; }
    // Portal-side authority check (Host re-checks before applying).
    const user = await getUserById(p.userId);
    const caps = (user?.remote_scope ?? null) as { approvals?: Array<{ key: string; allowed: boolean }> } | null;
    const canApprove = (caps?.approvals ?? []).some((a) => a.key === sub.activity && a.allowed);
    if (!canApprove) { res.status(403).json({ error: 'You are not authorized to approve this activity.' }); return; }

    const affected = await recordDecision(submissionUuid, decision, p.staffId, p.email, body.reason ?? null);
    if (affected === 0) { res.status(409).json({ error: 'Already decided or no longer awaiting approval.' }); return; }
    res.status(202).json({ ok: true, decision, status: 'pending_sync', message: 'Decision recorded; the Host will finalize it.' });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Decision failed' });
  }
}
