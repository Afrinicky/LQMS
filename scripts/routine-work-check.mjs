/**
 * Routine Work — end to end, against a running API.
 *
 * The claim this makes is a specific one: a member of staff can complete the
 * routine work of the bench from their portal. So it exercises the whole path
 * for each kind of work, in the order somebody would actually meet it —
 * programme, sheet, cell, breach, verification, archive — and it checks the
 * parts that are easy to get quietly wrong: that an out-of-range chart entry
 * raises an excursion through the same engine a hand-entered reading does,
 * that a signed month refuses further edits, and that a pasted analyser block
 * lines up by parameter NAME rather than by position.
 *
 *   npm run api        (in one terminal)
 *   node scripts/routine-work-check.mjs
 */
const BASE = process.env.API || 'http://127.0.0.1:4430/api';
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
  await j('/setup/initialize', { method: 'POST', body: { facilityName: 'Routine Lab', username: 'admin', password: PW, fullName: 'Admin User' } });
}
const A = (await j('/auth/login', { method: 'POST', body: { username: 'admin', password: PW } })).json?.token;
if (!A) { console.error('Could not sign in — is the API running on ' + BASE + '?'); process.exit(1); }

const month = new Date().toISOString().slice(0, 7);
const stamp = Date.now().toString(36).toUpperCase();

/* ==========================================================================
   Setting the scene: a unit, a member of staff in it, a fridge, a microscope
   ======================================================================== */
console.log('\n[0] A unit with a fridge and a microscope in it');

const sections = (await j('/sections', { token: A })).json ?? [];
const sectionId = sections.find(s => /haemat/i.test(s.name))?.id ?? sections[0]?.id;
check('a unit exists to work in', Boolean(sectionId), JSON.stringify(sections.length));

// Link the signing-in account to a staff record in that unit. Everything in the
// portal is scoped by "which unit is this person in", so without this the
// screens correctly show nothing — which is itself worth asserting, below.
const staffId = (await j('/staff', { token: A, method: 'POST', body: {
  fullName: `Bench Scientist ${stamp}`, employeeNo: `E${stamp}`, sectionId,
} })).json?.id;
const me = (await j('/auth/me', { token: A })).json?.user;
const linked = staffId && me?.id
  ? await j(`/users/${me.id}`, { token: A, method: 'PUT', body: { staffId } })
  : { status: 0 };
check('the account is linked to a staff record in that unit', linked.status === 200, JSON.stringify(linked.json)?.slice(0, 120));

const assetId = (await j('/environmental/assets', { token: A, method: 'POST', body: {
  assetCode: `FRIDGE-${stamp}`, name: `Reagent fridge ${stamp}`, assetType: 'refrigerator',
  sectionId, responsibleSectionId: sectionId, tempMin: 2, tempMax: 8,
} })).json?.id;
const fridge = ((await j('/environmental/assets', { token: A })).json ?? []).find(a => a.id === assetId);
check('a fridge is registered to that unit with a 2–8 °C range',
  Boolean(assetId) && Number(fridge?.responsible_section_id ?? fridge?.section_id) === Number(sectionId),
  JSON.stringify({ s: fridge?.section_id, r: fridge?.responsible_section_id }));

const equipmentId = (await j('/equipment', { token: A, method: 'POST', body: {
  name: `Microscope ${stamp}`, equipmentCategory: 'measuring_device', sectionId, status: 'operational',
} })).json?.id;
const microscope = (await j(`/equipment/${equipmentId}`, { token: A })).json;
check('a microscope is registered in that unit',
  Boolean(equipmentId) && Number(microscope?.section_id) === Number(sectionId), JSON.stringify(microscope?.section_id));

/* ==========================================================================
   1. The environmental chart
   ======================================================================== */
console.log('\n[1] The month\'s temperature chart — read, recorded, breached');

const open = await j('/routine-sheets/open', { token: A, method: 'POST', body: {
  kind: 'environmental', subjectId: assetId, month, sectionId,
} });
check('the fridge\'s chart for this month opens', open.status === 200, JSON.stringify(open.json)?.slice(0, 200));
const sheetId = open.json?.sheet?.id;
const tempRow = open.json?.rows?.find(r => r.row_key === 'temperature');
check('it carries a temperature row with the asset\'s own range',
  tempRow && tempRow.min_value === 2 && tempRow.max_value === 8, JSON.stringify(tempRow?.label));
