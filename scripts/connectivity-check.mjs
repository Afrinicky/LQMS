/**
 * How this host decides what to listen on.
 *
 * The regression this exists to prevent: for a while, that decision was a
 * database read. Starting the server meant opening SQLite and running every
 * migration before the first socket could be bound, and every failure in that
 * path was caught and answered with "listen on loopback". So a database that
 * was locked for a second, or a migration that threw on one host, took the
 * whole laboratory off the network — the desktop window still worked, because
 * it talks to 127.0.0.1, while every bench and every Tailscale address stopped
 * answering with nothing anywhere saying why.
 *
 * Deciding how to listen must therefore touch nothing but one small file, and
 * a facility must be able to set it without an administrator, an environment
 * variable, or a code change.
 *
 *   npx tsx scripts/connectivity-check.mjs
 */
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-check-'));
process.env.SECH_LIMS_DATA_DIR = scratch;
delete process.env.SECH_LIMS_API_HOST;
delete process.env.API_PORT;

const hb = await import('../server/services/hostBinding.ts');

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};
const file = hb.connectivityFilePath();
const write = text => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));

/* ============================================================ 1. first run */
console.log('\n[1] A laboratory that has never been configured');
let state = hb.networkConfig(true);
check('starts on this computer only', state.host === '127.0.0.1', state.host);
check('on the default port', state.port === 4317, String(state.port));
check('and the file is written, so there is something to change', fs.existsSync(file));
check('with the values it just resolved', read().host === '127.0.0.1' && read().port === 4317, JSON.stringify(read()));

/* ====================================================== 2. the file decides */
console.log('\n[2] The file is the answer, and nothing else is consulted');
write(JSON.stringify({ host: '0.0.0.0', port: 4480 }));
state = hb.networkConfig(true);
check('an address set in the file is used', state.host === '0.0.0.0', state.host);
check('and so is the port', state.port === 4480, String(state.port));
check('it is reported as coming from the file', state.source === 'file', state.source);
check('and the laboratory counts as open to the network', hb.lanChosen() === true);

/* =================================== 3. the regression: no database involved */
console.log('\n[3] A database that cannot be opened changes nothing');
// There is no database at all in this scratch directory, and no getDb is
// passed anywhere. If deciding how to listen needed one, this would be
// loopback — which is exactly the outage being guarded against.
check('the address still resolves from the file', hb.resolveBindHost() === '0.0.0.0', hb.resolveBindHost());
check('the port still resolves from the file', hb.resolvePort() === 4480, String(hb.resolvePort()));
check('and nothing in resolving it takes a database handle',
  hb.resolveBindHost.length === 0 && hb.resolvePort.length === 0,
  `${hb.resolveBindHost.length} / ${hb.resolvePort.length}`);

/* ============================================= 4. a file somebody hand-edited */
console.log('\n[4] A file edited by hand, well or badly');
write('{ this is not json');
state = hb.networkConfig(true);
check('unreadable JSON does not stop the host', state.host === '127.0.0.1' && state.port === 4317, JSON.stringify(state));
check('and it says so rather than failing silently', Boolean(state.problem), String(state.problem));
check('the file is rewritten with something valid', read().host === '127.0.0.1');

write(JSON.stringify({ host: 'nonsense', port: 70 }));
state = hb.networkConfig(true);
check('a nonsense address falls back rather than crashing listen()', state.host === '127.0.0.1', state.host);
check('and a port outside the usable range falls back too', state.port === 4317, String(state.port));

/* ============================================ 5. the screen writes the file */
console.log('\n[5] Set from the settings screen');
write(JSON.stringify({ host: '127.0.0.1', port: 4317 }));
hb.networkConfig(true);
hb.writeNetworkConfig({ host: '0.0.0.0' });
check('switching the network on is written down', read().host === '0.0.0.0', JSON.stringify(read()));
check('and the port is left alone', read().port === 4317, JSON.stringify(read()));
hb.writeNetworkConfig({ port: 4500 });
check('changing the port is written down', read().port === 4500, JSON.stringify(read()));
check('and the address is left alone', read().host === '0.0.0.0', JSON.stringify(read()));
let refused = null;
try { hb.writeNetworkConfig({ port: 22 }); } catch (e) { refused = String(e); }
check('a port the host cannot use is refused', refused !== null, String(refused));
check('and the file is not damaged by the attempt', read().port === 4500, JSON.stringify(read()));

/* ====================== 6. an environment variable seeds, and then lets go */
console.log('\n[6] An environment variable seeds a new host and then stops mattering');
// In its own process: the configuration is read once at import, so the only
// honest way to test what a freshly installed host does is to start one.
const second = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-check-2-'));
const seeded = path.join(second, 'config', 'connectivity.json');
const probe = path.join(second, 'probe.mjs');
fs.writeFileSync(probe, `
  const hb = await import(${JSON.stringify(path.resolve('server/services/hostBinding.ts'))});
  const first = hb.networkConfig(true);
  // What the screen does next, on a host its installer configured.
  hb.writeNetworkConfig({ host: '127.0.0.1' });
  process.stdout.write(JSON.stringify({ first, after: hb.networkConfig(true) }));
`);
const run = spawnSync(process.execPath, ['--import', 'tsx', probe], {
  env: { ...process.env, SECH_LIMS_DATA_DIR: second, SECH_LIMS_API_HOST: '0.0.0.0', API_PORT: '4600' },
  encoding: 'utf8',
});
const answer = (() => { try { return JSON.parse(run.stdout); } catch { return null; } })();
check('a freshly installed host starts', answer !== null, `${run.stdout}\n${run.stderr}`.slice(0, 400));
check('and a host configured by its installer keeps working',
  answer?.first?.host === '0.0.0.0' && answer?.first?.port === 4600, JSON.stringify(answer?.first));
check('the choice is written to the file, where it can be changed',
  fs.existsSync(seeded) && JSON.parse(fs.readFileSync(seeded, 'utf8')).host === '127.0.0.1',
  fs.existsSync(seeded) ? fs.readFileSync(seeded, 'utf8') : 'no file');
check('and the screen overrules the environment it was seeded from',
  answer?.after?.host === '127.0.0.1', JSON.stringify(answer?.after));

/* ============================================ 7. what was asked, and what was got */
console.log('\n[7] The port it asked for, and the port it got');
hb.recordBinding('0.0.0.0', 4317, 4317);
check('a host on the port it asked for reports no conflict', hb.portMovedFromConfigured() === false);
hb.writeNetworkConfig({ port: 4500 });
check('and choosing a different port for next time is still not a conflict',
  hb.portMovedFromConfigured() === false, String(hb.askedPort()));
hb.recordBinding('0.0.0.0', 4318, 4317);
check('a host whose port was taken does report one', hb.portMovedFromConfigured() === true);

fs.rmSync(scratch, { recursive: true, force: true });
fs.rmSync(second, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
