import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';

/**
 * Where an answer appears.
 *
 * Every register in SECH_LIMS keeps its "saved" and its "could not save" in one
 * place: a line at the very top of the page. That is where the state lives, so
 * that is where it was drawn. But the save button is rarely at the top — it is
 * at the bottom of a form, three screens down — so a person pressed Save, the
 * page answered off-screen, and as far as they could tell nothing happened.
 * They pressed it again.
 *
 * The answer now goes to the action. A <Notice> still draws in place, because
 * an error about a form belongs beside that form and has to stay readable
 * while it is corrected. But when it appears somewhere the reader cannot see,
 * the same message is also shown as a toast pinned to the control they just
 * used — the button, the row menu item, the field they pressed Enter in. No
 * duplication: the toast only exists for the case where the banner is out of
 * sight.
 *
 * The "control they just used" is tracked here, from a capture-phase listener
 * on the document, so no call site has to pass an anchor.
 */

export type NoticeKind = 'error' | 'success' | 'warn' | 'info';

type Toast = {
  id: number;
  kind: NoticeKind;
  message: ReactNode;
  /** The control the person used, so the toast can be drawn beside it. */
  anchor: HTMLElement | null;
  /** How long it stays. Errors linger; confirmations do not need to. */
  ms: number;
};

// ---------------------------------------------------------------------------
// The action point
// ---------------------------------------------------------------------------

/** Things that count as "the place the action was performed". */
const ACTION_SELECTOR = [
  'button',
  '[role="button"]',
  'input[type="submit"]',
  'input[type="button"]',
  'a[href]',
  'summary',
  '[data-action-anchor]',
].join(',');

let lastAction: HTMLElement | null = null;
let listening = false;

function remember(target: EventTarget | null) {
  if (!(target instanceof Element)) return;
  const el = target.closest<HTMLElement>(ACTION_SELECTOR);
  // Typing Enter in a field is an action too; the field itself is the anchor.
  lastAction = el ?? (target instanceof HTMLElement && target.matches('input, textarea, select') ? target : lastAction);
}

function startListening() {
  if (listening || typeof document === 'undefined') return;
  listening = true;
  document.addEventListener('pointerdown', e => remember(e.target), true);
  document.addEventListener('keydown', e => {
    if ((e as KeyboardEvent).key === 'Enter' || (e as KeyboardEvent).key === ' ') remember(e.target);
  }, true);
  document.addEventListener('submit', e => remember(e.target), true);
}

/** The control the person last used, if it is still on the page. */
export function actionAnchor(): HTMLElement | null {
  if (!lastAction) return null;
  if (!document.contains(lastAction)) { lastAction = null; return null; }
  return lastAction;
}

// ---------------------------------------------------------------------------
// The toast store — a plain subscription, so raising one costs no re-render
// anywhere except the host that draws them.
// ---------------------------------------------------------------------------

let toasts: Toast[] = [];
let nextId = 1;
const subscribers = new Set<() => void>();

function publish() { for (const fn of subscribers) fn(); }

const DEFAULT_MS: Record<NoticeKind, number> = {
  error: 9000, warn: 8000, success: 4500, info: 5000,
};

/** The last few messages shown, so a re-render does not show one twice. */
const recent = new Map<string, number>();
const REPEAT_MS = 3000;

/** Shows a message at the control the person just used. */
export function notifyAtAction(kind: NoticeKind, message: ReactNode, ms?: number): number {
  startListening();
  // The same page can draw the same banner again — switching tab, a list
  // reloading underneath it — and that is not a second thing happening.
  const signature = `${kind}:${typeof message === 'string' ? message : ''}`;
  const now = Date.now();
  for (const [k, at] of recent) if (now - at > REPEAT_MS) recent.delete(k);
  if (signature.length > kind.length + 1 && recent.has(signature)) return 0;
  recent.set(signature, now);

  const id = nextId++;
  toasts = [...toasts.filter(t => t.kind !== kind || t.message !== message), {
    id, kind, message, anchor: actionAnchor(), ms: ms ?? DEFAULT_MS[kind],
  }].slice(-3); // three at once is already more than anyone reads
  publish();
  return id;
}

export function dismissToast(id: number) {
  toasts = toasts.filter(t => t.id !== id);
  publish();
}

