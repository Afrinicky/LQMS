# SECH_LIMS Mobile Companion — plan

A mobile, installable companion app that lets every laboratory staff member
perform their day-to-day operational, quality, maintenance, inventory, safety and
administrative duties from a phone — in the lab over Wi-Fi/LAN, or from anywhere
over the Internet. The full SECH_LIMS desktop application remains the system of
record and continues to own the comprehensive testing workflows; the mobile app
is a **light, task-oriented extension** of it.

This is a planning document. Nothing here is built yet. It follows the same
plan-then-build approach used for the Remote Staff Portal (see
`docs/REMOTE_STAFF_PORTAL_PLAN.md`).

---

## 1. Goals

- One installable app that reduces paperwork and captures data at the point of work.
- Covers the **relevant, mobile-appropriate parts of every relevant module** — not a
  cut-down toy. If a staff member has a duty, it should be doable (or at least
  actionable) on the phone.
- Works **on the LAN** (lab Wi-Fi) and **over the Internet** (Tailscale today;
  optionally a hardened public tunnel later), with the same app and login.
- Offline-first for capture: readings, maintenance logs, incidents and notes can
  be recorded with no signal and sync automatically when back online.
- Respects the exact same identity and permissions as the desktop app — a staff
  member sees and can do only what their role allows.

## 2. Key architectural decision — talk directly to the Host

The Host already runs a full Express API at `:4317` covering every module, behind
the same authentication (`/api/auth`) and RBAC middleware (`requireAuth`,
`requirePermission`) the desktop app uses. The mobile app therefore is **a new
mobile-first front end that consumes the existing Host API** — reusing all module
endpoints, the login, and the permission model. Almost no new server code is
required for core features; the work is a focused mobile UI plus a few mobile
conveniences (offline outbox, photo/QR capture, push).

```
  Phone (installable PWA)
     │  same login, same RBAC
     ▼
  Host API :4317  ──►  full module routes (already exist)
     │
  SQLite (system of record)  ──►  optional cloud sync (already built)
```

This is deliberately **not** the cloud Remote Staff Portal (Neon/Vercel). That
portal stays as the lightweight, propose-→-approve, public-Internet-without-VPN
option. The mobile companion is the **full** operational client and reaches the
Host directly. See §8 for how the two coexist.

## 3. Why a PWA (installable web app), not a native app first

- **Installable** on Android and iOS (Add to Home Screen), full-screen, its own
  icon — the manifest + service worker are already scaffolded (`public/`).
- **One codebase**, same React/TypeScript stack, reuses the Host API and types.
- **LAN + Internet with one build** — it just points at whatever Host address is
  reachable (LAN IP, or Tailscale/tunnel host).
- **No app-store friction** for internal rollout; instant updates.
- Native camera, offline storage, push (Android) and biometric unlock are all
  available to a PWA.

If app-store distribution or deep native integration is later required, the same
codebase can be wrapped with **Capacitor** to ship real iOS/Android binaries with
minimal change. That is an optional future phase, not a blocker.

## 4. Connectivity & security

| Where the staff is | How the app reaches the Host | Notes |
|---|---|---|
| In the lab | `http://<LAN-IP>:4317` over Wi-Fi | Already working. |
| Remote (admins / few) | Tailscale → `http://<tailscale-ip>:4317` | Already working; private, encrypted, per-device. |
| Remote (all staff) | **Cloudflare Tunnel** → `https://…` gated by Host login | Optional hardening phase; one HTTPS URL, no per-device VPN, still behind the app's own auth (and optionally Cloudflare Access). |

Security posture:
- Auth is the Host's existing staff login; the app stores a session token and
  supports optional **biometric/PIN re-lock** on the device.
- RBAC is enforced server-side (unchanged) — the mobile UI only *shows* what the
  API already permits; it cannot escalate.
- The Host is never exposed with a raw open port to the Internet. Remote access is
  always via Tailscale or an authenticated tunnel.
- The app configures its Host endpoint once (LAN URL and remote URL) and can
  auto-pick whichever is reachable.

## 5. Feature scope by module

Legend — **Act** = create/update/record on mobile · **Capture** = record-only
(field data) · **View** = read/summaries on mobile, edited on desktop · **Desktop**
= stays on the full app (too heavy/complex for phone), surfaced as read-only where
useful.

