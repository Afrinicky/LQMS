import { Router } from 'express';
import { getDb } from '../db/database.js';
import { seedDefaults, setupInitialSystem } from '../db/seed.js';
const router = Router();
router.get('/status', (_req, res) => {
  seedDefaults();
  const db = getDb();
  const setup = db.prepare("SELECT value FROM settings WHERE key = 'setupComplete'").get() as { value: string } | undefined;
  const adminCount = db.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number };
  const host = db.prepare("SELECT value FROM settings WHERE key = 'hostMode'").get() as { value: string } | undefined;
  res.json({ setupComplete: setup?.value === 'true', adminExists: adminCount.count > 0, hostMode: host?.value !== 'false' });
});
router.post('/initialize', (req, res) => {
  try { setupInitialSystem(req.body); res.status(201).json({ ok: true }); } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : 'Setup failed' }); }
});
export default router;
