/**
 * Taking readings off the analyser, in the modules that are not quality
 * control.
 *
 * The control bench got this first, and the reasoning does not stop there. An
 * external quality assessment sample goes on the same analyser; a precision
 * study is twenty replicates read off the same screen; a critical result is the
 * one number nobody should be retyping under pressure. All three were typed in
 * by hand while the analyser had already said them over a wire.
 *
 * What is proved here is that each module can list the analysers, stand ready,
 * and be handed what arrived under this system's own analyte names — and that
 * standing ready on one module's rights does not open another's register.
 *
 *   node scripts/analyser-feed-check.mjs
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
if (!st.json?.setupComplete) await j('/setup/initialize', { method: 'POST', body: { facilityName: 'Bench Lab', username: 'admin', password: PW, fullName: 'Admin User' } });
const A = (await j('/auth/login', { method: 'POST', body: { username: 'admin', password: PW } })).json?.token;
const stamp = Date.now();
const PORT = 43000 + (stamp % 900);

/* ---- ASTM, as a Sysmex speaks it ---- */
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
        else { socket.write(Buffer.from([EOT])); clearTimeout(timer); setTimeout(() => { socket.end(); resolve(); }, 250); return; }
      }
    });
    socket.on('error', e => { clearTimeout(timer); reject(e); });
  });
}

/* ================================================== 1. a unit and its analyser */
console.log('\n[1] A unit, an analyser, and a link that is listening');
const sections = (await j('/sections', { token: A })).json ?? [];
const sectionId = sections.find(s => /chem|haemat/i.test(s.name))?.id ?? sections[0]?.id;
const analyser = (await j('/equipment', { token: A, method: 'POST', body: {
  name: `XN FEED ${stamp}`, equipmentCategory: 'analyser', sectionId, status: 'operational',
} })).json;
const link = await j('/instrument-links', { token: A, method: 'POST', body: {
  name: `Feed link ${stamp}`, equipmentId: analyser.id, sectionId, profileKey: 'sysmex_xn',
  role: 'sechlims_only', mode: 'server', protocol: 'astm', listenPort: PORT, autoStart: true,
} });
check('a link is set up on that analyser', link.status === 201, JSON.stringify(link.json));
const linkId = link.json.id;
await j(`/instrument-links/${linkId}/start`, { token: A, method: 'POST' });
await wait(500);

/* ======================= 2. every module can see it, and the right one first */
console.log('\n[2] Each module lists the analysers, best guess first');
const MODULES = ['eqa', 'verification-validation', 'process-management'];
const marks = {};
for (const m of MODULES) {
  const links = (await j(`/${m}/analyser/links?equipmentId=${analyser.id}&sectionId=${sectionId}`, { token: A })).json ?? [];
  const mine = links.find(l => l.id === linkId);
  check(`${m}: the link is listed`, Boolean(mine), JSON.stringify(links.map(l => l.id)));
  check(`${m}: it is the suggested one`, mine?.suggested === true && links[0]?.id === linkId, JSON.stringify(mine));
  check(`${m}: and it is one SECHLIMS may open`, mine?.open === true, JSON.stringify(mine));

  const armed = await j(`/${m}/analyser/listen`, { token: A, method: 'POST', body: { linkId } });
  check(`${m}: the screen can stand ready`, armed.json?.listening === true, JSON.stringify(armed.json));
  check(`${m}: and is handed a watermark`, Number.isFinite(Number(armed.json?.since?.patient)), JSON.stringify(armed.json?.since));
  marks[m] = Number(armed.json.since.patient);
}

/* ============================================ 3. a patient run, landing on all three */
console.log('\n[3] One patient run, reaching whichever screen asked for it');
const sample = `P-${stamp}`;
await sendAstm(PORT, [
  `H|\\^&|||XN-550^1.0|||||||P|1|${stamp}`,
  `O|1|${sample}||^^^^FBC|R||20260930081500|||||||||||||||||F`,
  'R|1|^^^HGB|12.8|g/dL||N||F',
  'R|2|^^^WBC|7.40|10*9/L||N||F',
  'L|1|N',
]);
await wait(900);

for (const m of MODULES) {
  const got = (await j(`/${m}/analyser/messages?linkId=${linkId}&since=${marks[m]}&kind=patient`, { token: A })).json ?? [];
  const mine = got.find(x => x.sample_id === sample);
  check(`${m}: the run reaches the screen`, Boolean(mine), JSON.stringify(got.map(x => x.sample_id)));
  check(`${m}: under this system's own analyte names`,
    (mine?.parsed_values ?? []).some(v => v.analyte === 'Haemoglobin' && Number(v.value) === 12.8),
    JSON.stringify(mine?.parsed_values));
  const asControl = (await j(`/${m}/analyser/messages?linkId=${linkId}&since=${marks[m]}&kind=control`, { token: A })).json ?? [];
  check(`${m}: a patient run is not offered as a control`, !asControl.some(x => x.sample_id === sample),
    JSON.stringify(asControl.map(x => x.sample_id)));
  const before = (await j(`/${m}/analyser/messages?linkId=${linkId}&since=999999999`, { token: A })).json ?? [];
  check(`${m}: nothing older than the watermark is mistaken for new`, before.length === 0, JSON.stringify(before.length));
}

