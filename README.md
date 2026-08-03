# SECH_LIMS by Nickland

Foundation MVP scaffold for an offline-first, LAN-ready Windows desktop Laboratory Quality Management System for St. Elizabeth Catholic Hospital Laboratory.

SECH_LIMS works alongside LHIMS/Lightwave. It focuses on neutral daily QMS operations such as document control, records/evidence, personnel, organogram positions, authorization foundations, actions, audit trail, backups, and host/client readiness. It does **not** include official GAS, SLIPTA, ISO scoring, accreditation scoring, star ratings, or official compliance grading. Internal audit marking is supported as a configurable internal assessment tool inside the assessment checklist module; it is an internal score only and is never relabelled as an accreditation or official compliance score.

## Technology stack

- Electron desktop shell
- React + Vite + TypeScript frontend
- Node.js + Express REST host API
- SQLite through `better-sqlite3`
- Local file storage through `multer`
- Backup ZIP packages through the Node `archiver` library

## Install

```bash
npm install
```

## Run in development

Run the API, Vite UI, and Electron shell together:

```bash
npm run dev
```

Run only the host API for LAN/client preparation:

```bash
npm run api
```

Default host API:

```text
http://127.0.0.1:4317/api
```

By default the API binds to `127.0.0.1` (private to the host PC). To serve desktop and mobile clients over the LAN, start the host with `SECH_LIMS_API_HOST=0.0.0.0` and `SECH_LIMS_MODE=hybrid`, then allow the port through the firewall. Only the host process accesses SQLite directly; clients use the REST API. See the offline-first hybrid architecture below.

## First-time setup

1. Start the app with `npm run dev`.
2. Open the Electron window.
3. If the database is uninitialized, the app redirects to `/setup`.
4. Enter the facility profile and first administrator details.
5. Setup seeds default roles, permissions, positions, modules, departments, sections, locations, and audit history.
6. After setup, sign in at `/login`.

The setup status endpoint is:

```text
GET /api/setup/status
```

It returns `setupComplete`, `adminExists`, and `hostMode`.

## Login

Use the administrator username/password created during first-time setup. Auth uses a local session token stored in the browser local storage for the MVP.

## Foundation modules

The sidebar includes Home, Main Dashboard, Documents & Records, Organisation & Leadership, Personnel Management, Action Tracker, Nonconforming Events & CAPA, Complaints Register, Risk Register, Customer Focus, Equipment Management, Internal Assessments, Supplier & Inventory, Process Management, Information Management, Continual Improvement, Meetings & Minutes, Management Review, Quality Indicators, Facilities & Safety, Environmental Monitoring, IQC Management, EQA Management, Method & Equipment Verification, Measurement Uncertainty, Blood Bank Handover, Monthly Reports & LHIMS Archive, Reports & Exports, Notifications, and Settings.

Foundation workflows are wired for every non-placeholder module above. Settings remains functional and always accessible.

## Settings foundation

Settings contains:

- Users & Access
- Positions & Organogram
- Permission Matrix
- System Modules Toggle
- Document Master List Import
- Evidence Upload
- Action Tracker
- Backup & Restore
- Device Access / Pairing

Module toggles hide disabled modules from the main sidebar, pause alerts by flag, preserve data, and show a clean disabled-module page for direct route access.

## Permission foundation

The server includes a central permission resolver and `requirePermission(moduleKey, action)` middleware. The resolver considers:

- module enabled/disabled status
- user overrides
- role permissions
- position permissions
- staff-position assignments
- section/unit and technical authorization foundations

Permission columns include View, Create, Edit, Void/Archive, Export, Print, Approve, and Source. Permission sources are Role default, Position default, Section scope, Technical authorization, Manual override, and Denied override.

## File and evidence upload foundation

Uploads use `multer` with a 25 MB file size limit and safe stored filenames. File metadata is saved to the `files` table. Evidence links support `moduleKey`, `recordType`, `recordId`, and `notes`.

## Device pairing foundation

The Device Access / Pairing page creates pending device records and pairing codes for future desktop LAN and mobile LAN clients. Full client pairing approval is intentionally deferred.

## Backup foundation

