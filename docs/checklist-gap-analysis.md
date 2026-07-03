# SECHLIMS — Checklist Gap Analysis & Upgrade Plan

_Deep audit of the software against two benchmarks: the **SLIPTA Checklist
Version 3:2023** (373 points across 12 sections) and the **Ghana Accreditation
Service FM7.2-05 scheme-specific checklist for medical laboratories (2022)**.
Written from the perspective of a laboratory quality manager and reviewed as a
software engineer. July 2026._

---

## How to read this

The software is now organised around the **same twelve sections** the SLIPTA
checklist uses, in the same order — so each section below maps one-to-one to a
left-pane feature. For each section I give:

- **Weight** — SLIPTA points (share of the 373 total).
- **Coverage** — what the software already does well.
- **Gaps** — checklist items with no home in the software yet.
- Gaps are tagged **[High]** (checklist points at risk now, common audit
  findings), **[Med]**, or **[Low]** (nice-to-have / partial).

**Design principle — standards are a blueprint, never named in the product.**
SLIPTA and the GAS checklist are used *only* as the specification for what the
software must let a laboratory do. The running application names no standard,
scheme or clause anywhere — no "ISO 15189", no "SLIPTA", no clause numbers in
page text, help copy, templates or exports. A laboratory that simply uses the
software the way it is built will produce the records and evidence those
schemes expect, without the software ever advertising them. (This document is
an internal engineering blueprint, not part of the product.)

The GAS FM7.2-05 checklist (2022) has now been reconciled — see **§13**. It is a
clause-by-clause restatement of ISO 15189:2022 (clauses 4–8.9), the same
backbone SLIPTA is built on, so the two agree section-for-section; GAS adds a
handful of finer-grained clauses and Ghana-specific regulatory items.

---

## Scorecard at a glance

| # | Section | SLIPTA pts | Software coverage |
|---|---------|-----------:|-------------------|
| 1 | Documents and Records | 22 | **Strong** — controlled docs, versions, reviews, attestations, master list, retention, archive |
| 2 | Organisation and Leadership | 26 | **Good** — org/leadership, meetings, management review; **budget & code-of-conduct records thin** |
| 3 | Personnel Management | 34 | **Strong** — records, competency, training, authorisation, declarations, rosters; **appraisals thin** |
| 4 | Customer Focus | 24 | **Good** — feedback, surveys, agreements, communications; **advisory service & lab handbook missing** |
| 5 | Equipment Management | 44 | **Strong** — register, maintenance, calibration, breakdown, verification |
| 6 | Assessments | 24 | **Good** — internal audits, findings, risk register, quality indicators; **EQA now lives here in the checklist** |
| 7 | Supplier and Inventory Management | 27 | **Strong** — suppliers, evaluations, inventory, batches, FEFO/expiry |
| 8 | Process Management | 71 | **Partial** — IQC, EQA, verification, MU, referrals, critical results, amendments strong; **pre-examination (sample collection, test request, receipt), contingency plan, reference-interval register, result-comparability missing** |
| 9 | Information Management | 24 | **Strong** — assets, systems, access reviews, security incidents, downtime, LIS validation, backups |
| 10 | Nonconforming Event Management | 13 | **Strong** — NC events, root cause, CAPA, effectiveness |
| 11 | Continual Improvement | 07 | **Strong** — projects, updates, indicators |
| 12 | Facilities and Safety | 57 | **Weak** — only a safety-incident log; **~50 of 57 points have no home** |

**Where the points are.** Process Management (71) and Facilities & Safety (57)
together are **34%** of the whole audit. Facilities & Safety is the single
biggest, most fixable gap in the software today.

---

## Section-by-section findings

### 1. Documents and Records — 22 pts · Strong
**Coverage.** Controlled-document lifecycle (draft → review → approve →
obsolete), version history, scheduled reviews, staff attestations, the
Documents & Records **master list**, record retention rules, backup and
destruction logs, and an archive with retrieval. This directly answers 1.3–1.10.
**Gaps.**
- **[Low] Legal-identity document (1.1).** Nowhere to store the lab's licence /
  registration / establishment letter. Add a "Legal & accreditation documents"
  area in the laboratory profile.
