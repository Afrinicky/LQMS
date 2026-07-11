import { collectScanCandidates, classifyDue, severityForCandidate, type ScanCandidate } from '../routes/notifications.js';
import { generateRecordNumber } from '../utils/recordNumber.js';

// ==========================================================================
// Alert service — the backbone of the notification/alert system.
//   * computeLiveAlerts   → always-current alert objects for the dashboards
//   * runAlertScanAndRoute → persists notifications routed to the right people
//   * throttledAutoScan    → runs the routed scan at most once per interval
// Every alert-worthy condition across the whole system flows through the
// shared collectScanCandidates() scan; this service turns those candidates
// into live cards and into per-user notifications routed by section + role.
// ==========================================================================

export type LiveAlert = {
  key: string;
  module: string;
  moduleLabel: string;
  title: string;
  message: string;
  detail: string;
  value: string | null;
  dueDate: string | null;
  severity: string;         // info | low | medium | high | urgent
  tone: 'ok' | 'warn' | 'crit' | 'info';
  notificationType: string;
  itemType: string;
  recordType: string;
  recordId: string;
  sectionId: number | null;
  sectionName: string | null;
  responsibleStaffId: number | null;
  actionUrl: string;
};

const MODULE_LABELS: Record<string, string> = {
  actions: 'Action Tracker', documents: 'Documents & Records', personnel: 'Personnel',
  equipment: 'Equipment', supplier_inventory: 'Supplier & Inventory', monitoring: 'Monitoring',
  iqc: 'Internal QC', eqa: 'EQA / PT', verification_validation: 'Verification & Validation',
  measurement_uncertainty: 'Measurement Uncertainty', blood_bank_handover: 'Blood Bank',
  monthly_reports: 'Monthly Reports', assessments: 'Assessments', meetings: 'Meetings',
  management_review: 'Management Review', quality_indicators: 'Quality Indicators',
  continual_improvement: 'Continual Improvement', customer_focus: 'Customer Focus', poct: 'POCT',
  nc_capa: 'NC & CAPA', risks: 'Risks', complaints: 'Complaints', facilities_safety: 'Facilities & Safety',
  process_management: 'Process Management', information_management: 'Information Management',
  organisation: 'Organisation & Leadership', notifications: 'Notifications',
};

// Map each module to a landing route so an alert card can open its source module.
const MODULE_ROUTES: Record<string, string> = {
  actions: '/actions', documents: '/documents', personnel: '/personnel', equipment: '/equipment',
  supplier_inventory: '/supplier-inventory', monitoring: '/monitoring', iqc: '/iqc', eqa: '/eqa',
  verification_validation: '/verification-validation', measurement_uncertainty: '/measurement-uncertainty',
  blood_bank_handover: '/blood-bank-handover', monthly_reports: '/monthly-reports', assessments: '/assessments',
  meetings: '/meetings', management_review: '/management-review', quality_indicators: '/quality-indicators',
  continual_improvement: '/continual-improvement', customer_focus: '/customer-focus', poct: '/poct',
  nc_capa: '/nc-capa', risks: '/risks', complaints: '/complaints', facilities_safety: '/facilities-safety',
  process_management: '/process-management', information_management: '/information-management',
  organisation: '/organisation',
};

function toneFor(c: ScanCandidate): 'ok' | 'warn' | 'crit' | 'info' {
  const sev = severityForCandidate(c);
  if (sev === 'urgent' || sev === 'high') return 'crit';
  if (sev === 'medium') return 'warn';
  if (sev === 'low') return 'ok';
  return 'info';
}

function relTime(dueDate: string | null): string {
  if (!dueDate) return '';
  const { isOverdue } = classifyDue(dueDate);
  const today = new Date();
  const due = new Date(dueDate);
  const days = Math.round((due.getTime() - today.getTime()) / 86400000);
  if (isOverdue) return `${Math.abs(days)}d overdue`;
  if (days === 0) return 'due today';
  return `due in ${days}d`;
}

