/**
 * Why a result left the analyser, reached the LHIMS client, and never arrived.
 *
 * This script is the laboratory's own case, reproduced. A Sysmex XN-550
 * transmits to the LHIMS middleware; the middleware's own window shows the
 * message arriving and being acknowledged; SECHLIMS is pointed at the client,
 * says it is running and following, and reports that nothing has ever arrived.
 *
 * Two things were wrong, and either on its own is enough to produce exactly
 * that screen:
 *
 *   ONE — the path. Somebody asked where the LHIMS client is types where the
 *   LHIMS client is: C:\Sysmex. That is a folder. A folder is readable, so the
 *   connection test passed; a folder has no bytes, so the link followed it from
 *   byte 0 for ever and never read anything. No error, because nothing failed.
 *
 *   TWO — the framing. What the client writes to its log is what it received
 *   off the wire, envelope and all: every record wrapped in STX, a frame
 *   number, ETX and a checksum. The splitter looked for a terminator record
 *   beginning `L|` and found `<STX>2L|1|N<ETX>07`, so no transmission ever
 *   ended, everything was held back waiting for an end that had already gone
 *   past, and the held text was eventually discarded for being too large.
 *
 * And the thing the laboratory asked about: a transmission is a patient result
 * or a control, and the control patterns must decide where a message GOES, not
 * whether it is received at all.
 *
 *   npm run api        (in one terminal)
 *   node scripts/lhims-transmission-check.mjs
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
  await j('/setup/initialize', { method: 'POST', body: { facilityName: 'LHIMS Lab', username: 'admin', password: PW, fullName: 'Admin User' } });
}
const A = (await j('/auth/login', { method: 'POST', body: { username: 'admin', password: PW } })).json?.token;
if (!A) { console.error(`Could not sign in — is the API running on ${BASE}?`); process.exit(1); }

const stamp = Date.now().toString(36).toUpperCase();

/* ==========================================================================
   The LHIMS client, played faithfully
   --------------------------------------------------------------------------
   Not a tidied version of what it writes. The control characters are there
   because they are there in the real file, and they are the whole problem.
   ======================================================================== */
const STX = '\x02', ETX = '\x03', EOT = '\x04', ENQ = '\x05', CR = '\r', LF = '\n';

const checksum = body => {
  let sum = 0;
  for (const b of Buffer.from(body, 'latin1')) sum = (sum + b) & 0xff;
  return sum.toString(16).toUpperCase().padStart(2, '0');
};

/** One ASTM frame, exactly as it comes off the wire. */
const frame = (record, n) => {
  const body = `${n % 8}${record}${ETX}`;
  return STX + body + checksum(body) + CR + LF;
};

/** A Sysmex XN-550 transmission, as the laboratory's own extract shows it. */
function xn550(sampleId, at, results, { actionCode = 'N' } = {}) {
  const tests = results.map(([code]) => `^^^^^${code}`).join('\\');
  return [
    'H|\\^&|||XN-550^00-2715346^^^^BD634545||||||||E1394-97',
    'P|1||||^^|||U|||||^^^',
    'C|1||',
    `O|1||^^ ${sampleId}^M|${tests}|||||||${actionCode}||||||||||||||F`,
    'C|1||',
    ...results.map(([code, value, unit], i) => `R|${i + 1}|^^^^${code}|${value}|${unit}||N||F||||${at}`),
    // Not every R record is a clinical analyte: the XN also sends its own
    // flags and the file names of its scattergrams.
    `R|${results.length + 1}|^^^^Blasts/Abn_Lympho?|90|||||F||||${at}`,
    `R|${results.length + 2}|^^^^SCAT_WDF|PNG^R^20260923^R^2026_09_23_07_42_${sampleId}_WDF.PNG|||N||F||||${at}`,
    'C|1||',
    'L|1|N',
  ];
}

const FBC = [
  ['WBC', '6.80', '10*3/uL'], ['RBC', '4.00', '10*6/uL'], ['HGB', '11.4', 'g/dL'],
  ['HCT', '31.8', '%'], ['MCV', '79.5', 'fL'], ['PLT', '354', '10*3/uL'],
];

