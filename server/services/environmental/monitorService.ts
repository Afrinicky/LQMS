/**
 * Environmental monitoring engine.
 *
 * `recordReading` is the single ingest path for BOTH manual and automated
 * readings: it evaluates thresholds, maintains active alerts, opens/closes
 * excursions, and — when an excursion is sustained past the configured
 * duration — auto-creates a Nonconformity (and links a CAPA) using the same
 * record-linking spine as the rest of the QMS.
 *
 * `EnvironmentalPoller` is the background service that drives automated devices
 * on a configurable interval via their communication driver.
 */
import { generateRecordNumber } from '../../utils/recordNumber.js';
import { getDriver } from './drivers.js';

type DB = any;

const TEMP = 'temperature';

function getSettings(db: DB) {
  return db.prepare('SELECT * FROM environmental_settings WHERE id = 1').get() as any
    ?? { excursion_nc_minutes: 30, battery_low_threshold: 20, no_comm_minutes: 15 };
}

/** Classify a value against acceptable + warning-margin bounds. */
function classify(value: number | null | undefined, min: number | null, max: number | null): 'normal' | 'warning' | 'critical' {
  if (value == null || min == null && max == null) return 'normal';
  if ((min != null && value < min) || (max != null && value > max)) return 'critical';
  const span = (max ?? 0) - (min ?? 0);
  const margin = Math.max(0.1, span * 0.1);
  if ((min != null && value < min + margin) || (max != null && value > max - margin)) return 'warning';
  return 'normal';
}

