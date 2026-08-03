# SECH_LIMS — Offline-First Hybrid Architecture Plan

> **Status:** Planning only. This document defines the target architecture and a
> phased roadmap. **No cloud synchronization is implemented in this phase** — we
> only design the seams so it can be added later without major code changes.
>
> **Scope decisions locked for this plan:**
> - **Mobile client:** Progressive Web App (PWA), reusing the existing SPA.
> - **Desktop client:** Both an Electron thin client *and* plain-browser access
>   to the same Host.
> - **Cloud sync:** Designed-for, not built. Future target is a cloud PostgreSQL
>   (e.g. Neon) plus a Vercel-hosted web frontend.

---

## 1. Goal

Convert SECH_LIMS from a fully offline, single-PC desktop application into an
**offline-first hybrid system**:

- The **Host PC** remains the single source of truth and runs everything:
  PostgreSQL-or-SQLite database, backend API, Dennis AI, device integrations,
  file storage, and all background services.
- **Desktop clients** connect to the Host over the local LAN.
- **Mobile clients** connect to the Host over the LAN now, and over secure
  remote access later.
- The architecture must let us add **cloud synchronization** (cloud PostgreSQL +
  Vercel web frontend) later **without major code changes**.
- **All laboratory functionality must keep working with no internet** —
  instrument integrations, environmental monitoring, printers, and workflows.

The problem this solves: today the system is fully offline, so staff who are out
of the laboratory cannot reach it. The hybrid design adds LAN clients now and a
clean path to secure remote/cloud access later, while never making the lab
depend on the internet to operate.

---

## 2. Current architecture (as-built)

| Layer | Today | Key file(s) |
|---|---|---|
| Frontend | React + Vite single-page app | `src/` |
| Backend | Express, ~40 route modules under `/api/*` | `server/index.ts`, `server/routes/*` |
| Database | SQLite via `better-sqlite3` (synchronous), WAL mode, inline migrations | `server/db/database.ts` |
| Desktop shell | Electron embeds the API in-process and serves the renderer same-origin | `electron/main.ts`, `electron/apiServer.ts` |
| Auth | Bearer tokens persisted in `auth_sessions` | `server/middleware/auth.ts` |
| AI (Dennis) | Offline-placeholder engine | `server/services/dennisService.ts`, `server/utils/dennisEngine.ts` |
| Background services | Environmental poller + alert scheduler | `server/index.ts:151-160` |
| Config | Scattered `process.env` reads + `settings` / `laboratory_profile` tables | `server/db/database.ts:5`, `electron/apiServer.ts:60-61` |
| LAN | Supported via `SECH_LIMS_API_HOST=0.0.0.0`; `devices` table holds a pairing scaffold (deferred) | `electron/apiServer.ts:43`, `README.md:42` |

### What is already in our favour

- The system is **already offline-first** and **LAN-capable** — the API can bind
  to `0.0.0.0` and serve the built renderer same-origin.
- The frontend **already resolves its API base URL dynamically**
  (`src/services/api.ts:31`): preload value → `VITE_API_BASE_URL` → same-origin →
  localhost. A client pointed at a different Host URL needs no code change.
- A **device pairing scaffold** exists (`devices` table with pairing codes).
- Data location is already env-configurable (`SECH_LIMS_DATA_DIR`).

Nothing here needs to be torn down. This is an extension, not a rewrite.

### The one hard problem

Every route module calls `getDb().prepare("...raw SQLite SQL...")` **directly**.
There is **no data-access seam**. Swapping to a cloud PostgreSQL (Neon) today
would mean rewriting ~40 files of SQLite-dialect SQL. Fixing this — introducing a
data-access abstraction — is the single most important structural change, and it
can be done without touching business logic.

---

## 3. Target architecture

```
                 HOST PC  (the lab's main computer — always the source of truth)
 ┌───────────────────────────────────────────────────────────────────────────┐
 │  Electron shell (electron/main.ts)                                         │
 │    └─ Embedded Node API (Express)  ── binds 0.0.0.0:4317 on the LAN        │
 │         ├─ Route modules (/api/*)         ← business logic UNCHANGED        │
 │         ├─ Data Access Layer  (NEW seam)                                   │
 │         │     ├─ SqliteStore   (ships now, local)                          │
 │         │     └─ PostgresStore (stub now → Neon later)                     │
 │         ├─ Dennis AI · device integrations · printers · env monitoring     │
 │         ├─ Background services (environmental poller, alert scheduler)     │
 │         ├─ File storage (local-data/)                                      │
 │         └─ Sync Engine (STUB now, disabled; implemented later)             │
 └───────────────────────────────────────────────────────────────────────────┘
        ▲ LAN (HTTP/REST + Bearer token)             ▲ remote (LATER: VPN/TLS tunnel)
        │                                            │
 ┌──────┴───────────────┐  ┌──────────────────┐  ┌──┴──────────────────────┐
 │ Desktop clients      │  │ Mobile clients   │  │ Cloud (LATER)           │
 │  • Electron thin     │  │  • PWA over LAN  │  │  • PostgreSQL (Neon)    │
 │    client            │  │  • PWA remote    │  │  • Vercel web frontend  │
 │  • Plain browser     │  │    (later)       │  │    (read / sync target) │
 └──────────────────────┘  └──────────────────┘  └─────────────────────────┘
```

