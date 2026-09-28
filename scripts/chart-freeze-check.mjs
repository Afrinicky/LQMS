/**
 * A chart that stops accepting readings mid-month.
 *
 *   node scripts/chart-freeze-check.mjs
 *   DB=/path/to/sech_lims.sqlite node scripts/chart-freeze-check.mjs
 *
 * The fault: verifying a sheet locks it, nothing unlocked it, and the screen
 * offered the signature the whole month through. A supervisor signing on the
 * 22nd left days 23 to 30 unrecordable for good, and the bench watched a chart
 * frozen at whatever it said that morning.
 *
 * Two rules settle it, and both are checked here. A month cannot be signed
 * until it has ended — the signature covers days that have not happened, which
 * is what made it wrong rather than merely early. And a sheet that was signed
 * early can be put back into use by the same person who could sign it, which
 * is how the charts already frozen are recovered. A month that has genuinely
 * ended stays final once signed, which is the whole point of signing it.
 *
 * The recovery needs a sheet already in the broken state, which only the old
 * code could produce, so it is written directly; that check runs when DB
 * points at the database the API is using.
 */
const BASE = process.env.API || 'http://127.0.0.1:4500/api';
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

/** Put a sheet into the state the old code left behind: signed, mid-month. */
async function freeze(sheetId) {
  if (!DB_PATH) return false;
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(DB_PATH);
  db.prepare(`UPDATE routine_log_sheets SET status = 'verified', verified_at = CURRENT_TIMESTAMP
      WHERE id = ?`).run(sheetId);
  db.close();
  return true;
}

if (!(await j('/setup/status')).json?.setupComplete) {
  await j('/setup/initialize', { method: 'POST', body: { facilityName: 'Chart Freeze Lab', username: 'admin', password: PW, fullName: 'Admin User' } });
}
const A = (await j('/auth/login', { method: 'POST', body: { username: 'admin', password: PW } })).json.token;
const stamp = Date.now();
const now = new Date();
const month = now.toISOString().slice(0, 7);
const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString().slice(0, 7);
const today = now.getDate();

console.log('\n[0] A fridge with this month\'s chart open');
const dept = (await j('/departments', { token: A, method: 'POST', body: { name: `Dept ${stamp}` } })).json;
const unit = (await j('/section-config/sections', { token: A, method: 'POST', body: { name: `Blood Bank ${stamp}`, departmentId: dept?.id } })).json?.id
  ?? (await j('/sections', { token: A })).json?.find(x => x.name === `Blood Bank ${stamp}`)?.id;
// The supervisor who signs the month off: a staff record in the unit, an
// account that may verify, and a signature on file — nothing may be signed
// without one.
const roles = (await j('/roles', { token: A })).json;
const sup = (await j('/staff', { token: A, method: 'POST',
  body: { employeeNo: `SUP-${stamp}`, firstName: 'Felix', surname: 'Gadzeto', sectionId: unit } })).json;
await j('/users', { token: A, method: 'POST', body: {
  username: `sup${stamp}`, password: PW, fullName: 'Felix Gadzeto',
  roleId: roles.find(r => r.name === 'Unit Supervisor')?.id, staffId: sup.id,
} });
const S = (await j('/auth/login', { method: 'POST', body: { username: `sup${stamp}`, password: PW } })).json?.token;
{
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const fd = new FormData();
  fd.append('file', new Blob([png], { type: 'image/png' }), 'signature.png');
  await fetch(`${BASE}/signatures/me`, { method: 'POST', headers: { Authorization: `Bearer ${S}` }, body: fd });
}
check('the supervisor has a signature on file',
  (await j('/signatures/me', { token: S })).json?.hasSignature === true);

const asset = await j('/environmental/charts/assets', { token: A, method: 'POST', body: {
  name: `Consumable storage fridge ${stamp}`, assetType: 'refrigerator', sectionId: unit, month,
  monitoringFrequency: 'daily',
  parameters: [{ label: 'Temperature', unit: '°C', minValue: 12, maxValue: 22, decimalPlaces: 1 }],
} });
check('the chart is open', asset.status === 201, `status ${asset.status} ${JSON.stringify(asset.json)}`);
const sheetId = asset.json?.sheetId;
const sheet = (await j(`/routine-sheets/${sheetId}`, { token: A })).json;
const row = (sheet?.rows ?? []).find(r => String(r.row_key).includes('temperature'));
const slot = (row?.slots ?? ['once'])[0] ?? 'once';
check('and has a temperature row to chart on', !!row, JSON.stringify((sheet?.rows ?? []).map(r => r.row_key)));