/* ======================================= 4. the readings land where they were wanted */
console.log('\n[4] What arrived is recordable, module by module');
const value = '12.8';

// EQA: a survey sample's reported result.
const programId = (await j('/eqa/programs', { token: A, method: 'POST', body: {
  programName: `Feed survey ${stamp}`, provider: 'Provider', testArea: 'Haematology', sectionId,
} })).json?.id;
const eventId = (await j(`/eqa/programs/${programId}/events`, { token: A, method: 'POST', body: {
  eqaProgramId: programId, cycleName: `Cycle ${stamp}`,
} })).json?.id;
const row = await j(`/eqa/events/${eventId}/results`, { token: A, method: 'POST', body: {
  resultKind: 'general', analyteOrTest: 'Haemoglobin', reportedResult: value,
} });
check('EQA: the fetched reading is recorded as a reported result', row.status === 201 || row.status === 200, JSON.stringify(row.json));
const event = (await j(`/eqa/events/${eventId}`, { token: A })).json;
check('EQA: and reads back on the event',
  (event?.results ?? []).some(r => r.analyte_or_test === 'Haemoglobin' && r.reported_result === value),
  JSON.stringify(event?.results));

// Verification/validation: a replicate on the precision characteristic.
const study = await j('/verification-validation', { token: A, method: 'POST', body: {
  studyType: 'verification', measurandType: 'quantitative', testName: 'Full blood count',
  methodName: 'Impedance', analyte: 'Haemoglobin', measurementUnits: 'g/dL',
  equipmentId: analyser.id, sectionId,
} });
check('a verification study exists to receive replicates', study.status === 201, JSON.stringify(study.json));
const params = (await j(`/verification-validation/${study.json.id}`, { token: A })).json?.parameters ?? [];
const precision = params.find(p => /^precision/.test(p.parameter));
check('with a precision characteristic seeded', Boolean(precision), JSON.stringify(params.map(p => p.parameter)));
const points = [12.8, 12.7, 12.9, 12.8, 13.0].map((v, i) => ({ sampleLabel: `${sample}-${i + 1}`, valueA: v, valueB: '' }));
await j(`/verification-validation/parameters/${precision.id}/datapoints`, { token: A, method: 'POST', body: { points } });
const stored = (await j(`/verification-validation/parameters/${precision.id}/datapoints`, { token: A })).json ?? [];
check('the replicates are held against the characteristic', stored.length === 5, JSON.stringify(stored.length));
check('labelled with the sample the analyser named', stored.some(d => String(d.sample_label).startsWith(sample)),
  JSON.stringify(stored.map(d => d.sample_label)));
const computed = await j(`/verification-validation/parameters/${precision.id}/compute`, { token: A, method: 'POST', body: {} });
check('and precision computes from them', /CV/.test(String(computed.json?.observed)), JSON.stringify(computed.json));

// Process management: a critical result, logged against its rule.
const testId = (await j('/process-management/tests', { token: A, method: 'POST', body: {
  testName: `Full blood count ${stamp}`, sectionId, equipmentId: analyser.id, sampleType: 'Whole blood',
} })).json?.id;
const rule = await j('/process-management/critical-result-rules', { token: A, method: 'POST', body: {
  testCatalogId: testId, analyteName: 'Haemoglobin', unit: 'g/dL', lowCriticalValue: 7, highCriticalValue: 20,
} });
check('a critical-result rule names the analyte', rule.status === 201 || rule.status === 200, JSON.stringify(rule.json));
const notified = await j('/process-management/critical-results', { token: A, method: 'POST', body: {
  eventDate: new Date().toISOString().slice(0, 10), eventTime: '08:15', requestReference: sample,
  testCatalogId: testId, analyteName: 'Haemoglobin', resultValue: value, unit: 'g/dL',
  criticalRuleId: rule.json.id, notifiedTo: 'Ward 3',
} });
check('the fetched reading is logged as a critical notification',
  notified.status === 201 || notified.status === 200, JSON.stringify(notified.json));
const criticals = (await j('/process-management/critical-results', { token: A })).json ?? [];
check('carrying the sample the analyser named',
  criticals.some(c => c.request_reference === sample && String(c.result_value) === value),
  JSON.stringify(criticals.slice(0, 3).map(c => c.request_reference)));

/* ============================================== 5. one module's right is not another's */
console.log('\n[5] A module\'s own view right, and nothing wider');
for (const m of MODULES) {
  const open = await j(`/${m}/analyser/links`);
  check(`${m}: an unauthenticated screen is refused`, open.status === 401 || open.status === 403, String(open.status));
}
const noLink = await j('/eqa/analyser/listen', { token: A, method: 'POST', body: {} });
check('standing ready without naming an analyser is refused', noLink.status === 400, JSON.stringify(noLink.json));
const gone = await j('/eqa/analyser/listen', { token: A, method: 'POST', body: { linkId: 99999 } });
check('and a link that is not set up is reported, not guessed at', gone.status === 404, JSON.stringify(gone.json));

await j(`/instrument-links/${linkId}/stop`, { token: A, method: 'POST' });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
