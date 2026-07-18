/**
 * Centralized runtime configuration for the SECH_LIMS host.
 *
 * This is the single place the server reads process.env. Every other module
 * imports the typed `config` object instead of touching process.env directly,
 * so all URLs, database connections, deployment mode, and (future) sync settings
 * are configurable purely through environment variables.
 *
 * This module is intentionally a dependency-free leaf: it imports nothing from
 * the rest of the server, so it can be safely imported by database.ts, the
 * Express app, and the Electron boot code without creating an import cycle.
 *
 * Phase 1 of the offline-first hybrid architecture. See
 * docs/HYBRID_ARCHITECTURE_PLAN.md. Cloud/Postgres/sync fields are declared here
 * so the seam exists, but nothing in this phase acts on them.
 */
import path from 'node:path';

/** Deployment mode. `local` = single-PC offline. `hybrid` = LAN/remote-capable. */
export type AppMode = 'local' | 'hybrid';

/** Active database driver. Only `sqlite` is implemented in this phase. */
export type DbDriver = 'sqlite' | 'postgres';

function envString(key: string, fallback: string): string {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
}

function envOptional(key: string): string | null {
  const v = process.env[key];
  return v === undefined || v === '' ? null : v;
}

function envNumber(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(key: string, fallback = false): boolean {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(v);
}

function normalizeMode(value: string): AppMode {
  return value.toLowerCase() === 'hybrid' ? 'hybrid' : 'local';
}

function normalizeDriver(value: string): DbDriver {
  return value.toLowerCase() === 'postgres' ? 'postgres' : 'sqlite';
}

const dataDir = envString('SECH_LIMS_DATA_DIR', path.join(process.cwd(), 'local-data'));

export interface AppConfig {
  /** Deployment default for the operating mode. The admin-settable runtime
   *  override lives in the `settings` table (key `systemMode`); effective mode
   *  is resolved by the API as `settings ?? config.mode`. */
  readonly mode: AppMode;
  readonly api: {
    /** Bind address. 127.0.0.1 keeps the host private; 0.0.0.0 serves the LAN. */
    readonly host: string;
    readonly port: number;
    /** External URL used by remote clients. Reserved for a later phase. */
    readonly publicUrl: string | null;
  };
  readonly db: {
    readonly driver: DbDriver;
    /** Root directory for the SQLite database, uploads, evidence and backups. */
    readonly dataDir: string;
    /** Explicit SQLite file path override; defaults to <dataDir>/sech_lims.sqlite. */
    readonly sqlitePath: string;
    /** Cloud Postgres/Neon connection string. Reserved for a later phase. */
    readonly postgresUrl: string | null;
  };
  readonly sync: {
    /** Master switch. Always false in this phase — the sync engine is a stub. */
    readonly enabled: boolean;
    /** Cloud sync endpoint. Reserved for a later phase. */
    readonly cloudUrl: string | null;
    readonly intervalMs: number;
  };
  readonly client: {
    /** When set, this build runs as a thin client that connects to a remote
     *  Host instead of embedding its own API. Consumed by the Electron shell.
     *  e.g. http://192.168.1.50:4317 */
    readonly hostUrl: string | null;
  };
}

export const config: AppConfig = Object.freeze({
  mode: normalizeMode(envString('SECH_LIMS_MODE', 'local')),
  api: Object.freeze({
    host: envString('SECH_LIMS_API_HOST', '127.0.0.1'),
    port: envNumber('API_PORT', 4317),
    publicUrl: envOptional('SECH_LIMS_PUBLIC_URL'),
  }),
  db: Object.freeze({
    driver: normalizeDriver(envString('SECH_LIMS_DB_DRIVER', 'sqlite')),
    dataDir,
    sqlitePath: envString('SECH_LIMS_DB_PATH', path.join(dataDir, 'sech_lims.sqlite')),
    postgresUrl: envOptional('SECH_LIMS_PG_URL'),
  }),
  sync: Object.freeze({
    enabled: envBool('SECH_LIMS_SYNC_ENABLED', false),
    cloudUrl: envOptional('SECH_LIMS_CLOUD_URL'),
    intervalMs: envNumber('SECH_LIMS_SYNC_INTERVAL_MS', 60000),
  }),
  client: Object.freeze({
    hostUrl: envOptional('SECH_LIMS_HOST_URL'),
  }),
});

/** True when the API is bound to a LAN-reachable address (not loopback only). */
export function isLanExposed(): boolean {
  return config.api.host === '0.0.0.0' || config.api.host === '::';
}
