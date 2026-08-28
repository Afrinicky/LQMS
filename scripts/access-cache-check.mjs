/**
 * THE CACHE IS NOT ALLOWED TO BE WRONG.
 *
 * The resolver keeps the grant map it builds and drops it when the database
 * layer's access epoch moves. That makes the dashboards fast; it would also be
 * the perfect way to serve a permission somebody no longer has. So this proves
 * the two things that matter, against a real database:
 *
 *   · a right granted is visible on the very next question;
 *   · a right withdrawn is gone on the very next question;
 *
 * and it proves them through every door the resolver answers — the single
 * decision, the client's permission map, and the viewable-module list.
 *
 *   node scripts/access-cache-check.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const dataDir = path.join(root, '.tmp-access-cache-check');
fs.rmSync(dataDir, { recursive: true, force: true });

const probe = path.join(dataDir, 'probe.mts');
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(probe, `
process.env.SECH_LIMS_DATA_DIR = ${JSON.stringify(dataDir)};
const { getDb, ensureDataDirs, accessEpoch } = await import(${JSON.stringify(path.join(root, 'server/db/database.ts'))});
const { seedDefaults, setupInitialSystem } = await import(${JSON.stringify(path.join(root, 'server/db/seed.ts'))});
const { resolvePermission, getEffectivePermissions, getViewableModules } =
  await import(${JSON.stringify(path.join(root, 'server/services/permissionResolver.ts'))});

ensureDataDirs(); getDb(); seedDefaults();
setupInitialSystem({ facilityName: 'Cache Check', username: 'admin', password: 'Passw0rd!cache', fullName: 'Cache Admin' });
const db = getDb();

const results = [];
const ok = (name, pass, detail = '') => results.push({ name, pass, detail });

// A profile that is not the administrator, and a user who holds it.
const profile = db.prepare("SELECT id FROM roles WHERE name = 'Biomedical Scientist'").get();
db.prepare(\`INSERT INTO users (username, password_hash, full_name, role_id, is_active)
            VALUES ('cache_probe', 'x', 'Cache Probe', ?, 1)\`).run(profile.id);
const user = db.prepare("SELECT id FROM users WHERE username = 'cache_probe'").get();

const perm = (key, action) =>
  db.prepare('SELECT id FROM permissions WHERE module_key = ? AND action = ?').get(key, action);

// ── 1. A right withdrawn is gone at once ────────────────────────────────────
const iqcCreate = perm('iqc', 'create');
ok('the profile starts able to record an IQC run',
  resolvePermission(user.id, 'iqc', 'create').allowed);

const before = accessEpoch();
db.prepare('INSERT OR REPLACE INTO user_permission_overrides (user_id, permission_id, allowed, reason) VALUES (?, ?, 0, ?)')
  .run(user.id, iqcCreate.id, 'cache check');
ok('writing an override moves the access epoch', accessEpoch() !== before);
ok('the withdrawal is visible on the next question',
  resolvePermission(user.id, 'iqc', 'create').allowed === false);
ok('and in the permission map the client is handed',
  !(getEffectivePermissions(user.id).iqc ?? []).includes('create'));

// ── 2. A right granted is there at once ─────────────────────────────────────
const rosterEdit = perm('personnel.rosters', 'edit');
ok('the profile starts unable to edit a duty roster',
  resolvePermission(user.id, 'personnel.rosters', 'edit').allowed === false);
db.prepare('INSERT OR REPLACE INTO user_permission_overrides (user_id, permission_id, allowed, reason) VALUES (?, ?, 1, ?)')
  .run(user.id, rosterEdit.id, 'cache check');
ok('the grant is visible on the next question',
  resolvePermission(user.id, 'personnel.rosters', 'edit').allowed);
ok('and it reaches the module through the union',
  resolvePermission(user.id, 'personnel', 'edit').allowed);

// ── 3. Switching a module off empties it at once ────────────────────────────
ok('the module is viewable to begin with', getViewableModules(user.id).has('iqc'));
db.prepare("UPDATE system_modules SET enabled = 0 WHERE key = 'iqc'").run();
ok('a disabled module leaves the viewable list at once',
  !getViewableModules(user.id).has('iqc'));
ok('and its every action is refused', resolvePermission(user.id, 'iqc', 'view').allowed === false);
db.prepare("UPDATE system_modules SET enabled = 1 WHERE key = 'iqc'").run();
ok('re-enabling it brings it back at once', getViewableModules(user.id).has('iqc'));

// ── 4. Changing the profile a user holds is seen at once ────────────────────
const technician = db.prepare("SELECT id FROM roles WHERE name = 'Technician'").get();
const wasFull = resolvePermission(user.id, 'iqc', 'edit').allowed;
db.prepare('UPDATE users SET role_id = ? WHERE id = ?').run(technician.id, user.id);
ok('moving the user to another profile changes the answer at once',
  resolvePermission(user.id, 'iqc', 'edit').allowed !== wasFull,
  \`was \${wasFull}, still \${resolvePermission(user.id, 'iqc', 'edit').allowed}\`);

// ── 5. Deactivating the account stops everything at once ────────────────────
db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(user.id);
ok('an account switched off can do nothing, at once',
  resolvePermission(user.id, 'documents.library', 'view').allowed === false);

// ── 6. The cache is actually doing its job ──────────────────────────────────
const t0 = Date.now();
for (let i = 0; i < 500; i++) resolvePermission(1, 'personnel', 'view');
const each = (Date.now() - t0) / 500;
ok('a repeated question is answered from the cache', each < 1, \`\${each.toFixed(3)}ms each\`);

console.log(JSON.stringify(results));
`);

const run = spawnSync('npx', ['tsx', probe], { cwd: root, encoding: 'utf8' });
const line = (run.stdout || '').trim().split('\n').filter(l => l.startsWith('[{')).pop();
if (!line) {
  console.error(run.stdout);
  console.error(run.stderr);
  console.error('\nThe cache check could not run.');
  process.exit(1);
}
const results = JSON.parse(line);
console.log('\nACCESS CACHE CHECK — a cached decision is never a stale one\n');
let failed = 0;
for (const r of results) {
  console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  if (!r.pass) failed++;
}
console.log(`\n${results.length - failed} passed, ${failed} failed`);
fs.rmSync(dataDir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