Backup creation uses the Node `archiver` ZIP library. Backup packages include:

- SQLite database
- uploads
- evidence
- config
- `backup-manifest.json`

Backups are listed in Settings → System → Backup & Restore, where each package can be downloaded to keep an off-server copy. Restore is fully supported: pick an existing backup or upload a backup ZIP from disk. Before any restore the system writes an automatic `pre-restore-*.zip` safety snapshot of the current state, then replaces the SQLite database, uploads, evidence, and config from the backup. Users may need to sign in again afterwards.

## Build checks

```bash
npm run typecheck
npm run build
```

## Foundations now in place

NC/CAPA, Complaints, Risks, Actions, Equipment Management, Supplier & Inventory, Environmental Monitoring, Facilities & Safety, IQC, EQA, Method & Equipment Verification, Measurement Uncertainty, Blood Bank Quality & Inventory Handover, Monthly Reports & LHIMS Archive (CSV + XLSX import, mapping rules, exception review, draft/approve/export, TAT summary with per-section drill-down), Document Control (versioning, attestations, distribution inbox, watermarked print render), Personnel Management (staff documents, declarations, training, competency, technical authorisations, duty rosters with coverage/conflict detection, self-service profile), the Phase 8 governance modules: Internal Assessments & Findings (with flexible checklist library + optional internal audit marking + printable reports), Meetings & Minutes, Management Review (with one-click input generation across QMS modules), Quality Indicators (numerator/denominator with target/warning/critical thresholds + simple trend chart), and Continual Improvement Projects, the Phase 9 Customer Focus module covering stakeholders, service agreements, feedback intake with escalation to Complaints / Actions / NC / CAPA, satisfaction surveys with question library and response capture, customer communication log, and CSV/XLSX import batches, the Phase 10 POCT Oversight module covering POCT sites, devices linked to equipment records, test menu, operator authorisations linked to competency assessments, reagent lots linked to inventory batches, QC materials and results with automatic range-based interpretation, EQA events, maintenance logs that roll forward device service dates, incidents that can escalate to actions / NC / CAPA, and site-scoped monthly review generation, the Phase 11 Notifications & Review Calendar module providing a central due-date layer with cross-module scanning, in-app notifications with read/acknowledge/resolve/dismiss workflow, a personal task queue, a review calendar with status filters, notification rules and per-module preferences, and a topbar unread badge, the Phase 12 Records, Reports & Evidence module covering report templates, report requests with simple CSV/JSON/HTML export, controlled-copy print job logging, evidence packs with manual item addition and JSON summary generation, full audit-trail browsing and review records with action creation, retention rules and review records (no destructive automation), backup/restore check records, and a data-integrity basic scan endpoint that records its findings, and the Phase 13 Process Management module covering a lab test directory linked to documents/equipment with TAT targets, specimen acceptance criteria, a specimen rejection register that can escalate to NC / actions, critical result rules (with low/high values and notification timeframes), critical result notifications with automatic escalation flagging when the notification time exceeds the rule's timeframe, a referral laboratory register and per-lab test catalogue, referral sendouts with delayed-return detection and NC / action escalation, report amendment logs with authorise / communicate / NC / action workflow, and period-bounded process review records with one-click neutral count summaries across rejections, critical notifications, referral sendouts, and amendments. Patient testing and clinical result reporting remain with LHIMS/Lightwave: this module records only the QMS workflow and uses request/patient references rather than patient names.

## Phase 14 Information Management foundation

Phase 14 activates the Information Management module. SECH_LIMS continues to support QMS oversight of laboratory information assets, systems, and IT-related quality records without replacing LHIMS/Lightwave for patient registration, test requests, clinical result entry, verification, dispatch, or reporting.

The module covers:

