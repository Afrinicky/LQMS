/**
 * The middleware engine, proved end to end — with no API and no browser.
 *
 * This is the test that decides whether the module works, because the module's
 * claim is not that it has screens: it is that a transmission arriving from an
 * analyser reaches the information systems a laboratory has configured, and
 * that what happened to it can be accounted for afterwards.
 *
 * So nothing here is mocked at the level that matters. The destinations are
 * real TCP servers in this process — one that acknowledges, one that rejects,
 * one that fails with an application error, one that never answers at all —
 * and the engine talks to them over real sockets with real framing. The
 * database is a real SQLite file in a temporary directory, created by the
 * application's own migrations.
 *
 * What is covered, in the order the checks run:
 *
 *   ASTM and HL7 parsing, framing and the outbound builders
 *   Connection establishment, rejection, application error and timeout
 *   Duplicate detection on ingestion, and idempotent enqueueing
 *   Retries with a bounded schedule, and the dead letter at the cap
 *   Queue recovery after a host that stopped mid-delivery
 *   Routing to several independent destinations at once
 *   One destination failing while another succeeds — partial delivery
 *   Field mapping, unit conversion, withheld unmapped codes, validation
 *   Configuration versioning and rollback
 *   The Sysmex XN-550 to LHIMS path, which must be refused everywhere
 *
 *   npx tsx scripts/middleware-engine-check.mjs
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sechlims-mw-'));
process.env.SECH_LIMS_DATA_DIR = root;
process.env.SECH_LIMS_SYNC_ENABLED = 'false';

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};
const section = name => console.log(`\n${name}\n${'-'.repeat(name.length)}`);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

/* ==========================================================================
   The laboratory's own protocol, played faithfully
   --------------------------------------------------------------------------
   Control characters included, because they are there on the wire and they are
   what a framing fault is made of.
   ======================================================================== */
const STX = '\x02', ETX = '\x03', VT = '\x0b', FS = '\x1c', CR = '\r', LF = '\n';

const checksum = body => {
  let sum = 0;
  for (const byte of Buffer.from(body, 'latin1')) sum = (sum + byte) & 0xff;
  return sum.toString(16).toUpperCase().padStart(2, '0');
};
const astmFrame = (record, n) => {
  const body = `${n % 8}${record}${ETX}`;
  return STX + body + checksum(body) + CR + LF;
};

/** One Sysmex-shaped ASTM transmission, framed exactly as a client writes it. */
function astmTransmission(sampleId, results, runAt = '20260420101500') {
  const records = [
    `H|\\^&|||XN-550^1|||||||P|1|${runAt}`,
    'P|1',
    `O|1|${sampleId}||^^^ALL|R|${runAt}`,
    ...results.map((r, i) => `R|${i + 1}|^^^${r.code}|${r.value}|${r.unit ?? ''}||${r.flag ?? 'N'}||F||||${runAt}`),
    'L|1|N',
  ];
  return records.map((record, i) => astmFrame(`${record}\r`, i + 1)).join('');
}

/** One HL7 v2 ORU^R01, framed in MLLP. */
function hl7Transmission(sampleId, results) {
  const segments = [
    'MSH|^~\\&|BC-5800|LAB|SECHLIMS|SECH|20260420101500||ORU^R01|MSG0001|P|2.3.1',
    `PID|1||${sampleId}`,
    `OBR|1|${sampleId}|${sampleId}|BC-5800|||20260420101500`,
    ...results.map((r, i) => `OBX|${i + 1}|NM|${r.code}^${r.code}^L||${r.value}|${r.unit ?? ''}||${r.flag ?? 'N'}|||F`),
  ];
  return VT + segments.join(CR) + FS + CR;
}

/* ==========================================================================
   Destinations that behave like real ones
   --------------------------------------------------------------------------
   Four, because the four answers a receiving system gives are the four things
   the queue has to tell apart: accepted, refused for ever, failed for now, and
   silent.
   ======================================================================== */
function mllpServer(behaviour) {
  const received = [];
  const server = net.createServer(socket => {
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk.toString('latin1');
      if (!buffer.includes(FS)) return;
      const message = buffer.replace(/^\x0b/, '').replace(/\x1c\r?$/, '');
      received.push(message);
      buffer = '';
      if (behaviour === 'silent') return;
      const controlId = (message.split(/[\r\n]+/)[0] ?? '').split('|')[9] ?? '1';
      const code = behaviour === 'reject' ? 'AR' : behaviour === 'error' ? 'AE' : 'AA';
      const reason = behaviour === 'reject' ? 'Unknown test code at this destination' : behaviour === 'error' ? 'Database unavailable' : '';
      const ack = [
        `MSH|^~\\&|DEST|DEST|SECHLIMS|SECH|20260420101500||ACK^R01|${controlId}|P|2.3.1`,
        `MSA|${code}|${controlId}|${reason}`,
      ].join(CR);
      socket.write(Buffer.concat([Buffer.from([0x0b]), Buffer.from(ack, 'latin1'), Buffer.from([0x1c, 0x0d])]));
    });
    socket.on('error', () => { /* a closed socket is the engine giving up, which is the point */ });
  });
  return { server, received };
}

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

