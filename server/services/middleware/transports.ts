/**
 * Carrying one message to one destination.
 *
 * Each transport does exactly one thing and reports one of three outcomes:
 *
 *   delivered — the destination has it, to the standard its acknowledgement
 *               policy actually proves. Against a policy of `none` that means
 *               the bytes left this host and nothing more, and the engine
 *               records it in those words rather than claiming acceptance.
 *   rejected  — the destination refused it and will refuse it identically
 *               again. A retry wastes an attempt and hides the problem, so
 *               this goes in front of a person.
 *   retry     — nothing conclusive happened: unreachable, timed out, an
 *               application error at the far end. Worth another go.
 *
 * That three-way split is the whole reliability model. Everything else —
 * backoff, attempt caps, dead letters, replay — is the engine acting on it.
 *
 * No transport writes to the database, and none of them throws: a failure is a
 * value, because a thrown error halfway through a delivery leaves a row saying
 * "in flight" for ever.
 */
import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  buildAstmRecords, buildHl7Oru, frameAstmRecords, frameMllp, readHl7Ack, unframeMllp,
  ACK, ENQ, EOT, NAK,
  type OutboundMessage,
} from '../instrumentBridge/protocols.js';
import { TRANSPORT_TIMEOUT_MS } from '../../../shared/constants/middleware.js';
import { lhimsAccepted, lhimsMeasureId, lhimsResultUrl, lhimsSafeUrl } from '../../../shared/constants/lhims.js';
import { openSecret, scrubSecrets } from './secrets.js';

export interface DestinationConfig {
  id: number;
  dest_code: string;
  name: string;
  platform: string;
  transport: string;
  payload_format: string;
  host: string | null;
  port: number | null;
  base_url: string | null;
  use_tls: number;
  username: string | null;
  secret_cipher: string | null;
  auth_scheme: string;
  export_dir: string | null;
  file_template: string | null;
  sending_facility: string | null;
  receiving_facility: string | null;
  receiving_application: string | null;
  ack_policy: string;
  ack_timeout_ms: number;
  transform: string | null;
}

export interface TransportOutcome {
  status: 'delivered' | 'rejected' | 'retry';
  detail: string;
  ackCode?: string | null;
  ackText?: string | null;
  measuredMs: number;
  resultsSent?: number;
  unmapped?: string[];
  /** Where the message ended up, when that is a place: a file, a URL, a port. */
  landedAt?: string | null;
}

export interface DeliveryRequest {
  destination: DestinationConfig;
  /** The canonical message, already mapped for this destination. */
  message: OutboundMessage;
  /** The rendered payload, as the explorer will show it. */
  payload: string;
  /** This delivery's own identifier, used as the protocol control id. */
  controlId: string;
  /** Per-destination LHIMS measure ids, where the transport needs them. */
  measureMap?: Record<string, number> | null;
  lhimsMapKey?: string | null;
}

const ok = (detail: string, measuredMs: number, extra?: Partial<TransportOutcome>): TransportOutcome =>
  ({ status: 'delivered', detail, measuredMs, ...extra });
const refuse = (detail: string, measuredMs: number, extra?: Partial<TransportOutcome>): TransportOutcome =>
  ({ status: 'rejected', detail: scrubSecrets(detail), measuredMs, ...extra });
const again = (detail: string, measuredMs: number, extra?: Partial<TransportOutcome>): TransportOutcome =>
  ({ status: 'retry', detail: scrubSecrets(detail), measuredMs, ...extra });

/* ============================================================================
   Rendering the message
   ----------------------------------------------------------------------------
   Done before any socket is opened, and stored, so the Message Explorer can
   show exactly what was sent and a rejection can be read against it.
   ========================================================================= */
