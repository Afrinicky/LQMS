import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { Printer } from 'lucide-react';
import { API_BASE, getToken, errorText } from '../../services/api';
import { openPrintable } from '../../services/xlsx';
import type { StaffFileOpen } from '../../../shared/types/api';

/**
 * A record in a staff file, opened the way a controlled document is opened.
 *
 * A staff file holds two kinds of thing: a file somebody uploaded, and a record
 * the system produced. Both are read here, in the same window — title bar,
 * minimise / maximise / close, drag and resize — so opening a competency report
 * feels no different from opening a scanned certificate.
 */
export default function StaffRecordViewer({ title, subtitle, open, onClose }: {
  title: string;
  subtitle?: string | null;
  open: Extract<StaffFileOpen, { kind: 'file' } | { kind: 'sheet' }>;
  onClose: () => void;
}) {
  const [html, setHtml] = useState<string | null>(null);
  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [maximized, setMaximized] = useState(true);
  const [minimized, setMinimized] = useState(false);
  const [winPos, setWinPos] = useState<{ x: number; y: number } | null>(null);
  const [winSize, setWinSize] = useState<{ w: number; h: number } | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const dragOffset = useRef({ x: 0, y: 0 });
  const resizing = useRef<{ dir: string; startX: number; startY: number; startW: number; startH: number; startL: number; startT: number } | null>(null);

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
        // The sheet carries its own print bar for when it is opened in a tab
        // of its own; in here the window's Print button already does that job.
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
  }, [open.kind, (open as any).path, (open as any).fileId]);

  function startWinDrag(e: ReactPointerEvent<HTMLElement>) {
    if (maximized) return;
    if ((e.target as HTMLElement).closest('button,select,input,a')) return;
    const rect = cardRef.current?.getBoundingClientRect();
    if (!rect) return;
    dragging.current = true;
    dragOffset.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    setWinPos({ x: rect.left, y: rect.top });
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function moveWinDrag(e: ReactPointerEvent<HTMLElement>) {
    if (!dragging.current) return;
    const w = cardRef.current?.offsetWidth || 600;
    const h = cardRef.current?.offsetHeight || 400;
    const x = Math.min(Math.max(0, e.clientX - dragOffset.current.x), Math.max(0, window.innerWidth - Math.min(w, window.innerWidth)));
    const y = Math.min(Math.max(0, e.clientY - dragOffset.current.y), Math.max(0, window.innerHeight - Math.min(h, window.innerHeight)));
    setWinPos({ x, y });
  }
  function stopWinDrag(e: ReactPointerEvent<HTMLElement>) {
    dragging.current = false;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* already released */ }
  }
  function startResize(e: ReactPointerEvent<HTMLElement>, dir: string) {
    if (maximized) return;
    const rect = cardRef.current?.getBoundingClientRect();
    if (!rect) return;
    resizing.current = { dir, startX: e.clientX, startY: e.clientY, startW: rect.width, startH: rect.height, startL: rect.left, startT: rect.top };
    setWinPos({ x: rect.left, y: rect.top });
    setWinSize({ w: rect.width, h: rect.height });
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault(); e.stopPropagation();
  }
  function moveResize(e: ReactPointerEvent<HTMLElement>) {
    const r = resizing.current; if (!r) return;
    const dx = e.clientX - r.startX; const dy = e.clientY - r.startY;
    let w = r.startW, h = r.startH, x = r.startL, y = r.startT;
    if (r.dir.includes('e')) w = r.startW + dx;
    if (r.dir.includes('s')) h = r.startH + dy;
    if (r.dir.includes('w')) w = r.startW - dx;
    if (r.dir.includes('n')) h = r.startH - dy;
    w = Math.min(Math.max(480, w), window.innerWidth);
    h = Math.min(Math.max(340, h), window.innerHeight);
    if (r.dir.includes('w')) x = r.startL + (r.startW - w);
    if (r.dir.includes('n')) y = r.startT + (r.startH - h);
    setWinPos({ x: Math.max(0, x), y: Math.max(0, y) });
    setWinSize({ w, h });
  }
  function stopResize(e: ReactPointerEvent<HTMLElement>) {
    resizing.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* already released */ }
  }

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

  if (minimized) {
    return <div style={{ position: 'fixed', right: 96, bottom: 24, zIndex: 1000 }}>
      <button className="secondary" onClick={() => setMinimized(false)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px', boxShadow: '0 4px 18px rgba(0,0,0,.4)' }}>
        📄 {title} — Restore
      </button>
    </div>;
  }

  const cardStyle: CSSProperties = maximized
    ? { width: '100vw', height: '100vh', maxWidth: '100vw', margin: 0, borderRadius: 0, position: 'fixed', inset: 0 }
    : {
        width: winSize ? winSize.w : 'min(1160px, 94vw)', height: winSize ? winSize.h : '90vh', maxWidth: '100vw', margin: 0,
        ...(winPos ? { position: 'fixed' as const, left: winPos.x, top: winPos.y } : { position: 'relative' as const }),
      };

  return <div style={{ position: 'fixed', inset: 0, background: maximized ? 'transparent' : 'rgba(8,16,32,0.55)', zIndex: 1000, display: 'flex', justifyContent: 'center', alignItems: 'center', overflow: 'hidden', pointerEvents: maximized ? 'none' : 'auto' }} onClick={onClose}>
    <div ref={cardRef} className="card sv-window" style={{ ...cardStyle, padding: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', pointerEvents: 'auto' }} onClick={e => e.stopPropagation()}
      onPointerMove={e => { moveWinDrag(e); moveResize(e); }} onPointerUp={e => { stopWinDrag(e); stopResize(e); }} onPointerCancel={e => { stopWinDrag(e); stopResize(e); }}>
      <style>{`.sv-window{background:#0b1428;border:1px solid #22345c;box-shadow:0 18px 60px rgba(0,0,0,.55)}
.sv-titlebar{display:flex;align-items:center;gap:10px;padding:4px 4px 4px 14px;background:#101c36;border-bottom:1px solid #22345c;user-select:none;touch-action:none;flex:none}
.sv-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13.5px;font-weight:600;color:#e7eefc}
.sv-winbtns{display:flex;gap:2px;flex:none}
.sv-winbtn{width:40px;height:30px;display:inline-flex;align-items:center;justify-content:center;background:transparent;border:0;box-shadow:none;border-radius:6px;color:#c8d4ec;font-size:13px;cursor:pointer;line-height:1;padding:0}
.sv-winbtn:hover{background:rgba(255,255,255,.09);color:#fff}
.sv-winbtn.sv-close:hover{background:#c42b1c;color:#fff}
.sv-toolbar{display:flex;align-items:center;gap:8px;padding:7px 10px;background:#0e1930;border-bottom:1px solid #1d2c4e;flex:none;flex-wrap:wrap}
.sv-sub{font-size:12px;color:#7c8db0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sv-ghost{height:30px;padding:0 11px;display:inline-flex;align-items:center;gap:6px;background:transparent;border:1px solid #2c416f;border-radius:7px;color:#dbe6fb;font-size:12.5px;cursor:pointer;box-shadow:none;white-space:nowrap}
.sv-ghost:hover{background:#1d3257;border-color:#3a5694}
.sv-ghost:disabled{opacity:.55;cursor:default}
.sv-content{flex:1;min-height:0;display:flex;flex-direction:column;background:#525659;padding:8px}
.sv-frame{flex:1;min-height:0;width:100%;border:0;border-radius:8px;background:#fff;display:block}
.sv-note{margin:auto;max-width:430px;text-align:center;background:#101c36;border:1px solid #22345c;border-radius:12px;padding:26px;color:#dbe6fb}
.sv-rs{position:absolute;z-index:30;touch-action:none}
.sv-rs-n{top:0;left:12px;right:12px;height:6px;cursor:ns-resize}
.sv-rs-s{bottom:0;left:12px;right:12px;height:6px;cursor:ns-resize}
.sv-rs-e{right:0;top:12px;bottom:12px;width:6px;cursor:ew-resize}
.sv-rs-w{left:0;top:12px;bottom:12px;width:6px;cursor:ew-resize}
.sv-rs-ne{top:0;right:0;width:14px;height:14px;cursor:nesw-resize}
.sv-rs-nw{top:0;left:0;width:14px;height:14px;cursor:nwse-resize}
.sv-rs-se{bottom:0;right:0;width:14px;height:14px;cursor:nwse-resize}
.sv-rs-sw{bottom:0;left:0;width:14px;height:14px;cursor:nesw-resize}`}</style>

      {!maximized && <>
        <div className="sv-rs sv-rs-n" onPointerDown={e => startResize(e, 'n')} />
        <div className="sv-rs sv-rs-s" onPointerDown={e => startResize(e, 's')} />
        <div className="sv-rs sv-rs-e" onPointerDown={e => startResize(e, 'e')} />
        <div className="sv-rs sv-rs-w" onPointerDown={e => startResize(e, 'w')} />
        <div className="sv-rs sv-rs-ne" onPointerDown={e => startResize(e, 'ne')} />
        <div className="sv-rs sv-rs-nw" onPointerDown={e => startResize(e, 'nw')} />
        <div className="sv-rs sv-rs-se" onPointerDown={e => startResize(e, 'se')} />
        <div className="sv-rs sv-rs-sw" onPointerDown={e => startResize(e, 'sw')} />
      </>}

      <div className="sv-titlebar" style={{ cursor: maximized ? 'default' : 'move' }} onPointerDown={startWinDrag}
        onDoubleClick={e => { if (!(e.target as HTMLElement).closest('button')) setMaximized(m => !m); }}>
        <span className="sv-title" title={title}>{title}</span>
        <span className="sv-winbtns">
          <button className="sv-winbtn" title="Minimize" onClick={() => setMinimized(true)}>─</button>
          <button className="sv-winbtn" title={maximized ? 'Restore down' : 'Maximize'} onClick={() => setMaximized(m => !m)}>{maximized ? '❐' : '☐'}</button>
          <button className="sv-winbtn sv-close" title="Close" onClick={onClose}>✕</button>
        </span>
      </div>

      <div className="sv-toolbar">
        {subtitle && <span className="sv-sub">{subtitle}</span>}
        <span style={{ flex: 1 }} />
        {open.kind === 'file' && <button className="sv-ghost" onClick={download} disabled={!fileUrl}>⬇ Download</button>}
        <button className="sv-ghost" onClick={print} disabled={busy}>
          <Printer size={14} />{busy ? 'Preparing…' : 'Print'}
        </button>
      </div>

      <div className="sv-content">
        {error && <div className="sv-note"><p style={{ margin: 0 }}>{error}</p></div>}
        {!error && open.kind === 'sheet' && (html
          ? <iframe className="sv-frame" title={title} srcDoc={html} />
          : <div className="sv-note"><p style={{ margin: 0 }}>Opening the record…</p></div>)}
        {!error && open.kind === 'file' && (
          !fileUrl ? <div className="sv-note"><p style={{ margin: 0 }}>Loading the file…</p></div>
            : isPdf ? <iframe className="sv-frame" title={title} src={fileUrl} />
              : isImage ? <div style={{ flex: 1, minHeight: 0, overflow: 'auto', textAlign: 'center' }}><img src={fileUrl} alt={fileName || title} style={{ maxWidth: '100%' }} /></div>
                : <div className="sv-note">
                    <p style={{ marginTop: 0 }}>{fileName}</p>
                    <p className="muted" style={{ marginBottom: 16 }}>This file type cannot be shown in the window.</p>
                    <button className="secondary" onClick={download}>Download file</button>
                  </div>)}
      </div>
    </div>
  </div>;
}
