/**
 * Scheduling backups, and copying them off site.
 *
 * The endpoints that make and restore archives live in routes/common.ts and are
 * unchanged. This is what wraps them: when backups happen without anybody
 * pressing a button, how long they are kept, and — if the laboratory has asked
 * for it — sending each one to Google Drive.
 *
 *   GET  /backup/status                 everything the settings screen shows
 *   GET/PUT /backup/schedule            when automatic backups run
 *   POST /backup/run-now                take a scheduled-style backup on demand
 *   POST /backup/prune                  apply the retention policy now
 *   GET  /backup/drive                  connection state (never the key)
 *   PUT  /backup/drive                  store the service-account key + folder
 *   POST /backup/drive/test             prove the credential and folder work
 *   DELETE /backup/drive                forget the credential
 *   POST /backup/drive/sync             copy backups up now
 *   GET  /backup/drive/history          what has been copied, and what failed
 *
 * Backups are the whole database. Changing where they go, or taking one on
 * demand, is settings work — so these sit behind the settings permissions, and
 * the two that reach the internet or destroy files sit behind `approve`.
 */
import { Router } from 'express';
import { requirePermission } from '../middleware/permissions.js';
import { audit } from '../services/auditService.js';
import { getDb } from '../db/database.js';
import { normaliseSchedule, describeSchedule, nextRunAfter } from '../../shared/constants/backup.js';
import * as backup from '../services/backupService.js';
import * as drive from '../services/googleDrive.js';

