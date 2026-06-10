import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { Bell, Database, Server, Shield } from 'lucide-react';
import { useEffect, useState } from 'react';
import { MODULES } from '../../shared/constants/modules';
import { useAuth } from '../hooks/useAuth';
import { useModules } from '../hooks/useModules';
import { api } from '../services/api';

export default function AppLayout() {
  const { user, logout } = useAuth();
  const { modules } = useModules();
  const navigate = useNavigate();
  const enabled = new Set(modules.filter(m => m.enabled || m.key === 'settings').map(m => m.key));
  const [unread, setUnread] = useState<number | null>(null);
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
  return <div className="app-shell"><aside className="sidebar"><div className="brand"><h1>SECH_LIMS</h1><span>by Nickland • QMS Foundation</span></div><nav className="nav">{MODULES.filter(m => enabled.size === 0 || enabled.has(m.key) || m.key === 'settings').map(m => <NavLink key={m.key} to={m.path}>{m.label}</NavLink>)}</nav></aside><main className="main"><header className="topbar"><input className="search" placeholder="Search documents, staff, actions, evidence..."/><button type="button" aria-label="Notifications" onClick={() => navigate('/notifications')} style={{ position: 'relative', background: 'transparent', border: 'none', cursor: 'pointer', padding: 4 }}><Bell color="#1B3A6B"/>{unread !== null && unread > 0 && <span style={{ position: 'absolute', top: -2, right: -4, background: '#d23a2a', color: '#fff', borderRadius: 10, padding: '0 5px', fontSize: 10, fontWeight: 700, minWidth: 16, textAlign: 'center' }}>{unread > 99 ? '99+' : unread}</span>}</button><button className="secondary" onClick={logout}>Logout</button></header><section className="content"><Outlet /></section><footer className="statusbar"><span><Database size={14}/> Database: local SQLite host</span><span><Server size={14}/> Host API: 127.0.0.1:4317</span><span>Backup: foundation ready</span><span><Shield size={14}/> User: {user?.fullName ?? 'Unknown'}</span><span>Version 0.1.0</span></footer></main></div>;
}
