/**
 * One transmission, lined up against one control's parameters.
 *
 * Shown before anything is saved. A system that decides column four is MCHC
 * and is wrong has written a false control record with a real name on it.
 *
 * The module and the bench both ask this question, and a batch of runs asks it
 * many times in a row, so it is answered in one place. Two screens mapping the
 * same transmission differently is how a control record stops meaning anything.
 */
import { bestLabel, mapRows, type Mapping } from './iqcAnalyteMatching.js';
import { feedMessageValues, messageFacts } from './feedMessageValues.js';

type DB = any;

function safeJson(value: unknown): any {
  if (typeof value !== 'string' || !value.trim()) return null;
  try { return JSON.parse(value); } catch { return null; }
}

export interface FeedMapping extends Mapping {
  message: Record<string, unknown>;
  materialId: number;
}

/** The parameters a control measures, in the order it defines them. */
export function controlAnalytes(db: DB, materialId: number): any[] {
  return db.prepare('SELECT * FROM iqc_analytes WHERE iqc_material_id = ? AND is_active = 1 ORDER BY display_order, id')
    .all(materialId) as any[];
}

/**
 * Line one message up against a control's parameters.
 *
 * The values are read from the transmission itself rather than from the cache
 * beside it, so a run already on the bench gets the benefit of every later
 * improvement to the parser — see `feedMessageValues`. Both the mapped name and
 * the analyser's own mnemonic are offered to the matcher, because a control
 * whose parameter is called "HGB" and one whose parameter is called
 * "Haemoglobin" are the same control to a bench, and only one of the two labels
 * will match either of them.
 */
export function mapFeedMessage(db: DB, message: any, materialId: number, analytes?: any[]): FeedMapping {
  const parameters = analytes ?? controlAnalytes(db, materialId);
  const values = feedMessageValues(db, message);

  // The map that named these parameters. A message from a bridge link has no
  // feed, and reading the feed table for it returns nothing — so every analyte
  // would come through under the analyser's own mnemonic and match nothing.
  const source = message.feed_id
    ? db.prepare('SELECT analyte_map FROM iqc_instrument_feeds WHERE id = ?').get(message.feed_id) as any
    : message.link_id
      ? db.prepare('SELECT analyte_map FROM instrument_links WHERE id = ?').get(message.link_id) as any
      : null;
  const map = (safeJson(source?.analyte_map) as Record<string, string> | null) ?? {};

  const grid = values.map(v => [bestLabel([map[String(v.analyte)] ?? v.analyte, v.code], parameters), v.value]);
  /*
   * The unit each reading actually arrived in, carried alongside the grid.
   *
   * It used to be dropped here, and `readings[].unit` then reported the
   * CONTROL's unit beside the analyser's number — so a screen showed 0.2673
   * labelled 10^9/L when the analyser had sent 10^6/uL, and the run was
   * charted against a mean a thousand times larger. The reading's own unit is
   * the only thing that can settle that, so it travels with it.
   */
  const units = values.map(v => (v as { unit?: string | null }).unit ?? null);
  return {
    message: { ...message, parsed_values: values, ...messageFacts(db, message) },
    materialId,
    ...mapRows(grid, parameters, units),
  };
}

/**
 * Several messages, against the same control, in the order they were asked for.
 *
 * What a batch of runs needs: one request rather than one per transmission, and
 * the control's parameters read once rather than once a message. A message that
 * is no longer there is left out rather than failing the lot — the caller is
 * entering what it selected, and an id that has since been rejected is not a
 * reason to refuse the other forty.
 */
export function mapFeedMessages(db: DB, ids: number[], materialId: number): FeedMapping[] {
  const analytes = controlAnalytes(db, materialId);
  const out: FeedMapping[] = [];
  const get = db.prepare('SELECT * FROM iqc_feed_messages WHERE id = ?');
  for (const id of ids) {
    const message = get.get(id) as any;
    if (!message) continue;
    out.push(mapFeedMessage(db, message, materialId, analytes));
  }
  return out;
}

/** The ids a caller listed, as numbers, deduplicated and bounded. */
export function messageIds(raw: unknown, limit: number): number[] {
  const text = Array.isArray(raw) ? raw.join(',') : String(raw ?? '');
  const seen = new Set<number>();
  for (const part of text.split(',')) {
    const id = Number(String(part).trim());
    if (Number.isInteger(id) && id > 0) seen.add(id);
    if (seen.size >= limit) break;
  }
  return [...seen];
}
