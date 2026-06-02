import { getDb } from '../db/database.js';
import { TECHNICAL_AUTHORIZATION_LEVELS } from '../../shared/constants/modules.js';

export type PermissionDecision = { allowed: boolean; source: string; reason: string };

const ACTIVE_ASSIGNMENT_TYPES = ['primary', 'acting', 'deputy', 'temporary'];
const TECHNICAL_ACTIONS_BY_LEVEL: Record<string, string[]> = {
  'View only': ['view'],
  Perform: ['view', 'create', 'edit', 'print'],
  Review: ['view', 'edit', 'print'],
  Verify: ['view', 'approve', 'print'],
  Approve: ['view', 'approve', 'print'],
  Supervise: ['view', 'create', 'edit', 'approve', 'export', 'print'],
  'Train others': ['view', 'create', 'edit', 'export', 'print']
};

export function resolvePermission(userId: number, moduleKey: string, action: string): PermissionDecision {
  const db = getDb();
  const module = db.prepare('SELECT enabled FROM system_modules WHERE key = ?').get(moduleKey) as { enabled: number } | undefined;
  if (!module || module.enabled !== 1) return { allowed: false, source: 'Module disabled', reason: 'The module is disabled or unavailable.' };

  const user = db.prepare('SELECT id, role_id, staff_id, is_active FROM users WHERE id = ?').get(userId) as { role_id: number; staff_id: number | null; is_active: number } | undefined;
  if (!user || user.is_active !== 1) return { allowed: false, source: 'Denied override', reason: 'Inactive or unknown user.' };

  const permission = db.prepare('SELECT id FROM permissions WHERE module_key = ? AND action = ?').get(moduleKey, action) as { id: number } | undefined;
  if (!permission) return { allowed: false, source: 'Denied override', reason: 'Permission is not defined.' };

  const override = db.prepare('SELECT allowed, source FROM user_permission_overrides WHERE user_id = ? AND permission_id = ?').get(userId, permission.id) as { allowed: number; source: string } | undefined;
  if (override) return { allowed: override.allowed === 1, source: override.source, reason: 'User-specific permission override.' };

  const rolePerm = db.prepare('SELECT allowed, source FROM role_permissions WHERE role_id = ? AND permission_id = ?').get(user.role_id, permission.id) as { allowed: number; source: string } | undefined;
  if (rolePerm?.allowed === 1) return { allowed: true, source: rolePerm.source, reason: 'Allowed by role default.' };

  if (user.staff_id) {
    const placeholders = ACTIVE_ASSIGNMENT_TYPES.map(() => '?').join(', ');
    const positionPerm = db.prepare(`
      SELECT pp.allowed, pp.source, spa.assignment_type assignmentType
      FROM staff_position_assignments spa
      JOIN position_permissions pp ON pp.position_id = spa.position_id
      WHERE spa.staff_id = ?
        AND spa.is_active = 1
        AND spa.assignment_type IN (${placeholders})
        AND (spa.ends_at IS NULL OR spa.ends_at > CURRENT_TIMESTAMP)
        AND pp.permission_id = ?
      LIMIT 1
    `).get(user.staff_id, ...ACTIVE_ASSIGNMENT_TYPES, permission.id) as { allowed: number; source: string; assignmentType: string } | undefined;
    if (positionPerm?.allowed === 1) return { allowed: true, source: 'Position default', reason: `Allowed by active ${positionPerm.assignmentType} position assignment.` };

    const technicalAuthorizations = db.prepare(`
      SELECT ta.level
      FROM technical_authorizations ta
      WHERE ta.is_active = 1
        AND ta.module_key = ?
        AND (ta.expires_at IS NULL OR ta.expires_at > CURRENT_TIMESTAMP)
        AND (
          ta.staff_id = ?
          OR ta.position_id IN (
            SELECT spa.position_id
            FROM staff_position_assignments spa
            WHERE spa.staff_id = ?
              AND spa.is_active = 1
              AND spa.assignment_type IN (${placeholders})
              AND (spa.ends_at IS NULL OR spa.ends_at > CURRENT_TIMESTAMP)
          )
        )
    `).all(moduleKey, user.staff_id, user.staff_id, ...ACTIVE_ASSIGNMENT_TYPES) as { level: string }[];
    const matchingTechnical = technicalAuthorizations.find(auth => TECHNICAL_AUTHORIZATION_LEVELS.includes(auth.level as never) && TECHNICAL_ACTIONS_BY_LEVEL[auth.level]?.includes(action));
    if (matchingTechnical) return { allowed: true, source: 'Technical authorization', reason: `Allowed by technical authorization level ${matchingTechnical.level}.` };
  }

  return { allowed: false, source: 'Denied override', reason: 'No permission source allows this action.' };
}
