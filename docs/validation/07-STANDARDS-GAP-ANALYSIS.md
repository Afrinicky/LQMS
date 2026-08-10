# 07 — Standards Gap Analysis

Clause-by-clause conformity of SECH_LIMS 0.1.0 (`dc73f10`) against the standards adopted in
document 01 §3.

**Status key:** ✅ Conforms · ◐ Partial · ✖ Does not conform · N/A Not applicable

A clause is judged **only** on what this software must do. Where a clause is satisfied by
laboratory procedure rather than by software, it is marked ✅ *(procedural)* and the procedure is
named — the software cannot claim the credit, but neither should it be marked down for it.

---

## 1. ISO 15189:2022 — Medical laboratories

| Clause | Requirement | Status | Basis |
|--------|-------------|--------|-------|
| 4.2 | Confidentiality of information | ◐ | Personal-record scoping verified (18 assertions); directory withholds ID and licence data. Undermined by unencrypted storage and transport — VF-01, VF-06, VF-07 |
| 5.2 | Management of the quality system | ✅ | Management review module with one-click input generation across QMS modules |
| 6.2 | Personnel — competence, authorisation, records | ✅ | Personnel module: competency, training, technical authorisations with expiry, duty rosters. Expired authorisations verified to confer nothing (`rbac-check`) |
| 6.3 | Facilities and environmental conditions | ✅ | Facilities & Safety and Environmental Monitoring modules with excursion alerting |
| 6.4–6.5 | Equipment, calibration, metrological traceability | ✅ | Equipment register with calibration and servicing due dates; overdue calibration raised as a critical system-audit flag |
| 6.6 | Reagents and consumables | ✅ | Supplier & Inventory with lot and batch records; IQC links reagent lots |
| 7.3.7.2 | Internal quality control | ✅ | 191 executed assertions: controls, lots, runs, rule-based interpretation, expired lots refused, corrections retain what they replaced |
| 7.3.7.3 | External quality assessment | ✅ | EQA module with events and performance records |
| 7.5 | Nonconformities and corrective action | ✅ | NC/CAPA, complaints, incidents, with cross-module escalation |
| **7.6.1** | Data and information management — general | ✅ | 33 modules; role-scoped access to what each user needs |
| **7.6.2** | Authorities and responsibilities for information systems | ◐ | RBAC is strong and independently verified (48 assertions). But sign-ins are unaudited (VF-03), guessing is unbounded (VF-02) and duties are not separable (VF-24), so the laboratory cannot evidence *who actually had access* |
| **7.6.3** | Information system management — validated before use, protected from unauthorised access, safeguarded against tampering and loss | ◐ | This package supplies the validation. Unauthorised-access protection is partial (VF-01, VF-02, VF-06). Tamper-safeguarding of the audit trail is absent (VF-05) |
| **7.6.4** | Protection against loss; backup | ✅ | **Demonstrated end to end** — backup, loss, restore, verified recovery, audit trail intact, integrity scan clean (PQ, 15/16) |
| 7.7 | Complaints | ✅ | Complaints register with escalation |
| 7.8 | Continuity and emergency preparedness | ◐ | Recovery proven; scheduled backups, retention floor and off-site copying verified. Archive authenticity unprovable (VF-08); off-site copies unencrypted (VF-07) |
| 8.2 | Documentation | ✅ | Document control with versioning, attestations, distribution, watermarked print |
| 8.3 | Control of documents | ✅ | Draft → review → approve → distribute, with electronic signature |
| **8.4** | Control of records | ◐ | Records are attributable, complete and recoverable. Weak on *Original/Enduring*: audit trail alterable at rest (VF-05), timestamps zone-ambiguous (VF-17), retention manual (VF-25) |
| 8.5 | Actions to address risks and opportunities | ✅ | Risk register with matrix scoring |
| 8.7 | Nonconformities and corrective actions | ✅ | Verified through NC/CAPA workflows |
| 8.8 | Evaluations and internal audit | ✅ | Internal assessments with flexible checklist library and printable reports |
| 8.9 | Management review | ✅ | Management review module |

**ISO 15189 verdict:** the laboratory-process clauses conform. The gap is concentrated in
**§7.6.2, §7.6.3 and §8.4** — the clauses about the information system itself, not about the
laboratory's work.

---

## 2. ISO/IEC 17025:2017 — Testing and calibration laboratories

