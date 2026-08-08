/**
 * The System Audit workspace.
 *
 * Two halves that answer two different questions:
 *
 *   the trail   what has been happening — every action, live, filterable, with
 *               the actor named and a link to the record it touched
 *   the flags   what has not been happening — everything due and not done, and
 *               every place the data disagrees with itself
 *
 * The rule for both is the same and it is the one the laboratory asked for:
 * anything shown here must lead to the thing it is about. Every trail entry and
 * every flag carries an action URL; nothing is a dead end.
 */
import { Router } from 'express';
import { getDb } from '../db/database.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import { audit } from '../services/auditService.js';
import { parseIntNullable } from './routeHelpers.js';
import { AUDIT_FLAG_CATEGORY_LABELS, AUDIT_FLAG_STATUSES } from '../../shared/constants/activities.js';
import { checkCatalogue, runAuditScan } from '../services/systemAuditService.js';
import { addDays, monthOf, todayIso } from '../services/dutyService.js';
import { currentObligations } from '../services/scheduleRollover.js';

/**
 * Where a trail entry leads.
 *
 * An audit row names a table and a row id, which is precise but useless to
 * read; this turns that into the screen a person can actually open. An entity
 * with no mapping falls back to the audit workspace itself rather than to a
 * broken link.
 */
const ENTITY_ROUTES: Record<string, (id: string) => string> = {
  duty_rosters: id => `/personnel?tab=Duty%20Roster&focus=duty_rosters:${id}`,
  duty_roster_rows: () => '/personnel?tab=Duty%20Roster',
  reassignment_schedules: id => `/personnel?tab=Unit%20Reassignments&focus=reassignment_schedules:${id}`,
  bench_schedules: id => `/personnel?tab=Bench%20Schedules&focus=bench_schedules:${id}`,
  roster_shift_types: () => '/settings/scheduling',
  section_benches: () => '/settings/sections',
  unit_activities: id => `/settings/activities?focus=unit_activities:${id}`,
  activity_occurrences: id => `/system-audit?tab=Not%20Done&focus=activity_occurrences:${id}`,
  scheduling_policy: () => '/settings/activities?tab=Scheduling%20policy',
  notification_sounds: () => '/settings/activities?tab=Reminder%20sounds',
  notification_sound_prefs: () => '/settings/activities?tab=Reminder%20sounds',
  staff: id => `/personnel?tab=Master%20Personnel%20Register&focus=staff:${id}`,
  users: id => `/settings/people?focus=users:${id}`,
  roles: () => '/settings/people',
  role_permissions: () => '/settings/people',
  user_permission_overrides: id => `/settings/people?focus=users:${id}`,
  sections: id => `/settings/sections?focus=sections:${id}`,
  departments: () => '/settings/sections',
  positions: () => '/settings/people',
  equipment_items: id => `/equipment?tab=Equipment%20Register&focus=equipment_items:${id}`,
  equipment_maintenance_records: id => `/equipment?tab=Maintenance&focus=equipment_maintenance_records:${id}`,
  equipment_schedules: () => '/equipment?tab=Equipment%20Register',
  inventory_items: id => `/supplier-inventory?tab=Item%20Register&focus=inventory_items:${id}`,
  inventory_batches: id => `/supplier-inventory?tab=Batches%2FLots&focus=inventory_batches:${id}`,
  suppliers: id => `/supplier-inventory?tab=Suppliers&focus=suppliers:${id}`,
  documents: id => `/documents?tab=Documents&focus=documents:${id}`,
  document_versions: () => '/documents?tab=Documents',
  nonconforming_events: id => `/nonconformities?tab=Register&focus=nonconforming_events:${id}`,
  capa_records: id => `/capa?tab=Register&focus=capa_records:${id}`,
  complaints: id => `/complaints?tab=Complaints%20Register&focus=complaints:${id}`,
  risks: id => `/risks?tab=Risk%20Register&focus=risks:${id}`,
  actions: id => `/actions?focus=actions:${id}`,
  incidents: id => `/incidents?focus=incidents:${id}`,
  safety_incidents: id => `/facilities-safety?tab=Safety%20Incidents&focus=safety_incidents:${id}`,
  monitoring_readings: () => '/monitoring?tab=Readings',
  monitoring_items: id => `/monitoring?tab=Monitoring%20Items&focus=monitoring_items:${id}`,
  environmental_assets: id => `/facilities-safety?tab=Environmental%20Monitoring&focus=environmental_assets:${id}`,
  environmental_readings: () => '/facilities-safety?tab=Environmental%20Monitoring&subtab=Readings',
  environmental_excursions: id => `/facilities-safety?tab=Environmental%20Monitoring&subtab=Excursions&focus=environmental_excursions:${id}`,
  iqc_results: () => '/iqc?tab=Review',
  iqc_runs: () => '/iqc?tab=Runs',
  iqc_materials: () => '/iqc?tab=Materials',
  eqa_events: id => `/eqa?tab=EQA%20Events&focus=eqa_events:${id}`,
  notifications: () => '/notifications?tab=Full%20Inbox',
  system_modules: () => '/settings/system',
  laboratory_profile: () => '/settings/laboratory',
  backup_logs: () => '/settings/system',
  files: () => '/records-reports?tab=Evidence%20Packs',
  evidence_files: () => '/records-reports?tab=Evidence%20Packs',
};

