/**
 * Taking a control's results off the analyser, and knowing why nothing arrives.
 *
 * Two questions this exists to settle.
 *
 * The first is the one the bench asks: the analyser has just run the control,
 * so why am I typing twenty-three numbers off a printout? The option to take
 * them has to appear wherever the control is run — and ONLY where an analyser
 * is actually attached, because a button that cannot do anything teaches people
 * the feature is broken.
 *
 * The second is the one that loses an afternoon: a link is set up, the screen
 * says "listening", and nothing ever comes through. The commonest cause is the
 * safety rule doing exactly its job — a link recorded as LHIMS's is never
 * opened — and nothing said so. The checks here have to name it, and name the
 * remedy.
 *
 *   node scripts/iqc-analyser-check.mjs
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

const st = await j('/setup/status');
if (!st.json?.setupComplete) await j('/setup/initialize', { method: 'POST', body: { facilityName: 'Analyser Lab', username: 'admin', password: PW, fullName: 'Admin User' } });
const A = (await j('/auth/login', { method: 'POST', body: { username: 'admin', password: PW } })).json?.token;
const day = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const stamp = Date.now();
const PORT = 41000 + (stamp % 900);

/* ---------------------------------------------------- ASTM, as a Sysmex speaks it */
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
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let index = -1;
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
          setTimeout(() => { socket.end(); resolve(); }, 250);
          return;
        }
      }
    });
    socket.on('error', e => { clearTimeout(timer); reject(e); });
  });
}
const wait = ms => new Promise(r => setTimeout(r, ms));

/* ===================================================== 1. no analyser at all */
console.log('\n[1] A control with no analyser says so, rather than offering a button that cannot work');
const bare = await j('/iqc/materials', { token: A, method: 'POST', body: {
  materialName: `Manual control ${stamp}`, testName: 'Manual method', lotNumber: `MAN-${stamp}`,
  source: 'commercial', controlType: 'quantitative', qcFrequency: 'daily',
  analytes: [{ analyte: 'Haemoglobin', unit: 'g/dL', targetMean: 13.5, targetSd: 0.4 }],
} });
const bareStatus = await j(`/iqc/materials/${bare.json.id}/analyser`, { token: A });
check('a control with no instrument is not linked', bareStatus.json?.linked === false);
// A manual control has no instrument, so "no link is set up on this system" was
// the wrong complaint about the wrong thing. The remedy is to say which machine
// it runs on — if indeed it runs on one.
check('and says why, naming the remedy rather than the symptom',
  /Set the instrument on the control|link is registered against/.test(String(bareStatus.json?.why ?? '')),
  bareStatus.json?.why);

/* ======================================== 2. an analyser the bridge will not open */
console.log('\n[2] The link LHIMS owns: the safety rule says so out loud');
const equipment = await j('/equipment', { token: A, method: 'POST', body: {
  name: `Sysmex XN-550 ${stamp}`, equipmentCategory: 'analyser', status: 'operational',
} });
const blocked = await j('/instrument-links', { token: A, method: 'POST', body: {
  name: `Haematology 1 ${stamp}`, equipmentId: equipment.json.id, profileKey: 'sysmex_xn',
  role: 'lhims_owned', mode: 'server', protocol: 'astm', listenPort: PORT + 500, autoStart: false,
} });
check('the link is recorded', blocked.status === 201, JSON.stringify(blocked.json));

const blockedChecks = await j(`/instrument-links/${blocked.json.id}/checks`, { token: A });
const opens = blockedChecks.json?.checks?.find(c => c.key === 'opens');
check('the checks say SECHLIMS will not open it', opens?.status === 'todo', JSON.stringify(opens));
check('and name the remedy', String(opens?.fix ?? '').includes('follow the LHIMS client'));
check('and the verdict is not "transmitting"', blockedChecks.json?.transmitting === false);

const blockedMaterial = await j('/iqc/materials', { token: A, method: 'POST', body: {
  materialName: `Blocked control ${stamp}`, testName: 'Full blood count', lotNumber: `BLK-${stamp}`,
  source: 'commercial', controlType: 'quantitative', qcFrequency: 'daily', equipmentId: equipment.json.id,
  analytes: [{ analyte: 'Haemoglobin', unit: 'g/dL', targetMean: 13.5, targetSd: 0.4 }],
} });
const blockedStatus = await j(`/iqc/materials/${blockedMaterial.json.id}/analyser`, { token: A });
check('the control still reports the analyser', blockedStatus.json?.linked === true);
check('but says it is one nothing will arrive on', blockedStatus.json?.source?.open === false);