// The folder the LHIMS client lives in — which is what somebody types.
const clientFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'Sysmex-'));
const logFile = path.join(clientFolder, 'LHIMSDataInput.txt');
fs.writeFileSync(logFile, '');

/** What writetoFile() puts in the log: the bytes, envelope and all. */
function clientReceives(records) {
  fs.appendFileSync(logFile, ENQ + records.map(frame).join('') + EOT, 'latin1');
}

/* ==========================================================================
   0. The scene
   ======================================================================== */
console.log('\n[0] A Sysmex XN-550 transmitting to the LHIMS middleware');

const sections = (await j('/sections', { token: A })).json ?? [];
const sectionId = sections.find(s => /haemat/i.test(s.name))?.id ?? sections[0]?.id;
const haem1 = (await j('/equipment', { token: A, method: 'POST', body: {
  name: `Hematology 1 — Sysmex XN550 ${stamp}`, equipmentCategory: 'analyser', sectionId, status: 'operational',
} })).json?.id;

/* ==========================================================================
   1. The path somebody actually types
   ======================================================================== */
console.log('\n[1] "Where is the LHIMS client?" — C:\\Sysmex, which is a folder');

const link = await j('/instrument-links', { token: A, method: 'POST', body: {
  name: `Hematology 1 ${stamp}`, equipmentId: haem1, sectionId,
  profileKey: 'sysmex_xn', role: 'lhims_owned', mode: 'lhims_tap', protocol: 'astm',
  // The folder, not the file. This is what the screenshot shows.
  tapPath: clientFolder,
} });
check('a link can be set up by pointing at the folder the client lives in', link.status === 201, JSON.stringify(link.json)?.slice(0, 200));
const id = link.json?.id;

await wait(600);
const checks1 = (await j(`/instrument-links/${id}/checks`, { token: A })).json;
const address = checks1?.checks?.find(c => c.key === 'address');
check('and the checklist resolves the folder to the log inside it',
  address?.status === 'ok' && /LHIMSDataInput\.txt is being followed/i.test(address?.detail ?? ''), JSON.stringify(address));

const test = (await j(`/instrument-links/${id}/self-test`, { token: A, method: 'POST' })).json;
check('the connection test names the file, not just the folder',
  test?.ok === true && /LHIMSDataInput\.txt/.test(test?.note ?? ''), JSON.stringify(test));

/* ==========================================================================
   2. The framing — a real transmission, not a tidied one
   ======================================================================== */
console.log('\n[2] A patient sample, written down the way the client writes it');

clientReceives(xn550('2610000069', '20260923074220', FBC));
const patient = (await j(`/instrument-links/${id}/fetch`, { token: A, method: 'POST' })).json;
check('the framed transmission is read', patient?.read >= 1, JSON.stringify(patient)?.slice(0, 200));

let messages = (await j(`/instrument-links/${id}/messages`, { token: A })).json ?? [];
const first = messages[0];
check('the sample identifier is the identifier, not the composite around it',
  first?.sample_id === '2610000069', JSON.stringify(first?.sample_id));
check('it is kept as a patient result', first?.kind === 'patient', first?.kind);
check('with every parameter the analyser sent',
  (first?.parsed_values ?? []).length >= 6, `${(first?.parsed_values ?? []).length} values`);
check('mapped through the Sysmex profile',
  (first?.parsed_values ?? []).some(v => v.code === 'HGB' && v.analyte === 'Haemoglobin'),
  JSON.stringify((first?.parsed_values ?? []).slice(0, 3)));
check('and stamped with the time the analyser ran it, not the time we read it',
  String(first?.instrument_run_at ?? '').startsWith('2026-09-23T07:42'), first?.instrument_run_at);

/* ==========================================================================
   3. A control, from the same analyser, down the same link
   ======================================================================== */
console.log('\n[3] A control run, which must go somewhere else entirely');

