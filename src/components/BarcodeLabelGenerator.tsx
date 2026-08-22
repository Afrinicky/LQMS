import { useState } from 'react';
import BarcodeSvg from './BarcodeSvg';
import { printLabelSheet, LABEL_PRESETS } from '../utils/labelPrint';
import NumberField from './ui/NumberField';

// Generic barcode label generator — type or paste any values (one per line) and
// print Code 128 stickers. For logistics, storage bins, shelves, files or any
// item that needs a scannable label.

export default function BarcodeLabelGenerator() {
  const [text, setText] = useState('');
  const [title, setTitle] = useState('');
  const [size, setSize] = useState('m');
  const [copies, setCopies] = useState(1);
  const values = text.split('\n').map(v => v.trim()).filter(Boolean);
  const preset = LABEL_PRESETS.find(p => p.key === size) || LABEL_PRESETS[1];

  return <div className="card">
    <h3>Barcode label generator</h3>
    <p className="muted" style={{ marginTop: 0 }}>Type or paste one value per line — each becomes a Code 128 barcode sticker. Use for logistics, storage bins/shelves, file boxes, or anything that needs a scannable label. The same barcodes are read by any USB or camera scanner.</p>
    <div className="form-grid">
      <label>Optional label title<input value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Reagent store" /></label>
      <label>Label size<select value={size} onChange={e => setSize(e.target.value)}>{LABEL_PRESETS.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}</select></label>
      <label>Copies of each<NumberField min={1} max={50} value={copies} onValue={n => setCopies(Math.max(1, n ?? 1))} /></label>
      <label style={{ gridColumn: '1 / -1' }}>Values (one per line)<textarea rows={5} value={text} onChange={e => setText(e.target.value)} placeholder={'STORE-A1\nFREEZER-2\nBOX-2026-001'} /></label>
    </div>
    <button type="button" disabled={values.length === 0} onClick={() => printLabelSheet(values.map(v => ({ barcodeValue: v, title: title || undefined, lines: [v] })), { widthMm: preset.widthMm, heightMm: preset.heightMm, copies, title: 'Barcode labels' })}>🏷️ Print {values.length || 0} label{values.length === 1 ? '' : 's'}{copies > 1 ? ` × ${copies}` : ''}</button>
    {values.length > 0 && <div style={{ marginTop: 14 }}>
      <h4 style={{ marginBottom: 6 }}>Preview</h4>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
        {values.slice(0, 12).map((v, i) => <div key={i} style={{ border: '1px solid #ddd', borderRadius: 6, padding: 8, textAlign: 'center', background: '#fff' }}>
          {title && <div style={{ fontWeight: 700, fontSize: 11 }}>{title}</div>}
          <BarcodeSvg value={v} moduleWidth={1.6} height={40} fontSize={10} width={180} />
        </div>)}
      </div>
      {values.length > 12 && <p className="muted" style={{ fontSize: 12 }}>…and {values.length - 12} more.</p>}
    </div>}
  </div>;
}
