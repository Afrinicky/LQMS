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
