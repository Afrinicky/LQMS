import { Navigate, useLocation } from 'react-router-dom';
import { PowerOff, ShieldOff } from 'lucide-react';
import { usePermissions, type PermissionAction } from '../hooks/usePermissions';
import { useAnalyserTransmission } from '../hooks/useAnalyserTransmission';

/**
 * Route-level permission gate.
 *
 * Modules a user may not view are already absent from the navigation, so this
 * exists to catch the ways someone still arrives at the URL — a bookmark, a
 * link in an old email, a permission withdrawn while the tab was open, or a
 * hand-typed address. Rather than render the workspace and let each request
 * fail with a scatter of 403s, the route is refused outright.
 *
 * `redirect` sends the user somewhere they can actually work instead of
 * showing a dead end; it is used for the shell routes (home, dashboard).
 */
export function RequirePermission({
  module,
  action = 'view',
  redirect,
  children,
}: {
  module: string;
  action?: PermissionAction;
  redirect?: string;
  children: React.ReactNode;
}) {
  const { can, loading } = usePermissions();
  const location = useLocation();

  // Say nothing until the map has loaded — flashing a refusal at someone who
  // turns out to be authorised is worse than a moment of blank space.
  if (loading) return <div className="card">Checking your access…</div>;
  if (can(module, action)) return <>{children}</>;
  if (redirect && location.pathname !== redirect) return <Navigate to={redirect} replace />;

  return (
    <div className="module-page">
      <div className="disabled-module">
        <span className="es-ico"><ShieldOff size={26} /></span>
        <h3>You do not have access to this area</h3>
      </div>
    </div>
  );
}

/**
 * Gate a container route that holds pages with different requirements — the
 * Settings shell, whose tabs each demand their own right. The container opens
 * when the user can reach at least one page inside it; the pages themselves
 * are still gated individually.
 */
export function RequireAnyPermission({
  requirements,
  children,
}: {
  requirements: { module: string; action?: PermissionAction }[];
  children: React.ReactNode;
}) {
  const { can, loading } = usePermissions();
  if (loading) return <div className="card">Checking your access…</div>;
  if (requirements.some(r => can(r.module, r.action ?? 'view'))) return <>{children}</>;
  return (
    <div className="module-page">
      <div className="disabled-module">
        <span className="es-ico"><ShieldOff size={26} /></span>
        <h3>You do not have access to this area</h3>
      </div>
    </div>
  );
}

/**
 * Gate a route that only exists while this laboratory transmits.
 *
 * The analyser workspace and the Analyser Sync page are absent from the
 * navigation when transmission is switched off, so this catches the ways
 * somebody still reaches the address — a bookmark, an old link, or the switch
 * being thrown while the tab was open. It says which of the two reasons applies
 * rather than one wording that covers both, because they need different people
 * to fix them: a refusal needs an administrator to grant access, and this needs
 * an administrator to switch transmission on.
 */
export function RequireAnalyserTransmission({ children }: { children: React.ReactNode }) {
  const { enabled, loading } = useAnalyserTransmission();
  if (loading) return <div className="card">Checking your access…</div>;
  if (enabled) return <>{children}</>;
  return (
    <div className="module-page">
      <div className="disabled-module">
        <span className="es-ico"><PowerOff size={26} /></span>
        <h3>Analyser transmission is switched off</h3>
        <p>
          This laboratory runs SECHLIMS for quality management, so it does not
          connect to an analyser and does not carry patient results. An
          administrator can switch transmission on under Settings → System.
        </p>
      </div>
    </div>
  );
}

export default RequirePermission;
