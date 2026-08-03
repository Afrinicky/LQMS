import { randomUUID } from 'node:crypto';

/**
 * Generate an RFC 4122 v4 UUID for globally-unique record identity.
 *
 * Part of the offline-first hybrid architecture (Phase 3). Application code
 * should use this when it starts populating the `uuid` columns explicitly; until
 * then the database backfills and an AFTER INSERT trigger keep existing and new
 * rows covered. See docs/SYNC_READY_SCHEMA.md.
 */
export function uuid(): string {
  return randomUUID();
}
