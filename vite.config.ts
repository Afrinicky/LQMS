import { defineConfig } from 'vite';
export default defineConfig({
  // Absolute base. The packaged renderer is served over http:// from the
  // embedded API server (same origin), NOT file://, so assets must resolve to
  // the origin root (/assets/index-xxxx.js). A relative base ('./') breaks on
  // any nested client route: reloading at /settings/ makes ./assets/… resolve
  // to /settings/assets/…, which the SPA fallback answers with index.html —
  // the JS/CSS then 404 with the wrong MIME type and the app never boots.
  base: '/',
  server: { host: '127.0.0.1', port: 5173 },
  build: { outDir: 'dist' }
});
