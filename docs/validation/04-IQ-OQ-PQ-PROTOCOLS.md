# 04 — Installation, Operational and Performance Qualification Protocols

**Executed:** 10 August 2026 · **Build:** commit `dc73f10` · **Environment:** Linux 6.18.5,
Node v22.22.2, npm 10.9.7

Structured to ISO/IEC/IEEE 29119-3 (test documentation). Every protocol below was executed;
the raw evidence is in `evidence/`.

---

## 1. Test environment

| Item | Value |
|------|-------|
| Operating system | Linux 6.18.5 (validation host) |
| Node.js | v22.22.2 |
| Database | SQLite via `better-sqlite3` 11.7.0, WAL journal, `foreign_keys = ON` |
| API bind | `127.0.0.1` (loopback), ports 4399–4488 for isolated instances |
| Data directory | Scratch directory per run; the laboratory's `local-data/` was never touched |
| Sync | Disabled (`SECH_LIMS_SYNC_ENABLED` unset → `false`) |

**Environment limitation.** The validated configuration is a Windows desktop host. This
qualification ran on Linux. Everything above the packaging layer — API, database, permission
resolver, audit trail, signatures, backup and restore — is platform-independent and its results
carry over. The Windows-specific layer (NSIS installer, `better-sqlite3` native rebuild against
Electron headers, `app.getPath('userData')` data location, firewall) **must be re-qualified on
the target machine**; see §2.3.

---

## 2. Installation Qualification (IQ)

**Objective:** the software builds from its controlled source into the artefacts it is meant to
produce, and its structure is intact.

### 2.1 Test cases

| ID | Test | Acceptance criterion | Result | Evidence |
|----|------|---------------------|--------|----------|
| IQ-1 | `npm install` from `package-lock.json` | Completes without error | **Pass** (exit 0) | `iq-build-evidence.log` |
| IQ-2 | `npm run typecheck` (`tsc --noEmit`) | No type errors across ~73,600 lines | **Pass** (exit 0) | `iq-build-evidence.log` |
| IQ-3 | `npm run smoke` — structural integrity | All checks pass | **Pass** — 120/120, 0 failed | `iq-build-evidence.log` |
| IQ-4 | `npm run build` — renderer + Electron main + preload | Build completes, artefacts written | **Pass** (exit 0) | `iq-build-evidence.log` |
| IQ-5 | Database schema initialises on a clean data directory | Tables created, seed applied, `setupComplete=false` | **Pass** | OQ-2.1 |
| IQ-6 | Dependency inventory and vulnerability state | No known exploitable vulnerabilities | **Deviation VF-10** — 45 advisories (1 critical, 36 high) | `iq-build-evidence.log` |

IQ-3 verifies 120 structural facts: entry points, every server route module, shared constants,
PWA manifest, service worker `/api` bypass, Electron packaging configuration, `asarUnpack` of
the native SQLite module, and the npm script set.

### 2.2 Result

**IQ passed** with one deviation (VF-10). The build is reproducible from the committed lockfile
and produces the expected artefacts.

### 2.3 Outstanding IQ on the target platform

The following must be executed on the Windows host before production use and appended to this
package. They are not failures — they are untested on the platform that matters.

| ID | Test | Acceptance criterion |
|----|------|---------------------|
| IQ-W1 | `npm run dist:win` on Windows with the native toolchain | NSIS installer produced; `better-sqlite3` rebuilt against Electron 32.3.3 headers |
| IQ-W2 | Install the produced `.exe` on a clean Windows machine | Application installs and launches |
| IQ-W3 | Confirm data location | Database, uploads, evidence, backups under `%APPDATA%/.../local-data`, never in the install directory |
| IQ-W4 | Reinstall / upgrade over an existing installation | User data survives untouched |
| IQ-W5 | Execute `docs/MODULE_ROUTE_SMOKE_TEST.md` on the installed application | Every route resolves |
| IQ-W6 | Execute `docs/RELEASE_CANDIDATE_CHECKLIST.md` (17 sections) | Signed off by the Quality Manager |

---

## 3. Operational Qualification (OQ)

**Objective:** each control the standards require behaves as specified, under conditions
including hostile and boundary input.

