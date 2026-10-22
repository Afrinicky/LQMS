/**
 * Carrying results on to the system downstream, whatever that system is.
 *
 * The laboratory's case: a Humacount 5D reaches SECHLIMS perfectly — the live
 * window shows every message arriving and being acknowledged — and not one of
 * its results reaches LHIMS. Five messages, all refused, all with the same
 * reason:
 *
 *   No LHIMS Measure Id For Take Mode, Blood Mode, Test Mode, Age, Remark,
 *   Ref Group, WBC, NEU%… — Map These On The Link
 *
 * Two separate faults, and the wording hides both.
 *
 *   ONE — there was nowhere to map them. The link offered a list of shipped
 *   maps, one per analyser we had the configuration files for, and a Humacount
 *   is not among them. Choosing a Sysmex map maps nothing, every parameter
 *   comes back unmapped, and the instruction "map these on the link" names a
 *   screen that did not exist.
 *
 *   TWO — half of what it is complaining about is not a result. Take Mode,
 *   Blood Mode, Test Mode, Age, Remark and Ref Group are the analyser
 *   describing itself, sent in the same segments as WBC because that is what
 *   the segment is for. Demanding an identifier for each buries the parameters
 *   that genuinely need one.
 *
 * And the thing that must stay true for every other laboratory: none of this is
 * LHIMS. A laboratory running a different LIS describes its address once and
 * carries its results the same way.
 *
 *   node scripts/forward-onward-check.mjs
 */
import net from 'node:net';
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

/* ---- HL7 over MLLP, the way a Humacount 5D sends ---- */
const VT = 0x0b, FS = 0x1c, CR = 0x0d;
function sendHl7(port, segments) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(segments.join('\r') + '\r', 'latin1');
    const frame = Buffer.concat([Buffer.from([VT]), body, Buffer.from([FS, CR])]);
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('the bridge did not answer in time')); }, 8000);
    socket.on('connect', () => socket.write(frame));
    socket.on('data', () => { clearTimeout(timer); setTimeout(() => { socket.end(); resolve(); }, 250); });
    socket.on('error', e => { clearTimeout(timer); reject(e); });
  });
}
/* What the analyser really sends: its own settings in the same OBX segments. */
const humacount = (sample) => ([
  'MSH|^~\\&|HUMACOUNT|HUMAN|LIS|LAB|20261022100714||ORU^R01|9|P|2.3.1',
  'PID|1||P-1||Doe^Jane||19900101|F',
  `OBR|1||${sample}|CBC|||20261022100700|||||||||||||||||F`,
  'OBX|1|ST|^Take Mode||Whole Blood||||||F',
  'OBX|2|ST|^Blood Mode||Pre-dilute||||||F',
  'OBX|3|ST|^Test Mode||CBC+DIFF||||||F',
  'OBX|4|NM|^Age||34|yr|||||F',
  'OBX|5|ST|^Remark||none||||||F',
  'OBX|6|ST|^Ref Group||Adult Female||||||F',
  'OBX|7|NM|^WBC||7.82|10*9/L|||||F',
  'OBX|8|NM|^NEU%||54.3|%|||||F',
  'OBX|9|NM|^HGB||12.40|g/dL|||||F',
  'OBX|10|NM|^PLT||243|10*9/L|||||F',
]);

const st = await j('/setup/status');
if (!st.json?.setupComplete) {
  await j('/setup/initialize', { method: 'POST', body: {
    facilityName: 'Onward Lab', username: 'admin', password: PW, fullName: 'Admin User',
  } });
}
const A = (await j('/auth/login', { method: 'POST', body: { username: 'admin', password: PW } })).json?.token;
const stamp = Date.now();
const PORT = 49000 + (stamp % 400);

/* ============== a receiving system that is not LHIMS, listening for real ===== */
const received = [];
const receiver = http.createServer((req, res) => {
  received.push(new URL(req.url, 'http://127.0.0.1'));
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('1');
});
const RECEIVER_PORT = PORT + 700;
await new Promise(r => receiver.listen(RECEIVER_PORT, '127.0.0.1', r));

/* ================================================= 1. the analyser and the link */
console.log('\n[1] A Humacount 5D, reaching SECHLIMS perfectly');
const sec = (await j('/section-config/sections', { token: A, method: 'POST', body: {
  name: `RCH Laboratory ${stamp}`, code: `RC${String(stamp).slice(-6)}`,
} })).json;
const eq = (await j('/equipment', { token: A, method: 'POST', body: {
  name: `HUMACOUNT 5D ${stamp}`, equipmentCategory: 'analyser', sectionId: sec.id, status: 'operational',
} })).json;
const link = await j('/instrument-links', { token: A, method: 'POST', body: {
  name: `Humacount 5D ${stamp}`, equipmentId: eq.id, sectionId: sec.id, profileKey: 'generic_hl7',
  role: 'shared_forward', mode: 'server', protocol: 'auto', listenPort: PORT, autoStart: true,
} });
check('the link is registered', link.status === 201, JSON.stringify(link.json));
const linkId = link.json?.id;
await j(`/instrument-links/${linkId}/start`, { token: A, method: 'POST' });
await wait(700);

