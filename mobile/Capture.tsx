/**
 * Field-capture screens for the mobile companion (M2): environmental readings and
 * equipment maintenance / breakdown reports. Each posts directly to the existing
 * Host endpoints through the offline-aware submit() (see net.ts), so captures made
 * without signal are queued and flushed on reconnect. Attribution (who recorded
 * it) is taken from the signed-in account server-side.
 */
import { useEffect, useState } from 'react';
import { api } from '../src/services/api';
import { submit } from './net';

export type CaptureKey = 'env' | 'equip:maintenance' | 'equip:breakdown';

const ICO = {
  back: 'M15 18l-6-6 6-6',
  gauge: 'M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM12 12 8 8M3 12a9 9 0 0 1 18 0',
  flask: 'M9 3h6M10 3v6.5L5.2 17a2 2 0 0 0 1.7 3h10.2a2 2 0 0 0 1.7-3L14 9.5V3M7.5 14h9',
  check: 'M20 6 9 17l-5-5',
};
const Ico = ({ d, size = 20 }: { d: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    {d.split('M').filter(Boolean).map((seg, i) => <path key={i} d={'M' + seg} />)}
  </svg>
);

const today = () => new Date().toISOString().slice(0, 10);
type Row = Record<string, unknown>;
const s = (v: unknown) => (v === null || v === undefined ? '' : String(v));

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return <div className="m-field"><label className="m-lbl">{label}</label>{children}{hint && <div className="m-fieldhint">{hint}</div>}</div>;
}

export function CaptureScreen({ capture, onBack }: { capture: CaptureKey; onBack: () => void }) {
  const isEnv = capture === 'env';
  const title = isEnv ? 'Environmental reading' : capture === 'equip:breakdown' ? 'Report breakdown' : 'Equipment maintenance';
  return (
    <div className="m-screen">
      <button className="m-back" onClick={onBack}><Ico d={ICO.back} size={18} /> Back</button>
      <div className="m-screen-h">{title}</div>
      {isEnv ? <EnvForm /> : <EquipmentForm mode={capture === 'equip:breakdown' ? 'breakdown' : 'maintenance'} />}
    </div>
  );
}

function Result({ r }: { r: { kind: 'ok' | 'queued' | 'err'; msg: string } | null }) {
  if (!r) return null;
  const cls = r.kind === 'err' ? 'err' : r.kind === 'queued' ? 'queued' : 'ok';
  return <div className={`m-result ${cls}`}>{r.kind === 'ok' && <Ico d={ICO.check} size={16} />}<span>{r.msg}</span></div>;
}

function EnvForm() {
  const [items, setItems] = useState<Row[] | null>(null);
  const [itemId, setItemId] = useState('');
  const [date, setDate] = useState(today());
  const [value, setValue] = useState('');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<{ kind: 'ok' | 'queued' | 'err'; msg: string } | null>(null);

  useEffect(() => { api<Row[]>('/monitoring/items').then(rows => { setItems(rows); if (rows[0]) setItemId(s(rows[0].id)); }).catch(() => setItems([])); }, []);
  const item = (items ?? []).find(r => s(r.id) === itemId);

  async function save() {
    if (!itemId) { setRes({ kind: 'err', msg: 'Select a monitoring item.' }); return; }
    if (value === '') { setRes({ kind: 'err', msg: 'Enter a reading value.' }); return; }
    setBusy(true); setRes(null);
    try {
      const out = await submit(`/monitoring/items/${itemId}/readings`, { readingDate: date, value, comment }, `Reading · ${s(item?.name)}`);
      if (out.queued) setRes({ kind: 'queued', msg: 'Saved offline — will submit automatically when back online.' });
      else {
        const st = s((out.data as { status?: string })?.status || 'recorded');
        setRes({ kind: 'ok', msg: `Reading recorded (${st}).` });
        setValue(''); setComment('');
      }
    } catch (e) { setRes({ kind: 'err', msg: (e as Error).message }); } finally { setBusy(false); }
  }

  if (items === null) return <p className="m-empty">Loading monitoring items…</p>;
  if (items.length === 0) return <p className="m-empty">No monitoring items are available on the Host.</p>;

  return (
    <div className="m-form">
      <Field label="Monitoring item">
        <select value={itemId} onChange={e => setItemId(e.target.value)}>
          {items.map(r => <option key={s(r.id)} value={s(r.id)}>{s(r.name)}{r.unit ? ` (${s(r.unit)})` : ''}</option>)}
        </select>
      </Field>
      {item && (item.lower_limit != null || item.upper_limit != null) && (
        <div className="m-limits">Acceptable range: {s(item.lower_limit)}–{s(item.upper_limit)} {s(item.unit)}</div>
      )}
      <Field label="Date"><input type="date" value={date} onChange={e => setDate(e.target.value)} /></Field>
      <Field label={`Value${item?.unit ? ' (' + s(item.unit) + ')' : ''}`}><input type="number" inputMode="decimal" step="any" value={value} onChange={e => setValue(e.target.value)} /></Field>
      <Field label="Comment" hint="Required if the reading is out of range."><textarea rows={2} value={comment} onChange={e => setComment(e.target.value)} /></Field>
      <button className="m-btn primary block" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Record reading'}</button>
      <Result r={res} />
    </div>
  );
}