/* ================================================= 3. an analyser that transmits */
console.log('\n[3] An analyser transmitting to nothing today: SECHLIMS takes it');
const analyser = await j('/equipment', { token: A, method: 'POST', body: {
  name: `Sysmex XN-330 ${stamp}`, equipmentCategory: 'analyser', status: 'operational',
} });
const link = await j('/instrument-links', { token: A, method: 'POST', body: {
  name: `Haematology 2 ${stamp}`, equipmentId: analyser.json.id, profileKey: 'sysmex_xn',
  role: 'sechlims_only', mode: 'server', protocol: 'astm', listenPort: PORT, autoStart: true,
} });
check('the link is opened', link.status === 201, JSON.stringify(link.json));
await j(`/instrument-links/${link.json.id}/start`, { token: A, method: 'POST' });
await wait(500);

const selfTest = await j(`/instrument-links/${link.json.id}/self-test`, { token: A, method: 'POST' });
check('the port really is open, tested rather than asserted', selfTest.json?.ok === true, JSON.stringify(selfTest.json));

const host = await j('/instrument-links/host', { token: A });
check('the address to set the analyser to is available', Array.isArray(host.json?.addresses));

const control = await j('/iqc/materials', { token: A, method: 'POST', body: {
  materialName: `Linked FBC ${stamp}`, testName: 'Full blood count', lotNumber: `LNK-${stamp}`,
  source: 'commercial', controlType: 'quantitative', qcFrequency: 'daily', equipmentId: analyser.json.id,
  analytes: [
    { analyte: 'Haemoglobin', unit: 'g/dL', targetMean: 13.5, targetSd: 0.4, decimalPlaces: 1 },
    { analyte: 'WBC', unit: '10^9/L', targetMean: 6.2, targetSd: 0.5, decimalPlaces: 2 },
  ],
} });
const controlId = control.json.id;

const linked = await j(`/iqc/materials/${controlId}/analyser`, { token: A });
check('the control reports its analyser', linked.json?.linked === true);
check('and that it is one SECHLIMS opens', linked.json?.source?.open === true);
check('with nothing waiting yet', (linked.json?.waiting ?? []).length === 0);

/* ------------------------------- the analyser sends a control run, and a patient */
await sendAstm(PORT, [
  `H|\\^&|||XN-330^1.0|||||||P|1|${stamp}`,
  // A sample identifier of this suite's own, so running the suites one after
  // another against one database cannot make two of them argue over "QC2".
  `O|1|QC-RETAIN-${stamp}|${`LNK-${stamp}`}|^^^^FBC|R||20260930080000|||||||||||||||||F`,
  'R|1|^^^HGB|13.6|g/dL||N||F',
  'R|2|^^^WBC|6.10|10*9/L||N||F',
  'L|1|N',
]);
await sendAstm(PORT, [
  `H|\\^&|||XN-330^1.0|||||||P|1|${stamp}`,
  `O|1|SC2026-${stamp % 10000}||^^^^FBC|R||20260930081500|||||||||||||||||F`,
  'R|1|^^^HGB|11.8|g/dL||L||F',
  'R|2|^^^WBC|8.40|10*9/L||N||F',
  'L|1|N',
]);
await wait(700);

const afterSend = await j(`/iqc/materials/${controlId}/analyser`, { token: A });
check('the control run is waiting on the control', (afterSend.json?.waiting ?? []).length > 0,
  JSON.stringify(afterSend.json?.waiting));
const waitingMessage = (afterSend.json?.waiting ?? [])[0];
check('and it is the QC sample, not the patient one', String(waitingMessage?.sample_id ?? '').toUpperCase().includes('QC'));

const mapped = await j(`/iqc/materials/${controlId}/analyser/messages/${waitingMessage.id}/map`, { token: A });
check('its readings line up with the control’s own parameters', mapped.json?.matched === 2, JSON.stringify(mapped.json?.readings));
const hbReading = (mapped.json?.readings ?? []).find(r => r.analyte === 'Haemoglobin');
check('haemoglobin came through as haemoglobin, not as HGB', hbReading?.value === 13.6);
check('and nothing the control does not measure was invented', (mapped.json?.unmatchedLabels ?? []).length === 0);

