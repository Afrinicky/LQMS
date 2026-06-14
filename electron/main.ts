import { app, BrowserWindow, dialog } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Direct SQLite + uploads + evidence + backup + config to the per-user app data
// directory so the installer never writes into Program Files.
if (!process.env.SECH_LIMS_DATA_DIR) {
  process.env.SECH_LIMS_DATA_DIR = path.join(app.getPath('userData'), 'local-data');
}

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
const indexHtmlPath = path.join(__dirname, '../../dist/index.html');

bootLog('main starting');
bootLog('singleInstanceLock', gotSingleInstanceLock);
bootLog('app.isPackaged', isPackaged);
bootLog('__dirname', __dirname);
bootLog('process.resourcesPath', process.resourcesPath);
bootLog('preload path', preloadPath, 'exists?', fs.existsSync(preloadPath));
bootLog('index.html path', indexHtmlPath, 'exists?', fs.existsSync(indexHtmlPath));
bootLog('SECH_LIMS_DATA_DIR', process.env.SECH_LIMS_DATA_DIR);

let mainWindow: BrowserWindow | null = null;

async function bootApiOnce(): Promise<void> {
  try {
    const { startLocalApi } = await import('./apiServer.js');
    const state = await startLocalApi();
    bootLog('local API ready', state);
  } catch (err) {
    bootLog('local API failed to start', String(err));
    dialog.showErrorBox(
      'SECH_LIMS by Nickland — startup error',
      `The local API could not start.\n\n${String(err)}\n\nCheck the log at:\n${bootLogPath}`
    );
    throw err;
  }
}

async function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.focus();
    bootLog('createWindow: existing window focused');
    return;
  }

  const win = new BrowserWindow({
    width: 1380,
    height: 860,
    minWidth: 1100,
    minHeight: 720,
    title: 'SECH_LIMS by Nickland',
    webPreferences: { preload: preloadPath, contextIsolation: true, nodeIntegration: false }
  });
  mainWindow = win;

  win.on('closed', () => { if (mainWindow === win) mainWindow = null; });

  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    bootLog('did-fail-load', { code, desc, url });
  });
  win.webContents.on('preload-error', (_e, file, err) => {
    bootLog('preload-error', { file, error: String(err) });
  });
  // Electron 32+ emits console-message with a single `details` object
  // ({ level, message, lineNumber, sourceId, frame }). Older versions emit
  // positional arguments (level, message, line, sourceId). Accept both so
  // renderer logs always reach boot.log.
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

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  try {
    if (devUrl) {
      bootLog('loading dev URL', devUrl);
      await win.loadURL(devUrl);
    } else {
      bootLog('loading file', indexHtmlPath);
      await win.loadFile(indexHtmlPath);
    }
    bootLog('window load completed');
  } catch (err) {
    bootLog('window load failed', String(err));
    try {
      const msg = String(err).replace(/`/g, "\\`");
      const html = `<!doctype html><html><body style="font-family:Inter,Segoe UI,Arial,sans-serif;padding:48px;background:#F6F8FC;color:#172033;"><h1>SECH_LIMS — renderer load error</h1><p style=\"color:#DC2626;font-weight:600\">Could not load the application UI.</p><pre style=\"background:#fff;border:1px solid #DDE3F0;border-radius:8px;padding:16px;white-space:pre-wrap;\">${msg}</pre><p>Check the installer and application files.</p></body></html>`;
      await win.loadURL(`data:text/html,${encodeURIComponent(html)}`);
    } catch { /* ignore secondary failures */ }
  }
}

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

app.whenReady().then(async () => {
  try {
    // Create the window first so the user sees progress or errors instead
    // of a transient blank/white screen. Then start the embedded API and
    // let the renderer show any API errors.
    await createWindow();
    try {
      await bootApiOnce();
      bootLog('API started after window creation');
    } catch (err) {
      bootLog('startup aborted (API failed)', String(err));
      // Keep the app running and surface a clear error UI in the renderer
      // so users don't just see a white screen and the app exit.
      if (mainWindow && !mainWindow.isDestroyed()) {
        try {
          const msg = String(err).replace(/`/g, "\\`");
          const html = `<!doctype html><html><body style="font-family:Inter,Segoe UI,Arial,sans-serif;padding:48px;background:#F6F8FC;color:#172033;"><h1>SECH_LIMS — startup error</h1><p style=\"color:#DC2626;font-weight:600\">The embedded API failed to start.</p><pre style=\"background:#fff;border:1px solid #DDE3F0;border-radius:8px;padding:16px;white-space:pre-wrap;\">${msg}</pre><p>See the application log for details.</p></body></html>`;
          await mainWindow.loadURL(`data:text/html,${encodeURIComponent(html)}`);
        } catch { /* best-effort only */ }
      }
    }
  } catch (err) {
    bootLog('unexpected startup error', String(err));
    try { dialog.showErrorBox('SECH_LIMS startup error', String(err)); } catch { /* ignore */ }
  }
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    bootLog('activate: creating window (API already running)');
    void createWindow();
  }
});
