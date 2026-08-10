/**
 * Verifies the other half of the personnel requirement: a member of staff
 * reaches their OWN record and nobody else's.
 *
 * Run against a server seeded by scripts/rbac-roles.mjs (which creates the
 * per-role probe users):  node scripts/rbac-selfservice.mjs
 */
const BASE = process.env.API || 'http://127.0.0.1:4405/api';
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
    body: o.body ? JSON.stringify(o.body) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const login = async u => (await j('/auth/login', { method: 'POST', body: { username: u, password: PW } })).json;

const admin = await login('admin');
const A = admin.token;

// Give the Technician probe user a staff record of their own, and make sure a
// second, unrelated staff record exists to attempt to reach.
const tech = await login('probe_technician');
const mine = await j('/staff', { token: A, method: 'POST', body: { fullName: 'Probe Technician', email: 'probe.tech@lab' } });
const other = await j('/staff', { token: A, method: 'POST', body: { fullName: 'Someone Else', email: 'someone@lab' } });
const myStaffId = mine.json?.id, otherStaffId = other.json?.id;
await j(`/users/${tech.user.id}`, { token: A, method: 'PUT', body: { staffId: myStaffId } });
const T = (await login('probe_technician')).token;

console.log('\n[Self-service — a Technician and their own record]');
const own = await j(`/staff/${myStaffId}`, { token: T });
check('can open their OWN staff record', own.status === 200, `got ${own.status}`);

const ownEdit = await j(`/staff/${myStaffId}`, { token: T, method: 'PUT', body: { phone: '024-000-0000' } });
check('can update their OWN contact details', ownEdit.status === 200, `got ${ownEdit.status}`);

const ownIdentity = await j(`/staff/${myStaffId}`, { token: T, method: 'PUT', body: { professionalLicence: 'FORGED-1' } });
check('CANNOT rewrite their own licence/registration', ownIdentity.status === 403, `got ${ownIdentity.status}`);

console.log('\n[Isolation — the same Technician and a colleague]');
const theirs = await j(`/staff/${otherStaffId}`, { token: T });
check('CANNOT open a colleague\'s record', theirs.status === 403, `got ${theirs.status}`);

const theirsEdit = await j(`/staff/${otherStaffId}`, { token: T, method: 'PUT', body: { fullName: 'Hacked' } });
check('CANNOT edit a colleague\'s record', theirsEdit.status === 403, `got ${theirsEdit.status}`);

for (const [label, path] of [
  ['declarations', '/personnel/declarations'],
  ['appraisals', '/personnel/appraisals'],
  ['competency assessments', '/personnel/competency'],
  ['the staff document register', '/personnel/staff-documents'],
  ['technical authorizations', '/authorizations/technical'],
  ['orientation records', '/personnel/orientations'],
  ['duty rosters', '/scheduling/duty-rosters'],
]) {
  const r = await j(path, { token: T });
  check(`CANNOT list everyone's ${label}`, r.status === 403, `got ${r.status}`);
}

console.log('\n[Directory — names stay available so pickers keep working]');
const dir = await j('/staff', { token: T });
const row = Array.isArray(dir.json) ? dir.json[0] : null;
check('can still list colleague NAMES', dir.status === 200 && Array.isArray(dir.json) && dir.json.length > 0, `got ${dir.status}`);
check('directory carries no date of birth', row ? !('dateOfBirth' in row) : false, JSON.stringify(row && Object.keys(row)));
check('directory carries no national ID', row ? !('nationalIdNumber' in row) : false);
check('directory carries no licence details', row ? !('professionalLicence' in row) : false);

console.log('\n[Own profile and inbox remain reachable]');
const prof = await j('/personnel/my-profile', { token: T });
check('own profile loads', prof.status === 200, `got ${prof.status}`);
const tasks = await j('/personnel/my-tasks', { token: T });
check('own tasks load (own training, declarations, duties)', tasks.status === 200, `got ${tasks.status}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
