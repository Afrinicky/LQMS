/**
 * Remote capability engine (R2) — authoritative on the Host.
 *
 * Computes what a staff member may do remotely, as a SUBSET of their Host
 * permissions. Effective capability =
 *   staff.remote_enabled
 *   AND (module in REMOTE_VIEW_MODULES)                      (for viewing)
 *   AND (activity.selfService OR resolvePermission(requires)) (for activities)
 *   AND (staff.remote_scope allows the module, if a scope is set)
 * Record-level scope (own vs others, section) is enforced when a submission is
 * applied (R3), not here.
 */
import { getDb } from '../db/database.js';
import { resolvePermission } from './permissionResolver.js';
import {
  REMOTE_VIEW_MODULES, REMOTE_ACTIVITIES, findActivity, type RemoteCapabilities,
} from '../../shared/constants/remoteAccess.js';

interface StaffRow { id: number; remote_enabled: number; remote_scope: string | null; }

/** The active Host user linked to a staff member (for permission resolution). */
export function findUserIdForStaff(staffId: number): number | null {
  const row = getDb().prepare('SELECT id FROM users WHERE staff_id = ? AND is_active = 1 ORDER BY id LIMIT 1').get(staffId) as { id: number } | undefined;
  return row?.id ?? null;
}

function scopeAllows(scope: string[] | null, moduleKey: string): boolean {
  return scope === null || scope.includes(moduleKey);
}

function parseScope(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String) : null;
  } catch {
    return null;
  }
}

/** Compute the full remote capability snapshot for a staff member. */
export function computeRemoteCapabilities(staffId: number): RemoteCapabilities {
  const db = getDb();
  const staff = db.prepare('SELECT id, remote_enabled, remote_scope FROM staff WHERE id = ?').get(staffId) as StaffRow | undefined;
  const remoteEnabled = !!staff && staff.remote_enabled === 1;
  const scope = parseScope(staff?.remote_scope ?? null);
  const userId = findUserIdForStaff(staffId);

  const viewModules: string[] = [];
  const activities: RemoteCapabilities['activities'] = [];
  const approvals: RemoteCapabilities['approvals'] = [];

  if (remoteEnabled && userId) {
    for (const moduleKey of REMOTE_VIEW_MODULES) {
      if (scopeAllows(scope, moduleKey) && resolvePermission(userId, moduleKey, 'view').allowed) {
        viewModules.push(moduleKey);
      }
    }
    for (const act of REMOTE_ACTIVITIES) {
      const inScope = scopeAllows(scope, act.module);
      const permitted = act.selfService
        ? true
        : !!act.requires && resolvePermission(userId, act.requires.module, act.requires.action).allowed;
      activities.push({ key: act.key, label: act.label, tier: act.tier, allowed: remoteEnabled && inScope && permitted });
      // Approval-tier activities: can this staff member approve them?
      if (act.tier === 'approval') {
        approvals.push({ key: act.key, label: act.label, allowed: resolvePermission(userId, act.module, 'approve').allowed });
      }
    }
  } else {
    for (const act of REMOTE_ACTIVITIES) {
      activities.push({ key: act.key, label: act.label, tier: act.tier, allowed: false });
      if (act.tier === 'approval') approvals.push({ key: act.key, label: act.label, allowed: false });
    }
  }

  return { remoteEnabled, viewModules, activities, approvals, computedAt: new Date().toISOString() };
}

/** Authoritative single-activity check used by the write path (R3). */
export function canRemoteActivity(staffId: number, activityKey: string): boolean {
  const caps = computeRemoteCapabilities(staffId);
  return caps.activities.some((a) => a.key === activityKey && a.allowed);
}

/** Authoritative approval check used by the approval path (R4): the approver must
 *  be remote-enabled and hold the 'approve' permission on the activity's module. */
export function canApproveActivity(approverStaffId: number, activityKey: string): boolean {
  const act = findActivity(activityKey);
  if (!act || act.tier !== 'approval') return false;
  const staff = getDb().prepare('SELECT remote_enabled FROM staff WHERE id = ?').get(approverStaffId) as { remote_enabled: number } | undefined;
  if (!staff || staff.remote_enabled !== 1) return false;
  const userId = findUserIdForStaff(approverStaffId);
  if (!userId) return false;
  return resolvePermission(userId, act.module, 'approve').allowed;
}

/** Set the per-staff remote-access flag on the Host. */
export function setStaffRemoteEnabled(staffId: number, enabled: boolean): void {
  getDb().prepare('UPDATE staff SET remote_enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(enabled ? 1 : 0, staffId);
}
