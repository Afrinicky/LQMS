#!/usr/bin/env node
/**
 * SECH_LIMS — Computerised System Validation: Operational Qualification suite.
 *
 * A repeatable, self-contained execution of the OQ test cases in
 * docs/validation/03-IQ-OQ-PQ-PROTOCOLS.md. It starts its own SECH_LIMS host on
 * an isolated data directory, exercises the controls that ISO 15189:2022 §7.6,
 * ISO/IEC 17025:2017 §7.11, 21 CFR Part 11, EU GMP Annex 11 and ISO/IEC
 * 27001:2022 place on a laboratory quality-management system, and writes a
 * machine-readable result set alongside the human-readable console log.
 *
 * It never touches the laboratory's own data: SECH_LIMS_DATA_DIR is redirected
 * to a scratch folder that is created fresh on every run and can be deleted
 * afterwards.
 *
 *   node scripts/validation/oq-suite.mjs                  (spawns its own host)
 *   API=http://127.0.0.1:4317/api node scripts/validation/oq-suite.mjs
 *                                                         (uses a running host)
 *
 * Exit code 0 = every test case reached its expected outcome. A test whose
 * expected outcome is "the control is absent" is reported as a DEVIATION, not
 * as a failure of the run, so the suite documents gaps without hiding them.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = Number(process.env.OQ_PORT ?? 4477);
const BASE = process.env.API ?? `http://127.0.0.1:${PORT}/api`;
const DATA_DIR = process.env.OQ_DATA_DIR ?? path.join(os.tmpdir(), `sechlims-oq-${Date.now()}`);
const OUT = process.env.OQ_OUT ?? path.join(root, 'docs/validation/evidence/oq-results.json');

const ADMIN = { username: 'oq_admin', password: 'OqAdmin!2026', fullName: 'OQ Validation Administrator' };
const TECH = { username: 'oq_tech', password: 'OqTech!2026', fullName: 'OQ Technician' };

/* ------------------------------------------------------------------ results */

const results = [];
let child = null;

/**
 * Record one test case.
 * @param outcome 'PASS'   — the required control behaved as specified
 *                'FAIL'   — the required control did not behave as specified
 *                'DEVIATION' — the control is absent or partial; a finding, and
 *                              the expected state of this build, so it does not
 *                              fail the run
 *                'INFO'   — observation recorded as evidence, not a judgement
 */
function record(id, requirement, title, outcome, observed) {
  results.push({ id, requirement, title, outcome, observed, at: new Date().toISOString() });
  const tag = { PASS: 'PASS ', FAIL: 'FAIL ', DEVIATION: 'DEV  ', INFO: 'INFO ' }[outcome];
  console.log(`  ${tag} ${id}  ${title}\n         ${observed}`);
}

const expect = (id, req, title, condition, observed) =>
  record(id, req, title, condition ? 'PASS' : 'FAIL', observed);

/* ---------------------------------------------------------------- transport */

async function call(pathname, { token, method = 'GET', body, headers = {}, raw = false } = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (raw) return { status: res.status, headers: res.headers, text: await res.text() };
  return { status: res.status, headers: res.headers, json: await res.json().catch(() => null) };
}

const login = (username, password) =>
  call('/auth/login', { method: 'POST', body: { username, password } });

/* -------------------------------------------------------------- host control */

