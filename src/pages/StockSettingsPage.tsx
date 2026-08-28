import { FormEvent, useEffect, useMemo, useState } from 'react';
import { usePermissions } from '../hooks/usePermissions';
import { Plus, Warehouse, Thermometer, Barcode, Trash2, Pencil, Truck } from 'lucide-react';
import { api, errorText , apiRead } from '../services/api';
import { DetailModal, NumberField } from '../components/ui';
import {
  STORAGE_KINDS, STORAGE_KIND_LABELS, isColdStorage,
  BARCODE_SOURCE_LABELS, normaliseBarcodePolicy, type BarcodePolicy,
  SUPPLY_SOURCE_KINDS, SUPPLY_SOURCE_KIND_LABELS, PROCUREMENT_MODES, PROCUREMENT_MODE_LABELS,
  PROCUREMENT_MODE_HINTS, normaliseProcurementPolicy, allowsStore, type ProcurementPolicy,
} from '../../shared/constants/inventory';
import type { Section } from '../../shared/types/api';
import TextField from '../components/ui/TextField';
import { Notice } from '../components/ui/Feedback';

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
const blankSource = { name: '', kind: 'main_store', code: '', contactPerson: '', phone: '', email: '', address: '', note: '' };

export type SupplySource = {
  id: number; name: string; kind: string; kind_label?: string; code?: string | null;
  contact_person?: string | null; phone?: string | null; email?: string | null;
  address?: string | null; note?: string | null; is_active: number; receipt_count: number;
};