/* ==========================================================================
   Go
   ======================================================================== */
const { ensureDataDirs, getDb } = await import('../server/db/database.js');
const protocols = await import('../server/services/instrumentBridge/protocols.js');
const middleware = await import('../shared/constants/middleware.js');
const { MiddlewareEngine } = await import('../server/services/middleware/engine.js');
const safety = await import('../server/services/middleware/safety.js');
const versions = await import('../server/services/middleware/versions.js');
const secrets = await import('../server/services/middleware/secrets.js');
const dennis = await import('../server/services/middleware/dennis.js');

ensureDataDirs();
const db = getDb();
const engine = new MiddlewareEngine(getDb);

console.log(`Analyser transmission & middleware — engine checks\nData directory: ${root}`);

/* ---------------------------------------------------------------- protocols */
section('Protocols: parsing, framing and the outbound builders');
{
  const raw = astmTransmission('SC-0001', [
    { code: 'HGB', value: '12.4', unit: 'g/dL' },
    { code: 'WBC', value: '6.2', unit: '10*9/L' },
  ]);

  check('ASTM is detected from the wire bytes', protocols.detectProtocol(raw) === 'astm',
    `detected ${protocols.detectProtocol(raw)}`);

  const split = protocols.splitTransmissions('astm', raw, { final: true });
  check('A framed ASTM transmission splits into exactly one message', split.complete.length === 1,
    `${split.complete.length} found`);

  const parsed = protocols.parseFor('astm', raw);
  check('The sample identifier survives framing', parsed[0]?.sampleId === 'SC-0001', String(parsed[0]?.sampleId));
  check('Both results are parsed with their units',
    parsed[0]?.results.length === 2 && parsed[0].results[0].unit === 'g/dL',
    JSON.stringify(parsed[0]?.results));

  const hl7 = hl7Transmission('SC-0002', [{ code: 'GLU', value: '5.1', unit: 'mmol/L' }]);
  check('HL7 is detected from the wire bytes', protocols.detectProtocol(hl7) === 'hl7',
    String(protocols.detectProtocol(hl7)));
  const hl7Parsed = protocols.parseFor('hl7', hl7);
  check('HL7 OBX results are parsed', hl7Parsed[0]?.results[0]?.code === 'GLU' && hl7Parsed[0].results[0].value === '5.1',
    JSON.stringify(hl7Parsed[0]?.results));

  // Outbound. A builder that cannot be re-read by the parser beside it is a
  // builder that will be rejected by somebody else's parser too.
  const outbound = {
    sampleId: 'SC-0003', runAt: '2026-04-20T10:15:00', instrument: 'XN-550', kind: 'patient',
    results: [{ code: 'HGB', name: 'Haemoglobin', value: '13.1', unit: 'g/dL', flag: 'N' }],
  };
  const builtHl7 = protocols.buildHl7Oru(outbound, { controlId: 'CTRL1', receivingApplication: 'HIS' });
  // OBX-3 is `identifier^text^coding system`, which is what a receiving system
  // reads. The inbound parser above deliberately prefers the TEXT component,
  // because several analysers in this laboratory put the mnemonic there — so
  // the round trip is asserted on the segment and on the value, not on which
  // component that parser happens to favour.
  check('A built HL7 message carries the code as the identifier and the name as the text',
    builtHl7.includes('OBX|1|NM|HGB^Haemoglobin^L|'), builtHl7.split('\r').pop());
  const reread = protocols.parseFor('hl7', builtHl7);
  check('A built HL7 message parses back with the same value, unit and sample',
    reread[0]?.sampleId === 'SC-0003' && reread[0].results[0].value === '13.1' && reread[0].results[0].unit === 'g/dL',
    JSON.stringify(reread[0]?.results));
  check('A built HL7 message carries the control id the acknowledgement must echo',
    builtHl7.includes('CTRL1'));

  const builtAstm = protocols.buildAstmRecords(outbound, { controlId: 'CTRL2' });
  const astmReread = protocols.parseFor('astm', builtAstm.join('\r\n'));
  check('A built ASTM transmission parses back to the same result',
    astmReread[0]?.results[0]?.code === 'HGB' && astmReread[0].sampleId === 'SC-0003',
    JSON.stringify(astmReread[0]));
  check('A built ASTM transmission is terminated', builtAstm[builtAstm.length - 1].startsWith('L|'));

  const frames = protocols.frameAstmRecords(builtAstm);
  const firstFrame = frames[0].toString('latin1');
  check('Each ASTM frame carries STX, a frame number and a checksum',
    firstFrame.startsWith(STX) && /\x03[0-9A-F]{2}\r\n$/.test(firstFrame),
    JSON.stringify(firstFrame.slice(0, 12)));

  // HL7 escaping: an ampersand in a name must not break the segment after it.
  check('HL7 escaping protects the delimiters',
    protocols.hl7Escape('A|B^C&D') === 'A\\F\\B\\S\\C\\T\\D',
    protocols.hl7Escape('A|B^C&D'));

  const ack = protocols.readHl7Ack(`${VT}MSH|^~\\&|D|D|S|S|1||ACK^R01|X|P|2.3.1${CR}MSA|AR|X|No such code${FS}${CR}`);
  check('An AR acknowledgement reads as a rejection, not a retry', ack.rejected && !ack.accepted, ack.code);
  const accepted = protocols.readHl7Ack(`${VT}MSH|^~\\&|D|D|S|S|1||ACK^R01|X|P|2.3.1${CR}MSA|AA|X${FS}${CR}`);
  check('An AA acknowledgement reads as acceptance', accepted.accepted && !accepted.rejected, accepted.code);
}

