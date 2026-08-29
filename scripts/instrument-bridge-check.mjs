/**
 * The analyser bridge, proved against simulated analysers.
 *
 * The claim being tested is a safety claim as much as a feature claim: SECHLIMS
 * can take the analysers that transmit to nothing today, WITHOUT going anywhere
 * near the link the LHIMS middleware is using for patient results.
 *
 * So this plays real traffic — a Sysmex ASTM transmission and a Mindray HL7
 * one — at live TCP links, and then attacks the safety rules directly: it tries
 * to start an LHIMS-owned link, tries to steal its port, tries to dial its
 * analyser, and tries to forward a copy back to LHIMS from a link LHIMS already
 * has. Every one of those must be refused.
 *
 *   npm run api        (in one terminal)
 *   node scripts/instrument-bridge-check.mjs
 */
import net from 'node:net';

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
if (!A) { console.error('Could not sign in — is the API running on ' + BASE + '?'); process.exit(1); }

const stamp = Date.now().toString(36).toUpperCase();
const PORT_HAEM2 = 15401;   // the second haematology analyser — transmits to nothing today
const PORT_CHEM1 = 15402;   // chemistry analyser 1 — transmits to nothing today
const PORT_LHIMS = 15500;   // stands in for the port the LHIMS client owns

/* ==========================================================================
   ASTM: what a Sysmex actually puts on the wire
   ======================================================================== */
const ENQ = 0x05, ACK = 0x06, EOT = 0x04, STX = 0x02, ETX = 0x03;

function astmFrame(n, text) {
  const body = Buffer.from(`${n % 8}${text}`, 'latin1');
  const withEtx = Buffer.concat([body, Buffer.from([ETX])]);
  let sum = 0; for (const b of withEtx) sum = (sum + b) & 0xff;
  return Buffer.concat([
    Buffer.from([STX]), withEtx,
    Buffer.from(`${sum.toString(16).toUpperCase().padStart(2, '0')}\r\n`, 'latin1'),
  ]);
}

/** Speak ASTM at a listening bridge, honouring the handshake it expects. */
function sendAstm(port, records) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let index = -1;         // -1 = waiting for the ACK to our ENQ
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('the bridge did not answer in time')); }, 8000);

    socket.on('connect', () => socket.write(Buffer.from([ENQ])));
    socket.on('data', chunk => {
      for (const byte of chunk) {
        if (byte !== ACK) continue;
        index++;
        if (index < records.length) socket.write(astmFrame(index + 1, records[index]));
        else {
          socket.write(Buffer.from([EOT]));
          clearTimeout(timer);
          setTimeout(() => { socket.end(); resolve(); }, 200);
          return;
        }
      }
    });
    socket.on('error', e => { clearTimeout(timer); reject(e); });
  });
}

/** Speak HL7 over MLLP. */
function sendHl7(port, message) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('no ACK from the bridge')); }, 8000);
    socket.on('connect', () => {
      socket.write(Buffer.concat([Buffer.from([0x0b]), Buffer.from(message, 'latin1'), Buffer.from([0x1c, 0x0d])]));
    });
    socket.on('data', chunk => {
      const text = chunk.toString('latin1');
      if (text.includes('MSA')) {
        clearTimeout(timer);
        setTimeout(() => { socket.end(); resolve(text); }, 100);
      }
    });
    socket.on('error', e => { clearTimeout(timer); reject(e); });
  });
}

/* ==========================================================================
   0. The scene: an LHIMS-owned link that must be left alone
   ======================================================================== */
console.log('\n[0] Recording the link LHIMS already owns, so the system knows to stay away');

const sections = (await j('/sections', { token: A })).json ?? [];
const sectionId = sections.find(s => /haemat/i.test(s.name))?.id ?? sections[0]?.id;

