# Sync engine

> **Update:** the sync engine is now **implemented** (cloud phase). This file is
> kept as a pointer; see **[`docs/CLOUD_SYNC.md`](CLOUD_SYNC.md)** for the current
> design, API, replication model, and how to enable it against Neon.

Historically this document described a stubbed contract (`GET /api/sync/status`,
`POST /api/sync/run`) that performed no synchronization. That contract is
unchanged, but `server/sync/syncEngine.ts` now performs real push/pull
replication between the local SQLite host and a cloud PostgreSQL database.

Synchronization remains **off by default** — it activates only when both
`SECH_LIMS_SYNC_ENABLED=true` and `SECH_LIMS_CLOUD_URL` are set. With it disabled
the host runs fully offline and nothing leaves the machine.