- **Information Asset Register** — paper registers, electronic files, databases, spreadsheets, LHIMS exports, reports, backup drives, evidence packs, shared folders, owners, storage locations, backup methods, confidentiality, and optional link to a retention rule.
- **Information Systems Register** — SECH_LIMS, LHIMS/Lightwave, analyzers, POCT systems, backup drives, shared folders, and other systems as oversight records (no live integrations).
- **Access Reviews** — periodic per-system access reviews with one-click generation of review items from the user/staff list and per-user decisions (keep, modify, remove, suspend, investigate); creates linked actions when an access issue is found.
- **Information Security Incidents** — confidentiality / data-loss / access incident log with severity, immediate action, investigation summary, and NC / CAPA / Action escalation; sensitive patient identifiers are not exposed in this module.
- **Data Correction Requests** — records correction requests with record references and summaries only — never directly edits clinical results in LHIMS/Lightwave; follows submitted → reviewed → approved → completed → closed flow with linked action.
- **System Change Control** — change requests with risk level, approval, implementation date, validation requirement, rollback plan, and submitted → reviewed → approved → implemented → validated → closed workflow.
- **Software Release Records** — SECH_LIMS version/release notes with testing, approval, deployment notes, and archive flow.
- **System Validation Records** — installation/operational/performance/UAT/verification records with scope, deviations, outcome, optional evidence file, and link to release/change request.
- **Downtime Records** — start/end with automatic duration_minutes calculation, downtime type, affected services, workaround, resolve/close workflow, and NC / Action escalation.
- **Information Management Reviews** — period-bounded reviews with one-click neutral summary generation across information assets, access reviews, security incidents, change requests, software releases, validations, downtime, data corrections, and data integrity scans.

Default permissions for the new module follow the established role pattern: System Administrator has all permissions, Laboratory Manager and Quality Manager have view/create/edit/approve/export/print, Quality Team Member / Section Head / Data Officer have view/create/edit/export/print, Biomedical Scientist has view/create, and Technician has view.

## Building the Windows installer with GitHub Actions

GitHub does not automatically build a `.exe` installer for SECH_LIMS — the build only happens when this workflow runs. If you do not push to GitHub, no installer is produced.

To produce a downloadable Windows installer without owning a Windows build machine:

1. Push the code to GitHub (the `claude/cool-gauss-gnBTr` branch or `main`).
2. Open the repository on GitHub in a browser.
3. Click the **Actions** tab.
4. In the left-hand list, select **Build Windows Installer**.
5. Click **Run workflow**, pick the branch you want to build, and confirm.
6. Wait for the workflow to finish (roughly 10–20 minutes — Electron must rebuild `better-sqlite3` against the bundled Electron headers on the Windows runner).
7. When the run finishes successfully, scroll to the **Artifacts** section at the bottom of the run summary page.
8. Download the artifact named **`SECH_LIMS_Windows_Installer`**.
9. Extract the downloaded `.zip`. Inside you will find `SECH_LIMS-by-Nickland-<version>-Setup.exe` plus the matching `.blockmap` and `latest.yml`. Run the `.exe` to install the application on a Windows machine.

Notes:

- The workflow runs on `windows-latest` so that `electron-builder` can natively rebuild `better-sqlite3` for the bundled Electron version. Linux runners cannot produce a Windows installer with the current packaging configuration.
- The workflow runs **manually** via `workflow_dispatch` and also on pushes to `main`. Other branches can use the manual "Run workflow" button at any time.
- The installer is **unsigned**. Windows SmartScreen may show a warning the first time it runs. Sign the installer in a future phase before distributing it publicly.
- **The installer must still be tested on a real Windows PC before production use.** Use [`docs/RELEASE_CANDIDATE_CHECKLIST.md`](docs/RELEASE_CANDIDATE_CHECKLIST.md) and [`docs/MODULE_ROUTE_SMOKE_TEST.md`](docs/MODULE_ROUTE_SMOKE_TEST.md) on the target machine after installation.

### Troubleshooting: GitHub Actions fails while rebuilding `better-sqlite3`

The native build step is the most fragile part of the Windows packaging pipeline. If the workflow fails inside `node-gyp` while rebuilding `better-sqlite3`:

1. **Confirm Electron is pinned and not floating to latest.** `package.json` must show `"electron": "32.3.3"` (no caret, no `latest`). Floating Electron versions caused an earlier failure where `electron-builder` pulled Electron 42 and `better-sqlite3` failed to compile against the `.electron-gyp/42.x` headers.
2. **Confirm `better-sqlite3` is pinned** to `11.7.0` (no caret, no `latest`).
3. **Confirm the workflow runs on `windows-latest`.** The first line of the job is `runs-on: windows-latest`.
4. **Confirm Node.js 20 is used.** The `actions/setup-node@v4` step sets `node-version: '20'`.
5. **Confirm native modules are rebuilt before packaging.** The workflow runs `npm run rebuild:native` (which calls `electron-builder install-app-deps`) *before* `npm run dist:win`. If you removed this step, add it back.
6. **Rerun the workflow manually** — Actions → Build Windows Installer → Run workflow. Cached state from a previous failed run is occasionally the cause.

If a future Electron upgrade is needed, bump `electron`, `electron-builder`, and `better-sqlite3` together in the same commit, then run `npm install` to refresh `package-lock.json` and verify locally before pushing.

## Phase 16 Release-candidate hardening

Phase 16 prepares the build for desktop release. It does not add new QMS workflows.

- **Code-splitting.** The major module pages (`DocumentControlPage`, `PersonnelManagementPage`, Phase 3/4/8 pages, `CustomerFocusPage`, `POCTPage`, `NotificationsPage`, `RecordsReportsPage`, `ProcessManagementPage`, `InformationManagementPage`, `BloodBankHandoverPage`, `MonthlyReportsPage`) are now lazy-loaded via `React.lazy` + `Suspense`. The main client bundle dropped from ~864 KB to ~344 KB and each module page is a separate chunk loaded on demand with a `Loading module…` fallback.
- **System/About endpoint.** `GET /api/system/about` returns `productName`, `version` (from `package.json`), `buildMode`, `apiStatus`, `databasePath`, `dataDirectory`, `lanReady`, and `generatedAt`. No secrets are exposed.
- **Electron-builder configuration.** `electron-builder` has been added as a dev dependency with NSIS Windows packaging targeting `release/SECH_LIMS-by-Nickland-<version>-Setup.exe`. The native `better-sqlite3` module is in `asarUnpack` so it can be loaded at runtime. The Electron main process sets `SECH_LIMS_DATA_DIR` to `app.getPath('userData')/local-data` before starting the API — the SQLite database, uploads, evidence, backups, and config never land in the installation directory, so reinstalling or updating the app does not touch user data.
- **New npm scripts.** `npm run smoke` runs a non-destructive structure check; `npm run pack` produces a packaged directory without an installer; `npm run dist` and `npm run dist:win` produce the NSIS installer.
- **Deployment guide.** [`docs/WINDOWS_INSTALLER_AND_LAN_DEPLOYMENT.md`](docs/WINDOWS_INSTALLER_AND_LAN_DEPLOYMENT.md) covers install, dev, build, installer creation, where data lives, backup, host desktop, LAN client preparation, firewall, and safe upgrades.
- **Release-candidate checklist.** [`docs/RELEASE_CANDIDATE_CHECKLIST.md`](docs/RELEASE_CANDIDATE_CHECKLIST.md) — 17 sections covering build, login, permissions, dashboard, backups, audit trail, notifications, linked records, sample workflows, LAN readiness, and Windows installer sign-off.
- **Module route smoke test.** [`docs/MODULE_ROUTE_SMOKE_TEST.md`](docs/MODULE_ROUTE_SMOKE_TEST.md) — table of every active frontend path and every documented API health endpoint with a pass/fail column.
- **Acceptance testing checklist.** Phase 15's [`docs/ACCEPTANCE_TESTING_PHASE_15.md`](docs/ACCEPTANCE_TESTING_PHASE_15.md) remains the per-module hands-on verification document.

> Important: `npm run dist:win` must run on a build host with the correct native toolchain to rebuild `better-sqlite3` against the Electron headers. On environments without that toolchain — including most sandboxed CI images — the packaging command will fail at the native rebuild step. This is expected; build the installer on a Windows machine (or a Linux host with the matching Electron + node-gyp toolchain) before signing off the release candidate.

## Phase 15 Integration hardening

Phase 15 is an integration/hardening pass — not a new QMS domain. It pulls the previously built foundations together for desktop/LAN testing:

- **Master dashboard** at `/dashboard` now aggregates the per-module summary endpoints (QMS Core, Operations, Technical Quality, People & Documents, Governance, Customer + POCT + Blood Bank, Process Management, Information & Records, Alerts & Tasks) plus a System Health row and a My Work row. Failed endpoints degrade gracefully — missing sections render `—` instead of crashing the page.
- **System Health summary** at `GET /api/dashboard/system-health-summary` returns active modules, total users, users linked vs not linked to a staff record, open and overdue actions, unread notifications, overdue calendar items, recent audit events, monthly backup checks, and open data-integrity issues — using safe SQL guards so older databases without optional tables still respond.
- **My Work summary** at `GET /api/dashboard/my-work-summary` resolves the signed-in user's open tasks, unread notifications, due-today, overdue, open actions, and pending approvals. Uses `req.user.staffId` for staff-scoped fields and `req.user.id` only as a fall-back.
- **Setup Health Check** at `GET /api/settings/setup-health` reports whether an admin user exists and is linked to a staff record, the active module count, permission row count, staff and position counts, and whether a backup configuration setting has been recorded — plus a `warnings[]` array surfaced in the UI.
- **Linked Records viewer** at `GET /api/common/linked-records?module_key=…&record_type=…&record_id=…` returns the outgoing and incoming `record_links` rows for a given record. A reusable `LinkedRecordsPanel` component is wired into the Records, Reports & Evidence pack detail card and can be re-used across any module.
- **Demo data seed** is a deliberate no-op: `POST /api/settings/demo-data/seed` is wired but returns `Demo data seeding is disabled in this foundation build.` so the production database can never accidentally be filled with fake clinical/patient data.
- **Acceptance testing checklist** has been added at `docs/ACCEPTANCE_TESTING_PHASE_15.md` covering 21 sections from setup and login through to build and packaging readiness.

The master dashboard, My Work block on the Home page, and System Health card give a single landing surface for daily QMS oversight without rebuilding any of the per-module pages.

## Offline-first hybrid architecture

SECH_LIMS runs fully offline on the host PC and can also serve clients over the
local network, with a clean, dormant path to future cloud synchronization. Every
new capability is off by default, so an existing single-PC install is unchanged.

- **Local vs Hybrid mode** — `SECH_LIMS_MODE` (env default) plus an admin toggle in
  **Settings → System → Connectivity & Mode**. Mode never affects instruments,
  monitoring, printers or workflows — those always run offline.
- **Clients** — desktop over LAN (plain browser or an Electron thin client via
  `SECH_LIMS_HOST_URL`) and mobile as an installable PWA. See
  [`docs/CLIENTS_LAN_AND_PWA.md`](docs/CLIENTS_LAN_AND_PWA.md).
- **Data-access seam** — routes can move onto a `DataStore` abstraction so a cloud
  PostgreSQL driver can be added later without rewriting business logic. See
  [`docs/DATA_ACCESS_LAYER.md`](docs/DATA_ACCESS_LAYER.md).
- **Cloud sync (opt-in, off by default)** — sync-ready columns, a change-capture
  outbox, a `PostgresStore` driver, and a real push/pull sync engine
  (`GET /api/sync/status`) replicate syncable records to a cloud PostgreSQL (e.g.
  Neon) when enabled. See [`docs/SYNC_READY_SCHEMA.md`](docs/SYNC_READY_SCHEMA.md)
  and [`docs/CLOUD_SYNC.md`](docs/CLOUD_SYNC.md).
- **Remote read-only portal** — an optional Vercel-hosted portal (`portal/` +
  `api/cloud/`) lets fully-remote staff view the synced data from anywhere, even
  when the Host is off. Read-only; the Host stays the sole writer. See
  [`docs/CLOUD_SYNC.md`](docs/CLOUD_SYNC.md).
- **Configuration** — all URLs, database connections, mode and sync settings are
  environment variables; see [`.env.example`](.env.example). Full plan in
  [`docs/HYBRID_ARCHITECTURE_PLAN.md`](docs/HYBRID_ARCHITECTURE_PLAN.md).

## Known limitations

