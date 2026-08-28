import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';

/**
 * Where an answer appears, and what it looks like.
 *
 * Every register in SECH_LIMS used to keep its "saved" and its "could not
 * save" in one place: a line at the very top of the page. That is where the
 * state lives, so that is where it was drawn. But the button that caused it is
 * rarely at the top — it is at the bottom of a form, or in a row halfway down a
 * table — so a person pressed the button, the page answered off-screen, and as
 * far as they could tell nothing happened. They pressed it again.
 *
 * So the answer goes to the action, and it goes there ONLY. When the control
 * that was used is known, the message is drawn beside that control and the
 * banner in the page is not drawn at all — one message, in one place, where the
 * person is already looking. The banner in the page is the fallback for the
 * cases where there is no control to point at: a page that failed while it was
 * loading, a background refresh, a message whose content is too rich to repeat
 * (a list, a link) and therefore belongs in the layout.
 *
 * The control is tracked here, from a capture-phase listener on the document,
 * so no call site has to pass an anchor. Its position is remembered as well as
 * its node: a row that reloads after saving replaces the button that was
 * pressed, and the message should still appear where that button was rather
 * than jumping to a corner of the screen.
 *
 * Nothing here animates. A message that slides, fades or counts itself down
 * draws the eye to the movement rather than to the sentence.
 */

export type NoticeKind = 'error' | 'success' | 'warn' | 'info';

/** The heading each kind carries, the way a notification is normally labelled. */
const TITLES: Record<NoticeKind, string> = {
  error: 'Error', success: 'Success', warn: 'Warning', info: 'Info',
};

const ICONS: Record<NoticeKind, typeof Info> = {
  error: XCircle, success: CheckCircle2, warn: AlertTriangle, info: Info,
};

/**
 * How long each kind stays.
 *
 * An error is not a status update — it is something to read, act on, and often
 * to retype a field because of, so it waits to be dismissed. A confirmation has
 * done its job the moment it is seen.
 */
const HOLD_MS: Record<NoticeKind, number> = {
  error: 0, // stays until dismissed or replaced
  warn: 0,
  success: 5000,
  info: 5000,
};

type Point = { el: HTMLElement | null; rect: DOMRect | null };

type Toast = { id: number; kind: NoticeKind; message: string; point: Point };

// ---------------------------------------------------------------------------
// The action point
// ---------------------------------------------------------------------------

const ACTION_SELECTOR = [
  'button',
  '[role="button"]',
  'input[type="submit"]',
  'input[type="button"]',
  'a[href]',
  'summary',
  '[data-action-anchor]',
].join(',');

let lastEl: HTMLElement | null = null;
let lastRect: DOMRect | null = null;
let lastAt = 0;
let listening = false;

/**
 * How long after a click a message still counts as that click's answer.
 * Generous, because a save on a slow host is still the answer to the save.
 */
const ANSWER_WINDOW_MS = 30000;

function remember(target: EventTarget | null) {
  if (!(target instanceof Element)) return;
  const el = target.closest<HTMLElement>(ACTION_SELECTOR)
    ?? (target instanceof HTMLElement && target.matches('input, textarea, select') ? target : null);
  if (!el) return;
  lastEl = el;
  lastRect = el.getBoundingClientRect();
  lastAt = Date.now();
}

function startListening() {
  if (listening || typeof document === 'undefined') return;
  listening = true;
  document.addEventListener('pointerdown', e => remember(e.target), true);
  document.addEventListener('keydown', e => {
    const k = (e as KeyboardEvent).key;
    if (k === 'Enter' || k === ' ') remember(e.target);
  }, true);
  document.addEventListener('submit', e => remember(e.target), true);
}

/** The control the message is an answer to, or null when there is not one. */
export function actionPoint(): Point | null {
  startListening();
  if (!lastEl || Date.now() - lastAt > ANSWER_WINDOW_MS) return null;
  // The node itself if it survived, otherwise where it was when it was used —
  // a table row that reloads after saving replaces the button that was pressed.
  if (document.contains(lastEl)) {
    const rect = lastEl.getBoundingClientRect();
    if (rect.width || rect.height) return { el: lastEl, rect };
  }
  return lastRect ? { el: null, rect: lastRect } : null;
}

// ---------------------------------------------------------------------------
// The message on screen — one at a time, because one thing happened
// ---------------------------------------------------------------------------

let current: Toast | null = null;
let nextId = 1;
const subscribers = new Set<() => void>();
function publish() { for (const fn of subscribers) fn(); }

/** The last message shown, so a page re-drawing does not repeat it. */
let lastSignature = '';
let lastSignatureAt = 0;
const REPEAT_MS = 3000;

