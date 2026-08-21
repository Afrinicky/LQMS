import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Trash2, Search, ClipboardList, PackageCheck, Printer, Lock, LockOpen } from 'lucide-react';
import { api, API_BASE, getToken } from '../../services/api';
import { DetailModal, KpiStrip, ChartCard, DonutChart, BarChart, BarMeter, Sparkline, CHART_COLORS } from '../../components/ui';
import BarcodeScanner from '../../components/BarcodeScanner';
import type { Section, Staff } from '../../../shared/types/api';
import { STOCK_STATUS_LABELS, NEEDS_ACTION, type StockStatus } from '../../../shared/constants/stockControl';
import { MOVEMENT_LABELS } from '../../../shared/constants/inventory';
import type { ConfigOption } from '../../../shared/constants/configLists';

/**
 * Running the store.
 *
 * The item register says what the laboratory stocks. These screens are about
 * what it holds: what is on the shelf now, what came in, what went out and to
 * whom, what the count found, and what to order next. They are written for the
 * person at the issuing counter with somebody waiting, which is why issuing is
 * one screen and not a tour of three.
 */

// ─────────────────────────────────────────────────────────────── shared bits

export type LedgerRow = {
  id: number; item_code: string; name: string; category: string | null; unit: string | null;
  storage_path: string | null; section_name: string | null; supplier_name: string | null;
  is_active: number; ven_class: string; abc_class: string | null; unit_cost: number | null;
  lead_time_days: number; review_period_days: number; service_level: number; planning_locked: number;
  minimum_stock: number; reorder_level: number; maximum_stock: number | null;
  on_hand: number; issuable: number; quarantined: number; expired_on_hand: number;
  batch_count: number; earliest_expiry: string | null; expiry_status: string | null;
  amc: number; months_of_stock: number | null; status: StockStatus; priority: 1 | 2 | 3;
  stock_value: number | null; last_issued: string | null; last_received: string | null;
  consumption: number[];
};

const STATUS_TONE: Record<string, { bg: string; fg: string }> = {
  stockout: { bg: '#fde2e2', fg: '#b42318' },
  blocked: { bg: '#fde2e2', fg: '#b42318' },
  critical: { bg: '#fde2e2', fg: '#b42318' },
  low: { bg: '#fff7df', fg: '#6b4b05' },
  adequate: { bg: '#e4f7ec', fg: '#155c34' },
  overstock: { bg: '#e8eefc', fg: '#1e40af' },
  unknown: { bg: 'transparent', fg: 'inherit' },
};

export function StatusBadge({ status }: { status: StockStatus }) {
  const t = STATUS_TONE[status] ?? STATUS_TONE.unknown;
  return <span className="badge plain" style={{ background: t.bg, color: t.fg }}>{STOCK_STATUS_LABELS[status]}</span>;
}

/** A count of things. Nobody issues 1426.08 tubes, so nobody should read it. */
export const qty = (n: number | null | undefined) =>
  n == null ? '—' : Math.abs(n) >= 100 ? Math.round(n).toLocaleString() : String(Math.round(n * 10) / 10);
const dateOnly = (d?: string | null) => String(d ?? '').slice(0, 10) || '—';
/** Cover in words: "3.4 months" reads better than a bare number in a column. */
const cover = (m: number | null) => m == null ? '—' : m < 1 ? `${Math.round(m * 30)} days` : `${m} months`;

async function download(path: string, fallback: string) {
  const res = await fetch(`${API_BASE}${path}`, { headers: getToken() ? { Authorization: `Bearer ${getToken()}` } : undefined });
  if (!res.ok) throw new Error((await res.json().catch(() => ({ error: res.statusText }))).error ?? res.statusText);
  const named = (res.headers.get('Content-Disposition') || '').match(/filename="?([^"]+)"?/);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url; a.download = named ? named[1] : fallback;
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}

// ────────────────────────────────────────────────────── the control ledger

/**
 * What the laboratory holds, and whether that is enough.
 *
 * The columns are chosen the way a supply officer reads a shelf: how much is
 * there, how much of it can actually go out today, how long it will last at
 * the rate it is going, and when the first lot turns. Quantity alone answers
 * none of those — 40 units is a fortnight of one reagent and two years of
 * another.
 */
