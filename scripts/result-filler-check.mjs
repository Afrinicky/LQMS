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
  // A parameter no laboratory holds a range for, so the report has something
  // to print a dash against whatever else has been set.
  'R|4|^^^^ZZUNKNOWN^99|1.23|u||N||F',
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

/*
 * The transmission was given the patient identifier `<sample>P`. A DIFFERENT
 * identifier of the same shape is another patient from the same series, and
 * filling one patient's results into another's form is the error this whole
 * tool exists to prevent.
 */
const contradicted = await j('/result-filler/verify', {
  method: 'POST', token: ADMIN, device: DEVICE,
  body: { adapterCode, identifiers: { sample: SAMPLE, patient: `${SAMPLE}Q` } },
});
check('a patient identifier of the same shape that disagrees blocks the fill',
  contradicted.json?.status === 'blocked' && contradicted.json?.mayFill === false,
  JSON.stringify(contradicted.json)?.slice(0, 200));

// A folder number and a laboratory number are different kinds of number, and
// a hospital routinely holds both. That is a warning, not a refusal.
const otherKind = await j('/result-filler/verify', {
  method: 'POST', token: ADMIN, device: DEVICE,
  body: { adapterCode, identifiers: { sample: SAMPLE, patient: 'UW-A11-AAB2287' } },
});
check('a patient identifier of another kind does not block it',
  otherKind.json?.status === 'verified' && otherKind.json?.mayFill === true,
  JSON.stringify(otherKind.json?.summary)?.slice(0, 160));

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

/* ===================================================== a page that was READ */
/**
 * What the extension sends when it has read a page rather than been configured
 * for one: every identifier it found, with how it found it, and every
 * parameter the form is asking for under the label printed beside it.
 *
 * The labels below are transcribed from LHIMS result-entry pages — the
 * required marker, the previous value and the method note included — so what
 * is proved here is the matching a real page actually demands.
 */
section('A page the extension read for itself');

const LHIMS = await j('/result-filler/adapters', {
  method: 'POST', token: ADMIN,
  body: {
    adapterCode: `SCAN-${stamp}`.slice(0, 20),
    name: `Scanned form ${stamp}`,
    platform: 'lhims',
    urlPattern: '*PathologyServiceTemplate*',
    urlMatchMode: 'glob',
    identifiers: [],
    normaliser: 'alnum',
    overwritePolicy: 'confirm',
    lookbackHours: 72,
    messageKind: 'patient',
  },
});
const scanAdapter = LHIMS.json?.adapterCode;

const DEVICE2 = (await j('/result-filler/enrol', {
  method: 'POST',
  body: {
    pairingCode: (await j('/result-filler/devices', {
      method: 'POST', token: ADMIN, body: { label: `Scan bench ${stamp}` },
    })).json?.pairingCode,
  },
})).json?.token;

/*
 * A second transmission, because the first has already been filled into a form
 * by the section above and a sample filled once verifies as "already entered".
 */
const SCAN_SAMPLE = `SC${stamp}`;
writeFileSync(join(WATCH, `${SCAN_SAMPLE}.txt`), [
  'H|\\^&|||XN-550^1|||||||P|1',
  `P|1||AAJ7447||SORPIITEY^KUUIREMAH||20200809|M`,
  `O|1|${SCAN_SAMPLE}||^^^FBC|R||||||||||||||||||F`,
  'R|1|^^^^WBC^1|7.42|10*3/uL||N||F',
  'R|2|^^^^HGB^3|13.8|g/dL||N||F',
  'R|3|^^^^NEUT#^8|2.50|10*3/uL||N||F',
  'R|4|^^^^NEUT%^12|52.1|%||N||F',
  'L|1|N',
].join('\r'));
await new Promise(resolve => setTimeout(resolve, 2_600));
await j(`/instrument-links/${linkId}/fetch`, { method: 'POST', token: ADMIN, body: {} });

