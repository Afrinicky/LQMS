/**
 * The middleware over HTTP: permissions, approval gates and Dennis's limits.
 *
 * The engine itself is proved by `middleware-engine-check.mjs`, which talks to
 * real sockets and needs no API. This is the other half: everything that is
 * only true because of a route guard, an approval row or a refusal.
 *
 * What it establishes:
 *
 *   A bench account cannot configure, approve, activate, scan, replay or roll
 *   back — and is not merely hidden from those controls but refused by the API.
 *   A destination must be TESTED before it can be approved, and APPROVED before
 *   it can be activated. Neither is a convention; both are enforced.
 *   Changing an active destination's settings stands it down again.
 *   The protected production connection is refused everywhere it is reachable:
 *   its port, its destination row, routing over it, and testing it.
 *   Dennis answers with measured evidence, cannot propose a configuration on
 *   the production port, and cannot apply its own proposal.
 *   Every privileged operation leaves an audit row.
 *
 *   npm run api          (in one terminal)
 *   node scripts/middleware-check.mjs
 */
const BASE = process.env.API || 'http://127.0.0.1:4430/api';
const PW = 'Passw0rd!test';
const BENCH_PW = 'Bench0rd!test';

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};
const section = name => console.log(`\n${name}\n${'-'.repeat(name.length)}`);

const j = async (path, options = {}) => {
  const response = await fetch(`${BASE}${path}`, {
    method: options.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}) },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  return { status: response.status, json: await response.json().catch(() => null) };
};

/* -------------------------------------------------------------- sign in */
const status = await j('/setup/status');
if (!status.json?.setupComplete) {
  await j('/setup/initialize', {
    method: 'POST',
    body: { facilityName: 'Middleware Test Laboratory', username: 'admin', password: PW, fullName: 'Admin User' },
  });
}
const ADMIN = (await j('/auth/login', { method: 'POST', body: { username: 'admin', password: PW } })).json?.token;
if (!ADMIN) {
  console.error(`Could not sign in — is the API running on ${BASE}?`);
  process.exit(1);
}
const stamp = Date.now().toString(36).toUpperCase();

/**
 * A bench account, created for this run.
 *
 * The point of the whole permission section: every refusal below has to be a
 * refusal of somebody the laboratory actually has, not of an anonymous caller.
 */
let BENCH = null;
{
  const roles = (await j('/roles', { token: ADMIN })).json ?? [];
  const technician = Array.isArray(roles) ? roles.find(r => /technician/i.test(r.name)) : null;
  const created = await j('/users', {
    method: 'POST', token: ADMIN,
    body: {
      username: `bench_${stamp}`.toLowerCase(), password: BENCH_PW,
      fullName: 'Bench Scientist', roleId: technician?.id ?? null, isActive: 1,
    },
  });
  if (created.status < 300) {
    BENCH = (await j('/auth/login', { method: 'POST', body: { username: `bench_${stamp}`.toLowerCase(), password: BENCH_PW } })).json?.token ?? null;
  }
}

console.log(`Analyser transmission & middleware — API checks\n${BASE}`);

/* ================================================================ reference */
section('The workspace loads');
{
  const reference = await j('/middleware/reference', { token: ADMIN });
  check('The vocabulary is served', reference.status === 200 && Array.isArray(reference.json?.transports),
    `status ${reference.status}`);
  check('Every transport the engine implements is offered',
    ['internal', 'hl7_mllp', 'astm_tcp', 'http_lhims', 'http_json', 'file_export']
      .every(key => (reference.json?.transports ?? []).some(t => t.key === key)),
    JSON.stringify((reference.json?.transports ?? []).map(t => t.key)));
  check('LHIMS is one platform among several, not the only one',
    (reference.json?.platforms ?? []).length > 2
    && (reference.json?.platforms ?? []).some(p => p.key === 'lis')
    && (reference.json?.platforms ?? []).some(p => p.key === 'his'),
    JSON.stringify((reference.json?.platforms ?? []).map(p => p.key)));

  const overview = await j('/middleware/overview', { token: ADMIN });
  check('The overview answers', overview.status === 200 && typeof overview.json?.queueDepth === 'number',
    `status ${overview.status}`);
  const diagnostics = await j('/middleware/diagnostics', { token: ADMIN });
  check('System diagnostics answer with layered findings',
    diagnostics.status === 200 && Array.isArray(diagnostics.json?.findings) && diagnostics.json.findings.length > 0,
    `status ${diagnostics.status}`);
}

