/**
 * Running a previously tested sample when the control material has run out.
 *
 * The scenario this exists for: the haematology control is finished, the
 * replacement has not arrived, and the analyser still has to be controlled
 * before patient results go out. A sample the laboratory already tested — on a
 * day its controls were in control — is re-read, and the question asked of it
 * is narrower than the one asked of a control: does the analyser still give the
 * answer it gave before, within the difference the control allows.
 *
 * What is checked here is that the re-read is judged against the ORIGINAL
 * result and not against the control's target, that it carries the link back
 * to the control run that covered the sample, and — the part that would quietly
 * corrupt everything — that a patient sample's numbers never enter the control
 * material's own chart, mean or SD.
 *
 *   node scripts/iqc-retained-check.mjs
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

/* ------------------------------------------------ 1. a control and its lot */
console.log('\n[1] A quantitative control, with a re-read tolerance on it');
const made = await j('/iqc/materials', { token: A, method: 'POST', body: {
  materialName: `Retained FBC Control ${stamp}`, testName: 'Full blood count',
  lotNumber: `RT-${stamp}`, source: 'commercial', controlType: 'quantitative',
  ruleProfile: 'westgard_standard', qcFrequency: 'daily', expiryDate: day(-120),
  continuityToleranceKind: 'percent', continuityToleranceValue: 10,
  analytes: [
    { analyte: 'Haemoglobin', unit: 'g/dL', targetMean: 13.5, targetSd: 0.4, decimalPlaces: 1 },
    // Its own figure, because 10% of a platelet count is not the same judgement.
    { analyte: 'Platelets', unit: '10^9/L', targetMean: 250, targetSd: 12, decimalPlaces: 0, continuityTolerance: '15' },
  ],
} });
check('the control is defined', made.status === 201, JSON.stringify(made.json));
const materialId = made.json?.id;
const analytes = (await j(`/iqc/materials/${materialId}/analytes`, { token: A })).json ?? [];
const hb = analytes.find(a => a.analyte === 'Haemoglobin');
const plt = analytes.find(a => a.analyte === 'Platelets');
check('the control carries a re-read tolerance', made.status === 201 && analytes.length === 2);
check('an analyte may carry its own', plt?.continuity_tolerance_value === 15 && plt?.continuity_tolerance_kind === 'absolute');
check('and one that names none falls back to the control’s', hb?.continuity_tolerance_value === null);

/* ------------------------------ 2. the control run the sample traces back to */
console.log('\n[2] The control run that covered the sample');
const covering = await j('/iqc/runs', { token: A, method: 'POST', body: {
  iqcMaterialId: materialId, runDate: day(9), runTime: '08:10',
  readings: [{ analyteId: hb.id, value: 13.5 }, { analyteId: plt.id, value: 250 }],
} });
check('a control run is recorded and in control', covering.json?.status === 'in_control', JSON.stringify(covering.json));
const coverage = await j(`/iqc/materials/${materialId}/retained-coverage?on=${day(9)}`, { token: A });
check('and is offered as the run a sample can be traced to', Array.isArray(coverage.json) && coverage.json.some(r => r.id === covering.json.id));

/* ---------------------------------------------- 3. enrolling the sample */
console.log('\n[3] Putting a previously run sample on the register');
const noValues = await j('/iqc/retained-samples', { token: A, method: 'POST', body: {
  iqcMaterialId: materialId, sampleReference: 'LAB-0001', originalRunDate: day(9), values: [],
} });
check('a sample with no original result is refused', noValues.status === 400);

const future = await j('/iqc/retained-samples', { token: A, method: 'POST', body: {
  iqcMaterialId: materialId, sampleReference: 'LAB-0001', originalRunDate: day(-5),
  values: [{ analyteId: hb.id, originalValue: 13.4 }],
} });
check('a sample first tested in the future is refused', future.status === 400);

const enrolled = await j('/iqc/retained-samples', { token: A, method: 'POST', body: {
  iqcMaterialId: materialId, sampleReference: 'LAB-0001', sampleType: 'EDTA whole blood',
  originalRunDate: day(9), originalRunTime: '09:20', originalIqcRunId: covering.json.id,
  reason: 'Control lot finished; replacement not yet delivered',
  values: [{ analyteId: hb.id, originalValue: 13.4 }, { analyteId: plt.id, originalValue: 246 }],
} });
check('a sample with its original result is accepted', enrolled.status === 201, JSON.stringify(enrolled.json));
const sampleId = enrolled.json?.id;

const detail = (await j(`/iqc/retained-samples/${sampleId}`, { token: A })).json;
check('it keeps the original result', detail?.values?.find(v => v.iqc_analyte_id === hb.id)?.original_value === 13.4);
check('and names the control run that covered it', detail?.original_run_number === covering.json.runNumber);
check('and says that control run was in control', detail?.original_control_status === 'in_control');
check('and why the sample is being used', String(detail?.reason ?? '').includes('Control lot finished'));