/* -------------------------------- the patient result, for a previously run sample */
console.log('\n[4] The patient result the analyser sent, for enrolling as a previously run sample');
const samples = await j(`/iqc/materials/${controlId}/analyser/patient-samples`, { token: A });
check('patient results are held and offered', Array.isArray(samples.json) && samples.json.length > 0,
  JSON.stringify(samples.json));
const patient = (samples.json ?? [])[0];
check('the patient sample is named', patient?.sample_id === `SC2026-${stamp % 10000}`);
check('and its parameters carry this system’s names', (patient?.parsed_values ?? []).some(v => v.analyte === 'Haemoglobin'));
check('the control run is not offered as a previously run sample',
  !(samples.json ?? []).some(s => String(s.sample_id ?? '').toUpperCase().includes('QC')));

const analytes = (await j(`/iqc/materials/${controlId}/analytes`, { token: A })).json ?? [];
const hb = analytes.find(a => a.analyte === 'Haemoglobin');
const enrolled = await j('/iqc/retained-samples', { token: A, method: 'POST', body: {
  iqcMaterialId: controlId, sampleReference: patient.sample_id, originalRunDate: day(1),
  source: 'instrument', feedMessageId: null,
  values: [{ analyteId: hb.id, originalValue: (patient.parsed_values.find(v => v.analyte === 'Haemoglobin') ?? {}).value }],
} });
check('it enrols as a previously run sample', enrolled.status === 201, JSON.stringify(enrolled.json));
const enrolledDetail = (await j(`/iqc/retained-samples/${enrolled.json.id}`, { token: A })).json;
check('recorded as having come off the analyser', enrolledDetail?.source === 'instrument');
check('with the result the analyser actually gave', enrolledDetail?.values?.[0]?.original_value === 11.8);

/* ============ 4b. standing ready, and a transmission arriving while it waits */
console.log('\n[4b] Pressing Fetch stands ready, and the next transmission lands');
const armed = await j(`/iqc/materials/${controlId}/analyser/listen`, { token: A, method: 'POST' });
check('the door is opened', armed.json?.listening === true, JSON.stringify(armed.json));
check('and a watermark is handed back for each kind of message',
  Number(armed.json?.since?.control) > 0 && Number(armed.json?.since?.patient) > 0, JSON.stringify(armed.json?.since));

// Nothing new yet: what is already there must not be mistaken for what is coming.
const beforeControl = await j(`/iqc/materials/${controlId}/analyser?since=${armed.json.since.control}`, { token: A });
check('what arrived before is not offered as new', (beforeControl.json?.waiting ?? []).length === 0);
const beforePatient = await j(`/iqc/materials/${controlId}/analyser/patient-samples?since=${armed.json.since.patient}`, { token: A });
check('nor is the patient result from before', (beforePatient.json ?? []).length === 0);

// Now the analyser sends, as it would with somebody standing at it.
await sendAstm(PORT, [
  `H|\\^&|||XN-330^1.0|||||||P|1|${stamp}`,
  `O|1|QC-RETAIN-${stamp}-B|${`LNK-${stamp}`}|^^^^FBC|R||20260930090000|||||||||||||||||F`,
  'R|1|^^^HGB|13.7|g/dL||N||F',
  'R|2|^^^WBC|6.30|10*9/L||N||F',
  'L|1|N',
]);
await wait(900);

const afterArm = await j(`/iqc/materials/${controlId}/analyser?since=${armed.json.since.control}`, { token: A });
check('the new control run is picked up while waiting', (afterArm.json?.waiting ?? []).length === 1,
  JSON.stringify((afterArm.json?.waiting ?? []).map(w => w.sample_id)));
check('and it is the one just sent', String((afterArm.json?.waiting ?? [])[0]?.sample_id ?? '').endsWith('-B'));

await sendAstm(PORT, [
  `H|\\^&|||XN-330^1.0|||||||P|1|${stamp}`,
  `O|1|SC2026-${(stamp % 10000) + 1}||^^^^FBC|R||20260930091500|||||||||||||||||F`,
  'R|1|^^^HGB|12.2|g/dL||N||F',
  'L|1|N',
]);
await wait(900);
const patientAfter = await j(`/iqc/materials/${controlId}/analyser/patient-samples?since=${armed.json.since.patient}`, { token: A });
check('a patient result sent while waiting is picked up too', (patientAfter.json ?? []).length === 1,
  JSON.stringify((patientAfter.json ?? []).map(x => x.sample_id)));
