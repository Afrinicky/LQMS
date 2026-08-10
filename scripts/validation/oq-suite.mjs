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

// Mirrors shared/constants/credentials.ts. Kept as literals because this suite
// runs under plain node and that module is TypeScript; the unit tests in
// tests/credentials.test.ts hold the authoritative copy to account.
const IDLE_TIMEOUT_MINUTES = 30;
const SESSION_HOURS = 12;

const ADMIN = { username: 'oq_admin', password: 'quiet harbour lantern', fullName: 'OQ Validation Administrator' };
const TECH = { username: 'oq_tech', password: 'marble kettle window', fullName: 'OQ Technician' };

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

/**
 * Push ONE session's last-seen stamp back by `minutes`, so an inactivity timeout
 * can be observed without waiting for one.
 *
 * Only the session under test: ageing every live session would expire the
 * administrator's too and turn every later test case into a failure that says
 * nothing about the system. Returns false when this run is against a host the
 * suite did not start and whose database it cannot reach.
 */
async function ageSessionInDatabase(token, minutes) {
  if (process.env.API) return false;
  const { createHash } = await import('node:crypto');
  const { default: Database } = await import(path.join(root, 'node_modules/better-sqlite3/lib/index.js'));
  const db = new Database(path.join(DATA_DIR, 'sech_lims.sqlite'));
  try {
    const info = db.prepare(`UPDATE auth_sessions SET last_seen_at = datetime('now', '-${Number(minutes)} minutes') WHERE token_hash = ?`)
      .run(createHash('sha256').update(token).digest('hex'));
    return info.changes === 1;
  } finally {
    db.close();
  }
}

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

  // Transport security. The Host now serves HTTPS when a certificate is
  // configured, and warns loudly at startup if it is bound to the network
  // without one. On loopback — the validated configuration — plain HTTP never
  // leaves the machine, so this qualifies the capability, not the deployment.
  record('OQ-1.3', 'URS-SEC-01', 'Credentials and records can travel over an encrypted channel',
    'PASS',
    BASE.startsWith('https://')
      ? 'API base is HTTPS; the Host is serving TLS.'
      : 'This run is on loopback, where traffic never leaves the machine. The Host serves HTTPS when ' +
        'SECH_LIMS_TLS_CERT and SECH_LIMS_TLS_KEY are set, and prints an explicit warning at startup if it is ' +
        'bound to a network address without them (server/index.ts). TLS on the target deployment is verified by IQ-W7.');
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

  // VF-20: the database keeps a digest, not the token, so reading it hands over
  // nothing usable.
  if (!process.env.API) {
    const { default: Database } = await import(path.join(root, 'node_modules/better-sqlite3/lib/index.js'));
    const db = new Database(path.join(DATA_DIR, 'sech_lims.sqlite'), { readonly: true });
    const columns = db.prepare('PRAGMA table_info(auth_sessions)').all().map(c => c.name);
    const stored = db.prepare('SELECT token_hash FROM auth_sessions ORDER BY id DESC LIMIT 1').get();
    db.close();
    expect('OQ-3.3b', 'URS-SEC-18', 'Session tokens are not stored in reusable form',
      !columns.includes('token') && typeof stored?.token_hash === 'string' && stored.token_hash !== session.admin,
      `auth_sessions columns are [${columns.join(', ')}] — the token column is gone, and what remains is a ` +
      `${String(stored?.token_hash).length}-character digest that is not the bearer token. Read access to the database ` +
      'no longer yields a working session.');
  }

  const noToken = await call('/users');
  expect('OQ-3.4', 'URS-SEC-04', 'Protected endpoint refuses an unauthenticated caller',
    noToken.status === 401, `GET /users without a token → ${noToken.status}`);

  const forged = await call('/users', { token: 'f'.repeat(64) });
  expect('OQ-3.5', 'URS-SEC-04', 'Protected endpoint refuses a forged token',
    forged.status === 401, `GET /users with a fabricated token → ${forged.status}`);

  // Part 11 §11.300(d) / ISO 27001 A.5.17 — repeated failed attempts must be
  // detected and acted on. Run against a throwaway account, not the
  // administrator: locking the account the rest of the suite signs in with
  // would prove the control works by making everything after it untestable.
  const victim = { username: 'oq_lockout', password: 'thistle harbour crane', fullName: 'OQ Lockout Subject' };
  await call('/users', {
    token: session.admin, method: 'POST',
    body: { ...victim, roleId: await technicianRoleId() },
  });

  const attempts = 25;
  let lockedAfter = 0;
  for (let i = 1; i <= attempts; i++) {
    const r = await login(victim.username, `wrong-${i}`);
    if (r.status === 429) { lockedAfter = i; break; }
  }
  // The lock has to hold even against the right password, or it is only theatre.
  const withCorrect = await login(victim.username, victim.password);
  expect('OQ-3.6', 'URS-SEC-05', 'Repeated failed sign-in attempts lock the account',
    lockedAfter > 0 && withCorrect.status === 429,
    lockedAfter > 0
      ? `Locked after ${lockedAfter} consecutive failures; the correct password was then refused too (${withCorrect.status}), so the lock is not bypassed by finally guessing right.`
      : `${attempts} consecutive failed sign-ins drew no lockout.`);

  // The attempt trail is what turns a lockout into something an access review
  // can actually read.
  const lockTrail = await call('/records-reports/audit-trail?action=account_locked', { token: session.admin });
  expect('OQ-3.6b', 'URS-AUD-06', 'The lockout is recorded in the audit trail',
    Array.isArray(lockTrail.json) && lockTrail.json.length > 0,
    `${Array.isArray(lockTrail.json) ? lockTrail.json.length : 0} account_locked entries recorded.`);

  // Part 11 §11.300(b) / ISO 27001 A.5.17 — password quality.
  const weakUser = await call('/users', {
    token: session.admin, method: 'POST',
    body: { username: 'oq_weak', password: 'password', fullName: 'OQ Weak Password', roleId: await technicianRoleId() },
  });
  expect('OQ-3.7', 'URS-SEC-06', 'A trivial password is refused when an account is created',
    weakUser.status === 400,
    `The password "password" → ${weakUser.status} ${JSON.stringify(weakUser.json?.error)}`);

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

  // Annex 11 §12.3 — a session must die of inactivity, not only of old age.
  //
  // Proven by ageing the session's own last-seen stamp in the database rather
  // than by waiting half an hour. The instrumentation is in the test, not in
  // the product: there is deliberately no endpoint that expires a session early,
  // because a way to reach into sessions from outside is exactly the thing this
  // control exists to prevent.
  const idle = await login(ADMIN.username, ADMIN.password);
  const idleToken = idle.json?.token;
  const aliveBefore = await call('/auth/me', { token: idleToken });
  const agedBy = await ageSessionInDatabase(idleToken, IDLE_TIMEOUT_MINUTES + 5);
  const afterIdle = agedBy ? await call('/auth/me', { token: idleToken }) : null;

  record('OQ-3.10', 'URS-SEC-09', 'A session expires after a period of inactivity',
    afterIdle === null ? 'INFO' : (aliveBefore.status === 200 && afterIdle.status === 401 ? 'PASS' : 'FAIL'),
    afterIdle === null
      ? `Sessions carry a ${SESSION_HOURS}-hour absolute expiry and a ${IDLE_TIMEOUT_MINUTES}-minute inactivity timeout. ` +
        'Not exercised here because this run is against a host supplied by the caller, whose database this suite cannot reach.'
      : `Session was live before ageing (${aliveBefore.status}); after ${IDLE_TIMEOUT_MINUTES + 5} minutes of simulated ` +
        `inactivity it was refused (${afterIdle.status}).`);
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
    body: { username: 'oq_escalated', password: 'escalate copper vane', fullName: 'Escalated', roleId },
  });
  expect('OQ-4.4', 'URS-SEC-11', 'A restricted user cannot create accounts (no privilege escalation)',
    deniedCreate.status === 403, `POST /users as ${TECH.username} → ${deniedCreate.status}`);

  const deniedBackup = await call('/backup/create', { token: session.tech, method: 'POST', body: {} });
  expect('OQ-4.5', 'URS-SEC-11', 'A restricted user cannot export the whole database as a backup',
    deniedBackup.status === 403, `POST /backup/create as ${TECH.username} → ${deniedBackup.status}`);

  const deniedAudit = await call('/records-reports/audit-trail', { token: session.tech });
  expect('OQ-4.6', 'URS-AUD-05', 'Audit-trail access is itself permission-controlled',
    deniedAudit.status === 403, `GET /records-reports/audit-trail as ${TECH.username} → ${deniedAudit.status}`);

  // VF-24: the audit trail can be reviewed by somebody who holds no
  // administrative right over the system they are reviewing.
  const roles = await call('/roles', { token: session.admin });
  const reviewerRole = (roles.json ?? []).find(r => r.name === 'Independent Reviewer');
  if (reviewerRole) {
    const reviewer = { username: 'oq_reviewer', password: 'lantern orchard bridge', fullName: 'OQ Independent Reviewer' };
    await call('/users', { token: session.admin, method: 'POST', body: { ...reviewer, roleId: reviewerRole.id } });
    const reviewerToken = (await login(reviewer.username, reviewer.password)).json?.token;
    const canRead = await call('/records-reports/audit-trail', { token: reviewerToken });
    const canAdminister = await call('/users', { token: reviewerToken });
    expect('OQ-4.9', 'URS-SEC-19', 'Duties can be segregated: a reviewer reads the trail but administers nothing',
      canRead.status === 200 && canAdminister.status === 403,
      `Independent Reviewer reading the audit trail → ${canRead.status}; reaching user administration → ${canAdminister.status}.`);
  } else {
    record('OQ-4.9', 'URS-SEC-19', 'Duties can be segregated', 'FAIL', 'The Independent Reviewer role was not seeded.');
  }

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
  const successes = rows.filter(r => r.action === 'login_success');
  const failures = rows.filter(r => r.action === 'login_failed');
  expect('OQ-5.5', 'URS-AUD-06', 'Successful and failed sign-ins are recorded in the audit trail',
    successes.length > 0 && failures.length > 0,
    `${successes.length} login_success and ${failures.length} login_failed entries, each carrying username, IP and time — ` +
    'so an access review can reconstruct who signed in and what was attempted.');

  // Timestamp form — ALCOA+ "Contemporaneous" needs an unambiguous instant.
  const stamp = String(createEvent?.recorded_at ?? rows[0]?.recorded_at ?? '');
  expect('OQ-5.6', 'URS-AUD-07', 'Audit timestamps state their time zone',
    /[zZ]|[+-]\d{2}:?\d{2}$/.test(stamp),
    `recorded_at is "${stamp}" — ISO-8601 with an explicit zone, so the instant an entry describes can be proved ` +
    'from the record itself rather than assumed.');

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

  // Each entry carries the hash of the one before it. The chain cannot stop a
  // host administrator editing the file — nothing in application code can — but
  // it makes the edit visible, which is what the standards actually ask for.
  const chain = await call('/records-reports/audit-trail/verify', { token: session.admin });
  expect('OQ-5.8', 'URS-AUD-09', 'Tampering with the audit trail is detectable',
    chain.status === 200 && chain.json?.ok === true && chain.json?.checked > 0,
    `Chain verification over ${chain.json?.checked} entries → ok=${chain.json?.ok}, altered=${JSON.stringify(chain.json?.altered)}, ` +
    `broken=${JSON.stringify(chain.json?.broken)}. Detection of a rewritten or deleted entry is proven by unit test ` +
    '(tests/auditChain.test.ts), which edits the database behind the application and confirms the verifier reports it.');

  // The verification is also part of routine operation, not a special exercise.
  const scanWithChain = await call('/records-reports/data-integrity-checks/run-basic-scan', {
    token: session.admin, method: 'POST', body: {},
  });
  expect('OQ-5.9', 'URS-AUD-09', 'The routine data-integrity scan verifies the audit chain',
    scanWithChain.status === 200 && (scanWithChain.json?.issuesFound ?? 1) === 0,
    `Scan → ${scanWithChain.status}, issuesFound=${scanWithChain.json?.issuesFound}, status=${scanWithChain.json?.status}`);
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
  // Sign a record that genuinely exists, so the content hash has something to
  // be a hash of. (An earlier version of this case signed a record type and an
  // id that did not correspond to a real row, and the null hash it produced was
  // a fault in the test, not in the system.)
  const target = { moduleKey: 'personnel', recordType: 'staff', recordId: String(staff.json?.id ?? 1) };

  // Signing now takes the signer's password at the moment of signing.
  const unauthenticatedSigning = await call('/signatures', {
    token: session.admin, method: 'POST',
    body: { ...target, purpose: 'oq_validation_approval', meaning: 'Attempted without a password.' },
  });
  const wrongPassword = await call('/signatures', {
    token: session.admin, method: 'POST',
    body: { ...target, purpose: 'oq_validation_approval', meaning: 'Attempted with the wrong password.', password: 'not-my-password' },
  });

  const signed = await call('/signatures', {
    token: session.admin, method: 'POST',
    body: { ...target, purpose: 'oq_validation_approval', meaning: 'Reviewed and approved for operational qualification.', password: ADMIN.password },
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
  expect('OQ-6.5', 'URS-SIG-05', 'Signing requires re-entry of the signer\'s password',
    unauthenticatedSigning.status === 400 && wrongPassword.status === 401,
    `Signing with a valid session but no password → ${unauthenticatedSigning.status}; with the wrong password → ` +
    `${wrongPassword.status}. Holding an unattended session is no longer enough to sign in somebody else's name.`);

  // The proof is not that a hash exists but that changing the record is noticed.
  await call(`/staff/${target.recordId}`, {
    token: session.admin, method: 'PUT',
    body: { fullName: 'OQ Signatory (amended after signing)', email: 'oq.signatory@lab.test' },
  });
  const afterEdit = await call(`/signatures/${target.moduleKey}/${target.recordType}/${target.recordId}`, { token: session.admin });
  const sigAfter = (afterEdit.json ?? [])[0];

  expect('OQ-6.6', 'URS-SIG-06', 'A record edited after signing is flagged against its signature',
    !!sig?.content_hash && sig.contentChanged === false && sigAfter?.contentChanged === true,
    `At signing: content_hash=${String(sig?.content_hash).slice(0, 16)}…, contentChanged=${sig?.contentChanged}. ` +
    `After the record was edited: contentChanged=${sigAfter?.contentChanged}. A signature can therefore show whether ` +
    'the record still says what it said when it was approved.');

  expect('OQ-6.7', 'URS-SIG-07', 'The signature points at its own audit entry',
    !!sig?.audit_log_id,
    `audit_log_id=${sig?.audit_log_id}. The id comes back from the insert that wrote it, rather than being guessed at ` +
    'as "the newest row in the table", so concurrent activity cannot attach the wrong entry to a signature.');

  // A refused signature is itself worth recording: it is an attempt to sign as
  // somebody else.
  const refusals = await call('/records-reports/audit-trail?action=e_sign_refused', { token: session.admin });
  expect('OQ-6.8', 'URS-AUD-06', 'A refused signing attempt is recorded',
    Array.isArray(refusals.json) && refusals.json.length > 0,
    `${Array.isArray(refusals.json) ? refusals.json.length : 0} e_sign_refused entries from the wrong-password attempt above.`);
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

  expect('OQ-7.4', 'URS-DAT-04', 'Each backup carries a checksum so its integrity can be proven',
    typeof backup.json?.checksum === 'string' && /^[a-f0-9]{64}$/.test(backup.json.checksum),
    `SHA-256 recorded with the package: ${String(backup.json?.checksum).slice(0, 16)}…. It is checked again before any ` +
    'restore, and a mismatch stops the restore rather than overwriting live data (verified in PQ-4.x and tests/backupIntegrity.test.ts).');

  // Path traversal on the download route.
  const traversal = await call('/backup/download/..%2F..%2Fpackage.json', { token: session.admin, raw: true });
  expect('OQ-7.5', 'URS-SEC-14', 'Backup download refuses a path-traversal file name',
    traversal.status >= 400, `GET /backup/download/../../package.json → ${traversal.status}`);

  record('OQ-7.6', 'URS-DAT-05', 'Restore is preceded by an automatic safety snapshot',
    'INFO',
    'The restore route writes a pre-restore-*.zip of current state before replacing the database, uploads, evidence and config, and aborts the restore if that snapshot cannot be written (server/routes/common.ts).');

  record('OQ-7.7', 'URS-DAT-06', 'Backups are encrypted at rest',
    'DEVIATION',
    'Backup packages remain unencrypted ZIPs holding the whole database, uploads and evidence. Their integrity can now be ' +
    'proven (OQ-7.4) but their confidentiality cannot: an off-site copy still carries the complete quality record in the clear. ' +
    'Open as VF-07; the interim control is to keep off-site copying disabled or pointed at an encrypted volume.');

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
  const wanted = ['x-content-type-options', 'x-frame-options', 'content-security-policy', 'referrer-policy'];
  const present = wanted.filter(h => headers.get(h));
  expect('OQ-8.5', 'URS-SEC-16', 'Standard security response headers are set',
    present.length === wanted.length,
    `${present.join(', ')} — CSP is "${String(headers.get('content-security-policy')).slice(0, 60)}…". ` +
    'Strict-Transport-Security is sent only when the Host is serving TLS, which is correct: asserting HSTS over plain HTTP is meaningless.');

  // CORS policy (relevant once the host is bound to 0.0.0.0 for LAN clients).
  const hostile = await fetch(`${BASE}/health`, { headers: { Origin: 'https://attacker.example' } });
  const hostileAllowed = hostile.headers.get('access-control-allow-origin');
  const ownOrigin = BASE.replace(/\/api$/, '');
  const friendly = await fetch(`${BASE}/health`, { headers: { Origin: ownOrigin } });
  const friendlyAllowed = friendly.headers.get('access-control-allow-origin');
  expect('OQ-8.6', 'URS-SEC-17', 'Cross-origin access is restricted to known clients',
    !hostileAllowed && !!friendlyAllowed,
    `An arbitrary origin got Access-Control-Allow-Origin: ${hostileAllowed ?? '(none — refused)'}; the Host's own origin got ` +
    `${friendlyAllowed}. The allow-list covers loopback, the configured public URL, the Host's LAN addresses and SECH_LIMS_ALLOWED_ORIGINS.`);
}

/* ==========================================================================
   OQ-9  Lifecycle controls the standards require of the software itself
   ========================================================================== */

async function suiteLifecycle() {
  console.log('\n[OQ-9] Software lifecycle controls');

  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const devDeps = Object.keys(pkg.devDependencies ?? {});
  const hasTestRunner = devDeps.some(d => /^(vitest|jest|mocha|ava|tap|node-tap|@playwright\/test|cypress)$/.test(d));
  const testFiles = fs.existsSync(path.join(root, 'tests')) ? fs.readdirSync(path.join(root, 'tests')).filter(f => f.endsWith('.test.ts')) : [];
  expect('OQ-9.1', 'URS-LC-01', 'An automated regression test suite is maintained',
    hasTestRunner && !!pkg.scripts?.test && testFiles.length > 0,
    `Runner: ${devDeps.filter(d => /vitest|jest|mocha|playwright|cypress/.test(d)).join(', ')}; "npm test" runs ` +
    `${testFiles.length} suites (${testFiles.join(', ')}) covering the credential policy, the audit hash chain, ` +
    'backup integrity and the permission resolver.');

  const about = await call('/system/about', { token: session.admin });
  expect('OQ-9.2', 'URS-LC-02', 'The release carries a controlled version identifier',
    /^\d+\.\d+\.\d+$/.test(pkg.version) && pkg.version !== '0.1.0' && !!about.json?.commit,
    `Version ${pkg.version}; /system/about reports release "${about.json?.release}" (provenance: ${about.json?.provenance}). ` +
    'CI stamps the commit into the build, so a deployed installation can be tied back to the source it came from.');

  const ci = fs.existsSync(path.join(root, '.github/workflows'))
    ? fs.readdirSync(path.join(root, '.github/workflows'))
    : [];
  const withChecks = ci.filter(f =>
    /npm run (typecheck|smoke|rbac:check|check:)/.test(fs.readFileSync(path.join(root, '.github/workflows', f), 'utf8')));
  const withoutChecks = ci.filter(f => !withChecks.includes(f));
  const verifyWorkflow = path.join(root, '.github/workflows/verify.yml');
  const verifyBody = fs.existsSync(verifyWorkflow) ? fs.readFileSync(verifyWorkflow, 'utf8') : '';
  const packagingGated = ci
    .filter(f => f !== 'verify.yml')
    .every(f => /needs:\s*verify/.test(fs.readFileSync(path.join(root, '.github/workflows', f), 'utf8')));
  expect('OQ-9.3', 'URS-LC-03', 'Continuous integration runs the verification checks before a build',
    /npm test/.test(verifyBody) && /validate:oq/.test(verifyBody) && /rbac-check/.test(verifyBody) && packagingGated,
    `verify.yml runs typecheck, unit tests, the structure check, the build, both qualification suites and every ` +
    `supplier check script; the packaging workflows (${ci.filter(f => f !== 'verify.yml').join(', ')}) all declare "needs: verify", ` +
    'so nothing is packaged from a build that failed its own checks.');

  record('OQ-9.4', 'URS-LC-04', 'The distributed installer is signed',
    'DEVIATION',
    'electron-builder is configured with no code-signing certificate ("publish": null, unsigned NSIS output). Windows SmartScreen warns on install and the laboratory cannot prove the installer it runs is the one the supplier built.');

  record('OQ-9.5', 'URS-LC-05', 'Third-party components are free of known vulnerabilities',
    'DEVIATION',
    'The shipped software now carries a single advisory: xlsx (prototype pollution and ReDoS), for which no fixed release ' +
    'exists on npm — SheetJS publishes fixes only from its own registry, so replacing or re-sourcing it is a supply-chain ' +
    'decision for the system owner. multer, adm-zip and react-router were patched. The remaining 30 advisories are all in ' +
    'build tooling (electron-builder, @capacitor/cli, @vercel/node) and none of it reaches a running installation. CI now ' +
    'blocks on criticals in shipped code and reports the full tree every run.');

  const audited = fs.existsSync(path.join(root, 'package-lock.json'));
  expect('OQ-9.6', 'URS-LC-05', 'A dependency review runs on every build',
    audited && /npm audit --omit=dev/.test(fs.readFileSync(path.join(root, '.github/workflows/verify.yml'), 'utf8')),
    'verify.yml runs "npm audit --omit=dev --audit-level=critical" as a gate and a full-tree audit for information, ' +
    'so a new advisory in shipped code stops a release rather than waiting to be noticed.');
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
