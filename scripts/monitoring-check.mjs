/**
 * Monitoring ranges are configurable, and a fresh entry is the writer's to fix.
 *
 *   node scripts/monitoring-check.mjs
 *   DB=/path/to/sech_lims.sqlite node scripts/monitoring-check.mjs   # full run
 *
 * Two things are proved.
 *
 * THE RANGES. What a fridge, an incubator or a room is monitored for, and the
 * range it must stay inside, was asked for once — when the asset was
 * registered — and never offered again. A revalidation, a corrected insert or
 * an asset that arrived set wrongly had nowhere to go. The ranges are now
 * editable, and a change reaches the asset's own band, the live dashboard and
 * the chart the bench is filling in this month.
 *
 * THE CORRECTION WINDOW. Somebody typing Monday's readings on Wednesday used
 * to produce an entry that was "closed" the instant it landed, so a mistyped
 * digit could not be fixed by the person who had just made it. What decides is
 * now the age of the ENTRY: for a day it is theirs to correct, after that it
 * takes a supervisor, a reason and an amendment trail.
 *
 * The checks that need an entry to be a day old age the row directly, so they
 * run only when DB points at the database the API is using.
 */
const BASE = process.env.API || 'http://127.0.0.1:4490/api';
const DB_PATH = process.env.DB || null;
const PW = 'Passw0rd!test';

let pass = 0, fail = 0, skipped = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};
const skip = name => { skipped++; console.log(`  SKIP  ${name} — set DB to run it`); };
const j = async (p, o = {}) => {
  const r = await fetch(`${BASE}${p}`, {
    method: o.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(o.token ? { Authorization: `Bearer ${o.token}` } : {}) },
    body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
  });
  const t = await r.text();
  let json = null; try { json = JSON.parse(t); } catch { json = t; }
  return { status: r.status, json };
};

/** Push an entry back in time, so the correction window has run out on it. */
async function ageEntry(sheetId, rowId, day, slot, hours) {
  if (!DB_PATH) return false;
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(DB_PATH);
  const when = new Date(Date.now() - hours * 3600_000).toISOString().replace('T', ' ').slice(0, 19);
  db.prepare(`UPDATE routine_log_cells SET first_recorded_at = ?, recorded_at = ?
      WHERE sheet_id = ? AND row_id = ? AND day = ? AND slot = ?`)
    .run(when, when, sheetId, rowId, day, slot);
  db.close();
  return true;
}

if (!(await j('/setup/status')).json?.setupComplete) {
  await j('/setup/initialize', { method: 'POST', body: { facilityName: 'Monitoring Lab', username: 'admin', password: PW, fullName: 'Admin User' } });
}
const A = (await j('/auth/login', { method: 'POST', body: { username: 'admin', password: PW } })).json.token;
const stamp = Date.now();
const today = new Date();
const month = today.toISOString().slice(0, 7);
const login = async u => (await j('/auth/login', { method: 'POST', body: { username: u, password: PW } })).json?.token;

console.log('\n[0] A unit, a fridge and somebody who reads it');
const dept = (await j('/departments', { token: A, method: 'POST', body: { name: `Dept ${stamp}` } })).json;
const unit = (await j('/section-config/sections', { token: A, method: 'POST', body: { name: `Haematology ${stamp}`, departmentId: dept?.id } })).json?.id
  ?? (await j('/sections', { token: A })).json?.find(x => x.name === `Haematology ${stamp}`)?.id;
check('the unit exists', !!unit);

const roles = (await j('/roles', { token: A })).json;
const roleId = n => roles.find(r => r.name === n)?.id;
const bench = (await j('/staff', { token: A, method: 'POST',
  body: { employeeNo: `BN-${stamp}`, firstName: 'Bella', surname: 'Bench', sectionId: unit } })).json;
await j('/users', { token: A, method: 'POST',
  body: { username: `bn${stamp}`, password: PW, fullName: 'Bella Bench', roleId: roleId('Technician'), staffId: bench.id } });
const B = await login(`bn${stamp}`);
check('a technician can sign in', !!B);

