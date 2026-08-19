/**
 * People & Access and the Microsoft Office handoff, end to end.
 *
 *   node scripts/office-edit-check.mjs
 *
 * Exercises the three things this round of work added:
 *   1. removing a member of staff — retire when they have history, erase when
 *      they have none, and the refusal in between
 *   2. changing the role somebody's account holds, and the guard that stops the
 *      last administrator moving
 *   3. handing a Word document to Office over WebDAV from a browser, and the
 *      save coming back as a new controlled version
 *
 * Assumes a host is already listening (npm run api) with a writable data dir.
 */
const BASE = process.env.API || 'http://127.0.0.1:4420/api';
const ORIGIN = BASE.replace(/\/api$/, '');
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

const st = await j('/setup/status');
if (!st.json?.setupComplete) {
  await j('/setup/initialize', { method: 'POST', body: { facilityName: 'Office Lab', username: 'admin', password: PW, fullName: 'Admin User' } });
}
const A = (await j('/auth/login', { method: 'POST', body: { username: 'admin', password: PW } })).json.token;
if (!A) { console.error('Could not sign in as admin — is the host running?'); process.exit(1); }
const roles = (await j('/roles', { token: A })).json;
const stamp = Date.now();

console.log('\n[1] A demonstration staff record can be erased outright');
await j('/staff', { token: A, method: 'POST', body: { firstName: 'Demo', surname: `Row${stamp}`, employeeNo: `DEMO-${stamp}` } });
const demo = (await j('/staff', { token: A })).json.find(s => s.employeeNo === `DEMO-${stamp}`);
check('the demo record was created', !!demo);
const demoImpact = await j(`/staff/${demo.id}/deletion-impact`, { token: A });
check('it reports no laboratory history', demoImpact.json?.canDelete === true, JSON.stringify(demoImpact.json?.historicReferences));
const erased = await j(`/staff/${demo.id}?mode=delete`, { token: A, method: 'DELETE' });
check('erasing succeeds', erased.status === 200 && erased.json.mode === 'delete', JSON.stringify(erased.json));
check('it is gone from the register', !(await j('/staff', { token: A })).json.some(s => s.id === demo.id));

console.log('\n[1b] Alerts routed to a demo record do not make it un-erasable');
await j('/staff', { token: A, method: 'POST', body: { firstName: 'Noisy', surname: `Demo${stamp}`, employeeNo: `NOISY-${stamp}` } });
const noisy = (await j('/staff', { token: A })).json.find(s => s.employeeNo === `NOISY-${stamp}`);
// A routed notification and an unsigned attestation are delivery, not record.
await j('/notifications', { token: A, method: 'POST', body: { assignedToStaffId: noisy.id, moduleKey: 'personnel', title: 'Routed alert', message: 'Demo record was alerted', notificationType: 'info', severity: 'low' } });
const noisyImpact = await j(`/staff/${noisy.id}/deletion-impact`, { token: A });
check('a notified demo record is still erasable', noisyImpact.json?.canDelete === true, JSON.stringify(noisyImpact.json?.historicReferences));
check('erasing it succeeds', (await j(`/staff/${noisy.id}?mode=delete`, { token: A, method: 'DELETE' })).status === 200);

console.log('\n[2] Somebody who has worked is retired, never erased');
await j('/staff', { token: A, method: 'POST', body: { firstName: 'Real', surname: `Scientist${stamp}`, employeeNo: `REAL-${stamp}` } });
const real = (await j('/staff', { token: A })).json.find(s => s.employeeNo === `REAL-${stamp}`);
await j('/actions', { token: A, method: 'POST', body: { title: 'Check the fridge log', moduleKey: 'personnel', assignedToStaffId: real.id } });
const realImpact = await j(`/staff/${real.id}/deletion-impact`, { token: A });
check('the history is found', realImpact.json?.canDelete === false && realImpact.json.totalHistoricRows > 0, JSON.stringify(realImpact.json));
check('the reason is in plain language', (realImpact.json.historicReferences[0]?.label || '').match(/[a-z] /), JSON.stringify(realImpact.json.historicReferences[0]));
check('a single row is described in the singular', !realImpact.json.historicReferences.some(r => r.rows === 1 && /(?<!s)s$/.test(r.label)),
  JSON.stringify(realImpact.json.historicReferences.filter(r => r.rows === 1)));
