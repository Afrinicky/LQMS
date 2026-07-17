/**
 * Store factory — resolves the active DataStore implementation from config.
 *
 * Route modules call getStore() and receive whichever driver the deployment is
 * configured for (SECH_LIMS_DB_DRIVER). Only `sqlite` is implemented today;
 * `postgres` is reserved for the future cloud phase and throws until built.
 */
import { config } from '../config/index.js';
import type { DataStore } from './dataStore.js';
import { SqliteStore } from './sqliteStore.js';
import { createPostgresStore } from './postgresStore.js';

let store: DataStore | undefined;

export function getStore(): DataStore {
  if (!store) {
    store = config.db.driver === 'postgres' ? createPostgresStore() : new SqliteStore();
  }
  return store;
}

/** Reset the cached store (used by tests / after a driver reconfiguration). */
export function resetStore(): void {
  store = undefined;
}

export type { DataStore } from './dataStore.js';
