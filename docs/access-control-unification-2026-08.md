# Access control — unification and deep audit

**Date:** August 2026
**Scope:** every module, every access-control surface, both sides of the wire.
**Verification:** `npm run audit:access` (static, 23 checks) and
`npm run audit:access:live` (live, 21 checks against a running host), plus the
pre-existing `rbac:check`, `rbac:matrix` and `rbac:selfservice` suites.

> Part 1 (§1–§6) is the unification. **Part 2 (§7–§10), at the foot of this
> document, is the second pass** after the laboratory tested it: the module-union
> leak that let a Biomedical Scientist open Settings and approve duty rosters,
> the notification bug that left bench inboxes empty, and the access preset.

---

## 1. What was wrong

Two complaints were raised, and they turned out to be the same fault seen from
two ends.

> *Users are not able to see what they are supposed to see, and are allowed to
> see what they are not supposed to even touch. Sometimes there is a "No
> permission" note, but the page still opens and Import/Export can be clicked.*

> *There are three sub-tabs — Role, Position and Individual. The role and
> position may contradict. There is also an "Advanced Matrix".*

Access was assembled from **four independent sources that could all disagree**:

| Layer | Table | Could it deny? |
|---|---|---|
| Role default | `role_permissions` | only if written as an explicit `0` |
| Position grant | `position_permissions` | **no — additive only** |
| Technical authorization | `technical_authorizations` | **no — additive only** |
| Individual override | `user_permission_overrides` | yes |

Because the middle two could only ever **add**, a role set to *No access* was
silently re-opened by a position grant or by a competency record. No screen
could state what a person could actually do, and four screens could each change
it: the Role tab, the Position tab, the Individual tab, the Advanced Matrix —
and a fifth, the raw permission grid buried in *Register New Staff*.

That is the "allowed to see what they should not" half. The "shown a control
that is then refused" half came from guards and UI disagreeing, catalogued in
§3.

---

## 2. The new model — one decision, then one exception

There are now exactly **two layers**, and they are ordered.

```
1. ACCESS PROFILE   The single cohort decision. Every user resolves to
                    exactly ONE profile, so two cohorts cannot contradict.
                       ↓
2. INDIVIDUAL       One person, superseding their profile — to grant or to
                    withdraw. Always wins. Nothing overrules it.
```

Then four invariants, applied in this order by
`server/services/permissionResolver.ts`:

- **`view` is the floor.** No action is possible without the right to view the
  area. Print, export, edit and approve all collapse without it.
- **A decision on a module cascades to every feature inside it**, allow *and*
  deny. "No access to Documents" now means no access to any part of Documents.
- **A module's access is the union of its features**, so the ~1,000 existing
  module-level route guards keep working while sensitive areas keep their own
  key.
- **A disabled module, or an inactive user, grants nothing at all.**

### Where the old surfaces went

| Was | Now |
|---|---|
| **Role** tab | **Access profiles** tab — a profile *is* a role row |
| **Position** tab | Positions are **mapped** to a profile, managed in the left rail of the same tab. `positions.access_profile_role_id`. They hold no grants of their own; `POST /permissions/level` with `scope: "position"` is refused with an explanation. |
| **Advanced Matrix** tab | Folded in: every area row expands to **"Show exact actions"**, and the technical-authorization register and change history are panels at the foot of the same tab |
| Permission grid in *Register New Staff* | Removed. Registration picks an access profile; anything personal is set afterwards under Individuals |
| **Individual** tab | **Individuals** tab, unchanged in purpose and now formally superseding — it is the only layer that can overrule a profile |

The People & Access tab rail went from six tabs to five; Access Control went
from four sub-surfaces to two.

### Technical authorizations no longer grant permissions

They remain the competency record ISO 15189 asks for — who is authorised to
perform, review, verify or approve technical work — and are shown on the Access
Control screen as reference. They no longer widen anybody's software rights,
because a competency note quietly granting `approve` was one of the
contradictions this work removed. Where the rights are genuinely needed they
are granted on the profile, or to the person, where they can be seen.

### Migration for a laboratory already running

- `positions.access_profile_role_id` is added, **null for every position**.
  Everyone keeps resolving to the profile on their account, so nothing moves on
  upgrade.
- Any position that had grants configured under the old Position tab has them
  **folded into a new profile** named `<Title> (from position)`, so the
  configuration is preserved for review, and an audit row
  (`access_profiles_migrated`) records it.
- The merged screen flags **positions that hold staff but are not mapped**, so
  an administrator decides explicitly rather than by default.
