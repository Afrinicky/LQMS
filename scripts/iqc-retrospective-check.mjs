/**
 * Controls whose history is being entered after the fact.
 *
 * This laboratory is bringing years of existing quality control onto the
 * system: every control procured and run on the haematology analyser since
 * 2023 has to appear on the charts and in the record. Those lots were run,
 * acted upon and thrown away long ago — so registering them as lots in current
 * use is wrong twice over. The bench board fills with "lot expired" against
 * material nobody is being asked to use, the Run it button disappears, and the
 * run that genuinely happened in 2023 is refused outright.
 *
 * A retrospective record changes one thing: the lot is not held to its expiry.
 * Every other rule is identical — the same Westgard evaluation, the same
 * verdict, the same nonconformity, recorded in retrospect along with everything
 * else about that period.
 *
 * Also proved here: an expiry date is editable, and editing it clears the flag.
 * An administrator who corrects a mistyped expiry should not have to retire the
 * lot and register it again.
 *
 *   node scripts/iqc-retrospective-check.mjs
 */
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
const onBoard = (board, id) => (board?.groups ?? []).flatMap(g => g.controls).find(c => c.id === id);

const st = await j('/setup/status');
if (!st.json?.setupComplete) {
  await j('/setup/initialize', { method: 'POST', body: {
    facilityName: 'Retro Lab', username: 'admin', password: PW, fullName: 'Admin User',
  } });
}
const A = (await j('/auth/login', { method: 'POST', body: { username: 'admin', password: PW } })).json?.token;
const stamp = Date.now();

/* ================================================================ 1. a unit */
console.log('\n[1] A unit, an analyser, and two lots that both ran out last year');
const sec = (await j('/section-config/sections', { token: A, method: 'POST', body: {
  name: `Haematology ${stamp}`, code: `HM${String(stamp).slice(-6)}`,
} })).json;
const me = (await j('/auth/me', { token: A })).json?.user;
const staff = (await j('/staff', { token: A, method: 'POST', body: {
  fullName: `Scientist ${stamp}`, employeeNo: `E${stamp}`, sectionId: sec.id,
} })).json;
await j(`/users/${me.id}`, { token: A, method: 'PUT', body: { staffId: staff.id } });
const analyser = (await j('/equipment', { token: A, method: 'POST', body: {
  name: `Sysmex XN-550 ${stamp}`, equipmentCategory: 'analyser', sectionId: sec.id, status: 'operational',
} })).json;

const define = (name, lot, expiry, recordingBasis) => j('/iqc/materials', { token: A, method: 'POST', body: {
  materialName: name, testName: 'Full blood count', lotNumber: lot, levelLabel: 'Level 1 (Low)',
  source: 'commercial', controlType: 'quantitative', qcFrequency: 'daily',
  sectionId: sec.id, equipmentId: analyser.id, expiryDate: expiry, recordingBasis,
  analytes: [
    { analyte: 'WBC', unit: '10^9/L', targetMean: 3.21, targetSd: 0.16, decimalPlaces: 2 },
    { analyte: 'HB', unit: 'g/dL', targetMean: 6.2, targetSd: 0.2, decimalPlaces: 1 },
  ],
} });

const EXPIRED_ON = '2024-06-30';
const current = await define(`Current lot ${stamp}`, `CUR-${stamp}`, EXPIRED_ON, 'prospective');
const historic = await define(`Historic lot ${stamp}`, `HIS-${stamp}`, EXPIRED_ON, 'retrospective');
check('a lot in current use is registered', current.status === 201, JSON.stringify(current.json));
check('and a lot whose history is being entered', historic.status === 201, JSON.stringify(historic.json));

const register = (await j('/iqc/materials', { token: A })).json ?? [];
const row = id => register.find(m => m.id === id);
check('the register records which is which',
  row(current.json.id)?.recording_basis === 'prospective'
  && row(historic.json.id)?.recording_basis === 'retrospective',
  JSON.stringify([row(current.json.id)?.recording_basis, row(historic.json.id)?.recording_basis]));

/* ================================================= 2. the bench board */
console.log('\n[2] The bench board: one is out of date, the other is a historical record');
const board = (await j(`/iqc/portal/board?sectionId=${sec.id}`, { token: A })).json;
check('the current lot is flagged as expired', onBoard(board, current.json.id)?.expired === true,
  JSON.stringify(onBoard(board, current.json.id)));
check('the retrospective lot is not', onBoard(board, historic.json.id)?.expired === false,
  JSON.stringify(onBoard(board, historic.json.id)));
check('and says so, so a two-year-old expiry does not read as a mistake',
  onBoard(board, historic.json.id)?.recordingBasis === 'retrospective',
  JSON.stringify(onBoard(board, historic.json.id)?.recordingBasis));
check('exactly one lot is counted as expired', Number(board?.counts?.expired) === 1,
  JSON.stringify(board?.counts));
check('and the retrospective one is counted as still due',
  Number(board?.counts?.due) === 1, JSON.stringify(board?.counts));

/* ============================================ 3. recording the runs that happened */
console.log('\n[3] Recording a run that happened in 2023');
const analytesOf = async id => (await j(`/iqc/materials/${id}/analytes`, { token: A })).json ?? [];
const histAnalytes = await analytesOf(historic.json.id);
const curAnalytes = await analytesOf(current.json.id);

