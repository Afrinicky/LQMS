import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Direct SQLite + uploads + evidence + backup + config to the per-user app data
// directory so the installer never writes into Program Files.
if (!process.env.SECH_LIMS_DATA_DIR) {
  process.env.SECH_LIMS_DATA_DIR = path.join(app.getPath('userData'), 'local-data');
}

// The packaged renderer (dist/) is served by the embedded API over HTTP so the
// window loads from http://127.0.0.1:<port>/ instead of file://. This avoids
// Electron blocking Vite's cross-origin ES module scripts on the opaque file://
// origin (the classic "renderer script did not start" blank screen) and makes
// the renderer same-origin with the API.
const rendererDir = path.join(__dirname, '../../dist');
process.env.SECH_LIMS_RENDERER_DIR = rendererDir;

// Enforce a single Electron main process. Double-clicking the .exe a second
// time would otherwise launch a second process that tries to bind the same
// port and crashes with EADDRINUSE. The second instance just quits and the
// existing window is focused.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
  process.exit(0);
}

const bootLogPath = path.join(app.getPath('userData'), 'boot.log');
function bootLog(...parts: unknown[]) {
  const line = `[${new Date().toISOString()}] ${parts.map(p => typeof p === 'string' ? p : JSON.stringify(p)).join(' ')}\n`;
  try { fs.appendFileSync(bootLogPath, line); } catch { /* ignore */ }
  console.log('[boot]', ...parts);
}

const isPackaged = app.isPackaged;
const preloadPath = path.join(__dirname, 'preload.cjs');
const indexHtmlPath = path.join(rendererDir, 'index.html');

bootLog('main starting');
bootLog('singleInstanceLock', gotSingleInstanceLock);
bootLog('app.isPackaged', isPackaged);
bootLog('__dirname', __dirname);
bootLog('process.resourcesPath', process.resourcesPath);
bootLog('preload path', preloadPath, 'exists?', fs.existsSync(preloadPath));
bootLog('renderer dir', rendererDir, 'index.html exists?', fs.existsSync(indexHtmlPath));
bootLog('SECH_LIMS_DATA_DIR', process.env.SECH_LIMS_DATA_DIR);

let mainWindow: BrowserWindow | null = null;

/* ------------------------------------------------------------------ *
 * Themed boot screens (dark premium theme, matching the app shell).
 * ------------------------------------------------------------------ */
const FLASK_SVG =
  '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M9 3h6"/><path d="M10 3v6.5L5.2 17a2 2 0 0 0 1.7 3h10.2a2 2 0 0 0 1.7-3L14 9.5V3"/><path d="M7.5 14h9"/></svg>';

