/**
 * Dennis, on the analyser interfaces.
 *
 * Dennis is the laboratory's assistant everywhere else in SECHLIMS, and this is
 * the same Dennis, with the same providers, the same settings and the same
 * activity log — not a second assistant. What changes is the ground it stands
 * on, and the rules it works under.
 *
 * THE ORDER IS THE POINT. Every answer is built the same way:
 *
 *   1. Deterministic tools gather the evidence — the diagnostics, the queue,
 *      the parser's actual output, the configuration of a profile known to
 *      work. This happens whether or not a model is available, and it is what
 *      the answer is MADE of.
 *   2. The model, if there is one, explains that evidence and nothing else.
 *   3. A proposal is validated by deterministic code again, after the model has
 *      produced it, and a proposal that fails validation is blocked rather than
 *      shown as advice.
 *
 * So with no model configured, this still works: the findings are real, the
 * procedure is real, and the answer says it was composed without one. A
 * laboratory is never worse off than it was, and is never given a fluent
 * account of something nobody measured.
 *
 * WHAT DENNIS MAY NOT DO, enforced here rather than requested of it:
 *   · change a protected production connection — refused in `safety.ts`;
 *   · activate anything — activation is a human action with an approval row;
 *   · route clinical results anywhere — it proposes rules, it does not apply them;
 *   · touch a patient record — it has no path to one;
 *   · see an identifiable message — samples are sanitised before they are read,
 *     and a sample that still looks identifiable is refused outright.
 *
 * Grades, not confidence theatre: `verified` means a tool in this system
 * measured it, `inferred` means it follows from what was measured, and
 * `hypothesis` means it does not and says so.
 */
import {
  DENNIS_PROPOSING_TOOLS, PROTECTED_BASELINE_LABEL,
  collidesWithProtected, looksIdentifiable, sanitiseProtocolSample,
  type DennisTool, type EvidenceGrade,
} from '../../../shared/constants/middleware.js';
import {
  INSTRUMENT_PROFILES, LINK_PROTOCOLS, profileByKey,
} from '../../../shared/constants/instruments.js';
import { DENNIS_NOTICE, localChat } from '../../utils/dennisEngine.js';
import { logActivity, providerSettings } from '../dennisService.js';
import { detectProtocol, effectiveProtocol, parseFor, splitTransmissions } from '../instrumentBridge/protocols.js';
import { diagnoseDestination, diagnoseLink, diagnoseSystem } from './diagnostics.js';
import { endpointIsSafe, protectedEndpoints, routeIsSafe } from './safety.js';
import { scrubSecrets } from './secrets.js';

type DB = any;

export interface DennisRequest {
  tool: DennisTool;
  userId: number;
  /** What the person asked, in their own words. Optional for the summary tools. */
  question?: string | null;
  linkId?: number | null;
  destinationId?: number | null;
  /** A captured transmission. Sanitised here before anything reads it. */
  sample?: string | null;
  /** For a proposal: what the person wants configured. */
  intent?: Record<string, unknown> | null;
}

export interface DennisAnswer {
  actionId: number | null;
  tool: DennisTool;
  /** The deterministic evidence the answer is built from. */
  findings: Array<{ label: string; detail: string; grade: EvidenceGrade }>;
  answer: string;
  grade: EvidenceGrade;
  confidence: 'high' | 'medium' | 'low';
  /** A change, where the tool produces one. Never applied by this call. */
  proposal: Record<string, unknown> | null;
  validation: { ok: boolean; errors: string[]; warnings: string[] } | null;
  state: string;
  blockedReason: string | null;
  /** How the prose was produced, so nobody mistakes a template for a model. */
  composedBy: 'local model' | 'deterministic';
  notice: string;
}

/* ============================================================================
   The one entry point
   ========================================================================= */
