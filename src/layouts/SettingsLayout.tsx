import { NavLink, Outlet } from 'react-router-dom';
import {
  Users, UserPlus, Network, ShieldCheck, ToggleRight, FileUp, Paperclip, ListChecks,
  DatabaseBackup, MonitorSmartphone, Microscope,
} from 'lucide-react';
import PageHeader from '../components/ui/PageHeader';
import type { LucideIcon } from 'lucide-react';

const items: { to: string; label: string; Icon: LucideIcon }[] = [
  { to: '/settings/register-staff', label: 'Register New Staff', Icon: UserPlus },
  { to: '/settings/users', label: 'Users & Access', Icon: Users },
  { to: '/settings/positions', label: 'Positions & Organogram', Icon: Network },
  { to: '/settings/sections', label: 'Section/Unit Configuration', Icon: Microscope },
  { to: '/settings/permissions', label: 'Permission Matrix', Icon: ShieldCheck },
  { to: '/settings/modules', label: 'System Modules Toggle', Icon: ToggleRight },
  { to: '/settings/document-import', label: 'Document Master List Import', Icon: FileUp },
  { to: '/settings/evidence', label: 'Evidence Upload', Icon: Paperclip },
  { to: '/settings/actions', label: 'Action Tracker', Icon: ListChecks },
  { to: '/settings/backup', label: 'Backup & Restore', Icon: DatabaseBackup },
  { to: '/settings/devices', label: 'Device Access / Pairing', Icon: MonitorSmartphone },
];

export default function SettingsLayout() {
  return (
    <div className="module-page">
      <PageHeader
        eyebrow="Configuration"
        title="Settings"
        subtitle="Lab identity, access control, roles and positions, module toggles, backups, and LAN/device preparation."
      />
      <div className="settings-layout">
        <nav className="settings-nav">
          {items.map(({ to, label, Icon }) => (
            <NavLink key={to} to={to}>
              <Icon size={16} />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
        <div><Outlet /></div>
      </div>
    </div>
  );
}
