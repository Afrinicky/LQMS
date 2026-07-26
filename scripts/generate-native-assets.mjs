/**
 * Generates the native app-store source assets with zero external dependencies:
 *
 *   build-resources/mobile/icon.png    1024×1024 — app icon (opaque brand mark)
 *   build-resources/mobile/splash.png  2732×2732 — launch splash (dark, centered)
 *
 * These are the source images `@capacitor/assets` expands into every Android and
 * iOS density (`npm run mobile:assets`). Re-run after changing the brand mark:
 *   node scripts/generate-native-assets.mjs
 *
 * Uses a hand-rolled PNG encoder (node:zlib) and the same flask mark as the PWA
 * icons, so no image library is needed.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const outDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'build-resources', 'mobile');
mkdirSync(outDir, { recursive: true });

const BG_TOP = [0x2f, 0x6b, 0xff];
const BG_BOT = [0x1b, 0x49, 0xc0];
const WHITE = [0xff, 0xff, 0xff];
const SPLASH_BG = [0x0a, 0x13, 0x22];
const SS = 4;

const lerp = (a, b, t) => a + (b - a) * t;
const mix = (c1, c2, t) => [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];

function inPoly(px, py, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
    if (((yi > py) !== (yj > py)) && (px < ((xj - xi) * (py - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
const inRect = (x, y, r) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;

// Flask silhouette centered in a box of side N, scaled by `scale` about center.
function flaskShapes(N, scale, cx, cy) {
  const s = (vx, vy) => [cx + (vx - 0.5) * N * scale, cy + (vy - 0.5) * N * scale];
  const rimPts = [[0.40, 0.205], [0.60, 0.205], [0.60, 0.25], [0.40, 0.25]].map(([a, b]) => s(a, b));
  const neck = [[0.44, 0.25], [0.56, 0.25], [0.575, 0.44], [0.425, 0.44]].map(([a, b]) => s(a, b));
  const body = [[0.425, 0.44], [0.575, 0.44], [0.74, 0.75], [0.72, 0.775], [0.28, 0.775], [0.26, 0.75]].map(([a, b]) => s(a, b));
  const crossPts = [[0.34, 0.60], [0.66, 0.60], [0.66, 0.632], [0.34, 0.632]].map(([a, b]) => s(a, b));
  const bbox = (pts) => ({ x0: Math.min(...pts.map(p => p[0])), x1: Math.max(...pts.map(p => p[0])), y0: Math.min(...pts.map(p => p[1])), y1: Math.max(...pts.map(p => p[1])) });
  return { rim: bbox(rimPts), neck, body, cross: bbox(crossPts) };
}

function render(size, { kind }) {
  const N = size, hi = N * SS;
  const out = Buffer.alloc(N * N * 4);
  const glyphScale = kind === 'splash' ? 0.34 : 0.92;
  const glyph = flaskShapes(hi, glyphScale, hi / 2, hi / 2);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const hx = x * SS + sx + 0.5, hy = y * SS + sy + 0.5;
          let col;
          if (kind === 'splash') col = SPLASH_BG.slice();
          else col = mix(BG_TOP, BG_BOT, hy / hi);
          const isGlyph = inRect(hx, hy, glyph.rim) || inPoly(hx, hy, glyph.neck) || (inPoly(hx, hy, glyph.body) && !inRect(hx, hy, glyph.cross));
          if (isGlyph) col = WHITE;
          r += col[0]; g += col[1]; b += col[2];
        }
      }
      const n = SS * SS, i = (y * N + x) * 4;
      out[i] = Math.round(r / n); out[i + 1] = Math.round(g / n); out[i + 2] = Math.round(b / n); out[i + 3] = 255;
    }
  }
  return out;
}

function crc32(buf) { let c = ~0; for (let i = 0; i < buf.length; i++) { c ^= buf[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return (~c) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'latin1');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function encodePng(rgba, size) {
  const N = size, ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc(N * (N * 4 + 1));
  for (let y = 0; y < N; y++) { raw[y * (N * 4 + 1)] = 0; rgba.copy(raw, y * (N * 4 + 1) + 1, y * N * 4, y * N * 4 + N * 4); }
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

for (const [name, size, kind] of [['icon.png', 1024, 'icon'], ['splash.png', 2732, 'splash'], ['splash-dark.png', 2732, 'splash']]) {
  writeFileSync(path.join(outDir, name), encodePng(render(size, { kind }), size));
  console.log(`wrote build-resources/mobile/${name} (${size}x${size})`);
}
