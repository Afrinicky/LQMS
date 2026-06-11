// CommonJS preload script. The root package.json sets "type": "module", so a
// preload.js compiled from preload.ts would be treated as ESM by Node and
// rejected by Electron with "Cannot use import statement outside a module".
// Writing the preload as a hand-authored .cjs sidesteps the module-system
// conflict and guarantees a CommonJS file in the asar.
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('sechLims', {
  apiBaseUrl: process.env.SECH_LIMS_API_URL || 'http://127.0.0.1:4317/api'
});
