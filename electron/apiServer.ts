import type { Server } from 'node:http';
import { createApiServer } from '../server/index.js';
import { getDb } from '../server/db/database.js';
import { EnvironmentalPoller } from '../server/services/environmental/monitorService.js';
import { config } from '../server/config/index.js';

export type ApiState = { host: string; port: number; baseUrl: string; reused: boolean };

let server: Server | undefined;
let startPromise: Promise<ApiState> | undefined;
let resolved: ApiState | undefined;

export function getApiState(): ApiState | undefined { return resolved; }

function listenAsync(app: ReturnType<typeof createApiServer>, port: number, host: string): Promise<Server> {
  return new Promise((resolve, reject) => {
    const s: Server = app.listen(port, host) as unknown as Server;
    const onErr = (err: NodeJS.ErrnoException) => { s.off('listening', onListening); reject(err); };
    const onListening = () => { s.off('error', onErr); resolve(s); };
    s.once('listening', onListening);
    s.once('error', onErr);
  });
}

async function pingSechLimsHealth(host: string, port: number): Promise<boolean> {
  const url = `http://${host}:${port}/api/health`;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2000);
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) return false;
    const body = await r.json().catch(() => null);
    return body?.product === 'SECH_LIMS by Nickland';
  } catch { return false; }
}

/**
 * Start the embedded host API. Returns the resolved state (host, port, baseUrl, reused).
 *
 * - Idempotent: subsequent calls return the in-flight startup promise or the
 *   already-resolved state, so listen() is never invoked twice within the same
 *   Electron main process.
 * - Default binding is 127.0.0.1; set SECH_LIMS_API_HOST=0.0.0.0 to expose to LAN.
 * - If the requested port is busy and the existing listener IS a SECH_LIMS host
 *   (verified via /api/health), reuse it. Otherwise probe up to 4 fallback ports.
 * - Sets process.env.SECH_LIMS_API_URL and SECH_LIMS_API_PORT so the preload
 *   script and renderer pick up the actually-chosen base URL.
 */
export function startLocalApi(): Promise<ApiState> {
  if (resolved) {
    console.log('[boot] startLocalApi: already started, returning existing state', resolved);
    return Promise.resolve(resolved);
  }
  if (startPromise) {
    console.log('[boot] startLocalApi: startup in progress, returning existing promise');
    return startPromise;
  }

  console.log('[boot] startLocalApi called');
  const requestedPort = config.api.port;
  const host = config.api.host;
  const candidates = [requestedPort, requestedPort + 1, requestedPort + 2, requestedPort + 3, requestedPort + 4];
  console.log('[boot] startLocalApi candidates', { host, candidates });

  startPromise = (async () => {
    const app = createApiServer();
    let lastErr: unknown;
    for (let i = 0; i < candidates.length; i++) {
      const port = candidates[i];
      const isFallback = i > 0;
      try {
        console.log(`[boot] startLocalApi trying ${host}:${port}${isFallback ? ' (fallback)' : ''}`);
        const s = await listenAsync(app, port, host);
        server = s;
        resolved = { host, port, baseUrl: `http://${host}:${port}/api`, reused: false };
        process.env.SECH_LIMS_API_URL = resolved.baseUrl;
        process.env.SECH_LIMS_API_PORT = String(port);
        console.log('[boot] startLocalApi listening', resolved);
        // Start the environmental poller (idle until polling is enabled in settings).
        try { new EnvironmentalPoller(getDb).start(); } catch (e) { console.error('[boot] environmental poller start failed', e); }
        return resolved;
      } catch (err) {
        lastErr = err;
        const code = (err as NodeJS.ErrnoException)?.code;
        console.warn(`[boot] startLocalApi listen failed on ${host}:${port}`, code, String(err));
        if (code === 'EADDRINUSE') {
          const isSechLims = await pingSechLimsHealth(host, port);
          if (isSechLims) {
            resolved = { host, port, baseUrl: `http://${host}:${port}/api`, reused: true };
            process.env.SECH_LIMS_API_URL = resolved.baseUrl;
            process.env.SECH_LIMS_API_PORT = String(port);
            console.log('[boot] startLocalApi reusing existing SECH_LIMS API on', resolved);
            return resolved;
          }
          // Not our app; try the next port.
          continue;
        }
        // Non-EADDRINUSE error — bubble up.
        throw err;
      }
    }
    throw new Error(`Could not bind any SECH_LIMS API port from ${candidates.join(', ')}: ${String(lastErr)}`);
  })();

  // If startup fails, clear the cached promise so a later retry can make a
  // fresh attempt instead of receiving the same rejected promise forever.
  startPromise.catch(() => { startPromise = undefined; });

  return startPromise;
}
