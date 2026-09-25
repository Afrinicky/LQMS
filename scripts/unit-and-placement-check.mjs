/**
 * The blood bank is a unit, and a placement ends on its own.
 *
 *   node scripts/unit-and-placement-check.mjs
 *
 * Two things are proved here.
 *
 * THE BLOOD BANK. It used to be a specialist post on a much narrower profile:
 * full rights over the handover register and little else, so the person
 * running it could not prepare a bench schedule or define a control for their
 * own unit. Its supervisor now carries the unit supervisor's access exactly —
 * area for area, action for action — with the blood registers on top, and runs
 * the blood bank the way every other supervisor runs their unit.
 *
 * A PLACEMENT. A student, an intern, a national service person or a locum is
 * enrolled with an end date. On the day it passes the laboratory is told; a
 * week later, if nobody extended it, their access is withdrawn and they leave
 * the active register — with the whole record kept under Former staff.
 */
const BASE = process.env.API || 'http://127.0.0.1:4460/api';
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
  const t = await r.text();
  let json = null; try { json = JSON.parse(t); } catch { json = t; }
  return { status: r.status, json };
};

if (!(await j('/setup/status')).json?.setupComplete) {
  await j('/setup/initialize', { method: 'POST', body: { facilityName: 'Unit Lab', username: 'admin', password: PW, fullName: 'Admin User' } });
}
const A = (await j('/auth/login', { method: 'POST', body: { username: 'admin', password: PW } })).json.token;
const stamp = Date.now();
const today = new Date().toISOString().slice(0, 10);
const day = n => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const login = async u => (await j('/auth/login', { method: 'POST', body: { username: u, password: PW } }));

console.log('\n[0] The vocabulary is one word, everywhere');
const roles = (await j('/roles', { token: A })).json;
const roleId = n => roles.find(r => r.name === n)?.id;
check('the shared profile is "Unit Supervisor"', !!roleId('Unit Supervisor'), JSON.stringify(roles.map(r => r.name)));
check('the blood bank profile is "Blood Bank Unit Supervisor"', !!roleId('Blood Bank Unit Supervisor'));
check('nothing is still called a head', !roles.some(r => /head/i.test(r.name)), JSON.stringify(roles.map(r => r.name)));
const posts = (await j('/positions', { token: A })).json ?? [];
check('the unit posts are supervisors', posts.some(p => p.title === 'Blood Bank Unit Supervisor')
  && posts.some(p => p.title === 'Haematology Unit Supervisor'), JSON.stringify(posts.map(p => p.title)));
check('and no post is still a unit head', !posts.some(p => /unit head/i.test(p.title)), JSON.stringify(posts.map(p => p.title)));

console.log('\n[1] The blood bank supervisor has a unit supervisor\'s access, and the blood on top');
const mkUser = async (username, role, staffId) => (await j('/users', { token: A, method: 'POST',
  body: { username, password: PW, fullName: username, roleId: roleId(role), staffId } })).json;
await mkUser(`us${stamp}`, 'Unit Supervisor');
await mkUser(`bb${stamp}`, 'Blood Bank Unit Supervisor');
const U = (await login(`us${stamp}`)).json?.token;
const B = (await login(`bb${stamp}`)).json?.token;
const pu = (await j('/auth/permissions', { token: U })).json?.permissions ?? {};
const pb = (await j('/auth/permissions', { token: B })).json?.permissions ?? {};
const areas = [...new Set([...Object.keys(pu), ...Object.keys(pb)])];
const differing = areas.filter(k => (pu[k] ?? []).slice().sort().join() !== (pb[k] ?? []).slice().sort().join());
check('every area but one is identical to a unit supervisor\'s',
  differing.length === 1 && differing[0] === 'blood_bank_handover', JSON.stringify(differing));
for (const area of ['personnel.rosters', 'iqc', 'personnel.training', 'equipment.register', 'nc_capa']) {
  check(`it runs its unit's ${area} exactly as any other unit does`,
    (pb[area] ?? []).slice().sort().join() === (pu[area] ?? []).slice().sort().join(),
    `${JSON.stringify(pu[area])} vs ${JSON.stringify(pb[area])}`);
}
check('and holds the blood registers outright',
  ['view', 'create', 'edit', 'approve', 'void_archive'].every(a => (pb.blood_bank_handover ?? []).includes(a)),
  JSON.stringify(pb.blood_bank_handover));
check('which the other unit supervisors do not',
  !(pu.blood_bank_handover ?? []).includes('approve'), JSON.stringify(pu.blood_bank_handover));

console.log('\n[2] The blood bank prepares its own bench schedule, like every other unit');
const dept = (await j('/departments', { token: A, method: 'POST', body: { name: `Dept ${stamp}` } })).json;
const bloodBank = (await j('/section-config/sections', { token: A, method: 'POST', body: { name: `Blood Bank ${stamp}`, departmentId: dept?.id } })).json?.id
  ?? (await j('/sections', { token: A })).json?.find(x => x.name === `Blood Bank ${stamp}`)?.id;
const mkStaff = async (no, first, sur, sectionId, extra = {}) => (await j('/staff', { token: A, method: 'POST',
  body: { employeeNo: no, firstName: first, surname: sur, sectionId, ...extra } })).json;
