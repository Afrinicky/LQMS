/**
 * Central RBAC decision point — one model, two layers.
 *
 * Every permission question in SECH_LIMS — API middleware, the effective
 * permission map the client uses to hide features, and the module filters on
 * dashboards and alert feeds — is answered here, so the server and the UI can
 * never disagree about what a user may do.
 *
 * ── Why this was rewritten ────────────────────────────────────────────────
 * Access used to be assembled from four independent sources that could all
 * disagree with one another: a role default, a position grant, a technical
 * authorization level, and a personal override. Because the first three could
 * only ever ADD, a role set to "no access" was silently re-opened by a
 * position or an authorization, and nobody looking at any single screen could
 * say what a person could actually do. That is how staff ended up seeing
 * workspaces nobody meant to give them.
 *
 * There are now exactly two layers, and they are ordered:
 *
 *   1. ACCESS PROFILE — the single cohort decision. Every user resolves to
 *      exactly one profile, so two cohorts can never contradict each other.
 *      A profile is a row in `roles`; an organogram position may be mapped to
 *      a profile (`positions.access_profile_role_id`), and when the person's
 *      active primary position carries such a mapping it is the profile that
 *      applies. Otherwise the profile on their user account applies. One
 *      decision, always.
 *
 *   2. INDIVIDUAL — a person-specific override that SUPERSEDES the profile,
 *      to allow or to deny. This is the only thing that can overrule layer 1,
 *      and it always wins.
 *
 * Technical authorizations no longer grant permissions. They remain the
 * competency record ISO 15189 asks for — who is authorised to perform, review,
 * verify or approve technical work — but a competency record silently widening
 * somebody's software rights was one of the contradictions this model removes.
 * If a person needs the rights, they are granted on their profile or as an
 * individual override, where they can be seen.
 *
 * Four invariants hold on top of the layers:
 *
 *  a. `view` is the floor. No action on an area is possible without the right
 *     to view it. A user who cannot open a record cannot print it, export it,
 *     edit it or approve it either.
 *  b. A decision recorded against a MODULE cascades to every feature inside
 *     it, allow or deny. "No access to Documents" means no access to any part
 *     of Documents.
 *  c. A module's access is the union of its features, so a module-level route
 *     guard keeps working once the module has been split up.
 *  d. A disabled module, or an inactive user, grants nothing at all.
 */
import { getDb } from '../db/database.js';
import { MODULES, PERMISSION_ACTIONS } from '../../shared/constants/modules.js';
import { FEATURES, featuresOfModule, isFeatureKey, getFeature, LEVEL_ACTIONS, levelForActions, type AccessLevel } from '../../shared/constants/features.js';

export type PermissionDecision = { allowed: boolean; source: string; reason: string };

/** Effective permissions for one user: module key → the actions they may take. */
export type PermissionMap = Record<string, string[]>;

/**
 * `view` is a prerequisite for every other action. Granting "print" without
 * "view" used to let a user print a record the system refused to show them.
 */
export const BASE_ACTION = 'view';

/** Where a decision came from, in the words the screens use. */
export const SOURCE_PROFILE = 'Access profile';
export const SOURCE_INDIVIDUAL = 'Individual override';
export const SOURCE_DERIVED = 'Derived';
export const SOURCE_NONE = 'Not granted';

type Grant = { allowed: boolean; source: string; reason: string };

/** Every key a permission may be granted on: modules and features alike. */
const ALL_PERM_KEYS: string[] = [...MODULES.map(m => m.key), ...FEATURES.map(f => f.key)];

/**
 * The one access profile that applies to a user.
 *
 * An organogram position may carry a profile mapping. When the person holds
 * such a position, that mapping is their profile — the organogram is the more
 * specific statement of what the job is. Otherwise their account's own profile
 * applies. Exactly one is returned, which is what makes contradiction
 * impossible.
 */
