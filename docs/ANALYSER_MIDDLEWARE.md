# Analyser Transmission & Middleware

The engine that carries a result from an analyser to SECHLIMS and to whichever
information systems a facility runs, and the record of what happened to every
message on the way.

This document covers what the module supports, what it refuses, how it is
deployed and configured, what it cannot do, and what a vendor or an
administrator has to supply.

---

## 1. The non-negotiable first

**The existing Sysmex XN-550 → LHIMS transmission is protected.** It carries
patient results today, and nothing in this module may disturb it.

That is enforced in code rather than left to a convention, in one place
(`server/services/middleware/safety.ts`) that every other part of the module
asks before it acts:

| Protected thing | How it is enforced |
|---|---|
| The link | A link recorded as `lhims_owned` is never opened by the bridge. The middleware never writes to it, tests it or probes it. |
| The endpoint | Its host and port are refused to every listener, destination, routing rule and network scan. A wildcard bind on that port counts as a collision. |
| The traffic | The engine is never in the path. It opens its own listeners for analysers that transmit nowhere today, and takes a copy of a protected analyser only by following the LHIMS client's own append log, read-only. |
| Duplication | A link LHIMS already receives may not be routed to an LHIMS destination. Two copies of one haemoglobin in a patient record is a worse failure than none. |
| The configuration | A **baseline** records the link's settings and health by reading them. Capturing one runs `SELECT` statements and nothing else, and is safe during a clinical session. Verifying one later **reports** drift; it never corrects it. |

A protected destination may be recorded so the laboratory can see it. It is
held read-only: it cannot be edited, tested, activated, rolled back or
transmitted over.

Migrating the XN-550 onto this engine is **out of scope for this work** and
requires, separately: a regression run of the checks in §8, explicit written
approval, a verified rollback procedure, and a post-change health check.

---

## 2. What the module does

```
analyser → bridge → ingest → normalise → validate → route → map
                  → queue → transmit → acknowledge → outcome
```

The analyser bridge (`server/services/instrumentBridge/`) receives a
transmission and records what the machine said. The middleware engine
(`server/services/middleware/engine.ts`) decides where it goes, carries it
there, and accounts for it afterwards.

Three design decisions shape everything else.

**The source message is never rewritten.** `instrument_messages` holds what
arrived. `mw_messages` points at it. A message routed to four destinations,
failed at two and replayed twice still has exactly one original.

**A delivery is the unit of reliability, not a message.** One row per
(message, destination) with its own attempts, acknowledgement and outcome. That
is what makes "the hospital system has it, the research database does not"
expressible at all, and why a destination failing cannot mark another's
delivery successful.

**Delivery is at least once, with idempotency — not exactly once.** Every
delivery carries a key unique to its destination, so a retry or an authorised
replay is the same delivery attempted again rather than a second result. What
this cannot control is a destination that acknowledges a message and then loses
it, or stores one and fails to acknowledge. Duplicates are made *detectable*
here and *reconcilable* there. Exactly-once is not claimed anywhere in the
product, the API or the UI.

---

## 3. Supported devices and protocols

### Inbound, from analysers

Handled by the existing bridge and its protocol implementations, which this
module extends rather than duplicates.

| Protocol | Notes |
|---|---|
| ASTM E1394 | Framed records, ENQ/ACK handshaking, per-frame checksum. The envelope is stripped before parsing. |
| HL7 v2 (ORU^R01) over MLLP | Framed between `0x0B` and `0x1C 0x0D`. |
| Delimited text | One result per line; layout mapped by hand. |
| `auto` | The protocol is worked out from the first message's shape. |

Connection modes: SECHLIMS listens (`server`), SECHLIMS dials out (`client`),
a watched folder (`file_drop`), and following a middleware client's own append
log read-only (`lhims_tap`).

Analyser profiles ship for Sysmex XN/XS/XT/KX-21N, Mindray BC-3600/5300/5800
and BS-380/240, DIRUI, HORIBA ABX Pentra and Micros, Abbott Cell-Dyn, URIT,
ELITech Selectra and Flexor, Biotecnica BT-3000, Ortho VITROS and Cepheid
GeneXpert, plus generic ASTM and HL7 profiles. A profile is a starting point;
every map is editable per link.

**Serial (RS-232) is not implemented.** See §7.

### Outbound, to information systems

| Transport | Payload | Acknowledgement |
|---|---|---|
| `internal` | — | None. Records acceptance in SECHLIMS, transmits nothing. |
| `hl7_mllp` | HL7 v2 ORU^R01 | `MSA` — `AA`/`CA` accepted, `AR`/`CR` rejected, `AE` retried. |
| `astm_tcp` | ASTM E1394 | ENQ/ACK handshake, per-frame ACK, EOT. |
| `http_lhims` | Per-result calls | The same `api/update_result.php` call the LHIMS middleware makes. |
| `http_json` | JSON | HTTP 2xx. 4xx (except 408/429) is a rejection; 5xx is retried. |
| `file_export` | HL7, ASTM, JSON or CSV | File written to a temporary name and renamed into place. |

