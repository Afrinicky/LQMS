/**
 * Copying backups off the premises, to Google Drive.
 *
 * WHY A SERVICE ACCOUNT, NOT "SIGN IN WITH GOOGLE"
 *
 * This host runs unattended on a laboratory LAN. The ordinary consent flow
 * needs a browser, a public callback URL and a refresh token that Google
 * expires — none of which a machine in a back office has. A service account is
 * the flow Google provides for exactly this: the laboratory creates one in the
 * Google Cloud console, downloads its JSON key, and shares one Drive folder
 * with the service account's email address. The host then authenticates with
 * nothing but that key, forever, with no browser and no expiry to babysit.
 *
 * WHY NO SDK
 *
 * `googleapis` is tens of megabytes and pulls a large dependency tree into an
 * offline-first application that is otherwise deliberately small. Everything
 * needed here is three HTTPS calls, and Node can sign the JWT itself.
 *
 * WHAT LEAVES THE BUILDING
 *
 * A backup ZIP contains the whole database, uploads and evidence. Uploading it
 * puts that in Google's hands. That is the laboratory's decision to make, so
 * it is off until somebody turns it on, and the screen that turns it on says
 * so plainly.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { configRoot, ensureDataDirs } from '../db/database.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files';
const FILES_URL = 'https://www.googleapis.com/drive/v3/files';
const ABOUT_URL = 'https://www.googleapis.com/drive/v3/about';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';

/** Where the key is kept. Never served to a client, never in the database. */
const keyPath = () => path.join(configRoot, 'google-drive-service-account.json');

export type ServiceAccountKey = {
  type: string;
  project_id: string;
  client_email: string;
  private_key: string;
  token_uri?: string;
};

export type DriveConnection = {
  connected: boolean;
  clientEmail: string | null;
  projectId: string | null;
  folderId: string | null;
  folderName: string | null;
};

/* ------------------------------------------------------------- credentials */

export function readKey(): ServiceAccountKey | null {
  try {
    const raw = fs.readFileSync(keyPath(), 'utf8');
    const key = JSON.parse(raw) as ServiceAccountKey;
    return key.client_email && key.private_key ? key : null;
  } catch { return null; }
}

/**
 * Store the service-account key. Returns what was wrong with it rather than
 * throwing, because the person pasting it needs to know which part is missing.
 */
export function saveKey(json: string): { ok: true; key: ServiceAccountKey } | { ok: false; error: string } {
  let parsed: ServiceAccountKey;
  try { parsed = JSON.parse(json); }
  catch { return { ok: false, error: 'That is not valid JSON. Paste the whole key file, including the outer braces.' }; }

  if (parsed.type !== 'service_account') {
    return { ok: false, error: 'That looks like an OAuth client key, not a service-account key. In the Google Cloud console open the service account, then Keys → Add key → JSON.' };
  }
  if (!parsed.client_email || !parsed.private_key) {
    return { ok: false, error: 'The key is missing client_email or private_key. Download it again from the Google Cloud console.' };
  }
  if (!/BEGIN (RSA )?PRIVATE KEY/.test(parsed.private_key)) {
    return { ok: false, error: 'The private_key in that file does not look like a key. Download it again rather than copying it by hand.' };
  }

  ensureDataDirs();
  // 0600: readable by the host process and nobody else on the machine.
  fs.writeFileSync(keyPath(), JSON.stringify(parsed, null, 2), { mode: 0o600 });
  try { fs.chmodSync(keyPath(), 0o600); } catch { /* best-effort on filesystems without modes */ }
  return { ok: true, key: parsed };
}

export function forgetKey(): void {
  try { fs.rmSync(keyPath(), { force: true }); } catch { /* already gone */ }
}

/* ------------------------------------------------------------------ tokens */

// One cached token per service account, keyed by its email — a laboratory may
// now have more than one Drive destination.
const cached = new Map<string, { token: string; expiresAt: number }>();

const b64url = (input: Buffer | string) =>
  Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * Exchange the service-account key for an access token (RFC 7523): sign a JWT
 * asserting who we are and what we want, and Google returns a bearer token.
 * Tokens last an hour; this reuses one until a minute before it expires.
 */