- Net effect on upgrade is **narrowing only** — the additive position layer and
  the additive technical-authorization layer stop widening access. That is the
  direction the complaint asked for. Anyone who genuinely needs a right now has
  it granted somewhere visible.

---

## 3. Findings, module by module

### 3.1 Server — export, import and print guarded as `view`

Taking the register out of the building was gated on the right to *read* it, so
a "View only" cohort could download every one of these. All corrected to
`export` (or `create` for an import, `print` for a print sheet).

| Module | Route | Was | Now |
|---|---|---|---|
| Personnel | `GET /personnel/register/export`, `/register/template` | `personnel.register:view` | `:export` |
| Personnel | `GET /staff/template` | `personnel:view` | `personnel.register:export` |
| Equipment | `GET /equipment/register/export`, `/register/template` | `equipment.register:view` | `:export` |
| Equipment | `GET /equipment/maintenance/export`, `/maintenance/template` | `equipment.maintenance:view` | `:export` |
| IQC | `GET /iqc/materials/export`, `/materials/template` | `iqc:view` | `iqc:export` |
| IQC | `GET /iqc/controls/template`, `/runs/template` | `iqc:view` | `iqc:export` |
| EQA | `GET /eqa/programs/export`, `/programs/template` | `eqa:view` | `eqa:export` |
| NC / CAPA | `GET /nonconformities/register/export`, `/register/template` | `nc_capa:view` | `nc_capa:export` |
| NC / CAPA | `GET /incidents/register/export`, `/register/template` | `nc_capa:view` | `nc_capa:export` |
| NC / CAPA | `GET /nonconformities/:id/print` | `nc_capa:view` | `nc_capa:print` |
| Measurement uncertainty | `GET /measurement-uncertainty/export`, `/template` | `:view` | `:export` |
| Process management | `GET /reference-intervals/export`, `/template` | `process_management.intervals:view` | `:export` |
| Verification & validation | `GET /verification-validation/export` | `:view` | `:export` |
| Verification & validation | `GET /verification-validation/:id/print` | `:view` | `:print` |
| Documents | `POST /documents/:id/versions/:vid/export-docx` | `documents.library:view` | `documents.library:export` |
| Environmental | `GET /environmental/readings/export`, `/readings/template`, `/reports/:type/export` | `facilities_safety:view` | `facilities_safety.environment:export` |
| Environmental | `GET /environmental/reports/:type/print` | `facilities_safety:view` | `facilities_safety.environment:print` |
| Scheduling | `GET /duty-rosters/:id/print`, `/reassignments/:id/print`, `/bench-schedules/:id/print`, `/unit-supervisors/print` | `personnel.rosters:view` | `:print` |
| Settings | `GET /section-config/sections/:id/tests/template` | `settings:view` | `settings:export` |

### 3.2 Server — guards on the wrong key

- **Environmental Monitoring** was guarded on the whole `facilities_safety`
  module while the UI gated on `monitoring`. The two never agreed: a person
  entitled to the readings saw no buttons, and a person with any safety right
  at all — someone who may only report an incident — could read, export and
  import the entire monitoring record through the API. Both sides now name
  `facilities_safety.environment`.
- **Scanned records** (`/scanned-records`) were guarded on `documents`, but a
  scanned record belongs to the module it documents — a temperature chart to
  monitoring, a service sheet to equipment. Anyone who could open the document
  library could list, upload and delete *every other module's* scans. Now
  resolved per request against the record's own module.

### 3.3 Server — a guard that was never reached

`GET /verification-validation/export` was declared **after**
`GET /verification-validation/:id`. Express matched the parameter route first,
so the export guard was dead code: the request was decided by `:id`'s `view`
guard and then answered `404`. The register could not be exported by anyone,
and the control protecting it did nothing. Fixed with a numeric-id guard, and
the whole route table is now scanned for this class of shadowing by
`audit:access` check **[2b]**.

### 3.4 Server — routes reachable without a session

`optionalAuth` runs globally, so an unguarded route answers anonymous callers.
These now require a session: `GET /dashboard`, `/dashboard/operations-summary`,
`/dashboard/technical-quality-summary`, `/dashboard/governance-summary`,
`/dashboard/qms-summary`, `/dashboard/my-work-summary`, `/common/linked-records`,
`/system/about`, `/system/connectivity`, `/config/option-lists/:key`.

The remaining unguarded routes are correct: login, password reset, first-time
setup, the file-view ticket routes (authority is the ticket in the path), and
the self-service endpoints that check the caller against their own record.

### 3.5 Client — controls shown that the API refuses

