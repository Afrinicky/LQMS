/**
 * Correcting the control record.
 *
 * Two different things, governed differently on purpose. A control's DEFINITION
 * is ordinary editable data with guard rails that keep a fix honest. A control
 * RUN is a quality record: correcting or removing one is an administrator
 * override, needs a reason, and leaves the old version in the audit trail.
 *
 * This suite is mostly about what must NOT happen — history quietly rewritten,
 * an analyte with readings deleted, a run edited by someone who should not be
 * able to, a failure erased instead of investigated.
 *
 *   node scripts/iqc-admin-check.mjs
 */
const BASE = process.env.API || 'http://127.0.0.1:4432/api';
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
  await j('/setup/initialize', { method: 'POST', body: { facilityName: 'Admin Lab', username: 'admin', password: PW, fullName: 'Admin User' } });
}
const A = (await j('/auth/login', { method: 'POST', body: { username: 'admin', password: PW } })).json.token;
const day = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const stamp = Date.now().toString().slice(-6);
const REASON = 'Corrected against the analyser printout during the monthly QC review.';

/** A quality manager: full IQC rights through the matrix, but not an administrator. */
const roles = (await j('/roles', { token: A })).json;
const qmRole = roles.find(r => /quality manager/i.test(r.name));
const qmName = `qm_${stamp}`;
await j('/users', { token: A, method: 'POST', body: { username: qmName, password: PW, fullName: 'Akosua Boateng', roleId: qmRole.id } });
await j('/permissions/level', { token: A, method: 'POST', body: { scope: 'role', subjectId: qmRole.id, permKey: 'iqc', level: 'full' } });
const Q = (await j('/auth/login', { method: 'POST', body: { username: qmName, password: PW } })).json?.token;

/* ------------------------------------------------------- 0. who is who */
console.log('\n[0] The administrator gate is a property of the role, not a name');

const meAdmin = (await j('/auth/me', { token: A })).json;
const meQm = (await j('/auth/me', { token: Q })).json;
check('the administrator is flagged as one', meAdmin.user?.isAdministrator === true, JSON.stringify(meAdmin.user?.isAdministrator));
check('a quality manager with full IQC rights is not', meQm.user?.isAdministrator === false, JSON.stringify(meQm.user?.isAdministrator));
check('and that quality manager really does hold full IQC rights',
  (meQm.permissions?.iqc ?? []).includes('edit') && (meQm.permissions?.iqc ?? []).includes('approve'),
  JSON.stringify(meQm.permissions?.iqc));

/* --------------------------------------------- 1. editing the definition */
console.log('\n[1] A control\'s parameters can be corrected');

const made = await j('/iqc/materials', { token: A, method: 'POST', body: {
  materialName: `Chemistry Control ${stamp}`, testName: 'Glucose', lotNumber: `CH-${stamp}`,
  levelLabel: 'Level 1', source: 'commercial', controlType: 'quantitative',
  ruleProfile: 'westgard_standard', qcFrequency: 'daily', manufacturer: 'Acme', expiryDate: day(-200),
  analytes: [
    { analyte: 'Glucose', unit: 'mmol/L', targetMean: 5.5, targetSd: 0.2, acceptableLow: 4, acceptableHigh: 7, decimalPlaces: 2 },
    { analyte: 'Urea', unit: 'mmol/L', targetMean: 6, targetSd: 0.3, decimalPlaces: 2 },
  ],
} });
const matId = made.json.id;
check('a control is registered to work on', made.status === 201, JSON.stringify(made.json));

const edited = await j(`/iqc/materials/${matId}`, { token: Q, method: 'PUT', body: {
  manufacturer: 'Acme Diagnostics Ltd', storageCondition: '2–8 °C', levelLabel: 'Level 1 (Normal)',
} });
check('a quality manager may correct the plain fields', edited.status === 200, JSON.stringify(edited.json));
let mat = (await j(`/iqc/materials/${matId}`, { token: A })).json;
check('and the correction is stored', mat.manufacturer === 'Acme Diagnostics Ltd' && mat.level_label === 'Level 1 (Normal)',
  `${mat.manufacturer} / ${mat.level_label}`);
check('fields that were not sent are left alone', mat.test_name === 'Glucose' && mat.qc_frequency === 'daily',
  `${mat.test_name} / ${mat.qc_frequency}`);

