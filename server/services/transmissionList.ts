/**
 * Every control run an analyser has sent, searchable.
 *
 * The run form shows the last few, because a bench running this morning's
 * control is looking for the one they have just put on the machine and nothing
 * else. But "the last few" is only tolerable if the rest is still reachable:
 * this laboratory has thousands waiting, and a run from a fortnight ago that
 * somebody needs to account for cannot simply fall off the bottom of a list.
 *
 * So the same rows are offered two ways — the newest handful inline, and all of
 * them in a window that can be narrowed by day, by control, by analyser or by
 * the sample identifier the machine used. One query serves both, and both
 * screens scope it their own way: the module by the right to view quality
 * control, the bench by the unit whose board it is.
 */

export interface TransmissionFilter {
  /** Only runs from this analyser link. */
  linkId?: number | null;
  /** Only runs the system matched to this control. */
  materialId?: number | null;
  /** Only runs on or after this day (YYYY-MM-DD). */
  from?: string | null;
  /** Only runs on or before this day (YYYY-MM-DD). */
  to?: string | null;
  /** Sample identifier, lot, control name or test, matched loosely. */
  search?: string | null;
  /** 'waiting' (the default), 'accepted', 'rejected' or 'all'. */
  state?: string | null;
  /** The unit whose board this is, for the bench. Null for the module. */
  sectionId?: number | null;
  limit?: number | null;
  offset?: number | null;
}

const STATES: Record<string, string[]> = {
  waiting: ['matched', 'unmatched'],
  accepted: ['accepted'],
  rejected: ['rejected'],
};

export interface TransmissionPage {
  rows: any[];
  /** How many match the filter in total, so the window can say so. */
  total: number;
  /** Every analyser that has ever sent one, for the window's own picker. */
  sources: Array<{ id: number; name: string }>;
  /** Every control these runs were matched to, likewise. */
  controls: Array<{ id: number; name: string }>;
}

