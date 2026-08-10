# 08 — Validation Summary Report

| | |
|---|---|
| **System** | SECH_LIMS by Nickland — Laboratory Quality Management System |
| **Version validated** | 0.1.0, commit `dc73f10` |
| **Laboratory** | St. Elizabeth Catholic Hospital Laboratory |
| **Validation period** | 10 August 2026 |
| **Approach** | GAMP 5 (2nd ed.) risk-based V-model, Category 5, retrospective baseline |
| **Standards** | ISO 15189:2022 · ISO/IEC 17025:2017 · ISO 9001:2015 · ISO/IEC 27001:2022 · ISO/IEC 25010:2023 · ISO/IEC/IEEE 29119 · ISO/IEC/IEEE 12207 · ISO 14971:2019 · ISO 22301:2019 · GAMP 5 · 21 CFR Part 11 · EU GMP Annex 11 · CLSI AUTO11/GP26 · Ghana Data Protection Act 843 |
| **Outcome** | **CONDITIONAL RELEASE** — approved for the restricted configuration in §6; not approved for LAN, mobile or remote deployment, nor for Part 11-compliant electronic signature, until the eight P1 findings are closed |

---

## 1. Executive summary

SECH_LIMS was validated by executing it — 664 test outcomes across installation, operational and
performance qualification, on isolated instances of the running system, at a single controlled
commit.

**Nothing the system claims to do was found not to work.** Zero test cases failed. The
laboratory-facing functions — document control, personnel and competency, equipment and
calibration, internal quality control, EQA, nonconformity and CAPA, internal audit, management
review, and the twenty-odd modules around them — behaved as specified under normal, boundary and
hostile conditions.

Two results are worth stating plainly because they are the ones an assessor will press hardest:

- **The disaster-recovery capability is real.** A populated laboratory was backed up, records
  were created and then lost, the system was restored, and everything that existed at backup
  time came back — including the audit trail, and including a record of the restore itself. The
  integrity scan on the recovered system was clean. Sixteen test cases, fifteen passed.
- **The permission model is genuinely well built.** Forty-eight independent assertions confirm
  that the right to view is a prerequisite for every other action, that a "view only" technical
  authorisation cannot confer approval, that an expired authorisation confers nothing, that
  disabling a module cascades, and that revoking a right blocks every route that leads to the
  data — including printing, exporting and QR resolution. This is better than most systems of
  this class achieve, and it was verified, not accepted on assertion.

Against that, **twenty-five findings** were raised. Not one is a broken feature. Every one is a
control that ISO 15189 §7.6, Annex 11, Part 11 or ISO 27001 requires, which this build does not
implement. Eight are Critical.

The single sentence that captures the result:

> **What the laboratory does with this system conforms to the standards; what protects the
> system does not yet.**

The application is well made. It sits on a platform that has no transport encryption, no defence
against password guessing, no record of who signed in, no tamper-evidence on the audit trail, no
encryption of the database or its backups, and no way to prove that a backup is the one the
laboratory took. Those are the eight P1 findings, and they are the whole distance between a
conditional and an unconditional release.

## 2. What was done

| Qualification | Method | Cases | Passed | Failed | Deviations | Observations |
|---------------|--------|-------|--------|--------|------------|--------------|
| **IQ** — build and installation | Executed: install, typecheck, structure check, production build, dependency audit | 120 | 120 | 0 | 1 (VF-10) | — |
| **Supplier verification** | Witnessed re-execution of 12 scripts on clean databases | 467 | 467 | 0 | 1 (VF-23) | — |
| **OQ** — operational controls | Executed: purpose-built 61-case suite, 9 groups | 61 | 38 | 0 | 19 | 4 |
| **PQ** — backup and recovery | Executed: full backup → loss → restore → verify cycle | 16 | 15 | 0 | 1 | — |
| **Total** | | **664** | **640** | **0** | **20** | **4** |

Two OQ suites (`npm run validate:oq`, `npm run validate:pq`) were written as part of this work
and committed with the code, so re-qualification after a change is a two-minute command rather
than a fortnight of manual testing. Both start their own host on a scratch data directory and
cannot reach the laboratory's records.

