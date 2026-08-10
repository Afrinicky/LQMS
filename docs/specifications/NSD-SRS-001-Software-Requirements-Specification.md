# NSD-SRS-001 — Software Requirements Specification

## SECH_LIMS by Nickland — Laboratory Quality Management System

---

## Document control

| Field | Value |
|-------|-------|
| **Document number** | NSD-SRS-001 |
| **Document set** | Nicklandsales Controlled Documents |
| **Title** | Software Requirements Specification — SECH_LIMS Laboratory Quality Management System |
| **Version** | 1.0 |
| **Status** | Approved baseline |
| **Applies to product version** | SECH_LIMS 1.0.0 and later, until superseded |
| **Author / owner** | Nickland (supplier) |
| **Approvers** | Supplier technical lead · Laboratory Manager (system owner) · Quality Manager (process owner) |
| **Effective date** | On signature (§13) |
| **Review cycle** | Every 12 months, or on any Major change (§12) |
| **Retention** | Life of the system + 5 years |
| **Supersedes** | Nothing. This is the first controlled requirements baseline for this product |
| **Related documents** | NSD-VMP-001 Validation Master Plan · NSD-RA-001 Risk Assessment · NSD-VR-001 Validation Report · NSD-PRC-001 Periodic Review and Change Control |

### Revision history

| Version | Date | Author | Change |
|---------|------|--------|--------|
| 1.0 | 10 August 2026 | Nickland | First issue. Establishes the controlled requirements baseline for SECH_LIMS. |

### Basis on which this baseline was established

This specification is the first controlled requirements baseline for SECH_LIMS. The product
existed before it. The requirements below were therefore derived — deliberately and in a
documented way — from four sources, then formally reviewed and approved as the controlling
specification against which the software is verified and validated:

1. the obligations the standards in §4 place on a laboratory information system;
2. the laboratory's intended use of the product, as stated in §5;
3. the product documentation issued with the software; and
4. the behaviour the software implements, inspected function by function.

This route is provided for in GAMP 5 (2nd Edition) for a Category 5 system already in
existence, and in ISO/IEC/IEEE 12207:2017 §6.4.2 where requirements are established for an
existing implementation. It is stated here rather than left to inference, because a
specification's authority rests on the reader knowing how it came to say what it says.

**From this baseline onward the sequence is the ordinary one.** No change may be made to
SECH_LIMS until the requirement it satisfies has been written into this document and approved.
Verification is performed against this specification; the validation report records the result.

---

## 1  Purpose

This document specifies what SECH_LIMS shall do, what properties it shall have, and how each
requirement is to be verified. It is the baseline for:

- design and implementation by the supplier;
- verification and validation of the software;
- change control over the life of the product; and
- the laboratory's demonstration, to an assessor, that its information system was specified
  before it was relied upon.

Nothing in the validation of SECH_LIMS is tested that is not required here, and no requirement
here is left unverified. That relationship is the reason the document exists.

## 2  Scope

### 2.1  Product identification

| Attribute | Value |
|-----------|-------|
| Product | SECH_LIMS by Nickland |
| Class | Laboratory **Quality** Management System |
| Baseline version | 1.0.0 |
| Deploying laboratory | St. Elizabeth Catholic Hospital Laboratory |
| Architecture | Electron desktop host · React + Vite renderer · Node/Express REST API · SQLite (`better-sqlite3`, WAL journal) |
| Scale | ~73,600 lines of TypeScript across 33 functional modules |
| Optional surfaces | LAN clients over HTTP/HTTPS · installable PWA · Capacitor Android build · read-only remote portal · PostgreSQL cloud-sync driver |

### 2.2  What the product does

SECH_LIMS records, routes and evidences the laboratory's **quality** processes: document
control, personnel and competency, equipment and calibration, internal quality control,
external quality assessment, nonconformity and CAPA, complaints, risk, internal audit,
management review, quality indicators, facilities and safety, environmental monitoring,
point-of-care testing oversight, process management, information management, and the records,
reports and evidence that hold them together.

### 2.3  What the product does not do

SECH_LIMS does not acquire results from analysers, does not calculate, interpret or report
patient results, and issues no output on which a clinical decision is directly made. Patient
registration, test requests, clinical result entry, verification and dispatch remain with
LHIMS/Lightwave. Records referencing laboratory work use request and specimen references, not
patient identifiers.

The product also excludes, by design: official accreditation scoring, SLIPTA and Ghana
Accreditation Service grading, and star ratings. Internal audit marking is supported as a
laboratory-defined internal assessment tool and is never presented as an accreditation score.