function EquipmentForm({ mode: initialMode }: { mode: 'maintenance' | 'breakdown' }) {
  const [items, setItems] = useState<Row[] | null>(null);
  const [eqId, setEqId] = useState('');
  const [mode, setMode] = useState<'maintenance' | 'breakdown'>(initialMode);
  const [date, setDate] = useState(today());
  const [mType, setMType] = useState('routine');
  const [findings, setFindings] = useState('');
  const [actionTaken, setActionTaken] = useState('');
  const [description, setDescription] = useState('');
  const [impact, setImpact] = useState('');
  const [immediate, setImmediate] = useState('');
  const [eqStatus, setEqStatus] = useState('out_of_service');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<{ kind: 'ok' | 'queued' | 'err'; msg: string } | null>(null);

  useEffect(() => { api<Row[]>('/equipment').then(rows => { setItems(rows); if (rows[0]) setEqId(s(rows[0].id)); }).catch(() => setItems([])); }, []);
  const eq = (items ?? []).find(r => s(r.id) === eqId);
  const eqName = (r?: Row) => s(r?.name || r?.equipment_number || r?.asset_number || r?.id);

  async function save() {
    if (!eqId) { setRes({ kind: 'err', msg: 'Select an equipment item.' }); return; }
    if (mode === 'breakdown' && !description.trim()) { setRes({ kind: 'err', msg: 'Describe the breakdown.' }); return; }
    setBusy(true); setRes(null);
    try {
      const out = mode === 'maintenance'
        ? await submit(`/equipment/${eqId}/maintenance`, { maintenanceDate: date, maintenanceType: mType, findings, actionTaken }, `Maintenance · ${eqName(eq)}`)
        : await submit(`/equipment/${eqId}/breakdown`, { breakdownDate: date, description, serviceImpact: impact, immediateAction: immediate, equipmentStatus: eqStatus }, `Breakdown · ${eqName(eq)}`);
      if (out.queued) setRes({ kind: 'queued', msg: 'Saved offline — will submit automatically when back online.' });
      else {
        setRes({ kind: 'ok', msg: mode === 'maintenance' ? 'Maintenance logged.' : 'Breakdown reported. Equipment status updated.' });
        setFindings(''); setActionTaken(''); setDescription(''); setImpact(''); setImmediate('');
      }
    } catch (e) { setRes({ kind: 'err', msg: (e as Error).message }); } finally { setBusy(false); }
  }

  if (items === null) return <p className="m-empty">Loading equipment…</p>;
  if (items.length === 0) return <p className="m-empty">No equipment is available on the Host.</p>;

  return (
    <div className="m-form">
      <div className="m-seg">
        <button className={mode === 'maintenance' ? 'active' : ''} onClick={() => setMode('maintenance')}>Maintenance</button>
        <button className={mode === 'breakdown' ? 'active' : ''} onClick={() => setMode('breakdown')}>Breakdown</button>
      </div>
      <Field label="Equipment">
        <select value={eqId} onChange={e => setEqId(e.target.value)}>
          {items.map(r => <option key={s(r.id)} value={s(r.id)}>{eqName(r)}</option>)}
        </select>
      </Field>
      <Field label="Date"><input type="date" value={date} onChange={e => setDate(e.target.value)} /></Field>
      {mode === 'maintenance' ? <>
        <Field label="Type">
          <select value={mType} onChange={e => setMType(e.target.value)}>
            <option value="routine">Routine</option><option value="preventive">Preventive</option><option value="corrective">Corrective</option>
          </select>
        </Field>
        <Field label="Findings"><textarea rows={2} value={findings} onChange={e => setFindings(e.target.value)} /></Field>
        <Field label="Action taken"><textarea rows={2} value={actionTaken} onChange={e => setActionTaken(e.target.value)} /></Field>
      </> : <>
        <Field label="Description"><textarea rows={2} value={description} onChange={e => setDescription(e.target.value)} /></Field>
        <Field label="Service impact"><input value={impact} onChange={e => setImpact(e.target.value)} /></Field>
        <Field label="Immediate action"><input value={immediate} onChange={e => setImmediate(e.target.value)} /></Field>
        <Field label="Equipment status">
          <select value={eqStatus} onChange={e => setEqStatus(e.target.value)}>
            <option value="out_of_service">Out of service</option><option value="under_repair">Under repair</option><option value="restricted_use">Restricted use</option>
          </select>
        </Field>
      </>}
      <button className="m-btn primary block" disabled={busy} onClick={save}>{busy ? 'Saving…' : mode === 'maintenance' ? 'Log maintenance' : 'Report breakdown'}</button>
      <Result r={res} />
    </div>
  );
}
