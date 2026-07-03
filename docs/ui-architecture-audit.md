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

### 2.1 One navigation source of truth

`shared/constants/navigation.ts` defines **NAV_SECTIONS** — the 15 homepage
features, each owning its child module keys:

| # | Section (homepage card) | Modules |
|---|---|---|
| 1 | Main Dashboard | dashboard |
| 2 | Documents & SOPs | documents, dennis |
| 3 | Personnel | personnel, organisation |
| 4 | Equipment & Monitoring | equipment, monitoring |
| 5 | Inventory | supplier_inventory |
| 6 | Process Control \| IQC-EQA | iqc, eqa, verification_validation, measurement_uncertainty, process_management, poct, blood_bank_handover |
| 7 | Nonconformities & CAPA | nc_capa, actions |
| 8 | Assessments & Audits | assessments |
| 9 | Risk Management | risks |
| 10 | Complaints & Customer Service | complaints, customer_focus |
| 11 | Facilities & Safety | facilities_safety |
| 12 | Continual Improvement | continual_improvement, quality_indicators, management_review, meetings |
| 13 | Reports | records_reports, monthly_reports, information_management |
| 14 | Notifications | notifications |
| 15 | Settings | settings |

- The **Home launchpad** renders its cards from this structure.
- The **sidebar** renders the same 15 sections in the same order. Sections
  with one module are plain links; sections with several become collapsible
  groups. The group containing the current route auto-expands; the rest stay
  closed, so the resting sidebar is 16 rows instead of 31.
- Every module remains reachable — nothing was removed, only grouped.

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
