/**
 * The system's audit of itself.
 *
 * The audit trail already records what people did. This service answers the
 * harder question an assessor actually asks: what was supposed to happen and
 * did not, and where does the system disagree with itself?
 *
 * Every check returns findings in one shape, and every finding carries the URL
 * that opens the record it is about — a flag you cannot click through to is a
 * complaint, not a finding. Findings are keyed so a re-scan updates a flag
 * rather than duplicating it, which is what gives each one a true first-seen
 * date and lets "open for eleven days" mean something.
 *
 * Checks are deliberately defensive: a laboratory may have any subset of the
 * modules configured, so a check whose table is absent returns nothing instead
 * of taking the scan down.
 */
import {
  AUDIT_FLAG_CATEGORY_LABELS, type AuditFlagCategory, type AuditSeverity,
} from '../../shared/constants/activities.js';
import { addDays, monthLabel, monthOf, nextMonth, todayIso } from './dutyService.js';
import { currentObligations } from './scheduleRollover.js';

type Db = any;

export type AuditFinding = {
  /** Stable across scans: same problem, same key. */
  flagKey: string;
  checkKey: string;
  category: AuditFlagCategory;
  severity: AuditSeverity;
  moduleKey?: string | null;
  title: string;
  detail?: string | null;
  recordType?: string | null;
  recordId?: string | null;
  sectionId?: number | null;
  responsibleStaffId?: number | null;
  dueDate?: string | null;
  /** Clicking the flag must land on the problem. */
  actionUrl: string;
};

export type AuditCheck = {
  key: string;
  label: string;
  category: AuditFlagCategory;
  description: string;
  severity: AuditSeverity;
  moduleKey?: string;
  run: (db: Db, today: string) => AuditFinding[];
};

function tableExists(db: Db, table: string): boolean {
  try {
    return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(table));
  } catch { return false; }
}

function columnExists(db: Db, table: string, column: string): boolean {
  if (!tableExists(db, table)) return false;
  try {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(c => c.name === column);
  } catch { return false; }
}

