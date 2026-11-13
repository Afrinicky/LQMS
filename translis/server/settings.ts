/**
 * What this installation is, and how long it keeps what passes through it.
 *
 * Three decisions, all an administrator's: where the software is standing
 * (network or on the analyser's own PC), what the receiving system is called,
 * and how long a result stays readable here after it has been delivered.
 *
 * The third is the one that matters legally. TransLis has to record what
 * arrived — a delivery cannot be queued, retried, traced or accounted for
 * otherwise — but it has no reason to hold the values once the laboratory's
 * own system has them. So they age out, and what remains is the proof that
 * something was sent: the delivery, its outcome, its trace, and the identifier
 * hashed rather than printed.
 */
import type Database from 'better-sqlite3';
import crypto from 'node:crypto';
import {
  DEFAULT_RETENTION_DAYS, MODE_LABEL, SETTING, type TransmissionMode,
} from './brand.js';

export type TransLisSettings = {
  mode: TransmissionMode;
  modeLabel: string;
  retentionDays: number;
  lisName: string;
};

function read(db: Database.Database, key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

function write(db: Database.Database, key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
  ).run(key, value);
}

export function getSettings(db: Database.Database): TransLisSettings {
  const mode: TransmissionMode = read(db, SETTING.mode) === 'direct' ? 'direct' : 'lan';
  const stored = Number(read(db, SETTING.retentionDays));
  return {
    mode,
    modeLabel: MODE_LABEL[mode],
    retentionDays: Number.isFinite(stored) && stored > 0 ? stored : DEFAULT_RETENTION_DAYS,
    lisName: read(db, SETTING.lisName) ?? 'the laboratory information system',
  };
}

export function saveSettings(
  db: Database.Database,
  input: { mode?: string; retentionDays?: unknown; lisName?: unknown },
): TransLisSettings {
  if (input.mode === 'lan' || input.mode === 'direct') write(db, SETTING.mode, input.mode);

  if (input.retentionDays !== undefined) {
    const days = Number(input.retentionDays);
    // A day is the floor and ten years the ceiling. Zero would mean erasing a
    // result the moment it arrived, before anything could be delivered or
    // retried, which is not a retention policy but a fault.
    if (!Number.isFinite(days) || days < 1 || days > 3650) {
      throw new Error('Keep results for between 1 and 3650 days.');
    }
    write(db, SETTING.retentionDays, String(Math.round(days)));
  }

  if (input.lisName !== undefined) write(db, SETTING.lisName, String(input.lisName).trim().slice(0, 120));
  return getSettings(db);
}

/**
 * An identifier, kept as proof without being kept.
 *
 * A delivery record has to be able to answer "was this sample sent?" after the
 * sample itself has been purged. A hash answers it — the laboratory can put
 * the identifier in and see whether it matches — without the register being a
 * list of everybody whose blood went through this machine.
 */
function fingerprint(value: string | null): string | null {
  if (!value) return null;
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

export type PurgeResult = {
  /** Transmissions whose values and raw text were removed. */
  messages: number;
  /** The cut-off applied, as the laboratory would read it. */
  before: string;
  retentionDays: number;
};

/**
 * Remove the result values and the raw message from everything older than the
 * retention period, and leave the accounting behind.
 *
 * Deliberately an UPDATE rather than a DELETE. Deleting the row would take the
 * delivery, its attempts, its acknowledgement and its trace with it, and a
 * laboratory asked to show that a result was transmitted on a date six months
 * ago would have nothing to show. Emptying the row keeps the whole of that
 * account and removes only the clinical content.
 */
export function purgeExpired(db: Database.Database, days?: number): PurgeResult {
  const retentionDays = days ?? getSettings(db).retentionDays;
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000)
    .toISOString().replace('T', ' ').slice(0, 19);

  const stale = db.prepare(
    `SELECT id, sample_id FROM instrument_messages
      WHERE received_at < ? AND (parsed_values IS NOT NULL OR raw_message IS NOT NULL)`,
  ).all(cutoff) as Array<{ id: number; sample_id: string | null }>;

  const empty = db.prepare(
    `UPDATE instrument_messages
        SET parsed_values = NULL, raw_message = NULL, sample_id = ?, lot_number = NULL
      WHERE id = ?`,
  );
  const tx = db.transaction((rows: typeof stale) => {
    for (const row of rows) empty.run(fingerprint(row.sample_id), row.id);
  });
  tx(stale);

  // The middleware's own canonical copy goes the same way, and so does the
  // rendered payload each delivery sent. `payload_hash` survives both, which
  // is what lets a laboratory still prove WHAT was sent to a destination on a
  // date after the content itself is gone.
  db.prepare(
    `UPDATE mw_messages
        SET normalised = NULL, sample_id = NULL, lot_number = NULL
      WHERE received_at < ? AND normalised IS NOT NULL`,
  ).run(cutoff);
  db.prepare(
    `UPDATE mw_deliveries SET payload = NULL
      WHERE payload IS NOT NULL
        AND message_id IN (SELECT id FROM mw_messages WHERE received_at < ?)`,
  ).run(cutoff);

  return { messages: stale.length, before: cutoff, retentionDays };
}

/** What is waiting to be purged, for the screen that offers to do it. */
export function purgeDue(db: Database.Database): { overdue: number; retentionDays: number; oldest: string | null } {
  const { retentionDays } = getSettings(db);
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000)
    .toISOString().replace('T', ' ').slice(0, 19);
  const row = db.prepare(
    `SELECT COUNT(*) AS n, MIN(received_at) AS oldest FROM instrument_messages
      WHERE received_at < ? AND (parsed_values IS NOT NULL OR raw_message IS NOT NULL)`,
  ).get(cutoff) as { n: number; oldest: string | null };
  return { overdue: Number(row?.n ?? 0), retentionDays, oldest: row?.oldest ?? null };
}
