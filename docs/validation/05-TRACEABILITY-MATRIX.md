# 05 — Requirements Traceability Matrix

**Software version:** 1.0.0 · **Baseline:**
[NSD-SRS-001](../specifications/NSD-SRS-001-Software-Requirements-Specification.md) v1.0 (76 requirements)

Forward trace (requirement → implementation → test → result) and reverse trace (test →
requirement), as required by GAMP 5 §7, ISO/IEC/IEEE 29119-2 and NSD-SRS-001 §12.2.

A test tracing to no requirement, and a requirement covered by no test, are each a defect in the
specification and are resolved before the validation report is approved. Neither exists at this
revision.

Legend: **✅** met · **⚠️** deviation · **ℹ️** observation — recorded as evidence, with no pass
condition in the baseline to judge against

---

## 1. Forward trace

| Requirement | Implemented in | Verified by | Result | Finding |
|-------------|----------------|-------------|--------|---------|
| URS-CFG-01 | `routes/setup.ts` `/status` | OQ-2.1, OQ-2.4 | ✅ | |
| URS-CFG-02 | `db/seed.ts` `setupInitialSystem` | OQ-2.2 | ✅ | |
| URS-CFG-03 | `seed.ts` user-count guard | OQ-2.3 | ✅ | |
| URS-INF-01 | `server/index.ts` `/api/health` | OQ-1.1 | ✅ | |
| URS-INF-02 | `utils/buildInfo.ts`; `/system/about` | OQ-4.0a, OQ-9.2 | ✅ | |
| URS-INF-03 | `/system/connectivity` | OQ-4.0b | ℹ️ | |
| URS-SEC-01 | `index.ts` `tlsOptions`, HTTPS listener and startup warning | OQ-1.3, OQ-8.5 | ✅ | |
| URS-SEC-02 | `routes/auth.ts` bcrypt compare; single refusal message | OQ-3.1, OQ-3.2 | ✅ | |
| URS-SEC-03 | `auth.ts` response shaping | OQ-3.3 | ✅ | |
| URS-SEC-04 | `middleware/auth.ts` `optionalAuth` + `requireAuth` | OQ-3.4, OQ-3.5 | ✅ | |
| URS-SEC-05 | `credentialService.ts` `lockState`, `recordFailure` | OQ-3.6, OQ-3.6b | ✅ | |
| URS-SEC-06 | `shared/constants/credentials.ts` `checkPassword`, applied at all four setting points | OQ-3.7, OQ-3.8; `tests/credentials.test.ts` | ✅ | |
| URS-SEC-07 | `auth.ts` `/logout` → `revokeSession` | OQ-3.9 | ✅ | |
| URS-SEC-08 | `common.ts` router-wide `requireAuth` | OQ-1.2 | ✅ | |
| URS-SEC-09 | `auth_sessions.last_seen_at`; idle check in `middleware/auth.ts` | OQ-3.10 | ✅ | |
| URS-SEC-10 | `common.ts` `POST /users` | OQ-4.1, OQ-4.2 | ✅ | |
| URS-SEC-11 | `middleware/permissions.ts` `requirePermission` | OQ-4.3–4.6 | ✅ | |
| URS-SEC-12 | `permissionResolver.ts` `getEffectivePermissions` | OQ-4.7 | ✅ | |
| URS-SEC-13 | `middleware/auth.ts` `u.is_active = 1` in the session join | OQ-4.8 | ✅ | |
| URS-SEC-14 | `backupService.ts` `isSafeBackupName` | OQ-7.5 | ✅ | |
| URS-SEC-15 | Parameterised statements throughout `server/`; dynamic SQL only from internal registries | OQ-8.3, inspection | ✅ | |
| URS-SEC-16 | `index.ts` `securityHeaders` | OQ-8.5 | ✅ | |
| URS-SEC-17 | `index.ts` `buildCorsPolicy` allow-list | OQ-8.6 | ✅ | |
| URS-SEC-18 | `middleware/auth.ts` `hashToken`; `auth_sessions.token_hash` | OQ-3.3b | ✅ | |
| URS-SEC-19 | `db/seed.ts` Independent Reviewer role | OQ-4.9; `tests/permissionResolver.test.ts` | ✅ | |
| URS-AUD-01 | `services/auditService.ts`; `recordsReports.ts` `/audit-trail` | OQ-5.1, PQ-1.2 | ✅ | |
| URS-AUD-02 | `auditService.ts` actor, address, device, timestamp | OQ-5.2 | ✅ | |
| URS-AUD-03 | `audit_logs.new_value` | OQ-5.3 | ✅ | |
| URS-AUD-04 | `audit_logs.old_value`, populated by route handlers | OQ-5.4; `account-check`, `iqc-admin-check` | ✅ | |
| URS-AUD-05 | `requirePermission('records_reports.audit', 'view')` | OQ-4.6 | ✅ | |
| URS-AUD-06 | `credentialService.ts` login/lockout auditing; `auth.ts` logout | OQ-5.5, OQ-3.6b, OQ-6.8 | ✅ | |
| URS-AUD-07 | `auditService.ts` `nowIso`; `audit_logs.recorded_at` | OQ-5.6; `tests/auditChain.test.ts` | ✅ | |
| URS-AUD-08 | No update or delete route exists on `audit_logs` | OQ-5.7 | ✅ | |
| URS-AUD-09 | `auditService.ts` hash chain; `verifyAuditChain`; integrity scan | OQ-5.8, OQ-5.9; `tests/auditChain.test.ts` | ✅ | |
| URS-AUD-10 | Trail travels inside the database file in the backup | PQ-4.6 | ✅ | |
| URS-AUD-11 | `common.ts` restore and refused-restore audit entries | PQ-4.7, PQ-5.5 | ✅ | |
| URS-SIG-01 | `services/signatureService.ts` `recordSignature` | OQ-6.1 | ✅ | |
| URS-SIG-02 | `e_signatures` signer name, signed_at, meaning | OQ-6.2 | ✅ | |
| URS-SIG-03 | `(module_key, record_type, record_id)` binding and index | OQ-6.3 | ✅ | |
| URS-SIG-04 | `signatureService.ts` authentication guard | OQ-6.4 | ✅ | |
| URS-SIG-05 | `signatureService.ts` password re-entry via `verifyPassword`; client prompt | OQ-6.5, OQ-6.8 | ✅ | |
| URS-SIG-06 | `signatureService.ts` `contentHashOf`; `contentChanged` on read | OQ-6.6 | ✅ | |
| URS-SIG-07 | `audit()` returns the inserted row id; the signature stores it | OQ-6.7 | ✅ | |
| URS-SIG-08 | `signatureService.ts` `recordAcknowledgement`; `reauthenticated` flag | OQ-6.5, inspection | ✅ | |
| URS-DAT-01 | `recordsReports.ts` basic scan | OQ-7.1, PQ-5.1 | ✅ | |
| URS-DAT-02 | `backupService.ts` `writeBackupZip`; `BackupScheduler` | OQ-7.2, PQ-2.1–2.2 | ✅ | |
| URS-DAT-03 | `/backup/list`, `backup_logs` | OQ-7.3 | ✅ | |
| URS-DAT-04 | `backupService.ts` `checksumOf`, `verifyChecksum`; restore gate | OQ-7.4, PQ-2.4, PQ-5.3–5.5; `tests/backupIntegrity.test.ts` | ✅ | |
| URS-DAT-05 | `common.ts` pre-restore snapshot, aborts on failure | PQ-4.2, OQ-7.6 | ✅ | |
| URS-DAT-06 | *Not implemented — packages are unencrypted archives* | OQ-7.7 | ⚠️ | VF-07 |
| URS-DAT-07 | *Not implemented — the database file is unencrypted* | OQ-7.8 | ⚠️ | VF-06 |
| URS-DAT-08 | `backup-manifest.json` | PQ-2.3 | ✅ | |
| URS-DAT-09 | `common.ts` `/backup/restore` | PQ-4.1 | ✅ | |
| URS-DAT-10 | `pre-restore-*.zip`, exempt from pruning | PQ-4.2; `backup-scheduler-check` | ✅ | |
| URS-DAT-11 | `closeDb()` → file swap → `getDb()` reopen | PQ-4.3 | ✅ | |
| URS-DAT-12 | WAL checkpoint before archiving | PQ-4.4 | ✅ | |
| URS-DAT-13 | Whole-file database replacement | PQ-4.5 | ✅ | |
| URS-DAT-14 | Integrity scan after recovery | PQ-5.1 | ✅ | |
| URS-DAT-15 | Retention rules recorded; no destructive automation exists | Inspection | ℹ️ | |
| URS-REL-01 | JSON body parser and central error handler | OQ-8.1 | ✅ | |
| URS-REL-02 | `index.ts` error handler returns the message only | OQ-8.2 | ✅ | |
| URS-REL-03 | — | OQ-8.4, PQ-5.2 | ✅ | |
| URS-QMS-01 | 33 modules over `server/routes/*` | PQ-1.1, OQ-4.1 | ✅ | |
| URS-QMS-02 | `routes/iqc*.ts`, `services/iqcEvaluation.ts` | `iqc-check` 38, `iqc-io-check` 80, `iqc-admin-check` 73 | ✅ | |
| URS-QMS-03 | `services/alertService.ts` | `alerts-check` 31 | ✅ | |
| URS-QMS-04 | `common.ts` user routes; `services/userReferences.ts` | `account-check` 37 | ✅ | |
| URS-QMS-05 | `backupService.ts`, `backupDestinations.ts`, `backupTransports.ts` | `backup-scheduler-check` 22, `backup-destinations-check` 58 | ✅ | |
| URS-QMS-06 | `permissionResolver.ts` `canReachPersonalRecord` | `rbac-selfservice` 18 | ✅ | |
| URS-QMS-07 | `permissionResolver.ts` `TECHNICAL_LEVEL_ACTIONS`; view-as-floor rule | `rbac-check` 16, `rbac-matrix` 14; `tests/permissionResolver.test.ts` | ✅ | |
| URS-LC-01 | Vitest; `tests/*.test.ts` | OQ-9.1; `npm test` (23 tests) | ✅ | |
| URS-LC-02 | `package.json` version; `utils/buildInfo.ts`; CI commit stamp | OQ-9.2 | ✅ | |
| URS-LC-03 | `.github/workflows/verify.yml`; packaging workflows gated on it | OQ-9.3 | ✅ | |
| URS-LC-04 | *Not implemented — no code-signing certificate configured* | OQ-9.4 | ⚠️ | VF-12 |
| URS-LC-05 | `package-lock.json`; CI dependency audit of shipped code | OQ-9.5, OQ-9.6, IQ-6 | ⚠️ | VF-10 |
| URS-LC-06 | NSD-SRS-001, approved and under the change control of its §12.3 | Inspection | ✅ | |
| URS-LC-07 | Execution order documented and enforced by `verify.yml` | OQ-9.3, inspection | ✅ | |

