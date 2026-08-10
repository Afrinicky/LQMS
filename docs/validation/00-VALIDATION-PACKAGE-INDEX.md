# SECH_LIMS — Computerised System Validation Package

**System:** SECH_LIMS by Nickland — Laboratory Quality Management System (LQMS)
**Software version validated:** 1.0.0
**Requirements baseline:** [NSD-SRS-001](../specifications/NSD-SRS-001-Software-Requirements-Specification.md) v1.0 — 76 requirements
**Validation performed:** 10 August 2026
**Validation approach:** GAMP 5 (2nd Edition) risk-based V-model, Category 5 (bespoke application)
**Status:** **Released for single-host and LAN operation, subject to five conditions** — see
[NSD-VR-001, the validation report](NSD-VR-001-Validation-Report.docx)

---

## What this package is

This is the validation of the **software**, not of the laboratory's quality system. It asks
one question, in the form an assessor asks it:

> Can this laboratory demonstrate that SECH_LIMS does what it is relied upon to do, that the
> quality records it holds are attributable, legible, contemporaneous, original and accurate,
> and that they will still be there — and still be trustworthy — tomorrow?

Everything here was produced by exercising the running system against an approved requirements
baseline. No result in this package is asserted from reading code alone: where a conclusion
rests on design inspection rather than execution, it says so.

## Documents

| # | Document | What it establishes |
|---|----------|---------------------|
| — | **[NSD-SRS-001 — Software Requirements Specification](../specifications/NSD-SRS-001-Software-Requirements-Specification.md)** | **The controlled requirements baseline.** 76 requirements to ISO/IEC/IEEE 29148:2018, each with a criticality, verification method and acceptance criterion. Everything below is judged against it |
| 01 | [Validation Master Plan](01-VALIDATION-MASTER-PLAN.md) | Scope, standards, approach, roles, acceptance criteria |
| 02 | [Requirements baseline](02-USER-REQUIREMENTS-SPECIFICATION.md) | Superseded — points to NSD-SRS-001 |
| 03 | [Risk Assessment](03-RISK-ASSESSMENT.md) | Function-level risk analysis driving test depth |
| 04 | [IQ / OQ / PQ Protocols](04-IQ-OQ-PQ-PROTOCOLS.md) | The protocols, and how to re-execute them |
| 05 | [Traceability Matrix](05-TRACEABILITY-MATRIX.md) | Requirement → design → test → result, both directions |
| 06 | [Deviations and Findings Register](06-DEVIATIONS-AND-FINDINGS.md) | Every finding raised on this product, risk-rated, with its disposition |
| 07 | [Standards Gap Analysis](07-STANDARDS-GAP-ANALYSIS.md) | Clause-by-clause conformity against 14 standards |
| 08 | [Validation Summary Report](08-VALIDATION-SUMMARY-REPORT.md) | Historical record of the conclusion reached at version 0.1.0 |
| 09 | [Periodic Review & Change Control](09-PERIODIC-REVIEW-AND-CHANGE-CONTROL.md) | Keeping the system in a validated state |
| 10 | [Remediation & Re-qualification](10-REMEDIATION-AND-REQUALIFICATION.md) | Historical record of the work between 0.1.0 and 1.0.0 |

The detailed validation report is issued as a Word document in the Nicklandsales controlled
document set: **[NSD-VR-001 — Validation Report](NSD-VR-001-Validation-Report.docx)**. It
records the validation of version 1.0.0 against NSD-SRS-001 and nothing else — it is not a
change log. Regenerate it with `npm run validate:report`.

## Executable protocols

Two of the protocols are scripts, so that re-qualification after a change is a command rather
than a fortnight:

```bash
npm test                  # 23 unit regression tests (~4 seconds)
npm run validate:oq       # 67 operational qualification test cases
npm run validate:pq       # 19 backup and disaster-recovery test cases
npm run validate          # both qualification suites, in sequence
```

All of these, plus the twelve supplier verification scripts, now run in CI on every push
(`.github/workflows/verify.yml`), and both packaging workflows wait for them.

Each starts its own host on an isolated scratch data directory, so neither can touch the
laboratory's live database. Both write machine-readable evidence into `evidence/`.

## Evidence

| File | Contents |
|------|----------|
| `evidence/iq-build-evidence.log` | Typecheck, unit tests, structure check, production build, dependency audit |
| `evidence/supplier-check-scripts.log` | 587 assertions from the supplier's own verification scripts |
| `evidence/oq-results.json` | 67 OQ test cases with observed behaviour |
| `evidence/pq-recovery-results.json` | 19 PQ backup/restore test cases |

## Result at a glance

Version 1.0.0, against NSD-SRS-001:

| Qualification | Cases | Passed | Failed | Deviations | Observations |
|---------------|-------|--------|--------|------------|--------------|
| IQ (build & installation) | 120 | 120 | 0 | 0 | — |
| Unit regression suite | 23 | 23 | 0 | 0 | — |
| Supplier verification scripts | 467 | 467 | 0 | 0 | — |
| OQ (operational) | 67 | 60 | 0 | 4 | 3 |
| PQ (recovery) | 19 | 19 | 0 | 0 | — |
| **Total** | **696** | **689** | **0** | **4** | **3** |

**No test case failed.** Seventy of the seventy-six specified requirements are met, four carry
a deviation, and two were not verified because the baseline deliberately states no requirement
for them (performance targets and usability).

The four open findings are decisions for the system owner — encryption keys the laboratory must
be willing to custody, a dependency whose fix is not published on the public registry, and a
code-signing certificate somebody has to buy — not defects anyone can code away. Each carries a
documented interim control, and each is set out in
[NSD-VR-001 §5](NSD-VR-001-Validation-Report.docx).

Documents 06, 08 and 10 are retained as the historical record of validation activity on earlier
versions. They are not the current position; NSD-VR-001 is.
