# My Portal — the staff workspace

*August 2026*

## What changed

SECH_LIMS gained a module organised around a **person** rather than a thing the
laboratory manages. Every other workspace is a register — documents, equipment,
suppliers. `staff_portal` (**My Portal**, `/my-portal`) is one member of staff's
own working file, and it sits directly below the Main Dashboard in the
navigation because, for most of the laboratory, it *is* their dashboard.

Alongside it, the **Main Dashboard was narrowed to the roles accountable for the
laboratory as a whole**: System Administrator, Laboratory Manager, Quality
Manager and unit heads (Section Head, Blood Bank Unit Head). Everyone else lands
on My Portal instead.

## Why the portal is built the other way round

A normal module opens on a dashboard and makes you leave it to reach a tab. My
Portal does the opposite: the landing **is** the portal. It carries, on one
screen:

* who the person is, where they are rostered today, and their signature;
* the six figures they steer by (to do today, assigned, unread, overdue, to
  sign, done today), each opening the panel that holds the work behind it;
* eight rectangular tiles — the faces of their own file — which open **in
  place**, so nobody navigates away from their portal to reach their own record;
* today's unit activities, what is waiting on them, the latest in their inbox,
  what is coming up, and one-tap buttons to raise a nonconformity, a safety
  incident, a complaint or a risk.

The tiles and sub-tabs are: **My Tasks**, **My Inbox**, **My Schedule**, **My
Record**, **My Documents**, **My Training**, **My Declarations** and
**Preferences**. Every task row opens the exact screen where the work is
performed — a declaration opens where it is signed, an attestation opens the
document inbox — rather than the module's front page.

## What moved, and what stayed

| Was | Is now |
| --- | --- |
| Main Dashboard: profile card, personal inbox, duty to-do | My Portal landing |
| Notifications & Reports: Dashboard, Full Inbox, My Tasks, Preferences | My Portal (My Inbox, My Tasks, Preferences) |
| Personnel Management: "My Profile" tab | My Portal (My Record, My Documents, My Training, My Declarations) |
| Notifications & Reports: review calendar, alert rules, routed scan, the alert overview | unchanged — these belong to the laboratory, not to one person |
| Main Dashboard: the laboratory's quality figures and charts | unchanged |

`src/components/DashboardProfileCard.tsx`, `src/components/DashboardInbox.tsx`
and `src/pages/personnel/UserPortal.tsx` were superseded and removed. The
alert-target map now sends activity alerts to `/my-portal?tab=My Tasks` instead
of the dashboard, and the topbar bell and user chip both open the portal.

## The portal is where the work happens

The first version told a member of staff what they owed and then sent them
somewhere else to do it. That is most of the way to useless — the reason the
list is worth having is that the list is where the work happens — so every kind
of task the portal raises now opens its own completion surface **over the
portal**, and closes back onto the list with the row gone. Nothing navigates.

| Task | What opens |
| --- | --- |
| Declaration | The text, the acknowledgement, a conflict-of-interest box, and (for a form issued as a file) download-sign-attach |
| Attestation | Document control's own viewer, lazy-imported, with its "I have read & understood" control |
| Action assigned to me | A progress panel: In progress / Waiting for evidence / Submitted for review / Completed, plus notes |
| Queued task | Start it, or mark it done |
| Unit activity | Already one tap on the duty panel |

The same drawer serves the landing, My Tasks and My Declarations, so there is
one way to sign a declaration however you reached it.

## The schedules, read in place

Being off the roster this week does not stop a person needing to read it.
**My Schedule** now carries the published duty roster, the unit reassignment
memo and bench schedules — read-only grids opened over the portal, with the
reader's own row highlighted and pulled to the top. Only `published` and
`approved` schedules appear: a draft is somebody's work in progress, and
planning a week around one that later changes is worse than not seeing it.
`personnel.rosters: view` is in the baseline every member of staff holds.

