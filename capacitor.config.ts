/**
 * Capacitor configuration — Native Mobile Application preparation (Phase 2 · §9).
 *
 * The Companion App ships today as an installable PWA and stays fully functional
 * as one. This config prepares a straightforward Capacitor wrap for a native
 * Android build (and later iOS) with minimal change: all device access already
 * goes through mobile/native.ts, so wrapping only swaps that seam's web
 * implementations for the native plugins.
 *
 * This file is intentionally dependency-light: it is a plain config object and is
 * not compiled into the app bundle. To produce a native build:
 *
 *   npm i -D @capacitor/cli @capacitor/core @capacitor/android
 *   npm i @capacitor/camera @capacitor/geolocation @capacitor/push-notifications \
 *         @capacitor/preferences @capacitor/filesystem
 *   npm run build            # emits dist/ (webDir below)
 *   npx cap add android
 *   npx cap sync
 *   npx cap open android
 *
 * `server.url` can point the native shell at a Host over the LAN/Tailscale/tunnel
 * during development; for production the built assets are bundled and the app
 * calls the Host API same-origin exactly as the PWA does.
 */
const config = {
  appId: 'gh.nickland.sechlims.companion',
  appName: 'SECH_LIMS Staff',
  webDir: 'dist',
  // The mobile entry is served at mobile.html; the native shell loads it directly.
  loggingBehavior: 'production',
  android: {
    allowMixedContent: true, // permits http Host access on the lab LAN
    captureInput: true,
  },
  plugins: {
    PushNotifications: { presentationOptions: ['badge', 'sound', 'alert'] },
    // Camera / Geolocation / Filesystem use their defaults; mobile/native.ts
    // reads capabilities() at runtime and enables live scanning + OCR on native.
  },
};

export default config;