function actionUrlFor(c: ScanCandidate): string {
  const base = MODULE_ROUTES[c.moduleKey] || '/notifications';
  // Carry the exact record identity so the destination page can scroll to and
  // highlight the offending record (see useFocusTarget on the client). Pages
  // that don't yet consume `focus` simply land on the correct module — the
  // param is inert, so this is always safe.
  if (c.recordType && c.recordId) {
    return `${base}?focus=${encodeURIComponent(`${c.recordType}:${c.recordId}`)}`;
  }
  return base;
}

// Compute always-current alerts (not persisted). Optionally filter to a staff
// member's scope (their section + items they are responsible for) and/or a
// single module.
export function computeLiveAlerts(db: any, opts: { module?: string; staffId?: number | null; scope?: 'all' | 'mine' } = {}): LiveAlert[] {
  const candidates = collectScanCandidates(db);
  const sectionNames = new Map<number, string>();
  for (const s of db.prepare('SELECT id, name FROM sections').all() as any[]) sectionNames.set(s.id, s.name);

  let mySectionId: number | null = null;
  if (opts.staffId) {
    const st = db.prepare('SELECT section_id FROM staff WHERE id = ?').get(opts.staffId) as any;
    mySectionId = st?.section_id ?? null;
  }

  const alerts: LiveAlert[] = [];
  for (const c of candidates) {
    if (opts.module && c.moduleKey !== opts.module) continue;
    if (opts.scope === 'mine' && opts.staffId) {
      const mine = c.responsibleStaffId === opts.staffId || (mySectionId != null && c.sectionId === mySectionId);
      if (!mine) continue;
    }
    const sev = severityForCandidate(c);
    alerts.push({
      key: `${c.moduleKey}:${c.recordType}:${c.recordId}:${c.itemType}`,
      module: c.moduleKey,
      moduleLabel: MODULE_LABELS[c.moduleKey] || c.moduleKey,
      title: c.title,
      message: c.message,
      detail: [c.sectionId ? sectionNames.get(c.sectionId) : null, relTime(c.dueDate)].filter(Boolean).join(' · '),
      value: c.value ?? (c.dueDate ? relTime(c.dueDate) : null),
      dueDate: c.dueDate,
      severity: sev,
      tone: toneFor(c),
      notificationType: c.notificationType,
      itemType: c.itemType,
      recordType: c.recordType,
      recordId: c.recordId,
      sectionId: c.sectionId ?? null,
      sectionName: c.sectionId ? (sectionNames.get(c.sectionId) ?? null) : null,
      responsibleStaffId: c.responsibleStaffId ?? null,
      actionUrl: actionUrlFor(c),
    });
  }
  // Sort: crit → warn → ok, then most overdue first.
  const toneRank: Record<string, number> = { crit: 0, warn: 1, info: 2, ok: 3 };
  alerts.sort((a, b) => {
    if (toneRank[a.tone] !== toneRank[b.tone]) return toneRank[a.tone] - toneRank[b.tone];
    const ad = a.dueDate || '9999'; const bd = b.dueDate || '9999';
    return ad < bd ? -1 : ad > bd ? 1 : 0;
  });
  return alerts;
}

// Group live alerts by module with a small summary per module.
export function groupLiveAlerts(alerts: LiveAlert[]) {
  const groups: Record<string, { module: string; moduleLabel: string; total: number; crit: number; warn: number; alerts: LiveAlert[] }> = {};
  for (const a of alerts) {
    if (!groups[a.module]) groups[a.module] = { module: a.module, moduleLabel: a.moduleLabel, total: 0, crit: 0, warn: 0, alerts: [] };
    const g = groups[a.module];
    g.total++;
    if (a.tone === 'crit') g.crit++;
    else if (a.tone === 'warn') g.warn++;
    g.alerts.push(a);
  }
  return Object.values(groups).sort((a, b) => (b.crit - a.crit) || (b.total - a.total));
}

