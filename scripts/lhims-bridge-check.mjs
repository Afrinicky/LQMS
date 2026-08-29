/**
 * The two things the decompiled LHIMS client made possible, proved.
 *
 * ONE — a copy of the analyser LHIMS owns. The client has a setting,
 * WRITE_TO_FILE, that makes it append every message it receives to
 * LHIMSDataInput.txt before doing anything else with it. This script plays the
 * part of that client: it appends real Sysmex transmissions to a file, and
 * checks SECHLIMS follows them. Crucially it also checks SECHLIMS never writes
 * to that file, never truncates it and never holds it — because the whole
 * claim is that following it cannot disturb the transmission.
 *
 * TWO — carrying results INTO LHIMS. The client posts each result to
 * api/update_result.php with a measure_id from the laboratory's own config. A
 * stub server here stands in for LHIMS and records exactly what arrives, so the
 * URL shape, the measure ids and the values can be checked against what the
 * real client would have sent.
 *
 *   npm run api        (in one terminal)
 *   node scripts/lhims-bridge-check.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

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
  await j('/setup/initialize', { method: 'POST', body: { facilityName: 'LHIMS Lab', username: 'admin', password: PW, fullName: 'Admin User' } });
}
const A = (await j('/auth/login', { method: 'POST', body: { username: 'admin', password: PW } })).json?.token;
if (!A) { console.error('Could not sign in — is the API running on ' + BASE + '?'); process.exit(1); }

const stamp = Date.now().toString(36).toUpperCase();
// Unique per run, for the same reason: a link's port is exclusive, so a re-run
// must not ask for one an earlier run's links still hold.
const PORT_BASE = 15600 + (Date.now() % 300) * 10;
const PORT_LHIMS_STUB = PORT_BASE + 1;
const PORT_REFUSED = PORT_BASE + 2;
const PORT_CHEM = PORT_BASE + 3;
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lhims-tap-'));
const tapFile = path.join(workDir, 'LHIMSDataInput.txt');
fs.writeFileSync(tapFile, '');

/** Append a transmission the way the LHIMS client's writetoFile() does. */
function clientAppends(records) {
  fs.appendFileSync(tapFile, records.join('\r') + '\r', 'latin1');
}

/* ==========================================================================
   A stub standing in for the LHIMS server
   ======================================================================== */
const delivered = [];
let refuseNext = 0;
const lhims = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.endsWith('/api/update_result.php')) {
    if (refuseNext > 0) { refuseNext--; res.end('0'); return; }
    delivered.push({
      username: url.searchParams.get('username'),
      password: url.searchParams.get('password'),
      specimenId: url.searchParams.get('specimen_id'),
      measureId: Number(url.searchParams.get('measure_id')),
      result: url.searchParams.get('result'),
      dec: Number(url.searchParams.get('dec')),
    });
    res.end('1');   // what LHIMS answers when it stored the result
    return;
  }
  res.statusCode = 404; res.end('');
});
await new Promise(r => lhims.listen(PORT_LHIMS_STUB, '127.0.0.1', r));

/* ==========================================================================
   0. The scene
   ======================================================================== */
console.log('\n[0] An analyser LHIMS owns, and one it never carried');

const sections = (await j('/sections', { token: A })).json ?? [];
const sectionId = sections.find(s => /haemat/i.test(s.name))?.id ?? sections[0]?.id;

const haem1 = (await j('/equipment', { token: A, method: 'POST', body: {
  name: `Sysmex XN-550 on LHIMS ${stamp}`, equipmentCategory: 'analyser', sectionId, status: 'operational',
} })).json?.id;
const chem1 = (await j('/equipment', { token: A, method: 'POST', body: {
  name: `Selectra Pro S ${stamp}`, equipmentCategory: 'analyser', sectionId, status: 'operational',
} })).json?.id;