export async function askDennisMiddleware(db: DB, request: DennisRequest): Promise<DennisAnswer> {
  const evidence = gather(db, request);
  const sanitisedRequest = {
    tool: request.tool,
    question: request.question ? String(request.question).slice(0, 1_000) : null,
    linkId: request.linkId ?? null,
    destinationId: request.destinationId ?? null,
    sampleProvided: Boolean(request.sample),
    intent: request.intent ?? null,
  };

  // A sample that still carries something identifiable after sanitising is
  // refused rather than sent anywhere. The structure is the diagnostic value;
  // the identifiers are not, and keeping them in the laboratory is not
  // negotiable against a slightly better answer.
  if (request.sample && looksIdentifiable(sanitiseProtocolSample(String(request.sample)))) {
    return record(db, request, sanitisedRequest, {
      findings: evidence.findings,
      answer: 'This sample still carries patient-identifying fields after sanitising, so it was not analysed. Paste the record structure without the patient segment, or use a captured control run.',
      grade: 'verified', confidence: 'high', proposal: null, validation: null,
      state: 'blocked', blockedReason: 'The sample could not be sanitised to the standard this module requires.',
      composedBy: 'deterministic',
    });
  }

  const proposal = DENNIS_PROPOSING_TOOLS.includes(request.tool) ? buildProposal(db, request, evidence) : null;
  const validation = proposal ? validateProposal(db, proposal) : null;

  if (proposal && validation && !validation.ok) {
    return record(db, request, sanitisedRequest, {
      findings: evidence.findings,
      answer: `The configuration this would need cannot be proposed: ${validation.errors.join(' ')}`,
      grade: 'verified', confidence: 'high', proposal, validation,
      state: 'blocked', blockedReason: validation.errors.join(' '),
      composedBy: 'deterministic',
    });
  }

  const prose = await compose(db, request, evidence, proposal, validation);

  return record(db, request, sanitisedRequest, {
    findings: evidence.findings,
    answer: prose.answer,
    grade: evidence.grade,
    confidence: evidence.confidence,
    proposal,
    validation,
    state: proposal ? 'proposed' : 'advisory',
    blockedReason: null,
    composedBy: prose.composedBy,
  });
}

/* ============================================================================
   Step one: the evidence
   ----------------------------------------------------------------------------
   Measured before anything is written, so the answer is an explanation of
   facts rather than a plausible account of a configuration.
   ========================================================================= */
interface Evidence {
  findings: Array<{ label: string; detail: string; grade: EvidenceGrade }>;
  context: string;
  grade: EvidenceGrade;
  confidence: 'high' | 'medium' | 'low';
}

