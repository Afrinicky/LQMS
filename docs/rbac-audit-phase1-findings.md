# RBAC audit — Phase 1 findings

A second, deeper audit of role-based access, prompted by a walkthrough of the
system with Technician and other lower-rank accounts.

The August pass fixed the *permission engine* — `view` became a prerequisite
for every action, technical authorizations stopped granting approval, and the
client stopped drawing modules a user cannot open. Those fixes hold. This pass
looked one level further in, at **what sits inside a module once you are
allowed through the door**, and found the engine is sound but the model it is
enforcing is far too coarse.

Everything below is evidenced against a live server, not read off the code.
Reproduce with `node scripts/rbac-probe.mjs`.

---

## The headline

**A Technician can read every colleague's complete HR file.** Their staff
record, their signed declarations, their performance appraisals, their
competency assessments. Confirmed allowed by the API, not merely visible in the
UI.

**A POCT Officer can edit any staff record in the laboratory** — name,
registration number, licence, appointment. Confirmed allowed.

These are not UI slips. The server permits them, because of the root cause
below.

---

## Root cause: one permission per module, for modules that contain dozens of things

Permissions are stored as `(module_key, action)` — 32 modules × 7 actions. But
a module is not one thing. Personnel Management alone has fifteen tabs:

> Dashboard · Master Personnel Register · Add Staff · Staff Documents ·
> Orientation & Induction · Declarations · Training Events · Competency
> Assessments · Performance Appraisals · Technical Authorizations · Duty Roster ·
> Unit Reassignments · Bench Schedules · My Profile · Reports

`personnel: view` is a single switch across all fifteen. There is no way to
express "may see the training calendar but not appraisals", or the thing the
laboratory actually needs — **"may edit their own record, may not open
anyone else's"**. The model has no concept of record ownership at all.

The same shape repeats everywhere. Process Management has 22 tabs behind one
key; Customer Focus 12; Information Management 12; Equipment 13.

Four consequences follow, and every finding in this report is one of them:

| # | Cause | Effect |
|---|-------|--------|
| **C1** | One permission per module | Sensitive tabs inherit access granted for routine ones |
| **C2** | No ownership scoping | "View personnel" means *everyone's* personnel data |
| **C3** | Seeded defaults grant `create` broadly | Lower ranks can add equipment, suppliers, reference intervals |
| **C4** | Tabs and workflow buttons are not permission-aware | Registers and approval controls render for everyone with `view` |

---

## Confirmed, by role

`v`=view `c`=create `e`=edit `x`=void/archive `X`=export `p`=print `A`=approve.
Blank = no access to the module at all.

| Module | Technician | Biomedical Sci. | Quality User | Data Officer | POCT Officer |
|---|---|---|---|---|---|
| personnel | `v` | `v` | — | — | **`vcep`** |
| documents | `vp` | `vp` | — | — | `vp` |
| equipment | `vcp` | `vcp` | `vcep` | — | `vcep` |
| supplier_inventory | `vcp` | `vcp` | `vcep` | `vp` | `vp` |
| process_management | `vc` | `vcp` | — | `vcep` | — |
| customer_focus | `v` | `vcp` | — | — | — |
| organisation | `vp` | `vp` | `vp` | `vp` | `vp` |
| information_management | `v` | `vc` | — | `vceXp` | — |
| continual_improvement | `v` | `vcp` | — | — | — |
| facilities_safety | `vcp` | `vcp` | `vcep` | — | — |
| verification_validation | `vcp` | `vcp` | `vcep` | — | — |
| records_reports | `v` | `vcp` | — | — | — |
| notifications | `v` | `vcp` | `v` | `v` | `v` |

### Live probe results

Only non-blocked results shown. A `400` means **the permission check passed**
and only the dummy payload was rejected — those are grants, not blocks.

**Technician**
- ALLOWED `GET /staff/:id` — another person's full record
- ALLOWED `GET /personnel/declarations` — everyone's
- ALLOWED `GET /personnel/appraisals` — everyone's
- ALLOWED `GET /personnel/competency` — everyone's
- ALLOWED `POST /supplier-inventory/suppliers` — add a supplier
- ALLOWED `POST /process-management/reference-intervals`
- ALLOWED `GET /organisation/registrations` — registrations & licences
- ALLOWED `GET /information-management/security-incidents`
- ALLOWED `GET /customer-focus/stakeholders`
- ALLOWED `GET /notifications/rules`
- 400 (permitted) `POST /equipment`, `POST /supplier-inventory/items`, `POST /verification-validation`

**POCT Officer** — all of the above, plus:
- ALLOWED **`PUT /staff/:id`** — edit another person's staff record

---

## Findings by module

### Personnel Management — severity: critical

- **C2** Every tab reads the whole laboratory. Declarations, appraisals,
  competency assessments and technical authorizations are HR records; a
  Technician sees all of them for all staff.
- **C4** "Add Staff" and the edit form render for anyone with `view`. The
  server refuses the save (Technician has no `edit`), so the reported
  "technician can edit another person" is *blocked at the API* — but the form
  is drawn, the data is pre-filled, and the refusal only arrives on submit.
  For a POCT Officer the save succeeds.
