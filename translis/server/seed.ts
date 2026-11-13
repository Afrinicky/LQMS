/**
 * What a TransLis database holds before anybody uses it.
 *
 * SECHLIMS seeds twenty access profiles, the organogram, the twelve quality
 * essentials and the positions that staff the laboratory. None of that means
 * anything here: TransLis carries results from an analyser to a laboratory
 * information system, and the only question it asks about a person is whether
 * they configure the interfaces or fill results with them.
 *
 * So there are two profiles and no third. The permission model underneath them
 * is SECHLIMS's own, unchanged — the same resolver, the same tables, the same
 * guards on the same routes — because the routes being reused are the ones
 * that ask it. What differs is only how little is written into it.
 */
import bcrypt from 'bcryptjs';
import type Database from 'better-sqlite3';
import { PERMISSION_ACTIONS } from '../../shared/constants/modules.js';
import { featuresOfModule } from '../../shared/constants/features.js';
import { ADMIN_PROFILE, STAFF_PROFILE } from './brand.js';

/**
 * The modules TransLis has.
 *
 * `analyser_middleware` is the workspace. `iqc` is here because the analyser
 * link routes are guarded on it in the shared code — a link is configured
 * under quality control in SECHLIMS, and reusing the route means reusing the
 * right it asks for rather than inventing a second one that could disagree.
 * `settings` governs this product's own administration.
 *
 * They are rows in `system_modules` because the resolver refuses everything
 * for a module it cannot find, which is the correct behaviour there and simply
 * means they have to exist here.
 */
const MODULES: Array<{ key: string; label: string; path: string }> = [
  { key: 'analyser_middleware', label: 'Analyser Transmission & Middleware', path: '/workspace' },
  { key: 'iqc', label: 'Analyser Links', path: '/analyser-sync' },
  { key: 'settings', label: 'Settings', path: '/settings' },
];

/**
 * What a member of staff may do.
 *
 * They fill results, and they may look at what has arrived to see whether an
 * analyser is transmitting before reporting a fault. They configure nothing:
 * not a link, not a destination, not a route, not a mapping, and they cannot
 * replay a result or roll a configuration back.
 *
 * `view` on `analyser_middleware.overview` is what opens Live Monitoring and
 * the Message Explorer; `view` on `analyser_middleware.result_filler` is what
 * the extension itself authenticates against on every fill.
 */
const STAFF_GRANTS: Array<[string, string[]]> = [
  ['analyser_middleware', ['view']],
  ['analyser_middleware.overview', ['view']],
  ['analyser_middleware.result_filler', ['view']],
];

/** Everything, for the one account that configures this installation. */
function administratorKeys(): string[] {
  return [
    ...MODULES.map(m => m.key),
    ...MODULES.flatMap(m => featuresOfModule(m.key).map(f => f.key)),
  ];
}

export function seedTransLis(db: Database.Database): void {
  const tx = db.transaction(() => {
    for (const module of MODULES) {
      db.prepare('INSERT OR IGNORE INTO system_modules (key, label, path, enabled, alerts_paused) VALUES (?, ?, ?, 1, 0)')
        .run(module.key, module.label, module.path);
      // A module switched off would refuse everything inside it, and TransLis
      // has no screen that switches one off, so an upgrade never leaves one
      // disabled by accident.
      db.prepare('UPDATE system_modules SET enabled = 1 WHERE key = ?').run(module.key);
      for (const action of PERMISSION_ACTIONS) {
        db.prepare('INSERT OR IGNORE INTO permissions (module_key, action, label) VALUES (?, ?, ?)')
          .run(module.key, action, `${module.label}: ${action}`);
      }
      for (const feature of featuresOfModule(module.key)) {
        for (const action of PERMISSION_ACTIONS) {
          db.prepare('INSERT OR IGNORE INTO permissions (module_key, action, label) VALUES (?, ?, ?)')
            .run(feature.key, action, `${feature.label}: ${action}`);
        }
      }
    }

    db.prepare("INSERT OR IGNORE INTO roles (name, description, is_system, kind) VALUES (?, ?, 1, 'position')")
      .run(ADMIN_PROFILE, 'Configures the analysers, the destinations and the accounts on this installation.');
    db.prepare("INSERT OR IGNORE INTO roles (name, description, is_system, kind) VALUES (?, ?, 1, 'position')")
      .run(STAFF_PROFILE, 'Fills results with the Result Filler, and watches what has arrived.');
    // The administrator flag reserves the few capabilities that sit outside the
    // permission matrix. It belongs to one profile and never to Staff.
    db.prepare('UPDATE roles SET is_administrator = 1 WHERE name = ?').run(ADMIN_PROFILE);
    db.prepare('UPDATE roles SET is_administrator = 0 WHERE name = ?').run(STAFF_PROFILE);

    const roleId = (name: string) =>
      Number((db.prepare('SELECT id FROM roles WHERE name = ?').get(name) as { id: number }).id);
    const permId = (key: string, action: string) =>
      (db.prepare('SELECT id FROM permissions WHERE module_key = ? AND action = ?').get(key, action) as { id: number } | undefined)?.id;

    const grant = (role: number, key: string, action: string, allowed: 0 | 1) => {
      const id = permId(key, action);
      if (!id) return;
      db.prepare('INSERT OR REPLACE INTO role_permissions (role_id, permission_id, allowed, source) VALUES (?, ?, ?, ?)')
        .run(role, id, allowed, 'Product default');
    };

    const admin = roleId(ADMIN_PROFILE);
    for (const key of administratorKeys()) {
      for (const action of PERMISSION_ACTIONS) grant(admin, key, action, 1);
    }

    // Staff are written as an explicit deny on everything first, then the three
    // grants. Writing only the grants would leave every other key unrecorded,
    // and "unrecorded" is a different thing from "refused" the moment somebody
    // edits a profile — this way the refusal is on the record and visible.
    const staff = roleId(STAFF_PROFILE);
    for (const key of administratorKeys()) {
      for (const action of PERMISSION_ACTIONS) grant(staff, key, action, 0);
    }
    for (const [key, actions] of STAFF_GRANTS) {
      for (const action of actions) grant(staff, key, action, 1);
    }
  });
  tx();
}

/** Is there an administrator yet? Until there is, the app runs its setup. */
export function setupComplete(db: Database.Database): boolean {
  try {
    const row = db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_active = 1').get() as { n: number };
    return row.n > 0;
  } catch { return false; }
}

/** The first administrator, created once by the setup screen. */
export function createFirstAdministrator(
  db: Database.Database,
  input: { username: string; password: string; fullName: string },
): { id: number } {
  if (setupComplete(db)) throw new Error('This installation already has an account.');
  seedTransLis(db);
  const role = db.prepare('SELECT id FROM roles WHERE name = ?').get(ADMIN_PROFILE) as { id: number };
  const result = db.prepare(
    'INSERT INTO users (username, password_hash, full_name, role_id, is_active) VALUES (?, ?, ?, ?, 1)',
  ).run(input.username.trim().toLowerCase(), bcrypt.hashSync(input.password, 10), input.fullName.trim(), role.id);
  return { id: Number(result.lastInsertRowid) };
}
