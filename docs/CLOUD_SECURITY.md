# Cloud & Remote Portal — security hardening (R8)

Operational guidance for deploying the Remote Staff Portal safely. See also
`docs/CLOUD_SYNC.md` and `docs/REMOTE_STAFF_PORTAL_PLAN.md`.

## 1. Least-privilege database role for the portal API

The Vercel portal functions should connect with a **restricted** role, not the
database owner. The API reads `PORTAL_DATABASE_URL` in preference to
`DATABASE_URL`, so set the restricted role there.

Run this once as the database owner (e.g. via the Neon SQL editor), after the
Host has created the tables:

```sql
CREATE ROLE portal_api LOGIN PASSWORD 'a-long-random-secret';
GRANT CONNECT ON DATABASE neondb TO portal_api;          -- your db name
GRANT USAGE ON SCHEMA public TO portal_api;

-- Read model: read-only.
GRANT SELECT ON synced_records TO portal_api;

-- Accounts: read + update (password change, lockout counters, last_login).
GRANT SELECT, UPDATE ON cloud_users TO portal_api;

-- Submissions: propose (insert), read, and record decisions (update).
GRANT SELECT, INSERT, UPDATE ON remote_submissions TO portal_api;
GRANT USAGE, SELECT ON SEQUENCE remote_submissions_id_seq TO portal_api;
```

The portal role deliberately has **no** rights to modify `synced_records`, no
`DELETE`, and no DDL. The Host keeps using the owner role via
`SECH_LIMS_CLOUD_URL`. In Vercel set only `PORTAL_DATABASE_URL` (the restricted
role) — the owner connection string never needs to live in the frontend project.

## 2. Login rate limiting / lockout

Login is rate-limited per account: after **5** failed attempts the account is
locked for **15 minutes** (`cloud_users.failed_attempts` / `locked_until`). A
successful login clears the counters. Locked accounts get `429`, not `401`.
Admins can clear a lock by disabling and re-enabling the account, or by resetting
its password (re-provision) from the Host console.

## 3. Authentication tokens

Portal JWTs are HS256, signed with `CLOUD_JWT_SECRET`, and expire after 60
minutes. **Rotate `CLOUD_JWT_SECRET` periodically** (and immediately if exposed);
rotating it invalidates all outstanding portal sessions, forcing re-login. Keep
it long and random; never commit it.

## 4. PII minimization in the cloud

Only a minimal set of staff fields is replicated to the cloud
(`STAFF_SYNC_FIELDS` in `server/sync/syncEngine.ts`): id, uuid, full name, email,
phone, section, employee number, active flag and timestamps. Internal flags
(`remote_enabled`, `remote_scope`) and any other personnel fields stay on the
Host and never reach Neon. Contact fields are kept only so the portal's
own-profile view works. If you tighten this list, note that the profile
self-service view will no longer show the removed fields.

> No patient/clinical data is ever replicated — SECH_LIMS is a QMS, and the
> syncable tables are quality records, not results.

## 5. Security headers

`vercel.json` sets `Content-Security-Policy` (same-origin `connect-src`, no
framing), `Strict-Transport-Security`, `X-Content-Type-Options`,
`X-Frame-Options: DENY`, `Referrer-Policy` and a restrictive `Permissions-Policy`
on all portal responses.

## 6. Transport & remote access

- Vercel serves the portal over HTTPS; keep it so (HSTS is set).
- The Host API must be fronted by TLS + authentication before any exposure beyond
  the LAN. Prefer a VPN/tunnel (e.g. Tailscale) or an HTTPS reverse proxy — never
  expose port 4317 to the public internet directly.
- Treat `SECH_LIMS_CLOUD_URL`, `PORTAL_DATABASE_URL` and `CLOUD_JWT_SECRET` as
  secrets: environment variables only, never committed (`.env` is gitignored).

## 7. Trust boundaries (recap)

- The **Host is authoritative**. Every remote submission and approval is
  re-validated on the Host (permission, ownership, approver authority) before it
  is applied — the cloud is never trusted for identity or authorization.
- The portal API is the only writer to `remote_submissions`; the portal never
  writes authoritative data or the read model directly.