### 2.4  Exclusions from this baseline

The following are **not specified here and are not validated**. Enabling any of them requires a
supplementary specification, risk assessment and qualification before use:

| Excluded | Reason |
|----------|--------|
| Cloud synchronisation and the PostgreSQL driver | Disabled by default; no laboratory requirement has been raised for them |
| Read-only remote portal | Depends on cloud synchronisation |
| Capacitor Android package | The mobile surface is specified here only as the browser-delivered PWA |

## 3  Definitions and conventions

### 3.1  Requirement syntax

Every requirement uses **shall** and exactly one testable obligation. Requirements are written
so that a reader can determine, without judgement, whether the software meets them.

### 3.2  Identification

`URS-<GROUP>-<nn>`, where the group is one of:

| Group | Subject |
|-------|---------|
| `CFG` | Configuration and controlled initialisation |
| `INF` | System identification and reporting |
| `SEC` | Security and access control |
| `AUD` | Audit trail |
| `SIG` | Electronic signatures |
| `DAT` | Data integrity, backup and recovery |
| `REL` | Reliability and correctness |
| `QMS` | Functional suitability of the quality processes |
| `LC` | Software lifecycle |

Identifiers are permanent. A withdrawn requirement keeps its number and is marked withdrawn;
numbers are never reused.

### 3.3  Criticality

Assigned from the risk assessment (NSD-RA-001) and determining the depth of verification.

| Criticality | Definition | Verification depth |
|-------------|------------|--------------------|
| **Critical** | Failure compromises the integrity, attributability or survival of a quality record, or allows an unauthorised person to act | Executed test with retained evidence |
| **Major** | Failure degrades assurance or breaches a standard clause without immediately corrupting a record | Executed or witnessed test |
| **Minor** | Failure is an inconvenience or a documentation gap | Inspection or analysis |

### 3.4  Verification method

Per ISO/IEC/IEEE 29148:2018 §5.2.8:

| Code | Method | Meaning here |
|------|--------|--------------|
| **T** | Test | The running system is exercised and its response captured verbatim |
| **D** | Demonstration | The system is operated through a scenario and the outcome observed |
| **I** | Inspection | Source, configuration or a stored artefact is examined |
| **A** | Analysis | The conclusion is reasoned from design or from other verified results |

### 3.5  Abbreviations

CAPA — corrective and preventive action · EQA — external quality assessment · IQC — internal
quality control · LQMS — laboratory quality management system · PWA — progressive web
application · RBAC — role-based access control · TLS — transport layer security.

---

## 4  Regulatory and standards basis

### 4.1  Classification determinations

These determinations set which obligations apply and are therefore part of the baseline.

| Question | Determination | Basis |
|----------|---------------|-------|
| Is the product medical device / IVD software? | **No** | It performs none of the functions in IVDR Annex VIII or the IMDRF *Software as a Medical Device* criteria: no patient result is generated, interpreted or communicated by it. IEC 62304 and IEC 82304-1 are applied as good-practice references, not as compliance obligations |
| Is the product GxP software under 21 CFR Part 11? | **Not by jurisdiction; adopted by intent** | The laboratory is not FDA-regulated. Part 11 and EU GMP Annex 11 are adopted in full as the accepted international benchmark, because the product implements an audit trail and electronic signatures and offers them to assessors as evidence |
| GAMP 5 software category | **Category 5 — bespoke application** | Written specifically for this laboratory; the whole application is subject to lifecycle and functional verification |
| Does the product process personal data? | **Yes — staff personal data** | Names, employee numbers, contact details, occupational-health and competency records. The Ghana Data Protection Act, 2012 (Act 843) applies. Patient data is excluded by design |

### 4.2  Standards adopted