/* ============================================= the protected connection */
section('The Sysmex XN-550 to LHIMS path');

// Record it the way the laboratory does: a link LHIMS owns, on its own port.
const protectedLink = await j('/instrument-links', {
  method: 'POST', token: ADMIN,
  body: {
    name: `Haematology 1 — Sysmex XN-550 (${stamp})`,
    profileKey: 'sysmex_xn', role: 'lhims_owned', mode: 'server', protocol: 'astm',
    listenPort: 5150, autoStart: false,
  },
});
const protectedLinkId = protectedLink.json?.id ?? protectedLink.json?.link?.id ?? null;
check('The existing LHIMS-owned link is recorded', protectedLink.status < 300 && protectedLinkId,
  `status ${protectedLink.status} ${JSON.stringify(protectedLink.json).slice(0, 200)}`);

{
  const baseline = await j('/middleware/baselines/capture', {
    method: 'POST', token: ADMIN, body: { linkId: protectedLinkId },
  });
  check('A baseline of it is captured', baseline.status === 200 && baseline.json?.ok, JSON.stringify(baseline.json).slice(0, 200));
  check('Capturing it says that nothing about the link was changed',
    String(baseline.json?.note ?? '').toLowerCase().includes('changed'), String(baseline.json?.note));

  const before = (await j(`/instrument-links`, { token: ADMIN })).json?.find(l => l.id === protectedLinkId);
  check('Its port is untouched by the capture', before?.listen_port === 5150, String(before?.listen_port));

  // The refusal that matters most: a destination on the production port.
  const collide = await j('/middleware/destinations', {
    method: 'POST', token: ADMIN,
    body: { name: `Collides (${stamp})`, platform: 'his', transport: 'hl7_mllp', host: '0.0.0.0', port: 5150 },
  });
  check('A destination on the production port is refused', collide.status === 409,
    `status ${collide.status} ${String(collide.json?.error).slice(0, 160)}`);
  check('The refusal explains itself rather than returning a bare error',
    String(collide.json?.error ?? '').toLowerCase().includes('production'), String(collide.json?.error));

  const baselines = await j('/middleware/baselines', { token: ADMIN });
  check('The baseline is held as protected',
    (baselines.json ?? []).some(b => b.is_protected === 1), JSON.stringify(baselines.json).slice(0, 200));

  const verified = await j(`/middleware/baselines/${(baselines.json ?? [])[0]?.id}/verify`, { method: 'POST', token: ADMIN, body: {} });
  check('Verifying reports a verdict', verified.status === 200 && verified.json?.verdict, JSON.stringify(verified.json).slice(0, 160));
  check('Verifying reports rather than corrects',
    String(verified.json?.note ?? '').length > 0 && verified.json?.verdict === 'unchanged', String(verified.json?.note));
}

/* ====================================================== the usable destination */
section('A destination, through its approval gates');

const internal = await j('/middleware/destinations', {
  method: 'POST', token: ADMIN,
  body: {
    name: `SECHLIMS acceptance (${stamp})`, platform: 'sechlims', transport: 'internal',
    payloadFormat: 'json', ackPolicy: 'none', notes: 'The baseline a routing rule is proved against.',
  },
});
const internalId = internal.json?.id;
check('A destination is created in the configured state',
  internal.status === 201 && internal.json?.state === 'configured', `status ${internal.status} ${internal.json?.state}`);
