/**
 * The internal quality control programme, and the register it is read beside.
 *
 * What this establishes, in the order a laboratory meets it.
 *
 * THE PLAN. Every active control is in the programme from the day it was
 * registered, on the frequency it was registered with, without anybody
 * configuring anything. A schedule written over that one is what the
 * laboratory is then judged against — the days it names, the shifts it names,
 * and nothing before it starts.
 *
 * THE GAPS. A scheduled run nobody recorded is reported as missed, on its own
 * day. A day still to come is not. A run entered after the fact closes the day
 * it was performed on, not the day it was entered. A reason recorded for a day
 * accounts for it without pretending a control was run.
 *
 * THE COVERAGE. An examination on the unit's menu with no control is a gap,
 * and an examination deliberately left out is a decision with a ground, an
 * author and a review date — never silence.
 *
 * THE REGISTER'S FILTERS. The control picker offers every control the
 * laboratory has registered, not only the ones something has matched to; the
 * analyser picker offers feeds as well as links; a period matches only
 * transmissions with a date inside it; and a window opened for one control
 * shows that control's transmissions and no other's.
 *
 *   npm run api          (in one terminal)
 *   node scripts/iqc-programme-check.mjs
 */
const BASE = process.env.API || 'http://127.0.0.1:4430/api';
const PW = 'Passw0rd!test';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};
const section = name => console.log(`\n${name}\n${'-'.repeat(name.length)}`);

