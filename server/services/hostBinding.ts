/**
 * Which address and port this host listens on.
 *
 * THE RULE: deciding how to listen must never depend on the database.
 *
 * It did, briefly, and that was a mistake worth writing down. The laboratory's
 * choice was stored in the settings table, so starting the server meant opening
 * SQLite and running every migration before the first socket could be bound —
 * and every failure in that path was caught and answered with "listen on
 * loopback". A database that was locked for a second, or a migration that threw
 * on one host, therefore took the whole laboratory off the network: the desktop
 * app still worked, because the window talks to 127.0.0.1, while every bench,
 * every tablet and every Tailscale address stopped answering, with nothing
 * anywhere saying why. A silent fallback to loopback is an outage that reports
 * itself as healthy.
 *
 * So the answer lives in one small file, `config/connectivity.json`, in the
 * laboratory's own data folder:
 *
 *     { "host": "0.0.0.0", "port": 4317 }
 *
 * It is read with one synchronous file read before anything else starts. The
 * settings screen writes it. A facility can also open it in Notepad, which is
 * the point — every laboratory running this configures its own network without
 * touching code, and without an administrator setting environment variables on
 * a machine nobody can log in to.
 *
 * Environment variables still exist, but only to SEED that file the first time.
 * They were the source of truth before, and that is exactly what made this
 * fragile: a host configured by SECH_LIMS_API_HOST=0.0.0.0 in one shortcut goes
 * back to loopback the moment somebody launches it another way, and the screen
 * that should fix it could only report that it was not allowed to. Seeding once
 * keeps every existing installation working and hands the choice to the people
 * using it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config/index.js';

/** Just enough of the database handle to read one setting. */
type Db = { prepare: (sql: string) => { get: (...args: unknown[]) => unknown; run: (...args: unknown[]) => unknown } };

/** Settings keys this session briefly used, imported once and then left alone. */
export const LAN_SETTING_KEY = 'lanExposed';
export const PORT_SETTING_KEY = 'apiPort';

const ALL_INTERFACES = '0.0.0.0';
const LOOPBACK = '127.0.0.1';

/**
 * Can anything other than this machine reach the host?
 *
 * True for every interface, and true for one named address of this machine —
 * binding the wired card is still a laboratory on the network. Only loopback
 * is private, and only loopback should make a screen say so.
 */
export function hostIsLan(host?: string | null): boolean {
  const value = String(host ?? '').trim();
  if (!value) return false;
  if (value === LOOPBACK || value === '::1' || value.toLowerCase() === 'localhost') return false;
  return true;
}

/* ----------------------------------------------------------------------------
   The file
   ------------------------------------------------------------------------- */

/** An address this laboratory is reached at, as the admin wants it shown. */
export type AddressEntry = {
  /** The address or hostname itself. */
  address: string;
  /** What this laboratory calls it. Blank falls back to the detected name. */
  label?: string;
  /** Kept out of the lists benches and analysers are pointed at. */
  hidden?: boolean;
  /** The one address this laboratory wants everybody to use. */
  primary?: boolean;
  /** Typed in by hand rather than found on an interface of this machine. */
  manual?: boolean;
};

export type TlsConfig = {
  enabled: boolean;
  /** Paths on this machine, so a certificate is never copied into a database. */
  certFile: string;
  keyFile: string;
};

export type NetworkConfig = {
  /**
   * What to bind.
   *
   * '0.0.0.0' is every interface, '127.0.0.1' is this machine only, and
   * anything else is one specific address on this machine — for a host with a
   * wired and a wireless card on the same network, or with a hotspot adapter
   * nobody wants it answering on.
   */
  host: string;
  port: number;
  /** Further ports to answer on, for a site whose policy fixes one. */
  extraPorts: number[];
  /**
   * The address this laboratory tells people to use.
   *
   * A detected address changes when a lease changes or a cable moves, and
   * every analyser and bench configured with the old one stops. A name the IT
   * team controls does not, so where a facility has one, it is what every
   * screen offers instead of whatever this machine happens to be called today.
   */
  publishedAddress: string;
  tls: TlsConfig;
  /** How detected addresses are shown, and any added by hand. */
  addresses: AddressEntry[];
};

export type NetworkConfigState = NetworkConfig & {
  /** Where this came from: the file, or the environment seeding it. */
  source: 'file' | 'environment';
  /** Set when the file could not be read or written, for the screen to show. */
  problem: string | null;
  path: string;
};

export function connectivityFilePath(): string {
  return path.join(config.db.dataDir, 'config', 'connectivity.json');
}

/** A plausible IPv4 or IPv6 literal. Not whether this machine has it. */
export function looksLikeAddress(value: unknown): boolean {
  const text = String(value ?? '').trim();
  if (!text) return false;
  if (/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(text)) {
    return text.split('.').every(part => Number(part) >= 0 && Number(part) <= 255);
  }
  return /^[0-9a-f:]+$/i.test(text) && text.includes(':');
}