clientReceives(xn550('CTRL-2609003058', '20260923074230', FBC));
await j(`/instrument-links/${id}/fetch`, { token: A, method: 'POST' });
messages = (await j(`/instrument-links/${id}/messages`, { token: A })).json ?? [];
const control = messages.find(m => m.sample_id === 'CTRL-2609003058');
check('the control arrives on the same link as the patient result', Boolean(control), `${messages.length} message(s)`);
check('and is told apart from it', control?.kind === 'control', control?.kind);
check('while the patient result stays a patient result',
  messages.filter(m => m.kind === 'patient').length >= 1, JSON.stringify(messages.map(m => m.kind)));

/* ==========================================================================
   4. The question the laboratory asked: do the patterns FILTER?
   --------------------------------------------------------------------------
   They must not. A link whose patterns recognise nothing should still receive
   every message; what it loses is the routing, not the result.
   ======================================================================== */
console.log('\n[4] Control patterns decide where a message goes, never whether it arrives');

await j(`/instrument-links/${id}`, { token: A, method: 'PUT', body: { controlPatterns: ['NOTHING-MATCHES-THIS'] } });
clientReceives(xn550('QC2-LEVEL2', '20260923074240', FBC));
await j(`/instrument-links/${id}/fetch`, { token: A, method: 'POST' });
messages = (await j(`/instrument-links/${id}/messages`, { token: A })).json ?? [];
const unmatched = messages.find(m => m.sample_id === 'QC2-LEVEL2');
check('a message matching no pattern at all still arrives in full', Boolean(unmatched), JSON.stringify(messages.map(m => m.sample_id)));
check('it is simply kept as a patient result rather than discarded',
  unmatched?.kind === 'patient' && (unmatched?.parsed_values ?? []).length >= 6, `${unmatched?.kind}, ${(unmatched?.parsed_values ?? []).length} values`);

// And a pattern the laboratory writes for itself, without anybody changing code.
await j(`/instrument-links/${id}`, { token: A, method: 'PUT', body: { controlPatterns: ['QC*', '/^CTRL-\\d+$/', '!QC-TRAINING'] } });
const tried = await j(`/instrument-links/${id}/simulate`, { token: A, method: 'POST', body: {
  text: ENQ + xn550('QC1-LOW', '20260923074250', FBC).map(frame).join('') + EOT,
} });
check('a wildcard pattern the laboratory wrote is honoured',
  tried.json?.messages?.[0]?.wouldBeTreatedAs === 'control', JSON.stringify(tried.json?.messages?.[0])?.slice(0, 200));
check('and the screen says why, in the same words the live log uses',
  /matches a control pattern/i.test(tried.json?.messages?.[0]?.because ?? ''), tried.json?.messages?.[0]?.because);

const trained = await j(`/instrument-links/${id}/simulate`, { token: A, method: 'POST', body: {
  text: ENQ + xn550('QC-TRAINING', '20260923074255', FBC).map(frame).join('') + EOT,
} });
check('a refusal the laboratory wrote wins over a match',
  trained.json?.messages?.[0]?.wouldBeTreatedAs === 'patient', JSON.stringify(trained.json?.messages?.[0]?.because));

/* ==========================================================================
   5. The analyser saying so itself, with no pattern at all
   ======================================================================== */
console.log('\n[5] An analyser that marks the run as quality control in the protocol');

const declared = await j(`/instrument-links/${id}/simulate`, { token: A, method: 'POST', body: {
  text: ENQ + xn550('SAMPLE-9001', '20260923074300', FBC, { actionCode: 'Q' }).map(frame).join('') + EOT,
} });
check('an ordinary-looking identifier is still read as a control when the analyser says so',
  declared.json?.messages?.[0]?.wouldBeTreatedAs === 'control', JSON.stringify(declared.json?.messages?.[0]?.because));

/* ==========================================================================
   6. Reading the same log again must not invent control runs
   ======================================================================== */
console.log('\n[6] Reading the log again from the beginning');

const before = ((await j(`/instrument-links/${id}/messages`, { token: A })).json ?? []).length;
const rewound = await j(`/instrument-links/${id}/rewind`, { token: A, method: 'POST' });
const after = ((await j(`/instrument-links/${id}/messages`, { token: A })).json ?? []).length;
check('the whole log can be read again on request', rewound.json?.ok === true, JSON.stringify(rewound.json));
check('and nothing already recorded is recorded twice', after === before, `${before} before, ${after} after`);