- All modules are foundation-level and require real-world testing before production use.
- Assessment checklist library supports JSON and CSV/XLSX imports, flexible question selection, optional internal audit marking, weighted section scoring, laboratory-defined internal pass thresholds, history-safe delete (only unused checklists/sections/questions), and per-response edit history. Sophisticated audit reporting templates and official accreditation scoring remain out of scope.
- Internal audit marking is supported as a configurable internal assessment tool.
- Official accreditation scoring, star ratings, and GAS/SLIPTA/ISO compliance grading are not included.
- Mobile access is delivered as an installable Progressive Web App (PWA) served by the host over the LAN; there is no separate native app store build yet.
- No advanced AI SOP conversion yet.
- POCT Oversight foundation exists for sites, devices, operators, authorisations, QC, EQA, maintenance, incidents, and monthly reviews. The clinical result-reporting workflow itself is not built in SECH_LIMS — patient testing and reporting remain with LHIMS/Lightwave.
- No advanced report designer yet (CSV/HTML/DOC exports exist on key modules; rich PDF templating is pending).
- Cloud synchronization is implemented but **opt-in and off by default**: with it disabled the host runs fully offline and no data leaves the machine. When `SECH_LIMS_SYNC_ENABLED=true` and a cloud PostgreSQL URL (e.g. Neon) are set, the host replicates syncable records to the cloud and merges cloud changes back (last-writer-wins). See [`docs/CLOUD_SYNC.md`](docs/CLOUD_SYNC.md). Provisioning the Neon database and deploying the Vercel web frontend are done in your own accounts with live credentials.
- No live Google Forms / Google Sheets / Gmail integration yet. CSV/XLSX import is the supported intake path; outbound email communications can be drafted via the operating system's default mail client through a mailto link, but no SMTP/Gmail API is wired.
- No live POCT device or result interfacing yet. POCT Oversight captures the quality-management workflow (sites, devices, operators, QC, EQA, maintenance, incidents, monthly reviews) plus inline QC trend chart, auto-flip of expired operator authorisations, multi-section monthly review summary generation, and printable site / authorisation roster / QC / monthly review reports through the OS print dialog. Patient result reporting remains with LHIMS/Lightwave and direct device communication has not been added.
- No live SMS, email, or calendar invite delivery yet. The Notifications & Review Calendar module records in-app notifications, tasks, and calendar items derived from a cross-module scan, and the topbar shows an unread count badge. Email and SMS preference toggles exist but are placeholders until a delivery integration is wired.
- No advanced PDF/Word visual report designer yet. The Records, Reports & Evidence module now supports a starter library of seeded report templates, simple CSV/JSON/HTML report exports with `filter_json`-driven WHERE clauses (operators: eq, ne, gt, gte, lt, lte, like, IN-array, IS NULL), controlled-copy print job logging, manual evidence packs with JSON summary generation and a printable HTML cover sheet that flows through the OS print dialog, full audit trail review with the linked action shown inline on each review row, retention rules and review records, backup/restore check records, and a deeper data-integrity scan (audit metadata, orphan links, notifications, overdue tasks, controlled docs, blood-unit screening completeness, monitoring excursion review, IQC review timeliness, equipment calibration currency, NC closure notes, CAPA effectiveness, POCT authorisation expiry, staff document expiry). Rich page-layout templates, branded PDF templates, and document-based Word generation remain future work.
- Customer Focus now includes survey response analytics, a cross-survey response list, CSV/XLSX import auto-mapping for stakeholders, feedback, and survey_responses (with surveyNumber/surveyId + per-question columns), and a per-service-agreement performance panel derived from feedback and communications in the agreement period.
- Some export and print layouts are placeholder templates; richer per-report-type designs will follow.
- PDSA/run-chart designer remains a future improvement.
- Management review narrative templating remains a future improvement.
- Restore now replaces the database, uploads, evidence, and config from a backup ZIP (existing backup or uploaded file), guarded by an automatic pre-restore safety snapshot.
- Permissions are wired server-side, but fine-grained UI editing of every permission source is still MVP-level.
- Installer packaging for Windows needs a final on-target test pass. The Electron shell, Vite build, and host API have been verified through `npm run build`, but a packaged installer should be smoke-tested on the deployment laptop before go-live.
