/**
 * Auth for the cloud read-API and portal (R1). A request is authenticated either
 * by a portal JWT (a signed-in staff member) or, for read-only back-compat, by
 * the shared CLOUD_API_TOKEN. Write/actor-bearing endpoints require a real user
 * principal (JWT), never the shared token.
 */
import { verifyPortalToken, type PortalClaims } from './jwt.js';

export interface MinimalReq {
  headers: Record<string, string | string[] | undefined>;
  query?: Record<string, string | string[] | undefined>;
}
export interface MinimalRes {
  status(code: number): MinimalRes;
  json(body: unknown): void;
  setHeader(name: string, value: string): void;
}

export type Principal =
  | { kind: 'user'; staffId: number; email: string; role: string | null; userId: number; claims: PortalClaims }
  | { kind: 'shared' };

function bearer(req: MinimalReq): string {
  const header = req.headers['authorization'];
  const headerStr = Array.isArray(header) ? header[0] : header;
  return (headerStr ?? '').replace(/^Bearer\s+/i, '');
}

/** Resolve the request principal, or null if unauthenticated. */
export function getPrincipal(req: MinimalReq): Principal | null {
  const token = bearer(req);
  const claims = token ? verifyPortalToken(token) : null;
  if (claims) {
    return { kind: 'user', staffId: claims.staffId, email: claims.email, role: claims.role, userId: Number(claims.sub), claims };
  }
  const expected = process.env.CLOUD_API_TOKEN;
  if (expected) {
    const q = req.query?.token;
    const qStr = Array.isArray(q) ? q[0] : q;
    if (token === expected || qStr === expected) return { kind: 'shared' };
  }
  return null;
}

/** Require any authenticated principal (JWT or shared token). Writes 401 otherwise. */
export function requireUser(req: MinimalReq, res: MinimalRes): Principal | null {
  const p = getPrincipal(req);
  if (!p) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }
  return p;
}

/** Require a signed-in staff member (JWT only; shared token is rejected). */
export function requireStaff(req: MinimalReq, res: MinimalRes): Extract<Principal, { kind: 'user' }> | null {
  const p = getPrincipal(req);
  if (!p || p.kind !== 'user') {
    res.status(401).json({ error: 'Sign-in required.' });
    return null;
  }
  return p;
}
