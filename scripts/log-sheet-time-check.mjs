/**
 * A chart records readings that were taken.
 *
 * Everything here follows from that one sentence. A cell for a day that has not
 * happened is not an early entry, it is a reading nobody took. An afternoon
 * reading typed at 08:05 measures the morning twice and hides the afternoon.
 * And an entry whose day has ended has been relied on — the handover read it,
 * the excursion register counted it — so changing it is an amendment with a
 * name and a reason on it, not an edit.
 *
 * Also checked: the trends a month shows that no single reading does, which is
 * the case where every value is in range and the fridge is failing anyway.
 *
 *   node scripts/log-sheet-time-check.mjs
 */
const BASE = process.env.API || 'http://127.0.0.1:4432/api';
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
if (!st.json?.setupComplete) await j('/setup/initialize', { method: 'POST', body: { facilityName: 'Chart Lab', username: 'admin', password: PW, fullName: 'Admin User' } });
const A = (await j('/auth/login', { method: 'POST', body: { username: 'admin', password: PW } })).json.token;
const stamp = Date.now();

const now = new Date();
const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
const todayDay = now.getDate();
const daysThisMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();

/* ------------------------------------------------------------------- setup */
const sections = (await j('/sections/options', { token: A })).json.sections;
const sectionId = sections[0]?.id;
const staffId = (await j('/staff', { token: A, method: 'POST', body: {
  fullName: `Charting Scientist ${stamp}`, employeeNo: `C${stamp}`, sectionId,
} })).json?.id;
const me = (await j('/auth/me', { token: A })).json?.user;
if (staffId && me?.id) await j(`/users/${me.id}`, { token: A, method: 'PUT', body: { staffId } });

const assetId = (await j('/environmental/assets', { token: A, method: 'POST', body: {
  assetCode: `TIMEFRIDGE-${stamp}`, name: `Time-rules fridge ${stamp}`, assetType: 'refrigerator',
  sectionId, responsibleSectionId: sectionId, tempMin: 2, tempMax: 8,
} })).json?.id;

const opened = await j('/routine-sheets/open', { token: A, method: 'POST', body: {
  kind: 'environmental', subjectId: assetId, month, sectionId,
} });
const sheetId = opened.json?.sheet?.id;
const tempRow = opened.json?.rows?.find(r => r.row_key === 'temperature');
check('a fridge chart opens for this month', Boolean(sheetId) && Boolean(tempRow), JSON.stringify(opened.status));

const write = (cells) => j(`/routine-sheets/${sheetId}/cells`, { token: A, method: 'POST', body: { cells } });

/* ================================================= 1. the future is not recordable */
console.log('\n[1] A reading cannot be entered for a day that has not happened');
if (todayDay < daysThisMonth) {
  const future = await write([{ rowId: tempRow.id, day: daysThisMonth, slot: 'am', value: 4.5 }]);
  check('a future day is refused', future.json?.saved === 0, JSON.stringify(future.json?.saved));
  check('and refused out loud, not silently dropped', (future.json?.refused ?? []).length === 1,
    JSON.stringify(future.json?.refused));
  check('with a reason that says why it is not an early entry',
    /has not happened yet/.test(future.json?.refused?.[0]?.reason ?? ''), future.json?.refused?.[0]?.reason);
  check('and nothing was written for that day',
    !(future.json?.cells ?? []).some(c => c.day === daysThisMonth), 'a cell exists for a future day');
} else {
  check('a future day is refused (skipped — today is the last of the month)', true);
  check('and refused out loud, not silently dropped (skipped)', true);
  check('with a reason that says why it is not an early entry (skipped)', true);
  check('and nothing was written for that day (skipped)', true);
}

/* ================================================ 2. today's afternoon waits */
console.log('\n[2] The afternoon column of today opens in the afternoon');
const window = opened.json?.sheet ?? {};
check('the sheet tells the screen when the PM column opens', typeof window.pmOpensAt === 'number', String(window.pmOpensAt));
check('and when the afternoon reading is actually due', typeof window.pmDueAt === 'number', String(window.pmDueAt));

