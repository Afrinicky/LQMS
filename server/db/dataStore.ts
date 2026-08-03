/**
 * DataStore — the data-access seam for the offline-first hybrid architecture
 * (Phase 2). See docs/HYBRID_ARCHITECTURE_PLAN.md and docs/DATA_ACCESS_LAYER.md.
 *
 * Route modules talk to this interface instead of reaching for better-sqlite3
 * directly. Today the only implementation is SqliteStore (local, on the host).
 * A PostgresStore can be added later to point at a cloud database (e.g. Neon)
 * without changing the calling code's shape.
 *
 * The interface is intentionally **async-first**: every method returns a Promise
 * so an asynchronous driver (node-postgres) satisfies it naturally. The SQLite
 * implementation is synchronous under the hood and resolves immediately, which
 * keeps it fast while presenting the same contract both drivers share.
 *
 * This module is pure types — it imports nothing — so it can be depended on from
 * anywhere without risk of an import cycle.
 */

/** Positional bind parameters. Both drivers accept a flat array. */
export type SqlParams = ReadonlyArray<unknown>;

/** Result of a write (INSERT/UPDATE/DELETE). */
export interface RunResult {
  /** Number of rows affected. */
  changes: number;
  /** Auto-generated id of an INSERT. SQLite-native (a plain JS number here — the
   *  app does not enable better-sqlite3 safeIntegers); a Postgres driver will
   *  populate it from a RETURNING clause. May be 0 when not applicable. */
  lastInsertRowid: number;
}

export type StoreDriver = 'sqlite' | 'postgres';

export interface DataStore {
  /** Which backend is active. */
  readonly driver: StoreDriver;

  /** Return the first matching row, or undefined. */
  get<T = unknown>(sql: string, params?: SqlParams): Promise<T | undefined>;

  /** Return all matching rows. */
  all<T = unknown>(sql: string, params?: SqlParams): Promise<T[]>;

  /** Execute a write and report affected rows / insert id. */
  run(sql: string, params?: SqlParams): Promise<RunResult>;

  /** Execute one or more raw statements (DDL / pragmas). No parameters. */
  exec(sql: string): Promise<void>;

  /**
   * Run `work` inside a single atomic transaction, passing a transactional
   * handle. Commits if it resolves, rolls back if it throws.
   *
   * IMPORTANT: within `work`, only await operations on the provided store
   * handle. Do not await unrelated real-async work (timers, network, fs) inside
   * a transaction — see docs/DATA_ACCESS_LAYER.md for the rationale.
   */
  transaction<T>(work: (tx: DataStore) => Promise<T>): Promise<T>;

  /** Lightweight liveness probe. */
  healthCheck(): Promise<boolean>;
}
