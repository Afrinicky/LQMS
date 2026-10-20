/**
 * Why a transmission is not working.
 *
 * The question a laboratory actually asks is "is transmission working?", and
 * the honest answer has five parts that are routinely confused with one
 * another:
 *
 *   the device is REACHABLE      — something answers at that address and port
 *   the connection is ESTABLISHED — a session was opened and held
 *   the message PARSED            — bytes became records became results
 *   the message was DELIVERED     — it left this host for the destination
 *   the destination ACCEPTED it   — the far end said so, in its own protocol
 *
 * Each can be true while the next is false, and "failed" on its own has sent
 * people to the wrong room for an afternoon. So every check below names its
 * layer, says what was observed, and where there is a definite remedy, says
 * that too.
 *
 * Nothing here probes a protected endpoint. A connect() to the port the LHIMS
 * middleware is using is exactly the disturbance this module exists to avoid,
 * so that check is answered from the register instead and labelled as such.
 */
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import {
  DISCOVERY_CONNECT_TIMEOUT_MS, deliveryIsConfirmable, worstStatus,
  type DiagnosticFinding, type DiagnosticStatus,
} from '../../../shared/constants/middleware.js';
import { linkIsOurs, modeIsPassive } from '../../../shared/constants/instruments.js';
import { detectProtocol, effectiveProtocol, parseFor, splitTransmissions } from '../instrumentBridge/protocols.js';
import { endpointIsSafe, protectedEndpoints } from './safety.js';
import { scrubSecrets, secretIsSet } from './secrets.js';

type DB = any;

export interface DiagnosticReport {
  subject: string;
  subjectKind: 'link' | 'destination' | 'system';
  subjectId: number | null;
  at: string;
  status: DiagnosticStatus;
  findings: DiagnosticFinding[];
  /** The one sentence to put at the top of the panel. */
  summary: string;
}

const finding = (
  layer: DiagnosticFinding['layer'], key: string, label: string,
  status: DiagnosticStatus, detail: string, remedy?: string | null, measuredMs?: number | null,
): DiagnosticFinding => ({ layer, key, label, status, detail: scrubSecrets(detail), remedy: remedy ?? null, measuredMs: measuredMs ?? null });

/* ============================================================================
   Is anything there?
   ========================================================================= */

/**
 * One TCP connect, timed, with the result in words.
 *
 * A connect is the only honest reachability test for an analyser interface:
 * ICMP is filtered on most hospital networks, and a device that answers a ping
 * and refuses the port looks healthy and transmits nothing.
 */
export function probeTcp(host: string, port: number, timeoutMs = DISCOVERY_CONNECT_TIMEOUT_MS): Promise<{
  reachable: boolean; latencyMs: number; detail: string; banner: string | null;
}> {
  return new Promise(resolve => {
    const started = Date.now();
    let settled = false;
    let banner = '';
    const socket = net.createConnection({ host, port });
    const done = (reachable: boolean, detail: string) => {
      if (settled) return;
      settled = true;
      try { socket.removeAllListeners(); socket.destroy(); } catch { /* already gone */ }
      resolve({ reachable, latencyMs: Date.now() - started, detail, banner: banner.trim() || null });
    };
    socket.setTimeout(timeoutMs, () => done(false, `${host}:${port} did not answer within ${timeoutMs} ms.`));
    socket.on('error', error => {
      const code = (error as NodeJS.ErrnoException).code;
      done(false, code === 'ECONNREFUSED' ? `${host}:${port} refused the connection — the host is up, nothing is listening on that port.`
        : code === 'EHOSTUNREACH' || code === 'ENETUNREACH' ? `${host} cannot be reached from this host.`
        : code === 'ETIMEDOUT' ? `${host}:${port} did not answer.`
        : `${host}:${port} — ${(error as Error).message}`);
    });
    socket.on('connect', () => {
      // A short listen: an analyser interface or an MLLP listener that greets
      // its caller identifies itself here, which is what makes a discovered
      // endpoint worth a profile guess rather than just an open port.
      setTimeout(() => done(true, `${host}:${port} answered.`), Math.min(400, timeoutMs));
    });
    socket.on('data', chunk => { if (banner.length < 400) banner += chunk.toString('latin1'); });
  });
}

