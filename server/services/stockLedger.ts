import type BetterSqlite3 from 'better-sqlite3';

type Database = BetterSqlite3.Database;
import { getDb } from '../db/database.js';
import {
  averageConsumption, forecastDemand, monthsOfStock, safetyStock, reorderPoint, maximumLevel,
  economicOrderQuantity, stockStatus, abcClassify, shortagePriority, stdDev,
  type Forecast, type StockStatus,
} from '../../shared/constants/stockControl.js';

/**
 * What the store actually holds, and what that means.
 *
 * One place works the stock position out, so the ledger, the forecast, the
 * reports and the dashboard cannot disagree about how much of something there
 * is or whether it is running out. Everything is derived from the batches and
 * the movements — the two things that are actually recorded — rather than from
 * a running total somebody might have edited.
 */

/** Movement types that take stock out of the store. */
const OUT = ['issue', 'consume', 'discard', 'waste', 'transfer_out', 'adjust_out'];
/** Movement types that put stock in. */
const IN = ['receive', 'return', 'adjust_in', 'transfer_in'];
/** Out-movements that represent USE, as opposed to loss. Consumption is use. */
const CONSUMPTION = ['issue', 'consume', 'transfer_out'];
/** Out-movements that represent loss — what the wastage rate is made of. */
export const WASTAGE = ['discard', 'waste'];

export const isOutMovement = (t: string) => OUT.includes(t);
export const isInMovement = (t: string) => IN.includes(t);

/** The first day of the month a timestamp falls in, as YYYY-MM. */
const monthKey = (d: string | Date) => new Date(d).toISOString().slice(0, 7);

/** Every month from `back` months ago to this one, oldest first. */
export function monthWindow(back: number): string[] {
  const out: string[] = [];
  const now = new Date();
  for (let i = back - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    out.push(d.toISOString().slice(0, 7));
  }
  return out;
}

export type ConsumptionRow = { item_id: number; month: string; quantity: number };

/**
 * Monthly consumption per item over a window.
 *
 * Only issues and use count — a batch discarded because it expired is a loss to
 * be reported, not demand to reorder against. Counting wastage as consumption
 * is how a laboratory orders more of the reagent it keeps throwing away.
 */
export function consumptionByMonth(db: Database, monthsBack: number): Map<number, Map<string, number>> {
  const since = monthWindow(monthsBack)[0] + '-01';
  const rows = db.prepare(`SELECT item_id, substr(movement_date, 1, 7) AS month, SUM(quantity) AS quantity
    FROM inventory_movements
    WHERE movement_type IN (${CONSUMPTION.map(() => '?').join(', ')})
      AND date(movement_date) >= date(?)
    GROUP BY item_id, month`).all(...CONSUMPTION, since) as ConsumptionRow[];
  const byItem = new Map<number, Map<string, number>>();
  for (const r of rows) {
    if (!byItem.has(r.item_id)) byItem.set(r.item_id, new Map());
    byItem.get(r.item_id)!.set(r.month, Number(r.quantity) || 0);
  }
  return byItem;
}

/** The consumption series for one item, zero-filled so gaps are real zeros. */
export function seriesFor(months: string[], monthly: Map<string, number> | undefined): number[] {
  return months.map(m => monthly?.get(m) ?? 0);
}

export type StockPosition = {
  id: number;
  item_code: string;
  name: string;
  category: string | null;
  unit: string | null;
  storage_path: string | null;
  section_name: string | null;
  supplier_id: number | null;
  supplier_name: string | null;
  is_active: number;
  ven_class: string;
  abc_class: string | null;
  unit_cost: number | null;
  lead_time_days: number;
  review_period_days: number;
  service_level: number;
  planning_locked: number;
  minimum_stock: number;
  reorder_level: number;
  maximum_stock: number | null;
  /** Everything on the shelf, summed from the batches. */
  on_hand: number;
  /** What can actually be issued today: accepted, in date, not rejected. */
  issuable: number;
  quarantined: number;
  expired_on_hand: number;
  batch_count: number;
  earliest_expiry: string | null;
  expiry_status: string | null;
  /** Average monthly consumption over the window. */
  amc: number;
  months_of_stock: number | null;
  status: StockStatus;
  priority: 1 | 2 | 3;
  stock_value: number | null;
  last_issued: string | null;
  last_received: string | null;
  consumption: number[];
};