check('the row is read morning and afternoon', (tempRow?.slots ?? []).length === 2, JSON.stringify(tempRow?.slots));

let sheet = await j(`/routine-sheets/${sheetId}/cells`, { token: A, method: 'POST', body: {
  cells: [{ rowId: tempRow.id, day: 1, slot: 'am', value: 4.2 }],
} });
check('an in-range reading records cleanly', sheet.json?.saved === 1 && sheet.json.breaches.length === 0, JSON.stringify(sheet.json?.breaches));
check('the cell knows who recorded it', Boolean(sheet.json?.cells?.[0]?.recorded_by_staff_id));
check('and carries their initials without them typing any', Boolean(sheet.json?.cells?.[0]?.initials));

sheet = await j(`/routine-sheets/${sheetId}/cells`, { token: A, method: 'POST', body: {
  cells: [{ rowId: tempRow.id, day: 1, slot: 'pm', value: 11.4 }],
} });
check('a reading above 8 °C is marked out of range', sheet.json?.breaches?.length === 1, JSON.stringify(sheet.json?.breaches));

// The point of routing chart entries through the monitoring engine: the
// excursion register must see this exactly as it sees a hand-entered reading.
const excursions = (await j('/environmental/excursions', { token: A })).json ?? [];
check('it raised a real excursion on the asset',
  excursions.some(e => Number(e.asset_id) === Number(assetId) && e.status === 'open'),
  `${excursions.length} excursion(s)`);
const readings = (await j(`/environmental/assets/${assetId}/readings?from=${month}-01&to=${month}-31T23:59:59`, { token: A })).json ?? [];
check('and wrote a reading into the environmental register', readings.length === 2, `${readings.length} reading(s)`);

const detail = (await j(`/routine-sheets/${sheetId}`, { token: A })).json;
check('the month reports what is missing, not just what is there',
  detail?.completeness?.missingCount > 0 && detail.completeness.expected > 2,
  JSON.stringify(detail?.completeness && { expected: detail.completeness.expected, missing: detail.completeness.missingCount }));
check('and counts the breach', detail?.completeness?.breaches === 1);
check('the breach is flagged as unexplained until somebody says what they did',
  detail?.completeness?.unexplainedBreaches === 1);

await j(`/routine-sheets/${sheetId}/cells`, { token: A, method: 'POST', body: {
  cells: [{ rowId: tempRow.id, day: 1, slot: 'pm', value: 11.4, note: 'Door found ajar; closed and re-read at 16:40.' }],
} });
const afterNote = (await j(`/routine-sheets/${sheetId}`, { token: A })).json;
check('recording what was done clears the unexplained flag', afterNote?.completeness?.unexplainedBreaches === 0);

// A cell is one reading. Coming back to it to write down what was done must not
// post the temperature a second time and double-count the month.
const readingsAfter = (await j(`/environmental/assets/${assetId}/readings?from=${month}-01&to=${month}-31T23:59:59`, { token: A })).json ?? [];
check('adding a note to a cell does not post the reading again',
  readingsAfter.length === 2, `${readingsAfter.length} reading(s)`);

/* ==========================================================================
   2. Signing the month
   ======================================================================== */
console.log('\n[2] The supervisor signs the month');

const refused = await j(`/routine-sheets/${sheetId}/verify`, { token: A, method: 'POST', body: { comments: 'Fine' } });
check('signing a month with gaps is refused until the gaps are acknowledged',
  refused.status === 409 && refused.json?.error === 'gaps', `${refused.status}`);
check('and the refusal says exactly how many are missing',
  String(refused.json?.message ?? '').includes(String(afterNote.completeness.missingCount)));

