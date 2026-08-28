import type { SetupStatus, SystemModule } from '../../shared/types/api';

export type OfficeOpenPayload = { storageArea: string; storedName: string; originalName: string; docId: number; versionId: number };
export type OfficeOpenResult = { ok: boolean; watchId?: string; error?: string };
export type OfficeFileChangedPayload = { watchId: string; docId: number; versionId: number; originalName: string; mimeGuess: string; bytes: Uint8Array };

declare global {
  interface Window {
    sechLims?: {
      apiBaseUrl: string;
      relaunch?: () => void;
      // "Open in Microsoft Office" round-trip — present only inside the packaged
      // Electron app; absent in the plain browser/dev-server preview.
      openInOffice?: (payload: OfficeOpenPayload) => Promise<OfficeOpenResult>;
      stopOfficeWatch?: (watchId: string) => void;
      checkOfficeNow?: (watchId: string) => Promise<{ ok: boolean; error?: string }>;
      onOfficeFileChanged?: (callback: (payload: OfficeFileChangedPayload) => void) => () => void;
    };
  }
}

// Resolve the API base URL, most-authoritative source first:
//  1. window.sechLims.apiBaseUrl — set by the Electron preload from the actual
//     host:port the embedded API bound to (handles fallback ports).
//  2. VITE_API_BASE_URL — explicit build-time override.
//  3. Same origin — the packaged app loads the renderer from
//     http://127.0.0.1:<port>/ served by the API itself, so "/api" on the same
//     origin is always correct and survives fallback ports. (Skipped on the
//     Vite dev server at :5173, where the API lives on a different port.)
//  4. Localhost default for plain browser/dev use.
//
// The native mobile app (Capacitor) is NOT served same-origin — it loads from
// capacitor://localhost — so it stores the Host address the user enters on the
// "Connect to Host" screen under API_BASE_OVERRIDE_KEY. That saved value takes
// priority so the same build reaches the Host over LAN, Tailscale or a tunnel.
export const API_BASE_OVERRIDE_KEY = 'sech_lims_api_base';

export function getApiBaseOverride(): string | null {
  try { return typeof localStorage !== 'undefined' ? localStorage.getItem(API_BASE_OVERRIDE_KEY) : null; } catch { return null; }
}
/** Persist (or clear) the Host API base URL. Caller reloads to apply. */
export function setApiBaseOverride(url: string | null) {
  try {
    if (url && url.trim()) localStorage.setItem(API_BASE_OVERRIDE_KEY, url.trim().replace(/\/+$/, ''));
    else localStorage.removeItem(API_BASE_OVERRIDE_KEY);
  } catch { /* storage unavailable */ }
}

/** True when running inside the Capacitor native shell (Android/iOS app). */
export function isNativeApp(): boolean {
  return Boolean((window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.());
}

function resolveApiBase(): string {
  const override = getApiBaseOverride();
  if (override) return `${override}/api`;
  const fromPreload = window.sechLims?.apiBaseUrl;
  if (fromPreload) return fromPreload;
  const fromEnv = import.meta.env.VITE_API_BASE_URL;
  if (fromEnv) return fromEnv;
  // A native shell has no useful same-origin (capacitor://localhost) — the app
  // routes the user to the Host-connection screen until an override is saved.
  if (!isNativeApp() && typeof location !== 'undefined' && /^https?:$/.test(location.protocol) && location.port !== '5173') {
    return `${location.origin}/api`;
  }
  return 'http://127.0.0.1:4317/api';
}

export const API_BASE = resolveApiBase();
/** Whether the app still needs the user to configure a Host address (native only). */
export function needsHostConfig(): boolean {
  return isNativeApp() && !getApiBaseOverride();
}
console.log('[renderer] API_BASE resolved to', API_BASE);

export function getToken() { return localStorage.getItem('sech_lims_token'); }
export function setToken(token: string | null) { if (token) localStorage.setItem('sech_lims_token', token); else localStorage.removeItem('sech_lims_token'); }

/**
 * A call the server refused. The status and the server's own payload travel
 * with the message, because some refusals carry an answer with them — a FEFO
 * warning names the older batch that should have been issued, and the screen
 * can only offer "issue that one instead" if it can see which one.
 */
export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly data: Record<string, unknown>, readonly method = 'GET') {
    super(message);
    this.name = 'ApiError';
  }
}

/** True when the server refused the call because of who the caller is. */
export function isPermissionDenied(e: unknown): boolean {
  return e instanceof ApiError && e.status === 403;
}

/**
 * The text a screen should put in its error banner for a failed call — empty
 * when a READ was refused on permission grounds.
 *
 * A person who may not reach something is never told they may not reach it.
 * Screens hide what their user has no right to; a red "Permission denied"
 * across a module the person legitimately opened is the opposite of that — it
 * announces the existence of the very thing that was meant to be out of sight,
 * and it does so for a restriction on one item inside the module. So a refused
 * read resolves to nothing to show. A refused WRITE keeps its message: the
 * control should have been hidden, and if one slipped through, silence would
 * leave the person clicking a button that does nothing.
 */
export function errorText(e: unknown): string {
  if (e instanceof ApiError && e.status === 403 && (e.method === 'GET' || e.method === 'HEAD')) return '';
  return e instanceof Error ? e.message : String(e ?? '');
}

/**
 * A read whose subject the caller may not be entitled to. A refusal comes back
 * as `fallback` instead of throwing, so one restricted item inside a module
 * cannot take down the loader that fetches the rest of it. Every other failure
 * (offline, server fault) still throws and still reaches the banner.
 */
export async function apiRead<T>(path: string, fallback: T): Promise<T> {
  try { return await api<T>(path); } catch (e) { if (isPermissionDenied(e)) return fallback; throw e; }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (!(options.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  const token = getToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const response = await fetch(`${API_BASE}${path}`, { ...options, headers });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText })) as Record<string, unknown>;
    throw new ApiError(String(body.error ?? response.statusText), response.status, body, String(options.method ?? 'GET').toUpperCase());
  }
  return response.json() as Promise<T>;
}

export const getSetupStatus = () => api<SetupStatus>('/setup/status');
export const getModules = () => api<SystemModule[]>('/system-modules');
