/**
 * Recording a SET of control runs, and one intake for every transmission.
 *
 * Three things are established here, in the order a laboratory meets them.
 *
 * FIRST, a set of runs is recorded as a set of runs. An analyser that transmits
 * in bulk sends a week of stored control runs at once, and a laboratory putting
 * a lot's history on the record has a hundred of them. Each must keep its own
 * date, its own readings and its own verdict — a batch that pools them, or that
 * stamps them all today, writes a Levey-Jennings chart that never happened. The
 * rules must read them oldest first, so a trend entered in one sitting is the
 * same trend it would have been entered on ten mornings.
 *
 * SECOND, one intake. A transmission posted to an IQC feed used to be written
 * to the IQC bench and nowhere else, so the Result Filler could not see it and
 * no other module could use it. Every road in now records the transmission
 * verbatim first, exactly as the bridge does.
 *
 * THIRD, the Result Filler fills a CONTROL run entry form. A control run is
 * filed against the control lot rather than a sample number, and the filler
 * must verify it on the lot, offer the control's own parameters, and still
 * refuse a patient form the same transmission.
 *
 *   npm run api          (in one terminal)
 *   node scripts/iqc-bulk-check.mjs
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
  if (o.device) headers['x-sechlims-device'] = o.device;
  const r = await fetch(`${BASE}${p}`, {
    method: o.method || 'GET', headers,
    body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const day = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

const status = await j('/setup/status');
if (!status.json?.setupComplete) {
  await j('/setup/initialize', {
    method: 'POST',
    body: { facilityName: 'Bulk Control Test Laboratory', username: 'admin', password: PW, fullName: 'Admin User' },
  });
}
const A = (await j('/auth/login', { method: 'POST', body: { username: 'admin', password: PW } })).json?.token;
if (!A) { console.error(`Could not sign in — is the API running on ${BASE}?`); process.exit(1); }
const stamp = Date.now().toString(36).toUpperCase().slice(-5);

/* ========================================================================
   A control to run
   ===================================================================== */
section('A control with a lot and three parameters');
const LOT = `BULK-${stamp}`;
const made = await j('/iqc/materials', {
  token: A, method: 'POST',
  body: {
    materialName: `Haematology control ${stamp}`, testName: 'Full blood count',
    lotNumber: LOT, levelLabel: 'Level 1', source: 'commercial',
    controlType: 'quantitative', ruleProfile: 'westgard_standard', qcFrequency: 'daily',
    expiryDate: day(-120),
    analytes: [
      { analyte: 'HGB', unit: 'g/dL', targetMean: 13.5, targetSd: 0.4, acceptableLow: 11, acceptableHigh: 16, decimalPlaces: 1 },
      { analyte: 'WBC', unit: '10*3/uL', targetMean: 7.2, targetSd: 0.35, acceptableLow: 4, acceptableHigh: 11, decimalPlaces: 2 },
      { analyte: 'PLT', unit: '10*3/uL', targetMean: 250, targetSd: 18, acceptableLow: 150, acceptableHigh: 400, decimalPlaces: 0 },
    ],
  },
});
const materialId = made.json?.id;
check('the control is registered', made.status === 201 && Boolean(materialId), JSON.stringify(made.json)?.slice(0, 160));
const analytes = (await j(`/iqc/materials/${materialId}/analytes`, { token: A })).json ?? [];
const hgb = analytes.find(a => a.analyte === 'HGB');
const wbc = analytes.find(a => a.analyte === 'WBC');
const plt = analytes.find(a => a.analyte === 'PLT');
check('it carries its three parameters', analytes.length === 3, `${analytes.length}`);

const reading = (date, hb, wb, pl) => ({
  runDate: date,
  runTime: '08:15',
  readings: [{ analyteId: hgb.id, value: hb }, { analyteId: wbc.id, value: wb }, { analyteId: plt.id, value: pl }],
});

/* ========================================================================
   A set of runs, each on its own day
   ===================================================================== */
