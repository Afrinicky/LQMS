/**
 * Do the dashboard alerts actually go anywhere?
 *
 * The complaint this suite exists for: "most of the alerts and attention
 * features at the dashboards are either unresponsive to click or do not lead to
 * the exact issue or problem." An alert is only useful if clicking it opens the
 * record it is about — not the module's front page, and not a generic inbox.
 *
 * So for every live alert this checks three things: it has somewhere to go,
 * that destination is a real route in the app, and it names both the tab the
 * record lives on and the record itself.
 *
 *   node scripts/alerts-check.mjs
 */
import { readFileSync } from 'node:fs';
import { ALERT_TARGETS } from '../shared/constants/alertTargets.ts';

const BASE = process.env.API || 'http://127.0.0.1:4431/api';
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

const st = await j('/setup/status');
if (!st.json?.setupComplete) {
  await j('/setup/initialize', { method: 'POST', body: { facilityName: 'Alert Lab', username: 'admin', password: PW, fullName: 'Admin User' } });
}
const A = (await j('/auth/login', { method: 'POST', body: { username: 'admin', password: PW } })).json.token;
const day = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const stamp = Date.now().toString().slice(-6);

/* ------------------------------------------------- 0. make something wrong */
// Seed conditions across several modules so there is a real spread of alerts.
console.log('\n[0] Give the laboratory some problems to raise alerts about');

// Routing delivers to staff, so the lab needs at least one person for the scan
// to have anywhere to send a notification.
const me = await j('/staff', { token: A, method: 'POST', body: { fullName: 'Quality Manager', email: `qm${stamp}@lab.test` } });
const meId = me.json?.id;
const admin = (await j('/users', { token: A })).json.find(u => u.username === 'admin');
if (admin && meId) await j(`/users/${admin.id}`, { token: A, method: 'PUT', body: { staffId: meId } });
check('the laboratory has a person alerts can be routed to', !!meId, JSON.stringify(me.json));

const eq = await j('/equipment', { token: A, method: 'POST', body: {
  name: `Centrifuge ${stamp}`, equipmentNumber: `EQ-${stamp}`, status: 'operational',
  calibrationDueDate: day(20), nextMaintenanceDue: day(10),
} });
check('an instrument overdue for calibration exists', eq.status === 201 || eq.status === 200, JSON.stringify(eq.json));

const item = await j('/supplier-inventory/items', { token: A, method: 'POST', body: {
  name: `Reagent ${stamp}`, category: 'reagent', unit: 'vial', quantity: 0, reorderLevel: 10,
} });
check('a stock item below its reorder level exists', item.status === 201 || item.status === 200, JSON.stringify(item.json));

const nc = await j('/nonconformities', { token: A, method: 'POST', body: {
  title: `Open nonconformity ${stamp}`, ncType: 'analytical', description: 'Raised by the alert test', detectedDate: day(3),
} });
check('an open nonconformity exists', nc.status === 201 || nc.status === 200, JSON.stringify(nc.json));

const iqcMat = await j('/iqc/materials', { token: A, method: 'POST', body: {
  materialName: `Alert Control ${stamp}`, testName: 'Glucose', lotNumber: `AC-${stamp}`,
  source: 'commercial', controlType: 'quantitative', ruleProfile: 'westgard_standard', expiryDate: day(-90),
  analytes: [{ analyte: 'Glucose', unit: 'mmol/L', targetMean: 5, targetSd: 0.2, decimalPlaces: 2 }],
} });
const glucose = (await j(`/iqc/materials/${iqcMat.json.id}/analytes`, { token: A })).json[0];
// 5 + 5 SD — a frank 1-3s rejection, which must await review.
const failedRun = await j('/iqc/runs', { token: A, method: 'POST', body: {
  iqcMaterialId: iqcMat.json.id, runDate: day(1), readings: [{ analyteId: glucose.id, value: 6 }],
} });
check('a rejected control run exists', failedRun.json?.status === 'out_of_control', JSON.stringify(failedRun.json?.status));

