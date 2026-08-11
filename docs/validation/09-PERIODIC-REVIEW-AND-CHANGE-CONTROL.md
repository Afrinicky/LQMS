# 09 — Periodic Review and Change Control

How SECH_LIMS stays in a validated state. Required by EU GMP Annex 11 §10 and §11, ISO 15189:2022
§7.6.3, ISO/IEC 17025:2017 §7.11.2, ISO 9001:2015 §8.5.6 and GAMP 5 §8.

---

## 1. The principle

A validation is a statement about one build at one moment. Commit `dc73f10` is validated. The
next commit is not, until something says so.

This document defines the smallest set of rules that keeps that statement true without making
every change unaffordable.

## 2. Change classification

Every change is classified **before** it is made. The classification decides what evidence is
required.

| Class | Definition | Evidence required | Approval |
|-------|------------|-------------------|----------|
| **Major** | Touches authentication, authorisation, the audit trail, electronic signatures, backup/restore, the database schema, or enables a previously disabled surface (LAN, PWA, cloud sync, PostgreSQL) | Risk assessment update (doc 03) · full `npm run validate` · targeted OQ cases for the change · updated traceability (doc 05) · updated summary report | System owner **and** Quality Manager |
| **Minor** | New or changed functionality inside an existing module, not touching anything in the Major list | `npm run validate` · supplier check scripts for the affected module · updated URS entry | Quality Manager |
| **Cosmetic** | Wording, layout, colour, non-functional refactor with no behaviour change | `npm run typecheck` · `npm run validate:oq` | Process owner |
| **Emergency** | Fix required to restore service or prevent record loss | Apply, then produce Minor-class evidence **within five working days**; record as a deviation until closed | Retrospective, both owners |

**Enabling any excluded surface is Major by definition.** Cloud synchronisation, the PostgreSQL
driver, the remote portal, LAN/hybrid mode, the mobile PWA and the Android build were excluded
from this validation (document 03 §4). Each requires a supplementary risk assessment and OQ
before use — and LAN, PWA and remote are additionally blocked by conditions C-1 and C-2 in
document 08 until VF-01 and VF-02 are closed.

## 3. Rules that apply to every change

1. **Specify before building.** Document 02 is the baseline. A change that adds or alters a
   requirement updates document 02 in the same commit. This closes VF-21 going forward.
2. **Bump the version.** Every release increments `package.json` and embeds the commit hash in
   `/system/about` (VF-11). A build whose version cannot be tied to a commit cannot be
   validated, and must not be deployed.
3. **Run the validation suite.** `npm run validate` must be green before merge. Once VF-22 is
   closed this is enforced by CI rather than by memory.
4. **Record it where the laboratory can see it.** The System Change Control and Software Release
   modules already exist in the Information Management module. Use them — a change record that
   lives only in a git history is not available to an assessor.

## 4. Periodic review

**Frequency:** every six months, or on closure of the P1 findings, whichever is sooner. Recorded
as a Management Review input.

The review answers seven questions:

| # | Question | Source |
|---|----------|--------|
| 1 | Is the deployed version still the validated version? | `/system/about` vs this package |
| 2 | Does the validation suite still pass? | `npm run validate` |
| 3 | What changed since the last review, and was each change classified and evidenced? | System Change Control module |
| 4 | Have any P1 or P2 findings been closed? Are the interim controls (C-1 to C-10) still being followed? | Document 06; laboratory procedures |
| 5 | Have new vulnerabilities appeared in dependencies? | `npm audit` |
| 6 | What incidents, downtime or data-integrity issues occurred? | Downtime records, security incidents, integrity scans |
| 7 | Do the standards still say what they said? | ISO 15189, 17025, 27001 revision status |

**Output:** a signed review record stating whether the system remains in a validated state, and
either confirming the release conditions or revising them.

### 4.1 Triggers for an unscheduled review

- Any P1 finding closed, or any new P1-class issue discovered
- A security incident affecting the host or its data
- A restore performed in anger
- A change to the deployment configuration — network exposure, host, database driver
- A new edition of ISO 15189 or ISO/IEC 17025

## 5. Re-validation

A **full re-validation** (documents 02 to 08 re-executed) is required when:

- The database engine changes (SQLite → PostgreSQL)
- Cloud synchronisation or the remote portal is enabled
- The authentication or permission model is redesigned
- Three years have elapsed since the last full validation
- Cumulative Minor changes have made the traceability matrix unreliable — judged at periodic
  review

Anything less is covered by the change classes in §2.

## 6. Records to retain

| Record | Retention | Where |
|--------|-----------|-------|
| This validation package and its evidence | Life of the system + 5 years | Repository under version control, and in the laboratory's document control system |
| Change records and classifications | Life of the system + 5 years | System Change Control module |
| Software release records | Life of the system + 5 years | Software Release Records module |
| Periodic review records | 5 years | Management Review module |
| Validation suite output after each release | Until superseded by two later releases | `docs/validation/evidence/` |

Retention is enforced procedurally — the system deliberately performs no automatic destruction
(VF-25).

## 7. Responsibilities

| Who | What |
|-----|------|
| Quality Manager | Owns this procedure; chairs the periodic review; approves Minor changes |
| Laboratory Manager (system owner) | Approves Major changes; accepts residual risk; owns conditions C-1 to C-10 |
| Supplier (Nickland) | Classifies changes before making them; produces the evidence; keeps documents 02 and 05 current |
| IT / host administrator | Host security, backup verification, applies the interim controls |
| Independent reviewer | Reviews validation and periodic-review records; must not be the person who performed the work |
