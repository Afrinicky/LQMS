# 06 — Deviations and Findings Register

**25 findings** from the validation of SECH_LIMS 0.1.0 (`dc73f10`).

| Priority | Count | Meaning |
|----------|-------|---------|
| **P1 — Critical** | 8 | Must be closed, or covered by an accepted written control, before the system is used outside the restricted configuration in document 08 |
| **P2 — Major** | 12 | Must be scheduled and closed within the first review cycle |
| **P3 — Minor** | 5 | Close as convenient; track to completion |

**No finding is a broken function.** Every one is a control the standards require that the build
does not implement, or a lifecycle practice that is missing. That distinction is the reason the
release decision in document 08 is *conditional* rather than *rejected*.

Evidence type: **E** = executed against the running system · **I** = established by source
inspection.

---

## P1 — Critical

### VF-01 · No transport encryption
**Requirement:** URS-SEC-01 · **Risk:** R-03 · **Evidence:** E (OQ-1.3)
**Clauses:** ISO 27001:2022 A.8.24 · Annex 11 §12.1 · ISO 15189:2022 §7.6.2 · CLSI AUTO11

The host serves plain HTTP with no TLS listener. In the default loopback configuration this is
contained. The moment `SECH_LIMS_API_HOST=0.0.0.0` is set to serve desktop clients or the mobile
PWA — which the product documentation instructs administrators to do — every password and every
quality record crosses the hospital network in clear text, readable by anything on that network.

**Corrective action:** terminate TLS in front of the host (a reverse proxy with an internal CA
certificate is sufficient on a LAN) and refuse plain HTTP on any non-loopback bind. Owner:
supplier with hospital IT.
**Interim control:** do not enable hybrid/LAN mode. Run single-host only.

### VF-02 · No protection against password guessing
**Requirement:** URS-SEC-05 · **Risk:** R-02 · **Evidence:** E (OQ-3.6)
**Clauses:** 21 CFR 11.300(d) · ISO 27001:2022 A.5.17 · Annex 11 §12.3

Twenty-five consecutive failed sign-ins produced no lockout, no throttling, no delay and no
alert; the correct password then succeeded normally. Part 11 §11.300(d) requires exactly the
opposite: transaction safeguards that detect unauthorised use and report it to management.
Compounded by VF-03 — the attempts leave no trace at all.

**Corrective action:** progressive delay then temporary lockout on consecutive failures per
account and per source address; raise a security notification to administrators.
**Interim control:** none available in software. Restrict network reach of the host.

### VF-03 · Authentication events are not audited
**Requirement:** URS-AUD-06 · **Risk:** R-08 · **Evidence:** E (OQ-5.5)
**Clauses:** 21 CFR 11.10(e) · Annex 11 §12.4 · ISO 27001:2022 A.8.15 · ISO 15189 §7.6.3

`routes/auth.ts` writes no audit entry on successful or failed sign-in. Password changes and
resets are audited; the act of gaining access is not. An access review — which ISO 15189 §7.6.2
requires the laboratory to perform, and which this system provides a *module* for — cannot be
answered from the system's own records: who signed in, when, from where, and how many times
someone failed first.

**Corrective action:** audit `login_success`, `login_failed` and `logout` with username, IP and
device. Two lines in the existing `audit()` service.
**Interim control:** none.

### VF-04 · Electronic signatures require no re-authentication
**Requirement:** URS-SIG-05 · **Risk:** R-09 · **Evidence:** E (OQ-6.5)
**Clauses:** 21 CFR 11.200(a)(1)(ii) · Annex 11 §14(b)