/** A hostname somebody could type into a browser. */
export function looksLikeHostname(value: unknown): boolean {
  const text = String(value ?? '').trim();
  if (!text || text.length > 253) return false;
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i.test(text);
}

function port(value: unknown): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1024 && n <= 65535 ? n : null;
}

function sane(value: unknown): Partial<NetworkConfig> {
  const given = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const out: Partial<NetworkConfig> = {};

  /*
   * Every interface, this machine only, or one named address of this machine.
   *
   * A typo must not become a listen() that throws and a laboratory that will
   * not open, so anything unreadable is simply not taken and the caller keeps
   * what it had. An address that IS readable but no longer exists on this
   * machine is a different and more dangerous case, and is handled where the
   * socket is actually opened — see `bindHostOrFallback`.
   */
  const host = String(given.host ?? '').trim();
  if (host === ALL_INTERFACES || host === LOOPBACK || host === '::' || looksLikeAddress(host)) out.host = host;

  const main = port(given.port);
  if (main !== null) out.port = main;

  if (Array.isArray(given.extraPorts)) {
    const extra = given.extraPorts.map(port).filter((n): n is number => n !== null);
    out.extraPorts = [...new Set(extra)].filter(n => n !== out.port);
  }

  const published = String(given.publishedAddress ?? '').trim();
  if (!published || looksLikeAddress(published) || looksLikeHostname(published)) out.publishedAddress = published;

  const tls = (given.tls && typeof given.tls === 'object' ? given.tls : null) as Record<string, unknown> | null;
  if (tls) {
    out.tls = {
      enabled: tls.enabled === true,
      certFile: String(tls.certFile ?? '').trim(),
      keyFile: String(tls.keyFile ?? '').trim(),
    };
  }

  if (Array.isArray(given.addresses)) {
    const seen = new Set<string>();
    out.addresses = given.addresses
      .map(entry => (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>)
      .map(entry => ({
        address: String(entry.address ?? '').trim(),
        label: String(entry.label ?? '').trim(),
        hidden: entry.hidden === true,
        primary: entry.primary === true,
        manual: entry.manual === true,
      }))
      .filter(entry => {
        if (!entry.address) return false;
        const key = entry.address.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    // Exactly one primary, or none. Two would make every screen that shows
    // "the address to use" pick whichever it happened to read first.
    let found = false;
    for (const entry of out.addresses) {
      if (!entry.primary) continue;
      if (found) entry.primary = false;
      found = true;
    }
  }
  return out;
}

export const EMPTY_TLS: TlsConfig = { enabled: false, certFile: '', keyFile: '' };

let cached: NetworkConfigState | null = null;

/**
 * What this host should listen on.
 *
 * Reading cannot fail in a way that changes the answer: a missing file is
 * seeded from the environment, and an unreadable one falls back to the
 * environment too — which is what every installation used before this file
 * existed, so the worst case is the old behaviour rather than a dark network.
 */
export function networkConfig(refresh = false): NetworkConfigState {
  if (cached && !refresh) return cached;
  const file = connectivityFilePath();
  const fromEnvironment: NetworkConfig = {
    host: config.api.host, port: config.api.port,
    extraPorts: [], publishedAddress: '', tls: { ...EMPTY_TLS }, addresses: [],
  };

  let problem: string | null = null;
  let parsed: Partial<NetworkConfig> = {};
  let existed = false;
  try {
    if (fs.existsSync(file)) {
      existed = true;
      parsed = sane(JSON.parse(fs.readFileSync(file, 'utf8')));
    }
  } catch (err) {
    problem = `This host's connectivity file could not be read, so it is using the values it started with. ${String(err)}`;
  }

  const resolved: NetworkConfig = {
    host: parsed.host ?? fromEnvironment.host,
    port: parsed.port ?? fromEnvironment.port,
    extraPorts: parsed.extraPorts ?? [],
    publishedAddress: parsed.publishedAddress ?? '',
    tls: parsed.tls ?? { ...EMPTY_TLS },
    addresses: parsed.addresses ?? [],
  };

  // Seed it, so the next person has something to edit and the screen has
  // something to change. A host that cannot write its own data folder has
  // bigger problems, and still runs.
  if (!existed || problem) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(resolved, null, 2)}\n`, 'utf8');
    } catch (err) {
      problem = problem ?? `This host's connectivity file could not be written, so a change here will not survive a restart. ${String(err)}`;
    }
  }

  cached = { ...resolved, source: existed && !problem ? 'file' : 'environment', problem, path: file };
  return cached;
}

