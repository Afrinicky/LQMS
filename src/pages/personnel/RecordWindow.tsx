import { useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';

/**
 * The window a record opens in.
 *
 * Everything in a staff file — the file itself and each document or record
 * inside it — opens the way a controlled document opens in Documents & Records:
 * a window over the page with a title bar that drags, edges that resize, and
 * the usual minimise / maximise / close. Both callers share this shell so a
 * staff file and the certificate inside it behave identically, and a window
 * opened from another window sits above it.
 */
export default function RecordWindow({ title, subtitle, toolbar, onClose, children, layer = 0, restoreLabel }: {
  title: string;
  subtitle?: string | null;
  /** Buttons for the window's own toolbar, right-aligned. */
  toolbar?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  /** 0 for a window opened from the page, 1 for one opened from another window. */
  layer?: 0 | 1;
  /** What the docked pill says while minimised. Defaults to the title. */
  restoreLabel?: string;
}) {
  const [maximized, setMaximized] = useState(true);
  const [minimized, setMinimized] = useState(false);
  const [winPos, setWinPos] = useState<{ x: number; y: number } | null>(null);
  const [winSize, setWinSize] = useState<{ w: number; h: number } | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const dragOffset = useRef({ x: 0, y: 0 });
  const resizing = useRef<{ dir: string; startX: number; startY: number; startW: number; startH: number; startL: number; startT: number } | null>(null);

  const zBase = 1000 + layer * 20;

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
    w = Math.min(Math.max(520, w), window.innerWidth);
    h = Math.min(Math.max(360, h), window.innerHeight);
    if (r.dir.includes('w')) x = r.startL + (r.startW - w);
    if (r.dir.includes('n')) y = r.startT + (r.startH - h);
    setWinPos({ x: Math.max(0, x), y: Math.max(0, y) });
    setWinSize({ w, h });
  }
  function stopResize(e: ReactPointerEvent<HTMLElement>) {
    resizing.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* already released */ }
  }

  if (minimized) {
    return <div style={{ position: 'fixed', right: 96, bottom: 24 + layer * 56, zIndex: zBase }}>
      <button type="button" className="rw-pill" onClick={() => setMinimized(false)}>
        {restoreLabel ?? title}<span>Restore</span>
      </button>
      <style>{PILL_CSS}</style>
    </div>;
  }

  const cardStyle: CSSProperties = maximized
    ? { width: '100vw', height: '100vh', maxWidth: '100vw', margin: 0, borderRadius: 0, position: 'fixed', inset: 0 }
    : {
        width: winSize ? winSize.w : `min(${1180 - layer * 60}px, ${94 - layer * 4}vw)`,
        height: winSize ? winSize.h : `${90 - layer * 4}vh`,
        maxWidth: '100vw', margin: 0,
        ...(winPos ? { position: 'fixed' as const, left: winPos.x, top: winPos.y } : { position: 'relative' as const }),
      };

  return <div className="rw-scrim" style={{ zIndex: zBase, background: maximized ? 'transparent' : 'rgba(8,16,32,0.58)', pointerEvents: maximized ? 'none' : 'auto' }} onClick={onClose}>
    <style>{WINDOW_CSS}{PILL_CSS}</style>
    <div ref={cardRef} className="rw-window" style={{ ...cardStyle, pointerEvents: 'auto' }} onClick={e => e.stopPropagation()}
      onPointerMove={e => { moveWinDrag(e); moveResize(e); }} onPointerUp={e => { stopWinDrag(e); stopResize(e); }} onPointerCancel={e => { stopWinDrag(e); stopResize(e); }}>

      {!maximized && ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].map(dir =>
        <div key={dir} className={`rw-rs rw-rs-${dir}`} onPointerDown={e => startResize(e, dir)} />)}

      <div className="rw-titlebar" style={{ cursor: maximized ? 'default' : 'move' }} onPointerDown={startWinDrag}
        onDoubleClick={e => { if (!(e.target as HTMLElement).closest('button')) setMaximized(m => !m); }}>
        <span className="rw-title" title={title}>{title}</span>
        {subtitle && <span className="rw-subtitle" title={subtitle}>{subtitle}</span>}
        <span className="rw-winbtns">
          <button type="button" className="rw-winbtn" title="Minimize" onClick={() => setMinimized(true)}>─</button>
          <button type="button" className="rw-winbtn" title={maximized ? 'Restore down' : 'Maximize'} onClick={() => setMaximized(m => !m)}>{maximized ? '❐' : '☐'}</button>
          <button type="button" className="rw-winbtn rw-close" title="Close" onClick={onClose}>✕</button>
        </span>
      </div>

      {toolbar && <div className="rw-toolbar">{toolbar}</div>}
      <div className="rw-body">{children}</div>
    </div>
  </div>;
}

