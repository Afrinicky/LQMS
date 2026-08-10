import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The audit trail's hash chain.
 *
 * The promise the chain makes is narrow and worth stating exactly: it does not
 * stop a host administrator editing the SQLite file, because nothing in
 * application code can. It makes the edit *visible*. These tests do the editing
 * themselves — straight into the database, behind the application's back, the
 * way a real tamper would — and check that the verifier notices.
 */
const dataDir = path.join(os.tmpdir(), `sechlims-test-audit-${process.pid}`);
process.env.SECH_LIMS_DATA_DIR = dataDir;

let audit: typeof import('../server/services/auditService.js').audit;
let verifyAuditChain: typeof import('../server/services/auditService.js').verifyAuditChain;
let getDb: typeof import('../server/db/database.js').getDb;

beforeAll(async () => {
  fs.mkdirSync(dataDir, { recursive: true });
  ({ audit, verifyAuditChain } = await import('../server/services/auditService.js'));
  ({ getDb } = await import('../server/db/database.js'));
});

afterAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('audit trail integrity', () => {
  it('chains entries and verifies clean', () => {
    for (let i = 0; i < 5; i++) {
      audit(undefined, { action: 'create', entity: 'widgets', entityId: i, newValue: { n: i } });
    }
    const result = verifyAuditChain();
    expect(result.ok).toBe(true);
    expect(result.checked).toBeGreaterThanOrEqual(5);
    expect(result.altered).toEqual([]);
    expect(result.broken).toEqual([]);
    expect(result.message).toMatch(/intact/i);
  });

  it('returns the id of the entry it wrote', () => {
    const id = audit(undefined, { action: 'update', entity: 'widgets', entityId: 99 });
    const row = getDb().prepare('SELECT action, entity_id FROM audit_logs WHERE id = ?').get(id) as
      { action: string; entity_id: string };
    expect(row.action).toBe('update');
    expect(row.entity_id).toBe('99');
  });

  it('stamps timestamps with an explicit time zone', () => {
    const id = audit(undefined, { action: 'create', entity: 'widgets', entityId: 1000 });
    const row = getDb().prepare('SELECT recorded_at FROM audit_logs WHERE id = ?').get(id) as { recorded_at: string };
    expect(row.recorded_at).toMatch(/Z$/);
    expect(Number.isNaN(Date.parse(row.recorded_at))).toBe(false);
  });

  it('detects an entry rewritten behind the application’s back', () => {
    const id = audit(undefined, { action: 'approve', entity: 'capa_records', entityId: 7, newValue: { status: 'approved' } });
    // The tamper: change what the record says happened, leaving the hash alone.
    getDb().prepare("UPDATE audit_logs SET action = 'reject' WHERE id = ?").run(id);

    const result = verifyAuditChain();
    expect(result.ok).toBe(false);
    expect(result.altered).toContain(id);
    expect(result.message).toMatch(/FAILED/);
  });

  it('detects an entry deleted from the middle of the trail', () => {
    // Start from a clean trail so the previous test's damage is not in the way.
    getDb().exec('DELETE FROM audit_logs');
    const ids = [1, 2, 3, 4].map(n =>
      audit(undefined, { action: 'create', entity: 'runs', entityId: n }));

    getDb().prepare('DELETE FROM audit_logs WHERE id = ?').run(ids[1]);

    const result = verifyAuditChain();
    expect(result.ok).toBe(false);
    // The entry after the hole no longer follows the one now preceding it.
    expect(result.broken).toContain(ids[2]);
  });

  it('reports pre-chain entries honestly rather than back-filling them', () => {
    getDb().exec('DELETE FROM audit_logs');
    // An entry as the old code would have written it: no hash at all.
    getDb().prepare("INSERT INTO audit_logs (action, entity, entity_id) VALUES ('create', 'legacy', '1')").run();
    audit(undefined, { action: 'create', entity: 'runs', entityId: 1 });

    const result = verifyAuditChain();
    expect(result.ok).toBe(true);
    expect(result.unchained).toBe(1);
    expect(result.message).toMatch(/before chaining began/);
  });
});
