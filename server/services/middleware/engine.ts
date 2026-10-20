/**
 * The middleware engine.
 *
 * The analyser bridge receives a transmission and writes down what the machine
 * said. This decides where it goes, carries it there, and can account for it
 * afterwards:
 *
 *   ingest → normalise → validate → route → map → queue → transmit
 *          → acknowledge → outcome
 *
 * Three decisions shape everything below.
 *
 * ONE: the source message is never rewritten. `instrument_messages` holds what
 * arrived, and a row here points at it. A message routed to four destinations,
 * failed at two of them and replayed twice still has exactly one original.
 *
 * TWO: a DELIVERY is the unit of reliability, not a message. One row per
 * (message, destination), with its own attempts, its own acknowledgement and
 * its own outcome — which is what makes "the hospital system has it, the
 * research database does not" expressible at all. A destination failing cannot
 * mark another's delivery successful, because they are different rows.
 *
 * THREE: at-least-once, with idempotency, and no pretending otherwise. Every
 * delivery carries a key unique to its destination, so a retry or an authorised
 * replay is the same delivery attempted again and never a second result. What
 * this cannot control is a destination that acknowledges a message and then
 * loses it, or stores it and then fails to acknowledge — so duplicates are made
 * DETECTABLE here and reconcilable there, and exactly-once is not claimed.
 *
 * Restart safety: a delivery marked in flight when the host stopped is picked
 * back up rather than lost, because the transmission may never have happened —
 * and an unsent result is a worse failure than a duplicate that can be seen.
 */
import crypto from 'node:crypto';
import {
  ENGINE_BATCH, ENGINE_TICK_MS, IN_FLIGHT_STALE_MS,
  deliveryIsConfirmable, deliveryIsReplayable, queueTone, retryDelayMs, routeMatches,
  validateMessage, validationBlocks,
  type NormalisedMessage, type NormalisedResult, type RouteCriteria, type ValidationFinding,
} from '../../../shared/constants/middleware.js';
import { mapAnalyte, profileByKey } from '../../../shared/constants/instruments.js';
import { uuid } from '../../utils/uuid.js';
import { deliver, payloadHash, renderPayload, type DestinationConfig } from './transports.js';
import { routeIsSafe } from './safety.js';
import { scrubSecrets } from './secrets.js';

type DB = any;
type DbGetter = () => DB;

/** What the bridge hands over once it has recorded a transmission. */
export interface IngestEnvelope {
  linkId: number | null;
  instrumentMessageId: number | null;
  protocol: string | null;
  kind: string;
  sampleId: string | null;
  lotNumber: string | null;
  instrument: string | null;
  runAt: string | null;
  results: Array<{ analyte?: string | null; code: string; value: string; unit?: string | null; flag?: string | null }>;
  raw: string | null;
  source?: 'bridge' | 'simulator' | 'replay';
}

export interface IngestOutcome {
  ok: boolean;
  messageId: number | null;
  messageUid: string | null;
  status: string;
  duplicate: boolean;
  routesMatched: number;
  deliveries: number;
  validation: ValidationFinding[];
  note: string;
}

function json<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try { return (JSON.parse(value) ?? fallback) as T; } catch { return fallback; }
}

/* ============================================================================
   The engine
   ========================================================================= */
export class MiddlewareEngine {
  private getDb: DbGetter;
  private timer: NodeJS.Timeout | null = null;
  private draining = false;
  private started = false;

  constructor(getDb: DbGetter) { this.getDb = getDb; }

  /**
   * Start the one timer that moves the queue.
   *
   * One timer for every destination rather than a timer each: a laboratory with
   * six destinations should not be running six clocks, and one destination's
   * sweep throwing must not stop the others.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.recover();
    this.timer = setInterval(() => { void this.tick(); }, ENGINE_TICK_MS);
    if (this.timer.unref) this.timer.unref();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.started = false;
  }

  isRunning(): boolean { return this.started; }

  /**
   * Pick up what the last run of this host left behind.
   *
   * A delivery recorded as in flight when the process stopped may or may not
   * have reached its destination. It is put back in the queue, because the
   * alternative is a result that silently never arrives — and the idempotency
   * key means the destination can recognise the repeat.
   */
  recover(): { reclaimed: number } {
    try {
      const cutoff = new Date(Date.now() - IN_FLIGHT_STALE_MS).toISOString().replace('T', ' ').slice(0, 19);
      const result = this.getDb().prepare(`UPDATE mw_deliveries
          SET state = 'retrying', next_attempt_at = CURRENT_TIMESTAMP,
              error = COALESCE(error, 'The host stopped while this delivery was in flight. It has been put back in the queue.'),
              updated_at = CURRENT_TIMESTAMP
          WHERE state = 'in_flight' AND (last_attempt_at IS NULL OR last_attempt_at <= ?)`).run(cutoff);
      const reclaimed = Number(result?.changes ?? 0);
      if (reclaimed) console.log(`[middleware] ${reclaimed} delivery(ies) reclaimed after restart`);
      return { reclaimed };
    } catch { return { reclaimed: 0 }; }
  }

  /* ========================================================================
     Ingestion
     ====================================================================== */

