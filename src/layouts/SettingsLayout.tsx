import { NavLink, Outlet } from 'react-router-dom';
import {
  Users, Building2, Microscope, SlidersHorizontal, FileUp, Paperclip, ListChecks, CalendarClock,
} from 'lucide-react';
import PageHeader from '../components/ui/PageHeader';
import type { LucideIcon } from 'lucide-react';

const items: { to: string; label: string; Icon: LucideIcon }[] = [
  { to: '/settings/laboratory', label: 'My Laboratory', Icon: Building2 },
  { to: '/settings/people', label: 'People & Access', Icon: Users },
  { to: '/settings/sections', label: 'Section/Unit Configuration', Icon: Microscope },
  { to: '/settings/scheduling', label: 'Roster & Scheduling', Icon: CalendarClock },
  { to: '/settings/system', label: 'System', Icon: SlidersHorizontal },
  { to: '/settings/document-import', label: 'Document Master List Import', Icon: FileUp },
  { to: '/settings/evidence', label: 'Evidence Upload', Icon: Paperclip },
  { to: '/settings/actions', label: 'Action Tracker', Icon: ListChecks },
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
