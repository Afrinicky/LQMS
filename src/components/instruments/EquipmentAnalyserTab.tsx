import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle, Cable, DownloadCloud, Loader2, Radio, Settings2, ShieldCheck,
} from 'lucide-react';
import { api, apiRead, errorText } from '../../services/api';
import { usePermissions } from '../../hooks/usePermissions';
import { Notice } from '../ui/Feedback';
import {
  LINK_STATE_LABELS, LINK_MODE_LABELS, LINK_PROTOCOL_LABELS, modeIsPassive,
} from '../../../shared/constants/instruments';
import type { EquipmentItem } from '../../../shared/types/api';

/**
 * Analyser transmission, seen from the equipment that does it.
 *
 * Everything about a link lived in one place — the last tab of the IQC
 * workspace — so the person who actually deals with the instrument, in
 * Equipment Management, had no way to find out whether it was transmitting.
 * "Is the Sysmex sending?" is an equipment question long before it is a quality
 * control one: it is asked when a machine has been moved, when its PC has been
 * rebuilt, and when somebody is deciding whether a missing result is the
 * analyser's fault or the bridge's.
 *
 * This is read-only on purpose. Configuring a link is administration and lives
 * in Settings; what belongs here is the answer, the last thing that arrived,
 * and a button to go and look now — which is the one action a person standing
 * at the instrument actually wants.
 */

type LinkRow = {
  id: number; name: string; link_code: string; equipment_id: number | null;
  role: string; mode: string; protocol: string; state: string; state_detail: string | null;
  listen_host: string | null; listen_port: number | null;
  remote_host: string | null; remote_port: number | null;
  watch_path: string | null; tap_path: string | null;
  last_message_at: string | null; last_connected_at: string | null; last_error: string | null;
  last_fetch_at: string | null; last_fetch_note: string | null;
  message_count: number; control_count: number; forward_pending: number;
  forward_enabled: number; fetch_enabled: number; running: boolean;
};

const CAN_FETCH = (mode: string) => mode === 'file_drop' || mode === 'lhims_tap';

