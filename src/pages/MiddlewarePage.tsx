import { useCallback, useEffect, useState } from 'react';
import { api, apiRead, errorText } from '../services/api';
import { useModules } from '../hooks/useModules';
import { usePermissions } from '../hooks/usePermissions';
import DisabledModule from '../components/DisabledModule';
import PermissionTabs from '../components/PermissionTabs';
import { PageHeader } from '../components/ui';
import { Notice } from '../components/ui/Feedback';
import MiddlewareOverview from '../components/middleware/Overview';
import MiddlewareDiscovery from '../components/middleware/Discovery';
import MiddlewareSetup from '../components/middleware/Setup';
import MiddlewareDiagnostics from '../components/middleware/Diagnostics';
import MiddlewareConnections from '../components/middleware/Connections';
import MiddlewareDestinations from '../components/middleware/Destinations';
import MiddlewareRouting from '../components/middleware/Routing';
import MiddlewareMonitor from '../components/middleware/Monitor';
import MiddlewareExplorer from '../components/middleware/Explorer';
import MiddlewareQueues from '../components/middleware/Queues';
import MiddlewareDennis from '../components/middleware/Dennis';
import MiddlewareAudit from '../components/middleware/Audit';
import type { Destination, MiddlewareLink, Overview, Reference, Route } from '../components/middleware/shared';

/**
 * Analyser Transmission & Middleware.
 *
 * One workspace for the whole journey a result makes: the analyser, the
 * protocol, the engine that carries it, the information systems that receive
 * it, and the record of what happened to every message.
 *
 * The first thing the page is built to make plain is the one that matters most
 * clinically: the existing Sysmex XN-550 to LHIMS transmission is PROTECTED.
 * It appears here so the laboratory can see that the system knows about it, and
 * everything about it is read-only — the engine refuses to bind its port, dial
 * its address, probe it or route over it, and the screens say so rather than
 * offering buttons that would be refused.
 *
 * The twelve sections run in the order the work is actually done: see the
 * state, find a device, configure it, diagnose it, then the connections, the
 * destinations, the routing, and finally the evidence — live traffic, the
 * message explorer, the queues, the assistant and the audit trail.
 */

const TABS = [
  'Overview',
  'Discovery',
  'Connection Setup',
  'Diagnostics',
  'Active Connections',
  'Destinations',
  'Routing & Mappings',
  'Live Monitoring',
  'Message Explorer',
  'Queues & Failed Deliveries',
  'Dennis Assistant',
  'Audit & Rollback',
];

export default function MiddlewarePage() {
  const { isEnabled } = useModules();
  const { can } = usePermissions();
  const [tab, setTab] = useState('Overview');
  const [overview, setOverview] = useState<Overview | null>(null);
  const [reference, setReference] = useState<Reference | null>(null);
  const [links, setLinks] = useState<MiddlewareLink[]>([]);
  const [destinations, setDestinations] = useState<Destination[]>([]);
  const [routes, setRoutes] = useState<Route[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const enabled = isEnabled('analyser_middleware');

  /**
   * The registers every section reads from, loaded once and refreshed together.
   *
   * Sections that each fetch their own copy are how two tabs come to disagree
   * about whether a destination is active, which in this module is not a
   * cosmetic problem.
   */
  const load = useCallback(async () => {
    try {
      const [summary, linkRows, destinationRows, routeRows] = await Promise.all([
        apiRead<Overview | null>('/middleware/overview', null),
        apiRead<MiddlewareLink[]>('/middleware/links', []),
        apiRead<Destination[]>('/middleware/destinations', []),
        apiRead<Route[]>('/middleware/routes', []),
      ]);
      if (summary) setOverview(summary);
      setLinks(linkRows);
      setDestinations(destinationRows);
      setRoutes(routeRows);
      setError(null);
    } catch (e) { setError(errorText(e)); }
  }, []);

  useEffect(() => { if (enabled) void load(); }, [enabled, load]);
  useEffect(() => {
    if (!enabled) return;
    void (async () => {
      try { setReference(await api<Reference>('/middleware/reference')); }
      catch { /* the pickers degrade to plain inputs */ }
    })();
  }, [enabled]);

  // A destination's state changes without anything happening on this page — a
  // delivery lands, a queue drains — so the registers refresh themselves.
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => { void load(); }, 20_000);
    return () => clearInterval(timer);
  }, [enabled, load]);

  if (!enabled) return <DisabledModule />;

  const shared = {
    overview, reference, links, destinations, routes,
    reload: load,
    onError: setError,
    onNotice: setNotice,
    canConfigure: can('analyser_middleware.configuration', 'edit'),
    canApprove: can('analyser_middleware.configuration', 'approve'),
    canDiscover: can('analyser_middleware.discovery', 'create'),
    canDiagnose: can('analyser_middleware.diagnostics', 'create'),
    canQueue: can('analyser_middleware.queues', 'edit'),
    canApproveDennis: can('analyser_middleware.dennis', 'approve'),
    canRollback: can('analyser_middleware.audit', 'void_archive'),
  };

  return (
    <div className="module-page mw">
      <PageHeader
        eyebrow="Information Management"
        title="Analyser Transmission & Middleware"
        subtitle="Analyser connections, protocol handling, routing and delivery to SECHLIMS and connected information systems."
      />
      <PermissionTabs moduleKey="analyser_middleware" tabs={TABS} active={tab} onChange={setTab} />
      {error && <Notice kind="error">{error}</Notice>}
      {notice && <Notice kind="success">{notice}</Notice>}

      {tab === 'Overview' && <MiddlewareOverview {...shared} onOpen={setTab} />}
      {tab === 'Discovery' && <MiddlewareDiscovery {...shared} onOpen={setTab} />}
      {tab === 'Connection Setup' && <MiddlewareSetup {...shared} onOpen={setTab} />}
      {tab === 'Diagnostics' && <MiddlewareDiagnostics {...shared} />}
      {tab === 'Active Connections' && <MiddlewareConnections {...shared} onOpen={setTab} />}
      {tab === 'Destinations' && <MiddlewareDestinations {...shared} />}
      {tab === 'Routing & Mappings' && <MiddlewareRouting {...shared} />}
      {tab === 'Live Monitoring' && <MiddlewareMonitor {...shared} />}
      {tab === 'Message Explorer' && <MiddlewareExplorer {...shared} />}
      {tab === 'Queues & Failed Deliveries' && <MiddlewareQueues {...shared} />}
      {tab === 'Dennis Assistant' && <MiddlewareDennis {...shared} />}
      {tab === 'Audit & Rollback' && <MiddlewareAudit {...shared} />}
    </div>
  );
}
