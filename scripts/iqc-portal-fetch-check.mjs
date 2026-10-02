/**
 * The bench's own control run: taking the results off the analyser, and
 * re-reading a previously run sample.
 *
 * Both existed in the module and neither reached the portal, which is where the
 * morning's controls are actually run. The bench had one route — type the
 * numbers — and no way to say "this lot is finished, I am re-reading the sample
 * we kept", short of walking to a desktop.
 *
 * The other thing proved here is the matching that made the button invisible: a
 * laboratory that registers its machine as "Sysmex XN550" and sets the link up
 * against "SYSMEX XN-550" has two equipment rows for one analyser. Asking only
 * for an exact equipment match found nothing, so the portal reported no feed,
 * drew no Fetch, and said nothing at all about why.
 *
 *   node scripts/iqc-portal-fetch-check.mjs
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
const day = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

const st = await j('/setup/status');
if (!st.json?.setupComplete) await j('/setup/initialize', { method: 'POST', body: { facilityName: 'Bench Lab', username: 'admin', password: PW, fullName: 'Admin User' } });
let A = (await j('/auth/login', { method: 'POST', body: { username: 'admin', password: PW } })).json?.token;
const stamp = Date.now();
const PORT = 42000 + (stamp % 900);

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

/* ================================================== 1. a bench, and its analyser */
console.log('\n[1] A unit, a member of staff in it, and an analyser transmitting to it');
// Its own unit. Several links in one unit is a real situation and the reason
// the bench gets a picker, but it makes "which link did it guess?" an
// arbitrary question — so this suite does not share a unit with another's
// leftovers.
const made = await j('/section-config/sections', { token: A, method: 'POST', body: {
  name: `Bench unit ${stamp}`, code: `BU${String(stamp).slice(-6)}`,
} });
const sectionId = made.json?.id;
check('a unit exists to work in', made.status === 201 && Boolean(sectionId), JSON.stringify(made.json));

// /auth/me answers { user, permissions } — the account is one level in.
const me = (await j('/auth/me', { token: A })).json?.user;
const staffId = (await j('/staff', { token: A, method: 'POST', body: {
  fullName: `Bench Scientist ${stamp}`, employeeNo: `E${stamp}`, sectionId,
} })).json?.id;
await j(`/users/${me.id}`, { token: A, method: 'PUT', body: { staffId } });
check('the account is on that unit’s bench', Boolean(staffId));

// TWO equipment rows for ONE machine, which is what a laboratory really has.
const onTheLink = (await j('/equipment', { token: A, method: 'POST', body: {
  name: `SYSMEX XN-550 ${stamp}`, equipmentCategory: 'analyser', sectionId, status: 'operational',
} })).json;
const onTheControl = (await j('/equipment', { token: A, method: 'POST', body: {
  name: `Sysmex XN550 ${stamp}`, equipmentCategory: 'analyser', sectionId, status: 'operational',
} })).json;
check('the same analyser is registered twice, as laboratories do',
  Boolean(onTheLink?.id) && Boolean(onTheControl?.id) && onTheLink.id !== onTheControl.id);

const link = await j('/instrument-links', { token: A, method: 'POST', body: {
  name: `Haematology 1 ${stamp}`, equipmentId: onTheLink.id, sectionId, profileKey: 'sysmex_xn',
  role: 'sechlims_only', mode: 'server', protocol: 'astm', listenPort: PORT, autoStart: true,
} });
check('a link is set up against one of them', link.status === 201, JSON.stringify(link.json));
await j(`/instrument-links/${link.json.id}/start`, { token: A, method: 'POST' });
await wait(500);

/* ================================ 2. the control the bench runs, on the OTHER row */
console.log('\n[2] The control names the other equipment row — the case that hid the button');
const control = await j('/iqc/materials', { token: A, method: 'POST', body: {
  materialName: `XN CHECK CONTROL ${stamp}`, testName: 'Full blood count', lotNumber: `XN-${stamp}`,
  levelLabel: 'Level 1 (Low)', source: 'commercial', controlType: 'quantitative', qcFrequency: 'daily',
  sectionId, equipmentId: onTheControl.id,
  analytes: [
    { analyte: 'Haemoglobin', unit: 'g/dL', targetMean: 6.2, targetSd: 0.2, decimalPlaces: 1 },
    { analyte: 'WBC', unit: '10^9/L', targetMean: 3.21, targetSd: 0.16, decimalPlaces: 2 },
  ],
} });
const controlId = control.json.id;
check('the control is defined on this unit', control.status === 201, JSON.stringify(control.json));