/** Shows a message beside the control the person just used. */
export function notifyAtAction(kind: NoticeKind, message: string, point?: Point | null): number {
  const where = point ?? actionPoint();
  if (!where) return 0;

  const signature = `${kind}:${message}`;
  const now = Date.now();
  if (signature === lastSignature && now - lastSignatureAt < REPEAT_MS) return 0;
  lastSignature = signature;
  lastSignatureAt = now;

  const id = nextId++;
  current = { id, kind, message, point: where };
  publish();
  return id;
}

export function dismissToast(id: number) {
  if (current && current.id === id) { current = null; publish(); }
}

function useCurrent() {
  const [, force] = useState(0);
  useEffect(() => {
    const fn = () => force(n => n + 1);
    subscribers.add(fn);
    return () => { subscribers.delete(fn); };
  }, []);
  return current;
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

/** The message itself: a colour block, a heading, the sentence, a way out. */
function Body({ kind, message, onClose }: { kind: NoticeKind; message: ReactNode; onClose?: () => void }) {
  const Icon = ICONS[kind];
  return <>
    <span className="fb-ico"><Icon size={20} strokeWidth={2.2} aria-hidden /></span>
    <div className="fb-main">
      <strong className="fb-title">{TITLES[kind]}</strong>
      <div className="fb-text">{message}</div>
    </div>
    {onClose && (
      <button type="button" className="fb-x" onClick={onClose} aria-label="Dismiss">
        <X size={16} />
      </button>
    )}
  </>;
}

/**
 * A message about something that just happened.
 *
 * When the control that caused it is known, this draws nothing and the message
 * appears beside that control instead. `silent` marks a banner that is page
 * furniture rather than an answer — a standing rule, a hint — which always
 * draws in place and never goes to a control.
 */
export function Notice({
  kind = 'info', children, className, style, silent = false, role,
}: {
  kind?: NoticeKind;
  children: ReactNode;
  className?: string;
  style?: React.CSSProperties;
  silent?: boolean;
  role?: string;
}) {
  // Only a plain sentence can be repeated beside a button. A message built out
  // of a list, a link or a table is part of the layout and stays in it.
  const text = typeof children === 'string' || typeof children === 'number' ? String(children) : '';
  const sendable = !silent && text.trim() !== '';
  const [sent, setSent] = useState(false);

  useLayoutEffect(() => {
    if (!sendable) { setSent(false); return; }
    setSent(notifyAtAction(kind, text) !== 0 || wasJustShown(kind, text));
  }, [text, kind, sendable]);

  if (sent) return null;

  return (
    <div
      className={`fb-notice fb-${kind} ${className ?? ''}`.trim()}
      style={style}
      role={role ?? (kind === 'error' ? 'alert' : 'status')}
    >
      <Body kind={kind} message={children} />
    </div>
  );
}

/**
 * True when this exact message is the one already on screen. A page that
 * re-renders must not fall back to drawing the banner as well, or the reader
 * gets the same sentence twice — once at the control and once at the top.
 */
function wasJustShown(kind: NoticeKind, text: string) {
  return lastSignature === `${kind}:${text}` && Date.now() - lastSignatureAt < REPEAT_MS;
}

const GAP = 8;
const WIDTH = 380;

/** Keeps the message beside its control as the page moves under it. */
function ActionMessage({ toast }: { toast: Toast }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const place = () => {
      const box = ref.current;
      if (!box) return;
      const h = box.offsetHeight || 68;
      const el = toast.point.el;
      const r = el && document.contains(el) ? el.getBoundingClientRect() : toast.point.rect;
      if (!r) { setPos(null); return; }
      // Under the control by preference, over it when there is no room.
      let top = r.bottom + GAP;
      if (top + h > window.innerHeight - 12) top = Math.max(12, r.top - GAP - h);
      let left = Math.min(r.left, window.innerWidth - WIDTH - 16);
      setPos({ top, left: Math.max(16, left) });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [toast.id, toast.point]);

  useEffect(() => {
    const hold = HOLD_MS[toast.kind];
    if (!hold) return;
    const t = window.setTimeout(() => dismissToast(toast.id), hold);
    return () => window.clearTimeout(t);
  }, [toast.id, toast.kind]);

  return (
    <div
      ref={ref}
      className={`fb-notice fb-at-action fb-${toast.kind}`}
      style={pos ? { top: pos.top, left: pos.left } : { visibility: 'hidden' }}
      role={toast.kind === 'error' ? 'alert' : 'status'}
    >
      <Body kind={toast.kind} message={toast.message} onClose={() => dismissToast(toast.id)} />
    </div>
  );
}

/** Mounted once by the shell. Draws the message that is up, if there is one. */
export function FeedbackHost() {
  const toast = useCurrent();
  useEffect(startListening, []);
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div className="fb-layer" aria-live="polite">
      {toast && <ActionMessage key={toast.id} toast={toast} />}
    </div>,
    document.body,
  );
}
