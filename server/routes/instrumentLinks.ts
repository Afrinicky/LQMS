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
  DEFAULT_CONTROL_PATTERNS, looksLikeControl, mapAnalyte, modeIsPassive, profileByKey,
} from '../../shared/constants/instruments.js';
import {
  LHIMS_MEASURE_MAPS, LHIMS_TAP_FILENAME, LHIMS_TAP_SETUP_STEPS,
  lhimsMapByKey, lhimsMeasureId,
} from '../../shared/constants/lhims.js';

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
      // What LHIMS calls each parameter, taken from this laboratory's own
      // client configuration files.
      lhimsMaps: LHIMS_MEASURE_MAPS.map(m => ({
        key: m.key, label: m.label, vendor: m.vendor,
        sourceConfig: m.sourceConfig, measureCount: Object.keys(m.measures).length,
      })),
      tap: { filename: LHIMS_TAP_FILENAME, steps: LHIMS_TAP_SETUP_STEPS },
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

    res.json(rows.map(row => shape(row)));
  });

  /**
   * A link as the browser may see it.
   *
   * The LHIMS password is stored because delivery is unattended and has to
   * survive a restart — but it is never sent back out. The screen is told
   * whether one is set, which is all it needs to draw the form honestly.
   */
  function shape(row: any) {
    const { lhims_password, ...rest } = row;
    return {
      ...rest,
      analyte_map: json<Record<string, string>>(row.analyte_map, {}),
      control_patterns: json<string[]>(row.control_patterns, []),
      measure_map: json<Record<string, number>>(row.measure_map, {}),
      lhims_password_set: Boolean(lhims_password),
      running: bridge.isRunning(row.id),
    };
  }

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
      forwardTarget: String(pick(b.forwardTarget, existing.forward_target) ?? 'lhims_api'),
      lhimsUrl: pick(b.lhimsUrl, existing.lhims_url) ?? null,
      lhimsUsername: pick(b.lhimsUsername, existing.lhims_username) ?? null,
      // An absent password keeps whatever is stored; an empty string clears it.
      lhimsPassword: b.lhimsPassword === undefined ? (existing.lhims_password ?? null)
        : (String(b.lhimsPassword) || null),
      lhimsMapKey: pick(b.lhimsMapKey, existing.lhims_map_key) ?? null,
      measureMap: b.measureMap !== undefined ? JSON.stringify(b.measureMap ?? {}) : (existing.measure_map ?? null),
      tapPath: pick(b.tapPath, existing.tap_path) ?? null,
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
    if (v.mode === 'lhims_tap' && !v.tapPath) {
      return `Following the LHIMS client needs the path to its ${LHIMS_TAP_FILENAME}. Set WRITE_TO_FILE = Yes in the client first, then point this at the file it writes.`;
    }

    // Delivering to LHIMS needs somewhere to deliver to, and a way to name each
    // parameter in LHIMS's own terms.
    // The safety rule comes first, and on its own. A link LHIMS already receives
    // must never deliver back into LHIMS — that stores one result twice — and
    // telling somebody their URL is missing when the real answer is "not this
    // link, ever" sends them off to fill in fields that will not help.
    if (v.forwardEnabled && v.role === 'lhims_owned') {
      return 'This link is recorded as one LHIMS already receives, so carrying its results to LHIMS would store the same result twice. Turn it off, or correct the link\'s role.';
    }

    // A raw TCP hand-off needs an address; delivery to the LHIMS API needs a
    // URL instead. Demanding both is what made the API route impossible to
    // configure.
    if (v.forwardEnabled && v.forwardTarget === 'tcp' && (!v.forwardHost || !v.forwardPort)) {
      return 'Handing the raw transmission to another program needs its address and port.';
    }
    if (v.forwardEnabled && v.forwardTarget !== 'tcp') {
      if (!v.lhimsUrl || !v.lhimsUsername) {
        return 'Carrying results to LHIMS needs its address and the username the middleware uses.';
      }
      if (!v.lhimsMapKey && !v.measureMap) {
        return 'Carrying results to LHIMS needs to know what LHIMS calls each parameter. Choose the analyser\'s LHIMS map, or set the measure ids by hand.';
      }
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
         forward_enabled, forward_host, forward_port, forward_target, lhims_url, lhims_username,
         lhims_password, lhims_map_key, measure_map, tap_path, auto_start, is_active, notes, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(code, v.name, v.equipmentId, v.sectionId, v.profileKey, v.role, v.mode, v.protocol,
        v.listenHost, v.listenPort, v.remoteHost, v.remotePort, v.watchPath, v.analyteMap, v.controlPatterns,
        v.forwardEnabled, v.forwardHost, v.forwardPort, v.forwardTarget, v.lhimsUrl, v.lhimsUsername,
        v.lhimsPassword, v.lhimsMapKey, v.measureMap, v.tapPath, v.autoStart, v.isActive, v.notes, req.user!.id);

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
        forward_port = ?, forward_target = ?, lhims_url = ?, lhims_username = ?, lhims_password = ?,
        lhims_map_key = ?, measure_map = ?, tap_path = ?,
        auto_start = ?, is_active = ?, notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(v.name, v.equipmentId, v.sectionId, v.profileKey, v.role, v.mode, v.protocol,
        v.listenHost, v.listenPort, v.remoteHost, v.remotePort, v.watchPath, v.analyteMap, v.controlPatterns,
        v.forwardEnabled, v.forwardHost, v.forwardPort, v.forwardTarget, v.lhimsUrl, v.lhimsUsername,
        v.lhimsPassword, v.lhimsMapKey, v.measureMap, v.tapPath,
        v.autoStart, v.isActive, v.notes, req.params.id);

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
    if (link.role === 'lhims_owned' && !modeIsPassive(link.mode)) {
      return res.status(400).json({
        error: 'This link is recorded as one LHIMS owns, and it is set to bind or dial. SECHLIMS deliberately does not open it, so the transmission working today is not disturbed. To take a COPY of this analyser instead, set the link to follow the LHIMS client\'s log — that reads a file and touches nothing.',
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
    return row ? shape(row) : null;
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
    const measureOverrides = json<Record<string, number>>(link.measure_map, {});
    let parsed;
    try { parsed = parseFor(link.protocol, text); }
    catch (error) { return res.status(400).json({ error: `That could not be read as ${link.protocol}: ${(error as Error).message}` }); }

    const carriesToLhims = Boolean(link.forward_enabled) && link.forward_target !== 'tcp';
    const unmapped = new Set<string>();

    const messages = parsed.map(message => {
      const kind = message.results.length === 0 ? 'unknown'
        : (looksLikeControl(message.sampleId, patterns) || looksLikeControl(message.lotNumber, patterns)) ? 'control' : 'patient';
      return {
        sampleId: message.sampleId,
        lotNumber: message.lotNumber,
        instrument: message.instrument,
        runAt: message.runAt,
        wouldBeTreatedAs: kind,
        // Only a patient result goes to LHIMS; a control belongs on the IQC
        // board and has no patient record to be filed under.
        wouldGoToLhims: carriesToLhims && kind === 'patient',
        results: message.results.map(result => {
          const analyte = mapAnalyte(result.code, linkMap, link.profile_key);
          const measureId = lhimsMeasureId(result.code, measureOverrides, link.lhims_map_key);
          if (carriesToLhims && kind === 'patient' && !measureId) unmapped.add(result.code);
          return {
            code: result.code,
            analyte,
            mapped: analyte !== result.code,
            value: result.value, unit: result.unit, flag: result.flag,
            lhimsMeasureId: measureId,
          };
        }),
      };
    });

    res.json({
      protocol: link.protocol,
      carriesToLhims,
      lhimsMap: link.lhims_map_key ? (lhimsMapByKey(link.lhims_map_key)?.label ?? link.lhims_map_key) : null,
      // Named rather than counted: these are the parameters LHIMS would not
      // receive, and the whole point of trying a message first is to find them.
      unmappedForLhims: [...unmapped],
      messages,
    });
  });

  return router;
}
