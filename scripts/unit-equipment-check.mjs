/**
 * The unit head's view of their own instruments.
 *
 * A unit head opening the maintenance tab used to be told only that no
 * maintenance tasks existed anywhere in their unit — true, and useless. What is
 * checked here is that they now get the inventory, that each instrument carries
 * the duties ISO 15189:2022 says THAT KIND of instrument is owed (they differ,
 * and pretending otherwise is how a fridge ends up in an IQC picker), and that
 * the gaps can be closed from where they were found.
 *
 *   node scripts/unit-equipment-check.mjs
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
if (!st.json?.setupComplete) await j('/setup/initialize', { method: 'POST', body: { facilityName: 'Equipment Lab', username: 'admin', password: PW, fullName: 'Admin User' } });
const A = (await j('/auth/login', { method: 'POST', body: { username: 'admin', password: PW } })).json.token;
const stamp = Date.now();

/* ------------------------------------------------------------------- setup */
const sections = (await j('/sections/options', { token: A })).json.sections;
const sectionId = sections[0]?.id;
if (!sectionId) { console.log('  FAIL  no unit exists to test against'); process.exit(1); }

const make = (name, category) => j('/equipment', { token: A, method: 'POST', body: {
  name, equipmentCategory: category, sectionId, status: 'operational',
  manufacturer: 'Test Co', model: 'M1', serialNumber: `SN-${stamp}-${name.slice(0, 3)}`,
} });

const analyser = await make(`Chemistry Analyser ${stamp}`, 'analyser');
const fridge = await make(`Reagent Fridge ${stamp}`, 'support');
const pipette = await make(`Micropipette ${stamp}`, 'measuring_device');
check('an analyser, a fridge and a pipette are registered to the unit',
  analyser.status === 201 && fridge.status === 201 && pipette.status === 201,
  `${analyser.status}/${fridge.status}/${pipette.status}`);

/* ============================================================ 1. the inventory */
console.log('\n[1] The unit head sees the inventory, not an empty screen');
const overview = await j(`/equipment/portal/unit-overview?sectionId=${sectionId}`, { token: A });
check('the overview is served', overview.status === 200, JSON.stringify(overview.json).slice(0, 140));
check('it names the unit', typeof overview.json.sectionName === 'string', String(overview.json.sectionName));
check('and lists its instruments', overview.json.counts.items >= 3, String(overview.json.counts.items));

const find = id => overview.json.equipment.find(e => e.id === id);
const an = find(analyser.json.id);
const fr = find(fridge.json.id);
const pi = find(pipette.json.id);
check('the analyser is on it', Boolean(an), 'analyser missing');
check('the fridge is on it', Boolean(fr), 'fridge missing');
check('the pipette is on it', Boolean(pi), 'pipette missing');

/* =============================================== 2. duties differ by archetype */
console.log('\n[2] What each kind of instrument is owed, and it is not the same list');
const duties = e => e.duties.map(d => d.duty);
check('an analyser owes calibration', duties(an).includes('calibration'), duties(an).join(','));
check('an analyser owes performance verification', duties(an).includes('verification'));
check('an analyser owes IQC', duties(an).includes('iqc'));
check('an analyser owes measurement uncertainty', duties(an).includes('measurement_uncertainty'));

check('a fridge owes NO IQC — it reports no patient result', !duties(fr).includes('iqc'), duties(fr).join(','));
check('a fridge owes NO calibration', !duties(fr).includes('calibration'));
check('but a fridge is not exempt: it owes continuous monitoring', duties(fr).includes('monitoring'));
check('and it owes maintenance', duties(fr).includes('maintenance'));
check('and periodic certification', duties(fr).includes('certification'));

check('a pipette owes calibration though it reports nothing', duties(pi).includes('calibration'), duties(pi).join(','));
check('and a pipette owes no IQC', !duties(pi).includes('iqc'));

/* ============================================ 3. gaps are named, not implied */
console.log('\n[3] Nothing set up reads as a gap, with the clause behind it');
const dutyOf = (e, key) => e.duties.find(d => d.duty === key);
check('maintenance shows as not set up', dutyOf(an, 'maintenance').setUp === false, String(dutyOf(an, 'maintenance').setUp));
check('and says so in words', /No maintenance tasks defined/.test(dutyOf(an, 'maintenance').detail ?? ''), dutyOf(an, 'maintenance').detail);
check('calibration shows as not set up', dutyOf(an, 'calibration').setUp === false);
check('and carries the clause it answers to', /6\.5\.2/.test(dutyOf(an, 'calibration').clause ?? ''), dutyOf(an, 'calibration').clause);
check('the analyser is counted as having gaps', an.gaps.length > 0, JSON.stringify(an.gaps));
check('a duty this system holds no record type for is marked untracked, not missing',
  dutyOf(an, 'measurement_uncertainty').tracked === false, String(dutyOf(an, 'measurement_uncertainty').tracked));
