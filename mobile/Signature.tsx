/**
 * Electronic-signature capture (Phase 2).
 *
 * A touch/pointer canvas that produces a signature image. The captured PNG is
 * uploaded as evidence and the returned file id is bound to the signature record
 * on the Host (identity, timestamp, device and IP are added server-side). Used
 * by approvals, form completion and acknowledgements.
 */
import { useEffect, useRef, useState } from 'react';
import { api } from '../src/services/api';
import { compressImage } from './native';

export function SignaturePad({ onChange }: { onChange: (dataUrl: string | null) => void }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef(false);
  const [hasInk, setHasInk] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    const ratio = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * ratio; canvas.height = rect.height * ratio;
    const ctx = canvas.getContext('2d');
    if (ctx) { ctx.scale(ratio, ratio); ctx.lineWidth = 2.2; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#0b1220'; }
  }, []);

  function pos(e: React.PointerEvent) {
    const canvas = canvasRef.current!; const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }
  function down(e: React.PointerEvent) {
    e.preventDefault();
    const ctx = canvasRef.current!.getContext('2d'); if (!ctx) return;
    drawing.current = true; const { x, y } = pos(e); ctx.beginPath(); ctx.moveTo(x, y);
    canvasRef.current!.setPointerCapture(e.pointerId);
  }
  function move(e: React.PointerEvent) {
    if (!drawing.current) return;
    const ctx = canvasRef.current!.getContext('2d'); if (!ctx) return;
    const { x, y } = pos(e); ctx.lineTo(x, y); ctx.stroke();
    if (!hasInk) setHasInk(true);
  }
  function up() {
    if (!drawing.current) return;
    drawing.current = false;
    if (hasInk) onChange(canvasRef.current!.toDataURL('image/png'));
  }
  function clear() {
    const canvas = canvasRef.current!; const ctx = canvas.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    setHasInk(false); onChange(null);
  }

  return (
    <div className="m-sign">
      <canvas ref={canvasRef} className="m-sign-canvas" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerLeave={up} />
      <div className="m-sign-row">
        <span className="m-sign-hint">{hasInk ? 'Signed' : 'Sign inside the box'}</span>
        <button type="button" className="m-btn small ghost" onClick={clear}>Clear</button>
      </div>
    </div>
  );
}

/** Convert a signature data URL to a File. */
export function dataUrlToFile(dataUrl: string, name = 'signature.png'): File {
  const [meta, b64] = dataUrl.split(',');
  const mime = /:(.*?);/.exec(meta)?.[1] ?? 'image/png';
  const bin = atob(b64); const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new File([arr], name, { type: mime });
}

/** Upload a signature image and return its Host file id (or null on failure). */
export async function uploadSignatureImage(dataUrl: string): Promise<number | null> {
  try {
    const file = await compressImage(dataUrlToFile(dataUrl), 1000, 0.85);
    const fd = new FormData();
    fd.append('file', file);
    fd.append('storageArea', 'evidence');
    const out = await api<{ id?: number }>('/files', { method: 'POST', body: fd });
    return out.id ?? null;
  } catch {
    return null;
  }
}