/* ------------------------------------------------------- retries and tones */
section('Retry schedule and queue vocabulary');
{
  const first = middleware.retryDelayMs(1, { seed: 1 });
  const third = middleware.retryDelayMs(3, { seed: 1 });
  const far = middleware.retryDelayMs(20, { seed: 1 });
  check('The retry delay grows with the attempt', third > first, `${first} then ${third}`);
  check('The retry delay is capped', far <= middleware.RETRY_CEILING_MS * 1.1, String(far));
  check('The schedule is deterministic for one delivery',
    middleware.retryDelayMs(2, { seed: 7 }) === middleware.retryDelayMs(2, { seed: 7 }));
  check('Two deliveries that failed together do not come back together',
    middleware.retryDelayMs(2, { seed: 7 }) !== middleware.retryDelayMs(2, { seed: 13 }));
  check('A delivered delivery is terminal', middleware.deliveryIsTerminal('delivered'));
  check('A retrying delivery is not terminal', !middleware.deliveryIsTerminal('retrying'));
  check('A dead letter may be replayed', middleware.deliveryIsReplayable('dead_letter'));
  check('A delivered delivery may not be replayed', !middleware.deliveryIsReplayable('delivered'));
  check('A destination with no acknowledgement cannot confirm acceptance',
    !middleware.deliveryIsConfirmable('none') && middleware.deliveryIsConfirmable('protocol_ack'));
}

/* ------------------------------------------------------------- validation */
section('Validation and field mapping');
{
  const blocked = middleware.validateMessage({
    sampleId: '', lotNumber: null, instrument: null, runAt: null, kind: 'patient', results: [],
  });
  check('A message with no identifier and no result is refused',
    middleware.validationBlocks(blocked), JSON.stringify(blocked));

  const warned = middleware.validateMessage({
    sampleId: 'SC-1', lotNumber: null, instrument: null, runAt: null, kind: 'patient',
    results: [{ code: 'HGB', analyte: 'Haemoglobin', value: '12', unit: null, flag: null }],
  });
  check('A missing unit is a warning, not a refusal',
    !middleware.validationBlocks(warned) && warned.some(f => f.severity === 'warning'),
    JSON.stringify(warned));

  const routed = middleware.routeMatches(
    { messageKind: 'patient', testCodes: ['HGB'] },
    { linkId: 1, kind: 'patient', codes: ['HGB', 'WBC'] },
  );
  check('A rule matches a message carrying one of its test codes', routed);
  check('A rule does not match a different kind of message',
    !middleware.routeMatches({ messageKind: 'control' }, { linkId: 1, kind: 'patient', codes: ['HGB'] }));
  check('A blank criterion matches everything',
    middleware.routeMatches({}, { linkId: 9, kind: 'control', codes: [] }));
}

/* ------------------------------------------------------------- redaction */
section('Sanitising a protocol sample');
{
  const withPatient = 'H|\\^&|||XN-550^1\rP|1|12345|67890|SMITH^JOHN||19800101|M\rO|1|SC-0001||^^^ALL|R\rR|1|^^^HGB|12.4|g/dL\rL|1|N';
  const clean = middleware.sanitiseProtocolSample(withPatient);
  check('A patient record is redacted', !clean.includes('SMITH'), clean);
  check('The record structure survives sanitising', clean.includes('R|1|^^^HGB|12.4'), clean);
  check('The sanitised sample is no longer identifiable', !middleware.looksIdentifiable(clean), clean);

  const hl7Pid = 'MSH|^~\\&|BC|LAB|S|S|1||ORU^R01|1|P|2.3.1\rPID|1||555|ADAMS^MARY||19751103|F\rOBX|1|NM|GLU||5.1';
  const cleanHl7 = middleware.sanitiseProtocolSample(hl7Pid);
  check('An HL7 PID segment is redacted', !cleanHl7.includes('ADAMS'), cleanHl7);
  check('The OBX result survives', cleanHl7.includes('OBX|1|NM|GLU||5.1'), cleanHl7);
}

/* ------------------------------------------------------------- the secrets */
section('Credential storage');
{
  const sealed = secrets.sealSecret('S3cret-pass');
  check('A credential does not survive in the clear', !String(sealed).includes('S3cret-pass'), String(sealed));
  check('A credential can be read back for a transport', secrets.openSecret(sealed) === 'S3cret-pass');
  check('A tampered credential refuses to open rather than returning rubbish',
    secrets.openSecret(`${String(sealed).slice(0, -4)}AAAA`) === null);
  check('An empty credential stores as nothing', secrets.sealSecret('') === null);
  check('A password in a URL is scrubbed before it can reach a log',
    !secrets.scrubSecrets('http://h/api.php?username=u&password=hunter2').includes('hunter2'),
    secrets.scrubSecrets('http://h/api.php?username=u&password=hunter2'));
  check('A bearer token is scrubbed',
    secrets.scrubSecrets('Authorization: Bearer abc.def.ghi').includes('[redacted]'));
}

