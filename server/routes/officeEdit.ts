/**
 * Editing a controlled document in Microsoft Word from a browser.
 *
 * The desktop application already hands a file straight to Word and watches it
 * for saves. Over the LAN or the internet there is no such handle: the browser
 * has no path on disk to give Word, and Word will not send the application's
 * bearer token, so an ordinary download is a dead end — the person edits a copy
 * in their Downloads folder and the laboratory's record silently goes stale.
 *
 * Word does know how to open and save a document over a URL. Given
 * `ms-word:ofe|u|https://host/office/edit/<token>/<name>.docx` it opens the
 * document from that address and saves straight back to it, which is exactly
 * how a document library on a corporate intranet behaves. What it speaks there
 * is a small dialect of WebDAV, and this is that dialect: OPTIONS to discover
 * the server, PROPFIND to read the file's size and date, LOCK/UNLOCK so a
 * second person is told the document is open, GET to read and PUT to save.
 *
 * Authority travels in the URL because there is nowhere else to put it. The
 * token names one file, one version, one person, and one purpose; it expires on
 * its own; and it grants nothing beyond reading that file and adding a new
 * version of that document. A save arrives as a document version attributed to
 * the person the token was minted for, exactly as a manual upload would — the
 * controlled-document history is unchanged in kind, only in convenience.
 */
import { Router, type Request, type Response } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getDb, uploadRoot, evidenceRoot } from '../db/database.js';
import { safeStoredFilename } from '../utils/safeFilename.js';

/** How long a handoff stays usable. Long enough for an afternoon's editing. */
export const OFFICE_SESSION_HOURS = 12;
/** A save larger than this is refused rather than filling the disk. */
const MAX_SAVE_BYTES = 80 * 1024 * 1024;

export type OfficeSession = {
  id: number; token: string; document_id: number; version_id: number; file_id: number;
  file_name: string; user_id: number; read_only: number; lock_token: string | null; saves: number;
  last_saved_at: string | null; last_version_id: number | null;
  expires_at: string; closed_at: string | null; created_at: string;
};

/** Word only opens what it recognises — anything else belongs in a download. */
export const OFFICE_EDITABLE = /\.(docx?|dotx?|xlsx?|xlsm|xltx?|pptx?|potx?|rtf|odt|ods|odp)$/i;

/**
 * The Office URI scheme that hands a URL to the right application.
 *
 * `ofe` opens the document for EDITING and saves back to the URL; `ofv` opens
 * it for VIEWING and does not. Reading a Word SOP is reading — it is the only
 * way to read one, because a .docx has no in-app preview — so somebody with
 * the right to read the document library gets `ofv`, and only an author gets
 * `ofe`. Word itself then enforces the difference at the desk.
 */
