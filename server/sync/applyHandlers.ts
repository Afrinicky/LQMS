/**
 * Host-side apply handlers for remote submissions (R3). Each handler translates a
 * validated remote proposal into an authoritative write on the Host database.
 * Handlers run inside a transaction; capture triggers are NOT suppressed, so any
 * change to a syncable table replicates back to the cloud and the portal sees it.
 *
 * New activities are added here as later phases land. Approval-tier activities are
 * parked as awaiting_approval by the reconciler and applied in R4.
 */
import type BetterSqlite3 from 'better-sqlite3';

export interface Submission {
  id: number;
  submission_uuid: string;
  actor_staff_id: number;
  actor_email: string | null;
  activity: string;
  target_table: string | null;
  target_uuid: string | null;
  base_version: string | null;
  payload: Record<string, unknown> | null;
}

export interface ApplyResult { ok: boolean; message: string; }
export type ApplyHandler = (db: BetterSqlite3.Database, s: Submission) => ApplyResult;

export const APPLY_HANDLERS: Record<string, ApplyHandler> = {
  // SOP / controlled-document acknowledgement: attest the latest version of the
  // targeted document on behalf of the acting staff member.
  'sop.acknowledge': (db, s) => {
    if (!s.target_uuid) return { ok: false, message: 'No document specified.' };
    const doc = db.prepare('SELECT id, title FROM documents WHERE uuid = ?').get(s.target_uuid) as { id: number; title: string } | undefined;
    if (!doc) return { ok: false, message: 'Document not found on Host.' };
    const version = db.prepare('SELECT id FROM document_versions WHERE document_id = ? ORDER BY id DESC LIMIT 1').get(doc.id) as { id: number } | undefined;
    if (!version) return { ok: false, message: 'Document has no version to acknowledge.' };
    const existing = db.prepare('SELECT id FROM document_attestations WHERE document_version_id = ? AND staff_id = ?').get(version.id, s.actor_staff_id) as { id: number } | undefined;
    if (existing) {
      db.prepare("UPDATE document_attestations SET status = 'attested', attested_at = CURRENT_TIMESTAMP WHERE id = ?").run(existing.id);
    } else {
      db.prepare("INSERT INTO document_attestations (document_version_id, staff_id, attested_at, status) VALUES (?, ?, CURRENT_TIMESTAMP, 'attested')").run(version.id, s.actor_staff_id);
    }
    return { ok: true, message: `Acknowledged "${doc.title}".` };
  },
};