check('the unit count of instruments needing a maintenance programme is real',
  overview.json.counts.needMaintenanceTasks >= 3, String(overview.json.counts.needMaintenanceTasks));

/* =========================================== 4. the gap can be closed from here */
console.log('\n[4] The gap is closed where it was found');
const framework = await j(`/equipment/${analyser.json.id}/maintenance-framework`, { token: A });
check('a starting framework is offered for the instrument', framework.status === 200 && framework.json.tasks.length > 0,
  `${framework.status} / ${framework.json?.tasks?.length}`);

const added = await j(`/equipment/${analyser.json.id}/maintenance-tasks`, { token: A, method: 'POST', body: {
  tasks: framework.json.tasks.slice(0, 3).map(t => ({ task: t.task, frequency: t.frequency, kind: t.kind, tier: t.tier })),
} });
check('the chosen tasks are accepted', added.status === 201 && added.json.created === 3, JSON.stringify(added.json));

const calSchedule = await j(`/equipment/${analyser.json.id}/schedules`, { token: A, method: 'POST', body: {
  scheduleType: 'calibration', frequency: 'annual', providerType: 'external', providerName: 'Metrology Ltd',
} });
check('a calibration schedule is accepted', calSchedule.status === 201, JSON.stringify(calSchedule.json));
check('with a first due date derived from the interval', /^\d{4}-\d{2}-\d{2}$/.test(calSchedule.json.nextDueDate ?? ''), calSchedule.json.nextDueDate);

const verSchedule = await j(`/equipment/${analyser.json.id}/schedules`, { token: A, method: 'POST', body: {
  scheduleType: 'verification', frequency: 'annual', providerType: 'internal',
} });
check('a verification schedule is accepted', verSchedule.status === 201, JSON.stringify(verSchedule.json));

/* ================================================= 5. the overview reflects it */
console.log('\n[5] The inventory reads differently the moment it is set up');
const after = await j(`/equipment/portal/unit-overview?sectionId=${sectionId}`, { token: A });
const an2 = after.json.equipment.find(e => e.id === analyser.json.id);
check('maintenance now reads as set up', an2.duties.find(d => d.duty === 'maintenance').setUp === true);
check('and names how many tasks', /3 /.test(an2.duties.find(d => d.duty === 'maintenance').detail ?? ''),
  an2.duties.find(d => d.duty === 'maintenance').detail);
check('calibration now reads as set up', an2.duties.find(d => d.duty === 'calibration').setUp === true);
check('with a date it is next due', Boolean(an2.duties.find(d => d.duty === 'calibration').dueDate));
check('and a state, not just a date', an2.duties.find(d => d.duty === 'calibration').dueState !== 'unscheduled',
  an2.duties.find(d => d.duty === 'calibration').dueState);
check('verification now reads as set up', an2.duties.find(d => d.duty === 'verification').setUp === true);
check('the analyser no longer counts as having those gaps',
  !an2.gaps.includes('maintenance') && !an2.gaps.includes('calibration'), JSON.stringify(an2.gaps));

/* ==================================== 6. and the maintenance chart now exists */
console.log('\n[6] Which is what makes the monthly chart appear');
const month = new Date().toISOString().slice(0, 7);
const charts = await j(`/equipment/maintenance-charts?month=${month}&sectionId=${sectionId}`, { token: A });
check('the unit now has a maintenance chart', charts.json.sheets.some(s => s.subject?.id === analyser.json.id),
  `${charts.json.sheets.length} sheet(s)`);
const sheet = charts.json.sheets.find(s => s.subject?.id === analyser.json.id);
check('and it carries the tasks as its rows', (sheet?.completeness?.expected ?? 0) > 0,
  JSON.stringify(sheet?.completeness));

/* ======================================== 7. an overdue date is not a missing one */
console.log('\n[7] Overdue and unscheduled are different words');
await j(`/equipment/${fridge.json.id}/schedules`, { token: A, method: 'POST', body: {
  scheduleType: 'preventive_maintenance', frequency: 'monthly', providerType: 'internal',
  nextDueDate: '2020-01-01',
} });
const late = await j(`/equipment/portal/unit-overview?sectionId=${sectionId}`, { token: A });
const fr2 = late.json.equipment.find(e => e.id === fridge.json.id);
check('a past due date reads as overdue', fr2.duties.find(d => d.duty === 'maintenance').dueState === 'overdue',
  fr2.duties.find(d => d.duty === 'maintenance').dueState);
check('and the fridge is counted among the overdue', fr2.overdue.includes('maintenance'), JSON.stringify(fr2.overdue));
check('the unit-level overdue count picks it up', late.json.counts.overdue >= 1, String(late.json.counts.overdue));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