| Module | Control | Was | Now |
|---|---|---|---|
| Equipment | **Import** register (beside a gated Export) | ungated | `equipment.register:create` |
| Equipment | Print barcode labels | `equipment:print` (module union) | `equipment.register:print` |
| Supplier & Inventory | Item register Export / Import | `supplier_inventory:*` (module union — true for someone who could only export storage inspections) | `supplier_inventory.stock:*` |
| Supplier & Inventory | Supplier register Export / Import | `supplier_inventory:*` | `supplier_inventory.suppliers:*` |
| Supplier & Inventory | Stock ledger Export, count-sheet Export ×2 | ungated | `supplier_inventory.stock:export` |
| Environmental | Export CSV / Export Excel / Print, device CSV Import | `monitoring:*` (a key the API never checked) | `facilities_safety.environment:*` |
| Monthly reports | Process / Reprocess an import batch | ungated | `monthly_reports:edit` |
| Monthly reports | Mark reviewed / Approve / Approve (override) | ungated | `monthly_reports:approve` |
| Monthly reports | Download an archived report | ungated | `monthly_reports:export` |
| Records & reports | Export CSV / JSON / HTML | ungated | `records_reports.generate:export` |
| Records & reports | Generate / Review / Approve | ungated | `:edit`, `:edit`, `:approve` |
| Records & reports | Log print job form | ungated | `records_reports.print:print` |
| Documents | Download as Word | ungated | `documents.library:export` |
| Documents | Records register Download | ungated | `documents.records:export` |
| Documents | Central archive Download ×2 | ungated | `documents.archive:export` |
| Customer focus | Import upload form, Process batch | ungated | `customer_focus.imports:create` / `:edit` |
| Assessments | Import checklist form, Create checklist form | ungated | `assessments:create` |
| Assessments | Activate / Deactivate, Archive, Delete | ungated | `:edit`, `:void_archive` |
| Blood bank | Download CSV | ungated | `blood_bank_handover:export` |
| Personnel | Blank register template | ungated | `personnel.register:export` |
| Scanned records (all modules) | Upload form, Download, Delete | ungated | host module's `create` / `export` / `void_archive` |

### 3.6 Client — pages and tabs that opened regardless

- **Placeholder module routes** were generated in a loop with no
  `RequirePermission` wrapper. A placeholder module is still a module; it is
  gated like every other one now.
- **`PermissionTabs` showed any tab that had no governing feature.** In a
  module that was never split into features, that meant *every* tab —
  including the blank "New …" forms. This is exactly the reported symptom: the
  user opens the form, fills it in, and the save is refused. A tab with no
  feature of its own now falls back to its **module** key, and the tab's own
  action decides it (`New …`, `Log a complaint`, `Report Incident`, `Manual
  Entry` … require `create`).
- **Risk Register, Complaints and the NC/CAPA submodules rendered raw tab
  bars.** All three now filter by permission. The duplicate unfiltered
  `useTabParam` calls were removed so a `?tab=` link cannot select a tab the
  bar has filtered away.
- **Environmental Monitoring rendered all twelve tabs to anyone.** Assets,
  Devices, Settings and Notifications now require `edit`; Manual Entry and
  Scanned Charts require `create`; the rest require `view`. A filtered-away
  active tab moves the user to the first tab they can open.

---

## 4. What is now guaranteed, and how it is proved

`npm run audit:access` — static, no server needed:

1. Every permission key named in a route guard, a `can()`, or a route element
   is a real module or feature.
2. Every export, import, template and print route asks for `export`, `create`
   or `print` — never `view`.
   **2b.** No permission guard is shadowed by an earlier parameter route.
3. Every module route in the client is behind a permission gate, generated
   placeholder routes included.
4. One model: the resolver reads exactly two grant tables, technical
   authorizations grant nothing, a user resolves to exactly one profile, only
   the seeder / the migration / the one write API touch the grant tables,
   positions carry no grants, the access screen offers exactly two surfaces,
   the Advanced Matrix is gone, individuals supersede.
5. Every module page filters its tab bar.
6. The client hides rather than disables — there is no greyed-out variant, and
   the shared Excel toolbar renders nothing when nothing is permitted.

`npm run audit:access:live` — against a running host, one account per access
profile:

1. **What the user is shown is exactly what the API allows.** For every profile
   and 30 areas, the effective permission map and the API's own answer must
   agree. A shown-but-refused area is a page that opens and then fails; a
   hidden-but-allowed area is a workspace withheld from someone entitled to it.
2. **View means view.** For 13 areas with a real export, the level is set to
   View and the export and template endpoints must return 403 — then set to
   Manage, and the same export must succeed. A control that is always refused
   is not a control, it is a broken button.
