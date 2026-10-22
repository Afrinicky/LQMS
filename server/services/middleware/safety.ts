/**
 * The existing transmission, and keeping away from it.
 *
 * THE NON-NEGOTIABLE: the Sysmex XN-550 reaches the national LHIMS middleware
 * and that path carries patient results. It must not be replaced, re-pointed,
 * proxied, probed, re-ported or migrated by anything in this module.
 *
 * Every other file asks this one before it acts, so the rule is enforced in a
 * single place rather than remembered in eight. Three things are protected:
 *
 *   The LINK. A link the laboratory recorded as LHIMS's is never opened by the
 *   bridge, and this module never writes to it, tests it or routes from it as
 *   though it were a connection of ours.
 *
 *   The ENDPOINT. The host and port that link uses, and the ports named in any
 *   captured baseline, are refused to every listener, destination and scan. A
 *   wildcard bind on a protected port is a collision, because binding every
 *   interface takes the port whichever address was typed.
 *
 *   The BASELINE. The link's configuration and health are written down, with a
 *   checksum, by READING them. Capturing a baseline changes nothing about the
 *   link it describes, and verifying one later reports drift rather than
 *   correcting it — a module that "repairs" the patient-results link is the
 *   failure this design exists to prevent.
 */
import crypto from 'node:crypto';
import net from 'node:net';
import {
  PROTECTED_BASELINE_LABEL, collidesWithProtected, type ProtectedEndpoint,
} from '../../../shared/constants/middleware.js';
import { modeIsPassive } from '../../../shared/constants/instruments.js';

type DB = any;

export interface SafetyVerdict {
  ok: boolean;
  /** Why it was refused, in words a person can act on. */
  reason: string | null;
  /** What it collided with, for the screen that has to explain the refusal. */
  endpoint?: ProtectedEndpoint | null;
}

const SAFE: SafetyVerdict = { ok: true, reason: null, endpoint: null };

/* ============================================================================
   What is protected right now
   ========================================================================= */

/**
 * Every address this module must not touch.
 *
 * Read fresh each time rather than cached: a laboratory that records a second
 * LHIMS-owned link must be protected from the next action, not from the next
 * restart.
 */
export function protectedEndpoints(db: DB): ProtectedEndpoint[] {
  const list: ProtectedEndpoint[] = [];
  try {
    const links = db.prepare(`SELECT id, name, role, mode, listen_host, listen_port, remote_host, remote_port
        FROM instrument_links WHERE role = 'lhims_owned'`).all() as any[];
    for (const link of links) {
      const because = `${link.name} is recorded as a link LHIMS owns.`;
      if (link.listen_port) list.push({ host: link.listen_host ?? null, port: Number(link.listen_port), because });
      if (link.remote_port) list.push({ host: link.remote_host ?? null, port: Number(link.remote_port), because });
    }
  } catch { /* a database without the links table protects nothing, and nothing runs either */ }
  try {
    const baselines = db.prepare('SELECT label, host, port FROM mw_baselines WHERE is_protected = 1 AND port IS NOT NULL').all() as any[];
    for (const baseline of baselines) {
      list.push({ host: baseline.host ?? null, port: Number(baseline.port), because: `${baseline.label} is a protected production connection.` });
    }
  } catch { /* before the first migration */ }
  try {
    const destinations = db.prepare('SELECT name, host, port FROM mw_destinations WHERE is_protected = 1 AND port IS NOT NULL').all() as any[];
    for (const destination of destinations) {
      list.push({ host: destination.host ?? null, port: Number(destination.port), because: `${destination.name} is a protected destination.` });
    }
  } catch { /* likewise */ }
  return list;
}

/** The links this module treats as somebody else's. */
export function protectedLinkIds(db: DB): Set<number> {
  const ids = new Set<number>();
  try {
    const rows = db.prepare("SELECT id FROM instrument_links WHERE role = 'lhims_owned'").all() as any[];
    for (const row of rows) ids.add(Number(row.id));
  } catch { /* nothing recorded */ }
  return ids;
}

/**
 * May this module bind, dial or probe this address?
 *
 * The one refusal that matters, and it is deliberately strict: a null host on
 * either side counts as a collision.
 */
export function endpointIsSafe(db: DB, candidate: { host?: string | null; port?: number | null }, purpose: string): SafetyVerdict {
  const hit = collidesWithProtected(candidate, protectedEndpoints(db));
  if (!hit) return SAFE;
  return {
    ok: false,
    endpoint: hit,
    reason: `${purpose} would use port ${candidate.port} on ${candidate.host || 'every interface'}, which belongs to a live production transmission. ${hit.because} Choose a different port, or use an isolated test endpoint.`,
  };
}

