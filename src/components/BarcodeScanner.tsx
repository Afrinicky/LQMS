import { useEffect, useRef, useState } from 'react';
import { Notice } from './ui/Feedback';

// Barcode input that works with the two common lab setups:
//   1. USB "keyboard-wedge" scanners — they type the code into the focused
//      field and press Enter. Nothing to install; just scan into the box.
//   2. Camera scanning via the browser's native BarcodeDetector (Chromium /
//      the desktop app), where a secure camera context is available.
// Emits the decoded value through onScan. Manual typing also works.

type BarcodeDetectorLike = { detect: (src: CanvasImageSource) => Promise<Array<{ rawValue: string }>> };

export default function BarcodeScanner({ onScan, placeholder = 'Scan or type a barcode…', autoFocus = true }: { onScan: (code: string) => void; placeholder?: string; autoFocus?: boolean }) {
  const [value, setValue] = useState('');
  const [camOn, setCamOn] = useState(false);
  const [camError, setCamError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastRef = useRef<{ code: string; at: number }>({ code: '', at: 0 });
  const hasDetector = typeof (window as any).BarcodeDetector !== 'undefined';

  useEffect(() => { if (autoFocus) inputRef.current?.focus(); }, [autoFocus]);

  // Not a <form>. A scanner is often placed inside another form — adding an
  // item while scanning the barcode off the box — and a form inside a form is
  // invalid, so Enter is handled on the field itself and kept from reaching
  // whatever form surrounds it.
  function submit() {
    const v = value.trim();
    if (v) { onScan(v); setValue(''); inputRef.current?.focus(); }
  }

  function stopCam() {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    setCamOn(false);
  }
  async function startCam() {
    setCamError(null);
    if (!hasDetector) { setCamError('Camera barcode scanning is not supported by this browser. Use a USB scanner or type the code.'); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      streamRef.current = stream; setCamOn(true);
      if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play(); }
      const Detector = (window as any).BarcodeDetector;
      const detector: BarcodeDetectorLike = new Detector({ formats: ['code_128', 'code_39', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'qr_code', 'codabar', 'itf'] });
      const tick = async () => {
        if (!streamRef.current || !videoRef.current) return;
        try {
          const found = await detector.detect(videoRef.current);
          if (found && found[0]?.rawValue) {
            const code = found[0].rawValue;
            const now = Date.now();
            if (code !== lastRef.current.code || now - lastRef.current.at > 1500) { lastRef.current = { code, at: now }; onScan(code); }
          }
        } catch { /* frame not ready */ }
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    } catch (e) { setCamError((e as Error).message || 'Could not access the camera.'); setCamOn(false); }
  }
  useEffect(() => () => stopCam(), []);

  return <div>
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <input ref={inputRef} value={value} onChange={e => setValue(e.target.value)} placeholder={placeholder} style={{ minWidth: 220 }}
        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }} />
      <button type="button" onClick={submit}>Enter</button>
      <button type="button" className="secondary" onClick={() => (camOn ? stopCam() : startCam())}>{camOn ? 'Stop camera' : '📷 Scan with camera'}</button>
      <span className="muted" style={{ fontSize: 12 }}>USB scanners type into the box automatically.</span>
    </div>
    {camError && <Notice kind="error" style={{ marginTop: 6 }}>{camError}</Notice>}
    {camOn && <div style={{ marginTop: 8 }}><video ref={videoRef} style={{ width: '100%', maxWidth: 360, borderRadius: 8, border: '1px solid #ccc' }} muted playsInline /></div>}
  </div>;
}