function gather(db: DB, request: DennisRequest): Evidence {
  const findings: Evidence['findings'] = [];
  const blocks: string[] = [];

  if (request.linkId != null) {
    const link = db.prepare('SELECT * FROM instrument_links WHERE id = ?').get(request.linkId) as any;
    if (link) {
      findings.push({
        label: 'Link configuration',
        detail: `${link.name}: role ${link.role}, mode ${link.mode}, protocol ${link.protocol}, state ${link.state}`
          + `${link.listen_port ? `, listening on port ${link.listen_port}` : ''}${link.state_detail ? ` — ${link.state_detail}` : ''}`,
        grade: 'verified',
      });
      blocks.push(`Link: ${link.name}\nRole: ${link.role}\nMode: ${link.mode}\nProtocol: ${link.protocol}\nState: ${link.state}\nDetail: ${link.state_detail ?? 'none'}\nLast message: ${link.last_message_at ?? 'never'}\nLast error: ${scrubSecrets(link.last_error ?? 'none')}`);
    }
  }

  if (request.sample) {
    const sanitised = sanitiseProtocolSample(String(request.sample));
    const detected = detectProtocol(sanitised);
    const resolved = effectiveProtocol(detected ?? 'auto', sanitised);
    let parsed = 0;
    let records = 0;
    try {
      const messages = parseFor(resolved, sanitised);
      parsed = messages.reduce((sum, m) => sum + m.results.length, 0);
      records = messages.length;
    } catch { parsed = 0; }
    const split = splitTransmissions(resolved, sanitised, { final: true });
    findings.push({
      label: 'Parser output',
      detail: `Read as ${resolved.toUpperCase()}: ${split.complete.length} complete transmission(s), ${records} message(s), ${parsed} result(s).`,
      grade: 'verified',
    });
    blocks.push(`Sanitised sample, as the parser reads it:\nProtocol detected: ${detected ?? 'none'}\nFramed transmissions: ${split.complete.length}\nResults parsed: ${parsed}\n\n${sanitised.slice(0, 2_000)}`);
  }

  if (request.destinationId != null) {
    const destination = db.prepare('SELECT * FROM mw_destinations WHERE id = ?').get(request.destinationId) as any;
    if (destination) {
      findings.push({
        label: 'Destination configuration',
        detail: `${destination.name}: ${destination.platform} over ${destination.transport} as ${destination.payload_format}, `
          + `acknowledgement ${destination.ack_policy}, state ${destination.state}`,
        grade: 'verified',
      });
      const failures = db.prepare(`SELECT error, COUNT(*) AS n FROM mw_deliveries
          WHERE destination_id = ? AND state = 'dead_letter' AND error IS NOT NULL
          GROUP BY error ORDER BY n DESC LIMIT 5`).all(request.destinationId) as any[];
      if (failures.length) {
        findings.push({
          label: 'Dead-letter reasons',
          detail: failures.map(f => `${f.n}× ${scrubSecrets(String(f.error)).slice(0, 160)}`).join('; '),
          grade: 'verified',
        });
      }
      blocks.push(`Destination: ${destination.name}\nPlatform: ${destination.platform}\nTransport: ${destination.transport}\nFormat: ${destination.payload_format}\nAcknowledgement: ${destination.ack_policy}\nState: ${destination.state}\nLast error: ${scrubSecrets(destination.last_error ?? 'none')}\nDead-letter reasons:\n${failures.map(f => `  ${f.n}x ${scrubSecrets(String(f.error)).slice(0, 200)}`).join('\n') || '  none'}`);
    }
  }

  // The whole module's state, always, because a question about one interface is
  // usually answered by something next to it.
  const system = diagnoseSystem(db);
  for (const check of system.findings.filter(f => f.status === 'fail' || f.status === 'warn')) {
    findings.push({ label: check.label, detail: check.detail, grade: 'verified' });
  }
  blocks.push(`System diagnostics (${system.status}): ${system.summary}\n`
    + system.findings.map(f => `  [${f.status}] ${f.label}: ${f.detail}`).join('\n'));

  const protectedList = protectedEndpoints(db);
  if (protectedList.length) {
    findings.push({
      label: 'Protected endpoints',
      detail: `${protectedList.length} endpoint(s) are protected and must not be bound, dialled or probed: `
        + protectedList.map(e => `${e.host || 'any'}:${e.port}`).join(', '),
      grade: 'verified',
    });
    blocks.push(`Protected endpoints (never to be used): ${protectedList.map(e => `${e.host || 'any'}:${e.port}`).join(', ')}`);
  }

  return {
    findings,
    context: blocks.join('\n\n'),
    grade: findings.length ? 'verified' : 'hypothesis',
    confidence: findings.length >= 3 ? 'high' : findings.length ? 'medium' : 'low',
  };
}

/* ============================================================================
   Step two: a proposal, from the evidence
   ----------------------------------------------------------------------------
   Built by deterministic code, not by the model. The model explains it. That
   way a proposal can always be validated field by field, and there is no path
   by which generated prose becomes a configuration.
   ========================================================================= */
function buildProposal(db: DB, request: DennisRequest, evidence: Evidence): Record<string, unknown> {
  if (request.tool === 'propose_mapping') return buildMappingProposal(db, request);
  return buildConnectionProposal(db, request, evidence);
}

