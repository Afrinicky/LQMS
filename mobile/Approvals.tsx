/**
 * Mobile approval workflows (Phase 2).
 *
 * A unified inbox of items awaiting the signed-in manager's decision, filtered
 * server-side by the same RBAC the desktop uses (leave, inventory requests, CAPA
 * verification, nonconformity review). Each decision — approve, reject or return
 * for correction — carries comments and an electronic signature, is timestamped
 * and lands in the audit trail; the requester is notified.
 */
import { useEffect, useState } from 'react';
import { api } from '../src/services/api';
import { Back, Ico, Result, s, type Msg } from './ui';
import { SignatureGate } from './SignatureOnFile';

type Row = Record<string, unknown>;
type Decision = 'approve' | 'reject' | 'return';

const P = {
  check: 'M20 6 9 17l-5-5',
  clock: 'M12 8v4l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z',
};

export function ApprovalsScreen({ onBack }: { onBack: () => void }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [active, setActive] = useState<Row | null>(null);

  function load() { setRows(null); api<Row[]>('/mobile/approvals').then(setRows).catch(e => setErr((e as Error).message)); }
  useEffect(load, []);

  if (active) return <DecisionScreen item={active} onBack={() => setActive(null)} onDone={() => { setActive(null); load(); }} />;

  return (
    <div className="m-screen">
      <Back onBack={onBack} />
      <div className="m-screen-h">Approvals</div>
      {err && <p className="m-err">{err}</p>}
      {rows === null && !err && <p className="m-empty">Loading approvals…</p>}
      {rows && rows.length === 0 && <p className="m-empty">Nothing awaiting your approval right now. ✅</p>}
      <div className="m-list">
        {(rows ?? []).map((r, i) => (
          <button key={i} className="m-item tappable" onClick={() => setActive(r)}>
            <span className="m-item-ic"><Ico d={P.clock} size={18} /></span>
            <div className="m-item-body">
              <div className="m-item-title">{s(r.title)}</div>
              <div className="m-item-meta">
                <span className="m-chip">{s(r.typeLabel)}</span>
                {r.requester_name ? <span className="m-due">by {s(r.requester_name)}</span> : null}
              </div>
            </div>
            <span className="m-chevron">›</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function DecisionScreen({ item, onBack, onDone }: { item: Row; onBack: () => void; onDone: () => void }) {
  const [decision, setDecision] = useState<Decision>('approve');
  const [comments, setComments] = useState('');
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Msg>(null);

  async function submitDecision() {
    setRes(null);
    if (decision !== 'approve' && !comments.trim()) { setRes({ kind: 'err', msg: 'Please add a comment explaining the decision.' }); return; }
    if (!ready) { setRes({ kind: 'err', msg: 'Upload your signature first — it is applied to this decision.' }); return; }
    setBusy(true);
    try {
      // The Host applies the signer's signature on file automatically.
      await api(`/mobile/approvals/${s(item.type)}/${s(item.id)}/decision`, {
        method: 'POST', body: JSON.stringify({ decision, comments }),
      });
      setRes({ kind: 'ok', msg: 'Decision recorded and signed.' });
      setTimeout(onDone, 700);
    } catch (e) { setRes({ kind: 'err', msg: (e as Error).message }); setBusy(false); }
  }

  const verbs: [Decision, string][] = [['approve', 'Approve'], ['return', 'Return'], ['reject', 'Reject']];
  return (
    <div className="m-screen">
      <Back onBack={onBack} />
      <div className="m-screen-h">{s(item.typeLabel)}</div>
      <div className="m-card" style={{ padding: 16 }}>
        <div className="m-req-title">{s(item.title)}</div>
        {item.requester_name ? <div className="m-me-role">Requested by {s(item.requester_name)}</div> : null}
      </div>

      <div className="m-section-h">Decision</div>
      <div className="m-seg3">
        {verbs.map(([v, lbl]) => (
          <button key={v} className={`${decision === v ? 'active ' + v : ''}`} onClick={() => setDecision(v)}>{lbl}</button>
        ))}
      </div>

      <div className="m-form">
        <label className="m-lbl">Comments{decision !== 'approve' ? ' (required)' : ' (optional)'}</label>
        <textarea rows={3} value={comments} onChange={e => setComments(e.target.value)} placeholder={decision === 'return' ? 'What needs correcting?' : decision === 'reject' ? 'Reason for rejection' : 'Any note (optional)'} />
        <label className="m-lbl">Electronic signature</label>
        <SignatureGate onReady={setReady} />
        <button className="m-btn primary block" disabled={busy} onClick={submitDecision}>
          <Ico d={P.check} size={18} /> {busy ? 'Recording…' : `Sign & ${decision === 'approve' ? 'approve' : decision === 'reject' ? 'reject' : 'return'}`}
        </button>
        <Result r={res} />
      </div>
    </div>
  );
}