const register = (await j(`/iqc/materials/${materialId}/retained-samples`, { token: A })).json;
check('it appears on the control’s register', Array.isArray(register) && register.some(s => s.id === sampleId));

/* ----------------------------------------------------- 4. the re-read */
console.log('\n[4] Re-reading the sample in place of the control');
const within = await j('/iqc/runs', { token: A, method: 'POST', body: {
  iqcMaterialId: materialId, runKind: 'retained_sample', retainedSampleId: sampleId,
  runDate: day(1), runTime: '08:05',
  readings: [{ analyteId: hb.id, value: 13.9 }, { analyteId: plt.id, value: 252 }],
} });
check('a re-read close to the original passes', within.json?.status === 'in_control', JSON.stringify(within.json));
check('and patient results are not withheld', within.json?.mayReleasePatientResults === true);
const hbLine = within.json?.analytes?.find(a => a.analyteId === hb.id);
check('the comparison is against the original, not the target', hbLine?.originalValue === 13.4);
check('and the difference is recorded', Math.abs((hbLine?.deviation ?? 0) - 0.5) < 1e-9);
check('as a percentage too', Math.abs((hbLine?.deviationPercent ?? 0) - 3.731) < 0.01);

const outside = await j('/iqc/runs', { token: A, method: 'POST', body: {
  iqcMaterialId: materialId, runKind: 'retained_sample', retainedSampleId: sampleId,
  runDate: day(1), runTime: '14:05',
  // 15.6 is +16.4% on 13.4, past the control's 10%. 250 is 4 off 246, inside
  // the platelet analyte's own figure of 15, so only one parameter fails.
  readings: [{ analyteId: hb.id, value: 15.6 }, { analyteId: plt.id, value: 250 }],
} });
check('a re-read beyond the allowed difference fails', outside.json?.status === 'out_of_control', JSON.stringify(outside.json));
check('and withholds patient results', outside.json?.mayReleasePatientResults === false);
const failed = outside.json?.analytes?.find(a => a.analyteId === hb.id);
check('naming the difference, not a Westgard rule', failed?.rule === 'continuity_out_of_tolerance');
check('the analyte with its own wider figure still passes',
  outside.json?.analytes?.find(a => a.analyteId === plt.id)?.status === 'accepted');
check('no z-score is invented for a re-read', failed?.zScore === null);

const listed = (await j('/iqc/runs?materialId=' + materialId, { token: A })).json ?? [];
const reread = listed.find(r => r.id === within.json.id);
check('the run register says what it was performed on', reread?.run_kind === 'retained_sample');
check('and names the sample', reread?.retained_sample_reference === 'LAB-0001');

/* -------------------------------- 5. the control's own statistics are safe */
console.log('\n[5] A patient sample never becomes a point on the control’s chart');
const chart = (await j(`/iqc/analytes/${hb.id}/chart`, { token: A })).json;
const chartValues = (chart?.points ?? []).map(p => Number(p.result_value));
check('the chart holds the control run', chartValues.includes(13.5));
check('and not the re-read', !chartValues.includes(13.9) && !chartValues.includes(15.6));
const targets = (await j(`/iqc/materials/${materialId}/targets`, { token: A })).json;
const hbTarget = targets?.analytes?.find(a => a.id === hb.id);
check('and the re-reads are not counted towards establishing a mean and SD', hbTarget?.usableResults === 1,
  JSON.stringify(hbTarget));

/* ------------------------------------------------------ 6. a qualitative one */
console.log('\n[6] A qualitative control: the sample has to give the same answer');
const qual = await j('/iqc/materials', { token: A, method: 'POST', body: {
  materialName: `Retained MTB Control ${stamp}`, testName: 'MTB',
  lotNumber: `RTQ-${stamp}`, source: 'commercial', controlType: 'qualitative',
  qcFrequency: 'per_kit', expiryDate: day(-60),
  analytes: [{ analyte: 'MTB', expectedResult: 'detected' }],
} });
const qualId = qual.json?.id;
const qualAnalyte = ((await j(`/iqc/materials/${qualId}/analytes`, { token: A })).json ?? [])[0];
const qualSample = await j('/iqc/retained-samples', { token: A, method: 'POST', body: {
  iqcMaterialId: qualId, sampleReference: 'LAB-0099', originalRunDate: day(6),
  values: [{ analyteId: qualAnalyte.id, originalQualitativeResult: 'detected' }],
} });
check('a qualitative sample keeps the result it originally gave', qualSample.status === 201, JSON.stringify(qualSample.json));

const same = await j('/iqc/runs', { token: A, method: 'POST', body: {
  iqcMaterialId: qualId, runKind: 'retained_sample', retainedSampleId: qualSample.json.id,
  runDate: day(0), readings: [{ analyteId: qualAnalyte.id, qualitativeResult: 'detected' }],
} });
check('reproducing it passes', same.json?.status === 'in_control', JSON.stringify(same.json));