**Principles**

1. **Offline-first, always.** The Host operates fully without internet. Cloud is
   an optional *third consumer/replica*, never a runtime dependency.
2. **One API, many clients.** Desktop (Electron or browser), mobile (PWA), and
   the future cloud all speak the same `/api` REST contract.
3. **Clean separation** between frontend, backend, synchronization, and device
   services, so any one can evolve without breaking the others.
4. **Everything configurable via environment variables** — URLs, DB connections,
   mode, and sync settings.

---

## 4. Structural changes and why each is needed

### 4.1 Centralized config module — *replace scattered `process.env` reads*

Env vars are currently read ad-hoc across `database.ts`, `apiServer.ts`,
`index.ts`, and `preload.cjs`. Introduce `server/config/index.ts` that reads and
validates the environment **once** and exposes a typed, immutable `config`
object. This is what makes "all URLs, DB connections and sync settings
configurable through env vars" concrete and testable.

```ts
// server/config/index.ts  (design sketch)
export type AppMode = 'local' | 'hybrid';
export type DbDriver = 'sqlite' | 'postgres';

export const config = {
  mode: (process.env.SECH_LIMS_MODE ?? 'local') as AppMode,
  api: {
    host: process.env.SECH_LIMS_API_HOST ?? '127.0.0.1', // 0.0.0.0 to serve LAN
    port: Number(process.env.API_PORT ?? 4317),
    publicUrl: process.env.SECH_LIMS_PUBLIC_URL ?? null,  // remote access (later)
  },
  db: {
    driver: (process.env.SECH_LIMS_DB_DRIVER ?? 'sqlite') as DbDriver,
    sqlitePath: process.env.SECH_LIMS_DB_PATH ?? undefined,
    postgresUrl: process.env.SECH_LIMS_PG_URL ?? null,     // Neon (later)
  },
  sync: {
    enabled: process.env.SECH_LIMS_SYNC_ENABLED === 'true', // stays false for now
    cloudUrl: process.env.SECH_LIMS_CLOUD_URL ?? null,
    intervalMs: Number(process.env.SECH_LIMS_SYNC_INTERVAL_MS ?? 60000),
  },
} as const;
```

### 4.2 Data Access Layer — *the critical seam*

Introduce `server/db/dataStore.ts`: an interface the routes call **instead of**
`better-sqlite3` directly. Two implementations:

- `SqliteStore` — wraps today's synchronous behaviour; ships now.
- `PostgresStore` — an empty stub now, filled in when going cloud.

Routes migrate from:

```ts
const row = getDb().prepare('SELECT * FROM risks WHERE id = ?').get(id);
```

to a store-mediated call (exact shape finalized during Phase 2). Because the
migration touches ~40 files, it is staged **module-by-module behind a
compatibility shim**, so the app keeps running throughout. This is the change
that lets us later point at Neon "without major code changes."

> Note: `better-sqlite3` is synchronous while Postgres drivers are async. The
> store interface is defined **async-first** so both drivers satisfy it; the
> SQLite implementation simply resolves immediately. This avoids a second rewrite
> when Postgres arrives.

### 4.3 Sync-ready schema conventions — *schema only, no sync logic*

Offline-first multi-node sync needs three things on syncable tables. Add them now
as **dormant, no-op-safe** structures so data is *ready* even though sync is off:

- a **globally unique id** (`uuid` column beside the existing INTEGER PK —
  autoincrement integer PKs collide across nodes);
- `updated_at` **+ soft-delete** (`deleted_at`) to support last-writer-wins /
  merge resolution;
- a **change-log / outbox table** (`sync_outbox`) that records mutations. It
  stays empty and unread until sync is switched on.

No behaviour changes today; when sync arrives, the history is already captured.

### 4.4 Local Mode vs Hybrid Mode

Two layers, matching the existing pattern (`hostMode` in `setup.ts` /
`laboratory_profile`):

- **Env var** `SECH_LIMS_MODE=local|hybrid` — the deployment default.
- **Runtime setting** in the `settings` table — admin-toggleable in the UI.

Behaviour:

- `local` — sync engine and any remote listeners are **hard-off**.
- `hybrid` — they are *available* but still gated by `SECH_LIMS_SYNC_ENABLED`
  (which stays `false` until sync is actually built).