export function renderPayload(destination: DestinationConfig, message: OutboundMessage, controlId: string, rawSource?: string | null): { payload: string; format: string } {
  const header = {
    sendingApplication: 'SECHLIMS',
    sendingFacility: destination.sending_facility || 'SECHLIMS',
    receivingApplication: destination.receiving_application || destination.dest_code,
    receivingFacility: destination.receiving_facility || '',
    controlId,
  };
  switch (destination.payload_format) {
    case 'hl7v2':
      return { payload: buildHl7Oru(message, header), format: 'hl7v2' };
    case 'astm':
      return { payload: buildAstmRecords(message, header).join('\r\n'), format: 'astm' };
    case 'csv': {
      const rows = [['sample_id', 'test_code', 'test_name', 'value', 'unit', 'flag', 'run_at'].join(',')];
      for (const result of message.results) {
        rows.push([
          message.sampleId, result.code, result.name ?? result.code, result.value,
          result.unit ?? '', result.flag ?? '', message.runAt ?? '',
        ].map(csvCell).join(','));
      }
      return { payload: rows.join('\n'), format: 'csv' };
    }
    case 'raw':
      return { payload: String(rawSource ?? ''), format: 'raw' };
    case 'json':
    default:
      return {
        payload: JSON.stringify({
          messageId: controlId,
          sampleId: message.sampleId,
          kind: message.kind ?? 'patient',
          instrument: message.instrument ?? null,
          runAt: message.runAt ?? null,
          results: message.results,
        }, null, 2),
        format: 'json',
      };
  }
}

