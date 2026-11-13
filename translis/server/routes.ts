/**
 * The routes TransLis adds on top of the ones it reuses.
 *
 * The analyser links, the middleware, the Result Filler and the transmitted
 * result reports are SECHLIMS's own routers, mounted unchanged. What is here
 * is only what this product has that SECHLIMS does not: a first-run setup, two
 * kinds of account rather than twenty profiles, the choice of where the
 * software is standing, and the retention policy.
 */
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { getDb } from '../../server/db/database.js';
import { requireAuth } from '../../server/middleware/auth.js';
import { requirePermission } from '../../server/middleware/permissions.js';
import { audit } from '../../server/services/auditService.js';
import { isAdministrator } from '../../server/middleware/administrator.js';
import { ADMIN_PROFILE, MODE_BLURB, MODE_LABEL, PRODUCT, PRODUCT_LONG, STAFF_PROFILE } from './brand.js';
import { createFirstAdministrator, seedTransLis, setupComplete } from './seed.js';
import { getSettings, purgeDue, purgeExpired, saveSettings } from './settings.js';
import { listenHost, listenPort } from './network.js';

/** Only an administrator configures this installation. */
const admin = requirePermission('settings', 'edit');

/** A password this product will accept. Stated rather than silently truncated. */
function checkPassword(password: unknown): string {
  const value = String(password ?? '');
  if (value.length < 8) throw new Error('A password must be at least 8 characters.');
  return value;
}

function checkUsername(username: unknown): string {
  const value = String(username ?? '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,40}$/.test(value)) {
    throw new Error('A username is 3 to 40 characters: letters, digits, dot, dash or underscore.');
  }
  return value;
}