- **[Low] Quality manual builder (1.2).** The manual exists only as an uploaded
  document. Consider a guided quality-manual template that links to the policies
  and SOPs held in the system (SLIPTA rewards a linked, navigable manual).

### 2. Organisation and Leadership — 26 pts · Good
**Coverage.** Organisation & leadership module, organogram, meetings & minutes
with actions, and management review with structured inputs/outputs and action
tracking (answers 2.5–2.11 well).
**Gaps.**
- **[High] Code of conduct records (2.1–2.2).** Impartiality, confidentiality
  and conflict-of-interest **declarations** exist per-staff under Personnel, but
  there is no organisation-level *code-of-conduct procedure + signed-adherence
  register* surfaced under Organisation. Surface a leadership code-of-conduct
  record set (policy + adherence evidence).
- **[Med] Budget projections (2.4).** No budgeting record tied to personnel,
  scope, equipment, maintenance and QA/QC (IQC/EQA) needs. Add a simple annual
  budget-projection record under Organisation.
- **[Low] Deputisation (2.3).** The data model has a "deputy" concept; make sure
  each key role shows its appointed deputy on the organogram.

### 3. Personnel Management — 34 pts · Strong
**Coverage.** Master personnel register, job descriptions/positions,
competency assessments with methods & frequency, training events & attendance,
technical authorisations, ethics declarations, orientation/induction, duty
rosters. This is one of the strongest areas and covers 3.1–3.11, 3.14.
**Gaps.**
- **[Med] Performance appraisals (3.12).** Competency ≠ performance appraisal.
  Add a periodic staff-performance-review record (plan, frequency, outcome).
- **[Low] Personnel meetings (3.13).** Covered by the Meetings module, but add a
  meeting **type = "Personnel meeting"** with the SLIPTA agenda template so the
  evidence is unambiguous.

### 4. Customer Focus — 24 pts · Good
**Coverage.** Stakeholders, service agreements (with POCT scope), feedback
intake with urgency, satisfaction surveys & analytics, communication log
(covers 4.3–4.7, 4.10).
**Gaps.**
- **[High] Advisory services record (4.1–4.2).** No place to document that the
  lab advises clinicians on test choice, interpretation, sample type and
  frequency, or who is authorised to give that advice. Add an "Advisory
  services" register under Customer Focus.
- **[High] Laboratory handbook / user information (4.8).** No handbook artefact
  (hours, test menu, collection instructions, TAT). Add a handbook builder or a
  dedicated handbook document type so users have a single published reference.
- **[Med] Delay/interruption notifications (4.9).** Nowhere to record that users
  were told about downtime, stock-outs or method changes. Link this to the
  Information Management downtime records and Notifications so a
  communicated-to-users record is produced.

### 5. Equipment Management — 44 pts · Strong
**Coverage.** Asset register with unique IDs, receipt/acceptance, verification
on install/after repair, preventive maintenance & service schedules, calibration
with metrological traceability, breakdown → NC/CAPA, defective/obsolete
labelling, return-to-service. Excellent fit to 5.1–5.16.
**Gaps.**
- **[Low] Adverse-incident reporting to manufacturer/authority (5.14).** Capture
  a field on breakdowns for "reported to manufacturer/regulator" with the report
  reference.
- **[Low] Password/adjustment protection attestation (5.16).** Add a checkbox +
  note on equipment records confirming safeguards against unintended
  adjustment.

### 6. Assessments — 24 pts · Good
**Coverage.** Internal-audit programmes, checklists, findings, audit action
plans; risk register with reviews; quality indicators with results. Answers
6.1–6.3, 6.4–6.9. **Note:** in the checklist, **risk management and quality
indicators are scored under Assessments**, while in the software they sit under
Continual Improvement. That's a defensible product choice — but at audit time
the evidence must be found. Consider cross-linking (a risk/QI tab visible from
Assessments) or a report that pulls all of Section 6's evidence together.
**Gaps.**
- **[Med] Risk register breadth (6.5).** SLIPTA expects risks identified across
  ~21 named areas (impartiality, confidentiality, each process phase, etc.).
  Add an "area" taxonomy to the risk register so coverage of all required
  domains is demonstrable.

