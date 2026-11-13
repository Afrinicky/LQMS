#!/usr/bin/env node
// Copies the hand-authored CommonJS preload into the compiled TransLis Electron
// output, so electron-builder packages it at the same
// dist-translis-electron/translis/electron/preload.cjs path that main.js
// references. Same reasoning as scripts/copy-preload.mjs: the root package is
// ESM, so the preload cannot be compiled from TypeScript.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const src = path.join(root, 'translis', 'electron', 'preload.cjs');
const dst = path.join(root, 'dist-translis-electron', 'translis', 'electron', 'preload.cjs');

if (!fs.existsSync(src)) {
  console.error(`copy-translis-preload: source not found: ${src}`);
  process.exit(1);
}
fs.mkdirSync(path.dirname(dst), { recursive: true });
fs.copyFileSync(src, dst);
console.log(`copy-translis-preload: wrote ${path.relative(root, dst)}`);