/* ====================================================================== */
section('The laboratory, as it actually is');

// One link LHIMS owns — the Sysmex XN-550 — and one of ours.
db.prepare(`INSERT INTO instrument_links
    (link_code, name, profile_key, role, mode, protocol, listen_host, listen_port, auto_start, is_active, state)
    VALUES ('LNK-XN550', 'Haematology 1 — Sysmex XN-550', 'sysmex_xn', 'lhims_owned', 'server', 'astm', '0.0.0.0', 5150, 1, 1, 'blocked')`).run();
db.prepare(`INSERT INTO instrument_links
    (link_code, name, profile_key, role, mode, protocol, listen_host, listen_port, auto_start, is_active, state)
    VALUES ('LNK-XN330', 'Haematology 2 — Sysmex XN-330', 'sysmex_xn', 'sechlims_only', 'server', 'astm', '0.0.0.0', 9201, 1, 1, 'listening')`).run();
const protectedLink = db.prepare("SELECT id FROM instrument_links WHERE link_code = 'LNK-XN550'").get().id;
const ourLink = db.prepare("SELECT id FROM instrument_links WHERE link_code = 'LNK-XN330'").get().id;

/* ------------------------------------------- the non-negotiable, first */
section('Production safety: the Sysmex XN-550 to LHIMS path');
{
  const endpoints = safety.protectedEndpoints(db);
  check('The XN-550 port is recognised as protected',
    endpoints.some(e => Number(e.port) === 5150), JSON.stringify(endpoints));

  const refused = safety.endpointIsSafe(db, { host: '0.0.0.0', port: 5150 }, 'A new destination');
  check('A destination on the protected port is refused', !refused.ok, String(refused.reason));

  const wildcard = safety.endpointIsSafe(db, { host: null, port: 5150 }, 'A listener on every interface');
  check('A wildcard bind on the protected port is refused too', !wildcard.ok, String(wildcard.reason));

  const elsewhere = safety.endpointIsSafe(db, { host: '127.0.0.1', port: 9400 }, 'A test destination');
  check('An unrelated port is allowed', elsewhere.ok, String(elsewhere.reason));

  const captured = safety.captureBaseline(db, { linkId: protectedLink, userId: null });
  check('A baseline of the existing transmission is captured', captured.ok, captured.note);
  check('Capturing a baseline changes nothing about the link',
    db.prepare('SELECT state, listen_port, protocol, role FROM instrument_links WHERE id = ?').get(protectedLink).state === 'blocked'
    && db.prepare('SELECT listen_port FROM instrument_links WHERE id = ?').get(protectedLink).listen_port === 5150);

  const verified = safety.verifyBaseline(db, captured.baselineId);
  check('The baseline verifies as unchanged', verified.verdict === 'unchanged', JSON.stringify(verified.drift));

  // The proposal validator must refuse the production port even when a person
  // asks for it directly.
  const proposal = dennis.validateProposal(db, {
    kind: 'destination', name: 'Something', transport: 'hl7_mllp', payload_format: 'hl7v2',
    host: '10.0.0.1', port: 5150, ack_policy: 'protocol_ack',
  });
  check('Dennis cannot propose a configuration on the protected port',
    !proposal.ok && proposal.errors.join(' ').includes('5150'), JSON.stringify(proposal));
}

/* ==================================================== destinations, for real */
section('Destinations that behave like real receiving systems');

const good = mllpServer('accept');
const rejecting = mllpServer('reject');
const erroring = mllpServer('error');
const silent = mllpServer('silent');
const goodPort = await listen(good.server);
const rejectPort = await listen(rejecting.server);
const errorPort = await listen(erroring.server);
const silentPort = await listen(silent.server);

function addDestination(code, name, port, options = {}) {
  db.prepare(`INSERT INTO mw_destinations
      (dest_code, name, platform, transport, payload_format, host, port, ack_policy, ack_timeout_ms,
       retry_max, retry_base_ms, state, is_active, auto_deliver)
      VALUES (?, ?, 'his', 'hl7_mllp', 'hl7v2', '127.0.0.1', ?, 'protocol_ack', ?, ?, 1000, 'active', 1, ?)`)
    .run(code, name, port, options.ackTimeoutMs ?? 4_000, options.retryMax ?? 3, options.autoDeliver === false ? 0 : 1);
  return db.prepare('SELECT * FROM mw_destinations WHERE dest_code = ?').get(code);
}

const hisGood = addDestination('DEST-HIS', 'Hospital information system', goodPort);
const hisReject = addDestination('DEST-REJ', 'Research extract (rejects)', rejectPort);
const hisError = addDestination('DEST-ERR', 'Regional registry (application error)', errorPort, { retryMax: 2 });
const hisSilent = addDestination('DEST-SIL', 'Legacy system (never answers)', silentPort, { retryMax: 2, ackTimeoutMs: 2_000 });

