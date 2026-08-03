#!/usr/bin/env node
// Copies the hand-authored CommonJS preload into the compiled Electron output
// so electron-builder packages it into resources/app.asar at the same
// dist-electron/electron/preload.cjs path that main.js references.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const src = path.join(root, 'electron', 'preload.cjs');
const dst = path.join(root, 'dist-electron', 'electron', 'preload.cjs');

if (!fs.existsSync(src)) {
  console.error(`copy-preload: source not found: ${src}`);
  process.exit(1);
}
fs.mkdirSync(path.dirname(dst), { recursive: true });
fs.copyFileSync(src, dst);
console.log(`copy-preload: wrote ${path.relative(root, dst)}`);