const haem1 = (await j('/equipment', { token: A, method: 'POST', body: {
  name: `Sysmex XN-550 (LHIMS) ${stamp}`, equipmentCategory: 'analyser', sectionId, status: 'operational',
} })).json?.id;
const haem2 = (await j('/equipment', { token: A, method: 'POST', body: {
  name: `Sysmex XN-330 (second) ${stamp}`, equipmentCategory: 'analyser', sectionId, status: 'operational',
} })).json?.id;
const chem1 = (await j('/equipment', { token: A, method: 'POST', body: {
  name: `Selectra Pro S ${stamp}`, equipmentCategory: 'analyser', sectionId, status: 'operational',
} })).json?.id;

const lhimsLink = await j('/instrument-links', { token: A, method: 'POST', body: {
  name: `Haematology 1 — LHIMS ${stamp}`, equipmentId: haem1, sectionId,
  profileKey: 'sysmex_xn', role: 'lhims_owned', mode: 'server', protocol: 'astm',
  listenPort: PORT_LHIMS, remoteHost: '10.10.0.9', remotePort: PORT_LHIMS,
} });
check('the LHIMS-owned link can be recorded', lhimsLink.status === 201, JSON.stringify(lhimsLink.json)?.slice(0, 160));
check('and the bridge marks it as left alone rather than running',
  lhimsLink.json?.state === 'blocked', `${lhimsLink.json?.state}`);
check('saying plainly why', /LHIMS/i.test(String(lhimsLink.json?.state_detail ?? '')), lhimsLink.json?.state_detail);
// On the row that matters most, "running" must never be shown next to a link
// the bridge has deliberately not opened.
check('and never reports itself as running', lhimsLink.json?.running === false, `running=${lhimsLink.json?.running}`);

/* ==========================================================================
   1. The safety rules, attacked directly
   ======================================================================== */
console.log('\n[1] Trying to disturb the working link — every one of these must be refused');

const started = await j(`/instrument-links/${lhimsLink.json.id}/start`, { token: A, method: 'POST' });
check('starting an LHIMS-owned link is refused', started.status === 400, `${started.status}`);
check('and the refusal explains the risk',
  /working today|disturb|not open/i.test(String(started.json?.error ?? '')), started.json?.error);

const portTheft = await j('/instrument-links', { token: A, method: 'POST', body: {
  name: `Port thief ${stamp}`, role: 'sechlims_only', mode: 'server', protocol: 'astm', listenPort: PORT_LHIMS,
} });
check('a second link cannot take the port LHIMS is using', portTheft.status === 400, `${portTheft.status}`);
check('and is told which link owns it',
  /LHIMS|owns/i.test(String(portTheft.json?.error ?? '')), portTheft.json?.error);

const dialTheft = await j('/instrument-links', { token: A, method: 'POST', body: {
  name: `Dial thief ${stamp}`, role: 'sechlims_only', mode: 'client', protocol: 'astm',
  remoteHost: '10.10.0.9', remotePort: PORT_LHIMS,
} });
check('nor dial the analyser LHIMS is connected to', dialTheft.status === 400, `${dialTheft.status}`);
check('because a second host connection can drop the first',
  /one host connection|drop/i.test(String(dialTheft.json?.error ?? '')), dialTheft.json?.error);

const doubleSend = await j('/instrument-links', { token: A, method: 'POST', body: {
  name: `Double sender ${stamp}`, role: 'lhims_owned', mode: 'server', protocol: 'astm',
  listenPort: 15599, forwardEnabled: true, forwardHost: '10.10.0.5', forwardPort: 5000,
} });
check('forwarding to LHIMS from a link LHIMS already has is refused', doubleSend.status === 400, `${doubleSend.status}`);
check('because it would send the same result twice',
  /twice/i.test(String(doubleSend.json?.error ?? '')), doubleSend.json?.error);

/* ==========================================================================
   2. The second haematology analyser — pure gain, nothing existing touched
   ======================================================================== */
console.log('\n[2] The second haematology analyser, which transmits to nothing today');

