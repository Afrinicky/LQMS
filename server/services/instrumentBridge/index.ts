/**
 * The analyser bridge.
 *
 * THE FIRST RULE, and the one every decision below serves: an existing
 * transmission that works must not be disturbed.
 *
 * This laboratory's first haematology analyser talks to the national LHIMS
 * middleware and that link carries patient results. So the bridge is built to
 * stay out of its way, and it enforces that rather than trusting a person to
 * remember:
 *
 *   · A link recorded as LHIMS's is never started. Not "started carefully" —
 *     never. It sits in the register marked `blocked` so the laboratory can see
 *     the system knows about it and is leaving it alone.
 *
 *   · Before binding anything, the port is checked against every LHIMS-owned
 *     link, and refused if it collides. A typo in a port number must not be
 *     able to take the patient-results link down.
 *
 *   · The bridge is never IN the path. It does not proxy, intercept or relay
 *     the working link. It opens its OWN listener for analysers that transmit
 *     nowhere today — the second haematology analyser and both chemistry
 *     analysers — which is pure gain: three machines that currently reach
 *     nothing start reaching SECHLIMS, and nothing that works is touched.
 *
 *   · One link never affects another. Each has its own server, its own framer
 *     and its own error handling; a chemistry analyser sending rubbish cannot
 *     stop the haematology link, and a port that will not bind fails that link
 *     alone.
 *
 * Forwarding a copy ONWARD to the LHIMS middleware exists, and is off. It is
 * how LHIMS could eventually carry all four analysers, but that is a decision
 * the laboratory takes deliberately once this has proved itself — and it is
 * refused outright for a link LHIMS already receives, because two copies of one
 * result is a worse failure than none.
 */
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import {
  framerFor, parseFor, type Framer, type AnalyserMessage,
} from './protocols.js';
import {
  LINK_MAX_FRAME_BYTES, LINK_RECONNECT_MS, linkIsOurs, looksLikeControl, mapAnalyte,
} from '../../../shared/constants/instruments.js';

type DB = any;
type DbGetter = () => DB;

interface LinkRow {
  id: number; link_code: string; name: string;
  equipment_id: number | null; section_id: number | null;
  profile_key: string | null; role: string; mode: string; protocol: string;
  listen_host: string | null; listen_port: number | null;
  remote_host: string | null; remote_port: number | null;
  watch_path: string | null;
  analyte_map: string | null; control_patterns: string | null;
  forward_enabled: number; forward_host: string | null; forward_port: number | null;
  auto_start: number; is_active: number;
}

function json<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try { return (JSON.parse(value) ?? fallback) as T; } catch { return fallback; }
}

/* ============================================================================
   One link
   ========================================================================= */
class Link {
  readonly id: number;
  private getDb: DbGetter;
  private row: LinkRow;
  private server: net.Server | null = null;
  private socket: net.Socket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private idleTimers = new Map<net.Socket, NodeJS.Timeout>();
  private watcher: fs.FSWatcher | null = null;
  private stopping = false;
  /**
   * Whether this link actually opened anything.
   *
   * A blocked link is held in the bridge's map so its state can be reported,
   * but it has no socket and never will. Saying "running" next to the link
   * carrying patient results would be exactly the wrong thing to tell somebody
   * looking at this screen, so the two are kept apart.
   */
  private opened = false;

  constructor(getDb: DbGetter, row: LinkRow) {
    this.getDb = getDb;
    this.row = row;
    this.id = row.id;
  }