await sendHl7(PORT, humacount(`2609002439`));
await wait(1200);
const arrived = (await j(`/instrument-links/${linkId}/messages?kind=patient`, { token: A })).json ?? [];
check('its patient result reaches SECHLIMS', arrived.length === 1, JSON.stringify(arrived.map(m => m.sample_id)));
check('with every field the analyser sent, settings and all',
  (arrived[0]?.parsed_values ?? []).length === 10, JSON.stringify((arrived[0]?.parsed_values ?? []).length));

/* ========== 2. the screen that did not exist, listing what it actually sends === */
console.log('\n[2] Every parameter the analyser has sent, ready to be matched up');
const params = await j(`/instrument-links/${linkId}/parameters`, { token: A });
check('the link can say what it has received', params.status === 200, JSON.stringify(params.json?.error));
const byCode = Object.fromEntries((params.json?.parameters ?? []).map(p => [p.code, p]));
check('all ten codes are listed', Object.keys(byCode).length === 10, JSON.stringify(Object.keys(byCode)));
check('with an example of the value, so nobody matches blind',
  byCode['WBC']?.samples?.includes('7.82'), JSON.stringify(byCode['WBC']));
check('and the unit the analyser reported', byCode['HGB']?.unit === 'g/dL', JSON.stringify(byCode['HGB']?.unit));
check('none has an identifier yet, which is the fault being fixed',
  Number(params.json?.counts?.needed) === 10, JSON.stringify(params.json?.counts));

console.log('\n[3] The analyser describing itself is told apart from what it measured');
for (const code of ['Take Mode', 'Blood Mode', 'Test Mode', 'Remark', 'Ref Group', 'Age']) {
  check(`"${code}" is suggested as not a result`, byCode[code]?.suggestion === 'describes_itself',
    JSON.stringify(byCode[code]?.suggestion));
}
for (const code of ['WBC', 'NEU%', 'HGB', 'PLT']) {
  check(`"${code}" is suggested as a measurement`, byCode[code]?.suggestion === 'measurement',
    JSON.stringify(byCode[code]?.suggestion));
}

/* ================= 4. matched up, and carried to a system that is not LHIMS ==== */
console.log('\n[4] Matched up once, and carried onward to a LIS that is not LHIMS');
const measureMap = { WBC: 'wbc_count', 'NEU%': 'neut_pct', HGB: 'haemoglobin', PLT: 'platelets' };
const skip = ['Take Mode', 'Blood Mode', 'Test Mode', 'Age', 'Remark', 'Ref Group'];
const template = `http://127.0.0.1:${RECEIVER_PORT}/api/results?sample={specimen}&test={code}&value={value}&dp={decimals}`;

const saved = await j(`/instrument-links/${linkId}`, { token: A, method: 'PUT', body: {
  forwardEnabled: true, forwardTarget: 'http_template', forwardTemplate: template,
  lhimsUsername: 'lab', lhimsPassword: 'secret', measureMap, forwardSkip: skip,
} });
check('the link saves the address and the matching', saved.status === 200, JSON.stringify(saved.json?.error));

await sendHl7(PORT, humacount(`2609003312`));
await wait(1500);
for (let i = 0; i < 25 && received.length < 4; i++) await wait(1000);

check('four results reach the receiving system', received.length === 4,
  `${received.length}: ${received.map(u => u.searchParams.get('test')).join(', ')}`);
check('under the identifiers that system knows them by',
  ['wbc_count', 'neut_pct', 'haemoglobin', 'platelets']
    .every(id => received.some(u => u.searchParams.get('test') === id)),
  received.map(u => u.searchParams.get('test')).join(', '));
check('the analyser’s own settings are not among them',
  !received.some(u => /Mode|Remark|Ref Group|Age/i.test(String(u.searchParams.get('test')))),
  received.map(u => u.searchParams.get('test')).join(', '));
check('each carrying its specimen number',
  received.every(u => u.searchParams.get('sample') === '2609003312'),
  received.map(u => u.searchParams.get('sample')).join(', '));
check('and the value as the analyser reported it',
  received.some(u => u.searchParams.get('test') === 'haemoglobin' && u.searchParams.get('value') === '12.40'),
  received.map(u => `${u.searchParams.get('test')}=${u.searchParams.get('value')}`).join(', '));