| Standard | Edition | Adopted for |
|----------|---------|-------------|
| ISO 15189 — Medical laboratories: quality and competence | 2022 | §7.6 control of data and information management, §7.8 continuity, §8.4 control of records, and the quality processes the product supports |
| ISO/IEC 17025 — Testing and calibration laboratories | 2017 | §7.11 control of data and information management, §8.4 records |
| ISO 9001 — Quality management systems | 2015 | §7.5 documented information, §8.5.6 control of changes |
| ISO/IEC 27001 + 27002 — Information security | 2022 | Annex A: access control, cryptography, logging, backup, secure development |
| ISO/IEC 25010 — Systems and software quality models | 2023 | Product-quality characteristics, used as the acceptance dimensions in §11 |
| **ISO/IEC/IEEE 29148 — Requirements engineering** | 2018 | **The structure and quality rules of this document** |
| ISO/IEC/IEEE 12207 — Software life cycle processes | 2017 | Lifecycle process expectations, §6.4.2 requirements definition |
| ISO/IEC/IEEE 29119 — Software testing | 2021–22 | Verification approach in §12 |
| ISO 14971 — Risk management | 2019 | Applied by analogy in NSD-RA-001; drives criticality here |
| ISO 22301 — Business continuity | 2019 | Backup and recovery requirements (DAT group) |
| ISO 81001-1 — Health software safety, effectiveness and security | 2021 | Good-practice reference |
| GAMP 5 — Compliant GxP computerised systems | 2nd ed., 2022 | Category determination and lifecycle approach |
| 21 CFR Part 11 — Electronic records and signatures | current | AUD and SIG groups |
| EU GMP Annex 11 — Computerised systems | current | Computerised-system controls throughout |
| CLSI AUTO11 / GP26 | current | IT security of laboratory software; QMS model |
| Ghana Data Protection Act (Act 843) | 2012 | §28 security safeguards for staff personal data |

### 4.3  Requirement quality rules applied

Per ISO/IEC/IEEE 29148:2018 §5.2.4–5.2.6, every requirement in §7–§11 is written to be
necessary, singular, unambiguous, complete, feasible, verifiable, and traceable to at least one
clause in §4.2. Requirements that could not be made verifiable were reworded until they were,
or removed.

---

## 5  Intended use, stakeholders and environment

### 5.1  Intended use statement

SECH_LIMS shall be used as the record of the laboratory's quality management system: the place
where quality documents, personnel competence, equipment status, quality control,
nonconformities, audits, reviews and their evidence are created, routed, approved and retained,
and from which the laboratory demonstrates conformity to an assessor.

It shall not be used to produce, interpret or issue a patient result.

### 5.2  Stakeholders

| Stakeholder | Interest |
|-------------|----------|
| Laboratory Manager (system owner) | Fitness for purpose; residual risk; release into use |
| Quality Manager (process owner) | That the QMS processes are correctly supported and evidenced |
| Section heads and bench staff | Daily use; that the system records their work without obstructing it |
| Independent reviewer | That the audit trail and records can be reviewed by somebody who cannot alter them |
| Hospital IT | Host security, network exposure, backup, availability |
| Supplier (Nickland) | Specification, implementation, verification, maintenance |
| External assessor | That the laboratory can demonstrate control of its information |

### 5.3  User classes

Access is granted by role, position and technical authorisation. The product shall support at
least the following classes, each with distinct rights: System Administrator, Laboratory
Manager, Quality Manager, Quality Team Member, Section Head, Biomedical Scientist, Technician,
Blood Bank Unit Head, Safety Manager, Data Officer, POCT Officer, Quality User, and an
Independent Reviewer who may read the audit trail and administer nothing.

### 5.4  Operating environment

| Item | Baseline |
|------|----------|
| Host | Single Windows PC, laboratory-controlled, physically secured |
| Runtime | Node.js 20 or later; Electron 32.x shell |
| Store | SQLite in WAL journal mode, foreign keys enforced |
| Network | Loopback by default. LAN operation permitted with TLS configured |
| Clients | The host application; LAN browsers; the installable PWA at `/m` |
| Data location | Outside the installation directory, so reinstalling does not touch laboratory data |

### 5.5  Constraints

- The product shall operate fully offline. No function required for daily quality work may
  depend on internet access.
- The product shall not require a database server; a single-host SQLite deployment shall be
  sufficient.
- The product shall not duplicate or replace LHIMS/Lightwave functions.
- Records shall never be destroyed automatically (see URS-DAT-15).

### 5.6  Assumptions and dependencies

- The laboratory provides physical and operating-system security for the host.
- The laboratory holds and applies procedures for account issue and revocation, workstation
  locking, backup custody and audit-trail review.
- Time on the host is set correctly and is under the laboratory's control.

---

## 6  Overall description

SECH_LIMS presents 33 modules over a single REST API and one permission decision point. A
user's rights are resolved from role defaults, position assignments, technical authorisations
and per-user overrides, in that order, with module enablement and a view-is-prerequisite rule
applied last. Records created in one module may be linked to records in another, and every
change is written to a single audit trail.

The specific requirements follow. Each is stated once, in the group where it belongs.

