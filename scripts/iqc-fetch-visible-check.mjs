/**
 * The Fetch button, on a control that matches no analyser.
 *
 * This is the case the bench actually had: two links on the system, a control
 * naming an instrument neither link was set up against, and a screen that
 * answered by drawing nothing at all. "No analyser matched this control" and
 * "this laboratory has no analyser" are different statements with different
 * remedies, and the second one was being shown for the first.
 *
 * Also proved here: a sample can be put on the register from the bench. The
 * re-read needs the original result to compare against, and until now that
 * record could only be made at a desktop — which is not where the person
 * holding the tube is standing.
 *
 *   node scripts/iqc-fetch-visible-check.mjs
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
const day = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

const st = await j('/setup/status');
if (!st.json?.setupComplete) await j('/setup/initialize', { method: 'POST', body: { facilityName: 'Bench Lab', username: 'admin', password: PW, fullName: 'Admin User' } });
let A = (await j('/auth/login', { method: 'POST', body: { username: 'admin', password: PW } })).json?.token;
const stamp = Date.now();

/* ============================= 1. a unit, a bench account, and TWO analysers */
console.log('\n[1] Two analyser links, and a control that names neither');
const sections = (await j('/sections', { token: A })).json ?? [];
// Its own unit. Run on a database that other suites have already used, a link
// left behind in Haematology matches this control by section and the case
// under test — a control that matches nothing — stops existing.
const made = await j('/section-config/sections', { token: A, method: 'POST', body: {
  name: `Unmatched unit ${stamp}`, code: `UU${String(stamp).slice(-6)}`,
} });
const unit = made.json?.id;
const other = sections[0]?.id ?? unit;
check('the control gets a unit of its own', made.status === 201 && Boolean(unit), JSON.stringify(made.json));

const me = (await j('/auth/me', { token: A })).json?.user;
const staffId = (await j('/staff', { token: A, method: 'POST', body: {
  fullName: `Bench ${stamp}`, employeeNo: `E${stamp}`, sectionId: unit,
} })).json?.id;
await j(`/users/${me.id}`, { token: A, method: 'PUT', body: { staffId } });
// The staff link only lands in a fresh token.
A = (await j('/auth/login', { method: 'POST', body: { username: 'admin', password: PW } })).json?.token;
check('the account is on the unit’s bench', Boolean(staffId));

const mk = async (name, sectionId) => (await j('/equipment', { token: A, method: 'POST', body: {
  name, equipmentCategory: 'analyser', sectionId, status: 'operational',
} })).json;
const analyserA = await mk(`Linked analyser A ${stamp}`, other);
const analyserB = await mk(`Linked analyser B ${stamp}`, other);
const unlinked = await mk(`The one the control names ${stamp}`, unit);

const mkLink = async (name, equipmentId, sectionId, port) => j('/instrument-links', { token: A, method: 'POST', body: {
  name, equipmentId, sectionId, profileKey: 'sysmex_xn',
  role: 'sechlims_only', mode: 'server', protocol: 'astm', listenPort: port, autoStart: false,
} });
const linkA = await mkLink(`Link A ${stamp}`, analyserA.id, other, 44100 + (stamp % 300));
const linkB = await mkLink(`Link B ${stamp}`, analyserB.id, other, 44500 + (stamp % 300));
check('two links exist, neither on this control’s unit', linkA.status === 201 && linkB.status === 201,
  JSON.stringify([linkA.json, linkB.json]));

const control = await j('/iqc/materials', { token: A, method: 'POST', body: {
  materialName: `Unmatched control ${stamp}`, testName: 'Full blood count', lotNumber: `UM-${stamp}`,
  levelLabel: 'Level 2 (Normal)', source: 'commercial', controlType: 'quantitative', qcFrequency: 'daily',
  sectionId: unit, equipmentId: unlinked.id,
  analytes: [
    { analyte: 'Haemoglobin', unit: 'g/dL', targetMean: 13.5, targetSd: 0.4, decimalPlaces: 1 },
    { analyte: 'WBC', unit: '10^9/L', targetMean: 7.2, targetSd: 0.35, decimalPlaces: 2 },
  ],
} });
const controlId = control.json.id;
check('the control is defined, naming an instrument no link is set up against', control.status === 201,
  JSON.stringify(control.json));

/* ========= 2. the module says so, and offers nothing it cannot stand behind */
/*
 * A control run is a statement about ONE instrument's performance: CLSI C24
 * keeps a mean, an SD and a Levey-Jennings chart per instrument, and ISO 15189
 * has the laboratory show comparability BETWEEN instruments. Neither survives a
 * run filed against a machine it was not run on, and an accepted run cannot be
 * un-attributed afterwards. So a link on another machine is not offered with a
 * warning beside it; it is not offered.
 */