check('with the decimal places it was measured to',
  received.some(u => u.searchParams.get('test') === 'haemoglobin' && u.searchParams.get('dp') === '2'),
  received.map(u => `${u.searchParams.get('test')}:${u.searchParams.get('dp')}`).join(', '));

const delivered = ((await j(`/instrument-links/${linkId}/messages?kind=patient`, { token: A })).json ?? [])
  .find(m => m.sample_id === '2609003312');
check('and the message is recorded as fully delivered', delivered?.forward_status === 'sent',
  JSON.stringify([delivered?.forward_status, delivered?.forward_note]));

/* ============================ 5. what the screen now says needs doing ========= */
console.log('\n[5] What is left to do, counted honestly');
const after = (await j(`/instrument-links/${linkId}/parameters`, { token: A })).json;
check('nothing is still to set', Number(after?.counts?.needed) === 0, JSON.stringify(after?.counts));
check('four are ready', Number(after?.counts?.ready) === 4, JSON.stringify(after?.counts));
check('six are recorded as not results', Number(after?.counts?.skipped) === 6, JSON.stringify(after?.counts));

/* ======================== 6. an address that would send results nowhere ======= */
console.log('\n[6] An address that could not work is refused while it can still be fixed');
const noValue = await j(`/instrument-links/${linkId}`, { token: A, method: 'PUT', body: {
  forwardTarget: 'http_template', forwardTemplate: `http://127.0.0.1:${RECEIVER_PORT}/api?sample={specimen}`,
} });
check('an address with no {value} is refused', noValue.status === 400, JSON.stringify(noValue.json));
const madeUp = await j(`/instrument-links/${linkId}`, { token: A, method: 'PUT', body: {
  forwardTarget: 'http_template',
  forwardTemplate: `http://127.0.0.1:${RECEIVER_PORT}/api?s={specimen}&v={value}&who={patient_name}`,
} });
check('a placeholder this system cannot fill is refused, and named',
  madeUp.status === 400 && /patient_name/.test(String(madeUp.json?.error)), JSON.stringify(madeUp.json));
const notUrl = await j(`/instrument-links/${linkId}`, { token: A, method: 'PUT', body: {
  forwardTarget: 'http_template', forwardTemplate: 'lis.example.org?s={specimen}&v={value}',
} });
check('an address that is not a URL is refused', notUrl.status === 400, JSON.stringify(notUrl.json));

/* ============================= 7. the safety rule is untouched ================ */
console.log('\n[7] The rule that protects the transmission already working');
const owned = await j('/instrument-links', { token: A, method: 'POST', body: {
  name: `LHIMS owns this ${stamp}`, sectionId: sec.id, profileKey: 'generic_hl7',
  role: 'lhims_owned', mode: 'server', protocol: 'auto', listenPort: PORT + 1,
  forwardEnabled: true, forwardTarget: 'http_template',
  forwardTemplate: `http://127.0.0.1:${RECEIVER_PORT}/api?s={specimen}&v={value}`,
} });
check('a link the middleware already owns still cannot be carried onward',
  owned.status === 400, JSON.stringify(owned.json));

/* ========== 8. the same analyser, carried to LHIMS the way its middleware does = */
/*
 * The laboratory's own destination. This stands in for LHIMS at the one call
 * the middleware makes — api/update_result.php — and checks that SECHLIMS makes
 * it identically: the same path, the same parameter names, the measure id as a
 * number, the result and its decimal places. A laboratory already running LHIMS
 * must get the call the middleware would have made, not a near miss.
 */
console.log('\n[8] The same analyser, carried to LHIMS the way its own middleware does');
const lhimsCalls = [];
const lhims = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  lhimsCalls.push(url);
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  // What the middleware's server answers when it has stored a result.
  res.end('1');
});
const LHIMS_PORT = PORT + 800;
await new Promise(r => lhims.listen(LHIMS_PORT, '127.0.0.1', r));

// The measure ids are the laboratory's own, typed in by hand, because no
// shipped map covers a Humacount. That is the whole point of the screen.
const measureIds = { WBC: 23, 'NEU%': 31, HGB: 25, PLT: 29 };
const toLhims = await j(`/instrument-links/${linkId}`, { token: A, method: 'PUT', body: {
  forwardEnabled: true, forwardTarget: 'lhims_api',
  lhimsUrl: `http://127.0.0.1:${LHIMS_PORT}/lhims_193`,
  lhimsUsername: 'SNO-484', lhimsPassword: 'secret',
  lhimsMapKey: '', measureMap: measureIds, forwardSkip: skip,
} });
check('the link is pointed at LHIMS with the ids set by hand',
  toLhims.status === 200, JSON.stringify(toLhims.json?.error));

await sendHl7(PORT, humacount('2609003336'));
await wait(1500);
for (let i = 0; i < 25 && lhimsCalls.length < 4; i++) await wait(1000);

