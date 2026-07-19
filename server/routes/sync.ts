/**
 * Synchronization API (Phase 5 — stub). Reserves the REST contract the UI and a
 * future cloud engine will use. While sync is disabled, /status reports the
 * dormant state and /run returns a skipped result. See server/sync/syncEngine.ts.
 */
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import { getSyncEngine } from '../sync/syncEngine.js';

export function syncRoutes() {
  const router = Router();

  // Current synchronization state (enabled flag, node id, pending outbox count).
  router.get('/status', requireAuth, async (_req, res, next) => {
    try {
      res.json(await getSyncEngine().status());
    } catch (err) {
      next(err);
    }
  });

  // Manually trigger a sync direction. Gated behind the settings permission.
  // Returns a skipped result while synchronization is disabled.
  router.post('/run', requirePermission('settings', 'edit'), async (req, res, next) => {
    try {
      const engine = getSyncEngine();
      const direction = String((req.body ?? {}).direction ?? 'both').toLowerCase();
      let result;
      if (direction === 'push') result = await engine.push();
      else if (direction === 'pull') result = await engine.pull();
      else if (direction === 'submissions') {
        const { processed } = await engine.processSubmissions();
        result = { ok: true, skipped: false, pushed: 0, pulled: 0, message: `Processed ${processed} submission(s).` };
      } else {
        const subs = await engine.processSubmissions();
        const push = await engine.push();
        const pull = await engine.pull();
        result = {
          ok: push.ok && pull.ok,
          skipped: push.skipped || pull.skipped,
          pushed: push.pushed,
          pulled: pull.pulled,
          message: `Processed ${subs.processed} submission(s); pushed ${push.pushed}; pulled ${pull.pulled}.`,
        };
      }
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
