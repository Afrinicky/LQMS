/**
 * Can anybody other than this computer open the laboratory?
 *
 * The failure this guards against already happened once: the host bound to
 * loopback, a browser on another machine timed out with nothing to go on, and
 * the settings screen printed a bind address and left somebody to infer the
 * rest. So what is checked here is not really Tailscale — it is that the host
 * gives a straight answer about its own reachability, and never hangs or throws
 * while doing it on a machine where Tailscale is missing, stopped, or broken.
 *
 * Tailscale is not installed on a test host and does not need to be. The CLI is
 * replaced with a stub that answers the way the real one does, including the
 * ways it fails.
 *
 *   npx tsx scripts/remote-access-check.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sech-remote-'));
const dataDir = path.join(scratch, 'data');
fs.mkdirSync(dataDir, { recursive: true });
process.env.SECH_LIMS_DATA_DIR = dataDir;

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

const ts = await import('../server/services/tailscale.ts');

/**
 * A stand-in for the tailscale CLI. Writes a script that prints whatever the
 * scenario says and exits how the scenario says, then points the module at it.
 */
function stubCli({ statusJson, serveJson, exitCode = 0, hang = false }) {
  const file = path.join(scratch, `tailscale-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(file, `#!/usr/bin/env node
const args = process.argv.slice(2).join(' ');
${hang ? 'setTimeout(() => {}, 60000);' : ''}
if (args.startsWith('status')) process.stdout.write(${JSON.stringify(statusJson ?? '')});
if (args.startsWith('serve')) process.stdout.write(${JSON.stringify(serveJson ?? '')});
${hang ? '' : `process.exit(${exitCode});`}
`);
  fs.chmodSync(file, 0o755);
  ts.__setCliForTests(file);
  return file;
}

const RUNNING = JSON.stringify({
  BackendState: 'Running',
  Self: { DNSName: 'lab-host.tail1a2b.ts.net.', TailscaleIPs: ['100.93.142.70', 'fd7a::1'] },
});
const SERVING = JSON.stringify({
  Web: { 'lab-host.tail1a2b.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:4317' } } } },
});
const SERVING_OTHER_PORT = JSON.stringify({
  Web: { 'lab-host.tail1a2b.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:9999' } } } },
});

/* ------------------------------------------------ 1. nothing installed */
console.log('\n[1] A computer with no Tailscale still gets a straight answer');

// Genuinely absent, which is a missing binary rather than one that fails —
// a stub that exits non-zero is still a file, and would be reported as
// installed-but-broken. That is a different sentence to the person reading it.
ts.__setCliForTests(path.join(scratch, 'no-tailscale-here'));
let r = await ts.reachability({ host: '127.0.0.1', port: 4317, lanExposed: false });
check('it does not claim to be reachable', r.reachable === false);
check('the route is none', r.route === 'none', r.route);
check('and the advice starts with installing Tailscale', /Install Tailscale/i.test(r.advice ?? ''), r.advice);
check('nothing is reported as a fault', r.tailscale.installed === false && r.tailscale.error === null);

/* ------------------------------------------- 2. installed, not signed in */
console.log('\n[2] Installed but not signed in says so, rather than "not installed"');

stubCli({ statusJson: JSON.stringify({ BackendState: 'NeedsLogin', Self: {} }) });
r = await ts.reachability({ host: '127.0.0.1', port: 4317, lanExposed: false });
check('it is seen as installed', r.tailscale.installed === true);
check('but not running', r.tailscale.running === false);
check('and the advice is to sign in', /not logged in|sign in/i.test(r.advice ?? ''), r.advice);
check('no command is suggested yet', !/serve --bg/.test(r.advice ?? ''), r.advice);

/* --------------------------------------- 3. signed in, not yet publishing */
console.log('\n[3] Signed in but not publishing gets the exact command');

stubCli({ statusJson: RUNNING, serveJson: '{}' });
r = await ts.reachability({ host: '127.0.0.1', port: 4317, lanExposed: false });
check('Tailscale is running', r.tailscale.running === true);
check('the machine name is known', r.tailscale.dnsName === 'lab-host.tail1a2b.ts.net', r.tailscale.dnsName);
check('the trailing dot is not shown to anybody', !(r.tailscale.dnsName ?? '').endsWith('.'));
check('the tailnet address is known', r.tailscale.ip === '100.93.142.70', r.tailscale.ip);
check('it is still not reachable', r.reachable === false);
check('and the advice carries the command, with the right port',
  /tailscale serve --bg 4317/.test(r.advice ?? ''), r.advice);

/* ------------------------------------------------- 4. actually publishing */
console.log('\n[4] Publishing is recognised, and the address is handed over');

stubCli({ statusJson: RUNNING, serveJson: SERVING });
r = await ts.reachability({ host: '127.0.0.1', port: 4317, lanExposed: false });
check('it is reachable', r.reachable === true);
check('over Tailscale', r.route === 'tailscale', r.route);
check('the address is the tailnet name, over https',
  r.url === 'https://lab-host.tail1a2b.ts.net/', r.url);
check('there is nothing left to advise', r.advice === null, r.advice ?? '');
check('and the table can say it is publishing', r.tailscale.serving === true);

/* ------------------------------- 5. publishing something else is not this */
console.log('\n[5] A serve rule for a different port is not mistaken for this one');

stubCli({ statusJson: RUNNING, serveJson: SERVING_OTHER_PORT });
r = await ts.reachability({ host: '127.0.0.1', port: 4317, lanExposed: false });
check('it is not reported as reachable', r.reachable === false, JSON.stringify(r.url));
check('and the command is still offered', /serve --bg 4317/.test(r.advice ?? ''));

/* --------------------------------------------------- 6. the LAN-bound case */
console.log('\n[6] A host open to the whole network is reachable, and told the cost');

stubCli({ statusJson: RUNNING, serveJson: '{}' });
r = await ts.reachability({ host: '0.0.0.0', port: 4317, lanExposed: true });
check('it is reachable', r.reachable === true);
check('over the LAN', r.route === 'lan', r.route);
check('and it says what that means', /whole network/i.test(r.advice ?? ''), r.advice);

/* ------------------------------------------------------- 7. it never hangs */
console.log('\n[7] A Tailscale that has stopped answering does not hold the screen');

stubCli({ hang: true });
const started = Date.now();
r = await ts.reachability({ host: '127.0.0.1', port: 4317, lanExposed: false });
const elapsed = Date.now() - started;
check('it gives up rather than waiting', elapsed < 12000, `${elapsed}ms`);
check('and still answers the question', r.reachable === false && !!r.advice);

/* ------------------------------------------ 8. nonsense from the CLI */
console.log('\n[8] Unreadable output is survived');

stubCli({ statusJson: 'not json at all' });
r = await ts.reachability({ host: '127.0.0.1', port: 4317, lanExposed: false });
check('it does not throw', r.reachable === false);
check('and says something rather than nothing', !!r.advice || !!r.tailscale.error);

fs.rmSync(scratch, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
