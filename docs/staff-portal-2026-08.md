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