3. **No access means gone**, from the map and from the API.
4. **A position cannot contradict a profile** — writing permissions to a
   position is refused; mapping a position to a profile works and is visible on
   the merged screen.
5. **The individual supersedes in both directions** — grants what the profile
   withholds, withdraws what the profile grants, and clearing the override
   returns the person to the profile. `GET /permissions/effective/:userId`
   states profile level, personal level and effect for every area.
6. **A disabled module grants nothing**, not even to the administrator.

Result at the time of writing: **16/16 static, 14/14 live**, with
`rbac:check` 19/19, `rbac:matrix` 14/14 and `rbac:selfservice` 18/18 unchanged
and passing.

---

## 5. Operating the new screen

**Settings → People & Access → Access Control.**

**Access profiles** (left rail: the profiles, then every organogram position)

- Pick a profile and set a level per area: *No access · View · Contribute ·
  Manage · Full*. **Set all** applies a level to a whole module in one call.
- **Show exact actions** on any row spells out the seven actions the level
  grants — the Advanced Matrix, in the place the decision is made.
- Each position names the profile its holders work under, or *Follows the
  person's own profile*. Positions holding staff with no mapping are called out
  at the top of the panel.
- Add, rename and retire profiles here. A new profile starts with **no access
  anywhere** — least privilege by default. A profile in use by an account or a
  position cannot be removed until those are moved.

**Individuals**

- Pick a person: the header states the profile they follow and, where it came
  from a position, which one.
- Every area is *Follow profile* until you decide otherwise. Any other level
  overrides the profile — to grant **or to withdraw** — and each row shows the
  profile level beside it and the effective outcome beneath.
- *Remove all personal decisions* returns someone to their profile entirely.

## 6. Deliberately left as they are

- **`GET /files/:id/download`** stays on `documents:view`. It is the path by
  which an attachment is *read* — a staff member opening their own declaration,
  a PDF the in-app viewer cannot embed — not a register export. Gating it on
  `export` would break reading, not tighten it. The named Export buttons that
  produce workbooks are all gated (§3.1, §3.5).
- **Backup download** under Settings → System stays as it is: the page already
  requires `settings:edit`, which is strictly narrower.
- **Self-service downloads and prints** in the User Portal — a person's own
  declaration, their own signed copy — stay ungated by design. Personal
  features are reached unconditionally for one's own record; the level controls
  what is seen of everybody else's (`canReachPersonalRecord`).


---

# Part 2 — the preset, and the leaks the first pass did not close

**Date:** August 2026 (second pass, after the laboratory tested Part 1)

Three screenshots settled what was still wrong: Access Control said Settings =
**No access** for a Biomedical Scientist, and a Biomedical Scientist had
Settings open; Access Control said Rosters = **View**, and a Biomedical
Scientist was saving, publishing and approving a duty roster. A hundred
attestations sat in the administrator's inbox while the bench inboxes they
belonged to were empty.

## 7. One root cause behind both screenshots

A module key is the **union of everything inside it**. Every member of staff
holds `personnel.self` at **Manage** — they maintain their own profile and
certificates, which is exactly right. Folding that into the union made
`personnel:edit` true for the **entire laboratory**, and every gate written
against the module opened with it:

```
personnel.self : manage      (everyone — their own record)
        ↓ union
personnel : edit  = TRUE for everyone
        ↓
/settings/scheduling   gated on personnel:edit  → Settings appears in the sidebar
canEditRosters         = can('personnel','edit') → Save / Publish / Approve / Delete
```

Two fixes, and they close the whole class:

1. **A personal area contributes only `view` and `print` to its module.**
   `server/services/permissionResolver.ts`. The workspace stays reachable — a
   person can open Personnel to find My Profile — but changing anything in a
   module now requires a grant on a real area of it. Their own record is still
   entirely theirs, through `canReachPersonalRecord`.
2. **Every write names the area it writes to, never the module.** 58 sites
   corrected — 33 route guards and 25 client gates. `audit:access` check
   **[4b]** now fails the build if a `create`, `edit`, `export`, `approve` or
   `void_archive` right is ever asked of a module that has features again.

The delegated Settings pages were the worst of it, and now name features:

| Settings page | Was | Now |
|---|---|---|
| Roster & Scheduling | `personnel:edit` — true for all staff | `personnel.rosters:edit` |
| Unit Activities & Reminders | `personnel.activities:view` | `personnel.activities:edit` |
| Stock & Storage | `supplier_inventory:edit` | `supplier_inventory.stock:edit` |
| Document Master List Import | `documents:create` | `documents.masterlist:create` |
| Evidence Upload | `records_reports:create` | `records_reports.evidence:create` |