const field = (index, label, unit = null) => ({ index, label, unit, referenceText: null, current: '', kind: 'text' });
const FBC_FIELDS = [
  'WBC *', 'RBC*', 'HGB*', 'HCT*', 'MCV*', 'MCH*', 'MCHC*', 'RDW-SD*', 'RDW-CV*', 'PDW*',
  'MPV* (Laser Flowcytometry) 0', 'P-LCR*', 'PCT*', 'NEUT#*', 'LYMPH#*', 'MONO#*', 'EO#*', 'BASO#*',
  'NEUT%*', 'LYMPH%*', 'MONO%*', 'EO%*', 'BASO%*', 'IG#*', 'IG%*', 'RET#*', 'RET%*',
  'IRF*', 'LFR*', 'MFR*', 'HFR*', 'RET-He*', 'PLT *',
].map((label, index) => field(index, label));

const scanned = await j('/result-filler/verify', {
  method: 'POST', token: ADMIN, device: DEVICE2,
  body: {
    adapterCode: scanAdapter,
    url: 'http://10.0.0.5/lhims_193/draftPathologyServiceTemplate.php?iServiceID=107',
    title: 'LHIMS : Draft',
    detectedIdentifiers: [
      { kind: 'sample', label: 'Sample Barcode', value: SCAN_SAMPLE, source: 'header', confidence: 100 },
      { kind: 'patient', label: '', value: 'UW-A11-AAB2287', source: 'shape', confidence: 58 },
      { kind: 'patient', label: 'NHIA No.', value: '29366816', source: 'caption', confidence: 41 },
    ],
    detectedFields: FBC_FIELDS,
  },
});
check('an identifier read out of a table cell verifies', scanned.json?.status === 'verified',
  JSON.stringify(scanned.json).slice(0, 200));
check('the answer says which of the page\u2019s identifiers it used',
  scanned.json?.matchedOn?.value === SCAN_SAMPLE && scanned.json?.matchedOn?.label === 'Sample Barcode',
  JSON.stringify(scanned.json?.matchedOn));
check('the ones it did not use are listed as tried', (scanned.json?.tried ?? []).length >= 1);
check('the scan is summarised back', (scanned.json?.scan?.fields ?? 0) === FBC_FIELDS.length
  && (scanned.json?.scan?.recognised ?? 0) >= 30,
  JSON.stringify(scanned.json?.scan));

/**
 * A folder number and a laboratory number are different KINDS of number, so
 * their disagreeing is not evidence of a wrong patient — this hospital's own
 * pages prove it. Two numbers of the same shape disagreeing is.
 */
check('a patient number of another kind warns rather than blocks',
  scanned.json?.status === 'verified'
  && (scanned.json?.warnings ?? []).some(w => /different kinds of number/i.test(w)),
  JSON.stringify(scanned.json?.warnings));

const sameShape = await j('/result-filler/verify', {
  method: 'POST', token: ADMIN, device: DEVICE2,
  body: {
    adapterCode: scanAdapter,
    detectedIdentifiers: [
      { kind: 'sample', label: 'Sample Barcode', value: SCAN_SAMPLE, source: 'header', confidence: 100 },
      { kind: 'patient', label: 'Patient ID', value: 'AAJ9999', source: 'caption', confidence: 60 },
    ],
    detectedFields: FBC_FIELDS,
  },
});
check('a patient number of the SAME shape that disagrees blocks the fill',
  sameShape.json?.status === 'blocked' && sameShape.json?.mayFill === false,
  JSON.stringify(sameShape.json?.summary));

const scanPlan = await j('/result-filler/populate', {
  method: 'POST', token: ADMIN, device: DEVICE2,
  body: {
    adapterCode: scanAdapter,
    detectedIdentifiers: [{ kind: 'sample', label: 'Sample Barcode', value: SCAN_SAMPLE, source: 'header', confidence: 100 }],
    detectedFields: FBC_FIELDS,
    url: 'http://10.0.0.5/lhims_193/draftPathologyServiceTemplate.php?iServiceID=107',
  },
});
check('a plan is built from what the page asked for', scanPlan.status === 200 && scanPlan.json?.mode === 'detected',
  JSON.stringify(scanPlan.json).slice(0, 200));

const placed = Object.fromEntries((scanPlan.json?.assignments ?? []).map(a => [a.fieldLabel, a.value]));
check('WBC went to the WBC box', placed['WBC'] === '7.42', JSON.stringify(placed).slice(0, 200));
check('an absolute and a percentage both landed, each in its own box',
  placed['NEUT#'] === '2.50' && placed['NEUT%'] === '52.1', JSON.stringify(placed));
