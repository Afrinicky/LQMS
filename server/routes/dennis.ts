import { Router } from 'express';
import { getDb } from '../db/database.js';
import { createDennisPlaceholder } from '../services/dennisService.js';

export function dennisRoutes() {
  const router = Router();

  router.get('/activity-log', (_req, res) => {
    const rows = getDb().prepare(`SELECT created_at AS dateTime, user_id AS userId, module, action, dennis_mode AS aiMode, status FROM dennis_activity_logs ORDER BY created_at DESC LIMIT 100`).all();
    res.json({ rows });
  });

  router.get('/settings', (_req, res) => {
    const rows = getDb().prepare('SELECT setting_key AS key, setting_value AS value, updated_at AS updatedAt FROM dennis_settings ORDER BY setting_key').all();
    res.json({ settings: rows });
  });

  router.post('/placeholder', (req, res) => {
    const action = String(req.body?.action ?? 'Dennis request');
    res.json(createDennisPlaceholder(action));
  });

  return router;
}
