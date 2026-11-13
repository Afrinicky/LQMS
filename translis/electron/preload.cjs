// CommonJS preload. The root package.json sets "type": "module", so a preload
// compiled from TypeScript would be treated as ESM by Node and rejected by
// Electron. Hand-authored .cjs guarantees a CommonJS file in the asar.
//
// It exposes one thing: where the API is. The renderer shares SECHLIMS's own
// api service, which reads `window.sechLims.apiBaseUrl` — so TransLis fills in
// the same key rather than inventing a second one the shared code would have
// to learn about.
const { contextBridge } = require('electron');

const envUrl = process.env.TRANSLIS_API_URL || '';
const port = process.env.TRANSLIS_PORT || '4330';
// A bind address of 0.0.0.0 exposes the host to the network but is not itself
// connectable; the window must always reach it over loopback.
const apiBaseUrl = (envUrl || `http://127.0.0.1:${port}/api`)
  .replace('://0.0.0.0:', '://127.0.0.1:')
  .replace('://[::]:', '://127.0.0.1:');

contextBridge.exposeInMainWorld('sechLims', { apiBaseUrl });
contextBridge.exposeInMainWorld('transLis', { apiBaseUrl, product: 'TransLis' });