export function backupSyncRoutes() {
  const router = Router();

  /* ------------------------------------------------------------- schedule */

  router.get('/backup/status', requirePermission('settings', 'view'), (_req, res) => {
    res.json(backup.protectionStatus());
  });

  router.get('/backup/schedule', requirePermission('settings', 'view'), (_req, res) => {
    const schedule = backup.getSchedule();
    res.json({ schedule, description: describeSchedule(schedule), nextRun: nextRunAfter(schedule, new Date())?.toISOString() ?? null });
  });

  router.put('/backup/schedule', requirePermission('settings', 'edit'), (req, res) => {
    const before = backup.getSchedule();
    const schedule = backup.saveSchedule(normaliseSchedule(req.body));
    audit(req, { action: 'edit', entity: 'backup_schedule', newValue: schedule, oldValue: before });
    res.json({ ok: true, schedule, description: describeSchedule(schedule), nextRun: nextRunAfter(schedule, new Date())?.toISOString() ?? null });
  });

  /**
   * Run the whole cycle now — backup, prune, and copy off site if that is
   * configured. This is what "Back up now" does: the same thing the schedule
   * does at 02:00, so what the button produces is what the night produces.
   */
  router.post('/backup/run-now', requirePermission('settings', 'export'), async (req, res) => {
    const result = await backup.runScheduledBackup(req.user!.id);
    if (result.error) return res.status(500).json({ error: `The backup could not be written: ${result.error}` });
    audit(req, { action: 'create', entity: 'backup', entityId: result.backup?.fileName, newValue: { trigger: 'manual-full-cycle', pruned: result.pruned.length, synced: result.sync?.ok ?? null } });
    res.status(201).json(result);
  });

  router.post('/backup/prune', requirePermission('settings', 'approve'), (req, res) => {
    const schedule = backup.getSchedule();
    const removed = backup.pruneLocal(schedule);
    audit(req, { action: 'prune', entity: 'backup', newValue: { removed, retention: schedule.retention } });
    res.json({ ok: true, removed, message: removed.length ? `${removed.length} older backup(s) removed under the retention policy.` : 'Nothing to remove — every backup is still within the retention policy.' });
  });

  /* ---------------------------------------------------------------- drive */

  /** Connection state. The private key is never returned, only what it is. */
  router.get('/backup/drive', requirePermission('settings', 'view'), (_req, res) => {
    const key = drive.readKey();
    const settings = backup.getDriveSettings();
    res.json({
      connected: key !== null,
      clientEmail: key?.client_email ?? null,
      projectId: key?.project_id ?? null,
      folderId: settings.folderId,
      folderName: settings.folderName,
      pending: key ? backup.unsyncedBackups().length : 0,
    });
  });

  /**
   * Store the service-account key and the destination folder.
   *
   * The key is written to the config directory with owner-only permissions and
   * never goes back to a browser. Sending it is `approve` work: it is the
   * credential that decides where the laboratory's whole database can be sent.
   */
  router.put('/backup/drive', requirePermission('settings', 'approve'), async (req, res) => {
    const folderId = String(req.body?.folderId ?? '').trim() || null;
    if (folderId && !/^[A-Za-z0-9_-]{10,}$/.test(folderId)) {
      return res.status(400).json({ error: 'That does not look like a Drive folder ID. Open the folder in Drive; the ID is the last part of the address bar.' });
    }

    if (req.body?.serviceAccountKey) {
      const stored = drive.saveKey(String(req.body.serviceAccountKey));
      if (stored.ok !== true) return res.status(400).json({ error: stored.error });
    } else if (!drive.readKey()) {
      return res.status(400).json({ error: 'Paste the service-account key JSON to connect Google Drive.' });
    }

    // Prove it works before saying it is connected — a credential that is only
    // discovered to be wrong at 02:00 is worse than no credential.
    const test = await drive.testConnection(folderId);
    if (test.ok !== true) {
      if (req.body?.serviceAccountKey) drive.forgetKey();
      return res.status(400).json({ error: test.error });
    }

    backup.saveDriveSettings({ folderId, folderName: test.folderName });
    audit(req, { action: 'connect', entity: 'backup_drive', newValue: { clientEmail: test.clientEmail, folderId, folderName: test.folderName } });
    res.json({ ok: true, connected: true, clientEmail: test.clientEmail, folderId, folderName: test.folderName, quota: test.quota });
  });

  router.post('/backup/drive/test', requirePermission('settings', 'edit'), async (req, res) => {
    const folderId = req.body?.folderId !== undefined
      ? (String(req.body.folderId).trim() || null)
      : backup.getDriveSettings().folderId;
    const test = await drive.testConnection(folderId);
    if (test.ok !== true) return res.status(400).json({ ok: false, error: test.error });
    res.json({ ok: true, ...test });
  });

  router.delete('/backup/drive', requirePermission('settings', 'approve'), (req, res) => {
    const key = drive.readKey();
    drive.forgetKey();
    backup.saveDriveSettings({ folderId: null, folderName: null });
    // Turn off the automatic copy too, rather than leave a schedule pointing at
    // a credential that no longer exists and failing every night.
    const schedule = backup.getSchedule();
    if (schedule.syncToDrive) backup.saveSchedule({ ...schedule, syncToDrive: false });
    audit(req, { action: 'disconnect', entity: 'backup_drive', oldValue: { clientEmail: key?.client_email ?? null } });
    res.json({ ok: true, message: 'Google Drive is disconnected. Backups already copied there are untouched; new ones stay on this host only.' });
  });

  /**
   * Copy backups up now. With no body it sends everything that has never
   * reached Drive, which is what someone pressing "Sync now" after a spell
   * offline actually wants.
   */
  router.post('/backup/drive/sync', requirePermission('settings', 'export'), async (req, res) => {
    if (!drive.readKey()) return res.status(400).json({ error: 'Google Drive is not connected yet.' });

    let files: string[];
    if (req.body?.fileName) {
      if (!backup.isSafeBackupName(String(req.body.fileName))) return res.status(400).json({ error: 'Invalid backup file name.' });
      files = [String(req.body.fileName)];
    } else {
      files = backup.unsyncedBackups();
    }
    if (files.length === 0) {
      return res.json({ ok: true, results: [], message: 'Every backup on this host is already in Google Drive.' });
    }
    // Newest first: if the connection drops part-way, the most valuable copy is
    // the one that already made it.
    const results = [];
    for (const fileName of files) results.push(await backup.syncOne(fileName, req.user!.id));

    const sent = results.filter(r => r.ok).length;
    const failed = results.filter(r => !r.ok);
    audit(req, { action: 'sync', entity: 'backup_drive', newValue: { attempted: files.length, sent, failed: failed.length } });
    res.json({
      ok: failed.length === 0,
      results,
      message: failed.length === 0
        ? `${sent} backup(s) copied to Google Drive.`
        : `${sent} of ${files.length} copied. ${failed[0].error}`,
    });
  });

  router.get('/backup/drive/history', requirePermission('settings', 'view'), (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 200);
    res.json(getDb().prepare(`SELECT s.*, u.full_name AS by_name FROM backup_sync_log s
      LEFT JOIN users u ON u.id = s.created_by ORDER BY s.id DESC LIMIT ?`).all(limit));
  });

  return router;
}
