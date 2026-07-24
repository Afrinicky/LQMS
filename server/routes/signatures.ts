/**
 * Electronic-signature API (Phase 2).
 *
 *   POST /api/signatures                 → record a signature on a record
 *   GET  /api/signatures/:module/:type/:id → signatures on a record
 *
 * The signature itself is captured by signatureService (identity, timestamp,
 * device, IP, audit reference). This route only exposes it; module routes that
 * already sign as part of their own workflow call the service directly.
 */
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { recordSignature, signaturesFor } from '../services/signatureService.js';

export function signatureRoutes() {
  const router = Router();

  router.post('/', requireAuth, (req, res) => {
    const { moduleKey, recordType, recordId, purpose, meaning, staffId, signatureImageFileId } = req.body ?? {};
    if (!moduleKey || !recordType || recordId === undefined || recordId === null || !purpose) {
      return res.status(400).json({ error: 'moduleKey, recordType, recordId and purpose are required' });
    }
    const sig = recordSignature(req, { moduleKey, recordType, recordId, purpose, meaning, staffId, signatureImageFileId });
    res.status(201).json(sig);
  });

  router.get('/:module/:type/:id', requireAuth, (req, res) => {
    res.json(signaturesFor(req.params.module, req.params.type, req.params.id));
  });

  return router;
}
