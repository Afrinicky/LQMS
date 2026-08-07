/**
 * Scheduling backups, where they are written, and where copies are sent.
 *
 * The endpoints that make and restore archives live in routes/common.ts. This is
 * what wraps them: when backups happen without anybody pressing a button, which
 * folder they land in, how long they are kept, and which destinations each one
 * is copied to.
 *
 *   GET  /backup/status                    everything the settings screen shows
 *   GET/PUT /backup/schedule               when automatic backups run
 *   GET/PUT /backup/folder                 where backups are written
 *   POST /backup/run-now                   the whole cycle, on demand
 *   POST /backup/prune                     apply the retention policy now
 *   GET  /backup/destinations              the list (never the credentials)
 *   GET  /backup/destination-kinds         what can be added, and what each needs
 *   POST/PUT /backup/destinations[/:id]    add or change one, proving it works
 *   POST /backup/destinations/:id/test     re-check a stored one
 *   POST /backup/destinations/:id/toggle   switch one on or off
 *   DELETE /backup/destinations/:id        forget one
 *   POST /backup/destinations/sync         copy outstanding backups out now
 *   GET  /backup/sync-history              what has been copied, and what failed
 *
 * Backups are the whole database. Taking one or reading the settings is
 * `settings` work; anything that changes where the laboratory's data can be
 * sent, or that deletes archives, needs `approve`.
 */
import { Router } from 'express';
import { requirePermission } from '../middleware/permissions.js';
import { audit } from '../services/auditService.js';
import { getDb } from '../db/database.js';
import { normaliseSchedule, describeSchedule, nextRunAfter } from '../../shared/constants/backup.js';
import { DESTINATION_KINDS_DEF, secretFieldsOf } from '../../shared/constants/backupDestinations.js';
import * as backup from '../services/backupService.js';
import * as dest from '../services/backupDestinations.js';

