/**
 * The extension's icon, drawn rather than imported.
 *
 * A browser action needs real PNGs at four sizes, and a laboratory host that
 * may never see the internet should not need an image editor — or a new
 * dependency — to rebuild them. This writes them with nothing but node's own
 * zlib: a rounded navy tile, a specimen tube, and the fill level that makes it
 * read as a laboratory tool at 16 pixels.
 *
 *   node scripts/make-extension-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const NAVY = [27, 58, 107];
const TEAL = [45, 183, 178];
const WHITE = [255, 255, 255];
const SUPERSAMPLE = 4;

const crcTable = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function png(size, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;    // bit depth
  header[9] = 6;    // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // no per-row filter
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** What colour is at this point of the artwork, in a 0..1 square? */
function sample(x, y) {
  // The tile: a rounded square, so the icon sits well on any toolbar.
  const radius = 0.22;
  const inset = 0.02;
  const inside = (() => {
    const cx = Math.min(Math.max(x, inset + radius), 1 - inset - radius);
    const cy = Math.min(Math.max(y, inset + radius), 1 - inset - radius);
    const dx = x - cx;
    const dy = y - cy;
    return x >= inset && x <= 1 - inset && y >= inset && y <= 1 - inset
      && dx * dx + dy * dy <= radius * radius + 1e-9;
  })();
  if (!inside) return null;

  // The tube: a vertical body with a rounded foot and a flared mouth.
  const bodyLeft = 0.38, bodyRight = 0.62, mouthTop = 0.22, bodyBottom = 0.78;
  const inTube = (() => {
    if (y < mouthTop || y > bodyBottom) return false;
    if (y < mouthTop + 0.05) return x >= bodyLeft - 0.05 && x <= bodyRight + 0.05;
    if (y > bodyBottom - 0.1) {
      const cx = 0.5;
      const cy = bodyBottom - 0.1;
      const rx = (bodyRight - bodyLeft) / 2;
      const dx = (x - cx) / rx;
      const dy = (y - cy) / 0.1;
      return dx * dx + dy * dy <= 1;
    }
    return x >= bodyLeft && x <= bodyRight;
  })();
  if (!inTube) return NAVY;

  // The sample inside it.
  return y > 0.52 ? TEAL : WHITE;
}

function render(size) {
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const colour = sample((x + (sx + 0.5) / SUPERSAMPLE) / size, (y + (sy + 0.5) / SUPERSAMPLE) / size);
          if (!colour) continue;
          r += colour[0]; g += colour[1]; b += colour[2]; a += 255;
        }
      }
      const n = SUPERSAMPLE * SUPERSAMPLE;
      const covered = a / 255;
      const offset = (y * size + x) * 4;
      pixels[offset] = covered ? Math.round(r / covered) : 0;
      pixels[offset + 1] = covered ? Math.round(g / covered) : 0;
      pixels[offset + 2] = covered ? Math.round(b / covered) : 0;
      pixels[offset + 3] = Math.round(a / n);
    }
  }
  return png(size, pixels);
}

const out = path.resolve('extension/icons');
mkdirSync(out, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  writeFileSync(path.join(out, `icon${size}.png`), render(size));
  console.log(`extension/icons/icon${size}.png`);
}
