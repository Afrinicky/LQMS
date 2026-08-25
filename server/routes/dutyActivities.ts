/**
 * Duty, unit activities and reminder sounds.
 *
 * Three groups of endpoints, gated differently on purpose:
 *
 *   /today, /context, /occurrences/:id/*   a person's own work — authentication
 *                                          is the only gate, exactly as their
 *                                          own inbox and own profile are
 *   /activities, /policy, /proposals       configuring the programme — gated on
 *                                          personnel.activities
 *   /sounds, /sound-settings               everyone chooses their own chime; the
 *                                          laboratory default needs settings
 *
 * The first group matters most. A member of staff must never need a permission
 * to be told what they are on duty to do.
 */
import { Router } from 'express';
import { getDb } from '../db/database.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import { audit } from '../services/auditService.js';
import { parseIntNullable, getCurrentStaffId } from './routeHelpers.js';
import {
  ACTIVITY_CATEGORIES, ACTIVITY_FREQUENCIES, ASSIGN_MODES, BUILTIN_SOUNDS,
  DEFAULT_SOUND_FOR_EVENT, REDESIGN_STATUSES, SOUND_EVENTS,
} from '../../shared/constants/activities.js';
import {
  adoptProposals, completeOccurrence, generateOccurrences, occurrencesOn,
  proposeActivities, refreshAssignments, runActivityTick, todosFor,
} from '../services/activityService.js';
import { dutyContextFor, todayIso } from '../services/dutyService.js';
import {
  currentObligations, ensureMonthSchedules, schedulingPolicy, runScheduleTick,
} from '../services/scheduleRollover.js';

