/**
 * PWA install support — lets staff install the app straight from the browser
 * (Add to Home Screen), no store or download required.
 *
 * Android/Chromium fires `beforeinstallprompt`, which we capture so the app can
 * show its own "Install" button and trigger the native prompt on demand. iOS
 * Safari has no such event, so the UI shows the manual Share ▸ Add to Home
 * Screen steps instead. Capture is registered from main.tsx before React mounts
 * so the (early) event is not missed.
 */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferred: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(l => l());

export function initInstallCapture() {
  if (typeof window === 'undefined') return;
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferred = e as BeforeInstallPromptEvent; notify(); });
  window.addEventListener('appinstalled', () => { deferred = null; notify(); });
}

export function onInstallStateChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function isIOS(): boolean {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

/** Already installed / running as an installed app? Then hide install prompts. */
export function isStandalone(): boolean {
  return (typeof window !== 'undefined' && window.matchMedia?.('(display-mode: standalone)').matches)
    || (navigator as unknown as { standalone?: boolean }).standalone === true;
}

export function canPromptInstall(): boolean { return deferred !== null; }

/** Trigger the browser's native install prompt (Android/Chromium). */
export async function promptInstall(): Promise<boolean> {
  if (!deferred) return false;
  await deferred.prompt();
  const choice = await deferred.userChoice;
  deferred = null; notify();
  return choice.outcome === 'accepted';
}
