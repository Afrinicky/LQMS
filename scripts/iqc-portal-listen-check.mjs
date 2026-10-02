/**
 * Pressing Fetch Results on the bench's own control run.
 *
 * It worked in the module and not on the portal, and the difference was in the
 * question each screen asked while it stood waiting.
 *
 * The module asks "what has arrived FOR THIS CONTROL" — matched to the control,
 * or on its link, or on its feed. The portal asked "what has arrived ON THIS
 * LINK", and the link it named was whichever one its picker had defaulted to.
 * A laboratory that registers one machine twice — "SYSMEX XN-550" for the link
 * and "Sysmex XN550" for the control, which this one does — has two links on
 * one instrument. The picker defaults to one; the analyser transmits down the
 * other; the run is parked against the control perfectly correctly, and the
 * poll standing there waiting for it filters it out by link id. The bench
 * presses the button, the analyser transmits, and the boxes stay empty.
 *
 *   node scripts/iqc-portal-listen-check.mjs
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
/** A control run, as a Sysmex sends one. */
const run = (stamp, id, hb) => ([
  `H|\\^&|||XN-550^1.0|||||||P|1|${stamp}`,
  `O|1|${id}|XN-${stamp}|^^^^FBC|R||||||Q||||||||||F`,
  `R|1|^^^^HGB|${hb}|g/dL||N||F||||20261002080000`,
  'R|2|^^^^WBC|3.30|10*9/L||N||F||||20261002080000',
  'L|1|N',
]);

const st = await j('/setup/status');
if (!st.json?.setupComplete) {
  await j('/setup/initialize', { method: 'POST', body: {
    facilityName: 'Bench Lab', username: 'admin', password: PW, fullName: 'Admin User',
  } });
}
const A = (await j('/auth/login', { method: 'POST', body: { username: 'admin', password: PW } })).json?.token;
const stamp = Date.now();
const PORT_A = 46000 + (stamp % 400);
const PORT_B = PORT_A + 500;

/* ============================ 1. one machine, registered twice, two links */
console.log('\n[1] One analyser, two equipment rows, a link on each — what this laboratory really has');
const sec = (await j('/section-config/sections', { token: A, method: 'POST', body: {
  name: `Bench ${stamp}`, code: `BN${String(stamp).slice(-6)}`,
} })).json;
const me = (await j('/auth/me', { token: A })).json?.user;
const staff = (await j('/staff', { token: A, method: 'POST', body: {
  fullName: `Scientist ${stamp}`, employeeNo: `E${stamp}`, sectionId: sec.id,
} })).json;
await j(`/users/${me.id}`, { token: A, method: 'PUT', body: { staffId: staff.id } });

// "SYSMEX XN-550" and "Sysmex XN550" are the same machine under two spellings.
const rowA = (await j('/equipment', { token: A, method: 'POST', body: {
  name: `SYSMEX XN-550 ${stamp}`, equipmentCategory: 'analyser', sectionId: sec.id, status: 'operational',
} })).json;
const rowB = (await j('/equipment', { token: A, method: 'POST', body: {
  name: `Sysmex XN550 ${stamp}`, equipmentCategory: 'analyser', sectionId: sec.id, status: 'operational',
} })).json;
check('the same analyser is registered twice, as this laboratory does',
  Boolean(rowA?.id) && Boolean(rowB?.id) && rowA.id !== rowB.id);

const linkA = (await j('/instrument-links', { token: A, method: 'POST', body: {
  name: `AAA host link ${stamp}`, equipmentId: rowA.id, sectionId: sec.id, profileKey: 'sysmex_xn',
  role: 'sechlims_only', mode: 'server', protocol: 'astm', listenPort: PORT_A, autoStart: true,
} })).json;
const linkB = (await j('/instrument-links', { token: A, method: 'POST', body: {
  name: `ZZZ bench link ${stamp}`, equipmentId: rowB.id, sectionId: sec.id, profileKey: 'sysmex_xn',
  role: 'sechlims_only', mode: 'server', protocol: 'astm', listenPort: PORT_B, autoStart: true,
} })).json;
await j(`/instrument-links/${linkA.id}/start`, { token: A, method: 'POST' });
await j(`/instrument-links/${linkB.id}/start`, { token: A, method: 'POST' });
await wait(800);
check('two links are registered on the one machine', Boolean(linkA?.id) && Boolean(linkB?.id));

