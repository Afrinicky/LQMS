# Environmental Monitoring — architecture & roadmap

Internal engineering note. The Environmental Monitoring submodule (under
Facilities & Safety) supports **manual** and **automated** monitoring on one
data model and one alarm/excursion engine.

## Delivered (Phase 1)

**Data model** (`server/db/database.ts`): `environmental_assets`,
`environmental_devices`, `environmental_readings`, `environmental_alerts`,
`environmental_excursions`, `environmental_settings`. Floor-plan coordinates
(`floor_plan_x/y`) and `config_json`/`driver_key` give room to grow.

**Driver architecture** (`server/services/environmental/drivers.ts`): every
protocol is an `EnvDriver` behind one interface. Working drivers: `manual`,
`csv_import`, `simulator` (generates live readings for trials), `rest_api`
(polls an HTTP endpoint via `config_json`). Registered-but-pending: mqtt,
modbus, tcp_ip, usb, wifi, ethernet, bluetooth, rs232, rs485 — add an adapter
without touching the core. Each driver's `automated` flag controls polling.

**Engine** (`server/services/environmental/monitorService.ts`):
`recordReading()` is the single ingest path for manual + automated data. It
classifies against acceptable/warning bands, keeps one active alert per
(asset, type), opens/closes temperature excursions, and auto-creates a
Nonconformity + linked CAPA once an excursion is sustained past
`excursion_nc_minutes`. `EnvironmentalPoller` polls automated devices on a
configurable cadence; it self-gates on `polling_enabled` (off by default) and
is started from both the standalone server and the packaged Electron host.

**API** (`server/routes/environmental.ts`, mounted `/api/environmental`):
assets & devices CRUD, manual reading, on-demand device poll, CSV import,
live dashboard, ranged chart data, alerts (ack/resolve), excursions
(ack / manual NC), settings, drivers. RBAC via the `facilities_safety` module.

**UI** (`src/pages/EnvironmentalMonitoringPage.tsx`, embedded in Facilities &
Safety → Environmental Monitoring): Live Dashboard (auto-refreshing colour-coded
asset cards — green/amber/red/grey, battery, signal, trend), Assets, Devices
(with "Poll now" + CSV import), Manual Entry, Alerts, Excursions, Charts
(24h/7d/30d/90d + CSV export), Settings. In-app notifications are raised on the
Facilities & Safety channel. Every change is written to the shared audit log.

**Integration**: excursions link to NC/CAPA via `record_links`; assets can link
to Equipment; alerts surface through the existing notification/audit spine.

## Delivered (Phase 2) — notifications & escalation

**Channels** (`server/services/environmental/notifications.ts`): a
`NotificationChannel` registry mirroring the driver pattern. Working now:
`in_app` (writes to the shared notifications feed) and `webhook`
(Teams/Slack incoming webhook via `environmental_settings.webhook_url`).
Registered-but-pending: `email`, `sms`, `whatsapp`, `teams` — queue and report
"not configured" until a relay is installed.

**Escalation** (`environmental_escalation_rules`): each rule targets a severity
and a `delay_minutes`; when a matching alert stays active and unacknowledged
past the delay, one queue entry (`environmental_notification_queue`, unique per
alert×rule) is created and delivered by the worker. Delay 0 = immediate; larger
delays form the ladder. Two default rules are seeded (immediate in-app for all;
escalate unacknowledged criticals after 30 min). The poller runs the escalation
sweep + delivery every tick regardless of automated polling, so manual-reading
alerts escalate too.

**API**: `/environmental/channels`, `/environmental/escalation-rules` (CRUD),
`/environmental/notification-queue`, `/environmental/channels/:key/test`.
**UI**: a Notifications tab (channel status + test send, escalation-rule editor,
notification log) plus a webhook URL field in Settings.

## Delivered (Phase 3) — insights, predictive maintenance & reports

**Insights engine** (`server/services/environmental/insights.ts`): a
deterministic, offline analysis over the last 30 days of readings/alerts/
excursions that produces plain-language observations and preventive-maintenance
recommendations — excursion frequency, afternoon/time-of-day drift, reading
instability (possible sensor drift), humidity patterns, battery decline,
intermittent communication, and calibration due/overdue. It recommends only;
`POST /environmental/insights/create-action` turns a recommendation into an
Action Tracker item on user approval. Surfaced in the **Insights** tab (Dennis
observations + predictive maintenance). An LLM layer can later enrich the same
findings.

**Reports** (`server/services/environmental/reports.ts`): one data model, two
renderers — Excel (`xlsx`) and printable HTML (browser → Save as PDF). Types:
summary, readings/trend, excursions, alarms, calibration, asset register,
device register, insights, audit — with a date range for time-based reports.
`GET /environmental/reports`, `/reports/:type/export`, `/reports/:type/print`.
Surfaced in the **Reports** tab.

## Roadmap (architected for, not yet built)

- **Interactive floor plan** — schema ready (`floor_plan_x/y`,
  `environmental_settings.floor_plan_file_id`); upload a plan and drop live
  asset indicators onto it.
- **Email/SMS/WhatsApp relays** — implement the pending channel adapters against
  the `NotificationChannel` interface (webhook already works for Teams/Slack).
- **LLM-enriched Dennis** — layer the conversational assistant over the
  deterministic insights for narrative summaries.
- **Dennis AI analysis** — recurring pattern detection over
  `environmental_readings` ("exceeded upper limit 3× this month"); recommend
  only, never auto-change.
- **Predictive maintenance** — battery/drift/excursion-frequency trends →
  preventive-maintenance recommendations.
- **Calibration & maintenance registers** — dedicated tables + overdue alerts
  and optional "block expired devices" enforcement (`prevent_expired_devices`).
- **Reports** — daily/weekly/monthly/department/equipment/calibration/alarm/
  excursion/trend/audit, printable + PDF/Excel export (CSV export shipped).
- **Additional parameters** — CO₂, differential pressure, light: add columns +
  per-parameter thresholds; the engine already generalises over a value+band.
- **More protocol drivers** — implement the pending adapters (Modbus/MQTT/BLE/
  USB) against the `EnvDriver` interface.
