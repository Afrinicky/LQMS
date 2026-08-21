/**
 * The arithmetic a store runs on.
 *
 * Everything here is a pure function of numbers, kept apart from the routes so
 * it can be reasoned about and tested on its own. The names are the ones a
 * supply officer already uses — average monthly consumption, months of stock,
 * reorder point, safety stock, economic order quantity, ABC/VEN — because the
 * point is not to invent a scheme but to implement the one the profession
 * already agreed on.
 *
 * References the terminology follows: WHO/MSH "Managing Drug Supply" logistics
 * indicators (AMC, months of stock, ABC/VEN), and the standard continuous- and
 * periodic-review inventory models.
 */

// ─────────────────────────────────────────────── consumption and stock cover

/** One period of history: a month (or week) and what was consumed in it. */
export type ConsumptionPeriod = { period: string; quantity: number };

export const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
export const mean = (xs: number[]) => (xs.length ? sum(xs) / xs.length : 0);

/** Population standard deviation — the spread of demand, not a sample estimate. */
export function stdDev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map(x => (x - m) ** 2)));
}

/**
 * Average monthly consumption.
 *
 * Periods where the item was out of stock are excluded when the caller marks
 * them, because a month that issued nothing because there was nothing to issue
 * is not evidence of low demand — averaging it in is how a chronically
 * understocked item stays understocked.
 */
export function averageConsumption(history: ConsumptionPeriod[], excludeStockouts: boolean[] = []): number {
  const usable = history.filter((_, i) => !excludeStockouts[i]);
  return mean((usable.length ? usable : history).map(h => h.quantity));
}

/** How long what is on the shelf will last at the current rate. */
export function monthsOfStock(onHand: number, amc: number): number | null {
  if (!amc || amc <= 0) return null;
  return onHand / amc;
}

// ───────────────────────────────────────────────────────────── forecasting

export type ForecastMethod = 'none' | 'naive' | 'moving_average' | 'weighted_moving_average' | 'holt' | 'holt_winters';

export type Forecast = {
  method: ForecastMethod;
  /** Expected demand in the next period. */
  nextPeriod: number;
  /** Demand per period over the horizon asked for, in order. */
  horizon: number[];
  /** Mean absolute percentage error from walking the method through history. */
  mape: number | null;
  /** Standard deviation of the forecast errors — what safety stock is sized on. */
  sigma: number;
  /** Direction and size of the trend per period. */
  trend: number;
  /** How much of the history the method actually had to learn from. */
  periodsUsed: number;
  /** Plain words for why this method and how far it can be trusted. */
  confidence: 'none' | 'low' | 'moderate' | 'good';
  note: string;
};

/** Simple mean of the last n periods. */
export function movingAverage(series: number[], window = 3): number {
  const w = series.slice(-window);
  return mean(w);
}

/**
 * Weighted moving average — the most recent period counts most.
 *
 * Weights 1..n so a three-period window is 1/6, 2/6, 3/6. Reagent use responds
 * to what the laboratory is doing now, so the newest month should not be worth
 * the same as one from a season ago.
 */
export function weightedMovingAverage(series: number[], window = 3): number {
  const w = series.slice(-window);
  if (!w.length) return 0;
  const weights = w.map((_, i) => i + 1);
  return sum(w.map((v, i) => v * weights[i])) / sum(weights);
}

/**
 * Holt's linear exponential smoothing — a level and a trend.
 *
 * Reagent demand moves: a new analyser, a new outreach clinic, a service that
 * is growing. A flat average is always behind such a series; Holt carries the
 * slope forward, which is what makes an order quantity right rather than
 * merely recent.
 */
export function holt(series: number[], alpha = 0.4, beta = 0.2): { level: number; trend: number; fitted: number[] } {
  if (series.length === 0) return { level: 0, trend: 0, fitted: [] };
  if (series.length === 1) return { level: series[0], trend: 0, fitted: [series[0]] };
  let level = series[0];
  let trend = series[1] - series[0];
  const fitted: number[] = [series[0]];
  for (let i = 1; i < series.length; i++) {
    const forecast = level + trend;
    fitted.push(forecast);
    const prevLevel = level;
    level = alpha * series[i] + (1 - alpha) * forecast;
    trend = beta * (level - prevLevel) + (1 - beta) * trend;
  }
  return { level, trend, fitted };
}

