# The appointment register

## 1. What went wrong

A laboratory appointed a new Microbiology supervisor and the old one stayed.
Both read as "Microbiology Unit Supervisor" on the staff register — and, far
worse, the old one kept the post's access, because a person's access profile is
resolved from exactly those appointment rows. The same thing happened in
reverse when a supervisor was rotated between units: her record still read Blood
Bank while somebody else held Blood Bank too.

Two causes, both structural.

**One fact, two records.** Who held the post lived in
`staff_position_assignments`; who ran the unit lived in `sections.head_staff_id`.
Nothing kept them in step, and different parts of the system read different ones.

**Six places could write them.** The organogram, the unit profile, the personnel
register, staff registration, a quick-assignment form, and a Unit Supervisors
board in Personnel Management — none aware of the others. The organogram's
"appoint" was the sharpest edge: it *demoted* the incumbent to a `secondary`
assignment that stayed **active**, so the post had two holders, one of them
invisible on the very chart that made them.

## 2. What it is now

One register, one writer, and everywhere else reads it.

| | |
| --- | --- |
| Where | Settings → People & Access → Positions & Organogram → **Appointments** |
| Service | `server/services/appointments.ts` — the only module that writes an appointment |
| Routes | `server/routes/appointments.ts` (`/api/appointments`) |
| Screen | `src/components/settings/Appointments.tsx` |

Four rules, held in the service rather than in each screen:

**An appointed post has one holder.** Appointing a successor **ends** the
predecessor's appointment, with the date it ended. It is never demoted or
hidden.

**A unit has one supervisor, and the unit follows the post.** A post names the
unit it supervises (`positions.supervises_section_id`) instead of being guessed
from its title, and at most one post per unit may do so — a unique index
enforces it. `sections.head_staff_id` is maintained from the appointment, so
scheduling, duty rosters, alert routing, quality control and the permission
resolver all read one answer. The supervisor's own `staff.section_id` moves to
the unit with them.

**A grade is not an office.** The one-holder rule is of appointed offices only
(`positions.is_core`, or any post that supervises a unit). Ten technicians hold
"Laboratory Technician"; that is a laboratory, not a conflict.

**A person may hold several posts.** The rule is one holder per *post*, never
one post per person. The register shows what each person already holds before
anybody is moved.

Acting appointments live on the same screen: a stand-in runs a unit for a fixed
period and it reverts on its own. Who holds the post and who is in charge today
are different questions, and the register answers both side by side.

## 3. What the other screens do now

| Screen | Then | Now |
| --- | --- | --- |
| Organogram node | Assigned and removed holders with its own rules | Shows the holder; links here |
| Unit profile (Settings → Units) | Set `head_staff_id` directly | Shows the supervisor read-only; links here |
| Personnel register | Changed a person's post | Shows the post read-only; links here |
| Positions list quick form | Created staff *and* appointed them | Creates the staff record only |
| Personnel Management → Unit Supervisors | A whole board of its own | Removed; it is the Unit supervisors view here |
| Staff registration | Inserted assignments directly | Goes through the register, so it hands a post over rather than doubling it |

The server routes behind the old screens were not deleted — a client that has
not been reloaded still calls them — but every one of them now goes through
`appoint()`/`vacate()`, so none of them can recreate the fault.

## 4. What happens to a database that already has the fault

A one-off reconciliation runs at startup (`server/db/database.ts`) and is
idempotent:

1. Each post's supervised unit is read once off the titles already in use — one
   post per unit, longest title match.
2. For every **appointed** post with more than one active holder, the most
   recent appointment stands and the rest are **ended**. Bench grades are not
   touched.
3. Every unit's `head_staff_id` is set from its supervising post's holder, and
   the holder's own unit is moved to match. Where the post is vacant but the
   unit names a head, that head becomes the appointment — the laboratory said
   who runs the unit and nothing here throws that away.
4. What it changed is written to `audit_logs` as a `reconcile` entry.

"Most recent wins" is a choice, and the Appointments tab shows the outcome so a
laboratory can correct anything it read differently — in one click.

## 5. What is proved, and where

`npm run check:appointments` — 40 checks against a live host: that an office has
one holder and a successor ends the predecessor's appointment; that the unit and
the supervisor's own record follow the post; that a grade displaces nobody; that
a person may hold several posts; that a second post cannot claim a unit; that
vacating leaves the unit honestly unsupervised; and that the unit profile, the
personnel register, the organogram and staff registration either go through the
register or change nothing at all.

`npm run check:unit-lead` and `npm run check:bench-access` cover the other side
of it — that running a unit still carries that unit's rights, and no others.