// A destination declared protected, so the engine's refusal can be observed.
db.prepare(`INSERT INTO mw_destinations
    (dest_code, name, platform, transport, payload_format, host, port, ack_policy, state, is_active, is_protected)
    VALUES ('DEST-LHIMS', 'LHIMS middleware (production)', 'lhims', 'hl7_mllp', 'hl7v2', '10.0.0.9', 5150, 'protocol_ack', 'active', 1, 1)`).run();
const lhimsDestination = db.prepare("SELECT * FROM mw_destinations WHERE dest_code = 'DEST-LHIMS'").get();

{
  const verdict = safety.routeIsSafe(db, ourLink, lhimsDestination.id);
  check('A route to a protected destination is refused', !verdict.ok, String(verdict.reason));
  const editable = safety.destinationIsEditable(lhimsDestination);
  check('A protected destination cannot be edited', !editable.ok, String(editable.reason));
  const fromProtected = safety.routeIsSafe(db, protectedLink, hisGood.id);
  check('A route from a protected link that the bridge never opens is refused as futile',
    !fromProtected.ok, String(fromProtected.reason));
}

/* ------------------------------------------------------------ the mappings */
section('Field mapping and transformation');
{
  // The research extract uses its own codes and stores haemoglobin in g/L.
  db.prepare(`INSERT INTO mw_mappings (destination_id, source_code, target_code, target_name, target_unit, factor, decimals)
      VALUES (?, 'HGB', 'HB_GL', 'Haemoglobin', 'g/L', 10, 0)`).run(hisReject.id);
  db.prepare(`INSERT INTO mw_mappings (destination_id, source_code, target_code, target_name)
      VALUES (?, 'WBC', 'WBC_COUNT', 'White cell count')`).run(hisReject.id);

  const mapped = engine.applyMapping(db, hisReject.id, {
    sampleId: 'SC-9', lotNumber: null, instrument: null, runAt: null, kind: 'patient',
    results: [
      { code: 'HGB', analyte: 'Haemoglobin', value: '12.4', unit: 'g/dL', flag: 'N' },
      { code: 'WBC', analyte: 'WBC', value: '6.2', unit: '10*9/L', flag: 'N' },
      { code: 'PLT', analyte: 'Platelets', value: '250', unit: '10*9/L', flag: 'N' },
    ],
  });
  check('A mapped code carries the destination\'s own code',
    mapped.results.find(r => r.code === 'HGB')?.targetCode === 'HB_GL', JSON.stringify(mapped.results));
  check('A unit conversion is applied',
    mapped.results.find(r => r.code === 'HGB')?.value === '124',
    mapped.results.find(r => r.code === 'HGB')?.value);
  check('A code with no mapping is withheld, not guessed at',
    !mapped.results.some(r => r.code === 'PLT') && mapped.unmapped.includes('PLT'),
    JSON.stringify(mapped.unmapped));

  const passthrough = engine.applyMapping(db, hisGood.id, {
    sampleId: 'SC-9', lotNumber: null, instrument: null, runAt: null, kind: 'patient',
    results: [{ code: 'PLT', analyte: 'Platelets', value: '250', unit: '10*9/L', flag: 'N' }],
  });
  check('A destination with no mapping table passes every code through',
    passthrough.results.length === 1 && passthrough.unmapped.length === 0,
    JSON.stringify(passthrough));
}

/* ------------------------------------------------------------- the routing */
section('Routing to several independent destinations');

function addRoute(code, name, destinationId, options = {}) {
  db.prepare(`INSERT INTO mw_routes (route_code, name, destination_id, priority, source_link_id, message_kind, test_codes, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)`)
    .run(code, name, destinationId, options.priority ?? 100, options.sourceLinkId ?? null,
      options.messageKind ?? 'patient', options.testCodes ? JSON.stringify(options.testCodes) : null);
}
addRoute('ROUTE-HIS', 'Patient results to the hospital system', hisGood.id);
addRoute('ROUTE-REJ', 'Patient results to the research extract', hisReject.id);
addRoute('ROUTE-ERR', 'Patient results to the regional registry', hisError.id);
addRoute('ROUTE-SIL', 'Patient results to the legacy system', hisSilent.id);
addRoute('ROUTE-LHIMS', 'Refused: protected destination', lhimsDestination.id);
addRoute('ROUTE-CTRL', 'Control runs only, nowhere', hisGood.id, { messageKind: 'control', testCodes: ['NOTHING'] });

const envelope = {
  linkId: ourLink,
  instrumentMessageId: null,
  protocol: 'astm',
  kind: 'patient',
  sampleId: 'SC-0001',
  lotNumber: null,
  instrument: 'XN-330',
  runAt: '2026-04-20 10:15:00',
  results: [
    { analyte: 'Haemoglobin', code: 'HGB', value: '12.4', unit: 'g/dL', flag: 'N' },
    { analyte: 'WBC', code: 'WBC', value: '6.2', unit: '10*9/L', flag: 'N' },
  ],
  raw: astmTransmission('SC-0001', [{ code: 'HGB', value: '12.4', unit: 'g/dL' }]),
  source: 'bridge',
};

