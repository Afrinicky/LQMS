/**
 * The TransLis desktop shell.
 *
 * One window over an embedded host, and very little else. The SECHLIMS shell
 * carries an Office round-trip, a document watcher, a thin-client mode, a
 * backup menu and a boot log; none of that belongs in a middleware that a
 * facility installs on one computer and leaves running.
 *
 * What it does keep is the part that matters on an unattended machine: the
 * window closing does not stop the host. An analyser transmits when it
 * transmits, and somebody shutting the window at the end of a shift must not
 * be the reason a night's results went nowhere. The application lives in the
 * tray and the host keeps listening until the computer is shut down.
 */
import { app, BrowserWindow, Menu, Tray, dialog, nativeImage, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';

// Before anything that reads where the database lives.
if (!process.env.SECH_LIMS_DATA_DIR) {
  process.env.SECH_LIMS_DATA_DIR = path.join(app.getPath('userData'), 'data');
}
process.env.SECH_LIMS_PRODUCT_NAME = 'TransLis';

const here = path.dirname(fileURLToPath(import.meta.url));

let window: BrowserWindow | null = null;
let tray: Tray | null = null;
let server: Server | undefined;
let baseUrl = '';
/** Set when the user really means to leave, as against closing the window. */
let quitting = false;

/** Where the built renderer is, in the packaged app and when run from source. */
function rendererDir(): string | null {
  const candidates = [
    process.env.TRANSLIS_RENDERER_DIR,
    path.resolve(here, '../../dist-translis'),
    path.resolve(here, '../../../dist-translis'),
    path.resolve(process.cwd(), 'dist-translis'),
  ].filter(Boolean) as string[];
  return candidates.find(dir => fs.existsSync(path.join(dir, 'index.html'))) ?? null;
}

/**
 * Start the embedded host, trying a few ports.
 *
 * A busy port here is usually a second copy of TransLis already running, and
 * the honest thing is to move rather than to fail: the analysers are
 * configured against a port, so the one that got there first keeps it.
 */
async function startHost(): Promise<string> {
  const dir = rendererDir();
  if (dir) process.env.TRANSLIS_RENDERER_DIR = dir;

  const { createTransLisServer } = await import('../server/index.js');
  const { listenHost, listenPort } = await import('../server/network.js');
  const { startTransLisServices } = await import('../server/services.js');
  const { getDb } = await import('../../server/db/database.js');

  const host = listenHost();
  const wanted = listenPort();
  const app_ = createTransLisServer();

  for (let port = wanted; port < wanted + 5; port += 1) {
    try {
      server = await new Promise<Server>((resolve, reject) => {
        const s = app_.listen(port, host) as unknown as Server;
        s.once('listening', () => resolve(s));
        s.once('error', reject);
      });
      startTransLisServices(getDb);
      // The window must reach the host over loopback whatever it is bound to:
      // 0.0.0.0 exposes it to the network but is not itself connectable.
      const reachable = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
      console.log(`[translis] host listening on http://${host}:${port}`);
      return `http://${reachable}:${port}`;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e;
    }
  }
  throw new Error(`No free port between ${wanted} and ${wanted + 4}.`);
}

function createWindow() {
  window = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    title: 'TransLis',
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  window.once('ready-to-show', () => window?.show());
  void window.loadURL(baseUrl);

  // Closing the window leaves the host running. An analyser does not wait for
  // somebody to be looking at a screen.
  window.on('close', event => {
    if (quitting) return;
    event.preventDefault();
    window?.hide();
  });
  window.on('closed', () => { window = null; });

  // A link to somewhere else opens in the real browser, not in this window.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(baseUrl)) { void shell.openExternal(url); return { action: 'deny' }; }
    return { action: 'allow' };
  });
}

function show() {
  if (!window) { createWindow(); return; }
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function createTray() {
  // An empty image rather than none: a tray entry with no icon still carries
  // its menu, and a missing icon file must not stop the application starting.
  const iconPath = path.resolve(here, '../../build-resources/translis/tray.png');
  const image = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  tray = new Tray(image);
  tray.setToolTip('TransLis — receiving from the analysers');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open TransLis', click: show },
    { type: 'separator' },
    { label: `Host: ${baseUrl}`, enabled: false },
    { type: 'separator' },
    {
      label: 'Quit — stops receiving',
      click: () => {
        const answer = dialog.showMessageBoxSync({
          type: 'warning',
          buttons: ['Keep running', 'Quit'],
          defaultId: 0,
          cancelId: 0,
          title: 'Quit TransLis?',
          message: 'Quitting stops TransLis receiving from the analysers.',
          detail: 'Anything an analyser transmits while it is closed will not be collected. '
            + 'Closing the window instead leaves it running in the background.',
        });
        if (answer === 1) { quitting = true; app.quit(); }
      },
    },
  ]));
  tray.on('click', show);
}

// One instance. A second launch raises the window the first one owns rather
// than starting a host that would find every port taken.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', show);

  app.whenReady().then(async () => {
    try {
      baseUrl = await startHost();
      process.env.TRANSLIS_API_URL = `${baseUrl}/api`;
      createWindow();
      createTray();
    } catch (e) {
      dialog.showErrorBox('TransLis could not start',
        `${e instanceof Error ? e.message : String(e)}\n\nData folder: ${process.env.SECH_LIMS_DATA_DIR}`);
      app.quit();
    }
  });

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); else show(); });
  // No window-all-closed quit: the host outlives the window on purpose.
  app.on('before-quit', () => { quitting = true; server?.close(); });
}