const control = (await j('/iqc/materials', { token: A, method: 'POST', body: {
  materialName: `XN CHECK ${stamp}`, testName: 'Full blood count', lotNumber: `XN-${stamp}`,
  levelLabel: 'Level 1 (Low)', source: 'commercial', controlType: 'quantitative', qcFrequency: 'daily',
  sectionId: sec.id, equipmentId: rowB.id,
  analytes: [
    { analyte: 'Haemoglobin', unit: 'g/dL', targetMean: 6.2, targetSd: 0.2, decimalPlaces: 1 },
    { analyte: 'WBC', unit: '10^9/L', targetMean: 3.21, targetSd: 0.16, decimalPlaces: 2 },
  ],
} })).json;
check('the control is defined against one of the two rows', Boolean(control?.id));

const detail = (await j(`/iqc/portal/controls/${control.id}`, { token: A })).json;
const options = detail?.feedOptions ?? [];
check('the bench is offered both links for its one machine', options.length === 2,
  JSON.stringify(options.map(o => o.name)));

/* ====================== 2. the bench stands ready, the analyser uses the other link */
console.log('\n[2] The bench stands ready on the link its picker chose; the analyser sends down the other');
// What the screen does: the first open link is the default.
const chosen = options.find(o => o.open) ?? options[0];
const other = options.find(o => o.id !== chosen?.id);
check('the picker defaults to one of them, and there is another', Boolean(chosen) && Boolean(other),
  JSON.stringify([chosen?.name, other?.name]));

const armed = await j(`/iqc/portal/controls/${control.id}/analyser-listen`, {
  token: A, method: 'POST', body: { linkId: chosen.id },
});
check('the bench can stand ready', armed.json?.listening === true, JSON.stringify(armed.json));
const since = Number(armed.json?.since?.control ?? 0);

const otherPort = other.id === linkA.id ? PORT_A : PORT_B;
await sendAstm(otherPort, run(stamp, `QC-OTHER-${stamp}`, '6.25'));
await wait(1200);

// Exactly the request the waiting screen makes.
const poll = async extra => {
  const q = new URLSearchParams({ since: String(since), sectionId: String(sec.id), materialId: String(control.id) });
  for (const [k, v] of Object.entries(extra ?? {})) q.set(k, String(v));
  return (await j(`/iqc/portal/feed-messages?${q}`, { token: A })).json ?? [];
};
const seen = await poll({ linkId: chosen.id });
check('the run reaches the waiting bench, though it came down the other link',
  seen.some(m => String(m.sample_id ?? '') === `QC-OTHER-${stamp}`),
  JSON.stringify(seen.map(m => [m.id, m.sample_id, m.link_id])));

// The module, which the laboratory says works, as the control answer.
const panel = await j(`/iqc/materials/${control.id}/analyser?linkId=${chosen.id}&since=${since}`, { token: A });
check('the module sees it too — the two screens now agree',
  (panel.json?.waiting ?? []).some(m => String(m.sample_id ?? '') === `QC-OTHER-${stamp}`),
  JSON.stringify((panel.json?.waiting ?? []).map(m => m.sample_id)));

/* ============================ 3. and the watermark spans the control, not one link */
console.log('\n[3] The watermark covers everything that can reach this control');
const second = await j(`/iqc/portal/controls/${control.id}/analyser-listen`, {
  token: A, method: 'POST', body: { linkId: chosen.id },
});
check('standing ready again marks the run that has just arrived as already seen',
  Number(second.json?.since?.control ?? 0) >= Number(seen[0]?.id ?? 0),
  `${second.json?.since?.control} vs ${seen[0]?.id}`);