TLS is available on the TCP transports, with certificate verification on. A
host with its own certificate authority installs it on the machine.

---

## 4. Deployment requirements

* The SECHLIMS host, on the laboratory network, reachable by the analysers.
* One free TCP port per analyser that transmits to SECHLIMS. Ports colliding
  with a protected connection are refused at configuration time.
* Outbound network reach from the host to each destination's address and port,
  through whatever firewall sits between.
* Read access to any watched folder; write access to any export folder.
* Node 20+ and the application's own SQLite database. No broker, queue server
  or additional service: the queue is a table, which is what makes it
  restart-safe without new infrastructure.

**Credentials** are encrypted at rest with AES-256-GCM, under a key held at
`<data-dir>/middleware.key` (created 0600 on first use). That key is part of
the host's backup set — a database restored onto a host without it will report
that stored credentials cannot be read, and they must be re-entered. No
endpoint returns a credential, and none is written to a log, a diagnostic
report, a configuration version or anything handed to Dennis.

---

## 5. Configuration procedure

The workspace runs the steps in the order the work is done.

1. **Baseline the existing transmission.** Read-only; changes nothing. Do this
   before anything else, because it is what tells the engine which endpoints to
   refuse.
2. **Discover or configure.** Discovery is limited to private address ranges,
   /24 at widest, 256 addresses, a named port list, and never a protected
   endpoint. It produces a *proposal* with a confidence, not a connection. An
   analyser that only accepts connections will not answer a scan and is
   configured by hand.
3. **Configure the destination** — transport, payload format, endpoint,
   authentication, acknowledgement policy and retry schedule. It is created
   `configured` and carries nothing.
4. **Test it in isolation.** One obviously synthetic control message
   (`SECHLIMS-TEST-0001`) over the real transport. Never a patient result, and
   never recorded as a delivery. A pass moves it to `awaiting_approval`.
5. **Approve it.** A destination that has never exchanged a message cannot be
   approved.
6. **Activate it.** Separate from approval on purpose: approval says the
   interface is correct, activation is the moment it starts carrying results.
7. **Route to it.** Rules narrow — a blank criterion matches everything, a set
   one must match. Every matching rule produces its own delivery. Preview uses
   the same matching function the engine does.
8. **Map its codes**, if it uses its own. A code with no mapping is **withheld
   and named**, never filed under a guess.

Changing an active destination's transport, endpoint, authentication or
acknowledgement policy **stands it down to `awaiting_approval`** and clears the
approval. So does a rollback. Nothing carries clinical results on settings
nobody has signed for.

### States

`Discovered → Configured → Testing → Awaiting approval → Active`, with
`Degraded` (a delivery failed, the interface still works), `Disconnected`
(stood down) and `Failed`.

### Parameter mappings — what a result is called at each step

A result changes name twice between the analyser and the record it ends up in,
and both translations live under **Parameter Mappings**, one sub-tab each.

**Analyser → SECHLIMS.** What the machine's own mnemonic means. Most analysers
need nothing: choosing the model under Connection Setup brings its whole
vocabulary with it, and the tab shows what that model already understands. The
tab is for the machine that disagrees with the book, and for the parameter
nobody has named yet — which it finds by itself. *Codes this analyser has
actually sent* reads the transmissions on the record, lists every mnemonic with
how often it has arrived and what it currently becomes, and puts the ones
nothing names at the top. A laboratory never has to guess what its machine
calls a parameter, or notice unaided that one has been arriving unnamed for a
fortnight.

**SECHLIMS → LIS.** What the receiving system calls it. Two vocabularies: the
names a result-entry form uses, which the Result Filler types on the
laboratory's behalf; and the numeric measure ids LHIMS files a result under,
per link. A parameter with no measure id is **withheld and named**, never filed
under a guess — the same rule as a destination's own code map, which stays
under Routing & Mappings because it belongs to a destination rather than to a
parameter.

**Saving a mapping never costs a connection.** A name is not a socket: the
running link takes the new settings in place, so an analyser mid-transmission
notices nothing, and a machine that has to be reconnected by hand is not made
to be. The check proves it — a rename, then the very next message read under
the new name, with the link never leaving the state it was in.

---

## 6. Diagnostics, permissions and audit

### Diagnostics

Layered, because each layer can pass while the next fails. Five facts are kept
apart throughout and never conflated:

| Fact | What it establishes |
|---|---|
| Reachable | Something answered at that address and port. |
| Established | A session opened and was held. |
| Parsed | Bytes became records became results. |
| Delivered | The message left this host. Against a destination with no acknowledgement policy, that is **all** it means. |
| Accepted | The receiving system said so in its own protocol. |

Every transmission carries an end-to-end trace: ingest, parse, normalise,
validate, map, route, queue, transmit, acknowledge, outcome and replay, each
with what was observed and how long it took.

### Permissions

Seven features under the `analyser_middleware` module, because reading the
transmission log and activating an interface that carries patient results are
not one decision.

