/**
 * Can the person who actually runs a unit do the unit's work?
 *
 *   node scripts/unit-lead-access-check.mjs
 *
 * The case this covers is the ordinary one: a Biomedical Scientist who heads a
 * unit, or is standing in for its head, whose login account carries a bench
 * profile because that is what they are. Running the unit has to carry the
 * unit's work with it — preparing its bench schedule, defining the controls
 * its tests need, running them — and it has to stop at the unit's edge. Three
 * things are checked, in both directions:
 *
 *   · the unit lead may prepare THEIR unit's bench schedule and define and run
 *     THEIR unit's controls;
 *   · they may do none of that for a unit they do not run;
 *   · a right withdrawn from them on the Access Control screen stays
 *     withdrawn, whatever post they hold.
 *
 * And the store: cancelling a voucher issued in error belongs to the three
 * posts accountable for the laboratory's records, the Quality Manager
 * included, and to nobody else.
 */
const BASE = process.env.API || 'http://127.0.0.1:4440/api';
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
  await j('/setup/initialize', { method: 'POST', body: { facilityName: 'Unit Lead Lab', username: 'admin', password: PW, fullName: 'Admin User' } });
}
const A = (await j('/auth/login', { method: 'POST', body: { username: 'admin', password: PW } })).json.token;
const stamp = Date.now();
const login = async u => (await j('/auth/login', { method: 'POST', body: { username: u, password: PW } })).json?.token;

console.log('\n[0] Three units, and the people on them');
const dept = (await j('/departments', { token: A, method: 'POST', body: { name: `Dept ${stamp}` } })).json;
const mkSection = async name => (await j('/section-config/sections', { token: A, method: 'POST', body: { name, departmentId: dept?.id } })).json?.id
  ?? (await j('/sections', { token: A })).json?.find(x => x.name === name)?.id;
const mine = await mkSection(`Haematology ${stamp}`);
const theirs = await mkSection(`Microbiology ${stamp}`);
const third = await mkSection(`Serology ${stamp}`);
check('three units exist', !!mine && !!theirs && !!third, JSON.stringify({ mine, theirs, third }));

const mkStaff = async (no, first, sur, sectionId) => (await j('/staff', { token: A, method: 'POST',
  body: { employeeNo: no, firstName: first, surname: sur, sectionId } })).json;
const roles = (await j('/roles', { token: A })).json;
const roleId = n => roles.find(r => r.name === n)?.id;
const mkUser = async (username, staffId, roleName) => (await j('/users', { token: A, method: 'POST',
  body: { username, password: PW, fullName: username, roleId: roleId(roleName), staffId } })).json;

// The substantive head of a unit, on a bench profile — which is the case the
// laboratory reported: the post is recorded on the unit, not on the account.
const head = await mkStaff(`UH-${stamp}`, 'Hanna', 'Head', mine);
await mkUser(`uh${stamp}`, head.id, 'Biomedical Scientist');
await j(`/section-config/sections/${mine}`, { token: A, method: 'PUT', body: { headStaffId: head.id } });
// Somebody standing in for the head of the OTHER unit, also on a bench profile.
const stand = await mkStaff(`AC-${stamp}`, 'Ama', 'Acting', theirs);
await mkUser(`ac${stamp}`, stand.id, 'Biomedical Scientist');
const today = new Date().toISOString().slice(0, 10);
const until = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
await j('/scheduling/acting-unit-heads', { token: A, method: 'POST',
  body: { sectionId: theirs, actingStaffId: stand.id, startDate: today, endDate: until, reason: 'Annual leave' } });
// A bench scientist who runs no unit at all — the control group.
const bench = await mkStaff(`BS-${stamp}`, 'Bernard', 'Bench', mine);
await mkUser(`bs${stamp}`, bench.id, 'Biomedical Scientist');
// Somebody who heads a unit on a profile that reads quality control but does
// not hold the laboratory-wide right to create in it. This is the person the
// unit-scoping is actually for: everything they may do here, they may do
// because they run that one unit.
const scoped = await mkStaff(`SC-${stamp}`, 'Sena', 'Scoped', third);
await mkUser(`sc${stamp}`, scoped.id, 'Quality Team Member');
await j(`/section-config/sections/${third}`, { token: A, method: 'PUT', body: { headStaffId: scoped.id } });

const H = await login(`uh${stamp}`);
const S = await login(`ac${stamp}`);
const B = await login(`bs${stamp}`);
const C = await login(`sc${stamp}`);
check('all four can sign in', !!H && !!S && !!B && !!C);

console.log('\n[1] The signed-in person is told which units they run');
const ledOf = async token => ((await j('/auth/permissions', { token })).json?.unitsLed ?? []).map(u => Number(u.id));
check('the substantive head is told they run their unit', (await ledOf(H)).includes(Number(mine)), JSON.stringify(await ledOf(H)));
check('the stand-in is told they run the unit they cover', (await ledOf(S)).includes(Number(theirs)), JSON.stringify(await ledOf(S)));
check('a bench scientist runs nothing', (await ledOf(B)).length === 0, JSON.stringify(await ledOf(B)));

