# Clients — LAN access, mobile PWA, and the desktop thin client

> Phase 4 of the offline-first hybrid architecture. See
> `docs/HYBRID_ARCHITECTURE_PLAN.md`. The Host PC remains the single source of
> truth; every client below talks to the same Host `/api` over the LAN.

## Prerequisite: expose the Host on the LAN

By default the Host binds to loopback only (private to the Host PC). To let other
machines connect, start the Host with:

```
SECH_LIMS_API_HOST=0.0.0.0
SECH_LIMS_MODE=hybrid
```

Then allow the API port (default `4317`) through the Windows firewall. In the app,
**Settings → System → Connectivity & Mode** shows whether the LAN is exposed and
lists the exact client URLs (e.g. `http://192.168.1.50:4317/`).

Nothing about this depends on the internet — it is all local network.

## 1. Mobile clients — Progressive Web App (PWA)

The web app is installable. On a phone/tablet on the same network:

1. Open the Host URL in the browser, e.g. `http://192.168.1.50:4317/`.
2. Use the browser's **Install app / Add to Home screen** option.
3. Launch it from the home screen — it runs full-screen like a native app.

Assets that make this work (served by the Host, verified over HTTP):

- `/manifest.webmanifest` — app name, icons, standalone display.
- `/sw.js` — the service worker.
- `/icon-192.png`, `/icon-512.png`, `/icon-maskable-512.png`, `/icon.svg`,
  `/apple-touch-icon.png` — icons (regenerate with
  `node scripts/generate-pwa-icons.mjs`).

### Offline behaviour and the data-safety rule

The service worker caches only the **app shell** (HTML/JS/CSS/icons) so the
interface launches fast and still opens during a brief network blip. It
**never caches `/api` responses** — laboratory data (results, QC, alerts) is
always fetched live from the Host, because a stale cached record could be
clinically misleading. When the Host is unreachable, the shell loads but data
views show their normal "cannot reach server" state rather than stale numbers.

## 2. Desktop clients

### Option A — plain browser (no install)

Staff open the Host URL in Chrome or Edge: `http://192.168.1.50:4317/`. This
works with zero extra setup once the Host is exposed on the LAN. It can also be
installed as a desktop PWA from the browser's address-bar install icon.

### Option B — Electron thin client

The same desktop application can run as a **thin client** that connects to the
Host instead of embedding its own API. On the client PC, set:

```
SECH_LIMS_HOST_URL=http://192.168.1.50:4317
```

Then launch the app. In this mode it:

- does **not** start a local API or open the local database;
- loads the UI from the Host and points every request at the Host's `/api`
  (passed to the renderer via a startup argument, so it is reliable regardless
  of process environment timing);
- shows a clear, actionable error screen if the Host is unreachable.

Leave `SECH_LIMS_HOST_URL` **unset** on the Host PC — without it the app behaves
exactly as before (embedded API + local database), so existing installs are
unchanged.

## Remote access (later phase — not built yet)

The same clients will reach the Host from outside the building once secure remote
access is added (reverse proxy / VPN / tunnel in front of `/api`, surfaced via
`SECH_LIMS_PUBLIC_URL`). No client code changes are needed because every client
already targets a configurable base URL. See `docs/HYBRID_ARCHITECTURE_PLAN.md`.
```