function csvCell(value: unknown): string {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/* ============================================================================
   The transports
   ========================================================================= */
export async function deliver(request: DeliveryRequest): Promise<TransportOutcome> {
  const started = Date.now();
  try {
    switch (request.destination.transport) {
      case 'internal': return deliverInternal(request, started);
      case 'hl7_mllp': return await deliverMllp(request, started);
      case 'astm_tcp': return await deliverAstm(request, started);
      case 'http_lhims': return await deliverLhims(request, started);
      case 'http_json': return await deliverHttpJson(request, started);
      case 'file_export': return deliverFile(request, started);
      default:
        return refuse(`This destination has no transport the engine knows how to use (${request.destination.transport}).`, Date.now() - started);
    }
  } catch (error) {
    // A transport that throws anyway is still an outcome, never an exception
    // escaping into the engine's loop.
    return again(`${(error as Error).message}`, Date.now() - started);
  }
}

/**
 * SECHLIMS itself.
 *
 * The results are already here — the bridge recorded them before any of this
 * ran. So the delivery records acceptance and transmits nothing, which makes it
 * the honest destination to prove a routing rule against before a clinical
 * system is pointed at.
 */
function deliverInternal(request: DeliveryRequest, started: number): TransportOutcome {
  return ok('Recorded in SECHLIMS. No transmission was required.', Date.now() - started, {
    resultsSent: request.message.results.length,
    landedAt: 'SECHLIMS',
  });
}

/** HL7 v2 over MLLP, with the acknowledgement actually read. */
function deliverMllp(request: DeliveryRequest, started: number): Promise<TransportOutcome> {
  const { destination } = request;
  if (!destination.host || !destination.port) {
    return Promise.resolve(refuse('This destination has no address or port to transmit to.', Date.now() - started));
  }
  const wantsAck = destination.ack_policy === 'protocol_ack';
  const timeout = Math.max(2_000, Number(destination.ack_timeout_ms ?? TRANSPORT_TIMEOUT_MS));
  const where = `${destination.host}:${destination.port}`;

  return new Promise<TransportOutcome>(resolve => {
    let settled = false;
    const finish = (outcome: TransportOutcome) => {
      if (settled) return;
      settled = true;
      try { socket.removeAllListeners(); socket.destroy(); } catch { /* already gone */ }
      resolve(outcome);
    };

    const socket = openSocket(destination);
    let answer = Buffer.alloc(0);

    socket.setTimeout(timeout, () => finish(again(
      wantsAck
        ? `${where} accepted the connection but sent no acknowledgement within ${Math.round(timeout / 1000)} seconds.`
        : `${where} did not answer within ${Math.round(timeout / 1000)} seconds.`,
      Date.now() - started)));
    socket.on('error', error => finish(again(`${where} — ${(error as Error).message}`, Date.now() - started)));

    socket.on('connect', () => {
      socket.write(frameMllp(request.payload), () => {
        if (!wantsAck) {
          // Nothing will be read, so say what is and is not known. The bytes
          // left; whether the destination stored them is not established.
          finish(ok(`Transmitted to ${where}. This destination sends no acknowledgement, so acceptance is not confirmed.`,
            Date.now() - started, { resultsSent: request.message.results.length, landedAt: where }));
        }
      });
    });

    socket.on('data', chunk => {
      if (!wantsAck) return;
      answer = Buffer.concat([answer, chunk]);
      // The far end's acknowledgement ends at FS CR. Waiting for the whole
      // envelope rather than reading the first packet is what stops a long
      // error message being read as a truncated code.
      if (!answer.includes(0x1c)) return;
      const verdict = readHl7Ack(answer);
      if (verdict.accepted) {
        finish(ok(`${where} acknowledged the message (${verdict.code}).`, Date.now() - started, {
          ackCode: verdict.code, ackText: verdict.text, resultsSent: request.message.results.length, landedAt: where,
        }));
      } else if (verdict.rejected) {
        finish(refuse(`${where} rejected the message (${verdict.code}): ${verdict.text || 'no reason given'}.`, Date.now() - started, {
          ackCode: verdict.code, ackText: verdict.text,
        }));
      } else {
        finish(again(`${where} returned ${verdict.code || 'an unrecognised acknowledgement'}: ${verdict.text || unframeMllp(answer).slice(0, 200)}.`,
          Date.now() - started, { ackCode: verdict.code || null, ackText: verdict.text }));
      }
    });

    socket.on('close', () => finish(again(`${where} closed the connection before acknowledging the message.`, Date.now() - started)));
  });
}

/**
 * ASTM E1394 over TCP, handshake and all.
 *
 * ENQ, wait for ACK, send each frame and wait for its ACK, then EOT. A NAK is
 * one repeat of the frame and no more: an analyser-side system that NAKs twice
 * is not going to accept the third attempt either, and sitting in that loop is
 * how a queue stops moving.
 */
function deliverAstm(request: DeliveryRequest, started: number): Promise<TransportOutcome> {
  const { destination } = request;
  if (!destination.host || !destination.port) {
    return Promise.resolve(refuse('This destination has no address or port to transmit to.', Date.now() - started));
  }
  const timeout = Math.max(2_000, Number(destination.ack_timeout_ms ?? TRANSPORT_TIMEOUT_MS));
  const where = `${destination.host}:${destination.port}`;
  const records = request.payload.split(/\r?\n/).filter(line => line.trim());
  const frames = frameAstmRecords(records);

  return new Promise<TransportOutcome>(resolve => {
    let settled = false;
    let index = -1;        // -1 is "ENQ sent, waiting to be allowed to speak"
    let repeats = 0;

    const finish = (outcome: TransportOutcome) => {
      if (settled) return;
      settled = true;
      try { socket.removeAllListeners(); socket.destroy(); } catch { /* already gone */ }
      resolve(outcome);
    };

    const socket = openSocket(destination);
    socket.setTimeout(timeout, () => finish(again(
      index < 0
        ? `${where} did not answer the ENQ within ${Math.round(timeout / 1000)} seconds.`
        : `${where} stopped acknowledging after frame ${index + 1} of ${frames.length}.`,
      Date.now() - started)));
    socket.on('error', error => finish(again(`${where} — ${(error as Error).message}`, Date.now() - started)));
    socket.on('close', () => finish(again(`${where} closed the connection after frame ${Math.max(0, index)} of ${frames.length}.`, Date.now() - started)));

    const sendNext = () => {
      index++;
      if (index >= frames.length) {
        socket.write(Buffer.from([EOT]), () => {
          finish(ok(`${where} acknowledged all ${frames.length} frames.`, Date.now() - started, {
            ackCode: 'ACK', resultsSent: request.message.results.length, landedAt: where,
          }));
        });
        return;
      }
      repeats = 0;
      socket.write(frames[index]);
    };

    socket.on('connect', () => socket.write(Buffer.from([ENQ])));
    socket.on('data', chunk => {
      for (const byte of chunk) {
        if (byte === ACK) { sendNext(); return; }
        if (byte === NAK) {
          if (index < 0) { finish(refuse(`${where} refused the transmission at the handshake.`, Date.now() - started, { ackCode: 'NAK' })); return; }
          if (repeats >= 1) {
            finish(refuse(`${where} refused frame ${index + 1} twice. The message was not accepted.`, Date.now() - started, { ackCode: 'NAK' }));
            return;
          }
          repeats++;
          socket.write(frames[index]);
          return;
        }
      }
    });
  });
}

/**
 * The LHIMS result API, result by result.
 *
 * The same api/update_result.php call the national middleware makes, so a
 * result posted from here lands in the field the middleware would have put it
 * in. A parameter with no measure id is NOT sent and is named instead: LHIMS
 * storing a haemoglobin under whatever id happened to be nearby is far worse
 * than LHIMS not storing it.
 */
async function deliverLhims(request: DeliveryRequest, started: number): Promise<TransportOutcome> {
  const { destination, message } = request;
  if (!destination.base_url || !destination.username) {
    return refuse('This destination has no LHIMS address or username.', Date.now() - started);
  }
  const specimenId = String(message.sampleId ?? '').trim();
  if (!specimenId) return refuse('The message carries no specimen identifier, so LHIMS has nothing to file it under.', Date.now() - started);

  const password = openSecret(destination.secret_cipher);
  if (destination.secret_cipher && password == null) {
    return refuse('The stored credential for this destination could not be read on this host. Re-enter it.', Date.now() - started);
  }
  const credentials = { username: String(destination.username), password: password ?? '' };
  const overrides = request.measureMap ?? {};

  let delivered = 0;
  const unmapped: string[] = [];
  const refused: string[] = [];

  for (const result of message.results) {
    const measureId = lhimsMeasureId(String(result.code ?? ''), overrides, request.lhimsMapKey ?? null);
    if (!measureId) { unmapped.push(String(result.code ?? '?')); continue; }
    const raw = String(result.value ?? '').trim();
    if (!raw) continue;
    const decimals = raw.includes('.') ? Math.min(4, raw.split('.')[1].length) : 0;
    const url = lhimsResultUrl(String(destination.base_url), credentials, { specimenId, measureId, value: raw, decimals });
    const answer = await httpText(url, { timeoutMs: Number(destination.ack_timeout_ms ?? TRANSPORT_TIMEOUT_MS) });
    if (answer.error) { refused.push(`${result.code}: ${answer.error}`); continue; }
    if (lhimsAccepted(answer.body)) delivered++;
    else refused.push(`${result.code}: ${answer.body.slice(0, 60) || 'no answer'}`);
  }

  const notes: string[] = [];
  if (delivered) notes.push(`${delivered} result(s) accepted`);
  if (unmapped.length) notes.push(`no measure id for ${unmapped.slice(0, 8).join(', ')}${unmapped.length > 8 ? '…' : ''}`);
  if (refused.length) notes.push(`refused: ${refused.slice(0, 4).join('; ')}`);
  const detail = notes.join('. ') || 'Nothing in this message could be delivered.';
  const elapsed = Date.now() - started;
  const where = lhimsSafeUrl(String(destination.base_url));

  // Nothing accepted but everything addressed: that is the far end refusing or
  // unreachable, which is worth another go.
  if (delivered === 0 && refused.length) return again(detail, elapsed, { unmapped, landedAt: where });
  // Nothing accepted and nothing even mappable: identical calls will fail
  // identically, and the unmapped codes are named for somebody to fix.
  if (delivered === 0) return refuse(detail, elapsed, { unmapped, landedAt: where });
  return ok(detail, elapsed, { resultsSent: delivered, unmapped, landedAt: where, ackCode: 'ACCEPTED' });
}

/** A JSON envelope posted to a documented endpoint. */
async function deliverHttpJson(request: DeliveryRequest, started: number): Promise<TransportOutcome> {
  const { destination } = request;
  if (!destination.base_url) return refuse('This destination has no URL to post to.', Date.now() - started);

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const secret = openSecret(destination.secret_cipher);
  if (destination.secret_cipher && secret == null) {
    return refuse('The stored credential for this destination could not be read on this host. Re-enter it.', Date.now() - started);
  }
  if (destination.auth_scheme === 'basic' && destination.username) {
    headers.Authorization = `Basic ${Buffer.from(`${destination.username}:${secret ?? ''}`).toString('base64')}`;
  } else if (destination.auth_scheme === 'bearer' && secret) {
    headers.Authorization = `Bearer ${secret}`;
  }
  // The delivery's own identifier, so a destination that implements
  // idempotency can recognise a retry as the same message.
  headers['X-Idempotency-Key'] = request.controlId;

  const answer = await httpText(String(destination.base_url), {
    method: 'POST', headers, body: request.payload,
    timeoutMs: Number(destination.ack_timeout_ms ?? TRANSPORT_TIMEOUT_MS),
  });
  const elapsed = Date.now() - started;
  const where = lhimsSafeUrl(String(destination.base_url));

  if (answer.error) return again(`${where} — ${answer.error}`, elapsed, { landedAt: where });
  const status = answer.status ?? 0;
  if (status >= 200 && status < 300) {
    return ok(`${where} answered ${status}.`, elapsed, {
      ackCode: String(status), ackText: answer.body.slice(0, 400),
      resultsSent: request.message.results.length, landedAt: where,
    });
  }
  // 4xx is the far end saying the message is wrong, which it will say again.
  // 408 and 429 are the exceptions: they are asking for a later attempt.
  if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
    return refuse(`${where} rejected the message with ${status}: ${answer.body.slice(0, 200)}`, elapsed, {
      ackCode: String(status), ackText: answer.body.slice(0, 400), landedAt: where,
    });
  }
  return again(`${where} answered ${status}: ${answer.body.slice(0, 200)}`, elapsed, {
    ackCode: String(status), ackText: answer.body.slice(0, 400), landedAt: where,
  });
}

