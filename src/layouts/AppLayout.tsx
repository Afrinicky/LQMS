import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Bell, Database, Server, LogOut, PanelLeftClose, PanelLeftOpen, Search, FlaskConical } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { MODULES } from '../../shared/constants/modules';
import { useAuth } from '../hooks/useAuth';
import { useModules } from '../hooks/useModules';
import { api } from '../services/api';
import { moduleIcon } from '../components/ui/moduleIcons';

/** Logical groups for the sidebar navigation. */
const NAV_GROUPS: { label: string; keys: string[] }[] = [
  { label: 'Overview', keys: ['dashboard'] },
  { label: 'Quality & Compliance', keys: ['documents', 'nc_capa', 'complaints', 'risks', 'assessments', 'customer_focus', 'actions'] },
  { label: 'Operations', keys: ['equipment', 'monitoring', 'supplier_inventory', 'facilities_safety', 'process_management'] },
  { label: 'Technical Quality', keys: ['iqc', 'eqa', 'verification_validation', 'measurement_uncertainty', 'poct', 'blood_bank_handover'] },
  { label: 'People & Governance', keys: ['personnel', 'organisation', 'meetings', 'management_review', 'quality_indicators', 'continual_improvement'] },
  { label: 'Records & System', keys: ['records_reports', 'information_management', 'monthly_reports', 'notifications', 'settings'] },
];

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
  const { user, logout } = useAuth();
  const { modules } = useModules();
  const navigate = useNavigate();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(false);
  const [unread, setUnread] = useState<number | null>(null);

  const enabled = useMemo(
    () => new Set(modules.filter(m => m.enabled || m.key === 'settings').map(m => m.key)),
    [modules]
  );
  const isVisible = (key: string) => enabled.size === 0 || enabled.has(key) || key === 'settings';
  const moduleByKey = useMemo(() => new Map(MODULES.map(m => [m.key, m])), []);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    const fetchUnread = () => {
      api<{ unreadNotifications: number }>('/dashboard/notifications-summary')
        .then(s => { if (!cancelled) setUnread(s.unreadNotifications); })
        .catch(() => {});
    };
    fetchUnread();
    const id = setInterval(fetchUnread, 60000);
    return () => { cancelled = true; clearInterval(id); };
  }, [user]);

  // The Home route is a full-bleed launchpad with no persistent sidebar.
  if (location.pathname === '/home') return <Outlet />;

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
          {NAV_GROUPS.map(group => {
            const items = group.keys.filter(isVisible).map(k => moduleByKey.get(k)).filter(Boolean) as typeof MODULES;
            if (items.length === 0) return null;
            return (
              <div key={group.label}>
                <div className="nav-group-label">{group.label}</div>
                {items.map(m => {
                  const Icon = moduleIcon(m.key);
                  return (
                    <NavLink key={m.key} to={m.path} title={m.label}>
                      <span className="nav-ico"><Icon size={18} /></span>
                      <span className="nav-label">{m.label}</span>
                    </NavLink>
                  );
                })}
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
            <button className="icon-btn" type="button" aria-label="Notifications" onClick={() => navigate('/notifications')}>
              <Bell size={18} />
              {unread !== null && unread > 0 && <span className="icon-badge">{unread > 99 ? '99+' : unread}</span>}
            </button>
            <button className="user-chip" type="button" onClick={() => navigate('/settings')}>
              <span className="user-avatar">{initials(user?.fullName)}</span>
              <span className="user-meta">
                <strong>{user?.fullName ?? 'User'}</strong>
                <span>{(user as any)?.role ?? (user as any)?.position ?? 'Member'}</span>
              </span>
            </button>
            <button className="icon-btn" type="button" aria-label="Logout" onClick={logout}><LogOut size={18} /></button>
          </div>
        </header>

        <section className="content"><Outlet /></section>

        <footer className="statusbar">
          <span className="ok"><Server size={13} /> Local Server · Online</span>
          <span><Database size={13} /> Database · local SQLite host</span>
          <span>Host API · {API_HOST}</span>
          <span className="status-spacer" />
          <span>SECH_LIMS by Nickland</span>
          <span>Version 0.1.0</span>
        </footer>
      </main>
    </div>
  );
}
