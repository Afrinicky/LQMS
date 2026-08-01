import { useEffect, useRef, useState } from 'react';

// Document scanner: capture a page straight from a camera (webcam / phone) into
// the system, or select a file produced by a flatbed/desktop scanner. The
// captured image is handed back to the caller as a File to upload — so whatever
// is scanned goes directly into the record it was opened from.

export default function DocumentScanner({ onCapture, buttonLabel = '📷 Scan document' }: { onCapture: (file: File) => void; buttonLabel?: string }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  function stop() {
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null; setReady(false); setOpen(false);
  }
  async function start() {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } } });
      streamRef.current = stream; setOpen(true);
      if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play(); setReady(true); }
    } catch (e) { setError((e as Error).message || 'Could not access the camera. You can select a scanned file instead.'); setOpen(true); }
  }
  useEffect(() => () => stop(), []);

  function capture() {
    const v = videoRef.current; if (!v) return;
    const canvas = document.createElement('canvas');
    canvas.width = v.videoWidth || 1280; canvas.height = v.videoHeight || 960;
    const ctx = canvas.getContext('2d'); if (!ctx) return;
    ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(blob => {
      if (!blob) return;
      const file = new File([blob], `scan-${new Date().toISOString().replace(/[:.]/g, '-')}.jpg`, { type: 'image/jpeg' });
      onCapture(file); stop();
    }, 'image/jpeg', 0.92);
  }

  return <span style={{ display: 'inline-block' }}>
    <button type="button" className="secondary" onClick={() => (open ? stop() : start())}>{open ? 'Close scanner' : buttonLabel}</button>
    {open && <div style={{ marginTop: 8, padding: 10, border: '1px solid #ccc', borderRadius: 8, maxWidth: 420 }}>
      {error && <div className="error" style={{ marginBottom: 6 }}>{error}</div>}
      {!error && <video ref={videoRef} style={{ width: '100%', borderRadius: 6, background: '#000' }} muted playsInline />}
      <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
        {!error && <button type="button" onClick={capture} disabled={!ready}>Capture page</button>}
        <button type="button" className="secondary" onClick={() => fileRef.current?.click()}>Select scanned file</button>
        <button type="button" className="secondary" onClick={stop}>Cancel</button>
      </div>
      <input ref={fileRef} type="file" accept="image/*,application/pdf" style={{ display: 'none' }} onChange={e => { const f = e.target.files?.[0]; if (f) { onCapture(f); stop(); } }} />
      <p className="muted" style={{ fontSize: 11, marginBottom: 0 }}>Point the camera at the document and press Capture, or select a file from a desktop/flatbed scanner.</p>
    </div>}
  </span>;
}
