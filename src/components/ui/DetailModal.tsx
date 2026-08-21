import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

/**
 * Two facts about dialogs that only one dialog can own.
 *
 * A record often opens another one over it — an item opens an adjustment, a
 * voucher opens its cancellation. Each of those is a DetailModal, so each was
 * separately saving and restoring `body.overflow` and separately answering
 * Escape. Both went wrong the moment there were two:
 *
 *   · the scroll lock was restored in whatever order React unmounted them, and
 *     the wrong order left `overflow: hidden` on the body with NO dialog open.
 *     The page could not be scrolled again until the app was restarted.
 *   · one Escape closed both, because `stopPropagation` does not stop other
 *     listeners already registered on the same node.
 *
 * So the lock is reference-counted — the first dialog takes it, the last one
 * gives it back — and a stack decides who Escape belongs to: the top one.
 */
let lockDepth = 0;
let lockedFrom = '';
const modalStack: string[] = [];

function lockScroll() {
  if (lockDepth === 0) {
    lockedFrom = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }
  lockDepth++;
}
function releaseScroll() {
  lockDepth = Math.max(0, lockDepth - 1);
  if (lockDepth === 0) document.body.style.overflow = lockedFrom;
}

/**
 * The one way a record opens in SECH_LIMS.
 *
 * Picking a row, a card or a unit used to reveal its detail *below* the list —
 * off the bottom of the screen, so nothing appeared to happen and people kept
 * clicking. A record now opens the way software everywhere opens one: over the
 * page, focused, with the list dimmed behind it and one obvious way out.
 *
 * It behaves the way an assessor and a screen reader both expect (WCAG 2.2 —
 * focus order, keyboard operability, no keyboard trap on exit):
 *
 *   · Escape closes it, and so does a click on the backdrop.
 *   · Focus moves into the dialog on open and returns to whatever opened it.
 *   · Tab cycles inside the dialog while it is up.
 *   · The page behind it cannot scroll, so the reader's place is not lost.
 *   · On a phone it becomes a full-height sheet rather than a squeezed box.
 */
export default function DetailModal({
  open, onClose, title, subtitle, header, children, width = 'wide', footer,
}: {
  open: boolean;
  onClose: () => void;
  /** Shown as the dialog's heading, and used as its accessible name. */
  title: ReactNode;
  subtitle?: ReactNode;
  /** Actions that belong beside the title — status chips, deactivate, delete. */
  header?: ReactNode;
  children: ReactNode;
  /** 'wide' for a workspace with tabs, 'narrow' for a single record. */
  width?: 'wide' | 'narrow';
  footer?: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const returnFocusTo = useRef<HTMLElement | null>(null);

  // onClose is nearly always written inline at the call site — `onClose={() =>
  // setSelected(null)}` — so it is a different function on every render of the
  // page behind the dialog. Depending on it would tear this effect down and
  // set it up again on every one of those renders, and typing into a field in
  // the dialog is exactly what causes them: each keystroke updates state on
  // the page, the effect re-runs, and its cleanup hands focus back to the
  // panel. The caret leaves the box mid-word and the rest of the sentence goes
  // nowhere. So the callback is held in a ref and the effect runs on `open`
  // alone — set up when the dialog opens, torn down when it closes.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const id = useId();

  useEffect(() => {
    if (!open) return;
    // Remember what opened this, so closing puts the caret back where it was.
    returnFocusTo.current = document.activeElement as HTMLElement | null;
    modalStack.push(id);

    const onKeyDown = (e: KeyboardEvent) => {
      // Escape belongs to the dialog on top. Without this every open dialog
      // answers the same keypress and one Escape shuts the whole stack.
      if (e.key === 'Escape') {
        if (modalStack[modalStack.length - 1] !== id) return;
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if (e.key !== 'Tab' || !panelRef.current) return;
      // A dialog with another one over it is not the one being tabbed through.
      if (modalStack[modalStack.length - 1] !== id) return;
      // Keep Tab inside the dialog: the page behind it is inert while it is up.
      const focusable = panelRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      const list = Array.from(focusable).filter(el => el.offsetParent !== null);
      if (list.length === 0) return;
      const first = list[0], last = list[list.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };

    document.addEventListener('keydown', onKeyDown, true);
    lockScroll();
    // Focus the panel itself rather than its first field, so opening a record
    // does not immediately put a cursor in an editable box.
    const t = window.setTimeout(() => panelRef.current?.focus(), 0);

    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      releaseScroll();
      const at = modalStack.lastIndexOf(id);
      if (at >= 0) modalStack.splice(at, 1);
      window.clearTimeout(t);
      // Only the dialog closing back to the page restores focus. A dialog
      // unmounting underneath another one would otherwise pull the caret out
      // of the dialog still on screen.
      if (modalStack.length === 0) returnFocusTo.current?.focus?.();
    };
  }, [open, id]);

  if (!open) return null;

  return createPortal(
    <div className="modal-scrim" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        className={`modal-panel ${width}`}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        tabIndex={-1}
        ref={panelRef}
      >
        <header className="modal-head">
          <div className="modal-title">
            <h3>{title}</h3>
            {subtitle && <p className="modal-sub">{subtitle}</p>}
          </div>
          <div className="modal-head-actions">
            {header}
            <button type="button" className="modal-x" onClick={onClose} aria-label="Close">
              <X size={18} />
            </button>
          </div>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}
