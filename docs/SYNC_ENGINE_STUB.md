# Sync engine — reserved contract (stub)

> Phase 5 of the offline-first hybrid architecture. See
> `docs/HYBRID_ARCHITECTURE_PLAN.md`. **No synchronization runs.** This phase only
> fixes the interface so the future cloud engine and the UI have a stable contract
> to build against.

## Pieces

| File | Role |
|---|---|
| `server/sync/syncEngine.ts` | `SyncEngine` interface + `StubSyncEngine` (self-gates on `config.sync.enabled`, does nothing) + `getSyncEngine()` singleton. |
| `server/routes/sync.ts` | REST surface: `GET /api/sync/status`, `POST /api/sync/run`. |

The engine reads through the **DataStore** (`getStore()`), not better-sqlite3
directly, so the real implementation already speaks the backend-agnostic layer.
It is started at boot alongside the other background services and immediately
returns because sync is disabled.

## The contract

### `GET /api/sync/status` (auth required)

```jsonc
{
  "enabled": false,           // config.sync.enabled (SECH_LIMS_SYNC_ENABLED)
  "state": "disabled",        // disabled | idle | syncing | error
  "nodeId": "…uuid…",         // settings.syncNodeId — this host's identity
  "cloudConfigured": false,   // config.sync.cloudUrl present?
  "pendingOutbox": 0,         // COUNT(sync_outbox WHERE sync_status='pending')
  "lastSyncAt": null,
  "lastError": null,
  "message": "Synchronization is planned but not enabled. …"
}
```

### `POST /api/sync/run` (settings permission)

Body `{ "direction": "push" | "pull" | "both" }` (default `both`). While disabled
it returns a skipped result:

```jsonc
{ "ok": false, "skipped": true, "pushed": 0, "pulled": 0, "message": "Synchronization is planned but not enabled. …" }
```

## How the real engine will use this (later)

1. Local mutations record to `sync_outbox` (Phase 3 scaffolding).
2. `push()` reads `pending` outbox rows, sends them to the cloud database
   (keyed by `uuid`), marks them `synced`, and updates `lastSyncAt`.
3. `pull()` fetches remote changes and merges by `uuid` using `updated_at`
   (last-writer-wins) and `deleted_at` tombstones.
4. `start()` runs that loop every `config.sync.intervalMs` when
   `config.sync.enabled` is true and `config.sync.cloudUrl` is set.

Turning it on will be a driver/implementation change plus flipping
`SECH_LIMS_SYNC_ENABLED` — the API surface and UI stay the same.

## UI

**Settings → System → Connectivity & Mode** reads `GET /api/sync/status` and shows
the node id, whether a cloud endpoint is configured, the pending-outbox count, and
the last-sync time — so the dormant machinery is observable today.
