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
 *
 * ----------------------------------------------------------------------------
 * THE WINDOW IS OPENED FOR A REASON, AND THE REASON NARROWS IT
 * ----------------------------------------------------------------------------
 * Opened from a control, it answers "what has this control transmitted?" and
 * shows that control's runs only. Opened from the board, it answers "what has
 * arrived?" and shows everything. Those are different questions, and answering
 * the first with the second is how a bench recording Level 3 was offered Level
 * 1's runs — the mistake this scoping exists to prevent.
 *
 * The pickers are built from what the laboratory HAS REGISTERED, not from what
 * has happened to arrive. A control picker assembled out of the transmissions
 * themselves can only ever offer the controls something has already matched to,
 * so the control somebody is looking for — the one whose runs are all sitting
 * unmatched — is precisely the one missing from it.
 */

export interface TransmissionFilter {
  /** Only runs from this analyser: a link id, or 'link:3' / 'feed:2'. */
  source?: string | number | null;
  /** Kept for callers that name a bridge link directly. */
  linkId?: number | null;
  /**
   * Which control's runs. A number means that control; 'unmatched' means the
   * runs no control was matched to; null means every control.
   */
  materialId?: number | string | null;
  /**
   * With `materialId`, also show runs matched to NO control that arrived from
   * this control's own analyser.
   *
   * An analyser that puts no lot number in its transmission leaves every run of
   * every control unmatched, so a laboratory with one of those would otherwise
   * open an empty window. It is off by default — a run matched to nothing is
   * not evidence that it is this control's — and the screen says plainly how
   * many are waiting behind it.
   */
  includeUnmatched?: boolean;
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
  /** Every analyser that could transmit, as 'link:3' / 'feed:2'. */
  sources: Array<{ id: string; name: string }>;
  /** Every control this laboratory has registered, in scope. */
  controls: Array<{ id: number; name: string }>;
  /**
   * How many runs match everything EXCEPT the control, and are matched to no
   * control at all. What the empty window has to be able to say.
   */
  unmatchedAvailable: number;
}

function day(value: unknown): string | null {
  const raw = String(value ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
}

/** 'link:3' / 'feed:2' / '3', as {kind, id}. A bare number is a link. */
function readSource(value: unknown): { kind: 'link' | 'feed'; id: number } | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const match = /^(link|feed):(\d+)$/.exec(raw);
  if (match) return { kind: match[1] as 'link' | 'feed', id: Number(match[2]) };
  return /^\d+$/.test(raw) ? { kind: 'link', id: Number(raw) } : null;
}

/**
 * The links and feeds that belong to one control's instrument.
 *
 * Which analyser a control is run on is the control's own instrument and
 * nothing wider — the rule, and why it is drawn exactly there, is in
 * `controlAnalyser.ts`. This is the same question asked of the register: an
 * unmatched run is this control's business only if it came off this control's
 * machine.
 */
function sourcesOfControl(db: any, materialId: number): { links: number[]; feeds: number[] } {
  try {
    const material = db.prepare('SELECT equipment_id, feed_id FROM iqc_materials WHERE id = ?').get(materialId) as any;
    if (!material) return { links: [], feeds: [] };
    const links = material.equipment_id
      ? (db.prepare('SELECT id FROM instrument_links WHERE equipment_id = ?').all(material.equipment_id) as any[]).map(r => Number(r.id))
      : [];
    const feeds: number[] = [];
    if (material.feed_id) feeds.push(Number(material.feed_id));
    if (material.equipment_id) {
      for (const row of db.prepare('SELECT id FROM iqc_instrument_feeds WHERE equipment_id = ? AND is_active = 1')
        .all(material.equipment_id) as any[]) feeds.push(Number(row.id));
    }
    return { links, feeds: [...new Set(feeds)] };
  } catch { return { links: [], feeds: [] }; }
}