function buildConnectionProposal(db: DB, request: DennisRequest, _evidence: Evidence): Record<string, unknown> {
  const intent = request.intent ?? {};
  const sample = request.sample ? sanitiseProtocolSample(String(request.sample)) : null;
  const detected = sample ? detectProtocol(sample) : null;

  // A profile the laboratory already runs successfully is better evidence than
  // anything inferred: the comparison is against something that works here.
  const working = db.prepare(`SELECT profile_key, protocol, mode, COUNT(*) AS n
      FROM instrument_links WHERE is_active = 1 AND state IN ('listening','connected','following')
      GROUP BY profile_key, protocol, mode ORDER BY n DESC LIMIT 1`).get() as any;

  const profileKey = String(intent.profileKey ?? '') || null;
  const profile = profileByKey(profileKey) ?? (detected
    ? INSTRUMENT_PROFILES.find(p => p.protocol === detected) ?? null
    : null);

  const port = Number(intent.port ?? 0) || suggestPort(db);
  return {
    kind: 'destination',
    name: String(intent.name ?? '') || (profile ? `${profile.label} interface` : 'New destination'),
    platform: String(intent.platform ?? 'lis'),
    transport: String(intent.transport ?? (detected === 'hl7' ? 'hl7_mllp' : detected === 'astm' ? 'astm_tcp' : 'hl7_mllp')),
    payload_format: String(intent.payloadFormat ?? (detected === 'astm' ? 'astm' : 'hl7v2')),
    host: intent.host == null ? null : String(intent.host),
    port,
    ack_policy: String(intent.ackPolicy ?? 'protocol_ack'),
    retry_max: Number(intent.retryMax ?? 6),
    basis: [
      detected ? `The sanitised sample frames as ${detected.toUpperCase()}.` : 'No sample was supplied, so the protocol is proposed from the destination type rather than observed.',
      profile ? `Matched against the ${profile.label} profile.` : 'No analyser profile matched.',
      working ? `This laboratory already runs ${working.n} working link(s) as ${String(working.protocol).toUpperCase()} in ${working.mode} mode.` : 'No working link was available to compare against.',
    ],
    manualSteps: [
      'Confirm the receiving system\'s port and acknowledgement behaviour with whoever administers it.',
      'Transmit one test message to the isolated test destination and read the acknowledgement before approving.',
      'Approval and activation are separate human actions; nothing is carried until both are recorded.',
    ],
  };
}

function buildMappingProposal(db: DB, request: DennisRequest): Record<string, unknown> {
  const destinationId = Number(request.destinationId ?? 0);
  const profileKey = String((request.intent ?? {}).profileKey ?? '') || null;
  const profile = profileByKey(profileKey);

  // The codes that have actually arrived, which is what a mapping is for —
  // rather than the codes a profile says the model emits.
  let observed: Array<{ code: string; n: number }> = [];
  try {
    const rows = db.prepare(`SELECT parsed_values FROM instrument_messages
        WHERE result_count > 0 ${request.linkId ? 'AND link_id = ?' : ''}
        ORDER BY id DESC LIMIT 50`).all(...(request.linkId ? [request.linkId] : [])) as any[];
    const tally = new Map<string, number>();
    for (const row of rows) {
      let values: any[] = [];
      try { values = JSON.parse(row.parsed_values ?? '[]'); } catch { values = []; }
      for (const value of values) {
        const code = String(value?.code ?? '').trim();
        if (code) tally.set(code, (tally.get(code) ?? 0) + 1);
      }
    }
    observed = [...tally.entries()].map(([code, n]) => ({ code, n })).sort((a, b) => b.n - a.n);
  } catch { observed = []; }

  let existing = new Set<string>();
  try {
    const rows = db.prepare('SELECT source_code FROM mw_mappings WHERE destination_id = ?').all(destinationId) as any[];
    existing = new Set(rows.map(r => String(r.source_code).toUpperCase()));
  } catch { existing = new Set(); }

  const rows = observed
    .filter(entry => !existing.has(entry.code.toUpperCase()))
    .slice(0, 40)
    .map(entry => ({
      sourceCode: entry.code,
      // The laboratory's own name for the analyte, from the profile. Never a
      // target code: what the receiving system calls it is not knowable here,
      // and inventing one is how a result gets filed under the wrong test.
      targetName: profile?.analytes[entry.code] ?? profile?.analytes[entry.code.toUpperCase()] ?? null,
      targetCode: null,
      seenInLast50Messages: entry.n,
      requiresConfirmation: true,
    }));

  return {
    kind: 'mapping',
    destinationId,
    rows,
    basis: [
      `${observed.length} distinct test code(s) have actually arrived from this source.`,
      profile ? `Analyte names taken from the ${profile.label} profile.` : 'No profile matched, so no analyte names could be filled in.',
      'No target code is proposed. What the receiving system calls each test has to come from its own documentation.',
    ],
    manualSteps: [
      'Enter the target code for each row from the receiving system\'s own interface specification.',
      'A row with no target code is not transmitted — the result is withheld and named, rather than filed under a guess.',
    ],
  };
}