---

## 7  Requirements — configuration and identification

| ID | Requirement | Crit. | Source | VM | Acceptance criterion |
|----|-------------|-------|--------|----|----------------------|
| URS-CFG-01 | The system shall report whether it has been initialised, so an uninitialised deployment cannot be mistaken for a working one | Major | Annex 11 §4.3 | T | A status endpoint returns setup state and administrator existence, correct before and after initialisation |
| URS-CFG-02 | First-time setup shall establish exactly one administrator account together with the facility profile, and shall record the event in the audit trail | Critical | ISO 15189 §7.6.2 | T | Initialisation succeeds once and writes an audit entry naming the facility and the account |
| URS-CFG-03 | Setup shall not be re-runnable once complete | Critical | Part 11 §11.10(d) | T | A second initialisation attempt is refused with an explanatory error and creates no account |
| URS-INF-01 | The host shall expose an unauthenticated health probe carrying no configuration detail | Minor | ISO 27001 A.8.16 | T | The probe returns a success indicator and product name only |
| URS-INF-02 | The system shall report its product name, version, source commit, build provenance and database status to an authorised user | Major | Annex 11 §4.3; GAMP 5 | T | All five fields present; version matches the released package; commit identifies the build |
| URS-INF-03 | The system shall report its deployment mode, network exposure and synchronisation state | Major | Annex 11 §4.5 | T | Mode, LAN exposure, database driver and sync state are returned |

## 8  Requirements — security and access control

| ID | Requirement | Crit. | Source | VM | Acceptance criterion |
|----|-------------|-------|--------|----|----------------------|
| URS-SEC-01 | Credentials and quality records shall be capable of transmission over an encrypted channel, and the system shall warn explicitly when bound to a network address without one | Critical | ISO 27001 A.8.24; Annex 11 §12.1; CLSI AUTO11 | T, I | The host serves HTTPS when a certificate is configured; a network bind without one produces a startup warning naming the exposure |
| URS-SEC-02 | Access shall require authentication; invalid credentials shall be refused without disclosing which element was wrong | Critical | ISO 15189 §7.6.2; Part 11 §11.10(d) | T | Valid credentials issue a session; invalid credentials are refused with a single non-specific message |
| URS-SEC-03 | Authentication responses shall never return stored password material | Critical | ISO 27001 A.5.17 | T | No hash or salt appears in any authentication response |
| URS-SEC-04 | Every endpoint holding quality records shall refuse unauthenticated and forged tokens | Critical | Part 11 §11.10(d) | T | Requests without a token, and with a fabricated token, are refused |
| URS-SEC-05 | Repeated failed sign-in attempts shall lock the account for a defined period, and the lock shall hold against the correct password | Critical | Part 11 §11.300(d); ISO 27001 A.5.17 | T | The account locks within the stated number of attempts; a subsequent correct password is refused while locked |
| URS-SEC-06 | Passwords shall meet a single defined quality policy applied identically wherever a password is set | Major | Part 11 §11.300(b); ISO 27001 A.5.17 | T | Minimum length, common-password, self-reference, repetition and reuse rules are enforced at account creation, administrator reset, self-service change and first-administrator setup |
| URS-SEC-07 | Signing out shall revoke the session token immediately | Major | Annex 11 §12.3 | T | A request using the token after sign-out is refused |
| URS-SEC-08 | Infrastructure detail — database path, data directory, network addresses — shall not be readable without a session | Major | ISO 27001 A.8.7 | T | Unauthenticated requests to system and connectivity endpoints are refused |
| URS-SEC-09 | Sessions shall expire on inactivity as well as on an absolute deadline | Major | Annex 11 §12.3 | T | A session unused for the stated idle period is refused thereafter |
| URS-SEC-10 | An administrator shall be able to create restricted user accounts bound to a role | Critical | ISO 15189 §7.6.2 | T | The account is created and can authenticate with the rights of its role |
| URS-SEC-11 | A restricted user shall be refused user administration, whole-database export and audit-trail access | Critical | Part 11 §11.10(d), (g) | T | Each is refused with an authorisation error |
| URS-SEC-12 | The permission map returned to a client shall omit everything the user may not view | Major | ISO 27001 A.8.3 | T | Modules the user cannot view are absent from the map |
| URS-SEC-13 | Deactivating an account shall end its live sessions immediately | Critical | ISO 27001 A.5.18 | T | A session valid before deactivation is refused after it |
| URS-SEC-14 | File-retrieval endpoints shall refuse path-traversal file names | Critical | ISO 27001 A.8.26 | T | A traversal name is refused and no file outside the intended folder is returned |
| URS-SEC-15 | User-supplied input shall not be interpretable as database instructions | Critical | ISO 27001 A.8.28; CLSI AUTO11 | T, I | Metacharacters in credentials do not bypass authentication; all statements are parameterised |
| URS-SEC-16 | The host shall set standard security response headers on every response | Minor | ISO 27001 A.8.26 | T | Content-Type options, frame options, referrer policy and a content-security policy are present |
| URS-SEC-17 | Cross-origin access shall be restricted to an allow-list of known clients | Major | ISO 27001 A.8.23 | T | An arbitrary origin receives no cross-origin grant; a configured origin does |
| URS-SEC-18 | Session tokens shall be stored so that disclosure of the database does not yield usable sessions | Major | ISO 27001 A.8.24 | I, T | The stored value is a digest, not the bearer token |
| URS-SEC-19 | The system shall permit audit-trail review by a role holding no administrative rights over what it reviews | Major | Annex 11 §2; ISO 15189 §7.6.3 | T | A reviewer role reads the trail and is refused user administration |