/**
 * Seasonal indices over a cycle (12 months by default).
 *
 * Malaria slides in the rainy season, school-entry screening in September: a
 * laboratory's demand has a shape to the year, and ordering a flat twelfth of
 * it every month is how a store runs dry in one season and expires stock in
 * another. Returns a multiplier per position in the cycle, averaging to 1.
 */
export function seasonalIndices(series: number[], cycle = 12): number[] {
  const overall = mean(series);
  if (!overall) return new Array(cycle).fill(1);
  const buckets: number[][] = Array.from({ length: cycle }, () => []);
  series.forEach((v, i) => buckets[i % cycle].push(v));
  const raw = buckets.map(b => (b.length ? mean(b) / overall : 1));
  // Normalised so the indices multiply out to the same annual total.
  const scale = cycle / sum(raw);
  return raw.map(r => r * scale);
}

/** Mean absolute percentage error, ignoring periods that were genuinely zero. */
export function mape(actual: number[], fitted: number[]): number | null {
  const pairs = actual.map((a, i) => [a, fitted[i]] as const).filter(([a, f]) => a > 0 && Number.isFinite(f));
  if (pairs.length === 0) return null;
  return (sum(pairs.map(([a, f]) => Math.abs(a - f) / a)) / pairs.length) * 100;
}

/**
 * Forecast demand, choosing the method the history can actually support.
 *
 * Not a fixed formula: each candidate is walked through the laboratory's own
 * history and scored on the error it would have made, and the one that fits
 * this item best wins. A reagent with steady use gets a moving average; one
 * that is climbing gets Holt; one with two years behind it gets the seasonal
 * shape as well. An item with almost no history is told so rather than being
 * given a confident number nobody should act on.
 */
export function forecastDemand(series: number[], horizonPeriods = 3, cycle = 12): Forecast {
  const clean = series.map(v => (Number.isFinite(v) && v > 0 ? v : 0));
  const n = clean.length;

  if (n === 0 || sum(clean) === 0) {
    return { method: 'none', nextPeriod: 0, horizon: new Array(horizonPeriods).fill(0), mape: null, sigma: 0, trend: 0,
      periodsUsed: n, confidence: 'none', note: 'Nothing has been issued yet, so there is nothing to forecast from. Set the levels by hand until it has been used for a month or two.' };
  }
  if (n < 3) {
    const v = clean[n - 1];
    return { method: 'naive', nextPeriod: v, horizon: new Array(horizonPeriods).fill(v), mape: null, sigma: stdDev(clean), trend: 0,
      periodsUsed: n, confidence: 'low', note: `Only ${n} period${n === 1 ? '' : 's'} of use so far — this is last period repeated, not a forecast. Treat it as a placeholder.` };
  }

  type Candidate = { method: ForecastMethod; fitted: number[]; project: (k: number) => number; trend: number };
  const candidates: Candidate[] = [];

  // Moving average, fitted one step ahead through the series.
  for (const [method, fn] of [['moving_average', movingAverage], ['weighted_moving_average', weightedMovingAverage]] as const) {
    const w = Math.min(3, n - 1);
    const fitted = clean.map((_, i) => (i < w ? clean[i] : fn(clean.slice(0, i), w)));
    const value = fn(clean, w);
    candidates.push({ method, fitted, project: () => value, trend: 0 });
  }

  // Holt: level plus trend.
  const h = holt(clean);
  candidates.push({ method: 'holt', fitted: h.fitted, project: k => Math.max(0, h.level + h.trend * k), trend: h.trend });

  // Holt-Winters in spirit: Holt on the deseasonalised series, reseasonalised
  // on the way out. Only offered with two full cycles behind it, because a
  // seasonal index from one year is just that year.
  if (n >= cycle * 2) {
    const idx = seasonalIndices(clean, cycle);
    const deseasonalised = clean.map((v, i) => v / (idx[i % cycle] || 1));
    const hw = holt(deseasonalised);
    candidates.push({
      method: 'holt_winters',
      fitted: hw.fitted.map((v, i) => v * (idx[i % cycle] || 1)),
      project: k => Math.max(0, (hw.level + hw.trend * k) * (idx[(n + k - 1) % cycle] || 1)),
      trend: hw.trend,
    });
  }

  // Scored on the part of the history every candidate could see, so the
  // comparison is fair rather than flattering whichever warms up fastest.
  const warmUp = Math.min(3, n - 1);
  const scored = candidates.map(c => ({
    ...c,
    error: mape(clean.slice(warmUp), c.fitted.slice(warmUp)),
  }));
  const best = scored.reduce((a, b) => {
    if (a.error === null) return b;
    if (b.error === null) return a;
    return b.error < a.error ? b : a;
  });

  const horizon = Array.from({ length: horizonPeriods }, (_, k) => Math.max(0, best.project(k + 1)));
  const residuals = clean.slice(warmUp).map((a, i) => a - best.fitted[warmUp + i]);
  const err = best.error;
  const confidence = err === null ? 'low' : err < 20 ? 'good' : err < 40 ? 'moderate' : 'low';

  return {
    method: best.method,
    nextPeriod: horizon[0] ?? 0,
    horizon,
    mape: err === null ? null : Math.round(err * 10) / 10,
    sigma: stdDev(residuals.length >= 2 ? residuals : clean),
    trend: Math.round(best.trend * 100) / 100,
    periodsUsed: n,
    confidence,
    note: METHOD_NOTES[best.method](n, err),
  };
}

