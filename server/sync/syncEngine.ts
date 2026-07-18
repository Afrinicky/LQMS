/**
 * SyncEngine — the synchronization seam (Phase 5 of the hybrid architecture).
 *
 * This is a STUB. No data is synchronized in this phase; the engine self-gates on
 * config.sync.enabled (SECH_LIMS_SYNC_ENABLED), which stays false. Its purpose is
 * to reserve a stable contract — status()/push()/pull()/start()/stop() and the
 * SyncStatus shape — that the UI and a future cloud implementation can build
 * against without further churn. See docs/SYNC_ENGINE_STUB.md and
 * docs/HYBRID_ARCHITECTURE_PLAN.md ("LATER" phase).
 *
 * It reads through the DataStore (getStore) rather than better-sqlite3 directly,
 * so when a real engine is written it already speaks the backend-agnostic layer.
 */
import { config } from '../config/index.js';
import { getStore } from '../db/store.js';

export type SyncState = 'disabled' | 'idle' | 'syncing' | 'error';

export interface SyncStatus {
  /** Whether synchronization is switched on (config.sync.enabled). */
  enabled: boolean;
  /** Coarse state for the UI. Always 'disabled' in this phase. */
  state: SyncState;
  /** This host's stable node id (settings.syncNodeId), or null if unseeded. */
  nodeId: string | null;
  /** Whether a cloud endpoint is configured (config.sync.cloudUrl). */
  cloudConfigured: boolean;
  /** Count of un-pushed rows in the dormant sync_outbox. */
  pendingOutbox: number;
  /** Timestamp of the last successful sync, or null (never, in this phase). */
  lastSyncAt: string | null;
  /** Last error message, if any. */
  lastError: string | null;
  /** Human-readable summary for the UI. */
  message: string;
}

export interface SyncResult {
  ok: boolean;
  /** True when the operation was intentionally not performed (sync disabled). */
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
  start(): void;
  stop(): void;
}

class StubSyncEngine implements SyncEngine {
  async status(): Promise<SyncStatus> {
    const store = getStore();
    let nodeId: string | null = null;
    let pendingOutbox = 0;
    try {
      const node = await store.get<{ value: string }>("SELECT value FROM settings WHERE key = 'syncNodeId'");
      nodeId = node?.value ?? null;
      const pending = await store.get<{ c: number }>("SELECT COUNT(*) AS c FROM sync_outbox WHERE sync_status = 'pending'");
      pendingOutbox = pending?.c ?? 0;
    } catch {
      // sync_outbox / settings absent in a partially-initialized DB — report zero.
    }
    return {
      enabled: config.sync.enabled,
      state: config.sync.enabled ? 'idle' : 'disabled',
      nodeId,
      cloudConfigured: Boolean(config.sync.cloudUrl),
      pendingOutbox,
      lastSyncAt: null,
      lastError: null,
      message: config.sync.enabled
        ? 'Synchronization is enabled but no engine implementation is active yet.'
        : DISABLED_MESSAGE,
    };
  }

  async push(): Promise<SyncResult> {
    return { ok: false, skipped: true, pushed: 0, pulled: 0, message: DISABLED_MESSAGE };
  }

  async pull(): Promise<SyncResult> {
    return { ok: false, skipped: true, pushed: 0, pulled: 0, message: DISABLED_MESSAGE };
  }

  start(): void {
    if (!config.sync.enabled) {
      console.log('[sync] disabled — engine not started (offline-first; no data leaves this host)');
      return;
    }
    // A real periodic push/pull loop will live here when the cloud phase lands.
    console.log('[sync] enabled flag set, but the engine is a stub in this build — no sync performed');
  }

  stop(): void {
    /* no-op while stubbed */
  }
}

let engine: SyncEngine | undefined;

export function getSyncEngine(): SyncEngine {
  if (!engine) engine = new StubSyncEngine();
  return engine;
}
