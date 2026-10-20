/**
 * Analyser transmission and middleware — the vocabulary.
 *
 * THE RULE THIS FILE INHERITS: nothing here may disturb a transmission that
 * already works. The laboratory's Sysmex XN-550 reaches the national LHIMS
 * middleware and that path carries patient results. Everything below is
 * additive, and the one endpoint that matters is declared PROTECTED so the
 * engine refuses to bind it, dial it, probe it or route over it.
 *
 * What the middleware adds to the analyser bridge is the second half of the
 * journey. The bridge receives from an analyser and records what it said; this
 * decides where that goes, carries it there, and can prove what happened to it:
 *
 *   ingest → parse → normalise → validate → map → route → queue → transmit
 *          → acknowledge → outcome
 *
 * Each of those is a trace step against one message, so "the ward says the
 * result never arrived" has an answer that is read rather than guessed.
 *
 * DELIVERY GUARANTEE, stated honestly: at least once, with idempotency.
 * One delivery row per (destination, message) carries an idempotency key, so a
 * retry or an authorised replay is the same delivery attempted again rather
 * than a second result. Exactly-once is NOT claimed: a destination that
 * acknowledges a message it has already stored, or acknowledges after its own
 * write fails, is outside this system's control. What is guaranteed is that a
 * duplicate is detectable here and reconcilable there.
 */

/* ============================================================================
   Where a message can go
   ----------------------------------------------------------------------------
   A destination is an information system, not a vendor. LHIMS is one platform
   among several and is deliberately NOT the default: a laboratory configures
   the systems it actually runs.
   ========================================================================= */
export const DESTINATION_PLATFORMS = ['sechlims', 'lhims', 'lis', 'his', 'other'] as const;
export type DestinationPlatform = (typeof DESTINATION_PLATFORMS)[number];

export const DESTINATION_PLATFORM_LABELS: Record<DestinationPlatform, string> = {
  sechlims: 'SECHLIMS',
  lhims: 'LHIMS',
  lis: 'Laboratory information system',
  his: 'Hospital information system',
  other: 'Other platform',
};

/** How a destination is actually reached. */
export const DESTINATION_TRANSPORTS = ['internal', 'hl7_mllp', 'astm_tcp', 'http_lhims', 'http_json', 'file_export'] as const;
export type DestinationTransport = (typeof DESTINATION_TRANSPORTS)[number];

export const DESTINATION_TRANSPORT_LABELS: Record<DestinationTransport, string> = {
  internal: 'SECHLIMS internal — no network transmission',
  hl7_mllp: 'HL7 v2 over MLLP (TCP)',
  astm_tcp: 'ASTM E1394 over TCP',
  http_lhims: 'LHIMS result API (HTTP)',
  http_json: 'HTTP JSON endpoint',
  file_export: 'File export to a watched folder',
};

export const DESTINATION_TRANSPORT_HINTS: Record<DestinationTransport, string> = {
  internal:
    'The results are already in SECHLIMS. Use this destination to record acceptance without transmitting anywhere, '
    + 'and as the baseline a new routing rule is proved against.',
  hl7_mllp: 'The usual arrangement for a hospital information system. ORU^R01 framed between 0x0B and 0x1C 0x0D, acknowledged with MSA.',
  astm_tcp: 'For a system that expects the analyser’s own dialect. ENQ/ACK handshake, framed records, checksum per frame.',
  http_lhims: 'The same api/update_result.php call the LHIMS middleware makes, result by result, using this laboratory’s own measure ids.',
  http_json: 'A JSON envelope posted to a documented endpoint. Basic or bearer authentication, 2xx means accepted.',
  file_export: 'For a system whose only intake is a folder. The file is written to a temporary name and renamed, so a reader never sees a part-written message.',
};

/** What a destination wants the message to look like. */
export const PAYLOAD_FORMATS = ['hl7v2', 'astm', 'json', 'csv', 'raw'] as const;
export type PayloadFormat = (typeof PAYLOAD_FORMATS)[number];