const verified = await j(`/routine-sheets/${sheetId}/verify`, { token: A, method: 'POST', body: {
  comments: 'One excursion on the 1st, dealt with.', acknowledgeGaps: true, raiseNc: true,
} });
check('acknowledging them lets it be signed', verified.status === 200, JSON.stringify(verified.json)?.slice(0, 160));
check('the signature is a real recorded signature', Boolean(verified.json?.signature?.id));
check('and states the gaps it was signed over',
  String(verified.json?.signature?.meaning ?? '').includes('not recorded'), verified.json?.signature?.meaning);
check('an NC was raised against the month', Boolean(verified.json?.ncId));

const locked = await j(`/routine-sheets/${sheetId}/cells`, { token: A, method: 'POST', body: {
  cells: [{ rowId: tempRow.id, day: 2, slot: 'am', value: 5 }],
} });
check('a signed month refuses further entries', locked.status === 400, `${locked.status}`);
check('and says a nonconformity is how a signed record gets corrected',
  String(locked.json?.error ?? '').toLowerCase().includes('nonconformity'), locked.json?.error);

const archived = await j(`/routine-sheets/${sheetId}/archive`, { token: A, method: 'POST', body: {} });
check('a signed month can be archived', archived.status === 200 && Boolean(archived.json?.archiveId));

/* ==========================================================================
   3. Decontamination
   ======================================================================== */
console.log('\n[3] Decontamination — the general programme, and a unit\'s reading of it');

const frameworks = (await j('/decontamination/frameworks', { token: A })).json ?? [];
check('the standard set ships with the system', frameworks.length >= 10, `${frameworks.length}`);
check('bench tops are in it, twice daily', frameworks.some(f => f.key === 'bench_tops' && f.frequency === 'twice_daily'));

const definitions = (await j(`/decontamination/definitions?sectionId=${sectionId}`, { token: A })).json ?? [];
check('every unit carries the laboratory-wide programme without being given it',
  definitions.length >= 10, `${definitions.length} for this unit`);
const bench = definitions.find(d => d.framework_key === 'bench_tops');
check('bench decontamination is one of them', Boolean(bench));

const unitSetting = await j(`/decontamination/definitions/${bench.id}/units/${sectionId}`, { token: A, method: 'PUT', body: {
  frequency: 'daily',
} });
check('a unit can run a laboratory-wide decontamination at its own frequency', unitSetting.status === 200);

const excuseRefused = await j(`/decontamination/definitions/${bench.id}/units/${sectionId}`, { token: A, method: 'PUT', body: {
  isExcluded: true,
} });
check('excusing a unit from one without a reason is refused', excuseRefused.status === 400, excuseRefused.json?.error);

const deconLog = await j('/decontamination/logs/open', { token: A, method: 'POST', body: {
  definitionId: bench.id, sectionId, month,
} });
check('its monthly log opens', deconLog.status === 200 && Boolean(deconLog.json?.sheetId));
const deconSheet = (await j(`/routine-sheets/${deconLog.json.sheetId}`, { token: A })).json;
const deconRow = deconSheet?.rows?.[0];
check('the log is a tick, not a number', deconRow?.row_type === 'tick', deconRow?.row_type);
check('and runs once a day now the unit set it to daily', (deconRow?.slots ?? []).length === 1, JSON.stringify(deconRow?.slots));

const ticked = await j(`/routine-sheets/${deconLog.json.sheetId}/cells`, { token: A, method: 'POST', body: {
  cells: [{ rowId: deconRow.id, day: 1, slot: deconRow.slots[0], done: true }],
} });
check('a decontamination can be recorded as done', ticked.json?.saved === 1);

const notDone = await j(`/routine-sheets/${deconLog.json.sheetId}/cells`, { token: A, method: 'POST', body: {
  cells: [{ rowId: deconRow.id, day: 2, slot: deconRow.slots[0], done: false }],
} });
check('recording that it was NOT done is a breach, not a blank', notDone.json?.breaches?.length === 1);

// The programme has to become work on somebody's list, or it is a policy
// document rather than a register.
// A laboratory-wide decontamination is carried by every unit, and each keeps
// its own log — one shared sheet would have one unit signing for another's benches.
const otherSection = sections.find(s => s.id !== sectionId)?.id;
const otherLog = await j('/decontamination/logs/open', { token: A, method: 'POST', body: {
  definitionId: bench.id, sectionId: otherSection, month,
} });
check('another unit gets its own log of the same laboratory-wide decontamination',
  otherLog.json?.sheetId && otherLog.json.sheetId !== deconLog.json.sheetId,
  `${deconLog.json?.sheetId} vs ${otherLog.json?.sheetId}`);