| Clause | Requirement | Status | Basis |
|--------|-------------|--------|-------|
| 7.11.1 | Access to data and information needed | ✅ | Verified through the permission map |
| 7.11.2 | Information system validated for functionality before introduction | ◐ | Satisfied by this package for the first time; **not** satisfied for any previously deployed build (VF-11 means those builds cannot even be identified) |
| 7.11.3(a) | Protected from unauthorised access | ◐ | VF-01, VF-02, VF-06, VF-19 |
| 7.11.3(b) | Safeguarded against tampering and loss | ◐ | Loss: ✅ proven by PQ. Tampering: ✖ VF-05 |
| 7.11.3(c) | Operated in conformance with supplier specification | ◐ | No supplier specification existed to conform to (VF-21) |
| 7.11.3(d) | Maintained to ensure integrity of data and information | ◐ | Data-integrity scan exists and passes; no regression suite protects it through change (VF-09) |
| 7.11.3(e) | Records of system failures and corrective actions | ✅ | Downtime records, system change control, information-security incidents — all present in the Information Management module |
| 7.11.4 | Off-site / externally managed systems conform to requirements | N/A | Cloud sync and remote portal are disabled and excluded (document 03 §4) |
| 7.11.5 | Calculations and data transfers checked appropriately | ✅ | IQC rule evaluation, measurement-uncertainty and TAT calculations exercised by 191 + 31 assertions |
| 8.4 | Control of records | ◐ | As ISO 15189 §8.4 |

---

## 3. 21 CFR Part 11 — Electronic records and signatures

| Section | Requirement | Status | Basis |
|---------|-------------|--------|-------|
| 11.10(a) | Validation of systems to ensure accuracy, reliability and consistent intended performance | ◐ | This package. Ongoing assurance absent (VF-09) |
| 11.10(b) | Ability to generate accurate and complete copies in human-readable and electronic form | ✅ | Export, print, report templates, evidence packs, controlled-copy print logging |
| 11.10(c) | Protection of records to enable accurate and ready retrieval throughout the retention period | ◐ | Retrieval ✅; protection ✖ (VF-05, VF-06) |
| 11.10(d) | Limiting system access to authorised individuals | ◐ | RBAC verified strong; the perimeter is not (VF-01, VF-02, VF-19) |
| 11.10(e) | Secure, computer-generated, time-stamped audit trails; no obscuring of previous entries; retained as long as the record | ◐ | Generated ✅, no edit/delete route ✅, old and new values ✅. **Fails** on security at rest (VF-05), on sign-in events (VF-03) and on timestamp unambiguity (VF-17) |
| 11.10(f) | Operational system checks enforcing sequencing of steps | ✅ | Workflow states enforced (draft→review→approve→…); expired lots refused |
| 11.10(g) | Authority checks — only authorised individuals may use, sign, access, alter | ✅ | 48 RBAC assertions plus OQ-4.3–4.6 |
| 11.10(h) | Device checks on the source of data input | ◐ | Device id and IP captured on sessions and signatures; no device authorisation enforced |
| 11.10(i) | Education, training and experience of persons who develop and use the system | ✅ *(procedural)* | The system records staff competency; developer competence is a supplier-assessment matter (VF-21) |
| 11.10(j) | Written policy holding individuals accountable for their electronic signatures | ✅ *(procedural)* | Laboratory policy required; not a software control |
| 11.10(k) | Controls over systems documentation, including change control and audit trail of changes | ◐ | Change control exists for the *laboratory's* systems as a module; the software's own change control fails on VF-11 and VF-21 |
| 11.50(a) | Signed records show printed name, date and time, and meaning of signature | ✅ | Verified OQ-6.2 |
| 11.50(b) | Those items subject to the same controls as the record and included in any copy | ✅ | Stored in `e_signatures`, travels in exports and backups |
| 11.70 | Signature/record linking so signatures cannot be excised, copied or transferred | ◐ | Linked by (module, type, id) ✅; not cryptographically bound to content ✖ (VF-13) |
| 11.100(a) | Signatures unique to one individual, not reused or reassigned | ✅ | Unique usernames; accounts deactivated rather than deleted where referenced |
| 11.100(b) | Identity verified before assigning a signature | ✅ *(procedural)* | Administrator-mediated account creation |
| 11.200(a)(1)(i) | First signing of a session uses all components | ✖ | Session sign-in, then signing with no component — VF-04 |
| 11.200(a)(1)(ii) | Subsequent signings re-enter at least one component | ✖ | VF-04 |
| 11.200(a)(2) | Used only by their genuine owners | ◐ | Undermined by VF-04 and VF-18 |
| 11.200(a)(3) | Attempted use by anyone else requires collaboration of two or more individuals | ✖ | A single unattended session is sufficient — VF-04 |
| 11.300(a) | Uniqueness of each combined identification code and password | ✅ | Unique username constraint |
| 11.300(b) | Periodic checking, recall and revision of credentials | ◐ | Administrator reset, forced change and approval-based self-service reset exist; no expiry or periodic revision (VF-19) |
| 11.300(c) | Loss management for compromised credentials | ✅ | Reset revokes all sessions; approval-gated self-service reset with throttling |
| 11.300(d) | Transaction safeguards to detect unauthorised use and report it to management | ✖ | VF-02 and VF-03: unlimited attempts, no record, no alert |
| 11.300(e) | Testing of devices bearing identification codes | N/A | No hardware tokens |

