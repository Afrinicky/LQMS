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

## Roadmap (architected for, not yet built)

- **Interactive floor plan** — schema ready (`floor_plan_x/y`,
  `environmental_settings.floor_plan_file_id`); upload a plan and drop live
  asset indicators onto it.
- **Notification channels** — email/SMS/WhatsApp/Teams + escalation rules
  (settings has `email_enabled`; a `NotificationQueue` worker plugs in here).
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
