import { useEffect, useRef, useState } from 'react';
import { PenLine, X, Upload } from 'lucide-react';
import { api, API_BASE, getToken, errorText } from '../services/api';

/**
 * "My signature" — upload a signature once; the Host then applies it to every
 * electronic signing (approvals, acknowledgements, forms) in place of drawing
 * one each time. Shared by desktop and mobile via the same /signatures/me API.
 */
async function fetchSignatureUrl(): Promise<string | null> {
  try {
    const res = await fetch(`${API_BASE}/signatures/me/image`, { headers: getToken() ? { Authorization: `Bearer ${getToken()}` } : {} });
    if (!res.ok) return null;
    return URL.createObjectURL(await res.blob());
  } catch { return null; }
}

export function SignatureModal({ onClose }: { onClose: () => void }) {
  const [hasSignature, setHasSignature] = useState<boolean | null>(null);
  const [staffLinked, setStaffLinked] = useState(true);
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  function refresh() {
    api<{ hasSignature: boolean; staffLinked?: boolean }>('/signatures/me')
      .then(r => { setHasSignature(r.hasSignature); setStaffLinked(r.staffLinked !== false); if (r.hasSignature) fetchSignatureUrl().then(setImgUrl); else setImgUrl(null); })
      .catch(e => setError(errorText(e)));
  }
  useEffect(refresh, []);
  useEffect(() => () => { if (imgUrl) URL.revokeObjectURL(imgUrl); }, [imgUrl]);

  async function upload(file: File | null) {
    if (!file) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      await api('/signatures/me', { method: 'POST', body: fd });
      setNotice('Signature saved. It will be applied to everything you sign.');
      refresh();
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }

  return (
    <div className="pw-overlay" onClick={onClose}>
      <div className="pw-modal" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="My signature">
        <div className="pw-head">
          <h3><PenLine size={18} /> My signature</h3>
          <button className="drawer-close" type="button" aria-label="Close" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="pw-body">
          <p className="muted" style={{ margin: '0 0 12px', fontSize: 13 }}>
            Upload your signature once. It is applied automatically to every electronic signing across SECH_LIMS — approvals, acknowledgements and forms.
          </p>
          {!staffLinked && <p className="pw-error">Your login isn’t linked to a staff record, so it can’t hold a signature. Ask an administrator to link it.</p>}
          {staffLinked && hasSignature && imgUrl && (
            <div className="sig-preview"><img src={imgUrl} alt="Your signature" /></div>
          )}
          {staffLinked && hasSignature === false && (
            <p className="muted" style={{ fontSize: 13 }}>No signature on file yet.</p>
          )}
          {notice && <p className="pw-ok">{notice}</p>}
          {error && <p className="pw-error">{error}</p>}
          {staffLinked && (
            <div className="form-actions" style={{ marginTop: 14 }}>
              <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={e => upload(e.target.files?.[0] ?? null)} />
              <button type="button" className="secondary" onClick={onClose}>Close</button>
              <button type="button" disabled={busy} onClick={() => fileRef.current?.click()}>
                <Upload size={15} /> {busy ? 'Uploading…' : hasSignature ? 'Replace signature' : 'Upload signature'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
