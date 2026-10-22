import { useCallback, useEffect, useState } from 'react';
import { Loader2, Lock, Radar, ShieldCheck } from 'lucide-react';
import { api, apiRead, errorText } from '../../services/api';
import { Facts, Field, Note, Panel, when, type SectionProps } from './shared';

/**
 * Analyser Discovery.
 *
 * Scope-limited by design: the laboratory's own private network, one subnet at
 * a time, a named list of ports, and never a protected endpoint. A connect to
 * the port the LHIMS middleware is using is exactly the disturbance this module
 * exists to avoid, so those addresses are skipped and the scan says how many.
 *
 * What comes back is an open port and, where the endpoint identified itself, a
 * guess with a confidence attached. It becomes a proposal, not a connection:
 * an analyser that only ever receives connections will not answer a scan at
 * all, and that is stated rather than left to be discovered the hard way.
 */
type Scan = {
  id: number; scan_code: string; target: string; ports: string;
  started_at: string; finished_at: string | null;
  hosts_scanned: number; endpoints_found: number; protected_skipped: number;
  status: string; note: string | null; scanned_by: string | null;
};

type Endpoint = {
  id: number; host: string; port: number; latency_ms: number | null;
  banner: string | null; protocol_guess: string | null; profile_guess: string | null;
  confidence: string; conflict: string; note: string | null; state: string;
  proposal: Record<string, unknown> | null;
};

export default function MiddlewareDiscovery({ reference, canDiscover, onError, onNotice, onOpen }: SectionProps) {
  const [scans, setScans] = useState<Scan[]>([]);
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [target, setTarget] = useState('');
  const [ports, setPorts] = useState('');
  const [running, setRunning] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);

  const load = useCallback(async () => {
    const data = await apiRead<{ scans: Scan[]; latest: Endpoint[] }>('/middleware/discovery', { scans: [], latest: [] });
    setScans(data.scans);
    setEndpoints(data.latest);
    setSelected(data.scans.length ? data.scans[0].id : null);
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function openScan(id: number) {
    setSelected(id);
    try {
      const data = await api<{ scan: Scan; endpoints: Endpoint[] }>(`/middleware/discovery/${id}`);
      setEndpoints(data.endpoints);
    } catch (e) { onError(errorText(e)); }
  }

  async function scan() {
    if (!target.trim()) { onError('Give an address or a range, for example 192.168.1.0/24.'); return; }
    setRunning(true); onError(null);
    try {
      const outcome = await api<{ note: string; scanId: number }>('/middleware/discovery', {
        method: 'POST',
        body: JSON.stringify({
          target: target.trim(),
          ports: ports.trim() ? ports.split(',').map(p => Number(p.trim())).filter(Boolean) : null,
        }),
      });
      onNotice(outcome.note);
      await load();
    } catch (e) { onError(errorText(e)); }
    finally { setRunning(false); }
  }

  const current = scans.find(s => s.id === selected) ?? null;

  return (
    <>
      <Panel
        title="Scan the laboratory network"
        subtitle="Private ranges only, /24 at widest, 256 addresses at most. Protected endpoints are never probed."
      >
        {!canDiscover ? (
          <Note>You do not hold the right to scan the network. The results of previous scans are below.</Note>
        ) : (
          <div className="mw-grid">
            <Field label="Address or range" value={target} onValue={setTarget} placeholder="192.168.1.0/24" />
            <Field
              label="Ports"
              value={ports}
              onValue={setPorts}
              placeholder={(reference?.discoveryPorts ?? []).join(', ')}
              hint="Leave blank for the usual analyser interface ports."
            />
            <div className="mw-actions">
              <button type="button" className="btn" disabled={running} onClick={() => void scan()}>
                {running ? <Loader2 size={13} className="pd-spin" /> : <Radar size={13} />} Scan
              </button>
            </div>
          </div>
        )}
        <Note>
          <ShieldCheck size={12} /> A scan opens one TCP connection per address and port and closes it. It writes
          nothing, configures nothing and is recorded against whoever ran it.
        </Note>
      </Panel>

      <div className="mw-grid-2">
        <Panel title="Scans" subtitle="Newest first.">
          {!scans.length ? <Note>No scan has been run.</Note> : (
            <ul className="mw-list">
              {scans.map(entry => (
                <li key={entry.id} className={entry.id === selected ? 'is-selected' : ''}>
                  <button type="button" className="mw-list-button" onClick={() => void openScan(entry.id)}>
                    <span className="mw-list-main">
                      <strong>{entry.target}</strong>
                      <span className="mw-sub">
                        {when(entry.started_at)} · {entry.endpoints_found} found of {entry.hosts_scanned} address(es)
                        {entry.protected_skipped ? ` · ${entry.protected_skipped} protected skipped` : ''}
                        {entry.scanned_by ? ` · ${entry.scanned_by}` : ''}
                      </span>
                    </span>
                    <span className={`mw-chip t-${entry.status === 'complete' ? 'ok' : 'info'}`}>{entry.status}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel
          title="Endpoints found"
          subtitle={current ? `${current.target} · ports ${current.ports}` : 'Select a scan.'}
        >
          {current?.protected_skipped ? (
            <Note tone="warn">
              <Lock size={12} /> {current.protected_skipped} address(es) were skipped because they belong to a live
              production transmission. They are not probed from here.
            </Note>
          ) : null}
          {!endpoints.length ? (
            <Note>
              Nothing answered. An analyser configured to transmit to a host, rather than to accept connections, does
              not answer a scan — configure it by hand in Connection Setup.
            </Note>
          ) : (
            <table className="data-table mw-table">
              <thead>
                <tr><th>Endpoint</th><th>Protocol</th><th>Looks like</th><th>Confidence</th><th /></tr>
              </thead>
              <tbody>
                {endpoints.map(endpoint => {
                  const profile = reference?.profiles.find(p => p.key === endpoint.profile_guess);
                  return (
                    <tr key={endpoint.id}>
                      <td className="mono">
                        {endpoint.host}:{endpoint.port}
                        {endpoint.latency_ms != null && <span className="mw-sub"> {endpoint.latency_ms} ms</span>}
                      </td>
                      <td>{endpoint.protocol_guess ? endpoint.protocol_guess.toUpperCase() : '—'}</td>
                      <td>{profile?.label ?? '—'}</td>
                      <td>
                        <span className={`mw-chip t-${endpoint.confidence === 'high' ? 'ok' : endpoint.confidence === 'medium' ? 'warn' : 'idle'}`}>
                          {endpoint.confidence}
                        </span>
                        {endpoint.conflict === 'in_use' && <span className="mw-chip t-info">already configured</span>}
                        {endpoint.conflict === 'protected' && <span className="mw-chip t-lock">protected</span>}
                      </td>
                      <td>
                        <button type="button" className="pq-link" onClick={() => onOpen?.('Connection Setup')}>Set up</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {endpoints.length > 0 && (
            <>
              {endpoints.filter(e => e.note).slice(0, 4).map(endpoint => (
                <Note key={endpoint.id}><strong className="mono">{endpoint.host}:{endpoint.port}</strong> {endpoint.note}</Note>
              ))}
              <Facts items={[
                { label: 'Needs a person', value: 'Protocol confirmed in the analyser’s service menu, a test message exchanged, and approval before activation.' },
              ]} />
            </>
          )}
        </Panel>
      </div>
    </>
  );
}