export async function getAccessToken(force = false, explicitKey?: ServiceAccountKey): Promise<string> {
  const key = explicitKey ?? readKey();
  if (!key) throw new Error('Google Drive is not connected — no service-account key is stored.');
  const hit = cached.get(key.client_email);
  if (!force && hit && hit.expiresAt > Date.now() + 60_000) return hit.token;

  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: key.client_email,
    scope: SCOPE,
    aud: key.token_uri || TOKEN_URL,
    exp: now + 3600,
    iat: now,
  }));
  const signature = b64url(crypto.sign('RSA-SHA256', Buffer.from(`${header}.${claims}`), key.private_key));
  const assertion = `${header}.${claims}.${signature}`;

  const res = await fetch(key.token_uri || TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  const body = await res.json().catch(() => ({})) as { access_token?: string; error_description?: string; error?: string };
  if (!res.ok || !body.access_token) {
    throw new Error(`Google refused the service-account key: ${body.error_description || body.error || res.statusText}`);
  }
  cached.set(key.client_email, { token: body.access_token, expiresAt: Date.now() + 3500_000 });
  return body.access_token;
}

/* ------------------------------------------------------------------- calls */

async function driveFetch(url: string, init: RequestInit = {}, key?: ServiceAccountKey): Promise<Response> {
  const token = await getAccessToken(false, key);
  const res = await fetch(url, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` } });
  // One retry on an expired token, in case the cached one was revoked early.
  if (res.status === 401) {
    const fresh = await getAccessToken(true, key);
    return fetch(url, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${fresh}` } });
  }
  return res;
}

/** Parse a pasted key without storing it, so a destination can hold its own. */
export function parseKey(json: string): ServiceAccountKey | null {
  try {
    const key = JSON.parse(json) as ServiceAccountKey;
    return key?.type === 'service_account' && key.client_email && key.private_key ? key : null;
  } catch { return null; }
}

/** Turn Google's error body into something a person can act on. */
async function explain(res: Response, folderId: string | null): Promise<string> {
  const text = await res.text().catch(() => '');
  let message = res.statusText;
  try { message = JSON.parse(text)?.error?.message || message; } catch { /* keep statusText */ }
  if (res.status === 404 && folderId) {
    return `Google cannot see folder ${folderId}. Open it in Drive, choose Share, and give the service-account email Editor access.`;
  }
  if (res.status === 403) {
    return `Google refused: ${message}. Check the Drive API is enabled for the project and that the folder is shared with the service account as an Editor.`;
  }
  return `Google Drive returned ${res.status}: ${message}`;
}

/**
 * Confirm the credential works and the folder is reachable, before anybody
 * relies on it. Returns what it found so the screen can show it.
 */
