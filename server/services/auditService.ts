/**
 * The audit trail, and the thing that makes it worth having.
 *
 * Every entry carries the hash of the entry before it. Rewriting or removing
 * one breaks the chain from that point forward, and the break is visible to
 * anyone who verifies it — which the data-integrity scan now does on every run.
 *
 * That is a deliberate choice of what to promise. A SQLite file belongs to
 * whoever administers the host, so no amount of application code can make an
 * entry impossible to alter. What the chain gives the laboratory instead is the
 * ability to say, with evidence, *whether* anything was altered and from when.
 * ISO 15189 §7.6.3, Annex 11 §9 and 21 CFR 11.10(e) all ask for records
 * safeguarded against tampering; detectable tampering is the honest form of
 * that promise on this platform, and it is a great deal better than the nothing
 * that was here before (validation finding VF-05).
 *
 * Timestamps are ISO-8601 with an explicit Z. The old SQLite CURRENT_TIMESTAMP
 * form said nothing about its zone, so an entry could not prove the instant it
 * described (VF-17).
 */
import crypto from 'node:crypto';
import { getDb } from '../db/database.js';
import type { Request } from 'express';

export interface AuditEntry {
  action: string;
  entity: string;
  entityId?: string | number;
  oldValue?: unknown;
  newValue?: unknown;
  /** Overrides the actor taken from the request. For unauthenticated events. */
  actorUserId?: number | null;
  ipAddress?: string | null;
}

/** ISO-8601 UTC, to the millisecond, with the zone stated. */
export const nowIso = () => new Date().toISOString();

/** The digest of one entry, over every field that gives it meaning. */
function hashEntry(fields: {
  prevHash: string;
  actor: number | null;
  action: string;
  entity: string;
  entityId: string | null;
  oldValue: string | null;
  newValue: string | null;
  recordedAt: string;
}): string {
  return crypto.createHash('sha256').update(JSON.stringify([
    fields.prevHash, fields.actor, fields.action, fields.entity,
    fields.entityId, fields.oldValue, fields.newValue, fields.recordedAt,
  ])).digest('hex');
}

/** The genesis link, so the first entry in a database still has a predecessor. */
const GENESIS = '0'.repeat(64);

/**
 * Write one entry and return its id.
 *
 * Returning the id is not a convenience: the electronic-signature service used
 * to find the entry it had just written with "the newest row in the table",
 * which attached the wrong entry to a signature whenever anything else was
 * audited in the same instant (VF-14).
 */
export function audit(req: Request | undefined, entry: AuditEntry): number {
  const db = getDb();
  const actor = entry.actorUserId !== undefined ? entry.actorUserId : (req?.user?.id ?? null);
  const entityId = entry.entityId === undefined || entry.entityId === null ? null : String(entry.entityId);
  const oldValue = entry.oldValue ? JSON.stringify(entry.oldValue) : null;
  const newValue = entry.newValue ? JSON.stringify(entry.newValue) : null;
  const recordedAt = nowIso();
  const ip = entry.ipAddress !== undefined ? entry.ipAddress : (req?.ip ?? null);
  const device = (req?.headers['x-device-id'] as string | undefined) ?? null;

  const previous = db.prepare('SELECT entry_hash FROM audit_logs WHERE entry_hash IS NOT NULL ORDER BY id DESC LIMIT 1')
    .get() as { entry_hash?: string } | undefined;
  const prevHash = previous?.entry_hash ?? GENESIS;
  const entryHash = hashEntry({ prevHash, actor, action: entry.action, entity: entry.entity, entityId, oldValue, newValue, recordedAt });

  const result = db.prepare(
    `INSERT INTO audit_logs (actor_user_id, action, entity, entity_id, old_value, new_value, ip_address, device_id, recorded_at, prev_hash, entry_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(actor, entry.action, entry.entity, entityId, oldValue, newValue, ip, device, recordedAt, prevHash, entryHash);

  return Number(result.lastInsertRowid);
}

export interface ChainVerification {
  ok: boolean;
  checked: number;
  /** Entries written before the chain existed. Not a break — just unchained. */
  unchained: number;
  /** ids of entries whose stored hash does not match their content. */
  altered: number[];
  /** ids of entries whose prev_hash does not match the entry before them. */
  broken: number[];
  message: string;
}

/**
 * Walk the trail and check it against itself.
 *
 * Entries written before this migration have no hash. They are counted and
 * reported honestly rather than being back-filled — back-filling a chain over
 * history you cannot vouch for would produce a document that looks like proof
 * and is not one.
 */
export function verifyAuditChain(limit?: number): ChainVerification {
  const db = getDb();
  const rows = db.prepare(
    `SELECT id, actor_user_id, action, entity, entity_id, old_value, new_value, recorded_at, prev_hash, entry_hash
     FROM audit_logs ORDER BY id ASC${limit ? ` LIMIT ${Number(limit)}` : ''}`
  ).all() as Array<{
    id: number; actor_user_id: number | null; action: string; entity: string; entity_id: string | null;
    old_value: string | null; new_value: string | null; recorded_at: string | null;
    prev_hash: string | null; entry_hash: string | null;
  }>;

  const altered: number[] = [];
  const broken: number[] = [];
  let unchained = 0;
  let checked = 0;
  let expectedPrev: string | null = null;

  for (const row of rows) {
    if (!row.entry_hash) { unchained++; continue; }
    checked++;

    const recomputed = hashEntry({
      prevHash: row.prev_hash ?? GENESIS,
      actor: row.actor_user_id,
      action: row.action,
      entity: row.entity,
      entityId: row.entity_id,
      oldValue: row.old_value,
      newValue: row.new_value,
      recordedAt: row.recorded_at ?? '',
    });
    if (recomputed !== row.entry_hash) altered.push(row.id);
    if (expectedPrev !== null && row.prev_hash !== expectedPrev) broken.push(row.id);
    expectedPrev = row.entry_hash;
  }

  const ok = altered.length === 0 && broken.length === 0;
  const message = ok
    ? `Audit trail intact: ${checked} chained ${checked === 1 ? 'entry' : 'entries'} verified` +
      (unchained ? `, ${unchained} written before chaining began.` : '.')
    : `Audit trail integrity check FAILED: ${altered.length} altered ${altered.length === 1 ? 'entry' : 'entries'}, ` +
      `${broken.length} ${broken.length === 1 ? 'break' : 'breaks'} in the chain. ` +
      'Investigate as a data-integrity incident before relying on any record from this period.';

  return { ok, checked, unchained, altered, broken, message };
}
