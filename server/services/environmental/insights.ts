/**
 * Environmental insights & predictive maintenance.
 *
 * A deterministic, offline analytics engine that reasons over the readings /
 * alerts / excursions history and produces plain-language observations and
 * preventive-maintenance recommendations — the kind of findings the spec asks
 * "Dennis" to surface ("exceeded the upper limit 3 times this month", "afternoon
 * temperatures are creeping up", "this equipment may need servicing").
 *
 * It NEVER changes records. It only recommends; users approve actions. Because
 * it is rule-based it works with no network and no model, and an LLM layer can
 * later enrich these same findings.
 */
type DB = any;

export type Insight = {
  asset_id: number | null;
  asset_name: string;
  category: 'excursion' | 'trend' | 'humidity' | 'communication' | 'battery' | 'calibration' | 'maintenance';
  severity: 'information' | 'warning' | 'critical';
  message: string;
  recommendation?: string;
  maintenance: boolean;
};

const SEV_ORDER = { information: 0, warning: 1, critical: 2 } as const;

function mean(xs: number[]) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }
function std(xs: number[]) { if (xs.length < 2) return 0; const m = mean(xs); return Math.sqrt(mean(xs.map(x => (x - m) ** 2))); }

export function computeInsights(db: DB): Insight[] {
  const out: Insight[] = [];
  const now = Date.now();
  const since30 = new Date(now - 30 * 86400000).toISOString();
  const assets = db.prepare('SELECT * FROM environmental_assets WHERE is_active = 1').all() as any[];

  for (const a of assets) {
    const readings = db.prepare('SELECT temperature, humidity, recorded_at, status FROM environmental_readings WHERE asset_id = ? AND recorded_at >= ? ORDER BY recorded_at').all(a.id, since30) as any[];
    const temps = readings.map(r => r.temperature).filter((t: any): t is number => typeof t === 'number');

    // Excursion frequency (this rolling month).
    const excCount = (db.prepare("SELECT COUNT(*) c FROM environmental_excursions WHERE asset_id = ? AND started_at >= ?").get(a.id, since30) as any).c;
    if (excCount >= 3) {
      out.push({ asset_id: a.id, asset_name: a.name, category: 'maintenance', severity: 'critical', maintenance: true,
        message: `${a.name} recorded ${excCount} temperature excursions in the last 30 days.`,
        recommendation: 'Recurrent excursions suggest a failing unit — schedule preventive maintenance / servicing and review the door seal, load and placement.' });
    } else if (excCount >= 1) {
      out.push({ asset_id: a.id, asset_name: a.name, category: 'excursion', severity: 'warning', maintenance: false,
        message: `${a.name} exceeded its acceptable limits ${excCount} time(s) in the last 30 days.`,
        recommendation: 'Review the excursions and confirm corrective actions were effective.' });
    }

    // Time-of-day drift: afternoons warmer than mornings and trending up.
    if (temps.length >= 12) {
      const morn = readings.filter(r => { const h = new Date(r.recorded_at).getHours(); return h >= 6 && h < 12 && typeof r.temperature === 'number'; }).map(r => r.temperature);
      const aft = readings.filter(r => { const h = new Date(r.recorded_at).getHours(); return h >= 12 && h < 18 && typeof r.temperature === 'number'; }).map(r => r.temperature);
      if (morn.length >= 4 && aft.length >= 4) {
        const diff = mean(aft) - mean(morn);
        if (diff >= 1) out.push({ asset_id: a.id, asset_name: a.name, category: 'trend', severity: 'information', maintenance: false,
          message: `${a.name} runs about ${diff.toFixed(1)}°C warmer in the afternoon than the morning.`,
          recommendation: 'Check afternoon ambient load (sunlight, HVAC, foot traffic, door openings).' });
      }
      // Instability / possible sensor or unit drift.
      const range = (a.temp_max ?? 0) - (a.temp_min ?? 0);
      const sd = std(temps);
      if (range > 0 && sd > range * 0.6) out.push({ asset_id: a.id, asset_name: a.name, category: 'maintenance', severity: 'warning', maintenance: true,
        message: `${a.name} readings are unstable (σ ≈ ${sd.toFixed(1)}°C vs a ${range}°C band).`,
        recommendation: 'Unstable readings can indicate sensor drift or a struggling compressor — verify the sensor and consider preventive maintenance.' });
    }

    // Humidity pattern.
    if (a.humidity_max != null) {
      const humOut = readings.filter(r => typeof r.humidity === 'number' && ((a.humidity_min != null && r.humidity < a.humidity_min) || (a.humidity_max != null && r.humidity > a.humidity_max))).length;
      if (humOut >= 3) out.push({ asset_id: a.id, asset_name: a.name, category: 'humidity', severity: 'warning', maintenance: false,
        message: `${a.name} humidity was outside limits ${humOut} time(s) in the last 30 days.`, recommendation: 'Review ventilation/dehumidification, especially in humid conditions.' });
    }

    // Calibration due / overdue.
    if (a.calibration_due_date) {
      const days = Math.round((new Date(a.calibration_due_date).getTime() - now) / 86400000);
      if (days <= 0) out.push({ asset_id: a.id, asset_name: a.name, category: 'calibration', severity: 'critical', maintenance: true, message: `${a.name} calibration is overdue (due ${a.calibration_due_date}).`, recommendation: 'Arrange calibration before continued use.' });
      else if (days <= 30) out.push({ asset_id: a.id, asset_name: a.name, category: 'calibration', severity: 'warning', maintenance: true, message: `${a.name} calibration is due in ${days} day(s).`, recommendation: 'Schedule calibration.' });
    }
  }

  // Device-level: battery trend, communication reliability, device calibration.
  const devices = db.prepare('SELECT dev.*, a.name AS asset_name FROM environmental_devices dev LEFT JOIN environmental_assets a ON a.id = dev.asset_id WHERE dev.is_active = 1').all() as any[];
  for (const d of devices) {
    const name = d.asset_name || d.name;
    if (d.battery_level != null && d.battery_level < 30) out.push({ asset_id: d.asset_id ?? null, asset_name: name, category: 'battery', severity: d.battery_level < 15 ? 'critical' : 'warning', maintenance: true, message: `${d.name} battery at ${Math.round(d.battery_level)}%.`, recommendation: 'Replace the device battery soon to avoid data gaps.' });
    const noComm = (db.prepare("SELECT COUNT(*) c FROM environmental_alerts WHERE device_id = ? AND alert_type = 'no_communication' AND triggered_at >= ?").get(d.id, since30) as any).c;
    if (noComm >= 3) out.push({ asset_id: d.asset_id ?? null, asset_name: name, category: 'communication', severity: 'warning', maintenance: true, message: `${d.name} lost communication ${noComm} time(s) in the last 30 days.`, recommendation: 'Check power, network/signal and mounting; intermittent comms often precede failure.' });
    if (d.calibration_due_date) {
      const days = Math.round((new Date(d.calibration_due_date).getTime() - now) / 86400000);
      if (days <= 0) out.push({ asset_id: d.asset_id ?? null, asset_name: name, category: 'calibration', severity: 'critical', maintenance: true, message: `${d.name} (device) calibration is overdue.`, recommendation: 'Calibrate or replace the device.' });
    }
  }

  return out.sort((x, y) => SEV_ORDER[y.severity] - SEV_ORDER[x.severity]);
}
