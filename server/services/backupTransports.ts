/**
 * Getting a backup file from here to there.
 *
 * One function per protocol, all with the same shape: given a local file and a
 * destination's configuration, put the file there and say plainly what happened.
 * Nothing here knows about schedules, retention or the database — that keeps
 * each transport small enough to read in one sitting and to reason about when a
 * hospital's network does something unexpected.
 *
 * No SDKs. S3 is signed with Node's own crypto (SigV4 is about forty lines when
 * you are only doing PUT and LIST), and WebDAV is HTTP with a password. Adding
 * the AWS SDK would have put tens of megabytes into an application that is
 * meant to run from a memory stick on a laboratory bench.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import * as drive from './googleDrive.js';

/**
 * How long any single network call may take before it is abandoned.
 *
 * A destination that accepts a connection and then says nothing would otherwise
 * stall the nightly cycle indefinitely, and every destination behind it would
 * never be tried. Better to fail one at 02:01 and carry on.
 *
 * Checks are given less rope than uploads, because somebody is sitting in front
 * of the screen waiting for the answer.
 */
const CHECK_TIMEOUT_MS = 15_000;
const UPLOAD_TIMEOUT_MS = 30 * 60_000;

const timed = (ms: number): RequestInit => ({ signal: AbortSignal.timeout(ms) });

export type TransportResult =
  | { ok: true; remoteId: string | null; note?: string }
  | { ok: false; error: string };

export type RemoteFile = { id: string; name: string; createdAt: string; size: number };

/**
 * Turn a thrown network error into something a laboratory can act on.
 *
 * `fetch` reports almost everything as the single word "failed" and hides what
 * actually went wrong on `cause` — sometimes nested twice. Reading the whole
 * chain is the difference between "check the address" and a message nobody in
 * a laboratory can do anything with.
 */
function networkExplain(e: unknown, where: string): string {
  const parts: string[] = [];
  for (let cur: unknown = e, depth = 0; cur && depth < 5; depth++) {
    const err = cur as Error & { code?: string; cause?: unknown };
    if (err.code) parts.push(err.code);
    if (err.name) parts.push(err.name);
    if (err.message) parts.push(err.message);
    cur = err.cause;
  }
  const message = parts.join(' ') || String(e);
  if (/ENOTFOUND|EAI_AGAIN/i.test(message)) return `Cannot find ${where}. Check the address, and that this computer has network access.`;
  if (/ECONNREFUSED/i.test(message)) return `${where} refused the connection. Check it is switched on and the port is right.`;
  if (/ETIMEDOUT|timeout|abort|AbortError|TimeoutError/i.test(message)) return `${where} did not answer in time. It may be off, unreachable from this network, or blocked by a firewall.`;
  if (/CERT|self.signed|SSL/i.test(message)) return `${where} presented a certificate this host does not trust. A self-signed certificate needs installing on this machine first.`;
  if (/EACCES|EPERM/i.test(message)) return `Permission denied by ${where}. Check the account this host runs as may write there.`;
  if (/ENOSPC/i.test(message)) return `${where} is full.`;
  return `${where}: ${(e as Error)?.message ?? String(e)}`;
}

/* ============================================================ folder / network */

/**
 * A folder, whether it is on this machine or a share on the hospital server.
 *
 * Both are the same operation as far as this host is concerned: a path it can
 * write to. What differs is the advice when it fails, because "check the drive"
 * and "check the server is reachable" send somebody to different places.
 */
export function folderCheck(dir: string, kind: 'folder' | 'network'): TransportResult {
  const where = kind === 'network' ? 'That shared folder' : 'That folder';
  if (!dir || !path.isAbsolute(dir.replace(/^\\\\/, '/'))) {
    return { ok: false, error: 'Give the full path, starting from the drive letter or from /.' };
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
    // Prove it is writable now rather than at 02:00: a share can be mounted
    // read-only, or the host's account can lack permission, and neither shows
    // up until something tries.
    const probe = path.join(dir, `.sech-lims-write-test-${Date.now()}`);
    fs.writeFileSync(probe, 'SECH_LIMS write test');
    fs.rmSync(probe, { force: true });
    return { ok: true, remoteId: dir };
  } catch (e) {
    const message = (e as Error).message;
    if (/ENOENT/i.test(message)) {
      return { ok: false, error: kind === 'network'
        ? `${where} could not be reached. Check the server is on and the share name is right — if it does not open in the file manager on this computer, it will not work here either.`
        : `${where} does not exist and could not be created. Check the drive is plugged in.` };
    }
    // Something along the path is a file. Almost always a typo, and worth saying
    // so plainly rather than showing the raw error.
    if (/ENOTDIR/i.test(message)) {
      return { ok: false, error: `${where} cannot be created because part of that path is a file, not a folder. Check the path for a typo.` };
    }
    return { ok: false, error: networkExplain(e, where) };
  }
}

