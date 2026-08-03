/**
 * Portal JWT signing/verification for the Remote Staff Portal (R1). Short-lived
 * HS256 tokens carry the authenticated staff's identity and (later) remote scope.
 * The signing secret (CLOUD_JWT_SECRET) is set in the Vercel project only.
 */
import jwt from 'jsonwebtoken';

const EXPIRES_IN = '60m';

export interface PortalClaims {
  sub: string;          // cloud_users.id
  staffId: number;      // Host staff id
  email: string;
  role: string | null;
  scope?: unknown;      // remote_scope snapshot (reserved for R2)
}

export function signPortalToken(claims: PortalClaims): string {
  const secret = process.env.CLOUD_JWT_SECRET;
  if (!secret) throw new Error('CLOUD_JWT_SECRET is not set');
  return jwt.sign(claims, secret, { expiresIn: EXPIRES_IN });
}

export function verifyPortalToken(token: string): PortalClaims | null {
  const secret = process.env.CLOUD_JWT_SECRET;
  if (!secret || !token) return null;
  try {
    return jwt.verify(token, secret) as PortalClaims;
  } catch {
    return null;
  }
}