const METHOD_NOTES: Record<ForecastMethod, (n: number, err: number | null) => string> = {
  none: () => 'No use recorded.',
  naive: n => `Too little history (${n} periods) to fit anything.`,
  moving_average: (n, e) => `Use has been steady, so a ${Math.min(3, n - 1)}-period average fits it best${e === null ? '' : ` (${e.toFixed(0)}% average error)`}.`,
  weighted_moving_average: (n, e) => `Recent months predict this one best, weighted towards the latest${e === null ? '' : ` (${e.toFixed(0)}% average error)`}.`,
  holt: (_n, e) => `Use is trending rather than flat, so the trend is carried forward${e === null ? '' : ` (${e.toFixed(0)}% average error)`}.`,
  holt_winters: (_n, e) => `Use has a repeating shape across the year, so the season is built in${e === null ? '' : ` (${e.toFixed(0)}% average error)`}.`,
};

// ───────────────────────────────────────────────────── levels and ordering

/**
 * The z-score for a target service level.
 *
 * Service level is the probability of NOT running out during the lead time.
 * A table is used rather than an inverse-normal approximation because these
 * are the only values anybody sets in practice, and a wrong tail value here
 * silently mis-sizes every safety stock in the laboratory.
 */
export const SERVICE_LEVEL_Z: Array<[level: number, z: number]> = [
  [0.50, 0.00], [0.75, 0.67], [0.80, 0.84], [0.85, 1.04], [0.90, 1.28],
  [0.95, 1.65], [0.97, 1.88], [0.98, 2.05], [0.99, 2.33], [0.995, 2.58], [0.999, 3.09],
];
export function zForServiceLevel(level: number): number {
  const l = Math.min(0.999, Math.max(0.5, level));
  let best = SERVICE_LEVEL_Z[0];
  for (const row of SERVICE_LEVEL_Z) if (Math.abs(row[0] - l) < Math.abs(best[0] - l)) best = row;
  return best[1];
}

/**
 * Safety stock — the buffer that absorbs demand being uneven.
 *
 *   SS = z × σ_period × √(lead time ÷ period length)
 *
 * σ is the spread of demand per period, scaled to the length of the lead time,
 * because uncertainty accumulates over the wait, not over the calendar.
 */
export function safetyStock(sigmaPerPeriod: number, leadTimeDays: number, serviceLevel = 0.95, periodDays = 30): number {
  if (sigmaPerPeriod <= 0 || leadTimeDays <= 0) return 0;
  return zForServiceLevel(serviceLevel) * sigmaPerPeriod * Math.sqrt(leadTimeDays / periodDays);
}

/** Order when stock falls to what the lead time will eat, plus the buffer. */
export function reorderPoint(demandPerPeriod: number, leadTimeDays: number, safety: number, periodDays = 30): number {
  return (demandPerPeriod / periodDays) * leadTimeDays + safety;
}

/**
 * Economic order quantity — the order size where ordering cost and holding
 * cost balance. Advisory only: a reagent's pack size and shelf life usually
 * decide the real answer, and a quantity that outlives its expiry is wrong
 * however economic it looks.
 */
export function economicOrderQuantity(annualDemand: number, orderCost: number, holdingCostPerUnitYear: number): number | null {
  if (annualDemand <= 0 || orderCost <= 0 || holdingCostPerUnitYear <= 0) return null;
  return Math.sqrt((2 * annualDemand * orderCost) / holdingCostPerUnitYear);
}

