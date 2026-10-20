import { Lock, Stethoscope } from 'lucide-react';
import { Facts, Note, Panel, ago, linkEndpointOf, when, type SectionProps } from './shared';

/**
 * Active Analyser Connections.
 *
 * The register of what is connected, read through the middleware: how much has
 * been ingested, how much matched no routing rule, how much is waiting and how
 * much has been abandoned.
 *
 * The protected link appears here like any other, and everything about it is
 * stated rather than offered: the engine opens nothing on it, and that is the
 * single most important fact on this screen.
 */
export default function MiddlewareConnections({ links, routes, onOpen }: SectionProps) {
  const protectedLinks = links.filter(l => l.engine_protected);
  const ours = links.filter(l => !l.engine_protected);

  return (
    <>
      {protectedLinks.length > 0 && (
        <Panel
          title="Protected links"
          subtitle="Recorded so the laboratory can see them. The engine binds nothing, dials nothing and probes nothing here."
          tone="lock"
        >
          {protectedLinks.map(link => (
            <div key={link.id} className="mw-block">
              <div className="mw-block-head">
                <strong><Lock size={12} /> {link.name}</strong>
                <span className="mw-chip t-lock">Protected</span>
                {link.mode === 'lhims_tap' && <span className="mw-chip t-info">Read-only copy</span>}
              </div>
              <Facts items={[
                { label: 'Protocol', value: String(link.protocol).toUpperCase() },
                { label: 'Arrangement', value: linkEndpointOf(link) },
                { label: 'State', value: link.state },
                { label: 'Instrument', value: link.equipment_name ?? '—' },
                { label: 'Unit', value: link.section_name ?? '—' },
                { label: 'Last heard', value: ago(link.last_message_at) },
                { label: 'Ingested by the middleware', value: link.middleware_messages },
                { label: 'Routing rules covering it', value: link.routes },
              ]} />
              {link.mode === 'lhims_tap' ? (
                <Note>
                  A copy is taken by following the client's own append log, read-only. No port is bound and no
                  connection is opened, so if SECHLIMS stops the existing transmission does not notice.
                </Note>
              ) : (
                <Note tone="warn">
                  Nothing will arrive on this link: it is recorded as one LHIMS owns and is set to bind or dial, so
                  SECHLIMS never opens it. To take a copy without touching the connection, set it to follow the LHIMS
                  client's own log.
                </Note>
              )}
            </div>
          ))}
        </Panel>
      )}

      <Panel
        title="Analyser connections"
        subtitle="Everything the bridge receives, and what the middleware did with it."
        actions={<button type="button" className="pq-link" onClick={() => onOpen?.('Diagnostics')}><Stethoscope size={12} /> Diagnose</button>}
      >
        {!ours.length ? (
          <Note>No analyser link of our own is configured. Add one in Settings, then route its messages here.</Note>
        ) : (
          <table className="data-table mw-table">
            <thead>
              <tr>
                <th>Analyser</th><th>Protocol</th><th>Arrangement</th><th>State</th>
                <th className="num">Ingested</th><th className="num">Unrouted</th>
                <th className="num">Waiting</th><th className="num">Dead</th><th>Last heard</th>
              </tr>
            </thead>
            <tbody>
              {ours.map(link => (
                <tr key={link.id}>
                  <td>
                    <strong>{link.name}</strong>
                    {link.section_name && <span className="mw-sub">{link.section_name}</span>}
                  </td>
                  <td>{String(link.protocol).toUpperCase()}</td>
                  <td className="mono">{linkEndpointOf(link)}</td>
                  <td>
                    <span className={`mw-chip t-${['listening', 'connected', 'following'].includes(link.state) ? 'ok' : link.state === 'error' ? 'crit' : 'idle'}`}>
                      {link.state}
                    </span>
                    {link.state_detail && <span className="mw-sub">{link.state_detail}</span>}
                  </td>
                  <td className="num">{link.middleware_messages}</td>
                  <td className={`num${link.unrouted ? ' t-warn' : ''}`}>{link.unrouted}</td>
                  <td className="num">{link.pending}</td>
                  <td className={`num${link.dead_letters ? ' t-crit' : ''}`}>{link.dead_letters}</td>
                  <td>{ago(link.last_message_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {ours.some(l => l.unrouted > 0) && (
          <Note tone="warn">
            Messages marked unrouted matched no routing rule. They are held in SECHLIMS, lost nowhere, and can be
            re-routed once a rule covers them.
            {' '}<button type="button" className="pq-link" onClick={() => onOpen?.('Routing & Mappings')}>Open routing</button>
          </Note>
        )}
        {!routes.length && (
          <Note tone="warn">
            No routing rule exists, so nothing is transmitted onward from any of these links.
            {' '}<button type="button" className="pq-link" onClick={() => onOpen?.('Routing & Mappings')}>Add a rule</button>
          </Note>
        )}
      </Panel>

      <Panel title="Connection states" subtitle="What each word on this screen means.">
        <Facts items={[
          { label: 'Listening', value: 'A port is bound and the analyser has not connected yet.' },
          { label: 'Connected', value: 'A session is open with the analyser.' },
          { label: 'Following', value: 'A log file somebody else writes is being read forward, read-only.' },
          { label: 'Blocked', value: 'Deliberately left alone: the link belongs to a live production transmission.' },
          { label: 'Failed', value: 'The link could not be opened. Its own reason is on the row.' },
          { label: 'Stopped', value: 'Not running. Nothing will arrive.' },
        ]} />
      </Panel>
    </>
  );
}
