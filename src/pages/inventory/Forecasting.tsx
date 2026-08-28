import { FormEvent, useEffect, useMemo, useState } from 'react';
import { Lock, LockOpen, TrendingUp } from 'lucide-react';
import { api, errorText } from '../../services/api';
import { DetailModal, KpiStrip, ChartCard, Sparkline, BarChart, RegisterSearch, CHART_COLORS } from '../../components/ui';
import { useCappedRows } from '../../hooks/useCappedRows';
import { STOCK_STATUS_LABELS, VEN_CLASSES, VEN_LABELS, SERVICE_LEVEL_Z, type StockStatus } from '../../../shared/constants/stockControl';
import { StatusBadge, qty } from './StockControl';

/**
 * What to order, and what the levels should be.
 *
 * A minimum somebody typed in once is a guess that ages. These levels are
 * worked out from what the laboratory actually consumed: the demand is
 * forecast from its own history, the buffer is sized from how uneven that
 * demand has been and how long the supplier takes, and the reorder point and
 * maximum follow. The method and its error are shown beside every number,
 * because a level nobody can see the reasoning behind is a level nobody
 * follows.
 */

type Advice = {
  item: {
    id: number; itemCode: string; name: string; unit: string | null; category: string | null;
    supplierName: string | null; abcClass: string | null; venClass: string;
    leadTimeDays: number; reviewPeriodDays: number; serviceLevel: number; unitCost: number | null;
    planningLocked: number; onHand: number; issuable: number; status: StockStatus;
    monthsOfStock: number | null; consumption: number[]; priority: 1 | 2 | 3;
  };
  forecast: { method: string; nextPeriod: number; horizon: number[]; mape: number | null; sigma: number; trend: number; periodsUsed: number; confidence: string; note: string };
  amc: number; safetyStock: number; reorderLevel: number; minimumStock: number; maximumStock: number;
  suggestedOrder: number; eoq: number | null; coverMonths: number | null;
  current: { minimum: number; reorder: number; maximum: number | null };
  changed: boolean;
};

const CONFIDENCE_TONE: Record<string, { bg: string; fg: string }> = {
  good: { bg: '#e4f7ec', fg: '#155c34' },
  moderate: { bg: '#fff7df', fg: '#6b4b05' },
  low: { bg: '#fde2e2', fg: '#b42318' },
  none: { bg: 'transparent', fg: 'inherit' },
};