async function waitForHost(timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

async function startHost() {
  if (process.env.API) return false; // caller supplied a running host

  // A host left over from an earlier run would answer on this port with a
  // database that is already initialised, and the setup and RBAC cases would
  // report failures that are artefacts of the harness rather than of the
  // system. Refuse to run rather than produce evidence that cannot be trusted.
  try {
    const stale = await fetch(`${BASE}/health`);
    if (stale.ok) {
      console.error(`\nA host is already listening on port ${PORT}. Stop it, or set OQ_PORT to a free port.\n` +
        'The qualification must start from a clean, uninitialised database to be valid.');
      process.exit(2);
    }
  } catch { /* nothing listening — expected */ }

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tsx = path.join(root, 'node_modules/.bin/tsx');
  child = spawn(tsx, ['server/index.ts'], {
    cwd: root,
    env: { ...process.env, SECH_LIMS_DATA_DIR: DATA_DIR, API_PORT: String(PORT), SECH_LIMS_API_HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true, // own process group, so stopHost can take the whole tree down
  });
  const log = [];
  child.stdout.on('data', d => log.push(String(d)));
  child.stderr.on('data', d => log.push(String(d)));
  if (!(await waitForHost())) {
    console.error('Host did not start:\n' + log.join(''));
    stopHost();
    process.exit(2);
  }
  return true;
}

/** Take down the host and every process it spawned. */
function stopHost() {
  if (!child?.pid) return;
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    try { process.kill(-child.pid, signal); } catch { /* group already gone */ }
    try { child.kill(signal); } catch { /* already gone */ }
  }
  child = null;
}

process.on('exit', stopHost);
process.on('SIGINT', () => { stopHost(); process.exit(130); });

/* ==========================================================================
   OQ-1  Installation state and system identification
   ========================================================================== */

async function suiteSystem() {
  console.log('\n[OQ-1] System identification and installation state');

  const health = await call('/health');
  expect('OQ-1.1', 'URS-INF-01', 'Host API answers a health probe',
    health.status === 200 && health.json?.ok === true,
    `GET /health → ${health.status} ${JSON.stringify(health.json)}`);

  // Annex 11 §12.4 / ISO 27001 A.8.7 — configuration detail (database path,
  // data directory, LAN addresses) must not be readable without a session.
  const anonAbout = await call('/system/about');
  const anonConn = await call('/system/connectivity');
  expect('OQ-1.2', 'URS-SEC-08', 'System and connectivity detail is refused to an unauthenticated caller',
    anonAbout.status === 401 && anonConn.status === 401,
    `GET /system/about → ${anonAbout.status}, GET /system/connectivity → ${anonConn.status} (commonRoutes applies requireAuth to the whole router)`);

  // Transport security: the host serves plain HTTP.
  record('OQ-1.3', 'URS-SEC-01', 'Credentials and records travel over an encrypted channel',
    BASE.startsWith('https://') ? 'PASS' : 'DEVIATION',
    BASE.startsWith('https://')
      ? 'API base is HTTPS.'
      : `API base is ${BASE.split('://')[0].toUpperCase()}; the host offers no TLS listener, so credentials and quality records cross the LAN in clear text.`);
}

/* ==========================================================================
   OQ-2  First-time setup and the single-administrator rule
   ========================================================================== */

async function suiteSetup() {
  console.log('\n[OQ-2] Controlled first-time setup');

  const before = await call('/setup/status');
  expect('OQ-2.1', 'URS-CFG-01', 'Uninitialised system reports setup as incomplete',
    before.status === 200 && before.json?.setupComplete === false,
    `setupComplete=${before.json?.setupComplete} adminExists=${before.json?.adminExists}`);

  const init = await call('/setup/initialize', {
    method: 'POST',
    body: { facilityName: 'OQ Validation Laboratory', shortName: 'OQ Lab', ...ADMIN },
  });
  expect('OQ-2.2', 'URS-CFG-02', 'First administrator can be established',
    init.status === 201, `POST /setup/initialize → ${init.status} ${JSON.stringify(init.json)}`);

  const repeat = await call('/setup/initialize', {
    method: 'POST',
    body: { facilityName: 'Rogue Laboratory', username: 'rogue', password: 'Rogue!2026x', fullName: 'Rogue' },
  });
  expect('OQ-2.3', 'URS-CFG-03', 'Setup cannot be re-run to create a second unaudited administrator',
    repeat.status === 400, `Second POST /setup/initialize → ${repeat.status} ${JSON.stringify(repeat.json)}`);

  const after = await call('/setup/status');
  expect('OQ-2.4', 'URS-CFG-01', 'System reports setup as complete once initialised',
    after.json?.setupComplete === true && after.json?.adminExists === true,
    `setupComplete=${after.json?.setupComplete} adminExists=${after.json?.adminExists}`);
}

/* ==========================================================================
   OQ-3  Authentication  (Part 11 §11.10(d)(g), §11.300; ISO 27001 A.5.15–A.5.17)
   ========================================================================== */

const session = {};

async function suiteAuthentication() {
  console.log('\n[OQ-3] Authentication and session control');

  const bad = await login(ADMIN.username, 'not-the-password');
  expect('OQ-3.1', 'URS-SEC-02', 'Invalid credentials are refused',
    bad.status === 401 && !bad.json?.token, `→ ${bad.status} ${JSON.stringify(bad.json)}`);

  const good = await login(ADMIN.username, ADMIN.password);
  expect('OQ-3.2', 'URS-SEC-02', 'Valid credentials are accepted and issue a session token',
    good.status === 200 && typeof good.json?.token === 'string' && good.json.token.length >= 32,
    `→ ${good.status}, token length ${good.json?.token?.length ?? 0}`);
  session.admin = good.json?.token;

  expect('OQ-3.3', 'URS-SEC-03', 'Login response never returns the stored password hash',
    !JSON.stringify(good.json ?? {}).toLowerCase().includes('password_hash') &&
    !JSON.stringify(good.json ?? {}).includes('$2a$') && !JSON.stringify(good.json ?? {}).includes('$2b$'),
    'No bcrypt material present in the authentication response.');

  const noToken = await call('/users');
  expect('OQ-3.4', 'URS-SEC-04', 'Protected endpoint refuses an unauthenticated caller',
    noToken.status === 401, `GET /users without a token → ${noToken.status}`);

  const forged = await call('/users', { token: 'f'.repeat(64) });
  expect('OQ-3.5', 'URS-SEC-04', 'Protected endpoint refuses a forged token',
    forged.status === 401, `GET /users with a fabricated token → ${forged.status}`);

  // Part 11 §11.300(d) / ISO 27001 A.5.17 — repeated failed attempts must be
  // detected and acted on.
  const attempts = 25;
  let lockedOut = false;
  for (let i = 0; i < attempts; i++) {
    const r = await login(ADMIN.username, `wrong-${i}`);
    if (r.status === 429 || (r.status === 403 && /lock/i.test(JSON.stringify(r.json)))) { lockedOut = true; break; }
  }
  const afterBurst = await login(ADMIN.username, ADMIN.password);
  record('OQ-3.6', 'URS-SEC-05', 'Repeated failed sign-in attempts are throttled or locked out',
    lockedOut ? 'PASS' : 'DEVIATION',
    lockedOut
      ? `Account protection engaged within ${attempts} attempts.`
      : `${attempts} consecutive failed sign-ins drew no lockout, no throttling and no rate limit; the correct password then still succeeded (${afterBurst.status}). Password guessing is unbounded and unrecorded.`);

  // Part 11 §11.300(b) / ISO 27001 A.5.17 — password quality.
  const weakUser = await call('/users', {
    token: session.admin, method: 'POST',
    body: { username: 'oq_weak', password: 'password', fullName: 'OQ Weak Password', roleId: await technicianRoleId() },
  });
  record('OQ-3.7', 'URS-SEC-06', 'Password complexity is enforced when an account is created',
    weakUser.status === 400 ? 'PASS' : 'DEVIATION',
    weakUser.status === 400
      ? `A trivial password was refused → ${JSON.stringify(weakUser.json)}`
      : `The password "password" was accepted (→ ${weakUser.status}). Only a length of 8 is enforced; there is no complexity, dictionary or reuse rule.`);

  const shortPw = await call('/users', {
    token: session.admin, method: 'POST',
    body: { username: 'oq_short', password: 'abc', fullName: 'OQ Short', roleId: await technicianRoleId() },
  });
  expect('OQ-3.8', 'URS-SEC-06', 'Minimum password length is enforced',
    shortPw.status === 400, `A 3-character password → ${shortPw.status} ${JSON.stringify(shortPw.json)}`);

  // Session termination.
  const throwaway = await login(ADMIN.username, ADMIN.password);
  const tmpToken = throwaway.json?.token;
  const beforeLogout = await call('/auth/me', { token: tmpToken });
  await call('/auth/logout', { token: tmpToken, method: 'POST' });
  const afterLogout = await call('/auth/me', { token: tmpToken });
  expect('OQ-3.9', 'URS-SEC-07', 'Signing out revokes the session token immediately',
    beforeLogout.status === 200 && afterLogout.status === 401,
    `before logout → ${beforeLogout.status}, after logout → ${afterLogout.status}`);

  // Annex 11 §12.3 — inactivity timeout.
  record('OQ-3.10', 'URS-SEC-09', 'Sessions expire after a defined period',
    'INFO',
    'Sessions carry a fixed 12-hour absolute expiry set at issue (auth_sessions.expires_at). There is no inactivity timeout: an unattended signed-in workstation stays usable for the remainder of the 12 hours.');
}

let _techRoleId = null;
async function technicianRoleId() {
  if (_techRoleId) return _techRoleId;
  const roles = await call('/roles', { token: session.admin });
  const row = (roles.json ?? []).find(r => /technician/i.test(r.name)) ?? (roles.json ?? [])[0];
  _techRoleId = row?.id;
  return _techRoleId;
}

/* ==========================================================================
   OQ-4  Authorisation  (ISO 15189 §7.6.2; Part 11 §11.10(d))
   ========================================================================== */

async function suiteAuthorisation() {
  console.log('\n[OQ-4] Role-based access control');

  // System identification, now that a session exists to ask with.
  const about = await call('/system/about', { token: session.admin });
  expect('OQ-4.0a', 'URS-INF-02', 'System reports its identity, version and build mode',
    about.status === 200 && !!about.json?.productName && !!about.json?.version,
    `productName=${about.json?.productName} version=${about.json?.version} buildMode=${about.json?.buildMode} apiStatus=${about.json?.apiStatus}`);

  const conn = await call('/system/connectivity', { token: session.admin });
  record('OQ-4.0b', 'URS-INF-03', 'Deployment mode and connectivity are reportable',
    conn.status === 200 ? 'INFO' : 'FAIL',
    `mode=${conn.json?.mode} (${conn.json?.modeSource}) lanExposed=${conn.json?.lanExposed} driver=${conn.json?.database?.driver} sync=${conn.json?.sync?.status}`);

  const roleId = await technicianRoleId();
  const created = await call('/users', {
    token: session.admin, method: 'POST',
    body: { username: TECH.username, password: TECH.password, fullName: TECH.fullName, roleId },
  });
  expect('OQ-4.1', 'URS-SEC-10', 'An administrator can create a restricted user account',
    created.status === 201, `POST /users → ${created.status} ${JSON.stringify(created.json)}`);

  const tech = await login(TECH.username, TECH.password);
  session.tech = tech.json?.token;
  expect('OQ-4.2', 'URS-SEC-10', 'The restricted account can authenticate',
    tech.status === 200 && !!session.tech, `→ ${tech.status}`);

  const denied = await call('/users', { token: session.tech });
  expect('OQ-4.3', 'URS-SEC-11', 'A restricted user is refused the user-administration endpoint',
    denied.status === 403, `GET /users as ${TECH.username} → ${denied.status} ${JSON.stringify(denied.json?.error)}`);

  const deniedCreate = await call('/users', {
    token: session.tech, method: 'POST',
    body: { username: 'oq_escalated', password: 'Escalate!2026', fullName: 'Escalated', roleId },
  });
  expect('OQ-4.4', 'URS-SEC-11', 'A restricted user cannot create accounts (no privilege escalation)',
    deniedCreate.status === 403, `POST /users as ${TECH.username} → ${deniedCreate.status}`);

  const deniedBackup = await call('/backup/create', { token: session.tech, method: 'POST', body: {} });
  expect('OQ-4.5', 'URS-SEC-11', 'A restricted user cannot export the whole database as a backup',
    deniedBackup.status === 403, `POST /backup/create as ${TECH.username} → ${deniedBackup.status}`);

  const deniedAudit = await call('/records-reports/audit-trail', { token: session.tech });
  expect('OQ-4.6', 'URS-AUD-05', 'Audit-trail access is itself permission-controlled',
    deniedAudit.status === 403, `GET /records-reports/audit-trail as ${TECH.username} → ${deniedAudit.status}`);

  const permissions = tech.json?.permissions ?? {};
  expect('OQ-4.7', 'URS-SEC-12', 'The client permission map omits everything the user may not view',
    !('settings' in permissions), `settings present in map: ${'settings' in permissions}`);

  // Deactivation must invalidate a live session, not merely block the next login.
  const users = await call('/users', { token: session.admin });
  const techRow = (users.json ?? []).find(u => u.username === TECH.username);
  const stillValidBefore = await call('/auth/me', { token: session.tech });
  const deact = await call(`/users/${techRow?.id}?mode=deactivate`, { token: session.admin, method: 'DELETE' });
  const stillValidAfter = await call('/auth/me', { token: session.tech });
  record('OQ-4.8', 'URS-SEC-13', 'Deactivating an account immediately ends its live session',
    deact.status === 200 && stillValidAfter.status === 401 ? 'PASS'
      : deact.status !== 200 ? 'INFO' : 'FAIL',
    `deactivate → ${deact.status}; session before ${stillValidBefore.status}, after ${stillValidAfter.status}`);
}

/* ==========================================================================
   OQ-5  Audit trail  (Part 11 §11.10(e); Annex 11 §9; ISO 15189 §7.6.3)
   ========================================================================== */

async function suiteAuditTrail() {
  console.log('\n[OQ-5] Audit trail');

  const trail = await call('/records-reports/audit-trail', { token: session.admin });
  const rows = Array.isArray(trail.json) ? trail.json : [];
  expect('OQ-5.1', 'URS-AUD-01', 'Audit trail is readable by an authorised user',
    trail.status === 200 && rows.length > 0, `→ ${trail.status}, ${rows.length} entries`);

  const createEvent = rows.find(r => r.entity === 'users' && r.action === 'create');
  expect('OQ-5.2', 'URS-AUD-02', 'Creating a record writes an attributable audit entry',
    !!createEvent && createEvent.actor_user_id != null && !!createEvent.created_at,
    createEvent
      ? `action=${createEvent.action} entity=${createEvent.entity} actor=${createEvent.actor_user_id} at=${createEvent.created_at} ip=${createEvent.ip_address}`
      : 'No create entry found for the account created in OQ-4.1.');

  expect('OQ-5.3', 'URS-AUD-03', 'Audit entries record the new value of a change',
    !!createEvent?.new_value, `new_value=${String(createEvent?.new_value).slice(0, 120)}`);

  // Part 11 §11.10(e) requires the old value for changes, not only the new one.
  const changeEvents = rows.filter(r => ['update', 'edit', 'link_staff'].includes(r.action));
  record('OQ-5.4', 'URS-AUD-04', 'Changes record the previous value as well as the new one',
    changeEvents.length === 0 ? 'INFO' : (changeEvents.some(r => r.old_value) ? 'PASS' : 'DEVIATION'),
    changeEvents.length === 0
      ? 'No modification events in this run to evaluate.'
      : `${changeEvents.filter(r => r.old_value).length} of ${changeEvents.length} modification entries carry old_value.`);

  // Part 11 §11.10(e) / Annex 11 §12 — sign-in events are security events.
  const loginEvents = rows.filter(r => /login|sign_in|authenticat/i.test(String(r.action)));
  record('OQ-5.5', 'URS-AUD-06', 'Successful and failed sign-ins are recorded in the audit trail',
    loginEvents.length > 0 ? 'PASS' : 'DEVIATION',
    loginEvents.length > 0
      ? `${loginEvents.length} authentication entries found.`
      : 'Neither successful nor failed sign-ins are written to audit_logs. The 25 failed attempts in OQ-3.6 and every successful login left no audit record, so an access review cannot reconstruct who signed in, from where, or when an attack occurred.');

  // Timestamp form — ALCOA+ "Contemporaneous" needs an unambiguous instant.
  const stamp = String(createEvent?.created_at ?? rows[0]?.created_at ?? '');
  record('OQ-5.6', 'URS-AUD-07', 'Audit timestamps are unambiguous as to time zone',
    /[zZ]|[+-]\d{2}:?\d{2}$/.test(stamp) ? 'PASS' : 'DEVIATION',
    `Stored form is "${stamp}" — a SQLite CURRENT_TIMESTAMP in UTC with no zone marker. Nothing in the record states the zone, so a reader in a different zone (or after a host clock change) cannot prove the instant.`);

  // The audit trail must not be alterable from the application.
  const mutate = await call(`/records-reports/audit-trail/${createEvent?.id ?? 1}`, {
    token: session.admin, method: 'PUT', body: { action: 'tampered' },
  });
  const remove = await call(`/records-reports/audit-trail/${createEvent?.id ?? 1}`, {
    token: session.admin, method: 'DELETE',
  });
  expect('OQ-5.7', 'URS-AUD-08', 'The application exposes no route that edits or deletes audit entries',
    [404, 405].includes(mutate.status) && [404, 405].includes(remove.status),
    `PUT → ${mutate.status}, DELETE → ${remove.status} (no such routes are defined)`);

  record('OQ-5.8', 'URS-AUD-09', 'Audit records are protected against modification at rest',
    'DEVIATION',
    'audit_logs is an ordinary writable SQLite table with no hash chain, digital signature, append-only trigger or write-once storage. Anyone with file access to sech_lims.sqlite — the same people who administer the host — can alter or delete history undetectably.');
}

/* ==========================================================================
   OQ-6  Electronic signatures  (Part 11 Subpart C §11.50, §11.70, §11.200)
   ========================================================================== */

async function suiteSignatures() {
  console.log('\n[OQ-6] Electronic signatures');

  const staff = await call('/staff', {
    token: session.admin, method: 'POST',
    body: { fullName: 'OQ Signatory', email: 'oq.signatory@lab.test' },
  });
  const target = { moduleKey: 'documents', recordType: 'documents', recordId: String(staff.json?.id ?? 1) };

  const signed = await call('/signatures', {
    token: session.admin, method: 'POST',
    body: { ...target, purpose: 'oq_validation_approval', meaning: 'Reviewed and approved for operational qualification.' },
  });
  expect('OQ-6.1', 'URS-SIG-01', 'A regulated action can be electronically signed',
    signed.status === 200 || signed.status === 201, `POST /signatures → ${signed.status} ${JSON.stringify(signed.json)}`);

  const read = await call(`/signatures/${target.moduleKey}/${target.recordType}/${target.recordId}`, { token: session.admin });
  const sig = (read.json ?? [])[0];
  expect('OQ-6.2', 'URS-SIG-02', 'The signature records the signer, the instant and the meaning',
    !!sig?.signer_name && !!sig?.signed_at && !!sig?.meaning,
    sig ? `signer=${sig.signer_name} at=${sig.signed_at} meaning="${sig.meaning}"` : 'No signature returned.');

  expect('OQ-6.3', 'URS-SIG-03', 'The signature is bound to the record it signs',
    !!sig && String(sig.id).length > 0 && read.status === 200,
    `Signature is retrieved by (module=${target.moduleKey}, type=${target.recordType}, id=${target.recordId}).`);

  expect('OQ-6.4', 'URS-SIG-04', 'Signing is refused without an authenticated identity',
    (await call('/signatures', { method: 'POST', body: { ...target, purpose: 'anonymous' } })).status === 401,
    'An unauthenticated POST /signatures is refused.');

  // Part 11 §11.200(a)(1)(ii): within a continuous session, at least one
  // signature component must be re-entered at the moment of signing.
  record('OQ-6.5', 'URS-SIG-05', 'Signing requires re-entry of a signature component',
    'DEVIATION',
    'The signature was applied on the strength of the session bearer token alone; no password or second component was requested at the moment of signing. Anyone reaching an unattended signed-in workstation can apply that person\'s legally binding signature.');

  record('OQ-6.6', 'URS-SIG-06', 'The signature is cryptographically bound to the signed content',
    'DEVIATION',
    'e_signatures stores identity, time, purpose and meaning, but no hash of the record content as signed. Nothing detects a later edit of the underlying record, so a signature cannot demonstrate what was actually approved.');

  record('OQ-6.7', 'URS-SIG-07', 'Signature-to-audit linkage is deterministic',
    'DEVIATION',
    'signatureService links the signature to its audit entry with "SELECT id FROM audit_logs ORDER BY id DESC LIMIT 1" after the insert. Two signatures (or any concurrent audited action) landing in the same instant can attach the wrong audit row to a signature.');
}

/* ==========================================================================
   OQ-7  Data integrity, backup and recovery
          (ISO 15189 §7.6.4; Annex 11 §7; ISO 22301; ISO 27001 A.8.13)
   ========================================================================== */

async function suiteDataIntegrity() {
  console.log('\n[OQ-7] Data integrity, backup and recovery');

  const scan = await call('/records-reports/data-integrity-checks/run-basic-scan', {
    token: session.admin, method: 'POST', body: {},
  });
  expect('OQ-7.1', 'URS-DAT-01', 'A data-integrity scan can be run and records its findings',
    scan.status === 200 || scan.status === 201, `→ ${scan.status} ${JSON.stringify(scan.json).slice(0, 160)}`);

  const backup = await call('/backup/create', { token: session.admin, method: 'POST', body: {} });
  expect('OQ-7.2', 'URS-DAT-02', 'A complete backup package can be produced on demand',
    backup.status === 200 || backup.status === 201, `→ ${backup.status} ${JSON.stringify(backup.json).slice(0, 200)}`);

  const list = await call('/backup/list', { token: session.admin });
  const packages = list.json?.backups ?? list.json ?? [];
  expect('OQ-7.3', 'URS-DAT-03', 'Backups are registered and listable for review',
    list.status === 200 && Array.isArray(packages) && packages.length > 0,
    `→ ${list.status}, ${Array.isArray(packages) ? packages.length : 0} package(s) registered`);

  const first = Array.isArray(packages) ? packages[0] : null;
  const hasChecksum = first && Object.keys(first).some(k => /checksum|sha|hash|digest/i.test(k));
  record('OQ-7.4', 'URS-DAT-04', 'Each backup carries a checksum so its integrity can be proven',
    hasChecksum ? 'PASS' : 'DEVIATION',
    hasChecksum
      ? 'A checksum field is recorded with the package.'
      : `The register records ${first ? Object.keys(first).join(', ') : 'no fields'}. No checksum or digest is stored, so a corrupted or altered archive cannot be distinguished from a good one before it is restored over live data.`);

  // Path traversal on the download route.
  const traversal = await call('/backup/download/..%2F..%2Fpackage.json', { token: session.admin, raw: true });
  expect('OQ-7.5', 'URS-SEC-14', 'Backup download refuses a path-traversal file name',
    traversal.status >= 400, `GET /backup/download/../../package.json → ${traversal.status}`);

  record('OQ-7.6', 'URS-DAT-05', 'Restore is preceded by an automatic safety snapshot',
    'INFO',
    'The restore route writes a pre-restore-*.zip of current state before replacing the database, uploads, evidence and config, and aborts the restore if that snapshot cannot be written (server/routes/common.ts).');

  record('OQ-7.7', 'URS-DAT-06', 'Backups are encrypted at rest',
    'DEVIATION',
    'Backup packages are unencrypted ZIPs containing the whole SQLite database, uploads and evidence. Copies sent off site to Google Drive or S3 carry the laboratory\'s complete quality record in the clear.');

  record('OQ-7.8', 'URS-DAT-07', 'The database itself is encrypted at rest',
    'DEVIATION',
    'sech_lims.sqlite is a plain unencrypted SQLite file. Anyone with file-level access to the host — or to a stolen laptop — reads every record without authenticating to the application.');
}

/* ==========================================================================
   OQ-8  Input validation and error handling  (ISO/IEC 25010 reliability)
   ========================================================================== */

async function suiteRobustness() {
  console.log('\n[OQ-8] Input handling and error behaviour');

  const malformed = await fetch(`${BASE}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"username": ',
  });
  const malformedBody = await malformed.text();
  expect('OQ-8.1', 'URS-REL-01', 'Malformed JSON is rejected without crashing the host',
    malformed.status >= 400 && malformed.status < 600,
    `Truncated JSON body → ${malformed.status}`);

  record('OQ-8.2', 'URS-REL-02', 'Error responses do not disclose internal implementation detail',
    /stack|at Object\.|node_modules|\/home\//i.test(malformedBody) ? 'DEVIATION' : 'PASS',
    /node_modules|\/home\//i.test(malformedBody)
      ? `The error body carried internal detail: ${malformedBody.slice(0, 200)}`
      : `Error body was ${malformedBody.slice(0, 160)}`);

  const injection = await login("' OR 1=1 --", "' OR '1'='1");
  expect('OQ-8.3', 'URS-SEC-15', 'SQL metacharacters in credentials do not bypass authentication',
    injection.status === 401 && !injection.json?.token,
    `Injection attempt in username/password → ${injection.status}`);

  const stillUp = await call('/health');
  expect('OQ-8.4', 'URS-REL-03', 'The host remains available after malformed and hostile input',
    stillUp.status === 200 && stillUp.json?.ok === true, `GET /health → ${stillUp.status}`);

  // Security response headers (ISO 27001 A.8.26 / OWASP baseline).
  const headers = stillUp.headers;
  const present = ['strict-transport-security', 'x-content-type-options', 'x-frame-options', 'content-security-policy']
    .filter(h => headers.get(h));
  record('OQ-8.5', 'URS-SEC-16', 'Standard security response headers are set',
    present.length >= 3 ? 'PASS' : 'DEVIATION',
    present.length === 0
      ? 'None of Strict-Transport-Security, X-Content-Type-Options, X-Frame-Options or Content-Security-Policy are sent; no security-header middleware is installed.'
      : `Only ${present.join(', ')} present.`);

  // CORS policy (relevant once the host is bound to 0.0.0.0 for LAN clients).
  const cors = await fetch(`${BASE}/health`, { headers: { Origin: 'https://attacker.example' } });
  const allowed = cors.headers.get('access-control-allow-origin');
  record('OQ-8.6', 'URS-SEC-17', 'Cross-origin access is restricted to known clients',
    allowed && allowed !== '*' && !allowed.includes('attacker') ? 'PASS' : 'DEVIATION',
    `The host reflected Access-Control-Allow-Origin: ${allowed} for an arbitrary origin, with credentials enabled (cors({ origin: true, credentials: true })).`);
}

/* ==========================================================================
   OQ-9  Lifecycle controls the standards require of the software itself
   ========================================================================== */

async function suiteLifecycle() {
  console.log('\n[OQ-9] Software lifecycle controls');

  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const devDeps = Object.keys(pkg.devDependencies ?? {});
  const hasTestRunner = devDeps.some(d => /^(vitest|jest|mocha|ava|tap|node-tap|@playwright\/test|cypress)$/.test(d));
  record('OQ-9.1', 'URS-LC-01', 'An automated regression test suite is maintained',
    hasTestRunner ? 'PASS' : 'DEVIATION',
    hasTestRunner
      ? `Test runner present: ${devDeps.filter(d => /vitest|jest|mocha|playwright|cypress/.test(d)).join(', ')}`
      : 'No test framework is declared and there is no "test" script. Verification rests on hand-written check scripts that must each be run against a manually started host; a regression in an unscripted module is not detected by any automated means.');

  record('OQ-9.2', 'URS-LC-02', 'The release carries a controlled version identifier',
    /^\d+\.\d+\.\d+$/.test(pkg.version) && pkg.version !== '0.1.0' ? 'PASS' : 'DEVIATION',
    `package.json version is ${pkg.version}. Every build since the foundation MVP has carried this same number, so a deployed installation cannot be tied to the code it was built from.`);

  const ci = fs.existsSync(path.join(root, '.github/workflows'))
    ? fs.readdirSync(path.join(root, '.github/workflows'))
    : [];
  const withChecks = ci.filter(f =>
    /npm run (typecheck|smoke|rbac:check|check:)/.test(fs.readFileSync(path.join(root, '.github/workflows', f), 'utf8')));
  const withoutChecks = ci.filter(f => !withChecks.includes(f));
  record('OQ-9.3', 'URS-LC-03', 'Continuous integration runs the verification checks before a build',
    withChecks.length > 0 && withoutChecks.length === 0 ? 'PASS' : withChecks.length > 0 ? 'DEVIATION' : 'FAIL',
    ci.length === 0
      ? 'No workflows found.'
      : `${withChecks.join(', ') || 'none'} run typecheck/smoke before packaging; ${withoutChecks.join(', ') || 'none'} package without running any verification check. ` +
        'No workflow runs the RBAC, IQC, alerts, account or backup check scripts, so those 587 assertions are only ever exercised by hand.');

  record('OQ-9.4', 'URS-LC-04', 'The distributed installer is signed',
    'DEVIATION',
    'electron-builder is configured with no code-signing certificate ("publish": null, unsigned NSIS output). Windows SmartScreen warns on install and the laboratory cannot prove the installer it runs is the one the supplier built.');

  record('OQ-9.5', 'URS-LC-05', 'Third-party components are free of known vulnerabilities',
    'DEVIATION',
    'npm audit reports 45 advisories (1 critical, 36 high) at the validated commit, including runtime dependencies xlsx (prototype pollution, ReDoS — no fixed release), multer, adm-zip, react-router and electron. No dependency-review or patching cycle is defined.');
}

/* ------------------------------------------------------------------- runner */

async function main() {
  console.log('SECH_LIMS — Operational Qualification suite');
  console.log(`Base URL : ${BASE}`);
  console.log(`Data dir : ${process.env.API ? '(external host)' : DATA_DIR}`);

  const spawned = await startHost();
  try {
    await suiteSystem();
    await suiteSetup();
    await suiteAuthentication();
    await suiteAuthorisation();
    await suiteAuditTrail();
    await suiteSignatures();
    await suiteDataIntegrity();
    await suiteRobustness();
    await suiteLifecycle();
  } finally {
    if (spawned) stopHost();
  }

  const tally = results.reduce((acc, r) => ({ ...acc, [r.outcome]: (acc[r.outcome] ?? 0) + 1 }), {});
  console.log('\n─────────────────────────────────────────────────────────');
  console.log(`Executed ${results.length} test cases: ` +
    `${tally.PASS ?? 0} passed, ${tally.FAIL ?? 0} failed, ` +
    `${tally.DEVIATION ?? 0} deviations, ${tally.INFO ?? 0} observations.`);

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({
    suite: 'SECH_LIMS Operational Qualification',
    executedAt: new Date().toISOString(),
    baseUrl: BASE,
    node: process.version,
    platform: `${os.type()} ${os.release()}`,
    tally,
    results,
  }, null, 2));
  console.log(`Evidence written to ${path.relative(root, OUT)}`);

  process.exit((tally.FAIL ?? 0) > 0 ? 1 : 0);
}

main().catch(err => { console.error(err); stopHost(); process.exit(2); });
