import { code128Svg, type BarcodeOptions } from '../../shared/utils/barcode';

// Inline Code 128 barcode preview. The SVG is generated locally (no external
// service), so it is safe under the app CSP and prints crisply.
export default function BarcodeSvg({ value, width, ...opts }: { value: string; width?: number | string } & BarcodeOptions) {
  const svg = code128Svg(value, opts);
  return <span style={{ display: 'inline-block', width: width ?? 'auto', lineHeight: 0 }} dangerouslySetInnerHTML={{ __html: svg }} />;
}
