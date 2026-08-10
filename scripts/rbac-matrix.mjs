/**
 * Verifies the redesigned access-control screen actually controls access:
 * setting a level for a cohort or a person must change what the API allows,
 * immediately and in both directions.
 *
 *   node scripts/rbac-matrix.mjs
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
const perms = async token => (await j('/auth/permissions', { token })).json.permissions;

const A = (await login('admin')).token;
const roles = (await j('/roles', { token: A })).json;
const techRole = roles.find(r => r.name === 'Technician');

const setLevel = (scope, subjectId, permKey, level) =>
  j('/permissions/level', { token: A, method: 'POST', body: { scope, subjectId, permKey, level } });

console.log('\n[Catalogue backs the screen]');
const cat = (await j('/permissions/catalogue', { token: A })).json;
check('catalogue returns role grants', !!cat?.roles && Object.keys(cat.roles).length > 0);
check('catalogue returns per-user overrides', Array.isArray(cat?.userOverrideKeys));

console.log('\n[Granting a cohort a level opens exactly that much]');
const tech = () => login('probe_technician');
let before = await perms((await tech()).token);
check('Technician starts with no access to appraisals', !before['personnel.appraisals'], JSON.stringify(before['personnel.appraisals']));

await setLevel('role', techRole.id, 'personnel.appraisals', 'view');
let after = await perms((await tech()).token);
check('View grants view+print, nothing more',
  JSON.stringify((after['personnel.appraisals'] || []).sort()) === JSON.stringify(['print', 'view']),
  JSON.stringify(after['personnel.appraisals']));
const listOk = await j('/personnel/appraisals', { token: (await tech()).token });
check('the API now allows the appraisals list', listOk.status === 200, `got ${listOk.status}`);

await setLevel('role', techRole.id, 'personnel.appraisals', 'manage');
after = await perms((await tech()).token);
check('Manage adds create/edit/export',
  ['view', 'print', 'create', 'edit', 'export'].every(a => (after['personnel.appraisals'] || []).includes(a)),
  JSON.stringify(after['personnel.appraisals']));
check('Manage still withholds approve', !(after['personnel.appraisals'] || []).includes('approve'));

console.log('\n[Revoking closes it again — the direction that actually matters]');
await setLevel('role', techRole.id, 'personnel.appraisals', 'none');
after = await perms((await tech()).token);
check('No access removes the area from the map entirely', !after['personnel.appraisals'], JSON.stringify(after['personnel.appraisals']));
const listGone = await j('/personnel/appraisals', { token: (await tech()).token });
check('the API refuses the appraisals list again', listGone.status === 403, `got ${listGone.status}`);

console.log('\n[One person can differ from their cohort]');
const t = await tech();
await setLevel('user', t.user.id, 'personnel.appraisals', 'view');
let mine = await perms((await tech()).token);
check('an individual override opens it for that person', (mine['personnel.appraisals'] || []).includes('view'), JSON.stringify(mine['personnel.appraisals']));

// A second Technician must be unaffected by the first one's override.
await j('/users', { token: A, method: 'POST', body: { username: 'probe_tech_peer', password: PW, fullName: 'Peer Tech', roleId: techRole.id } });
const peer = await perms((await login('probe_tech_peer')).token);
check('their colleagues on the same role are unaffected', !peer['personnel.appraisals'], JSON.stringify(peer['personnel.appraisals']));

await j(`/permissions/user-override/${t.user.id}/personnel.appraisals`, { token: A, method: 'DELETE' });
mine = await perms((await tech()).token);
check('clearing the override returns them to their role', !mine['personnel.appraisals'], JSON.stringify(mine['personnel.appraisals']));

console.log('\n[A level cannot smuggle in more than it says]');
await setLevel('role', techRole.id, 'documents.workflow', 'view');
after = await perms((await tech()).token);
check('View on document workflow does not grant approve', !(after['documents.workflow'] || []).includes('approve'));
await setLevel('role', techRole.id, 'documents.workflow', 'none');

console.log('\n[Module access follows its features]');
await setLevel('role', techRole.id, 'personnel.register', 'view');
after = await perms((await tech()).token);
check('granting one feature makes its module visible', (after['personnel'] || []).includes('view'));
await setLevel('role', techRole.id, 'personnel.register', 'none');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
