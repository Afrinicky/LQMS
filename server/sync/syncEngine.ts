/**
 * SyncEngine — bidirectional replication between the local SQLite host and a
 * cloud PostgreSQL database (e.g. Neon), for the cloud phase of the hybrid
 * architecture. See docs/CLOUD_SYNC.md and docs/HYBRID_ARCHITECTURE_PLAN.md.
 *
 * It self-gates on config.sync.enabled + config.sync.cloudUrl; with either unset
 * it is inert and the host runs fully offline, exactly as before.
 *
 * Replication model — JSONB document store. Each local row of a syncable table
 * is serialized and upserted into a single cloud table `synced_records`, keyed by
 * (entity_table, uuid). This avoids hand-mirroring ~21 relational schemas in the
 * cloud while giving cloud consumers (a Vercel web app, dashboards) a uniform,
 * queryable shape. Conflicts resolve last-writer-wins by updated_at; deletes are
 * tombstones (deleted_at set).
 *
 *  push(): drains sync_outbox → upserts current local row state into the cloud.
 *  pull(): reads cloud changes since a watermark → merges into local tables by
 *          uuid, with capture suppressed so applied changes are not re-emitted.
 */
import { config } from '../config/index.js';
import { getStore } from '../db/store.js';
import { getDb } from '../db/database.js';
import { PostgresStore } from '../db/postgresStore.js';
import { SYNCABLE_TABLES, isSyncableTable } from '../db/syncableTables.js';
import { canRemoteActivity, canApproveActivity } from '../services/remoteCapabilities.js';
import { findActivity } from '../../shared/constants/remoteAccess.js';
import { APPLY_HANDLERS, type Submission } from './applyHandlers.js';
import { audit } from '../services/auditService.js';

export type SyncState = 'disabled' | 'idle' | 'syncing' | 'error';

export interface SyncStatus {
  enabled: boolean;
  state: SyncState;
  nodeId: string | null;
  cloudConfigured: boolean;
  pendingOutbox: number;
  lastSyncAt: string | null;
  lastError: string | null;
  message: string;
}

export interface SyncResult {
  ok: boolean;
  skipped: boolean;
  pushed: number;
  pulled: number;
  message: string;
}

const DISABLED_MESSAGE =
  'Synchronization is planned but not enabled. The host runs fully offline; ' +
  'no data leaves this machine.';

export interface SyncEngine {
  status(): Promise<SyncStatus>;
  push(): Promise<SyncResult>;
  pull(): Promise<SyncResult>;
  processSubmissions(): Promise<{ processed: number }>;
  start(): void;
  stop(): void;
}

/** Normalize a SQLite text timestamp or JS value to epoch ms (UTC). */
function toEpoch(value: unknown): number {
  if (value == null) return 0;
  if (value instanceof Date) return value.getTime();
  let s = String(value);
  if (!s.includes('T')) s = s.replace(' ', 'T');
  if (!/[zZ]|[+-]\d\d:?\d\d$/.test(s)) s += 'Z';
  const t = Date.parse(s);
  return Number.isNaN(t) ? 0 : t;
}

function toIso(value: unknown): string | null {
  const e = toEpoch(value);
  return e ? new Date(e).toISOString() : null;
}

class CloudSyncEngine implements SyncEngine {
  private cloud: PostgresStore | null = null;
  private schemaReady = false;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastError: string | null = null;
  private columnCache = new Map<string, string[]>();

  private enabledAndConfigured(): boolean {
    return config.sync.enabled && Boolean(config.sync.cloudUrl);
  }

  private cloudStore(): PostgresStore {
    if (!this.cloud) this.cloud = new PostgresStore(config.sync.cloudUrl as string);
    return this.cloud;
  }

