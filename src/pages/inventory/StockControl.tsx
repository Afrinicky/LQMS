import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Trash2, ClipboardList, PackageCheck, Printer, Lock, LockOpen, Undo2, FileText, X } from 'lucide-react';
import { api, API_BASE, getToken, ApiError } from '../../services/api';
import { DetailModal, KpiStrip, ChartCard, DonutChart, BarChart, BarMeter, Sparkline, RowMenu, RegisterSearch, CHART_COLORS } from '../../components/ui';
import BarcodeScanner from '../../components/BarcodeScanner';
import type { Section, Staff, Department } from '../../../shared/types/api';
import { STOCK_STATUS_LABELS, NEEDS_ACTION, type StockStatus } from '../../../shared/constants/stockControl';
import { MOVEMENT_LABELS } from '../../../shared/constants/inventory';
import type { ConfigOption } from '../../../shared/constants/configLists';
import { useCappedRows } from '../../hooks/useCappedRows';
import { usePermissions } from '../../hooks/usePermissions';
import { encodeDestination, decodeDestination } from '../../../shared/constants/inventory';

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
  const { can } = usePermissions();
  const [rows, setRows] = useState<LedgerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Only the settled query lives here; the box holds what is being typed.
  const [deferred, setDeferred] = useState('');
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
    const q = deferred.trim().toLowerCase();
    return rows.filter(r => {
      if (filter === 'attention' && !NEEDS_ACTION.includes(r.status)) return false;
      if (filter === 'expiring' && !['expired', 'expiring_soon'].includes(r.expiry_status ?? '')) return false;
      if (filter === 'quarantine' && r.quarantined <= 0) return false;
      if (filter === 'idle' && !(r.on_hand > 0 && r.amc === 0)) return false;
      if (!q) return true;
      return [r.name, r.item_code, r.category, r.storage_path, r.supplier_name].some(v => String(v ?? '').toLowerCase().includes(q));
    }).sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));
  }, [rows, deferred, filter]);
  const page = useCappedRows(shown);

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
          <RegisterSearch onQuery={setDeferred} placeholder="Search item, code, category, shelf…" />
          {can('supplier_inventory.stock', 'export') && <button type="button" className="secondary" onClick={() => void download('/supplier-inventory/ledger/export', 'Stock_Control_Ledger.xlsx').catch(e => setError((e as Error).message))}>Export</button>}
        </div>
      </div>

      <div className="reg-seg" role="tablist" aria-label="Filter the ledger" style={{ margin: '4px 0 12px' }}>
        {([['all', 'Everything'], ['attention', 'Needs ordering'], ['expiring', 'Expiring'], ['quarantine', 'In quarantine'], ['idle', 'Not moving']] as const).map(([k, label]) =>
          <button key={k} type="button" role="tab" aria-selected={filter === k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>{label}</button>)}
      </div>

      {error && <div className="error">{error}</div>}
      {loading ? <p>Loading…</p> : shown.length === 0 ? <p className="muted">Nothing here.</p> :
        <div>
        <div className="table-scroll"><table className="data-table reg-table ledger-table"><thead><tr>
          <th>Item</th><th>Available</th><th>Used / month</th><th>Cover</th>
          <th>Min / reorder / max</th><th>Expires first</th><th>Status</th>
        </tr></thead><tbody>
          {page.shown.map(r => <tr key={r.id} className="row-clickable" onClick={() => setCard(r.id)} tabIndex={0} role="button"
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
        </tbody></table></div>
        {page.hidden > 0 && <p className="muted list-capped">
          Showing the first {page.shown.length.toLocaleString()} of {page.total.toLocaleString()} items. Search or
          filter to narrow it down.
        </p>}
        </div>}
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
export function IssueDesk({ items, sections, staff, departments, reasons, destinations, onIssued }: {
  items: LedgerRow[]; sections: Section[]; staff: Staff[]; departments: Department[];
  reasons: ConfigOption[]; destinations: ConfigOption[]; onIssued: () => void;
}) {
  // Where it is going, encoded as "unit:3", "department:7", "facility:code"
  // or the bare word "other". A laboratory issues beyond its own benches all
  // the time — to a ward, to a health centre, to an outreach team — and a
  // picker that only lists units forces all of that into the wrong box.
  const [destination, setDestination] = useState('');
  const [destinationName, setDestinationName] = useState('');
  const [receivedByStaffId, setReceivedByStaffId] = useState('');
  // "Other" for the collector too: somebody from outside the laboratory has no
  // staff record, and issuing to nobody at all is not a record of anything.
  const [collectorOther, setCollectorOther] = useState(false);
  const [collectedByName, setCollectedByName] = useState('');
  const [purpose, setPurpose] = useState('');
  const [note, setNote] = useState('');
  const chosen = decodeDestination(destination);
  const needsDestinationName = destination === 'other';
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
    if (!destination) { setError('Say where this is going.'); return; }
    if (needsDestinationName && !destinationName.trim()) { setError('You chose “Other” — say who or where it is going to.'); return; }
    if (!receivedByStaffId && !collectedByName.trim()) { setError('Say who is collecting it.'); return; }
    // Nothing is sent while a line asks for more than can go out: the whole
    // voucher would be refused, and the storekeeper would be told at the
    // counter rather than on the screen in front of them.
    if (shortLines > 0) { setError('One or more lines ask for more than can be issued. Reduce them, or take the item off the voucher.'); return; }
    setBusy(true);
    try {
      const r = await api<any>('/supplier-inventory/issues', {
        method: 'POST',
        body: JSON.stringify({
          destination,
          destinationName: needsDestinationName ? destinationName.trim() : '',
          sectionId: chosen.type === 'unit' ? chosen.id : null,
          receivedByStaffId: collectorOther ? null : (receivedByStaffId || null),
          issuedToName: collectorOther ? collectedByName.trim() : '',
          purpose, note, lines: payload,
        }),
      });
      setVoucher(r);
      setLines([{ itemId: '', quantity: '' }]); setPurpose(''); setNote('');
      onIssued();
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }

  return <>
    <div className="card">
      <h3>Issue stock</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        Name where it is going, who is collecting it and why. It need not be one of the laboratory's own benches —
        a hospital department, another facility or anything else can be named. The store allocates the lots —
        earliest expiry first — and writes a numbered issue voucher.
      </p>
      {error && <div className="error">{error}</div>}

      <form onSubmit={submit}>
        <div className="issue-head">
          {/* Not everything goes to a bench. The groups are what a storekeeper
              would say out loud: one of our units, a department of the
              hospital, another facility, or something else entirely. */}
          <label>Issued to<select value={destination} onChange={e => { setDestination(e.target.value); setDestinationName(''); }}>
            <option value="">Select where it is going</option>
            {sections.length > 0 && <optgroup label="Laboratory units">
              {sections.map(sec => <option key={sec.id} value={encodeDestination('unit', sec.id)}>{sec.name}</option>)}
            </optgroup>}
            {departments.length > 0 && <optgroup label="Hospital departments">
              {departments.map(d => <option key={d.id} value={encodeDestination('department', d.id)}>{d.name}</option>)}
            </optgroup>}
            {destinations.length > 0 && <optgroup label="Other facilities">
              {destinations.map(d => <option key={d.id} value={encodeDestination('facility', d.value)}>{d.label}</option>)}
            </optgroup>}
            <optgroup label="Anything else">
              <option value="other">Other — say who</option>
            </optgroup>
          </select></label>
          {needsDestinationName && <label>Who or where <span className="muted">(required)</span>
            <input value={destinationName} onChange={e => setDestinationName(e.target.value)}
              placeholder="Name the unit, facility or programme" autoFocus /></label>}

          <label>Collected by
            {collectorOther
              ? <input value={collectedByName} onChange={e => setCollectedByName(e.target.value)}
                  placeholder="Name the person collecting" autoFocus />
              : <select value={receivedByStaffId} onChange={e => {
                  if (e.target.value === '__other') { setCollectorOther(true); setReceivedByStaffId(''); setCollectedByName(''); return; }
                  setReceivedByStaffId(e.target.value);
                }}>
                  <option value="">Select the member of staff</option>
                  {staff.map(st => <option key={st.id} value={st.id}>{st.fullName}</option>)}
                  <option value="__other">Other — someone not on the staff register</option>
                </select>}
            {collectorOther && <button type="button" className="linklike" style={{ alignSelf: 'start' }}
              onClick={() => { setCollectorOther(false); setCollectedByName(''); }}>Pick from the staff register instead</button>}
          </label>

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
export function IssueRegister({ refreshKey, canVoid, onChanged }: {
  refreshKey: number; canVoid?: boolean; onChanged?: () => void;
}) {
  const [rows, setRows] = useState<any[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const [cancelling, setCancelling] = useState<any>(null);
  const [deferred, setDeferred] = useState('');

  const load = () => api<any[]>('/supplier-inventory/issues').then(setRows).catch(() => setRows([]));
  useEffect(() => { void load(); }, [refreshKey]);
  const shown = useMemo(() => {
    const q = deferred.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(r => [r.issue_number, r.section_name, r.destination_label, r.destination_name, r.issued_to_name, r.received_by_name, r.purpose_label, r.purpose, r.issued_by_name]
      .some(v => String(v ?? '').toLowerCase().includes(q)));
  }, [rows, deferred]);
  const page = useCappedRows(shown);

  return <div className="card">
    <div className="section-head" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
      <h3 style={{ margin: 0 }}>Issue register</h3>
      <RegisterSearch style={{ marginLeft: 'auto' }} onQuery={setDeferred} placeholder="Search voucher, unit, person…" />
    </div>
    {shown.length === 0 ? <p className="muted">Nothing has been issued yet.</p> :
      <div>
      <div className="table-scroll"><table className="data-table reg-table"><thead><tr>
        <th>Voucher</th><th>Date</th><th>Issued to</th><th>Collected by</th><th>Reason</th><th>Lines</th><th>Quantity</th><th>Issued by</th><th>Status</th><th className="reg-actions-col"></th>
      </tr></thead><tbody>
        {page.shown.map(r => <tr key={r.id} className={`row-clickable${r.status === 'cancelled' ? ' row-retired' : ''}`} onClick={() => setOpen(r.id)} tabIndex={0} role="button"
          onKeyDown={e => { if (e.key === 'Enter') setOpen(r.id); }}>
          <td><span className="reg-primary">{r.issue_number}</span></td>
          <td className="nowrap">{dateOnly(r.issue_date)}</td>
          <td>{r.destination_label || r.section_name || <span className="muted">—</span>}</td>
          <td>{r.received_by_name || r.issued_to_name || <span className="muted">—</span>}</td>
          <td>{r.purpose_label || r.purpose || <span className="muted">—</span>}</td>
          <td>{r.line_count}</td>
          <td>{r.total_quantity}</td>
          <td>{r.issued_by_name || <span className="muted">—</span>}</td>
          <td>{r.status === 'cancelled' ? <span className="badge" style={{ background: '#fde2e2', color: '#b42318' }}>cancelled</span>
            : r.status === 'returned' ? <span className="badge">part returned</span>
            : <span className="badge" style={{ background: '#e4f7ec', color: '#155c34' }}>issued</span>}</td>
          <td className="reg-actions-col" onClick={e => e.stopPropagation()}>
            <RowMenu label={`Manage ${r.issue_number}`}>{close => <>
              <button type="button" role="menuitem" onClick={() => { close(); setOpen(r.id); }}><FileText size={14} /> Open the voucher</button>
              {/* Cancelling puts every line back on the lot it came from. It
                  is not offered to everyone, and it costs a written reason. */}
              {canVoid && r.status !== 'cancelled' && <button type="button" role="menuitem" className="danger"
                onClick={() => { close(); setCancelling(r); }}><Undo2 size={14} /> Cancel this voucher…</button>}
            </>}</RowMenu>
          </td>
        </tr>)}
      </tbody></table></div>
      {page.hidden > 0 && <p className="muted list-capped">
        Showing the most recent {page.shown.length.toLocaleString()} of {page.total.toLocaleString()} vouchers.
      </p>}
      </div>}
    {open != null && <IssueDetail id={open} onClose={() => setOpen(null)} onChanged={() => { void load(); onChanged?.(); }} canVoid={canVoid} />}
    {cancelling && <CancelVoucherPrompt voucher={cancelling} onClose={() => setCancelling(null)}
      onDone={() => { setCancelling(null); void load(); onChanged?.(); }} />}
  </div>;
}

/**
 * Cancelling a voucher that should never have been written.
 *
 * Every line goes back to the exact lot it came out of, so that lot's expiry
 * still governs it, and the voucher stays on the register marked cancelled.
 * Nothing is deleted: a voucher that vanishes is indistinguishable from one
 * that was never written, and the numbering would then be lying.
 */
function CancelVoucherPrompt({ voucher, onClose, onDone }: { voucher: any; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function go() {
    if (!reason.trim()) { setError('A reason is required — it goes onto the voucher.'); return; }
    setBusy(true); setError(null);
    try {
      await api(`/supplier-inventory/issues/${voucher.id}/cancel`, { method: 'POST', body: JSON.stringify({ reason: reason.trim() }) });
      onDone();
    } catch (e) { setError((e as Error).message); setBusy(false); }
  }

  return <DetailModal open onClose={onClose} width="narrow" title={`Cancel ${voucher.issue_number}`}
    footer={<>
      <button type="button" className="secondary" onClick={onClose}>Keep the voucher</button>
      <button type="button" className="danger" disabled={busy} onClick={() => void go()}>{busy ? 'Cancelling…' : 'Cancel the voucher'}</button>
    </>}>
    {error && <div className="error">{error}</div>}
    <p className="muted" style={{ marginTop: 0 }}>
      All {voucher.total_quantity} on this voucher goes back to the lots it came out of, and the voucher stays on
      the register marked cancelled. Use this for a voucher issued in error — if the stock was taken and some of
      it came back, record a return on the voucher instead.
    </p>
    <label>Reason<textarea value={reason} onChange={e => setReason(e.target.value)} rows={3}
      placeholder="Issued to the wrong unit, duplicate of ISS-…, wrong item picked" autoFocus /></label>
  </DetailModal>;
}

function IssueDetail({ id, onClose, onChanged, canVoid }: {
  id: number; onClose: () => void; onChanged?: () => void; canVoid?: boolean;
}) {
  const [data, setData] = useState<any>(null);
  const [returning, setReturning] = useState<Record<number, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
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
      setReturning({}); await load(); onChanged?.();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  return <DetailModal open onClose={onClose} title={data ? data.issue_number : 'Issue voucher'}
    subtitle={data ? `${dateOnly(data.issue_date)} · ${data.destination_label || data.section_name || data.issued_to_name || ''}` : ''}
    header={data && <>
      {data.status === 'cancelled' && <span className="badge" style={{ background: '#fde2e2', color: '#b42318' }}>cancelled</span>}
      <button type="button" className="secondary" onClick={() => window.print()}><Printer size={14} /> Print</button>
      {canVoid && data.status !== 'cancelled' && <RowMenu label={`Manage ${data.issue_number}`}>{close => <>
        <button type="button" role="menuitem" className="danger" onClick={() => { close(); setCancelling(true); }}>
          <Undo2 size={14} /> Cancel this voucher…
        </button>
      </>}</RowMenu>}
    </>}>
    {error && <div className="error">{error}</div>}
    {!data ? <p>Loading…</p> : <>
      {data.status === 'cancelled' && <div className="notice-warn" style={{ marginTop: 0 }}>
        This voucher was cancelled{data.cancelled_by_name ? ` by ${data.cancelled_by_name}` : ''} — every line went back
        to the lot it came from.{data.cancellation_reason ? ` Reason: ${data.cancellation_reason}` : ''}
      </div>}
      <dl className="fact-grid">
        <div><dt>Issued to</dt><dd>{data.destination_label || data.section_name || '—'}</dd></div>
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
      {cancelling && <CancelVoucherPrompt voucher={data} onClose={() => setCancelling(false)}
        onDone={() => { setCancelling(false); void load(); onChanged?.(); }} />}
      {data.status !== 'cancelled' && <div className="reg-head-actions" style={{ marginTop: 12 }}>
        <button type="button" className="secondary" disabled={busy} onClick={sendReturn}>
          {busy ? 'Returning…' : 'Put the returned stock back'}
        </button>
        <span className="muted">It goes back into the lot it came out of, so that lot's expiry still applies.</span>
      </div>}
    </>}
  </DetailModal>;
}

// ─────────────────────────────────────────────────────────────── stock take

/**
 * Counting the shelf, and putting right what the count finds.
 *
 * The register and the shelf drift apart — breakages, an issue nobody wrote
 * down, a miscount on receipt, a box moved to a unit's own cupboard. A count
 * freezes what the register believes, records what was actually found, and
 * posts every difference as an adjustment carrying a reason, so the correction
 * is part of the record rather than a balance that changed overnight.
 *
 * Three things make this a real count rather than a form:
 *
 *   · it can include the items the register says are EMPTY, because stock the
 *     register has lost is exactly what a count is for and a sheet of only
 *     non-zero rows can never find it;
 *   · it can be counted BLIND, with the book balance hidden, because a number
 *     already printed on the page is very hard not to simply agree with;
 *   · anything found that is not on the sheet can be ADDED at the shelf.
 */
export function StockTake({ places, staff, items, categories, canVoid, onPosted }: {
  places: Array<{ id: number; path: string }>;
  staff: Staff[];
  items: LedgerRow[];
  categories: ConfigOption[];
  canVoid?: boolean;
  onPosted: () => void;
}) {
  const { can } = usePermissions();
  const [counts, setCounts] = useState<any[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const [cancelling, setCancelling] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showClosed, setShowClosed] = useState(false);
  const [form, setForm] = useState({
    scope: 'full', storageLocationId: '', scopeValue: '', countedByStaffId: '', note: '',
    includeEmpty: true, blind: false,
  });
  const [pickedItems, setPickedItems] = useState<number[]>([]);
  const [itemQuery, setItemQuery] = useState('');

  const load = () => api<any[]>('/supplier-inventory/counts').then(setCounts).catch(() => setCounts([]));
  useEffect(() => { void load(); }, []);

  const openCounts = counts.filter(c => c.status === 'open');
  const shownCounts = showClosed ? counts : counts.filter(c => c.status !== 'cancelled');
  const pickable = useMemo(() => {
    const q = itemQuery.trim().toLowerCase();
    const rows = q ? items.filter(i => [i.name, i.item_code, i.category, i.storage_path].some(v => String(v ?? '').toLowerCase().includes(q))) : items;
    return rows.slice(0, 60);
  }, [items, itemQuery]);

  async function start(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError(null); setNotice(null);
    try {
      const r = await api<{ id: number; lines: number }>('/supplier-inventory/counts', {
        method: 'POST',
        body: JSON.stringify({ ...form, itemIds: form.scope === 'items' ? pickedItems : undefined }),
      });
      await load();
      if (r.lines === 0) {
        setNotice('That sheet came out empty — nothing matched what you asked to count. Widen the scope, or tick “include items the register says are empty”.');
      }
      setOpen(r.id);
      setPickedItems([]);
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }

  const scopeWords = (c: any) => c.scope === 'location' ? (c.storage_path || 'one place')
    : c.scope === 'cycle' ? 'high-value items'
    : c.scope === 'category' ? `category: ${c.scope_value || '—'}`
    : c.scope === 'items' ? 'selected items'
    : 'everything';

  return <>
    {/* An open count is the thing you came here to finish, so it is offered
        before the form that would start another one. */}
    {openCounts.length > 0 && <div className="card">
      <h3>Counts in progress</h3>
      <p className="muted" style={{ marginTop: 0 }}>Pick up where the count was left. A sheet stays open until it is posted or abandoned.</p>
      <div className="table-scroll"><table className="data-table reg-table"><thead><tr>
        <th>Count</th><th>Started</th><th>Scope</th><th>Counted by</th><th>Progress</th><th>Variances</th><th></th>
      </tr></thead><tbody>
        {openCounts.map(c => {
          const done = Number(c.counted_lines) || 0;
          const total = Number(c.line_count) || 0;
          const pct = total === 0 ? 0 : Math.round((done / total) * 100);
          return <tr key={c.id} className="row-clickable" onClick={() => setOpen(c.id)} tabIndex={0} role="button"
            onKeyDown={e => { if (e.key === 'Enter') setOpen(c.id); }}>
            <td><span className="reg-primary">{c.count_number}</span><span className="reg-sub">{c.note || ''}</span></td>
            <td className="nowrap">{dateOnly(c.count_date)}</td>
            <td>{scopeWords(c)}{c.blind ? <span className="badge">blind</span> : null}</td>
            <td>{c.counted_by_name || <span className="muted">—</span>}</td>
            <td>
              <span className="reg-primary">{done} of {total}</span>
              <span className="count-bar"><span style={{ width: `${pct}%` }} /></span>
            </td>
            <td>{c.variance_lines > 0 ? <span className="badge warn">{c.variance_lines}</span> : <span className="muted">none yet</span>}</td>
            <td><button type="button" className="tiny" onClick={e => { e.stopPropagation(); setOpen(c.id); }}>Continue</button></td>
          </tr>;
        })}
      </tbody></table></div>
    </div>}

    <div className="card">
      <h3>Start a stock count</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        A sheet is drawn up per lot on the shelf. Count it, enter what you found, and post it — every difference
        becomes an adjustment with your reason on it, and lands on the item's bin card.
      </p>
      {error && <div className="error">{error}</div>}
      {notice && <div className="notice-warn">{notice}</div>}
      <form className="form" onSubmit={start}>
        <label>What to count<select value={form.scope} onChange={e => setForm({ ...form, scope: e.target.value })}>
          <option value="full">Everything in the store</option>
          <option value="location">One store, shelf or fridge</option>
          <option value="category">One category of item</option>
          <option value="cycle">Cycle count — the high-value (class A) items</option>
          <option value="items">Just the items I pick</option>
        </select></label>

        {form.scope === 'location' && <label>Which place<select value={form.storageLocationId} onChange={e => setForm({ ...form, storageLocationId: e.target.value })} required>
          <option value="">Select a place</option>
          {places.map(p => <option key={p.id} value={p.id}>{p.path}</option>)}
        </select></label>}

        {form.scope === 'category' && <label>Which category<select value={form.scopeValue} onChange={e => setForm({ ...form, scopeValue: e.target.value })} required>
          <option value="">Select a category</option>
          {categories.map(c => <option key={c.id} value={c.value}>{c.label}</option>)}
        </select></label>}

        {form.scope === 'items' && <div className="count-picker">
          <RegisterSearch onQuery={setItemQuery} placeholder="Search the register…" />
          <p className="muted" style={{ margin: '6px 0' }}>
            {pickedItems.length === 0 ? 'Nothing picked yet.' : `${pickedItems.length} item${pickedItems.length === 1 ? '' : 's'} picked.`}
            {pickedItems.length > 0 && <> <button type="button" className="linklike" onClick={() => setPickedItems([])}>Clear</button></>}
          </p>
          <div className="count-picker-list">
            {pickable.map(i => <label key={i.id} className="count-pick">
              <input type="checkbox" checked={pickedItems.includes(i.id)}
                onChange={e => setPickedItems(ids => e.target.checked ? [...ids, i.id] : ids.filter(n => n !== i.id))} />
              <span>{i.name}<small>{[i.item_code, i.storage_path].filter(Boolean).join(' · ')}</small></span>
              <span className="muted">{qty(i.on_hand)} {i.unit || ''}</span>
            </label>)}
            {pickable.length === 0 && <p className="muted">Nothing matches that.</p>}
          </div>
        </div>}

        <label>Counted by<select value={form.countedByStaffId} onChange={e => setForm({ ...form, countedByStaffId: e.target.value })}>
          <option value="">Me</option>
          {staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}
        </select></label>
        <label>Note<input value={form.note} onChange={e => setForm({ ...form, note: e.target.value })} placeholder="Month-end count, handover…" /></label>

        <label className="toggle">
          <input type="checkbox" checked={form.includeEmpty} onChange={e => setForm({ ...form, includeEmpty: e.target.checked })} />
          Include items the register says are empty
        </label>
        <p className="hint" style={{ margin: '-6px 0 4px' }}>
          Leave this on. Stock the register has lost still sits on the shelf, and a sheet of only non-zero rows can
          never find it.
        </p>

        <label className="toggle">
          <input type="checkbox" checked={form.blind} onChange={e => setForm({ ...form, blind: e.target.checked })} />
          Count blind — hide what the register believes
        </label>
        <p className="hint" style={{ margin: '-6px 0 4px' }}>
          The honest way to count: the book balance is hidden until the sheet is posted, so the count is what was on
          the shelf rather than what the page suggested.
        </p>

        <button type="submit" disabled={busy || (form.scope === 'items' && pickedItems.length === 0)}>
          <ClipboardList size={15} /> {busy ? 'Drawing up the sheet…' : 'Start the count'}
        </button>
      </form>
    </div>

    <div className="card">
      <div className="section-head" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <h3 style={{ margin: 0 }}>Stock counts</h3>
        <label className="toggle" style={{ marginLeft: 'auto' }}>
          <input type="checkbox" checked={showClosed} onChange={e => setShowClosed(e.target.checked)} />
          Show abandoned counts
        </label>
      </div>
      {shownCounts.length === 0 ? <p className="muted">Nothing has been counted yet.</p> :
        <div className="table-scroll"><table className="data-table reg-table"><thead><tr>
          <th>Count</th><th>Date</th><th>Scope</th><th>Counted by</th><th>Progress</th><th>Variances</th><th>Value</th><th>Status</th><th className="reg-actions-col"></th>
        </tr></thead><tbody>
          {shownCounts.map(c => <tr key={c.id} className={`row-clickable${c.status === 'cancelled' ? ' row-retired' : ''}`}
            onClick={() => setOpen(c.id)} tabIndex={0} role="button"
            onKeyDown={e => { if (e.key === 'Enter') setOpen(c.id); }}>
            <td><span className="reg-primary">{c.count_number}</span><span className="reg-sub">{c.note || ''}</span></td>
            <td className="nowrap">{dateOnly(c.count_date)}</td>
            <td>{scopeWords(c)}{c.blind ? <span className="badge">blind</span> : null}</td>
            <td>{c.counted_by_name || <span className="muted">—</span>}</td>
            <td>{c.counted_lines} of {c.line_count}</td>
            <td>{c.variance_lines > 0 ? <span className="badge warn">{c.variance_lines}</span> : <span className="muted">none</span>}</td>
            <td className="nowrap">{c.variance_value ? Math.round(c.variance_value).toLocaleString() : <span className="muted">—</span>}</td>
            <td>{c.status === 'posted' ? <span className="badge" style={{ background: '#e4f7ec', color: '#155c34' }}>posted</span>
              : c.status === 'cancelled' ? <span className="badge" style={{ background: '#fde2e2', color: '#b42318' }}>abandoned</span>
              : <span className="badge warn">open</span>}</td>
            <td className="reg-actions-col" onClick={e => e.stopPropagation()}>
              <RowMenu label={`Manage ${c.count_number}`}>{close => <>
                <button type="button" role="menuitem" onClick={() => { close(); setOpen(c.id); }}><FileText size={14} /> Open the sheet</button>
                {can('supplier_inventory.stock', 'export') && <button type="button" role="menuitem" onClick={() => { close(); void download(`/supplier-inventory/counts/${c.id}/export`, `${c.count_number}.xlsx`).catch(e => setError((e as Error).message)); }}>
                  <Printer size={14} /> Export the variance sheet
                </button>}
                {canVoid && c.status === 'open' && <button type="button" role="menuitem" className="danger" onClick={() => { close(); setCancelling(c); }}>
                  <X size={14} /> Abandon this count…
                </button>}
              </>}</RowMenu>
            </td>
          </tr>)}
        </tbody></table></div>}
    </div>

    {open != null && <CountSheet id={open} items={items} canVoid={canVoid}
      onClose={() => setOpen(null)} onPosted={() => { void load(); onPosted(); }} />}
    {cancelling && <AbandonCountPrompt count={cancelling} onClose={() => setCancelling(null)}
      onDone={() => { setCancelling(null); void load(); }} />}
  </>;
}

/** Abandoning a count that will not be finished. */
function AbandonCountPrompt({ count, onClose, onDone }: { count: any; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function go() {
    if (!reason.trim()) { setError('Say why — an abandoned count with no explanation looks like a count that was hidden.'); return; }
    setBusy(true); setError(null);
    try {
      await api(`/supplier-inventory/counts/${count.id}/cancel`, { method: 'POST', body: JSON.stringify({ reason: reason.trim() }) });
      onDone();
    } catch (e) { setError((e as Error).message); setBusy(false); }
  }

  return <DetailModal open onClose={onClose} width="narrow" title={`Abandon ${count.count_number}`}
    footer={<>
      <button type="button" className="secondary" onClick={onClose}>Keep the count</button>
      <button type="button" className="danger" disabled={busy} onClick={() => void go()}>{busy ? 'Abandoning…' : 'Abandon the count'}</button>
    </>}>
    {error && <div className="error">{error}</div>}
    <p className="muted" style={{ marginTop: 0 }}>
      Nothing is posted and no balance moves. The sheet stays on the register marked abandoned, with what had been
      counted still on it.
    </p>
    <label>Reason<textarea value={reason} onChange={e => setReason(e.target.value)} rows={3}
      placeholder="Started in the wrong place, superseded by CNT-…, interrupted" autoFocus /></label>
  </DetailModal>;
}

/**
 * The sheet itself.
 *
 * Written for somebody standing at a shelf with a tablet: a search, a filter
 * down to what is still uncounted, a scanner that jumps to the row, and a
 * running tally of what the count has found so far. Posting is the last step
 * and says plainly what it is about to do.
 */
function CountSheet({ id, items, canVoid, onClose, onPosted }: {
  id: number; items: LedgerRow[]; canVoid?: boolean; onClose: () => void; onPosted: () => void;
}) {
  const [data, setData] = useState<any>(null);
  const { can } = usePermissions();
  const [edits, setEdits] = useState<Record<number, { counted: string; reason: string; note: string }>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'todo' | 'variance'>('all');
  const [revealed, setRevealed] = useState(false);
  const [adding, setAdding] = useState(false);
  const [addForm, setAddForm] = useState({ itemId: '', batchId: '', countedQuantity: '', reason: '', note: '' });

  const load = () => api(`/supplier-inventory/counts/${id}`).then(d => { setData(d); setEdits({}); }).catch(e => setError((e as Error).message));
  useEffect(() => { void load(); }, [id]);

  const posted = data?.status === 'posted';
  const abandoned = data?.status === 'cancelled';
  const locked = posted || abandoned;
  // A blind count hides the book balance until it is posted. It can be
  // revealed deliberately — a supervisor checking a wild variance — and the
  // sheet says so on the screen when it has been.
  const hideBook = Boolean(data?.blind) && !posted && !revealed;

  const value = (l: any) => edits[l.id]?.counted ?? (l.counted_quantity == null ? '' : String(l.counted_quantity));
  const varianceOf = (l: any) => {
    const v = value(l);
    return v === '' ? null : Number(v) - Number(l.system_quantity);
  };
  const patch = (l: any, part: Partial<{ counted: string; reason: string; note: string }>) =>
    setEdits(x => ({
      ...x,
      [l.id]: {
        counted: part.counted ?? x[l.id]?.counted ?? value(l),
        reason: part.reason ?? x[l.id]?.reason ?? l.reason ?? '',
        note: part.note ?? x[l.id]?.note ?? l.note ?? '',
      },
    }));

  const lines: any[] = data?.lines ?? [];
  const sheet = useMemo(() => {
    const q = query.trim().toLowerCase();
    return lines.filter(l => {
      if (filter === 'todo' && value(l) !== '') return false;
      if (filter === 'variance' && !(varianceOf(l) != null && Math.abs(varianceOf(l) as number) > 0.0001)) return false;
      if (!q) return true;
      return [l.item_name, l.item_code, l.batch_number, l.lot_number, l.storage_path].some(v => String(v ?? '').toLowerCase().includes(q));
    });
  }, [lines, query, filter, edits]);
  // A full count of a large store runs to thousands of lines, each carrying two
  // inputs. Drawing them all makes the sheet unusable on the tablet it is meant
  // to be worked on, so it draws a screenful at a time and the filters above
  // move through the rest.
  const shownPage = useCappedRows(sheet);
  const shown = shownPage.shown;

  // The tally is worked out from what is on screen right now, including edits
  // not yet saved — otherwise the figures lag a step behind the person typing.
  const live = useMemo(() => {
    let counted = 0, variances = 0, gain = 0, loss = 0, varianceValue = 0;
    for (const l of lines) {
      const v = value(l);
      if (v === '') continue;
      counted++;
      const diff = Number(v) - Number(l.system_quantity);
      if (Math.abs(diff) > 0.0001) {
        variances++;
        if (diff > 0) gain++; else loss++;
        varianceValue += diff * Number(l.unit_cost ?? 0);
      }
    }
    return {
      counted, variances, gain, loss,
      outstanding: lines.length - counted,
      varianceValue: Math.round(varianceValue * 100) / 100,
      accuracy: counted === 0 ? null : Math.round(((counted - variances) / counted) * 1000) / 10,
    };
  }, [lines, edits]);

  async function save(then?: () => Promise<void>) {
    setBusy('save'); setError(null);
    try {
      const payload = Object.entries(edits).map(([lineId, e]) => ({
        id: Number(lineId),
        countedQuantity: e.counted === '' ? null : Number(e.counted),
        reason: e.reason || null,
        note: e.note || null,
      }));
      if (payload.length) await api(`/supplier-inventory/counts/${id}/lines`, { method: 'PUT', body: JSON.stringify({ lines: payload }) });
      if (then) await then();
      await load();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(''); }
  }

  async function post(postPartial = false) {
    await save(async () => {
      try {
        const r = await api<{ adjustments: number; gains: number; losses: number; failures: Array<{ itemName: string; reason: string }> }>(
          `/supplier-inventory/counts/${id}/post`, { method: 'POST', body: JSON.stringify({ postPartial }) });
        onPosted();
        setError(null);
        setNotice(`Posted — ${r.adjustments} adjustment${r.adjustments === 1 ? '' : 's'} written to the bin cards (${r.gains} found, ${r.losses} missing).`
          + (r.failures.length ? ` ${r.failures.length} could not be posted: ${r.failures.map(f => `${f.itemName} — ${f.reason}`).join('; ')}` : ''));
      } catch (e) {
        // A partial post is a decision, not an error: the server asks first.
        if (e instanceof ApiError && e.status === 409 && (e.data as any)?.needsConfirmation) {
          if (window.confirm(`${e.message}\n\nPost the count anyway?`)) await post(true);
          return;
        }
        throw e;
      }
    });
  }

  async function addLine(e: FormEvent) {
    e.preventDefault(); setBusy('add'); setError(null);
    try {
      await api(`/supplier-inventory/counts/${id}/lines`, { method: 'POST', body: JSON.stringify(addForm) });
      setAdding(false); setAddForm({ itemId: '', batchId: '', countedQuantity: '', reason: '', note: '' });
      await load();
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(''); }
  }

  const chosenItem = items.find(i => String(i.id) === addForm.itemId);

  return <DetailModal open onClose={onClose} title={data ? `${data.count_number} — count sheet` : 'Count sheet'}
    subtitle={data ? `${dateOnly(data.count_date)}${data.counted_by_name ? ` · counted by ${data.counted_by_name}` : ''}${data.storage_path ? ` · ${data.storage_path}` : ''}` : ''}
    header={data && <>
      {posted ? <span className="badge" style={{ background: '#e4f7ec', color: '#155c34' }}>posted</span>
        : abandoned ? <span className="badge" style={{ background: '#fde2e2', color: '#b42318' }}>abandoned</span>
        : <span className="badge warn">open</span>}
      {Boolean(data.blind) && <span className="badge">blind count</span>}
      {can('supplier_inventory.stock', 'export') && <button type="button" className="secondary" onClick={() => void download(`/supplier-inventory/counts/${id}/export`, `${data.count_number}.xlsx`).catch(e => setError((e as Error).message))}>
        <Printer size={14} /> Export
      </button>}
    </>}
    footer={data && !locked && <>
      <button type="button" className="secondary" disabled={!!busy} onClick={() => setAdding(true)}>
        <Plus size={15} /> Found something not on the sheet
      </button>
      <button type="button" className="secondary" disabled={!!busy || Object.keys(edits).length === 0} onClick={() => void save()}>
        {busy === 'save' ? 'Saving…' : 'Save what I have counted'}
      </button>
      <button type="button" disabled={!!busy || live.counted === 0} onClick={() => void post()}>
        <PackageCheck size={15} /> Post the count
      </button>
    </>}>
    {error && <div className="error">{error}</div>}
    {notice && <div className="notice-ok">{notice}</div>}
    {!data ? <p>Loading…</p> : <>
      {abandoned && <div className="notice-warn" style={{ marginTop: 0 }}>
        This count was abandoned and nothing was posted.{data.cancellation_reason ? ` Reason: ${data.cancellation_reason}` : ''}
      </div>}

      {/* What the count has found so far, in the four figures a manager asks
          for: how far through it is, how many lines disagree, which way, and
          what that is worth. */}
      <div className="stock-figures">
        <div><span className="fig">{live.counted} <small>of {lines.length}</small></span><span className="fig-label">counted</span></div>
        <div><span className="fig">{live.variances}</span><span className="fig-label">disagree</span></div>
        <div><span className="fig">{live.gain} / {live.loss}</span><span className="fig-label">found / missing</span></div>
        <div><span className="fig">{live.varianceValue ? Math.round(live.varianceValue).toLocaleString() : '—'}</span><span className="fig-label">value of the difference</span></div>
        <div><span className="fig">{live.accuracy == null ? '—' : `${live.accuracy}%`}</span><span className="fig-label">register accuracy</span></div>
      </div>

      <p className="muted" style={{ marginTop: 12 }}>
        {posted ? 'This count has been posted; the differences are on the bin cards.'
          : abandoned ? 'Nothing here was posted.'
          : 'Enter what you actually found. Leave a line blank if it was not counted — only counted lines are posted.'}
      </p>

      {!locked && <div className="reg-head-actions" style={{ margin: '10px 0', gap: 10, flexWrap: 'wrap' }}>
        <RegisterSearch style={{ flex: '1 1 220px' }} onQuery={setQuery} placeholder="Search item, lot, shelf…" />
        <div className="reg-seg" role="tablist" aria-label="Filter the sheet">
          {([['all', `All ${lines.length}`], ['todo', `Still to count ${live.outstanding}`], ['variance', `Disagreeing ${live.variances}`]] as const)
            .map(([k, label]) => <button key={k} type="button" role="tab" aria-selected={filter === k}
              className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>{label}</button>)}
        </div>
        <div style={{ flex: '1 1 220px' }}>
          <BarcodeScanner placeholder="Scan a box to find its row…" autoFocus={false} onScan={code => { setQuery(code.trim()); setFilter('all'); }} />
        </div>
        {Boolean(data.blind) && <button type="button" className="secondary" onClick={() => setRevealed(r => !r)}>
          {hideBook ? <><LockOpen size={14} /> Reveal the book balance</> : <><Lock size={14} /> Hide it again</>}
        </button>}
      </div>}

      {hideBook && <p className="hint" style={{ marginTop: 0 }}>
        This is a blind count — what the register believes is hidden until the sheet is posted.
      </p>}
      {Boolean(data.blind) && revealed && !posted && <div className="notice-warn">
        The book balance has been revealed on a blind count. That is recorded against nothing — but the point of
        counting blind is lost for any line counted from here on.
      </div>}

      <div className="table-scroll"><table className="data-table count-sheet"><thead><tr>
        <th>Item</th><th>Batch / lot</th><th>Expires</th><th>Where</th>
        <th>{hideBook ? <span className="muted">hidden</span> : 'Book balance'}</th>
        <th>Counted</th><th>Variance</th><th>Reason</th><th></th>
      </tr></thead><tbody>
        {shown.map(l => {
          const v = varianceOf(l);
          return <tr key={l.id} className={l.added_manually ? 'row-added' : ''}>
            <td>
              <span className="reg-primary">{l.item_name}{l.added_manually && <span className="badge">found at the shelf</span>}</span>
              <span className="reg-sub">{l.item_code}</span>
            </td>
            <td>{l.batch_number || <span className="muted">{l.batch_id ? `#${l.batch_id}` : 'no lot'}</span>}
              {l.lot_number && <span className="reg-sub">lot {l.lot_number}</span>}</td>
            <td className="nowrap">{dateOnly(l.expiry_date)}</td>
            <td>{l.storage_path || <span className="muted">—</span>}</td>
            <td>{hideBook ? <span className="muted">—</span> : <>{l.system_quantity} {l.unit || ''}</>}</td>
            <td><input type="number" step="any" style={{ width: 110 }} disabled={locked} value={value(l)}
              onChange={e => patch(l, { counted: e.target.value })} /></td>
            <td>{v == null ? <span className="muted">—</span>
              : hideBook ? <span className="muted">on posting</span>
              : v === 0 ? <span className="badge" style={{ background: '#e4f7ec', color: '#155c34' }}>agrees</span>
              : <span className="badge" style={{ background: '#fde2e2', color: '#b42318' }}>{v > 0 ? '+' : ''}{Math.round(v * 100) / 100}</span>}</td>
            <td><input disabled={locked} placeholder={v ? 'Why?' : ''} style={{ minWidth: 160 }}
              value={edits[l.id]?.reason ?? l.reason ?? ''}
              onChange={e => patch(l, { reason: e.target.value })} /></td>
            <td className="reg-actions-col">
              {!locked && <div className="reg-row-actions">
                {!hideBook && <button type="button" className="tiny" title="Record it as agreeing with the register"
                  onClick={() => patch(l, { counted: String(l.system_quantity) })}>Agrees</button>}
                {l.added_manually && <button type="button" className="tiny danger" title="Take this line off the sheet"
                  onClick={() => void api(`/supplier-inventory/counts/${id}/lines/${l.id}`, { method: 'DELETE' }).then(load).catch(e => setError((e as Error).message))}>
                  <Trash2 size={13} />
                </button>}
              </div>}
            </td>
          </tr>;
        })}
        {shown.length === 0 && <tr><td colSpan={9} className="muted" style={{ padding: 18, textAlign: 'center' }}>
          {lines.length === 0
            ? 'This sheet is empty — nothing matched the scope it was drawn up for. Add what is on the shelf, or abandon it and start one with a wider scope.'
            : 'Nothing matches that filter.'}
        </td></tr>}
      </tbody></table></div>
      {shownPage.hidden > 0 && <p className="muted list-capped">
        Showing {shownPage.shown.length.toLocaleString()} of {shownPage.total.toLocaleString()} lines on this sheet.
        Use “Still to count” to work through the rest, or search for the shelf you are standing at.
      </p>}

      {/* Something on the shelf that the register never listed. This is the
          half of a count that finds stock rather than confirming it. */}
      {adding && <DetailModal open onClose={() => setAdding(false)} width="narrow" title="Add what was found"
        footer={<>
          <button type="button" className="secondary" onClick={() => setAdding(false)}>Cancel</button>
          <button type="submit" form="add-count-line" disabled={busy === 'add' || !addForm.itemId}>{busy === 'add' ? 'Adding…' : 'Add it to the sheet'}</button>
        </>}>
        {error && <div className="error">{error}</div>}
        <p className="muted" style={{ marginTop: 0 }}>
          For stock the sheet did not list — a box behind another box, a lot nobody booked in, something moved
          from a unit's own cupboard. It posts as a variance like any other line.
        </p>
        <form id="add-count-line" className="form" onSubmit={addLine}>
          <label>Item<select value={addForm.itemId} onChange={e => setAddForm({ ...addForm, itemId: e.target.value, batchId: '' })} required>
            <option value="">Select the item</option>
            {items.map(i => <option key={i.id} value={i.id}>{i.name} — {i.item_code}</option>)}
          </select></label>
          <label>Quantity found<input type="number" step="any" min={0} value={addForm.countedQuantity}
            onChange={e => setAddForm({ ...addForm, countedQuantity: e.target.value })} /></label>
          <label>Reason<input value={addForm.reason} onChange={e => setAddForm({ ...addForm, reason: e.target.value })}
            placeholder="Found behind the fridge, never booked in…" /></label>
          <label>Note<input value={addForm.note} onChange={e => setAddForm({ ...addForm, note: e.target.value })} /></label>
          {chosenItem && <p className="hint">
            The register holds {qty(chosenItem.on_hand)} {chosenItem.unit || ''} of this across {chosenItem.batch_count} lot
            {chosenItem.batch_count === 1 ? '' : 's'}. What is entered here is counted against nothing, so the whole
            quantity posts as stock found.
          </p>}
        </form>
      </DetailModal>}
    </>}
  </DetailModal>;
}