| Module | Mobile scope | Representative staff actions |
|---|---|---|
| **My Work** (hub) | Act | My tasks/actions, items assigned to me, notifications, reviews/renewals due, quick-capture shortcuts |
| **Personnel / My Records** | Act/View | My profile & contact, my competency & training records, my registers, leave requests, documents awaiting my acknowledgement |
| **Environmental Monitoring** | Capture | Record readings against items, see limits & out-of-range flags, add corrective note, view recent trend |
| **Equipment Management** | Act | View equipment, **record maintenance** (routine/preventive/corrective), log calibration checks, **report breakdown** (+ photo), view service history, QR-scan a tag to open its record |
| **Supplier & Inventory** | Act | View stock & expiry, **record usage/consumption**, receive stock, record batch, **request items**, low-stock/expiry alerts, barcode scan |
| **Nonconforming Events & CAPA** | Act | Raise an NC (+ photo), view NCs/CAPAs assigned to me, update progress, complete corrective actions, add evidence |
| **Facilities & Safety** | Act | Report a safety incident (+ photo/location), view open incidents, update status |
| **Internal Assessments** | Act | Conduct checklist assessments, record findings/evidence, respond to assigned assessment items |
| **Documents & Records** | Act | Read controlled SOPs/policies, **acknowledge/attest** new versions, search the master list |
| **Action Tracker** | Act | My actions across all modules, update status, add completion notes |
| **Complaints / Risks** | Act/View | Log a complaint, view risk register, update risks I own |
| **IQC / EQA** | Capture/View | Record IQC results / acknowledge EQA (capture where sensible), view status |
| **POCT Oversight** | Capture | Record POCT QC / incident entries |
| **Customer Focus** | Act/View | Log feedback, view satisfaction items |
| **Notifications & Review Calendar** | Act | Receive, open, and act on notifications; see what's due |
| **Records, Reports & Evidence** | Capture/View | Upload evidence/photos, view records; heavy report building stays on desktop |
| Dashboard / Quality Indicators | View | Read-only KPI cards and my-relevant summaries |
| Management Review, Monthly Reports/LHIMS, Method Verification & Validation, Measurement Uncertainty, Meetings, Organisation & Leadership, Process/Information Management, Blood Bank Handover, Settings | Desktop | Surfaced as read-only summaries or my-tasks where relevant; full authoring stays on the desktop app |

Guiding rule: **if it is a duty a staff member performs in the course of a shift,
it belongs on the phone.** Complex authoring, configuration, calculations and
comprehensive test-result workflows stay on the desktop.

## 6. Mobile UX model

- **Home**: a clean grid/launchpad of the staff member's permitted areas, plus a
  "Quick capture" row (Reading · Maintenance · Incident · NC · Inventory use).
- **Bottom tab bar**: Home · My Work · Capture · Notifications · Me.
- **Task-first flows**: large tap targets, one action per screen, minimal typing,
  sensible defaults, date/number pickers.
- **Camera & QR**: attach photos as evidence; scan equipment/inventory tags to jump
  straight to a record or pre-fill a form.
- **Offline banner + outbox**: shows queued items and auto-flushes on reconnect
  (the pattern already proven in the cloud portal).
- **Role-aware**: the home grid and every action are filtered by the staff
  member's permissions.
- Matches the desktop app's visual language (same design tokens) so it feels like
  one product.

## 7. Cross-cutting concerns

- **Auth/session**: reuse `/api/auth`; token stored securely; optional biometric/PIN
  re-lock; auto-select LAN vs remote endpoint.
- **Offline capture & sync**: local queue (IndexedDB) with idempotent submit and
  conflict-safe replay; visible sync state.
- **Push notifications**: task assigned, NC raised to me, stock low, review due
  (Web Push on Android now; iOS via installed PWA / later Capacitor).
- **Media**: photo capture & upload wired to the existing evidence/records
  endpoints.
- **QR/barcode**: equipment tags and inventory items.
- **Permissions parity**: no new authority is created on mobile — server RBAC is
  the single source of truth.
- **Auditing**: mobile actions flow through the same Host services, so they land in
  the existing audit trail automatically.

## 8. Relationship to the existing Remote Staff Portal (cloud)

Two complementary remote surfaces, by design:

- **Cloud Remote Staff Portal** (Neon/Vercel, already built): public Internet, no
  VPN, deliberately limited, propose-→-approve. Best for staff who only occasionally
  need a few self-service actions from anywhere.
- **Mobile Companion** (this plan, direct-to-Host over LAN/Tailscale/tunnel): the
  full operational toolkit for everyday work.

They share the same identity model. Over time the mobile app can also learn to fall
back to the cloud portal's API when only the public Internet is available and the
Host is unreachable — but that convergence is a later, optional step, not part of
the core build.

## 9. Execution phases

Status as built (branch `claude/sech-lims-hybrid-architecture-qa21ze`):

- **M0 — Foundation** ✅: installable bottom-tab PWA served at `/m`, login against
  `/api/auth`, same-origin API (LAN + Tailscale, no config), permission-aware home.
