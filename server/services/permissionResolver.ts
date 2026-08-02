/**
 * Central RBAC decision point.
 *
 * Every permission question in SECH_LIMS — API middleware, the effective
 * permission map the client uses to hide features, and the module filters on
 * dashboards and alert feeds — is answered here, so the server and the UI can
 * never disagree about what a user may do.
 *
 * Three rules make the model safe:
 *
 *  1. `view` is the floor. No action on a module is possible without the right
 *     to view that module. A user who cannot open a record cannot print it,
 *     export it, edit it or approve it either.
 *  2. A technical authorization grants only the actions its level actually
 *     implies. "View only" no longer confers approval rights.
 *  3. An expired or inactive authorization grants nothing.
 */
import { getDb } from '../db/database.js';
import { MODULES, PERMISSION_ACTIONS } from '../../shared/constants/modules.js';
import { FEATURES, featuresOfModule, isFeatureKey, getFeature } from '../../shared/constants/features.js';

export type PermissionDecision = { allowed: boolean; source: string; reason: string };

/** Effective permissions for one user: module key → the actions they may take. */
export type PermissionMap = Record<string, string[]>;

/**
 * `view` is a prerequisite for every other action. Granting "print" without
 * "view" used to let a user print a record the system refused to show them.
 */
export const BASE_ACTION = 'view';

/**
 * What each technical-authorization level is actually authorised to do.
 * Levels are competency statements, so they widen gradually and only the
 * supervisory levels carry approval or archiving rights.
 */
const TECHNICAL_LEVEL_ACTIONS: Record<string, string[]> = {
  'View only': ['view'],
  'Perform': ['view', 'create', 'print'],
  'Review': ['view', 'create', 'edit', 'print'],
  'Verify': ['view', 'create', 'edit', 'print', 'export'],
  'Approve': ['view', 'create', 'edit', 'print', 'export', 'approve'],
  'Supervise': ['view', 'create', 'edit', 'void_archive', 'print', 'export', 'approve'],
  'Train others': ['view', 'print'],
};

type Grant = { allowed: boolean; source: string; reason: string };

/**
 * Resolve every (module, action) pair for a user in a handful of queries.
 * Used directly for the client permission map, and by `resolvePermission` so
 * a single implementation decides both.
 */
