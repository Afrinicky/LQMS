import type { Request } from 'express';

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
