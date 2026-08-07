/**
 * Where backups are written, and where copies go.
 *
 * The two claims this has to stand behind are the ones a laboratory bets its
 * records on: a backup lands in the folder that was chosen, immediately, without
 * anybody downloading anything; and a copy reaches every destination that was
 * set up, with one that is unreachable never costing the others.
 *
 * Folder and network destinations are exercised for real against temporary
 * directories — which is the honest test, since a network share is a path as far
 * as this host is concerned. S3, WebDAV and Drive are tested for their refusals
 * and their secrecy, because a made-up endpoint is all that can be reached from
 * a test machine.
 *
 *   npx tsx scripts/backup-destinations-check.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sech-dest-'));
const dataDir = path.join(scratch, 'data');
fs.mkdirSync(dataDir, { recursive: true });
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
const dest = await import('../server/services/backupDestinations.ts');
const { describeDestination } = await import('../shared/constants/backupDestinations.ts');

const zipsIn = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.zip')) : []);

// A path that cannot possibly be a folder, and says so straight away. A regular
// file with something asked for beneath it is the honest stand-in for a bad
// path: the kernel answers ENOTDIR at once, which is what a typo does. A dead
// network mount is the other failure — that one blocks, and is what the
// deadline in folderCheckWithTimeout exists for; it is not reproducible here.
const blocker = path.join(scratch, 'this-is-a-file');
fs.writeFileSync(blocker, 'a regular file, so no folder can exist beneath it');
const impossiblePath = path.join(blocker, 'backups');

/* ------------------------------------------------ 1. the folder is a choice */
console.log('\n[1] Backups go to the folder the laboratory chose');

const initial = dest.configuredFolder();
check('it starts at the default, inside the data directory', initial.isDefault && initial.path.includes(dataDir), initial.path);

const chosen = path.join(scratch, 'chosen-backups');
const moved = await dest.setBackupFolder(chosen);
check('a folder can be chosen', moved.ok === true, JSON.stringify(moved));
check('and it is created if it does not exist', fs.existsSync(chosen));
check('the status reports it, and that it is not the default',
  dest.configuredFolder().path === chosen && dest.configuredFolder().isDefault === false);

const first = await bk.createBackup('manual', null);
check('a backup lands in the chosen folder immediately', zipsIn(chosen).includes(first.fileName), zipsIn(chosen).join(','));
check('and not in the default one', !zipsIn(path.join(dataDir, 'backups')).includes(first.fileName));
check('the register lists it from there', bk.listLocal().some(b => b.fileName === first.fileName));

// A path that cannot be written to is refused before it is stored, rather than
// discovered at 02:00.
const impossible = await dest.setBackupFolder(impossiblePath);
check('an unusable folder is refused', impossible.ok === false, JSON.stringify(impossible));
check('and the working folder is untouched', dest.configuredFolder().path === chosen);
check('a relative path is refused', (await dest.setBackupFolder('backups/here')).ok === false);

// If the chosen folder disappears — an unplugged USB drive — backups keep
// happening somewhere rather than stopping.
const removable = path.join(scratch, 'removable');
await dest.setBackupFolder(removable);
fs.rmSync(removable, { recursive: true, force: true });
check('a folder that vanishes is reported as unavailable', dest.configuredFolder().available === false);
const afterLoss = await bk.createBackup('manual', null);
check('but a backup is still taken', !!afterLoss.fileName, afterLoss.fileName);

await dest.setBackupFolder(chosen);
check('and the folder can be set back', dest.configuredFolder().path === chosen);

/* ------------------------------------- 2. a folder on another machine */
console.log('\n[2] The hospital server is just a folder this host can write to');

const hospital = path.join(scratch, 'hospital-server', 'lims-backups');
const saved = await dest.saveDestination(null, {
  kind: 'network', name: 'Hospital server', config: { path: hospital },
});
check('a network destination saves once it has been proved', saved.ok === true, JSON.stringify(saved));
check('and the folder was created on the way', fs.existsSync(hospital));
check('the list describes where it points', describeDestination({ kind: 'network', config: { path: hospital } }) === hospital);

const unreachable = await dest.saveDestination(null, {
  kind: 'network', name: 'Broken share', config: { path: path.join(blocker, 'share') },
});
check('a share that cannot be written to is refused', unreachable.ok === false);
check('with advice somebody can act on', /reach|exist|Permission|not a folder/i.test(unreachable.error ?? ''), unreachable.error);
check('and nothing was stored', dest.listDestinations().length === 1, `${dest.listDestinations().length}`);