/** The ceiling: enough to cover the review cycle and the next lead time. */
export function maximumLevel(demandPerPeriod: number, leadTimeDays: number, reviewPeriodDays: number, safety: number, periodDays = 30): number {
  return (demandPerPeriod / periodDays) * (leadTimeDays + reviewPeriodDays) + safety;
}

export type StockStatus = 'stockout' | 'blocked' | 'critical' | 'low' | 'adequate' | 'overstock' | 'unknown';

export const STOCK_STATUS_LABELS: Record<StockStatus, string> = {
  stockout: 'Out of stock',
  blocked: 'None released',
  critical: 'Critically low',
  low: 'Below reorder level',
  adequate: 'Adequate',
  overstock: 'Overstocked',
  unknown: 'No levels set',
};

/** The statuses that mean somebody has to do something today. */
export const NEEDS_ACTION: StockStatus[] = ['stockout', 'blocked', 'critical', 'low'];

/**
 * Where an item stands, in the words a store uses.
 *
 * Judged on what can actually be ISSUED, not on what is physically present. A
 * reagent with four hundred tests sitting in the fridge still in quarantine
 * cannot serve a single patient this morning, and a register that calls that
 * "adequate" is worse than one that says nothing — somebody reads it, orders
 * nothing, and the bench runs dry. Stock that is present but not released is
 * called exactly that, so the answer is to go and inspect it rather than to
 * raise an order.
 *
 * Months of stock decides the rest when there is consumption to judge by,
 * because "40 units" means nothing until you know whether that is a fortnight
 * or two years; the configured levels decide it when there is not.
 */
export function stockStatus(input: {
  onHand: number; issuable?: number | null;
  minimum?: number | null; reorderLevel?: number | null; maximum?: number | null; monthsOfStock?: number | null;
}): StockStatus {
  const available = input.issuable ?? input.onHand;
  if (available <= 0 && input.onHand > 0) return 'blocked';
  const onHand = available;
  const mos = input.monthsOfStock;
  const min = input.minimum ?? 0;
  const reorder = input.reorderLevel ?? 0;
  const max = input.maximum ?? 0;
  if (onHand <= 0) return 'stockout';
  if (mos != null) {
    if (mos < 0.5) return 'critical';
    if (mos < 1) return 'low';
    if (max > 0 && onHand > max) return 'overstock';
    if (mos > 12) return 'overstock';
    return 'adequate';
  }
  if (min > 0 && onHand <= min) return 'critical';
  if (reorder > 0 && onHand <= reorder) return 'low';
  if (max > 0 && onHand > max) return 'overstock';
  if (min > 0 || reorder > 0 || max > 0) return 'adequate';
  return 'unknown';
}

// ───────────────────────────────────────────────────────────── ABC and VEN

export const VEN_CLASSES = ['vital', 'essential', 'desirable'] as const;
export type VenClass = typeof VEN_CLASSES[number];
export const VEN_LABELS: Record<string, string> = {
  vital: 'Vital — the laboratory stops without it',
  essential: 'Essential — testing is degraded without it',
  desirable: 'Desirable — inconvenient without it',
};

/**
 * ABC classification by Pareto on annual consumption value.
 *
 * A is the small handful of items carrying ~70% of the spend and deserving
 * tight control and frequent counting; B the next ~20%; C the long tail that
 * is cheaper to overstock than to manage closely.
 */
export function abcClassify<T>(rows: T[], valueOf: (row: T) => number): Map<T, 'A' | 'B' | 'C'> {
  const out = new Map<T, 'A' | 'B' | 'C'>();
  const total = sum(rows.map(valueOf));
  if (total <= 0) { rows.forEach(r => out.set(r, 'C')); return out; }
  let running = 0;
  [...rows].sort((a, b) => valueOf(b) - valueOf(a)).forEach(row => {
    running += valueOf(row);
    const share = running / total;
    out.set(row, share <= 0.7 ? 'A' : share <= 0.9 ? 'B' : 'C');
  });
  return out;
}

/**
 * How urgently a shortage of this item needs acting on.
 *
 * The ABC/VEN pairing: a vital item is chased whatever it costs, a desirable
 * C-class one can wait for the next routine order.
 */
export function shortagePriority(abc: string | null | undefined, ven: string | null | undefined): 1 | 2 | 3 {
  if (ven === 'vital') return 1;
  if (ven === 'essential' && (abc === 'A' || abc === 'B')) return 1;
  if (ven === 'essential') return 2;
  return abc === 'A' ? 2 : 3;
}
