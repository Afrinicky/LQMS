# 10 — Remediation and Re-qualification

**System:** SECH_LIMS by Nickland (LQMS) · **From:** 0.1.0 (`dc73f10`) · **To:** 1.0.0
**Re-qualified:** 10 August 2026

---

## 1. What this document is

The August 2026 validation raised 25 findings and released the system conditionally
(document 08). This records what was then fixed, what was deliberately not fixed and why, and
the results of re-running every qualification against the corrected build.

**Summary: 21 of 25 findings closed. Four remain open, all of them decisions for the system
owner rather than defects anyone can code away.**

| | Before | After |
|---|---|---|
| Test outcomes executed | 664 | **696** |
| Failures | 0 | **0** |
| Deviations | 20 | **4** |
| Critical (P1) findings open | 8 | **2** |
| Requirements met | 49 of 75 | **69 of 75** |

---

## 2. Findings closed

### 2.1 Critical

| # | Finding | What was done | Verified by |
|---|---------|---------------|-------------|
| **VF-01** | No transport encryption | The Host now serves HTTPS when `SECH_LIMS_TLS_CERT` and `SECH_LIMS_TLS_KEY` are set, and prints an explicit startup warning — naming what is at stake — if it is bound to a network address without them. HSTS is sent only when TLS is actually in use. | OQ-1.3, OQ-8.5 |
| **VF-02** | No protection against password guessing | Five consecutive failures lock the account for fifteen minutes. The lock is checked before the password, so guessing gains nothing by continuing, and it holds even against the correct password. Every attempt and every lock is audited. | OQ-3.6, OQ-3.6b |
| **VF-03** | Sign-ins not audited | `login_success`, `login_failed`, `login_blocked`, `account_locked` and `logout` are written to the audit trail with username, IP, device and time. An access review can now be answered from the system's own records. | OQ-5.5, OQ-3.6b |
| **VF-04** | Signatures required no re-authentication | Signing takes the signer's password at the moment of signing. A session alone is refused (400); a wrong password is refused (401) and the refusal is itself audited. Acknowledgements — reading a document, acknowledging an announcement — are recorded through a separate path marked `reauthenticated = 0`, so "read this" and "approved this" stay visibly different things. | OQ-6.5, OQ-6.8 |
| **VF-05** | Audit trail not tamper-evident | Each entry carries the SHA-256 of the entry before it. `GET /records-reports/audit-trail/verify` walks the chain, and the routine data-integrity scan does the same on every run. Entries written before chaining began are reported as unchained rather than back-filled. | OQ-5.8, OQ-5.9, `tests/auditChain.test.ts` |
| **VF-08** | Backup integrity unprovable | Every backup records a SHA-256. The digest is checked before a restore, and a mismatch refuses the restore outright rather than overwriting live data — proven by damaging an archive and confirming the refusal. | PQ-2.4, PQ-5.3, PQ-5.4, PQ-5.5 |

**On VF-05, the promise is worth stating precisely.** A hash chain cannot make a SQLite file
immutable — nothing in application code can, because the file belongs to whoever administers
the host. What it does is make tampering *visible*: a rewritten or deleted entry breaks the
chain from that point on, and the break is dated. The unit tests prove this by editing the
database behind the application's back and confirming the verifier reports it. Detectable
tampering is the honest form of "safeguarded against tampering" on this platform, and it is a
great deal better than the nothing that was there before.

### 2.2 Major

