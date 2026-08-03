# Deployment runbook — Neon cloud + Vercel Remote Staff Portal

End-to-end steps to take SECH_LIMS from LAN-only to a cloud-synced Host with a
hosted Remote Staff Portal. Do the steps in order. See `docs/CLOUD_SYNC.md` and
`docs/CLOUD_SECURITY.md` for the concepts.

## Architecture recap

```
 Host PC (authoritative)  --push/pull-->  Neon PostgreSQL  <--reads/writes--  Vercel portal (staff)
   SQLite + full app                       synced_records                       portal/ + api/
   provisions accounts                     cloud_users                          per-staff login (JWT)
   applies submissions                     remote_submissions                   propose / approve
```

The Host is always the source of truth. Nothing here is required for the LAN app
to keep working; it is all opt-in.

## Where each secret lives

| Secret / var | Set on | Purpose |
|---|---|---|
| `SECH_LIMS_CLOUD_URL` | **Host** | Owner connection to Neon (sync + provisioning). |
| `SECH_LIMS_SYNC_ENABLED=true` | **Host** | Turns sync on. |
| `PORTAL_DATABASE_URL` | **Vercel** | Restricted portal role (least privilege). |
| `CLOUD_JWT_SECRET` | **Vercel** | Signs portal login tokens. (Host does NOT need it.) |

Keep all of these out of git. `.env` is already gitignored.

---

## Step 1 — Create the Neon database

There are two ways; use whichever your Neon account offers.

**Option A — standalone Neon (neon.tech):**
1. Sign up at **neon.tech**, create a **Project** (region close to the lab).
2. It creates a database (e.g. `neondb`). Copy the **owner connection string**:
   ```
   postgresql://OWNER:PASSWORD@ep-xxxx.REGION.aws.neon.tech/neondb?sslmode=require
   ```

**Option B — via the Vercel + Neon integration** (if Neon says *"To create a new
project, use the Neon Postgres integration in Vercel"*):
1. First import this repo as a **Vercel project** (Step 4.1–4.2 below) so it exists.
2. In that Vercel project → **Storage → Create Database → Neon (Serverless
   Postgres)** and follow the prompts. This creates the Neon project, links it,
   and **auto-injects `DATABASE_URL`** (and pooled/unpooled variants) into the
   Vercel project's environment — so the portal has its connection with no manual
   env var.
3. Open the database from Vercel (**Storage → your DB → Open in Neon**, or the
   Neon console) to (a) copy a connection string for the **Host**, and (b) run
   SQL in Step 3. Use the string ending in `?sslmode=require`.

Either way you end up with a Neon connection string. The **Host** uses it as
`SECH_LIMS_CLOUD_URL`; the **portal** uses `PORTAL_DATABASE_URL` (or the
integration-injected `DATABASE_URL` as a fallback).

## Step 2 — Point the Host at Neon and start syncing

On the Host, add to your launcher (`.bat`) or system environment:
```
SECH_LIMS_MODE=hybrid
SECH_LIMS_SYNC_ENABLED=true
SECH_LIMS_CLOUD_URL=postgresql://OWNER:PASSWORD@ep-xxxx.REGION.aws.neon.tech/neondb?sslmode=require
```
Restart the Host. On boot it will:
- create `synced_records`, `cloud_users`, `remote_submissions` in Neon,
- back-fill existing records and keep syncing (~every 60s).

**Verify:** Settings → System → Connectivity & Mode shows *Cloud endpoint
configured: Yes* and a dropping *pending outbox*; or in Neon's SQL editor:
```sql
SELECT count(*) FROM synced_records;
```
The Host must have outbound internet to Neon (TLS, port 5432).

## Step 3 — Create the least-privilege portal role (Neon SQL editor, as owner)

Run once, **after** Step 2 has created the tables:
```sql
CREATE ROLE portal_api LOGIN PASSWORD 'a-long-random-secret';
GRANT CONNECT ON DATABASE neondb TO portal_api;      -- your db name
GRANT USAGE ON SCHEMA public TO portal_api;
GRANT SELECT ON synced_records TO portal_api;
GRANT SELECT, UPDATE ON cloud_users TO portal_api;
GRANT SELECT, INSERT, UPDATE ON remote_submissions TO portal_api;
GRANT USAGE, SELECT ON SEQUENCE remote_submissions_id_seq TO portal_api;
```
The portal role's connection string is your `PORTAL_DATABASE_URL`:
```
postgresql://portal_api:a-long-random-secret@ep-xxxx.REGION.aws.neon.tech/neondb?sslmode=require
```
(You can skip this step to start — the portal falls back to `DATABASE_URL` — but
use the restricted role before real rollout.)

## Step 4 — Deploy the portal to Vercel

1. In **Vercel**, *Add New → Project* and import this repository.
2. It auto-detects `vercel.json` (static `portal/` + `api/` functions; no build).
3. Add **Environment Variables** (Production):
   - `CLOUD_JWT_SECRET` = a long random secret (generate one, keep it safe). **Required.**
   - `PORTAL_DATABASE_URL` = the `portal_api` connection string (Step 3). Preferred.
   - If you used the **Vercel+Neon integration** (Option B), `DATABASE_URL` is
     already injected — the portal will use it if `PORTAL_DATABASE_URL` is unset,
     so you can defer the restricted role and start immediately.
4. **Deploy** (or redeploy after adding env vars). Note the production URL
   (e.g. `https://sech-portal.vercel.app`).

> Order note for Option B: import the repo to Vercel (4.1–4.2) → create the Neon
> DB via Storage (Step 1B) → set `CLOUD_JWT_SECRET` → redeploy → then Steps 2/3/5.

**Verify:** open the URL — you should see the portal sign-in screen. It will say
"invalid email or password" until you provision an account (Step 5).

## Step 5 — Provision remote staff accounts (Host)

On the Host: **Settings → System → Remote Staff Access**.
1. Pick a staff member (must have a Host login for real permissions).
2. Set/generate a temporary password; create the account.
3. Share the portal URL + email + temporary password with the staff member
   securely. They sign in and are forced to set a new password.

## Step 6 — Smoke-test the live portal

Sign in as the provisioned staff member and confirm:
- overview tiles show synced record counts;
- **My work** → update profile / a task; **Field capture** → record a reading;
- **My submissions** shows them `pending` then `applied` after the next Host sync;
- an approver sees leave/inventory requests under **Approvals**.

If a submission stays `pending_sync`, check the Host is running and syncing
(Settings → Connectivity & Mode → last sync), and that it has internet.

## Step 7 — (Optional) Remote access to the full Host app

The portal is read + light actions. For staff who need the **full** app remotely,
put the Host behind a VPN/tunnel (e.g. **Tailscale**) and have them use the LAN
URL over it, or the Electron thin client (`SECH_LIMS_HOST_URL`). Never expose the
Host's port 4317 directly to the internet.

## Maintenance

- **Rotate `CLOUD_JWT_SECRET`** periodically (invalidates all portal sessions).
- **Disable/re-enable or re-provision** accounts from the Host console; disabling
  also clears a locked account.
- Keep the Host on and syncing so the portal stays current.
- Back up the Host as usual — it remains the system of record; the cloud is a
  replica plus an inbound request queue.

## Rollback

To turn everything off: set `SECH_LIMS_SYNC_ENABLED=false` on the Host (sync stops;
LAN app unaffected) and remove/disable the Vercel project. No local data is lost —
the Host was always authoritative.
