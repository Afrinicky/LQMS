# 03 — Risk Assessment

**Method:** GAMP 5 (2nd ed.) risk-based approach, using the ISO 14971:2019 analysis structure
by analogy. **Scope:** functions of SECH_LIMS 0.1.0 as deployed. **Date:** 10 August 2026.

---

## 1. Method

For each function the assessment asks three questions in order, exactly as GAMP 5 §5 sets out:

1. **What is the harm** if the function fails, produces a wrong result, or is used by someone
   who should not have it? Harm here is to the *quality record* and to the laboratory's ability
   to defend its results — not to a patient directly, because this system issues no patient
   result (see document 01 §2.2).
2. **How likely** is that failure, given how the function is built?
3. **How likely is it to be detected** before it does harm?

Risk class = Severity × Likelihood, then adjusted by Detectability.

| Severity | Definition |
|----------|------------|
| **High** | A quality record is lost, corrupted, or rendered indefensible; or an unauthorised person acts as an authorised one; or the laboratory cannot demonstrate what happened |
| **Medium** | Assurance is degraded; a standard clause is breached; recovery is possible but manual |
| **Low** | Inconvenience, cosmetic or documentation-only impact |

| Likelihood | Definition |
|------------|------------|
| **High** | Expected in normal operation, or reachable by an ordinary user without special effort |
| **Medium** | Requires an unusual sequence, a hostile actor on the LAN, or a rare concurrency |
| **Low** | Requires host compromise, physical access, or a defect not observed in testing |

| Detectability | Effect on risk class |
|---------------|----------------------|
| **Detectable** — the system or a routine check surfaces it | Reduce one class |
| **Undetectable** — nothing in the system would reveal it | Raise one class |

| Risk class | Consequence for this validation |
|------------|-------------------------------|
| **1 — High** | Must be tested by execution; must be closed or covered by an accepted, documented control before release |
| **2 — Medium** | Tested by execution or witnessed script; corrective action scheduled |
| **3 — Low** | Design review and build verification sufficient |

## 2. Function-level risk register

| # | Function | Failure considered | Sev | Lik | Det | Class | Test depth applied |
|---|----------|--------------------|-----|-----|-----|-------|--------------------|
| R-01 | Authentication | An unauthorised person signs in as a member of staff | High | Med | Undetectable (sign-ins are not audited) | **1** | Executed — OQ-3.1–3.9 |
| R-02 | Password guessing | Credentials brute-forced over the LAN | High | High (no lockout, no rate limit) | Undetectable | **1** | Executed — OQ-3.6 |
| R-03 | Transport of credentials and records | Traffic read or altered on the LAN | High | Med | Undetectable | **1** | Executed — OQ-1.3 |
| R-04 | Authorisation (RBAC) | A user acts beyond their competence or authority | High | Med | Detectable (audit trail) | **1** | Executed + witnessed — OQ-4.x, 48 script assertions |
| R-05 | Technical authorisation levels | An expired or "view only" authorisation confers approval | High | Low | Detectable | **2** | Witnessed — rbac-check, rbac-matrix |
| R-06 | Audit trail capture | A change is made with no record of who or what | High | Low | Undetectable | **1** | Executed — OQ-5.1–5.4 |
| R-07 | Audit trail integrity at rest | History is altered or deleted by someone with file access | High | Med | Undetectable | **1** | Inspected — OQ-5.8 |
| R-08 | Security event logging | An attack or misuse leaves no trace | High | High | Undetectable | **1** | Executed — OQ-5.5 |
| R-09 | Electronic signature — identity | A signature is applied by someone other than the signer | High | Med (unattended workstation) | Undetectable | **1** | Executed — OQ-6.5 |
| R-10 | Electronic signature — content binding | The record is altered after signing | High | Med | Undetectable | **1** | Inspected — OQ-6.6 |
| R-11 | Signature↔audit linkage | A signature is attributed to the wrong audit entry | Med | Low (concurrency) | Undetectable | **2** | Inspected — OQ-6.7 |
| R-12 | Backup creation | No usable copy exists when the host is lost | High | Low | Detectable (register + schedule check) | **2** | Executed — OQ-7.2, PQ-2.x |
| R-13 | Backup integrity | A corrupt or substituted archive is restored over live data | High | Low | Undetectable (no checksum) | **1** | Executed — OQ-7.4, PQ-5.3 |
| R-14 | Restore | Recovery fails, or loses records that were in the backup | High | Low | Detectable | **1** | Executed — PQ-4.1–4.7 |
| R-15 | Backup confidentiality | The whole quality record leaks via an unencrypted off-site copy | High | Med (cloud destinations) | Undetectable | **1** | Inspected — OQ-7.7 |
| R-16 | Database confidentiality at rest | A stolen or shared host yields every record without authentication | High | Med | Undetectable | **1** | Inspected — OQ-7.8 |
| R-17 | Data-integrity monitoring | Orphaned or inconsistent records accumulate unnoticed | Med | Med | Detectable | **2** | Executed — OQ-7.1, PQ-5.1 |
| R-18 | Injection / hostile input | Database contents read or altered through the API | High | Low (parameterised throughout) | Detectable | **2** | Executed — OQ-8.3 |
| R-19 | Path traversal on file retrieval | Arbitrary host files disclosed | High | Low | Detectable | **2** | Executed — OQ-7.5 |
| R-20 | Cross-origin exposure | A malicious page drives the API of a LAN-exposed host | Med | Med (hybrid mode only) | Undetectable | **2** | Executed — OQ-8.6 |
| R-21 | Session lifetime | An unattended signed-in workstation is used by another person | High | High | Undetectable | **1** | Executed — OQ-3.10 |
| R-22 | Setup / first administrator | A second unaudited administrator is created | High | Low | Detectable | **2** | Executed — OQ-2.3 |
| R-23 | Account lifecycle | A departed member of staff retains access | High | Low | Detectable | **2** | Executed + witnessed — OQ-4.8, account-check |
| R-24 | Personal-data confidentiality | Staff health, ID or licence data reaches colleagues | High | Low | Detectable | **2** | Witnessed — rbac-selfservice |
| R-25 | IQC evaluation | A control run is misinterpreted, or an expired lot is used | High | Low | Detectable | **2** | Witnessed — 191 IQC assertions |
| R-26 | Alerting and due dates | An overdue calibration, competency or review is not raised | Med | Low | Detectable | **2** | Witnessed — alerts-check |
| R-27 | Release identification | The deployed build cannot be tied to its source | High | High (version frozen at 0.1.0) | Undetectable | **1** | Inspected — OQ-9.2 |
| R-28 | Third-party components | A known vulnerability is exploited through a dependency | High | Med | Detectable (npm audit) | **1** | Executed — OQ-9.5 |
| R-29 | Installer authenticity | A tampered installer is deployed | High | Low | Undetectable (unsigned) | **1** | Inspected — OQ-9.4 |
| R-30 | Regression on change | A change silently breaks a module nobody re-tested | High | High | Undetectable | **1** | Inspected — OQ-9.1 |
| R-31 | Record retention | Records destroyed too early, or kept without control | Med | Low | Detectable | **3** | Design review — no destructive automation exists |
| R-32 | Availability | Host crashes under malformed input | Med | Low | Detectable | **2** | Executed — OQ-8.1, 8.4 |
| R-33 | Cloud sync / remote portal | Records replicated beyond the laboratory's control | High | Low (disabled by default) | Detectable | **3** | Out of scope — see §4 |