const missingPath = await dest.saveDestination(null, { kind: 'network', name: 'No path', config: {} });
check('a destination with nothing filled in is refused', missingPath.ok === false, missingPath.error);
check('naming the field that is missing', /Folder path/i.test(missingPath.error ?? ''), missingPath.error);

/* --------------------------------------- 3. copies go out with the backup */
console.log('\n[3] A backup is copied out as it is taken, not when somebody remembers');

const second = path.join(scratch, 'second-disk');
await dest.saveDestination(null, { kind: 'folder', name: 'Second disk', config: { path: second } });

// A destination added today has never seen yesterday's backups, and says so.
check('backups taken before a destination existed are counted as waiting',
  dest.listDestinations().every(d => d.pending > 0),
  dest.listDestinations().map(d => `${d.name}:${d.pending}`).join(' '));
const catchUp = await dest.syncPending(null, null);
check('and one sync sends them', catchUp.length > 0 && catchUp.every(c => c.ok),
  JSON.stringify(catchUp.map(c => [c.destinationName, c.ok, c.error])));

const cycle = await bk.runScheduledBackup(null);
check('the cycle takes a backup', !!cycle.backup, JSON.stringify(cycle.error));
check('and copies it to both destinations', cycle.copies.length === 2 && cycle.copies.every(c => c.ok),
  JSON.stringify(cycle.copies.map(c => [c.destinationName, c.ok, c.error])));
check('the file really is on the hospital server', zipsIn(hospital).includes(cycle.backup.fileName), zipsIn(hospital).join(','));
check('and really is on the second disk', zipsIn(second).includes(cycle.backup.fileName));
check('nothing is left waiting', dest.listDestinations().every(d => d.pending === 0),
  dest.listDestinations().map(d => `${d.name}:${d.pending}`).join(' '));

// Sending the same backup again must not send it twice.
const again = await dest.copyToAll(cycle.backup.fileName, null);
check('a backup already there is not sent again', again.every(c => c.ok && c.skipped), JSON.stringify(again.map(c => c.skipped)));

/* ------------------------------- 4. one destination failing costs nothing */
console.log('\n[4] A destination that is down does not take the others with it');

const flaky = path.join(scratch, 'flaky-server', 'drop');
const flakyDest = await dest.saveDestination(null, { kind: 'network', name: 'Flaky server', config: { path: flaky } });
check('a third destination is added', flakyDest.ok === true);

// Make it unwritable the way a share going offline does.
fs.rmSync(path.join(scratch, 'flaky-server'), { recursive: true, force: true });
fs.writeFileSync(path.join(scratch, 'flaky-server'), 'now a file, so the folder beneath cannot exist');

const mixed = await bk.runScheduledBackup(null);
check('the local backup is still written', !!mixed.backup && zipsIn(chosen).includes(mixed.backup.fileName));
check('the healthy destinations still get it',
  mixed.copies.filter(c => c.ok).length === 2, JSON.stringify(mixed.copies.map(c => [c.destinationName, c.ok])));
check('the failing one is reported by name',
  mixed.copies.some(c => !c.ok && c.destinationName === 'Flaky server'), JSON.stringify(mixed.copies.map(c => c.destinationName)));
check('and remembered against that destination',
  dest.listDestinations().find(d => d.name === 'Flaky server')?.lastResult === 'failed');
check('with a message somebody can act on',
  !!dest.listDestinations().find(d => d.name === 'Flaky server')?.lastMessage,
  dest.listDestinations().find(d => d.name === 'Flaky server')?.lastMessage);
check('the others are still marked healthy',
  dest.listDestinations().filter(d => d.name !== 'Flaky server').every(d => d.lastResult === 'success'));

// And it catches up once the share is back.
fs.rmSync(path.join(scratch, 'flaky-server'), { force: true });
const waiting = dest.pendingFor(flakyDest.destination.id);
check('the backups it missed are counted as waiting', waiting.length >= 2, `${waiting.length}`);
const caughtUp = await dest.syncPending(flakyDest.destination.id, null);
check('and they are sent once it is reachable again', caughtUp.every(c => c.ok), JSON.stringify(caughtUp.map(c => c.error)));
check('leaving nothing outstanding', dest.pendingFor(flakyDest.destination.id).length === 0);

/* ------------------------------------------------- 5. pausing and removing */
console.log('\n[5] A destination can be paused without losing what it holds');

