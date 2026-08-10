# 01 — Validation Master Plan

**System:** SECH_LIMS by Nickland (LQMS)
**Version:** 0.1.0, commit `dc73f10`
**Plan date:** 10 August 2026

---

## 1. Purpose

To establish, by documented and reproducible evidence, that SECH_LIMS is fit for its intended
use as the laboratory quality management system of St. Elizabeth Catholic Hospital Laboratory,
and that the electronic records it holds meet the integrity, security and retrievability
requirements placed on them by the standards in §3.

## 2. System description and intended use

| Attribute | Value |
|-----------|-------|
| Product | SECH_LIMS by Nickland |
| Category | Laboratory **Quality** Management System (not a LIS/LIMS for clinical results) |
| Version validated | 0.1.0, commit `dc73f10` |
| Size | ~73,600 lines of TypeScript/TSX across 33 functional modules |
| Architecture | Electron desktop host · React + Vite renderer · Node/Express REST API · SQLite (`better-sqlite3`, WAL) |
| Optional surfaces | LAN clients over HTTP, installable PWA (`/m`), Capacitor Android build, read-only Vercel portal, PostgreSQL cloud-sync driver |
| Default deployment | Single Windows host, API bound to `127.0.0.1`, fully offline, sync disabled |
| Data held | QMS records: documents, personnel, competency, equipment, IQC/EQA, NC/CAPA, complaints, risks, audits, meetings, indicators, POCT, environmental monitoring, information-management records |
| Data **not** held | Patient identity, test requests, clinical results, result verification and dispatch — these remain in LHIMS/Lightwave |

### 2.1 Intended use statement

SECH_LIMS records, routes and evidences the laboratory's **quality** processes. It does not
acquire results from analysers, does not calculate or report patient results, and does not
issue any output on which a clinical decision is directly made. Records referencing laboratory
work use request/specimen references, not patient identifiers.

### 2.2 Regulatory classification

| Question | Determination | Basis |
|----------|---------------|-------|
| Is it a medical device / IVD software? | **No** | It performs none of the functions in IVDR Annex VIII / IMDRF "Software as a Medical Device" criteria: no patient result is generated, interpreted or communicated by it. IEC 62304 and IEC 82304-1 are therefore applied as **good-practice references**, not as compliance obligations. |
| Is it GxP software under 21 CFR Part 11? | **Not by jurisdiction; yes by intent** | The laboratory is not FDA-regulated. Part 11 and EU GMP Annex 11 are nevertheless applied in full as the accepted international benchmark for electronic records and signatures, because the system implements electronic signatures and an audit trail and offers them as evidence to assessors. |
| GAMP 5 software category | **Category 5 — bespoke application** | Written specifically for this laboratory; the whole application is subject to lifecycle and functional verification. |
| Does it process personal data? | **Yes** — staff personal data (names, employee numbers, contact details, health surveillance, competency, disciplinary-adjacent records) | Ghana Data Protection Act, 2012 (Act 843) applies. Patient data is out of scope by design. |

## 3. Standards and regulations applied

| Standard | Edition | Applied as |
|----------|---------|------------|
| ISO 15189 — Medical laboratories: quality and competence | 2022 | **Primary.** §7.6 information management, §7.8 continuity, §8.4 records |
| ISO/IEC 17025 — Testing and calibration laboratories | 2017 | **Primary.** §7.11 control of data and information management |
| ISO 9001 — Quality management systems | 2015 | §7.5 documented information, §8.5.6 change control |
| ISO/IEC 27001 + 27002 — Information security | 2022 | Annex A: access control, cryptography, logging, backup, secure development |
| ISO/IEC 25010 — Systems and software quality models (SQuaRE) | 2023 | Product-quality characteristics used as OQ acceptance dimensions |
| ISO/IEC/IEEE 29119 — Software testing | 2021–22 | Test documentation, design and process structure |
| ISO/IEC/IEEE 12207 — Software life cycle processes | 2017 | Lifecycle process expectations |
| ISO 14971 — Risk management (by analogy) | 2019 | Risk-analysis method in document 03 |
| ISO 22301 — Business continuity | 2019 | Backup and recovery qualification (PQ) |
| ISO 81001-1 — Health software safety, effectiveness and security | 2021 | Good-practice reference |
| GAMP 5 — Risk-based approach to compliant GxP computerised systems | 2nd ed., 2022 | **Validation methodology** |
| 21 CFR Part 11 — Electronic records; electronic signatures | current | Benchmark for audit trail and e-signature |
| EU GMP Annex 11 — Computerised systems | current | Benchmark for computerised system controls |
| CLSI AUTO11 / GP26 | current | IT security of laboratory software; QMS model |
| Ghana Data Protection Act (Act 843) | 2012 | Personal-data safeguards for staff records |