const profiles = await j('/instrument-links/profiles', { token: A });
check('the system ships the LHIMS measure maps from the laboratory\'s own configs',
  (profiles.json?.lhimsMaps ?? []).length >= 15, `${(profiles.json?.lhimsMaps ?? []).length} maps`);
check('including the Selectra Pro S chemistry map',
  profiles.json?.lhimsMaps?.some(m => m.key === 'selectra_pros' && m.measureCount >= 20),
  JSON.stringify(profiles.json?.lhimsMaps?.find(m => m.key === 'selectra_pros')));
check('and it explains how to switch the client\'s log on',
  (profiles.json?.tap?.steps ?? []).some(s => /WRITE_TO_FILE/.test(s)), JSON.stringify(profiles.json?.tap?.filename));

/* ==========================================================================
   1. Haematology 1 — a copy, taken without touching the link
   ======================================================================== */
console.log('\n[1] Following the LHIMS client\'s own log — the way haematology 1 reaches SECHLIMS');

// A link that binds or dials is still refused on an LHIMS-owned analyser.
const stillRefused = await j('/instrument-links', { token: A, method: 'POST', body: {
  name: `Haem 1 direct ${stamp}`, role: 'lhims_owned', mode: 'server', protocol: 'astm', listenPort: PORT_REFUSED,
} });
const startAttempt = stillRefused.status === 201
  ? await j(`/instrument-links/${stillRefused.json.id}/start`, { token: A, method: 'POST' })
  : { status: 400 };
check('an LHIMS-owned link that would BIND is still refused', startAttempt.status === 400, `${startAttempt.status}`);
check('and is pointed at the safe alternative',
  /follow the LHIMS client|reads a file/i.test(String(startAttempt.json?.error ?? '')), startAttempt.json?.error);

const tap = await j('/instrument-links', { token: A, method: 'POST', body: {
  name: `Haematology 1 — copy from LHIMS ${stamp}`, equipmentId: haem1, sectionId,
  profileKey: 'sysmex_xn', role: 'lhims_owned', mode: 'lhims_tap', protocol: 'astm',
  tapPath: tapFile, controlPatterns: ['QC', 'QC1', 'QC2', 'XbarM'],
} });
check('but following the client\'s log IS allowed on that same analyser', tap.status === 201, JSON.stringify(tap.json)?.slice(0, 200));
await wait(600);
let tapState = (await j('/instrument-links', { token: A })).json?.find(l => l.id === tap.json.id);
check('and the link is following it', tapState?.state === 'following', `${tapState?.state}: ${tapState?.state_detail}`);
check('saying so is read-only', /read-only|untouched/i.test(String(tapState?.state_detail ?? '')), tapState?.state_detail);

// What the file looked like before SECHLIMS ever saw it.
const beforeStat = fs.statSync(tapFile);
const beforeBytes = fs.readFileSync(tapFile);

// The LHIMS client receives a patient sample and appends it.
clientAppends([
  'H|\\^&|||XN-550^1.0|||||||P|1|20260829103000',
  'P|1||||^^||||||||||||||||||||||||||',
  'O|1|SC260829-0507||^^^^FBC|R||20260829102800|||||||||||||||||F',
  'R|1|^^^WBC|5.83|10*3/uL||N||F||||20260829102900',
  'R|2|^^^HGB|12.9|g/dL||N||F||||20260829102900',
  'R|3|^^^PLT|233|10*3/uL||N||F||||20260829102900',
  'L|1|N',
]);
await wait(4500);

let messages = (await j(`/instrument-links/${tap.json.id}/messages`, { token: A })).json ?? [];
const copied = messages.find(m => m.sample_id === 'SC260829-0507');
check('a patient result reaches SECHLIMS through the log', Boolean(copied), `${messages.length} message(s)`);
check('with its three results', copied?.result_count === 3, `${copied?.result_count}`);
check('mapped to analytes', copied?.parsed_values?.some(v => v.code === 'HGB' && v.analyte === 'Haemoglobin'));

