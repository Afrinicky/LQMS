/**
 * Lots in series, the period each is run in, and the month's sheet.
 *
 * What this establishes, in the order a laboratory meets it.
 *
 * THE PERIOD. A lot states when it was put into use and when it was exhausted,
 * the expiry date standing as the end until somebody says otherwise. That
 * period is what the schedule is drawn from: nothing is expected of the lot
 * outside it, nothing may be recorded against it there, and the refusal names
 * the lot that WAS open on the day — singly, in a batch, and from a workbook.
 *
 * THE SERIES. A lot may say which lot it continues, and the chain is one
 * control: one line on the schedule, one chart. A series is one examination at
 * one level in one unit, and joining it wrongly is refused rather than warned
 * about, because a series joined wrongly is invisible afterwards.
 *
 * ONE PLACE FOR THE DATES. The schedule will not take a period of its own, so
 * the dates on the vial and the dates in the programme cannot disagree.
 *
 * THE SHEET. A month no lot reaches into carries no sheet; a lot's own days
 * are the only ones its row answers for; and what the screen shows, the print
 * and the workbook show too.
 *
 *   npm run api          (in one terminal)
 *   node scripts/iqc-series-check.mjs
 */
const BASE = process.env.API || 'http://127.0.0.1:4430/api';
const PW = 'Passw0rd!test';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};
const section = name => console.log(`\n${name}\n${'-'.repeat(name.length)}`);

