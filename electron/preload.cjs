// CommonJS preload script. The root package.json sets "type": "module", so a
// preload.js compiled from preload.ts would be treated as ESM by Node and
// rejected by Electron with "Cannot use import statement outside a module".
// Writing the preload as a hand-authored .cjs sidesteps the module-system
// conflict and guarantees a CommonJS file in the asar.
const { contextBridge } = require('electron');

// process.env.SECH_LIMS_API_URL is set by electron/main.ts after the embedded
// API has bound a port. Because the BrowserWindow is created only after the
// API is ready, this preload script sees the actually-resolved URL — including
// the fallback port if 4317 was busy.
const apiBaseUrl =
  process.env.SECH_LIMS_API_URL ||
  `http://${process.env.SECH_LIMS_API_HOST || '127.0.0.1'}:${process.env.SECH_LIMS_API_PORT || process.env.API_PORT || '4317'}/api`;

contextBridge.exposeInMainWorld('sechLims', { apiBaseUrl });