check('four results reach LHIMS', lhimsCalls.length === 4,
  `${lhimsCalls.length}: ${lhimsCalls.map(u => u.searchParams.get('measure_id')).join(', ')}`);
check('at the middleware\u2019s own endpoint',
  lhimsCalls.every(u => u.pathname === '/lhims_193/api/update_result.php'),
  [...new Set(lhimsCalls.map(u => u.pathname))].join(', '));
check('with the username the middleware uses',
  lhimsCalls.every(u => u.searchParams.get('username') === 'SNO-484'), 'username');
check('the specimen filed under its own number',
  lhimsCalls.every(u => u.searchParams.get('specimen_id') === '2609003336'),
  [...new Set(lhimsCalls.map(u => u.searchParams.get('specimen_id')))].join(', '));
check('each parameter under the measure id this laboratory gave it',
  [23, 31, 25, 29].every(id => lhimsCalls.some(u => u.searchParams.get('measure_id') === String(id))),
  lhimsCalls.map(u => u.searchParams.get('measure_id')).join(', '));
check('the haemoglobin exactly as the analyser reported it',
  lhimsCalls.some(u => u.searchParams.get('measure_id') === '25' && u.searchParams.get('result') === '12.40'),
  lhimsCalls.map(u => `${u.searchParams.get('measure_id')}=${u.searchParams.get('result')}`).join(', '));
/*
 * dec=0 on every call, because that is what the middleware sends. Its
 * HumaCount driver calls saveResults(barcode, measureId, value, 0) with the
 * literal 0, and its other drivers append the constant string "&dec=0". Every
 * result LHIMS has accepted through this endpoint arrived with dec=0, and a
 * call indistinguishable from the middleware's is the whole object here.
 */
check('and dec=0, the way the middleware sends it',
  lhimsCalls.every(u => u.searchParams.get('dec') === '0'),
  lhimsCalls.map(u => u.searchParams.get('dec')).join(', '));
check('the parameters in the order the middleware writes them',
  lhimsCalls.every(u => [...u.searchParams.keys()].join(',')
    === 'username,password,specimen_id,measure_id,result,dec'),
  [...new Set(lhimsCalls.map(u => [...u.searchParams.keys()].join(',')))].join(' | '));
check('and the analyser\u2019s own settings never reach LHIMS',
  lhimsCalls.length === 4, 'six settings would have made ten calls');

const toLhimsMsg = ((await j(`/instrument-links/${linkId}/messages?kind=patient`, { token: A })).json ?? [])
  .find(m => m.sample_id === '2609003336');
check('and LHIMS answering "1" is read as stored', toLhimsMsg?.forward_status === 'sent',
  JSON.stringify([toLhimsMsg?.forward_status, toLhimsMsg?.forward_note]));

/* ============ 9. what the laboratory saw before any of this was built ======== */
console.log('\n[9] The failure the laboratory reported, and that it no longer happens');
/*
 * Reproduced exactly: another analyser's shipped map chosen, nothing set by
 * hand, nothing marked as not a result. Every parameter comes back unmapped,
 * which is the screen in the laboratory's own screenshot.
 */
const asBefore = await j(`/instrument-links/${linkId}`, { token: A, method: 'PUT', body: {
  lhimsMapKey: 'sysmex_xs500i', measureMap: {}, forwardSkip: [],
} });
check('a link can be put back the way it was', asBefore.status === 200, JSON.stringify(asBefore.json?.error));
await sendHl7(PORT, humacount('2609009999'));
// Delivery is store-and-forward, so wait for the queue to settle rather than
// for a fixed moment: 'pending' here would mean "not tried yet", not "failed".
let before = null;
for (let i = 0; i < 30; i++) {
  await wait(1000);
  before = ((await j(`/instrument-links/${linkId}/messages?kind=patient`, { token: A })).json ?? [])
    .find(m => m.sample_id === '2609009999');
  if (before && before.forward_status !== 'pending') break;
}
check('with another analyser\u2019s map it still delivers nothing \u2014 the original fault',
  before?.forward_status === 'failed', JSON.stringify([before?.forward_status, before?.forward_note]));
const whyBefore = String(before?.forward_error ?? before?.forward_note ?? '');
check('naming the parameters, as the laboratory\u2019s own screen did',
  /Take Mode/.test(whyBefore) && /WBC/.test(whyBefore), whyBefore);
check('but now saying where to fix it',
  /receiving system calls each parameter/i.test(whyBefore), whyBefore);

const still = (await j(`/instrument-links/${linkId}/parameters`, { token: A })).json;
check('and the screen lists all ten parameters waiting to be matched up',
  Number(still?.counts?.needed) === 10, JSON.stringify(still?.counts));

lhims.close();
await j(`/instrument-links/${linkId}/stop`, { token: A, method: 'POST' });
receiver.close();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