export function translisRoutes() {
  const router = Router();

  /* ----------------------------------------------------------------- setup */

  /**
   * Whether this installation has been set up, asked before anybody signs in.
   *
   * Unauthenticated on purpose: it is the question the login screen has to ask
   * to know whether to show itself or the setup wizard, and the answer is one
   * boolean about an empty database.
   */
  router.get('/setup/status', (_req, res) => {
    const db = getDb();
    res.json({
      product: PRODUCT,
      productLong: PRODUCT_LONG,
      setupComplete: setupComplete(db),
      modes: (['lan', 'direct'] as const).map(key => ({ key, label: MODE_LABEL[key], blurb: MODE_BLURB[key] })),
    });
  });

  router.post('/setup/initialize', (req, res) => {
    const db = getDb();
    if (setupComplete(db)) return res.status(409).json({ error: 'This installation already has an account.' });
    try {
      const username = checkUsername(req.body?.username);
      const password = checkPassword(req.body?.password);
      const fullName = String(req.body?.fullName ?? '').trim();
      if (!fullName) return res.status(400).json({ error: 'Give the administrator’s name.' });
      createFirstAdministrator(db, { username, password, fullName });
      saveSettings(db, {
        mode: req.body?.mode,
        lisName: req.body?.lisName,
        retentionDays: req.body?.retentionDays,
      });
      res.json({ ok: true, settings: getSettings(db) });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : 'Setup failed.' });
    }
  });

  /* -------------------------------------------------------------- settings */

  /**
   * What this installation is. Readable by anybody signed in, because the
   * workspace draws itself differently in each mode and a member of staff has
   * to be able to see which one they are working in.
   */
  router.get('/settings', requireAuth, (_req, res) => {
    const db = getDb();
    const settings = getSettings(db);
    // What the host is bound to NOW, against what the stored mode asks for.
    // They differ between changing the mode and restarting, and a screen that
    // showed only the setting would be telling somebody the analysers can
    // reach this computer when they cannot yet.
    const boundTo = listenHost();
    res.json({
      ...settings,
      modes: (['lan', 'direct'] as const).map(key => ({ key, label: MODE_LABEL[key], blurb: MODE_BLURB[key] })),
      retention: purgeDue(db),
      network: {
        boundTo,
        port: listenPort(),
        reachableFromNetwork: boundTo !== '127.0.0.1',
        /** True when the mode has been changed and the host has not restarted. */
        restartNeeded: (settings.mode === 'lan') !== (boundTo !== '127.0.0.1'),
      },
    });
  });

  router.put('/settings', admin, (req, res) => {
    const db = getDb();
    const before = getSettings(db);
    try {
      const after = saveSettings(db, req.body ?? {});
      audit(req, { action: 'edit', entity: 'translis_settings', oldValue: before, newValue: after });
      res.json(after);
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : 'Those settings were not accepted.' });
    }
  });

  /** Purge now, rather than waiting for tonight's pass. */
  router.post('/settings/purge', admin, (req, res) => {
    const db = getDb();
    const result = purgeExpired(db);
    audit(req, { action: 'delete', entity: 'translis_retention', newValue: result });
    res.json({ ...result, retention: purgeDue(db) });
  });

  /* -------------------------------------------------------------- accounts */

  /**
   * The people who use this installation.
   *
   * Two kinds and no more. A profile is not chosen from a list of twenty here:
   * an account either configures the interfaces or fills results with them,
   * and anything finer than that belongs in a quality management system rather
   * than in a middleware.
   */
  router.get('/accounts', admin, (_req, res) => {
    const rows = getDb().prepare(
      `SELECT u.id, u.username, u.full_name fullName, u.is_active isActive, u.created_at createdAt,
              r.name profile, r.is_administrator isAdministrator
         FROM users u JOIN roles r ON r.id = u.role_id
        ORDER BY r.is_administrator DESC, u.username`,
    ).all();
    res.json({ accounts: rows, profiles: [ADMIN_PROFILE, STAFF_PROFILE] });
  });

  router.post('/accounts', admin, (req, res) => {
    const db = getDb();
    seedTransLis(db);
    try {
      const username = checkUsername(req.body?.username);
      const password = checkPassword(req.body?.password);
      const fullName = String(req.body?.fullName ?? '').trim();
      const profile = req.body?.profile === ADMIN_PROFILE ? ADMIN_PROFILE : STAFF_PROFILE;
      if (!fullName) return res.status(400).json({ error: 'Give the person’s name.' });
      if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) {
        return res.status(409).json({ error: 'That username is taken.' });
      }
      const role = db.prepare('SELECT id FROM roles WHERE name = ?').get(profile) as { id: number };
      const created = db.prepare(
        'INSERT INTO users (username, password_hash, full_name, role_id, is_active) VALUES (?, ?, ?, ?, 1)',
      ).run(username, bcrypt.hashSync(password, 10), fullName, role.id);
      audit(req, {
        action: 'create', entity: 'translis_account', entityId: Number(created.lastInsertRowid),
        newValue: { username, fullName, profile },
      });
      res.json({ id: Number(created.lastInsertRowid), username, fullName, profile });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : 'That account was not created.' });
    }
  });

  router.put('/accounts/:id', admin, (req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const user = db.prepare('SELECT u.*, r.name profile FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?')
      .get(id) as { id: number; username: string; profile: string; is_active: number } | undefined;
    if (!user) return res.status(404).json({ error: 'No such account.' });

    try {
      if (req.body?.password !== undefined) {
        db.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
          .run(bcrypt.hashSync(checkPassword(req.body.password), 10), id);
      }
      if (req.body?.fullName !== undefined) {
        db.prepare('UPDATE users SET full_name = ? WHERE id = ?').run(String(req.body.fullName).trim(), id);
      }
      if (req.body?.profile === ADMIN_PROFILE || req.body?.profile === STAFF_PROFILE) {
        // The last administrator cannot demote themselves into a product
        // nobody can configure. The refusal names the remedy.
        if (user.profile === ADMIN_PROFILE && req.body.profile === STAFF_PROFILE && lastAdministrator(id)) {
          return res.status(400).json({ error: 'This is the only administrator. Make somebody else an administrator first.' });
        }
        const role = db.prepare('SELECT id FROM roles WHERE name = ?').get(req.body.profile) as { id: number };
        db.prepare('UPDATE users SET role_id = ? WHERE id = ?').run(role.id, id);
      }
      if (req.body?.isActive !== undefined) {
        const active = req.body.isActive ? 1 : 0;
        if (!active && user.profile === ADMIN_PROFILE && lastAdministrator(id)) {
          return res.status(400).json({ error: 'This is the only administrator. Make somebody else an administrator first.' });
        }
        db.prepare('UPDATE users SET is_active = ? WHERE id = ?').run(active, id);
        if (!active) db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(id);
      }
      audit(req, {
        action: 'edit', entity: 'translis_account', entityId: id,
        oldValue: { username: user.username, profile: user.profile, isActive: user.is_active },
        newValue: { profile: req.body?.profile ?? user.profile, isActive: req.body?.isActive ?? user.is_active },
      });
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : 'That change was not accepted.' });
    }
  });

  /** Is this the only account that can still configure the installation? */
  function lastAdministrator(excludingUserId: number): boolean {
    const others = getDb().prepare(
      `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id
        WHERE u.is_active = 1 AND r.is_administrator = 1 AND u.id != ?`,
    ).all(excludingUserId) as Array<{ id: number }>;
    return others.every(row => !isAdministrator(row.id));
  }

  return router;
}