/**
 * Is the folder there, right now, without bringing it into being?
 *
 * Deliberately not `folderCheck`: that one creates what is missing, which is the
 * right behaviour when a backup is about to be written and exactly the wrong
 * behaviour when the screen is reporting whether the drive is still plugged in.
 * Asking the question must not change the answer.
 */
export function folderAvailable(dir: string): boolean {
  if (!dir) return false;
  try {
    if (!fs.statSync(dir).isDirectory()) return false;
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The same check, with a deadline.
 *
 * A path pointing at a network share whose server has gone away does not fail —
 * it blocks, in the kernel, for as long as the mount's own timeout, which can be
 * minutes. That is tolerable in a background cycle and not at all tolerable with
 * somebody waiting on a settings screen, so anything interactive comes through
 * here and gets an answer either way.
 *
 * The underlying operation is left to finish in the thread pool; abandoning the
 * wait is all that is needed.
 */
export function folderCheckWithTimeout(dir: string, kind: 'folder' | 'network', ms = CHECK_TIMEOUT_MS): Promise<TransportResult> {
  const where = kind === 'network' ? 'That shared folder' : 'That folder';
  return new Promise<TransportResult>(resolve => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({
        ok: false,
        error: `${where} did not respond within ${Math.round(ms / 1000)} seconds. That usually means the machine holding it is off, or the drive is disconnected.`,
      });
    }, ms);
    // The deadline must never be the reason the process stays alive.
    timer.unref?.();
    setImmediate(() => {
      const result = folderCheck(dir, kind);
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    });
  });
}

export function folderPut(filePath: string, fileName: string, dir: string, kind: 'folder' | 'network'): TransportResult {
  const ready = folderCheck(dir, kind);
  if (ready.ok !== true) return ready;
  const target = path.join(dir, fileName);
  // Write beside the target and rename into place, so a copy interrupted by a
  // dropped network link never leaves a half-file that looks like a backup.
  const staging = `${target}.part`;
  try {
    fs.copyFileSync(filePath, staging);
    fs.rmSync(target, { force: true });
    fs.renameSync(staging, target);
    return { ok: true, remoteId: target };
  } catch (e) {
    try { fs.rmSync(staging, { force: true }); } catch { /* nothing to clean */ }
    return { ok: false, error: networkExplain(e, kind === 'network' ? 'the shared folder' : 'that folder') };
  }
}

export function folderList(dir: string): RemoteFile[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.toLowerCase().endsWith('.zip'))
    .map(f => {
      const stat = fs.statSync(path.join(dir, f));
      return { id: path.join(dir, f), name: f, createdAt: stat.mtime.toISOString(), size: stat.size };
    });
}

export function folderDelete(fullPath: string): boolean {
  try { fs.rmSync(fullPath, { force: true }); return true; } catch { return false; }
}

/* ================================================================== S3 (SigV4) */

const sha256 = (v: crypto.BinaryLike) => crypto.createHash('sha256').update(v).digest('hex');
const hmac = (key: crypto.BinaryLike, v: string) => crypto.createHmac('sha256', key).update(v).digest();

type S3Config = {
  endpoint: string; region?: string; bucket: string; prefix?: string;
  accessKeyId: string; secretAccessKey: string; forcePathStyle?: boolean;
};

/**
 * Build a signed S3 request.
 *
 * `UNSIGNED-PAYLOAD` is what lets a several-hundred-megabyte backup stream
 * straight from disk: signing the payload would mean reading the whole file to
 * hash it before a single byte went out. Every S3 implementation accepts it
 * over HTTPS, and the request itself is still signed.
 */
function signS3(cfg: S3Config, method: string, key: string, extraHeaders: Record<string, string> = {}, query = '') {
  const region = cfg.region?.trim() || 'us-east-1';
  const endpoint = new URL(cfg.endpoint.replace(/\/+$/, ''));
  const pathStyle = cfg.forcePathStyle === true || /^\d+\.\d+\.\d+\.\d+$/.test(endpoint.hostname) || endpoint.port !== '';
  const host = pathStyle ? endpoint.host : `${cfg.bucket}.${endpoint.host}`;
  const canonicalUri = pathStyle
    ? `/${cfg.bucket}${key ? `/${key.split('/').map(encodeURIComponent).join('/')}` : ''}`
    : `/${key.split('/').map(encodeURIComponent).join('/')}`;

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);

  const headers: Record<string, string> = {
    host,
    'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
    'x-amz-date': amzDate,
    ...extraHeaders,
  };
  const signedKeys = Object.keys(headers).map(h => h.toLowerCase()).sort();
  const canonicalHeaders = signedKeys.map(h => `${h}:${String(headers[Object.keys(headers).find(k => k.toLowerCase() === h)!]).trim()}\n`).join('');
  const signedHeaders = signedKeys.join(';');

  const canonicalRequest = [method, canonicalUri, query, canonicalHeaders, signedHeaders, 'UNSIGNED-PAYLOAD'].join('\n');
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');

  const signing = hmac(hmac(hmac(hmac(`AWS4${cfg.secretAccessKey}`, dateStamp), region), 's3'), 'aws4_request');
  const signature = crypto.createHmac('sha256', signing).update(toSign).digest('hex');

  headers.Authorization = `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { url: `${endpoint.protocol}//${host}${canonicalUri}${query ? `?${query}` : ''}`, headers };
}