Result, checked live against every seeded profile:

| Profile | Settings | Pages offered |
|---|---|---|
| System Administrator | shown | all eleven |
| Laboratory Manager | shown | Stock, Roster, Unit Activities, Master List, Evidence |
| Quality Manager | shown | Unit Activities, Master List, Evidence |
| Section Head | shown | Stock, Roster, Unit Activities |
| Stores Officer | shown | Stock & Storage |
| **Biomedical Scientist** | **hidden** | — |
| **Technician** | **hidden** | — |
| **Internal Auditor** | **hidden** | — |

Only the administrator profile holds the `settings` key at all; everyone else
who sees Settings sees a short list of delegated tools and nothing else.

## 8. Why the attestations never arrived

`notifyStaff` looped over the **login accounts** attached to a staff record:

```js
const users = db.prepare('SELECT id FROM users WHERE staff_id = ? AND is_active = 1').all(staffId);
for (const u of users) { /* insert the notification */ }
```

A person with no account yet, or whose account was linked to their staff record
*after* the document was issued, matched nothing — so the loop inserted nothing,
and never would, because it only ran at the moment of issue. The attestation
existed; the person was never told. `notifyAllStaff` in
`organisationExtended.ts` (the code of conduct) had the same shape.

Three changes:

- **A task is addressed to the staff record, not to an account.** One row per
  person on `assigned_to_staff_id`, with `user_id` filled in when an account
  exists. Link the account later and the waiting task is simply there. Repeat
  delivery for the same person and record is refused.
- **The backlog is delivered once**, by a migration that writes the missing
  notification for every pending or overdue attestation that has none.
- **An inbox is personal.** `GET /notifications` returned *every* row unless the
  caller passed `?mine=true` — which is why a hundred other people's
  attestations piled up in the administrator's inbox. It is personal by
  default; seeing the whole queue takes `notifications.rules:view` and an
  explicit `?all=true`. Acknowledging, resolving and dismissing moved from
  `notifications:edit` to `notifications.inbox:edit`, so acting on your own
  alerts needs nothing but your own inbox.

Verified end to end: a staff member created with no account, a document issued
and distributed, *then* the account created and linked — the attestation is in
their inbox, and the administrator's inbox holds one item, their own.

## 9. The preset

`ROLE_DEFAULTS_VERSION` is bumped to `2026.08-features.6-bench-baseline`, which
applies the table below **authoritatively, once**. This matters: a laboratory
already running was carrying grants from before features existed — the
Biomedical Scientist in the screenshot held **77 of 99 areas** — and
`INSERT OR IGNORE` could never clear them. After the re-apply that profile
holds **28**.

### What every member of staff gets, and only this

1. **To be told what they must do** — their own inbox, their reminder sounds,
   the review calendar, and the duty roster they are on (read).
2. **To raise what they find** — a nonconformity, a safety incident, a
   complaint, and their assigned actions.
3. **To keep their own record** — profile, certificates, declarations,
   training, through `personnel.self` and the self-service routes.
4. **The documents they must follow** — the library, and the code of conduct
   they sign against.

Their own declarations, training and duties are deliberately **not** granted as
areas: `view` on those registers is the right to read *everybody's*. A person
reaches their own through `/personnel/my-profile`, `/my-tasks`,
`/my-declarations` and the User Portal, which check the caller against their
own staff record.

### The daily job on top of that

Each profile adds the bench work it is responsible for — IQC, environmental
readings, equipment maintenance, sample receipt, the store, the front desk —
and nothing beyond it. Three profiles the organogram always had but the access
model never named were added: **Stores Officer**, **Customer Service Officer**
and **Internal Auditor** (reads the whole management system, runs assessments,
changes nothing it audits).

| Profile | Areas | Settings |
|---|---|---|
| System Administrator | 82 | yes |
| Laboratory Manager | 79 | delegated only |
| Quality Manager | 75 | delegated only |
| Internal Auditor | 47 | no |
| Quality Team Member | 46 | no |
| Section Head | 43 | delegated only |
| Biomedical Scientist | 28 | no |
| Technician | 20 | no |
| Customer Service Officer | 18 | no |
| Data Officer / Safety Manager | 17 | no |
| Blood Bank Unit Head / Stores Officer | 15 | no |
| Quality User | 14 | no |
| POCT Officer | 13 | no |

### Every position is wired to a profile

The Access Control screen was right to complain that fifteen positions held
staff with no mapping — their access came from whatever profile happened to be
on their login account, which is not a decision anybody made. The seed now maps
them by normalised title, so `INTERNAL AUDITOR`, `Internal Auditor` and
`internal  auditor` are one job:

```
Biochemistry Unit Head    → Section Head          Quality Manager       → Quality Manager
Biomedical Scientist      → Biomedical Scientist  Quality Team Member   → Quality Team Member
Blood Bank Unit Head      → Blood Bank Unit Head  Safety Manager        → Safety Manager
Customer Service Officer  → Customer Service      Secretary             → Quality User
Data Officer              → Data Officer          Stores Officer        → Stores Officer
Haematology Unit Head     → Section Head          System Administrator  → System Administrator
Laboratory Manager        → Laboratory Manager    Technician            → Technician
Microbiology Unit Head    → Section Head          Intern / trainee      → Technician
POCT Officer              → POCT Officer          Internal Auditor      → Internal Auditor
```

Only a position with **no mapping yet** is touched, so a laboratory's own choice
is never overwritten. Sixteen positions mapped on first boot; the warning
clears.

**One safeguard:** an administrator's account always wins over the organogram.
Without it, an administrator whose staff record happens to hold a bench position
would be demoted by the mapping — and, if they were the only administrator, the
laboratory would be locked out of its own access control with no way back in.

## 10. What the audits now prove

`npm run audit:access` — **23 static checks**, adding:

- **[4b]** No write right is ever asked of a module key; personal areas
  contribute only view/print; every delegated Settings page names a feature.
- **[4c]** Tasks are addressed to the staff record; `notifyAllStaff` reaches
  staff with no login account; the inbox is personal unless the caller manages
  alerts; acknowledging your own alert needs only your own inbox.

`npm run audit:access:live` — **21 live checks**, adding:

- **[6]** Only the administrator profile holds Settings. For each bench profile:
  Settings absent from the map and refused by the API (People & Access,
  modules, sections); no roster create, approve, or acting-head appointment; no
  staff-register export; no personnel register or appraisals — **and** their
  inbox, calendar, own profile, own tasks, own declarations, the roster they are
  on, and the documents they must follow all reachable, and an NC, a complaint
  and a safety incident all raisable.
- **[7]** Every active organogram position is mapped to a profile.
- **[8]** The default inbox listing carries nobody else's work, and asking for
  everybody's does not widen it.

Alongside: `rbac:check` 19/19, `rbac:matrix` 14/14, `rbac:selfservice` 22/22
(now asserting the roster is readable by all and writable by none of the bench),
`account-check` 37/37, `complaints-check` 38/38, `core-documents-check` 20/20,
`inventory-check` 43/43, `inventory-records-check` 56/56, `iqc-check` 38/38,
`iqc-io-check` 80/80, `iqc-admin-check` 73/73, `office-edit-check` 74/74.


---

## 11. Opening a Word document was gated on authoring

A controlled `.docx` has **no in-app preview** — the viewer deliberately stopped
rendering an approximation of Word, because the record and what people read
could drift. Word is therefore the *only* way to read one.

The handoff that opens it was gated on `documents.authoring:edit`, on both
sides:

```ts
// server/routes/documents.ts
router.post('/:id/versions/:versionId/office-session',
  requirePermission('documents.authoring', 'edit'), …)

// src/components/OfficeHandoff.tsx
{canEdit && <button className="oh-primary" onClick={open}>Open in Word</button>}
const rt = useOfficeRoundTrip({ ...props, autoOpen: canEdit });
```

So anybody who could read the document library but not author it — which,
after §9, is every member of bench staff — got no auto-open, no **Open in
Microsoft Word** button, and a card with a lone **Download**. They could not
read the SOP they are required to read and attest to.

**Reading is reading.** Opening is now governed by `documents.library:view`;
whether the handoff may write a version *back* is a separate answer:

- The session records `read_only` (new column on `office_edit_sessions`).
- `officeUriFor` takes a mode: an author is handed `ms-word:ofe|u|…` (open for
  edit), a reader `ms-word:ofv|u|…` (open for view), so Word behaves correctly
  at the desk.
- The WebDAV `PUT` refuses a read-only session with 403 — the URI is a request,
  this is the answer.
- On the desktop route the file-change watcher is not wired up at all for a
  reader, so no save is pushed at an API that would refuse it and no false
  "your reading failed" error is shown.
- **Upload edit** stays behind `documents.authoring:edit`; **Open** and
  **Download** do not. The status line says `Opened in Word · read-only`.

Verified live: a Biomedical Scientist mints a session (201), gets
`readOnly: true` and `ms-word:ofv`, **GET 200** (Word reads it) and **PUT 403**
(Word cannot save back). An administrator gets `readOnly: false`, `ms-word:ofe`
and GET 200.

