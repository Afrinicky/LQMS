/**
 * Signature-on-file (Phase 2 revision).
 *
 * Staff upload their signature once; it is then applied automatically to every
 * electronic signing (approvals, forms, declarations, acknowledgements) in place
 * of drawing one each time. This module provides:
 *   - useSignatureStatus(): whether the current user has a signature on file,
 *   - SignatureImage: renders a signature image (auth-fetched as a blob),
 *   - SignatureManager: upload / view / replace the signature on file,
 *   - SignatureGate: the inline block shown in signing flows — confirms the
 *     signature that will be applied, or prompts a one-time upload if missing.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, API_BASE, getToken } from '../src/services/api';
import { compressImage } from './native';
import { Ico, Result, type Msg } from './ui';

const PEN = 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z';
const UP = 'M12 3v12M8 11l4 4 4-4M4 21h16';

/** Authenticated image fetch → object URL (an <img> tag can't send the token). */
async function fetchImageUrl(path: string): Promise<string | null> {
  try {
    const res = await fetch(`${API_BASE}${path}`, { headers: getToken() ? { Authorization: `Bearer ${getToken()}` } : {} });
    if (!res.ok) return null;
    return URL.createObjectURL(await res.blob());
  } catch { return null; }
}

export interface SigStatus { hasSignature: boolean; fileId: number | null; staffLinked: boolean; loading: boolean; refresh: () => void; }

export function useSignatureStatus(): SigStatus {
  const [state, setState] = useState<{ hasSignature: boolean; fileId: number | null; staffLinked: boolean; loading: boolean }>({ hasSignature: false, fileId: null, staffLinked: true, loading: true });
  const load = useCallback(() => {
    setState(s => ({ ...s, loading: true }));
    api<{ hasSignature: boolean; fileId: number | null; staffLinked?: boolean }>('/signatures/me')
      .then(r => setState({ hasSignature: r.hasSignature, fileId: r.fileId, staffLinked: r.staffLinked !== false, loading: false }))
      .catch(() => setState({ hasSignature: false, fileId: null, staffLinked: true, loading: false }));
  }, []);
  useEffect(load, [load]);
  return { ...state, refresh: load };
}

/** Renders a signature image (self or a given staff member), auth-fetched. */
export function SignatureImage({ staffId, cacheKey, className }: { staffId?: number; cacheKey?: unknown; className?: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true; let created: string | null = null;
    const path = staffId ? `/signatures/staff/${staffId}/image` : '/signatures/me/image';
    fetchImageUrl(path).then(u => { if (live) { created = u; setUrl(u); } else if (u) URL.revokeObjectURL(u); });
    return () => { live = false; if (created) URL.revokeObjectURL(created); };
  }, [staffId, cacheKey]);
  if (!url) return null;
  return <img src={url} alt="signature" className={className ?? 'm-sig-img'} />;
}

/** Upload / view / replace the signature on file. */
export function SignatureManager({ onChange }: { onChange?: () => void }) {
  const status = useSignatureStatus();
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Msg>(null);
  const [ver, setVer] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  async function upload(file: File | null) {
    if (!file) return;
    setBusy(true); setRes(null);
    try {
      const img = await compressImage(file, 1200, 0.9);
      const fd = new FormData();
      fd.append('file', img);
      await api('/signatures/me', { method: 'POST', body: fd });
      setRes({ kind: 'ok', msg: 'Signature saved. It will be used for all your signings.' });
      setVer(v => v + 1); status.refresh(); onChange?.();
    } catch (e) { setRes({ kind: 'err', msg: (e as Error).message }); } finally { setBusy(false); }
  }

  if (!status.staffLinked) return <p className="m-empty">Link your account to a staff record to store a signature.</p>;

  return (
    <div className="m-form">
      {status.hasSignature ? (
        <div className="m-sig-card">
          <SignatureImage cacheKey={ver} />
          <div className="m-sig-note">This signature is applied to everything you sign.</div>
        </div>
      ) : (
        <p className="m-empty">No signature on file yet. Upload a photo or scan of your handwritten signature once — it will be used for every signing.</p>
      )}
      <label className="m-photobtn">
        <Ico d={UP} size={18} /> {status.hasSignature ? 'Replace signature' : 'Upload signature'}
        <input ref={inputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={e => upload(e.target.files?.[0] ?? null)} disabled={busy} />
      </label>
      <Result r={res} />
    </div>
  );
}

/**
 * Signing gate for approval / form / declaration flows. Shows the signature that
 * will be applied and reports readiness via onReady. If none is on file it lets
 * the user upload one inline (once), then continues.
 */
export function SignatureGate({ onReady }: { onReady: (ready: boolean) => void }) {
  const status = useSignatureStatus();
  const [uploading, setUploading] = useState(false);
  const [ver, setVer] = useState(0);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { onReady(status.hasSignature); }, [status.hasSignature, onReady]);

  async function upload(file: File | null) {
    if (!file) return;
    setUploading(true); setErr(null);
    try {
      const img = await compressImage(file, 1200, 0.9);
      const fd = new FormData(); fd.append('file', img);
      await api('/signatures/me', { method: 'POST', body: fd });
      setVer(v => v + 1); status.refresh();
    } catch (e) { setErr((e as Error).message); } finally { setUploading(false); }
  }

  if (status.loading) return <div className="m-sig-gate"><span className="m-sig-hint">Checking your signature…</span></div>;
  if (!status.staffLinked) return <div className="m-sig-gate"><span className="m-sig-hint">Your account isn’t linked to a staff record, so it can’t hold a signature.</span></div>;

  if (status.hasSignature) {
    return (
      <div className="m-sig-gate">
        <div className="m-sig-gate-head"><Ico d={PEN} size={16} /> <span>Signing with your signature on file</span></div>
        <div className="m-sig-card"><SignatureImage cacheKey={ver} /></div>
      </div>
    );
  }
  return (
    <div className="m-sig-gate">
      <span className="m-sig-hint">You have no signature on file. Upload it once — it will be reused for every signing.</span>
      <label className="m-photobtn" style={{ marginTop: 8 }}>
        <Ico d={UP} size={18} /> {uploading ? 'Uploading…' : 'Upload your signature'}
        <input type="file" accept="image/*" style={{ display: 'none' }} onChange={e => upload(e.target.files?.[0] ?? null)} disabled={uploading} />
      </label>
      {err && <p className="m-err">{err}</p>}
    </div>
  );
}
