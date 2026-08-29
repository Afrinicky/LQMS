/**
 * The chart that would not draw, and the record nobody could print.
 *
 * Two things this wave had to fix, and both are the kind that pass a code
 * review and fail at the bench:
 *
 *   A control with an assigned mean but no assigned SD — which is what every
 *   control looks like for its first weeks, and what the define screen
 *   explicitly invites — printed a page with a heading, a statistics strip and
 *   a blank rectangle where the chart should have been. A blank rectangle on a
 *   signed quality record is indistinguishable from a fault.
 *
 *   And there was no way to print what a control actually READ against what it
 *   should have read. The Levey-Jennings chart answers "is the method
 *   behaving"; review asks "what did it read on Tuesday, and was that inside
 *   the range", and that had no document at all.
 *
 *   npm run api        (in one terminal)
 *   node scripts/iqc-report-check.mjs
 */
import * as XLSX from 'xlsx';

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
const text = async (p, token) => {
  const r = await fetch(`${BASE}${p}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: r.status, body: await r.text() };
};
const book = async (p, token) => {
  const r = await fetch(`${BASE}${p}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) return { status: r.status, rows: null };
  const wb = XLSX.read(Buffer.from(await r.arrayBuffer()), { type: 'buffer' });
  return { status: r.status, sheetName: wb.SheetNames[0], rows: XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '', raw: false }) };
};

const st = await j('/setup/status');
if (!st.json?.setupComplete) {
  await j('/setup/initialize', { method: 'POST', body: { facilityName: 'Report Lab', username: 'admin', password: PW, fullName: 'Admin User' } });
}
const A = (await j('/auth/login', { method: 'POST', body: { username: 'admin', password: PW } })).json?.token;
if (!A) { console.error(`Could not sign in — is the API running on ${BASE}?`); process.exit(1); }

const stamp = Date.now().toString(36).toUpperCase();
const today = new Date().toISOString().slice(0, 10);
const day = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

/* ==========================================================================
   0. Three controls: one with a full target, one with no SD, one flat
   ======================================================================== */
console.log('\n[0] Controls in the three states a chart has to cope with');

const make = async (name, analytes) => (await j('/iqc/materials', {
  token: A, method: 'POST',
  body: {
    materialName: name, testName: 'Liver function', lotNumber: `LOT-${stamp}-${name.slice(-1)}`,
    source: 'commercial', controlType: 'quantitative', qcFrequency: 'daily',
    ruleProfile: 'westgard_standard', expiryDate: day(-365), analytes,
  },
})).json;

const full = await make(`Full target ${stamp}`, [
  { analyte: 'Total bilirubin', unit: 'µmol/L', targetMean: '12', targetSd: '0.8', decimalPlaces: '1' },
]);
const noSd = await make(`No SD ${stamp}`, [
  { analyte: 'Total bilirubin', unit: 'µmol/L', targetMean: '12', targetSd: '', decimalPlaces: '1' },
]);
const flat = await make(`Flat series ${stamp}`, [
  { analyte: 'Total bilirubin', unit: 'µmol/L', targetMean: '12', targetSd: '', decimalPlaces: '1' },
]);
check('three controls are defined', Boolean(full?.id && noSd?.id && flat?.id));

const analyteOf = async id => ((await j(`/iqc/materials/${id}/analytes`, { token: A })).json ?? [])[0];
const fullA = await analyteOf(full.id), noSdA = await analyteOf(noSd.id), flatA = await analyteOf(flat.id);
check('the control with no SD really has none', noSdA?.target_sd === null, JSON.stringify(noSdA?.target_sd));

const record = async (material, analyte, values, dates) => {
  const ids = [];
  for (let i = 0; i < values.length; i++) {
    const r = await j('/iqc/runs', { token: A, method: 'POST', body: {
      iqcMaterialId: material.id, runDate: dates?.[i] ?? day(values.length - i),
      runTime: '09:0' + (i % 10), readings: [{ analyteId: analyte.id, value: values[i] }],
    } });
    if (r.json?.id) ids.push(r.json.id);
  }
  return ids;
};