const minutesNow = now.getHours() * 60 + now.getMinutes();
const pmToday = await write([{ rowId: tempRow.id, day: todayDay, slot: 'pm', value: 5.1 }]);
if (minutesNow < (window.pmOpensAt ?? 900)) {
  check('before the window, today’s PM reading is refused', pmToday.json?.saved === 0, JSON.stringify(pmToday.json?.saved));
  check('and says two readings taken together measure one moment twice',
    /measure one moment twice/.test(pmToday.json?.refused?.[0]?.reason ?? ''), pmToday.json?.refused?.[0]?.reason);
} else {
  check('after the window, today’s PM reading is accepted', pmToday.json?.saved === 1, JSON.stringify(pmToday.json));
  check('and nothing is refused', (pmToday.json?.refused ?? []).length === 0, JSON.stringify(pmToday.json?.refused));
}

const amToday = await write([{ rowId: tempRow.id, day: todayDay, slot: 'am', value: 4.4 }]);
check('this morning’s reading is always accepted', amToday.json?.saved === 1, JSON.stringify(amToday.json?.refused));

/* ================================== 3. today is correctable without ceremony */
console.log('\n[3] Correcting or withdrawing today’s entry is ordinary work');
const corrected = await write([{ rowId: tempRow.id, day: todayDay, slot: 'am', value: 4.9 }]);
check('today’s reading can be changed with no reason asked', corrected.json?.saved === 1, JSON.stringify(corrected.json?.refused));
check('and it is not counted as an amendment', corrected.json?.amended === 0, String(corrected.json?.amended));

const withdrawn = await write([{ rowId: tempRow.id, day: todayDay, slot: 'am', clear: true }]);
check('today’s reading can be withdrawn', withdrawn.json?.cleared === 1, JSON.stringify(withdrawn.json));
check('and the cell is gone from the sheet',
  !(withdrawn.json?.cells ?? []).some(c => c.day === todayDay && c.slot === 'am'), 'the cell is still there');

/* ============================ 4. a past day: filling a blank vs changing it */
console.log('\n[4] A day that has ended: a blank may be filled, a record may not be quietly changed');
const pastDay = todayDay > 3 ? todayDay - 3 : 1;
const backfilled = await write([{ rowId: tempRow.id, day: pastDay, slot: 'am', value: 4.6 }]);
check('filling a blank for a past day is allowed — the reading was taken, just not typed',
  backfilled.json?.saved === 1, JSON.stringify(backfilled.json?.refused));

const noted = await write([{
  rowId: tempRow.id, day: pastDay, slot: 'am', value: 4.6,
  note: 'Re-read at 09:20 after the door was found ajar; contents unaffected.',
}]);
check('adding a note to a past day needs no authorisation — it is the habit worth encouraging',
  noted.json?.saved === 1 && noted.json?.amended === 0, JSON.stringify(noted.json?.refused));

/* ============================================ 5. changing it IS an amendment */
console.log('\n[5] Changing what a past entry says takes a reason, and keeps the original');
const noReason = await write([{ rowId: tempRow.id, day: pastDay, slot: 'am', value: 6.9 }]);
check('changing it without a reason is refused', noReason.json?.saved === 0, JSON.stringify(noReason.json?.saved));
check('and the refusal asks for the reason', /a reason is required/.test(noReason.json?.refused?.[0]?.reason ?? ''),
  noReason.json?.refused?.[0]?.reason);
check('the original value is untouched',
  (noReason.json?.cells ?? []).find(c => c.day === pastDay && c.slot === 'am')?.value_num === 4.6,
  JSON.stringify((noReason.json?.cells ?? []).find(c => c.day === pastDay && c.slot === 'am')?.value_num));

const tooShort = await write([{ rowId: tempRow.id, day: pastDay, slot: 'am', value: 6.9, amendReason: 'typo' }]);
check('a one-word reason is not a reason', tooShort.json?.saved === 0, JSON.stringify(tooShort.json?.saved));

const amended = await write([{
  rowId: tempRow.id, day: pastDay, slot: 'am', value: 6.9,
  amendReason: 'Transcribed as 4.6 from the logger display, which read 6.9; corrected against the printout retained with the chart.',
}]);
check('with a supervisor and a real reason it goes through', amended.json?.saved === 1, JSON.stringify(amended.json?.refused));
check('and is counted as an amendment, not an ordinary entry', amended.json?.amended === 1, String(amended.json?.amended));
const cell = (amended.json?.cells ?? []).find(c => c.day === pastDay && c.slot === 'am');
check('the cell carries the amendment on its face', Number(cell?.amendment_count) === 1, String(cell?.amendment_count));
check('and the reason with it', /corrected against the printout/.test(cell?.last_amend_reason ?? ''), cell?.last_amend_reason);