`audit:access` check **[4d]** pins all six halves of this — 29 static checks in
total now — so a future change cannot quietly make reading an SOP require the
right to rewrite it.


---

## 12. Document control and declarations were offered to readers

Two more surfaces were drawn to everybody who could open the module.

**Documents & Records.** The tab bar was a plain array — `docTabs` — rendered
without a permission in sight, so a Biomedical Scientist whose profile reads
*Authoring: No access* and *Review & approval: No access* was offered **New
Document**, **Bulk Import**, the **Review** and **Approval** queues, **Reviews
Due**, the **Obsolete Register**, and an **Attestations** register carrying 3,158
rows of every colleague's signing status. Each tab now names the right it needs:

| Tab | Right |
|---|---|
| Document Register, My Inbox | `documents.library:view` |
| New Document, Bulk Import | `documents.authoring:create` |
| Review Queue, Approval Queue, Reviews Due, Attestations, Obsolete Register | `documents.workflow:view` |

A tab filtered away cannot stay selected, and the Settings deep link that jumps
straight to *New Document* now checks the same right before it does.

The server was loose in the same place: `GET /documents/attestations/list` and
`/attestations/documents` were guarded on `documents.library:view`, so reading
the library bought the whole laboratory's attestation register. Both now take
`documents.workflow:view`. `/attestations/pending` and `/distribution/inbox`
accepted any `staffId`, letting a reader open a named colleague's outstanding
signatures; they answer with the **caller's own** unless the caller holds
`documents.workflow:view`.

**Organisation → Code of Conduct.** The *Set up declaration* button was
literally hardcoded:

```ts
const canManage = true; // Server enforces permissions
```

The API had always refused a reader (`POST /organisation/ethical-forms` needs
`organisation.structure:create`), so the button could only ever fail — and what
you cannot do you should not see. It now asks `organisation.structure:create`,
and the ⋯ menu behind it asks `:edit` and `:void_archive` for editing and
deleting. **Signing is untouched**: `/ethical-forms/:id/sign` needs only
`organisation.structure:view`, which every member of staff holds, so a
declaration put to somebody is still theirs to read and sign — they simply
cannot raise one.

Verified as a Biomedical Scientist against a running host — the tab bar now
draws **Document Register** and **My Inbox** and nothing else, while
`POST /documents`, the attestation register, the picker and
`POST /ethical-forms` all answer 403, and the document register, their own
document inbox, the attestation they owe, the declarations put to them and
their notifications inbox all answer 200.

### The audit that should have caught it

Check **[5]** passed this file because it looked for the string
`PermissionTabs` *anywhere* in it — and Documents & Records imports it for its
Dashboard/Documents/Records rail while a second bar right underneath mapped a
raw array. It now inspects **each `className="tabs"` block on its own** and
requires the array it maps to be filtered by `can` / `canView` or produced by
`usePermittedTabs`. Inner switchers (`tabs sub`, `view-switch`) are exempt —
they choose between views of one area the person already holds.

That found four more rails that switch into **other modules** while checking
only whether the module was switched on, never whether the person may open it:

| Page | Rail entry | Was | Now |
|---|---|---|---|
| Assessments | Risk Management | `isEnabled('risks')` | `+ canView('risks')` |
| Assessments | Quality Indicator Monitoring | `isEnabled(…)` | `+ canView('quality_indicators')` |
| Process Management | Blood banking | `isEnabled(…)` | `+ canView('blood_bank_handover')` |
| Notifications | Records, Reports & Evidence | `isEnabled(…)` | `+ canView('records_reports')` |
| Notifications | Monthly Reports & Archives | `isEnabled(…)` | `+ canView('monthly_reports')` |

New check **[5b]** pins the document tabs to their rights by name, the
attestation register to `documents.workflow`, and the declaration button to
`organisation.structure:create`. The live audit now also proves, for every bench
profile, that the attestation register and raising a declaration are refused
while the attestation they owe, their document inbox and the declarations put to
them are reachable.

**39 static checks, 21 live**, alongside `rbac:check` 19/19, `rbac:matrix`
14/14, `rbac:selfservice` 22/22, `core-documents-check` 20/20,
`office-edit-check` 74/74, `account-check` 37/37, `complaints-check` 38/38,
`inventory-check` 43/43 and `iqc-io-check` 80/80.


---

## 13. Every role, every module — the sweep

> *All these concerns I have raised are not only about biomedical scientists;
> technicians and other roles are able to do the same.*

Correct, and the four passes above were fixing what appeared in a screenshot.
This one stopped doing that.

