/**
 * QR-code infrastructure service (Phase 2).
 *
 * Every physical or logical entity in SECH_LIMS can carry a stable QR token that
 * resolves directly to its record. The backend is complete now: tokens are
 * minted, stored and resolvable. When a secure (HTTPS) camera context becomes
 * available — via Cloudflare Tunnel or the native app — scanning works
 * immediately with no backend change.
 *
 * A token is opaque and stable per entity: minting the same (type, id) twice
 * returns the existing token, so printed labels never break.
 */
import crypto from 'node:crypto';
import { getDb } from '../db/database.js';

// Entity types that can be tagged. Each maps to the module + client route the
// resolver points at.
export const QR_ENTITY_TYPES = [
  'equipment', 'reagent', 'inventory_item', 'storage_location', 'room',
  'environmental_point', 'maintenance_record', 'location',
] as const;
export type QrEntityType = (typeof QR_ENTITY_TYPES)[number];

// Where a scanned token resolves inside the apps. `deep` is the mobile route.
const ENTITY_RESOLUTION: Record<string, { module: string; deep: string; table?: string; labelExpr?: string }> = {
  equipment: { module: 'equipment', deep: '/m/equipment', table: 'equipment_items', labelExpr: "name || ' · ' || equipment_number" },
  reagent: { module: 'supplier_inventory', deep: '/m/inventory', table: 'inventory_items', labelExpr: 'name' },
  inventory_item: { module: 'supplier_inventory', deep: '/m/inventory', table: 'inventory_items', labelExpr: 'name' },
  storage_location: { module: 'organisation', deep: '/m/locations', table: 'locations', labelExpr: 'name' },
  location: { module: 'organisation', deep: '/m/locations', table: 'locations', labelExpr: 'name' },
  room: { module: 'organisation', deep: '/m/locations', table: 'locations', labelExpr: 'name' },
  environmental_point: { module: 'monitoring', deep: '/m/environmental', table: 'monitoring_items', labelExpr: 'name' },
  maintenance_record: { module: 'equipment', deep: '/m/equipment', table: 'equipment_maintenance_records' },
};

/** The module a taggable entity type belongs to, for permission checks. */
export function moduleForEntityType(entityType: string): string | null {
  return ENTITY_RESOLUTION[entityType]?.module ?? null;
}

/** The module a scanned token points at, for permission checks. */
export function moduleForToken(token: string): string | null {
  const qr = getDb().prepare('SELECT entity_type FROM qr_codes WHERE token = ? AND is_active = 1').get(token) as { entity_type: string } | undefined;
  return qr ? moduleForEntityType(qr.entity_type) : null;
}

function newToken(): string {
  // 16 bytes → 22-char url-safe token. Prefixed so tokens are visually distinct.
  return 'SQ' + crypto.randomBytes(16).toString('base64url');
}

export interface QrCode {
  id: number;
  token: string;
  entity_type: string;
  entity_id: string;
  label: string | null;
  is_active: number;
}

/** Return the existing QR for an entity, or mint one. Idempotent per entity. */
export function ensureQrForEntity(entityType: string, entityId: string | number, userId?: number | null, label?: string | null): QrCode {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM qr_codes WHERE entity_type = ? AND entity_id = ?').get(entityType, String(entityId)) as QrCode | undefined;
  if (existing) return existing;
  let resolvedLabel = label ?? null;
  const cfg = ENTITY_RESOLUTION[entityType];
  if (!resolvedLabel && cfg?.table && cfg.labelExpr) {
    try {
      const row = db.prepare(`SELECT ${cfg.labelExpr} AS label FROM ${cfg.table} WHERE id = ?`).get(entityId) as { label?: string } | undefined;
      resolvedLabel = row?.label ?? null;
    } catch { /* label is best-effort */ }
  }
  // Retry on the very unlikely token collision.
  for (let attempt = 0; attempt < 4; attempt++) {
    const token = newToken();
    try {
      const result = db.prepare('INSERT INTO qr_codes (token, entity_type, entity_id, label, created_by) VALUES (?, ?, ?, ?, ?)')
        .run(token, entityType, String(entityId), resolvedLabel, userId ?? null);
      return db.prepare('SELECT * FROM qr_codes WHERE id = ?').get(Number(result.lastInsertRowid)) as QrCode;
    } catch (e) {
      // UNIQUE(entity_type, entity_id) race → return the row that won.
      const again = db.prepare('SELECT * FROM qr_codes WHERE entity_type = ? AND entity_id = ?').get(entityType, String(entityId)) as QrCode | undefined;
      if (again) return again;
      if (attempt === 3) throw e;
    }
  }
  throw new Error('Could not mint QR token');
}

/** Resolve a scanned token to its entity and the route that opens it. */
export function resolveToken(token: string) {
  const db = getDb();
  const qr = db.prepare('SELECT * FROM qr_codes WHERE token = ? AND is_active = 1').get(token) as QrCode | undefined;
  if (!qr) return null;
  const cfg = ENTITY_RESOLUTION[qr.entity_type];
  let record: unknown = null;
  if (cfg?.table) {
    try { record = db.prepare(`SELECT * FROM ${cfg.table} WHERE id = ?`).get(qr.entity_id) ?? null; } catch { record = null; }
  }
  return {
    token: qr.token,
    entityType: qr.entity_type,
    entityId: qr.entity_id,
    label: qr.label,
    module: cfg?.module ?? null,
    deepLink: cfg ? `${cfg.deep}/${qr.entity_id}` : null,
    record,
  };
}

/** Bulk-mint QR tokens for every row of a taggable entity type. */
export function ensureQrForAll(entityType: string, userId?: number | null): { entityType: string; created: number; total: number } {
  const db = getDb();
  const cfg = ENTITY_RESOLUTION[entityType];
  if (!cfg?.table) return { entityType, created: 0, total: 0 };
  const rows = db.prepare(`SELECT id FROM ${cfg.table}`).all() as Array<{ id: number }>;
  let created = 0;
  for (const r of rows) {
    const before = db.prepare('SELECT 1 FROM qr_codes WHERE entity_type = ? AND entity_id = ?').get(entityType, String(r.id));
    ensureQrForEntity(entityType, r.id, userId);
    if (!before) created++;
  }
  return { entityType, created, total: rows.length };
}
