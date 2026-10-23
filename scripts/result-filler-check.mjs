/**
 * The Result Filler over HTTP: enrolment, verification and the refusals.
 *
 * What this establishes, in the order the extension does it:
 *
 *   A browser cannot ask for anything until an administrator has enrolled it,
 *   and a pairing code works once.
 *   A verified identifier produces a plan; an unknown one, an ambiguous one,
 *   and one contradicted by the record produce no values at all.
 *   A near match is refused until the person has confirmed it.
 *   A second fill of the same transmission is reported as already entered.
 *   A revoked browser is refused immediately.
 *   A transmitted result renders as a report, and exports as Word and Excel.
 *
 *   npm run api          (in one terminal)
 *   node scripts/result-filler-check.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.API || 'http://127.0.0.1:4431/api';
const WATCH = process.env.RF_WATCH || '/tmp/rf-check';
const PW = 'Passw0rd!test';

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};
const section = name => console.log(`\n${name}\n${'-'.repeat(name.length)}`);

const j = async (path, options = {}) => {
  const headers = { 'Content-Type': 'application/json' };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.device) headers['x-sechlims-device'] = options.device;
  const response = await fetch(`${BASE}${path}`, {
    method: options.method || 'GET', headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: response.status, json, text };
};

/* -------------------------------------------------------------- sign in */
mkdirSync(WATCH, { recursive: true });

const status = await j('/setup/status');
if (!status.json?.setupComplete) {
  await j('/setup/initialize', {
    method: 'POST',
    body: { facilityName: 'Result Filler Test Laboratory', username: 'admin', password: PW, fullName: 'Admin User' },
  });
}
const ADMIN = (await j('/auth/login', { method: 'POST', body: { username: 'admin', password: PW } })).json?.token;
if (!ADMIN) {
  console.error(`Could not sign in — is the API running on ${BASE}?`);
  process.exit(1);
}
const stamp = Date.now().toString(36).toUpperCase();

/* ------------------------------------------------- a transmission to fill */
section('A transmission on the record');
const link = await j('/instrument-links', {
  method: 'POST', token: ADMIN,
  body: { name: `RF check analyser ${stamp}`, mode: 'file_drop', protocol: 'astm', role: 'sechlims_only', watchPath: WATCH },
});
const linkId = link.json?.id ?? link.json?.link?.id ?? null;
check('an analyser link can be created for the check', Boolean(linkId), JSON.stringify(link.json)?.slice(0, 160));

/**
 * The real path, not a simulation: a file the analyser wrote, read by the
 * bridge. The filler is deliberately blind to simulated messages — a test
 * transmission must never be fillable into a patient's form — so a check that
 * simulated one would prove the opposite of what it set out to.
 */
const SAMPLE = `RF${stamp}`;
writeFileSync(join(WATCH, `${SAMPLE}.txt`), [
  'H|\\^&|||XN-550^1|||||||P|1',
  `P|1||${SAMPLE}P||CHECK^PATIENT||19900101|M`,
  `O|1|${SAMPLE}||^^^WBC|R||||||||||||||||||F`,
  'R|1|^^^^WBC^1|7.42|10*3/uL||N||F',
  'R|2|^^^^HGB^3|13.8|g/dL||N||F',
  'R|3|^^^^PLT^8|232|10*3/uL||N||F',
  'L|1|N',
].join('\r'));

// The bridge leaves a file alone for two seconds in case it is still being
// written, so the check waits with it rather than racing it.
await new Promise(resolve => setTimeout(resolve, 2_600));
const fetched = await j(`/instrument-links/${linkId}/fetch`, { method: 'POST', token: ADMIN, body: {} });
check('the bridge reads the transmission out of the folder', fetched.status === 200,
  JSON.stringify(fetched.json)?.slice(0, 200));
await new Promise(resolve => setTimeout(resolve, 600));

/* --------------------------------------------------------------- the form */
section('A form the extension knows');
const adapter = await j('/result-filler/adapters', {
  method: 'POST', token: ADMIN,
  body: {
    adapterCode: `CHK-${stamp}`.slice(0, 20),
    name: `Check form ${stamp}`,
    platform: 'lis',
    urlPattern: '*check-form*',
    urlMatchMode: 'glob',
    formSelector: 'table.check',
    identifiers: [{ kind: 'sample', selectorKind: 'name', selector: 'specimen_id', primary: true }],
    normaliser: 'alnum',
    overwritePolicy: 'confirm',
    lookbackHours: 72,
    messageKind: 'patient',
    matchByLabel: true,
  },
});
const adapterCode = adapter.json?.adapterCode;
check('a form adapter can be added', adapter.status === 201 && Boolean(adapterCode), JSON.stringify(adapter.json)?.slice(0, 160));

