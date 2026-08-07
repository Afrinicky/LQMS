/**
 * Does the scheduler actually fire?
 *
 * Everything else about backups can be checked through the API, but the thing
 * that matters most cannot: whether the host takes a backup at 02:00 without
 * anybody there. So this one runs the scheduler in-process against a throwaway
 * database and puts the clock where it needs to be.
 *
 * What it is really protecting against is a schedule that looks configured on
 * screen and silently never fires, and its opposite — a scheduler that fires
 * again every minute and fills the disk by morning.
 *
 *   npx tsx scripts/backup-scheduler-check.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sech-backup-sched-'));
process.env.SECH_LIMS_DATA_DIR = dataDir;

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

const { ensureDataDirs, getDb } = await import('../server/db/database.ts');
const { seedDefaults } = await import('../server/db/seed.ts');
ensureDataDirs();
seedDefaults();
const bk = await import('../server/services/backupService.ts');

const hhmmOf = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const schedule = (patch) => bk.saveSchedule({
  enabled: true, frequency: 'custom', times: ['02:00'], daysOfWeek: [],
  retention: { daily: 7, weekly: 4, monthly: 12 }, ...patch,
});

/* ------------------------------------------------------------- 1. it fires */
console.log('\n[1] A due backup is taken without anybody pressing anything');

check('the laboratory starts with no backups', bk.listLocal().length === 0);

// A time five minutes in the past: the very next tick should notice.
schedule({ times: [hhmmOf(new Date(Date.now() - 5 * 60_000))] });
const scheduler = new bk.BackupScheduler();
const first = await scheduler.tick();
check('the scheduler takes the backup that was due', !!first?.backup, JSON.stringify(first)?.slice(0, 100));
check('and it is a real file', (first?.backup?.sizeBytes ?? 0) > 0, `${first?.backup?.sizeBytes} bytes`);
check('the register now has one', bk.listLocal().length === 1);
check('nothing was sent off site, because no destination is configured', first?.copies?.length === 0,
  JSON.stringify(first?.copies));

/* --------------------------------------------------- 2. it does not repeat */
console.log('\n[2] And then it stops, rather than running every minute');

const second = await scheduler.tick();
check('a second tick does nothing', second === null);
const third = await scheduler.tick();
check('nor a third', third === null);
check('still exactly one backup', bk.listLocal().length === 1, `${bk.listLocal().length}`);

/* ------------------------------------------------------- 3. off means off */
console.log('\n[3] A schedule that is off never fires');

bk.saveSchedule({ ...bk.getSchedule(), enabled: false, times: [hhmmOf(new Date(Date.now() - 60_000))] });
const whileOff = await new bk.BackupScheduler().tick();
check('a disabled schedule takes nothing', whileOff === null);
check('and leaves the count alone', bk.listLocal().length === 1);

/* ------------------------------------------------- 4. a missed one catches up */
console.log('\n[4] A host switched off overnight catches up when it returns');

// The real shape of a power cut: the host last backed up two days ago, and a
// scheduled time has passed since. Coming back must produce the missed backup
// rather than wait for tomorrow.
schedule({ times: [hhmmOf(new Date(Date.now() - 2 * 3600_000))] });
getDb().prepare("INSERT INTO settings (key, value) VALUES ('backup.lastScheduledRun', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
  .run(String(Date.now() - 2 * 86400_000));
const caughtUp = await new bk.BackupScheduler().tick();
check('the missed backup is taken on return', !!caughtUp?.backup, JSON.stringify(caughtUp?.backup)?.slice(0, 80));
check('the register has two now', bk.listLocal().length === 2, `${bk.listLocal().length}`);

/* --------------------------------------------------- 5. retention in the cycle */
console.log('\n[5] The cycle prunes, but never below one copy');

// A policy that keeps nothing must still leave the newest backup standing.
bk.saveSchedule({ ...bk.getSchedule(), retention: { daily: 0, weekly: 0, monthly: 0 } });
const removed = bk.pruneLocal(bk.getSchedule());
const left = bk.listLocal();
check('an aggressive policy prunes something', removed.length >= 1, `removed ${removed.length}`);
check('but the laboratory is never left with none', left.length >= 1, `${left.length} left`);

// A backup somebody put in the folder by hand is not the policy's to delete.
fs.writeFileSync(path.join(dataDir, 'backups', 'brought-in-by-hand.zip'), 'not really a zip');
const removed2 = bk.pruneLocal(bk.getSchedule());
check('a backup brought in from elsewhere is left alone',
  !removed2.includes('brought-in-by-hand.zip') && fs.existsSync(path.join(dataDir, 'backups', 'brought-in-by-hand.zip')));

// Nor is a pre-restore safety snapshot, which exists precisely to be there
// when something has gone wrong.
fs.writeFileSync(path.join(dataDir, 'backups', 'pre-restore-2020-01-01T00-00-00-000Z.zip'), 'safety');
const removed3 = bk.pruneLocal(bk.getSchedule());
check('a pre-restore safety snapshot is never pruned',
  !removed3.some(f => f.startsWith('pre-restore-')) && fs.existsSync(path.join(dataDir, 'backups', 'pre-restore-2020-01-01T00-00-00-000Z.zip')));

/* ------------------------------------------------------ 6. copies are opt-in */
console.log('\n[6] Nothing leaves the building unless it was asked to');

schedule({ times: [hhmmOf(new Date(Date.now() - 3 * 60_000))] });
const noDestinations = await new bk.BackupScheduler().tick();
check('a cycle with nowhere to copy to still takes the local backup', !!noDestinations?.backup);
check('and sends nothing anywhere', noDestinations?.copies.length === 0, JSON.stringify(noDestinations?.copies));
check('nor prunes anything remote', Object.keys(noDestinations?.prunedRemote ?? {}).length === 0);

const status = bk.protectionStatus();
check('the status says no destination is configured', status.copies.configured === 0, JSON.stringify(status.copies));
check('and that nothing is off site', status.copies.offSite === 0 && status.copies.offSiteHealthy === 0);
check('while still naming the folder backups are written to', !!status.folder.path, JSON.stringify(status.folder));

getDb().close();
fs.rmSync(dataDir, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