function suggestPort(db: DB): number {
  const taken = new Set<number>();
  try {
    for (const row of db.prepare('SELECT listen_port, remote_port FROM instrument_links').all() as any[]) {
      if (row.listen_port) taken.add(Number(row.listen_port));
      if (row.remote_port) taken.add(Number(row.remote_port));
    }
    for (const row of db.prepare('SELECT port FROM mw_destinations WHERE port IS NOT NULL').all() as any[]) {
      taken.add(Number(row.port));
    }
  } catch { /* an empty register leaves everything free */ }
  for (const endpoint of protectedEndpoints(db)) if (endpoint.port) taken.add(Number(endpoint.port));
  for (let port = 9200; port < 9300; port++) if (!taken.has(port)) return port;
  return 9200;
}

/* ============================================================================
   Step three: validation, by code, after the proposal exists
   ========================================================================= */
export function validateProposal(db: DB, proposal: Record<string, unknown>): { ok: boolean; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (proposal.kind === 'mapping') {
    const rows = (proposal.rows as any[]) ?? [];
    if (!rows.length) warnings.push('No unmapped code was found, so there is nothing to add.');
    for (const row of rows) {
      if (!row.sourceCode) errors.push('A proposed mapping row has no source code.');
      if (!row.targetCode) warnings.push(`${row.sourceCode}: no target code. It will not be transmitted until one is entered.`);
    }
    return { ok: errors.length === 0, errors, warnings };
  }

  const port = Number(proposal.port ?? 0);
  const host = proposal.host == null ? null : String(proposal.host);
  const transport = String(proposal.transport ?? '');

  if (!proposal.name) errors.push('A destination needs a name.');
  if (!['internal', 'hl7_mllp', 'astm_tcp', 'http_lhims', 'http_json', 'file_export'].includes(transport)) {
    errors.push(`${transport || 'That transport'} is not a transport the engine implements.`);
  }
  if ((transport === 'hl7_mllp' || transport === 'astm_tcp') && (!host || !port)) {
    errors.push('A TCP destination needs a host and a port.');
  }
  if (port) {
    const collision = collidesWithProtected({ host, port }, protectedEndpoints(db));
    if (collision) {
      // The refusal that matters most, and it is made here rather than at the
      // point of saving, so a proposal that would collide never reaches a
      // screen as advice.
      errors.push(`Port ${port} belongs to a live production transmission. ${collision.because} A proposal may not use it.`);
    }
    const safe = endpointIsSafe(db, { host, port }, 'The proposed destination');
    if (!safe.ok && safe.reason) errors.push(safe.reason);
  }
  if (String(proposal.ack_policy ?? '') === 'none') {
    warnings.push('With no acknowledgement, a delivery can be shown as transmitted but never as accepted.');
  }
  if (!LINK_PROTOCOLS.includes(String(proposal.payload_format ?? '') as any) && !['hl7v2', 'astm', 'json', 'csv', 'raw'].includes(String(proposal.payload_format ?? ''))) {
    errors.push(`${proposal.payload_format} is not a payload format the engine renders.`);
  }
  return { ok: errors.length === 0, errors, warnings };
}

/* ============================================================================
   Step four: the words
   ========================================================================= */
