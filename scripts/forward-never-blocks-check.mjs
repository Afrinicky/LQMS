/**
 * A receiving system that is not answering must cost the analyser nothing.
 *
 * The laboratory pointed a Humacount at SECHLIMS, turned on carrying results to
 * LHIMS, and the analyser stopped getting through: "connected … read
 * ECONNRESET", forty seconds apart, with no acknowledgement in between.
 *
 * Carrying results onward runs on a twenty-second timer, and a result waits up
 * to fifteen seconds for a host that is not answering. Four results a message,
 * twenty-five messages a batch, LHIMS unreachable — one drain takes twenty
 * minutes, so the timer started another, and another. By the afternoon the host
 * was holding hundreds of overlapping deliveries, all waiting on answers that
 * were never coming, and the analyser's connection was one more thing it was
 * too busy to serve.
 *
 * Receiving is the thing that must never suffer. Carrying onward is the last
 * thing this bridge does and the first thing that should give way.
 *
 *   node scripts/forward-never-blocks-check.mjs
 */
import net from 'node:net';

const BASE = process.env.API || 'http://127.0.0.1:4430/api';
const PW = 'Passw0rd!test';

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
const wait = ms => new Promise(r => setTimeout(r, ms));

const VT = 0x0b, FS = 0x1c, CR = 0x0d;
/** Transmit, and report what came back and how long it took. */
function transmit(port, segments) {
  return new Promise(resolve => {
    const started = Date.now();
    const body = Buffer.from(segments.join('\r') + '\r', 'latin1');
    const frame = Buffer.concat([Buffer.from([VT]), body, Buffer.from([FS, CR])]);
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let answer = '';
    const done = note => { try { socket.destroy(); } catch { /* gone */ }
      resolve({ acknowledged: /MSA\|A/.test(answer), ms: Date.now() - started, note }); };
    const timer = setTimeout(() => done('no acknowledgement within 20s'), 20_000);
    socket.on('connect', () => socket.write(frame));
    socket.on('data', d => {
      answer += d.toString('latin1');
      if (/MSA\|A/.test(answer)) { clearTimeout(timer); done('acknowledged'); }
    });
    socket.on('error', e => { clearTimeout(timer); done(`socket error: ${e.code}`); });
  });
}
const message = sample => ([
  'MSH|^~\\&|HUMACOUNT|HUMAN|LIS|LAB|20261023085843||ORU^R01|9|P|2.3.1',
  'PID|1||P-1||Doe^Jane||19900101|F',
  `OBR|1||${sample}|CBC|||20261023085800|||||||||||||||||F`,
  'OBX|1|NM|^WBC||7.82|10*9/L|||||F', 'OBX|2|NM|^HGB||12.40|g/dL|||||F',
  'OBX|3|NM|^PLT||243|10*9/L|||||F', 'OBX|4|NM|^NEU%||54.3|%|||||F',
]);

const st = await j('/setup/status');
if (!st.json?.setupComplete) {
  await j('/setup/initialize', { method: 'POST', body: {
    facilityName: 'Blocking Lab', username: 'admin', password: PW, fullName: 'Admin User' } });
}
const A = (await j('/auth/login', { method: 'POST', body: { username: 'admin', password: PW } })).json?.token;
const stamp = Date.now();
const PORT = 50500 + (stamp % 300);

/* ========= 1. an analyser, carrying results to a system that is not there ==== */
console.log('\n[1] Carrying results to an address nothing answers on');
const sec = (await j('/section-config/sections', { token: A, method: 'POST', body: {
  name: `RCH ${stamp}`, code: `RC${String(stamp).slice(-6)}` } })).json;
const eq = (await j('/equipment', { token: A, method: 'POST', body: {
  name: `HUMACOUNT 5D ${stamp}`, equipmentCategory: 'analyser', sectionId: sec.id, status: 'operational' } })).json;

/*
 * 10.255.255.1 is reserved and routes nowhere: a connection to it hangs rather
 * than being refused, which is what an unreachable LHIMS on a hospital network
 * actually does. A refused port would answer immediately and prove nothing.
 */
const link = (await j('/instrument-links', { token: A, method: 'POST', body: {
  name: `Humacount 5D ${stamp}`, equipmentId: eq.id, sectionId: sec.id, profileKey: 'generic_hl7',
  role: 'shared_forward', mode: 'server', protocol: 'auto', listenPort: PORT, autoStart: true,
  forwardEnabled: true, forwardTarget: 'lhims_api',
  lhimsUrl: 'http://10.255.255.1/lhims_193', lhimsUsername: 'SNO-484', lhimsPassword: 'x',
  measureMap: { WBC: 23, HGB: 25, PLT: 29, 'NEU%': 31 } } })).json;
check('the link is registered and listening', Boolean(link?.id), JSON.stringify(link));
await j(`/instrument-links/${link.id}/start`, { token: A, method: 'POST' });
await wait(900);

/* ============== 2. fill the queue with work that cannot be delivered ========= */
console.log('\n[2] A queue of results the receiving system will never take');
const first = await transmit(PORT, message('2610000001'));
check('the first transmission is acknowledged', first.acknowledged, JSON.stringify(first));
for (let i = 2; i <= 10; i++) await transmit(PORT, message(`261000000${i}`));
const queued = (await j(`/instrument-links/${link.id}/messages?kind=patient`, { token: A })).json ?? [];
check('ten transmissions are recorded', queued.length === 10, `${queued.length}`);
check('and they are queued to be carried onward',
  queued.filter(m => m.forward_status === 'pending' || m.forward_status === 'failed'
    || m.forward_status === 'partial').length === 10,
  JSON.stringify([...new Set(queued.map(m => m.forward_status))]));

/* ===== 3. while the deliveries are failing, the analyser must still get through = */
console.log('\n[3] While those deliveries are timing out, the analyser keeps working');
/*
 * Long enough for several drains to have started under the old code — the timer
 * is twenty seconds and one batch of these takes minutes. The question is
 * whether the analyser is still served while that is going on.
 */
await wait(45_000);
const during = await transmit(PORT, message('2610009999'));
check('a transmission sent mid-failure is acknowledged', during.acknowledged, JSON.stringify(during));
check('and promptly, not after a queue of timeouts', during.ms < 5_000, `${during.ms} ms`);

const after = (await j(`/instrument-links/${link.id}/messages?kind=patient`, { token: A })).json ?? [];
const landed = after.find(m => m.sample_id === '2610009999');
check('the result is recorded in full', Number(landed?.result_count) === 4, JSON.stringify(landed?.result_count));
check('the link is still listening, not stopped',
  (await j('/instrument-links', { token: A })).json?.find(l => l.id === link.id)?.state !== 'error',
  JSON.stringify((await j('/instrument-links', { token: A })).json?.find(l => l.id === link.id)?.state));

/* ======== 4. and the queue is intact: nothing was lost to the giving up ====== */
console.log('\n[4] Nothing is lost by giving up on an unreachable host');
const queue = (await j(`/instrument-links/${link.id}/messages?kind=patient`, { token: A })).json ?? [];
check('every transmission is still on the books', queue.length === 11, `${queue.length}`);
check('none was marked delivered to a host that never answered',
  !queue.some(m => m.forward_status === 'sent'),
  JSON.stringify(queue.map(m => m.forward_status)));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
