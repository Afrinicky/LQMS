import { defineConfig } from 'vite';

// Stamped into the bundle at build time and shown in the status bar. A LAN
// deployment is updated by pulling source and rebuilding, and it is otherwise
// impossible to tell from the running window whether the build in front of you
// includes a change you just made — the version number alone never moves.
const BUILD_STAMP = new Date().toISOString().slice(0, 16).replace('T', ' ');

export default defineConfig({
  define: { __BUILD_STAMP__: JSON.stringify(BUILD_STAMP) },
  // Absolute base. The packaged renderer is served over http:// from the
  // embedded API server (same origin), NOT file://, so assets must resolve to
  // the origin root (/assets/index-xxxx.js). A relative base ('./') breaks on
  // any nested client route: reloading at /settings/ makes ./assets/… resolve
  // to /settings/assets/…, which the SPA fallback answers with index.html —
  // the JS/CSS then 404 with the wrong MIME type and the app never boots.
  base: '/',
  server: { host: '127.0.0.1', port: 5173 },
  build: {
    outDir: 'dist',
    rollupOptions: {
      // Two entry points: the desktop renderer (index.html → /) and the mobile
      // Staff Companion PWA (mobile.html → served by the Host at /m). Shared code
      // is split into common chunks automatically.
      input: {
        main: 'index.html',
        mobile: 'mobile.html',
      },
    },
  },
});
