# Remote Staff Portal — Design & Implementation Plan

> **Status: PLAN ONLY — no implementation yet.** This evolves the current
> read-only cloud portal (`portal/` + `api/cloud/`, see `docs/CLOUD_SYNC.md`) into
> a role-based Remote Staff Portal. It is for review before any code is written.
>
> Four decisions are still open (§13). This document adopts the **recommended
> defaults** so the design is concrete, and marks them **(pending confirmation)**.

---

## 1. Guiding principles

1. **The Host stays authoritative.** The Host PC + its SQLite database is the
   single system of record. The cloud never becomes the source of truth.
2. **Propose, don't write.** The portal never writes to authoritative data or even
   to the cloud read model (`synced_records`). Remote edits become **submissions**
   the Host validates and applies. This makes remote editing safe *and* keeps it
   working while the Host is briefly offline (submissions queue in Neon, apply on
   reconnect).
3. **Default deny.** Anything not explicitly classified as remote-permitted is
   LAN/Full-only.
4. **Reuse the existing RBAC — don't fork it.** Effective remote permission =
   *Host permission* **AND** *feature tier allows remote* **AND** *staff is
   remote-enabled* **AND** *section scope / technical authorization matches*. The
   cloud can only ever be a **subset** of what a person can already do on the Host.
5. **No patient/clinical data in the cloud.** SECH_LIMS is a QMS, not a results
   system. Staff PII is handled per the data-protection decision (§11, §13).

---

## 2. Feature classification

Tiers: **V** = Remote View Only · **E** = Remote Editable (auto-applied after Host
validation) · **A** = Editable with Approval (remote proposal → authorized
approval → applied) · **L** = LAN/Full LIMS Only.

| Module | Tier(s) | What's remote vs not |
|---|---|---|
| Home / My Work | V + E | View personalized work; act on items via their own modules |
| Main Dashboard | V | Aggregated metrics, read-only |
| Documents & Records | V + E + A + L | **V** read current SOPs/policies; **E** SOP acknowledgement/attestation; **A** document review/approve; **L** authoring, versioning, Office round-trip, publishing |
| Personnel Management | E + A + L | **E** own profile fields, self-log training attendance; **A** competency sign-off, authorizations, **leave requests** (new, §4); **L** staff/position admin |
| Action Tracker | E + A | **E** update *own assigned* actions (progress, notes, evidence); **A** verify/close others' actions, create outside own scope |
| Nonconforming Events & CAPA | E + A | **E** report an NC, post CAPA progress updates + evidence; **A** NC disposition, CAPA verification/closure/effectiveness |
| Complaints Register | E + A | **E** log a complaint; **A** investigation, root cause, closure |
| Risk Register | V + A | **V** read; **A** propose new risk / mitigation / rescoring; review & closure |
| Customer Focus | V + E + L | **V** read; **E** log feedback; **L** service agreements, survey config |
| Equipment Management | V + E + A + L | **V** read; **E** log maintenance performed, report breakdown; **A** calibration/verification review, adverse-event closure; **L** master data, decommission, device profiles |
| Internal Assessments | A + L | **A** capture assigned checklist responses; **L** audit programme setup/config |
| Supplier & Inventory | V + E + A + L | **V** stock levels; **E** **inventory request** (new, §4); **A** issue/receipt approval; **L** supplier master, batch acceptance |
| Environmental Monitoring | V + E + A + L | **V** read logs; **E** record manual readings; **A** excursion review/sign-off; **L** monitoring-item config, device integrations |
| Facilities & Safety | E + A | **E** report a safety incident; **A** investigation & closure |
| IQC Management | V + A + L | **V** read; **A** manual IQC result entry (needs review); **L** instrument-linked entry, config |
| EQA Management | V + A + L | **V** read; **A** record EQA submission/results; **L** programme config |
| Method & Equipment Verification | V + A + L | **V** read; **A** record experiments/outcomes; **L** approval, config |
| Measurement Uncertainty | V + A + L | **V** read; **A** budget entry; **L** config |
| POCT Oversight | V + E + A + L | **V** read; **E** field QC entry, incident report at a site; **A** monthly review sign-off; **L** device/operator authorization, config |
| Quality Indicators | V + A + L | **V** read; **A** periodic data entry; **L** indicator config |
| Continual Improvement | V + A | **V** read; **A** project updates/outcomes |
| Meetings & Minutes | V + A + L | **V** read minutes; **A** attendance/action items; **L** minutes authoring |
| Management Review | V + L | **V** read outputs; **L** inputs/authoring/sign-off |
| Records, Reports & Evidence | V + E + L | **V**/export reports; **E** attach evidence to assigned items; **L** retention/archive admin |
| Notifications & Review Calendar | V + E | **V** feed; **E** acknowledge/mark-read/complete assigned tasks |
| Organisation & Leadership | V + L | **V** read policies/objectives/org chart; **L** all editing |
| Process Management | V + L | **V** read; **L** process mapping/config |
| Information Management | V + L | **V** read; **L** data governance/config |
| Monthly Reports & LHIMS Archive | V + L | **V** read reports; **L** LHIMS import (host-side files) |
| Blood Bank Handover | L | On-site, safety-critical shift handover — Host only |
| Dennis (AI) | L (→ V later) | Runs on the Host (engine/Ollama); expose read of outputs later |
| Settings | L | Users, roles, permissions, modules, backups, devices, lab profile — **never** remote |