check('nothing was put in a box the analyser sent nothing for',
  (scanPlan.json?.assignments ?? []).length === 4, `${(scanPlan.json?.assignments ?? []).length} assignment(s)`);

/* ---- the distinction that matters most ------------------------------- */
const DIFFERENTIAL = [
  field(0, 'NEUT#*'), field(1, 'NEUT%*'), field(2, 'LYMPH#*'), field(3, 'LYMPH%*'),
];
const diffPlan = await j('/result-filler/populate', {
  method: 'POST', token: ADMIN, device: DEVICE2,
  body: {
    adapterCode: scanAdapter,
    detectedIdentifiers: [{ kind: 'sample', label: 'Sample Barcode', value: SCAN_SAMPLE, source: 'header', confidence: 100 }],
    detectedFields: DIFFERENTIAL,
    confirmed: true,
  },
});
const pairs = Object.fromEntries((diffPlan.json?.assignments ?? []).map(a => [a.sourceCode, a.fieldLabel]));
check('an absolute count and a percentage each went to their own box',
  pairs['NEUT#'] === 'NEUT#' && pairs['NEUT%'] === 'NEUT%',
  JSON.stringify(pairs));
check('and a form offering only the absolute takes only the absolute',
  (await j('/result-filler/populate', {
    method: 'POST', token: ADMIN, device: DEVICE2,
    body: {
      adapterCode: scanAdapter,
      detectedIdentifiers: [{ kind: 'sample', label: 'Sample Barcode', value: SCAN_SAMPLE, source: 'header', confidence: 100 }],
      detectedFields: [field(0, 'NEUT#*')],
      confirmed: true,
    },
  })).json?.assignments?.every(a => a.sourceCode === 'NEUT#'));

/* ---- chemistry, where the two systems share no vocabulary ------------- */
section('Chemistry, where the analyser and the form share no words');

const CHEM_SAMPLE = `CH${stamp}`;
writeFileSync(join(WATCH, `${CHEM_SAMPLE}.txt`), [
  'H|\\^&|||SELECTRA^1|||||||P|1',
  `P|1||CH${stamp}P||CHECK^CHEMISTRY||19700101|F`,
  `O|1|${CHEM_SAMPLE}||^^^LFT|R||||||||||||||||||F`,
  ['NA|139|mmol/L', 'K|4.2|mmol/L', 'CL|101|mmol/L', 'CREA|78|umol/L', 'BUN|4.9|mmol/L',
   'ALB|41.2|g/L', 'TP|71.0|g/L', 'SGPT|28|U/L', 'SGOT|31|U/L', 'GGT|22|U/L',
   'TBIL|12.4|umol/L', 'DBIL|3.1|umol/L', 'ALP|88|U/L', 'GLU|5.4|mmol/L',
  ].map((row, i) => {
    const [code, value, unit] = row.split('|');
    return `R|${i + 1}|^^^^${code}^${i + 1}|${value}|${unit}||N||F`;
  }).join('\r'),
  'L|1|N',
].join('\r'));
await new Promise(resolve => setTimeout(resolve, 2_600));
await j(`/instrument-links/${linkId}/fetch`, { method: 'POST', token: ADMIN, body: {} });

const LFT_FIELDS = [
  'ALBUMIN*', 'TOTAL PROTEIN*', 'Alanine Aminotransferase (ALT)*', 'Aspartate Aminotransferase (AST)*',
  'Gamma Glutamyltransferase (GGT)*', 'TOTAL BILIRUBIN*', 'DIRECT BILIRUBIN*', 'INDIRECT BILIRUBIN*',
  'Alkaline Phosphatase*',
].map((label, index) => field(index, label));

const lft = await j('/result-filler/populate', {
  method: 'POST', token: ADMIN, device: DEVICE2,
  body: {
    adapterCode: scanAdapter,
    detectedIdentifiers: [{ kind: 'sample', label: 'Sample Barcode', value: CHEM_SAMPLE, source: 'header', confidence: 100 }],
    detectedFields: LFT_FIELDS,
    url: 'http://10.0.0.5/lhims_193/updatePathologyServiceTemplate.php?iConsultationID=678391',
  },
});
const lftPlaced = Object.fromEntries((lft.json?.assignments ?? []).map(a => [a.fieldLabel, `${a.sourceCode}=${a.value}`]));
check('SGPT reached “Alanine Aminotransferase (ALT)”', lftPlaced['Alanine Aminotransferase (ALT)'] === 'SGPT=28',
  JSON.stringify(lftPlaced));
