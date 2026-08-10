import { defineConfig } from 'vitest/config';

/**
 * The regression suite the August 2026 validation found missing (VF-09).
 *
 * These are fast, in-process tests of the logic that decides who may do what,
 * whether a password is acceptable, whether the audit trail has been tampered
 * with, and whether a backup is the archive it claims to be. They complement —
 * they do not replace — the qualification protocols in scripts/validation,
 * which exercise the whole running Host over HTTP.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // better-sqlite3 is a native module and each suite opens its own database
    // file; running them in one process keeps that predictable.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 20_000,
    reporters: ['default'],
  },
});