function shellHtml(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"/><style>
    html,body{height:100%;margin:0}
    body{font-family:Inter,"Segoe UI",system-ui,Arial,sans-serif;color:#F5F8FF;
      background:radial-gradient(1000px 640px at 50% -12%,rgba(47,107,255,0.18),transparent 60%),linear-gradient(160deg,#0A1322 0%,#060A14 100%);
      display:flex;align-items:center;justify-content:center;padding:24px}
    .wrap{display:flex;flex-direction:column;align-items:center;text-align:center;gap:16px;max-width:520px}
    .mark{width:56px;height:56px;border-radius:16px;display:grid;place-items:center;
      background:linear-gradient(140deg,#2F6BFF,#1B49C0);box-shadow:0 10px 30px rgba(47,107,255,0.45)}
    .title{font-size:26px;font-weight:700;letter-spacing:0.02em}
    .sub{font-size:13px;color:#A8B3C7;margin-top:-8px}
    h2{margin:6px 0 0;font-size:18px;font-weight:600}
    p{margin:0;color:#A8B3C7;font-size:13.5px;line-height:1.5}
    .spinner{width:34px;height:34px;border-radius:50%;border:3px solid rgba(78,141,255,0.18);
      border-top-color:#4E8DFF;animation:spin .8s linear infinite}
    @keyframes spin{to{transform:rotate(360deg)}}
    .err-ico{width:54px;height:54px;border-radius:16px;display:grid;place-items:center;
      background:rgba(255,107,125,0.14);border:1px solid rgba(255,107,125,0.28)}
    pre{width:100%;text-align:left;background:#0D1424;border:1px solid rgba(255,255,255,0.08);
      border-radius:10px;padding:12px 14px;color:#A8B3C7;font-size:12px;white-space:pre-wrap;
      font-family:ui-monospace,Consolas,Menlo,monospace}
    button{font-family:inherit;font-size:14px;font-weight:600;color:#fff;border:0;cursor:pointer;
      padding:11px 22px;border-radius:10px;background:linear-gradient(180deg,#4E8DFF,#2F6BFF);
      box-shadow:0 6px 16px rgba(47,107,255,0.32);margin-top:4px}
    .hint{font-size:12px;color:#5A6680;margin-top:6px}
  </style></head><body><div class="wrap">${body}</div></body></html>`;
}

const BRAND_BLOCK =
  `<div class="mark">${FLASK_SVG}</div><div><div class="title">SECH_LIMS</div><div class="sub">by Nickland</div></div>`;

function splashDataUrl(status = 'Starting your laboratory workspace…'): string {
  const body = `${BRAND_BLOCK}<div class="spinner"></div><p>${status}</p>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(shellHtml(body))}`;
}

function errorDataUrl(message: string): string {
  const safe = String(message).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c] as string));
  const body =
    `<div class="err-ico"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#FF6B7D" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg></div>` +
    `<div><div class="title">SECH_LIMS</div><div class="sub">by Nickland</div></div>` +
    `<h2>The workspace could not start</h2>` +
    `<p>The embedded local service did not start. You can retry, and if it keeps failing, restart your computer or reinstall the application.</p>` +
    `<pre>${safe}</pre>` +
    `<button onclick="(window.sechLims&&window.sechLims.relaunch)?window.sechLims.relaunch():location.reload()">Retry</button>` +
    `<div class="hint">Diagnostics are written to the boot log in your app-data folder.</div>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(shellHtml(body))}`;
}

/* ------------------------------------------------------------------ *
 * API startup with retry/backoff.
 * ------------------------------------------------------------------ */
type ApiResult = { ok: boolean; state?: { host: string; port: number; baseUrl: string }; error?: string };

async function bootApiWithRetry(): Promise<ApiResult> {
  const { startLocalApi } = await import('./apiServer.js');
  const delays = [0, 600, 1200, 2400, 3600];
  let lastErr: unknown;
  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (delays[attempt]) await new Promise(r => setTimeout(r, delays[attempt]));
    try {
      const state = await startLocalApi();
      bootLog('local API ready', state, 'attempt', attempt + 1);
      return { ok: true, state };
    } catch (err) {
      lastErr = err;
      bootLog('local API start attempt failed', attempt + 1, String(err));
    }
  }
  return { ok: false, error: String(lastErr) };
}

/* ------------------------------------------------------------------ *
 * Window lifecycle.
 * ------------------------------------------------------------------ */
async function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.focus();
    bootLog('createWindow: existing window focused');
    return mainWindow;
  }

  const win = new BrowserWindow({
    width: 1380,
    height: 860,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: '#080D1A',
    title: 'SECH_LIMS by Nickland',
    show: false,
    webPreferences: { preload: preloadPath, contextIsolation: true, nodeIntegration: false }
  });
  mainWindow = win;

  win.on('closed', () => { if (mainWindow === win) mainWindow = null; });
  win.once('ready-to-show', () => win.show());

  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    bootLog('did-fail-load', { code, desc, url });
  });
  win.webContents.on('preload-error', (_e, file, err) => {
    bootLog('preload-error', { file, error: String(err) });
  });
  win.webContents.on('console-message', (...args: unknown[]) => {
    const [first, ...rest] = args.slice(1); // drop the Event
    if (typeof first === 'object' && first !== null && 'message' in (first as any)) {
      bootLog('renderer console', first as any);
    } else {
      bootLog('renderer console', { level: first, message: rest[0], line: rest[1], sourceId: rest[2] });
    }
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    bootLog('render-process-gone', details);
  });

  // Show the themed splash immediately so there is never a blank window.
  await win.loadURL(splashDataUrl());
  bootLog('splash shown');
  return win;
}

async function loadRenderer(state: { host: string; port: number }) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  try {
    if (devUrl) {
      bootLog('loading dev URL', devUrl);
      await mainWindow.loadURL(devUrl);
    } else {
      const url = `http://${state.host}:${state.port}/`;
      bootLog('loading renderer over http', url);
      await mainWindow.loadURL(url);
    }
    bootLog('renderer load completed');
  } catch (err) {
    bootLog('renderer load failed', String(err));
    if (mainWindow && !mainWindow.isDestroyed()) {
      await mainWindow.loadURL(errorDataUrl(`Could not load the application UI.\n${String(err)}`));
    }
  }
}

ipcMain.on('sech-lims:relaunch', () => {
  bootLog('relaunch requested from renderer');
  app.relaunch();
  app.exit(0);
});

app.on('second-instance', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    bootLog('second-instance: focused existing window');
  }
});

process.on('uncaughtException', (err) => {
  bootLog('uncaughtException', String(err), (err as Error)?.stack ?? '');
  try {
    dialog.showErrorBox(
      'SECH_LIMS by Nickland — fatal error',
      `An unexpected error occurred.\n\n${String(err)}\n\nCheck the log at:\n${bootLogPath}`
    );
  } catch { /* ignore */ }
});
process.on('unhandledRejection', (reason) => {
  bootLog('unhandledRejection', String(reason));
});

async function bootSequence() {
  // 1. Open the window with a themed splash so the user immediately sees a
  //    branded loading screen (never a blank or white window).
  await createWindow();

  // 2. Start the embedded API (which also serves the renderer), with retry.
  const result = await bootApiWithRetry();

  // 3. Either load the real UI from the API origin, or show a themed error.
  if (result.ok && result.state) {
    await loadRenderer(result.state);
  } else {
    const message = result.error ?? 'The local service did not start.';
    bootLog('startup aborted (API failed)', message);
    if (mainWindow && !mainWindow.isDestroyed()) {
      await mainWindow.loadURL(errorDataUrl(message));
    }
  }
}

app.whenReady().then(async () => {
  try {
    await bootSequence();
  } catch (err) {
    bootLog('unexpected startup error', String(err));
    if (mainWindow && !mainWindow.isDestroyed()) {
      try { await mainWindow.loadURL(errorDataUrl(String(err))); } catch { /* ignore */ }
    } else {
      try { dialog.showErrorBox('SECH_LIMS startup error', String(err)); } catch { /* ignore */ }
    }
  }
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    bootLog('activate: re-creating window');
    void bootSequence();
  }
});