section('Several runs in one entry');
const batch = await j('/iqc/runs/batch', {
  token: A, method: 'POST',
  body: {
    iqcMaterialId: materialId,
    runs: [reading(day(9), 13.5, 7.2, 250), reading(day(8), 13.6, 7.1, 248), reading(day(7), 13.4, 7.3, 252)],
  },
});
check('three runs are recorded in one entry', batch.status === 201 && batch.json?.recorded === 3,
  `${batch.status} ${JSON.stringify(batch.json)?.slice(0, 200)}`);
check('each gets a run number of its own',
  new Set((batch.json?.runs ?? []).map(r => r.runNumber)).size === 3,
  JSON.stringify(batch.json?.runs?.map(r => r.runNumber)));
check('each keeps the day it was run',
  (batch.json?.runs ?? []).map(r => r.runDate).join(',') === [day(9), day(8), day(7)].join(','),
  JSON.stringify(batch.json?.runs?.map(r => r.runDate)));
check('every one of them is in control', (batch.json?.runs ?? []).every(r => r.status === 'in_control'),
  JSON.stringify(batch.json?.runs?.map(r => r.status)));

const register = (await j(`/iqc/runs?materialId=${materialId}`, { token: A })).json ?? [];
check('the register holds all three', register.length === 3, `${register.length}`);
check('they are filed under their own dates, not today',
  register.every(r => r.run_date !== day(0)), JSON.stringify(register.map(r => r.run_date)));

/* ========================================================================
   The rules read the set in order
   ===================================================================== */
section('A trend entered in one sitting is still a trend');
// Two consecutive runs beyond +2 SD on the same side is 2₂ₛ. Entered as a set,
// the second must see the first — which only holds if the batch is evaluated
// oldest first, against what it has already written.
const trend = await j('/iqc/runs/batch', {
  token: A, method: 'POST',
  body: {
    iqcMaterialId: materialId,
    runs: [reading(day(6), 14.45, 7.2, 250), reading(day(5), 14.45, 7.2, 250)],
  },
});
const second = (trend.json?.runs ?? [])[1];
check('the second run beyond 2 SD is caught as 2₂ₛ',
  String(second?.ruleSummary ?? '').includes('2₂ₛ'),
  JSON.stringify(trend.json?.runs?.map(r => r.ruleSummary)));
check('and it withholds patient results', second?.mayReleasePatientResults === false);
check('the entry reports how many failed', trend.json?.rejected === 1, JSON.stringify(trend.json?.rejected));

/* ========================================================================
   What a set refuses
   ===================================================================== */
section('What a set refuses, and what it still records');
const mixed = await j('/iqc/runs/batch', {
  token: A, method: 'POST',
  body: {
    iqcMaterialId: materialId,
    runs: [
      reading(day(4), 13.5, 7.2, 250),
      { runDate: day(3), readings: [] },
      { runDate: day(-2), readings: [{ analyteId: hgb.id, value: 13.5 }] },
      { runTime: '09:00', readings: [{ analyteId: hgb.id, value: 13.5 }] },
    ],
  },
});
check('the run that could be recorded is recorded', mixed.json?.recorded === 1, JSON.stringify(mixed.json?.recorded));
check('a run with no reading is refused by name',
  (mixed.json?.refused ?? []).some(r => r.reason.includes('No readings')), JSON.stringify(mixed.json?.refused));
check('a run dated in the future is refused',
  (mixed.json?.refused ?? []).some(r => r.reason.includes('future')), JSON.stringify(mixed.json?.refused));
check('a run with no date is refused',
  (mixed.json?.refused ?? []).some(r => r.reason.includes('no day')), JSON.stringify(mixed.json?.refused));

const empty = await j('/iqc/runs/batch', { token: A, method: 'POST', body: { iqcMaterialId: materialId, runs: [] } });
check('an empty entry is refused', empty.status === 400, `${empty.status}`);
const none = await j('/iqc/runs/batch', {
  token: A, method: 'POST',
  body: { iqcMaterialId: materialId, runs: [{ runDate: day(2), readings: [] }] },
});
check('an entry where nothing can be recorded is refused outright', none.status === 400, `${none.status}`);
const unknown = await j('/iqc/runs/batch', {
  token: A, method: 'POST', body: { iqcMaterialId: 999999, runs: [reading(day(2), 13.5, 7.2, 250)] },
});
check('an unknown control is refused', unknown.status === 404, `${unknown.status}`);