// Registered from the bench, which is the path a unit actually uses, and which
// opens this month's chart in the same call.
const asset = await j('/environmental/charts/assets', { token: A, method: 'POST', body: {
  name: `Reagent fridge ${stamp}`, assetType: 'refrigerator', sectionId: unit, month,
  monitoringFrequency: 'daily',
  parameters: [{ label: 'Temperature', unit: '°C', minValue: 2, maxValue: 8, decimalPlaces: 1 }],
} });
check('the fridge is registered with a range', asset.status === 201, `status ${asset.status} ${JSON.stringify(asset.json)}`);
const assetId = asset.json?.id;
const sheetId = asset.json?.sheetId;
check('and this month\'s chart is open', !!sheetId, JSON.stringify(asset.json));

console.log('\n[1] The range can be changed after registration');
const before = ((await j('/environmental/assets', { token: A })).json ?? []).find(a => Number(a.id) === Number(assetId));
check('the asset carries the range it was registered with',
  Number(before?.temp_min) === 2 && Number(before?.temp_max) === 8,
  JSON.stringify({ min: before?.temp_min, max: before?.temp_max }));

const changed = await j(`/environmental/assets/${assetId}/parameters`, { token: A, method: 'PUT', body: {
  parameters: [
    { parameter: 'temperature', label: 'Temperature', unit: '°C', minValue: 2, maxValue: 6, decimalPlaces: 1 },
    { label: 'Humidity', unit: '%', minValue: 30, maxValue: 60, decimalPlaces: 0 },
  ],
} });
check('the ranges save', changed.status === 200, `status ${changed.status} ${JSON.stringify(changed.json)}`);
check('a parameter can be added at the same time',
  (changed.json ?? []).some(p => p.parameter === 'humidity' && Number(p.max_value) === 60),
  JSON.stringify((changed.json ?? []).map(p => p.parameter)));

const after = ((await j('/environmental/assets', { token: A })).json ?? []).find(a => Number(a.id) === Number(assetId));
check('the asset\'s own band follows the temperature parameter',
  Number(after?.temp_min) === 2 && Number(after?.temp_max) === 6,
  JSON.stringify({ min: after?.temp_min, max: after?.temp_max }));
check('and its humidity band too',
  Number(after?.humidity_min) === 30 && Number(after?.humidity_max) === 60,
  JSON.stringify({ min: after?.humidity_min, max: after?.humidity_max }));

const sheet = (await j(`/routine-sheets/${sheetId}`, { token: A })).json;
const tempRow = (sheet?.rows ?? []).find(r => String(r.row_key).includes('temperature'));
check('this month\'s chart takes the new limits',
  Number(tempRow?.max_value) === 6, JSON.stringify({ min: tempRow?.min_value, max: tempRow?.max_value }));
check('and grows the row the new parameter needs',
  (sheet?.rows ?? []).some(r => String(r.row_key).includes('humidity')),
  JSON.stringify((sheet?.rows ?? []).map(r => r.row_key)));

console.log('\n[2] A range with no ends at all is refused');
const empty = await j(`/environmental/assets/${assetId}/parameters`, { token: A, method: 'PUT', body: {
  parameters: [{ parameter: 'temperature', label: 'Temperature', unit: '°C', minValue: '', maxValue: '' }],
} });
check('a parameter with neither limit is refused', empty.status === 400, `status ${empty.status}`);
const inverted = await j(`/environmental/assets/${assetId}/parameters`, { token: A, method: 'PUT', body: {
  parameters: [{ parameter: 'temperature', label: 'Temperature', unit: '°C', minValue: 8, maxValue: 2 }],
} });
check('a range that runs backwards is refused', inverted.status === 400, `status ${inverted.status}`);

console.log('\n[3] A reading typed in for an earlier day can be corrected by the person who typed it');
const dayOfMonth = today.getDate();
const pastDay = Math.max(1, dayOfMonth - 3);
const mine = (await j(`/routine-sheets/${sheetId}`, { token: B })).json;
const row = (mine?.rows ?? []).find(r => String(r.row_key).includes('temperature'));
check('the technician can open the chart', !!row, JSON.stringify(mine?.error ?? Object.keys(mine ?? {})));

