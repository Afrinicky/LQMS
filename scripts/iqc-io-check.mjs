/**
 * IQC in and out of Excel.
 *
 * A laboratory that already keeps its controls and its QC in spreadsheets
 * should be able to bring them in without retyping, and take a period's record
 * back out for review, audit or accreditation. The two things this has to get
 * right are that an imported run is judged exactly as a typed one is, and that
 * a bad row is reported rather than silently written.
 *
 *   node scripts/iqc-io-check.mjs
 */
import * as XLSX from 'xlsx';

const BASE = process.env.API || 'http://127.0.0.1:4430/api';
const PW = 'thistle harbour crane';

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

/** Download a workbook and parse it back into rows. */
const grab = async (p, token) => {
  const r = await fetch(`${BASE}${p}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) return { status: r.status, rows: null, type: r.headers.get('Content-Type') };
  const buf = Buffer.from(await r.arrayBuffer());
  const wb = XLSX.read(buf, { type: 'buffer' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  return { status: r.status, rows: XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false }), sheetName: wb.SheetNames[0], buf };
};

const text = async (p, token) => {
  const r = await fetch(`${BASE}${p}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: r.status, body: await r.text(), type: r.headers.get('Content-Type') };
};

/** Post rows as an .xlsx upload, the way the browser does. */
const push = async (p, token, headers, rows, sheetName) => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([headers, ...rows]), sheetName);
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'upload.xlsx');
  const r = await fetch(`${BASE}${p}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
  return { status: r.status, json: await r.json().catch(() => null) };
};

const st = await j('/setup/status');
if (!st.json?.setupComplete) {
  await j('/setup/initialize', { method: 'POST', body: { facilityName: 'IQC Lab', username: 'admin', password: PW, fullName: 'Admin User' } });
}
const A = (await j('/auth/login', { method: 'POST', body: { username: 'admin', password: PW } })).json.token;
const day = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const stamp = Date.now().toString().slice(-6);

const CONTROL_HEADERS = ['Control name', 'Test', 'Lot number', 'Level or designation', 'Source', 'Control type',
  'Manufacturer', 'Expiry date', 'Open-vial expiry', 'Storage condition', 'Section', 'Instrument',
  'Run frequency', 'Rule set', 'Prepared by', 'Preparation date', 'Base material', 'Preparation method',
  'Validation summary', 'Analyte', 'Unit', 'Target mean', 'Target SD', 'Acceptable low', 'Acceptable high',
  'Decimal places', 'Expected result', 'Active'];
const RUN_HEADERS = ['Lot number', 'Run date', 'Run time', 'Shift', 'Instrument', 'Operator', 'Reagent lot',
  'Analyte', 'Result', 'Qualitative result', 'Comment'];

// A control row with only the fields that matter filled in.
const ctl = (o) => CONTROL_HEADERS.map(h => o[h] ?? '');
const run = (o) => RUN_HEADERS.map(h => o[h] ?? '');

/* ------------------------------------------------------------- 1. template */
console.log('\n[1] The templates say what the sheet expects');

const tpl = await grab('/iqc/controls/template', A);
check('a control template downloads', tpl.status === 200, `got ${tpl.status}`);
check('it carries every column the importer reads',
  tpl.rows && CONTROL_HEADERS.every(h => Object.keys(tpl.rows[0]).includes(h)),
  tpl.rows ? `missing ${CONTROL_HEADERS.filter(h => !Object.keys(tpl.rows[0]).includes(h)).join(', ')}` : 'no rows');
check('it shows a worked quantitative example', tpl.rows?.some(r => r['Control type'] === 'quantitative' && r['Target mean']));
check('it shows a worked qualitative example', tpl.rows?.some(r => r['Control type'] === 'qualitative' && r['Expected result']));
check('it shows an in-house control with its provenance',
  tpl.rows?.some(r => r.Source === 'in_house' && r['Preparation method'] && r['Prepared by']));

const runTpl = await grab('/iqc/runs/template', A);
check('a run template downloads', runTpl.status === 200, `got ${runTpl.status}`);
check('it carries every run column', runTpl.rows && RUN_HEADERS.every(h => Object.keys(runTpl.rows[0]).includes(h)));

/* ---------------------------------------------------- 2. importing controls */
console.log('\n[2] Bringing a register in — several controls in one file');

const FBC = `Haematology Control Normal ${stamp}`;
const HBS = `HBsAg Positive Control ${stamp}`;
const POOL = `Pooled Serum ${stamp}`;
const fbcLot = `HC-${stamp}`, hbsLot = `HB-${stamp}`, poolLot = `IH-${stamp}`;

const imported = await push('/iqc/controls/import', A, CONTROL_HEADERS, [
  // One quantitative control across three analyte rows.
  ctl({ 'Control name': FBC, Test: 'Full blood count', 'Lot number': fbcLot, 'Level or designation': 'Level 2 (Normal)',
    Source: 'commercial', 'Control type': 'quantitative', Manufacturer: 'Acme Diagnostics', 'Expiry date': day(-365),
    'Run frequency': 'daily', 'Rule set': 'westgard_standard',
    Analyte: 'Haemoglobin', Unit: 'g/dL', 'Target mean': '13.5', 'Target SD': '0.4', 'Acceptable low': '11', 'Acceptable high': '16', 'Decimal places': '1', Active: 'yes' }),
  ctl({ 'Control name': FBC, Test: 'Full blood count', 'Lot number': fbcLot, Source: 'commercial', 'Control type': 'quantitative',
    'Expiry date': day(-365), Analyte: 'WBC', Unit: '×10⁹/L', 'Target mean': '7.2', 'Target SD': '0.35', 'Decimal places': '2', Active: 'yes' }),
  ctl({ 'Control name': FBC, Test: 'Full blood count', 'Lot number': fbcLot, Source: 'commercial', 'Control type': 'quantitative',
    'Expiry date': day(-365), Analyte: 'Platelets', Unit: '×10⁹/L', 'Target mean': '250', 'Target SD': '18', 'Decimal places': '0', Active: 'yes' }),
  // A qualitative control in the same file.
  ctl({ 'Control name': HBS, Test: 'Hepatitis B surface antigen', 'Lot number': hbsLot, 'Level or designation': 'Positive control',
    Source: 'commercial', 'Control type': 'qualitative', 'Expiry date': day(-200), 'Run frequency': 'per_kit',
    Analyte: 'HBsAg', 'Expected result': 'reactive', Active: 'yes' }),
  // An in-house control, which must carry how it was made.
  ctl({ 'Control name': POOL, Test: 'Glucose', 'Lot number': poolLot, Source: 'in_house', 'Control type': 'quantitative',
    'Expiry date': day(-120), 'Preparation date': day(30), 'Base material': 'Residual patient serum',
    'Preparation method': 'Pooled from 20 residual sera, filtered, aliquoted 0.5 mL',
    'Validation summary': 'Assigned over 20 runs', Analyte: 'Glucose', Unit: 'mmol/L',
    'Target mean': '5.5', 'Target SD': '0.2', 'Decimal places': '2', Active: 'yes' }),
], 'IQC CONTROLS');

check('the import is accepted', imported.status === 200, JSON.stringify(imported.json));
check('all three controls are created', imported.json?.created === 3, `created ${imported.json?.created}`);
check('every analyte row is written', imported.json?.analytes === 5, `${imported.json?.analytes}`);
check('nothing is reported as an error', (imported.json?.errors ?? []).length === 0, JSON.stringify(imported.json?.errors));

const mats = (await j('/iqc/materials', { token: A })).json;
const fbcMat = mats.find(m => m.material_name === FBC);
const hbsMat = mats.find(m => m.material_name === HBS);
const poolMat = mats.find(m => m.material_name === POOL);
check('the quantitative control kept its three analytes', fbcMat?.analyte_count === 3, `${fbcMat?.analyte_count}`);
check('the qualitative control is stored as qualitative', hbsMat?.control_type === 'qualitative', hbsMat?.control_type);
check('a qualitative control gets the matching rule set', hbsMat?.rule_profile === 'match_expected', hbsMat?.rule_profile);
check('the in-house control is marked in-house', poolMat?.source === 'in_house', poolMat?.source);

const poolFull = (await j(`/iqc/materials/${poolMat.id}`, { token: A })).json;
check('and it carries the provenance ISO 15189 §7.3.7.2 asks for',
  !!(poolFull?.preparation_method && poolFull?.base_material), JSON.stringify(poolFull?.preparation_method));

/* --------------------------------------------------- 3. refusing bad rows */
console.log('\n[3] A row that cannot be accepted is named, not swallowed');

const bad = await push('/iqc/controls/import', A, CONTROL_HEADERS, [
  ctl({ 'Control name': `Broken A ${stamp}`, 'Lot number': `BA-${stamp}`, Analyte: 'Thing' }),                      // no test
  ctl({ 'Control name': `Broken B ${stamp}`, Test: 'Glucose', 'Lot number': `BB-${stamp}`, Source: 'donated', Analyte: 'Glucose' }),
  ctl({ 'Control name': `Broken C ${stamp}`, Test: 'HIV', 'Lot number': `BC-${stamp}`, 'Control type': 'qualitative', Analyte: 'HIV Ag/Ab' }),
  ctl({ 'Control name': `Broken D ${stamp}`, Test: 'Glucose', 'Lot number': `BD-${stamp}`, Source: 'in_house', Analyte: 'Glucose', 'Target mean': '5' }),
  ctl({ Test: 'Glucose', Analyte: 'Glucose' }),                                                                     // no name or lot
], 'IQC CONTROLS');

const msgs = (bad.json?.errors ?? []).join(' | ');
check('a control with no test is refused', /Broken A|no test/i.test(msgs), msgs);
check('an unrecognised source is refused', /source must be/i.test(msgs), msgs);
check('a qualitative analyte with no expected result is refused', /expected result/i.test(msgs), msgs);
check('an in-house control with no preparation method is refused', /in-house/i.test(msgs), msgs);
check('a row with no control name or lot is refused', /control name and lot number/i.test(msgs), msgs);
check('and none of those five is created', bad.json?.created === 0, `created ${bad.json?.created}`);
const badMats = (await j('/iqc/materials', { token: A })).json.filter(m => m.material_name.startsWith('Broken'));
check('nothing from the bad file reached the register', badMats.length === 0, `${badMats.length} found`);

/* -------------------------------------------------- 4. re-import is an update */
console.log('\n[4] Re-importing an edited export updates rather than duplicates');

const again = await push('/iqc/controls/import', A, CONTROL_HEADERS, [
  ctl({ 'Control name': FBC, Test: 'Full blood count', 'Lot number': fbcLot, Source: 'commercial', 'Control type': 'quantitative',
    'Expiry date': day(-365), Manufacturer: 'Acme Diagnostics (revised)',
    Analyte: 'Haemoglobin', Unit: 'g/dL', 'Target mean': '13.6', 'Target SD': '0.4', 'Decimal places': '1', Active: 'yes' }),
], 'IQC CONTROLS');
check('the second import updates the existing lot', again.json?.updated === 1 && again.json?.created === 0, JSON.stringify(again.json));
const matsAfter = (await j('/iqc/materials', { token: A })).json.filter(m => m.material_name === FBC);
check('the control is not duplicated', matsAfter.length === 1, `${matsAfter.length} copies`);
const fbcAnalytes = (await j(`/iqc/materials/${fbcMat.id}/analytes`, { token: A })).json;
check('its other analytes survive the partial re-import', fbcAnalytes.length === 3, `${fbcAnalytes.length}`);
check('the edited target is applied', fbcAnalytes.find(a => a.analyte === 'Haemoglobin')?.target_mean === 13.6);

/* --------------------------------------------------- 5. exporting the register */
console.log('\n[5] Taking the register out, for a period');

const allCtl = await grab('/iqc/controls/export', A);
check('the register exports', allCtl.status === 200, `got ${allCtl.status}`);
check('one row per analyte', allCtl.rows.filter(r => r['Control name'] === FBC).length === 3);
check('the export uses the same columns as the import',
  CONTROL_HEADERS.every(h => Object.keys(allCtl.rows[0]).includes(h)));
check('in-house provenance travels with it',
  allCtl.rows.some(r => r['Control name'] === POOL && r['Preparation method']));

const future = await grab(`/iqc/controls/export?from=${day(-30)}&to=${day(-20)}`, A);
check('a window that predates every control returns none', future.rows.length === 0, `${future.rows.length} rows`);
const today = await grab(`/iqc/controls/export?from=${day(1)}&to=${day(0)}`, A);
check('a window covering today returns them', today.rows.some(r => r['Control name'] === FBC), `${today.rows.length} rows`);

/* -------------------------------------------------------- 6. importing runs */
console.log('\n[6] Imported runs are judged exactly as typed ones are');

// Twelve in-control days, so the multirules have a history to work against.
// The values alternate either side of the mean: a real control scatters, and a
// flat series on one side would legitimately trip the 10ₓ shift rule.
const settle = [];
for (let d = 30, k = 0; d > 18; d--, k++) {
  const hi = k % 2 === 0;
  settle.push(run({ 'Lot number': fbcLot, 'Run date': day(d), 'Run time': '08:30', Shift: 'Morning', Analyte: 'Haemoglobin', Result: hi ? '13.8' : '13.4' }));
  settle.push(run({ 'Lot number': fbcLot, 'Run date': day(d), 'Run time': '08:30', Shift: 'Morning', Analyte: 'WBC', Result: hi ? '7.3' : '7.1' }));
  settle.push(run({ 'Lot number': fbcLot, 'Run date': day(d), 'Run time': '08:30', Shift: 'Morning', Analyte: 'Platelets', Result: hi ? '258' : '242' }));
}
const seeded = await push('/iqc/runs/import', A, RUN_HEADERS, settle, 'IQC RUNS');
check('a backlog of runs imports', seeded.status === 200, JSON.stringify(seeded.json?.errors));
check('rows sharing lot, date, time and instrument become one run', seeded.json?.created === 12, `${seeded.json?.created} runs`);
check('every reading is stored', seeded.json?.readings === 36, `${seeded.json?.readings}`);
check('none of them is rejected', seeded.json?.rejected === 0, `${seeded.json?.rejected}`);

// One frank 1-3s failure on haemoglobin: 13.5 + 4 × 0.4.
const failRun = await push('/iqc/runs/import', A, RUN_HEADERS, [
  run({ 'Lot number': fbcLot, 'Run date': day(17), 'Run time': '08:30', Analyte: 'Haemoglobin', Result: '15.1' }),
  run({ 'Lot number': fbcLot, 'Run date': day(17), 'Run time': '08:30', Analyte: 'WBC', Result: '7.2' }),
  run({ 'Lot number': fbcLot, 'Run date': day(17), 'Run time': '08:30', Analyte: 'Platelets', Result: '250' }),
], 'IQC RUNS');
check('an out-of-control reading is caught on import', failRun.json?.rejected === 1, JSON.stringify(failRun.json));

const runsNow = (await j('/iqc/runs', { token: A })).json.filter(r => r.lot_number === fbcLot);
const rejectedRun = runsNow.find(r => r.status === 'out_of_control');
check('the rejected run is recorded as such', !!rejectedRun);
check('and its patient results are withheld', rejectedRun?.patient_results_released === 0, `${rejectedRun?.patient_results_released}`);
check('the rule that rejected it is named', !!rejectedRun?.rule_summary, rejectedRun?.rule_summary);
check('an imported failure still cannot be signed off blind',
  (await j(`/iqc/runs/${rejectedRun.id}/review`, { token: A, method: 'POST', body: {} })).status === 400);

// Qualitative: a positive control that reads non-reactive has failed.
const qual = await push('/iqc/runs/import', A, RUN_HEADERS, [
  run({ 'Lot number': hbsLot, 'Run date': day(3), Analyte: 'HBsAg', 'Qualitative result': 'reactive' }),
  run({ 'Lot number': hbsLot, 'Run date': day(2), Analyte: 'HBsAg', 'Qualitative result': 'non_reactive' }),
], 'IQC RUNS');
check('qualitative runs import', qual.json?.created === 2, JSON.stringify(qual.json));
check('a positive control reading non-reactive is rejected', qual.json?.rejected === 1, `${qual.json?.rejected}`);

/* ------------------------------------------------- 7. refusing bad run rows */
console.log('\n[7] Run rows that cannot be trusted are refused');

const badRuns = await push('/iqc/runs/import', A, RUN_HEADERS, [
  run({ 'Lot number': `NOPE-${stamp}`, 'Run date': day(1), Analyte: 'Haemoglobin', Result: '13.5' }),
  run({ 'Lot number': fbcLot, 'Run date': day(1), Analyte: 'Bilirubin', Result: '12' }),
  run({ 'Lot number': fbcLot, 'Run date': day(1), Analyte: 'Haemoglobin', Result: 'about thirteen' }),
  run({ 'Lot number': hbsLot, 'Run date': day(1), Analyte: 'HBsAg', 'Qualitative result': 'probably' }),
  run({ 'Run date': day(1), Analyte: 'Haemoglobin', Result: '13.5' }),
], 'IQC RUNS');
const rmsg = (badRuns.json?.errors ?? []).join(' | ');
check('an unknown lot is refused', /no control with that lot/i.test(rmsg), rmsg);
check('an analyte the control does not measure is refused', /is not an analyte/i.test(rmsg), rmsg);
check('a non-numeric quantitative result is refused', /numeric result/i.test(rmsg), rmsg);
check('an unrecognised qualitative result is refused', /not a recognised result/i.test(rmsg), rmsg);
check('a row missing its lot is refused', /all required/i.test(rmsg), rmsg);

const expiredRun = await push('/iqc/runs/import', A, RUN_HEADERS, [
  run({ 'Lot number': poolLot, 'Run date': day(-200), Analyte: 'Glucose', Result: '5.5' }),
], 'IQC RUNS');
check('a run dated after the lot expired is refused',
  /expired/i.test((expiredRun.json?.errors ?? []).join(' ')), JSON.stringify(expiredRun.json?.errors));

/* --------------------------------------------------------- 8. runs export */
console.log('\n[8] The QC record for a period leaves complete');

const runsOut = await grab(`/iqc/runs/export?materialId=${fbcMat.id}`, A);
check('runs export', runsOut.status === 200, `got ${runsOut.status}`);
check('with the outcome, not just the numbers',
  Object.keys(runsOut.rows[0]).includes('Outcome') && Object.keys(runsOut.rows[0]).includes('Rule'));
check('the rejection is visible in the file, in words', runsOut.rows.some(r => r.Outcome === 'Rejected'),
  [...new Set(runsOut.rows.map(r => r.Outcome))].join(', '));
check('z-scores travel with the results', runsOut.rows.some(r => r['z-score'] !== ''));

const window = await grab(`/iqc/runs/export?materialId=${fbcMat.id}&from=${day(20)}&to=${day(19)}`, A);
check('a date window narrows the export', window.rows.length > 0 && window.rows.length < runsOut.rows.length,
  `${window.rows.length} of ${runsOut.rows.length}`);
check('and only that window is in it', window.rows.every(r => r['Run date'] >= day(20) && r['Run date'] <= day(19)));

/* ----------------------------------------------- 9. the chart, out on paper */
console.log('\n[9] The Levey-Jennings chart as a file and as a printed record');

const hb = fbcAnalytes.find(a => a.analyte === 'Haemoglobin');
const chartX = await grab(`/iqc/analytes/${hb.id}/chart.xlsx`, A);
check('the chart exports to Excel', chartX.status === 200, `got ${chartX.status}`);
check('the series is in it', chartX.rows.filter(r => r['Run date']).length > 10, `${chartX.rows.length} rows`);
const statBlock = JSON.stringify(chartX.rows);
check('the statistics travel with the series', /Observed mean/.test(statBlock) && /SD index/.test(statBlock));
check('so does the period it covers', /Period/.test(statBlock));

const narrowed = await grab(`/iqc/analytes/${hb.id}/chart.xlsx?from=${day(25)}&to=${day(20)}`, A);
check('a date range narrows the chart export',
  narrowed.rows.filter(r => r['Run date']).length < chartX.rows.filter(r => r['Run date']).length,
  `${narrowed.rows.filter(r => r['Run date']).length}`);

const print = await text(`/iqc/analytes/${hb.id}/chart/print?autoprint=0`, A);
check('the printable chart renders', print.status === 200 && /text\/html/.test(print.type ?? ''), `${print.status} ${print.type}`);
check('it draws the chart itself, not a placeholder', /<svg/.test(print.body) && /polyline/.test(print.body));
check('it shows the control limit lines', /\+3SD|−3SD/.test(print.body));
check('it names the control and lot', print.body.includes(fbcLot));
check('it carries the statistics', /Observed mean/.test(print.body) && /CV%/.test(print.body) && /SD index/.test(print.body));
check('it lists the individual results', /<table/.test(print.body) && /Outcome/.test(print.body));
check('it has somewhere to sign', /Reviewed by/.test(print.body) && /Authorised by/.test(print.body));
check('it is laid out for A4', /@page\s*\{\s*size:\s*A4/.test(print.body));

const printRange = await text(`/iqc/analytes/${hb.id}/chart/print?from=${day(25)}&to=${day(20)}&autoprint=0`, A);
check('the printed record states the period it covers',
  printRange.body.includes(day(25)) && printRange.body.includes(day(20)));

/* ------------------------------------------------------- 10. who may do this */
console.log('\n[10] Import and export obey the same rights as the screen');

const roles = (await j('/roles', { token: A })).json;
const bioRole = roles.find(r => /biomedical/i.test(r.name)) ?? roles.find(r => /technician/i.test(r.name));
const bio = `iqcio_bio_${stamp}`;
const made = await j('/users', { token: A, method: 'POST', body: {
  username: bio, password: PW, fullName: 'Kofi Mensah', roleId: bioRole.id, email: `${bio}@lab.test`,
} });
check('a bench account is created for the test', made.status === 201 || made.status === 200, JSON.stringify(made.json));
const B = (await j('/auth/login', { method: 'POST', body: { username: bio, password: PW } })).json?.token;

const perm = async (p, token) => (await fetch(`${BASE}${p}`, { headers: { Authorization: `Bearer ${token}` } })).status;

// Whatever the role holds today, granting the export right must let the file
// out and revoking it must stop it — that is the whole contract.
await j('/permissions/level', { token: A, method: 'POST', body: { scope: 'role', subjectId: bioRole.id, permKey: 'iqc', level: 'manage' } });
const Bm = (await j('/auth/login', { method: 'POST', body: { username: bio, password: PW } })).json?.token;
check('with the export right the register export is served', await perm('/iqc/controls/export', Bm) === 200);
check('and the printable chart is served', await perm(`/iqc/analytes/${hb.id}/chart/print`, Bm) === 200);

await j('/permissions/level', { token: A, method: 'POST', body: { scope: 'role', subjectId: bioRole.id, permKey: 'iqc', level: 'none' } });
const B2 = (await j('/auth/login', { method: 'POST', body: { username: bio, password: PW } })).json?.token;
check('revoking IQC blocks the control export', await perm('/iqc/controls/export', B2) === 403);
check('revoking IQC blocks the run export', await perm('/iqc/runs/export', B2) === 403);
check('revoking IQC blocks the chart export', await perm(`/iqc/analytes/${hb.id}/chart.xlsx`, B2) === 403);
check('revoking IQC blocks printing the chart', await perm(`/iqc/analytes/${hb.id}/chart/print`, B2) === 403);
check('revoking IQC blocks the template', await perm('/iqc/controls/template', B2) === 403);
const blockedImport = await push('/iqc/controls/import', B2, CONTROL_HEADERS, [
  ctl({ 'Control name': `Sneaky ${stamp}`, Test: 'Glucose', 'Lot number': `SN-${stamp}`, Analyte: 'Glucose', 'Target mean': '5' }),
], 'IQC CONTROLS');
check('and blocks importing controls', blockedImport.status === 403, `got ${blockedImport.status}`);
const blockedRuns = await push('/iqc/runs/import', B2, RUN_HEADERS, [
  run({ 'Lot number': fbcLot, 'Run date': day(1), Analyte: 'Haemoglobin', Result: '13.5' }),
], 'IQC RUNS');
check('and blocks importing runs', blockedRuns.status === 403, `got ${blockedRuns.status}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
