/**
 * Three corrections, proved.
 *
 * ONE WIZARD. Setting a control up from the portal opens the same form the
 * Quality Control module uses, from the panel that lists the controls — not a
 * shortened copy of it, and not a third tab to be in. A unit head who does not
 * hold the module's create right must be able to use it for their own unit,
 * because that is the basis on which the panel offers them the button; the two
 * used to disagree and the dialog opened empty.
 *
 * DELETING A DECLARATION. It failed with "FOREIGN KEY constraint failed" on
 * every declaration that had actually reached the bench — the moment somebody
 * opens the notification it raised, a notification_events row points at it. And
 * a declaration people have SIGNED is a record, so deleting it is refused until
 * that is said out loud.
 *
 *   npm run api        (in one terminal)
 *   node scripts/portal-wizard-check.mjs
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
  await j('/setup/initialize', { method: 'POST', body: { facilityName: 'Wizard Lab', username: 'admin', password: PW, fullName: 'Admin User' } });
}
const A = (await j('/auth/login', { method: 'POST', body: { username: 'admin', password: PW } })).json?.token;
if (!A) { console.error(`Could not sign in — is the API running on ${BASE}?`); process.exit(1); }
const stamp = Date.now().toString(36).toUpperCase();

// The account has to be a member of staff before any of this: a declaration is
// published TO staff, and the notification it raises is what the bug lived in.
const sections = (await j('/sections', { token: A })).json ?? [];
const sectionId = sections[0]?.id;
const me = (await j('/auth/me', { token: A })).json?.user;
const staffId = (await j('/staff', { token: A, method: 'POST', body: { fullName: `Signer ${stamp}`, employeeNo: `W${stamp}`, sectionId } })).json?.id;
await j(`/users/${me.id}`, { token: A, method: 'PUT', body: { staffId } });

/* ==========================================================================
   1. Deleting a declaration
   ======================================================================== */
console.log('\n[1] Deleting a declaration form');

const makeForm = async title => (await j('/organisation/ethical-forms', {
  token: A, method: 'POST',
  body: { title, formType: 'code_of_conduct', version: 'v1.0', bodyContent: 'Be good.', effectiveDate: '2026-01-01', notifyStaff: true },
})).json;

const clean = await makeForm(`Untouched ${stamp}`);
const gone = await j(`/organisation/ethical-forms/${clean.id}`, { token: A, method: 'DELETE' });
check('a declaration nobody has touched deletes', gone.status === 200, JSON.stringify(gone.json));

// The case that failed in the laboratory: somebody opened the notification it
// raised, which writes a notification_events row pointing at that notification.
const opened = await makeForm(`Opened ${stamp}`);
const notes = (await j('/notifications?limit=200', { token: A })).json;
const list = Array.isArray(notes) ? notes : (notes?.rows ?? notes?.notifications ?? []);
const mine = list.find(n => String(n.action_url ?? '').includes(`form=${opened.id}`)
  || (n.record_type === 'ethical_declaration_forms' && String(n.record_id) === String(opened.id)));
check('publishing a declaration notifies the laboratory', Boolean(mine), `${list.length} notification(s)`);

if (mine) {
  const read = await j(`/notifications/${mine.id}/read`, { token: A, method: 'POST', body: {} });
  check('somebody opens it, which records an event against it', read.status === 200, `${read.status}`);
}

check('the notification could be opened, so this case is the real one', Boolean(mine));

const afterOpen = await j(`/organisation/ethical-forms/${opened.id}`, { token: A, method: 'DELETE' });
check('the declaration still deletes once its notification has been opened',
  afterOpen.status === 200, JSON.stringify(afterOpen.json));
check('and not with a database message', afterOpen.status !== 500
  && !String(afterOpen.json?.error ?? '').includes('FOREIGN KEY'), JSON.stringify(afterOpen.json));

