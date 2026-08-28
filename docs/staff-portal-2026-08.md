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
