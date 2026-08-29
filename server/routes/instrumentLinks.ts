/**
 * Analyser links, over HTTP.
 *
 *   GET    /instrument-links                 every link, with its live state
 *   GET    /instrument-links/profiles        the analysers this system knows
 *   POST   /instrument-links                 add one
 *   PUT    /instrument-links/:id             change one
 *   DELETE /instrument-links/:id             retire one
 *   POST   /instrument-links/:id/start       start it
 *   POST   /instrument-links/:id/stop        stop it
 *   GET    /instrument-links/:id/messages    what this analyser has said
 *   POST   /instrument-links/:id/simulate    play a message at it, to prove the mapping
 *
 * The whole surface is administrative — connecting an analyser is not bench
 * work — so it takes the IQC module's own edit right, and the safety rules the
 * bridge enforces are stated back to the caller rather than left implicit.
 */
import { Router } from 'express';
import { getDb } from '../db/database.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import { audit } from '../services/auditService.js';
import { parseIntNullable } from './routeHelpers.js';
import { getBridge } from '../services/instrumentBridge/index.js';
import { parseFor } from '../services/instrumentBridge/protocols.js';
import {
  INSTRUMENT_PROFILES, LINK_MODES, LINK_PROTOCOLS, LINK_ROLES, LINK_ROLE_LABELS,
  DEFAULT_CONTROL_PATTERNS, looksLikeControl, mapAnalyte, profileByKey,
} from '../../shared/constants/instruments.js';

const MODULE = 'iqc';
const numericOnly = (req: any, _res: any, next: any) => (/^\d+$/.test(req.params.id) ? next() : next('route'));

function json<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try { return (JSON.parse(value) ?? fallback) as T; } catch { return fallback; }
}