const board = (await j('/iqc/portal/board', { token: A })).json;
check('it reaches the bench board', (board?.groups ?? []).flatMap(g => g.controls).some(c => c.id === controlId),
  JSON.stringify((board?.groups ?? []).flatMap(g => g.controls).map(c => c.id)));

const detail = (await j(`/iqc/portal/controls/${controlId}`, { token: A })).json;
check('the bench is told which analyser serves it, despite the two rows',
  Boolean(detail?.feed?.id), JSON.stringify(detail?.feed));
check('and it is the link that is really listening', detail?.feed?.id === link.json.id);

/* ======================================= 3. Fetch, from the bench's own run screen */
console.log('\n[3] Standing ready from the bench, and the transmission landing');
const armed = await j(`/iqc/portal/controls/${controlId}/analyser-listen`, { token: A, method: 'POST' });
check('the bench can stand ready', armed.json?.listening === true, JSON.stringify(armed.json));
check('and is handed a watermark', Number(armed.json?.since?.control) >= 0, JSON.stringify(armed.json?.since));

await sendAstm(PORT, [
  `H|\\^&|||XN-550^1.0|||||||P|1|${stamp}`,
  `O|1|QC1-${stamp}|${`XN-${stamp}`}|^^^^FBC|R||20260930080000|||||||||||||||||F`,
  'R|1|^^^HGB|6.25|g/dL||N||F',
  'R|2|^^^WBC|3.30|10*9/L||N||F',
  'L|1|N',
]);
await wait(900);

const waiting = (await j(`/iqc/portal/feed-messages?since=${armed.json.since.control}`, { token: A })).json ?? [];
check('the run the analyser just sent reaches the bench', waiting.some(m => String(m.sample_id).startsWith('QC1-')),
  JSON.stringify(waiting.map(m => m.sample_id)));

const message = waiting.find(m => String(m.sample_id).startsWith('QC1-'));
const mapped = (await j(`/iqc/portal/feed-messages/${message.id}/mapping?materialId=${controlId}`, { token: A })).json;
check('and lines up with the control’s own parameters', mapped?.matched === 2, JSON.stringify(mapped?.readings));
check('haemoglobin came through as haemoglobin',
  (mapped?.readings ?? []).some(r => r.analyte === 'Haemoglobin' && r.value === 6.25),
  JSON.stringify(mapped?.readings));

/* ===================== 4. a previously run sample, chosen from the bench */
console.log('\n[4] Re-reading a previously run sample, from the bench');
const analytes = (await j(`/iqc/materials/${controlId}/analytes`, { token: A })).json ?? [];
const hb = analytes.find(a => a.analyte === 'Haemoglobin');

const empty = (await j(`/iqc/portal/controls/${controlId}/retained-samples`, { token: A })).json;
check('the register is empty until a sample is enrolled', Array.isArray(empty) && empty.length === 0);

const covering = await j('/iqc/runs', { token: A, method: 'POST', body: {
  iqcMaterialId: controlId, runDate: day(5),
  readings: [{ analyteId: hb.id, value: 6.2 }],
} });
const enrolled = await j('/iqc/retained-samples', { token: A, method: 'POST', body: {
  iqcMaterialId: controlId, sampleReference: `LAB-${stamp}`, originalRunDate: day(4),
  originalIqcRunId: covering.json.id,
  values: [{ analyteId: hb.id, originalValue: 6.3 }],
} });
check('a sample is enrolled in the module', enrolled.status === 201, JSON.stringify(enrolled.json));

const register = (await j(`/iqc/portal/controls/${controlId}/retained-samples`, { token: A })).json;
check('and the bench can now choose it', (register ?? []).some(x => x.id === enrolled.json.id),
  JSON.stringify((register ?? []).map(x => x.sample_reference)));
check('with what it originally gave, to compare against',
  (register ?? [])[0]?.values?.some(v => v.original_value === 6.3), JSON.stringify((register ?? [])[0]?.values));
check('and the control run that covered it', Boolean((register ?? [])[0]?.original_run_number));