function actionUrlForEntry(entity: string, entityId: string | null): string {
  const route = ENTITY_ROUTES[entity];
  if (route && entityId) return route(entityId);
  if (route) return route('');
  return '/system-audit?tab=Live%20Trail';
}

const ACTION_VERBS: Record<string, string> = {
  create: 'created', edit: 'updated', delete: 'deleted', void_archive: 'archived',
  approve: 'approved', publish: 'published', print: 'printed', export: 'exported',
  login: 'signed in', logout: 'signed out', complete: 'completed', missed: 'was missed',
  carry_forward: 'was carried forward', restore: 'restored', backup: 'backed up',
};

function summarise(entry: any): string {
  const verb = ACTION_VERBS[entry.action] ?? entry.action.replace(/_/g, ' ');
  const who = entry.actor_name || entry.actor_username || 'The system';
  const what = String(entry.entity || '').replace(/_/g, ' ');
  return `${who} ${verb} ${what}${entry.entity_id ? ` #${entry.entity_id}` : ''}`;
}

export function systemAuditRoutes() {
  const router = Router();
  router.use(requireAuth);

  /* ======================================================================
     The live trail
     ==================================================================== */
  router.get('/trail', requirePermission('system_audit.trail', 'view'), (req, res) => {
    const db = getDb();
    const limit = Math.min(500, Math.max(1, parseIntNullable(req.query.limit) ?? 100));
    const offset = Math.max(0, parseIntNullable(req.query.offset) ?? 0);

    const clauses: string[] = [];
    const params: unknown[] = [];
    if (req.query.action) { clauses.push('a.action = ?'); params.push(req.query.action); }
    if (req.query.entity) { clauses.push('a.entity = ?'); params.push(req.query.entity); }
    if (req.query.actorId) { clauses.push('a.actor_user_id = ?'); params.push(req.query.actorId); }
    if (req.query.from) { clauses.push('a.created_at >= ?'); params.push(String(req.query.from)); }
    if (req.query.to) { clauses.push('a.created_at <= ?'); params.push(`${String(req.query.to)} 23:59:59`); }
    if (req.query.search) {
      clauses.push('(a.entity LIKE ? OR a.entity_id LIKE ? OR a.action LIKE ? OR u.full_name LIKE ? OR u.username LIKE ?)');
      const like = `%${String(req.query.search)}%`;
      params.push(like, like, like, like, like);
    }
    // "Since" powers the live tail: the client sends the newest id it holds and
    // gets only what has happened since, so an open audit screen stays current
    // without re-downloading the whole page every few seconds.
    if (req.query.sinceId) { clauses.push('a.id > ?'); params.push(req.query.sinceId); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    const rows = db.prepare(`SELECT a.*, u.full_name AS actor_name, u.username AS actor_username
       FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id
       ${where} ORDER BY a.id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset) as any[];
    const total = (db.prepare(`SELECT COUNT(*) n FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id ${where}`).get(...params) as any).n;

    res.json({
      entries: rows.map(row => ({
        ...row,
        action_url: actionUrlForEntry(String(row.entity), row.entity_id ? String(row.entity_id) : null),
        summary: summarise(row),
      })),
      total, offset, limit,
      actions: (db.prepare('SELECT DISTINCT action FROM audit_logs ORDER BY action').all() as any[]).map(r => r.action),
      entities: (db.prepare('SELECT DISTINCT entity FROM audit_logs ORDER BY entity').all() as any[]).map(r => r.entity),
      actors: db.prepare(`SELECT DISTINCT u.id, COALESCE(u.full_name, u.username) AS name FROM audit_logs a
         JOIN users u ON u.id = a.actor_user_id ORDER BY name`).all(),
    });
  });

  /* ======================================================================
     Flags
     ==================================================================== */
  router.get('/flags', requirePermission('system_audit.flags', 'view'), (req, res) => {
    const db = getDb();
    const clauses: string[] = [];
    const params: unknown[] = [];
    const status = req.query.status ? String(req.query.status) : 'open';
    if (status !== 'all') {
      if (status === 'open') clauses.push("f.status IN ('open','acknowledged')");
      else { clauses.push('f.status = ?'); params.push(status); }
    }
    if (req.query.category) { clauses.push('f.category = ?'); params.push(req.query.category); }
    if (req.query.severity) { clauses.push('f.severity = ?'); params.push(req.query.severity); }
    if (req.query.checkKey) { clauses.push('f.check_key = ?'); params.push(req.query.checkKey); }
    if (req.query.moduleKey) { clauses.push('f.module_key = ?'); params.push(req.query.moduleKey); }
    if (req.query.sectionId) { clauses.push('f.section_id = ?'); params.push(req.query.sectionId); }
    if (req.query.search) {
      clauses.push('(f.title LIKE ? OR f.detail LIKE ?)');
      const like = `%${String(req.query.search)}%`;
      params.push(like, like);
    }

    res.json(db.prepare(`SELECT f.*, s.name AS section_name, st.full_name AS responsible_name,
         u.full_name AS acknowledged_by_name
       FROM system_audit_flags f
       LEFT JOIN sections s ON s.id = f.section_id
       LEFT JOIN staff st ON st.id = f.responsible_staff_id
       LEFT JOIN users u ON u.id = f.acknowledged_by
       ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
       ORDER BY CASE f.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
                f.first_seen_at
       LIMIT 500`).all(...params));
  });

  router.post('/flags/:id/acknowledge', requirePermission('system_audit.flags', 'edit'), (req, res) => {
    const db = getDb();
    const flag = db.prepare('SELECT * FROM system_audit_flags WHERE id = ?').get(req.params.id) as any;
    if (!flag) return res.status(404).json({ error: 'Flag not found' });
    db.prepare("UPDATE system_audit_flags SET status = 'acknowledged', acknowledged_by = ?, acknowledged_at = CURRENT_TIMESTAMP, resolution_note = ? WHERE id = ?")
      .run(req.user!.id, req.body?.note ?? flag.resolution_note, req.params.id);
    audit(req, { action: 'acknowledge', entity: 'system_audit_flags', entityId: req.params.id, newValue: { note: req.body?.note ?? null } });
    res.json({ ok: true });
  });

  /**
   * Dismiss a flag as not a problem here.
   *
   * A reason is required. A dismissal without one is indistinguishable from
   * somebody clearing the screen, and the next assessor will ask.
   */
  router.post('/flags/:id/dismiss', requirePermission('system_audit.flags', 'edit'), (req, res) => {
    const db = getDb();
    const flag = db.prepare('SELECT * FROM system_audit_flags WHERE id = ?').get(req.params.id) as any;
    if (!flag) return res.status(404).json({ error: 'Flag not found' });
    const note = String(req.body?.note ?? '').trim();
    if (!note) return res.status(400).json({ error: 'Give the reason this flag does not apply before dismissing it.' });
    db.prepare("UPDATE system_audit_flags SET status = 'dismissed', resolved_at = CURRENT_TIMESTAMP, resolution_note = ?, acknowledged_by = ? WHERE id = ?")
      .run(note, req.user!.id, req.params.id);
    audit(req, { action: 'dismiss', entity: 'system_audit_flags', entityId: req.params.id, oldValue: { status: flag.status }, newValue: { note } });
    res.json({ ok: true });
  });

  router.post('/flags/:id/resolve', requirePermission('system_audit.flags', 'edit'), (req, res) => {
    const db = getDb();
    const flag = db.prepare('SELECT * FROM system_audit_flags WHERE id = ?').get(req.params.id) as any;
    if (!flag) return res.status(404).json({ error: 'Flag not found' });
    db.prepare("UPDATE system_audit_flags SET status = 'resolved', resolved_at = CURRENT_TIMESTAMP, resolution_note = ? WHERE id = ?")
      .run(req.body?.note ?? 'Marked resolved.', req.params.id);
    audit(req, { action: 'resolve', entity: 'system_audit_flags', entityId: req.params.id, newValue: { note: req.body?.note ?? null } });
    res.json({ ok: true });
  });

  /** Raise a CAPA-style action from a flag, so a finding becomes tracked work. */
  router.post('/flags/:id/raise-action', requirePermission('system_audit.flags', 'edit'), (req, res) => {
    const db = getDb();
    const flag = db.prepare('SELECT * FROM system_audit_flags WHERE id = ?').get(req.params.id) as any;
    if (!flag) return res.status(404).json({ error: 'Flag not found' });
    const result = db.prepare(`INSERT INTO actions (title, module_key, source_module, source_record_id, description, status, priority, assigned_to_staff_id, due_date, created_by)
       VALUES (?, ?, 'system_audit', ?, ?, 'Not started', ?, ?, ?, ?)`)
      .run(flag.title, flag.module_key || 'system_audit', String(flag.id), flag.detail,
        flag.severity === 'critical' ? 'high' : 'normal',
        parseIntNullable(req.body?.assignedToStaffId) ?? flag.responsible_staff_id,
        req.body?.dueDate ?? null, req.user!.id);
    const actionId = Number(result.lastInsertRowid);
    db.prepare("UPDATE system_audit_flags SET status = 'acknowledged', acknowledged_by = ?, acknowledged_at = CURRENT_TIMESTAMP, resolution_note = ? WHERE id = ?")
      .run(req.user!.id, `Action #${actionId} raised.`, req.params.id);
    audit(req, { action: 'create', entity: 'actions', entityId: actionId, newValue: { fromAuditFlag: flag.id } });
    res.status(201).json({ actionId });
  });

  /* ======================================================================
     Not done — the omission register, in the laboratory's own terms
     ==================================================================== */
  router.get('/not-done', requirePermission('system_audit.flags', 'view'), (req, res) => {
    const db = getDb();
    const from = req.query.from ? String(req.query.from) : addDays(todayIso(), -30);
    const to = req.query.to ? String(req.query.to) : todayIso();
    const clauses = ['o.occurrence_date BETWEEN ? AND ?', "o.status = 'missed'"];
    const params: unknown[] = [from, to];
    if (req.query.sectionId) { clauses.push('o.section_id = ?'); params.push(req.query.sectionId); }

    res.json(db.prepare(`SELECT o.id, o.occurrence_date, o.window_end, o.section_id, o.missed_flagged_at,
         a.id AS activity_id, a.name AS activity_name, a.activity_code, a.category, a.frequency, a.priority,
         a.redesign_status, a.target_route, s.name AS section_name,
         (SELECT GROUP_CONCAT(st.full_name, ', ') FROM activity_assignees ag JOIN staff st ON st.id = ag.staff_id
           WHERE ag.occurrence_id = o.id AND ag.is_watcher = 0) AS assignee_names
       FROM activity_occurrences o
       JOIN unit_activities a ON a.id = o.activity_id
       LEFT JOIN sections s ON s.id = o.section_id
       WHERE ${clauses.join(' AND ')}
       ORDER BY o.occurrence_date DESC, a.name`).all(...params));
  });

  /* ======================================================================
     Overview
     ==================================================================== */
  router.get('/summary', requirePermission('system_audit.flags', 'view'), (_req, res) => {
    const db = getDb();
    const today = todayIso();
    const weekAgo = addDays(today, -7);
    const count = (sql: string, ...params: unknown[]) => Number((db.prepare(sql).get(...params) as any)?.n ?? 0);

    const byCategory = (db.prepare(`SELECT category, COUNT(*) n, SUM(CASE WHEN severity = 'critical' THEN 1 ELSE 0 END) c
       FROM system_audit_flags WHERE status IN ('open','acknowledged') GROUP BY category ORDER BY n DESC`).all() as any[])
      .map(row => ({
        category: row.category,
        label: AUDIT_FLAG_CATEGORY_LABELS[row.category as keyof typeof AUDIT_FLAG_CATEGORY_LABELS] ?? row.category,
        count: Number(row.n), critical: Number(row.c),
      }));

    const obligations = currentObligations(db, today);

    res.json({
      generatedAt: new Date().toISOString(),
      flags: {
        open: count("SELECT COUNT(*) n FROM system_audit_flags WHERE status = 'open'"),
        acknowledged: count("SELECT COUNT(*) n FROM system_audit_flags WHERE status = 'acknowledged'"),
        critical: count("SELECT COUNT(*) n FROM system_audit_flags WHERE status IN ('open','acknowledged') AND severity = 'critical'"),
        high: count("SELECT COUNT(*) n FROM system_audit_flags WHERE status IN ('open','acknowledged') AND severity = 'high'"),
        medium: count("SELECT COUNT(*) n FROM system_audit_flags WHERE status IN ('open','acknowledged') AND severity = 'medium'"),
        low: count("SELECT COUNT(*) n FROM system_audit_flags WHERE status IN ('open','acknowledged') AND severity = 'low'"),
        newToday: count("SELECT COUNT(*) n FROM system_audit_flags WHERE substr(first_seen_at, 1, 10) = ?", today),
        resolvedToday: count("SELECT COUNT(*) n FROM system_audit_flags WHERE substr(resolved_at, 1, 10) = ?", today),
      },
      byCategory,
      byModule: db.prepare(`SELECT module_key, COUNT(*) count FROM system_audit_flags
         WHERE status IN ('open','acknowledged') AND module_key IS NOT NULL GROUP BY module_key ORDER BY count DESC`).all(),
      trail: {
        eventsToday: count('SELECT COUNT(*) n FROM audit_logs WHERE substr(created_at, 1, 10) = ?', today),
        eventsThisWeek: count('SELECT COUNT(*) n FROM audit_logs WHERE substr(created_at, 1, 10) >= ?', weekAgo),
        actors: count('SELECT COUNT(DISTINCT actor_user_id) n FROM audit_logs WHERE substr(created_at, 1, 10) >= ?', weekAgo),
        entities: count('SELECT COUNT(DISTINCT entity) n FROM audit_logs WHERE substr(created_at, 1, 10) >= ?', weekAgo),
        lastEventAt: (db.prepare('SELECT MAX(created_at) d FROM audit_logs').get() as any)?.d ?? null,
      },
      activities: {
        dueToday: count("SELECT COUNT(*) n FROM activity_occurrences WHERE status IN ('pending','in_progress') AND window_start <= ? AND window_end >= ?", today, today),
        doneToday: count("SELECT COUNT(*) n FROM activity_occurrences WHERE status = 'done' AND substr(completed_at, 1, 10) = ?", today),
        missedThisWeek: count("SELECT COUNT(*) n FROM activity_occurrences WHERE status = 'missed' AND occurrence_date >= ?", weekAgo),
        flaggedForRedesign: count("SELECT COUNT(*) n FROM unit_activities WHERE redesign_status IN ('flagged','in_progress')"),
      },
      schedules: {
        pending: obligations.filter(o => o.status === 'due_soon').length,
        overdue: obligations.filter(o => o.status === 'overdue').length,
        carriedForwardThisMonth: count('SELECT COUNT(*) n FROM schedule_carry_forwards WHERE month = ?', monthOf(today)),
      },
      lastScan: db.prepare('SELECT s.*, u.full_name AS triggered_by_name FROM system_audit_scans s LEFT JOIN users u ON u.id = s.triggered_by ORDER BY s.id DESC LIMIT 1').get() ?? null,
    });
  });

  /* ======================================================================
     Checks and scans
     ==================================================================== */
  router.get('/checks', requirePermission('system_audit.checks', 'view'), (_req, res) => {
    res.json(checkCatalogue(getDb()));
  });

  router.get('/scans', requirePermission('system_audit.checks', 'view'), (_req, res) => {
    res.json(getDb().prepare('SELECT s.*, u.full_name AS triggered_by_name FROM system_audit_scans s LEFT JOIN users u ON u.id = s.triggered_by ORDER BY s.id DESC LIMIT 50').all());
  });

  router.post('/scan', requirePermission('system_audit.checks', 'create'), (req, res) => {
    const db = getDb();
    const result = runAuditScan(db, req.user!.id);
    audit(req, { action: 'scan', entity: 'system_audit_flags', entityId: String(result.scanId), newValue: result });
    res.json(result);
  });

  /** Schedule obligations, for the Schedules tab. */
  router.get('/schedules', requirePermission('system_audit.flags', 'view'), (req, res) => {
    const db = getDb();
    const today = req.query.date ? String(req.query.date) : todayIso();
    res.json({
      obligations: currentObligations(db, today),
      carryForwards: db.prepare(`SELECT cf.*, s.name AS section_name FROM schedule_carry_forwards cf
         LEFT JOIN sections s ON s.id = cf.section_id ORDER BY cf.month DESC, cf.id DESC LIMIT 100`).all(),
    });
  });

  /** The statuses and categories the client filters on, from one source. */
  router.get('/meta', (_req, res) => {
    res.json({ statuses: AUDIT_FLAG_STATUSES, categories: AUDIT_FLAG_CATEGORY_LABELS });
  });

  return router;
}