async function compose(db: DB, request: DennisRequest, evidence: Evidence, proposal: Record<string, unknown> | null, validation: { ok: boolean; errors: string[]; warnings: string[] } | null): Promise<{ answer: string; composedBy: 'local model' | 'deterministic' }> {
  const settings = providerSettings(db);
  const instruction = INSTRUCTIONS[request.tool];
  const template = deterministicAnswer(request, evidence, proposal, validation);

  // Online AI is not used here at all. Middleware evidence carries sample
  // identifiers, host addresses and queue contents, and the policy for that
  // material is that it stays in the laboratory. The local model is the only
  // one offered, and no model at all is a supported state.
  if (!settings.localEnabled) return { answer: template, composedBy: 'deterministic' };

  const system = 'You are Dennis, the laboratory middleware assistant in SECHLIMS. '
    + 'Answer ONLY from the evidence given. Never invent a host, port, code, measurement or error you were not shown. '
    + 'Mark anything that does not follow directly from the evidence as a hypothesis. '
    + 'Never suggest changing, re-pointing or testing a protected production connection. '
    + 'Be concise and operational: a laboratory scientist is reading this at a bench.';
  const user = `${instruction}\n\nQuestion: ${request.question ?? '(none given)'}\n\n`
    + `Evidence measured by SECHLIMS:\n${evidence.context}\n\n`
    + (proposal ? `Proposed configuration (produced by deterministic code, not by you — explain and check it, do not change it):\n${JSON.stringify(proposal, null, 2)}\n\n` : '')
    + (validation ? `Validation of that proposal: ${validation.ok ? 'passed' : 'FAILED'}\n${[...validation.errors, ...validation.warnings].join('\n')}\n\n` : '')
    + 'Write the answer.';

  try {
    const body = await localChat(settings, [{ role: 'system', content: system }, { role: 'user', content: user }]);
    const answer = scrubSecrets(String(body ?? '').trim());
    if (!answer) return { answer: template, composedBy: 'deterministic' };
    return {
      answer: `${answer}\n\n— Evidence this was built from —\n${evidence.findings.map(f => `• ${f.label}: ${f.detail}`).join('\n')}`,
      composedBy: 'local model',
    };
  } catch {
    // A model that is not answering is not a failure of the tool. The evidence
    // and the procedure are the substance; the prose was the optional part.
    return { answer: template, composedBy: 'deterministic' };
  }
}

const INSTRUCTIONS: Record<DennisTool, string> = {
  explain_diagnostics: 'Explain what the diagnostic findings mean and what the most likely cause is. Distinguish reachable, connected, parsed, delivered and accepted — they are different facts.',
  troubleshoot: 'Give a numbered troubleshooting procedure. Each step must be something a person can do and observe, in the order that eliminates the most likely cause first.',
  analyse_sample: 'Describe what the sanitised sample is, how it frames, and why the parser read it the way it did. Name the field or framing error if there is one.',
  recommend_profile: 'Recommend the protocol, connection mode and analyser profile that fit the evidence, and say what is still unknown.',
  compare_configuration: 'Compare the failing configuration with the working one and list only the differences that could account for the failure.',
  propose_configuration: 'Explain the proposed configuration, what it is based on, and what has to be confirmed by a person before it is approved.',
  propose_mapping: 'Explain the proposed mapping, which codes were observed, and what the laboratory must supply from the receiving system\'s documentation.',
  summarise_health: 'Summarise transmission health: what is working, what is not, what is queued and what needs a person. Lead with anything that needs action today.',
};

