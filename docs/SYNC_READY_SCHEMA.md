# Sync-ready schema — dormant scaffolding

> Phase 3 of the offline-first hybrid architecture. See
> `docs/HYBRID_ARCHITECTURE_PLAN.md`. **Nothing here activates synchronization.**
> It only prepares the data so sync can be added later without a disruptive
> schema migration on live laboratory databases.

## What was added

All changes live in the idempotent `migrate()` in `server/db/database.ts` and run
transparently on the existing local database.

### 1. Per-table sync fields

For each table in the `SYNCABLE_TABLES` list, the migration ensures three
columns exist:

| Column | Purpose |
|---|---|
| `uuid` | Globally-unique record id. Integer autoincrement PKs collide across nodes; a UUID does not. Backfilled for existing rows and auto-assigned to new rows by a trigger. Unique index enforced. |
| `updated_at` | Last-modified timestamp for last-writer-wins / merge resolution. Added only if the table did not already have it. |
| `deleted_at` | Soft-delete marker so a deletion can propagate instead of leaving a gap. Unused by current queries. |

New rows get a `uuid` automatically via an `AFTER INSERT` trigger
(`trg_<table>_uuid`) that fires only when `NEW.uuid IS NULL`. This keeps every
row covered while sync is dormant, **without changing any existing INSERT code**.

Currently in scope (`SYNCABLE_TABLES`):

```
nonconforming_events, capa_records, complaints, risks,
equipment_items, equipment_maintenance_records, equipment_calibration_records,
inventory_items, inventory_batches, suppliers,
monitoring_items, monitoring_readings, safety_incidents,
actions, documents, document_versions,
iqc_materials, iqc_results, eqa_programs, eqa_events, staff
```

Config singletons (e.g. `laboratory_profile`), append-only logs (`audit_logs`)
and auth tables are intentionally excluded. Extend the list to bring more record
streams into scope — the migration is safe to re-run and skips tables that are
already done or absent.

### 2. Change-log / outbox — `sync_outbox`

A dormant table that a future sync engine will use to record local mutations and
track which have been pushed to the cloud:

| Column | Meaning |
|---|---|
| `entity_table`, `entity_uuid`, `entity_id` | What changed. |
| `operation` | `insert` \| `update` \| `delete`. |
| `payload` | Optional JSON snapshot of the change. |
| `origin_node` | Node id that produced it. |
| `created_at`, `synced_at` | When recorded / when pushed. |
| `sync_status` | `pending` \| `synced` \| `failed`. |

**Capture is gated on `SECH_LIMS_SYNC_ENABLED`.** While sync is off (the
default) the outbox stays empty and has zero overhead. When the flag is enabled,
`migrate()` installs capture triggers on the syncable tables that record each
change into `sync_outbox` (entity, uuid, operation, origin node); turning the
flag off again drops those triggers.

Because SQLite has no `BEFORE INSERT` way to assign `NEW.uuid` and does not
guarantee trigger fire-order, capture keys off `UPDATE` rather than a separate
`INSERT` trigger: the uuid-backfill's own update (uuid moving from NULL to set)
is recorded as the `insert` event with a guaranteed uuid, genuine edits as
`update`, and hard deletes via an `AFTER DELETE` trigger. This yields exactly one
outbox row per logical change, each carrying the record's uuid. Writing an outbox
row is purely local — it sends nothing anywhere. The rows are drained by the sync
engine (a stub today; see `docs/SYNC_ENGINE_STUB.md`).

### 3. Node identity — `settings.syncNodeId`

A stable per-host UUID, seeded once, that will attribute outbox entries to their
originating node once multiple nodes participate.

## Why this is safe today

- New columns are nullable and unread by existing queries, so behaviour is
  unchanged.
- The UUID trigger only acts when `uuid` is `NULL`, so it is transparent.
- The unique index tolerates the backfill because existing rows are populated
  before the index is created.
- Everything is guarded and idempotent — re-running `migrate()` is a no-op after
  the first pass, and tables missing from a given build are skipped.

## How sync will use this later (not built yet)

1. Write mutations to `sync_outbox` (e.g. via the DataStore or triggers).
2. A sync engine reads `pending` rows, pushes them to the cloud database
   (keyed by `uuid`), and marks them `synced`.
3. It pulls remote changes and merges by `uuid` using `updated_at`
   (last-writer-wins) and `deleted_at` for tombstones.

See `docs/HYBRID_ARCHITECTURE_PLAN.md` for the sync-engine seam (Phase 5) that
will consume this scaffolding.