/* ------------------------------------------------------------- the browser */
section('Enrolling a browser');
const noDevice = await j('/result-filler/verify', {
  method: 'POST', token: ADMIN, body: { adapterCode, identifiers: { sample: SAMPLE } },
});
check('a browser that is not enrolled is refused', noDevice.status === 401 && noDevice.json?.code === 'device_missing',
  `${noDevice.status} ${JSON.stringify(noDevice.json)?.slice(0, 120)}`);

const device = await j('/result-filler/devices', {
  method: 'POST', token: ADMIN, body: { label: `Check bench ${stamp}`, location: 'Check' },
});
const pairingCode = device.json?.pairingCode;
check('a pairing code is issued', device.status === 201 && Boolean(pairingCode));

const enrolled = await j('/result-filler/enrol', { method: 'POST', body: { pairingCode } });
const DEVICE = enrolled.json?.token;
check('the pairing code enrols the browser', enrolled.status === 200 && Boolean(DEVICE));

const reuse = await j('/result-filler/enrol', { method: 'POST', body: { pairingCode } });
check('the same pairing code cannot be used twice', reuse.status === 400, `${reuse.status}`);

const badCode = await j('/result-filler/enrol', { method: 'POST', body: { pairingCode: 'ZZZZ-ZZZZ' } });
check('an unknown pairing code is refused', badCode.status === 400);

/* ------------------------------------------------------------ verification */
section('Verifying an identifier');
const verified = await j('/result-filler/verify', {
  method: 'POST', token: ADMIN, device: DEVICE,
  body: { adapterCode, identifiers: { sample: SAMPLE }, url: 'https://example.test/check-form', title: 'Check' },
});
check('a known identifier verifies', verified.json?.status === 'verified' && verified.json?.mayFill === true,
  JSON.stringify(verified.json)?.slice(0, 220));
check('the transmission comes back with its parameters', (verified.json?.transmissions?.[0]?.readings?.length ?? 0) >= 3);

const unknown = await j('/result-filler/verify', {
  method: 'POST', token: ADMIN, device: DEVICE,
  body: { adapterCode, identifiers: { sample: `NOPE${stamp}` } },
});
check('an unknown identifier is not found and cannot fill', unknown.json?.status === 'not_found' && unknown.json?.mayFill === false);

const missing = await j('/result-filler/verify', {
  method: 'POST', token: ADMIN, device: DEVICE, body: { adapterCode, identifiers: {} },
});
check('no identifier means no fill', missing.json?.status === 'no_identifier' && missing.json?.mayFill === false);

const contradicted = await j('/result-filler/verify', {
  method: 'POST', token: ADMIN, device: DEVICE,
  body: { adapterCode, identifiers: { sample: SAMPLE, patient: 'SOMEONE-ELSE-9999' } },
});
check('a contradicting patient identifier blocks the fill',
  contradicted.json?.status === 'blocked' && contradicted.json?.mayFill === false,
  JSON.stringify(contradicted.json)?.slice(0, 200));

const near = await j('/result-filler/verify', {
  method: 'POST', token: ADMIN, device: DEVICE,
  body: { adapterCode, identifiers: { sample: SAMPLE.slice(2) } },
});
check('a partial identifier is a near match, not a match', near.json?.status === 'near_match',
  JSON.stringify(near.json)?.slice(0, 200));

/* ------------------------------------------------------------- the filling */
section('Issuing a plan');
const refusedPlan = await j('/result-filler/populate', {
  method: 'POST', token: ADMIN, device: DEVICE, body: { adapterCode, identifiers: { sample: `NOPE${stamp}` } },
});
check('no plan is issued for an identifier that did not verify', refusedPlan.status === 409);

const unconfirmed = await j('/result-filler/populate', {
  method: 'POST', token: ADMIN, device: DEVICE, body: { adapterCode, identifiers: { sample: SAMPLE.slice(2) } },
});
check('a near match is refused until it is confirmed', unconfirmed.status === 409 && unconfirmed.json?.needsConfirmation === true);

const plan = await j('/result-filler/populate', {
  method: 'POST', token: ADMIN, device: DEVICE,
  body: { adapterCode, identifiers: { sample: SAMPLE }, url: 'https://example.test/check-form', title: 'Check' },
});
check('a verified identifier produces a plan', plan.status === 200 && (plan.json?.fields?.length ?? 0) >= 3,
  JSON.stringify(plan.json)?.slice(0, 220));
