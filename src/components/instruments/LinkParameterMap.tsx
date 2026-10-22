import { useCallback, useEffect, useState } from 'react';
import { Check, ClipboardPaste, Loader2, RefreshCw, Search } from 'lucide-react';
import { api, errorText } from '../../services/api';
import { Notice } from '../ui/Feedback';
import TextField from '../ui/TextField';
import { parsePastedMappings } from '../../../shared/constants/receivers';

/* ----------------------------------------------------------------------------
   What the receiving system calls each parameter
   ----------------------------------------------------------------------------
   This is the screen that was missing, and the reason an analyser outside the
   shipped maps could never be carried onward. Delivery would refuse every
   result with "no identifier for WBC, NEU%, Take Mode, Blood Mode… — map these
   on the link", and there was nowhere on the link to map them.

   Guessing was never the answer. What a receiving system calls a parameter is
   that laboratory's own configuration — the `listestid` in its LHIMS client
   files, the column name in somebody else's LIS — and a haemoglobin filed under
   a plausible-looking wrong identifier is worse than one not filed at all.

   So the question is turned round. Instead of asking somebody to know in
   advance what their analyser sends, this lists what it HAS sent: every
   distinct code, how often, with an example of the value, and one box beside
   each. An analyser's own settings — Take Mode, Blood Mode, Ref Group — are
   marked as not results, so the few parameters that genuinely need an
   identifier are visible rather than buried among them.
   ------------------------------------------------------------------------- */

type Parameter = {
  code: string;
  label: string | null;
  unit: string | null;
  messages: number;
  samples: string[];
  identifier: string;
  /** 'link' — set here; 'profile' — from the analyser's shipped map; 'none'. */
  source: 'link' | 'profile' | 'none';
  skipped: boolean;
  suggestion: 'measurement' | 'describes_itself';
};

type Page = {
  linkId: number;
  forwardTarget: string;
  mapLabel: string | null;
  messagesRead: number;
  parameters: Parameter[];
  counts: { total: number; ready: number; needed: number; skipped: number };
};

