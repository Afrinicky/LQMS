import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Bot, Maximize2, MessageCircle, Send, X } from 'lucide-react';
import { MODULES } from '../../shared/constants/modules';
import type { ApiUser } from '../../shared/types/api';
import { DENNIS_NOTICE, createFloatingDennisResponse } from '../services/dennisService';
import { api } from '../services/api';

type WidgetPosition = { x: number; y: number };
type Source = { title: string; documentCode?: string | null; version?: string | null; section?: string | null };
type FloatingMessage = { role: 'user' | 'dennis'; content: string; sources?: Source[]; pending?: boolean };
type DennisContext = { currentRoute: string; currentModule: string; currentUserRole: string; currentRecordId: string | null; currentPageTitle: string };

const STORAGE_KEY = 'dennis_floating_widget_position';
const DEFAULT_OFFSET = 24;
const ICON_SIZE = 62;
const PANEL_WIDTH = 372;
const PANEL_HEIGHT = 520;

// Self-contained styling so the widget looks right regardless of the global
// stylesheet — a round, draggable chat icon that expands into a mini chat popup.
const FLOAT_CSS = `
.dennis-fab{position:fixed;z-index:1200;width:${ICON_SIZE}px;height:${ICON_SIZE}px;border-radius:50%;border:none;cursor:grab;
  display:flex;align-items:center;justify-content:center;color:#fff;touch-action:none;
  background:radial-gradient(circle at 30% 25%,#2f6df0,#1B3A6B);box-shadow:0 8px 22px rgba(8,16,40,.45);transition:transform .12s ease,box-shadow .12s ease}
.dennis-fab:hover{transform:scale(1.06);box-shadow:0 10px 28px rgba(8,16,40,.55)}
.dennis-fab:active{cursor:grabbing}
.dennis-fab .dot{position:absolute;top:6px;right:6px;width:12px;height:12px;border-radius:50%;background:#37d67a;border:2px solid #0f1830}
.dennis-fab .ring{position:absolute;inset:0;border-radius:50%;border:2px solid rgba(255,255,255,.18)}
.dennis-pop{position:fixed;z-index:1200;width:${PANEL_WIDTH}px;max-width:94vw;height:${PANEL_HEIGHT}px;max-height:84vh;display:flex;flex-direction:column;
  background:#0f1830;border:1px solid #25365f;border-radius:16px;overflow:hidden;box-shadow:0 18px 50px rgba(4,8,24,.6);color:#e7edf8}
.dennis-pop .hd{display:flex;align-items:center;gap:10px;padding:11px 12px;background:linear-gradient(90deg,#16284b,#1B3A6B);cursor:grab;touch-action:none}
.dennis-pop .hd:active{cursor:grabbing}
.dennis-pop .av{width:34px;height:34px;border-radius:50%;background:radial-gradient(circle at 30% 25%,#2f6df0,#13315f);display:flex;align-items:center;justify-content:center;color:#fff;flex:0 0 auto}
.dennis-pop .ti{display:flex;flex-direction:column;line-height:1.15;flex:1;min-width:0}
.dennis-pop .ti strong{font-size:14px}
.dennis-pop .ti small{font-size:11px;color:#9fb2d6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dennis-pop .ic{background:transparent;border:none;color:#cfe0ff;cursor:pointer;padding:4px;border-radius:6px;display:flex}
.dennis-pop .ic:hover{background:rgba(255,255,255,.12)}
.dennis-pop .qa{display:flex;flex-wrap:wrap;gap:6px;padding:8px 10px;border-bottom:1px solid #1e2c4d}
.dennis-pop .qa button{font-size:11px;padding:4px 9px;border-radius:20px;border:1px solid #2c416f;background:#16243f;color:#cdddf7;cursor:pointer}
.dennis-pop .qa button:hover{background:#1d3257}
.dennis-pop .qa button:disabled{opacity:.5;cursor:default}
.dennis-pop .ms{flex:1;overflow:auto;padding:12px;display:flex;flex-direction:column;gap:10px}
.dennis-pop .b{max-width:88%;padding:8px 11px;border-radius:12px;font-size:13px;line-height:1.45;white-space:pre-wrap;word-wrap:break-word}
.dennis-pop .b.user{align-self:flex-end;background:#2f6df0;color:#fff;border-bottom-right-radius:4px}
.dennis-pop .b.dennis{align-self:flex-start;background:#17233f;border:1px solid #243663;border-bottom-left-radius:4px}
.dennis-pop .b .src{margin-top:6px;font-size:11px;color:#9fb2d6;border-top:1px dashed #2c416f;padding-top:5px}
.dennis-pop .b .ntc{display:block;margin-top:5px;font-size:10.5px;color:#7d8fb5}
.dennis-pop .typing span{display:inline-block;width:6px;height:6px;margin-right:3px;border-radius:50%;background:#9fb2d6;animation:dblink 1s infinite}
.dennis-pop .typing span:nth-child(2){animation-delay:.2s}.dennis-pop .typing span:nth-child(3){animation-delay:.4s}
@keyframes dblink{0%,60%,100%{opacity:.3}30%{opacity:1}}
.dennis-pop .cp{display:flex;gap:8px;padding:10px;border-top:1px solid #1e2c4d;background:#0c1428}
.dennis-pop .cp textarea{flex:1;resize:none;height:40px;border-radius:10px;border:1px solid #2c416f;background:#0f1d38;color:#e7edf8;padding:9px 11px;font-family:inherit;font-size:13px}
.dennis-pop .cp button{border:none;border-radius:10px;background:#2f6df0;color:#fff;padding:0 14px;cursor:pointer;display:flex;align-items:center;gap:6px}
.dennis-pop .cp button:disabled{opacity:.5;cursor:default}
`;

