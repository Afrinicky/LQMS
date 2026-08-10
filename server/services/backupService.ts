/**
 * Making backups, keeping the useful ones, and sending copies off site.
 *
 * The archive itself is unchanged from what this system has always written: a
 * ZIP holding the SQLite database, uploads, evidence, config and a manifest.
 * What is new around it is that a laboratory no longer has to remember to press
 * the button — a schedule takes one every night, retention stops the disk
 * filling with a year of identical archives, and, if the laboratory has asked
 * for it, each finished backup is copied to Google Drive so a fire in the
 * building is not also the end of the quality record.
 *
 * Everything here is written so a failure is loud but never fatal: a Drive
 * upload that cannot reach Google leaves a perfectly good local backup behind
 * and says so.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getDb, ensureDataDirs, uploadRoot, evidenceRoot, configRoot, dbPath } from '../db/database.js';
import * as dest from './backupDestinations.js';

// Where backups are written. Configurable (a second disk, a folder the
// hospital's own server backup already sweeps), so every path goes through this
// rather than a constant.
const backupFolder = () => dest.backupFolder();
import { normaliseSchedule, backupsToKeep, nextRunAfter, mostRecentDue, type BackupSchedule } from '../../shared/constants/backup.js';

const SCHEDULE_KEY = 'backup.schedule';
const LAST_RUN_KEY = 'backup.lastScheduledRun';

/* --------------------------------------------------------------- archiving */

// archiver is loaded lazily: a top-level import breaks the packaged Electron
// app under app.asar (CommonJS module, ESM-only dependency). See the same note
// in routes/common.ts, which this function was lifted out of so the scheduler
// and the manual endpoint write byte-identical archives.
async function loadArchiver(): Promise<(format: string, options?: any) => any> {
  const mod: any = await import('archiver');
  const factory = mod.default ?? mod;
  if (typeof factory === 'function') return factory as (format: string, options?: any) => any;
  return (format: string, options?: any) => {
    switch (format) {
      case 'tar': return new mod.TarArchive(options);
      case 'json': return new mod.JsonArchive(options);
      case 'zip':
      default: return new mod.ZipArchive(options);
    }
  };
}

/** Only plain file names, so a caller can never reference a path outside the folder. */
export function isSafeBackupName(name: string): boolean {
  return typeof name === 'string' && /^[A-Za-z0-9._-]+\.zip$/.test(name) && !name.includes('..');
}

/* --------------------------------------------------------------- integrity */

/**
 * The SHA-256 of a finished archive.
 *
 * Recorded when the backup is taken and checked again before a restore, so the
 * laboratory can tell the difference between the archive it made and one that
 * has since been corrupted on a failing disk, truncated by a half-finished
 * copy, or swapped. The old restore checked only that the ZIP would open, which
 * a damaged archive very often will (validation finding VF-08).
 */
