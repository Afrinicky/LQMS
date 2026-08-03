# SECH_LIMS Companion — Native Android / iOS build & store submission

The Companion App runs as an installable PWA **and** can be packaged as a native
Android and iOS app for the Google Play Store and Apple App Store using
[Capacitor](https://capacitorjs.com). The native build wraps the **same** web
app — no separate codebase.

The repository is already wired for this:

- `vite.mobile.config.ts` + `npm run build:mobile` → `dist-mobile/` (the web
  assets Capacitor bundles, with a relative base and `index.html` entry).
- `capacitor.config.ts` → app id `gh.nickland.sechlims.companion`, `webDir: dist-mobile`.
- `mobile/native.ts` → the single device-capability seam (camera, geolocation,
  push, image compression); it uses Capacitor plugins at runtime when present.
- `mobile/HostSetup.tsx` → first-launch screen to point the app at the Host.
- `build-resources/mobile/{icon,splash}.png` → app-store icon & splash sources.

You run the store builds on your own machine (they need the Android/iOS SDKs and
your signing keys / developer accounts, which never live in this repo).

---

## 0. One-time prerequisites

- **Node 18+** and this repo installed: `npm install` (pulls the Capacitor deps
  already listed in `package.json`).
- **Android:** [Android Studio](https://developer.android.com/studio) (includes
  the SDK + JDK). A Google Play Console account ($25 one-time).
- **iOS (macOS only):** Xcode + CocoaPods (`sudo gem install cocoapods`). An
  Apple Developer Program account ($99/yr).

---

## 1. Create the native projects (once)

```bash
npm run build:mobile          # produces dist-mobile/
npx cap add android           # creates android/
npx cap add ios               # creates ios/  (macOS only)
```

This scaffolds native `android/` and `ios/` projects that reference `dist-mobile/`.
Commit them if you want them under version control, or regenerate any time.

## 2. Generate the app icons & splash

```bash
node scripts/generate-native-assets.mjs   # refreshes build-resources/mobile/*
npm run mobile:assets                      # @capacitor/assets → all densities
```

`npm run mobile:assets` expands `build-resources/mobile/icon.png` (1024²) and
`splash.png` (2732²) into every Android mipmap and iOS asset-catalog size.

## 3. Sync web → native (every time the app changes)

```bash
npm run cap:sync              # build:mobile + cap sync (android + ios)
```

Use this after any code change. It rebuilds `dist-mobile/` and copies it into the
native projects.

## 4a. Android — build a release AAB for Play

```bash
npm run cap:android           # build + sync + open Android Studio
```

In Android Studio:

1. **Build ▸ Generate Signed Bundle / APK ▸ Android App Bundle**.
2. Create (once) an upload keystore and **keep it safe** — Play signs with it
   forever. Store the passwords in your password manager, never in the repo.
3. Set the build variant to **release** and finish → produces `app-release.aab`.
4. In the **Play Console**: create the app, complete the store listing, data-safety
   and content-rating forms, then upload the `.aab` to Internal testing →
   Production.

Version bumps live in `android/app/build.gradle` (`versionCode` must increase
each upload). Keep `applicationId` = `gh.nickland.sechlims.companion`.

## 4b. iOS — archive for the App Store (macOS)

```bash
npm run cap:ios               # build + sync + open Xcode
```

In Xcode:

1. Select the **App** target ▸ **Signing & Capabilities** ▸ choose your Team
   (automatic signing is fine).
2. Set the Bundle Identifier to `gh.nickland.sechlims.companion`.
3. **Product ▸ Archive**, then **Distribute App ▸ App Store Connect**.
4. In **App Store Connect**: create the app record, fill the listing and privacy
   details, attach the build, and submit for review.

---

## 5. Connecting the installed app to the Host

Because the native app is not served by the Host, on first launch it shows a
**Connect to Host** screen. The user enters the Host address once:

| Where they are | Address to enter |
|---|---|
| On the lab Wi-Fi / LAN | the Host LAN IP + port, e.g. `192.168.1.20:4317` |
| Remote via Tailscale | the Host Tailscale address, e.g. `100.x.y.z:4317` |
| Remote via Cloudflare Tunnel | the `https://…` tunnel URL |

It is saved on the device and reused; it can be changed later under
**Me ▸ Notifications ▸ Host connection**. Login and RBAC are unchanged — the app
authenticates against the Host exactly like the PWA.

> Cleartext (http) LAN access is enabled in `capacitor.config.ts`
> (`cleartext: true`). For public distribution, prefer serving the Host behind a
> Cloudflare Tunnel so staff connect over `https`.

## 6. What lights up natively

`mobile/native.ts` detects the native shell and enables, with no code change:

- **Geolocation** for clock-in via the Geolocation plugin (permission-prompted).
- **Status bar / splash** theming.
- The live **QR/barcode scanner** (secure context) and **camera** capture.
- **Push notifications** — opt-in; see the note below.

The PWA build contains **no** Capacitor dependency — plugins are reached through
the `window.Capacitor` global that only exists inside the native shell, so the
web app is unaffected.

## Troubleshooting: the app closes immediately on launch (Android)

If, right after installing, the app opens and then closes itself within a second
(no error, no white screen), the usual cause is **native Push Notifications
without Firebase**. `@capacitor/push-notifications` on Android integrates
Firebase Cloud Messaging, and Firebase's startup provider crashes the whole app
(`Default FirebaseApp is not initialized in this process`) when there is no valid
`google-services.json` in `android/app/`.

To confirm, plug the phone in and run:

```
adb logcat | grep -i "FirebaseApp\|AndroidRuntime\|sechlims"
```

**This is why native push is off by default.** The app is fully functional
without it, so nothing else needs to change to get a working build.

### Re-enabling native push (only when you have Firebase)

1. Create a Firebase project and register the Android app with the id
   `gh.nickland.sechlims.companion`.
2. Download `google-services.json` and place it in `android/app/`.
3. `npm install @capacitor/push-notifications@^6`.
4. Re-add the `PushNotifications` block under `plugins` in `capacitor.config.ts`.
5. `npm run cap:sync`, rebuild.

`registerNativePush()` in `mobile/native.ts` already no-ops when the plugin is
absent, so no application code changes are needed either way.

Any *other* startup failure now shows an on-screen error (with a Reload button)
instead of a blank screen — capture that text if you see it and share it.

## 7. Updating a published app

1. Make code changes as usual.
2. Bump the version (`android/app/build.gradle` `versionCode`/`versionName`;
   Xcode target version/build).
3. `npm run cap:sync`, rebuild the AAB / archive, and upload the new build.

The PWA (served at `/m`) updates instantly on the next load; only store builds
need re-submission.
