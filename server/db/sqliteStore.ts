/**
 * SqliteStore — the local, on-host implementation of DataStore backed by the
 * existing better-sqlite3 connection (Phase 2 of the hybrid architecture).
 *
 * It deliberately reuses the shared getDb() singleton rather than opening its
 * own connection, so there is exactly one SQLite handle in the process. This
 * lets migrated routes (via the store) and not-yet-migrated routes (via getDb()
 * directly) operate on the same database throughout a gradual migration.
 */
import type BetterSqlite3 from 'better-sqlite3';
import { getDb } from './database.js';
import type { DataStore, RunResult, SqlParams } from './dataStore.js';

export class SqliteStore implements DataStore {
  readonly driver = 'sqlite' as const;

  /** Always resolve the live shared connection (survives restore/reopen). */
  private get db(): BetterSqlite3.Database {
    return getDb();
  }

  async get<T = unknown>(sql: string, params: SqlParams = []): Promise<T | undefined> {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  async all<T = unknown>(sql: string, params: SqlParams = []): Promise<T[]> {
    return this.db.prepare(sql).all(...params) as T[];
  }

  async run(sql: string, params: SqlParams = []): Promise<RunResult> {
    const info = this.db.prepare(sql).run(...params);
    // safeIntegers is not enabled, so lastInsertRowid is a JS number at runtime.
    return { changes: info.changes, lastInsertRowid: Number(info.lastInsertRowid) };
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  /**
   * Manual BEGIN/COMMIT/ROLLBACK around the callback.
   *
   * Correctness note: every store operation here completes synchronously and
   * resolves an already-settled promise, so awaiting one only schedules a
   * microtask. Node drains the microtask queue to exhaustion before running the
   * next macrotask (another HTTP request's handler), so a transaction body that
   * only awaits this store runs to COMMIT with no other database access
   * interleaving on the single shared connection. This is why `work` must not
   * await unrelated real-async operations inside a transaction.
   */
  async transaction<T>(work: (tx: DataStore) => Promise<T>): Promise<T> {
    const db = this.db;
    db.exec('BEGIN');
    try {
      const result = await work(this);
      db.exec('COMMIT');
      return result;
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* best-effort; connection may be mid-error */ }
      throw err;
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      this.db.prepare('SELECT 1').get();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Escape hatch: the underlying better-sqlite3 connection, for the not-yet
   * migrated synchronous call sites during the gradual rollout. New code should
   * prefer the async DataStore methods above.
   */
  raw(): BetterSqlite3.Database {
    return this.db;
  }
}