const j = async (p, o = {}) => {
  const headers = { 'Content-Type': 'application/json' };
  if (o.token) headers.Authorization = `Bearer ${o.token}`;
  const r = await fetch(`${BASE}${p}`, {
    method: o.method || 'GET', headers,
    body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const raw = async (p, token) => {
  const r = await fetch(`${BASE}${p}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: r.status, type: r.headers.get('content-type') ?? '', text: await r.text().catch(() => '') };
};
const day = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const month = d => d.slice(0, 7);

const status = await j('/setup/status');
if (!status.json?.setupComplete) {
  await j('/setup/initialize', {
    method: 'POST',
    body: { facilityName: 'Series Test Laboratory', username: 'admin', password: PW, fullName: 'Admin User' },
  });
}
const A = (await j('/auth/login', { method: 'POST', body: { username: 'admin', password: PW } })).json?.token;
if (!A) { console.error(`Could not sign in — is the API running on ${BASE}?`); process.exit(1); }
const stamp = Date.now().toString(36).toUpperCase().slice(-5);

const sections = (await j('/sections/options', { token: A })).json?.sections ?? [];
const unit = sections[0];

const testName = `Series check assay ${stamp}`;
await j('/process-management/tests', {
  token: A, method: 'POST',
  body: { testName, testCode: `SCA-${stamp}`, sectionId: unit.id, sampleType: 'Serum' },
});

const defineLot = (body) => j('/iqc/materials', {
  token: A, method: 'POST',
  body: {
    materialName: `Series control ${stamp}`, testName, source: 'commercial',
    controlType: 'quantitative', ruleProfile: 'westgard_standard', qcFrequency: 'daily',
    sectionId: unit.id, recordingBasis: 'retrospective',
    analytes: [{ analyte: 'ANALYTE', unit: 'g/L', targetMean: 10, targetSd: 0.5, acceptableLow: 8, acceptableHigh: 12, decimalPlaces: 1 }],
    ...body,
  },
});
const analyteOf = async id => ((await j(`/iqc/materials/${id}/analytes`, { token: A })).json ?? [])[0];

/* ========================================================================
   A lot has a period, and the expiry date is the end of it
   ===================================================================== */
section('A lot has a period');

const first = await defineLot({
  lotNumber: `L1-${stamp}`, levelLabel: 'Level 1',
  inUseFrom: day(80), inUseTo: day(41), expiryDate: day(-200),
});
check('a lot is registered with the period it was in use for', first.status === 201, JSON.stringify(first.json)?.slice(0, 200));
const lot1 = first.json?.id;

const expiryOnly = await defineLot({
  lotNumber: `LX-${stamp}`, levelLabel: 'Level 9', inUseFrom: day(30), expiryDate: day(-10),
});
const lotX = expiryOnly.json?.id;
const materials = (await j('/iqc/materials', { token: A })).json ?? [];
const rowX = materials.find(m => m.id === lotX);
check('the expiry date stands as the end of the period when none is given',
  rowX?.in_use_to === null && rowX?.expiry_date === day(-10), JSON.stringify({ to: rowX?.in_use_to, exp: rowX?.expiry_date }));

const backwards = await defineLot({
  lotNumber: `LB-${stamp}`, levelLabel: 'Level 8', inUseFrom: day(10), inUseTo: day(40),
});
check('a lot cannot be taken out of use before it was put into use', backwards.status === 400,
  `${backwards.status} ${JSON.stringify(backwards.json)}`);

const pastExpiry = await defineLot({
  lotNumber: `LE-${stamp}`, levelLabel: 'Level 7', inUseFrom: day(40), inUseTo: day(5), expiryDate: day(20),
});
check('a lot cannot be in use past its expiry date', pastExpiry.status === 400,
  `${pastExpiry.status} ${JSON.stringify(pastExpiry.json)}`);

check('a lot registered without a period is accepted and treated as always in use',
  (await defineLot({ lotNumber: `LO-${stamp}`, levelLabel: 'Level 6' })).status === 201);

/* ========================================================================
   A run belongs to the lot that was open that day
   ===================================================================== */
section('A run belongs to the lot that was open that day');
const a1 = await analyteOf(lot1);

const inside = await j('/iqc/runs', {
  token: A, method: 'POST',
  body: { iqcMaterialId: lot1, runDate: day(60), readings: [{ analyteId: a1.id, value: 10 }] },
});
check('a run inside the lot’s period is recorded', inside.status === 201, JSON.stringify(inside.json)?.slice(0, 160));

const before = await j('/iqc/runs', {
  token: A, method: 'POST',
  body: { iqcMaterialId: lot1, runDate: day(95), readings: [{ analyteId: a1.id, value: 10 }] },
});
check('a run before the lot was in use is refused', before.status === 400, `${before.status} ${JSON.stringify(before.json)}`);
check('and the refusal says when the lot was in use',
  /was not in use until/.test(before.json?.error ?? ''), before.json?.error);

const after = await j('/iqc/runs', {
  token: A, method: 'POST',
  body: { iqcMaterialId: lot1, runDate: day(20), readings: [{ analyteId: a1.id, value: 10 }] },
});
check('a run after the lot was exhausted is refused', after.status === 400, `${after.status} ${JSON.stringify(after.json)}`);

/* ========================================================================
   The next lot continues it
   ===================================================================== */
section('The next lot continues it');

const wrongLevel = await defineLot({
  lotNumber: `LW-${stamp}`, levelLabel: 'Level 2', inUseFrom: day(40), continuesMaterialId: lot1,
});
check('a lot of another level cannot continue it', wrongLevel.status === 400,
  `${wrongLevel.status} ${JSON.stringify(wrongLevel.json)}`);
check('and the refusal says a series is one level', /one level/.test(wrongLevel.json?.error ?? ''), wrongLevel.json?.error);

const wrongTest = await j('/iqc/materials', {
  token: A, method: 'POST',
  body: {
    materialName: `Series control ${stamp}`, testName: `Another assay ${stamp}`, lotNumber: `LT-${stamp}`,
    levelLabel: 'Level 1', source: 'commercial', controlType: 'quantitative', sectionId: unit.id,
    continuesMaterialId: lot1,
    analytes: [{ analyte: 'ANALYTE', targetMean: 10, targetSd: 1 }],
  },
});
check('a control for another examination cannot continue it', wrongTest.status === 400,
  `${wrongTest.status} ${JSON.stringify(wrongTest.json)}`);

const candidates = (await j(`/iqc/series/candidates?sectionId=${unit.id}&testName=${encodeURIComponent(testName)}&levelLabel=Level%201`, { token: A })).json ?? [];
check('the candidate list offers the lot of the same control at the same level',
  candidates.some(c => c.id === lot1), JSON.stringify(candidates.map(c => c.lotNumber)));
check('and offers no lot of another level',
  candidates.every(c => (c.levelLabel ?? '') === 'Level 1'), JSON.stringify(candidates.map(c => c.levelLabel)));

const second = await defineLot({
  lotNumber: `L2-${stamp}`, levelLabel: 'Level 1',
  inUseFrom: day(40), inUseTo: day(1), expiryDate: day(-100), continuesMaterialId: lot1,
});
const lot2 = second.json?.id;
check('the next lot continues it', second.status === 201, JSON.stringify(second.json)?.slice(0, 160));

const all = (await j('/iqc/materials', { token: A })).json ?? [];
const row1 = all.find(m => m.id === lot1);
const row2 = all.find(m => m.id === lot2);
check('both lots read as one series', row1?.series_id === lot1 && row2?.series_id === lot1,
  JSON.stringify({ one: row1?.series_id, two: row2?.series_id }));
check('a lot that continues nothing is its own series', row1?.continues_material_id === null);

const loop = await j(`/iqc/materials/${lot1}`, {
  token: A, method: 'PUT', body: { continuesMaterialId: lot2 },
});
check('a series cannot be made to loop', loop.status === 400, `${loop.status} ${JSON.stringify(loop.json)}`);

/* ========================================================================
   The refusal names the lot that was open
   ===================================================================== */
section('The refusal names the lot that was open');
const a2 = await analyteOf(lot2);
const misdated = await j('/iqc/runs', {
  token: A, method: 'POST',
  body: { iqcMaterialId: lot2, runDate: day(60), readings: [{ analyteId: a2.id, value: 10 }] },
});
check('a run dated inside the PREVIOUS lot’s period is refused on this one', misdated.status === 400,
  `${misdated.status} ${JSON.stringify(misdated.json)}`);
check('and the refusal names the lot that was in use that day',
  (misdated.json?.error ?? '').includes(`L1-${stamp}`), misdated.json?.error);

const batch = await j('/iqc/runs/batch', {
  token: A, method: 'POST',
  body: {
    iqcMaterialId: lot2,
    runs: [
      { runDate: day(30), readings: [{ analyteId: a2.id, value: 10 }] },
      { runDate: day(60), readings: [{ analyteId: a2.id, value: 10 }] },
    ],
  },
});
check('a batch records the run inside the period', batch.json?.recorded === 1, JSON.stringify(batch.json)?.slice(0, 200));
check('and refuses the one outside it by name',
  batch.json?.refused?.length === 1 && (batch.json.refused[0].reason ?? '').includes(`L1-${stamp}`),
  JSON.stringify(batch.json?.refused));

/* ========================================================================
   The period owns the programme's window
   ===================================================================== */
section('One place for the dates');
const from = day(80), to = day(0);
const programme = async () =>
  (await j(`/iqc/programme?sectionId=${unit.id}&from=${from}&to=${to}`, { token: A })).json;

let p = await programme();
let c1 = (p.controls ?? []).find(c => c.id === lot1);
let c2 = (p.controls ?? []).find(c => c.id === lot2);
check('the schedule starts when the lot was put into use', c1?.schedule?.startsOn === day(80), JSON.stringify(c1?.schedule));
check('and ends when it was taken out of use', c1?.schedule?.endsOn === day(41), JSON.stringify(c1?.schedule));
check('nothing is expected of the lot outside its period',
  (c1?.days ?? []).every(d => d.date >= day(80) && d.date <= day(41)),
  JSON.stringify({ first: c1?.days?.[0]?.date, last: c1?.days?.[c1.days.length - 1]?.date }));
check('the programme carries the period and the series',
  c1?.inUseFrom === day(80) && c1?.inUseTo === day(41) && c1?.seriesId === lot1,
  JSON.stringify({ from: c1?.inUseFrom, to: c1?.inUseTo, series: c1?.seriesId }));
check('a lot whose end is its expiry date says so',
  ((p.controls ?? []).find(c => c.id === lotX))?.endIsExpiry === true);

const written = await j(`/iqc/programme/controls/${lot1}/schedule`, {
  token: A, method: 'PUT',
  body: { frequency: 'daily', weekdays: [1, 2, 3, 4, 5], startsOn: day(5), endsOn: day(0), isActive: true },
});
check('the schedule accepts the days and shifts', written.status === 200, JSON.stringify(written.json));
check('and says the period is kept on the lot, not on the schedule',
  /on the lot itself/.test(written.json?.note ?? ''), JSON.stringify(written.json));
p = await programme();
c1 = (p.controls ?? []).find(c => c.id === lot1);
check('the period is unchanged by writing a schedule',
  c1?.schedule?.startsOn === day(80) && c1?.schedule?.endsOn === day(41), JSON.stringify(c1?.schedule));
check('and the days it names are honoured', c1?.schedule?.weekdays?.length === 5, JSON.stringify(c1?.schedule?.weekdays));

const missed = await j('/iqc/programme/missed', {
  token: A, method: 'POST',
  body: { iqcMaterialId: lot1, dueDate: day(20), reason: 'Analyser under repair.' },
});
check('a day the lot was not in use cannot be accounted for either', missed.status === 400,
  `${missed.status} ${JSON.stringify(missed.json)}`);

/* ========================================================================
   A period narrowed after the fact leaves the runs standing
   ===================================================================== */
section('Nothing recorded is moved or hidden');
await j(`/iqc/materials/${lot1}`, { token: A, method: 'PUT', body: { inUseFrom: day(55), inUseTo: day(41) } });
p = await programme();
c1 = (p.controls ?? []).find(c => c.id === lot1);
check('a run now outside the lot’s period is counted and flagged', c1?.runsOutsidePeriod === 1,
  JSON.stringify({ outside: c1?.runsOutsidePeriod }));
const stillThere = (await j(`/iqc/runs?materialId=${lot1}`, { token: A })).json ?? [];
check('and the run itself is still on the record',
  stillThere.some(r => r.run_date === day(60)), JSON.stringify(stillThere.map(r => r.run_date)));
await j(`/iqc/materials/${lot1}`, { token: A, method: 'PUT', body: { inUseFrom: day(80), inUseTo: day(41) } });

/* ========================================================================
   The sheet
   ===================================================================== */
section('The month’s sheet');
const sheetMonth = month(day(0));
const printed = await raw(`/iqc/programme/sheet/print?sectionId=${unit.id}&month=${sheetMonth}&seriesId=${lot1}&autoprint=0`, A);
check('the sheet prints', printed.status === 200 && printed.type.includes('text/html'), `${printed.status} ${printed.type}`);
check('and the printed sheet names the lot and its period',
  printed.text.includes(`L2-${stamp}`), printed.text.slice(0, 200));
check('the printed sheet carries a legend somebody can read in black and white',
  /not run/.test(printed.text) && /lot not in use/i.test(printed.text));

const workbook = await raw(`/iqc/programme/sheet/export.xlsx?sectionId=${unit.id}&month=${sheetMonth}&seriesId=${lot1}`, A);
check('the sheet exports as a workbook',
  workbook.status === 200 && /spreadsheet|octet/.test(workbook.type), `${workbook.status} ${workbook.type}`);

const blank = await raw(`/iqc/programme/sheet/template.xlsx?sectionId=${unit.id}&month=${sheetMonth}&seriesId=${lot1}`, A);
check('a blank month downloads in the shape the run importer reads',
  blank.status === 200 && /spreadsheet|octet/.test(blank.type), `${blank.status} ${blank.type}`);

// A series whose lots all carry periods, in a month none of them reaches
// into. (A lot registered with no period is deliberately treated as always in
// use, so it appears in every month — which is what the open-period lots
// registered above are for.)
const old = month(day(400));
const empty = await raw(`/iqc/programme/sheet/print?sectionId=${unit.id}&seriesId=${lot1}&month=${old}&autoprint=0`, A);
check('a month no lot of the series was in use in carries no sheet',
  empty.status === 200 && /No control of this unit was in use/.test(empty.text), empty.text.slice(0, 200));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
