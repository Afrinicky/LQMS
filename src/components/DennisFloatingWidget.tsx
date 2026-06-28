import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Bot, GripHorizontal, Send, X } from 'lucide-react';
import { MODULES } from '../../shared/constants/modules';
import type { ApiUser } from '../../shared/types/api';
import { DENNIS_NOTICE, createFloatingDennisResponse } from '../services/dennisService';
import { api } from '../services/api';

type WidgetPosition = { x: number; y: number };
type FloatingMessage = { role: 'user' | 'dennis'; content: string };
type DennisContext = {
  currentRoute: string;
  currentModule: string;
  currentUserRole: string;
  currentRecordId: string | null;
  currentPageTitle: string;
};

const STORAGE_KEY = 'dennis_floating_widget_position';
const DEFAULT_OFFSET = 24;
const BUTTON_SIZE = 72;
const PANEL_WIDTH = 390;
const PANEL_HEIGHT = 540;

function clampPosition(next: WidgetPosition, width: number, height: number): WidgetPosition {
  if (typeof window === 'undefined') return next;
  const margin = 12;
  return {
    x: Math.min(Math.max(margin, next.x), Math.max(margin, window.innerWidth - width - margin)),
    y: Math.min(Math.max(margin, next.y), Math.max(margin, window.innerHeight - height - margin))
  };
}

function readStoredPosition(): WidgetPosition | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<WidgetPosition>;
    if (typeof parsed.x !== 'number' || typeof parsed.y !== 'number') return null;
    return parsed as WidgetPosition;
  } catch {
    return null;
  }
}

function defaultPosition(width: number, height: number): WidgetPosition {
  if (typeof window === 'undefined') return { x: 0, y: 0 };
  return { x: window.innerWidth - width - DEFAULT_OFFSET, y: window.innerHeight - height - DEFAULT_OFFSET };
}

function inferRecordId(pathname: string) {
  const match = pathname.match(/\/(\d+)(?:$|\/)/);
  return match?.[1] ?? null;
}

