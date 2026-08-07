/**
 * The list of places a backup is copied to, and the machinery that copies it.
 *
 * A backup that exists only on the machine that made it is not really a backup.
 * What "somewhere else" means, though, depends entirely on the institution: a
 * hospital with a file server wants a folder on it, one with an IT department
 * may have MinIO on its own hardware, one with a budget may want Backblaze.
 * So this holds a list rather than one blessed provider, and every enabled
 * destination gets a copy of every backup as soon as it is written.
 *
 * SECRETS
 *
 * Passwords, access keys and service-account keys are stored in the `secret`
 * column and never travel back to a browser — a client sees only `hasSecret`.
 * They do travel inside the backup archive itself, which is unavoidable when
 * the archive contains the database; it is one more reason a backup file is
 * treated as sensitive.
 *
 * FAILURE
 *
 * A destination that cannot be reached must never cost the laboratory its local
 * backup. Every copy is attempted independently, failures are recorded against
 * the destination that failed, and the cycle carries on to the next one.
 */
import fs from 'node:fs';
import path from 'node:path';
import { getDb, defaultBackupRoot, ensureDataDirs } from '../db/database.js';
import {
  kindDef, secretFieldsOf, describeDestination, missingFields,
  type BackupDestination, type DestinationKind,
} from '../../shared/constants/backupDestinations.js';
import * as t from './backupTransports.js';
import * as drive from './googleDrive.js';

const FOLDER_KEY = 'backup.folder';

/* ================================================== where backups are written */

/**
 * The folder backups are written to and listed from.
 *
 * Configurable, because the default sits inside the application's data
 * directory — which is fine until a laboratory wants them on a second disk, or
 * somewhere their existing server backup already sweeps up. Falls back to the
 * default whenever the configured folder has gone away, so a disconnected USB
 * drive degrades to "still backing up, just not there" rather than "not backing
 * up at all".
 */
export function backupFolder(): string {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(FOLDER_KEY) as { value: string } | undefined;
  const configured = row?.value?.trim();
  if (!configured) return defaultBackupRoot;
  try {
    fs.mkdirSync(configured, { recursive: true });
    return configured;
  } catch {
    console.error(`[backup] configured folder ${configured} is unavailable; falling back to ${defaultBackupRoot}`);
    ensureDataDirs();
    return defaultBackupRoot;
  }
}

export function configuredFolder(): { path: string; isDefault: boolean; available: boolean } {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(FOLDER_KEY) as { value: string } | undefined;
  const configured = row?.value?.trim();
  if (!configured) return { path: defaultBackupRoot, isDefault: true, available: true };
  return { path: configured, isDefault: false, available: t.folderAvailable(configured) };
}

