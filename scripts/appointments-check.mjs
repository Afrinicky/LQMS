/**
 * One appointment register, and the doors that used to go round it.
 *
 * THE FAULT. A laboratory appointed a new Microbiology supervisor and the old
 * one stayed: both appeared on the staff register as "Microbiology Unit
 * Supervisor", and the old one kept the post's access, because a person's
 * profile is resolved from exactly these assignment rows. The cause was two
 * records of one fact — the post's holder and the unit's `head_staff_id` —
 * written by five screens that never consulted each other, and an "appoint"
 * that demoted the incumbent to a second, still-active assignment instead of
 * ending theirs.
 *
 * What this establishes, in the order it matters:
 *
 *   An appointed office has ONE holder. Appointing a successor ends the
 *   predecessor's appointment rather than hiding it.
 *   A unit has ONE supervisor, and the unit follows the post: the holder runs
 *   the unit, and the unit becomes their own.
 *   A GRADE is not an office. Ten technicians hold "Laboratory Technician"
 *   and nothing displaces anybody.
 *   A PERSON may hold several posts at once.
 *   Every other door — the organogram, the unit profile, the personnel
 *   register, staff registration — either goes through the register or
 *   changes nothing at all.
 *
 *   npm run api          (in one terminal)
 *   node scripts/appointments-check.mjs
 */
import { benchRole, clinicalUnit } from './lib/people.mjs';

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

const status = await j('/setup/status');
if (!status.json?.setupComplete) {
  await j('/setup/initialize', {
    method: 'POST',
    body: { facilityName: 'Appointments Test Laboratory', username: 'admin', password: PW, fullName: 'Admin User' },
  });
}
const A = (await j('/auth/login', { method: 'POST', body: { username: 'admin', password: PW } })).json?.token;
const benchGrade = await benchRole(j, A);
const homeUnitId = (await clinicalUnit(j, A))?.id ?? null;
if (!A) { console.error(`Could not sign in — is the API running on ${BASE}?`); process.exit(1); }
const stamp = Date.now().toString(36).toUpperCase().slice(-5);

const register = async () => (await j('/appointments', { token: A })).json;
const postNamed = (reg, title) => (reg?.posts ?? []).find(p => p.title === title);
const unitNamed = (reg, name) => (reg?.units ?? []).find(u => u.name === name);

/* ========================================================================
   A unit, two people and the post that runs it
   ===================================================================== */
section('A unit, and the post that runs it');
const unit = await j('/section-config/sections', {
  token: A, method: 'POST', body: { name: `Serology ${stamp}`, code: `SER-${stamp}` },
});
const unitId = unit.json?.id;
check('a unit can be created', Boolean(unitId), `${unit.status} ${JSON.stringify(unit.json)?.slice(0, 140)}`);
check('creating one does not appoint anybody to run it',
  !(await register())?.units?.find(u => u.id === unitId)?.supervisorStaffId);

const post = await j('/positions', {
  token: A, method: 'POST', body: { title: `Serology Unit Supervisor ${stamp}`, isCore: true },
});
const postId = post.json?.id;
check('an appointed post can be created', Boolean(postId), JSON.stringify(post.json)?.slice(0, 140));

const supervises = await j(`/appointments/posts/${postId}/supervises`, {
  token: A, method: 'PUT', body: { sectionId: unitId },
});
check('the post can be told which unit it supervises', supervises.status === 200, JSON.stringify(supervises.json));

const grade = await j('/positions', {
  token: A, method: 'POST', body: { title: `Laboratory Technician ${stamp}`, isCore: false },
});
const gradeId = grade.json?.id;

const people = {};
for (const name of ['Ama', 'Kofi', 'Yaa', 'Kwesi']) {
  const made = await j('/staff', { token: A, method: 'POST', body: { fullName: `${name} ${stamp}`, primaryRoleId: benchGrade.id, sectionId: homeUnitId } });
  people[name] = made.json?.id;
}
check('four people are on the staff register', Object.values(people).every(Boolean), JSON.stringify(people));

/* ========================================================================
   One office, one holder
   ===================================================================== */
