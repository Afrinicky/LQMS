/**
 * Where this host listens, which the transmission mode decides.
 *
 * This is the one place the two modes are more than wording.
 *
 *   direct — the software is standing on the analyser's own PC. It reads a
 *            folder on that machine, or a port on it, and the only browser
 *            that needs it is the one in front of the person using it. So it
 *            binds loopback, and nothing on the network can reach it at all.
 *
 *   lan    — the analysers transmit to this computer across the laboratory
 *            network and the benches open it by its address, so it binds every
 *            interface. That is an exposure, and it is one somebody chose.
 *
 * An installation nobody has set up yet binds loopback whichever way the
 * setting reads, because a host with no accounts on it should not be answering
 * the network while it waits for its first administrator.
 *
 * `TRANSLIS_HOST` overrides both, for a site that puts this behind something
 * of its own.
 */
import { getDb } from '../../server/db/database.js';
import { setupComplete } from './seed.js';
import { getSettings } from './settings.js';

export function listenHost(): string {
  if (process.env.TRANSLIS_HOST) return process.env.TRANSLIS_HOST;
  try {
    const db = getDb();
    if (!setupComplete(db)) return '127.0.0.1';
    return getSettings(db).mode === 'lan' ? '0.0.0.0' : '127.0.0.1';
  } catch {
    return '127.0.0.1';
  }
}

export function listenPort(): number {
  const port = Number(process.env.TRANSLIS_PORT);
  return Number.isFinite(port) && port > 0 ? port : 4330;
}