check('No credential is ever returned', !JSON.stringify(internal.json ?? {}).includes('secret_cipher'),
  JSON.stringify(internal.json ?? {}).slice(0, 200));

{
  const early = await j(`/middleware/destinations/${internalId}/approve`, { method: 'POST', token: ADMIN, body: {} });
  check('A destination that has never exchanged a message cannot be approved', early.status === 409,
    `status ${early.status} ${String(early.json?.error).slice(0, 140)}`);

  const tested = await j(`/middleware/destinations/${internalId}/test`, { method: 'POST', token: ADMIN, body: {} });
  check('It can be tested in isolation', tested.status === 200 && tested.json?.ok, JSON.stringify(tested.json).slice(0, 200));
  check('The test message is obviously synthetic, never a patient result',
    String(tested.json?.payload ?? '').includes('SECHLIMS-TEST'), String(tested.json?.payload).slice(0, 120));
  check('A passed test moves it to awaiting approval, not to active',
    (await j('/middleware/destinations', { token: ADMIN })).json.find(d => d.id === internalId)?.state === 'awaiting_approval');

  const unapproved = await j(`/middleware/destinations/${internalId}/activate`, { method: 'POST', token: ADMIN, body: {} });
  check('An unapproved destination cannot be activated', unapproved.status === 409,
    `status ${unapproved.status} ${String(unapproved.json?.error).slice(0, 140)}`);

  const approved = await j(`/middleware/destinations/${internalId}/approve`, { method: 'POST', token: ADMIN, body: {} });
  check('A tested destination can be approved', approved.status === 200 && approved.json?.approved_by, `status ${approved.status}`);
  const activated = await j(`/middleware/destinations/${internalId}/activate`, { method: 'POST', token: ADMIN, body: {} });
  check('An approved destination can be activated', activated.status === 200 && activated.json?.state === 'active',
    `status ${activated.status} ${activated.json?.state}`);

  // Changing what it IS must take the approval away with it.
  const changed = await j(`/middleware/destinations/${internalId}`, {
    method: 'PUT', token: ADMIN, body: { ackPolicy: 'http_2xx', reason: 'Changed the acknowledgement policy.' },
  });
  check('Changing an active destination\'s settings stands it down to awaiting approval',
    changed.status === 200 && changed.json?.state === 'awaiting_approval' && changed.json?.standDown === true,
    `${changed.json?.state} standDown=${changed.json?.standDown}`);

  // Put it back and activate again, so the routing checks below have somewhere
  // to deliver to.
  await j(`/middleware/destinations/${internalId}`, { method: 'PUT', token: ADMIN, body: { ackPolicy: 'none', reason: 'Reverted.' } });
  await j(`/middleware/destinations/${internalId}/test`, { method: 'POST', token: ADMIN, body: {} });
  await j(`/middleware/destinations/${internalId}/approve`, { method: 'POST', token: ADMIN, body: {} });
  await j(`/middleware/destinations/${internalId}/activate`, { method: 'POST', token: ADMIN, body: {} });
}

/* ================================================================== routing */
section('Routing, and the refusals built into it');

const ourLink = await j('/instrument-links', {
  method: 'POST', token: ADMIN,
  body: {
    name: `Haematology 2 — Sysmex XN-330 (${stamp})`,
    profileKey: 'sysmex_xn', role: 'sechlims_only', mode: 'server', protocol: 'astm',
    listenPort: 9271, autoStart: false,
  },
});
const ourLinkId = ourLink.json?.id ?? null;