/* ============================================================================
   One analyser link, end to end
   ========================================================================= */

/**
 * Everything that can be established about a link without disturbing it.
 *
 * The order matters: a laboratory reading down this list gets to the first
 * failure and stops, and the first failure is the one to fix.
 */
export async function diagnoseLink(db: DB, linkId: number): Promise<DiagnosticReport> {
  const link = db.prepare('SELECT * FROM instrument_links WHERE id = ?').get(linkId) as any;
  const at = new Date().toISOString();
  if (!link) {
    return { subject: `Link ${linkId}`, subjectKind: 'link', subjectId: linkId, at, status: 'fail', summary: 'That link is not in the register.', findings: [] };
  }
  const findings: DiagnosticFinding[] = [];
  const protectedList = protectedEndpoints(db);
  const isProtected = link.role === 'lhims_owned';

  /* ---- Network --------------------------------------------------------- */
  if (isProtected && !modeIsPassive(link.mode)) {
    findings.push(finding('network', 'protected', 'Protected production connection', 'info',
      `${link.name} is recorded as a link LHIMS owns. SECHLIMS does not bind its port, dial its address or probe it, so no network test is run against it.`,
      'To take a copy of what this analyser sends without touching the connection, set the link to follow the LHIMS client\'s own append log.'));
  } else if (link.mode === 'client' && link.remote_host && link.remote_port) {
    const verdict = endpointIsSafe(db, { host: link.remote_host, port: link.remote_port }, 'Testing this analyser');
    if (!verdict.ok) {
      findings.push(finding('network', 'reachable', 'Analyser reachable', 'warn', verdict.reason ?? '', 'Use a different port.'));
    } else {
      const probe = await probeTcp(String(link.remote_host), Number(link.remote_port));
      findings.push(finding('network', 'reachable', 'Analyser reachable',
        probe.reachable ? 'ok' : 'fail', probe.detail,
        probe.reachable ? null : 'Check the analyser is switched on, its host communication is enabled, and the address and port match what is set here.',
        probe.latencyMs));
    }
  } else if (link.mode === 'server') {
    const addresses = lanAddresses();
    findings.push(finding('network', 'host', 'This host on the network',
      addresses.length ? 'ok' : 'fail',
      addresses.length
        ? `The analyser should be pointed at ${addresses.map(a => a.address).join(' or ')} on port ${link.listen_port ?? '(no port set)'}.`
        : 'This host has no network address other than its own loopback, so an analyser on the bench cannot reach it.',
      addresses.length ? null : 'Connect this machine to the laboratory network.'));
    if (!link.listen_port) {
      findings.push(finding('network', 'port', 'Listening port', 'fail', 'No port is set on this link, so nothing can be bound.', 'Set a port, and set the same one in the analyser.'));
    } else {
      const collision = protectedList.find(e => Number(e.port) === Number(link.listen_port));
      if (collision) {
        findings.push(finding('network', 'port', 'Listening port', 'fail',
          `Port ${link.listen_port} belongs to a live production transmission. ${collision.because}`,
          'Choose a different port for this link.'));
      } else {
        findings.push(finding('network', 'port', 'Listening port', 'ok', `Port ${link.listen_port} does not collide with any protected connection.`));
      }
    }
  }

  /* ---- Transport ------------------------------------------------------- */
  const state = String(link.state ?? 'stopped');
  const openStates = ['listening', 'connected', 'following'];
  findings.push(finding('transport', 'state', 'Connection state',
    openStates.includes(state) ? 'ok' : state === 'blocked' ? 'info' : state === 'error' ? 'fail' : 'warn',
    state === 'blocked'
      ? 'Deliberately left alone — this is the link LHIMS owns, and the bridge never opens it.'
      : `${state}${link.state_detail ? ` — ${link.state_detail}` : ''}`,
    openStates.includes(state) || state === 'blocked' ? null : 'Start the link, and read its live log for what happens when it tries.'));

  if (!linkIsOurs(link.role, link.mode)) {
    findings.push(finding('transport', 'blocked', 'Listener', 'info',
      'No listener is opened for this link, by design. Nothing will arrive on it, and nothing it would have disturbed is disturbed.'));
  }

  if (link.mode === 'file_drop' || link.mode === 'lhims_tap') {
    const target = link.mode === 'lhims_tap' ? link.tap_path : link.watch_path;
    if (!target) {
      findings.push(finding('transport', 'path', 'Folder or log file', 'fail', 'No path is set, so there is nothing to read.', 'Point the link at the folder the analyser writes to, or at the client\'s own log file.'));
    } else {
      let stat: fs.Stats | null = null;
      try { stat = fs.statSync(String(target)); } catch { stat = null; }
      if (!stat) {
        findings.push(finding('transport', 'path', 'Folder or log file', 'fail',
          `${target} cannot be reached from this host.`,
          'Check the share is mounted and that this host has read access to it.'));
      } else if (stat.isDirectory()) {
        const names = safeList(String(target));
        findings.push(finding('transport', 'path', 'Folder or log file',
          link.mode === 'lhims_tap' ? 'warn' : names.length ? 'ok' : 'warn',
          link.mode === 'lhims_tap'
            ? `${target} is a folder, not a file. A folder has no bytes to follow, so the link reads nothing and reports no error.`
            : `${target} holds ${names.length} file(s).`,
          link.mode === 'lhims_tap' ? 'Point the link at the log file itself, not at the folder it sits in.' : null));
      } else {
        findings.push(finding('transport', 'path', 'Folder or log file', 'ok',
          `${target} is a readable file of ${stat.size.toLocaleString()} bytes. Followed from byte ${Number(link.tap_offset ?? 0).toLocaleString()}.`,
          Number(link.tap_offset ?? 0) > stat.size ? 'The file is smaller than the position being read from — it has been replaced or truncated. Rewind the link.' : null));
      }
    }
  }

  /* ---- Protocol -------------------------------------------------------- */
  const lastMessage = db.prepare(`SELECT raw_message, result_count, kind, received_at FROM instrument_messages
      WHERE link_id = ? ORDER BY id DESC LIMIT 1`).get(linkId) as any;
  if (!lastMessage) {
    findings.push(finding('protocol', 'parsed', 'Message parsing', 'warn',
      'Nothing has ever arrived on this link, so there is no transmission to read.',
      'Transmit one sample from the analyser, or use the Message and Protocol Explorer to play a captured message at this link.'));
  } else {
    const raw = String(lastMessage.raw_message ?? '');
    const detected = detectProtocol(raw);
    const resolved = effectiveProtocol(link.protocol, raw);
    let parsedCount = 0;
    try { parsedCount = parseFor(resolved, raw).reduce((sum, m) => sum + m.results.length, 0); }
    catch { parsedCount = 0; }
    const split = splitTransmissions(resolved, raw, { final: true });

    findings.push(finding('protocol', 'framing', 'Framing', split.complete.length ? 'ok' : 'fail',
      split.complete.length
        ? `The last transmission framed into ${split.complete.length} complete message(s).`
        : 'The last transmission could not be framed into a complete message — no terminator record was found, so the engine would hold it waiting for an end that has already passed.',
      split.complete.length ? null : 'Check the analyser is sending the protocol this link is set to, and read the raw message in the Protocol Explorer.'));

    findings.push(finding('protocol', 'protocol', 'Protocol',
      detected && detected !== resolved ? 'warn' : 'ok',
      detected && detected !== resolved
        ? `This link is set to ${String(link.protocol).toUpperCase()}, and what arrived is ${detected.toUpperCase()}.`
        : `Read as ${resolved.toUpperCase()}${link.protocol === 'auto' ? ' (worked out from the message)' : ''}.`,
      detected && detected !== resolved ? `Set this link's protocol to ${detected.toUpperCase()}, or to "work it out".` : null));

    findings.push(finding('protocol', 'parsed', 'Results parsed', parsedCount ? 'ok' : 'fail',
      parsedCount
        ? `${parsedCount} result(s) came out of the last transmission, received ${String(lastMessage.received_at).slice(0, 16).replace('T', ' ')}.`
        : 'The last transmission was received and recorded, and no result came out of it.',
      parsedCount ? null : 'Open the raw message in the Protocol Explorer. A link that receives messages and understands none of them looks exactly like a link that receives nothing.'));
  }

  /* ---- Data ------------------------------------------------------------ */
  const quality = db.prepare(`SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN sample_id IS NULL OR TRIM(sample_id) = '' THEN 1 ELSE 0 END) AS no_sample,
      SUM(CASE WHEN result_count = 0 THEN 1 ELSE 0 END) AS empty,
      SUM(CASE WHEN kind = 'unknown' THEN 1 ELSE 0 END) AS unknown
    FROM instrument_messages WHERE link_id = ? AND received_at >= datetime('now', '-7 days')`).get(linkId) as any;
  const total = Number(quality?.total ?? 0);
  if (total) {
    const noSample = Number(quality?.no_sample ?? 0);
    const empty = Number(quality?.empty ?? 0);
    findings.push(finding('data', 'identifiers', 'Sample identifiers',
      noSample === 0 ? 'ok' : noSample === total ? 'fail' : 'warn',
      noSample === 0
        ? `All ${total} message(s) in the last seven days carry a sample identifier.`
        : `${noSample} of ${total} message(s) in the last seven days carry no sample identifier, so no destination can file them.`,
      noSample ? 'Check the analyser is configured to transmit the sample identifier, and that the barcode is being read.' : null));
    findings.push(finding('data', 'results', 'Results present',
      empty === 0 ? 'ok' : empty === total ? 'fail' : 'warn',
      empty === 0 ? `Every message carried at least one result.` : `${empty} of ${total} message(s) carried no readable result.`,
      empty ? 'Read one of them in the Protocol Explorer — the mapping or the protocol is usually the cause.' : null));
  }

  /* ---- Queue ----------------------------------------------------------- */
  const queue = db.prepare(`SELECT
      SUM(CASE WHEN v.state IN ('queued','retrying','in_flight') THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN v.state = 'dead_letter' THEN 1 ELSE 0 END) AS dead
    FROM mw_deliveries v JOIN mw_messages m ON m.id = v.message_id WHERE m.link_id = ?`).get(linkId) as any;
  const pending = Number(queue?.pending ?? 0);
  const dead = Number(queue?.dead ?? 0);
  findings.push(finding('queue', 'backlog', 'Queued deliveries', dead ? 'warn' : 'ok',
    `${pending} delivery(ies) waiting, ${dead} in the dead-letter queue.`,
    dead ? 'Open Pending Queues and Failed Deliveries to see which destination refused them and why.' : null));

  const status = worstStatus(findings);
  return {
    subject: String(link.name),
    subjectKind: 'link',
    subjectId: linkId,
    at,
    status,
    findings,
    summary: summarise(findings, isProtected && !modeIsPassive(link.mode)),
  };
}

