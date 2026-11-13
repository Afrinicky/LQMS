import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import {
  Cable, LogOut, PanelLeftClose, PanelLeftOpen, Radio, Settings2, Waypoints,
} from 'lucide-react';
import { useAuth } from '../../src/hooks/useAuth';
import { ThemeToggle } from '../../src/components/ui/ThemeToggle';
import { useInstallation } from './useInstallation';

/**
 * The application frame: SECHLIMS's own, with three entries instead of
 * fourteen.
 *
 * The same markup and the same stylesheet, so a laboratory that runs both
 * recognises one as the other's middleware rather than as a different piece of
 * software that happens to be beside it.
 */
function initials(name?: string | null) {
  if (!name) return 'U';
  const parts = String(name).trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || 'U';
}

export default function Shell({ configures, children }: { configures: boolean; children: React.ReactNode }) {
  const { user, logout } = useAuth();
  const { installation } = useInstallation();
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className={`app-shell ${collapsed ? 'collapsed' : ''}`}>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark"><Waypoints size={20} /></span>
          <span className="brand-text">
            <h1>TransLis</h1>
            <span>by Nickland</span>
          </span>
        </div>

        <button className="sidebar-toggle" type="button" onClick={() => setCollapsed(c => !c)}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
          {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
          <span>Collapse</span>
        </button>

        <nav className="nav">
          <div className="nav-group-label">Transmission</div>
          <NavLink to="/transmission" title="Analyser Transmission &amp; Middleware">
            <span className="nav-ico"><Radio size={18} /></span>
            <span className="nav-label">Transmission &amp; Middleware</span>
          </NavLink>

          {configures && <>
            <div className="nav-group-label">Configuration</div>
            <NavLink to="/analyser-sync" title="Analyser Sync &amp; Interfacing">
              <span className="nav-ico"><Cable size={18} /></span>
              <span className="nav-label">Analyser Sync &amp; Interfacing</span>
            </NavLink>
            <NavLink to="/settings" title="Settings">
              <span className="nav-ico"><Settings2 size={18} /></span>
              <span className="nav-label">Settings</span>
            </NavLink>
          </>}
        </nav>
      </aside>

      <main className="main">
        <header className="topbar">
          {/* Where the software is standing. It governs what the configuration
              screens offer, so it is stated rather than buried in Settings. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--faint)' }}>
            {installation && (
              <span className="health-pill">
                <span className="dot" />
                <span>{installation.modeLabel}</span>
              </span>
            )}
          </div>
          <div className="topbar-actions">
            <span className="user-chip" style={{ cursor: 'default' }}>
              <span className="user-avatar">{initials(user?.fullName)}</span>
              <span className="user-meta">
                <strong>{user?.fullName ?? 'User'}</strong>
                <span>{user?.roleName ?? 'Staff'}</span>
              </span>
            </span>
            <ThemeToggle />
            <button className="icon-btn" type="button" aria-label="Sign out" title="Sign out"
              onClick={() => { void logout(); }}><LogOut size={18} /></button>
          </div>
        </header>

        <section className="content">{children}</section>
      </main>
    </div>
  );
}