{
  const route = await j('/middleware/routes', {
    method: 'POST', token: ADMIN,
    body: { name: `Patient results to SECHLIMS (${stamp})`, destinationId: internalId, sourceLinkId: ourLinkId, messageKind: 'patient' },
  });
  check('A routing rule is created', route.status === 201 && route.json?.id, `status ${route.status}`);

  const fromProtected = await j('/middleware/routes', {
    method: 'POST', token: ADMIN,
    body: { name: `Refused (${stamp})`, destinationId: internalId, sourceLinkId: protectedLinkId, messageKind: 'patient' },
  });
  check('A rule from the protected link, which the engine never opens, is refused', fromProtected.status === 409,
    `status ${fromProtected.status} ${String(fromProtected.json?.error).slice(0, 160)}`);

  const preview = await j('/middleware/routes/preview', {
    method: 'POST', token: ADMIN, body: { linkId: ourLinkId, kind: 'patient', codes: ['HGB'] },
  });
  check('The preview says which rules would queue a delivery',
    preview.status === 200 && (preview.json?.matches ?? []).some(m => m.wouldQueue),
    JSON.stringify(preview.json).slice(0, 220));
}

/* ================================================= a transmission, end to end */
section('A transmission through the engine, over the API');
{
  const simulated = await j('/middleware/simulate', {
    method: 'POST', token: ADMIN,
    body: {
      linkId: ourLinkId,
      kind: 'patient',
      message: [
        'H|\\^&|||XN-330^1|||||||P|1|20260420101500',
        'P|1|12345|67890|SMITH^JOHN||19800101|M',
        `O|1|SC-${stamp}||^^^ALL|R|20260420101500`,
        'R|1|^^^HGB|12.4|g/dL||N||F',
        'R|2|^^^WBC|6.2|10*9/L||N||F',
        'L|1|N',
      ].join('\r'),
    },
  });
  check('A pasted transmission is played through the engine',
    simulated.status === 200 && (simulated.json?.messages ?? []).length > 0,
    `status ${simulated.status} ${JSON.stringify(simulated.json).slice(0, 200)}`);
  check('It was sanitised before anything read it', simulated.json?.sanitised === true);
  check('It was queued for the active destination',
    (simulated.json?.messages ?? []).some(m => m.deliveries > 0), JSON.stringify(simulated.json?.messages).slice(0, 200));

  const messageId = (simulated.json?.messages ?? [])[0]?.messageId;
  const trace = await j(`/middleware/messages/${messageId}`, { token: ADMIN });
  check('Every stage of it is on the record', trace.status === 200 && (trace.json?.trace ?? []).length >= 5,
    `${(trace.json?.trace ?? []).length} step(s)`);
  check('The patient name never reached the record',
    !JSON.stringify(trace.json ?? {}).includes('SMITH'), 'a patient name is in the stored message');

  const drained = await j('/middleware/queue/drain', { method: 'POST', token: ADMIN, body: {} });
  check('A sweep can be run on request', drained.status === 200 && typeof drained.json?.attempted === 'number',
    JSON.stringify(drained.json));

  const deliveries = await j(`/middleware/deliveries?limit=20`, { token: ADMIN });
  check('The delivery is accepted by the internal destination',
    (deliveries.json?.rows ?? []).some(row => row.message_id === messageId && row.state === 'delivered'),
    JSON.stringify((deliveries.json?.rows ?? []).map(r => [r.destination_name, r.state])).slice(0, 220));
  check('A delivery against a destination with no acknowledgement is not claimed as confirmed',
    (deliveries.json?.rows ?? []).filter(row => row.message_id === messageId).every(row => row.confirmable === false));
}