export function profileIdForUser(userId: number): { profileId: number | null; via: 'position' | 'account' | null; positionTitle?: string } {
  const db = getDb();
  const user = db.prepare('SELECT id, role_id, staff_id, is_active FROM users WHERE id = ?').get(userId) as
    { id: number; role_id: number; staff_id: number | null; is_active: number } | undefined;
  if (!user || user.is_active !== 1) return { profileId: null, via: null };

  // An administrator's account always wins over the organogram. Otherwise an
  // administrator whose staff record happens to hold a bench position would be
  // demoted by a position mapping — and, if they were the only administrator,
  // the laboratory would be locked out of its own access control with no way
  // back in.
  const accountIsAdministrator = (db.prepare('SELECT is_administrator AS a FROM roles WHERE id = ?')
    .get(user.role_id) as { a: number } | undefined)?.a === 1;

  if (user.staff_id && !accountIsAdministrator) {
    const mapped = db.prepare(`
      SELECT p.access_profile_role_id AS profileId, p.title AS title
      FROM staff_position_assignments spa
      JOIN positions p ON p.id = spa.position_id
      WHERE spa.staff_id = ? AND spa.is_active = 1 AND p.is_active = 1
        AND p.access_profile_role_id IS NOT NULL
      ORDER BY CASE spa.assignment_type WHEN 'primary' THEN 0 ELSE 1 END, spa.id
      LIMIT 1
    `).get(user.staff_id) as { profileId: number; title: string } | undefined;
    if (mapped?.profileId) return { profileId: mapped.profileId, via: 'position', positionTitle: mapped.title };
  }
  return { profileId: user.role_id, via: 'account' };
}

/**
 * Resolve every (key, action) pair for a user in a handful of queries.
 * Used directly for the client permission map, and by `resolvePermission` so
 * a single implementation decides both.
 */