  /**
   * Take one transmission into the middleware.
   *
   * Everything is written down before anything is attempted: the normalised
   * message, the validation findings, the routes that matched and one queued
   * delivery for each. A host that dies immediately after this call loses
   * nothing, because the queue is in the database and not in this process.
   */
  ingest(envelope: IngestEnvelope): IngestOutcome {
    const db = this.getDb();
    const normalised = this.normalise(db, envelope);
    const findings = validateMessage(normalised);
    const dedupe = this.dedupeKey(envelope, normalised);

    // The same transmission ingested twice is one message. A transmission SENT
    // twice carries a different run time or different values and so a different
    // key — the same distinction the bridge makes, for the same reason: a
    // control run recorded twice puts a point on a chart that never happened.
    if (dedupe) {
      const seen = db.prepare('SELECT id, message_uid, status FROM mw_messages WHERE link_id IS ? AND dedupe_key = ?')
        .get(envelope.linkId, dedupe) as any;
      if (seen) {
        this.trace(db, { messageId: Number(seen.id), stage: 'ingest', outcome: 'info', detail: 'This transmission had already been ingested, so it was not routed again.' });
        return {
          ok: true, messageId: Number(seen.id), messageUid: String(seen.message_uid), status: String(seen.status),
          duplicate: true, routesMatched: 0, deliveries: 0, validation: findings,
          note: 'Already ingested. The existing message and its deliveries stand.',
        };
      }
    }

    const messageUid = uuid();
    const link = envelope.linkId == null ? null
      : db.prepare('SELECT id, section_id, profile_key FROM instrument_links WHERE id = ?').get(envelope.linkId) as any;

    let messageId = 0;
    try {
      const inserted = db.prepare(`INSERT INTO mw_messages
          (message_uid, link_id, instrument_message_id, source, protocol, kind, sample_id, lot_number,
           instrument_name, instrument_run_at, section_id, result_count, normalised, validation, status, dedupe_key)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(messageUid, envelope.linkId, envelope.instrumentMessageId, envelope.source ?? 'bridge',
          envelope.protocol, normalised.kind, normalised.sampleId, normalised.lotNumber,
          normalised.instrument, normalised.runAt, link?.section_id ?? null,
          normalised.results.length, JSON.stringify(normalised), JSON.stringify(findings),
          'ingested', dedupe);
      messageId = Number(inserted.lastInsertRowid);
    } catch (error) {
      return {
        ok: false, messageId: null, messageUid: null, status: 'failed', duplicate: false,
        routesMatched: 0, deliveries: 0, validation: findings,
        note: `The message could not be recorded: ${(error as Error).message}`,
      };
    }

    this.trace(db, { messageId, stage: 'ingest', outcome: 'ok', detail: `Ingested from ${envelope.source ?? 'bridge'}${envelope.linkId ? ` on link ${envelope.linkId}` : ''}.` });
    this.trace(db, { messageId, stage: 'normalise', outcome: 'ok', detail: `${normalised.results.length} result(s) normalised as ${normalised.kind}.` });

    const errors = findings.filter(f => f.severity === 'error');
    const warnings = findings.filter(f => f.severity === 'warning');
    for (const warning of warnings) {
      this.trace(db, { messageId, stage: 'validate', outcome: 'warn', detail: `${warning.field}: ${warning.detail}` });
    }

    if (validationBlocks(findings)) {
      this.setMessageStatus(db, messageId, 'invalid');
      this.trace(db, { messageId, stage: 'validate', outcome: 'error', detail: errors.map(e => e.detail).join(' ') });
      return {
        ok: false, messageId, messageUid, status: 'invalid', duplicate: false,
        routesMatched: 0, deliveries: 0, validation: findings,
        note: errors.map(e => e.detail).join(' '),
      };
    }
    this.trace(db, { messageId, stage: 'validate', outcome: 'ok', detail: 'The message carries an identifier and at least one result.' });

    const queued = this.route(db, { messageId, normalised, envelope, profileKey: link?.profile_key ?? null, sectionId: link?.section_id ?? null });
    return {
      ok: true, messageId, messageUid,
      status: queued.deliveries ? 'routed' : 'no_route',
      duplicate: false, routesMatched: queued.routesMatched, deliveries: queued.deliveries,
      validation: findings, note: queued.note,
    };
  }

  /* ========================================================================
     Normalisation
     ====================================================================== */

  /**
   * One canonical shape, whatever arrived.
   *
   * The analyser's own mnemonic is kept alongside the laboratory's name for the
   * analyte, because a destination mapping is written against the mnemonic and
   * a person reads the name. Losing either is what makes a mapping screen
   * guesswork.
   */
  private normalise(db: DB, envelope: IngestEnvelope): NormalisedMessage {
    const link = envelope.linkId == null ? null
      : db.prepare('SELECT analyte_map, profile_key FROM instrument_links WHERE id = ?').get(envelope.linkId) as any;
    const linkMap = json<Record<string, string>>(link?.analyte_map, {});
    const results: NormalisedResult[] = (envelope.results ?? [])
      .filter(result => String(result.code ?? '').trim())
      .map(result => ({
        code: String(result.code).trim(),
        analyte: String(result.analyte ?? '').trim() || mapAnalyte(String(result.code), linkMap, link?.profile_key ?? null),
        value: String(result.value ?? '').trim(),
        unit: result.unit ? String(result.unit).trim() : null,
        flag: result.flag ? String(result.flag).trim() : null,
      }));
    return {
      sampleId: envelope.sampleId ? String(envelope.sampleId).trim() : null,
      lotNumber: envelope.lotNumber ? String(envelope.lotNumber).trim() : null,
      instrument: envelope.instrument ? String(envelope.instrument).trim() : null,
      runAt: envelope.runAt ? String(envelope.runAt) : null,
      kind: envelope.kind || 'unknown',
      results,
    };
  }

  /**
   * What makes this transmission itself.
   *
   * Of what the analyser SAID — which sample, which machine, which moment,
   * which values — rather than of the bytes, so a client that changed how it
   * writes its log is still recognised as having said the same thing twice.
   */
  private dedupeKey(envelope: IngestEnvelope, normalised: NormalisedMessage): string | null {
    if (!normalised.sampleId && !normalised.results.length) return null;
    const material = JSON.stringify([
      normalised.sampleId, normalised.lotNumber, normalised.instrument, normalised.runAt,
      normalised.results.map(r => [r.code, r.value]).sort(),
    ]);
    return crypto.createHash('sha256').update(material).digest('hex').slice(0, 32);
  }

  /* ========================================================================
     Routing
     ====================================================================== */

  /**
   * Which destinations want this message, and a queued delivery for each.
   *
   * Every matching rule produces its own delivery. Rules are taken in priority
   * order so a laboratory can put a specific rule in front of a general one,
   * and `stop_on_match` exists for the case where one destination is meant to
   * take a class of message exclusively.
   */
  private route(db: DB, context: {
    messageId: number; normalised: NormalisedMessage; envelope: IngestEnvelope;
    profileKey: string | null; sectionId: number | null;
  }): { routesMatched: number; deliveries: number; note: string } {
    let rules: any[] = [];
    try {
      rules = db.prepare(`SELECT r.*, d.id AS dest_id, d.name AS dest_name, d.state AS dest_state,
            d.is_active AS dest_active, d.is_protected AS dest_protected, d.auto_deliver,
            d.retry_max, d.ack_policy
          FROM mw_routes r JOIN mw_destinations d ON d.id = r.destination_id
          WHERE r.is_active = 1 ORDER BY r.priority, r.id`).all() as any[];
    } catch { rules = []; }

    const candidate = {
      linkId: context.envelope.linkId,
      profileKey: context.profileKey,
      kind: context.normalised.kind,
      sectionId: context.sectionId,
      facility: null as string | null,
      department: null as string | null,
      codes: context.normalised.results.map(r => r.code),
    };

    let matched = 0;
    let queued = 0;
    const skipped: string[] = [];

    for (const rule of rules) {
      const criteria: RouteCriteria = {
        sourceLinkId: rule.source_link_id ?? null,
        sourceProfileKey: rule.source_profile_key ?? null,
        messageKind: rule.message_kind ?? 'any',
        testCodes: json<string[]>(rule.test_codes, []),
        sectionId: rule.section_id ?? null,
        facility: rule.facility ?? null,
        department: rule.department ?? null,
      };
      if (!routeMatches(criteria, candidate)) continue;
      matched++;

      // The safety rules again, at the moment of routing rather than only when
      // the rule was written: a destination may have been marked protected, or
      // a link re-recorded as LHIMS's, since.
      const verdict = routeIsSafe(db, context.envelope.linkId, Number(rule.dest_id));
      if (!verdict.ok) {
        skipped.push(`${rule.dest_name}: ${verdict.reason}`);
        this.trace(db, {
          messageId: context.messageId, destinationId: Number(rule.dest_id), stage: 'route', outcome: 'warn',
          detail: `Not queued for ${rule.dest_name} — ${verdict.reason}`,
        });
        continue;
      }
      if (!rule.dest_active) {
        skipped.push(`${rule.dest_name} is switched off.`);
        continue;
      }
      if (rule.dest_state !== 'active' && rule.dest_state !== 'degraded' && rule.dest_state !== 'testing') {
        skipped.push(`${rule.dest_name} is ${rule.dest_state} rather than active, so nothing was queued for it.`);
        this.trace(db, {
          messageId: context.messageId, destinationId: Number(rule.dest_id), stage: 'route', outcome: 'warn',
          detail: `${rule.dest_name} is ${rule.dest_state}. A destination receives clinical traffic only once it is active.`,
        });
        continue;
      }

      const created = this.enqueue(db, {
        messageId: context.messageId,
        destinationId: Number(rule.dest_id),
        routeId: Number(rule.id),
        maxAttempts: Number(rule.retry_max ?? 6),
        ackExpected: deliveryIsConfirmable(rule.ack_policy),
      });
      if (created) queued++;
      if (rule.stop_on_match) break;
    }

    this.setMessageStatus(db, context.messageId, queued ? 'routed' : 'no_route', matched);
    const note = queued
      ? `${queued} delivery(ies) queued across ${queued === matched ? 'every' : matched} matching rule(s).`
      : matched
        ? `${matched} rule(s) matched but nothing was queued. ${skipped.join(' ')}`.trim()
        : 'No routing rule covers this message, so it is held in SECHLIMS and transmitted nowhere.';
    this.trace(db, {
      messageId: context.messageId, stage: 'route', outcome: queued ? 'ok' : 'warn', detail: note,
    });
    return { routesMatched: matched, deliveries: queued, note };
  }

  /**
   * One queued delivery.
   *
   * The idempotency key is the message and the destination, so re-routing the
   * same message to the same destination cannot create a second delivery —
   * which is the database refusing to let the engine send a result twice,
   * rather than the engine remembering not to.
   */
  private enqueue(db: DB, options: {
    messageId: number; destinationId: number; routeId: number | null;
    maxAttempts: number; ackExpected: boolean;
  }): boolean {
    const message = db.prepare('SELECT message_uid FROM mw_messages WHERE id = ?').get(options.messageId) as any;
    const key = `${message?.message_uid ?? options.messageId}:${options.destinationId}`;
    try {
      db.prepare(`INSERT INTO mw_deliveries
          (delivery_uid, message_id, destination_id, route_id, idempotency_key, state,
           max_attempts, next_attempt_at, ack_expected)
          VALUES (?, ?, ?, ?, ?, 'queued', ?, CURRENT_TIMESTAMP, ?)`)
        .run(uuid(), options.messageId, options.destinationId, options.routeId, key,
          Math.max(1, options.maxAttempts), options.ackExpected ? 1 : 0);
    } catch {
      // The unique constraint did its job: this message is already queued for
      // this destination, and that is the correct outcome, not an error.
      return false;
    }
    const delivery = db.prepare('SELECT id FROM mw_deliveries WHERE destination_id = ? AND idempotency_key = ?')
      .get(options.destinationId, key) as any;
    this.trace(db, {
      messageId: options.messageId, deliveryId: Number(delivery?.id ?? 0), destinationId: options.destinationId,
      stage: 'queue', outcome: 'ok',
      detail: options.ackExpected
        ? 'Queued. This destination acknowledges, so delivery will be confirmed.'
        : 'Queued. This destination sends no acknowledgement, so delivery can be transmitted but not confirmed.',
    });
    return true;
  }

  /* ========================================================================
     Delivery
     ====================================================================== */

  /** One sweep: everything due, up to a batch. */
  async tick(): Promise<{ attempted: number; delivered: number; failed: number }> {
    if (this.draining) return { attempted: 0, delivered: 0, failed: 0 };
    this.draining = true;
    const summary = { attempted: 0, delivered: 0, failed: 0 };
    try {
      const db = this.getDb();
      let due: any[] = [];
      try {
        due = db.prepare(`SELECT v.* FROM mw_deliveries v
            JOIN mw_destinations d ON d.id = v.destination_id
            WHERE v.state IN ('queued', 'retrying')
              AND (v.next_attempt_at IS NULL OR v.next_attempt_at <= CURRENT_TIMESTAMP)
              AND d.is_active = 1 AND d.auto_deliver = 1 AND d.is_protected = 0
            ORDER BY v.next_attempt_at, v.id LIMIT ?`).all(ENGINE_BATCH) as any[];
      } catch { due = []; }

      for (const delivery of due) {
        summary.attempted++;
        // One delivery failing is one delivery's problem. The loop must finish.
        try {
          const outcome = await this.attempt(db, Number(delivery.id));
          if (outcome === 'delivered') summary.delivered++;
          else if (outcome === 'failed') summary.failed++;
        } catch (error) {
          console.error(`[middleware] delivery ${delivery.id}:`, (error as Error).message);
        }
      }
    } finally {
      this.draining = false;
    }
    return summary;
  }

  /**
   * One attempt at one delivery.
   *
   * Claimed first — set to in flight with the attempt counted — so two sweeps,
   * or a sweep and an operator pressing "send now", cannot transmit the same
   * message twice in parallel.
   */
  async attempt(db: DB, deliveryId: number): Promise<'delivered' | 'retry' | 'failed' | 'skipped'> {
    const row = db.prepare(`SELECT v.*, m.normalised, m.sample_id, m.kind, m.instrument_name, m.instrument_run_at,
          m.message_uid, m.link_id, m.instrument_message_id
        FROM mw_deliveries v JOIN mw_messages m ON m.id = v.message_id WHERE v.id = ?`).get(deliveryId) as any;
    if (!row) return 'skipped';
    if (row.state === 'in_flight') return 'skipped';

    const destination = db.prepare('SELECT * FROM mw_destinations WHERE id = ?').get(row.destination_id) as DestinationConfig & { is_protected: number; is_active: number };
    if (!destination) {
      this.settle(db, row, { status: 'rejected', detail: 'The destination no longer exists.', measuredMs: 0 });
      return 'failed';
    }
    if (destination.is_protected) {
      // Belt and braces: the query above excludes protected destinations, and
      // this refuses one that became protected since the row was read.
      this.settle(db, row, { status: 'rejected', detail: 'This destination is a protected production connection. The engine does not transmit over it.', measuredMs: 0 });
      return 'failed';
    }

    const attempt = Number(row.attempt ?? 0) + 1;
    db.prepare(`UPDATE mw_deliveries SET state = 'in_flight', attempt = ?, last_attempt_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(attempt, deliveryId);

    const normalised = json<NormalisedMessage>(row.normalised, { sampleId: null, lotNumber: null, instrument: null, runAt: null, kind: 'unknown', results: [] });
    const mapped = this.applyMapping(db, Number(row.destination_id), normalised);

    if (!mapped.results.length) {
      const detail = mapped.unmapped.length
        ? `Nothing could be mapped for this destination. Unmapped: ${mapped.unmapped.slice(0, 10).join(', ')}.`
        : 'This message carries no result this destination can accept.';
      this.trace(db, { messageId: Number(row.message_id), deliveryId, destinationId: Number(row.destination_id), stage: 'map', outcome: 'error', detail });
      this.settle(db, { ...row, attempt }, { status: 'rejected', detail, measuredMs: 0, unmapped: mapped.unmapped });
      return 'failed';
    }
    if (mapped.unmapped.length) {
      this.trace(db, {
        messageId: Number(row.message_id), deliveryId, destinationId: Number(row.destination_id), stage: 'map', outcome: 'warn',
        detail: `${mapped.results.length} result(s) mapped; no mapping for ${mapped.unmapped.slice(0, 10).join(', ')}. These are not sent.`,
      });
    } else {
      this.trace(db, {
        messageId: Number(row.message_id), deliveryId, destinationId: Number(row.destination_id), stage: 'map', outcome: 'ok',
        detail: `${mapped.results.length} result(s) mapped for this destination.`,
      });
    }

    const outbound = {
      sampleId: String(normalised.sampleId ?? ''),
      patientId: null,
      runAt: normalised.runAt ?? row.instrument_run_at ?? null,
      instrument: normalised.instrument ?? row.instrument_name ?? null,
      kind: normalised.kind,
      results: mapped.results.map(result => ({
        code: result.targetCode || result.code,
        name: result.analyte,
        value: result.value,
        unit: result.unit,
        flag: result.flag,
      })),
    };

    const source = row.instrument_message_id
      ? (db.prepare('SELECT raw_message FROM instrument_messages WHERE id = ?').get(row.instrument_message_id) as any)?.raw_message ?? null
      : null;
    const rendered = renderPayload(destination, outbound, String(row.delivery_uid), source);
    const transform = json<Record<string, unknown>>(destination.transform, {});

    this.trace(db, {
      messageId: Number(row.message_id), deliveryId, destinationId: Number(row.destination_id), stage: 'transmit', outcome: 'info',
      detail: `Attempt ${attempt} of ${row.max_attempts} as ${rendered.format} over ${destination.transport}.`,
    });

    const outcome = await deliver({
      destination,
      message: outbound,
      payload: rendered.payload,
      controlId: String(row.delivery_uid),
      measureMap: (transform.measureMap as Record<string, number>) ?? null,
      lhimsMapKey: (transform.lhimsMapKey as string) ?? null,
    });

    db.prepare('UPDATE mw_deliveries SET payload = ?, payload_format = ?, payload_hash = ? WHERE id = ?')
      .run(rendered.payload.slice(0, 60_000), rendered.format, payloadHash(rendered.payload), deliveryId);

    this.settle(db, { ...row, attempt }, { ...outcome, unmapped: outcome.unmapped ?? mapped.unmapped },
      { baseMs: (destination as any).retry_base_ms, factor: (destination as any).retry_factor });
    return outcome.status === 'delivered' ? 'delivered'
      : outcome.status === 'rejected' ? 'failed'
      : attempt >= Number(row.max_attempts ?? 6) ? 'failed' : 'retry';
  }

  /**
   * What the attempt means for the delivery.
   *
   * The distinction the whole queue turns on. A REJECTION will be rejected
   * identically for ever: it goes to the dead-letter queue now, where a person
   * can see it, instead of burning five more attempts first. A retry has
   * another go until the cap, and the cap is real — a delivery that has failed
   * six times is a configuration problem, and retrying it for ever hides that
   * from the laboratory rather than solving it.
   */
  private settle(db: DB, delivery: any, outcome: {
    status: 'delivered' | 'rejected' | 'retry'; detail: string;
    ackCode?: string | null; ackText?: string | null; measuredMs: number;
    resultsSent?: number; unmapped?: string[]; landedAt?: string | null;
  }, retry?: { baseMs?: number | null; factor?: number | null }): void {
    const deliveryId = Number(delivery.id);
    const messageId = Number(delivery.message_id);
    const destinationId = Number(delivery.destination_id);
    const attempt = Number(delivery.attempt ?? 1);
    const maxAttempts = Number(delivery.max_attempts ?? 6);
    const detail = scrubSecrets(outcome.detail);

    if (outcome.status === 'delivered') {
      db.prepare(`UPDATE mw_deliveries SET state = 'delivered', delivered_at = CURRENT_TIMESTAMP,
          ack_code = ?, ack_text = ?, ack_at = CASE WHEN ? IS NULL THEN ack_at ELSE CURRENT_TIMESTAMP END,
          results_sent = ?, results_unmapped = ?, error = NULL, dead_letter_reason = NULL,
          next_attempt_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(outcome.ackCode ?? null, outcome.ackText ?? null, outcome.ackCode ?? null,
          Number(outcome.resultsSent ?? 0), outcome.unmapped?.length ? JSON.stringify(outcome.unmapped) : null, deliveryId);
      this.trace(db, { messageId, deliveryId, destinationId, stage: 'acknowledge', outcome: 'ok', detail, durationMs: outcome.measuredMs });
      this.trace(db, { messageId, deliveryId, destinationId, stage: 'outcome', outcome: 'ok', detail: outcome.landedAt ? `Delivered to ${outcome.landedAt}.` : 'Delivered.' });
      this.touchDestination(db, destinationId, true, null);
    } else if (outcome.status === 'rejected') {
      db.prepare(`UPDATE mw_deliveries SET state = 'dead_letter', error = ?, dead_letter_reason = ?,
          ack_code = ?, ack_text = ?, next_attempt_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(detail, 'The destination refused this message, and would refuse it again.',
          outcome.ackCode ?? null, outcome.ackText ?? null, deliveryId);
      this.trace(db, { messageId, deliveryId, destinationId, stage: 'outcome', outcome: 'error', detail: `Rejected and moved to the dead-letter queue. ${detail}`, durationMs: outcome.measuredMs });
      this.touchDestination(db, destinationId, false, detail);
    } else if (attempt >= maxAttempts) {
      db.prepare(`UPDATE mw_deliveries SET state = 'dead_letter', error = ?, dead_letter_reason = ?,
          next_attempt_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(detail, `Abandoned after ${attempt} attempt(s).`, deliveryId);
      this.trace(db, { messageId, deliveryId, destinationId, stage: 'outcome', outcome: 'error', detail: `Abandoned after ${attempt} attempt(s) and moved to the dead-letter queue. ${detail}`, durationMs: outcome.measuredMs });
      this.touchDestination(db, destinationId, false, detail);
    } else {
      // The DESTINATION's own schedule, not a global one. A hospital system that
      // restarts in seconds and a regional registry that comes back in the
      // morning do not want the same backoff, and the setting existed while
      // the engine quietly ignored it.
      const delay = retryDelayMs(attempt, {
        seed: deliveryId,
        baseMs: retry?.baseMs ?? null,
        factor: retry?.factor ?? null,
      });
      const when = new Date(Date.now() + delay).toISOString().replace('T', ' ').slice(0, 19);
      db.prepare(`UPDATE mw_deliveries SET state = 'retrying', error = ?, next_attempt_at = ?,
          updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(detail, when, deliveryId);
      this.trace(db, {
        messageId, deliveryId, destinationId, stage: 'transmit', outcome: 'warn',
        detail: `${detail} Attempt ${attempt} of ${maxAttempts}; next attempt in ${Math.round(delay / 1000)} second(s).`,
        durationMs: outcome.measuredMs,
      });
      this.touchDestination(db, destinationId, false, detail);
    }
    this.refreshMessageStatus(db, messageId);
  }

  /**
   * The message's own status, from its deliveries.
   *
   * Derived rather than set, so "delivered to the hospital system, dead-lettered
   * at the research database" reads as PARTLY delivered — and no single
   * destination failing can make the message look lost, nor one succeeding make
   * it look complete.
   */
  private refreshMessageStatus(db: DB, messageId: number): void {
    const counts = db.prepare(`SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN state = 'delivered' THEN 1 ELSE 0 END) AS delivered,
        SUM(CASE WHEN state IN ('dead_letter', 'cancelled') THEN 1 ELSE 0 END) AS stopped
      FROM mw_deliveries WHERE message_id = ?`).get(messageId) as any;
    const total = Number(counts?.total ?? 0);
    if (!total) return;
    const delivered = Number(counts?.delivered ?? 0);
    const stopped = Number(counts?.stopped ?? 0);
    const status = delivered === total ? 'complete'
      : delivered > 0 ? 'partial'
      : stopped === total ? 'failed'
      : 'routed';
    this.setMessageStatus(db, messageId, status);
  }

  private setMessageStatus(db: DB, messageId: number, status: string, routesMatched?: number): void {
    try {
      if (routesMatched == null) {
        db.prepare('UPDATE mw_messages SET status = ? WHERE id = ?').run(status, messageId);
      } else {
        db.prepare('UPDATE mw_messages SET status = ?, routes_matched = ? WHERE id = ?').run(status, routesMatched, messageId);
      }
    } catch { /* the status is a summary; the deliveries are the record */ }
  }

  /**
   * A destination's own health, from how its deliveries are actually going.
   *
   * `degraded` rather than `failed` on a single refusal: one message a system
   * will not accept is a mapping problem, and marking the whole interface
   * failed would stop every other result going through it.
   */
  private touchDestination(db: DB, destinationId: number, success: boolean, error: string | null): void {
    try {
      if (success) {
        db.prepare(`UPDATE mw_destinations SET last_delivery_at = CURRENT_TIMESTAMP, last_error = NULL,
            state = CASE WHEN state IN ('degraded', 'disconnected', 'failed') THEN 'active' ELSE state END,
            state_detail = CASE WHEN state IN ('degraded', 'disconnected', 'failed') THEN 'Delivering again.' ELSE state_detail END,
            updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(destinationId);
        return;
      }
      db.prepare(`UPDATE mw_destinations SET last_error = ?,
          state = CASE WHEN state = 'active' THEN 'degraded' ELSE state END,
          state_detail = CASE WHEN state = 'active' THEN 'A delivery failed. Open Connection Diagnostics.' ELSE state_detail END,
          updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(error, destinationId);
    } catch { /* health is a summary */ }
  }

  /* ========================================================================
     Mapping
     ====================================================================== */

  /**
   * What this destination calls each result, and in what unit.
   *
   * A code with no mapping is NOT sent, and is named. A destination filing a
   * haemoglobin under whatever code happened to be nearby is far worse than one
   * not filing it, so the unmapped codes travel with the delivery and appear on
   * the screen instead.
   *
   * A destination with no mappings at all passes everything through unchanged,
   * which is what a system that already speaks the analyser's codes wants —
   * and a mapping marked required is the way to say "this destination must
   * receive this test", which fails the delivery loudly if it is missing.
   */
  applyMapping(db: DB, destinationId: number, message: NormalisedMessage): { results: NormalisedResult[]; unmapped: string[] } {
    let rows: any[] = [];
    try { rows = db.prepare('SELECT * FROM mw_mappings WHERE destination_id = ? AND is_active = 1').all(destinationId) as any[]; }
    catch { rows = []; }

    const byCode = new Map<string, any>();
    for (const row of rows) byCode.set(String(row.source_code).trim().toUpperCase(), row);

    const results: NormalisedResult[] = [];
    const unmapped: string[] = [];

    for (const result of message.results) {
      if (!String(result.value ?? '').trim()) continue;
      const mapping = byCode.get(String(result.code).trim().toUpperCase());
      if (!mapping) {
        // No mapping table at all is pass-through. A table that exists and does
        // not name this code is a deliberate omission, and is treated as one.
        if (!rows.length) { results.push({ ...result, mapped: false, targetCode: result.code }); continue; }
        unmapped.push(result.code);
        continue;
      }
      results.push({
        code: result.code,
        analyte: mapping.target_name || result.analyte,
        value: convertValue(result.value, mapping),
        unit: mapping.target_unit || result.unit,
        flag: mapValue(result.flag, mapping),
        mapped: true,
        targetCode: mapping.target_code || result.code,
      });
    }

    // A required mapping with nothing to map is the destination's own rule
    // being broken, and it is worth saying which test is missing.
    for (const row of rows) {
      if (!row.is_required) continue;
      const present = results.some(r => String(r.code).toUpperCase() === String(row.source_code).toUpperCase());
      if (!present) unmapped.push(`${row.source_code} (required by this destination)`);
    }
    return { results, unmapped };
  }

  /* ========================================================================
     Operator actions
     ====================================================================== */

  /**
   * Send one delivery now, rather than waiting for its turn.
   *
   * For the person who has just fixed the thing that was wrong. It claims the
   * row the same way a sweep does, so "send now" twice in quick succession is
   * one transmission.
   */
  async sendNow(deliveryId: number, userId: number | null): Promise<{ ok: boolean; state: string; note: string }> {
    const db = this.getDb();
    const row = db.prepare('SELECT * FROM mw_deliveries WHERE id = ?').get(deliveryId) as any;
    if (!row) return { ok: false, state: 'missing', note: 'That delivery no longer exists.' };
    if (row.state === 'delivered') return { ok: false, state: row.state, note: 'This delivery has already been accepted.' };
    if (row.state === 'in_flight') return { ok: false, state: row.state, note: 'This delivery is being attempted now.' };

    this.trace(db, { messageId: Number(row.message_id), deliveryId, destinationId: Number(row.destination_id), stage: 'transmit', outcome: 'info', detail: 'Attempted on request.', actorUserId: userId });
    await this.attempt(db, deliveryId);
    const after = db.prepare('SELECT state, error FROM mw_deliveries WHERE id = ?').get(deliveryId) as any;
    return {
      ok: after?.state === 'delivered',
      state: String(after?.state ?? 'unknown'),
      note: after?.state === 'delivered' ? 'Delivered.' : String(after?.error ?? 'The attempt did not succeed.'),
    };
  }

  /**
   * Replay a delivery that stopped.
   *
   * The SAME delivery, attempted again from zero — not a new one. That is what
   * keeps the idempotency key meaningful: a destination that recognises the key
   * can tell a replay from a second result, and the laboratory has one row per
   * (message, destination) however many times it was tried.
   */
  replay(deliveryId: number, userId: number | null, reason?: string | null): { ok: boolean; note: string } {
    const db = this.getDb();
    const row = db.prepare('SELECT * FROM mw_deliveries WHERE id = ?').get(deliveryId) as any;
    if (!row) return { ok: false, note: 'That delivery no longer exists.' };
    if (!deliveryIsReplayable(row.state)) {
      return { ok: false, note: `A delivery that is ${row.state} is not replayed. Only a dead-lettered, rejected or cancelled delivery is.` };
    }
    const destination = db.prepare('SELECT is_protected, is_active, state, name FROM mw_destinations WHERE id = ?').get(row.destination_id) as any;
    if (destination?.is_protected) return { ok: false, note: `${destination.name} is a protected production connection. The engine does not transmit over it.` };
    if (!destination?.is_active) return { ok: false, note: `${destination?.name ?? 'That destination'} is switched off.` };

    db.prepare(`UPDATE mw_deliveries SET state = 'queued', attempt = 0, next_attempt_at = CURRENT_TIMESTAMP,
        error = NULL, dead_letter_reason = NULL, ack_code = NULL, ack_text = NULL, ack_at = NULL,
        replay_count = replay_count + 1, replayed_by = ?, replayed_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(userId ?? null, deliveryId);
    this.trace(db, {
      messageId: Number(row.message_id), deliveryId, destinationId: Number(row.destination_id),
      stage: 'replay', outcome: 'info', actorUserId: userId,
      detail: `Replayed from the dead-letter queue${reason ? ` — ${reason}` : ''}. The same delivery is attempted again under its original idempotency key.`,
    });
    this.refreshMessageStatus(db, Number(row.message_id));
    return { ok: true, note: 'Queued for another attempt. It keeps its original delivery identity, so the destination can recognise the repeat.' };
  }

  /** Stop trying. For a delivery whose destination will never want it. */
  cancel(deliveryId: number, userId: number | null, reason: string): { ok: boolean; note: string } {
    const db = this.getDb();
    const row = db.prepare('SELECT * FROM mw_deliveries WHERE id = ?').get(deliveryId) as any;
    if (!row) return { ok: false, note: 'That delivery no longer exists.' };
    if (row.state === 'delivered') return { ok: false, note: 'This delivery has already been accepted and cannot be cancelled.' };
    db.prepare(`UPDATE mw_deliveries SET state = 'cancelled', dead_letter_reason = ?, next_attempt_at = NULL,
        updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(reason, deliveryId);
    this.trace(db, {
      messageId: Number(row.message_id), deliveryId, destinationId: Number(row.destination_id),
      stage: 'outcome', outcome: 'warn', actorUserId: userId, detail: `Cancelled — ${reason}`,
    });
    this.refreshMessageStatus(db, Number(row.message_id));
    return { ok: true, note: 'Cancelled. It is kept on the record and can still be replayed.' };
  }

  /**
   * Route a message that has already been ingested, again.
   *
   * For the laboratory that has just written the routing rule it should have
   * had. The existing deliveries are untouched: the idempotency key means a
   * destination already queued or delivered is not queued twice.
   */
  reroute(messageId: number, userId: number | null): { ok: boolean; queued: number; note: string } {
    const db = this.getDb();
    const row = db.prepare('SELECT * FROM mw_messages WHERE id = ?').get(messageId) as any;
    if (!row) return { ok: false, queued: 0, note: 'That message no longer exists.' };
    const normalised = json<NormalisedMessage>(row.normalised, { sampleId: null, lotNumber: null, instrument: null, runAt: null, kind: 'unknown', results: [] });
    const link = row.link_id == null ? null
      : db.prepare('SELECT section_id, profile_key FROM instrument_links WHERE id = ?').get(row.link_id) as any;

    this.trace(db, { messageId, stage: 'route', outcome: 'info', actorUserId: userId, detail: 'Re-routed on request against the current rules.' });
    const outcome = this.route(db, {
      messageId,
      normalised,
      envelope: {
        linkId: row.link_id ?? null, instrumentMessageId: row.instrument_message_id ?? null,
        protocol: row.protocol ?? null, kind: normalised.kind,
        sampleId: normalised.sampleId, lotNumber: normalised.lotNumber,
        instrument: normalised.instrument, runAt: normalised.runAt,
        results: normalised.results, raw: null, source: 'replay',
      },
      profileKey: link?.profile_key ?? null,
      sectionId: link?.section_id ?? null,
    });
    this.refreshMessageStatus(db, messageId);
    return { ok: true, queued: outcome.deliveries, note: outcome.note };
  }

  /* ========================================================================
     What the engine is doing
     ====================================================================== */
  overview(): Record<string, unknown> {
    const db = this.getDb();
    const blank = {
      running: this.started,
      destinations: 0, destinationsActive: 0, destinationsDegraded: 0,
      routes: 0, messagesToday: 0, deliveredToday: 0,
      queued: 0, retrying: 0, inFlight: 0, deadLetters: 0,
      lastDeliveryAt: null as string | null, tone: 'ok' as 'ok' | 'warn' | 'crit',
      protectedConnections: 0,
    };
    try {
      const counts = db.prepare(`SELECT
          (SELECT COUNT(*) FROM mw_destinations WHERE is_active = 1) AS destinations,
          (SELECT COUNT(*) FROM mw_destinations WHERE is_active = 1 AND state = 'active') AS active,
          (SELECT COUNT(*) FROM mw_destinations WHERE is_active = 1 AND state IN ('degraded','failed','disconnected')) AS degraded,
          (SELECT COUNT(*) FROM mw_destinations WHERE is_protected = 1) AS protected_count,
          (SELECT COUNT(*) FROM mw_routes WHERE is_active = 1) AS routes,
          (SELECT COUNT(*) FROM mw_messages WHERE date(received_at) = date('now')) AS messages_today,
          (SELECT COUNT(*) FROM mw_deliveries WHERE state = 'delivered' AND date(delivered_at) = date('now')) AS delivered_today,
          (SELECT COUNT(*) FROM mw_deliveries WHERE state = 'queued') AS queued,
          (SELECT COUNT(*) FROM mw_deliveries WHERE state = 'retrying') AS retrying,
          (SELECT COUNT(*) FROM mw_deliveries WHERE state = 'in_flight') AS in_flight,
          (SELECT COUNT(*) FROM mw_deliveries WHERE state = 'dead_letter') AS dead_letters,
          (SELECT MAX(delivered_at) FROM mw_deliveries WHERE state = 'delivered') AS last_delivery_at
        `).get() as any;
      const depth = Number(counts?.queued ?? 0) + Number(counts?.retrying ?? 0) + Number(counts?.in_flight ?? 0);
      return {
        running: this.started,
        destinations: Number(counts?.destinations ?? 0),
        destinationsActive: Number(counts?.active ?? 0),
        destinationsDegraded: Number(counts?.degraded ?? 0),
        protectedConnections: Number(counts?.protected_count ?? 0),
        routes: Number(counts?.routes ?? 0),
        messagesToday: Number(counts?.messages_today ?? 0),
        deliveredToday: Number(counts?.delivered_today ?? 0),
        queued: Number(counts?.queued ?? 0),
        retrying: Number(counts?.retrying ?? 0),
        inFlight: Number(counts?.in_flight ?? 0),
        deadLetters: Number(counts?.dead_letters ?? 0),
        queueDepth: depth,
        lastDeliveryAt: counts?.last_delivery_at ?? null,
        tone: queueTone(depth, Number(counts?.dead_letters ?? 0)),
      };
    } catch { return blank; }
  }

  /** Every stage of one message, in order, with its deliveries. */
  traceOf(messageId: number): Record<string, unknown> {
    const db = this.getDb();
    const message = db.prepare(`SELECT m.*, l.name AS link_name FROM mw_messages m
        LEFT JOIN instrument_links l ON l.id = m.link_id WHERE m.id = ?`).get(messageId) as any;
    if (!message) return { message: null, deliveries: [], trace: [] };
    const deliveries = db.prepare(`SELECT v.*, d.name AS destination_name, d.platform, d.transport, d.ack_policy
        FROM mw_deliveries v JOIN mw_destinations d ON d.id = v.destination_id
        WHERE v.message_id = ? ORDER BY v.id`).all(messageId) as any[];
    const trace = db.prepare(`SELECT t.*, d.name AS destination_name, u.full_name AS actor_name
        FROM mw_trace t LEFT JOIN mw_destinations d ON d.id = t.destination_id
        LEFT JOIN users u ON u.id = t.actor_user_id
        WHERE t.message_id = ? ORDER BY t.id`).all(messageId) as any[];
    return {
      message: {
        ...message,
        normalised: json<NormalisedMessage | null>(message.normalised, null),
        validation: json<ValidationFinding[]>(message.validation, []),
      },
      deliveries: deliveries.map(delivery => ({
        ...delivery,
        results_unmapped: json<string[]>(delivery.results_unmapped, []),
        // The acknowledgement policy decides what "delivered" is worth, and
        // the screen must say so rather than implying acceptance.
        confirmable: deliveryIsConfirmable(delivery.ack_policy),
      })),
      trace,
    };
  }

  /** One line in the message's own history. Never throws; it is a record, not a gate. */
  trace(db: DB, entry: {
    messageId?: number | null; deliveryId?: number | null; destinationId?: number | null;
    stage: string; outcome: string; detail: string; durationMs?: number | null; actorUserId?: number | null;
  }): void {
    try {
      db.prepare(`INSERT INTO mw_trace (message_id, delivery_id, destination_id, stage, outcome, detail, duration_ms, actor_user_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(entry.messageId ?? null, entry.deliveryId || null, entry.destinationId ?? null,
          entry.stage, entry.outcome, scrubSecrets(entry.detail).slice(0, 2_000),
          entry.durationMs ?? null, entry.actorUserId ?? null);
    } catch { /* the trace is evidence, not a dependency */ }
  }
}

/** A linear conversion, where the destination stores a different unit. */
function convertValue(value: string, mapping: any): string {
  const raw = String(value ?? '').trim();
  const numeric = Number(raw);
  const factor = mapping.factor == null ? null : Number(mapping.factor);
  const offset = mapping.offset_value == null ? 0 : Number(mapping.offset_value);
  if (!Number.isFinite(numeric) || (factor == null && !offset)) return mapValue(raw, mapping) ?? raw;
  const converted = numeric * (factor ?? 1) + offset;
  const decimals = mapping.decimals == null ? decimalsOf(raw) : Math.max(0, Math.min(6, Number(mapping.decimals)));
  return converted.toFixed(decimals);
}

function decimalsOf(raw: string): number {
  return raw.includes('.') ? Math.min(4, raw.split('.')[1].length) : 0;
}

/** A coded value the destination calls something else. */
function mapValue(value: string | null | undefined, mapping: any): string | null {
  const raw = value == null ? null : String(value);
  if (!raw) return raw;
  const table = json<Record<string, string>>(mapping.value_map, {});
  for (const [from, to] of Object.entries(table)) {
    if (String(from).toUpperCase() === raw.toUpperCase()) return to;
  }
  return raw;
}

/* ============================================================================
   The one engine
   ========================================================================= */
let engine: MiddlewareEngine | null = null;

export function getEngine(getDb: DbGetter): MiddlewareEngine {
  if (!engine) engine = new MiddlewareEngine(getDb);
  return engine;
}

export function currentEngine(): MiddlewareEngine | null { return engine; }

/** Every analyser profile, for the discovery and configuration screens. */
export function profileSummary(key: string | null | undefined) {
  const profile = profileByKey(key);
  if (!profile) return null;
  return { key: profile.key, label: profile.label, vendor: profile.vendor, protocol: profile.protocol, discipline: profile.discipline };
}