section('An office has one holder, and the unit follows it');
let r = await j('/appointments', { token: A, method: 'POST', body: { positionId: postId, staffId: people.Ama } });
check('the first appointment is made', r.status === 201, JSON.stringify(r.json)?.slice(0, 160));
let reg = await register();
check('the post names its holder', postNamed(reg, `Serology Unit Supervisor ${stamp}`)?.holder?.staffId === people.Ama);
check('and the unit is run by them', unitNamed(reg, `Serology ${stamp}`)?.supervisorStaffId === people.Ama);

let staffRow = (await j('/staff', { token: A })).json.find(s => s.id === people.Ama);
check('the supervisor now belongs to the unit they supervise', staffRow?.sectionName === `Serology ${stamp}`,
  String(staffRow?.sectionName));
check('and the register shows the post against their name', String(staffRow?.primaryPosition ?? '').includes('Serology Unit Supervisor'),
  String(staffRow?.primaryPosition));

r = await j('/appointments', { token: A, method: 'POST', body: { positionId: postId, staffId: people.Kofi } });
check('a successor can be appointed', r.status === 201, JSON.stringify(r.json)?.slice(0, 160));
check('and the answer says whose appointment ended', r.json?.replacedStaffId === people.Ama, JSON.stringify(r.json?.summary));

reg = await register();
check('THE POST NOW HAS ONE HOLDER', postNamed(reg, `Serology Unit Supervisor ${stamp}`)?.holder?.staffId === people.Kofi);
check('the unit is run by the successor', unitNamed(reg, `Serology ${stamp}`)?.supervisorStaffId === people.Kofi);
check('the predecessor holds nothing', (reg.people.find(p => p.staffId === people.Ama)?.posts ?? []).length === 0,
  JSON.stringify(reg.people.find(p => p.staffId === people.Ama)?.posts));

staffRow = (await j('/staff', { token: A })).json.find(s => s.id === people.Ama);
check('and the predecessor no longer reads as the supervisor on the staff register',
  !String(staffRow?.primaryPosition ?? '').includes('Supervisor'), String(staffRow?.primaryPosition));
check('the register reports no conflicts', (reg.conflicts ?? []).length === 0, JSON.stringify(reg.conflicts));

/* ========================================================================
   A grade is not an office
   ===================================================================== */
section('A grade is held by everybody graded into it');
for (const who of ['Ama', 'Yaa', 'Kwesi']) {
  await j('/appointments', { token: A, method: 'POST', body: { positionId: gradeId, staffId: people[who] } });
}
reg = await register();
const gradeRow = postNamed(reg, `Laboratory Technician ${stamp}`);
check('three people hold the same grade, and none displaced another', (gradeRow?.graded ?? []).length === 3,
  JSON.stringify(gradeRow?.graded?.map(g => g.name)));
check('a grade is not treated as an office', gradeRow?.isOffice === false);

/* ========================================================================
   A person may hold several posts
   ===================================================================== */
section('A person may hold several posts');
const officer = await j('/positions', { token: A, method: 'POST', body: { title: `Safety Officer ${stamp}`, isCore: true } });
await j('/appointments', { token: A, method: 'POST', body: { positionId: officer.json?.id, staffId: people.Kofi } });
reg = await register();
const kofi = reg.people.find(p => p.staffId === people.Kofi);
check('the supervisor also holds the safety office', (kofi?.posts ?? []).length === 2, JSON.stringify(kofi?.posts));
check('and still runs the unit', unitNamed(reg, `Serology ${stamp}`)?.supervisorStaffId === people.Kofi);

/* ========================================================================
   One supervisor per unit
   ===================================================================== */
section('A unit has one supervising post');
const rival = await j('/positions', { token: A, method: 'POST', body: { title: `Serology Unit Head ${stamp}`, isCore: true } });
const claim = await j(`/appointments/posts/${rival.json?.id}/supervises`, {
  token: A, method: 'PUT', body: { sectionId: unitId },
});
check('a second post cannot claim the same unit', claim.status === 409, `${claim.status} ${JSON.stringify(claim.json)}`);
check('and the refusal names the post that already has it',
  String(claim.json?.error ?? '').includes('Serology Unit Supervisor'), String(claim.json?.error));

/* ========================================================================
   Vacating
   ===================================================================== */
