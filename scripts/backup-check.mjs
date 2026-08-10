/**
 * Backups: on a schedule, kept sensibly, and copied off site.
 *
 * The things that matter here are the ones nobody notices until the day they
 * need them. A schedule that silently never fires. A retention policy that
 * deletes the last copy. A stored credential that goes back to a browser. A
 * failed upload that reports success. So this checks the boring guarantees.
 *
 * This is the HTTP side: the schedule, the folder, and the destination
 * endpoints as a browser meets them. Copying to real folders and shares is
 * exercised in scripts/backup-destinations-check.mjs.
 *
 * No cloud provider is reachable from a test host and none needs to be: the
 * credential handling, the refusals and the logging are all local, and a
 * connection attempt with a made-up key must fail cleanly rather than hang or
 * store something half-configured.
 *
 *   npx tsx scripts/backup-check.mjs
 */
import { nextRunAfter, backupsToKeep, normaliseSchedule, describeSchedule, mostRecentDue } from '../shared/constants/backup.ts';

const BASE = process.env.API || 'http://127.0.0.1:4433/api';
const PW = 'thistle harbour crane';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};
const j = async (p, o = {}) => {
  const r = await fetch(`${BASE}${p}`, {
    method: o.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(o.token ? { Authorization: `Bearer ${o.token}` } : {}) },
    body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => null) };
};

const st = await j('/setup/status');
if (!st.json?.setupComplete) {
  await j('/setup/initialize', { method: 'POST', body: { facilityName: 'Backup Lab', username: 'admin', password: PW, fullName: 'Admin User' } });
}
const A = (await j('/auth/login', { method: 'POST', body: { username: 'admin', password: PW } })).json.token;
const stamp = Date.now().toString().slice(-6);

/* ------------------------------------------------- 1. the schedule model */
console.log('\n[1] A schedule that cannot be misconfigured into silence');

check('an empty schedule normalises to a usable default',
  normaliseSchedule({}).times.length === 1 && normaliseSchedule({}).frequency === 'daily',
  JSON.stringify(normaliseSchedule({})));
check('nonsense times are dropped rather than stored',
  normaliseSchedule({ times: ['25:00', 'later', '02:00'] }).times.join(',') === '02:00',
  normaliseSchedule({ times: ['25:00', 'later', '02:00'] }).times.join(','));
check('a schedule with no valid time at all falls back to one',
  normaliseSchedule({ times: ['99:99'] }).times.length === 1);
check('twice-daily always ends up with two times',
  normaliseSchedule({ frequency: 'twice_daily', times: ['03:00'] }).times.length === 2);
check('weekly always ends up with a day',
  normaliseSchedule({ frequency: 'weekly', daysOfWeek: [] }).daysOfWeek.length === 1);
check('retention is clamped to something sane',
  normaliseSchedule({ retention: { daily: -5, weekly: 9999, monthly: 3 } }).retention.daily === 7 &&
  normaliseSchedule({ retention: { daily: -5, weekly: 9999, monthly: 3 } }).retention.weekly === 52,
  JSON.stringify(normaliseSchedule({ retention: { daily: -5, weekly: 9999, monthly: 3 } }).retention));
check('a schedule that is off says so plainly',
  describeSchedule(normaliseSchedule({ enabled: false })) === 'Automatic backups are off.');

/* --------------------------------------------------- 2. when it next runs */
console.log('\n[2] The next run lands where a person would expect');

const daily = normaliseSchedule({ enabled: true, frequency: 'daily', times: ['02:00'] });
const atNoon = new Date(2026, 4, 12, 12, 0, 0);            // Tuesday midday
const next = nextRunAfter(daily, atNoon);
check('midday on a daily schedule points at 02:00 tomorrow',
  next.getDate() === 13 && next.getHours() === 2, next?.toString());

const beforeDawn = new Date(2026, 4, 12, 1, 0, 0);
check('01:00 points at 02:00 the same morning',
  nextRunAfter(daily, beforeDawn).getDate() === 12, nextRunAfter(daily, beforeDawn)?.toString());

