/**
 * Environmental device driver architecture.
 *
 * Each communication protocol / manufacturer is a driver that knows how to read
 * a sample from a device. The core monitoring service depends only on the
 * `EnvDriver` interface, so new hardware (LogTag, Testo, Vaisala, Modbus, MQTT,
 * …) is added by dropping in a new driver and registering it — no changes to the
 * ingest, alarm or excursion logic.
 *
 * A driver's `automated` flag tells the poller whether to poll it on a timer.
 * Manual and CSV-import devices are not polled (data arrives via endpoints).
 */

export type EnvReadingSample = {
  ok: boolean;
  temperature?: number | null;
  humidity?: number | null;
  batteryLevel?: number | null;
  signalStrength?: number | null;
  recordedAt?: string;
  error?: string;
};

export type EnvDevice = {
  id: number;
  driver_key: string;
  communication_method: string;
  config_json?: string | null;
  asset_id?: number | null;
  [k: string]: unknown;
};

export interface EnvDriver {
  key: string;
  label: string;
  /** Whether the background poller should poll devices on this driver. */
  automated: boolean;
  poll(device: EnvDevice): Promise<EnvReadingSample>;
}

function parseConfig(device: EnvDevice): Record<string, unknown> {
  if (!device.config_json) return {};
  try { return JSON.parse(device.config_json) as Record<string, unknown>; } catch { return {}; }
}

/** Read a dotted path (e.g. "data.temp") out of an arbitrary JSON object. */
function pick(obj: unknown, path?: unknown): number | null {
  if (!path || typeof path !== 'string') return null;
  let cur: any = obj;
  for (const part of path.split('.')) { if (cur == null) return null; cur = cur[part]; }
  const n = Number(cur);
  return Number.isFinite(n) ? n : null;
}

// --- Manual: never polled; readings are entered by a user. ------------------
const manualDriver: EnvDriver = {
  key: 'manual', label: 'Manual entry', automated: false,
  async poll() { return { ok: false, error: 'Manual device — enter readings by hand.' }; },
};

// --- CSV import: not polled; a file is uploaded and parsed by the route. -----
const csvDriver: EnvDriver = {
  key: 'csv_import', label: 'CSV import', automated: false,
  async poll() { return { ok: false, error: 'CSV device — import a data-logger export file.' }; },
};

// --- Simulator: a fully working automated driver for demos and testing. ------
// Generates readings around the bound asset's acceptable midpoint with noise and
// the occasional excursion so the live dashboard, alarms, excursions and
// auto-NC pipeline can be exercised end-to-end without physical hardware.
function makeSimulatorDriver(getAsset: (id: number) => any): EnvDriver {
  return {
    key: 'simulator', label: 'Simulator (built-in test device)', automated: true,
    async poll(device) {
      const asset = device.asset_id ? getAsset(device.asset_id) : null;
      const tMin = asset?.temp_min ?? 2, tMax = asset?.temp_max ?? 8;
      const mid = (tMin + tMax) / 2, span = Math.max(1, tMax - tMin);
      // ~8% of samples drift outside the band to produce excursions.
      const excursion = Math.random() < 0.08;
      const noise = (Math.random() - 0.5) * span * (excursion ? 2.4 : 0.5);
      const temperature = +(mid + noise + (excursion ? (Math.random() < 0.5 ? -span : span) : 0)).toFixed(2);
      const humidity = asset?.humidity_max != null ? +(((asset.humidity_min ?? 30) + (asset.humidity_max ?? 60)) / 2 + (Math.random() - 0.5) * 8).toFixed(1) : null;
      const batteryLevel = +Math.max(5, 100 - (Date.now() % 100000) / 2000).toFixed(0);
      return { ok: true, temperature, humidity, batteryLevel, signalStrength: 70 + Math.round(Math.random() * 30), recordedAt: new Date().toISOString() };
    },
  };
}

// --- REST API: automated pull from a device/gateway HTTP endpoint. -----------
// config_json: { url, method?, headers?, tempPath, humidityPath?, batteryPath?, signalPath? }
const restDriver: EnvDriver = {
  key: 'rest_api', label: 'REST API', automated: true,
  async poll(device) {
    const cfg = parseConfig(device);
    const url = cfg.url as string | undefined;
    if (!url) return { ok: false, error: 'REST device has no "url" in its configuration.' };
    try {
      const res = await fetch(url, { method: (cfg.method as string) || 'GET', headers: (cfg.headers as Record<string, string>) || undefined });
      if (!res.ok) return { ok: false, error: `Device responded ${res.status}` };
      const json = await res.json();
      return {
        ok: true,
        temperature: pick(json, cfg.tempPath ?? 'temperature'),
        humidity: pick(json, cfg.humidityPath),
        batteryLevel: pick(json, cfg.batteryPath),
        signalStrength: pick(json, cfg.signalPath),
        recordedAt: new Date().toISOString(),
      };
    } catch (e) { return { ok: false, error: (e as Error).message }; }
  },
};

// --- Not-yet-implemented protocols: registered so the UI can list/select them
// and store configuration, but polling reports a clear "driver pending" state
// until a native adapter is added. This keeps the architecture open without
// pretending to support hardware we cannot yet reach from Node.
function pendingDriver(key: string, label: string): EnvDriver {
  return { key, label, automated: false, async poll() { return { ok: false, error: `${label} driver not yet installed on this host.` }; } };
}

export const COMMUNICATION_METHODS = [
  'manual', 'csv_import', 'simulator', 'rest_api', 'mqtt', 'modbus', 'tcp_ip',
  'usb', 'wifi', 'ethernet', 'bluetooth', 'rs232', 'rs485',
] as const;

let registry: Map<string, EnvDriver> | null = null;

/** Build (once) the driver registry. `getAsset` lets drivers read asset bounds. */
export function getDriverRegistry(getAsset: (id: number) => any): Map<string, EnvDriver> {
  if (registry) return registry;
  const drivers: EnvDriver[] = [
    manualDriver, csvDriver, makeSimulatorDriver(getAsset), restDriver,
    pendingDriver('mqtt', 'MQTT'), pendingDriver('modbus', 'Modbus'), pendingDriver('tcp_ip', 'TCP/IP'),
    pendingDriver('usb', 'USB data logger'), pendingDriver('wifi', 'Wi-Fi data logger'),
    pendingDriver('ethernet', 'Ethernet'), pendingDriver('bluetooth', 'Bluetooth sensor'),
    pendingDriver('rs232', 'RS232'), pendingDriver('rs485', 'RS485'),
  ];
  registry = new Map(drivers.map(d => [d.key, d]));
  return registry;
}

export function getDriver(key: string, getAsset: (id: number) => any): EnvDriver {
  return getDriverRegistry(getAsset).get(key) ?? manualDriver;
}

export function listDrivers(getAsset: (id: number) => any) {
  return Array.from(getDriverRegistry(getAsset).values()).map(d => ({ key: d.key, label: d.label, automated: d.automated }));
}
