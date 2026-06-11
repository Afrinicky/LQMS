import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Direct SQLite + uploads + evidence + backup + config to the per-user app data
// directory so the installer never writes into Program Files.
if (!process.env.SECH_LIMS_DATA_DIR) {
  process.env.SECH_LIMS_DATA_DIR = path.join(app.getPath('userData'), 'local-data');
}

// boot.log persists per-launch diagnostics next to the user data folder so a
// non-developer running the installed app can capture renderer / preload
// failures even when DevTools cannot be opened.
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
bootLog('app.isPackaged', isPackaged);
bootLog('__dirname', __dirname);
bootLog('process.resourcesPath', process.resourcesPath);
bootLog('preload path', preloadPath, 'exists?', fs.existsSync(preloadPath));
bootLog('index.html path', indexHtmlPath, 'exists?', fs.existsSync(indexHtmlPath));
bootLog('SECH_LIMS_DATA_DIR', process.env.SECH_LIMS_DATA_DIR);

async function createWindow() {
  try {
    const { startLocalApi } = await import('./apiServer.js');
    startLocalApi();
    bootLog('local API started');
  } catch (err) {
    bootLog('local API failed to start', String(err));
  }

  const win = new BrowserWindow({
    width: 1380,
    height: 860,
    minWidth: 1100,
    minHeight: 720,
    title: 'SECH_LIMS by Nickland',
    webPreferences: { preload: preloadPath, contextIsolation: true, nodeIntegration: false }
  });

  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    bootLog('did-fail-load', { code, desc, url });
  });
  win.webContents.on('preload-error', (_e, file, err) => {
    bootLog('preload-error', { file, error: String(err) });
  });
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    bootLog('renderer console', { level, message, line, sourceId });
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
  }
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
