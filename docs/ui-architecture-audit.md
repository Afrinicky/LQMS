# SECH_LIMS — UI & Architecture Audit

_Audit of the navigation architecture and dashboard design, with the changes
applied in this branch. July 2026._

## 1. Findings

### 1.1 Navigation: sidebar and homepage told two different stories

- The **Home launchpad** presented the product as **15 features** (Main
  Dashboard, Documents & SOPs, Personnel, … Settings).
- The **sidebar** presented the same product as **31 modules** spread across
  6 ad-hoc groups ("Quality & Compliance", "Operations", "Technical Quality",
  …) whose names and ordering matched nothing on the homepage.
- The two surfaces were maintained as **separate hard-coded lists**
  (`LAUNCH_CARDS` in `CorePages.tsx`, `NAV_GROUPS` in `AppLayout.tsx`), so
  they drifted apart as modules were added.

**Impact:** users learn the product's mental model on the homepage, then meet
a completely different taxonomy in the sidebar. A 31-item flat list also makes
every navigation a visual scan of the full column.

### 1.2 Dashboards: numbers instead of pictures, and far too many of them

- The **Main Dashboard** stacked a KPI row, two charts, My Work, quick
  actions, and **ten additional sections containing ~90 large metric cards**
  (System Health, QMS Core, Operations, …, Snapshot Counts) — roughly five
  screens of tiles, most duplicating what module dashboards already show. It
  also issued **16 API calls** on every load.
- **Module dashboards** each led with a grid of 4–11 big metric cards
  (~110 px tall each) before their charts, pushing the charts below the fold.

**Impact:** the dashboards read as inventories of numbers, not instruments.
Nothing was ranked, proportioned or trended; the eye had no anchor.

## 2. Changes applied

### 2.1 One navigation source of truth, organised by the twelve quality essentials

`shared/constants/navigation.ts` defines **NAV_SECTIONS**: the twelve quality
essentials of a laboratory quality management system, book-ended by the
software's own features. Each section owns its child module keys:

| Band | Section | Modules |
|---|---|---|
| Overview | Main Dashboard | dashboard |
| Essential 01 | Organisation | organisation, meetings, management_review |
| Essential 02 | Personnel | personnel |
| Essential 03 | Equipment | equipment |
| Essential 04 | Purchasing & Inventory | supplier_inventory |
| Essential 05 | Process Control | process_management, iqc, verification_validation, measurement_uncertainty, poct, blood_bank_handover |
| Essential 06 | Information Management | information_management |
| Essential 07 | Documents & Records | documents, dennis |
| Essential 08 | Occurrence Management | nc_capa, actions |
| Essential 09 | Assessments | assessments, eqa |
| Essential 10 | Process Improvement | continual_improvement, quality_indicators, risks |
| Essential 11 | Customer Service | complaints, customer_focus |
| Essential 12 | Facilities & Safety | facilities_safety, monitoring |
| System | Notifications & Reports | notifications, records_reports, monthly_reports |
| System | Settings | settings |

Placement rationale (the judgment calls):

- **Meetings and management review sit under Organisation** — they are how
  leadership steers the quality system.
- **EQA sits under Assessments, beside internal audits** — external quality
  assessment is an assessment of the laboratory, not a bench control; IQC
  stays in Process Control where the daily work happens.
- **Risk management sits under Process Improvement** — the risk register is
  the preventive half of the improvement cycle, next to quality indicators
  and improvement projects.
- **Environmental monitoring sits under Facilities & Safety** — temperature
  and environment readings describe the laboratory's physical conditions.
- **Reports are merged with Notifications** into one system band: alerts,
  the review calendar, generated reports and evidence packs are all "what
  the system tells you", not a quality essential of their own.

Rendering:

- The **Home launchpad** renders its cards from this structure; the twelve
  essentials carry index badges 01–12, the software features do not.
- The **sidebar** renders the same sections in the same order under three
  band labels (Overview / Quality essentials / System). Sections with one
  module are plain links; sections with several are collapsible groups, and
  the group containing the current route auto-expands.
- Every module remains reachable — nothing was removed, only grouped. Module
  page eyebrows name the essential each module belongs to.
- No external standard is cited anywhere in the user interface; the
  structure and wording stand on their own.

### 2.2 Chart-first, one-page dashboards

- A new **`KpiStrip`** component (`components/ui/KpiStrip.tsx`) shows a
  dashboard's headline numbers as a single slim band (~70 px) instead of a
  grid of large cards. Values support `danger` / `warning` / `success` tones.
- The **Main Dashboard** is now: one KPI strip → six compact charts (quality
  workload donut; operational readiness, technical quality, people &
  documents, governance meters; alerts bar chart) → My Work strip + quick
  actions. The ten metric sections are gone, and the page loads with 9 API
  calls instead of 16. Detailed counts live on the module dashboards they
  belong to.
- **Every module dashboard** (Equipment, Inventory, Monitoring, Safety, IQC,
  EQA, Verification, MU, NC/CAPA, Complaints, Risks, Personnel, Documents &
  Records, Process, Information, Customer Focus, POCT, Blood Bank, Monthly
  Reports, Notifications, Records & Reports, and the governance pages) now
  follows the same pattern: **KPI strip on top, charts below, one page**.

## 3. Recommendations for future work

1. **Trends over snapshots.** The chart kit already has a `Sparkline`; adding
   month-by-month history endpoints (e.g. NCs opened/closed per month, IQC
   failure rate) would turn the dashboards from status boards into trend
   instruments — the single most valuable next step for a QMS.
2. **Make charts clickable.** Each chart segment/bar maps to a filtered list
   in a module; wiring `onClick → navigate` would make the dashboard the
   primary way into work queues.
3. **Role-aware dashboards.** The quality manager, section head and bench
   scientist need different headline KPIs; NAV_SECTIONS plus the permission
   model would support per-role KPI strips with little extra plumbing.
4. **Keep the shared structure authoritative.** When adding a module: add it
   to `MODULES`, then to its section in `NAV_SECTIONS`. Never re-introduce a
   page-local navigation list.