**Part 11 verdict:** the **electronic record** provisions are close — mostly ◐, closable by
VF-03, VF-05, VF-17. The **electronic signature** provisions of Subpart C are **not met**, and
VF-04 is the reason. Until it is closed, signatures in SECH_LIMS should be described in the
laboratory's procedures as *system-recorded approvals*, not as Part 11-compliant electronic
signatures.

---

## 4. EU GMP Annex 11 — Computerised systems

| § | Requirement | Status | Basis |
|---|-------------|--------|-------|
| 1 | Risk management across the lifecycle | ◐ | Document 03 supplies it now; not previously performed |
| 2 | Personnel — defined responsibilities, segregation of duties | ◐ | VF-24 |
| 3 | Suppliers and service providers — assessment, audit | ✖ | No supplier assessment of Nickland (VF-21) |
| 4.1–4.4 | Validation documentation, up-to-date specifications, inventory | ◐ | Supplied here; VF-11 breaks the tie between a specification and a deployed build |
| 4.5 | Data transfer validation between systems | N/A | No live integrations; LHIMS data enters by reviewed import with mapping rules and exception review |
| 5 | Data — built-in checks for correct and secure entry | ✅ | Validation on entry, workflow state checks, exception review on imports |
| 6 | Accuracy checks for critical data | ✅ | Data-integrity scan; IQC rule evaluation; import exception review |
| 7.1 | Data protected by physical and electronic means | ◐ | Electronic: partial (VF-06). Physical: laboratory responsibility |
| 7.2 | Regular backups; **integrity and accuracy of backup data checked** | ◐ | Backups ✅ and recovery proven ✅; integrity checking ✖ (VF-08) |
| 8 | Printouts — clear indication of altered data | ◐ | Controlled-copy printing with watermarking and job logging; no "altered since signing" indicator (VF-13) |
| 9 | Audit trails for GMP-relevant changes and deletions | ◐ | Present and permission-controlled; not tamper-evident (VF-05); excludes sign-ins (VF-03) |
| 10 | Change and configuration management | ◐ | VF-11, VF-21, VF-22 |
| 11 | Periodic evaluation | ✅ | Document 09 establishes it |
| 12.1 | Physical and logical access controls; access restricted to authorised persons | ◐ | VF-01, VF-02 |
| 12.2 | Management of identity creation, change and cancellation | ✅ | 37 assertions; deactivation ends live sessions (OQ-4.8) |
| 12.3 | Access control including inactivity logout | ✖ | VF-18 |
| 12.4 | Management systems record who entered or changed data, and when | ◐ | Data changes ✅; access events ✖ (VF-03) |
| 13 | Incident management | ✅ | Information-security incidents, downtime records, NC/CAPA escalation |
| 14 | Electronic signature | ✖ | VF-04, VF-13 |
| 15 | Batch release | N/A | Not a manufacturing system |
| 16 | Business continuity | ✅ | **Proven by PQ**; scheduled backups with retention floor and off-site copying |
| 17 | Archiving — data readable and integrity checked after change | ◐ | Central archive present; no integrity check on archived data (VF-08) |

---

## 5. ISO/IEC 27001:2022 — Annex A controls (relevant subset)

| Control | Status | Basis |
|---------|--------|-------|
| A.5.15 Access control | ✅ | Verified RBAC |
| A.5.16 Identity management | ✅ | Account lifecycle, 37 assertions |
| A.5.17 Authentication information | ✖ | VF-02, VF-19, VF-20 |
| A.5.18 Access rights (provision, review, removal) | ◐ | Removal verified ✅; access-review module exists; review is not enforced (VF-24) |
| A.5.3 Segregation of duties | ✖ | VF-24 |
| A.8.3 Information access restriction | ✅ | Permission map omits what a user may not see |
| A.8.5 Secure authentication | ✖ | VF-02, VF-19 |
| A.8.7 Protection against malware | N/A | Host operating-system responsibility |
| A.8.8 Management of technical vulnerabilities | ✖ | VF-10 |
| A.8.13 Information backup | ◐ | Backups and recovery ✅; encryption and integrity checking ✖ (VF-07, VF-08) |
| A.8.15 Logging | ✖ | VF-03 |
| A.8.16 Monitoring activities | ◐ | Health endpoint and system-audit scanning; no security monitoring |
| A.8.19 Software installation on operational systems | ✖ | VF-12 |
| A.8.23 Web filtering / origin control | ✖ | VF-16 |
| A.8.24 Use of cryptography | ✖ | VF-01, VF-06, VF-07, VF-20 |
| A.8.25 Secure development lifecycle | ◐ | VF-09, VF-21, VF-22 |
| A.8.26 Application security requirements | ◐ | Injection and traversal defences verified ✅; headers absent (VF-15) |
| A.8.28 Secure coding | ✅ | Parameterised SQL throughout; dynamic SQL only from internal registries, never from request data; bcrypt cost 12 |
| A.8.30 Outsourced development | ✖ | No supplier assessment (VF-21) |

