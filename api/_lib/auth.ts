/**
 * Shared-token gate for the cloud read-API. A single access token
 * (CLOUD_API_TOKEN) protects the read endpoints; the portal supplies it as a
 * Bearer header. Fails closed — if no token is configured, all access is denied.
 *
 * This is deliberately simple for a read-only portal. Per-user auth against the
 * cloud is a future enhancement; today the Host remains the system of record with
 * full role-based access control.
 */
export interface MinimalReq {
  headers: Record<string, string | string[] | undefined>;
  query?: Record<string, string | string[] | undefined>;
}
export interface MinimalRes {
  status(code: number): MinimalRes;
  json(body: unknown): void;
  setHeader(name: string, value: string): void;
}

/** Returns true if the request carries the correct token; otherwise writes 401/503 and returns false. */
export function requireToken(req: MinimalReq, res: MinimalRes): boolean {
  const expected = process.env.CLOUD_API_TOKEN;
  if (!expected) {
    res.status(503).json({ error: 'Cloud portal is not configured (CLOUD_API_TOKEN unset).' });
    return false;
  }
  const header = req.headers['authorization'];
  const headerStr = Array.isArray(header) ? header[0] : header;
  const bearer = (headerStr ?? '').replace(/^Bearer\s+/i, '');
  const q = req.query?.token;
  const qStr = Array.isArray(q) ? q[0] : q;
  if (bearer === expected || qStr === expected) return true;
  res.status(401).json({ error: 'Unauthorized' });
  return false;
}