/**
 * May a route take messages FROM this link?
 *
 * Yes, and this is the distinction that makes the whole module useful: reading
 * what a protected analyser said — from the message the bridge already
 * recorded, or from the middleware's own append log — touches neither the
 * analyser nor its connection. Delivering those messages ONWARD to the system
 * that already receives them does not, and is refused below.
 */
export function sourceIsSafe(db: DB, linkId: number | null): SafetyVerdict {
  if (linkId == null) return SAFE;
  let link: any;
  try { link = db.prepare('SELECT id, name, role, mode FROM instrument_links WHERE id = ?').get(linkId); }
  catch { return SAFE; }
  if (!link) return SAFE;
  if (link.role !== 'lhims_owned') return SAFE;
  if (modeIsPassive(link.mode)) return SAFE;
  // A protected link that is not in a read-only mode is one the bridge never
  // opens, so nothing will ever arrive from it. Routing from it is not unsafe,
  // it is futile, and saying so is better than a rule that silently never fires.
  return {
    ok: false,
    reason: `${link.name} is recorded as a link LHIMS owns and is not in a read-only mode, so SECHLIMS never opens it and no message will ever arrive from it. Set the link to follow the LHIMS client's own log first.`,
  };
}

/**
 * May this destination receive messages from this source?
 *
 * The duplicate-result guard. A link LHIMS already receives must never be
 * routed to a LHIMS destination: two copies of one haemoglobin in a patient
 * record is a worse failure than none, and it is the mistake a well-meaning
 * routing rule makes first.
 */
export function routeIsSafe(db: DB, sourceLinkId: number | null, destinationId: number): SafetyVerdict {
  const source = sourceIsSafe(db, sourceLinkId);
  if (!source.ok) return source;

  let destination: any;
  try { destination = db.prepare('SELECT id, name, platform, is_protected, host, port FROM mw_destinations WHERE id = ?').get(destinationId); }
  catch { return SAFE; }
  if (!destination) return { ok: false, reason: 'That destination no longer exists.' };

  if (destination.is_protected) {
    return {
      ok: false,
      reason: `${destination.name} is a protected production connection. The engine records it so the laboratory can see it and refuses to transmit over it. Route to a test destination instead.`,
    };
  }

  if (sourceLinkId != null && String(destination.platform) === 'lhims') {
    let link: any;
    try { link = db.prepare('SELECT id, name, role FROM instrument_links WHERE id = ?').get(sourceLinkId); }
    catch { link = null; }
    if (link && link.role === 'lhims_owned') {
      return {
        ok: false,
        reason: `${link.name} already transmits to LHIMS through its own middleware. Routing it to ${destination.name} as well would file every result twice.`,
      };
    }
  }
  return SAFE;
}

/**
 * May this destination be changed at all?
 *
 * A protected destination is an observation of something that works, not a
 * configuration to edit. Everything about it is read-only here.
 */
export function destinationIsEditable(destination: { is_protected?: number | null; name?: string }): SafetyVerdict {
  if (!destination?.is_protected) return SAFE;
  return {
    ok: false,
    reason: `${destination.name ?? 'This destination'} is a protected production connection and is held here read-only. Changing it from SECHLIMS is refused.`,
  };
}

/* ============================================================================
   The baseline
   ========================================================================= */
export interface BaselineSnapshot {
  label: string;
  linkId: number | null;
  linkName: string | null;
  role: string | null;
  mode: string | null;
  protocol: string | null;
  host: string | null;
  port: number | null;
  watchPath: string | null;
  tapPath: string | null;
  destinationSummary: string;
  /** Observed health at the moment of capture, not a target. */
  health: {
    state: string | null;
    lastMessageAt: string | null;
    lastConnectedAt: string | null;
    messagesReceived: number;
    messagesLast7Days: number;
    lastError: string | null;
  };
}

/**
 * Write down what the existing connection looks like, without touching it.
 *
 * Every field here comes from a SELECT. Nothing is bound, dialled, restarted or
 * reconfigured, and the function is safe to run on a live laboratory during a
 * clinical session — which is the only way a baseline is any use.
 */
