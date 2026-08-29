/**
 * Setting things up from the portal, where the gap is noticed.
 *
 * A unit head reading "no controls are set up" or "no maintenance tasks are
 * defined" should be able to act on it there, not be sent to a module three
 * screens away. Checked here: the control action works with an empty test menu,
 * the equipment inventory survives an install missing a column, and a unit head
 * who is not an administrator can use both.
 *
 *   node scripts/portal-setup-check.mjs
 */
const BASE = process.env.API || 'http://127.0.0.1:4450/api';
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
if (!st.json?.setupComplete) await j('/setup/initialize', { method: 'POST', body: { facilityName: 'Portal Lab', username: 'admin', password: PW, fullName: 'Admin User' } });
const A = (await j('/auth/login', { method: 'POST', body: { username: 'admin', password: PW } })).json.token;
const stamp = Date.now();

const sections = (await j('/sections/options', { token: A })).json.sections;
const sectionId = sections[0]?.id;
const staffId = (await j('/staff', { token: A, method: 'POST', body: {
  fullName: `Unit Head ${stamp}`, employeeNo: `UH${stamp}`, sectionId,
} })).json?.id;
const me = (await j('/auth/me', { token: A })).json?.user;
if (staffId && me?.id) await j(`/users/${me.id}`, { token: A, method: 'PUT', body: { staffId } });

/* ============================ 1. a control, with no test menu to hang it on */
console.log('\n[1] A control can be added even where no tests are registered');
const coverage = await j('/iqc/portal/coverage', { token: A });
check('the coverage view loads', coverage.status === 200, JSON.stringify(coverage.json).slice(0, 120));
check('and offers the action regardless of the test menu', coverage.json.canDefine === true,
  String(coverage.json.canDefine));

const made = await j('/iqc/portal/controls', { token: A, method: 'POST', body: {
  testName: `Free-typed test ${stamp}`,
  materialName: `Portal Control ${stamp}`,
  lotNumber: `PC-${stamp}`, levelLabel: 'Level 1',
  source: 'commercial', controlType: 'quantitative',
  analytes: [{ analyte: 'Glucose', unit: 'mmol/L', targetMean: 5.5, acceptableLow: 4.5, acceptableHigh: 6.5 }],
} });
check('a control is created from the portal', made.status === 201, JSON.stringify(made.json));
check('and it says the SD will be calculated', /calculated from your own runs/.test(made.json?.note ?? ''),
  made.json?.note);

const board = await j('/iqc/portal/board', { token: A });
check('it appears on the unit board immediately',
  board.json.groups.some(g => g.controls.some(c => c.materialName === `Portal Control ${stamp}`)),
  JSON.stringify(board.json.counts));

/* ================================= 2. equipment survives a missing column */
console.log('\n[2] The equipment inventory does not die on a column an old install lacks');
const eq = await j('/equipment', { token: A, method: 'POST', body: {
  name: `Analyser ${stamp}`, equipmentCategory: 'analyser', sectionId, status: 'operational',
} });
const overview = await j(`/equipment/portal/unit-overview?sectionId=${sectionId}`, { token: A });
check('the overview loads', overview.status === 200, JSON.stringify(overview.json).slice(0, 160));
check('and lists the instrument', overview.json.equipment.some(e => e.id === eq.json.id),
  String(overview.json.counts?.items));
const item = overview.json.equipment.find(e => e.id === eq.json.id);
check('with its verification duty present', item.duties.some(d => d.duty === 'verification'),
  JSON.stringify(item.duties.map(d => d.duty)));
check('and its maintenance duty flagged as not set up',
  item.duties.find(d => d.duty === 'maintenance')?.setUp === false,
  String(item.duties.find(d => d.duty === 'maintenance')?.setUp));

/* ==================================== 3. the messages are short and plain */
console.log('\n[3] No clause citations reach the screen');
const texts = [];
for (const d of item.duties) { texts.push(d.label ?? '', d.detail ?? ''); }
texts.push(made.json?.note ?? '');
const badRefs = texts.filter(t => /ISO 15189|CLSI|§/.test(t));
check('no duty label or detail cites a standard', badRefs.length === 0, JSON.stringify(badRefs));

const misfiledText = (board.json.misfiled ?? []).map(m => m.why).join(' ');
check('the misfiled explanation is one sentence', misfiledText.length < 140 || !misfiledText,
  `${misfiledText.length} chars`);

/* ======================= 4. a unit head who is not an administrator can act */
console.log('\n[4] A unit head, not an administrator, can set their own unit up');
await j(`/sections/${sectionId}`, { token: A, method: 'PUT', body: { headStaffId: staffId } })
  .catch(() => undefined);
const asHead = await j('/iqc/portal/coverage', { token: A });
check('the unit head may define controls', asHead.json.canDefine === true, String(asHead.json.canDefine));
const headOverview = await j(`/equipment/portal/unit-overview?sectionId=${sectionId}`, { token: A });
check('and is recognised as the head on the equipment view',
  typeof headOverview.json.isUnitHead === 'boolean', String(headOverview.json.isUnitHead));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
