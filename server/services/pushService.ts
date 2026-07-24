/**
 * Push-notification framework (Phase 2).
 *
 * Browser/native push delivery requires HTTPS, which is not yet deployed. The
 * complete framework is built now so that when a Cloudflare Tunnel (or the
 * native app) is available, delivery is switched on with no redesign:
 *
 *  - subscriptions          → push_subscriptions (per user/device endpoints)
 *  - preferences            → notification_preferences (already present)
 *  - server-side generation → queuePush() enqueues into push_deliveries
 *  - scheduling / reminders → push_deliveries.scheduled_for
 *  - retry                  → push_deliveries.attempts + status
 *
 * Until a delivery transport is wired, deliveries sit in the queue as 'pending'
 * (or 'deferred' when there is no active subscription) and the in-app
 * notification is always created so nothing is lost.
 */
import { getDb } from '../db/database.js';

export interface QueuePushInput {
  userId: number;
  title: string;
  body?: string;
  priority?: 'low' | 'normal' | 'high' | 'critical';
  moduleKey?: string;
  payload?: Record<string, unknown>;
  scheduledFor?: string;      // ISO timestamp; omit for "as soon as deliverable"
  createInApp?: boolean;      // also create an in-app notification (default true)
}

/** Respect the user's per-module in-app preference (defaults to enabled). */
function inAppEnabled(userId: number, moduleKey?: string): boolean {
  const db = getDb();
  const pref = db.prepare('SELECT in_app_enabled FROM notification_preferences WHERE user_id = ? AND (module_key = ? OR module_key IS NULL) ORDER BY module_key IS NULL LIMIT 1')
    .get(userId, moduleKey ?? null) as { in_app_enabled?: number } | undefined;
  return pref ? pref.in_app_enabled !== 0 : true;
}

/**
 * Generate a notification: creates the in-app record and enqueues a push
 * delivery. Safe to call from any module service. Returns the delivery id.
 */
export function queuePush(input: QueuePushInput): { notificationId: number | null; deliveryId: number } {
  const db = getDb();
  let notificationId: number | null = null;
  if (input.createInApp !== false && inAppEnabled(input.userId, input.moduleKey)) {
    const n = db.prepare('INSERT INTO notifications (user_id, module_key, title, message, status) VALUES (?, ?, ?, ?, ?)')
      .run(input.userId, input.moduleKey ?? 'system', input.title, input.body ?? null, 'unread');
    notificationId = Number(n.lastInsertRowid);
  }
  const hasSub = db.prepare('SELECT 1 FROM push_subscriptions WHERE user_id = ? AND is_active = 1 LIMIT 1').get(input.userId);
  const status = hasSub ? 'pending' : 'deferred';
  const d = db.prepare(`INSERT INTO push_deliveries (notification_id, user_id, title, body, priority, payload, scheduled_for, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(notificationId, input.userId, input.title, input.body ?? null, input.priority ?? 'normal',
      input.payload ? JSON.stringify(input.payload) : null, input.scheduledFor ?? null, status);
  return { notificationId, deliveryId: Number(d.lastInsertRowid) };
}

/**
 * Deliveries that are due and deliverable right now. A future HTTPS-connected
 * worker calls this, pushes over Web Push/FCM, then marks each delivered/failed.
 * Implemented now so the transport is the only remaining piece.
 */
export function dueDeliveries(limit = 50) {
  const db = getDb();
  return db.prepare(`SELECT * FROM push_deliveries
     WHERE status IN ('pending') AND (scheduled_for IS NULL OR scheduled_for <= CURRENT_TIMESTAMP)
     ORDER BY created_at LIMIT ?`).all(limit);
}

export function markDelivered(id: number) {
  getDb().prepare("UPDATE push_deliveries SET status = 'delivered', delivered_at = CURRENT_TIMESTAMP, last_attempt_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
}

export function markFailed(id: number, error: string, maxAttempts = 5) {
  const db = getDb();
  const row = db.prepare('SELECT attempts FROM push_deliveries WHERE id = ?').get(id) as { attempts?: number } | undefined;
  const attempts = (row?.attempts ?? 0) + 1;
  const status = attempts >= maxAttempts ? 'failed' : 'pending';
  db.prepare('UPDATE push_deliveries SET attempts = ?, status = ?, last_attempt_at = CURRENT_TIMESTAMP, last_error = ? WHERE id = ?')
    .run(attempts, status, error, id);
}