console.log('\n[2] Bench schedules — their own unit, and no other');
const month = new Date().toISOString().slice(0, 7);
const makeSchedule = (token, sectionId) => j('/scheduling/bench-schedules', { token, method: 'POST', body: { sectionId, month } });
const own = await makeSchedule(H, mine);
check('the head prepares their own unit\'s schedule', own.status === 201, `status ${own.status} ${JSON.stringify(own.json)}`);
const other = await makeSchedule(H, theirs);
check('and is refused another unit\'s', other.status === 403, `status ${other.status}`);
const acting = await makeSchedule(S, theirs);
check('the stand-in prepares the schedule of the unit they cover', acting.status === 201, `status ${acting.status} ${JSON.stringify(acting.json)}`);
const notMine = await makeSchedule(B, mine);
check('a bench scientist prepares none', notMine.status === 403, `status ${notMine.status}`);

const access = (await j('/scheduling/bench-schedules/access', { token: H })).json;
check('the board is told which units the head may prepare for',
  Array.isArray(access?.units) && access.units.length === 1 && Number(access.units[0].id) === Number(mine),
  JSON.stringify(access));

const paint = await j(`/scheduling/bench-schedules/${own.json.id}/cells`, { token: H, method: 'POST', body: { cells: [] } });
check('the head may write on their own schedule', paint.status === 200, `status ${paint.status}`);
const poach = await j(`/scheduling/bench-schedules/${acting.json.id}/cells`, { token: H, method: 'POST', body: { cells: [] } });
check('and may not write on the other unit\'s', poach.status === 403, `status ${poach.status}`);

console.log('\n[3] Controls — defining and running them for their own unit');
const control = body => ({ method: 'POST', body });
const defineFor = (token, sectionId) => j('/iqc/materials', { token, ...control({
  materialName: `Control ${stamp}-${sectionId}`, testName: 'Haemoglobin', lotNumber: `LOT${stamp}`,
  sectionId, controlType: 'quantitative',
  analytes: [{ analyte: 'Haemoglobin', unit: 'g/dL', targetMean: 12, targetSd: 0.4 }],
}) });
const mineControl = await defineFor(H, mine);
check('the head defines a control for their own unit', mineControl.status === 201, `status ${mineControl.status} ${JSON.stringify(mineControl.json)}`);
const standControl = await defineFor(S, theirs);
check('the stand-in defines a control for the unit they cover', standControl.status === 201, `status ${standControl.status} ${JSON.stringify(standControl.json)}`);

const run = (token, materialId) => j('/iqc/runs', { token, ...control({
  iqcMaterialId: materialId, runDate: today,
  readings: [{ analyte: 'Haemoglobin', value: 12.1 }],
}) });
const ownRun = await run(H, mineControl.json?.id);
check('the head runs their own unit\'s control', ownRun.status === 201, `status ${ownRun.status} ${JSON.stringify(ownRun.json)}`);
const standRun = await run(S, standControl.json?.id);
check('the stand-in runs the control they defined', standRun.status === 201, `status ${standRun.status} ${JSON.stringify(standRun.json)}`);

// The scoping itself: somebody who reaches this work ONLY through the unit
// they run reaches their unit and stops there.
const scopedOwn = await defineFor(C, third);
check('a unit head without the laboratory-wide right still defines their own unit\'s control',
  scopedOwn.status === 201, `status ${scopedOwn.status} ${JSON.stringify(scopedOwn.json)}`);
const scopedOther = await defineFor(C, mine);
check('and is refused one for a unit they do not run', scopedOther.status === 403, `status ${scopedOther.status}`);
const scopedRunOwn = await run(C, scopedOwn.json?.id);
check('they run their own unit\'s control', scopedRunOwn.status === 201, `status ${scopedRunOwn.status} ${JSON.stringify(scopedRunOwn.json)}`);
const scopedRunOther = await run(C, mineControl.json?.id);
check('and are refused another unit\'s', scopedRunOther.status === 403, `status ${scopedRunOther.status}`);

console.log('\n[4] Access Control still holds the highest authority');
const headUserId = (await j('/users', { token: A })).json?.find(u => u.username === `uh${stamp}`)?.id;
const withdrawn = await j('/permissions/action', { token: A, method: 'POST',
  body: { scope: 'user', subjectId: headUserId, permKey: 'personnel.rosters', action: 'create', allowed: false, reason: 'Withdrawn for this check' } });
check('the withdrawal was recorded', withdrawn.status === 200, `status ${withdrawn.status} ${JSON.stringify(withdrawn.json)}`);
const H2 = await login(`uh${stamp}`);
const afterWithdrawal = await makeSchedule(H2, mine);
check('a right withdrawn individually is not handed back by the post',
  afterWithdrawal.status === 403, `status ${afterWithdrawal.status}`);

console.log('\n[5] Correcting the store — who may cancel a voucher');
const qm = await mkStaff(`QM-${stamp}`, 'Quincy', 'Manager', mine);
await mkUser(`qm${stamp}`, qm.id, 'Quality Manager');
const Q = await login(`qm${stamp}`);
const qmPerms = (await j('/auth/permissions', { token: Q })).json?.permissions ?? {};
check('the Quality Manager may cancel a voucher issued in error',
  (qmPerms['supplier_inventory.stock'] ?? []).includes('void_archive'),
  JSON.stringify(qmPerms['supplier_inventory.stock']));
check('and still only reads the stores register otherwise',
  !(qmPerms['supplier_inventory.stock'] ?? []).includes('create'),
  JSON.stringify(qmPerms['supplier_inventory.stock']));
const benchPerms = (await j('/auth/permissions', { token: B })).json?.permissions ?? {};
check('a bench scientist may not',
  !(benchPerms['supplier_inventory.stock'] ?? []).includes('void_archive'),
  JSON.stringify(benchPerms['supplier_inventory.stock']));

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