/* ============================================================================
   One destination, end to end
   ========================================================================= */
export async function diagnoseDestination(db: DB, destinationId: number): Promise<DiagnosticReport> {
  const destination = db.prepare('SELECT * FROM mw_destinations WHERE id = ?').get(destinationId) as any;
  const at = new Date().toISOString();
  if (!destination) {
    return { subject: `Destination ${destinationId}`, subjectKind: 'destination', subjectId: destinationId, at, status: 'fail', summary: 'That destination is not in the register.', findings: [] };
  }
  const findings: DiagnosticFinding[] = [];

  if (destination.is_protected) {
    findings.push(finding('network', 'protected', 'Protected production connection', 'info',
      `${destination.name} is held read-only so the laboratory can see it. SECHLIMS does not connect to it, test it or transmit over it.`));
  }

  /* ---- Network and transport ------------------------------------------- */
  if (destination.transport === 'internal') {
    findings.push(finding('network', 'internal', 'Transport', 'ok', 'This destination is SECHLIMS itself. No network transmission is involved.'));
  } else if (destination.transport === 'file_export') {
    const dir = String(destination.export_dir ?? '');
    if (!dir) {
      findings.push(finding('transport', 'folder', 'Export folder', 'fail', 'No export folder is set.', 'Set the folder the receiving system reads from.'));
    } else {
      let writable = false;
      try { fs.mkdirSync(dir, { recursive: true }); fs.accessSync(dir, fs.constants.W_OK); writable = true; } catch { writable = false; }
      findings.push(finding('transport', 'folder', 'Export folder', writable ? 'ok' : 'fail',
        writable ? `${dir} is writable from this host.` : `${dir} cannot be written to from this host.`,
        writable ? null : 'Check the share is mounted and this host has write access.'));
    }
  } else if (destination.transport === 'http_lhims' || destination.transport === 'http_json') {
    const url = String(destination.base_url ?? '');
    if (!url) {
      findings.push(finding('transport', 'url', 'Endpoint', 'fail', 'No URL is set for this destination.', 'Set the endpoint the receiving system documents.'));
    } else {
      let parsed: URL | null = null;
      try { parsed = new URL(url); } catch { parsed = null; }
      if (!parsed) {
        findings.push(finding('transport', 'url', 'Endpoint', 'fail', `${url} is not a valid URL.`, 'Correct the address, including its scheme.'));
      } else {
        const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
        const probe = await probeTcp(parsed.hostname, port, 2_000);
        findings.push(finding('network', 'reachable', 'Endpoint reachable', probe.reachable ? 'ok' : 'fail',
          probe.reachable ? `${parsed.hostname}:${port} answered.` : probe.detail,
          probe.reachable ? null : 'Check the host is up, the port is right, and nothing between here and there is blocking it.',
          probe.latencyMs));
      }
    }
  } else {
    if (!destination.host || !destination.port) {
      findings.push(finding('transport', 'address', 'Address', 'fail', 'No address or port is set for this destination.', 'Set the host and port the receiving system listens on.'));
    } else if (destination.is_protected) {
      findings.push(finding('network', 'reachable', 'Endpoint reachable', 'info',
        'Not probed. This is a protected production endpoint and the engine does not open connections to it.'));
    } else {
      const probe = await probeTcp(String(destination.host), Number(destination.port), 3_000);
      findings.push(finding('network', 'reachable', 'Endpoint reachable', probe.reachable ? 'ok' : 'fail',
        probe.reachable ? `${destination.host}:${destination.port} answered.` : probe.detail,
        probe.reachable ? null : 'Check the receiving system is running and listening on that port, and that the firewall between the two allows it.',
        probe.latencyMs));
      if (probe.banner) {
        findings.push(finding('protocol', 'banner', 'Greeting', 'info', `The endpoint sent ${probe.banner.length} byte(s) on connect.`));
      }
    }
  }

  /* ---- Authentication -------------------------------------------------- */
  if (destination.auth_scheme !== 'none') {
    const held = secretIsSet(destination.secret_cipher);
    findings.push(finding('destination', 'credential', 'Credential', held ? 'ok' : 'fail',
      held ? `A ${destination.auth_scheme} credential is stored, encrypted, for ${destination.username || 'this destination'}.`
        : `This destination is set to ${destination.auth_scheme} authentication and no credential is stored.`,
      held ? null : 'Enter the credential on the destination. It is encrypted at rest and never returned by the API.'));
  }

  /* ---- Acknowledgement policy ------------------------------------------ */
  findings.push(finding('destination', 'ack', 'Acknowledgement',
    deliveryIsConfirmable(destination.ack_policy) ? 'ok' : 'warn',
    deliveryIsConfirmable(destination.ack_policy)
      ? `This destination acknowledges, so a delivery marked delivered has been accepted by the receiving system.`
      : `This destination sends no acknowledgement. A delivery can be shown as transmitted, and acceptance by the receiving system is not established.`,
    deliveryIsConfirmable(destination.ack_policy) ? null : 'If the receiving system can acknowledge, set the policy to match. Reconcile periodically otherwise.'));

  /* ---- Mapping --------------------------------------------------------- */
  const mappings = db.prepare('SELECT COUNT(*) AS n, SUM(is_required) AS required FROM mw_mappings WHERE destination_id = ? AND is_active = 1').get(destinationId) as any;
  const mapped = Number(mappings?.n ?? 0);
  findings.push(finding('data', 'mapping', 'Field mapping', mapped ? 'ok' : 'info',
    mapped
      ? `${mapped} test code(s) mapped for this destination, ${Number(mappings?.required ?? 0)} of them required.`
      : 'No mapping is defined, so every result is sent with the analyser\'s own test code.',
    mapped ? null : 'Add mappings if this destination uses its own codes or units.'));

  /* ---- Delivery record ------------------------------------------------- */
  const deliveries = db.prepare(`SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN state = 'delivered' THEN 1 ELSE 0 END) AS delivered,
      SUM(CASE WHEN state IN ('queued','retrying','in_flight') THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN state = 'dead_letter' THEN 1 ELSE 0 END) AS dead,
      MAX(delivered_at) AS last_delivered
    FROM mw_deliveries WHERE destination_id = ?`).get(destinationId) as any;
  const totalDeliveries = Number(deliveries?.total ?? 0);
  findings.push(finding('destination', 'acceptance', 'Deliveries accepted',
    totalDeliveries === 0 ? 'info' : Number(deliveries?.dead ?? 0) ? 'warn' : 'ok',
    totalDeliveries === 0
      ? 'Nothing has been delivered to this destination yet.'
      : `${deliveries.delivered ?? 0} of ${totalDeliveries} accepted, ${deliveries.pending ?? 0} waiting, ${deliveries.dead ?? 0} in the dead-letter queue.`
        + (deliveries?.last_delivered ? ` Last accepted ${String(deliveries.last_delivered).slice(0, 16).replace('T', ' ')}.` : ''),
    Number(deliveries?.dead ?? 0) ? 'Open the dead-letter queue — each row carries the reason the destination gave.' : null));

  if (destination.last_error) {
    findings.push(finding('destination', 'last_error', 'Last error', 'warn', String(destination.last_error)));
  }

  /* ---- Queue ----------------------------------------------------------- */
  findings.push(finding('queue', 'backlog', 'Queue depth',
    Number(deliveries?.pending ?? 0) > 50 ? 'warn' : 'ok',
    `${deliveries?.pending ?? 0} delivery(ies) waiting for this destination.`,
    Number(deliveries?.pending ?? 0) > 50 ? 'A backlog that is not shrinking means the destination is refusing or unreachable. Fix the layer above before replaying.' : null));

  return {
    subject: String(destination.name),
    subjectKind: 'destination',
    subjectId: destinationId,
    at,
    status: worstStatus(findings),
    findings,
    summary: summarise(findings, Boolean(destination.is_protected)),
  };
}

