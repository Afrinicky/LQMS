import type { SetupStatus, SystemModule } from '../../shared/types/api';

declare global { interface Window { sechLims?: { apiBaseUrl: string; relaunch?: () => void } } }

// Resolve the API base URL, most-authoritative source first:
//  1. window.sechLims.apiBaseUrl — set by the Electron preload from the actual
//     host:port the embedded API bound to (handles fallback ports).
//  2. VITE_API_BASE_URL — explicit build-time override.
//  3. Same origin — the packaged app loads the renderer from
//     http://127.0.0.1:<port>/ served by the API itself, so "/api" on the same
//     origin is always correct and survives fallback ports. (Skipped on the
//     Vite dev server at :5173, where the API lives on a different port.)
//  4. Localhost default for plain browser/dev use.
function resolveApiBase(): string {
  const fromPreload = window.sechLims?.apiBaseUrl;
  if (fromPreload) return fromPreload;
  const fromEnv = import.meta.env.VITE_API_BASE_URL;
  if (fromEnv) return fromEnv;
  if (typeof location !== 'undefined' && /^https?:$/.test(location.protocol) && location.port !== '5173') {
    return `${location.origin}/api`;
  }
  return 'http://127.0.0.1:4317/api';
}

export const API_BASE = resolveApiBase();
console.log('[renderer] API_BASE resolved to', API_BASE);

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
