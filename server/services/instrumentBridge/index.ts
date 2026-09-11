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
  framerFor, parseFor, splitTransmissions, type Framer, type AnalyserMessage,
} from './protocols.js';
import {
  LINK_MAX_FRAME_BYTES, LINK_RECONNECT_MS, linkIsOurs, looksLikeControl, mapAnalyte, modeIsPassive,
} from '../../../shared/constants/instruments.js';
import {
  LHIMS_MAX_ATTEMPTS, LHIMS_TAP_POLL_MS, LHIMS_TAP_START_AT_END,
  lhimsAccepted, lhimsMeasureId, lhimsResultUrl, lhimsSafeUrl,
} from '../../../shared/constants/lhims.js';

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
  forward_target: string | null;
  lhims_url: string | null; lhims_username: string | null; lhims_password: string | null;
  lhims_map_key: string | null; measure_map: string | null;
  tap_path: string | null; tap_offset: number | null;
  // Fetching, for the modes that can be asked rather than only pushed to.
  fetch_enabled: number; fetch_interval_seconds: number | null;
  file_pattern: string | null; archive_path: string | null; delete_after_read: number;
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
  private tapTimer: NodeJS.Timeout | null = null;
  private tapOffset = 0;
  private tapCarry = '';
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
    if (!linkIsOurs(this.row.role, this.row.mode)) {
      this.setState('blocked', 'LHIMS owns this link. SECHLIMS is deliberately not binding or dialling it, so the existing transmission is untouched.');
      return;
    }
    if (!this.row.is_active) { this.setState('stopped', 'Switched off'); return; }
    this.opened = true;

    if (this.row.mode === 'lhims_tap') return this.startTap();
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

  /* ------------------------------------------------------- the LHIMS tap */
  /**
   * Follow the LHIMS client's own append log.
   *
   * This is how the analyser LHIMS owns reaches SECHLIMS without being
   * disturbed. The middleware, with WRITE_TO_FILE switched on, appends every
   * message it receives to LHIMSDataInput.txt before it does anything else with
   * it. We open that file read-only, remember where we got to, and read what
   * has been added — exactly what `tail -f` does.
   *
   * It cannot affect the transmission. No port is bound, no socket is opened,
   * nothing is intercepted, and the file is never written to or locked. If this
   * host is switched off for a week, the LHIMS client carries on and we simply
   * pick up from our offset when it comes back.
   *
   * Polling rather than fs.watch on purpose: the file usually lives on a
   * network share, and watch events over SMB are unreliable in exactly the way
   * that loses a result.
   */
  private startTap(): void {
    const file = this.row.tap_path?.trim();
    if (!file) {
      this.setState('error', 'No path set to the LHIMS client\'s log file.', 'No path set');
      this.opened = false;
      return;
    }

    // Where to begin. Stored per link so a restart resumes rather than
    // re-reading a year of history, and the first start begins at the end
    // because the point is to follow what happens from now on.
    const stored = Number(this.row.tap_offset ?? 0);
    try {
      const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
      this.tapOffset = stored > 0 ? Math.min(stored, size) : (LHIMS_TAP_START_AT_END ? size : 0);
    } catch { this.tapOffset = 0; }

    const poll = () => {
      if (this.stopping) return;
      try { this.readTap(file); }
      catch (error) { this.setState('error', `Reading ${file}: ${(error as Error).message}`, (error as Error).message); }
    };
    this.tapTimer = setInterval(poll, LHIMS_TAP_POLL_MS);
    poll();
    this.setState('following',
      `Following ${file} from byte ${this.tapOffset}. Read-only — the LHIMS client's own transmission is untouched.`);
  }

  private readTap(file: string): void {
    if (!fs.existsSync(file)) {
      this.setState('error', `${file} is not there. Check WRITE_TO_FILE is set to Yes in the LHIMS client, and that the share is reachable.`);
      return;
    }
    const size = fs.statSync(file).size;

    // The client was reinstalled, or somebody emptied the log. Starting over is
    // right; carrying a stale offset would skip everything until it grew past it.
    if (size < this.tapOffset) {
      this.tapOffset = 0;
      this.tapCarry = '';
      this.setState('following', `${file} was truncated or replaced; following it again from the beginning.`);
    }
    if (size === this.tapOffset) return;

    const handle = fs.openSync(file, 'r');
    try {
      const length = size - this.tapOffset;
      const buffer = Buffer.alloc(Math.min(length, LINK_MAX_FRAME_BYTES));
      const read = fs.readSync(handle, buffer, 0, buffer.length, this.tapOffset);
      this.tapOffset += read;
      this.tapCarry += buffer.subarray(0, read).toString('latin1');
    } finally {
      fs.closeSync(handle);
    }

    // The client appends whole transmissions, each ending in its ASTM
    // terminator record. Split on that, and hold anything after the last one in
    // case we caught the file mid-append.
    const { complete, remainder } = splitTransmissions(this.tapCarry, this.row.protocol);
    this.tapCarry = remainder.length > LINK_MAX_FRAME_BYTES ? '' : remainder;
    for (const text of complete) {
      if (text.trim()) this.ingest(text, 'lhims-client-log');
    }
    if (complete.length) {
      try {
        this.getDb().prepare('UPDATE instrument_links SET tap_offset = ? WHERE id = ?').run(this.tapOffset, this.id);
      } catch { /* the offset is an optimisation, not the record */ }
      this.setState('following', `Following ${file}. ${complete.length} message(s) read just now.`);
    }
  }

  /* ------------------------------------------------------------ file drop */
  /**
   * A watched folder, swept as well as watched.
   *
   * The old arrangement only ever saw files CREATED while the watcher was
   * running. Everything already sitting in the folder when the link started was
   * invisible — permanently — and so was everything written while this host was
   * switched off. A laboratory that pointed a link at a folder holding a
   * fortnight of exports got nothing, with no error to explain it, which is the
   * worst way for a feature to fail.
   *
   * So the folder is swept on start, on a schedule, and whenever somebody asks;
   * the watcher stays because it makes an arriving file land in seconds rather
   * than at the next sweep. Both paths go through the same sweep, so a file
   * cannot be read twice by being both watched and swept.
   */
  private startWatcher(): void {
    const dir = this.row.watch_path?.trim();
    if (!dir || !fs.existsSync(dir)) {
      this.setState('error', `The watched folder ${dir ?? '(not set)'} does not exist.`, 'Folder not found');
      return;
    }
    try {
      this.watcher = fs.watch(dir, (_event, filename) => {
        if (!filename) return;
        // Give the analyser a moment to finish writing before reading it. The
        // sweep decides what is actually new, so a burst of events for one file
        // costs a directory listing rather than a duplicated result.
        setTimeout(() => { try { this.sweepFolder(); } catch { /* reported by the sweep */ } }, 750);
      });
      const found = this.sweepFolder();
      this.setState('listening', found
        ? `Watching ${dir}. ${found} file(s) read on starting.`
        : `Watching ${dir}`);
    } catch (error) {
      this.setState('error', (error as Error).message, (error as Error).message);
    }
  }

  /** Does this file name look like something the analyser exports? */
  private matchesPattern(name: string): boolean {
    const pattern = this.row.file_pattern?.trim();
    // No pattern means every file. A folder an analyser writes into usually
    // holds nothing else, and refusing files because they were not named in
    // advance loses results for a configuration nobody knew they had to fill in.
    if (!pattern) return true;
    const parts = pattern.split(/[,;]/).map(p => p.trim()).filter(Boolean);
    if (!parts.length) return true;
    return parts.some(part => {
      const escaped = part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
      return new RegExp(`^${escaped}$`, 'i').test(name);
    });
  }

  /**
   * Read whatever in the folder has not been read.
   *
   * The whole safety of this rests on `instrument_files`. A file is identified
   * by its name, its size and its own modification time, so looking again picks
   * up what was missed without ingesting yesterday's results a second time —
   * and a file genuinely replaced by a newer version of itself reads as new,
   * because it is. Re-reading a control run is not a harmless duplicate: it
   * puts a point on a Levey-Jennings chart that never happened.
   *
   * Returns how many files were read, for the note on the screen.
   */
  private sweepFolder(): number {
    const dir = this.row.watch_path?.trim();
    if (!dir || !fs.existsSync(dir)) return 0;
    const db = this.getDb();

    let names: string[] = [];
    try { names = fs.readdirSync(dir); }
    catch (error) {
      this.setState('error', `Reading ${dir}: ${(error as Error).message}`, (error as Error).message);
      return 0;
    }

    let read = 0;
    for (const name of names.sort()) {
      if (!this.matchesPattern(name)) continue;
      const full = path.join(dir, name);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(full);
        if (!stat.isFile()) continue;
      } catch { continue; }

      // A file still being written to has its size change under us, and half a
      // transmission parses as a shorter one rather than as an error. Anything
      // touched in the last two seconds waits for the next sweep.
      if (Date.now() - stat.mtimeMs < 2_000) continue;

      const modified = new Date(stat.mtimeMs).toISOString();
      try {
        const seen = db.prepare(`SELECT id FROM instrument_files
            WHERE link_id = ? AND file_name = ? AND file_size = ? AND modified_at = ?`)
          .get(this.id, name, stat.size, modified);
        if (seen) continue;
      } catch { /* without the table, fall through and read it */ }

      let messages = 0;
      let outcome = 'read';
      let note: string | null = null;
      try {
        const text = fs.readFileSync(full, 'latin1');
        if (text.trim()) {
          // One file may hold several transmissions, exactly as the tap's log
          // does, so it is split the same way rather than parsed as one.
          const { complete, remainder } = splitTransmissions(text, this.row.protocol);
          const chunks = complete.length ? complete : [text];
          for (const chunk of chunks) if (chunk.trim()) messages += this.ingest(chunk, `file:${name}`);
          if (complete.length && remainder.trim()) {
            // Something after the last terminator. Recorded rather than
            // dropped: an analyser whose export is not framed as expected
            // should leave evidence of it.
            messages += this.ingest(remainder, `file:${name}`);
          }
        } else {
          outcome = 'empty';
          note = 'The file held nothing.';
        }
      } catch (error) {
        outcome = 'error';
        note = (error as Error).message;
        this.setState('error', `Reading ${name}: ${note}`, note);
      }

      try {
        db.prepare(`INSERT OR IGNORE INTO instrument_files
            (link_id, file_name, file_size, modified_at, message_count, outcome, note)
            VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(this.id, name, stat.size, modified, messages, outcome, note);
      } catch { /* the read happened; not recording it costs one re-read */ }

      if (outcome !== 'error') {
        read++;
        this.disposeOf(full, name);
      }
    }
    return read;
  }

  /**
   * What becomes of a file once it has been read.
   *
   * Both options are off by default, and deliberately so: the analyser's export
   * is the laboratory's own record of what it sent, and a bridge that deletes
   * it by default destroys the only copy the first time it misreads something.
   * A folder that is never cleared is a housekeeping problem; a folder that
   * clears itself is a lost result.
   */
  private disposeOf(full: string, name: string): void {
    const archive = this.row.archive_path?.trim();
    try {
      if (archive) {
        fs.mkdirSync(archive, { recursive: true });
        // Stamped, because analysers reuse file names and an archive that
        // overwrites yesterday's export is not an archive.
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        fs.renameSync(full, path.join(archive, `${stamp}_${name}`));
      } else if (this.row.delete_after_read) {
        fs.unlinkSync(full);
      }
    } catch (error) {
      this.setState('error', `Could not move ${name} aside: ${(error as Error).message}`);
    }
  }

  /**
   * Look now, rather than waiting to be spoken to.
   *
   * Everything about this bridge was built around being pushed to, which is how
   * transmission normally works and leaves two things impossible: proving a new
   * link works without waiting for the analyser to decide to send something,
   * and catching up after the host has been off for an afternoon.
   *
   * Only the modes that can be asked answer it. A listening socket has nothing
   * to fetch — the analyser holds that — and saying so plainly is better than a
   * button that appears to do something and does not.
   */
  fetchNow(): { ok: boolean; read: number; note: string } {
    if (!linkIsOurs(this.row.role, this.row.mode)) {
      return { ok: false, read: 0, note: 'LHIMS owns this link. SECHLIMS does not open it, and fetching would mean opening it.' };
    }
    const stamp = (note: string, read: number) => {
      try {
        this.getDb().prepare(`UPDATE instrument_links SET last_fetch_at = CURRENT_TIMESTAMP,
            last_fetch_note = ? WHERE id = ?`).run(note, this.id);
      } catch { /* the note is for the screen, not the record */ }
      return { ok: true, read, note };
    };

    if (this.row.mode === 'file_drop') {
      const read = this.sweepFolder();
      return stamp(read ? `${read} new file(s) read from the folder.` : 'Nothing new in the folder.', read);
    }
    if (this.row.mode === 'lhims_tap') {
      const file = this.row.tap_path?.trim();
      if (!file) return { ok: false, read: 0, note: 'No path is set to the LHIMS client\'s log file.' };
      const before = this.tapOffset;
      try { this.readTap(file); }
      catch (error) { return { ok: false, read: 0, note: (error as Error).message }; }
      const gained = this.tapOffset - before;
      return stamp(gained > 0 ? `Read ${gained} new byte(s) from the LHIMS client's log.` : 'Nothing new in the log.', gained > 0 ? 1 : 0);
    }
    if (this.row.mode === 'client') {
      // Dialling out IS the fetch, so the honest answer is whether the
      // connection is up — not a pretence that a message was pulled.
      const live = Boolean(this.socket && !this.socket.destroyed);
      return { ok: live, read: 0, note: live
        ? 'Connected to the analyser and listening for what it sends. This link pulls nothing on demand; the analyser decides when to transmit.'
        : 'Not connected to the analyser at the moment. It will keep retrying.' };
    }
    return { ok: false, read: 0, note: 'This link waits for the analyser to connect to it, so there is nothing to fetch. The analyser decides when to transmit.' };
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
  private ingest(text: string, peer: string): number {
    const db = this.getDb();
    let parsed: AnalyserMessage[] = [];
    try { parsed = parseFor(this.row.protocol, text); }
    catch (error) { this.setState('error', `Could not read a message from ${peer}: ${(error as Error).message}`); }

    const linkMap = json<Record<string, string>>(this.row.analyte_map, {});
    const patterns = json<string[]>(this.row.control_patterns, []);

    // A transmission with nothing parseable in it is still recorded, so the
    // bench can look at what actually arrived.
    let recorded = 0;
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
      recorded++;
    }
    return recorded;
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
    if (this.tapTimer) { clearInterval(this.tapTimer); this.tapTimer = null; }
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
  private fetchTimer: NodeJS.Timeout | null = null;
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

    // Looking, for the links that have been told to look. One timer that wakes
    // every thirty seconds and decides which links are due, rather than a timer
    // per link: a laboratory with a dozen folders should not be running a dozen
    // clocks, and one sweep that throws must not stop the others.
    this.fetchTimer = setInterval(() => { this.runDueFetches(); }, 30_000);
  }

  /**
   * Sweep the links whose interval has elapsed.
   *
   * The interval is kept on the link rather than shared, because a folder an
   * analyser writes to every few minutes and a log that is appended to all day
   * do not want the same cadence, and polling a network share harder than it
   * needs is how a share starts refusing connections.
   */
  private runDueFetches(): void {
    let rows: Array<{ id: number; fetch_interval_seconds: number | null; last_fetch_at: string | null }> = [];
    try {
      rows = this.getDb().prepare(`SELECT id, fetch_interval_seconds, last_fetch_at FROM instrument_links
          WHERE is_active = 1 AND fetch_enabled = 1 AND mode IN ('file_drop', 'lhims_tap')
            AND role != 'lhims_owned'`).all() as any[];
    } catch { return; }

    const now = Date.now();
    for (const row of rows) {
      const link = this.links.get(row.id);
      if (!link) continue;
      const every = Math.max(30, Number(row.fetch_interval_seconds ?? 300)) * 1000;
      const last = row.last_fetch_at ? Date.parse(String(row.last_fetch_at).replace(' ', 'T') + 'Z') : 0;
      if (Number.isFinite(last) && now - last < every) continue;
      // One link's sweep failing is one link's problem.
      try { link.fetchNow(); }
      catch (error) { console.error(`[bridge] scheduled fetch on link ${row.id}:`, (error as Error).message); }
    }
  }

  /**
   * Look now, on one link, because somebody asked.
   *
   * A link that is not running is started for the attempt rather than refused:
   * "fetch" on a stopped link means "go and look", and telling somebody to
   * start it first before it can look in a folder is a step that exists only
   * because of how this was built.
   */
  fetchNow(linkId: number): { ok: boolean; read: number; note: string } {
    let link = this.links.get(linkId);
    if (!link) {
      let row: LinkRow | undefined;
      try { row = this.getDb().prepare('SELECT * FROM instrument_links WHERE id = ?').get(linkId) as LinkRow; }
      catch { return { ok: false, read: 0, note: 'That link could not be read.' }; }
      if (!row) return { ok: false, read: 0, note: 'That link no longer exists.' };
      if (!row.is_active) return { ok: false, read: 0, note: 'This link is switched off.' };
      link = new Link(this.getDb, row);
      this.links.set(linkId, link);
    }
    return link.fetchNow();
  }

  /**
   * What the whole bridge is doing, in one answer.
   *
   * Built for the screen that asks "is analyser transmission working?" — a
   * question nobody could answer without opening every link in turn and
   * reading its state.
   */
  overview(): Record<string, unknown> {
    const db = this.getDb();
    const blank = { links: 0, running: 0, blocked: 0, failing: 0, messagesToday: 0, controlsWaiting: 0, forwardPending: 0, forwardFailed: 0, lastMessageAt: null as string | null };
    try {
      const links = db.prepare('SELECT * FROM instrument_links WHERE is_active = 1').all() as LinkRow[];
      const counts = db.prepare(`SELECT
          (SELECT COUNT(*) FROM instrument_messages WHERE date(received_at) = date('now')) AS today,
          (SELECT MAX(received_at) FROM instrument_messages) AS last_at,
          (SELECT COUNT(*) FROM iqc_feed_messages WHERE status IN ('matched','unmatched')) AS waiting,
          (SELECT COUNT(*) FROM instrument_messages WHERE forward_status = 'pending') AS pending,
          (SELECT COUNT(*) FROM instrument_messages WHERE forward_status = 'failed') AS failed`).get() as any;
      return {
        links: links.length,
        // A blocked link is not a broken one: it is the bridge deliberately
        // staying away from the transmission LHIMS owns, and counting it as a
        // failure would make the screen say something is wrong when the most
        // important safety rule in the system is working.
        running: links.filter(l => this.isRunning(l.id)).length,
        blocked: links.filter(l => (l as any).state === 'blocked').length,
        failing: links.filter(l => (l as any).state === 'error').length,
        messagesToday: Number(counts?.today ?? 0),
        lastMessageAt: counts?.last_at ?? null,
        controlsWaiting: Number(counts?.waiting ?? 0),
        forwardPending: Number(counts?.pending ?? 0),
        forwardFailed: Number(counts?.failed ?? 0),
      };
    } catch { return blank; }
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
    if (this.fetchTimer) { clearInterval(this.fetchTimer); this.fetchTimer = null; }
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
   * Carry results into LHIMS, for the links told to.
   *
   * This is the same HTTP call the LHIMS middleware makes — api/update_result.php
   * with a specimen id, a measure id and a value — so a result posted from here
   * lands in exactly the field the middleware would have put it in. It is how
   * the three analysers the middleware never carried can start reaching LHIMS,
   * without the middleware changing at all.
   *
   * Store and forward: the message is written down first and delivered
   * afterwards, so LHIMS being unreachable costs a delay and nothing else.
   * Attempts are capped, because a message that has failed five times is a
   * configuration problem and retrying it forever only hides that.
   */
  private async drainForwardQueue(): Promise<void> {
    let pending: any[] = [];
    try {
      pending = this.getDb().prepare(`SELECT m.*, l.forward_host, l.forward_port, l.forward_target,
            l.lhims_url, l.lhims_username, l.lhims_password, l.lhims_map_key, l.measure_map,
            l.name AS link_name, l.role
          FROM instrument_messages m JOIN instrument_links l ON l.id = m.link_id
          WHERE m.forward_status = 'pending' AND l.forward_enabled = 1 AND m.forward_attempts < ?
          ORDER BY m.id LIMIT 25`).all(LHIMS_MAX_ATTEMPTS) as any[];
    } catch { return; }
    if (!pending.length) return;

    for (const message of pending) {
      // A link LHIMS already receives must never be delivered to it: that would
      // post the same result twice, and a duplicated haemoglobin in a patient
      // record is a worse failure than a missing one.
      if (message.role === 'lhims_owned') {
        this.markForward(message.id, 'failed', 'This link belongs to LHIMS already; delivering it would store the same result twice.');
        continue;
      }
      // Only patient results go to LHIMS. A control run is quality control,
      // belongs on the IQC board, and has no patient record to be filed under.
      if (message.kind !== 'patient') {
        this.markForward(message.id, 'not_required', null);
        continue;
      }
      try {
        const outcome = message.forward_target === 'tcp'
          ? await this.deliverByTcp(message)
          : await this.deliverToLhims(message);
        this.markForward(message.id, this.settle(outcome, message), outcome.note);
      } catch (error) {
        this.markForward(message.id, this.settle({ status: 'retry', note: null }, message), (error as Error).message);
      }
    }
  }

  /**
   * What a delivery attempt means for the message's state.
   *
   * The distinction that matters: a REFUSAL is usually temporary — LHIMS
   * restarting, the network dropping — and deserves another go, whereas a
   * message with no specimen identifier or no address to send to will fail
   * identically forever and only wastes attempts. So 'retry' keeps the message
   * pending until the cap, and only then admits defeat; 'failed' is reserved
   * for the problems a person has to fix.
   */
  private settle(outcome: { status: string; note: string | null }, message: any): string {
    if (outcome.status !== 'retry') return outcome.status;
    const attempts = Number(message.forward_attempts ?? 0) + 1;
    return attempts >= LHIMS_MAX_ATTEMPTS ? 'failed' : 'pending';
  }

  /**
   * One message, delivered result by result.
   *
   * A parameter with no measure id is NOT sent. LHIMS storing a haemoglobin
   * under whatever id happened to be nearby is far worse than LHIMS not storing
   * it, so the unmapped codes are named in the status instead and the message
   * is marked partly delivered — visible, and fixable, rather than silently wrong.
   */
  private async deliverToLhims(message: any): Promise<{ status: string; note: string | null }> {
    if (!message.lhims_url || !message.lhims_username) {
      return { status: 'failed', note: 'No LHIMS address or username is set on this link.' };
    }
    const specimenId = String(message.sample_id ?? '').trim();
    if (!specimenId) {
      return { status: 'failed', note: 'This message carries no specimen identifier, so LHIMS has nothing to file it under.' };
    }

    const values: any[] = json<any[]>(message.parsed_values, []);
    if (!values.length) return { status: 'not_required', note: 'Nothing in this message to deliver.' };

    const overrides = json<Record<string, number>>(message.measure_map, {});
    const credentials = { username: String(message.lhims_username), password: String(message.lhims_password ?? '') };

    let delivered = 0;
    const unmapped: string[] = [];
    const refused: string[] = [];

    for (const value of values) {
      const measureId = lhimsMeasureId(String(value.code ?? value.analyte ?? ''), overrides, message.lhims_map_key);
      if (!measureId) { unmapped.push(String(value.code ?? value.analyte ?? '?')); continue; }

      const raw = String(value.value ?? '').trim();
      if (!raw) continue;
      // How many decimal places the analyser reported, so LHIMS stores the
      // number as it was measured rather than rounded.
      const decimals = raw.includes('.') ? Math.min(4, raw.split('.')[1].length) : 0;

      const url = lhimsResultUrl(String(message.lhims_url), credentials, {
        specimenId, measureId, value: raw, decimals,
      });
      const answer = await this.httpGet(url);
      if (lhimsAccepted(answer)) delivered++;
      else refused.push(`${value.code}: ${answer.slice(0, 40) || 'no answer'}`);
    }

    const notes: string[] = [];
    if (delivered) notes.push(`${delivered} result(s) delivered`);
    if (unmapped.length) notes.push(`no LHIMS measure id for ${unmapped.slice(0, 8).join(', ')}${unmapped.length > 8 ? '…' : ''} — map these on the link`);
    if (refused.length) notes.push(`LHIMS refused ${refused.slice(0, 4).join('; ')}`);

    // Nothing got through, but every parameter was mapped and addressed: that
    // is LHIMS refusing or unreachable, so it is worth another go rather than
    // being written off.
    if (delivered === 0 && refused.length) {
      return { status: 'retry', note: notes.join('. ') || null };
    }
    // Nothing got through and nothing was even mappable: retrying identical
    // calls will not help, and the unmapped codes are named for somebody to fix.
    if (delivered === 0) {
      return { status: 'failed', note: notes.join('. ') || 'Nothing in this message could be mapped to a LHIMS measure id.' };
    }
    const status = (unmapped.length || refused.length) ? 'partial' : 'sent';
    return { status, note: notes.join('. ') || null };
  }

  /** A plain TCP hand-off, for a middleware that wants the raw transmission. */
  private async deliverByTcp(message: any): Promise<{ status: string; note: string | null }> {
    if (!message.forward_host || !message.forward_port) {
      return { status: 'failed', note: 'No address is set on this link to hand the message to.' };
    }
    await this.sendOnward(String(message.forward_host), Number(message.forward_port), message.raw_message ?? '');
    return { status: 'sent', note: null };
  }

  /** One GET, with a timeout, never throwing on a refusal. */
  private async httpGet(url: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(url, { signal: controller.signal });
      return (await response.text()).trim();
    } catch (error) {
      // The safe URL, so a password never reaches a log or a screen.
      throw new Error(`${lhimsSafeUrl(url)} — ${(error as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private markForward(messageId: number, status: string, error: string | null): void {
    try {
      this.getDb().prepare(`UPDATE instrument_messages SET forward_status = ?, forward_error = ?,
          forward_attempts = forward_attempts + 1,
          forwarded_at = CASE WHEN ? IN ('sent', 'partial') THEN CURRENT_TIMESTAMP ELSE forwarded_at END
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
