import { useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';

// ==========================================================================
// useTabParam — opens the workspace tab a link asks for.
//
// A dashboard alert carries `?tab=<name>` (and `?subtab=<name>` for a
// workspace nested inside another module's tab), chosen from ALERT_TARGETS by
// the alert scan. Without this, every alert landed on its module's front page
// and left the reader to hunt for the record.
//
// The hook only ever selects a tab the caller offers, so a tab a user is not
// permitted to see cannot be opened by putting its name in a URL — the caller
// passes its already-permission-filtered list.
//
// Matching is case- and punctuation-insensitive so a link survives a tab being
// renamed from "Batches/Lots" to "Batches / Lots". It applies once per value of
// the parameter, so the user can click away afterwards without being dragged
// back.
// ==========================================================================

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

export function useTabParam(tabs: string[], onChange: (name: string) => void, param: 'tab' | 'subtab' = 'tab') {
  const [params] = useSearchParams();
  const wanted = params.get(param);
  const applied = useRef<string | null>(null);

  useEffect(() => {
    if (!wanted || tabs.length === 0) return;
    if (applied.current === wanted) return;
    const match = tabs.find(t => norm(t) === norm(wanted));
    if (!match) return; // not offered here (or not permitted) — leave the page alone
    applied.current = wanted;
    onChange(match);
    // onChange is a setState in every caller, so it is safe to leave out.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted, tabs]);
}
