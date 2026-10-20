/**
 * Analyser transmission and middleware, over HTTP.
 *
 *   GET    /middleware/overview               is transmission working?
 *   GET    /middleware/reference              the vocabulary the screens read from
 *   GET    /middleware/host                   what to type into an analyser
 *
 *   GET    /middleware/links                  analyser connections, with their middleware state
 *   GET    /middleware/links/:id/diagnostics  layered diagnostics for one link
 *
 *   GET    /middleware/destinations           the information systems we transmit to
 *   POST   /middleware/destinations           add one (configured; it carries nothing yet)
 *   PUT    /middleware/destinations/:id       change one
 *   DELETE /middleware/destinations/:id       retire one
 *   POST   /middleware/destinations/:id/test  prove it in isolation, with a test message
 *   POST   /middleware/destinations/:id/approve    approve it for activation
 *   POST   /middleware/destinations/:id/activate   activate it, after approval
 *   POST   /middleware/destinations/:id/deactivate  stand it down
 *   GET    /middleware/destinations/:id/diagnostics
 *   GET/POST /middleware/destinations/:id/mappings  field and code mappings
 *
 *   GET    /middleware/routes                 routing rules
 *   POST   /middleware/routes/preview         which rules would match this message
 *
 *   GET    /middleware/messages               the explorer
 *   GET    /middleware/messages/:id           one message, every stage of it
 *   POST   /middleware/messages/:id/reroute   route it again against current rules
 *   POST   /middleware/simulate               play a message through the engine
 *
 *   GET    /middleware/deliveries             queues and dead letters
 *   POST   /middleware/deliveries/:id/replay  authorised replay
 *   POST   /middleware/deliveries/:id/cancel
 *   POST   /middleware/deliveries/:id/send-now
 *   POST   /middleware/queue/drain            run a sweep now
 *
 *   GET/POST /middleware/discovery            authorised, scope-limited discovery
 *   GET/POST /middleware/baselines            the protected connection, read-only
 *   GET    /middleware/versions               configuration history
 *   POST   /middleware/versions/:id/rollback
 *   GET    /middleware/dennis                 what the assistant has advised
 *   POST   /middleware/dennis/ask
 *   POST   /middleware/dennis/:id/review
 *
 * Permissions are per feature, because "may read the transmission log" and "may
 * activate an interface that carries patient results" are not one decision.
 * Every protected operation is audited, and every refusal says what it refused
 * and why rather than returning a bare 403.
 */
import { Router } from 'express';
import { getDb } from '../db/database.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import { audit } from '../services/auditService.js';
import {
  ACK_POLICIES, ACK_POLICY_LABELS, ACTIVATABLE_STATES, CONNECTION_STATES, CONNECTION_STATE_LABELS,
  DELIVERY_STATES, DELIVERY_STATE_LABELS, DENNIS_TOOLS, DENNIS_TOOL_LABELS,
  DESTINATION_PLATFORMS, DESTINATION_PLATFORM_LABELS, DESTINATION_TRANSPORTS,
  DESTINATION_TRANSPORT_HINTS, DESTINATION_TRANSPORT_LABELS, DIAGNOSTIC_LAYER_LABELS,
  DISCOVERY_DEFAULT_PORTS, MESSAGE_STATUS_LABELS, PAYLOAD_FORMATS, PAYLOAD_FORMAT_LABELS,
  ROUTE_MESSAGE_KINDS, ROUTE_MESSAGE_KIND_LABELS, TRACE_STAGE_LABELS,
  deliveryIsConfirmable, routeMatches, sanitiseProtocolSample,
  type DennisTool, type RouteCriteria,
} from '../../shared/constants/middleware.js';
import { INSTRUMENT_PROFILES, LINK_STATE_LABELS } from '../../shared/constants/instruments.js';
import { getEngine } from '../services/middleware/engine.js';
import { diagnoseDestination, diagnoseLink, diagnoseSystem, lanAddresses } from '../services/middleware/diagnostics.js';
import { discoveryEndpoints, discoveryHistory, runDiscovery } from '../services/middleware/discovery.js';
import {
  captureBaseline, destinationIsEditable, endpointIsSafe, protectedEndpoints, routeIsSafe, verifyBaseline,
} from '../services/middleware/safety.js';
import { recordVersion, rollbackTo, versionHistory } from '../services/middleware/versions.js';
import { askDennisMiddleware, dennisHistory, markApplied, reviewAction } from '../services/middleware/dennis.js';
import { sealSecret, secretIsSet } from '../services/middleware/secrets.js';
import { deliver, renderPayload } from '../services/middleware/transports.js';
import { detectProtocol, effectiveProtocol, parseFor } from '../services/instrumentBridge/protocols.js';
import { mapAnalyte } from '../../shared/constants/instruments.js';

/* The features this surface is granted on. One decision each. */
const F = {
  overview: 'analyser_middleware.overview',
  discovery: 'analyser_middleware.discovery',
  configuration: 'analyser_middleware.configuration',
  diagnostics: 'analyser_middleware.diagnostics',
  queues: 'analyser_middleware.queues',
  dennis: 'analyser_middleware.dennis',
  audit: 'analyser_middleware.audit',
} as const;

const numericOnly = (req: any, _res: any, next: any) => (/^\d+$/.test(req.params.id) ? next() : next('route'));

function json<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try { return (JSON.parse(value) ?? fallback) as T; } catch { return fallback; }
}

/** A destination as the API is allowed to describe it: no credential, ever. */
function publicDestination(row: any) {
  const { secret_cipher, ...rest } = row;
  return {
    ...rest,
    secret_set: secretIsSet(secret_cipher),
    transform: json<Record<string, unknown>>(row.transform, {}),
    confirmable: deliveryIsConfirmable(row.ack_policy),
  };
}

function nextCode(db: any, table: string, column: string, prefix: string): string {
  const row = db.prepare(`SELECT ${column} AS code FROM ${table} ORDER BY id DESC LIMIT 1`).get() as any;
  const last = Number(String(row?.code ?? '').replace(/\D+/g, '')) || 0;
  return `${prefix}-${String(last + 1).padStart(4, '0')}`;
}

