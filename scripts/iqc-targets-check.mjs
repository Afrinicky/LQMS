/**
 * The control that arrives without an SD.
 *
 * This is the ordinary case, not the edge one: most commercial inserts give an
 * assayed mean and an acceptable range and no standard deviation, because the
 * SD belongs to the instrument and the operators, not to the vial. An in-house
 * control arrives with neither. Before this, such a control could be defined
 * and run and would judge nothing — no z score, no Westgard, and a
 * Levey-Jennings chart with nothing to draw.
 *
 * What is checked here is that the laboratory's own SD gets established the way
 * CLSI C24 and ISO 15189:2022 §7.3.7.2 say it should, and that everything
 * downstream then behaves as if it had been there all along.
 *
 *   node scripts/iqc-targets-check.mjs
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
if (!st.json?.setupComplete) await j('/setup/initialize', { method: 'POST', body: { facilityName: 'IQC Lab', username: 'admin', password: PW, fullName: 'Admin User' } });
const A = (await j('/auth/login', { method: 'POST', body: { username: 'admin', password: PW } })).json.token;
const day = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const stamp = Date.now();

/* ============================================================ 1. no SD at all */
console.log('\n[1] A control defined the way the insert actually reads: a mean, a range, no SD');
const made = await j('/iqc/materials', { token: A, method: 'POST', body: {
  materialName: `Chemistry Control L1 ${stamp}`, testName: `Serum glucose ${stamp}`,
  lotNumber: `CC-${stamp}`, levelLabel: 'Level 1', source: 'commercial',
  controlType: 'quantitative', ruleProfile: 'westgard_standard', expiryDate: day(-365),
  analytes: [{ analyte: 'Glucose', unit: 'mmol/L', targetMean: 5.5, acceptableLow: 4.5, acceptableHigh: 6.5, decimalPlaces: 2 }],
} });
check('a control with no SD is accepted, not refused', made.status === 201, JSON.stringify(made.json));
const materialId = made.json.id;
const analyte = (await j(`/iqc/materials/${materialId}/analytes`, { token: A })).json[0];
check('its parameter genuinely carries no SD', analyte.target_sd === null, String(analyte.target_sd));

const targetsAtStart = await j(`/iqc/materials/${materialId}/targets`, { token: A });
check('the targets view says where it stands', targetsAtStart.status === 200, JSON.stringify(targetsAtStart.json));
check('and that no limits are in force yet', targetsAtStart.json.analytes[0].source === 'none', targetsAtStart.json.analytes[0].source);
check('naming the requirement as 20 over 20 days',
  targetsAtStart.json.requirement.points === 20 && targetsAtStart.json.requirement.days === 20,
  JSON.stringify(targetsAtStart.json.requirement));

/* ============================== 2. runs against a control with no limits yet */
console.log('\n[2] It still controls something in the meantime');
const runOn = (date, value) => j('/iqc/runs', { token: A, method: 'POST', body: {
  iqcMaterialId: materialId, runDate: date, readings: [{ analyteId: analyte.id, value }],
} });

let r = await runOn(day(40), 5.5);
check('a run is accepted with no SD in force', r.status === 201, JSON.stringify(r.json));
check('and is judged in control', r.json.status === 'in_control', String(r.json.status));

r = await runOn(day(39), 9.9);   // far outside the acceptable range
check('a value outside the acceptable range is still rejected',
  r.json.status === 'out_of_control', JSON.stringify(r.json.ruleSummary));
check('so patient results are withheld', r.json.mayReleasePatientResults === false);

/* ================================== 3. too little data establishes nothing */
console.log('\n[3] Limits are not established from too little data');
const early = await j(`/iqc/materials/${materialId}/establish-targets`, { token: A, method: 'POST', body: {} });
check('establishing from three runs changes nothing', early.json.changed === 0, JSON.stringify(early.json));
check('and says how far short it is', /of 20 results needed/.test(early.json.outcomes[0].reason ?? ''), early.json.outcomes[0].reason);

/* ================================================== 4. interim, then definitive */
console.log('\n[4] Twenty results over five days: interim limits (CLSI C24)');
// Twenty results spread over only five separate days: enough points, not
// enough days, which is exactly the interim case.
const values = [5.48, 5.52, 5.55, 5.44, 5.61, 5.39, 5.57, 5.50, 5.46, 5.58,
                5.43, 5.53, 5.60, 5.41, 5.56, 5.49, 5.47, 5.54, 5.51, 5.45];
for (let i = 0; i < 20; i++) await runOn(day(30 - (i % 5)), values[i]);

const interim = await j(`/iqc/materials/${materialId}/establish-targets`, { token: A, method: 'POST', body: {} });
check('an SD is established', interim.json.changed === 1, JSON.stringify(interim.json));
const it = interim.json.outcomes[0].target;
check('it is marked interim, not definitive', it.basis === 'interim', String(it.basis));
check('and flagged provisional', it.provisional === true, String(it.provisional));
check('the SD is a real number', typeof it.sd === 'number' && it.sd > 0, String(it.sd));
check('the vendor mean is kept, not replaced', Math.abs(it.mean - 5.5) < 1e-9, String(it.mean));
check('it says how many days short of definitive it is', it.daysShort > 0, String(it.daysShort));