export function captureBaseline(db: DB, options: { linkId?: number | null; label?: string | null; userId?: number | null; note?: string | null }): {
  ok: boolean; baselineId: number | null; snapshot: BaselineSnapshot | null; note: string;
} {
  let link: any = null;
  if (options.linkId != null) {
    link = db.prepare('SELECT * FROM instrument_links WHERE id = ?').get(options.linkId);
    if (!link) return { ok: false, baselineId: null, snapshot: null, note: 'That analyser link no longer exists.' };
  } else {
    // The laboratory's own production link, found by what it IS rather than by
    // an id somebody has to look up: the link LHIMS owns.
    link = db.prepare("SELECT * FROM instrument_links WHERE role = 'lhims_owned' ORDER BY id LIMIT 1").get();
    if (!link) {
      return {
        ok: false, baselineId: null, snapshot: null,
        note: 'No link is recorded as one LHIMS owns, so there is no production transmission to take a baseline of. Record the existing analyser link first, marked as LHIMS-owned.',
      };
    }
  }

  const counts = db.prepare(`SELECT COUNT(*) AS recent FROM instrument_messages
      WHERE link_id = ? AND received_at >= datetime('now', '-7 days')`).get(link.id) as any;

  const snapshot: BaselineSnapshot = {
    label: String(options.label || PROTECTED_BASELINE_LABEL),
    linkId: Number(link.id),
    linkName: link.name ?? null,
    role: link.role ?? null,
    mode: link.mode ?? null,
    protocol: link.protocol ?? null,
    host: link.listen_host ?? link.remote_host ?? null,
    port: link.listen_port ?? link.remote_port ?? null,
    watchPath: link.watch_path ?? null,
    tapPath: link.tap_path ?? null,
    destinationSummary: link.role === 'lhims_owned'
      ? 'LHIMS middleware, over the connection it already owns. SECHLIMS is not in this path.'
      : 'SECHLIMS',
    health: {
      state: link.state ?? null,
      lastMessageAt: link.last_message_at ?? null,
      lastConnectedAt: link.last_connected_at ?? null,
      messagesReceived: Number(link.messages_received ?? 0),
      messagesLast7Days: Number(counts?.recent ?? 0),
      lastError: link.last_error ?? null,
    },
  };

  const checksum = baselineChecksum(snapshot);
  db.prepare(`INSERT INTO mw_baselines
      (label, link_id, host, port, protocol, destination_summary, baseline_json, checksum, captured_by, note, is_protected)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(label) DO UPDATE SET
        link_id = excluded.link_id, host = excluded.host, port = excluded.port,
        protocol = excluded.protocol, destination_summary = excluded.destination_summary,
        baseline_json = excluded.baseline_json, checksum = excluded.checksum,
        captured_at = CURRENT_TIMESTAMP, captured_by = excluded.captured_by, note = excluded.note`)
    .run(snapshot.label, snapshot.linkId, snapshot.host, snapshot.port, snapshot.protocol,
      snapshot.destinationSummary, JSON.stringify(snapshot), checksum, options.userId ?? null, options.note ?? null);

  const row = db.prepare('SELECT id FROM mw_baselines WHERE label = ?').get(snapshot.label) as any;
  return {
    ok: true, baselineId: Number(row?.id ?? 0), snapshot,
    note: `Baseline recorded for ${snapshot.linkName ?? 'the link'} by reading its configuration. Nothing about the link was changed.`,
  };
}

/**
 * Has the protected connection moved since the baseline was taken?
 *
 * Reports. Does not correct. A drift here is a question for the person who
 * changed it, and the one thing this module must never do is decide it knows
 * better and put the patient-results link back.
 */
