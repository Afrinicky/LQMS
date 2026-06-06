function countRecordsForYear(db: any, table: string, year: string) {
  return db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE strftime('%Y', created_at) = ?`).get(year).count as number;
}

export function generateRecordNumber(db: any, table: string, prefix: string, createdAt?: string) {
  const date = createdAt ? new Date(createdAt) : new Date();
  const year = String(date.getFullYear());
  const count = countRecordsForYear(db, table, year);
  return `${prefix}-${year}-${String(count + 1).padStart(4, '0')}`;
}