// And the file is exactly as the client left it.
const afterStat = fs.statSync(tapFile);
const afterBytes = fs.readFileSync(tapFile);
check('SECHLIMS did not write to the file', afterBytes.length >= beforeBytes.length
  && afterBytes.subarray(0, beforeBytes.length).equals(beforeBytes), 'the earlier bytes are unchanged');
check('nor truncated or replaced it', afterStat.ino === beforeStat.ino, `inode ${beforeStat.ino} -> ${afterStat.ino}`);

// The client keeps appending; the tap keeps up without re-reading old messages.
clientAppends([
  'H|\\^&|||XN-550^1.0|||||||P|1|20260829080000',
  'O|1|QC2||^^^^FBC|R||20260829075500|||||||||||||||||F',
  'R|1|^^^WBC|7.31|10*3/uL||N||F',
  'R|2|^^^HGB|13.5|g/dL||N||F',
  'L|1|N',
]);
await wait(4500);
messages = (await j(`/instrument-links/${tap.json.id}/messages`, { token: A })).json ?? [];
check('a second transmission is picked up', messages.length === 2, `${messages.length}`);
check('and the first is not read twice',
  messages.filter(m => m.sample_id === 'SC260829-0507').length === 1);
check('a control in the log is recognised as a control',
  messages.find(m => m.sample_id === 'QC2')?.kind === 'control',
  messages.find(m => m.sample_id === 'QC2')?.kind);
check('and parked on the IQC bench',
  ((await j('/iqc/portal/feed-messages', { token: A })).json ?? []).some(m => m.sample_id === 'QC2'));

// Half an append must not be parsed as a whole message.
fs.appendFileSync(tapFile, 'H|\\^&|||XN-550^1.0|||||||P|1\rO|1|SC-PARTIAL||^^^^FBC|R\rR|1|^^^WBC|4.4', 'latin1');
await wait(4500);
messages = (await j(`/instrument-links/${tap.json.id}/messages`, { token: A })).json ?? [];
check('a half-written transmission is held back, not parsed short',
  !messages.some(m => m.sample_id === 'SC-PARTIAL'), `${messages.length} message(s)`);
fs.appendFileSync(tapFile, '\rR|2|^^^HGB|11.8|g/dL||N||F\rL|1|N\r', 'latin1');
await wait(4500);
messages = (await j(`/instrument-links/${tap.json.id}/messages`, { token: A })).json ?? [];
const completed = messages.find(m => m.sample_id === 'SC-PARTIAL');
check('and read in full once the client finishes writing it', Boolean(completed));
check('with both of its results', completed?.result_count === 2, `${completed?.result_count}`);

/* ==========================================================================
   2. Carrying the chemistry analyser INTO LHIMS
   ======================================================================== */
console.log('\n[2] SECHLIMS delivering to LHIMS, the way the middleware does');

const carry = await j('/instrument-links', { token: A, method: 'POST', body: {
  name: `Chemistry 1 ${stamp}`, equipmentId: chem1, sectionId,
  profileKey: 'selectra_pro', role: 'shared_forward', mode: 'server', protocol: 'astm',
  listenPort: PORT_CHEM,
  forwardEnabled: true, forwardTarget: 'lhims_api',
  lhimsUrl: `http://127.0.0.1:${PORT_LHIMS_STUB}/`, lhimsUsername: 'lhimsuser', lhimsPassword: 'secret-pw',
  lhimsMapKey: 'selectra_pros',
} });
check('a link can be set to carry results to LHIMS', carry.status === 201, JSON.stringify(carry.json)?.slice(0, 200));
check('and the password is never sent back out',
  carry.json?.lhims_password === undefined && carry.json?.lhims_password_set === true,
  JSON.stringify({ pw: carry.json?.lhims_password, set: carry.json?.lhims_password_set }));

const listed = (await j('/instrument-links', { token: A })).json?.find(l => l.id === carry.json.id);
check('nor in the listing', listed?.lhims_password === undefined, JSON.stringify(Object.keys(listed ?? {}).filter(k => /password/i.test(k))));