function deterministicAnswer(request: DennisRequest, evidence: Evidence, proposal: Record<string, unknown> | null, validation: { ok: boolean; errors: string[]; warnings: string[] } | null): string {
  const lines: string[] = [];
  lines.push(`${INSTRUCTIONS[request.tool].split('.')[0]}, from what SECHLIMS measured:`);
  lines.push('');
  for (const item of evidence.findings) lines.push(`• ${item.label}: ${item.detail}`);
  if (!evidence.findings.length) lines.push('• Nothing could be measured for this request.');

  if (request.tool === 'troubleshoot') {
    lines.push('');
    lines.push('Procedure:');
    lines.push('1. Reachability — can this host open a connection to the device or destination? A refused connection means nothing is listening; a timeout means nothing answered at all.');
    lines.push('2. Session — does the connection stay open, or is it closed before a message completes?');
    lines.push('3. Framing — does the transmission frame into complete messages? Read the raw message in the Protocol Explorer.');
    lines.push('4. Parsing — do results come out of it? A link that receives and understands nothing looks exactly like one that receives nothing.');
    lines.push('5. Identifiers and mapping — is there a sample identifier, and is every test code mapped for the destination?');
    lines.push('6. Delivery and acceptance — did the message leave, and did the destination acknowledge it? These are two different facts.');
    lines.push('7. Queue — is the backlog shrinking? Replaying into a destination that is still refusing only grows it.');
  }

  if (proposal) {
    lines.push('');
    lines.push('Proposed configuration:');
    for (const [key, value] of Object.entries(proposal)) {
      if (key === 'basis' || key === 'manualSteps' || key === 'rows') continue;
      lines.push(`  ${key}: ${value == null ? '(not set)' : String(value)}`);
    }
    const basis = (proposal.basis as string[]) ?? [];
    if (basis.length) { lines.push(''); lines.push('Based on:'); for (const item of basis) lines.push(`  • ${item}`); }
    const manual = (proposal.manualSteps as string[]) ?? [];
    if (manual.length) { lines.push(''); lines.push('Requires a person:'); for (const item of manual) lines.push(`  • ${item}`); }
    lines.push('');
    lines.push(validation?.ok
      ? 'Validation passed. This is a proposal: it is applied only after review and approval, and activation is a separate action.'
      : `Validation failed: ${validation?.errors.join(' ')}`);
  }

  lines.push('');
  lines.push('Composed without a model: every line above is a measurement from this system, with no inference added.');
  return lines.join('\n');
}

/* ============================================================================
   The record
   ========================================================================= */
function record(db: DB, request: DennisRequest, sanitisedRequest: Record<string, unknown>, result: {
  findings: DennisAnswer['findings']; answer: string; grade: EvidenceGrade;
  confidence: 'high' | 'medium' | 'low'; proposal: Record<string, unknown> | null;
  validation: DennisAnswer['validation']; state: string; blockedReason: string | null;
  composedBy: 'local model' | 'deterministic';
}): DennisAnswer {
  let actionId: number | null = null;
  try {
    const inserted = db.prepare(`INSERT INTO mw_dennis_actions
        (user_id, tool, intent, subject_kind, subject_id, request_json, findings, answer,
         evidence_grade, confidence, proposal, validation, state, blocked_reason, online_used, redaction_applied)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1)`)
      .run(request.userId, request.tool, request.question ? String(request.question).slice(0, 500) : null,
        request.destinationId != null ? 'destination' : request.linkId != null ? 'link' : 'system',
        request.destinationId ?? request.linkId ?? null,
        JSON.stringify(sanitisedRequest), JSON.stringify(result.findings),
        scrubSecrets(result.answer).slice(0, 20_000), result.grade, result.confidence,
        result.proposal ? JSON.stringify(result.proposal) : null,
        result.validation ? JSON.stringify(result.validation) : null,
        result.state, result.blockedReason);
    actionId = Number(inserted.lastInsertRowid);
  } catch { actionId = null; }

  // The same activity log the rest of Dennis writes to, so "what has the
  // assistant been doing" is one question with one answer.
  logActivity(db, {
    userId: request.userId, module: 'analyser_middleware', action: `dennis_${request.tool}`,
    status: result.state === 'blocked' ? 'blocked' : 'ok',
    mode: result.composedBy === 'local model' ? 'local' : 'offline',
    recordId: actionId ? String(actionId) : null,
    onlineUsed: false, redactionApplied: true,
    detail: result.blockedReason ?? (request.question ? String(request.question).slice(0, 120) : null) ?? undefined,
  });

  return {
    actionId, tool: request.tool, findings: result.findings, answer: result.answer,
    grade: result.grade, confidence: result.confidence, proposal: result.proposal,
    validation: result.validation, state: result.state, blockedReason: result.blockedReason,
    composedBy: result.composedBy, notice: DENNIS_NOTICE,
  };
}