const twice = normaliseSchedule({ enabled: true, frequency: 'twice_daily', times: ['02:00', '14:00'] });
check('twice-daily at 09:00 points at this afternoon',
  nextRunAfter(twice, new Date(2026, 4, 12, 9, 0)).getHours() === 14);
check('twice-daily at 15:00 points at tomorrow morning',
  nextRunAfter(twice, new Date(2026, 4, 12, 15, 0)).getHours() === 2 &&
  nextRunAfter(twice, new Date(2026, 4, 12, 15, 0)).getDate() === 13);

const weekly = normaliseSchedule({ enabled: true, frequency: 'weekly', times: ['02:00'], daysOfWeek: [0] });
const sundayNext = nextRunAfter(weekly, atNoon);
check('a Sunday schedule from a Tuesday points at Sunday', sundayNext.getDay() === 0, sundayNext?.toString());
check('a schedule that is off has no next run', nextRunAfter(normaliseSchedule({ enabled: false }), atNoon) === null);

// A host switched off overnight must take the missed backup when it returns,
// not skip the day.
const back = mostRecentDue(daily, new Date(2026, 4, 12, 9, 30));
check('a host that missed 02:00 still sees it as due at 09:30',
  back && back.getHours() === 2 && back.getDate() === 12, back?.toString());

/* --------------------------------------------------------- 3. retention */
console.log('\n[3] Retention keeps a useful spread, and never the last copy');

const now = new Date(2026, 4, 12, 12, 0, 0);
const daysAgo = n => ({ createdAt: new Date(now.getTime() - n * 86400000).toISOString(), tag: `d${n}` });
const year = [0, 1, 2, 3, 4, 5, 6, 7, 10, 14, 21, 28, 40, 70, 100, 200, 300, 400].map(daysAgo);
const kept = backupsToKeep(year, { daily: 7, weekly: 4, monthly: 12 }, now);

check('everything inside the daily window survives',
  year.filter(e => Number(e.tag.slice(1)) <= 7).every(e => kept.has(e)));
check('the year of archives is thinned, not kept whole', kept.size < year.length, `${kept.size} of ${year.length}`);
check('but something from months back is still there',
  [...kept].some(e => Number(e.tag.slice(1)) >= 70), [...kept].map(e => e.tag).join(','));
check('nothing older than the monthly window is kept',
  ![...kept].some(e => Number(e.tag.slice(1)) === 400), [...kept].map(e => e.tag).join(','));

const single = [daysAgo(900)];
check('the only backup there is is never pruned, however old',
  backupsToKeep(single, { daily: 1, weekly: 0, monthly: 0 }, now).size === 1);
check('a zero retention policy still keeps the newest',
  backupsToKeep(year, { daily: 0, weekly: 0, monthly: 0 }, now).size >= 1);

/* --------------------------------------------- 4. the endpoints themselves */
console.log('\n[4] Saving and reading a schedule');

const initial = await j('/backup/schedule', { token: A });
check('a schedule can be read before one is ever saved', initial.status === 200 && !!initial.json?.schedule);
// Automatic backups are opt-in: a laboratory that has never configured one is
// off, not quietly writing archives it did not ask for. Only meaningful on a
// database that has not been configured yet, so it is skipped on a re-run.
const everConfigured = (await j('/records-reports/audit-trail?entity=backup_schedule&limit=1', { token: A })).json?.length > 0;
if (everConfigured) console.log('  SKIP  it starts switched off (this database has been configured before)');
else check('it starts switched off', initial.json.schedule.enabled === false);

const saved = await j('/backup/schedule', { token: A, method: 'PUT', body: {
  enabled: true, frequency: 'daily', times: ['02:00'], retention: { daily: 7, weekly: 4, monthly: 12 },
} });
check('a schedule saves', saved.status === 200, JSON.stringify(saved.json));
check('and comes back described in words', /Every night at 02:00/.test(saved.json?.description ?? ''), saved.json?.description);
check('with the next run computed', !!saved.json?.nextRun, saved.json?.nextRun);

