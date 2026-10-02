/**
 * Why a control that transmitted perfectly never reached the bench.
 *
 * Three separate faults, all of which looked to the laboratory like "the
 * transmission stopped working" — and the live log said otherwise every time,
 * because the run HAD arrived and had been parked correctly.
 *
 *  1. The lists were ordered by the date the ANALYSER stamped. A Sysmex X-bar M
 *     transmission carries the day its stored moving average was computed, and
 *     an analyser with a drifting clock carries whatever it believes. So a
 *     control sent this morning sorted into the middle of a fortnight of older
 *     ones, the newest-five list showed five old runs, and the register looked
 *     like it held nothing but September.
 *
 *  2. The bench's poll — the one standing there waiting for the transmission
 *     after somebody pressed Fetch Results — did not say which unit's board it
 *     was looking at. The server scopes that list by unit, and with nothing
 *     told to it, it fell back to the READER's own unit. A senior post looking
 *     at haematology's board was handed their own unit's transmissions, so the
 *     run arrived, was parked, and was filtered out of the very poll waiting
 *     for it. The boxes stayed empty and the LHIMS client reported success.
 *
 *  3. The register behind "Earlier results from the analysers" had the same
 *     hole, and answered "nothing matches that" about a register with thousands
 *     of rows in it.
 *
 *   node scripts/iqc-transmission-register-check.mjs
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
/* The host stamps arrival with SQLite's CURRENT_TIMESTAMP, which is UTC. */
const todayUtc = () => new Date().toISOString().slice(0, 10);

const st = await j('/setup/status');
if (!st.json?.setupComplete) {
  await j('/setup/initialize', { method: 'POST', body: {
    facilityName: 'Register Lab', username: 'admin', password: PW, fullName: 'Admin User',
  } });
}
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

/* ========================================= 1. two units, and whose is whose */
console.log('\n[1] Two units: the one the reader sits in, and the one whose board they open');
const home = await j('/section-config/sections', { token: A, method: 'POST', body: {
  name: `Reader unit ${stamp}`, code: `RU${String(stamp).slice(-6)}`,
} });
const bench = await j('/section-config/sections', { token: A, method: 'POST', body: {
  name: `Haematology ${stamp}`, code: `HA${String(stamp).slice(-6)}`,
} });
const homeId = home.json?.id; const benchId = bench.json?.id;
check('both units exist', home.status === 201 && bench.status === 201 && homeId !== benchId,
  JSON.stringify([home.json, bench.json]));

// The reader's OWN staff record sits on the other unit — the condition under
// which every one of these faults showed itself, and the ordinary condition of
// an administrator or a Quality Manager.
const me = (await j('/auth/me', { token: A })).json?.user;
const staffId = (await j('/staff', { token: A, method: 'POST', body: {
  fullName: `Senior post ${stamp}`, employeeNo: `E${stamp}`, sectionId: homeId,
} })).json?.id;
await j(`/users/${me.id}`, { token: A, method: 'PUT', body: { staffId } });
check('the reader is on the other unit', Boolean(staffId));

const analyser = (await j('/equipment', { token: A, method: 'POST', body: {
  name: `Sysmex XN-550 ${stamp}`, equipmentCategory: 'analyser', sectionId: benchId, status: 'operational',
} })).json;
const link = await j('/instrument-links', { token: A, method: 'POST', body: {
  name: `Haematology bench ${stamp}`, equipmentId: analyser.id, sectionId: benchId, profileKey: 'sysmex_xn',
  role: 'sechlims_only', mode: 'server', protocol: 'astm', listenPort: PORT, autoStart: true,
} });
check('an analyser link listens for that unit', link.status === 201, JSON.stringify(link.json));
await j(`/instrument-links/${link.json.id}/start`, { token: A, method: 'POST' });
await wait(500);

const control = await j('/iqc/materials', { token: A, method: 'POST', body: {
  materialName: `XN CHECK ${stamp}`, testName: 'Full blood count', lotNumber: `XN-${stamp}`,
  levelLabel: 'Level 1 (Low)', source: 'commercial', controlType: 'quantitative', qcFrequency: 'daily',
  sectionId: benchId, equipmentId: analyser.id,
  analytes: [
    { analyte: 'Haemoglobin', unit: 'g/dL', targetMean: 6.2, targetSd: 0.2, decimalPlaces: 1 },
    { analyte: 'WBC', unit: '10^9/L', targetMean: 3.21, targetSd: 0.16, decimalPlaces: 2 },
  ],
} });
const controlId = control.json?.id;
check('the control is on that unit', control.status === 201, JSON.stringify(control.json));

