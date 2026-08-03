/** Dump the effective permission map for every seeded role. */
const BASE = process.env.API || 'http://127.0.0.1:4402/api';
const PW = 'Passw0rd!test';
const j = async (p, o = {}) => {
  const r = await fetch(`${BASE}${p}`, { headers: { 'Content-Type': 'application/json', ...(o.token ? { Authorization: `Bearer ${o.token}` } : {}) }, method: o.method || 'GET', body: o.body ? JSON.stringify(o.body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
};

const st = await j('/setup/status');
if (!st.json?.setupComplete) await j('/setup/initialize', { method: 'POST', body: { facilityName: 'Audit Lab', username: 'admin', password: PW, fullName: 'Admin User' } });
const { json: a } = await j('/auth/login', { method: 'POST', body: { username: 'admin', password: PW } });
const A = a.token;
const roles = (await j('/roles', { token: A })).json;

const MODULES_OF_INTEREST = process.argv.slice(2);
const out = {};
for (const role of roles) {
  const u = `probe_${role.name.toLowerCase().replace(/\W+/g, '_')}`;
  await j('/users', { token: A, method: 'POST', body: { username: u, password: PW, fullName: `Probe ${role.name}`, roleId: role.id } });
  const login = await j('/auth/login', { method: 'POST', body: { username: u, password: PW } });
  if (login.status !== 200) { console.log('!! could not probe', role.name, login.status); continue; }
  out[role.name] = login.json.permissions;
}

const allModules = [...new Set(Object.values(out).flatMap(m => Object.keys(m)))].sort();
const show = MODULES_OF_INTEREST.length ? MODULES_OF_INTEREST : allModules;
const SHORT = { view: 'v', create: 'c', edit: 'e', void_archive: 'x', export: 'X', print: 'p', approve: 'A' };

const roleNames = Object.keys(out);
const lower = ['Technician', 'Biomedical Scientist', 'Quality User', 'Data Officer', 'POCT Officer', 'Blood Bank Unit Head', 'Safety Manager'];
console.log('\nLegend: v=view c=create e=edit x=void/archive X=export p=print A=approve\n');
console.log('MODULE'.padEnd(26) + lower.map(r => r.slice(0, 11).padEnd(13)).join(''));
console.log('-'.repeat(26 + lower.length * 13));
for (const m of show) {
  const row = lower.map(r => (out[r]?.[m] || []).map(x => SHORT[x] || x).join('').padEnd(13));
  if (row.every(c => c.trim() === '')) continue;
  console.log(m.padEnd(26) + row.join(''));
}
console.log('\n(blank = no access to that module at all)');