export const PAYLOAD_FORMAT_LABELS: Record<PayloadFormat, string> = {
  hl7v2: 'HL7 v2 ORU^R01',
  astm: 'ASTM E1394',
  json: 'JSON',
  csv: 'Delimited text',
  raw: 'Source message, unchanged',
};

/** What counts as "the destination has it". */
export const ACK_POLICIES = ['none', 'protocol_ack', 'http_2xx', 'file_written'] as const;
export type AckPolicy = (typeof ACK_POLICIES)[number];

export const ACK_POLICY_LABELS: Record<AckPolicy, string> = {
  none: 'None — transmission alone is treated as delivery',
  protocol_ack: 'Protocol acknowledgement (HL7 MSA or ASTM ACK)',
  http_2xx: 'HTTP 2xx with an accepted body',
  file_written: 'File written and renamed into place',
};

/**
 * A destination with no acknowledgement cannot confirm anything.
 *
 * Stated as a function because the screens and the engine must agree: a
 * delivery marked "delivered" against `none` means the bytes left this host,
 * and claiming more than that is how a laboratory comes to believe a result
 * arrived somewhere it did not.
 */
export function deliveryIsConfirmable(policy?: string | null): boolean {
  return policy === 'protocol_ack' || policy === 'http_2xx';
}

/* ============================================================================
   States — the words on the screen
   ========================================================================= */
export const CONNECTION_STATES = [
  'discovered', 'configured', 'testing', 'awaiting_approval', 'active', 'degraded', 'disconnected', 'failed',
] as const;
export type ConnectionState = (typeof CONNECTION_STATES)[number];

export const CONNECTION_STATE_LABELS: Record<ConnectionState, string> = {
  discovered: 'Discovered',
  configured: 'Configured',
  testing: 'Testing',
  awaiting_approval: 'Awaiting approval',
  active: 'Active',
  degraded: 'Degraded',
  disconnected: 'Disconnected',
  failed: 'Failed',
};

/** The tone a state carries, so every screen colours it the same way. */
export const CONNECTION_STATE_TONES: Record<ConnectionState, 'ok' | 'warn' | 'crit' | 'idle' | 'info'> = {
  discovered: 'info',
  configured: 'idle',
  testing: 'info',
  awaiting_approval: 'warn',
  active: 'ok',
  degraded: 'warn',
  disconnected: 'idle',
  failed: 'crit',
};

/**
 * The states a destination may be activated from.
 *
 * Activation is approval-controlled on purpose: a destination that has never
 * been tested must not start receiving clinical results because somebody
 * clicked the wrong row.
 */
export const ACTIVATABLE_STATES: ConnectionState[] = ['awaiting_approval'];

/* ============================================================================
   One delivery, through its life
   ========================================================================= */
export const DELIVERY_STATES = [
  'queued', 'in_flight', 'delivered', 'rejected', 'retrying', 'dead_letter', 'cancelled',
] as const;
export type DeliveryState = (typeof DELIVERY_STATES)[number];

export const DELIVERY_STATE_LABELS: Record<DeliveryState, string> = {
  queued: 'Queued',
  in_flight: 'In flight',
  delivered: 'Delivered',
  rejected: 'Rejected by destination',
  retrying: 'Retrying',
  dead_letter: 'Dead letter',
  cancelled: 'Cancelled',
};

/** Nothing further will happen to a delivery in one of these states on its own. */
export function deliveryIsTerminal(state?: string | null): boolean {
  return state === 'delivered' || state === 'dead_letter' || state === 'cancelled';
}

/** A delivery a person may replay: it has stopped, and it did not arrive. */
export function deliveryIsReplayable(state?: string | null): boolean {
  return state === 'dead_letter' || state === 'rejected' || state === 'cancelled';
}

/* ============================================================================
   The message, through the same life
   ========================================================================= */