/** Keep exactly one active alert per (asset, type); refresh or open. */
function upsertAlert(db: DB, assetId: number, deviceId: number | null, type: string, severity: string, message: string, value: number | null, excursionId?: number | null) {
  const existing = db.prepare("SELECT id FROM environmental_alerts WHERE asset_id = ? AND alert_type = ? AND status = 'active'").get(assetId, type) as any;
  if (existing) {
    db.prepare('UPDATE environmental_alerts SET severity = ?, message = ?, value = ?, excursion_id = COALESCE(?, excursion_id) WHERE id = ?').run(severity, message, value, excursionId ?? null, existing.id);
    return existing.id as number;
  }
  const r = db.prepare('INSERT INTO environmental_alerts (asset_id, device_id, alert_type, severity, message, value, status, excursion_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(assetId, deviceId, type, severity, message, value, 'active', excursionId ?? null);
  // Surface as an in-app notification for the Facilities & Safety module.
  db.prepare('INSERT INTO notifications (user_id, module_key, title, message, status) VALUES (NULL, ?, ?, ?, ?)')
    .run('facilities_safety', `Environmental alert: ${type.replace(/_/g, ' ')}`, message, 'unread');
  return Number(r.lastInsertRowid);
}

function resolveAlerts(db: DB, assetId: number, types: string[]) {
  const q = types.map(() => '?').join(',');
  db.prepare(`UPDATE environmental_alerts SET status = 'resolved', resolved_at = CURRENT_TIMESTAMP WHERE asset_id = ? AND status = 'active' AND alert_type IN (${q})`).run(assetId, ...types);
}

export type RecordReadingInput = {
  assetId: number; deviceId?: number | null; source?: string;
  temperature?: number | null; humidity?: number | null;
  batteryLevel?: number | null; signalStrength?: number | null;
  recordedAt?: string; recordedByStaffId?: number | null;
  observation?: string | null; correctiveAction?: string | null; manualReason?: string | null; signature?: string | null;
  userId?: number | null;
};

export function recordReading(db: DB, input: RecordReadingInput) {
  const asset = db.prepare('SELECT * FROM environmental_assets WHERE id = ?').get(input.assetId) as any;
  if (!asset) throw new Error('Environmental asset not found');
  const settings = getSettings(db);
  const at = input.recordedAt || new Date().toISOString();
  const temp = input.temperature ?? null;
  const hum = input.humidity ?? null;

  const tempClass = classify(temp, asset.temp_min, asset.temp_max);
  const humClass = asset.humidity_max != null || asset.humidity_min != null ? classify(hum, asset.humidity_min, asset.humidity_max) : 'normal';
  const order = { normal: 0, warning: 1, critical: 2 } as const;
  const status = (order[humClass] > order[tempClass] ? humClass : tempClass);

  const readingId = Number(db.prepare(`INSERT INTO environmental_readings (asset_id, device_id, source, temperature, humidity, battery_level, signal_strength, recorded_at, recorded_by_staff_id, status, observation, corrective_action, manual_reason, signature, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    input.assetId, input.deviceId ?? null, input.source ?? 'manual', temp, hum,
    input.batteryLevel ?? null, input.signalStrength ?? null, at, input.recordedByStaffId ?? null, status,
    input.observation ?? null, input.correctiveAction ?? null, input.manualReason ?? null, input.signature ?? null, input.userId ?? null,
  ).lastInsertRowid);

  if (input.deviceId) {
    db.prepare('UPDATE environmental_devices SET last_communication_at = ?, battery_level = COALESCE(?, battery_level), signal_strength = COALESCE(?, signal_strength) WHERE id = ?')
      .run(at, input.batteryLevel ?? null, input.signalStrength ?? null, input.deviceId);
  }

  // ---- Temperature excursion + alert lifecycle ----
  const tempOut = tempClass === 'critical';
  let excursionId: number | null = null;
  if (temp != null && tempOut) {
    let exc = db.prepare("SELECT * FROM environmental_excursions WHERE asset_id = ? AND parameter = ? AND status = 'open'").get(input.assetId, TEMP) as any;
    if (!exc) {
      excursionId = Number(db.prepare('INSERT INTO environmental_excursions (asset_id, device_id, parameter, acceptable_min, acceptable_max, started_at, max_value, min_value, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(input.assetId, input.deviceId ?? null, TEMP, asset.temp_min, asset.temp_max, at, temp, temp, 'open').lastInsertRowid);
      exc = db.prepare('SELECT * FROM environmental_excursions WHERE id = ?').get(excursionId);
    } else {
      excursionId = exc.id;
      const maxV = Math.max(exc.max_value ?? temp, temp), minV = Math.min(exc.min_value ?? temp, temp);
      const mins = Math.round((new Date(at).getTime() - new Date(exc.started_at).getTime()) / 60000);
      db.prepare('UPDATE environmental_excursions SET max_value = ?, min_value = ?, duration_minutes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(maxV, minV, mins, exc.id);
    }
    const dir = asset.temp_max != null && temp > asset.temp_max ? 'temp_high' : 'temp_low';
    upsertAlert(db, input.assetId, input.deviceId ?? null, dir, 'critical', `${asset.name}: temperature ${temp}°C outside ${asset.temp_min ?? '−'}–${asset.temp_max ?? '−'}°C`, temp, excursionId);

    // Sustained excursion → auto-create Nonconformity (+ CAPA link).
    const durMin = Math.round((new Date(at).getTime() - new Date(exc.started_at).getTime()) / 60000);
    if (!exc.nc_id && durMin >= (settings.excursion_nc_minutes ?? 30)) {
      autoCreateNc(db, input.assetId, excursionId!, asset, input.userId ?? null);
    }
  } else if (temp != null) {
    // Back in range → close temperature excursion and resolve its alerts.
    const open = db.prepare("SELECT * FROM environmental_excursions WHERE asset_id = ? AND parameter = ? AND status = 'open'").get(input.assetId, TEMP) as any;
    if (open) {
      const mins = Math.round((new Date(at).getTime() - new Date(open.started_at).getTime()) / 60000);
      db.prepare("UPDATE environmental_excursions SET status = 'closed', ended_at = ?, duration_minutes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(at, mins, open.id);
    }
    resolveAlerts(db, input.assetId, ['temp_high', 'temp_low']);
  }

  // ---- Humidity alert (advisory; no auto-NC in this phase) ----
  if (hum != null && humClass === 'critical') {
    const dir = asset.humidity_max != null && hum > asset.humidity_max ? 'humidity_high' : 'humidity_low';
    upsertAlert(db, input.assetId, input.deviceId ?? null, dir, 'warning', `${asset.name}: humidity ${hum}% outside ${asset.humidity_min ?? '−'}–${asset.humidity_max ?? '−'}%`, hum);
  } else if (hum != null) {
    resolveAlerts(db, input.assetId, ['humidity_high', 'humidity_low']);
  }

  // ---- Battery low alert ----
  if (input.batteryLevel != null) {
    if (input.batteryLevel < (settings.battery_low_threshold ?? 20)) {
      upsertAlert(db, input.assetId, input.deviceId ?? null, 'battery_low', 'warning', `${asset.name}: device battery ${input.batteryLevel}%`, input.batteryLevel);
    } else {
      resolveAlerts(db, input.assetId, ['battery_low']);
    }
  }
  // A successful reading clears any prior "no communication" alert.
  resolveAlerts(db, input.assetId, ['no_communication', 'sensor_disconnected']);

  return { readingId, status, excursionId };
}

function autoCreateNc(db: DB, assetId: number, excursionId: number, asset: any, userId: number | null) {
  const createdAt = new Date().toISOString();
  const exc = db.prepare('SELECT * FROM environmental_excursions WHERE id = ?').get(excursionId) as any;
  const ncNumber = generateRecordNumber(db, 'nonconforming_events', 'NC', createdAt);
  const ncId = Number(db.prepare(`INSERT INTO nonconforming_events (nc_number, event_date, source_module, source_record_id, title, description, category, severity, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(ncNumber, createdAt.slice(0, 10), 'environmental', String(excursionId),
      `Temperature excursion: ${asset.name}`,
      `Sustained temperature excursion on ${asset.name} (${asset.asset_code}). Acceptable ${asset.temp_min}–${asset.temp_max}°C; observed min ${exc.min_value}°C / max ${exc.max_value}°C since ${exc.started_at}.`,
      'environmental', 'high', 'open', userId, createdAt).lastInsertRowid);
  const capaNumber = generateRecordNumber(db, 'capa_records', 'CAPA', createdAt);
  const capaId = Number(db.prepare(`INSERT INTO capa_records (capa_number, source_module, source_record_id, nc_id, title, problem_summary, priority, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(capaNumber, 'environmental', String(excursionId), ncId, `CAPA for ${asset.name} temperature excursion`, `Investigate and correct the sustained temperature excursion on ${asset.name}.`, 'high', 'open', userId, createdAt).lastInsertRowid);
  db.prepare('UPDATE environmental_excursions SET nc_id = ?, capa_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(ncId, capaId, excursionId);
  db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run('environmental', 'environmental_excursions', String(excursionId), 'nc_capa', 'nonconforming_events', String(ncId), 'Auto-NC from environmental excursion');
  db.prepare('INSERT INTO audit_logs (actor_user_id, action, entity, entity_id, new_value) VALUES (NULL, ?, ?, ?, ?)').run('auto_create', 'nonconforming_events', String(ncId), JSON.stringify({ ncNumber, excursionId, asset: asset.asset_code }));
  return { ncId, capaId };
}

// ---------------------------------------------------------------------------
// Background poller: drives automated devices on a configurable interval.
// ---------------------------------------------------------------------------
export class EnvironmentalPoller {
  private timer: NodeJS.Timeout | null = null;
  private lastPolled = new Map<number, number>();
  constructor(private getDb: () => DB) {}

  start() {
    if (this.timer) return;
    // Fine-grained 30s tick; each device is polled at its own configured cadence.
    this.timer = setInterval(() => { try { this.tick(); } catch { /* keep the loop alive */ } }, 30_000);
    if (this.timer.unref) this.timer.unref();
  }
  stop() { if (this.timer) { clearInterval(this.timer); this.timer = null; } }

  private tick() {
    const db = this.getDb();
    const settings = getSettings(db);
    if (!settings.polling_enabled) return;
    const getAsset = (id: number) => db.prepare('SELECT * FROM environmental_assets WHERE id = ?').get(id);
    const devices = db.prepare("SELECT * FROM environmental_devices WHERE is_active = 1 AND asset_id IS NOT NULL").all() as any[];
    const now = Date.now();
    for (const device of devices) {
      const driver = getDriver(device.driver_key, getAsset);
      if (!driver.automated) continue;
      const interval = (device.poll_interval_seconds || settings.default_poll_interval_seconds || 300) * 1000;
      if (now - (this.lastPolled.get(device.id) ?? 0) < interval) continue;
      this.lastPolled.set(device.id, now);
      void driver.poll(device).then(sample => {
        if (sample.ok) {
          recordReading(db, { assetId: device.asset_id, deviceId: device.id, source: 'automated', temperature: sample.temperature, humidity: sample.humidity, batteryLevel: sample.batteryLevel, signalStrength: sample.signalStrength, recordedAt: sample.recordedAt });
        } else {
          upsertAlert(db, device.asset_id, device.id, 'no_communication', 'warning', `${device.name}: ${sample.error || 'no communication'}`, null);
        }
      }).catch(() => { upsertAlert(db, device.asset_id, device.id, 'no_communication', 'warning', `${device.name}: poll failed`, null); });
    }
  }
}