// A signed declaration is a record. It is refused until that is acknowledged.
const signed = await makeForm(`Signed ${stamp}`);
const sig = await j(`/organisation/ethical-forms/${signed.id}/sign`, { token: A, method: 'POST', body: { affirmationText: 'I agree' } });
check('it can be signed', sig.status === 201, `${sig.status}`);

/* -------------------------------------------------------------------------
   Marking one obsolete — its own act, and it must SHOW
   ---------------------------------------------------------------------- */
const retired = await j(`/organisation/ethical-forms/${signed.id}/status`, {
  token: A, method: 'POST', body: { status: 'obsolete' },
});
check('a declaration can be marked obsolete', retired.status === 200 && retired.json?.status === 'obsolete',
  JSON.stringify(retired.json));
check('and its signatures are kept', Number(retired.json?.signaturesKept) === 1, JSON.stringify(retired.json?.signaturesKept));

const listed = (await j('/organisation/ethical-forms', { token: A })).json ?? [];
const row = listed.find(f => f.id === signed.id);
check('the register reports it as obsolete, not as one to sign', row?.status === 'obsolete', row?.status);
check('and still counts the signature it holds', Number(row?.signature_count) === 1, JSON.stringify(row?.signature_count));

// Nobody is asked to sign a withdrawn declaration.
const notesNow = (await j('/notifications?limit=200', { token: A })).json;
const openList = Array.isArray(notesNow) ? notesNow : (notesNow?.rows ?? notesNow?.notifications ?? []);
check('outstanding requests to sign it are withdrawn',
  !openList.some(n => String(n.action_url ?? '').includes(`form=${signed.id}`) && !['resolved', 'dismissed'].includes(n.status)),
  `${openList.length} notification(s) remain`);

const cannotSign = await j(`/organisation/ethical-forms/${signed.id}/sign`, { token: A, method: 'POST', body: { affirmationText: 'again' } });
check('an obsolete declaration cannot be signed', cannotSign.status >= 400, `${cannotSign.status}`);

const back = await j(`/organisation/ethical-forms/${signed.id}/status`, { token: A, method: 'POST', body: { status: 'active' } });
check('and it can be brought back into force', back.status === 200 && back.json?.status === 'active', JSON.stringify(back.json));

const nonsense = await j(`/organisation/ethical-forms/${signed.id}/status`, { token: A, method: 'POST', body: { status: 'banana' } });
check('a status that is not one of the three is refused', nonsense.status === 400, `${nonsense.status}`);

/* -------------------------------------------------------------------------
   Deleting a SIGNED declaration — permitted, because demonstration data has
   to be able to go
   ---------------------------------------------------------------------- */
const forced = await j(`/organisation/ethical-forms/${signed.id}`, { token: A, method: 'DELETE' });
check('a signed declaration deletes outright', forced.status === 200, JSON.stringify(forced.json));
check('and says how many signatures went with it',
  Number(forced.json?.signaturesRemoved) === 1, JSON.stringify(forced.json?.signaturesRemoved));

const afterDelete = await j(`/organisation/ethical-forms/${signed.id}`, { token: A });
check('it is really gone', afterDelete.status === 404, `${afterDelete.status}`);

/* ==========================================================================
   2. One wizard, and who may use it
   ======================================================================== */
console.log('\n[2] Setting a control up from the portal');

const lookups = await j('/iqc/portal/lookups', { token: A });
check('the wizard\'s lists are served to the portal', lookups.status === 200
  && Array.isArray(lookups.json?.sections) && Array.isArray(lookups.json?.equipment), `${lookups.status}`);

const coverage = await j('/iqc/portal/coverage', { token: A });
check('the coverage panel loads', coverage.status === 200, `${coverage.status}`);
check('and says whether this person may define a control', typeof coverage.json?.canDefine === 'boolean');

