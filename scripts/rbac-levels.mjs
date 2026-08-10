/**
 * Prints the access LEVEL every role holds in every area — the review a
 * laboratory manager actually needs before signing off the defaults.
 *
 *   node scripts/rbac-levels.mjs            # every role
 *   node scripts/rbac-levels.mjs personnel  # one module
 */
const BASE = process.env.API || 'http://127.0.0.1:4408/api';
const PW = 'thistle harbour crane';

const LEVEL_ACTIONS = {
  none: [], view: ['view', 'print'], contribute: ['view', 'print', 'create'],
  manage: ['view', 'print', 'create', 'edit', 'export'],
  full: ['view', 'print', 'create', 'edit', 'export', 'void_archive', 'approve'],
};
const ORDER = ['none', 'view', 'contribute', 'manage', 'full'];
const SHORT = { none: '·', view: 'View', contribute: 'Contrib', manage: 'Manage', full: 'FULL' };
const levelOf = actions => {
  const held = new Set(actions || []);
  for (const l of [...ORDER].reverse()) {
    if (l === 'none') continue;
    if (LEVEL_ACTIONS[l].every(a => held.has(a))) return l;
  }
  return held.size ? 'view' : 'none';
};

const j = async (p, o = {}) => {
  const r = await fetch(`${BASE}${p}`, {
    method: o.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(o.token ? { Authorization: `Bearer ${o.token}` } : {}) },
    body: o.body ? JSON.stringify(o.body) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => null) };
};

const st = await j('/setup/status');
if (!st.json?.setupComplete) await j('/setup/initialize', { method: 'POST', body: { facilityName: 'Audit Lab', username: 'admin', password: PW, fullName: 'Admin User' } });
const A = (await j('/auth/login', { method: 'POST', body: { username: 'admin', password: PW } })).json.token;
const roles = (await j('/roles', { token: A })).json;

const maps = {};
for (const role of roles) {
  const u = `probe_${role.name.toLowerCase().replace(/\W+/g, '_')}`;
  await j('/users', { token: A, method: 'POST', body: { username: u, password: PW, fullName: `Probe ${role.name}`, roleId: role.id } });
  const login = await j('/auth/login', { method: 'POST', body: { username: u, password: PW } });
  if (login.status === 200) maps[role.name] = login.json.permissions;
}

const filter = process.argv[2];
const areas = [...new Set(Object.values(maps).flatMap(m => Object.keys(m)))]
  .filter(k => k.includes('.'))
  .filter(k => !filter || k.startsWith(filter))
  .sort();

const NAMES = Object.keys(maps).filter(n => n !== 'System Administrator');
const W = 9;
console.log('\nAccess level by role (System Administrator omitted — holds everything)\n');
console.log('AREA'.padEnd(34) + NAMES.map(n => n.replace(/[a-z ]/g, '').padEnd(W)).join(''));
console.log(NAMES.map(n => `  ${n.replace(/[a-z ]/g, '')} = ${n}`).join('\n'));
console.log('-'.repeat(34 + NAMES.length * W));
for (const area of areas) {
  const cells = NAMES.map(n => SHORT[levelOf(maps[n][area])].padEnd(W));
  if (cells.every(c => c.trim() === '·')) continue;
  console.log(area.padEnd(34) + cells.join(''));
}
