import { createContext, useContext, useEffect, useState } from 'react';
import { api, setToken as saveToken, getToken } from '../services/api';
import type { ApiUser } from '../../shared/types/api';

type AuthContextValue = { user: ApiUser | null; loading: boolean; login: (username: string, password: string) => Promise<void>; logout: () => Promise<void>; refreshUser: () => Promise<void> };
const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<ApiUser | null>(null); const [loading, setLoading] = useState(true);
  useEffect(() => { if (!getToken()) { setLoading(false); return; } api<{ user: ApiUser }>('/auth/me').then(r => setUser(r.user)).catch(() => saveToken(null)).finally(() => setLoading(false)); }, []);
  async function login(username: string, password: string) { const r = await api<{ token: string; user: ApiUser }>('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }); saveToken(r.token); setUser(r.user); }
  async function logout() { await api('/auth/logout', { method: 'POST' }).catch(() => undefined); saveToken(null); setUser(null); }
  // Re-read the account after something that changes it — clearing a required
  // password change, for instance — so the shell stops insisting on it.
  async function refreshUser() { try { const r = await api<{ user: ApiUser }>('/auth/me'); setUser(r.user); } catch { /* leave as-is */ } }
  return <AuthContext.Provider value={{ user, loading, login, logout, refreshUser }}>{children}</AuthContext.Provider>;
}
export function useAuth() { const ctx = useContext(AuthContext); if (!ctx) throw new Error('useAuth must be used inside AuthProvider'); return ctx; }
