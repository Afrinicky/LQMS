/**
 * Analyzer Transmission & Middleware v2 control-plane API.
 *
 * This module is intentionally additive. It creates only v2-owned tables and
 * does not start listeners, change existing instrument_links, or forward data.
 * Production routing remains disabled until a route has been validated and
 * explicitly activated by a later, tested delivery-worker implementation.
 */
import { Router } from 'express';
import crypto from 'node:crypto';
import { getDb } from '../db/database.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import { audit } from '../services/auditService.js';

const MODULE = 'iqc';
const DESTINATIONS = new Set(['sechlims', 'lhims']);
const MESSAGE_KINDS = new Set(['patient', 'control', 'unknown', 'all']);
const ROUTE_STATES = new Set(['draft', 'validated', 'disabled']);

function ensureV2Schema() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS transmission_v2_routes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      route_key TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      source_link_id INTEGER NOT NULL,
      destination_key TEXT NOT NULL CHECK(destination_key IN ('sechlims','lhims')),
      message_kind TEXT NOT NULL DEFAULT 'all',
      enabled INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL DEFAULT 'draft',
      mapping_json TEXT NOT NULL DEFAULT '{}',
      config_version INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_by INTEGER,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_validation_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_transmission_v2_routes_source
      ON transmission_v2_routes(source_link_id, enabled);
    CREATE TABLE IF NOT EXISTS transmission_v2_envelopes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      envelope_uuid TEXT NOT NULL UNIQUE,
      source_link_id INTEGER NOT NULL,
      received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      protocol TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      raw_payload TEXT NOT NULL,
      parsed_json TEXT,
      message_kind TEXT NOT NULL DEFAULT 'unknown',
      sample_id TEXT,
      parser_version TEXT NOT NULL DEFAULT 'v2',
      validation_state TEXT NOT NULL DEFAULT 'pending',
      validation_detail TEXT,
      correlation_id TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(source_link_id, fingerprint)
    );
    CREATE INDEX IF NOT EXISTS idx_transmission_v2_envelopes_received
      ON transmission_v2_envelopes(received_at DESC);
    CREATE TABLE IF NOT EXISTS transmission_v2_deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      envelope_id INTEGER NOT NULL REFERENCES transmission_v2_envelopes(id),
      route_id INTEGER NOT NULL REFERENCES transmission_v2_routes(id),
      destination_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT,
      last_attempt_at TEXT,
      acknowledged_at TEXT,
      destination_reference TEXT,
      idempotency_key TEXT NOT NULL UNIQUE,
      error_code TEXT,
      error_detail TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(envelope_id, route_id)
    );
    CREATE INDEX IF NOT EXISTS idx_transmission_v2_deliveries_status
      ON transmission_v2_deliveries(status, next_attempt_at);
    CREATE TABLE IF NOT EXISTS transmission_v2_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      event_type TEXT NOT NULL,
      level TEXT NOT NULL DEFAULT 'info',
      route_id INTEGER,
      envelope_id INTEGER,
      delivery_id INTEGER,
      actor_user_id INTEGER,
      detail_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_transmission_v2_events_time
      ON transmission_v2_events(occurred_at DESC);
  `);
}

function safeJson(value: unknown) {
  if (typeof value !== 'string') return value ?? null;
  try { return JSON.parse(value); } catch { return null; }
}
function addEvent(eventType: string, level: string, detail: Record<string, unknown>, actorUserId?: number | null, routeId?: number | null) {
  getDb().prepare(`INSERT INTO transmission_v2_events(event_type,level,route_id,actor_user_id,detail_json)
    VALUES(?,?,?,?,?)`).run(eventType, level, routeId ?? null, actorUserId ?? null, JSON.stringify(detail));
}
function userId(req: any): number | null {
  const id = req.user?.id ?? req.auth?.userId ?? req.userId;
  return Number.isInteger(Number(id)) && Number(id) > 0 ? Number(id) : null;
}

export function transmissionMiddlewareV2Routes() {
  ensureV2Schema();
  const router = Router();
  router.use(requireAuth);

  router.get('/overview', requirePermission(MODULE, 'view'), (_req, res) => {
    const db = getDb();
    const routeCounts = db.prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN enabled=1 THEN 1 ELSE 0 END) AS enabled
      FROM transmission_v2_routes`).get() as any;
    const deliveryCounts = db.prepare(`SELECT
      SUM(CASE WHEN status='queued' THEN 1 ELSE 0 END) AS queued,
      SUM(CASE WHEN status='sending' THEN 1 ELSE 0 END) AS sending,
      SUM(CASE WHEN status='acknowledged' THEN 1 ELSE 0 END) AS acknowledged,
      SUM(CASE WHEN status IN ('failed_permanent','quarantined') THEN 1 ELSE 0 END) AS failed
      FROM transmission_v2_deliveries`).get() as any;
    const envelopeCounts = db.prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN validation_state='rejected' THEN 1 ELSE 0 END) AS rejected
      FROM transmission_v2_envelopes`).get() as any;
    res.json({
      version: 2,
      mode: 'control-plane-only',
      productionDeliveryEnabled: false,
      safety: 'Existing analyzer listeners and LHIMS-owned connections are not modified by v2.',
      routes: { total: Number(routeCounts?.total ?? 0), enabled: Number(routeCounts?.enabled ?? 0) },
      deliveries: Object.fromEntries(['queued','sending','acknowledged','failed'].map(k => [k, Number(deliveryCounts?.[k] ?? 0)])),
      envelopes: { total: Number(envelopeCounts?.total ?? 0), rejected: Number(envelopeCounts?.rejected ?? 0) },
    });
  });

  router.get('/routes', requirePermission(MODULE, 'view'), (_req, res) => {
    const rows = getDb().prepare(`SELECT r.*, l.name AS source_name, l.role AS source_role, l.mode AS source_mode
      FROM transmission_v2_routes r
      LEFT JOIN instrument_links l ON l.id=r.source_link_id
      ORDER BY r.updated_at DESC, r.id DESC`).all() as any[];
    res.json(rows.map(r => ({ ...r, mapping_json: safeJson(r.mapping_json), last_validation_json: safeJson(r.last_validation_json) })));
  });

  router.post('/routes', requirePermission(MODULE, 'edit'), (req, res) => {
    const b = req.body ?? {};
    const name = String(b.name ?? '').trim();
    const sourceLinkId = Number(b.sourceLinkId);
    const destinationKey = String(b.destinationKey ?? '');
    const messageKind = String(b.messageKind ?? 'all');
    if (!name || name.length > 120) return res.status(400).json({ error: 'Route name is required and must be at most 120 characters.' });
    if (!Number.isInteger(sourceLinkId) || sourceLinkId < 1) return res.status(400).json({ error: 'Choose an existing source analyzer link.' });
    if (!DESTINATIONS.has(destinationKey)) return res.status(400).json({ error: 'Unsupported destination. Choose SECHLIMS or LHIMS.' });
    if (!MESSAGE_KINDS.has(messageKind)) return res.status(400).json({ error: 'Unsupported message type filter.' });
    const db = getDb();
    const source = db.prepare('SELECT id, name, role, mode, is_active FROM instrument_links WHERE id=?').get(sourceLinkId) as any;
    if (!source) return res.status(400).json({ error: 'The selected source link does not exist.' });
    if (source.role === 'lhims_owned') {
      return res.status(409).json({ error: 'This source is marked LHIMS-owned. V2 will not take ownership or create a competing connection for it.' });
    }
    const routeKey = `route_${crypto.randomUUID()}`;
    const actor = userId(req);
    const result = db.prepare(`INSERT INTO transmission_v2_routes
      (route_key,name,source_link_id,destination_key,message_kind,enabled,state,mapping_json,created_by,updated_by)
      VALUES(?,?,?,?,?,0,'draft',?,?,?)`).run(routeKey, name, sourceLinkId, destinationKey, messageKind,
      JSON.stringify(b.mapping ?? {}), actor, actor);
    addEvent('route.created', 'info', { routeKey, name, sourceLinkId, destinationKey, messageKind, initialState: 'draft' }, actor, Number(result.lastInsertRowid));
    try { audit(req, { action: 'create', entity: 'transmission_v2_routes', entityId: Number(result.lastInsertRowid), newValue: { routeKey, name, sourceLinkId, destinationKey, messageKind } }); } catch { /* v2 event log remains available */ }
    res.status(201).json({ id: Number(result.lastInsertRowid), routeKey, state: 'draft', enabled: false, productionDeliveryEnabled: false });
  });

  router.post('/routes/:id/validate', requirePermission(MODULE, 'edit'), (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid route ID.' });
    const db = getDb();
    const route = db.prepare(`SELECT r.*, l.name AS source_name, l.role AS source_role, l.mode AS source_mode,
      l.is_active AS source_active FROM transmission_v2_routes r
      LEFT JOIN instrument_links l ON l.id=r.source_link_id WHERE r.id=?`).get(id) as any;
    if (!route) return res.status(404).json({ error: 'Route not found.' });
    const checks = [
      { key: 'source_exists', ok: Boolean(route.source_name), detail: route.source_name ? 'Source link exists.' : 'Source link is missing.' },
      { key: 'source_active', ok: Number(route.source_active) === 1, detail: Number(route.source_active) === 1 ? 'Source link is active.' : 'Source link is inactive.' },
      { key: 'source_not_lhims_owned', ok: route.source_role !== 'lhims_owned', detail: route.source_role === 'lhims_owned' ? 'LHIMS-owned sources cannot be activated by v2.' : 'Source ownership is compatible.' },
      { key: 'destination_supported', ok: DESTINATIONS.has(route.destination_key), detail: DESTINATIONS.has(route.destination_key) ? 'Destination adapter is recognized.' : 'Destination adapter is unsupported.' },
      { key: 'mapping_json', ok: Boolean(safeJson(route.mapping_json) && typeof safeJson(route.mapping_json) === 'object'), detail: 'Mapping configuration must be a JSON object.' },
    ];
    const passed = checks.every(c => c.ok);
    const validation = { checkedAt: new Date().toISOString(), passed, checks, note: 'Validation does not open connections or send clinical data.' };
    db.prepare('UPDATE transmission_v2_routes SET state=?,last_validation_json=?,updated_at=CURRENT_TIMESTAMP,updated_by=? WHERE id=?')
      .run(passed ? 'validated' : 'draft', JSON.stringify(validation), userId(req), id);
    addEvent('route.validated', passed ? 'info' : 'warn', validation, userId(req), id);
    res.json({ routeId: id, ...validation, productionDeliveryEnabled: false });
  });

  router.post('/routes/:id/disable', requirePermission(MODULE, 'edit'), (req, res) => {
    const id = Number(req.params.id);
    const db = getDb();
    const result = db.prepare(`UPDATE transmission_v2_routes SET enabled=0,state='disabled',
      updated_at=CURRENT_TIMESTAMP,updated_by=? WHERE id=?`).run(userId(req), id);
    if (!result.changes) return res.status(404).json({ error: 'Route not found.' });
    addEvent('route.disabled', 'warn', { reason: String(req.body?.reason ?? 'Disabled by administrator').slice(0, 300) }, userId(req), id);
    res.json({ ok: true, routeId: id, enabled: false });
  });

  router.get('/deliveries', requirePermission(MODULE, 'view'), (req, res) => {
    const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
    const status = typeof req.query.status === 'string' ? req.query.status : null;
    const allowed = new Set(['queued','sending','acknowledged','retry_wait','failed_permanent','quarantined','cancelled']);
    const rows = getDb().prepare(`SELECT d.id,d.envelope_id,d.route_id,d.destination_key,d.status,d.attempt_count,
      d.next_attempt_at,d.last_attempt_at,d.acknowledged_at,d.destination_reference,d.error_code,d.error_detail,
      d.created_at,d.updated_at,r.name AS route_name,e.sample_id,e.protocol,e.received_at
      FROM transmission_v2_deliveries d JOIN transmission_v2_routes r ON r.id=d.route_id
      JOIN transmission_v2_envelopes e ON e.id=d.envelope_id
      WHERE (? IS NULL OR d.status=?) ORDER BY d.updated_at DESC LIMIT ?`)
      .all(status && allowed.has(status) ? status : null, status && allowed.has(status) ? status : null, limit);
    res.json(rows);
  });

  router.get('/events', requirePermission(MODULE, 'view'), (req, res) => {
    const after = Math.max(0, Number(req.query.after) || 0);
    const limit = Math.max(1, Math.min(300, Number(req.query.limit) || 100));
    const rows = getDb().prepare(`SELECT id,occurred_at,event_type,level,route_id,envelope_id,delivery_id,actor_user_id,detail_json
      FROM transmission_v2_events WHERE id>? ORDER BY id ASC LIMIT ?`).all(after, limit) as any[];
    res.json(rows.map(r => ({ ...r, detail: safeJson(r.detail_json), detail_json: undefined })));
  });

  // Deliberately no production enqueue/send/replay/activate endpoint in this
  // first control-plane slice. The next slice must connect the durable queue to
  // bridge receive events and a destination worker, with test-destination proof.
  return router;
}
