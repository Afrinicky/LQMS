#!/usr/bin/env node
/**
 * Stages the mobile PWA for a standalone Vercel deploy.
 *
 * Copies deploy/vercel-mobile.json into dist-mobile/vercel.json so the deployed
 * static site gets the right security headers, a Content-Security-Policy that
 * permits calling the Host over https, and SPA rewrites — without touching the
 * repo-root vercel.json used by the separate Remote Staff Portal deploy.
 *
 * Run after `npm run build:mobile`, then deploy the folder:
 *   npx vercel deploy --prod dist-mobile
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'deploy', 'vercel-mobile.json');
const outDir = path.join(root, 'dist-mobile');
const dst = path.join(outDir, 'vercel.json');

if (!fs.existsSync(path.join(outDir, 'index.html'))) {
  console.error('prepare-vercel-mobile: dist-mobile/index.html missing — run "npm run build:mobile" first.');
  process.exit(1);
}
fs.copyFileSync(src, dst);
console.log('prepare-vercel-mobile: dist-mobile/vercel.json written — deploy with: npx vercel deploy --prod dist-mobile');
