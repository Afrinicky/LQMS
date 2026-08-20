import { ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MoreHorizontal } from 'lucide-react';

/**
 * The row's own menu — where the actions that are not everyday live.
 *
 * Removing a record is not something to put under someone's thumb in a table
 * of a hundred rows, so it sits behind "⋯" with the other management actions.
 *
 * It is drawn in a portal at viewport coordinates because a register scrolls
 * sideways, and `overflow-x: auto` forces `overflow-y` to compute to `auto`
 * too: a menu positioned inside the table is clipped on both axes and the
 * clicks land on nothing. Positioned here, the last row of a long register
 * behaves like the first.
 */
export default function RowMenu({ label, children }: { label: string; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const MENU_W = 218;

  // Measured after paint, so the real height decides whether it flips.
  useLayoutEffect(() => {
    if (!open || !trigger.current) return;
    const place = () => {
      const btn = trigger.current?.getBoundingClientRect();
      if (!btn) return;
      // Scrolled out of sight entirely — there is nothing left to anchor to.
      if (btn.bottom < 0 || btn.top > window.innerHeight) { setOpen(false); return; }
      const height = panel.current?.offsetHeight ?? 90;
      const below = window.innerHeight - btn.bottom;
      const top = below < height + 12 && btn.top > height + 12 ? btn.top - height - 6 : btn.bottom + 6;
      const left = Math.max(8, Math.min(btn.right - MENU_W, window.innerWidth - MENU_W - 8));
      setPos({ top, left });
    };
    place();
    // Anything that moves the row moves the menu with it. It must NOT simply
    // close on scroll: opening a menu on a row near the bottom scrolls that row
    // into view, and a close-on-scroll handler then shuts the menu the instant
    // it appears — which is indistinguishable from the button not working.
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    document.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  useEffect(() => { if (!open) setPos(null); }, [open]);

  return <>
    <button type="button" ref={trigger} className="tiny reg-more" aria-label={label} aria-haspopup="menu" aria-expanded={open}
      onClick={e => { e.stopPropagation(); setOpen(o => !o); }}>
      <MoreHorizontal size={14} />
    </button>
    {open && createPortal(<>
      <div className="reg-menu-scrim" onClick={() => setOpen(false)} />
      <div ref={panel} className="reg-menu" role="menu"
        style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, width: MENU_W, visibility: pos ? 'visible' : 'hidden' }}>
        {children(() => setOpen(false))}
      </div>
    </>, document.body)}
  </>;
}
