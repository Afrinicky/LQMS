/**
 * PostgresStore — a DataStore implementation over node-postgres (`pg`), for the
 * cloud phase of the hybrid architecture. It lets the DataStore seam target a
 * cloud PostgreSQL (e.g. Neon) using the same interface the routes and sync
 * engine already speak. See docs/DATA_ACCESS_LAYER.md and docs/CLOUD_SYNC.md.
 *
 * Dialect handling vs SQLite:
 *  - Placeholders: SQLite `?` are translated to PostgreSQL `$1..$n` in order.
 *  - Insert ids: Postgres has no lastInsertRowid; callers that need the new id
 *    add `RETURNING id` and this store reads it back from the returned row.
 *  - Transactions: a dedicated pooled client runs BEGIN/COMMIT/ROLLBACK and the
 *    callback receives a client-bound DataStore handle.
 */
import pg from 'pg';
import { config } from '../config/index.js';
import type { DataStore, RunResult, SqlParams } from './dataStore.js';

/** Translate SQLite-style `?` placeholders into PostgreSQL `$1..$n`. */
export function toPgPlaceholders(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

type QueryFn = (text: string, params: unknown[]) => Promise<pg.QueryResult>;

/** Shared get/all/run/exec implemented on top of an arbitrary query function
 *  (a pool or a transaction-bound client). */
class PgQueryable implements DataStore {
  readonly driver = 'postgres' as const;
  constructor(protected query: QueryFn) {}

  async get<T = unknown>(sql: string, params: SqlParams = []): Promise<T | undefined> {
    const r = await this.query(toPgPlaceholders(sql), [...params]);
    return r.rows[0] as T | undefined;
  }

  async all<T = unknown>(sql: string, params: SqlParams = []): Promise<T[]> {
    const r = await this.query(toPgPlaceholders(sql), [...params]);
    return r.rows as T[];
  }

  async run(sql: string, params: SqlParams = []): Promise<RunResult> {
    const r = await this.query(toPgPlaceholders(sql), [...params]);
    const rowid = (r.rows?.[0] as { id?: number } | undefined)?.id;
    return { changes: r.rowCount ?? 0, lastInsertRowid: Number(rowid ?? 0) };
  }

  async exec(sql: string): Promise<void> {
    // Multi-statement DDL is passed through unparameterized.
    await this.query(sql, []);
  }

  async transaction<T>(_work: (tx: DataStore) => Promise<T>): Promise<T> {
    throw new Error('Nested transactions are not supported on a transaction-bound store handle.');
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.query('SELECT 1', []);
      return true;
    } catch {
      return false;
    }
  }
}

export class PostgresStore extends PgQueryable {
  private pool: pg.Pool;

  constructor(connectionString: string) {
    const pool = new pg.Pool({ connectionString, max: 8, idleTimeoutMillis: 30000 });
    super((text, params) => pool.query(text, params as unknown[]));
    this.pool = pool;
  }

  override async transaction<T>(work: (tx: DataStore) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const bound = new PgQueryable((text, params) => client.query(text, params as unknown[]));
      const result = await work(bound);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* best-effort */ }
      throw err;
    } finally {
      client.release();
    }
  }

  /** Close the pool (used on shutdown / tests). */
  async close(): Promise<void> {
    await this.pool.end();
  }
}

export function createPostgresStore(): DataStore {
  const url = config.db.postgresUrl;
  if (!url) {
    throw new Error(
      'SECH_LIMS_DB_DRIVER=postgres requires SECH_LIMS_PG_URL to be set to a ' +
      'PostgreSQL connection string (e.g. a Neon URL). See docs/CLOUD_SYNC.md.'
    );
  }
  return new PostgresStore(url);
}
