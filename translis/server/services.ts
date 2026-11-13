/**
 * What the TransLis host does on its own.
 *
 * Three things, against SECHLIMS's dozen: read the analysers, carry what they
 * say to wherever it is routed, and forget the clinical content once the
 * retention period has run.
 *
 * The first two are the same engine and the same bridge SECHLIMS starts, with
 * the same seam between them. They are started unconditionally here — there is
 * no master switch in this product, because transmitting is the entire reason
 * it is installed.
 */
import type { getDb as GetDb } from '../../server/db/database.js';
import { purgeExpired } from './settings.js';

type DbGetter = typeof GetDb;

let started = false;

/** Once a day, and once shortly after starting, so a host switched off for a
 *  week catches up rather than waiting until midnight. */
const PURGE_INTERVAL_MS = 24 * 60 * 60_000;
const PURGE_FIRST_DELAY_MS = 60_000;

export function startTransLisServices(getDb: DbGetter): void {
  if (started) return;
  started = true;

  // The analyser links. Every link set to start on its own, and — exactly as
  // in SECHLIMS — never one recorded as owned by another middleware, which the
  // bridge refuses to open. That refusal is in the shared code and TransLis
  // inherits it rather than restating it.
  import('../../server/services/instrumentBridge/index.js')
    .then(({ getBridge }) => { getBridge(getDb).start(); })
    .catch(e => console.error('[translis] analyser bridge failed to start:', e));

  // The engine, and the seam the bridge hands a recorded transmission to.
  Promise.all([
    import('../../server/services/middleware/engine.js'),
    import('../../server/services/instrumentBridge/index.js'),
  ]).then(([{ getEngine }, { observeMessages }]) => {
    const engine = getEngine(getDb);
    engine.start();
    observeMessages(message => {
      engine.ingest({
        linkId: message.linkId,
        instrumentMessageId: message.instrumentMessageId,
        protocol: message.protocol,
        kind: message.kind,
        sampleId: message.sampleId,
        lotNumber: message.lotNumber,
        instrument: message.instrument,
        runAt: message.runAt,
        results: message.results,
        raw: message.raw,
        source: 'bridge',
      });
    });
    console.log('[translis] middleware engine started');
  }).catch(e => console.error('[translis] middleware engine failed to start:', e));

  // Retention. A result this host no longer needs is a result it should not be
  // holding, and a policy that only runs when somebody presses a button is not
  // a policy.
  const sweep = () => {
    try {
      const result = purgeExpired(getDb());
      if (result.messages > 0) {
        console.log(`[translis] purged the values from ${result.messages} transmission(s) older than ${result.retentionDays} days`);
      }
    } catch (e) { console.error('[translis] retention sweep failed:', e); }
  };
  const first = setTimeout(sweep, PURGE_FIRST_DELAY_MS);
  const repeat = setInterval(sweep, PURGE_INTERVAL_MS);
  if (first.unref) first.unref();
  if (repeat.unref) repeat.unref();
}