const activities = (await j(`/duty/activities?sectionId=${sectionId}`, { token: A })).json ?? [];
check('adopting the programme created scheduled reminders for the unit',
  activities.some(a => a.category === 'cleaning'), `${activities.length} activities`);

/* ==========================================================================
   4. Equipment maintenance
   ======================================================================== */
console.log('\n[4] Equipment maintenance — the microscope');

const framework = (await j(`/equipment/${equipmentId}/maintenance-framework`, { token: A })).json;
check('the system knows how a microscope is normally maintained',
  framework?.framework === 'microscope', framework?.framework);
check('and offers the daily lens clean',
  (framework?.tasks ?? []).some(t => /lens|objective/i.test(t.task) && t.frequency === 'daily'));

const added = await j(`/equipment/${equipmentId}/maintenance-tasks`, { token: A, method: 'POST', body: {
  tasks: framework.tasks.map(t => ({ task: t.task, frequency: t.frequency, kind: t.kind, tier: t.tier, guidance: t.guidance })),
} });
check('the whole starting list can be adopted at once', added.status === 201 && added.json.created >= 8, JSON.stringify(added.json?.created));

const chartOpen = await j('/equipment/maintenance-charts/open', { token: A, method: 'POST', body: { equipmentId, month } });
const maintSheet = (await j(`/routine-sheets/${chartOpen.json.sheetId}`, { token: A })).json;
const dailyRows = (maintSheet?.rows ?? []).filter(r => r.cadence === 'daily');
const weeklyRows = (maintSheet?.rows ?? []).filter(r => r.cadence === 'weekly');
check('daily tasks run across the days of the month', dailyRows.length >= 3, `${dailyRows.length}`);
check('weekly and annual ones run across the weeks', weeklyRows.length >= 3, `${weeklyRows.length}`);

const maintCell = await j(`/routine-sheets/${chartOpen.json.sheetId}/cells`, { token: A, method: 'POST', body: {
  cells: [{ rowId: dailyRows[0].id, day: 1, slot: dailyRows[0].slots[0], done: true }],
} });
check('a maintenance task can be ticked off on the chart', maintCell.json?.saved === 1);

const maintActivities = (await j(`/duty/activities?sectionId=${sectionId}`, { token: A })).json ?? [];
check('maintenance appears on the bench\'s duty list, one entry per cadence',
  maintActivities.filter(a => a.category === 'equipment').length >= 2,
  `${maintActivities.filter(a => a.category === 'equipment').length}`);

/* ==========================================================================
   5. IQC in the portal
   ======================================================================== */
console.log('\n[5] IQC from the portal — the board, and the ways in');

const analyserId = (await j('/equipment', { token: A, method: 'POST', body: {
  name: `Haematology analyser ${stamp}`, equipmentCategory: 'analyser', sectionId, status: 'operational',
} })).json?.id;

const control = await j('/iqc/materials', { token: A, method: 'POST', body: {
  materialName: `FBC control ${stamp}`, testName: 'Full blood count', lotNumber: `FBC-${stamp}`,
  levelLabel: 'Level 2', source: 'commercial', controlType: 'quantitative',
  ruleProfile: 'westgard_standard', qcFrequency: 'daily', sectionId, equipmentId: analyserId,
  analytes: [
    { analyte: 'Haemoglobin', unit: 'g/dL', targetMean: 13.5, targetSd: 0.4, acceptableLow: 11, acceptableHigh: 16, decimalPlaces: 1 },
    { analyte: 'WBC', unit: '10^9/L', targetMean: 7.2, targetSd: 0.35, acceptableLow: 4, acceptableHigh: 11, decimalPlaces: 2 },
    { analyte: 'Platelets', unit: '10^9/L', targetMean: 250, targetSd: 18, acceptableLow: 150, acceptableHigh: 400, decimalPlaces: 0 },
    { analyte: 'MCHC', unit: 'g/dL', targetMean: 33, targetSd: 0.6, acceptableLow: 31, acceptableHigh: 36, decimalPlaces: 1 },
  ],
} });
check('a multi-parameter control is created on the analyser', control.status === 201, JSON.stringify(control.json)?.slice(0, 160));
const controlId = control.json.id;

