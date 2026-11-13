/**
 * The analyser transmission master switch.
 *
 * A laboratory may run SECHLIMS for quality management alone, and some must:
 * until a facility holds clearance to handle patient results in this system,
 * the honest configuration is one where SECHLIMS does not speak to an analyser
 * at all — it opens no socket, dials no address, watches no folder and accepts
 * no transmission. Controls and patient results are populated by TransLis, the
 * standalone middleware and result filler, which reaches a result-entry form in
 * the browser and never needs SECHLIMS to hold anything.
 *
 * So this is a switch, not a rewrite. NOTHING in the transmission or middleware
 * code is changed by it. When the switch is on, every part of that module runs
 * exactly as it did before this file existed; when it is off, the bridge and
 * the engine are stopped and the routes that would reach an analyser refuse.
 * The difference between the two states is entirely in this file and in the
 * guards it exports.
 *
 * WHAT OFF MEANS, precisely, because "off" is the whole point:
 *
 *   Refused — anything that communicates with an analyser or takes a message
 *   from one: starting the bridge or the engine, opening or dialling a link,
 *   listening, fetching, a posted feed message, a network scan, a destination
 *   test, a delivery, a replay. Also the whole Analyser Transmission &
 *   Middleware module, the Result Filler and the transmitted-result reports,
 *   which are hidden rather than left as buttons that would be refused.
 *
 *   Kept — control data the laboratory already holds. A control run already on
 *   the IQC bench can still be read, rejected and recorded against its chart.
 *   Quality management is what the facility is keeping; making it forget
 *   yesterday's control would serve nobody and protects no patient.
 *
 * The default is ON, so an installation that transmits today keeps transmitting
 * across this change and nobody has to notice it happened.
 */
import type { NextFunction, Request, Response } from 'express';
import type Database from 'better-sqlite3';
import { getDb } from '../db/database.js';

/** The stored setting. Absent means on, which is the default. */
export const MIDDLEWARE_SWITCH_KEY = 'analyser_middleware_enabled';

/** The code every refusal carries, so the UI can say why rather than "403". */
export const MIDDLEWARE_OFF_CODE = 'analyser_transmission_off';

/** What a person is told when something was refused because the switch is off. */
export const MIDDLEWARE_OFF_MESSAGE =
  'Analyser transmission and middleware is switched off for this laboratory. '
  + 'An administrator can switch it on under Settings → System.';

type Db = Database.Database;

/**
 * Is SECHLIMS allowed to touch an analyser?
 *
 * Read from the database every time rather than cached. This is a primary-key
 * lookup on a table of a few dozen rows, and a cache here would mean a host
 * that went on transmitting for as long as the cache lived after somebody
 * switched it off — which is the one failure this switch exists to prevent.
 */
export function middlewareEnabled(db?: Db): boolean {
  try {
    const database = db ?? getDb();
    const row = database.prepare('SELECT value FROM settings WHERE key = ?').get(MIDDLEWARE_SWITCH_KEY) as
      { value: string } | undefined;
    if (!row) return true;
    return row.value !== '0' && row.value !== 'false' && row.value !== 'off';
  } catch {
    // A database that cannot be read is not permission to start transmitting.
    return false;
  }
}

/**
 * Record the switch, then make the host match it.
 *
 * The write and the effect are one call on purpose. A switch that is stored but
 * not applied until the next restart is a switch that lies, and this one is
 * turned off for a legal reason rather than a cosmetic one.
 */
export function setMiddlewareEnabled(on: boolean, db?: Db): void {
  const database = db ?? getDb();
  database.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
  ).run(MIDDLEWARE_SWITCH_KEY, on ? '1' : '0');
  void applyMiddlewareSwitch();
}

/**
 * Start or stop the bridge and the engine so the running host agrees with the
 * stored switch.
 *
 * Called at boot and again whenever the switch changes. Both components carry
 * their own `started` guard, so calling this when nothing needs to change costs
 * nothing, and the stop paths are the ones they already use when a laboratory
 * stops a link by hand.
 */
export async function applyMiddlewareSwitch(): Promise<void> {
  const on = middlewareEnabled();
  const [bridgeModule, engineModule] = await Promise.all([
    import('./instrumentBridge/index.js'),
    import('./middleware/engine.js'),
  ]);

  if (on) {
    try { bridgeModule.getBridge(getDb).start(); }
    catch (e) { console.error('[switch] analyser bridge failed to start:', e); }
    try { engineModule.getEngine(getDb).start(); }
    catch (e) { console.error('[switch] middleware engine failed to start:', e); }
    return;
  }

  // Off. Stop the engine first, so nothing is picked up out of the queue while
  // the bridge is still closing its sockets.
  try { engineModule.currentEngine()?.stop(); }
  catch (e) { console.error('[switch] middleware engine failed to stop:', e); }
  try { bridgeModule.currentBridge()?.stop(); }
  catch (e) { console.error('[switch] analyser bridge failed to stop:', e); }
  console.log('[switch] analyser transmission is off: no link is open and nothing is being delivered');
}

/**
 * Refuse a request that would reach an analyser, or that belongs to a module
 * the switch hides entirely.
 *
 * 403 with a code rather than 404: the endpoint exists and the configuration is
 * the reason, and an administrator reading a log should be able to tell the
 * difference between "switched off" and "broken".
 */
export function requireMiddlewareOn(_req: Request, res: Response, next: NextFunction) {
  if (!middlewareEnabled()) {
    return res.status(403).json({ error: MIDDLEWARE_OFF_MESSAGE, code: MIDDLEWARE_OFF_CODE });
  }
  next();
}

/**
 * Answer a reading endpoint that sits inside a module which stays live.
 *
 * The analyser panels in Quality Control, external quality assessment and
 * verification are a few tabs inside pages that must keep working. A 403 there
 * would surface as a red bar across a page about something else, so when the
 * switch is off those endpoints answer with nothing found and say why. The
 * screens already draw the empty case, because an analyser that has sent
 * nothing yet looks the same.
 */
export function quietWhenMiddlewareOff<T>(empty: T) {
  return (_req: Request, res: Response, next: NextFunction) => {
    if (!middlewareEnabled()) {
      return res.json(empty as unknown as Record<string, unknown>);
    }
    next();
  };
}
