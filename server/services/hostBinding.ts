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
import path from 'node:path';
import { config } from '../config/index.js';

/** Just enough of the database handle to read one setting. */
type Db = { prepare: (sql: string) => { get: (...args: unknown[]) => unknown; run: (...args: unknown[]) => unknown } };

/** Settings keys this session briefly used, imported once and then left alone. */
export const LAN_SETTING_KEY = 'lanExposed';
export const PORT_SETTING_KEY = 'apiPort';

const ALL_INTERFACES = '0.0.0.0';
const LOOPBACK = '127.0.0.1';

export function hostIsLan(host?: string | null): boolean {
  return host === ALL_INTERFACES || host === '::';
}

/* ----------------------------------------------------------------------------
   The file
   ------------------------------------------------------------------------- */

export type NetworkConfig = {
  /** '0.0.0.0' for every device on the network, '127.0.0.1' for this one. */
  host: string;
  port: number;
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

function sane(value: unknown): Partial<NetworkConfig> {
  const given = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const out: Partial<NetworkConfig> = {};
  const host = String(given.host ?? '').trim();
  // Only the two answers this means anything for. A typo in a hand-edited file
  // must not become a listen() that throws and a laboratory that will not open.
  if (host === ALL_INTERFACES || host === LOOPBACK || host === '::') out.host = host;
  const port = Number(given.port);
  if (Number.isInteger(port) && port >= 1024 && port <= 65535) out.port = port;
  return out;
}

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
  const fromEnvironment: NetworkConfig = { host: config.api.host, port: config.api.port };

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
  };
  const checked = sane(next);
  if (checked.host === undefined || checked.port === undefined) {
    throw new Error('A connectivity setting must be an address of 0.0.0.0 or 127.0.0.1 and a port between 1024 and 65535.');
  }
  const file = connectivityFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ host: checked.host, port: checked.port }, null, 2)}\n`, 'utf8');
  cached = { host: checked.host, port: checked.port, source: 'file', problem: null, path: file };
  return cached;
}

/* ----------------------------------------------------------------------------
   What to listen on
   ------------------------------------------------------------------------- */

export function resolveBindHost(): string { return networkConfig().host; }
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
