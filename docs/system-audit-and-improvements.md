# SECHLIMS — System audit & improvement plan

_Audit date: 2026-07-04. Scope: full application after the module-consolidation
work (single-dashboard workspaces, process-phase regrouping). This is an
internal engineering/quality document; nothing here is surfaced in the product._

## 1. Where the system stands

The application now presents **one workspace per quality essential**, each with a
single dashboard followed by flat working tabs. The information architecture in
`shared/constants/navigation.ts` is the single source of truth for both the
sidebar and the home launchpad, so the two can never drift apart.

Consolidations completed:

| Workspace | Dashboard | Working tabs (after dashboard) |
|-----------|-----------|--------------------------------|
| Organisation & Leadership | 1 | Code of Conduct, Budget Projections, Registration & License, Meetings, Management Review |
| Customer Focus | 1 | Complaints, Advisory Services, Laboratory Handbook, … |
| Process Management | 1 | Pre-examination, Examination, Post-examination, Blood banking (phase tabs, each with its own sub-tabs) |
| Nonconforming Event Management | 1 | NC register, CAPA, Action Tracker |
| Assessments | 1 | Internal Audit, Risk Management, Quality Indicator Monitoring |
| Facilities & Safety | 1 | Safety registers + Environmental Monitoring |
| Notifications & Reports | 1 | Notifications & Review Calendar, Records/Reports/Evidence, Monthly Reports & Archives |

Process Management is now organised around the **path of a sample** —
pre-examination → examination → post-examination → blood banking — which mirrors
how bench staff actually experience the workflow. IQC, EQA, method
verification, measurement uncertainty and POCT live as sub-tabs under
Examination; blood banking is its own phase. Each still respects its module
enable/disable flag, so a lab that doesn't run POCT simply won't see the tab.

## 2. Strengths worth keeping

- **Chart-first dashboards.** Every workspace opens on a compact KPI strip plus
  one or two charts that fit one screen, and every KPI/segment drills through to
  its source records. Good for a quality manager's morning glance.
- **Consistent record spine.** Auto record numbering, `record_links` for
  NC/CAPA/action traceability, `requirePermission` gating, and audit logging are
  applied uniformly across modules.
- **No embedded standards.** All requirements are expressed through the data
  model and workflows, not by naming or hard-coding any external document. SOPs
  and policies are user-created/uploaded, never shipped.
- **Offline-first.** SQLite + Express + Electron keep the whole thing usable
  without a network, which suits the deployment context.

## 3. Improvement opportunities (prioritised)

### High value, low risk
1. **Cross-module "My work" home.** The Notifications dashboard already
   aggregates due/overdue items; promote a single unified "action inbox" that
   pulls open actions, pending reviews and approvals from every module into one
   list per user. Reduces the hunting that the tab structure can still require.
2. **Deep-link routes for phase tabs.** Direct routes still exist for the old
   sub-modules (`/iqc`, `/eqa`, …). Add query-param support to
   `/process-management?phase=examination&tab=IQC` so notifications and reports
   can link straight to the right sub-tab instead of the module root.
3. **Empty-state guidance.** Several new registers show a bare "No records yet"
   row. A one-line prompt describing what the register is for (and a "add first
   record" affordance) would help first-time users.

### Medium value
4. **Consolidate the four `useLookups()` copies.** Sections/departments/staff/
   equipment/locations lookups are re-implemented in most page files. Extract a
   shared hook with a small in-memory cache to cut duplicate fetches on tab
   switches.
5. **Dashboard summary endpoints.** Each dashboard fires several parallel calls.
   A single `/dashboard/<module>-summary` per workspace (already the pattern for
   some) applied everywhere would reduce round-trips and simplify the frontend.
6. **Review-calendar coverage.** Every register with a "next review/next due"
   date should feed the shared review calendar automatically. Confirm reference
   intervals, contingency plans, comparability studies and MU reviews all emit
   review items.

### Longer term
7. **Role-scoped dashboards.** A bench scientist, a section head and the quality
   manager want different first screens. Consider a role default landing view.
8. **Trend analytics.** IQC has Levey-Jennings; extend simple trend charts to
   TAT, rejection rates and EQA performance over time for management review.
9. **Test coverage.** Add integration tests around the NC/CAPA linking and the
   record-numbering generator — the highest-consequence shared code paths.

## 4. Data-integrity checks to schedule

- Verify no orphaned `record_links` after module consolidation.
- Confirm every module key referenced by `isEnabled(...)` still exists in the
  module registry (IQC/EQA/verification/MU/POCT/blood-bank remain registered so
  their Process Management sub-tabs can be toggled).
- Spot-check that disabling a sub-module cleanly hides its phase sub-tab without
  breaking the parent dashboard.