const bbHead = await mkStaff(`BB-${stamp}`, 'Bea', 'Banks', bloodBank);
await mkUser(`bbs${stamp}`, 'Blood Bank Unit Supervisor', bbHead.id);
await j(`/section-config/sections/${bloodBank}`, { token: A, method: 'PUT', body: { headStaffId: bbHead.id } });
const BB = (await login(`bbs${stamp}`)).json?.token;
const led = ((await j('/auth/permissions', { token: BB })).json?.unitsLed ?? []).map(u => Number(u.id));
check('the blood bank supervisor is recognised as running the blood bank', led.includes(Number(bloodBank)), JSON.stringify(led));
const schedule = await j('/scheduling/bench-schedules', { token: BB, method: 'POST',
  body: { sectionId: bloodBank, month: today.slice(0, 7) } });
check('and prepares its bench schedule', schedule.status === 201, `status ${schedule.status} ${JSON.stringify(schedule.json)}`);
const control = await j('/iqc/materials', { token: BB, method: 'POST', body: {
  materialName: `BB control ${stamp}`, testName: 'Blood grouping', lotNumber: `L${stamp}`,
  sectionId: bloodBank, controlType: 'qualitative',
  analytes: [{ analyte: 'Anti-A', expectedResult: 'REACTIVE' }],
} });
check('and defines its own controls', control.status === 201, `status ${control.status} ${JSON.stringify(control.json)}`);

console.log('\n[3] A placement is enrolled with a start and an end');
const intern = await mkStaff(`INT-${stamp}`, 'Ida', 'Intern', bloodBank, {
  personnelCategory: 'INTERN', appointmentType: 'INTERN', appointmentDate: day(-90), placementEndDate: day(-1),
});
check('the placement is recorded', !!intern?.id, JSON.stringify(intern));
const readBack = ((await j('/staff', { token: A })).json ?? []).find(s => Number(s.id) === Number(intern.id));
check('the register carries its end date', readBack?.placementEndDate === day(-1), JSON.stringify(readBack?.placementEndDate));

const permanent = await mkStaff(`PRM-${stamp}`, 'Peter', 'Permanent', bloodBank, {
  personnelCategory: 'STAFF', appointmentDate: day(-400), placementEndDate: day(-1),
});
const permBack = ((await j('/staff', { token: A })).json ?? []).find(s => Number(s.id) === Number(permanent.id));
check('a permanent member of staff carries no placement end', !permBack?.placementEndDate, JSON.stringify(permBack?.placementEndDate));

console.log('\n[4] The day it ends, the laboratory is told — and nothing is taken away');
const tick = await j('/staff/placement-tick', { token: A, method: 'POST', body: {} });
check('the pass runs', tick.status === 200, `status ${tick.status} ${JSON.stringify(tick.json)}`);
const afterWarning = ((await j('/staff?status=all', { token: A })).json ?? []).find(s => Number(s.id) === Number(intern.id));
check('the intern is still on the active register', Number(afterWarning?.isActive) === 1, JSON.stringify(afterWarning?.isActive));
check('and the laboratory was warned', !!afterWarning?.placementNoticeAt, JSON.stringify(afterWarning?.placementNoticeAt));
check('the supervisor of the unit was told',
  (tick.json?.warned ?? 0) >= 2, JSON.stringify(tick.json));

console.log('\n[5] Extending it puts the clock back');
await j(`/staff/${intern.id}`, { token: A, method: 'PUT', body: { placementEndDate: day(30) } });
const extended = ((await j('/staff', { token: A })).json ?? []).find(s => Number(s.id) === Number(intern.id));
check('the new end date is on the record', extended?.placementEndDate === day(30), JSON.stringify(extended?.placementEndDate));
check('and the earlier warning no longer stands', !extended?.placementNoticeAt, JSON.stringify(extended?.placementNoticeAt));

console.log('\n[6] A week after it ends, access is withdrawn and the record is kept');
const leaver = await mkStaff(`STU-${stamp}`, 'Sam', 'Student', bloodBank, {
  personnelCategory: 'STUDENT', appointmentDate: day(-120), placementEndDate: day(14),
});
await mkUser(`stu${stamp}`, 'Technician', leaver.id);
check('the student could sign in while the placement ran', (await login(`stu${stamp}`)).status === 200);
// The placement now ends more than a week ago, which is where the grace
// period has run out and the withdrawal is due.
await j(`/staff/${leaver.id}`, { token: A, method: 'PUT', body: { placementEndDate: day(-8) } });
await j('/staff/placement-tick', { token: A, method: 'POST', body: {} });
const all = (await j('/staff?status=all', { token: A })).json ?? [];
const gone = all.find(s => Number(s.id) === Number(leaver.id));
check('they are off the active register', Number(gone?.isActive) === 0, JSON.stringify(gone?.isActive));
check('with the reason and the date on the record', !!gone?.exitReason && !!gone?.exitDate,
  JSON.stringify({ reason: gone?.exitReason, date: gone?.exitDate }));
check('the whole record is still there', !!gone?.fullName && !!gone?.employeeNo, JSON.stringify(gone?.employeeNo));
check('they cannot sign in any more', (await login(`stu${stamp}`)).status !== 200);
const active = (await j('/staff', { token: A })).json ?? [];
check('and they are not counted as active staff', !active.some(s => Number(s.id) === Number(leaver.id)));
const former = (await j('/staff?status=retired', { token: A })).json ?? [];
check('they are found under former staff', former.some(s => Number(s.id) === Number(leaver.id)), `${former.length} former`);

console.log('\n[7] A permanent member of staff is never withdrawn by this');
const permActive = active.some(s => Number(s.id) === Number(permanent.id));
check('the permanent member of staff is untouched', permActive);

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