const WINDOW_CSS = `.rw-scrim{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;overflow:hidden}
.rw-window{display:flex;flex-direction:column;overflow:hidden;background:var(--panel,#0b1428);border:1px solid var(--border,#22345c);border-radius:12px;box-shadow:0 24px 70px rgba(0,0,0,.6)}
.rw-titlebar{display:flex;align-items:center;gap:12px;padding:0 4px 0 16px;height:40px;flex:none;background:var(--panel-2,#101c36);border-bottom:1px solid var(--border,#22345c);user-select:none;touch-action:none}
.rw-title{font-size:13.5px;font-weight:650;color:var(--text,#e7eefc);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:none;max-width:52%}
.rw-subtitle{flex:1;min-width:0;font-size:12px;color:var(--muted,#7c8db0);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rw-winbtns{display:flex;gap:2px;flex:none;margin-left:auto}
.rw-winbtn{width:40px;height:30px;display:inline-flex;align-items:center;justify-content:center;background:transparent;border:0;box-shadow:none;border-radius:7px;color:var(--muted,#c8d4ec);font-size:13px;cursor:pointer;line-height:1;padding:0}
.rw-winbtn:hover{background:rgba(255,255,255,.09);color:#fff}
.rw-winbtn.rw-close:hover{background:#c42b1c;color:#fff}
.rw-toolbar{display:flex;align-items:center;gap:8px;padding:8px 14px;flex:none;flex-wrap:wrap;background:var(--panel-2,#0e1930);border-bottom:1px solid var(--border,#1d2c4e)}
.rw-body{flex:1;min-height:0;overflow:auto}
.rw-btn{height:30px;padding:0 12px;display:inline-flex;align-items:center;gap:6px;background:transparent;border:1px solid var(--border,#2c416f);border-radius:8px;color:var(--text,#dbe6fb);font-size:12.5px;font-weight:600;cursor:pointer;box-shadow:none;white-space:nowrap}
.rw-btn:hover:not(:disabled){background:var(--accent-soft,#1d3257);border-color:var(--accent-bright,#3a5694)}
.rw-btn:disabled{opacity:.5;cursor:default}
.rw-rs{position:absolute;z-index:30;touch-action:none}
.rw-rs-n{top:0;left:14px;right:14px;height:6px;cursor:ns-resize}
.rw-rs-s{bottom:0;left:14px;right:14px;height:6px;cursor:ns-resize}
.rw-rs-e{right:0;top:14px;bottom:14px;width:6px;cursor:ew-resize}
.rw-rs-w{left:0;top:14px;bottom:14px;width:6px;cursor:ew-resize}
.rw-rs-ne{top:0;right:0;width:14px;height:14px;cursor:nesw-resize}
.rw-rs-nw{top:0;left:0;width:14px;height:14px;cursor:nwse-resize}
.rw-rs-se{bottom:0;right:0;width:14px;height:14px;cursor:nwse-resize}
.rw-rs-sw{bottom:0;left:0;width:14px;height:14px;cursor:nesw-resize}`;

const PILL_CSS = `.rw-pill{display:flex;align-items:center;gap:10px;padding:10px 16px;border-radius:10px;font-size:12.5px;font-weight:600;
background:var(--panel-2,#101c36);border:1px solid var(--border,#2c416f);color:var(--text,#e7eefc);cursor:pointer;box-shadow:0 6px 22px rgba(0,0,0,.45)}
.rw-pill span{font-weight:500;color:var(--muted,#7c8db0)}
.rw-pill:hover{border-color:var(--accent-bright,#4e8dff)}`;