export function officeUriFor(fileName: string, url: string, mode: 'edit' | 'view' = 'edit'): string {
  const ext = (fileName.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
  const app = /^(xls|xlsx|xlsm|xlt|xltx|ods|csv)$/.test(ext) ? 'ms-excel'
    : /^(ppt|pptx|pot|potx|odp)$/.test(ext) ? 'ms-powerpoint'
    : 'ms-word';
  return `${app}:${mode === 'view' ? 'ofv' : 'ofe'}|u|${url}`;
}

/** The application a given file will land in, for the button's label. */
export function officeAppNameFor(fileName: string): string {
  const ext = (fileName.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
  if (/^(xls|xlsx|xlsm|xlt|xltx|ods|csv)$/.test(ext)) return 'Microsoft Excel';
  if (/^(ppt|pptx|pot|potx|odp)$/.test(ext)) return 'Microsoft PowerPoint';
  return 'Microsoft Word';
}

/** Mint a handoff. Called by the documents routes, which do the permission work. */
export function createOfficeSession(input: {
  documentId: number; versionId: number; fileId: number; fileName: string; userId: number;
  /** True when the holder may read the document but not write a new version. */
  readOnly?: boolean;
}): OfficeSession {
  const db = getDb();
  const token = crypto.randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + OFFICE_SESSION_HOURS * 3600_000).toISOString();
  db.prepare(`INSERT INTO office_edit_sessions (token, document_id, version_id, file_id, file_name, user_id, read_only, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(token, input.documentId, input.versionId, input.fileId, input.fileName, input.userId, input.readOnly ? 1 : 0, expiresAt);
  return db.prepare('SELECT * FROM office_edit_sessions WHERE token = ?').get(token) as OfficeSession;
}

export function getOfficeSession(token: string): OfficeSession | null {
  const db = getDb();
  const s = db.prepare('SELECT * FROM office_edit_sessions WHERE token = ?').get(token) as OfficeSession | undefined;
  if (!s) return null;
  if (s.closed_at) return null;
  if (new Date(s.expires_at).getTime() < Date.now()) return null;
  // The handoff carries the authority of the person it was minted for, so it
  // must die with them: deactivating an account has to end what it can still
  // do, not leave a working URL behind for the rest of the day.
  const holder = db.prepare('SELECT is_active FROM users WHERE id = ?').get(s.user_id) as { is_active: number } | undefined;
  if (!holder || holder.is_active !== 1) return null;
  // Likewise if the document itself has gone.
  const doc = db.prepare('SELECT id FROM documents WHERE id = ?').get(s.document_id);
  if (!doc) return null;
  return s;
}

export function closeOfficeSession(token: string): void {
  getDb().prepare('UPDATE office_edit_sessions SET closed_at = CURRENT_TIMESTAMP WHERE token = ? AND closed_at IS NULL').run(token);
}

/** Absolute base URL of this host as the caller reached it — what Word must dial. */
export function publicBaseUrl(req: Request): string {
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  return `${proto}://${host}`;
}

function resolveOnDisk(fileId: number): { fp: string; mime: string; name: string } | null {
  const file = getDb().prepare('SELECT * FROM files WHERE id = ?').get(fileId) as
    { stored_name: string; original_name: string; mime_type: string | null; storage_area: string } | undefined;
  if (!file) return null;
  const root = file.storage_area === 'evidence' ? evidenceRoot : uploadRoot;
  const fp = path.join(root, file.stored_name);
  if (path.dirname(path.resolve(fp)) !== path.resolve(root)) return null;
  if (!fs.existsSync(fp)) return null;
  return { fp, mime: file.mime_type || 'application/octet-stream', name: file.original_name };
}

const xmlEscape = (s: string) => s.replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c] as string));
const httpDate = (ms: number) => new Date(ms).toUTCString();
const isoZ = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');

/**
 * Everything Word asks of a server before it will treat a URL as editable
 * rather than read-only. Missing any one of these is what makes Word silently
 * fall back to "Read-Only" or refuse to save.
 */
function davHeaders(res: Response) {
  res.setHeader('DAV', '1,2');
  res.setHeader('MS-Author-Via', 'DAV');
  res.setHeader('Allow', 'OPTIONS, HEAD, GET, PUT, POST, PROPFIND, PROPPATCH, LOCK, UNLOCK, DELETE, MKCOL, COPY, MOVE');
  res.setHeader('Public', 'OPTIONS, HEAD, GET, PUT, POST, PROPFIND, PROPPATCH, LOCK, UNLOCK');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'no-store');
}

