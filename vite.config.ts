import { defineConfig } from 'vite';
export default defineConfig({
  // Relative base so the packaged Electron renderer loaded via file:// can
  // resolve ./assets/index-xxxx.js instead of /assets/index-xxxx.js (which
  // resolves to /C:/assets/... and 404s in the installed app).
  base: './',
  server: { host: '127.0.0.1', port: 5173 },
  build: { outDir: 'dist' }
});
