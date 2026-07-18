/**
 * Generates the SECH_LIMS PWA icons with zero external dependencies.
 *
 * Renders the brand mark (a flask on the brand-blue gradient) into PNGs at the
 * sizes a Progressive Web App needs, using 4x supersampling for crisp edges and
 * a hand-rolled PNG encoder (node:zlib for the deflate stream). Re-run with
 * `node scripts/generate-pwa-icons.mjs` after changing the mark.
 *
 * Outputs into public/:
 *   icon-192.png            (any)
 *   icon-512.png            (any)
 *   icon-maskable-512.png   (maskable — full-bleed background, safe-zone glyph)
 *   apple-touch-icon.png    (180, opaque, for iOS "Add to Home Screen")
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
mkdirSync(publicDir, { recursive: true });

// Brand palette (from index.html).
const BG_TOP = [0x2f, 0x6b, 0xff];
const BG_BOT = [0x1b, 0x49, 0xc0];
const WHITE = [0xff, 0xff, 0xff];

const SS = 4; // supersampling factor

function lerp(a, b, t) { return a + (b - a) * t; }
function mix(c1, c2, t) { return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)]; }

// Rounded-rect coverage test: is (x,y) inside the box [0,w]x[0,h] with corner
// radius r? Clamp the point to the inner box and measure the corner distance.
function insideRoundedRect(x, y, w, h, r) {
  if (x < 0 || y < 0 || x > w || y > h) return false;
  const cx = Math.min(Math.max(x, r), w - r);
  const cy = Math.min(Math.max(y, r), h - r);
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

// Point-in-polygon (even-odd).
function inPoly(px, py, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
    if (((yi > py) !== (yj > py)) && (px < ((xj - xi) * (py - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

// Flask silhouette in normalized [0..1] coordinates.
function flaskShapes(N) {
  const s = (v) => v * N;
  const rim = { x0: s(0.40), x1: s(0.60), y0: s(0.205), y1: s(0.25) };
  const neck = [
    [s(0.44), s(0.25)], [s(0.56), s(0.25)], [s(0.575), s(0.44)], [s(0.425), s(0.44)],
  ];
  const body = [
    [s(0.425), s(0.44)], [s(0.575), s(0.44)], [s(0.74), s(0.75)], [s(0.72), s(0.775)],
    [s(0.28), s(0.775)], [s(0.26), s(0.75)],
  ];
  const cross = { x0: s(0.34), x1: s(0.66), y0: s(0.60), y1: s(0.632) };
  return { rim, neck, body, cross };
}

function inRect(x, y, r) { return x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1; }

function renderIcon(size, { maskable = false, opaque = false } = {}) {
  const N = size;
  const hi = N * SS;
  const radius = maskable ? 0 : hi * 0.22;
  const glyph = flaskShapes(hi);
  // Accumulate averaged pixels back down to N.
  const out = Buffer.alloc(N * N * 4);

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const hx = x * SS + sx + 0.5;
          const hy = y * SS + sy + 0.5;
          const insideBg = maskable ? true : insideRoundedRect(hx, hy, hi, hi, radius);
          if (!insideBg) continue;
          const t = hy / hi;
          let col = mix(BG_TOP, BG_BOT, t);
          const isGlyph = inRect(hx, hy, glyph.rim) || inPoly(hx, hy, glyph.neck) ||
            (inPoly(hx, hy, glyph.body) && !inRect(hx, hy, glyph.cross));
          if (isGlyph) col = WHITE;
          r += col[0]; g += col[1]; b += col[2]; a += 255;
        }
      }
      const n = SS * SS;
      const i = (y * N + x) * 4;
      const alpha = opaque ? 255 : Math.round(a / n);
      // Composite over the background where partially covered so edges stay clean.
      out[i] = Math.round(r / n);
      out[i + 1] = Math.round(g / n);
      out[i + 2] = Math.round(b / n);
      out[i + 3] = opaque ? 255 : alpha;
    }
  }
  return out;
}

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'latin1');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(rgba, size) {
  const N = size;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit, RGBA
  const raw = Buffer.alloc(N * (N * 4 + 1));
  for (let y = 0; y < N; y++) {
    raw[y * (N * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (N * 4 + 1) + 1, y * N * 4, y * N * 4 + N * 4);
  }
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const targets = [
  ['icon-192.png', 192, {}],
  ['icon-512.png', 512, {}],
  ['icon-maskable-512.png', 512, { maskable: true }],
  ['apple-touch-icon.png', 180, { maskable: true, opaque: true }],
];
for (const [name, size, opts] of targets) {
  const png = encodePng(renderIcon(size, opts), size);
  writeFileSync(path.join(publicDir, name), png);
  console.log(`wrote public/${name} (${size}x${size}, ${png.length} bytes)`);
}
