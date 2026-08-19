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
check('a departure with no stated reason is refused',
  (await j(`/staff/${real.id}`, { token: A, method: 'DELETE', body: {} })).status === 400);
const retired = await j(`/staff/${real.id}`, { token: A, method: 'DELETE', body: { exitReason: 'Transfer to another facility', exitDate: '2026-08-01', notes: 'Moved to Regional Hospital' } });
check('recording the departure succeeds', retired.status === 200 && retired.json.mode === 'deactivate', JSON.stringify(retired.json));
check('the record is kept, not gone', (await j('/staff?status=all', { token: A })).json.some(s => s.id === real.id));
{
  const gone = (await j('/staff?status=retired', { token: A })).json.find(s => s.id === real.id);
  check('the reason is on the record', gone?.exitReason === 'Transfer to another facility', JSON.stringify(gone?.exitReason));
  check('so is the date', gone?.exitDate === '2026-08-01', JSON.stringify(gone?.exitDate));
  check('and the note', gone?.exitNotes === 'Moved to Regional Hospital');
}

console.log('\n[2b] A retired person leaves the register, the export and the import');
const activeNow = (await j('/staff', { token: A })).json;
check('the retired record is gone from the register', !activeNow.some(s => s.id === real.id));
const retiredList = (await j('/staff?status=retired', { token: A })).json;
check('and is in the retired list instead', retiredList.some(s => s.id === real.id));
check('?status=all still sees both', (await j('/staff?status=all', { token: A })).json.some(s => s.id === real.id));
{
  const XLSXmod = await import('xlsx');
  const res = await fetch(`${BASE}/staff/export`, { headers: { Authorization: `Bearer ${A}` } });
  const wb = XLSXmod.read(Buffer.from(await res.arrayBuffer()), { type: 'buffer' });
  const sheet = XLSXmod.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '', raw: false });
  const ids = sheet.map(r => String(Object.values(r)[0] ?? '')).concat(sheet.map(r => JSON.stringify(r)));
  check('the export omits the departed record', !ids.some(v => v.includes(`REAL-${stamp}`)), `REAL-${stamp}`);
}
{
  const XLSXmod = await import('xlsx');
  const res = await fetch(`${BASE}/staff/export?status=former`, { headers: { Authorization: `Bearer ${A}` } });
  check('the former-staff list has its own export', res.ok, String(res.status));
  const wb = XLSXmod.read(Buffer.from(await res.arrayBuffer()), { type: 'buffer' });
  check('on its own sheet', wb.SheetNames[0] === 'FORMER PERSONNEL', wb.SheetNames[0]);
  const rows = XLSXmod.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '', raw: false });
  const mine = rows.find(r => JSON.stringify(r).includes(`REAL-${stamp}`));
  check('it carries the departed person', !!mine);
  check('with the reason and date', JSON.stringify(mine).includes('Transfer to another facility') && JSON.stringify(mine).includes('2026-08-01'),
    JSON.stringify(mine).slice(0, 200));
}
// An import row naming a retired Staff ID is refused rather than silently applied.
{
  const XLSXmod = await import('xlsx');
  const aoa = [['STAFF ID', 'SURNAME', 'FIRSTNAME(S)'], [`REAL-${stamp}`, 'Ghost', 'Edit']];
  const wb = XLSXmod.utils.book_new();
  XLSXmod.utils.book_append_sheet(wb, XLSXmod.utils.aoa_to_sheet(aoa), 'MASTER PERSONNEL REGISTER');
  const buf = XLSXmod.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const fd = new FormData();
  fd.append('file', new Blob([buf]), 'retired.xlsx');
  const r = await fetch(`${BASE}/staff/import`, { method: 'POST', headers: { Authorization: `Bearer ${A}` }, body: fd });
  const out = await r.json();
  check('an import row for a retired person is skipped', out.skipped === 1 && out.updated === 0, JSON.stringify(out));
  check('and it says why', (out.errors[0] || '').includes('retired'), JSON.stringify(out.errors));
}
const restored = await j(`/staff/${real.id}/reactivate`, { token: A, method: 'POST', body: {} });
check('restoring brings them back into the register', restored.status === 200
  && (await j('/staff', { token: A })).json.some(s => s.id === real.id));
check('and clears the departure', !(await j('/staff', { token: A })).json.find(s => s.id === real.id)?.exitReason);