## 9  Requirements — audit trail and electronic signatures

### 9.1  Audit trail

| ID | Requirement | Crit. | Source | VM | Acceptance criterion |
|----|-------------|-------|--------|----|----------------------|
| URS-AUD-01 | The system shall maintain a computer-generated, time-stamped audit trail readable by authorised users | Critical | Part 11 §11.10(e); Annex 11 §9; ISO 15189 §7.6.3 | T | The trail is retrievable and contains entries for actions performed |
| URS-AUD-02 | Every create, change and deletion shall be attributable to an identified user, with time and origin | Critical | Part 11 §11.10(e); ALCOA+ | T | Entries carry actor, timestamp and source address |
| URS-AUD-03 | Audit entries shall record the new value of a change | Critical | Part 11 §11.10(e) | T | The new value is present and legible |
| URS-AUD-04 | Audit entries for modifications shall record the previous value | Critical | Part 11 §11.10(e); Annex 11 §9 | T | Modification entries carry the prior value |
| URS-AUD-05 | Access to the audit trail shall itself be permission-controlled | Major | Annex 11 §12.1 | T | A user without the right is refused |
| URS-AUD-06 | Successful and failed sign-ins, blocked attempts, lockouts and sign-outs shall be recorded as auditable security events | Critical | Annex 11 §12.4; ISO 27001 A.8.15 | T | Each event type appears in the trail with username, address and time |
| URS-AUD-07 | Audit timestamps shall be unambiguous as to time zone | Major | ALCOA+; Annex 11 §9 | T | Timestamps carry an explicit zone designator |
| URS-AUD-08 | The application shall expose no route that edits or deletes audit entries | Critical | Part 11 §11.10(e) | T, I | No such route exists; attempts are not found |
| URS-AUD-09 | Alteration or deletion of an audit entry shall be detectable | Critical | Part 11 §11.10(c),(e); Annex 11 §9 | T | A verification function reports an entry altered outside the application, and reports a deletion as a break in sequence |
| URS-AUD-10 | The audit trail shall survive a restore intact | Critical | ISO 15189 §7.6.4; Annex 11 §7.2 | T | Entries present at backup time are present after restore |
| URS-AUD-11 | Backup, restore, refused restore and recovery events shall themselves be audited | Major | Annex 11 §7.2, §16 | T | Each appears in the trail |

### 9.2  Electronic signatures

| ID | Requirement | Crit. | Source | VM | Acceptance criterion |
|----|-------------|-------|--------|----|----------------------|
| URS-SIG-01 | Regulated actions — approval, verification, release, acknowledgement — shall be electronically signable | Critical | ISO 15189 §8.3; Part 11 §11.50 | T | A signature is recorded against the action |
| URS-SIG-02 | Each signature shall record the signer's printed name, the date and time, and the meaning of the signing | Critical | Part 11 §11.50(a) | T | All three are stored and retrievable |
| URS-SIG-03 | Each signature shall be bound to the specific record it signs | Critical | Part 11 §11.70 | T | Signatures are retrievable by module, record type and record identifier |
| URS-SIG-04 | Signing shall be impossible without an authenticated identity | Critical | Part 11 §11.200 | T | An unauthenticated signing attempt is refused |
| URS-SIG-05 | Signing within a continuous session shall require re-entry of at least one signature component | Critical | Part 11 §11.200(a)(1)(ii); Annex 11 §14 | T | A signing without the component is refused; with a wrong component it is refused and the refusal is audited |
| URS-SIG-06 | A signature shall be bound to the content signed, so that later alteration of the record is detectable | Critical | Part 11 §11.70 | T | A record edited after signing is flagged wherever the signature is displayed |
| URS-SIG-07 | The link between a signature and its audit entry shall be deterministic under concurrent activity | Major | Part 11 §11.10(e) | T, I | The signature carries the identifier of its own audit entry |
| URS-SIG-08 | Acknowledgement of a record shall be recorded distinguishably from approval of it | Major | Part 11 §11.50; Annex 11 §14 | T, I | Acknowledgements are stored with an indicator separating them from signatures requiring re-authentication |