const stale = await poll({ linkId: chosen.id, since: Number(second.json?.since?.control ?? 0) });
check('so a second press does not hand back the run from the first',
  !stale.some(m => String(m.sample_id ?? '') === `QC-OTHER-${stamp}`),
  JSON.stringify(stale.map(m => m.sample_id)));

/* ======================================= 4. the link it IS pointed at still works */
console.log('\n[4] And the ordinary case — the analyser sends down the link the bench chose');
const third = await j(`/iqc/portal/controls/${control.id}/analyser-listen`, {
  token: A, method: 'POST', body: { linkId: chosen.id },
});
const chosenPort = chosen.id === linkA.id ? PORT_A : PORT_B;
await sendAstm(chosenPort, run(stamp, `QC-CHOSEN-${stamp}`, '6.31'));
await wait(1200);
const direct = await poll({ linkId: chosen.id, since: Number(third.json?.since?.control ?? 0) });
check('it arrives, as it always did',
  direct.some(m => String(m.sample_id ?? '') === `QC-CHOSEN-${stamp}`),
  JSON.stringify(direct.map(m => m.sample_id)));
const mapped = direct.length
  ? (await j(`/iqc/portal/feed-messages/${direct.find(m => String(m.sample_id) === `QC-CHOSEN-${stamp}`).id}/mapping?materialId=${control.id}`, { token: A })).json
  : null;
check('and fills the control’s boxes', mapped?.matched === 2, JSON.stringify(mapped?.readings));

/* =================== 5. another unit's analyser is still none of this bench's business */
console.log('\n[5] Scoping is not loosened by any of this');
const away = (await j('/section-config/sections', { token: A, method: 'POST', body: {
  name: `Away ${stamp}`, code: `AW${String(stamp).slice(-6)}`,
} })).json;
const awayRow = (await j('/equipment', { token: A, method: 'POST', body: {
  name: `Cobas ${stamp}`, equipmentCategory: 'analyser', sectionId: away.id, status: 'operational',
} })).json;
const awayLink = (await j('/instrument-links', { token: A, method: 'POST', body: {
  name: `Away link ${stamp}`, equipmentId: awayRow.id, sectionId: away.id, profileKey: 'generic_astm',
  role: 'sechlims_only', mode: 'server', protocol: 'astm', listenPort: PORT_B + 500, autoStart: true,
} })).json;
await j(`/instrument-links/${awayLink.id}/start`, { token: A, method: 'POST' });
await wait(600);
await sendAstm(PORT_B + 500, run(stamp, `QC-AWAY-${stamp}`, '6.40'));
await wait(1200);
const mine = await poll({ linkId: chosen.id, since: 0 });
check('another unit’s transmission stays out of this bench’s poll',
  !mine.some(m => String(m.sample_id ?? '') === `QC-AWAY-${stamp}`),
  JSON.stringify(mine.map(m => m.sample_id)));
check('while this control’s own runs are all there',
  mine.filter(m => String(m.sample_id ?? '').startsWith('QC-')).length >= 2,
  JSON.stringify(mine.map(m => m.sample_id)));

/* ========== 6. enrolling a previously run sample, which is a PATIENT's sample */
console.log('\n[6] The sample number, taken off the analyser rather than typed');
/*
 * The bench's enrolment was reading the CONTROL runs, so the number it filled
 * in was a control's name — "XbarM2" — and never the laboratory number the
 * sample was reported under. A previously run sample is a patient's sample.
 */
const armedSample = await j(`/iqc/portal/controls/${control.id}/analyser-listen`, {
  token: A, method: 'POST', body: { linkId: chosen.id },
});
const patientMark = Number(armedSample.json?.since?.patient ?? 0);
await sendAstm(chosenPort, [
  `H|\\^&|||XN-550^1.0|||||||P|1|${stamp}`,
  `O|1|LAB-${stamp}|${stamp}|^^^^FBC|R||||||N||||||||||F`,
  'R|1|^^^^HGB|12.4|g/dL||N||F||||20261001091500',
  'R|2|^^^^WBC|7.80|10*9/L||N||F||||20261001091500',
  'L|1|N',
]);
await wait(1200);

