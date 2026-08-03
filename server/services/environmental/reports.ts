/**
 * Environmental report builder.
 *
 * One data model feeds two renderers: an Excel workbook (via xlsx) and a
 * printable HTML page (browser → "Save as PDF"). Report types share the same
 * `ReportSheet[]` shape so adding a report is just adding a data builder.
 */
import * as XLSX from 'xlsx';
import { computeInsights } from './insights.js';

type DB = any;
export type ReportSheet = { name: string; headers: string[]; rows: (string | number | null)[][] };
export type Report = { title: string; sheets: ReportSheet[] };

export const REPORT_TYPES = [
  { key: 'summary', label: 'Environmental summary' },
  { key: 'readings', label: 'Readings / trend' },
  { key: 'excursions', label: 'Excursion report' },
  { key: 'alarms', label: 'Alarm report' },
  { key: 'calibration', label: 'Calibration report' },
  { key: 'assets', label: 'Asset register' },
  { key: 'devices', label: 'Device register' },
  { key: 'insights', label: 'Insights & maintenance' },
  { key: 'audit', label: 'Audit report' },
];

const esc = (v: unknown) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function range(from?: string | null, to?: string | null) { return { from: from || '0000', to: to || '9999-12-31T23:59:59Z' }; }

export function buildReport(db: DB, type: string, from?: string | null, to?: string | null): Report {
  const r = range(from, to);
  const rangeLabel = from || to ? ` (${(from || 'start').slice(0, 10)} → ${(to || 'now').slice(0, 10)})` : '';
  switch (type) {
    case 'readings': {
      const rows = db.prepare(`SELECT rd.recorded_at, a.name, rd.source, rd.temperature, rd.humidity, rd.status FROM environmental_readings rd JOIN environmental_assets a ON a.id = rd.asset_id WHERE rd.recorded_at >= ? AND rd.recorded_at <= ? ORDER BY rd.recorded_at DESC LIMIT 20000`).all(r.from, r.to) as any[];
      return { title: `Environmental Readings${rangeLabel}`, sheets: [{ name: 'Readings', headers: ['Recorded at', 'Asset', 'Source', 'Temperature (°C)', 'Humidity (%)', 'Status'], rows: rows.map(x => [x.recorded_at, x.name, x.source, x.temperature, x.humidity, x.status]) }] };
    }
    case 'excursions': {
      const rows = db.prepare(`SELECT a.name, e.parameter, e.acceptable_min, e.acceptable_max, e.started_at, e.ended_at, e.min_value, e.max_value, e.duration_minutes, e.status, nc.nc_number, capa.capa_number FROM environmental_excursions e JOIN environmental_assets a ON a.id = e.asset_id LEFT JOIN nonconforming_events nc ON nc.id = e.nc_id LEFT JOIN capa_records capa ON capa.id = e.capa_id WHERE e.started_at >= ? AND e.started_at <= ? ORDER BY e.started_at DESC`).all(r.from, r.to) as any[];
      return { title: `Excursion Report${rangeLabel}`, sheets: [{ name: 'Excursions', headers: ['Asset', 'Parameter', 'Min limit', 'Max limit', 'Started', 'Ended', 'Observed min', 'Observed max', 'Duration (min)', 'Status', 'NC', 'CAPA'], rows: rows.map(x => [x.name, x.parameter, x.acceptable_min, x.acceptable_max, x.started_at, x.ended_at, x.min_value, x.max_value, x.duration_minutes, x.status, x.nc_number, x.capa_number]) }] };
    }
    case 'alarms': {
      const rows = db.prepare(`SELECT al.triggered_at, a.name, al.alert_type, al.severity, al.message, al.status, al.acknowledged_at FROM environmental_alerts al LEFT JOIN environmental_assets a ON a.id = al.asset_id WHERE al.triggered_at >= ? AND al.triggered_at <= ? ORDER BY al.triggered_at DESC`).all(r.from, r.to) as any[];
      return { title: `Alarm Report${rangeLabel}`, sheets: [{ name: 'Alarms', headers: ['Triggered at', 'Asset', 'Type', 'Severity', 'Message', 'Status', 'Acknowledged at'], rows: rows.map(x => [x.triggered_at, x.name, x.alert_type, x.severity, x.message, x.status, x.acknowledged_at]) }] };
    }
    case 'calibration': {
      const assets = db.prepare('SELECT name, asset_code, calibration_due_date, status FROM environmental_assets ORDER BY calibration_due_date').all() as any[];
      const devices = db.prepare('SELECT name, device_code, calibration_status, calibration_due_date FROM environmental_devices ORDER BY calibration_due_date').all() as any[];
      return { title: `Calibration Report`, sheets: [
        { name: 'Assets', headers: ['Asset', 'Code', 'Calibration due', 'Status'], rows: assets.map(x => [x.name, x.asset_code, x.calibration_due_date, x.status]) },
        { name: 'Devices', headers: ['Device', 'Code', 'Calibration status', 'Calibration due'], rows: devices.map(x => [x.name, x.device_code, x.calibration_status, x.calibration_due_date]) },
      ] };
    }
    case 'assets': {
      const rows = db.prepare(`SELECT a.asset_code, a.name, a.asset_type, l.name loc, a.temp_min, a.temp_max, a.humidity_min, a.humidity_max, a.monitoring_frequency, a.status FROM environmental_assets a LEFT JOIN locations l ON l.id = a.location_id ORDER BY a.name`).all() as any[];
      return { title: 'Environmental Asset Register', sheets: [{ name: 'Assets', headers: ['Code', 'Name', 'Type', 'Location', 'Temp min', 'Temp max', 'Humidity min', 'Humidity max', 'Frequency', 'Status'], rows: rows.map(x => [x.asset_code, x.name, x.asset_type, x.loc, x.temp_min, x.temp_max, x.humidity_min, x.humidity_max, x.monitoring_frequency, x.status]) }] };
    }
    case 'devices': {
      const rows = db.prepare(`SELECT dev.device_code, dev.name, dev.manufacturer, dev.model, dev.communication_method, a.name asset, dev.battery_level, dev.last_communication_at FROM environmental_devices dev LEFT JOIN environmental_assets a ON a.id = dev.asset_id ORDER BY dev.name`).all() as any[];
      return { title: 'Environmental Device Register', sheets: [{ name: 'Devices', headers: ['Code', 'Name', 'Manufacturer', 'Model', 'Communication', 'Asset', 'Battery %', 'Last comm'], rows: rows.map(x => [x.device_code, x.name, x.manufacturer, x.model, x.communication_method, x.asset, x.battery_level, x.last_communication_at]) }] };
    }
    case 'insights': {
      const ins = computeInsights(db);
      return { title: 'Insights & Predictive Maintenance', sheets: [{ name: 'Insights', headers: ['Asset', 'Category', 'Severity', 'Observation', 'Recommendation', 'Maintenance'], rows: ins.map(i => [i.asset_name, i.category, i.severity, i.message, i.recommendation ?? '', i.maintenance ? 'Yes' : 'No']) }] };
    }
    case 'audit': {
      const rows = db.prepare(`SELECT created_at, action, entity, entity_id, actor_user_id FROM audit_logs WHERE entity LIKE 'environmental%' AND created_at >= ? AND created_at <= ? ORDER BY created_at DESC LIMIT 5000`).all(r.from, r.to) as any[];
      return { title: `Environmental Audit Report${rangeLabel}`, sheets: [{ name: 'Audit', headers: ['When', 'Action', 'Entity', 'Entity ID', 'Actor user'], rows: rows.map(x => [x.created_at, x.action, x.entity, x.entity_id, x.actor_user_id]) }] };
    }
    case 'summary':
    default: {
      const assets = db.prepare('SELECT COUNT(*) c FROM environmental_assets WHERE is_active = 1').get() as any;
      const devices = db.prepare('SELECT COUNT(*) c FROM environmental_devices WHERE is_active = 1').get() as any;
      const readCount = db.prepare('SELECT COUNT(*) c FROM environmental_readings WHERE recorded_at >= ? AND recorded_at <= ?').get(r.from, r.to) as any;
      const excCount = db.prepare('SELECT COUNT(*) c FROM environmental_excursions WHERE started_at >= ? AND started_at <= ?').get(r.from, r.to) as any;
      const alarmCount = db.prepare('SELECT COUNT(*) c FROM environmental_alerts WHERE triggered_at >= ? AND triggered_at <= ?').get(r.from, r.to) as any;
      const openExc = db.prepare("SELECT COUNT(*) c FROM environmental_excursions WHERE status = 'open'").get() as any;
      const byAsset = db.prepare(`SELECT a.name, COUNT(e.id) c FROM environmental_assets a LEFT JOIN environmental_excursions e ON e.asset_id = a.id AND e.started_at >= ? AND e.started_at <= ? GROUP BY a.id ORDER BY c DESC`).all(r.from, r.to) as any[];
      return { title: `Environmental Summary${rangeLabel}`, sheets: [
        { name: 'Summary', headers: ['Metric', 'Value'], rows: [['Active assets', assets.c], ['Active devices', devices.c], ['Readings in period', readCount.c], ['Excursions in period', excCount.c], ['Alarms in period', alarmCount.c], ['Open excursions now', openExc.c]] },
        { name: 'Excursions by asset', headers: ['Asset', 'Excursions in period'], rows: byAsset.map(x => [x.name, x.c]) },
      ] };
    }
  }
}

