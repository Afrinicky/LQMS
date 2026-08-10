# SECH_LIMS — Computerised System Validation Package

**System:** SECH_LIMS by Nickland — Laboratory Quality Management System (LQMS)
**Version validated:** 1.0.0 — originally validated at 0.1.0 (commit `dc73f10`), remediated and re-qualified
**Validation performed:** 10 August 2026
**Validation approach:** GAMP 5 (2nd Edition) risk-based V-model, Category 5 (bespoke application)
**Status:** **Full release, subject to five conditions** — see
[08 — Validation Summary Report](08-VALIDATION-SUMMARY-REPORT.md) and
[10 — Remediation and Re-qualification](10-REMEDIATION-AND-REQUALIFICATION.md)

---

## What this package is

This is the validation of the **software**, not of the laboratory's quality system. It asks
one question, in the form an assessor asks it:

> Can this laboratory demonstrate that SECH_LIMS does what it is relied upon to do, that the
> quality records it holds are attributable, legible, contemporaneous, original and accurate,
> and that they will still be there — and still be trustworthy — tomorrow?

Everything here was produced by exercising the running system at commit `dc73f10`. No result
in this package is asserted from reading code alone: where a conclusion rests on design
inspection rather than execution, it says so.

## Documents

| # | Document | What it establishes |
|---|----------|---------------------|
| 01 | [Validation Master Plan](01-VALIDATION-MASTER-PLAN.md) | Scope, standards, approach, roles, acceptance criteria |
| 02 | [User Requirements Specification](02-USER-REQUIREMENTS-SPECIFICATION.md) | 75 testable requirements traced to standard clauses |
| 03 | [Risk Assessment](03-RISK-ASSESSMENT.md) | Function-level risk analysis driving test depth |
| 04 | [IQ / OQ / PQ Protocols](04-IQ-OQ-PQ-PROTOCOLS.md) | The protocols, and how to re-execute them |
| 05 | [Traceability Matrix](05-TRACEABILITY-MATRIX.md) | Requirement → design → test → result, both directions |
| 06 | [Deviations and Findings Register](06-DEVIATIONS-AND-FINDINGS.md) | 25 findings, risk-rated, with corrective actions |
| 07 | [Standards Gap Analysis](07-STANDARDS-GAP-ANALYSIS.md) | Clause-by-clause conformity against 14 standards |
| 08 | [Validation Summary Report](08-VALIDATION-SUMMARY-REPORT.md) | **The report.** Conclusion and release decision |
| 09 | [Periodic Review & Change Control](09-PERIODIC-REVIEW-AND-CHANGE-CONTROL.md) | Keeping the system in a validated state |
| 10 | [Remediation & Re-qualification](10-REMEDIATION-AND-REQUALIFICATION.md) | **What was fixed, what was not, and the re-run results** |

A single consolidated report covering the whole exercise — validation, remediation and
re-qualification — is available as a Word document:
**[SECH_LIMS-Validation-Report.docx](SECH_LIMS-Validation-Report.docx)**. Regenerate it with
`npm run validate:report`.

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

**As originally validated (0.1.0):** 664 outcomes, 640 passed, 0 failed, 20 deviations,
4 observations — and 25 findings raised.

**After remediation (1.0.0):**

| Qualification | Cases | Passed | Failed | Deviations | Observations |
|---------------|-------|--------|--------|------------|--------------|
| IQ (build & installation) | 120 | 120 | 0 | 0 | — |
| Unit regression suite | 23 | 23 | 0 | 0 | — |
| Supplier verification scripts | 467 | 467 | 0 | 0 | — |
| OQ (operational) | 67 | 60 | 0 | 4 | 3 |
| PQ (recovery) | 19 | 19 | 0 | 0 | — |
| **Total** | **696** | **689** | **0** | **4** | **3** |

Nothing the system claims to do was found not to work, before or after. **21 of the 25 findings
are closed.** The four that remain are decisions for the system owner — encryption keys the
laboratory must be willing to custody, a dependency whose fix is not on npm, and a code-signing
certificate somebody has to buy — not defects anyone can code away. Each carries a documented
interim control. [Document 10](10-REMEDIATION-AND-REQUALIFICATION.md) has the detail.
