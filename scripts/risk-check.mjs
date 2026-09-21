/**
 * Risk management — the staged lifecycle, end to end.
 *
 *   node scripts/risk-check.mjs
 *
 * A risk is identified, analysed on the laboratory's 5x5 matrix, evaluated
 * against its own criteria, treated with controls, re-scored, accepted by an
 * authorised officer and reviewed on the cycle its band decides. Each step is
 * checked here, including the refusals — a rule that can be skipped is not a
 * control. The configurable criteria are checked by changing them and watching
 * the same scores land in different bands.
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';

const BASE = process.env.API || 'http://127.0.0.1:4421/api';
const DATA_DIR = process.env.SECH_LIMS_DATA_DIR || path.join(process.cwd(), 'local-data');
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
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, json };
};

if (!(await j('/setup/status')).json?.setupComplete)
  await j('/setup/initialize', { method: 'POST', body: { facilityName: 'Risk Lab', username: 'admin', password: PW, fullName: 'Admin User' } });
const A = (await j('/auth/login', { method: 'POST', body: { username: 'admin', password: PW } })).json.token;

console.log('\n[1] The laboratory has risk criteria, and they are its own to change');
const c0 = await j('/risks/criteria', { token: A });
check('criteria are served', c0.status === 200 && c0.json.bands?.length === 4, `status ${c0.status}`);
check('the matrix is 5x5', c0.json.likelihood?.length === 5 && c0.json.severity?.length === 5);
check('an acceptance authority is named', (c0.json.acceptanceRoles || []).length > 0);

console.log('\n[2] A risk is identified, and lands in the analysis queue');
const bad = await j('/risks', { token: A, method: 'POST', body: { riskArea: 'No description' } });
check('a risk with no description is refused', bad.status === 400, `status ${bad.status}`);
const created = await j('/risks', { token: A, method: 'POST', body: {
  riskArea: 'Sample mislabelling at reception', riskDescription: 'Specimens may be labelled with the wrong patient identifiers.',
  cause: 'Manual transcription at a busy counter', consequence: 'Wrong result issued against the wrong patient',
  existingControls: 'Two-identifier check at receipt', riskCategory: 'pre_examination', riskSource: 'proactive_assessment',
  affectsPatientSafety: true,
} });
check('the risk is created', created.status === 201 && !!created.json.riskNumber, `status ${created.status}`);
const id = created.json.id;
check('it starts at analysis', created.json.nextStage === 'analysis');

console.log('\n[3] Analysis scores it on the matrix');
const noScore = await j(`/risks/${id}/analysis`, { token: A, method: 'POST', body: { likelihood: 4 } });
check('a half-scored assessment is refused', noScore.status === 400, `status ${noScore.status}`);
const analysed = await j(`/risks/${id}/analysis`, { token: A, method: 'POST', body: { likelihood: 4, severity: 4, analysisNotes: 'Three near misses this year.' } });
check('the score is likelihood x severity', analysed.json.score === 16, `got ${analysed.json.score}`);
check('the band follows the criteria', analysed.json.level === 'high', `got ${analysed.json.level}`);
check('it moves to evaluation', analysed.json.nextStage === 'evaluation');

console.log('\n[4] Evaluation applies the criteria, and cannot be talked out of treatment');
const evaluated = await j(`/risks/${id}/evaluation`, { token: A, method: 'POST', body: { decision: 'accept', evaluationNotes: 'Tried to accept it.' } });
check('a High risk cannot simply be accepted', evaluated.json.decision === 'treat', `got ${evaluated.json.decision}`);
check('the criteria say why', !!evaluated.json.reason);
check('it moves to treatment', evaluated.json.nextStage === 'treatment');

console.log('\n[5] Treatment: a plan, controls, and no shortcut past them');
const noPlan = await j(`/risks/${id}/treatment`, { token: A, method: 'POST', body: { treatmentOption: 'reduce' } });
check('a treatment option with no plan is refused', noPlan.status === 400, `status ${noPlan.status}`);
await j(`/risks/${id}/treatment`, { token: A, method: 'POST', body: {
  treatmentOption: 'reduce', mitigationPlan: 'Barcode labels printed at the point of collection.', treatmentDueDate: '2026-12-31',
} });
const earlyComplete = await j(`/risks/${id}/treatment/complete`, { token: A, method: 'POST', body: {} });
check('treatment cannot complete with no controls recorded', earlyComplete.status === 400, `status ${earlyComplete.status}`);
const control = await j(`/risks/${id}/controls`, { token: A, method: 'POST', body: {
  controlDescription: 'Barcode printers at every collection point', controlType: 'engineering', targetDate: '2026-10-31', createAction: true,
} });
check('a control measure is added', control.status === 201, `status ${control.status}`);
const blocked = await j(`/risks/${id}/treatment/complete`, { token: A, method: 'POST', body: {} });
check('treatment cannot complete while a control is outstanding', blocked.status === 400, `status ${blocked.status}`);
await j(`/risks/${id}/controls/${control.json.id}`, { token: A, method: 'PUT', body: { status: 'implemented', verificationNotes: 'Installed and in use.' } });
const completed = await j(`/risks/${id}/treatment/complete`, { token: A, method: 'POST', body: {} });
check('with every control implemented it moves to residual risk', completed.json.nextStage === 'residual', `got ${completed.json.nextStage}`);

const withAction = await j(`/actions?`, { token: A });
check('the control was raised on the action tracker', Array.isArray(withAction.json) && withAction.json.some(a => a.source_module === 'risks'));

console.log('\n[6] Residual risk is re-scored, and cannot quietly go up');
const worse = await j(`/risks/${id}/residual`, { token: A, method: 'POST', body: { residualLikelihood: 5, residualSeverity: 5 } });
check('a residual score above the initial one is questioned', worse.status === 400, `status ${worse.status}`);
const residual = await j(`/risks/${id}/residual`, { token: A, method: 'POST', body: { residualLikelihood: 2, residualSeverity: 3 } });
check('the residual score is recorded', residual.json.score === 6, `got ${residual.json.score}`);
check('it moves to acceptance', residual.json.nextStage === 'acceptance');

console.log('\n[7] Acceptance is an authorisation, not a button');
const noReason = await j(`/risks/${id}/accept`, { token: A, method: 'POST', body: { decision: 'accepted' } });
check('acceptance without a justification is refused', noReason.status === 400, `status ${noReason.status}`);
const unsigned = await j(`/risks/${id}/accept`, { token: A, method: 'POST', body: { decision: 'accepted', justification: 'Tolerable with barcode labelling in place.' } });
check('acceptance is refused without a signature on file', unsigned.status === 400 && unsigned.json?.code === 'signature_required', `status ${unsigned.status}`);

// Give the administrator a staff record with a signature on file, the way
// Personnel Management would, so the rest of the lifecycle can be exercised.
{
  // A real 1x1 PNG on disk, because a signature the report cannot load is
  // indistinguishable from one that was never applied.
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'uploads', 'sig-test.png'), PNG);
  const db = new Database(path.join(DATA_DIR, 'sech_lims.sqlite'));
  const file = db.prepare("INSERT INTO files (original_name, stored_name, mime_type, size_bytes, storage_area) VALUES ('sig.png', 'sig-test.png', 'image/png', ?, 'uploads')").run(PNG.length);
  const staff = db.prepare("INSERT INTO staff (employee_no, full_name, first_name, surname, signature_file_id) VALUES ('RISK-AUTH', 'Admin User', 'Admin', 'User', ?)").run(file.lastInsertRowid);
  db.prepare('UPDATE users SET staff_id = ? WHERE username = ?').run(staff.lastInsertRowid, 'admin');
  db.close();
}
const B = (await j('/auth/login', { method: 'POST', body: { username: 'admin', password: PW } })).json.token;

const accepted = await j(`/risks/${id}/accept`, { token: B, method: 'POST', body: { decision: 'accepted', justification: 'Residual risk is tolerable with barcode labelling in place.' } });
check('the risk is accepted once it can be signed', accepted.status === 200 && accepted.json.decision === 'accepted', JSON.stringify(accepted.json));
check('it moves to monitoring', accepted.json.nextStage === 'monitoring', `got ${accepted.json.nextStage}`);
check('a review is scheduled from its band', !!accepted.json.reviewDueDate, JSON.stringify(accepted.json));

const signed = await j(`/risks/${id}`, { token: B });
check('the acceptance is on the record as a signature', (signed.json.signatures || []).some(x => x.purpose === 'risk_acceptance'));
check('the accepting officer is named', !!signed.json.accepted_by_name, JSON.stringify(signed.json.accepted_by_name));

console.log('\n[7b] Monitoring reviews the risk, and can send it back');
const noNotes = await j(`/risks/${id}/review`, { token: B, method: 'POST', body: { outcome: 'unchanged' } });
check('a review with no notes is refused', noNotes.status === 400, `status ${noNotes.status}`);
const reviewed = await j(`/risks/${id}/review`, { token: B, method: 'POST', body: { outcome: 'unchanged', reviewNotes: 'Barcode labelling still in use; no further near misses.' } });
check('the review is recorded', reviewed.status === 201, `status ${reviewed.status}`);
check('the next review is scheduled', !!reviewed.json.nextReviewDate);
check('it stays in monitoring', reviewed.json.nextStage === 'monitoring', `got ${reviewed.json.nextStage}`);
const reassessed = await j(`/risks/${id}/review`, { token: B, method: 'POST', body: { outcome: 'reassess', reviewNotes: 'New analyser changes the picture.' } });
check('a changed picture sends the risk back for re-analysis', reassessed.json.nextStage === 'analysis', `got ${reassessed.json.nextStage}`);

console.log('\n[7c] Handling is proportionate to the size of the risk');
const low = await j('/risks', { token: B, method: 'POST', body: { riskArea: 'Label printer ribbon runs low', riskDescription: 'A ribbon runs out and a label prints faint.' } });
await j(`/risks/${low.json.id}/analysis`, { token: B, method: 'POST', body: { likelihood: 2, severity: 1 } });
const lowEval = await j(`/risks/${low.json.id}/evaluation`, { token: B, method: 'POST', body: { decision: 'accept' } });
check('a low risk may be retained without control', lowEval.json.decision === 'accept', JSON.stringify(lowEval.json));
check('and goes straight to acceptance', lowEval.json.nextStage === 'acceptance', `got ${lowEval.json.nextStage}`);
const lowAccept = await j(`/risks/${low.json.id}/accept`, { token: B, method: 'POST', body: { decision: 'accepted', justification: 'Tolerable; caught by the daily printer check.' } });
check('a low risk closes on acceptance instead of entering the review cycle', lowAccept.json.closed === true && lowAccept.json.nextStage === 'closed', JSON.stringify(lowAccept.json));
const lowRow = await j(`/risks/${low.json.id}`, { token: B });
check('it is closed, with the acceptance as its closure', lowRow.json.status === 'closed' && !!lowRow.json.closed_at);
check('and carries no review date', !lowRow.json.review_due_date);
const inRegister = (await j('/risks', { token: B })).json.some(x => x.id === low.json.id);
check('a closed risk is still in the register', inRegister);

console.log('\n[7d] "Other" always says what it was');
const vagueWho = await j('/risks', { token: B, method: 'POST', body: { riskArea: 'x', riskDescription: 'y', identifiedByStaffId: 'other' } });
check('an external identifier with no name is refused', vagueWho.status === 400, `status ${vagueWho.status}`);
const vagueCat = await j('/risks', { token: B, method: 'POST', body: { riskArea: 'x', riskDescription: 'y', riskCategory: 'other' } });
check('a category of "other" with nothing specified is refused', vagueCat.status === 400, `status ${vagueCat.status}`);
const external = await j('/risks', { token: B, method: 'POST', body: {
  riskArea: 'Uncontrolled copy of a method in use', riskDescription: 'A superseded printout was found at the bench.',
  identifiedByStaffId: 'other', identifiedByOther: 'External assessor, ABC Accreditation',
  riskCategory: 'other', riskCategoryOther: 'Document control', riskSource: 'other', riskSourceOther: 'Surveillance visit',
} });
check('a risk found by an external party is accepted', external.status === 201, JSON.stringify(external.json));
const ext = (await j(`/risks/${external.json.id}`, { token: B })).json;
check('and names who found it', ext.identified_by_other === 'External assessor, ABC Accreditation', ext.identified_by_other);
check('and says what the category was', ext.risk_category_other === 'Document control', ext.risk_category_other);
check('and says what the source was', ext.risk_source_other === 'Surveillance visit', ext.risk_source_other);

console.log('\n[8] The criteria really are the laboratory\'s own');
const patched = await j('/risks/criteria', { token: A, method: 'PUT', body: {
  bands: [
    { label: 'Negligible', max: 2, color: '#1a7f37', action: 'Monitor.', reviewMonths: 0 },
    { label: 'Tolerable', max: 6, color: '#c9a227', action: 'Control where practicable.', reviewMonths: 6 },
    { label: 'Serious', max: 12, color: '#e8590c', action: 'Treatment plan required.', reviewMonths: 3 },
    { label: 'Intolerable', max: 25, color: '#c1121f', action: 'Stop the activity.', reviewMonths: 1 },
  ],
  likelihood: c0.json.likelihood.map((s, i) => ({ ...s, label: i === 0 ? 'Very rare' : s.label })),
} });
check('the criteria save', patched.status === 200, `status ${patched.status}`);
check('band boundaries are respected', patched.json.bands[1].min === 3 && patched.json.bands[1].max === 6, JSON.stringify(patched.json.bands?.[1]));
check('the top band still reaches 25', patched.json.bands[3].max === 25);
check('a renamed scale step sticks', patched.json.likelihood[0].label === 'Very rare');

const second = await j('/risks', { token: A, method: 'POST', body: { riskArea: 'Reagent stock-out', riskDescription: 'Critical reagent runs out mid-run.' } });
const rescored = await j(`/risks/${second.json.id}/analysis`, { token: A, method: 'POST', body: { likelihood: 2, severity: 4 } });
check('the same score now falls in the new band', rescored.json.score === 8 && rescored.json.levelLabel === 'Serious', `${rescored.json.score} ${rescored.json.levelLabel}`);

console.log('\n[8b] A band may be set to close on acceptance');
check('a zero review cycle is kept', patched.json.bands[0].reviewMonths === 0, String(patched.json.bands[0].reviewMonths));

console.log('\n[9] The register reports on itself');
const summary = await j('/risks/summary', { token: A });
check('a summary is served', summary.status === 200 && summary.json.total >= 2, `status ${summary.status}`);
const detail = await j(`/risks/${id}`, { token: A });
check('a risk carries its controls, reviews and signatures', Array.isArray(detail.json.controls) && Array.isArray(detail.json.reviews) && Array.isArray(detail.json.signatures));
const printed = await fetch(`${BASE}/risks/${id}/print`, { headers: { Authorization: `Bearer ${A}` } });
const html = await printed.text();
check('the risk prints as a full report', printed.status === 200 && html.includes('Risk Assessment Report'), `status ${printed.status}`);
check('the report carries its authorisations', html.includes('Authorisations') && html.includes('Residual risk accepted'));
check('the report carries the matrix and both scores', html.includes('Likelihood') && html.includes('Residual risk'));
const lowReport = await (await fetch(`${BASE}/risks/${low.json.id}/print`, { headers: { Authorization: `Bearer ${B}` } })).text();
check('the person who identified the risk signed for it',
  lowReport.includes('Identified by') && /Identified by[\s\S]{0,400}?<img src="data:/.test(lowReport));
check('no field is printed with a bare dash', !/<span class="vl">\s*—\s*<\/span>/.test(html));
check('no empty box is printed', !/<div class="box"><\/div>/.test(html));

// A risk accepted without control measures must not print a control section,
// an empty control table, or a signature line for work nobody did.
const lowHtml = await (await fetch(`${BASE}/risks/${low.json.id}/print`, { headers: { Authorization: `Bearer ${B}` } })).text();
check('a risk with no controls prints no control section', !lowHtml.includes('Risk Control'), 'control section present');
check('and no control signature block', !lowHtml.includes('Control measures implemented'));
check('and no "no control measures recorded" filler', !lowHtml.includes('No control measures'));
check('and no empty linked-records table', !lowHtml.includes('No linked records'));
check('but still prints its acceptance', lowHtml.includes('Residual Risk and Acceptability'));
check('and its closure', lowHtml.includes('Closure'));
const xlsx = await fetch(`${BASE}/risks/register/export`, { headers: { Authorization: `Bearer ${A}` } });
check('the register exports to Excel', xlsx.status === 200 && (xlsx.headers.get('content-type') || '').includes('spreadsheet'), `status ${xlsx.status}`);
const regPrint = await fetch(`${BASE}/risks/register/print`, { headers: { Authorization: `Bearer ${A}` } });
check('the register prints', regPrint.status === 200);

console.log('\n[9b] A risk can be deleted, but only by an administrator and only with a reason');
const noReasonDel = await j(`/risks/${external.json.id}`, { token: B, method: 'DELETE', body: { reason: 'oops' } });
check('a thin reason is refused', noReasonDel.status === 400, `status ${noReasonDel.status}`);
const deleted = await j(`/risks/${external.json.id}`, { token: B, method: 'DELETE', body: { reason: 'Logged twice by mistake during the surveillance visit.' } });
check('with a reason an administrator may delete it', deleted.status === 200, JSON.stringify(deleted.json));
check('and it is gone from the register', !(await j('/risks', { token: B })).json.some(x => x.id === external.json.id));

console.log('\n[10] The same matrix governs nonconformities');
const ncMatrix = await j('/nonconformities/risk-matrix', { token: A });
check('the nonconformity matrix is the configured one', ncMatrix.json.bands?.[3]?.label === 'Intolerable', JSON.stringify(ncMatrix.json.bands?.[3]));

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