---

## 6. ISO/IEC 25010:2023 — Product quality

| Characteristic | Assessment |
|----------------|------------|
| **Functional suitability** | **Strong.** 664 executed and witnessed test outcomes, none failed. 33 modules covering the ISO 15189 quality domains |
| **Performance efficiency** | **Adequate, unmeasured.** Code-split renderer (344 KB main chunk); synchronous SQLite suits a single host. No load or volume testing performed — the permission resolver recomputes every grant on every request, which is untested at multi-client scale |
| **Compatibility** | **Adequate.** Clean REST seam; deliberate non-integration with LHIMS/Lightwave avoids coupling |
| **Interaction capability** | **Not assessed.** No usability testing was in scope; no accessibility evaluation exists |
| **Reliability** | **Good.** Survived malformed and hostile input; recovered fully from simulated data loss; schedulers self-gate and fail loudly without becoming fatal |
| **Security** | **Weakest characteristic.** Authorisation is genuinely well built; authentication, cryptography and logging are not (VF-01 to VF-07, VF-15 to VF-20) |
| **Maintainability** | **Mixed.** Clear module boundaries, a single permission decision point, unusually good explanatory comments — against a 5,217-line `database.ts`, a 2,300-line `common.ts`, and no automated tests (VF-09) |
| **Flexibility** | **Good.** Configuration entirely by environment variable; `DataStore` seam allows a PostgreSQL backend without rewriting business logic |
| **Safety** | **N/A by design.** No patient result is produced or reported |

---

## 7. Lifecycle and testing standards

| Standard | Assessment |
|----------|------------|
| **ISO/IEC/IEEE 12207:2017** | Implementation and integration processes are evident and disciplined. Missing: requirements definition (VF-21), verification as a defined process (VF-09), configuration management (VF-11) |
| **ISO/IEC/IEEE 29119** | Test documentation and design now exist for the first time in this package. Test execution remains manual and partial (VF-09, VF-22, VF-23) |
| **ISO 14971:2019** | Applied by analogy in document 03. No prior risk file existed |
| **GAMP 5 (2nd ed.)** | Category 5 correctly identified. Retrospective validation route used and documented. Supplier assessment outstanding (VF-21) |
| **IEC 62304 / IEC 82304-1 / ISO 81001-1** | **Not applicable** — the system is not medical-device software (document 01 §2.2). Used as good-practice reference; the software-maintenance and problem-resolution processes of 62304 §6 and §9 are the model for document 09 |
| **CLSI AUTO11** | Authentication, encryption and audit-logging expectations for laboratory software: partially met — same gaps as ISO 27001 above |
| **ISO 22301:2019** | **Met.** Recovery demonstrated end to end with a defined recovery point and a proven procedure |
| **Ghana Data Protection Act 2012 (Act 843)** | §28 (security safeguards) **not met** for staff personal data: no encryption in transit or at rest, unencrypted off-site copies (VF-01, VF-06, VF-07). Data minimisation is well handled — patient data is excluded by design and the staff directory withholds ID and licence detail |

---

## 8. Summary

| Standard | Conforms | Partial | Does not conform | N/A |
|----------|----------|---------|------------------|-----|
| ISO 15189:2022 | 16 | 6 | 0 | 0 |
| ISO/IEC 17025:2017 | 2 | 7 | 0 | 1 |
| 21 CFR Part 11 | 7 | 10 | 5 | 2 |
| EU GMP Annex 11 | 6 | 10 | 3 | 2 |
| ISO/IEC 27001:2022 (subset) | 4 | 6 | 8 | 2 |

The shape of this result is consistent across every framework: **what the laboratory does with
the system conforms; what protects the system does not yet.** No standard is failed on
functional grounds. Every non-conformity traces to one of eight P1 findings and clusters into
four themes — transport and storage encryption, credential protection, security logging, and
signature identity.