### 7. Supplier and Inventory Management — 27 pts · Strong
**Coverage.** Approved-supplier list, supplier evaluations/performance reviews,
inventory with lot/batch, expiry monitoring, FEFO, min/max stock, goods-receipt
inspection, expired-stock disposal. Strong fit to 7.1–7.12.
**Gaps.**
- **[Med] Storage-condition checklist (7.9).** The nine-point storage-area
  assessment (cold storage, humidity, ventilation, access control, sunlight) has
  no structured home. Add a periodic storage-area inspection record (this also
  overlaps Facilities & Safety §12).
- **[Low] Recall handling (7.2 g).** Add a "manufacturer recall / field-safety
  notice" record linked to affected lots.

### 8. Process Management — 71 pts · Partial (biggest technical gap)
**Coverage.** IQC (with Levey-Jennings), EQA programmes/events/performance,
method verification & validation, measurement uncertainty, biological-reference
handling on the test catalogue, referral laboratories & send-outs, critical-
result rules & notifications, report amendments, process reviews, specimen
acceptance/rejection criteria. This covers 8.13–8.16, 8.20–8.26 well.
**Gaps.**
- **[High] Contingency / continuity & emergency-preparedness plan (8.1–8.2, 6
  pts).** Nothing in the software. Add a Contingency Plan record set (scenarios:
  personnel, equipment, power, stock-outs, fire/disaster; plus periodic test of
  the plan and effectiveness review). High value, low build cost, and it is a
  frequent audit finding.
- **[High] Pre-examination process (8.3–8.8).** The QMS records rejection and
  acceptance *criteria*, but there is no structured evidence of the pre-exam
  **process itself**: sample-collection instructions, test-request completeness,
  primary-sample receipt/accessioning log, handling/storage, transport
  conditions. Some of this is LIS territory (a true accessioning system), but
  SLIPTA wants the *procedures and monitoring records*. Add a Pre-examination
  area under Process Management: collection-instruction documents, a
  request-quality monitor (missing-data rate), and a sample-receipt/condition
  log feeding the rejection register.
- **[Med] Result comparability across methods/POCT (8.17).** No record of
  periodic comparison when the same test runs on multiple analysers or against
  POCT. Add a comparability-study record.
- **[Med] Biological reference-interval register (8.27).** Reference intervals
  live as free text on the test catalogue. Promote them to a reviewed register
  (source, decision limits, change-communication to users).
- **[Low] Reporting requirements checklist (9.4 overlaps).** Ensure the report
  format captures all 9.4 a–r elements (page x-of-y, revision trail, critical
  flags, referral-lab identification) — mostly a reporting-template concern.

### 9. Information Management — 24 pts · Strong
**Coverage.** Information assets, systems inventory, access reviews, security
incidents, change requests, software releases, LIS validation records,
downtime records, data-correction requests, backups. Strong fit to 9.6–9.10.
**Gaps.**
- **[Low] Report content completeness (9.1–9.4).** As above — a report-format
  conformance checklist would close the loop.
- **[Low] Analytic-system traceability (9.5).** Ensure results can name the
  instrument used when multiple analysers run the same test.

### 10. Nonconforming Event Management — 13 pts · Strong
**Coverage.** NC events with risk grading, root-cause analysis, CAPA with
effectiveness review, halt/recall, requester communication, resumption
authorisation. Full fit to 10.1–10.5. **No material gaps.**

### 11. Continual Improvement — 07 pts · Strong
**Coverage.** Improvement projects, updates, communication, quality indicators.
Full fit to 11.1–11.3. **No material gaps** (ensure improvement outcomes can be
shown as charts — the dashboards now do this).

