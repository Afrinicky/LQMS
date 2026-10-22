/**
 * Every configuration change, and the way back.
 *
 * A clinical interface is a controlled thing. "Who changed the mapping on
 * Friday, and what was it before?" has to have an answer, and "put it back"
 * has to be one action rather than an archaeology exercise.
 *
 * So every write to a destination, a route or a mapping records the row BEFORE
 * and the row AFTER. Rolling back writes the old row again and records THAT as
 * a new version — the history is append-only, because erasing the record of a
 * change to a system that carries patient results is worse than the change.
 *
 * Secrets never enter a version. The encrypted credential column is dropped
 * from both snapshots, so a rollback restores the configuration and leaves the
 * credential alone — which is also the only safe behaviour, since an old
 * snapshot's credential may have been revoked.
 */
import { scrubSecrets } from './secrets.js';

type DB = any;

/** Columns a snapshot never carries, whatever table it came from. */
const NEVER_SNAPSHOT = new Set(['secret_cipher', 'lhims_password']);

export type VersionScope = 'destination' | 'route' | 'mapping';

export interface VersionEntry {
  id: number;
  scope: string;
  entity_id: number | null;
  entity_code: string | null;
  entity_name: string | null;
  action: string;
  before_json: unknown;
  after_json: unknown;
  reason: string | null;
  created_by: number | null;
  created_at: string;
  changed_by?: string | null;
  /** Which fields actually differ, so a screen need not diff them itself. */
  changes?: Array<{ field: string; from: string; to: string }>;
}

/** A row, with everything that must not be stored taken out. */
export function snapshot(row: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!row) return null;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (NEVER_SNAPSHOT.has(key)) continue;
    out[key] = typeof value === 'string' ? scrubSecrets(value) : value;
  }
  return out;
}

