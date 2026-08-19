/**
 * Serving one file's bytes to an <iframe>, by name.
 *
 * Mounted outside /api and outside the authenticated router, because the only
 * caller is a browser frame that cannot send an Authorization header. Authority
 * is the ticket in the path: minted for one file, for one signed-in person, and
 * good for half an hour (see services/viewTickets.ts).
 */
import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { getDb, uploadRoot, evidenceRoot } from '../db/database.js';
import { readViewTicket } from '../services/viewTickets.js';

export function fileViewRoutes() {
  const router = Router();

  router.get('/:token/:name', (req, res) => {
    const ticket = readViewTicket(String(req.params.token));
    if (!ticket) return res.status(404).json({ error: 'This view link has expired. Close the document and open it again.' });
    const db = getDb();
    // A ticket dies with the account it was minted for, so ending somebody's
    // access ends what they can still read through a link already handed out.
    const holder = db.prepare('SELECT is_active FROM users WHERE id = ?').get(ticket.userId) as { is_active: number } | undefined;
    if (!holder || holder.is_active !== 1) return res.status(404).json({ error: 'File not found' });

    const file = db.prepare('SELECT * FROM files WHERE id = ?').get(ticket.fileId) as
      { stored_name: string; original_name: string; mime_type: string | null; storage_area: string } | undefined;
    if (!file) return res.status(404).json({ error: 'File not found' });
    const root = file.storage_area === 'evidence' ? evidenceRoot : uploadRoot;
    const fp = path.join(root, file.stored_name);
    if (path.dirname(path.resolve(fp)) !== path.resolve(root) || !fs.existsSync(fp)) return res.status(404).json({ error: 'File not found' });

    res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(file.original_name)}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    fs.createReadStream(fp).pipe(res);
  });

  return router;
}