const junk = await j('/backup/schedule', { token: A, method: 'PUT', body: { enabled: true, frequency: 'hourly', times: ['nope'] } });
check('nonsense is normalised rather than refused', junk.status === 200 && junk.json.schedule.frequency === 'daily',
  JSON.stringify(junk.json?.schedule));
check('and the stored times are valid', junk.json.schedule.times.every(t => /^\d\d:\d\d$/.test(t)));

await j('/backup/schedule', { token: A, method: 'PUT', body: {
  enabled: true, frequency: 'daily', times: ['02:00'], retention: { daily: 7, weekly: 4, monthly: 12 },
} });

/* ------------------------------------------------- 5. taking one for real */
console.log('\n[5] A backup that actually contains the laboratory');

const status0 = (await j('/backup/status', { token: A })).json;
check('the status endpoint answers', !!status0?.schedule, JSON.stringify(status0)?.slice(0, 80));
check('it knows automatic backups are on now', status0.schedule.enabled === true);
check('and when the next one is due', !!status0.nextRun);

const run = await j('/backup/run-now', { token: A, method: 'POST', body: {} });
check('a backup runs on demand', run.status === 201, JSON.stringify(run.json)?.slice(0, 120));
check('and produces a real file', (run.json?.backup?.sizeBytes ?? 0) > 0, `${run.json?.backup?.sizeBytes} bytes`);
check('named so it sorts by date', /^sech-lims-backup-\d{4}-\d{2}-\d{2}/.test(run.json?.backup?.fileName ?? ''), run.json?.backup?.fileName);
check('nothing was copied off site, because no destination is configured',
  Array.isArray(run.json?.copies) && run.json.copies.length === 0, JSON.stringify(run.json?.copies));

const list = (await j('/backup/list', { token: A })).json;
check('it appears in the register', list.backups.some(b => b.fileName === run.json.backup.fileName));
check('the register says whether each copy is off site',
  list.backups.every(b => 'syncedAt' in b), Object.keys(list.backups[0] ?? {}).join(','));

const status1 = (await j('/backup/status', { token: A })).json;
check('the status now reports a recent backup', !!status1.lastBackup, JSON.stringify(status1.lastBackup)?.slice(0, 60));
check('and counts what is on the shelf', status1.backupCount >= 1 && status1.totalBytes > 0);

/* --------------------------------------------------------- 6. pruning */
console.log('\n[6] Pruning removes only what it should');

const before = (await j('/backup/list', { token: A })).json.backups.length;
const pruned = await j('/backup/prune', { token: A, method: 'POST', body: {} });
check('pruning runs', pruned.status === 200, JSON.stringify(pruned.json));
const after = (await j('/backup/list', { token: A })).json.backups;
check('a fresh backup is never pruned', after.some(b => b.fileName === run.json.backup.fileName));
check('and nothing was lost from a young collection', after.length === before, `${before} → ${after.length}`);

/* ------------------------------------------------------ 7. destinations */
console.log('\n[7] A destination is proved before it is believed');

const kinds = await j('/backup/destination-kinds', { token: A });
check('the screen can be told what may be added', kinds.status === 200 && kinds.json.length >= 4, `${kinds.json?.length}`);
check('and each kind says what it needs', kinds.json.every(k => Array.isArray(k.fields) && k.label && k.tagline));
check('at least one kind is off site', kinds.json.some(k => k.offSite === true));

const noneYet = (await j('/backup/destinations', { token: A })).json;
check('none are configured to begin with', Array.isArray(noneYet) && noneYet.length === 0, JSON.stringify(noneYet));

const nonsenseKind = await j('/backup/destinations', { token: A, method: 'POST', body: { kind: 'carrier-pigeon', config: {} } });
check('an unknown kind is refused', nonsenseKind.status === 400, `got ${nonsenseKind.status}`);

