// CommonJS preload script. The root package.json sets "type": "module", so a
// preload.js compiled from preload.ts would be treated as ESM by Node and
// rejected by Electron with "Cannot use import statement outside a module".
// Writing the preload as a hand-authored .cjs sidesteps the module-system
// conflict and guarantees a CommonJS file in the asar.
const { contextBridge, ipcRenderer } = require('electron');

// process.env.SECH_LIMS_API_URL is set by electron/main.ts after the embedded
// API has bound a port. The packaged renderer is now served *by* that API over
// http://127.0.0.1:<port>/, so the renderer is same-origin with the API and can
// fall back to location.origin if this value is ever missing.
const apiBaseUrl =
  process.env.SECH_LIMS_API_URL ||
  `http://${process.env.SECH_LIMS_API_HOST || '127.0.0.1'}:${process.env.SECH_LIMS_API_PORT || process.env.API_PORT || '4317'}/api`;

contextBridge.exposeInMainWorld('sechLims', {
  apiBaseUrl,
  // Used by the themed boot/error screen's "Retry" button to request a clean
  // relaunch of the whole application from the main process.
  relaunch: () => ipcRenderer.send('sech-lims:relaunch'),

  // "Open in Microsoft Office" round-trip — Electron-only (no-op surface in a
  // plain browser/dev-server context, where window.sechLims is absent entirely).
  // Opens the stored file with the OS's default app, watches it for saves, and
  // delivers each saved revision back to the renderer as raw bytes so it can be
  // uploaded as a new document version through the normal API.
  openInOffice: (payload) => ipcRenderer.invoke('sech-lims:open-in-office', payload),
  stopOfficeWatch: (watchId) => ipcRenderer.send('sech-lims:stop-office-watch', watchId),
  onOfficeFileChanged: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('sech-lims:office-file-changed', handler);
    return () => ipcRenderer.removeListener('sech-lims:office-file-changed', handler);
  },
});
