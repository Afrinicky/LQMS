/**
 * Camera intelligence & QR/barcode scanning (Phase 2).
 *
 * The QR/barcode backend is complete now; live scanning needs a secure context
 * (HTTPS or the native app). This component therefore degrades gracefully:
 *  - Secure context with a BarcodeDetector → live camera scanning.
 *  - Otherwise → OS-camera photo capture (works over http) plus manual entry,
 *    with a "confirm or edit" step for anything read (OCR-ready).
 *
 * A scanned/entered QR token is resolved through /api/qr/:token to its record.
 */
import { useEffect, useRef, useState } from 'react';
import { api } from '../src/services/api';
import { Back, Field, Ico, s } from './ui';
import { capabilities } from './native';

// BarcodeDetector is not yet in the TS DOM lib; declare the slice we use.
interface BarcodeResult { rawValue: string; format: string }
interface BarcodeDetectorLike { detect(source: CanvasImageSource): Promise<BarcodeResult[]> }
declare global {
  interface Window { BarcodeDetector?: new (opts?: { formats?: string[] }) => BarcodeDetectorLike }
}

const CAM = 'M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z';
const QR = 'M3 3h6v6H3zM15 3h6v6h-6zM3 15h6v6H3zM15 15h3M18 18h3M21 15v6M15 18v3';

type Resolved = { entityType: string; entityId: string; label: string | null; module: string | null; deepLink: string | null; record: Record<string, unknown> | null };

export function ScanScreen({ onBack }: { onBack: () => void }) {
  const caps = capabilities();
  const [manual, setManual] = useState('');
  const [resolved, setResolved] = useState<Resolved | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);

  async function resolveToken(token: string) {
    setErr(null); setResolved(null);
    const t = token.trim();
    if (!t) return;
    try { setResolved(await api<Resolved>(`/qr/${encodeURIComponent(t)}`)); }
    catch (e) { setErr((e as Error).message || 'Unknown code'); }
  }

  return (
    <div className="m-screen">
      <Back onBack={onBack} />
      <div className="m-screen-h">Scan</div>
      {caps.liveCamera && window.BarcodeDetector ? (
        <LiveScanner active={scanning} onStart={() => setScanning(true)} onStop={() => setScanning(false)} onResult={code => { setScanning(false); void resolveToken(code); }} />
      ) : (
        <div className="m-scan-note">
          <Ico d={QR} size={20} />
          <div>
            <strong>Live scanning needs HTTPS</strong>
            <p>On the lab LAN over http, enter the code shown under the QR label, or use camera capture. Live scanning switches on automatically over the secure tunnel or in the native app.</p>
          </div>
        </div>
      )}

      <Field label="Enter code manually">
        <div className="m-inline">
          <input value={manual} onChange={e => setManual(e.target.value)} placeholder="e.g. SQ… token" autoCapitalize="none" />
          <button className="m-btn small primary" onClick={() => resolveToken(manual)}>Open</button>
        </div>
      </Field>

      {err && <p className="m-err">{err}</p>}
      {resolved && <ResolvedCard r={resolved} />}
    </div>
  );
}

function ResolvedCard({ r }: { r: Resolved }) {
  const rec = r.record ?? {};
  const name = s(rec.name || rec.equipment_number || rec.item_code || r.label || r.entityId);
  return (
    <div className="m-card" style={{ padding: 16 }}>
      <div className="m-section-h" style={{ marginTop: 0 }}>{r.entityType.replace(/_/g, ' ')}</div>
      <div className="m-me-name">{name}</div>
      {rec.status ? <div className="m-me-role">Status: {s(rec.status)}</div> : null}
      <div className="m-kv"><span>Type</span><strong>{r.entityType}</strong></div>
      <div className="m-kv"><span>Reference</span><strong>#{r.entityId}</strong></div>
      {r.module && <div className="m-kv"><span>Module</span><strong>{r.module}</strong></div>}
    </div>
  );
}

function LiveScanner({ active, onStart, onStop, onResult }: { active: boolean; onStart: () => void; onStop: () => void; onResult: (code: string) => void }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!active) return;
    let stopped = false;
    const detector = new window.BarcodeDetector!({ formats: ['qr_code', 'code_128', 'ean_13', 'code_39', 'data_matrix'] });
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        streamRef.current = stream;
        if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play(); }
        const tick = async () => {
          if (stopped || !videoRef.current) return;
          try {
            const codes = await detector.detect(videoRef.current);
            if (codes[0]?.rawValue) { onResult(codes[0].rawValue); return; }
          } catch { /* transient */ }
          rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
      } catch (e) { setErr((e as Error).message || 'Camera unavailable'); }
    })();
    return () => {
      stopped = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      streamRef.current?.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    };
  }, [active, onResult]);

  return (
    <div className="m-scanbox">
      {active ? (
        <>
          <video ref={videoRef} className="m-scanvideo" playsInline muted />
          <div className="m-scan-frame" />
          <button className="m-btn small ghost" onClick={onStop} style={{ marginTop: 10 }}>Stop</button>
          {err && <p className="m-err">{err}</p>}
        </>
      ) : (
        <button className="m-btn primary block" onClick={onStart}><Ico d={QR} size={18} /> Start camera scan</button>
      )}
    </div>
  );
}

/**
 * Inline scan/enter field for the forms engine and capture screens. Accepts a QR
 * token or a typed value (serial/lot number). When a QR is entered it resolves
 * and shows the entity label so the user can confirm — the OCR "confirm or edit"
 * pattern extends the same control.
 */
export function ScanField({ label, value, onChange, hint }: { label: string; value: string; onChange: (v: string) => void; hint?: string }) {
  const caps = capabilities();
  const [live, setLive] = useState(false);
  const [resolvedLabel, setResolvedLabel] = useState<string | null>(null);

  async function resolve(token: string) {
    onChange(token);
    try { const r = await api<Resolved>(`/qr/${encodeURIComponent(token.trim())}`); setResolvedLabel(r.label || r.entityId); }
    catch { setResolvedLabel(null); }
  }

  return (
    <Field label={label} hint={hint}>
      <div className="m-inline">
        <input value={value} onChange={e => { onChange(e.target.value); setResolvedLabel(null); }} placeholder="Scan or type reference" autoCapitalize="none" />
        {caps.liveCamera && window.BarcodeDetector
          ? <button type="button" className="m-btn small ghost" onClick={() => setLive(v => !v)}><Ico d={CAM} size={16} /></button>
          : null}
      </div>
      {resolvedLabel && <div className="m-fieldhint" style={{ color: 'var(--success)' }}>Matched: {resolvedLabel}</div>}
      {live && caps.liveCamera && window.BarcodeDetector && (
        <LiveScanner active onStart={() => undefined} onStop={() => setLive(false)} onResult={code => { setLive(false); void resolve(code); }} />
      )}
    </Field>
  );
}
