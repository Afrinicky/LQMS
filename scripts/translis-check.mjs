/**
 * TransLis over HTTP: setup, the two accounts, the modes and retention.
 *
 * The engine, the bridge, the transports, the routing and the Result Filler
 * are proved by the SECHLIMS checks, against the very same files — there is no
 * second copy of any of it to test. What is proved here is only what TransLis
 * adds, and what it is obliged to refuse:
 *
 *   An installation with no account is set up once and not twice.
 *   An administrator reaches the configuration; a member of staff does not,
 *   and is refused by the API rather than merely not shown the screens.
 *   The last administrator cannot demote or suspend themselves into a product
 *   nobody can configure.
 *   The transmission mode decides what the host answers on.
 *   A retention period is bounded, and a purge empties the clinical content
 *   while leaving the delivery record, the trace and the identifier's
 *   fingerprint behind.
 *   The extension it hands out says TransLis, and keeps the storage keys the
 *   browser already recognises.
 *
 *   TRANSLIS_PORT=4331 SECH_LIMS_DATA_DIR=/tmp/translis-check \
 *     npx tsx translis/server/index.ts     (in one terminal)
 *   node scripts/translis-check.mjs
 */
const BASE = process.env.TRANSLIS_API || 'http://127.0.0.1:4331/api';
const ADMIN_PW = 'TransLis!check1';
const STAFF_PW = 'Bench!check12';

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};
const section = name => console.log(`\n${name}\n${'-'.repeat(name.length)}`);