// ------------------------------------------------------------------
// Recipient routing — who should be notified about a candidate.
// ------------------------------------------------------------------
function staffByPositionKeywords(db: any, keywords: string[]): number[] {
  const like = keywords.map(() => 'LOWER(p.title) LIKE ?').join(' OR ');
  const params = keywords.map(k => `%${k.toLowerCase()}%`);
  try {
    const rows = db.prepare(`SELECT DISTINCT spa.staff_id AS id FROM staff_position_assignments spa JOIN positions p ON p.id = spa.position_id JOIN staff s ON s.id = spa.staff_id WHERE spa.is_active = 1 AND s.is_active = 1 AND (${like})`).all(...params) as any[];
    return rows.map(r => r.id);
  } catch { return []; }
}

// Staff linked to a user account whose ROLE matches one of the given keywords
// (e.g. Manager, Administrator). This is the delivery-guarantee fallback: it
// works even when the organogram has no matching position titles, because the
// managerial/admin roles are always seeded.
function staffByUserRoleKeywords(db: any, keywords: string[]): number[] {
  const like = keywords.map(() => 'LOWER(r.name) LIKE ?').join(' OR ');
  const params = keywords.map(k => `%${k.toLowerCase()}%`);
  try {
    const rows = db.prepare(`SELECT DISTINCT u.staff_id AS id FROM users u JOIN roles r ON r.id = u.role_id JOIN staff s ON s.id = u.staff_id WHERE u.is_active = 1 AND s.is_active = 1 AND u.staff_id IS NOT NULL AND (${like})`).all(...params) as any[];
    return rows.map(r => r.id);
  } catch { return []; }
}

export function resolveRecipients(db: any, c: ScanCandidate): number[] {
  const set = new Set<number>();
  // 1. The explicitly responsible person.
  if (c.responsibleStaffId) set.add(c.responsibleStaffId);
  // 2. Section head + active staff of the record's section.
  if (c.sectionId) {
    const sec = db.prepare('SELECT head_staff_id FROM sections WHERE id = ?').get(c.sectionId) as any;
    if (sec?.head_staff_id) set.add(sec.head_staff_id);
    for (const s of db.prepare('SELECT id FROM staff WHERE section_id = ? AND is_active = 1').all(c.sectionId) as any[]) set.add(s.id);
  }
  // 3. Role-based routing for approvals, reviews and high-severity items.
  const sev = severityForCandidate(c);
  if (c.notificationType === 'approval_required') {
    for (const id of staffByPositionKeywords(db, ['laboratory manager', 'lab manager', 'director', 'quality manager'])) set.add(id);
  } else if (c.notificationType === 'review_required') {
    for (const id of staffByPositionKeywords(db, ['quality manager', 'laboratory manager', 'head'])) set.add(id);
  }
  if (sev === 'urgent') {
    for (const id of staffByPositionKeywords(db, ['quality manager', 'laboratory manager'])) set.add(id);
  }
  // 4. Delivery-guarantee fallback so an alert is never routed to nobody:
  // try managerial/supervisor position titles, then staff whose USER ROLE is
  // managerial/admin (always seeded), then any active administrator. This
  // reaches an accountable authority without spamming every staff member.
  if (set.size === 0) {
    for (const id of staffByPositionKeywords(db, ['quality manager', 'laboratory manager', 'manager', 'supervisor', 'head'])) set.add(id);
  }
  if (set.size === 0) {
    for (const id of staffByUserRoleKeywords(db, ['quality manager', 'laboratory manager', 'manager', 'administrator'])) set.add(id);
  }
  if (set.size === 0) {
    for (const id of staffByUserRoleKeywords(db, ['administrator', 'admin'])) set.add(id);
  }
  return [...set];
}