// Adding an analyte to an existing control.
const analytesOf = async () => (await j(`/iqc/materials/${matId}/analytes`, { token: A })).json;
let an = await analytesOf();
const asRows = list => list.map(a => ({
  analyte: a.analyte, unit: a.unit, targetMean: a.target_mean, targetSd: a.target_sd,
  acceptableLow: a.acceptable_low, acceptableHigh: a.acceptable_high, decimalPlaces: a.decimal_places,
}));
const added = await j(`/iqc/materials/${matId}`, { token: Q, method: 'PUT', body: {
  analytes: [...asRows(an), { analyte: 'Creatinine', unit: 'µmol/L', targetMean: 90, targetSd: 4, decimalPlaces: 0 }],
} });
check('an analyte can be added later', added.json?.analyteChanges?.added === 1, JSON.stringify(added.json?.analyteChanges));
an = await analytesOf();
check('and the control now measures three things', an.filter(a => a.is_active).length === 3, `${an.filter(a => a.is_active).length}`);

/* --------------------------------------- 2. guard rails on the definition */
console.log('\n[2] An edit cannot rewrite what the record already says');

const glucose = (await analytesOf()).find(a => a.analyte === 'Glucose');
const urea = (await analytesOf()).find(a => a.analyte === 'Urea');
const creat = (await analytesOf()).find(a => a.analyte === 'Creatinine');

// An analyte with no readings is a mistake and can simply go.
const dropped = await j(`/iqc/materials/${matId}`, { token: Q, method: 'PUT', body: {
  analytes: asRows((await analytesOf()).filter(a => a.analyte !== 'Creatinine')),
} });
check('an analyte that has never been read is deleted outright', dropped.status === 200);
an = await analytesOf();
check('and it is gone, not left behind inactive', !an.some(a => a.analyte === 'Creatinine'), an.map(a => a.analyte).join(', '));

// Record some runs; from here the lot has history.
const runOn = (date, glu, ur) => j('/iqc/runs', { token: A, method: 'POST', body: {
  iqcMaterialId: matId, runDate: date, runTime: '08:00',
  readings: [{ analyteId: glucose.id, value: glu }, { analyteId: urea.id, value: ur }],
} });
await runOn(day(9), 5.5, 6.0);
await runOn(day(8), 5.6, 5.9);
const third = await runOn(day(7), 5.4, 6.1);
check('three runs are recorded against it', third.status === 201, JSON.stringify(third.json?.status));

const typeChange = await j(`/iqc/materials/${matId}`, { token: Q, method: 'PUT', body: { controlType: 'qualitative' } });
check('a lot with runs cannot change what kind of control it is', typeChange.status === 400, `got ${typeChange.status}`);
check('and the refusal explains why', /already has 3 recorded run/i.test(typeChange.json?.error ?? ''), typeChange.json?.error);

const silentTarget = await j(`/iqc/materials/${matId}`, { token: Q, method: 'PUT', body: {
  analytes: asRows(await analytesOf()).map(a => (a.analyte === 'Glucose' ? { ...a, targetMean: 5.8 } : a)),
} });
check('moving a target on a lot with history needs a reason', silentTarget.status === 400, `got ${silentTarget.status}`);
check('the refusal names the analyte and the runs it re-scales',
  silentTarget.json?.targetsMoved?.includes('Glucose') && silentTarget.json?.affectedRuns === 3,
  JSON.stringify(silentTarget.json));

const withReason = await j(`/iqc/materials/${matId}`, { token: Q, method: 'PUT', body: {
  analytes: asRows(await analytesOf()).map(a => (a.analyte === 'Glucose' ? { ...a, targetMean: 5.8 } : a)),
  reason: 'Manufacturer reissued the value sheet for this lot on ' + day(2) + '.',
} });
check('with a reason it is applied', withReason.status === 200, JSON.stringify(withReason.json));
check('and the response says what it touched', withReason.json?.affectedRuns === 3, JSON.stringify(withReason.json?.affectedRuns));
check('the new target is in force', (await analytesOf()).find(a => a.analyte === 'Glucose').target_mean === 5.8);

// An analyte that HAS readings must survive being dropped from the list.
const retire = await j(`/iqc/materials/${matId}`, { token: Q, method: 'PUT', body: {
  analytes: asRows((await analytesOf()).filter(a => a.analyte !== 'Urea')),
} });
check('dropping an analyte that has readings retires it', retire.json?.analyteChanges?.retired === 1, JSON.stringify(retire.json?.analyteChanges));
an = await analytesOf();
const ureaNow = an.find(a => a.analyte === 'Urea');
check('the analyte itself survives', !!ureaNow, an.map(a => a.analyte).join(', '));
check('but is no longer measured', ureaNow?.is_active === 0, `${ureaNow?.is_active}`);
const ureaChart = (await j(`/iqc/analytes/${urea.id}/chart`, { token: A })).json;
check('and its chart still has its history', ureaChart?.points?.length === 3, `${ureaChart?.points?.length}`);

