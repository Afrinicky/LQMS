import type { NextFunction, Request, Response } from 'express';
import { resolvePermission } from '../services/permissionResolver.js';

export function requirePermission(moduleKey: string, action: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    const decision = resolvePermission(req.user.id, moduleKey, action);
    if (!decision.allowed) return res.status(403).json({ error: 'Permission denied', decision });
    res.locals.permissionDecision = decision;
    next();
  };
}