const s3Key = (cfg: S3Config, fileName: string) =>
  `${(cfg.prefix ?? '').replace(/^\/+|\/+$/g, '')}${cfg.prefix ? '/' : ''}${fileName}`.replace(/^\/+/, '');

/** Read the S3 error body, which carries a far better message than the status. */
async function s3Explain(res: Response, cfg: S3Config): Promise<string> {
  const body = await res.text().catch(() => '');
  const code = /<Code>([^<]+)<\/Code>/.exec(body)?.[1] ?? '';
  const message = /<Message>([^<]+)<\/Message>/.exec(body)?.[1] ?? res.statusText;
  if (/NoSuchBucket/i.test(code)) return `There is no bucket called "${cfg.bucket}" at that endpoint. Create it first, or check the spelling.`;
  if (/InvalidAccessKeyId/i.test(code)) return 'That access key ID is not recognised by this provider.';
  if (/SignatureDoesNotMatch/i.test(code)) return 'The secret access key does not match the access key ID. Copy both again from your provider.';
  if (/AccessDenied/i.test(code)) return `Access denied. The key needs permission to write to "${cfg.bucket}".`;
  if (res.status === 301 || /PermanentRedirect/i.test(code)) return 'The bucket is in a different region than the one given. Correct the region, or use the endpoint your provider lists for that bucket.';
  return `${code || res.status}: ${message}`;
}

export async function s3Check(cfg: S3Config): Promise<TransportResult> {
  try {
    // A one-object listing: proves the endpoint, the credential and the bucket
    // all at once, without writing anything.
    const { url, headers } = signS3(cfg, 'GET', '', {}, 'list-type=2&max-keys=1');
    const res = await fetch(url, { method: 'GET', headers, ...timed(CHECK_TIMEOUT_MS) });
    if (!res.ok) return { ok: false, error: await s3Explain(res, cfg) };
    return { ok: true, remoteId: cfg.bucket, note: `Bucket "${cfg.bucket}" is reachable and the key can read it.` };
  } catch (e) { return { ok: false, error: networkExplain(e, 'that S3 endpoint') }; }
}

export async function s3Put(filePath: string, fileName: string, cfg: S3Config): Promise<TransportResult> {
  try {
    const size = fs.statSync(filePath).size;
    const key = s3Key(cfg, fileName);
    const { url, headers } = signS3(cfg, 'PUT', key, { 'content-type': 'application/zip', 'content-length': String(size) });
    const res = await fetch(url, {
      method: 'PUT',
      headers,
      body: Readable.toWeb(fs.createReadStream(filePath)) as ReadableStream,
      // Node needs telling that a streamed body is not going to be duplexed.
      duplex: 'half',
      ...timed(UPLOAD_TIMEOUT_MS),
    } as RequestInit & { duplex: 'half' });
    if (!res.ok) return { ok: false, error: await s3Explain(res, cfg) };
    return { ok: true, remoteId: key };
  } catch (e) { return { ok: false, error: networkExplain(e, 'that S3 endpoint') }; }
}

export async function s3List(cfg: S3Config): Promise<RemoteFile[]> {
  const prefix = (cfg.prefix ?? '').replace(/^\/+|\/+$/g, '');
  const query = `list-type=2&max-keys=1000${prefix ? `&prefix=${encodeURIComponent(`${prefix}/`)}` : ''}`;
  const { url, headers } = signS3(cfg, 'GET', '', {}, query);
  const res = await fetch(url, { method: 'GET', headers, ...timed(CHECK_TIMEOUT_MS) });
  if (!res.ok) throw new Error(await s3Explain(res, cfg));
  const xml = await res.text();
  const out: RemoteFile[] = [];
  for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const block = match[1];
    const key = /<Key>([^<]+)<\/Key>/.exec(block)?.[1];
    if (!key || !key.toLowerCase().endsWith('.zip')) continue;
    out.push({
      id: key,
      name: key.split('/').pop()!,
      createdAt: /<LastModified>([^<]+)<\/LastModified>/.exec(block)?.[1] ?? new Date().toISOString(),
      size: Number(/<Size>(\d+)<\/Size>/.exec(block)?.[1] ?? 0),
    });
  }
  return out;
}

