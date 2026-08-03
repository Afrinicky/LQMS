import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Bell, ChevronDown, Database, Server, LogOut, PanelLeftClose, PanelLeftOpen, Search, FlaskConical, KeyRound, PenLine } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { MODULES } from '../../shared/constants/modules';
import { NAV_SECTIONS, NAV_GROUP_LABELS } from '../../shared/constants/navigation';
import { useAuth } from '../hooks/useAuth';
import { useModules } from '../hooks/useModules';
import { usePermissions } from '../hooks/usePermissions';
import { canEnterSettings } from '../constants/settingsAccess';
import { api } from '../services/api';
import { moduleIcon, sectionIcon } from '../components/ui/moduleIcons';
import { DennisFloatingWidget } from '../components/DennisFloatingWidget';
import { ChangePasswordModal } from '../components/ChangePasswordModal';
import { SignatureModal } from '../components/SignatureModal';

const API_HOST = (() => {
  try { return new URL((window as any).sechLims?.apiBaseUrl ?? 'http://127.0.0.1:4317/api').host; }
  catch { return '127.0.0.1:4317'; }
})();

function initials(name?: string) {
  if (!name) return 'U';
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || 'U';
}

export default function AppLayout() {
  const { user, logout, refreshUser } = useAuth();
  const { modules, isEnabled } = useModules();
  const { can, canView } = usePermissions();
  const navigate = useNavigate();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(false);
  const [unread, setUnread] = useState<number | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [showSignature, setShowSignature] = useState(false);
  const [sectionOverrides, setSectionOverrides] = useState<Record<string, boolean>>({});

  const enabled = useMemo(
    () => new Set(modules.filter(m => m.enabled).map(m => m.key)),
    [modules]
  );
  // A module reaches the sidebar only when it is switched on for the
  // laboratory AND this user is allowed to view it. Anything else is not
  // dimmed or badged — it is simply not drawn, so nobody browses a menu of
  // work they cannot do.
  //
  // Settings is the one exception to "one module, one right": it also holds
  // delegated tools (roster building, imports, evidence), so it appears for
  // anyone who can open at least one page inside it.
  const isVisible = (key: string) => {
    if (!(enabled.size === 0 || enabled.has(key))) return false;
    return key === 'settings' ? canEnterSettings(can) : canView(key);
  };
  const moduleByKey = useMemo(() => new Map(MODULES.map(m => [m.key, m])), []);

  // Sidebar sections mirror the Home launchpad 1:1. A section renders as a
  // single link when only one of its modules is visible, or as a collapsible
  // group otherwise. The group containing the current route stays expanded.
  const sections = useMemo(() =>
    NAV_SECTIONS.map(s => ({
      ...s,
      items: s.modules.filter(isVisible).map(k => moduleByKey.get(k)).filter(Boolean) as typeof MODULES,
    })).filter(s => s.items.length > 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [enabled, moduleByKey, canView, can]
  );
  const activeSectionKey = useMemo(
    () => sections.find(s => s.items.some(m => location.pathname.startsWith(m.path)))?.key,
    [sections, location.pathname]
  );
  const sectionExpanded = (key: string) => sectionOverrides[key] ?? key === activeSectionKey;
  const toggleSection = (key: string) =>
    setSectionOverrides(o => ({ ...o, [key]: !sectionExpanded(key) }));

  // Navigating to another section clears manual overrides so the sidebar
  // follows the user again (active section open, the rest closed).
  useEffect(() => { setSectionOverrides({}); }, [activeSectionKey]);

  const showInbox = canView('notifications');

  useEffect(() => {
    if (!user || !showInbox) { setUnread(null); return; }
    let cancelled = false;
    const fetchUnread = () => {
      api<{ unreadNotifications: number }>('/dashboard/notifications-summary')
        .then(s => { if (!cancelled) setUnread(s.unreadNotifications); })
        .catch(() => {});
    };
    fetchUnread();
    const id = setInterval(fetchUnread, 60000);
    return () => { cancelled = true; clearInterval(id); };
  }, [user, showInbox]);

  // The Home route is a full-bleed launchpad with no persistent sidebar.
  if (location.pathname === '/home') return <>
    <Outlet />
    <DennisFloatingWidget user={user} dennisEnabled={isEnabled('dennis')} />
  </>;

  return (
    <div className={`app-shell ${collapsed ? 'collapsed' : ''}`}>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark"><FlaskConical size={20} /></span>
          <span className="brand-text">
            <h1>SECH_LIMS</h1>
            <span>by Nickland</span>
          </span>
        </div>

        <button className="sidebar-toggle" type="button" onClick={() => setCollapsed(c => !c)}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
          {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
          <span>Collapse</span>
        </button>

        <nav className="nav">
          <NavLink to="/home" end>
            {(() => { const I = moduleIcon('home'); return <span className="nav-ico"><I size={18} /></span>; })()}
            <span className="nav-label">Home</span>
          </NavLink>
          {sections.map((section, i) => {
            const groupLabel = (i === 0 || sections[i - 1].group !== section.group)
              ? <div className="nav-group-label">{NAV_GROUP_LABELS[section.group]}</div>
              : null;
            const Icon = sectionIcon(section.key);
            // Single-module sections are plain links labelled like the Home card.
            if (section.items.length === 1) {
              return (
                <div key={section.key}>
                  {groupLabel}
                  <NavLink to={section.items[0].path} title={section.title}>
                    <span className="nav-ico"><Icon size={18} /></span>
                    <span className="nav-label">{section.title}</span>
                  </NavLink>
                </div>
              );
            }
            const expanded = sectionExpanded(section.key);
            const active = section.key === activeSectionKey;
            return (
              <div key={section.key} className={`nav-section ${expanded ? 'open' : ''}`}>
                {groupLabel}
                <button
                  type="button"
                  className={`nav-section-head ${active ? 'active' : ''}`}
                  title={section.title}
                  aria-expanded={expanded}
                  onClick={() => toggleSection(section.key)}
                >
                  <span className="nav-ico"><Icon size={18} /></span>
                  <span className="nav-label">{section.title}</span>
                  <span className="nav-caret"><ChevronDown size={14} /></span>
                </button>
                {expanded && (
                  <div className="nav-section-items">
                    {section.items.map(m => {
                      const ItemIcon = moduleIcon(m.key);
                      return (
                        <NavLink key={m.key} to={m.path} title={m.label}>
                          <span className="nav-ico"><ItemIcon size={16} /></span>
                          <span className="nav-label">{m.label}</span>
                        </NavLink>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </nav>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="search" style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--faint)' }}>
            <Search size={16} />
            <input
              placeholder="Search documents, staff, equipment, actions, evidence…"
              style={{ border: 0, background: 'transparent', padding: 0, boxShadow: 'none', flex: 1 }}
            />
          </div>
          <div className="topbar-actions">
            <span className="health-pill"><span className="dot" /><span>System Healthy</span></span>
            {showInbox && (
              <button className="icon-btn" type="button" aria-label="Notifications" onClick={() => navigate('/notifications')}>
                <Bell size={18} />
                {unread !== null && unread > 0 && <span className="icon-badge">{unread > 99 ? '99+' : unread}</span>}
              </button>
            )}
            {/* The chip opens the dashboard, where a staff member's own profile
                now lives. It used to open Settings, which most roles may not
                even see. */}
            <button className="user-chip" type="button" title="My profile"
              onClick={() => navigate(canView('dashboard') ? '/dashboard' : '/home')}>
              <span className="user-avatar">{initials(user?.fullName)}</span>
              <span className="user-meta">
                <strong>{user?.fullName ?? 'User'}</strong>
                <span>{user?.roleName ?? 'Member'}</span>
              </span>
            </button>
            <button className="icon-btn" type="button" aria-label="My signature" title="My signature" onClick={() => setShowSignature(true)}><PenLine size={18} /></button>
            <button className="icon-btn" type="button" aria-label="Change password" title="Change password" onClick={() => setShowPassword(true)}><KeyRound size={18} /></button>
            <button className="icon-btn" type="button" aria-label="Logout" onClick={logout}><LogOut size={18} /></button>
          </div>
        </header>
        {/* An administrator can require a new password. The dialog then cannot be
          dismissed — there is nowhere else to go until it is done. */}
      {(showPassword || user?.mustChangePassword) && (
        <ChangePasswordModal
          required={Boolean(user?.mustChangePassword)}
          onClose={() => setShowPassword(false)}
          onChanged={refreshUser}
        />
      )}
        {showSignature && <SignatureModal onClose={() => setShowSignature(false)} />}

        <section className="content"><Outlet /></section>

        <DennisFloatingWidget user={user} dennisEnabled={isEnabled('dennis')} />

        <footer className="statusbar">
          <span className="ok"><Server size={13} /> Local Server · Online</span>
          <span><Database size={13} /> Database · local SQLite host</span>
          <span>Host API · {API_HOST}</span>
          <span className="status-spacer" />
          <span>SECH_LIMS by Nickland</span>
          <span title="When this build was produced. If a change you expect is missing, rebuild and restart.">
            Version 0.1.0 · build {typeof __BUILD_STAMP__ === 'string' ? __BUILD_STAMP__ : 'dev'}
          </span>
        </footer>
      </main>
    </div>
  );
}
