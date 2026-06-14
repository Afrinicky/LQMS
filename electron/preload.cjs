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
});
