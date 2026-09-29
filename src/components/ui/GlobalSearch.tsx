import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../services/api';

// ==========================================================================
// GlobalSearch — the top bar's search field, for real.
//
// The field used to be an input with a placeholder and nothing behind it, on
// both the Home launchpad and inside the application shell. It now asks
// /api/search, which reaches every register the signed-in user may view, and
// opens the record that is chosen.
//
// What the interaction has to get right:
//
//  * Typing must not fire a request per keystroke, so the query is debounced
//    and an in-flight request whose query is no longer current is discarded
//    rather than rendered — otherwise a slow early response can overwrite a
//    fast later one and the reader sees results for what they used to be
//    typing.
//  * It must be usable from the keyboard alone: ↑/↓ move, Enter opens, Escape
//    closes (and a second Escape clears), and the listbox/option roles let a
//    screen reader follow along.
//  * It must close on a click anywhere else, and on navigating away.
// ==========================================================================

export type SearchHit = {
  type: string;
  moduleKey: string;
  moduleLabel: string;
  id: number;
  code: string | null;
  title: string;
  detail: string;
  url: string;
};

type SearchResponse = { query: string; results: SearchHit[]; truncated: boolean };

/** Below this, a substring match returns most of the database and helps nobody. */
const MIN_QUERY = 2;
const DEBOUNCE_MS = 220;

export default function GlobalSearch({
  placeholder = 'Search documents, staff, equipment, actions, evidence…',
  className = 'search',
  style,
}: {
  placeholder?: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [active, setActive] = useState(0);

  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  /** Ignore a response the query has already moved past. */
  const latest = useRef(0);
  const listId = useId();

  const trimmed = query.trim();

  useEffect(() => {
    if (trimmed.length < MIN_QUERY) {
      setHits([]); setTruncated(false); setBusy(false); setFailed(false);
      return;
    }
    setBusy(true);
    const seq = ++latest.current;
    const timer = window.setTimeout(() => {
      api<SearchResponse>(`/search?q=${encodeURIComponent(trimmed)}`)
        .then(data => {
          if (seq !== latest.current) return;
          setHits(data.results);
          setTruncated(data.truncated);
          setFailed(false);
          setActive(0);
        })
        .catch(() => {
          if (seq !== latest.current) return;
          setHits([]); setTruncated(false); setFailed(true);
        })
        .finally(() => { if (seq === latest.current) setBusy(false); });
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [trimmed]);

  // A click anywhere outside puts the field away.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const close = useCallback(() => { setOpen(false); setActive(0); }, []);

  const openHit = useCallback((hit: SearchHit) => {
    close();
    setQuery('');
    setHits([]);
    inputRef.current?.blur();
    navigate(hit.url);
  }, [close, navigate]);

  /** Results in the order they arrive, grouped under the register they came from. */
  const groups = useMemo(() => {
    const out: { type: string; items: SearchHit[] }[] = [];
    for (const hit of hits) {
      const last = out[out.length - 1];
      if (last && last.type === hit.type) last.items.push(hit);
      else out.push({ type: hit.type, items: [hit] });
    }
    return out;
  }, [hits]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      // First Escape puts the list away; a second clears what was typed.
      if (open && hits.length > 0) close();
      else { setQuery(''); close(); inputRef.current?.blur(); }
      return;
    }
    if (!open || hits.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive(i => (i + 1) % hits.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(i => (i - 1 + hits.length) % hits.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const hit = hits[active];
      if (hit) openHit(hit);
    }
  };

  const showPanel = open && trimmed.length >= MIN_QUERY;
  const activeId = hits[active] ? `${listId}-opt-${active}` : undefined;

  return (
    <div className="global-search" ref={wrapRef}>
      <div className={className} style={style}>
        <Search size={16} />
        <input
          ref={inputRef}
          type="search"
          value={query}
          placeholder={placeholder}
          onChange={e => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          role="combobox"
          aria-expanded={showPanel}
          aria-controls={showPanel ? listId : undefined}
          aria-activedescendant={activeId}
          aria-autocomplete="list"
          aria-label="Search the laboratory"
          autoComplete="off"
          spellCheck={false}
          style={{ border: 0, background: 'transparent', padding: 0, boxShadow: 'none', flex: 1 }}
        />
        {query && (
          <button type="button" className="gs-clear" aria-label="Clear search"
            onClick={() => { setQuery(''); close(); inputRef.current?.focus(); }}>
            <X size={14} />
          </button>
        )}
      </div>

      {showPanel && (
        <div className="gs-panel" role="presentation">
          {busy && hits.length === 0 && <p className="gs-note">Searching…</p>}
          {!busy && failed && <p className="gs-note">Search is unavailable right now.</p>}
          {!busy && !failed && hits.length === 0 && (
            <p className="gs-note">No match for “{trimmed}”.</p>
          )}

          {hits.length > 0 && (
            <ul className="gs-list" id={listId} role="listbox" aria-label="Search results">
              {groups.map(group => (
                <li key={group.type} className="gs-group" role="presentation">
                  <p className="gs-group-label">{group.type}</p>
                  <ul role="presentation">
                    {group.items.map(hit => {
                      const index = hits.indexOf(hit);
                      return (
                        <li
                          key={`${hit.type}-${hit.id}`}
                          id={`${listId}-opt-${index}`}
                          role="option"
                          aria-selected={index === active}
                          className={`gs-item ${index === active ? 'is-active' : ''}`}
                          onMouseEnter={() => setActive(index)}
                          onMouseDown={e => e.preventDefault() /* keep focus so blur cannot close first */}
                          onClick={() => openHit(hit)}
                        >
                          <span className="gs-main">
                            <span className="gs-title">{hit.title}</span>
                            <span className="gs-sub">
                              {[hit.code, hit.detail].filter(Boolean).join(' · ') || hit.moduleLabel}
                            </span>
                          </span>
                          <span className="gs-module">{hit.moduleLabel}</span>
                        </li>
                      );
                    })}
                  </ul>
                </li>
              ))}
            </ul>
          )}

          {truncated && <p className="gs-note gs-more">Showing the closest matches. Keep typing to narrow it down.</p>}
        </div>
      )}
    </div>
  );
}