### The inventory

A scanner (`npm run audit:controls`, `scripts/access-scan-controls.mjs`) walks
every `.tsx` file, finds each control that triggers a write — button, menu item,
form — follows its handler to the API endpoint it calls, reads the guard the
**server** puts on that endpoint, and reports the exact `can(key, action)` the
control is missing.

That derivation is the point. The gate is not a guess about what a control
*ought* to need; it is **what the API will actually ask for**. A "Create NC"
button on the blood-bank screen came out as `nc_capa:create`, not
`blood_bank_handover:anything`, because that is the endpoint it calls.

It found **388 ungated write controls across 42 files**, of which **339
resolved to an exact gate**.

### First, the reassurance

The same pass read all **1,368 mounted routes**: **1,285 carry a
`requirePermission` guard**, and the 24 unguarded writes are all self-service —
your own appraisal acknowledgement, your own duty occurrence, your own mobile
record, your own signature, your own push subscription — each checked inside the
handler against the caller's own staff record. The one that looked like an
exception, `POST /mobile/approvals/:type/:id/decision`, calls `canApprove`
itself.

**So this was never a hole in the data.** Every one of those 388 controls was
already refused by the API. It was the other half of the rule — *what you cannot
do you should not see* — that was broken, across every role, in 42 files.

### The fix

Hand-gating 339 controls invites a different mistake in each one. Instead they
were rewritten with the **TypeScript compiler's own parser**, so element ranges
are exact:

- the element that *carries the handler* is gated — never an enclosing `<tr>`,
  which would hide the record instead of the action on it;
- braces are added only where the element sits among JSX children (inside
  `(…)`, a ternary or an existing `x && …` they would read as an object
  literal — the first attempt got this wrong and was thrown away);
- an existing condition is **extended** rather than nested;
- `const { can } = usePermissions()` is injected into any component that
  lacked it, walking out past expression-bodied arrows to the component that
  owns the list.

**339 of 339 gated**, across 31 files. Four over-gates from handlers that share
a helper (`UserAccountActions`, the backup folder) were then corrected by hand
so each control asks for its own endpoint's right, not the union of every
endpoint in the component — role change and reactivation are `settings:edit`,
deactivate and purge are `settings:void_archive`.

The 49 controls left unresolved are self-service, where the handler checks the
caller against their own record rather than a permission.

### One more thing it turned up

`DocumentControlPage` decided administrator status by **comparing the role's
name**:

```ts
const isAdmin = (user.roleName || '').toLowerCase() === 'system administrator';
```

The server decides it from `roles.is_administrator`, so renaming the role would
have silently kept — or lost — the reserved capabilities. It reads the flag now,
and the login payload reports that flag off the **access profile the user
resolves to**, the same fact `requireAdministrator` uses. Static check **[5c]**
fails the build if any client compares a role name again.

### The proof, for every role

Two new live checks replace screenshot-by-screenshot:

**[9] Every write route agrees with the map, for every profile.** The audit
reads the server's own guard off each static write route and asserts the
effective permission map — the thing every button is drawn from — says the same.
**3,275 probes** across all 15 profiles × every static write route. Where they
disagree, a control is either shown and then refused, or hidden from somebody
entitled to it. Administrator-only acts are recognised as the second gate they
are and probed separately.

**[10] Nothing has been hidden from the people who should see it.** The other
direction, which matters just as much after a rewrite of this size: every one of
the **160 distinct gates** the interface asks for anywhere is one the
administrator profile actually holds, so no screen has been quietly emptied.

Both pass. Alongside: **41 static checks**, `audit:controls` at **zero
resolvable ungated controls**, `rbac:check` 19/19, `rbac:matrix` 14/14,
`rbac:selfservice` 22/22, `core-documents-check` 20/20, `office-edit-check`
74/74, `account-check` 37/37, `complaints-check` 38/38, `inventory-check` 43/43,
`inventory-records-check` 56/56, `iqc-check` 38/38, `iqc-io-check` 80/80,
`iqc-admin-check` 73/73.

### What this does and does not settle

`audit:controls` holds the count at zero: a new ungated control fails it. **[9]**
holds every write route in agreement with the map for every profile. Between
them, a control that is shown and then refused is now a build failure rather
than something to be found in use.

What they do not cover: a *read* that shows too much — a listing that returns
other people's rows to somebody who may see the page but not the people on it.
Three of those were found and fixed by hand (the attestation register, pending
attestations, the distribution inbox — §12), but there is no automated check for
that class yet. It needs a per-endpoint statement of whose rows the answer may
contain, which does not exist in the code today.
