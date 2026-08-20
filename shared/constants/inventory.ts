/**
 * Supply and inventory control — the vocabulary and the rules.
 *
 * ISO 15189:2022 asks a laboratory to control what it buys and what it holds:
 * §6.6 for externally provided products and services, and §6.4/§6.5 for the
 * reagents and consumables themselves — received and inspected, stored as the
 * manufacturer requires, verified before use where performance depends on it,
 * traceable by lot and expiry, and used oldest-first so nothing expires on a
 * shelf while a newer box is opened.
 *
 * These constants are the parts of that a laboratory sees and chooses.
 */

/** The kinds of place stock lives in, coarse to fine. */
export const STORAGE_KINDS = [
  'store', 'room', 'unit', 'cupboard', 'shelf', 'rack', 'bin',
  'refrigerator', 'freezer', 'cold_room', 'incubator', 'other',
] as const;
export type StorageKind = typeof STORAGE_KINDS[number];

export const STORAGE_KIND_LABELS: Record<string, string> = {
  store: 'Store', room: 'Room', unit: 'Unit / section store', cupboard: 'Cupboard',
  shelf: 'Shelf', rack: 'Rack', bin: 'Bin', refrigerator: 'Refrigerator',
  freezer: 'Freezer', cold_room: 'Cold room', incubator: 'Incubator', other: 'Other',
};

/** Places that hold a temperature, and so carry a range to be checked against. */
export const COLD_STORAGE_KINDS = ['refrigerator', 'freezer', 'cold_room', 'incubator'];
export const isColdStorage = (kind?: string | null) => COLD_STORAGE_KINDS.includes(String(kind));

/**
 * Where an item's barcode comes from.
 *
 * Plenty of reagents arrive with a barcode already printed on the box, and
 * re-labelling them is both wasted effort and a chance to mislabel. Plenty of
 * others arrive with nothing. So the laboratory sets a default and each item
 * may differ from it — what must never happen is a scan that matches nothing
 * because the system assumed one and the box carries the other.
 */
export const BARCODE_SOURCES = ['system', 'product'] as const;
export type BarcodeSource = typeof BARCODE_SOURCES[number];

export const BARCODE_SOURCE_LABELS: Record<string, string> = {
  system: 'A barcode SECH_LIMS generates and you print',
  product: "The barcode already printed on the product",
};

/** What the laboratory does by default, and whether an item may differ. */
export type BarcodePolicy = {
  /** The default for a new item. */
  defaultSource: BarcodeSource;
  /** May an individual item use the other one? Almost always yes. */
  allowPerItem: boolean;
};
export const DEFAULT_BARCODE_POLICY: BarcodePolicy = { defaultSource: 'system', allowPerItem: true };

export function normaliseBarcodePolicy(input: unknown): BarcodePolicy {
  const raw = (input ?? {}) as Partial<BarcodePolicy>;
  return {
    defaultSource: BARCODE_SOURCES.includes(raw.defaultSource as never) ? raw.defaultSource as BarcodeSource : 'system',
    allowPerItem: raw.allowPerItem !== false,
  };
}

/**
 * The barcode a given item actually answers to.
 *
 * An item set to use the product's own barcode uses it; anything else — including
 * an item set to "product" whose barcode was never captured — falls back to the
 * code the system minted, so every item is always scannable by something.
 */
export function effectiveBarcode(item: { item_code?: string | null; product_barcode?: string | null; barcode_source?: string | null }): string {
  const product = (item.product_barcode ?? '').trim();
  if (item.barcode_source === 'product' && product) return product;
  return (item.item_code ?? '').trim();
}

/** Movement types that take stock OUT of the laboratory's hands. */
export const ISSUING_MOVEMENTS = ['issue', 'consume', 'discard', 'waste', 'transfer_out'];

export const MOVEMENT_LABELS: Record<string, string> = {
  issue: 'Issued to a unit', consume: 'Consumed', discard: 'Discarded', waste: 'Wasted',
  transfer_out: 'Transferred out', receive: 'Received', return: 'Returned',
  adjust_in: 'Stock adjustment (in)', adjust_out: 'Stock adjustment (out)', transfer_in: 'Transferred in',
};

/** What a batch is allowed to be. Quarantine is the state on arrival. */
export const ACCEPTANCE_STATES = ['pending', 'accepted', 'rejected', 'quarantined'] as const;