/** Write one version. Never throws: the change has happened, and the record follows it. */
export function recordVersion(db: DB, entry: {
  scope: VersionScope;
  entityId: number | null;
  entityCode?: string | null;
  entityName?: string | null;
  action: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  reason?: string | null;
  userId: number | null;
  dennisActionId?: number | null;
  rolledBackFrom?: number | null;
}): number | null {
  try {
    const result = db.prepare(`INSERT INTO mw_config_versions
        (scope, entity_id, entity_code, entity_name, action, before_json, after_json, reason, dennis_action_id, rolled_back_from, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(entry.scope, entry.entityId, entry.entityCode ?? null, entry.entityName ?? null, entry.action,
        entry.before ? JSON.stringify(snapshot(entry.before)) : null,
        entry.after ? JSON.stringify(snapshot(entry.after)) : null,
        entry.reason ?? null, entry.dennisActionId ?? null, entry.rolledBackFrom ?? null, entry.userId);
    return Number(result.lastInsertRowid);
  } catch { return null; }
}

/** The history of one thing, or of everything, newest first. */
export function versionHistory(db: DB, filter?: { scope?: VersionScope | null; entityId?: number | null; limit?: number | null }): VersionEntry[] {
  const limit = Math.min(500, Math.max(1, Number(filter?.limit ?? 100)));
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter?.scope) { where.push('v.scope = ?'); params.push(filter.scope); }
  if (filter?.entityId != null) { where.push('v.entity_id = ?'); params.push(filter.entityId); }
  params.push(limit);
  try {
    const rows = db.prepare(`SELECT v.*, u.full_name AS changed_by FROM mw_config_versions v
        LEFT JOIN users u ON u.id = v.created_by
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY v.id DESC LIMIT ?`).all(...params) as any[];
    return rows.map(row => {
      const before = parse(row.before_json);
      const after = parse(row.after_json);
      return { ...row, before_json: before, after_json: after, changes: diff(before, after) };
    });
  } catch { return []; }
}

/**
 * Put a configuration back to what one version recorded.
 *
 * Restores the fields that configuration actually consists of, and nothing
 * else: identity, counters, approval and timestamps stay as they are, because
 * a rollback is a change to settings and not a claim that the approval or the
 * delivery history also went backwards.
 *
 * A protected destination is refused outright — it is held read-only, so there
 * is nothing here to roll back.
 */
export function rollbackTo(db: DB, versionId: number, userId: number | null, reason: string | null): {
  ok: boolean; note: string; versionId: number | null;
} {
  const version = db.prepare('SELECT * FROM mw_config_versions WHERE id = ?').get(versionId) as any;
  if (!version) return { ok: false, note: 'That version is not on the record.', versionId: null };

  // The state to go back TO is what the chosen version left behind. Rolling
  // back a deletion means putting the row back, which this does not do: a
  // deleted interface is re-created deliberately, with its own approval.
  const target = parse(version.after_json) ?? parse(version.before_json);
  if (!target) return { ok: false, note: 'That version holds no configuration to restore.', versionId: null };
  if (version.action === 'delete') {
    return { ok: false, note: 'This version records a deletion. Re-create the interface instead, so it goes through approval again.', versionId: null };
  }

  const table = version.scope === 'destination' ? 'mw_destinations'
    : version.scope === 'route' ? 'mw_routes'
    : version.scope === 'mapping' ? 'mw_mappings' : null;
  if (!table) return { ok: false, note: `Nothing of scope "${version.scope}" can be rolled back.`, versionId: null };

  const current = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(version.entity_id) as any;
  if (!current) return { ok: false, note: 'The record this version describes no longer exists.', versionId: null };
  if (table === 'mw_destinations' && current.is_protected) {
    return { ok: false, note: `${current.name} is a protected production connection, held read-only. There is nothing here to roll back.`, versionId: null };
  }

  const fields = RESTORABLE[version.scope as VersionScope].filter(field => field in target);
  if (!fields.length) return { ok: false, note: 'That version holds no restorable field.', versionId: null };

  const assignments = fields.map(field => `${field} = ?`).join(', ');
  const values = fields.map(field => (target as Record<string, unknown>)[field] ?? null);
  db.prepare(`UPDATE ${table} SET ${assignments}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...values, version.entity_id);

  // A destination whose settings have just changed under it is no longer the
  // thing that was approved. It goes back to awaiting approval rather than
  // quietly carrying clinical traffic on restored settings nobody has signed.
  if (table === 'mw_destinations' && current.state === 'active') {
    db.prepare(`UPDATE mw_destinations SET state = 'awaiting_approval',
        state_detail = 'Settings were rolled back. Test and approve before activating again.',
        approved_by = NULL, approved_at = NULL WHERE id = ?`).run(version.entity_id);
  }

  const after = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(version.entity_id) as any;
  const newVersion = recordVersion(db, {
    scope: version.scope as VersionScope,
    entityId: Number(version.entity_id),
    entityCode: version.entity_code,
    entityName: version.entity_name,
    action: 'rollback',
    before: current,
    after,
    reason: reason ?? `Rolled back to version ${versionId}.`,
    userId,
    rolledBackFrom: versionId,
  });

  return {
    ok: true,
    versionId: newVersion,
    note: table === 'mw_destinations' && current.state === 'active'
      ? `Settings restored from version ${versionId}. The destination now awaits approval again, so nothing is transmitted on restored settings until somebody signs for them.`
      : `Settings restored from version ${versionId}.`,
  };
}

/** The fields that ARE the configuration, per scope. */
const RESTORABLE: Record<VersionScope, string[]> = {
  destination: [
    'name', 'platform', 'transport', 'payload_format', 'host', 'port', 'base_url', 'use_tls',
    'username', 'auth_scheme', 'export_dir', 'file_template', 'sending_facility',
    'receiving_facility', 'receiving_application', 'ack_policy', 'ack_timeout_ms',
    'retry_max', 'retry_base_ms', 'retry_factor', 'transform', 'auto_deliver', 'notes',
  ],
  route: [
    'name', 'destination_id', 'priority', 'source_link_id', 'source_profile_key', 'message_kind',
    'test_codes', 'section_id', 'facility', 'department', 'transform', 'stop_on_match', 'is_active', 'notes',
  ],
  mapping: [
    'source_code', 'target_code', 'target_name', 'target_unit', 'factor', 'offset_value',
    'decimals', 'value_map', 'is_required', 'is_active', 'note',
  ],
};

function parse(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try { return JSON.parse(value); } catch { return null; }
}

/** Which fields differ between two snapshots, for the screen. */
function diff(before: Record<string, unknown> | null, after: Record<string, unknown> | null): Array<{ field: string; from: string; to: string }> {
  if (!before || !after) return [];
  const changes: Array<{ field: string; from: string; to: string }> = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    if (key === 'updated_at' || key === 'created_at') continue;
    const from = before[key] == null ? '' : String(before[key]);
    const to = after[key] == null ? '' : String(after[key]);
    if (from !== to) changes.push({ field: key, from, to });
  }
  return changes;
}