| # | Finding | What was done | Verified by |
|---|---------|---------------|-------------|
| **VF-09** | No automated regression suite | Vitest adopted; 23 tests covering the credential policy, the audit hash chain (including tamper and deletion detection), backup integrity and the permission resolver. `npm test` runs them in under four seconds. | `npm test` |
| **VF-10** | Dependency vulnerabilities | Patched down from 45 advisories to 31, and — the number that matters — **the shipped software now carries one**: `xlsx`. Everything else is build tooling that never reaches an installation. See §3. | OQ-9.5, OQ-9.6 |
| **VF-11** | Version identifier frozen | Version moved to 1.0.0; CI stamps the commit into the build; `/system/about` reports version, commit, build date and provenance (`release` when stamped by CI, `source` when run from a working tree). A deployed installation can now be tied to the code it came from. | OQ-9.2 |
| **VF-13** | Signatures not bound to content | Each signature stores a hash of the record as it stood. Reading signatures back returns `contentChanged`, so a record edited after signing is flagged wherever the signature appears. | OQ-6.6 |
| **VF-16** | Cross-origin policy accepted anything | Replaced with an allow-list: loopback, the Vite dev server, the configured public URL, the Host's own LAN addresses and `SECH_LIMS_ALLOWED_ORIGINS`. A request with no Origin — the desktop shell, the mobile app, the check scripts — is not a browser cross-origin request and still passes. | OQ-8.6 |
| **VF-18** | No inactivity timeout | Sessions carry a last-seen stamp and die after 30 minutes of inactivity, alongside the 12-hour absolute expiry. | OQ-3.10 |
| **VF-19** | Password policy was length-only | One policy in one place: minimum 12 characters, no common passwords, no runs or repeats, not your own name or username, and no reuse of the last five. Applied identically at account creation, administrator reset, self-service change and first-administrator setup — the four places that each used to enforce their own version. | OQ-3.7, OQ-3.8, `tests/credentials.test.ts` |
| **VF-20** | Session tokens stored reusably | The `token` column is gone. Sessions are looked up by SHA-256 digest, so reading the database yields nothing usable. Existing sessions were not migrated: a token stored in the clear should not survive the change that stops storing it in the clear. | OQ-3.3b |
| **VF-21** | No specification baseline | Document 02 is adopted as the controlled baseline; document 09 requires specification before change. | — |
| **VF-22** | Verification not enforced in CI | New `verify.yml` runs typecheck, unit tests, structure check, build, both qualification suites and every supplier check script. Both packaging workflows now declare `needs: verify`, so nothing is packaged from a build that failed its own checks. | OQ-9.3 |
| **VF-24** | Duties not separable | An `Independent Reviewer` role is seeded: reads the audit trail, the system-audit findings and the records, and holds no administrative right over the system it reviews. | OQ-4.9 |

### 2.3 Minor

| # | Finding | What was done |
|---|---------|---------------|
| **VF-14** | Signature↔audit link non-deterministic | `audit()` returns the id of the row it wrote; the signature stores that id instead of guessing at "the newest row in the table". |
| **VF-15** | No security headers | `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Cross-Origin-Opener-Policy`, `Permissions-Policy` and a Content-Security-Policy are set on every response. Written directly rather than by adding a dependency for eleven lines. |
| **VF-17** | Timestamps without a time zone | Audit entries carry `recorded_at` in ISO-8601 UTC with an explicit `Z`. Existing rows keep the form they were written with, and are reported as such. |
| **VF-23** | Verification scripts had undocumented prerequisites | The CI workflow documents and enforces the order: `rbac-roles` seeds the probe users that `rbac-matrix` and `rbac-selfservice` read. |
| **VF-25** | Retention not enforced | No change, and none wanted. Automatic destruction of quality records is a far worse failure mode than over-retention. Recorded as an accepted design decision. |

---

## 3. Findings deliberately left open

These four are not oversights. Each is a decision with consequences the laboratory has to own,
and implementing any of them unilaterally would have been the wrong call.

### VF-06 — The database is not encrypted at rest

Encrypting the SQLite file needs SQLCipher, which means changing a native dependency in a build
that already documents `better-sqlite3` as its most fragile packaging step — and it needs a key
custody procedure. **A lost key is a lost quality record.** That trade is the system owner's to
make, with the hospital's IT security, not the supplier's to impose.

*Interim control (C-4):* full-disk encryption on the host and physical security, documented in
the laboratory's information-security procedure.

### VF-07 — Backups are not encrypted

The same reasoning, more sharply. Backups are the laboratory's last line of defence, and the
backup subsystem currently passes 158 assertions covering scheduling, retention that never
prunes to zero, off-site copying and restore. Encrypting the archive means a key that, if lost,
turns every backup into noise on the day it is needed most.

The integrity half of this problem is now closed (VF-08): a laboratory can prove an archive is
the one it took. The confidentiality half needs a key-custody decision first.

*Interim control (C-5):* keep off-site copying disabled, or point it at an encrypted volume
under the laboratory's control.

### VF-10 — `xlsx` carries an unfixed advisory

`xlsx` 0.18.5 is the last version on npm; SheetJS publishes fixes only from its own registry.
Closing this means either re-sourcing the dependency from a non-npm registry or replacing it —
and it is used by IQC import/export, staff import, monthly reports and the register exports.
Either route is a supply-chain decision with real regression surface.

*Mitigation in place:* every import path is permission-gated, and the workbooks the system
parses come from the laboratory itself rather than from strangers. CI now blocks on any critical
advisory in shipped code, so this cannot quietly get worse.

### VF-12 — The installer is unsigned

Needs a code-signing certificate the laboratory must purchase. The build is ready for one:
`electron-builder` picks up the certificate from the environment when it exists.

---

## 4. Re-qualification results

Everything was re-executed against the corrected build. Nothing was accepted on the strength of
having been written carefully.