check('SGOT reached “Aspartate Aminotransferase (AST)”', lftPlaced['Aspartate Aminotransferase (AST)'] === 'SGOT=31');
check('GGT reached “Gamma Glutamyltransferase (GGT)”', lftPlaced['Gamma Glutamyltransferase (GGT)'] === 'GGT=22');
check('ALB reached ALBUMIN and TP reached TOTAL PROTEIN',
  lftPlaced['ALBUMIN'] === 'ALB=41.2' && lftPlaced['TOTAL PROTEIN'] === 'TP=71.0');
check('TBIL and DBIL were told apart',
  lftPlaced['TOTAL BILIRUBIN'] === 'TBIL=12.4' && lftPlaced['DIRECT BILIRUBIN'] === 'DBIL=3.1');
check('INDIRECT BILIRUBIN was left empty, the analyser having sent none',
  !lftPlaced['INDIRECT BILIRUBIN']);
check('ALP reached Alkaline Phosphatase', lftPlaced['Alkaline Phosphatase'] === 'ALP=88');

const BUE_FIELDS = ['UREA*', 'CREATININE*', 'SODIUM*', 'POTASSIUM*', 'CHLORIDE*', 'CALCIUM*', 'PH*', 'Ionized Calcium*']
  .map((label, index) => field(index, label));
const bue = await j('/result-filler/populate', {
  method: 'POST', token: ADMIN, device: DEVICE2,
  body: {
    adapterCode: scanAdapter,
    detectedIdentifiers: [{ kind: 'sample', label: 'Sample Barcode', value: CHEM_SAMPLE, source: 'header', confidence: 100 }],
    detectedFields: BUE_FIELDS,
  },
});
const buePlaced = Object.fromEntries((bue.json?.assignments ?? []).map(a => [a.fieldLabel, `${a.sourceCode}=${a.value}`]));
check('NA reached SODIUM, K reached POTASSIUM, CL reached CHLORIDE',
  buePlaced['SODIUM'] === 'NA=139' && buePlaced['POTASSIUM'] === 'K=4.2' && buePlaced['CHLORIDE'] === 'CL=101',
  JSON.stringify(buePlaced));
check('BUN reached UREA and CREA reached CREATININE',
  buePlaced['UREA'] === 'BUN=4.9' && buePlaced['CREATININE'] === 'CREA=78');
check('CALCIUM was not filled from the ionised one, nor the other way about',
  !buePlaced['CALCIUM'] && !buePlaced['Ionized Calcium']);
check('glucose had nowhere to go on this form and was reported, not dropped',
  (bue.json?.unmatched ?? []).some(u => u.code === 'GLU'),
  JSON.stringify(bue.json?.unmatched));

/* ---- a name this laboratory uses and nobody else does ----------------- */
// Unique per run, so the register this check leaves behind cannot make the
// next run pass for the wrong reason.
const LOCAL_NAME = `RANDOM SUGAR ${stamp}`;
const aliasBefore = await j('/result-filler/populate', {
  method: 'POST', token: ADMIN, device: DEVICE2,
  body: {
    adapterCode: scanAdapter,
    detectedIdentifiers: [{ kind: 'sample', label: 'Sample Barcode', value: CHEM_SAMPLE, source: 'header', confidence: 100 }],
    detectedFields: [field(0, `${LOCAL_NAME}*`)],
  },
});
check('an unknown local name is not guessed at', aliasBefore.status === 409, `${aliasBefore.status}`);

await j('/result-filler/aliases', { method: 'POST', token: ADMIN, body: { canonical: 'GLUCOSE', alias: LOCAL_NAME } });
const aliasAfter = await j('/result-filler/populate', {
  method: 'POST', token: ADMIN, device: DEVICE2,
  body: {
    adapterCode: scanAdapter,
    detectedIdentifiers: [{ kind: 'sample', label: 'Sample Barcode', value: CHEM_SAMPLE, source: 'header', confidence: 100 }],
    detectedFields: [field(0, `${LOCAL_NAME}*`)],
  },
});
check('and fills once the laboratory has taught it that name',
  aliasAfter.json?.assignments?.[0]?.value === '5.4',
  JSON.stringify(aliasAfter.json?.assignments ?? aliasAfter.json));