/* ========================================================================
   One intake for every transmission
   ===================================================================== */
section('A transmission posted to a feed is recorded like any other');
const feed = await j('/iqc/portal/feeds', {
  token: A, method: 'POST',
  body: { name: `Bulk check feed ${stamp}`, transport: 'http_post', protocol: 'astm', controlIdPatterns: [LOT] },
});
const feedId = feed.json?.id;
check('a feed can be registered', (feed.status === 201 || feed.status === 200) && Boolean(feedId),
  `${feed.status} ${JSON.stringify(feed.json)?.slice(0, 160)}`);

const posted = [];
for (const [index, values] of [[13.5, 7.2, 250], [13.7, 7.0, 244], [13.3, 7.4, 256]].entries()) {
  const message = await j(`/iqc/portal/feeds/${feedId}/messages`, {
    token: A, method: 'POST',
    body: {
      sampleId: `QC1-${stamp}-${index}`, lotNumber: LOT,
      runAt: `${day(index + 12)} 07:${30 + index}:00`,
      raw: `control run ${index}`,
      values: [
        { code: 'HGB', analyte: 'HGB', value: values[0], unit: 'g/dL' },
        { code: 'WBC', analyte: 'WBC', value: values[1], unit: '10*3/uL' },
        { code: 'PLT', analyte: 'PLT', value: values[2], unit: '10*3/uL' },
      ],
    },
  });
  posted.push(message.json);
}
check('each posted transmission is matched to the control',
  posted.every(m => m?.matched === true), JSON.stringify(posted.map(m => m?.matched)));
check('and each is recorded verbatim as a transmission of its own',
  posted.every(m => Number(m?.instrumentMessageId) > 0), JSON.stringify(posted.map(m => m?.instrumentMessageId)));
check('the ids are distinct', new Set(posted.map(m => m?.instrumentMessageId)).size === 3);

/* ========================================================================
   Selecting several transmissions, and recording them as runs
   ===================================================================== */
section('Several transmissions, read in one request and recorded as runs');
const ids = posted.map(m => m.id);
const mapped = await j(`/iqc/portal/feed-messages/mapping?materialId=${materialId}&ids=${ids.join(',')}`, { token: A });
const mappings = mapped.json?.mappings ?? [];
check('every selected transmission is lined up against the control', mappings.length === 3, `${mappings.length}`);
check('all three parameters are matched on each', mappings.every(m => m.matched === 3),
  JSON.stringify(mappings.map(m => m.matched)));
check('each carries the moment the analyser ran it',
  mappings.every(m => Boolean(m.message?.instrument_run_at)),
  JSON.stringify(mappings.map(m => m.message?.instrument_run_at)));

const fromTransmissions = await j('/iqc/runs/batch', {
  token: A, method: 'POST',
  body: {
    iqcMaterialId: materialId,
    runs: mappings.map(m => ({
      runDate: String(m.message.instrument_run_at).slice(0, 10),
      runTime: String(m.message.instrument_run_at).slice(11, 16),
      feedMessageId: m.message.id,
      readings: m.readings.map(r => ({ analyteId: r.analyteId, value: r.value })),
    })),
  },
});
check('the selection is recorded as three runs', fromTransmissions.json?.recorded === 3,
  JSON.stringify(fromTransmissions.json)?.slice(0, 200));
check('each run is tied to the transmission it was read off',
  (fromTransmissions.json?.runs ?? []).every(r => Number(r.feedMessageId) > 0),
  JSON.stringify(fromTransmissions.json?.runs?.map(r => r.feedMessageId)));

const after = (await j(`/iqc/portal/transmissions?materialId=${materialId}&state=accepted`, { token: A })).json;
check('and the transmissions are accounted for as accepted',
  (after?.rows ?? []).length >= 3, JSON.stringify(after?.total));

/* ========================================================================
   The Result Filler, on a control run entry form
   ===================================================================== */
section('The Result Filler fills a control run form');
const device = await j('/result-filler/devices', {
  token: A, method: 'POST', body: { label: `Bulk check bench ${stamp}`, location: 'Check' },
});
const DEVICE = (await j('/result-filler/enrol', { method: 'POST', body: { pairingCode: device.json?.pairingCode } })).json?.token;
check('a browser can be enrolled', Boolean(DEVICE));