export function listTransmissions(db: any, filter: TransmissionFilter): TransmissionPage {
  const states = STATES[String(filter.state ?? 'waiting')] ?? null;
  const from = day(filter.from);
  const to = day(filter.to);
  const search = String(filter.search ?? '').trim();
  const like = search ? `%${search.toLowerCase()}%` : null;
  const limit = Math.min(Math.max(Number(filter.limit ?? 50) || 50, 1), 200);
  const offset = Math.max(Number(filter.offset ?? 0) || 0, 0);
  const source = readSource(filter.source ?? filter.linkId);

  const wantedControl = typeof filter.materialId === 'string' && filter.materialId.trim() === 'unmatched'
    ? 'unmatched' as const
    : (Number(filter.materialId) || null);

  // Written once and used for the page, the count and the pickers, so a filter
  // can never mean one thing in the list and another in the number beside it.
  const where: string[] = [];
  const args: any[] = [];

  if (states) { where.push(`m.status IN (${states.map(() => '?').join(', ')})`); args.push(...states); }
  if (source) {
    where.push(source.kind === 'link' ? 'm.link_id = ?' : 'm.feed_id = ?');
    args.push(source.id);
  }

  if (wantedControl === 'unmatched') {
    where.push('m.iqc_material_id IS NULL');
  } else if (wantedControl) {
    if (filter.includeUnmatched) {
      // This control's runs, and the ones matched to nothing that came off its
      // own machine. Never another control's.
      const { links, feeds } = sourcesOfControl(db, wantedControl);
      const unmatchedFrom: string[] = [];
      if (links.length) unmatchedFrom.push(`m.link_id IN (${links.map(() => '?').join(', ')})`);
      if (feeds.length) unmatchedFrom.push(`m.feed_id IN (${feeds.map(() => '?').join(', ')})`);
      if (unmatchedFrom.length) {
        where.push(`(m.iqc_material_id = ? OR (m.iqc_material_id IS NULL AND (${unmatchedFrom.join(' OR ')})))`);
        args.push(wantedControl, ...links, ...feeds);
      } else {
        // No analyser is registered against the control, so there is no machine
        // an unmatched run could have come off. Its own runs, then.
        where.push('m.iqc_material_id = ?');
        args.push(wantedControl);
      }
    } else {
      where.push('m.iqc_material_id = ?');
      args.push(wantedControl);
    }
  }

  /*
   * A day matches when EITHER stamp falls INSIDE the window.
   *
   * These two dates are not the same date, and on a haematology analyser they
   * are routinely weeks apart. A Sysmex X-bar M file carries the day the stored
   * moving average was computed; an analyser with a drifting clock stamps
   * whatever it believes the date to be. Either way the run reached this host
   * when it reached it, and that is the only one of the two this system
   * witnessed. Somebody narrowing to a day could mean either — "the control we
   * ran on Monday", or "what came in on Monday" — so both are honoured.
   *
   * The two bounds are applied to ONE stamp at a time. Tested separately, a
   * transmission received in October and stamped September satisfied "on or
   * after 1 October" by its arrival and "on or before 5 October" by its stamp,
   * and turned up in a window neither of its dates is in.
   */
  if (from || to) {
    const window = (column: string) => {
      const parts: string[] = [`${column} IS NOT NULL`];
      if (from) parts.push(`date(${column}) >= ?`);
      if (to) parts.push(`date(${column}) <= ?`);
      return `(${parts.join(' AND ')})`;
    };
    const bounds: any[] = [];
    if (from) bounds.push(from);
    if (to) bounds.push(to);
    where.push(`(${window('m.received_at')} OR ${window('m.instrument_run_at')})`);
    args.push(...bounds, ...bounds);
  }

  if (like) {
    where.push(`(LOWER(IFNULL(m.sample_id, '')) LIKE ? OR LOWER(IFNULL(m.lot_number, '')) LIKE ?
      OR LOWER(IFNULL(mat.material_name, '')) LIKE ? OR LOWER(IFNULL(mat.test_name, '')) LIKE ?
      OR LOWER(IFNULL(mat.level_label, '')) LIKE ?
      OR LOWER(IFNULL(COALESCE(f.name, l.name), '')) LIKE ?)`);
    args.push(like, like, like, like, like, like);
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

  /*
   * The pickers, built from the register of controls and analysers rather than
   * from the transmissions.
   *
   * Assembled out of the transmissions, a picker can only offer what has
   * already matched: a laboratory with twenty controls and three of them ever
   * matched was shown three, and the seventeen somebody actually wanted to
   * narrow to were unreachable. The denominator is what the laboratory has
   * registered.
   */
  const unit = filter.sectionId ?? null;
  let sources: Array<{ id: string; name: string }> = [];
  let controls: Array<{ id: number; name: string }> = [];
  try {
    const links = db.prepare(`SELECT l.id, l.name, e.name AS equipment_name
        FROM instrument_links l LEFT JOIN equipment_items e ON e.id = l.equipment_id
        WHERE l.name IS NOT NULL AND COALESCE(l.is_active, 1) = 1
          AND (? IS NULL OR l.section_id IS NULL OR l.section_id = ?)
        ORDER BY l.name`).all(unit, unit) as any[];
    const feeds = db.prepare(`SELECT f.id, f.name, e.name AS equipment_name
        FROM iqc_instrument_feeds f LEFT JOIN equipment_items e ON e.id = f.equipment_id
        WHERE f.name IS NOT NULL AND COALESCE(f.is_active, 1) = 1
          AND (? IS NULL OR f.section_id IS NULL OR f.section_id = ?)
        ORDER BY f.name`).all(unit, unit) as any[];
    sources = [
      ...links.map(l => ({ id: `link:${l.id}`, name: l.equipment_name && l.equipment_name !== l.name ? `${l.name} · ${l.equipment_name}` : String(l.name) })),
      ...feeds.map(f => ({ id: `feed:${f.id}`, name: f.equipment_name && f.equipment_name !== f.name ? `${f.name} · ${f.equipment_name}` : String(f.name) })),
    ];
  } catch { /* the list is the answer; the pickers are a convenience */ }
  try {
    controls = (db.prepare(`SELECT mat.id,
          mat.material_name || CASE WHEN mat.level_label IS NOT NULL AND mat.level_label != ''
            THEN ' — ' || mat.level_label ELSE '' END
          || CASE WHEN mat.lot_number IS NOT NULL AND mat.lot_number != ''
            THEN ' · lot ' || mat.lot_number ELSE '' END AS name
        FROM iqc_materials mat
        LEFT JOIN equipment_items e ON e.id = mat.equipment_id
        WHERE mat.is_active = 1
          AND (? IS NULL OR COALESCE(mat.performing_section_id, mat.section_id, e.section_id) IS NULL
               OR COALESCE(mat.performing_section_id, mat.section_id, e.section_id) = ?)
        ORDER BY mat.test_name, mat.material_name, mat.level_label`).all(unit, unit) as any[])
      .map(r => ({ id: Number(r.id), name: String(r.name) }));
  } catch { /* as above */ }

  /*
   * How many runs are waiting that no control was matched to.
   *
   * Counted against the same filters minus the control itself, because it is
   * the answer to the one question an empty control-scoped window raises: is
   * there nothing, or is it all sitting unmatched?
   */
  let unmatchedAvailable = 0;
  if (wantedControl && wantedControl !== 'unmatched') {
    try {
      const { links, feeds } = sourcesOfControl(db, wantedControl);
      const scope: string[] = [];
      const scopeArgs: any[] = [];
      if (links.length) { scope.push(`m.link_id IN (${links.map(() => '?').join(', ')})`); scopeArgs.push(...links); }
      if (feeds.length) { scope.push(`m.feed_id IN (${feeds.map(() => '?').join(', ')})`); scopeArgs.push(...feeds); }
      if (scope.length) {
        const statusClause = states ? `AND m.status IN (${states.map(() => '?').join(', ')})` : '';
        unmatchedAvailable = Number((db.prepare(`SELECT COUNT(*) AS n FROM iqc_feed_messages m
            WHERE m.iqc_material_id IS NULL AND (${scope.join(' OR ')}) ${statusClause}`)
          .get(...scopeArgs, ...(states ?? [])) as any)?.n ?? 0);
      }
    } catch { /* a count is a courtesy */ }
  }

  return { rows, total, sources, controls, unmatchedAvailable };
}