  private async ensureSchema(): Promise<void> {
    if (this.schemaReady) return;
    await this.cloudStore().exec(`
      CREATE SEQUENCE IF NOT EXISTS synced_records_seq;
      CREATE TABLE IF NOT EXISTS synced_records (
        entity_table text NOT NULL,
        uuid text NOT NULL,
        data jsonb NOT NULL,
        updated_at timestamptz,
        deleted_at timestamptz,
        origin_node text,
        cloud_seq bigint NOT NULL,
        PRIMARY KEY (entity_table, uuid)
      );
      CREATE INDEX IF NOT EXISTS idx_synced_records_seq ON synced_records (cloud_seq);
    `);
    this.schemaReady = true;
  }

  private async nodeId(): Promise<string | null> {
    const row = await getStore().get<{ value: string }>("SELECT value FROM settings WHERE key = 'syncNodeId'");
    return row?.value ?? null;
  }

  private async localColumns(table: string): Promise<string[]> {
    const cached = this.columnCache.get(table);
    if (cached) return cached;
    const rows = await getStore().all<{ name: string }>(`PRAGMA table_info(${table})`);
    const cols = rows.map((r) => r.name);
    this.columnCache.set(table, cols);
    return cols;
  }

  /**
   * One-time initial replication of everything already in the database. The
   * change-capture outbox only records changes made *after* sync is enabled, so
   * without this an existing lab's data would never reach the cloud. Runs once
   * (guarded by settings.syncBackfillDone) at the start of the first push.
   */
  private async backfillIfNeeded(local: ReturnType<typeof getStore>, cloud: PostgresStore, node: string | null): Promise<number> {
    if ((await this.getSetting('syncBackfillDone')) === '1') return 0;
    let count = 0;
    for (const table of SYNCABLE_TABLES) {
      let rows: Record<string, unknown>[];
      try {
        rows = await local.all<Record<string, unknown>>(`SELECT * FROM ${table} WHERE uuid IS NOT NULL`);
      } catch {
        continue; // table absent in this build
      }
      for (const rec of rows) {
        const updatedAt = toIso(rec.updated_at) ?? toIso(rec.created_at) ?? new Date().toISOString();
        const deletedAt = rec.deleted_at ? toIso(rec.deleted_at) : null;
        await this.upsertCloud(cloud, table, String(rec.uuid), rec, updatedAt, deletedAt, node);
        count++;
      }
    }
    await this.setSetting('syncBackfillDone', '1');
    if (count) await this.setSetting('syncLastAt', new Date().toISOString());
    console.log(`[sync] initial backfill pushed ${count} existing record(s) to the cloud`);
    return count;
  }

  // ---- push: local -> cloud -------------------------------------------------
  async push(): Promise<SyncResult> {
    if (!this.enabledAndConfigured()) return { ok: false, skipped: true, pushed: 0, pulled: 0, message: DISABLED_MESSAGE };
    await this.ensureSchema();
    const local = getStore();
    const cloud = this.cloudStore();
    const node = await this.nodeId();
    let pushed = await this.backfillIfNeeded(local, cloud, node);
    const pending = await local.all<{ id: number; entity_table: string; entity_uuid: string | null; entity_id: number; operation: string }>(
      "SELECT id, entity_table, entity_uuid, entity_id, operation FROM sync_outbox WHERE sync_status = 'pending' ORDER BY id"
    );
    for (const row of pending) {
      if (!isSyncableTable(row.entity_table) || !row.entity_uuid) {
        await local.run("UPDATE sync_outbox SET sync_status = 'synced', synced_at = CURRENT_TIMESTAMP WHERE id = ?", [row.id]);
        continue;
      }
      if (row.operation === 'delete') {
        await this.upsertCloud(cloud, row.entity_table, row.entity_uuid, {}, new Date().toISOString(), new Date().toISOString(), node);
      } else {
        const rec = await local.get<Record<string, unknown>>(`SELECT * FROM ${row.entity_table} WHERE uuid = ?`, [row.entity_uuid]);
        if (rec) {
          const updatedAt = toIso(rec.updated_at) ?? toIso(rec.created_at) ?? new Date().toISOString();
          const deletedAt = rec.deleted_at ? toIso(rec.deleted_at) : null;
          await this.upsertCloud(cloud, row.entity_table, row.entity_uuid, rec, updatedAt, deletedAt, node);
        }
      }
      await local.run("UPDATE sync_outbox SET sync_status = 'synced', synced_at = CURRENT_TIMESTAMP WHERE id = ?", [row.id]);
      pushed++;
    }
    if (pushed) await this.setSetting('syncLastAt', new Date().toISOString());
    return { ok: true, skipped: false, pushed, pulled: 0, message: `Pushed ${pushed} change(s) to the cloud.` };
  }

