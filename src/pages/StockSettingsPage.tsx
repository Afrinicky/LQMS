import { FormEvent, useEffect, useMemo, useState } from 'react';
import { Plus, Warehouse, Thermometer, Barcode, Trash2, Pencil } from 'lucide-react';
import { api } from '../services/api';
import { DetailModal } from '../components/ui';
import {
  STORAGE_KINDS, STORAGE_KIND_LABELS, isColdStorage,
  BARCODE_SOURCE_LABELS, normaliseBarcodePolicy, type BarcodePolicy,
} from '../../shared/constants/inventory';
import type { Section } from '../../shared/types/api';

/* ============================================================================
   STOCK & STORAGE SETTINGS

   Two things a laboratory could not previously configure, and one of them was
   why the Location field on a new stock item was an empty dropdown.

   A laboratory does not store reagents "somewhere". It stores them on a named
   shelf, in a named fridge, in the main store or in a unit's own cupboard — and
   an assessor asks to be taken to them. So storage is a tree the laboratory
   builds: places inside places, with the temperature a cold place is supposed
   to hold.

   The barcode policy is the other. Plenty of reagents arrive with a barcode
   already printed on the box; re-labelling those is wasted work and a chance to
   mislabel. Plenty arrive with nothing at all. The laboratory picks its normal
   answer here, and any item may differ from it.
   ========================================================================= */

export type StorageLocation = {
  id: number; name: string; kind: string; parent_id: number | null; section_id: number | null;
  code?: string | null; description?: string | null; temp_min?: number | null; temp_max?: number | null;
  is_active: number; display_order: number; path: string; section_name?: string | null;
  item_count: number; child_count: number;
};

const blankPlace = { name: '', kind: 'shelf', parentId: '', sectionId: '', code: '', description: '', tempMin: '', tempMax: '' };

