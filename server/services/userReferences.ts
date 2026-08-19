/**
 * Everywhere a user account is referenced.
 *
 * Used to decide whether an account may be erased or must only be deactivated.
 * An accredited laboratory cannot lose the authorship of a record, a signature
 * or an audit entry, so an account that left any of those behind is kept.
 *
 * Discovery is deliberately belt-and-braces. Declared foreign keys are the
 * obvious source, but they are NOT enough: `audit_logs.actor_user_id` — the one
 * column that most matters here — is a plain INTEGER with no REFERENCES clause,
 * so a purely schema-driven check would happily erase an account that had
 * written the entire audit trail. Columns are therefore also matched by name.
 */
import { getDb } from '../db/database.js';

/**
 * Column names that hold a user id across this schema. Matched on every table
 * in addition to whatever foreign keys are declared.
 */
const USER_COLUMN_NAMES = new Set([
  'user_id', 'actor_user_id', 'created_by', 'updated_by', 'uploaded_by', 'linked_by',
  'paired_user_id', 'assigned_to_user_id', 'signed_by_user_id', 'submitted_by_user_id',
  'snapshot_by_user_id', 'decided_by_user_id', 'reviewed_by_user_id', 'approved_by_user_id',
  'closed_by_user_id', 'completed_by_user_id', 'acknowledged_by_user_id', 'requested_by_user_id',
  'verified_by_user_id', 'authorised_by_user_id', 'authorized_by_user_id', 'deleted_by_user_id',
]);

/**
 * Tables that are account plumbing rather than laboratory record. These go with
 * the account when it is erased; they never block the erase.
 */
export const DISPOSABLE_TABLES = new Set([
  'auth_sessions',
  'password_reset_requests',
  'user_permission_overrides',
  'push_subscriptions',
  'notification_preferences',
]);

export type UserReference = { table: string; column: string; rows: number };

/** Every (table, column) that currently points at this user, with row counts. */
export function referencesToUser(userId: number): UserReference[] {
  const db = getDb();
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
  const found: UserReference[] = [];

  for (const { name } of tables) {
    if (name === 'users') continue;

    const columns = new Set<string>();
    try {
      for (const fk of db.prepare(`PRAGMA foreign_key_list("${name}")`).all() as { table: string; from: string }[]) {
        if (fk.table === 'users') columns.add(fk.from);
      }
      for (const col of db.prepare(`PRAGMA table_info("${name}")`).all() as { name: string; type: string }[]) {
        if (USER_COLUMN_NAMES.has(col.name)) columns.add(col.name);
      }
    } catch { continue; }

    for (const column of columns) {
      try {
        const rows = (db.prepare(`SELECT COUNT(*) c FROM "${name}" WHERE "${column}" = ?`).get(userId) as { c: number }).c;
        if (rows > 0) found.push({ table: name, column, rows });
      } catch { /* a view, or the column vanished — nothing to count */ }
    }
  }
  return found.sort((a, b) => b.rows - a.rows);
}

/** The references that make an account un-erasable: everything but plumbing. */
export function historicReferences(userId: number): UserReference[] {
  return referencesToUser(userId).filter(r => !DISPOSABLE_TABLES.has(r.table));
}

/**
 * Erase an account the laboratory record still names.
 *
 * The counterpart of purgeStaffEverywhere, and for the same one situation: a
 * system set up with demonstration logins that has since gone live. Those
 * accounts are not people, but weeks of routed notifications, document
 * distribution and audit entries have grown against them, so the ordinary
 * "erase only what left no trace" rule refuses them for good.
 *
 * It deliberately treats two kinds of reference differently.
 *
 * Columns with a DECLARED foreign key to users(id) must let go — SQLite has
 * foreign keys switched on, so the delete would simply fail otherwise. Those
 * are emptied where the schema allows a null, and the row is removed where it
 * cannot exist without an account.
 *
 * Columns that merely hold a user id — `audit_logs.actor_user_id` above all —
 * are left exactly as they are. The audit trail is the one thing an accredited
 * laboratory may not lose, and blanking the actor would turn a thousand entries
 * into anonymous ones. The id stays, the entries stay, and the purge record the
 * caller writes names which id was erased and who it was, so the trail can
 * still be read end to end afterwards.
 */
export function purgeUserEverywhere(userId: number): {
  detached: { table: string; column: string; rows: number; action: 'detached' | 'deleted' }[];
  keptWithId: { table: string; column: string; rows: number }[];
} {
  const db = getDb();
  const detached: { table: string; column: string; rows: number; action: 'detached' | 'deleted' }[] = [];
  const keptWithId: { table: string; column: string; rows: number }[] = [];

  for (const ref of referencesToUser(userId)) {
    if (DISPOSABLE_TABLES.has(ref.table)) continue;   // handled by purgeDisposableRows

    // Does the schema actually force this column to let go?
    let declaredFk = false;
    let nullable = true;
    try {
      declaredFk = (db.prepare(`PRAGMA foreign_key_list("${ref.table}")`).all() as { table: string; from: string }[])
        .some(fk => fk.table === 'users' && fk.from === ref.column);
      const col = (db.prepare(`PRAGMA table_info("${ref.table}")`).all() as { name: string; notnull: number }[])
        .find(c => c.name === ref.column);
      nullable = !col || col.notnull === 0;
    } catch { continue; }

    if (!declaredFk) { keptWithId.push(ref); continue; }

    try {
      if (nullable) {
        db.prepare(`UPDATE "${ref.table}" SET "${ref.column}" = NULL WHERE "${ref.column}" = ?`).run(userId);
        detached.push({ ...ref, action: 'detached' });
      } else {
        db.prepare(`DELETE FROM "${ref.table}" WHERE "${ref.column}" = ?`).run(userId);
        detached.push({ ...ref, action: 'deleted' });
      }
    } catch { /* surfaces on the delete itself */ }
  }
  return { detached, keptWithId };
}

/** Remove the plumbing rows for an account that is about to be erased. */
export function purgeDisposableRows(userId: number): void {
  const db = getDb();
  for (const table of DISPOSABLE_TABLES) {
    const columns = new Set<string>();
    try {
      for (const fk of db.prepare(`PRAGMA foreign_key_list("${table}")`).all() as { table: string; from: string }[]) {
        if (fk.table === 'users') columns.add(fk.from);
      }
      for (const col of db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]) {
        if (USER_COLUMN_NAMES.has(col.name)) columns.add(col.name);
      }
    } catch { continue; }
    for (const column of columns) {
      try { db.prepare(`DELETE FROM "${table}" WHERE "${column}" = ?`).run(userId); } catch { /* absent */ }
    }
  }
}
