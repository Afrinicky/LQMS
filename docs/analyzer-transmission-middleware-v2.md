# SECHLIMS Analyzer Transmission & Middleware v2

Status: design and implementation guardrails
Branch: `feature/analyzer-middleware-v2`
Base: `main`

## Non-negotiable safety invariant

The existing Sysmex XN-550 -> LHIMS middleware connection must remain unchanged while v2 is built, tested, and validated. Do not bind to, proxy, restart, reconfigure, or claim ownership of the existing LHIMS-owned endpoint. Do not alter the existing analyzer route as part of a UI or schema rollout. Existing `instrument_links`, `instrument_messages`, LHIMS tap/following behaviour, protocol parsing, and current routing settings remain compatible.

A production route is migrated only after a separate approval, successful simulated/test-destination verification, and a documented rollback plan.

## Existing implementation discovered

The repository already has a substantial analyzer bridge:

- `server/services/instrumentBridge/index.ts`: connection lifecycle, ASTM/HL7 protocol handling, LHIMS tap/following, message persistence, and forwarding.
- `server/services/instrumentBridge/protocols.ts`: framing/parsing for ASTM and HL7 MLLP.
- `server/routes/instrumentLinks.ts`: existing analyzer link administration, diagnostics, activity, and forwarding endpoints.
- `src/pages/InstrumentLinksTab.tsx`: existing connection configuration and monitoring UI.
- `src/components/instruments/LiveTransmission.tsx`: live event viewer.
- `src/components/instruments/TransmissionsDialog.tsx`: transmission history.
- `server/routes/analyserFeed.ts`: analyzer data feed for other modules.
- `shared/constants/lhims.ts`: LHIMS-specific mapping and request behaviour.
- The application uses TypeScript, Express, React, and SQLite via better-sqlite3. Preserve that architecture unless a separately reviewed migration establishes a need to change it.

Therefore v2 should extend the existing bridge and database rather than create a competing listener or duplicate analyzer registry.

## Target architecture

1. **Transport adapters** — existing TCP server/client, file-drop, and read-only LHIMS tap first; add serial and other adapters only when their host/runtime support is confirmed. Every adapter has a unique ID, ownership mode, lifecycle, health signal, and bounded input size.
2. **Protocol adapters** — reuse and test ASTM E1394 and HL7 v2/MLLP handling. Keep framing separate from parsing and parsing separate from routing. Unknown or invalid frames must be rejected/quarantined with reason and never silently interpreted as results.
3. **Canonical envelope** — preserve the exact raw payload and record source link, received timestamp, protocol, message fingerprint, parser version, parsed sample/accession ID where present, result/control classification, and validation findings. Raw payload is immutable; transformations create a new representation.
4. **Durable message queue** — persist an inbound message before reporting it as accepted where protocol semantics allow. Store one delivery row per destination, with states such as queued, sending, acknowledged, retry_wait, failed_permanent, quarantined, and cancelled. Queue processing must recover after application restart.
5. **Routing engine** — configurable source-to-destination rules, including multiple destinations, message types, filters, mapping versions, enable/disable state, and effective dates. Each destination succeeds or fails independently.
6. **Destination adapters** — existing LHIMS HTTP upload path and SECHLIMS internal persistence first. Additional LIS/HIS destinations must use explicit adapter contracts and destination-specific validation. Never assume a generic endpoint is compatible with LHIMS.
7. **Monitoring and operations** — dashboard counters, last successful receive/delivery per link and destination, live event stream, searchable message/delivery history, structured errors, safe retries, and controlled replay.
8. **Configuration and audit** — versioned configuration, actor/timestamp/reason audit, permission checks, secure credential storage, validation-before-activation, and rollback to the prior version.

## Proposed data model additions

Use additive SQLite migrations only. Do not rename or drop existing tables/columns.

- `transmission_routes`: route identity, source link, destination key, enabled flag, priority, filter/mapping JSON, configuration version, created/updated metadata.
- `transmission_envelopes`: stable UUID, source link, received timestamp, protocol, raw payload or secure raw-payload reference, SHA-256 fingerprint, parsed JSON, parser version, validation state, correlation ID.
- `transmission_deliveries`: envelope ID, destination key, status, attempt count, next attempt timestamp, last attempt timestamp, acknowledgement timestamp, destination receipt/reference, error code and safe error detail, unique idempotency key.
- `transmission_events`: timestamped lifecycle events for receive/parse/validate/queue/send/ack/failure/retry/replay and configuration changes.
- `transmission_config_versions`: immutable snapshots or equivalent audited version history for link/route changes.