export function DennisFloatingWidget({ user, dennisEnabled }: { user: ApiUser | null; dennisEnabled: boolean }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [position, setPosition] = useState<WidgetPosition | null>(null);
  const [messages, setMessages] = useState<FloatingMessage[]>([
    { role: 'dennis', content: 'Hello, I am Dennis. Ask me for placeholder quality assistance from anywhere in SECH_LIMS.' }
  ]);
  const dragOffset = useRef({ x: 0, y: 0 });
  const dragging = useRef(false);
  const dragged = useRef(false);

  const currentModule = useMemo(() => {
    const sorted = [...MODULES].sort((a, b) => b.path.length - a.path.length);
    return sorted.find(m => location.pathname === m.path || location.pathname.startsWith(`${m.path}/`));
  }, [location.pathname]);

  const context: DennisContext = useMemo(() => ({
    currentRoute: location.pathname,
    currentModule: currentModule?.label ?? 'Unknown module',
    currentUserRole: user?.roleName ?? 'Unknown role',
    currentRecordId: inferRecordId(location.pathname),
    currentPageTitle: currentModule?.label ?? document.title ?? 'SECH_LIMS'
  }), [currentModule, location.pathname, user?.roleName]);

  useEffect(() => {
    const width = open ? PANEL_WIDTH : BUTTON_SIZE;
    const height = open ? PANEL_HEIGHT : BUTTON_SIZE;
    setPosition(prev => clampPosition(prev ?? readStoredPosition() ?? defaultPosition(width, height), width, height));
  }, [open]);

  useEffect(() => {
    if (!position) return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(position));
  }, [position]);

  useEffect(() => {
    const onResize = () => setPosition(prev => prev ? clampPosition(prev, open ? PANEL_WIDTH : BUTTON_SIZE, open ? PANEL_HEIGHT : BUTTON_SIZE) : prev);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [open]);

  if (!user || !dennisEnabled) return null;

  const startDrag = (event: PointerEvent<HTMLElement>) => {
    if (!position) return;
    dragging.current = true;
    dragged.current = false;
    dragOffset.current = { x: event.clientX - position.x, y: event.clientY - position.y };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveDrag = (event: PointerEvent<HTMLElement>) => {
    if (!dragging.current) return;
    const width = open ? PANEL_WIDTH : BUTTON_SIZE;
    const height = open ? PANEL_HEIGHT : BUTTON_SIZE;
    const next = { x: event.clientX - dragOffset.current.x, y: event.clientY - dragOffset.current.y };
    dragged.current = true;
    setPosition(clampPosition(next, width, height));
  };

  const stopDrag = (event: PointerEvent<HTMLElement>) => {
    dragging.current = false;
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* pointer capture may already be released */ }
  };

  const send = (message = input.trim()) => {
    if (!message) return;
    setMessages(prev => [...prev, { role: 'user', content: message }, { role: 'dennis', content: 'Searching approved documents…' }]);
    setInput('');
    // Ask the live Dennis backend with the current page context so answers are
    // source-grounded and prioritised for the module the user is on. Falls back
    // to an offline placeholder if the backend is unreachable.
    api<{ answer: string }>('/dennis/ask', { method: 'POST', body: JSON.stringify({ question: message, context }) })
      .then(res => setMessages(prev => { const next = [...prev]; next[next.length - 1] = { role: 'dennis', content: res.answer }; return next; }))
      .catch(() => setMessages(prev => { const next = [...prev]; next[next.length - 1] = { role: 'dennis', content: createFloatingDennisResponse(message, context) }; return next; }));
  };

  const style = position ? { left: position.x, top: position.y } : { right: DEFAULT_OFFSET, bottom: DEFAULT_OFFSET };

  if (!open) {
    return <button
      type="button"
      className="dennis-float-button"
      style={style}
      title="Ask Dennis"
      aria-label="Ask Dennis"
      onClick={() => { if (!dragged.current) setOpen(true); }}
      onPointerDown={startDrag}
      onPointerMove={moveDrag}
      onPointerUp={stopDrag}
      onPointerCancel={stopDrag}
    >
      <span className="dennis-float-avatar"><Bot size={24} /></span>
      <span>Ask Dennis</span>
      <span className="dennis-float-badge">3</span>
    </button>;
  }

  return <section className="dennis-float-panel" style={style} aria-label="Dennis floating chatbot">
    <header
      className="dennis-float-header"
      onPointerDown={startDrag}
      onPointerMove={moveDrag}
      onPointerUp={stopDrag}
      onPointerCancel={stopDrag}
    >
      <span className="dennis-float-avatar"><Bot size={22} /></span>
      <span className="dennis-float-title"><strong>Dennis</strong><small>AI Quality Assistant</small></span>
      <span className="dennis-float-context"><GripHorizontal size={14} /> {context.currentModule}</span>
      <button type="button" className="dennis-float-close" onClick={() => setOpen(false)} aria-label="Minimize Dennis"><X size={17} /></button>
    </header>
    <div className="dennis-float-quick-actions">
      {['Ask about SOP', 'Help with CAPA', 'Summarize this page', 'Show pending alerts'].map(action => <button type="button" key={action} onClick={() => send(action)}>{action}</button>)}
      <button type="button" onClick={() => navigate('/dennis')}>Open Full Dennis Workspace</button>
    </div>
    <div className="dennis-float-messages">
      {messages.map((message, index) => <article key={`${message.role}-${index}`} className={`dennis-float-message ${message.role}`}>
        <strong>{message.role === 'dennis' ? 'Dennis' : 'You'}</strong>
        <p>{message.content}</p>
        {message.role === 'dennis' && <span>{DENNIS_NOTICE}</span>}
      </article>)}
    </div>
    <form className="dennis-float-compose" onSubmit={event => { event.preventDefault(); send(); }}>
      <textarea value={input} onChange={event => setInput(event.target.value)} placeholder="Ask Dennis for safe placeholder assistance…" />
      <button type="submit"><Send size={16} /> Send</button>
    </form>
  </section>;
}
