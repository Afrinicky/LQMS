/**
 * Whether other devices on the network can reach this host — and whether that
 * survives a restart.
 *
 * The failure this exists to stop is a quiet one. The host binds to loopback by
 * default and is opened to the network by an environment variable. An
 * environment variable belongs to whatever shell or shortcut started the host,
 * so the first restart puts it back on loopback. A laboratory published over
 * Tailscale does not notice, because Tailscale proxies to 127.0.0.1 and
 * loopback is all it needs; the plain network address simply stops answering.
 * One route up, one route down, and nothing anywhere saying why.
 *
 * So the choice is stored with everything else the laboratory decides, and the
 * point of this file is the second server start: the same database, a new
 * process, no environment variable, and the network still reachable.
 *
 *   node scripts/lan-access-check.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

const dir = mkdtempSync(path.join(tmpdir(), 'sechlims-lan-'));
const DB = path.join(dir, 'lan.sqlite');
const PORT = 45300 + Math.floor(Math.random() * 300);
const PW = 'Passw0rd!test';
const wait = ms => new Promise(r => setTimeout(r, ms));

/**
 * Start a host against the same database, with the environment we choose.
 *
 * Detached, and killed by process GROUP. `npx tsx` puts two processes between
 * this one and the server, so killing the child alone leaves the server holding
 * the port — and every "restart" after that quietly talks to the first host,
 * which is exactly the bug this file exists to catch, arriving as a pass.
 */
function startHost(env = {}) {
  const child = spawn('npx', ['tsx', 'server/index.ts'], {
    // Its own data folder as well as its own database: the address and port
    // this host listens on live in a file there, and a check that shared that
    // folder with the developer's own host would read somebody else's choice.
    env: { ...process.env, API_PORT: String(PORT), SECH_LIMS_DATA_DIR: dir, SECH_LIMS_DB_PATH: DB, SECH_LIMS_API_HOST: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let log = '';
  child.stdout.on('data', d => { log += d.toString(); });
  child.stderr.on('data', d => { log += d.toString(); });
  return {
    child,
    log: () => log,
    async ready() {
      for (let i = 0; i < 90; i++) {
        try {
          const r = await fetch(`http://127.0.0.1:${PORT}/api/setup/status`);
          if (r.ok) return true;
        } catch { /* not up yet */ }
        await wait(1000);
      }
      return false;
    },
    async stop() {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
      // Wait for the port to be genuinely free, rather than for a signal to
      // have been sent. A half-stopped host answers, and a check that talks to
      // yesterday's process proves nothing.
      for (let i = 0; i < 40; i++) {
        await wait(250);
        let answered = false;
        try {
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), 500);
          await fetch(`http://127.0.0.1:${PORT}/api/setup/status`, { signal: ctrl.signal });
          clearTimeout(t);
          answered = true;
        } catch { answered = false; }
        if (!answered) return;
        if (i === 12) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }
      }
      throw new Error(`the host on port ${PORT} would not stop`);
    },
  };
}

const j = async (p, o = {}) => {
  const r = await fetch(`http://127.0.0.1:${PORT}/api${p}`, {
    method: o.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(o.token ? { Authorization: `Bearer ${o.token}` } : {}) },
    body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => null) };
};

/** Does anything answer on an address that is not loopback? */
async function reachableOffLoopback(address) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2500);
    const r = await fetch(`http://${address}:${PORT}/api/setup/status`, { signal: ctrl.signal });
    clearTimeout(t);
    return r.ok;
  } catch { return false; }
}

const { networkInterfaces } = await import('node:os');
const lanAddress = Object.values(networkInterfaces()).flat()
  .find(n => n && n.family === 'IPv4' && !n.internal)?.address ?? null;