  private setState(state: string, detail?: string | null, error?: string | null) {
    try {
      this.getDb().prepare(`UPDATE instrument_links SET state = ?, state_detail = ?,
          last_error = COALESCE(?, last_error), updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(state, detail ?? null, error ?? null, this.id);
    } catch { /* a state note must never take the link down */ }
  }

  start(): void {
    this.stopping = false;
    this.opened = false;

    // The guard that matters. A link belonging to LHIMS is not started, and
    // the register says so rather than leaving somebody to wonder.
    if (!linkIsOurs(this.row.role)) {
      this.setState('blocked', 'LHIMS owns this link. SECHLIMS is deliberately not binding or dialling it, so the existing transmission is untouched.');
      return;
    }
    if (!this.row.is_active) { this.setState('stopped', 'Switched off'); return; }
    this.opened = true;

    if (this.row.mode === 'file_drop') return this.startWatcher();
    if (this.row.mode === 'client') return this.startClient();
    return this.startServer();
  }

  /* ---------------------------------------------------------------- server */
  private startServer(): void {
    const port = Number(this.row.listen_port);
    if (!Number.isFinite(port) || port <= 0) {
      this.setState('error', 'No port set for this link.', 'No port set');
      this.opened = false;
      return;
    }

    // Never bind a port an LHIMS-owned link uses. A mistyped port must not be
    // able to steal the patient-results link's socket.
    const clash = this.getDb().prepare(`SELECT name FROM instrument_links
        WHERE id != ? AND role = 'lhims_owned' AND is_active = 1
          AND (listen_port = ? OR remote_port = ?)`).get(this.id, port, port) as any;
    if (clash) {
      this.setState('blocked',
        `Port ${port} is recorded as belonging to "${clash.name}", which LHIMS owns. This link has not been started — change its port, or correct the other link's record.`,
        `Port ${port} reserved for an LHIMS-owned link`);
      this.opened = false;
      return;
    }

    const server = net.createServer(socket => this.attach(socket, 'inbound'));
    server.on('error', (error: NodeJS.ErrnoException) => {
      this.opened = false;
      const message = error.code === 'EADDRINUSE'
        ? `Port ${port} is already in use on this machine. Something else — very likely the LHIMS client — is listening on it. Give this link a different port; do not stop the other program.`
        : error.message;
      this.setState('error', message, message);
      this.server = null;
      // A port that is busy now may be free later, but retrying forever on a
      // port somebody else owns is how you end up racing them for it. One
      // clear failure, left for a person to resolve.
    });
    server.on('close', () => { if (!this.stopping) this.setState('stopped', 'The listener closed.'); });

    try {
      const host = this.row.listen_host?.trim() || undefined;
      server.listen(port, host, () => {
        this.setState('listening', `Waiting for ${this.row.name} on ${host ?? 'every interface'}:${port}`);
      });
      this.server = server;
    } catch (error) {
      this.setState('error', (error as Error).message, (error as Error).message);
    }
  }

  /* ---------------------------------------------------------------- client */
  private startClient(): void {
    const host = this.row.remote_host?.trim();
    const port = Number(this.row.remote_port);
    if (!host || !Number.isFinite(port) || port <= 0) {
      this.setState('error', 'No analyser address set for this link.', 'No address set');
      this.opened = false;
      return;
    }

    // Do not dial an analyser LHIMS is already speaking to. Most analysers
    // accept one host connection; a second one can drop the first.
    const clash = this.getDb().prepare(`SELECT name FROM instrument_links
        WHERE id != ? AND role = 'lhims_owned' AND is_active = 1
          AND remote_host = ? AND remote_port = ?`).get(this.id, host, port) as any;
    if (clash) {
      this.setState('blocked',
        `${host}:${port} is recorded as "${clash.name}", which LHIMS owns. Dialling it could drop the existing connection, so this link has not been started.`,
        'Analyser reserved for an LHIMS-owned link');
      this.opened = false;
      return;
    }

    const connect = () => {
      if (this.stopping) return;
      this.setState('connecting', `Connecting to ${host}:${port}`);
      const socket = net.createConnection({ host, port }, () => {
        this.setState('connected', `Connected to ${host}:${port}`);
        this.getDb().prepare('UPDATE instrument_links SET last_connected_at = CURRENT_TIMESTAMP WHERE id = ?').run(this.id);
      });
      this.attach(socket, `${host}:${port}`);
      socket.on('close', () => {
        this.socket = null;
        if (this.stopping) return;
        this.setState('connecting', `Lost the connection; retrying every ${Math.round(LINK_RECONNECT_MS / 1000)}s`);
        this.reconnectTimer = setTimeout(connect, LINK_RECONNECT_MS);
      });
      socket.on('error', error => {
        this.setState('error', (error as Error).message, (error as Error).message);
      });
      this.socket = socket;
    };
    connect();
  }

  /* ------------------------------------------------------------ file drop */
  private startWatcher(): void {
    const dir = this.row.watch_path?.trim();
    if (!dir || !fs.existsSync(dir)) {
      this.setState('error', `The watched folder ${dir ?? '(not set)'} does not exist.`, 'Folder not found');
      return;
    }
    try {
      this.watcher = fs.watch(dir, (_event, filename) => {
        if (!filename) return;
        const full = path.join(dir, String(filename));
        // Give the analyser a moment to finish writing before reading it.
        setTimeout(() => {
          try {
            if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return;
            const text = fs.readFileSync(full, 'latin1');
            if (text.trim()) this.ingest(text, `file:${filename}`);
          } catch (error) {
            this.setState('error', (error as Error).message, (error as Error).message);
          }
        }, 750);
      });
      this.setState('listening', `Watching ${dir}`);
    } catch (error) {
      this.setState('error', (error as Error).message, (error as Error).message);
    }
  }

