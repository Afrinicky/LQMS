/**
 * Connectivity, as something a facility configures rather than something it
 * is handed.
 *
 * This screen used to report two facts — the bind address and the port — and
 * present everything else as fixed: the addresses were detected, unlabelled
 * and read-only, and the only choice was between every interface and this
 * machine alone. A laboratory whose network did not happen to suit that could
 * do nothing about it, and a laboratory whose network broke was told that the
 * host was listening and every address was answering, which was true and
 * useless.
 *
 * So it is now a console. Each section is one decision an administrator makes,
 * stated in the order the decisions actually depend on each other, and the
 * last of them answers the question the old screen could not: if a bench
 * cannot reach this host, which layer is stopping it.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle, Check, CheckCircle2, Eye, EyeOff, Globe, Loader2, Lock,
  Pin, Plus, RefreshCw, ShieldCheck, Trash2, XCircle,
} from 'lucide-react';
import { api, errorText } from '../../services/api';
import TextField from '../ui/TextField';
import { Notice } from '../ui/Feedback';
import type { SystemConnectivity, ConnectivityFinding } from '../../../shared/types/api';

type AddressChoice = { address: string; label?: string; hidden?: boolean; primary?: boolean; manual?: boolean };

export default function ConnectivityConsole({ info, canEdit, onChanged }: {
  info: SystemConnectivity; canEdit: boolean; onChanged: () => void;
}) {
  const advanced = info.advanced;
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const [host, setHost] = useState(advanced?.host ?? '0.0.0.0');
  const [extraPorts, setExtraPorts] = useState((advanced?.extraPorts ?? []).join(', '));
  const [published, setPublished] = useState(advanced?.publishedAddress ?? '');
  const [tlsOn, setTlsOn] = useState(advanced?.tls.enabled ?? false);
  const [certFile, setCertFile] = useState(advanced?.tls.certFile ?? '');
  const [keyFile, setKeyFile] = useState(advanced?.tls.keyFile ?? '');
  const [newAddress, setNewAddress] = useState('');
  const [newLabel, setNewLabel] = useState('');

  const [findings, setFindings] = useState<ConnectivityFinding[] | null>(null);
  const [verdict, setVerdict] = useState<string | null>(null);

  useEffect(() => {
    setHost(advanced?.host ?? '0.0.0.0');
    setExtraPorts((advanced?.extraPorts ?? []).join(', '));
    setPublished(advanced?.publishedAddress ?? '');
    setTlsOn(advanced?.tls.enabled ?? false);
    setCertFile(advanced?.tls.certFile ?? '');
    setKeyFile(advanced?.tls.keyFile ?? '');
  }, [advanced]);

  const save = useCallback(async (patch: Record<string, unknown>, key: string) => {
    setBusy(key); setProblem(null); setNote(null);
    try {
      const r = await api<{ note: string }>('/system/connectivity/advanced',
        { method: 'PUT', body: JSON.stringify(patch) });
      setNote(r.note);
      onChanged();
    } catch (e) { setProblem(errorText(e)); }
    finally { setBusy(null); }
  }, [onChanged]);

  async function diagnose() {
    setBusy('diagnose'); setProblem(null);
    try {
      const r = await api<{ findings: ConnectivityFinding[]; verdict: string }>('/system/connectivity/diagnose');
      setFindings(r.findings);
      setVerdict(r.verdict);
    } catch (e) { setProblem(errorText(e)); }
    finally { setBusy(null); }
  }

  async function openFirewall() {
    setBusy('firewall'); setProblem(null); setNote(null);
    try {
      const r = await api<{ changed: string[] }>('/system/connectivity/firewall', { method: 'POST' });
      setNote(r.changed.length ? r.changed.join('. ') + '.' : 'The firewall already admitted this port.');
      onChanged();
      await diagnose();
    } catch (e) { setProblem(errorText(e)); }
    finally { setBusy(null); }
  }

  /** The address book, written back whole so one save cannot contradict another. */
  function writeAddresses(next: AddressChoice[]) {
    void save({ addresses: next }, 'addresses');
  }

  const choices: AddressChoice[] = advanced?.addresses ?? [];
  const choiceFor = (address: string) =>
    choices.find(c => c.address.toLowerCase() === address.toLowerCase()) ?? { address };

  function updateChoice(address: string, patch: Partial<AddressChoice>) {
    const rest = choices.filter(c => c.address.toLowerCase() !== address.toLowerCase());
    const merged = { ...choiceFor(address), ...patch, address };
    // One primary at most: pinning a second must unpin the first, or every
    // screen that shows "the address to use" picks whichever it read first.
    if (patch.primary) for (const other of rest) other.primary = false;
    writeAddresses([...rest, merged]);
  }

  const book = info.addressBook ?? [];
  const firewall = info.firewall;
  const visitors = info.visitors ?? [];
  const reachUrl = `${info.advanced?.tls.enabled ? 'https' : 'http'}://`
    + `${book.find(b => b.primary)?.address ?? book.find(b => b.kind === 'lan')?.address ?? info.api.host}`
    + `:${info.api.port}/api/system/reach`;

  const tone = (s: ConnectivityFinding['status']) =>
    s === 'ok' ? 'cx-ok' : s === 'fail' ? 'cx-fail' : s === 'warn' ? 'cx-warn' : 'cx-info';

  return (
    <div className="card cx-console">
      <div className="section-head"><h3>Network Configuration</h3></div>

      {note && <Notice kind="success">{note}</Notice>}
      {problem && <Notice kind="error">{problem}</Notice>}

      {info.bindFellBackFrom && (
        <Notice kind="warn" silent>
          This host was set to listen on <code>{info.bindFellBackFrom}</code>, which it no longer has. It is
          listening on every interface instead so that the laboratory stayed on the network. Choose an address
          below that this machine actually has.
        </Notice>
      )}

      {/* ---------------------------------------------------------------- */}
      <section className="cx-section">
        <h4>Listening Address</h4>
        <p className="hint">
          Which of this machine&rsquo;s network cards answers. A host with both a wired and a wireless card on the
          same network, or with a Mobile Hotspot adapter, can be held to one of them.
        </p>
        <div className="cx-field">
          <select value={host} onChange={e => setHost(e.target.value)} disabled={!canEdit}>
            <option value="0.0.0.0">Every interface on this machine</option>
            <option value="127.0.0.1">This computer only</option>
            {(info.interfaces ?? [])
              .filter(i => i.family === 'IPv4' && i.kind !== 'loopback')
              .map(i => (
                <option key={i.address} value={i.address}>
                  {i.address} — {i.name}{i.kind === 'hotspot' ? ' (Mobile Hotspot)' : i.kind === 'remote' ? ' (remote access)' : ''}
                </option>
              ))}
          </select>
          <button type="button" disabled={!canEdit || busy !== null || host === (advanced?.host ?? '')}
            onClick={() => void save({ host }, 'host')}>
            {busy === 'host' ? <Loader2 size={13} className="spin" /> : <Check size={13} />} Apply
          </button>
        </div>
        <span className="hint">Takes effect when this host is restarted.</span>
      </section>

      {/* ---------------------------------------------------------------- */}
      <section className="cx-section">
        <h4>Additional Ports</h4>
        <p className="hint">
          Further ports this host answers on, beside <code>{info.api.port}</code>. Separate several with commas.
          A port that cannot be taken is reported and skipped; it never prevents the host from starting.
        </p>
        <div className="cx-field">
          <TextField value={extraPorts} onValue={setExtraPorts} placeholder="8080, 9443" disabled={!canEdit} />
          <button type="button" disabled={!canEdit || busy !== null}
            onClick={() => void save({
              extraPorts: extraPorts.split(',').map(p => p.trim()).filter(Boolean).map(Number),
            }, 'extraPorts')}>
            {busy === 'extraPorts' ? <Loader2 size={13} className="spin" /> : <Check size={13} />} Apply
          </button>
        </div>
      </section>

      {/* ---------------------------------------------------------------- */}
      <section className="cx-section">
        <h4>Published Address</h4>
        <p className="hint">
          The address this laboratory tells people to use. A detected address changes when a lease changes or a
          cable moves, and every analyser and bench configured with the old one stops. A name the IT team controls
          does not.
        </p>
        <div className="cx-field">
          <TextField value={published} onValue={setPublished}
            placeholder="sechlims.hospital.local" disabled={!canEdit} />
          <button type="button" disabled={!canEdit || busy !== null}
            onClick={() => void save({ publishedAddress: published.trim() }, 'published')}>
            {busy === 'published' ? <Loader2 size={13} className="spin" /> : <Check size={13} />} Apply
          </button>
        </div>
      </section>

      {/* ---------------------------------------------------------------- */}
      <section className="cx-section">
        <h4>Transport Security</h4>
        <p className="hint">
          Serve the laboratory over <code>https</code> using a certificate already on this machine. If the
          certificate cannot be read at startup the host falls back to <code>http</code> and says why, rather than
          refusing to start.
        </p>
        <label className="cx-check">
          <input type="checkbox" checked={tlsOn} disabled={!canEdit}
            onChange={e => setTlsOn(e.target.checked)} />
          <span>Serve over https</span>
        </label>
        {tlsOn && (
          <div className="cx-grid">
            <label><span>Certificate file</span>
              <TextField value={certFile} onValue={setCertFile} placeholder="C:\\certs\\lab.crt" disabled={!canEdit} /></label>
            <label><span>Private key file</span>
              <TextField value={keyFile} onValue={setKeyFile} placeholder="C:\\certs\\lab.key" disabled={!canEdit} /></label>
          </div>
        )}
        <div className="cx-field">
          <button type="button" disabled={!canEdit || busy !== null}
            onClick={() => void save({ tls: { enabled: tlsOn, certFile: certFile.trim(), keyFile: keyFile.trim() } }, 'tls')}>
            {busy === 'tls' ? <Loader2 size={13} className="spin" /> : <Lock size={13} />} Apply
          </button>
        </div>
      </section>

      {/* ---------------------------------------------------------------- */}
      <section className="cx-section">
        <h4>Host Addresses</h4>
        <p className="hint">
          Every address this machine has, as this laboratory wants them presented. Rename one, hide an address that
          is not the laboratory network, and pin the one everybody should be given.
        </p>
        <table className="data-table cx-table">
          <thead>
            <tr><th>Address</th><th>Shown as</th><th>Adapter</th><th /></tr>
          </thead>
          <tbody>
            {book.map(entry => (
              <tr key={entry.address} className={entry.hidden ? 'cx-row-off' : undefined}>
                <td>
                  <code>{entry.address}</code>
                  {entry.primary && <span className="cx-chip cx-chip-primary">the one to use</span>}
                  {entry.manual && <span className="cx-chip">added here</span>}
                  {entry.note && <small className="cx-note">{entry.note}</small>}
                </td>
                <td>
                  <TextField value={entry.label} disabled={!canEdit}
                    onValue={v => updateChoice(entry.address, { label: v, manual: entry.manual })} />
                </td>
                <td className="hint">{entry.adapter || '—'}</td>
                <td className="cx-row-actions">
                  <button type="button" className="btn ghost" title={entry.primary ? 'Already the one to use' : 'Make this the one to use'}
                    disabled={!canEdit || busy !== null || entry.primary}
                    onClick={() => updateChoice(entry.address, { primary: true, manual: entry.manual })}>
                    <Pin size={12} />
                  </button>
                  <button type="button" className="btn ghost" title={entry.hidden ? 'Show this address' : 'Hide this address'}
                    disabled={!canEdit || busy !== null}
                    onClick={() => updateChoice(entry.address, { hidden: !entry.hidden, manual: entry.manual })}>
                    {entry.hidden ? <EyeOff size={12} /> : <Eye size={12} />}
                  </button>
                  {entry.manual && (
                    <button type="button" className="btn ghost cx-danger" title="Remove this address"
                      disabled={!canEdit || busy !== null}
                      onClick={() => writeAddresses(choices.filter(c => c.address.toLowerCase() !== entry.address.toLowerCase()))}>
                      <Trash2 size={12} />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {canEdit && (
          <div className="cx-field cx-add">
            <TextField value={newAddress} onValue={setNewAddress}
              placeholder="An address or name this machine cannot see — a proxy, or a DNS name" />
            <TextField value={newLabel} onValue={setNewLabel} placeholder="What to call it" />
            <button type="button" disabled={busy !== null || !newAddress.trim()}
              onClick={() => {
                writeAddresses([...choices, { address: newAddress.trim(), label: newLabel.trim(), manual: true }]);
                setNewAddress(''); setNewLabel('');
              }}>
              <Plus size={13} /> Add
            </button>
          </div>
        )}
      </section>

      {/* ---------------------------------------------------------------- */}
      <section className="cx-section">
        <h4>Firewall Status</h4>
        {!firewall?.supported ? (
          <p className="hint">{firewall?.note ?? 'The firewall on this host is managed outside this application.'}</p>
        ) : (
          <>
            <div className="cx-rows">
              <div className="cx-row">
                <span>Inbound port {info.api.port}</span>
                <span className={firewall.portAllowed ? 'ok' : 'bad'}>
                  {firewall.portAllowed === null ? 'could not be read'
                    : firewall.portAllowed ? `admitted by "${firewall.ruleName}"` : 'not admitted'}
                </span>
              </div>
              {firewall.profiles.map(profile => (
                <div className="cx-row" key={profile.name}>
                  <span>{profile.name}</span>
                  <span className={profile.public ? 'bad' : 'ok'}>
                    {profile.category}{profile.public ? ' — Windows refuses inbound connections on a Public network' : ''}
                  </span>
                </div>
              ))}
            </div>
            {canEdit && (
              <div className="cx-field">
                <button type="button" disabled={busy !== null} onClick={() => void openFirewall()}>
                  {busy === 'firewall' ? <Loader2 size={13} className="spin" /> : <ShieldCheck size={13} />}
                  {' '}Allow devices to reach this host
                </button>
                <span className="hint">
                  Admits the port on every firewall profile and moves any Public connection to Private.
                  {firewall.elevated === false && ' This application is not running as administrator, so it will '
                    + 'hand you the command to run instead.'}
                </span>
              </div>
            )}
          </>
        )}
      </section>

      {/* ---------------------------------------------------------------- */}
      <section className="cx-section">
        <h4>Connectivity Diagnostics</h4>
        <p className="hint">
          Works down the layers a connection has to survive and reports the first one that fails.
        </p>
        <div className="cx-field">
          <button type="button" disabled={busy !== null} onClick={() => void diagnose()}>
            {busy === 'diagnose' ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />} Run diagnostics
          </button>
        </div>

        {verdict && <Notice kind={findings?.some(f => f.status === 'fail') ? 'warn' : 'success'} silent>{verdict}</Notice>}

        {findings && (
          <ul className="cx-findings">
            {findings.map(finding => (
              <li key={finding.key} className={tone(finding.status)}>
                <span className="cx-icon">
                  {finding.status === 'ok' ? <CheckCircle2 size={14} />
                    : finding.status === 'fail' ? <XCircle size={14} />
                    : finding.status === 'warn' ? <AlertTriangle size={14} /> : <Globe size={14} />}
                </span>
                <div>
                  <strong>{finding.label}</strong>
                  <p>{finding.detail}</p>
                  {finding.fix && <p className="cx-fix">{finding.fix}</p>}
                </div>
              </li>
            ))}
          </ul>
        )}

        <div className="cx-beacon">
          <strong>Check from another computer</strong>
          <p className="hint">
            Open this address in a browser on a bench. If it answers, that machine can reach this host and the
            address below will appear in the list. If it does not, the fault is in the network between them.
          </p>
          <code className="cx-url">{reachUrl}</code>
          {visitors.length > 0 ? (
            <table className="data-table cx-table">
              <thead><tr><th>Device</th><th>Last reached</th></tr></thead>
              <tbody>
                {visitors.map(v => (
                  <tr key={v.address}>
                    <td><code>{v.address}</code></td>
                    <td className="hint">{v.at.slice(0, 19).replace('T', ' ')} UTC</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="hint">No other device has reached this host since it started.</p>
          )}
        </div>
      </section>
    </div>
  );
}
