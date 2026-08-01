import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { evidenceRoot } from '../db/database.js';

// Persists an in-memory uploaded file (multer memoryStorage) into the evidence
// store and registers it in the files table, returning the new file id. Used
// wherever a workflow step needs a supporting document — e.g. the root-cause
// analysis sheet attached before an investigation can be completed.
export function saveEvidenceFile(db: any, file: { originalname: string; mimetype?: string; size: number; buffer: Buffer }, userId: number): number {
  fs.mkdirSync(evidenceRoot, { recursive: true });
  const ext = path.extname(file.originalname) || '';
  const storedName = `${Date.now()}-${crypto.randomUUID()}${ext}`;
  fs.writeFileSync(path.join(evidenceRoot, storedName), file.buffer);
  const r = db.prepare('INSERT INTO files (original_name, stored_name, mime_type, size_bytes, storage_area, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)')
    .run(file.originalname, storedName, file.mimetype ?? null, file.size, 'evidence', userId);
  return Number(r.lastInsertRowid);
}