function isIsoDate(value: unknown): boolean {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function jsonOrNull(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) return value.length ? JSON.stringify(value) : null;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/* ============================================================================
   Sound preferences
   ----------------------------------------------------------------------------
   Two rows: the laboratory's default and, optionally, the user's own. The
   effective settings are the laboratory's overlaid with whatever the user has
   actually chosen, so a laboratory changing its default reaches everyone who
   has not overridden it.
   ========================================================================= */
const SOUND_COLUMNS = ['enabled', 'volume', 'desktop_enabled', 'mobile_enabled', 'repeat_count',
  'quiet_hours_start', 'quiet_hours_end', 'daily_briefing_enabled',
  'sound_todo', 'sound_reminder', 'sound_overdue', 'sound_critical', 'sound_schedule', 'sound_briefing'] as const;

function laboratorySoundPrefs(db: any): any {
  const row = db.prepare("SELECT * FROM notification_sound_prefs WHERE scope = 'laboratory'").get();
  if (row) return row;
  db.prepare("INSERT INTO notification_sound_prefs (scope, user_id) VALUES ('laboratory', NULL)").run();
  return db.prepare("SELECT * FROM notification_sound_prefs WHERE scope = 'laboratory'").get();
}

function userSoundPrefs(db: any, userId: number): any | null {
  return db.prepare("SELECT * FROM notification_sound_prefs WHERE scope = 'user' AND user_id = ?").get(userId) ?? null;
}

function effectiveSoundPrefs(db: any, userId: number | null): any {
  const laboratory = laboratorySoundPrefs(db);
  const own = userId ? userSoundPrefs(db, userId) : null;
  if (!own) return { ...laboratory, scope: 'laboratory' };
  const merged: any = { ...laboratory, ...own, scope: 'user' };
  // A user row stores every column, so "not chosen" is represented by NULL.
  for (const column of SOUND_COLUMNS) {
    if (own[column] === null || own[column] === undefined) merged[column] = laboratory[column];
  }
  return merged;
}

/** The sound key each event should play for this user, resolved once server-side. */
function soundMapFor(prefs: any): Array<{ event: string; soundKey: string }> {
  return SOUND_EVENTS.map(event => ({
    event,
    soundKey: prefs[`sound_${event}`] || DEFAULT_SOUND_FOR_EVENT[event],
  }));
}

export function dutyActivityRoutes() {
  const router = Router();
  router.use(requireAuth);

  /* ======================================================================
     A person's own day
     ==================================================================== */

  /**
   * Everything the signed-in person needs when they open the system in the
   * morning: whether they are on duty, in which unit, what is on their list,
   * what they are watching over, and which schedules they owe.
   *
   * Deliberately one call. The dashboard, the briefing and the mobile app all
   * ask the same question, and splitting it into five requests only invents
   * ways for them to disagree with each other.
   */
  router.get('/today', (req, res) => {
    const db = getDb();
    const date = isIsoDate(req.query.date) ? String(req.query.date) : todayIso();
    const staffId = getCurrentStaffId(req);
    const userId = req.user!.id;

    // Keep the pipeline warm on the first visit of the day rather than relying
    // on a scheduler tick having already fired — a laboratory that switched the
    // host on five minutes ago still gets a correct list.
    try {
      generateOccurrences(db, { from: date });
      refreshAssignments(db, { from: date });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[duty] generation on /today failed:', (err as Error).message);
    }

    const duty = staffId ? dutyContextFor(db, staffId, date) : {
      date, month: date.slice(0, 7), shiftCode: null, shiftLabel: null, onDuty: false,
      sectionId: null, sectionName: null, benchName: null, assignmentSource: null,
      rosterStatus: null, rosterCarriedForward: false, benchCarriedForward: false,
    };
    const { mine, watching } = staffId ? todosFor(db, staffId, date) : { mine: [], watching: [] };

    const obligations = currentObligations(db, date)
      .filter(o => o.status === 'due_soon' || o.status === 'overdue' || o.status === 'carried_forward')
      .map(o => ({ ...o, isMine: staffId !== null && o.ownerStaffId === staffId }));
    // Managers and unit heads see the schedules they owe; everyone else does not
    // need a monthly roster reminder cluttering their morning.
    const scheduleTasks = obligations.filter(o => o.isMine || obligationVisibleTo(db, userId));

    const prefs = effectiveSoundPrefs(db, userId);
    const briefingKey = `briefing.seen.${userId}`;
    const seen = db.prepare('SELECT value FROM settings WHERE key = ?').get(briefingKey) as any;

    res.json({
      date,
      greetingName: req.user!.username,
      duty,
      mine, watching, scheduleTasks,
      counts: {
        due: mine.filter(o => o.status === 'pending' || o.status === 'in_progress').length,
        done: mine.filter(o => o.status === 'done').length,
        overdue: mine.filter(o => (o.status === 'pending' || o.status === 'in_progress') && o.occurrence_date < date).length,
        missed: mine.filter(o => o.status === 'missed').length,
        watching: watching.length,
      },
      sounds: soundMapFor(prefs),
      soundPrefs: {
        enabled: prefs.enabled, volume: prefs.volume, repeatCount: prefs.repeat_count,
        desktopEnabled: prefs.desktop_enabled, mobileEnabled: prefs.mobile_enabled,
        quietHoursStart: prefs.quiet_hours_start, quietHoursEnd: prefs.quiet_hours_end,
        dailyBriefingEnabled: prefs.daily_briefing_enabled,
      },
      briefingSeen: seen?.value === date,
    });
  });

  /** Whether this user is one of the people schedules are expected from. */
  function obligationVisibleTo(db: any, userId: number): boolean {
    const row = db.prepare(`SELECT 1 FROM users u JOIN roles r ON r.id = u.role_id
       WHERE u.id = ? AND (LOWER(r.name) LIKE '%manager%' OR LOWER(r.name) LIKE '%head%' OR r.is_administrator = 1)`).get(userId);
    return Boolean(row);
  }

  /** Record that the person has seen today's briefing, so it opens once a day. */
  router.post('/briefing-seen', (req, res) => {
    const db = getDb();
    const date = isIsoDate(req.body?.date) ? String(req.body.date) : todayIso();
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP")
      .run(`briefing.seen.${req.user!.id}`, date);
    res.json({ ok: true, date });
  });

  router.get('/context', (req, res) => {
    const db = getDb();
    const date = isIsoDate(req.query.date) ? String(req.query.date) : todayIso();
    const staffId = parseIntNullable(req.query.staffId) ?? getCurrentStaffId(req);
    if (staffId === null) return res.status(400).json({ error: 'This account is not linked to a staff record, so no duty can be resolved for it.' });
    res.json(dutyContextFor(db, staffId, date));
  });

  /* ======================================================================
     Working an occurrence
     ==================================================================== */
  function assertAssigned(db: any, occurrenceId: number, staffId: number | null): { ok: boolean; occurrence?: any; error?: string } {
    const occurrence = db.prepare('SELECT * FROM activity_occurrences WHERE id = ?').get(occurrenceId);
    if (!occurrence) return { ok: false, error: 'Activity not found' };
    if (staffId === null) return { ok: false, error: 'This account is not linked to a staff record.' };
    const assigned = db.prepare('SELECT is_watcher FROM activity_assignees WHERE occurrence_id = ? AND staff_id = ?').get(occurrenceId, staffId) as any;
    // A watcher may not complete work they did not do, and somebody the roster
    // never placed here may not sign it off either. Both would put a name on a
    // record that is not true, which is the one thing a QMS cannot allow.
    if (!assigned) return { ok: false, error: 'This activity is not on your list. Only the staff the roster placed on it can complete it.' };
    if (assigned.is_watcher) return { ok: false, error: 'You are watching this activity as oversight; the staff on duty complete it.' };
    return { ok: true, occurrence };
  }

  router.post('/occurrences/:id/start', (req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const check = assertAssigned(db, id, getCurrentStaffId(req));
    if (!check.ok) return res.status(check.error === 'Activity not found' ? 404 : 403).json({ error: check.error });
    db.prepare("UPDATE activity_occurrences SET status = 'in_progress', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending'").run(id);
    audit(req, { action: 'edit', entity: 'activity_occurrences', entityId: id, newValue: { status: 'in_progress' } });
    res.json({ ok: true });
  });

  router.post('/occurrences/:id/complete', (req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const staffId = getCurrentStaffId(req);
    const check = assertAssigned(db, id, staffId);
    if (!check.ok) return res.status(check.error === 'Activity not found' ? 404 : 403).json({ error: check.error });

    const result = completeOccurrence(db, id, {
      staffId, userId: req.user!.id,
      note: req.body?.note ?? null,
      evidenceFileId: parseIntNullable(req.body?.evidenceFileId),
      linkedRecordType: req.body?.linkedRecordType ?? null,
      linkedRecordId: req.body?.linkedRecordId ?? null,
      easeRating: parseIntNullable(req.body?.easeRating),
      minutesTaken: parseIntNullable(req.body?.minutesTaken),
    });
    if (!result.ok) return res.status(404).json({ error: 'Activity not found' });
    audit(req, { action: 'complete', entity: 'activity_occurrences', entityId: id, newValue: { note: req.body?.note ?? null, easeRating: req.body?.easeRating ?? null } });
    res.json({ ok: true });
  });

  /**
   * "Not applicable today" — the instrument is out of service, the unit was
   * closed. Recorded with a reason, because an unexplained skip and a genuine
   * exemption look identical in a register and only one of them is acceptable.
   */
  router.post('/occurrences/:id/not-applicable', (req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const staffId = getCurrentStaffId(req);
    const check = assertAssigned(db, id, staffId);
    if (!check.ok) return res.status(check.error === 'Activity not found' ? 404 : 403).json({ error: check.error });
    const reason = String(req.body?.reason ?? '').trim();
    if (!reason) return res.status(400).json({ error: 'A reason is required before an activity can be recorded as not applicable.' });
    db.prepare("UPDATE activity_occurrences SET status = 'not_applicable', completed_at = CURRENT_TIMESTAMP, completed_by_staff_id = ?, completion_note = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(staffId, reason, id);
    db.prepare("UPDATE notifications SET status = 'resolved', resolved_at = CURRENT_TIMESTAMP WHERE record_type = 'activity_occurrences' AND record_id = ? AND status NOT IN ('resolved','dismissed')").run(String(id));
    audit(req, { action: 'edit', entity: 'activity_occurrences', entityId: id, newValue: { status: 'not_applicable', reason } });
    res.json({ ok: true });
  });

  /** How easy was it? The evidence the simplification programme runs on. */
  router.post('/occurrences/:id/feedback', (req, res) => {
    const db = getDb();
    const occurrence = db.prepare('SELECT activity_id FROM activity_occurrences WHERE id = ?').get(req.params.id) as any;
    if (!occurrence) return res.status(404).json({ error: 'Activity not found' });
    const rating = parseIntNullable(req.body?.easeRating);
    if (rating !== null && (rating < 1 || rating > 5)) return res.status(400).json({ error: 'Rate ease from 1 (very hard) to 5 (very easy).' });
    db.prepare(`INSERT INTO activity_feedback (activity_id, occurrence_id, staff_id, ease_rating, minutes_taken, comment, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(occurrence.activity_id, req.params.id, getCurrentStaffId(req), rating, parseIntNullable(req.body?.minutesTaken), req.body?.comment ?? null, req.user!.id);
    res.status(201).json({ ok: true });
  });

  /** The unit-wide register of occurrences — who did what, and what was not done. */
  router.get('/occurrences', requirePermission('personnel.activities', 'view'), (req, res) => {
    const db = getDb();
    const date = isIsoDate(req.query.date) ? String(req.query.date) : todayIso();
    res.json(occurrencesOn(db, date, {
      sectionId: parseIntNullable(req.query.sectionId),
      status: req.query.status ? String(req.query.status) : null,
    }));
  });

  /* ======================================================================
     The activity catalogue
     ==================================================================== */
  router.get('/activities', requirePermission('personnel.activities', 'view'), (req, res) => {
    const db = getDb();
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (req.query.sectionId) { clauses.push('a.section_id = ?'); params.push(req.query.sectionId); }
    if (req.query.category) { clauses.push('a.category = ?'); params.push(req.query.category); }
    if (req.query.redesign) { clauses.push('a.redesign_status = ?'); params.push(req.query.redesign); }
    if (req.query.active !== 'all') clauses.push('a.is_active = 1');
    res.json(db.prepare(`SELECT a.*, s.name AS section_name, b.name AS bench_name, e.name AS equipment_name,
         st.full_name AS responsible_name,
         (SELECT AVG(ease_rating) FROM activity_feedback f WHERE f.activity_id = a.id AND f.ease_rating IS NOT NULL) AS avg_ease,
         (SELECT COUNT(*) FROM activity_occurrences o WHERE o.activity_id = a.id AND o.status = 'missed') AS missed_count,
         (SELECT COUNT(*) FROM activity_occurrences o WHERE o.activity_id = a.id AND o.status = 'done') AS done_count
       FROM unit_activities a
       LEFT JOIN sections s ON s.id = a.section_id
       LEFT JOIN section_benches b ON b.id = a.bench_id
       LEFT JOIN equipment_items e ON e.id = a.equipment_id
       LEFT JOIN staff st ON st.id = a.responsible_staff_id
       ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
       ORDER BY s.name, a.name`).all(...params));
  });

  function activityBody(req: any, existing: any = {}) {
    const b = req.body ?? {};
    const pick = <T>(value: T | undefined, fallback: T) => (value === undefined ? fallback : value);
    return {
      name: String(pick(b.name, existing.name) ?? '').trim(),
      description: pick(b.description, existing.description) ?? null,
      instructions: pick(b.instructions, existing.instructions) ?? null,
      category: String(pick(b.category, existing.category) ?? 'other'),
      departmentId: b.departmentId !== undefined ? parseIntNullable(b.departmentId) : (existing.department_id ?? null),
      sectionId: b.sectionId !== undefined ? parseIntNullable(b.sectionId) : (existing.section_id ?? null),
      benchId: b.benchId !== undefined ? parseIntNullable(b.benchId) : (existing.bench_id ?? null),
      equipmentId: b.equipmentId !== undefined ? parseIntNullable(b.equipmentId) : (existing.equipment_id ?? null),
      environmentalAssetId: b.environmentalAssetId !== undefined ? parseIntNullable(b.environmentalAssetId) : (existing.environmental_asset_id ?? null),
      monitoringItemId: b.monitoringItemId !== undefined ? parseIntNullable(b.monitoringItemId) : (existing.monitoring_item_id ?? null),
      targetModuleKey: pick(b.targetModuleKey, existing.target_module_key) ?? null,
      targetRoute: pick(b.targetRoute, existing.target_route) ?? null,
      frequency: String(pick(b.frequency, existing.frequency) ?? 'daily'),
      intervalDays: b.intervalDays !== undefined ? parseIntNullable(b.intervalDays) : (existing.interval_days ?? null),
      weekdays: b.weekdays !== undefined ? jsonOrNull(b.weekdays) : (existing.weekdays ?? null),
      dayOfMonth: b.dayOfMonth !== undefined ? parseIntNullable(b.dayOfMonth) : (existing.day_of_month ?? null),
      months: b.months !== undefined ? jsonOrNull(b.months) : (existing.months ?? null),
      shiftCodes: b.shiftCodes !== undefined ? jsonOrNull(b.shiftCodes) : (existing.shift_codes ?? null),
      dueTime: pick(b.dueTime, existing.due_time) ?? null,
      graceMinutes: b.graceMinutes !== undefined ? (parseIntNullable(b.graceMinutes) ?? 0) : (existing.grace_minutes ?? 0),
      assignMode: String(pick(b.assignMode, existing.assign_mode) ?? 'on_duty'),
      responsibleStaffId: b.responsibleStaffId !== undefined ? parseIntNullable(b.responsibleStaffId) : (existing.responsible_staff_id ?? null),
      priority: String(pick(b.priority, existing.priority) ?? 'normal'),
      evidenceRequired: b.evidenceRequired !== undefined ? (b.evidenceRequired ? 1 : 0) : (existing.evidence_required ?? 0),
      notifyLeadership: b.notifyLeadership !== undefined ? (b.notifyLeadership ? 1 : 0) : (existing.notify_leadership ?? 1),
      soundKey: pick(b.soundKey, existing.sound_key) ?? null,
      estimatedMinutes: b.estimatedMinutes !== undefined ? parseIntNullable(b.estimatedMinutes) : (existing.estimated_minutes ?? null),
      isActive: b.isActive !== undefined ? (b.isActive ? 1 : 0) : (existing.is_active ?? 1),
    };
  }

  function validateActivity(v: ReturnType<typeof activityBody>): string | null {
    if (!v.name) return 'A name is required.';
    if (!ACTIVITY_FREQUENCIES.includes(v.frequency as any)) return `Frequency must be one of: ${ACTIVITY_FREQUENCIES.join(', ')}.`;
    if (!ACTIVITY_CATEGORIES.includes(v.category as any)) return `Category must be one of: ${ACTIVITY_CATEGORIES.join(', ')}.`;
    if (!ASSIGN_MODES.includes(v.assignMode as any)) return `Assignment must be one of: ${ASSIGN_MODES.join(', ')}.`;
    if (v.frequency === 'custom_days' && !v.intervalDays) return 'An interval in days is required for a custom frequency.';
    if (v.assignMode === 'named_staff' && !v.responsibleStaffId) return 'Name the member of staff responsible.';
    if (v.assignMode !== 'named_staff' && !v.sectionId) return 'A unit is required so the duty roster can resolve who does the work.';
    if (v.assignMode === 'bench' && !v.benchId) return 'Choose the bench this activity belongs to.';
    return null;
  }

  router.post('/activities', requirePermission('personnel.activities', 'create'), (req, res) => {
    const db = getDb();
    const v = activityBody(req);
    const error = validateActivity(v);
    if (error) return res.status(400).json({ error });

    const code = String(req.body?.activityCode ?? '').trim() || `ACT-${Date.now().toString(36).toUpperCase()}`;
    if (db.prepare('SELECT id FROM unit_activities WHERE activity_code = ?').get(code)) {
      return res.status(409).json({ error: `An activity with the code "${code}" already exists.` });
    }
    const result = db.prepare(`INSERT INTO unit_activities
       (activity_code, name, description, instructions, category, department_id, section_id, bench_id, equipment_id,
        environmental_asset_id, monitoring_item_id, target_module_key, target_route, frequency, interval_days,
        weekdays, day_of_month, months, shift_codes, due_time, grace_minutes, assign_mode, responsible_staff_id,
        priority, evidence_required, notify_leadership, sound_key, estimated_minutes, is_active, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(code, v.name, v.description, v.instructions, v.category, v.departmentId, v.sectionId, v.benchId, v.equipmentId,
        v.environmentalAssetId, v.monitoringItemId, v.targetModuleKey, v.targetRoute, v.frequency, v.intervalDays,
        v.weekdays, v.dayOfMonth, v.months, v.shiftCodes, v.dueTime, v.graceMinutes, v.assignMode, v.responsibleStaffId,
        v.priority, v.evidenceRequired, v.notifyLeadership, v.soundKey, v.estimatedMinutes, v.isActive, req.user!.id);

    const id = Number(result.lastInsertRowid);
    audit(req, { action: 'create', entity: 'unit_activities', entityId: id, newValue: { code, ...v } });
    // Raise its first occurrences straight away, so a manager who has just
    // added the morning fridge check sees it on the bench's list today rather
    // than tomorrow.
    try { generateOccurrences(db, {}); } catch { /* the scheduler will catch up */ }
    res.status(201).json({ id, activityCode: code });
  });

  router.put('/activities/:id', requirePermission('personnel.activities', 'edit'), (req, res) => {
    const db = getDb();
    const existing = db.prepare('SELECT * FROM unit_activities WHERE id = ?').get(req.params.id) as any;
    if (!existing) return res.status(404).json({ error: 'Activity not found' });
    const v = activityBody(req, existing);
    const error = validateActivity(v);
    if (error) return res.status(400).json({ error });

    db.prepare(`UPDATE unit_activities SET name = ?, description = ?, instructions = ?, category = ?, department_id = ?,
         section_id = ?, bench_id = ?, equipment_id = ?, environmental_asset_id = ?, monitoring_item_id = ?,
         target_module_key = ?, target_route = ?, frequency = ?, interval_days = ?, weekdays = ?, day_of_month = ?,
         months = ?, shift_codes = ?, due_time = ?, grace_minutes = ?, assign_mode = ?, responsible_staff_id = ?,
         priority = ?, evidence_required = ?, notify_leadership = ?, sound_key = ?, estimated_minutes = ?,
         is_active = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`)
      .run(v.name, v.description, v.instructions, v.category, v.departmentId, v.sectionId, v.benchId, v.equipmentId,
        v.environmentalAssetId, v.monitoringItemId, v.targetModuleKey, v.targetRoute, v.frequency, v.intervalDays,
        v.weekdays, v.dayOfMonth, v.months, v.shiftCodes, v.dueTime, v.graceMinutes, v.assignMode, v.responsibleStaffId,
        v.priority, v.evidenceRequired, v.notifyLeadership, v.soundKey, v.estimatedMinutes, v.isActive, req.params.id);

    audit(req, { action: 'edit', entity: 'unit_activities', entityId: req.params.id, oldValue: existing, newValue: v });
    try { refreshAssignments(db, {}); } catch { /* the scheduler will catch up */ }
    res.json({ ok: true });
  });

  router.delete('/activities/:id', requirePermission('personnel.activities', 'void_archive'), (req, res) => {
    const db = getDb();
    const existing = db.prepare('SELECT * FROM unit_activities WHERE id = ?').get(req.params.id) as any;
    if (!existing) return res.status(404).json({ error: 'Activity not found' });
    // Deactivate rather than delete: the completed occurrences behind it are
    // the laboratory's evidence that the work was done, and deleting the
    // definition would orphan them.
    db.prepare('UPDATE unit_activities SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id);
    db.prepare("DELETE FROM activity_occurrences WHERE activity_id = ? AND status = 'pending'").run(req.params.id);
    audit(req, { action: 'void_archive', entity: 'unit_activities', entityId: req.params.id, oldValue: existing });
    res.json({ ok: true, deactivated: true });
  });

  /**
   * Flag an activity for redesign.
   *
   * The laboratory's own principle: staff comply with what is easy, so an
   * activity that is hard to execute is a design defect. Flagging it puts it on
   * a list to be simplified instead of leaving it as a recurring failure.
   */
  router.post('/activities/:id/redesign', requirePermission('personnel.activities', 'edit'), (req, res) => {
    const db = getDb();
    const existing = db.prepare('SELECT * FROM unit_activities WHERE id = ?').get(req.params.id) as any;
    if (!existing) return res.status(404).json({ error: 'Activity not found' });
    const status = String(req.body?.status ?? 'flagged');
    if (!REDESIGN_STATUSES.includes(status as any)) return res.status(400).json({ error: `Status must be one of: ${REDESIGN_STATUSES.join(', ')}.` });
    const rating = parseIntNullable(req.body?.simplicityRating);
    if (rating !== null && (rating < 1 || rating > 5)) return res.status(400).json({ error: 'Rate simplicity from 1 (very hard) to 5 (very easy).' });

    db.prepare(`UPDATE unit_activities SET redesign_status = ?, redesign_note = ?, simplicity_rating = ?,
         redesign_flagged_by = ?, redesign_flagged_at = CASE WHEN ? = 'none' THEN NULL ELSE CURRENT_TIMESTAMP END,
         updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(status, req.body?.note ?? existing.redesign_note, rating ?? existing.simplicity_rating,
        status === 'none' ? null : req.user!.id, status, req.params.id);
    audit(req, { action: 'edit', entity: 'unit_activities', entityId: req.params.id, oldValue: { redesign_status: existing.redesign_status }, newValue: { redesign_status: status, note: req.body?.note ?? null } });
    res.json({ ok: true });
  });

  /** Feedback across an activity, for the people deciding what to simplify. */
  router.get('/activities/:id/feedback', requirePermission('personnel.activities', 'view'), (req, res) => {
    res.json(getDb().prepare(`SELECT f.*, s.full_name AS staff_name FROM activity_feedback f
       LEFT JOIN staff s ON s.id = f.staff_id WHERE f.activity_id = ? ORDER BY f.created_at DESC`).all(req.params.id));
  });

  /* ======================================================================
     Building the catalogue from what is already configured
     ==================================================================== */
  router.get('/activities-proposals', requirePermission('personnel.activities', 'create'), (_req, res) => {
    res.json(proposeActivities(getDb()));
  });

  router.post('/activities-proposals/adopt', requirePermission('personnel.activities', 'create'), (req, res) => {
    const db = getDb();
    const wanted: string[] | null = Array.isArray(req.body?.sourceKeys) ? req.body.sourceKeys.map(String) : null;
    const all = proposeActivities(db);
    const chosen = wanted ? all.filter(p => wanted.includes(p.sourceKey)) : all;
    if (!chosen.length) return res.status(400).json({ error: 'No proposals matched.' });
    const result = adoptProposals(db, chosen, req.user!.id);
    audit(req, { action: 'create', entity: 'unit_activities', newValue: { adopted: result.created, from: 'proposals' } });
    try { generateOccurrences(db, {}); } catch { /* the scheduler will catch up */ }
    res.status(201).json(result);
  });

  /* ======================================================================
     Scheduling policy and carry-forward
     ==================================================================== */
  router.get('/policy', (_req, res) => {
    res.json(schedulingPolicy(getDb()));
  });

  router.put('/policy', requirePermission('settings', 'edit'), (req, res) => {
    const db = getDb();
    const existing = schedulingPolicy(db);
    const b = req.body ?? {};
    const num = (key: string, fallback: number, min = 0, max = 365) => {
      const value = parseIntNullable(b[key]);
      if (value === null) return fallback;
      return Math.min(max, Math.max(min, value));
    };
    const flag = (key: string, fallback: number) => (b[key] === undefined ? fallback : (b[key] ? 1 : 0));
    const ROTATION_FREQUENCIES = ['none', 'monthly', 'quarterly', 'biannual', 'annual'];
    const freq = (key: string, fallback: string) => (typeof b[key] === 'string' && ROTATION_FREQUENCIES.includes(b[key]) ? b[key] : fallback);
    const notes = b.rotationNotes === undefined ? existing.rotation_notes : (String(b.rotationNotes).trim() || null);

    db.prepare(`UPDATE scheduling_policy SET roster_due_days_before = ?, reassignment_due_days_before = ?,
         bench_due_days_before = ?, reminder_lead_days = ?, auto_carry_forward = ?, bench_inherit_gaps = ?,
         activity_generation_days = ?, missed_grace_hours = ?, notify_leadership_daily = ?, briefing_hour = ?,
         rotation_enabled = ?, rotation_staff_frequency = ?, rotation_rotate_unit_heads = ?, rotation_head_frequency = ?, rotation_notes = ?,
         updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1`)
      .run(num('rosterDueDaysBefore', existing.roster_due_days_before, 0, 60),
        num('reassignmentDueDaysBefore', existing.reassignment_due_days_before, 0, 60),
        num('benchDueDaysBefore', existing.bench_due_days_before, 0, 60),
        num('reminderLeadDays', existing.reminder_lead_days, 1, 60),
        flag('autoCarryForward', existing.auto_carry_forward),
        flag('benchInheritGaps', existing.bench_inherit_gaps),
        num('activityGenerationDays', existing.activity_generation_days, 1, 90),
        num('missedGraceHours', existing.missed_grace_hours, 0, 48),
        flag('notifyLeadershipDaily', existing.notify_leadership_daily),
        num('briefingHour', existing.briefing_hour, 0, 23),
        flag('rotationEnabled', existing.rotation_enabled),
        freq('rotationStaffFrequency', existing.rotation_staff_frequency),
        flag('rotationRotateUnitHeads', existing.rotation_rotate_unit_heads),
        freq('rotationHeadFrequency', existing.rotation_head_frequency),
        notes,
        req.user!.id);

    audit(req, { action: 'edit', entity: 'scheduling_policy', entityId: 1, oldValue: existing, newValue: req.body });
    res.json(schedulingPolicy(db));
  });

  router.get('/schedule-obligations', (req, res) => {
    const db = getDb();
    const date = isIsoDate(req.query.date) ? String(req.query.date) : todayIso();
    res.json(currentObligations(db, date));
  });

  router.get('/carry-forwards', requirePermission('personnel.rosters', 'view'), (req, res) => {
    const db = getDb();
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (req.query.month) { clauses.push('cf.month = ?'); params.push(req.query.month); }
    res.json(db.prepare(`SELECT cf.*, s.name AS section_name FROM schedule_carry_forwards cf
       LEFT JOIN sections s ON s.id = cf.section_id
       ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
       ORDER BY cf.month DESC, cf.id DESC`).all(...params));
  });

  /** Roll the previous month's schedules forward now, rather than waiting. */
  router.post('/carry-forward', requirePermission('personnel.rosters', 'create'), (req, res) => {
    const db = getDb();
    const month = String(req.body?.month ?? '').trim();
    if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'A month (YYYY-MM) is required.' });
    const result = ensureMonthSchedules(db, month, { force: true });
    audit(req, { action: 'carry_forward', entity: 'duty_rosters', entityId: month, newValue: result });
    res.json(result);
  });

  /* ======================================================================
     Sounds
     ==================================================================== */
  router.get('/sounds', (_req, res) => {
    res.json(getDb().prepare('SELECT * FROM notification_sounds WHERE is_active = 1 ORDER BY display_order, id').all());
  });

  router.post('/sounds', requirePermission('settings', 'create'), (req, res) => {
    const db = getDb();
    const key = String(req.body?.soundKey ?? '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
    if (!key) return res.status(400).json({ error: 'A key is required.' });
    if (!req.body?.label) return res.status(400).json({ error: 'A label is required.' });
    if (db.prepare('SELECT id FROM notification_sounds WHERE sound_key = ?').get(key)) return res.status(409).json({ error: `A sound with the key "${key}" already exists.` });
    if (!req.body?.toneSpec && !req.body?.fileId) return res.status(400).json({ error: 'Provide either a tone specification or an uploaded sound file.' });

    const order = (db.prepare('SELECT COALESCE(MAX(display_order),0)+1 n FROM notification_sounds').get() as any).n;
    const result = db.prepare(`INSERT INTO notification_sounds (sound_key, label, description, tone_spec, file_id, is_system, is_active, display_order, created_by)
       VALUES (?, ?, ?, ?, ?, 0, 1, ?, ?)`)
      .run(key, String(req.body.label), req.body.description ?? null,
        req.body.toneSpec ? JSON.stringify(req.body.toneSpec) : null, parseIntNullable(req.body.fileId), order, req.user!.id);
    audit(req, { action: 'create', entity: 'notification_sounds', entityId: Number(result.lastInsertRowid), newValue: { key } });
    res.status(201).json({ id: Number(result.lastInsertRowid), soundKey: key });
  });

  router.delete('/sounds/:id', requirePermission('settings', 'void_archive'), (req, res) => {
    const db = getDb();
    const existing = db.prepare('SELECT * FROM notification_sounds WHERE id = ?').get(req.params.id) as any;
    if (!existing) return res.status(404).json({ error: 'Sound not found' });
    if (existing.is_system) {
      db.prepare('UPDATE notification_sounds SET is_active = 0 WHERE id = ?').run(req.params.id);
      return res.json({ ok: true, deactivated: true });
    }
    db.prepare('DELETE FROM notification_sounds WHERE id = ?').run(req.params.id);
    audit(req, { action: 'delete', entity: 'notification_sounds', entityId: req.params.id, oldValue: existing });
    res.json({ ok: true });
  });

  router.get('/sound-settings', (req, res) => {
    const db = getDb();
    res.json({
      effective: effectiveSoundPrefs(db, req.user!.id),
      laboratory: laboratorySoundPrefs(db),
      user: userSoundPrefs(db, req.user!.id),
      sounds: db.prepare('SELECT * FROM notification_sounds WHERE is_active = 1 ORDER BY display_order, id').all(),
      builtins: BUILTIN_SOUNDS,
      events: SOUND_EVENTS,
    });
  });

  function writeSoundPrefs(db: any, scope: 'laboratory' | 'user', userId: number | null, body: any) {
    const known = new Set((db.prepare('SELECT sound_key FROM notification_sounds WHERE is_active = 1').all() as any[]).map(r => String(r.sound_key)));
    const sound = (key: string, fallback: string) => {
      const value = body[key];
      if (value === undefined || value === null || value === '') return fallback;
      // Silently accepting an unknown key would leave a preference that plays
      // nothing and looks like a broken speaker.
      return known.has(String(value)) ? String(value) : fallback;
    };
    const current = scope === 'laboratory' ? laboratorySoundPrefs(db) : (userSoundPrefs(db, userId!) ?? laboratorySoundPrefs(db));
    const volume = body.volume === undefined ? current.volume : Math.min(1, Math.max(0, Number(body.volume) || 0));
    const flag = (key: string, fallback: number) => (body[key] === undefined ? fallback : (body[key] ? 1 : 0));
    const time = (key: string, fallback: string | null) => {
      if (body[key] === undefined) return fallback;
      const value = String(body[key] ?? '').trim();
      return /^\d{2}:\d{2}$/.test(value) ? value : null;
    };

    const values = [
      flag('enabled', current.enabled), volume, flag('desktopEnabled', current.desktop_enabled),
      flag('mobileEnabled', current.mobile_enabled),
      body.repeatCount === undefined ? current.repeat_count : Math.min(5, Math.max(1, Number(body.repeatCount) || 1)),
      time('quietHoursStart', current.quiet_hours_start), time('quietHoursEnd', current.quiet_hours_end),
      flag('dailyBriefingEnabled', current.daily_briefing_enabled),
      sound('soundTodo', current.sound_todo), sound('soundReminder', current.sound_reminder),
      sound('soundOverdue', current.sound_overdue), sound('soundCritical', current.sound_critical),
      sound('soundSchedule', current.sound_schedule), sound('soundBriefing', current.sound_briefing),
    ];

    const exists = scope === 'laboratory'
      ? db.prepare("SELECT id FROM notification_sound_prefs WHERE scope = 'laboratory'").get()
      : db.prepare("SELECT id FROM notification_sound_prefs WHERE scope = 'user' AND user_id = ?").get(userId);

    if (exists) {
      db.prepare(`UPDATE notification_sound_prefs SET enabled = ?, volume = ?, desktop_enabled = ?, mobile_enabled = ?,
           repeat_count = ?, quiet_hours_start = ?, quiet_hours_end = ?, daily_briefing_enabled = ?,
           sound_todo = ?, sound_reminder = ?, sound_overdue = ?, sound_critical = ?, sound_schedule = ?, sound_briefing = ?,
           updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...values, exists.id);
    } else {
      db.prepare(`INSERT INTO notification_sound_prefs (scope, user_id, enabled, volume, desktop_enabled, mobile_enabled,
           repeat_count, quiet_hours_start, quiet_hours_end, daily_briefing_enabled,
           sound_todo, sound_reminder, sound_overdue, sound_critical, sound_schedule, sound_briefing)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(scope, userId, ...values);
    }
  }

  /** A person's own chimes. Nobody needs permission to silence their own device. */
  router.put('/sound-settings', (req, res) => {
    const db = getDb();
    writeSoundPrefs(db, 'user', req.user!.id, req.body ?? {});
    res.json({ effective: effectiveSoundPrefs(db, req.user!.id), user: userSoundPrefs(db, req.user!.id) });
  });

  /** Clear a personal override and follow the laboratory again. */
  router.delete('/sound-settings', (req, res) => {
    const db = getDb();
    db.prepare("DELETE FROM notification_sound_prefs WHERE scope = 'user' AND user_id = ?").run(req.user!.id);
    res.json({ effective: effectiveSoundPrefs(db, req.user!.id), user: null });
  });

  router.put('/sound-settings/laboratory', requirePermission('settings', 'edit'), (req, res) => {
    const db = getDb();
    const before = laboratorySoundPrefs(db);
    writeSoundPrefs(db, 'laboratory', null, req.body ?? {});
    audit(req, { action: 'edit', entity: 'notification_sound_prefs', entityId: 'laboratory', oldValue: before, newValue: req.body });
    res.json({ laboratory: laboratorySoundPrefs(db), effective: effectiveSoundPrefs(db, req.user!.id) });
  });

  /* ======================================================================
     Manual ticks — useful for a manager who has just changed a roster and
     wants the lists to catch up without waiting for the scheduler.
     ==================================================================== */
  router.post('/run-tick', requirePermission('personnel.activities', 'edit'), (req, res) => {
    const db = getDb();
    const today = isIsoDate(req.body?.date) ? String(req.body.date) : todayIso();
    const schedules = runScheduleTick(db, today);
    const activities = runActivityTick(db, today);
    audit(req, { action: 'edit', entity: 'activity_occurrences', newValue: { manualTick: true, activities: activities.generated.created } });
    res.json({ schedules, activities });
  });

  return router;
}