---

## 3. Editable-over-cloud vs not — summary

- **Directly editable remotely (auto-apply after Host re-validation):** SOP
  acknowledgements · own-profile fields · self-logged training attendance · own
  assigned task/action updates + evidence · incident/NC reporting (create) · CAPA
  progress updates · manual environmental readings · equipment maintenance logs &
  breakdown reports · POCT field QC/incident capture · feedback logging ·
  notification/task acknowledgement · evidence attachment.
- **Editable only with approval:** NC disposition · CAPA verification/closure/
  effectiveness · risk scoring/closure · IQC/EQA acceptance · calibration/method
  verification sign-off · competency sign-off · document review/approval ·
  meeting/quality-indicator entries · leave · inventory issue.
- **Never remote (LAN/Full only):** all configuration & administration (Settings,
  RBAC, module/org/process config, approval-route setup), device/instrument/
  printer integrations, document authoring/Office round-trip, backups/restore,
  data imports, and blood-bank handover.

**Rule of thumb:** *field capture and self-service = Editable; anything that
closes, disposes, verifies, scores, or configures = Approval or LAN.*

---

## 4. Two new capabilities the requested activities imply

Added on both Host and portal:
- **Leave management** — `leave_requests` (staff, type, dates, reason, status):
  request remotely, manager approves (Approval tier).
- **Inventory requests** — `inventory_requests` (item, qty, section,
  justification): request remotely, stores issues/approves (Approval tier).

---

## 5. RBAC model (remote overlay on the existing engine)

- **Identity reuse:** roles, positions, `permissions` matrix,
  `technical_authorizations`, section scope stay on the Host and remain
  authoritative.
- **Remote overlay (new):**
  - `staff.remote_enabled` — opt-in per person, set on the Host.
  - `remote_scope` — subset of modules/activities allowed remotely (defaults from
    role, editable by admin).
  - **Feature-tier table** (module, action → tier + remote_allowed) encodes §2.
- **Effective remote permission** (evaluated on the cloud API for UX and
  **authoritatively re-checked on the Host** before applying):
  `hostGrants(module,action) ∧ tier.remoteAllowed ∧ staff.remote_enabled ∧
  sectionScopeOK ∧ technicalAuthOK`.
- The cloud can never exceed Host permissions.

---

## 6. Authentication — **Password + optional MFA (pending confirmation)**

- Cloud identities are **separate from Host logins**. The Host provisions a cloud
  account per remote-enabled staff into Neon `cloud_users` (staff_id, email,
  **cloud-specific** password hash [argon2/bcrypt], role & scope snapshot, status,
  optional MFA secret). Host password hashes are **never** copied to the cloud.
- **Login:** email + password (+ optional TOTP) → short-lived **JWT** (30–60 min)
  with claims (staff_id, roles, remote_scope, section); refresh-token rotation;
  HTTPS-only; CSRF protection; rate-limiting + lockout.
- **Provisioning/reset:** Host admin enables remote access → creates the account
  with a temporary password or invite (email delivery not yet wired — §13).
- **JWT signing secret** shared between the cloud API and Host; rotatable.

---

## 7. Approval workflows — **Remote approval allowed for authorized approvers (pending confirmation)**

- Reuse existing `approval_routes` / `approval_route_steps` (module-scoped).
- An approval-tier submission → Host creates the target record in a **pending
  state** and enters its approval route; approvers are notified.
- Approvers act on the Host, or **remotely** if that approver is remote-enabled for
  the approve action (approval is itself a tiered, audited action).
