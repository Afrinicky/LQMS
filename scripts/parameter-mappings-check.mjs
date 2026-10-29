/**
 * Parameter mappings: what a result is called at each step of its journey.
 *
 * What this establishes:
 *   every analyser link is offered with what its model already understands;
 *   the codes a link has actually received are reported, and the ones nothing
 *   names are reported first;
 *   a name saved here is read on the very next message — WITHOUT the link
 *   being restarted, because a name is not a socket and a laboratory must not
 *   pay for a rename with a reconnection;
 *   and what LHIMS files a parameter under is configurable per link.
 *
 *   npm run api        (in one terminal)
 *   node scripts/parameter-mappings-check.mjs
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

const st = await j('/setup/status');
if (!st.json?.setupComplete) {
  await j('/setup/initialize', { method: 'POST', body: { facilityName: 'Mapping Lab', username: 'admin', password: PW, fullName: 'Admin User' } });
}
const A = (await j('/auth/login', { method: 'POST', body: { username: 'admin', password: PW } })).json?.token;
if (!A) { console.error(`Could not sign in — is the API running on ${BASE}?`); process.exit(1); }

const stamp = Date.now().toString(36).toUpperCase();
const PORT = 16200 + (Date.now() % 300);

/* ---- an analyser whose codes nobody has named --------------------------- */
console.log('\n[1] What an analyser calls each parameter');

const link = await j('/instrument-links', { token: A, method: 'POST', body: {
  name: `Mapping analyser ${stamp}`, role: 'sechlims_only', mode: 'server', protocol: 'hl7',
  listenPort: PORT, profileKey: 'sysmex_xn',
} });
check('a link to map can be created', link.status === 201, JSON.stringify(link.json)?.slice(0, 140));
await wait(500);

const all = await j('/middleware/parameter-mappings', { token: A });
const mine = (all.json?.links ?? []).find(l => l.id === link.json.id);
check('the mappings screen lists the link', Boolean(mine), `${(all.json?.links ?? []).length} link(s)`);
check('with the model it is set to', mine?.profileLabel?.includes('Sysmex XN'), JSON.stringify(mine?.profileLabel));
check('and what that model already understands is offered',
  (all.json?.profiles ?? []).some(p => p.key === 'sysmex_xn' && Object.keys(p.analytes ?? {}).length > 5),
  `${(all.json?.profiles ?? []).length} profile(s)`);
check('along with the maps LHIMS files results under',
  (all.json?.lhimsMaps ?? []).some(m => Array.isArray(m.measures) && m.measures.length > 5),
  `${(all.json?.lhimsMaps ?? []).length} map(s)`);

/* ---- a transmission carrying a code nothing names ---------------------- */
const sendHl7 = (port, message) => new Promise((resolve, reject) => {
  const socket = net.createConnection({ host: '127.0.0.1', port });
  const timer = setTimeout(() => { socket.destroy(); reject(new Error('no acknowledgement')); }, 8000);
  socket.on('connect', () => socket.write(Buffer.concat([
    Buffer.from([0x0b]), Buffer.from(message, 'latin1'), Buffer.from([0x1c, 0x0d])])));
  socket.on('data', () => { clearTimeout(timer); setTimeout(() => { socket.end(); resolve(); }, 120); });
  socket.on('error', e => { clearTimeout(timer); reject(e); });
});

const oru = id => [
  `MSH|^~\\&|XN|Sysmex|||20261029120000||ORU^R01|${id}|P|2.3.1`,
  `OBR|1||${id}|00001^Automated Count^99MRC`,
  'OBX|1|NM|6690-2^WBC^LN||7.42|10*9/L|4.0-10.0|N|||F',
  // A mnemonic no profile knows: this is the one a laboratory has to name.
  // HL7 carries the identifier, the text and the coding system; the text is
  // what an analyser's own word for a parameter actually lives in.
  `OBX|2|NM|99ZZ^ZZHOUSE${stamp}^99MRC||3.14|ratio||N|||F`,
].join('\r');

