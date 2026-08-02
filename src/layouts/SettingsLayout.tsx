import { NavLink, Outlet } from 'react-router-dom';
import {
  Users, Building2, Microscope, SlidersHorizontal, FileUp, Paperclip, ListChecks, CalendarClock,
} from 'lucide-react';
import PageHeader from '../components/ui/PageHeader';
import { usePermissions } from '../hooks/usePermissions';
import { visibleSettingsTabs } from '../constants/settingsAccess';
import type { LucideIcon } from 'lucide-react';

const ICONS: Record<string, LucideIcon> = {
  '/settings/laboratory': Building2,
  '/settings/people': Users,
  '/settings/sections': Microscope,
  '/settings/scheduling': CalendarClock,
  '/settings/system': SlidersHorizontal,
  '/settings/document-import': FileUp,
  '/settings/evidence': Paperclip,
  '/settings/actions': ListChecks,
};

export default function SettingsLayout() {
  const { can } = usePermissions();
  const visible = visibleSettingsTabs(can);
  // Someone who only holds a delegated tool here is not an administrator, so
  // the page does not describe administration they cannot perform.
  const isAdministrator = visible.some(t => t.administration);

  return (
    <div className="module-page">
      <PageHeader
        eyebrow="Configuration"
        title="Settings"
        subtitle={isAdministrator
          ? 'Lab identity, access control, roles and positions, module toggles, backups, and LAN/device preparation.'
          : 'The configuration tools assigned to your role.'}
      />
      <div className="settings-layout">
        <nav className="settings-nav">
          {visible.map(({ to, label }) => {
            const Icon = ICONS[to] ?? SlidersHorizontal;
            return (
              <NavLink key={to} to={to}>
                <Icon size={16} />
                <span>{label}</span>
              </NavLink>
            );
          })}
        </nav>
        <div><Outlet /></div>
      </div>
    </div>
  );
}