const adapters = (await j('/result-filler/adapters', { token: A })).json ?? [];
const control = adapters.find(a => a.adapterCode === 'SECHLIMS-IQC');
const bench = adapters.find(a => a.adapterCode === 'SECHLIMS-IQC-BENCH');
check('the control run entry form ships as a form the filler knows', Boolean(control));
check('and so does the bench’s copy of it', Boolean(bench));
check('both fill from control runs only',
  control?.messageKind === 'control' && bench?.messageKind === 'control',
  `${control?.messageKind} / ${bench?.messageKind}`);

const verified = await j('/result-filler/verify', {
  token: A, device: DEVICE,
  method: 'POST',
  body: {
    adapterCode: 'SECHLIMS-IQC',
    url: 'http://127.0.0.1/iqc',
    detectedIdentifiers: [{ kind: 'control', label: 'Control lot', value: LOT, source: 'declared', confidence: 100 }],
    detectedFields: [
      { index: 0, label: 'HGB', unit: 'g/dL', current: '' },
      { index: 1, label: 'WBC', unit: '10*3/uL', current: '' },
      { index: 2, label: 'PLT', unit: '10*3/uL', current: '' },
    ],
  },
});
check('the control lot verifies against the control transmissions',
  verified.json?.status === 'verified' && verified.json?.mayFill === true,
  `${verified.status} ${JSON.stringify(verified.json?.summary)?.slice(0, 200)}`);
check('it says which identifier it was recognised by',
  verified.json?.matchedOn?.kind === 'control' && verified.json?.matchedOn?.value === LOT,
  JSON.stringify(verified.json?.matchedOn));
check('the transmissions offered are control runs',
  (verified.json?.transmissions ?? []).every(t => t.kind === 'control'),
  JSON.stringify(verified.json?.transmissions?.map(t => t.kind)));

const plan = await j('/result-filler/populate', {
  token: A, device: DEVICE,
  method: 'POST',
  body: {
    adapterCode: 'SECHLIMS-IQC',
    url: 'http://127.0.0.1/iqc',
    detectedIdentifiers: [{ kind: 'control', label: 'Control lot', value: LOT, source: 'declared', confidence: 100 }],
    detectedFields: [
      { index: 0, label: 'HGB', unit: 'g/dL', current: '' },
      { index: 1, label: 'WBC', unit: '10*3/uL', current: '' },
      { index: 2, label: 'PLT', unit: '10*3/uL', current: '' },
    ],
  },
});
check('a plan fills the control’s own parameters',
  plan.status === 200 && (plan.json?.assignments ?? []).length === 3,
  `${plan.status} ${JSON.stringify(plan.json)?.slice(0, 220)}`);
check('and the fill is on the record as issued', Boolean(plan.json?.fillUid));

/* A patient form must never be filled from a control run. */
const patientForm = await j('/result-filler/adapters', {
  token: A, method: 'POST',
  body: {
    adapterCode: `PAT-${stamp}`, name: `Patient form ${stamp}`, platform: 'lis',
    urlPattern: '*patient-check*', urlMatchMode: 'glob', formSelector: 'table.check',
    identifiers: [{ kind: 'sample', selectorKind: 'name', selector: 'specimen_id', primary: true }],
    normaliser: 'alnum', overwritePolicy: 'never', lookbackHours: 24 * 30,
    messageKind: 'patient', matchByLabel: true,
  },
});
const refusedFill = await j('/result-filler/verify', {
  token: A, device: DEVICE,
  method: 'POST',
  body: {
    adapterCode: patientForm.json?.adapterCode,
    url: 'http://127.0.0.1/patient-check',
    identifiers: { sample: LOT },
    detectedFields: [{ index: 0, label: 'HGB', unit: 'g/dL', current: '' }],
  },
});
check('a patient form is NOT filled from a control run',
  refusedFill.json?.mayFill !== true,
  `${refusedFill.json?.status} ${JSON.stringify(refusedFill.json?.summary)?.slice(0, 160)}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