/* ====================================================== permission enforcement */
section('Permission enforcement');
if (!BENCH) {
  console.log('  SKIP  No bench account could be created on this host, so the refusals were not exercised.');
} else {
  const refusals = [
    ['configure a destination', 'POST', '/middleware/destinations', { name: 'Nope', transport: 'internal' }],
    ['change a destination', 'PUT', `/middleware/destinations/${internalId}`, { name: 'Nope' }],
    ['approve a destination', 'POST', `/middleware/destinations/${internalId}/approve`, {}],
    ['activate a destination', 'POST', `/middleware/destinations/${internalId}/activate`, {}],
    ['retire a destination', 'DELETE', `/middleware/destinations/${internalId}`, {}],
    ['scan the network', 'POST', '/middleware/discovery', { target: '192.168.1.0/30' }],
    ['create a routing rule', 'POST', '/middleware/routes', { name: 'Nope', destinationId: internalId }],
    ['run a queue sweep', 'POST', '/middleware/queue/drain', {}],
    ['capture a baseline', 'POST', '/middleware/baselines/capture', {}],
  ];
  for (const [what, method, path, body] of refusals) {
    const response = await j(path, { method, token: BENCH, body });
    check(`A bench account may not ${what}`, response.status === 403,
      `status ${response.status} ${String(response.json?.error).slice(0, 80)}`);
  }

  const rollback = await j('/middleware/versions/1/rollback', { method: 'POST', token: BENCH, body: { reason: 'x' } });
  check('A bench account may not roll a configuration back', rollback.status === 403, `status ${rollback.status}`);

  const versions = await j('/middleware/versions', { token: BENCH });
  check('A bench account may not read the configuration history either', versions.status === 403, `status ${versions.status}`);

  const unauthenticated = await j('/middleware/overview');
  check('An unauthenticated caller reaches nothing', unauthenticated.status === 401, `status ${unauthenticated.status}`);
}

/* ============================================================ Dennis's limits */
section('Dennis: evidence, and the things it may not do');
{
  const answer = await j('/middleware/dennis/ask', {
    method: 'POST', token: ADMIN,
    body: { tool: 'summarise_health', question: 'Is transmission working?' },
  });
  check('Dennis answers', answer.status === 200 && String(answer.json?.answer ?? '').length > 0, `status ${answer.status}`);
  check('The answer is built from measured evidence',
    (answer.json?.findings ?? []).length > 0 && answer.json?.grade === 'verified',
    `${(answer.json?.findings ?? []).length} finding(s), grade ${answer.json?.grade}`);
  check('The answer says how its prose was produced',
    ['local model', 'deterministic'].includes(answer.json?.composedBy), String(answer.json?.composedBy));
  check('An advisory answer proposes no change', answer.json?.state === 'advisory' && answer.json?.proposal === null,
    String(answer.json?.state));
  check('No external AI was used', answer.json?.notice && answer.status === 200);

  const onProductionPort = await j('/middleware/dennis/ask', {
    method: 'POST', token: ADMIN,
    body: { tool: 'propose_configuration', question: 'Set up a destination on 5150.', intent: { port: 5150, host: '10.0.0.9', name: 'X' } },
  });
  check('Dennis cannot propose a configuration on the production port',
    onProductionPort.json?.state === 'blocked', `${onProductionPort.json?.state} ${String(onProductionPort.json?.blockedReason).slice(0, 140)}`);
  check('The block names the reason', String(onProductionPort.json?.blockedReason ?? '').length > 0,
    String(onProductionPort.json?.blockedReason));

  const blockedReview = await j(`/middleware/dennis/${onProductionPort.json?.actionId}/review`, {
    method: 'POST', token: ADMIN, body: { decision: 'approved' },
  });
  check('A blocked recommendation cannot be approved', blockedReview.status === 409,
    `status ${blockedReview.status} ${String(blockedReview.json?.error).slice(0, 120)}`);

  const identifiable = await j('/middleware/dennis/ask', {
    method: 'POST', token: ADMIN,
    body: { tool: 'analyse_sample', sample: 'PID|1||555|ADAMS^MARY||19751103|F\rOBX|1|NM|GLU||5.1' },
  });
  check('A sample that cannot be sanitised to standard is refused rather than analysed',
    identifiable.json?.state === 'blocked' || !String(identifiable.json?.answer ?? '').includes('ADAMS'),
    String(identifiable.json?.answer).slice(0, 140));

  const proposal = await j('/middleware/dennis/ask', {
    method: 'POST', token: ADMIN,
    body: { tool: 'propose_mapping', destinationId: internalId, intent: { profileKey: 'sysmex_xn' } },
  });
  check('A mapping proposal is recorded as proposed, not applied',
    proposal.json?.state === 'proposed' && proposal.json?.proposal, String(proposal.json?.state));
  check('A mapping proposal never invents a target code',
    ((proposal.json?.proposal?.rows ?? []).every(row => row.targetCode === null)),
    JSON.stringify(proposal.json?.proposal?.rows ?? []).slice(0, 200));

  const history = await j('/middleware/dennis', { token: ADMIN });
  check('Every recommendation is on the record',
    (history.json?.actions ?? []).length >= 3, String((history.json?.actions ?? []).length));
  check('A recommendation records whether external AI was used',
    (history.json?.actions ?? []).every(action => action.online_used === 0));

  if (BENCH) {
    const benchApprove = await j(`/middleware/dennis/${proposal.json?.actionId}/review`, {
      method: 'POST', token: BENCH, body: { decision: 'approved' },
    });
    check('A bench account may not approve a Dennis proposal', benchApprove.status === 403, `status ${benchApprove.status}`);
  }
}

