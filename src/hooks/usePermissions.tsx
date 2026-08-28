import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api } from '../services/api';
import { useAuth } from './useAuth';
import type { PermissionMap } from '../../shared/types/api';

/**
 * The client's copy of the permissions the server computed for this user.
 *
 * SECH_LIMS hides rather than disables: a feature a user is not entitled to
 * use is not rendered at all — no greyed-out button, no menu entry, no card on
 * a dashboard. This context is what every surface asks before drawing itself.
 *
 * The map comes from the server's own resolver (`GET /auth/permissions`), so
 * the UI can never advertise something the API would refuse — and, just as
 * importantly, hiding here is a courtesy, never the control. Every hidden
 * action is independently refused server-side.
 *
 * A module absent from the map means the user may not view it at all.
 */
type PermissionContextValue = {
  permissions: PermissionMap;
  loading: boolean;
  /** May the user take `action` on `moduleKey`? */
  can: (moduleKey: string, action: PermissionAction) => boolean;
  /** May the user open `moduleKey` at all? */
  canView: (moduleKey: string) => boolean;
  /** May the user take `action` on at least one of these modules? */
  canAny: (moduleKeys: string[], action?: PermissionAction) => boolean;
  refresh: () => Promise<void>;
};

export type PermissionAction = 'view' | 'create' | 'edit' | 'void_archive' | 'export' | 'import' | 'print' | 'approve';

const PermissionContext = createContext<PermissionContextValue | undefined>(undefined);

export function PermissionProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const [permissions, setPermissions] = useState<PermissionMap>({});
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!user) { setPermissions({}); setLoading(false); return; }
    try {
      const r = await api<{ permissions: PermissionMap }>('/auth/permissions');
      setPermissions(r.permissions ?? {});
    } catch {
      // Fail closed on the first load: with no map, nothing optional is shown.
      // A later refresh that fails — a dropped LAN connection, the host
      // restarting — keeps the map already in hand instead, so a momentary
      // blip does not make the whole application look revoked. The server
      // refuses the action either way, so this cannot widen access.
      setPermissions(prev => (Object.keys(prev).length > 0 ? prev : {}));
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => { setLoading(true); void refresh(); }, [refresh]);

  // An administrator can change someone's rights while they are signed in.
  // Re-reading the map when the window regains focus keeps a stale tab from
  // showing a feature that has since been withdrawn.
  useEffect(() => {
    if (!user) return;
    const onFocus = () => { void refresh(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [user, refresh]);

  const value = useMemo<PermissionContextValue>(() => {
    const can = (moduleKey: string, action: PermissionAction) => (permissions[moduleKey] ?? []).includes(action);
    return {
      permissions,
      loading,
      can,
      canView: (moduleKey: string) => can(moduleKey, 'view'),
      canAny: (moduleKeys: string[], action: PermissionAction = 'view') => moduleKeys.some(k => can(k, action)),
      refresh,
    };
  }, [permissions, loading, refresh]);

  return <PermissionContext.Provider value={value}>{children}</PermissionContext.Provider>;
}

export function usePermissions() {
  const ctx = useContext(PermissionContext);
  if (!ctx) throw new Error('usePermissions must be used inside PermissionProvider');
  return ctx;
}

/**
 * Render `children` only when the user holds the permission.
 *
 *   <Can module="documents" action="print"><button>Print</button></Can>
 *
 * There is deliberately no "disabled" variant: a control the user may not use
 * should not appear at all.
 */
export function Can({ module, action = 'view', children }: { module: string; action?: PermissionAction; children: React.ReactNode }) {
  const { can } = usePermissions();
  return can(module, action) ? <>{children}</> : null;
}
