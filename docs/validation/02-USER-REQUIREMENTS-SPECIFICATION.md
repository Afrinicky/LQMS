# 02 — User Requirements Specification

**System:** SECH_LIMS by Nickland (LQMS) · **Baseline:** commit `dc73f10` · **Requirements:** 75

---

## How to read this

Each requirement is testable and carries a criticality that set how deeply it was tested:

| Criticality | Meaning | Test depth |
|-------------|---------|------------|
| **Critical** | Failure compromises the integrity, attributability or survival of a quality record, or lets an unauthorised person act | Executed test, evidence captured |
| **Major** | Failure degrades assurance or breaches a standard clause without immediately corrupting a record | Executed or witnessed test |
| **Minor** | Failure is an inconvenience or a documentation gap | Inspection or build verification |

The **Clause** column is the obligation the requirement exists to satisfy. The **Result**
column is the outcome recorded in document 05; ✅ met, ⚠️ deviation raised, ℹ️ observation.

---

## A. Configuration and system identification

| ID | Requirement | Criticality | Clause | Result |
|----|-------------|-------------|--------|--------|
| URS-CFG-01 | The system shall report whether it has been initialised, so an uninitialised deployment cannot be mistaken for a working one | Major | Annex 11 §4.3 | ✅ |
| URS-CFG-02 | First-time setup shall establish exactly one administrator account with a facility profile, as an audited event | Critical | ISO 15189 §7.6.2 | ✅ |
| URS-CFG-03 | Setup shall not be re-runnable once complete, so a second unaudited administrator cannot be created | Critical | Part 11 §11.10(d) | ✅ |
| URS-INF-01 | The host shall expose a health probe for monitoring and deployment verification | Minor | ISO 27001 A.8.16 | ✅ |
| URS-INF-02 | The system shall report its product name, version, build mode and database status | Major | Annex 11 §4.3, GAMP 5 | ✅ |
| URS-INF-03 | The system shall report its deployment mode, network exposure and sync state | Major | Annex 11 §4.5 | ℹ️ |

## B. Security and access control

| ID | Requirement | Criticality | Clause | Result |
|----|-------------|-------------|--------|--------|
| URS-SEC-01 | Credentials and quality records shall be encrypted in transit between client and host | Critical | ISO 27001 A.8.24; Annex 11 §12.1; CLSI AUTO11 | ⚠️ VF-01 |
| URS-SEC-02 | Access shall require authentication; invalid credentials shall be refused | Critical | ISO 15189 §7.6.2; Part 11 §11.10(d) | ✅ |
| URS-SEC-03 | Authentication responses shall never return stored password material | Critical | ISO 27001 A.5.17 | ✅ |
| URS-SEC-04 | Every endpoint holding quality records shall refuse unauthenticated and forged tokens | Critical | Part 11 §11.10(d) | ✅ |
| URS-SEC-05 | Repeated failed sign-in attempts shall be throttled, locked out and recorded | Critical | Part 11 §11.300(d); ISO 27001 A.5.17 | ⚠️ VF-02 |
| URS-SEC-06 | Passwords shall meet a defined quality policy (length **and** composition), with reuse and dictionary controls | Major | Part 11 §11.300(b); ISO 27001 A.5.17 | ⚠️ VF-19 |
| URS-SEC-07 | Signing out shall revoke the session token immediately | Major | Annex 11 §12.3 | ✅ |
| URS-SEC-08 | Infrastructure detail (database path, data directory, LAN addresses) shall not be readable without a session | Major | ISO 27001 A.8.7 | ✅ |
| URS-SEC-09 | Sessions shall expire on inactivity as well as on an absolute deadline | Major | Annex 11 §12.3 | ⚠️ VF-18 |
| URS-SEC-10 | An administrator shall be able to create restricted user accounts bound to a role | Critical | ISO 15189 §7.6.2 | ✅ |
| URS-SEC-11 | A restricted user shall be refused user administration, database export and audit-trail access | Critical | Part 11 §11.10(d), (g) | ✅ |
| URS-SEC-12 | The permission map returned to a client shall omit everything the user may not view | Major | ISO 27001 A.8.3 | ✅ |
| URS-SEC-13 | Deactivating an account shall end its live sessions immediately, not merely block the next sign-in | Critical | ISO 27001 A.5.18 | ✅ |
| URS-SEC-14 | File-retrieval endpoints shall refuse path-traversal file names | Critical | ISO 27001 A.8.26 | ✅ |
| URS-SEC-15 | User-supplied input shall not be interpretable as database instructions | Critical | ISO 27001 A.8.28; CLSI AUTO11 | ✅ |
| URS-SEC-16 | The host shall set standard security response headers | Minor | ISO 27001 A.8.26 | ⚠️ VF-15 |
| URS-SEC-17 | Cross-origin access shall be restricted to known clients | Major | ISO 27001 A.8.23 | ⚠️ VF-16 |
| URS-SEC-18 | Session tokens shall be stored so that database or browser-storage disclosure does not yield usable sessions | Major | ISO 27001 A.8.24 | ⚠️ VF-20 |
| URS-SEC-19 | Administrative action and independent review of the audit trail shall be separable | Major | Annex 11 §2; ISO 15189 §7.6.3 | ⚠️ VF-24 |