  private async upsertCloud(cloud: PostgresStore, table: string, uuid: string, data: Record<string, unknown>, updatedAt: string, deletedAt: string | null, node: string | null): Promise<void> {
    await cloud.run(
      `INSERT INTO synced_records (entity_table, uuid, data, updated_at, deleted_at, origin_node, cloud_seq)
       VALUES (?, ?, ?::jsonb, ?, ?, ?, nextval('synced_records_seq'))
       ON CONFLICT (entity_table, uuid) DO UPDATE SET
         data = EXCLUDED.data, updated_at = EXCLUDED.updated_at, deleted_at = EXCLUDED.deleted_at,
         origin_node = EXCLUDED.origin_node, cloud_seq = nextval('synced_records_seq')
       WHERE synced_records.updated_at IS NULL OR EXCLUDED.updated_at IS NULL OR EXCLUDED.updated_at >= synced_records.updated_at`,
      [table, uuid, JSON.stringify(data), updatedAt, deletedAt, node]
    );
  }

  // ---- pull: cloud -> local -------------------------------------------------
  async pull(): Promise<SyncResult> {
    if (!this.enabledAndConfigured()) return { ok: false, skipped: true, pushed: 0, pulled: 0, message: DISABLED_MESSAGE };
    await this.ensureSchema();
    const local = getStore();
    const cloud = this.cloudStore();
    const node = await this.nodeId();
    const cursor = (await this.getSetting('syncPullCursor')) ?? '0';
    const remote = await cloud.all<{ entity_table: string; uuid: string; data: Record<string, unknown>; updated_at: unknown; deleted_at: unknown; cloud_seq: string }>(
      `SELECT entity_table, uuid, data, updated_at, deleted_at, cloud_seq
       FROM synced_records WHERE cloud_seq > ?::bigint AND (origin_node IS DISTINCT FROM ?) ORDER BY cloud_seq`,
      [cursor, node]
    );
    if (remote.length === 0) return { ok: true, skipped: false, pushed: 0, pulled: 0, message: 'Already up to date with the cloud.' };

    let pulled = 0;
    let maxSeq = cursor;
    // Suppress capture so applying pulled changes does not re-emit to the outbox.
    await local.run("UPDATE sync_control SET value = '0' WHERE key = 'capture'");
    try {
      for (const r of remote) {
        if (isSyncableTable(r.entity_table)) {
          await this.applyRemote(local, r.entity_table, r.uuid, r.data, r.updated_at, r.deleted_at);
          pulled++;
        }
        maxSeq = r.cloud_seq;
      }
    } finally {
      await local.run("UPDATE sync_control SET value = '1' WHERE key = 'capture'");
    }
    await this.setSetting('syncPullCursor', String(maxSeq));
    if (pulled) await this.setSetting('syncLastAt', new Date().toISOString());
    return { ok: true, skipped: false, pushed: 0, pulled, message: `Pulled ${pulled} change(s) from the cloud.` };
  }