console.log('\n[2] Run Control: an analyser that is not this control’s is not offered');
const attached = (await j(`/iqc/materials/${controlId}/analyser`, { token: A })).json;
check('the module reports no match rather than a feed', attached?.linked === false, JSON.stringify(attached?.linked));
check('and names the real problem', /link is registered against/i.test(String(attached?.why)), String(attached?.why));
check('and offers no analyser, because none belongs to this control’s instrument',
  (attached?.options ?? []).length === 0,
  JSON.stringify((attached?.options ?? []).map(o => o.name)));

/* ========================================= 3. the bench is held to the same rule */
console.log('\n[3] The portal: the same control, and the same refusal');
const detail = (await j(`/iqc/portal/controls/${controlId}`, { token: A })).json;
check('the bench can open the control', Boolean(detail?.material), JSON.stringify(detail?.error));
check('it is told no analyser matched', !detail?.feed, JSON.stringify(detail?.feed));
check('and is offered none to pick from', (detail?.feedOptions ?? []).length === 0,
  JSON.stringify((detail?.feedOptions ?? []).map(o => o.name)));

// Naming one by hand does not get round it: a request for a link on another
// machine is ignored rather than obeyed.
const armed = await j(`/iqc/portal/controls/${controlId}/analyser-listen`, {
  token: A, method: 'POST', body: { linkId: linkB.json.id },
});
check('asking for an analyser on another machine is refused',
  armed.json?.listening === false, JSON.stringify(armed.json));
check('and is handed a watermark all the same', Number.isFinite(Number(armed.json?.since?.control)), JSON.stringify(armed.json?.since));
check('saying which of the two things is missing',
  /link is registered against/i.test(String(armed.json?.note)), JSON.stringify(armed.json?.note));

const guessed = await j(`/iqc/portal/controls/${controlId}/analyser-listen`, { token: A, method: 'POST' });
check('and without a choice it says the same thing',
  guessed.json?.listening === false && /link is registered against/i.test(String(guessed.json?.note)), JSON.stringify(guessed.json));

/* ======================================= 4. enrolling a sample from the bench */
console.log('\n[4] Putting a sample on the register without leaving the bench');
const analytes = (await j(`/iqc/materials/${controlId}/analytes`, { token: A })).json ?? [];
const hb = analytes.find(a => a.analyte === 'Haemoglobin');
const wbc = analytes.find(a => a.analyte === 'WBC');

const empty = (await j(`/iqc/portal/controls/${controlId}/retained-samples`, { token: A })).json;
check('the register starts empty', Array.isArray(empty) && empty.length === 0, JSON.stringify(empty));

const added = await j('/iqc/retained-samples', { token: A, method: 'POST', body: {
  iqcMaterialId: controlId, sampleReference: `LAB-${stamp}`, originalRunDate: day(1),
  values: [{ analyteId: hb.id, originalValue: 13.4 }, { analyteId: wbc.id, originalValue: 7.1 }],
} });
check('the bench can enrol one', added.status === 201, JSON.stringify(added.json));

const register = (await j(`/iqc/portal/controls/${controlId}/retained-samples`, { token: A })).json ?? [];
check('and it appears in the bench’s own picker', register.some(x => x.id === added.json.id),
  JSON.stringify(register.map(x => x.sample_reference)));
check('carrying what it originally gave', (register[0]?.values ?? []).some(v => v.original_value === 13.4),
  JSON.stringify(register[0]?.values));

const reread = await j('/iqc/runs', { token: A, method: 'POST', body: {
  iqcMaterialId: controlId, runKind: 'retained_sample', retainedSampleId: added.json.id,
  runDate: day(0), readings: [{ analyteId: hb.id, value: 13.5 }],
} });
check('and the re-read is judged against it', reread.json?.status === 'in_control', JSON.stringify(reread.json));

const refused = await j('/iqc/retained-samples', { token: A, method: 'POST', body: {
  iqcMaterialId: controlId, sampleReference: `LAB-X-${stamp}`, originalRunDate: day(1), values: [],
} });
check('a sample with no original result is refused', refused.status === 400, JSON.stringify(refused.json));

/* ============================================ 5. what the laboratory looks like */
console.log('\n[5] How this laboratory\'s screens are set up');
const before = (await j('/system/appearance', { token: A })).json;
check('a laboratory that has never chosen opens light', before?.theme === 'light', JSON.stringify(before));
check('on the default accent, comfortable, unscaled, menu open',
  before?.accent === 'blue' && before?.density === 'comfortable' && before?.scale === '100' && before?.sidebar === 'expanded',
  JSON.stringify(before));