function computeGrants(userId: number): Map<string, Grant> {
  const db = getDb();
  const grants = new Map<string, Grant>();
  const key = (permKey: string, action: string) => `${permKey}:${action}`;
  const set = (permKey: string, action: string, allowed: boolean, source: string, reason: string) => {
    grants.set(key(permKey, action), { allowed, source, reason });
  };

  const { profileId, via, positionTitle } = profileIdForUser(userId);
  if (profileId === null) return grants;

  const enabledModules = new Set(
    (db.prepare('SELECT key FROM system_modules WHERE enabled = 1').all() as { key: string }[]).map(m => m.key)
  );

  const permissions = db.prepare('SELECT id, module_key, action FROM permissions').all() as
    { id: number; module_key: string; action: string }[];
  const permById = new Map(permissions.map(p => [p.id, p]));

  // A decision written against a module applies to every feature inside it.
  // Applied for both layers so "no access to Personnel" is not undone by a
  // feature grant left behind from an earlier configuration.
  const applyRow = (permKey: string, action: string, allowed: boolean, source: string, reason: string) => {
    set(permKey, action, allowed, source, reason);
    for (const feature of featuresOfModule(permKey)) {
      set(feature.key, action, allowed, source, reason);
    }
  };

  // ── Layer 1: the access profile ───────────────────────────────────────────
  const profileVia = via === 'position'
    ? `${SOURCE_PROFILE} (via the ${positionTitle} position)`
    : SOURCE_PROFILE;
  const profileRows = db.prepare('SELECT permission_id, allowed FROM role_permissions WHERE role_id = ?')
    .all(profileId) as { permission_id: number; allowed: number }[];
  // Modules first, features second, so a specific feature decision refines the
  // module-wide one rather than being overwritten by it.
  const ordered = profileRows
    .map(r => ({ ...r, perm: permById.get(r.permission_id) }))
    .filter((r): r is typeof r & { perm: { id: number; module_key: string; action: string } } => !!r.perm)
    .sort((a, b) => Number(isFeatureKey(a.perm.module_key)) - Number(isFeatureKey(b.perm.module_key)));
  for (const row of ordered) {
    applyRow(row.perm.module_key, row.perm.action, row.allowed === 1, profileVia,
      row.allowed === 1 ? 'Allowed by the access profile.' : 'Not allowed by the access profile.');
  }

  // ── Layer 2: the individual, superseding everything above ─────────────────
  const overrides = db.prepare('SELECT permission_id, allowed, reason FROM user_permission_overrides WHERE user_id = ?')
    .all(userId) as { permission_id: number; allowed: number; reason: string | null }[];
  const orderedOverrides = overrides
    .map(r => ({ ...r, perm: permById.get(r.permission_id) }))
    .filter((r): r is typeof r & { perm: { id: number; module_key: string; action: string } } => !!r.perm)
    .sort((a, b) => Number(isFeatureKey(a.perm.module_key)) - Number(isFeatureKey(b.perm.module_key)));
  for (const row of orderedOverrides) {
    applyRow(row.perm.module_key, row.perm.action, row.allowed === 1, SOURCE_INDIVIDUAL,
      row.allowed === 1
        ? `Granted to this person individually${row.reason ? ` — ${row.reason}` : ''}.`
        : `Withdrawn from this person individually${row.reason ? ` — ${row.reason}` : ''}.`);
  }

  // ── Invariant (a): `view` is the floor for every other action ─────────────
  // Applied before the module union so a module cannot inherit, say, `export`
  // from a feature the user may not even open.
  for (const permKey of ALL_PERM_KEYS) {
    const canView = grants.get(key(permKey, BASE_ACTION))?.allowed === true;
    if (canView) continue;
    for (const action of PERMISSION_ACTIONS) {
      if (action === BASE_ACTION) continue;
      if (grants.get(key(permKey, action))?.allowed) {
        set(permKey, action, false, SOURCE_DERIVED,
          `The ${action} right needs the right to view this area. Grant "view" first.`);
      }
    }
  }

  // ── Invariant (c): a module's access is the union of its features ─────────
  // Permissions are granted on features, but 1,000+ existing route guards name
  // modules. Deriving the module from its features keeps every one of them
  // working: `personnel:view` means "can view at least one part of Personnel",
  // which is exactly the question the module gate is asking. The finer
  // question is asked with a feature key.
  //
  // A PERSONAL feature is the exception, and it matters more than it sounds.
  // Everyone manages their OWN record — `personnel.self` is granted at Manage
  // to every member of staff, because they maintain their own profile and
  // certificates. Folding that into the union made `personnel:edit` true for
  // the entire laboratory, and every gate written against the module then
  // opened: Settings → Roster & Scheduling appeared in the sidebar, and the
  // duty roster handed out Save / Publish / Approve / Delete to a Biomedical
  // Scientist who held nothing but View on rosters.
  //
  // So a personal feature contributes only what it honestly means at module
  // level: the workspace is worth showing, and its own record can be printed.
  // Changing anything in the module still needs a grant on a real area of it.
  const MODULE_ACTIONS_FROM_PERSONAL = new Set(['view', 'print']);
  for (const moduleKey of new Set(FEATURES.map(f => f.module))) {
    const features = featuresOfModule(moduleKey);
    for (const action of PERMISSION_ACTIONS) {
      const contributors = features.filter(f => !f.personal || MODULE_ACTIONS_FROM_PERSONAL.has(action));
      const allowedBy = contributors.find(f => grants.get(key(f.key, action))?.allowed === true);
      if (allowedBy) {
        set(moduleKey, action, true, SOURCE_DERIVED, `Allowed by the "${allowedBy.label}" area.`);
      } else {
        set(moduleKey, action, false, SOURCE_DERIVED, 'No area inside this module allows this action.');
      }
    }
  }

  // ── Invariant (d): disabled modules grant nothing ─────────────────────────
  const moduleOf = (permKey: string) => getFeature(permKey)?.module ?? permKey;
  for (const permKey of ALL_PERM_KEYS) {
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
  if (!user || user.is_active !== 1) return { allowed: false, source: SOURCE_NONE, reason: 'Inactive or unknown user.' };

  if (!isFeatureKey(permKey)) {
    const permission = db.prepare('SELECT id FROM permissions WHERE module_key = ? AND action = ?').get(permKey, action) as { id: number } | undefined;
    if (!permission && featuresOfModule(permKey).length === 0) {
      return { allowed: false, source: SOURCE_NONE, reason: 'Permission is not defined.' };
    }
  }

  const grant = computeGrants(userId).get(`${permKey}:${action}`);
  if (grant?.allowed) return { allowed: true, source: grant.source, reason: grant.reason };
  if (grant) return { allowed: false, source: grant.source, reason: grant.reason };
  return { allowed: false, source: SOURCE_NONE, reason: 'No permission source allows this action.' };
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
 * to decide what to render: `{ documents: ['view','print'], … }`. Areas the
 * user cannot view are omitted entirely, so "not in the map" means "must not
 * see it" on both sides of the wire.
 */
export function getEffectivePermissions(userId: number): PermissionMap {
  const grants = computeGrants(userId);
  const map: PermissionMap = {};
  for (const permKey of ALL_PERM_KEYS) {
    const actions = PERMISSION_ACTIONS.filter(a => grants.get(`${permKey}:${a}`)?.allowed === true);
    if (actions.includes(BASE_ACTION)) map[permKey] = [...actions];
  }
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

/* ==========================================================================
   Explaining a decision
   --------------------------------------------------------------------------
   The Individuals screen has to answer "why can this person do that?" in
   words an administrator can act on. Nothing else may compute access, so the
   explanation is derived from the same grant map the guards use.
   ========================================================================= */

export type AreaExplanation = {
  permKey: string;
  /** What the profile alone would give. */
  profileLevel: AccessLevel;
  /** What the individual override gives, when there is one. */
  overrideLevel: AccessLevel | null;
  /** What actually applies. */
  effectiveLevel: AccessLevel;
  actions: string[];
  source: string;
};

/** The level a set of stored rows amounts to for one area. */
function levelFromRows(rows: Map<string, boolean>, permKey: string): AccessLevel {
  const actions = PERMISSION_ACTIONS.filter(a => rows.get(`${permKey}:${a}`) === true);
  return levelForActions(actions);
}

/**
 * Per-area explanation of one user's access: profile level, personal override
 * level (or none), and the effective outcome.
 */
export function explainUserAccess(userId: number): { profileId: number | null; via: 'position' | 'account' | null; positionTitle?: string; areas: AreaExplanation[] } {
  const db = getDb();
  const { profileId, via, positionTitle } = profileIdForUser(userId);
  const permissions = db.prepare('SELECT id, module_key, action FROM permissions').all() as
    { id: number; module_key: string; action: string }[];
  const permById = new Map(permissions.map(p => [p.id, p]));

  const profileRows = new Map<string, boolean>();
  if (profileId !== null) {
    for (const r of db.prepare('SELECT permission_id, allowed FROM role_permissions WHERE role_id = ?').all(profileId) as { permission_id: number; allowed: number }[]) {
      const p = permById.get(r.permission_id);
      if (p) profileRows.set(`${p.module_key}:${p.action}`, r.allowed === 1);
    }
  }
  const overrideRows = new Map<string, boolean>();
  const overriddenKeys = new Set<string>();
  for (const r of db.prepare('SELECT permission_id, allowed FROM user_permission_overrides WHERE user_id = ?').all(userId) as { permission_id: number; allowed: number }[]) {
    const p = permById.get(r.permission_id);
    if (!p) continue;
    overrideRows.set(`${p.module_key}:${p.action}`, r.allowed === 1);
    overriddenKeys.add(p.module_key);
  }

  const effective = getEffectivePermissions(userId);
  const areas: AreaExplanation[] = ALL_PERM_KEYS.map(permKey => {
    const actions = effective[permKey] ?? [];
    return {
      permKey,
      profileLevel: levelFromRows(profileRows, permKey),
      overrideLevel: overriddenKeys.has(permKey) ? levelFromRows(overrideRows, permKey) : null,
      effectiveLevel: levelForActions(actions),
      actions,
      source: overriddenKeys.has(permKey) ? SOURCE_INDIVIDUAL : SOURCE_PROFILE,
    };
  });
  return { profileId, via, positionTitle, areas };
}

/** The action set a level implies — exported so writers and readers agree. */
export function actionsForLevel(level: AccessLevel): string[] {
  return LEVEL_ACTIONS[level] ?? [];
}
