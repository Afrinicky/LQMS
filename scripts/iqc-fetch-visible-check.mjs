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

/* ================================ 2. the module says so, and still offers both */
console.log('\n[2] Run Control: no match is not the same as no analyser');
const attached = (await j(`/iqc/materials/${controlId}/analyser`, { token: A })).json;
check('the module reports no match rather than a feed', attached?.linked === false, JSON.stringify(attached?.linked));
check('and names the real problem', /match/i.test(String(attached?.why)), String(attached?.why));
check('while still offering every analyser to choose from',
  (attached?.options ?? []).some(o => o.id === linkA.json.id) && (attached?.options ?? []).some(o => o.id === linkB.json.id),
  JSON.stringify((attached?.options ?? []).map(o => o.name)));

/* ========================================= 3. the bench gets the same offer */
console.log('\n[3] The portal: the same control, the same two analysers');
const detail = (await j(`/iqc/portal/controls/${controlId}`, { token: A })).json;
check('the bench can open the control', Boolean(detail?.material), JSON.stringify(detail?.error));
check('it is told no analyser matched', !detail?.feed, JSON.stringify(detail?.feed));
check('and is handed both to pick from', (detail?.feedOptions ?? []).length >= 2,
  JSON.stringify((detail?.feedOptions ?? []).map(o => o.name)));

const armed = await j(`/iqc/portal/controls/${controlId}/analyser-listen`, {
  token: A, method: 'POST', body: { linkId: linkB.json.id },
});
check('the bench can stand ready on the one it picked', armed.json?.listening === true, JSON.stringify(armed.json));
check('and is handed a watermark', Number.isFinite(Number(armed.json?.since?.control)), JSON.stringify(armed.json?.since));

const guessed = await j(`/iqc/portal/controls/${controlId}/analyser-listen`, { token: A, method: 'POST' });
check('without a choice it says plainly that nothing is attached',
  guessed.json?.listening === false && /no analyser/i.test(String(guessed.json?.note)), JSON.stringify(guessed.json));

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

/* ================================================= 5. the laboratory's theme */
console.log('\n[5] The theme this laboratory opens on');
const before = (await j('/system/appearance', { token: A })).json;
check('a laboratory that has never chosen opens light', before?.defaultTheme === 'light', JSON.stringify(before));
const setDark = await j('/system/appearance', { token: A, method: 'PUT', body: { defaultTheme: 'dark' } });
check('an administrator can set it', setDark.json?.defaultTheme === 'dark', JSON.stringify(setDark.json));
check('and it is stamped, so devices know to adopt it', Boolean(setDark.json?.setAt), JSON.stringify(setDark.json?.setAt));
const setLight = await j('/system/appearance', { token: A, method: 'PUT', body: { defaultTheme: 'light' } });
check('and set back', setLight.json?.defaultTheme === 'light', JSON.stringify(setLight.json));
const nonsense = await j('/system/appearance', { token: A, method: 'PUT', body: { defaultTheme: 'purple' } });
check('anything else is refused', nonsense.status === 400, JSON.stringify(nonsense.json));
const anon = await j('/system/appearance');
check('and it is not readable without signing in', anon.status === 401 || anon.status === 403, String(anon.status));

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