const board = await j('/iqc/portal/board', { token: A });
check('the portal board loads for the unit', board.status === 200, JSON.stringify(board.json?.message));
const boardControl = board.json?.groups?.flatMap(g => g.controls).find(c => c.id === controlId);
check('the control appears on it', Boolean(boardControl));
check('grouped under its analyser', board.json?.groups?.some(g => g.equipmentId === analyserId));
check('and shows plainly that it has not been run today', boardControl?.doneToday === false);
check('the board counts what is due', board.json?.counts?.due >= 1);

// Only diagnostic equipment carries IQC. A control put on a fridge is a
// configuration error and the board has to say so rather than hide it.
const onFridge = await j('/iqc/materials', { token: A, method: 'POST', body: {
  materialName: `Misfiled control ${stamp}`, testName: 'Nothing', lotNumber: `X-${stamp}`,
  source: 'commercial', controlType: 'qualitative', ruleProfile: 'match_expected',
  sectionId, equipmentId,   // the microscope — a measuring device, not an analyser
  analytes: [{ analyte: 'Result', expectedResult: 'positive' }],
} });
const board2 = await j('/iqc/portal/board', { token: A });
check('a control on non-diagnostic equipment is called out, not silently dropped',
  board2.json?.misfiled?.some(m => m.id === onFridge.json?.id), JSON.stringify(board2.json?.misfiled?.length));

/* -- pasting a block, in the analyser's order and naming -------------------- */
const pasted = await j(`/iqc/portal/controls/${controlId}/parse-paste`, { token: A, method: 'POST', body: {
  // Deliberately: the analyser's own mnemonics, in the analyser's order, with
  // a unit column in the way and a parameter the control does not have.
  text: 'PLT\t248\t10^9/L\nHGB\t13.6\tg/dL\nMCHC\t33.2\tg/dL\nWBC\t7.1\t10^9/L\nRDW\t13.1\t%',
} });
check('a pasted block is read', pasted.status === 200, JSON.stringify(pasted.json)?.slice(0, 160));
check('four of the control\'s parameters line up', pasted.json?.matched === 4, `${pasted.json?.matched}`);
check('"HGB" finds Haemoglobin', pasted.json?.readings?.some(r => r.analyte === 'Haemoglobin' && r.value === 13.6));
check('"PLT" finds Platelets even though it was pasted first',
  pasted.json?.readings?.some(r => r.analyte === 'Platelets' && r.value === 248));
check('the unit column is not mistaken for the value',
  pasted.json?.readings?.every(r => r.value !== null && !Number.isNaN(r.value)));
check('a parameter the control does not have is reported, not swallowed',
  pasted.json?.unmatchedLabels?.includes('RDW'), JSON.stringify(pasted.json?.unmatchedLabels));

const partial = await j(`/iqc/portal/controls/${controlId}/parse-paste`, { token: A, method: 'POST', body: {
  text: 'HGB\t13.6\nWBC\t7.1',
} });
check('a partial paste says which parameters are still missing',
  partial.json?.missingAnalytes?.length === 2, JSON.stringify(partial.json?.missingAnalytes?.map(a => a.analyte)));

/* -- the entry methods a control allows ------------------------------------ */
const methods = await j(`/iqc/portal/controls/${controlId}/entry-methods`, { token: A, method: 'PUT', body: {
  entryMethods: ['paste', 'worksheet', 'upload'], preferredEntryMethod: 'paste',
} });
check('a control can declare which ways its results may be entered', methods.status === 200);
check('typing values in is always kept, whatever else is chosen',
  methods.json?.entryMethods?.includes('manual'), JSON.stringify(methods.json?.entryMethods));

const badMethod = await j(`/iqc/portal/controls/${controlId}/entry-methods`, { token: A, method: 'PUT', body: {
  entryMethods: ['paste'], preferredEntryMethod: 'scan',
} });
check('a preferred method the control does not allow is refused', badMethod.status === 400, badMethod.json?.error);

