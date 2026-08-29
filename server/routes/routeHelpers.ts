import type { Request, Response } from 'express';

import { hasSignatureOnFile, NO_SIGNATURE_MESSAGE } from '../services/signatureService.js';

export function parseIntNullable(value: unknown) {
  // Treat null/undefined/empty-string as "no value" so an unselected dropdown
  // does not become 0 (which then fails foreign-key checks against real ids).
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

export function getCurrentStaffId(req: Request) {
  return parseIntNullable(req.user?.staffId);
}

export function getStaffIdOrCurrent(req: Request, value: unknown) {
  const parsed = parseIntNullable(value);
  if (parsed !== null) return parsed;
  return getCurrentStaffId(req);
}

export function requireCurrentStaffId(req: Request) {
  const staffId = getCurrentStaffId(req);
  if (staffId === null) {
    throw new Error('This action requires the logged-in user to be linked to a staff record.');
  }
  return staffId;
}


/**
 * Refuse the request when the caller has no signature on file.
 *
 * Every signature already goes through recordSignature, which throws — but a
 * route that writes its record BEFORE signing would leave that record behind,
 * saved and unsigned. So those routes ask first. Returns true when the caller
 * may sign; when it returns false the response has already been sent.
 */
export function blockedForNoSignature(req: Request, res: Response): boolean {
  if (hasSignatureOnFile(getCurrentStaffId(req))) return false;
  res.status(400).json({ error: NO_SIGNATURE_MESSAGE, code: 'signature_required' });
  return true;
}