export function StockLedger({ onOpenItem, refreshKey }: { onOpenItem: (id: number) => void; refreshKey: number }) {
  const [rows, setRows] = useState<LedgerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'attention' | 'expiring' | 'quarantine' | 'idle'>('all');
  const [card, setCard] = useState<number | null>(null);

  useEffect(() => {
    setLoading(true);
    api<{ rows: LedgerRow[] }>('/supplier-inventory/ledger')
      .then(d => setRows(d.rows))
      .catch(e => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, [refreshKey]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter(r => {
      if (filter === 'attention' && !NEEDS_ACTION.includes(r.status)) return false;
      if (filter === 'expiring' && !['expired', 'expiring_soon'].includes(r.expiry_status ?? '')) return false;
      if (filter === 'quarantine' && r.quarantined <= 0) return false;
      if (filter === 'idle' && !(r.on_hand > 0 && r.amc === 0)) return false;
      if (!q) return true;
      return [r.name, r.item_code, r.category, r.storage_path, r.supplier_name].some(v => String(v ?? '').toLowerCase().includes(q));
    }).sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));
  }, [rows, query, filter]);

  const totals = useMemo(() => ({
    items: rows.length,
    attention: rows.filter(r => NEEDS_ACTION.includes(r.status)).length,
    stockout: rows.filter(r => r.status === 'stockout').length,
    quarantined: rows.filter(r => r.quarantined > 0).length,
    expiring: rows.filter(r => ['expired', 'expiring_soon'].includes(r.expiry_status ?? '')).length,
    value: rows.reduce((n, r) => n + (r.stock_value ?? 0), 0),
  }), [rows]);

  return <>
    <KpiStrip items={[
      { label: 'Items held', value: totals.items },
      { label: 'Need ordering', value: totals.attention, tone: totals.attention ? 'warning' : undefined, onClick: () => setFilter('attention') },
      { label: 'Out of stock', value: totals.stockout, tone: 'danger', onClick: () => setFilter('attention') },
      { label: 'Expiring or expired', value: totals.expiring, tone: totals.expiring ? 'warning' : undefined, onClick: () => setFilter('expiring') },
      { label: 'Quarantined', value: totals.quarantined, onClick: () => setFilter('quarantine') },
    ]} />

    <div className="card" style={{ marginTop: 16 }}>
      <div className="section-head" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <div>
          <h3 style={{ margin: 0 }}>Stock control ledger</h3>
          <p className="muted" style={{ margin: '2px 0 0' }}>
            Everything the store holds. <strong>On hand</strong> is what is physically there; <strong>issuable</strong> is
            what may actually go out today, once quarantined and out-of-date lots are set aside.
          </p>
        </div>
        <div className="reg-head-actions" style={{ marginLeft: 'auto' }}>
          <label className="reg-search"><Search size={15} />
            <input placeholder="Search item, code, category, shelf…" value={query} onChange={e => setQuery(e.target.value)} />
          </label>
          <button type="button" className="secondary" onClick={() => void download('/supplier-inventory/ledger/export', 'Stock_Control_Ledger.xlsx').catch(e => setError((e as Error).message))}>Export</button>
        </div>
      </div>

      <div className="reg-seg" role="tablist" aria-label="Filter the ledger" style={{ margin: '4px 0 12px' }}>
        {([['all', 'Everything'], ['attention', 'Needs ordering'], ['expiring', 'Expiring'], ['quarantine', 'In quarantine'], ['idle', 'Not moving']] as const).map(([k, label]) =>
          <button key={k} type="button" role="tab" aria-selected={filter === k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>{label}</button>)}
      </div>

      {error && <div className="error">{error}</div>}
      {loading ? <p>Loading…</p> : shown.length === 0 ? <p className="muted">Nothing here.</p> :
        <div className="table-scroll"><table className="data-table reg-table ledger-table"><thead><tr>
          <th>Item</th><th>Available</th><th>Used / month</th><th>Cover</th>
          <th>Min / reorder / max</th><th>Expires first</th><th>Status</th>
        </tr></thead><tbody>
          {shown.map(r => <tr key={r.id} className="row-clickable" onClick={() => setCard(r.id)} tabIndex={0} role="button"
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setCard(r.id); } }}>
            <td>
              <span className="reg-primary">{r.name}</span>
              <span className="reg-sub">{[r.item_code, r.storage_path, r.abc_class && `class ${r.abc_class}`, r.ven_class === 'vital' && 'vital'].filter(Boolean).join(' · ')}</span>
            </td>
            {/* What can go out today comes first; what is present but held is
                said underneath, because that is the thing to act on. */}
            <td>
              <span className="reg-primary">{qty(r.issuable)} {r.unit || ''}</span>
              {r.quarantined > 0 && <span className="reg-sub">{qty(r.quarantined)} awaiting inspection</span>}
              {r.expired_on_hand > 0 && <span className="reg-sub">{qty(r.expired_on_hand)} expired on the shelf</span>}
              {r.on_hand !== r.issuable && r.quarantined === 0 && r.expired_on_hand === 0 && <span className="reg-sub">{qty(r.on_hand)} on hand</span>}
            </td>
            <td>{r.amc ? qty(r.amc) : <span className="muted">—</span>}</td>
            <td className="nowrap">{cover(r.months_of_stock)}</td>
            <td className="nowrap">{qty(r.minimum_stock || 0)} / {qty(r.reorder_level || 0)} / {r.maximum_stock == null ? '—' : qty(r.maximum_stock)}</td>
            <td className="nowrap">{r.earliest_expiry
              ? <>{dateOnly(r.earliest_expiry)}{r.expiry_status && r.expiry_status !== 'valid' &&
                  <span className="badge" style={{ background: r.expiry_status === 'expired' ? '#fde2e2' : '#fff7df', color: r.expiry_status === 'expired' ? '#b42318' : '#6b4b05' }}>{r.expiry_status.replace('_', ' ')}</span>}</>
              : <span className="muted">—</span>}</td>
            <td><StatusBadge status={r.status} /></td>
          </tr>)}
        </tbody></table></div>}
    </div>

    {card != null && <BinCard itemId={card} onClose={() => setCard(null)} onOpenItem={onOpenItem} />}
  </>;
}

