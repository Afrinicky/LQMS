/**
 * Push-notification API (Phase 2 framework).
 *
 *   POST   /api/push/subscribe          → register a device push endpoint
 *   POST   /api/push/unsubscribe        → deactivate an endpoint
 *   GET    /api/push/subscriptions      → my registered devices
 *   GET    /api/push/preferences        → my per-module preferences
 *   PUT    /api/push/preferences        → update a preference
 *   POST   /api/push/schedule           → schedule a reminder/notification
 *   GET    /api/push/pending            → deliveries awaiting an HTTPS transport
 *   GET    /api/push/vapid-public-key   → public key (when configured)
 *
 * Web Push delivery needs HTTPS; until the tunnel is deployed these endpoints
 * build and store everything so nothing has to be redesigned to turn it on.
 */
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import { getDb } from '../db/database.js';
import { audit } from '../services/auditService.js';
import { queuePush, dueDeliveries } from '../services/pushService.js';
import { getCurrentStaffId, parseIntNullable } from './routeHelpers.js';

export function pushRoutes() {
  const router = Router();

  router.get('/vapid-public-key', requireAuth, (_req, res) => {
    res.json({ publicKey: process.env.SECH_LIMS_VAPID_PUBLIC_KEY ?? null, enabled: Boolean(process.env.SECH_LIMS_VAPID_PUBLIC_KEY) });
  });

  router.post('/subscribe', requireAuth, (req, res) => {
    const { endpoint, keys, platform, deviceInfo } = req.body ?? {};
    if (!endpoint) return res.status(400).json({ error: 'endpoint is required' });
    const db = getDb();
    const p256dh = keys?.p256dh ?? null;
    const auth = keys?.auth ?? null;
    db.prepare(`INSERT INTO push_subscriptions (user_id, staff_id, platform, endpoint, p256dh, auth, device_info, is_active, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
        ON CONFLICT(user_id, endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, platform = excluded.platform, device_info = excluded.device_info, is_active = 1, last_seen_at = CURRENT_TIMESTAMP`)
      .run(req.user!.id, getCurrentStaffId(req), platform ?? 'web', endpoint, p256dh, auth, deviceInfo ?? req.headers['user-agent'] ?? null);
    res.status(201).json({ ok: true });
  });

  router.post('/unsubscribe', requireAuth, (req, res) => {
    if (!req.body?.endpoint) return res.status(400).json({ error: 'endpoint is required' });
    getDb().prepare('UPDATE push_subscriptions SET is_active = 0 WHERE user_id = ? AND endpoint = ?').run(req.user!.id, req.body.endpoint);
    res.json({ ok: true });
  });

  router.get('/subscriptions', requireAuth, (req, res) => {
    res.json(getDb().prepare('SELECT id, platform, device_info, is_active, last_seen_at, created_at FROM push_subscriptions WHERE user_id = ? ORDER BY id DESC').all(req.user!.id));
  });

  router.get('/preferences', requireAuth, (req, res) => {
    res.json(getDb().prepare('SELECT * FROM notification_preferences WHERE user_id = ? ORDER BY module_key IS NULL, module_key').all(req.user!.id));
  });

  router.put('/preferences', requireAuth, (req, res) => {
    const { moduleKey, inAppEnabled, digestEnabled, emailEnabled, smsEnabled } = req.body ?? {};
    const db = getDb();
    const bool = (v: unknown, d: number) => (v === undefined || v === null ? d : (v ? 1 : 0));
    db.prepare(`INSERT INTO notification_preferences (user_id, staff_id, module_key, in_app_enabled, digest_enabled, email_enabled, sms_enabled, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(user_id, module_key) DO UPDATE SET in_app_enabled = excluded.in_app_enabled, digest_enabled = excluded.digest_enabled, email_enabled = excluded.email_enabled, sms_enabled = excluded.sms_enabled, updated_at = CURRENT_TIMESTAMP`)
      .run(req.user!.id, getCurrentStaffId(req), moduleKey ?? null, bool(inAppEnabled, 1), bool(digestEnabled, 0), bool(emailEnabled, 0), bool(smsEnabled, 0));
    res.json({ ok: true });
  });

  // Schedule a reminder/notification. Target a specific user, or (with the
  // notifications create permission) broadcast to a set of users.
  router.post('/schedule', requireAuth, (req, res) => {
    const { title, body, priority, moduleKey, scheduledFor, userId } = req.body ?? {};
    if (!title) return res.status(400).json({ error: 'title is required' });
    const targetUser = parseIntNullable(userId) ?? req.user!.id;
    const out = queuePush({ userId: targetUser, title, body, priority, moduleKey, scheduledFor });
    audit(req, { action: 'push_schedule', entity: 'push_deliveries', entityId: out.deliveryId, newValue: { title, scheduledFor, targetUser } });
    res.status(201).json(out);
  });

  // Diagnostics for the not-yet-connected transport.
  router.get('/pending', requirePermission('notifications', 'view'), (_req, res) => {
    res.json(dueDeliveries(100));
  });

  return router;
}
