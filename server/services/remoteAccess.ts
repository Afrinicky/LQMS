/**
 * Remote Staff Access provisioning (R1). The Host is the authority for who may
 * access the cloud portal: an admin provisions per-staff cloud accounts, which
 * this service writes into the Neon `cloud_users` table (via PostgresStore).
 * Passwords are hashed here (cloud-specific) — Host login hashes are never copied.
 *
 * Requires SECH_LIMS_CLOUD_URL to be configured (the same cloud DB sync uses).
 */
import bcrypt from 'bcryptjs';
import { config } from '../config/index.js';
import { PostgresStore } from '../db/postgresStore.js';

let store: PostgresStore | undefined;

export function cloudConfigured(): boolean {
  return Boolean(config.sync.cloudUrl);
}

function cloud(): PostgresStore {
  if (!config.sync.cloudUrl) {
    throw new Error('Cloud is not configured. Set SECH_LIMS_CLOUD_URL to enable remote staff access.');
  }
  if (!store) store = new PostgresStore(config.sync.cloudUrl);
  return store;
}

export async function ensureCloudUsers(): Promise<void> {
  await cloud().exec(`
    CREATE TABLE IF NOT EXISTS cloud_users (
      id bigserial PRIMARY KEY,
      staff_id integer NOT NULL,
      email text NOT NULL UNIQUE,
      password_hash text NOT NULL,
      full_name text,
      role text,
      remote_scope jsonb,
      status text NOT NULL DEFAULT 'active',
      mfa_secret text,
      must_change_password boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz,
      last_login_at timestamptz
    );
  `);
}

export interface ProvisionInput {
  staffId: number;
  email: string;
  fullName?: string | null;
  role?: string | null;
  password: string;
}

/** Create or re-provision a cloud account for a staff member (idempotent by email). */
export async function provisionUser(input: ProvisionInput): Promise<void> {
  await ensureCloudUsers();
  const hash = bcrypt.hashSync(input.password, 12);
  await cloud().run(
    `INSERT INTO cloud_users (staff_id, email, password_hash, full_name, role, status, must_change_password)
     VALUES (?, ?, ?, ?, ?, 'active', true)
     ON CONFLICT (email) DO UPDATE SET
       staff_id = EXCLUDED.staff_id, password_hash = EXCLUDED.password_hash,
       full_name = EXCLUDED.full_name, role = EXCLUDED.role,
       status = 'active', must_change_password = true, updated_at = now()`,
    [input.staffId, input.email.trim().toLowerCase(), hash, input.fullName ?? null, input.role ?? null]
  );
}

export interface CloudUserRow {
  id: number; staff_id: number; email: string; full_name: string | null;
  role: string | null; status: string; last_login_at: string | null;
}

export async function listUsers(): Promise<CloudUserRow[]> {
  await ensureCloudUsers();
  return cloud().all<CloudUserRow>(
    `SELECT id, staff_id, email, full_name, role, status, last_login_at FROM cloud_users ORDER BY email`
  );
}

export async function setStatus(id: number, status: 'active' | 'disabled'): Promise<void> {
  await cloud().run(`UPDATE cloud_users SET status = ?, updated_at = now() WHERE id = ?`, [status, id]);
}
