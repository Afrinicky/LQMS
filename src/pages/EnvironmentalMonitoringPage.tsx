import { FormEvent, useEffect, useState } from 'react';
import PageHeader from '../components/ui/PageHeader';
import { KpiStrip } from '../components/ui';
import { useModules } from '../hooks/useModules';
import { api, API_BASE, getToken } from '../services/api';
import DisabledModule from '../components/DisabledModule';
import type {
  Department, Section, Location, Staff, EquipmentItem,
  EnvAsset, EnvDevice, EnvReading, EnvAlert, EnvExcursion, EnvDashboard, EnvSettings,
  EnvEscalationRule, EnvNotificationQueueItem, EnvChannel, EnvInsight, EnvReportType,
} from '../../shared/types/api';

const tabBar = (active: string, tabs: string[], onChange: (n: string) => void) =>
  <div className="tabs">{tabs.map(n => <button key={n} type="button" className={active === n ? 'active' : ''} onClick={() => onChange(n)}>{n}</button>)}</div>;
const badge = (s?: string) => <span className={`badge ${s ? s.toLowerCase().replace(/\s+/g, '-') : ''}`}>{s ? s.replace(/_/g, ' ') : '—'}</span>;
const fmtTime = (iso?: string | null) => { if (!iso) return '—'; const d = new Date(iso); return isNaN(+d) ? String(iso) : d.toLocaleString(); };
const ago = (iso?: string | null) => { if (!iso) return 'never'; const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000); if (s < 60) return `${Math.round(s)}s ago`; if (s < 3600) return `${Math.round(s / 60)}m ago`; if (s < 86400) return `${Math.round(s / 3600)}h ago`; return `${Math.round(s / 86400)}d ago`; };

