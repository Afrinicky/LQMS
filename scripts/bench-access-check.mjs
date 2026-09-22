/**
 * Can the person actually running a unit prepare its bench schedule?
 *
 *   node scripts/bench-access-check.mjs
 *
 * Two people are checked: the substantive head of a unit, and somebody acting
 * as head while the substantive head is away. Each must see the Bench
 * Schedules workspace, see their own unit in the unit list, and be able to
 * create a schedule for it. The acting head must lose that again when the
 * appointment ends.
 */
const BASE = process.env.API || 'http://127.0.0.1:4440/api';
const PW = 'Passw0rd!test';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};
const j = async (p, o = {}) => {
  const r = await fetch(`${BASE}${p}`, { method: o.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(o.token ? { Authorization: `Bearer ${o.token}` } : {}) },
    body: o.body !== undefined ? JSON.stringify(o.body) : undefined });
  const t = await r.text();
  let json = null; try { json = JSON.parse(t); } catch { json = t; }
  return { status: r.status, json };
};

if (!(await j('/setup/status')).json?.setupComplete)
  await j('/setup/initialize', { method: 'POST', body: { facilityName: 'Bench Lab', username: 'admin', password: PW, fullName: 'Admin User' } });
const A = (await j('/auth/login', { method: 'POST', body: { username: 'admin', password: PW } })).json.token;
const stamp = Date.now();

// A unit, its substantive head, and a bench scientist who will act for them.
const dept = (await j('/departments', { token: A, method: 'POST', body: { name: `Dept ${stamp}` } })).json;
const sectionRes = await j('/section-config/sections', { token: A, method: 'POST', body: { name: `Haematology ${stamp}`, departmentId: dept?.id } });
const sectionId = sectionRes.json?.id
  ?? (await j('/sections', { token: A })).json?.find(x => x.name === `Haematology ${stamp}`)?.id;
console.log('\n[0] Fixtures');
check('a unit exists', !!sectionId, JSON.stringify(sectionRes.json));

const mk = async (no, first, sur) => (await j('/staff', { token: A, method: 'POST',
  body: { employeeNo: no, firstName: first, surname: sur, sectionId } })).json;
const head = await mk(`HEAD-${stamp}`, 'Hilda', 'Head');
const actor = await mk(`ACT-${stamp}`, 'Ama', 'Acting');
check('two staff in that unit', !!head?.id && !!actor?.id, JSON.stringify({ head, actor }));

const roles = (await j('/roles', { token: A })).json;
const roleId = n => roles.find(r => r.name === n)?.id;
const mkUser = async (username, staffId, roleName) => (await j('/users', { token: A, method: 'POST',
  body: { username, password: PW, fullName: username, roleId: roleId(roleName), staffId } })).json;
const headUser = await mkUser(`head${stamp}`, head.id, 'Section Head');
const actorUser = await mkUser(`act${stamp}`, actor.id, 'Biomedical Scientist');
check('a Section Head account and a Biomedical Scientist account', !!headUser?.id && !!actorUser?.id, JSON.stringify({ headUser, actorUser }));

// The unit records who runs it.
await j(`/section-config/sections/${sectionId}`, { token: A, method: 'PUT', body: { headStaffId: head.id } });

const login = async u => (await j('/auth/login', { method: 'POST', body: { username: u, password: PW } })).json?.token;
const H = await login(`head${stamp}`);
const S = await login(`act${stamp}`);
check('both can sign in', !!H && !!S);

const month = new Date().toISOString().slice(0, 7);
async function canPrepare(token, who) {
  const perms = (await j('/auth/permissions', { token })).json;
  const rosters = perms?.permissions?.['personnel.rosters'] ?? [];
  const sees = Array.isArray(rosters) && rosters.includes('view');
  const creates = Array.isArray(rosters) && rosters.includes('create');
  const units = (await j('/sections', { token })).json;
  const listed = Array.isArray(units) && units.some(u => Number(u.id) === Number(sectionId));
  const made = await j('/scheduling/bench-schedules', { token, method: 'POST', body: { sectionId, month: `${month}` } });
  return { who, sees, creates, listed, made };
}