// The bench records the re-read exactly as the module does.
const reread = await j('/iqc/runs', { token: A, method: 'POST', body: {
  iqcMaterialId: controlId, runKind: 'retained_sample', retainedSampleId: enrolled.json.id,
  runDate: day(0), readings: [{ analyteId: hb.id, value: 6.35 }],
} });
check('the bench’s re-read is recorded and judged', reread.json?.status === 'in_control', JSON.stringify(reread.json));
check('against the original, not the control’s target',
  reread.json?.analytes?.[0]?.originalValue === 6.3, JSON.stringify(reread.json?.analytes?.[0]));

const drifted = await j('/iqc/runs', { token: A, method: 'POST', body: {
  iqcMaterialId: controlId, runKind: 'retained_sample', retainedSampleId: enrolled.json.id,
  runDate: day(0), readings: [{ analyteId: hb.id, value: 7.4 }],
} });
check('and a re-read that has drifted is rejected', drifted.json?.status === 'out_of_control', JSON.stringify(drifted.json));
check('holding patient results', drifted.json?.mayReleasePatientResults === false);

/* ================= 6. whose board a control is on, and who may say so */
/*
 * The board is drawn through the unit scope, which knows that three posts — the
 * administrator, the Quality Manager and the Laboratory Manager — answer for
 * every unit and may CHOOSE which unit they are looking at. Every per-control
 * action checked the reader's own staff section instead, so a Quality Manager
 * could open another unit's board from the picker, see its controls listed,
 * press Run it, and be told the control was not on their board — about a
 * control that plainly was on the board in front of them.
 *
 * Both directions matter. The senior post must reach it; the bench must not.
 */
console.log('\n[6] Reaching a control on a unit that is not your own');

const otherUnit = ((await j('/sections', { token: A })).json ?? []).find(x => Number(x.id) !== Number(sectionId));
const awayControl = otherUnit ? await j('/iqc/materials', { token: A, method: 'POST', body: {
  materialName: `Away control ${stamp}`, testName: 'Full blood count', lotNumber: `AW-${stamp}`,
  levelLabel: 'Level 1 (Low)', source: 'commercial', controlType: 'quantitative', qcFrequency: 'daily',
  sectionId: otherUnit.id,
  analytes: [{ analyte: 'Haemoglobin', unit: 'g/dL', targetMean: 13.5, targetSd: 0.4, decimalPlaces: 1 }],
} }) : null;
check('a control exists on another unit', awayControl?.status === 201, JSON.stringify(awayControl?.json));

if (awayControl?.status === 201) {
  const awayId = awayControl.json.id;
  // The administrator's own staff record is on THIS unit, not that one.
  const register = await j(`/iqc/portal/controls/${awayId}/retained-samples`, { token: A });
  check('a post that answers for every unit reaches it', register.status === 200,
    JSON.stringify(register.json?.error));
  const armed = await j(`/iqc/portal/controls/${awayId}/analyser-listen`, { token: A, method: 'POST' });
  check('and may stand ready on it', armed.status === 200, JSON.stringify(armed.json?.error));

  // A bench account is held to its own unit, which is the whole point of the check.
  const roles = (await j('/roles', { token: A })).json ?? [];
  const bench = (Array.isArray(roles) ? roles : []).find(r => /biomedical scientist/i.test(String(r.name)));
  const benchStaff = await j('/staff', { token: A, method: 'POST', body: {
    fullName: `Bench ${stamp}`, staffNumber: `BT${stamp % 100000}`, sectionId, employmentStatus: 'active',
  } });
  const username = `bench${stamp % 100000}`;
  await j('/users', { token: A, method: 'POST', body: {
    username, password: PW, fullName: `Bench ${stamp}`, roleId: bench?.id, staffId: benchStaff.json?.id,
  } });
  const B = (await j('/auth/login', { method: 'POST', body: { username, password: PW } })).json?.token;
  check('a bench account can be signed in', Boolean(B));

  if (B) {
    const refusedRegister = await j(`/iqc/portal/controls/${awayId}/retained-samples`, { token: B });
    check('the bench is still refused another unit\u2019s control', refusedRegister.status === 404,
      `${refusedRegister.status}`);
    const refusedArm = await j(`/iqc/portal/controls/${awayId}/analyser-listen`, { token: B, method: 'POST' });
    check('and cannot stand ready on it either', refusedArm.status === 404, `${refusedArm.status}`);
    const own = await j(`/iqc/portal/controls/${controlId}/retained-samples`, { token: B });
    check('while its own unit\u2019s control is reachable as before', own.status === 200,
      JSON.stringify(own.json?.error));
  }
}

await j(`/instrument-links/${link.json.id}/stop`, { token: A, method: 'POST' });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