export default function StockSettingsPage() {
  const { can } = usePermissions();
  const [places, setPlaces] = useState<StorageLocation[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [policy, setPolicy] = useState<BarcodePolicy>({ defaultSource: 'system', allowPerItem: true });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState(blankPlace);
  const [editing, setEditing] = useState<StorageLocation | null>(null);
  // Where deliveries come from, and whether this laboratory draws from a store
  // at all. A hospital laboratory usually does; a standalone one usually does not.
  const [procurement, setProcurement] = useState<ProcurementPolicy>({ mode: 'direct', defaultSourceType: 'supplier' });
  const [sources, setSources] = useState<SupplySource[]>([]);
  const [addingSource, setAddingSource] = useState(false);
  const [sourceForm, setSourceForm] = useState(blankSource);
  const [editingSource, setEditingSource] = useState<SupplySource | null>(null);

  const load = () => Promise.all([
    apiRead<StorageLocation[]>('/supplier-inventory/storage-locations?includeInactive=true', []).then(setPlaces),
    apiRead<BarcodePolicy | null>('/supplier-inventory/barcode-policy', null).then(p => { if (p) setPolicy(normaliseBarcodePolicy(p)); }),
    api<Section[]>('/sections').then(setSections).catch(() => setSections([])),
    api<ProcurementPolicy>('/supplier-inventory/procurement-policy').then(p => setProcurement(normaliseProcurementPolicy(p))).catch(() => undefined),
    api<SupplySource[]>('/supplier-inventory/supply-sources?includeInactive=true').then(setSources).catch(() => setSources([])),
  ]).catch(e => setError(errorText(e)));
  useEffect(() => { void load(); }, []);

  async function run(label: string, fn: () => Promise<unknown>, done: string) {
    setBusy(label); setError(null); setNotice(null);
    try { await fn(); setNotice(done); await load(); return true; }
    catch (e) { setError(errorText(e)); return false; }
    finally { setBusy(null); }
  }

  async function addPlace(e: FormEvent) {
    e.preventDefault();
    const ok = await run('add', () => api('/supplier-inventory/storage-locations', { method: 'POST', body: JSON.stringify(form) }), `${form.name} added.`);
    if (ok) { setAdding(false); setForm(blankPlace); }
  }
  async function addSource(e: FormEvent) {
    e.preventDefault();
    const ok = await run('add-source', () => api('/supplier-inventory/supply-sources', { method: 'POST', body: JSON.stringify(sourceForm) }), `${sourceForm.name} added.`);
    if (ok) { setAddingSource(false); setSourceForm(blankSource); }
  }
  async function saveSource(e: FormEvent) {
    e.preventDefault();
    if (!editingSource) return;
    const ok = await run('edit-source', () => api(`/supplier-inventory/supply-sources/${editingSource.id}`, {
      method: 'PUT',
      body: JSON.stringify({
        name: editingSource.name, kind: editingSource.kind, code: editingSource.code ?? '',
        contactPerson: editingSource.contact_person ?? '', phone: editingSource.phone ?? '',
        email: editingSource.email ?? '', address: editingSource.address ?? '',
        note: editingSource.note ?? '', isActive: editingSource.is_active === 1,
      }),
    }), 'Source updated.');
    if (ok) setEditingSource(null);
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
      <p>Where the laboratory keeps its reagents and consumables, where deliveries come from, and how its stock is barcoded. Stock item categories, units of measure, issue reasons, movement reasons and outside issue destinations live in <strong>Dropdown Lists</strong>.</p>
    </div>

    {error && <Notice kind="error">{error}</Notice>}
    {notice && <Notice kind="success">{notice}</Notice>}

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

    {/* ---- Where deliveries come from ------------------------------------- */}
    <div className="card" style={{ marginTop: 16 }}>
      <h3><Truck size={17} style={{ verticalAlign: '-3px', marginRight: 7 }} />Where stock comes from</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        A standalone laboratory buys what it uses. A hospital laboratory usually draws most of its reagents
        from the hospital's main store and buys only a few items direct — and may also receive from a district,
        regional or national medical store. Say which of those happens here, and the receiving screen asks for
        the right thing instead of pretending every delivery came from a supplier.
      </p>
      <div className="bc-choice">
        {PROCUREMENT_MODES.map(mode => (
          <button key={mode} type="button" className={procurement.mode === mode ? 'active' : ''}
            onClick={() => setProcurement(p => normaliseProcurementPolicy({ ...p, mode }))}>
            <strong>{PROCUREMENT_MODE_LABELS[mode]}</strong>
            <span>{PROCUREMENT_MODE_HINTS[mode]}</span>
          </button>
        ))}
      </div>
      {procurement.mode === 'both' && <label style={{ marginTop: 12, display: 'block', maxWidth: 420 }}>
        Which one a receipt starts on
        <select value={procurement.defaultSourceType} onChange={e => setProcurement(p => ({ ...p, defaultSourceType: e.target.value === 'store' ? 'store' : 'supplier' }))}>
          <option value="supplier">Bought direct from a supplier</option>
          <option value="store">Drawn from a store</option>
        </select>
      </label>}
      <div style={{ marginTop: 12 }}>
        <button type="button" disabled={busy === 'procurement'}
          onClick={() => void run('procurement', () => api('/supplier-inventory/procurement-policy', { method: 'PUT', body: JSON.stringify(procurement) }), 'Saved — the receiving screen follows this now.')}>
          {busy === 'procurement' ? 'Saving…' : 'Save how stock is obtained'}
        </button>
      </div>

      {allowsStore(procurement) && <>
        <div className="reg-head" style={{ marginTop: 20 }}>
          <div className="reg-head-text">
            <h4 style={{ margin: 0 }}>Stores this laboratory draws from</h4>
            <p className="muted" style={{ margin: '2px 0 0' }}>
              Every store a delivery can be received from — the hospital's own main store, and any district,
              regional, national or partner store that supplies this laboratory. More than one is normal.
            </p>
          </div>
          <div className="reg-head-actions">
            <button type="button" onClick={() => { setSourceForm(blankSource); setAddingSource(true); }}><Plus size={15} /> Add a store</button>
          </div>
        </div>
        <div className="table-scroll" style={{ marginTop: 10 }}>
          <table className="data-table">
            <thead><tr><th>Store</th><th>Kind</th><th>Contact</th><th>Deliveries</th><th className="reg-actions-col"></th></tr></thead>
            <tbody>
              {sources.map(src => <tr key={src.id} className={src.is_active ? '' : 'row-retired'}>
                <td>
                  <span className="reg-primary">{src.name}{!src.is_active && <span className="badge inactive">not in use</span>}</span>
                  {src.code && <span className="reg-sub">{src.code}</span>}
                </td>
                <td>{SUPPLY_SOURCE_KIND_LABELS[src.kind] ?? src.kind}</td>
                <td>{src.contact_person || <span className="muted">—</span>}
                  {(src.phone || src.email) && <span className="reg-sub">{[src.phone, src.email].filter(Boolean).join(' · ')}</span>}</td>
                <td>{src.receipt_count ? `${src.receipt_count}` : <span className="muted">none yet</span>}</td>
                <td className="reg-actions-col">
                  <div className="reg-row-actions">
                    <button type="button" className="tiny" onClick={() => setEditingSource({ ...src })}><Pencil size={13} /> Edit</button>
                    <button type="button" className="tiny danger" disabled={busy === `del-src-${src.id}`}
                      onClick={() => void run(`del-src-${src.id}`, () => api(`/supplier-inventory/supply-sources/${src.id}`, { method: 'DELETE' }), `${src.name} removed.`)}>
                      <Trash2 size={13} />
                    </button>
                  </div>
                </td>
              </tr>)}
              {sources.length === 0 && <tr><td colSpan={5} className="muted" style={{ padding: 18, textAlign: 'center' }}>
                No stores yet — add the one this laboratory draws most of its stock from.
              </td></tr>}
            </tbody>
          </table>
        </div>
      </>}
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
      {error && <Notice kind="error">{error}</Notice>}
      {can('settings', 'edit') && <form id="add-place" className="form-grid" onSubmit={addPlace}>
        <label className="wide">Name<TextField value={form.name} onValue={nextValue => setForm({ ...form, name: nextValue })} placeholder="e.g. Shelf B3, Reagent fridge, Haematology cupboard" /></label>
        <label>Kind<select value={form.kind} onChange={e => setForm({ ...form, kind: e.target.value })}>
          {STORAGE_KINDS.map(k => <option key={k} value={k}>{STORAGE_KIND_LABELS[k]}</option>)}</select></label>
        <label>Inside<select value={form.parentId} onChange={e => setForm({ ...form, parentId: e.target.value })}>
          <option value="">Nothing — this is a top-level place</option>
          {ordered.map(p => <option key={p.id} value={p.id}>{p.path}</option>)}</select></label>
        <label>Unit <span className="muted">(optional)</span><select value={form.sectionId} onChange={e => setForm({ ...form, sectionId: e.target.value })}>
          <option value="">Not tied to a unit</option>
          {sections.map(sec => <option key={sec.id} value={sec.id}>{sec.name}</option>)}</select></label>
        <label>Label / code <span className="muted">(optional)</span><TextField value={form.code} onValue={nextValue => setForm({ ...form, code: nextValue })} placeholder="e.g. B3" /></label>
        {isColdStorage(form.kind) && <>
          <label>Coldest allowed °C<input type="number" step="any" value={form.tempMin} onChange={e => setForm({ ...form, tempMin: e.target.value })} placeholder="2" /></label>
          <label>Warmest allowed °C<input type="number" step="any" value={form.tempMax} onChange={e => setForm({ ...form, tempMax: e.target.value })} placeholder="8" /></label>
        </>}
      </form>}
    </DetailModal>

    <DetailModal open={addingSource} onClose={() => setAddingSource(false)} width="narrow" title="Add a store"
      footer={<>
        <button type="button" className="secondary" onClick={() => setAddingSource(false)}>Cancel</button>
        <button type="submit" form="add-source" disabled={!sourceForm.name.trim() || busy === 'add-source'}>{busy === 'add-source' ? 'Adding…' : 'Add'}</button>
      </>}>
      {error && <Notice kind="error">{error}</Notice>}
      {can('settings', 'edit') && <form id="add-source" className="form-grid" onSubmit={addSource}>
        <label className="wide">Name<TextField value={sourceForm.name} onValue={nextValue => setSourceForm({ ...sourceForm, name: nextValue })} placeholder="e.g. Hospital Main Store, Regional Medical Store" /></label>
        <label>Kind<select value={sourceForm.kind} onChange={e => setSourceForm({ ...sourceForm, kind: e.target.value })}>
          {SUPPLY_SOURCE_KINDS.map(k => <option key={k} value={k}>{SUPPLY_SOURCE_KIND_LABELS[k]}</option>)}</select></label>
        <label>Code <span className="muted">(optional)</span><TextField value={sourceForm.code} onValue={nextValue => setSourceForm({ ...sourceForm, code: nextValue })} /></label>
        <label>Contact person<TextField value={sourceForm.contactPerson} onValue={nextValue => setSourceForm({ ...sourceForm, contactPerson: nextValue })} /></label>
        <label>Phone<TextField value={sourceForm.phone} onValue={nextValue => setSourceForm({ ...sourceForm, phone: nextValue })} /></label>
        <label className="wide">Note<TextField value={sourceForm.note} onValue={nextValue => setSourceForm({ ...sourceForm, note: nextValue })} placeholder="Requisition day, who signs for it…" /></label>
      </form>}
    </DetailModal>

    <DetailModal open={!!editingSource} onClose={() => setEditingSource(null)} width="narrow" title={editingSource ? `Edit ${editingSource.name}` : ''}
      footer={<>
        <button type="button" className="secondary" onClick={() => setEditingSource(null)}>Cancel</button>
        <button type="submit" form="edit-source" disabled={busy === 'edit-source'}>{busy === 'edit-source' ? 'Saving…' : 'Save'}</button>
      </>}>
      {editingSource && <>
        {error && <Notice kind="error">{error}</Notice>}
        {can('settings', 'edit') && <form id="edit-source" className="form-grid" onSubmit={saveSource}>
          <label className="wide">Name<TextField value={editingSource.name} onValue={nextValue => setEditingSource({ ...editingSource, name: nextValue })} /></label>
          <label>Kind<select value={editingSource.kind} onChange={e => setEditingSource({ ...editingSource, kind: e.target.value })}>
            {SUPPLY_SOURCE_KINDS.map(k => <option key={k} value={k}>{SUPPLY_SOURCE_KIND_LABELS[k]}</option>)}</select></label>
          <label>Code<TextField value={editingSource.code ?? ''} onValue={nextValue => setEditingSource({ ...editingSource, code: nextValue })} /></label>
          <label>Contact person<TextField value={editingSource.contact_person ?? ''} onValue={nextValue => setEditingSource({ ...editingSource, contact_person: nextValue })} /></label>
          <label>Phone<TextField value={editingSource.phone ?? ''} onValue={nextValue => setEditingSource({ ...editingSource, phone: nextValue })} /></label>
          <label className="wide">Note<TextField value={editingSource.note ?? ''} onValue={nextValue => setEditingSource({ ...editingSource, note: nextValue })} /></label>
          <label className="toggle wide">
            <input type="checkbox" checked={editingSource.is_active === 1} onChange={e => setEditingSource({ ...editingSource, is_active: e.target.checked ? 1 : 0 })} />
            Still drawn from
          </label>
        </form>}
      </>}
    </DetailModal>

    <DetailModal open={!!editing} onClose={() => setEditing(null)} width="narrow" title={editing ? `Edit ${editing.name}` : ''}
      footer={<>
        <button type="button" className="secondary" onClick={() => setEditing(null)}>Cancel</button>
        <button type="submit" form="edit-place" disabled={busy === 'edit'}>{busy === 'edit' ? 'Saving…' : 'Save'}</button>
      </>}>
      {editing && <>
        {error && <Notice kind="error">{error}</Notice>}
        {can('settings', 'edit') && <form id="edit-place" className="form-grid" onSubmit={saveEdit}>
          <label className="wide">Name<TextField value={editing.name} onValue={nextValue => setEditing({ ...editing, name: nextValue })} /></label>
          <label>Kind<select value={editing.kind} onChange={e => setEditing({ ...editing, kind: e.target.value })}>
            {STORAGE_KINDS.map(k => <option key={k} value={k}>{STORAGE_KIND_LABELS[k]}</option>)}</select></label>
          <label>Inside<select value={String(editing.parent_id ?? '')} onChange={e => setEditing({ ...editing, parent_id: e.target.value ? Number(e.target.value) : null })}>
            <option value="">Nothing — this is a top-level place</option>
            {ordered.filter(p => p.id !== editing.id).map(p => <option key={p.id} value={p.id}>{p.path}</option>)}</select></label>
          <label>Unit<select value={String(editing.section_id ?? '')} onChange={e => setEditing({ ...editing, section_id: e.target.value ? Number(e.target.value) : null })}>
            <option value="">Not tied to a unit</option>
            {sections.map(sec => <option key={sec.id} value={sec.id}>{sec.name}</option>)}</select></label>
          <label>Label / code<TextField value={editing.code ?? ''} onValue={nextValue => setEditing({ ...editing, code: nextValue })} /></label>
          {isColdStorage(editing.kind) && <>
            <label>Coldest allowed °C<NumberField step="any" value={editing.temp_min ?? null} onValue={n => setEditing({ ...editing, temp_min: n })} /></label>
            <label>Warmest allowed °C<NumberField step="any" value={editing.temp_max ?? null} onValue={n => setEditing({ ...editing, temp_max: n })} /></label>
          </>}
          <label className="toggle wide">
            <input type="checkbox" checked={editing.is_active === 1} onChange={e => setEditing({ ...editing, is_active: e.target.checked ? 1 : 0 })} />
            Still in use
          </label>
        </form>}
      </>}
    </DetailModal>
  </div>;
}