const emptyFolder = await j('/backup/destinations', { token: A, method: 'POST', body: { kind: 'network', name: 'Ward server', config: {} } });
check('a destination with nothing filled in is refused', emptyFolder.status === 400);
check('naming the field that is missing', /Folder path/i.test(emptyFolder.json?.error ?? ''), emptyFolder.json?.error);

const relative = await j('/backup/destinations', { token: A, method: 'POST', body: { kind: 'network', name: 'Ward server', config: { path: 'share/backups' } } });
check('a path that is not a full path is refused', relative.status === 400);
check('saying what a full path looks like', /full path/i.test(relative.json?.error ?? ''), relative.json?.error);

/* --------------------------------------------------- 7b. the Drive credential */
console.log('\n[7b] The Google Drive credential is handled like a credential');

const drive = (body, method = 'POST', path = '/backup/destinations') =>
  j(path, { token: A, method, body: { kind: 'google_drive', name: 'Drive', ...body } });

const notJson = await drive({ config: { serviceAccountKey: 'hello' } });
check('a key that is not JSON is refused', notJson.status === 400, `got ${notJson.status}`);
check('with an explanation of what to paste', /JSON/i.test(notJson.json?.error ?? ''), notJson.json?.error);

const oauthKey = await drive({ config: { serviceAccountKey: JSON.stringify({ type: 'authorized_user', client_id: 'x', client_secret: 'y' }) } });
check('an OAuth client key is refused with the right advice',
  oauthKey.status === 400 && /service.account/i.test(oauthKey.json?.error ?? ''), oauthKey.json?.error);

const noKeyMaterial = await drive({ config: { serviceAccountKey: JSON.stringify({
  type: 'service_account', project_id: 'p', client_email: 'a@b.iam.gserviceaccount.com', private_key: 'not a key',
}) } });
check('a key with no key material in it is refused', noKeyMaterial.status === 400, noKeyMaterial.json?.error);

// A syntactically real key that Google has never issued. This exercises the
// whole path — JWT built, signed with the private key, sent to Google's token
// endpoint — and must come back as a clean refusal, fast, storing nothing. On a
// host with no internet it fails differently and that is equally correct, so
// both answers are accepted.
const { generateKeyPairSync } = await import('node:crypto');
const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const startedAt = Date.now();
const fakeAccount = await drive({ config: {
  serviceAccountKey: JSON.stringify({
    type: 'service_account', project_id: 'sech-lims-test',
    client_email: 'backups@sech-lims-test.iam.gserviceaccount.com', private_key: privateKey,
  }),
  folderId: '1AbC2dEfGhIjKlMnOpQrStUvWxYz',
} });
const elapsed = Date.now() - startedAt;
check('a well-formed key for an account Google does not know is refused', fakeAccount.status === 400, `got ${fakeAccount.status}`);
check('and the refusal says what Google said, or that it is unreachable',
  /account not found|invalid_grant|invalid grant|reach Google/i.test(fakeAccount.json?.error ?? ''), fakeAccount.json?.error);
check('it fails quickly rather than hanging', elapsed < 20000, `${elapsed}ms`);

const afterFake = (await j('/backup/destinations', { token: A })).json;
check('none of those attempts left a half-connected destination behind',
  afterFake.length === 0, JSON.stringify(afterFake));

const syncWithNone = await j('/backup/destinations/sync', { token: A, method: 'POST', body: {} });
check('a sync with nowhere to send says so plainly',
  syncWithNone.status === 200 && /already reached|no destination/i.test(syncWithNone.json?.message ?? ''),
  JSON.stringify(syncWithNone.json));

const history = await j('/backup/sync-history', { token: A });
check('the sync history is readable even when empty', history.status === 200 && Array.isArray(history.json));

/* ------------------------------------------------------ 7c. the folder */
console.log('\n[7c] Where backups are written is the laboratory\'s choice');