await sendHl7(PORT, oru(`MAP1_${stamp}`));
await wait(900);

const seen = await j(`/middleware/parameter-mappings/${link.json.id}/codes`, { token: A });
const codes = seen.json?.codes ?? [];
check('the codes the analyser sent are reported', codes.length >= 2, JSON.stringify(codes.map(c => c.code)));
const house = codes.find(c => c.code === `ZZHOUSE${stamp}`);
check('a code nothing names says so', house?.namedBy === 'none', JSON.stringify(house));
check('and a code the model knows says which', codes.find(c => c.code === 'WBC')?.namedBy === 'profile',
  JSON.stringify(codes.find(c => c.code === 'WBC')));
check('the unnamed one is listed first, where it will be seen',
  codes[0]?.namedBy === 'none', JSON.stringify(codes.map(c => `${c.code}:${c.namedBy}`)));

/* ---- naming it, without disturbing the transmission -------------------- */
console.log('\n[2] A name is not a socket');

const before = (await j('/instrument-links', { token: A })).json?.find(l => l.id === link.json.id);
const saved = await j(`/middleware/parameter-mappings/${link.json.id}`, { token: A, method: 'PUT', body: {
  analyteMap: { [`ZZHOUSE${stamp}`]: 'House index' },
} });
check('the name is saved', saved.status === 200 && saved.json?.analyteMap?.[`ZZHOUSE${stamp}`] === 'House index',
  JSON.stringify(saved.json));

const after = (await j('/instrument-links', { token: A })).json?.find(l => l.id === link.json.id);
check('and the link is still listening — it was never restarted',
  after?.state === before?.state && ['listening', 'connected'].includes(String(after?.state)),
  `${before?.state} then ${after?.state}`);

// The proof that matters: the very next message is read with the new name.
await sendHl7(PORT, oru(`MAP2_${stamp}`));
await wait(900);
const reread = await j(`/middleware/parameter-mappings/${link.json.id}/codes`, { token: A });
const named = (reread.json?.codes ?? []).find(c => c.code === `ZZHOUSE${stamp}`);
check('the next message is read with the new name', named?.analyte === 'House index', JSON.stringify(named));
check('and the register says this link named it', named?.namedBy === 'link', JSON.stringify(named));

const messages = await j(`/instrument-links/${link.json.id}/messages`, { token: A });
const latest = (messages.json ?? []).find(m => String(m.raw_message ?? '').includes(`MAP2_${stamp}`));
check('the stored result carries the name, not the code',
  (latest?.parsed_values ?? []).some(v => v.analyte === 'House index'),
  JSON.stringify((latest?.parsed_values ?? []).map(v => `${v.code}->${v.analyte}`)));

/* ---- what LHIMS calls it ----------------------------------------------- */
console.log('\n[3] What LHIMS files it under');

const lhims = await j(`/middleware/parameter-mappings/${link.json.id}`, { token: A, method: 'PUT', body: {
  lhimsMapKey: 'sysmex_xs500i', measureMap: { 'House index': 91 },
} });
check('a map and an id by hand are both accepted',
  lhims.status === 200 && lhims.json?.lhimsMapKey === 'sysmex_xs500i' && lhims.json?.measureMap?.['House index'] === 91,
  JSON.stringify(lhims.json));
check('and the name saved earlier is not lost by saving the ids',
  lhims.json?.analyteMap?.[`ZZHOUSE${stamp}`] === 'House index', JSON.stringify(lhims.json?.analyteMap));

const nonsense = await j(`/middleware/parameter-mappings/${link.json.id}`, { token: A, method: 'PUT', body: {
  lhimsMapKey: 'not-a-map',
} });
check('a map this system does not know is refused', nonsense.status === 400, `${nonsense.status}`);

await j(`/instrument-links/${link.json.id}/stop`, { token: A, method: 'POST' });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