## C. Audit trail

| ID | Requirement | Criticality | Clause | Result |
|----|-------------|-------------|--------|--------|
| URS-AUD-01 | The system shall maintain a computer-generated, time-stamped audit trail readable by authorised users | Critical | Part 11 §11.10(e); Annex 11 §9; ISO 15189 §7.6.3 | ✅ |
| URS-AUD-02 | Every create, change and deletion shall be attributable to an identified user, with time and origin | Critical | Part 11 §11.10(e); ALCOA+ | ✅ |
| URS-AUD-03 | Audit entries shall record the new value of a change | Critical | Part 11 §11.10(e) | ✅ |
| URS-AUD-04 | Audit entries for modifications shall record the previous value | Critical | Part 11 §11.10(e); Annex 11 §9 | ✅ |
| URS-AUD-05 | Access to the audit trail shall itself be permission-controlled | Major | Annex 11 §12.1 | ✅ |
| URS-AUD-06 | Successful and failed sign-ins shall be recorded as auditable security events | Critical | Annex 11 §12.4; ISO 27001 A.8.15 | ⚠️ VF-03 |
| URS-AUD-07 | Audit timestamps shall be unambiguous as to time zone and traceable to a controlled clock | Major | ALCOA+ (contemporaneous); Annex 11 §9 | ⚠️ VF-17 |
| URS-AUD-08 | The application shall expose no route that edits or deletes audit entries | Critical | Part 11 §11.10(e) | ✅ |
| URS-AUD-09 | Audit records shall be protected against modification at rest and any tampering shall be detectable | Critical | Part 11 §11.10(c),(e); Annex 11 §9 | ⚠️ VF-05 |
| URS-AUD-10 | The audit trail shall survive a restore intact | Critical | ISO 15189 §7.6.4; Annex 11 §7.2 | ✅ |
| URS-AUD-11 | Backup, restore and recovery events shall themselves be audited | Major | Annex 11 §7.2, §16 | ✅ |

## D. Electronic signatures

| ID | Requirement | Criticality | Clause | Result |
|----|-------------|-------------|--------|--------|
| URS-SIG-01 | Regulated actions (approval, verification, acknowledgement) shall be electronically signable | Critical | ISO 15189 §8.3; Part 11 §11.50 | ✅ |
| URS-SIG-02 | Each signature shall record the signer's printed name, the date and time, and the meaning of the signing | Critical | Part 11 §11.50(a) | ✅ |
| URS-SIG-03 | Each signature shall be bound to the specific record it signs | Critical | Part 11 §11.70 | ✅ |
| URS-SIG-04 | Signing shall be impossible without an authenticated identity | Critical | Part 11 §11.200 | ✅ |
| URS-SIG-05 | Signing within a continuous session shall require re-entry of at least one signature component | Critical | Part 11 §11.200(a)(1)(ii); Annex 11 §14 | ⚠️ VF-04 |
| URS-SIG-06 | A signature shall be cryptographically bound to the content signed, so later alteration is detectable | Critical | Part 11 §11.70 | ⚠️ VF-13 |
| URS-SIG-07 | The link between a signature and its audit entry shall be deterministic under concurrency | Major | Part 11 §11.10(e) | ⚠️ VF-14 |

## E. Data integrity, backup and recovery

| ID | Requirement | Criticality | Clause | Result |
|----|-------------|-------------|--------|--------|
| URS-DAT-01 | The system shall provide a data-integrity scan that records its findings as a retained record | Major | ISO 15189 §7.6.3; Annex 11 §6 | ✅ |
| URS-DAT-02 | A complete backup of database, uploads, evidence and configuration shall be producible on demand and on a schedule | Critical | ISO 15189 §7.6.4; Annex 11 §7.2; ISO 22301 | ✅ |
| URS-DAT-03 | Backups shall be registered and listable for review | Major | Annex 11 §7.2 | ✅ |
| URS-DAT-04 | Each backup shall carry a checksum, and its integrity shall be verified before it is restored over live data | Critical | Annex 11 §7.2; ISO 27001 A.8.13 | ⚠️ VF-08 |
| URS-DAT-05 | A restore shall be preceded by an automatic safety snapshot of current state, and abort if that snapshot cannot be written | Critical | ISO 22301 §8.4 | ✅ |
| URS-DAT-06 | Backup packages, including off-site copies, shall be encrypted | Critical | ISO 27001 A.8.24; Act 843 §28 | ⚠️ VF-07 |
| URS-DAT-07 | The database shall be encrypted at rest | Major | ISO 27001 A.8.24; Act 843 §28 | ⚠️ VF-06 |
| URS-DAT-08 | Each backup shall carry a manifest describing what it contains | Major | Annex 11 §7.2 | ✅ |
| URS-DAT-09 | A restore from a registered backup shall complete and return the system to service | Critical | ISO 15189 §7.8; ISO 22301 | ✅ |
| URS-DAT-10 | The pre-restore safety snapshot shall be retained and identifiable | Critical | ISO 22301 §8.4 | ✅ |
| URS-DAT-11 | Users shall be able to authenticate again after a restore | Critical | ISO 22301 §8.4 | ✅ |
| URS-DAT-12 | Every record present when the backup was taken shall be present after the restore | Critical | Annex 11 §7.2 (accuracy and completeness) | ✅ |
| URS-DAT-13 | Records created after the backup shall be absent after the restore, and the restore point shall be knowable | Critical | Annex 11 §7.2 | ✅ |
| URS-DAT-14 | A recovered system shall pass a data-integrity scan | Critical | ISO 15189 §7.6.3 | ✅ |
| URS-DAT-15 | Record retention periods shall be definable, and no record shall be destroyed automatically | Major | ISO 15189 §8.4.3; ISO 17025 §8.4.2 | ℹ️ VF-25 |

