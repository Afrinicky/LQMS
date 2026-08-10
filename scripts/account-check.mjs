/**
 * Account management: administrator-approved password reset, and removing a
 * user. Exercises the security properties, not just the happy path.
 *
 *   node scripts/account-check.mjs
 */
const BASE = process.env.API || 'http://127.0.0.1:4420/api';
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
const login = (u, p = PW) => j('/auth/login', { method: 'POST', body: { username: u, password: p } });

const st = await j('/setup/status');
if (!st.json?.setupComplete) await j('/setup/initialize', { method: 'POST', body: { facilityName: 'Account Lab', username: 'admin', password: PW, fullName: 'Admin User' } });
const A = (await login('admin')).json.token;
const roles = (await j('/roles', { token: A })).json;
const techRole = roles.find(r => r.name === 'Technician');

const mk = async (username, fullName) => {
  await j('/users', { token: A, method: 'POST', body: { username, password: PW, fullName, roleId: techRole.id } });
  return (await j('/users', { token: A })).json.find(u => u.username === username);
};

console.log('\n[1] Asking from the sign-in screen reveals nothing about who exists');
const target = await mk('reset_target', 'Reset Target');
const realReq = await j('/auth/password-reset/request', { method: 'POST', body: { username: 'reset_target', reason: 'At the bench' } });
const fakeReq = await j('/auth/password-reset/request', { method: 'POST', body: { username: 'no_such_person_at_all' } });
check('a real account gets a claim token', realReq.status === 200 && !!realReq.json.claimToken);
check('an unknown account answers identically', fakeReq.status === 200 && !!fakeReq.json.claimToken);
const realStatus = await j(`/auth/password-reset/status?claim=${realReq.json.claimToken}`);
const fakeStatus = await j(`/auth/password-reset/status?claim=${fakeReq.json.claimToken}`);
check('both report "pending" — no enumeration', realStatus.json.status === 'pending' && fakeStatus.json.status === 'pending',
  `${realStatus.json.status} / ${fakeStatus.json.status}`);

console.log('\n[2] Only a real request reaches an administrator');
const queue = await j('/users/password-resets', { token: A });
const names = (queue.json.pending || []).map(r => r.requested_username);
check('the real request is queued', names.includes('reset_target'));
check('the unknown one is not', !names.includes('no_such_person_at_all'), JSON.stringify(names));
check('the administrator was notified', (await j('/notifications?mine=true', { token: A })).json.some(n => n.record_type === 'password_reset_requests'));

console.log('\n[3] No token before approval; the reset is refused');
check('status carries no reset token while pending', !realStatus.json.resetToken);
const early = await j('/auth/password-reset/complete', { method: 'POST', body: { resetToken: 'guessed-token', newPassword: 'BrandNew1!' } });
check('a guessed token is refused', early.status === 400, `got ${early.status}`);

console.log('\n[4] Approval opens it, for that browser only');
const requestId = queue.json.pending.find(r => r.requested_username === 'reset_target').id;
const decided = await j(`/users/password-resets/${requestId}/decide`, { token: A, method: 'POST', body: { decision: 'approve' } });
check('the administrator can approve', decided.status === 200, JSON.stringify(decided.json));
const afterApproval = await j(`/auth/password-reset/status?claim=${realReq.json.claimToken}`);
check('the waiting browser now receives a reset token', afterApproval.json.status === 'approved' && !!afterApproval.json.resetToken);
const otherBrowser = await j(`/auth/password-reset/status?claim=${fakeReq.json.claimToken}`);
check('a different browser learns nothing', !otherBrowser.json.resetToken);

console.log('\n[5] Setting the new password');
const rt = afterApproval.json.resetToken;
const tooShort = await j('/auth/password-reset/complete', { method: 'POST', body: { resetToken: rt, newPassword: 'abc' } });
check('a short password is refused', tooShort.status === 400);
const done = await j('/auth/password-reset/complete', { method: 'POST', body: { resetToken: rt, newPassword: 'copper lantern ninety' } });
check('the new password is accepted', done.status === 200, JSON.stringify(done.json));
check('the old password no longer works', (await login('reset_target', PW)).status === 401);
check('the new password works', (await login('reset_target', 'copper lantern ninety')).status === 200);

console.log('\n[6] An approval is single use');
const replay = await j('/auth/password-reset/complete', { method: 'POST', body: { resetToken: rt, newPassword: 'AnotherOne9!' } });
check('replaying the same token is refused', replay.status === 400, `got ${replay.status}`);