| Qualification | Cases | Passed | Failed | Deviations | Observations |
|---------------|-------|--------|--------|------------|--------------|
| IQ — build, structure, dependencies | 120 | 120 | 0 | 0 | — |
| Unit regression suite (new) | 23 | 23 | 0 | 0 | — |
| Supplier verification scripts | 467 | 467 | 0 | 0 | — |
| OQ — operational controls | 67 | 60 | 0 | 4 | 3 |
| PQ — backup and recovery | 19 | 19 | 0 | 0 | — |
| **Total** | **696** | **689** | **0** | **4** | **3** |

The OQ grew from 61 cases to 67 and the PQ from 16 to 19, because several controls that
previously had nothing to test now do.

### 4.1 Regressions found and fixed during re-qualification

Two things broke, both caught by re-running the suites rather than by inspection:

1. **The session table could not accept a null token.** Storing digests instead of tokens left
   the old `NOT NULL` `token` column in place, and every sign-in returned 500. The table is now
   rebuilt in the migration — old sessions are dropped rather than carried over, which is the
   correct outcome anyway.
2. **A new account could no longer be erased.** `password_history` counted as "laboratory
   history" in the deletion-impact check, so an unused account was blocked from deletion by its
   own password bookkeeping. Credential history is now disposable with the account.

The second was found by `account-check` failing 6 of 37 assertions — a supplier script written
long before this work, catching a regression in it. That is precisely the argument for VF-09 and
VF-22, and it is worth recording that the argument proved itself within an hour of being made.

### 4.2 A defect in the test suite, not the system

The OQ's own inactivity test initially aged *every* live session, expiring the administrator's
too and turning eight later cases into failures that said nothing about the system. It now ages
only the session under test. This is the second harness defect this validation has found in its
own instrumentation — the first was the stray-host bug recorded in document 04 §6 — and both are
recorded rather than quietly corrected, because a validation that hides its own mistakes is not
evidence of anything.

The instrumentation is in the test, not the product: there is deliberately no endpoint that
expires a session early, because a way to reach into sessions from outside is exactly what the
control exists to prevent.

---

## 5. Revised requirements position

| Criticality | Count | Met | Deviation | Observation |
|-------------|-------|-----|-----------|-------------|
| Critical | 47 | 45 | 2 | 0 |
| Major | 24 | 20 | 2 | 2 |
| Minor | 4 | 4 | 0 | 0 |
| **Total** | **75** | **69** | **4** | **2** |

The four requirements still unmet:

| Requirement | Criticality | Finding |
|-------------|-------------|---------|
| URS-DAT-06 — backups encrypted, including off-site copies | Critical | VF-07 |
| URS-LC-05 — third-party components free of known vulnerabilities | Critical | VF-10 |
| URS-DAT-07 — database encrypted at rest | Major | VF-06 |
| URS-LC-04 — distributed installers code-signed | Major | VF-12 |

The two observations are URS-INF-03 (connectivity reporting, recorded as evidence rather than
judged) and URS-DAT-15 (retention enforced by procedure, an accepted design decision).

---

## 5A. Clause-level position after remediation

Every clause the original gap analysis (document 07) recorded as partial or failing, and where
it stands now. Clauses that already conformed are not repeated.