console.log('\n[1] The substantive head of the unit');
const h = await canPrepare(H, 'head');
check('sees the Bench Schedules workspace', h.sees, JSON.stringify(h));
check('may create a schedule', h.creates);
check('sees their own unit in the unit list', h.listed, JSON.stringify((await j('/sections', { token: H })).json).slice(0, 200));
check('and the schedule is created', h.made.status === 201, `status ${h.made.status} ${JSON.stringify(h.made.json)}`);

console.log('\n[2] Somebody acting as head while the substantive head is away');
const today = new Date().toISOString().slice(0, 10);
const until = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
const appt = await j('/scheduling/acting-unit-heads', { token: A, method: 'POST',
  body: { sectionId, actingStaffId: actor.id, startDate: today, endDate: until, reason: 'Annual leave' } });
check('the acting appointment is recorded', appt.status === 201 || appt.status === 200, `status ${appt.status} ${JSON.stringify(appt.json)}`);
const S2 = await login(`act${stamp}`);
const a = await canPrepare(S2, 'acting');
check('the acting head sees the Bench Schedules workspace', a.sees, JSON.stringify(a));
check('may create a schedule', a.creates, JSON.stringify(a));
check('sees the unit they are running', a.listed, JSON.stringify(a));
check('and the schedule is created', a.made.status === 201, `status ${a.made.status} ${JSON.stringify(a.made.json)}`);

console.log('\n[3] When the acting period ends, so does the access');
const apptId = appt.json?.id ?? (await j('/scheduling/acting-unit-heads', { token: A })).json?.[0]?.id;
await j(`/scheduling/acting-unit-heads/${apptId}/end`, { token: A, method: 'POST', body: {} });
const S3 = await login(`act${stamp}`);
const after = await canPrepare(S3, 'after');
check('the stand-in no longer runs the unit', !after.creates, JSON.stringify(after));

console.log('\n[4] Standing in never costs somebody rights they already hold');
const qm = await mk(`QM-${stamp}`, 'Quincy', 'Manager');
await mkUser(`qm${stamp}`, qm.id, 'Quality Manager');
const Q1 = await login(`qm${stamp}`);
const before = (await j('/auth/permissions', { token: Q1 })).json?.permissions ?? {};
await j('/scheduling/acting-unit-heads', { token: A, method: 'POST',
  body: { sectionId, actingStaffId: qm.id, startDate: today, endDate: until, reason: 'Covering the unit' } });
const Q2 = await login(`qm${stamp}`);
const afterQm = (await j('/auth/permissions', { token: Q2 })).json?.permissions ?? {};
const lost = Object.keys(before).filter(k => (before[k] || []).some(a => !(afterQm[k] || []).includes(a)));
check('a Quality Manager covering a unit keeps every right they had', lost.length === 0, `lost: ${lost.join(', ')}`);

console.log('\n[5] An appointment only counts while it is running');
const later = await mk(`FUT-${stamp}`, 'Fred', 'Future');
await mkUser(`fut${stamp}`, later.id, 'Biomedical Scientist');
const sec2 = (await j('/section-config/sections', { token: A, method: 'POST', body: { name: `Micro ${stamp}`, departmentId: dept?.id } })).json?.id
  ?? (await j('/sections', { token: A })).json?.find(x => x.name === `Micro ${stamp}`)?.id;
const from = new Date(Date.now() + 10 * 864e5).toISOString().slice(0, 10);
const to = new Date(Date.now() + 20 * 864e5).toISOString().slice(0, 10);
await j('/scheduling/acting-unit-heads', { token: A, method: 'POST',
  body: { sectionId: sec2, actingStaffId: later.id, startDate: from, endDate: to, reason: 'Planned cover' } });
const F = await login(`fut${stamp}`);
const fPerms = (await j('/auth/permissions', { token: F })).json?.permissions ?? {};
check('an appointment that starts next week grants nothing today',
  !(fPerms['personnel.rosters'] || []).includes('create'), JSON.stringify(fPerms['personnel.rosters']));

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