export function ForecastingPanel({ canEdit, refreshKey, onApplied }: { canEdit: boolean; refreshKey: number; onApplied: () => void }) {
  const [rows, setRows] = useState<Advice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [only, setOnly] = useState<'order' | 'changed' | 'all'>('order');
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [tuning, setTuning] = useState<Advice | null>(null);
  const [months, setMonths] = useState(12);

  const load = () => {
    setLoading(true);
    api<{ rows: Advice[] }>(`/supplier-inventory/forecast?months=${months}`)
      .then(d => setRows(d.rows))
      .catch(e => setError(errorText(e)))
      .finally(() => setLoading(false));
  };
  useEffect(load, [refreshKey, months]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter(r => {
      if (only === 'order' && r.suggestedOrder <= 0) return false;
      if (only === 'changed' && !r.changed) return false;
      if (!q) return true;
      return [r.item.name, r.item.itemCode, r.item.category, r.item.supplierName].some(v => String(v ?? '').toLowerCase().includes(q));
    }).sort((a, b) => a.item.priority - b.item.priority || b.suggestedOrder - a.suggestedOrder);
  }, [rows, query, only]);
  const page = useCappedRows(shown);

  const totals = useMemo(() => ({
    toOrder: rows.filter(r => r.suggestedOrder > 0).length,
    orderValue: rows.reduce((n, r) => n + r.suggestedOrder * (r.item.unitCost ?? 0), 0),
    forecastable: rows.filter(r => r.forecast.method !== 'none').length,
    goodFit: rows.filter(r => r.forecast.confidence === 'good').length,
    levelsStale: rows.filter(r => r.changed && !r.item.planningLocked).length,
  }), [rows]);

  async function apply(ids: number[]) {
    if (ids.length === 0) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const r = await api<{ applied: any[]; skipped: any[] }>('/supplier-inventory/forecast/apply', {
        method: 'POST', body: JSON.stringify({ itemIds: ids, months }),
      });
      setNotice(`Levels set on ${r.applied.length} item${r.applied.length === 1 ? '' : 's'}`
        + (r.skipped.length ? `. ${r.skipped.length} skipped — ${r.skipped[0].reason}.` : '.'));
      setPicked(new Set());
      load(); onApplied();
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  }

  const toggle = (id: number) => setPicked(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  return <>
    <KpiStrip items={[
      { label: 'To order now', value: totals.toOrder, tone: totals.toOrder ? 'warning' : undefined },
      { label: 'Order value', value: Math.round(totals.orderValue).toLocaleString() },
      { label: 'Items with enough history', value: totals.forecastable },
      { label: 'Forecasts fitting well', value: totals.goodFit },
      { label: 'Levels out of date', value: totals.levelsStale, tone: totals.levelsStale ? 'warning' : undefined },
    ]} />

    <div className="card" style={{ marginTop: 16 }}>
      <div className="section-head" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <div>
          <h3 style={{ margin: 0 }}>Demand forecast and order proposal</h3>
          <p className="muted" style={{ margin: '2px 0 0', maxWidth: 780 }}>
            Each item's own consumption decides its levels. The buffer covers how uneven that use has been over the
            supplier's lead time at the service level set for the item; the reorder level covers the lead time on top of
            it; the maximum covers the lead time and the ordering cycle together.
          </p>
        </div>
        <div className="reg-head-actions" style={{ marginLeft: 'auto' }}>
          <RegisterSearch onQuery={setQuery} placeholder="Search item, supplier…" />
          <select value={months} onChange={e => setMonths(Number(e.target.value))} aria-label="History window">
            {[6, 12, 18, 24, 36].map(m => <option key={m} value={m}>{m} months of history</option>)}
          </select>
        </div>
      </div>

      <div className="reg-seg" role="tablist" style={{ margin: '4px 0 12px' }}>
        {([['order', 'To order'], ['changed', 'Levels out of date'], ['all', 'Everything']] as const).map(([k, l]) =>
          <button key={k} type="button" role="tab" aria-selected={only === k} className={only === k ? 'on' : ''} onClick={() => setOnly(k)}>{l}</button>)}
      </div>

      {error && <div className="error">{error}</div>}
      {notice && <div className="notice-ok">{notice}</div>}

      {canEdit && shown.length > 0 && <div className="reg-head-actions" style={{ marginBottom: 10 }}>
        <button type="button" className="secondary" onClick={() => setPicked(new Set(shown.filter(r => !r.item.planningLocked).map(r => r.item.id)))}>Select all shown</button>
        <button type="button" disabled={busy || picked.size === 0} onClick={() => void apply([...picked])}>
          {busy ? 'Applying…' : `Apply the levels to ${picked.size} item${picked.size === 1 ? '' : 's'}`}
        </button>
      </div>}

      {loading ? <p>Loading…</p> : shown.length === 0 ? <p className="muted">
        {only === 'order' ? 'Nothing needs ordering — every item is above its reorder level.' : 'Nothing here.'}
      </p> : <>
        <div className="table-scroll"><table className="data-table reg-table"><thead><tr>
          {canEdit && <th style={{ width: 32 }}></th>}
          <th>Item</th><th>Used per month</th><th>Cover</th>
          <th>Forecast next month</th><th>Proposed min / reorder / max</th><th>Order now</th>
        </tr></thead><tbody>
          {page.shown.map(r => <tr key={r.item.id} className="row-clickable" onClick={() => setTuning(r)} tabIndex={0} role="button"
            onKeyDown={e => { if (e.key === 'Enter') setTuning(r); }}>
            {canEdit && <td onClick={e => e.stopPropagation()}>
              <input type="checkbox" checked={picked.has(r.item.id)} disabled={!!r.item.planningLocked}
                onChange={() => toggle(r.item.id)} aria-label={`Apply levels to ${r.item.name}`} />
            </td>}
            <td>
              <span className="reg-primary">{r.item.name}{r.item.planningLocked ? <Lock size={11} style={{ marginLeft: 6, verticalAlign: '-1px' }} /> : null}</span>
              <span className="reg-sub">{r.item.itemCode}{r.item.abcClass ? ` · ${r.item.abcClass}` : ''}{r.item.venClass === 'vital' ? ' · vital' : ''} · {r.item.leadTimeDays}-day lead time</span>
            </td>
            <td style={{ minWidth: 110 }}>
              <span className="reg-primary">{r.amc ? qty(r.amc) : '—'}</span>
              {r.item.consumption.some(v => v > 0) &&
                <Sparkline data={r.item.consumption} height={26} color={r.forecast.trend > 0 ? CHART_COLORS[1] : CHART_COLORS[0]} />}
            </td>
            <td className="nowrap">{r.coverMonths == null ? <span className="muted">—</span> : `${r.coverMonths} months`}<span className="reg-sub"><StatusBadge status={r.item.status} /></span></td>
            <td>
              <span className="reg-primary">{qty(r.forecast.nextPeriod)} {r.item.unit || ''}</span>
              <span className="reg-sub">
                <span className="badge plain" style={CONFIDENCE_TONE[r.forecast.confidence] && { background: CONFIDENCE_TONE[r.forecast.confidence].bg, color: CONFIDENCE_TONE[r.forecast.confidence].fg }}>
                  {r.forecast.confidence === 'none' ? 'no data' : `${r.forecast.confidence} fit`}
                </span>
                {r.forecast.mape != null ? ` ±${Math.round(r.forecast.mape)}%` : ''}
                {r.forecast.trend !== 0 ? ` · ${r.forecast.trend > 0 ? '▲' : '▼'} ${Math.abs(r.forecast.trend)}/mo` : ''}
              </span>
            </td>
            <td className="nowrap">
              <span className="reg-primary">{r.minimumStock} / {r.reorderLevel} / {r.maximumStock}</span>
              {r.changed && <span className="reg-sub">now {r.current.minimum} / {r.current.reorder} / {r.current.maximum ?? '—'}</span>}
            </td>
            <td>{r.suggestedOrder > 0
              ? <><span className="reg-primary">{qty(r.suggestedOrder)} {r.item.unit || ''}</span>
                {r.item.unitCost ? <span className="reg-sub">≈ {Math.round(r.suggestedOrder * r.item.unitCost).toLocaleString()}</span> : null}</>
              : <span className="muted">—</span>}</td>
          </tr>)}
        </tbody></table></div>
        {page.hidden > 0 && <p className="muted list-capped">
          Showing the first {page.shown.length.toLocaleString()} of {page.total.toLocaleString()} items, highest priority first.
        </p>}
      </>}
    </div>

    {tuning && <PlanningPanel advice={tuning} canEdit={canEdit} onClose={() => setTuning(null)}
      onSaved={() => { setTuning(null); load(); onApplied(); }} />}
  </>;
}

