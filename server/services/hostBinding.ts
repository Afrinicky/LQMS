/**
 * Which address the host listens on, and whether that survives a restart.
 *
 * The laboratory binds to loopback by default, which is right for one PC and
 * wrong the moment anybody expects to open it from the bench next door. Turning
 * that on used to mean setting SECH_LIMS_API_HOST=0.0.0.0 in the environment —
 * and an environment variable is not a setting. It lives in whatever shell or
 * shortcut happened to start the host, so the first restart puts the laboratory
 * back on loopback with nothing anywhere saying so.
 *
 * What that failure looks like is worth writing down, because it is confusing
 * enough to lose a morning to: a host published over Tailscale keeps working,
 * because Tailscale proxies to 127.0.0.1 and loopback is all it needs. The
 * plain LAN address stops, because nothing is listening on that interface any
 * more. One route up, one route down, no error on either.
 *
 * So the choice is stored in the database with everything else the laboratory
 * decides, and read on every start. The environment variable still wins when it
 * is set explicitly — somebody who writes it into a service definition means it,
 * and a stored setting must not silently overrule a deployment.
 *
 * The module also remembers what was ACTUALLY bound, which is not always what
 * was asked for: the desktop host walks up through fallback ports when its own
 * is taken. Reporting the intended port to somebody typing an address into
 * another machine is worse than reporting nothing.
 */
import { config } from '../config/index.js';

/** Just enough of the database handle to read and write one setting. */
type Db = { prepare: (sql: string) => { get: (...args: unknown[]) => unknown; run: (...args: unknown[]) => unknown } };

/** The key the laboratory's choice is stored under. */
export const LAN_SETTING_KEY = 'lanExposed';
/** The port the laboratory has chosen for itself, if it has chosen one. */
export const PORT_SETTING_KEY = 'apiPort';

/** Did somebody set the bind address in the environment deliberately? */
export function hostSetInEnvironment(): boolean {
  const raw = process.env.SECH_LIMS_API_HOST;
  return typeof raw === 'string' && raw.trim() !== '';
}

/** And the port? Same rule: a deployment that says so means it. */
export function portSetInEnvironment(): boolean {
  const raw = process.env.API_PORT;
  return typeof raw === 'string' && raw.trim() !== '';
}

/** Every interface, rather than this machine alone. */
const ALL_INTERFACES = '0.0.0.0';
const LOOPBACK = '127.0.0.1';

export function hostIsLan(host?: string | null): boolean {
  return host === ALL_INTERFACES || host === '::';
}

/**
 * What the laboratory has chosen, ignoring the environment.
 *
 * Returns null when it has never chosen, which is different from choosing not
 * to: a host that has never been asked keeps the loopback default, and the
 * screen can say "not set up" rather than "switched off".
 */
export function storedLanChoice(db: Db): boolean | null {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(LAN_SETTING_KEY) as
      { value?: string } | undefined;
    if (!row?.value) return null;
    return String(row.value).toLowerCase() === 'true';
  } catch {
    // A host starting before its settings table exists must still start.
    return null;
  }
}

export function setStoredLanChoice(db: Db, exposed: boolean): void {
  db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`)
    .run(LAN_SETTING_KEY, exposed ? 'true' : 'false');
}

/**
 * The address to bind, deciding between the environment and the stored choice.
 *
 * `getDb` is passed rather than called at import, because this runs during
 * startup and the database may not be open yet. A host that cannot read its
 * setting binds to loopback — the safe answer, never the open one.
 */
export function resolveBindHost(getDb?: () => Db): string {
  if (hostSetInEnvironment()) return config.api.host;
  if (!getDb) return LOOPBACK;
  try {
    return storedLanChoice(getDb()) ? ALL_INTERFACES : LOOPBACK;
  } catch {
    return LOOPBACK;
  }
}

/**
 * The port the laboratory asked for.
 *
 * Which port the host answers on was reachable only by editing an environment
 * variable on the machine — which is the same problem the bind address had, and
 * it matters more: a laboratory that has to move off 4317 because something
 * else took it has no way to say so, and every device set up against the old
 * number quietly stops.
 */
export function storedPort(db: Db): number | null {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(PORT_SETTING_KEY) as
      { value?: string } | undefined;
    const value = Number(row?.value);
    return Number.isInteger(value) && value >= 1024 && value <= 65535 ? value : null;
  } catch {
    return null;
  }
}

export function setStoredPort(db: Db, port: number): void {
  db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`)
    .run(PORT_SETTING_KEY, String(port));
}

/** The port to listen on, deciding between the environment and the choice. */
export function resolvePort(getDb?: () => Db): number {
  if (portSetInEnvironment() || !getDb) return config.api.port;
  try {
    return storedPort(getDb()) ?? config.api.port;
  } catch {
    return config.api.port;
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
 * that the port "was already in use when it started". It had not been. The only
 * honest source for what was asked is the moment it was asked.
 */
export function recordBinding(host: string, port: number, asked?: number): void {
  bound = { host, port, asked: asked ?? port };
}

export function boundHost(): string { return bound?.host ?? config.api.host; }
export function boundPort(): number { return bound?.port ?? config.api.port; }

/** Can anything other than this machine reach the API at all? */
export function boundToLan(): boolean { return hostIsLan(boundHost()); }

/**
 * True when the host ended up somewhere other than the port it was asked for.
 *
 * Asked for, not configured: a laboratory that has chosen its own port is not
 * surprised to be on it, and warning about that would be noise. The warning is
 * for the host whose port was taken and walked on to the next one.
 */
export function portMovedFromConfigured(): boolean {
  return bound !== null && bound.port !== bound.asked;
}

/** The port this host asked for when it started. */
export function askedPort(): number { return bound?.asked ?? config.api.port; }