export function verifyBaseline(db: DB, baselineId: number): {
  ok: boolean; verdict: 'unchanged' | 'drifted' | 'missing'; drift: string[]; health: BaselineSnapshot['health'] | null; note: string;
} {
  const row = db.prepare('SELECT * FROM mw_baselines WHERE id = ?').get(baselineId) as any;
  if (!row) return { ok: false, verdict: 'missing', drift: [], health: null, note: 'That baseline no longer exists.' };

  let recorded: BaselineSnapshot;
  try { recorded = JSON.parse(row.baseline_json); }
  catch { return { ok: false, verdict: 'missing', drift: [], health: null, note: 'The stored baseline could not be read.' }; }

  const current = recorded.linkId != null
    ? db.prepare('SELECT * FROM instrument_links WHERE id = ?').get(recorded.linkId) as any
    : null;
  if (!current) {
    const note = `The link this baseline describes (${recorded.linkName ?? recorded.linkId}) is no longer in the register.`;
    markVerified(db, baselineId, 'drifted', [note]);
    return { ok: true, verdict: 'drifted', drift: [note], health: null, note };
  }

  const drift: string[] = [];
  const compare = (field: string, was: unknown, now: unknown) => {
    const a = was == null ? '' : String(was);
    const b = now == null ? '' : String(now);
    if (a !== b) drift.push(`${field}: was ${a || '(none)'}, now ${b || '(none)'}`);
  };
  compare('role', recorded.role, current.role);
  compare('mode', recorded.mode, current.mode);
  compare('protocol', recorded.protocol, current.protocol);
  compare('host', recorded.host, current.listen_host ?? current.remote_host);
  compare('port', recorded.port, current.listen_port ?? current.remote_port);
  compare('watch path', recorded.watchPath, current.watch_path);
  compare('log followed', recorded.tapPath, current.tap_path);

  const counts = db.prepare(`SELECT COUNT(*) AS recent FROM instrument_messages
      WHERE link_id = ? AND received_at >= datetime('now', '-7 days')`).get(current.id) as any;
  const health: BaselineSnapshot['health'] = {
    state: current.state ?? null,
    lastMessageAt: current.last_message_at ?? null,
    lastConnectedAt: current.last_connected_at ?? null,
    messagesReceived: Number(current.messages_received ?? 0),
    messagesLast7Days: Number(counts?.recent ?? 0),
    lastError: current.last_error ?? null,
  };

  const verdict = drift.length ? 'drifted' : 'unchanged';
  markVerified(db, baselineId, verdict, drift);
  return {
    ok: true, verdict, drift, health,
    note: drift.length
      ? `${drift.length} setting(s) differ from the baseline. SECHLIMS has changed nothing — this is reported for whoever made the change.`
      : 'The protected connection matches its baseline exactly.',
  };
}

function markVerified(db: DB, baselineId: number, verdict: string, drift: string[]): void {
  try {
    db.prepare('UPDATE mw_baselines SET last_verified_at = CURRENT_TIMESTAMP, last_verdict = ?, last_drift = ? WHERE id = ?')
      .run(verdict, drift.length ? JSON.stringify(drift) : null, baselineId);
  } catch { /* the verdict is returned regardless */ }
}

function baselineChecksum(snapshot: BaselineSnapshot): string {
  // The CONFIGURATION, not the health. A baseline whose checksum changed every
  // time a message arrived would say the link had drifted all day.
  const material = JSON.stringify([
    snapshot.linkId, snapshot.role, snapshot.mode, snapshot.protocol,
    snapshot.host, snapshot.port, snapshot.watchPath, snapshot.tapPath,
  ]);
  return crypto.createHash('sha256').update(material).digest('hex').slice(0, 32);
}

/**
 * Is anything already listening here?
 *
 * Used before a port is proposed, so a conflict is reported at configuration
 * time rather than discovered as a link that will not start. A protected port
 * is never probed — a connect() to the middleware's port is exactly the
 * disturbance this file exists to prevent — so it is answered from the register
 * instead.
 */
export function portIsFree(db: DB, host: string | null, port: number, timeoutMs = 1_200): Promise<{ free: boolean; note: string }> {
  const verdict = endpointIsSafe(db, { host, port }, 'Checking this port');
  if (!verdict.ok) return Promise.resolve({ free: false, note: verdict.reason ?? 'This port belongs to a protected connection.' });

  return new Promise(resolve => {
    const probe = net.createServer();
    const done = (free: boolean, note: string) => {
      try { probe.removeAllListeners(); probe.close(); } catch { /* already closed */ }
      resolve({ free, note });
    };
    const timer = setTimeout(() => done(false, 'The port did not answer in time.'), timeoutMs);
    probe.once('error', error => {
      clearTimeout(timer);
      const code = (error as NodeJS.ErrnoException).code;
      done(false, code === 'EADDRINUSE'
        ? `Something is already listening on ${host || 'every interface'}:${port}.`
        : `${host || 'every interface'}:${port} cannot be bound on this host — ${(error as Error).message}`);
    });
    probe.once('listening', () => {
      clearTimeout(timer);
      done(true, `${host || 'every interface'}:${port} is free on this host.`);
    });
    try { probe.listen(port, host || undefined); }
    catch (error) { clearTimeout(timer); done(false, (error as Error).message); }
  });
}