**Protocol:** `scripts/validation/oq-suite.mjs` — 61 test cases in nine groups. Re-execute with:

```bash
npm run validate:oq
```

The suite starts its own host on an isolated scratch data directory and stops it afterwards, so
it cannot reach the laboratory's data. Results are written to `evidence/oq-results.json`.

### 3.1 Test groups

| Group | Subject | Cases | Standard basis |
|-------|---------|-------|----------------|
| OQ-1 | System identification and installation state | 3 | Annex 11 §4.3, ISO 27001 A.8.7 |
| OQ-2 | Controlled first-time setup | 4 | ISO 15189 §7.6.2, Part 11 §11.10(d) |
| OQ-3 | Authentication and session control | 10 | Part 11 §11.10(d), §11.300; ISO 27001 A.5.15–A.5.18 |
| OQ-4 | Role-based access control | 10 | ISO 15189 §7.6.2, Part 11 §11.10(d),(g) |
| OQ-5 | Audit trail | 8 | Part 11 §11.10(e), Annex 11 §9, ISO 15189 §7.6.3 |
| OQ-6 | Electronic signatures | 7 | Part 11 Subpart C, Annex 11 §14 |
| OQ-7 | Data integrity, backup and recovery | 8 | ISO 15189 §7.6.4, Annex 11 §7 |
| OQ-8 | Input handling and error behaviour | 6 | ISO 25010 reliability, ISO 27001 A.8.26 |
| OQ-9 | Software lifecycle controls | 5 | ISO 12207, ISO 29119, GAMP 5 |

### 3.2 Outcome classification

The suite distinguishes three outcomes, and the distinction is the point:

- **PASS** — a required control was exercised and behaved as specified.
- **DEVIATION** — the control is absent or partial. Recorded as a finding, not as a functional
  failure, and it does not fail the run.
- **FAIL** — a control that exists did not behave as specified.

### 3.3 Result

```
Executed 61 test cases: 38 passed, 0 failed, 19 deviations, 4 observations.
```

**No specified behaviour was found broken.** Every deviation is a control the standards require
that the build does not implement. Deviations map to VF-01 through VF-19 and VF-22 in
document 06.

### 3.4 Corrections made during execution

Two test cases (system identification and connectivity reporting) initially reported FAIL. On
investigation the cause was in the test, not the system: `/api/system/about` and
`/api/system/connectivity` sit behind the router-wide `requireAuth` guard in
`server/routes/common.ts:197`, so an unauthenticated probe is correctly refused. The cases were
rewritten — one to assert the refusal (OQ-1.2, now Pass) and one to query with a session
(OQ-4.0a/b, now Pass). This is recorded because an assumption drawn from reading source was
corrected by executing against the system, which is the reason executed evidence outranks
inspection in document 01 §4.1.

---

## 4. Supplier verification scripts (witnessed re-execution)

The supplier ships twelve verification scripts. All were re-executed here on clean, isolated
databases and their output captured in `evidence/supplier-check-scripts.log`.

| Script | Subject | Assertions | Result |
|--------|---------|-----------|--------|
| `smoke-check` | Structural integrity (counted under IQ-3) | 120 | 120 pass |
| `rbac-check` | View-as-floor rule, print/export gating, technical-authorisation levels, QR gating, alert filtering | 16 | 16 pass |
| `rbac-matrix` | Feature-level grants; a level cannot confer more than it states | 14 | 14 pass |
| `rbac-selfservice` | Staff reach their own record and no one else's; directory withholds ID and licence detail | 18 | 18 pass |
| `account-check` | Account lifecycle; the administrator cannot lock the laboratory out | 37 | 37 pass |
| `iqc-check` | Controls, lots, runs, rule evaluation; expired lots refused | 38 | 38 pass |
| `iqc-io-check` | IQC import/export; permission revocation blocks every path | 80 | 80 pass |
| `iqc-admin-check` | Corrections and removals retain what they replaced, with reasons | 73 | 73 pass |
| `alerts-check` | Cross-module scanning, routing by section and role, actionable URLs | 31 | 31 pass |
| `backup-check` | Backup creation, listing, restore, audit of schedule changes | 80 | 80 pass |
| `backup-scheduler-check` | Scheduled backups, missed-run catch-up, retention never pruning to zero | 22 | 22 pass |
| `backup-destinations-check` | Off-site destinations, remote pruning, stored secrets never returned | 58 | 58 pass |
| **Total** | | **587** | **587 pass, 0 fail** |