## Signing an attestation from the list

An attestation row carries two controls now. **Read & attest** opens the
document in document control's own viewer, as before. **Sign** records it from
the list, for the case that is genuinely common — somebody who read the SOP at
the bench, or read it here yesterday and is clearing their list this morning.

It is two clicks, deliberately. An attestation is a signed statement that a
named person read and understood a controlled document; a single unguarded
click, sitting beside "Done" buttons that mean far less, would collect
signatures nobody intended to give. So the first click replaces the button with
the sentence being signed and a confirm, in place on the row — still quick, no
dialog and no navigation, but nobody signs by accident.

## Job descriptions

A job description is a controlled document like any other: written, reviewed,
approved, versioned and issued through Documents & Records. What makes it
different is that it is the one document whose purpose is to describe a
particular job — so `documents` gained two columns saying which:

* `applies_to_position_id` — the post it describes. Everybody holding that post
  sees it.
* `applies_to_staff_id` — for a laboratory that issues a personalised
  description. One issued by name takes precedence over the one for the post.

Both are distinct from `owner_position_id`, which already existed and means
something else: the post responsible for keeping the document current.

The consequence is that a job description is **uploaded once and appears in
three places**, none of which holds a copy:

| Where | What it is |
| --- | --- |
| Documents & Records | the document itself, with the two new fields on the form when the type is Job Description |
| Personnel Management → Job Descriptions | the register: which post, which version, which status — and **which active posts have none**, with how many people hold each |
| My Portal → My Record | the holder's own, opened in document control's viewer |

Keeping a second copy on the staff file was the alternative, and it is how a
laboratory ends up with two job descriptions that disagree — with the one the
member of staff reads being the stale one. So all three surfaces read the
register (`GET /personnel/my-job-descriptions`, self-scoped;
`GET /personnel/job-descriptions`, gated on `personnel.register`) and open the
same viewer. When a new version is issued, what is read in the portal changes
with it, because it is the same document.

Only documents in force reach a portal — `approved`, `current` or `due_review`.
A draft job description is somebody's work in progress, and a member of staff
reading their duties from one that later changes is worse than reading nothing.
A description registered without a file says so on the row rather than offering
to open an empty window.

## Routine Work — and who is competent to do it

The recurring work of a bench — environmental charting, bench and equipment
decontamination, scheduled equipment maintenance, IQC — was already being
scheduled and reminded on by the unit-activities engine. What it lacked was a
place where a member of staff could see the whole programme, understand their
part in it, and do their part. That is the **Routine Work** face of the portal:

* **Due from me now** — what is on this person's list today, completed in one
  tap, with the note and ease rating the simplification programme runs on.
* **The unit's programme** — every active activity for their unit, grouped by
  the kind of work, with its frequency, when it was last done and by whom.

The whole programme is shown, including work this reader does not perform.
A technician is entitled to know the analyser is serviced monthly even though a
scientist services it; what the tier decides is whether they get a button, not
whether they get the truth.

### Three tiers, and they are permissions

Being rostered onto a bench is not the same as being competent to do everything
that happens on it. Each activity carries a **performer tier**, and each tier is
an ordinary permission feature — so who holds it is an Access Control decision
per profile, changeable without touching code:

| Tier | `routine_work.…` | Default holders |
| --- | --- | --- |
| **General** — charting, decontamination, cleaning, stock and safety checks | `general` | Everyone (in the baseline) |
| **Technical** — IQC, calibration checks, method-related maintenance | `technical` | Biomedical Scientist and above, POCT and Safety, the quality office |
| **Supervisory** — reviews, sign-offs, scheduled servicing | `supervisory` | Section Head, Blood Bank Unit Head, Safety Manager, Quality Manager, Laboratory Manager |
| **Oversight** — read what the whole unit was due to do and what was done | `oversight` | Unit heads, the quality office, Internal Auditor |

