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

## Remote read-only portal (Vercel + Neon)

For staff who are fully remote from the Host — even when the Host PC is off —
there is a **read-only cloud portal** hosted on Vercel and backed directly by
Neon. Writes still happen only on the Host (offline-first authority); the portal
is a view of the replicated data.

Pieces (all in this repo):

| Path | Role |
|---|---|
| `api/cloud/summary.ts` | `GET /api/cloud/summary` — live record counts per entity type. |
| `api/cloud/records.ts` | `GET /api/cloud/records?entity=risks` — records of a type (deleted excluded). |
| `api/cloud/record.ts` | `GET /api/cloud/record?entity=risks&uuid=…` — one record. |
| `api/_lib/cloudDb.ts` | Read-only queries over `synced_records` (via `pg`). |
| `api/_lib/auth.ts` | Shared-token gate (`CLOUD_API_TOKEN`), fails closed. |
| `portal/index.html` | Self-contained read-only portal UI (no build step). |
| `vercel.json` | Serves `portal/` as the site and `api/cloud/*` as serverless functions. |

### Authentication (R1 — per-staff accounts)

The portal uses per-staff cloud accounts (not a shared token):

- Accounts live in Neon `cloud_users` and are **provisioned from the Host** —
  `POST /api/remote-access/users` (Settings permission), which hashes a
  cloud-specific password and writes it to Neon. Host login hashes are never
  copied. Manage/disable via `GET /api/remote-access/users` and
  `POST /api/remote-access/users/:id/status`.
- Staff sign in at the portal with email + password (`POST /api/portal/login`),
  receive a short-lived JWT (signed with `CLOUD_JWT_SECRET`), and must replace
  their temporary password on first login (`POST /api/portal/change-password`).
- All portal reads require a valid JWT. `CLOUD_API_TOKEN`, if set, remains a
  legacy read-only fallback; prefer per-staff accounts and leave it unset.

> R1 (identity & auth) and R2 (RBAC + tier engine) of
> `docs/REMOTE_STAFF_PORTAL_PLAN.md` are implemented, plus R3's first slice.

### Remote editing (R3 — propose → validate → apply)

Beyond viewing, permitted staff can submit changes without ever writing to
authoritative data directly:

1. The portal calls `POST /api/portal/submit` (JWT); the actor is taken from the
   token, and the proposal is queued in the cloud `remote_submissions` table.
2. The Host sync engine pulls pending submissions each cycle, **re-validates**
   them against its authoritative permissions (`canRemoteActivity`), and applies
   auto-tier activities via a handler registry (`server/sync/applyHandlers.ts`);
   approval-tier activities are parked as `awaiting_approval` (R4). Every apply is
   audited.
3. The outcome is written back; staff see it under **My submissions** in the
   portal (`GET /api/portal/submissions`).

Shipped self-service activities (auto-apply, ownership enforced on the Host):
**SOP/document acknowledgement**, **own-profile update** (contact fields), and
**assigned-task update** (status/notes — only the task's assignee may update it,
via the "My work" view). Notification acknowledgement is deferred until
notifications are replicated to the cloud; approval-tier activities (incidents,
CAPA closure, leave, inventory) arrive with R4/R5. The Host never trusts the
client for identity, permission, or ownership — it re-checks everything.

### Deploy

1. Import this repo into **Vercel** (it uses `vercel.json` — static `portal/` +
   `api/` functions; no framework build).
2. In the Vercel project, set **Environment Variables**:
   - `DATABASE_URL` — your Neon connection string (the same database the Host
     replicates into).
   - `CLOUD_JWT_SECRET` — a long random secret for signing login tokens.
   - `CLOUD_API_TOKEN` — optional legacy shared read token (can be omitted).
3. On the Host (with `SECH_LIMS_CLOUD_URL` set), provision staff accounts via
   `/api/remote-access/users`.
4. Deploy. Remote staff open the Vercel URL, sign in with their email + password,
   set a new password, and browse the synced data (read-only).

### Notes

- The portal reads only `synced_records`, so it shows exactly what the Host has
  replicated — keep the Host syncing to keep the portal current.
- The shared token is intentionally simple for a read-only view. Per-user cloud
  authentication is a future enhancement; the Host remains the system of record
  with full role-based access control.
- The **full, editable** application is the Host app, reached over the LAN or via
  secure remote access (VPN/tunnel such as Tailscale). The Vercel portal
  complements it for lightweight, always-available remote viewing.

## Security notes

- Treat `SECH_LIMS_CLOUD_URL` as a secret (it contains DB credentials); set it via
  the environment, never commit it. `.env` is gitignored.
- Use `sslmode=require` for cloud PostgreSQL connections.
- Remote access to the Host API must be fronted by TLS and authentication before
  exposing it beyond the LAN.