const expiryStatusOf = (date: string | null): string | null => {
  if (!date) return null;
  const days = Math.ceil((new Date(date).getTime() - Date.now()) / 86400000);
  if (days < 0) return 'expired';
  if (days <= 90) return 'expiring_soon';
  return 'valid';
};

/**
 * The stock position of every item, with the numbers a store runs on.
 *
 * `on_hand` is everything physically there; `issuable` is what may actually
 * leave today. They differ whenever a delivery is still in quarantine or a lot
 * has gone out of date on the shelf, and confusing the two is how a register
 * reports healthy stock for an item nobody can issue.
 */
export function stockPositions(opts: { monthsBack?: number; includeInactive?: boolean } = {}): { months: string[]; rows: StockPosition[] } {
  const db = getDb();
  const monthsBack = opts.monthsBack ?? 12;
  const months = monthWindow(monthsBack);
  const consumption = consumptionByMonth(db, monthsBack);
  const today = new Date().toISOString().slice(0, 10);

  const rows = db.prepare(`SELECT i.*, sup.name AS supplier_name, sec.name AS section_name,
      (SELECT COALESCE(SUM(b.quantity_available), 0) FROM inventory_batches b WHERE b.item_id = i.id) AS on_hand,
      (SELECT COALESCE(SUM(b.quantity_available), 0) FROM inventory_batches b
        WHERE b.item_id = i.id AND b.acceptance_status = 'accepted'
          AND (b.expiry_date IS NULL OR b.expiry_date = '' OR date(b.expiry_date) >= date(?))) AS issuable,
      (SELECT COALESCE(SUM(b.quantity_available), 0) FROM inventory_batches b
        WHERE b.item_id = i.id AND b.acceptance_status IN ('pending', 'quarantined')) AS quarantined,
      (SELECT COALESCE(SUM(b.quantity_available), 0) FROM inventory_batches b
        WHERE b.item_id = i.id AND b.expiry_date IS NOT NULL AND b.expiry_date != '' AND date(b.expiry_date) < date(?)) AS expired_on_hand,
      (SELECT COUNT(*) FROM inventory_batches b WHERE b.item_id = i.id AND b.quantity_available > 0) AS batch_count,
      (SELECT MIN(b.expiry_date) FROM inventory_batches b
        WHERE b.item_id = i.id AND b.quantity_available > 0 AND b.expiry_date IS NOT NULL AND b.expiry_date != ''
          AND b.acceptance_status != 'rejected') AS earliest_expiry,
      (SELECT MAX(m.movement_date) FROM inventory_movements m WHERE m.item_id = i.id AND m.movement_type IN ('issue', 'consume')) AS last_issued,
      (SELECT MAX(b.date_received) FROM inventory_batches b WHERE b.item_id = i.id) AS last_received,
      l.name AS storage_name
    FROM inventory_items i
    LEFT JOIN suppliers sup ON sup.id = i.supplier_id
    LEFT JOIN sections sec ON sec.id = i.section_id
    LEFT JOIN storage_locations l ON l.id = i.storage_location_id
    ${opts.includeInactive ? '' : 'WHERE i.is_active = 1'}
    ORDER BY i.name`).all(today, today) as any[];

  const paths = storagePathMap(db);

  const positions: StockPosition[] = rows.map(r => {
    const series = seriesFor(months, consumption.get(r.id));
    const amc = averageConsumption(series.map((q, idx) => ({ period: months[idx], quantity: q })));
    const onHand = Number(r.on_hand) || 0;
    const issuable = Number(r.issuable) || 0;
    // Cover is how long the store can keep serving, so it is measured on what
    // may actually go out — not on what happens to be in the building.
    const mos = monthsOfStock(issuable, amc);
    const status = stockStatus({
      onHand, issuable, minimum: r.minimum_stock, reorderLevel: r.reorder_level,
      maximum: r.maximum_stock, monthsOfStock: mos,
    });
    return {
      ...r,
      storage_path: r.storage_location_id ? paths.get(r.storage_location_id) ?? r.storage_name ?? null : null,
      on_hand: onHand,
      issuable,
      quarantined: Number(r.quarantined) || 0,
      expired_on_hand: Number(r.expired_on_hand) || 0,
      batch_count: Number(r.batch_count) || 0,
      expiry_status: expiryStatusOf(r.earliest_expiry),
      amc: Math.round(amc * 100) / 100,
      months_of_stock: mos == null ? null : Math.round(mos * 10) / 10,
      status,
      priority: shortagePriority(r.abc_class, r.ven_class),
      stock_value: r.unit_cost != null ? Math.round(onHand * Number(r.unit_cost) * 100) / 100 : null,
      consumption: series,
    };
  });

  // ABC is a property of the whole catalogue, not of one row, so it is worked
  // out across the set once the annual value of each is known.
  const annualValue = (p: StockPosition) => (p.unit_cost ?? 0) * p.amc * 12;
  const classes = abcClassify(positions, annualValue);
  for (const p of positions) {
    // A class set by hand stands; otherwise it follows the spend.
    if (!p.abc_class) p.abc_class = annualValue(p) > 0 ? classes.get(p) ?? 'C' : null;
    p.priority = shortagePriority(p.abc_class, p.ven_class);
  }
  return { months, rows: positions };
}