export default function StockSettingsPage() {
  const [places, setPlaces] = useState<StorageLocation[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [policy, setPolicy] = useState<BarcodePolicy>({ defaultSource: 'system', allowPerItem: true });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState(blankPlace);
  const [editing, setEditing] = useState<StorageLocation | null>(null);

  const load = () => Promise.all([
    api<StorageLocation[]>('/supplier-inventory/storage-locations?includeInactive=true').then(setPlaces),
    api<BarcodePolicy>('/supplier-inventory/barcode-policy').then(p => setPolicy(normaliseBarcodePolicy(p))),
    api<Section[]>('/sections').then(setSections).catch(() => setSections([])),
  ]).catch(e => setError((e as Error).message));
  useEffect(() => { void load(); }, []);

  async function run(label: string, fn: () => Promise<unknown>, done: string) {
    setBusy(label); setError(null); setNotice(null);
    try { await fn(); setNotice(done); await load(); return true; }
    catch (e) { setError((e as Error).message); return false; }
    finally { setBusy(null); }
  }

  async function addPlace(e: FormEvent) {
    e.preventDefault();
    const ok = await run('add', () => api('/supplier-inventory/storage-locations', { method: 'POST', body: JSON.stringify(form) }), `${form.name} added.`);
    if (ok) { setAdding(false); setForm(blankPlace); }
  }
  async function saveEdit(e: FormEvent) {
    e.preventDefault();
    if (!editing) return;
    const ok = await run('edit', () => api(`/supplier-inventory/storage-locations/${editing.id}`, {
      method: 'PUT',
      body: JSON.stringify({
        name: editing.name, kind: editing.kind, parentId: editing.parent_id ?? '', sectionId: editing.section_id ?? '',
        code: editing.code ?? '', description: editing.description ?? '',
        tempMin: editing.temp_min ?? '', tempMax: editing.temp_max ?? '', isActive: editing.is_active === 1,
      }),
    }), 'Storage place updated.');
    if (ok) setEditing(null);
  }

  // Deepest-last, so a tree reads as a tree in a flat list.
  const ordered = useMemo(() => [...places].sort((a, b) => a.path.localeCompare(b.path)), [places]);
  const depthOf = (p: StorageLocation) => (p.path.match(/›/g) || []).length;

  return <div className="settings-module">
    <div className="settings-module-head">
      <h2>Stock &amp; Storage</h2>
      <p>Where the laboratory keeps its reagents and consumables, and how its stock is barcoded. Stock item categories, units of measure, issue reasons and movement reasons live in <strong>Dropdown Lists</strong>.</p>
    </div>

    {error && <div className="error">{error}</div>}
    {notice && <div className="notice-ok">{notice}</div>}

    {/* ---- Storage places ------------------------------------------------ */}
    <div className="card">
      <div className="reg-head">
        <div className="reg-head-text">
          <h3><Warehouse size={17} style={{ verticalAlign: '-3px', marginRight: 7 }} />Storage places</h3>
          <p className="muted">
            The stores, rooms, shelves, fridges and freezers stock actually sits in. Put places inside places —
            a shelf in a store, a shelf in a fridge in a unit — and every stock item can then say exactly where
            it is. A cold place carries the temperature range it is meant to hold.
          </p>
        </div>
        <div className="reg-head-actions">
          <button type="button" onClick={() => { setForm(blankPlace); setAdding(true); }}><Plus size={15} /> Add a place</button>
        </div>
      </div>

      <div className="table-scroll">
        <table className="data-table">
          <thead><tr><th>Place</th><th>Kind</th><th>Unit</th><th>Temperature</th><th>Holding</th><th className="reg-actions-col"></th></tr></thead>
          <tbody>
            {ordered.map(p => <tr key={p.id} className={p.is_active ? '' : 'row-retired'}>
              <td>
                <span className="reg-primary" style={{ paddingLeft: depthOf(p) * 16 }}>
                  {depthOf(p) > 0 && <span className="muted" style={{ marginRight: 6 }}>└</span>}{p.name}
                  {!p.is_active && <span className="badge inactive">not in use</span>}
                </span>
                {p.code && <span className="reg-sub" style={{ paddingLeft: depthOf(p) * 16 }}>{p.code}</span>}
              </td>
              <td>{STORAGE_KIND_LABELS[p.kind] ?? p.kind}</td>
              <td>{p.section_name || <span className="muted">—</span>}</td>
              <td>
                {p.temp_min != null || p.temp_max != null
                  ? <span className="reg-primary"><Thermometer size={12} style={{ verticalAlign: '-1px' }} /> {p.temp_min ?? '−∞'} to {p.temp_max ?? '∞'} °C</span>
                  : <span className="muted">{isColdStorage(p.kind) ? 'no range set' : '—'}</span>}
              </td>
              <td>{p.item_count ? `${p.item_count} item${p.item_count === 1 ? '' : 's'}` : <span className="muted">empty</span>}</td>
              <td className="reg-actions-col">
                <div className="reg-row-actions">
                  <button type="button" className="tiny" onClick={() => setEditing({ ...p })}><Pencil size={13} /> Edit</button>
                  <button type="button" className="tiny danger" disabled={busy === `del-${p.id}`}
                    onClick={() => void run(`del-${p.id}`, () => api(`/supplier-inventory/storage-locations/${p.id}`, { method: 'DELETE' }), `${p.name} removed.`)}>
                    <Trash2 size={13} />
                  </button>
                </div>
              </td>
            </tr>)}
            {ordered.length === 0 && <tr><td colSpan={6} className="muted" style={{ padding: 18, textAlign: 'center' }}>
              No storage places yet — add the main store, then the shelves and fridges inside it.
            </td></tr>}
          </tbody>
        </table>
      </div>
    </div>

    {/* ---- Barcodes ------------------------------------------------------- */}
    <div className="card" style={{ marginTop: 16 }}>
      <h3><Barcode size={17} style={{ verticalAlign: '-3px', marginRight: 7 }} />Barcodes on stock</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        Some reagents arrive with a barcode already printed on the box; others arrive with nothing. Choose what
        this laboratory does by default. Whatever an item ends up carrying, scanning it finds it — the register
        matches both the product's barcode and the one SECH_LIMS generates.
      </p>
      <div className="bc-choice">
        {(['system', 'product'] as const).map(src => (
          <button key={src} type="button" className={policy.defaultSource === src ? 'active' : ''}
            onClick={() => setPolicy(p => ({ ...p, defaultSource: src }))}>
            <strong>{src === 'system' ? 'Generate our own' : "Use the product's barcode"}</strong>
            <span>{BARCODE_SOURCE_LABELS[src]}</span>
          </button>
        ))}
      </div>
      <label className="toggle" style={{ marginTop: 12 }}>
        <input type="checkbox" checked={policy.allowPerItem} onChange={e => setPolicy(p => ({ ...p, allowPerItem: e.target.checked }))} />
        Let individual items differ from this
      </label>
      <p className="hint" style={{ marginTop: 4 }}>
        Leave this on unless every single item is the same. A laboratory almost always has some boxes that carry
        a barcode and some that do not.
      </p>
      <div style={{ marginTop: 12 }}>
        <button type="button" disabled={busy === 'policy'}
          onClick={() => void run('policy', () => api('/supplier-inventory/barcode-policy', { method: 'PUT', body: JSON.stringify(policy) }), 'Barcode policy saved.')}>
          {busy === 'policy' ? 'Saving…' : 'Save barcode policy'}
        </button>
      </div>
    </div>

    {/* ---- Add / edit a place -------------------------------------------- */}
    <DetailModal open={adding} onClose={() => setAdding(false)} width="narrow" title="Add a storage place"
      footer={<>
        <button type="button" className="secondary" onClick={() => setAdding(false)}>Cancel</button>
        <button type="submit" form="add-place" disabled={!form.name.trim() || busy === 'add'}>{busy === 'add' ? 'Adding…' : 'Add'}</button>
      </>}>
      {error && <div className="error">{error}</div>}
      <form id="add-place" className="form-grid" onSubmit={addPlace}>
        <label className="wide">Name<input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="e.g. Shelf B3, Reagent fridge, Haematology cupboard" /></label>
        <label>Kind<select value={form.kind} onChange={e => setForm({ ...form, kind: e.target.value })}>
          {STORAGE_KINDS.map(k => <option key={k} value={k}>{STORAGE_KIND_LABELS[k]}</option>)}</select></label>
        <label>Inside<select value={form.parentId} onChange={e => setForm({ ...form, parentId: e.target.value })}>
          <option value="">Nothing — this is a top-level place</option>
          {ordered.map(p => <option key={p.id} value={p.id}>{p.path}</option>)}</select></label>
        <label>Unit <span className="muted">(optional)</span><select value={form.sectionId} onChange={e => setForm({ ...form, sectionId: e.target.value })}>
          <option value="">Not tied to a unit</option>
          {sections.map(sec => <option key={sec.id} value={sec.id}>{sec.name}</option>)}</select></label>
        <label>Label / code <span className="muted">(optional)</span><input value={form.code} onChange={e => setForm({ ...form, code: e.target.value })} placeholder="e.g. B3" /></label>
        {isColdStorage(form.kind) && <>
          <label>Coldest allowed °C<input type="number" step="any" value={form.tempMin} onChange={e => setForm({ ...form, tempMin: e.target.value })} placeholder="2" /></label>
          <label>Warmest allowed °C<input type="number" step="any" value={form.tempMax} onChange={e => setForm({ ...form, tempMax: e.target.value })} placeholder="8" /></label>
        </>}
      </form>
    </DetailModal>

    <DetailModal open={!!editing} onClose={() => setEditing(null)} width="narrow" title={editing ? `Edit ${editing.name}` : ''}
      footer={<>
        <button type="button" className="secondary" onClick={() => setEditing(null)}>Cancel</button>
        <button type="submit" form="edit-place" disabled={busy === 'edit'}>{busy === 'edit' ? 'Saving…' : 'Save'}</button>
      </>}>
      {editing && <>
        {error && <div className="error">{error}</div>}
        <form id="edit-place" className="form-grid" onSubmit={saveEdit}>
          <label className="wide">Name<input value={editing.name} onChange={e => setEditing({ ...editing, name: e.target.value })} /></label>
          <label>Kind<select value={editing.kind} onChange={e => setEditing({ ...editing, kind: e.target.value })}>
            {STORAGE_KINDS.map(k => <option key={k} value={k}>{STORAGE_KIND_LABELS[k]}</option>)}</select></label>
          <label>Inside<select value={String(editing.parent_id ?? '')} onChange={e => setEditing({ ...editing, parent_id: e.target.value ? Number(e.target.value) : null })}>
            <option value="">Nothing — this is a top-level place</option>
            {ordered.filter(p => p.id !== editing.id).map(p => <option key={p.id} value={p.id}>{p.path}</option>)}</select></label>
          <label>Unit<select value={String(editing.section_id ?? '')} onChange={e => setEditing({ ...editing, section_id: e.target.value ? Number(e.target.value) : null })}>
            <option value="">Not tied to a unit</option>
            {sections.map(sec => <option key={sec.id} value={sec.id}>{sec.name}</option>)}</select></label>
          <label>Label / code<input value={editing.code ?? ''} onChange={e => setEditing({ ...editing, code: e.target.value })} /></label>
          {isColdStorage(editing.kind) && <>
            <label>Coldest allowed °C<input type="number" step="any" value={editing.temp_min ?? ''} onChange={e => setEditing({ ...editing, temp_min: e.target.value === '' ? null : Number(e.target.value) })} /></label>
            <label>Warmest allowed °C<input type="number" step="any" value={editing.temp_max ?? ''} onChange={e => setEditing({ ...editing, temp_max: e.target.value === '' ? null : Number(e.target.value) })} /></label>
          </>}
          <label className="toggle wide">
            <input type="checkbox" checked={editing.is_active === 1} onChange={e => setEditing({ ...editing, is_active: e.target.checked ? 1 : 0 })} />
            Still in use
          </label>
        </form>
      </>}
    </DetailModal>
  </div>;
}
