import { useEffect, useState } from 'react';
import { API_BASE, getToken } from '../services/api';

/**
 * Renders a staff member's signature-on-file image wherever their signature
 * should appear (attestations, approvals, printed records). Fetches with the
 * auth token as a blob (an <img src> can't send headers). Renders nothing when
 * the staff member has no signature on file.
 */
export function SignatureThumb({ staffId, height = 34 }: { staffId?: number | null; height?: number }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!staffId) { setUrl(null); return; }
    let live = true; let created: string | null = null;
    fetch(`${API_BASE}/signatures/staff/${staffId}/image`, { headers: getToken() ? { Authorization: `Bearer ${getToken()}` } : {} })
      .then(r => (r.ok ? r.blob() : null))
      .then(b => { if (!b) return; const u = URL.createObjectURL(b); if (live) { created = u; setUrl(u); } else URL.revokeObjectURL(u); })
      .catch(() => undefined);
    return () => { live = false; if (created) URL.revokeObjectURL(created); };
  }, [staffId]);
  if (!url) return null;
  return <img src={url} alt="signature" style={{ height, maxWidth: 140, objectFit: 'contain', background: '#fff', borderRadius: 4, padding: 2 }} />;
}