/* ==========================================================================
   7. The link still never touches the client's file
   ======================================================================== */
console.log('\n[7] The rule none of this may break');

const sizeBefore = fs.statSync(logFile).size;
const bytesBefore = fs.readFileSync(logFile);
await j(`/instrument-links/${id}/fetch`, { token: A, method: 'POST' });
await wait(400);
check('SECHLIMS did not write to the client\'s log', fs.statSync(logFile).size === sizeBefore);
check('nor altered a byte of it', Buffer.compare(fs.readFileSync(logFile), bytesBefore) === 0);

/* ==========================================================================
   8. Watching it happen
   ======================================================================== */
console.log('\n[8] The transmission, as it happens');

const feed = (await j(`/instrument-links/${id}/events?after=0`, { token: A })).json;
check('the live log carries what the bridge did with each message',
  (feed?.events ?? []).some(e => /New message received/i.test(e.text)), `${(feed?.events ?? []).length} event(s)`);
check('including which sample, and whether it was a control or a patient',
  (feed?.events ?? []).some(e => /Control run|Patient result/.test(e.text)),
  JSON.stringify((feed?.events ?? []).slice(-4).map(e => e.text)));
check('and it says which file is actually being followed',
  /LHIMSDataInput\.txt/.test(feed?.following?.file ?? ''), feed?.following?.file);

/* ==========================================================================
   9. An analyser nobody configured correctly
   ======================================================================== */
console.log('\n[9] A link whose protocol is left to be worked out');

const auto = await j('/instrument-links', { token: A, method: 'POST', body: {
  name: `Unknown analyser ${stamp}`, sectionId, role: 'sechlims_only', mode: 'file_drop',
  protocol: 'auto', watchPath: fs.mkdtempSync(path.join(os.tmpdir(), 'auto-')),
  profileKey: 'generic_astm',
} });
check('a link can be set to work the protocol out', auto.status === 201, JSON.stringify(auto.json)?.slice(0, 200));

const hl7 = [
  'MSH|^~\\&|BC-5800|LAB|SECHLIMS|SECH|20260923074300||ORU^R01|1|P|2.3.1',
  'OBR|1||QC-HIGH-3|^^^FBC|||20260923074300',
  'OBX|1|NM|^^^WBC^WBC||7.21|10*3/uL|||||F',
  'OBX|2|NM|^^^HGB^HGB||13.9|g/dL|||||F',
].join('\r');
const sniffed = await j(`/instrument-links/${auto.json.id}/simulate`, { token: A, method: 'POST', body: { text: hl7 } });
check('an HL7 message on that link is read as HL7 without anybody saying so',
  sniffed.json?.protocol === 'hl7' && (sniffed.json?.messages?.[0]?.results ?? []).length === 2,
  JSON.stringify(sniffed.json?.messages?.[0])?.slice(0, 200));

const astmText = ENQ + xn550('2610000070', '20260923074310', FBC).map(frame).join('') + EOT;
const sniffed2 = await j(`/instrument-links/${auto.json.id}/simulate`, { token: A, method: 'POST', body: { text: astmText } });
check('and an ASTM one on the same link is read as ASTM',
  sniffed2.json?.protocol === 'astm' && sniffed2.json?.messages?.[0]?.sampleId === '2610000070',
  JSON.stringify(sniffed2.json?.messages?.[0])?.slice(0, 160));
check('with the framing taken off, so a capture can be pasted in as it was captured',
  /^H\|/.test(String(sniffed2.json?.clean ?? '')), String(sniffed2.json?.clean ?? '').slice(0, 60));

/* ==========================================================================
   Done
   ======================================================================== */
await j(`/instrument-links/${id}/stop`, { token: A, method: 'POST' });
await j(`/instrument-links/${auto.json.id}/stop`, { token: A, method: 'POST' });
try { fs.rmSync(clientFolder, { recursive: true, force: true }); } catch { /* a temporary folder */ }

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
