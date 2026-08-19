/**
 * Reading a document version's file into its searchable content.
 *
 * This lives outside the document routes because two very different things now
 * attach a file to a version: the document register itself, and a save that
 * arrives from Microsoft Word over the browser handoff. Both must leave the
 * version's text, HTML and section list in the same state, so both call this.
 */
import path from 'node:path';
import { getDb, uploadRoot, evidenceRoot } from '../db/database.js';
import { extractDocument } from '../utils/documentExtract.js';
import { indexDocument } from '../services/dennisService.js';

type DbLike = ReturnType<typeof getDb>;

/** Extract `fileId` into `versionId`. Best-effort: a failure leaves the version alone. */
export function extractIntoVersion(db: DbLike, versionId: number, fileId: number) {
  try {
    const file = db.prepare('SELECT * FROM files WHERE id = ?').get(fileId) as
      { storage_area: string; stored_name: string; original_name: string; mime_type: string | null } | undefined;
    if (!file) return;
    const root = file.storage_area === 'evidence' ? evidenceRoot : uploadRoot;
    const result = extractDocument(path.join(root, file.stored_name), file.original_name, file.mime_type);
    db.prepare(`UPDATE document_versions SET content_text = ?, content_html = ?, content_sections = ?, page_count = ?, extraction_method = ?, extracted_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(result.text || null, result.html || null, result.sections.length ? JSON.stringify(result.sections) : null, result.pageCount, result.method, versionId);
    return result;
  } catch { /* best-effort extraction */ }
}

/**
 * The whole after-save job for a version that has just gained a file: read the
 * content, then make the document findable by the assistant. Used by the Office
 * save path, which has no request context to do this itself.
 */
export function ingestVersionFile(versionId: number, fileId: number, userId: number, documentId: number): void {
  const db = getDb();
  extractIntoVersion(db, versionId, fileId);
  try { indexDocument(db, documentId, userId); } catch { /* AI indexing is best-effort */ }
}