| Standard | Clause | Now | Basis |
|----------|--------|-----|-------|
| ISO 15189 | 4.2 Confidentiality of information | ◐ Partial | Transport closed (VF-01); storage at rest open (VF-06, VF-07) |
| ISO 15189 | 7.6.2 Authorities and responsibilities | ✅ | VF-02, VF-03, VF-24 closed |
| ISO 15189 | 7.6.3 Information system management | ◐ Partial | Tamper-evidence and access protection closed; encryption at rest open (VF-06) |
| ISO 15189 | 7.8 Continuity and emergency preparedness | ◐ Partial | Archive authenticity closed (VF-08); off-site confidentiality open (VF-07) |
| ISO 15189 | 8.4 Control of records | ✅ | VF-05 and VF-17 closed; retention accepted as procedural (VF-25) |
| ISO 17025 | 7.11.2 Validated before introduction | ✅ | This package, with a version that identifies the build (VF-11) |
| ISO 17025 | 7.11.3(a) Protected from unauthorised access | ◐ Partial | VF-01, VF-02, VF-19 closed; VF-06 open |
| ISO 17025 | 7.11.3(b) Safeguarded against tampering and loss | ✅ | Loss proven by PQ; tampering now detectable (VF-05) |
| ISO 17025 | 7.11.3(c)–(d) Supplier spec; maintained integrity | ✅ | VF-21 baseline adopted; VF-09 regression suite in place |
| Part 11 | 11.10(c) Protection of records | ◐ Partial | VF-05 closed; VF-06 open |
| Part 11 | 11.10(d) Limiting system access | ✅ | VF-01, VF-02, VF-19 closed |
| Part 11 | 11.10(e) Secure, time-stamped audit trails | ✅ | VF-03, VF-05, VF-17 closed |
| Part 11 | 11.10(h) Device checks | ◐ Partial | Device and IP captured; no device authorisation enforced |
| Part 11 | 11.10(k) Systems documentation and change control | ✅ | VF-11, VF-21, VF-22 closed |
| Part 11 | 11.70 Signature/record linking | ✅ | VF-13 closed — bound to a hash of what was signed |
| Part 11 | 11.200 Signature components | ✅ | VF-04 closed — the only outright failure in Subpart C |
| Part 11 | 11.300(b), (d) Credentials; transaction safeguards | ✅ | VF-19, VF-02, VF-03 closed |
| Annex 11 | §3 Suppliers and service providers | ✖ | No supplier assessment of the developer recorded — see §6 |
| Annex 11 | §7.1, §17 Data protection; archiving | ◐ Partial | Integrity closed; encryption at rest open (VF-06, VF-07) |
| Annex 11 | §7.2 Backups checked for accuracy and completeness | ✅ | VF-08 closed, demonstrated by refusing a damaged archive |
| Annex 11 | §9 Audit trails | ✅ | VF-03, VF-05 closed |
| Annex 11 | §12.1, §12.3, §12.4 Security and access control | ✅ | VF-01, VF-02, VF-18, VF-03 closed |
| Annex 11 | §14 Electronic signature | ✅ | VF-04, VF-13 closed |
| ISO 27001 | A.5.3, A.5.17, A.5.18, A.8.5 Access and credentials | ✅ | VF-02, VF-19, VF-20, VF-24 closed |
| ISO 27001 | A.8.8 Technical vulnerabilities | ✖ | VF-10 open — one advisory in shipped code, no fix on npm |
| ISO 27001 | A.8.13 Information backup | ◐ Partial | Integrity closed (VF-08); encryption open (VF-07) |
| ISO 27001 | A.8.15 Logging | ✅ | VF-03 closed |
| ISO 27001 | A.8.19, A.8.30 Installation; outsourced development | ✖ | VF-12 open; supplier assessment outstanding |
| ISO 27001 | A.8.23, A.8.25, A.8.26 Origin control; secure development | ✅ | VF-16, VF-09, VF-15, VF-22 closed |
| ISO 27001 | A.8.24 Use of cryptography | ◐ Partial | In transit and for stored tokens closed; at rest open (VF-06, VF-07) |

**Every remaining gap traces to one of the four open findings, plus the supplier assessment.**
Three of the four are about cryptography at rest and the fourth is a certificate. Nothing that
remains is a defect in how the system behaves.

The electronic-signature provisions of Part 11 Subpart C — recorded as *not met* in document 07 —
are now satisfied. Signatures may be described in laboratory procedures as electronic signatures
rather than as system-recorded approvals.

---

## 6. Revised release position

The conditions in document 08 §6 are reduced to those that still apply:

| Condition | Status |
|-----------|--------|
| C-1 · Loopback only until TLS | **Lifted.** TLS is supported. LAN deployment now requires a certificate to be configured — the Host warns loudly if it is not |
| C-2 · No mobile or LAN clients | **Lifted**, subject to C-1's certificate being in place |
| C-3 · Cloud sync and PostgreSQL remain disabled | **Still applies.** Excluded from validation scope; enabling either requires a supplementary risk assessment and OQ |
| C-4 · Full-disk encryption and physical security on the host | **Still applies** (VF-06) |
| C-5 · Off-site copying disabled or pointed at an encrypted volume | **Still applies** (VF-07) |
| C-6 · Manual backup verification | **Lifted.** Verification is automatic and refuses a bad archive |
| C-7 · Signatures described as "system-recorded approvals" | **Lifted.** Re-authentication and content binding are in place; signatures may be described as electronic signatures under Part 11 §11.50 and §11.200 |
| C-8 · Workstation locking enforced procedurally | **Reduced to good practice.** A 30-minute inactivity timeout now backs it |
| C-9 · Named host administrators; independent audit-trail review | **Still applies**, and is now supportable: the Independent Reviewer role exists, and the chain gives the reviewer something to verify |
| C-10 · IQ on the target Windows platform | **Still applies.** Unchanged by this work — see document 04 §2.3 |

**Recommended release position: full release for single-host and LAN operation**, subject to
C-3, C-4, C-5, C-9 and C-10, and to the system owner accepting the residual risk in §3.

This is a change from *conditional* to *full-with-conditions*, and it rests on the four
remaining findings all being owner decisions with documented interim controls rather than
unaddressed defects.
