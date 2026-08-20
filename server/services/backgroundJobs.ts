/**
 * Everything the host does on its own, once.
 *
 * These jobs — automatic backups, the alert scan, the duty and activity
 * rollover, the environmental poller, the sync engine — used to be started
 * inside the `import.meta.url === argv[1]` block at the bottom of
 * server/index.ts. That block runs when somebody launches the API directly
 * (`npm run api`) and NEVER runs in the packaged desktop application, which
 * imports `createApiServer()` and calls `listen()` itself.
 *
 * So on the machine a laboratory actually uses, the schedule screen accepted a
 * backup schedule, drew the next run time, and nothing ever took a backup. The
 * alert scan and the duty rollover were silently missing for the same reason.
 *
 * One function, called by both entry points, is the fix — and the reason the
 * jobs live here rather than in either caller.
 *
 * Every job self-gates on its own stored settings, so starting them all is
 * always safe: a laboratory that has not turned automatic backups on simply has
 * a timer that decides there is nothing to do.
 */
import type { getDb as GetDb } from '../db/database.js';

type DbGetter = typeof GetDb;

let started = false;
const timers: NodeJS.Timeout[] = [];

/** Run `fn` after `delayMs`, then every `everyMs`. Failures are logged, never fatal. */
function every(label: string, delayMs: number, everyMs: number, fn: () => unknown) {
  const tick = async () => {
    try { await fn(); } catch (e) { console.error(`[jobs] ${label} failed:`, e); }
  };
  timers.push(setTimeout(tick, delayMs));
  timers.push(setInterval(tick, everyMs));
}

/**
 * Start the host's background jobs. Idempotent: calling it twice in one process
 * (the desktop app retries its API startup on a busy port) starts one set.
 */
export function startBackgroundServices(getDb: DbGetter): void {
  if (started) return;
  started = true;

  // Environmental polling. Idle until a laboratory turns automated polling on.
  import('./environmental/monitorService.js')
    .then(({ EnvironmentalPoller }) => new EnvironmentalPoller(getDb).start())
    .catch(e => console.error('[jobs] environmental poller failed to start:', e));

  // Automatic backups. Self-gates on the stored schedule, and takes a missed
  // backup shortly after a host that was switched off overnight comes back.
  import('./backupService.js')
    .then(({ BackupScheduler }) => { new BackupScheduler().start(); console.log('[jobs] backup scheduler started'); })
    .catch(e => console.error('[jobs] backup scheduler failed to start:', e));

  // Synchronization engine (stub). Self-gates on SECH_LIMS_SYNC_ENABLED.
  import('../sync/syncEngine.js')
    .then(({ getSyncEngine }) => getSyncEngine().start())
    .catch(e => console.error('[jobs] sync engine failed to start:', e));

  // Alert scan: every module's due, overdue, expiring, excursion and pending
  // items, routed to the right staff by section and role. Idempotent.
  import('./alertService.js')
    .then(({ runAlertScanAndRoute }) => every('alert scan', 20_000, 15 * 60_000, () => runAlertScanAndRoute(getDb(), null)))
    .catch(e => console.error('[jobs] alert scheduler failed to start:', e));

  // Duty and activity rollover, and the system's audit of itself. Three jobs on
  // one timer, each idempotent, so a restart mid-morning costs nothing.
  Promise.all([
    import('./scheduleRollover.js'),
    import('./activityService.js'),
    import('./systemAuditService.js'),
  ]).then(([schedules, activities, systemAudit]) => {
    every('duty & activity tick', 12_000, 10 * 60_000, () => {
      const db = getDb();
      try { schedules.runScheduleTick(db); } catch (e) { console.error('[jobs] schedule tick failed:', e); }
      try { activities.runActivityTick(db); } catch (e) { console.error('[jobs] activity tick failed:', e); }
      try { systemAudit.throttledAuditScan(db); } catch (e) { console.error('[jobs] system audit scan failed:', e); }
    });
  }).catch(e => console.error('[jobs] duty & activity scheduler failed to start:', e));
}

/** Stop everything. Used by tests; the application runs these for its lifetime. */
export function stopBackgroundServices(): void {
  for (const t of timers) { clearTimeout(t); clearInterval(t); }
  timers.length = 0;
  started = false;
}
