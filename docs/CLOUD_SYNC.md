# Cloud synchronization

> Cloud phase of the offline-first hybrid architecture. See
> `docs/HYBRID_ARCHITECTURE_PLAN.md`. Sync is **opt-in and off by default** — with
> it disabled the host runs exactly as before and no data leaves the machine.

## Principles

- The **Host PC stays authoritative**. It always reads and writes its local
  SQLite database, online or offline. The cloud is a replica, never a runtime
  dependency.
- Sync activates only when **both** `SECH_LIMS_SYNC_ENABLED=true` **and**
  `SECH_LIMS_CLOUD_URL` (a PostgreSQL connection string, e.g. Neon) are set.

## Replication model — JSONB document store

Rather than mirroring ~21 relational schemas in the cloud, each syncable row is
serialized and upserted into a single cloud table, keyed by `(entity_table,
uuid)`:

```sql
CREATE TABLE synced_records (
  entity_table text NOT NULL,
  uuid         text NOT NULL,
  data         jsonb NOT NULL,      -- the full row
  updated_at   timestamptz,         -- for last-writer-wins
  deleted_at   timestamptz,         -- tombstone
  origin_node  text,                -- which host produced the change
  cloud_seq    bigint NOT NULL,     -- monotonic; the pull watermark
  PRIMARY KEY (entity_table, uuid)
);
```

The engine creates this automatically on first run. Cloud consumers (dashboards,
a Vercel web app) read `synced_records` directly; a richer relational cloud
schema can be layered on later without changing the host.

## The engine (`server/sync/syncEngine.ts`)

- **push()** drains `sync_outbox` (populated by the dormant-until-enabled capture
  triggers), reads each row's current local state, and upserts it into
  `synced_records`. Deletes become tombstones. Processed outbox rows are marked
  `synced`.
- **pull()** reads `synced_records` with `cloud_seq` greater than a stored
  watermark and `origin_node` other than this host, then merges each into the
  local table by `uuid`. Capture is suppressed (`sync_control.capture = '0'`)
  while applying, so pulled changes are **not** re-emitted to the outbox — no echo
  loop. The watermark advances to the highest `cloud_seq` seen.
- **Conflict resolution** is last-writer-wins by `updated_at`; `deleted_at`
  tombstones propagate deletions.
- **start()** runs a push+pull cycle every `SECH_LIMS_SYNC_INTERVAL_MS` (and once
  shortly after boot) when enabled; it is a no-op when disabled.

### API

- `GET /api/sync/status` — enabled/state, node id, pending-outbox count, last sync.
- `POST /api/sync/run` `{ "direction": "push" | "pull" | "both" }` — trigger a
  cycle on demand (settings permission).

Surfaced in **Settings → System → Connectivity & Mode**.

## Enabling sync against Neon

1. Create a Neon project and database; copy the connection string.
2. On the Host, set:
   ```
   SECH_LIMS_SYNC_ENABLED=true
   SECH_LIMS_CLOUD_URL=postgres://USER:PASSWORD@HOST/DB?sslmode=require
   ```
3. Restart the host. The engine provisions `synced_records` and begins
   replicating on the configured interval. Watch `GET /api/sync/status`.

`SECH_LIMS_DB_DRIVER=postgres` + `SECH_LIMS_PG_URL` is a separate, advanced option
that points the DataStore itself at PostgreSQL (via `PostgresStore`); the normal
hybrid deployment keeps the host on SQLite and only *replicates* to the cloud.

## Vercel web frontend (deployment scaffolding)

`vercel.json` builds the SPA and serves it with SPA-history rewrites. The hosted
frontend reaches its data by pointing `VITE_API_BASE_URL` at a reachable API:

- **Near term:** the Host API over secure remote access (VPN/tunnel/reverse
  proxy), reusing everything that already works on the LAN.
- **Later:** a thin cloud read-API over `synced_records` deployed alongside the
  frontend, for staff who are fully remote from the Host.

Deploying the frontend and provisioning Neon require live credentials and are
performed in your Vercel/Neon accounts; the app code and config here are ready
for it.

## Security notes

- Treat `SECH_LIMS_CLOUD_URL` as a secret (it contains DB credentials); set it via
  the environment, never commit it. `.env` is gitignored.
- Use `sslmode=require` for cloud PostgreSQL connections.
- Remote access to the Host API must be fronted by TLS and authentication before
  exposing it beyond the LAN.