const j = async (p, o = {}) => {
  const headers = { 'Content-Type': 'application/json' };
  if (o.token) headers.Authorization = `Bearer ${o.token}`;
  const r = await fetch(`${BASE}${p}`, {
    method: o.method || 'GET', headers,
    body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const day = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

const status = await j('/setup/status');
if (!status.json?.setupComplete) {
  await j('/setup/initialize', {
    method: 'POST',
    body: { facilityName: 'Programme Test Laboratory', username: 'admin', password: PW, fullName: 'Admin User' },
  });
}
const A = (await j('/auth/login', { method: 'POST', body: { username: 'admin', password: PW } })).json?.token;
if (!A) { console.error(`Could not sign in — is the API running on ${BASE}?`); process.exit(1); }
const stamp = Date.now().toString(36).toUpperCase().slice(-5);

/* ========================================================================
   A unit, an examination and a control
   ===================================================================== */
section('A unit with one examination and one control');
const sections = (await j('/sections/options', { token: A })).json?.sections ?? [];
const unit = sections[0];
check('the laboratory has a unit to plan for', Boolean(unit?.id), JSON.stringify(sections)?.slice(0, 120));

const test = await j('/process-management/tests', {
  token: A, method: 'POST',
  body: { testName: `Programme check assay ${stamp}`, testCode: `PCA-${stamp}`, sectionId: unit.id, sampleType: 'Serum' },
});
const testId = test.json?.id ?? null;
check('an examination can be put on the unit’s menu', Boolean(testId), `${test.status} ${JSON.stringify(test.json)?.slice(0, 160)}`);

const made = await j('/iqc/materials', {
  token: A, method: 'POST',
  body: {
    materialName: `Programme control ${stamp}`, testName: `Programme check assay ${stamp}`,
    lotNumber: `PRG-${stamp}`, levelLabel: 'Level 1', source: 'commercial',
    controlType: 'quantitative', ruleProfile: 'westgard_standard', qcFrequency: 'daily',
    sectionId: unit.id, performingSectionId: unit.id, expiryDate: day(-400),
    // The period a lot is run in lives on the lot, and it is what the
    // schedule is drawn from, so the window this check works over is opened
    // here rather than on the schedule.
    inUseFrom: day(9),
    analytes: [{ analyte: 'ANALYTE', unit: 'g/L', targetMean: 10, targetSd: 0.5, acceptableLow: 8, acceptableHigh: 12, decimalPlaces: 1 }],
  },
});
const materialId = made.json?.id;
check('a control is registered for it', made.status === 201 && Boolean(materialId), JSON.stringify(made.json)?.slice(0, 180));
const analyte = ((await j(`/iqc/materials/${materialId}/analytes`, { token: A })).json ?? [])[0];

const period = { from: day(9), to: day(0) };
const programme = async (extra = '') =>
  (await j(`/iqc/programme?sectionId=${unit.id}&from=${period.from}&to=${period.to}${extra}`, { token: A })).json;

/* ========================================================================
   Every control is in the programme from the start
   ===================================================================== */
section('The plan, before anybody writes one');
let p = await programme();
let control = (p?.controls ?? []).find(c => c.id === materialId);
check('the control is in the programme without being configured', Boolean(control), JSON.stringify(p?.counts));
check('its schedule is read from the frequency it was registered with',
  control?.schedule?.isDefault === true && control?.schedule?.frequency === 'daily',
  JSON.stringify(control?.schedule));
check('nothing is expected before the lot was put into use',
  control?.days?.every(d => d.date >= String(control.schedule.startsOn ?? d.date)) === true,
  JSON.stringify(control?.schedule?.startsOn));
check('today is not yet counted as missed',
  (control?.days ?? []).filter(d => d.date === day(0)).every(d => d.state === 'due'),
  JSON.stringify((control?.days ?? []).filter(d => d.date === day(0))));

/*
 * A plan written over the default, which is what the laboratory is then judged
 * against. The period it runs over is the lot's own, set when the lot was
 * registered — the schedule carries the days and the shifts and nothing else.
 */
await j(`/iqc/programme/controls/${materialId}/schedule`, {
  token: A, method: 'PUT',
  body: { frequency: 'daily', weekdays: [1, 2, 3, 4, 5, 6, 7], isActive: true },
});

/* ========================================================================
   A run closes the day it was performed on
   ===================================================================== */
section('What a run closes, and what it does not');
await j('/iqc/runs', {
  token: A, method: 'POST',
  body: { iqcMaterialId: materialId, runDate: day(3), readings: [{ analyteId: analyte.id, value: 10 }] },
});
p = await programme();
control = (p.controls ?? []).find(c => c.id === materialId);
check('the day it was run on is closed',
  control.days.find(d => d.date === day(3))?.state === 'in_control',
  JSON.stringify(control.days.find(d => d.date === day(3))));
check('the day it was ENTERED on is not',
  control.days.find(d => d.date === day(0))?.state === 'due',
  JSON.stringify(control.days.find(d => d.date === day(0))));
check('the days before it are reported as not run',
  control.days.filter(d => d.date < day(3) && d.state === 'missed').length > 0,
  JSON.stringify(control.missed));
check('compliance is performed over what was judged',
  typeof control.compliance === 'number' && control.compliance < 100, String(control.compliance));

/* ========================================================================
   A failed run is still a run, and says so
   ===================================================================== */
await j('/iqc/runs', {
  token: A, method: 'POST',
  body: { iqcMaterialId: materialId, runDate: day(2), readings: [{ analyteId: analyte.id, value: 30 }] },
});
p = await programme();
control = (p.controls ?? []).find(c => c.id === materialId);
check('a rejected run closes its day and is marked as rejected',
  control.days.find(d => d.date === day(2))?.state === 'rejected',
  JSON.stringify(control.days.find(d => d.date === day(2))));

/* ========================================================================
   A day accounted for is not a day hidden
   ===================================================================== */
section('A day that was not run, accounted for');
const excuse = await j('/iqc/programme/missed', {
  token: A, method: 'POST',
  body: { iqcMaterialId: materialId, dueDate: day(4), reason: 'Analyser under repair; no patient samples run.' },
});
check('a reason can be recorded for a missed day', excuse.status === 201, JSON.stringify(excuse.json));
p = await programme();
control = (p.controls ?? []).find(c => c.id === materialId);
const excused = control.days.find(d => d.date === day(4));
check('the day reads as accounted for rather than missed', excused?.state === 'excused', JSON.stringify(excused));
check('the reason is on the record', String(excused?.reason ?? '').includes('under repair'), String(excused?.reason));
check('and it no longer counts against compliance',
  control.days.filter(d => d.date === day(4) && d.state === 'missed').length === 0);

const blank = await j('/iqc/programme/missed', {
  token: A, method: 'POST', body: { iqcMaterialId: materialId, dueDate: day(5), reason: '   ' },
});
check('a day cannot be accounted for with no reason', blank.status === 400, `${blank.status}`);
const future = await j('/iqc/programme/missed', {
  token: A, method: 'POST', body: { iqcMaterialId: materialId, dueDate: day(-3), reason: 'Not yet' },
});
check('a day that has not happened cannot be missed', future.status === 400, `${future.status}`);
const contradiction = await j('/iqc/programme/missed', {
  token: A, method: 'POST', body: { iqcMaterialId: materialId, dueDate: day(3), reason: 'Nothing was run' },
});
check('a day with a run on it cannot be declared missed', contradiction.status === 409, `${contradiction.status}`);

/* ========================================================================
   The laboratory's own plan
   ===================================================================== */
section('A schedule the laboratory writes');
const planned = await j(`/iqc/programme/controls/${materialId}/schedule`, {
  token: A, method: 'PUT',
  body: { frequency: 'weekly', weekdays: [1], isActive: true },
});
check('a schedule can be written', planned.status === 200, JSON.stringify(planned.json));
p = await programme();
control = (p.controls ?? []).find(c => c.id === materialId);
check('it is the laboratory\u2019s own, not one read from the frequency', control.schedule.isDefault === false);
check('a weekly control is expected once a week, not every day', control.expected <= 2, String(control.expected));
check('and the plan is stated in words', String(control.schedule.summary).toLowerCase().includes('week'),
  control.schedule.summary);

const badShifts = await j(`/iqc/programme/controls/${materialId}/schedule`, {
  token: A, method: 'PUT', body: { frequency: 'per_shift', shifts: [] },
});
check('a per-shift schedule with no shift named is refused', badShifts.status === 400, `${badShifts.status}`);

await j(`/iqc/programme/controls/${materialId}/schedule`, {
  token: A, method: 'PUT', body: { frequency: 'daily', weekdays: [1, 2, 3, 4, 5, 6, 7], isActive: false },
});
p = await programme();
control = (p.controls ?? []).find(c => c.id === materialId);
check('a control taken out of the programme expects nothing', control.expected === 0, String(control.expected));
await j(`/iqc/programme/controls/${materialId}/schedule`, {
  token: A, method: 'PUT', body: { frequency: 'daily', weekdays: [1, 2, 3, 4, 5, 6, 7], isActive: true },
});

/* ========================================================================
   Which examinations are covered at all
   ===================================================================== */
section('Coverage, and an examination deliberately left out');
p = await programme();
const covered = (p.coverage ?? []).find(t => t.id === testId);
check('the examination is on the programme’s register', Boolean(covered), `${(p.coverage ?? []).length} examinations`);
check('and it reads as controlled, because a control names it', covered?.covered === true, JSON.stringify(covered?.controls));

const other = await j('/process-management/tests', {
  token: A, method: 'POST',
  body: { testName: `Uncontrolled assay ${stamp}`, testCode: `UNC-${stamp}`, sectionId: unit.id, sampleType: 'Serum' },
});
const otherId = other.json?.id;
p = await programme();
let gap = (p.coverage ?? []).find(t => t.id === otherId);
check('an examination with no control is reported as a gap',
  gap?.covered === false && gap?.exemption === null, JSON.stringify(gap));
check('and it is counted', p.counts.uncovered >= 1, JSON.stringify(p.counts));

const exempted = await j('/iqc/programme/exemptions', {
  token: A, method: 'POST',
  body: { testId: otherId, ground: 'qualitative_each_kit', reason: 'The kit carries its own internal control on every use.' },
});
check('an examination can be left out of the programme, with a ground', exempted.status === 201, JSON.stringify(exempted.json));
check('and it is given a review date', Boolean(exempted.json?.reviewOn), JSON.stringify(exempted.json));
const twice = await j('/iqc/programme/exemptions', {
  token: A, method: 'POST', body: { testId: otherId, reason: 'Again' },
});
check('it cannot be left out twice', twice.status === 409, `${twice.status}`);
const unreasoned = await j('/iqc/programme/exemptions', {
  token: A, method: 'POST', body: { testId: testId, reason: '' },
});
check('and never without a reason', unreasoned.status === 400, `${unreasoned.status}`);

p = await programme();
gap = (p.coverage ?? []).find(t => t.id === otherId);
check('the exemption is carried with the examination', gap?.exemption?.ground === 'qualitative_each_kit', JSON.stringify(gap?.exemption));
check('it no longer counts as uncovered',
  (p.coverage ?? []).filter(t => !t.covered && !t.exemption).every(t => t.id !== otherId));

const withdrawn = await j(`/iqc/programme/exemptions/${exempted.json.id}/withdraw`, {
  token: A, method: 'POST', body: { reason: 'A control material is now available.' },
});
check('an exemption can be withdrawn', withdrawn.status === 200, JSON.stringify(withdrawn.json));
p = await programme();
gap = (p.coverage ?? []).find(t => t.id === otherId);
check('and the examination is a gap again', gap?.exemption === null && gap?.covered === false);

/* ========================================================================
   The register the programme is read beside
   ===================================================================== */
section('The transmission register’s filters');
const register = (await j('/iqc/analyser/transmissions?state=all&limit=1', { token: A })).json;
check('the control picker offers controls that have never transmitted',
  (register?.controls ?? []).some(c => c.id === materialId),
  `${(register?.controls ?? []).length} controls offered`);
check('the analyser picker names its sources as links or feeds',
  (register?.sources ?? []).every(s => /^(link|feed):\d+$/.test(String(s.id))),
  JSON.stringify((register?.sources ?? []).slice(0, 3)));

const inWindow = (await j(`/iqc/analyser/transmissions?state=all&from=${day(1)}&to=${day(0)}&limit=200`, { token: A })).json;
const outsiders = (inWindow?.rows ?? []).filter(row => {
  const received = String(row.received_at ?? '').slice(0, 10);
  const ran = row.instrument_run_at ? String(row.instrument_run_at).slice(0, 10) : null;
  const inside = d => d && d >= day(1) && d <= day(0);
  return !inside(received) && !inside(ran);
});
check('a period returns only transmissions with a date inside it',
  outsiders.length === 0, JSON.stringify(outsiders.slice(0, 2).map(r => [r.received_at, r.instrument_run_at])));

const scoped = (await j(`/iqc/analyser/transmissions?state=all&materialId=${materialId}&limit=50`, { token: A })).json;
check('a window opened for one control shows that control’s runs and no other’s',
  (scoped?.rows ?? []).every(r => Number(r.iqc_material_id) === materialId),
  JSON.stringify((scoped?.rows ?? []).slice(0, 3).map(r => r.iqc_material_id)));
check('and it says how many unmatched runs are waiting behind it',
  typeof scoped?.unmatchedAvailable === 'number', JSON.stringify(scoped?.unmatchedAvailable));

const unmatchedOnly = (await j('/iqc/analyser/transmissions?state=all&materialId=unmatched&limit=20', { token: A })).json;
check('the register can be narrowed to what matched no control',
  (unmatchedOnly?.rows ?? []).every(r => r.iqc_material_id === null),
  JSON.stringify((unmatchedOnly?.rows ?? []).slice(0, 3).map(r => r.iqc_material_id)));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
