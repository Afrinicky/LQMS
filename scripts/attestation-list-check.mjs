/**
 * The attestation list shows the right people, with their real signatures.
 *
 *   API_PORT=4425 SECH_LIMS_DATA_DIR=/tmp/att-check npx tsx server/index.ts &
 *   node scripts/attestation-list-check.mjs
 *
 * Four things are asserted, all of them regressions this laboratory reported:
 *   1. a signed attestation carries the signer's own signature image on the
 *      printed list, inlined so it survives the print window;
 *   2. the printed list names a Designation, not a Position, and no longer
 *      carries the unit/section column;
 *   3. somebody who has left and never signed is off the list entirely — and
 *      out of the counts that drive the register and the tab badge;
 *   4. somebody who signed before leaving stays on it, signature and all.
 */
const BASE = process.env.API || 'http://127.0.0.1:4425/api';
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
const text = async (p, token) => {
  const r = await fetch(`${BASE}${p}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  return { status: r.status, body: await r.text() };
};

if (!(await j('/setup/status')).json?.setupComplete)
  await j('/setup/initialize', { method: 'POST', body: { facilityName: 'Attestation Lab', username: 'admin', password: PW, fullName: 'Admin User' } });
const A = (await j('/auth/login', { method: 'POST', body: { username: 'admin', password: PW } })).json.token;
const stamp = Date.now();

// A one-pixel PNG stands in for a scanned signature.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
async function uploadSignatureFor(token) {
  const form = new FormData();
  form.append('file', new Blob([PNG], { type: 'image/png' }), 'signature.png');
  const r = await fetch(`${BASE}/signatures/me`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
  return r.ok;
}

console.log('\n[setup] three people and a controlled document');
const roles = (await j('/roles', { token: A })).json || [];
const roleId = (roles.find(r => /staff|technician|scientist/i.test(r.name)) || roles[roles.length - 1])?.id;
check('a role to give the test accounts', !!roleId, JSON.stringify(roles.map(r => r.name)));
const people = {};
for (const [key, name] of [['stays', 'Ama Stays'], ['leftUnsigned', 'Kofi Never-Signed'], ['leftSigned', 'Efua Signed-Then-Left']]) {
  const s = await j('/staff', { token: A, method: 'POST', body: {
    fullName: `${name} ${stamp}`, employeeNo: `E${stamp}${Object.keys(people).length}`,
    designation: 'Medical Laboratory Scientist', email: `${key}${stamp}@lab.test`,
  } });
  people[key] = s.json;
  check(`staff created: ${key}`, !!s.json?.id, JSON.stringify(s.json));
  // Each needs a login so they can sign personally — an attestation may never
  // be signed on somebody's behalf.
  const u = await j('/users', { token: A, method: 'POST', body: {
    username: `${key}${stamp}`, password: PW, fullName: name, staffId: s.json.id, roleId,
  } });
  people[key].username = `${key}${stamp}`;
  people[key].userCreated = u.status < 300;
}

const doc = await j('/documents', { token: A, method: 'POST', body: {
  documentCode: `SECHPO${stamp % 1000}`, title: 'Attestation list check SOP', documentType: 'SOP',
} });
check('document created', !!doc.json?.id, JSON.stringify(doc.json));
const docId = doc.json.id;
const ver = await j(`/documents/${docId}/versions`, { token: A, method: 'POST', body: { versionNumber: '1.0', versionLabel: '1.0', effectiveDate: '2026-01-01' } });
check('version created', !!ver.json?.id, JSON.stringify(ver.json));

const assign = await j(`/documents/${docId}/assign-attestation`, { token: A, method: 'POST', body: {
  targetType: 'staff', staffIds: [people.stays.id, people.leftUnsigned.id, people.leftSigned.id],
} });
check('three attestations assigned', assign.json?.assigned === 3, JSON.stringify(assign.json));

console.log('\n[1] Efua signs with her own signature, then leaves');
const efuaToken = (await j('/auth/login', { method: 'POST', body: { username: people.leftSigned.username, password: PW } })).json?.token;
check('Efua can sign in', !!efuaToken);
check('Efua has a signature on file', await uploadSignatureFor(efuaToken));
const signed = await j(`/documents/${docId}/attest`, { token: efuaToken, method: 'POST', body: {} });
check('Efua signs her attestation', signed.json?.ok === true, JSON.stringify(signed.json));

for (const key of ['leftUnsigned', 'leftSigned']) {
  const r = await fetch(`${BASE}/staff/${people[key].id}?mode=deactivate`, {
    method: 'DELETE', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${A}` },
    body: JSON.stringify({ exitReason: 'End of contract', exitDate: '2026-06-30' }),
  });
  check(`${key} recorded as having left`, r.ok, String(r.status));
}

console.log('\n[2] The on-screen list drops the leaver who never signed');
const list = (await j(`/documents/attestations/list?documentId=${docId}`, { token: A })).json;
const names = list.map(r => r.staff_name);
check('Ama (still here, pending) is listed', names.some(n => n?.includes('Ama Stays')), JSON.stringify(names));
check('Efua (signed, then left) is listed', names.some(n => n?.includes('Efua Signed-Then-Left')), JSON.stringify(names));
check('Kofi (left without signing) is NOT listed', !names.some(n => n?.includes('Kofi Never-Signed')), JSON.stringify(names));

console.log('\n[3] The counts behind the picker and the register agree');
const picker = (await j('/documents/attestations/documents', { token: A })).json.find(d => d.id === docId);
check('picker counts two, not three', Number(picker?.attestations_total) === 2, JSON.stringify(picker));
check('picker counts one signed', Number(picker?.attestations_signed) === 1, JSON.stringify(picker));
check('picker counts one pending', Number(picker?.attestations_pending) === 1, JSON.stringify(picker));
const register = (await j('/documents', { token: A })).json.find(d => d.id === docId);
check('register total matches', Number(register?.attestations_total) === 2, JSON.stringify({ t: register?.attestations_total }));

console.log('\n[4] The printed list: signature, designation, no section');
const printed = await text(`/documents/${docId}/attestations/print`, A);
check('print renders', printed.status === 200, String(printed.status));
const html = printed.body;
check('the signature image travels with the page', html.includes('<img src="data:image/png;base64,'), 'no inline signature found');
check('the column is Designation', /<th[^>]*>Designation<\/th>/.test(html));
check('Position is gone', !/<th[^>]*>Position<\/th>/.test(html));
check('Section / unit is gone', !/Section\s*\/\s*unit/.test(html));
check('there is a Signature column', /<th[^>]*>Signature<\/th>/.test(html));
check('the designation is printed', html.includes('Medical Laboratory Scientist'));
check('Efua is on the printed list', html.includes('Efua Signed-Then-Left'));
check('Ama is on the printed list', html.includes('Ama Stays'));
check('Kofi is not on the printed list', !html.includes('Kofi Never-Signed'));

console.log(`\n${fail === 0 ? 'ALL CHECKS PASSED' : 'FAILURES PRESENT'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
