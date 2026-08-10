# 05 — Requirements Traceability Matrix

Forward trace (requirement → implementation → test → result) and reverse trace (test →
requirement), as required by GAMP 5 §7 and ISO/IEC/IEEE 29119-2.

Legend: **✅** verified · **⚠️** deviation raised · **ℹ️** observation

---

## 1. Forward trace

| Requirement | Implemented in | Test case | Result | Finding |
|-------------|----------------|-----------|--------|---------|
| URS-CFG-01 | `server/routes/setup.ts` `/status` | OQ-2.1, OQ-2.4 | ✅ | |
| URS-CFG-02 | `server/db/seed.ts` `setupInitialSystem` | OQ-2.2 | ✅ | |
| URS-CFG-03 | `seed.ts:616` user-count guard | OQ-2.3 | ✅ | |
| URS-INF-01 | `server/index.ts:93` `/api/health` | OQ-1.1 | ✅ | |
| URS-INF-02 | `common.ts:2241` `/system/about` | OQ-4.0a | ✅ | |
| URS-INF-03 | `common.ts:2285` `/system/connectivity` | OQ-4.0b | ℹ️ | |
| URS-SEC-01 | *(not implemented — HTTP only)* | OQ-1.3 | ⚠️ | VF-01 |
| URS-SEC-02 | `routes/auth.ts:14` bcrypt compare | OQ-3.1, OQ-3.2 | ✅ | |
| URS-SEC-03 | `auth.ts:20` response shaping | OQ-3.3 | ✅ | |
| URS-SEC-04 | `middleware/auth.ts` `optionalAuth`+`requireAuth` | OQ-3.4, OQ-3.5 | ✅ | |
| URS-SEC-05 | *(not implemented)* | OQ-3.6 | ⚠️ | VF-02 |
| URS-SEC-06 | `common.ts:583`, `auth.ts:56` length-only rule | OQ-3.7, OQ-3.8 | ⚠️ | VF-19 |
| URS-SEC-07 | `auth.ts:43` `/logout` session revoke | OQ-3.9 | ✅ | |
| URS-SEC-08 | `common.ts:197` router-wide `requireAuth` | OQ-1.2 | ✅ | |
| URS-SEC-09 | `auth_sessions.expires_at` (absolute only) | OQ-3.10 | ⚠️ | VF-18 |
| URS-SEC-10 | `common.ts:578` `POST /users` | OQ-4.1, OQ-4.2 | ✅ | |
| URS-SEC-11 | `middleware/permissions.ts` `requirePermission` | OQ-4.3–4.6 | ✅ | |
| URS-SEC-12 | `permissionResolver.ts` `getEffectivePermissions` | OQ-4.7 | ✅ | |
| URS-SEC-13 | `middleware/auth.ts:13` `u.is_active = 1` in the session join | OQ-4.8 | ✅ | |
| URS-SEC-14 | `backupService.ts` `isSafeBackupName` | OQ-7.5 | ✅ | |
| URS-SEC-15 | Parameterised statements throughout `server/` | OQ-8.3 | ✅ | |
| URS-SEC-16 | *(no security-header middleware)* | OQ-8.5 | ⚠️ | VF-15 |
| URS-SEC-17 | `index.ts:88` `cors({ origin: true, credentials: true })` | OQ-8.6 | ⚠️ | VF-16 |
| URS-SEC-18 | `auth_sessions.token` stored in plain text; client keeps it in `localStorage` | Inspection | ⚠️ | VF-20 |
| URS-SEC-19 | `records_reports.audit` permission; administrator holds every right | Inspection | ⚠️ | VF-24 |
| URS-AUD-01 | `services/auditService.ts`; `recordsReports.ts:557` | OQ-5.1, PQ-1.2 | ✅ | |
| URS-AUD-02 | `auditService.ts:6` actor, IP, device, timestamp | OQ-5.2 | ✅ | |
| URS-AUD-03 | `audit_logs.new_value` | OQ-5.3 | ✅ | |
| URS-AUD-04 | `audit_logs.old_value`, populated by route handlers | OQ-5.4; `account-check`, `iqc-admin-check` | ✅ | |
| URS-AUD-05 | `requirePermission('records_reports.audit','view')` | OQ-4.6 | ✅ | |
| URS-AUD-06 | *(login writes no audit entry)* | OQ-5.5 | ⚠️ | VF-03 |
| URS-AUD-07 | SQLite `CURRENT_TIMESTAMP`, no zone marker | OQ-5.6 | ⚠️ | VF-17 |
| URS-AUD-08 | No update/delete route exists on `audit_logs` | OQ-5.7 | ✅ | |
| URS-AUD-09 | Plain writable table; no hash chain or trigger | OQ-5.8 | ⚠️ | VF-05 |
| URS-AUD-10 | Trail travels inside the SQLite file in the backup | PQ-4.6 | ✅ | |
| URS-AUD-11 | `common.ts:2156` restore audit entry | PQ-4.7 | ✅ | |
| URS-SIG-01 | `services/signatureService.ts` `recordSignature` | OQ-6.1 | ✅ | |
| URS-SIG-02 | `e_signatures` signer_name, signed_at, meaning | OQ-6.2 | ✅ | |
| URS-SIG-03 | `(module_key, record_type, record_id)` binding + index | OQ-6.3 | ✅ | |
| URS-SIG-04 | `signatureService.ts:52` authentication guard | OQ-6.4 | ✅ | |
| URS-SIG-05 | *(session token alone; no component re-entry)* | OQ-6.5 | ⚠️ | VF-04 |
| URS-SIG-06 | *(no content hash stored)* | OQ-6.6 | ⚠️ | VF-13 |
| URS-SIG-07 | `signatureService.ts:76` last-row lookup | OQ-6.7 | ⚠️ | VF-14 |
| URS-DAT-01 | `recordsReports.ts:736` basic scan | OQ-7.1, PQ-5.1 | ✅ | |
| URS-DAT-02 | `backupService.ts` `writeBackupZip`; `BackupScheduler` | OQ-7.2, PQ-2.1–2.2 | ✅ | |
| URS-DAT-03 | `common.ts:2027` `/backup/list`, `backup_logs` | OQ-7.3 | ✅ | |
| URS-DAT-04 | *(no checksum stored or verified)* | OQ-7.4, PQ-5.3 | ⚠️ | VF-08 |
| URS-DAT-05 | `common.ts:2108` pre-restore snapshot, aborts on failure | PQ-4.2, OQ-7.6 | ✅ | |
| URS-DAT-06 | Plain ZIP; `backupTransports.ts` uploads as-is | OQ-7.7 | ⚠️ | VF-07 |
| URS-DAT-07 | Unencrypted SQLite file | OQ-7.8 | ⚠️ | VF-06 |
| URS-DAT-08 | `backup-manifest.json` | PQ-2.3 | ✅ | |
| URS-DAT-09 | `common.ts:2066` `/backup/restore` | PQ-4.1 | ✅ | |
| URS-DAT-10 | `pre-restore-*.zip`, exempt from pruning | PQ-4.2; `backup-scheduler-check` | ✅ | |
| URS-DAT-11 | `closeDb()` → swap → `getDb()` reopen | PQ-4.3 | ✅ | |
| URS-DAT-12 | WAL checkpoint before archiving (`backupService.ts:139`) | PQ-4.4 | ✅ | |
| URS-DAT-13 | Whole-file database replacement | PQ-4.5 | ✅ | |
| URS-DAT-14 | Basic scan after recovery | PQ-5.1 | ✅ | |
| URS-DAT-15 | Retention rules recorded; no destructive automation | Inspection | ℹ️ | VF-25 |
| URS-REL-01 | `express.json` parser + error handler | OQ-8.1 | ✅ | |
| URS-REL-02 | `index.ts:190` error handler returns message only | OQ-8.2 | ✅ | |
| URS-REL-03 | — | OQ-8.4, PQ-5.2 | ✅ | |
| URS-QMS-01 | 33 modules over `server/routes/*` | PQ-1.1, OQ-4.1 | ✅ | |
| URS-QMS-02 | `routes/iqc*.ts`, `services/iqcEvaluation.ts` | `iqc-check` 38, `iqc-io-check` 80, `iqc-admin-check` 73 | ✅ | |
| URS-QMS-03 | `services/alertService.ts` | `alerts-check` 31 | ✅ | |
| URS-QMS-04 | `common.ts` user routes, `services/userReferences.ts` | `account-check` 37 | ✅ | |
| URS-QMS-05 | `backupService.ts`, `backupDestinations.ts`, `backupTransports.ts` | `backup-scheduler-check` 22, `backup-destinations-check` 58 | ✅ | |
| URS-QMS-06 | `permissionResolver.ts` `canReachPersonalRecord` | `rbac-selfservice` 18 | ✅ | |
| URS-QMS-07 | `permissionResolver.ts` `TECHNICAL_LEVEL_ACTIONS`, view-as-floor | `rbac-check` 16, `rbac-matrix` 14 | ✅ | |
| URS-LC-01 | *(no test framework declared)* | OQ-9.1 | ⚠️ | VF-09 |
| URS-LC-02 | `package.json` version `0.1.0` | OQ-9.2 | ⚠️ | VF-11 |
| URS-LC-03 | `.github/workflows/` | OQ-9.3 | ⚠️ | VF-22 |
| URS-LC-04 | `electron-builder` config, `"publish": null` | OQ-9.4 | ⚠️ | VF-12 |
| URS-LC-05 | `package-lock.json` | OQ-9.5, IQ-6 | ⚠️ | VF-10 |
| URS-LC-06 | *(no controlled specification baseline)* | Inspection | ⚠️ | VF-21 |
| URS-LC-07 | `scripts/*-check.mjs` | §4.1 of doc 04 | ⚠️ | VF-23 |

## 2. Reverse trace — coverage

| Test source | Cases | Requirements covered | Orphan tests |
|-------------|-------|---------------------|--------------|
| IQ (build, structure, dependencies) | 120 | URS-CFG-01, URS-LC-05, structural integrity | 0 |
| OQ suite | 61 | 45 requirements | 0 |
| PQ suite | 16 | 16 requirements | 0 |
| Supplier scripts | 467 | URS-QMS-02…07, URS-AUD-04, URS-DAT-02/03/10, URS-SEC-11 | 0 |

**Coverage:** every one of the 75 requirements in document 02 traces to at least one executed,
witnessed or inspected verification. No test exists that does not trace back to a requirement.

**Requirements verified by inspection only (4):** URS-SEC-18, URS-SEC-19, URS-DAT-15, URS-LC-06.
Each concerns the absence of a control or a stored-data property that cannot be provoked through
the API. Each is recorded as such in document 06.
