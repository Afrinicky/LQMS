import { code128Svg } from '../../shared/utils/barcode';

// Print a sheet of barcode stickers. Each label is a fixed physical size (mm),
// laid out in a grid that fills the page, ready for label/sticker stock or an
// A4 sheet cut to size. All content is inline SVG/HTML — no external assets.

export type LabelSpec = {
  barcodeValue: string;        // the value encoded in the barcode (e.g. asset number)
  title?: string;              // bold line above the barcode
  lines?: string[];            // extra human-readable lines below the code
};
export type LabelOptions = {
  widthMm?: number;            // label width
  heightMm?: number;           // label height
  columns?: number;            // labels per row (auto if omitted)
  gapMm?: number;
  copies?: number;             // copies of each label
  title?: string;              // document title
};

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

export function printLabelSheet(labels: LabelSpec[], opts: LabelOptions = {}) {
  const w = opts.widthMm ?? 50;
  const h = opts.heightMm ?? 25;
  const gap = opts.gapMm ?? 3;
  const cols = opts.columns ?? Math.max(1, Math.floor((190 + gap) / (w + gap)));
  const copies = Math.max(1, opts.copies ?? 1);
  const expanded: LabelSpec[] = [];
  for (const l of labels) for (let i = 0; i < copies; i++) expanded.push(l);

  const cells = expanded.map(l => {
    // Fit the barcode to the label: scale module width to the label width.
    const modW = Math.max(1, Math.round((w - 8) / 34));
    const barcode = code128Svg(l.barcodeValue, { moduleWidth: modW, height: Math.round(h * 1.6), showText: true, fontSize: 9, quietZone: 6 });
    const extra = (l.lines || []).filter(Boolean).map(t => `<div class="ln">${esc(t)}</div>`).join('');
    return `<div class="lbl">${l.title ? `<div class="ttl">${esc(l.title)}</div>` : ''}<div class="bc">${barcode}</div>${extra}</div>`;
  }).join('');

  const html = `<!doctype html><html><head><meta charset="utf-8"/><title>${esc(opts.title || 'Barcode labels')}</title>
<style>
@page{size:A4;margin:6mm}*{box-sizing:border-box}
html,body{margin:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{font-family:'Segoe UI',system-ui,sans-serif}
.no-print{background:#f4f6fb;padding:8px 12px;border:1px solid #ccd;border-radius:6px;margin:8px;font-size:12px}
.sheet{display:grid;grid-template-columns:repeat(${cols}, ${w}mm);gap:${gap}mm;padding:4mm}
.lbl{width:${w}mm;height:${h}mm;border:1px dotted #bbb;padding:1.5mm;display:flex;flex-direction:column;align-items:center;justify-content:center;overflow:hidden;page-break-inside:avoid}
.lbl .ttl{font-weight:700;font-size:9px;text-align:center;line-height:1.1;margin-bottom:1px;white-space:nowrap;overflow:hidden;max-width:100%}
.lbl .bc{line-height:0}.lbl .bc svg{max-width:100%;height:auto}
.lbl .ln{font-size:8px;color:#333;text-align:center;line-height:1.15;white-space:nowrap;overflow:hidden;max-width:100%}
@media print{.no-print{display:none}.lbl{border:none}}
</style><script>window.addEventListener('load',()=>{setTimeout(()=>window.print(),350)})</script></head>
<body><div class="no-print">${expanded.length} label(s). The print dialog opens automatically — set margins to “None/Default” and scale to 100% for correct sizes. <button onclick="window.print()">Print</button></div>
<div class="sheet">${cells}</div></body></html>`;

  const win = window.open('', '_blank', 'width=900,height=700');
  if (!win) return;
  win.document.open(); win.document.write(html); win.document.close();
}

export const LABEL_PRESETS: { key: string; label: string; widthMm: number; heightMm: number }[] = [
  { key: 's', label: 'Small 38 × 19 mm', widthMm: 38, heightMm: 19 },
  { key: 'm', label: 'Medium 50 × 25 mm', widthMm: 50, heightMm: 25 },
  { key: 'l', label: 'Large 70 × 40 mm', widthMm: 70, heightMm: 40 },
  { key: 'specimen', label: 'Specimen 60 × 30 mm', widthMm: 60, heightMm: 30 },
];