export default function EquipmentAnalyserTab({ equipment }: { equipment: EquipmentItem[] }) {
  const { can } = usePermissions();
  const canConfigure = can('iqc', 'edit');
  const [links, setLinks] = useState<LinkRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [messages, setMessages] = useState<Record<number, Array<Record<string, any>>>>({});

  const load = useCallback(async () => {
    setLinks(await apiRead<LinkRow[]>('/instrument-links', []));
  }, []);
  useEffect(() => { void load(); }, [load]);
  // An analyser connects, or sends, without anything happening on this page.
  useEffect(() => {
    const timer = setInterval(() => { void load(); }, 20_000);
    return () => clearInterval(timer);
  }, [load]);

  async function fetchNow(row: LinkRow) {
    setBusy(row.id); setError(null); setNotice(null);
    try {
      const answer = await api<{ ok: boolean; note: string }>(`/instrument-links/${row.id}/fetch`, { method: 'POST' });
      if (answer.ok) setNotice(`${row.name}: ${answer.note}`); else setError(`${row.name}: ${answer.note}`);
      await load();
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(null); }
  }

  async function showMessages(row: LinkRow) {
    if (messages[row.id]) { setMessages(m => { const next = { ...m }; delete next[row.id]; return next; }); return; }
    try {
      const rows = await apiRead<Array<Record<string, any>>>(`/instrument-links/${row.id}/messages`, []);
      setMessages(m => ({ ...m, [row.id]: rows.slice(0, 10) }));
    } catch (e) { setError(errorText(e)); }
  }

  if (!links) return <div className="card"><p className="muted"><Loader2 size={14} className="spin" /> Loading…</p></div>;

  const withLink = new Set(links.map(l => l.equipment_id).filter(Boolean) as number[]);
  // Only instruments that could sensibly transmit. Listing the fridges under
  // "no link configured" would bury the two analysers that genuinely have none.
  const unlinked = equipment.filter(item => !withLink.has(item.id));

  return (
    <div>
      {error && <Notice kind="error">{error}</Notice>}
      {notice && <Notice kind="success">{notice}</Notice>}

      <div className="card">
        <div className="pp-head">
          <div>
            <h3><Cable size={16} /> Analyser transmission</h3>
            <p>
              Which of these instruments send their results straight into SECHLIMS, and what has arrived. Control
              runs go to the IQC board for the bench to accept; patient results can be carried on to LHIMS for the
              analysers its own middleware never covered.
            </p>
          </div>
          {canConfigure && (
            <Link className="pq-link" to="/settings/analysers"><Settings2 size={13} /> Set up links</Link>
          )}
        </div>

        <div className="il-safety">
          <ShieldCheck size={15} />
          <div>
            <strong>A transmission that already works is never touched.</strong>
            <p>
              An analyser whose link belongs to the LHIMS middleware is recorded here so the system knows to stay
              away from it — SECHLIMS will not bind its port or dial it, and says so rather than trying. That
              analyser still reaches SECHLIMS, by reading the middleware&rsquo;s own log file, which cannot affect
              the connection either way.
            </p>
          </div>
        </div>

        {links.length === 0 ? (
          <p className="muted">
            No analyser is connected yet. {canConfigure
              ? <>Start with an instrument that is not transmitting anywhere today — that costs the existing
                  arrangement nothing. <Link to="/settings/analysers">Set one up</Link>.</>
              : 'Ask whoever administers the system to set one up.'}
          </p>
        ) : (
          <ul className="il-list">
            {links.map(row => {
              const item = equipment.find(e => e.id === row.equipment_id);
              const tone = row.state === 'connected' || row.state === 'listening' || row.state === 'following' ? 'ok'
                : row.state === 'blocked' ? 'lhims' : row.state === 'error' ? 'crit' : 'idle';
              const shown = messages[row.id];
              return (
                <li key={row.id} className={`il-row t-${tone}`}>
                  <span className={`il-rail ${tone}`} />
                  <div className="il-main">
                    <span className="il-name">
                      {item ? `${item.equipment_number} — ${item.name}` : row.name}
                      <span className={`il-state s-${row.state}`}>
                        {row.state === 'connected' && <Radio size={10} />}
                        {LINK_STATE_LABELS[row.state as keyof typeof LINK_STATE_LABELS] ?? row.state}
                      </span>
                      {row.role === 'lhims_owned' && <span className="badge">LHIMS owns this</span>}
                      {modeIsPassive(row.mode) && <span className="badge">read-only copy</span>}
                      {Boolean(row.forward_enabled) && <span className="badge">carries to LHIMS</span>}
                    </span>
                    <span className="il-meta">
                      <span>{LINK_MODE_LABELS[row.mode as keyof typeof LINK_MODE_LABELS] ?? row.mode}</span>
                      <span>{LINK_PROTOCOL_LABELS[row.protocol as keyof typeof LINK_PROTOCOL_LABELS]?.split('(')[0].trim() ?? row.protocol}</span>
                      <span>{row.message_count} message{row.message_count === 1 ? '' : 's'}</span>
                      {row.control_count > 0 && <span>{row.control_count} control run{row.control_count === 1 ? '' : 's'}</span>}
                      <span>{row.last_message_at
                        ? `last heard ${String(row.last_message_at).slice(0, 16).replace('T', ' ')}`
                        : 'nothing received yet'}</span>
                      {row.forward_pending > 0 && <span className="warn">{row.forward_pending} waiting for LHIMS</span>}
                    </span>
                    {row.state_detail && <p className={`il-detail${row.state === 'error' ? ' is-error' : ''}`}>{row.state_detail}</p>}
                    {row.last_fetch_note && <p className="il-detail is-fetch">{row.last_fetch_note}</p>}

                    {shown && (
                      shown.length === 0
                        ? <p className="il-detail">This link has not recorded anything yet.</p>
                        : <ul className="il-messages">
                            {shown.map(m => (
                              <li key={m.id}>
                                <span className="il-msg-head">
                                  <span className={`badge ${m.kind === 'control' ? 'pending' : m.kind === 'patient' ? 'done' : ''}`}>{m.kind}</span>
                                  <span>{String(m.received_at ?? '').slice(0, 16).replace('T', ' ')}</span>
                                  <span>{m.sample_id || 'no sample id'}</span>
                                  <span>{m.result_count} result{m.result_count === 1 ? '' : 's'}</span>
                                </span>
                              </li>
                            ))}
                          </ul>
                    )}
                  </div>
                  <div className="il-side">
                    {CAN_FETCH(row.mode) && row.role !== 'lhims_owned' && (
                      <button type="button" className="pq-link" disabled={busy === row.id} onClick={() => void fetchNow(row)}>
                        {busy === row.id ? <Loader2 size={12} className="pd-spin" /> : <DownloadCloud size={12} />} Fetch
                      </button>
                    )}
                    <button type="button" className="pq-link" onClick={() => void showMessages(row)}>
                      {shown ? 'Hide' : 'Recent'}
                    </button>
                    {canConfigure && <Link className="pq-link" to="/settings/analysers">Settings</Link>}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {unlinked.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <h4>Instruments with no link</h4>
          <p className="muted">
            Results from these are entered by hand. An analyser that speaks TCP/IP and transmits nowhere today is
            the safe one to connect next — nothing existing is affected by taking it.
          </p>
          <ul className="il-unlinked">
            {unlinked.map(item => (
              <li key={item.id}>
                <strong>{item.equipment_number}</strong> {item.name}
                {item.manufacturer && <span className="muted"> · {item.manufacturer}</span>}
              </li>
            ))}
          </ul>
          {!canConfigure && (
            <p className="il-detail"><AlertTriangle size={12} /> Setting up a link needs quality-control edit rights.</p>
          )}
        </div>
      )}
    </div>
  );
}