/* ============================================================================
   Review
   ----------------------------------------------------------------------------
   A proposal is reviewed by a person who holds the right to change the
   configuration. Approving it does not apply it: the application is the
   ordinary create or update endpoint, with the ordinary permission check, the
   ordinary validation and the ordinary configuration version — so there is no
   privileged path by which an assistant's proposal reaches production.
   ========================================================================= */
export function reviewAction(db: DB, options: {
  actionId: number; userId: number; decision: 'approved' | 'rejected'; note?: string | null;
}): { ok: boolean; note: string; proposal: Record<string, unknown> | null } {
  const action = db.prepare('SELECT * FROM mw_dennis_actions WHERE id = ?').get(options.actionId) as any;
  if (!action) return { ok: false, note: 'That recommendation is not on the record.', proposal: null };
  if (action.state === 'blocked') return { ok: false, note: 'That recommendation was blocked by validation and cannot be approved.', proposal: null };
  if (action.state === 'applied') return { ok: false, note: 'That recommendation has already been applied.', proposal: null };
  if (!action.proposal) return { ok: false, note: 'That recommendation is advisory and proposes no change, so there is nothing to approve.', proposal: null };

  // Validated AGAIN at approval, because the laboratory's configuration may
  // have moved since the proposal was made — a port that was free on Tuesday
  // may be the production port today.
  let proposal: Record<string, unknown> | null = null;
  try { proposal = JSON.parse(action.proposal); } catch { proposal = null; }
  if (!proposal) return { ok: false, note: 'The stored proposal could not be read.', proposal: null };

  if (options.decision === 'approved') {
    const validation = validateProposal(db, proposal);
    if (!validation.ok) {
      db.prepare(`UPDATE mw_dennis_actions SET state = 'blocked', blocked_reason = ?, reviewed_by = ?,
          reviewed_at = CURRENT_TIMESTAMP, review_note = ?, validation = ? WHERE id = ?`)
        .run(validation.errors.join(' '), options.userId, options.note ?? null, JSON.stringify(validation), options.actionId);
      return { ok: false, note: `The laboratory's configuration has changed since this was proposed, and it no longer validates: ${validation.errors.join(' ')}`, proposal: null };
    }
  }

  db.prepare(`UPDATE mw_dennis_actions SET state = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP, review_note = ? WHERE id = ?`)
    .run(options.decision, options.userId, options.note ?? null, options.actionId);

  return {
    ok: true,
    proposal: options.decision === 'approved' ? proposal : null,
    note: options.decision === 'approved'
      ? 'Approved. Applying it is a separate action and goes through the same validation, permission check and configuration version as any other change.'
      : 'Rejected, and kept on the record with your note.',
  };
}

/** Mark an approved proposal as the one a configuration version carried out. */
export function markApplied(db: DB, actionId: number, versionId: number | null): void {
  try {
    db.prepare("UPDATE mw_dennis_actions SET state = 'applied', applied_version_id = ? WHERE id = ?").run(versionId, actionId);
  } catch { /* the version itself is the record */ }
}

/** Everything the assistant has advised, proposed or had blocked. */
export function dennisHistory(db: DB, limit = 50): any[] {
  try {
    const rows = db.prepare(`SELECT a.*, u.full_name AS asked_by, r.full_name AS reviewed_by_name
        FROM mw_dennis_actions a
        LEFT JOIN users u ON u.id = a.user_id
        LEFT JOIN users r ON r.id = a.reviewed_by
        ORDER BY a.id DESC LIMIT ?`).all(limit) as any[];
    return rows.map(row => ({
      ...row,
      findings: safeJson(row.findings) ?? [],
      proposal: safeJson(row.proposal),
      validation: safeJson(row.validation),
      request_json: safeJson(row.request_json),
    }));
  } catch { return []; }
}

function safeJson(value: unknown): any {
  if (typeof value !== 'string' || !value.trim()) return null;
  try { return JSON.parse(value); } catch { return null; }
}

/** The protected baseline's label, so the UI and the assistant name it the same way. */
export const PROTECTED_LABEL = PROTECTED_BASELINE_LABEL;

/** Re-exported so the routes can refuse a route without importing safety directly. */
export { routeIsSafe };
