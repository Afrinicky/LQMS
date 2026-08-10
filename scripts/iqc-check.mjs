/**
 * IQC: the two shapes of control a laboratory actually runs.
 *
 * A full blood count control — one vial, eight numeric parameters, Westgard.
 * A hepatitis B surface antigen control — one reactive result, matched against
 * what it is supposed to give. Both have to work without pretending to be the
 * other, which is the whole point of the redesign.
 *
 *   node scripts/iqc-check.mjs
 */
const BASE = process.env.API || 'http://127.0.0.1:4430/api';
const PW = 'thistle harbour crane';

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

/* ---------------------------------------------------- 1. quantitative: FBC */
console.log('\n[1] A quantitative control — FBC, one vial, several parameters');
const fbc = await j('/iqc/materials', { token: A, method: 'POST', body: {
  materialName: 'Haematology Control Normal', testName: 'Full blood count',
  lotNumber: 'HC-2026-04', levelLabel: 'Level 2 (Normal)', source: 'commercial',
  controlType: 'quantitative', ruleProfile: 'westgard_standard', qcFrequency: 'daily',
  manufacturer: 'Acme Diagnostics', expiryDate: day(-180),
  analytes: [
    { analyte: 'Haemoglobin', unit: 'g/dL', targetMean: 13.5, targetSd: 0.4, acceptableLow: 11, acceptableHigh: 16, decimalPlaces: 1 },
    { analyte: 'WBC', unit: '×10⁹/L', targetMean: 7.2, targetSd: 0.35, acceptableLow: 4, acceptableHigh: 11, decimalPlaces: 2 },
    { analyte: 'Platelets', unit: '×10⁹/L', targetMean: 250, targetSd: 18, acceptableLow: 150, acceptableHigh: 400, decimalPlaces: 0 },
  ],
} });
check('an FBC control is created', fbc.status === 201, JSON.stringify(fbc.json));
const fbcId = fbc.json.id;
const fbcAnalytes = (await j(`/iqc/materials/${fbcId}/analytes`, { token: A })).json;
check('it carries all three parameters', fbcAnalytes.length === 3, `${fbcAnalytes.length}`);
const hb = fbcAnalytes.find(a => a.analyte === 'Haemoglobin');
const wbc = fbcAnalytes.find(a => a.analyte === 'WBC');
const plt = fbcAnalytes.find(a => a.analyte === 'Platelets');

const runFbc = (date, values) => j('/iqc/runs', { token: A, method: 'POST', body: {
  iqcMaterialId: fbcId, runDate: date, readings: [
    { analyteId: hb.id, value: values[0] }, { analyteId: wbc.id, value: values[1] }, { analyteId: plt.id, value: values[2] },
  ],
} });

let r = await runFbc(day(20), [13.5, 7.2, 250]);
check('a run on target is in control', r.json.status === 'in_control', JSON.stringify(r.json.status));
check('one run covers every parameter', r.json.analytes.length === 3);
check('patient results may be released', r.json.mayReleasePatientResults === true);

r = await runFbc(day(19), [14.4, 7.2, 250]);  // Hb = +2.25 SD
check('one parameter beyond 2 SD raises a 1₂ₛ warning', r.json.status === 'warning' && r.json.analytes.find(a => a.analyte === 'Haemoglobin').rule === 'warning_1_2s', JSON.stringify(r.json.ruleSummary));
check('a warning does NOT stop patient results', r.json.mayReleasePatientResults === true);

r = await runFbc(day(18), [15.0, 7.2, 250]);  // Hb = +3.75 SD
check('beyond 3 SD is rejected as 1₃ₛ', r.json.analytes.find(a => a.analyte === 'Haemoglobin').rule === 'reject_1_3s', JSON.stringify(r.json.ruleSummary));
check('a rejection withholds patient results', r.json.mayReleasePatientResults === false);
check('the run as a whole is out of control', r.json.status === 'out_of_control');

// 2₂ₛ needs two consecutive accepted runs on the same side beyond 2 SD.
await runFbc(day(17), [14.45, 7.2, 250]);
r = await runFbc(day(16), [14.45, 7.2, 250]);
check('two consecutive beyond +2 SD is caught as 2₂ₛ',
  r.json.analytes.find(a => a.analyte === 'Haemoglobin').rule === 'reject_2_2s', JSON.stringify(r.json.ruleSummary));

// Two parameters in the SAME run beyond 2 SD on the same side → 2of3₂ₛ.
r = await j('/iqc/runs', { token: A, method: 'POST', body: {
  iqcMaterialId: fbcId, runDate: day(15),
  readings: [{ analyteId: wbc.id, value: 8.0 }, { analyteId: plt.id, value: 296 }],
} });
check('two parameters in one run beyond 2 SD is caught across the run',
  r.json.analytes.some(a => a.rule === 'reject_2of3_2s'), JSON.stringify(r.json.ruleSummary));

r = await runFbc(day(14), [20, 7.2, 250]);
check('outside the acceptable range is rejected regardless of SD',
  r.json.analytes.find(a => a.analyte === 'Haemoglobin').rule === 'out_of_range', JSON.stringify(r.json.ruleSummary));

/* ------------------------------------------------ 2. qualitative: HBsAg */
console.log('\n[2] A qualitative control — HBsAg, reactive or not');
const hbsag = await j('/iqc/materials', { token: A, method: 'POST', body: {
  materialName: 'HBsAg Positive Control', testName: 'Hepatitis B surface antigen',
  lotNumber: 'HB-2026-11', levelLabel: 'Positive control', source: 'commercial',
  controlType: 'qualitative', qcFrequency: 'per_kit', expiryDate: day(-90),
  analytes: [{ analyte: 'HBsAg', expectedResult: 'reactive' }],
} });
check('a qualitative control is created', hbsag.status === 201, JSON.stringify(hbsag.json));
const hbvId = hbsag.json.id;
const hbvAnalyte = (await j(`/iqc/materials/${hbvId}/analytes`, { token: A })).json[0];
check('it needs no mean or SD', hbvAnalyte.target_mean === null && hbvAnalyte.target_sd === null);
check('and carries its expected result instead', hbvAnalyte.expected_result === 'reactive');