### 12. Facilities and Safety — 57 pts · Weak (biggest coverage gap)
**Coverage.** Only a **safety-incident log** and environmental monitoring
(temperature/humidity). That answers roughly 12.20–12.21 and part of 12.6/12.9 —
about 7 of 57 points.
**Gaps (this is the priority build).**
- **[High] Safety manual & safety programme (12.1, 12.11, 12.12).** No safety
  manual artefact or programme register.
- **[High] Safety inspections/audits (12.16).** No scheduled safety-audit record
  with findings → CAPA (distinct from quality internal audits).
- **[High] Biosafety-cabinet certification (12.10).** No equipment-safety
  certification register (install/annual recert, certificate labels).
- **[High] Waste disposal (12.13).** No biohazard/sharps waste-disposal log.
- **[High] Hazardous chemicals & SDS (12.14).** No chemical inventory with
  SDS references, segregation and spill measures.
- **[High] Fire safety (12.15).** No extinguisher/alarm inspection register or
  fire-drill records.
- **[High] PPE (12.17–12.18).** No PPE availability/usage register.
- **[High] Vaccination & post-exposure prophylaxis (12.19–12.20).** No
  immunisation / PEP record set (Hep B, declination forms, exposure follow-up).
- **[Med] Facilities adequacy & layout (12.2–12.4, 12.8).** No facility
  assessment (space adequacy, patient/testing separation, storage areas, floor
  plan).
- **[Med] Housekeeping (12.5, 12.9).** No housekeeping/cleaning-disinfection log.
- **[Med] Safety officer & biosecurity (12.23–12.24).** Designate a safety
  officer and hold biosecurity policy/records.

---

## 13. Ghana Accreditation Service FM7.2-05 (2022) — reconciliation

The GAS checklist is a **clause-by-clause checklist of ISO 15189:2022**
(clauses 4 General requirements → 8.9 Management reviews), with columns for the
clause text, where implementation is documented, and remarks. It is the same
standard SLIPTA operationalises, so it confirms — rather than contradicts — the
section findings above. Mapping GAS clauses to the software's sections:

| GAS / ISO 15189:2022 clause group | Software section(s) | Status |
|---|---|---|
| 4 General (impartiality, confidentiality, patients) | Organisation and Leadership; Information Management | Good; **impartiality/COI + confidentiality registers thin** |
| 5 Structural & governance (legal entity, director, activities, structure, objectives, **5.6 risk**) | Organisation and Leadership; Assessments | Good; **legal-entity doc + advisory activities (5.3.3) missing** |
| 6.2 Personnel | Personnel Management | Strong |
| 6.3 Facilities & environmental conditions | Facilities and Safety | **Weak — biggest gap** |
| 6.4 Equipment · 6.5 Calibration & traceability | Equipment Management | Strong |
| 6.6 Reagents & consumables · 6.7 Service agreements · 6.8 External providers | Supplier & Inventory; Customer Focus | Strong / Good |
| 7.1 Risk to patient care | Assessments (risk) | Good |
| 7.2 Pre-examination | Process Management | **Partial — pre-exam process missing** |
| 7.3 Examination (verification, validation, MU, reference intervals, IQC, EQA, comparability) | Process Management | Strong; **7.3.5 reference-interval register, 7.3.7.4 comparability thin** |
| 7.4 Post-examination (reporting, critical results, amendments, sample retention) | Process Management; Information Management | Good; **report-format completeness (7.4.1.6) to verify** |
| 7.5 Nonconforming work | Nonconforming Event Management | Strong |
| 7.6 Data & information management (incl. 7.6.4 downtime, 7.6.5 off-site) | Information Management | Strong |
| 7.7 Complaints | Customer Focus | Strong |
| **7.8 Continuity & emergency preparedness** | Process Management | **Missing** |
| 8.2–8.4 Management-system docs & records | Documents and Records | Strong |
| 8.5 Risks & opportunities · 8.6 Improvement · 8.6.2 feedback | Continual Improvement; Customer Focus | Strong |
| 8.7 Nonconformities & corrective action | Nonconforming Event Management | Strong |
| 8.8 Evaluations (quality indicators, internal audits) | Assessments; Continual Improvement | Good |
| 8.9 Management reviews | Organisation and Leadership | Strong |

