/**
 * Core laboratory documents point at the register, not at a second upload.
 *
 *   node scripts/core-documents-check.mjs
 *
 * The Quality Manual, Laboratory Handbook and Safety Manual are ordinary
 * controlled documents. This screen used to match them by their document TYPE
 * string, so a manual filed as anything else never appeared and the only
 * remedy on offer was to upload it again.
 */
const BASE = process.env.API || 'http://127.0.0.1:4420/api';
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
  return { status: r.status, json: await r.json().catch(() => null) };
};

if (!(await j('/setup/status')).json?.setupComplete)
  await j('/setup/initialize', { method: 'POST', body: { facilityName: 'Core Lab', username: 'admin', password: PW, fullName: 'Admin User' } });
const A = (await j('/auth/login', { method: 'POST', body: { username: 'admin', password: PW } })).json.token;
const stamp = Date.now();

console.log('\n[1] The three standard core documents exist as places to fill');
let slots = (await j('/laboratory/core-documents', { token: A })).json;
const keys = slots.map(s => s.slotKey);
for (const k of ['quality_manual', 'laboratory_handbook', 'safety_manual'])
  check(`${k} is there`, keys.includes(k), JSON.stringify(keys));
check('and they are marked as standard', slots.filter(s => s.isSystem === 1).length >= 3);

console.log('\n[2] A document already in the register can be chosen — whatever its type');
// Filed as "Policy", which the old type-matching screen would never have found.
const doc = await j('/documents', { token: A, method: 'POST', body: {
  title: `Laboratory Quality Manual ${stamp}`, documentType: 'Policy', documentCode: `QM-${stamp}`,
} });
check('a controlled document is registered', doc.status === 201 || doc.status === 200, JSON.stringify(doc.json));
const qmSlot = slots.find(s => s.slotKey === 'quality_manual');
const assigned = await j(`/laboratory/core-documents/${qmSlot.id}/document`, { token: A, method: 'PUT', body: { documentId: doc.json.id } });
check('it can be made the Quality Manual', assigned.status === 200, JSON.stringify(assigned.json));
slots = (await j('/laboratory/core-documents', { token: A })).json;
const qm = slots.find(s => s.slotKey === 'quality_manual');
check('the core place now names it', qm.documentId === doc.json.id && qm.documentTitle.includes('Quality Manual'), JSON.stringify(qm.documentTitle));
check('and carries what is needed to open it', qm.documentId != null);
check('the document itself knows it is core',
  (await j(`/documents/${doc.json.id}`, { token: A })).json.core_slot_key === 'quality_manual');

console.log('\n[3] One document fills one core place');
const hbSlot = slots.find(s => s.slotKey === 'laboratory_handbook');
const clash = await j(`/laboratory/core-documents/${hbSlot.id}/document`, { token: A, method: 'PUT', body: { documentId: doc.json.id } });
check('the same document cannot also be the Handbook', clash.status === 400 && /already the/i.test(clash.json.error), JSON.stringify(clash.json));
check('an unknown document is refused',
  (await j(`/laboratory/core-documents/${hbSlot.id}/document`, { token: A, method: 'PUT', body: { documentId: 999999 } })).status === 400);

console.log('\n[4] An assignment can be cleared and re-made');
check('clearing works', (await j(`/laboratory/core-documents/${qmSlot.id}/document`, { token: A, method: 'PUT', body: { documentId: null } })).status === 200);
slots = (await j('/laboratory/core-documents', { token: A })).json;
check('the place is empty again', !slots.find(s => s.slotKey === 'quality_manual').documentId);
check('and the document is no longer marked core',
  !(await j(`/documents/${doc.json.id}`, { token: A })).json.core_slot_key);
await j(`/laboratory/core-documents/${qmSlot.id}/document`, { token: A, method: 'PUT', body: { documentId: doc.json.id } });

console.log('\n[5] A laboratory can add core documents of its own');
const added = await j('/laboratory/core-documents', { token: A, method: 'POST', body: { label: `Ethics Policy ${stamp}`, description: 'How the laboratory handles ethical matters.' } });
check('adding one works', added.status === 201, JSON.stringify(added.json));
slots = (await j('/laboratory/core-documents', { token: A })).json;
const mine = slots.find(s => s.id === added.json.id);
check('it appears alongside the standard ones', !!mine && mine.isSystem === 0);
check('a duplicate name is refused',
  (await j('/laboratory/core-documents', { token: A, method: 'POST', body: { label: `Ethics Policy ${stamp}` } })).status === 400);
check('it can be renamed', (await j(`/laboratory/core-documents/${mine.id}`, { token: A, method: 'PUT', body: { label: 'Research Ethics Policy' } })).status === 200);
check('and removed', (await j(`/laboratory/core-documents/${mine.id}`, { token: A, method: 'DELETE' })).status === 200);
const removeStandard = await j(`/laboratory/core-documents/${qmSlot.id}`, { token: A, method: 'DELETE' });
check('but a standard one cannot be removed', removeStandard.status === 400 && /standard/i.test(removeStandard.json.error), JSON.stringify(removeStandard.json));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