export default function LinkParameterMap({ linkId, target, measureMap, skip, onChange }: {
  linkId: number;
  /**
   * Where the results are going, because it decides what an identifier IS.
   *
   * LHIMS is keyed on a number — the `listestid` from the laboratory's own
   * client configuration — and anything else typed there matches nothing and
   * reads, confusingly, as a parameter nobody has mapped. Another system may
   * key on a word. So the rule is stated and checked rather than discovered.
   */
  target: string;
  /** What is set on the form right now, which may be unsaved. */
  measureMap: Record<string, string | number>;
  skip: string[];
  onChange: (next: { measureMap: Record<string, string>; skip: string[] }) => void;
}) {
  const [page, setPage] = useState<Page | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [onlyNeeded, setOnlyNeeded] = useState(false);
  /** Pasting a mapping the laboratory already has, rather than typing it. */
  const [pasting, setPasting] = useState(false);
  const [pasted, setPasted] = useState('');
  const [took, setTook] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setPage(await api<Page>(`/instrument-links/${linkId}/parameters`));
      setProblem(null);
    } catch (e) { setProblem(errorText(e)); }
    finally { setLoading(false); }
  }, [linkId]);
  useEffect(() => { void load(); }, [load]);

  const upper = (code: string) => code.trim().toUpperCase();
  const skipped = new Set(skip.map(upper));
  /** What is set on the form, keyed the way the analyser writes the code. */
  const setFor = (code: string) => {
    const hit = Object.entries(measureMap).find(([k]) => upper(k) === upper(code));
    return hit ? String(hit[1] ?? '') : '';
  };

  const setIdentifier = (code: string, value: string) => {
    const next: Record<string, string> = {};
    for (const [k, v] of Object.entries(measureMap)) if (upper(k) !== upper(code)) next[k] = String(v ?? '');
    if (value.trim()) next[code] = value.trim();
    onChange({ measureMap: next, skip });
  };

  /** Whatever is on the form, as the strings the save expects. */
  const asStrings = (): Record<string, string> => Object.fromEntries(
    Object.entries(measureMap).map(([k, v]) => [k, String(v ?? '')]));

  const setSkipped = (code: string, off: boolean) => {
    const rest = skip.filter(c => upper(c) !== upper(code));
    onChange({ measureMap: asStrings(), skip: off ? [...rest, code] : rest });
  };

  /**
   * Take the first guess for every code nobody has decided on yet.
   *
   * Only the codes with no identifier and no decision — a parameter already
   * mapped, or already set aside by hand, is somebody's answer and is never
   * overwritten by a guess.
   */
  const applySuggestions = () => {
    const next = [...skip];
    for (const p of page?.parameters ?? []) {
      if (p.identifier || setFor(p.code) || skipped.has(upper(p.code))) continue;
      if (p.suggestion === 'describes_itself') next.push(p.code);
    }
    onChange({ measureMap: asStrings(), skip: next });
  };

  /**
   * Take a pasted mapping, matched to what this analyser actually sends.
   *
   * Only the codes this link has seen are taken. A mapping copied out of the
   * middleware covers every analyser it serves, and filling this link with
   * another machine's parameters would be a list nobody can check.
   */
  const applyPasted = () => {
    const { rows: pairs, ignored } = parsePastedMappings(pasted);
    const known = new Map((page?.parameters ?? []).map(p => [upper(p.code), p.code]));
    const next: Record<string, string> = asStrings();
    let taken = 0; const unknown: string[] = [];
    for (const pair of pairs) {
      const code = known.get(upper(pair.code));
      if (!code) { unknown.push(pair.code); continue; }
      next[code] = pair.identifier;
      taken++;
    }
    onChange({ measureMap: next, skip });
    setTook([
      `${taken} parameter${taken === 1 ? '' : 's'} matched up`,
      unknown.length ? `${unknown.length} not sent by this analyser (${unknown.slice(0, 5).join(', ')}${unknown.length > 5 ? '\u2026' : ''})` : '',
      ignored.length ? `${ignored.length} line${ignored.length === 1 ? '' : 's'} carried no pair` : '',
    ].filter(Boolean).join(' \u00b7 '));
    if (taken) { setPasted(''); setPasting(false); }
  };

  const rows = (page?.parameters ?? []).filter(p => {
    if (onlyNeeded && (skipped.has(upper(p.code)) || p.identifier || setFor(p.code))) return false;
    const q = search.trim().toLowerCase();
    return !q || p.code.toLowerCase().includes(q) || String(p.label ?? '').toLowerCase().includes(q);
  });

  // Counted from the form rather than from the server, so the tally moves as
  // somebody types rather than only after a save.
  const live = (page?.parameters ?? []).reduce((acc, p) => {
    if (skipped.has(upper(p.code))) acc.skipped++;
    else if (p.identifier || setFor(p.code)) acc.ready++;
    else acc.needed++;
    return acc;
  }, { ready: 0, needed: 0, skipped: 0 });

  const unseen = !loading && (page?.parameters.length ?? 0) === 0;
  // LHIMS files a result by a numeric measure id. A word typed here would
  // match nothing and be reported as unmapped, which is a long way to find out.
  const numbersOnly = target === 'lhims_api';
  const wrong = numbersOnly
    ? (page?.parameters ?? []).filter(p => {
      const own = setFor(p.code).trim();
      return own && !/^\d+$/.test(own);
    }).map(p => p.code)
    : [];

  return (
    <div className="lf-params">
      <div className="lf-params-head">
        <strong>What the receiving system calls each parameter</strong>
        <button type="button" className="pq-link" onClick={() => void load()} disabled={loading}>
          {loading ? <Loader2 size={12} className="pd-spin" /> : <RefreshCw size={12} />} Re-read what has arrived
        </button>
      </div>

      {problem && <Notice kind="error">{problem}</Notice>}

      {unseen ? (
        <p className="iqc-hint">
          Nothing has arrived from this analyser yet. Once it sends its first patient result, every parameter it
          uses is listed here to be matched up — so there is nothing to fill in from memory.
        </p>
      ) : (
        <>
          <p className="lf-params-lead">
            Taken from the {page?.messagesRead ?? 0} most recent transmission{page?.messagesRead === 1 ? '' : 's'}.
            Give each parameter the identifier the receiving system knows it by. A parameter with no identifier is
            not sent — it is reported instead, because a result filed under the wrong identifier is worse than
            one not filed.
            {page?.mapLabel ? ` Identifiers shown in grey come from ${page.mapLabel}; typing over one keeps your own.` : ''}
          </p>

          {wrong.length > 0 && (
            <Notice kind="error">
              LHIMS files a result by a measure id, which is a number — the <code>listestid</code> from your own
              LHIMS client configuration. {wrong.slice(0, 6).join(', ')}{wrong.length > 6 ? '\u2026' : ''}
              {wrong.length === 1 ? ' has' : ' have'} something else, and would be sent nowhere.
            </Notice>
          )}

          <div className="lf-params-tally">
            <span className="badge done">{live.ready} ready</span>
            <span className={`badge${live.needed ? ' warning' : ''}`}>{live.needed} still to set</span>
            <span className="badge">{live.skipped} not results</span>
            {live.needed > 0 && (
              <button type="button" className="pq-link" onClick={applySuggestions}>
                Set aside the ones that are not results
              </button>
            )}
            <button type="button" className="pq-link" onClick={() => setPasting(v => !v)}>
              <ClipboardPaste size={12} /> {pasting ? 'Cancel' : 'Paste a mapping'}
            </button>
          </div>

          {pasting && (
            <div className="lf-params-paste">
              <p className="muted">
                Paste the pairs you already have — one per line, the analyser&rsquo;s code and the identifier
                the receiving system files it under. Copied straight out of a spreadsheet, a configuration file,
                or the <code>ParameterMappings</code> table works: commas, tabs, columns and
                <code> InstParameterCode / ParameterID</code> headings are all understood. Only the parameters
                this analyser actually sends are taken.
              </p>
              <textarea rows={6} value={pasted} spellCheck={false}
                onChange={e => setPasted(e.target.value)}
                placeholder={'WBC, 23\nHGB, 25\nNEUT#, 33'} />
              <div className="lf-params-paste-acts">
                <button type="button" disabled={!pasted.trim()} onClick={applyPasted}>Match these up</button>
                <button type="button" className="secondary" onClick={() => { setPasting(false); setPasted(''); }}>
                  Cancel
                </button>
              </div>
            </div>
          )}
          {took && <p className="iqc-hint ok">{took}</p>}

          <div className="lf-params-filters">
            <label className="il-tx-search">
              <Search size={13} />
              <TextField value={search} onValue={setSearch} placeholder="Find a parameter" />
            </label>
            <label className="ls-check">
              <input type="checkbox" checked={onlyNeeded} onChange={e => setOnlyNeeded(e.target.checked)} />
              <span>Only those still to set</span>
            </label>
          </div>

          <ul className="lf-params-list">
            {rows.map(p => {
              const off = skipped.has(upper(p.code));
              const own = setFor(p.code);
              return (
                <li key={p.code} className={off ? 'is-off' : own || p.identifier ? 'is-set' : ''}>
                  <div className="lf-param-id">
                    <strong>{p.code}</strong>
                    {p.label && p.label !== p.code && <span className="muted">{p.label}</span>}
                    <span className="muted">
                      {p.messages} message{p.messages === 1 ? '' : 's'}
                      {p.unit ? ` · ${p.unit}` : ''}
                      {p.samples.length ? ` · e.g. ${p.samples.slice(0, 3).join(', ')}` : ''}
                    </span>
                  </div>
                  <label className="lf-param-value">
                    <span>Identifier</span>
                    <TextField value={own} onValue={v => setIdentifier(p.code, v)} disabled={off}
                      inputMode={numbersOnly ? 'numeric' : undefined}
                      placeholder={p.source === 'profile' && p.identifier ? p.identifier
                        : numbersOnly ? 'measure id' : 'not set'} />
                  </label>
                  <label className="ls-check lf-param-skip">
                    <input type="checkbox" checked={off} onChange={e => setSkipped(p.code, e.target.checked)} />
                    <span>Not a result</span>
                  </label>
                  {!off && (own || p.identifier) && <Check size={14} className="lf-param-tick" />}
                </li>
              );
            })}
          </ul>
          {rows.length === 0 && <p className="iqc-hint">Nothing matches that.</p>}
        </>
      )}
    </div>
  );
}