Explicitly **out of scope**: SLIPTA, GAS, accreditation scoring and star ratings. The product
excludes these by design (see `README.md`), and this validation does not assess them.

## 4. Validation approach

A GAMP 5 V-model, scaled by risk:

```
  User Requirements (doc 02) ──────────────────────► Performance Qualification (PQ)
        │                                                        ▲
        ├── Risk Assessment (doc 03) ───────────────────────────┤
        │                                                        │
     Functional / design specification ──────────► Operational Qualification (OQ)
        │   (reverse-engineered from code — see §6)              ▲
        │                                                        │
     Build and installation ─────────────────────► Installation Qualification (IQ)
```

Test depth was set per function by the risk rating in document 03: every function rated **High**
received executed, evidenced testing; **Medium** functions were tested by the supplier's own
verification scripts, re-executed and witnessed here; **Low** functions were covered by build
verification and design review.

### 4.1 Evidence hierarchy

1. **Executed** — the running system was exercised and its response captured verbatim. All OQ
   and PQ results are of this kind.
2. **Witnessed** — the supplier's verification scripts were re-executed on a clean database in
   this environment and their output captured. 587 assertions.
3. **Inspected** — a control was evaluated by reading source. Used only where behaviour cannot
   be provoked from outside (e.g. absence of a hash chain on the audit table). Every such
   conclusion is labelled in the findings register.

## 5. Roles and responsibilities

| Role | Responsibility | Held by |
|------|----------------|---------|
| System owner | Accepts the system into use; owns the residual risk | Laboratory Manager |
| Process owner | Confirms fitness for the quality processes | Quality Manager |
| Validation lead | Plans, executes and reports the validation | This package |
| Supplier / developer | Provides the software, closes findings | Nickland |
| IT / host administrator | Installation, backup, host security | Hospital IT with the laboratory |
| Independent reviewer | Reviews and approves the summary report | Quality Manager (must not be the person who performed the work) |

Approval signatures are collected on document 08.

## 6. The requirements baseline

Validation is executed against **[NSD-SRS-001](../specifications/NSD-SRS-001-Software-Requirements-Specification.md)**,
the controlled Software Requirements Specification for SECH_LIMS, approved before execution
begins. It is structured to ISO/IEC/IEEE 29148:2018 and specifies 76 requirements, each
singular and verifiable, each traced to at least one clause of the standards in §3, and each
carrying a criticality, a verification method and an acceptance criterion.

Traceability runs in both directions: every test case traces to a requirement, and every
requirement traces to at least one test case. A test tracing to no requirement, and a
requirement covered by no test, are each treated as a defect in the specification and are
resolved before the validation report is approved.

NSD-SRS-001 records in its own document control how the baseline was established for a product
that already existed — derived from the adopted standards, the laboratory's intended use, the
product documentation and the implemented behaviour, then reviewed and approved. That provenance
belongs in the specification rather than here, but it bears on how this package should be read:
**the specification is the authority for what the software is required to do; this package is
the record of whether it does it.**

The specification also states, deliberately, where it sets no requirement — numeric performance
and capacity targets, and usability and accessibility. Neither was agreed with the laboratory,
so neither is a validation acceptance criterion and neither is verified. Their absence is a
decision on the record, not an omission.

From this baseline onward the sequence is the ordinary one: no change is made to SECH_LIMS
until the requirement it satisfies has been written into NSD-SRS-001 and approved
(document 09).

## 7. Acceptance criteria

The system is recommended for release when:

1. **AC-1** — Every requirement classified *Critical* in document 02 has a passing test result.
2. **AC-2** — No test case reports FAIL (a specified behaviour not working).
3. **AC-3** — Every deviation is risk-rated, has an owner and a corrective action, and any
   deviation rated **High** is either closed or covered by an accepted, documented interim
   procedural control.
4. **AC-4** — The backup and recovery cycle is demonstrated end to end on the target
   configuration.
5. **AC-5** — The residual risk is stated and accepted in writing by the system owner.

**Status against acceptance criteria:** AC-1 partially met, AC-2 met, AC-3 met with interim
controls, AC-4 met, AC-5 pending signature. The consequence is a **conditional release**
restricted to a defined configuration — see document 08.

## 8. Deliverables

Documents 00–09 of this package, plus the executable protocols
(`scripts/validation/oq-suite.mjs`, `scripts/validation/pq-recovery.mjs`) and their evidence
files. The package is version-controlled in the repository with the code it validates, so the
validated state and the validated build cannot drift apart.