A signature is applied on the strength of the session bearer token alone. Part 11 requires that
signings within a continuous session re-enter at least one signature component — in practice,
the password. As built, anyone reaching an unattended signed-in workstation can apply another
person's legally binding approval to a CAPA, a document release or a competency sign-off.
Aggravated by VF-18 (no inactivity timeout) and VF-03 (the session's origin is not audited).

**Corrective action:** require password re-entry at the point of signing; record on the
signature that the component was re-entered.
**Interim control:** enforce workstation locking procedurally, and treat signatures as
supported-by-procedure rather than as Part 11-compliant, until closed.

### VF-05 · The audit trail is not tamper-evident
**Requirement:** URS-AUD-09 · **Risk:** R-07 · **Evidence:** I (OQ-5.8)
**Clauses:** 21 CFR 11.10(c),(e) · Annex 11 §9 · ISO 15189 §7.6.3 · ALCOA+ (Original, Enduring)

`audit_logs` is an ordinary writable SQLite table: no hash chain, no signature, no append-only
trigger, no write-once medium. The application exposes no route that alters it — **OQ-5.7
confirmed that, and it is a real strength** — but anyone with file access to `sech_lims.sqlite`,
which is the same set of people who administer the host, can rewrite history and leave no sign
of it.

**Corrective action:** chain each entry to the hash of its predecessor and verify the chain in
the data-integrity scan; alternatively write the trail to append-only external storage.
**Interim control:** restrict host administrator accounts to named individuals; review the trail
at a defined frequency using the Records & Reports audit-review workflow the system already
provides.

### VF-06 · The database is not encrypted at rest
**Requirement:** URS-DAT-07 · **Risk:** R-16 · **Evidence:** I (OQ-7.8)
**Clauses:** ISO 27001:2022 A.8.24 · Ghana Data Protection Act 2012 §28 · Annex 11 §7.1

`sech_lims.sqlite` is a plain file. It carries staff personal data — names, employee numbers,
contact details, occupational-health and competency records. Anyone with file access, or anyone
holding a stolen host machine, reads all of it without ever authenticating to the application.

**Corrective action:** SQLCipher, or full-disk encryption on the host with a documented key
custody procedure.
**Interim control:** BitLocker on the host; physical security of the host machine; document both
in the laboratory's information-security procedure.

### VF-07 · Backups are unencrypted, including off-site copies
**Requirement:** URS-DAT-06 · **Risk:** R-15 · **Evidence:** I (OQ-7.7)
**Clauses:** ISO 27001:2022 A.8.24, A.8.13 · Act 843 §28 · Annex 11 §7.2

Backup packages are plain ZIPs containing the complete database, uploads and evidence. The
off-site feature copies them to Google Drive or S3 as they are. The laboratory's entire quality
record, including staff personal data, leaves the building unencrypted — the single largest
concentration of exposure in the system.

**Corrective action:** encrypt the package before it is written, with laboratory-held keys and a
documented recovery procedure; never rely on the destination provider's encryption alone.
**Interim control:** disable off-site copying until closed, or restrict destinations to an
encrypted volume under the laboratory's control.

### VF-08 · Backup integrity cannot be proven
**Requirements:** URS-DAT-04 · **Risk:** R-13 · **Evidence:** E (OQ-7.4, PQ-5.3)
**Clauses:** Annex 11 §7.2 ("backups checked for accuracy and completeness") · ISO 27001 A.8.13

No checksum is stored with a package and none is computed before a restore. The restore
validates that the ZIP opens — not that it is the archive the laboratory took. A silently
corrupted or substituted archive would be restored over live data, and the pre-restore safety
snapshot would then be the only surviving copy of the good state.

**Corrective action:** compute and store a SHA-256 digest at backup time; verify it before
restore and refuse a mismatch; record the verification in `backup_restore_checks`.
**Interim control:** verify each package manually after creation and record the result in the
existing backup-check register.

---

## P2 — Major

### VF-09 · No automated regression test suite
**Requirement:** URS-LC-01 · **Risk:** R-30 · **Evidence:** E (OQ-9.1)
**Clauses:** ISO/IEC/IEEE 29119 · GAMP 5 §7 · IEC 62304 §5.5–5.7 (reference)

No test framework is declared and there is no `test` script. Verification rests on twelve
hand-written scripts that must each be run against a manually started host — 587 assertions of
real value, but exercised only when someone remembers, in an order that is not documented
(VF-23). A regression in any module without a script is caught by nobody.

**Corrective action:** adopt a runner (Vitest fits the stack), convert the existing scripts to
it, and require green before merge.

### VF-10 · Known vulnerabilities in third-party components
**Requirement:** URS-LC-05 · **Risk:** R-28 · **Evidence:** E (OQ-9.5, IQ-6)
**Clauses:** ISO 27001:2022 A.8.8 · CLSI AUTO11

`npm audit` reports 45 advisories at the validated commit: 1 critical, 36 high, 6 moderate, 2
low. Runtime-reachable: `xlsx` (prototype pollution and ReDoS, no fixed release published —
reached by every CSV/XLSX import path), `multer` (denial of service on upload), `adm-zip`
(crafted-ZIP memory exhaustion — reached by the restore-from-upload path), `react-router`,
`electron`. The remainder are build-time only.

**Corrective action:** replace `xlsx` with a maintained parser; upgrade `multer`, `adm-zip`,
`react-router` and `electron`; add `npm audit` to CI with a failure threshold; define a
dependency-review cadence.

### VF-11 · The release version is not controlled
**Requirement:** URS-LC-02 · **Risk:** R-27 · **Evidence:** E (OQ-9.2)
**Clauses:** Annex 11 §4.3 · ISO/IEC/IEEE 12207 §6.3.5 · GAMP 5 configuration management

`package.json` has read `0.1.0` since the foundation MVP, across every phase and every
installer. The installer file name, the About screen and any software-release record the
laboratory writes all carry the same number. It is therefore impossible to state which build a
given installation is running, which defeats change control and makes this validation
untraceable to a deployed system.

**Corrective action:** adopt semantic versioning, bump on every release, and embed the commit
hash and build date in `/system/about`.

### VF-12 · The installer is unsigned
**Requirement:** URS-LC-04 · **Risk:** R-29 · **Evidence:** I (OQ-9.4)
**Clauses:** ISO 27001:2022 A.8.19, A.8.30

`electron-builder` runs with no code-signing certificate. Windows SmartScreen warns on every
install, which trains staff to dismiss the warning, and the laboratory cannot demonstrate that
the installer it ran is the one the supplier built.

**Corrective action:** obtain a code-signing certificate and sign the NSIS output; publish
SHA-256 digests alongside releases.

### VF-13 · Signatures are not bound to the content signed
**Requirement:** URS-SIG-06 · **Risk:** R-10 · **Evidence:** I (OQ-6.6)
**Clauses:** 21 CFR 11.70 · Annex 11 §14

`e_signatures` records who, when, why and against which record — but no hash of the record as it
stood. If the record is edited afterwards the signature still appears valid, so it cannot
demonstrate what was actually approved. Part 11 §11.70 requires signatures to be linked to their
records so they cannot be excised, copied or transferred.

**Corrective action:** store a SHA-256 of the canonical signed content on the signature, and
show "content changed since signing" wherever a signature is displayed.

### VF-16 · Cross-origin policy accepts any origin with credentials
**Requirement:** URS-SEC-17 · **Risk:** R-20 · **Evidence:** E (OQ-8.6)
**Clauses:** ISO 27001:2022 A.8.23

`cors({ origin: true, credentials: true })` reflects whatever `Origin` a caller sends. On a
loopback-only host the exposure is limited; on a LAN-exposed host it removes the browser's
same-origin protection for any page a member of staff opens.

**Corrective action:** allow-list the host's own origins and the configured LAN client URLs.

### VF-18 · Sessions have no inactivity timeout
**Requirement:** URS-SEC-09 · **Risk:** R-21 · **Evidence:** E (OQ-3.10)
**Clauses:** Annex 11 §12.3 · ISO 27001:2022 A.8.1

Sessions carry a fixed 12-hour absolute expiry from issue. A workstation left signed in at the
start of a shift stays usable for the rest of it. In a laboratory with shared benches this is
the ordinary case, not the exception — and it is what makes VF-04 dangerous rather than
theoretical.

**Corrective action:** add a configurable inactivity timeout (15–30 minutes is usual) alongside
the absolute expiry.

### VF-19 · Password policy is length-only
**Requirement:** URS-SEC-06 · **Risk:** R-01 · **Evidence:** E (OQ-3.7)
**Clauses:** 21 CFR 11.300(b) · ISO 27001:2022 A.5.17

Eight characters is the whole rule. The literal password `password` was accepted for a new
account. There is no composition rule, no dictionary or breach check, no reuse history and no
expiry. With VF-02 (unlimited guessing) this is the most reachable route into the system.

**Corrective action:** enforce a policy — length ≥ 12, a breached-password check, reuse history
— and apply it at creation, at administrator reset and at self-service change alike.

### VF-20 · Session tokens are stored in reusable form
**Requirement:** URS-SEC-18 · **Risk:** R-01 · **Evidence:** I
**Clauses:** ISO 27001:2022 A.8.24 · Annex 11 §12.1

Tokens are 32 bytes of CSPRNG output — good entropy — but stored verbatim in `auth_sessions` and
kept by the client in `localStorage`. Read access to the database (see VF-06) yields live
sessions for every signed-in user; any script injected into the renderer can read the token.

**Corrective action:** store only a SHA-256 of the token server-side; move the client to a
`HttpOnly`, `Secure`, `SameSite` cookie once TLS exists (VF-01).

### VF-21 · No controlled specification baseline existed
**Requirement:** URS-LC-06 · **Risk:** R-30 · **Evidence:** I
**Clauses:** Annex 11 §4 · GAMP 5 §4 · ISO/IEC/IEEE 12207 §6.4.2

Before this package there was no URS, no functional specification, no design specification, no
supplier assessment and no design-review record — only planning and phase notes. Requirements
were reconstructed retrospectively (document 01 §6). This validation can therefore prove what
the system does and that it is fit for use; it cannot prove that what it does is what anyone
specified in advance.

**Corrective action:** adopt document 02 as the baseline; specify before building from here on;
record a supplier assessment of Nickland.

### VF-22 · Verification is not enforced by continuous integration
**Requirement:** URS-LC-03 · **Risk:** R-30 · **Evidence:** E (OQ-9.3)
**Clauses:** ISO/IEC/IEEE 12207 §6.4.6 · GAMP 5

`build-windows-installer.yml` does run `smoke` and `typecheck` before packaging — a genuine
control, and it works. `build-android-apk.yml` runs nothing. Neither runs the RBAC, IQC, alerts,
account or backup scripts, so those 467 assertions are exercised only by hand.

**Corrective action:** one workflow that runs typecheck, build and the full validation suite on
every push, gating both packaging workflows.

### VF-24 · Segregation of duties is not enforceable
**Requirement:** URS-SEC-19 · **Risk:** R-04 · **Evidence:** I
**Clauses:** Annex 11 §2 · ISO 15189:2022 §7.6.3 · ISO 27001 A.5.3

The System Administrator role holds every permission, including audit-trail review. The same
person can act, review their own actions, and hold the host file access described in VF-05. The
permission model is expressive enough to separate these — the finding is that nothing requires
it, and the default seed does not.

**Corrective action:** seed a review-only role holding `records_reports.audit` without
administrative rights; require the periodic audit review to be performed by someone other than
the administrator; document this in the laboratory's procedure.

---

## P3 — Minor

### VF-14 · Signature-to-audit linkage is non-deterministic
**Requirement:** URS-SIG-07 · **Evidence:** I (OQ-6.7) · **Clause:** 21 CFR 11.10(e)

`signatureService.ts:76` resolves the audit row it just wrote with
`SELECT id FROM audit_logs ORDER BY id DESC LIMIT 1`. Any concurrent audited action landing
between the insert and the lookup attaches the wrong audit entry to the signature. Rare on a
single-host deployment, systematic once several clients work simultaneously.
**Corrective action:** return the inserted row id from `audit()` and use it directly.

### VF-15 · No security response headers
**Requirement:** URS-SEC-16 · **Evidence:** E (OQ-8.5) · **Clause:** ISO 27001 A.8.26

None of `Strict-Transport-Security`, `X-Content-Type-Options`, `X-Frame-Options` or
`Content-Security-Policy` is sent.
**Corrective action:** add `helmet` with a CSP appropriate to the renderer.

### VF-17 · Audit timestamps carry no time zone
**Requirement:** URS-AUD-07 · **Evidence:** E (OQ-5.6) · **Clauses:** Annex 11 §9 · ALCOA+

Entries store SQLite `CURRENT_TIMESTAMP` — `2026-08-10 10:09:05`, UTC by convention with nothing
in the record saying so. A reader in another zone, or anyone reconstructing events after a host
clock change, cannot prove the instant. The interface displays these values without conversion.
**Corrective action:** store ISO 8601 with offset, and state the host time source in the record.

### VF-23 · Verification scripts have undocumented prerequisites
**Requirement:** URS-LC-07 · **Evidence:** E (document 04 §4.1) · **Clause:** ISO 29119 §5

`rbac-matrix` and `rbac-selfservice` crash unless `rbac-roles` has seeded the same host first;
nothing says so. During this validation both initially appeared broken and were only shown to
pass once chained correctly.
**Corrective action:** make each script self-seeding, or document the order in a runner.

### VF-25 · Retention rules are recorded but not enforced
**Requirement:** URS-DAT-15 · **Evidence:** I · **Clauses:** ISO 15189 §8.4.3 · ISO 17025 §8.4.2

The system records retention rules and review records but never destroys anything. This is a
deliberate and defensible design decision — automated destruction of quality records is a far
worse failure mode than over-retention — and it is recorded as an observation rather than a
defect. It nonetheless leaves the laboratory to enforce its retention schedule by hand.
**Corrective action:** none required in software. Document the manual procedure and evidence it
through the existing retention-review workflow.

---

## Closure plan

| Priority | Findings | Target |
|----------|----------|--------|
| P1 | VF-01, 02, 03, 04, 05, 06, 07, 08 | Before any LAN, PWA or multi-client deployment, and before signatures are relied on as Part 11-compliant |
| P2 | VF-09, 10, 11, 12, 13, 16, 18, 19, 20, 21, 22, 24 | Within the first periodic-review cycle (6 months) |
| P3 | VF-14, 15, 17, 23, 25 | As convenient; tracked to closure |

VF-03, VF-11 and VF-14 are each a small, contained change with disproportionate compliance
value; they are the sensible place to start.
