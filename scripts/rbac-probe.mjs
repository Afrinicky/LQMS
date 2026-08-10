/** Probe what lower-rank roles can actually WRITE, not just see. */
const BASE = process.env.API || 'http://127.0.0.1:4402/api';
const PW = 'thistle harbour crane';
const j = async (p, o = {}) => {
  const r = await fetch(`${BASE}${p}`, { headers: { 'Content-Type': 'application/json', ...(o.token ? { Authorization: `Bearer ${o.token}` } : {}) }, method: o.method || 'GET', body: o.body ? JSON.stringify(o.body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const login = async u => (await j('/auth/login', { method: 'POST', body: { username: u, password: PW } })).json;

const A = (await login('admin')).token;
// A victim staff record to attempt to read/modify.
const victim = await j('/staff', { token: A, method: 'POST', body: { fullName: 'Victim Person', email: 'victim@lab' } });
const vid = victim.json?.id;
console.log('victim staff id:', vid, '(create status', victim.status + ')');

const PROBES = [
  ['GET  /staff/:id (another person\'s full record)', vid && `/staff/${vid}`, 'GET', null],
  ['PUT  /staff/:id (edit another person)', vid && `/staff/${vid}`, 'PUT', { fullName: 'Hacked Name' }],
  ['GET  /personnel/declarations (everyone\'s)', '/personnel/declarations', 'GET', null],
  ['GET  /personnel/appraisals (everyone\'s)', '/personnel/appraisals', 'GET', null],
  ['GET  /personnel/competency (everyone\'s)', '/personnel/competency', 'GET', null],
  ['POST /equipment (add new equipment)', '/equipment', 'POST', { name: 'Probe Analyser', equipmentNumber: 'PROBE-1' }],
  ['POST /supplier-inventory/items (add stock item)', '/supplier-inventory/items', 'POST', { name: 'Probe Item', itemCode: 'PRB-1' }],
  ['POST /supplier-inventory/suppliers (add supplier)', '/supplier-inventory/suppliers', 'POST', { name: 'Probe Supplier' }],
  ['POST /verification-validation (new study)', '/verification-validation', 'POST', { title: 'Probe study', methodName: 'X' }],
  ['POST /process-management/reference-intervals', '/process-management/reference-intervals', 'POST', { testName: 'X', analyte: 'Y' }],
  ['GET  /organisation/budget-projections', '/organisation/budget-projections', 'GET', null],
  ['GET  /organisation/registrations', '/organisation/registrations', 'GET', null],
  ['GET  /information-management/security-incidents', '/information-management/security-incidents', 'GET', null],
  ['POST /improvement/projects (new project)', '/improvement/projects', 'POST', { title: 'Probe project' }],
  ['GET  /customer-focus/stakeholders', '/customer-focus/stakeholders', 'GET', null],
  ['POST /customer-focus/stakeholders', '/customer-focus/stakeholders', 'POST', { name: 'Probe Stakeholder' }],
  ['POST /documents (create document)', '/documents', 'POST', { title: 'Probe doc', documentType: 'sop' }],
  ['GET  /notifications/rules', '/notifications/rules', 'GET', null],
];

for (const role of ['Technician', 'Biomedical Scientist', 'POCT Officer', 'Data Officer']) {
  const u = `probe_${role.toLowerCase().replace(/\W+/g, '_')}`;
  const s = await login(u);
  if (!s?.token) { console.log(`\n### ${role}: could not log in`); continue; }
  console.log(`\n### ${role}`);
  for (const [label, path, method, body] of PROBES) {
    if (!path) continue;
    const r = await j(path, { token: s.token, method, body });
    const verdict = r.status === 403 ? 'BLOCKED' : (r.status < 400 ? '*** ALLOWED ***' : `(${r.status})`);
    if (verdict !== 'BLOCKED') console.log(`  ${verdict.padEnd(16)} ${label}`);
  }
}
console.log('\n(only non-blocked results shown; BLOCKED = correctly refused)');
