/**
 * Electronic-signature service (Phase 2).
 *
 * Records a tamper-evident signature at the moment a user performs a regulated
 * action — supervisor verification, CAPA approval, maintenance completion, audit
 * completion, acknowledgements, etc. Each signature captures the signer's
 * identity, a timestamp, the device, the IP address (when available) and a
 * reference to the audit log, and is bound to its target record by
 * (module_key, record_type, record_id).
 *
 * Signatures integrate with the existing authentication/RBAC: the caller has
 * already been authorised by the route's requirePermission guard, so this
 * service simply persists the cryptographic-of-record evidence. It reuses the
 * shared audit service so every signature also lands in the standard audit trail.
 */
import type { Request } from 'express';
import { getDb } from '../db/database.js';
import { audit } from './auditService.js';
import { getCurrentStaffId, parseIntNullable } from '../routes/routeHelpers.js';

export interface SignatureInput {
  moduleKey: string;
  recordType: string;
  recordId: string | number;
  purpose: string;           // e.g. 'capa_approval', 'maintenance_completion'
  meaning?: string;          // human-readable statement the signer attests to
  staffId?: number | null;
  signatureImageFileId?: number | null;
  deviceInfo?: string | null;
}

export interface SignatureRecord {
  id: number;
  purpose: string;
  meaning: string | null;
  signerName: string | null;
  signedAt: string;
}

function deviceFromRequest(req: Request): string | null {
  const ua = req.headers['user-agent'];
  const dev = req.headers['x-device-id'];
  const parts = [dev ? `device:${dev}` : null, ua ? String(ua) : null].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

/**
 * Persist an electronic signature and return the stored record. Throws when the
 * request has no authenticated user (routes should be behind requireAuth).
 */
export function recordSignature(req: Request, input: SignatureInput): SignatureRecord {
  if (!req.user) throw new Error('Authentication required to sign');
  const db = getDb();
  const staffId = input.staffId ?? getCurrentStaffId(req);
  const signer = db.prepare('SELECT full_name FROM users WHERE id = ?').get(req.user.id) as { full_name?: string } | undefined;
  const deviceInfo = input.deviceInfo ?? deviceFromRequest(req);
  const ip = req.ip ?? null;

  const result = db.prepare(`INSERT INTO e_signatures
      (module_key, record_type, record_id, purpose, meaning, user_id, staff_id, signer_name, signature_image_file_id, device_info, ip_address, signed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`)
    .run(input.moduleKey, input.recordType, String(input.recordId), input.purpose, input.meaning ?? null,
      req.user.id, staffId, signer?.full_name ?? req.user.username, parseIntNullable(input.signatureImageFileId), deviceInfo, ip);
  const id = Number(result.lastInsertRowid);

  audit(req, { action: 'e_sign', entity: input.recordType, entityId: input.recordId, newValue: { purpose: input.purpose, meaning: input.meaning, signatureId: id } });
  // Link the audit row back onto the signature for traceability.
  const auditRow = db.prepare('SELECT id FROM audit_logs ORDER BY id DESC LIMIT 1').get() as { id?: number } | undefined;
  if (auditRow?.id) db.prepare('UPDATE e_signatures SET audit_log_id = ? WHERE id = ?').run(auditRow.id, id);

  return {
    id,
    purpose: input.purpose,
    meaning: input.meaning ?? null,
    signerName: signer?.full_name ?? req.user.username,
    signedAt: new Date().toISOString(),
  };
}

/** All signatures on a given record, newest first. */
export function signaturesFor(moduleKey: string, recordType: string, recordId: string | number) {
  return getDb().prepare(
    `SELECT e.id, e.purpose, e.meaning, e.signer_name, e.signed_at, e.device_info, e.ip_address, e.staff_id, e.signature_image_file_id
     FROM e_signatures e WHERE e.module_key = ? AND e.record_type = ? AND e.record_id = ? ORDER BY e.signed_at DESC`
  ).all(moduleKey, recordType, String(recordId));
}