Before creating any table, inspect the complete current migrations and existing `instrument_messages` schema. Reuse existing durable fields where equivalent and migrate data additively. Avoid duplicating raw messages unnecessarily; use a documented retention policy and access controls.

## Delivery and idempotency rules

- Compute a stable fingerprint from source identity plus normalized protocol payload; do not use sample ID alone because a sample can legitimately have multiple messages/results.
- Use a per-destination idempotency key and a unique database constraint to prevent duplicate queue entries.
- Mark a delivery acknowledged only after the destination-specific acknowledgement has been interpreted as success.
- A timeout after a destination accepted a message is ambiguous: reconcile if possible before retrying. Do not promise exactly-once delivery across external systems; implement at-least-once delivery with idempotency/reconciliation.
- Use bounded exponential backoff with jitter, maximum attempts, and dead-letter/quarantine handling.
- One destination failure must not block another destination.
- Preserve original result values, units, flags, timestamps, and analyzer identifiers. Any mapping must be versioned and validated.
- Do not automatically replay patient-result messages into production from a diagnostic screen without a warning, permission check, idempotency check, and audit event.

## Ownership and network safety

- Keep LHIMS-owned connections as passive/read-only integrations unless the laboratory explicitly approves a planned migration.
- Never bind a new listener to an occupied port or a port reserved for an existing LHIMS-owned link. Fail closed with a visible conflict diagnostic.
- Never change the XN-550 connection, LHIMS client configuration, host/port, or its service lifecycle during this feature's implementation.
- Do not route one result back into its source system without loop prevention and explicit approval.
- Restrict network binding to configured interfaces; do not default to all interfaces without an explicit administrator choice.
- Keep credentials out of UI responses, logs, exception text, and event payloads.
- Redact patient identifiers from ordinary operational logs; expose identifiable content only in the authorized message explorer.
- Keep all network listeners and file watchers on the local host service, not in browser code.

## UI modules

Add a top-level Analyzer Transmission & Middleware workspace while retaining existing settings routes and components:

- Overview
- Analyzer Connections
- Destinations
- Routing Rules
- Live Transmissions
- Message Explorer
- Delivery Queue / Failed Deliveries
- Protocol Diagnostics
- Audit & Configuration History

The workspace may link to existing analyzer settings during transition. Avoid maintaining two separate editors for the same link configuration. Existing equipment/IQC pages should continue to show the same link state and use existing endpoints until the new workspace is verified.

## Rollout sequence

1. Baseline inventory and tests of the current bridge and live configuration.
2. Additive schema migration and repository/service abstractions; no routing changes.
3. Unit tests for idempotency, queue recovery, destination isolation, protocol invalidity, and retries.
4. Dry-run/simulation destination and read-only monitoring for existing connections.
5. Side-by-side compare old and new processing on synthetic/test messages; no duplicate production writes.
6. Enable one newly connected, non-LHIMS-owned analyzer in a controlled test.
7. Validate delivery acknowledgements, restart recovery, duplicate handling, and audit trace.
8. Migrate other approved routes one at a time, only after signed-off acceptance and rollback.
9. Treat the XN-550 -> LHIMS path as out of scope until a separately approved migration project.

## Acceptance criteria

- Existing analyzer configuration survives upgrade without being overwritten.
- Existing XN-550 -> LHIMS communication remains unchanged during build and test.
- Restarting the SECHLIMS service recovers queued deliveries and retains audit history.
- A single inbound message can be routed to multiple destinations with independent outcomes.
- Repeated delivery attempts do not create duplicate destination records where idempotency is supported.
- Protocol parse/framing failures are visible and quarantined, not silently dropped.
- All configuration and replay actions are permission-checked and audited.
- Health status distinguishes socket connected, message received, message parsed, queued, delivered, and destination-acknowledged.
- Existing tests `check:bridge`, `check:fetch`, `check:lhims`, `check:transmission`, and `check:analyser-feed` pass, with new middleware tests added.
- No claim of production readiness is made until end-to-end tests against approved test endpoints pass.
