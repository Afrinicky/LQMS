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
 *   POST   /instrument-links/:id/fetch       look now, rather than wait to be sent to
 *   POST   /instrument-links/fetch-all       look on every link that can be looked at
 *   GET    /instrument-links/overview        is analyser transmission working?
 *   GET    /instrument-links/:id/files       which files this link has read
 *   GET    /instrument-links/host            the addresses to set the analyser to
 *   GET    /instrument-links/:id/checks      what is left before this link transmits
 *   POST   /instrument-links/:id/self-test   is the port actually open and reachable
 *   GET    /instrument-links/:id/activity    what has arrived, by kind, over time
 *
 * The whole surface is administrative — connecting an analyser is not bench
 * work — so it takes the IQC module's own edit right, and the safety rules the
 * bridge enforces are stated back to the caller rather than left implicit.
 */
import { Router } from 'express';
import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
import { getDb } from '../db/database.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import { audit } from '../services/auditService.js';
import { parseIntNullable } from './routeHelpers.js';
import { getBridge, resolveTapTarget } from '../services/instrumentBridge/index.js';
import { cleanTransmission, detectProtocol, effectiveProtocol, parseFor } from '../services/instrumentBridge/protocols.js';
import {
  INSTRUMENT_PROFILES, LINK_MODES, LINK_PROTOCOLS, LINK_ROLES, LINK_ROLE_LABELS,
  DEFAULT_CONTROL_PATTERNS, classifyMessage, mapAnalyte, modeIsPassive, profileByKey,
  linkIsOurs, LINK_STATE_LABELS,
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

/** Can this host see the path at all? A share that has gone is the usual answer. */
function fs_exists(target?: string | null): boolean {
  if (!target) return false;
  try { fs.accessSync(target, fs.constants.R_OK); return true; } catch { return false; }
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
      // Looking, as well as being sent to.
      fetchEnabled: b.fetchEnabled !== undefined ? (b.fetchEnabled ? 1 : 0) : (existing.fetch_enabled ?? 0),
      fetchIntervalSeconds: b.fetchIntervalSeconds !== undefined
        ? Math.max(30, Number(b.fetchIntervalSeconds) || 300) : (existing.fetch_interval_seconds ?? 300),
      filePattern: pick(b.filePattern, existing.file_pattern) ?? null,
      archivePath: pick(b.archivePath, existing.archive_path) ?? null,
      deleteAfterRead: b.deleteAfterRead !== undefined ? (b.deleteAfterRead ? 1 : 0) : (existing.delete_after_read ?? 0),
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
      return `Following the LHIMS client needs the path to its ${LHIMS_TAP_FILENAME}, or to the folder holding it. Set WRITE_TO_FILE = Yes in the client first, then point this at the file it writes.`;
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

    // Deleting the analyser's own export and moving it aside are alternatives,
    // not a pair. Doing both would delete the archive it was just moved into.
    if (v.deleteAfterRead && v.archivePath) {
      return 'Choose one: move each file to an archive folder after reading it, or delete it. Doing both would delete the copy that was just archived.';
    }
    // Fetching is for the modes that can be asked. A listening socket has
    // nothing to fetch — the analyser decides when to transmit — and offering
    // a schedule that can never do anything is worse than not offering it.
    if (v.fetchEnabled && v.mode !== 'file_drop' && v.mode !== 'lhims_tap') {
      return 'Only a watched folder or the LHIMS client\'s log can be fetched on a schedule. A link the analyser connects to receives whenever the analyser sends.';
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
         lhims_password, lhims_map_key, measure_map, tap_path,
         fetch_enabled, fetch_interval_seconds, file_pattern, archive_path, delete_after_read,
         auto_start, is_active, notes, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(code, v.name, v.equipmentId, v.sectionId, v.profileKey, v.role, v.mode, v.protocol,
        v.listenHost, v.listenPort, v.remoteHost, v.remotePort, v.watchPath, v.analyteMap, v.controlPatterns,
        v.forwardEnabled, v.forwardHost, v.forwardPort, v.forwardTarget, v.lhimsUrl, v.lhimsUsername,
        v.lhimsPassword, v.lhimsMapKey, v.measureMap, v.tapPath,
        v.fetchEnabled, v.fetchIntervalSeconds, v.filePattern, v.archivePath, v.deleteAfterRead,
        v.autoStart, v.isActive, v.notes, req.user!.id);

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
        fetch_enabled = ?, fetch_interval_seconds = ?, file_pattern = ?, archive_path = ?, delete_after_read = ?,
        auto_start = ?, is_active = ?, notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(v.name, v.equipmentId, v.sectionId, v.profileKey, v.role, v.mode, v.protocol,
        v.listenHost, v.listenPort, v.remoteHost, v.remotePort, v.watchPath, v.analyteMap, v.controlPatterns,
        v.forwardEnabled, v.forwardHost, v.forwardPort, v.forwardTarget, v.lhimsUrl, v.lhimsUsername,
        v.lhimsPassword, v.lhimsMapKey, v.measureMap, v.tapPath,
        v.fetchEnabled, v.fetchIntervalSeconds, v.filePattern, v.archivePath, v.deleteAfterRead,
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
     Fetching
     ----------------------------------------------------------------------
     Everything above is built around being pushed to: the analyser dials in,
     or writes a file, and something arrives. That is how transmission normally
     works, and it leaves two things impossible — proving a new link works
     without waiting for the analyser to decide to send something, and catching
     up after this host has been switched off for an afternoon.

     So a link can be asked to look. Only the modes that CAN look answer it: a
     listening socket has nothing to fetch, because the analyser holds what it
     has not sent yet, and a button that appears to do something and does not
     is worse than no button.
     ==================================================================== */
  router.post('/:id/fetch', numericOnly, requirePermission(MODULE, 'view'), (req, res) => {
    const db = getDb();
    const link = db.prepare('SELECT * FROM instrument_links WHERE id = ?').get(req.params.id) as any;
    if (!link) return res.status(404).json({ error: 'Link not found' });
    const outcome = bridge.fetchNow(Number(req.params.id));
    audit(req, { action: 'edit', entity: 'instrument_links', entityId: req.params.id, newValue: { fetched: true, read: outcome.read } });
    res.json({ ...outcome, link: currentState(db, Number(req.params.id)) });
  });

  /**
   * Look on every link that can be looked at.
   *
   * The one button somebody presses after the host has been off overnight. An
   * LHIMS-owned link is skipped rather than attempted, because fetching it
   * would mean opening it, and that is the one thing this bridge never does.
   */
  router.post('/fetch-all', requirePermission(MODULE, 'view'), (req, res) => {
    const db = getDb();
    // A link following a client's log is included even when the analyser is
    // LHIMS's: reading that file is the one thing that touches nothing, and it
    // is the link most likely to need catching up after a host has been off.
    // Anything that would BIND or DIAL an LHIMS-owned analyser is still skipped.
    const links = db.prepare(`SELECT id, name FROM instrument_links
        WHERE is_active = 1 AND mode IN ('file_drop', 'lhims_tap')
          AND (role != 'lhims_owned' OR mode = 'lhims_tap')
        ORDER BY name`).all() as any[];
    const results = links.map(link => {
      // One link's folder being unreachable must not stop the rest being read.
      try { return { id: link.id, name: link.name, ...bridge.fetchNow(link.id) }; }
      catch (error) { return { id: link.id, name: link.name, ok: false, read: 0, note: (error as Error).message }; }
    });
    const read = results.reduce((sum, r) => sum + Number(r.read ?? 0), 0);
    audit(req, { action: 'edit', entity: 'instrument_links', entityId: 0, newValue: { fetchedAll: links.length, read } });
    res.json({
      checked: links.length,
      read,
      note: links.length === 0
        ? 'No link on this system is set up to be fetched. A watched folder or the LHIMS client\'s log can be; an analyser that connects to SECHLIMS sends when it is ready.'
        : read ? `${read} new item(s) read across ${links.length} link(s).` : `Nothing new on any of the ${links.length} link(s) checked.`,
      results,
    });
  });

  /* ======================================================================
     Getting a link to transmit
     ----------------------------------------------------------------------
     Everything below answers the question somebody actually has in front of
     this screen: I set a link up and nothing arrives — why, and what do I do
     about it. Before this, the state said "listening" and the analyser said
     nothing, and there was nowhere to look.
     ==================================================================== */

  /**
   * What to type into the analyser.
   *
   * An analyser is configured by walking to it and entering a host address and
   * a port. The address is this machine's, and nobody should have to find it
   * from a command prompt in another room.
   */
  router.get('/host', requirePermission(MODULE, 'view'), (_req, res) => {
    const addresses: Array<{ name: string; address: string }> = [];
    const interfaces = os.networkInterfaces();
    for (const [name, list] of Object.entries(interfaces)) {
      for (const entry of list ?? []) {
        // IPv4 only, and not the loopback: an analyser on the bench cannot
        // reach 127.0.0.1, and offering it is how an afternoon is lost.
        if (entry.family !== 'IPv4' || entry.internal) continue;
        addresses.push({ name, address: entry.address });
      }
    }
    res.json({ hostname: os.hostname(), addresses });
  });

  /**
   * What is left before this link transmits.
   *
   * A checklist rather than a state word, because "listening" and "nothing has
   * ever arrived" are both true at the same time and only the second one is
   * actionable. Each check says what it found and, where there is one, the
   * thing to change.
   */
  router.get('/:id/checks', numericOnly, requirePermission(MODULE, 'view'), (req, res) => {
    const db = getDb();
    const link = db.prepare('SELECT * FROM instrument_links WHERE id = ?').get(req.params.id) as any;
    if (!link) return res.status(404).json({ error: 'Link not found' });

    const checks: Array<{ key: string; label: string; status: 'ok' | 'todo' | 'warn' | 'info'; detail: string; fix?: string }> = [];
    const add = (key: string, label: string, status: 'ok' | 'todo' | 'warn' | 'info', detail: string, fix?: string) =>
      checks.push({ key, label, status, detail, ...(fix ? { fix } : {}) });

    /* 1 — will the bridge open it at all? The one that catches most people. */
    const opens = linkIsOurs(link.role, link.mode);
    if (!opens) {
      add('opens', 'SECHLIMS will open this link', 'todo',
        'This link is recorded as one LHIMS owns and is set to bind or dial, so SECHLIMS deliberately never opens it. '
        + 'Nothing will ever arrive here while that is true — which is the safety rule working, not a fault.',
        'Set "How it is reached" to follow the LHIMS client\'s log. That reads a file rather than touching the '
        + 'connection, so the transmission LHIMS owns is untouched and SECHLIMS gets a copy of everything it receives.');
    } else {
      add('opens', 'SECHLIMS will open this link', 'ok',
        link.role === 'lhims_owned'
          ? 'It reads the LHIMS client\'s own log, which touches nothing.'
          : 'This analyser is not transmitting anywhere else, so SECHLIMS takes it.');
    }

    /* 2 — is it actually up right now? */
    const running = bridge.isRunning(link.id);
    if (!opens) add('running', 'It is running', 'info', 'Not applicable while the link is left alone.');
    else if (running) add('running', 'It is running', 'ok', link.state_detail || LINK_STATE_LABELS[link.state as never] || link.state);
    else {
      add('running', 'It is running', 'todo',
        link.last_error ? `It is not running. ${link.last_error}` : 'It is not running.',
        link.is_active ? 'Press Start on the link.' : 'The link is retired. Switch it back on first.');
    }

    /* 3 — what the analyser has to be pointed at */
    if (link.mode === 'server') {
      add('address', 'The analyser is pointed here', link.messages_received > 0 ? 'ok' : 'todo',
        link.listen_port
          ? `Set the analyser's host communication to this machine's address, port ${link.listen_port}.`
          : 'No port is set, so there is nothing for the analyser to send to.',
        link.listen_port ? undefined : 'Give the link the port the analyser transmits on.');
    } else if (link.mode === 'client') {
      add('address', 'SECHLIMS can reach the analyser', link.messages_received > 0 ? 'ok' : 'todo',
        link.remote_host ? `It dials ${link.remote_host}:${link.remote_port ?? '—'}.` : 'No analyser address is set.',
        link.remote_host ? undefined : 'Give the link the analyser\'s address and port.');
    } else if (link.mode === 'file_drop') {
      add('address', 'The folder exists', link.watch_path ? (fs_exists(link.watch_path) ? 'ok' : 'todo') : 'todo',
        link.watch_path
          ? (fs_exists(link.watch_path) ? `Watching ${link.watch_path}.` : `${link.watch_path} cannot be reached from this host.`)
          : 'No folder is set.',
        link.watch_path && fs_exists(link.watch_path) ? undefined : 'Point the link at the folder the analyser exports into.');
    } else {
      // A folder is the answer most people give to "where is the client", so a
      // folder is resolved to the log inside it rather than reported as fine
      // and then followed as though a directory had bytes in it. That was the
      // silent failure: a readable path, a running link, and nothing to read.
      const target = resolveTapTarget(link.tap_path);
      add('address', 'The client\'s log can be read', target.file ? 'ok' : 'todo',
        link.tap_path ? target.note : `No path to ${LHIMS_TAP_FILENAME} is set.`,
        target.file ? undefined
          : `Switch WRITE_TO_FILE on in the client and point the link at the ${LHIMS_TAP_FILENAME} it writes, or at the folder holding it.`);
    }

    /* 4 — has anything ever actually arrived? */
    const counts = db.prepare(`SELECT
        COUNT(*) AS total,
        SUM(kind = 'control') AS controls,
        SUM(kind = 'patient') AS patients,
        SUM(kind = 'unknown') AS unknown,
        MAX(received_at) AS last_at
      FROM instrument_messages WHERE link_id = ?`).get(link.id) as any;
    add('received', 'The analyser has reached it', Number(counts?.total ?? 0) > 0 ? 'ok' : 'todo',
      Number(counts?.total ?? 0) > 0
        ? `${counts.total} message(s) received, the last at ${String(counts.last_at ?? '').slice(0, 16).replace('T', ' ')}.`
        : 'Nothing has ever arrived on this link.',
      Number(counts?.total ?? 0) > 0 ? undefined
        : 'Run a sample on the analyser and transmit it as you normally would. If nothing appears, check the address and port above on the analyser itself.');

    /* 5 — is what arrived being understood? */
    const linkMap = json<Record<string, string>>(link.analyte_map, {});
    const recent = db.prepare(`SELECT parsed_values FROM instrument_messages
        WHERE link_id = ? AND result_count > 0 ORDER BY id DESC LIMIT 20`).all(link.id) as any[];
    const unmapped = new Set<string>();
    for (const row of recent) {
      for (const value of json<any[]>(row.parsed_values, [])) {
        const code = String(value.code ?? value.analyte ?? '');
        if (!code) continue;
        if (mapAnalyte(code, linkMap, link.profile_key) === code && !linkMap[code]) unmapped.add(code);
      }
    }
    if (recent.length === 0) {
      add('mapping', 'Its parameters are recognised', 'info', 'Nothing has arrived to check yet.');
    } else if (unmapped.size === 0) {
      add('mapping', 'Its parameters are recognised', 'ok', 'Every parameter in the recent messages has a name this system uses.');
    } else {
      add('mapping', 'Its parameters are recognised', 'warn',
        `${[...unmapped].slice(0, 12).join(', ')} came through under the analyser's own name and matched nothing.`,
        'Choose the right analyser under "Which analyser it is", or add these to the link\'s own parameter map.');
    }

    /* 5b — is the protocol the right one? A link reading messages it cannot
       understand looks exactly like a link reading nothing. */
    {
      const sample = db.prepare(`SELECT raw_message, result_count FROM instrument_messages
          WHERE link_id = ? ORDER BY id DESC LIMIT 5`).all(link.id) as any[];
      if (sample.length) {
        const barren = sample.filter(r => Number(r.result_count ?? 0) === 0);
        const detected = detectProtocol(String(sample[0].raw_message ?? ''));
        const configured = String(link.protocol ?? 'astm');
        if (barren.length === sample.length && detected && detected !== configured && configured !== 'auto') {
          add('protocol', 'It is being read as the right protocol', 'warn',
            `This link is set to ${configured.toUpperCase()}, but what arrived looks like ${detected.toUpperCase()}, and no result came out of it.`,
            `Set "What it speaks" to ${detected.toUpperCase()}, or to "work it out from what arrives".`);
        } else if (configured === 'auto') {
          add('protocol', 'It is being read as the right protocol', 'ok',
            detected ? `Read as ${detected.toUpperCase()}, worked out from what the analyser actually sends.` : 'Worked out from each message as it arrives.');
        }
      }
    }

    /* 6 — are controls being told apart from patients? */
    add('kinds', 'Controls are told apart from patients',
      Number(counts?.total ?? 0) === 0 ? 'info' : Number(counts?.unknown ?? 0) > 0 ? 'warn' : 'ok',
      Number(counts?.total ?? 0) === 0
        ? 'Nothing has arrived to sort yet.'
        : `${Number(counts?.controls ?? 0)} control run(s), ${Number(counts?.patients ?? 0)} patient result(s)`
          + (Number(counts?.unknown ?? 0) ? `, and ${counts.unknown} message(s) with nothing readable in them.` : '.'),
      Number(counts?.unknown ?? 0) > 0
        ? 'Open Messages and look at one. A message with no results in it usually means the protocol is set to the wrong one.'
        : undefined);

    /* 7 — where patient results go */
    if (link.forward_enabled) {
      const ready = link.forward_target === 'tcp'
        ? Boolean(link.forward_host && link.forward_port)
        : Boolean(link.lhims_url && link.lhims_username && link.lhims_map_key);
      add('patients', 'Patient results are carried onward', ready ? 'ok' : 'todo',
        ready
          ? (link.forward_target === 'tcp'
            ? `Handed to ${link.forward_host}:${link.forward_port}.`
            : 'Posted to LHIMS as the middleware does. Control runs are never sent.')
          : 'Carrying patient results onward is switched on but not fully set up, so nothing is being sent.',
        ready ? undefined : 'Fill in the address, the sign-in and the parameter map under Settings.');
    } else {
      add('patients', 'Patient results are kept here', Number(counts?.patients ?? 0) > 0 ? 'ok' : 'info',
        Number(counts?.patients ?? 0) > 0
          ? `${counts.patients} patient result(s) held on this link. They can be enrolled as previously run samples for QC when a control lot runs out.`
          : 'Patient results this analyser sends are kept on the link, and can be enrolled as previously run samples for QC.');
    }

    const pending = db.prepare(`SELECT COUNT(*) AS n FROM instrument_messages
        WHERE link_id = ? AND forward_status = 'failed'`).get(link.id) as any;
    if (Number(pending?.n ?? 0) > 0) {
      add('forward_failed', 'Everything sent onward was accepted', 'warn',
        `${pending.n} result(s) were refused by the far end.`,
        'Open Messages and read the refusal on one of them.');
    }

    const outstanding = checks.filter(c => c.status === 'todo').length;
    res.json({
      linkId: link.id,
      transmitting: outstanding === 0 && Number(counts?.total ?? 0) > 0,
      outstanding,
      counts: {
        total: Number(counts?.total ?? 0), controls: Number(counts?.controls ?? 0),
        patients: Number(counts?.patients ?? 0), unknown: Number(counts?.unknown ?? 0),
        lastAt: counts?.last_at ?? null,
      },
      checks,
    });
  });

  /**
   * Is the port actually open?
   *
   * The bridge saying "listening" is the bridge's own opinion. This opens a
   * connection to the port from this host and closes it again without sending
   * anything, which settles whether a listener is really there — and separates
   * "the port is not open" from "the analyser is not sending", which are two
   * completely different afternoons.
   */
  router.post('/:id/self-test', numericOnly, requirePermission(MODULE, 'view'), (req, res) => {
    const db = getDb();
    const link = db.prepare('SELECT * FROM instrument_links WHERE id = ?').get(req.params.id) as any;
    if (!link) return res.status(404).json({ error: 'Link not found' });

    if (link.mode === 'lhims_tap') {
      if (!link.tap_path) return res.json({ ok: false, note: 'No path is set on this link yet.' });
      // Readable is not the same as followable: a folder is readable and has
      // nothing to read. Settle which file this link is actually on.
      const target = resolveTapTarget(link.tap_path);
      if (!target.file) return res.json({ ok: false, note: target.note });
      let size = 0;
      try { size = fs.statSync(target.file).size; } catch { /* reported as unknown below */ }
      return res.json({ ok: true, note: `${target.note} It holds ${size.toLocaleString()} byte(s) at the moment.` });
    }

    if (link.mode === 'file_drop') {
      const target = link.watch_path;
      if (!target) return res.json({ ok: false, note: 'No path is set on this link yet.' });
      return res.json(fs_exists(target)
        ? { ok: true, note: `${target} is readable from this host.` }
        : { ok: false, note: `${target} cannot be reached from this host. Check the share, the spelling and this machine's permissions on it.` });
    }

    const host = link.mode === 'client' ? link.remote_host : (link.listen_host || '127.0.0.1');
    const port = link.mode === 'client' ? link.remote_port : link.listen_port;
    if (!port) return res.json({ ok: false, note: 'No port is set on this link yet.' });
    if (link.mode === 'client' && !host) return res.json({ ok: false, note: 'No analyser address is set on this link yet.' });

    const socket = new net.Socket();
    let answered = false;
    const answer = (ok: boolean, note: string) => {
      if (answered) return;
      answered = true;
      socket.destroy();
      res.json({ ok, note });
    };
    socket.setTimeout(3000);
    socket.once('connect', () => answer(true, link.mode === 'client'
      ? `The analyser answered on ${host}:${port}.`
      : `The port is open on this host: ${port} is accepting connections.`));
    socket.once('timeout', () => answer(false, `Nothing answered on ${host}:${port} within three seconds.`));
    socket.once('error', (error: Error) => answer(false, link.mode === 'client'
      ? `Could not reach the analyser on ${host}:${port} — ${error.message}`
      : `Port ${port} is not open on this host — ${error.message}. Start the link, and check nothing else is using the port.`));
    socket.connect(Number(port), String(host));
  });

  /**
   * What has arrived, so somebody can watch it arriving.
   *
   * The counts by kind and the last few messages, refreshed by the screen.
   * "Is it transmitting?" answered by watching it transmit is worth more than
   * any status word.
   */
  router.get('/:id/activity', numericOnly, requirePermission(MODULE, 'view'), (req, res) => {
    const db = getDb();
    const link = db.prepare('SELECT id, name, state, last_message_at FROM instrument_links WHERE id = ?').get(req.params.id) as any;
    if (!link) return res.status(404).json({ error: 'Link not found' });
    const byKind = db.prepare(`SELECT kind, COUNT(*) AS n FROM instrument_messages
        WHERE link_id = ? GROUP BY kind`).all(link.id) as any[];
    const today = db.prepare(`SELECT COUNT(*) AS n FROM instrument_messages
        WHERE link_id = ? AND date(received_at) = date('now')`).get(link.id) as any;
    const recent = db.prepare(`SELECT id, received_at, sample_id, lot_number, kind, result_count,
          forward_status, forward_error
        FROM instrument_messages WHERE link_id = ? ORDER BY id DESC LIMIT 30`).all(link.id);
    res.json({
      link,
      today: Number(today?.n ?? 0),
      byKind: Object.fromEntries(byKind.map(r => [r.kind, Number(r.n)])),
      recent,
    });
  });

  /**
   * The transmission as it happens.
   *
   * The LHIMS client puts the conversation on its own screen — connected,
   * message received, message sent, results transmitted — and a laboratory
   * running a sample can see whether it worked without waiting, refreshing or
   * guessing. This is the same thing for SECHLIMS: every step the bridge takes
   * with a message, in order, read from a cursor so a screen that was away for
   * a minute catches up rather than missing the transmission it was waiting for.
   *
   * It is a window, not a record. The record is written first, in full, and is
   * under Messages; this is what is happening right now.
   */
  router.get('/:id/events', numericOnly, requirePermission(MODULE, 'view'), (req, res) => {
    const db = getDb();
    // Everything the live window draws, so it can be opened from any screen
    // that knows a link's id and needs nothing else passed to it.
    const link = db.prepare(`SELECT l.id, l.name, l.mode, l.role, l.protocol, l.state, l.state_detail,
          l.listen_host, l.listen_port, l.remote_host, l.remote_port, l.watch_path, l.file_pattern,
          l.tap_path, l.tap_offset, l.last_message_at, l.messages_received,
          e.name AS equipment_name
        FROM instrument_links l LEFT JOIN equipment_items e ON e.id = l.equipment_id
        WHERE l.id = ?`).get(req.params.id) as any;
    if (!link) return res.status(404).json({ error: 'Link not found' });
    const after = Number(req.query.after ?? 0);
    const feed = bridge.events(Number(req.params.id), Number.isFinite(after) ? after : 0);
    res.json({
      link,
      // Which file is actually being followed, which is not always the path
      // that was typed — a folder resolves to the log inside it.
      following: link.mode === 'lhims_tap' ? resolveTapTarget(link.tap_path) : null,
      running: bridge.isRunning(link.id),
      ...feed,
    });
  });

  /**
   * Read a followed log again, from its beginning.
   *
   * Following a file starts at its end, because the point is to follow what
   * happens from now on. A laboratory that has just connected a link — or has
   * just had one put right — quite reasonably wants what the client already
   * wrote, and had no way to ask for it. Nothing is duplicated by asking:
   * every transmission is fingerprinted as it is recorded, so one that has
   * been read before is recognised and skipped.
   */
  router.post('/:id/rewind', numericOnly, requirePermission(MODULE, 'edit'), (req, res) => {
    const db = getDb();
    const link = db.prepare('SELECT * FROM instrument_links WHERE id = ?').get(req.params.id) as any;
    if (!link) return res.status(404).json({ error: 'Link not found' });
    if (link.mode !== 'lhims_tap') {
      return res.status(400).json({ error: 'Only a link following a client\'s log can be read again from the beginning.' });
    }
    if (!bridge.isRunning(link.id)) bridge.restart(link.id);
    const outcome = bridge.rewind(link.id);
    audit(req, { action: 'edit', entity: 'instrument_links', entityId: req.params.id, newValue: { rewound: true, read: outcome.read } });
    res.json({ ...outcome, link: currentState(db, Number(req.params.id)) });
  });

  /**
   * Is analyser transmission working?
   *
   * One answer, for the screen that has to give it. Before this, answering
   * meant opening every link in turn and reading its state, which is why
   * nobody could say.
   */
  router.get('/overview', requirePermission(MODULE, 'view'), (_req, res) => {
    res.json(bridge.overview());
  });

  /**
   * Which files this link has read.
   *
   * The record that makes a folder sweep safe, shown so somebody can see it:
   * a file that was read, when, and how many messages came out of it. "The
   * analyser definitely exported that run" is settled here rather than argued
   * about.
   */
  router.get('/:id/files', numericOnly, requirePermission(MODULE, 'view'), (req, res) => {
    const rows = getDb().prepare(`SELECT * FROM instrument_files WHERE link_id = ?
        ORDER BY id DESC LIMIT 200`).all(req.params.id);
    res.json(rows);
  });

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
    // Exactly what the bridge would do with it, including working out the
    // protocol from the text when the link is set to. A screen that promises
    // one thing and a bridge that does another is worse than no screen.
    const protocol = effectiveProtocol(link.protocol, text);
    let parsed;
    try { parsed = parseFor(protocol, text); }
    catch (error) { return res.status(400).json({ error: `That could not be read as ${protocol}: ${(error as Error).message}` }); }

    // The same control materials the bridge checks against, so a run named by
    // its own lot is recognised here too.
    const known = (() => {
      try {
        return (db.prepare('SELECT lot_number, material_code FROM iqc_materials WHERE is_active = 1').all() as any[])
          .flatMap(r => [r.lot_number, r.material_code]).filter(Boolean).map(String);
      } catch { return []; }
    })();

    const carriesToLhims = Boolean(link.forward_enabled) && link.forward_target !== 'tcp';
    const unmapped = new Set<string>();

    const messages = parsed.map(message => {
      const verdict = classifyMessage({
        sampleId: message.sampleId, lotNumber: message.lotNumber,
        controlHint: message.controlHint, knownControlIds: known,
      }, patterns);
      const kind = message.results.length === 0 ? 'unknown' : verdict.control ? 'control' : 'patient';
      return {
        sampleId: message.sampleId,
        lotNumber: message.lotNumber,
        instrument: message.instrument,
        runAt: message.runAt,
        wouldBeTreatedAs: kind,
        // Why, in the same words the live log uses, so somebody proving a link
        // can see the reasoning rather than only the verdict.
        because: verdict.because,
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
      protocol,
      // What the text itself looks like, which is how somebody finds out the
      // link is set to the wrong protocol.
      detectedProtocol: detectProtocol(text),
      configuredProtocol: link.protocol,
      // The transmission with its framing taken off, which is what the parser
      // actually reads. Pasting a capture straight out of a client's log and
      // seeing the records come out of it settles a great many arguments.
      clean: cleanTransmission(text).slice(0, 8_000),
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