const refusedAlias = await j('/result-filler/aliases', { method: 'POST', token: ADMIN, body: { canonical: 'UREA', alias: LOCAL_NAME } });
check('one name cannot be taught to mean two parameters', refusedAlias.status === 409, `${refusedAlias.status}`);

const repeatAlias = await j('/result-filler/aliases', { method: 'POST', token: ADMIN, body: { canonical: 'GLUCOSE', alias: LOCAL_NAME } });
check('nor taught twice', repeatAlias.status === 409, `${repeatAlias.status}`);

/* ============ the names SECHLIMS itself gives an analyser's parameters ===== */
/**
 * The bridge does not hand on the analyser's mnemonic alone: it maps it through
 * the instrument profile, so a Sysmex XN's HGB arrives as "Haemoglobin" and its
 * NEUT# as "Neutrophils". Those are the words the matcher actually sees, and
 * the bare plural is the ABSOLUTE count — filing it as a percentage would be
 * the one mistake this matcher exists to prevent.
 */
section('The names SECHLIMS gives an analyser’s parameters');

const SYSMEX_SAMPLE = `SX${stamp}`;
const sysmexLink = await j('/instrument-links', {
  method: 'POST', token: ADMIN,
  body: {
    name: `Haematology scan ${stamp}`, mode: 'file_drop', protocol: 'astm',
    role: 'sechlims_only', watchPath: WATCH, profileKey: 'sysmex_xn',
  },
});
const SYSMEX = [
  ['WBC', '8.92'], ['RBC', '4.40'], ['HGB', '10.2'], ['HCT', '30.9'], ['MCV', '70.2'],
  ['MCH', '23.2'], ['MCHC', '33.1'], ['PLT', '288'],
  ['NEUT#', '5.11'], ['LYMPH#', '2.80'], ['MONO#', '0.41'], ['EO#', '0.09'], ['BASO#', '0.03'],
  ['NEUT%', '57.3'], ['LYMPH%', '31.4'], ['MONO%', '4.6'], ['EO%', '1.0'], ['BASO%', '0.3'],
  ['RDW-SD', '41.1'], ['RDW-CV', '15.2'], ['PDW', '11.9'], ['MPV', '10.4'], ['P-LCR', '29.1'],
  ['PCT', '0.30'], ['RET#', '55.0'], ['RET%', '1.25'],
];
writeFileSync(join(WATCH, `${SYSMEX_SAMPLE}.txt`), [
  'H|\\^&|||XN-550^1|||||||P|1',
  `P|1||AAN5678||ADOM^JADEN||19900101|M`,
  `O|1|${SYSMEX_SAMPLE}||^^^FBC|R||||||||||||||||||F`,
  ...SYSMEX.map(([code, value], i) => `R|${i + 1}|^^^^${code}^${i + 1}|${value}|u||N||F`),
  'L|1|N',
].join('\r'));
await new Promise(resolve => setTimeout(resolve, 2_600));
await j(`/instrument-links/${sysmexLink.json?.id}/fetch`, { method: 'POST', token: ADMIN, body: {} });

const sysmexPlan = await j('/result-filler/populate', {
  method: 'POST', token: ADMIN, device: DEVICE2,
  body: {
    adapterCode: scanAdapter,
    detectedIdentifiers: [{ kind: 'sample', label: 'Sample Barcode', value: SYSMEX_SAMPLE, source: 'header', confidence: 100 }],
    detectedFields: FBC_FIELDS,
  },
});
const byField = Object.fromEntries((sysmexPlan.json?.assignments ?? []).map(a => [a.fieldLabel, a.value]));
check('every parameter a Sysmex XN sends reaches its LHIMS box',
  (sysmexPlan.json?.assignments ?? []).length === SYSMEX.length,
  `${(sysmexPlan.json?.assignments ?? []).length} of ${SYSMEX.length}; unmatched ${JSON.stringify(sysmexPlan.json?.unmatched)}`);
check('“Haemoglobin” reached HGB and “Platelets” reached PLT',
  byField['HGB'] === '10.2' && byField['PLT'] === '288', JSON.stringify(byField));
