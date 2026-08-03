/**
 * SOP / controlled-document acknowledgement (M4). Lists the controlled documents
 * awaiting the signed-in staff member's attestation and lets them acknowledge each
 * personally. Attestations are signed by the caller only — the Host enforces
 * ownership — so this posts /documents/:docId/attest with the attestation id.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../src/services/api';
import type { ApiUser } from '../shared/types/api';
import { Back, Ico, ICO, s } from './ui';

type Row = Record<string, unknown>;

export function DocumentsScreen({ user, onBack }: { user: ApiUser; onBack: () => void }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<Record<string, string>>({});

  const load = useCallback(() => {
    setErr(null);
    const q = user.staffId ? `?staffId=${user.staffId}` : '';
    api<Row[]>(`/documents/attestations/pending${q}`).then(setRows).catch(e => { setRows([]); setErr((e as Error).message); });
  }, [user.staffId]);
  useEffect(() => { load(); }, [load]);

  async function ack(row: Row) {
    const aid = s(row.id);
    const docId = s(row.doc_id || row.document_id);
    setMsg(m => ({ ...m, [aid]: 'Signing…' }));
    try {
      await api(`/documents/${docId}/attest`, { method: 'POST', body: JSON.stringify({ attestationId: Number(row.id) }) });
      setRows(rs => (rs ?? []).filter(r => s(r.id) !== aid));
    } catch (e) { setMsg(m => ({ ...m, [aid]: (e as Error).message })); }
  }

  return (
    <div className="m-screen">
      <Back onBack={onBack} />
      <div className="m-screen-h">Documents to acknowledge</div>
      {!user.staffId && <p className="m-empty">Your login isn’t linked to a staff record, so attestations can’t be signed. Ask your administrator to link your account.</p>}
      {err && <p className="m-err">{err}</p>}
      {rows === null && !err && <p className="m-empty">Loading…</p>}
      {rows && rows.length === 0 && user.staffId && <p className="m-empty">Nothing awaiting your acknowledgement. ✅</p>}
      <div className="m-list">
        {(rows ?? []).map(r => {
          const aid = s(r.id);
          const overdue = s(r.status).toLowerCase() === 'overdue';
          return (
            <div className="m-item" key={aid}>
              <span className="m-item-ic"><Ico d={ICO.doc} size={18} /></span>
              <div className="m-item-body">
                <div className="m-item-title">{s(r.title)}</div>
                <div className="m-item-meta">
                  {r.document_code && <span className="m-chip">{s(r.document_code)}</span>}
                  {r.version_number && <span className="m-chip">v{s(r.version_number)}</span>}
                  {overdue && <span className="m-tag danger">Overdue</span>}
                  {r.due_date && !overdue && <span className="m-due">Due {s(r.due_date)}</span>}
                </div>
                <div className="m-ackrow">
                  <button className="m-btn primary small" onClick={() => ack(r)} disabled={!user.staffId}>Acknowledge</button>
                  {msg[aid] && <span className="m-fieldhint">{msg[aid]}</span>}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
