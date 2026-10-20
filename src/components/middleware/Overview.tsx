import { useEffect, useState } from 'react';
import { AlertTriangle, Lock, RefreshCw, ShieldCheck } from 'lucide-react';
import { api, errorText } from '../../services/api';
import { KpiStrip } from '../ui';
import {
  Facts, Live, MessageChip, Note, Panel, StateChip, StatusMark,
  ago, endpointOf, when, type DiagnosticReport, type SectionProps,
} from './shared';

/**
 * Overview — the answer to "is transmission working?".
 *
 * Built around the five facts that are routinely confused with one another:
 * what is connected, what parsed, what was delivered, what was accepted, and
 * what is still waiting. Anything needing a person is at the top.
 */
export default function MiddlewareOverview({ overview, destinations, links, onOpen, onError }: SectionProps) {
  const [report, setReport] = useState<DiagnosticReport | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try { setReport(await api<DiagnosticReport>('/middleware/diagnostics')); }
      catch { /* the dashboard stands without it */ }
    })();
  }, []);

  async function refresh() {
    setBusy(true);
    try { setReport(await api<DiagnosticReport>('/middleware/diagnostics')); }
    catch (e) { onError(errorText(e)); }
    finally { setBusy(false); }
  }

  const needsAttention = (report?.findings ?? []).filter(f => f.status === 'fail' || f.status === 'warn');
  const protectedDestinations = destinations.filter(d => d.is_protected);
  const awaiting = destinations.filter(d => d.state === 'awaiting_approval');

  return (
    <>
      <KpiStrip items={[
        { label: 'Messages today', value: overview?.messagesToday ?? 0, onClick: () => onOpen?.('Message Explorer') },
        { label: 'Delivered today', value: overview?.deliveredToday ?? 0, tone: 'success', onClick: () => onOpen?.('Queues & Failed Deliveries') },
        { label: 'Queued', value: overview?.queueDepth ?? 0, tone: (overview?.queueDepth ?? 0) > 50 ? 'warning' : undefined, onClick: () => onOpen?.('Queues & Failed Deliveries') },
        { label: 'Dead letters', value: overview?.deadLetters ?? 0, tone: (overview?.deadLetters ?? 0) ? 'danger' : undefined, onClick: () => onOpen?.('Queues & Failed Deliveries') },
        { label: 'Active destinations', value: `${overview?.destinationsActive ?? 0}/${overview?.destinations ?? 0}`, onClick: () => onOpen?.('Destinations') },
        { label: 'Analyser links running', value: `${overview?.links?.running ?? 0}/${overview?.links?.n ?? 0}`, onClick: () => onOpen?.('Active Connections') },
      ]} />

      {/* The production-safety statement, first and unmissable. */}
      <Panel
        title="Protected production transmission"
        subtitle="Held read-only. The engine will not bind, dial, probe or route over these."
        tone="lock"
      >
        {overview?.baselines?.length || protectedDestinations.length ? (
          <ul className="mw-list">
            {(overview?.baselines ?? []).map(baseline => (
              <li key={`b${baseline.id}`}>
                <span className="mw-list-main">
                  <strong><Lock size={11} /> {baseline.label}</strong>
                  <span className="mw-sub">
                    Baseline captured {when(baseline.captured_at)}
                    {baseline.last_verdict ? ` · last verified ${when(baseline.last_verified_at)}: ${baseline.last_verdict}` : ' · not verified since'}
                  </span>
                </span>
                {baseline.last_verdict === 'drifted'
                  ? <span className="mw-chip t-warn">Drifted</span>
                  : <span className="mw-chip t-ok">Unchanged</span>}
              </li>
            ))}
            {protectedDestinations.map(destination => (
              <li key={`d${destination.id}`}>
                <span className="mw-list-main">
                  <strong><Lock size={11} /> {destination.name}</strong>
                  <span className="mw-sub">{endpointOf(destination)} · read-only</span>
                </span>
                <StateChip state={destination.state} protectedConnection />
              </li>
            ))}
          </ul>
        ) : (
          <Note>
            No protected connection is recorded yet. Capture a baseline of the existing analyser-to-LHIMS link in
            Connection Setup — it reads the link's configuration and changes nothing about it.
          </Note>
        )}
      </Panel>

      <div className="mw-grid-2">
        <Panel
          title="Needs attention"
          subtitle={report ? report.summary : 'Reading the diagnostics.'}
          actions={<button type="button" className="pq-link" disabled={busy} onClick={() => void refresh()}><RefreshCw size={12} /> Re-check</button>}
          tone={report?.status === 'fail' ? 'crit' : report?.status === 'warn' ? 'warn' : undefined}
        >
          {needsAttention.length === 0 ? (
            <Note tone="ok"><ShieldCheck size={12} /> Every check passed.</Note>
          ) : (
            <ul className="mw-list">
              {needsAttention.map(finding => (
                <li key={finding.key}>
                  <span className="mw-list-main">
                    <strong>{finding.label}</strong>
                    <span className="mw-sub">{finding.detail}</span>
                    {finding.remedy && <span className="mw-sub t-remedy">{finding.remedy}</span>}
                  </span>
                  <StatusMark status={finding.status} />
                </li>
              ))}
            </ul>
          )}
          {awaiting.length > 0 && (
            <Note tone="warn">
              <AlertTriangle size={12} /> {awaiting.length} destination(s) await approval and carry nothing until approved and activated.
              {' '}<button type="button" className="pq-link" onClick={() => onOpen?.('Destinations')}>Open destinations</button>
            </Note>
          )}
        </Panel>

        <Panel title="Engine" subtitle="Queue state and delivery guarantee.">
          <Facts items={[
            { label: 'Engine', value: <Live on={Boolean(overview?.running)} /> },
            { label: 'Queued', value: overview?.queued ?? 0 },
            { label: 'Retrying', value: overview?.retrying ?? 0 },
            { label: 'In flight', value: overview?.inFlight ?? 0 },
            { label: 'Dead letters', value: overview?.deadLetters ?? 0 },
            { label: 'Last accepted', value: ago(overview?.lastDeliveryAt) },
            { label: 'Routing rules', value: overview?.routes ?? 0 },
            { label: 'Links failing', value: overview?.links?.failing ?? 0 },
          ]} />
          <Note>
            Delivery is at least once, with an idempotency key per destination so a retry or an authorised replay is the
            same delivery rather than a second result. Exactly-once is not claimed: a destination that acknowledges a
            message and then loses it is outside this engine's control.
          </Note>
        </Panel>
      </div>

      <Panel
        title="Recent transmissions"
        subtitle="Every stage of each is on the record."
        actions={<button type="button" className="pq-link" onClick={() => onOpen?.('Message Explorer')}>Open the explorer</button>}
      >
        {!overview?.recent?.length ? (
          <Note>Nothing has been ingested by the middleware yet.</Note>
        ) : (
          <table className="data-table mw-table">
            <thead>
              <tr>
                <th>Received</th><th>Analyser</th><th>Sample</th><th>Kind</th>
                <th className="num">Results</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {overview.recent.map(message => (
                <tr key={message.id}>
                  <td>{when(message.received_at)}</td>
                  <td>{message.link_name ?? '—'}</td>
                  <td className="mono">{message.sample_id ?? '—'}</td>
                  <td>{message.kind}</td>
                  <td className="num">{message.result_count}</td>
                  <td><MessageChip status={message.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel title="Destinations" subtitle="Each with its own profile, mapping, acknowledgement policy and delivery state.">
        {!destinations.length ? (
          <Note>
            No destination is configured, so messages are held in SECHLIMS and transmitted nowhere.
            {' '}<button type="button" className="pq-link" onClick={() => onOpen?.('Destinations')}>Add one</button>
          </Note>
        ) : (
          <table className="data-table mw-table">
            <thead>
              <tr>
                <th>Destination</th><th>Platform</th><th>Endpoint</th><th>State</th>
                <th className="num">Delivered</th><th className="num">Waiting</th><th className="num">Dead</th>
              </tr>
            </thead>
            <tbody>
              {destinations.map(destination => (
                <tr key={destination.id}>
                  <td><strong>{destination.name}</strong></td>
                  <td>{destination.platform}</td>
                  <td className="mono">{endpointOf(destination)}</td>
                  <td><StateChip state={destination.state} protectedConnection={Boolean(destination.is_protected)} /></td>
                  <td className="num">{destination.delivered}</td>
                  <td className="num">{destination.pending}</td>
                  <td className={`num${destination.dead_letters ? ' t-crit' : ''}`}>{destination.dead_letters}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      {links.length > 0 && (
        <Panel title="Analyser links" subtitle="What the bridge is receiving, and what the middleware did with it.">
          <table className="data-table mw-table">
            <thead>
              <tr>
                <th>Analyser</th><th>State</th><th className="num">Ingested</th>
                <th className="num">Unrouted</th><th className="num">Waiting</th><th>Last heard</th>
              </tr>
            </thead>
            <tbody>
              {links.map(link => (
                <tr key={link.id}>
                  <td>
                    <strong>{link.name}</strong>
                    {link.engine_protected && <span className="mw-chip t-lock"><Lock size={10} /> Protected</span>}
                  </td>
                  <td>{link.state}</td>
                  <td className="num">{link.middleware_messages}</td>
                  <td className={`num${link.unrouted ? ' t-warn' : ''}`}>{link.unrouted}</td>
                  <td className="num">{link.pending}</td>
                  <td>{ago(link.last_message_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}
    </>
  );
}
