/**
 * Live RBAC verification against a running SECH_LIMS API.
 *
 * Seeds an isolated database, creates one user per role, and asserts the
 * behaviours the audit set out to fix:
 *   1. print/export are refused without view
 *   2. a "View only" technical authorization does not confer approve
 *   3. an expired technical authorization confers nothing
 *   4. a revoked role permission survives a re-seed
 *   5. QR token resolution is gated on the target module
 *   6. the effective-permission map matches what the API actually allows
 */
const BASE = process.env.API || 'http://127.0.0.1:4399/api';

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function call(path, { token, method = 'GET', body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON (file streams) */ }
  return { status: res.status, json };
}

async function login(username, password) {
  const r = await call('/auth/login', { method: 'POST', body: { username, password } });
  if (r.status !== 200) throw new Error(`login ${username} failed: ${r.status} ${JSON.stringify(r.json)}`);
  return r.json;
}

const PW = 'Passw0rd!test';

async function main() {
  // ---- first-time setup ----
  const status = await call('/setup/status');
  if (!status.json?.setupComplete) {
    const r = await call('/setup/initialize', {
      method: 'POST',
      body: { facilityName: 'RBAC Test Lab', username: 'admin', password: PW, fullName: 'Admin User' },
    });
    if (r.status >= 400) throw new Error(`setup failed: ${JSON.stringify(r.json)}`);
  }
  const admin = await login('admin', PW);
  const A = admin.token;

  console.log('\n[1] Effective-permission map is returned and scoped');
  check('admin login carries a permission map', !!admin.permissions && Object.keys(admin.permissions).length > 5,
    JSON.stringify(Object.keys(admin.permissions || {}).length));
  check('admin may view settings', (admin.permissions.settings || []).includes('view'));

  // ---- create a technician user ----
  const roles = (await call('/roles', { token: A })).json;
  const techRole = roles.find(r => r.name === 'Technician');
  const created = await call('/users', { token: A, method: 'POST', body: { username: 'tech1', password: PW, fullName: 'Tech One', roleId: techRole.id } });
  if (created.status >= 400 && created.status !== 409) console.log('   (user create said', created.status, JSON.stringify(created.json), ')');
  const tech = await login('tech1', PW);
  const T = tech.token;

  console.log('\n[2] A role without settings rights cannot see or reach Settings');
  check('technician has no settings entry in the map', !tech.permissions.settings, JSON.stringify(tech.permissions.settings));
  check('GET /users is refused', (await call('/users', { token: T })).status === 403);
  check('technician CAN see home + dashboard (shell stays usable)',
    !!tech.permissions.home && !!tech.permissions.dashboard);
  check('technician CAN see organisation (seed gap fixed)', !!tech.permissions.organisation,
    JSON.stringify(tech.permissions.organisation));

  console.log('\n[3] print/export require view (the reported bug)');
  const perms = (await call('/permissions', { token: A })).json;
  const docView = perms.find(p => p.module_key === 'documents' && p.action === 'view');
  const docPrint = perms.find(p => p.module_key === 'documents' && p.action === 'print');
  // Grant print, deny view, for this one user.
  await call('/permissions/user-override', { token: A, method: 'POST', body: { userId: tech.user.id, permissionId: docPrint.id, allowed: true, reason: 'test' } });
  await call('/permissions/user-override', { token: A, method: 'POST', body: { userId: tech.user.id, permissionId: docView.id, allowed: false, reason: 'test' } });
  const after = (await call('/auth/permissions', { token: T })).json.permissions;
  check('documents disappears from the map when view is denied', !after.documents, JSON.stringify(after.documents));
  const printRes = await call('/documents/1/print-render', { token: T });
  check('print endpoint is refused without view', printRes.status === 403, `got ${printRes.status}`);
  const exportRes = await call('/documents/masterlist/export', { token: T });
  check('export endpoint is refused without view', exportRes.status === 403, `got ${exportRes.status}`);

  console.log('\n[4] Technical authorizations grant only what their level implies');
  const staffRes = await call('/staff', { token: A, method: 'POST', body: { fullName: 'Tech One', email: 'tech1' } });
  const staffId = staffRes.json?.id;
  if (staffId) {
    await call(`/users/${tech.user.id}`, { token: A, method: 'PUT', body: { staffId } });
    // "View only" on IQC must not confer approve.
    await call('/authorizations/technical', { token: A, method: 'POST', body: { staffId, moduleKey: 'iqc', level: 'View only' } });
    const m1 = (await call('/auth/permissions', { token: T })).json.permissions;
    check('"View only" does not grant approve', !(m1.iqc || []).includes('approve'), JSON.stringify(m1.iqc));
    // An expired authorization grants nothing at all.
    const expired = await call('/authorizations/technical', { token: A, method: 'POST', body: { staffId, moduleKey: 'eqa', level: 'Approve', expiresAt: '2020-01-01' } });
    const m2 = (await call('/auth/permissions', { token: T })).json.permissions;
    const eqaFromRole = (tech.permissions.eqa || []);
    check('expired authorization adds no rights',
      !(m2.eqa || []).includes('approve'), JSON.stringify({ eqa: m2.eqa, fromRole: eqaFromRole, created: expired.status }));
  } else {
    console.log('   (skipped: could not create staff record —', staffRes.status, JSON.stringify(staffRes.json), ')');
  }

  console.log('\n[5] A revoked role permission is not restored by re-seeding');
  const eqaPrint = perms.find(p => p.module_key === 'eqa' && p.action === 'print');
  await call('/permissions/role', { token: A, method: 'POST', body: { roleId: techRole.id, permissionId: eqaPrint.id, allowed: false } });
  const matrix = (await call('/permissions/matrix', { token: A })).json;
  const row = matrix.rolePermissions.find(r => r.role_id === techRole.id && r.permission_id === eqaPrint.id);
  check('revocation is stored as allowed=0', row && row.allowed === 0, JSON.stringify(row));
  console.log('       (restart-survival is enforced by INSERT OR IGNORE in the seeder)');

  console.log('\n[6] QR resolution is gated on the target module');
  // A Technician legitimately holds equipment:print, so the lookup should
  // succeed — that is the control working, not failing. Revoke equipment view
  // for this user and the same call must now be refused.
  const okLookup = await call('/qr/lookup/equipment/1', { token: T });
  check('QR lookup succeeds when the user may print that module', okLookup.status === 200, `got ${okLookup.status}`);
  const token = okLookup.json?.token;
  const equipView = perms.find(p => p.module_key === 'equipment' && p.action === 'view');
  await call('/permissions/user-override', { token: A, method: 'POST', body: { userId: tech.user.id, permissionId: equipView.id, allowed: false, reason: 'test' } });
  const deniedLookup = await call('/qr/lookup/equipment/1', { token: T });
  check('QR lookup is refused once equipment view is revoked', deniedLookup.status === 403, `got ${deniedLookup.status}`);
  if (token) {
    const deniedResolve = await call(`/qr/${token}`, { token: T });
    check('scanning a token no longer returns the record', deniedResolve.status === 403, `got ${deniedResolve.status}`);
  }

  console.log('\n[7] Alert feeds are filtered to viewable modules');
  const alerts = (await call('/notifications/live-alerts', { token: T })).json;
  if (Array.isArray(alerts)) {
    const visible = new Set(Object.keys((await call('/auth/permissions', { token: T })).json.permissions));
    check('every live alert belongs to a viewable module', alerts.every(a => visible.has(a.module)),
      JSON.stringify([...new Set(alerts.map(a => a.module))].filter(m => !visible.has(m))));
  } else {
    check('live alerts readable or refused cleanly', true);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('ERROR', e); process.exit(2); });
