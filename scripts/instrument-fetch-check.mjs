/**
 * Fetching, proved against a real folder on disk.
 *
 * The bridge was built entirely around being pushed to: an analyser dials in or
 * writes a file, and something arrives. That left two things broken, and this
 * script is about both of them.
 *
 * THE SILENT ONE. A watched folder only ever reported files CREATED while the
 * watcher was running. Everything already sitting in it when the link started
 * was invisible — permanently — and so was everything written while the host
 * was switched off. A laboratory that pointed a link at a folder holding a
 * fortnight of exports got nothing, with no error to explain it. So the first
 * thing tested here is a file written BEFORE the link exists.
 *
 * THE ONE THAT WOULD BE WORSE. The fix for that is a sweep, and a sweep that
 * forgets what it has read turns one control run into two. A duplicated point
 * on a Levey-Jennings chart is a run that never happened, and a laboratory
 * acting on it is acting on fiction — so the test that matters most below is
 * the second fetch finding NOTHING, twice over.
 *
 *   npm run api        (in one terminal)
 *   node scripts/instrument-fetch-check.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = process.env.API || 'http://127.0.0.1:4430/api';
const PW = 'Passw0rd!test';

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
const wait = ms => new Promise(r => setTimeout(r, ms));

const st = await j('/setup/status');
if (!st.json?.setupComplete) {
  await j('/setup/initialize', { method: 'POST', body: { facilityName: 'Bridge Lab', username: 'admin', password: PW, fullName: 'Admin User' } });
}
const A = (await j('/auth/login', { method: 'POST', body: { username: 'admin', password: PW } })).json?.token;
if (!A) { console.error(`Could not sign in — is the API running on ${BASE}?`); process.exit(1); }

/* One ASTM transmission, as a chemistry analyser writes it into an export. */
const transmission = (sampleId, glucose) => [
  'H|\\^&|||Selectra|||||||P|1',
  `P|1||${sampleId}`,
  `O|1|${sampleId}||^^^GLU|R`,
  `R|1|^^^GLU|${glucose}|mmol/L||N||F`,
  'L|1|N',
].join('\r') + '\r';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sechlims-drop-'));
const archive = path.join(dir, 'done');
const stamp = Date.now().toString(36).toUpperCase();

console.log(`\nWatching ${dir}\n`);

/* ==========================================================================
   [1] A file that was already there before the link existed
   ------------------------------------------------------------------------
   The silent failure. Nothing about the old watcher could ever see this file.
   ======================================================================== */
console.log('[1] A folder that already holds results');

fs.writeFileSync(path.join(dir, 'EXPORT-001.txt'), transmission(`${stamp}-A`, '5.4'), 'latin1');
// Older than the two-second settling window, so the sweep does not skip it as
// a file still being written.
await wait(2200);

const made = await j('/instrument-links', {
  method: 'POST', token: A,
  body: {
    name: `Chemistry export ${stamp}`, role: 'sechlims_only', mode: 'file_drop', protocol: 'astm',
    profileKey: 'selectra_pro', watchPath: dir, filePattern: '*.txt',
    archivePath: archive, autoStart: false, fetchEnabled: true, fetchIntervalSeconds: 60,
  },
});
check('a watched-folder link can be created with a fetch schedule', made.status === 201, JSON.stringify(made.json));
const id = made.json?.id;
if (!id) { console.log('\nCannot continue without a link.'); process.exit(1); }

const first = await j(`/instrument-links/${id}/fetch`, { method: 'POST', token: A });
check('fetching reads the file that was already in the folder', first.json?.read === 1, JSON.stringify(first.json));
check('and says so in words rather than silently', /1 new file/i.test(String(first.json?.note ?? '')), first.json?.note);

const afterFirst = await j(`/instrument-links/${id}/messages`, { token: A });
check('the transmission was recorded', (afterFirst.json ?? []).length === 1);
check('with the sample identifier the analyser sent', afterFirst.json?.[0]?.sample_id === `${stamp}-A`, afterFirst.json?.[0]?.sample_id);
check('and the glucose mapped through the chemistry profile',
  JSON.stringify(afterFirst.json?.[0]?.parsed_values ?? []).includes('Glucose'),
  JSON.stringify(afterFirst.json?.[0]?.parsed_values));

/* ==========================================================================
   [2] The test that matters most
   ------------------------------------------------------------------------
   A sweep that forgets is worse than no sweep. One control run read twice is a
   point on a chart that never happened.
   ======================================================================== */
console.log('\n[2] Reading the same folder again must not duplicate anything');

const second = await j(`/instrument-links/${id}/fetch`, { method: 'POST', token: A });
check('a second fetch finds nothing new', second.json?.read === 0, JSON.stringify(second.json));
const afterSecond = await j(`/instrument-links/${id}/messages`, { token: A });
check('and records nothing new — still one message', (afterSecond.json ?? []).length === 1,
  `${(afterSecond.json ?? []).length} messages`);

