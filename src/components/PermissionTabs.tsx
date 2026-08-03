import { useEffect, useMemo } from 'react';
import { usePermissions } from '../hooks/usePermissions';
import { permKeyForTab, actionForTab } from '../../shared/constants/features';

/**
 * The workspace tab bar, filtered by permission.
 *
 * Every module page used to render its full tab list to anyone who could open
 * the module, so a Technician allowed into Personnel Management to see a
 * training calendar was also offered Declarations, Appraisals and Technical
 * Authorizations. The API refused the data, but the tabs were there to click.
 *
 * A tab is drawn only when the user holds `view` on the feature that governs
 * it. Tabs with no governing feature — a module's own landing dashboard — are
 * always shown, so pages keep a sensible home.
 *
 * If the active tab is filtered away (a bookmarked deep link, or rights
 * withdrawn mid-session), the bar moves the user to the first tab they can
 * actually open rather than leaving them on a blank panel.
 */
export function usePermittedTabs(moduleKey: string, tabs: string[], active: string, onChange: (name: string) => void) {
  const { can } = usePermissions();

  const permitted = useMemo(
    () => tabs.filter(tab => {
      const permKey = permKeyForTab(moduleKey, tab);
      return permKey === null || can(permKey, actionForTab(tab));
    }),
    [moduleKey, tabs, can],
  );

  useEffect(() => {
    if (permitted.length === 0) return;
    if (!permitted.includes(active)) onChange(permitted[0]);
    // onChange is a setState in every caller, so it is safe to leave out.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [permitted, active]);

  return permitted;
}

export default function PermissionTabs({
  moduleKey, tabs, active, onChange,
}: {
  moduleKey: string;
  tabs: string[];
  active: string;
  onChange: (name: string) => void;
}) {
  const permitted = usePermittedTabs(moduleKey, tabs, active, onChange);
  if (permitted.length === 0) return null;
  return (
    <div className="tabs">
      {permitted.map(name => (
        <button key={name} type="button" className={active === name ? 'active' : ''} onClick={() => onChange(name)}>
          {name}
        </button>
      ))}
    </div>
  );
}
