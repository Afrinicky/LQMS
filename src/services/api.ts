import type { SetupStatus, SystemModule } from '../../shared/types/api';

declare global { interface Window { sechLims?: { apiBaseUrl: string } } }
export const API_BASE = window.sechLims?.apiBaseUrl ?? import.meta.env.VITE_API_BASE_URL ?? 'http://127.0.0.1:4317/api';

export function getToken() { return localStorage.getItem('sech_lims_token'); }
export function setToken(token: string | null) { if (token) localStorage.setItem('sech_lims_token', token); else localStorage.removeItem('sech_lims_token'); }

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (!(options.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  const token = getToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const response = await fetch(`${API_BASE}${path}`, { ...options, headers });
  if (!response.ok) throw new Error((await response.json().catch(() => ({ error: response.statusText }))).error ?? response.statusText);
  return response.json() as Promise<T>;
}

export const getSetupStatus = () => api<SetupStatus>('/setup/status');
export const getModules = () => api<SystemModule[]>('/system-modules');