/* ==================== 2. an old stamp arriving after a recent one */
console.log('\n[2] A recent stamp first, then an X-bar M stamped a year ago');
/*
 * The stamp a Sysmex puts on a result is in the R record's completion field,
 * which is where the dates below go — the real thing, so this proves what the
 * laboratory actually sees rather than a convenient fiction. A control is
 * recognised the way the profile recognises one: QC or XbarM in the sample
 * identifier.
 */
await sendAstm(PORT, [
  `H|\\^&|||XN-550^1.0|||||||P|1|${stamp}`,
  `O|1|QC-RECENT-${stamp}|XN-${stamp}|^^^^FBC|R||||||Q||||||||||F`,
  'R|1|^^^^HGB|6.25|g/dL||N||F||||20260930080000',
  'L|1|N',
]);
await wait(1200);
// And this one, sent SECOND and therefore the run the bench is standing at the
// analyser waiting for, carries the day its stored moving average was computed.
await sendAstm(PORT, [
  `H|\\^&|||XN-550^1.0|||||||P|1|${stamp}`,
  `O|1|XbarM-${stamp}|XN-${stamp}|^^^^FBC|R||||||Q||||||||||F`,
  'R|1|^^^^HGB|6.31|g/dL||N||F||||20250912061500',
  'R|2|^^^^WBC|3.28|10*9/L||N||F||||20250912061500',
  'L|1|N',
]);
await wait(1000);

/* =================================== 3. the register, scoped to the unit looked at */
console.log('\n[3] Earlier results from the analysers — for the unit being looked at');
const unscoped = await j('/iqc/portal/transmissions', { token: A });
check('without being told the unit, the reader is shown their own and not the bench’s',
  (unscoped.json?.rows ?? []).every(r => !String(r.sample_id ?? '').includes(String(stamp))),
  JSON.stringify((unscoped.json?.rows ?? []).map(r => r.sample_id)));

const scoped = await j(`/iqc/portal/transmissions?sectionId=${benchId}`, { token: A });
const rows = scoped.json?.rows ?? [];
check('told the unit, the register answers with that unit’s transmissions',
  rows.length >= 2, `${rows.length} rows — ${JSON.stringify(scoped.json?.error ?? '')}`);
check('and not with "nothing matches that"', Number(scoped.json?.total ?? 0) >= 2, JSON.stringify(scoped.json?.total));

/* ============================================ 4. newest means newest by arrival */
console.log('\n[4] Newest means newest by arrival, not by what the analyser stamped');
check('the run that arrived last is at the top of the register',
  String(rows[0]?.sample_id ?? '').startsWith('XbarM-'),
  JSON.stringify(rows.map(r => [r.sample_id, r.received_at, r.instrument_run_at])));
check('even though the analyser stamped it the older of the two',
  String(rows[0]?.instrument_run_at ?? '') < String(rows[1]?.instrument_run_at ?? ''),
  JSON.stringify(rows.map(r => r.instrument_run_at)));
check('both dates come back, so a screen can show the difference rather than hide it',
  Boolean(rows[0]?.received_at) && Boolean(rows[0]?.instrument_run_at),
  JSON.stringify(rows[0]));
check('and the parameter count is the count, not a column that does not exist',
  Number(rows[0]?.result_count) === 2, JSON.stringify(rows[0]?.result_count));

// The same question asked of the module's own newest-few list.
const panel = await j(`/iqc/materials/${controlId}/analyser?linkId=${link.json.id}`, { token: A });
const waiting = panel.json?.waiting ?? [];
check('the module’s newest-few list puts it first too',
  String(waiting[0]?.sample_id ?? '').startsWith('XbarM-'),
  JSON.stringify(waiting.map(w => [w.sample_id, w.received_at, w.instrument_run_at])));

/* ======================================== 5. narrowing by day finds it either way */
console.log('\n[5] Narrowing by day finds it by the day it came in, as well as by the day it was run');
const today = todayUtc();
const byArrival = await j(`/iqc/portal/transmissions?sectionId=${benchId}&from=${today}&to=${today}`, { token: A });
check('a run whose analyser stamp is last year still shows under today',
  (byArrival.json?.rows ?? []).some(r => String(r.sample_id).startsWith('XbarM-')),
  JSON.stringify((byArrival.json?.rows ?? []).map(r => r.sample_id)));
const byRun = await j(`/iqc/portal/transmissions?sectionId=${benchId}&from=2025-09-12&to=2025-09-12`, { token: A });
check('and is also findable under the day the analyser said it ran',
  (byRun.json?.rows ?? []).some(r => String(r.sample_id).startsWith('XbarM-')),
  JSON.stringify((byRun.json?.rows ?? []).map(r => r.sample_id)));

/* ================================ 6. the picker is scoped the same way the list is */
console.log('\n[6] The register’s own pickers are scoped the way its list is');
check('the unit being looked at is offered its own analyser',
  (scoped.json?.sources ?? []).some(s => s.id === link.json.id),
  JSON.stringify(scoped.json?.sources));