function useLookups() {
  const [departments, setDepartments] = useState<Department[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [equipment, setEquipment] = useState<EquipmentItem[]>([]);
  useEffect(() => {
    api<Department[]>('/departments').then(setDepartments).catch(() => {});
    api<Section[]>('/sections').then(setSections).catch(() => {});
    api<Location[]>('/locations').then(setLocations).catch(() => {});
    api<Staff[]>('/staff').then(setStaff).catch(() => {});
    api<EquipmentItem[]>('/equipment').then(setEquipment).catch(() => {});
  }, []);
  return { departments, sections, locations, staff, equipment };
}

// Compact time-series line chart with the acceptable band drawn as a shaded zone.
function TrendChart({ readings, min, max }: { readings: EnvReading[]; min?: number | null; max?: number | null }) {
  const pts = readings.filter(r => r.temperature != null).map(r => ({ t: new Date(r.recorded_at).getTime(), v: r.temperature as number, s: r.status }));
  if (pts.length === 0) return <p className="muted">No temperature readings in this range.</p>;
  const w = 900, h = 320, padL = 46, padR = 16, padT = 16, padB = 30;
  const innerW = w - padL - padR, innerH = h - padT - padB;
  const vals = pts.map(p => p.v).concat([min, max].filter((x): x is number => x != null));
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const span = (hi - lo) || 1; const yMin = lo - span * 0.12, yMax = hi + span * 0.12;
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t || t0 + 1;
  const x = (t: number) => padL + (t1 === t0 ? innerW / 2 : ((t - t0) / (t1 - t0)) * innerW);
  const y = (v: number) => padT + innerH - ((v - yMin) / (yMax - yMin)) * innerH;
  const color = (s: string) => s === 'critical' ? 'var(--danger)' : s === 'warning' ? 'var(--warning)' : 'var(--success)';
  const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(p.t).toFixed(1)} ${y(p.v).toFixed(1)}`).join(' ');
  return <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label="Temperature trend" style={{ width: '100%', height: 'auto', background: '#fff', border: '1px solid var(--border)', borderRadius: 12 }}>
    {min != null && max != null && <rect x={padL} y={y(max)} width={innerW} height={Math.max(0, y(min) - y(max))} fill="rgba(42,157,74,0.10)" />}
    {max != null && <line x1={padL} x2={w - padR} y1={y(max)} y2={y(max)} stroke="var(--danger)" strokeDasharray="4 4" strokeWidth={1} />}
    {min != null && <line x1={padL} x2={w - padR} y1={y(min)} y2={y(min)} stroke="var(--danger)" strokeDasharray="4 4" strokeWidth={1} />}
    {max != null && <text x={padL - 6} y={y(max) + 4} fontSize={10} textAnchor="end" fill="var(--muted)">{max}</text>}
    {min != null && <text x={padL - 6} y={y(min) + 4} fontSize={10} textAnchor="end" fill="var(--muted)">{min}</text>}
    <path d={line} fill="none" stroke="var(--navy, #1B3A6B)" strokeWidth={1.5} />
    {pts.map((p, i) => <circle key={i} cx={x(p.t)} cy={y(p.v)} r={3} fill={color(p.s)} stroke="#fff" strokeWidth={0.8}><title>{new Date(p.t).toLocaleString()} — {p.v}°C ({p.s})</title></circle>)}
    <text x={padL} y={h - 8} fontSize={10} fill="var(--muted)">{new Date(t0).toLocaleString()}</text>
    <text x={w - padR} y={h - 8} fontSize={10} textAnchor="end" fill="var(--muted)">{new Date(t1).toLocaleString()}</text>
  </svg>;
}

const CARD_TONE: Record<string, string> = { normal: 'ok', warning: 'warn', critical: 'crit', offline: 'off', unknown: 'off' };
const TREND_ICON: Record<string, string> = { up: '▲', down: '▼', flat: '▬' };

export function EnvironmentalMonitoringPage({ embedded = false }: { embedded?: boolean } = {}) {
  const { isEnabled } = useModules();
  const { departments, sections, locations, staff, equipment } = useLookups();
  const [tab, setTab] = useState('Live Dashboard');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [dashboard, setDashboard] = useState<EnvDashboard | null>(null);
  const [assets, setAssets] = useState<EnvAsset[]>([]);
  const [devices, setDevices] = useState<EnvDevice[]>([]);
  const [alerts, setAlerts] = useState<EnvAlert[]>([]);
  const [excursions, setExcursions] = useState<EnvExcursion[]>([]);
  const [settings, setSettings] = useState<EnvSettings | null>(null);
  const [drivers, setDrivers] = useState<{ key: string; label: string; automated: boolean }[]>([]);
  const [commMethods, setCommMethods] = useState<string[]>([]);

  const [chartAsset, setChartAsset] = useState<string>('');
  const [chartRange, setChartRange] = useState('24h');
  const [chartData, setChartData] = useState<EnvReading[]>([]);

  const enabled = embedded || isEnabled('facilities_safety');
  function flash(m: string) { setNotice(m); setTimeout(() => setNotice(null), 4000); }

  function loadDashboard() { api<EnvDashboard>('/environmental/dashboard').then(setDashboard).catch(() => {}); }
  function loadAssets() { api<EnvAsset[]>('/environmental/assets').then(setAssets).catch(() => {}); }
  function loadDevices() { api<EnvDevice[]>('/environmental/devices').then(setDevices).catch(() => {}); }
  function loadAlerts() { api<EnvAlert[]>('/environmental/alerts').then(setAlerts).catch(() => {}); }
  function loadExcursions() { api<EnvExcursion[]>('/environmental/excursions').then(setExcursions).catch(() => {}); }
  function loadSettings() { api<EnvSettings>('/environmental/settings').then(setSettings).catch(() => {}); }

  useEffect(() => {
    if (!enabled) return;
    loadDashboard(); loadAssets(); loadDevices(); loadAlerts(); loadExcursions(); loadSettings();
    api<{ drivers: typeof drivers; communicationMethods: string[] }>('/environmental/drivers').then(d => { setDrivers(d.drivers); setCommMethods(d.communicationMethods); }).catch(() => {});
  }, [enabled]);

  // Live auto-refresh of the dashboard every 15s while that tab is open.
  useEffect(() => {
    if (!enabled || tab !== 'Live Dashboard') return;
    const id = setInterval(loadDashboard, 15000);
    return () => clearInterval(id);
  }, [enabled, tab]);

  function loadChart(assetId: string, range: string) {
    if (!assetId) { setChartData([]); return; }
    api<EnvReading[]>(`/environmental/assets/${assetId}/readings?range=${range}`).then(setChartData).catch(() => setChartData([]));
  }
  useEffect(() => { if (tab === 'Charts' && chartAsset) loadChart(chartAsset, chartRange); }, [tab, chartAsset, chartRange]);

  if (!enabled) return <DisabledModule />;

  const TABS = ['Live Dashboard', 'Assets', 'Devices', 'Manual Entry', 'Alerts', 'Excursions', 'Insights', 'Notifications', 'Charts', 'Reports', 'Settings'];

  return <div className="module-page env-mon">
    {!embedded && <PageHeader eyebrow="Facilities and Safety" title="Environmental Monitoring" subtitle="Manual and automated temperature/humidity monitoring, alarms and excursions." />}
    {tabBar(tab, TABS, setTab)}
    {error && <div className="error">{error}</div>}
    {notice && <div className="notice-ok">{notice}</div>}

    {tab === 'Live Dashboard' && <LiveDashboard dashboard={dashboard} onOpenChart={id => { setChartAsset(String(id)); setChartRange('24h'); setTab('Charts'); }} onRefresh={loadDashboard} />}

    {tab === 'Assets' && <AssetsTab assets={assets} devices={devices} lookups={{ departments, sections, locations, staff, equipment }} onChanged={() => { loadAssets(); loadDashboard(); }} onError={setError} onFlash={flash} />}

    {tab === 'Devices' && <DevicesTab devices={devices} assets={assets} locations={locations} drivers={drivers} commMethods={commMethods} onChanged={() => { loadDevices(); loadAssets(); loadDashboard(); }} onError={setError} onFlash={flash} />}

    {tab === 'Manual Entry' && <ManualEntryTab assets={assets} staff={staff} onSaved={() => { loadDashboard(); loadAlerts(); loadExcursions(); }} onError={setError} onFlash={flash} />}

    {tab === 'Alerts' && <AlertsTab alerts={alerts} onChanged={() => { loadAlerts(); loadDashboard(); }} onError={setError} />}

    {tab === 'Excursions' && <ExcursionsTab excursions={excursions} onChanged={() => { loadExcursions(); loadDashboard(); }} onError={setError} onFlash={flash} />}

    {tab === 'Insights' && <InsightsTab onError={setError} onFlash={flash} />}

    {tab === 'Notifications' && <NotificationsTab onError={setError} onFlash={flash} />}

    {tab === 'Reports' && <ReportsTab onError={setError} />}

    {tab === 'Charts' && <div>
      <div className="form-grid" style={{ marginBottom: 12 }}>
        <label>Asset<select value={chartAsset} onChange={e => setChartAsset(e.target.value)}><option value="">— select —</option>{assets.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
        <label>Range<select value={chartRange} onChange={e => setChartRange(e.target.value)}>{['24h', '7d', '30d', '90d'].map(r => <option key={r} value={r}>{r === '24h' ? '24 hours' : r === '7d' ? '7 days' : r === '30d' ? '30 days' : '90 days'}</option>)}</select></label>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
          <button type="button" className="secondary" disabled={!chartData.length} onClick={() => exportCsv(chartData, assets.find(a => String(a.id) === chartAsset)?.name || 'asset')}>Export CSV</button>
        </div>
      </div>
      {chartAsset
        ? <div className="card"><TrendChart readings={chartData} min={assets.find(a => String(a.id) === chartAsset)?.temp_min} max={assets.find(a => String(a.id) === chartAsset)?.temp_max} /></div>
        : <p className="muted">Choose an asset to view its temperature trend. Exports available as CSV; PDF/Excel reporting is on the roadmap.</p>}
    </div>}

    {tab === 'Settings' && <SettingsTab settings={settings} onSaved={() => { loadSettings(); loadDashboard(); }} onError={setError} onFlash={flash} />}
  </div>;
}

function exportCsv(readings: EnvReading[], name: string) {
  const rows = [['recorded_at', 'temperature', 'humidity', 'status', 'source'], ...readings.map(r => [r.recorded_at, r.temperature ?? '', r.humidity ?? '', r.status, r.source])];
  const csv = rows.map(r => r.join(',')).join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  const a = document.createElement('a'); a.href = url; a.download = `${name.replace(/\s+/g, '_')}_readings.csv`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// Compact, self-loading environmental live cards for embedding on another
// module's dashboard (e.g. Facilities & Safety). Renders the same excursion
// cards as the full Live Dashboard, with a small status line and auto-refresh.
export function EnvLiveCards({ onOpenFull }: { onOpenFull?: () => void }) {
  const [dashboard, setDashboard] = useState<EnvDashboard | null>(null);
  useEffect(() => {
    const load = () => api<EnvDashboard>('/environmental/dashboard').then(setDashboard).catch(() => setDashboard(null));
    load();
    const id = setInterval(load, 30000);
    return () => clearInterval(id);
  }, []);
  if (!dashboard) return null;
  const s = dashboard.summary;
  if (s.totalAssets === 0) return null;
  return <section className="alert-section">
    <div className="alert-section-head">
      <h3>Environmental monitoring — live</h3>
      <div className="alert-section-counts">
        {s.critical > 0 && <span className="alert-chip crit">{s.critical} critical</span>}
        {s.warning > 0 && <span className="alert-chip warn">{s.warning} warning</span>}
        {s.openExcursions > 0 && <span className="alert-chip crit">{s.openExcursions} excursion{s.openExcursions === 1 ? '' : 's'}</span>}
        <span className="alert-chip muted">{s.totalAssets} assets</span>
        {onOpenFull && <button type="button" className="alert-more" onClick={onOpenFull}>Open monitoring →</button>}
      </div>
    </div>
    <div className="env-cards">
      {dashboard.cards.map(c => <div key={c.id} className={`env-card tone-${CARD_TONE[c.status] || 'off'}`} style={{ cursor: 'default' }}>
        <div className="env-card-top">
          <span className="env-card-name">{c.name}</span>
          <span className="env-dot" />
        </div>
        <div className="env-card-temp">{c.temperature != null ? `${c.temperature}°C` : '—'} <span className="env-trend">{TREND_ICON[c.trend] || ''}</span></div>
        <div className="env-card-sub">{c.temp_min != null || c.temp_max != null ? `Range ${c.temp_min ?? '−'}–${c.temp_max ?? '−'}°C` : 'No range set'}{c.humidity != null ? ` · ${c.humidity}% RH` : ''}</div>
        <div className="env-card-meta"><span>{badge(c.status)}</span></div>
        <div className="env-card-foot">{c.location_name || c.section_name || '—'} · {c.source === 'automated' ? 'auto' : c.source === 'manual' ? 'manual' : '—'} · {ago(c.last_updated)}</div>
      </div>)}
    </div>
  </section>;
}

function LiveDashboard({ dashboard, onOpenChart, onRefresh }: { dashboard: EnvDashboard | null; onOpenChart: (id: number) => void; onRefresh: () => void }) {
  if (!dashboard) return <p>Loading live dashboard…</p>;
  const s = dashboard.summary;
  return <>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
      <span className="muted">{s.pollingEnabled ? '● Automated polling enabled — updates live' : '○ Automated polling off — using manual/on-demand readings'}</span>
      <button type="button" className="secondary" onClick={onRefresh}>Refresh now</button>
    </div>
    <KpiStrip items={[
      { label: 'Monitored assets', value: s.totalAssets },
      { label: 'Normal', value: s.normal, tone: 'success' },
      { label: 'Warning', value: s.warning, tone: 'warning' },
      { label: 'Critical', value: s.critical, tone: 'danger' },
      { label: 'Offline', value: s.offline },
      { label: 'Active alerts', value: s.activeAlerts, tone: s.activeAlerts ? 'warning' : undefined },
      { label: 'Open excursions', value: s.openExcursions, tone: s.openExcursions ? 'danger' : undefined },
    ]} />
    {dashboard.cards.length === 0 && <p className="muted" style={{ marginTop: 16 }}>No environmental assets yet. Add refrigerators, freezers, incubators or rooms under the Assets tab.</p>}
    <div className="env-cards" style={{ marginTop: 18 }}>
      {dashboard.cards.map(c => <button key={c.id} type="button" className={`env-card tone-${CARD_TONE[c.status] || 'off'}`} onClick={() => onOpenChart(c.id)} title="View trend">
        <div className="env-card-top">
          <span className="env-card-name">{c.name}</span>
          <span className="env-dot" />
        </div>
        <div className="env-card-temp">{c.temperature != null ? `${c.temperature}°C` : '—'} <span className="env-trend">{TREND_ICON[c.trend] || ''}</span></div>
        <div className="env-card-sub">{c.temp_min != null || c.temp_max != null ? `Range ${c.temp_min ?? '−'}–${c.temp_max ?? '−'}°C` : 'No range set'}{c.humidity != null ? ` · ${c.humidity}% RH` : ''}</div>
        <div className="env-card-meta">
          <span>{badge(c.status)}</span>
          {c.device_battery != null && <span title="Battery">🔋 {Math.round(c.device_battery)}%</span>}
          {c.device_signal != null && <span title="Signal">📶 {Math.round(c.device_signal)}%</span>}
        </div>
        <div className="env-card-foot">{c.location_name || c.section_name || '—'} · {c.source === 'automated' ? 'auto' : c.source === 'manual' ? 'manual' : '—'} · {ago(c.last_updated)}</div>
      </button>)}
    </div>
  </>;
}

function AssetsTab({ assets, devices, lookups, onChanged, onError, onFlash }: any) {
  const blank = { name: '', assetType: 'refrigerator', departmentId: '', sectionId: '', locationId: '', responsibleStaffId: '', equipmentId: '', tempMin: '', tempMax: '', humidityMin: '', humidityMax: '', monitoringFrequency: 'continuous', installationDate: '', calibrationDueDate: '', deviceId: '', notes: '' };
  const [form, setForm] = useState(blank);
  async function submit(e: FormEvent) {
    e.preventDefault(); onError(null);
    try {
      const body: any = { ...form };
      ['tempMin', 'tempMax', 'humidityMin', 'humidityMax'].forEach(k => { body[k] = form[k as keyof typeof form] === '' ? null : Number(form[k as keyof typeof form]); });
      await api('/environmental/assets', { method: 'POST', body: JSON.stringify(body) });
      setForm(blank); onChanged(); onFlash('Asset registered.');
    } catch (err) { onError((err as Error).message); }
  }
  async function remove(id: number) { if (!confirm('Delete this asset and its readings link?')) return; try { await api(`/environmental/assets/${id}`, { method: 'DELETE' }); onChanged(); } catch (e) { onError((e as Error).message); } }
  return <>
    <div className="card">
      <h3>Register monitored asset</h3>
      <form className="form-grid" onSubmit={submit}>
        <label>Name<input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required placeholder="e.g. Reagent fridge 1" /></label>
        <label>Asset type<select value={form.assetType} onChange={e => setForm({ ...form, assetType: e.target.value })}>{['refrigerator', 'freezer', 'ultra_low_freezer', 'incubator', 'cold_room', 'room', 'water_bath', 'blood_bank_fridge', 'other'].map(t => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}</select></label>
        <label>Department<select value={form.departmentId} onChange={e => setForm({ ...form, departmentId: e.target.value })}><option value="">—</option>{lookups.departments.map((d: Department) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
        <label>Section<select value={form.sectionId} onChange={e => setForm({ ...form, sectionId: e.target.value })}><option value="">—</option>{lookups.sections.map((s: Section) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label>Location<select value={form.locationId} onChange={e => setForm({ ...form, locationId: e.target.value })}><option value="">—</option>{lookups.locations.map((l: Location) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
        <label>Responsible staff<select value={form.responsibleStaffId} onChange={e => setForm({ ...form, responsibleStaffId: e.target.value })}><option value="">—</option>{lookups.staff.map((s: Staff) => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
        <label>Linked equipment<select value={form.equipmentId} onChange={e => setForm({ ...form, equipmentId: e.target.value })}><option value="">—</option>{lookups.equipment.map((eq: EquipmentItem) => <option key={eq.id} value={eq.id}>{eq.name}</option>)}</select></label>
        <label>Assigned device<select value={form.deviceId} onChange={e => setForm({ ...form, deviceId: e.target.value })}><option value="">— none (manual) —</option>{devices.map((d: EnvDevice) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
        <label>Temp min (°C)<input type="number" step="any" value={form.tempMin} onChange={e => setForm({ ...form, tempMin: e.target.value })} /></label>
        <label>Temp max (°C)<input type="number" step="any" value={form.tempMax} onChange={e => setForm({ ...form, tempMax: e.target.value })} /></label>
        <label>Humidity min (%)<input type="number" step="any" value={form.humidityMin} onChange={e => setForm({ ...form, humidityMin: e.target.value })} /></label>
        <label>Humidity max (%)<input type="number" step="any" value={form.humidityMax} onChange={e => setForm({ ...form, humidityMax: e.target.value })} /></label>
        <label>Monitoring frequency<select value={form.monitoringFrequency} onChange={e => setForm({ ...form, monitoringFrequency: e.target.value })}>{['continuous', 'hourly', 'twice_daily', 'daily', 'weekly'].map(f => <option key={f} value={f}>{f.replace(/_/g, ' ')}</option>)}</select></label>
        <label>Installation date<input type="date" value={form.installationDate} onChange={e => setForm({ ...form, installationDate: e.target.value })} /></label>
        <label>Calibration due<input type="date" value={form.calibrationDueDate} onChange={e => setForm({ ...form, calibrationDueDate: e.target.value })} /></label>
        <button type="submit">Add asset</button>
      </form>
    </div>
    <div className="card" style={{ marginTop: 16 }}>
      <h3>Assets</h3>
      <table className="data-table"><thead><tr><th>Code</th><th>Name</th><th>Type</th><th>Location</th><th>Range °C</th><th>Device</th><th>Status</th><th></th></tr></thead><tbody>
        {assets.map((a: EnvAsset) => <tr key={a.id}><td>{a.asset_code}</td><td>{a.name}</td><td>{(a.asset_type || '—').replace(/_/g, ' ')}</td><td>{a.location_name || '—'}</td><td>{a.temp_min ?? '−'}–{a.temp_max ?? '−'}</td><td>{a.device_name || <span className="muted">manual</span>}</td><td>{badge(a.status)}</td><td><button className="secondary" onClick={() => remove(a.id)}>Delete</button></td></tr>)}
        {assets.length === 0 && <tr><td colSpan={8} className="muted">No assets yet.</td></tr>}
      </tbody></table>
    </div>
  </>;
}

function DevicesTab({ devices, assets, locations, drivers, commMethods, onChanged, onError, onFlash }: any) {
  const blank = { name: '', manufacturer: '', model: '', serialNumber: '', deviceType: '', communicationMethod: 'manual', driverKey: 'manual', firmwareVersion: '', calibrationStatus: '', calibrationDueDate: '', assetId: '', locationId: '', pollIntervalSeconds: '', configJson: '', notes: '' };
  const [form, setForm] = useState(blank);
  const [csv, setCsv] = useState<Record<number, string>>({});
  async function submit(e: FormEvent) {
    e.preventDefault(); onError(null);
    try { await api('/environmental/devices', { method: 'POST', body: JSON.stringify({ ...form, driverKey: form.driverKey || form.communicationMethod }) }); setForm(blank); onChanged(); onFlash('Device registered.'); }
    catch (err) { onError((err as Error).message); }
  }
  async function pollNow(id: number) { onError(null); try { const r = await api<any>(`/environmental/devices/${id}/poll`, { method: 'POST', body: JSON.stringify({}) }); onChanged(); onFlash(`Reading captured: ${r.sample?.temperature ?? '—'}°C (${r.status}).`); } catch (e) { onError((e as Error).message); } }
  async function importCsv(id: number) { const text = csv[id]; if (!text) return; onError(null); try { const r = await api<{ imported: number }>(`/environmental/devices/${id}/import-csv`, { method: 'POST', body: JSON.stringify({ csv: text }) }); onChanged(); onFlash(`Imported ${r.imported} readings.`); setCsv({ ...csv, [id]: '' }); } catch (e) { onError((e as Error).message); } }
  async function onFile(id: number, file?: File) { if (!file) return; setCsv({ ...csv, [id]: await file.text() }); }
  async function remove(id: number) { if (!confirm('Delete this device?')) return; try { await api(`/environmental/devices/${id}`, { method: 'DELETE' }); onChanged(); } catch (e) { onError((e as Error).message); } }
  return <>
    <div className="card">
      <h3>Register device / data logger</h3>
      <p className="muted" style={{ marginTop: 0 }}>Pick a communication method. The <strong>Simulator</strong> driver generates live readings so you can trial the dashboard, alarms and excursions before hardware arrives. REST API and CSV import are ready; other protocols are listed and store configuration for when their adapter is installed.</p>
      <form className="form-grid" onSubmit={submit}>
        <label>Name<input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required /></label>
        <label>Communication<select value={form.communicationMethod} onChange={e => setForm({ ...form, communicationMethod: e.target.value, driverKey: e.target.value })}>{(commMethods.length ? commMethods : ['manual']).map((m: string) => <option key={m} value={m}>{m.replace(/_/g, ' ')}</option>)}</select></label>
        <label>Driver<select value={form.driverKey} onChange={e => setForm({ ...form, driverKey: e.target.value })}>{drivers.map((d: any) => <option key={d.key} value={d.key}>{d.label}{d.automated ? ' (auto)' : ''}</option>)}</select></label>
        <label>Manufacturer<input value={form.manufacturer} onChange={e => setForm({ ...form, manufacturer: e.target.value })} placeholder="e.g. Testo, LogTag, Vaisala" /></label>
        <label>Model<input value={form.model} onChange={e => setForm({ ...form, model: e.target.value })} /></label>
        <label>Serial number<input value={form.serialNumber} onChange={e => setForm({ ...form, serialNumber: e.target.value })} /></label>
        <label>Assigned asset<select value={form.assetId} onChange={e => setForm({ ...form, assetId: e.target.value })}><option value="">—</option>{assets.map((a: EnvAsset) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
        <label>Location<select value={form.locationId} onChange={e => setForm({ ...form, locationId: e.target.value })}><option value="">—</option>{locations.map((l: Location) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
        <label>Poll interval (s)<input type="number" value={form.pollIntervalSeconds} onChange={e => setForm({ ...form, pollIntervalSeconds: e.target.value })} placeholder="default from settings" /></label>
        <label>Firmware<input value={form.firmwareVersion} onChange={e => setForm({ ...form, firmwareVersion: e.target.value })} /></label>
        <label>Calibration due<input type="date" value={form.calibrationDueDate} onChange={e => setForm({ ...form, calibrationDueDate: e.target.value })} /></label>
        <label>Driver config (JSON)<textarea value={form.configJson} onChange={e => setForm({ ...form, configJson: e.target.value })} placeholder='REST e.g. {"url":"http://sensor/api","tempPath":"data.temp"}' /></label>
        <button type="submit">Add device</button>
      </form>
    </div>
    <div className="card" style={{ marginTop: 16 }}>
      <h3>Devices</h3>
      <table className="data-table"><thead><tr><th>Code</th><th>Name</th><th>Comm</th><th>Asset</th><th>Battery</th><th>Last comm</th><th>Actions</th></tr></thead><tbody>
        {devices.map((d: EnvDevice) => <tr key={d.id}>
          <td>{d.device_code}</td><td>{d.name}</td><td>{d.communication_method.replace(/_/g, ' ')}</td><td>{d.asset_name || '—'}</td>
          <td>{d.battery_level != null ? `${Math.round(d.battery_level)}%` : '—'}</td><td>{ago(d.last_communication_at)}</td>
          <td style={{ whiteSpace: 'nowrap' }}>
            {d.asset_id && <button className="secondary" onClick={() => pollNow(d.id)}>Poll now</button>}{' '}
            {d.communication_method === 'csv_import' && d.asset_id && <>
              <input type="file" accept=".csv,text/csv" onChange={e => onFile(d.id, e.target.files?.[0])} style={{ maxWidth: 150 }} />
              <button className="secondary" disabled={!csv[d.id]} onClick={() => importCsv(d.id)}>Import</button>{' '}
            </>}
            <button className="secondary" onClick={() => remove(d.id)}>Delete</button>
          </td>
        </tr>)}
        {devices.length === 0 && <tr><td colSpan={7} className="muted">No devices yet.</td></tr>}
      </tbody></table>
    </div>
  </>;
}

function ManualEntryTab({ assets, staff, onSaved, onError, onFlash }: any) {
  const blank = { assetId: '', temperature: '', humidity: '', recordedByStaffId: '', observation: '', correctiveAction: '', manualReason: '', signature: '' };
  const [form, setForm] = useState(blank);
  async function submit(e: FormEvent) {
    e.preventDefault(); onError(null);
    if (!form.assetId) return onError('Select an asset.');
    try {
      const r = await api<{ status: string }>(`/environmental/assets/${form.assetId}/readings`, { method: 'POST', body: JSON.stringify(form) });
      onFlash(`Reading recorded (${r.status}).`); setForm(blank); onSaved();
    } catch (err) { onError((err as Error).message); }
  }
  return <div className="card">
    <h3>Manual reading</h3>
    <p className="muted" style={{ marginTop: 0 }}>Manual entries are tagged as <em>manual</em> and evaluated by the same alarm/excursion engine as automated readings.</p>
    <form className="form-grid" onSubmit={submit}>
      <label>Asset<select value={form.assetId} onChange={e => setForm({ ...form, assetId: e.target.value })} required><option value="">—</option>{assets.map((a: EnvAsset) => <option key={a.id} value={a.id}>{a.name} ({a.temp_min ?? '−'}–{a.temp_max ?? '−'}°C)</option>)}</select></label>
      <label>Temperature (°C)<input type="number" step="any" value={form.temperature} onChange={e => setForm({ ...form, temperature: e.target.value })} required /></label>
      <label>Humidity (%)<input type="number" step="any" value={form.humidity} onChange={e => setForm({ ...form, humidity: e.target.value })} /></label>
      <label>Recorded by<select value={form.recordedByStaffId} onChange={e => setForm({ ...form, recordedByStaffId: e.target.value })}><option value="">Me</option>{staff.map((s: Staff) => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
      <label>Reason for manual entry<input value={form.manualReason} onChange={e => setForm({ ...form, manualReason: e.target.value })} placeholder="e.g. routine round, device offline" /></label>
      <label>Signature<input value={form.signature} onChange={e => setForm({ ...form, signature: e.target.value })} placeholder="initials" /></label>
      <label>Observation<textarea value={form.observation} onChange={e => setForm({ ...form, observation: e.target.value })} /></label>
      <label>Corrective action<textarea value={form.correctiveAction} onChange={e => setForm({ ...form, correctiveAction: e.target.value })} /></label>
      <button type="submit">Record reading</button>
    </form>
  </div>;
}

function AlertsTab({ alerts, onChanged, onError }: any) {
  const [filter, setFilter] = useState('active');
  const shown = alerts.filter((a: EnvAlert) => filter === 'all' || a.status === filter);
  async function ack(id: number) { try { await api(`/environmental/alerts/${id}/acknowledge`, { method: 'POST', body: JSON.stringify({}) }); onChanged(); } catch (e) { onError((e as Error).message); } }
  async function resolve(id: number) { try { await api(`/environmental/alerts/${id}/resolve`, { method: 'POST', body: JSON.stringify({}) }); onChanged(); } catch (e) { onError((e as Error).message); } }
  return <div className="card">
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
      <h3 style={{ margin: 0 }}>Alerts</h3>
      <select value={filter} onChange={e => setFilter(e.target.value)}>{['active', 'acknowledged', 'resolved', 'all'].map(s => <option key={s} value={s}>{s}</option>)}</select>
    </div>
    <table className="data-table" style={{ marginTop: 10 }}><thead><tr><th>Severity</th><th>Type</th><th>Asset</th><th>Message</th><th>Triggered</th><th>Status</th><th></th></tr></thead><tbody>
      {shown.map((a: EnvAlert) => <tr key={a.id}><td>{badge(a.severity)}</td><td>{a.alert_type.replace(/_/g, ' ')}</td><td>{a.asset_name || '—'}</td><td>{a.message || '—'}</td><td>{fmtTime(a.triggered_at)}</td><td>{badge(a.status)}</td>
        <td style={{ whiteSpace: 'nowrap' }}>{a.status === 'active' && <button className="secondary" onClick={() => ack(a.id)}>Acknowledge</button>}{' '}{a.status !== 'resolved' && <button className="secondary" onClick={() => resolve(a.id)}>Resolve</button>}</td></tr>)}
      {shown.length === 0 && <tr><td colSpan={7} className="muted">No {filter} alerts.</td></tr>}
    </tbody></table>
  </div>;
}

function ExcursionsTab({ excursions, onChanged, onError, onFlash }: any) {
  async function ack(id: number) { try { await api(`/environmental/excursions/${id}/acknowledge`, { method: 'POST', body: JSON.stringify({ investigationStatus: 'investigating' }) }); onChanged(); } catch (e) { onError((e as Error).message); } }
  async function createNc(id: number) { try { const r = await api<{ ncNumber: string }>(`/environmental/excursions/${id}/create-nc`, { method: 'POST', body: JSON.stringify({}) }); onChanged(); onFlash(`Created ${r.ncNumber}.`); } catch (e) { onError((e as Error).message); } }
  return <div className="card">
    <h3>Temperature excursions</h3>
    <p className="muted" style={{ marginTop: 0 }}>An excursion opens when temperature leaves the acceptable band and closes when it returns. Sustained excursions auto-create a Nonconformity (and linked CAPA).</p>
    <table className="data-table"><thead><tr><th>Asset</th><th>Band °C</th><th>Started</th><th>Ended</th><th>Min/Max</th><th>Duration</th><th>Status</th><th>NC / CAPA</th><th></th></tr></thead><tbody>
      {excursions.map((e: EnvExcursion) => <tr key={e.id}><td>{e.asset_name || '—'}</td><td>{e.acceptable_min ?? '−'}–{e.acceptable_max ?? '−'}</td><td>{fmtTime(e.started_at)}</td><td>{e.ended_at ? fmtTime(e.ended_at) : <span className="badge critical">ongoing</span>}</td><td>{e.min_value ?? '−'} / {e.max_value ?? '−'}</td><td>{e.duration_minutes != null ? `${e.duration_minutes}m` : '—'}</td><td>{badge(e.status)}</td><td>{e.nc_number || '—'}{e.capa_number ? ` / ${e.capa_number}` : ''}</td>
        <td style={{ whiteSpace: 'nowrap' }}><button className="secondary" onClick={() => ack(e.id)}>Acknowledge</button>{' '}{!e.nc_id && <button className="secondary" onClick={() => createNc(e.id)}>Create NC</button>}</td></tr>)}
      {excursions.length === 0 && <tr><td colSpan={9} className="muted">No excursions recorded.</td></tr>}
    </tbody></table>
  </div>;
}

function SettingsTab({ settings, onSaved, onError, onFlash }: any) {
  const [f, setF] = useState<any>(null);
  useEffect(() => { if (settings) setF({ pollingEnabled: !!settings.polling_enabled, defaultPollIntervalSeconds: settings.default_poll_interval_seconds, excursionNcMinutes: settings.excursion_nc_minutes, batteryLowThreshold: settings.battery_low_threshold, noCommMinutes: settings.no_comm_minutes, preventExpiredDevices: !!settings.prevent_expired_devices, webhookUrl: (settings as any).webhook_url ?? '' }); }, [settings]);
  if (!f) return <p>Loading settings…</p>;
  async function save(e: FormEvent) { e.preventDefault(); onError(null); try { await api('/environmental/settings', { method: 'PUT', body: JSON.stringify(f) }); onFlash('Settings saved.'); onSaved(); } catch (err) { onError((err as Error).message); } }
  return <div className="card">
    <h3>Monitoring settings</h3>
    <form className="form-grid" onSubmit={save}>
      <label><input type="checkbox" checked={f.pollingEnabled} onChange={e => setF({ ...f, pollingEnabled: e.target.checked })} /> Enable automated polling</label>
      <label>Default poll interval<select value={f.defaultPollIntervalSeconds} onChange={e => setF({ ...f, defaultPollIntervalSeconds: Number(e.target.value) })}>{[[30, '30 seconds'], [60, '1 minute'], [300, '5 minutes'], [600, '10 minutes'], [1800, '30 minutes'], [3600, 'Hourly']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
      <label>Excursion → NC after (minutes)<input type="number" value={f.excursionNcMinutes} onChange={e => setF({ ...f, excursionNcMinutes: Number(e.target.value) })} /></label>
      <label>Battery low threshold (%)<input type="number" value={f.batteryLowThreshold} onChange={e => setF({ ...f, batteryLowThreshold: Number(e.target.value) })} /></label>
      <label>No-communication alert after (minutes)<input type="number" value={f.noCommMinutes} onChange={e => setF({ ...f, noCommMinutes: Number(e.target.value) })} /></label>
      <label><input type="checkbox" checked={f.preventExpiredDevices} onChange={e => setF({ ...f, preventExpiredDevices: e.target.checked })} /> Prevent use of calibration-expired devices</label>
      <label>Webhook URL (Teams/Slack incoming webhook)<input value={f.webhookUrl} onChange={e => setF({ ...f, webhookUrl: e.target.value })} placeholder="https://…" /></label>
      <button type="submit">Save settings</button>
    </form>
    <p className="muted" style={{ marginTop: 12 }}>Configure who gets notified under the <strong>Notifications</strong> tab. The interactive floor plan, predictive maintenance and Dennis analysis build on this data in later phases.</p>
  </div>;
}

function NotificationsTab({ onError, onFlash }: any) {
  const [channels, setChannels] = useState<EnvChannel[]>([]);
  const [rules, setRules] = useState<EnvEscalationRule[]>([]);
  const [queue, setQueue] = useState<EnvNotificationQueueItem[]>([]);
  const blank = { name: '', severity: 'critical', delayMinutes: '0', channel: 'in_app', recipients: '' };
  const [form, setForm] = useState(blank);
  function load() {
    api<EnvChannel[]>('/environmental/channels').then(setChannels).catch(() => {});
    api<EnvEscalationRule[]>('/environmental/escalation-rules').then(setRules).catch(() => {});
    api<EnvNotificationQueueItem[]>('/environmental/notification-queue').then(setQueue).catch(() => {});
  }
  useEffect(() => { load(); }, []);
  async function addRule(e: FormEvent) { e.preventDefault(); onError(null); try { await api('/environmental/escalation-rules', { method: 'POST', body: JSON.stringify(form) }); setForm(blank); load(); onFlash('Escalation rule added.'); } catch (err) { onError((err as Error).message); } }
  async function removeRule(id: number) { if (!confirm('Delete this rule?')) return; try { await api(`/environmental/escalation-rules/${id}`, { method: 'DELETE' }); load(); } catch (e) { onError((e as Error).message); } }
  async function toggleRule(r: EnvEscalationRule) { try { await api(`/environmental/escalation-rules/${r.id}`, { method: 'PUT', body: JSON.stringify({ isActive: !r.is_active }) }); load(); } catch (e) { onError((e as Error).message); } }
  async function test(key: string) { onError(null); try { const r = await api<{ ok: boolean; error?: string }>(`/environmental/channels/${key}/test`, { method: 'POST', body: JSON.stringify({}) }); onFlash(r.ok ? `Test sent via ${key}.` : `Test not sent: ${r.error}`); load(); } catch (e) { onError((e as Error).message); } }
  return <>
    <div className="card">
      <h3>Notification channels</h3>
      <p className="muted" style={{ marginTop: 0 }}>In-app is always on. The Webhook channel posts to a Teams/Slack incoming webhook (set the URL under Settings). Email/SMS/WhatsApp are ready to plug in once a relay is configured on the host.</p>
      <table className="data-table"><thead><tr><th>Channel</th><th>Status</th><th></th></tr></thead><tbody>
        {channels.map(c => <tr key={c.key}><td>{c.label}</td><td>{c.ready ? <span className="badge active">ready</span> : <span className="badge">not configured</span>}</td><td><button className="secondary" onClick={() => test(c.key)}>Send test</button></td></tr>)}
      </tbody></table>
    </div>
    <div className="card" style={{ marginTop: 16 }}>
      <h3>Escalation rules</h3>
      <p className="muted" style={{ marginTop: 0 }}>Each rule notifies a channel when a matching alert has gone unacknowledged for the delay. Delay 0 = notify immediately; larger delays form the escalation ladder.</p>
      <form className="form-grid" onSubmit={addRule}>
        <label>Name<input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required /></label>
        <label>Severity<select value={form.severity} onChange={e => setForm({ ...form, severity: e.target.value })}>{['any', 'information', 'warning', 'critical'].map(s => <option key={s} value={s}>{s}</option>)}</select></label>
        <label>Delay (minutes)<input type="number" min={0} value={form.delayMinutes} onChange={e => setForm({ ...form, delayMinutes: e.target.value })} /></label>
        <label>Channel<select value={form.channel} onChange={e => setForm({ ...form, channel: e.target.value })}>{channels.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}</select></label>
        <label>Recipients<input value={form.recipients} onChange={e => setForm({ ...form, recipients: e.target.value })} placeholder="emails / phones / role (optional)" /></label>
        <button type="submit">Add rule</button>
      </form>
      <table className="data-table" style={{ marginTop: 10 }}><thead><tr><th>Name</th><th>Severity</th><th>Delay</th><th>Channel</th><th>Recipients</th><th>Active</th><th></th></tr></thead><tbody>
        {rules.map(r => <tr key={r.id}><td>{r.name}</td><td>{badge(r.severity)}</td><td>{r.delay_minutes}m</td><td>{r.channel}</td><td>{r.recipients || '—'}</td><td>{r.is_active ? 'Yes' : 'No'}</td>
          <td style={{ whiteSpace: 'nowrap' }}><button className="secondary" onClick={() => toggleRule(r)}>{r.is_active ? 'Disable' : 'Enable'}</button>{' '}<button className="secondary" onClick={() => removeRule(r.id)}>Delete</button></td></tr>)}
        {rules.length === 0 && <tr><td colSpan={7} className="muted">No rules yet.</td></tr>}
      </tbody></table>
    </div>
    <div className="card" style={{ marginTop: 16 }}>
      <h3>Notification log</h3>
      <table className="data-table"><thead><tr><th>When</th><th>Channel</th><th>Subject</th><th>Rule</th><th>Status</th><th>Detail</th></tr></thead><tbody>
        {queue.map(q => <tr key={q.id}><td>{fmtTime(q.created_at)}</td><td>{q.channel}</td><td>{q.subject || '—'}</td><td>{q.rule_name || '—'}</td><td>{badge(q.status)}</td><td>{q.error || (q.sent_at ? 'delivered' : '—')}</td></tr>)}
        {queue.length === 0 && <tr><td colSpan={6} className="muted">No notifications dispatched yet.</td></tr>}
      </tbody></table>
    </div>
  </>;
}

function InsightsTab({ onError, onFlash }: any) {
  const [insights, setInsights] = useState<EnvInsight[]>([]);
  const [loading, setLoading] = useState(true);
  function load() { setLoading(true); api<EnvInsight[]>('/environmental/insights').then(setInsights).catch(() => setInsights([])).finally(() => setLoading(false)); }
  useEffect(() => { load(); }, []);
  async function createAction(i: EnvInsight) {
    onError(null);
    try { await api('/environmental/insights/create-action', { method: 'POST', body: JSON.stringify({ assetId: i.asset_id, title: `${i.asset_name}: ${i.category} follow-up`, description: `${i.message}${i.recommendation ? '\n\nRecommendation: ' + i.recommendation : ''}`, priority: i.severity === 'critical' ? 'high' : 'normal' }) }); onFlash('Action created in the Action Tracker.'); }
    catch (e) { onError((e as Error).message); }
  }
  const maintenance = insights.filter(i => i.maintenance);
  const observations = insights.filter(i => !i.maintenance);
  const row = (i: EnvInsight, k: number) => <div key={k} className={`insight-row sev-${i.severity}`}>
    <div className="insight-main"><strong>{i.asset_name}</strong> <span className="badge">{i.category}</span> {badge(i.severity)}<div>{i.message}</div>{i.recommendation && <div className="muted" style={{ marginTop: 2 }}>→ {i.recommendation}</div>}</div>
    <button type="button" className="secondary" onClick={() => createAction(i)}>Create action</button>
  </div>;
  return <>
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}><h3 style={{ margin: 0 }}>Dennis observations</h3><button className="secondary" onClick={load}>Re-analyse</button></div>
      <p className="muted" style={{ marginTop: 4 }}>Automatic analysis of the last 30 days. These are recommendations only — nothing is changed automatically; you approve any action.</p>
      {loading ? <p>Analysing…</p> : observations.length ? observations.map(row) : <p className="muted">No noteworthy patterns detected.</p>}
    </div>
    <div className="card" style={{ marginTop: 16 }}>
      <h3>Predictive maintenance</h3>
      <p className="muted" style={{ marginTop: 4 }}>Signals that suggest servicing before failure (recurrent excursions, unstable readings, battery, communication, calibration).</p>
      {loading ? <p>Analysing…</p> : maintenance.length ? maintenance.map(row) : <p className="muted">No maintenance signals detected.</p>}
    </div>
  </>;
}

async function fetchAuthedBlob(path: string): Promise<Blob | null> {
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : undefined });
  if (!res.ok) return null;
  return res.blob();
}

function ReportsTab({ onError }: any) {
  const [types, setTypes] = useState<EnvReportType[]>([]);
  const [type, setType] = useState('summary');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  useEffect(() => { api<EnvReportType[]>('/environmental/reports').then(setTypes).catch(() => {}); }, []);
  const qs = () => { const p = new URLSearchParams(); if (from) p.set('from', from); if (to) p.set('to', to); return p.toString() ? `?${p.toString()}` : ''; };
  async function exportExcel() {
    onError(null);
    const blob = await fetchAuthedBlob(`/environmental/reports/${type}/export${qs()}`);
    if (!blob) return onError('Could not generate the report.');
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `Environmental_${type}.xlsx`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
  async function printPdf() {
    onError(null);
    const blob = await fetchAuthedBlob(`/environmental/reports/${type}/print${qs()}`);
    if (!blob) return onError('Could not generate the report.');
    const url = URL.createObjectURL(blob); window.open(url, '_blank'); setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  return <div className="card">
    <h3>Reports</h3>
    <p className="muted" style={{ marginTop: 0 }}>Generate environmental reports as Excel or printable PDF. Date range applies to time-based reports (readings, excursions, alarms, audit, summary).</p>
    <div className="form-grid">
      <label>Report<select value={type} onChange={e => setType(e.target.value)}>{types.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}</select></label>
      <label>From<input type="date" value={from} onChange={e => setFrom(e.target.value)} /></label>
      <label>To<input type="date" value={to} onChange={e => setTo(e.target.value)} /></label>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
        <button type="button" onClick={exportExcel}>Export Excel</button>
        <button type="button" className="secondary" onClick={printPdf}>Print / PDF</button>
      </div>
    </div>
  </div>;
}