- **C3** `POCT Officer` is seeded `personnel: view create edit print`. No
  justification: their job is point-of-care oversight.
- Missing entirely: a self-service scope. A member of staff has no way to
  maintain their own contact details without being handed the whole register.

### Documents & Records — severity: critical

- **C4** The lifecycle buttons — *Submit for review*, *Approve & issue*,
  *Distribute to all staff for attestation* — are gated only on document
  status, never on permission (`DocumentControlPage.tsx:1923-1925`). A
  Technician holding `documents: view print` sees the approve button on every
  reviewed document. The API refuses the click, but the control is presented as
  theirs to use.
- **C1** Central Archive, Master List and Laboratory Profile are all inside
  `documents: view`.

### Equipment — severity: high

- **C3** `create` is seeded to Technician and Biomedical Scientist, so both can
  add equipment to the asset register, open verification & validation studies,
  add training & competency entries and attach equipment files.
- The intent expressed for training is *"they can only view or add their own
  trainings"* — the model cannot express this today.

### Supplier & Inventory — severity: high

- **C3** Technician and Biomedical Scientist can create suppliers (confirmed
  live) and stock items. Item Register, Batches/Lots, Stock Movements,
  Suppliers, Storage Inspections and Barcode Labels are one permission.

### Process Management — severity: high

- **C1/C3** 22 tabs behind one key. Test Directory, Acceptance Criteria,
  Reference Intervals, Critical Result Rules, Referral Labs and Contingency
  Plan are laboratory-defining configuration; `create` is granted to Technician
  and Data Officer. Creating a reference interval is confirmed allowed for a
  Technician.

### Customer Focus — severity: medium-high

- **C1** Advisory Services, Stakeholders, Service Agreements, Survey Responses,
  Communication Log, Imports and Reports all sit behind `customer_focus: view`,
  which a Technician holds. Stakeholders confirmed readable.
- The stated intent — *log a communication, but not read the register* — is a
  create-without-view shape the model cannot express.

### Organisation & Leadership — severity: medium-high

- **C1** Every role is seeded `organisation: view print`, which now includes
  Budgetary Projection, Quality & Technical Records Review, and Registrations &
  Licences. Registrations confirmed readable by every role probed.
- Meetings needs partial access (attend/see minutes, not manage) — not
  expressible.

*Note: this one is partly self-inflicted. The August pass granted every role
`organisation: view print` to fix roles being locked out of a module the
sidebar offered them. That was right for the organogram and wrong for the
budget and licence tabs.*

### Information Management — severity: medium-high

- **C1** Information Assets, Systems, Access Reviews, Security Incidents, Data
  Corrections, Change Requests, Software Releases, System Validations, Downtime
  and Reviews are one key. Security Incidents confirmed readable by a
  Technician. Biomedical Scientist additionally holds `create`.

### Continual Improvement / Facilities & Safety / Notifications — severity: medium

- **CI** — Biomedical Scientist can create improvement projects and updates.
- **Facilities & Safety** — Immunisation & Exposure is occupational-health data
  sitting behind the same key as incident reporting, which lower ranks
  legitimately need. Assets, Devices and Settings likewise.
- **Notifications** — Notification Rules confirmed readable by every role.
  Rules, Preferences and Generate Alerts are administrative; the inbox, tasks
  and calendar are not.

---

## The permission matrix itself

The Settings → People & Access matrix has seven tabs (*Authorization Matrix,
Role Permissions, Position Permissions, User Overrides, Technical
Authorizations, Section Scope, Audit History*) and presents permissions as a
grid of **224 individual checkboxes per role** — 32 modules × 7 actions — with
no grouping, no search and no notion of a sensible default. Granting a cohort a
coherent set of rights means finding and ticking dozens of boxes without
mis-clicking, and there is no way to see at a glance what a role can actually
do.

This is why the seeded defaults have drifted: they are effectively unreviewable.

---

## Remediation plan

**Phase 2 — a permission model that can express the requirement.**
Introduce *features*: named sub-areas of a module (`personnel.register`,
`personnel.appraisals`, `documents.workflow`, …) mapped to the tabs and
operations they govern. Permissions attach to features. Module access becomes
the union of a user's features, so existing route guards keep working while
sensitive areas get their own key.

Add **ownership scope** for personal records, so `own` / `section` / `all` is
expressible and "edit your own details, never open anyone else's" becomes a
setting rather than a wish.

**Phase 3 — a matrix an administrator can actually read.**
Replace the 224-checkbox grid with one **access level** per feature —
*None · View · Contribute · Manage · Full* — grouped by module, searchable,
with the same control used for a whole cohort (role) or a single person. Levels
expand to action sets underneath, so nothing is lost.

**Phase 4 — enforce it.**
Feature keys on the server routes named above; a permission-aware tab bar so
tabs a user has no feature for are not drawn (there are currently 16 separate
copies of the tab-bar helper, none permission-aware); permission gates on the
document lifecycle buttons.

**Phase 5 — re-seed and verify.**
Rebuild role defaults against the feature catalogue on a least-privilege basis,
and extend the automated probe to assert every finding in this report is closed
for every seeded role.