check('another unit’s register does not offer it',
  !((unscoped.json?.sources ?? []).some(s => s.id === link.json.id)),
  JSON.stringify(unscoped.json?.sources));

/* ==================== 7. the poll the bench stands on while Fetch Results waits */
console.log('\n[7] The poll behind Fetch Results, which is where the boxes are filled from');
const blind = await j('/iqc/portal/feed-messages', { token: A });
check('unscoped, it cannot see the transmission it is waiting for',
  !((blind.json ?? []).some(m => String(m.sample_id ?? '').startsWith('XbarM-'))),
  JSON.stringify((blind.json ?? []).map(m => m.sample_id)));

const seeing = await j(`/iqc/portal/feed-messages?sectionId=${benchId}&linkId=${link.json.id}`, { token: A });
check('scoped to the unit and the analyser, it sees it',
  (seeing.json ?? []).some(m => String(m.sample_id ?? '').startsWith('XbarM-')),
  JSON.stringify((seeing.json ?? []).map(m => m.sample_id)));
check('newest by arrival here as well',
  String((seeing.json ?? [])[0]?.sample_id ?? '').startsWith('XbarM-'),
  JSON.stringify((seeing.json ?? []).map(m => m.sample_id)));

const arrived = (seeing.json ?? []).find(m => String(m.sample_id ?? '').startsWith('XbarM-'));
const mapped = arrived
  ? (await j(`/iqc/portal/feed-messages/${arrived.id}/mapping?materialId=${controlId}`, { token: A })).json
  : null;
check('and what it saw fills the control’s boxes', mapped?.matched === 2, JSON.stringify(mapped?.readings));
check('with the transmission itself returned for the preview to read',
  Array.isArray(mapped?.message?.parsed_values) && mapped.message.parsed_values.length === 2,
  JSON.stringify(mapped?.message?.parsed_values));
check('carrying both of its dates, which is what the preview shows',
  Boolean(mapped?.message?.received_at) && Boolean(mapped?.message?.instrument_run_at),
  JSON.stringify([mapped?.message?.received_at, mapped?.message?.instrument_run_at]));

/* ================================== 8. a link in no unit at all is nobody's secret */
/*
 * Scoping a register by unit must not hide the links that belong to no unit.
 * A bench analyser registered before units were filled in, or a shared machine
 * deliberately left unassigned, still transmits — and a filter that dropped it
 * would be the same fault over again, wearing the fix as a disguise.
 */
console.log('\n[8] A link registered against no unit stays visible to every unit');
const shared = await j('/instrument-links', { token: A, method: 'POST', body: {
  name: `Shared bench ${stamp}`, profileKey: 'generic_astm',
  role: 'sechlims_only', mode: 'server', protocol: 'astm', listenPort: PORT + 1, autoStart: true,
} });
check('such a link can be registered', shared.status === 201, JSON.stringify(shared.json));
await j(`/instrument-links/${shared.json.id}/start`, { token: A, method: 'POST' });
await wait(500);
// No QC in the identifier here, so it is the ASTM action code that says this is
// a control — the open path, for a client that marks its controls properly.
await sendAstm(PORT + 1, [
  `H|\\^&|||GENERIC^1.0|||||||P|1|${stamp}`,
  `O|1|SHARED-${stamp}|XN-${stamp}|^^^^FBC|R||||||Q||||||||||F`,
  'R|1|^^^^HGB|6.28|g/dL||N||F||||20260930090000',
  'L|1|N',
]);
await wait(1000);

const fromBench = await j(`/iqc/portal/transmissions?sectionId=${benchId}`, { token: A });
const fromHome = await j(`/iqc/portal/transmissions?sectionId=${homeId}`, { token: A });
check('the unassigned link\u2019s run is on the bench\u2019s register',
  (fromBench.json?.rows ?? []).some(r => String(r.sample_id ?? '').startsWith('SHARED-')),
  JSON.stringify((fromBench.json?.rows ?? []).map(r => r.sample_id)));
check('and on the other unit\u2019s register too, because it belongs to neither',
  (fromHome.json?.rows ?? []).some(r => String(r.sample_id ?? '').startsWith('SHARED-')),
  JSON.stringify((fromHome.json?.rows ?? []).map(r => r.sample_id)));
check('while the bench\u2019s own run stays off the other unit\u2019s register',
  !((fromHome.json?.rows ?? []).some(r => String(r.sample_id ?? '').startsWith('XbarM-'))),
  JSON.stringify((fromHome.json?.rows ?? []).map(r => r.sample_id)));

await j(`/instrument-links/${link.json.id}/stop`, { token: A, method: 'POST' });
await j(`/instrument-links/${shared.json.id}/stop`, { token: A, method: 'POST' });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
