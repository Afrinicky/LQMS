/**
 * Native capability abstraction (Phase 2 · Native-app preparation).
 *
 * A single seam between the Companion App and device capabilities. Today every
 * function has a pure-web implementation that works inside the installable PWA;
 * when the project is wrapped with Capacitor, only this file swaps in the native
 * plugins (@capacitor/camera, @capacitor/geolocation, @capacitor/push-…). No
 * screen imports a device API directly, so the native transition is contained.
 *
 * Capabilities are also *detected* here so the UI can degrade gracefully: e.g.
 * live QR scanning needs a secure context (HTTPS/native), which is not yet
 * deployed over plain-http LAN — the scan screen reads `caps.liveCamera` and
 * offers manual entry instead of shipping an inert button.
 */

// Capacitor injects this global when running inside the native shell. Plugins
// are reached through window.Capacitor.Plugins so nothing is imported at build
// time — the PWA build has no Capacitor dependency, and the native build wires
// the real plugins in automatically.
interface CapacitorGlobal { isNativePlatform?: () => boolean; getPlatform?: () => string; Plugins?: Record<string, any> }
declare global {
  interface Window { Capacitor?: CapacitorGlobal }
}

function plugin<T = any>(name: string): T | undefined {
  return window.Capacitor?.Plugins?.[name] as T | undefined;
}

export function isNative(): boolean {
  return Boolean(window.Capacitor?.isNativePlatform?.());
}

export function platform(): 'web' | 'ios' | 'android' {
  const p = window.Capacitor?.getPlatform?.();
  return p === 'ios' || p === 'android' ? p : 'web';
}

/** A secure context (HTTPS or native) is required for the live camera/getUserMedia. */
export function isSecureContext(): boolean {
  return isNative() || (typeof window !== 'undefined' && window.isSecureContext === true);
}

export interface DeviceCapabilities {
  native: boolean;
  platform: 'web' | 'ios' | 'android';
  liveCamera: boolean;       // getUserMedia / native camera stream (needs secure ctx)
  osCamera: boolean;         // OS camera via <input capture> — works over http too
  geolocation: boolean;
  push: boolean;             // Web Push needs a secure context + service worker
  ocr: boolean;              // in-browser OCR available (native or future WASM)
}

export function capabilities(): DeviceCapabilities {
  const secure = isSecureContext();
  return {
    native: isNative(),
    platform: platform(),
    liveCamera: secure && typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia),
    osCamera: true,
    geolocation: typeof navigator !== 'undefined' && Boolean(navigator.geolocation),
    push: secure && 'serviceWorker' in navigator && 'PushManager' in window,
    ocr: isNative(),
  };
}

export interface Coords { latitude: number; longitude: number; accuracy?: number }

/** Best-effort current position. Resolves null when unavailable or denied. */
export async function getPosition(timeoutMs = 8000): Promise<Coords | null> {
  // Native: use the Geolocation plugin (handles runtime permission prompts).
  const geo = plugin('Geolocation');
  if (geo?.getCurrentPosition) {
    try {
      const pos = await geo.getCurrentPosition({ enableHighAccuracy: true, timeout: timeoutMs });
      return { latitude: pos.coords.latitude, longitude: pos.coords.longitude, accuracy: pos.coords.accuracy };
    } catch { return null; }
  }
  // Web/PWA fallback.
  return new Promise(resolve => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ latitude: pos.coords.latitude, longitude: pos.coords.longitude, accuracy: pos.coords.accuracy }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 60000 },
    );
  });
}

/** A short, stable device descriptor for signatures/audit and clock events. */
export function deviceInfo(): string {
  const p = platform();
  const shell = isNative() ? 'native' : 'pwa';
  return `${p}/${shell} · ${navigator.userAgent.slice(0, 60)}`;
}

/** Persist a device id so signatures/subscriptions can be traced to a handset. */
export function deviceId(): string {
  const KEY = 'sech_m_device_id';
  let id = localStorage.getItem(KEY);
  if (!id) { id = 'dev-' + Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem(KEY, id); }
  return id;
}

/**
 * Initialise the native shell: theme the status bar to match the app, then
 * dismiss the splash screen once the web layer is ready. No-ops in the PWA.
 */
export async function initNativeShell(): Promise<void> {
  if (!isNative()) return;
  try {
    const statusBar = plugin('StatusBar');
    await statusBar?.setStyle?.({ style: 'DARK' });
    await statusBar?.setBackgroundColor?.({ color: '#0A1322' });
  } catch { /* status bar theming is best-effort */ }
  try { await plugin('SplashScreen')?.hide?.(); } catch { /* no splash plugin */ }
}

/**
 * Register this device for native push and hand the token to the Host. Safe to
 * call after login; no-ops in the PWA (Web Push is registered separately once
 * HTTPS is available). Errors are swallowed — push is an enhancement.
 *
 * Native push is OPT-IN: @capacitor/push-notifications is not part of the
 * default build because on Android it requires Firebase, and a missing
 * google-services.json crashes the app on launch. When the plugin is absent
 * this simply no-ops. See docs/NATIVE_APP_BUILD.md to enable it with Firebase.
 */
export async function registerNativePush(postSubscribe: (endpoint: string, platform: string) => Promise<void>): Promise<void> {
  const push = plugin('PushNotifications');
  if (!isNative() || !push?.requestPermissions) return;
  try {
    const perm = await push.requestPermissions();
    if (perm?.receive !== 'granted') return;
    push.addListener?.('registration', async (token: { value: string }) => {
      try { await postSubscribe(token.value, platform()); } catch { /* retried on next launch */ }
    });
    await push.register();
  } catch { /* push registration is best-effort */ }
}

/**
 * Compress an image File before upload (bandwidth over LAN/tunnel is scarce).
 * Falls back to the original file if canvas encoding is unavailable.
 */
export async function compressImage(file: File, maxDim = 1600, quality = 0.72): Promise<File> {
  if (!file.type.startsWith('image/')) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
    const w = Math.round(bitmap.width * scale); const h = Math.round(bitmap.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, w, h);
    const blob: Blob | null = await new Promise(res => canvas.toBlob(res, 'image/jpeg', quality));
    if (!blob) return file;
    return new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' });
  } catch {
    return file;
  }
}
