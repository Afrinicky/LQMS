import type { NextFunction, Request, Response } from 'express';
import { getDb } from '../db/database.js';

declare global {
  namespace Express {
    interface Request { user?: { id: number; username: string; roleId: number; staffId?: number | null } }
  }
}

export function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (token) {
    const session = getDb().prepare(`SELECT u.id, u.username, u.role_id, u.staff_id FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.revoked_at IS NULL AND s.expires_at > CURRENT_TIMESTAMP AND u.is_active = 1`).get(token) as { id: number; username: string; role_id: number; staff_id: number | null } | undefined;
    if (session) req.user = { id: session.id, username: session.username, roleId: session.role_id, staffId: session.staff_id };
  }
  next();
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  next();
}
