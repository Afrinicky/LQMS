/**
 * Electronic-signature API (Phase 2).
 *
 * Staff upload their signature ONCE (`POST /me`); it is stored on their staff
 * record and reused for every electronic signing across the system in place of
 * drawing one each time. Signing endpoints (approvals, forms, declarations,
 * acknowledgements) go through signatureService, which automatically attaches
 * the signer's signature on file — so a signature set here reflects on the Host
 * and everywhere signatures are shown.
 *
 *   GET  /api/signatures/me                  → do I have a signature on file?
 *   POST /api/signatures/me                  → upload/replace my signature (image)
 *   GET  /api/signatures/me/image            → my signature image
 *   GET  /api/signatures/staff/:id/image     → a staff member's signature image
 *   POST /api/signatures                     → record a signature on a record
 *   GET  /api/signatures/:module/:type/:id   → signatures on a record
 */
import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { requireAuth } from '../middleware/auth.js';
import { getDb, uploadRoot, evidenceRoot } from '../db/database.js';
import { audit } from '../services/auditService.js';
import { safeStoredFilename } from '../utils/safeFilename.js';
import { recordSignature, signaturesFor } from '../services/signatureService.js';
import { requireCurrentStaffId } from './routeHelpers.js';

const upload = multer({
  storage: multer.diskStorage({ destination: (_req, _file, cb) => cb(null, uploadRoot), filename: (_req, file, cb) => cb(null, safeStoredFilename(file.originalname)) }),
  limits: { fileSize: 5 * 1024 * 1024 },
});

function streamFile(res: import('express').Response, fileId: number | null | undefined): boolean {
  if (!fileId) return false;
  const file = getDb().prepare('SELECT stored_name, mime_type, storage_area FROM files WHERE id = ?').get(fileId) as { stored_name: string; mime_type: string; storage_area: string } | undefined;
  if (!file) return false;
  const root = file.storage_area === 'evidence' ? evidenceRoot : uploadRoot;
  const fp = path.join(root, file.stored_name);
  if (!fs.existsSync(fp)) return false;
  res.setHeader('Content-Type', file.mime_type || 'image/png');
  res.setHeader('Cache-Control', 'private, max-age=60');
  fs.createReadStream(fp).pipe(res);
  return true;
}

export function signatureRoutes() {
  const router = Router();

  // ── Signature on file (uploaded once, reused everywhere) ──
  router.get('/me', requireAuth, (req, res) => {
    const staffId = req.user?.staffId ?? null;
    if (!staffId) return res.json({ hasSignature: false, fileId: null, staffLinked: false });
    const row = getDb().prepare('SELECT signature_file_id FROM staff WHERE id = ?').get(staffId) as { signature_file_id?: number | null } | undefined;
    res.json({ hasSignature: Boolean(row?.signature_file_id), fileId: row?.signature_file_id ?? null, staffLinked: true });
  });

  router.post('/me', requireAuth, upload.single('file'), (req, res) => {
    let staffId: number;
    try { staffId = requireCurrentStaffId(req); } catch (e) { return res.status(400).json({ error: (e as Error).message }); }
    if (!req.file) return res.status(400).json({ error: 'No signature image uploaded' });
    if (!/^image\//.test(req.file.mimetype)) return res.status(400).json({ error: 'The signature must be an image.' });
    const db = getDb();
    const file = db.prepare('INSERT INTO files (original_name, stored_name, mime_type, size_bytes, storage_area, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)')
      .run(req.file.originalname, path.basename(req.file.path), req.file.mimetype, req.file.size, 'uploads', req.user!.id);
    const fileId = Number(file.lastInsertRowid);
    db.prepare('UPDATE staff SET signature_file_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(fileId, staffId);
    audit(req, { action: 'set_signature', entity: 'staff', entityId: staffId, newValue: { signatureFileId: fileId } });
    res.status(201).json({ ok: true, fileId });
  });

  router.get('/me/image', requireAuth, (req, res) => {
    const staffId = req.user?.staffId ?? null;
    const row = staffId ? getDb().prepare('SELECT signature_file_id FROM staff WHERE id = ?').get(staffId) as { signature_file_id?: number } | undefined : undefined;
    if (!streamFile(res, row?.signature_file_id)) res.status(404).json({ error: 'No signature on file' });
  });

  // A staff member's signature image, so it can be shown wherever their
  // signature appears (approvals, attestations, printed records).
  router.get('/staff/:id/image', requireAuth, (req, res) => {
    const row = getDb().prepare('SELECT signature_file_id FROM staff WHERE id = ?').get(req.params.id) as { signature_file_id?: number } | undefined;
    if (!streamFile(res, row?.signature_file_id)) res.status(404).json({ error: 'No signature on file' });
  });

  // ── Record / read signatures on a record ──
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
