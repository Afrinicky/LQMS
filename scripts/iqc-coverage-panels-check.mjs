/**
 * A panel is one test on the quality-control board, not sixteen.
 *
 * The unit's control board listed every row of the test menu, so a full blood
 * count appeared as "FULL BLOOD COUNT (FBC)" AND as HB, HCT, MCH, MCHC, MCV,
 * MPV, PLT and WBC beside it. Haematology looked like seventeen uncontrolled
 * tests when it reports nine, and the board invited somebody to define a second
 * control "for HCT" that would duplicate the one already covering the panel —
 * because nobody runs a control for MCHC. The control is run for the FBC, on
 * the analyser, and it judges every parameter of it at once.
 *
 * A test that belongs to no panel is untouched: a malaria RDT is not a
 * component of anything.
 *
 *   node scripts/iqc-coverage-panels-check.mjs
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

const st = await j('/setup/status');
if (!st.json?.setupComplete) {
  await j('/setup/initialize', { method: 'POST', body: {
    facilityName: 'Panel Lab', username: 'admin', password: PW, fullName: 'Admin User',
  } });
}
const A = (await j('/auth/login', { method: 'POST', body: { username: 'admin', password: PW } })).json?.token;
const stamp = Date.now();

/* ================================================ 1. a menu with a panel on it */
console.log('\n[1] A unit whose menu holds a panel and some standalone tests');
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

const panel = await j(`/section-config/sections/${sec.id}/tests`, { token: A, method: 'POST', body: {
  isPanel: true, testName: 'Full Blood Count (FBC)', sampleType: 'EDTA whole blood',
  methodName: 'Impedance with hydrodynamic focussing', automation: 'automated', equipmentId: analyser.id,
  components: [
    { testName: 'WBC' }, { testName: 'RBC' }, { testName: 'HB' }, { testName: 'HCT' },
    { testName: 'MCV' }, { testName: 'MCH' }, { testName: 'MCHC' }, { testName: 'PLT' },
  ],
} });
check('the panel and its eight parameters are on the menu', panel.status === 201, JSON.stringify(panel.json));

// Things that belong to no panel, which must not be affected by any of this.
for (const name of ['Malaria RDT', 'Sickling', 'Peripheral blood film comments']) {
  const made = await j(`/section-config/sections/${sec.id}/tests`, { token: A, method: 'POST', body: {
    testName: name, automation: 'manual',
  } });
  check(`"${name}" is on the menu as a standalone test`, made.status === 201, JSON.stringify(made.json));
}

const menu = (await j(`/section-config/sections/${sec.id}`, { token: A })).json?.tests ?? [];
check('the menu itself still holds all twelve rows', menu.length === 12, `${menu.length}`);
check('eight of them are the panel’s components',
  menu.filter(t => t.parent_test_id).length === 8,
  JSON.stringify(menu.map(t => [t.test_name, t.is_panel, t.parent_test_id])));

/* ================================= 2. the control board shows tests, not parameters */
console.log('\n[2] The quality-control board shows what a control is actually run for');
const coverage = (await j(`/iqc/portal/coverage?sectionId=${sec.id}`, { token: A })).json;
const names = (coverage?.tests ?? []).map(t => t.testName);
check('the panel is on the board', names.some(n => /Full Blood Count/i.test(n)), JSON.stringify(names));
check('its parameters are not listed beside it',
  !names.some(n => ['WBC', 'RBC', 'HB', 'HCT', 'MCV', 'MCH', 'MCHC', 'PLT'].includes(String(n).trim())),
  JSON.stringify(names));
check('every standalone test is still there',
  ['Malaria RDT', 'Sickling', 'Peripheral blood film comments'].every(n => names.includes(n)),
  JSON.stringify(names));
check('so the board counts four tests, not twelve', Number(coverage?.counts?.tests) === 4,
  JSON.stringify(coverage?.counts));
check('and all four are uncontrolled, which is the truth before any control exists',
  Number(coverage?.counts?.uncovered) === 4, JSON.stringify(coverage?.counts));

/* ================================ 3. a control for the panel covers the panel */
console.log('\n[3] One control for the panel, and the board says the panel is covered');
const control = await j('/iqc/materials', { token: A, method: 'POST', body: {
  materialName: `XN CHECK ${stamp}`, testName: 'Full Blood Count (FBC)', lotNumber: `XN-${stamp}`,
  levelLabel: 'Level 1 (Low)', source: 'commercial', controlType: 'quantitative', qcFrequency: 'daily',
  sectionId: sec.id, equipmentId: analyser.id,
  analytes: [
    { analyte: 'WBC', unit: '10^9/L', targetMean: 3.21, targetSd: 0.16 },
    { analyte: 'HB', unit: 'g/dL', targetMean: 6.2, targetSd: 0.2 },
    { analyte: 'PLT', unit: '10^9/L', targetMean: 61, targetSd: 6 },
  ],
} });
check('the control is defined for the panel', control.status === 201, JSON.stringify(control.json));

const after = (await j(`/iqc/portal/coverage?sectionId=${sec.id}`, { token: A })).json;
const fbc = (after?.tests ?? []).find(t => /Full Blood Count/i.test(t.testName));
check('the panel now reads as covered', fbc?.covered === true, JSON.stringify(fbc));
check('by the one control, carrying its three parameters',
  fbc?.controls?.length === 1 && fbc.controls[0].analytes === 3, JSON.stringify(fbc?.controls));
check('one test covered, three still without', Number(after?.counts?.covered) === 1
  && Number(after?.counts?.uncovered) === 3, JSON.stringify(after?.counts));
check('and nothing is reported as a control for a test not on the menu',
  (after?.unlisted ?? []).length === 0, JSON.stringify(after?.unlisted));

/* ================= 4. a unit with no panels at all is exactly as it was */
console.log('\n[4] A unit whose menu has no panels is untouched');
const plain = (await j('/section-config/sections', { token: A, method: 'POST', body: {
  name: `Serology ${stamp}`, code: `SR${String(stamp).slice(-6)}`,
} })).json;
for (const name of ['Abbott Bioline HIV test', 'OraQuick HIV test', 'Standard Q HIV antibody test']) {
  await j(`/section-config/sections/${plain.id}/tests`, { token: A, method: 'POST', body: {
    testName: name, automation: 'manual',
  } });
}
const plainCoverage = (await j(`/iqc/portal/coverage?sectionId=${plain.id}`, { token: A })).json;
check('all three standalone tests are on its board', Number(plainCoverage?.counts?.tests) === 3,
  JSON.stringify((plainCoverage?.tests ?? []).map(t => t.testName)));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