/** Change the address, the port, or both. Takes effect at the next restart. */
export function writeNetworkConfig(patch: Partial<NetworkConfig>): NetworkConfigState {
  const current = networkConfig();
  const next: NetworkConfig = {
    host: patch.host ?? current.host,
    port: patch.port ?? current.port,
    extraPorts: patch.extraPorts ?? current.extraPorts,
    publishedAddress: patch.publishedAddress ?? current.publishedAddress,
    tls: patch.tls ?? current.tls,
    addresses: patch.addresses ?? current.addresses,
  };
  const checked = sane(next);
  if (checked.host === undefined || checked.port === undefined) {
    throw new Error('An address must be 0.0.0.0, 127.0.0.1, or one of this machine\u2019s own addresses, '
      + 'and a port must be between 1024 and 65535.');
  }
  const written: NetworkConfig = {
    host: checked.host,
    port: checked.port,
    extraPorts: checked.extraPorts ?? [],
    publishedAddress: checked.publishedAddress ?? '',
    tls: checked.tls ?? { ...EMPTY_TLS },
    addresses: checked.addresses ?? [],
  };
  const file = connectivityFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(written, null, 2)}\n`, 'utf8');
  cached = { ...written, source: 'file', problem: null, path: file };
  return cached;
}

/* ----------------------------------------------------------------------------
   What to listen on
   ------------------------------------------------------------------------- */

/**
 * The address to actually bind, having checked this machine still has it.
 *
 * This is the safety net under the whole feature. An administrator can now
 * bind one named address — the wired card rather than the wireless one, say —
 * and that address is a fact about the machine on the day it was chosen. A
 * cable moves, a lease changes, an IT team reorganises the network, and the
 * address is simply gone. `listen()` on an address a machine does not have
 * throws EADDRNOTAVAIL, the host does not come up, and the laboratory loses
 * everything rather than one adapter.
 *
 * So the choice is verified against the interfaces that exist right now. If it
 * is missing, the host falls back to every interface and SAYS SO. Falling back
 * silently is what this file's opening comment warns against; falling back
 * loudly keeps the laboratory on the network and still tells somebody the
 * setting no longer matches the machine.
 */
export function bindHostOrFallback(): { host: string; fellBackFrom: string | null } {
  const wanted = networkConfig().host;
  if (wanted === ALL_INTERFACES || wanted === LOOPBACK || wanted === '::') {
    return { host: wanted, fellBackFrom: null };
  }
  try {
    const have = new Set<string>();
    for (const list of Object.values(os.networkInterfaces())) {
      for (const entry of list ?? []) have.add(String(entry.address));
    }
    if (have.has(wanted)) return { host: wanted, fellBackFrom: null };
  } catch {
    // If the interfaces cannot be read, binding everything is the safe answer.
    return { host: ALL_INTERFACES, fellBackFrom: wanted };
  }
  return { host: ALL_INTERFACES, fellBackFrom: wanted };
}

export function resolveBindHost(): string { return bindHostOrFallback().host; }
export function resolvePort(): number { return networkConfig().port; }

/** Whether the laboratory has said other devices may reach it. */
export function lanChosen(): boolean { return hostIsLan(networkConfig().host); }

/**
 * Bring across a choice made while this was a database setting.
 *
 * Called once the server is already listening, so nothing about starting up
 * depends on it. It only writes when the file is still the seeded one, so a
 * laboratory that has since set its address from the screen keeps that.
 */
export function importLegacyChoices(db: Db): void {
  try {
    const current = networkConfig();
    if (current.source === 'file') return;
    const read = (key: string) => (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      { value?: string } | undefined)?.value ?? null;
    const lan = read(LAN_SETTING_KEY);
    const port = Number(read(PORT_SETTING_KEY));
    const patch: Partial<NetworkConfig> = {};
    // Only a choice that OPENS the network is brought across. Closing it is
    // also the default, so a stored "false" cannot be told apart from a host
    // that never chose — and guessing wrong in that direction takes a working
    // laboratory off the network on the strength of a row in a table. A
    // laboratory that really wants it closed says so on the screen, which
    // writes the file directly and never comes through here.
    if (String(lan).toLowerCase() === 'true') patch.host = ALL_INTERFACES;
    if (Number.isInteger(port) && port >= 1024 && port <= 65535) patch.port = port;
    if (Object.keys(patch).length) writeNetworkConfig(patch);
  } catch {
    // A laboratory with no such setting, or no readable database yet, simply
    // keeps what the file says. This is a convenience, never a requirement.
  }
}

/* ----------------------------------------------------------------------------
   What was actually bound
   ------------------------------------------------------------------------- */
let bound: { host: string; port: number; asked: number } | null = null;

/**
 * Called once the listener is up, with what it really got — and what it had
 * asked for, which is not the same thing and cannot be recomputed later.
 *
 * Recomputing it was a real bug: choosing a new port from the settings screen
 * made the host compare today's binding against tomorrow's choice and announce
 * that the running port "was already in use when it started". It had not been.
 */
export function recordBinding(host: string, port: number, asked?: number): void {
  bound = { host, port, asked: asked ?? port };
}

export function boundHost(): string { return bound?.host ?? networkConfig().host; }
export function boundPort(): number { return bound?.port ?? networkConfig().port; }

/** Can anything other than this machine reach the API at all? */
export function boundToLan(): boolean { return hostIsLan(boundHost()); }

/** True when the host ended up somewhere other than the port it asked for. */
export function portMovedFromConfigured(): boolean {
  return bound !== null && bound.port !== bound.asked;
}

/** The port this host asked for when it started. */
export function askedPort(): number { return bound?.asked ?? networkConfig().port; }