export async function testConnection(folderId: string | null, key?: ServiceAccountKey): Promise<{
  ok: true; clientEmail: string; folderName: string | null; quota: { used: string | null; limit: string | null } | null;
} | { ok: false; error: string }> {
  const account = key ?? readKey();
  if (!account) return { ok: false, error: 'No service-account key is stored yet.' };
  try {
    const about = await driveFetch(`${ABOUT_URL}?fields=storageQuota,user`, {}, account);
    if (!about.ok) return { ok: false, error: await explain(about, null) };
    const info = await about.json() as { storageQuota?: { usage?: string; limit?: string } };

    let folderName: string | null = null;
    if (folderId) {
      const folder = await driveFetch(`${FILES_URL}/${encodeURIComponent(folderId)}?fields=id,name,mimeType&supportsAllDrives=true`, {}, account);
      if (!folder.ok) return { ok: false, error: await explain(folder, folderId) };
      const f = await folder.json() as { name?: string; mimeType?: string };
      if (f.mimeType !== 'application/vnd.google-apps.folder') {
        return { ok: false, error: 'That Drive ID is a file, not a folder. Open the destination folder in Drive and copy the ID from its address bar.' };
      }
      folderName = f.name ?? null;
    }
    return {
      ok: true,
      clientEmail: account.client_email,
      folderName,
      quota: info.storageQuota
        ? { used: info.storageQuota.usage ?? null, limit: info.storageQuota.limit ?? null }
        : null,
    };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}

/**
 * Upload a backup, resumably.
 *
 * A full backup carries every upload and every piece of evidence, so it can be
 * hundreds of megabytes over a clinic's broadband. A resumable session survives
 * that far better than one long POST, and Google will tell us where it got to
 * if the line drops mid-transfer.
 */
export async function uploadBackup(
  filePath: string, fileName: string, folderId: string | null,
  onProgress?: (sentBytes: number, totalBytes: number) => void,
  key?: ServiceAccountKey,
): Promise<{ ok: true; fileId: string; webViewLink: string | null } | { ok: false; error: string }> {
  if (!fs.existsSync(filePath)) return { ok: false, error: `The backup ${fileName} is no longer on disk.` };
  const total = fs.statSync(filePath).size;

  try {
    const metadata: Record<string, unknown> = { name: fileName, mimeType: 'application/zip' };
    if (folderId) metadata.parents = [folderId];

    const start = await driveFetch(`${UPLOAD_URL}?uploadType=resumable&supportsAllDrives=true&fields=id,webViewLink`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': 'application/zip', 'X-Upload-Content-Length': String(total) },
      body: JSON.stringify(metadata),
    }, key);
    if (!start.ok) return { ok: false, error: await explain(start, folderId) };
    const session = start.headers.get('location');
    if (!session) return { ok: false, error: 'Google did not return an upload session. Try again.' };

    // 8 MiB chunks: large enough that the per-chunk round trip is negligible,
    // small enough that a dropped connection costs seconds, not minutes.
    const CHUNK = 8 * 1024 * 1024;
    const handle = fs.openSync(filePath, 'r');
    try {
      let sent = 0;
      while (sent < total) {
        const size = Math.min(CHUNK, total - sent);
        const buffer = Buffer.alloc(size);
        fs.readSync(handle, buffer, 0, size, sent);
        const res = await fetch(session, {
          method: 'PUT',
          headers: { 'Content-Length': String(size), 'Content-Range': `bytes ${sent}-${sent + size - 1}/${total}` },
          body: new Uint8Array(buffer),
        });
        if (res.status === 200 || res.status === 201) {
          const done = await res.json().catch(() => ({})) as { id?: string; webViewLink?: string };
          onProgress?.(total, total);
          if (!done.id) return { ok: false, error: 'Upload finished but Google did not return a file id.' };
          return { ok: true, fileId: done.id, webViewLink: done.webViewLink ?? null };
        }
        // 308 means "keep going" and tells us how much it actually kept.
        if (res.status === 308) {
          const range = res.headers.get('range');
          sent = range ? Number(range.split('-')[1]) + 1 : sent + size;
          onProgress?.(sent, total);
          continue;
        }
        return { ok: false, error: await explain(res, folderId) };
      }
      return { ok: false, error: 'Upload ended without Google confirming the file.' };
    } finally { fs.closeSync(handle); }
  } catch (e) {
    const message = (e as Error).message;
    if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|fetch failed/i.test(message)) {
      return { ok: false, error: 'Could not reach Google. Check this host has internet access; the local backup is safe either way.' };
    }
    return { ok: false, error: message };
  }
}

/** What is already in the Drive folder, so retention can be mirrored there. */
export async function listRemote(folderId: string | null, key?: ServiceAccountKey): Promise<Array<{ id: string; name: string; createdTime: string; size: number }>> {
  const q = folderId ? `'${folderId}' in parents and trashed = false` : 'trashed = false';
  const url = `${FILES_URL}?q=${encodeURIComponent(q)}&fields=files(id,name,createdTime,size)&orderBy=createdTime desc&pageSize=200&supportsAllDrives=true&includeItemsFromAllDrives=true`;
  const res = await driveFetch(url, {}, key);
  if (!res.ok) throw new Error(await explain(res, folderId));
  const body = await res.json() as { files?: Array<{ id: string; name: string; createdTime: string; size?: string }> };
  return (body.files ?? []).map(f => ({ id: f.id, name: f.name, createdTime: f.createdTime, size: Number(f.size ?? 0) }));
}

export async function deleteRemote(fileId: string, key?: ServiceAccountKey): Promise<boolean> {
  const res = await driveFetch(`${FILES_URL}/${encodeURIComponent(fileId)}?supportsAllDrives=true`, { method: 'DELETE' }, key);
  return res.ok || res.status === 404;
}
