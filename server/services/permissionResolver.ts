import { getDb } from '../db/database.js';
import { TECHNICAL_AUTHORIZATION_LEVELS } from '../../shared/constants/modules.js';

export type PermissionDecision = { allowed: boolean; source: string; reason: string };

export function resolvePermission(userId: number, moduleKey: string, action: string): PermissionDecision {
  const db = getDb();
  const module = db.prepare('SELECT enabled FROM system_modules WHERE key = ?').get(moduleKey) as { enabled: number } | undefined;
  if (!module || module.enabled !== 1) return { allowed: false, source: 'Module disabled', reason: 'The module is disabled or unavailable.' };
  
  const user = db.prepare('SELECT id, role_id, staff_id, is_active FROM users WHERE id = ?').get(userId) as { role_id: number; staff_id: number | null; is_active: number } | undefined;
  if (!user || user.is_active !== 1) return { allowed: false, source: 'Denied override', reason: 'Inactive or unknown user.' };
  
  const permission = db.prepare('SELECT id FROM permissions WHERE module_key = ? AND action = ?').get(moduleKey, action) as { id: number } | undefined;
  if (!permission) return { allowed: false, source: 'Denied override', reason: 'Permission is not defined.' };
  
  // Check user-specific override
  const override = db.prepare('SELECT allowed, source FROM user_permission_overrides WHERE user_id = ? AND permission_id = ?').get(userId, permission.id) as { allowed: number; source: string } | undefined;
  if (override) return { allowed: override.allowed === 1, source: override.source, reason: 'User-specific permission override.' };
  
  // Check role permission
  const rolePerm = db.prepare('SELECT allowed, source FROM role_permissions WHERE role_id = ? AND permission_id = ?').get(user.role_id, permission.id) as { allowed: number; source: string } | undefined;
  if (rolePerm?.allowed === 1) return { allowed: true, source: rolePerm.source, reason: 'Allowed by role default.' };
  
  // Check position permissions (only if staff_id is set)
  if (user.staff_id) {
    const positionPerm = db.prepare(`
      SELECT pp.allowed, pp.source FROM staff_position_assignments spa 
      JOIN position_permissions pp ON pp.position_id = spa.position_id 
      WHERE spa.staff_id = ? AND spa.is_active = 1 AND pp.permission_id = ? 
      LIMIT 1
    `).get(user.staff_id, permission.id) as { allowed: number; source: string } | undefined;
    if (positionPerm?.allowed === 1) return { allowed: true, source: positionPerm.source, reason: 'Allowed by active position assignment.' };
  }
  
  // Check technical authorizations (only if staff_id is set)
  if (user.staff_id && ['view', 'approve'].includes(action)) {
    const tech = db.prepare(`
      SELECT ta.level FROM technical_authorizations ta
      WHERE ta.is_active = 1 AND ta.module_key = ? 
      AND (
        ta.staff_id = ? 
        OR ta.position_id IN (
          SELECT position_id FROM staff_position_assignments 
          WHERE staff_id = ? AND is_active = 1
        )
      )
      LIMIT 1
    `).get(moduleKey, user.staff_id, user.staff_id) as { level: string } | undefined;
    
    if (tech && TECHNICAL_AUTHORIZATION_LEVELS.includes(tech.level as never)) {
      return { allowed: true, source: 'Technical authorization', reason: `Allowed by technical authorization level ${tech.level}.` };
    }
  }
  
  return { allowed: false, source: 'Denied override', reason: 'No permission source allows this action.' };
}
