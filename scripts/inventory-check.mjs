/**
 * Supply and inventory control — storage, barcodes, the register, and the
 * rules that stop bad stock reaching a patient sample.
 *
 *   node scripts/inventory-check.mjs
 *
 * Three things are proved here. Stock can say where it is, because the
 * laboratory's own stores and shelves are configurable. An item answers to
 * whichever barcode it actually carries — the one printed on the box, or the
 * one SECH_LIMS generated. And the ISO 15189 §6.6 controls hold: a delivery
 * is quarantined until inspected, a rejected or expired batch cannot be
 * issued, and stock leaves oldest-expiry-first unless somebody deliberately
 * says otherwise.
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
  await j('/setup/initialize', { method: 'POST', body: { facilityName: 'Stock Lab', username: 'admin', password: PW, fullName: 'Admin User' } });
const A = (await j('/auth/login', { method: 'POST', body: { username: 'admin', password: PW } })).json.token;
const stamp = Date.now();
const day = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

console.log('\n[1] The laboratory names its own stores, shelves and fridges');
let places = (await j('/supplier-inventory/storage-locations', { token: A })).json;
check('somewhere to put stock exists out of the box', Array.isArray(places) && places.length > 0, JSON.stringify(places));
const store = await j('/supplier-inventory/storage-locations', { token: A, method: 'POST', body: { name: `Chemistry Store ${stamp}`, kind: 'store' } });
check('a store can be added', store.status === 201, JSON.stringify(store.json));
const shelf = await j('/supplier-inventory/storage-locations', { token: A, method: 'POST', body: { name: 'Shelf B3', kind: 'shelf', parentId: store.json.id } });
check('and a shelf inside it', shelf.status === 201, JSON.stringify(shelf.json));
const fridge = await j('/supplier-inventory/storage-locations', { token: A, method: 'POST', body: { name: 'Reagent fridge', kind: 'refrigerator', parentId: store.json.id, tempMin: 2, tempMax: 8 } });
check('a cold place carries the range it must hold', fridge.status === 201, JSON.stringify(fridge.json));
places = (await j('/supplier-inventory/storage-locations', { token: A })).json;
const shelfRow = places.find(p => p.id === shelf.json.id);
check('a shelf says which store it is in', shelfRow?.path === `Chemistry Store ${stamp} › Shelf B3`, shelfRow?.path);
check('a place cannot be its own parent',
  (await j(`/supplier-inventory/storage-locations/${store.json.id}`, { token: A, method: 'PUT', body: { name: 'x', kind: 'store', parentId: store.json.id } })).status === 400);
check('a store holding shelves cannot simply be deleted',
  (await j(`/supplier-inventory/storage-locations/${store.json.id}`, { token: A, method: 'DELETE' })).status === 400);

console.log('\n[2] Item categories and units come from Settings');
const cats = (await j('/config/option-lists/inventory_category', { token: A })).json;
check('stock categories are configurable', Array.isArray(cats) && cats.some(c => c.value === 'reagent'), JSON.stringify(cats?.slice(0, 3)));
const units = (await j('/config/option-lists/inventory_unit', { token: A })).json;
check('units of measure are configurable', Array.isArray(units) && units.length > 0);
const own = await j('/config/option-lists/inventory_category', { token: A, method: 'POST', body: { value: `molecular_kit_${stamp}`, label: 'Molecular kit' } });
check("a laboratory can add its own category", own.status === 201 || own.status === 200, JSON.stringify(own.json));

console.log('\n[3] An item records where it is kept');
const item = await j('/supplier-inventory/items', { token: A, method: 'POST', body: {
  name: `Glucose reagent ${stamp}`, category: 'reagent', unit: 'kit', storageLocationId: fridge.json.id,
  manufacturer: 'Acme Diagnostics', catalogueNumber: 'GLU-500', minimumStock: 2, reorderLevel: 4,
} });
check('the item is created', item.status === 201, JSON.stringify(item.json));
let items = (await j('/supplier-inventory/items', { token: A })).json;
let row = items.find(i => i.id === item.json.id);
check('and the register says exactly where it sits', row?.storage_path === `Chemistry Store ${stamp} › Reagent fridge`, row?.storage_path);

console.log('\n[4] Whichever barcode the box actually carries');
const policy = (await j('/supplier-inventory/barcode-policy', { token: A })).json;
check('a barcode policy is readable', policy && ['system', 'product'].includes(policy.defaultSource), JSON.stringify(policy));
check('the item SECH_LIMS numbered answers to its own code', row?.barcode === row?.item_code, `${row?.barcode} / ${row?.item_code}`);
const noCode = await j('/supplier-inventory/items', { token: A, method: 'POST', body: {
  name: `Bad barcode ${stamp}`, category: 'reagent', unit: 'kit', barcodeSource: 'product',
} });
check('an item set to use the box barcode must be given one', noCode.status === 400 && /barcode/i.test(noCode.json.error), JSON.stringify(noCode.json));
const boxed = await j('/supplier-inventory/items', { token: A, method: 'POST', body: {
  name: `Cuvettes ${stamp}`, category: 'consumable', unit: 'box', barcodeSource: 'product', productBarcode: `5901234${stamp % 100000}`,
} });
check('with the barcode it can be created', boxed.status === 201, JSON.stringify(boxed.json));
const clash = await j('/supplier-inventory/items', { token: A, method: 'POST', body: {
  name: `Cuvettes copy ${stamp}`, category: 'consumable', unit: 'box', barcodeSource: 'product', productBarcode: `5901234${stamp % 100000}`,
} });
check('two items cannot share one barcode', clash.status === 400 && /already belongs/i.test(clash.json.error), JSON.stringify(clash.json));
items = (await j('/supplier-inventory/items', { token: A })).json;
const boxRow = items.find(i => i.id === boxed.json.id);
check('the register shows the box barcode for that item', boxRow?.barcode === `5901234${stamp % 100000}`, boxRow?.barcode);
const scanProduct = await j(`/supplier-inventory/scan/5901234${stamp % 100000}`, { token: A });
check('scanning the box finds the item', scanProduct.status === 200 && scanProduct.json.id === boxed.json.id, JSON.stringify(scanProduct.json));
const scanSystem = await j(`/supplier-inventory/scan/${row.item_code}`, { token: A });
check('scanning a generated label finds its item too', scanSystem.status === 200 && scanSystem.json.id === item.json.id, JSON.stringify(scanSystem.json));
check('an unknown code says so plainly', (await j('/supplier-inventory/scan/NOTHING-HERE', { token: A })).status === 404);

console.log('\n[5] A delivery is quarantined until it has been inspected');
const older = await j(`/supplier-inventory/items/${item.json.id}/batches`, { token: A, method: 'POST', body: {
  batchNumber: `OLD-${stamp}`, quantityReceived: 10, quantityAvailable: 10, dateReceived: day(-10), expiryDate: day(30), storageLocationId: fridge.json.id,
} });
const newer = await j(`/supplier-inventory/items/${item.json.id}/batches`, { token: A, method: 'POST', body: {
  batchNumber: `NEW-${stamp}`, quantityReceived: 10, quantityAvailable: 10, dateReceived: day(-1), expiryDate: day(180), storageLocationId: fridge.json.id,
} });
check('two deliveries are booked in', older.status === 201 && newer.status === 201);
const batches = (await j('/supplier-inventory/batches', { token: A })).json;
const olderRow = batches.find(b => b.id === older.json.id);
check('a new delivery starts unaccepted', ['pending', 'quarantined'].includes(olderRow?.acceptance_status), olderRow?.acceptance_status);
const earlyIssue = await j(`/supplier-inventory/batches/${older.json.id}/movement`, { token: A, method: 'POST', body: { movementType: 'issue', quantity: 1 } });
check('it cannot be issued while in quarantine', earlyIssue.status === 400 && /quarantine/i.test(earlyIssue.json.error), JSON.stringify(earlyIssue.json));
const discardOk = await j(`/supplier-inventory/batches/${older.json.id}/movement`, { token: A, method: 'POST', body: { movementType: 'discard', quantity: 1 } });
check('but it can always be discarded', discardOk.status === 200 || discardOk.status === 201, JSON.stringify(discardOk.json));

console.log('\n[6] Rejected and expired stock cannot be put into use');
const rejected = await j(`/supplier-inventory/items/${item.json.id}/batches`, { token: A, method: 'POST', body: {
  batchNumber: `REJ-${stamp}`, quantityReceived: 5, quantityAvailable: 5, dateReceived: day(-2), expiryDate: day(90),
} });
await j(`/supplier-inventory/batches/${rejected.json.id}/acceptance`, { token: A, method: 'POST', body: { acceptanceStatus: 'rejected' } });
const rejIssue = await j(`/supplier-inventory/batches/${rejected.json.id}/movement`, { token: A, method: 'POST', body: { movementType: 'issue', quantity: 1 } });
check('a rejected delivery cannot be issued', rejIssue.status === 400 && /rejected/i.test(rejIssue.json.error), JSON.stringify(rejIssue.json));
const expired = await j(`/supplier-inventory/items/${item.json.id}/batches`, { token: A, method: 'POST', body: {
  batchNumber: `EXP-${stamp}`, quantityReceived: 5, quantityAvailable: 5, dateReceived: day(-200), expiryDate: day(-3),
} });
await j(`/supplier-inventory/batches/${expired.json.id}/acceptance`, { token: A, method: 'POST', body: { acceptanceStatus: 'accepted' } });
const expIssue = await j(`/supplier-inventory/batches/${expired.json.id}/movement`, { token: A, method: 'POST', body: { movementType: 'issue', quantity: 1 } });
check('an expired batch cannot be issued', expIssue.status === 400 && /expired/i.test(expIssue.json.error), JSON.stringify(expIssue.json));

console.log('\n[7] Stock leaves oldest-expiry-first');
await j(`/supplier-inventory/batches/${older.json.id}/acceptance`, { token: A, method: 'POST', body: { acceptanceStatus: 'accepted' } });
await j(`/supplier-inventory/batches/${newer.json.id}/acceptance`, { token: A, method: 'POST', body: { acceptanceStatus: 'accepted' } });
const skip = await j(`/supplier-inventory/batches/${newer.json.id}/movement`, { token: A, method: 'POST', body: { movementType: 'issue', quantity: 1 } });
check('opening the newer box is stopped', skip.status === 409, JSON.stringify(skip.json));
check('and the older one is named', skip.json?.fefo?.batchId === older.json.id, JSON.stringify(skip.json?.fefo));
const deliberate = await j(`/supplier-inventory/batches/${newer.json.id}/movement`, { token: A, method: 'POST', body: { movementType: 'issue', quantity: 1, reason: 'older box damaged', overrideFefo: true } });
check('but it can be done deliberately', deliberate.status === 200 || deliberate.status === 201, JSON.stringify(deliberate.json));
const detail = (await j(`/supplier-inventory/items/${item.json.id}`, { token: A })).json;
const skipped = detail.movements?.find(m => /FEFO skipped/i.test(m.reason || ''));
check('and the record says the rotation was skipped on purpose', !!skipped, JSON.stringify(detail.movements?.[0]));
const inOrder = await j(`/supplier-inventory/batches/${older.json.id}/movement`, { token: A, method: 'POST', body: { movementType: 'issue', quantity: 2 } });
check('issuing the oldest box passes without argument', inOrder.status === 200 || inOrder.status === 201, JSON.stringify(inOrder.json));

console.log('\n[8] The register goes out and comes back as a spreadsheet');
const xl = await fetch(`${BASE}/supplier-inventory/items/export`, { headers: { Authorization: `Bearer ${A}` } });
check('the register exports', xl.ok, String(xl.status));
const buf = Buffer.from(await xl.arrayBuffer());
check('as a real workbook, not a blank template', buf.length > 2000 && buf.subarray(0, 2).toString() === 'PK', `${buf.length} bytes`);
check('named for the register', /Stock_Item_Register/.test(xl.headers.get('content-disposition') || ''), xl.headers.get('content-disposition'));

const XLSX = await import('xlsx');
const wb = XLSX.read(buf, { type: 'buffer' });
const sheet = wb.Sheets[wb.SheetNames[0]];
const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
check('the exported rows are the laboratory\'s own', rows.some(r => String(r.Name || '').includes(`Glucose reagent ${stamp}`)), `${rows.length} rows`);
const exported = rows.find(r => String(r.Name || '').includes(`Glucose reagent ${stamp}`));
check('and each row says where the item is kept', String(exported['Storage location'] || '').includes('Reagent fridge'), exported && exported['Storage location']);

// Edit that same file and put it back: one row changed, one row new.
exported['Minimum stock'] = 9;
rows.push({ 'Item code': '', Name: `Imported swabs ${stamp}`, Category: 'consumable', Unit: 'pack',
  'Storage location': 'Shelf B3', Quantity: 25, 'Minimum stock': 5, 'Reorder level': 10, Status: 'available' });
const out = XLSX.utils.book_new();
const headers = Object.keys(rows[0]);
const aoa = [headers, ...rows.map(r => headers.map(k => r[k] ?? ''))];
XLSX.utils.book_append_sheet(out, XLSX.utils.aoa_to_sheet(aoa), 'STOCK');
const upload = XLSX.write(out, { type: 'buffer', bookType: 'xlsx' });

const fd = new FormData();
fd.append('file', new Blob([upload], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'register.xlsx');
const imp = await fetch(`${BASE}/supplier-inventory/items/import`, { method: 'POST', headers: { Authorization: `Bearer ${A}` }, body: fd });
const impJson = await imp.json().catch(() => null);
check('the edited file imports', imp.ok, JSON.stringify(impJson));
check('the new row was created', impJson?.created >= 1, JSON.stringify(impJson));
check('the edited row was updated, not duplicated', impJson?.updated >= 1, JSON.stringify(impJson));
items = (await j('/supplier-inventory/items', { token: A })).json;
row = items.find(i => i.id === item.json.id);
check('the change actually landed', Number(row.minimum_stock) === 9, String(row.minimum_stock));
const swabs = items.filter(i => i.name === `Imported swabs ${stamp}`);
check('the new item exists exactly once', swabs.length === 1, String(swabs.length));
check('and the storage place named in the file was matched', swabs[0]?.storage_path?.includes('Shelf B3'), swabs[0]?.storage_path);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