### 4.1 Execution-order defect

`rbac-matrix` and `rbac-selfservice` fail with a runtime error unless `rbac-roles` has first
seeded per-role probe users into the **same** host instance. Nothing documents this. Both pass
when chained correctly, which is how the results above were obtained. Recorded as **VF-23**.

`rbac-levels`, `rbac-probe` and `rbac-roles` produce permission matrices rather than
assertions; they were executed and their output retained as design evidence, and contribute no
pass/fail count.

---

## 5. Performance Qualification (PQ)

**Objective:** demonstrate the behaviour the laboratory actually depends on — that the quality
record survives the loss of the host.

**Protocol:** `scripts/validation/pq-recovery.mjs` — 16 test cases. Re-execute with:

```bash
npm run validate:pq
```

### 5.1 Scenario

1. Initialise a laboratory, create three staff records, confirm the audit trail captured them.
2. Take a backup and confirm the package exists on disk with a manifest.
3. Create a further record **after** the backup — the state a restore must roll back.
4. Restore from the backup.
5. Verify: the restore completes; a pre-restore safety snapshot was written; users can sign in
   again; every pre-backup record returned; the post-backup record is correctly gone; the audit
   trail survived; the restore was itself audited.
6. Run a data-integrity scan on the recovered system and confirm the host is still serving.

### 5.2 Result

```
Executed 16 test cases: 15 passed, 0 failed, 1 deviation.
```

Key observed values, verbatim from `evidence/pq-recovery-results.json`:

| Test | Observation |
|------|-------------|
| PQ-2.2 | Backup package written: 214,282 bytes |
| PQ-4.2 | Safety snapshot `pre-restore-2026-08-10T10-12-40-567Z.zip` written before any live data was touched |
| PQ-4.4 | All three pre-backup records returned |
| PQ-4.5 | Post-backup record correctly absent |
| PQ-4.6 | Audit trail: 5 entries before backup, 6 after restore (the extra entry being the restore itself) |
| PQ-4.7 | The restore event is present in the restored trail |
| PQ-5.1 | Data-integrity scan on the recovered system: 6 records checked, 0 issues, status `passed` |

**The disaster-recovery capability works.** This is the strongest single result in the
validation: a laboratory can lose its host and get its quality record back, complete and with
its history.

The one deviation (PQ-5.3 → **VF-08**) is that nothing proves the archive is authentic before
it overwrites live data. The restore checks that the ZIP opens, not that it is the archive the
laboratory took.

---

## 6. Re-execution and repeatability

```bash
npm run validate          # OQ then PQ, ~2 minutes
```

Both protocols are self-contained and non-destructive: each starts its own host on a scratch
data directory, and each refuses to run if a host is already listening on its port — because a
host left over from an earlier run has an initialised database, and every result after that
would be an artefact of the harness rather than evidence about the system.

**Repeatability was verified, not assumed.** Three consecutive executions produced identical
results with no residual processes:

| Run | OQ | PQ |
|-----|----|----|
| 1 | 38 passed, 0 failed, 19 deviations, 4 observations | 15 passed, 0 failed, 1 deviation |
| 2 | 38 passed, 0 failed, 19 deviations, 4 observations | 15 passed, 0 failed, 1 deviation |
| 3 | 38 passed, 0 failed, 19 deviations, 4 observations | 15 passed, 0 failed, 1 deviation |

This check was added because the second execution of the OQ suite initially reported eight
failures that the first had not. The cause was in the harness: it signalled the `npx` wrapper
rather than the process group, so the host survived and the next run silently connected to the
already-initialised instance from the previous one. The suite now spawns the host in its own
process group, tears down the whole tree, and pre-flights the port. Recorded here because a
protocol that gives a different answer on Tuesday is not a protocol — and because the same class
of defect, undetected, is exactly how a validation comes to certify something that was never
tested.

These protocols are the required evidence after any change classified Major in document 09.