export function middlewareRoutes() {
  const router = Router();
  router.use(requireAuth);
  const engine = getEngine(getDb);

  /* ======================================================================
     The vocabulary, so every screen says the same words
     ==================================================================== */
  router.get('/reference', requirePermission(F.overview, 'view'), (_req, res) => {
    res.json({
      platforms: DESTINATION_PLATFORMS.map(key => ({ key, label: DESTINATION_PLATFORM_LABELS[key] })),
      transports: DESTINATION_TRANSPORTS.map(key => ({
        key, label: DESTINATION_TRANSPORT_LABELS[key], hint: DESTINATION_TRANSPORT_HINTS[key],
      })),
      payloadFormats: PAYLOAD_FORMATS.map(key => ({ key, label: PAYLOAD_FORMAT_LABELS[key] })),
      ackPolicies: ACK_POLICIES.map(key => ({ key, label: ACK_POLICY_LABELS[key] })),
      connectionStates: CONNECTION_STATES.map(key => ({ key, label: CONNECTION_STATE_LABELS[key] })),
      deliveryStates: DELIVERY_STATES.map(key => ({ key, label: DELIVERY_STATE_LABELS[key] })),
      messageKinds: ROUTE_MESSAGE_KINDS.map(key => ({ key, label: ROUTE_MESSAGE_KIND_LABELS[key] })),
      messageStatuses: MESSAGE_STATUS_LABELS,
      traceStages: TRACE_STAGE_LABELS,
      diagnosticLayers: DIAGNOSTIC_LAYER_LABELS,
      linkStates: LINK_STATE_LABELS,
      dennisTools: DENNIS_TOOLS.map(key => ({ key, label: DENNIS_TOOL_LABELS[key] })),
      profiles: INSTRUMENT_PROFILES.map(p => ({ key: p.key, label: p.label, vendor: p.vendor, protocol: p.protocol, discipline: p.discipline })),
      discoveryPorts: DISCOVERY_DEFAULT_PORTS,
      activatableStates: ACTIVATABLE_STATES,
    });
  });

  router.get('/host', requirePermission(F.overview, 'view'), (_req, res) => {
    res.json({ addresses: lanAddresses(), protectedEndpoints: protectedEndpoints(getDb()) });
  });

  /* ======================================================================
     Overview
     ==================================================================== */
  router.get('/overview', requirePermission(F.overview, 'view'), (_req, res) => {
    const db = getDb();
    const summary = engine.overview();
    const links = db.prepare(`SELECT COUNT(*) AS n,
        SUM(CASE WHEN state IN ('listening','connected','following') THEN 1 ELSE 0 END) AS running,
        SUM(CASE WHEN state = 'blocked' THEN 1 ELSE 0 END) AS blocked,
        SUM(CASE WHEN state = 'error' THEN 1 ELSE 0 END) AS failing
      FROM instrument_links WHERE is_active = 1`).get() as any;
    const baselines = db.prepare('SELECT id, label, last_verdict, last_verified_at, captured_at FROM mw_baselines ORDER BY id').all();
    const recent = db.prepare(`SELECT m.id, m.message_uid, m.received_at, m.sample_id, m.kind, m.status,
          m.result_count, l.name AS link_name
        FROM mw_messages m LEFT JOIN instrument_links l ON l.id = m.link_id
        ORDER BY m.id DESC LIMIT 10`).all();
    res.json({ ...summary, links, baselines, recent });
  });

  /* ======================================================================
     Analyser connections
     ---------------------------------------------------------------------
     The register the bridge already keeps, read through the middleware's
     eyes: what has arrived, where it went, and whether this is a link the
     engine must leave alone.
     ==================================================================== */
  router.get('/links', requirePermission(F.overview, 'view'), (_req, res) => {
    const db = getDb();
    const rows = db.prepare(`SELECT l.*, e.name AS equipment_name, s.name AS section_name,
          (SELECT COUNT(*) FROM mw_messages m WHERE m.link_id = l.id) AS middleware_messages,
          (SELECT COUNT(*) FROM mw_messages m WHERE m.link_id = l.id AND m.status = 'no_route') AS unrouted,
          (SELECT COUNT(*) FROM mw_deliveries v JOIN mw_messages m ON m.id = v.message_id
             WHERE m.link_id = l.id AND v.state IN ('queued','retrying','in_flight')) AS pending,
          (SELECT COUNT(*) FROM mw_deliveries v JOIN mw_messages m ON m.id = v.message_id
             WHERE m.link_id = l.id AND v.state = 'dead_letter') AS dead_letters,
          (SELECT COUNT(*) FROM mw_routes r WHERE r.is_active = 1 AND (r.source_link_id = l.id OR r.source_link_id IS NULL)) AS routes
        FROM instrument_links l
        LEFT JOIN equipment_items e ON e.id = l.equipment_id
        LEFT JOIN sections s ON s.id = l.section_id
        WHERE l.is_active = 1 ORDER BY l.name`).all() as any[];
    res.json(rows.map(row => ({
      ...row,
      analyte_map: json<Record<string, string>>(row.analyte_map, {}),
      control_patterns: json<string[]>(row.control_patterns, []),
      // The one thing every screen must agree about.
      engine_protected: row.role === 'lhims_owned',
    })));
  });

  router.get('/links/:id/diagnostics', numericOnly, requirePermission(F.diagnostics, 'view'), async (req, res) => {
    res.json(await diagnoseLink(getDb(), Number(req.params.id)));
  });

  /* ======================================================================
     Destinations
     ==================================================================== */
  router.get('/destinations', requirePermission(F.overview, 'view'), (_req, res) => {
    const db = getDb();
    const rows = db.prepare(`SELECT d.*, a.full_name AS approved_by_name, v.full_name AS activated_by_name,
          (SELECT COUNT(*) FROM mw_routes r WHERE r.destination_id = d.id AND r.is_active = 1) AS routes,
          (SELECT COUNT(*) FROM mw_mappings m WHERE m.destination_id = d.id AND m.is_active = 1) AS mappings,
          (SELECT COUNT(*) FROM mw_deliveries x WHERE x.destination_id = d.id AND x.state = 'delivered') AS delivered,
          (SELECT COUNT(*) FROM mw_deliveries x WHERE x.destination_id = d.id AND x.state IN ('queued','retrying','in_flight')) AS pending,
          (SELECT COUNT(*) FROM mw_deliveries x WHERE x.destination_id = d.id AND x.state = 'dead_letter') AS dead_letters
        FROM mw_destinations d
        LEFT JOIN users a ON a.id = d.approved_by
        LEFT JOIN users v ON v.id = d.activated_by
        ORDER BY d.is_protected DESC, d.name`).all() as any[];
    res.json(rows.map(publicDestination));
  });

  router.post('/destinations', requirePermission(F.configuration, 'create'), (req, res) => {
    const db = getDb();
    const body = req.body ?? {};
    const name = String(body.name ?? '').trim();
    if (!name) return res.status(400).json({ error: 'Give the destination a name.' });
    const transport = String(body.transport ?? 'hl7_mllp');
    if (!DESTINATION_TRANSPORTS.includes(transport as any)) {
      return res.status(400).json({ error: `${transport} is not a transport the engine implements.` });
    }
    const port = body.port == null || body.port === '' ? null : Number(body.port);

    // The refusal that matters, made before the row exists.
    if (port) {
      const verdict = endpointIsSafe(db, { host: body.host ?? null, port }, 'This destination');
      if (!verdict.ok) return res.status(409).json({ error: verdict.reason, endpoint: verdict.endpoint });
    }

    const code = nextCode(db, 'mw_destinations', 'dest_code', 'DEST');
    const inserted = db.prepare(`INSERT INTO mw_destinations
        (dest_code, name, platform, transport, payload_format, host, port, base_url, use_tls,
         username, secret_cipher, auth_scheme, export_dir, file_template, sending_facility,
         receiving_facility, receiving_application, ack_policy, ack_timeout_ms, retry_max,
         retry_base_ms, retry_factor, transform, state, state_detail, is_active, auto_deliver, notes, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'configured', ?, 1, ?, ?, ?)`)
      .run(code, name, String(body.platform ?? 'lis'), transport, String(body.payloadFormat ?? 'hl7v2'),
        body.host ? String(body.host) : null, port, body.baseUrl ? String(body.baseUrl) : null,
        body.useTls ? 1 : 0, body.username ? String(body.username) : null,
        sealSecret(body.secret), String(body.authScheme ?? 'none'),
        body.exportDir ? String(body.exportDir) : null, body.fileTemplate ? String(body.fileTemplate) : null,
        body.sendingFacility ? String(body.sendingFacility) : null,
        body.receivingFacility ? String(body.receivingFacility) : null,
        body.receivingApplication ? String(body.receivingApplication) : null,
        String(body.ackPolicy ?? 'protocol_ack'), Number(body.ackTimeoutMs ?? 20_000),
        Number(body.retryMax ?? 6), Number(body.retryBaseMs ?? 15_000), Number(body.retryFactor ?? 2),
        body.transform ? JSON.stringify(body.transform) : null,
        'Configured. Test it, then approve it — it carries nothing until it is activated.',
        body.autoDeliver === false ? 0 : 1, body.notes ? String(body.notes) : null, req.user!.id);

    const id = Number(inserted.lastInsertRowid);
    const row = db.prepare('SELECT * FROM mw_destinations WHERE id = ?').get(id) as any;
    const versionId = recordVersion(db, {
      scope: 'destination', entityId: id, entityCode: code, entityName: name,
      action: 'create', before: null, after: row, reason: body.reason ?? null, userId: req.user!.id,
      dennisActionId: body.dennisActionId ?? null,
    });
    if (body.dennisActionId) markApplied(db, Number(body.dennisActionId), versionId);
    audit(req, { action: 'middleware_destination_create', entity: 'mw_destinations', entityId: id, newValue: { code, name, transport } });
    res.status(201).json(publicDestination(row));
  });

  router.put('/destinations/:id', numericOnly, requirePermission(F.configuration, 'edit'), (req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const before = db.prepare('SELECT * FROM mw_destinations WHERE id = ?').get(id) as any;
    if (!before) return res.status(404).json({ error: 'That destination no longer exists.' });

    const editable = destinationIsEditable(before);
    if (!editable.ok) return res.status(409).json({ error: editable.reason });

    const body = req.body ?? {};
    const port = body.port === undefined ? before.port : (body.port == null || body.port === '' ? null : Number(body.port));
    const host = body.host === undefined ? before.host : (body.host ? String(body.host) : null);
    if (port) {
      const verdict = endpointIsSafe(db, { host, port }, 'This destination');
      if (!verdict.ok) return res.status(409).json({ error: verdict.reason, endpoint: verdict.endpoint });
    }

    const keep = (key: string, value: unknown) => (value === undefined ? before[key] : value);
    db.prepare(`UPDATE mw_destinations SET name = ?, platform = ?, transport = ?, payload_format = ?,
        host = ?, port = ?, base_url = ?, use_tls = ?, username = ?, auth_scheme = ?,
        export_dir = ?, file_template = ?, sending_facility = ?, receiving_facility = ?,
        receiving_application = ?, ack_policy = ?, ack_timeout_ms = ?, retry_max = ?,
        retry_base_ms = ?, retry_factor = ?, transform = ?, auto_deliver = ?, notes = ?,
        secret_cipher = CASE WHEN ? IS NULL THEN secret_cipher ELSE ? END,
        updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(String(keep('name', body.name)), String(keep('platform', body.platform)),
        String(keep('transport', body.transport)), String(keep('payload_format', body.payloadFormat)),
        host, port, keep('base_url', body.baseUrl), body.useTls === undefined ? before.use_tls : (body.useTls ? 1 : 0),
        keep('username', body.username), String(keep('auth_scheme', body.authScheme)),
        keep('export_dir', body.exportDir), keep('file_template', body.fileTemplate),
        keep('sending_facility', body.sendingFacility), keep('receiving_facility', body.receivingFacility),
        keep('receiving_application', body.receivingApplication),
        String(keep('ack_policy', body.ackPolicy)), Number(keep('ack_timeout_ms', body.ackTimeoutMs)),
        Number(keep('retry_max', body.retryMax)), Number(keep('retry_base_ms', body.retryBaseMs)),
        Number(keep('retry_factor', body.retryFactor)),
        body.transform === undefined ? before.transform : (body.transform ? JSON.stringify(body.transform) : null),
        body.autoDeliver === undefined ? before.auto_deliver : (body.autoDeliver ? 1 : 0),
        keep('notes', body.notes),
        body.secret ? sealSecret(body.secret) : null, body.secret ? sealSecret(body.secret) : null,
        id);

    // A destination whose settings have changed is no longer the thing that was
    // approved. It stands down to awaiting approval rather than carrying
    // clinical traffic on settings nobody has signed for.
    const changedSettings = ['transport', 'payloadFormat', 'host', 'port', 'baseUrl', 'authScheme', 'ackPolicy', 'exportDir']
      .some(key => body[key] !== undefined);
    if (changedSettings && before.state === 'active') {
      db.prepare(`UPDATE mw_destinations SET state = 'awaiting_approval', approved_by = NULL, approved_at = NULL,
          state_detail = 'Settings changed. Test and approve before activating again.' WHERE id = ?`).run(id);
    }

    const after = db.prepare('SELECT * FROM mw_destinations WHERE id = ?').get(id) as any;
    const versionId = recordVersion(db, {
      scope: 'destination', entityId: id, entityCode: before.dest_code, entityName: after.name,
      action: 'update', before, after, reason: req.body?.reason ?? null, userId: req.user!.id,
      dennisActionId: req.body?.dennisActionId ?? null,
    });
    if (req.body?.dennisActionId) markApplied(db, Number(req.body.dennisActionId), versionId);
    audit(req, { action: 'middleware_destination_update', entity: 'mw_destinations', entityId: id, oldValue: { state: before.state }, newValue: { state: after.state } });
    res.json({ ...publicDestination(after), standDown: changedSettings && before.state === 'active' });
  });

  router.delete('/destinations/:id', numericOnly, requirePermission(F.configuration, 'void_archive'), (req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const before = db.prepare('SELECT * FROM mw_destinations WHERE id = ?').get(id) as any;
    if (!before) return res.status(404).json({ error: 'That destination no longer exists.' });
    const editable = destinationIsEditable(before);
    if (!editable.ok) return res.status(409).json({ error: editable.reason });

    const pending = db.prepare("SELECT COUNT(*) AS n FROM mw_deliveries WHERE destination_id = ? AND state IN ('queued','retrying','in_flight')").get(id) as any;
    if (Number(pending?.n ?? 0)) {
      return res.status(409).json({ error: `${pending.n} delivery(ies) are still queued for this destination. Cancel or replay them before retiring it, so nothing is lost silently.` });
    }

    // Retired, not erased. The deliveries already made to it are the record of
    // results that left this laboratory, and deleting the row would take them
    // with it.
    db.prepare("UPDATE mw_destinations SET is_active = 0, state = 'disconnected', state_detail = 'Retired.', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
    db.prepare('UPDATE mw_routes SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE destination_id = ?').run(id);
    recordVersion(db, {
      scope: 'destination', entityId: id, entityCode: before.dest_code, entityName: before.name,
      action: 'delete', before, after: null, reason: req.body?.reason ?? null, userId: req.user!.id,
    });
    audit(req, { action: 'middleware_destination_retire', entity: 'mw_destinations', entityId: id, oldValue: { name: before.name } });
    res.json({ ok: true, note: 'Retired, with its routing rules switched off. Its delivery history is kept.' });
  });

  /**
   * Prove it, in isolation.
   *
   * A test message built from a fixed, obviously-synthetic sample — never a
   * patient result — carried over the real transport to the real destination.
   * It records nothing as a delivery, because it is not one, and it is the only
   * thing that establishes the difference between a reachable endpoint and one
   * that will accept a message.
   */
  router.post('/destinations/:id/test', numericOnly, requirePermission(F.diagnostics, 'create'), async (req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const destination = db.prepare('SELECT * FROM mw_destinations WHERE id = ?').get(id) as any;
    if (!destination) return res.status(404).json({ error: 'That destination no longer exists.' });
    if (destination.is_protected) {
      return res.status(409).json({ error: `${destination.name} is a protected production connection. The engine does not open connections to it, so it cannot be tested from here.` });
    }

    const sample = {
      sampleId: 'SECHLIMS-TEST-0001',
      patientId: null,
      runAt: new Date().toISOString(),
      instrument: 'SECHLIMS middleware test',
      kind: 'control',
      results: [
        { code: 'HGB', name: 'Haemoglobin', value: '12.4', unit: 'g/dL', flag: 'N' },
        { code: 'WBC', name: 'WBC', value: '6.2', unit: '10^9/L', flag: 'N' },
      ],
    };
    const controlId = `TEST-${Date.now().toString(36).toUpperCase()}`;
    const rendered = renderPayload(destination, sample, controlId, null);
    const outcome = await deliver({
      destination, message: sample, payload: rendered.payload, controlId,
      measureMap: json<Record<string, unknown>>(destination.transform, {}).measureMap as Record<string, number> ?? null,
      lhimsMapKey: json<Record<string, unknown>>(destination.transform, {}).lhimsMapKey as string ?? null,
    });

    const passed = outcome.status === 'delivered';
    db.prepare(`UPDATE mw_destinations SET last_test_at = CURRENT_TIMESTAMP, last_test_outcome = ?,
        state = CASE WHEN state IN ('configured','testing','failed') THEN ? ELSE state END,
        state_detail = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(`${outcome.status}: ${outcome.detail}`.slice(0, 500),
        passed ? 'awaiting_approval' : 'testing',
        passed
          ? 'The test message was accepted. Approve it to allow activation.'
          : `The test message was not accepted: ${outcome.detail}`.slice(0, 500),
        id);

    audit(req, { action: 'middleware_destination_test', entity: 'mw_destinations', entityId: id, newValue: { status: outcome.status } });
    res.json({
      ok: passed,
      status: outcome.status,
      detail: outcome.detail,
      ackCode: outcome.ackCode ?? null,
      ackText: outcome.ackText ?? null,
      measuredMs: outcome.measuredMs,
      landedAt: outcome.landedAt ?? null,
      payload: rendered.payload.slice(0, 8_000),
      payloadFormat: rendered.format,
      note: passed
        ? 'Accepted. This destination now awaits approval; it carries nothing until it is approved and activated.'
        : 'Not accepted. Nothing was activated.',
    });
  });

  router.post('/destinations/:id/approve', numericOnly, requirePermission(F.configuration, 'approve'), (req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const row = db.prepare('SELECT * FROM mw_destinations WHERE id = ?').get(id) as any;
    if (!row) return res.status(404).json({ error: 'That destination no longer exists.' });
    if (row.is_protected) return res.status(409).json({ error: 'A protected production connection is held read-only and is not approved from here.' });
    if (!row.last_test_at) {
      return res.status(409).json({ error: 'Test the destination first. A destination that has never exchanged a message must not be approved to carry clinical results.' });
    }
    db.prepare(`UPDATE mw_destinations SET state = 'awaiting_approval', approved_by = ?, approved_at = CURRENT_TIMESTAMP,
        state_detail = 'Approved. Activate it when the laboratory is ready.', updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(req.user!.id, id);
    const after = db.prepare('SELECT * FROM mw_destinations WHERE id = ?').get(id) as any;
    recordVersion(db, { scope: 'destination', entityId: id, entityCode: row.dest_code, entityName: row.name, action: 'approve', before: row, after, reason: req.body?.reason ?? null, userId: req.user!.id });
    audit(req, { action: 'middleware_destination_approve', entity: 'mw_destinations', entityId: id });
    res.json(publicDestination(after));
  });

  router.post('/destinations/:id/activate', numericOnly, requirePermission(F.configuration, 'approve'), (req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const row = db.prepare('SELECT * FROM mw_destinations WHERE id = ?').get(id) as any;
    if (!row) return res.status(404).json({ error: 'That destination no longer exists.' });
    if (row.is_protected) return res.status(409).json({ error: 'A protected production connection is held read-only and is not activated from here.' });
    if (!row.approved_by) {
      return res.status(409).json({ error: 'This destination has not been approved. Approval and activation are separate on purpose: one person signs that the interface is correct, and activation is the moment it starts carrying results.' });
    }
    db.prepare(`UPDATE mw_destinations SET state = 'active', activated_by = ?, activated_at = CURRENT_TIMESTAMP,
        state_detail = 'Active.', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(req.user!.id, id);
    const after = db.prepare('SELECT * FROM mw_destinations WHERE id = ?').get(id) as any;
    recordVersion(db, { scope: 'destination', entityId: id, entityCode: row.dest_code, entityName: row.name, action: 'activate', before: row, after, reason: req.body?.reason ?? null, userId: req.user!.id });
    audit(req, { action: 'middleware_destination_activate', entity: 'mw_destinations', entityId: id });
    res.json(publicDestination(after));
  });

  router.post('/destinations/:id/deactivate', numericOnly, requirePermission(F.configuration, 'approve'), (req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const row = db.prepare('SELECT * FROM mw_destinations WHERE id = ?').get(id) as any;
    if (!row) return res.status(404).json({ error: 'That destination no longer exists.' });
    if (row.is_protected) return res.status(409).json({ error: 'A protected production connection is held read-only.' });
    const reason = String(req.body?.reason ?? '').trim() || 'Stood down.';
    db.prepare(`UPDATE mw_destinations SET state = 'disconnected', state_detail = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(reason, id);
    const after = db.prepare('SELECT * FROM mw_destinations WHERE id = ?').get(id) as any;
    recordVersion(db, { scope: 'destination', entityId: id, entityCode: row.dest_code, entityName: row.name, action: 'deactivate', before: row, after, reason, userId: req.user!.id });
    audit(req, { action: 'middleware_destination_deactivate', entity: 'mw_destinations', entityId: id, newValue: { reason } });
    res.json({
      ...publicDestination(after),
      note: 'Stood down. Queued deliveries are kept and will be attempted when it is active again — nothing is discarded.',
    });
  });

  router.get('/destinations/:id/diagnostics', numericOnly, requirePermission(F.diagnostics, 'view'), async (req, res) => {
    res.json(await diagnoseDestination(getDb(), Number(req.params.id)));
  });

  /* ======================================================================
     Mappings
     ==================================================================== */
  router.get('/destinations/:id/mappings', numericOnly, requirePermission(F.overview, 'view'), (req, res) => {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM mw_mappings WHERE destination_id = ? ORDER BY source_code').all(Number(req.params.id)) as any[];
    // The codes that have actually arrived, so a mapping screen shows what the
    // analysers are really sending rather than what a profile says they might.
    const observed = db.prepare(`SELECT parsed_values FROM instrument_messages
        WHERE result_count > 0 ORDER BY id DESC LIMIT 100`).all() as any[];
    const tally = new Map<string, number>();
    for (const message of observed) {
      for (const value of json<any[]>(message.parsed_values, [])) {
        const code = String(value?.code ?? '').trim();
        if (code) tally.set(code, (tally.get(code) ?? 0) + 1);
      }
    }
    res.json({
      mappings: rows.map(row => ({ ...row, value_map: json<Record<string, string>>(row.value_map, {}) })),
      observedCodes: [...tally.entries()].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count),
    });
  });

  router.post('/destinations/:id/mappings', numericOnly, requirePermission(F.configuration, 'edit'), (req, res) => {
    const db = getDb();
    const destinationId = Number(req.params.id);
    const destination = db.prepare('SELECT * FROM mw_destinations WHERE id = ?').get(destinationId) as any;
    if (!destination) return res.status(404).json({ error: 'That destination no longer exists.' });
    const editable = destinationIsEditable(destination);
    if (!editable.ok) return res.status(409).json({ error: editable.reason });

    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [req.body];
    let written = 0;
    for (const row of rows) {
      const sourceCode = String(row?.sourceCode ?? '').trim();
      if (!sourceCode) continue;
      const before = db.prepare('SELECT * FROM mw_mappings WHERE destination_id = ? AND source_code = ?').get(destinationId, sourceCode) as any;
      db.prepare(`INSERT INTO mw_mappings
          (destination_id, source_code, target_code, target_name, target_unit, factor, offset_value,
           decimals, value_map, is_required, is_active, note, created_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(destination_id, source_code) DO UPDATE SET
            target_code = excluded.target_code, target_name = excluded.target_name,
            target_unit = excluded.target_unit, factor = excluded.factor,
            offset_value = excluded.offset_value, decimals = excluded.decimals,
            value_map = excluded.value_map, is_required = excluded.is_required,
            is_active = excluded.is_active, note = excluded.note, updated_at = CURRENT_TIMESTAMP`)
        .run(destinationId, sourceCode,
          row.targetCode ? String(row.targetCode) : null, row.targetName ? String(row.targetName) : null,
          row.targetUnit ? String(row.targetUnit) : null,
          row.factor == null || row.factor === '' ? null : Number(row.factor),
          row.offset == null || row.offset === '' ? null : Number(row.offset),
          row.decimals == null || row.decimals === '' ? null : Number(row.decimals),
          row.valueMap ? JSON.stringify(row.valueMap) : null,
          row.required ? 1 : 0, row.active === false ? 0 : 1,
          row.note ? String(row.note) : null, req.user!.id);
      const after = db.prepare('SELECT * FROM mw_mappings WHERE destination_id = ? AND source_code = ?').get(destinationId, sourceCode) as any;
      recordVersion(db, {
        scope: 'mapping', entityId: Number(after.id), entityCode: sourceCode,
        entityName: `${destination.name} · ${sourceCode}`,
        action: before ? 'update' : 'create', before, after, reason: req.body?.reason ?? null, userId: req.user!.id,
        dennisActionId: req.body?.dennisActionId ?? null,
      });
      written++;
    }
    if (req.body?.dennisActionId) markApplied(db, Number(req.body.dennisActionId), null);
    audit(req, { action: 'middleware_mapping_write', entity: 'mw_mappings', entityId: destinationId, newValue: { written } });
    res.json({ ok: true, written });
  });

  router.delete('/mappings/:id', numericOnly, requirePermission(F.configuration, 'edit'), (req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const before = db.prepare('SELECT * FROM mw_mappings WHERE id = ?').get(id) as any;
    if (!before) return res.status(404).json({ error: 'That mapping no longer exists.' });
    db.prepare('DELETE FROM mw_mappings WHERE id = ?').run(id);
    recordVersion(db, { scope: 'mapping', entityId: id, entityCode: before.source_code, entityName: before.source_code, action: 'delete', before, after: null, reason: req.body?.reason ?? null, userId: req.user!.id });
    audit(req, { action: 'middleware_mapping_delete', entity: 'mw_mappings', entityId: id });
    res.json({ ok: true });
  });

  /* ======================================================================
     Routing rules
     ==================================================================== */
  router.get('/routes', requirePermission(F.overview, 'view'), (_req, res) => {
    const db = getDb();
    const rows = db.prepare(`SELECT r.*, d.name AS destination_name, d.platform, d.state AS destination_state,
          d.is_protected AS destination_protected, l.name AS source_link_name, s.name AS section_name,
          (SELECT COUNT(*) FROM mw_deliveries v WHERE v.route_id = r.id) AS deliveries
        FROM mw_routes r
        JOIN mw_destinations d ON d.id = r.destination_id
        LEFT JOIN instrument_links l ON l.id = r.source_link_id
        LEFT JOIN sections s ON s.id = r.section_id
        ORDER BY r.priority, r.id`).all() as any[];
    res.json(rows.map(row => ({ ...row, test_codes: json<string[]>(row.test_codes, []) })));
  });

  router.post('/routes', requirePermission(F.configuration, 'create'), (req, res) => {
    const db = getDb();
    const body = req.body ?? {};
    const name = String(body.name ?? '').trim();
    const destinationId = Number(body.destinationId ?? 0);
    if (!name) return res.status(400).json({ error: 'Give the rule a name.' });
    if (!destinationId) return res.status(400).json({ error: 'Choose the destination this rule sends to.' });

    const sourceLinkId = body.sourceLinkId == null || body.sourceLinkId === '' ? null : Number(body.sourceLinkId);
    const verdict = routeIsSafe(db, sourceLinkId, destinationId);
    if (!verdict.ok) return res.status(409).json({ error: verdict.reason });

    const code = nextCode(db, 'mw_routes', 'route_code', 'ROUTE');
    const inserted = db.prepare(`INSERT INTO mw_routes
        (route_code, name, destination_id, priority, source_link_id, source_profile_key, message_kind,
         test_codes, section_id, facility, department, transform, stop_on_match, is_active, notes, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(code, name, destinationId, Number(body.priority ?? 100), sourceLinkId,
        body.sourceProfileKey ? String(body.sourceProfileKey) : null,
        String(body.messageKind ?? 'patient'),
        Array.isArray(body.testCodes) && body.testCodes.length ? JSON.stringify(body.testCodes.map(String)) : null,
        body.sectionId == null || body.sectionId === '' ? null : Number(body.sectionId),
        body.facility ? String(body.facility) : null, body.department ? String(body.department) : null,
        body.transform ? JSON.stringify(body.transform) : null,
        body.stopOnMatch ? 1 : 0, body.active === false ? 0 : 1,
        body.notes ? String(body.notes) : null, req.user!.id);

    const id = Number(inserted.lastInsertRowid);
    const after = db.prepare('SELECT * FROM mw_routes WHERE id = ?').get(id) as any;
    const versionId = recordVersion(db, { scope: 'route', entityId: id, entityCode: code, entityName: name, action: 'create', before: null, after, reason: body.reason ?? null, userId: req.user!.id, dennisActionId: body.dennisActionId ?? null });
    if (body.dennisActionId) markApplied(db, Number(body.dennisActionId), versionId);
    audit(req, { action: 'middleware_route_create', entity: 'mw_routes', entityId: id, newValue: { code, name, destinationId } });
    res.status(201).json({ ...after, test_codes: json<string[]>(after.test_codes, []) });
  });

  router.put('/routes/:id', numericOnly, requirePermission(F.configuration, 'edit'), (req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const before = db.prepare('SELECT * FROM mw_routes WHERE id = ?').get(id) as any;
    if (!before) return res.status(404).json({ error: 'That rule no longer exists.' });
    const body = req.body ?? {};
    const destinationId = body.destinationId === undefined ? Number(before.destination_id) : Number(body.destinationId);
    const sourceLinkId = body.sourceLinkId === undefined ? before.source_link_id
      : (body.sourceLinkId == null || body.sourceLinkId === '' ? null : Number(body.sourceLinkId));
    const verdict = routeIsSafe(db, sourceLinkId, destinationId);
    if (!verdict.ok) return res.status(409).json({ error: verdict.reason });

    const keep = (key: string, value: unknown) => (value === undefined ? before[key] : value);
    db.prepare(`UPDATE mw_routes SET name = ?, destination_id = ?, priority = ?, source_link_id = ?,
        source_profile_key = ?, message_kind = ?, test_codes = ?, section_id = ?, facility = ?,
        department = ?, transform = ?, stop_on_match = ?, is_active = ?, notes = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`)
      .run(String(keep('name', body.name)), destinationId, Number(keep('priority', body.priority)), sourceLinkId,
        keep('source_profile_key', body.sourceProfileKey), String(keep('message_kind', body.messageKind)),
        body.testCodes === undefined ? before.test_codes
          : (Array.isArray(body.testCodes) && body.testCodes.length ? JSON.stringify(body.testCodes.map(String)) : null),
        body.sectionId === undefined ? before.section_id : (body.sectionId == null || body.sectionId === '' ? null : Number(body.sectionId)),
        keep('facility', body.facility), keep('department', body.department),
        body.transform === undefined ? before.transform : (body.transform ? JSON.stringify(body.transform) : null),
        body.stopOnMatch === undefined ? before.stop_on_match : (body.stopOnMatch ? 1 : 0),
        body.active === undefined ? before.is_active : (body.active ? 1 : 0),
        keep('notes', body.notes), id);

    const after = db.prepare('SELECT * FROM mw_routes WHERE id = ?').get(id) as any;
    recordVersion(db, { scope: 'route', entityId: id, entityCode: before.route_code, entityName: after.name, action: 'update', before, after, reason: body.reason ?? null, userId: req.user!.id });
    audit(req, { action: 'middleware_route_update', entity: 'mw_routes', entityId: id });
    res.json({ ...after, test_codes: json<string[]>(after.test_codes, []) });
  });

  router.delete('/routes/:id', numericOnly, requirePermission(F.configuration, 'void_archive'), (req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const before = db.prepare('SELECT * FROM mw_routes WHERE id = ?').get(id) as any;
    if (!before) return res.status(404).json({ error: 'That rule no longer exists.' });
    db.prepare('UPDATE mw_routes SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
    recordVersion(db, { scope: 'route', entityId: id, entityCode: before.route_code, entityName: before.name, action: 'delete', before, after: null, reason: req.body?.reason ?? null, userId: req.user!.id });
    audit(req, { action: 'middleware_route_retire', entity: 'mw_routes', entityId: id });
    res.json({ ok: true, note: 'Switched off. Deliveries already made under it are kept.' });
  });

  /**
   * Which rules would take this message?
   *
   * The same function the engine uses, so what this screen predicts is what
   * actually happens. A screen that disagrees with the engine about routing is
   * worse than no screen.
   */
  router.post('/routes/preview', requirePermission(F.overview, 'view'), (req, res) => {
    const db = getDb();
    const body = req.body ?? {};
    const rules = db.prepare(`SELECT r.*, d.name AS destination_name, d.state AS destination_state, d.is_protected
        FROM mw_routes r JOIN mw_destinations d ON d.id = r.destination_id
        WHERE r.is_active = 1 ORDER BY r.priority, r.id`).all() as any[];
    const candidate = {
      linkId: body.linkId == null ? null : Number(body.linkId),
      profileKey: body.profileKey ?? null,
      kind: String(body.kind ?? 'patient'),
      sectionId: body.sectionId == null ? null : Number(body.sectionId),
      facility: body.facility ?? null,
      department: body.department ?? null,
      codes: Array.isArray(body.codes) ? body.codes.map(String) : [],
    };
    const matches: any[] = [];
    for (const rule of rules) {
      const criteria: RouteCriteria = {
        sourceLinkId: rule.source_link_id ?? null,
        sourceProfileKey: rule.source_profile_key ?? null,
        messageKind: rule.message_kind ?? 'any',
        testCodes: json<string[]>(rule.test_codes, []),
        sectionId: rule.section_id ?? null,
        facility: rule.facility ?? null,
        department: rule.department ?? null,
      };
      if (!routeMatches(criteria, candidate)) continue;
      const verdict = routeIsSafe(db, candidate.linkId, Number(rule.destination_id));
      matches.push({
        routeId: rule.id, routeCode: rule.route_code, name: rule.name,
        destination: rule.destination_name, destinationState: rule.destination_state,
        wouldQueue: verdict.ok && (rule.destination_state === 'active' || rule.destination_state === 'degraded' || rule.destination_state === 'testing'),
        reason: verdict.ok
          ? (rule.destination_state === 'active' ? 'Would be queued.' : `Would match, but ${rule.destination_name} is ${rule.destination_state} rather than active.`)
          : verdict.reason,
        stopsHere: Boolean(rule.stop_on_match),
      });
      if (rule.stop_on_match) break;
    }
    res.json({
      matches,
      note: matches.length
        ? `${matches.filter(m => m.wouldQueue).length} of ${matches.length} matching rule(s) would queue a delivery.`
        : 'No rule covers a message like this. It would be held in SECHLIMS and transmitted nowhere.',
    });
  });

  /* ======================================================================
     Messages, and the trace of each
     ==================================================================== */
  router.get('/messages', requirePermission(F.overview, 'view'), (req, res) => {
    const db = getDb();
    const where: string[] = [];
    const params: unknown[] = [];
    if (req.query.linkId) { where.push('m.link_id = ?'); params.push(Number(req.query.linkId)); }
    if (req.query.status) { where.push('m.status = ?'); params.push(String(req.query.status)); }
    if (req.query.kind) { where.push('m.kind = ?'); params.push(String(req.query.kind)); }
    if (req.query.search) {
      where.push('(m.sample_id LIKE ? OR m.lot_number LIKE ? OR m.message_uid LIKE ?)');
      const like = `%${String(req.query.search).trim()}%`;
      params.push(like, like, like);
    }
    if (req.query.from) { where.push('date(m.received_at) >= date(?)'); params.push(String(req.query.from)); }
    if (req.query.to) { where.push('date(m.received_at) <= date(?)'); params.push(String(req.query.to)); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limit = Math.min(500, Math.max(1, Number(req.query.limit ?? 100)));
    const offset = Math.max(0, Number(req.query.offset ?? 0));

    const total = (db.prepare(`SELECT COUNT(*) AS n FROM mw_messages m ${clause}`).get(...params) as any)?.n ?? 0;
    const rows = db.prepare(`SELECT m.*, l.name AS link_name,
          (SELECT COUNT(*) FROM mw_deliveries v WHERE v.message_id = m.id) AS deliveries,
          (SELECT COUNT(*) FROM mw_deliveries v WHERE v.message_id = m.id AND v.state = 'delivered') AS delivered,
          (SELECT COUNT(*) FROM mw_deliveries v WHERE v.message_id = m.id AND v.state = 'dead_letter') AS dead_letters
        FROM mw_messages m LEFT JOIN instrument_links l ON l.id = m.link_id
        ${clause} ORDER BY m.id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset) as any[];
    res.json({
      total,
      rows: rows.map(row => ({
        ...row,
        normalised: undefined,
        validation: json<any[]>(row.validation, []),
      })),
    });
  });

  router.get('/messages/:id', numericOnly, requirePermission(F.overview, 'view'), (req, res) => {
    const db = getDb();
    const trace = engine.traceOf(Number(req.params.id)) as any;
    if (!trace.message) return res.status(404).json({ error: 'That message is not on the record.' });
    // The source message, exactly as the bridge recorded it. Preserved and
    // never rewritten; this is the only place it is read from.
    const source = trace.message.instrument_message_id
      ? db.prepare('SELECT raw_message, peer, received_at FROM instrument_messages WHERE id = ?').get(trace.message.instrument_message_id) as any
      : null;
    res.json({ ...trace, source: source ?? null });
  });

  router.post('/messages/:id/reroute', numericOnly, requirePermission(F.queues, 'edit'), (req, res) => {
    const outcome = engine.reroute(Number(req.params.id), req.user!.id);
    if (!outcome.ok) return res.status(400).json({ error: outcome.note });
    audit(req, { action: 'middleware_message_reroute', entity: 'mw_messages', entityId: req.params.id, newValue: { queued: outcome.queued } });
    res.json(outcome);
  });

  /**
   * Play a message through the engine.
   *
   * The simulator. It is how a routing rule, a mapping and a destination are
   * proved without waiting for an analyser — and it sanitises whatever is
   * pasted in first, so a captured production transmission can be used for
   * testing without its identifiers.
   */
  router.post('/simulate', requirePermission(F.diagnostics, 'create'), (req, res) => {
    const db = getDb();
    const body = req.body ?? {};
    const raw = String(body.message ?? '');
    if (!raw.trim()) return res.status(400).json({ error: 'Paste a transmission to play through the engine.' });

    const text = body.sanitise === false ? raw : sanitiseProtocolSample(raw);
    const linkId = body.linkId == null || body.linkId === '' ? null : Number(body.linkId);
    const link = linkId == null ? null : db.prepare('SELECT * FROM instrument_links WHERE id = ?').get(linkId) as any;
    const protocol = effectiveProtocol(link?.protocol ?? detectProtocol(text) ?? 'auto', text);

    let parsed: any[] = [];
    try { parsed = parseFor(protocol, text); }
    catch (error) { return res.status(400).json({ error: `The message could not be read as ${protocol.toUpperCase()}: ${(error as Error).message}` }); }
    if (!parsed.length) return res.status(400).json({ error: `Nothing came out of this message when read as ${protocol.toUpperCase()}.` });

    const linkMap = json<Record<string, string>>(link?.analyte_map, {});
    const outcomes = parsed.map(message => engine.ingest({
      linkId,
      instrumentMessageId: null,
      protocol,
      kind: String(body.kind ?? (message.controlHint ? 'control' : 'patient')),
      sampleId: message.sampleId,
      lotNumber: message.lotNumber,
      instrument: message.instrument,
      runAt: message.runAt,
      results: message.results.map((result: any) => ({
        analyte: mapAnalyte(result.code, linkMap, link?.profile_key ?? null),
        code: result.code, value: result.value, unit: result.unit, flag: result.flag,
      })),
      raw: text,
      source: 'simulator',
    }));

    audit(req, { action: 'middleware_simulate', entity: 'mw_messages', newValue: { protocol, messages: outcomes.length } });
    res.json({
      protocol,
      sanitised: body.sanitise !== false,
      messages: outcomes,
      note: `${outcomes.length} message(s) played through the engine as ${protocol.toUpperCase()}. `
        + `${outcomes.reduce((sum, o) => sum + o.deliveries, 0)} delivery(ies) queued.`,
    });
  });

  /* ======================================================================
     Queues
     ==================================================================== */
  router.get('/deliveries', requirePermission(F.overview, 'view'), (req, res) => {
    const db = getDb();
    const where: string[] = [];
    const params: unknown[] = [];
    if (req.query.state) {
      const states = String(req.query.state).split(',').map(s => s.trim()).filter(Boolean);
      where.push(`v.state IN (${states.map(() => '?').join(',')})`);
      params.push(...states);
    }
    if (req.query.destinationId) { where.push('v.destination_id = ?'); params.push(Number(req.query.destinationId)); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limit = Math.min(500, Math.max(1, Number(req.query.limit ?? 100)));

    const rows = db.prepare(`SELECT v.*, d.name AS destination_name, d.platform, d.transport, d.ack_policy,
          m.sample_id, m.kind, m.message_uid, m.received_at AS message_received_at,
          l.name AS link_name, u.full_name AS replayed_by_name
        FROM mw_deliveries v
        JOIN mw_destinations d ON d.id = v.destination_id
        JOIN mw_messages m ON m.id = v.message_id
        LEFT JOIN instrument_links l ON l.id = m.link_id
        LEFT JOIN users u ON u.id = v.replayed_by
        ${clause} ORDER BY v.id DESC LIMIT ?`).all(...params, limit) as any[];

    const summary = db.prepare(`SELECT state, COUNT(*) AS n FROM mw_deliveries GROUP BY state`).all() as any[];
    const byDestination = db.prepare(`SELECT d.id, d.name, d.state AS destination_state,
          SUM(CASE WHEN v.state IN ('queued','retrying','in_flight') THEN 1 ELSE 0 END) AS pending,
          SUM(CASE WHEN v.state = 'dead_letter' THEN 1 ELSE 0 END) AS dead_letters,
          SUM(CASE WHEN v.state = 'delivered' THEN 1 ELSE 0 END) AS delivered
        FROM mw_destinations d LEFT JOIN mw_deliveries v ON v.destination_id = d.id
        WHERE d.is_active = 1 GROUP BY d.id ORDER BY pending DESC, d.name`).all() as any[];

    res.json({
      rows: rows.map(row => ({
        ...row,
        payload: undefined,
        results_unmapped: json<string[]>(row.results_unmapped, []),
        confirmable: deliveryIsConfirmable(row.ack_policy),
      })),
      summary, byDestination,
    });
  });

  router.get('/deliveries/:id', numericOnly, requirePermission(F.overview, 'view'), (req, res) => {
    const db = getDb();
    const row = db.prepare(`SELECT v.*, d.name AS destination_name, d.transport, d.payload_format, d.ack_policy,
          m.sample_id, m.message_uid, m.kind
        FROM mw_deliveries v JOIN mw_destinations d ON d.id = v.destination_id
        JOIN mw_messages m ON m.id = v.message_id WHERE v.id = ?`).get(Number(req.params.id)) as any;
    if (!row) return res.status(404).json({ error: 'That delivery is not on the record.' });
    const trace = db.prepare('SELECT * FROM mw_trace WHERE delivery_id = ? ORDER BY id').all(Number(req.params.id));
    res.json({
      ...row,
      results_unmapped: json<string[]>(row.results_unmapped, []),
      confirmable: deliveryIsConfirmable(row.ack_policy),
      trace,
    });
  });

  router.post('/deliveries/:id/replay', numericOnly, requirePermission(F.queues, 'edit'), (req, res) => {
    const outcome = engine.replay(Number(req.params.id), req.user!.id, req.body?.reason ?? null);
    if (!outcome.ok) return res.status(409).json({ error: outcome.note });
    audit(req, { action: 'middleware_delivery_replay', entity: 'mw_deliveries', entityId: req.params.id, newValue: { reason: req.body?.reason ?? null } });
    res.json(outcome);
  });

  router.post('/deliveries/:id/cancel', numericOnly, requirePermission(F.queues, 'edit'), (req, res) => {
    const reason = String(req.body?.reason ?? '').trim();
    if (!reason) return res.status(400).json({ error: 'Say why this delivery is being cancelled. It is a clinical result that will not be sent.' });
    const outcome = engine.cancel(Number(req.params.id), req.user!.id, reason);
    if (!outcome.ok) return res.status(409).json({ error: outcome.note });
    audit(req, { action: 'middleware_delivery_cancel', entity: 'mw_deliveries', entityId: req.params.id, newValue: { reason } });
    res.json(outcome);
  });

  router.post('/deliveries/:id/send-now', numericOnly, requirePermission(F.queues, 'edit'), async (req, res) => {
    const outcome = await engine.sendNow(Number(req.params.id), req.user!.id);
    audit(req, { action: 'middleware_delivery_send_now', entity: 'mw_deliveries', entityId: req.params.id, newValue: { state: outcome.state } });
    res.json(outcome);
  });

  router.post('/queue/drain', requirePermission(F.queues, 'edit'), async (req, res) => {
    const summary = await engine.tick();
    audit(req, { action: 'middleware_queue_drain', entity: 'mw_deliveries', newValue: summary });
    res.json({ ...summary, note: `${summary.attempted} delivery(ies) attempted, ${summary.delivered} accepted, ${summary.failed} failed.` });
  });

  router.post('/queue/recover', requirePermission(F.queues, 'edit'), (req, res) => {
    const outcome = engine.recover();
    audit(req, { action: 'middleware_queue_recover', entity: 'mw_deliveries', newValue: outcome });
    res.json({ ...outcome, note: `${outcome.reclaimed} delivery(ies) that were in flight have been put back in the queue.` });
  });

  /* ======================================================================
     Discovery
     ==================================================================== */
  router.get('/discovery', requirePermission(F.discovery, 'view'), (req, res) => {
    const db = getDb();
    const scans = discoveryHistory(db, Number(req.query.limit ?? 20));
    const latest = scans.length ? discoveryEndpoints(db, Number(scans[0].id)) : [];
    res.json({ scans, latest });
  });

  router.get('/discovery/:id', numericOnly, requirePermission(F.discovery, 'view'), (req, res) => {
    const db = getDb();
    const scan = db.prepare('SELECT * FROM mw_discovery_scans WHERE id = ?').get(Number(req.params.id));
    if (!scan) return res.status(404).json({ error: 'That scan is not on the record.' });
    res.json({ scan, endpoints: discoveryEndpoints(db, Number(req.params.id)) });
  });

  router.post('/discovery', requirePermission(F.discovery, 'create'), async (req, res) => {
    const db = getDb();
    const outcome = await runDiscovery(db, {
      target: String(req.body?.target ?? ''),
      ports: Array.isArray(req.body?.ports) ? req.body.ports.map(Number) : null,
      userId: req.user!.id,
    });
    if (!outcome.ok) return res.status(400).json({ error: outcome.note });
    audit(req, {
      action: 'middleware_discovery_scan', entity: 'mw_discovery_scans', entityId: outcome.scanId ?? undefined,
      newValue: { target: req.body?.target, found: outcome.endpoints.length, protectedSkipped: outcome.protectedSkipped },
    });
    res.json(outcome);
  });

  /* ======================================================================
     The protected connection
     ==================================================================== */
  router.get('/baselines', requirePermission(F.overview, 'view'), (_req, res) => {
    const db = getDb();
    const rows = db.prepare(`SELECT b.*, u.full_name AS captured_by_name, l.name AS link_name, l.state AS link_state
        FROM mw_baselines b LEFT JOIN users u ON u.id = b.captured_by
        LEFT JOIN instrument_links l ON l.id = b.link_id ORDER BY b.id`).all() as any[];
    res.json(rows.map(row => ({
      ...row,
      baseline_json: json<Record<string, unknown> | null>(row.baseline_json, null),
      last_drift: json<string[]>(row.last_drift, []),
    })));
  });

  router.post('/baselines/capture', requirePermission(F.configuration, 'create'), (req, res) => {
    const db = getDb();
    const outcome = captureBaseline(db, {
      linkId: req.body?.linkId == null ? null : Number(req.body.linkId),
      label: req.body?.label ?? null,
      note: req.body?.note ?? null,
      userId: req.user!.id,
    });
    if (!outcome.ok) return res.status(400).json({ error: outcome.note });
    audit(req, { action: 'middleware_baseline_capture', entity: 'mw_baselines', entityId: outcome.baselineId ?? undefined, newValue: { label: outcome.snapshot?.label } });
    res.json(outcome);
  });

  router.post('/baselines/:id/verify', numericOnly, requirePermission(F.diagnostics, 'view'), (req, res) => {
    const outcome = verifyBaseline(getDb(), Number(req.params.id));
    if (!outcome.ok) return res.status(404).json({ error: outcome.note });
    res.json(outcome);
  });

  /* ======================================================================
     Diagnostics, for the whole module
     ==================================================================== */
  router.get('/diagnostics', requirePermission(F.diagnostics, 'view'), (_req, res) => {
    res.json(diagnoseSystem(getDb()));
  });

  /* ======================================================================
     Configuration history and rollback
     ==================================================================== */
  router.get('/versions', requirePermission(F.audit, 'view'), (req, res) => {
    res.json({
      versions: versionHistory(getDb(), {
        scope: req.query.scope ? String(req.query.scope) as any : null,
        entityId: req.query.entityId ? Number(req.query.entityId) : null,
        limit: Number(req.query.limit ?? 100),
      }),
    });
  });

  router.post('/versions/:id/rollback', numericOnly, requirePermission(F.audit, 'void_archive'), (req, res) => {
    const outcome = rollbackTo(getDb(), Number(req.params.id), req.user!.id, req.body?.reason ?? null);
    if (!outcome.ok) return res.status(409).json({ error: outcome.note });
    audit(req, { action: 'middleware_config_rollback', entity: 'mw_config_versions', entityId: req.params.id, newValue: { reason: req.body?.reason ?? null } });
    res.json(outcome);
  });

  /* ======================================================================
     Dennis
     ==================================================================== */
  router.get('/dennis', requirePermission(F.dennis, 'view'), (req, res) => {
    res.json({ actions: dennisHistory(getDb(), Number(req.query.limit ?? 50)) });
  });

  router.post('/dennis/ask', requirePermission(F.dennis, 'view'), async (req, res) => {
    const body = req.body ?? {};
    const tool = String(body.tool ?? 'summarise_health') as DennisTool;
    if (!DENNIS_TOOLS.includes(tool)) return res.status(400).json({ error: `${tool} is not a tool Dennis has here.` });
    try {
      const answer = await askDennisMiddleware(getDb(), {
        tool,
        userId: req.user!.id,
        question: body.question ?? null,
        linkId: body.linkId == null || body.linkId === '' ? null : Number(body.linkId),
        destinationId: body.destinationId == null || body.destinationId === '' ? null : Number(body.destinationId),
        sample: body.sample ?? null,
        intent: body.intent ?? null,
      });
      res.json(answer);
    } catch (error) {
      res.status(500).json({ error: `Dennis could not answer: ${(error as Error).message}` });
    }
  });

  router.post('/dennis/:id/review', numericOnly, requirePermission(F.dennis, 'approve'), (req, res) => {
    const decision = req.body?.decision === 'rejected' ? 'rejected' : 'approved';
    const outcome = reviewAction(getDb(), {
      actionId: Number(req.params.id), userId: req.user!.id, decision, note: req.body?.note ?? null,
    });
    if (!outcome.ok) return res.status(409).json({ error: outcome.note });
    audit(req, { action: `middleware_dennis_${decision}`, entity: 'mw_dennis_actions', entityId: req.params.id, newValue: { note: req.body?.note ?? null } });
    res.json(outcome);
  });

  return router;
}
