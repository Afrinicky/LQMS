import type { NextFunction, Request, Response } from 'express';
import { resolvePermission, getViewableModules, BASE_ACTION } from '../services/permissionResolver.js';

/**
 * Guard a route with one module permission. `view` is enforced as a
 * prerequisite inside the resolver, so `requirePermission('documents','print')`
 * also denies anyone who may not view documents.
 */
export function requirePermission(moduleKey: string, action: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    const decision = resolvePermission(req.user.id, moduleKey, action);
    if (!decision.allowed) return res.status(403).json({ error: 'Permission denied', decision });
    res.locals.permissionDecision = decision;
    next();
  };
}

/**
 * Guard a route whose target module is only known at request time (QR
 * resolution, signatures, cross-module lookups). `resolve` returns the module
 * key the request touches, or null when the request is malformed.
 */
export function requireResolvedPermission(
  resolve: (req: Request) => string | null | undefined,
  action: string = BASE_ACTION,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    const moduleKey = resolve(req);
    if (!moduleKey) return res.status(400).json({ error: 'The record does not belong to a known module.' });
    const decision = resolvePermission(req.user.id, moduleKey, action);
    if (!decision.allowed) return res.status(403).json({ error: 'Permission denied', decision });
    res.locals.permissionDecision = decision;
    next();
  };
}

/**
 * Attach the caller's viewable module set to `res.locals` so a handler that
 * returns data from many modules can drop the rows they may not see.
 */
export function withViewableModules(req: Request, res: Response, next: NextFunction) {
  res.locals.viewableModules = req.user ? getViewableModules(req.user.id) : new Set<string>();
  next();
}

/** The caller's viewable module set, computed on demand. */
export function viewableModulesOf(req: Request): Set<string> {
  return req.user ? getViewableModules(req.user.id) : new Set<string>();
}