const refusedRun = await j('/iqc/runs', { token: A, method: 'POST', body: {
  iqcMaterialId: current.json.id, runDate: '2026-05-04',
  readings: [{ analyteId: curAnalytes[0].id, value: 3.2 }],
} });
check('a current lot refuses a run after its expiry', refusedRun.status === 400,
  JSON.stringify(refusedRun.json));

const historicRun = await j('/iqc/runs', { token: A, method: 'POST', body: {
  iqcMaterialId: historic.json.id, runDate: '2023-04-12', runTime: '08:30',
  readings: [{ analyteId: histAnalytes[0].id, value: 3.24 }, { analyteId: histAnalytes[1].id, value: 6.22 }],
} });
check('the retrospective lot records the run it actually had in 2023',
  historicRun.status === 201 || historicRun.status === 200, JSON.stringify(historicRun.json));
const recorded = ((await j('/iqc/runs?limit=200', { token: A })).json ?? [])
  .find(r => r.id === historicRun.json?.id);
check('on the day it was run, not today', recorded?.run_date === '2023-04-12',
  JSON.stringify([recorded?.run_date, historicRun.json?.id]));

/* ============================== 4. judged exactly as a current lot is judged */
console.log('\n[4] Judged by the same rules — a retrospective record is not a lenient one');
check('a run within the limits is in control', historicRun.json?.status === 'in_control',
  JSON.stringify(historicRun.json?.status));

const wild = await j('/iqc/runs', { token: A, method: 'POST', body: {
  iqcMaterialId: historic.json.id, runDate: '2023-04-13', runTime: '08:30',
  readings: [{ analyteId: histAnalytes[0].id, value: 9.9 }, { analyteId: histAnalytes[1].id, value: 6.21 }],
} });
check('and a run far outside them is rejected, in retrospect as at the time',
  wild.json?.status === 'out_of_control', JSON.stringify(wild.json?.status));
check('with patient results held, exactly as they would have been',
  wild.json?.mayReleasePatientResults === false, JSON.stringify(wild.json?.mayReleasePatientResults));

/* ====================== 5. an expiry date is editable, and the flag follows it */
console.log('\n[5] Correcting a mistyped expiry date');
const edited = await j(`/iqc/materials/${current.json.id}`, { token: A, method: 'PUT', body: {
  expiryDate: '2027-12-31',
} });
check('the administrator may change the expiry date', edited.status === 200, JSON.stringify(edited.json));
const after = (await j('/iqc/materials', { token: A })).json ?? [];
check('and the new date is what is stored',
  after.find(m => m.id === current.json.id)?.expiry_date === '2027-12-31',
  JSON.stringify(after.find(m => m.id === current.json.id)?.expiry_date));

const board2 = (await j(`/iqc/portal/board?sectionId=${sec.id}`, { token: A })).json;
check('the bench board stops flagging it the moment the date is corrected',
  onBoard(board2, current.json.id)?.expired === false,
  JSON.stringify(onBoard(board2, current.json.id)));
check('nothing is counted as expired any more', Number(board2?.counts?.expired) === 0,
  JSON.stringify(board2?.counts));
const nowRuns = await j('/iqc/runs', { token: A, method: 'POST', body: {
  iqcMaterialId: current.json.id, runDate: '2026-05-04',
  readings: [{ analyteId: curAnalytes[0].id, value: 3.2 }],
} });
check('and the run it refused a moment ago is accepted', nowRuns.status === 201 || nowRuns.status === 200,
  JSON.stringify(nowRuns.json).slice(0, 200));

/* ================= 6. a lot can be corrected to retrospective without being retired */
console.log('\n[6] A lot registered as current, then found to be a historical one');
const switched = await j(`/iqc/materials/${current.json.id}`, { token: A, method: 'PUT', body: {
  expiryDate: EXPIRED_ON, recordingBasis: 'retrospective',
} });
check('it can be corrected in place', switched.status === 200, JSON.stringify(switched.json));
const board3 = (await j(`/iqc/portal/board?sectionId=${sec.id}`, { token: A })).json;
check('and is no longer flagged, though its expiry is two years past',
  onBoard(board3, current.json.id)?.expired === false
  && onBoard(board3, current.json.id)?.recordingBasis === 'retrospective',
  JSON.stringify(onBoard(board3, current.json.id)));
const backdated = await j('/iqc/runs', { token: A, method: 'POST', body: {
  iqcMaterialId: current.json.id, runDate: '2025-02-18',
  readings: [{ analyteId: curAnalytes[0].id, value: 3.19 }],
} });
check('its own history can now be entered too', backdated.status === 201 || backdated.status === 200,
  JSON.stringify(backdated.json).slice(0, 200));

/* ============================= 7. the coverage table says the same thing */
console.log('\n[7] The coverage table agrees with the board');
const coverage = (await j(`/iqc/portal/coverage?sectionId=${sec.id}`, { token: A })).json;
const all = [...(coverage?.tests ?? []).flatMap(t => t.controls), ...(coverage?.unlisted ?? [])];
const hist = all.find(c => c.id === historic.json.id);
check('the retrospective lot is not shown as expired there either', hist?.expired === false,
  JSON.stringify(hist));
check('and carries the same wording', hist?.recordingBasis === 'retrospective', JSON.stringify(hist?.recordingBasis));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
