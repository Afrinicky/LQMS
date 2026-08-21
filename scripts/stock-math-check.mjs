/**
 * The arithmetic a store runs on, checked on its own.
 *
 *   npx tsx scripts/stock-math-check.mjs
 *
 * These are pure functions — no server, no database. If the forecast picks the
 * wrong method or safety stock is sized wrongly, every level in the laboratory
 * is wrong with it, so they are checked here rather than only through the
 * screens that use them.
 */
const m = await import('../shared/constants/stockControl.ts');
let pass = 0, fail = 0;
const check = (n, ok, d = '') => ok ? (pass++, console.log('  PASS ', n)) : (fail++, console.log('  FAIL ', n, '—', d));
const near = (a, b, tol = 0.02) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

console.log('\nforecast picks the method the history supports');
check('no history says so', m.forecastDemand([]).method === 'none');
check('one period is honest about it', m.forecastDemand([40]).confidence === 'low');
const steady = m.forecastDemand([100, 98, 102, 99, 101, 100]);
check('steady use → an average', ['moving_average', 'weighted_moving_average'].includes(steady.method), steady.method);
check('  and lands on ~100', near(steady.nextPeriod, 100, 0.05), String(steady.nextPeriod));
check('  with a low error', steady.mape !== null && steady.mape < 10, String(steady.mape));
check('  and good confidence', steady.confidence === 'good', steady.confidence);
const rising = m.forecastDemand([50, 60, 70, 80, 90, 100]);
check('a rising series → Holt', rising.method === 'holt', rising.method);
check('  projects upward, not backward', rising.nextPeriod > 100, String(rising.nextPeriod));
check('  and reports the slope', rising.trend > 5, String(rising.trend));
const seasonal = m.forecastDemand([...Array(3)].flatMap(() => [30,30,40,60,90,120,140,120,80,50,35,30]));
check('two+ years of seasonality → seasonal method', seasonal.method === 'holt_winters', seasonal.method);
check('  and January is forecast low, not at the annual mean', seasonal.nextPeriod < 60, String(seasonal.nextPeriod));

console.log('\nlevels follow from lead time, variability and the service level');
check('z(95%) is 1.65', m.zForServiceLevel(0.95) === 1.65);
check('a higher service level costs more buffer', m.safetyStock(20, 30, 0.99) > m.safetyStock(20, 30, 0.90));
check('a longer wait costs more buffer', m.safetyStock(20, 60, 0.95) > m.safetyStock(20, 30, 0.95));
check('steady demand needs no buffer', m.safetyStock(0, 30, 0.95) === 0);
// 100/month, 30-day lead time, safety 33 → ROP = 100 + 33
check('reorder point = lead-time demand + buffer', near(m.reorderPoint(100, 30, 33), 133));
check('a 15-day lead time halves the lead-time demand', near(m.reorderPoint(100, 15, 0), 50));
check('maximum covers lead time AND the review cycle', near(m.maximumLevel(100, 30, 30, 33), 233));
check('EOQ is the textbook root', near(m.economicOrderQuantity(1200, 50, 6), Math.sqrt((2*1200*50)/6)));
check('EOQ declines to say so without costs', m.economicOrderQuantity(1200, 0, 6) === null);

console.log('\nmonths of stock decides status, not raw quantity');
check('nothing on the shelf is a stockout', m.stockStatus({ onHand: 0 }) === 'stockout');
check('stock present but not released is NOT called adequate',
  m.stockStatus({ onHand: 400, issuable: 0, monthsOfStock: 3.2 }) === 'blocked',
  m.stockStatus({ onHand: 400, issuable: 0, monthsOfStock: 3.2 }));
check('once released it is judged normally',
  m.stockStatus({ onHand: 400, issuable: 400, monthsOfStock: 3.2 }) === 'adequate');
check('and cover is measured on what can go out',
  m.stockStatus({ onHand: 400, issuable: 20, monthsOfStock: 0.2 }) === 'critical');
check('two weeks left is critical', m.stockStatus({ onHand: 40, monthsOfStock: 0.4 }) === 'critical');
check('three weeks left is low', m.stockStatus({ onHand: 70, monthsOfStock: 0.7 }) === 'low');
check('three months is adequate', m.stockStatus({ onHand: 300, monthsOfStock: 3 }) === 'adequate');
check('two years is overstock', m.stockStatus({ onHand: 3000, monthsOfStock: 24 }) === 'overstock');
check('with no consumption it falls back to the levels', m.stockStatus({ onHand: 5, minimum: 10 }) === 'critical');
check('and says so when there are no levels either', m.stockStatus({ onHand: 5 }) === 'unknown');
check('months of stock is null without consumption', m.monthsOfStock(100, 0) === null);

console.log('\nABC and VEN');
const rows = [{ v: 700 }, { v: 200 }, { v: 60 }, { v: 40 }];
const abc = m.abcClassify(rows, r => r.v);
check('the item carrying most spend is A', abc.get(rows[0]) === 'A', abc.get(rows[0]));
check('the next band is B', abc.get(rows[1]) === 'B', abc.get(rows[1]));
check('the tail is C', abc.get(rows[3]) === 'C', abc.get(rows[3]));
check('a vital shortage is top priority whatever its value', m.shortagePriority('C', 'vital') === 1);
check('a desirable C-class one can wait', m.shortagePriority('C', 'desirable') === 3);

console.log('\nconsumption averaging');
check('AMC is the plain mean', m.averageConsumption([{period:'a',quantity:90},{period:'b',quantity:110}]) === 100);
check('a stockout month is not evidence of low demand',
  m.averageConsumption([{period:'a',quantity:100},{period:'b',quantity:100},{period:'c',quantity:0}], [false,false,true]) === 100);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