Defaults live in one table (`ROUTINE_TECHNICAL_ROLES` and friends in
`server/db/seed.ts`) for the same reason the Main Dashboard list does: "who is
competent to do what" is a decision a laboratory should read in one place. A
laboratory that has trained its technicians on the analysers grants them the
technical tier in Access Control; one that treats fridge charts as supervised
sets that activity's tier higher. Both are configuration, not code.

The tier is set per activity under **Settings → Unit Activities & Reminders**,
next to "who does it" — the roster decides *which person*, the tier decides
*whether that person is qualified*. Choosing a category suggests the tier that
kind of work usually sits at, so adding an analyser service does not quietly
default to "anyone on duty".

Enforcement is server-side in `assertMayWork`, which asks two independent
questions and needs yes to both: did the roster place you on it, and do you hold
its tier. It guards `start`, `complete` and `not-applicable` alike — writing an
activity off as not applicable is as much a claim about the work as completing
it. A refusal names the tier that does perform it, so the reply is useful rather
than merely negative. `GET /duty/routine` returns `mayPerform` per activity so
the screens ask the same question before drawing a control.

## The half of the file its subject keeps

A personnel file has two halves. One is what the laboratory decides — post,
unit, staff number, appointment — and it stays with Personnel Management, is
shown with a padlock, and says so. The other is what the person knows and the
laboratory does not, and it was going stale because updating it meant asking
somebody to type it in.

Staff now maintain that half themselves:

* **My Record** — phone, email, emergency contact, date of birth, ID, and their
  qualifications, regulator, licence number and expiry. Plus a **passport
  photograph**: any picture is cropped to 7:9 and re-encoded in the browser
  before it is sent, so a phone photograph arrives the right shape and a
  fraction of the 2 MB cap.
* **My Documents** — upload, correct and remove their own certificates and
  licences.
* **My Training** — courses, conferences and qualifications completed outside
  the laboratory's own register (`staff_cpd_records`), with the certificate
  attached.

The line is drawn at consequence, and at evidence. A field that decides what
somebody may do is not theirs. And once Personnel Management has **verified** a
document or a training record it becomes evidence and stops being editable from
the portal — a verified record whose subject can still quietly change the dates
is not evidence of anything. A document the register placed on the file is
read-only there from the start. Every self-service change is written to the
audit trail with its old value.

Endpoints (all self-scoped; none accepts a staff id from the body):
`PUT /personnel/my-profile`, `POST /personnel/my-upload`,
`POST|PUT|DELETE /personnel/my-documents[/:id]`,
`GET|POST|PUT|DELETE /personnel/my-training[/:id]`,
`POST|GET|DELETE /personnel/my-photo`, and
`POST /actions/:id/my-progress` — which moves an action only along the *doing*
half of its lifecycle. Verified and Closed are the verifier's words and are
refused: an assignee marking their own work verified is the thing an audit trail
exists to prevent.

## Access

* `staff_portal` is granted to the **whole laboratory** at Manage level in the
  seeded baseline. Everything behind it reads a self-scoped endpoint — the
  server matches the caller against their own staff record — so giving the
  portal to everyone gives nobody sight of a colleague's file.
* `dashboard` was removed from the baseline and granted to the four profiles
  listed in `MAIN_DASHBOARD_ROLES` (`server/db/seed.ts`). The list is kept in
  one place so "who sees the laboratory's overview" stays a single visible
  decision rather than a line buried in four role blocks.
* `notifications.inbox` and `notifications.sounds` remain the keys the portal's
  inbox, task-queue and sound endpoints are gated on; only the screens moved.
* Seeded defaults reach existing laboratories through
  `ROLE_DEFAULTS_VERSION = '2026.08-features.7-staff-portal'`, which re-applies
  the corrected position once and then leaves each laboratory's own decisions
  alone.

`npm run audit:access` and `npm run rbac:check` both assert the new position: a
Technician holds `staff_portal` and does **not** hold `dashboard`.