console.log('\n[1] A month still running cannot be signed off');
const early = await j(`/routine-sheets/${sheetId}/verify`, { token: A, method: 'POST', body: { acknowledgeGaps: true } });
check('the signature is refused', early.status === 400, `status ${early.status}`);
check('and says why', /has not ended yet/.test(early.json?.error ?? ''), JSON.stringify(early.json?.error));
check('the sheet is still open', (await j(`/routine-sheets/${sheetId}`, { token: A })).json?.sheet?.status === 'open');
check('and the screen is not offered the signature either',
  (await j(`/routine-sheets/${sheetId}`, { token: A })).json?.permissions?.canVerify === false);

console.log('\n[2] So the chart keeps accepting readings all month');
const charted = await j(`/routine-sheets/${sheetId}/cells`, { token: A, method: 'POST',
  body: { cells: [{ rowId: row.id, day: today, slot, value: 18.2 }] } });
check('today\'s reading records', charted.json?.saved === 1, JSON.stringify(charted.json?.refused));

console.log('\n[3] A chart already frozen by the old rule can be put back into use');
if (await freeze(sheetId)) {
  const frozen = (await j(`/routine-sheets/${sheetId}`, { token: A })).json;
  check('it reads as signed and shut', frozen?.sheet?.locked === true, JSON.stringify(frozen?.sheet?.status));
  check('nothing can be charted on it', frozen?.permissions?.canRecord === false);
  const refused = await j(`/routine-sheets/${sheetId}/cells`, { token: A, method: 'POST',
    body: { cells: [{ rowId: row.id, day: Math.max(1, today - 1), slot, value: 17.1 }] } });
  check('and the server refuses the reading', refused.status === 400, `status ${refused.status}`);

  check('the supervisor is offered the way out', frozen?.permissions?.canReopen === true);
  const reopened = await j(`/routine-sheets/${sheetId}/reopen`, { token: A, method: 'POST', body: {} });
  check('putting it back into use works', reopened.status === 200, `status ${reopened.status} ${JSON.stringify(reopened.json?.error)}`);
  const back = (await j(`/routine-sheets/${sheetId}`, { token: A })).json;
  check('the sheet is open again', back?.sheet?.status === 'open', JSON.stringify(back?.sheet?.status));
  check('the premature signature is withdrawn with it', !back?.sheet?.verified_at, JSON.stringify(back?.sheet?.verified_at));
  check('and the readings already on it are untouched',
    (back?.cells ?? []).some(c => Number(c.value_num) === 18.2), `${(back?.cells ?? []).length} cells`);

  const resumed = await j(`/routine-sheets/${sheetId}/cells`, { token: A, method: 'POST',
    body: { cells: [{ rowId: row.id, day: Math.max(1, today - 1), slot, value: 17.1 }] } });
  check('the rest of the month can be charted', resumed.json?.saved === 1, JSON.stringify(resumed.json?.refused));
} else {
  for (const name of ['it reads as signed and shut', 'the supervisor is offered the way out',
    'putting it back into use works', 'the rest of the month can be charted']) skip(name);
}

console.log('\n[4] A month that has ended is signed, and stays signed');
const old = await j('/routine-sheets/open', { token: A, method: 'POST',
  body: { kind: 'environmental', subjectId: asset.json?.id, month: lastMonth, sectionId: unit } });
check('last month\'s chart opens', old.status === 200, `status ${old.status} ${JSON.stringify(old.json?.error)}`);
const oldId = old.json?.sheet?.id;
check('and its signature is offered', (await j(`/routine-sheets/${oldId}`, { token: S })).json?.permissions?.canVerify === true);
const signed = await j(`/routine-sheets/${oldId}/verify`, { token: S, method: 'POST', body: { acknowledgeGaps: true } });
check('it can be signed off', signed.status === 200, `status ${signed.status} ${JSON.stringify(signed.json?.error)}`);
const after = (await j(`/routine-sheets/${oldId}`, { token: S })).json;
check('and it is closed for good', after?.sheet?.locked === true, JSON.stringify(after?.sheet?.status));
check('with no way back into use', after?.permissions?.canReopen === false);
const refuseReopen = await j(`/routine-sheets/${oldId}/reopen`, { token: S, method: 'POST', body: {} });
check('reopening a properly signed month is refused', refuseReopen.status === 400, `status ${refuseReopen.status}`);
check('and points at a nonconformity instead', /nonconformity/.test(refuseReopen.json?.error ?? ''),
  JSON.stringify(refuseReopen.json?.error));

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ''}`);
process.exit(fail === 0 ? 0 : 1);