const different = await j('/iqc/runs', { token: A, method: 'POST', body: {
  iqcMaterialId: qualId, runKind: 'retained_sample', retainedSampleId: qualSample.json.id,
  runDate: day(0), readings: [{ analyteId: qualAnalyte.id, qualitativeResult: 'not_detected' }],
} });
check('failing to reproduce it fails', different.json?.status === 'out_of_control');
check('as a mismatch with the original', different.json?.analytes?.[0]?.rule === 'continuity_mismatch');
check('and withholds patient results', different.json?.mayReleasePatientResults === false);

/* ------------------------------------------------------------ 7. guard rails */
console.log('\n[7] Guard rails');
// The whole scenario: the lot is out of date, the analyser still has to be
// controlled, and a sample the laboratory already tested stands in for it.
const spent = await j('/iqc/materials', { token: A, method: 'POST', body: {
  materialName: `Spent Control ${stamp}`, testName: 'Full blood count',
  lotNumber: `RTX-${stamp}`, source: 'commercial', controlType: 'quantitative',
  ruleProfile: 'westgard_standard', qcFrequency: 'daily', expiryDate: day(3),
  analytes: [{ analyte: 'Haemoglobin', unit: 'g/dL', targetMean: 13.5, targetSd: 0.4, decimalPlaces: 1 }],
} });
const spentHb = ((await j(`/iqc/materials/${spent.json.id}/analytes`, { token: A })).json ?? [])[0];
const spentSample = await j('/iqc/retained-samples', { token: A, method: 'POST', body: {
  iqcMaterialId: spent.json.id, sampleReference: 'LAB-0100', originalRunDate: day(10),
  values: [{ analyteId: spentHb.id, originalValue: 13.4 }],
} });

const expired = await j('/iqc/runs', { token: A, method: 'POST', body: {
  iqcMaterialId: spent.json.id, runDate: day(0),
  readings: [{ analyteId: spentHb.id, value: 13.5 }],
} });
check('an expired lot still cannot be run as a control', expired.status === 400);

const expiredRetained = await j('/iqc/runs', { token: A, method: 'POST', body: {
  iqcMaterialId: spent.json.id, runKind: 'retained_sample', retainedSampleId: spentSample.json.id,
  runDate: day(0), readings: [{ analyteId: spentHb.id, value: 13.5 }],
} });
check('but a sample may stand in for it, which is the point', expiredRetained.status === 201, JSON.stringify(expiredRetained.json));

const wrongControl = await j('/iqc/runs', { token: A, method: 'POST', body: {
  iqcMaterialId: qualId, runKind: 'retained_sample', retainedSampleId: sampleId,
  runDate: day(0), readings: [{ analyteId: qualAnalyte.id, qualitativeResult: 'detected' }],
} });
check('a sample cannot be re-read against another control', wrongControl.status === 404);

const beforeOriginal = await j('/iqc/runs', { token: A, method: 'POST', body: {
  iqcMaterialId: materialId, runKind: 'retained_sample', retainedSampleId: sampleId,
  runDate: day(30), readings: [{ analyteId: hb.id, value: 13.5 }],
} });
check('a re-read cannot predate the original test', beforeOriginal.status === 400);

const noSample = await j('/iqc/runs', { token: A, method: 'POST', body: {
  iqcMaterialId: materialId, runKind: 'retained_sample',
  runDate: day(0), readings: [{ analyteId: hb.id, value: 13.5 }],
} });
check('and a re-read with no sample named is refused', noSample.status === 400);

const rejectedCoverage = await j('/iqc/retained-samples', { token: A, method: 'POST', body: {
  iqcMaterialId: materialId, sampleReference: 'LAB-0002', originalRunDate: day(1),
  originalIqcRunId: 999999, values: [{ analyteId: hb.id, originalValue: 13.4 }],
} });
check('a sample cannot be traced to a control run that is not this control’s', rejectedCoverage.status === 400);

const retire = await j(`/iqc/retained-samples/${sampleId}`, { token: A, method: 'DELETE' });
check('a sample that has been re-read is retired, not erased', retire.json?.retired === true);
const afterRetire = (await j(`/iqc/materials/${materialId}/retained-samples`, { token: A })).json;
check('and drops off the list offered for a re-read', !afterRetire.some(s => s.id === sampleId));
const retiredRun = await j('/iqc/runs', { token: A, method: 'POST', body: {
  iqcMaterialId: materialId, runKind: 'retained_sample', retainedSampleId: sampleId,
  runDate: day(0), readings: [{ analyteId: hb.id, value: 13.5 }],
} });
check('and cannot be re-read any more', retiredRun.status === 400);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
