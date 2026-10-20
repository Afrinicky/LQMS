/**
 * Finding the analysers, and proposing how to talk to them.
 *
 * Discovery here is deliberately narrow, because a scanner on a hospital
 * network is not a laboratory tool:
 *
 *   SCOPE. Private address ranges only, /24 at widest, capped at 256 addresses
 *   and a named list of ports. A request outside that is refused rather than
 *   trimmed — somebody who typed /16 wants something this is not.
 *
 *   AUTHORITY. A scan has an actor and is recorded. "Who scanned the network"
 *   is a question a hospital will eventually ask.
 *
 *   SAFETY. A protected endpoint is never probed. A connect() to the port the
 *   LHIMS middleware is using is exactly the disturbance this module exists to
 *   avoid, so those addresses are skipped and counted, and the scan says so.
 *
 * What comes back is an open port and, where the endpoint says enough to tell,
 * a guess at what it is — with a confidence, because a guess presented as a
 * fact is how a laboratory ends up with a chemistry analyser configured as a
 * haematology one.
 *
 * Nothing here activates anything. A discovered endpoint becomes a PROPOSAL,
 * which is reviewed, tested in isolation and approved before it carries a
 * single result.
 */
import {
  DISCOVERY_CONNECT_TIMEOUT_MS, DISCOVERY_DEFAULT_PORTS, DISCOVERY_MAX_HOSTS,
  expandCidr, isPrivateAddress,
} from '../../../shared/constants/middleware.js';
import { INSTRUMENT_PROFILES } from '../../../shared/constants/instruments.js';
import { detectProtocol } from '../instrumentBridge/protocols.js';
import { probeTcp } from './diagnostics.js';
import { collidesWithProtected } from '../../../shared/constants/middleware.js';
import { protectedEndpoints } from './safety.js';

type DB = any;

export interface DiscoveryRequest {
  /** A single address, or a range as `192.168.1.0/24`. */
  target: string;
  ports?: number[] | null;
  userId: number | null;
}

export interface DiscoveredEndpoint {
  host: string;
  port: number;
  latencyMs: number;
  banner: string | null;
  protocolGuess: string | null;
  profileGuess: string | null;
  confidence: 'high' | 'medium' | 'low';
  conflict: 'none' | 'protected' | 'in_use';
  proposal: Record<string, unknown>;
  note: string;
}

export interface DiscoveryOutcome {
  ok: boolean;
  scanId: number | null;
  scanCode: string | null;
  hostsScanned: number;
  protectedSkipped: number;
  endpoints: DiscoveredEndpoint[];
  note: string;
}

/**
 * Run one scan.
 *
 * Probes run in small batches rather than all at once: 256 simultaneous
 * connections look like a port sweep to any network monitoring worth having,
 * and a laboratory does not need its middleware setting off the hospital's
 * intrusion detection.
 */
export async function runDiscovery(db: DB, request: DiscoveryRequest): Promise<DiscoveryOutcome> {
  const ports = (request.ports?.length ? request.ports : DISCOVERY_DEFAULT_PORTS)
    .map(Number).filter(p => Number.isInteger(p) && p > 0 && p < 65536).slice(0, 24);
  if (!ports.length) {
    return { ok: false, scanId: null, scanCode: null, hostsScanned: 0, protectedSkipped: 0, endpoints: [], note: 'No valid port was given to scan.' };
  }

  const target = String(request.target ?? '').trim();
  let hosts: string[] = [];
  if (target.includes('/')) {
    const expanded = expandCidr(target);
    if (expanded.error) {
      return { ok: false, scanId: null, scanCode: null, hostsScanned: 0, protectedSkipped: 0, endpoints: [], note: expanded.error };
    }
    hosts = expanded.hosts;
  } else if (isPrivateAddress(target)) {
    hosts = [target];
  } else {
    return {
      ok: false, scanId: null, scanCode: null, hostsScanned: 0, protectedSkipped: 0, endpoints: [],
      note: `${target || 'That address'} is not inside a private network. Discovery is limited to the laboratory's own network.`,
    };
  }
  if (hosts.length > DISCOVERY_MAX_HOSTS) {
    return { ok: false, scanId: null, scanCode: null, hostsScanned: 0, protectedSkipped: 0, endpoints: [], note: `A scan is limited to ${DISCOVERY_MAX_HOSTS} addresses.` };
  }

  const scanCode = `SCAN-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  const inserted = db.prepare(`INSERT INTO mw_discovery_scans (scan_code, target, ports, created_by, status)
      VALUES (?, ?, ?, ?, 'running')`).run(scanCode, target, ports.join(','), request.userId ?? null);
  const scanId = Number(inserted.lastInsertRowid);

  const protectedList = protectedEndpoints(db);
  const endpoints: DiscoveredEndpoint[] = [];
  let protectedSkipped = 0;

  const work: Array<{ host: string; port: number }> = [];
  for (const host of hosts) for (const port of ports) work.push({ host, port });

  const BATCH = 24;
  for (let i = 0; i < work.length; i += BATCH) {
    const slice = work.slice(i, i + BATCH);
    const results = await Promise.all(slice.map(async item => {
      // The refusal that matters. Counted, not probed, and reported.
      if (collidesWithProtected(item, protectedList)) return { item, skipped: true as const };
      const probe = await probeTcp(item.host, item.port, DISCOVERY_CONNECT_TIMEOUT_MS);
      return { item, skipped: false as const, probe };
    }));
    for (const result of results) {
      if (result.skipped) { protectedSkipped++; continue; }
      if (!result.probe.reachable) continue;
      endpoints.push(identify(db, result.item.host, result.item.port, result.probe.latencyMs, result.probe.banner));
    }
  }

  for (const endpoint of endpoints) {
    try {
      db.prepare(`INSERT OR IGNORE INTO mw_discovery_endpoints
          (scan_id, host, port, latency_ms, banner, protocol_guess, profile_guess, confidence, conflict, proposal, note)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(scanId, endpoint.host, endpoint.port, endpoint.latencyMs,
          endpoint.banner ? endpoint.banner.slice(0, 1_000) : null,
          endpoint.protocolGuess, endpoint.profileGuess, endpoint.confidence,
          endpoint.conflict, JSON.stringify(endpoint.proposal), endpoint.note);
    } catch { /* one endpoint failing to record must not lose the scan */ }
  }

  db.prepare(`UPDATE mw_discovery_scans SET finished_at = CURRENT_TIMESTAMP, hosts_scanned = ?,
      endpoints_found = ?, protected_skipped = ?, status = 'complete', note = ? WHERE id = ?`)
    .run(hosts.length, endpoints.length, protectedSkipped,
      protectedSkipped ? `${protectedSkipped} address(es) were skipped because they belong to a protected production transmission.` : null,
      scanId);

  return {
    ok: true, scanId, scanCode, hostsScanned: hosts.length, protectedSkipped, endpoints,
    note: endpoints.length
      ? `${endpoints.length} endpoint(s) answered across ${hosts.length} address(es).`
        + (protectedSkipped ? ` ${protectedSkipped} address(es) were skipped as protected.` : '')
      : `Nothing answered on ${ports.length} port(s) across ${hosts.length} address(es). An analyser that only receives connections will not answer a scan — configure it by hand.`,
  };
}