export const MESSAGE_STATUSES = [
  'ingested', 'invalid', 'no_route', 'routed', 'partial', 'complete', 'failed',
] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

export const MESSAGE_STATUS_LABELS: Record<MessageStatus, string> = {
  ingested: 'Ingested',
  invalid: 'Failed validation',
  no_route: 'No routing rule matched',
  routed: 'Routed',
  partial: 'Partly delivered',
  complete: 'Delivered',
  failed: 'Delivery failed',
};

/**
 * Every stage a message passes through, in order.
 *
 * The trace is written stage by stage so the Message Explorer can show where a
 * transmission stopped, and the distinction the spec insists on is kept
 * throughout: reachable, connected, parsed, delivered and ACCEPTED are five
 * different facts and none of them implies the next.
 */
export const TRACE_STAGES = [
  'ingest', 'parse', 'normalise', 'validate', 'map', 'route', 'queue', 'transmit', 'acknowledge', 'outcome', 'replay',
] as const;
export type TraceStage = (typeof TRACE_STAGES)[number];

export const TRACE_STAGE_LABELS: Record<TraceStage, string> = {
  ingest: 'Ingested',
  parse: 'Parsed',
  normalise: 'Normalised',
  validate: 'Validated',
  map: 'Mapped',
  route: 'Routed',
  queue: 'Queued',
  transmit: 'Transmitted',
  acknowledge: 'Acknowledged',
  outcome: 'Outcome',
  replay: 'Replayed',
};

/* ============================================================================
   Routing
   ----------------------------------------------------------------------------
   A rule says which messages go to one destination. Rules are ordered, every
   matching rule produces its own delivery, and a destination failing has no
   effect on any other — the whole reason deliveries are rows rather than a
   single status on the message.
   ========================================================================= */
export const ROUTE_MESSAGE_KINDS = ['any', 'patient', 'control', 'unknown'] as const;
export type RouteMessageKind = (typeof ROUTE_MESSAGE_KINDS)[number];

export const ROUTE_MESSAGE_KIND_LABELS: Record<RouteMessageKind, string> = {
  any: 'Any message',
  patient: 'Patient results only',
  control: 'Control runs only',
  unknown: 'Unreadable messages only',
};

export interface RouteCriteria {
  /** The analyser link this rule applies to. Null is every link. */
  sourceLinkId?: number | null;
  /** The analyser profile, for a rule that follows a model rather than one machine. */
  sourceProfileKey?: string | null;
  messageKind?: RouteMessageKind | null;
  /** Test identifiers, as the analyser emits them or as mapped. Empty is every test. */
  testCodes?: string[] | null;
  sectionId?: number | null;
  facility?: string | null;
  department?: string | null;
}

export interface RoutableMessage {
  linkId: number | null;
  profileKey?: string | null;
  kind: string;
  sectionId?: number | null;
  facility?: string | null;
  department?: string | null;
  codes: string[];
}

/**
 * Does this rule cover this message?
 *
 * Shared between the engine and the "try a rule" screen on purpose: a screen
 * that predicts routing differently from the engine is worse than no screen.
 * Every criterion left blank matches everything, and a criterion that is set
 * must match — so a rule narrows, never widens.
 */
export function routeMatches(criteria: RouteCriteria, message: RoutableMessage): boolean {
  if (criteria.sourceLinkId != null && criteria.sourceLinkId !== message.linkId) return false;
  if (criteria.sourceProfileKey && criteria.sourceProfileKey !== (message.profileKey ?? null)) return false;
  const kind = criteria.messageKind ?? 'any';
  if (kind !== 'any' && kind !== message.kind) return false;
  if (criteria.sectionId != null && criteria.sectionId !== message.sectionId) return false;
  if (criteria.facility && normalise(criteria.facility) !== normalise(message.facility ?? '')) return false;
  if (criteria.department && normalise(criteria.department) !== normalise(message.department ?? '')) return false;
  const wanted = (criteria.testCodes ?? []).map(normalise).filter(Boolean);
  if (wanted.length) {
    const present = new Set((message.codes ?? []).map(normalise));
    if (!wanted.some(code => present.has(code))) return false;
  }
  return true;
}

