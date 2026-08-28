/**
 * THE DASHBOARD HAS TO OPEN.
 *
 * Every screen in the system opens on a summary, and a summary is a dozen
 * COUNT(*)s over the tables that grow fastest — `notifications` above all, one
 * row per person per controlled document, per due activity, per alert. On top
 * of that every request asks the permission resolver what its caller may see.
 *
 * Both of those used to be paid in full, every time: the resolver rebuilt its
 * whole grant map for each question, and the counts scanned an unindexed table
 * that got longer every day the laboratory ran. This measures both against a
 * database with a realistic amount of work in it, and fails if the dashboard
 * stops being quick.
 *
 *   node scripts/dashboard-perf-check.mjs [rows]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const dataDir = path.join(root, '.tmp-dashboard-perf');
const ROWS = Number(process.argv[2] || 50000);
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });

const probe = path.join(dataDir, 'probe.mts');
fs.writeFileSync(probe, `
process.env.SECH_LIMS_DATA_DIR = ${JSON.stringify(dataDir)};
const { getDb, ensureDataDirs } = await import(${JSON.stringify(path.join(root, 'server/db/database.ts'))});
const { seedDefaults, setupInitialSystem } = await import(${JSON.stringify(path.join(root, 'server/db/seed.ts'))});
const { resolvePermission, getEffectivePermissions } = await import(${JSON.stringify(path.join(root, 'server/services/permissionResolver.ts'))});
const { computeSummary } = await import(${JSON.stringify(path.join(root, 'server/routes/notifications.ts'))});

ensureDataDirs(); getDb(); seedDefaults();
setupInitialSystem({ facilityName: 'Perf Lab', username: 'admin', password: 'Passw0rd!perf', fullName: 'Perf Admin' });
const db = getDb();

// A laboratory that has been running: a notification per person per document,
// per activity, per alert.
const ins = db.prepare(\`INSERT INTO notifications
  (module_key, notification_type, title, message, severity, status, due_date, assigned_to_staff_id, created_at)
  VALUES (?,?,?,?,?,?,?,?,datetime('now'))\`);
const mods = ['documents','personnel','equipment','iqc','nc_capa','monitoring','supplier_inventory'];
const types = ['attestation_required','approval_required','follow_up','reminder'];
const states = ['unread','read','acknowledged','resolved'];
db.transaction(() => {
  for (let i = 0; i < ${ROWS}; i++) {
    ins.run(mods[i % mods.length], types[i % types.length], 'Perf ' + i, 'perf',
      i % 9 === 0 ? 'urgent' : 'normal', states[i % states.length],
      i % 3 === 0 ? '2026-0' + ((i % 9) + 1) + '-15' : null, null);
  }
})();

const admin = db.prepare("SELECT id, staff_id FROM users WHERE username = 'admin'").get();
const req = { user: { id: admin.id, staffId: admin.staff_id } };

// Warm the statement cache so we measure the work, not the first-call cost.
resolvePermission(admin.id, 'personnel', 'view'); computeSummary(req);

const time = (n, fn) => { const t = process.hrtime.bigint(); for (let i = 0; i < n; i++) fn(); return Number(process.hrtime.bigint() - t) / 1e6 / n; };

const perQuestion = time(2000, () => resolvePermission(admin.id, 'personnel', 'view'));
const perMap = time(100, () => getEffectivePermissions(admin.id));
const perSummary = time(50, () => computeSummary(req));

// What one dashboard load actually costs: seven module summaries, the
// notification summary, and the permission question each of them asks.
const perLoad = time(20, () => { for (let i = 0; i < 8; i++) resolvePermission(admin.id, 'personnel', 'view'); computeSummary(req); });

console.log(JSON.stringify({ rows: ${ROWS}, perQuestion, perMap, perSummary, perLoad,
  indexes: db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='index' AND tbl_name='notifications'").get().c }));
`);

const run = spawnSync('npx', ['tsx', probe], { cwd: root, encoding: 'utf8' });
const line = (run.stdout || '').trim().split('\n').filter(l => l.startsWith('{')).pop();
if (!line) { console.error(run.stdout); console.error(run.stderr); process.exit(1); }
const m = JSON.parse(line);

console.log(`\nDASHBOARD PERFORMANCE — ${m.rows.toLocaleString()} notifications, ${m.indexes} indexes on the table\n`);
let failed = 0;
const budget = (name, value, limit, unit = 'ms') => {
  const ok = value <= limit;
  if (!ok) failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name} — ${value.toFixed(3)}${unit} (budget ${limit}${unit})`);
};
budget('one permission question', m.perQuestion, 0.5);
budget('the whole permission map a screen is handed', m.perMap, 3);
budget('the notification summary every dashboard opens on', m.perSummary, 25);
budget('one dashboard load, end to end', m.perLoad, 30);

console.log(`\n${4 - failed} passed, ${failed} failed`);
fs.rmSync(dataDir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
