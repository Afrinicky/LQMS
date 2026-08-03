import { Router } from 'express';
import { getStore } from '../db/store.js';
import { seedDefaults, setupInitialSystem } from '../db/seed.js';

const router = Router();

// First module migrated onto the DataStore seam (Phase 2). The queries below go
// through getStore() instead of getDb().prepare(...), so this endpoint is
// backend-agnostic. Behaviour and response shape are unchanged.
router.get('/status', async (_req, res, next) => {
  try {
    seedDefaults();
    const store = getStore();
    const setup = await store.get<{ value: string }>("SELECT value FROM settings WHERE key = 'setupComplete'");
    const admin = await store.get<{ count: number }>('SELECT COUNT(*) AS count FROM users');
    const host = await store.get<{ value: string }>("SELECT value FROM settings WHERE key = 'hostMode'");
    res.json({
      setupComplete: setup?.value === 'true',
      adminExists: (admin?.count ?? 0) > 0,
      hostMode: host?.value !== 'false',
    });
  } catch (err) {
    next(err);
  }
});

router.post('/initialize', (req, res) => {
  try {
    setupInitialSystem(req.body);
    res.status(201).json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Setup failed' });
  }
});

export default router;
