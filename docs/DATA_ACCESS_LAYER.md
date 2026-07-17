# Data Access Layer (DataStore) — migration guide

> Phase 2 of the offline-first hybrid architecture. See
> `docs/HYBRID_ARCHITECTURE_PLAN.md` for the big picture.

## Why this exists

Every route module historically called `getDb().prepare("...SQLite SQL...")`
directly. That hard-wires the application to a specific database and would make a
future cloud PostgreSQL (e.g. Neon) backend a ~40-file rewrite.

The **DataStore** is a thin seam between the routes and the database. Routes call
an interface; a driver implements it. Swapping the backend later becomes a driver
change, not an application rewrite.

## The pieces

| File | Role |
|---|---|
| `server/db/dataStore.ts` | The `DataStore` interface (pure types, async-first). |
| `server/db/sqliteStore.ts` | `SqliteStore` — wraps the existing better-sqlite3 `getDb()` singleton. The only implementation today. |
| `server/db/postgresStore.ts` | `createPostgresStore()` — reserved stub, throws until the cloud phase. |
| `server/db/store.ts` | `getStore()` factory — picks the driver from `config.db.driver` (`SECH_LIMS_DB_DRIVER`). |

`SqliteStore` reuses the shared connection, so migrated routes (via the store)
and not-yet-migrated routes (via `getDb()` directly) read and write the **same**
database. The migration is therefore incremental and safe: nothing breaks
mid-rollout.

## The interface

```ts
store.get<T>(sql, params?)   // → Promise<T | undefined>   (first row)
store.all<T>(sql, params?)   // → Promise<T[]>             (all rows)
store.run(sql, params?)      // → Promise<{ changes, lastInsertRowid }>
store.exec(sql)              // → Promise<void>            (DDL / pragmas)
store.transaction(work)      // → Promise<T>               (atomic)
store.healthCheck()          // → Promise<boolean>
```

## Migration pattern (per handler)

**Before**

```ts
router.get('/status', (_req, res) => {
  const db = getDb();
  const row = db.prepare("SELECT value FROM settings WHERE key = 'setupComplete'").get();
  res.json({ setupComplete: row?.value === 'true' });
});
```

**After**

```ts
router.get('/status', async (_req, res, next) => {
  try {
    const store = getStore();
    const row = await store.get<{ value: string }>("SELECT value FROM settings WHERE key = 'setupComplete'");
    res.json({ setupComplete: row?.value === 'true' });
  } catch (err) { next(err); }
});
```

Mechanical rules:

1. Make the handler `async` and add `(err) => next(err)` handling (or a
   `try/catch`).
2. `db.prepare(sql).get(...p)` → `await store.get(sql, p)`.
3. `db.prepare(sql).all(...p)` → `await store.all(sql, p)`.
4. `db.prepare(sql).run(...p)` → `await store.run(sql, p)` (use `.changes` /
   `.lastInsertRowid` from the result).
5. `db.transaction(() => { ... })()` → `await store.transaction(async (tx) => { ... })`,
   replacing inner `db.*` calls with `await tx.*`.
6. Pass parameters as a single array: `.get(a, b)` → `store.get(sql, [a, b])`.

## Transaction rule

Inside `store.transaction(work)`, only await operations on the provided `tx`
handle. Do **not** await unrelated real-async work (timers, network, `fs`) inside
a transaction. `SqliteStore` runs the body between a manual `BEGIN` and `COMMIT`
on the single shared connection; because store operations settle synchronously,
Node drains the microtask queue to completion before any other request's handler
runs, so the transaction stays isolated. Awaiting real I/O would yield the event
loop mid-transaction and break that guarantee.

## SQL dialect

The store abstracts *how* queries run, not *what dialect* they are written in.
The current SQL is SQLite-flavoured. When `PostgresStore` is built,
dialect-sensitive spots (`?` vs `$n` placeholders, `INSERT OR IGNORE`,
`CURRENT_TIMESTAMP`, `RETURNING` for insert ids, `PRAGMA`) will be reconciled per
driver at that time. Keeping queries flowing through the store is the
prerequisite that makes that reconciliation localized rather than global.

## Rollout status

- [x] Seam built: interface, SQLite driver, Postgres stub, factory.
- [x] `server/routes/setup.ts` migrated (reference implementation).
- [ ] Remaining route modules — migrate incrementally; each is independent.

Not-yet-migrated modules keep using `getDb()` and continue to work unchanged.
