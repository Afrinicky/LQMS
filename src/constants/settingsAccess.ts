import type { PermissionAction } from '../hooks/usePermissions';

/**
 * Who may reach each page under Settings.
 *
 * Settings is not one permission: it holds true administration (lab identity,
 * users, modules, backups) alongside a few delegated tools that were parked
 * here — roster building, the document master-list import, evidence upload and
 * the action tracker. Each is gated on the right its own module demands.
 *
 * This is the single source used by the sidebar, the Home launchpad, the tab
 * rail and the route guards, so all four agree on what a person can see. The
 * server enforces the same rights independently.
 */
export type SettingsTab = {
  to: string;
  label: string;
  module: string;
  action: PermissionAction;
  /** True for the pages that are genuinely system administration. */
  administration?: boolean;
  /**
   * False for a page that exists elsewhere in its own right, so holding its
   * permission must not by itself put Settings in front of someone. The Action
   * Tracker is the case: it has a top-level route of its own, and nearly every
   * role can use it, so counting it would show "Settings" to the whole
   * laboratory for a page that is not a setting.
   */
  grantsEntry?: boolean;
};

export const SETTINGS_TABS: SettingsTab[] = [
  { to: '/settings/laboratory', label: 'My Laboratory', module: 'settings', action: 'view', administration: true, grantsEntry: true },
  { to: '/settings/people', label: 'People & Access', module: 'settings', action: 'edit', administration: true, grantsEntry: true },
  { to: '/settings/sections', label: 'Section/Unit Configuration', module: 'settings', action: 'edit', administration: true, grantsEntry: true },
  { to: '/settings/config-lists', label: 'Dropdown Lists', module: 'settings', action: 'edit', administration: true, grantsEntry: true },
  { to: '/settings/stock', label: 'Stock & Storage', module: 'supplier_inventory', action: 'edit', grantsEntry: true },
  { to: '/settings/scheduling', label: 'Roster & Scheduling', module: 'personnel', action: 'edit', grantsEntry: true },
  { to: '/settings/activities', label: 'Unit Activities & Reminders', module: 'personnel.activities', action: 'view', grantsEntry: true },
  { to: '/settings/system', label: 'System', module: 'settings', action: 'edit', administration: true, grantsEntry: true },
  { to: '/settings/document-import', label: 'Document Master List Import', module: 'documents', action: 'create', grantsEntry: true },
  { to: '/settings/evidence', label: 'Evidence Upload', module: 'records_reports', action: 'create', grantsEntry: true },
  { to: '/settings/actions', label: 'Action Tracker', module: 'actions', action: 'view', grantsEntry: false },
];

export type Can = (module: string, action: PermissionAction) => boolean;

/** The Settings pages this user may open. */
export function visibleSettingsTabs(can: Can): SettingsTab[] {
  return SETTINGS_TABS.filter(t => can(t.module, t.action));
}

/** Whether Settings should be offered at all — see `grantsEntry`. */
export function canEnterSettings(can: Can): boolean {
  return SETTINGS_TABS.some(t => t.grantsEntry && can(t.module, t.action));
}

/**
 * What to promise on the Settings card and header. Someone holding only a
 * delegated tool is not offered "users, permissions and configuration".
 */
export function settingsBlurb(can: Can): string {
  const visible = visibleSettingsTabs(can);
  if (visible.some(t => t.administration)) return 'Users, permissions and configuration';
  const labels = visible.filter(t => t.grantsEntry).map(t => t.label);
  return labels.length ? labels.join(' · ') : 'Configuration assigned to your role';
}
