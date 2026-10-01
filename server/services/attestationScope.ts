/**
 * Who belongs on an attestation list — and what happens to the ones who leave.
 *
 * An attestation is a person's acknowledgement that they have read a controlled
 * document. Once somebody has left the laboratory there is nobody left to give
 * it: the row sits on the register as "pending" for ever, inflates the
 * outstanding count, and puts a name on the printed list that an assessor will
 * ask about and nobody can answer.
 *
 * So a former member of staff appears on an attestation list only if they
 * actually signed while they were here. That signature is a record and stays —
 * it is evidence the document was read by the people working to it at the time.
 * What they never signed is withdrawn, not carried.
 *
 * Two halves, deliberately:
 *   - `withdrawOutstandingAttestations` runs when an exit is recorded, so the
 *     backlog is cleared at the moment it stops being owed;
 *   - `ATTESTATION_STAFF_IN_SCOPE` is the read-time backstop, so registers and
 *     printed lists are already correct for exits recorded before this existed,
 *     and for any path that retires a record without going through the above.
 */

// Same shape the rest of the server passes around for the better-sqlite3 handle.
type DB = any;

/**
 * SQL predicate: is this attestation one that should still be shown?
 *
 * True for anybody currently on the register, and for a former member of staff
 * who signed before they left. `alias` is the table alias of
 * `document_attestations` in the surrounding query.
 */
export function attestationInScopeSql(alias = 'a'): string {
  return `(${alias}.status = 'signed' OR COALESCE((SELECT s_sc.is_active FROM staff s_sc WHERE s_sc.id = ${alias}.staff_id), 1) = 1)`;
}

/** The same predicate for the common case of an `a`-aliased attestations table. */
export const ATTESTATION_STAFF_IN_SCOPE = attestationInScopeSql('a');

/**
 * Close out everything a leaver still owed.
 *
 * Marked `waived` rather than deleted: the assignment happened, and the reason
 * it was never signed is part of the document's history. The matching inbox
 * task and distribution row are closed with it, so nothing keeps asking a
 * person who is gone.
 *
 * Returns how many attestations were withdrawn.
 */
export function withdrawOutstandingAttestations(db: DB, staffId: number, reason?: string): number {
  const note = `Withdrawn — staff member left the laboratory${reason ? ` (${reason})` : ''}.`;
  const outstanding = db.prepare(
    "SELECT id FROM document_attestations WHERE staff_id = ? AND status IN ('pending','overdue')",
  ).all(staffId) as Array<{ id: number }>;
  if (!outstanding.length) return 0;

  db.prepare(
    `UPDATE document_attestations
        SET status = 'waived',
            notes = TRIM(COALESCE(notes || ' ', '') || ?)
      WHERE staff_id = ? AND status IN ('pending','overdue')`,
  ).run(note, staffId);
  db.prepare(
    "UPDATE document_distribution SET status = 'cancelled' WHERE target_staff_id = ? AND status IN ('pending','overdue')",
  ).run(staffId);
  db.prepare(
    `UPDATE notifications
        SET status = 'dismissed', resolved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE assigned_to_staff_id = ?
        AND module_key = 'documents'
        AND record_type = 'document_attestations'
        AND status NOT IN ('resolved','dismissed')`,
  ).run(staffId);
  return outstanding.length;
}