const haemLink = await j('/instrument-links', { token: A, method: 'POST', body: {
  name: `Haematology 2 ${stamp}`, equipmentId: haem2, sectionId,
  profileKey: 'sysmex_xn', role: 'sechlims_only', mode: 'server', protocol: 'astm',
  listenPort: PORT_HAEM2, controlPatterns: ['QC', 'QC1', 'QC2', 'XbarM'],
} });
check('it can be given its own link on its own port', haemLink.status === 201, JSON.stringify(haemLink.json)?.slice(0, 160));
await wait(400);
const haemState = (await j('/instrument-links', { token: A })).json?.find(l => l.id === haemLink.json.id);
check('and the bridge is listening for it', haemState?.state === 'listening', `${haemState?.state}: ${haemState?.state_detail}`);

// A patient sample, exactly as a Sysmex sends one.
await sendAstm(PORT_HAEM2, [
  'H|\\^&|||XN-550^1.0|||||||P|1|20260829103000',
  'P|1||||^^||||||||||||||||||||||||||',
  'O|1|SC260829-0142||^^^^FBC|R||20260829102800|||||||||||||||||F',
  'R|1|^^^WBC|6.21|10*3/uL||N||F||||20260829102900',
  'R|2|^^^RBC|4.55|10*6/uL||N||F||||20260829102900',
  'R|3|^^^HGB|13.4|g/dL||N||F||||20260829102900',
  'R|4|^^^PLT|248|10*3/uL||N||F||||20260829102900',
  'L|1|N',
]);
await wait(600);

let messages = (await j(`/instrument-links/${haemLink.json.id}/messages`, { token: A })).json ?? [];
const patient = messages.find(m => m.sample_id === 'SC260829-0142');
check('a patient transmission is received and recorded', Boolean(patient), `${messages.length} message(s)`);
check('with all four results read', patient?.result_count === 4, `${patient?.result_count}`);
check('and is NOT mistaken for a control', patient?.kind === 'patient', patient?.kind);
check('the analyser\'s mnemonics are mapped to the system\'s analytes',
  patient?.parsed_values?.some(v => v.code === 'HGB' && v.analyte === 'Haemoglobin'),
  JSON.stringify(patient?.parsed_values?.map(v => `${v.code}->${v.analyte}`)));

// The same analyser, running its control.
await sendAstm(PORT_HAEM2, [
  'H|\\^&|||XN-550^1.0|||||||P|1|20260829080000',
  'P|1||||QC2^^||||||||||||||||||||||||||',
  'O|1|QC2||^^^^FBC|R||20260829075500|||||||||||||||||F',
  'R|1|^^^WBC|7.24|10*3/uL||N||F||||20260829075800',
  'R|2|^^^HGB|13.6|g/dL||N||F||||20260829075800',
  'R|3|^^^PLT|251|10*3/uL||N||F||||20260829075800',
  'C|1|I|QC LOT HC26041|G',
  'L|1|N',
]);
await wait(600);

messages = (await j(`/instrument-links/${haemLink.json.id}/messages`, { token: A })).json ?? [];
const control = messages.find(m => m.sample_id === 'QC2');
check('a control transmission is recognised as a control', control?.kind === 'control', control?.kind);
check('and its lot is picked out of the comment record', control?.lot_number === 'HC26041', control?.lot_number);

const waiting = (await j('/iqc/portal/feed-messages', { token: A })).json ?? [];
const parked = waiting.find(m => m.sample_id === 'QC2');
check('it is parked on the IQC bench, not accepted behind anybody\'s back',
  Boolean(parked) && parked.status !== 'accepted', `${parked?.status}`);
check('and says why it could not be matched to a control material',
  parked?.status === 'unmatched' && /no active control material/i.test(String(parked?.status_note ?? '')),
  parked?.status_note);

/* ==========================================================================
   3. The chemistry analyser — the one LHIMS never supported
   ======================================================================== */
console.log('\n[3] A chemistry analyser, which the LHIMS middleware was never written for');