section('A post can be left vacant, and it says so');
r = await j('/appointments/vacate', { token: A, method: 'POST', body: { positionId: postId, staffId: people.Kofi } });
check('an appointment can be ended', r.status === 200, JSON.stringify(r.json));
reg = await register();
check('the post reads as vacant', postNamed(reg, `Serology Unit Supervisor ${stamp}`)?.holder === null);
check('and the unit has no supervisor rather than a stale one',
  unitNamed(reg, `Serology ${stamp}`)?.supervisorStaffId === null,
  JSON.stringify(unitNamed(reg, `Serology ${stamp}`)));
await j('/appointments', { token: A, method: 'POST', body: { positionId: postId, staffId: people.Kofi } });

/* ========================================================================
   The doors that used to go round the register
   ===================================================================== */
section('Every other door leads here');

const viaUnit = await j(`/section-config/sections/${unitId}`, {
  token: A, method: 'PUT', body: { name: `Serology ${stamp}`, headStaffId: people.Yaa },
});
check('the unit profile no longer appoints a supervisor', viaUnit.status === 200);
check('and says where it is done', String(viaUnit.json?.note ?? '').includes('Appointments'), JSON.stringify(viaUnit.json));
reg = await register();
check('the unit is still run by the person appointed to the post',
  unitNamed(reg, `Serology ${stamp}`)?.supervisorStaffId === people.Kofi,
  JSON.stringify(unitNamed(reg, `Serology ${stamp}`)?.supervisorName));

const viaStaff = await j(`/staff/${people.Yaa}`, { token: A, method: 'PUT', body: { positionId: postId } });
check('the personnel register no longer changes a post', viaStaff.status === 200);
check('and says where it is done', String(viaStaff.json?.note ?? '').includes('Appointments'), JSON.stringify(viaStaff.json));
reg = await register();
check('the post still has exactly one holder, the appointed one',
  postNamed(reg, `Serology Unit Supervisor ${stamp}`)?.holder?.staffId === people.Kofi);

const viaOrganogram = await j(`/positions/${postId}/occupant`, {
  token: A, method: 'POST', body: { staffId: people.Yaa, assignmentType: 'primary' },
});
check('the organogram appoints through the register', viaOrganogram.status === 201, JSON.stringify(viaOrganogram.json)?.slice(0, 140));
reg = await register();
check('so it hands the post over rather than adding a second holder',
  postNamed(reg, `Serology Unit Supervisor ${stamp}`)?.holder?.staffId === people.Yaa
  && (reg.conflicts ?? []).length === 0,
  JSON.stringify(reg.conflicts));
check('and the unit went with it', unitNamed(reg, `Serology ${stamp}`)?.supervisorStaffId === people.Yaa);
check('the person it was taken from holds only what is left',
  !(reg.people.find(p => p.staffId === people.Kofi)?.posts ?? []).some(t => t.includes('Unit Supervisor')),
  JSON.stringify(reg.people.find(p => p.staffId === people.Kofi)?.posts));

const registered = await j('/staff/register', {
  token: A, method: 'POST',
  body: { fullName: `Esi ${stamp}`, firstName: 'Esi', surname: stamp, positionIds: [postId],
    primaryRoleId: benchGrade.id, sectionId: homeUnitId },
});
check('registering somebody into an occupied post is allowed', registered.status === 201, JSON.stringify(registered.json)?.slice(0, 140));
reg = await register();
check('and it hands the post over rather than doubling it',
  postNamed(reg, `Serology Unit Supervisor ${stamp}`)?.holder?.staffId === registered.json?.staffId
  && (reg.conflicts ?? []).length === 0,
  JSON.stringify(reg.conflicts));

/* ========================================================================
   What the system reads afterwards
   ===================================================================== */
section('What the rest of the system reads');
const units = (await j('/section-config/sections', { token: A })).json ?? [];
const serology = (Array.isArray(units) ? units : units.sections ?? []).find(s => Number(s.id) === Number(unitId));
check('the unit record names the appointed supervisor — which is what scheduling, the duty roster, alert routing and quality control all read',
  Number(serology?.headStaffId ?? serology?.head_staff_id ?? 0) === Number(registered.json?.staffId),
  JSON.stringify({ unit: serology, expected: registered.json?.staffId })?.slice(0, 200));

const dup = await j('/appointments', { token: A, method: 'POST', body: { positionId: postId, staffId: registered.json?.staffId } });
check('appointing the same person again is refused rather than duplicated', dup.status === 409, `${dup.status}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