const trail = await j(`/routine-sheets/${sheetId}/amendments`, { token: A });
check('the amendment trail is readable', trail.status === 200 && trail.json.length === 1, `${trail.status} / ${trail.json?.length}`);
check('the original value stays legible in it', Number(trail.json[0]?.old_value_num) === 4.6, String(trail.json[0]?.old_value_num));
check('beside the value that replaced it', Number(trail.json[0]?.new_value_num) === 6.9, String(trail.json[0]?.new_value_num));
check('with who made the change', Boolean(trail.json[0]?.amended_by_name), JSON.stringify(trail.json[0]?.amended_by_name));

/* =============================================== 6. withdrawal is gated too */
console.log('\n[6] Withdrawing a past entry is the largest change there is');
const wipeNoReason = await write([{ rowId: tempRow.id, day: pastDay, slot: 'am', clear: true }]);
check('withdrawing a past entry without a reason is refused', wipeNoReason.json?.cleared === 0, String(wipeNoReason.json?.cleared));

const wiped = await write([{
  rowId: tempRow.id, day: pastDay, slot: 'am', clear: true,
  amendReason: 'Recorded against the wrong fridge; the reading belongs to Refrigerator 2 and has been entered there.',
}]);
check('with a reason it is withdrawn', wiped.json?.cleared === 1, JSON.stringify(wiped.json));
const trail2 = await j(`/routine-sheets/${sheetId}/amendments`, { token: A });
check('and the withdrawal is on the trail with what it used to say',
  trail2.json.some(a => a.action === 'delete' && Number(a.old_value_num) === 6.9),
  JSON.stringify(trail2.json.map(a => a.action)));

/* ================================================= 7. an import may backfill */
console.log('\n[7] A month loaded from the laboratory’s own paper chart is not typing the future');
// The import path asserts what the paper already said, so the calendar rules
// that govern typing into a live cell do not apply to it.
const template = await fetch(`${BASE}/routine-sheets/${sheetId}/template.xlsx`, { headers: { Authorization: `Bearer ${A}` } });
check('a blank month can be taken out to fill offline', template.status === 200, String(template.status));

/* ====================================== 8. the trends a month shows */
console.log('\n[8] Every reading in range, and the fridge failing anyway');
const trendAsset = (await j('/environmental/assets', { token: A, method: 'POST', body: {
  assetCode: `TRENDFRIDGE-${stamp}`, name: `Trend fridge ${stamp}`, assetType: 'refrigerator',
  sectionId, responsibleSectionId: sectionId, tempMin: 2, tempMax: 8,
} })).json?.id;
// Last month, so every day of it is in the past and writable.
const past = new Date(now.getFullYear(), now.getMonth() - 1, 1);
const pastMonth = `${past.getFullYear()}-${String(past.getMonth() + 1).padStart(2, '0')}`;
const trendSheet = await j('/routine-sheets/open', { token: A, method: 'POST', body: {
  kind: 'environmental', subjectId: trendAsset, month: pastMonth, sectionId,
} });
const trendSheetId = trendSheet.json?.sheet?.id;
const trendRow = trendSheet.json?.rows?.find(r => r.row_key === 'temperature');

// Twelve days climbing from 3.0 to 6.3 — every single one inside 2 to 8 °C.
const climbing = Array.from({ length: 12 }, (_, i) => ({
  rowId: trendRow.id, day: i + 1, slot: 'am', value: Number((3.0 + i * 0.3).toFixed(2)),
}));
const climb = await j(`/routine-sheets/${trendSheetId}/cells`, { token: A, method: 'POST', body: { cells: climbing } });
check('twelve climbing readings all record', climb.json?.saved === 12, JSON.stringify(climb.json?.refused));
check('and not one of them breaches its range', climb.json?.breaches?.length === 0, JSON.stringify(climb.json?.breaches));

const detail = await j(`/routine-sheets/${trendSheetId}`, { token: A });
const trends = detail.json?.trends ?? [];
check('the month is nonetheless flagged', trends.length > 0, JSON.stringify(trends.length));
const rising = trends.find(t => t.kind === 'rising');
check('as a rising trend', Boolean(rising), JSON.stringify(trends.map(t => t.kind)));
check('naming how many readings ran that way', (rising?.points ?? 0) >= 6, String(rising?.points));
check('with the days it ran between', rising?.from?.day === 1 && rising?.to?.day === 12,
  JSON.stringify([rising?.from?.day, rising?.to?.day]));
