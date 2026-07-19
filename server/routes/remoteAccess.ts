/**
 * Host API for managing Remote Staff Portal accounts (R1). Settings-permission
 * gated; writes to the cloud `cloud_users` table via the provisioning service.
 * Available only when the cloud is configured (SECH_LIMS_CLOUD_URL).
 */
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { requirePermission } from '../middleware/permissions.js';
import { audit } from '../services/auditService.js';
import { cloudConfigured, provisionUser, listUsers, setStatus, refreshUser } from '../services/remoteAccess.js';

function requireCloud(_req: Request, res: Response, next: NextFunction) {
  if (!cloudConfigured()) {
    return res.status(400).json({ error: 'Cloud is not configured. Set SECH_LIMS_CLOUD_URL to enable remote staff access.' });
  }
  next();
}

export function remoteAccessRoutes() {
  const router = Router();

  router.get('/status', requirePermission('settings', 'view'), (_req, res) => {
    res.json({ cloudConfigured: cloudConfigured() });
  });

  router.get('/users', requirePermission('settings', 'view'), requireCloud, async (_req, res, next) => {
    try { res.json(await listUsers()); } catch (err) { next(err); }
  });

  router.post('/users', requirePermission('settings', 'edit'), requireCloud, async (req, res, next) => {
    try {
      const b = (req.body ?? {}) as { staffId?: number; email?: string; fullName?: string; role?: string; password?: string };
      if (!b.staffId || !b.email || !b.password) {
        return res.status(400).json({ error: 'staffId, email and password are required.' });
      }
      if (String(b.password).length < 8) {
        return res.status(400).json({ error: 'Temporary password must be at least 8 characters.' });
      }
      await provisionUser({ staffId: Number(b.staffId), email: String(b.email), fullName: b.fullName ?? null, role: b.role ?? null, password: String(b.password) });
      audit(req, { action: 'provision', entity: 'cloud_user', entityId: String(b.email), newValue: { staffId: b.staffId, email: b.email, role: b.role } });
      res.status(201).json({ ok: true });
    } catch (err) { next(err); }
  });

  router.post('/users/:id/refresh', requirePermission('settings', 'edit'), requireCloud, async (req, res, next) => {
    try {
      const caps = await refreshUser(Number(req.params.id));
      audit(req, { action: 'edit', entity: 'cloud_user', entityId: req.params.id, newValue: { refreshedScope: true } });
      res.json({ ok: true, capabilities: caps });
    } catch (err) { next(err); }
  });

  router.post('/users/:id/status', requirePermission('settings', 'edit'), requireCloud, async (req, res, next) => {
    try {
      const status = String((req.body ?? {}).status);
      if (status !== 'active' && status !== 'disabled') {
        return res.status(400).json({ error: "status must be 'active' or 'disabled'." });
      }
      await setStatus(Number(req.params.id), status);
      audit(req, { action: 'edit', entity: 'cloud_user', entityId: req.params.id, newValue: { status } });
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

  return router;
}
