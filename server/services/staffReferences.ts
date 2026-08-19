/**
 * Everywhere a staff record is referenced.
 *
 * The staff register is the spine of the system: a person is the reviewer of a
 * nonconformity, the owner of a CAPA, the signatory of a competency record and
 * the name on a duty roster. An accredited laboratory may not lose any of that,
 * so a person who has done work is retired (deactivated) rather than erased —
 * their history keeps naming them.
 *
 * A record that has done nothing at all is different: demonstration rows, a
 * typo'd duplicate, an import that landed twice. Those may be erased outright,
 * and this module is what tells the two apart.
 *
 * Discovery mirrors userReferences: declared foreign keys are the obvious
 * source, but plenty of staff columns are plain INTEGERs with no REFERENCES
 * clause, so column names are matched on every table as well.
 */
import { getDb } from '../db/database.js';

/**
 * Column names that hold a staff id across this schema. Matched on every table
 * in addition to whatever foreign keys are declared. Anything ending in
 * `_staff_id` is picked up automatically (there are dozens: reviewed_by_staff_id,
 * closed_by_staff_id, responsible_staff_id …), so only the irregular ones are
 * listed here.
 */
const STAFF_COLUMN_NAMES = new Set([
  'staff_id', 'facilitator_staff_id', 'trainer_staff_id', 'assessor_staff_id',
  'appraiser_staff_id', 'supervisor_staff_id', 'delegate_staff_id',
]);

const isStaffColumn = (name: string) => STAFF_COLUMN_NAMES.has(name) || /_staff_id$/.test(name);

/**
 * Tables that describe how a person is wired into the organisation rather than
 * what they did. They go with the record when it is erased; they never block
 * the erase, because nothing in them is a laboratory result, decision or
 * signature.
 */
export const DISPOSABLE_STAFF_TABLES = new Set([
  'staff_position_assignments',
  'technical_authorizations',
  'staff_orientations',
  // Delivery, not record: an alert routed to somebody is a message about a
  // record, never the record itself. Leaving these in blocked exactly the case
  // this exists for — a demonstration row that the alert scanner had written to.
  'notifications',
  'push_subscriptions',
  'notification_preferences',
]);

/**
 * Tables where only some rows are a record. An attestation somebody signed is
 * evidence they read a controlled document and must survive; one merely
 * assigned to them and never signed is a to-do list entry, and goes with the
 * record. The condition is the SQL that identifies the rows that DO block.
 */
const CONDITIONAL_STAFF_TABLES: Record<string, string> = {
  document_attestations: "status = 'signed'",
};

export type StaffReference = { table: string; column: string; rows: number };

/** Every (table, column) that currently points at this staff record. */
export function referencesToStaff(staffId: number): StaffReference[] {
  const db = getDb();
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
  const found: StaffReference[] = [];

  for (const { name } of tables) {
    if (name === 'staff') continue;

    const columns = new Set<string>();
    try {
      for (const fk of db.prepare(`PRAGMA foreign_key_list("${name}")`).all() as { table: string; from: string }[]) {
        if (fk.table === 'staff') columns.add(fk.from);
      }
      for (const col of db.prepare(`PRAGMA table_info("${name}")`).all() as { name: string }[]) {
        if (isStaffColumn(col.name)) columns.add(col.name);
      }
    } catch { continue; }

    const onlyIf = CONDITIONAL_STAFF_TABLES[name];
    for (const column of columns) {
      try {
        const rows = (db.prepare(`SELECT COUNT(*) c FROM "${name}" WHERE "${column}" = ?${onlyIf ? ` AND (${onlyIf})` : ''}`).get(staffId) as { c: number }).c;
        if (rows > 0) found.push({ table: name, column, rows });
      } catch { /* a view, or the column vanished — nothing to count */ }
    }
  }
  return found.sort((a, b) => b.rows - a.rows);
}

/** The references that make a staff record un-erasable: everything but wiring. */
export function historicStaffReferences(staffId: number): StaffReference[] {
  return referencesToStaff(staffId).filter(r => !DISPOSABLE_STAFF_TABLES.has(r.table));
}

/** Remove the organisational-wiring rows for a record about to be erased. */
export function purgeDisposableStaffRows(staffId: number): void {
  const db = getDb();
  // The rows of a conditional table that were never a record go too — an
  // attestation nobody ever signed has nothing to say once the person is gone.
  for (const [table, blocks] of Object.entries(CONDITIONAL_STAFF_TABLES)) {
    try { db.prepare(`DELETE FROM "${table}" WHERE staff_id = ? AND NOT (${blocks})`).run(staffId); } catch { /* absent */ }
  }
  for (const table of DISPOSABLE_STAFF_TABLES) {
    const columns = new Set<string>();
    try {
      for (const fk of db.prepare(`PRAGMA foreign_key_list("${table}")`).all() as { table: string; from: string }[]) {
        if (fk.table === 'staff') columns.add(fk.from);
      }
      for (const col of db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]) {
        if (isStaffColumn(col.name)) columns.add(col.name);
      }
    } catch { continue; }
    for (const column of columns) {
      try { db.prepare(`DELETE FROM "${table}" WHERE "${column}" = ?`).run(staffId); } catch { /* absent */ }
    }
  }
}

/**
 * A plain-language name for a table, so the screen can say "3 nonconformities"
 * rather than "nonconforming_events (3)". Anything unmapped falls back to the
 * table name with underscores opened out.
 */
const TABLE_LABELS: Record<string, string> = {
  actions: 'assigned actions',
  audit_logs: 'audit trail entries',
  capa_records: 'CAPA records',
  competency_assessments: 'competency assessments',
  complaints: 'complaints',
  document_attestations: 'document attestations',
  duty_roster_entries: 'duty roster entries',
  equipment_items: 'equipment assignments',
  nonconforming_events: 'nonconformities',
  performance_appraisals: 'performance appraisals',
  risks: 'risk register entries',
  safety_incidents: 'safety incidents',
  staff_declarations: 'signed declarations',
  staff_documents: 'personnel documents',
  training_attendance: 'training attendance',
  users: 'login account',
};

/** Singular forms, for the rows where "1 nonconformities" would read badly. */
const SINGULAR: Record<string, string> = {
  'assigned actions': 'assigned action',
  'CAPA records': 'CAPA record',
  'competency assessments': 'competency assessment',
  'complaints': 'complaint',
  'document attestations': 'document attestation',
  'duty roster entries': 'duty roster entry',
  'equipment assignments': 'equipment assignment',
  'nonconformities': 'nonconformity',
  'performance appraisals': 'performance appraisal',
  'risk register entries': 'risk register entry',
  'safety incidents': 'safety incident',
  'signed declarations': 'signed declaration',
  'personnel documents': 'personnel document',
  'training attendance': 'training attendance record',
  'audit trail entries': 'audit trail entry',
};

export function describeStaffReference(ref: StaffReference): string {
  const plural = TABLE_LABELS[ref.table] ?? ref.table.replace(/_/g, ' ');
  const label = ref.rows === 1 ? (SINGULAR[plural] ?? plural.replace(/s$/, '')) : plural;
  return `${ref.rows} ${label}`;
}
