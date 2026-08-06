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
import { getDb, ensureDataDirs, backupRoot, uploadRoot, evidenceRoot, configRoot, dbPath } from '../db/database.js';
import { normaliseSchedule, backupsToKeep, nextRunAfter, mostRecentDue, type BackupSchedule } from '../../shared/constants/backup.js';
import * as drive from './googleDrive.js';

const SCHEDULE_KEY = 'backup.schedule';
const DRIVE_KEY = 'backup.drive';
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

/** Every backup ZIP on disk, newest first, with when the system thinks it was made. */
export function listLocal(): BackupFile[] {
  ensureDataDirs();
  const logs = getDb().prepare('SELECT file_name, created_at FROM backup_logs ORDER BY id DESC').all() as Array<{ file_name: string; created_at: string }>;
  const logged = new Map(logs.map(l => [l.file_name, l.created_at]));
  return fs.readdirSync(backupRoot)
    .filter(f => f.toLowerCase().endsWith('.zip') && !f.startsWith('.') && !f.startsWith('_'))
    .map(f => {
      const stat = fs.statSync(path.join(backupRoot, f));
      return {
        fileName: f,
        sizeBytes: stat.size,
        createdAt: logged.get(f) ?? stat.mtime.toISOString(),
        source: logged.has(f) ? 'system' : 'external',
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
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
  const fullPath = path.join(backupRoot, fileName);
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
  getDb().prepare('INSERT INTO backup_logs (file_name, manifest, created_by) VALUES (?, ?, ?)').run(fileName, JSON.stringify(manifest), userId);
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

export type DriveSettings = { folderId: string | null; folderName: string | null };

export function getDriveSettings(): DriveSettings {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(DRIVE_KEY) as { value: string } | undefined;
  try {
    const parsed = row ? JSON.parse(row.value) : {};
    return { folderId: parsed.folderId ?? null, folderName: parsed.folderName ?? null };
  } catch { return { folderId: null, folderName: null }; }
}

export function saveDriveSettings(settings: DriveSettings): void {
  getDb().prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`)
    .run(DRIVE_KEY, JSON.stringify(settings));
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
      fs.rmSync(path.join(backupRoot, b.fileName), { force: true });
      removed.push(b.fileName);
    } catch { /* a file we cannot delete is not worth failing the backup over */ }
  }
  return removed;
}

/* ------------------------------------------------------------- drive sync */

export type SyncOutcome = { fileName: string; ok: boolean; error?: string; fileId?: string; sizeBytes?: number };

/**
 * Copy one backup to Drive and record what happened. Every attempt is logged,
 * successful or not, because "when did this last leave the building" is a
 * question an assessor asks and a failed upload is the answer they need.
 */
export async function syncOne(fileName: string, userId: number | null): Promise<SyncOutcome> {
  const db = getDb();
  const { folderId } = getDriveSettings();
  const full = path.join(backupRoot, fileName);
  const sizeBytes = fs.existsSync(full) ? fs.statSync(full).size : 0;
  const started = Date.now();

  const record = (ok: boolean, error: string | null, fileId: string | null) => {
    db.prepare(`INSERT INTO backup_sync_log (file_name, destination, status, remote_id, size_bytes, duration_ms, message, created_by)
      VALUES (?, 'google_drive', ?, ?, ?, ?, ?, ?)`)
      .run(fileName, ok ? 'success' : 'failed', fileId, sizeBytes, Date.now() - started, error, userId);
  };

  if (!drive.readKey()) {
    const error = 'Google Drive is not connected.';
    record(false, error, null);
    return { fileName, ok: false, error };
  }

  // Already up there? Don't send it twice — this runs after every scheduled
  // backup and on demand, and the two can easily overlap.
  try {
    const remote = await drive.listRemote(folderId);
    const existing = remote.find(r => r.name === fileName);
    if (existing) {
      record(true, null, existing.id);
      return { fileName, ok: true, fileId: existing.id, sizeBytes };
    }
  } catch { /* if listing fails, fall through and try the upload anyway */ }

  const result = await drive.uploadBackup(full, fileName, folderId);
  if (result.ok === true) {
    record(true, null, result.fileId);
    return { fileName, ok: true, fileId: result.fileId, sizeBytes };
  }
  record(false, result.error, null);
  return { fileName, ok: false, error: result.error, sizeBytes };
}

/** Apply the same retention window to the Drive folder as to the local one. */
export async function pruneRemote(schedule: BackupSchedule, now = new Date()): Promise<string[]> {
  const { folderId } = getDriveSettings();
  const remote = await drive.listRemote(folderId);
  const candidates = remote
    .filter(f => f.name.startsWith('sech-lims-backup-'))
    .map(f => ({ ...f, createdAt: f.createdTime }));
  const keep = backupsToKeep(candidates, schedule.retention, now);
  const removed: string[] = [];
  for (const f of candidates) {
    if (keep.has(f)) continue;
    if (await drive.deleteRemote(f.id)) removed.push(f.name);
  }
  return removed;
}

/** Every backup on disk that has never reached Drive successfully. */
export function unsyncedBackups(): string[] {
  const db = getDb();
  const synced = new Set((db.prepare("SELECT DISTINCT file_name FROM backup_sync_log WHERE status = 'success'").all() as Array<{ file_name: string }>).map(r => r.file_name));
  return listLocal().filter(b => b.source === 'system' && !b.fileName.startsWith('pre-restore-') && !synced.has(b.fileName)).map(b => b.fileName);
}

/* --------------------------------------------------------------- scheduler */

export type ScheduledResult = {
  backup: BackupFile | null;
  pruned: string[];
  sync: SyncOutcome | null;
  prunedRemote: string[];
  error?: string;
};

/**
 * One scheduled cycle: take the backup, prune what the policy has finished
 * with, then copy it off site if that was asked for.
 *
 * The order matters. The backup is written before anything is deleted, so a
 * failure never leaves the laboratory with fewer copies than it started with.
 */
export async function runScheduledBackup(userId: number | null = null): Promise<ScheduledResult> {
  const schedule = getSchedule();
  const out: ScheduledResult = { backup: null, pruned: [], sync: null, prunedRemote: [] };
  try {
    out.backup = await createBackup('scheduled', userId);
  } catch (e) {
    out.error = (e as Error).message;
    return out;
  }
  try { out.pruned = pruneLocal(schedule); } catch { /* keeping the backup matters more */ }

  if (schedule.syncToDrive && drive.readKey()) {
    out.sync = await syncOne(out.backup.fileName, userId);
    if (out.sync.ok) {
      try { out.prunedRemote = await pruneRemote(schedule); } catch { /* leave the remote copies be */ }
    }
  }
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
      if (result.error) console.error('[backup] scheduled backup failed:', result.error);
      else console.log(`[backup] scheduled backup ${result.backup?.fileName}${result.sync ? (result.sync.ok ? ' — copied to Google Drive' : ` — Drive copy failed: ${result.sync.error}`) : ''}`);
      return result;
    } finally { this.running = false; }
  }
}

/** Everything the settings screen needs to describe the current protection. */
export function protectionStatus() {
  const schedule = getSchedule();
  const local = listLocal();
  const db = getDb();
  const lastSync = db.prepare("SELECT * FROM backup_sync_log WHERE status = 'success' ORDER BY id DESC LIMIT 1").get() as Record<string, unknown> | undefined;
  const lastFailure = db.prepare("SELECT * FROM backup_sync_log WHERE status = 'failed' ORDER BY id DESC LIMIT 1").get() as Record<string, unknown> | undefined;
  const newest = local[0] ?? null;
  const driveConnected = drive.readKey() !== null;
  return {
    schedule,
    nextRun: nextRunAfter(schedule, new Date())?.toISOString() ?? null,
    lastBackup: newest,
    backupCount: local.length,
    totalBytes: local.reduce((sum, b) => sum + b.sizeBytes, 0),
    drive: {
      connected: driveConnected,
      ...getDriveSettings(),
      clientEmail: drive.readKey()?.client_email ?? null,
      lastSyncAt: (lastSync?.created_at as string) ?? null,
      lastSyncFile: (lastSync?.file_name as string) ?? null,
      lastFailureAt: (lastFailure?.created_at as string) ?? null,
      lastFailureMessage: (lastFailure?.message as string) ?? null,
      pendingCount: driveConnected ? unsyncedBackups().length : 0,
    },
  };
}