function day(value: unknown): string | null {
  const raw = String(value ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
}

export function listTransmissions(db: any, filter: TransmissionFilter): TransmissionPage {
  const states = STATES[String(filter.state ?? 'waiting')] ?? null;
  const from = day(filter.from);
  const to = day(filter.to);
  const search = String(filter.search ?? '').trim();
  const like = search ? `%${search.toLowerCase()}%` : null;
  const limit = Math.min(Math.max(Number(filter.limit ?? 50) || 50, 1), 200);
  const offset = Math.max(Number(filter.offset ?? 0) || 0, 0);

  // Written once and used for the page, the count and the pickers, so a filter
  // can never mean one thing in the list and another in the number beside it.
  const where: string[] = [];
  const args: any[] = [];

  if (states) { where.push(`m.status IN (${states.map(() => '?').join(', ')})`); args.push(...states); }
  if (filter.linkId) { where.push('m.link_id = ?'); args.push(filter.linkId); }
  if (filter.materialId) { where.push('m.iqc_material_id = ?'); args.push(filter.materialId); }
  /*
   * A day matches if EITHER stamp falls in it.
   *
   * These two dates are not the same date, and on a haematology analyser they
   * are routinely weeks apart. A Sysmex X-bar M file carries the day the stored
   * moving average was computed; an analyser with a drifting clock stamps
   * whatever it believes the date to be. Either way the run reached this host
   * when it reached it, and that is the only one of the two this system
   * witnessed.
   *
   * Somebody narrowing to a day could mean either — "the control we ran on
   * Monday", or "what came in on Monday" — so both are honoured rather than
   * silently picking one and hiding the run under the other.
   */
  if (from) { where.push("(date(m.received_at) >= ? OR date(m.instrument_run_at) >= ?)"); args.push(from, from); }
  if (to) { where.push("(date(m.received_at) <= ? OR date(m.instrument_run_at) <= ?)"); args.push(to, to); }
  if (like) {
    where.push(`(LOWER(IFNULL(m.sample_id, '')) LIKE ? OR LOWER(IFNULL(m.lot_number, '')) LIKE ?
      OR LOWER(IFNULL(mat.material_name, '')) LIKE ? OR LOWER(IFNULL(mat.test_name, '')) LIKE ?
      OR LOWER(IFNULL(COALESCE(f.name, l.name), '')) LIKE ?)`);
    args.push(like, like, like, like, like);
  }
  // The bench sees its own unit's board and no other.
  if (filter.sectionId != null) {
    where.push(`(COALESCE(f.section_id, l.section_id) IS NULL OR COALESCE(f.section_id, l.section_id) = ?)`);
    args.push(filter.sectionId);
  }

  const joins = `FROM iqc_feed_messages m
      LEFT JOIN iqc_instrument_feeds f ON f.id = m.feed_id
      LEFT JOIN instrument_links l ON l.id = m.link_id
      LEFT JOIN equipment_items le ON le.id = l.equipment_id
      LEFT JOIN iqc_materials mat ON mat.id = m.iqc_material_id`;
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  let rows: any[] = [];
  let total = 0;
  try {
    // How many parameters came with it is the length of what was parsed out of
    // it; this table keeps no count of its own. Counted in SQL rather than by
    // shipping every reading of every row to a screen that only wants a number.
    //
    // Newest BY ARRIVAL. Ordering on the analyser's own stamp put a control
    // transmitted this morning somewhere in the middle of a fortnight of older
    // ones, because the machine had stamped it with the day its stored moving
    // average was computed. The register is a record of what this host
    // received, so it is ordered by when it received it, and both dates are
    // returned so a screen can show the difference rather than hide it.
    rows = db.prepare(`SELECT m.id, m.sample_id, m.lot_number, m.received_at, m.instrument_run_at,
          COALESCE(json_array_length(m.parsed_values), 0) AS result_count,
          m.status, m.status_note, m.iqc_material_id,
          COALESCE(f.name, l.name) AS source_name,
          COALESCE(le.name, '') AS equipment_name,
          mat.material_name, mat.test_name, mat.level_label
        ${joins} ${clause}
        ORDER BY m.received_at DESC, m.id DESC
        LIMIT ? OFFSET ?`).all(...args, limit, offset) as any[];
    total = Number((db.prepare(`SELECT COUNT(*) AS n ${joins} ${clause}`).get(...args) as any)?.n ?? 0);
  } catch (error) {
    // Silence here is how a mistyped column became an empty register that
    // looked like an empty laboratory. Say what happened, and say it is empty
    // because something went wrong rather than because nothing was sent.
    throw new Error(`The transmission register could not be read: ${(error as Error).message}`);
  }

  // The pickers offer only what is actually there — a laboratory with one
  // analyser should not be shown a dropdown, and one with six should not be
  // shown the two that have never transmitted.
  let sources: Array<{ id: number; name: string }> = [];
  let controls: Array<{ id: number; name: string }> = [];
  // Scoped the same way the list is. A bench narrowing its own unit's register
  // has no business being offered another unit's analysers to narrow it by.
  const unit = filter.sectionId ?? null;
  try {
    sources = db.prepare(`SELECT DISTINCT l.id AS id, l.name AS name
        FROM iqc_feed_messages m JOIN instrument_links l ON l.id = m.link_id
        WHERE l.name IS NOT NULL
          AND (? IS NULL OR l.section_id IS NULL OR l.section_id = ?)
        ORDER BY l.name`).all(unit, unit) as any[];
    controls = db.prepare(`SELECT DISTINCT mat.id AS id,
          mat.material_name || CASE WHEN mat.level_label IS NOT NULL AND mat.level_label != ''
            THEN ' — ' || mat.level_label ELSE '' END AS name
        FROM iqc_feed_messages m JOIN iqc_materials mat ON mat.id = m.iqc_material_id
        LEFT JOIN iqc_instrument_feeds f ON f.id = m.feed_id
        LEFT JOIN instrument_links l ON l.id = m.link_id
        WHERE (? IS NULL OR COALESCE(f.section_id, l.section_id) IS NULL
               OR COALESCE(f.section_id, l.section_id) = ?)
        ORDER BY name`).all(unit, unit) as any[];
  } catch { /* the list is the answer; the pickers are a convenience */ }

  return { rows, total, sources, controls };
}