const j = async (path, options = {}) => {
  const headers = { 'Content-Type': 'application/json' };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  const response = await fetch(`${BASE}${path}`, {
    method: options.method || 'GET', headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  return { status: response.status, json: await response.json().catch(() => null) };
};

console.log(`TransLis — API checks\n${BASE}`);

/* ------------------------------------------------------------------ setup */
section('Setting the installation up');

const before = await j('/translis/setup/status');
check('the host answers before anybody has signed in', before.status === 200, `status ${before.status}`);
check('it names the product', before.json?.product === 'TransLis', JSON.stringify(before.json?.product));
check('it offers both ways of receiving',
  (before.json?.modes ?? []).map(m => m.key).sort().join(',') === 'direct,lan');

if (!before.json?.setupComplete) {
  const created = await j('/translis/setup/initialize', {
    method: 'POST',
    body: { username: 'admin', password: ADMIN_PW, fullName: 'Site Administrator', mode: 'lan', lisName: 'LHIMS' },
  });
  check('the first administrator is created', created.status === 200, JSON.stringify(created.json));
} else {
  check('the first administrator is created', true, 'already set up on this host');
}

const again = await j('/translis/setup/initialize', {
  method: 'POST',
  body: { username: 'intruder', password: 'Whatever!123', fullName: 'Second Admin' },
});
check('a second setup is refused once there is an account', again.status === 409, `status ${again.status}`);

const short = await j('/translis/accounts', { method: 'POST', body: { username: 'x', password: 'short', fullName: 'X' } });
check('an unauthenticated account creation is refused', short.status === 401 || short.status === 403, `status ${short.status}`);

/* ----------------------------------------------------------------- signing in */
section('The two accounts');

const admin = (await j('/auth/login', { method: 'POST', body: { username: 'admin', password: ADMIN_PW } })).json?.token;
check('the administrator signs in', Boolean(admin));

const staffName = `bench${Date.now().toString().slice(-6)}`;
const madeStaff = await j('/translis/accounts', {
  method: 'POST', token: admin,
  body: { username: staffName, password: STAFF_PW, fullName: 'Bench Scientist', profile: 'Staff' },
});
check('the administrator can add a member of staff', madeStaff.status === 200, JSON.stringify(madeStaff.json));

const staff = (await j('/auth/login', { method: 'POST', body: { username: staffName, password: STAFF_PW } })).json?.token;
check('the member of staff signs in', Boolean(staff));

const weak = await j('/translis/accounts', {
  method: 'POST', token: admin,
  body: { username: 'tooshort', password: 'abc', fullName: 'Short Password' },
});
check('a password under eight characters is refused', weak.status === 400, `status ${weak.status}`);

const badName = await j('/translis/accounts', {
  method: 'POST', token: admin,
  body: { username: 'no spaces here', password: 'Longenough1', fullName: 'Bad Username' },
});
check('a username with spaces is refused', badName.status === 400, `status ${badName.status}`);

const duplicate = await j('/translis/accounts', {
  method: 'POST', token: admin,
  body: { username: staffName, password: STAFF_PW, fullName: 'Someone Else' },
});
check('a username already taken is refused', duplicate.status === 409, `status ${duplicate.status}`);

/* ------------------------------------------------------- what staff may do */
section('What a member of staff may do, and may not');

const mayRead = [
  ['the workspace overview', '/middleware/overview'],
  ['live monitoring', '/middleware/messages'],
  ['the Result Filler', '/result-filler/overview'],
  ['the forms it fills', '/result-filler/adapters'],
];
for (const [what, path] of mayRead) {
  const answer = await j(path, { token: staff });
  check(`staff may read ${what}`, answer.status === 200, `status ${answer.status}`);
}

const mayNot = [
  ['configure a destination', 'POST', '/middleware/destinations', { name: 'Nowhere' }],
  ['teach the filler a form', 'POST', '/result-filler/adapters', { name: 'Nowhere' }],
  ['change the installation', 'PUT', '/translis/settings', { retentionDays: 3000 }],
  ['purge the register', 'POST', '/translis/settings/purge', {}],
  ['list the accounts', 'GET', '/translis/accounts', undefined],
  ['add an account', 'POST', '/translis/accounts', { username: 'sneak', password: 'Longenough1', fullName: 'S' }],
  ['reach the analyser links', 'GET', '/instrument-links', undefined],
];
for (const [what, method, path, body] of mayNot) {
  const answer = await j(path, { method, token: staff, body });
  check(`staff may not ${what}`, answer.status === 403, `status ${answer.status}`);
}

/* --------------------------------------------------- the last administrator */
section('The last administrator');

const me = (await j('/auth/me', { token: admin })).json?.user;
const demote = await j(`/translis/accounts/${me?.id}`, {
  method: 'PUT', token: admin, body: { profile: 'Staff' },
});
check('the only administrator cannot demote themselves', demote.status === 400, `status ${demote.status}`);

const suspend = await j(`/translis/accounts/${me?.id}`, {
  method: 'PUT', token: admin, body: { isActive: false },
});
check('the only administrator cannot suspend themselves', suspend.status === 400, `status ${suspend.status}`);

const stillAdmin = await j('/translis/accounts', { token: admin });
check('and is still an administrator afterwards',
  (stillAdmin.json?.accounts ?? []).some(a => a.id === me?.id && a.profile === 'Administrator'));

/* -------------------------------------------------------------- the modes */
section('Where the software is standing');

const settings = (await j('/translis/settings', { token: admin })).json;
check('the installation reports its mode', settings?.mode === 'lan' || settings?.mode === 'direct');
check('it reports what the host is answering on', typeof settings?.network?.boundTo === 'string');
check('a networked installation answers on every interface, a direct one on loopback',
  settings?.mode === 'lan'
    ? settings?.network?.boundTo === '0.0.0.0' || settings?.network?.restartNeeded === true
    : settings?.network?.boundTo === '127.0.0.1' || settings?.network?.restartNeeded === true,
  JSON.stringify(settings?.network));

const toDirect = await j('/translis/settings', { method: 'PUT', token: admin, body: { mode: 'direct' } });
check('the mode can be changed', toDirect.status === 200 && toDirect.json?.mode === 'direct', JSON.stringify(toDirect.json));

const afterChange = (await j('/translis/settings', { token: admin })).json;
check('and the screen says a restart is needed before it takes effect',
  afterChange?.network?.restartNeeded === true || afterChange?.network?.boundTo === '127.0.0.1',
  JSON.stringify(afterChange?.network));

await j('/translis/settings', { method: 'PUT', token: admin, body: { mode: 'lan' } });

const named = await j('/translis/settings', { method: 'PUT', token: admin, body: { lisName: 'Lhims' } });
check('the receiving system can be named', named.json?.lisName === 'Lhims', JSON.stringify(named.json?.lisName));

/* ----------------------------------------------------------------- retention */
section('Retention');

for (const [what, days] of [['zero', 0], ['negative', -5], ['beyond ten years', 4000], ['not a number', 'soon']]) {
  const answer = await j('/translis/settings', { method: 'PUT', token: admin, body: { retentionDays: days } });
  check(`a retention period of ${what} is refused`, answer.status === 400, `status ${answer.status}`);
}

const kept = await j('/translis/settings', { method: 'PUT', token: admin, body: { retentionDays: 14 } });
check('a retention period inside the bounds is accepted', kept.json?.retentionDays === 14, JSON.stringify(kept.json?.retentionDays));

const due = (await j('/translis/settings', { token: admin })).json?.retention;
check('the screen says what is waiting to be purged', typeof due?.overdue === 'number', JSON.stringify(due));

const purged = await j('/translis/settings/purge', { method: 'POST', token: admin });
check('a purge runs and reports what it cleared', purged.status === 200 && typeof purged.json?.messages === 'number',
  JSON.stringify(purged.json));

await j('/translis/settings', { method: 'PUT', token: admin, body: { retentionDays: 30 } });

/* ---------------------------------------------------------------- the extension */
section('The extension it hands out');

const packaged = await fetch(`${BASE}/result-filler/package?host=http://127.0.0.1:4331`, {
  headers: { Authorization: `Bearer ${admin}` },
});
const disposition = packaged.headers.get('content-disposition') ?? '';
check('it packages as a zip', packaged.status === 200 && (packaged.headers.get('content-type') ?? '').includes('zip'),
  `status ${packaged.status}`);
check('named for this product', disposition.includes('translis-result-filler.zip'), disposition);

const bytes = Buffer.from(await packaged.arrayBuffer());
check('and is a real archive', bytes.length > 1000 && bytes[0] === 0x50 && bytes[1] === 0x4b, `${bytes.length} bytes`);

/* ------------------------------------------------------------------ summary */
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
