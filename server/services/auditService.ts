import { getDb } from '../db/database.js';
import type { Request } from 'express';

export function audit(req: Request | undefined, entry: { action: string; entity: string; entityId?: string | number; oldValue?: unknown; newValue?: unknown }) {
  const actor = req?.user?.id ?? null;
  getDb().prepare('INSERT INTO audit_logs (actor_user_id, action, entity, entity_id, old_value, new_value, ip_address, device_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(actor, entry.action, entry.entity, entry.entityId ? String(entry.entityId) : null, entry.oldValue ? JSON.stringify(entry.oldValue) : null, entry.newValue ? JSON.stringify(entry.newValue) : null, req?.ip ?? null, req?.headers['x-device-id'] ?? null);
}