const chemLink = await j('/instrument-links', { token: A, method: 'POST', body: {
  name: `Chemistry 1 ${stamp}`, equipmentId: chem1, sectionId,
  profileKey: 'selectra_pro', role: 'sechlims_only', mode: 'server', protocol: 'astm',
  listenPort: PORT_CHEM1,
} });
check('it gets its own link too', chemLink.status === 201);
await wait(400);

await sendAstm(PORT_CHEM1, [
  'H|\\^&|||Selectra ProS^2.1|||||||P|1|20260829094500',
  'O|1|CTRL-NORM||^^^^CHEM|R||20260829094000|||||||||||||||||F',
  'R|1|^^^GLU|5.4|mmol/L||N||F',
  'R|2|^^^CREA|88|umol/L||N||F',
  'R|3|^^^ALT|31|U/L||N||F',
  'L|1|N',
]);
await wait(600);

const chemMessages = (await j(`/instrument-links/${chemLink.json.id}/messages`, { token: A })).json ?? [];
check('chemistry results arrive', chemMessages.length >= 1, `${chemMessages.length}`);
check('mapped through the chemistry profile',
  chemMessages[0]?.parsed_values?.some(v => v.code === 'CREA' && v.analyte === 'Creatinine'),
  JSON.stringify(chemMessages[0]?.parsed_values?.map(v => `${v.code}->${v.analyte}`)));
check('and CTRL-NORM is read as a control', chemMessages[0]?.kind === 'control', chemMessages[0]?.kind);

// The haematology link must be entirely unaffected by anything chemistry did.
const haemAfter = (await j('/instrument-links', { token: A })).json?.find(l => l.id === haemLink.json.id);
check('the haematology link is untouched by the chemistry one',
  haemAfter?.state === 'listening' || haemAfter?.state === 'connected', `${haemAfter?.state}`);
check('both analysers are live at the same time — the thing LHIMS cannot do',
  ['listening', 'connected'].includes(haemAfter?.state)
  && ['listening', 'connected'].includes((await j('/instrument-links', { token: A })).json?.find(l => l.id === chemLink.json.id)?.state));

/* ==========================================================================
   4. HL7, for the newer analysers
   ======================================================================== */
console.log('\n[4] An HL7 analyser');

const hl7Link = await j('/instrument-links', { token: A, method: 'POST', body: {
  name: `Mindray BC-5800 ${stamp}`, sectionId, profileKey: 'mindray_bc5800',
  role: 'sechlims_only', mode: 'server', protocol: 'hl7', listenPort: 15403,
} });
check('an HL7 link starts', hl7Link.status === 201);
await wait(400);

const ack = await sendHl7(15403, [
  'MSH|^~\\&|Mindray|BC-5800|SECHLIMS|LAB|20260829110000||ORU^R01|MSG00021|P|2.3.1',
  'PID|1||QC1||Control^Level1',
  'OBR|1||QC1|00001^Automated Count^99MRC|||20260829105500',
  'OBX|1|NM|6690-2^WBC^LN||7.15|10*9/L|4.0-10.0|N|||F',
  'OBX|2|NM|718-7^HGB^LN||13.2|g/dL|11.0-16.0|N|||F',
  'OBX|3|NM|777-3^PLT^LN||245|10*9/L|150-400|N|||F',
].join('\r'));
check('the analyser gets its HL7 acknowledgement', /MSA\|AA/.test(ack), ack.slice(0, 80));
await wait(600);

const hl7Messages = (await j(`/instrument-links/${hl7Link.json.id}/messages`, { token: A })).json ?? [];
check('the HL7 message is read', hl7Messages.length >= 1, `${hl7Messages.length}`);
check('its three results are picked out', hl7Messages[0]?.result_count === 3, `${hl7Messages[0]?.result_count}`);
check('the OBX identifiers map to analytes',
  hl7Messages[0]?.parsed_values?.some(v => v.analyte === 'Haemoglobin'),
  JSON.stringify(hl7Messages[0]?.parsed_values?.map(v => `${v.code}->${v.analyte}`)));
check('and QC1 is read as a control', hl7Messages[0]?.kind === 'control', hl7Messages[0]?.kind);