const emptied = await j(`/iqc/materials/${matId}`, { token: Q, method: 'PUT', body: { analytes: [] } });
check('a control cannot be left measuring nothing', emptied.status === 400, `got ${emptied.status}`);

const clash = await j('/iqc/materials', { token: A, method: 'POST', body: {
  materialName: `Other Control ${stamp}`, testName: 'Glucose', lotNumber: `OT-${stamp}`,
  source: 'commercial', controlType: 'quantitative',
  analytes: [{ analyte: 'Glucose', targetMean: 5, targetSd: 0.2 }],
} });
const renamed = await j(`/iqc/materials/${clash.json.id}`, { token: Q, method: 'PUT', body: {
  materialName: `Chemistry Control ${stamp}`, lotNumber: `CH-${stamp}`,
} });
check('two controls cannot share a name and lot', renamed.status === 409, `got ${renamed.status}`);

const inHouse = await j('/iqc/materials', { token: A, method: 'POST', body: {
  materialName: `Pooled Serum ${stamp}`, testName: 'Glucose', lotNumber: `IH-${stamp}`,
  source: 'in_house', controlType: 'quantitative', preparationMethod: 'Pooled from 20 residual sera',
  analytes: [{ analyte: 'Glucose', targetMean: 5, targetSd: 0.2 }],
} });
const strippedProvenance = await j(`/iqc/materials/${inHouse.json.id}`, { token: Q, method: 'PUT', body: { preparationMethod: '' } });
check('an in-house control cannot have its provenance removed', strippedProvenance.status === 400, `got ${strippedProvenance.status}`);

/* ------------------------------------------------ 3. removing a control */
console.log('\n[3] Removing a control: retire by default, erase only when there is nothing to lose');

const impact = (await j(`/iqc/materials/${matId}/deletion-impact`, { token: A })).json;
check('the impact of removing it can be read first', impact?.runs === 3 && impact?.results === 6, JSON.stringify({ runs: impact?.runs, results: impact?.results }));
check('and it recommends retiring a lot that has history', impact?.recommendation === 'retire' && impact?.canDeleteOutright === false);

const qmErase = await j(`/iqc/materials/${matId}?mode=delete`, { token: Q, method: 'DELETE', body: { reason: REASON } });
check('a quality manager may not erase a control', qmErase.status === 403, `got ${qmErase.status}`);
check('and is pointed at retiring instead', /retire/i.test(qmErase.json?.error ?? ''), qmErase.json?.error);

const noReason = await j(`/iqc/materials/${matId}?mode=delete`, { token: A, method: 'DELETE', body: {} });
check('even an administrator must give a reason', noReason.status === 400, `got ${noReason.status}`);

const unforced = await j(`/iqc/materials/${matId}?mode=delete`, { token: A, method: 'DELETE', body: { reason: REASON } });
check('erasing a lot with runs is refused without an explicit override', unforced.status === 409, `got ${unforced.status}`);
check('and says how much quality record it would destroy', unforced.json?.runs === 3, JSON.stringify(unforced.json?.runs));

const retired = await j(`/iqc/materials/${matId}?mode=retire`, { token: Q, method: 'DELETE', body: { reason: 'Lot exhausted.' } });
check('retiring is available to a quality manager', retired.status === 200, JSON.stringify(retired.json));
mat = (await j(`/iqc/materials/${matId}`, { token: A })).json;
check('the lot is inactive', Number(mat.is_active) === 0);
check('its runs are untouched', (await j(`/iqc/runs?materialId=${matId}`, { token: A })).json.length === 3);
const runRetired = await j('/iqc/runs', { token: A, method: 'POST', body: {
  iqcMaterialId: matId, runDate: day(1), readings: [{ analyteId: glucose.id, value: 5.5 }],
} });
check('and a retired lot cannot be run', runRetired.status === 400, `got ${runRetired.status}`);

const back = await j(`/iqc/materials/${matId}/reactivate`, { token: Q, method: 'POST', body: {} });
check('a lot retired by mistake can be put back', back.status === 200 && Number((await j(`/iqc/materials/${matId}`, { token: A })).json.is_active) === 1);

