import { useEffect, useState } from 'react';
import { api } from '../../services/api';
import { KpiStrip, ChartCard, DonutChart, BarChart, BarMeter, Sparkline, CHART_COLORS } from '../../components/ui';
import type { StockStatus } from '../../../shared/constants/stockControl';
import { StatusBadge, qty } from './StockControl';

/**
 * The state of the store, in the figures a manager is asked for.
 *
 * Read together rather than one at a time: a rising consumption trend means
 * one thing beside a healthy stock position and quite another beside a
 * shortage list, so they run in that order — what is happening, what is at
 * risk, what is being wasted, and who is supplying it. They sit under the
 * module dashboard, because the position and the reporting on it are one
 * question asked twice.
 */

type Reports = {
  generatedAt: string;
  months: string[];
  trend: { month: string; issued: number; received: number; wasted: number }[];
  totals: {
    items: number; stockValue: number; issuedUnits: number; receivedUnits: number; wastedUnits: number;
    wastageRate: number; turnover: number | null; stockoutItems: number; belowReorder: number;
  };
  statusCounts: Record<string, number>;
  expiry: { bands: Record<string, number>; value: Record<string, number>; batches: any[] };
  topConsumers: { id: number; name: string; unit: string | null; total: number; value: number }[];
  slowMovers: { id: number; name: string; onHand: number; unit: string | null; value: number | null; lastIssued: string | null }[];
  shortages: { id: number; name: string; unit: string | null; onHand: number; issuable: number; status: StockStatus;
    monthsOfStock: number | null; amc: number; priority: number; abc: string | null; ven: string; supplierName: string | null }[];
  abcMix: { abc: string; items: number; value: number }[];
  venMix: { ven: string; items: number }[];
  supplierPerformance: { id: number; name: string; deliveries: number; rejected: number; awaiting: number; next_evaluation_due: string | null }[];
};

const shortMonth = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleString(undefined, { month: 'short', timeZone: 'UTC' });
const dateOnly = (d?: string | null) => String(d ?? '').slice(0, 10) || '—';