- Outcome (approved/rejected + reason) is audited and synced back to the portal.
- **Optimistic concurrency:** each edit submission carries the `base_version`
  (uuid + updated_at) of the record read; the Host rejects/flags if the record
  changed since — no silent overwrites.

---

## 8. Audit logging

- Every remote action → Host `audit_logs` with `source='remote_portal'`, actor
  staff_id, cloud session id, IP, device, module/action, old/new value, submission
  id, approval decision. The Host audit remains the authoritative, complete trail.
- Cloud-side append-only `cloud_audit` records auth events (login, failed login,
  token issue, submission receipt) for security monitoring; reconciled with Host.

---

## 9. Synchronization strategy (Host ↔ Neon ↔ Portal)

**Read path (exists):** Host `push` → `synced_records` (read model) → portal `GET`.

**Write path (new inbound queue):**
1. Portal (authenticated) → cloud API validates JWT + tier → **INSERT into Neon
   `remote_submissions`** (uuid, actor, module, action, target_uuid, base_version,
   payload, needs_approval, status=`pending_sync`).
2. Host sync engine each cycle **pulls** new submissions.
3. Host **re-validates** (actor still remote-enabled; RBAC/tier/section/tech-auth;
   optimistic concurrency).
4. **Auto-apply tier** → apply via DataStore, audit, status=`applied`. **Approval
   tier** → create pending record + enter approval route, status=`awaiting_
   approval` → on approval, apply. **Invalid/denied/conflict** → status=`rejected`
   + reason.
5. Host writes the outcome back; the affected record re-replicates via
   `synced_records`, so the portal shows the result.

**Guarantees:**
- **Offline Host:** submissions queue in Neon; portal shows "submitted — pending
  host processing"; applied on reconnect.
- **Least privilege:** the portal API's cloud DB role can **INSERT
  `remote_submissions`** and **SELECT `synced_records`** only — it **cannot**
  modify `synced_records`. The Host uses a separate privileged role.
- **Idempotency:** submission uuid + processed marker prevents double-apply.
- The portal never writes authoritative data directly.

---

## 10. Data-model additions

- **Neon:** `cloud_users`, `remote_submissions`, `cloud_audit` (+ existing
  `synced_records`); two DB roles (portal-limited, host-privileged).
- **Host:** `staff.remote_enabled` + `remote_scope`, feature-tier table, submission
  processed-log; reuse `audit_logs`, `approval_routes`.
- **New feature tables:** `leave_requests`, `inventory_requests`.

---

## 11. Security & data protection

TLS everywhere; JWT expiry + rotation; optional MFA; rate-limiting/lockout; input
validation & schema allowlists; least-privilege cloud roles; secrets in env only;
full audit. **Data protection — minimize PII in cloud (pending confirmation):**
replicate only references/IDs and non-sensitive fields for personnel; keep full
personal data on the Host; document region + retention.

---

## 12. Phased implementation plan

Each phase: schema → Host reconciliation → cloud API → portal UI → tests → docs.
Every phase ships independently and stays off/opt-in until enabled.

- **R0 — Foundations:** finalize classification & tier table; threat model;
  data-protection sign-off.
- **R1 — Cloud identity & auth:** `cloud_users`, Host provisioning, login + JWT
  (+ optional MFA).
- **R2 — Remote RBAC + tier engine** (authoritative on Host, mirrored to cloud).
- **R3 — Inbound submissions + auto-apply**, starting low-risk: **SOP
  acknowledgement, task update, profile fields.**
- **R4 — Approval workflows:** **incident/NC reporting → disposition; CAPA updates
  → closure.**
- **R5 — New modules:** Leave, Inventory Requests.
- **R6 — Field capture** (environmental readings, equipment logs, POCT QC) with
  **offline queueing in the PWA.**
- **R7 — Audit, security monitoring, Host "Remote Access" admin console.**
- **R8 — Hardening:** rate limits, secret rotation, pen-test, data-protection
  review.

---

## 13. Open decisions (recommended defaults adopted above, pending confirmation)

1. **Authentication:** Password + optional MFA *(recommended)* · Magic-link/email
   OTP (needs SMTP) · SSO (external IdP).
2. **Approvals:** Remote approval for authorized approvers *(recommended)* · Host-
   only approvals.
3. **MVP scope:** Self-service (profile, SOP ack, tasks, notifications)
   *(recommended first)* · Incident & CAPA · Field capture · Leave & inventory.
4. **PII in cloud:** Minimize *(recommended)* · Full replication + documented DPA ·
   Decide later.

Once confirmed, implementation begins at **R0 → R1**, checking back before
expanding scope.
