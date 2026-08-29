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
import fs from 'fs';
import path from 'path';
import type { Request } from 'express';
import { getDb, evidenceRoot, uploadRoot } from '../db/database.js';
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

/** What to tell somebody who tried to sign without a signature on file. */
export const NO_SIGNATURE_MESSAGE =
  'You have no signature on file, so you cannot sign this. Add one under My Portal \u2192 My Record \u2192 Replace signature '
  + '(or ask Personnel Management to upload it for you), then sign again.';

/**
 * Refusal to sign for want of a signature. A named class so a route can tell it
 * apart from a genuine failure and answer 400 with the remedy rather than 500.
 */
export class SignatureRequiredError extends Error {
  readonly code = 'signature_required';
  constructor(message: string = NO_SIGNATURE_MESSAGE) { super(message); this.name = 'SignatureRequiredError'; }
}

function deviceFromRequest(req: Request): string | null {
  const ua = req.headers['user-agent'];
  const dev = req.headers['x-device-id'];
  const parts = [dev ? `device:${dev}` : null, ua ? String(ua) : null].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

/**
 * Persist an electronic signature and return the stored record. Throws when the
 * request has no authenticated user (routes should be behind requireAuth), and
 * when the signer has no signature on file.
 *
 * THAT SECOND RULE IS THE POINT OF SIGNING. A record that carries a typed name
 * and nothing else is what an assessor challenges first, and it is what this
 * laboratory has had to defend on paper for years. Nobody signs anything here
 * until their own signature is set up — so the check lives at the one place
 * every signature in the system passes through, rather than in each of the
 * screens that happen to remember it.
 */
export function recordSignature(req: Request, input: SignatureInput): SignatureRecord {
  if (!req.user) throw new Error('Authentication required to sign');
  const db = getDb();
  const staffId = input.staffId ?? getCurrentStaffId(req);
  const signer = db.prepare('SELECT full_name FROM users WHERE id = ?').get(req.user.id) as { full_name?: string } | undefined;
  const deviceInfo = input.deviceInfo ?? deviceFromRequest(req);
  const ip = req.ip ?? null;

  // Signature image: prefer an explicit one, otherwise fall back to the signer's
  // signature on file (uploaded once, reused for every signing).
  let signatureFileId = parseIntNullable(input.signatureImageFileId);
  if (!signatureFileId && staffId) {
    const onFile = db.prepare('SELECT signature_file_id FROM staff WHERE id = ?').get(staffId) as { signature_file_id?: number | null } | undefined;
    signatureFileId = onFile?.signature_file_id ?? null;
  }
  if (!signatureFileId) throw new SignatureRequiredError();

  const result = db.prepare(`INSERT INTO e_signatures
      (module_key, record_type, record_id, purpose, meaning, user_id, staff_id, signer_name, signature_image_file_id, device_info, ip_address, signed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`)
    .run(input.moduleKey, input.recordType, String(input.recordId), input.purpose, input.meaning ?? null,
      req.user.id, staffId, signer?.full_name ?? req.user.username, signatureFileId, deviceInfo, ip);
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


/* ============================================================================
   Signature images
   ----------------------------------------------------------------------------
   A printed record carries the signature itself, not the signer's name typed in
   a box. Printed sheets are opened in a new window and cannot send an auth
   header, so the image is inlined as a data URI rather than linked.
   ========================================================================= */

/** One stored file as a data URI, or null when it is not on disk. */
export function fileDataUri(fileId: number | null | undefined): string | null {
  if (!fileId) return null;
  const file = getDb().prepare('SELECT stored_name, mime_type, storage_area FROM files WHERE id = ?')
    .get(fileId) as { stored_name?: string; mime_type?: string; storage_area?: string } | undefined;
  if (!file?.stored_name) return null;
  const root = file.storage_area === 'evidence' ? evidenceRoot : uploadRoot;
  try {
    const bytes = fs.readFileSync(path.join(root, file.stored_name));
    return `data:${file.mime_type || 'image/png'};base64,${bytes.toString('base64')}`;
  } catch { return null; }
}

/** The signature a member of staff has on file, as a data URI. */
export function staffSignatureDataUri(staffId: number | null | undefined): string | null {
  if (!staffId) return null;
  const staff = getDb().prepare('SELECT signature_file_id FROM staff WHERE id = ?')
    .get(staffId) as { signature_file_id?: number | null } | undefined;
  return fileDataUri(staff?.signature_file_id ?? null);
}

/**
 * The image captured with a particular signing, as a data URI.
 *
 * Prefer this over the signer's current signature on a record that has already
 * been signed: the signature stored WITH the signature row is the one that was
 * actually applied, and it must not change if the person later replaces the
 * signature on their profile.
 */
export function signatureImageDataUri(signature: { signature_image_file_id?: number | null; staff_id?: number | null } | null | undefined): string | null {
  if (!signature) return null;
  return fileDataUri(signature.signature_image_file_id ?? null) ?? staffSignatureDataUri(signature.staff_id ?? null);
}

/**
 * Has this person a signature on file?
 *
 * Nothing in this system may be signed without one. A name typed into an audit
 * row is not a signature, and a verified record that shows only a name is
 * exactly what an assessor challenges — so the check belongs at the point of
 * signing rather than in the printout.
 */
export function hasSignatureOnFile(staffId: number | null | undefined): boolean {
  if (!staffId) return false;
  const staff = getDb().prepare('SELECT signature_file_id FROM staff WHERE id = ?')
    .get(staffId) as { signature_file_id?: number | null } | undefined;
  return Boolean(staff?.signature_file_id);
}