/**
 * The tally card that hangs on the shelf.
 *
 * Every movement in date order with the balance it left behind. This is the
 * document a storekeeper checks the shelf against and an assessor asks to see,
 * and it is the reason each movement records its balance at the time rather
 * than having one worked out afterwards.
 */
export function BinCard({ itemId, onClose, onOpenItem }: { itemId: number; onClose: () => void; onOpenItem: (id: number) => void }) {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api(`/supplier-inventory/ledger/${itemId}`).then(setData).catch(e => setError((e as Error).message));
  }, [itemId]);

  const p = data?.position as LedgerRow | null;
  return <DetailModal open onClose={onClose}
    title={data ? `${data.item.name} — bin card` : 'Bin card'}
    subtitle={data?.item.itemCode}
    header={data && <>
      {p && <StatusBadge status={p.status} />}
      <button type="button" className="secondary" onClick={() => { onClose(); onOpenItem(itemId); }}>Open the item</button>
    </>}>
    {error && <div className="error">{error}</div>}
    {!data ? <p>Loading…</p> : <>
      <div className="stock-figures">
        <div><span className="fig">{qty(data.onHand)} <small>{data.item.unit || ''}</small></span><span className="fig-label">on the shelf</span></div>
        <div><span className="fig">{qty(p?.issuable)}</span><span className="fig-label">available to issue</span></div>
        <div><span className="fig">{qty(p?.amc ?? 0)}</span><span className="fig-label">used per month</span></div>
        <div><span className="fig">{cover(p?.months_of_stock ?? null)}</span><span className="fig-label">cover left</span></div>
        <div><span className="fig">{dateOnly(p?.earliest_expiry)}</span><span className="fig-label">expires first</span></div>
      </div>

      {!data.reconciles && <div className="notice-warn" style={{ marginTop: 10 }}>
        The card's running balance and the shelf do not agree. Something was posted out of order or backdated — a stock count will settle it.
      </div>}

      {p && p.consumption.some((n: number) => n > 0) && <div style={{ marginTop: 16 }}>
        <p className="muted" style={{ margin: '0 0 4px' }}>Issued per completed month over the last year</p>
        <Sparkline data={p.consumption.slice(0, -1)} height={64} />
      </div>}

      <h4>Movements</h4>
      {data.lines.length === 0 ? <p className="muted">Nothing has moved yet.</p> :
        <div className="table-scroll"><table className="data-table"><thead><tr>
          <th>Date</th><th>Movement</th><th>In</th><th>Out</th><th>Balance</th><th>Batch</th><th>To / from</th><th>Reference</th>
        </tr></thead><tbody>
          {data.lines.map((l: any) => <tr key={l.id}>
            <td className="nowrap">{dateOnly(l.movement_date)}</td>
            <td>{MOVEMENT_LABELS[l.movement_type] ?? String(l.movement_type).replace(/_/g, ' ')}</td>
            <td>{l.direction === 'in' ? l.quantity : ''}</td>
            <td>{l.direction === 'out' ? l.quantity : ''}</td>
            <td><strong>{l.running_balance}</strong></td>
            <td>{l.batch_number || <span className="muted">—</span>}</td>
            <td>{l.issued_to_section_name || l.received_by_name || <span className="muted">—</span>}</td>
            <td>{l.issue_number || l.reason || <span className="muted">—</span>}</td>
          </tr>)}
        </tbody></table></div>}
    </>}
  </DetailModal>;
}

// ──────────────────────────────────────────────────────────── issuing out

type BasketLine = { itemId: string; quantity: string };

