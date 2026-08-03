# Installing the SECH_LIMS Staff Companion without an app store

You do **not** need the Google Play Store or Apple App Store. There are three
no‑store ways to install the app; pick what suits each device.

| Method | Android | iPhone / iPad | Needs HTTPS? | Best for |
|---|---|---|---|---|
| **1. Add to Home Screen (PWA)** | ✅ | ✅ | Recommended (required for the Android install prompt) | Everyone; zero download |
| **2. APK from GitHub Releases** | ✅ | ❌ (not possible on iOS) | No — works on LAN/Tailscale | A real installable Android app on the lab network |
| **3. Mobile PWA hosted on Vercel** | ✅ | ✅ | Yes (Host must be HTTPS) | All‑staff internet access via a tunnel |

---

## 1. Add to Home Screen (PWA) — no download, all platforms

The app is a Progressive Web App, so any phone can install it from the browser.

**Android (Chrome):**
1. Open the Host address in Chrome, e.g. `http://<host>:4317/m` (or the HTTPS
   tunnel URL).
2. The app shows an **Install the app** card under **Me** — tap **Install**.
   (Or use Chrome’s ⋮ menu ▸ *Install app* / *Add to Home screen*.)
3. It appears on the home screen with its own icon and runs full‑screen.

> The Android install button only appears over **HTTPS**. On a plain‑http LAN,
> use method 2, or serve the Host behind a Cloudflare Tunnel.

**iPhone / iPad (Safari):**
1. Open the Host address in **Safari** (not Chrome).
2. Tap the **Share** icon, then **Add to Home Screen**. (The app’s **Me** screen
   shows a **How** button with these steps.)
3. Launch it from the new home‑screen icon.

This is the only no‑store route for iPhone, and it works even over plain‑http LAN.

## 2. APK from GitHub Releases — installable Android app, no store

A signed APK is published on the repository’s **Releases** page by the
*Build Android APK* GitHub Action.

1. On the phone, open the repo’s **Releases** and download `SECH_LIMS-Staff.apk`.
2. Tap the downloaded file. If prompted, allow **Install unknown apps** for your
   browser/Files app (Android Settings ▸ Apps ▸ Special access).
3. Install and open. On first launch, enter your Host address (LAN IP, Tailscale,
   or tunnel URL) on the **Connect to Host** screen.

Because the native app allows cleartext, this works on the lab LAN and over
Tailscale **without** a tunnel.

**Publishing an APK:** create a GitHub Release (or run the *Build Android APK*
workflow manually). With no secrets it builds a debug‑signed APK that installs
fine; to ship a release‑signed one, set the `ANDROID_KEYSTORE_*` repository
secrets (see the workflow header comment). iOS cannot be side‑loaded this way —
use method 1 for iPhones.

## 3. Mobile PWA hosted on Vercel — one HTTPS URL for everyone

Serve the installable PWA from Vercel so staff install it from a single web
address. This is a **separate** deployment from the existing Remote Staff Portal
and does not affect it.

```bash
npm run build:mobile:vercel        # builds dist-mobile/ with a Vercel config
npx vercel deploy --prod dist-mobile
```

Then staff open the Vercel URL and **Add to Home Screen** (method 1).

> **Important — mixed content:** a page served over HTTPS (Vercel) cannot call a
> Host over plain `http://`. So the Host must be reachable over **HTTPS** — i.e.
> behind a **Cloudflare Tunnel**. Over the LAN/Tailscale (http) use method 1 from
> the Host’s own `/m` URL, or method 2. The app’s **Connect to Host** override
> lets you point it at the tunnel URL.

---

## Which should I use?

- **Just want it working now, any phone:** method 1 from the Host’s `/m` URL.
- **A proper installable Android app on the lab network:** method 2 (GitHub APK).
- **All staff over the internet, no per‑device VPN:** stand up a Cloudflare
  Tunnel, then method 1 or 3 against the HTTPS URL.

See `docs/NATIVE_APP_BUILD.md` for full store builds if you ever want them, and
`docs/MOBILE_REMOTE_ACCESS.md` for the tunnel setup.
