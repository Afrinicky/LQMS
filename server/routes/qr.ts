/**
 * QR-code infrastructure API (Phase 2).
 *
 * Backend is complete and usable now over LAN/Tailscale; scanning goes live
 * unchanged once a secure camera context (HTTPS/native) is available.
 *
 *   GET  /api/qr/:token                 → resolve a scanned token to its record
 *   GET  /api/qr/lookup/:type/:id       → the token for an entity (mints if new)
 *   POST /api/qr/generate               → mint one token { entityType, entityId }
 *   POST /api/qr/generate-all           → bulk-mint for an entity type
 *   GET  /api/qr                        → list registered tokens
 */
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import { audit } from '../services/auditService.js';
import { getDb } from '../db/database.js';
import { ensureQrForEntity, ensureQrForAll, resolveToken, QR_ENTITY_TYPES } from '../services/qrService.js';

export function qrRoutes() {
  const router = Router();

  // List registered QR tokens (optionally filtered by entity type).
  router.get('/', requireAuth, (req, res) => {
    const db = getDb();
    const type = req.query.entityType ? String(req.query.entityType) : null;
    const rows = type
      ? db.prepare('SELECT * FROM qr_codes WHERE entity_type = ? ORDER BY id DESC').all(type)
      : db.prepare('SELECT * FROM qr_codes ORDER BY id DESC').all();
    res.json(rows);
  });

  // Resolve a scanned token → entity + deep link + record. Any authenticated
  // user may resolve; the record they then open is still RBAC-guarded.
  router.get('/:token', requireAuth, (req, res) => {
    const resolved = resolveToken(req.params.token);
    if (!resolved) return res.status(404).json({ error: 'Unknown or inactive QR code' });
    res.json(resolved);
  });

  // Fetch (or mint) the token for a specific entity — used to render/print labels.
  router.get('/lookup/:type/:id', requireAuth, (req, res) => {
    if (!QR_ENTITY_TYPES.includes(req.params.type as never)) return res.status(400).json({ error: `entityType must be one of: ${QR_ENTITY_TYPES.join(', ')}` });
    const qr = ensureQrForEntity(req.params.type, req.params.id, req.user!.id);
    res.json(qr);
  });

  router.post('/generate', requirePermission('organisation', 'create'), (req, res) => {
    const { entityType, entityId, label } = req.body ?? {};
    if (!QR_ENTITY_TYPES.includes(entityType)) return res.status(400).json({ error: `entityType must be one of: ${QR_ENTITY_TYPES.join(', ')}` });
    if (entityId === undefined || entityId === null || entityId === '') return res.status(400).json({ error: 'entityId is required' });
    const qr = ensureQrForEntity(entityType, entityId, req.user!.id, label ?? null);
    audit(req, { action: 'qr_generate', entity: 'qr_codes', entityId: qr.id, newValue: { entityType, entityId } });
    res.status(201).json(qr);
  });

  router.post('/generate-all', requirePermission('organisation', 'create'), (req, res) => {
    const entityType = req.body?.entityType;
    if (!QR_ENTITY_TYPES.includes(entityType)) return res.status(400).json({ error: `entityType must be one of: ${QR_ENTITY_TYPES.join(', ')}` });
    const summary = ensureQrForAll(entityType, req.user!.id);
    audit(req, { action: 'qr_generate_all', entity: 'qr_codes', newValue: summary });
    res.json(summary);
  });

  return router;
}
