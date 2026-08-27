/**
 * Configurable dropdown lists.
 *
 *   GET    /config/option-lists            the registered lists + their options
 *   GET    /config/option-lists/:key       one list's options (view — any user)
 *   POST   /config/option-lists/:key       add an option
 *   PUT    /config/options/:id             rename / re-map / activate an option
 *   DELETE /config/options/:id             remove an option (never a built-in)
 *   POST   /config/option-lists/:key/reorder   set the display order
 *
 * Viewing is open to anyone who can read the screens that use a list; editing
 * needs the settings permission, because a picklist is configuration.
 */
import { Router } from 'express';
import { getDb } from '../db/database.js';
import { requirePermission } from '../middleware/permissions.js';
import { requireAuth } from '../middleware/auth.js';
import { audit } from '../services/auditService.js';
import { CONFIG_LISTS, configListDef } from '../../shared/constants/configLists.js';
import { isArchetype } from '../../shared/constants/equipment.js';

const slug = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);

function readOptions(db: any, key: string) {
  return (db.prepare('SELECT id, list_key, value, label, extra, sort_order, is_active, is_system FROM config_options WHERE list_key = ? ORDER BY sort_order, label').all(key) as any[])
    .map(o => ({ ...o, extra: o.extra ? JSON.parse(o.extra) : null }));
}

// The archetype an option must carry, validated against the registry so an
// equipment category can never be pinned to a behaviour that does not exist.
function resolveExtra(key: string, body: Record<string, unknown>): string | null {
  const def = configListDef(key);
  if (!def?.archetypeOf) return null;
  const archetype = String(body.archetype ?? '').trim();
  if (!isArchetype(archetype)) throw new Error(`Choose a valid behaviour for this option (${def.archetypeOf.join(', ')}).`);
  return JSON.stringify({ archetype });
}

export function configOptionsRoutes() {
  const router = Router();

  router.get('/config/option-lists', requirePermission('settings', 'view'), (_req, res) => {
    const db = getDb();
    res.json(CONFIG_LISTS.map(def => ({
      key: def.key, label: def.label, description: def.description,
      archetypeOf: def.archetypeOf ?? null,
      options: readOptions(db, def.key),
    })));
  });

  // Any authenticated user may read a list — the equipment form needs it — so
  // this is gated only by being logged in, not by the settings permission.
  // These lists are the laboratory's own configured vocabulary — unit names,
  // categories, suppliers' terms. Readable by anybody signed in, because every
  // form needs them, but not by an unauthenticated caller on the LAN.
  router.get('/config/option-lists/:key', requireAuth, (req, res) => {
    if (!configListDef(req.params.key)) return res.status(404).json({ error: 'Unknown list.' });
    res.json(readOptions(getDb(), req.params.key));
  });

  router.post('/config/option-lists/:key', requirePermission('settings', 'edit'), (req, res) => {
    const key = req.params.key;
    if (!configListDef(key)) return res.status(404).json({ error: 'Unknown list.' });
    const label = String(req.body.label ?? '').trim();
    if (!label) return res.status(400).json({ error: 'A label is required.' });
    const value = slug(String(req.body.value ?? label));
    if (!value) return res.status(400).json({ error: 'Give the option a short code.' });
    const db = getDb();
    if (db.prepare('SELECT 1 FROM config_options WHERE list_key = ? AND value = ?').get(key, value)) {
      return res.status(409).json({ error: `An option with code "${value}" already exists in this list.` });
    }
    let extra: string | null;
    try { extra = resolveExtra(key, req.body); } catch (e) { return res.status(400).json({ error: (e as Error).message }); }
    const nextOrder = (db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM config_options WHERE list_key = ?').get(key) as { n: number }).n;
    const r = db.prepare('INSERT INTO config_options (list_key, value, label, extra, sort_order, is_active, is_system) VALUES (?, ?, ?, ?, ?, 1, 0)')
      .run(key, value, label, extra, nextOrder);
    audit(req, { action: 'create', entity: 'config_options', entityId: Number(r.lastInsertRowid), newValue: { key, value, label } });
    res.status(201).json({ id: Number(r.lastInsertRowid), value });
  });

  router.put('/config/options/:id', requirePermission('settings', 'edit'), (req, res) => {
    const db = getDb();
    const opt = db.prepare('SELECT * FROM config_options WHERE id = ?').get(req.params.id) as any;
    if (!opt) return res.status(404).json({ error: 'Option not found.' });
    const label = req.body.label !== undefined ? String(req.body.label).trim() : opt.label;
    if (!label) return res.status(400).json({ error: 'A label is required.' });
    const isActive = req.body.isActive === undefined ? opt.is_active : (req.body.isActive ? 1 : 0);
    let extra = opt.extra;
    if (configListDef(opt.list_key)?.archetypeOf && req.body.archetype !== undefined) {
      try { extra = resolveExtra(opt.list_key, req.body); } catch (e) { return res.status(400).json({ error: (e as Error).message }); }
    }
    db.prepare('UPDATE config_options SET label = ?, extra = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(label, extra, isActive, req.params.id);
    audit(req, { action: 'edit', entity: 'config_options', entityId: Number(req.params.id), oldValue: opt, newValue: { label, isActive } });
    res.json({ ok: true });
  });

  router.delete('/config/options/:id', requirePermission('settings', 'void_archive'), (req, res) => {
    const db = getDb();
    const opt = db.prepare('SELECT * FROM config_options WHERE id = ?').get(req.params.id) as any;
    if (!opt) return res.status(404).json({ error: 'Option not found.' });
    // A built-in underpins behaviour elsewhere; it can be deactivated but never
    // deleted, the same rule a panel's used component follows.
    if (opt.is_system) {
      db.prepare("UPDATE config_options SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
      audit(req, { action: 'edit', entity: 'config_options', entityId: Number(req.params.id), newValue: { deactivated: true } });
      return res.json({ ok: true, deactivated: true, message: 'A built-in option cannot be deleted — it was deactivated instead.' });
    }
    db.prepare('DELETE FROM config_options WHERE id = ?').run(req.params.id);
    audit(req, { action: 'delete', entity: 'config_options', entityId: Number(req.params.id), oldValue: opt });
    res.json({ ok: true });
  });

  router.post('/config/option-lists/:key/reorder', requirePermission('settings', 'edit'), (req, res) => {
    const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
    const db = getDb();
    const upd = db.prepare('UPDATE config_options SET sort_order = ? WHERE id = ? AND list_key = ?');
    const tx = db.transaction(() => ids.forEach((id: number, i: number) => upd.run(i, id, req.params.key)));
    tx();
    res.json({ ok: true });
  });

  return router;
}