console.log('\n[2c] A demonstration record the live system grew around can be force-erased');
await j('/staff', { token: A, method: 'POST', body: { firstName: 'Demo', surname: `Legacy${stamp}`, employeeNo: `LEG-${stamp}` } });
const legacy = (await j('/staff', { token: A })).json.find(s => s.employeeNo === `LEG-${stamp}`);
await j('/actions', { token: A, method: 'POST', body: { title: 'Demo-era action', moduleKey: 'personnel', assignedToStaffId: legacy.id } });
const legacyAction = (await j('/actions', { token: A })).json.find(a => a.assigned_to_staff_id === legacy.id);
const legacyImpact = await j(`/staff/${legacy.id}/deletion-impact`, { token: A });
check('an ordinary erase is still refused', legacyImpact.json.canDelete === false);
check('but a force erase is offered', legacyImpact.json.canForceDelete === true, JSON.stringify(legacyImpact.json));
check('a force erase without a reason is refused',
  (await j(`/staff/${legacy.id}?mode=purge`, { token: A, method: 'DELETE', body: { reason: 'demo' } })).status === 400);
const purged = await j(`/staff/${legacy.id}?mode=purge`, { token: A, method: 'DELETE', body: { reason: 'Demonstration record created during setup, never a member of staff' } });
check('with one, it succeeds', purged.status === 200 && purged.json.mode === 'purge', JSON.stringify(purged.json));
check('the record is gone', !(await j('/staff?status=all', { token: A })).json.some(s => s.id === legacy.id));
const survivor = (await j('/actions', { token: A })).json.find(a => a.id === legacyAction.id);
check('the record it was named in survives', !!survivor, `action ${legacyAction.id}`);
check('and no longer names anybody', survivor && (survivor.assigned_to_staff_id === null || survivor.assigned_to_staff_id === undefined),
  JSON.stringify(survivor?.assigned_to_staff_id));
const purgeTrail = (await j('/permissions/matrix', { token: A })).json.auditHistory.find(a => a.action === 'purge' && a.entity === 'staff');
check('the audit trail records the purge and its reason',
  !!purgeTrail && (purgeTrail.new_value || '').includes('Demonstration record'), JSON.stringify(purgeTrail?.new_value || '').slice(0, 120));
check('and who was erased', (purgeTrail?.old_value || '').includes(`LEG-${stamp}`));

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

console.log('\n[3b] A demonstration login account can be force-erased too');
await j('/users', { token: A, method: 'POST', body: { username: `demo${stamp}`, password: PW, fullName: 'Demo Account', roleId: qm.id } });
const demoAcct = (await j('/users', { token: A })).json.find(u => u.username === `demo${stamp}`);
// Give it laboratory history of the kind that blocks an ordinary erase.
const demoNotif = await j('/notifications', { token: A, method: 'POST', body: { assignedToUserId: demoAcct.id, moduleKey: 'personnel', title: 'For the demo account', message: 'Assigned while the system was being set up', notificationType: 'task_assigned', severity: 'low' } });
check('the demo account has laboratory history', demoNotif.status === 201, JSON.stringify(demoNotif.json));
const acctImpact = await j(`/users/${demoAcct.id}/deletion-impact`, { token: A });
check('an ordinary erase is refused', acctImpact.json.canDelete === false, JSON.stringify(acctImpact.json.historicReferences));
check('but a force erase is offered', acctImpact.json.canForceDelete === true);
check('a force erase without a reason is refused',
  (await j(`/users/${demoAcct.id}?mode=purge`, { token: A, method: 'DELETE', body: { reason: 'demo' } })).status === 400);
// Something the account itself authored, so the audit trail can be checked after.
const trailBefore = (await j('/permissions/matrix', { token: A })).json.auditHistory.length;
const acctPurge = await j(`/users/${demoAcct.id}?mode=purge`, { token: A, method: 'DELETE', body: { reason: 'Demonstration login created while setting the system up' } });
check('with one, it succeeds', acctPurge.status === 200 && acctPurge.json.mode === 'purge', JSON.stringify(acctPurge.json));
check('the account is gone', !(await j('/users', { token: A })).json.some(u => u.id === demoAcct.id));
{
  const trail = (await j('/permissions/matrix', { token: A })).json.auditHistory;
  check('the audit trail did not shrink', trail.length >= trailBefore, `${trail.length} vs ${trailBefore}`);
  const rec = trail.find(a => a.action === 'purge' && a.entity === 'users');
  check('and it names the erased account and the reason',
    !!rec && (rec.old_value || '').includes(`demo${stamp}`) && (rec.new_value || '').includes('Demonstration login'),
    JSON.stringify(rec?.old_value || '').slice(0, 120));
}

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