// Persist per-user notifications for every candidate, routed to recipients,
// deduplicated against existing open notifications. Also refreshes the shared
// review calendar. Returns a small summary.
export function runAlertScanAndRoute(db: any, actorUserId: number | null): { candidates: number; created: number; skipped: number; recipients: number } {
  const candidates = collectScanCandidates(db);
  const today = new Date().toISOString().slice(0, 10);

  const usersByStaff = new Map<number, number[]>();
  for (const u of db.prepare('SELECT id, staff_id FROM users WHERE is_active = 1 AND staff_id IS NOT NULL').all() as any[]) {
    if (!usersByStaff.has(u.staff_id)) usersByStaff.set(u.staff_id, []);
    usersByStaff.get(u.staff_id)!.push(u.id);
  }

  const existsNotif = db.prepare("SELECT id FROM notifications WHERE assigned_to_staff_id = ? AND module_key = ? AND record_type = ? AND record_id = ? AND notification_type = ? AND status NOT IN ('resolved','dismissed')");
  const insertNotif = db.prepare(`INSERT INTO notifications (notification_number, user_id, module_key, title, message, status, severity, notification_type, due_date, record_type, record_id, assigned_to_staff_id, assigned_to_user_id, action_url, action_label, created_by) VALUES (?, ?, ?, ?, ?, 'unread', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const existsCal = db.prepare("SELECT id FROM review_calendar_items WHERE module_key = ? AND record_type = ? AND record_id = ? AND due_date = ? AND status NOT IN ('completed','cancelled')");
  const insertCal = db.prepare(`INSERT INTO review_calendar_items (calendar_number, module_key, record_type, record_id, title, description, due_date, item_type, responsible_staff_id, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  let created = 0, skipped = 0, recipientCount = 0;
  const tx = db.transaction(() => {
    for (const c of candidates) {
      const recipients = resolveRecipients(db, c);
      const sev = severityForCandidate(c);
      const actionUrl = actionUrlFor(c);
      const actionLabel = c.notificationType === 'approval_required' ? 'Review & approve'
        : c.notificationType === 'review_required' ? 'Open & review'
        : c.notificationType === 'expiry_alert' ? 'View item'
        : 'Open';
      for (const staffId of recipients) {
        recipientCount++;
        const dup = existsNotif.get(staffId, c.moduleKey, c.recordType, c.recordId, c.notificationType);
        if (dup) { skipped++; continue; }
        const number = generateRecordNumber(db, 'notifications', 'NOTIF', new Date().toISOString());
        const userIds = usersByStaff.get(staffId) || [];
        insertNotif.run(number, userIds[0] ?? null, c.moduleKey, c.title, c.message, sev, c.notificationType, c.dueDate, c.recordType, c.recordId, staffId, userIds[0] ?? null, actionUrl, actionLabel, actorUserId);
        created++;
      }
      // Shared review-calendar entry (one per candidate with a due date).
      if (c.dueDate) {
        const dup = existsCal.get(c.moduleKey, c.recordType, c.recordId, c.dueDate);
        if (!dup) {
          const calNumber = generateRecordNumber(db, 'review_calendar_items', 'CAL', new Date().toISOString());
          const calStatus = c.dueDate < today ? 'overdue' : 'due_soon';
          insertCal.run(calNumber, c.moduleKey, c.recordType, c.recordId, c.title, c.message, c.dueDate, c.itemType, c.responsibleStaffId ?? null, calStatus, actorUserId);
        }
      }
    }
  });
  tx();
  return { candidates: candidates.length, created, skipped, recipients: recipientCount };
}

// Run the routed scan at most once per intervalMinutes. State is stored in the
// shared settings table so the throttle survives restarts.
let lastRunMemo = 0;
export function throttledAutoScan(db: any, intervalMinutes = 15): void {
  const now = Date.now();
  // Cheap in-memory guard first.
  if (now - lastRunMemo < intervalMinutes * 60 * 1000) return;
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'alerts.lastAutoRun'").get() as any;
    const last = row ? Number(row.value) : 0;
    if (now - last < intervalMinutes * 60 * 1000) { lastRunMemo = last; return; }
    lastRunMemo = now;
    db.prepare("INSERT INTO settings (key, value) VALUES ('alerts.lastAutoRun', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP").run(String(now));
    runAlertScanAndRoute(db, null);
  } catch (err) {
    // Never let auto-scan break the request it piggy-backs on.
    // eslint-disable-next-line no-console
    console.error('[alerts] auto-scan failed:', (err as Error).message);
  }
}