const set = await j('/system/appearance', { token: A, method: 'PUT', body: {
  theme: 'dark', accent: 'teal', density: 'compact', scale: '125', sidebar: 'collapsed',
} });
check('an administrator can set all of it at once',
  set.json?.theme === 'dark' && set.json?.accent === 'teal' && set.json?.density === 'compact'
    && set.json?.scale === '125' && set.json?.sidebar === 'collapsed', JSON.stringify(set.json));
check('and it is stamped, so devices know to adopt it', Boolean(set.json?.setAt), JSON.stringify(set.json?.setAt));

const one = await j('/system/appearance', { token: A, method: 'PUT', body: { accent: 'green' } });
check('one part can be changed without resetting the rest',
  one.json?.accent === 'green' && one.json?.theme === 'dark' && one.json?.scale === '125', JSON.stringify(one.json));

const legacy = await j('/system/appearance', { token: A, method: 'PUT', body: { defaultTheme: 'light' } });
check('the field this endpoint first had still works', legacy.json?.theme === 'light', JSON.stringify(legacy.json));

const nonsense = await j('/system/appearance', { token: A, method: 'PUT', body: { accent: 'purple' } });
check('a value this build does not know is refused', nonsense.status === 400, JSON.stringify(nonsense.json));
const nothing = await j('/system/appearance', { token: A, method: 'PUT', body: {} });
check('and so is a change that changes nothing', nothing.status === 400, JSON.stringify(nothing.json));
const anon = await j('/system/appearance');
check('it is not readable without signing in', anon.status === 401 || anon.status === 403, String(anon.status));

// Put it back, so a suite run does not leave the next person on a dark screen.
await j('/system/appearance', { token: A, method: 'PUT', body: {
  theme: 'light', accent: 'blue', density: 'comfortable', scale: '100', sidebar: 'expanded',
} });

/* ================================================ 6. every address, reachable or not */
console.log('\n[6] The addresses this host answers on');
const conn = (await j('/system/connectivity', { token: A })).json;
check('the host reports its addresses', Array.isArray(conn?.hostAddresses), JSON.stringify(conn?.hostAddresses?.length));
check('each one says whether it is answering',
  (conn?.hostAddresses ?? []).every(a => typeof a.reachable === 'boolean' && a.url && a.label),
  JSON.stringify(conn?.hostAddresses));
check('and a Tailscale address is named as one',
  (conn?.hostAddresses ?? []).every(a => !a.url.includes('://100.') || /tailscale/i.test(a.label)),
  JSON.stringify((conn?.hostAddresses ?? []).map(a => a.label)));

/* ========================================================== 7. the port is a setting */
console.log('\n[7] Which port this host answers on');
const port = conn?.portSetting;
check('the port is reported as something the laboratory owns', Boolean(port), JSON.stringify(port));
check('and it is not flagged as having moved when it has not',
  conn?.lan?.portMoved === false, JSON.stringify({ asked: port?.asked, bound: port?.bound, moved: conn?.lan?.portMoved }));

if (port?.lockedToEnvironment) {
  const refused = await j('/system/port', { token: A, method: 'PUT', body: { port: 4400 } });
  check('a port set in the environment is not overruled from here', refused.status === 400, JSON.stringify(refused.json));
} else {
  const chosen = await j('/system/port', { token: A, method: 'PUT', body: { port: 4400 } });
  check('an administrator can choose the port', chosen.status === 200, JSON.stringify(chosen.json));
  check('and is told it waits for a restart', chosen.json?.appliesAtRestart === true, JSON.stringify(chosen.json));

  const after = (await j('/system/connectivity', { token: A })).json;
  check('the choice is remembered as the next port', after?.portSetting?.next === 4400, JSON.stringify(after?.portSetting));
  check('while the running host keeps the port it actually bound',
    after?.portSetting?.bound === port.bound, JSON.stringify(after?.portSetting));
  // The bug this replaced: choosing a port made the host claim the port it was
  // running on "was already in use when it started". It had not been.
  check('and choosing a port is not reported as a port conflict',
    after?.lan?.portMoved === false, JSON.stringify({ moved: after?.lan?.portMoved, asked: after?.portSetting?.asked }));

  const silly = await j('/system/port', { token: A, method: 'PUT', body: { port: 80 } });
  check('a privileged or impossible port is refused', silly.status === 400, JSON.stringify(silly.json));

  await j('/system/port', { token: A, method: 'PUT', body: { port: port.bound } });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