**Net:** GAS surfaces the same two priority gaps as SLIPTA — **6.3 Facilities &
environmental conditions** and **7.2 pre-examination + 7.8 continuity** — plus a
few finer clauses (5.3.3 advisory activities, 4.1/4.2 impartiality &
confidentiality records, 7.3.5 reference intervals, 7.3.7.4 comparability)
already listed in the sections above. No change to the plan's priorities.

GAS-specific (Ghana) items to fold into the relevant builds — **captured as
ordinary configurable records, with no regulator named in the UI**:

- **[High] Regulatory registration records.** Facility licensing and
  practitioner registration handled as expiry-tracked credential records
  (same mechanism as personnel licences), configurable to whatever body a
  laboratory answers to.
- **[Med] Waste & radiation compliance.** Waste manifests and (where relevant)
  a radiation-source register inside the Facilities & Safety build.
- **[Med] Data protection.** Information Management access/retention already
  supports consent and data-subject handling; keep it generic.
- **[Low] Report/units conventions.** Report templates remain fully
  configurable so a laboratory can match local expectations itself.

---

## Recommended upgrade plan (phased)

Sequenced by **points-at-risk ÷ build-cost** — biggest accreditation gain first.

### Phase A — Facilities & Safety build-out  *(unlocks ~45 of 57 pts)*
Turn the section from an incident log into a full QSE with these record sets,
each following the existing module pattern (dashboard KPI strip → charts → tabs,
records feeding NC/CAPA and Notifications):
1. Safety manual & safety programme register.
2. Scheduled safety inspections/audits → findings → CAPA.
3. Biosafety-cabinet & safety-equipment certification register.
4. Waste-disposal log (biohazard/sharps, manifests).
5. Hazardous-chemical inventory with SDS + spill measures.
6. Fire-safety register (extinguisher/alarm checks, fire drills).
7. PPE register; vaccination & post-exposure-prophylaxis records.
8. Facility assessment (space/layout/storage) + housekeeping log.
9. Designated safety officer + biosecurity policy.

### Phase B — Process Management pre-examination & continuity  *(unlocks ~12–15 pts)*
1. Contingency / continuity & emergency-preparedness plan (with periodic test).
2. Pre-examination area: collection instructions, request-quality monitor,
   sample-receipt/condition log feeding the rejection register.
3. Result-comparability study record; biological-reference-interval register.

### Phase C — Customer Focus & Organisation completeness  *(unlocks ~8–10 pts)*
1. Advisory-services register + laboratory handbook builder.
2. Delay/interruption user-notification records (link downtime ↔ notifications).
3. Leadership code-of-conduct register; annual budget-projection record.

### Phase D — Cross-cutting polish  *(protects existing points)*
1. Report-format conformance: ensure report templates capture every required
   report element (page x-of-y, revision trail, critical flags, referral-lab
   identification) as configurable template fields.
2. Risk-register "area" taxonomy covering the full set of required domains.
3. Cross-link risk & quality indicators into the Assessments view.
4. Performance-appraisal records; storage-condition inspection; recall handling.
5. Regulatory-registration credential records (generic, configurable per lab).

_(No self-assessment / checklist-scoring layer will be built. The software is
designed so that correct routine use produces conforming records; it does not
grade the laboratory against a checklist inside the product.)_

---

## Bottom line

The software already covers the **management-system and technical-quality**
essentials strongly — Documents, Personnel, Equipment, Supplier/Inventory, IQC/
EQA/verification, Nonconforming events, Information management and Continual
improvement are audit-ready or close. The two things standing between it and a
credible conformance posture are **(1) a real Facilities & Safety module** and
**(2) the pre-examination and continuity pieces of Process Management**. Phase A
alone closes the largest block of gaps.

Both benchmarks — SLIPTA v3:2023 and GAS FM7.2-05 (2022) — have been reconciled
and agree on these priorities. They serve purely as the build specification;
the product itself names no standard and includes no self-assessment layer.
