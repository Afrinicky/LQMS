/**
 * The bin card, and the two things a store gets wrong on paper.
 *
 *   node scripts/bin-card-check.mjs
 *
 * A bin card is the tally card that hangs on the shelf, and three things make
 * it worth hanging there: it carries the date the stock actually moved, it can
 * be taken off the system as a printed card or a spreadsheet without being
 * retyped, and a voucher entered wrongly can be put right rather than left
 * standing. Each is checked here end to end.
 */
const BASE = process.env.API || 'http://127.0.0.1:4440/api';
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
  const t = await r.text();
  let json = null; try { json = JSON.parse(t); } catch { json = t; }
  return { status: r.status, json, text: t, headers: r.headers };
};
const raw = async (p, token) => {
  const r = await fetch(`${BASE}${p}`, { headers: token ? { Authorization: `Bearer ${token}` } : undefined });
  return { status: r.status, type: r.headers.get('content-type') ?? '', length: Number(r.headers.get('content-length') ?? 0), body: await r.arrayBuffer() };
};

if (!(await j('/setup/status')).json?.setupComplete) {
  await j('/setup/initialize', { method: 'POST', body: { facilityName: 'Bin Card Lab', username: 'admin', password: PW, fullName: 'Admin User' } });
}
const A = (await j('/auth/login', { method: 'POST', body: { username: 'admin', password: PW } })).json.token;
const stamp = Date.now();
const today = new Date().toISOString().slice(0, 10);
const daysAgo = n => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);

console.log('\n[0] An item with stock on the shelf');
const item = (await j('/supplier-inventory/items', { token: A, method: 'POST',
  body: { name: `Test Reagent ${stamp}`, category: 'Reagent', unit: 'vials', minimumStock: 5, reorderLevel: 10 } })).json;
check('the item is registered', !!item?.id, JSON.stringify(item));
const batch = await j(`/supplier-inventory/items/${item.id}/batches`, { token: A, method: 'POST',
  body: { batchNumber: `B${stamp}`, quantityReceived: 100, dateReceived: daysAgo(10), expiryDate: "2030-01-01", acceptanceStatus: "accepted" } });
check('a delivery is booked in', batch.status === 201 || batch.status === 200, `status ${batch.status} ${JSON.stringify(batch.json)}`);

console.log('\n[1] Stock goes out on the day it actually went out');
const backdated = daysAgo(3);
const issue = await j('/supplier-inventory/issues', { token: A, method: 'POST',
  body: { issueDate: backdated, destination: 'other', destinationName: 'Outreach team', issuedToName: 'M. Mensah',
    lines: [{ itemId: item.id, quantity: 4 }] } });
check('the voucher is written', issue.status === 201, `status ${issue.status} ${JSON.stringify(issue.json)}`);
check('and carries the date it was issued on', issue.json?.issueDate === backdated, String(issue.json?.issueDate));

const future = await j('/supplier-inventory/issues', { token: A, method: 'POST',
  body: { issueDate: new Date(Date.now() + 864e5).toISOString().slice(0, 10), destination: 'other', destinationName: 'Outreach team',
    issuedToName: 'M. Mensah', lines: [{ itemId: item.id, quantity: 1 }] } });
check('a date in the future is refused', future.status === 400, `status ${future.status}`);

const card1 = (await j(`/supplier-inventory/ledger/${item.id}`, { token: A })).json;
const outLine = (card1?.lines ?? []).find(l => l.direction === 'out');
check('the movement lands on the card under that date', String(outLine?.movement_date ?? '').slice(0, 10) === backdated,
  JSON.stringify(outLine?.movement_date));

console.log('\n[2] A voucher entered wrongly is put right, not left standing');
const corrected = daysAgo(2);
const fix = await j(`/supplier-inventory/issues/${issue.json.id}`, { token: A, method: 'PUT',
  body: { issueDate: corrected, destination: 'other', destinationName: 'Outreach team', issuedToName: 'K. Owusu', note: 'Collector corrected' } });
check('the correction is accepted', fix.status === 200, `status ${fix.status} ${JSON.stringify(fix.json)}`);
const after = (await j(`/supplier-inventory/issues/${issue.json.id}`, { token: A })).json;
check('the voucher now reads the corrected date', String(after?.issue_date ?? '').slice(0, 10) === corrected, String(after?.issue_date));
check('and the corrected collector', after?.issued_to_name === 'K. Owusu', String(after?.issued_to_name));
const card2 = (await j(`/supplier-inventory/ledger/${item.id}`, { token: A })).json;
const outLine2 = (card2?.lines ?? []).find(l => l.direction === 'out');
check('the bin card follows the correction', String(outLine2?.movement_date ?? '').slice(0, 10) === corrected,
  JSON.stringify(outLine2?.movement_date));

const badDate = await j(`/supplier-inventory/issues/${issue.json.id}`, { token: A, method: 'PUT', body: { issueDate: 'not-a-date' } });
check('a date that is not a date is refused', badDate.status === 400, `status ${badDate.status}`);

console.log('\n[3] The card comes off the system as a card');
const printed = await raw(`/supplier-inventory/ledger/${item.id}/print?autoprint=0`, A);
const html = new TextDecoder().decode(printed.body);
check('the printed sheet is served', printed.status === 200 && printed.type.includes('text/html'), `status ${printed.status} ${printed.type}`);
for (const heading of ['Bin card', 'Item code', 'Unit of issue', 'Storage place', 'Reorder level', 'Balance']) {
  check(`it carries "${heading}"`, html.includes(heading));
}
for (const column of ['Reference', 'Batch / lot', 'Expiry', 'Received', 'Issued', 'Posted by']) {
  check(`the movement table has a "${column}" column`, html.includes(column));
}
check('it ends with somewhere to sign', html.includes('Storekeeper') && html.includes('Checked by'));
check('the movements are on it', html.includes(issue.json.issueNumber), issue.json.issueNumber);

console.log('\n[4] …and as a spreadsheet');
const xlsx = await raw(`/supplier-inventory/ledger/${item.id}/export`, A);
check('the workbook is served', xlsx.status === 200 && xlsx.type.includes('spreadsheetml'), `status ${xlsx.status} ${xlsx.type}`);
check('and is a real workbook', new TextDecoder().decode(xlsx.body.slice(0, 2)) === 'PK');

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