- **M1 — My Work & Me** ✅: my assigned tasks (overdue flagged), scoped alerts, my
  profile, sign-out.
- **M2 — Field capture** ✅: environmental readings (with acceptable-range + status),
  equipment maintenance / breakdown; offline outbox with auto-flush.
- **M3 — Inventory & Safety** ✅: stock view (low-stock/expiry flags), record usage
  against a batch; safety incident reporting.
- **M4 — Quality** ✅: raise nonconformities; acknowledge SOPs / controlled documents
  (personal attestation). *(Complaints/Risks/CAPA update: later.)*
- **M5a — Photo evidence** ✅: attach a photo (OS camera via file input, works over
  http) to breakdowns, safety incidents and nonconformities.
- **M6 — Assessments** ✅: conduct checklist assessments (per-question response +
  evidence, auto-saved, progress counter).
- **Recent-context** ✅: recent readings / maintenance history shown inline on the
  capture screens.

### Phase 2 — Primary digital workstation ✅ (branch `claude/sechlims-mobile-upgrades-micuq9`)

Phase 2 expands the companion from a capture tool into the primary mobile
workspace. See `docs/MOBILE_COMPANION_PHASE_2.md` for the full design.

- **Staff Self-Service** ✅: profile & contact edit, emergency contacts,
  professional licences, document/certificate upload (→ verification workflow),
  leave requests, clock in/out (optional GPS), duty roster, training history &
  upcoming requirements, competency records, announcements, and electronic
  acknowledgement/signing of declarations. (`mobile/SelfService.tsx`,
  `/api/mobile/me/*`, `/api/mobile/announcements`).
- **Role-based dashboard** ✅: `/api/mobile/dashboard` returns permission-filtered
  widgets + quick actions; the home screen is tailored per role with drill-down.
- **Dynamic Digital Forms Engine** ✅: JSON templates rendered on the client with
  every field type, conditional questions and validation; administrators publish
  new forms with no app update. Ten starter templates seeded.
  (`mobile/Forms.tsx`, `/api/forms/*`, `form_templates`/`form_submissions`).
- **Mobile approval workflows** ✅: unified RBAC-filtered inbox with approve /
  reject / return, comments, e-signature, timestamp and audit trail; the
  requester is notified. (`mobile/Approvals.tsx`, `/api/mobile/approvals`).
- **Electronic signatures** ✅: `e_signatures` records identity, timestamp,
  device, IP and an audit-log reference; used by approvals, form completion and
  acknowledgements. (`server/services/signatureService.ts`, `/api/signatures`).
- **QR infrastructure** ✅ (backend complete): stable per-entity tokens for
  equipment, reagents, inventory, storage locations, rooms, environmental points
  and maintenance records, each resolving to its record. Scanning goes live
  unchanged once a secure camera context exists. (`server/services/qrService.ts`,
  `/api/qr/*`).
- **Push-notification framework** ✅ (backend complete): subscriptions,
  preferences, server-side event generation, scheduling/reminders, priorities,
  read/unread, history and retry — wired to delivery when HTTPS lands.
  (`server/services/pushService.ts`, `/api/push/*`).
- **Camera intelligence** ✅: image compression, offline photo capture, QR/barcode
  scanning (live over a secure context, manual entry otherwise) with an
  OCR-ready "confirm or edit" step. (`mobile/Scan.tsx`, `mobile/native.ts`).
- **Native-app preparation** ✅: all device access is behind `mobile/native.ts`;
  `capacitor.config.ts` documents the Android wrap. The PWA stays fully
  functional.

Remaining / optional:

- **HTTPS remote access** (see `docs/MOBILE_REMOTE_ACCESS.md`): Cloudflare Tunnel so
  all staff reach the companion over the Internet without per-device Tailscale.
  Prerequisite for the two items below.
- **Web Push notifications** and **QR / barcode scanning** — require a secure
  context (HTTPS), so they are deferred until the tunnel is in place; building them
  over plain http would ship inert features.
- **Native wrap** (Capacitor) for app-store distribution, if ever wanted.

Each phase is independently useful and shippable. Build, test on a real phone
against the lab Host, move on — exactly how we did R1–R8.

## 10. Open decisions (to confirm before M0)

1. **Installable technology** — PWA now (recommended), with an optional Capacitor
   native wrap later.
2. **Backend model** — mobile talks **directly to the Host** for full features
   (recommended), keeping the cloud portal as the separate lightweight option.
3. **All-staff Internet access** — start with Tailscale on staff phones (private,
   already working) and add a Cloudflare Tunnel later if per-device VPN is too much
   to manage.
4. **Scope of M1 first slice** — confirm the initial module set to build first
   (proposed: My Work, Me/Personnel, Documents ack, Environmental + Equipment
   capture).
