# SECH_LIMS by Nickland — Phase 15 Acceptance Testing Checklist

This checklist is a practical, hands-on verification of the desktop/LAN
foundation after Phase 15 integration hardening. It is not an accreditation
audit and does not produce a SLIPTA/GAS/ISO score.

Run through each section after a fresh `npm install` and `npm run build` on
the target laptop, with the host API started by `npm run api` or by launching
the Electron shell with `npm run dev`.

Mark each item as Pass / Fail / N/A. Record the build commit hash and the
person performing the testing at the top of the page.

---

## 1. Setup and login
- [ ] `GET /api/setup/status` returns `setupComplete=false` on a fresh database.
- [ ] First-time setup wizard accepts facility profile and admin credentials.
- [ ] After setup the wizard redirects to `/login`.
- [ ] Admin user can sign in and reach `/home`.
- [ ] Refreshing the browser keeps the user signed in until logout.
- [ ] `GET /api/settings/setup-health` returns no warnings when admin is linked to staff and modules are active.

## 2. User/staff linkage
- [ ] Settings → Users & Access lists the admin user.
- [ ] Linking the admin to a staff record updates `users.staff_id` and clears the "admin not linked" warning in setup health.
- [ ] Adding a second user with a different role can be created from Settings.

## 3. Module navigation
- [ ] Sidebar shows every active module exactly once.
- [ ] No completed module displays as "placeholder".
- [ ] Disabled modules in Settings → System Modules hide from the sidebar and show the disabled-module page when navigated to by URL.
- [ ] Settings remains reachable even when all other modules are disabled.

## 4. Permissions
- [ ] Settings → Permission Matrix loads role/position/user override grids.
- [ ] Demoting a role for a module removes the user's access to that module on next refresh.
- [ ] System Administrator retains every action for every module.

## 5. Main dashboard
- [ ] `/dashboard` renders the System Health, My Work, QMS Core, Operations, Technical Quality, People & Documents, Governance, Customer + POCT + Blood Bank, Process Management, Information & Records, and Alerts & Tasks sections.
- [ ] When the API is briefly unreachable the dashboard does not crash; missing sections show `—` instead of throwing.
- [ ] System Health counts match `/api/dashboard/system-health-summary` returned values.
- [ ] My Work counts match `/api/dashboard/my-work-summary` for the signed-in user.

## 6. Notifications and My Tasks
- [ ] Notifications module loads `/notifications`.
- [ ] Topbar bell badge reflects unread count.
- [ ] My Tasks tab lists tasks assigned to the signed-in staff.
- [ ] Notification scan creates entries for at least one due date in a seeded module (e.g. equipment calibration due).

## 7. Document control
- [ ] Document master list page lists seeded documents.
- [ ] Creating a new document, uploading a file, and approving the document version completes without error.
- [ ] Attestation queue shows pending attestations for the signed-in staff.
- [ ] Watermarked print render opens in a new tab and triggers the OS print dialog.

## 8. NC/CAPA and actions
- [ ] Creating an NC from any source module records it under `/nc-capa`.
- [ ] CAPA can be created from an open NC.
- [ ] Actions tracker lists every action assigned to the signed-in staff.
- [ ] Closing an action records the closure timestamp.

## 9. Equipment / inventory / monitoring / safety
- [ ] Equipment register lists seeded items with calibration / maintenance due fields.
- [ ] Inventory low-stock / expiring soon / expired filters return the correct rows.
- [ ] Environmental monitoring readings outside warning / critical limits are flagged.
- [ ] Safety incidents can be created and closed.

## 10. IQC / EQA / Verification / MU
- [ ] Recording an IQC result triggers the range-based interpretation.
- [ ] Levey-Jennings trend renders for a selected material.
- [ ] EQA event can be marked submitted and result received.
- [ ] Method verification can move from planned → completed → approved.
- [ ] Measurement uncertainty record can move from draft → in_review → approved.

## 11. Blood bank handover
- [ ] Weekly handover record can be created with units, donations, and transfusion summaries.
- [ ] Adverse events can escalate to NC / CAPA / Safety Incident.
- [ ] Blood bank dashboard cards reflect the recorded counts.

## 12. Monthly Reports & LHIMS archive
- [ ] CSV and XLSX imports succeed for a sample LHIMS export file.
- [ ] Exception register lists rows that did not auto-map.
- [ ] Monthly report batch moves through draft → reviewed → approved → exported.
- [ ] TAT summary per section drill-down shows expected counts.