  private async applyRemote(local: ReturnType<typeof getStore>, table: string, uuid: string, data: Record<string, unknown>, remoteUpdatedAt: unknown, remoteDeletedAt: unknown): Promise<void> {
    const existing = await local.get<{ id: number; updated_at: string | null }>(`SELECT id, updated_at FROM ${table} WHERE uuid = ?`, [uuid]);
    // Tombstone: soft-delete locally.
    if (remoteDeletedAt) {
      if (existing) await local.run(`UPDATE ${table} SET deleted_at = ? WHERE uuid = ?`, [toIso(remoteDeletedAt), uuid]);
      return;
    }
    const cols = await this.localColumns(table);
    const keys = Object.keys(data).filter((k) => cols.includes(k) && k !== 'id');
    if (existing) {
      // Last-writer-wins: skip if the local copy is newer.
      if (toEpoch(existing.updated_at) > toEpoch(remoteUpdatedAt)) return;
      const setKeys = keys.filter((k) => k !== 'uuid');
      if (setKeys.length === 0) return;
      const assignments = setKeys.map((k) => `${k} = ?`).join(', ');
      await local.run(`UPDATE ${table} SET ${assignments} WHERE uuid = ?`, [...setKeys.map((k) => data[k] as unknown), uuid]);
    } else {
      const insKeys = keys.includes('uuid') ? keys : [...keys, 'uuid'];
      const values = insKeys.map((k) => (k === 'uuid' ? uuid : (data[k] as unknown)));
      const placeholders = insKeys.map(() => '?').join(', ');
      await local.run(`INSERT INTO ${table} (${insKeys.join(', ')}) VALUES (${placeholders})`, values);
    }
  }

  // ---- inbound submissions (R3): cloud -> Host apply ------------------------
  private async ensureSubmissionsSchema(): Promise<void> {
    await this.cloudStore().exec(`
      CREATE TABLE IF NOT EXISTS remote_submissions (
        id bigserial PRIMARY KEY,
        submission_uuid text UNIQUE NOT NULL,
        actor_staff_id integer NOT NULL,
        actor_email text,
        activity text NOT NULL,
        target_table text,
        target_uuid text,
        base_version text,
        payload jsonb,
        status text NOT NULL DEFAULT 'pending_sync',
        result text,
        created_at timestamptz NOT NULL DEFAULT now(),
        processed_at timestamptz
      );
      CREATE INDEX IF NOT EXISTS idx_remote_submissions_status ON remote_submissions (status);
      ALTER TABLE remote_submissions ADD COLUMN IF NOT EXISTS decision text;
      ALTER TABLE remote_submissions ADD COLUMN IF NOT EXISTS decided_by_staff_id integer;
      ALTER TABLE remote_submissions ADD COLUMN IF NOT EXISTS decided_by_email text;
      ALTER TABLE remote_submissions ADD COLUMN IF NOT EXISTS decision_reason text;
      ALTER TABLE remote_submissions ADD COLUMN IF NOT EXISTS decided_at timestamptz;
    `);
  }

  /** Run an activity's apply handler in a transaction. Capture is left ON so
   *  changes to syncable tables replicate back and the portal reflects them. */
  private runApply(db: ReturnType<typeof getDb>, s: Submission): { status: string; message: string } {
    const handler = APPLY_HANDLERS[s.activity];
    if (!handler) return { status: 'rejected', message: 'No apply handler for this activity yet.' };
    try {
      const result = db.transaction(() => handler(db, s))();
      if (result.ok) {
        audit(undefined, { action: 'remote_apply', entity: 'remote_submission', entityId: s.submission_uuid, newValue: { activity: s.activity, actorStaffId: s.actor_staff_id, message: result.message } });
        return { status: 'applied', message: result.message };
      }
      return { status: 'rejected', message: result.message };
    } catch (err) {
      return { status: 'rejected', message: err instanceof Error ? err.message : 'Apply failed.' };
    }
  }