export function reportToWorkbook(report: Report): Buffer {
  const wb = XLSX.utils.book_new();
  for (const s of report.sheets) {
    const ws = XLSX.utils.aoa_to_sheet([[report.title], [s.name], [], s.headers, ...s.rows]);
    XLSX.utils.book_append_sheet(wb, ws, s.name.slice(0, 31));
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

export function reportToHtml(report: Report, autoprint: boolean): string {
  const auto = autoprint ? '<script>window.addEventListener("load",()=>setTimeout(()=>window.print(),250));</script>' : '';
  const sheets = report.sheets.map(s => `<h2>${esc(s.name)}</h2><table><thead><tr>${s.headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${s.rows.length ? s.rows.map(row => `<tr>${row.map(c => `<td>${c == null || c === '' ? '—' : esc(c)}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${s.headers.length}">No data.</td></tr>`}</tbody></table>`).join('');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>${esc(report.title)}</title>
<style>@page{size:A4 landscape;margin:12mm}body{font-family:'Times New Roman',Georgia,serif;color:#111;padding:16px 22px;line-height:1.4}
.no-print{background:#f4f6fb;padding:8px 12px;border:1px solid #ccd;border-radius:6px;margin-bottom:12px;font-size:12px}
h1{font-size:20px;border-bottom:2px solid #1B3A6B;padding-bottom:6px;margin:0 0 12px}
h2{font-size:14px;color:#1B3A6B;margin-top:16px;border-bottom:1px solid #ccd;padding-bottom:3px}
table{border-collapse:collapse;width:100%;font-size:10px;margin:6px 0 12px}
th,td{border:1px solid #aaa;padding:3px 6px;text-align:left;vertical-align:top}
thead th{background:#eef2f7}
.footer{font-size:10px;color:#555;margin-top:20px;border-top:1px solid #ccc;padding-top:6px}
@media print{.no-print{display:none}body{padding:0}}
</style>${auto}</head><body>
<div class="no-print">Choose any printer or "Save as PDF". <button onclick="window.print()">Print</button></div>
<h1>${esc(report.title)}</h1>${sheets}
<div class="footer">SECH_LIMS by Nickland · Generated ${new Date().toISOString().slice(0, 19).replace('T', ' ')}</div>
</body></html>`;
}