const patients = (await j(`/iqc/portal/controls/${control.id}/patient-samples?linkId=${chosen.id}`, { token: A })).json ?? [];
check('the bench can read the patient samples its analyser has sent',
  Array.isArray(patients) && patients.length > 0, JSON.stringify(patients).slice(0, 200));
const sample = patients.find(m => String(m.sample_id ?? '') === `LAB-${stamp}`);
check('and the one just sent is among them, under its laboratory number',
  Boolean(sample), JSON.stringify(patients.map(m => m.sample_id)));
check('a control run is NOT offered as a previously run sample',
  !patients.some(m => String(m.sample_id ?? '').startsWith('QC-')),
  JSON.stringify(patients.map(m => m.sample_id)));
check('its readings come through under the control\u2019s own names',
  (sample?.parsed_values ?? []).some(v => /haemoglobin|hgb/i.test(String(v.analyte))),
  JSON.stringify(sample?.parsed_values));
/*
 * The host decides which of the control's parameters each reading is, because
 * the screen comparing the two strings got it wrong in the ordinary case: a
 * Sysmex sends HGB, the link maps it to Haemoglobin, and this control calls the
 * parameter Haemoglobin — but a control that called it HGB matched nothing, and
 * the reading arrived, was displayed, and filled no box at all.
 */
const controlAnalytes = (await j(`/iqc/materials/${control.id}/analytes`, { token: A })).json ?? [];
check('and arrive already lined up against the control\u2019s parameters',
  (sample?.readings ?? []).length === 2, JSON.stringify(sample?.readings));
check('each naming the parameter it fills, by id',
  (sample?.readings ?? []).every(r => controlAnalytes.some(a => a.id === r.analyteId)),
  JSON.stringify([(sample?.readings ?? []).map(r => r.analyteId), controlAnalytes.map(a => a.id)]));
check('with the numbers the analyser sent',
  (sample?.readings ?? []).some(r => Number(r.value) === 12.4)
  && (sample?.readings ?? []).some(r => Number(r.value) === 7.8),
  JSON.stringify(sample?.readings));
check('the watermark it was armed with is below it, so a wait would have caught it',
  Number(sample?.id ?? 0) > patientMark, `${sample?.id} vs ${patientMark}`);

const narrowed = (await j(`/iqc/portal/controls/${control.id}/patient-samples?linkId=${chosen.id}&search=LAB-${stamp}`, { token: A })).json ?? [];
check('and it can be looked up by its number', narrowed.length === 1 && narrowed[0].sample_id === `LAB-${stamp}`,
  JSON.stringify(narrowed.map(m => m.sample_id)));

const enrolled = await j('/iqc/retained-samples', { token: A, method: 'POST', body: {
  iqcMaterialId: control.id, sampleReference: sample?.sample_id, originalRunDate: '2026-10-01',
  originalRunTime: '09:15', source: 'instrument', feedMessageId: sample?.id,
  values: [{ analyteId: (await j(`/iqc/materials/${control.id}/analytes`, { token: A })).json[0].id, originalValue: 12.4 }],
} });
check('it enrols as a previously run sample', enrolled.status === 201, JSON.stringify(enrolled.json));
const register = (await j(`/iqc/portal/controls/${control.id}/retained-samples`, { token: A })).json ?? [];
check('and reaches the bench\u2019s register under that same number',
  register.some(x => x.sample_reference === `LAB-${stamp}`),
  JSON.stringify(register.map(x => x.sample_reference)));

/* ============== 7. another unit's analyser is not readable through this route */
console.log('\n[7] And it is scoped like everything else on the bench');
const refused = await j(`/iqc/portal/controls/${control.id}/patient-samples?linkId=${awayLink.id}`, { token: A });
check('naming another instrument\u2019s link does not reach its samples',
  !(refused.json ?? []).some(m => String(m.sample_id ?? '').startsWith('QC-AWAY-')),
  JSON.stringify((refused.json ?? []).map(m => m.sample_id)));

for (const id of [linkA.id, linkB.id, awayLink.id]) await j(`/instrument-links/${id}/stop`, { token: A, method: 'POST' });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