check('“Neutrophils” reached NEUT#, and “Neutrophils %” reached NEUT%',
  byField['NEUT#'] === '5.11' && byField['NEUT%'] === '57.3',
  `NEUT#=${byField['NEUT#']} NEUT%=${byField['NEUT%']}`);
check('and the same for the rest of the differential',
  byField['LYMPH#'] === '2.80' && byField['LYMPH%'] === '31.4'
  && byField['MONO#'] === '0.41' && byField['EO#'] === '0.09' && byField['BASO#'] === '0.03',
  JSON.stringify(byField));
check('“Reticulocytes” reached RET# rather than RET%',
  byField['RET#'] === '55.0' && byField['RET%'] === '1.25',
  `RET#=${byField['RET#']} RET%=${byField['RET%']}`);

/* ---- a label a page ran together with everything in its cell ----------- */
/**
 * Reported from the bench as "it says the parameters do not match": a page that
 * put the box and its unit dropdown in one container made every label read as
 * the UNIT — "x10^3/uL" as the name of a parameter — so nothing matched
 * anything. The page is read better now; the matcher also looks for the
 * parameter inside a cluttered label, and refuses one naming two.
 */
const CLUTTERED = ['WBC * 0 x10^3/uL Machine 5-10', 'HGB * 0 g/DL Machine 11.00-16.00']
  .map((label, index) => field(index, label));
const cluttered = await j('/result-filler/populate', {
  method: 'POST', token: ADMIN, device: DEVICE2,
  body: {
    adapterCode: scanAdapter,
    detectedIdentifiers: [{ kind: 'sample', label: 'Sample Barcode', value: SYSMEX_SAMPLE, source: 'header', confidence: 100 }],
    detectedFields: CLUTTERED,
  },
});
check('a parameter buried in a cluttered label is still placed',
  (cluttered.json?.assignments ?? []).length === 2
  && cluttered.json.assignments.every(a => /read out of the label/.test(a.how)),
  JSON.stringify(cluttered.json?.assignments?.map(a => `${a.sourceCode}: ${a.how}`) ?? cluttered.json));

const ambiguous = await j('/result-filler/populate', {
  method: 'POST', token: ADMIN, device: DEVICE2,
  body: {
    adapterCode: scanAdapter,
    detectedIdentifiers: [{ kind: 'sample', label: 'Sample Barcode', value: SYSMEX_SAMPLE, source: 'header', confidence: 100 }],
    detectedFields: [field(0, 'HGB and HCT on one line')],
  },
});
check('a label naming two parameters is filled from neither', ambiguous.status === 409, `${ambiguous.status}`);

check('a refusal says what the form asked for, so it can be acted on',
  Array.isArray(ambiguous.json?.unfilled) && Array.isArray(ambiguous.json?.unmatched)
  && ambiguous.json.unfilled.length > 0,
  JSON.stringify(ambiguous.json).slice(0, 200));

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

/* ===================================================== the reference ranges */
/**
 * A reference range is the laboratory's clinical decision, so none is assumed.
 * What is proved here is that a parameter with no range prints a dash, that a
 * range set once is found whatever the analyser called the parameter, and that
 * the most specific range wins — a newborn's haematocrit is not an adult's.
 */
section('What a printed result is read against');

const beforeRanges = await j(`/transmission-reports/${reportId}`, { token: ADMIN });
const unranged = (beforeRanges.json?.report?.parameters ?? []).find(p => p.code === 'ZZUNKNOWN');
check('a parameter with no range on file prints nothing',
  Boolean(unranged) && !unranged.referenceLow && !unranged.referenceHigh && !unranged.referenceText,
  JSON.stringify(unranged));

const loaded = await j('/transmission-reports/ranges/load-form-ranges', { method: 'POST', token: ADMIN, body: {} });
check('the ranges the laboratory’s own forms use are on the register',
  ((loaded.json?.added ?? 0) + (loaded.json?.kept ?? 0)) > 50,
  JSON.stringify(loaded.json).slice(0, 180));

const loadedAgain = await j('/transmission-reports/ranges/load-form-ranges', { method: 'POST', token: ADMIN, body: {} });
check('loading them again changes nothing the laboratory has set',
  loadedAgain.json?.added === 0 && (loadedAgain.json?.kept ?? 0) > 50,
  JSON.stringify(loadedAgain.json).slice(0, 160));