export function InventoryReports({ refreshKey }: { refreshKey: number }) {
  const [data, setData] = useState<Reports | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [months, setMonths] = useState(12);

  useEffect(() => {
    api<Reports>(`/supplier-inventory/reports?months=${months}`).then(setData).catch(e => setError((e as Error).message));
  }, [refreshKey, months]);

  if (error) return <div className="card"><div className="error">{error}</div></div>;
  if (!data) return <div className="card"><p>Loading…</p></div>;
  const t = data.totals;

  const expiryBands = [
    { label: 'Already expired', value: data.expiry.bands.expired, color: CHART_COLORS[3] },
    { label: 'Within 30 days', value: data.expiry.bands.within30, color: CHART_COLORS[2] },
    { label: 'Within 90 days', value: data.expiry.bands.within90, color: CHART_COLORS[0] },
    { label: 'Within 180 days', value: data.expiry.bands.within180, color: CHART_COLORS[1] },
  ];

  return <>
    <div className="section-head" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 12, borderTop: '1px solid var(--border)', paddingTop: 18 }}>
      <div>
        <h3 style={{ margin: 0 }}>Stock reporting</h3>
        <p className="muted" style={{ margin: '2px 0 0' }}>
          Live from the ledger — as at {new Date(data.generatedAt).toLocaleString()}.
        </p>
      </div>
      <select value={months} onChange={e => setMonths(Number(e.target.value))} aria-label="Reporting window" style={{ marginLeft: 'auto', width: 'auto' }}>
        {[3, 6, 12, 24].map(m => <option key={m} value={m}>Last {m} months</option>)}
      </select>
    </div>

    {/* The position itself is on the strip above this section; these are the
        figures the position does not show — what the stock is worth, what
        moved, and how much of it was lost. */}
    <KpiStrip items={[
      { label: 'Stock value', value: Math.round(t.stockValue).toLocaleString() },
      { label: 'Issued in the window', value: Math.round(t.issuedUnits).toLocaleString() },
      { label: 'Received in the window', value: Math.round(t.receivedUnits).toLocaleString() },
      { label: 'Wastage rate', value: `${t.wastageRate}%`, tone: t.wastageRate > 5 ? 'warning' : undefined },
      { label: 'Stock turnover a year', value: t.turnover ?? '—' },
    ]} />

    {/* Where every item stands is already on the strip and the donut above
        this section, so it is not drawn a second time. What the position
        cannot show is movement over time, which is what starts here. */}
    <div style={{ marginTop: 18 }}>
      <ChartCard title="Consumption against receipts" subtitle="What was issued each month against what was received">
        <BarChart data={data.trend.map(m => ({ label: shortMonth(m.month), value: m.issued, color: CHART_COLORS[0] }))} height={180} />
        <div style={{ marginTop: 10 }}>
          <p className="muted" style={{ margin: '0 0 4px' }}>Received</p>
          <Sparkline data={data.trend.map(m => m.received)} height={44} color={CHART_COLORS[1]} />
        </div>
      </ChartCard>
    </div>

    <div className="grid cols-2" style={{ marginTop: 18 }}>
      <ChartCard title="Expiry risk" subtitle="Batches by the shelf life they have left">
        <BarMeter data={expiryBands} />
        <p className="muted" style={{ marginTop: 10 }}>
          Value at risk within 90 days: <strong>{Math.round((data.expiry.value.expired ?? 0) + (data.expiry.value.within30 ?? 0) + (data.expiry.value.within90 ?? 0)).toLocaleString()}</strong>
        </p>
      </ChartCard>

      <ChartCard title="Wastage" subtitle="What was discarded rather than issued">
        <BarChart data={data.trend.map(m => ({ label: shortMonth(m.month), value: m.wasted, color: CHART_COLORS[3] }))} height={180} />
        <p className="muted" style={{ marginTop: 8 }}>
          {t.wastedUnits} unit{t.wastedUnits === 1 ? '' : 's'} discarded against {t.receivedUnits} received — a wastage rate of {t.wastageRate}%.
          {t.wastageRate > 5 ? ' That is high; check the expiry list and whether order quantities outlive their shelf life.' : ''}
        </p>
      </ChartCard>
    </div>

    <div className="card" style={{ marginTop: 18 }}>
      <h3>Replenishment list</h3>
      {data.shortages.length === 0 ? <p className="muted">Nothing is below its reorder level.</p> :
        <div className="table-scroll"><table className="data-table reg-table"><thead><tr>
          <th>Item</th><th>On hand</th><th>Issuable</th><th>Used per month</th><th>Cover</th><th>Supplier</th><th>Status</th>
        </tr></thead><tbody>
          {data.shortages.map(s => <tr key={s.id}>
            <td><span className="reg-primary">{s.name}</span>
              <span className="reg-sub">{[s.abc && `class ${s.abc}`, s.ven === 'vital' ? 'vital' : null].filter(Boolean).join(' · ')}</span></td>
            <td>{qty(s.onHand)} {s.unit || ''}</td>
            <td>{qty(s.issuable)}</td>
            <td>{s.amc ? qty(s.amc) : <span className="muted">—</span>}</td>
            <td className="nowrap">{s.monthsOfStock == null ? <span className="muted">—</span> : `${s.monthsOfStock} months`}</td>
            <td>{s.supplierName || <span className="muted">none recorded</span>}</td>
            <td><StatusBadge status={s.status} /></td>
          </tr>)}
        </tbody></table></div>}
    </div>

    <div className="grid cols-2" style={{ marginTop: 18 }}>
      <div className="card">
        <h3>Highest consumption</h3>
        {data.topConsumers.length === 0 ? <p className="muted">Nothing has been issued yet.</p> :
          <BarMeter data={data.topConsumers.slice(0, 8).map(c => ({ label: c.name, value: c.total }))} />}
      </div>
      <div className="card">
        <h3>Slow-moving stock</h3>
        <p className="muted" style={{ marginTop: 0 }}>Stock held that nothing has been issued from over the window — capital on a shelf, and a candidate for expiry.</p>
        {data.slowMovers.length === 0 ? <p className="muted">Everything held is moving.</p> :
          <div className="table-scroll"><table className="data-table"><thead><tr><th>Item</th><th>On hand</th><th>Value</th><th>Last issued</th></tr></thead><tbody>
            {data.slowMovers.map(s => <tr key={s.id}>
              <td>{s.name}</td><td>{s.onHand} {s.unit || ''}</td>
              <td>{s.value == null ? <span className="muted">—</span> : Math.round(s.value).toLocaleString()}</td>
              <td className="nowrap">{dateOnly(s.lastIssued)}</td>
            </tr>)}
          </tbody></table></div>}
      </div>
    </div>

    <div className="grid cols-2" style={{ marginTop: 18 }}>
      <ChartCard title="ABC analysis" subtitle="Where the money sits — class A is the few items carrying most of it">
        <BarMeter data={data.abcMix.map((a, i) => ({ label: `Class ${a.abc} — ${a.items} item${a.items === 1 ? '' : 's'}`, value: a.value, color: CHART_COLORS[i] }))} />
        <p className="muted" style={{ marginTop: 8 }}>Class A deserves the tightest control and the most frequent counting.</p>
      </ChartCard>
      <ChartCard title="VEN classification" subtitle="Vital items are chased whatever they cost">
        <DonutChart centerLabel="Items" data={data.venMix.map((v, i) => ({ label: v.ven, value: v.items, color: CHART_COLORS[i] }))} />
      </ChartCard>
    </div>

    <div className="card" style={{ marginTop: 18 }}>
      <h3>Supplier performance</h3>
      {data.supplierPerformance.length === 0 ? <p className="muted">No suppliers registered.</p> :
        <div className="table-scroll"><table className="data-table"><thead><tr>
          <th>Supplier</th><th>Deliveries in the window</th><th>Rejected on receipt</th><th>In quarantine</th><th>Rejection rate</th><th>Next evaluation</th>
        </tr></thead><tbody>
          {data.supplierPerformance.map(s => {
            const rate = s.deliveries > 0 ? Math.round((s.rejected / s.deliveries) * 1000) / 10 : 0;
            return <tr key={s.id}>
              <td><span className="reg-primary">{s.name}</span></td>
              <td>{s.deliveries}</td><td>{s.rejected}</td><td>{s.awaiting}</td>
              <td>{s.deliveries === 0 ? <span className="muted">—</span>
                : <span className="badge" style={rate > 5 ? { background: '#fde2e2', color: '#b42318' } : { background: '#e4f7ec', color: '#155c34' }}>{rate}%</span>}</td>
              <td className="nowrap">{dateOnly(s.next_evaluation_due)}</td>
            </tr>;
          })}
        </tbody></table></div>}
    </div>

    {data.expiry.batches.length > 0 && <div className="card" style={{ marginTop: 18 }}>
      <h3>Lots expiring within six months</h3>
      <div className="table-scroll"><table className="data-table"><thead><tr>
        <th>Item</th><th>Batch</th><th>Expires</th><th>Still on the shelf</th><th>Value</th>
      </tr></thead><tbody>
        {data.expiry.batches.map(b => <tr key={b.id}>
          <td>{b.item_name}</td><td>{b.batch_number || <span className="muted">—</span>}</td>
          <td className="nowrap">{dateOnly(b.expiry_date)}</td>
          <td>{b.quantity_available} {b.unit || ''}</td>
          <td>{b.unit_cost ? Math.round(b.unit_cost * b.quantity_available).toLocaleString() : <span className="muted">—</span>}</td>
        </tr>)}
      </tbody></table></div>
    </div>}
  </>;
}