/* ------------------------------------------------------ 1. every alert aims */
console.log('\n[1] Every alert points somewhere, and somewhere specific');

const alerts = (await j('/notifications/live-alerts', { token: A })).json;
check('the live-alert feed returns alerts', Array.isArray(alerts) && alerts.length > 0, `${alerts?.length}`);

const noUrl = alerts.filter(a => !a.actionUrl);
check('none is a dead click', noUrl.length === 0, noUrl.map(a => a.itemType).join(', '));

const toInbox = alerts.filter(a => a.actionUrl.startsWith('/notifications'));
check('none falls back to the generic inbox', toInbox.length === 0,
  [...new Set(toInbox.map(a => a.itemType))].join(', '));

// Which alert kinds name a tab, and which are still landing on a module's
// front page? Every kind the scan can raise should have an entry.
const kinds = [...new Set(alerts.map(a => a.itemType))];
const untargeted = kinds.filter(k => !ALERT_TARGETS[k]);
check('every kind of alert raised names the tab its record lives on', untargeted.length === 0,
  `no target for: ${untargeted.join(', ')}`);

const withTab = alerts.filter(a => a.actionUrl.includes('tab='));
check('the alerts carry that tab in their URL', withTab.length === alerts.filter(a => ALERT_TARGETS[a.itemType]?.tab).length,
  `${withTab.length} of ${alerts.length}`);

const withFocus = alerts.filter(a => a.actionUrl.includes('focus='));
check('and the identity of the record itself', withFocus.length === alerts.filter(a => a.recordType && a.recordId).length,
  `${withFocus.length} of ${alerts.length}`);

/* ------------------------------------------- 2. those destinations are real */
console.log('\n[2] Those destinations are routes the app actually has');