/** Run a check body, swallowing a failure into "no findings" plus a log line. */
function safely(key: string, fn: () => AuditFinding[]): AuditFinding[] {
  try { return fn(); } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[system-audit] check ${key} failed:`, (err as Error).message);
    return [];
  }
}

/* ============================================================================
   The checks
   ========================================================================= */
export const AUDIT_CHECKS: AuditCheck[] = [
  /* ── Unit activities: the work that was supposed to be done ────────────── */
  {
    key: 'activity_missed',
    label: 'Unit activity not done',
    category: 'activity',
    severity: 'high',
    moduleKey: 'personnel',
    description: 'A scheduled unit activity — charting, an equipment check, a control — whose window closed with no record that it was done.',
    run: (db, today) => safely('activity_missed', () => {
      if (!tableExists(db, 'activity_occurrences')) return [];
      // A fortnight of individual misses is the actionable window: each one is
      // a distinct gap somebody can still explain or make good. Older and more
      // chronic patterns are the `activity_hard_to_do` check's job, and the
      // Not Done register holds the complete history either way.
      const since = addDays(today, -14);
      const rows = db.prepare(`SELECT o.id, o.occurrence_date, o.section_id, a.name, a.category, a.priority, s.name AS section_name,
           (SELECT GROUP_CONCAT(st.full_name, ', ') FROM activity_assignees ag JOIN staff st ON st.id = ag.staff_id
             WHERE ag.occurrence_id = o.id AND ag.is_watcher = 0) AS who
         FROM activity_occurrences o JOIN unit_activities a ON a.id = o.activity_id
         LEFT JOIN sections s ON s.id = o.section_id
         WHERE o.status = 'missed' AND o.occurrence_date >= ?`).all(since) as any[];
      return rows.map(row => ({
        flagKey: `activity_missed:${row.id}`,
        checkKey: 'activity_missed',
        category: 'activity' as AuditFlagCategory,
        severity: (row.priority === 'critical' ? 'critical' : 'high') as AuditSeverity,
        moduleKey: 'personnel',
        title: `Not done: ${row.name}`,
        detail: `Due ${row.occurrence_date}${row.section_name ? ` in ${row.section_name}` : ''}. ${row.who ? `On duty: ${row.who}.` : 'Nobody was assigned.'}`,
        recordType: 'activity_occurrences', recordId: String(row.id),
        sectionId: row.section_id ?? null, dueDate: row.occurrence_date,
        actionUrl: `/system-audit?tab=Not%20Done&focus=activity_occurrences:${row.id}`,
      }));
    }),
  },
  {
    key: 'activity_unassigned',
    label: 'Activity with nobody on it',
    category: 'activity',
    severity: 'high',
    moduleKey: 'personnel',
    description: 'An activity due now that the rosters could not place on anybody — usually a unit with no roster entry or no members.',
    run: (db, today) => safely('activity_unassigned', () => {
      if (!tableExists(db, 'activity_occurrences')) return [];
      // One flag per ACTIVITY, not per occurrence. A daily activity in a unit
      // with no roster generates an unassigned occurrence for every day in the
      // generation window; raising one flag each would bury the real findings
      // under a fortnight of identical rows. The horizon is short for the same
      // reason: an occurrence three days out has nobody on it because the
      // roster has not been painted that far yet, which is not a finding.
      const horizon = addDays(today, 2);
      const rows = db.prepare(`SELECT a.id AS activity_id, a.name, a.section_id, s.name AS section_name,
           COUNT(*) AS n, MIN(o.occurrence_date) AS earliest
         FROM activity_occurrences o JOIN unit_activities a ON a.id = o.activity_id
         LEFT JOIN sections s ON s.id = a.section_id
         WHERE o.status = 'pending' AND o.window_start <= ? AND o.window_end >= ?
           AND NOT EXISTS (SELECT 1 FROM activity_assignees ag WHERE ag.occurrence_id = o.id AND ag.is_watcher = 0)
         GROUP BY a.id`).all(horizon, today) as any[];
      return rows.map(row => ({
        flagKey: `activity_unassigned:${row.activity_id}`,
        checkKey: 'activity_unassigned',
        category: 'activity' as AuditFlagCategory,
        severity: 'high' as AuditSeverity,
        moduleKey: 'personnel',
        title: `Nobody assigned: ${row.name}`,
        detail: `${row.n === 1 ? 'An occurrence is' : `${row.n} occurrences are`} due from ${row.earliest}${row.section_name ? ` in ${row.section_name}` : ''}, but the duty roster, unit reassignment and bench schedule between them name nobody to do the work.`,
        recordType: 'unit_activities', recordId: String(row.activity_id),
        sectionId: row.section_id ?? null, dueDate: row.earliest,
        actionUrl: `/personnel?tab=Duty%20Roster`,
      }));
    }),
  },
  {
    key: 'activity_no_unit',
    label: 'Activity not tied to a unit',
    category: 'inconsistency',
    severity: 'medium',
    moduleKey: 'personnel',
    description: 'An active activity with no unit, so there is no duty roster to route it by.',
    run: db => safely('activity_no_unit', () => {
      if (!tableExists(db, 'unit_activities')) return [];
      const rows = db.prepare("SELECT id, activity_code, name FROM unit_activities WHERE is_active = 1 AND (section_id IS NULL OR section_id = 0) AND assign_mode NOT IN ('named_staff')").all() as any[];
      return rows.map(row => ({
        flagKey: `activity_no_unit:${row.id}`,
        checkKey: 'activity_no_unit',
        category: 'inconsistency' as AuditFlagCategory,
        severity: 'medium' as AuditSeverity,
        moduleKey: 'personnel',
        title: `No unit set: ${row.name}`,
        detail: 'The activity is assigned by duty, but names no unit, so nobody can be resolved for it. Set the unit or name a responsible member of staff.',
        recordType: 'unit_activities', recordId: String(row.id),
        actionUrl: `/settings/activities?focus=unit_activities:${row.id}`,
      }));
    }),
  },
  {
    key: 'activity_hard_to_do',
    label: 'Activity staff find hard',
    category: 'activity',
    severity: 'medium',
    moduleKey: 'personnel',
    description: 'An activity staff have rated hard to execute, or that is missed far more often than it is done. These are design problems, and are flagged for redesign rather than chased as discipline.',
    run: db => safely('activity_hard_to_do', () => {
      if (!tableExists(db, 'activity_occurrences')) return [];
      const rows = db.prepare(`SELECT a.id, a.name, a.redesign_status,
           (SELECT AVG(ease_rating) FROM activity_feedback f WHERE f.activity_id = a.id AND f.ease_rating IS NOT NULL) AS avg_ease,
           (SELECT COUNT(*) FROM activity_occurrences o WHERE o.activity_id = a.id AND o.status = 'missed') AS missed,
           (SELECT COUNT(*) FROM activity_occurrences o WHERE o.activity_id = a.id AND o.status = 'done') AS done
         FROM unit_activities a WHERE a.is_active = 1`).all() as any[];
      return rows
        .filter(row => {
          const total = Number(row.missed) + Number(row.done);
          const chronic = total >= 5 && Number(row.missed) / total >= 0.4;
          const rated = row.avg_ease !== null && Number(row.avg_ease) <= 2.5;
          return chronic || rated;
        })
        .map(row => {
          const total = Number(row.missed) + Number(row.done);
          const rate = total ? Math.round((Number(row.missed) / total) * 100) : 0;
          return {
            flagKey: `activity_hard_to_do:${row.id}`,
            checkKey: 'activity_hard_to_do',
            category: 'activity' as AuditFlagCategory,
            severity: 'medium' as AuditSeverity,
            moduleKey: 'personnel',
            title: `Hard to comply with: ${row.name}`,
            detail: `${rate}% of occurrences were missed${row.avg_ease !== null ? `, and staff rate it ${Number(row.avg_ease).toFixed(1)} out of 5 for ease` : ''}. Simplify how it is done — compliance follows ease.${row.redesign_status === 'none' ? ' Not yet flagged for redesign.' : ''}`,
            recordType: 'unit_activities', recordId: String(row.id),
            actionUrl: `/settings/activities?focus=unit_activities:${row.id}`,
          };
        });
    }),
  },

  /* ── Rosters and schedules ─────────────────────────────────────────────── */
  {
    key: 'schedule_not_prepared',
    label: 'Roster or schedule not prepared',
    category: 'schedule',
    severity: 'high',
    moduleKey: 'personnel',
    description: 'A duty roster, unit reassignment or bench schedule that has passed its preparation deadline without being prepared.',
    run: (db, today) => safely('schedule_not_prepared', () => {
      if (!tableExists(db, 'duty_rosters')) return [];
      return currentObligations(db, today)
        .filter(o => o.status === 'overdue')
        .map(o => ({
          flagKey: `schedule_not_prepared:${o.kind}:${o.month}:${o.sectionId ?? 0}`,
          checkKey: 'schedule_not_prepared',
          category: 'schedule' as AuditFlagCategory,
          severity: 'high' as AuditSeverity,
          moduleKey: 'personnel',
          title: `${o.kindLabel} not prepared — ${o.monthLabel}${o.sectionName ? ` (${o.sectionName})` : ''}`,
          detail: o.message,
          recordType: o.kind === 'duty_roster' ? 'duty_rosters' : o.kind === 'reassignment' ? 'reassignment_schedules' : 'bench_schedules',
          recordId: String(o.scheduleId ?? `${o.month}`),
          sectionId: o.sectionId, responsibleStaffId: o.ownerStaffId, dueDate: o.dueDate,
          actionUrl: o.actionUrl,
        }));
    }),
  },
  {
    key: 'schedule_carried_forward',
    label: 'Month running on a carried-forward schedule',
    category: 'schedule',
    severity: 'medium',
    moduleKey: 'personnel',
    description: 'A month whose roster or schedule was never prepared, so the previous month\'s was rolled forward automatically. Valid, but it must be reviewed and it must be visible.',
    run: (db, today) => safely('schedule_carried_forward', () => {
      if (!tableExists(db, 'schedule_carry_forwards')) return [];
      const months = [monthOf(today), nextMonth(monthOf(today))];
      const rows = db.prepare(`SELECT cf.*, s.name AS section_name FROM schedule_carry_forwards cf
         LEFT JOIN sections s ON s.id = cf.section_id
         WHERE cf.month IN (?, ?)`).all(...months) as any[];
      return rows.map(row => ({
        flagKey: `schedule_carried_forward:${row.kind}:${row.month}:${row.section_id}`,
        checkKey: 'schedule_carried_forward',
        category: 'schedule' as AuditFlagCategory,
        severity: 'medium' as AuditSeverity,
        moduleKey: 'personnel',
        title: `${row.kind === 'duty_roster' ? 'Duty roster' : row.kind === 'reassignment' ? 'Unit reassignment' : 'Bench schedule'} carried forward — ${monthLabel(row.month)}${row.section_name ? ` (${row.section_name})` : ''}`,
        detail: row.detail || 'The previous month\'s schedule is running because none was prepared. Review it and adjust.',
        recordType: row.kind === 'duty_roster' ? 'duty_rosters' : row.kind === 'reassignment' ? 'reassignment_schedules' : 'bench_schedules',
        recordId: String(row.created_id ?? ''),
        sectionId: row.section_id || null,
        actionUrl: row.kind === 'bench_schedule'
          ? `/personnel?tab=Bench%20Schedules&sectionId=${row.section_id}`
          : row.kind === 'reassignment' ? '/personnel?tab=Unit%20Reassignments' : '/personnel?tab=Duty%20Roster',
      }));
    }),
  },
  {
    key: 'roster_unapproved',
    label: 'Roster in force without approval',
    category: 'governance',
    severity: 'medium',
    moduleKey: 'personnel',
    description: 'The month has started on a roster still sitting in draft — staff are working to an unapproved schedule.',
    run: (db, today) => safely('roster_unapproved', () => {
      if (!tableExists(db, 'duty_rosters')) return [];
      const month = monthOf(today);
      const rows = db.prepare("SELECT id, roster_number, month, status FROM duty_rosters WHERE month = ? AND status = 'draft'").all(month) as any[];
      return rows.map(row => ({
        flagKey: `roster_unapproved:${row.id}`,
        checkKey: 'roster_unapproved',
        category: 'governance' as AuditFlagCategory,
        severity: 'medium' as AuditSeverity,
        moduleKey: 'personnel',
        title: `Duty roster still in draft — ${monthLabel(row.month)}`,
        detail: `${row.roster_number} is the roster for the month that is already running, and it has not been approved or published.`,
        recordType: 'duty_rosters', recordId: String(row.id),
        actionUrl: `/personnel?tab=Duty%20Roster&focus=duty_rosters:${row.id}`,
      }));
    }),
  },
  {
    key: 'staff_without_unit',
    label: 'Staff with no unit',
    category: 'inconsistency',
    severity: 'medium',
    moduleKey: 'personnel',
    description: 'An active member of staff who belongs to no unit, so no unit work can ever be routed to them.',
    run: db => safely('staff_without_unit', () => {
      const rows = db.prepare('SELECT id, full_name FROM staff WHERE is_active = 1 AND (section_id IS NULL OR section_id = 0)').all() as any[];
      return rows.map(row => ({
        flagKey: `staff_without_unit:${row.id}`,
        checkKey: 'staff_without_unit',
        category: 'inconsistency' as AuditFlagCategory,
        severity: 'medium' as AuditSeverity,
        moduleKey: 'personnel',
        title: `No unit assigned: ${row.full_name}`,
        detail: 'This member of staff is active but sits in no unit, so they receive no unit activities and appear on no bench schedule.',
        recordType: 'staff', recordId: String(row.id),
        actionUrl: `/personnel?tab=Master%20Personnel%20Register&focus=staff:${row.id}`,
      }));
    }),
  },
  {
    key: 'section_without_head',
    label: 'Unit with no head',
    category: 'governance',
    severity: 'medium',
    moduleKey: 'settings',
    description: 'A unit with no head, so its bench schedule has no owner and its escalations have nowhere to go.',
    run: db => safely('section_without_head', () => {
      if (!columnExists(db, 'sections', 'head_staff_id')) return [];
      const rows = db.prepare('SELECT id, name FROM sections WHERE is_active = 1 AND head_staff_id IS NULL').all() as any[];
      return rows.map(row => ({
        flagKey: `section_without_head:${row.id}`,
        checkKey: 'section_without_head',
        category: 'governance' as AuditFlagCategory,
        severity: 'medium' as AuditSeverity,
        moduleKey: 'settings',
        title: `No unit head: ${row.name}`,
        detail: 'Bench schedules for this unit have nobody to prepare them, and activities that escalate have nobody to escalate to.',
        recordType: 'sections', recordId: String(row.id),
        sectionId: Number(row.id),
        actionUrl: `/settings/sections?focus=sections:${row.id}`,
      }));
    }),
  },

  /* ── Records that were due and never appeared ──────────────────────────── */
  {
    key: 'overdue_capa',
    label: 'CAPA past its due date',
    category: 'omission',
    severity: 'high',
    moduleKey: 'nc_capa',
    description: 'A corrective or preventive action still open after its due date.',
    run: (db, today) => safely('overdue_capa', () => {
      if (!tableExists(db, 'capa_records')) return [];
      const rows = db.prepare("SELECT id, capa_number, title, due_date, responsible_staff_id FROM capa_records WHERE due_date IS NOT NULL AND due_date < ? AND status NOT IN ('closed','completed','verified')").all(today) as any[];
      return rows.map(row => ({
        flagKey: `overdue_capa:${row.id}`,
        checkKey: 'overdue_capa',
        category: 'omission' as AuditFlagCategory,
        severity: 'high' as AuditSeverity,
        moduleKey: 'nc_capa',
        title: `CAPA overdue: ${row.capa_number} — ${row.title}`,
        detail: `Due ${row.due_date} and still open.`,
        recordType: 'capa_records', recordId: String(row.id),
        responsibleStaffId: row.responsible_staff_id ?? null, dueDate: row.due_date,
        actionUrl: `/capa?tab=Register&focus=capa_records:${row.id}`,
      }));
    }),
  },
  {
    key: 'nc_without_capa',
    label: 'Nonconformity with no CAPA',
    category: 'omission',
    severity: 'high',
    moduleKey: 'nc_capa',
    description: 'A nonconformity open beyond a fortnight with no corrective action raised against it.',
    run: (db, today) => safely('nc_without_capa', () => {
      if (!tableExists(db, 'nonconforming_events') || !tableExists(db, 'capa_records')) return [];
      const cutoff = addDays(today, -14);
      const rows = db.prepare(`SELECT n.id, n.nc_number, n.title, n.event_date, n.section_id
         FROM nonconforming_events n
         WHERE n.status NOT IN ('closed','cancelled') AND n.event_date <= ?
           AND NOT EXISTS (SELECT 1 FROM capa_records c WHERE c.nc_id = n.id)`).all(cutoff) as any[];
      return rows.map(row => ({
        flagKey: `nc_without_capa:${row.id}`,
        checkKey: 'nc_without_capa',
        category: 'omission' as AuditFlagCategory,
        severity: 'high' as AuditSeverity,
        moduleKey: 'nc_capa',
        title: `No CAPA raised: ${row.nc_number} — ${row.title}`,
        detail: `Reported ${row.event_date}, still open after 14 days, and no corrective action has been raised against it.`,
        recordType: 'nonconforming_events', recordId: String(row.id),
        sectionId: row.section_id ?? null, dueDate: row.event_date,
        actionUrl: `/nonconformities?tab=Register&focus=nonconforming_events:${row.id}`,
      }));
    }),
  },
  {
    key: 'excursion_unresolved',
    label: 'Environmental excursion left open',
    category: 'omission',
    severity: 'critical',
    moduleKey: 'monitoring',
    description: 'A temperature or humidity excursion open for more than a day with no investigation recorded.',
    run: (db, today) => safely('excursion_unresolved', () => {
      if (!tableExists(db, 'environmental_excursions')) return [];
      const cutoff = addDays(today, -1);
      const rows = db.prepare(`SELECT e.id, e.started_at, e.parameter, a.name AS asset_name, a.section_id
         FROM environmental_excursions e LEFT JOIN environmental_assets a ON a.id = e.asset_id
         WHERE e.status = 'open' AND substr(e.started_at, 1, 10) <= ?`).all(cutoff) as any[];
      return rows.map(row => ({
        flagKey: `excursion_unresolved:${row.id}`,
        checkKey: 'excursion_unresolved',
        category: 'omission' as AuditFlagCategory,
        severity: 'critical' as AuditSeverity,
        moduleKey: 'monitoring',
        title: `Excursion still open: ${row.asset_name || 'asset'} (${row.parameter})`,
        detail: `Started ${String(row.started_at).slice(0, 16).replace('T', ' ')} and has neither been closed nor investigated.`,
        recordType: 'environmental_excursions', recordId: String(row.id),
        sectionId: row.section_id ?? null,
        actionUrl: `/facilities-safety?tab=Environmental%20Monitoring&subtab=Excursions&focus=environmental_excursions:${row.id}`,
      }));
    }),
  },
  {
    key: 'equipment_maintenance_overdue',
    label: 'Equipment maintenance overdue',
    category: 'omission',
    severity: 'high',
    moduleKey: 'equipment',
    description: 'An instrument whose scheduled maintenance or servicing due date has passed.',
    run: (db, today) => safely('equipment_maintenance_overdue', () => {
      if (!tableExists(db, 'equipment_schedules')) return [];
      const rows = db.prepare(`SELECT es.id, es.next_due_date, es.schedule_type, es.section_id, e.name AS equipment_name, e.id AS equipment_id
         FROM equipment_schedules es JOIN equipment_items e ON e.id = es.equipment_id
         WHERE es.is_active = 1 AND es.next_due_date IS NOT NULL AND es.next_due_date < ?`).all(today) as any[];
      return rows.map(row => ({
        flagKey: `equipment_maintenance_overdue:${row.id}`,
        checkKey: 'equipment_maintenance_overdue',
        category: 'omission' as AuditFlagCategory,
        severity: 'high' as AuditSeverity,
        moduleKey: 'equipment',
        title: `${row.schedule_type === 'servicing' ? 'Servicing' : 'Maintenance'} overdue: ${row.equipment_name}`,
        detail: `Was due ${row.next_due_date}.`,
        recordType: 'equipment_items', recordId: String(row.equipment_id),
        sectionId: row.section_id ?? null, dueDate: row.next_due_date,
        actionUrl: `/equipment?tab=Equipment%20Register&focus=equipment_items:${row.equipment_id}`,
      }));
    }),
  },
  {
    key: 'calibration_overdue',
    label: 'Calibration overdue',
    category: 'omission',
    severity: 'critical',
    moduleKey: 'equipment',
    description: 'An instrument in service past its calibration due date — results from it are not defensible.',
    run: (db, today) => safely('calibration_overdue', () => {
      if (!tableExists(db, 'equipment_items')) return [];
      const column = columnExists(db, 'equipment_items', 'next_calibration_due') ? 'COALESCE(next_calibration_due, calibration_due_date)' : 'calibration_due_date';
      const rows = db.prepare(`SELECT id, name, equipment_number, ${column} AS due, section_id, status
         FROM equipment_items WHERE ${column} IS NOT NULL AND ${column} < ? AND status NOT IN ('retired', 'decommissioned')`).all(today) as any[];
      return rows.map(row => ({
        flagKey: `calibration_overdue:${row.id}`,
        checkKey: 'calibration_overdue',
        category: 'omission' as AuditFlagCategory,
        severity: 'critical' as AuditSeverity,
        moduleKey: 'equipment',
        title: `Calibration overdue: ${row.name} (${row.equipment_number})`,
        detail: `Calibration was due ${row.due} and the instrument is still listed as ${row.status}.`,
        recordType: 'equipment_items', recordId: String(row.id),
        sectionId: row.section_id ?? null, dueDate: row.due,
        actionUrl: `/equipment?tab=Equipment%20Register&focus=equipment_items:${row.id}`,
      }));
    }),
  },
  {
    key: 'expired_stock_in_use',
    label: 'Expired stock still available',
    category: 'inconsistency',
    severity: 'critical',
    moduleKey: 'supplier_inventory',
    description: 'A reagent or consumable past its expiry date that the register still shows as available.',
    run: (db, today) => safely('expired_stock_in_use', () => {
      if (!tableExists(db, 'inventory_items')) return [];
      const rows = db.prepare("SELECT id, item_code, name, expiry_date, quantity FROM inventory_items WHERE expiry_date IS NOT NULL AND expiry_date < ? AND status = 'available' AND quantity > 0").all(today) as any[];
      return rows.map(row => ({
        flagKey: `expired_stock_in_use:${row.id}`,
        checkKey: 'expired_stock_in_use',
        category: 'inconsistency' as AuditFlagCategory,
        severity: 'critical' as AuditSeverity,
        moduleKey: 'supplier_inventory',
        title: `Expired but still available: ${row.name}`,
        detail: `${row.item_code} expired on ${row.expiry_date}, and ${row.quantity} remain marked available for use.`,
        recordType: 'inventory_items', recordId: String(row.id),
        dueDate: row.expiry_date,
        actionUrl: `/supplier-inventory?tab=Item%20Register&focus=inventory_items:${row.id}`,
      }));
    }),
  },
  {
    key: 'document_review_overdue',
    label: 'Controlled document past review',
    category: 'omission',
    severity: 'medium',
    moduleKey: 'documents',
    description: 'A controlled document in force past its review date.',
    run: (db, today) => safely('document_review_overdue', () => {
      if (!columnExists(db, 'documents', 'next_review_date')) return [];
      const rows = db.prepare("SELECT id, document_code, title, next_review_date FROM documents WHERE next_review_date IS NOT NULL AND next_review_date < ? AND status NOT IN ('obsolete','archived')").all(today) as any[];
      return rows.map(row => ({
        flagKey: `document_review_overdue:${row.id}`,
        checkKey: 'document_review_overdue',
        category: 'omission' as AuditFlagCategory,
        severity: 'medium' as AuditSeverity,
        moduleKey: 'documents',
        title: `Review overdue: ${row.document_code || ''} ${row.title}`.trim(),
        detail: `Review was due ${row.next_review_date} and the document remains in force.`,
        recordType: 'documents', recordId: String(row.id),
        dueDate: row.next_review_date,
        actionUrl: `/documents?tab=Documents&focus=documents:${row.id}`,
      }));
    }),
  },
  {
    key: 'iqc_unreviewed',
    label: 'IQC results never reviewed',
    category: 'omission',
    severity: 'high',
    moduleKey: 'iqc',
    description: 'Internal quality control results more than a week old with no review recorded.',
    run: (db, today) => safely('iqc_unreviewed', () => {
      if (!tableExists(db, 'iqc_results') || !columnExists(db, 'iqc_results', 'reviewed_at')) return [];
      const cutoff = addDays(today, -7);
      const rows = db.prepare(`SELECT id, run_date FROM iqc_results WHERE reviewed_at IS NULL AND run_date IS NOT NULL AND run_date <= ? LIMIT 200`).all(cutoff) as any[];
      // One flag per day of unreviewed results rather than one per result: a
      // hundred identical rows is noise, and the reviewer works by day anyway.
      const byDate = new Map<string, number>();
      for (const row of rows) byDate.set(String(row.run_date).slice(0, 10), (byDate.get(String(row.run_date).slice(0, 10)) ?? 0) + 1);
      return [...byDate.entries()].map(([date, count]) => ({
        flagKey: `iqc_unreviewed:${date}`,
        checkKey: 'iqc_unreviewed',
        category: 'omission' as AuditFlagCategory,
        severity: 'high' as AuditSeverity,
        moduleKey: 'iqc',
        title: `IQC not reviewed — ${date}`,
        detail: `${count} control result${count === 1 ? '' : 's'} from ${date} have never been reviewed.`,
        recordType: 'iqc_results', recordId: date,
        dueDate: date,
        actionUrl: `/iqc?tab=Review`,
      }));
    }),
  },

  /* ── Accounts and access ───────────────────────────────────────────────── */
  {
    key: 'user_without_staff',
    label: 'Login not linked to a person',
    category: 'access',
    severity: 'high',
    moduleKey: 'settings',
    description: 'An active user account with no staff record behind it, so its actions cannot be attributed and it receives no duty work.',
    run: db => safely('user_without_staff', () => {
      const rows = db.prepare('SELECT id, username, full_name FROM users WHERE is_active = 1 AND (staff_id IS NULL OR staff_id = 0)').all() as any[];
      return rows.map(row => ({
        flagKey: `user_without_staff:${row.id}`,
        checkKey: 'user_without_staff',
        category: 'access' as AuditFlagCategory,
        severity: 'high' as AuditSeverity,
        moduleKey: 'settings',
        title: `Account not linked to staff: ${row.username}`,
        detail: `${row.full_name} can sign in, but the account is attached to no personnel record, so its actions are unattributable and no duty activity can reach it.`,
        recordType: 'users', recordId: String(row.id),
        actionUrl: `/settings/people?focus=users:${row.id}`,
      }));
    }),
  },
  {
    key: 'dormant_account',
    label: 'Dormant account still enabled',
    category: 'access',
    severity: 'medium',
    moduleKey: 'settings',
    description: 'An enabled account with no sign-in for 90 days.',
    run: (db, today) => safely('dormant_account', () => {
      if (!tableExists(db, 'auth_sessions')) return [];
      const cutoff = addDays(today, -90);
      const rows = db.prepare(`SELECT u.id, u.username, u.full_name, u.created_at,
           (SELECT MAX(created_at) FROM auth_sessions s WHERE s.user_id = u.id) AS last_seen
         FROM users u WHERE u.is_active = 1`).all() as any[];
      return rows
        // An account created last week that has not been used yet is not
        // dormant, it is new. Flagging every fresh install's accounts on day
        // one is the fastest way to teach people the audit cries wolf.
        .filter(row => String(row.created_at ?? '').slice(0, 10) < cutoff)
        .filter(row => !row.last_seen || String(row.last_seen).slice(0, 10) < cutoff)
        .map(row => ({
          flagKey: `dormant_account:${row.id}`,
          checkKey: 'dormant_account',
          category: 'access' as AuditFlagCategory,
          severity: 'medium' as AuditSeverity,
          moduleKey: 'settings',
          title: `Dormant account: ${row.username}`,
          detail: row.last_seen ? `${row.full_name} last signed in on ${String(row.last_seen).slice(0, 10)}.` : `${row.full_name} has never signed in.`,
          recordType: 'users', recordId: String(row.id),
          actionUrl: `/settings/people?focus=users:${row.id}`,
        }));
    }),
  },

  /* ── Record integrity ──────────────────────────────────────────────────── */
  {
    key: 'orphan_evidence',
    label: 'Evidence pointing at a missing file',
    category: 'integrity',
    severity: 'high',
    moduleKey: 'records_reports',
    description: 'An evidence link whose underlying file record no longer exists.',
    run: db => safely('orphan_evidence', () => {
      if (!tableExists(db, 'evidence_files')) return [];
      const rows = db.prepare(`SELECT e.id, e.module_key, e.record_type, e.record_id FROM evidence_files e
         WHERE NOT EXISTS (SELECT 1 FROM files f WHERE f.id = e.file_id)`).all() as any[];
      return rows.map(row => ({
        flagKey: `orphan_evidence:${row.id}`,
        checkKey: 'orphan_evidence',
        category: 'integrity' as AuditFlagCategory,
        severity: 'high' as AuditSeverity,
        moduleKey: 'records_reports',
        title: `Missing evidence file (${row.module_key})`,
        detail: `The evidence attached to ${row.record_type} ${row.record_id} points at a file record that no longer exists.`,
        recordType: 'evidence_files', recordId: String(row.id),
        actionUrl: `/records-reports?tab=Evidence%20Packs&focus=evidence_files:${row.id}`,
      }));
    }),
  },
  {
    key: 'audit_trail_unreviewed',
    label: 'Audit trail not reviewed',
    category: 'governance',
    severity: 'medium',
    moduleKey: 'records_reports',
    description: 'ISO 15189 expects the audit trail to be reviewed periodically; none has been recorded in the last quarter.',
    run: (db, today) => safely('audit_trail_unreviewed', () => {
      if (!tableExists(db, 'audit_trail_reviews')) return [];
      const cutoff = addDays(today, -92);
      const last = db.prepare('SELECT MAX(review_date) AS d FROM audit_trail_reviews').get() as any;
      if (last?.d && String(last.d).slice(0, 10) >= cutoff) return [];
      return [{
        flagKey: 'audit_trail_unreviewed:current',
        checkKey: 'audit_trail_unreviewed',
        category: 'governance' as AuditFlagCategory,
        severity: 'medium' as AuditSeverity,
        moduleKey: 'records_reports',
        title: 'Audit trail has not been reviewed this quarter',
        detail: last?.d ? `The last recorded review was on ${String(last.d).slice(0, 10)}.` : 'No audit trail review has ever been recorded.',
        recordType: 'audit_trail_reviews', recordId: 'current',
        dueDate: cutoff,
        actionUrl: '/records-reports?tab=Audit%20Trail%20Reviews',
      }];
    }),
  },
  {
    key: 'backup_not_verified',
    label: 'Backup never restore-tested',
    category: 'integrity',
    severity: 'high',
    moduleKey: 'records_reports',
    description: 'A backup nobody has proved can be restored is not a backup. None has been verified in the last quarter.',
    run: (db, today) => safely('backup_not_verified', () => {
      if (!tableExists(db, 'backup_restore_checks')) return [];
      const cutoff = addDays(today, -92);
      const last = db.prepare("SELECT MAX(check_date) AS d FROM backup_restore_checks WHERE restore_test_status IN ('passed','successful','ok')").get() as any;
      if (last?.d && String(last.d).slice(0, 10) >= cutoff) return [];
      return [{
        flagKey: 'backup_not_verified:current',
        checkKey: 'backup_not_verified',
        category: 'integrity' as AuditFlagCategory,
        severity: 'high' as AuditSeverity,
        moduleKey: 'records_reports',
        title: 'No successful restore test this quarter',
        detail: last?.d ? `The last successful restore test was on ${String(last.d).slice(0, 10)}.` : 'No restore test has ever been recorded.',
        recordType: 'backup_restore_checks', recordId: 'current',
        dueDate: cutoff,
        actionUrl: '/records-reports?tab=Backup%2FRestore%20Checks',
      }];
    }),
  },
  {
    key: 'module_disabled_with_work',
    label: 'Disabled module still holding open work',
    category: 'inconsistency',
    severity: 'medium',
    moduleKey: 'settings',
    description: 'A module switched off while records inside it are still open — the work becomes invisible rather than finished.',
    run: db => safely('module_disabled_with_work', () => {
      if (!tableExists(db, 'system_modules')) return [];
      const openCounts: Record<string, () => number> = {
        nc_capa: () => tableExists(db, 'nonconforming_events') ? (db.prepare("SELECT COUNT(*) n FROM nonconforming_events WHERE status NOT IN ('closed','cancelled')").get() as any).n : 0,
        complaints: () => tableExists(db, 'complaints') ? (db.prepare("SELECT COUNT(*) n FROM complaints WHERE status NOT IN ('closed','cancelled')").get() as any).n : 0,
        equipment: () => tableExists(db, 'equipment_breakdowns') ? (db.prepare("SELECT COUNT(*) n FROM equipment_breakdowns WHERE status NOT IN ('closed','resolved')").get() as any).n : 0,
        actions: () => tableExists(db, 'actions') ? (db.prepare("SELECT COUNT(*) n FROM actions WHERE status != 'Closed'").get() as any).n : 0,
      };
      const out: AuditFinding[] = [];
      for (const row of db.prepare('SELECT key, label FROM system_modules WHERE enabled = 0').all() as any[]) {
        const counter = openCounts[row.key];
        if (!counter) continue;
        const open = counter();
        if (!open) continue;
        out.push({
          flagKey: `module_disabled_with_work:${row.key}`,
          checkKey: 'module_disabled_with_work',
          category: 'inconsistency' as AuditFlagCategory,
          severity: 'medium' as AuditSeverity,
          moduleKey: 'settings',
          title: `${row.label} is switched off with ${open} open record${open === 1 ? '' : 's'}`,
          detail: 'Disabling a module hides its records; it does not close them. Re-enable it to work them off, or close them first.',
          recordType: 'system_modules', recordId: String(row.key),
          actionUrl: '/settings/system',
        });
      }
      return out;
    }),
  },
];

/* ============================================================================
   Running a scan
   ========================================================================= */
export type ScanResult = { scanId: number; checksRun: number; flagsFound: number; flagsNew: number; flagsCleared: number; durationMs: number };

/**
 * Run every check and reconcile the results against the stored flags.
 *
 * Reconciliation is the point. A finding that is still present refreshes its
 * row; one that has gone away is auto-cleared with a timestamp, so the flag
 * list is the live state of the laboratory rather than an ever-growing pile.
 * A flag somebody explicitly dismissed stays dismissed.
 */
export function runAuditScan(db: Db, triggeredBy: number | null = null, today = todayIso()): ScanResult {
  const started = Date.now();
  const scanId = Number(db.prepare('INSERT INTO system_audit_scans (triggered_by) VALUES (?)').run(triggeredBy).lastInsertRowid);

  const findings: AuditFinding[] = [];
  for (const check of AUDIT_CHECKS) findings.push(...check.run(db, today));

  const seen = new Set(findings.map(f => f.flagKey));
  let flagsNew = 0;

  const upsert = db.prepare(`INSERT INTO system_audit_flags
     (flag_key, check_key, category, severity, module_key, title, detail, record_type, record_id, section_id,
      responsible_staff_id, due_date, action_url, status, first_seen_at, last_seen_at, occurrences)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1)
     ON CONFLICT(flag_key) DO UPDATE SET
       severity = excluded.severity, title = excluded.title, detail = excluded.detail,
       action_url = excluded.action_url, due_date = excluded.due_date,
       section_id = excluded.section_id, responsible_staff_id = excluded.responsible_staff_id,
       last_seen_at = CURRENT_TIMESTAMP, occurrences = system_audit_flags.occurrences + 1,
       auto_cleared_at = NULL,
       -- A flag that had been auto-cleared and has come back is open again;
       -- one a person resolved or dismissed keeps their decision.
       status = CASE WHEN system_audit_flags.auto_cleared_at IS NOT NULL THEN 'open' ELSE system_audit_flags.status END`);

  const existing = new Set((db.prepare("SELECT flag_key FROM system_audit_flags WHERE status = 'open' OR status = 'acknowledged'").all() as any[]).map(r => String(r.flag_key)));

  const run = db.transaction(() => {
    for (const finding of findings) {
      if (!existing.has(finding.flagKey)) {
        const known = db.prepare('SELECT id FROM system_audit_flags WHERE flag_key = ?').get(finding.flagKey);
        if (!known) flagsNew++;
      }
      upsert.run(finding.flagKey, finding.checkKey, finding.category, finding.severity, finding.moduleKey ?? null,
        finding.title, finding.detail ?? null, finding.recordType ?? null, finding.recordId ?? null,
        finding.sectionId ?? null, finding.responsibleStaffId ?? null, finding.dueDate ?? null, finding.actionUrl);
    }
  });
  run();

  // Anything open that this scan did not find has been put right.
  let flagsCleared = 0;
  for (const flagKey of existing) {
    if (seen.has(flagKey)) continue;
    db.prepare("UPDATE system_audit_flags SET status = 'resolved', auto_cleared_at = CURRENT_TIMESTAMP, resolved_at = CURRENT_TIMESTAMP, resolution_note = COALESCE(resolution_note, 'Cleared automatically — the condition no longer exists.') WHERE flag_key = ?")
      .run(flagKey);
    flagsCleared++;
  }

  const durationMs = Date.now() - started;
  db.prepare(`UPDATE system_audit_scans SET finished_at = CURRENT_TIMESTAMP, duration_ms = ?, checks_run = ?, flags_found = ?, flags_new = ?, flags_cleared = ?, detail = ? WHERE id = ?`)
    .run(durationMs, AUDIT_CHECKS.length, findings.length, flagsNew, flagsCleared,
      JSON.stringify({ byCategory: countBy(findings, f => f.category) }), scanId);

  return { scanId, checksRun: AUDIT_CHECKS.length, flagsFound: findings.length, flagsNew, flagsCleared, durationMs };
}

function countBy<T>(rows: T[], key: (row: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) { const k = key(row); out[k] = (out[k] ?? 0) + 1; }
  return out;
}

/** Metadata for the Checks tab: what each check looks for, and how it is doing. */
export function checkCatalogue(db: Db) {
  const counts = new Map<string, { open: number; lastSeen: string | null }>();
  try {
    for (const row of db.prepare("SELECT check_key, COUNT(*) n, MAX(last_seen_at) last FROM system_audit_flags WHERE status IN ('open','acknowledged') GROUP BY check_key").all() as any[]) {
      counts.set(String(row.check_key), { open: Number(row.n), lastSeen: row.last ?? null });
    }
  } catch { /* pre-migration database */ }
  return AUDIT_CHECKS.map(check => ({
    key: check.key,
    label: check.label,
    category: check.category,
    categoryLabel: AUDIT_FLAG_CATEGORY_LABELS[check.category],
    description: check.description,
    severity: check.severity,
    moduleKey: check.moduleKey ?? null,
    openFlags: counts.get(check.key)?.open ?? 0,
    lastSeenAt: counts.get(check.key)?.lastSeen ?? null,
  }));
}

/** Run the scan at most once per interval; state survives a restart. */
let lastScanMemo = 0;
export function throttledAuditScan(db: Db, intervalMinutes = 20): void {
  const now = Date.now();
  if (now - lastScanMemo < intervalMinutes * 60 * 1000) return;
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'systemAudit.lastScan'").get() as any;
    const last = row ? Number(row.value) : 0;
    if (now - last < intervalMinutes * 60 * 1000) { lastScanMemo = last; return; }
    lastScanMemo = now;
    db.prepare("INSERT INTO settings (key, value) VALUES ('systemAudit.lastScan', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP").run(String(now));
    runAuditScan(db, null);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[system-audit] throttled scan failed:', (err as Error).message);
  }
}