const ingested = engine.ingest(envelope);
check('The message is ingested', ingested.ok && ingested.messageId, JSON.stringify(ingested));
check('Four deliveries are queued, one per usable destination', ingested.deliveries === 4,
  `${ingested.deliveries} queued of ${ingested.routesMatched} rule(s) matched`);
check('The protected destination is not queued',
  db.prepare('SELECT COUNT(*) AS n FROM mw_deliveries WHERE destination_id = ?').get(lhimsDestination.id).n === 0);
check('The refusal is on the record rather than silent',
  db.prepare("SELECT COUNT(*) AS n FROM mw_trace WHERE message_id = ? AND stage = 'route' AND outcome = 'warn'").get(ingested.messageId).n > 0);

/* ------------------------------------------------------- duplicate detection */
section('Duplicate detection and idempotency');
{
  const again = engine.ingest(envelope);
  check('The same transmission ingested twice is one message',
    again.duplicate && again.messageId === ingested.messageId, JSON.stringify(again));
  check('No second set of deliveries is created', again.deliveries === 0);

  const total = db.prepare('SELECT COUNT(*) AS n FROM mw_deliveries WHERE message_id = ?').get(ingested.messageId).n;
  // Re-routing an existing message must not duplicate a delivery either: the
  // idempotency key is the message and the destination.
  const rerouted = engine.reroute(ingested.messageId, null);
  const after = db.prepare('SELECT COUNT(*) AS n FROM mw_deliveries WHERE message_id = ?').get(ingested.messageId).n;
  check('Re-routing a message does not create a second delivery for a destination it already has',
    after === total && rerouted.queued === 0, `${total} then ${after}`);

  // A genuine second run — different values — is a different message.
  const second = engine.ingest({
    ...envelope,
    sampleId: 'SC-0002',
    results: [{ analyte: 'Haemoglobin', code: 'HGB', value: '13.9', unit: 'g/dL', flag: 'N' }],
  });
  check('A different transmission is a different message', !second.duplicate && second.messageId !== ingested.messageId);
}

/* -------------------------------------------------------------- delivery */
section('Delivery, acknowledgement and the four answers');
{
  // Several sweeps, because the silent destination has to time out and the
  // erroring one has to exhaust its attempts.
  for (let i = 0; i < 4; i++) {
    await engine.tick();
    await wait(1_300);
  }

  const rows = db.prepare(`SELECT d.dest_code, v.state, v.attempt, v.ack_code, v.error, v.dead_letter_reason, v.results_sent
      FROM mw_deliveries v JOIN mw_destinations d ON d.id = v.destination_id
      WHERE v.message_id = ? ORDER BY d.dest_code`).all(ingested.messageId);
  const by = code => rows.find(r => r.dest_code === code) ?? {};

  check('The accepting destination accepted the message',
    by('DEST-HIS').state === 'delivered' && by('DEST-HIS').ack_code === 'AA', JSON.stringify(by('DEST-HIS')));
  check('The accepting destination actually received an HL7 message',
    good.received.length > 0 && good.received[0].includes('ORU^R01'), String(good.received[0]).slice(0, 80));
  check('The message it received carries the mapped results',
    good.received[0].includes('HGB') && good.received[0].includes('12.4'), String(good.received[0]).slice(0, 200));

  check('An outright rejection goes straight to the dead-letter queue, not round the retry loop',
    by('DEST-REJ').state === 'dead_letter' && by('DEST-REJ').attempt === 1, JSON.stringify(by('DEST-REJ')));
  check('The rejection reason is kept',
    String(by('DEST-REJ').error ?? '').includes('Unknown test code'), String(by('DEST-REJ').error));
  check('The rejecting destination received the message with ITS own codes and units',
    rejecting.received.length > 0 && rejecting.received[0].includes('HB_GL') && rejecting.received[0].includes('124'),
    String(rejecting.received[0]).slice(0, 220));

  check('An application error is retried and then abandoned at the cap',
    by('DEST-ERR').state === 'dead_letter' && by('DEST-ERR').attempt >= 2, JSON.stringify(by('DEST-ERR')));
  check('Abandoning says how many attempts were made',
    String(by('DEST-ERR').dead_letter_reason ?? '').includes('attempt'), String(by('DEST-ERR').dead_letter_reason));

  check('A destination that never answers times out rather than hanging the queue',
    ['retrying', 'dead_letter'].includes(by('DEST-SIL').state), JSON.stringify(by('DEST-SIL')));
  check('The timeout says what was and was not established',
    String(by('DEST-SIL').error ?? '').includes('acknowledgement'), String(by('DEST-SIL').error));

  const message = db.prepare('SELECT status FROM mw_messages WHERE id = ?').get(ingested.messageId);
  check('One destination succeeding and another failing reads as PARTLY delivered',
    message.status === 'partial', message.status);
  check('A destination failing did not mark another\'s delivery successful',
    by('DEST-REJ').state !== 'delivered' && by('DEST-HIS').state === 'delivered');
  check('The source transmission is preserved untouched',
    db.prepare('SELECT COUNT(*) AS n FROM mw_messages WHERE id = ? AND normalised IS NOT NULL').get(ingested.messageId).n === 1);
}