/* ============================================================================
   The whole module, in one answer
   ========================================================================= */
export function diagnoseSystem(db: DB): DiagnosticReport {
  const findings: DiagnosticFinding[] = [];
  const at = new Date().toISOString();

  const links = db.prepare('SELECT COUNT(*) AS n, SUM(CASE WHEN state = \'error\' THEN 1 ELSE 0 END) AS failing FROM instrument_links WHERE is_active = 1').get() as any;
  findings.push(finding('transport', 'links', 'Analyser links',
    Number(links?.failing ?? 0) ? 'warn' : 'ok',
    `${links?.n ?? 0} active link(s), ${links?.failing ?? 0} failing.`));

  const destinations = db.prepare(`SELECT
      COUNT(*) AS n,
      SUM(CASE WHEN state = 'active' THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN state IN ('degraded','failed','disconnected') THEN 1 ELSE 0 END) AS unwell,
      SUM(CASE WHEN state = 'awaiting_approval' THEN 1 ELSE 0 END) AS waiting
    FROM mw_destinations WHERE is_active = 1`).get() as any;
  findings.push(finding('destination', 'destinations', 'Destinations',
    Number(destinations?.unwell ?? 0) ? 'warn' : 'ok',
    `${destinations?.active ?? 0} active, ${destinations?.unwell ?? 0} degraded or disconnected, ${destinations?.waiting ?? 0} awaiting approval.`,
    Number(destinations?.waiting ?? 0) ? 'A destination awaiting approval receives nothing until it is approved and activated.' : null));

  const queue = db.prepare(`SELECT
      SUM(CASE WHEN state IN ('queued','retrying') THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN state = 'in_flight' THEN 1 ELSE 0 END) AS in_flight,
      SUM(CASE WHEN state = 'dead_letter' THEN 1 ELSE 0 END) AS dead
    FROM mw_deliveries`).get() as any;
  const pending = Number(queue?.pending ?? 0);
  findings.push(finding('queue', 'depth', 'Queue depth',
    pending > 250 ? 'fail' : pending > 50 || Number(queue?.dead ?? 0) ? 'warn' : 'ok',
    `${pending} waiting, ${queue?.in_flight ?? 0} in flight, ${queue?.dead ?? 0} dead-lettered.`,
    pending > 50 ? 'Diagnose the destination with the largest backlog first; replaying into a destination that is refusing only grows the queue.' : null));

  const routes = db.prepare('SELECT COUNT(*) AS n FROM mw_routes WHERE is_active = 1').get() as any;
  const unrouted = db.prepare("SELECT COUNT(*) AS n FROM mw_messages WHERE status = 'no_route' AND received_at >= datetime('now','-7 days')").get() as any;
  findings.push(finding('data', 'routes', 'Routing rules',
    Number(routes?.n ?? 0) === 0 ? 'info' : Number(unrouted?.n ?? 0) ? 'warn' : 'ok',
    Number(routes?.n ?? 0) === 0
      ? 'No routing rule is configured, so messages are held in SECHLIMS and transmitted nowhere.'
      : `${routes.n} active rule(s). ${unrouted?.n ?? 0} message(s) in the last seven days matched none of them.`,
    Number(unrouted?.n ?? 0) ? 'Open those messages in the Explorer and re-route them once a rule covers them.' : null));

  const baselines = db.prepare('SELECT label, last_verdict, last_verified_at FROM mw_baselines WHERE is_protected = 1').all() as any[];
  for (const baseline of baselines) {
    findings.push(finding('network', `baseline:${baseline.label}`, `Baseline — ${baseline.label}`,
      baseline.last_verdict === 'drifted' ? 'warn' : baseline.last_verdict ? 'ok' : 'info',
      baseline.last_verdict
        ? `Last verified ${String(baseline.last_verified_at).slice(0, 16).replace('T', ' ')}: ${baseline.last_verdict}.`
        : 'Captured, and not verified since.',
      baseline.last_verdict === 'drifted' ? 'Settings differ from the recorded baseline. SECHLIMS changed nothing — check who changed the connection.' : null));
  }

  return {
    subject: 'Analyser transmission and middleware',
    subjectKind: 'system',
    subjectId: null,
    at,
    status: worstStatus(findings),
    findings,
    summary: summarise(findings, false),
  };
}

/* ============================================================================
   Helpers
   ========================================================================= */
function summarise(findings: DiagnosticFinding[], isProtected: boolean): string {
  const failed = findings.filter(f => f.status === 'fail');
  const warned = findings.filter(f => f.status === 'warn');
  if (isProtected && !failed.length) {
    return 'Held read-only as a protected production connection. Nothing was bound, dialled or probed.';
  }
  if (failed.length) return `${failed.length} check(s) failed. The first is: ${failed[0].detail}`;
  if (warned.length) return `Everything essential passed, with ${warned.length} thing(s) worth attention. The first is: ${warned[0].detail}`;
  return 'Every check passed.';
}

function safeList(dir: string): string[] {
  try { return fs.readdirSync(dir); } catch { return []; }
}

/** The addresses an analyser on the bench could actually reach this host on. */
export function lanAddresses(): Array<{ name: string; address: string }> {
  const out: Array<{ name: string; address: string }> = [];
  const interfaces = os.networkInterfaces();
  for (const [name, list] of Object.entries(interfaces)) {
    for (const entry of list ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      out.push({ name, address: entry.address });
    }
  }
  return out;
}