const bands = await j('/transmission-reports/ranges', { token: ADMIN });
check('a parameter that needs several bands got all of them',
  (bands.json?.rows ?? []).filter(row => row.analyte === 'HCT').length >= 7,
  `${(bands.json?.rows ?? []).filter(row => row.analyte === 'HCT').length} band(s) for HCT`);

const afterRanges = await j(`/transmission-reports/${reportId}`, { token: ADMIN });
const hgb = (afterRanges.json?.report?.parameters ?? []).find(p => /HGB|haemoglobin/i.test(p.analyte));
check('and a result is then read against one',
  hgb?.referenceLow === '11.00' && hgb?.referenceHigh === '16.00',
  JSON.stringify(hgb));

// The transmission in this check carries HGB; the range was set under HGB and
// found for it however the analyser named the parameter.
const printedWithRanges = await j(`/transmission-reports/${reportId}/print`, { token: ADMIN });
check('the printed report shows the range', printedWithRanges.text.includes('11.00'),
  printedWithRanges.text.slice(0, 0));

const added = await j('/transmission-reports/ranges', {
  method: 'POST', token: ADMIN,
  body: { analyte: 'HCT', sex: 'male', low: '42', high: '52', unit: '%' },
});
check('a range can be set for one sex', added.status === 201, JSON.stringify(added.json));

const newborn = await j('/transmission-reports/ranges', {
  method: 'POST', token: ADMIN,
  body: { analyte: 'HCT', ageMaxDays: 56, ageLabel: 'Newborn', low: '44', high: '64', unit: '%' },
});
check('and another for an age band', newborn.status === 201);

const badBand = await j('/transmission-reports/ranges', {
  method: 'POST', token: ADMIN,
  body: { analyte: 'HCT', ageMinDays: 400, ageMaxDays: 100, low: '1', high: '2' },
});
check('an age band that ends before it begins is refused', badBand.status === 400, `${badBand.status}`);

const emptyRange = await j('/transmission-reports/ranges', { method: 'POST', token: ADMIN, body: { analyte: 'HCT' } });
check('a range with neither a number nor a word is refused', emptyRange.status === 400, `${emptyRange.status}`);

/*
 * The distinction that must survive everywhere it appears: an absolute count
 * and a percentage are different parameters, and a range keyed on the letters
 * of a name alone would print one against the other.
 */
const differentialReport = await j(`/transmission-reports?search=${encodeURIComponent(SYSMEX_SAMPLE)}`, { token: ADMIN });
const differentialId = differentialReport.json?.rows?.[0]?.id;
const differential = await j(`/transmission-reports/${differentialId}`, { token: ADMIN });
const parameterRange = (code) => {
  const found = (differential.json?.report?.parameters ?? []).find(p => p.code === code);
  return found ? `${found.referenceLow}-${found.referenceHigh}` : null;
};
check('the absolute neutrophil count is read against the absolute range',
  parameterRange('NEUT#') === '2.00-7.00', `NEUT# -> ${parameterRange('NEUT#')}`);
check('and the percentage against the percentage range',
  parameterRange('NEUT%') === '50.0-70.0', `NEUT% -> ${parameterRange('NEUT%')}`);
check('the same holds for the reticulocytes',
  parameterRange('RET#') === '0.0-999.9' && parameterRange('RET%') === '0.5-2',
  `RET# -> ${parameterRange('RET#')}, RET% -> ${parameterRange('RET%')}`);

const ranges = await j('/transmission-reports/ranges', { token: ADMIN });
check('the register reads the age band back in words',
  (ranges.json?.rows ?? []).some(row => row.analyte === 'HCT' && /weeks|days/.test(row.ageBand ?? '')),
  JSON.stringify((ranges.json?.rows ?? []).filter(r => r.analyte === 'HCT').map(r => r.ageBand)));

/* ------------------------------------------------------------ the package */
section('The extension package');
const zip = await fetch(`${BASE}/result-filler/package`, { headers: { Authorization: `Bearer ${ADMIN}` } });
const zipBytes = Buffer.from(await zip.arrayBuffer());
check('the extension downloads as a zip', zip.status === 200 && zipBytes.subarray(0, 2).toString() === 'PK' && zipBytes.length > 8_000,
  `${zip.status} ${zipBytes.length} bytes`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