dest.setEnabled(flakyDest.destination.id, false);
const whilePaused = await bk.runScheduledBackup(null);
check('a paused destination is skipped', !whilePaused.copies.some(c => c.destinationName === 'Flaky server'),
  JSON.stringify(whilePaused.copies.map(c => c.destinationName)));
check('while the others still receive copies', whilePaused.copies.length === 2 && whilePaused.copies.every(c => c.ok));

const heldFiles = zipsIn(flaky).length;
dest.deleteDestination(flakyDest.destination.id);
check('removing a destination forgets it', !dest.listDestinations().some(d => d.name === 'Flaky server'));
check('but leaves the copies already sent there', zipsIn(flaky).length === heldFiles, `${zipsIn(flaky).length} vs ${heldFiles}`);

/* --------------------------------------------------- 6. retention travels */
console.log('\n[6] Retention applies everywhere, not only here');

bk.saveSchedule({ ...bk.getSchedule(), enabled: true, retention: { daily: 0, weekly: 0, monthly: 0 } });
const before = zipsIn(hospital).length;
const pruningCycle = await bk.runScheduledBackup(null);
check('the cycle runs', !!pruningCycle.backup);
check('older copies are cleared from the destination too', zipsIn(hospital).length < before + 1,
  `${before} → ${zipsIn(hospital).length}`);
check('the newest copy is still there', zipsIn(hospital).includes(pruningCycle.backup.fileName));
check('and it says which destination it pruned', Object.keys(pruningCycle.prunedRemote).length > 0,
  JSON.stringify(pruningCycle.prunedRemote));

bk.saveSchedule({ ...bk.getSchedule(), retention: { daily: 7, weekly: 4, monthly: 12 } });

/* ------------------------------------------------- 7. credentials stay put */
console.log('\n[7] Passwords and keys never come back out');

const cloudy = await dest.saveDestination(null, {
  kind: 's3', name: 'Nowhere', config: {
    endpoint: 'https://s3.invalid.example', bucket: 'nope',
    accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'super-secret-value',
  },
});
check('an S3 endpoint that does not exist is refused', cloudy.ok === false, JSON.stringify(cloudy).slice(0, 120));
check('with a message about reaching it', /find|reach|answer|refused/i.test(cloudy.error ?? ''), cloudy.error);

// Store one directly so the redaction can be checked without a live endpoint.
getDb().prepare(`INSERT INTO backup_destinations (kind, name, enabled, config, secret)
  VALUES ('s3', 'Stored bucket', 0, ?, ?)`)
  .run(JSON.stringify({ endpoint: 'https://s3.example', bucket: 'b', accessKeyId: 'AKIA' }),
       JSON.stringify({ secretAccessKey: 'super-secret-value' }));

const listed = dest.listDestinations();
const stored = listed.find(d => d.name === 'Stored bucket');
check('a stored destination is listed', !!stored);
check('its secret is not in the listing', !JSON.stringify(listed).includes('super-secret-value'),
  'the secret appeared in the list');
check('but the listing says one is on file', stored.hasSecret === true);
check('and the harmless settings are still visible', stored.config.bucket === 'b' && stored.config.accessKeyId === 'AKIA');

// Editing without retyping the password must keep the stored one.
const keptSecret = await dest.saveDestination(stored.id, {
  kind: 's3', name: 'Renamed bucket', config: { endpoint: 'https://s3.invalid.example', bucket: 'b', accessKeyId: 'AKIA', secretAccessKey: '' },
});
check('an edit that leaves the password blank does not wipe it',
  keptSecret.ok === false && !!getDb().prepare("SELECT secret FROM backup_destinations WHERE id = ?").get(stored.id).secret,
  'the stored secret was lost');

/* ---------------------------------------------- 8. the shape of the status */
console.log('\n[8] The screen can tell whether the laboratory is really covered');

const status = bk.protectionStatus();
check('the status names the folder in use', status.folder.path === chosen, status.folder.path);
check('it lists the destinations', status.destinations.length >= 2, `${status.destinations.length}`);
check('and counts the off-site ones separately from the local disk',
  status.copies.offSite >= 1 && status.copies.offSite < status.copies.configured + 1,
  JSON.stringify(status.copies));
check('a second folder on this machine does not count as off site',
  status.destinations.find(d => d.name === 'Second disk') && status.copies.offSite < status.destinations.filter(d => d.enabled).length,
  JSON.stringify(status.copies));

getDb().close();
fs.rmSync(scratch, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
