# The central Communication Service

*Information Management → Communication*

Every communication SECH_LIMS sends or receives passes through one service, is
recorded as one kind of record, and is readable in one place. This document is
the contract: what the service guarantees, and what a module must do to use it.

---

## Why it exists

Communication used to happen wherever a module needed it.

| What was sent | Where it was recorded | What an assessor could see |
|---|---|---|
| The monthly reassignment memo | Printed from Scheduling | Nothing on file |
| A critical value telephoned to a ward | `critical_result_notifications` | A row in Process Management |
| A controlled-document release | An attestation task per person | A task list, not a notice |
| Everything else | WhatsApp, by hand | Nothing at all |

Four mechanisms, four shapes of evidence, and no screen that could answer the
question the laboratory is actually asked: *what has this laboratory
communicated, to whom, by what means, and did they receive it?*

The Communication Service is that screen's backing store, and the single door
everything goes through.

---

## The three rules

**1. Delivery is never claimed, only recorded.**
SECH_LIMS delivers on exactly one channel — its own, in-app. A memo exported to
PDF and carried to WhatsApp by a supervisor is recorded as **prepared**, with
the person who prepared it named, and `delivery_confirmed` left `NULL`. A log
that invents a read receipt is worse than no log, because somebody will rely on
it. `channelIsIntegrated()` in `shared/constants/communications.ts` is the only
place that list of channels lives; the API refuses a `system` dispatch on any
channel outside it.

**2. An audience is remembered as it was named.**
"All laboratory staff" is resolved to people at the moment of sending, and both
are kept: `communication_recipients.audience_label` holds the label the sender
chose, and `user_id` / `staff_id` / `stakeholder_id` hold who it reached.
Membership changes; what the memo was addressed to does not.

**3. Confidential content does not leave without a reason on the record.**
A `restricted` or `confidential` communication cannot be shared through an
external channel without an explicit confirmation and a justification, both
stored on the dispatch row. The service enforces this, not the screen, because
the screen is not the only caller.

---

## The shape of a record

```
communication_threads      one conversation
  └─ communications        one message, memo, notice, alert or notification
       ├─ communication_recipients   who it was addressed to, and what each did
       ├─ communication_dispatches   which channels carried it, and how
       ├─ communication_attachments  what travelled with it
       └─ communication_events       the chronological trail
```

Four child tables because an assessor asks four separate questions, and
conflating them makes any one answer unprovable. `communication_audiences` and
`communication_templates` hold the configuration behind the hub.

### Numbering

Each kind numbers in its own series, so "memo 14 of this year" does not require
counting past three hundred chat messages: `MEMO-`, `NOTE-`, `MSG-`, `ALRT-`,
`SYSN-`, `ACKR-`, `EXTC-`, `COMM-`, and `CTHR-` for a thread.

---

## How a module uses it

One function. A module that needs to issue a memo, a notice, an alert, a
critical-value communication or a staff communication calls it and gets a
number back. It does **not** insert into `communications`, raise its own
notifications, or keep its own log.

```ts
import { recordModuleCommunication } from '../services/communicationService.js';

const communication = recordModuleCommunication(req, {
  type: 'notice',                 // memo | notice | alert | direct_message | …
  direction: 'internal',          // outbound | inbound | internal
  channel: 'in_app',
  subject: 'Reagent shortage — Biochemistry',
  body: 'Diluent is below one pack. Non-urgent work is deferred until Friday.',
  priority: 'high',
  confidentiality: 'internal',
  requiresAcknowledgement: true,
  audiences: [{ kind: 'audience_group', ref: 'AUD-LAB-ALL' }],
  // The record this is about, so the log can open it and the record can show
  // what has been said about it.
  sourceModule: 'supplier_inventory',
  sourceRecordType: 'inventory_items',
  sourceRecordId: itemId,
  once: true,                     // see below
});
```

### What the call guarantees

* It **never throws into its caller.** A module's own work — releasing a
  document, recording a critical value — must not fail because a communication
  record could not be written. The failure lands in the audit trail as
  `communication_record_failed`, where it can be found and fixed, and the
  function returns `null`.
* It creates the thread, numbers the record, resolves the audience, inserts the
  recipients, links the source record, raises an in-app notification per
  reachable recipient, records the dispatch, and writes the events.