/** Change where backups are written. Existing archives are left where they are. */
export async function setBackupFolder(folder: string | null): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  if (!folder || !folder.trim()) {
    getDb().prepare('DELETE FROM settings WHERE key = ?').run(FOLDER_KEY);
    ensureDataDirs();
    return { ok: true, path: defaultBackupRoot };
  }
  const target = folder.trim();
  const ready = await t.folderCheckWithTimeout(target, 'folder');
  if (ready.ok !== true) return { ok: false, error: ready.error };
  getDb().prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`).run(FOLDER_KEY, target);
  return { ok: true, path: target };
}

/* ============================================================== destinations */

type Row = {
  id: number; kind: DestinationKind; name: string; enabled: number;
  config: string; secret: string | null;
  last_result: string | null; last_attempt_at: string | null; last_message: string | null;
};

const parse = (json: string | null): Record<string, unknown> => {
  try { return json ? JSON.parse(json) : {}; } catch { return {}; }
};

/** A destination as the client may see it: configuration without the secrets. */
function toPublic(row: Row, pending: number): BackupDestination {
  const config = parse(row.config);
  for (const key of secretFieldsOf(row.kind)) delete config[key];
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    enabled: row.enabled === 1,
    config,
    hasSecret: !!row.secret,
    lastResult: (row.last_result as 'success' | 'failed' | null) ?? null,
    lastAttemptAt: row.last_attempt_at,
    lastMessage: row.last_message,
    pending,
  };
}

/** Configuration WITH the secrets merged back in — server-side only. */
function fullConfig(row: Row): Record<string, unknown> {
  return { ...parse(row.config), ...parse(row.secret) };
}

const rows = (): Row[] => getDb().prepare('SELECT * FROM backup_destinations ORDER BY id').all() as Row[];
const rowOf = (id: number): Row | undefined => getDb().prepare('SELECT * FROM backup_destinations WHERE id = ?').get(id) as Row | undefined;

export function listDestinations(): BackupDestination[] {
  const all = rows();
  const sent = sentCounts();
  const total = countBackups();
  return all.map(r => toPublic(r, Math.max(0, total - (sent.get(r.id) ?? 0))));
}

function countBackups(): number {
  const dir = backupFolder();
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.zip') && !f.startsWith('.') && !f.startsWith('pre-restore-')).length;
}

function sentCounts(): Map<number, number> {
  const out = new Map<number, number>();
  for (const r of getDb().prepare(
    "SELECT destination_id AS id, COUNT(DISTINCT file_name) AS n FROM backup_sync_log WHERE status = 'success' AND destination_id IS NOT NULL GROUP BY destination_id",
  ).all() as Array<{ id: number; n: number }>) out.set(r.id, r.n);
  return out;
}

export type SaveInput = { kind: string; name?: string; enabled?: boolean; config: Record<string, unknown> };

/**
 * Create or update a destination, after proving it actually works.
 *
 * Testing before saving is the whole point: a destination that is only
 * discovered to be wrong at 02:00, in a log nobody reads, is worse than no
 * destination at all — the laboratory believes it is protected when it is not.
 */
export async function saveDestination(id: number | null, input: SaveInput): Promise<
  { ok: true; destination: BackupDestination; note?: string } | { ok: false; error: string }
> {
  const def = kindDef(input.kind);
  if (!def) return { ok: false, error: 'Unknown destination type.' };

  const existing = id ? rowOf(id) : undefined;
  if (id && !existing) return { ok: false, error: 'That destination no longer exists.' };

  // An edit that does not retype the password keeps the stored one.
  const merged: Record<string, unknown> = { ...(existing ? fullConfig(existing) : {}) };
  for (const [k, v] of Object.entries(input.config ?? {})) {
    if (v === '' && secretFieldsOf(input.kind).includes(k)) continue; // blank means "leave it"
    merged[k] = v;
  }

  const missing = missingFields(input.kind, merged, !!existing?.secret);
  if (missing.length > 0) return { ok: false, error: `Still needed: ${missing.join(', ')}.` };

  const verdict = await testConfig(input.kind as DestinationKind, merged);
  if (verdict.ok !== true) return { ok: false, error: verdict.error };

  // Google Drive resolves the folder's real name while testing, which is worth
  // keeping so the list can say "Drive folder \"Laboratory backups\"".
  if (verdict.detail?.folderName) merged.folderName = verdict.detail.folderName;

  const secretKeys = secretFieldsOf(input.kind);
  const secret: Record<string, unknown> = {};
  const plain: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(merged)) (secretKeys.includes(k) ? secret : plain)[k] = v;

  const name = (input.name ?? '').trim() || def.label;
  const enabled = input.enabled === false ? 0 : 1;
  const db = getDb();
  let savedId: number;
  if (existing) {
    db.prepare(`UPDATE backup_destinations SET kind = ?, name = ?, enabled = ?, config = ?, secret = ?,
      updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(input.kind, name, enabled, JSON.stringify(plain), Object.keys(secret).length ? JSON.stringify(secret) : null, existing.id);
    savedId = existing.id;
  } else {
    const r = db.prepare(`INSERT INTO backup_destinations (kind, name, enabled, config, secret)
      VALUES (?, ?, ?, ?, ?)`)
      .run(input.kind, name, enabled, JSON.stringify(plain), Object.keys(secret).length ? JSON.stringify(secret) : null);
    savedId = Number(r.lastInsertRowid);
  }
  return { ok: true, destination: toPublic(rowOf(savedId)!, countBackups()), note: verdict.note };
}