/**
 * What a barcode on a box of reagent actually identifies.
 *
 * Two different questions, and the standards answer them at two different
 * levels:
 *
 *   · WHAT is this? — the trade item. Under GS1 that is the GTIN, printed on
 *     every box of that product, identical across every delivery of it. This
 *     is the item-level barcode: "Abbott Bioline HIV 1/2, 30-test box".
 *
 *   · WHICH ONE is this? — the delivery. The batch/lot number and the expiry
 *     date, which differ from box to box of the same product. This is the
 *     batch-level barcode.
 *
 * ISO 15189:2022 §6.6.2 asks the laboratory to record the lot code of every
 * reagent and consumable it uses, and §6.6.3 to verify a new lot before it is
 * put into service; the traceability the clause is after runs from a patient
 * result back to a *lot*, not to a product type. So a laboratory needs both,
 * and they are not alternatives.
 *
 * A modern reagent box carries both in one symbol — GS1-128 or GS1 DataMatrix
 * — as Application Identifiers: (01) GTIN, (10) batch/lot, (17) expiry as
 * YYMMDD. A scanner types the lot and the product code as one long string, so
 * it is read apart here rather than being demanded field by field.
 */
export type Gs1Scan = { gtin?: string; lot?: string; serial?: string; expiry?: string; raw: string };

/** The FNC1 group separator a scanner emits between variable-length fields. */
const GS = '\x1d';
/** Fixed-length AIs, so the parser knows where each field ends without a separator. */
const GS1_FIXED: Record<string, number> = { '00': 18, '01': 14, '02': 14, '11': 6, '12': 6, '13': 6, '15': 6, '16': 6, '17': 6, '20': 2 };
/** Variable-length AIs run to the next group separator, or to the end. */
const GS1_VARIABLE = new Set(['10', '21', '22', '30', '240', '241', '400', '401', '414', '710']);

/** A GS1 expiry is YYMMDD; a day of 00 means "the end of that month". */
function gs1Date(v: string): string | undefined {
  if (!/^\d{6}$/.test(v)) return undefined;
  const year = 2000 + Number(v.slice(0, 2));
  const month = Number(v.slice(2, 4));
  if (month < 1 || month > 12) return undefined;
  const day = Number(v.slice(4, 6)) || new Date(year, month, 0).getDate();
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Read a scanned string as GS1 element strings, if that is what it is.
 *
 * Returns undefined for an ordinary barcode — a plain EAN-13, or a code the
 * laboratory printed itself — so the caller falls back to matching the whole
 * string, which is what most consumables still need.
 */
export function parseGs1(input: string): Gs1Scan | undefined {
  const raw = String(input ?? '').trim();
  if (!raw) return undefined;
  // Some scanners emit the group separator, some print the AIs in brackets,
  // some do neither. Brackets are stripped so both notations parse the same.
  const bracketed = /^\(\d{2,4}\)/.test(raw);
  const s = bracketed ? raw.replace(/[()]/g, '') : raw;
  // A bare 13-digit EAN is not GS1 element strings, however much it looks like
  // one starting "01"; only a string long enough to carry an AI and its value
  // is worth taking apart.
  if (!bracketed && !/^(01|00|10|17|21)/.test(s)) return undefined;

  const out: Gs1Scan = { raw };
  let i = 0, found = 0;
  while (i < s.length) {
    const ai = [2, 3, 4].map(n => s.slice(i, i + n)).find(c => GS1_FIXED[c] !== undefined || GS1_VARIABLE.has(c));
    if (!ai) break;
    i += ai.length;
    let value: string;
    if (GS1_FIXED[ai] !== undefined) {
      value = s.slice(i, i + GS1_FIXED[ai]);
      i += GS1_FIXED[ai];
    } else {
      const end = s.indexOf(GS, i);
      value = end === -1 ? s.slice(i) : s.slice(i, end);
      i = end === -1 ? s.length : end + 1;
    }
    if (!value) break;
    found++;
    if (ai === '01' || ai === '02') out.gtin = value;
    else if (ai === '10') out.lot = value;
    else if (ai === '21') out.serial = value;
    else if (ai === '17') out.expiry = gs1Date(value);
  }
  return found > 0 && (out.gtin || out.lot) ? out : undefined;
}

/**
 * A GTIN-14 and the EAN-13 printed beneath it are the same product written to
 * different widths, so comparing them as strings says they differ. Both are
 * reduced to their significant digits before matching.
 */
export function normaliseGtin(code: string): string {
  return String(code ?? '').trim().replace(/^0+/, '');
}
