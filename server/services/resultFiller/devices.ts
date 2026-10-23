/**
 * Enrolling a browser, and recognising it afterwards.
 *
 * The extension carries two credentials and they answer two different
 * questions. The DEVICE token says this browser was enrolled by an
 * administrator and may ask SECHLIMS for pending results; the person's ordinary
 * session token says who is filling the form. Either may be withdrawn without
 * the other, and the fill register records both.
 *
 * Enrolment is a one-time pairing code, short-lived, shown once in the settings
 * screen and exchanged for a token the browser keeps. The token is stored as a
 * hash: the register can prove which device asked without holding anything that
 * would let somebody impersonate it.
 */
import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { getDb } from '../../db/database.js';
import { DEVICE_HEADER, PAIRING_CODE_LENGTH, PAIRING_CODE_TTL_MINUTES } from '../../../shared/constants/resultFiller.js';

export interface EnrolledDevice {
  id: number;
  device_code: string;
  label: string;
  state: string;
  section_id: number | null;
}

declare global {
  namespace Express {
    interface Request { fillerDevice?: EnrolledDevice }
  }
}

/** Unambiguous on paper: no O/0, no I/1/L, so a code read aloud is typed right. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function newPairingCode(): string {
  const bytes = crypto.randomBytes(PAIRING_CODE_LENGTH);
  let code = '';
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) code += ALPHABET[bytes[i] % ALPHABET.length];
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export function newDeviceToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(String(token ?? '')).digest('hex');
}

export function pairingExpiry(): string {
  return new Date(Date.now() + PAIRING_CODE_TTL_MINUTES * 60_000).toISOString().replace('T', ' ').slice(0, 19);
}

export function nextDeviceCode(db: any): string {
  const row = db.prepare('SELECT device_code AS code FROM rf_devices ORDER BY id DESC LIMIT 1').get() as any;
  const last = Number(String(row?.code ?? '').replace(/\D+/g, '')) || 0;
  return `RFD-${String(last + 1).padStart(4, '0')}`;
}

/** What a user agent string is worth saying in a register: the browser, no more. */
export function browserOf(userAgent: string | null | undefined): string {
  const ua = String(userAgent ?? '');
  if (/Edg\//.test(ua)) return 'Microsoft Edge';
  if (/OPR\//.test(ua)) return 'Opera';
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/Chrome\//.test(ua)) return 'Chrome';
  if (/Safari\//.test(ua)) return 'Safari';
  return 'Browser';
}

/**
 * Exchange a pairing code for a device token.
 *
 * The code is consumed whether or not it is used again: a pairing code that
 * survives its use is a credential sitting in somebody's notes.
 */
export function enrol(db: any, pairingCode: string, userAgent: string | null): { token: string; device: EnrolledDevice } | { error: string } {
  const code = String(pairingCode ?? '').trim().toUpperCase();
  if (!code) return { error: 'Enter the pairing code from SECHLIMS.' };
  const row = db.prepare(`SELECT * FROM rf_devices WHERE UPPER(pairing_code) = ? AND state != 'revoked'`).get(code) as any;
  if (!row) return { error: 'That pairing code is not recognised. Ask an administrator for a new one.' };
  if (row.pairing_expires_at && String(row.pairing_expires_at) < new Date().toISOString().replace('T', ' ').slice(0, 19)) {
    return { error: 'That pairing code has expired. Ask an administrator for a new one.' };
  }

  const token = newDeviceToken();
  db.prepare(`UPDATE rf_devices
      SET token_hash = ?, state = 'enrolled', pairing_code = NULL, pairing_expires_at = NULL,
          user_agent = ?, browser = ?, enrolled_at = CURRENT_TIMESTAMP, last_seen_at = CURRENT_TIMESTAMP
      WHERE id = ?`)
    .run(hashToken(token), String(userAgent ?? '').slice(0, 400), browserOf(userAgent), row.id);

  return {
    token,
    device: { id: Number(row.id), device_code: row.device_code, label: row.label, state: 'enrolled', section_id: row.section_id ?? null },
  };
}

/**
 * The browser asking must be one that was enrolled.
 *
 * Refusals say which credential is missing rather than returning a bare 403,
 * because "the extension stopped working" is otherwise indistinguishable from
 * "this device was revoked this morning".
 */
export function requireDevice(req: Request, res: Response, next: NextFunction) {
  const token = String(req.headers[DEVICE_HEADER] ?? '').trim();
  if (!token) {
    return res.status(401).json({ error: 'This browser is not enrolled. Open the extension options and enter a pairing code from SECHLIMS.', code: 'device_missing' });
  }
  const db = getDb();
  const row = db.prepare('SELECT id, device_code, label, state, section_id FROM rf_devices WHERE token_hash = ?').get(hashToken(token)) as any;
  if (!row) {
    return res.status(401).json({ error: 'This browser is no longer enrolled. Ask an administrator to pair it again.', code: 'device_unknown' });
  }
  if (row.state !== 'enrolled') {
    return res.status(403).json({ error: `This browser’s enrolment was ${row.state}. Ask an administrator to pair it again.`, code: 'device_revoked' });
  }
  req.fillerDevice = row as EnrolledDevice;
  try {
    db.prepare('UPDATE rf_devices SET last_seen_at = CURRENT_TIMESTAMP, last_seen_ip = ? WHERE id = ?')
      .run(String(req.ip ?? '').slice(0, 60), row.id);
  } catch { /* the register's convenience, not the request's business */ }
  next();
}