// What the bench sees before trusting it.
const dry = await j(`/instrument-links/${carry.json.id}/simulate`, { token: A, method: 'POST', body: {
  text: [
    'H|\\^&|||Selectra ProS^2.1|||||||P|1|20260829094500',
    'O|1|SC260829-0611||^^^^CHEM|R||20260829094000|||||||||||||||||F',
    'R|1|^^^ALB|41|g/L||N||F',
    'R|2|^^^ALT|31|U/L||N||F',
    'R|3|^^^NONSENSE|9|x||N||F',
    'L|1|N',
  ].join('\r\n'),
} });
check('trying a message shows what LHIMS would be told', dry.status === 200);
check('ALB maps to the measure id from the laboratory\'s own config',
  dry.json?.messages?.[0]?.results?.find(r => r.code === 'ALB')?.lhimsMeasureId === 144,
  JSON.stringify(dry.json?.messages?.[0]?.results?.map(r => `${r.code}=${r.lhimsMeasureId}`)));
check('and a parameter LHIMS has no id for is named, not guessed at',
  dry.json?.unmappedForLhims?.includes('NONSENSE'), JSON.stringify(dry.json?.unmappedForLhims));

/* -- now for real, over the wire ------------------------------------------ */
const net = await import('node:net');
const ENQ = 0x05, ACK = 0x06, EOT = 0x04, STX = 0x02, ETX = 0x03;
function astmFrame(n, text) {
  const body = Buffer.from(`${n % 8}${text}`, 'latin1');
  const withEtx = Buffer.concat([body, Buffer.from([ETX])]);
  let sum = 0; for (const b of withEtx) sum = (sum + b) & 0xff;
  return Buffer.concat([Buffer.from([STX]), withEtx,
    Buffer.from(`${sum.toString(16).toUpperCase().padStart(2, '0')}\r\n`, 'latin1')]);
}
function sendAstm(port, records) {
  return new Promise((resolve, reject) => {
    const socket = net.default.createConnection({ host: '127.0.0.1', port });
    let index = -1;
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('no answer')); }, 8000);
    socket.on('connect', () => socket.write(Buffer.from([ENQ])));
    socket.on('data', chunk => {
      for (const byte of chunk) {
        if (byte !== ACK) continue;
        index++;
        if (index < records.length) socket.write(astmFrame(index + 1, records[index]));
        else { socket.write(Buffer.from([EOT])); clearTimeout(timer); setTimeout(() => { socket.end(); resolve(); }, 200); return; }
      }
    });
    socket.on('error', e => { clearTimeout(timer); reject(e); });
  });
}

await wait(500);
await sendAstm(PORT_CHEM, [
  'H|\\^&|||Selectra ProS^2.1|||||||P|1|20260829094500',
  'O|1|SC260829-0611||^^^^CHEM|R||20260829094000|||||||||||||||||F',
  'R|1|^^^ALB|41|g/L||N||F',
  'R|2|^^^ALT|31|U/L||N||F',
  'R|3|^^^CREA|88.5|umol/L||N||F',
  'L|1|N',
]);
// The delivery sweep runs on a timer; give it a turn.
await wait(23000);

check('the patient results were delivered to LHIMS', delivered.length >= 3, `${delivered.length} call(s)`);
check('under the right specimen id',
  delivered.every(d => d.specimenId === 'SC260829-0611'), JSON.stringify(delivered.map(d => d.specimenId)));
check('with LHIMS\'s own measure ids — ALB 144, ALT 153',
  delivered.some(d => d.measureId === 144 && d.result === '41')
  && delivered.some(d => d.measureId === 153 && d.result === '31'),
  JSON.stringify(delivered.map(d => `${d.measureId}=${d.result}`)));
