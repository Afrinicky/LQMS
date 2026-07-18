/**
 * PostgresStore — reserved for the future cloud phase (e.g. Neon). It is NOT
 * implemented yet; the seam exists so that switching SECH_LIMS_DB_DRIVER to
 * `postgres` later is a driver change rather than an application rewrite.
 *
 * See docs/HYBRID_ARCHITECTURE_PLAN.md ("LATER" phase). When implemented this
 * will wrap a node-postgres pool and translate the RunResult / RETURNING and
 * placeholder-dialect concerns behind the same DataStore contract.
 */
import type { DataStore } from './dataStore.js';

export function createPostgresStore(): DataStore {
  throw new Error(
    'PostgresStore is not implemented yet. The cloud/Postgres backend is planned ' +
    'for a later phase — set SECH_LIMS_DB_DRIVER=sqlite (the default) to run the ' +
    'host on its local database. See docs/HYBRID_ARCHITECTURE_PLAN.md.'
  );
}
