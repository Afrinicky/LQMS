/**
 * Credentials the middleware has to keep.
 *
 * A destination that needs a password needs it unattended: the engine delivers
 * at three in the morning with nobody to type it. So it is stored — and stored
 * encrypted, which the analyser bridge's own `lhims_password` is not, because
 * that column predates this and rewriting it would touch the one link that
 * must not be touched.
 *
 * AES-256-GCM with a key held in a file in the data directory, created at 0600
 * on first use. That is not a hardware security module and does not pretend to
 * be: it protects a stolen database file, which is the realistic threat for a
 * laboratory host, and it keeps a password out of every backup, export, log
 * line and diagnostic report by construction rather than by remembering to
 * strip it.
 *
 * The one rule the rest of the module relies on: a secret is written through
 * `sealSecret` and read ONLY by a transport about to use it. Nothing returns a
 * decrypted secret to an HTTP response.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dataRoot } from '../../db/database.js';

const KEY_FILE = 'middleware.key';
const VERSION = 'mw1';

let cachedKey: Buffer | null = null;

/** The host's own middleware key, created once and kept to this host. */
function key(): Buffer {
  if (cachedKey) return cachedKey;
  const file = path.join(dataRoot, KEY_FILE);
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    const decoded = Buffer.from(existing, 'base64');
    if (decoded.length === 32) { cachedKey = decoded; return cachedKey; }
  } catch { /* first use, or an unreadable key file replaced below */ }

  const fresh = crypto.randomBytes(32);
  try {
    fs.mkdirSync(dataRoot, { recursive: true });
    fs.writeFileSync(file, fresh.toString('base64'), { mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch { /* a file system without modes */ }
  } catch {
    // A host that cannot write its key still has to work. The key lives for
    // this process only, which means a stored secret cannot be read back after
    // a restart — and a transport that cannot decrypt says so plainly rather
    // than delivering nothing silently.
  }
  cachedKey = fresh;
  return cachedKey;
}

/** Encrypt a secret for storage. An empty secret stores as null. */
export function sealSecret(plain: string | null | undefined): string | null {
  const value = String(plain ?? '');
  if (!value) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64'), tag.toString('base64'), body.toString('base64')].join(':');
}

/**
 * Read a secret back, for a transport about to authenticate with it.
 *
 * Returns null rather than throwing when the ciphertext cannot be opened — a
 * key file replaced, a database copied to another host — so the delivery fails
 * with "the stored credential could not be read on this host", which is the
 * true and actionable answer.
 */
export function openSecret(sealed: string | null | undefined): string | null {
  const value = String(sealed ?? '');
  if (!value) return null;
  const parts = value.split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(parts[1], 'base64'));
    decipher.setAuthTag(Buffer.from(parts[2], 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64')), decipher.final()]).toString('utf8');
  } catch { return null; }
}

/** Is a secret held for this destination? The only thing a screen may know. */
export function secretIsSet(sealed: string | null | undefined): boolean {
  return Boolean(String(sealed ?? '').trim());
}

/**
 * Strip anything credential-shaped out of text bound for a log, a diagnostic
 * report or an assistant.
 *
 * Applied at the point of writing rather than trusted to callers: a password
 * in a URL reaches a screen through whichever code path forgot, so the
 * scrubbing lives where every path passes.
 */
export function scrubSecrets(text: string | null | undefined): string {
  let value = String(text ?? '');
  if (!value) return value;
  value = value.replace(/((?:password|passwd|pwd|secret|token|api[_-]?key|authorization)\s*[=:]\s*)("?)([^\s&"',;]+)\2/gi,
    (_m, head, quote) => `${head}${quote}[redacted]${quote}`);
  // Credentials in a URL's authority, and in a query string.
  value = value.replace(/(\/\/)([^/@\s:]+):([^/@\s]+)@/g, '$1$2:[redacted]@');
  value = value.replace(/([?&](?:password|passwd|pwd|token|key|apikey|api_key)=)[^&\s]*/gi, '$1[redacted]');
  value = value.replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/g, '$1[redacted]');
  return value;
}
