/**
 * What an analyser actually said, read with today's parser.
 *
 * `iqc_feed_messages.parsed_values` is a CACHE. The record is `raw_message` —
 * the transmission, verbatim, written down before anything tried to understand
 * it, which is the whole reason it is stored at all. When the reading improves,
 * everything already on the bench should improve with it.
 *
 * That is not hypothetical. A Sysmex XN writes its universal test ID as
 * `^^^^WBC^1`, and a parser taking the last component read every parameter of
 * every XbarM transmission as `1`. Sixteen parameters arrived, sixteen were
 * stored, and the control screen filled in none of them. Fixing the parser
 * fixes what arrives next; re-reading the raw message is what fixes the runs
 * already sitting on the bench, without rewriting a single stored row.
 *
 * It is conservative about it. The re-reading is used only when it yields at
 * least as many parameters as the cache held, so a message the current parser
 * understands LESS well than whatever stored it keeps what it had.
 */
import { effectiveProtocol, parseFor } from './instrumentBridge/protocols.js';
import { mapAnalyte } from '../../shared/constants/instruments.js';

export interface FeedValue {
  /** The analyser's own mnemonic. */
  code?: string;
  /** That mnemonic under this system's names, where the link maps it. */
  analyte?: string;
  value?: unknown;
  unit?: string | null;
  flag?: string | null;
}

function safeJson(value: unknown): any {
  if (typeof value !== 'string' || !value.trim()) return null;
  try { return JSON.parse(value); } catch { return null; }
}

export function feedMessageValues(db: any, message: any): FeedValue[] {
  const stored: FeedValue[] = (safeJson(message?.parsed_values) as FeedValue[]) ?? [];
  const raw = String(message?.raw_message ?? '');
  if (!raw.trim()) return stored;

  let link: any = null;
  try {
    link = message.link_id
      ? db.prepare('SELECT profile_key, analyte_map, protocol FROM instrument_links WHERE id = ?').get(message.link_id)
      : null;
  } catch { link = null; }

  try {
    const parsed = parseFor(effectiveProtocol(link?.protocol, raw), raw);
    if (!parsed.length) return stored;
    // One transmission can carry more than one sample. Take the one this row is
    // about rather than merging two patients' parameters into one control run.
    const wanted = String(message?.sample_id ?? '').trim();
    const picked = (wanted && parsed.find(m => String(m.sampleId ?? '').trim() === wanted)) || parsed[0];
    if (!picked?.results?.length) return stored;

    const linkMap = (safeJson(link?.analyte_map) as Record<string, string> | null) ?? {};
    const fresh: FeedValue[] = picked.results.map(r => ({
      code: r.code,
      analyte: mapAnalyte(r.code, linkMap, link?.profile_key ?? null),
      value: r.value,
      unit: r.unit,
      flag: r.flag,
    }));
    return fresh.length >= stored.length ? fresh : stored;
  } catch {
    // A message the parser chokes on is still a message; the cache stands.
    return stored;
  }
}

/**
 * What a transmission is, said in the names a bench uses.
 *
 * The row in `iqc_feed_messages` carries ids: which link, which control. A
 * preview of it has to say "Haematology Sysmex XN-550" and "XN CHECK — Level 1",
 * and reading those off the ids is the same two joins wherever it is done. So
 * it is done once, here, and the module and the bench show the same words.
 */
export function messageFacts(db: any, message: any): {
  source_name: string | null; equipment_name: string | null;
  material_name: string | null; level_label: string | null; test_name: string | null;
} {
  const blank = {
    source_name: null, equipment_name: null,
    material_name: null, level_label: null, test_name: null,
  };
  if (!message) return blank;
  try {
    const source = message.feed_id
      ? db.prepare(`SELECT f.name, e.name AS equipment_name FROM iqc_instrument_feeds f
            LEFT JOIN equipment_items e ON e.id = f.equipment_id WHERE f.id = ?`).get(message.feed_id)
      : message.link_id
        ? db.prepare(`SELECT l.name, e.name AS equipment_name FROM instrument_links l
            LEFT JOIN equipment_items e ON e.id = l.equipment_id WHERE l.id = ?`).get(message.link_id)
        : null;
    // The control it was READ as, which is not always the control it is being
    // looked at against — and saying so is the whole point of showing it.
    const material = message.iqc_material_id
      ? db.prepare('SELECT material_name, level_label, test_name FROM iqc_materials WHERE id = ?')
        .get(message.iqc_material_id)
      : null;
    return {
      source_name: source?.name ?? null,
      equipment_name: source?.equipment_name ?? null,
      material_name: material?.material_name ?? null,
      level_label: material?.level_label ?? null,
      test_name: material?.test_name ?? null,
    };
  } catch {
    // Names are a courtesy; the readings are the answer.
    return blank;
  }
}