export async function s3Delete(key: string, cfg: S3Config): Promise<boolean> {
  const { url, headers } = signS3(cfg, 'DELETE', key);
  const res = await fetch(url, { method: 'DELETE', headers, ...timed(CHECK_TIMEOUT_MS) });
  return res.ok || res.status === 404;
}

/* ==================================================================== WebDAV */

type WebdavConfig = { url: string; username: string; password: string };

const webdavAuth = (cfg: WebdavConfig) =>
  `Basic ${Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64')}`;
const webdavBase = (cfg: WebdavConfig) => cfg.url.replace(/\/+$/, '');

function webdavExplain(status: number, where: string): string {
  if (status === 401) return 'The username or password was rejected. If the server offers app passwords, use one of those.';
  if (status === 403) return 'The server accepted the sign-in but refused the write. Check this account may write to that folder.';
  if (status === 404) return `${where} was not found. Check the address — in Nextcloud it is the WebDAV link at the bottom of the files page.`;
  if (status === 405) return 'That address does not accept uploads. It usually means the path points at something other than a folder.';
  if (status === 507) return 'The server is out of space.';
  return `The server answered ${status}.`;
}

export async function webdavCheck(cfg: WebdavConfig): Promise<TransportResult> {
  try {
    const res = await fetch(`${webdavBase(cfg)}/`, {
      method: 'PROPFIND',
      headers: { Authorization: webdavAuth(cfg), Depth: '0' },
      ...timed(CHECK_TIMEOUT_MS),
    });
    // 207 Multi-Status is the success answer for PROPFIND.
    if (res.status === 207 || res.ok) return { ok: true, remoteId: cfg.url, note: 'The folder is reachable and the sign-in works.' };
    return { ok: false, error: webdavExplain(res.status, 'That folder') };
  } catch (e) { return { ok: false, error: networkExplain(e, 'that WebDAV server') }; }
}

export async function webdavPut(filePath: string, fileName: string, cfg: WebdavConfig): Promise<TransportResult> {
  try {
    const size = fs.statSync(filePath).size;
    const target = `${webdavBase(cfg)}/${encodeURIComponent(fileName)}`;
    const res = await fetch(target, {
      method: 'PUT',
      headers: { Authorization: webdavAuth(cfg), 'Content-Type': 'application/zip', 'Content-Length': String(size) },
      body: Readable.toWeb(fs.createReadStream(filePath)) as ReadableStream,
      duplex: 'half',
      ...timed(UPLOAD_TIMEOUT_MS),
    } as RequestInit & { duplex: 'half' });
    if (!res.ok && res.status !== 204) return { ok: false, error: webdavExplain(res.status, 'That folder') };
    return { ok: true, remoteId: target };
  } catch (e) { return { ok: false, error: networkExplain(e, 'that WebDAV server') }; }
}

export async function webdavList(cfg: WebdavConfig): Promise<RemoteFile[]> {
  const res = await fetch(`${webdavBase(cfg)}/`, {
    method: 'PROPFIND',
    headers: { Authorization: webdavAuth(cfg), Depth: '1' },
    ...timed(CHECK_TIMEOUT_MS),
  });
  if (res.status !== 207 && !res.ok) throw new Error(webdavExplain(res.status, 'That folder'));
  const xml = await res.text();
  const out: RemoteFile[] = [];
  // Namespace prefixes vary between servers (d:, D:, lp1:), so match loosely.
  for (const block of xml.split(/<[a-zA-Z0-9]*:?response>/i).slice(1)) {
    const href = /<[a-zA-Z0-9]*:?href>([^<]+)<\/[a-zA-Z0-9]*:?href>/i.exec(block)?.[1];
    if (!href) continue;
    const name = decodeURIComponent(href.split('/').filter(Boolean).pop() ?? '');
    if (!name.toLowerCase().endsWith('.zip')) continue;
    out.push({
      id: href,
      name,
      createdAt: new Date(/<[a-zA-Z0-9]*:?getlastmodified>([^<]+)</i.exec(block)?.[1] ?? Date.now()).toISOString(),
      size: Number(/<[a-zA-Z0-9]*:?getcontentlength>(\d+)</i.exec(block)?.[1] ?? 0),
    });
  }
  return out;
}

export async function webdavDelete(href: string, cfg: WebdavConfig): Promise<boolean> {
  const base = new URL(webdavBase(cfg));
  const target = href.startsWith('http') ? href : `${base.origin}${href}`;
  const res = await fetch(target, { method: 'DELETE', headers: { Authorization: webdavAuth(cfg) }, ...timed(CHECK_TIMEOUT_MS) });
  return res.ok || res.status === 204 || res.status === 404;
}

/* ============================================================== Google Drive */

// Google Drive keeps its own module, because the service-account handshake is a
// bigger thing than the other transports and predates them.
export { drive };