  /* -------------------------------------------------------------- the wire */
  private attach(socket: net.Socket, label: string): void {
    const peer = socket.remoteAddress ? `${socket.remoteAddress}:${socket.remotePort}` : label;
    const framer: Framer = framerFor(this.row.protocol, LINK_MAX_FRAME_BYTES);
    socket.setKeepAlive(true, 30_000);

    if (this.row.mode === 'server') {
      this.setState('connected', `${this.row.name} connected from ${peer}`);
      try {
        this.getDb().prepare('UPDATE instrument_links SET last_connected_at = CURRENT_TIMESTAMP WHERE id = ?').run(this.id);
      } catch { /* not worth dropping a connection over */ }
    }

    socket.on('data', chunk => {
      try {
        const { replies, messages } = framer.push(chunk);
        // Answer first. An analyser that does not get its ACK stops sending,
        // and every millisecond spent parsing before replying is a millisecond
        // it spends waiting.
        for (const reply of replies) { if (!socket.destroyed) socket.write(reply); }
        for (const message of messages) this.ingest(message, peer);
      } catch (error) {
        this.setState('error', `Reading from ${peer}: ${(error as Error).message}`, (error as Error).message);
      }
      this.resetIdle(socket, framer, peer);
    });

    socket.on('close', () => {
      this.clearIdle(socket);
      // Whatever arrived but was never terminated is still a record. A link
      // that drops mid-transmission should not silently lose the sample.
      try {
        const remainder = framer.flush();
        if (remainder && remainder.trim()) this.ingest(remainder, peer);
      } catch { /* nothing more can be done for it */ }
      if (this.row.mode === 'server' && !this.stopping) {
        this.setState('listening', `${peer} disconnected; still listening`);
      }
    });

    socket.on('error', error => {
      this.setState('error', `${peer}: ${(error as Error).message}`, (error as Error).message);
      socket.destroy();
    });
  }

  /**
   * A delimited analyser has no end-of-transmission marker, so a pause in the
   * stream is what says "that was the whole thing".
   */
  private resetIdle(socket: net.Socket, framer: Framer, peer: string): void {
    if (this.row.protocol !== 'delimited') return;
    this.clearIdle(socket);
    this.idleTimers.set(socket, setTimeout(() => {
      const remainder = framer.flush();
      if (remainder && remainder.trim()) this.ingest(remainder, peer);
    }, 2_000));
  }

  private clearIdle(socket: net.Socket): void {
    const timer = this.idleTimers.get(socket);
    if (timer) { clearTimeout(timer); this.idleTimers.delete(socket); }
  }