## 10  Requirements — data integrity, backup, recovery and reliability

### 10.1  Data integrity, backup and recovery

| ID | Requirement | Crit. | Source | VM | Acceptance criterion |
|----|-------------|-------|--------|----|----------------------|
| URS-DAT-01 | The system shall provide a data-integrity scan that records its findings as a retained record | Major | ISO 15189 §7.6.3; Annex 11 §6 | T | The scan runs, reports records checked and issues found, and is retained |
| URS-DAT-02 | A complete backup of database, uploads, evidence and configuration shall be producible on demand and on a schedule | Critical | ISO 15189 §7.6.4; Annex 11 §7.2; ISO 22301 | T | A package is produced by both routes and contains all four |
| URS-DAT-03 | Backups shall be registered and listable for review | Major | Annex 11 §7.2 | T | Each package appears in a register with its size and time |
| URS-DAT-04 | Each backup shall carry a checksum, verified before the archive is restored over live data, and a mismatch shall refuse the restore | Critical | Annex 11 §7.2; ISO 27001 A.8.13 | T | A digest is recorded; an altered archive is refused and live data is unchanged |
| URS-DAT-05 | A restore shall be preceded by an automatic safety snapshot of current state, and shall abort if that snapshot cannot be written | Critical | ISO 22301 §8.4 | T | The snapshot is written and identifiable before any live data is replaced |
| URS-DAT-06 | Backup packages, including copies sent off site, shall be encrypted | Critical | ISO 27001 A.8.24; Act 843 §28 | I | Package contents are not readable without the laboratory's key |
| URS-DAT-07 | The database shall be encrypted at rest | Major | ISO 27001 A.8.24; Act 843 §28 | I | The database file is not readable without the laboratory's key |
| URS-DAT-08 | Each backup shall carry a manifest describing its contents | Major | Annex 11 §7.2 | T | The manifest lists the included components |
| URS-DAT-09 | A restore from a registered backup shall complete and return the system to service | Critical | ISO 15189 §7.8; ISO 22301 | T | The restore completes and the host continues serving |
| URS-DAT-10 | The pre-restore safety snapshot shall be retained and exempt from retention pruning | Critical | ISO 22301 §8.4 | T | The snapshot survives a pruning cycle |
| URS-DAT-11 | Users shall be able to authenticate again after a restore | Critical | ISO 22301 §8.4 | T | Sign-in succeeds against the restored database |
| URS-DAT-12 | Every record present when the backup was taken shall be present after the restore | Critical | Annex 11 §7.2 | T | All pre-backup records are retrievable afterwards |
| URS-DAT-13 | Records created after the backup shall be absent after the restore, so the restore point is knowable | Critical | Annex 11 §7.2 | T | Post-backup records are absent |
| URS-DAT-14 | A recovered system shall pass a data-integrity scan | Critical | ISO 15189 §7.6.3 | T | The scan reports no issues |
| URS-DAT-15 | Record retention periods shall be definable, and **no record shall be destroyed automatically** | Major | ISO 15189 §8.4.3; ISO 17025 §8.4.2 | I | Retention rules and reviews exist; no automatic destruction path exists |

### 10.2  Reliability and correctness

| ID | Requirement | Crit. | Source | VM | Acceptance criterion |
|----|-------------|-------|--------|----|----------------------|
| URS-REL-01 | Malformed input shall be rejected without loss of service | Major | ISO 25010 reliability; ISO 15189 §7.6.3 | T | A malformed request returns an error and the host continues serving |
| URS-REL-02 | Error responses shall not disclose internal implementation detail | Minor | ISO 27001 A.8.26 | T | No stack trace, file path or dependency name appears in an error body |
| URS-REL-03 | The host shall remain available after malformed and hostile input, and after a restore | Critical | ISO 25010 fault tolerance | T | The health probe succeeds after each |