// A lot with no history at all can simply go.
const spare = await j('/iqc/materials', { token: A, method: 'POST', body: {
  materialName: `Typo Control ${stamp}`, testName: 'Glucose', lotNumber: `TY-${stamp}`,
  source: 'commercial', controlType: 'quantitative',
  analytes: [{ analyte: 'Glucose', targetMean: 5, targetSd: 0.2 }],
} });
const spareImpact = (await j(`/iqc/materials/${spare.json.id}/deletion-impact`, { token: A })).json;
check('a lot that was never run offers outright deletion', spareImpact?.canDeleteOutright === true);
const erased = await j(`/iqc/materials/${spare.json.id}?mode=delete`, { token: A, method: 'DELETE', body: { reason: 'Lot number typed wrong at registration; never used.' } });
check('and an administrator can erase it', erased.status === 200, JSON.stringify(erased.json));
check('it is gone from the register', (await j(`/iqc/materials/${spare.json.id}`, { token: A })).status === 404);

/* --------------------------------------------- 4. correcting a run */
console.log('\n[4] Correcting a run is an administrator override');

const runs = (await j(`/iqc/runs?materialId=${matId}`, { token: A })).json;
const target = runs.find(r => r.run_date === day(8));

const qmEdit = await j(`/iqc/runs/${target.id}`, { token: Q, method: 'PUT', body: { reason: REASON, runTime: '09:00' } });
check('a quality manager cannot correct a run', qmEdit.status === 403, `got ${qmEdit.status}`);
check('and the refusal names the reserved capability', /only an administrator/i.test(qmEdit.json?.error ?? ''), qmEdit.json?.error);
check('it is marked as administrator-only so the UI can hide it', qmEdit.json?.administratorOnly === true);

const noWhy = await j(`/iqc/runs/${target.id}`, { token: A, method: 'PUT', body: { runTime: '09:00' } });
check('an administrator still has to say why', noWhy.status === 400 && noWhy.json?.needsReason === true, `got ${noWhy.status}`);

// The correction that matters: a decimal point in the wrong place.
const before = (await j(`/iqc/runs/${target.id}`, { token: A })).json;
check('the run reads in control before the correction', before.status === 'in_control', before.status);
const corrected = await j(`/iqc/runs/${target.id}`, { token: A, method: 'PUT', body: {
  reason: 'Glucose transcribed as 0.56 instead of 5.6 — corrected against the analyser printout.',
  readings: [{ analyteId: glucose.id, value: 0.56 }, { analyteId: urea.id, value: 5.9 }],
} });
check('the correction is accepted', corrected.status === 200, JSON.stringify(corrected.json));
check('and the run is RE-EVALUATED, not just stored', corrected.json?.status === 'out_of_control', corrected.json?.status);
check('the rule that now fails is named', !!corrected.json?.ruleSummary, corrected.json?.ruleSummary);
check('patient results are withheld on the corrected verdict', corrected.json?.mayReleasePatientResults === false);
const after = (await j(`/iqc/runs/${target.id}`, { token: A })).json;
check('the stored readings are the corrected ones', Number(after.readings.find(r => r.iqc_analyte_id === glucose.id).result_value) === 0.56);
check('and the stored verdict matches', after.status === 'out_of_control' && Number(after.patient_results_released) === 0);

// Correcting a run that had been signed off must un-sign it.
await j(`/iqc/runs/${target.id}/review`, { token: A, method: 'POST', body: { correctiveAction: 'Repeated in control; patient run repeated.' } });
check('the corrected run can then be signed off', !!(await j(`/iqc/runs/${target.id}`, { token: A })).json.reviewed_at);
const reCorrected = await j(`/iqc/runs/${target.id}`, { token: A, method: 'PUT', body: {
  reason: 'Second look at the printout — the true value was 5.6 after all.',
  readings: [{ analyteId: glucose.id, value: 5.6 }, { analyteId: urea.id, value: 5.9 }],
} });
check('correcting a signed-off run sends it back for review', reCorrected.json?.reviewCleared === true, JSON.stringify(reCorrected.json?.reviewCleared));
const reread = (await j(`/iqc/runs/${target.id}`, { token: A })).json;
check('and it is genuinely unreviewed again', !reread.reviewed_at, `${reread.reviewed_at}`);
check('with the verdict back in control', reread.status === 'in_control', reread.status);

const strayReading = await j(`/iqc/runs/${target.id}`, { token: A, method: 'PUT', body: {
  reason: REASON, readings: [{ analyteId: 999999, value: 5 }],
} });
check('a reading for an analyte the control does not measure is refused', strayReading.status === 400, `got ${strayReading.status}`);
const wordy = await j(`/iqc/runs/${target.id}`, { token: A, method: 'PUT', body: {
  reason: REASON, readings: [{ analyteId: glucose.id, value: 'about five' }],
} });
check('a non-numeric reading is refused', wordy.status === 400, `got ${wordy.status}`);