/* ------------------------------------------------------------- traceability */
section('End-to-end traceability');
{
  const trace = engine.traceOf(ingested.messageId);
  const stages = new Set(trace.trace.map(step => step.stage));
  for (const stage of ['ingest', 'normalise', 'validate', 'route', 'queue', 'transmit', 'outcome']) {
    check(`The trace records the ${stage} stage`, stages.has(stage), [...stages].join(', '));
  }
  check('The acknowledgement is recorded as its own stage', stages.has('acknowledge'), [...stages].join(', '));
  check('Every delivery is on the trace', trace.deliveries.length === 4, String(trace.deliveries.length));
  check('A delivery says whether its destination can confirm acceptance',
    trace.deliveries.every(d => typeof d.confirmable === 'boolean'));
}

/* ------------------------------------------------------- replay and recovery */
section('Replay, cancellation and restart recovery');
{
  const dead = db.prepare(`SELECT v.id, v.idempotency_key FROM mw_deliveries v
      JOIN mw_destinations d ON d.id = v.destination_id
      WHERE v.message_id = ? AND d.dest_code = 'DEST-ERR'`).get(ingested.messageId);

  const replayed = engine.replay(dead.id, null, 'The registry is back.');
  check('A dead-lettered delivery can be replayed', replayed.ok, replayed.note);
  const after = db.prepare('SELECT state, attempt, idempotency_key, replay_count FROM mw_deliveries WHERE id = ?').get(dead.id);
  check('A replay resets the attempts rather than creating a second delivery',
    after.state === 'queued' && after.attempt === 0 && after.replay_count === 1, JSON.stringify(after));
  check('A replay keeps the original idempotency key, so the destination can recognise the repeat',
    after.idempotency_key === dead.idempotency_key);

  const deliveredRow = db.prepare(`SELECT v.id FROM mw_deliveries v JOIN mw_destinations d ON d.id = v.destination_id
      WHERE v.message_id = ? AND d.dest_code = 'DEST-HIS'`).get(ingested.messageId);
  const refusedReplay = engine.replay(deliveredRow.id, null, null);
  check('An accepted delivery cannot be replayed', !refusedReplay.ok, refusedReplay.note);

  const cancelled = engine.cancel(dead.id, null, 'The registry no longer wants haematology.');
  check('A delivery can be cancelled with a reason', cancelled.ok, cancelled.note);
  check('A cancellation is on the record',
    db.prepare("SELECT COUNT(*) AS n FROM mw_trace WHERE delivery_id = ? AND detail LIKE '%Cancelled%'").get(dead.id).n > 0);

  // A host that stopped mid-delivery. The row is left in flight with an old
  // timestamp, exactly as a killed process leaves it.
  const silentRow = db.prepare(`SELECT v.id FROM mw_deliveries v JOIN mw_destinations d ON d.id = v.destination_id
      WHERE v.message_id = ? AND d.dest_code = 'DEST-SIL'`).get(ingested.messageId);
  db.prepare("UPDATE mw_deliveries SET state = 'in_flight', last_attempt_at = datetime('now', '-20 minutes') WHERE id = ?").run(silentRow.id);
  const recovered = engine.recover();
  check('A delivery left in flight by a stopped host is reclaimed', recovered.reclaimed >= 1, JSON.stringify(recovered));
  check('A reclaimed delivery is queued again rather than lost',
    db.prepare('SELECT state FROM mw_deliveries WHERE id = ?').get(silentRow.id).state === 'retrying');
}

/* --------------------------------------------------- a destination standing down */
section('A destination that is not active receives nothing');
{
  db.prepare("UPDATE mw_destinations SET state = 'awaiting_approval' WHERE id = ?").run(hisGood.id);
  const outcome = engine.ingest({
    ...envelope, sampleId: 'SC-0003',
    results: [{ analyte: 'Haemoglobin', code: 'HGB', value: '11.2', unit: 'g/dL', flag: 'N' }],
  });
  const queued = db.prepare(`SELECT COUNT(*) AS n FROM mw_deliveries WHERE message_id = ? AND destination_id = ?`)
    .get(outcome.messageId, hisGood.id).n;
  check('A destination awaiting approval is not queued for', queued === 0, `${queued} queued`);
  check('The reason is on the trace',
    db.prepare("SELECT COUNT(*) AS n FROM mw_trace WHERE message_id = ? AND stage = 'route' AND detail LIKE '%awaiting_approval%'")
      .get(outcome.messageId).n > 0);
  db.prepare("UPDATE mw_destinations SET state = 'active' WHERE id = ?").run(hisGood.id);
}

/* ------------------------------------------------------------- an invalid message */
section('A message that cannot be delivered anywhere');
{
  const outcome = engine.ingest({
    ...envelope, sampleId: '', results: [], raw: 'nothing readable',
  });
  check('A message with no identifier and no result is held, not routed',
    outcome.status === 'invalid' && outcome.deliveries === 0, JSON.stringify(outcome));
  check('It is still recorded in full, so it can be looked at',
    outcome.messageId && db.prepare('SELECT COUNT(*) AS n FROM mw_messages WHERE id = ?').get(outcome.messageId).n === 1);
}

