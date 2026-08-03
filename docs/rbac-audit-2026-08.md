# Role-based access audit — August 2026

A full review of how SECH_LIMS decides who may do what, prompted by a report
that users who were refused sight of a record could still print it.

The audit covered the permission resolver, all 46 route modules, the permission
seed data, and every client surface that renders an action. It found the
reported bug and nine others. All ten are fixed; the fixes are verified by
`scripts/rbac-check.mjs` against a live server.

Two principles now hold throughout:

1. **`view` is the floor.** No action on a module is possible without the right
   to view that module.
2. **Hide, don't disable.** A feature a user is not entitled to use is not
   rendered — no greyed-out button, no menu entry, no card. Hiding is a
   courtesy; every hidden action is still refused independently by the server.

---

## Findings

### 1 — Print and export did not require the right to view *(the reported bug)*

**Severity: high.** `requirePermission('documents','print')` checked only the
`print` right. A role or user granted `print` while denied `view` was refused
the record on screen and handed the same record as a printable page. The
seeded roles make this easy to hit: nearly every role carries `print` on
modules an administrator might later restrict, and revoking `view` alone left
printing wide open. `export` behaved the same way, as did the XLSX register
downloads.

**Fix.** `resolvePermission` now treats `view` as a prerequisite for every
other action. A grant of `print`, `export`, `edit`, `approve` or
`void_archive` is discarded when the same module's `view` is not allowed, no
matter which layer granted it. This closes the hole at the resolver, so all
current and future print/export routes inherit the fix rather than needing
individual patches.

`server/services/permissionResolver.ts`

### 2 — Any technical authorization granted approval rights

**Severity: high.** The resolver allowed `view` and `approve` for any staff
member holding *any* active technical authorization on a module, without
looking at its level. A "View only" authorization therefore conferred the
right to approve records in that module — the opposite of what the level says.

**Fix.** Each level now maps to the actions it actually implies. Only
`Approve` and `Supervise` confer approval; `View only` confers nothing beyond
viewing.

`server/services/permissionResolver.ts`

### 3 — Expired technical authorizations kept working

**Severity: medium.** `technical_authorizations.expires_at` was written by the
UI and never read. An authorization that expired years ago continued to grant
access until someone deactivated it by hand.

**Fix.** Expired rows are excluded from the resolver and from the
authorizations shown on a user's own profile.

### 4 — Revoking a permission silently undid itself on restart

**Severity: high.** `seedDefaults()` runs on every server start and wrote role
defaults with `INSERT OR REPLACE ... allowed 1`. An administrator who revoked
a seeded permission had it restored the next time the host restarted, with no
warning and no audit entry. In an offline-first deployment that restarts often,
a revocation could last hours.

**Fix.** Seeding now uses `INSERT OR IGNORE`: it establishes a role's defaults
the first time a permission exists and never touches it again. New modules in
future versions still receive their defaults, because no row exists for them
yet.

`server/db/seed.ts`

### 5 — Scanning a QR code returned records the scanner could not open

**Severity: high.** `GET /api/qr/:token` embedded the full database row of the
equipment item, inventory item, location or monitoring point it pointed at, and
was guarded by nothing but a valid session. The code comment claimed "the
record they then open is still RBAC-guarded", but the record was already in the
response. `GET /api/qr/lookup/:type/:id` also minted new tokens — a write —
with no module check.

**Fix.** Both routes resolve the entity's module and check it: viewing takes
`view`, and minting a label token takes `print` on that module.

`server/routes/qr.ts`, `server/services/qrService.ts`

### 6 — Anyone signed in could sign any record

**Severity: high.** `POST /api/signatures` accepted any `moduleKey`,
`recordType` and `recordId` from the request body and recorded an electronic
signature against it, with only `requireAuth`. Any account could attach a
signature to a record in a module it had no access to. Reading a record's
signatures was equally open.

**Fix.** Recording a signature takes the `edit` right on the module that owns
the record; reading them takes `view` on that module.

`server/routes/signatures.ts`

### 7 — Staff signature images were downloadable by any account

**Severity: medium.** `GET /api/signatures/staff/:id/image` streamed any staff
member's signature image to any signed-in user, which is forgeable material.

**Fix.** You may fetch your own signature, one belonging to staff you may view
under Personnel, or one that already appears on a signed record — the case the
endpoint exists to serve. Everything else is refused, and each fetch of someone
else's signature is written to the audit trail.