/**
 * One item's plan, and the assumptions behind it.
 *
 * The lead time, the service level and how critical the item is are the three
 * dials that move every number on this screen, so they are editable right here
 * beside the numbers they produce.
 */
function PlanningPanel({ advice, canEdit, onClose, onSaved }: {
  advice: Advice; canEdit: boolean; onClose: () => void; onSaved: () => void;
}) {
  const it = advice.item;
  const [form, setForm] = useState({
    leadTimeDays: String(it.leadTimeDays), reviewPeriodDays: String(it.reviewPeriodDays),
    serviceLevel: String(it.serviceLevel), unitCost: it.unitCost == null ? '' : String(it.unitCost),
    venClass: it.venClass, abcClass: it.abcClass ?? '', planningLocked: !!it.planningLocked,
    minimumStock: String(advice.current.minimum), reorderLevel: String(advice.current.reorder),
    maximumStock: advice.current.maximum == null ? '' : String(advice.current.maximum),
  });
  const [busy, setBusy] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function save(e: FormEvent) {
    e.preventDefault(); setBusy('save'); setError(null);
    try {
      await api(`/supplier-inventory/planning/${it.id}`, { method: 'PUT', body: JSON.stringify(form) });
      onSaved();
    } catch (err) { setError(errorText(err)); }
    finally { setBusy(''); }
  }
  async function applyProposed() {
    setBusy('apply'); setError(null);
    try {
      await api('/supplier-inventory/forecast/apply', { method: 'POST', body: JSON.stringify({ itemIds: [it.id] }) });
      onSaved();
    } catch (err) { setError(errorText(err)); }
    finally { setBusy(''); }
  }

  return <DetailModal open onClose={onClose} title={it.name} subtitle={`${it.itemCode} · planning`}
    header={<>
      <StatusBadge status={it.status} />
      {it.planningLocked ? <span className="badge"><Lock size={11} /> levels locked</span> : null}
    </>}>
    {error && <div className="error">{error}</div>}

    <div className="stock-figures">
      <div><span className="fig">{qty(it.onHand)} <small>{it.unit || ''}</small></span><span className="fig-label">on hand</span></div>
      <div><span className="fig">{qty(advice.amc)}</span><span className="fig-label">used per month</span></div>
      <div><span className="fig">{advice.coverMonths ?? '—'}</span><span className="fig-label">months of cover</span></div>
      <div><span className="fig">{Math.round(advice.forecast.nextPeriod)}</span><span className="fig-label">forecast next month</span></div>
      <div><span className="fig">{qty(advice.suggestedOrder)}</span><span className="fig-label">order now</span></div>
    </div>

    <div className="plan-explain">
      <h4 style={{ marginBottom: 6 }}><TrendingUp size={15} style={{ verticalAlign: '-2px' }} /> How these numbers were reached</h4>
      <p className="muted" style={{ marginTop: 0 }}>{advice.forecast.note}</p>
      <ol className="plan-steps">
        <li><strong>Demand</strong> — {Math.round(advice.forecast.nextPeriod)} {it.unit || 'units'} a month, from {advice.forecast.periodsUsed} periods of this item's own use.</li>
        <li><strong>Buffer</strong> — {advice.safetyStock} {it.unit || 'units'}, covering how uneven that use has been (±{Math.round(advice.forecast.sigma)} a month) across a {it.leadTimeDays}-day wait at a {Math.round(it.serviceLevel * 100)}% service level.</li>
        <li><strong>Reorder at</strong> — {advice.reorderLevel}, so an order placed then arrives before the buffer is gone.</li>
        <li><strong>Maximum</strong> — {advice.maximumStock}, enough for the {it.leadTimeDays}-day lead time and the {it.reviewPeriodDays}-day ordering cycle together.</li>
        {advice.eoq != null && <li><strong>Economic order quantity</strong> — {advice.eoq}, if ordering cost and holding cost were the only considerations. Pack size and shelf life usually decide instead.</li>}
      </ol>
      {advice.item.consumption.some(v => v > 0) && <div style={{ marginTop: 10 }}>
        <p className="muted" style={{ margin: '0 0 4px' }}>Completed months, then the next three forecast</p>
        <Sparkline data={[...it.consumption.slice(0, -1), ...advice.forecast.horizon]} height={70} />
      </div>}
    </div>

    <form className="form" onSubmit={save} style={{ marginTop: 16 }}>
      <h4 style={{ margin: '0 0 4px' }}>The assumptions</h4>
      <label>Supplier lead time <span className="muted">(days from order to delivery)</span>
        <input type="number" min={1} value={form.leadTimeDays} onChange={e => setForm({ ...form, leadTimeDays: e.target.value })} /></label>
      <label>Ordering cycle <span className="muted">(days between orders)</span>
        <input type="number" min={1} value={form.reviewPeriodDays} onChange={e => setForm({ ...form, reviewPeriodDays: e.target.value })} /></label>
      <label>Service level <span className="muted">(the chance of not running out while waiting)</span>
        <select value={form.serviceLevel} onChange={e => setForm({ ...form, serviceLevel: e.target.value })}>
          {SERVICE_LEVEL_Z.filter(([l]) => l >= 0.8).map(([l]) => <option key={l} value={l}>{Math.round(l * 100)}%</option>)}
        </select></label>
      <label>How critical<select value={form.venClass} onChange={e => setForm({ ...form, venClass: e.target.value })}>
        {VEN_CLASSES.map(v => <option key={v} value={v}>{VEN_LABELS[v]}</option>)}
      </select></label>
      <label>Value class <span className="muted">(blank follows the spend)</span>
        <select value={form.abcClass} onChange={e => setForm({ ...form, abcClass: e.target.value })}>
          <option value="">Work it out from the spend</option>
          {['A', 'B', 'C'].map(c => <option key={c} value={c}>{c}</option>)}
        </select></label>
      <label>Unit cost<input type="number" step="any" min={0} value={form.unitCost} onChange={e => setForm({ ...form, unitCost: e.target.value })} /></label>
      <label>Minimum<input type="number" min={0} value={form.minimumStock} onChange={e => setForm({ ...form, minimumStock: e.target.value })} /></label>
      <label>Reorder level<input type="number" min={0} value={form.reorderLevel} onChange={e => setForm({ ...form, reorderLevel: e.target.value })} /></label>
      <label>Maximum<input type="number" min={0} value={form.maximumStock} onChange={e => setForm({ ...form, maximumStock: e.target.value })} /></label>
      <label className="toggle">
        <input type="checkbox" checked={form.planningLocked} onChange={e => setForm({ ...form, planningLocked: e.target.checked })} />
        {form.planningLocked ? <Lock size={13} /> : <LockOpen size={13} />} Keep these levels — do not let the forecast change them
      </label>
      {canEdit && <div className="reg-head-actions">
        <button type="submit" disabled={!!busy}>{busy === 'save' ? 'Saving…' : 'Save'}</button>
        <button type="button" className="secondary" disabled={!!busy || !!form.planningLocked} onClick={() => void applyProposed()}>
          {busy === 'apply' ? 'Applying…' : `Use the proposed ${advice.minimumStock} / ${advice.reorderLevel} / ${advice.maximumStock}`}
        </button>
      </div>}
    </form>
  </DetailModal>;
}