export function instrumentLinkRoutes() {
  const router = Router();
  router.use(requireAuth);
  const bridge = getBridge(getDb);

  /* ======================================================================
     What the system knows how to talk to
     ==================================================================== */
  router.get('/profiles', requirePermission(MODULE, 'view'), (_req, res) => {
    res.json({
      profiles: INSTRUMENT_PROFILES.map(p => ({
        key: p.key, label: p.label, vendor: p.vendor, discipline: p.discipline,
        protocol: p.protocol, notes: p.notes ?? null,
        analyteCount: Object.keys(p.analytes).length,
      })),
      roles: LINK_ROLES.map(r => ({ key: r, label: LINK_ROLE_LABELS[r] })),
      modes: LINK_MODES, protocols: LINK_PROTOCOLS,
      defaultControlPatterns: DEFAULT_CONTROL_PATTERNS,
    });
  });

  router.get('/profiles/:key/analytes', requirePermission(MODULE, 'view'), (req, res) => {
    const profile = profileByKey(req.params.key);
    if (!profile) return res.status(404).json({ error: 'Unknown analyser profile' });
    res.json(profile.analytes);
  });

  /* ======================================================================
     The links
     ==================================================================== */
  router.get('/', requirePermission(MODULE, 'view'), (req, res) => {
    const db = getDb();
    const rows = db.prepare(`SELECT l.*, e.name AS equipment_name, e.equipment_number, s.name AS section_name,
          (SELECT COUNT(*) FROM instrument_messages m WHERE m.link_id = l.id) AS message_count,
          (SELECT COUNT(*) FROM instrument_messages m WHERE m.link_id = l.id AND m.kind = 'control') AS control_count,
          (SELECT COUNT(*) FROM instrument_messages m WHERE m.link_id = l.id AND m.forward_status = 'pending') AS forward_pending
        FROM instrument_links l
        LEFT JOIN equipment_items e ON e.id = l.equipment_id
        LEFT JOIN sections s ON s.id = l.section_id
        ${req.query.active === 'all' ? '' : 'WHERE l.is_active = 1'}
        ORDER BY CASE l.role WHEN 'lhims_owned' THEN 1 ELSE 0 END, l.name`).all() as any[];

    res.json(rows.map(row => ({
      ...row,
      analyte_map: json<Record<string, string>>(row.analyte_map, {}),
      control_patterns: json<string[]>(row.control_patterns, []),
      running: bridge.isRunning(row.id),
    })));
  });

  function body(req: any, existing: any = {}) {
    const b = req.body ?? {};
    const pick = <T>(value: T | undefined, fallback: T) => (value === undefined ? fallback : value);
    return {
      name: String(pick(b.name, existing.name) ?? '').trim(),
      equipmentId: b.equipmentId !== undefined ? parseIntNullable(b.equipmentId) : (existing.equipment_id ?? null),
      sectionId: b.sectionId !== undefined ? parseIntNullable(b.sectionId) : (existing.section_id ?? null),
      profileKey: pick(b.profileKey, existing.profile_key) ?? null,
      role: String(pick(b.role, existing.role) ?? 'sechlims_only'),
      mode: String(pick(b.mode, existing.mode) ?? 'server'),
      protocol: String(pick(b.protocol, existing.protocol) ?? 'astm'),
      listenHost: pick(b.listenHost, existing.listen_host) ?? null,
      listenPort: b.listenPort !== undefined ? parseIntNullable(b.listenPort) : (existing.listen_port ?? null),
      remoteHost: pick(b.remoteHost, existing.remote_host) ?? null,
      remotePort: b.remotePort !== undefined ? parseIntNullable(b.remotePort) : (existing.remote_port ?? null),
      watchPath: pick(b.watchPath, existing.watch_path) ?? null,
      analyteMap: b.analyteMap !== undefined ? JSON.stringify(b.analyteMap ?? {}) : (existing.analyte_map ?? null),
      controlPatterns: b.controlPatterns !== undefined ? JSON.stringify(b.controlPatterns ?? []) : (existing.control_patterns ?? null),
      forwardEnabled: b.forwardEnabled !== undefined ? (b.forwardEnabled ? 1 : 0) : (existing.forward_enabled ?? 0),
      forwardHost: pick(b.forwardHost, existing.forward_host) ?? null,
      forwardPort: b.forwardPort !== undefined ? parseIntNullable(b.forwardPort) : (existing.forward_port ?? null),
      autoStart: b.autoStart !== undefined ? (b.autoStart ? 1 : 0) : (existing.auto_start ?? 1),
      isActive: b.isActive !== undefined ? (b.isActive ? 1 : 0) : (existing.is_active ?? 1),
      notes: pick(b.notes, existing.notes) ?? null,
    };
  }

  /**
   * The rules that keep the existing transmission safe, checked before a link
   * is ever saved rather than discovered when it fails to bind.
   */
  function validate(db: any, v: ReturnType<typeof body>, id: number | null): string | null {
    if (!v.name) return 'Give the link a name — usually the analyser\'s.';
    if (!LINK_ROLES.includes(v.role as any)) return `The link's role must be one of: ${LINK_ROLES.join(', ')}.`;
    if (!LINK_MODES.includes(v.mode as any)) return `The mode must be one of: ${LINK_MODES.join(', ')}.`;
    if (!LINK_PROTOCOLS.includes(v.protocol as any)) return `The protocol must be one of: ${LINK_PROTOCOLS.join(', ')}.`;

    if (v.mode === 'server' && !v.listenPort) return 'A listening link needs the port the analyser will send to.';
    if (v.mode === 'client' && (!v.remoteHost || !v.remotePort)) return 'A dialling link needs the analyser\'s address and port.';
    if (v.mode === 'file_drop' && !v.watchPath) return 'A watched link needs the folder the analyser writes into.';

    // Forwarding a copy to LHIMS from a link LHIMS already receives would post
    // the same result twice. Refused outright rather than warned about.
    if (v.forwardEnabled && v.role === 'lhims_owned') {
      return 'This link is recorded as one LHIMS already receives, so forwarding a copy to LHIMS would send the same result twice. Turn forwarding off, or correct the link\'s role.';
    }
    if (v.forwardEnabled && (!v.forwardHost || !v.forwardPort)) {
      return 'Forwarding needs the address and port of the LHIMS middleware to send to.';
    }

    // Never let a new link take a port an LHIMS-owned link uses.
    if (v.role !== 'lhims_owned' && v.mode === 'server' && v.listenPort) {
      const clash = db.prepare(`SELECT name FROM instrument_links
          WHERE role = 'lhims_owned' AND is_active = 1 AND (listen_port = ? OR remote_port = ?)
            AND (? IS NULL OR id != ?)`).get(v.listenPort, v.listenPort, id, id) as any;
      if (clash) {
        return `Port ${v.listenPort} is recorded as belonging to "${clash.name}", which LHIMS owns. Choose a different port — taking that one could stop the transmission that is working today.`;
      }
    }
    if (v.role !== 'lhims_owned' && v.mode === 'client' && v.remoteHost && v.remotePort) {
      const clash = db.prepare(`SELECT name FROM instrument_links
          WHERE role = 'lhims_owned' AND is_active = 1 AND remote_host = ? AND remote_port = ?
            AND (? IS NULL OR id != ?)`).get(v.remoteHost, v.remotePort, id, id) as any;
      if (clash) {
        return `${v.remoteHost}:${v.remotePort} is recorded as "${clash.name}", which LHIMS owns. Most analysers accept one host connection, so dialling it could drop the connection that is working today.`;
      }
    }

    // Two of our own links on one port is simply a mistake.
    if (v.mode === 'server' && v.listenPort && v.role !== 'lhims_owned') {
      const twin = db.prepare(`SELECT name FROM instrument_links
          WHERE is_active = 1 AND mode = 'server' AND listen_port = ? AND role != 'lhims_owned'
            AND (? IS NULL OR id != ?)`).get(v.listenPort, id, id) as any;
      if (twin) return `Port ${v.listenPort} is already used by "${twin.name}". Each analyser needs its own port.`;
    }
    return null;
  }

  router.post('/', requirePermission(MODULE, 'edit'), (req, res) => {
    const db = getDb();
    const v = body(req);
    const error = validate(db, v, null);
    if (error) return res.status(400).json({ error });

    const code = String(req.body?.linkCode ?? '').trim() || `LINK-${Date.now().toString(36).toUpperCase()}`;
    if (db.prepare('SELECT id FROM instrument_links WHERE link_code = ?').get(code)) {
      return res.status(409).json({ error: `A link with the code "${code}" already exists.` });
    }

    const result = db.prepare(`INSERT INTO instrument_links
        (link_code, name, equipment_id, section_id, profile_key, role, mode, protocol,
         listen_host, listen_port, remote_host, remote_port, watch_path, analyte_map, control_patterns,
         forward_enabled, forward_host, forward_port, auto_start, is_active, notes, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(code, v.name, v.equipmentId, v.sectionId, v.profileKey, v.role, v.mode, v.protocol,
        v.listenHost, v.listenPort, v.remoteHost, v.remotePort, v.watchPath, v.analyteMap, v.controlPatterns,
        v.forwardEnabled, v.forwardHost, v.forwardPort, v.autoStart, v.isActive, v.notes, req.user!.id);

    const id = Number(result.lastInsertRowid);
    if (v.isActive && v.autoStart) bridge.restart(id);
    audit(req, { action: 'create', entity: 'instrument_links', entityId: id, newValue: { code, ...v, analyteMap: undefined } });
    res.status(201).json({ id, linkCode: code, ...currentState(db, id) });
  });

  router.put('/:id', numericOnly, requirePermission(MODULE, 'edit'), (req, res) => {
    const db = getDb();
    const existing = db.prepare('SELECT * FROM instrument_links WHERE id = ?').get(req.params.id) as any;
    if (!existing) return res.status(404).json({ error: 'Link not found' });
    const v = body(req, existing);
    const error = validate(db, v, Number(req.params.id));
    if (error) return res.status(400).json({ error });

    db.prepare(`UPDATE instrument_links SET name = ?, equipment_id = ?, section_id = ?, profile_key = ?,
        role = ?, mode = ?, protocol = ?, listen_host = ?, listen_port = ?, remote_host = ?, remote_port = ?,
        watch_path = ?, analyte_map = ?, control_patterns = ?, forward_enabled = ?, forward_host = ?,
        forward_port = ?, auto_start = ?, is_active = ?, notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(v.name, v.equipmentId, v.sectionId, v.profileKey, v.role, v.mode, v.protocol,
        v.listenHost, v.listenPort, v.remoteHost, v.remotePort, v.watchPath, v.analyteMap, v.controlPatterns,
        v.forwardEnabled, v.forwardHost, v.forwardPort, v.autoStart, v.isActive, v.notes, req.params.id);

    // Settings changed means the socket has to be rebuilt; a link that is now
    // LHIMS's, or now inactive, is stopped rather than restarted.
    bridge.restart(Number(req.params.id));
    audit(req, { action: 'edit', entity: 'instrument_links', entityId: req.params.id, oldValue: { role: existing.role, port: existing.listen_port }, newValue: { role: v.role, port: v.listenPort } });
    res.json(currentState(db, Number(req.params.id)));
  });

  router.delete('/:id', numericOnly, requirePermission(MODULE, 'edit'), (req, res) => {
    const db = getDb();
    const existing = db.prepare('SELECT * FROM instrument_links WHERE id = ?').get(req.params.id) as any;
    if (!existing) return res.status(404).json({ error: 'Link not found' });
    bridge.stopLink(Number(req.params.id));
    // Deactivated, not deleted: the messages it received are a record of what
    // the analyser actually sent.
    db.prepare("UPDATE instrument_links SET is_active = 0, state = 'stopped', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
    audit(req, { action: 'delete', entity: 'instrument_links', entityId: req.params.id, oldValue: existing });
    res.json({ ok: true });
  });

  /* ======================================================================
     Running them
     ==================================================================== */
  router.post('/:id/start', numericOnly, requirePermission(MODULE, 'edit'), (req, res) => {
    const db = getDb();
    const link = db.prepare('SELECT * FROM instrument_links WHERE id = ?').get(req.params.id) as any;
    if (!link) return res.status(404).json({ error: 'Link not found' });
    if (link.role === 'lhims_owned') {
      return res.status(400).json({
        error: 'This link is recorded as one LHIMS owns. SECHLIMS deliberately does not open it, so the transmission that is working today is not disturbed. Change its role only if LHIMS has genuinely stopped using it.',
      });
    }
    bridge.restart(Number(req.params.id));
    audit(req, { action: 'edit', entity: 'instrument_links', entityId: req.params.id, newValue: { started: true } });
    res.json(currentState(db, Number(req.params.id)));
  });

  router.post('/:id/stop', numericOnly, requirePermission(MODULE, 'edit'), (req, res) => {
    bridge.stopLink(Number(req.params.id));
    audit(req, { action: 'edit', entity: 'instrument_links', entityId: req.params.id, newValue: { stopped: true } });
    res.json(currentState(getDb(), Number(req.params.id)));
  });

  function currentState(db: any, id: number) {
    const row = db.prepare('SELECT * FROM instrument_links WHERE id = ?').get(id) as any;
    if (!row) return null;
    return { ...row, analyte_map: json(row.analyte_map, {}), control_patterns: json(row.control_patterns, []), running: bridge.isRunning(id) };
  }

  /* ======================================================================
     What the analyser has said
     ==================================================================== */
  router.get('/:id/messages', numericOnly, requirePermission(MODULE, 'view'), (req, res) => {
    const db = getDb();
    const kind = typeof req.query.kind === 'string' ? req.query.kind : null;
    const rows = db.prepare(`SELECT m.*, f.status AS feed_status FROM instrument_messages m
        LEFT JOIN iqc_feed_messages f ON f.id = m.iqc_feed_message_id
        WHERE m.link_id = ? AND (? IS NULL OR m.kind = ?)
        ORDER BY m.id DESC LIMIT 100`).all(req.params.id, kind, kind) as any[];
    res.json(rows.map(row => ({
      ...row,
      parsed_values: json(row.parsed_values, []),
      // The raw text is what somebody maps a new analyser from, but a hundred
      // full transmissions is a great deal to send to a browser.
      raw_message: String(row.raw_message ?? '').slice(0, 4000),
    })));
  });

  /**
   * Play a message at a link without an analyser in the room.
   *
   * This is how a laboratory proves the mapping before trusting it: paste a
   * transmission the analyser actually produced, and see exactly which analytes
   * it would have produced and whether it would have been read as a control.
   * Nothing is stored — it answers a question, it does not make a record.
   */
  router.post('/:id/simulate', numericOnly, requirePermission(MODULE, 'view'), (req, res) => {
    const db = getDb();
    const link = db.prepare('SELECT * FROM instrument_links WHERE id = ?').get(req.params.id) as any;
    if (!link) return res.status(404).json({ error: 'Link not found' });
    const text = String(req.body?.text ?? '');
    if (!text.trim()) return res.status(400).json({ error: 'Paste a transmission to try.' });

    const linkMap = json<Record<string, string>>(link.analyte_map, {});
    const patterns = json<string[]>(link.control_patterns, []);
    let parsed;
    try { parsed = parseFor(link.protocol, text); }
    catch (error) { return res.status(400).json({ error: `That could not be read as ${link.protocol}: ${(error as Error).message}` }); }

    res.json({
      protocol: link.protocol,
      messages: parsed.map(message => ({
        sampleId: message.sampleId,
        lotNumber: message.lotNumber,
        instrument: message.instrument,
        runAt: message.runAt,
        wouldBeTreatedAs: message.results.length === 0 ? 'unknown'
          : (looksLikeControl(message.sampleId, patterns) || looksLikeControl(message.lotNumber, patterns)) ? 'control' : 'patient',
        results: message.results.map(result => ({
          code: result.code,
          analyte: mapAnalyte(result.code, linkMap, link.profile_key),
          mapped: mapAnalyte(result.code, linkMap, link.profile_key) !== result.code,
          value: result.value, unit: result.unit, flag: result.flag,
        })),
      })),
    });
  });

  return router;
}
