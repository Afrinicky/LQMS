/**
 * Remote-access policy (R2 of the Remote Staff Portal).
 *
 * Encodes the classification from docs/REMOTE_STAFF_PORTAL_PLAN.md as data both
 * the Host (authoritative enforcement) and the cloud/portal (UX) share:
 *  - REMOTE_VIEW_MODULES: which modules may be browsed remotely.
 *  - REMOTE_ACTIVITIES: the catalog of remote actions, each with the Host
 *    permission that gates it (or selfService) and its tier (auto | approval).
 *
 * Effective capability is always a SUBSET of Host permissions and is re-checked
 * on the Host; this file is policy, not enforcement.
 */

/** Modules whose records may be viewed through the portal. Excludes Settings,
 *  Blood Bank Handover and Dennis (LAN-only / sensitive). */
export const REMOTE_VIEW_MODULES: readonly string[] = [
  'home', 'dashboard', 'documents', 'organisation', 'personnel', 'actions',
  'nc_capa', 'complaints', 'risks', 'customer_focus', 'equipment', 'assessments',
  'supplier_inventory', 'continual_improvement', 'meetings', 'management_review',
  'quality_indicators', 'facilities_safety', 'monitoring', 'iqc', 'eqa',
  'verification_validation', 'measurement_uncertainty', 'poct', 'monthly_reports',
  'records_reports', 'notifications', 'process_management', 'information_management',
];

export type RemoteTier = 'auto' | 'approval';

export interface RemoteActivity {
  /** Stable activity key used by submissions (R3). */
  key: string;
  label: string;
  /** Module the activity belongs to (for grouping / scope). */
  module: string;
  /** Auto-apply after Host validation, or route for approval. */
  tier: RemoteTier;
  /** Any remote-enabled staff may do it (ownership enforced when applied). */
  selfService?: boolean;
  /** Host permission required (when not selfService). */
  requires?: { module: string; action: string };
}

export const REMOTE_ACTIVITIES: readonly RemoteActivity[] = [
  // Self-service (no module CRUD permission; record ownership enforced on apply)
  { key: 'profile.update', label: 'Update own profile', module: 'personnel', tier: 'auto', selfService: true },
  { key: 'sop.acknowledge', label: 'Acknowledge an SOP/document', module: 'documents', tier: 'auto', selfService: true },
  { key: 'training.log', label: 'Log training attendance', module: 'personnel', tier: 'auto', selfService: true },
  { key: 'task.update', label: 'Update an assigned task/action', module: 'actions', tier: 'auto', selfService: true },
  { key: 'notification.acknowledge', label: 'Acknowledge a notification', module: 'notifications', tier: 'auto', selfService: true },
  { key: 'leave.request', label: 'Request leave', module: 'personnel', tier: 'approval', selfService: true },
  { key: 'inventory.request', label: 'Request inventory/stock', module: 'supplier_inventory', tier: 'approval', selfService: true },
  // Permission-gated (require the corresponding Host permission)
  { key: 'incident.report', label: 'Report a safety incident', module: 'facilities_safety', tier: 'auto', requires: { module: 'facilities_safety', action: 'create' } },
  { key: 'nc.report', label: 'Report a nonconformity', module: 'nc_capa', tier: 'auto', requires: { module: 'nc_capa', action: 'create' } },
  { key: 'capa.update', label: 'Post a CAPA progress update', module: 'nc_capa', tier: 'auto', requires: { module: 'nc_capa', action: 'edit' } },
  { key: 'env.reading', label: 'Record an environmental reading', module: 'monitoring', tier: 'auto', requires: { module: 'monitoring', action: 'create' } },
  { key: 'equipment.maintenance_log', label: 'Log equipment maintenance', module: 'equipment', tier: 'auto', requires: { module: 'equipment', action: 'create' } },
  { key: 'equipment.breakdown_report', label: 'Report an equipment breakdown', module: 'equipment', tier: 'auto', requires: { module: 'equipment', action: 'create' } },
  { key: 'poct.qc_entry', label: 'Enter POCT QC / incident', module: 'poct', tier: 'auto', requires: { module: 'poct', action: 'create' } },
];

export function findActivity(key: string): RemoteActivity | undefined {
  return REMOTE_ACTIVITIES.find((a) => a.key === key);
}

/** Snapshot shape stored in cloud_users.remote_scope and returned to the portal. */
export interface RemoteCapabilities {
  remoteEnabled: boolean;
  viewModules: string[];
  activities: Array<{ key: string; label: string; tier: RemoteTier; allowed: boolean }>;
  /** Approval-tier activities this staff member may approve (has 'approve' on the module). */
  approvals: Array<{ key: string; label: string; allowed: boolean }>;
  computedAt: string;
}