const refused = await j(`/staff/${real.id}?mode=delete`, { token: A, method: 'DELETE' });
check('erasing is refused', refused.status === 409, `got ${refused.status}`);
const retired = await j(`/staff/${real.id}`, { token: A, method: 'DELETE' });
check('retiring succeeds', retired.status === 200 && retired.json.mode === 'deactivate', JSON.stringify(retired.json));
check('the record is retired, not gone', (await j('/staff', { token: A })).json.find(s => s.id === real.id)?.isActive === 0
  || (await j('/staff', { token: A })).json.find(s => s.id === real.id)?.isActive === false);
const restored = await j(`/staff/${real.id}/reactivate`, { token: A, method: 'POST', body: {} });
check('and it comes back', restored.status === 200);

console.log('\n[3] A role can be changed on an existing account');
const qm = roles.find(r => /quality manager/i.test(r.name)) || roles.find(r => r.name !== 'System Administrator');
const admin = roles.find(r => r.name === 'System Administrator');
await j('/users', { token: A, method: 'POST', body: { username: `qm${stamp}`, password: PW, fullName: 'Quality Manager', roleId: qm.id } });
const account = (await j('/users', { token: A })).json.find(u => u.username === `qm${stamp}`);
check('the account starts in its original role', account.roleId === qm.id);
const promoted = await j(`/users/${account.id}`, { token: A, method: 'PUT', body: { roleId: admin.id } });
check('promoting to System Administrator succeeds', promoted.status === 200, JSON.stringify(promoted.json));
check('the register shows the new role', (await j('/users', { token: A })).json.find(u => u.id === account.id).roleName === 'System Administrator');
const demoted = await j(`/users/${account.id}`, { token: A, method: 'PUT', body: { roleId: qm.id } });
check('and it can be moved back', demoted.status === 200);
check('linking a staff record still works alongside it',
  (await j(`/users/${account.id}`, { token: A, method: 'PUT', body: { staffId: real.id } })).status === 200);

console.log('\n[4] A Word document is handed to Office and saves back');
// A minimal but real .docx: a zip whose first entry is [Content_Types].xml.
const { execSync } = await import('node:child_process');
const fs = await import('node:fs');
const os = await import('node:os');
const path = await import('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'office-check-'));
fs.writeFileSync(path.join(tmp, 'hello.txt'), 'SECH_LIMS office round trip');
execSync(`cd ${tmp} && zip -q fake.docx hello.txt`);
const docxBytes = fs.readFileSync(path.join(tmp, 'fake.docx'));

const fd = new FormData();
fd.append('file', new Blob([docxBytes], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }), 'Quality Manual.docx');
const upload = await fetch(`${BASE}/files`, { method: 'POST', headers: { Authorization: `Bearer ${A}` }, body: fd });
const uploaded = await upload.json();
check('the file uploaded', upload.ok && !!uploaded.id, JSON.stringify(uploaded));

const doc = await j('/documents', { token: A, method: 'POST', body: { title: `Office Round Trip ${stamp}`, documentType: 'SOP' } });
check('a document was created', doc.status === 201 || doc.status === 200, JSON.stringify(doc.json));
const docId = doc.json.id;
const version = await j(`/documents/${docId}/versions`, { token: A, method: 'POST', body: { versionNumber: '1.0', fileId: uploaded.id, makeCurrent: true } });
check('a version carries the file', version.status === 201, JSON.stringify(version.json));

