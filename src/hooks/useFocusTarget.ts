import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';

// ==========================================================================
// useFocusTarget — makes dashboard alerts land "exactly where the problem is".
//
// Alert/notification action URLs carry `?focus=<recordType>:<recordId>` (set
// by the server's actionUrlFor). Any page can call this hook to scroll the
// matching record into view and flash it, so a click on the dashboard opens
// the record, not just the module.
//
// A page marks its rows/cards with `data-focus="<recordType>:<recordId>"`
// (or use `focusAttr(recordType, id)` below). The hook re-runs whenever the
// focus param or the provided `ready` signal changes, so it also works once
// async data has loaded and the target has rendered.
// ==========================================================================

export function focusAttr(recordType: string | undefined | null, recordId: string | number | undefined | null) {
  if (!recordType || recordId === undefined || recordId === null || recordId === '') return {};
  return { 'data-focus': `${recordType}:${recordId}` };
}

export function useFocusTarget(ready: unknown = true) {
  const [params] = useSearchParams();
  const focus = params.get('focus');

  useEffect(() => {
    if (!focus) return;
    // Wait a tick so freshly-rendered rows exist in the DOM.
    const timer = window.setTimeout(() => {
      const safe = (window.CSS && CSS.escape) ? CSS.escape(focus) : focus.replace(/"/g, '\\"');
      const el = document.querySelector<HTMLElement>(`[data-focus="${safe}"]`);
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('focus-flash');
      const clear = () => el.classList.remove('focus-flash');
      window.setTimeout(clear, 2600);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [focus, ready]);

  return focus;
}
