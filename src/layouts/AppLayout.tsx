import { NavLink, Outlet } from 'react-router-dom';
import { Bell, Database, Server, Shield } from 'lucide-react';
import { MODULES } from '../../shared/constants/modules';
import { useAuth } from '../hooks/useAuth';
import { useModules } from '../hooks/useModules';

export default function AppLayout() {
  const { user, logout } = useAuth(); const { modules } = useModules();
  const enabled = new Set(modules.filter(m => m.enabled || m.key === 'settings').map(m => m.key));
  return <div className="app-shell"><aside className="sidebar"><div className="brand"><h1>SECH_LIMS</h1><span>by Nickland • QMS Foundation</span></div><nav className="nav">{MODULES.filter(m => enabled.size === 0 || enabled.has(m.key) || m.key === 'settings').map(m => <NavLink key={m.key} to={m.path}>{m.label}</NavLink>)}</nav></aside><main className="main"><header className="topbar"><input className="search" placeholder="Search documents, staff, actions, evidence..."/><Bell color="#1B3A6B"/><button className="secondary" onClick={logout}>Logout</button></header><section className="content"><Outlet /></section><footer className="statusbar"><span><Database size={14}/> Database: local SQLite host</span><span><Server size={14}/> Host API: 127.0.0.1:4317</span><span>Backup: foundation ready</span><span><Shield size={14}/> User: {user?.fullName ?? 'Unknown'}</span><span>Version 0.1.0</span></footer></main></div>;
}