  /* -------------------------------------------------------------- ingest */
  /**
   * One complete transmission, recorded and routed.
   *
   * Everything is written down verbatim first, before any attempt to
   * understand it. A message nobody could map is exactly what is needed in
   * order to map it, and an analyser that says something unexpected overnight
   * should leave evidence rather than a gap.
   */
  private ingest(text: string, peer: string): void {
    const db = this.getDb();
    let parsed: AnalyserMessage[] = [];
    try { parsed = parseFor(this.row.protocol, text); }
    catch (error) { this.setState('error', `Could not read a message from ${peer}: ${(error as Error).message}`); }

    const linkMap = json<Record<string, string>>(this.row.analyte_map, {});
    const patterns = json<string[]>(this.row.control_patterns, []);

    // A transmission with nothing parseable in it is still recorded, so the
    // bench can look at what actually arrived.
    const toStore = parsed.length ? parsed : [{
      sampleId: null, lotNumber: null, instrument: null, runAt: null, results: [], raw: text,
    } as AnalyserMessage];

    for (const message of toStore) {
      const values = message.results.map(result => ({
        analyte: mapAnalyte(result.code, linkMap, this.row.profile_key),
        code: result.code,
        value: result.value,
        unit: result.unit,
        flag: result.flag,
      }));

      const isControl = looksLikeControl(message.sampleId, patterns)
        || looksLikeControl(message.lotNumber, patterns);
      const kind = message.results.length === 0 ? 'unknown' : isControl ? 'control' : 'patient';

      let messageId = 0;
      try {
        const inserted = db.prepare(`INSERT INTO instrument_messages
            (link_id, peer, raw_message, sample_id, lot_number, instrument_name, instrument_run_at,
             result_count, parsed_values, kind, forward_status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(this.id, peer, text.slice(0, 60_000), message.sampleId, message.lotNumber,
            message.instrument, message.runAt, values.length, JSON.stringify(values), kind,
            this.row.forward_enabled ? 'pending' : 'not_required');
        messageId = Number(inserted.lastInsertRowid);

        db.prepare(`UPDATE instrument_links SET last_message_at = CURRENT_TIMESTAMP,
            messages_received = messages_received + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(this.id);
      } catch (error) {
        // Losing the database is not a reason to drop the connection; the next
        // message may well land.
        this.setState('error', `Could not record a message: ${(error as Error).message}`);
        continue;
      }

      if (kind === 'control') this.routeControl(db, messageId, message, values);
    }
  }

  /**
   * A control run reaching the bench.
   *
   * It is parked, never accepted. An analyser message is evidence that a
   * control was run — not a decision that it passed, and not permission to
   * release patient results. That decision belongs to a person, and the IQC
   * board is where they make it.
   */
  private routeControl(db: DB, messageId: number, message: AnalyserMessage, values: any[]): void {
    // Which control is it? The lot is the strongest signal, then the sample
    // identifier, then the link's own instrument.
    let material: any = null;
    if (message.lotNumber) {
      material = db.prepare('SELECT * FROM iqc_materials WHERE lot_number = ? AND is_active = 1').get(message.lotNumber);
    }
    if (!material && message.sampleId) {
      material = db.prepare('SELECT * FROM iqc_materials WHERE is_active = 1 AND (material_code = ? OR lot_number = ?)')
        .get(message.sampleId, message.sampleId);
    }
    if (!material && this.row.equipment_id) {
      // One active control on this instrument is unambiguous; more than one and
      // the bench chooses, because guessing between Level 1 and Level 2 is how
      // a control record becomes fiction.
      const candidates = db.prepare('SELECT * FROM iqc_materials WHERE equipment_id = ? AND is_active = 1').all(this.row.equipment_id) as any[];
      if (candidates.length === 1) material = candidates[0];
    }

    try {
      const feed = db.prepare(`INSERT INTO iqc_feed_messages
          (feed_id, link_id, instrument_message_id, raw_message, sample_id, lot_number,
           instrument_run_at, parsed_values, iqc_material_id, status, status_note)
          VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(this.id, messageId, message.raw.slice(0, 60_000), message.sampleId, message.lotNumber,
          message.runAt, JSON.stringify(values), material?.id ?? null,
          material ? 'matched' : 'unmatched',
          material ? null
            : `Recognised as a control from "${message.sampleId ?? message.lotNumber ?? 'the sample identifier'}", but no active control material matched it. Match it by hand on the bench, or add its lot to the control.`);
      db.prepare('UPDATE instrument_messages SET iqc_feed_message_id = ? WHERE id = ?').run(Number(feed.lastInsertRowid), messageId);
      db.prepare('UPDATE instrument_links SET controls_matched = controls_matched + ? WHERE id = ?').run(material ? 1 : 0, this.id);
    } catch (error) {
      this.setState('error', `Could not park a control run: ${(error as Error).message}`);
    }
  }

  /** Did this link actually open a socket, a listener or a watcher? */
  isOpen(): boolean { return this.opened; }

  stop(): void {
    this.stopping = true;
    this.opened = false;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    for (const timer of this.idleTimers.values()) clearTimeout(timer);
    this.idleTimers.clear();
    if (this.socket) { this.socket.destroy(); this.socket = null; }
    if (this.watcher) { this.watcher.close(); this.watcher = null; }
    if (this.server) { this.server.close(); this.server = null; }
    this.setState('stopped', 'Stopped');
  }
}

/* ============================================================================
   The bridge
   ========================================================================= */
export class InstrumentBridge {
  private getDb: DbGetter;
  private links = new Map<number, Link>();
  private forwardTimer: NodeJS.Timeout | null = null;
  private started = false;

  constructor(getDb: DbGetter) { this.getDb = getDb; }

  /** Start every active link the laboratory has asked to run on its own. */
  start(): void {
    if (this.started) return;
    this.started = true;

    let rows: LinkRow[] = [];
    try {
      rows = this.getDb().prepare('SELECT * FROM instrument_links WHERE is_active = 1 AND auto_start = 1').all() as LinkRow[];
    } catch { return; }

    // Mark everything stopped first, so a state left over from a host that was
    // switched off mid-transmission does not read as live.
    try { this.getDb().prepare("UPDATE instrument_links SET state = 'stopped' WHERE state != 'blocked'").run(); }
    catch { /* the links below set their own state anyway */ }

    for (const row of rows) this.startLink(row);
    if (rows.length) console.log(`[bridge] ${rows.length} analyser link(s) started`);

    // Onward forwarding to LHIMS, for links that have been told to. Idle when
    // none has, which is the default.
    this.forwardTimer = setInterval(() => { void this.drainForwardQueue(); }, 20_000);
  }

  private startLink(row: LinkRow): void {
    const existing = this.links.get(row.id);
    if (existing) existing.stop();
    const link = new Link(this.getDb, row);
    this.links.set(row.id, link);
    try { link.start(); }
    catch (error) {
      // One link failing to start must never stop the others.
      console.error(`[bridge] link "${row.name}" failed to start:`, (error as Error).message);
    }
  }

  /** Restart one link after its settings changed. */
  restart(linkId: number): void {
    let row: LinkRow | undefined;
    try { row = this.getDb().prepare('SELECT * FROM instrument_links WHERE id = ?').get(linkId) as LinkRow; }
    catch { return; }
    if (!row) { this.stopLink(linkId); return; }
    if (!row.is_active) { this.stopLink(linkId); return; }
    this.startLink(row);
  }

  stopLink(linkId: number): void {
    const link = this.links.get(linkId);
    if (link) { link.stop(); this.links.delete(linkId); }
  }

  stop(): void {
    for (const link of this.links.values()) link.stop();
    this.links.clear();
    if (this.forwardTimer) { clearInterval(this.forwardTimer); this.forwardTimer = null; }
    this.started = false;
  }

  /**
   * Is this link actually running?
   *
   * A blocked link is held so its state can be reported, but it has opened
   * nothing — and telling somebody the LHIMS link is "running" is precisely
   * the misunderstanding this whole design exists to prevent.
   */
  isRunning(linkId: number): boolean {
    const link = this.links.get(linkId);
    return Boolean(link && link.isOpen());
  }

  /**
   * Pass copies onward to the LHIMS middleware, for the links told to.
   *
   * Store and forward: a message is recorded first and sent afterwards, so the
   * middleware being down costs nothing but a delay. Attempts are capped —
   * a message that has failed five times is a configuration problem, and
   * retrying it forever only hides that.
   */
  private async drainForwardQueue(): Promise<void> {
    let pending: any[] = [];
    try {
      pending = this.getDb().prepare(`SELECT m.*, l.forward_host, l.forward_port, l.name AS link_name, l.role
          FROM instrument_messages m JOIN instrument_links l ON l.id = m.link_id
          WHERE m.forward_status = 'pending' AND l.forward_enabled = 1 AND m.forward_attempts < 5
          ORDER BY m.id LIMIT 25`).all() as any[];
    } catch { return; }
    if (!pending.length) return;

    for (const message of pending) {
      // A link LHIMS already receives must never be forwarded to it: that
      // would post the same result twice.
      if (message.role === 'lhims_owned') {
        this.markForward(message.id, 'failed', 'This link belongs to LHIMS already; forwarding it would send the same result twice.');
        continue;
      }
      if (!message.forward_host || !message.forward_port) {
        this.markForward(message.id, 'failed', 'No LHIMS address is set on this link.');
        continue;
      }
      try {
        await this.sendOnward(message.forward_host, Number(message.forward_port), message.raw_message ?? '');
        this.markForward(message.id, 'sent', null);
      } catch (error) {
        this.markForward(message.id, 'pending', (error as Error).message);
      }
    }
  }

  private markForward(messageId: number, status: string, error: string | null): void {
    try {
      this.getDb().prepare(`UPDATE instrument_messages SET forward_status = ?, forward_error = ?,
          forward_attempts = forward_attempts + 1,
          forwarded_at = CASE WHEN ? = 'sent' THEN CURRENT_TIMESTAMP ELSE forwarded_at END
          WHERE id = ?`).run(status, error, status, messageId);
    } catch { /* the next sweep will try again */ }
  }

  private sendOnward(host: string, port: number, raw: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host, port });
      const done = (error?: Error) => {
        socket.removeAllListeners();
        socket.destroy();
        error ? reject(error) : resolve();
      };
      socket.setTimeout(10_000, () => done(new Error(`${host}:${port} did not answer within 10 seconds`)));
      socket.on('error', error => done(error as Error));
      socket.on('connect', () => {
        socket.write(raw, 'latin1', () => setTimeout(() => done(), 250));
      });
    });
  }
}

let bridge: InstrumentBridge | null = null;

export function getBridge(getDb: DbGetter): InstrumentBridge {
  if (!bridge) bridge = new InstrumentBridge(getDb);
  return bridge;
}

/** The running bridge, if one has been started. Used by the routes. */
export function currentBridge(): InstrumentBridge | null { return bridge; }