function normalise(value: string): string {
  return String(value ?? '').trim().toUpperCase().replace(/[\s_-]+/g, '');
}

/* ============================================================================
   Retries
   ----------------------------------------------------------------------------
   Exponential with a ceiling and deterministic jitter. Deterministic because a
   test has to be able to assert the schedule, and jittered because twenty
   deliveries that failed together must not all come back at the same instant
   and fail together again.
   ========================================================================= */
export const RETRY_DEFAULT_MAX_ATTEMPTS = 6;
export const RETRY_DEFAULT_BASE_MS = 15_000;
export const RETRY_DEFAULT_FACTOR = 2;
export const RETRY_CEILING_MS = 30 * 60 * 1000;

export function retryDelayMs(attempt: number, options?: {
  baseMs?: number | null; factor?: number | null; ceilingMs?: number | null; seed?: number | null;
}): number {
  const base = Math.max(1_000, Number(options?.baseMs ?? RETRY_DEFAULT_BASE_MS));
  const factor = Math.max(1, Number(options?.factor ?? RETRY_DEFAULT_FACTOR));
  const ceiling = Math.max(base, Number(options?.ceilingMs ?? RETRY_CEILING_MS));
  const raw = base * Math.pow(factor, Math.max(0, attempt - 1));
  const capped = Math.min(ceiling, raw);
  // Up to a tenth either way, from the delivery's own id, so the spread is
  // stable for the same delivery and different between deliveries.
  const seed = Number(options?.seed ?? 0);
  const spread = ((seed % 21) - 10) / 100;
  return Math.max(1_000, Math.round(capped * (1 + spread)));
}

/* ============================================================================
   Validation — what a message must carry before it is routed anywhere
   ========================================================================= */
export interface ValidationFinding {
  /** 'error' stops the message. 'warning' is recorded and the message proceeds. */
  severity: 'error' | 'warning';
  field: string;
  detail: string;
}

export interface NormalisedResult {
  code: string;
  analyte: string;
  value: string;
  unit: string | null;
  flag: string | null;
  /** True once a destination mapping has been applied to this result. */
  mapped?: boolean;
  targetCode?: string | null;
}

export interface NormalisedMessage {
  sampleId: string | null;
  lotNumber: string | null;
  instrument: string | null;
  runAt: string | null;
  kind: string;
  results: NormalisedResult[];
}

/**
 * Is this message fit to send anywhere?
 *
 * Deliberately short, and deliberately not configurable: these are the facts
 * without which no destination can file a result at all. Anything a particular
 * destination needs on top of this is a mapping question, answered per
 * destination, where the laboratory can see which codes are unmapped.
 */
export function validateMessage(message: NormalisedMessage): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  if (!String(message.sampleId ?? '').trim()) {
    findings.push({ severity: 'error', field: 'sampleId', detail: 'The message carries no sample or specimen identifier, so no destination can file it.' });
  }
  if (!message.results.length) {
    findings.push({ severity: 'error', field: 'results', detail: 'Nothing was parsed out of this message, so there is no result to deliver.' });
  }
  for (const result of message.results) {
    if (!String(result.code ?? '').trim()) {
      findings.push({ severity: 'error', field: 'results.code', detail: 'A result arrived with no test code.' });
      continue;
    }
    if (!String(result.value ?? '').trim()) {
      findings.push({ severity: 'warning', field: `results.${result.code}`, detail: `${result.code} arrived with no value and will not be sent.` });
    }
    if (!result.unit) {
      findings.push({ severity: 'warning', field: `results.${result.code}`, detail: `${result.code} carries no unit. The destination will store the number as the analyser reported it.` });
    }
  }
  if (!String(message.runAt ?? '').trim()) {
    findings.push({ severity: 'warning', field: 'runAt', detail: 'The analyser gave no run time, so the time of receipt is used.' });
  }
  return findings;
}