* `send: false` leaves it a draft. Anything else dispatches it.
* `once: true` reuses an existing communication for the same
  (`type`, `sourceModule`, `sourceRecordType`, `sourceRecordId`) instead of
  creating a second one. Use it wherever the module's action can legitimately
  repeat — republishing a schedule, reprinting a memo — so the second run is
  another *dispatch* of one communication rather than a duplicate of it.
  `findModuleCommunication()` is the same lookup on its own, for a module that
  wants to add a dispatch to a communication it raised earlier.

### Recipients with no SECH_LIMS account

A clinician, a supplier, a hospital department. The audience resolves them (from
the staff register or the stakeholder register), the recipient row is created,
and the delivery status is set to `prepared` — a record exists, a delivery does
not, and somebody must still carry it. The log says exactly that.

---

## Already wired

| Module | What it raises | Where |
|---|---|---|
| Scheduling | The reassignment memo, on publish; the printed copy as a dispatch | `server/routes/scheduling.ts` |
| Process Management | A critical-value communication, with the read-back and the channel used | `server/routes/processManagement.ts` |
| Documents & Records | The controlled-document release notice, on issue or distribution | `server/routes/documents.ts` |

A new module adds a row here and a call to `recordModuleCommunication()`. It
does not add a communication mechanism.

---

## Permissions

Four feature keys, because "may send a message to a colleague" and "may approve
a memo to the whole hospital" are not the same decision — and nor is "may read
everybody else's correspondence".

| Key | Covers |
|---|---|
| `information_management.communication` | The hub: read, compose, reply. Granted to **every** member of staff in the seeded baseline, and marked `personal`, so a person always reaches their own correspondence and nobody else's. |
| `information_management.communication_memos` | Formal memos and notices: prepare (`create`), release (`approve`), prepare an external copy (`export`), print (`print`), withdraw (`void_archive`). |
| `information_management.communication_log` | The register and the audit trail — **sensitive**, because it reaches other people's communications. `export` for the spreadsheet. |
| `information_management.communication_audiences` | Audiences and templates. |

The granularity the design asks for (view, create, send, reply, approve,
externally share, export, manage, audit) is expressed as **actions** on those
four keys rather than as a new vocabulary, so the existing resolver, the access
matrix and every route guard keep working unchanged.

Two reading rules hold throughout the API:

* A person always reaches a communication they **sent** or were **addressed
  to**, on `communication: view` alone.
* Reading somebody else's requires `communication_log: view`.

---

## The interface

| Tab | What it is |
|---|---|
| **Communication** | The person's own conversations: a two-pane chat with replies, acknowledgements, attachments and forwarding. |
| **Memos & Notices** | The formal end: drafting, the approval queue, dispatch, and preparing copies for channels SECH_LIMS cannot reach. |
| **Communication Log** | The register of everything, filterable by period, type, direction, channel, status, "shared externally" and "acknowledgement required", with a spreadsheet export and a full record view per communication. |
| **Audiences & Templates** | The configuration: rule-based audiences that follow the organisation, and the laboratory's standard wording. |

A new message arrives as a small popup in the corner of the screen
(`src/components/CommunicationPopup.tsx`) with Open, Reply and Dismiss.
Dismissing is **not** reading: the message stays unread, in the inbox, and
counted. Nothing pops up on the first load of a session, a batch is one chime,
and a message announces itself once.

---

## Files

| Path | What it holds |
|---|---|
| `shared/constants/communications.ts` | The vocabulary: types, directions, channels, audience kinds, statuses, dispatch methods, share formats, numbering prefixes, feature keys. |
| `shared/types/api.ts` | `Communication`, `CommunicationThread`, `CommunicationRecipient`, `CommunicationDispatch`, `CommunicationEvent`, `CommunicationAudience`, `CommunicationTemplate`, `CommunicationSummary`. |
| `server/db/database.ts` | The eight tables and their indexes, plus the seeded audiences and templates. |
| `server/services/communicationService.ts` | Audience resolution, thread handling, create / send / reply / forward, acknowledgement, external-share recording, event logging, `recordModuleCommunication()`. |
| `server/routes/communications.ts` | `/api/communications` — the inbox, threads, compose, approval, replies, attachments, external sharing, print / Word / text rendering, the register and its export. |
| `src/pages/communication/` | The four tabs and their dialogs. |
| `src/hooks/useCommunications.tsx` | The shell-wide poll, shared by the popup and the topbar count. |
| `src/components/CommunicationPopup.tsx` | The inbound-message popup. |