## F. Reliability and correctness

| ID | Requirement | Criticality | Clause | Result |
|----|-------------|-------------|--------|--------|
| URS-REL-01 | Malformed input shall be rejected without loss of service | Major | ISO 25010 (reliability); ISO 15189 §7.6.3 | ✅ |
| URS-REL-02 | Error responses shall not disclose internal implementation detail | Minor | ISO 27001 A.8.26 | ✅ |
| URS-REL-03 | The host shall remain available after malformed and hostile input, and after a restore | Critical | ISO 25010 (fault tolerance) | ✅ |

## G. Functional suitability of the quality processes

| ID | Requirement | Criticality | Clause | Result |
|----|-------------|-------------|--------|--------|
| URS-QMS-01 | Quality records shall be creatable, persisted and retrievable across the module set | Critical | ISO 15189 §8.4; ISO 17025 §8.4 | ✅ |
| URS-QMS-02 | Internal quality control shall support controls, lots, runs, rule-based interpretation, corrections with reason, and import/export — with expired lots refused | Critical | ISO 15189 §7.3.7.2; ISO 17025 §7.7 | ✅ |
| URS-QMS-03 | Due, overdue, expiring and excursion conditions shall raise routed notifications that open the record they concern | Major | ISO 15189 §7.6.1; §8.5 | ✅ |
| URS-QMS-04 | Account lifecycle (create, link to staff, reset, require change, deactivate, reactivate, delete-impact) shall be administrable without the administrator locking the laboratory out | Critical | ISO 15189 §7.6.2 | ✅ |
| URS-QMS-05 | Backups shall run to a schedule, retain a defined number of copies, never prune to zero, and copy off site to configured destinations without exposing stored secrets | Critical | ISO 15189 §7.8; ISO 22301 | ✅ |
| URS-QMS-06 | Staff shall reach their own personal records and not other people's; the directory shall not expose national ID or licence detail | Critical | ISO 15189 §4.2 (confidentiality); Act 843 | ✅ |
| URS-QMS-07 | Permission levels shall not confer more than they state: view is a prerequisite for every other action, and an expired technical authorisation shall confer nothing | Critical | ISO 15189 §6.2.4, §7.6.2 | ✅ |

## H. Software lifecycle

| ID | Requirement | Criticality | Clause | Result |
|----|-------------|-------------|--------|--------|
| URS-LC-01 | An automated regression test suite shall exist and be maintained with the code | Critical | ISO 29119; IEC 62304 §5.5–5.7; GAMP 5 | ⚠️ VF-09 |
| URS-LC-02 | Each release shall carry a unique, controlled version identifier traceable to its source | Critical | Annex 11 §4.3; ISO 12207 §6.3.5 | ⚠️ VF-11 |
| URS-LC-03 | Continuous integration shall run the verification checks before any distributable is produced | Major | ISO 12207 §6.4.6; GAMP 5 | ⚠️ VF-22 |
| URS-LC-04 | Distributed installers shall be code-signed | Major | ISO 27001 A.8.19, A.8.30 | ⚠️ VF-12 |
| URS-LC-05 | Third-party components shall be inventoried and free of known exploitable vulnerabilities | Critical | ISO 27001 A.8.8; CLSI AUTO11 | ⚠️ VF-10 |
| URS-LC-06 | The system shall have a controlled specification baseline maintained under change control | Critical | Annex 11 §4, §10; GAMP 5 | ⚠️ VF-21 |
| URS-LC-07 | Verification procedures shall be executable without undocumented prerequisites | Minor | ISO 29119 §5 | ⚠️ VF-23 |

---

## Summary

| Criticality | Count | Met | Deviation | Observation |
|-------------|-------|-----|-----------|-------------|
| Critical | 47 | 35 | 12 | 0 |
| Major | 24 | 12 | 10 | 2 |
| Minor | 4 | 2 | 2 | 0 |
| **Total** | **75** | **49** | **24** | **2** |

Twelve Critical requirements are not met. None of them is a function that fails — each is a
control the standards require that the system has not yet implemented. Their disposition drives
the conditional release in document 08.
