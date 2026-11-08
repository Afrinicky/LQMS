import { useCallback, useEffect, useState } from 'react';
import { CalendarDays, Loader2, Search, X } from 'lucide-react';
import { api, errorText } from '../../services/api';
import { Notice } from '../ui/Feedback';
import TextField from '../ui/TextField';
import TransmissionPreview from './TransmissionPreview';

/**
 * Every control run the analysers have sent, and a way through them.
 *
 * The run form shows the newest few, because a bench running this morning's
 * control is looking for the one they have just put on the machine. Showing all
 * of them there was worse than useless: this laboratory has thousands waiting,
 * and a list that long buries the run somebody is standing at the analyser
 * waiting for under a fortnight of older ones.
 *
 * But "the newest few" is only honest if the rest is still reachable. A run
 * from a fortnight ago that has to be accounted for cannot simply fall off the
 * bottom of a list with nowhere to look it up — so this is where the rest live,
 * narrowed by day, by control, by analyser, or by whatever the machine called
 * the sample.
 */

export type Transmission = {
  id: number; sample_id: string | null; lot_number: string | null;
  received_at: string; instrument_run_at: string | null;
  result_count: number; status: string; status_note: string | null;
  iqc_material_id: number | null;
  source_name: string | null; equipment_name: string | null;
  material_name: string | null; test_name: string | null; level_label: string | null;
};

type Page = {
  rows: Transmission[];
  total: number;
  /** Every analyser that could transmit, as 'link:3' / 'feed:2'. */
  sources: Array<{ id: string; name: string }>;
  /** Every control this laboratory has registered, in this unit. */
  controls: Array<{ id: number; name: string }>;
  /** Runs from this control's analyser that no control was matched to. */
  unmatchedAvailable?: number;
};

/** The control a window was opened for, where it was opened for one. */
export type TransmissionControl = { id: number; name: string };

const PAGE = 50;

const STATES = [
  { key: 'waiting', label: 'Waiting to be accepted' },
  { key: 'accepted', label: 'Already accepted' },
  { key: 'rejected', label: 'Rejected' },
  { key: 'all', label: 'Every state' },
];

