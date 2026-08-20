/**
 * Complaint handling, against ISO 15189:2022 §7.4.
 *
 *   node scripts/complaints-check.mjs
 *
 * The clause asks a laboratory to receive and evaluate complaints, acknowledge
 * receipt, keep a record of what was done, have the decision made or reviewed
 * by people NOT involved in the activity complained about, and formally tell
 * the complainant when handling has ended. Each of those is checked here,
 * including the refusals — a rule that can be skipped is not a control.
 */
const BASE = process.env.API || 'http://127.0.0.1:4420/api';
const PW = 'Passw0rd!test';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};
const j = async (p, o = {}) => {
  const r = await fetch(`${BASE}${p}`, { method: o.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(o.token ? { Authorization: `Bearer ${o.token}` } : {}) },
    body: o.body !== undefined ? JSON.stringify(o.body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
};

if (!(await j('/setup/status')).json?.setupComplete)
  await j('/setup/initialize', { method: 'POST', body: { facilityName: 'Complaint Lab', username: 'admin', password: PW, fullName: 'Admin User' } });
const A = (await j('/auth/login', { method: 'POST', body: { username: 'admin', password: PW } })).json.token;
const stamp = Date.now();

// Two people: one investigates, one reviews. They must not be the same.
await j('/staff', { token: A, method: 'POST', body: { employeeNo: `INV-${stamp}`, firstName: 'Ivy', surname: 'Investigator' } });
await j('/staff', { token: A, method: 'POST', body: { employeeNo: `REV-${stamp}`, firstName: 'Rita', surname: 'Reviewer' } });
const staff = (await j('/staff', { token: A })).json;
const investigator = staff.find(s => s.employeeNo === `INV-${stamp}`);
const reviewer = staff.find(s => s.employeeNo === `REV-${stamp}`);

console.log('\n[1] A complaint can be logged at all');
const missing = await j('/complaints', { token: A, method: 'POST', body: { title: 'No description' } });
check('an incomplete complaint is refused with a reason', missing.status === 400 && /required/i.test(missing.json.error), JSON.stringify(missing.json));
const created = await j('/complaints', { token: A, method: 'POST', body: {
  receivedDate: '2026-08-20', source: 'OPD', complainantType: 'Clinician', complainantName: 'Dr Mensah',
  contact: '0200000000', category: 'Turnaround time', title: `Results delayed ${stamp}`,
  description: 'Urgent FBC took six hours to report.', severity: 'major', patientAffected: true,
} });
check('a complete complaint is created', created.status === 201 && !!created.json.id, JSON.stringify(created.json));
const id = created.json.id;
check('it is given a complaint number', /^COMP/.test(created.json.complaintNumber || ''), created.json.complaintNumber);

console.log('\n[2] Receipt is acknowledged, on a target the laboratory sets');
check('an acknowledgement is due by a stored date', !!created.json.acknowledgementDueDate, created.json.acknowledgementDueDate);
check('so is a resolution', !!created.json.resolutionDueDate, created.json.resolutionDueDate);
{
  const t = await j('/complaints/config/targets', { token: A });
  check('the targets are readable', t.json.acknowledgeDays > 0 && t.json.resolveDays > 0, JSON.stringify(t.json));
  const saved = await j('/complaints/config/targets', { token: A, method: 'PUT', body: { acknowledgeDays: 2, resolveDays: 21 } });
  check('and a laboratory can set its own', saved.json.acknowledgeDays === 2 && saved.json.resolveDays === 21, JSON.stringify(saved.json));
}
check('acknowledging without saying how is refused',
  (await j(`/complaints/${id}/acknowledge`, { token: A, method: 'POST', body: {} })).status === 400);
const ack = await j(`/complaints/${id}/acknowledge`, { token: A, method: 'POST', body: { method: 'Telephone', note: 'Spoke to Dr Mensah' } });
check('acknowledging succeeds', ack.status === 200, JSON.stringify(ack.json));
let detail = (await j(`/complaints/${id}`, { token: A })).json;
check('the record shows when and how', !!detail.acknowledged_at && detail.acknowledgement_method === 'Telephone');
check('and moves to acknowledged', detail.stage === 'acknowledged', detail.stage);
check('acknowledging twice is refused',
  (await j(`/complaints/${id}/acknowledge`, { token: A, method: 'POST', body: { method: 'Email' } })).status === 400);

console.log('\n[3] Closing early is refused — the clause is not optional');
const earlyClose = await j(`/complaints/${id}/close`, { token: A, method: 'POST', body: { closureSummary: 'Sorted it out' } });
check('a complaint with no review cannot be closed', earlyClose.status === 400 && /review/i.test(earlyClose.json.error), JSON.stringify(earlyClose.json));

console.log('\n[4] Investigation, then an independent review');
await j(`/complaints/${id}/assign`, { token: A, method: 'POST', body: { assignedToStaffId: investigator.id } });
detail = (await j(`/complaints/${id}`, { token: A })).json;
check('assigning moves it to under investigation', detail.stage === 'under_investigation', detail.stage);
const noReview = await j(`/complaints/${id}/review`, { token: A, method: 'POST', body: { outcome: 'upheld', reviewedByStaffId: reviewer.id } });
check('reviewing before there are findings is refused', noReview.status === 400 && /nothing to review/i.test(noReview.json.error), JSON.stringify(noReview.json));
const partial = await j(`/complaints/${id}/investigate`, { token: A, method: 'POST', body: { investigationSummary: 'Analyser down for 4 hours.', sendForReview: true } });
check('sending for review without a correction is refused', partial.status === 400 && /correction/i.test(partial.json.error), JSON.stringify(partial.json));
const investigated = await j(`/complaints/${id}/investigate`, { token: A, method: 'POST', body: {
  investigationSummary: 'Analyser down for 4 hours; no backup route in place.',
  rootCause: 'No documented contingency for haematology analyser failure.',
  correction: 'Samples referred to the district laboratory; clinician informed.',
  sendForReview: true,
} });
check('findings plus a correction send it for review', investigated.status === 200 && investigated.json.stage === 'awaiting_review', JSON.stringify(investigated.json));

const selfReview = await j(`/complaints/${id}/review`, { token: A, method: 'POST', body: { outcome: 'upheld', reviewedByStaffId: investigator.id } });
check('the investigator cannot review their own complaint', selfReview.status === 400 && /not involved/i.test(selfReview.json.error), JSON.stringify(selfReview.json));
const noDecision = await j(`/complaints/${id}/review`, { token: A, method: 'POST', body: { reviewedByStaffId: reviewer.id } });
check('a review without a decision is refused', noDecision.status === 400, JSON.stringify(noDecision.json));
const reviewed = await j(`/complaints/${id}/review`, { token: A, method: 'POST', body: {
  outcome: 'upheld', reviewedByStaffId: reviewer.id, notes: 'Delay confirmed; contingency plan required.',
} });
check('an uninvolved colleague can review it', reviewed.status === 200 && reviewed.json.outcome === 'upheld', JSON.stringify(reviewed.json));
detail = (await j(`/complaints/${id}`, { token: A })).json;
check('the decision is on the record', detail.outcome === 'upheld' && !!detail.reviewed_at);
check('and it now owes the complainant an answer', detail.stage === 'outcome_pending', detail.stage);

console.log('\n[5] The complainant is told, and only then can it close');
const stillEarly = await j(`/complaints/${id}/close`, { token: A, method: 'POST', body: { closureSummary: 'Done' } });
check('closing before telling the complainant is refused', stillEarly.status === 400 && /complainant/i.test(stillEarly.json.error), JSON.stringify(stillEarly.json));
const told = await j(`/complaints/${id}/communicate-outcome`, { token: A, method: 'POST', body: {
  method: 'Email', summary: 'Complaint upheld; contingency plan being written and a CAPA raised.',
} });
check('the outcome can be communicated', told.status === 200, JSON.stringify(told.json));
const closed = await j(`/complaints/${id}/close`, { token: A, method: 'POST', body: { closureSummary: 'Contingency plan issued; CAPA-1 tracks effectiveness.' } });
check('and then it closes', closed.status === 200, JSON.stringify(closed.json));
detail = (await j(`/complaints/${id}`, { token: A })).json;
check('the record reads closed', detail.stage === 'closed' && detail.status === 'closed');
check('closing twice is refused',
  (await j(`/complaints/${id}/close`, { token: A, method: 'POST', body: { closureSummary: 'again' } })).status === 400);

console.log('\n[6] Everything that was done is on the record');
const events = detail.events || [];
const types = events.map(e => e.event_type);
for (const t of ['received', 'acknowledged', 'assigned', 'sent_for_review', 'reviewed', 'outcome_communicated', 'closed'])
  check(`the trail records "${t}"`, types.includes(t), JSON.stringify(types));
check('each step names who did it', events.every(e => e.actor_user_id || e.actor_staff_id));
check('and when', events.every(e => !!e.created_at));

console.log('\n[7] A complaint can also be withdrawn');
const w = await j('/complaints', { token: A, method: 'POST', body: {
  receivedDate: '2026-08-20', complainantType: 'Patient', category: 'Billing',
  title: `Withdrawn ${stamp}`, description: 'Raised then withdrawn.',
} });
check('withdrawing needs a reason', (await j(`/complaints/${w.json.id}/withdraw`, { token: A, method: 'POST', body: {} })).status === 400);
const withdrawn = await j(`/complaints/${w.json.id}/withdraw`, { token: A, method: 'POST', body: { reason: 'Complainant withdrew after the result was explained.' } });
check('and then it closes as withdrawn', withdrawn.status === 200
  && (await j(`/complaints/${w.json.id}`, { token: A })).json.stage === 'withdrawn');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