/**
 * Forget a destination, keeping the record of what was sent there.
 *
 * The sync log is evidence — an assessor asking "was the March backup ever off
 * site?" needs an answer that survives somebody tidying up the destination list.
 * So the rows are detached rather than deleted; they keep the name they were
 * written with and simply stop pointing at a row that no longer exists.
 */
export function deleteDestination(id: number): boolean {
  const db = getDb();
  return db.transaction(() => {
    db.prepare('UPDATE backup_sync_log SET destination_id = NULL WHERE destination_id = ?').run(id);
    return db.prepare('DELETE FROM backup_destinations WHERE id = ?').run(id).changes > 0;
  })();
}

export function setEnabled(id: number, enabled: boolean): boolean {
  return getDb().prepare('UPDATE backup_destinations SET enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(enabled ? 1 : 0, id).changes > 0;
}

/* ------------------------------------------------------------------ testing */

type TestVerdict =
  | { ok: true; note?: string; detail?: Record<string, string | null> }
  | { ok: false; error: string };

/** Prove a configuration reaches something real, without writing a backup. */
export async function testConfig(kind: DestinationKind, config: Record<string, unknown>): Promise<TestVerdict> {
  try {
    switch (kind) {
      case 'folder':
      case 'network': {
        const r = await t.folderCheckWithTimeout(String(config.path ?? ''), kind);
        return r.ok === true
          ? { ok: true, note: 'The folder exists and this host can write to it.' }
          : { ok: false, error: r.error };
      }
      case 's3': {
        const r = await t.s3Check(config as never);
        return r.ok === true ? { ok: true, note: r.note } : { ok: false, error: r.error };
      }
      case 'webdav': {
        const r = await t.webdavCheck(config as never);
        return r.ok === true ? { ok: true, note: r.note } : { ok: false, error: r.error };
      }
      case 'google_drive': {
        const key = drive.parseKey(String(config.serviceAccountKey ?? ''));
        if (!key) return { ok: false, error: 'That is not a valid service-account key. Paste the whole JSON file downloaded from the Google Cloud console.' };
        const r = await drive.testConnection(String(config.folderId ?? '') || null, key);
        return r.ok === true
          ? { ok: true, note: `Connected as ${r.clientEmail}.`, detail: { folderName: r.folderName } }
          : { ok: false, error: r.error };
      }
      default:
        return { ok: false, error: 'Unknown destination type.' };
    }
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}

export async function testDestination(id: number): Promise<TestVerdict> {
  const row = rowOf(id);
  if (!row) return { ok: false, error: 'That destination no longer exists.' };
  return testConfig(row.kind, fullConfig(row));
}

/* ------------------------------------------------------------------ copying */

export type CopyOutcome = {
  destinationId: number; destinationName: string; kind: DestinationKind;
  fileName: string; ok: boolean; error?: string; skipped?: boolean;
};

async function putTo(row: Row, filePath: string, fileName: string): Promise<t.TransportResult> {
  const config = fullConfig(row);
  switch (row.kind) {
    case 'folder':
    case 'network':
      return t.folderPut(filePath, fileName, String(config.path ?? ''), row.kind);
    case 's3':
      return t.s3Put(filePath, fileName, config as never);
    case 'webdav':
      return t.webdavPut(filePath, fileName, config as never);
    case 'google_drive': {
      const key = drive.parseKey(String(config.serviceAccountKey ?? ''));
      if (!key) return { ok: false, error: 'The stored Google key is unreadable. Reconnect this destination.' };
      const r = await drive.uploadBackup(filePath, fileName, String(config.folderId ?? '') || null, undefined, key);
      return r.ok === true ? { ok: true, remoteId: r.fileId } : { ok: false, error: r.error };
    }
    default:
      return { ok: false, error: 'Unknown destination type.' };
  }
}

async function listFrom(row: Row): Promise<t.RemoteFile[]> {
  const config = fullConfig(row);
  switch (row.kind) {
    case 'folder':
    case 'network':
      return t.folderList(String(config.path ?? ''));
    case 's3':
      return t.s3List(config as never);
    case 'webdav':
      return t.webdavList(config as never);
    case 'google_drive': {
      const key = drive.parseKey(String(config.serviceAccountKey ?? ''));
      if (!key) return [];
      return (await drive.listRemote(String(config.folderId ?? '') || null, key))
        .map(f => ({ id: f.id, name: f.name, createdAt: f.createdTime, size: f.size }));
    }
    default:
      return [];
  }
}

async function removeFrom(row: Row, remoteId: string): Promise<boolean> {
  const config = fullConfig(row);
  switch (row.kind) {
    case 'folder':
    case 'network': return t.folderDelete(remoteId);
    case 's3': return t.s3Delete(remoteId, config as never);
    case 'webdav': return t.webdavDelete(remoteId, config as never);
    case 'google_drive': {
      const key = drive.parseKey(String(config.serviceAccountKey ?? ''));
      return key ? drive.deleteRemote(remoteId, key) : false;
    }
    default: return false;
  }
}

function record(row: Row, fileName: string, ok: boolean, error: string | null, remoteId: string | null, sizeBytes: number, ms: number, userId: number | null) {
  const db = getDb();
  db.prepare(`INSERT INTO backup_sync_log (file_name, destination, destination_id, destination_name, status, remote_id, size_bytes, duration_ms, message, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(fileName, row.kind, row.id, row.name, ok ? 'success' : 'failed', remoteId, sizeBytes, ms, error, userId);
  db.prepare(`UPDATE backup_destinations SET last_result = ?, last_attempt_at = CURRENT_TIMESTAMP, last_message = ? WHERE id = ?`)
    .run(ok ? 'success' : 'failed', error, row.id);
}

/** Copy one backup to one destination, skipping it if it is already there. */
export async function copyOne(row: Row, fileName: string, userId: number | null): Promise<CopyOutcome> {
  const base = { destinationId: row.id, destinationName: row.name, kind: row.kind, fileName };
  const filePath = path.join(backupFolder(), fileName);
  if (!fs.existsSync(filePath)) {
    return { ...base, ok: false, error: 'That backup is no longer in the backup folder.' };
  }
  const sizeBytes = fs.statSync(filePath).size;
  const started = Date.now();

  // Already there? Don't send it twice — a manual sync and the nightly cycle
  // overlap often, and re-sending a 300 MB archive over a clinic's line hurts.
  try {
    const remote = await listFrom(row);
    const hit = remote.find(f => f.name === fileName);
    if (hit) {
      record(row, fileName, true, null, hit.id, sizeBytes, Date.now() - started, userId);
      return { ...base, ok: true, skipped: true };
    }
  } catch { /* if listing fails, try the copy anyway — it may still work */ }

  const result = await putTo(row, filePath, fileName);
  if (result.ok === true) {
    record(row, fileName, true, null, result.remoteId, sizeBytes, Date.now() - started, userId);
    return { ...base, ok: true };
  }
  record(row, fileName, false, result.error, null, sizeBytes, Date.now() - started, userId);
  return { ...base, ok: false, error: result.error };
}

/**
 * Copy one backup to every enabled destination.
 *
 * Each is attempted independently: the hospital server being down must not stop
 * the copy going to Backblaze, and neither must touch the local archive.
 */
export async function copyToAll(fileName: string, userId: number | null): Promise<CopyOutcome[]> {
  const out: CopyOutcome[] = [];
  for (const row of rows()) {
    if (row.enabled !== 1) continue;
    try { out.push(await copyOne(row, fileName, userId)); }
    catch (e) {
      record(row, fileName, false, (e as Error).message, null, 0, 0, userId);
      out.push({ destinationId: row.id, destinationName: row.name, kind: row.kind, fileName, ok: false, error: (e as Error).message });
    }
  }
  return out;
}

/** Which backups have never reached a given destination. */
export function pendingFor(id: number): string[] {
  const dir = backupFolder();
  if (!fs.existsSync(dir)) return [];
  const sent = new Set((getDb().prepare(
    "SELECT DISTINCT file_name FROM backup_sync_log WHERE status = 'success' AND destination_id = ?",
  ).all(id) as Array<{ file_name: string }>).map(r => r.file_name));
  return fs.readdirSync(dir)
    .filter(f => f.toLowerCase().endsWith('.zip') && !f.startsWith('.') && !f.startsWith('pre-restore-'))
    .filter(f => !sent.has(f))
    .sort()
    .reverse();
}

/** Send everything outstanding, newest first so the most valuable lands soonest. */
export async function syncPending(id: number | null, userId: number | null): Promise<CopyOutcome[]> {
  const targets = id ? rows().filter(r => r.id === id) : rows().filter(r => r.enabled === 1);
  const out: CopyOutcome[] = [];
  for (const row of targets) {
    for (const fileName of pendingFor(row.id)) {
      try { out.push(await copyOne(row, fileName, userId)); }
      catch (e) {
        out.push({ destinationId: row.id, destinationName: row.name, kind: row.kind, fileName, ok: false, error: (e as Error).message });
      }
    }
  }
  return out;
}

/** Apply the retention window to a destination, so copies do not pile up there. */
export async function pruneDestination(id: number, keepNames: Set<string>): Promise<string[]> {
  const row = rowOf(id);
  if (!row) return [];
  const removed: string[] = [];
  for (const file of await listFrom(row)) {
    if (!file.name.startsWith('sech-lims-backup-')) continue;
    if (keepNames.has(file.name)) continue;
    if (await removeFrom(row, file.id)) removed.push(file.name);
  }
  return removed;
}

export async function pruneAll(keepNames: Set<string>): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const row of rows()) {
    if (row.enabled !== 1) continue;
    try {
      const removed = await pruneDestination(row.id, keepNames);
      if (removed.length) out[row.name] = removed;
    } catch { /* a destination that cannot be pruned is not worth failing over */ }
  }
  return out;
}

export { describeDestination };

/* ------------------------------------------------------------- migration */

/**
 * Carry an existing single-Drive connection into the destinations list.
 *
 * Before destinations existed there was exactly one off-site option, and it
 * kept its key in a file and its folder in a settings row. A laboratory that
 * had set that up must not silently stop being backed up because the model
 * grew — so on first boot after the upgrade its connection becomes a
 * destination, switched on, and the old settings row is retired.
 *
 * Idempotent: once a Drive destination exists it does nothing.
 */
export function migrateLegacyDrive(): void {
  const db = getDb();
  const already = db.prepare("SELECT COUNT(*) AS n FROM backup_destinations WHERE kind = 'google_drive'").get() as { n: number };
  if (already.n > 0) return;

  const key = drive.readKey();
  if (!key) return;

  const row = db.prepare("SELECT value FROM settings WHERE key = 'backup.drive'").get() as { value: string } | undefined;
  let folderId: string | null = null;
  let folderName: string | null = null;
  try {
    const parsed = row ? JSON.parse(row.value) : {};
    folderId = parsed.folderId ?? null;
    folderName = parsed.folderName ?? null;
  } catch { /* an unreadable row just means no folder */ }

  db.prepare(`INSERT INTO backup_destinations (kind, name, enabled, config, secret)
    VALUES ('google_drive', ?, 1, ?, ?)`)
    .run(
      folderName ? `Google Drive — ${folderName}` : 'Google Drive',
      JSON.stringify({ folderId, folderName }),
      JSON.stringify({ serviceAccountKey: JSON.stringify(key) }),
    );
  db.prepare("DELETE FROM settings WHERE key = 'backup.drive'").run();
  console.log('[backup] existing Google Drive connection moved into the destinations list');
}
