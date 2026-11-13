import { useCallback, useEffect, useState } from 'react';
import { api, apiRead, errorText } from '../../../src/services/api';
import { usePermissions } from '../../../src/hooks/usePermissions';
import PermissionTabs from '../../../src/components/PermissionTabs';
import { PageHeader } from '../../../src/components/ui';
import { Notice } from '../../../src/components/ui/Feedback';
import MiddlewareOverview from '../../../src/components/middleware/Overview';
import MiddlewareDiscovery from '../../../src/components/middleware/Discovery';
import MiddlewareSetup from '../../../src/components/middleware/Setup';
import MiddlewareDiagnostics from '../../../src/components/middleware/Diagnostics';
import MiddlewareConnections from '../../../src/components/middleware/Connections';
import MiddlewareDestinations from '../../../src/components/middleware/Destinations';
import MiddlewareRouting from '../../../src/components/middleware/Routing';
import MiddlewareParameterMappings from '../../../src/components/middleware/ParameterMappings';
import MiddlewareMonitor from '../../../src/components/middleware/Monitor';
import MiddlewareExplorer from '../../../src/components/middleware/Explorer';
import MiddlewareQueues from '../../../src/components/middleware/Queues';
import MiddlewareResultFiller from '../../../src/components/middleware/ResultFiller';
import MiddlewareLabReports from '../../../src/components/middleware/LabReports';
import MiddlewareAudit from '../../../src/components/middleware/Audit';
import type {
  Destination, MiddlewareLink, Overview, Reference, Route,
} from '../../../src/components/middleware/shared';
import { useInstallation } from '../useInstallation';

/**
 * Analyser Transmission & Middleware, as TransLis has it.
 *
 * The same fourteen sections SECHLIMS draws, from the same component files,
 * minus the Dennis Assistant — which is the laboratory's own assistant reading
 * the laboratory's own evidence, and belongs to the quality management system
 * rather than to a middleware dispatched to a facility that does not run one.
 *
 * Nothing here is a copy. Each section below is the file SECHLIMS renders, so
 * a correction to the Message Explorer is a correction in both products and
 * neither can quietly fall behind the other.
 */
const TABS = [
  'Overview',
  'Discovery',
  'Connection Setup',
  'Diagnostics',
  'Active Connections',
  'Destinations',
  'Routing & Mappings',
  'Parameter Mappings',
  'Live Monitoring',
  'Message Explorer',
  'Queues & Failed Deliveries',
  'Result Filler',
  'Result Reports',
  'Audit & Rollback',
];

export default function Workspace() {
  const { can } = usePermissions();
  const { installation } = useInstallation();
  const [tab, setTab] = useState('Result Filler');
  const [overview, setOverview] = useState<Overview | null>(null);
  const [reference, setReference] = useState<Reference | null>(null);
  const [links, setLinks] = useState<MiddlewareLink[]>([]);
  const [destinations, setDestinations] = useState<Destination[]>([]);
  const [routes, setRoutes] = useState<Route[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  /** The registers every section reads from, loaded once and refreshed together. */
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

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    void (async () => {
      try { setReference(await api<Reference>('/middleware/reference')); }
      catch { /* the pickers degrade to plain inputs */ }
    })();
  }, []);
  useEffect(() => {
    const timer = setInterval(() => { void load(); }, 20_000);
    return () => clearInterval(timer);
  }, [load]);

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
    canApproveDennis: false,
    canRollback: can('analyser_middleware.audit', 'void_archive'),
  };

  return (
    <div className="module-page mw">
      <PageHeader
        eyebrow="TransLis"
        title="Analyser Transmission &amp; Middleware"
        subtitle={installation
          ? `Analyser connections, protocol handling, routing and delivery to ${installation.lisName}.`
          : 'Analyser connections, protocol handling, routing and delivery.'}
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
      {tab === 'Parameter Mappings' && <MiddlewareParameterMappings {...shared} />}
      {tab === 'Live Monitoring' && <MiddlewareMonitor {...shared} />}
      {tab === 'Message Explorer' && <MiddlewareExplorer {...shared} />}
      {tab === 'Queues & Failed Deliveries' && <MiddlewareQueues {...shared} />}
      {tab === 'Result Filler' && <MiddlewareResultFiller {...shared} />}
      {tab === 'Result Reports' && <MiddlewareLabReports {...shared} />}
      {tab === 'Audit & Rollback' && <MiddlewareAudit {...shared} />}
    </div>
  );
}
