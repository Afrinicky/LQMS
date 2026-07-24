# SECH_LIMS Companion App — Phase 2 Expansion

Phase 2 turns the Companion App into the **primary mobile workstation** for
laboratory staff: operational, quality, maintenance, administrative and
supervisory duties are all doable from a phone, fully synchronized with the Host
over LAN, Tailscale and a future Cloudflare Tunnel. It reuses the existing Host
API, authentication and RBAC — no new authority is created on mobile, and every
write flows through the same audit trail as the desktop app.

## What shipped

| Area | Client | Server |
|---|---|---|
| Staff Self-Service | `mobile/SelfService.tsx` | `/api/mobile/me/*`, `/api/mobile/announcements` |
| Role-based dashboard | `mobile/App.tsx` (`Home`) | `/api/mobile/dashboard` |
| Dynamic Forms Engine | `mobile/Forms.tsx` | `/api/forms/*` |
| Approval workflows | `mobile/Approvals.tsx` | `/api/mobile/approvals` |
| Electronic signatures | `mobile/Signature.tsx` | `/api/signatures`, `signatureService.ts` |
| QR infrastructure | `mobile/Scan.tsx` | `/api/qr/*`, `qrService.ts` |
| Push framework | `mobile/SelfService.tsx` (settings) | `/api/push/*`, `pushService.ts` |
| Camera intelligence | `mobile/Scan.tsx`, `mobile/native.ts` | (reuses `/api/evidence`, `/api/files`) |
| Native prep | `mobile/native.ts`, `capacitor.config.ts` | — |

## New database tables (additive migration in `server/db/database.ts`)

- `e_signatures` — signature-of-record: identity, timestamp, device, IP, audit ref, bound to `(module_key, record_type, record_id)`.
- `qr_codes` — stable per-entity token registry; `UNIQUE(entity_type, entity_id)`.
- `push_subscriptions`, `push_deliveries` — device endpoints and the outbound queue with retry.
- `announcements`, `announcement_reads` — org broadcasts with read/ack receipts.
- `clock_events` — clock in/out with optional GPS.
- `form_templates`, `form_submissions` — the forms engine (JSON schema + answers).
- `leave_requests` / `inventory_requests` extended with `days`, `decision_notes`, `created_by`, `updated_at`.
- `staff` extended with emergency-contact and licence self-service columns.

## Dynamic Forms Engine

Templates are authored as JSON (`{ sections: [{ title, fields: [...] }] }`).
Supported field `type`s: `heading`, `text`, `textarea`, `number`, `date`,
`time`, `datetime`, `dropdown`, `multichoice`, `checkbox`, `passfail`, `rating`,
`signature`, `photo`, `qr`. Fields support `required`, `options`, `min`/`max`,
`pattern`, and conditional display via `showIf: { field, equals }`. The server
re-validates every submission and derives an overall pass/fail result. Ten
starter templates are seeded (temperature monitoring, opening/closing
checklists, cleaning, waste disposal, equipment maintenance, internal audit,
fire safety, vehicle and facility inspection). Administrators add new forms with
no application update.

Create a template:

```
POST /api/forms/templates
{ "templateKey": "reagent_receipt", "title": "Reagent Receipt", "category": "Inventory",
  "requiresSignature": true,
  "schema": { "sections": [ { "title": "Receipt", "fields": [
     { "key": "lot", "label": "Lot number", "type": "qr", "required": true },
     { "key": "expiry", "label": "Expiry", "type": "date", "required": true },
     { "key": "coldchain", "label": "Cold chain intact", "type": "passfail", "required": true }
  ] } ] } }
```

## Electronic signatures

`recordSignature(req, { moduleKey, recordType, recordId, purpose, meaning })`
persists a signature and links it to the audit row it generates. It is called by
approvals, form completion (when `requires_signature`), announcement
acknowledgement and declaration signing. The signature image is optional (the
identity + meaning + timestamp is the record); when supplied it is uploaded and
referenced by `signature_image_file_id`.

## QR infrastructure (backend complete now)

Tokens are minted per entity and are stable, so printed labels never break.
`GET /api/qr/:token` resolves to the entity, its module and a mobile deep link.
`POST /api/qr/generate-all { entityType }` bulk-mints for a whole entity type.
Live scanning needs a secure context (HTTPS/native); until then the scan screen
offers manual code entry and OS-camera capture. No backend change is needed to
turn scanning on.

## Push-notification framework (backend complete now)

`queuePush({ userId, title, body, priority, moduleKey, scheduledFor })` creates
the in-app notification (respecting `notification_preferences`) and enqueues a
`push_deliveries` row. When no subscription exists the delivery is `deferred`;
when one does it is `pending`. A future HTTPS-connected worker calls
`dueDeliveries()` → send → `markDelivered`/`markFailed` (retry with backoff).
`VAPID` public key is exposed at `/api/push/vapid-public-key` when configured.

## Native-app preparation

`mobile/native.ts` is the single seam for device capabilities (camera,
geolocation, push, secure storage, image compression) and capability detection.
No screen touches a device API directly, so a Capacitor wrap only swaps this
file's web implementations for native plugins. `capacitor.config.ts` documents
the Android build. The PWA remains fully functional throughout.

## Offline-first & audit

Self-service and form submissions post through the offline-aware `submit()`
(queue in `localStorage`, auto-flush on reconnect). Every mobile write reuses
the Host services, so all actions — including signatures and approvals — land in
the existing audit trail automatically.
