import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The rules that decide who may do what.
 *
 * The permission model came through the August 2026 validation better than
 * anything else in the system, which is precisely why it needs tests: these are
 * the invariants that must survive the next change to the resolver. Each one
 * corresponds to a real defect the RBAC audit found and fixed.
 */
const dataDir = path.join(os.tmpdir(), `sechlims-test-rbac-${process.pid}`);
process.env.SECH_LIMS_DATA_DIR = dataDir;

let getDb: typeof import('../server/db/database.js').getDb;
let resolvePermission: typeof import('../server/services/permissionResolver.js').resolvePermission;
let getEffectivePermissions: typeof import('../server/services/permissionResolver.js').getEffectivePermissions;

let technicianId: number;
let adminId: number;

beforeAll(async () => {
  fs.mkdirSync(dataDir, { recursive: true });
  ({ getDb } = await import('../server/db/database.js'));
  const { seedDefaults } = await import('../server/db/seed.js');
  ({ resolvePermission, getEffectivePermissions } = await import('../server/services/permissionResolver.js'));

  seedDefaults();
  const db = getDb();
  const roleId = (name: string) => (db.prepare('SELECT id FROM roles WHERE name = ?').get(name) as { id: number }).id;
  const makeUser = (username: string, role: string) => {
    db.prepare('INSERT INTO users (username, password_hash, full_name, role_id) VALUES (?, ?, ?, ?)')
      .run(username, 'x', username, roleId(role));
    return (db.prepare('SELECT id FROM users WHERE username = ?').get(username) as { id: number }).id;
  };
  technicianId = makeUser('t_tech', 'Technician');
  adminId = makeUser('t_admin', 'System Administrator');
});

afterAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('permission resolver', () => {
  it('gives the administrator the settings module', () => {
    expect(resolvePermission(adminId, 'settings', 'view').allowed).toBe(true);
  });

  it('keeps a technician out of user administration', () => {
    expect(resolvePermission(technicianId, 'settings', 'view').allowed).toBe(false);
    expect(getEffectivePermissions(technicianId).settings).toBeUndefined();
  });

  it('treats the right to view as a prerequisite for every other action', () => {
    const db = getDb();
    const perm = (moduleKey: string, action: string) =>
      (db.prepare('SELECT id FROM permissions WHERE module_key = ? AND action = ?').get(moduleKey, action) as { id: number }).id;

    // Grant print and export on documents but deny view: the classic mistake.
    for (const action of ['print', 'export']) {
      db.prepare('INSERT OR REPLACE INTO user_permission_overrides (user_id, permission_id, allowed, source) VALUES (?, ?, 1, ?)')
        .run(technicianId, perm('documents.library', action), 'Manual override');
    }
    db.prepare('INSERT OR REPLACE INTO user_permission_overrides (user_id, permission_id, allowed, source) VALUES (?, ?, 0, ?)')
      .run(technicianId, perm('documents.library', 'view'), 'Denied override');

    expect(resolvePermission(technicianId, 'documents.library', 'print').allowed).toBe(false);
    expect(resolvePermission(technicianId, 'documents.library', 'export').allowed).toBe(false);
  });

  it('grants an inactive user nothing at all', () => {
    getDb().prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(adminId);
    expect(resolvePermission(adminId, 'settings', 'view').allowed).toBe(false);
    expect(Object.keys(getEffectivePermissions(adminId))).toHaveLength(0);
    getDb().prepare('UPDATE users SET is_active = 1 WHERE id = ?').run(adminId);
  });

  it('grants nothing on a module the laboratory has switched off', () => {
    const db = getDb();
    expect(resolvePermission(adminId, 'iqc', 'view').allowed).toBe(true);
    db.prepare("UPDATE system_modules SET enabled = 0 WHERE key = 'iqc'").run();
    const decision = resolvePermission(adminId, 'iqc', 'view');
    expect(decision.allowed).toBe(false);
    expect(decision.source).toBe('Module disabled');
    db.prepare("UPDATE system_modules SET enabled = 1 WHERE key = 'iqc'").run();
  });

  it('seeds an independent reviewer who can read the trail but change nothing', () => {
    const db = getDb();
    const role = db.prepare("SELECT id FROM roles WHERE name = 'Independent Reviewer'").get() as { id: number } | undefined;
    expect(role, 'the Independent Reviewer role should be seeded').toBeTruthy();

    db.prepare('INSERT INTO users (username, password_hash, full_name, role_id) VALUES (?, ?, ?, ?)')
      .run('t_reviewer', 'x', 'Reviewer', role!.id);
    const reviewerId = (db.prepare("SELECT id FROM users WHERE username = 't_reviewer'").get() as { id: number }).id;

    expect(resolvePermission(reviewerId, 'records_reports.audit', 'view').allowed).toBe(true);
    // Reads the trail; holds no administrative right over the system it reviews.
    expect(resolvePermission(reviewerId, 'settings', 'view').allowed).toBe(false);
    expect(resolvePermission(reviewerId, 'records_reports.audit', 'edit').allowed).toBe(false);
  });
});