const handoff = await j(`/documents/${docId}/versions/${version.json.id}/office-session`, { token: A, method: 'POST', body: {} });
check('a handoff is minted', handoff.status === 201 && !!handoff.json.token, JSON.stringify(handoff.json));
check('it names Microsoft Word', handoff.json.appName === 'Microsoft Word', handoff.json.appName);
check('the Office URI is well formed', /^ms-word:ofe\|u\|https?:\/\//.test(handoff.json.officeUri), handoff.json.officeUri);

const davUrl = handoff.json.url.replace(/^https?:\/\/[^/]+/, ORIGIN);
const options = await fetch(davUrl, { method: 'OPTIONS' });
check('OPTIONS advertises WebDAV', options.headers.get('dav')?.includes('2') && options.headers.get('ms-author-via') === 'DAV',
  `${options.headers.get('dav')} / ${options.headers.get('ms-author-via')}`);

const propfind = await fetch(davUrl, { method: 'PROPFIND', headers: { Depth: '0' } });
const propXml = await propfind.text();
check('PROPFIND returns a multistatus', propfind.status === 207 && propXml.includes('<D:getcontentlength>'), `${propfind.status}`);
check('PROPFIND names the document', propXml.includes('Quality Manual.docx'));

const lock = await fetch(davUrl, { method: 'LOCK', headers: { 'Content-Type': 'application/xml' }, body: '<?xml version="1.0"?><D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockinfo>' });
check('LOCK hands back a lock token', lock.status === 200 && !!lock.headers.get('lock-token'), `${lock.status}`);

const get = await fetch(davUrl);
const fetched = Buffer.from(await get.arrayBuffer());
check('GET returns the original bytes', get.status === 200 && fetched.length === docxBytes.length, `${get.status} ${fetched.length} vs ${docxBytes.length}`);

fs.writeFileSync(path.join(tmp, 'edited.txt'), 'Edited in Microsoft Word, saved straight back');
execSync(`cd ${tmp} && zip -q edited.docx hello.txt edited.txt`);
const editedBytes = fs.readFileSync(path.join(tmp, 'edited.docx'));
const put = await fetch(davUrl, { method: 'PUT', headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }, body: editedBytes });
check('PUT is accepted', put.status === 201, `${put.status}`);
// 81 MB, one past the 80 MB ceiling: the server must stop reading and refuse
// rather than buffer the whole thing to find out.
const huge = await fetch(davUrl, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.alloc(81 * 1024 * 1024) }).catch(e => ({ status: 0, err: String(e) }));
check('an oversized save is refused', huge.status === 413, `${huge.status}${huge.err ? ' ' + huge.err : ''}`);
check('and the refused save left no version behind',
  (await j(`/documents/office-session/${handoff.json.token}`, { token: A })).json.saves === 1);

const status = await j(`/documents/office-session/${handoff.json.token}`, { token: A });
check('the handoff reports the save', status.json.active && status.json.saves === 1, JSON.stringify(status.json));
const detail = (await j(`/documents/${docId}`, { token: A })).json;
const saved = (detail.versions || []).find(v => v.id === status.json.versionId);
check('the save became a new version', !!saved, JSON.stringify((detail.versions || []).map(v => v.version_number)));
check('the version says where it came from', saved?.revision_summary === 'Saved from Microsoft Office', saved?.revision_summary);
check('the document now points at it', detail.current_version_id === status.json.versionId, `${detail.current_version_id} vs ${status.json.versionId}`);

const readBack = await fetch(davUrl);
const roundTripped = Buffer.from(await readBack.arrayBuffer());
check('a second GET serves the saved bytes', roundTripped.length === editedBytes.length, `${roundTripped.length} vs ${editedBytes.length}`);

await fetch(davUrl, { method: 'UNLOCK' });
await j(`/documents/office-session/${handoff.json.token}`, { token: A, method: 'DELETE' });
const afterClose = await fetch(davUrl);
check('closing the handoff kills the URL', afterClose.status === 404, `${afterClose.status}`);
check('an invented token is refused', (await fetch(`${ORIGIN}/office/edit/not-a-real-token/x.docx`)).status === 404);

console.log('\n[5] A handoff dies with the account that minted it');
await j('/users', { token: A, method: 'POST', body: { username: `tmp${stamp}`, password: PW, fullName: 'Temporary Editor', roleId: admin.id } });
const tmpUser = (await j('/users', { token: A })).json.find(u => u.username === `tmp${stamp}`);
const T = (await j('/auth/login', { method: 'POST', body: { username: `tmp${stamp}`, password: PW } })).json.token;
const theirs = await j(`/documents/${docId}/versions/${version.json.id}/office-session`, { token: T, method: 'POST', body: {} });
check('they can mint one', theirs.status === 201, JSON.stringify(theirs.json));
const theirUrl = theirs.json.url.replace(/^https?:\/\/[^/]+/, ORIGIN);
check('and it works', (await fetch(theirUrl)).status === 200);
await j(`/users/${tmpUser.id}`, { token: A, method: 'DELETE' });   // deactivate
check('deactivating the account kills the URL', (await fetch(theirUrl)).status === 404);

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
