/**
 * Inventory screen for the mobile companion (M3): view current stock (with
 * low-stock and expiry flags) and record usage/consumption against a specific
 * batch. Usage posts to /supplier-inventory/batches/:id/movement through the
 * offline-aware submit(). Stock and batches come from the existing Host endpoints.
 */
import { useEffect, useMemo, useState } from 'react';
import { api } from '../src/services/api';
import { submit } from './net';
import { Back, Field, Result, s, type Msg } from './ui';

type Row = Record<string, unknown>;

function expiryBadge(status: string) {
  const v = status.toLowerCase();
  if (v.includes('expired')) return <span className="m-tag danger">Expired</span>;
  if (v.includes('expir') || v.includes('soon')) return <span className="m-tag warn">Expiring</span>;
  return null;
}

export function InventoryScreen({ onBack }: { onBack: () => void }) {
  const [mode, setMode] = useState<'stock' | 'usage'>('stock');
  const [items, setItems] = useState<Row[] | null>(null);
  const [batches, setBatches] = useState<Row[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api<Row[]>('/supplier-inventory/items').then(setItems).catch(e => { setItems([]); setErr((e as Error).message); });
    api<Row[]>('/supplier-inventory/batches').then(setBatches).catch(() => setBatches([]));
  }, []);

  return (
    <div className="m-screen">
      <Back onBack={onBack} />
      <div className="m-screen-h">Inventory</div>
      <div className="m-seg">
        <button className={mode === 'stock' ? 'active' : ''} onClick={() => setMode('stock')}>Stock</button>
        <button className={mode === 'usage' ? 'active' : ''} onClick={() => setMode('usage')}>Record usage</button>
      </div>
      {err && <p className="m-err">{err}</p>}
      {mode === 'stock' ? <StockList items={items} /> : <UsageForm items={items} batches={batches} />}
    </div>
  );
}

function StockList({ items }: { items: Row[] | null }) {
  if (items === null) return <p className="m-empty">Loading stock…</p>;
  if (items.length === 0) return <p className="m-empty">No inventory items on the Host.</p>;
  return (
    <div className="m-list">
      {items.map(r => (
        <div className="m-item" key={s(r.id)}>
          <div className="m-item-body">
            <div className="m-item-title">{s(r.item_name || r.name)}</div>
            <div className="m-item-meta">
              <span className="m-chip">{s(r.quantity)} {s(r.unit_of_measure || r.unit)}</span>
              {r.low_stock ? <span className="m-tag warn">Low stock</span> : null}
              {r.expiry_status ? expiryBadge(s(r.expiry_status)) : null}
              {r.supplier_name ? <span className="m-due">{s(r.supplier_name)}</span> : null}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function UsageForm({ items, batches }: { items: Row[] | null; batches: Row[] }) {
  const [itemId, setItemId] = useState('');
  const [batchId, setBatchId] = useState('');
  const [movementType, setMovementType] = useState('consume');
  const [quantity, setQuantity] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Msg>(null);

  useEffect(() => { if (items && items[0] && !itemId) setItemId(s(items[0].id)); }, [items, itemId]);
  const itemBatches = useMemo(() => batches.filter(b => s(b.item_id) === itemId), [batches, itemId]);
  useEffect(() => { setBatchId(itemBatches[0] ? s(itemBatches[0].id) : ''); }, [itemBatches]);
  const item = (items ?? []).find(r => s(r.id) === itemId);

  async function save() {
    if (!batchId) { setRes({ kind: 'err', msg: 'Select a batch to draw from.' }); return; }
    if (quantity === '' || Number(quantity) <= 0) { setRes({ kind: 'err', msg: 'Enter a positive quantity.' }); return; }
    setBusy(true); setRes(null);
    try {
      const out = await submit(`/supplier-inventory/batches/${batchId}/movement`, { movementType, quantity, reason }, `Usage · ${s(item?.item_name || item?.name)}`);
      if (out.queued) setRes({ kind: 'queued', msg: 'Saved offline — will submit automatically when back online.' });
      else { setRes({ kind: 'ok', msg: 'Usage recorded. Stock updated.' }); setQuantity(''); setReason(''); }
    } catch (e) { setRes({ kind: 'err', msg: (e as Error).message }); } finally { setBusy(false); }
  }

  if (items === null) return <p className="m-empty">Loading…</p>;
  if (items.length === 0) return <p className="m-empty">No inventory items on the Host.</p>;

  return (
    <div className="m-form">
      <Field label="Item">
        <select value={itemId} onChange={e => setItemId(e.target.value)}>
          {items.map(r => <option key={s(r.id)} value={s(r.id)}>{s(r.item_name || r.name)}</option>)}
        </select>
      </Field>
      <Field label="Batch" hint={itemBatches.length === 0 ? 'No batches recorded for this item on the Host.' : undefined}>
        <select value={batchId} onChange={e => setBatchId(e.target.value)} disabled={itemBatches.length === 0}>
          {itemBatches.map(b => <option key={s(b.id)} value={s(b.id)}>{s(b.batch_number || ('Batch #' + s(b.id)))} · {s(b.quantity_available)} left{b.expiry_date ? ' · exp ' + s(b.expiry_date) : ''}</option>)}
        </select>
      </Field>
      <Field label="Movement">
        <select value={movementType} onChange={e => setMovementType(e.target.value)}>
          <option value="consume">Consume / use</option><option value="issue">Issue to section</option><option value="discard">Discard</option><option value="waste">Waste</option>
        </select>
      </Field>
      <Field label={`Quantity${item?.unit_of_measure || item?.unit ? ' (' + s(item?.unit_of_measure || item?.unit) + ')' : ''}`}><input type="number" inputMode="decimal" step="any" value={quantity} onChange={e => setQuantity(e.target.value)} /></Field>
      <Field label="Reason / note"><input value={reason} onChange={e => setReason(e.target.value)} /></Field>
      <button className="m-btn primary block" disabled={busy || itemBatches.length === 0} onClick={save}>{busy ? 'Saving…' : 'Record usage'}</button>
      <Result r={res} />
    </div>
  );
}