/**
 * A file, for a system whose only intake is a folder.
 *
 * Written under a temporary name and renamed into place, because a reader
 * watching the folder will otherwise pick up a half-written message and file
 * half a result.
 */
function deliverFile(request: DeliveryRequest, started: number): TransportOutcome {
  const { destination } = request;
  const dir = String(destination.export_dir ?? '').trim();
  if (!dir) return refuse('This destination has no export folder.', Date.now() - started);
  try { fs.mkdirSync(dir, { recursive: true }); }
  catch (error) { return again(`${dir} cannot be written to from this host — ${(error as Error).message}`, Date.now() - started); }

  const extension = destination.payload_format === 'hl7v2' ? 'hl7'
    : destination.payload_format === 'astm' ? 'astm'
    : destination.payload_format === 'csv' ? 'csv'
    : destination.payload_format === 'json' ? 'json' : 'txt';
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
  const template = String(destination.file_template ?? '{sample}-{stamp}.{ext}');
  const name = template
    .replace('{sample}', safeName(request.message.sampleId || 'message'))
    .replace('{stamp}', stamp)
    .replace('{uid}', safeName(request.controlId))
    .replace('{ext}', extension);
  const target = path.join(dir, name);
  const temporary = path.join(dir, `.${name}.part`);

  try {
    fs.writeFileSync(temporary, request.payload, 'latin1');
    fs.renameSync(temporary, target);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch { /* nothing to tidy */ }
    return again(`${target} could not be written — ${(error as Error).message}`, Date.now() - started);
  }
  return ok(`Written to ${target}.`, Date.now() - started, {
    resultsSent: request.message.results.length, landedAt: target, ackCode: 'WRITTEN',
  });
}