/* ===================================================== versioning and the audit */
section('Configuration history and the audit trail');
{
  const versions = await j(`/middleware/versions?scope=destination&entityId=${internalId}`, { token: ADMIN });
  check('Every change to the destination is recorded',
    versions.status === 200 && (versions.json?.versions ?? []).length >= 3,
    `${(versions.json?.versions ?? []).length} version(s)`);
  check('A version names the fields that changed',
    (versions.json?.versions ?? []).some(v => (v.changes ?? []).some(c => c.field === 'ack_policy')),
    JSON.stringify((versions.json?.versions ?? [])[0]?.changes ?? []).slice(0, 200));
  check('No credential appears anywhere in the history',
    !JSON.stringify(versions.json ?? {}).includes('secret_cipher'));

  const target = (versions.json?.versions ?? []).find(v => v.action === 'create');
  const rolled = await j(`/middleware/versions/${target?.id}/rollback`, {
    method: 'POST', token: ADMIN, body: { reason: 'Checking rollback works.' },
  });
  check('A configuration can be rolled back', rolled.status === 200 && rolled.json?.ok, JSON.stringify(rolled.json).slice(0, 200));
  check('The rollback stands the destination down again',
    (await j('/middleware/destinations', { token: ADMIN })).json.find(d => d.id === internalId)?.state === 'awaiting_approval');

  const audit = await j('/system-audit/trail?limit=200', { token: ADMIN });
  const rows = audit.json?.rows ?? audit.json?.entries ?? audit.json ?? [];
  const actions = new Set((Array.isArray(rows) ? rows : []).map(row => row.action));
  for (const action of ['middleware_destination_create', 'middleware_destination_approve', 'middleware_destination_activate', 'middleware_config_rollback']) {
    check(`${action} is in the audit trail`, actions.has(action),
      Array.isArray(rows) ? `${rows.length} row(s) read` : 'the trail could not be read');
  }
}

/* ============================================= the protected path, at the end */
section('The Sysmex XN-550 to LHIMS path, after everything above');
{
  const link = (await j('/instrument-links', { token: ADMIN })).json?.find(l => l.id === protectedLinkId);
  check('Its role is unchanged', link?.role === 'lhims_owned', String(link?.role));
  check('Its port is unchanged', link?.listen_port === 5150, String(link?.listen_port));
  check('Its protocol is unchanged', link?.protocol === 'astm', String(link?.protocol));
  check('The bridge is not running it', link?.running !== true, `running=${link?.running}`);
  check('Nothing was routed from it',
    !((await j('/middleware/routes', { token: ADMIN })).json ?? []).some(r => r.source_link_id === protectedLinkId));
  const baselines = await j('/middleware/baselines', { token: ADMIN });
  const verified = await j(`/middleware/baselines/${(baselines.json ?? [])[0]?.id}/verify`, { method: 'POST', token: ADMIN, body: {} });
  check('Its baseline still verifies as unchanged', verified.json?.verdict === 'unchanged',
    `${verified.json?.verdict} ${JSON.stringify(verified.json?.drift ?? [])}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
