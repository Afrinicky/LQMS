# SECH_LIMS — Computerised System Validation Package

**System:** SECH_LIMS by Nickland — Laboratory Quality Management System (LQMS)
**Version validated:** 0.1.0 (commit `dc73f10`)
**Validation performed:** 10 August 2026
**Validation approach:** GAMP 5 (2nd Edition) risk-based V-model, Category 5 (bespoke application)
**Status:** **Conditional release** — see [08 — Validation Summary Report](08-VALIDATION-SUMMARY-REPORT.md)

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

## Executable protocols

Two of the protocols are scripts, so that re-qualification after a change is a command rather
than a fortnight:

```bash
npm run validate:oq       # 61 operational qualification test cases
npm run validate:pq       # 16 backup and disaster-recovery test cases
npm run validate          # both, in sequence
```

Each starts its own host on an isolated scratch data directory, so neither can touch the
laboratory's live database. Both write machine-readable evidence into `evidence/`.

## Evidence

| File | Contents |
|------|----------|
| `evidence/iq-build-evidence.log` | Typecheck, structure check, production build, dependency audit |
| `evidence/supplier-check-scripts.log` | 587 assertions from the supplier's own verification scripts |
| `evidence/oq-results.json` | 61 OQ test cases with observed behaviour |
| `evidence/pq-recovery-results.json` | 16 PQ backup/restore test cases |

## Result at a glance

| Qualification | Cases | Passed | Failed | Deviations | Observations |
|---------------|-------|--------|--------|------------|--------------|
| IQ (build & installation) | 120 | 120 | 0 | — | — |
| Supplier verification scripts | 467 | 467 | 0 | — | — |
| OQ (operational) | 61 | 38 | 0 | 19 | 4 |
| PQ (recovery) | 16 | 15 | 0 | 1 | — |
| **Total** | **664** | **640** | **0** | **20** | **4** |

Nothing the system claims to do was found not to work. Every deviation is a control the
standards require that the system does not yet implement — the difference matters, and
[document 06](06-DEVIATIONS-AND-FINDINGS.md) keeps it.
