/**
 * Removing notifications, and everything hanging off them.
 *
 * A notification is not a leaf. Two tables point at it: `notification_events`,
 * written every time somebody opens, acknowledges, resolves or dismisses one,
 * and `push_deliveries`, written when it is queued to a phone. Deleting the
 * notification without clearing those first fails with
 *
 *     FOREIGN KEY constraint failed
 *
 * which is what a laboratory saw when it tried to remove a declaration form
 * that anybody had actually opened. It worked on a freshly created one and
 * failed on every real one — the worst shape of bug, because it looks like it
 * works until it matters.
 *
 * So notifications are deleted through here, children first, and nowhere else.
 */
import type BetterSqlite3 from 'better-sqlite3';

type Db = BetterSqlite3.Database;

function tableExists(db: Db, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

/**
 * Delete the notifications matching `where` (a fragment against `notifications`,
 * without the keyword) and everything that references them.
 *
 * Returns how many notifications went, so a caller can say so.
 */
export function deleteNotificationsWhere(db: Db, where: string, params: unknown[]): number {
  const rows = db.prepare(`SELECT id FROM notifications WHERE ${where}`).all(...params) as Array<{ id: number }>;
  if (rows.length === 0) return 0;
  const ids = rows.map(r => Number(r.id));
  const list = ids.map(() => '?').join(',');

  // The children first, and only the tables this installation actually has —
  // an older database may predate either of them.
  if (tableExists(db, 'notification_events')) {
    db.prepare(`DELETE FROM notification_events WHERE notification_id IN (${list})`).run(...ids);
  }
  if (tableExists(db, 'push_deliveries')) {
    db.prepare(`DELETE FROM push_deliveries WHERE notification_id IN (${list})`).run(...ids);
  }
  db.prepare(`DELETE FROM notifications WHERE id IN (${list})`).run(...ids);
  return ids.length;
}