const runHbv = (date, observed) => j('/iqc/runs', { token: A, method: 'POST', body: {
  iqcMaterialId: hbvId, runDate: date, readings: [{ analyteId: hbvAnalyte.id, qualitativeResult: observed }],
} });

r = await runHbv(day(10), 'reactive');
check('a positive control reading reactive passes', r.json.status === 'in_control', JSON.stringify(r.json));
check('patient results may be released', r.json.mayReleasePatientResults === true);

r = await runHbv(day(9), 'non_reactive');
check('the same control reading non-reactive FAILS', r.json.status === 'out_of_control', JSON.stringify(r.json.ruleSummary));
check('and is reported as a mismatch, not a z-score', r.json.analytes[0].rule === 'expected_mismatch');
check('and withholds patient results', r.json.mayReleasePatientResults === false);
check('no z-score is invented for it', r.json.analytes[0].zScore === null);

const hbvMaterial = (await j('/iqc/materials', { token: A })).json.find(m => m.id === hbvId);
check('the rule profile is forced to expected-match', hbvMaterial.rule_profile === 'match_expected', hbvMaterial.rule_profile);

/* --------------------------------------------------- 3. in-house control */
console.log('\n[3] An in-house control must document its own provenance');
const bad = await j('/iqc/materials', { token: A, method: 'POST', body: {
  materialName: 'Pooled Serum Control', testName: 'Glucose', lotNumber: 'IH-01',
  source: 'in_house', controlType: 'quantitative',
  analytes: [{ analyte: 'Glucose', targetMean: 5.5, targetSd: 0.2 }],
} });
check('one without a preparation method is refused', bad.status === 400, `got ${bad.status}`);
const good = await j('/iqc/materials', { token: A, method: 'POST', body: {
  materialName: 'Pooled Serum Control', testName: 'Glucose', lotNumber: 'IH-01',
  source: 'in_house', controlType: 'quantitative',
  preparationMethod: 'Pooled from 20 residual sera, filtered, aliquoted 0.5 mL, stored at −20 °C',
  baseMaterial: 'Residual patient serum', validationSummary: 'Assigned against 20 runs on the reference analyser',
  analytes: [{ analyte: 'Glucose', unit: 'mmol/L', targetMean: 5.5, targetSd: 0.2 }],
} });
check('with it, the control is accepted', good.status === 201, JSON.stringify(good.json));

/* --------------------------------------------- 4. chart and statistics */
console.log('\n[4] The Levey-Jennings chart carries real statistics');
const chart = (await j(`/iqc/analytes/${hb.id}/chart`, { token: A })).json;
check('the chart returns points', Array.isArray(chart.points) && chart.points.length > 0, `${chart.points?.length}`);
check('with the target it is measured against', chart.analyte.targetMean === 13.5 && chart.analyte.targetSd === 0.4);
check('an observed mean is computed', typeof chart.statistics.mean === 'number', JSON.stringify(chart.statistics));
check('an observed SD is computed', typeof chart.statistics.sd === 'number');
check('CV% is computed', typeof chart.statistics.cv === 'number');
check('bias against target is computed', typeof chart.statistics.bias === 'number');
check('SD index is computed', typeof chart.statistics.sdIndex === 'number');
check('rejections are marked on the series', chart.points.some(p => p.rule_violation && p.rule_violation.startsWith('reject_')));

/* --------------------------------------------------- 5. run governance */
console.log('\n[5] A failed run cannot simply be signed off');
const failed = (await j('/iqc/runs?status=out_of_control', { token: A })).json[0];
const noAction = await j(`/iqc/runs/${failed.id}/review`, { token: A, method: 'POST', body: {} });
check('signing off a failure without an action is refused', noAction.status === 400, `got ${noAction.status}`);
const withAction = await j(`/iqc/runs/${failed.id}/review`, { token: A, method: 'POST', body: { correctiveAction: 'Recalibrated, repeated in control, patient run repeated' } });
check('recording what was done allows sign-off', withAction.status === 200);
const withheld = await j(`/iqc/runs/${failed.id}/release`, { token: A, method: 'POST', body: { released: false } });
check('withholding results without a reason is refused', withheld.status === 400, `got ${withheld.status}`);

/* --------------------------------------------------- 6. guard rails */
console.log('\n[6] Guard rails');
const expired = await j('/iqc/materials', { token: A, method: 'POST', body: {
  materialName: 'Expired Control', testName: 'Glucose', lotNumber: 'EX-1',
  source: 'commercial', controlType: 'quantitative', expiryDate: day(30),
  analytes: [{ analyte: 'Glucose', targetMean: 5, targetSd: 0.2 }],
} });
const expRun = await j('/iqc/runs', { token: A, method: 'POST', body: {
  iqcMaterialId: expired.json.id, runDate: day(0),
  readings: [{ analyteId: (await j(`/iqc/materials/${expired.json.id}/analytes`, { token: A })).json[0].id, value: 5 }],
} });
check('an expired lot cannot be run', expRun.status === 400, `got ${expRun.status}`);

const noAnalytes = await j('/iqc/runs', { token: A, method: 'POST', body: { iqcMaterialId: 999999, runDate: day(0), readings: [] } });
check('an unknown control is refused', noAnalytes.status === 404 || noAnalytes.status === 400);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