| Feature | Governs |
|---|---|
| `overview` | Dashboard, connections, live monitoring, message explorer. Read-only. |
| `discovery` | Network scans. |
| `configuration` | Destinations, routes, mappings; approval and activation at `full`. |
| `diagnostics` | Running diagnostics, destination tests, the simulator. |
| `queues` | Replay, re-route, cancel, queue sweeps. |
| `dennis` | Asking Dennis; approving its proposals at `full`. |
| `audit` | Configuration history; rollback at `full`. |

### Audit

Every configuration change records the settings before and after it, with who
and why. Rollback writes the old settings again and records *that* as a new
version — the history is append-only. Scans, tests, replays, cancellations,
re-routes and sweeps go to the system audit trail. Every Dennis recommendation,
its evidence, its validation, its approval or rejection and the version that
carried it out are on the record.

---

## 7. Limitations, and what needs a person or the vendor

Stated rather than worked around.

**Not implemented**

* **Serial (RS-232/USB) connections.** The analyser profiles name serial-capable
  instruments, but this module speaks TCP, files and HTTP only. A serial
  analyser needs a serial-to-Ethernet converter, after which it is an ordinary
  TCP link. No part of the UI offers serial configuration.
* **Inbound queries** (HL7 `QRY`/`ORM` work orders, ASTM host query mode). The
  engine is result-out; it does not answer an analyser asking for a worklist.
* **Protocols beyond ASTM E1394, HL7 v2 and delimited text** — no HL7 FHIR, no
  vendor-proprietary binary protocols, no DICOM.
* **Automatic cutover** of an existing production connection. Deliberately
  absent; see §1.

**Needs a person or the vendor**

* The analyser's own host address, port and protocol, set in its service menu.
* Vendor host-communication or file-export options, where licensed separately.
* Proprietary drivers, serial cabling and physical configuration at the
  instrument.
* The target test codes a receiving system uses — these come from its own
  interface specification and are never invented here.
* Firewall rules between this host and each receiving system.
* The decision to approve and activate an interface, and to replay or cancel a
  clinical result.

**Known constraints**

* A destination with `ack_policy: none` can be shown as transmitted, never as
  accepted. The UI says so on every such row.
* Discovery finds open ports. It cannot read an analyser's configured protocol,
  so a profile guess is a guess with a confidence attached.
* The queue is per host. A second SECHLIMS host runs its own queue; they do not
  co-ordinate.

---

## 8. Tests

```bash
npm run check:middleware-engine   # no API needed
npm run api                       # in one terminal
npm run check:middleware          # in another
```

**`scripts/middleware-engine-check.mjs`** — 118 checks. Real TCP destinations in
process (one acknowledging, one rejecting, one failing with an application
error, one silent), a real SQLite database from the application's own
migrations. Covers ASTM and HL7 parsing, framing and the outbound builders;
connection establishment, rejection, application error and timeout; duplicate
detection and idempotent enqueueing; the retry schedule and the dead letter at
the cap; queue recovery after a stopped host; routing to several independent
destinations; partial delivery; field mapping, unit conversion, withheld
unmapped codes and validation; configuration versioning and rollback; sample
sanitising; credential storage; and the XN-550 path, asserted unchanged at the
end.

**`scripts/middleware-check.mjs`** — 76 checks over HTTP. Permission
enforcement against a real bench account (twelve refusals), the approval gates,
stand-down on settings change, the protected-port refusals, a transmission
played end to end through the engine, Dennis's limits (blocked on the
production port, cannot approve its own proposal, refuses an unsanitisable
sample, never invents a target code), configuration history and rollback, and
the audit trail.

**Regression protection for the existing integration.** The XN-550 assertions
run at the end of both scripts, after everything else has executed. The
existing analyser suite — `check:bridge`, `check:fetch`, `check:lhims`,
`check:transmission`, `check:analyser-feed`, `check:iqc-analyser` — passes
identically before and after this work.

---

## 9. Where the code is

| Path | What it holds |
|---|---|
| `shared/constants/middleware.ts` | The vocabulary, states, routing match, retry schedule, validation, sanitising and the protected-endpoint test. Shared by server and UI so they cannot disagree. |
| `server/services/middleware/engine.ts` | Ingest, normalise, validate, route, map, queue, deliver, settle, replay, recover. |
| `server/services/middleware/transports.ts` | The six transports and the payload renderer. |
| `server/services/middleware/safety.ts` | Protected endpoints, baselines, route and destination refusals. |
| `server/services/middleware/diagnostics.ts` | The layered checks. |
| `server/services/middleware/discovery.ts` | Scope-limited scanning and profile proposals. |
| `server/services/middleware/versions.ts` | Configuration history and rollback. |
| `server/services/middleware/secrets.ts` | Credential sealing and log scrubbing. |
| `server/services/middleware/dennis.ts` | Evidence gathering, proposals, deterministic validation, review. |
| `server/routes/middleware.ts` | The HTTP surface, with per-feature permissions and audit. |
| `src/pages/MiddlewarePage.tsx`, `src/components/middleware/` | The twelve-section workspace. |

The bridge is reached through one observer seam
(`observeMessages` in `server/services/instrumentBridge/index.ts`), registered
at startup and wrapped so that nothing the middleware does can affect the
transmission that produced the message.
