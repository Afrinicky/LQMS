/**
 * The core operational record tables a sync engine replicates. Shared by the
 * schema migration (which adds uuid/updated_at/deleted_at + capture triggers)
 * and the sync engine (which pushes/pulls them). Config singletons, append-only
 * logs and auth tables are intentionally excluded. See docs/SYNC_READY_SCHEMA.md.
 */
export const SYNCABLE_TABLES = [
  'nonconforming_events', 'capa_records', 'complaints', 'risks',
  'equipment_items', 'equipment_maintenance_records', 'equipment_calibration_records',
  'inventory_items', 'inventory_batches', 'suppliers',
  'monitoring_items', 'monitoring_readings', 'safety_incidents',
  'actions', 'documents', 'document_versions',
  'iqc_materials', 'iqc_results', 'eqa_programs', 'eqa_events',
  'staff',
] as const;

export type SyncableTable = typeof SYNCABLE_TABLES[number];

export function isSyncableTable(name: string): name is SyncableTable {
  return (SYNCABLE_TABLES as readonly string[]).includes(name);
}
