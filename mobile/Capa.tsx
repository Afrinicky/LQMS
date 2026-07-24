/**
 * CAPA (corrective / preventive actions) on mobile: view open CAPAs and post a
 * progress update against one, through the offline-aware submit(). Full CAPA
 * authoring stays on the desktop; this covers the on-the-go "record progress"
 * duty. Updates go to /capa/:id/add-update.
 */
import { useEffect, useState } from 'react';
import { api } from '../src/services/api';
import { submit } from './net';
import { Back, s, type Msg } from './ui';

type Row = Record<string, unknown>;

const CLOSED = ['closed', 'verified', 'completed', 'effective', 'cancelled'];

export function CapaScreen({ onBack }: { onBack: () => void }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = () => api<Row[]>('/capa').then(setRows).catch(e => { setRows([]); setErr((e as Error).message); });
  useEffect(() => { load(); }, []);

  const open = (rows ?? []).filter(r => !CLOSED.includes(s(r.status).toLowerCase()));

  return (
    <div className="m-screen">
      <Back onBack={onBack} />
      <div className="m-screen-h">CAPA</div>
      {err && <p className="m-err">{err}</p>}
      {rows === null && !err && <p className="m-empty">Loading…</p>}
      {rows && open.length === 0 && !err && <p className="m-empty">No open CAPAs. ✅</p>}
      <div className="m-list">
        {open.map(r => <CapaCard key={s(r.id)} r={r} />)}
      </div>
    </div>
  );
}

function CapaCard({ r }: { r: Row }) {
  const [openForm, setOpenForm] = useState(false);
  const [text, setText] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const title = s(r.title || r.description || r.action_description) || `CAPA ${s(r.capa_number || r.id)}`;

  async function save() {
    if (!text.trim()) { setMsg({ kind: 'err', msg: 'Enter an update.' }); return; }
    setBusy(true); setMsg(null);
    try {
      const body: Record<string, unknown> = { updateText: text };
      if (status) body.status = status;
      const out = await submit(`/capa/${s(r.id)}/add-update`, body, `CAPA update · ${s(r.capa_number || r.id)}`);
      setMsg(out.queued ? { kind: 'queued', msg: 'Saved offline — will submit when back online.' } : { kind: 'ok', msg: 'Update posted.' });
      if (!out.queued) { setText(''); }
    } catch (e) { setMsg({ kind: 'err', msg: (e as Error).message }); } finally { setBusy(false); }
  }

  return (
    <div className="m-req">
      <div className="m-req-title">{title}</div>
      <div className="m-item-meta">
        {r.capa_number ? <span className="m-chip">{s(r.capa_number)}</span> : null}
        {r.status ? <span className="m-tag warn">{s(r.status)}</span> : null}
        {r.due_date ? <span className="m-due">Due {s(r.due_date)}</span> : null}
      </div>
      {!openForm ? (
        <button className="m-btn ghost small" onClick={() => setOpenForm(true)} style={{ marginTop: 10 }}>Add progress update</button>
      ) : (
        <div className="m-form" style={{ marginTop: 10 }}>
          <textarea rows={2} placeholder="Progress / action taken" value={text} onChange={e => setText(e.target.value)} />
          <select value={status} onChange={e => setStatus(e.target.value)}>
            <option value="">Keep current status</option>
            <option value="in_progress">In progress</option>
            <option value="implemented">Implemented</option>
            <option value="pending_verification">Pending verification</option>
          </select>
          <div className="m-ackrow">
            <button className="m-btn primary small" disabled={busy} onClick={save}>{busy ? 'Posting…' : 'Post update'}</button>
            <button className="m-btn ghost small" onClick={() => setOpenForm(false)}>Cancel</button>
          </div>
          {msg && <div className={`m-result ${msg.kind}`}><span>{msg.msg}</span></div>}
        </div>
      )}
    </div>
  );
}