function safeName(value: string): string {
  return String(value ?? '').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 64) || 'message';
}

/* ============================================================================
   The two primitives everything above uses
   ========================================================================= */
function openSocket(destination: DestinationConfig): net.Socket {
  const host = String(destination.host);
  const port = Number(destination.port);
  if (destination.use_tls) {
    // `rejectUnauthorized` stays on: a laboratory interface using TLS with a
    // certificate nobody checks has the cost of TLS and none of its value. A
    // host with its own certificate authority installs it on the machine.
    return tls.connect({ host, port, servername: host }) as unknown as net.Socket;
  }
  return net.createConnection({ host, port });
}

async function httpText(url: string, options: {
  method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number;
}): Promise<{ status: number | null; body: string; error: string | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(2_000, options.timeoutMs ?? TRANSPORT_TIMEOUT_MS));
  try {
    const response = await fetch(url, {
      method: options.method ?? 'GET',
      headers: options.headers,
      body: options.body,
      signal: controller.signal,
    });
    return { status: response.status, body: (await response.text()).trim(), error: null };
  } catch (error) {
    // The safe URL, so a password in a query string never reaches a log.
    return { status: null, body: '', error: `${lhimsSafeUrl(url)} — ${(error as Error).message}` };
  } finally {
    clearTimeout(timer);
  }
}

/** A stable identifier for a payload, for the explorer and for duplicate checks. */
export function payloadHash(payload: string): string {
  return crypto.createHash('sha256').update(String(payload ?? ''), 'utf8').digest('hex').slice(0, 32);
}