function computeGrants(userId: number): Map<string, Grant> {
  const db = getDb();
  const grants = new Map<string, Grant>();
  const key = (moduleKey: string, action: string) => `${moduleKey}:${action}`;

  const user = db.prepare('SELECT id, role_id, staff_id, is_active FROM users WHERE id = ?').get(userId) as
    { id: number; role_id: number; staff_id: number | null; is_active: number } | undefined;
  if (!user || user.is_active !== 1) return grants;

  const enabledModules = new Set(
    (db.prepare('SELECT key FROM system_modules WHERE enabled = 1').all() as { key: string }[]).map(m => m.key)
  );

  const permissions = db.prepare('SELECT id, module_key, action FROM permissions').all() as
    { id: number; module_key: string; action: string }[];
  const permById = new Map(permissions.map(p => [p.id, p]));

  const set = (moduleKey: string, action: string, allowed: boolean, source: string, reason: string) => {
    grants.set(key(moduleKey, action), { allowed, source, reason });
  };

  // ── Layer 1: role defaults ────────────────────────────────────────────────
  const rolePerms = db.prepare('SELECT permission_id, allowed, source FROM role_permissions WHERE role_id = ?')
    .all(user.role_id) as { permission_id: number; allowed: number; source: string }[];
  for (const rp of rolePerms) {
    const p = permById.get(rp.permission_id);
    if (!p || rp.allowed !== 1) continue;
    set(p.module_key, p.action, true, rp.source || 'Role default', 'Allowed by role default.');
  }

  if (user.staff_id) {
    // ── Layer 2: permissions attached to an active position assignment ──────
    const positionPerms = db.prepare(`
      SELECT pp.permission_id, pp.allowed, pp.source
      FROM staff_position_assignments spa
      JOIN position_permissions pp ON pp.position_id = spa.position_id
      WHERE spa.staff_id = ? AND spa.is_active = 1
    `).all(user.staff_id) as { permission_id: number; allowed: number; source: string }[];
    for (const pp of positionPerms) {
      const p = permById.get(pp.permission_id);
      if (!p || pp.allowed !== 1) continue;
      set(p.module_key, p.action, true, pp.source || 'Position default', 'Allowed by active position assignment.');
    }

    // ── Layer 3: technical authorizations, limited to the level's actions ────
    // Inactive and expired authorizations are ignored entirely.
    const techAuths = db.prepare(`
      SELECT ta.module_key, ta.level
      FROM technical_authorizations ta
      WHERE ta.is_active = 1
        AND (ta.expires_at IS NULL OR ta.expires_at = '' OR date(ta.expires_at) >= date('now'))
        AND (
          ta.staff_id = ?
          OR ta.position_id IN (SELECT position_id FROM staff_position_assignments WHERE staff_id = ? AND is_active = 1)
        )
    `).all(user.staff_id, user.staff_id) as { module_key: string; level: string }[];
    for (const ta of techAuths) {
      for (const action of TECHNICAL_LEVEL_ACTIONS[ta.level] ?? []) {
        set(ta.module_key, action, true, 'Technical authorization', `Allowed by technical authorization level ${ta.level}.`);
      }
    }
  }

  // ── Layer 4: user-specific overrides win over everything above ────────────
  const overrides = db.prepare('SELECT permission_id, allowed, source FROM user_permission_overrides WHERE user_id = ?')
    .all(userId) as { permission_id: number; allowed: number; source: string }[];
  for (const o of overrides) {
    const p = permById.get(o.permission_id);
    if (!p) continue;
    set(p.module_key, p.action, o.allowed === 1, o.source || 'Manual override', 'User-specific permission override.');
  }

  // ── Rule 1: `view` is the floor for every other action ────────────────────
  // Applied last so it also overrides grants made by any layer above.
  const keysSeen = new Set(permissions.map(p => p.module_key));
  for (const permKey of keysSeen) {
    const canView = grants.get(key(permKey, BASE_ACTION))?.allowed === true;
    for (const action of PERMISSION_ACTIONS) {
      if (action === BASE_ACTION) continue;
      const g = grants.get(key(permKey, action));
      if (g?.allowed && !canView) {
        set(permKey, action, false, 'Denied override',
          `The ${action} right needs the right to view this area. Grant "view" first.`);
      }
    }
  }

  // ── Rule 2: a module's access is the union of its features ───────────────
  // Permissions are granted on features, but 1,000+ existing route guards name
  // modules. Deriving the module from its features keeps every one of them
  // working: `personnel:view` now means "can view at least one part of
  // Personnel", which is exactly the question the module gate is asking — is
  // this workspace worth showing at all. The finer question is asked with a
  // feature key.
  for (const moduleKey of new Set(FEATURES.map(f => f.module))) {
    const features = featuresOfModule(moduleKey);
    for (const action of PERMISSION_ACTIONS) {
      const allowedBy = features.find(f => grants.get(key(f.key, action))?.allowed === true);
      if (allowedBy) {
        set(moduleKey, action, true, 'Feature grant', `Allowed by the "${allowedBy.label}" feature.`);
      } else {
        set(moduleKey, action, false, 'Denied override', 'No feature inside this module allows this action.');
      }
    }
  }

  // ── Disabled modules grant nothing, whatever the layers above said ────────
  const moduleOf = (permKey: string) => getFeature(permKey)?.module ?? permKey;
  for (const permKey of new Set([...keysSeen, ...FEATURES.map(f => f.key)])) {
    if (enabledModules.has(moduleOf(permKey))) continue;
    for (const action of PERMISSION_ACTIONS) {
      set(permKey, action, false, 'Module disabled', 'The module is disabled or unavailable.');
    }
  }

  return grants;
}