Deviation counts differ between qualifications and the findings register because several test
cases evidence the same finding, and four findings were established by inspection where the
control's absence cannot be provoked from outside.

## 3. What was found

### 3.1 Critical findings (P1) — eight

| # | Finding | Consequence |
|---|---------|-------------|
| VF-01 | No transport encryption | Every password and record crosses the LAN in clear the moment hybrid mode is enabled — which the product documentation instructs administrators to do |
| VF-02 | No lockout or throttling on failed sign-ins | 25 consecutive wrong passwords drew no response at all; guessing is unbounded |
| VF-03 | Sign-ins are not audited | The system cannot answer "who had access, and when" — the question ISO 15189 §7.6.2 exists to make answerable |
| VF-04 | Signatures need no re-authentication | An unattended signed-in workstation lets anyone apply another person's approval |
| VF-05 | Audit trail is not tamper-evident | No route can alter it — verified — but anyone with host file access can rewrite history undetectably |
| VF-06 | Database not encrypted at rest | A stolen host yields every staff record without authentication |
| VF-07 | Backups unencrypted, including off-site | The complete quality record leaves the building in the clear |
| VF-08 | Backup integrity unprovable | A corrupted or substituted archive would be restored over live data, and nothing would notice |

They cluster into four themes: **encryption** (VF-01, 06, 07), **credential protection**
(VF-02), **security logging** (VF-03), and **signature identity and record integrity**
(VF-04, 05, 08).

### 3.2 Major and minor findings

Twelve Major findings concern the software lifecycle and the security perimeter: no automated
regression suite (VF-09), 45 dependency advisories including a critical one (VF-10), a version
number frozen at `0.1.0` across every build ever shipped (VF-11), an unsigned installer (VF-12),
signatures not bound to content (VF-13), permissive cross-origin policy (VF-16), no inactivity
timeout (VF-18), a length-only password rule that accepted the password `password` (VF-19),
reusable stored session tokens (VF-20), no specification baseline before this validation
(VF-21), verification not enforced in CI (VF-22), and no enforced segregation of duties (VF-24).

Five Minor findings are recorded in document 06. One of them — VF-25, retention rules recorded
but never enforced by automatic destruction — is a deliberate and correct design decision, and
is recorded as an observation rather than a defect.

### 3.3 The finding that shapes everything else

**VF-11 — the version identifier has read `0.1.0` since the foundation MVP.** Every installer,
every About screen and every software-release record the laboratory writes carries the same
number. It is therefore impossible to state which build a given installation is running.

This validation is of commit `dc73f10`. Without a version bump, no deployed installation can be
tied to it — so the validated state cannot be demonstrated to an assessor even where it exists.
It is a one-line change with more compliance value than anything else on the list, and it should
be closed first.

## 4. Assessment against the acceptance criteria

| # | Criterion | Result |
|---|-----------|--------|
| AC-1 | Every Critical requirement has a passing test result | **Not met** — 35 of 47 met; 12 carry deviations |
| AC-2 | No test case reports FAIL | **Met** — 0 failures in 664 outcomes |
| AC-3 | Every deviation risk-rated, owned, with corrective action or accepted interim control | **Met** — document 06 |
| AC-4 | Backup and recovery demonstrated end to end | **Met** — PQ, 15/16 |
| AC-5 | Residual risk stated and accepted in writing by the system owner | **Pending signature** — §8 |

AC-1 not being met is what makes this release conditional rather than full.

## 5. Fitness for intended use

Intended use is quality-management oversight for a hospital laboratory, alongside LHIMS/Lightwave
which retains all patient and clinical-result functions. Judged against that use, and only that
use:

- **Functionally fit.** The modules do what the laboratory needs, and it has been demonstrated
  rather than asserted.
- **Recoverable.** The laboratory can lose its host and get its quality record back complete.
  Proven, not claimed.
- **Correctly authorised.** People see and do what their role, position and technical
  authorisation permit, and nothing more.