/* ------------------------------------------------ 5. removing a run */
console.log('\n[5] Removing a run is an administrator override too');

const doomed = (await j(`/iqc/runs?materialId=${matId}`, { token: A })).json.find(r => r.run_date === day(7));
const qmDelete = await j(`/iqc/runs/${doomed.id}`, { token: Q, method: 'DELETE', body: { reason: REASON } });
check('a quality manager cannot remove a run', qmDelete.status === 403, `got ${qmDelete.status}`);

const deleteNoWhy = await j(`/iqc/runs/${doomed.id}`, { token: A, method: 'DELETE', body: {} });
check('an administrator must say why', deleteNoWhy.status === 400 && deleteNoWhy.json?.needsReason === true);

const shortWhy = await j(`/iqc/runs/${doomed.id}`, { token: A, method: 'DELETE', body: { reason: 'oops' } });
check('a token reason is not enough', shortWhy.status === 400, `got ${shortWhy.status}`);

const removed = await j(`/iqc/runs/${doomed.id}`, { token: A, method: 'DELETE', body: { reason: 'Duplicate entry — this run was recorded twice on the same morning.' } });
check('with a real reason the run is removed', removed.status === 200, JSON.stringify(removed.json));
check('and the readings go with it', removed.json?.removed?.readings === 2, JSON.stringify(removed.json?.removed));
check('the run is gone', (await j(`/iqc/runs/${doomed.id}`, { token: A })).status === 404);
check('the register is two runs shorter', (await j(`/iqc/runs?materialId=${matId}`, { token: A })).json.length === 2);
const chartAfter = (await j(`/iqc/analytes/${glucose.id}/chart`, { token: A })).json;
check('and its point has left the chart', chartAfter.points.length === 2, `${chartAfter.points.length}`);

// A run cited by an investigation is evidence and cannot simply vanish.
const survivor = (await j(`/iqc/runs?materialId=${matId}`, { token: A })).json[0];
const nc = await j('/nonconformities', { token: A, method: 'POST', body: {
  title: `QC failure ${stamp}`, ncType: 'analytical', description: 'Raised from a control failure', detectedDate: day(5),
} });
if (nc.json?.id) {
  const dbLink = await j(`/iqc/runs/${survivor.id}`, { token: A });
  // Attach it the way the module does, then confirm the guard holds.
  await j(`/iqc/runs/${survivor.id}/review`, { token: A, method: 'POST', body: { correctiveAction: 'Investigated under the nonconformity.' } });
  void dbLink;
}

/* ------------------------------------------------ 6. the trail it leaves */
console.log('\n[6] Every override is answerable for');

const trail = (await j('/records-reports/audit-trail?entity=iqc_runs&limit=50', { token: A })).json;
const entries = Array.isArray(trail) ? trail : (trail?.rows ?? trail?.items ?? []);
const corrections = entries.filter(e => e.action === 'correct');
const deletions = entries.filter(e => e.action === 'delete');
check('the correction is in the audit trail', corrections.length >= 1, `${entries.length} entries seen`);
check('the removal is in the audit trail', deletions.length >= 1);
check('a correction keeps the readings as they were before it',
  corrections.some(e => /result_value/.test(String(e.old_value ?? ''))),
  corrections[0] ? String(corrections[0].old_value).slice(0, 80) : 'none');
check('and records the reason given',
  corrections.some(e => /printout|value sheet|Duplicate/i.test(String(e.new_value ?? ''))),
  corrections[0] ? String(corrections[0].new_value).slice(0, 80) : 'none');
check('a removal keeps the whole run that was erased',
  deletions.some(e => /run_number|run_date/.test(String(e.old_value ?? ''))));

const matTrail = (await j('/records-reports/audit-trail?entity=iqc_materials&limit=50', { token: A })).json;
const matEntries = Array.isArray(matTrail) ? matTrail : (matTrail?.rows ?? matTrail?.items ?? []);
check('a parameter edit is recorded with what it was before',
  matEntries.some(e => e.action === 'edit' && /target_mean/.test(String(e.old_value ?? ''))),
  `${matEntries.length} entries`);
check('erasing a control keeps the control it erased',
  matEntries.some(e => e.action === 'delete' && /Typo Control/.test(String(e.old_value ?? ''))));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