check('and carries its readings, ready to fill the boxes',
  (patientAfter.json ?? [])[0]?.parsed_values?.some(v => v.analyte === 'Haemoglobin' && Number(v.value) === 12.2),
  JSON.stringify((patientAfter.json ?? [])[0]?.parsed_values));

// A link that is stopped is started by standing ready, or "waiting" is a lie.
await j(`/instrument-links/${link.json.id}/stop`, { token: A, method: 'POST' });
await wait(500);
const rearmed = await j(`/iqc/materials/${controlId}/analyser/listen`, { token: A, method: 'POST' });
check('standing ready starts a link that was stopped', rearmed.json?.listening === true, JSON.stringify(rearmed.json));
await wait(900);
const stateNow = String(((await j('/instrument-links', { token: A })).json ?? [])
  .find(l => l.id === link.json.id)?.state ?? '');
check('and it really is open again', ['listening', 'connected', 'following'].includes(stateNow), stateNow);

// One the bridge will never open must say so rather than appear to wait.
const blockedArm = await j(`/iqc/materials/${blockedMaterial.json.id}/analyser/listen`, { token: A, method: 'POST' });
check('a link LHIMS owns refuses to pretend it is waiting', blockedArm.json?.listening === false);
check('and says why', /LHIMS/.test(String(blockedArm.json?.note ?? '')), blockedArm.json?.note);


/* ======== 4c. one machine registered twice, and a machine that is not it */
/*
 * Two names for ONE machine is normal in a real register and must not cost the
 * bench its link. Two different machines is the opposite case, and offering one
 * for the other writes a control run against an analyser it was never run on —
 * which CLSI C24 (a mean, an SD and a chart per instrument) and ISO 15189
 * (comparability BETWEEN instruments) both depend on not happening.
 */
console.log('\n[4c] Two spellings of one machine, and a machine that is simply not it');

// The laboratory registered its machine twice under slightly different names —
// which is normal, and used to make the whole panel vanish.
const otherEquipment = await j('/equipment', { token: A, method: 'POST', body: {
  name: `SYSMEX XN330 ${stamp}`, equipmentCategory: 'analyser', status: 'operational',
} });
const mismatched = await j('/iqc/materials', { token: A, method: 'POST', body: {
  materialName: `Mismatched FBC ${stamp}`, testName: 'Full blood count', lotNumber: `MIS-${stamp}`,
  source: 'commercial', controlType: 'quantitative', qcFrequency: 'daily',
  equipmentId: otherEquipment.json.id,
  analytes: [{ analyte: 'Haemoglobin', unit: 'g/dL', targetMean: 13.5, targetSd: 0.4, decimalPlaces: 1 }],
} });
const mismatchedStatus = await j(`/iqc/materials/${mismatched.json.id}/analyser`, { token: A });
check('a second spelling of the same machine still finds its link',
  (mismatchedStatus.json?.options ?? []).some(o => o.id === link.json.id),
  JSON.stringify((mismatchedStatus.json?.options ?? []).map(o => o.name)));
check('and nothing belonging to another machine is offered beside it',
  (mismatchedStatus.json?.options ?? []).every(o => o.id === link.json.id),
  JSON.stringify((mismatchedStatus.json?.options ?? []).map(o => o.name)));

// A machine that is genuinely a different machine gets nothing at all.
const foreign = await j('/equipment', { token: A, method: 'POST', body: {
  name: `GeneXpert IV ${stamp}`, equipmentCategory: 'analyser', status: 'operational',
} });
const foreignControl = await j('/iqc/materials', { token: A, method: 'POST', body: {
  materialName: `MTB control ${stamp}`, testName: 'GeneXpert MTB', lotNumber: `GX-${stamp}`,
  source: 'commercial', controlType: 'quantitative', qcFrequency: 'daily',
  equipmentId: foreign.json.id,
  analytes: [{ analyte: 'Haemoglobin', unit: 'g/dL', targetMean: 13.5, targetSd: 0.4, decimalPlaces: 1 }],
} });
const foreignStatus = await j(`/iqc/materials/${foreignControl.json.id}/analyser`, { token: A });
check('a control on a different machine is offered no analyser at all',
  (foreignStatus.json?.options ?? []).length === 0,
  JSON.stringify((foreignStatus.json?.options ?? []).map(o => o.name)));