const folder = (await j('/backup/folder', { token: A })).json;
check('it starts at the default', folder.isDefault === true && !!folder.path, JSON.stringify(folder));

const badFolder = await j('/backup/folder', { token: A, method: 'PUT', body: { path: 'somewhere/relative' } });
check('a relative folder is refused', badFolder.status === 400, `got ${badFolder.status}`);
check('with advice about what to give', /full path/i.test(badFolder.json?.error ?? ''), badFolder.json?.error);
check('and the folder is unchanged', (await j('/backup/folder', { token: A })).json.isDefault === true);

/* ------------------------------------------------------ 8. who may do what */
console.log('\n[8] Backups are the whole database, so the rights match');

const roles = (await j('/roles', { token: A })).json;
const techRole = roles.find(r => /technician/i.test(r.name));
const tech = `bk_tech_${stamp}`;
await j('/users', { token: A, method: 'POST', body: { username: tech, password: PW, fullName: 'Kwesi Owusu', roleId: techRole.id } });
const T = (await j('/auth/login', { method: 'POST', body: { username: tech, password: PW } })).json?.token;

const perm = async (p, token, method = 'GET', body) => (await j(p, { token, method, body })).status;
check('a technician cannot read the backup status', await perm('/backup/status', T) === 403);
check('a technician cannot change the schedule', await perm('/backup/schedule', T, 'PUT', { enabled: false }) === 403);
check('a technician cannot take a backup', await perm('/backup/run-now', T, 'POST', {}) === 403);
check('a technician cannot prune', await perm('/backup/prune', T, 'POST', {}) === 403);
check('a technician cannot add a destination', await perm('/backup/destinations', T, 'POST', { kind: 'folder', config: {} }) === 403);
check('a technician cannot move the backup folder', await perm('/backup/folder', T, 'PUT', { path: '/tmp/anywhere' }) === 403);
check('a technician cannot read the sync history', await perm('/backup/sync-history', T) === 403);
check('and cannot download a backup', await perm(`/backup/download/${encodeURIComponent(run.json.backup.fileName)}`, T) === 403);

// Settings rights without approval: may look and take one, may not send the
// laboratory's data somewhere new or destroy backups.
const qmRole = roles.find(r => /quality manager/i.test(r.name));
const qm = `bk_qm_${stamp}`;
await j('/users', { token: A, method: 'POST', body: { username: qm, password: PW, fullName: 'Ama Darko', roleId: qmRole.id } });
await j('/permissions/level', { token: A, method: 'POST', body: { scope: 'role', subjectId: qmRole.id, permKey: 'settings', level: 'manage' } });
const Q = (await j('/auth/login', { method: 'POST', body: { username: qm, password: PW } })).json?.token;
check('a manager with settings rights can read the status', await perm('/backup/status', Q) === 200);
check('and can take a backup', await perm('/backup/run-now', Q, 'POST', {}) === 201);
check('but cannot add a destination for the data to leave by',
  await perm('/backup/destinations', Q, 'POST', { kind: 'folder', config: {} }) === 403);
check('nor move where backups are written', await perm('/backup/folder', Q, 'PUT', { path: '/tmp/anywhere' }) === 403);
check('and cannot prune backups away', await perm('/backup/prune', Q, 'POST', {}) === 403);

/* ------------------------------------------------------ 9. the audit trail */
console.log('\n[9] Changes to how the laboratory is protected are recorded');

const trail = (await j('/records-reports/audit-trail?limit=100', { token: A })).json;
const entries = Array.isArray(trail) ? trail : [];
check('saving a schedule is audited', entries.some(e => e.entity === 'backup_schedule'), `${entries.length} entries`);
check('with what it was before', entries.some(e => e.entity === 'backup_schedule' && /enabled/.test(String(e.old_value ?? ''))));
check('taking a backup is audited', entries.some(e => e.entity === 'backup' && e.action === 'create'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