/* ------------------------------------------------- versioning and rollback */
section('Configuration versioning and rollback');
{
  const before = db.prepare('SELECT * FROM mw_destinations WHERE id = ?').get(hisGood.id);
  versions.recordVersion(db, {
    scope: 'destination', entityId: hisGood.id, entityCode: before.dest_code, entityName: before.name,
    action: 'create', before: null, after: before, reason: 'Configured.', userId: null,
  });

  db.prepare("UPDATE mw_destinations SET ack_policy = 'none', retry_max = 1, state = 'active' WHERE id = ?").run(hisGood.id);
  const changed = db.prepare('SELECT * FROM mw_destinations WHERE id = ?').get(hisGood.id);
  const updateVersion = versions.recordVersion(db, {
    scope: 'destination', entityId: hisGood.id, entityCode: before.dest_code, entityName: before.name,
    action: 'update', before, after: changed, reason: 'Somebody turned the acknowledgement off.', userId: null,
  });
  check('A change is recorded with a version', Boolean(updateVersion), String(updateVersion));

  const history = versions.versionHistory(db, { scope: 'destination', entityId: hisGood.id });
  check('The history names the fields that changed',
    history[0].changes.some(c => c.field === 'ack_policy'), JSON.stringify(history[0].changes));
  check('A credential never enters a version',
    !JSON.stringify(history).includes('secret_cipher'));

  const firstVersion = history.find(v => v.action === 'create');
  const rolled = versions.rollbackTo(db, firstVersion.id, null, 'Put the acknowledgement back.');
  check('A configuration can be rolled back to a recorded version', rolled.ok, rolled.note);
  const restored = db.prepare('SELECT ack_policy, retry_max, state, approved_by FROM mw_destinations WHERE id = ?').get(hisGood.id);
  check('The settings are restored', restored.ack_policy === 'protocol_ack' && restored.retry_max === 3, JSON.stringify(restored));
  check('An active destination stands down after a rollback, so nothing runs on settings nobody signed for',
    restored.state === 'awaiting_approval' && restored.approved_by === null, JSON.stringify(restored));
  check('The rollback is itself a version',
    versions.versionHistory(db, { scope: 'destination', entityId: hisGood.id })[0].action === 'rollback');

  const refused = versions.rollbackTo(db, versions.recordVersion(db, {
    scope: 'destination', entityId: lhimsDestination.id, entityCode: 'DEST-LHIMS', entityName: 'LHIMS',
    action: 'update', before: lhimsDestination, after: lhimsDestination, reason: null, userId: null,
  }), null, 'Try the protected one.');
  check('A protected destination cannot be rolled back', !refused.ok, refused.note);
}

/* ------------------------------------------------------- the engine overview */
section('The engine, summarised');
{
  const overview = engine.overview();
  check('The overview counts the destinations', overview.destinations >= 4, JSON.stringify(overview.destinations));
  check('The overview counts the dead letters', overview.deadLetters >= 1, String(overview.deadLetters));
  check('The overview names the protected connection', overview.protectedConnections >= 1, String(overview.protectedConnections));
  check('The queue tone reflects the dead letters', overview.tone !== 'ok', overview.tone);
}

/* ------------------------------------------- the XN-550, at the very end */
section('The Sysmex XN-550 to LHIMS path, after everything above');
{
  const link = db.prepare('SELECT * FROM instrument_links WHERE id = ?').get(protectedLink);
  check('Its role is unchanged', link.role === 'lhims_owned', link.role);
  check('Its port is unchanged', link.listen_port === 5150, String(link.listen_port));
  check('Its protocol is unchanged', link.protocol === 'astm', link.protocol);
  check('Its mode is unchanged', link.mode === 'server', link.mode);
  check('Its state is still blocked — the engine never opened it', link.state === 'blocked', link.state);
  check('Nothing was delivered over the protected destination',
    db.prepare('SELECT COUNT(*) AS n FROM mw_deliveries WHERE destination_id = ?').get(lhimsDestination.id).n === 0);
  const baseline = db.prepare("SELECT * FROM mw_baselines WHERE link_id = ?").get(protectedLink);
  const verdict = safety.verifyBaseline(db, baseline.id);
  check('The baseline still verifies as unchanged', verdict.verdict === 'unchanged', JSON.stringify(verdict.drift));
  check('No listener was opened on the protected port by this process',
    await portIsFreeHere(5150), 'something in this process bound 5150');
}

function portIsFreeHere(port) {
  return new Promise(resolve => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => { probe.close(); resolve(true); });
    probe.listen(port, '127.0.0.1');
  });
}

/* ------------------------------------------------------------------- done */
for (const entry of [good, rejecting, erroring, silent]) entry.server.close();
engine.stop();

console.log(`\n${pass} passed, ${fail} failed`);
try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* a temporary directory */ }
process.exit(fail ? 1 : 0);