/**
 * The issuing counter.
 *
 * Somebody from a unit is standing there. Name the unit, the member of staff
 * collecting and why the stock is wanted, add the lines, and issue. The store
 * allocates the lots — earliest expiry first — and writes a numbered voucher.
 * Nothing here asks the storekeeper to choose a batch, because that was the
 * step that made people give up and write it on a card instead.
 */
export function IssueDesk({ items, sections, staff, reasons, onIssued }: {
  items: LedgerRow[]; sections: Section[]; staff: Staff[]; reasons: ConfigOption[]; onIssued: () => void;
}) {
  const [sectionId, setSectionId] = useState('');
  const [receivedByStaffId, setReceivedByStaffId] = useState('');
  const [purpose, setPurpose] = useState('');
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<BasketLine[]>([{ itemId: '', quantity: '' }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [voucher, setVoucher] = useState<any>(null);

  const byId = useMemo(() => new Map(items.map(i => [String(i.id), i])), [items]);
  const setLine = (i: number, patch: Partial<BasketLine>) =>
    setLines(ls => ls.map((l, n) => (n === i ? { ...l, ...patch } : l)));

  /**
   * Every item on the register is offered, not only the ones with stock.
   *
   * A storekeeper who cannot find an item in the list assumes it was never
   * registered and registers it again. So the whole catalogue is here, split
   * into what can go out today and what cannot, with the reason it cannot on
   * the option itself.
   */
  const groups = useMemo(() => {
    const available = items.filter(i => i.issuable > 0);
    const held = items.filter(i => i.issuable <= 0);
    const label = (i: LedgerRow) => i.issuable > 0
      ? `${i.name} — ${qty(i.issuable)} ${i.unit || ''} available`.replace(/\s+/g, ' ')
      : `${i.name} — ${i.quarantined > 0 ? 'awaiting inspection'
        : i.expired_on_hand > 0 ? 'expired on the shelf'
        : i.on_hand > 0 ? 'on hand but not released' : 'out of stock'}`;
    return { available, held, label };
  }, [items]);

  const shortLines = lines.filter(l => {
    const item = byId.get(l.itemId);
    return item ? Number(l.quantity) > item.issuable : false;
  }).length;

  /** A scan at the counter drops the item straight into the basket. */
  async function scanIn(code: string) {
    setError(null);
    try {
      const hit = await api<{ kind: string; id: number; itemId?: number }>(`/supplier-inventory/scan/${encodeURIComponent(code.trim())}`);
      const id = String(hit.kind === 'batch' ? (hit.itemId ?? hit.id) : hit.id);
      setLines(ls => {
        const existing = ls.findIndex(l => l.itemId === id);
        if (existing >= 0) {
          const next = [...ls];
          next[existing] = { ...next[existing], quantity: String((Number(next[existing].quantity) || 0) + 1) };
          return next;
        }
        const blank = ls.findIndex(l => !l.itemId);
        const next = [...ls];
        if (blank >= 0) next[blank] = { itemId: id, quantity: '1' };
        else next.push({ itemId: id, quantity: '1' });
        return next;
      });
    } catch (e) { setError((e as Error).message); }
  }

  async function submit(e: FormEvent) {
    e.preventDefault(); setError(null);
    const payload = lines
      .filter(l => l.itemId && Number(l.quantity) > 0)
      .map(l => ({ itemId: Number(l.itemId), quantity: Number(l.quantity) }));
    if (payload.length === 0) { setError('Add at least one item.'); return; }
    if (!sectionId && !receivedByStaffId) { setError('Say which unit this is going to, or who is collecting it.'); return; }
    // Nothing is sent while a line asks for more than can go out: the whole
    // voucher would be refused, and the storekeeper would be told at the
    // counter rather than on the screen in front of them.
    if (shortLines > 0) { setError('One or more lines ask for more than can be issued. Reduce them, or take the item off the voucher.'); return; }
    setBusy(true);
    try {
      const r = await api<any>('/supplier-inventory/issues', {
        method: 'POST',
        body: JSON.stringify({ sectionId: sectionId || null, receivedByStaffId: receivedByStaffId || null, purpose, note, lines: payload }),
      });
      setVoucher(r);
      setLines([{ itemId: '', quantity: '' }]); setPurpose(''); setNote('');
      onIssued();
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }

  return <>
    <div className="card">
      <h3>Issue stock to a unit</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        Name the unit, the member of staff collecting and why. The store allocates the lots — earliest expiry
        first — and writes a numbered issue voucher.
      </p>
      {error && <div className="error">{error}</div>}

      <form onSubmit={submit}>
        <div className="issue-head">
          <label>Issued to unit<select value={sectionId} onChange={e => setSectionId(e.target.value)}>
            <option value="">Select the unit</option>
            {sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select></label>
          <label>Collected by<select value={receivedByStaffId} onChange={e => setReceivedByStaffId(e.target.value)}>
            <option value="">Select the member of staff</option>
            {staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}
          </select></label>
          <label>Reason for issue<select value={purpose} onChange={e => setPurpose(e.target.value)}>
            <option value="">Select a reason</option>
            {reasons.map(r => <option key={r.id} value={r.value}>{r.label}</option>)}
          </select>
          {reasons.length === 0 && <span className="muted">No reasons configured — add them in Settings → Dropdown Lists.</span>}</label>
          <label>Remarks<input value={note} onChange={e => setNote(e.target.value)} placeholder="Optional — anything the voucher should carry" /></label>
        </div>

        <div style={{ margin: '12px 0' }}>
          <BarcodeScanner placeholder="Scan an item to add it…" autoFocus={false} onScan={scanIn} />
        </div>

        <div className="table-scroll"><table className="data-table issue-lines"><thead><tr>
          <th style={{ width: '46%' }}>Item</th><th>Available</th><th style={{ width: 140 }}>Quantity</th><th>Issued from</th><th></th>
        </tr></thead><tbody>
          {lines.map((l, i) => {
            const item = byId.get(l.itemId);
            const want = Number(l.quantity) || 0;
            const short = item ? want > item.issuable : false;
            return <tr key={i}>
              <td>
                <select value={l.itemId} onChange={e => setLine(i, { itemId: e.target.value })}>
                  <option value="">Select an item</option>
                  {groups.available.length > 0 && <optgroup label="Available to issue">
                    {groups.available.map(it => <option key={it.id} value={it.id}>{groups.label(it)}</option>)}
                  </optgroup>}
                  {groups.held.length > 0 && <optgroup label="Nothing available to issue">
                    {groups.held.map(it => <option key={it.id} value={it.id}>{groups.label(it)}</option>)}
                  </optgroup>}
                </select>
                {item && item.storage_path && <span className="reg-sub">{item.storage_path}</span>}
              </td>
              <td>{item ? <><span className="reg-primary">{qty(item.issuable)} {item.unit || ''}</span>
                {item.quarantined > 0 && <span className="reg-sub">{qty(item.quarantined)} awaiting inspection</span>}
                {item.expired_on_hand > 0 && <span className="reg-sub">{qty(item.expired_on_hand)} expired on the shelf</span>}</> : <span className="muted">—</span>}</td>
              <td><input type="number" min={0} step="any" value={l.quantity} onChange={e => setLine(i, { quantity: e.target.value })}
                className={short ? 'input-error' : ''} /></td>
              <td>{item && want > 0
                ? (short ? <span className="badge" style={{ background: '#fde2e2', color: '#b42318' }}>only {qty(item.issuable)} available</span>
                  : <span className="muted">{item.earliest_expiry ? `earliest expiry ${dateOnly(item.earliest_expiry)}` : 'earliest-expiry lot'}</span>)
                : <span className="muted">—</span>}</td>
              <td>{lines.length > 1 && <button type="button" className="tiny danger" aria-label="Remove line"
                onClick={() => setLines(ls => ls.filter((_, n) => n !== i))}><Trash2 size={13} /></button>}</td>
            </tr>;
          })}
        </tbody></table></div>

        <div className="reg-head-actions" style={{ marginTop: 12 }}>
          <button type="button" className="secondary" onClick={() => setLines(ls => [...ls, { itemId: '', quantity: '' }])}><Plus size={14} /> Add another item</button>
          <button type="submit" disabled={busy || shortLines > 0} style={{ marginLeft: 'auto' }}>{busy ? 'Issuing…' : 'Issue it'}</button>
        </div>
      </form>
    </div>

    {voucher && <IssueVoucher voucher={voucher} onClose={() => setVoucher(null)} />}
  </>;
}

/** What was just issued, ready to hand over or print. */
function IssueVoucher({ voucher, onClose }: { voucher: any; onClose: () => void }) {
  return <DetailModal open onClose={onClose} width="narrow" title={`Issued — ${voucher.issueNumber}`}
    header={<button type="button" className="secondary" onClick={() => window.print()}><Printer size={14} /> Print</button>}
    footer={<button type="button" onClick={onClose}>Done</button>}>
    <p className="notice-ok">Stock has left the store and the balances are updated.</p>
    <table className="data-table"><thead><tr><th>Item</th><th>Quantity</th><th>Lots issued from</th></tr></thead><tbody>
      {voucher.lines.map((l: any) => <tr key={l.itemId}>
        <td><span className="reg-primary">{l.name}</span></td>
        <td>{l.quantity} {l.unit || ''}</td>
        <td>{l.allocation.map((a: any) => <span key={a.batchId} className="reg-sub">
          {a.quantity} from {a.batchNumber || `batch #${a.batchId}`}{a.expiry ? ` (exp ${dateOnly(a.expiry)})` : ''}
        </span>)}</td>
      </tr>)}
    </tbody></table>
  </DetailModal>;
}

/** Every voucher the store has written. */
export function IssueRegister({ refreshKey }: { refreshKey: number }) {
  const [rows, setRows] = useState<any[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const [query, setQuery] = useState('');

  useEffect(() => { api<any[]>('/supplier-inventory/issues').then(setRows).catch(() => setRows([])); }, [refreshKey]);
  const shown = rows.filter(r => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return [r.issue_number, r.section_name, r.issued_to_name, r.received_by_name, r.purpose_label, r.purpose, r.issued_by_name]
      .some(v => String(v ?? '').toLowerCase().includes(q));
  });

  return <div className="card">
    <div className="section-head" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
      <h3 style={{ margin: 0 }}>Issue register</h3>
      <label className="reg-search" style={{ marginLeft: 'auto' }}><Search size={15} />
        <input placeholder="Search voucher, unit, person…" value={query} onChange={e => setQuery(e.target.value)} /></label>
    </div>
    {shown.length === 0 ? <p className="muted">Nothing has been issued yet.</p> :
      <div className="table-scroll"><table className="data-table reg-table"><thead><tr>
        <th>Voucher</th><th>Date</th><th>Unit</th><th>Collected by</th><th>Reason</th><th>Lines</th><th>Quantity</th><th>Issued by</th><th>Status</th>
      </tr></thead><tbody>
        {shown.map(r => <tr key={r.id} className="row-clickable" onClick={() => setOpen(r.id)} tabIndex={0} role="button"
          onKeyDown={e => { if (e.key === 'Enter') setOpen(r.id); }}>
          <td><span className="reg-primary">{r.issue_number}</span></td>
          <td className="nowrap">{dateOnly(r.issue_date)}</td>
          <td>{r.section_name || <span className="muted">—</span>}</td>
          <td>{r.received_by_name || r.issued_to_name || <span className="muted">—</span>}</td>
          <td>{r.purpose_label || r.purpose || <span className="muted">—</span>}</td>
          <td>{r.line_count}</td>
          <td>{r.total_quantity}</td>
          <td>{r.issued_by_name || <span className="muted">—</span>}</td>
          <td>{r.status === 'returned' ? <span className="badge">part returned</span> : <span className="badge" style={{ background: '#e4f7ec', color: '#155c34' }}>issued</span>}</td>
        </tr>)}
      </tbody></table></div>}
    {open != null && <IssueDetail id={open} onClose={() => setOpen(null)} />}
  </div>;
}

function IssueDetail({ id, onClose }: { id: number; onClose: () => void }) {
  const [data, setData] = useState<any>(null);
  const [returning, setReturning] = useState<Record<number, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => api(`/supplier-inventory/issues/${id}`).then(setData).catch(e => setError((e as Error).message));
  useEffect(() => { void load(); }, [id]);

  async function sendReturn() {
    const lines = Object.entries(returning)
      .map(([lineId, q]) => ({ lineId: Number(lineId), quantity: Number(q) }))
      .filter(l => l.quantity > 0);
    if (lines.length === 0) { setError('Say how much is coming back.'); return; }
    setBusy(true); setError(null);
    try {
      await api(`/supplier-inventory/issues/${id}/return`, { method: 'POST', body: JSON.stringify({ lines, reason: 'Returned unused' }) });
      setReturning({}); await load();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  return <DetailModal open onClose={onClose} title={data ? data.issue_number : 'Issue voucher'}
    subtitle={data ? `${dateOnly(data.issue_date)} · ${data.section_name || data.issued_to_name || ''}` : ''}>
    {error && <div className="error">{error}</div>}
    {!data ? <p>Loading…</p> : <>
      <dl className="fact-grid">
        <div><dt>Issued to unit</dt><dd>{data.section_name || '—'}</dd></div>
        <div><dt>Collected by</dt><dd>{data.received_by_name || data.issued_to_name || '—'}</dd></div>
        <div><dt>Reason for issue</dt><dd>{data.purpose_label || data.purpose || '—'}</dd></div>
        <div><dt>Issued by</dt><dd>{data.issued_by_name || '—'}</dd></div>
        {data.note && <div><dt>Remarks</dt><dd>{data.note}</dd></div>}
      </dl>
      <h4>Lines issued</h4>
      <div className="table-scroll"><table className="data-table"><thead><tr>
        <th>Item</th><th>Quantity</th><th>Lots issued from</th><th>Returning</th>
      </tr></thead><tbody>
        {data.lines.map((l: any) => <tr key={l.id}>
          <td><span className="reg-primary">{l.item_name}</span><span className="reg-sub">{l.item_code}</span></td>
          <td>{l.quantity} {l.unit || ''}</td>
          <td>{(l.allocation ?? []).map((a: any) => <span key={a.batchId} className="reg-sub">
            {a.quantity} from {a.batchNumber || `#${a.batchId}`}</span>)}</td>
          <td><input type="number" min={0} max={l.quantity} step="any" style={{ width: 90 }}
            value={returning[l.id] ?? ''} onChange={e => setReturning(r => ({ ...r, [l.id]: e.target.value }))} /></td>
        </tr>)}
      </tbody></table></div>
      <div className="reg-head-actions" style={{ marginTop: 12 }}>
        <button type="button" className="secondary" disabled={busy} onClick={sendReturn}>
          {busy ? 'Returning…' : 'Put the returned stock back'}
        </button>
        <span className="muted">It goes back into the lot it came out of, so that lot's expiry still applies.</span>
      </div>
    </>}
  </DetailModal>;
}

// ─────────────────────────────────────────────────────────────── stock take

/**
 * Counting the shelf.
 *
 * The register and the shelf drift apart — breakages, an issue nobody wrote
 * down, a miscount on receipt. A count freezes what the register believes,
 * records what was found, and posts the difference as an adjustment with a
 * reason, so the correction is part of the record rather than a balance that
 * changed overnight.
 */
export function StockTake({ places, staff, onPosted }: {
  places: Array<{ id: number; path: string }>; staff: Staff[]; onPosted: () => void;
}) {
  const [counts, setCounts] = useState<any[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ scope: 'full', storageLocationId: '', countedByStaffId: '', note: '' });

  const load = () => api<any[]>('/supplier-inventory/counts').then(setCounts).catch(() => setCounts([]));
  useEffect(() => { void load(); }, []);

  async function start(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      const r = await api<{ id: number }>('/supplier-inventory/counts', { method: 'POST', body: JSON.stringify(form) });
      await load(); setOpen(r.id);
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }

  return <>
    <div className="card">
      <h3>Start a stock count</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        A sheet is drawn up per lot on the shelf, pre-filled with what the register believes. Count, enter what
        you found, and post it — every difference becomes an adjustment with your reason on it.
      </p>
      {error && <div className="error">{error}</div>}
      <form className="form" onSubmit={start}>
        <label>What to count<select value={form.scope} onChange={e => setForm({ ...form, scope: e.target.value })}>
          <option value="full">Everything in the store</option>
          <option value="location">One store, shelf or fridge</option>
          <option value="cycle">Cycle count — the high-value items only</option>
        </select></label>
        {form.scope === 'location' && <label>Which place<select value={form.storageLocationId} onChange={e => setForm({ ...form, storageLocationId: e.target.value })}>
          <option value="">Select a place</option>
          {places.map(p => <option key={p.id} value={p.id}>{p.path}</option>)}
        </select></label>}
        <label>Counted by<select value={form.countedByStaffId} onChange={e => setForm({ ...form, countedByStaffId: e.target.value })}>
          <option value="">Me</option>
          {staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}
        </select></label>
        <label>Note<input value={form.note} onChange={e => setForm({ ...form, note: e.target.value })} placeholder="Month-end count, handover…" /></label>
        <button type="submit" disabled={busy}><ClipboardList size={15} /> {busy ? 'Drawing up the sheet…' : 'Start the count'}</button>
      </form>
    </div>

    <div className="card">
      <h3>Stock counts</h3>
      {counts.length === 0 ? <p className="muted">Nothing has been counted yet.</p> :
        <div className="table-scroll"><table className="data-table reg-table"><thead><tr>
          <th>Count</th><th>Date</th><th>Scope</th><th>Counted by</th><th>Progress</th><th>Differences</th><th>Status</th>
        </tr></thead><tbody>
          {counts.map(c => <tr key={c.id} className="row-clickable" onClick={() => setOpen(c.id)} tabIndex={0} role="button"
            onKeyDown={e => { if (e.key === 'Enter') setOpen(c.id); }}>
            <td><span className="reg-primary">{c.count_number}</span><span className="reg-sub">{c.note || ''}</span></td>
            <td className="nowrap">{dateOnly(c.count_date)}</td>
            <td>{c.scope === 'location' ? (c.storage_path || 'one place') : c.scope === 'cycle' ? 'high-value items' : 'everything'}</td>
            <td>{c.counted_by_name || <span className="muted">—</span>}</td>
            <td>{c.counted_lines} of {c.line_count}</td>
            <td>{c.variance_lines > 0 ? <span className="badge warn">{c.variance_lines}</span> : <span className="muted">none</span>}</td>
            <td>{c.status === 'posted'
              ? <span className="badge" style={{ background: '#e4f7ec', color: '#155c34' }}>posted</span>
              : <span className="badge warn">open</span>}</td>
          </tr>)}
        </tbody></table></div>}
    </div>

    {open != null && <CountSheet id={open} onClose={() => setOpen(null)} onPosted={() => { void load(); onPosted(); }} />}
  </>;
}

function CountSheet({ id, onClose, onPosted }: { id: number; onClose: () => void; onPosted: () => void }) {
  const [data, setData] = useState<any>(null);
  const [edits, setEdits] = useState<Record<number, { counted: string; reason: string }>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState('');
  const load = () => api(`/supplier-inventory/counts/${id}`).then(d => { setData(d); setEdits({}); }).catch(e => setError((e as Error).message));
  useEffect(() => { void load(); }, [id]);

  const value = (l: any) => edits[l.id]?.counted ?? (l.counted_quantity == null ? '' : String(l.counted_quantity));
  const varianceOf = (l: any) => {
    const v = value(l);
    return v === '' ? null : Number(v) - Number(l.system_quantity);
  };

  async function save(then?: () => Promise<void>) {
    setBusy('save'); setError(null);
    try {
      const lines = Object.entries(edits).map(([lineId, e]) => ({ id: Number(lineId), countedQuantity: e.counted === '' ? null : Number(e.counted), reason: e.reason }));
      if (lines.length) await api(`/supplier-inventory/counts/${id}/lines`, { method: 'PUT', body: JSON.stringify({ lines }) });
      if (then) await then();
      await load();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(''); }
  }

  async function post() {
    await save(async () => {
      const r = await api<{ adjustments: number }>(`/supplier-inventory/counts/${id}/post`, { method: 'POST', body: JSON.stringify({}) });
      onPosted();
      setError(null);
      alert(`Count posted — ${r.adjustments} adjustment${r.adjustments === 1 ? '' : 's'} written to the ledger.`);
    });
  }

  const posted = data?.status === 'posted';
  return <DetailModal open onClose={onClose} title={data ? `${data.count_number} — count sheet` : 'Count sheet'}
    subtitle={data ? `${dateOnly(data.count_date)}${data.counted_by_name ? ` · counted by ${data.counted_by_name}` : ''}` : ''}
    header={data && (posted ? <span className="badge" style={{ background: '#e4f7ec', color: '#155c34' }}>posted</span> : <span className="badge warn">open</span>)}
    footer={data && !posted && <>
      <button type="button" className="secondary" disabled={!!busy} onClick={() => void save()}>{busy === 'save' ? 'Saving…' : 'Save what I have counted'}</button>
      <button type="button" disabled={!!busy} onClick={() => void post()}><PackageCheck size={15} /> Post the count</button>
    </>}>
    {error && <div className="error">{error}</div>}
    {!data ? <p>Loading…</p> : <>
      <p className="muted">
        {posted ? 'This count has been posted; the differences are on the bin cards.'
          : 'Enter what you actually found. Leave a line blank if it was not counted — only counted lines are posted.'}
      </p>
      <div className="table-scroll"><table className="data-table"><thead><tr>
        <th>Item</th><th>Batch / lot</th><th>Expires</th><th>Book balance</th><th>Counted</th><th>Variance</th><th>Reason</th>
      </tr></thead><tbody>
        {data.lines.map((l: any) => {
          const v = varianceOf(l);
          return <tr key={l.id}>
            <td><span className="reg-primary">{l.item_name}</span><span className="reg-sub">{l.item_code}</span></td>
            <td>{l.batch_number || <span className="muted">—</span>}</td>
            <td className="nowrap">{dateOnly(l.expiry_date)}</td>
            <td>{l.system_quantity} {l.unit || ''}</td>
            <td><input type="number" step="any" style={{ width: 100 }} disabled={posted} value={value(l)}
              onChange={e => setEdits(x => ({ ...x, [l.id]: { counted: e.target.value, reason: x[l.id]?.reason ?? l.reason ?? '' } }))} /></td>
            <td>{v == null ? <span className="muted">—</span>
              : v === 0 ? <span className="badge" style={{ background: '#e4f7ec', color: '#155c34' }}>agrees</span>
              : <span className="badge" style={{ background: '#fde2e2', color: '#b42318' }}>{v > 0 ? '+' : ''}{v}</span>}</td>
            <td><input disabled={posted} placeholder={v ? 'Why?' : ''} style={{ minWidth: 150 }}
              value={edits[l.id]?.reason ?? l.reason ?? ''}
              onChange={e => setEdits(x => ({ ...x, [l.id]: { counted: x[l.id]?.counted ?? value(l), reason: e.target.value } }))} /></td>
          </tr>;
        })}
      </tbody></table></div>
    </>}
  </DetailModal>;
}