console.log('\n[7] Refusing a request');
const denyTarget = await mk('deny_target', 'Deny Target');
const denyReq = await j('/auth/password-reset/request', { method: 'POST', body: { username: 'deny_target' } });
const denyQueue = await j('/users/password-resets', { token: A });
const denyId = denyQueue.json.pending.find(r => r.requested_username === 'deny_target').id;
await j(`/users/password-resets/${denyId}/decide`, { token: A, method: 'POST', body: { decision: 'deny', note: 'Could not confirm identity' } });
const denied = await j(`/auth/password-reset/status?claim=${denyReq.json.claimToken}`);
check('the requester is told it was refused', denied.json.status === 'denied', denied.json.status);
check('the refusal note is passed on', denied.json.note === 'Could not confirm identity');
check('their password is unchanged', (await login('deny_target', PW)).status === 200);

console.log('\n[8] Only an approver may decide');
const techToken = (await login('reset_target', 'copper lantern ninety')).json.token;
check('a Technician cannot see the queue', (await j('/users/password-resets', { token: techToken })).status === 403);
const sneak = await j('/auth/password-reset/request', { method: 'POST', body: { username: 'deny_target' } });
const sneakQueue = await j('/users/password-resets', { token: A });
const sneakId = sneakQueue.json.pending.find(r => r.requested_username === 'deny_target')?.id;
check('a Technician cannot approve one', sneakId ? (await j(`/users/password-resets/${sneakId}/decide`, { token: techToken, method: 'POST', body: { decision: 'approve' } })).status === 403 : true);

console.log('\n[9] Rate limiting');
let throttledSeen = false;
for (let i = 0; i < 6; i++) {
  const r = await j('/auth/password-reset/request', { method: 'POST', body: { username: 'flood_target' } });
  const s = await j(`/auth/password-reset/status?claim=${r.json.claimToken}`);
  if (s.json.status !== 'pending') throttledSeen = true;
}
const floodQueue = await j('/users/password-resets', { token: A });
const floodCount = floodQueue.json.pending.filter(r => r.requested_username === 'flood_target').length;
check('a flood does not bury the administrator', floodCount <= 3, `${floodCount} queued`);
check('throttled requests still look pending to the caller', !throttledSeen);

console.log('\n[10] Administrator-initiated change');
const forced = await mk('forced_user', 'Forced User');
await j(`/users/${forced.id}/require-password-change`, { token: A, method: 'POST', body: {} });
const forcedLogin = await login('forced_user');
check('they can still sign in', forcedLogin.status === 200);
check('and are flagged to choose a new password', forcedLogin.json.user.mustChangePassword === true, JSON.stringify(forcedLogin.json.user.mustChangePassword));
await j('/auth/change-password', { token: forcedLogin.json.token, method: 'POST', body: { currentPassword: PW, newPassword: 'fresh meadow ninety' } });
check('changing it clears the flag', (await login('forced_user', 'fresh meadow ninety')).json.user.mustChangePassword === false);

const temp = await mk('temp_user', 'Temp User');
await j(`/users/${temp.id}/reset-password`, { token: A, method: 'POST', body: { newPassword: 'handover willow gate' } });
const tempLogin = await login('temp_user', 'handover willow gate');
check('a temporary password also forces a change', tempLogin.json.user.mustChangePassword === true);

console.log('\n[11] Removing an account');
const fresh = await mk('never_used', 'Never Used');
const impact = await j(`/users/${fresh.id}/deletion-impact`, { token: A });
check('an unused account may be erased', impact.json.canDelete === true, JSON.stringify(impact.json.historicReferences));
const erased = await j(`/users/${fresh.id}?mode=delete`, { token: A, method: 'DELETE' });
check('erasing it succeeds', erased.status === 200, JSON.stringify(erased.json));
check('it is gone from the list', !(await j('/users', { token: A })).json.some(u => u.username === 'never_used'));

const usedImpact = await j(`/users/${target.id}/deletion-impact`, { token: A });
check('an account with history may NOT be erased', usedImpact.json.canDelete === false, JSON.stringify(usedImpact.json.historicReferences));
const refused = await j(`/users/${target.id}?mode=delete`, { token: A, method: 'DELETE' });
check('the server refuses and explains', refused.status === 409, `got ${refused.status}`);
const deact = await j(`/users/${target.id}`, { token: A, method: 'DELETE' });
check('but it can be deactivated', deact.status === 200);
check('and then cannot sign in', (await login('reset_target', 'copper lantern ninety')).status === 401);
const react = await j(`/users/${target.id}/reactivate`, { token: A, method: 'POST', body: {} });
check('reactivating restores access', react.status === 200 && (await login('reset_target', 'copper lantern ninety')).status === 200);

console.log('\n[12] The administrator cannot lock the laboratory out');
const me = (await j('/users', { token: A })).json.find(u => u.username === 'admin');
check('you cannot remove your own account', (await j(`/users/${me.id}`, { token: A, method: 'DELETE' })).status === 400);
const selfImpact = await j(`/users/${me.id}/deletion-impact`, { token: A });
check('and the screen says why', selfImpact.json.blockers.length > 0, JSON.stringify(selfImpact.json.blockers));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
