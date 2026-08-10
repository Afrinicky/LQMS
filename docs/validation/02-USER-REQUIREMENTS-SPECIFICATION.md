# 02 — Requirements baseline

> **This document has been superseded.** The controlled requirements baseline for SECH_LIMS is
> **[NSD-SRS-001 — Software Requirements Specification](../specifications/NSD-SRS-001-Software-Requirements-Specification.md)**,
> issued in the Nicklandsales controlled document set and structured to ISO/IEC/IEEE 29148:2018.
>
> Go there for the requirements themselves. This page remains only to keep the numbering of the
> validation package stable and to explain the relationship between the two documents.

---

## Where the requirements live now

| | |
|---|---|
| **Document** | NSD-SRS-001, Software Requirements Specification |
| **Version** | 1.0 |
| **Requirements** | 76 |
| **Structure** | ISO/IEC/IEEE 29148:2018 |
| **Identifier scheme** | `URS-<GROUP>-<nn>` — unchanged, so every reference in the traceability matrix and the qualification protocols still resolves |

Each requirement in NSD-SRS-001 carries more than this document ever did: a rationale, the
standard clause it derives from, a criticality, the method by which it is to be verified, and
the acceptance criterion that decides whether it passes. That is what makes it a specification
rather than a list.

## What changed, and why

This page was originally a requirements *register* — a table of what the software was expected
to do, assembled during validation. A register is not a baseline. A baseline is approved before
verification, is the authority against which verification is judged, and cannot be altered
except through change control.

NSD-SRS-001 is that baseline. It is approved by the supplier's technical lead, the system owner
and the process owner; it governs change through its own §12.3; and it states explicitly the
areas in which it sets no requirement, so that silence is never mistaken for an oversight.

## Requirement groups

Unchanged from the original register, so existing references remain valid:

| Group | Subject | Count |
|-------|---------|-------|
| `CFG` | Configuration and controlled initialisation | 3 |
| `INF` | System identification and reporting | 3 |
| `SEC` | Security and access control | 19 |
| `AUD` | Audit trail | 11 |
| `SIG` | Electronic signatures | 8 |
| `DAT` | Data integrity, backup and recovery | 15 |
| `REL` | Reliability and correctness | 3 |
| `QMS` | Functional suitability of the quality processes | 7 |
| `LC` | Software lifecycle | 7 |
| | **Total** | **76** |

One requirement is new relative to the original register: **URS-SIG-08**, requiring that
acknowledgement of a record be recorded distinguishably from approval of it. It was written into
the baseline because the distinction exists in the software and matters to anyone reading the
evidence — "read this" and "approved this" are not the same act, and a specification that did
not say so would have left the difference undocumented.