check('and what a climb like that usually means', /compressor|seal/.test(rising?.meaning ?? ''), rising?.meaning?.slice(0, 60));
check('it is severe enough to act on', rising?.severity === 'act', String(rising?.severity));

/* The slower shape, which is the one a run rule misses: a month that wanders up
   and down while losing margin the whole time. No six readings run the same
   way, so nothing a run rule looks for is there — and the fridge is still
   ending the month with less room than it started with. */
console.log('\n[9] A drift too noisy for a run rule, and still a drift');
const driftAsset = (await j('/environmental/assets', { token: A, method: 'POST', body: {
  assetCode: `DRIFT-${stamp}`, name: `Drifting fridge ${stamp}`, assetType: 'refrigerator',
  sectionId, responsibleSectionId: sectionId, tempMin: 2, tempMax: 8,
} })).json?.id;
const driftSheet = await j('/routine-sheets/open', { token: A, method: 'POST', body: {
  kind: 'environmental', subjectId: driftAsset, month: pastMonth, sectionId,
} });
const driftRow = driftSheet.json?.rows?.find(r => r.row_key === 'temperature');
const noisy = [4.3, 4.6, 4.4, 4.7, 4.5, 5.4, 5.8, 5.5, 6.1, 5.9, 7.1, 7.3, 7.0, 7.4, 7.2];
const drifted = await j(`/routine-sheets/${driftSheet.json.sheet.id}/cells`, { token: A, method: 'POST', body: {
  cells: noisy.map((v, i) => ({ rowId: driftRow.id, day: i + 1, slot: 'am', value: v })),
} });
check('fifteen wandering readings all record', drifted.json?.saved === 15, JSON.stringify(drifted.json?.refused));
check('and none of them is out of range', drifted.json?.breaches?.length === 0, JSON.stringify(drifted.json?.breaches));

const driftDetail = await j(`/routine-sheets/${driftSheet.json.sheet.id}`, { token: A });
const driftTrends = driftDetail.json?.trends ?? [];
check('no run rule fires — nothing runs six the same way',
  !driftTrends.some(t => t.kind === 'rising' || t.kind === 'falling'), JSON.stringify(driftTrends.map(t => t.kind)));
const approaching = driftTrends.find(t => t.kind === 'approaching_limit');
check('but the loss of margin is caught', Boolean(approaching), JSON.stringify(driftTrends.map(t => t.kind)));
check('naming how much margin it has given up', /less margin/.test(approaching?.summary ?? ''),
  approaching?.summary);
check('and it is severe enough to act on', approaching?.severity === 'act', String(approaching?.severity));
check('having stayed one side of the middle, that is caught too',
  driftTrends.some(t => t.kind === 'shift'), JSON.stringify(driftTrends.map(t => t.kind)));

/* A steady, well-centred month raises nothing — a rule that fires on ordinary
   noise teaches people to ignore the ones that matter. */
console.log('\n[10] And a month that is genuinely fine says nothing at all');
const steadyAsset = (await j('/environmental/assets', { token: A, method: 'POST', body: {
  assetCode: `STEADY-${stamp}`, name: `Steady fridge ${stamp}`, assetType: 'refrigerator',
  sectionId, responsibleSectionId: sectionId, tempMin: 2, tempMax: 8,
} })).json?.id;
const steadySheet = await j('/routine-sheets/open', { token: A, method: 'POST', body: {
  kind: 'environmental', subjectId: steadyAsset, month: pastMonth, sectionId,
} });
const steadyRow = steadySheet.json?.rows?.find(r => r.row_key === 'temperature');
const wobble = [5.0, 4.8, 5.2, 4.9, 5.1, 4.7, 5.3, 5.0, 4.9, 5.2, 4.8, 5.1];
await j(`/routine-sheets/${steadySheet.json.sheet.id}/cells`, { token: A, method: 'POST', body: {
  cells: wobble.map((v, i) => ({ rowId: steadyRow.id, day: i + 1, slot: 'am', value: v })),
} });
const steady = await j(`/routine-sheets/${steadySheet.json.sheet.id}`, { token: A });
check('a steady, centred month raises nothing', (steady.json?.trends ?? []).length === 0,
  JSON.stringify((steady.json?.trends ?? []).map(t => t.kind)));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