*Residual risk:* a user who can legitimately view a record can still obtain the
signature images on it, because the client renders them from this endpoint.
Eliminating that means compositing signatures into print output server-side and
never sending the raw image. That is a larger change and is not in this pass.

### 8 — The digital forms engine was open to every account

**Severity: medium.** Form templates, the submissions list and individual
submissions were readable by anyone signed in, and anyone could submit against
any template. Submissions carry answers to quality records.

**Fix.** Templates take `records_reports:view`; submitting takes
`records_reports:create`. A user always sees their own submissions; seeing
anyone else's takes `records_reports:view`, and the list is then trimmed to the
modules whose forms they may read.

`server/routes/forms.ts`

### 9 — Dashboards, alert feeds and record links leaked across modules

**Severity: medium.** Every dashboard summary endpoint returned counts for all
modules to anyone signed in. `/notifications/live-alerts` returned alert titles
naming records from every module. The notification inbox listed alerts from
modules the reader had no access to. `/common/linked-records` returned links
into modules the caller could not open.

**Fix.** Single-module summaries now carry their module's `view` requirement.
Cross-module summaries emit a field only when its module is viewable — absent
rather than zero, so the client omits it instead of showing a misleading `0`.
Alert feeds, the inbox and linked records are filtered to viewable modules.

`server/routes/common.ts`, `server/routes/notifications.ts`

### 10 — Client-side gating used role *names*, not permissions

**Severity: medium.** The few places that hid anything matched on role name:
`/manager|head|administrator|supervisor/i.test(user.roleName)` decided who
could edit rosters, so a custom role called "Bench Head" silently gained roster
editing nobody had granted. Elsewhere `roleName === 'System Administrator'`
was compared directly. Roles are user-editable, so these tests drift from the
permissions they were standing in for.

**Fix.** All of them now ask the permission map.

`src/pages/PersonnelManagementPage.tsx`, `src/pages/SettingsPages.tsx`,
`src/pages/DocumentControlPage.tsx`

---

## Hiding unauthorized features

The client previously had **no permission awareness at all** — it rendered the
full navigation for everyone and let the API refuse the click. That is what
produced the "I can see it but not use it" experience.

`GET /api/auth/permissions` now returns the effective permission map computed
by the same resolver the API enforces with, so the UI cannot advertise
something the server would refuse. Login and `/auth/me` carry it too. The map
is re-read whenever the window regains focus, so rights withdrawn while someone
is signed in take effect without a re-login.

Hidden on that basis:

- **Sidebar and Home launchpad** — modules absent from the map are not drawn.
- **Routes** — `RequirePermission` refuses a module URL reached by bookmark,
  stale link or typing. The dashboard redirects home rather than showing a dead
  end.
- **Settings** — the whole area disappears for roles without it. Because it
  also holds delegated tools (roster building, master-list import, evidence
  upload), it opens for anyone holding one of those, showing only their tabs
  and describing only what they will find. The Action Tracker deliberately does
  *not* open Settings: it has its own route, and counting it would have shown
  "Settings" to the entire laboratory.
- **Actions within pages** — print, export, import, create, obsolete and
  approve controls across Documents, Equipment, Inventory, Personnel,
  Scheduling, Assessments, POCT, Verification, Monitoring, NC/CAPA, Customer
  Focus, Monthly Reports and Records & Reports.
- **Topbar** — the notification bell is gone without inbox access.
- **Alert strips** — a refused alert feed renders nothing rather than "no
  alerts", so nobody is told a module is clear when they simply cannot see it.

### One seed change was required to make hiding safe

Hiding by permission exposed gaps in the seeded defaults that were invisible
while everything was on screen for everyone:

- **`home` and `dashboard` were granted to no role but System Administrator.**
  Gating on them would have left every other role with an empty application.
- **`organisation` was granted to no role but System Administrator**, so
  Organisation & Leadership was already returning 403s to the Laboratory
  Manager — the sidebar simply offered a page that did not work.

Both are now seeded: the shell for every role, and Organisation with rights
appropriate to each. Because seeding no longer overwrites, these apply to
existing installations without disturbing anything an administrator has
changed.

---

## Verification

`node scripts/rbac-check.mjs` (with the API running) exercises the fixes
against a live server and a real database: 16 checks, all passing. It covers
print and export refusal without view, level-limited technical authorizations,
expiry, revocation surviving a restart, QR gating before and after a
revocation, and alert-feed filtering.
