import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Direct SQLite + uploads + evidence + backup + config to the per-user app data
// directory so the installer never writes into Program Files.
if (!process.env.SECH_LIMS_DATA_DIR) {
  process.env.SECH_LIMS_DATA_DIR = path.join(app.getPath('userData'), 'local-data');
}

async function createWindow() {
  const { startLocalApi } = await import('./apiServer.js');
  startLocalApi();
  const win = new BrowserWindow({
    width: 1380,
    height: 860,
    minWidth: 1100,
    minHeight: 720,
    title: 'SECH_LIMS by Nickland',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) await win.loadURL(devUrl); else await win.loadFile(path.join(__dirname, '../dist/index.html'));
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