/**
 * What is probably at this endpoint, and what it would take to use it.
 *
 * A greeting that frames as ASTM or HL7 is strong evidence and says so. An
 * open port with nothing to say is an open port — confidence low, and the
 * proposal says it needs a test message before anybody believes it.
 */
function identify(db: DB, host: string, port: number, latencyMs: number, banner: string | null): DiscoveredEndpoint {
  const protocolGuess = banner ? detectProtocol(banner) : null;
  let profileGuess: string | null = null;
  let confidence: DiscoveredEndpoint['confidence'] = 'low';
  const notes: string[] = [];

  if (banner) {
    const upper = banner.toUpperCase();
    const vendor = INSTRUMENT_PROFILES.find(profile =>
      upper.includes(profile.vendor.toUpperCase()) ||
      profile.label.split(/[\s(/]/).some(word => word.length > 4 && upper.includes(word.toUpperCase())));
    if (vendor) { profileGuess = vendor.key; confidence = protocolGuess ? 'high' : 'medium'; notes.push(`The endpoint named itself in its greeting.`); }
    else if (protocolGuess) { confidence = 'medium'; notes.push(`The greeting frames as ${protocolGuess.toUpperCase()}, so the protocol is known and the model is not.`); }
    else { notes.push('The endpoint greeted the connection with something this system does not recognise.'); }
  } else {
    notes.push('The port is open and the endpoint said nothing. That is normal for an analyser that waits to be spoken to.');
  }

  // Already in the register? A laboratory re-scanning should see which of these
  // it has already configured rather than proposing them all again.
  let inUse = false;
  try {
    const existing = db.prepare(`SELECT id FROM instrument_links
        WHERE (listen_port = ? AND IFNULL(listen_host,'') IN ('', ?)) OR (remote_host = ? AND remote_port = ?)`)
      .get(port, host, host, port) as any;
    inUse = Boolean(existing);
  } catch { inUse = false; }

  const guessed = profileGuess ? INSTRUMENT_PROFILES.find(p => p.key === profileGuess) : null;
  return {
    host, port, latencyMs, banner,
    protocolGuess: protocolGuess ?? guessed?.protocol ?? null,
    profileGuess,
    confidence,
    conflict: inUse ? 'in_use' : 'none',
    note: notes.join(' ') + (inUse ? ' This address and port are already configured on an analyser link.' : ''),
    proposal: {
      // A proposal, not a configuration. The analyser dials the laboratory in
      // nearly every installation, so the proposed mode is the one that
      // actually works rather than the one the scan happened to discover.
      name: guessed ? `${guessed.label} (${host})` : `Analyser at ${host}:${port}`,
      profileKey: profileGuess,
      protocol: protocolGuess ?? guessed?.protocol ?? 'auto',
      mode: 'server',
      role: 'sechlims_only',
      suggestedListenPort: port,
      remoteHost: host,
      remotePort: port,
      requiresManualSteps: [
        'Set the analyser\'s host communication to this machine\'s address and the port on the link.',
        'Confirm the protocol in the analyser\'s own service menu — a scan cannot read it.',
        'Transmit one sample and check the parsed result before the link is approved.',
      ],
      confidence,
    },
  };
}

/** Every scan this laboratory has run, newest first. */
export function discoveryHistory(db: DB, limit = 20): any[] {
  try {
    return db.prepare(`SELECT s.*, u.full_name AS scanned_by FROM mw_discovery_scans s
        LEFT JOIN users u ON u.id = s.created_by ORDER BY s.id DESC LIMIT ?`).all(limit) as any[];
  } catch { return []; }
}

/** What one scan found. */
export function discoveryEndpoints(db: DB, scanId: number): any[] {
  try {
    const rows = db.prepare('SELECT * FROM mw_discovery_endpoints WHERE scan_id = ? ORDER BY host, port').all(scanId) as any[];
    return rows.map(row => ({
      ...row,
      proposal: safeJson(row.proposal),
    }));
  } catch { return []; }
}

function safeJson(value: unknown): unknown {
  if (typeof value !== 'string' || !value.trim()) return null;
  try { return JSON.parse(value); } catch { return null; }
}