export default function TransmissionsDialog({
  endpoint, scope, control, mapUrl, title, lead, onUse, onUseMany, selectLimit = 200, onReject, onClose, busyId,
}: {
  /** Where the list comes from — the module's, or the bench's own unit-scoped one. */
  endpoint: string;
  /**
   * Fixed query the screen adds to every request — on the portal, the unit
   * whose board is being looked at.
   *
   * Without it the bench's register fell back to the reader's OWN unit, so a
   * senior post looking at the haematology board was handed the transmissions
   * of whichever unit their staff record sits in, and told "nothing matches
   * that" about a register with thousands of rows in it.
   */
  scope?: Record<string, string | number | null | undefined>;
  /**
   * The control this window was opened for.
   *
   * Given, the register answers "what has THIS control transmitted?" and shows
   * that control's runs only — a bench recording Level 3 has no business being
   * offered Level 1's. Omitted, it answers "what has arrived?" and every
   * control is on the picker.
   */
  control?: TransmissionControl;
  /**
   * Where the reading of one row is found, so a row can be opened rather than
   * only used. Omitted where the screen cannot say which control to read it
   * against — the row then stays a plain row.
   */
  mapUrl?: (row: Transmission) => string;
  title?: string;
  lead?: string;
  /** Taking one into the form underneath. Omitted where that is not on offer. */
  onUse?: (row: Transmission) => void | Promise<void>;
  /**
   * Taking SEVERAL into the form underneath, each as a run of its own.
   *
   * An analyser that transmits in bulk sends a week of stored control runs at
   * once, and a laboratory entering its history has a hundred to account for.
   * Where this is given the list becomes selectable; where it is not, nothing
   * about the window changes.
   */
  onUseMany?: (rows: Transmission[]) => void | Promise<void>;
  /** How many may be taken at once. */
  selectLimit?: number;
  /** Setting one aside. Omitted on screens where that is not the bench's job. */
  onReject?: (row: Transmission) => void | Promise<void>;
  onClose: () => void;
  busyId?: number | null;
}) {
  const [page, setPage] = useState<Page | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [offset, setOffset] = useState(0);
  // The scope is written inline at the call site, so a new object arrives on
  // every render of the page behind this dialog; keying on its contents is what
  // keeps that from becoming a query per render.
  const scopeKey = JSON.stringify(scope ?? {});

  const [search, setSearch] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [source, setSource] = useState('');
  const [materialId, setMaterialId] = useState('');
  const [state, setState] = useState('waiting');
  /**
   * Whether runs matched to no control are shown beside this control's.
   *
   * Off by default: a run matched to nothing is not evidence that it is this
   * control's. On, only the ones from this control's own analyser appear, and
   * each says so.
   */
  const [withUnmatched, setWithUnmatched] = useState(false);
  /** The transmission being looked at, before anything is taken from it. */
  const [preview, setPreview] = useState<Transmission | null>(null);
  /**
   * What has been picked for a set of runs, kept by id across pages and
   * filters: a fortnight's runs are found by narrowing to one day at a time,
   * and a selection that emptied itself on every filter would be useless.
   */
  const [picked, setPicked] = useState<Map<number, Transmission>>(new Map());

  const selecting = Boolean(onUseMany);
  /** A transmission still waiting is one a run can be recorded from. */
  const usable = (row: Transmission) => row.status === 'matched' || row.status === 'unmatched';
  const toggle = (row: Transmission) => setPicked(held => {
    const next = new Map(held);
    if (next.has(row.id)) next.delete(row.id);
    else if (next.size < selectLimit) next.set(row.id, row);
    return next;
  });

  const load = useCallback(async () => {
    setLoading(true);
    const q = new URLSearchParams();
    if (search.trim()) q.set('search', search.trim());
    if (from) q.set('from', from);
    if (to) q.set('to', to);
    if (source) q.set('source', source);
    // Opened for a control, the control is not a filter the reader chooses.
    if (control) {
      q.set('materialId', String(control.id));
      if (withUnmatched) q.set('includeUnmatched', '1');
    } else if (materialId) q.set('materialId', materialId);
    if (state) q.set('state', state);
    q.set('limit', String(PAGE));
    q.set('offset', String(offset));
    for (const [key, value] of Object.entries(scope ?? {})) {
      if (value !== null && value !== undefined && value !== '') q.set(key, String(value));
    }
    try {
      setPage(await api<Page>(`${endpoint}?${q}`));
      setProblem(null);
    } catch (e) { setProblem(errorText(e)); }
    finally { setLoading(false); }
    // `scope` itself is deliberately not a dependency: see scopeKey above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint, scopeKey, search, from, to, source, materialId, state, offset, control?.id, withUnmatched]);

  // Typing in the search box should not fire a query per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => { void load(); }, 250);
    return () => clearTimeout(timer);
  }, [load]);

  // Any change to what is being asked for starts again at the first page,
  // because page three of the old answer is not page three of the new one.
  const narrow = <T,>(set: (v: T) => void) => (value: T) => { setOffset(0); set(value); };

  const rows = page?.rows ?? [];
  const total = page?.total ?? 0;
  const shown = offset + rows.length;
  const unmatchedWaiting = page?.unmatchedAvailable ?? 0;

  /*
   * An empty window has to say WHICH kind of empty it is.
   *
   * "Nothing matches that" over a control whose analyser has sent two thousand
   * runs it could not match tells the bench the feature is broken. The count of
   * what is sitting unmatched is the one fact that explains it, and the
   * checkbox above is the remedy.
   */
  const emptyWord = control && !withUnmatched && unmatchedWaiting > 0
    ? `No transmission is matched to this control. ${unmatchedWaiting.toLocaleString()} from its analyser were matched to no control — include them above to select from those.`
    : 'Nothing matches that.';

  return (
    <div className="ls-modal-back" onClick={onClose}>
      <div className="ls-modal is-wide il-tx" onClick={e => e.stopPropagation()}>
        <header>
          <h4>{title ?? 'Results from the analysers'}</h4>
          <button type="button" className="pq-link" onClick={onClose}><X size={14} /></button>
        </header>

        {problem && <Notice kind="error">{problem}</Notice>}
        {lead && <p className="iqc-modal-lead">{lead}</p>}

        <div className="il-tx-filters">
          <label className="il-tx-search">
            <Search size={13} />
            <TextField value={search} onValue={narrow(setSearch)}
              placeholder="Sample number, lot, control or analyser" />
          </label>
          <label>
            <span><CalendarDays size={12} /> From</span>
            <input type="date" value={from} onChange={e => narrow(setFrom)(e.target.value)} />
          </label>
          <label>
            <span>To</span>
            <input type="date" value={to} onChange={e => narrow(setTo)(e.target.value)} />
          </label>
          {(page?.sources.length ?? 0) > 1 && (
            <label>
              <span>Analyser</span>
              <select value={source} onChange={e => narrow(setSource)(e.target.value)}>
                <option value="">Any</option>
                {page?.sources.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </label>
          )}
          {/* Opened for a control, the control is stated rather than chosen:
              this window is that control's register. Opened from the board, it
              is a filter, and it offers every control the laboratory has
              registered — not only the ones something has already matched to,
              which is how a control whose runs all arrive unmatched became
              impossible to narrow to. */}
          {!control && (page?.controls.length ?? 0) > 0 && (
            <label>
              <span>Control</span>
              <select value={materialId} onChange={e => narrow(setMaterialId)(e.target.value)}>
                <option value="">Any control</option>
                <option value="unmatched">Not matched to a control</option>
                {page?.controls.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
          )}
          {control && (
            <label className="il-tx-fixed">
              <span>Control</span>
              <strong>{control.name}</strong>
            </label>
          )}
          <label>
            <span>State</span>
            <select value={state} onChange={e => narrow(setState)(e.target.value)}>
              {STATES.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
          </label>
          {/* An analyser that puts no lot number in its transmission leaves
              every run of every control matched to nothing. Those are not this
              control's runs on the record, so they are not shown as though
              they were — but they are one click away, from this control's own
              analyser only, and each row says it was matched to nothing. */}
          {control && (
            <label className="il-tx-toggle">
              <input type="checkbox" checked={withUnmatched}
                onChange={e => narrow(setWithUnmatched)(e.target.checked)} />
              <span>Include transmissions not matched to a control</span>
            </label>
          )}
        </div>

        <p className="il-tx-count">
          {loading ? <><Loader2 size={12} className="pd-spin" /> Looking…</>
            : total === 0 ? emptyWord
            : `${total.toLocaleString()} transmission${total === 1 ? '' : 's'}${total > rows.length ? ` · showing ${offset + 1}–${shown}` : ''}`}
          {selecting && rows.some(usable) && (
            <>
              <button type="button" className="pq-link il-tx-all"
                onClick={() => setPicked(held => {
                  const next = new Map(held);
                  for (const row of rows.filter(usable)) {
                    if (next.size >= selectLimit) break;
                    next.set(row.id, row);
                  }
                  return next;
                })}>Select these</button>
              {picked.size > 0 && (
                <button type="button" className="pq-link" onClick={() => setPicked(new Map())}>Clear selection</button>
              )}
            </>
          )}
        </p>

        {rows.length > 0 && (
          <ul className="il-tx-list">
            {rows.map(row => {
              /* Both stamps, labelled, and never the one dressed as the other.
                 Showing the analyser's own date alone was read as the day the
                 run came in — so a register of this morning's transmissions
                 looked like a register of September. */
              const received = String(row.received_at).slice(0, 16).replace('T', ' ');
              const ran = row.instrument_run_at
                ? String(row.instrument_run_at).slice(0, 16).replace('T', ' ') : null;
              const facts = (
                <>
                  <strong>{row.sample_id || 'control sample'}</strong>
                  <span className="muted">
                    received {received}
                    {ran && ran !== received ? ` · analyser stamped ${ran}` : ''}
                    {' · '}{row.result_count} parameter{row.result_count === 1 ? '' : 's'}
                    {row.source_name ? ` · ${row.source_name}` : ''}
                  </span>
                  <span className="muted">
                    {row.material_name
                      ? `${row.material_name}${row.level_label ? ` — ${row.level_label}` : ''}`
                      : 'not matched to a control'}
                    {row.test_name ? ` · ${row.test_name}` : ''}
                  </span>
                </>
              );
              return (
              <li key={row.id} className={picked.has(row.id) ? 'is-picked' : ''}>
                {/* Picked for a set of runs. Only a transmission still waiting
                    can be: one already accepted is a run on the record. */}
                {selecting && (
                  <input type="checkbox" className="il-tx-pick" checked={picked.has(row.id)}
                    disabled={!usable(row)} onChange={() => toggle(row)}
                    aria-label={`Select ${row.sample_id || 'this transmission'}`} />
                )}
                {/* The row opens the transmission, the same as it does in the
                    newest-few list on the form behind this window. A count of
                    parameters is not enough to decide whether this is the run
                    somebody just put on the analyser. */}
                {mapUrl
                  ? <button type="button" className="il-tx-main il-tx-open" onClick={() => setPreview(row)}>{facts}</button>
                  : <div className="il-tx-main">{facts}</div>}
                <span className={`badge${row.status === 'accepted' ? ' done' : row.status === 'rejected' ? ' failed' : ''}`}>
                  {row.status === 'matched' || row.status === 'unmatched' ? 'waiting' : row.status}
                </span>
                {onUse && (row.status === 'matched' || row.status === 'unmatched') && (
                  <button type="button" className="pq-link" disabled={busyId === row.id}
                    onClick={() => void onUse(row)}>
                    {busyId === row.id ? <Loader2 size={12} className="pd-spin" /> : null} Use these
                  </button>
                )}
                {onReject && (row.status === 'matched' || row.status === 'unmatched') && (
                  <button type="button" className="pq-link" disabled={busyId === row.id}
                    onClick={async () => { await onReject(row); void load(); }}>Reject</button>
                )}
              </li>
              );
            })}
          </ul>
        )}

        {preview && (
          <TransmissionPreview
            mapUrl={mapUrl!(preview)} message={preview}
            onClose={() => setPreview(null)}
            onUse={onUse ? async () => { const row = preview; setPreview(null); await onUse(row); } : undefined} />
        )}

        <div className="il-tx-foot">
          <button type="button" className="secondary" disabled={offset === 0 || loading}
            onClick={() => setOffset(Math.max(0, offset - PAGE))}>Newer</button>
          <button type="button" className="secondary" disabled={shown >= total || loading}
            onClick={() => setOffset(offset + PAGE)}>Older</button>
          {selecting && (
            <>
              <span className="il-tx-picked">
                {picked.size === 0 ? 'None selected'
                  : `${picked.size} selected${picked.size >= selectLimit ? ` (the most that can be taken at once)` : ''}`}
              </span>
              <button type="button" disabled={picked.size === 0}
                onClick={() => { const rows = [...picked.values()]; setPicked(new Map()); void onUseMany!(rows); }}>
                Use {picked.size || ''} selected
              </button>
            </>
          )}
          <button type="button" className="secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
