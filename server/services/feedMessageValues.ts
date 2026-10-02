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
