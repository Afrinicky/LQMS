#!/usr/bin/env node
/**
 * Prepares the native web build for Capacitor.
 *
 * `vite build --config vite.mobile.config.ts` emits the mobile entry as
 * dist-mobile/mobile.html. Capacitor loads index.html by default, so this
 * script renames it. Run automatically by the `build:mobile` npm script.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'dist-mobile');
const from = path.join(outDir, 'mobile.html');
const to = path.join(outDir, 'index.html');

if (!fs.existsSync(from)) {
  console.error(`prepare-capacitor: expected ${path.relative(root, from)} — run the mobile build first.`);
  process.exit(1);
}
fs.renameSync(from, to);
console.log(`prepare-capacitor: ${path.relative(root, to)} ready for Capacitor (webDir=dist-mobile).`);