Instrument integrations, environmental monitoring, printers, and laboratory
workflows run **identically in both modes** — they never touch the network sync
path, so loss of internet can never affect them.

### 4.5 Sync engine as a stub interface — *reserve the contract*

`server/sync/syncEngine.ts` defines the interface (`push()`, `pull()`,
`status()`) and a `/api/sync/status` endpoint. In this phase it logs
"sync disabled" and returns immediately. This gives the future cloud and the UI a
**stable contract** to build against. No cloud code, no Neon client, nothing that
runs.

### 4.6 Clients

- **Desktop — Electron thin client:** the same desktop app, configured to connect
  to the Host PC's LAN URL instead of embedding its own API. Needs a
  "connect to Host" configuration screen and reuse of the `devices` pairing
  scaffold. Consistent UX with the Host.
- **Desktop — plain browser:** LAN staff open the Host's URL in Chrome/Edge; no
  install. Already works once the API binds to the LAN. Both desktop paths hit
  the identical `/api`.
- **Mobile — PWA:** add a web-app manifest and a service worker to the existing
  SPA. It installs to a phone's home screen, works over the LAN today, and works
  over remote access later **with no rebuild**. Chosen over React Native to avoid
  a second codebase and because the SPA already runs in a browser.
- **Remote access (later):** designed-for, not built. `SECH_LIMS_PUBLIC_URL` plus
  a reverse proxy / VPN / tunnel (e.g. Tailscale or an HTTPS reverse proxy)
  fronting the same `/api`. No app changes because clients already use a
  configurable base URL.

---

## 5. Environment variable contract

| Variable | Purpose | Default |
|---|---|---|
| `SECH_LIMS_MODE` | `local` / `hybrid` | `local` |
| `SECH_LIMS_API_HOST` | bind address (`0.0.0.0` to serve the LAN) | `127.0.0.1` |
| `API_PORT` | API port | `4317` |
| `SECH_LIMS_PUBLIC_URL` | external URL for remote clients (later) | *(none)* |
| `SECH_LIMS_DB_DRIVER` | `sqlite` / `postgres` | `sqlite` |
| `SECH_LIMS_DB_PATH` | SQLite file path | `local-data/sech_lims.sqlite` |
| `SECH_LIMS_PG_URL` | Neon / Postgres connection string (later) | *(none)* |
| `SECH_LIMS_SYNC_ENABLED` | master sync switch | `false` |
| `SECH_LIMS_CLOUD_URL` | cloud sync endpoint (later) | *(none)* |
| `SECH_LIMS_SYNC_INTERVAL_MS` | sync poll interval (later) | `60000` |
| `SECH_LIMS_DATA_DIR` | root for uploads/evidence/backups/config | `local-data/` |
| `VITE_API_BASE_URL` | client → Host API base URL | *(auto-resolved)* |

---

## 6. Phased roadmap

| Phase | Deliverable | Risk | Cloud code? |
|---|---|---|---|
| **1 — Foundations** | Config module; Local/Hybrid mode setting + UI toggle; formalize LAN binding + firewall/host-URL docs | Low | No |
| **2 — Data Access Layer** | `dataStore` interface + `SqliteStore`; migrate routes module-by-module behind a shim | Medium (touches ~40 files) | No |
| **3 — Sync-ready schema** | `uuid`, `updated_at`, `deleted_at`, `sync_outbox` (all dormant) | Low | No |
| **4 — Clients** | Electron thin-client "connect to Host" + pairing; plain-browser LAN access; PWA manifest + service worker | Medium | No |
| **5 — Sync stub** | `syncEngine` interface + `/api/sync/status` contract (disabled) | Low | No |
| **LATER** | `PostgresStore`; Neon provisioning; real sync engine; Vercel web frontend; remote-access hardening (TLS/VPN/tunnel) | — | **Yes** |

Recommended first step: **Phase 1 only, then review** — smallest safe change, no
route rewrites.

---

## 7. Explicitly out of scope for this upgrade

- No cloud synchronization logic.
- No Neon/PostgreSQL client or provisioning.
- No Vercel deployment.
- No remote-access implementation (VPN/tunnel/TLS).

Only the **seams** for the above are created, so each drops in cleanly later.

---

## 8. Guarantees this design preserves

- The Host PC runs the entire laboratory with **no internet**.
- Instrument integrations, environmental monitoring, printers, and workflows are
  unaffected by network or cloud state in both Local and Hybrid modes.
- Existing single-PC installs keep working unchanged: every new capability is
  **off by default** (`SECH_LIMS_MODE=local`, `SECH_LIMS_SYNC_ENABLED=false`,
  SQLite driver, `127.0.0.1` binding).