/** "Main Store › Shelf B3" for every storage place, resolved once. */
export function storagePathMap(db: Database): Map<number, string> {
  const rows = db.prepare('SELECT id, name, parent_id FROM storage_locations').all() as { id: number; name: string; parent_id: number | null }[];
  const byId = new Map(rows.map(r => [r.id, r]));
  const path = (id: number, seen = new Set<number>()): string => {
    const r = byId.get(id);
    if (!r || seen.has(id)) return r?.name ?? '';
    seen.add(id);
    return r.parent_id ? `${path(r.parent_id, seen)} › ${r.name}` : r.name;
  };
  return new Map(rows.map(r => [r.id, path(r.id)]));
}

/**
 * The part of the consumption history that is actually evidence of demand.
 *
 * Two things in the raw window are not:
 *
 *   · the months before the item was ever used. A reagent introduced in June
 *     did not have zero demand in January — it did not exist. Averaging those
 *     zeros in halves the forecast and halves the order with it.
 *   · the current month, which is only partly over. Forecasting from a month
 *     that is three days old says demand has collapsed.
 *
 * Both are kept for the ledger's chart, where showing the whole window is
 * right, and dropped here, where they would mislead.
 */
export function demandSeries(consumption: number[]): number[] {
  const completed = consumption.slice(0, -1);
  const firstUse = completed.findIndex(v => v > 0);
  return firstUse === -1 ? [] : completed.slice(firstUse);
}

export type PlanningAdvice = {
  itemId: number;
  forecast: Forecast;
  amc: number;
  safetyStock: number;
  reorderLevel: number;
  minimumStock: number;
  maximumStock: number;
  suggestedOrder: number;
  eoq: number | null;
  coverMonths: number | null;
  /** What the item currently has, so the difference can be shown. */
  current: { minimum: number; reorder: number; maximum: number | null };
  changed: boolean;
};

/**
 * What the levels for one item ought to be, given how it has actually been used.
 *
 * The chain is the standard one: forecast demand, size the buffer from how
 * uneven that demand has been and how long the supplier takes, set the reorder
 * point at lead-time demand plus the buffer, and set the maximum to cover the
 * lead time and the ordering cycle together. The minimum is the buffer itself —
 * the level at which the laboratory is running on its reserve.
 */
export function planFor(position: StockPosition, horizonMonths = 3): PlanningAdvice {
  const forecast = forecastDemand(demandSeries(position.consumption), horizonMonths);
  const demand = forecast.method === 'none' ? position.amc : forecast.nextPeriod;
  const sigma = forecast.sigma || stdDev(position.consumption);
  const ss = safetyStock(sigma, position.lead_time_days, position.service_level);
  const rop = reorderPoint(demand, position.lead_time_days, ss);
  const max = maximumLevel(demand, position.lead_time_days, position.review_period_days, ss);
  const eoq = economicOrderQuantity(demand * 12, 50, (position.unit_cost ?? 0) * 0.25);
  // Order back up to the maximum, counting only what can actually be issued —
  // quarantined and expired stock is not cover.
  const suggested = Math.max(0, Math.ceil(max - position.issuable));
  const r = (n: number) => Math.max(0, Math.ceil(n));
  return {
    itemId: position.id,
    forecast, amc: position.amc,
    safetyStock: r(ss), reorderLevel: r(rop), minimumStock: r(ss), maximumStock: r(max),
    suggestedOrder: suggested,
    eoq: eoq == null ? null : Math.ceil(eoq),
    coverMonths: position.months_of_stock,
    current: { minimum: position.minimum_stock ?? 0, reorder: position.reorder_level ?? 0, maximum: position.maximum_stock },
    changed: r(rop) !== (position.reorder_level ?? 0) || r(ss) !== (position.minimum_stock ?? 0) || r(max) !== (position.maximum_stock ?? 0),
  };
}