check('and the decimal places the analyser reported',
  delivered.find(d => d.measureId === 145 || d.result === '88.5')?.dec === 1,
  JSON.stringify(delivered.map(d => `${d.result}/dec${d.dec}`)));
check('authenticating as the middleware does',
  delivered[0]?.username === 'lhimsuser' && delivered[0]?.password === 'secret-pw');

const carried = (await j(`/instrument-links/${carry.json.id}/messages`, { token: A })).json ?? [];
check('and the message records that it went', ['sent', 'partial'].includes(carried[0]?.forward_status), carried[0]?.forward_status);

/* ==========================================================================
   3. What must NOT be delivered
   ======================================================================== */
console.log('\n[3] The things LHIMS must never be sent');

const before = delivered.length;
await sendAstm(PORT_CHEM, [
  'H|\\^&|||Selectra ProS^2.1|||||||P|1|20260829080000',
  'O|1|QC1||^^^^CHEM|R||20260829075500|||||||||||||||||F',
  'R|1|^^^ALB|39|g/L||N||F',
  'L|1|N',
]);
await wait(23000);
check('a CONTROL run is not posted into LHIMS as a patient result',
  delivered.length === before, `${delivered.length - before} extra call(s)`);
const controlMsg = ((await j(`/instrument-links/${carry.json.id}/messages`, { token: A })).json ?? [])
  .find(m => m.sample_id === 'QC1');
check('it is recorded as not needing delivery', controlMsg?.forward_status === 'not_required', controlMsg?.forward_status);
check('and is on the IQC bench instead', controlMsg?.kind === 'control', controlMsg?.kind);

// The copy of haematology 1 must never be posted back into LHIMS.
const doubleUp = await j(`/instrument-links/${tap.json.id}`, { token: A, method: 'PUT', body: {
  forwardEnabled: true, forwardTarget: 'lhims_api',
  lhimsUrl: `http://127.0.0.1:${PORT_LHIMS_STUB}/`, lhimsUsername: 'x', lhimsMapKey: 'sysmex_xs500i',
} });
if (doubleUp.status === 200) {
  const countBefore = delivered.length;
  await wait(23000);
  check('a copy taken FROM LHIMS is never posted back into LHIMS',
    delivered.length === countBefore, `${delivered.length - countBefore} extra call(s)`);
} else {
  check('a copy taken FROM LHIMS cannot even be set to deliver back to it', doubleUp.status === 400, doubleUp.json?.error);
}

/* ==========================================================================
   4. LHIMS being down costs a delay, not a result
   ======================================================================== */
console.log('\n[4] When LHIMS refuses');

refuseNext = 99;
await sendAstm(PORT_CHEM, [
  'H|\\^&|||Selectra ProS^2.1|||||||P|1|20260829120000',
  'O|1|SC260829-0777||^^^^CHEM|R||20260829115500|||||||||||||||||F',
  'R|1|^^^ALB|44|g/L||N||F',
  'L|1|N',
]);
await wait(23000);
const held = ((await j(`/instrument-links/${carry.json.id}/messages`, { token: A })).json ?? [])
  .find(m => m.sample_id === 'SC260829-0777');
check('a refused result is kept, not lost', Boolean(held), 'the message is recorded either way');
check('and marked as not delivered', ['failed', 'pending', 'partial'].includes(held?.forward_status), held?.forward_status);

refuseNext = 0;
await wait(23000);
const recovered = ((await j(`/instrument-links/${carry.json.id}/messages`, { token: A })).json ?? [])
  .find(m => m.sample_id === 'SC260829-0777');
check('and delivered once LHIMS answers again',
  recovered?.forward_status === 'sent' || delivered.some(d => d.specimenId === 'SC260829-0777'),
  `${recovered?.forward_status}`);

/* ==========================================================================
   Tidy up
   ======================================================================== */
for (const id of [tap.json.id, carry.json.id]) {
  await j(`/instrument-links/${id}/stop`, { token: A, method: 'POST' });
}
lhims.close();
try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* best effort */ }

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