export function validationBlocks(findings: ValidationFinding[]): boolean {
  return findings.some(f => f.severity === 'error');
}

/* ============================================================================
   Diagnostics — the layers, in the order a fault is actually found
   ----------------------------------------------------------------------------
   Named layers rather than a single "connection test", because every one of
   these can pass while the next fails, and a laboratory told only "failed"
   has to guess which. Reachable is not connected; connected is not parsed;
   parsed is not delivered; delivered is not accepted.
   ========================================================================= */
export const DIAGNOSTIC_LAYERS = ['network', 'transport', 'protocol', 'data', 'destination', 'queue'] as const;
export type DiagnosticLayer = (typeof DIAGNOSTIC_LAYERS)[number];

export const DIAGNOSTIC_LAYER_LABELS: Record<DiagnosticLayer, string> = {
  network: 'Network reachability',
  transport: 'Transport and listeners',
  protocol: 'Framing and parsing',
  data: 'Identifiers, mappings and validation',
  destination: 'Destination acceptance',
  queue: 'Queues and recovery',
};

export type DiagnosticStatus = 'ok' | 'warn' | 'fail' | 'skipped' | 'info';

export interface DiagnosticFinding {
  layer: DiagnosticLayer;
  key: string;
  label: string;
  status: DiagnosticStatus;
  /** What was observed, in words, with no credential in it. */
  detail: string;
  /** What to do about it, where there is a definite answer. */
  remedy?: string | null;
  /** Measured, rather than inferred. */
  measuredMs?: number | null;
}

/** The worst thing found, which is what a row in a list should show. */
export function worstStatus(findings: Array<{ status: DiagnosticStatus }>): DiagnosticStatus {
  if (findings.some(f => f.status === 'fail')) return 'fail';
  if (findings.some(f => f.status === 'warn')) return 'warn';
  if (findings.some(f => f.status === 'ok')) return 'ok';
  return 'info';
}

/* ============================================================================
   Production safety
   ----------------------------------------------------------------------------
   The laboratory's Sysmex XN-550 transmits to the LHIMS middleware. That path
   is declared here so every part of the module refuses it by the same test
   rather than each remembering to.
   ========================================================================= */
export const PROTECTED_BASELINE_LABEL = 'Sysmex XN-550 → LHIMS';

export interface ProtectedEndpoint {
  host: string | null;
  port: number | null;
  /** Why it is protected, for the refusal message. */
  because: string;
}

/**
 * Would using this address collide with a protected endpoint?
 *
 * A null or wildcard host on either side is treated as a collision, because
 * binding every interface on a port the middleware uses takes that port
 * whichever address was typed. Refusing a legitimate configuration costs
 * somebody a conversation; taking the patient-results port costs the hospital
 * its results.
 */
export function collidesWithProtected(
  candidate: { host?: string | null; port?: number | null },
  protectedEndpoints: ProtectedEndpoint[],
): ProtectedEndpoint | null {
  const port = Number(candidate.port ?? 0);
  if (!port) return null;
  const host = hostKey(candidate.host);
  for (const endpoint of protectedEndpoints) {
    if (Number(endpoint.port ?? 0) !== port) continue;
    const owned = hostKey(endpoint.host);
    if (!owned || !host || owned === host) return endpoint;
  }
  return null;
}

/** Every interface reads as "any", which collides with everything on that port. */
function hostKey(host?: string | null): string {
  const value = String(host ?? '').trim().toLowerCase();
  if (!value || value === '0.0.0.0' || value === '::' || value === '*') return '';
  if (value === 'localhost') return '127.0.0.1';
  return value;
}

/* ============================================================================
   Redaction — what Dennis is allowed to see
   ----------------------------------------------------------------------------
   Raw clinical messages stay in the authorised environment. A diagnostic
   sample handed to an assistant keeps its STRUCTURE — which is the whole
   diagnostic value of it — and loses its identifiers.
   ========================================================================= */