export function checksumOf(filePath: string): string {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

export interface ChecksumVerdict {
  ok: boolean;
  expected: string | null;
  actual: string;
  message: string;
}

/**
 * Check an archive against the digest recorded when it was made.
 *
 * An archive with no recorded digest — one taken before this existed, or one
 * carried in from another machine — is reported as unverifiable rather than as
 * good or bad, because that is what it is. The restore route lets it through
 * and says so; it does not pretend to have checked something it could not.
 */
export function verifyChecksum(fileName: string): ChecksumVerdict {
  const filePath = path.join(backupFolder(), fileName);
  const actual = checksumOf(filePath);
  const row = getDb().prepare('SELECT checksum FROM backup_logs WHERE file_name = ? ORDER BY id DESC LIMIT 1')
    .get(fileName) as { checksum: string | null } | undefined;
  const expected = row?.checksum ?? null;

  if (!expected) {
    return { ok: true, expected: null, actual, message: 'No digest was recorded for this archive, so its integrity could not be confirmed. It was accepted on the laboratory\'s judgement.' };
  }
  if (expected === actual) {
    return { ok: true, expected, actual, message: 'Archive matches the digest recorded when it was taken.' };
  }
  return {
    ok: false, expected, actual,
    message: 'This archive does not match the digest recorded when it was taken. It has been altered, corrupted or replaced. Restoring it would overwrite live data with contents nobody can vouch for.',
  };
}

/** Write the deployment to a ZIP at `targetPath`. */
export async function writeBackupZip(targetPath: string, manifest: unknown): Promise<void> {
  const archiver = await loadArchiver();
  await new Promise<void>((resolve, reject) => {
    const output = fs.createWriteStream(targetPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    if (fs.existsSync(dbPath)) archive.file(dbPath, { name: 'database/sech_lims.sqlite' });
    if (fs.existsSync(uploadRoot)) archive.directory(uploadRoot, 'uploads');
    if (fs.existsSync(evidenceRoot)) archive.directory(evidenceRoot, 'evidence');
    if (fs.existsSync(configRoot)) archive.directory(configRoot, 'config');
    archive.append(JSON.stringify(manifest, null, 2), { name: 'backup-manifest.json' });
    archive.finalize();
  });
}

export type BackupFile = { fileName: string; sizeBytes: number; createdAt: string; source: string };

/**
 * When a backup was taken, to the millisecond, read out of its own name.
 *
 * This is the only source that is both exact and consistent. The log's
 * `created_at` is a SQLite timestamp, so it is only accurate to the second and
 * is written in a different shape to an ISO string — and backups do land in the
 * same second, when somebody presses the button while the schedule fires, or
 * during testing. Two records that compare equal put retention in the position
 * of choosing arbitrarily between them, which is how the newest archive ends up
 * being the one that gets deleted.
 */
function stampFromName(fileName: string): string | null {
  const match = fileName.match(/(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/);
  if (!match) return null;
  const at = new Date(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

/** A SQLite `CURRENT_TIMESTAMP` (UTC, space-separated) as an ISO string. */
function loggedStamp(value: string): string | null {
  const at = new Date(/[TZ]/.test(value) ? value : `${value.replace(' ', 'T')}Z`);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

/** Every backup ZIP on disk, newest first, with when the system thinks it was made. */
export function listLocal(): BackupFile[] {
  ensureDataDirs();
  const logs = getDb().prepare('SELECT file_name, created_at FROM backup_logs ORDER BY id DESC').all() as Array<{ file_name: string; created_at: string }>;
  const logged = new Map(logs.map(l => [l.file_name, l.created_at]));
  return fs.readdirSync(backupFolder())
    .filter(f => f.toLowerCase().endsWith('.zip') && !f.startsWith('.') && !f.startsWith('_'))
    .map(f => {
      const stat = fs.statSync(path.join(backupFolder(), f));
      const fromLog = logged.has(f) ? loggedStamp(logged.get(f)!) : null;
      return {
        fileName: f,
        sizeBytes: stat.size,
        // Name first, then the log, then the file itself — most precise wins.
        createdAt: stampFromName(f) ?? fromLog ?? stat.mtime.toISOString(),
        source: logged.has(f) ? 'system' : 'external',
      };
    })
    // The name breaks ties, since it carries the millisecond the log has lost.
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.fileName.localeCompare(a.fileName));
}

/**
 * Take a backup. `trigger` says who asked — a person, the schedule, or a
 * restore about to overwrite things — and ends up in the manifest so a file
 * found a year later explains itself.
 */
export async function createBackup(trigger: 'manual' | 'scheduled' | 'pre-restore', userId: number | null): Promise<BackupFile> {
  ensureDataDirs();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = trigger === 'pre-restore' ? `pre-restore-${stamp}.zip` : `sech-lims-backup-${stamp}.zip`;
  const fullPath = path.join(backupFolder(), fileName);
  const manifest = {
    product: 'SECH_LIMS by Nickland',
    createdAt: new Date().toISOString(),
    trigger,
    includes: ['SQLite database', 'uploads', 'evidence', 'config', 'backup-manifest.json'],
  };
  // Fold the write-ahead log into the database file first, or the snapshot is
  // missing everything written since the last checkpoint.
  try { getDb().pragma('wal_checkpoint(TRUNCATE)'); } catch { /* best-effort */ }
  await writeBackupZip(fullPath, manifest);
  const sizeBytes = fs.existsSync(fullPath) ? fs.statSync(fullPath).size : 0;
  const checksum = checksumOf(fullPath);
  getDb().prepare('INSERT INTO backup_logs (file_name, manifest, created_by, checksum) VALUES (?, ?, ?, ?)')
    .run(fileName, JSON.stringify({ ...manifest, checksum }), userId, checksum);
  return { fileName, sizeBytes, createdAt: manifest.createdAt, source: 'system' };
}

/* ---------------------------------------------------------------- schedule */

export function getSchedule(): BackupSchedule {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(SCHEDULE_KEY) as { value: string } | undefined;
  try { return normaliseSchedule(row ? JSON.parse(row.value) : {}); }
  catch { return normaliseSchedule({}); }
}

export function saveSchedule(schedule: BackupSchedule): BackupSchedule {
  const clean = normaliseSchedule(schedule);
  getDb().prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`)
    .run(SCHEDULE_KEY, JSON.stringify(clean));
  return clean;
}

const lastScheduledRun = (): number => {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(LAST_RUN_KEY) as { value: string } | undefined;
  const n = Number(row?.value);
  return Number.isFinite(n) ? n : 0;
};
const markScheduledRun = (at: number) => {
  getDb().prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`)
    .run(LAST_RUN_KEY, String(at));
};

/* --------------------------------------------------------------- retention */

/**
 * Delete the local backups the policy no longer wants.
 *
 * Only backups this system made are ever pruned. A ZIP somebody copied into the
 * folder by hand, and any pre-restore safety snapshot, are left alone — they
 * were put there deliberately and it is not this function's place to decide
 * they are finished with.
 */
export function pruneLocal(schedule: BackupSchedule, now = new Date()): string[] {
  const all = listLocal().filter(b => b.source === 'system' && !b.fileName.startsWith('pre-restore-'));
  const keep = backupsToKeep(all, schedule.retention, now);
  const removed: string[] = [];
  for (const b of all) {
    if (keep.has(b)) continue;
    try {
      fs.rmSync(path.join(backupFolder(), b.fileName), { force: true });
      removed.push(b.fileName);
    } catch { /* a file we cannot delete is not worth failing the backup over */ }
  }
  return removed;
}

/* --------------------------------------------------------------- copies out */

/**
 * Send everything outstanding to every enabled destination.
 *
 * Kept here as a thin pass-through so callers have one place to reach for,
 * whether they are the scheduler, the "copy now" button, or a laboratory
 * catching up after a spell with the network down.
 */
export const syncPending = (destinationId: number | null, userId: number | null) =>
  dest.syncPending(destinationId, userId);

/** Every backup on this host that has not reached every enabled destination. */
export function unsyncedBackups(): string[] {
  const names = new Set<string>();
  for (const d of dest.listDestinations()) {
    if (!d.enabled) continue;
    for (const f of dest.pendingFor(d.id)) names.add(f);
  }
  return [...names].sort().reverse();
}

/* --------------------------------------------------------------- scheduler */

export type ScheduledResult = {
  backup: BackupFile | null;
  pruned: string[];
  /** One entry per enabled destination — the hospital server, a bucket, Drive. */
  copies: dest.CopyOutcome[];
  prunedRemote: Record<string, string[]>;
  error?: string;
};

/**
 * One cycle: take the backup, copy it everywhere it belongs, then prune what
 * the policy has finished with.
 *
 * The order matters twice over. The archive is written before anything is
 * deleted, so a failure never leaves the laboratory with fewer copies than it
 * started with. And the copies go out before the pruning, so a backup is never
 * removed from here having never reached anywhere else.
 *
 * This is the whole of what "Back up now" does as well, so what the button
 * produces at four in the afternoon is exactly what the night produces.
 */
export async function runScheduledBackup(userId: number | null = null): Promise<ScheduledResult> {
  const schedule = getSchedule();
  const out: ScheduledResult = { backup: null, pruned: [], copies: [], prunedRemote: {} };
  try {
    out.backup = await createBackup('scheduled', userId);
  } catch (e) {
    out.error = (e as Error).message;
    return out;
  }

  // Every enabled destination gets this backup, each attempted independently:
  // the hospital server being down must not stop the copy reaching the cloud.
  try { out.copies = await dest.copyToAll(out.backup.fileName, userId); }
  catch (e) { console.error('[backup] copying out failed', e); }

  try { out.pruned = pruneLocal(schedule); } catch { /* keeping the backup matters more */ }

  // Mirror the retention window everywhere, so a destination does not quietly
  // accumulate a year of archives the laboratory thought it had pruned.
  try {
    const keep = new Set(listLocal().map(b => b.fileName));
    out.prunedRemote = await dest.pruneAll(keep);
  } catch { /* leave the copies be rather than risk deleting the wrong thing */ }

  return out;
}

/**
 * The background scheduler.
 *
 * It wakes every minute and asks one question: has a scheduled time passed
 * since the last backup? That is deliberately simple — it means a host that was
 * switched off overnight takes its missed backup shortly after it comes back,
 * rather than skipping a day because nothing was listening at 02:00.
 */
export class BackupScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  start(): void {
    if (this.timer) return;
    // A minute after boot, then every minute. The check is a couple of reads
    // and a date comparison, so the cost is nothing.
    setTimeout(() => void this.tick(), 60_000);
    this.timer = setInterval(() => void this.tick(), 60_000);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  async tick(now = new Date()): Promise<ScheduledResult | null> {
    if (this.running) return null;
    const schedule = getSchedule();
    if (!schedule.enabled) return null;

    const last = lastScheduledRun();
    // The most recent moment the schedule wanted a backup: step back from now
    // and find the previous due time. `nextRunAfter` from an hour before the
    // last run tells us the same thing from the other direction.
    const due = mostRecentDue(schedule, now);
    if (!due) return null;
    if (last >= due.getTime()) return null;

    this.running = true;
    try {
      markScheduledRun(due.getTime());
      const result = await runScheduledBackup(null);
      if (result.error) {
        console.error('[backup] scheduled backup failed:', result.error);
      } else {
        const sent = result.copies.filter(c => c.ok).length;
        const failed = result.copies.filter(c => !c.ok);
        console.log(`[backup] ${result.backup?.fileName}` +
          (result.copies.length ? ` — copied to ${sent} of ${result.copies.length} destination(s)` : '') +
          (failed.length ? `; ${failed.map(f => `${f.destinationName}: ${f.error}`).join('; ')}` : ''));
      }
      return result;
    } finally { this.running = false; }
  }
}

/** Everything the settings screen needs to describe the current protection. */
export function protectionStatus() {
  const schedule = getSchedule();
  const local = listLocal();
  const db = getDb();
  const newest = local[0] ?? null;
  const destinations = dest.listDestinations();
  const enabled = destinations.filter(d => d.enabled);
  const lastSuccess = db.prepare("SELECT * FROM backup_sync_log WHERE status = 'success' ORDER BY id DESC LIMIT 1")
    .get() as Record<string, unknown> | undefined;

  // "Off site" means a copy exists somewhere this building's misfortunes cannot
  // reach. A second folder on the same machine does not count, however useful
  // it is against a failing disk.
  const offSiteKinds = new Set(['network', 's3', 'webdav', 'google_drive']);
  const offSite = enabled.filter(d => offSiteKinds.has(d.kind));
  const offSiteHealthy = offSite.filter(d => d.lastResult === 'success' && d.pending === 0);

  return {
    schedule,
    nextRun: nextRunAfter(schedule, new Date())?.toISOString() ?? null,
    lastBackup: newest,
    backupCount: local.length,
    totalBytes: local.reduce((sum, b) => sum + b.sizeBytes, 0),
    folder: dest.configuredFolder(),
    destinations,
    copies: {
      configured: enabled.length,
      offSite: offSite.length,
      offSiteHealthy: offSiteHealthy.length,
      failing: enabled.filter(d => d.lastResult === 'failed').length,
      pending: enabled.reduce((sum, d) => sum + d.pending, 0),
      lastCopyAt: (lastSuccess?.created_at as string) ?? null,
    },
  };
}
