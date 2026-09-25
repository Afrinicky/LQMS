import { useEffect, useState } from 'react';
import { Download, Printer } from 'lucide-react';
import { API_BASE, getToken, errorText } from '../../services/api';
import { openPrintable } from '../../services/xlsx';
import RecordWindow from './RecordWindow';
import type { StaffFileOpen } from '../../../shared/types/api';

/**
 * A record in a staff file, opened the way a controlled document is opened.
 *
 * A staff file holds two kinds of thing: a file somebody uploaded, and a record
 * the system produced. Both are read here, in the same window, so opening a
 * competency report feels no different from opening a scanned certificate.
 */
export default function StaffRecordViewer({ title, subtitle, open, onClose, layer = 1 }: {
  title: string;
  subtitle?: string | null;
  open: Extract<StaffFileOpen, { kind: 'file' } | { kind: 'sheet' }>;
  onClose: () => void;
  layer?: 0 | 1;
}) {
  const [html, setHtml] = useState<string | null>(null);
  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const fileName = open.kind === 'file' ? (open.fileName || 'document') : null;
  const mime = open.kind === 'file' ? (open.mimeType || '') : '';
  const isPdf = open.kind === 'file' && (mime === 'application/pdf' || /\.pdf$/i.test(fileName || ''));
  const isImage = open.kind === 'file' && (mime.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp)$/i.test(fileName || ''));

  useEffect(() => {
    let revoke: string | null = null;
    let cancelled = false;
    setError(null); setHtml(null); setFileUrl(null);
    const token = getToken();
    const headers = token ? { Authorization: `Bearer ${token}` } : undefined;

    if (open.kind === 'sheet') {
      const path = `${open.path}${open.path.includes('?') ? '&' : '?'}autoprint=0`;
      fetch(`${API_BASE}${path}`, { headers })
        .then(async r => { if (!r.ok) throw new Error(await r.text() || r.statusText); return r.text(); })
        // The sheet carries its own print bar for when it is opened in a tab of
        // its own; in here the window's Print button already does that job.
        .then(text => { if (!cancelled) setHtml(`${text}<style>.toolbar{display:none}</style>`); })
        .catch(e => { if (!cancelled) setError(errorText(e)); });
    } else {
      // A PDF goes through a view ticket so the browser's own reader titles it
      // properly; anything else is fetched as a blob the window can embed.
      const asBlob = () => fetch(`${API_BASE}/files/${open.fileId}/raw`, { headers })
        .then(async r => { if (!r.ok) throw new Error('Could not load the file.'); return r.blob(); })
        .then(b => { if (!cancelled) { revoke = URL.createObjectURL(b); setFileUrl(revoke); } });
      if (isPdf) {
        fetch(`${API_BASE}/files/${open.fileId}/view-ticket`, { method: 'POST', headers: { ...(headers || {}), 'Content-Type': 'application/json' }, body: '{}' })
          .then(async r => { if (!r.ok) throw new Error('ticket'); return r.json(); })
          .then((t: { path: string }) => { if (!cancelled) setFileUrl(new URL(t.path, API_BASE).toString()); })
          .catch(() => asBlob().catch(e => { if (!cancelled) setError(errorText(e)); }));
      } else {
        asBlob().catch(e => { if (!cancelled) setError(errorText(e)); });
      }
    }
    return () => { cancelled = true; if (revoke) URL.revokeObjectURL(revoke); };
  }, [open.kind, (open as { path?: string }).path, (open as { fileId?: number }).fileId]);

  async function print() {
    if (open.kind === 'file') {
      // A stored file prints from the reader that can render it, so it is
      // opened in its own tab rather than pushed through the sheet printer.
      if (!fileUrl) return;
      if (!window.open(fileUrl, '_blank')) setError('Allow pop-ups for this site to print the file.');
      return;
    }
    setBusy(true);
    try { await openPrintable(open.path); }
    catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  }

  function download() {
    if (open.kind !== 'file' || !fileUrl) return;
    const a = document.createElement('a');
    a.href = fileUrl; a.download = fileName || 'document'; a.click();
  }

  return <RecordWindow title={title} subtitle={subtitle} onClose={onClose} layer={layer} toolbar={<>
    <span style={{ flex: 1 }} />
    {open.kind === 'file' && <button type="button" className="rw-btn" onClick={download} disabled={!fileUrl}>
      <Download size={14} />Download
    </button>}
    <button type="button" className="rw-btn" onClick={print} disabled={busy}>
      <Printer size={14} />{busy ? 'Preparing…' : 'Print'}
    </button>
  </>}>
    <style>{`.srv-stage{height:100%;display:flex;flex-direction:column;background:#525659;padding:10px}
.srv-frame{flex:1;min-height:0;width:100%;border:0;border-radius:8px;background:#fff;display:block}
.srv-note{margin:auto;max-width:430px;text-align:center;background:var(--panel-2,#101c36);border:1px solid var(--border,#22345c);border-radius:12px;padding:26px;color:var(--text,#dbe6fb)}`}</style>

    <div className="srv-stage">
      {error && <div className="srv-note"><p style={{ margin: 0 }}>{error}</p></div>}
      {!error && open.kind === 'sheet' && (html
        ? <iframe className="srv-frame" title={title} srcDoc={html} />
        : <div className="srv-note"><p style={{ margin: 0 }}>Opening the record…</p></div>)}
      {!error && open.kind === 'file' && (
        !fileUrl ? <div className="srv-note"><p style={{ margin: 0 }}>Loading the file…</p></div>
          : isPdf ? <iframe className="srv-frame" title={title} src={fileUrl} />
            : isImage ? <div style={{ flex: 1, minHeight: 0, overflow: 'auto', textAlign: 'center' }}><img src={fileUrl} alt={fileName || title} style={{ maxWidth: '100%' }} /></div>
              : <div className="srv-note">
                  <p style={{ marginTop: 0 }}>{fileName}</p>
                  <p className="muted" style={{ marginBottom: 16 }}>This file type cannot be shown in the window.</p>
                  <button type="button" className="secondary" onClick={download}>Download file</button>
                </div>)}
    </div>
  </RecordWindow>;
}