## 11  Requirements — quality processes and software lifecycle

### 11.1  Functional suitability of the quality processes

| ID | Requirement | Crit. | Source | VM | Acceptance criterion |
|----|-------------|-------|--------|----|----------------------|
| URS-QMS-01 | Quality records shall be creatable, persisted and retrievable across the module set | Critical | ISO 15189 §8.4; ISO 17025 §8.4 | T | Records created in a module are retrievable unchanged |
| URS-QMS-02 | Internal quality control shall support control materials, lots, runs, rule-based interpretation, corrections that retain what they replaced, and import/export — and shall refuse a run against an expired lot | Critical | ISO 15189 §7.3.7.2; ISO 17025 §7.7 | T | Each behaviour demonstrated; an expired lot is refused |
| URS-QMS-03 | Due, overdue, expiring and excursion conditions shall raise notifications routed by section and role, each opening the record it concerns | Major | ISO 15189 §7.6.1, §8.5 | T | Notifications are raised, routed and carry an actionable link |
| URS-QMS-04 | Account lifecycle — create, link to staff, reset, require change, deactivate, reactivate, assess deletion impact — shall be administrable without the administrator being able to lock the laboratory out | Critical | ISO 15189 §7.6.2 | T | Each operation succeeds; self-removal of the last administrator is refused |
| URS-QMS-05 | Backups shall run to a schedule, retain a defined number of copies, never prune to zero, and copy to configured off-site destinations without exposing stored credentials | Critical | ISO 15189 §7.8; ISO 22301 | T | Schedule, missed-run catch-up, retention floor and destination handling all demonstrated; secrets never returned |
| URS-QMS-06 | Staff shall reach their own personal records and not those of others, and the staff directory shall not expose national identity or licence detail | Critical | ISO 15189 §4.2; Act 843 | T | Own record reachable; another's refused; directory fields restricted |
| URS-QMS-07 | A permission level shall confer no more than it states: view shall be a prerequisite for every other action, and an expired or inactive technical authorisation shall confer nothing | Critical | ISO 15189 §6.2.4, §7.6.2 | T | Print and export are refused without view; an expired authorisation grants nothing |

### 11.2  Software lifecycle

| ID | Requirement | Crit. | Source | VM | Acceptance criterion |
|----|-------------|-------|--------|----|----------------------|
| URS-LC-01 | An automated regression test suite shall exist and be maintained with the code | Critical | ISO 29119; GAMP 5; IEC 62304 §5.5–5.7 (ref.) | I, T | A test runner and suites are present and pass on demand |
| URS-LC-02 | Each release shall carry a unique, controlled version identifier traceable to its source | Critical | Annex 11 §4.3; ISO 12207 §6.3.5 | T, I | The version is unique per release and the build reports its source commit |
| URS-LC-03 | Continuous integration shall run the verification suite before any distributable is produced | Major | ISO 12207 §6.4.6; GAMP 5 | I | Packaging workflows depend on a verification workflow that runs typecheck, tests, qualification and check scripts |
| URS-LC-04 | Distributed installers shall be code-signed | Major | ISO 27001 A.8.19, A.8.30 | I | The installer carries a valid signature |
| URS-LC-05 | Third-party components shall be inventoried, and shipped components shall be free of known exploitable vulnerabilities | Critical | ISO 27001 A.8.8; CLSI AUTO11 | A, I | A dependency audit of shipped code reports no unmitigated advisory; the audit runs on every build |
| URS-LC-06 | The product shall have a controlled requirements baseline maintained under change control | Critical | Annex 11 §4, §10; GAMP 5 | I | This document, approved and under the change control of §12 |
| URS-LC-07 | Verification procedures shall be executable without undocumented prerequisites | Minor | ISO 29119 §5 | I, D | Each procedure either self-provisions or its prerequisites are documented and enforced |

### 11.3  Quality attributes (ISO/IEC 25010)

These are the acceptance dimensions against which the product as a whole is judged.