function clampPosition(next: WidgetPosition, width: number, height: number): WidgetPosition {
  if (typeof window === 'undefined') return next;
  const margin = 12;
  return {
    x: Math.min(Math.max(margin, next.x), Math.max(margin, window.innerWidth - width - margin)),
    y: Math.min(Math.max(margin, next.y), Math.max(margin, window.innerHeight - height - margin)),
  };
}
function readStoredPosition(): WidgetPosition | null {
  try { const raw = localStorage.getItem(STORAGE_KEY); if (!raw) return null; const p = JSON.parse(raw) as Partial<WidgetPosition>; return typeof p.x === 'number' && typeof p.y === 'number' ? p as WidgetPosition : null; } catch { return null; }
}
function defaultPosition(width: number, height: number): WidgetPosition {
  if (typeof window === 'undefined') return { x: 0, y: 0 };
  return { x: window.innerWidth - width - DEFAULT_OFFSET, y: window.innerHeight - height - DEFAULT_OFFSET };
}
function inferRecordId(pathname: string) { return pathname.match(/\/(\d+)(?:$|\/)/)?.[1] ?? null; }

export function DennisFloatingWidget({ user, dennisEnabled }: { user: ApiUser | null; dennisEnabled: boolean }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [position, setPosition] = useState<WidgetPosition | null>(null);
  const [messages, setMessages] = useState<FloatingMessage[]>([{ role: 'dennis', content: 'Hi, I’m Dennis. Ask me a quality question and I’ll search the laboratory’s approved documents and answer with sources. I can also help draft CAPAs, summaries and reports.' }]);
  const dragOffset = useRef({ x: 0, y: 0 });
  const dragging = useRef(false);
  const dragged = useRef(false);
  const msgEndRef = useRef<HTMLDivElement>(null);

  const currentModule = useMemo(() => {
    const sorted = [...MODULES].sort((a, b) => b.path.length - a.path.length);
    return sorted.find(m => location.pathname === m.path || location.pathname.startsWith(`${m.path}/`));
  }, [location.pathname]);
  const context: DennisContext = useMemo(() => ({
    currentRoute: location.pathname, currentModule: currentModule?.label ?? 'Unknown module',
    currentUserRole: user?.roleName ?? 'Unknown role', currentRecordId: inferRecordId(location.pathname),
    currentPageTitle: currentModule?.label ?? document.title ?? 'SECH_LIMS',
  }), [currentModule, location.pathname, user?.roleName]);

  useEffect(() => {
    const w = open ? PANEL_WIDTH : ICON_SIZE, h = open ? PANEL_HEIGHT : ICON_SIZE;
    setPosition(prev => clampPosition(prev ?? readStoredPosition() ?? defaultPosition(w, h), w, h));
  }, [open]);
  useEffect(() => { if (position) localStorage.setItem(STORAGE_KEY, JSON.stringify(position)); }, [position]);
  useEffect(() => {
    const onResize = () => setPosition(prev => prev ? clampPosition(prev, open ? PANEL_WIDTH : ICON_SIZE, open ? PANEL_HEIGHT : ICON_SIZE) : prev);
    window.addEventListener('resize', onResize); return () => window.removeEventListener('resize', onResize);
  }, [open]);
  useEffect(() => { msgEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, open]);
  // Allow other parts of the app (e.g. the document viewer) to open Dennis with a
  // pre-filled question via window.dispatchEvent(new CustomEvent('dennis:ask', {detail:{question}})).
  useEffect(() => {
    const handler = (e: Event) => { const d = (e as CustomEvent).detail as { question?: string } | undefined; setOpen(true); if (d?.question) setInput(String(d.question)); };
    window.addEventListener('dennis:ask', handler as EventListener);
    return () => window.removeEventListener('dennis:ask', handler as EventListener);
  }, []);

  if (!user || !dennisEnabled) return null;

  const startDrag = (e: PointerEvent<HTMLElement>) => { if (!position) return; dragging.current = true; dragged.current = false; dragOffset.current = { x: e.clientX - position.x, y: e.clientY - position.y }; e.currentTarget.setPointerCapture(e.pointerId); };
  // Header drag must NOT capture the pointer when the press lands on a control
  // (close / open-workspace buttons) — otherwise pointer capture swallows the
  // click and those buttons appear dead.
  const startHeaderDrag = (e: PointerEvent<HTMLElement>) => { if ((e.target as HTMLElement).closest('button')) return; startDrag(e); };
  const moveDrag = (e: PointerEvent<HTMLElement>) => { if (!dragging.current) return; const w = open ? PANEL_WIDTH : ICON_SIZE, h = open ? PANEL_HEIGHT : ICON_SIZE; if (Math.abs(e.clientX - (dragOffset.current.x + (position?.x ?? 0))) > 3 || Math.abs(e.clientY - (dragOffset.current.y + (position?.y ?? 0))) > 3) dragged.current = true; setPosition(clampPosition({ x: e.clientX - dragOffset.current.x, y: e.clientY - dragOffset.current.y }, w, h)); };
  const stopDrag = (e: PointerEvent<HTMLElement>) => { dragging.current = false; try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* already released */ } };

  const send = (message = input.trim()) => {
    if (!message || busy) return;
    setBusy(true);
    setMessages(prev => [...prev, { role: 'user', content: message }, { role: 'dennis', content: '', pending: true }]);
    setInput('');
    api<{ answer: string; sources?: Source[] }>('/dennis/ask', { method: 'POST', body: JSON.stringify({ question: message, context }) })
      .then(res => setMessages(prev => { const n = [...prev]; n[n.length - 1] = { role: 'dennis', content: res.answer, sources: res.sources }; return n; }))
      .catch(() => setMessages(prev => { const n = [...prev]; n[n.length - 1] = { role: 'dennis', content: createFloatingDennisResponse(message, context) }; return n; }))
      .finally(() => setBusy(false));
  };

  const style = position ? { left: position.x, top: position.y } : { right: DEFAULT_OFFSET, bottom: DEFAULT_OFFSET };

  if (!open) {
    return <>
      <style>{FLOAT_CSS}</style>
      <button type="button" className="dennis-fab" style={style as any} title="Ask Dennis" aria-label="Ask Dennis"
        onClick={() => { if (!dragged.current) setOpen(true); }}
        onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={stopDrag} onPointerCancel={stopDrag}>
        <span className="ring" /><span className="dot" /><MessageCircle size={26} />
      </button>
    </>;
  }

  const quickActions = ['Summarize this page', 'Find an SOP', 'Help with a CAPA', 'Show alerts'];
  return <>
    <style>{FLOAT_CSS}</style>
    <section className="dennis-pop" style={style as any} aria-label="Dennis chat">
      <div className="hd" onPointerDown={startHeaderDrag} onPointerMove={moveDrag} onPointerUp={stopDrag} onPointerCancel={stopDrag}>
        <span className="av"><Bot size={20} /></span>
        <span className="ti"><strong>Dennis</strong><small>{context.currentModule} · review before use</small></span>
        <button type="button" className="ic" title="Open full workspace" onClick={() => { setOpen(false); navigate('/dennis'); }}><Maximize2 size={16} /></button>
        <button type="button" className="ic" title="Minimize" onClick={() => setOpen(false)}><X size={18} /></button>
      </div>
      <div className="qa">{quickActions.map(a => <button type="button" key={a} disabled={busy} onClick={() => send(a)}>{a}</button>)}</div>
      <div className="ms">
        {messages.map((m, i) => <div key={i} className={`b ${m.role}`}>
          {m.pending ? <span className="typing"><span /><span /><span /></span> : m.content}
          {m.role === 'dennis' && !!m.sources?.length && <div className="src">Sources: {m.sources.map(s => `${s.title}${s.documentCode ? ` (${s.documentCode})` : ''}`).join('; ')}</div>}
          {m.role === 'dennis' && !m.pending && <span className="ntc">{DENNIS_NOTICE}</span>}
        </div>)}
        <div ref={msgEndRef} />
      </div>
      <form className="cp" onSubmit={e => { e.preventDefault(); send(); }}>
        <textarea value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} placeholder="Ask Dennis…" />
        <button type="submit" disabled={busy} aria-label="Send"><Send size={16} /></button>
      </form>
    </section>
  </>;
}