/* ==========================================================================
   5. Proving a mapping before trusting it
   ======================================================================== */
console.log('\n[5] Trying a transmission without an analyser in the room');

const dry = await j(`/instrument-links/${haemLink.json.id}/simulate`, { token: A, method: 'POST', body: {
  text: [
    'H|\\^&|||XN-550^1.0|||||||P|1|20260829120000',
    'O|1|QC1||^^^^FBC|R||20260829115500|||||||||||||||||F',
    'R|1|^^^HGB|13.9|g/dL||N||F',
    'R|2|^^^WEIRDCODE|42|x||N||F',
    'L|1|N',
  ].join('\r\n'),
} });
check('a pasted transmission can be tried without recording anything', dry.status === 200);
check('it says what each code would become',
  dry.json?.messages?.[0]?.results?.some(r => r.code === 'HGB' && r.analyte === 'Haemoglobin' && r.mapped === true));
check('and shows an unrecognised code as itself rather than inventing a name',
  dry.json?.messages?.[0]?.results?.some(r => r.code === 'WEIRDCODE' && r.analyte === 'WEIRDCODE' && r.mapped === false));
check('it says whether the message would be treated as a control',
  dry.json?.messages?.[0]?.wouldBeTreatedAs === 'control', dry.json?.messages?.[0]?.wouldBeTreatedAs);

const before = (await j(`/instrument-links/${haemLink.json.id}/messages`, { token: A })).json?.length ?? 0;
await j(`/instrument-links/${haemLink.json.id}/simulate`, { token: A, method: 'POST', body: { text: 'H|\\^&|||X|||||||P|1\rL|1|N' } });
const after = (await j(`/instrument-links/${haemLink.json.id}/messages`, { token: A })).json?.length ?? 0;
check('trying a message really does not record one', before === after, `${before} then ${after}`);

/* ==========================================================================
   6. Telling a control from a patient
   ======================================================================== */
console.log('\n[6] The distinction everything rests on');

const boundary = await j(`/instrument-links/${haemLink.json.id}/simulate`, { token: A, method: 'POST', body: {
  text: [
    'H|\\^&|||XN|||||||P|1',
    'O|1|SC2024QCX0031||^^^^FBC|R||20260829120000|||||||||||||||||F',
    'R|1|^^^HGB|12.1|g/dL||N||F',
    'L|1|N',
  ].join('\r\n'),
} });
check('a patient sample whose number merely CONTAINS "QC" is not swept into the QC record',
  boundary.json?.messages?.[0]?.wouldBeTreatedAs === 'patient',
  `${boundary.json?.messages?.[0]?.wouldBeTreatedAs} for SC2024QCX0031`);

const hyphenated = await j(`/instrument-links/${haemLink.json.id}/simulate`, { token: A, method: 'POST', body: {
  text: ['H|\\^&|||XN|||||||P|1', 'O|1|QC-2||^^^^FBC|R||20260829120000|||||||||||||||||F', 'R|1|^^^HGB|13.0|g/dL||N||F', 'L|1|N'].join('\r\n'),
} });
check('but one genuinely named QC-2 is', hyphenated.json?.messages?.[0]?.wouldBeTreatedAs === 'control',
  `${hyphenated.json?.messages?.[0]?.wouldBeTreatedAs} for QC-2`);

/* ==========================================================================
   7. Stopping cleanly
   ======================================================================== */
console.log('\n[7] Stopping');

for (const id of [haemLink.json.id, chemLink.json.id, hl7Link.json.id]) {
  await j(`/instrument-links/${id}/stop`, { token: A, method: 'POST' });
}
await wait(300);
const stopped = (await j('/instrument-links', { token: A })).json ?? [];
check('every link we started is stopped',
  [haemLink.json.id, chemLink.json.id, hl7Link.json.id].every(id => stopped.find(l => l.id === id)?.running === false));
check('and the LHIMS-owned link is still exactly where it was: left alone',
  stopped.find(l => l.id === lhimsLink.json.id)?.state === 'blocked');

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
