import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useLocation } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { onWriteOutcome, writeOutcomeCounts } from '../../services/api';

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
/**
 * How long a message stays up.
 *
 * A refusal is held far longer than a confirmation, because it has to be read
 * and usually acted on. It is not held forever: the page that raised it renders
 * the same sentence inline as well, so the record of what went wrong does not
 * depend on the floating copy — and a floating copy that never leaves is litter
 * anchored to a control that may no longer be there.
 */
const HOLD_MS: Record<NoticeKind, number> = {
  error: 20000,
  warn: 20000,
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

/** Shows a message beside the control the person just used. */
export function notifyAtAction(kind: NoticeKind, message: string, point?: Point | null): number {
  const where = point ?? actionPoint();
  if (!where) return 0;

  // The same sentence, still on screen, said again: it does not need to be
  // drawn twice — it needs to move to the control that has just been used.
  // Pressing Sign on one row and then on the next should walk the refusal down
  // the table rather than leave it behind at the first row.
  if (current && current.kind === kind && current.message === message) {
    current = { ...current, point: where };
    publish();
    return current.id;
  }

  const id = nextId++;
  current = { id, kind, message, point: where };
  publish();
  return id;
}

/** True when this exact sentence is the one on screen. */
function isShowing(kind: NoticeKind, message: string) {
  return Boolean(current && current.kind === kind && current.message === message);
}

export function dismissToast(id: number) {
  if (current && current.id === id) { current = null; publish(); }
}

/**
 * Take down whatever is up.
 *
 * Called when the page changes. A message is an answer to something the person
 * just did HERE — "FOREIGN KEY constraint failed" on the declarations screen
 * means nothing floating over the main dashboard a moment later, and an error
 * that follows somebody around the application until they close it by hand
 * reads as a fault in the application rather than an answer to their action.
 */
export function clearToasts() {
  if (current) { current = null; publish(); }
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
    <span className="fb-ico"><Icon size={16} strokeWidth={2.3} aria-hidden /></span>
    <div className="fb-main">
      <strong className="fb-title">{TITLES[kind]}</strong>
      <div className="fb-text">{message}</div>
    </div>
    {onClose && (
      <button type="button" className="fb-x" onClick={onClose} aria-label="Dismiss">
        <X size={13} />
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
  const [, redraw] = useState(0);

  // A second identical refusal changes nothing in this component's props — the
  // page set its state to the string it already held — so the only way to hear
  // about it is from the request layer, which knows a write just came back.
  useEffect(() => {
    if (!sendable) return;
    return onWriteOutcome(() => redraw(n => n + 1));
  }, [sendable]);

  // Runs after every render, and does something only when there is genuinely
  // something new to say: a different sentence, or the same one after another
  // write settled the same way.
  const answered = useRef<{ text: string; kind: NoticeKind; count: number } | null>(null);
  useLayoutEffect(() => {
    if (!sendable) {
      answered.current = null;
      if (sent) setSent(false);
      return;
    }
    const counts = writeOutcomeCounts();
    const count = kind === 'error' ? counts.failures : counts.successes;
    const last = answered.current;
    if (last && last.text === text && last.kind === kind && last.count === count) return;
    answered.current = { text, kind, count };
    const delivered = notifyAtAction(kind, text) !== 0 || isShowing(kind, text);
    if (delivered !== sent) setSent(delivered);
  });

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

const GAP = 8;
const WIDTH = 300;

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
  const { pathname, search } = useLocation();
  useEffect(startListening, []);

  // Leaving the page takes the message with it. It was an answer to something
  // done there; carried onto the next screen it is just an alarm with no
  // subject, and it used to sit there until somebody closed it by hand.
  useEffect(() => { clearToasts(); }, [pathname, search]);

  if (typeof document === 'undefined') return null;
  return createPortal(
    <div className="fb-layer" aria-live="polite">
      {toast && <ActionMessage key={toast.id} toast={toast} />}
    </div>,
    document.body,
  );
}