function useToasts() {
  const [, force] = useState(0);
  useEffect(() => {
    const fn = () => force(n => n + 1);
    subscribers.add(fn);
    return () => { subscribers.delete(fn); };
  }, []);
  return toasts;
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

const ICONS: Record<NoticeKind, typeof Info> = {
  error: XCircle, success: CheckCircle2, warn: AlertTriangle, info: Info,
};

/** Class the existing stylesheet already carries, so old markup keeps working. */
const KIND_CLASS: Record<NoticeKind, string> = {
  error: 'error', success: 'notice-ok', warn: 'notice-warn', info: 'notice-info',
};

/**
 * A message about something that just happened, drawn where it is placed.
 *
 * `kind` picks the colour and the icon. Anything else — style, extra classes —
 * is passed straight through, so it drops into the markup it replaces.
 */
export function Notice({
  kind = 'info', children, className, style, silent = false, role,
}: {
  kind?: NoticeKind;
  children: ReactNode;
  className?: string;
  style?: React.CSSProperties;
  /** Set on a banner that is part of the page furniture rather than an answer
   *  to an action — a standing rule, a hint — so it never raises a toast. */
  silent?: boolean;
  role?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const Icon = ICONS[kind];
  // Re-checked whenever the wording changes: the same box saying something new
  // is a new answer, and it has to reach the reader wherever they are looking.
  const key = typeof children === 'string' || typeof children === 'number' ? String(children) : '';

  useLayoutEffect(() => {
    if (silent) return;
    const el = ref.current;
    if (!el) return;
    // One frame's grace: a banner drawn as the page re-lays-out reports a
    // position it is about to leave.
    const raf = requestAnimationFrame(() => {
      if (!ref.current || !document.contains(ref.current)) return;
      if (isOnScreen(ref.current)) return;
      notifyAtAction(kind, textOf(ref.current));
    });
    return () => cancelAnimationFrame(raf);
  }, [key, kind, silent]);

  return (
    <div
      ref={ref}
      className={`fb-notice fb-${kind} ${KIND_CLASS[kind]} ${className ?? ''}`.trim()}
      style={style}
      role={role ?? (kind === 'error' ? 'alert' : 'status')}
    >
      <Icon size={16} className="fb-notice-ico" aria-hidden />
      <div className="fb-notice-body">{children}</div>
    </div>
  );
}

/** What the banner actually says, for repeating in the toast. */
function textOf(el: HTMLElement): string {
  const body = el.querySelector<HTMLElement>('.fb-notice-body') ?? el;
  return (body.innerText || body.textContent || '').trim();
}

/** Whether the reader can see it without scrolling. */
function isOnScreen(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return false;
  // The top bar sits over the page, so a banner under it is not readable.
  const top = 72;
  return r.bottom > top + 8 && r.top < window.innerHeight - 8;
}

const GAP = 10;
const TOAST_W = 340;

/** Keeps one toast beside its control as the page moves under it. */
function AnchoredToast({ toast }: { toast: Toast }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const Icon = ICONS[toast.kind];

  useLayoutEffect(() => {
    const place = () => {
      const anchor = toast.anchor;
      const box = ref.current;
      if (!box) return;
      const h = box.offsetHeight || 64;
      if (!anchor || !document.contains(anchor)) { setPos(null); return; }
      const r = anchor.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) { setPos(null); return; }
      // Below the control by preference, above it when there is no room.
      let top = r.bottom + GAP;
      if (top + h > window.innerHeight - 12) top = Math.max(12, r.top - GAP - h);
      // Left-aligned to the control, pulled back inside the window.
      let left = r.left;
      left = Math.min(left, window.innerWidth - TOAST_W - 16);
      left = Math.max(16, left);
      setPos({ top, left });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [toast.anchor, toast.id]);

  useEffect(() => {
    const t = window.setTimeout(() => dismissToast(toast.id), toast.ms);
    return () => window.clearTimeout(t);
  }, [toast.id, toast.ms]);

  // With no live control to point at, it falls to the corner rather than
  // disappearing — an answer nobody sees is the bug this exists to fix.
  const style: React.CSSProperties = pos
    ? { top: pos.top, left: pos.left }
    : { bottom: 24, right: 24 };

  return (
    <div
      ref={ref}
      className={`fb-toast fb-${toast.kind} ${pos ? 'fb-toast-anchored' : 'fb-toast-corner'}`}
      style={style}
      role={toast.kind === 'error' ? 'alert' : 'status'}
    >
      <span className="fb-toast-ico"><Icon size={16} aria-hidden /></span>
      <div className="fb-toast-body">{toast.message}</div>
      <button type="button" className="fb-toast-x" onClick={() => dismissToast(toast.id)} aria-label="Dismiss">
        <X size={14} />
      </button>
      <span className="fb-toast-rail" style={{ animationDuration: `${toast.ms}ms` }} />
    </div>
  );
}

/** Mounted once by the shell. Draws whatever toasts are up. */
export function FeedbackHost() {
  const list = useToasts();
  useEffect(startListening, []);
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div className="fb-layer" aria-live="polite">
      {list.map(t => <AnchoredToast key={t.id} toast={t} />)}
    </div>,
    document.body,
  );
}