export const REDACTION_TOKEN = '[redacted]';

/**
 * A protocol sample safe to reason about.
 *
 * Record structure, field positions, delimiters, framing, test codes and units
 * are kept because they are what a framing or mapping fault looks like. Names,
 * dates of birth, sample and patient identifiers are replaced. The result is
 * still a valid-looking transmission, so an assistant can point at the field
 * that is wrong.
 */
export function sanitiseProtocolSample(raw: string, options?: { keepCodes?: boolean }): string {
  let text = String(raw ?? '');
  // ASTM patient record: everything after the identifier fields is identity.
  text = text.replace(/(^|[\r\n\x02])(\d?P\|[^|]*\|)[^\r\n\x03]*/g, (_m, lead, head) => `${lead}${head}${REDACTION_TOKEN}`);
  // HL7 PID: keep the segment and its first fields, redact the rest.
  text = text.replace(/(^|[\r\n])(PID\|[^|]*\|)[^\r\n]*/g, (_m, lead, head) => `${lead}${head}${REDACTION_TOKEN}`);
  // Sample identifiers wherever they appear in an ASTM order or result record.
  text = text.replace(/(\d?O\|\d+\|)([^|]*)\|([^|]*)/g, (_m, head) => `${head}${REDACTION_TOKEN}|${REDACTION_TOKEN}`);
  // Dates that look like a birth date rather than a run time.
  text = text.replace(/\b(19|20)\d{2}[01]\d[0-3]\d\b(?!\d)/g, REDACTION_TOKEN);
  if (!options?.keepCodes) return text;
  return text;
}

/** Does this text still carry something that looks like an identifier? */
export function looksIdentifiable(text: string): boolean {
  const value = String(text ?? '');
  if (/(^|[\r\n\x02])\d?P\|[^|]*\|[A-Za-z0-9]/.test(value)) return true;
  if (/(^|[\r\n])PID\|[^|]*\|[A-Za-z0-9]/.test(value)) return true;
  return false;
}

/* ============================================================================
   Dennis — what an assistant may do here, and what it may never do
   ========================================================================= */
export const DENNIS_TOOLS = [
  'explain_diagnostics', 'troubleshoot', 'analyse_sample', 'recommend_profile',
  'compare_configuration', 'propose_configuration', 'propose_mapping', 'summarise_health',
] as const;
export type DennisTool = (typeof DENNIS_TOOLS)[number];

export const DENNIS_TOOL_LABELS: Record<DennisTool, string> = {
  explain_diagnostics: 'Explain a diagnostic result',
  troubleshoot: 'Produce a troubleshooting procedure',
  analyse_sample: 'Analyse a sanitised protocol sample',
  recommend_profile: 'Recommend a protocol and connection profile',
  compare_configuration: 'Compare against a verified profile',
  propose_configuration: 'Propose a connection configuration',
  propose_mapping: 'Propose a field mapping',
  summarise_health: 'Summarise transmission health',
};

/** A tool that produces a change needs approval before anything happens. */
export const DENNIS_PROPOSING_TOOLS: DennisTool[] = ['propose_configuration', 'propose_mapping'];

export const DENNIS_ACTION_STATES = ['advisory', 'proposed', 'approved', 'rejected', 'applied', 'rolled_back', 'blocked'] as const;
export type DennisActionState = (typeof DENNIS_ACTION_STATES)[number];

export const DENNIS_ACTION_STATE_LABELS: Record<DennisActionState, string> = {
  advisory: 'Advisory',
  proposed: 'Proposed',
  approved: 'Approved',
  rejected: 'Rejected',
  applied: 'Applied',
  rolled_back: 'Rolled back',
  blocked: 'Blocked',
};

/**
 * What an assistant's answer is worth.
 *
 * `verified` means a deterministic tool in this system measured it. `inferred`
 * means it follows from what was measured. `hypothesis` means it does not, and
 * says so. Mixing the three is the failure mode that makes an assistant
 * dangerous around clinical traffic.
 */
