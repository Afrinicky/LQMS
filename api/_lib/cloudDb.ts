/**
 * Cloud read-API data layer — read-only queries against the Neon `synced_records`
 * table that the Host replicates into (see docs/CLOUD_SYNC.md). Used by the Vercel
 * serverless functions in api/cloud/*. Read-only by design: the Host remains the
 * single writer; the cloud portal is a view.
 */
import { Pool } from 'pg';

let pool: Pool | undefined;

function getPool(): Pool {
  if (!pool) {
    const url = process.env.DATABASE_URL || process.env.SECH_LIMS_CLOUD_URL;
    if (!url) throw new Error('DATABASE_URL (Neon connection string) is not set');
    pool = new Pool({
      connectionString: url,
      max: 3,
      // Managed Postgres (Neon) requires TLS; accept the provider chain.
      ssl: /sslmode=require|neon\.tech|\.aws\./i.test(url) ? { rejectUnauthorized: false } : undefined,
    });
  }
  return pool;
}

/**
 * Entity types the portal may read. Mirrors SYNCABLE_TABLES
 * (server/db/syncableTables.ts) — kept as a self-contained allowlist so the
 * serverless bundle has no cross-package import, and to reject arbitrary input.
 */
export const READABLE_ENTITIES = new Set<string>([
  'nonconforming_events', 'capa_records', 'complaints', 'risks',
  'equipment_items', 'equipment_maintenance_records', 'equipment_calibration_records',
  'inventory_items', 'inventory_batches', 'suppliers',
  'monitoring_items', 'monitoring_readings', 'safety_incidents',
  'actions', 'documents', 'document_versions',
  'iqc_materials', 'iqc_results', 'eqa_programs', 'eqa_events', 'staff',
]);

export interface SyncedRow {
  uuid: string;
  data: Record<string, unknown>;
  updated_at: string | null;
  deleted_at: string | null;
}

/** Count of live (non-deleted) records per entity type. */
export async function summary(): Promise<Array<{ entity_table: string; total: number }>> {
  const r = await getPool().query(
    `SELECT entity_table, COUNT(*)::int AS total
       FROM synced_records
      WHERE deleted_at IS NULL
      GROUP BY entity_table
      ORDER BY entity_table`
  );
  return r.rows;
}

/** List live records of one entity type, newest first. */
export async function listRecords(entity: string, limit = 200, offset = 0): Promise<SyncedRow[]> {
  const r = await getPool().query(
    `SELECT uuid, data, updated_at, deleted_at
       FROM synced_records
      WHERE entity_table = $1 AND deleted_at IS NULL
      ORDER BY updated_at DESC NULLS LAST
      LIMIT $2 OFFSET $3`,
    [entity, Math.min(Math.max(limit, 1), 1000), Math.max(offset, 0)]
  );
  return r.rows as SyncedRow[];
}

/** Fetch one record (including tombstones, so callers can detect deletions). */
export async function getRecord(entity: string, uuid: string): Promise<SyncedRow | null> {
  const r = await getPool().query(
    `SELECT uuid, data, updated_at, deleted_at FROM synced_records WHERE entity_table = $1 AND uuid = $2`,
    [entity, uuid]
  );
  return (r.rows[0] as SyncedRow) ?? null;
}

// --- Remote Staff Portal accounts (R1) -------------------------------------
// cloud_users is provisioned/written by the Host (server/services/remoteAccess);
// the portal auth endpoints read it here. Password hashes are cloud-specific.

export interface CloudUser {
  id: number;
  staff_id: number;
  email: string;
  password_hash: string;
  full_name: string | null;
  role: string | null;
  remote_scope: unknown;
  status: string;
  must_change_password: boolean;
}

/** Missing-table code so auth can respond cleanly before any user is provisioned. */
function isUndefinedTable(err: unknown): boolean {
  return (err as { code?: string })?.code === '42P01';
}

export async function getUserByEmail(email: string): Promise<CloudUser | null> {
  try {
    const r = await getPool().query(
      `SELECT id, staff_id, email, password_hash, full_name, role, remote_scope, status, must_change_password
         FROM cloud_users WHERE lower(email) = lower($1)`,
      [email]
    );
    return (r.rows[0] as CloudUser) ?? null;
  } catch (err) {
    if (isUndefinedTable(err)) return null;
    throw err;
  }
}

export async function getUserById(id: number): Promise<CloudUser | null> {
  try {
    const r = await getPool().query(
      `SELECT id, staff_id, email, password_hash, full_name, role, remote_scope, status, must_change_password
         FROM cloud_users WHERE id = $1`,
      [id]
    );
    return (r.rows[0] as CloudUser) ?? null;
  } catch (err) {
    if (isUndefinedTable(err)) return null;
    throw err;
  }
}

export async function touchLastLogin(id: number): Promise<void> {
  await getPool().query(`UPDATE cloud_users SET last_login_at = now() WHERE id = $1`, [id]);
}

export async function updatePassword(id: number, passwordHash: string): Promise<void> {
  await getPool().query(
    `UPDATE cloud_users SET password_hash = $1, must_change_password = false, updated_at = now() WHERE id = $2`,
    [passwordHash, id]
  );
}
