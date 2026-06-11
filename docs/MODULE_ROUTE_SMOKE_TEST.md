# SECH_LIMS by Nickland — Module Route Smoke Test

A quick, click-through verification that every active route reaches its expected page and every documented API endpoint returns a 200 (or a meaningful 4xx for auth/permission cases).

Tester name: ________________ &nbsp;&nbsp;&nbsp;&nbsp; Date: ________________ &nbsp;&nbsp;&nbsp;&nbsp; Build commit: ________________

Mark Pass / Fail / N/A for each row.

---

## Frontend routes

Visit each path while signed in as the System Administrator and confirm the expected page header and one piece of data render. None of these should display a blank page, a 404, or a thrown error.

| Path | Expected page | Pass/Fail |
| --- | --- | --- |
| /home | Home with My Work block |  |
| /dashboard | Main Dashboard sections (System Health → Alerts & Tasks) |  |
| /documents | Documents & Records (Document Control) |  |
| /personnel | Personnel Management |  |
| /actions | Action Tracker |  |
| /nc-capa | Nonconforming Events & CAPA |  |
| /complaints | Complaints Register |  |
| /risks | Risk Register |  |
| /customer-focus | Customer Focus |  |
| /equipment | Equipment Management |  |
| /supplier-inventory | Supplier & Inventory |  |
| /monitoring | Environmental Monitoring |  |
| /facilities-safety | Facilities & Safety |  |
| /iqc | IQC Management |  |
| /eqa | EQA Management |  |
| /verification-validation | Method & Equipment Verification |  |
| /measurement-uncertainty | Measurement Uncertainty |  |
| /blood-bank-handover | Blood Bank Handover |  |
| /monthly-reports | Monthly Reports & LHIMS Archive |  |
| /assessments | Internal Assessments |  |
| /meetings | Meetings & Minutes |  |
| /management-review | Management Review |  |
| /quality-indicators | Quality Indicators |  |
| /continual-improvement | Continual Improvement |  |
| /poct | POCT Oversight |  |
| /notifications | Notifications & Review Calendar |  |
| /records-reports | Records, Reports & Evidence |  |
| /process-management | Process Management |  |
| /information-management | Information Management |  |
| /settings | Settings (Users & Access default) |  |

If a row fails: capture the URL, the console error (DevTools → Console), and any displayed message. Lazy-loaded module pages should briefly show "Loading module…" before rendering.

---

## API health endpoints

Run each request from `curl` or DevTools while signed in (for protected endpoints, include the `Authorization: Bearer <token>` header — the token is in the browser local storage under `sech_lims_token`).

| Endpoint | Expected | Pass/Fail |
| --- | --- | --- |
| GET /api/health | `{ ok: true, product: "SECH_LIMS by Nickland", lanReady: true }` |  |
| GET /api/system/about | productName, version, buildMode, apiStatus=ok, databasePath, dataDirectory, lanReady=true, generatedAt |  |
| GET /api/setup/status | `setupComplete: true` after first-run setup |  |
| GET /api/dashboard/system-health-summary | activeModules, totalUsers, usersLinkedToStaff, usersNotLinkedToStaff, openActions, overdueActions, unreadNotifications, overdueCalendarItems, recentAuditEvents, backupChecksThisMonth, openDataIntegrityIssues |  |
| GET /api/dashboard/my-work-summary | myOpenTasks, myUnreadNotifications, myDueToday, myOverdueItems, myOpenActions, myPendingApprovals |  |
| GET /api/settings/setup-health | hasAdminUser, adminLinkedToStaff, moduleCount, activeModuleCount, permissionRowsCount, staffCount, positionsCount, backupConfigured, warnings[] |  |
| GET /api/common/linked-records?module_key=records_reports&record_type=evidence_packs&record_id=1 | `{ outgoing: [], incoming: [] }` (empty arrays OK if no record 1 exists) |  |
| GET /api/dashboard/notifications-summary | unreadNotifications, urgentNotifications, dueToday, dueSoon, overdue, openTasks, pendingApprovals, reviewItemsDue, followUpsDue, byModule |  |
| POST /api/settings/demo-data/seed | `{ ok: false, message: "Demo data seeding is disabled in this foundation build." }` |  |

If `npm run smoke` reports any FAIL rows, fix those before exercising the route smoke test on a running build.

---

## Sign-off

| Item | Pass / Fail / N/A | Notes |
| --- | --- | --- |
| All 30 frontend paths render |  |  |
| All 9 documented API endpoints respond |  |  |
| No console errors during the click-through |  |  |
| No 4xx other than the expected auth/permission cases |  |  |
| Demo seed endpoint refuses cleanly |  |  |

Tester signature: ________________ &nbsp;&nbsp;&nbsp;&nbsp; Date: ________________