/** Keep credentials out of the audit trail — record that they changed, not what to. */
const redact = (kind: string, config: Record<string, unknown> = {}) => {
  const out: Record<string, unknown> = { ...config };
  for (const key of secretFieldsOf(kind)) if (out[key]) out[key] = '(changed)';
  return out;
};

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

  /* --------------------------------------------------------------- folder */

  router.get('/backup/folder', requirePermission('settings', 'view'), (_req, res) => {
    res.json(dest.configuredFolder());
  });

  /**
   * Move where backups are written.
   *
   * Archives already on disk stay where they are — moving hundreds of megabytes
   * without being asked is not this endpoint's business, and the old folder is
   * still readable if somebody needs what is in it.
   */
  router.put('/backup/folder', requirePermission('settings', 'approve'), async (req, res) => {
    const before = dest.configuredFolder();
    const result = await dest.setBackupFolder(req.body?.path ?? null);
    if (result.ok !== true) return res.status(400).json({ error: result.error });
    audit(req, { action: 'edit', entity: 'backup_folder', oldValue: { path: before.path }, newValue: { path: result.path } });
    res.json({
      ok: true, ...dest.configuredFolder(),
      message: `New backups will be written to ${result.path}. Archives already taken stay where they are.`,
    });
  });

  /** Check a folder is usable before committing to it. */
  router.post('/backup/folder/test', requirePermission('settings', 'edit'), async (req, res) => {
    const verdict = await dest.testConfig('folder', { path: String(req.body?.path ?? '') });
    if (verdict.ok !== true) return res.status(400).json({ ok: false, error: verdict.error });
    res.json({ ok: true, note: verdict.note });
  });

  /* ---------------------------------------------------------- the cycle */

  router.post('/backup/run-now', requirePermission('settings', 'export'), async (req, res) => {
    const result = await backup.runScheduledBackup(req.user!.id);
    if (result.error) return res.status(500).json({ error: `The backup could not be written: ${result.error}` });
    audit(req, {
      action: 'create', entity: 'backup', entityId: result.backup?.fileName,
      newValue: { trigger: 'manual', pruned: result.pruned.length, copies: result.copies.map(c => ({ to: c.destinationName, ok: c.ok })) },
    });
    res.status(201).json(result);
  });

  router.post('/backup/prune', requirePermission('settings', 'approve'), (req, res) => {
    const schedule = backup.getSchedule();
    const removed = backup.pruneLocal(schedule);
    audit(req, { action: 'prune', entity: 'backup', newValue: { removed, retention: schedule.retention } });
    res.json({
      ok: true, removed,
      message: removed.length
        ? `${removed.length} older backup(s) removed under the retention policy.`
        : 'Nothing to remove — every backup is still within the retention policy.',
    });
  });

  /* --------------------------------------------------------- destinations */

  /** What can be added, and which fields each kind needs. Drives the forms. */
  router.get('/backup/destination-kinds', requirePermission('settings', 'view'), (_req, res) => {
    res.json(DESTINATION_KINDS_DEF);
  });

  router.get('/backup/destinations', requirePermission('settings', 'view'), (_req, res) => {
    res.json(dest.listDestinations());
  });

  /**
   * Add or change a destination.
   *
   * The configuration is tested against the real thing before it is stored, so
   * a laboratory never ends up believing it has an off-site copy that has in
   * fact been failing quietly since the day it was set up.
   */
  const save = (idFrom: (req: { params: Record<string, string> }) => number | null) =>
    async (req: any, res: any) => {
      const id = idFrom(req);
      const result = await dest.saveDestination(id, {
        kind: String(req.body?.kind ?? ''),
        name: req.body?.name,
        enabled: req.body?.enabled,
        config: req.body?.config ?? {},
      });
      if (result.ok !== true) return res.status(400).json({ error: result.error });
      audit(req, {
        action: id ? 'edit' : 'create', entity: 'backup_destination', entityId: result.destination.id,
        newValue: { kind: result.destination.kind, name: result.destination.name, config: redact(result.destination.kind, req.body?.config) },
      });
      res.status(id ? 200 : 201).json({ ok: true, destination: result.destination, note: result.note });
    };

  router.post('/backup/destinations', requirePermission('settings', 'approve'), save(() => null));
  router.put('/backup/destinations/:id', requirePermission('settings', 'approve'), save(req => Number(req.params.id)));

  router.post('/backup/destinations/:id/test', requirePermission('settings', 'edit'), async (req, res) => {
    const verdict = await dest.testDestination(Number(req.params.id));
    if (verdict.ok !== true) return res.status(400).json({ ok: false, error: verdict.error });
    res.json({ ok: true, note: verdict.note });
  });

  router.post('/backup/destinations/:id/toggle', requirePermission('settings', 'edit'), (req, res) => {
    const enabled = req.body?.enabled !== false;
    if (!dest.setEnabled(Number(req.params.id), enabled)) return res.status(404).json({ error: 'That destination no longer exists.' });
    audit(req, { action: enabled ? 'enable' : 'disable', entity: 'backup_destination', entityId: req.params.id });
    res.json({ ok: true, enabled });
  });

  router.delete('/backup/destinations/:id', requirePermission('settings', 'approve'), (req, res) => {
    const before = dest.listDestinations().find(d => d.id === Number(req.params.id));
    if (!dest.deleteDestination(Number(req.params.id))) return res.status(404).json({ error: 'That destination no longer exists.' });
    audit(req, { action: 'delete', entity: 'backup_destination', entityId: req.params.id, oldValue: { kind: before?.kind, name: before?.name } });
    res.json({
      ok: true,
      message: `${before?.name ?? 'That destination'} removed. Copies already sent there are untouched; new backups will not go there.`,
    });
  });

  /**
   * Copy outstanding backups out now. With no body it catches every enabled
   * destination up — which is what somebody presses after a spell offline.
   */
  router.post('/backup/destinations/sync', requirePermission('settings', 'export'), async (req, res) => {
    const id = req.body?.destinationId ? Number(req.body.destinationId) : null;
    const results = await dest.syncPending(id, req.user!.id);
    if (results.length === 0) {
      return res.json({ ok: true, results: [], message: 'Every backup has already reached every destination.' });
    }
    const sent = results.filter(r => r.ok).length;
    const failed = results.filter(r => !r.ok);
    audit(req, { action: 'sync', entity: 'backup_destination', newValue: { attempted: results.length, sent, failed: failed.length } });
    res.json({
      ok: failed.length === 0,
      results,
      message: failed.length === 0
        ? `${sent} copy(ies) sent.`
        : `${sent} of ${results.length} sent. ${failed[0].destinationName}: ${failed[0].error}`,
    });
  });

  router.get('/backup/sync-history', requirePermission('settings', 'view'), (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 200);
    // The name is resolved from the destination if it still exists and from the
    // row itself otherwise, so history reads properly after one is removed.
    res.json(getDb().prepare(`SELECT s.id, s.file_name, s.destination, s.destination_id, s.status,
        s.remote_id, s.size_bytes, s.duration_ms, s.message, s.created_by, s.created_at,
        u.full_name AS by_name,
        COALESCE(d.name, s.destination_name, s.destination) AS destination_name
      FROM backup_sync_log s
      LEFT JOIN users u ON u.id = s.created_by
      LEFT JOIN backup_destinations d ON d.id = s.destination_id
      ORDER BY s.id DESC LIMIT ?`).all(limit));
  });

  return router;
}