export function officeEditRoutes() {
  const router = Router();

  // Word sends XML bodies and raw document bytes, neither of which the JSON
  // parser upstream would touch — so they are read here. The size ceiling is
  // enforced while reading rather than after: a save nobody will accept must
  // not be buffered into memory first.
  router.use((req, res, next) => {
    if (req.method !== 'PUT' && req.method !== 'PROPFIND' && req.method !== 'PROPPATCH' && req.method !== 'LOCK') return next();
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > MAX_SAVE_BYTES) { davHeaders(res); res.status(413).end(); return; }
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > MAX_SAVE_BYTES) { davHeaders(res); res.status(413).end(); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => { if (!res.headersSent) { (req as Request & { rawBody?: Buffer }).rawBody = Buffer.concat(chunks); next(); } });
    req.on('error', next);
  });

  // Word probes the collection before the file. Answer both.
  router.options('/edit/:token', (_req, res) => { davHeaders(res); res.status(200).end(); });
  router.options('/edit/:token/:name', (_req, res) => { davHeaders(res); res.status(200).end(); });

  const load = (req: Request, res: Response): OfficeSession | null => {
    const session = getOfficeSession(String(req.params.token));
    if (!session) { davHeaders(res); res.status(404).end(); return null; }
    return session;
  };

  // PROPFIND — the file's name, size, type and dates. Word will not open a
  // document it cannot get these for.
  const propfind = (req: Request, res: Response) => {
    const session = load(req, res); if (!session) return;
    const resolved = resolveOnDisk(session.file_id);
    if (!resolved) { davHeaders(res); res.status(404).end(); return; }
    const st = fs.statSync(resolved.fp);
    const base = `${publicBaseUrl(req)}/office/edit/${session.token}`;
    const href = `${base}/${encodeURIComponent(session.file_name)}`;
    const depth = String(req.headers.depth ?? '0');

    const fileEntry = `<D:response>
    <D:href>${xmlEscape(href)}</D:href>
    <D:propstat><D:prop>
      <D:displayname>${xmlEscape(session.file_name)}</D:displayname>
      <D:getcontentlength>${st.size}</D:getcontentlength>
      <D:getcontenttype>${xmlEscape(resolved.mime)}</D:getcontenttype>
      <D:getlastmodified>${httpDate(st.mtimeMs)}</D:getlastmodified>
      <D:creationdate>${isoZ(st.birthtimeMs || st.ctimeMs)}</D:creationdate>
      <D:getetag>"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"</D:getetag>
      <D:resourcetype/>
      <D:supportedlock>
        <D:lockentry><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry>
      </D:supportedlock>
    </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
  </D:response>`;

    const collectionEntry = `<D:response>
    <D:href>${xmlEscape(base)}/</D:href>
    <D:propstat><D:prop>
      <D:displayname>${xmlEscape(session.file_name)}</D:displayname>
      <D:resourcetype><D:collection/></D:resourcetype>
      <D:getlastmodified>${httpDate(st.mtimeMs)}</D:getlastmodified>
    </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
  </D:response>`;

    // A PROPFIND on the folder lists the folder and the one file in it; on the
    // file itself, just the file.
    const onCollection = !req.params.name;
    const body = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  ${onCollection ? collectionEntry + (depth === '0' ? '' : fileEntry) : fileEntry}
</D:multistatus>`;
    davHeaders(res);
    res.status(207).type('application/xml; charset=utf-8').send(body);
  };
  router.propfind('/edit/:token', propfind);
  router.propfind('/edit/:token/:name', propfind);

  // Word writes custom properties on open; accepting them is enough.
  router.proppatch('/edit/:token/:name', (req, res) => {
    const session = load(req, res); if (!session) return;
    const href = `${publicBaseUrl(req)}/office/edit/${session.token}/${encodeURIComponent(session.file_name)}`;
    davHeaders(res);
    res.status(207).type('application/xml; charset=utf-8').send(`<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:"><D:response><D:href>${xmlEscape(href)}</D:href>
<D:propstat><D:prop/><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>`);
  });

  // LOCK / UNLOCK — Word takes a write lock before it will edit rather than
  // open read-only. The lock is per handoff, which is the right granularity:
  // two people editing the same document hold two different tokens.
  router.lock('/edit/:token/:name', (req, res) => {
    const session = load(req, res); if (!session) return;
    const lockToken = session.lock_token || `opaquelocktoken:${crypto.randomUUID()}`;
    getDb().prepare('UPDATE office_edit_sessions SET lock_token = ? WHERE id = ?').run(lockToken, session.id);
    const href = `${publicBaseUrl(req)}/office/edit/${session.token}/${encodeURIComponent(session.file_name)}`;
    davHeaders(res);
    res.setHeader('Lock-Token', `<${lockToken}>`);
    res.status(200).type('application/xml; charset=utf-8').send(`<?xml version="1.0" encoding="utf-8"?>
<D:prop xmlns:D="DAV:"><D:lockdiscovery><D:activelock>
  <D:locktype><D:write/></D:locktype>
  <D:lockscope><D:exclusive/></D:lockscope>
  <D:depth>0</D:depth>
  <D:timeout>Second-3600</D:timeout>
  <D:locktoken><D:href>${xmlEscape(lockToken)}</D:href></D:locktoken>
  <D:lockroot><D:href>${xmlEscape(href)}</D:href></D:lockroot>
</D:activelock></D:lockdiscovery></D:prop>`);
  });
  router.unlock('/edit/:token/:name', (req, res) => {
    const session = load(req, res); if (!session) return;
    getDb().prepare('UPDATE office_edit_sessions SET lock_token = NULL WHERE id = ?').run(session.id);
    davHeaders(res);
    res.status(204).end();
  });

  // HEAD / GET — the document itself.
  const serve = (req: Request, res: Response, withBody: boolean) => {
    const session = load(req, res); if (!session) return;
    const resolved = resolveOnDisk(session.file_id);
    if (!resolved) { davHeaders(res); res.status(404).end(); return; }
    const st = fs.statSync(resolved.fp);
    davHeaders(res);
    res.setHeader('Content-Type', resolved.mime);
    res.setHeader('Content-Length', String(st.size));
    res.setHeader('Last-Modified', httpDate(st.mtimeMs));
    res.setHeader('ETag', `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(session.file_name)}"`);
    if (!withBody) return res.status(200).end();
    fs.createReadStream(resolved.fp).pipe(res);
  };
  router.head('/edit/:token/:name', (req, res) => serve(req, res, false));
  router.get('/edit/:token/:name', (req, res) => serve(req, res, true));

  // PUT — the save. Every save from Word becomes a new document version, so the
  // controlled history reads the same as it would from a manual upload.
  router.put('/edit/:token/:name', (req, res) => {
    const session = load(req, res); if (!session) return;
    // A reader's handoff carries no authority to write. Word is already told
    // this by the `ofv` URI it was opened with, and it is enforced here too —
    // the URI is a request, this is the answer.
    if (session.read_only) { davHeaders(res); res.status(403).end(); return; }
    const bytes = (req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0);
    if (bytes.length === 0) { davHeaders(res); res.status(400).end(); return; }
    if (bytes.length > MAX_SAVE_BYTES) { davHeaders(res); res.status(413).end(); return; }

    const db = getDb();
    const source = db.prepare('SELECT * FROM files WHERE id = ?').get(session.file_id) as
      { original_name: string; mime_type: string | null } | undefined;
    const originalName = session.file_name || source?.original_name || 'document.docx';
    const storedName = safeStoredFilename(originalName);
    try {
      fs.writeFileSync(path.join(uploadRoot, storedName), bytes);
    } catch {
      davHeaders(res); res.status(507).end(); return;
    }

    const stamp = new Date();
    const label = `word-${stamp.toISOString().slice(0, 10)}-${String(stamp.getHours()).padStart(2, '0')}${String(stamp.getMinutes()).padStart(2, '0')}${String(stamp.getSeconds()).padStart(2, '0')}`;
    const tx = db.transaction(() => {
      const fileRow = db.prepare('INSERT INTO files (original_name, stored_name, mime_type, size_bytes, storage_area, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)')
        .run(originalName, storedName, source?.mime_type || 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytes.length, 'uploads', session.user_id);
      const fileId = Number(fileRow.lastInsertRowid);
      const staffId = (db.prepare('SELECT staff_id FROM users WHERE id = ?').get(session.user_id) as { staff_id: number | null } | undefined)?.staff_id ?? null;
      const versionRow = db.prepare(`INSERT INTO document_versions (document_id, version_label, version_number, file_id, revision_summary, status, prepared_by_staff_id, created_by)
        VALUES (?, ?, ?, ?, ?, 'draft', ?, ?)`)
        .run(session.document_id, label, label, fileId, 'Saved from Microsoft Office', staffId, session.user_id);
      const versionId = Number(versionRow.lastInsertRowid);
      db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run('documents', 'document_versions', String(versionId), 'documents', 'files', String(fileId), 'Saved from Microsoft Office');
      db.prepare('UPDATE documents SET current_version_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(versionId, session.document_id);
      // Subsequent saves in the same sitting re-read the file this session now
      // points at, so Word keeps editing the latest bytes rather than the ones
      // it was first given.
      db.prepare('UPDATE office_edit_sessions SET file_id = ?, version_id = ?, last_version_id = ?, saves = saves + 1, last_saved_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(fileId, versionId, versionId, session.id);
      db.prepare('INSERT INTO audit_logs (actor_user_id, action, entity, entity_id, new_value) VALUES (?, ?, ?, ?, ?)')
        .run(session.user_id, 'office_save', 'document_versions', String(versionId), JSON.stringify({ documentId: session.document_id, fileId, bytes: bytes.length, via: 'webdav' }));
      return { versionId, fileId };
    });
    let out: { versionId: number; fileId: number };
    try { out = tx(); }
    catch { davHeaders(res); res.status(500).end(); return; }

    // Content extraction feeds search and the in-app preview; a failure here
    // must not fail the save Word is waiting on.
    void (async () => {
      try {
        const { ingestVersionFile } = await import('../services/documentContent.js');
        ingestVersionFile(out.versionId, out.fileId, session.user_id, session.document_id);
      } catch { /* best effort */ }
    })();

    davHeaders(res);
    res.setHeader('ETag', `"${bytes.length.toString(16)}-${Date.now().toString(16)}"`);
    res.status(201).end();
  });

  // Word occasionally probes for a folder or moves a temp file; answering
  // politely keeps it from deciding the server is read-only.
  router.mkcol('/edit/:token/:name', (_req, res) => { davHeaders(res); res.status(405).end(); });
  router.delete('/edit/:token/:name', (_req, res) => { davHeaders(res); res.status(403).end(); });

  return router;
}