check('and is told which of the two things is missing',
  /link is registered against/i.test(String(foreignStatus.json?.why)), String(foreignStatus.json?.why));

// Saying which machine it is puts the panel back.
const chosen = await j(`/iqc/materials/${mismatched.json.id}/analyser?linkId=${link.json.id}`, { token: A });
check('choosing the analyser links it', chosen.json?.linked === true, JSON.stringify(chosen.json?.why));
check('and it is the one chosen', chosen.json?.source?.id === link.json.id);

// And it can be armed and fed, exactly like a matching one.
const chosenArm = await j(`/iqc/materials/${mismatched.json.id}/analyser/listen`,
  { token: A, method: 'POST', body: { linkId: link.json.id } });
check('and stood ready', chosenArm.json?.listening === true, JSON.stringify(chosenArm.json));

await sendAstm(PORT, [
  `H|\\^&|||XN-330^1.0|||||||P|1|${stamp}`,
  `O|1|QC-RETAIN-${stamp}-C|${`MIS-${stamp}`}|^^^^FBC|R||20260930100000|||||||||||||||||F`,
  'R|1|^^^HGB|13.55|g/dL||N||F',
  'L|1|N',
]);
await wait(900);
const chosenWaiting = await j(
  `/iqc/materials/${mismatched.json.id}/analyser?linkId=${link.json.id}&since=${chosenArm.json.since.control}`, { token: A });
check('the control run reaches the control being run',
  (chosenWaiting.json?.waiting ?? []).some(w => String(w.sample_id).endsWith('-C')),
  JSON.stringify((chosenWaiting.json?.waiting ?? []).map(w => w.sample_id)));
// The analyser sent no lot, so the system could only guess from the machine.
// It says which control it guessed, rather than hiding the run entirely.
check('and says plainly which control it was read as',
  Boolean((chosenWaiting.json?.waiting ?? []).find(w => String(w.sample_id).endsWith('-C'))?.matched_elsewhere),
  JSON.stringify((chosenWaiting.json?.waiting ?? []).map(w => w.matched_elsewhere)));

const cMessage = (chosenWaiting.json.waiting ?? []).find(w => String(w.sample_id).endsWith('-C'));
const mapped2 = await j(
  `/iqc/materials/${mismatched.json.id}/analyser/messages/${cMessage.id}/map`, { token: A });
check('and its reading fills the control\u2019s own box', mapped2.json?.readings?.[0]?.value === 13.55,
  JSON.stringify(mapped2.json?.readings));

// The instrument picked on the run form is the first guess, before anything else.
const byRunInstrument = await j(
  `/iqc/materials/${mismatched.json.id}/analyser?equipmentId=${analyser.json.id}`, { token: A });
check('the instrument chosen on the run decides which analyser is used',
  byRunInstrument.json?.source?.id === link.json.id, JSON.stringify(byRunInstrument.json?.source?.name));


/* ------------------------------------------------------- 5. the checks, once live */
console.log('\n[5] The checks on a link that is working');
const liveChecks = await j(`/instrument-links/${link.json.id}/checks`, { token: A });
check('it reports as transmitting', liveChecks.json?.transmitting === true, JSON.stringify(liveChecks.json?.checks?.filter(c => c.status === 'todo')));
check('with nothing outstanding', liveChecks.json?.outstanding === 0);
check('and counts what arrived by kind',
  liveChecks.json?.counts?.controls === 3 && liveChecks.json?.counts?.patients === 2,
  JSON.stringify(liveChecks.json?.counts));
const patientsCheck = liveChecks.json?.checks?.find(c => c.key === 'patients');
check('and says where patient results are going', String(patientsCheck?.detail ?? '').includes('previously run samples'));

const activity = await j(`/instrument-links/${link.json.id}/activity`, { token: A });
check('the stream shows every message', (activity.json?.recent ?? []).length === 5);
check('sorted by kind', activity.json?.byKind?.control === 3 && activity.json?.byKind?.patient === 2);

const fetched = await j(`/iqc/materials/${controlId}/analyser/fetch`, { token: A, method: 'POST' });
check('asking a listening link to fetch says plainly that it cannot',
  String(fetched.json?.note ?? '').includes('sends when it is ready'));

await j(`/instrument-links/${link.json.id}/stop`, { token: A, method: 'POST' });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
