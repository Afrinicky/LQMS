/**
 * Supply and inventory — the record you can actually go back to.
 *
 *   node scripts/inventory-records-check.mjs
 *
 * An expiry date belongs to the delivery, not to the product, so the register
 * has to derive it from the batches or it shows a blank column beside stock
 * that expires next week. A movement that cannot be looked up afterwards is
 * not a record. A supplier register that cannot be corrected or exported is a
 * list. And under GS1 the barcode on a box carries the product, the lot and
 * the expiry together — the level ISO 15189 §6.6.2 traceability runs at.
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
  await j('/setup/initialize', { method: 'POST', body: { facilityName: 'Records Lab', username: 'admin', password: PW, fullName: 'Admin User' } });
const A = (await j('/auth/login', { method: 'POST', body: { username: 'admin', password: PW } })).json.token;
const stamp = Date.now();
const day = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const GS = String.fromCharCode(29);

console.log('\n[1] The register shows the expiry that will actually be reached');
const item = await j('/supplier-inventory/items', { token: A, method: 'POST', body: {
  name: `Bioline HIV ${stamp}`, category: 'reagent', unit: 'kit', minimumStock: 2, reorderLevel: 4,
  manufacturer: 'Abbott', catalogueNumber: 'BL-HIV-30',
} });
check('an item is registered', item.status === 201, JSON.stringify(item.json));
const itemId = item.json.id;
let row = (await j('/supplier-inventory/items', { token: A })).json.find(i => i.id === itemId);
check('with no stock it has nothing to expire', !row.effective_expiry, String(row.effective_expiry));
check('and no stock on hand', row.stock_on_hand === 0, String(row.stock_on_hand));

const far = await j(`/supplier-inventory/items/${itemId}/batches`, { token: A, method: 'POST', body: {
  batchNumber: `FAR-${stamp}`, quantityReceived: 10, quantityAvailable: 10, dateReceived: day(-2), expiryDate: day(300) } });
const near = await j(`/supplier-inventory/items/${itemId}/batches`, { token: A, method: 'POST', body: {
  batchNumber: `NEAR-${stamp}`, quantityReceived: 4, quantityAvailable: 4, dateReceived: day(-1), expiryDate: day(20) } });
check('two deliveries are booked in', far.status === 201 && near.status === 201);
row = (await j('/supplier-inventory/items', { token: A })).json.find(i => i.id === itemId);
check('the register shows the earliest batch expiry', row.effective_expiry?.slice(0, 10) === day(20), String(row.effective_expiry));
check('and warns that it is close', row.expiry_status === 'expiring_soon', row.expiry_status);
check('stock on hand is the sum of the batches', row.stock_on_hand === 14, String(row.stock_on_hand));
check('so it is no longer flagged low', row.low_stock === false, String(row.low_stock));

console.log('\n[2] Opening an item shows the record, not a row of ids');
const detail = (await j(`/supplier-inventory/items/${itemId}`, { token: A })).json;
check('the manufacturer and catalogue number are there', detail.manufacturer === 'Abbott' && detail.catalogue_number === 'BL-HIV-30');
check('the batches are listed with their expiry status', detail.batches.length === 2 && detail.batches[0].expiry_status);
check('the earliest-expiring batch comes first', detail.batches[0].batch_number === `NEAR-${stamp}`, detail.batches[0].batch_number);
check('who registered it is named, not numbered', detail.created_by_name === 'Admin User', detail.created_by_name);

console.log('\n[3] A movement can be traced back to');
await j(`/supplier-inventory/batches/${near.json.id}/acceptance`, { token: A, method: 'POST', body: { acceptanceStatus: 'accepted' } });
const sections = (await j('/sections', { token: A })).json ?? [];
const move = await j(`/supplier-inventory/batches/${near.json.id}/movement`, { token: A, method: 'POST', body: {
  movementType: 'issue', quantity: 2, reason: 'Morning run', issuedToSectionId: sections[0]?.id ?? null } });
check('the issue is recorded', move.status === 200 || move.status === 201, JSON.stringify(move.json));
const movements = (await j('/supplier-inventory/movements', { token: A })).json;
check('and appears in the movement register', Array.isArray(movements) && movements.length >= 1, JSON.stringify(movements)?.slice(0, 120));
const mine = movements.find(m => m.reason === 'Morning run');
check('naming the item it came from', mine?.item_name?.includes('Bioline HIV'), mine?.item_name);
check('and the batch it came out of', mine?.batch_number === `NEAR-${stamp}`, mine?.batch_number);
check('and who recorded it', mine?.recorded_by_name === 'Admin User', mine?.recorded_by_name);
if (sections[0]) check('and which unit it went to', mine?.issued_to_section_name === sections[0].name, mine?.issued_to_section_name);
check('the register can be filtered to one item',
  (await j(`/supplier-inventory/movements?itemId=${itemId}`, { token: A })).json.every(m => m.item_id === itemId));
const mx = await fetch(`${BASE}/supplier-inventory/movements/export`, { headers: { Authorization: `Bearer ${A}` } });
check('and exported', mx.ok && Number(mx.headers.get('content-length') || 3000) > 2000, String(mx.status));
const afterIssue = (await j(`/supplier-inventory/items/${itemId}`, { token: A })).json;
check('the item detail carries the movement too', afterIssue.movements.some(m => m.reason === 'Morning run'));

console.log('\n[4] A barcode on a box says product AND lot AND expiry');
const gtin = `0750123${String(stamp).slice(-6)}9`.padEnd(14, '0').slice(0, 14);
await j(`/supplier-inventory/items/${itemId}`, { token: A, method: 'PUT', body: { productBarcode: gtin, barcodeSource: 'product' } });
const scanItem = await j(`/supplier-inventory/scan/${encodeURIComponent(gtin)}`, { token: A });
check('scanning the product code finds the product', scanItem.json?.kind === 'item' && scanItem.json.id === itemId, JSON.stringify(scanItem.json));
// The same product with an EAN-13 printed under the GTIN-14.
const ean = gtin.replace(/^0+/, '');
check('a GTIN-14 and the EAN-13 beneath it are the same product',
  (await j(`/supplier-inventory/scan/${encodeURIComponent(ean)}`, { token: A })).json?.id === itemId);

// A full GS1 symbol: (01) product, (10) lot, (17) expiry.
const gs1 = `01${gtin}10NEAR-${stamp}${GS}17${day(20).slice(2).replace(/-/g, '')}`;
const scanGs1 = await j(`/supplier-inventory/scan/${encodeURIComponent(gs1)}`, { token: A });
check('a GS1 symbol resolves to the exact delivery', scanGs1.json?.kind === 'batch' && scanGs1.json.id === near.json.id, JSON.stringify(scanGs1.json));
check('and reports the lot it read off the box', scanGs1.json?.parsed?.lot === `NEAR-${stamp}`, JSON.stringify(scanGs1.json?.parsed));
check('and the expiry, so receiving need not retype it', scanGs1.json?.parsed?.expiry === day(20), scanGs1.json?.parsed?.expiry);

// A lot the laboratory has NOT received yet: the product is known, the lot is new.
const newLot = `01${gtin}10FRESH-${stamp}${GS}17${day(400).slice(2).replace(/-/g, '')}`;
const scanNew = await j(`/supplier-inventory/scan/${encodeURIComponent(newLot)}`, { token: A });
check('an unknown lot of a known product resolves to the product', scanNew.json?.kind === 'item' && scanNew.json.id === itemId, JSON.stringify(scanNew.json));
check('with the new lot and expiry handed back for the receipt', scanNew.json?.parsed?.lot === `FRESH-${stamp}` && scanNew.json?.parsed?.expiry === day(400), JSON.stringify(scanNew.json?.parsed));

const boxed = await j(`/supplier-inventory/items/${itemId}/batches`, { token: A, method: 'POST', body: {
  batchNumber: `BOX-${stamp}`, quantityReceived: 5, quantityAvailable: 5, dateReceived: day(0), expiryDate: day(120), productBarcode: `BATCHBC-${stamp}` } });
check('a delivery can carry its own barcode', boxed.status === 201, JSON.stringify(boxed.json));
check('which resolves to that delivery',
  (await j(`/supplier-inventory/scan/BATCHBC-${stamp}`, { token: A })).json?.id === boxed.json.id);
check('and two deliveries cannot share one barcode',
  (await j(`/supplier-inventory/items/${itemId}/batches`, { token: A, method: 'POST', body: {
    batchNumber: 'CLASH', quantityReceived: 1, quantityAvailable: 1, dateReceived: day(0), productBarcode: `BATCHBC-${stamp}` } })).status === 400);

console.log('\n[5] Removing an item keeps the traceability, unless it was a mistake');
const impact = (await j(`/supplier-inventory/items/${itemId}/deletion-impact`, { token: A })).json;
check('what removal would cost is stated up front', impact.batches === 3 && impact.movements >= 1, JSON.stringify(impact));
check('and withdrawing is what it recommends', impact.recommendation === 'withdraw' && impact.canDeleteOutright === false);
check('erasing without a reason is refused',
  (await j(`/supplier-inventory/items/${itemId}?mode=delete`, { token: A, method: 'DELETE', body: {} })).status === 400);
const blocked = await j(`/supplier-inventory/items/${itemId}?mode=delete`, { token: A, method: 'DELETE', body: { reason: 'entered by mistake in testing' } });
check('and erasing stock with history needs a second confirmation', blocked.status === 409 && blocked.json.needsForce, JSON.stringify(blocked.json));
check('withdrawing works and says so',
  (await j(`/supplier-inventory/items/${itemId}`, { token: A, method: 'DELETE', body: { reason: 'discontinued' } })).json?.mode === 'withdrawn');
row = (await j('/supplier-inventory/items', { token: A })).json.find(i => i.id === itemId);
check('the withdrawn item keeps its batches', row.is_active === 0 && row.batch_count === 3, `${row.is_active}/${row.batch_count}`);

const spare = await j('/supplier-inventory/items', { token: A, method: 'POST', body: { name: `Typo ${stamp}`, category: 'consumable', unit: 'box' } });
check('an item with no history erases outright',
  (await j(`/supplier-inventory/items/${spare.json.id}?mode=delete`, { token: A, method: 'DELETE', body: { reason: 'entered by mistake' } })).json?.mode === 'deleted');

console.log('\n[6] Suppliers are a register that can be kept');
const sup = await j('/supplier-inventory/suppliers', { token: A, method: 'POST', body: {
  name: `Acme Diagnostics ${stamp}`, contactPerson: 'A. Buyer', phone: '024', email: 'a@example.test',
  itemCategory: 'Reagents', evaluationRequired: true, nextEvaluationDue: day(-5) } });
check('a supplier is registered', sup.status === 201, JSON.stringify(sup.json));
let sups = (await j('/supplier-inventory/suppliers', { token: A })).json;
let mineS = sups.find(x => x.id === sup.json.id);
check('one never evaluated is shown as such', mineS.evaluation_status === 'never_evaluated', mineS.evaluation_status);
await j(`/supplier-inventory/suppliers/${sup.json.id}/evaluation`, { token: A, method: 'POST', body: {
  evaluationDate: day(-30), rating: 'satisfactory', findings: 'Deliveries on time', nextEvaluationDate: day(-2) } });
sups = (await j('/supplier-inventory/suppliers', { token: A })).json;
mineS = sups.find(x => x.id === sup.json.id);
check('an evaluation past its next-due date reads overdue', mineS.evaluation_status === 'overdue', mineS.evaluation_status);
check('and the last rating is on the register row', mineS.last_rating === 'satisfactory', mineS.last_rating);
const evals = (await j('/supplier-inventory/supplier-evaluations', { token: A })).json;
check('every evaluation is listed in one place', evals.some(e => e.supplier_id === sup.json.id && e.supplier_name?.includes('Acme')), JSON.stringify(evals?.[0])?.slice(0, 120));
check('the supplier can be corrected',
  (await j(`/supplier-inventory/suppliers/${sup.json.id}`, { token: A, method: 'PUT', body: { contactPerson: 'B. Buyer' } })).status === 200);
check('and the correction sticks',
  (await j('/supplier-inventory/suppliers', { token: A })).json.find(x => x.id === sup.json.id).contact_person === 'B. Buyer');

const sx = await fetch(`${BASE}/supplier-inventory/suppliers/export`, { headers: { Authorization: `Bearer ${A}` } });
check('the supplier register exports', sx.ok, String(sx.status));
const XLSX = await import('xlsx');
const wb = XLSX.read(Buffer.from(await sx.arrayBuffer()), { type: 'buffer' });
const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
check('carrying the laboratory\'s own suppliers', rows.some(r => String(r.Name).includes('Acme Diagnostics')), `${rows.length} rows`);
const edited = rows.find(r => String(r.Name).includes('Acme Diagnostics'));
edited.Phone = '0555000111';
rows.push({ 'Supplier code': '', Name: `Imported Supplies ${stamp}`, 'Contact person': 'C. Rep', Phone: '030', Email: '', Address: '', Supplies: 'Consumables', Status: 'active', 'Evaluation required': 'Yes', 'Last evaluated': '', 'Next evaluation due': '' });
const headers = Object.keys(rows[0]);
const out = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(out, XLSX.utils.aoa_to_sheet([headers, ...rows.map(r => headers.map(k => r[k] ?? ''))]), 'SUPPLIERS');
const fd = new FormData();
fd.append('file', new Blob([XLSX.write(out, { type: 'buffer', bookType: 'xlsx' })]), 'suppliers.xlsx');
const imp = await fetch(`${BASE}/supplier-inventory/suppliers/import`, { method: 'POST', headers: { Authorization: `Bearer ${A}` }, body: fd });
const impJson = await imp.json().catch(() => null);
check('the edited file imports', imp.ok && impJson.created >= 1 && impJson.updated >= 1, JSON.stringify(impJson));
sups = (await j('/supplier-inventory/suppliers', { token: A })).json;
check('the edit landed', sups.find(x => x.id === sup.json.id).phone === '0555000111');
check('and the new supplier exists exactly once', sups.filter(x => x.name === `Imported Supplies ${stamp}`).length === 1);

console.log('\n[7] Removing a supplier never orphans the stock they supplied');
const si = (await j(`/supplier-inventory/suppliers/${sup.json.id}/deletion-impact`, { token: A })).json;
check('the impact names the evaluations behind them', si.evaluations >= 1 && si.recommendation === 'suspend', JSON.stringify(si));
const supBlocked = await j(`/supplier-inventory/suppliers/${sup.json.id}?mode=delete`, { token: A, method: 'DELETE', body: { reason: 'duplicate record' } });
check('erasing one with history needs confirming', supBlocked.status === 409 && supBlocked.json.needsForce, JSON.stringify(supBlocked.json));
check('suspending works',
  (await j(`/supplier-inventory/suppliers/${sup.json.id}`, { token: A, method: 'DELETE', body: { reason: 'contract ended' } })).json?.mode === 'suspended');
check('and the suspended supplier is still on the register',
  (await j('/supplier-inventory/suppliers', { token: A })).json.find(x => x.id === sup.json.id).status === 'suspended');

// A supplier who actually supplies something, force-erased: the stock survives.
const sup2 = await j('/supplier-inventory/suppliers', { token: A, method: 'POST', body: { name: `Wrong Entry ${stamp}` } });
const supplied = await j('/supplier-inventory/items', { token: A, method: 'POST', body: {
  name: `Supplied item ${stamp}`, category: 'consumable', unit: 'box', supplierId: sup2.json.id } });
const forced = await j(`/supplier-inventory/suppliers/${sup2.json.id}?mode=delete&force=1`, { token: A, method: 'DELETE', body: { reason: 'entered twice by mistake' } });
check('a force-erase reports what it detached', forced.json?.detached?.items === 1, JSON.stringify(forced.json));
const survivor = (await j('/supplier-inventory/items', { token: A })).json.find(i => i.id === supplied.json.id);
check('and the item they supplied is still there', !!survivor && !survivor.supplier_id, JSON.stringify(survivor?.supplier_id));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