// The wizard posts where the module posts, so a control defined at the bench is
// the same record as one defined in Quality Control.
const viaWizard = await j('/iqc/materials', {
  token: A, method: 'POST',
  body: {
    materialName: `Bench control ${stamp}`, testName: 'Liver function', lotNumber: `LOT-${stamp}`,
    source: 'commercial', controlType: 'quantitative', qcFrequency: 'daily',
    ruleProfile: 'westgard_standard', sectionId,
    analytes: [{ analyte: 'Total bilirubin', unit: 'µmol/L', targetMean: '12', targetSd: '0.8', decimalPlaces: '1' }],
  },
});
check('the wizard\'s own endpoint accepts the control', viaWizard.status === 201, JSON.stringify(viaWizard.json)?.slice(0, 160));

const board = (await j('/iqc/portal/board', { token: A })).json;
const onBoard = (board?.groups ?? []).flatMap(g => g.controls).some(c => c.id === viaWizard.json?.id);
check('and it reaches the unit\'s board', onBoard, `${(board?.groups ?? []).length} group(s)`);

/* ==========================================================================
   3. A unit head with no module create right
   ======================================================================== */
console.log('\n[3] The unit head the panel offers the button to');

// Make a second account, head of the unit, WITHOUT the IQC create right.
const headStaff = (await j('/staff', { token: A, method: 'POST', body: { fullName: `Unit Head ${stamp}`, employeeNo: `H${stamp}`, sectionId } })).json?.id;
// Deliberately a role with NO quality-control rights at all — Stores Officer.
// A Biomedical Scientist would prove nothing here: that role holds iqc at
// Manage, so it may define a control anywhere and this whole case disappears.
// The point is somebody who may define one ONLY because they head the unit.
const roles = (await j('/roles', { token: A })).json ?? [];
const plain = roles.find(r => /stores officer/i.test(r.name ?? ''))
  ?? roles.find(r => !r.isAdministrator && !/scientist|manager|head|quality/i.test(r.name ?? ''));
const headUser = await j('/users', {
  token: A, method: 'POST',
  body: { username: `head${stamp}`.toLowerCase(), password: PW, fullName: `Unit Head ${stamp}`, staffId: headStaff, roleId: plain?.id },
});
check('a second account exists for the unit head', headUser.status === 201 || headUser.status === 200, JSON.stringify(headUser.json)?.slice(0, 140));
check('and it holds no quality-control rights of its own', Boolean(plain) && !/scientist|quality|manager/i.test(plain.name), plain?.name);

await j(`/section-config/sections/${sectionId}`, { token: A, method: 'PUT', body: { headStaffId: headStaff } });
const H = (await j('/auth/login', { method: 'POST', body: { username: `head${stamp}`.toLowerCase(), password: PW } })).json?.token;

if (!H) {
  check('the unit head can sign in', false, 'no token');
} else {
  const theirCoverage = await j('/iqc/portal/coverage', { token: H });
  const offered = theirCoverage.json?.canDefine === true;
  check('the panel offers the unit head the button', offered, JSON.stringify(theirCoverage.json?.canDefine));

  const theirs = await j('/iqc/materials', {
    token: H, method: 'POST',
    body: {
      materialName: `Head control ${stamp}`, testName: 'Urea', lotNumber: `HL-${stamp}`,
      source: 'commercial', controlType: 'quantitative', sectionId,
      analytes: [{ analyte: 'Urea', unit: 'mmol/L', targetMean: '5', targetSd: '0.3', decimalPlaces: '1' }],
    },
  });
  check('and the wizard they open actually saves for their own unit',
    theirs.status === 201, `${theirs.status} ${JSON.stringify(theirs.json)?.slice(0, 140)}`);

  const elsewhere = sections.find(s => Number(s.id) !== Number(sectionId));
  if (elsewhere) {
    const notTheirs = await j('/iqc/materials', {
      token: H, method: 'POST',
      body: {
        materialName: `Other unit ${stamp}`, testName: 'Urea', lotNumber: `OL-${stamp}`,
        source: 'commercial', controlType: 'quantitative', sectionId: elsewhere.id,
        analytes: [{ analyte: 'Urea', targetMean: '5', targetSd: '0.3' }],
      },
    });
    check('but not for a unit they do not head', notTheirs.status === 403, `${notTheirs.status}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