/* -- an instrument feed ---------------------------------------------------- */
const feed = await j('/iqc/portal/feeds', { token: A, method: 'POST', body: {
  name: `Analyser feed ${stamp}`, equipmentId: analyserId, sectionId,
  transport: 'tcp_server', protocol: 'astm', port: 5000,
} });
check('an instrument feed can be set up', feed.status === 201, JSON.stringify(feed.json));

const message = await j(`/iqc/portal/feeds/${feed.json.id}/messages`, { token: A, method: 'POST', body: {
  sampleId: 'QC2', lotNumber: `FBC-${stamp}`,
  values: [{ analyte: 'HGB', value: 13.4 }, { analyte: 'WBC', value: 7.3 }, { analyte: 'PLT', value: 252 }, { analyte: 'MCHC', value: 33.1 }],
} });
check('a control result sent by the analyser is accepted', message.status === 201);
check('and matched to the control by its lot number', message.json?.matched === true, JSON.stringify(message.json));

const mapping = await j(`/iqc/portal/feed-messages/${message.json.id}/mapping`, { token: A });
check('the instrument\'s mnemonics line up with the control\'s parameters',
  mapping.json?.matched === 4, `${mapping.json?.matched}`);

const waiting = await j('/iqc/portal/feed-messages?status=matched', { token: A });
check('it waits on the bench rather than becoming a run on its own',
  (waiting.json ?? []).some(m => m.id === message.json.id && m.status === 'matched'));

/* -- and it all ends in one ordinary run ----------------------------------- */
const analytes = (await j(`/iqc/materials/${controlId}/analytes`, { token: A })).json;
const run = await j('/iqc/runs', { token: A, method: 'POST', body: {
  iqcMaterialId: controlId, equipmentId: analyserId, entryMethod: 'paste',
  readings: pasted.json.readings.map(r => ({ analyteId: r.analyteId, value: r.value })),
} });
check('the mapped values record as an ordinary control run', run.status === 201, JSON.stringify(run.json)?.slice(0, 160));
check('judged by the same Westgard rules as a typed one', run.json?.status === 'in_control', run.json?.ruleSummary);
check('covering every parameter that was pasted', run.json?.analytes?.length === 4);

const board3 = await j('/iqc/portal/board', { token: A });
const done = board3.json?.groups?.flatMap(g => g.controls).find(c => c.id === controlId);
check('the board now shows it as run today', done?.doneToday === true);
check('and flags that nobody has accepted it yet', done?.pendingReview === true);

/* ==========================================================================
   6. The portal's own view
   ======================================================================== */
console.log('\n[6] What the portal actually shows');

const routine = await j('/duty/routine', { token: A });
check('the Routine Work tab has a programme to show',
  (routine.json?.programme ?? []).length > 0, `${(routine.json?.programme ?? []).length} activities`);
check('it covers cleaning and equipment care, not just one kind',
  new Set((routine.json?.programme ?? []).map(a => a.category)).size >= 2,
  JSON.stringify([...new Set((routine.json?.programme ?? []).map(a => a.category))]));

for (const [kind, endpoint] of [
  ['environmental', '/environmental/charts'],
  ['decontamination', '/decontamination/logs'],
  ['equipment_maintenance', '/equipment/maintenance-charts'],
]) {
  const index = await j(`${endpoint}?month=${month}`, { token: A });
  check(`the portal's ${kind} face lists this unit's sheets`,
    index.status === 200 && (index.json?.sheets ?? []).length > 0,
    `${index.status} · ${(index.json?.sheets ?? []).length} sheet(s)`);
}

const printed = await fetch(`${BASE}/routine-sheets/${sheetId}/print`, { headers: { Authorization: `Bearer ${A}` } });
const html = await printed.text();
check('a sheet prints as the laboratory\'s own form', printed.ok && html.includes('<table'), `${printed.status}`);
check('the printed sheet carries the signature block', html.includes('Reviewed and verified by'));
check('and lists what was out of range under the grid', html.includes('Out of range'));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