const fullRuns = await record(full, fullA, [12.1, 11.6, 12.8, 12.0, 13.9]);
const noSdRuns = await record(noSd, noSdA, [12.1, 11.8, 12.4, 12.2]);
// The exact case from the bench: the same number twice, and no assigned SD.
const flatRuns = await record(flat, flatA, [12.1, 12.1]);
check('runs are recorded against all three', fullRuns.length === 5 && noSdRuns.length === 4 && flatRuns.length === 2,
  `${fullRuns.length}/${noSdRuns.length}/${flatRuns.length}`);

/* ==========================================================================
   1. The chart draws in every one of those states
   ======================================================================== */
console.log('\n[1] The printed chart is never blank');

/** Points are circles or triangles; a page with neither drew nothing. */
const plotted = html => (html.match(/<circle|<polygon/g) ?? []).length;

const p1 = await text(`/iqc/analytes/${fullA.id}/chart/print?autoprint=0`, A);
check('a control with a full target prints its chart', p1.status === 200 && plotted(p1.body) >= 5, `${plotted(p1.body)} points`);
check('and is called a Levey-Jennings chart', p1.body.includes('Levey-Jennings chart —'));
check('with no caveat over it', !p1.body.includes('class="caveat"'));

const p2 = await text(`/iqc/analytes/${noSdA.id}/chart/print?autoprint=0`, A);
check('a control with NO assigned SD still prints a chart', p2.status === 200 && plotted(p2.body) >= 4, `${plotted(p2.body)} points`);
check('it is called a run chart rather than passed off as a Levey-Jennings chart',
  p2.body.includes('Run chart — no control limits established yet'),
  p2.body.slice(p2.body.indexOf('<h1'), p2.body.indexOf('<h1') + 140));
check('and it does NOT invent SD bands from the handful of runs so far',
  !p2.body.includes('+1SD') && !p2.body.includes('provisional limits'));
check('the page says what is needed before limits exist',
  p2.body.includes('20 results over 20 days'));
check('and it is drawn against the acceptable range, which is what a result is checked against',
  p2.body.includes('>High<') || p2.body.includes('>Low<') || p2.body.includes('no acceptable range'));

const p3 = await text(`/iqc/analytes/${flatA.id}/chart/print?autoprint=0`, A);
check('two identical results with no SD still print a chart', p3.status === 200 && plotted(p3.body) >= 2, `${plotted(p3.body)} points`);
check('and it too is called a run chart', p3.body.includes('Run chart — no control limits established yet'));

/* ==========================================================================
   2. The runs, as a printed record
   ======================================================================== */
console.log('\n[2] The runs against their targets, printed');

const report = await text(`/iqc/runs/report/print?ids=${fullRuns.join(',')}&autoprint=0`, A);
check('a set of runs prints as one document', report.status === 200);
check('every selected run is on it', fullRuns.every(() => true) && (report.body.match(/<section class="run">/g) ?? []).length === 5,
  `${(report.body.match(/<section class="run">/g) ?? []).length} sections`);
check('the result is shown beside the target it was measured against',
  report.body.includes('Target mean') && report.body.includes('Acceptable range') && report.body.includes('Against target'));
check('and the rejected run is marked as rejected', report.body.includes('Rejected'));
check('it carries the decision about patient results', report.body.includes('Patient results'));

const withCharts = await text(`/iqc/runs/report/print?ids=${fullRuns.join(',')}&charts=1&autoprint=0`, A);
check('the chart can travel on the same document',
  withCharts.status === 200 && withCharts.body.includes('<section class="chart">'));
check('and it is drawn, not left blank', plotted(withCharts.body) > plotted(report.body));

const several = await text(`/iqc/runs/report/print?materialIds=${full.id},${noSd.id}&from=${day(30)}&to=${today}&charts=1&autoprint=0`, A);
check('several controls print together', several.status === 200
  && (several.body.match(/<section class="run">/g) ?? []).length === 9,
  `${(several.body.match(/<section class="run">/g) ?? []).length} runs`);
check('with a chart for each of them',
  (several.body.match(/<section class="chart">/g) ?? []).length === 2);
check('and a chart that has no SD still draws inside the report',
  several.body.includes('Run chart — no control limits established yet'));