- **Not yet defensible as a secure system of record.** The audit trail can be altered by a host
  administrator; sign-ins leave no trace; signatures do not establish identity to the standard
  Part 11 sets. An assessor who asks "how do you know this record was not changed?" cannot be
  given a complete answer today.

The last point is not a reason to withhold the system from use. It is a reason to bound how it
is used, and to state honestly what its records currently prove.

## 6. Release decision

**CONDITIONAL RELEASE — approved for the following configuration only:**

| Condition | Requirement |
|-----------|-------------|
| C-1 | Single host. API bound to `127.0.0.1`. **Hybrid/LAN mode must not be enabled** until VF-01 is closed |
| C-2 | Mobile PWA, Capacitor build, LAN desktop clients and the remote portal **not deployed** until VF-01 and VF-02 are closed |
| C-3 | Cloud synchronisation and the PostgreSQL driver **remain disabled**; enabling either invalidates this validation |
| C-4 | Host protected by full-disk encryption and physical security, documented in the laboratory's information-security procedure (interim control for VF-06) |
| C-5 | Off-site backup copying **disabled**, or restricted to an encrypted volume under laboratory control (interim control for VF-07) |
| C-6 | Each backup verified manually after creation and the check recorded (interim control for VF-08) |
| C-7 | Electronic signatures described in laboratory procedures as **system-recorded approvals**, not as 21 CFR Part 11 electronic signatures, until VF-04 and VF-13 are closed |
| C-8 | Workstation locking enforced procedurally and evidenced through personnel training (interim control for VF-04, VF-18) |
| C-9 | Host administrator accounts restricted to named individuals; the audit trail reviewed at a defined frequency by someone other than the administrator, using the existing audit-review workflow (interim control for VF-05, VF-24) |
| C-10 | IQ on the target Windows platform (IQ-W1 to IQ-W6, document 04 §2.3) completed and appended before production use |

**The release is not approved for:** LAN or multi-client operation, mobile or remote access,
cloud synchronisation, or any claim of 21 CFR Part 11 / Annex 11 §14 electronic-signature
compliance.

**Review:** on closure of the P1 findings, or within six months, whichever is sooner
(document 09).

## 7. Recommendations, in order

1. **Close VF-11 (versioning) and VF-03 (sign-in auditing) first.** Both are small, contained
   changes; both unlock disproportionate compliance value.
2. **Then the encryption cluster — VF-01, VF-06, VF-07.** TLS on any non-loopback bind,
   encryption at rest, encrypted backup packages. These three are what stand between the system
   and LAN deployment.
3. **Then the identity cluster — VF-02, VF-04, VF-18, VF-19.** Lockout, signing
   re-authentication, inactivity timeout, a real password policy.
4. **Then VF-08 and VF-05.** Backup checksums, and a hash chain on the audit trail.
5. **In parallel, VF-09 and VF-22.** Adopt Vitest, convert the twelve existing scripts, gate
   merges on the validation suite. Without this, every fix above is one refactor away from
   silently regressing — and the next validation costs as much as this one.
6. **Record a supplier assessment** of Nickland and adopt document 02 as the controlled
   specification baseline (VF-21).

## 8. Approval

This report requires signature by the system owner, the process owner and an independent
reviewer. The independent reviewer must not be the person who performed the validation
(Annex 11 §2; ISO 15189 §7.6.3).

| Role | Name | Signature | Date |
|------|------|-----------|------|
| Validation lead | | | |
| System owner (Laboratory Manager) | | | |
| Process owner (Quality Manager) | | | |
| Independent reviewer | | | |

**By signing, the system owner accepts the residual risk stated in document 03 §5 and undertakes
to operate the system within conditions C-1 to C-10 above.**

---

### Supporting documents

Documents 00–09 of this package · `evidence/oq-results.json` · `evidence/pq-recovery-results.json`
· `evidence/iq-build-evidence.log` · `evidence/supplier-check-scripts.log` ·
`scripts/validation/oq-suite.mjs` · `scripts/validation/pq-recovery.mjs`