check('the plan carries the values as received',
  plan.json?.fields?.some(f => f.sourceCode === 'WBC' && f.value === '7.42'),
  JSON.stringify(plan.json?.fields)?.slice(0, 220));
check('the plan says what to do about a field that already has a value',
  plan.json?.overwritePolicy === 'confirm');

const outcome = await j('/result-filler/outcome', {
  method: 'POST', token: ADMIN, device: DEVICE,
  body: { fillUid: plan.json?.fillUid, filled: plan.json?.fields?.length ?? 0, skipped: 0, overwritten: 0 },
});
check('the outcome is recorded', outcome.status === 200 && outcome.json?.state === 'applied');

const again = await j('/result-filler/verify', {
  method: 'POST', token: ADMIN, device: DEVICE, body: { adapterCode, identifiers: { sample: SAMPLE } },
});
check('a second fill of the same transmission is flagged as already entered', again.json?.status === 'already_entered',
  JSON.stringify(again.json)?.slice(0, 200));

const activity = await j('/result-filler/activity', { token: ADMIN });
check('the fill is on the record', (activity.json?.rows ?? []).some(row => row.identifier === SAMPLE));

/* ------------------------------------------------------------- withdrawal */
section('Revoking a browser');
const deviceId = device.json?.id;
await j(`/result-filler/devices/${deviceId}/revoke`, { method: 'POST', token: ADMIN, body: { reason: 'Check' } });
const afterRevoke = await j('/result-filler/verify', {
  method: 'POST', token: ADMIN, device: DEVICE, body: { adapterCode, identifiers: { sample: SAMPLE } },
});
check('a revoked browser is refused at once', afterRevoke.status === 403 && afterRevoke.json?.code === 'device_revoked',
  `${afterRevoke.status}`);

/* ----------------------------------------------------------- the report */
section('The report a transmission prints as');
const register = await j(`/transmission-reports?search=${encodeURIComponent(SAMPLE)}`, { token: ADMIN });
const reportId = register.json?.rows?.[0]?.id;
check('the transmission appears in the report register', Boolean(reportId), JSON.stringify(register.json)?.slice(0, 180));

const report = await j(`/transmission-reports/${reportId}`, { token: ADMIN });
check('the report carries the parameters as transmitted',
  (report.json?.report?.parameters ?? []).some(p => p.code === 'HGB' && p.value === '13.8'));
check('the demographics are read back out of the transmission',
  report.json?.report?.demographics?.patientName?.includes('CHECK'),
  JSON.stringify(report.json?.report?.demographics)?.slice(0, 160));

const printed = await j(`/transmission-reports/${reportId}/print`, { token: ADMIN });
check('the report renders as a page', printed.status === 200 && printed.text.includes('<table class="results"'));
check('the printed report shows the sample', printed.text.includes(SAMPLE));

const saved = await j('/transmission-reports/templates/DEFAULT', {
  method: 'PUT', token: ADMIN,
  body: { name: 'Check template', organisation: 'CHECK HEALTH SERVICE', reportTitle: 'HAEMATOLOGY REPORT', paper: 'A4' },
});
check('the report design can be saved', saved.status === 200 && saved.json?.organisation === 'CHECK HEALTH SERVICE');

const restyled = await j(`/transmission-reports/${reportId}/print`, { token: ADMIN });
check('the saved design is used', restyled.text.includes('CHECK HEALTH SERVICE') && restyled.text.includes('HAEMATOLOGY REPORT'));

const docx = await fetch(`${BASE}/transmission-reports/export.docx?ids=${reportId}`, { headers: { Authorization: `Bearer ${ADMIN}` } });
const docxBytes = Buffer.from(await docx.arrayBuffer());
check('the report exports as Word', docx.status === 200 && docxBytes.length > 2_000 && docxBytes.subarray(0, 2).toString() === 'PK');

const xlsx = await fetch(`${BASE}/transmission-reports/export.xlsx?ids=${reportId}`, { headers: { Authorization: `Bearer ${ADMIN}` } });
const xlsxBytes = Buffer.from(await xlsx.arrayBuffer());
check('the report exports as Excel', xlsx.status === 200 && xlsxBytes.length > 2_000 && xlsxBytes.subarray(0, 2).toString() === 'PK');

/* ------------------------------------------------------------ the package */
section('The extension package');
const zip = await fetch(`${BASE}/result-filler/package`, { headers: { Authorization: `Bearer ${ADMIN}` } });
const zipBytes = Buffer.from(await zip.arrayBuffer());
check('the extension downloads as a zip', zip.status === 200 && zipBytes.subarray(0, 2).toString() === 'PK' && zipBytes.length > 8_000,
  `${zip.status} ${zipBytes.length} bytes`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
