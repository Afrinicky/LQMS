# SECH_LIMS by Nickland

Foundation MVP scaffold for an offline-first, LAN-ready Windows desktop Laboratory Quality Management System for St. Elizabeth Catholic Hospital Laboratory.

SECH_LIMS works alongside LHIMS/Lightwave. It focuses on neutral daily QMS operations such as document control, records/evidence, personnel, organogram positions, authorization foundations, actions, audit trail, backups, and host/client readiness. It does **not** include GAS, SLIPTA, ISO scoring, accreditation scoring, star ratings, checklist scores, or compliance percentages.

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

The API binds to `0.0.0.0` so the host desktop can later serve desktop clients or mobile LAN clients. Only the host process should access SQLite directly; clients should use the REST API.

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

The sidebar includes Home, Main Dashboard, Documents & Records, Organisation & Leadership, Personnel Management, Customer Focus, Equipment Management, Assessments, Supplier & Inventory, Process Management, Information Management, Nonconforming Events & CAPA, Continual Improvement, Facilities & Safety, Blood Bank Handover, Monthly Reports & LHIMS Archive, Reports & Exports, Notifications, and Settings.

Most advanced operational modules are placeholders in this MVP. Settings remains functional and always accessible.

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

Restore is a guarded placeholder in the foundation MVP.

## Build checks

```bash
npm run typecheck
npm run build
```

## Known limitations

- No full blood bank workflows.
- No LHIMS monthly report generation engine.
- No full NC/CAPA, equipment, inventory, monitoring, IQC, or EQA workflows.
- No mobile application.
- No WebSocket notifications yet.
- No advanced SOP editor.
- Document master list import accepts a placeholder request; CSV parsing comes later.
- Restore workflow is a safe placeholder.
- Permissions are wired server-side, but fine-grained UI editing of every permission source is MVP-level only.