const empty = await text('/iqc/runs/report/print?autoprint=0', A);
check('selecting nothing prints nothing rather than the whole register',
  empty.status === 200 && empty.body.includes('No control runs were selected'));

/* ==========================================================================
   3. The same thing in Excel
   ======================================================================== */
console.log('\n[3] The same record, in Excel');

const wb = await book(`/iqc/runs/report.xlsx?ids=${fullRuns.join(',')}`, A);
check('the workbook downloads', wb.status === 200, `${wb.status}`);
check('one row per reading', wb.rows?.length === 5, `${wb.rows?.length} rows`);
check('carrying the target the reading was measured against',
  wb.rows?.[0]?.['Target mean'] === '12' && wb.rows?.[0]?.Parameter === 'Total bilirubin',
  JSON.stringify(wb.rows?.[0])?.slice(0, 200));
check('and how far from it the result landed', String(wb.rows?.[0]?.['Against target'] ?? '').length > 0,
  wb.rows?.[0]?.['Against target']);
check('with the run outcome on every row', wb.rows?.every(r => r['Run outcome']));

/* ==========================================================================
   4. The portal: the chart where the work happens
   ======================================================================== */
console.log('\n[4] The chart, and a new control, from the portal');

const sections = (await j('/sections', { token: A })).json ?? [];
const sectionId = sections[0]?.id;
const staffId = (await j('/staff', { token: A, method: 'POST', body: {
  fullName: `QC Scientist ${stamp}`, employeeNo: `Q${stamp}`, sectionId,
} })).json?.id;
const me = (await j('/auth/me', { token: A })).json?.user;
await j(`/users/${me.id}`, { token: A, method: 'PUT', body: { staffId } });

// Put the controls in that unit so they reach the board.
for (const m of [full, noSd, flat]) {
  await j(`/iqc/materials/${m.id}`, { token: A, method: 'PUT', body: { sectionId } });
}

const board = (await j('/iqc/portal/board', { token: A })).json;
check('the board resolves to the unit', Number(board?.sectionId) === Number(sectionId), JSON.stringify(board?.sectionId));
check('and says whether this person may define a control', board?.canDefine === true);
check('naming the unit a new control would belong to', Boolean(board?.sectionName));

const lookups = (await j('/iqc/portal/lookups', { token: A })).json;
check('the portal serves the wizard the lists it needs',
  Array.isArray(lookups?.sections) && Array.isArray(lookups?.staff) && Array.isArray(lookups?.equipment),
  JSON.stringify(Object.keys(lookups ?? {})));
check('and tells it which unit to start on', Number(lookups?.sectionId) === Number(sectionId));

const chartAnalytes = (await j(`/iqc/portal/controls/${noSd.id}/chart-analytes`, { token: A })).json;
check('a control offers its parameters for charting', Array.isArray(chartAnalytes) && chartAnalytes.length === 1);

const portalChart = (await j(`/iqc/portal/analytes/${noSdA.id}/chart`, { token: A })).json;
check('the chart can be read inside the portal', Array.isArray(portalChart?.points) && portalChart.points.length === 4,
  `${portalChart?.points?.length} points`);
check('with the same statistics the module computes',
  portalChart?.statistics?.n === 4 && portalChart.analyte?.targetSd === null,
  JSON.stringify(portalChart?.statistics));

/* ==========================================================================
   5. A control outside the unit is not readable through the portal
   ======================================================================== */
console.log('\n[5] The portal chart does not reach past the unit');

const other = (await j('/section-config/sections', { token: A, method: 'POST', body: { name: `Other unit ${stamp}` } })).json;
if (other?.id) {
  await j(`/iqc/materials/${flat.id}`, { token: A, method: 'PUT', body: { sectionId: other.id, performingSectionId: other.id } });
  const blocked = await j(`/iqc/portal/analytes/${flatA.id}/chart`, { token: A });
  check('a control belonging to another unit is not charted here', blocked.status === 404, `${blocked.status}`);
  const blockedList = await j(`/iqc/portal/controls/${flat.id}/chart-analytes`, { token: A });
  check('nor are its parameters listed', blockedList.status === 404, `${blockedList.status}`);
} else {
  check('a second unit could be created to test the boundary', false, JSON.stringify(other));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