| Characteristic | Requirement of the product | Verification |
|----------------|---------------------------|--------------|
| Functional suitability | The specified functions shall be present, correct and appropriate to the intended use | Every requirement in §7–§11.2 verified |
| Reliability | The product shall remain available under malformed input and shall recover completely from loss of the host | URS-REL-01…03, URS-DAT-09…14 |
| Security | Confidentiality, integrity, authenticity, accountability and non-repudiation shall be maintained to the level the SEC, AUD and SIG groups specify | SEC, AUD, SIG groups |
| Maintainability | The product shall be modifiable with confidence, supported by an automated regression suite and a single permission decision point | URS-LC-01, design inspection |
| Flexibility | Deployment shall be configurable by environment variable without code change | §5.4, URS-INF-03 |
| Performance efficiency | The product shall support the laboratory's daily workload on a single host. **No numeric performance target is specified in this baseline**, and performance is therefore not a validation acceptance criterion | Not verified — see §12.4 |
| Interaction capability | **Not specified in this baseline.** No usability or accessibility requirement has been agreed | Not verified — see §12.4 |
| Safety | Not applicable. The product produces no patient result | Determination in §4.1 |

---

## 12  Verification, traceability and change control

### 12.1  Verification approach

Verification is planned in NSD-VMP-001 and executed to protocols structured to ISO/IEC/IEEE
29119-3. Every requirement in this document shall be verified by the method stated in its row,
and its result recorded in the traceability matrix and the validation report.

| Qualification | Establishes |
|---------------|-------------|
| Installation qualification | That the software builds and installs as specified in the stated environment |
| Operational qualification | That each specified control behaves as required, including under boundary and hostile conditions |
| Performance qualification | That the product performs its intended use in the laboratory's own scenarios, including loss and recovery of the host |

### 12.2  Traceability

Bidirectional traceability shall be maintained: from each requirement to its implementation and
its verifying test, and from each test back to the requirement it verifies. **A test that
traces to no requirement, and a requirement covered by no test, are each a defect in this
specification** and shall be resolved before the validation report is approved.

### 12.3  Change control of this document

| Change to the product | Requirement of this document |
|-----------------------|------------------------------|
| **Major** — touches authentication, authorisation, the audit trail, electronic signatures, backup and restore, the database schema, or enables an excluded surface (§2.4) | Amend this specification and obtain approval **before** implementation. Re-verify affected requirements and any requirement they interact with |
| **Minor** — new or changed functionality inside an existing module | Amend the affected requirement and obtain Quality Manager approval before implementation |
| **Cosmetic** — wording, layout, non-functional refactor | No amendment required; record the change |
| **Emergency** — restores service or prevents record loss | Implement, then amend this specification within five working days and record the interval as a deviation |

Each amendment increments the document version, is entered in the revision history, and is
approved by the signatories in §13. A superseded version is retained; it is never overwritten.

### 12.4  Requirements deliberately not stated

Stated here so that their absence is a decision on the record rather than an omission:

| Area | Position |
|------|----------|
| Numeric performance and capacity targets | No target has been agreed with the laboratory. Performance is therefore not a validation acceptance criterion. To be established at the first periodic review |
| Usability and accessibility | No requirement agreed. Not verified |
| Cloud synchronisation, remote portal, native Android package | Excluded from this baseline (§2.4) |
| Supplier assessment of Nickland | Required by Annex 11 §3. It is a laboratory obligation, not a property of the software, and is therefore recorded in the validation package rather than specified here |

---

## 13  Approval

This specification takes effect on signature. Until it is signed it is a draft and shall not be
used as the basis of verification.

| Role | Name | Signature | Date |
|------|------|-----------|------|
| Author — Supplier technical lead (Nickland) | | | |
| System owner — Laboratory Manager | | | |
| Process owner — Quality Manager | | | |

**By signing, the approvers accept this document as the controlled requirements baseline for
SECH_LIMS, and accept that no change shall be made to the product until the requirement it
satisfies has been written here and approved.**

---

### Annex A — Requirement count by group and criticality

| Group | Requirements | Critical | Major | Minor |
|-------|-------------|----------|-------|-------|
| CFG — configuration | 3 | 2 | 1 | 0 |
| INF — identification | 3 | 0 | 2 | 1 |
| SEC — security and access | 19 | 10 | 8 | 1 |
| AUD — audit trail | 11 | 8 | 3 | 0 |
| SIG — electronic signatures | 8 | 6 | 2 | 0 |
| DAT — data, backup, recovery | 15 | 10 | 5 | 0 |
| REL — reliability | 3 | 1 | 1 | 1 |
| QMS — quality processes | 7 | 6 | 1 | 0 |
| LC — software lifecycle | 7 | 4 | 2 | 1 |
| **Total** | **76** | **47** | **25** | **4** |