/**
 * The batches to take a quantity out of, oldest expiry first.
 *
 * This is what makes issuing one action instead of several: the storekeeper
 * says "40 urine containers" and the store decides which boxes they come out
 * of. Only stock that may actually be issued is offered — accepted, in date —
 * so FEFO can never reach past a quarantined delivery into a good one.
 */
export function allocateFefo(db: Database, itemId: number, quantity: number): { batchId: number; quantity: number; batchNumber: string | null; expiry: string | null }[] {
  const today = new Date().toISOString().slice(0, 10);
  const batches = db.prepare(`SELECT id, batch_number, expiry_date, quantity_available FROM inventory_batches
    WHERE item_id = ? AND quantity_available > 0 AND acceptance_status = 'accepted'
      AND (expiry_date IS NULL OR expiry_date = '' OR date(expiry_date) >= date(?))
    ORDER BY CASE WHEN expiry_date IS NULL OR expiry_date = '' THEN 1 ELSE 0 END, expiry_date, date_received, id`)
    .all(itemId, today) as { id: number; batch_number: string | null; expiry_date: string | null; quantity_available: number }[];

  const plan: { batchId: number; quantity: number; batchNumber: string | null; expiry: string | null }[] = [];
  let left = quantity;
  for (const b of batches) {
    if (left <= 0) break;
    const take = Math.min(left, b.quantity_available);
    if (take <= 0) continue;
    plan.push({ batchId: b.id, quantity: take, batchNumber: b.batch_number, expiry: b.expiry_date });
    left -= take;
  }
  if (left > 0) return [];
  return plan;
}

/** What may be issued of an item right now — the same rule allocation uses. */
export function issuableQuantity(db: Database, itemId: number): number {
  const today = new Date().toISOString().slice(0, 10);
  return Number((db.prepare(`SELECT COALESCE(SUM(quantity_available), 0) AS n FROM inventory_batches
    WHERE item_id = ? AND acceptance_status = 'accepted'
      AND (expiry_date IS NULL OR expiry_date = '' OR date(expiry_date) >= date(?))`).get(itemId, today) as { n: number }).n) || 0;
}

/**
 * Record a movement and the balance it leaves behind.
 *
 * The balance is written at the time, the way a tally card on the shelf is
 * written: what was there, what moved, what is left. Recomputing it later from
 * the movements would give a different answer the moment anything is corrected
 * or backdated, and then the card and the shelf no longer agree.
 */
export function postMovement(db: Database, input: {
  itemId: number; batchId: number | null; movementType: string; quantity: number; movementDate: string;
  issuedToSectionId?: number | null; receivedByStaffId?: number | null; reason?: string | null;
  issueId?: number | null; countId?: number | null; unitCost?: number | null; userId: number;
  /**
   * Whether this posting should move the balances, or only record that they
   * moved. Booking in a delivery already puts the quantity on the new batch,
   * so its receipt movement must not add it a second time.
   */
  applyToStock?: boolean;
}): { id: number; balanceAfter: number } {
  const signed = input.applyToStock === false ? 0
    : isOutMovement(input.movementType) ? -Math.abs(input.quantity)
    : isInMovement(input.movementType) ? Math.abs(input.quantity) : 0;

  if (input.batchId && signed !== 0) {
    db.prepare('UPDATE inventory_batches SET quantity_available = quantity_available + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(signed, input.batchId);
  }
  if (signed !== 0) {
    db.prepare('UPDATE inventory_items SET quantity = MAX(0, quantity + ?), updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(signed, input.itemId);
  }
  const balanceAfter = Number((db.prepare('SELECT COALESCE(SUM(quantity_available), 0) AS n FROM inventory_batches WHERE item_id = ?')
    .get(input.itemId) as { n: number }).n) || 0;

  const r = db.prepare(`INSERT INTO inventory_movements
    (item_id, batch_id, movement_type, quantity, movement_date, issued_to_section_id, received_by_staff_id, reason, issue_id, count_id, unit_cost, balance_after, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(input.itemId, input.batchId, input.movementType, Math.abs(input.quantity), input.movementDate,
      input.issuedToSectionId ?? null, input.receivedByStaffId ?? null, input.reason ?? null,
      input.issueId ?? null, input.countId ?? null, input.unitCost ?? null, balanceAfter, input.userId);
  return { id: Number(r.lastInsertRowid), balanceAfter };
}