## 13. Internal assessments / checklists / internal audit marks
- [ ] Assessment program can be created and linked to one of the seeded starter checklists.
- [ ] Toggling `marking_enabled` on a checklist enables internal marks for selected questions.
- [ ] Internal score reports correctly with weighted section scores.
- [ ] No part of the UI rebrands internal marks as accreditation, GAS, SLIPTA, ISO, or star ratings.

## 14. Customer focus
- [ ] Stakeholders, agreements, and feedback records can be created.
- [ ] Feedback can escalate to Complaints / Actions / NC / CAPA.
- [ ] Satisfaction survey responses can be captured and analytics render.

## 15. POCT oversight
- [ ] POCT sites, devices, operators, and authorisations can be created.
- [ ] QC results trigger the range-based interpretation and the trend chart.
- [ ] Maintenance log roll-forward updates `next_service_due` on the linked device.
- [ ] Site-scoped monthly review summary generation populates the four summary fields.

## 16. Records / reports / evidence packs
- [ ] Report templates render in the Templates tab.
- [ ] Generate Report tab produces CSV/JSON/HTML output for at least one seeded template.
- [ ] Evidence pack can have items added and the JSON summary printed.
- [ ] Evidence pack detail card shows a Linked Records panel (Phase 15).
- [ ] Audit trail review records inline action.
- [ ] Data integrity scan records issues without auto-deletion.

## 17. Process management
- [ ] Lab test directory and acceptance criteria can be created.
- [ ] Specimen rejection records can escalate to NC / Action and close.
- [ ] Critical result notifications correctly flag escalation when the notification time exceeds the rule's timeframe.
- [ ] Referral sendouts display the `_delayed` flag when expected return date is past with no result received.
- [ ] Report amendment can move draft → authorised → closed.
- [ ] Process review summary generation populates rejection / critical / referral / amendment fields with counts.

## 18. Information management
- [ ] Information asset and system registers can be created and toggled.
- [ ] Access review `/generate-items` populates one item per user.
- [ ] Per-item review decision saves (`keep_access` / `modify_access` / `remove_access` / `suspend_account` / `needs_investigation`).
- [ ] Security incident can escalate to NC / CAPA / Action.
- [ ] Data correction request follows submitted → reviewed → approved → completed → closed.
- [ ] Change request follows submitted → reviewed → approved → implemented → validated → closed.
- [ ] Software release can be approved, deployed, and archived.
- [ ] System validation can be approved and closed.
- [ ] Downtime record duration_minutes is calculated when both start and end are present.
- [ ] Information management review summary generation populates assets / access / incidents / change / downtime / validation / data-integrity fields.

## 19. Backup / restore check records
- [ ] Backup creation produces a zip in the configured backup folder.
- [ ] Backup file appears in Settings → Backup & Restore.
- [ ] Backup/Restore check records can be added under Records, Reports & Evidence.
- [ ] Restore endpoint remains a guarded placeholder and returns the expected message.

## 20. Audit trail review
- [ ] Audit trail browse filters by module, action, actor, and date range.
- [ ] Creating an audit-trail review records the review and optionally an action.

## 21. Build and packaging readiness
- [ ] `npm install` completes without optional-dependency errors on the target Windows laptop.
- [ ] `npm run typecheck` passes.
- [ ] `npm run build` produces `dist/` without errors.
- [ ] `npm run dev` launches the Electron window and connects to the local host API.
- [ ] After packaging (future phase), the Windows installer will need its own dedicated test pass — track this as an outstanding item.

---

## Sign-off

| Section | Pass / Fail / N/A | Notes |
| --- | --- | --- |
| Setup and login | | |
| User/staff linkage | | |
| Module navigation | | |
| Permissions | | |
| Main dashboard | | |
| Notifications and My Tasks | | |
| Document control | | |
| NC/CAPA and actions | | |
| Equipment / inventory / monitoring / safety | | |
| IQC / EQA / Verification / MU | | |
| Blood bank handover | | |
| Monthly reports archive | | |
| Internal assessments / checklists / internal audit marks | | |
| Customer focus | | |
| POCT oversight | | |
| Records / reports / evidence packs | | |
| Process management | | |
| Information management | | |
| Backup/restore check records | | |
| Audit trail review | | |
| Build and packaging readiness | | |

Tester name: ________________ &nbsp;&nbsp;&nbsp;&nbsp; Date: ________________ &nbsp;&nbsp;&nbsp;&nbsp; Build commit: ________________