  async processSubmissions(): Promise<{ processed: number }> {
    if (!this.enabledAndConfigured()) return { processed: 0 };
    await this.ensureSchema();
    await this.ensureSubmissionsSchema();
    const cloud = this.cloudStore();
    const db = getDb();
    let processed = 0;

    // Pass 1: newly-submitted proposals. Validate the requester first, then
    // auto-apply, or park approval-tier activities for a decision.
    const pending = await cloud.all<Submission>(
      `SELECT id, submission_uuid, actor_staff_id, actor_email, activity, target_table, target_uuid, base_version, payload
         FROM remote_submissions WHERE status = 'pending_sync' ORDER BY id`
    );
    for (const s of pending) {
      let status = 'rejected';
      let message = '';
      const def = findActivity(s.activity);
      if (!def) message = 'Unknown activity.';
      else if (!canRemoteActivity(s.actor_staff_id, s.activity)) message = 'Not permitted for this staff member.';
      else if (def.tier === 'approval') { status = 'awaiting_approval'; message = 'Awaiting approval.'; }
      else { const r = this.runApply(db, s); status = r.status; message = r.message; }
      await cloud.run(
        `UPDATE remote_submissions SET status = ?, result = ?, processed_at = CASE WHEN ? = 'awaiting_approval' THEN NULL ELSE now() END WHERE id = ?`,
        [status, message, status, s.id]
      );
      processed++;
    }

    // Pass 2: decided approvals. Re-validate the approver's authority (and that
    // the requester is still permitted), then apply or reject — all on the Host.
    const decided = await cloud.all<Submission & { decision: string | null; decision_reason: string | null }>(
      `SELECT id, submission_uuid, actor_staff_id, actor_email, activity, target_table, target_uuid, base_version, payload, decided_by_staff_id, decision, decision_reason
         FROM remote_submissions WHERE status = 'awaiting_approval' AND decision IS NOT NULL AND processed_at IS NULL ORDER BY id`
    );
    for (const s of decided) {
      let status = 'rejected';
      let message = '';
      if (!s.decided_by_staff_id || !canApproveActivity(s.decided_by_staff_id, s.activity)) {
        message = 'Approver is not authorized.';
      } else if (s.decision === 'reject') {
        message = s.decision_reason || 'Rejected by approver.';
      } else if (!canRemoteActivity(s.actor_staff_id, s.activity)) {
        message = 'Requester is no longer permitted.';
      } else {
        const r = this.runApply(db, s); status = r.status; message = r.message;
      }
      await cloud.run(`UPDATE remote_submissions SET status = ?, result = ?, processed_at = now() WHERE id = ?`, [status, message, s.id]);
      processed++;
    }
    return { processed };
  }

  // ---- settings helpers -----------------------------------------------------
  private async getSetting(key: string): Promise<string | null> {
    const row = await getStore().get<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key]);
    return row?.value ?? null;
  }
  private async setSetting(key: string, value: string): Promise<void> {
    await getStore().run(
      'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP',
      [key, value]
    );
  }

  // ---- status & lifecycle ---------------------------------------------------
  async status(): Promise<SyncStatus> {
    const local = getStore();
    let nodeId: string | null = null;
    let pendingOutbox = 0;
    let lastSyncAt: string | null = null;
    try {
      nodeId = await this.nodeId();
      pendingOutbox = (await local.get<{ c: number }>("SELECT COUNT(*) AS c FROM sync_outbox WHERE sync_status = 'pending'"))?.c ?? 0;
      lastSyncAt = await this.getSetting('syncLastAt');
    } catch { /* partially-initialized DB */ }
    const enabled = this.enabledAndConfigured();
    return {
      enabled,
      state: this.lastError ? 'error' : enabled ? 'idle' : 'disabled',
      nodeId,
      cloudConfigured: Boolean(config.sync.cloudUrl),
      pendingOutbox,
      lastSyncAt,
      lastError: this.lastError,
      message: enabled
        ? 'Synchronization is enabled. The host stays authoritative; changes replicate to the cloud.'
        : DISABLED_MESSAGE,
    };
  }

  private async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.processSubmissions();
      await this.push();
      await this.pull();
      this.lastError = null;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      console.error('[sync] cycle failed:', this.lastError);
    } finally {
      this.running = false;
    }
  }

  start(): void {
    if (!this.enabledAndConfigured()) {
      console.log('[sync] disabled — engine not started (offline-first; no data leaves this host)');
      return;
    }
    console.log(`[sync] enabled — replicating to cloud every ${config.sync.intervalMs}ms`);
    setTimeout(() => void this.runOnce(), 5000);
    this.timer = setInterval(() => void this.runOnce(), config.sync.intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.cloud) { void this.cloud.close().catch(() => {}); this.cloud = null; }
  }
}

let engine: SyncEngine | undefined;

export function getSyncEngine(): SyncEngine {
  if (!engine) engine = new CloudSyncEngine();
  return engine;
}