## 3. Risk profile

| Class | Count | Disposition |
|-------|-------|-------------|
| **1 — High** | 16 | All executed or inspected; 12 produced deviations requiring corrective action or an accepted interim control |
| **2 — Medium** | 15 | All tested; 4 produced deviations |
| **3 — Low** | 2 | Design review only |

The concentration of Class 1 risk is not in the quality functions — those tested clean — but in
the **platform controls around them**: transport security, credential protection, audit-trail
integrity, signature identity, encryption at rest, and the lifecycle controls that would keep
all of the above true after the next change.

## 4. Exclusions and their justification

| Excluded | Justification |
|----------|---------------|
| Cloud synchronisation, PostgreSQL driver, remote Vercel portal | Disabled by default (`SECH_LIMS_SYNC_ENABLED=false`, `sync.status = "planned"`) and not enabled in the validated configuration. **Enabling any of them invalidates this validation** and requires a supplementary risk assessment and OQ — see document 09 §3. |
| Capacitor Android build, PWA over the LAN | Not part of the validated configuration. The PWA inherits every transport finding (VF-01) and must not be deployed until that is closed. |
| Windows installer packaging (`dist:win`) | Cannot be produced or executed in this environment; requires a Windows host with the native toolchain. IQ on the target machine remains outstanding — see document 04 §2.3. |
| Patient data protection | The system holds none by design. Confirmed by module inspection: process-management records use request/specimen references. |
| Accreditation scoring (SLIPTA, GAS, star ratings) | Excluded from the product by design. |

## 5. Residual risk after planned corrective action

If the corrective actions in document 06 are completed as scheduled, every Class 1 risk falls to
Class 2 or below, with two exceptions that remain and must be owned procedurally:

- **R-07 (audit-trail integrity at rest)** — SQLite gives no write-once storage. Even with a
  hash chain, the laboratory relies on host access control. Mitigate by restricting host
  administrator accounts and reviewing the trail at defined intervals.
- **R-16 (database confidentiality)** — full encryption at rest requires SQLCipher or an
  encrypted volume; until then, physical and operating-system security of the host is the
  control.
