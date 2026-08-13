function countRecordsForYear(db: any, table: string, year: string) {
  return db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE strftime('%Y', created_at) = ?`).get(year).count as number;
}

/**
 * A human-readable record number, e.g. IQCM-2026-0007.
 *
 * When `codeColumn` is given (the UNIQUE column the number is written to) the
 * next sequence is derived from the highest number already issued for this
 * prefix and year, then advanced past any code that still exists. A plain
 * COUNT(*) breaks the moment a record is deleted — the count drops, the next
 * number repeats one already on file, and the insert fails with a UNIQUE
 * constraint error. Deriving from the maximum and checking existence is
 * immune to gaps, deletions and count drift; pass the column wherever the
 * generated number lands in a UNIQUE column.
 */
export function generateRecordNumber(db: any, table: string, prefix: string, createdAt?: string, codeColumn?: string) {
  const date = createdAt ? new Date(createdAt) : new Date();
  const year = String(date.getFullYear());

  if (codeColumn) {
    const rows = db.prepare(`SELECT ${codeColumn} AS code FROM ${table} WHERE ${codeColumn} LIKE ?`).all(`${prefix}-${year}-%`) as Array<{ code: string | null }>;
    let maxSeq = 0;
    for (const r of rows) {
      const m = /-(\d+)$/.exec(String(r.code ?? ''));
      if (m) maxSeq = Math.max(maxSeq, Number(m[1]));
    }
    const exists = db.prepare(`SELECT 1 FROM ${table} WHERE ${codeColumn} = ? LIMIT 1`);
    let seq = maxSeq + 1;
    let code = `${prefix}-${year}-${String(seq).padStart(4, '0')}`;
    while (exists.get(code)) { seq++; code = `${prefix}-${year}-${String(seq).padStart(4, '0')}`; }
    return code;
  }

  const count = countRecordsForYear(db, table, year);
  return `${prefix}-${year}-${String(count + 1).padStart(4, '0')}`;
}
