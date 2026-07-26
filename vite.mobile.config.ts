import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Dedicated build for the NATIVE mobile app (Capacitor Android/iOS).
//
// The PWA is built by the main vite.config.ts and served by the Host at /m with
// an absolute base. The native shell instead loads its assets from the app
// bundle over capacitor://localhost, so this build:
//   - uses a RELATIVE base ('./') so asset URLs resolve inside the bundle, and
//   - emits only the mobile entry into dist-mobile/.
// scripts/prepare-capacitor.mjs then renames mobile.html → index.html (the file
// Capacitor loads by default) after the build.
const dir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  base: './',
  build: {
    outDir: 'dist-mobile',
    emptyOutDir: true,
    rollupOptions: {
      input: path.resolve(dir, 'mobile.html'),
    },
  },
});