const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const routes = new Set([...appSource.matchAll(/<Route\s+path="([^"]+)"/g)].map(m => m[1]));
const badRoutes = [...new Set(alerts.map(a => a.actionUrl.split('?')[0]))].filter(p => !routes.has(p));
check('every alert route is declared in the router', badRoutes.length === 0, badRoutes.join(', '));

// And the tab names have to be tabs the pages really render, or the link opens
// the module and silently does nothing.
const pageSource = ['Phase3Pages', 'Phase4Pages', 'Phase8Pages', 'PersonnelManagementPage', 'DocumentControlPage',
  'IqcPage', 'QMSPages', 'NcCapaPages', 'OrganisationPage', 'CustomerFocusPage', 'POCTPage',
  'InformationManagementPage', 'ProcessManagementPage', 'MonthlyReportsPage', 'BloodBankHandoverPage',
  'VerificationValidationPage', 'EnvironmentalMonitoringPage', 'SystemAuditPage']
  .map(f => readFileSync(new URL(`../src/pages/${f}.tsx`, import.meta.url), 'utf8')).join('\n');

const namedTabs = [...new Set(Object.values(ALERT_TARGETS).flatMap(t => [t.tab, t.subtab]).filter(Boolean))];
const missingTabs = namedTabs.filter(t => !pageSource.includes(`'${t}'`));
check('every tab an alert names exists in a page', missingTabs.length === 0, missingTabs.join(' | '));

/* ---------------------------------------- 3. the record kinds are markable */
console.log('\n[3] The record an alert names is one a page can highlight');

const focusTypes = [...new Set(alerts.filter(a => a.recordType).map(a => a.recordType))];
const marked = focusTypes.filter(t => pageSource.includes(`focusAttr('${t}'`));
console.log(`      ${marked.length} of ${focusTypes.length} record kinds are marked for highlight`);
console.log(`      not yet marked: ${focusTypes.filter(t => !marked.includes(t)).join(', ') || 'none'}`);
check('the equipment register can highlight an instrument', pageSource.includes("focusAttr('equipment_items'"));
check('the stock register can highlight an item', pageSource.includes("focusAttr('inventory_items'"));
check('the control-run review can highlight a run', pageSource.includes("focusAttr('iqc_runs'"));
check('the nonconformity register can highlight an event', pageSource.includes("focusAttr('nonconforming_events'"));

/* --------------------------------------------- 4. the specific cases seeded */
console.log('\n[4] The problems we created lead to their own records');

const expect = (itemType, wantTab, label) => {
  const a = alerts.find(x => x.itemType === itemType);
  if (!a) { check(label, false, `no ${itemType} alert was raised`); return; }
  const url = new URL(a.actionUrl, 'http://x');
  check(label, url.searchParams.get('tab') === wantTab && !!url.searchParams.get('focus'),
    `${a.actionUrl}`);
};
expect('equipment_calibration', 'Equipment Register', 'the calibration alert opens the equipment register at that instrument');
expect('inventory_low_stock', 'Item Register', 'the low-stock alert opens the item register at that item');
expect('nc_open', 'Register', 'the nonconformity alert opens the nonconformity register at that event');
expect('iqc_review', 'Review', 'the rejected control run opens IQC review at that run');

const ncAlert = alerts.find(a => a.itemType === 'nc_open');
check('a nonconformity opens its own route, not the shared module route',
  ncAlert?.actionUrl.startsWith('/nonconformities'), ncAlert?.actionUrl);

const iqcAlert = alerts.find(a => a.itemType === 'iqc_review');
check('the control-run alert names the control and the rule that broke',
  !!iqcAlert && /Alert Control/.test(iqcAlert.title) && /reject|1₃|withheld/i.test(iqcAlert.message || ''),
  `${iqcAlert?.title} :: ${iqcAlert?.message}`);
// The run this invocation created must raise exactly one alert, whatever else
// is already in the database — a three-analyte failure is one decision.
const mine = alerts.filter(a => a.itemType === 'iqc_review' && a.title.includes(stamp));
check('one failing run raises one alert, not one per analyte', mine.length === 1, `${mine.length}`);
check('and it names the run, not a single result',
  alerts.every(a => a.itemType !== 'iqc_review' || a.recordType === 'iqc_runs'),
  [...new Set(alerts.filter(a => a.itemType === 'iqc_review').map(a => a.recordType))].join(', '));

/* ------------------------------------------------- 5. grouped feed is usable */
console.log('\n[5] The by-module chart can reach each record too');

const grouped = (await j('/notifications/live-alerts?grouped=true', { token: A })).json;
check('the grouped feed returns modules', grouped?.groups?.length > 0, `${grouped?.groups?.length}`);
check('each group carries its own alerts to open',
  grouped.groups.every(g => Array.isArray(g.alerts) && g.alerts.length > 0));
check('and each of those alerts has its destination',
  grouped.groups.every(g => g.alerts.every(a => a.actionUrl && !a.actionUrl.startsWith('/notifications'))));
check('the group totals match the alerts they carry',
  grouped.groups.every(g => g.alerts.length === g.total),
  grouped.groups.filter(g => g.alerts.length !== g.total).map(g => `${g.module} ${g.alerts.length}/${g.total}`).join(', '));

/* ------------------------------------------ 6. routed notifications too */
console.log('\n[6] A routed notification opens the same place');

await j('/notifications/auto-scan', { token: A, method: 'POST', body: {} });
const inbox = (await j('/notifications', { token: A })).json;
const routed = (inbox || []).filter(n => n.action_url);
check('the scan routed notifications with an action URL', routed.length > 0, `${inbox?.length} in inbox`);
check('and those URLs aim at a tab and a record',
  routed.every(n => n.action_url.includes('focus=') || n.action_url.includes('tab=')),
  routed.filter(n => !/focus=|tab=/.test(n.action_url)).slice(0, 3).map(n => n.action_url).join(', '));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