export const EVIDENCE_GRADES = ['verified', 'inferred', 'hypothesis'] as const;
export type EvidenceGrade = (typeof EVIDENCE_GRADES)[number];

export const EVIDENCE_GRADE_LABELS: Record<EvidenceGrade, string> = {
  verified: 'Verified',
  inferred: 'Inferred',
  hypothesis: 'Hypothesis',
};

/* ============================================================================
   Queue health
   ========================================================================= */
export const QUEUE_DEPTH_WARN = 50;
export const QUEUE_DEPTH_CRITICAL = 250;
export const DEAD_LETTER_WARN = 1;

export function queueTone(depth: number, deadLetters: number): 'ok' | 'warn' | 'crit' {
  if (depth >= QUEUE_DEPTH_CRITICAL) return 'crit';
  if (depth >= QUEUE_DEPTH_WARN || deadLetters >= DEAD_LETTER_WARN) return 'warn';
  return 'ok';
}

/** How often the engine looks for work. One timer, like the bridge's. */
export const ENGINE_TICK_MS = 5_000;
/** How long a transport may take before the attempt is abandoned. */
export const TRANSPORT_TIMEOUT_MS = 20_000;
/** A delivery left in flight longer than this did not survive a restart. */
export const IN_FLIGHT_STALE_MS = 5 * 60 * 1000;
/** How many deliveries one tick will attempt. */
export const ENGINE_BATCH = 25;

/* ============================================================================
   Discovery
   ----------------------------------------------------------------------------
   Scope-limited and authorised. A scan names the hosts and ports it will try,
   refuses anything outside a private range, and never touches a protected
   endpoint — a connect() to the middleware's port is exactly the disturbance
   this module exists to avoid.
   ========================================================================= */
export const DISCOVERY_DEFAULT_PORTS = [3000, 4000, 5000, 5150, 6000, 7000, 8000, 8080, 9100, 10000, 12000];
export const DISCOVERY_MAX_HOSTS = 256;
export const DISCOVERY_CONNECT_TIMEOUT_MS = 1_200;

/**
 * Is this address inside the laboratory's own network?
 *
 * Discovery is refused anywhere else. A scan that can reach the internet is
 * not a laboratory tool, and an analyser is never there.
 */
export function isPrivateAddress(host: string): boolean {
  const value = String(host ?? '').trim();
  const parts = value.split('.').map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

/**
 * Expand `192.168.1.0/24` into the addresses a scan will try.
 *
 * Capped, and refused outside a private range. A prefix shorter than /24 is
 * refused rather than truncated: somebody who typed /16 wants a different tool.
 */
export function expandCidr(cidr: string): { hosts: string[]; error: string | null } {
  const match = String(cidr ?? '').trim().match(/^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/);
  if (!match) return { hosts: [], error: 'Give a range as an address and a prefix, for example 192.168.1.0/24.' };
  const base = match[1];
  const prefix = Number(match[2]);
  if (!isPrivateAddress(base)) return { hosts: [], error: `${base} is not inside a private network. Discovery is limited to the laboratory's own network.` };
  if (prefix < 24 || prefix > 32) return { hosts: [], error: 'The range must be between /24 and /32, so a scan stays within one subnet.' };
  const octets = base.split('.').map(Number);
  const size = 2 ** (32 - prefix);
  if (size > DISCOVERY_MAX_HOSTS) return { hosts: [], error: `A scan is limited to ${DISCOVERY_MAX_HOSTS} addresses.` };
  const start = (octets[0] << 24) + (octets[1] << 16) + (octets[2] << 8) + octets[3];
  const network = start & ~(size - 1);
  const hosts: string[] = [];
  for (let i = 0; i < size; i++) {
    const value = network + i;
    hosts.push([(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.'));
  }
  return { hosts, error: null };
}
