/**
 * Capacitor configuration — native Android / iOS packaging.
 *
 * The Companion App ships as an installable PWA and stays fully functional as
 * one. This config wraps the SAME app as a native binary for the Google Play
 * Store and Apple App Store. All device access goes through mobile/native.ts, so
 * the native build reuses the web code unchanged.
 *
 * Build the native web assets first, then sync:
 *
 *   npm run build:mobile        # → dist-mobile/ (webDir below)
 *   npx cap add android         # once, creates android/
 *   npx cap add ios             # once, creates ios/ (needs macOS + Xcode)
 *   npm run cap:sync            # copies dist-mobile/ into the native projects
 *   npx cap open android        # build a signed AAB in Android Studio → Play
 *   npx cap open ios            # archive in Xcode → App Store
 *
 * See docs/NATIVE_APP_BUILD.md for the full store-submission runbook.
 *
 * The app is not served same-origin in the native shell, so on first launch it
 * asks the user for the Host address (LAN IP, Tailscale, or Cloudflare Tunnel)
 * and reaches the same REST API as the PWA.
 */
import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'gh.nickland.sechlims.companion',
  appName: 'SECH_LIMS Staff',
  webDir: 'dist-mobile',
  // Allow cleartext (http) traffic so the app can reach a Host over the lab LAN
  // or Tailscale. Over a Cloudflare Tunnel it uses https automatically.
  server: {
    androidScheme: 'https',
    cleartext: true,
  },
  android: {
    allowMixedContent: true,
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 800,
      backgroundColor: '#0A1322',
      showSpinner: false,
    },
    // NOTE: native Push Notifications are intentionally NOT enabled by default.
    // On Android, @capacitor/push-notifications pulls in Firebase Cloud
    // Messaging, and Firebase's startup ContentProvider CRASHES the app on
    // launch ("Default FirebaseApp is not initialized") when no valid
    // google-services.json is bundled — which looks like the app closing itself
    // the moment it opens. The app is fully functional without push. To turn it
    // back on: install @capacitor/push-notifications, add a real
    // google-services.json (Firebase console) into android/app/, re-add the
    // PushNotifications config block here, then `npm run cap:sync`. See
    // docs/NATIVE_APP_BUILD.md → "App closes immediately on launch (Android)".
  },
};

export default config;