/**
 * Decide a single question for a user. `permKey` is either a module key
 * (`personnel`) or a feature key (`personnel.appraisals`).
 */
export function resolvePermission(userId: number, permKey: string, action: string): PermissionDecision {
  const db = getDb();
  const moduleKey = getFeature(permKey)?.module ?? permKey;
  const module = db.prepare('SELECT enabled FROM system_modules WHERE key = ?').get(moduleKey) as { enabled: number } | undefined;
  if (!module || module.enabled !== 1) return { allowed: false, source: 'Module disabled', reason: 'The module is disabled or unavailable.' };

  const user = db.prepare('SELECT is_active FROM users WHERE id = ?').get(userId) as { is_active: number } | undefined;
  if (!user || user.is_active !== 1) return { allowed: false, source: 'Denied override', reason: 'Inactive or unknown user.' };

  if (!isFeatureKey(permKey)) {
    const permission = db.prepare('SELECT id FROM permissions WHERE module_key = ? AND action = ?').get(permKey, action) as { id: number } | undefined;
    if (!permission && featuresOfModule(permKey).length === 0) {
      return { allowed: false, source: 'Denied override', reason: 'Permission is not defined.' };
    }
  }

  const grant = computeGrants(userId).get(`${permKey}:${action}`);
  if (grant?.allowed) return { allowed: true, source: grant.source, reason: grant.reason };
  if (grant) return { allowed: false, source: grant.source, reason: grant.reason };
  return { allowed: false, source: 'Denied override', reason: 'No permission source allows this action.' };
}

/**
 * Whether a user reaches a record in a *personal* feature.
 *
 * Personal features hold a person's own data — their profile, declarations,
 * training, appraisals, occupational health. Everyone reaches their own record
 * unconditionally; reaching someone else's takes the granted level. This is
 * what makes "edit your own details, never open anyone else's" expressible.
 *
 * `ownerStaffId` is the staff record the row belongs to; pass null for a
 * listing, which then answers "may this user see other people's rows here".
 */
export function canReachPersonalRecord(
  userId: number,
  featureKey: string,
  action: string,
  ownerStaffId: number | null,
  callerStaffId: number | null,
): boolean {
  const feature = getFeature(featureKey);
  if (feature?.personal && ownerStaffId != null && callerStaffId != null && Number(ownerStaffId) === Number(callerStaffId)) {
    // Your own record. Viewing and printing it is always yours; changing it
    // still needs a grant, so a laboratory can keep appraisals read-only to
    // the person they are about.
    if (action === BASE_ACTION || action === 'print') return true;
  }
  return resolvePermission(userId, featureKey, action).allowed;
}

/**
 * The full effective permission map for a user, in the shape the client needs
 * to decide what to render: `{ documents: ['view','print'], … }`. Modules the
 * user cannot view are omitted entirely, so "not in the map" means "must not
 * see it" on both sides of the wire.
 */
export function getEffectivePermissions(userId: number): PermissionMap {
  const grants = computeGrants(userId);
  const map: PermissionMap = {};
  const add = (permKey: string) => {
    const actions = PERMISSION_ACTIONS.filter(a => grants.get(`${permKey}:${a}`)?.allowed === true);
    if (actions.includes(BASE_ACTION)) map[permKey] = [...actions];
  };
  for (const module of MODULES) add(module.key);
  // Features travel in the same map, keyed `module.feature`, so the client
  // hides a tab with the same call it uses to hide a module.
  for (const feature of FEATURES) add(feature.key);
  return map;
}

/** Module keys a user may view — the basis for every "hide it" decision. */
export function getViewableModules(userId: number): Set<string> {
  return new Set(Object.keys(getEffectivePermissions(userId)));
}

/** Convenience predicate used by route handlers that filter mixed-module data. */
export function canViewModule(userId: number, moduleKey: string): boolean {
  return resolvePermission(userId, moduleKey, BASE_ACTION).allowed;
}