console.log('\n[5] Twenty results over twenty days: the definitive set');
for (let i = 0; i < 20; i++) await runOn(day(200 + i), values[i]);
const settled = await j(`/iqc/materials/${materialId}/establish-targets`, { token: A, method: 'POST', body: {} });
const dt = settled.json.outcomes[0].target;
check('the basis becomes definitive', dt.basis === 'definitive', String(dt.basis));
check('and it is no longer provisional', dt.provisional === false, String(dt.provisional));
check('over at least twenty separate days', dt.days >= 20, String(dt.days));

/* ============================================ 6. the chart can now be drawn */
console.log('\n[6] The Levey-Jennings chart draws against the established limits');
const chart = await j(`/iqc/analytes/${analyte.id}/chart`, { token: A });
check('the chart returns a target mean', typeof chart.json.analyte.targetMean === 'number', String(chart.json.analyte.targetMean));
check('and a target SD it did not have before', typeof chart.json.analyte.targetSd === 'number', String(chart.json.analyte.targetSd));
check('nothing was entered on the definition', chart.json.analyte.enteredSd === null, String(chart.json.analyte.enteredSd));
check('and the chart says where the SD came from', chart.json.target.source === 'established', String(chart.json.target?.source));
check('with the number of results behind it', chart.json.target.n >= 20, String(chart.json.target?.n));

/* ======================================= 7. Westgard now actually evaluates */
console.log('\n[7] Westgard runs against limits the laboratory established');
const sd = chart.json.analyte.targetSd;
r = await runOn(day(1), 5.5 + 3.6 * sd);
check('a result beyond 3 SD is rejected as 1₃ₛ',
  r.json.analytes[0].rule === 'reject_1_3s', JSON.stringify(r.json.ruleSummary));
check('with a z score computed', typeof r.json.analytes[0].zScore === 'number', String(r.json.analytes[0].zScore));

/* ============================== 8. an entered SD is never quietly overwritten */
console.log('\n[8] A figure somebody entered is a decision, and outranks the calculation');
const vendor = await j('/iqc/materials', { token: A, method: 'POST', body: {
  materialName: `Vendor SD Control ${stamp}`, testName: `Vendor assay ${stamp}`,
  lotNumber: `VS-${stamp}`, source: 'commercial', controlType: 'quantitative',
  ruleProfile: 'westgard_standard', expiryDate: day(-365),
  analytes: [{ analyte: 'Analyte A', unit: 'U/L', targetMean: 100, targetSd: 5, acceptableLow: 80, acceptableHigh: 120 }],
} });
const vendorAnalyte = (await j(`/iqc/materials/${vendor.json.id}/analytes`, { token: A })).json[0];
for (let i = 0; i < 25; i++) {
  await j('/iqc/runs', { token: A, method: 'POST', body: {
    iqcMaterialId: vendor.json.id, runDate: day(120 + i),
    readings: [{ analyteId: vendorAnalyte.id, value: 100 + (i % 5) * 0.2 - 0.4 }],
  } });
}
const untouched = await j(`/iqc/materials/${vendor.json.id}/establish-targets`, { token: A, method: 'POST', body: {} });
check('the entered SD is left alone', untouched.json.changed === 0, JSON.stringify(untouched.json));
check('and the refusal says why', /already has an SD entered/.test(untouched.json.outcomes[0].reason ?? ''), untouched.json.outcomes[0].reason);
const stillVendor = await j(`/iqc/analytes/${vendorAnalyte.id}/chart`, { token: A });
check('the chart still uses the entered SD', stillVendor.json.analyte.targetSd === 5, String(stillVendor.json.analyte.targetSd));
check('and reports it as the vendor’s', stillVendor.json.target.source === 'vendor', String(stillVendor.json.target?.source));

const forced = await j(`/iqc/materials/${vendor.json.id}/establish-targets`, { token: A, method: 'POST', body: { force: true } });
check('asking explicitly recalculates it', forced.json.changed === 1, JSON.stringify(forced.json));

/* ========================================== 9. rejected runs stay out of it */
console.log('\n[9] A rejected run does not widen the limits it failed');
const before = (await j(`/iqc/materials/${materialId}/targets`, { token: A })).json.analytes[0];
await runOn(day(2), 30);           // grossly out; rejected on the range check
const after = (await j(`/iqc/materials/${materialId}/targets`, { token: A })).json.analytes[0];
check('the established SD is unchanged by a rejected run',
  Math.abs(Number(after.sd) - Number(before.sd)) < 1e-9, `${before.sd} -> ${after.sd}`);

/* ============================================= 10. the unit lookup a head needs */
console.log('\n[10] A unit can be named by somebody without settings rights');
const options = await j('/sections/options', { token: A });
check('the unit lookup is served', options.status === 200, JSON.stringify(options.json).slice(0, 120));
check('it returns the units', Array.isArray(options.json.sections), typeof options.json.sections);
check('and marks which one is the reader’s own', 'mine' in options.json, JSON.stringify(Object.keys(options.json)));

const anon = await j('/sections/options');
check('but not to somebody who is not signed in', anon.status === 401, String(anon.status));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
