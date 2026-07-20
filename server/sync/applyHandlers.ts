/**
 * Host-side apply handlers for remote submissions (R3). Each handler translates a
 * validated remote proposal into an authoritative write on the Host database.
 * Handlers run inside a transaction; capture triggers are NOT suppressed, so any
 * change to a syncable table replicates back to the cloud and the portal sees it.
 *
 * New activities are added here as later phases land. Approval-tier activities are
 * parked as awaiting_approval by the reconciler and applied in R4.
 */
import type BetterSqlite3 from 'better-sqlite3';

export interface Submission {
  id: number;
  submission_uuid: string;
  actor_staff_id: number;
  actor_email: string | null;
  activity: string;
  target_table: string | null;
  target_uuid: string | null;
  base_version: string | null;
  payload: Record<string, unknown> | null;
  /** Set on approval-tier submissions once decided (R4); the approving staff id. */
  decided_by_staff_id?: number | null;
}

export interface ApplyResult { ok: boolean; message: string; }
export type ApplyHandler = (db: BetterSqlite3.Database, s: Submission) => ApplyResult;

export const APPLY_HANDLERS: Record<string, ApplyHandler> = {
  // SOP / controlled-document acknowledgement: attest the latest version of the
  // targeted document on behalf of the acting staff member.
  'sop.acknowledge': (db, s) => {
    if (!s.target_uuid) return { ok: false, message: 'No document specified.' };
    const doc = db.prepare('SELECT id, title FROM documents WHERE uuid = ?').get(s.target_uuid) as { id: number; title: string } | undefined;
    if (!doc) return { ok: false, message: 'Document not found on Host.' };
    const version = db.prepare('SELECT id FROM document_versions WHERE document_id = ? ORDER BY id DESC LIMIT 1').get(doc.id) as { id: number } | undefined;
    if (!version) return { ok: false, message: 'Document has no version to acknowledge.' };
    const existing = db.prepare('SELECT id FROM document_attestations WHERE document_version_id = ? AND staff_id = ?').get(version.id, s.actor_staff_id) as { id: number } | undefined;
    if (existing) {
      db.prepare("UPDATE document_attestations SET status = 'attested', attested_at = CURRENT_TIMESTAMP WHERE id = ?").run(existing.id);
    } else {
      db.prepare("INSERT INTO document_attestations (document_version_id, staff_id, attested_at, status) VALUES (?, ?, CURRENT_TIMESTAMP, 'attested')").run(version.id, s.actor_staff_id);
    }
    return { ok: true, message: `Acknowledged "${doc.title}".` };
  },

  // Own-profile update: a staff member may change only their own contact fields.
  'profile.update': (db, s) => {
    const p = s.payload ?? {};
    const phone = p.phone === undefined ? undefined : (p.phone === null ? null : String(p.phone));
    const email = p.email === undefined ? undefined : (p.email === null ? null : String(p.email));
    if (phone === undefined && email === undefined) return { ok: false, message: 'Nothing to update.' };
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (phone !== undefined) { sets.push('phone = ?'); vals.push(phone); }
    if (email !== undefined) { sets.push('email = ?'); vals.push(email); }
    vals.push(s.actor_staff_id);
    const info = db.prepare(`UPDATE staff SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...vals);
    if (info.changes === 0) return { ok: false, message: 'Staff record not found.' };
    return { ok: true, message: 'Profile updated.' };
  },

  // Assigned-task update: only the staff the action is assigned to may update it,
  // and only its status / completion notes.
  'task.update': (db, s) => {
    if (!s.target_uuid) return { ok: false, message: 'No task specified.' };
    const action = db.prepare('SELECT id, assigned_to_staff_id, title FROM actions WHERE uuid = ?').get(s.target_uuid) as { id: number; assigned_to_staff_id: number | null; title: string } | undefined;
    if (!action) return { ok: false, message: 'Task not found on Host.' };
    if (action.assigned_to_staff_id !== s.actor_staff_id) return { ok: false, message: 'This task is not assigned to you.' };
    const p = s.payload ?? {};
    const status = p.status === undefined ? undefined : String(p.status);
    const notes = p.completionNotes === undefined ? undefined : String(p.completionNotes);
    if (status === undefined && notes === undefined) return { ok: false, message: 'Nothing to update.' };
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (status !== undefined) { sets.push('status = ?'); vals.push(status); }
    if (notes !== undefined) { sets.push('completion_notes = ?'); vals.push(notes); }
    vals.push(action.id);
    db.prepare(`UPDATE actions SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...vals);
    return { ok: true, message: `Updated "${action.title}".` };
  },

  // Environmental reading capture: record a value against a monitoring item and
  // classify it against the item's limits.
  'env.reading': (db, s) => {
    if (!s.target_uuid) return { ok: false, message: 'No monitoring item specified.' };
    const item = db.prepare('SELECT id, name, lower_limit, upper_limit, warning_lower_limit, warning_upper_limit, critical_lower_limit, critical_upper_limit FROM monitoring_items WHERE uuid = ?').get(s.target_uuid) as
      { id: number; name: string; lower_limit: number | null; upper_limit: number | null; warning_lower_limit: number | null; warning_upper_limit: number | null; critical_lower_limit: number | null; critical_upper_limit: number | null } | undefined;
    if (!item) return { ok: false, message: 'Monitoring item not found on Host.' };
    const p = s.payload ?? {};
    const value = Number(p.value);
    if (!Number.isFinite(value)) return { ok: false, message: 'A numeric reading value is required.' };
    const below = (lim: number | null) => lim !== null && value < lim;
    const above = (lim: number | null) => lim !== null && value > lim;
    let status = 'normal';
    if (below(item.critical_lower_limit) || above(item.critical_upper_limit) || below(item.lower_limit) || above(item.upper_limit)) status = 'critical';
    else if (below(item.warning_lower_limit) || above(item.warning_upper_limit)) status = 'warning';
    db.prepare(
      `INSERT INTO monitoring_readings (monitoring_item_id, reading_date, value, entered_by_staff_id, status, comment)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(item.id, new Date().toISOString().slice(0, 10), value, s.actor_staff_id, status, p.comment === undefined ? null : String(p.comment));
    return { ok: true, message: `Reading recorded for "${item.name}" (${status}).` };
  },

  // Equipment maintenance log.
  'equipment.maintenance_log': (db, s) => {
    if (!s.target_uuid) return { ok: false, message: 'No equipment specified.' };
    const eq = db.prepare('SELECT id, name FROM equipment_items WHERE uuid = ?').get(s.target_uuid) as { id: number; name: string } | undefined;
    if (!eq) return { ok: false, message: 'Equipment not found on Host.' };
    const p = s.payload ?? {};
    db.prepare(
      `INSERT INTO equipment_maintenance_records (equipment_id, maintenance_date, maintenance_type, performed_by_staff_id, findings, action_taken, status)
       VALUES (?, ?, ?, ?, ?, ?, 'completed')`
    ).run(eq.id, new Date().toISOString().slice(0, 10), p.maintenanceType === undefined ? 'routine' : String(p.maintenanceType), s.actor_staff_id,
      p.findings === undefined ? null : String(p.findings), p.actionTaken === undefined ? null : String(p.actionTaken));
    return { ok: true, message: `Maintenance logged for "${eq.name}".` };
  },

  // Equipment breakdown report.
  'equipment.breakdown_report': (db, s) => {
    if (!s.target_uuid) return { ok: false, message: 'No equipment specified.' };
    const eq = db.prepare('SELECT id, name FROM equipment_items WHERE uuid = ?').get(s.target_uuid) as { id: number; name: string } | undefined;
    if (!eq) return { ok: false, message: 'Equipment not found on Host.' };
    const p = s.payload ?? {};
    if (!p.description) return { ok: false, message: 'A description of the breakdown is required.' };
    db.prepare(
      `INSERT INTO equipment_breakdowns (equipment_id, breakdown_date, reported_by_staff_id, description, service_impact, immediate_action, status)
       VALUES (?, ?, ?, ?, ?, ?, 'open')`
    ).run(eq.id, new Date().toISOString().slice(0, 10), s.actor_staff_id, String(p.description),
      p.serviceImpact === undefined ? null : String(p.serviceImpact), p.immediateAction === undefined ? null : String(p.immediateAction));
    return { ok: true, message: `Breakdown reported for "${eq.name}".` };
  },

  // Leave request (approval tier): runs only when an authorized approver approves.
  // Creates the leave record as approved, attributed to the deciding approver.
  'leave.request': (db, s) => {
    const p = s.payload ?? {};
    const type = p.type === undefined ? null : String(p.type);
    const start = p.startDate === undefined ? null : String(p.startDate);
    const end = p.endDate === undefined ? null : String(p.endDate);
    const reason = p.reason === undefined ? null : String(p.reason);
    if (!start || !end) return { ok: false, message: 'Leave start and end dates are required.' };
    db.prepare(
      `INSERT INTO leave_requests (staff_id, leave_type, start_date, end_date, reason, status, approved_by_staff_id, decided_at)
       VALUES (?, ?, ?, ?, ?, 'approved', ?, CURRENT_TIMESTAMP)`
    ).run(s.actor_staff_id, type, start, end, reason, s.decided_by_staff_id ?? null);
    return { ok: true, message: `Leave approved (${start} → ${end}).` };
  },

  // Inventory request (approval tier): runs only when approved. Records the
  // request as approved; may reference an existing inventory item by uuid.
  'inventory.request': (db, s) => {
    const p = s.payload ?? {};
    let inventoryItemId: number | null = null;
    let itemName = p.itemName === undefined ? null : String(p.itemName);
    if (s.target_uuid) {
      const inv = db.prepare('SELECT id, name FROM inventory_items WHERE uuid = ?').get(s.target_uuid) as { id: number; name: string } | undefined;
      if (inv) { inventoryItemId = inv.id; if (!itemName) itemName = inv.name; }
    }
    if (!itemName) return { ok: false, message: 'An item name is required.' };
    const qty = p.quantity === undefined || p.quantity === '' ? null : Number(p.quantity);
    db.prepare(
      `INSERT INTO inventory_requests (staff_id, item_name, inventory_item_id, quantity, unit, justification, status, approved_by_staff_id, decided_at)
       VALUES (?, ?, ?, ?, ?, ?, 'approved', ?, CURRENT_TIMESTAMP)`
    ).run(s.actor_staff_id, itemName, inventoryItemId, Number.isFinite(qty as number) ? qty : null,
      p.unit === undefined ? null : String(p.unit), p.justification === undefined ? null : String(p.justification), s.decided_by_staff_id ?? null);
    return { ok: true, message: `Inventory request approved: ${itemName}${qty ? ' ×' + qty : ''}.` };
  },
};
