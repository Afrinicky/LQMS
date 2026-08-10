import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Backup checksums.
 *
 * The failure this guards against is quiet: an archive that still opens as a
 * ZIP, still looks like a backup, and is no longer the backup that was taken.
 * The restore route used to accept exactly that (validation finding VF-08).
 */
const dataDir = path.join(os.tmpdir(), `sechlims-test-backup-${process.pid}`);
process.env.SECH_LIMS_DATA_DIR = dataDir;

let checksumOf: typeof import('../server/services/backupService.js').checksumOf;
let verifyChecksum: typeof import('../server/services/backupService.js').verifyChecksum;
let getDb: typeof import('../server/db/database.js').getDb;
let backupDir: string;

beforeAll(async () => {
  fs.mkdirSync(dataDir, { recursive: true });
  ({ checksumOf, verifyChecksum } = await import('../server/services/backupService.js'));
  ({ getDb } = await import('../server/db/database.js'));
  getDb(); // opens and migrates, and creates the data directories
  backupDir = path.join(dataDir, 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
});

afterAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function writeArchive(name: string, contents: string): string {
  const filePath = path.join(backupDir, name);
  fs.writeFileSync(filePath, contents);
  return filePath;
}

describe('backup integrity', () => {
  it('produces a stable digest for identical content and a different one otherwise', () => {
    const a = writeArchive('a.zip', 'the quality record');
    const b = writeArchive('b.zip', 'the quality record');
    const c = writeArchive('c.zip', 'the quality record, edited');
    expect(checksumOf(a)).toBe(checksumOf(b));
    expect(checksumOf(a)).not.toBe(checksumOf(c));
    expect(checksumOf(a)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('accepts an archive that matches the digest recorded when it was taken', () => {
    const file = 'good.zip';
    const filePath = writeArchive(file, 'contents at backup time');
    getDb().prepare('INSERT INTO backup_logs (file_name, manifest, checksum) VALUES (?, ?, ?)')
      .run(file, '{}', checksumOf(filePath));

    const verdict = verifyChecksum(file);
    expect(verdict.ok).toBe(true);
    expect(verdict.expected).toBe(verdict.actual);
  });

  it('refuses an archive whose contents changed after it was recorded', () => {
    const file = 'tampered.zip';
    const filePath = writeArchive(file, 'contents at backup time');
    getDb().prepare('INSERT INTO backup_logs (file_name, manifest, checksum) VALUES (?, ?, ?)')
      .run(file, '{}', checksumOf(filePath));

    // The archive rots, is truncated by a half-finished copy, or is swapped.
    fs.writeFileSync(filePath, 'contents at backup time (but not really)');

    const verdict = verifyChecksum(file);
    expect(verdict.ok).toBe(false);
    expect(verdict.expected).not.toBe(verdict.actual);
    expect(verdict.message).toMatch(/altered, corrupted or replaced/);
  });

  it('says an archive is unverifiable rather than pretending it checked one', () => {
    const file = 'from-elsewhere.zip';
    writeArchive(file, 'an archive carried in on a memory stick');

    const verdict = verifyChecksum(file);
    expect(verdict.ok).toBe(true);          // not refused …
    expect(verdict.expected).toBeNull();     // … but not vouched for either
    expect(verdict.message).toMatch(/could not be confirmed/);
  });
});