const slot = (row?.slots ?? ['once'])[0] ?? 'once';
const first = await j(`/routine-sheets/${sheetId}/cells`, { token: B, method: 'POST',
  body: { cells: [{ rowId: row.id, day: pastDay, slot, value: 4.4 }] } });
check('a reading is charted for an earlier day', first.status === 200 && first.json?.saved === 1,
  `status ${first.status} ${JSON.stringify(first.json?.refused ?? first.json)}`);

// The mistake: it should have been 5.4. Under the old calendar rule this was
// refused outright, because the day it belongs to had already ended.
const fix = await j(`/routine-sheets/${sheetId}/cells`, { token: B, method: 'POST',
  body: { cells: [{ rowId: row.id, day: pastDay, slot, value: 5.4 }] } });
check('and the person who typed it can put it right', fix.status === 200 && (fix.json?.refused ?? []).length === 0,
  JSON.stringify(fix.json?.refused));
const fixedCell = (fix.json?.cells ?? []).find(c => c.day === pastDay && c.slot === slot && c.row_id === row.id);
check('the corrected value is what the chart says', Number(fixedCell?.value_num) === 5.4, JSON.stringify(fixedCell?.value_num));
check('and it is not counted as an amendment', Number(fixedCell?.amendment_count ?? 0) === 0,
  JSON.stringify(fixedCell?.amendment_count));

console.log('\n[4] Once the entry has stood a day, it takes a supervisor');
if (await ageEntry(sheetId, row.id, pastDay, slot, 30)) {
  const late = await j(`/routine-sheets/${sheetId}/cells`, { token: B, method: 'POST',
    body: { cells: [{ rowId: row.id, day: pastDay, slot, value: 6.4 }] } });
  check('the technician is refused', (late.json?.refused ?? []).length === 1,
    JSON.stringify(late.json?.refused ?? late.json));
  const still = (await j(`/routine-sheets/${sheetId}`, { token: A })).json?.cells
    ?.find(c => c.day === pastDay && c.slot === slot && c.row_id === row.id);
  check('and the entry is untouched', Number(still?.value_num) === 5.4, JSON.stringify(still?.value_num));

  const noReason = await j(`/routine-sheets/${sheetId}/cells`, { token: A, method: 'POST',
    body: { cells: [{ rowId: row.id, day: pastDay, slot, value: 6.4 }] } });
  check('a supervisor without a reason is refused too', (noReason.json?.refused ?? []).length === 1,
    JSON.stringify(noReason.json?.refused));

  const amended = await j(`/routine-sheets/${sheetId}/cells`, { token: A, method: 'POST',
    body: { cells: [{ rowId: row.id, day: pastDay, slot, value: 6.4, amendReason: 'Transcribed from the wrong line of the logger printout.' }] } });
  check('with a reason, the amendment is accepted', amended.json?.amended === 1, JSON.stringify(amended.json?.refused));
  const trail = (await j(`/routine-sheets/${sheetId}/amendments`, { token: A })).json ?? [];
  check('and the original stays legible in the trail',
    trail.some(t => Number(t.old_value_num) === 5.4 && Number(t.new_value_num) === 6.4), `${trail.length} entries`);

  // A correction must not hand out another day in which to correct it again.
  const again = await j(`/routine-sheets/${sheetId}/cells`, { token: B, method: 'POST',
    body: { cells: [{ rowId: row.id, day: pastDay, slot, value: 7.4 }] } });
  check('amending does not reopen the window for the bench', (again.json?.refused ?? []).length === 1,
    JSON.stringify(again.json?.refused));
} else {
  skip('the technician is refused once the entry has stood a day');
  skip('a supervisor with a reason may amend it');
  skip('amending does not reopen the window');
}

console.log('\n[5] A blank day is always fillable — there is nothing to amend');
const blankDay = Math.max(1, dayOfMonth - 5);
const blank = await j(`/routine-sheets/${sheetId}/cells`, { token: B, method: 'POST',
  body: { cells: [{ rowId: row.id, day: blankDay, slot, value: 3.9 }] } });
check('catching up on a day never charted is ordinary work',
  blank.status === 200 && blank.json?.saved === 1, JSON.stringify(blank.json?.refused));

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ''}`);
process.exit(fail === 0 ? 0 : 1);