## 2. Reverse trace — coverage

| Verification source | Cases | Requirements covered | Orphan tests |
|---------------------|-------|---------------------|--------------|
| IQ — build, structure, dependencies | 120 | URS-CFG-01, URS-LC-01/02/05, structural integrity | 0 |
| Unit regression suite | 23 | URS-SEC-06/19, URS-AUD-07/09, URS-DAT-04, URS-QMS-07 | 0 |
| OQ suite | 67 | 48 requirements | 0 |
| PQ suite | 19 | 17 requirements | 0 |
| Supplier verification scripts | 467 | URS-QMS-02…07, URS-AUD-04, URS-DAT-02/03/10, URS-SEC-11 | 0 |

**Coverage:** every one of the 76 requirements in NSD-SRS-001 traces to at least one executed,
witnessed or inspected verification. No test exists that does not trace back to a requirement.

## 3. Summary

| Result | Count | Requirements |
|--------|-------|-------------|
| ✅ Met | 70 | |
| ⚠️ Deviation | 4 | URS-DAT-06, URS-DAT-07, URS-LC-04, URS-LC-05 |
| ℹ️ Observation | 2 | URS-INF-03, URS-DAT-15 |
| **Total** | **76** | |

By criticality: 45 of 47 Critical met (URS-DAT-06 and URS-LC-05 carry deviations); 21 of 25
Major met; 4 of 4 Minor met.

**Verified by inspection only (5):** URS-SEC-15 (in part), URS-DAT-06, URS-DAT-07, URS-DAT-15,
URS-LC-06. Each concerns a stored-data property or the absence of a control, which cannot be
provoked through the interface. Each is labelled as inspected in the validation report.

**Quality attributes not verified:** NSD-SRS-001 §11.3 states no numeric performance or capacity
target and no usability or accessibility requirement. Those two attributes are therefore neither
met nor failed — they are unspecified, and §12.4 of the baseline records that as a decision.
