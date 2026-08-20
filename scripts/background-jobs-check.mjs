/**
 * The host's background jobs actually run.
 *
 * The schedule screen used to accept a backup schedule, draw the next run time,
 * and never take a backup: every background job was started inside the
 * standalone entry point's listen() callback, which the packaged desktop
 * application — the machine a laboratory actually runs on — never executes.
 *
 *   node scripts/background-jobs-check.mjs
 *
 * Runs against a live host (npm run api). It sets a schedule whose most recent
 * due time is in the past, so the very next tick has work to do.
 */
const BASE = process.env.API || 'http://127.0.0.1:4420/api';
const PW = 'Passw0rd!test';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};
const j = async (p, o = {}) => {
  const r = await fetch(`${BASE}${p}`, { method: o.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(o.token ? { Authorization: `Bearer ${o.token}` } : {}) },
    body: o.body !== undefined ? JSON.stringify(o.body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
};

if (!(await j('/setup/status')).json?.setupComplete)
  await j('/setup/initialize', { method: 'POST', body: { facilityName: 'Jobs Lab', username: 'admin', password: PW, fullName: 'Admin User' } });
const A = (await j('/auth/login', { method: 'POST', body: { username: 'admin', password: PW } })).json.token;

console.log('\n[1] Every background job is wired into both entry points');
{
  const fs = await import('node:fs');
  const standalone = fs.readFileSync(new URL('../server/index.ts', import.meta.url), 'utf8');
  const electron = fs.readFileSync(new URL('../electron/apiServer.ts', import.meta.url), 'utf8');
  check('the standalone host starts them', standalone.includes('startBackgroundServices'));
  check('the packaged desktop host starts them too', electron.includes('startBackgroundServices'),
    'this is the one that was missing, so a laboratory never got an automatic backup');
  const jobs = fs.readFileSync(new URL('../server/services/backgroundJobs.ts', import.meta.url), 'utf8');
  for (const [label, needle] of [
    ['backups', 'BackupScheduler'], ['alert scan', 'runAlertScanAndRoute'],
    ['duty rollover', 'runScheduleTick'], ['activities', 'runActivityTick'],
    ['environmental polling', 'EnvironmentalPoller'], ['sync', 'getSyncEngine'],
  ]) check(`${label} is among them`, jobs.includes(needle));
}

console.log('\n[2] A due schedule produces a backup on the next tick');
const before = (await j('/backup/status', { token: A })).json;
check('the host reports its protection status', !!before, JSON.stringify(before));
const countBefore = before?.backupCount ?? 0;

// Every hour on the hour, so "the most recent due time" is always in the past.
const saved = await j('/backup/schedule', { token: A, method: 'PUT', body: {
  enabled: true, frequency: 'twice_daily', times: ['00:00', '12:00'], daysOfWeek: [],
  keepDailyDays: 7, keepWeeklyWeeks: 4, keepMonthlyMonths: 12,
} });
check('the schedule saves', saved.status === 200, JSON.stringify(saved.json));
const after = (await j('/backup/status', { token: A })).json;
check('and the host says when it runs next', !!after?.schedule?.enabled && !!after?.nextRun, JSON.stringify(after?.nextRun));

console.log('   waiting up to 90s for the scheduler tick…');
let took = null;
for (let i = 0; i < 18; i++) {
  await new Promise(r => setTimeout(r, 5000));
  const now = (await j('/backup/status', { token: A })).json;
  if ((now?.backupCount ?? 0) > countBefore) { took = now; break; }
}
check('the scheduler took a backup on its own', !!took,
  'no new backup appeared — the timer is not running');
if (took) {
  check('it is a real archive', (took.lastBackup?.sizeBytes ?? 0) > 0, JSON.stringify(took.lastBackup));
  check('and the host knows it wrote it', took.lastBackup?.source === 'system', JSON.stringify(took.lastBackup?.source));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