check('the file was moved aside after reading', !fs.existsSync(path.join(dir, 'EXPORT-001.txt')));
check('into the archive folder, stamped so it cannot overwrite another export',
  fs.existsSync(archive) && fs.readdirSync(archive).some(f => f.endsWith('EXPORT-001.txt')),
  fs.existsSync(archive) ? fs.readdirSync(archive).join(', ') : 'no archive folder');

const files = await j(`/instrument-links/${id}/files`, { token: A });
check('and the read is on the record, so "was that run exported?" has an answer',
  (files.json ?? []).length === 1 && files.json[0].message_count === 1,
  JSON.stringify(files.json));

/* ==========================================================================
   [3] A second export, arriving later
   ======================================================================== */
console.log('\n[3] A new export arriving afterwards');

fs.writeFileSync(path.join(dir, 'EXPORT-002.txt'), transmission(`${stamp}-B`, '6.1'), 'latin1');
await wait(2200);
const third = await j(`/instrument-links/${id}/fetch`, { method: 'POST', token: A });
check('the new file is read', third.json?.read === 1, JSON.stringify(third.json));
const afterThird = await j(`/instrument-links/${id}/messages`, { token: A });
check('two messages now, not three', (afterThird.json ?? []).length === 2, `${(afterThird.json ?? []).length}`);

/* ==========================================================================
   [4] Files the link was told not to read
   ======================================================================== */
console.log('\n[4] The file pattern');

fs.writeFileSync(path.join(dir, 'readme.log'), 'not a transmission', 'latin1');
await wait(2200);
const fourth = await j(`/instrument-links/${id}/fetch`, { method: 'POST', token: A });
check('a file outside the pattern is left alone', fourth.json?.read === 0, JSON.stringify(fourth.json));
check('and is still in the folder', fs.existsSync(path.join(dir, 'readme.log')));

/* ==========================================================================
   [5] The safety rules, applied to fetching too
   ------------------------------------------------------------------------
   Fetching an LHIMS-owned link would mean OPENING it, which is the one thing
   this bridge never does.
   ======================================================================== */
console.log('\n[5] Fetching must obey the same rule as everything else');

const lhims = await j('/instrument-links', {
  method: 'POST', token: A,
  body: {
    name: `LHIMS haematology ${stamp}`, role: 'lhims_owned', mode: 'server', protocol: 'astm',
    listenPort: 15999, autoStart: false,
  },
});
check('an LHIMS-owned link can be recorded', lhims.status === 201, JSON.stringify(lhims.json));
if (lhims.json?.id) {
  const refused = await j(`/instrument-links/${lhims.json.id}/fetch`, { method: 'POST', token: A });
  check('fetching it is refused', refused.json?.ok === false, JSON.stringify(refused.json));
  check('and says why: SECHLIMS does not open a link LHIMS owns',
    /LHIMS owns/i.test(String(refused.json?.note ?? '')), refused.json?.note);
}

const listening = await j('/instrument-links', {
  method: 'POST', token: A,
  body: { name: `Listening ${stamp}`, role: 'sechlims_only', mode: 'server', protocol: 'astm', listenPort: 15998, autoStart: false },
});
if (listening.json?.id) {
  const nothing = await j(`/instrument-links/${listening.json.id}/fetch`, { method: 'POST', token: A });
  check('a listening link says plainly that there is nothing to fetch',
    nothing.json?.ok === false && /nothing to fetch/i.test(String(nothing.json?.note ?? '')), nothing.json?.note);
  // A schedule that can never do anything is refused at the point of saving,
  // rather than silently accepted and never firing.
  const bad = await j(`/instrument-links/${listening.json.id}`, {
    method: 'PUT', token: A, body: { fetchEnabled: true },
  });
  check('and a fetch schedule cannot be set on one', bad.status === 400, JSON.stringify(bad.json));
}

/* ==========================================================================
   [6] Fetch everything, and the overview
   ======================================================================== */
console.log('\n[6] The buttons the screens actually press');

const all = await j('/instrument-links/fetch-all', { method: 'POST', token: A });
check('fetch-all answers', all.status === 200, JSON.stringify(all.json));
check('it skips the LHIMS-owned link rather than attempting it',
  !(all.json?.results ?? []).some(r => String(r.name).includes('LHIMS haematology')),
  JSON.stringify((all.json?.results ?? []).map(r => r.name)));

const over = await j('/instrument-links/overview', { token: A });
check('the overview answers "is transmission working?"', over.status === 200, JSON.stringify(over.json));
check('it counts the links', Number(over.json?.links) >= 3, JSON.stringify(over.json));
check('and reports the LHIMS-owned one as left alone, not as a failure',
  Number(over.json?.failing ?? 0) === 0, `failing=${over.json?.failing}`);

/* --------------------------------------------------------------- tidy up */
for (const linkId of [id, lhims.json?.id, listening.json?.id].filter(Boolean)) {
  await j(`/instrument-links/${linkId}`, { method: 'DELETE', token: A });
}
try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* a temp folder */ }

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
