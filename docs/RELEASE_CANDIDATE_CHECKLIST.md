# SECH_LIMS by Nickland — Release Candidate Checklist

A short, practical checklist to run through on the target Windows machine
before signing off a release candidate for the laboratory to use.

Tester name: ________________ &nbsp;&nbsp;&nbsp;&nbsp; Date: ________________ &nbsp;&nbsp;&nbsp;&nbsp; Build commit: ________________

Mark each item as Pass / Fail / N/A.

---

## 1. Build check
- [ ] `npm install` completes without optional-dependency errors.
- [ ] `npm run smoke` reports 0 failures.
- [ ] `npm run typecheck` exits clean.
- [ ] `npm run build` produces `dist/` and `dist-electron/`.

## 2. Login / setup check
- [ ] On a fresh database, `/api/setup/status` returns `setupComplete=false`.
- [ ] The setup wizard creates the system administrator user, default modules, default positions, and default permissions.
- [ ] Logging in as the admin reaches `/home` without errors.
- [ ] `GET /api/system/about` returns the product name, version, `apiStatus = ok`, `lanReady = true`, and a `generatedAt` timestamp.

## 3. Admin / staff linkage check
- [ ] Settings → Users & Access lists the admin user.
- [ ] Linking the admin to a staff record updates `users.staff_id` and clears the "admin not linked" warning in setup health.
- [ ] `GET /api/settings/setup-health` reports `hasAdminUser = true`, `adminLinkedToStaff = true`, and an empty `warnings` array.

## 4. Permissions check
- [ ] Settings → Permission Matrix loads.
- [ ] System Administrator retains every action for every module.
- [ ] Removing a role permission removes the matching menu item / page after refresh.

## 5. Navigation check
- [ ] Every active module in the sidebar opens its own page without a 404.
- [ ] Disabled modules in Settings → System Modules hide from the sidebar and show the disabled-module page when navigated to.
- [ ] Settings remains reachable regardless of module toggles.

## 6. Master dashboard check
- [ ] `/dashboard` renders the System Health, My Work, QMS Core, Operations, Technical Quality, People & Documents, Governance, Customer + POCT + Blood Bank, Process Management, Information & Records, and Alerts & Tasks sections.
- [ ] When one summary endpoint is temporarily unreachable, the dashboard does not crash — it shows `—` for missing values.
- [ ] System Health and My Work numbers match the underlying API endpoints.

## 7. Module toggles check
- [ ] Disabling a module from Settings → System Modules updates the sidebar after refresh.
- [ ] Re-enabling restores the page.
- [ ] Disabled modules do not delete underlying data.

## 8. Backup check
- [ ] Settings → Backup & Restore can create a backup ZIP.
- [ ] The backup ZIP appears under the data folder's `backups/` subdirectory and contains the database, uploads, evidence, config, and a `backup-manifest.json`.
- [ ] Removing the application installer folder does not affect the database — the data lives under `%APPDATA%\SECH_LIMS by Nickland\local-data\`.

## 9. Restore test record check
- [ ] Records, Reports & Evidence → Backup/Restore Checks can record a restore test (status, findings, action required).
- [ ] The restore endpoint itself remains a guarded placeholder and returns the expected refusal message.

## 10. Audit trail check
- [ ] Records, Reports & Evidence → Audit Trail browses by module, action, actor, and date range.
- [ ] An audit trail review record can be created with an optional linked action.
- [ ] The `setup_health` and `demo_data_seed` audit entries appear when those endpoints are exercised.

## 11. Notifications scan check
- [ ] Notifications → Scan now (or scheduled run) inserts notifications for at least one detected due date.
- [ ] The topbar bell badge reflects the unread count.

## 12. My Tasks check
- [ ] Home page and `/dashboard` My Work blocks show the signed-in user's counts.
- [ ] `/api/dashboard/my-work-summary` returns matching numbers.

## 13. Linked records check
- [ ] Records, Reports & Evidence → Evidence Pack detail card shows the Linked Records panel.
- [ ] `GET /api/common/linked-records?module_key=…&record_type=…&record_id=…` returns outgoing and incoming `record_links` for a sample record.

## 14. Sample QMS workflows
- [ ] Create an NC, escalate to CAPA and Action, close all three.
- [ ] Approve a document version and assign an attestation.
- [ ] Record an IQC result that fails range, raise an NC, close it.
- [ ] Create a process review record and click Generate summary — the four summary fields populate.
- [ ] Create an information management review and click Generate summary — the seven summary fields populate.

## 15. LAN readiness check
- [ ] The host API binds to `0.0.0.0:4317` (configurable via `API_PORT`).
- [ ] Windows Defender Firewall has TCP 4317 allowed on the private profile only.
- [ ] Pairing codes can be created from Settings → Device Access / Pairing.

## 16. Windows installer check
- [ ] `npm run dist:win` produces an NSIS installer under `release/`.
- [ ] Installing on a clean Windows laptop creates desktop and start-menu shortcuts.
- [ ] The application launches, the API starts, and the first-run setup wizard appears on the new machine.
- [ ] Uninstalling removes the application but **does not** remove the data folder under `%APPDATA%\SECH_LIMS by Nickland\local-data\`.

## 17. Final user acceptance sign-off
- [ ] Acceptance testing checklist (`docs/ACCEPTANCE_TESTING_PHASE_15.md`) completed for this build.
- [ ] Module route smoke test (`docs/MODULE_ROUTE_SMOKE_TEST.md`) completed for this build.
- [ ] Laboratory leadership has signed off in writing.
- [ ] Roll-back plan recorded (previous installer + most recent backup ZIP location).

| Role | Name | Signature | Date |
| --- | --- | --- | --- |
| Laboratory Manager |  |  |  |
| Quality Manager |  |  |  |
| System Administrator |  |  |  |
| Tester |  |  |  |
