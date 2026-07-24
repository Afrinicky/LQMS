# Remote access for the mobile companion (HTTPS for all staff)

The Staff Companion is served by the Host at `http://<host>:4317/m`. On the lab
LAN that is all you need. For staff to use it **from anywhere over the Internet**
you have two options:

1. **Tailscale** (already working) — private, encrypted, but every staff device
   must join your tailnet. Best for a handful of trusted people (admins).
2. **Cloudflare Tunnel** (this document) — gives the Host **one public HTTPS URL**
   that any staff phone can open with just their laboratory login. No per-device
   VPN, and because it is HTTPS it also unlocks browser features that plain
   `http://` blocks — **camera streaming, QR/barcode scanning and Web Push
   notifications** (future mobile phases).

The Host is never exposed with an open port. Cloudflare makes an **outbound** connection
from the Host to Cloudflare's edge; the tunnel carries traffic back. There is no
inbound firewall hole and no port-forwarding.

> Security note: exposing the Host to the Internet — even via a tunnel — means the
> Host's own login is now the front door for the whole application. Use strong
> passwords, keep the app patched, and prefer adding **Cloudflare Access** (below)
> so only authenticated staff even reach the sign-in page.

---

## Option A — Quick tunnel (5 minutes, temporary URL)

Good for a first test. The URL changes each run, so it is not for permanent rollout.

**On the Host (Windows):**
1. Download `cloudflared` for Windows from Cloudflare's downloads page and put
   `cloudflared.exe` somewhere on PATH (e.g. `C:\cloudflared\`).
2. Start the Host normally (via your `Start SECH_LIMS (Hybrid).bat`, which already
   binds `0.0.0.0:4317`).
3. In a terminal run:
   ```
   cloudflared tunnel --url http://127.0.0.1:4317
   ```
4. It prints a URL like `https://random-words.trycloudflare.com`. Staff open
   **`https://random-words.trycloudflare.com/m`** on their phones and sign in.

That's it for a demo. For a stable URL and access control, use Option B.

## Option B — Named tunnel with your own domain (permanent)

Requires a domain managed in Cloudflare (free plan is fine).

1. **Authenticate** the Host once:
   ```
   cloudflared tunnel login
   ```
2. **Create** a named tunnel and note its ID:
   ```
   cloudflared tunnel create sech-lims
   ```
3. **Route** a hostname to it (pick any subdomain of your domain):
   ```
   cloudflared tunnel route dns sech-lims lab.example.com
   ```
4. **Config** — create `C:\Users\hp\.cloudflared\config.yml`:
   ```yaml
   tunnel: sech-lims
   credentials-file: C:\Users\hp\.cloudflared\<TUNNEL-ID>.json
   ingress:
     - hostname: lab.example.com
       service: http://127.0.0.1:4317
     - service: http_status:404
   ```
5. **Run** it (and install as a service so it starts with Windows):
   ```
   cloudflared tunnel run sech-lims
   cloudflared service install
   ```
6. Staff open **`https://lab.example.com/m`** and sign in. The full desktop app is
   also reachable at `https://lab.example.com/` — restrict that with Access (below).

## Recommended — lock the front door with Cloudflare Access

Put the tunnel behind **Cloudflare Zero Trust → Access** so only approved people
reach the app at all (a second factor before the Host's own login):

1. In the Cloudflare Zero Trust dashboard, add an **Application** for
   `lab.example.com`.
2. Add a **policy** allowing only your staff — e.g. emails ending `@sechlab.gov.gh`,
   or a named list, with a one-time-PIN or Google login.
3. Optionally scope it: allow everyone to `/m*` (the companion) but require an
   admin group for `/` (the full app).

Now a staff phone: Cloudflare Access verifies the person → the SECH_LIMS sign-in
page loads → they log in with their lab account → RBAC applies as usual. Three
layers: Access, app login, per-role permissions.

---

## Which URL does the app use?

The companion always calls `/api` on **the same origin it was opened from**, so it
needs no configuration:

| Opened at | Talks to |
|---|---|
| `http://<LAN-IP>:4317/m` | Host on the LAN |
| `http://<tailscale-ip>:4317/m` | Host over Tailscale |
| `https://lab.example.com/m` | Host via Cloudflare Tunnel |

Staff can install (Add to Home Screen) from whichever URL they normally use.
For a mixed rollout, the **HTTPS tunnel URL works everywhere** (in the lab too), so
standardising on it is simplest — and it is the one that enables push/QR later.

## Keeping it running

- Install `cloudflared` as a Windows **service** (step 5) so the tunnel restarts
  with the machine, alongside the Host.
- The Host PC must stay **on and awake** (Power settings → never sleep) for either
  Tailscale or the tunnel to serve clients.
- Rotate Cloudflare Access membership when staff join/leave; disable a lost phone
  from the Host's user administration as usual.

## What this unlocks for later mobile phases

Once the companion is served over HTTPS (tunnel), these become available and can
be added to the app:

- **Web Push** — task-assigned / stock-low / review-due notifications to phones.
- **QR / barcode scanning** — scan an equipment asset tag or inventory label to
  jump straight to its record or pre-fill a capture form.
- **Live camera** capture (in addition to the file-input photo that already works).

These are intentionally not built yet because they are inert over plain `http://`.
