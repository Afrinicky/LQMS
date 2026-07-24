/**
 * Field-capture screens for the mobile companion: environmental readings,
 * equipment maintenance / breakdown (M2), and safety incident reports (M3).
 * Each posts directly to the existing Host endpoints through the offline-aware
 * submit() (see net.ts). Attribution is taken from the signed-in account
 * server-side.
 */
import { useEffect, useState } from 'react';
import { api } from '../src/services/api';
import { submit } from './net';
import { Back, Field, Result, today, s, type Msg } from './ui';

export type CaptureKey = 'env' | 'equip:maintenance' | 'equip:breakdown' | 'safety';

type Row = Record<string, unknown>;

export function CaptureScreen({ capture, onBack }: { capture: CaptureKey; onBack: () => void }) {
  const title = capture === 'env' ? 'Environmental reading'
    : capture === 'equip:breakdown' ? 'Report breakdown'
    : capture === 'safety' ? 'Report safety incident'
    : 'Equipment maintenance';
  return (
    <div className="m-screen">
      <Back onBack={onBack} />
      <div className="m-screen-h">{title}</div>
      {capture === 'env' ? <EnvForm />
        : capture === 'safety' ? <SafetyForm />
        : <EquipmentForm mode={capture === 'equip:breakdown' ? 'breakdown' : 'maintenance'} />}
    </div>
  );
}

function EnvForm() {
  const [items, setItems] = useState<Row[] | null>(null);
  const [itemId, setItemId] = useState('');
  const [date, setDate] = useState(today());
  const [value, setValue] = useState('');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Msg>(null);

  useEffect(() => { api<Row[]>('/monitoring/items').then(rows => { setItems(rows); if (rows[0]) setItemId(s(rows[0].id)); }).catch(() => setItems([])); }, []);
  const item = (items ?? []).find(r => s(r.id) === itemId);

  async function save() {
    if (!itemId) { setRes({ kind: 'err', msg: 'Select a monitoring item.' }); return; }
    if (value === '') { setRes({ kind: 'err', msg: 'Enter a reading value.' }); return; }
    setBusy(true); setRes(null);
    try {
      const out = await submit(`/monitoring/items/${itemId}/readings`, { readingDate: date, value, comment }, `Reading · ${s(item?.name)}`);
      if (out.queued) setRes({ kind: 'queued', msg: 'Saved offline — will submit automatically when back online.' });
      else { const st = s((out.data as { status?: string })?.status || 'recorded'); setRes({ kind: 'ok', msg: `Reading recorded (${st}).` }); setValue(''); setComment(''); }
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
  const [res, setRes] = useState<Msg>(null);

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
      else { setRes({ kind: 'ok', msg: mode === 'maintenance' ? 'Maintenance logged.' : 'Breakdown reported. Equipment status updated.' }); setFindings(''); setActionTaken(''); setDescription(''); setImpact(''); setImmediate(''); }
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

function SafetyForm() {
  const [date, setDate] = useState(today());
  const [category, setCategory] = useState('Needlestick / sharps');
  const [severity, setSeverity] = useState('Medium');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [immediate, setImmediate] = useState('');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Msg>(null);

  async function save() {
    if (!description.trim() && !title.trim()) { setRes({ kind: 'err', msg: 'Enter a description of what happened.' }); return; }
    setBusy(true); setRes(null);
    try {
      const out = await submit('/facilities-safety/incidents',
        { incidentDate: date, title, description, severity, category, immediateAction: immediate }, `Safety · ${category}`);
      if (out.queued) setRes({ kind: 'queued', msg: 'Saved offline — will submit automatically when back online.' });
      else { const no = s((out.data as { incidentNumber?: string })?.incidentNumber || ''); setRes({ kind: 'ok', msg: `Incident reported${no ? ' (' + no + ')' : ''}.` }); setTitle(''); setDescription(''); setImmediate(''); }
    } catch (e) { setRes({ kind: 'err', msg: (e as Error).message }); } finally { setBusy(false); }
  }

  return (
    <div className="m-form">
      <Field label="Date"><input type="date" value={date} onChange={e => setDate(e.target.value)} /></Field>
      <Field label="Category">
        <select value={category} onChange={e => setCategory(e.target.value)}>
          {['Needlestick / sharps', 'Chemical spill', 'Biological exposure', 'Slip / trip / fall', 'Fire / electrical', 'Equipment injury', 'Other'].map(c => <option key={c}>{c}</option>)}
        </select>
      </Field>
      <Field label="Severity">
        <select value={severity} onChange={e => setSeverity(e.target.value)}>
          {['Low', 'Medium', 'High', 'Critical'].map(c => <option key={c}>{c}</option>)}
        </select>
      </Field>
      <Field label="Short title"><input value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Needlestick in phlebotomy" /></Field>
      <Field label="What happened"><textarea rows={3} value={description} onChange={e => setDescription(e.target.value)} /></Field>
      <Field label="Immediate action taken"><textarea rows={2} value={immediate} onChange={e => setImmediate(e.target.value)} /></Field>
      <button className="m-btn primary block" disabled={busy} onClick={save}>{busy ? 'Reporting…' : 'Report incident'}</button>
      <Result r={res} />
    </div>
  );
}
