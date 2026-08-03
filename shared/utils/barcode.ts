// Pure-TypeScript Code 128 (Code Set B) barcode → SVG string. No dependencies,
// no DOM, no external services — so it works identically on the server (for
// printed sticker sheets) and in the browser (for on-screen previews) under the
// app's strict content-security policy. Code 128B covers the full printable
// ASCII set, which suits asset tags, reagent/lot labels and specimen labels.

// Canonical Code 128 bar/space width patterns for values 0..106 (106 = stop).
const PATTERNS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
];
const START_B = 104;
const STOP = 106;

export type BarcodeOptions = {
  moduleWidth?: number;   // px per narrow module
  height?: number;        // barcode bar height in px
  showText?: boolean;     // render the human-readable value below
  fontSize?: number;
  quietZone?: number;     // quiet-zone width in modules (min 10)
};

function encode(value: string): number[] {
  const codes: number[] = [START_B];
  let sum = START_B;
  let pos = 1;
  for (const ch of value) {
    let v = ch.charCodeAt(0) - 32; // Code B: ASCII 32..126 → 0..94
    if (v < 0 || v > 94) v = '?'.charCodeAt(0) - 32; // replace unsupported chars
    codes.push(v);
    sum += v * pos;
    pos++;
  }
  codes.push(sum % 103); // checksum
  codes.push(STOP);
  return codes;
}

/** Render a Code 128B barcode for `value` as a self-contained SVG string. */
export function code128Svg(value: string, opts: BarcodeOptions = {}): string {
  const mod = opts.moduleWidth ?? 2;
  const height = opts.height ?? 60;
  const showText = opts.showText !== false;
  const fontSize = opts.fontSize ?? 12;
  const quiet = Math.max(10, opts.quietZone ?? 10);
  const safe = (value || '').toString().slice(0, 48) || ' ';

  const codes = encode(safe);
  let x = quiet;
  const rects: string[] = [];
  for (const code of codes) {
    const pattern = PATTERNS[code] || PATTERNS[0];
    let bar = true; // patterns start with a bar
    for (const ch of pattern) {
      const w = Number(ch) * mod;
      if (bar) rects.push(`<rect x="${x}" y="0" width="${w}" height="${height}" fill="#000"/>`);
      x += w;
      bar = !bar;
    }
  }
  const totalWidth = x + quiet;
  const textH = showText ? fontSize + 4 : 0;
  const svgH = height + textH;
  const text = showText
    ? `<text x="${totalWidth / 2}" y="${height + fontSize}" font-family="'Courier New',monospace" font-size="${fontSize}" text-anchor="middle" fill="#000" letter-spacing="1">${escapeText(safe)}</text>`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalWidth} ${svgH}" width="${totalWidth}" height="${svgH}" preserveAspectRatio="xMidYMid meet"><rect x="0" y="0" width="${totalWidth}" height="${svgH}" fill="#fff"/>${rects.join('')}${text}</svg>`;
}

function escapeText(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}