let host;
try {
  /* ============================================ 1. the default is loopback */
  console.log('\n[1] Out of the box, only this computer can open the laboratory');
  host = startHost();
  check('the host starts', await host.ready(), host.log().slice(-400));
  check('and says it is listening on this computer only', /this computer only/.test(host.log()), host.log().slice(-200));

  await j('/setup/initialize', { method: 'POST', body: { facilityName: 'LAN Lab', username: 'admin', password: PW, fullName: 'Admin User' } });
  const A = (await j('/auth/login', { method: 'POST', body: { username: 'admin', password: PW } })).json?.token;

  let info = (await j('/system/connectivity', { token: A })).json;
  check('the screen reports it as not on the network', info?.lan?.exposed === false, JSON.stringify(info?.lan));
  check('and that the laboratory is not asking for the network', info?.lan?.choice === false, JSON.stringify(info?.lan));
  check('and that the choice is not locked to the environment', info?.lan?.lockedToEnvironment === false);
  if (lanAddress) {
    check('nothing answers on this machine’s network address', !(await reachableOffLoopback(lanAddress)));
  }

  /* ================================================ 2. switching it on */
  console.log('\n[2] Switching the network on');
  const on = await j('/system/lan', { token: A, method: 'PUT', body: { enabled: true } });
  check('the setting is accepted', on.status === 200, JSON.stringify(on.json));
  check('and says it takes effect at the next restart', on.json?.appliesAtRestart === true);

  info = (await j('/system/connectivity', { token: A })).json;
  check('the choice is recorded', info?.lan?.choice === true);
  check('but nothing has changed yet on the running host', info?.lan?.exposed === false);

  /* =========================== 3. THE POINT: it survives the restart */
  console.log('\n[3] The restart that used to undo it');
  await host.stop();
  host = startHost();
  check('the host starts again, with no environment variable set', await host.ready(), host.log().slice(-400));
  check('and this time says it is reachable from the network',
    /reachable from the network/.test(host.log()), host.log().slice(-200));

  const B = (await j('/auth/login', { method: 'POST', body: { username: 'admin', password: PW } })).json?.token;
  info = (await j('/system/connectivity', { token: B })).json;
  check('the screen reports it as on the network', info?.lan?.exposed === true, JSON.stringify(info?.lan));
  check('and offers the address to hand to another device', (info?.lanUrls ?? []).length > 0, JSON.stringify(info?.lanUrls));
  if (lanAddress) {
    check('and the network address really answers', await reachableOffLoopback(lanAddress));
    check('the address offered is the one that works',
      (info?.lanUrls ?? []).some(u => u.includes(lanAddress) && u.includes(String(PORT))), JSON.stringify(info?.lanUrls));
  }

  /* ================================================== 4. switching it off */
  console.log('\n[4] Switching it off again');
  const off = await j('/system/lan', { token: B, method: 'PUT', body: { enabled: false } });
  check('the setting is accepted', off.status === 200);
  await host.stop();
  host = startHost();
  check('the host starts', await host.ready());
  check('back on this computer only', /this computer only/.test(host.log()), host.log().slice(-200));
  if (lanAddress) {
    check('and the network address stops answering', !(await reachableOffLoopback(lanAddress)));
  }

  /* ===================== 5. a deployment that set it deliberately still wins */
  console.log('\n[5] The laboratory\'s own choice outranks the environment it was installed with');
  // This used to be the other way round, and that is what left a laboratory
  // unable to fix its own network: the host had SECH_LIMS_API_HOST set by
  // whatever shortcut installed it, so the switch on the settings screen was
  // drawn permanently disabled, and the only remedy was an environment
  // variable on a machine nobody could log in to. An environment variable may
  // seed a host that has never been configured. It may not overrule one that
  // has.
  await host.stop();
  host = startHost({ SECH_LIMS_API_HOST: '0.0.0.0' });
  check('the host starts', await host.ready());
  check('and stays where this laboratory put it, not where the variable says',
    /this computer only/.test(host.log()), host.log().slice(-200));

  const C = (await j('/auth/login', { method: 'POST', body: { username: 'admin', password: PW } })).json?.token;
  info = (await j('/system/connectivity', { token: C })).json;
  check('the screen does not claim the environment is in charge', info?.lan?.lockedToEnvironment === false,
    JSON.stringify(info?.lan));
  check('and names the file the answer really comes from',
    /connectivity\.json$/.test(String(info?.settingsFile?.path ?? '')), JSON.stringify(info?.settingsFile));

  const accepted = await j('/system/lan', { token: C, method: 'PUT', body: { enabled: true } });
  check('the switch works even on a host whose environment names an address',
    accepted.status === 200, JSON.stringify(accepted.json));

  await host.stop();
  host = startHost({ SECH_LIMS_API_HOST: '127.0.0.1' });
  check('the host starts once more', await host.ready());
  check('on the network, because that is what this laboratory chose',
    /reachable from the network/.test(host.log()), host.log().slice(-200));

} finally {
  if (host) await host.stop();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* a temp directory */ }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
