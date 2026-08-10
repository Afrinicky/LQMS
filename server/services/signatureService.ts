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
import crypto from 'node:crypto';
import type { Request } from 'express';
import { getDb } from '../db/database.js';
import { audit } from './auditService.js';
import { verifyPassword } from './credentialService.js';
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
  /** The signer's password, re-entered at the moment of signing. */
  password?: string | null;
}

/** Raised when signing is refused. The route turns it into a 400/401. */
export class SignatureRefused extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

/**
 * A digest of the record as it stood when it was signed.
 *
 * Without this a signature says only "somebody approved something called
 * document 41 on Tuesday". With it, the system can tell an assessor whether the
 * thing on screen today is the thing that was approved (validation finding
 * VF-13). Column order is fixed by the SELECT, and volatile bookkeeping columns
 * are dropped so that touching `updated_at` does not look like tampering.
 */
const VOLATILE = new Set(['updated_at', 'last_seen_at', 'synced_at', 'sync_version', 'deleted_at']);

export function contentHashOf(recordType: string, recordId: string | number): string | null {
  const db = getDb();
  // Only tables that actually exist; a record type naming a view or a table
  // from a future build must not stop somebody signing.
  const known = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(recordType) as { name?: string } | undefined;
  if (!known?.name) return null;
  try {
    const row = db.prepare(`SELECT * FROM "${recordType}" WHERE id = ?`).get(recordId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const canonical = Object.keys(row).sort()
      .filter(key => !VOLATILE.has(key))
      .map(key => [key, row[key] === null || row[key] === undefined ? null : String(row[key])]);
    return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  } catch {
    return null;
  }
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
  if (!req.user) throw new SignatureRefused('Authentication required to sign', 401);
  const db = getDb();

  // 21 CFR 11.200(a)(1)(ii): a signing inside a continuous session re-enters at
  // least one signature component. Until this was added, holding a signed-in
  // session was the whole of what it took to sign in somebody else's name
  // (validation finding VF-04).
  if (!input.password) {
    throw new SignatureRefused('Re-enter your password to sign. A signature has to be yours at the moment you give it.');
  }
  if (!verifyPassword(req.user.id, input.password)) {
    audit(req, {
      action: 'e_sign_refused', entity: input.recordType, entityId: input.recordId,
      newValue: { purpose: input.purpose, reason: 'password re-entry failed' },
    });
    throw new SignatureRefused('That password is not correct, so nothing was signed.', 401);
  }

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

  const contentHash = contentHashOf(input.recordType, input.recordId);

  const result = db.prepare(`INSERT INTO e_signatures
      (module_key, record_type, record_id, purpose, meaning, user_id, staff_id, signer_name, signature_image_file_id, device_info, ip_address, content_hash, reauthenticated, signed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)`)
    .run(input.moduleKey, input.recordType, String(input.recordId), input.purpose, input.meaning ?? null,
      req.user.id, staffId, signer?.full_name ?? req.user.username, signatureFileId, deviceInfo, ip, contentHash);
  const id = Number(result.lastInsertRowid);

  // audit() returns the id of the row it wrote. It used to be found again with
  // "the newest row in the table", which attached the wrong entry to a
  // signature whenever anything else was audited in the same instant (VF-14).
  const auditLogId = audit(req, {
    action: 'e_sign', entity: input.recordType, entityId: input.recordId,
    newValue: { purpose: input.purpose, meaning: input.meaning, signatureId: id, contentHash },
  });
  db.prepare('UPDATE e_signatures SET audit_log_id = ? WHERE id = ?').run(auditLogId, id);

  return {
    id,
    purpose: input.purpose,
    meaning: input.meaning ?? null,
    signerName: signer?.full_name ?? req.user.username,
    signedAt: new Date().toISOString(),
  };
}

/**
 * Record that somebody has seen something, without claiming they signed it.
 *
 * Reading a controlled document or acknowledging an announcement is an
 * attributable act worth keeping, but it is not an approval and it should not
 * be dressed as one. These land in the same table with `reauthenticated = 0`,
 * so the difference between "Kwame read this" and "Kwame approved this" stays
 * visible to anyone reading the evidence — which is the point of asking for a
 * password on the second one.
 */
export function recordAcknowledgement(req: Request, input: Omit<SignatureInput, 'password'>): SignatureRecord {
  if (!req.user) throw new SignatureRefused('Authentication required', 401);
  const db = getDb();
  const staffId = input.staffId ?? getCurrentStaffId(req);
  const signer = db.prepare('SELECT full_name FROM users WHERE id = ?').get(req.user.id) as { full_name?: string } | undefined;
  const contentHash = contentHashOf(input.recordType, input.recordId);

  const result = db.prepare(`INSERT INTO e_signatures
      (module_key, record_type, record_id, purpose, meaning, user_id, staff_id, signer_name, signature_image_file_id, device_info, ip_address, content_hash, reauthenticated, signed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP)`)
    .run(input.moduleKey, input.recordType, String(input.recordId), input.purpose, input.meaning ?? null,
      req.user.id, staffId, signer?.full_name ?? req.user.username,
      parseIntNullable(input.signatureImageFileId), input.deviceInfo ?? deviceFromRequest(req), req.ip ?? null, contentHash);
  const id = Number(result.lastInsertRowid);

  const auditLogId = audit(req, {
    action: 'acknowledge', entity: input.recordType, entityId: input.recordId,
    newValue: { purpose: input.purpose, meaning: input.meaning, signatureId: id },
  });
  db.prepare('UPDATE e_signatures SET audit_log_id = ? WHERE id = ?').run(auditLogId, id);

  return {
    id,
    purpose: input.purpose,
    meaning: input.meaning ?? null,
    signerName: signer?.full_name ?? req.user.username,
    signedAt: new Date().toISOString(),
  };
}

/**
 * All signatures on a given record, newest first.
 *
 * Each carries `contentChanged`: true when the record no longer hashes to what
 * it hashed to when it was signed. A signature on a record that has since been
 * edited is still a real signature — of something else — and the screen showing
 * it needs to say so.
 */
export function signaturesFor(moduleKey: string, recordType: string, recordId: string | number) {
  const rows = getDb().prepare(
    `SELECT e.id, e.purpose, e.meaning, e.signer_name, e.signed_at, e.device_info, e.ip_address, e.staff_id,
            e.signature_image_file_id, e.content_hash, e.reauthenticated, e.audit_log_id
     FROM e_signatures e WHERE e.module_key = ? AND e.record_type = ? AND e.record_id = ? ORDER BY e.signed_at DESC`
  ).all(moduleKey, recordType, String(recordId)) as Array<Record<string, unknown> & { content_hash: string | null }>;

  const current = contentHashOf(recordType, recordId);
  return rows.map(row => ({
    ...row,
    contentChanged: row.content_hash != null && current != null && row.content_hash !== current,
  }));
}
